import { describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Core's OpenAI speech upload (packages/core/src/speech-to-task.ts transcribeRemoteOpenAI) posts a FormData through the
// polyfilled fetch. The bytes the host gets must be the ones RN's Android app sends for the same form (RN FormData.getParts,
// NetworkingModule.constructMultipartBody, OkHttp MultipartBody; the layout is written down in host-polyfills.js).
type Payload = { url: string; method: string; headers: [string, string][]; base64?: string; text?: string };

const load = () => {
    const sent: Payload[] = [];
    const context = vm.createContext({
        __mindwtrNative: {
            netFetch: (json: string) => { sent.push(JSON.parse(json)); return `net-${sent.length}`; },
            netAbort: () => {},
            randomBytes: (count: number) => JSON.stringify([...randomBytes(count)]),
            nowMs: () => Date.now(),
            log: () => {},
            ioNext: () => '',
            ioBody: () => '',
        },
    });
    vm.runInContext(readFileSync(import.meta.dir + '/host-polyfills.js', 'utf8'), context);
    const run = (code: string) => vm.runInContext(code, context);
    const header = (payload: Payload, name: string) => payload.headers.find(([key]) => key === name)?.[1];
    return { sent, run, header };
};

const AUDIO = [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x0d, 0x0a, 0xff, 0x80];

// The OkHttp layout, built apart from the polyfill: per part `--b CRLF`, the part's headers (RN's lowercase
// content-disposition), OkHttp's `Content-Type:` when the part has a type, `Content-Length:`, a blank line, the body, CRLF;
// then `--b--` CRLF.
const expectedMultipart = (boundary: string, parts: { disposition: string; type?: string; body: Buffer }[]) =>
    Buffer.concat([
        ...parts.flatMap((part) => [
            Buffer.from(`--${boundary}\r\ncontent-disposition: ${part.disposition}\r\n`
                + (part.type ? `Content-Type: ${part.type}\r\n` : '')
                + `Content-Length: ${part.body.length}\r\n\r\n`, 'utf8'),
            part.body,
            Buffer.from('\r\n'),
        ]),
        Buffer.from(`--${boundary}--\r\n`),
    ]);

const BOUNDARY_TYPE = /^multipart\/form-data; boundary=([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

describe('multipart FormData over the polyfilled fetch', () => {
    it('sends core\'s speech upload as the RN Android app does', () => {
        const host = load();
        host.run(`
            var form = new FormData();
            form.append('file', new Blob([new Uint8Array(${JSON.stringify(AUDIO)}).buffer], { type: 'audio/mp4' }), 'mindwtr-audio-x.m4a');
            form.append('model', 'gpt-4o-transcribe');
            form.append('language', 'de');
            form.append('response_format', 'json');
            fetch('https://api.openai.com/v1/audio/transcriptions', {
                method: 'POST', headers: { Authorization: 'Bearer synthetic' }, body: form,
            });
        `);
        expect(host.sent).toHaveLength(1);
        const payload = host.sent[0];
        expect(payload.text).toBeUndefined();
        const contentType = host.header(payload, 'content-type') ?? '';
        const boundary = BOUNDARY_TYPE.exec(contentType)?.[1];
        expect(boundary).toBeDefined();
        expect(host.header(payload, 'authorization')).toBe('Bearer synthetic');
        const body = Buffer.from(payload.base64 ?? '', 'base64');
        expect(body.equals(expectedMultipart(boundary!, [
            { disposition: 'form-data; name="file"; filename="mindwtr-audio-x.m4a"', type: 'audio/mp4', body: Buffer.from(AUDIO) },
            { disposition: 'form-data; name="model"', body: Buffer.from('gpt-4o-transcribe') },
            { disposition: 'form-data; name="language"', body: Buffer.from('de') },
            { disposition: 'form-data; name="response_format"', body: Buffer.from('json') },
        ]))).toBe(true);
    });

    it('names a Blob without a filename "blob", encodes a filename as RN does, and sends text as UTF-8', () => {
        const host = load();
        host.run(`
            var form = new FormData();
            form.append('a', new Blob(['x']));
            form.append('b', new Blob(['y'], { type: 'Text/Plain' }), 'dir/a b.txt');
            form.append('note', 'Grüße 文');
            fetch('https://synthetic.invalid/up', { method: 'POST', body: form });
        `);
        const payload = host.sent[0];
        const boundary = BOUNDARY_TYPE.exec(host.header(payload, 'content-type') ?? '')![1];
        expect(Buffer.from(payload.base64!, 'base64').equals(expectedMultipart(boundary, [
            { disposition: 'form-data; name="a"; filename="blob"', type: 'application/octet-stream', body: Buffer.from('x') },
            { disposition: 'form-data; name="b"; filename="dir_a%20b.txt"', type: 'text/plain', body: Buffer.from('y') },
            { disposition: 'form-data; name="note"', body: Buffer.from('Grüße 文', 'utf8') },
        ]))).toBe(true);
    });

    it('uses a boundary the caller set, and adds one to a caller\'s type without one as OkHttp does', () => {
        const host = load();
        host.run(`
            var form = new FormData();
            form.append('k', 'v');
            fetch('https://synthetic.invalid/up', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=fixed' }, body: form });
            fetch('https://synthetic.invalid/up', { method: 'POST', headers: { 'Content-Type': 'multipart/mixed' }, body: form });
        `);
        expect(host.header(host.sent[0], 'content-type')).toBe('multipart/form-data; boundary=fixed');
        expect(Buffer.from(host.sent[0].base64!, 'base64').equals(
            expectedMultipart('fixed', [{ disposition: 'form-data; name="k"', body: Buffer.from('v') }]))).toBe(true);
        expect(host.header(host.sent[1], 'content-type')).toMatch(/^multipart\/mixed; boundary=[0-9a-f-]{36}$/);
    });

    it('sends a Blob body as its bytes with its type', () => {
        const host = load();
        host.run(`fetch('https://synthetic.invalid/up', { method: 'PUT', body: new Blob([new Uint8Array([1, 2]), 'é'], { type: 'audio/MP4' }) });`);
        expect(host.header(host.sent[0], 'content-type')).toBe('audio/mp4');
        expect([...Buffer.from(host.sent[0].base64!, 'base64')]).toEqual([1, 2, 0xc3, 0xa9]);
    });

    it('gives Blob and FormData the parts of their APIs core and RN code use', async () => {
        const host = load();
        const result = await host.run(`
            var blob = new Blob(['ab', new Uint8Array([99])], { type: 'TEXT/PLAIN' });
            var form = new FormData();
            form.append('x', '1');
            form.append('x', 2);
            form.append('f', blob, 'f.txt');
            var seen = [];
            form.forEach(function (value, name) { seen.push(name); });
            var before = { x: form.get('x'), all: form.getAll('x'), has: form.has('f'), missing: form.get('none'),
                file: form.get('f').name, fileType: form.get('f').type, entries: Array.from(form).map(function (e) { return e[0]; }) };
            form.set('x', '3');
            form.delete('f');
            Promise.all([blob.text(), blob.arrayBuffer(), blob.slice(1).text()]).then(function (read) {
                return JSON.stringify({ before: before, seen: seen, after: Array.from(form.entries()), type: blob.type, size: blob.size,
                    text: read[0], bytes: Array.from(new Uint8Array(read[1])), sliced: read[2] });
            });
        `);
        expect(JSON.parse(result)).toEqual({
            before: { x: '1', all: ['1', '2'], has: true, missing: null, file: 'f.txt', fileType: 'text/plain', entries: ['x', 'x', 'f'] },
            seen: ['x', 'x', 'f'], after: [['x', '3']], type: 'text/plain', size: 3, text: 'abc', bytes: [97, 98, 99], sliced: 'bc',
        });
    });
});
