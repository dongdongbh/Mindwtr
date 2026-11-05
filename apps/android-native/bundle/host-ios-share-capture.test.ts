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
