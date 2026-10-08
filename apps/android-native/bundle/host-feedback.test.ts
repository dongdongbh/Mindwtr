import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import vm from 'node:vm';
import { build } from 'esbuild';

const endpoint = 'https://feedback.mindwtr.app';
const metadata = { appVersion: '1.3.3', build: '1', platform: 'ios', os: 'ios 17.5.1', locale: 'en-US', installChannel: 'app-store' };
const request = { category: 'bug', message: ' Synthetic feedback ', includeDiagnostics: false };
const databases: Database[] = [];
let source: string;
beforeAll(async () => {
    const built = await build({ stdin: { contents: `
        import './host-entry';
        import { useTaskStore } from '../../../packages/core/src/store';
        import { logError, logInfo, addBreadcrumb } from '../../../packages/core/src/index';
        import { acquireWorkspaceTransitionLock, initializeSandboxRuntime } from '../../../packages/core/src/sandbox';
        globalThis.fixture = {
            failSave: () => useTaskStore.setState({ persistenceFailure: { message: 'private failure' } }),
            sandbox: () => initializeSandboxRuntime(true), transition: acquireWorkspaceTransitionLock,
            error: () => logError(new Error('Synthetic failure token=private-token'), { scope: 'sync', context: { taskTitle: 'private task' } }),
            info: () => logInfo('Synthetic recent operation', { scope: 'sync' }),
            breadcrumb: () => addBreadcrumb('sync:manual'),
        };
    `, resolveDir: import.meta.dir, loader: 'ts' }, bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent' });
    source = built.outputFiles[0].text;
});
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
};
const fixture = () => {
    const database = new Database(':memory:'); databases.push(database);
    const requests: { url: string; init?: RequestInit }[] = [], writes: string[] = [], operations: string[] = [];
    let wire: typeof fetch = async () => new Response(null, { status: 204 });
    let text = '', failLog = false, cancelNext = false, beforeRead: (() => void) | undefined;
    class Controller extends AbortController {
        constructor() { super(); if (cancelNext) { cancelNext = false; this.abort(); } }
    }
    // The real bundled module runs against SQLite and a closed synthetic native port.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state: Record<string, any> = {
        AbortController: Controller, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout,
        __mindwtrHostPlatform: 'ios', console: { info() {}, warn() {}, error() {}, log() {} },
        fetch: (input: RequestInfo | URL, init?: RequestInit) => { requests.push({ url: String(input), init }); return wire(input, init); },
        __mindwtrNative: {
            sqlExec: (sql: string) => { writes.push('sqlExec'); database.exec(sql); return null; },
            sqlRun: (sql: string, params: string) => { writes.push('sqlRun'); database.query(sql).run(...JSON.parse(params)); return null; },
            sqlAll: (sql: string, params: string) => JSON.stringify(database.query(sql).all(...JSON.parse(params))),
            nowMs: () => Date.now(), randomBytes: (count: number) => JSON.stringify(Array(count).fill(7)), log() {},
            logFile: (operation: string, value: string) => {
                operations.push(operation);
                if (operation === 'read') beforeRead?.();
                if (failLog) throw new Error('private diagnostic error');
                if (['path', 'ensure'].includes(operation)) return 'files/logs/mindwtr.log';
                if (operation === 'exists') return text ? '1' : '';
                if (operation === 'isAbsent') return text ? '' : '1';
                if (operation === 'size') return String(text.length);
                if (operation === 'read') return text;
                if (operation === 'append') { text += value; return ''; }
                if (operation === 'write') { text = value; return ''; }
                if (operation === 'delete') { const had = Boolean(text); text = ''; return had ? '1' : ''; }
                throw new Error('Unexpected diagnostic operation');
            },
            rnStateCommit: () => null, kvGet: () => '[null]',
            kvSet: () => { writes.push('kvSet'); return null; }, kvRemove: () => { writes.push('kvRemove'); return null; },
            secretCall: () => { throw new Error('Feedback must not read credentials'); },
            fileList: () => 'null', fileRead: () => { throw new Error('Feedback must not read files'); }, fileDelete: () => { writes.push('fileDelete'); return null; },
        },
    };
    vm.runInNewContext(source, state);
    const poll = async (ticket: string) => {
        for (let step = 0; step < 100; step++) {
            const answer = state.MindwtrHost.poll(ticket);
            if (answer !== null) return JSON.parse(answer);
            await new Promise((done) => setTimeout(done, 0));
        }
        throw new Error('Feedback operation did not settle');
    };
    const boot = async () => {
        expect((await poll(state.MindwtrHost.boot('', ''))).ok).toBe(true);
        await poll(state.MindwtrHost.logClearChecked());
        requests.length = 0; writes.length = 0; operations.length = 0; text = '';
    };
    const start = (input: unknown = request, url: unknown = endpoint, meta: unknown = metadata) =>
        state.MindwtrHost.iosSubmitFeedback(typeof input === 'string' ? input : JSON.stringify(input), JSON.stringify(meta), url);
    return { state, requests, writes, operations, poll, boot, start,
        send: (input: unknown = request, url: unknown = endpoint, meta: unknown = metadata) => poll(start(input, url, meta)),
        wire: (value: typeof fetch) => { wire = value; }, text: () => text,
        saved: (value: string) => { text = value; }, failLog: () => { failLog = true; }, cancelNext: () => { cancelNext = true; },
        beforeRead: (work: () => void) => { beforeRead = work; } };
};

describe('actual native feedback bridge', () => {
    it('starts no request at boot/configuration and exposes only shared categories/configured', async () => {
        const f = fixture(); expect(f.requests).toEqual([]); await f.boot();
        expect(await f.poll(f.state.MindwtrHost.iosFeedbackConfiguration(` ${endpoint} `))).toEqual({ ok: true,
            value: { configured: true, categories: ['bug', 'feature', 'other'] } });
        expect(f.requests).toEqual([]); expect(f.operations).toEqual([]); expect(f.writes).toEqual([]);
    });
    it.each(['', 'http://feedback.mindwtr.app', `${endpoint}/other`, `${endpoint}?token=private`, 'https://feedback.mindwtr.app.attacker.test', 'https://name:secret@feedback.mindwtr.app', null])('fails closed for endpoint %# without diagnostics/HTTP', async (url) => {
        const f = fixture(); await f.boot();
        expect((await f.poll(f.state.MindwtrHost.iosFeedbackConfiguration(url))).value.configured).toBe(false);
        expect(await f.send(request, url)).toEqual({ ok: false, error: 'feedback_not_configured' });
        expect(f.requests).toEqual([]); expect(f.operations).toEqual([]); expect(f.writes).toEqual([]);
    });
    it.each([201, 204])('acknowledges one normalized POST on %i without reading response JSON or leaking its input', async (status) => {
        const f = fixture(); await f.boot(); f.wire(async () => new Response(status === 204 ? null : 'not JSON', { status }));
        expect(await f.send({ ...request, email: ' synthetic@example.test ' })).toEqual({ ok: true, value: { status: 'sent' } });
        expect(f.requests).toHaveLength(1);
        const { url, init } = f.requests[0]; expect(url).toBe(endpoint);
        expect(init?.method).toBe('POST'); expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
        expect(init?.redirect).toBe('error'); expect(init?.signal).toBeInstanceOf(AbortSignal);
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({ category: 'bug', message: 'Synthetic feedback', email: 'synthetic@example.test', metadata, submittedAt: expect.any(String) });
        expect(Number.isFinite(Date.parse(body.submittedAt))).toBe(true);
        expect(f.operations).not.toContain('read'); expect(f.writes).toEqual([]);
        const lines = f.text().trim().split('\n').map((line) => JSON.parse(line));
        expect(lines).toEqual([{ ts: expect.any(String), level: 'info', scope: 'native-ios',
            message: 'Native iOS feedback submission acknowledged', context: { releaseCheck: 'v1.3.5/ios-feedback', outcome: 'sent' } }]);
        for (const value of ['Synthetic feedback', 'synthetic@example.test', endpoint, '1.3.3']) expect(f.text()).not.toContain(value);
    });
    it.each([
        ['invalid_category', { ...request, category: 'invalid' }], ['message_required', { ...request, message: '  ' }],
        ['message_too_long', { ...request, message: 'a'.repeat(4001) }], ['invalid_email', { ...request, email: 'invalid' }],
        ['feedback_invalid_request', { ...request, endpoint }], ['feedback_invalid_request', { ...request, includeDiagnostics: 'true' }],
        ['feedback_invalid_request', { ...request, message: 1 }], ['feedback_invalid_request', { category: 'bug', message: 'text' }],
        ['feedback_invalid_request', { ...request, diagnostics: { logs: 'private' } }], ['feedback_invalid_request', 'malformed {'],
    ])('refuses %s before diagnostics or transport', async (error, input) => {
        const f = fixture(); await f.boot(); expect(await f.send(input)).toEqual({ ok: false, error });
        expect(f.requests).toEqual([]); expect(f.operations).toEqual([]); expect(f.writes).toEqual([]);
    });
    it('refuses arbitrary metadata and oversized closed envelopes before IO', async () => {
        const f = fixture(); await f.boot();
        expect(await f.send(request, endpoint, { ...metadata, deviceId: 'private' })).toEqual({ ok: false, error: 'feedback_invalid_request' });
        expect(await f.send(' '.repeat(64_001))).toEqual({ ok: false, error: 'feedback_invalid_request' });
        expect(f.requests).toEqual([]); expect(f.operations).toEqual([]);
    });
    it.each(['boot', 'platform', 'sandbox', 'transition', 'persistence'])('refuses %s without diagnostics or HTTP', async (guard) => {
        const f = fixture(); if (guard !== 'boot') await f.boot();
        if (guard === 'platform') f.state.__mindwtrHostPlatform = 'android';
        if (guard === 'sandbox') f.state.fixture.sandbox();
        if (guard === 'transition') f.state.fixture.transition();
        if (guard === 'persistence') f.state.fixture.failSave();
        expect(await f.send({ ...request, includeDiagnostics: true })).toEqual({ ok: false, error: 'feedback_not_ready' });
        expect((await f.poll(f.state.MindwtrHost.iosFeedbackConfiguration(endpoint))).error).toBe('feedback_not_ready');
        expect(f.requests).toEqual([]); expect(f.operations).toEqual([]);
    });
    it.each(['bug', 'feature', 'other'])('omits diagnostics unless Bug explicitly opts in (%s)', async (category) => {
        const f = fixture(); await f.boot(); f.saved('not shared');
        expect((await f.send({ ...request, category, includeDiagnostics: category !== 'bug' })).ok).toBe(true);
        expect(JSON.parse(String(f.requests[0].init?.body))).not.toHaveProperty('diagnostics');
        expect(f.operations).not.toContain('read'); expect(f.writes).toEqual([]);
    });
    it('captures sanitized bounded complete saved/session lines while logging stays off and snapshot remains volatile', async () => {
        const f = fixture(); await f.boot(); f.state.fixture.error(); f.state.fixture.info(); f.state.fixture.breadcrumb();
        expect(f.text()).toBe('');
        const saved = { ts: new Date().toISOString(), level: 'error', scope: 'sync', message: 'Saved failure Authorization: Bearer private-secret',
            context: { password: 'private-password', taskTitle: 'private-title', url: 'https://name:secret@example.test?token=private-query' }, unknown: 'private-extra' };
        f.saved('rotated fragment\n' + JSON.stringify(saved) + '\n' + Array.from({ length: 500 }, (_, i) => JSON.stringify({
            ts: new Date(Date.now() - 5_000 - i).toISOString(), level: 'info', scope: 'sync', message: `Routine ${i}` })).join('\n'));
        expect((await f.send({ ...request, includeDiagnostics: true })).ok).toBe(true);
        const logs = JSON.parse(String(f.requests[0].init?.body)).diagnostics.logs as string;
        expect(logs.length).toBeLessThanOrEqual(20_000);
        const lines = logs.split('\n').map((line) => JSON.parse(line));
        expect(lines.some(({ message }) => message.includes('Saved failure'))).toBe(true);
        expect(lines.some(({ message }) => message.includes('Synthetic failure'))).toBe(true);
        expect(lines.some(({ message }) => message === 'Synthetic recent operation')).toBe(true);
        expect(lines.at(-1).message).toBe('Feedback diagnostics snapshot');
        expect(lines.at(-1).context.debugLoggingEnabled).toBe('false'); expect(lines.at(-1).context.breadcrumbs).toContain('sync:manual');
        for (const value of ['private-token', 'private task', 'private-secret', 'private-password', 'private-title', 'name:secret', 'private-query', 'private-extra', 'rotated fragment']) expect(logs).not.toContain(value);
        expect(f.text()).not.toContain('Feedback diagnostics snapshot'); expect(f.operations.filter((op) => op === 'read')).toHaveLength(1);
        expect(f.writes).toEqual([]);
    });
    it('clears volatile evidence with checked Clear and still sends a snapshot when file IO is unavailable', async () => {
        const f = fixture(); await f.boot(); f.state.fixture.error();
        await f.poll(f.state.MindwtrHost.logClearChecked()); f.failLog();
        expect(await f.send({ ...request, includeDiagnostics: true })).toEqual({ ok: true, value: { status: 'sent' } });
        const logs = JSON.parse(String(f.requests[0].init?.body)).diagnostics.logs as string;
        expect(logs).toContain('Feedback diagnostics snapshot'); expect(logs).not.toContain('Synthetic failure');
        expect(f.requests).toHaveLength(1); expect(f.writes).toEqual([]);
    });
    it('rechecks current workspace after diagnostics and refuses before POST', async () => {
        const f = fixture(); await f.boot(); f.saved(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', scope: 'sync', message: 'Saved' }));
        f.beforeRead(() => f.state.fixture.transition());
        expect(await f.send({ ...request, includeDiagnostics: true })).toEqual({ ok: false, error: 'feedback_not_ready' });
        expect(f.requests).toEqual([]); expect(f.writes).toEqual([]);
    });
    it('rejects a stale workspace after the single POST without publishing a sent result or retrying', async () => {
        const f = fixture(); await f.boot();
        f.wire(async () => { f.state.fixture.transition(); return new Response(null, { status: 204 }); });
        expect(await f.send()).toEqual({ ok: false, error: 'feedback_not_ready' });
        expect(f.requests).toHaveLength(1); expect(f.text()).toBe(''); expect(f.writes).toEqual([]);
    });
    it.each(['http', 'transport'])('returns fixed failure without retry or success marker on %s error', async (kind) => {
        const f = fixture(); await f.boot(); f.wire(async () => {
            if (kind === 'transport') throw new Error('private response credentials/body');
            return new Response('private remote text', { status: 503 });
        });
        expect(await f.send()).toEqual({ ok: false, error: 'feedback_failed' });
        expect(f.requests).toHaveLength(1); expect(f.text()).toBe(''); expect(f.writes).toEqual([]);
    });
    it('refuses pre-cancellation and a canceled held reply, then permits only a fresh explicit attempt', async () => {
        const f = fixture(); await f.boot(); f.cancelNext();
        expect(await f.send()).toEqual({ ok: false, error: 'feedback_cancelled' }); expect(f.requests).toEqual([]);
        const held = deferred<Response>(); f.wire(() => held.promise);
        const ticket = f.start(); expect(f.requests).toHaveLength(1); f.state.MindwtrHost.abort(ticket);
        expect(f.requests[0].init?.signal?.aborted).toBe(true); held.resolve(new Response(null, { status: 204 }));
        expect(await f.poll(ticket)).toEqual({ ok: false, error: 'feedback_cancelled' });
        expect(f.text()).toBe(''); expect(f.requests).toHaveLength(1);
        f.wire(async () => new Response(null, { status: 204 })); expect((await f.send()).ok).toBe(true);
        expect(f.requests).toHaveLength(2); expect(f.writes).toEqual([]);
    });
});
