import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { build } from 'esbuild';
import { createCapturedWebLinkAttachment, resetForTests, setStorageAdapter, useTaskStore, type AppData, type Attachment, type StorageAdapter } from '@mindwtr/core';
import { enrichAndroidCaptureTitle, enrichAndroidEditorLinkTitles, fetchAndroidLinkTitle } from './host-link-title';

const globals = globalThis as unknown as Record<string, unknown>;
const originalPlatform = globals.__mindwtrHostPlatform;
const originalNative = globals.__mindwtrNative;
let hostEvents: string[] = [];
const url = 'https://news.example.org/story';
const createdAt = '2026-01-01T00:00:00.000Z';

const polyfillResponse = (bytes: Uint8Array, type = 'text/html; charset=utf-8') => ({
    ok: true, status: 200, redirected: false, url, body: null,
    headers: new Headers({ 'content-type': type }),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
}) as unknown as Response;

const memoryStorage = (initial: AppData) => {
    let stored = structuredClone(initial);
    const adapter: StorageAdapter = {
        getData: async () => structuredClone(stored),
        saveData: async (data) => { stored = structuredClone(data); },
        saveDataIfUnchanged: async (data) => { stored = structuredClone(data); },
    };
    return { adapter, stored: () => stored };
};

const seed = (settings: AppData['settings'] = {}) => {
    const attachment = createCapturedWebLinkAttachment(url, new Date(createdAt));
    const data: AppData = {
        tasks: [{ id: 'shared', title: url, status: 'inbox', contexts: [], tags: [], createdAt, updatedAt: createdAt, rev: 1, attachments: [attachment] }],
        projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'device', ...settings },
    };
    const storage = memoryStorage(data);
    setStorageAdapter(storage.adapter);
    useTaskStore.setState({ _allTasks: data.tasks, _allProjects: [], settings: data.settings });
    return { ...storage, attachment };
};

const settle = async (check: () => boolean) => {
    for (let attempt = 0; attempt < 50 && !check(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};

describe('native Android link titles', () => {
    beforeEach(() => {
        resetForTests();
        globals.__mindwtrHostPlatform = 'android';
        hostEvents = [];
        globals.__mindwtrNative = { hostEvent: (json: string) => { hostEvents.push(json); } };
    });

    afterEach(() => {
        resetForTests();
        globals.__mindwtrHostPlatform = originalPlatform;
        globals.__mindwtrNative = originalNative;
    });

    it('reads the title from a bodiless bridge response without cookies or redirects', async () => {
        const inits: RequestInit[] = [];
        const html = new TextEncoder().encode('<html><head><title>Field &amp; Notes</title></head><body>…</body></html>');
        const title = await fetchAndroidLinkTitle(url, (async (_address: string, init: RequestInit) => {
            inits.push(init);
            return polyfillResponse(html);
        }) as typeof fetch);
        expect(title).toBe('Field & Notes');
        expect(inits[0]).toMatchObject({ credentials: 'omit', redirect: 'error' });
    });

    it('reads the title with the native host polyfills for URL, fetch Response, Headers, AbortController and TextDecoder', async () => {
        const bundled = await build({
            stdin: { contents: `export { fetchAndroidLinkTitle } from './host-link-title';`, resolveDir: import.meta.dir, loader: 'ts' },
            bundle: true, write: false, format: 'iife', globalName: 'linkTitle', target: 'es2020', logLevel: 'silent',
            alias: { '@mindwtr/core': new URL('../../../packages/core/src/index.ts', import.meta.url).pathname },
        });
        const requests: unknown[] = [];
        const context: Record<string, unknown> = {
            URL: undefined, URLSearchParams: undefined, TextDecoder: undefined, TextEncoder: undefined, AbortController: undefined, AbortSignal: undefined,
            Headers: undefined, Request: undefined, Response: undefined, setTimeout, clearTimeout, console,
        };
        vm.createContext(context);
        vm.runInContext(readFileSync(new URL('./host-polyfills.js', import.meta.url), 'utf8'), context);
        let page = '<html><head><title>Getting Things Done - Wikipedia</title></head>';
        context.fetch = (input: string, init: { redirect?: string; signal?: unknown }) => {
            requests.push({ input, redirect: init.redirect, signal: Boolean(init.signal) });
            const Polyfilled = context.Response as new (body: null, init: object) => Record<string, unknown>;
            const response = new Polyfilled(null, { status: 200, headers: [['content-type', 'text/html; charset=UTF-8']] });
            response.url = input;
            response._text = page;
            response._bytes = undefined;
            response.mindwtrDecodedTextBytes = page.length;
            response.arrayBuffer = () => { throw new Error('the whole page was converted to bytes'); };
            return Promise.resolve(response);
        };
        vm.runInContext(bundled.outputFiles[0].text, context);
        const host = context.linkTitle as { fetchAndroidLinkTitle(url: string): Promise<string | null> };
        expect(await host.fetchAndroidLinkTitle('https://en.wikipedia.org/wiki/Getting_Things_Done#History')).toBe('Getting Things Done - Wikipedia');
        expect(requests).toEqual([{ input: 'https://en.wikipedia.org/wiki/Getting_Things_Done', redirect: 'error', signal: true }]);

        page = `<html><head><meta name="x" content="${'a'.repeat(120_000)}"><title>Late in the head</title>`;
        expect(await host.fetchAndroidLinkTitle('https://example.org/late')).toBe('Late in the head');
        page = `<html><head><meta name="x" content="${'界'.repeat(60_000)}"><title>Past the scan limit</title>`;
        expect(await host.fetchAndroidLinkTitle('https://example.org/wide')).toBeNull();
        page = `<html><head><title>Big page</title></head><body>${'界'.repeat(5_000_000)}</body>`;
        const started = performance.now();
        expect(await host.fetchAndroidLinkTitle('https://example.org/big')).toBe('Big page');
        expect(performance.now() - started).toBeLessThan(1_000);
    });

    it('keeps the title from a non-UTF-8 page and a page longer than the scan limit', async () => {
        const latin = new Uint8Array([...new TextEncoder().encode('<title>Caf'), 0xe9, ...new TextEncoder().encode('</title>')]);
        expect(await fetchAndroidLinkTitle(url, (async () => polyfillResponse(latin)) as typeof fetch)).toBe('Caf�');
        const long = new TextEncoder().encode(`<title>Long read</title>${'界'.repeat(100_000)}`);
        expect(await fetchAndroidLinkTitle(url, (async () => polyfillResponse(long)) as typeof fetch)).toBe('Long read');
    });

    it('renames a saved bare-URL capture from its page title', async () => {
        const storage = seed();
        const loads: string[] = [];
        enrichAndroidCaptureTitle('shared', ` ${url} `, async (address) => { loads.push(address); return 'A shared headline'; });
        await settle(() => storage.stored().tasks[0].title !== url);
        expect(loads).toEqual([url]);
        expect(storage.stored().tasks[0]).toMatchObject({ title: 'A shared headline', attachments: [{ uri: url, title: 'A shared headline' }] });
        expect(useTaskStore.getState()._tasksById.get('shared')?.title).toBe('A shared headline');
        await settle(() => hostEvents.length > 0);
        expect(hostEvents).toEqual(['{"type":"linkTitle"}']);
    });

    it('makes no request when Look up page titles is off, the text is not a bare URL, or the host is iOS', async () => {
        seed({ fetchLinkTitles: false });
        const loads: string[] = [];
        const loader = async (address: string) => { loads.push(address); return 'Title'; };
        enrichAndroidCaptureTitle('shared', url, loader);
        enrichAndroidCaptureTitle('shared', `Read ${url}`, loader);
        resetForTests();
        seed();
        globals.__mindwtrHostPlatform = 'ios';
        enrichAndroidCaptureTitle('shared', url, loader);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(loads).toEqual([]);
        expect(hostEvents).toEqual([]);
    });

    it('looks up only links the editor save added as bare URLs', async () => {
        const storage = seed();
        const added: Attachment = { ...createCapturedWebLinkAttachment('https://docs.example.org/guide', new Date(createdAt)), id: 'added' };
        const labeled: Attachment = { id: 'labeled', kind: 'link', title: 'My label', uri: 'https://docs.example.org/other', createdAt, updatedAt: createdAt };
        const task = storage.stored().tasks[0];
        const committed = [...task.attachments!, added, labeled];
        const saved = { ...task, attachments: committed, rev: 2 };
        await storage.adapter.saveData({ ...storage.stored(), tasks: [saved] });
        useTaskStore.setState({ _allTasks: [saved] });
        const loads: string[] = [];
        enrichAndroidEditorLinkTitles({ taskId: 'shared', baseline: task.attachments!, committed }, async (address) => { loads.push(address); return 'Guide'; });
        await settle(() => storage.stored().tasks[0].attachments?.some((row) => row.title === 'Guide') === true);
        expect(loads).toEqual(['https://docs.example.org/guide']);
        await settle(() => hostEvents.length > 0);
        expect(hostEvents).toEqual(['{"type":"linkTitle"}']);
        expect(storage.stored().tasks[0].attachments?.map((row) => row.title)).toEqual([task.attachments![0].title, 'Guide', 'My label']);
    });
});
