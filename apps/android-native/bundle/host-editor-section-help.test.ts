import { beforeAll, describe, expect, it } from 'bun:test';
import vm from 'node:vm';
import { build } from 'esbuild';

type Host = {
    taskEditorSectionHelp(): string;
    language(stored: string, system: string): string;
    poll(ticket: string): string | null;
};
let source = '';
beforeAll(async () => {
    const built = await build({ entryPoints: [new URL('./host-entry.ts', import.meta.url).pathname], bundle: true,
        write: false, format: 'iife', target: 'es2022', logLevel: 'silent' });
    source = built.outputFiles[0].text;
});

const fixture = () => {
    const operations: string[] = [];
    const state: { MindwtrHost?: Host; [name: string]: unknown } = {
        AbortController, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout,
        __mindwtrHostPlatform: 'ios', console: { info() {}, warn() {}, error() {}, log() {} },
        __mindwtrNative: new Proxy({}, { get: (_target, property) => property === 'trace' || property === 'log' ? () => undefined : () => {
            operations.push(String(property));
            throw new Error('Help must not call native storage: ' + String(property));
        } }),
    };
    vm.runInNewContext(source, state);
    const host = state.MindwtrHost;
    if (!host) throw new Error('Host did not initialize');
    const poll = async (ticket: string): Promise<unknown> => {
        for (let step = 0; step < 100; step++) {
            const answer = host.poll(ticket);
            if (answer !== null) return JSON.parse(answer);
            await new Promise((done) => setTimeout(done, 0));
        }
        throw new Error('Help read did not settle');
    };
    return { host, poll, operations };
};

describe('task editor section help native read', () => {
    it('returns exact localized copy and shared guide destinations without native writes', async () => {
        const { host, poll, operations } = fixture();
        expect(await poll(host.language('en', 'en-US'))).toEqual({ ok: true, value: { language: 'en' } });
        expect(await poll(host.taskEditorSectionHelp())).toEqual({ ok: true, value: {
            help: 'Help', readGuide: 'Read the guide', guideError: 'Could not open the guide. Tap the link to try again.',
            scheduling: { title: 'Scheduling', body: 'Start is when an action becomes available. Due is a real deadline. Leave dates empty when neither applies.',
                url: 'https://docs.mindwtr.app/use/mobile#scheduling-tasks' },
            details: { title: 'Details', body: 'Extra fields are optional. Capture a thought first, then add only what helps you act. Change visible fields in Settings → GTD → Task Editor Layout.',
                url: 'https://docs.mindwtr.app/use/mobile#task-editor-task-view' },
        } });
        expect(operations).toEqual([]);
    });

    it('uses translated guide page and anchors for supported documentation locales', async () => {
        const { host, poll, operations } = fixture();
        await poll(host.language('de', 'de-DE'));
        expect(await poll(host.taskEditorSectionHelp())).toMatchObject({ ok: true, value: {
            scheduling: { title: 'Terminplanung', url: 'https://docs.mindwtr.app/de/use/mobile#aufgaben-planen' },
            details: { url: 'https://docs.mindwtr.app/de/use/mobile#aufgabeneditor-aufgabe-ansicht' },
        } });
        expect(operations).toEqual([]);
    });

    it('keeps app translation while unsupported documentation locales use the shared English fallback', async () => {
        const { host, poll, operations } = fixture();
        await poll(host.language('uk', 'uk-UA'));
        expect(await poll(host.taskEditorSectionHelp())).toMatchObject({ ok: true, value: {
            scheduling: { url: 'https://docs.mindwtr.app/use/mobile#scheduling-tasks' },
            details: { url: 'https://docs.mindwtr.app/use/mobile#task-editor-task-view' },
        } });
        expect(operations).toEqual([]);
    });
});
