import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import vm from 'node:vm';
import { build } from 'esbuild';

const bundle = 'tech.example.mindwtr.dev';
const installed = '1.5.0';
const listing = 'https://apps.apple.com/app/id123456789';
const databases: Database[] = [];
let source: string;

beforeAll(async () => {
    const built = await build({
        stdin: { contents: `
            import './host-entry';
            import { useTaskStore } from '../../../packages/core/src/store';
            import { acquireWorkspaceTransitionLock, initializeSandboxRuntime } from '../../../packages/core/src/sandbox';
            globalThis.fixture = {
                failSave: () => useTaskStore.setState({ persistenceFailure: { message: 'synthetic failure' } }),
                sandbox: () => initializeSandboxRuntime(true),
                transition: acquireWorkspaceTransitionLock,
            };
        `, resolveDir: import.meta.dir, loader: 'ts' },
        bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent',
    });
    source = built.outputFiles[0].text;
});
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

const result = (version: string) => new Response(JSON.stringify({ results: [{ version, trackViewUrl: listing }] }));
const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
};

const fixture = () => {
    const database = new Database(':memory:'); databases.push(database);
    const requests: { url: string; init?: RequestInit }[] = [], writes: string[] = [], lines: string[] = [];
    let wire: typeof fetch = async () => result(requests.length === 1 ? '1.0.0' : '2.0.0');
    let cancelNext = false, failLog = false, logText = '';
    class Controller extends AbortController {
        constructor() { super(); if (cancelNext) { cancelNext = false; this.abort(); } }
    }
    const state: Record<string, any> = {
        AbortController: Controller, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout,
        __mindwtrHostPlatform: 'ios', console: { info() {}, warn() {}, error() {}, log() {} },
        fetch: (input: RequestInfo | URL, init?: RequestInit) => {
            requests.push({ url: String(input), init }); return wire(input, init);
        },
        __mindwtrNative: {
            sqlExec: (sql: string) => { writes.push('sqlExec'); database.exec(sql); return null; },
            sqlRun: (sql: string, params: string) => { writes.push('sqlRun'); database.query(sql).run(...JSON.parse(params)); return null; },
            sqlAll: (sql: string, params: string) => JSON.stringify(database.query(sql).all(...JSON.parse(params))),
            nowMs: () => Date.now(), randomBytes: (count: number) => JSON.stringify(Array(count).fill(7)),
            log: (line: string) => { lines.push(line); },
            logFile: (operation: string, text: string) => {
                if (failLog) throw new Error('synthetic diagnostic failure');
                if (['path', 'ensure'].includes(operation)) return 'files/logs/mindwtr.log';
                if (operation === 'size') return String(logText.length);
                if (operation === 'read') return logText;
                if (operation === 'exists') return logText ? '1' : '';
                if (operation === 'isAbsent') return logText ? '' : '1';
                if (operation === 'append') { logText += text; return ''; }
                if (operation === 'write') { logText = text; return ''; }
                if (operation === 'delete') { logText = ''; return '1'; }
                throw new Error('Unexpected diagnostic operation');
            },
            rnStateCommit: () => null,
            kvGet: () => '[null]',
            kvSet: () => { writes.push('kvSet'); return null; },
            kvRemove: () => { writes.push('kvRemove'); return null; },
            fileList: () => 'null', fileRead: () => '', fileDelete: () => { writes.push('fileDelete'); return null; },
        },
    };
    vm.runInNewContext(source, state);
    const poll = async (ticket: string) => {
        for (let step = 0; step < 100; step++) {
            const answer = state.MindwtrHost.poll(ticket);
            if (answer !== null) return JSON.parse(answer);
            await new Promise((done) => setTimeout(done, 0));
        }
        throw new Error('Host operation did not settle');
    };
    const boot = async () => {
        const answer = await poll(state.MindwtrHost.boot('', ''));
        expect(answer.ok).toBe(true);
        expect(requests).toEqual([]);
        writes.length = 0; lines.length = 0; logText = '';
    };
    return { state, requests, writes, lines, poll, boot,
        lookup: (identifier: unknown = bundle, version: unknown = installed) => poll(state.MindwtrHost.iosAboutAppStoreInfo(identifier, version)),
        wire: (fetcher: typeof fetch) => { wire = fetcher; },
        cancelNext: () => { cancelNext = true; }, failLog: () => { failLog = true; }, logText: () => logText };
};

describe('actual exported iOS About lookup bridge', () => {
    it('stays inactive at initialization/boot, then returns the shared two-region result without domain/config writes', async () => {
        const f = fixture(); expect(f.requests).toEqual([]); await f.boot();
        expect(await f.lookup()).toEqual({ ok: true, value: { version: '2.0.0', trackViewUrl: listing, updateAvailable: true } });
        expect(f.requests).toHaveLength(2);
        expect(new URL(f.requests[0].url).searchParams.get('bundleId')).toBe(bundle);
        expect(new URL(f.requests[0].url).searchParams.has('country')).toBe(false);
        expect(new URL(f.requests[1].url).searchParams.get('country')).toBe('US');
        for (const { init } of f.requests) {
            expect(init?.signal).toBeInstanceOf(AbortSignal); expect(init?.signal?.aborted).toBe(false);
            expect(init?.cache).toBe('no-store');
        }
        expect(f.writes).toEqual([]);
        const entries = f.logText().trim().split('\n').map((line) => JSON.parse(line));
        expect(entries).toHaveLength(1);
        expect(entries[0]).toEqual({ ts: expect.any(String), level: 'info', scope: 'native-ios',
            message: 'Native iOS App Store information fetched',
            context: { releaseCheck: 'v1.3.5/ios-about-app-store', outcome: 'fetched' } });
        for (const privateValue of [bundle, installed, listing, '2.0.0']) expect(f.logText()).not.toContain(privateValue);
    });

    it.each(['2', 'v2.0.0-beta+build', ' 3.0.0 '])('uses the shared installed-version comparison for %s', async (version) => {
        const f = fixture(); await f.boot();
        expect(await f.lookup(bundle, version)).toEqual({ ok: true, value: { version: '2.0.0', trackViewUrl: listing, updateAvailable: false } });
        expect(f.writes).toEqual([]);
    });

    it('preserves the successful result if the diagnostic sink fails', async () => {
        const f = fixture(); await f.boot(); f.failLog();
        expect(await f.lookup()).toEqual({ ok: true, value: { version: '2.0.0', trackViewUrl: listing, updateAvailable: true } });
        expect(f.writes).toEqual([]);
    });

    it.each(['', 'tech..example', '.tech.example', 'tech.example.', 'tech example.dev', 'tech.example/dev', 'single', 'a.'.repeat(128) + 'b', null])('refuses invalid identity %# before HTTP', async (identifier) => {
        const f = fixture(); await f.boot();
        expect(await f.lookup(identifier)).toEqual({ ok: false, error: 'INVALID_INPUT: Invalid App Store bundle identifier' });
        expect(f.requests).toEqual([]); expect(f.writes).toEqual([]); expect(f.logText()).toBe('');
    });

    it.each(['', '   ', '1.0\n', '1.0\u0000', '1.0\u007f', '1.0\u0085', 'a'.repeat(201), null])('refuses invalid installed version %# before HTTP', async (version) => {
        const f = fixture(); await f.boot();
        expect(await f.lookup(bundle, version)).toEqual({ ok: false, error: 'INVALID_INPUT: Invalid installed app version' });
        expect(f.requests).toEqual([]); expect(f.writes).toEqual([]); expect(f.logText()).toBe('');
    });

    it.each(['boot', 'platform', 'sandbox', 'transition', 'persistence'])('refuses %s without HTTP or writes', async (guard) => {
        const f = fixture();
        if (guard !== 'boot') await f.boot();
        if (guard === 'platform') f.state.__mindwtrHostPlatform = 'android';
        if (guard === 'sandbox') f.state.fixture.sandbox();
        if (guard === 'transition') f.state.fixture.transition();
        if (guard === 'persistence') f.state.fixture.failSave();
        const answer = await f.lookup();
        expect(answer.ok).toBe(false);
        expect(answer.error).toStartWith(guard === 'persistence' ? 'SAVE_FAILED:' : 'NOT_READY:');
        expect(f.requests).toEqual([]); expect(f.writes).toEqual([]); expect(f.logText()).toBe('');
    });

    it('does not fetch when submit supplies an already canceled signal', async () => {
        const f = fixture(); await f.boot(); f.cancelNext();
        expect(await f.lookup()).toEqual({ ok: false, error: 'CANCELLED: App Store lookup was cancelled' });
        expect(f.requests).toEqual([]); expect(f.writes).toEqual([]); expect(f.logText()).toBe('');
    });

    it('does not start the US lookup after a canceled first fetch ignores its signal', async () => {
        const f = fixture(); await f.boot(); const held = deferred<Response>(); f.wire(() => held.promise);
        const ticket = f.state.MindwtrHost.iosAboutAppStoreInfo(bundle, installed);
        expect(f.requests).toHaveLength(1); f.state.MindwtrHost.abort(ticket);
        expect(f.requests[0].init?.signal?.aborted).toBe(true); held.resolve(result('1.0.0'));
        expect(await f.poll(ticket)).toEqual({ ok: false, error: 'CANCELLED: App Store lookup was cancelled' });
        expect(f.requests).toHaveLength(1); expect(f.writes).toEqual([]); expect(f.logText()).toBe('');
    });

    it.each([1, 2])('rejects cancellation during region %i body decoding even if JSON ignores its signal', async (region) => {
        const f = fixture(); await f.boot(); const held = deferred<unknown>(), started = deferred<void>();
        f.wire(async () => {
            const response = result('1.0.0');
            if (f.requests.length === region) response.json = () => { started.resolve(); return held.promise; };
            return response;
        });
        const ticket = f.state.MindwtrHost.iosAboutAppStoreInfo(bundle, installed); await started.promise;
        f.state.MindwtrHost.abort(ticket); held.resolve({ results: [{ version: '1.0.0', trackViewUrl: listing }] });
        expect(await f.poll(ticket)).toEqual({ ok: false, error: 'CANCELLED: App Store lookup was cancelled' });
        expect(f.requests).toHaveLength(region); expect(f.writes).toEqual([]); expect(f.logText()).toBe('');
    });

    it('rechecks a workspace change between requests and sanitizes transport failures', async () => {
        const changed = fixture(); await changed.boot();
        changed.wire(async () => { changed.state.fixture.transition(); return result('1.0.0'); });
        expect(await changed.lookup()).toEqual({ ok: false, error: 'NOT_READY: App Store lookup is unavailable' });
        expect(changed.requests).toHaveLength(1); expect(changed.writes).toEqual([]); expect(changed.logText()).toBe('');
        const failed = fixture(); await failed.boot(); failed.wire(async () => { throw new Error('private response URL/body'); });
        expect(await failed.lookup()).toEqual({ ok: false, error: 'LOOKUP_FAILED: App Store lookup could not be completed' });
        expect(failed.requests).toHaveLength(1); expect(failed.writes).toEqual([]); expect(failed.lines).toEqual([]); expect(failed.logText()).toBe('');
    });
});
