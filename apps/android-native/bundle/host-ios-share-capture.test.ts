import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildShareCaptureDraft } from '../../../packages/core/src/entry-points';
import { readIOSShareCaptureDraft } from './ios-share-capture';

const entry = readFileSync(new URL('./host-entry.ts', import.meta.url), 'utf8');
const start = entry.indexOf('    iosShareCaptureDraft(json: string): string {');
const end = entry.indexOf('    iosEntityOpen(', start);
if (start < 0 || end < 0) throw new Error('iOS share projection unavailable');
const source = new Bun.Transpiler({ loader: 'ts' }).transformSync(`globalThis.port = {${entry.slice(start, end)}};`);
const fixture = (platform = 'ios', saved = true) => {
    let reads = 0;
    const state = { __mindwtrHostPlatform: platform, readIOSShareCaptureDraft,
        submit: (work: () => unknown) => work(),
        requireSaved: () => { reads++; if (!saved) throw new Error('NOT_READY'); },
        port: undefined as unknown as { iosShareCaptureDraft(raw: string): Promise<unknown> } };
    vm.runInNewContext(source, state);
    return { port: state.port, reads: () => reads };
};
describe('iOS raw share canonical title/note projection', () => {
    it.each([
        { subject: ' Email ', text: ' Body https://example.com/doc ', webUrl: 'https://example.com/doc' },
        { subject: 'Email', text: 'Body', webUrl: 'https://example.com/doc' },
        { subject: null, text: ' Text ', webUrl: 'https://example.com/doc' },
        { subject: null, text: null, webUrl: 'https://example.com/doc' },
        { subject: null, text: 'https://example.com/doc', webUrl: 'https://example.com/doc' },
        { subject: 'e\u0301 😀', text: '🔒 Private\nbody', webUrl: null },
        { subject: null, text: ' \n', webUrl: null },
    ])('uses the actual RN/core formatter without writes: %j', async input => {
        const f = fixture(), draft = buildShareCaptureDraft({ shareSubject: input.subject, shareText: input.text, shareWebUrl: input.webUrl });
        expect(await f.port.iosShareCaptureDraft(JSON.stringify(input))).toEqual({ draft: draft ? { title: draft.title, note: draft.description ?? '' } : null });
        expect(f.reads()).toBe(1);
    });
    it('keeps exact UTF16 limits and raw URL bytes', () => {
        const input = { subject: 's'.repeat(10_000), text: '😀'.repeat(25_000), webUrl: 'https://example.com/doc?a=%2f' };
        expect(readIOSShareCaptureDraft(JSON.stringify(input)).draft?.title).toBe(input.subject);
        expect(() => readIOSShareCaptureDraft(JSON.stringify({ ...input, text: input.text + 'x' }))).toThrow('INVALID_INPUT');
        expect(readIOSShareCaptureDraft(JSON.stringify({ subject: null, text: null, webUrl: input.webUrl })).draft?.title).toBe(input.webUrl);
    });
    it.each([null, [], {}, { subject: null, text: 'text', webUrl: null, library: 'other' },
        { subject: false, text: 'text', webUrl: null }, { subject: null, text: 1, webUrl: null },
        { subject: null, text: 'text', webUrl: 'file:///private/foreign' },
        { subject: null, text: 'text', webUrl: 'https://' }].map(input => [input] as const))('refuses malformed/foreign fields: %j', input => {
        expect(() => readIOSShareCaptureDraft(JSON.stringify(input))).toThrow();
    });
    it('keeps readiness/platform gates before projection', async () => {
        const android = fixture('android'), cold = fixture('ios', false), raw = JSON.stringify({ subject: null, text: 'text', webUrl: null });
        await expect(android.port.iosShareCaptureDraft(raw)).rejects.toThrow('INVALID_INPUT');
        expect(android.reads()).toBe(0);
        await expect(cold.port.iosShareCaptureDraft(raw)).rejects.toThrow('NOT_READY');
    });
});

describe('iOS shared files follow RN\'s file capture rule', () => {
    const AT = '2026-11-17T10:00:00.000Z', DIR = 'file:///private/var/mobile/Containers/Data/Application/A/Library/attachments/';
    const file = (id: string, name: string, extra: Record<string, unknown> = {}) => {
        const extension = /\.[A-Za-z0-9]{1,8}$/.exec(name)?.[0]?.toLowerCase() ?? '';
        return { id, name, mimeType: 'image/jpeg', size: 1000, sha256: 'a'.repeat(64), uri: DIR + id + extension, ...extra };
    };
    const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'];
    const read = (input: Record<string, unknown>) => readIOSShareCaptureDraft(JSON.stringify({ subject: null, text: null, webUrl: null,
        skippedFiles: 0, receivedAt: AT, ...input }));
    it('titles a photo-only share by its first file name without the extension and attaches each file', async () => {
        const result = await read({ files: [file(ids[0], 'IMG_0001.HEIC'), file(ids[1], 'Scan.pdf', { mimeType: 'application/pdf' })] });
        expect(result).toEqual({ draft: { title: 'IMG_0001', note: '' }, skipped: 0, attachments: [
            { id: ids[0], kind: 'file', title: 'IMG_0001.HEIC', uri: DIR + ids[0] + '.heic', mimeType: 'image/jpeg', size: 1000,
                fileHash: 'a'.repeat(64), createdAt: AT, updatedAt: AT, localStatus: 'available' },
            { id: ids[1], kind: 'file', title: 'Scan.pdf', uri: DIR + ids[1] + '.pdf', mimeType: 'application/pdf', size: 1000,
                fileHash: 'a'.repeat(64), createdAt: AT, updatedAt: AT, localStatus: 'available' }] });
    });
    it('prefers the subject, keeps the text as the note only beside a subject, and ignores the web URL', async () => {
        expect((await read({ subject: 'Trip', text: 'Look', webUrl: 'https://example.com', files: [file(ids[0], 'a.jpg')] })).draft)
            .toEqual({ title: 'Trip', note: 'Look' });
        expect((await read({ text: 'Look', webUrl: 'https://example.com', files: [file(ids[0], 'a.jpg')] })).draft).toEqual({ title: 'Look', note: '' });
    });
    it('counts blocked, oversized, uncopied and extension-skipped files, and falls back to the text when none attached', async () => {
        const result = await read({ text: 'Read this', skippedFiles: 1, files: [file(ids[0], 'run.exe', { mimeType: 'application/x-msdownload' }),
            file(ids[1], 'big.mov', { size: 60 * 1024 * 1024 }), file(ids[2], 'gone.png', { uri: null })] });
        expect(result).toEqual({ draft: { title: 'Read this', note: '' }, attachments: [], skipped: 4 });
        expect(await read({ skippedFiles: 0, files: [file(ids[0], 'gone.png', { uri: null })] })).toEqual({ draft: null, attachments: [], skipped: 1 });
    });
    it.each([
        { files: [file(ids[0], 'a.jpg', { uri: DIR + 'other.jpg' })] },
        { files: [file(ids[0], 'a.jpg'), file(ids[0], 'b.jpg')] },
        { files: Array.from({ length: 7 }, (_, n) => file(`00000000-0000-4000-8000-00000000001${n}`, 'a.jpg')) },
        { files: [{ ...file(ids[0], 'a.jpg'), extra: 1 }] },
        { files: [file(ids[0], 'a.jpg')], receivedAt: 'yesterday' },
        { files: [file(ids[0], 'a.jpg')], skippedFiles: -1 },
    ].map(input => [input] as const))('refuses a malformed file list: %j', async input => {
        expect(() => read(input)).toThrow();
    });
});

