import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const entry = readFileSync(new URL('./host-entry.ts', import.meta.url), 'utf8');
const start = entry.indexOf('    captureOpen(): string {');
const end = entry.indexOf('    iosReviewAIWitness(', start);
if (start < 0 || end < 0) throw new Error('Capture bridge unavailable');
const source = new Bun.Transpiler({ loader: 'ts' }).transformSync(`globalThis.port = {${entry.slice(start, end)}};`);

function fixture(saved = true) {
    const calls: unknown[] = [];
    const receive = (input: unknown) => { calls.push(input); return input; };
    const state = {
        submit: (work: () => Promise<unknown>) => work(),
        requireSaved: () => { if (!saved) throw new Error('NOT_READY'); },
        unwrap: (value: unknown) => value,
        contract: { openQuickCapture: receive, getQuickCaptureView: receive, getQuickCaptureAutocomplete: receive,
            admitQuickCaptureAudio: receive, editQuickCapture: receive },
        port: { captureOpen: async (_json?: string): Promise<unknown> => undefined,
            captureOpenContext: async (_json: string): Promise<unknown> => undefined,
            captureAutocomplete: async (_json: string): Promise<unknown> => undefined },
    };
    vm.runInNewContext(source, state);
    return { port: state.port, calls };
}

describe('native capture destination bridge', () => {
    it('forwards contextual project and section while retaining no-argument opening', async () => {
        const f = fixture();
        const context = { initialProps: { projectId: 'project-1', sectionId: 'section-1' } };
        await f.port.captureOpenContext(JSON.stringify(context));
        await f.port.captureOpen();
        expect(f.calls).toEqual([context, undefined]);
    });

    it('forwards the exact UTF16 caret and selection to core autocomplete', async () => {
        const f = fixture();
        const input = { text: '🙂 Call @wo later', caret: 11, selectionEnd: 11 };
        expect(await f.port.captureAutocomplete(JSON.stringify(input))).toEqual(input);
        expect(f.calls).toEqual([input]);
    });

    it('does not query capture data before canonical storage is ready', async () => {
        const f = fixture(false);
        await expect(f.port.captureOpen()).rejects.toThrow('NOT_READY');
        await expect(f.port.captureAutocomplete('{"text":"@","caret":1}')).rejects.toThrow('NOT_READY');
        expect(f.calls).toEqual([]);
    });
});
