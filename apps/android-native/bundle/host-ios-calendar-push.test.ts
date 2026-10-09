import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { build } from 'esbuild';
import type { AppData, Task } from '../../../packages/core/src/types';

let source: string;
const polyfills = readFileSync(new URL('./host-polyfills.js', import.meta.url), 'utf8');
const fixtures: ReturnType<typeof fixture>[] = [];
const at = '2026-10-09T00:00:00.000Z';
const task = (id: string): Task => ({ id, title: `PRIVATE ${id}`, status: 'inbox', contexts: [], tags: [],
    dueDate: '2026-10-10', createdAt: at, updatedAt: at });
const data = (tasks = [task('task-é')]): AppData => ({ tasks, projects: [], sections: [], areas: [],
    settings: { externalCalendars: [], deviceId: 'fixture-device' } });
const pushNames = ['mindwtr:calendar-push-sync:enabled', 'mindwtr:calendar-push-sync:calendar-id',
    'mindwtr:calendar-push-sync:target-calendar-id', 'mindwtr:calendar-push-sync:color', 'mindwtr:calendar-push-sync:creation-intent'];
const setting = (edit: unknown) => ({ requestId: '12345678-1234-4234-8234-123456789abc', edit });

beforeAll(async () => {
    const built = await build({ stdin: { contents: `
        import './host-entry';
        import { useTaskStore, getStorageAdapter, setStorageAdapter, getPersistenceStatus, flushPendingSave, resetForTests } from '../../../packages/core/src/store';
        import { acquireWorkspaceTransitionLock, initializeSandboxRuntime } from '../../../packages/core/src/sandbox';
        let subscriptions = 0;
        const subscribe = useTaskStore.subscribe;
        useTaskStore.subscribe = (...args) => {
            const counted = args.length === 2;
            if (counted) subscriptions += 1;
            const stop = subscribe(...args);
            return () => { if (counted) subscriptions -= 1; stop(); };
        };
        globalThis.fixture = { state: useTaskStore.getState, set: useTaskStore.setState,
            adapter: getStorageAdapter, replaceAdapter: setStorageAdapter, persistence: getPersistenceStatus,
            flush: flushPendingSave, reset: resetForTests, subscriptions: () => subscriptions,
            sandbox: () => initializeSandboxRuntime(true), transition: acquireWorkspaceTransitionLock,
            install: d => useTaskStore.setState({ _allTasks: d.tasks, _allProjects: d.projects,
                _allSections: d.sections, _allAreas: d.areas, settings: d.settings }),
        };
    `, resolveDir: import.meta.dir, loader: 'ts' }, bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent' });
    source = built.outputFiles[0].text;
});

afterEach(async () => {
    for (const f of fixtures.splice(0)) {
        f.releaseAll(); f.state.__resumeHostCalls();
        await f.state.fixture.flush(); f.state.fixture.reset(); f.database.close();
    }
});

const fixture = (options: { platform?: string; push?: boolean; due?: boolean; enabled?: boolean } = {}) => {
    const database = new Database(':memory:');
    const sql: string[] = [], genericCalls: Record<string, any>[] = [], privateCalls: Record<string, any>[] = [];
    const aborted: string[] = [], due: string[][] = [], kv = new Map<string, string>();
    kv.set(pushNames[0], options.enabled === false ? '0' : '1'); kv.set(pushNames[2], 'target'); kv.set(pushNames[3], '#123456');
    const mappings = new Map<string, Record<string, any>>(), ready: Record<string, any>[] = [];
    const debounces = new Map<number, () => void>(), releases: (() => void)[] = [];
    let nextID = 0, nextDebounce = 0, writeID = 0, logText = '', failLog = false, failNext: string | null = null;
    let hold: { op: string; entered: () => void; count: number } | null = null;
    const calendars = [{ id: 'target', title: 'PRIVATE CALENDAR', color: '#123456', allowsModifications: true }];
    const privateValue = (input: Record<string, any>) => {
        if (input.op === 'readState') return pushNames.map((name) => kv.get(name) ?? null);
        if (input.op === 'setState') { if (input.value === null) kv.delete(input.name); else kv.set(input.name, input.value); return null; }
        if (input.op === 'read') return input.request.op === 'permissions' ? { status: 'granted' }
            : input.request.op === 'calendars' ? structuredClone(calendars) : [];
        if (input.op === 'sources') return [{ id: 'source', name: 'PRIVATE ACCOUNT', type: 'caldav' }];
        if (input.op === 'mapping') return mappings.get(input.taskId) ?? null;
        if (input.op === 'mappings') return [...mappings.values()];
        if (input.op === 'deleteMapping') { mappings.delete(input.expected.taskId); return null; }
        if (input.op === 'ackMapping') { if (input.entry) mappings.set(input.entry.taskId, structuredClone(input.entry));
            else { for (const [id, row] of mappings) if (row.calendarEventId === 'event-deleted') mappings.delete(id); } return null; }
        if (input.op === 'write') {
            writeID += 1;
            return { operationId: `11111111-1111-4111-8111-${String(writeID).padStart(12, '0')}`,
                result: input.request.op.startsWith('create') ? { kind: 'identifier', id: `event-${writeID}` } : { kind: 'completed' } };
        }
        throw new Error('Unexpected private operation');
    };
    const channel = (json: string, isPrivate: boolean) => {
        const input = JSON.parse(json), id = `io:${++nextID}`;
        (isPrivate ? privateCalls : genericCalls).push(structuredClone(input));
        const failure = failNext; failNext = null;
        const finish = () => ready.push(failure ? { id, error: failure } : { id,
            value: isPrivate ? privateValue(input) : input.op === 'permissions' ? { status: 'granted' }
                : input.op === 'calendars' ? structuredClone(calendars) : [] });
        if (isPrivate && hold?.op === input.op) {
            hold.count -= 1; const entered = hold.entered;
            if (hold.count === 0) hold = null;
            releases.push(finish); entered();
        } else finish();
        return id;
    };
    const state: Record<string, any> = {
        AbortController, URL, TextEncoder, TextDecoder,
        setTimeout: (callback: () => void, delay?: number) => {
            if (delay === 2500) { const id = --nextDebounce; debounces.set(id, callback); return id; }
            return setTimeout(callback, delay);
        },
        clearTimeout: (id: any) => { if (!debounces.delete(id)) clearTimeout(id); },
        __mindwtrHostPlatform: options.platform ?? 'ios', console: { info() {}, warn() {}, error() {}, log() {} },
        __mindwtrNative: {
            sqlExec: (text: string) => { sql.push(text); database.exec(text); return null; },
            sqlRun: (text: string, params: string) => { sql.push(text); database.query(text).run(...JSON.parse(params)); return null; },
            sqlAll: (text: string, params: string) => { sql.push(text); return JSON.stringify(database.query(text).all(...JSON.parse(params))); },
            nowMs: () => Date.now(), randomBytes: (count: number) => JSON.stringify(Array(count).fill(7)), log() {},
            logFile: (operation: string, text: string) => {
                if (failLog) throw new Error('PRIVATE diagnostic failure');
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
            rnStateCommit: () => null, kvGet: (name: string) => JSON.stringify([kv.get(name) ?? null]),
            kvMultiGet: (json: string) => JSON.stringify(JSON.parse(json).map((name: string) => [name, kv.get(name) ?? null])),
            kvSet: (name: string, value: string) => { kv.set(name, value); return null; }, kvRemove: (name: string) => { kv.delete(name); return null; },
            fileList: () => 'null', fileRead: () => '', fileDelete: () => null,
            calendarCall: (json: string) => channel(json, false), calendarAbort: (id: string) => aborted.push(`generic:${id}`),
            ...(options.push === false ? {} : { calendarPushCall: (json: string) => channel(json, true), calendarPushAbort: (id: string) => aborted.push(id) }),
            ...(options.due === false ? {} : { calendarPushDue: (json: string) => { due.push(JSON.parse(json)); return null; } }),
            ioNext: () => ready.length ? JSON.stringify(ready.shift()) : '',
        },
    };
    const context = vm.createContext(state);
    vm.runInContext(polyfills, context); vm.runInContext(source, context);
    const spin = async (predicate: () => boolean) => {
        for (let step = 0; step < 2000; step++) { state.__pumpTimers(); if (predicate()) return;
            await new Promise((done) => setTimeout(done, 0)); }
        throw new Error('Host operation did not settle');
    };
    const poll = async (ticket: string) => {
        let answer: string | null = null;
        await spin(() => (answer = state.MindwtrHost.poll(ticket)) !== null);
        return JSON.parse(answer!);
    };
    const f = { state, database, sql, genericCalls, privateCalls, aborted, due, kv, mappings, poll, spin,
        raw: (method: string, json: string) => poll(state.MindwtrHost[method](json)),
        call: (method: string, input?: unknown) => poll(input === undefined ? state.MindwtrHost[method]() : state.MindwtrHost[method](JSON.stringify(input))),
        boot: async (seed = data()) => { expect(await poll(state.MindwtrHost.boot('', ''))).toMatchObject({ ok: true });
            state.fixture.install(seed); sql.length = 0; genericCalls.length = 0; privateCalls.length = 0; logText = ''; },
        hold: (op: string, count = 1) => { let entered!: () => void; const accepted = new Promise<void>((resolve) => { entered = resolve; });
            hold = { op, entered, count }; return { accepted, release: () => releases.shift()?.() }; },
        releaseAll: () => { hold = null; for (const release of releases.splice(0)) release(); state.__pumpTimers(); },
        fireDue: () => { for (const callback of debounces.values()) callback(); debounces.clear(); },
        debounceCount: () => debounces.size, failNext: (message: string) => { failNext = message; },
        failLog: () => { failLog = true; }, logText: () => logText,
    };
    fixtures.push(f); return f;
};

describe('actual private iOS Calendar push host facade', () => {
    it.each([{ push: false }, { due: false }, { platform: 'android' }])('keeps absent or partial capability and Android inactive: %j', async (options) => {
        const f = fixture(options); await f.boot();
        expect(typeof f.state.__mindwtrCalendarPushCall).toBe(options.push === false ? 'undefined' : 'function');
        expect(await f.call('iosCalendarPushStart')).toMatchObject({ ok: false, error: expect.stringContaining('NOT_READY') });
        expect(await f.call('iosCalendarPushStop')).toMatchObject({ ok: false, error: expect.stringContaining('NOT_READY') });
        expect(await f.call('iosCalendarPushRun', { ids: null })).toMatchObject({ ok: false });
        expect(f.privateCalls).toEqual([]); expect(f.due).toEqual([]); expect(f.state.fixture.subscriptions()).toBe(0);
        if (options.platform !== 'android') expect(await f.call('iosCalendarRead', { op: 'openSettings' })).toMatchObject({ ok: true });
    });

    it('starts exactly one shared watcher and emits coalesced due admission without provider work', async () => {
        const f = fixture(); await f.boot();
        expect(await f.call('iosCalendarPushStart')).toEqual({ ok: true, value: true });
        expect(await f.call('iosCalendarPushStart')).toEqual({ ok: true, value: true });
        expect(f.state.fixture.subscriptions()).toBe(1);
        const calls = f.privateCalls.length;
        f.state.fixture.install(data([{ ...task('task-é'), title: 'PRIVATE changed' }, task('e\u0301')]));
        f.state.fixture.install(data([{ ...task('task-é'), title: 'PRIVATE changed again' }, task('e\u0301')]));
        expect(f.debounceCount()).toBe(1); f.fireDue();
        expect(f.due).toEqual([['task-é', 'e\u0301']]); expect(f.privateCalls).toHaveLength(calls);
        expect(await f.call('iosCalendarPushStop')).toEqual({ ok: true, value: null });
        expect(f.state.fixture.subscriptions()).toBe(0); expect(f.sql).toEqual([]);
    });

    it('returns the saved disabled state without installing a watcher or running a provider', async () => {
        const f = fixture({ enabled: false }); await f.boot();
        expect(await f.call('iosCalendarPushStart')).toEqual({ ok: true, value: false });
        expect(f.state.fixture.subscriptions()).toBe(0); expect(f.privateCalls.map((call) => call.op)).toEqual(['readState']);
        expect(await f.call('iosCalendarPushStop')).toEqual({ ok: true, value: null }); expect(f.sql).toEqual([]);
    });

    it('uses the cached shared service for full then partial work and private mappings without SQL', async () => {
        const f = fixture(); await f.boot(data([task('é'), task('e\u0301')]));
        expect(await f.call('iosCalendarPushRun', { ids: null })).toEqual({ ok: true, value: null });
        expect(f.mappings.size).toBe(2);
        expect(f.privateCalls.filter((call) => call.op === 'write').map((call) => call.request.op)).toEqual(['createEvent', 'createEvent']);
        expect(await f.call('iosCalendarPushRun', { ids: ['e\u0301'] })).toEqual({ ok: true, value: null });
        expect(f.privateCalls.filter((call) => call.op === 'write').map((call) => [call.request.op, call.taskId]))
            .toEqual([['createEvent', 'é'], ['createEvent', 'e\u0301'], ['updateEvent', 'e\u0301']]);
        expect(f.sql).toEqual([]); expect(f.genericCalls).toEqual([]);
    });

    it('keeps the existing four workers and refuses a second owned command during a held run', async () => {
        const f = fixture(); await f.boot(data(Array.from({ length: 6 }, (_, i) => task(`task-${i}`))));
        const held = f.hold('write', 4), ticket = f.state.MindwtrHost.iosCalendarPushRun('{"ids":null}');
        await f.spin(() => f.privateCalls.filter((call) => call.op === 'write').length === 4);
        expect(f.state.MindwtrHost.poll(ticket)).toBeNull();
        expect(await f.call('iosCalendarPushRun', { ids: ['task-5'] })).toMatchObject({ ok: false, error: expect.stringContaining('already owned') });
        held.release(); await f.spin(() => f.privateCalls.filter((call) => call.op === 'write').length === 5);
        f.releaseAll(); expect(await f.poll(ticket)).toEqual({ ok: true, value: null });
        expect(f.mappings.size).toBe(6); expect(f.sql).toEqual([]);
    });

    it('waits for accepted Settings full work and reuses its watcher rather than creating another', async () => {
        const f = fixture({ enabled: false }); await f.boot();
        const held = f.hold('write'), ticket = f.state.MindwtrHost.iosCalendarPushSetting(JSON.stringify(setting({ type: 'push', before: false, enabled: true })));
        await f.spin(() => f.privateCalls.some((call) => call.op === 'write'));
        expect(f.state.MindwtrHost.poll(ticket)).toBeNull(); held.release();
        expect(await f.poll(ticket)).toMatchObject({ ok: true, value: { changed: true, open: 'push' } });
        expect(await f.call('iosCalendarPushStart')).toEqual({ ok: true, value: true });
        expect(f.state.fixture.subscriptions()).toBe(1); expect(f.sql).toEqual([]);
        expect(f.database.query('SELECT COUNT(*) AS n FROM native_request_receipts').get()).toEqual({ n: 0 });
    });

    it('Stop invalidates a held Start without installing a late watcher', async () => {
        const f = fixture(); await f.boot(); const held = f.hold('readState');
        const ticket = f.state.MindwtrHost.iosCalendarPushStart();
        expect(await f.call('iosCalendarPushStop')).toEqual({ ok: true, value: null });
        held.release(); expect(await f.poll(ticket)).toMatchObject({ ok: false, error: expect.stringContaining('lifecycle changed') });
        expect(f.state.fixture.subscriptions()).toBe(0);
        expect(await f.call('iosCalendarPushStart')).toEqual({ ok: true, value: true });
    });

    it.each(['queued', 'failed', 'sandbox', 'transition', 'adapter', 'boot'])('Stop retires the retained watcher after %s changes without admitting work', async (kind) => {
        const f = fixture(); await f.boot();
        expect(await f.call('iosCalendarPushStart')).toEqual({ ok: true, value: true });
        f.state.fixture.install(data([{ ...task('task-é'), title: 'PRIVATE pending' }]));
        expect(f.state.fixture.subscriptions()).toBe(1); expect(f.debounceCount()).toBe(1);
        if (kind === 'queued') await f.state.fixture.state().addTask('PRIVATE queued');
        if (kind === 'failed') f.state.fixture.set({ persistenceFailure: { message: 'PRIVATE failure' } });
        if (kind === 'sandbox') f.state.fixture.sandbox();
        if (kind === 'transition') f.state.fixture.transition();
        if (kind === 'adapter') f.state.fixture.replaceAdapter({});
        if (kind === 'boot') expect(await f.poll(f.state.MindwtrHost.bootRecovery('', ''))).toMatchObject({ ok: true });
        const privateCount = f.privateCalls.length, sqlCount = f.sql.length, cells = [...f.kv];
        expect(await f.call('iosCalendarPushStop')).toEqual({ ok: true, value: null });
        expect(f.state.fixture.subscriptions()).toBe(0); expect(f.debounceCount()).toBe(0);
        f.fireDue(); expect(f.due).toEqual([]);
        expect(f.privateCalls).toHaveLength(privateCount); expect(f.sql).toHaveLength(sqlCount); expect([...f.kv]).toEqual(cells);
        if (kind === 'queued') expect(f.state.fixture.persistence().queued).toBeGreaterThan(0);
        f.state.fixture.set({ persistenceFailure: null });
    });

    it('uses the fulfilled boot schema cache when native denies all generic SQL during owned work', async () => {
        const f = fixture(); await f.boot();
        const denied = () => { throw new Error('Generic SQL is denied under the native Calendar owner'); };
        f.state.__mindwtrNative.sqlExec = denied; f.state.__mindwtrNative.sqlRun = denied; f.state.__mindwtrNative.sqlAll = denied;
        expect(await f.call('iosCalendarPushStart')).toEqual({ ok: true, value: true });
        expect(await f.call('iosCalendarPushRun', { ids: null })).toEqual({ ok: true, value: null });
        expect(f.mappings.size).toBe(1);
        expect(await f.call('iosCalendarPushSetting', setting({ type: 'push', before: true, enabled: false })))
            .toMatchObject({ ok: true, value: { changed: true, open: null } });
        expect(await f.call('iosCalendarPushStop')).toEqual({ ok: true, value: null });
        expect(f.state.fixture.subscriptions()).toBe(0); expect(f.sql).toEqual([]);
    });

    it.each(['adapter', 'sandbox', 'transition', 'failed', 'generation'])('refuses %s change across a private await without later provider work', async (kind) => {
        const f = fixture(); await f.boot(); const held = f.hold('readState');
        const ticket = f.state.MindwtrHost.iosCalendarPushStart();
        if (kind === 'adapter') f.state.fixture.replaceAdapter({});
        if (kind === 'sandbox') f.state.fixture.sandbox();
        if (kind === 'transition') f.state.fixture.transition();
        if (kind === 'failed') f.state.fixture.set({ persistenceFailure: { message: 'PRIVATE failure' } });
        if (kind === 'generation') { await f.state.fixture.state().addTask('PRIVATE added'); await f.state.fixture.flush(); f.sql.length = 0; }
        held.release(); expect(await f.poll(ticket)).toMatchObject({ ok: false });
        expect(f.privateCalls.map((call) => call.op)).toEqual(['readState']); expect(f.state.fixture.subscriptions()).toBe(0);
        expect(f.sql).toEqual([]); f.state.fixture.set({ persistenceFailure: null });
    });

    it.each(['queued', 'inFlight', 'immediate', 'retrying'])('refuses %s persistence without flushing it or reaching private admission', async (kind) => {
        const f = fixture(); await f.boot();
        const adapter = f.state.fixture.adapter(), save = adapter.saveData.bind(adapter), schema = adapter.ensureSchema.bind(adapter);
        let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
        adapter.saveData = async (value: AppData) => { await held; return save(value); };
        if (kind === 'immediate') adapter.ensureSchema = async () => { await held; return schema(); };
        let saving: Promise<unknown> | undefined;
        if (kind === 'immediate') saving = f.state.fixture.state().updateTask('task-é', { title: 'PRIVATE changed' });
        else { await f.state.fixture.state().addTask('PRIVATE added');
            if (kind === 'inFlight') saving = f.state.fixture.flush();
            if (kind === 'retrying') saving = f.state.fixture.state().retryPersistence(); }
        try {
            expect(f.state.fixture.persistence()[kind]).toBeTruthy();
            expect(await f.call('iosCalendarPushStart')).toMatchObject({ ok: false, error: expect.stringContaining('NOT_READY') });
            expect(f.state.fixture.persistence()[kind]).toBeTruthy(); expect(f.privateCalls).toEqual([]); expect(f.sql).toEqual([]);
        } finally { release(); await saving; await f.state.fixture.flush(); }
    });

    it.each(['run', 'setting'])('refuses a stale generation after held %s mutation without mapping acknowledgement', async (method) => {
        const f = fixture({ enabled: method !== 'setting' }); await f.boot(); const held = f.hold('write');
        const ticket = method === 'run' ? f.state.MindwtrHost.iosCalendarPushRun('{"ids":null}')
            : f.state.MindwtrHost.iosCalendarPushSetting(JSON.stringify(setting({ type: 'push', before: false, enabled: true })));
        await f.spin(() => f.privateCalls.some((call) => call.op === 'write'));
        await f.state.fixture.state().addTask('PRIVATE later generation'); await f.state.fixture.flush(); f.sql.length = 0;
        held.release(); expect(await f.poll(ticket)).toMatchObject({ ok: false, error: expect.stringContaining('NOT_READY') });
        expect(f.privateCalls.some((call) => call.op === 'ackMapping')).toBe(false); expect(f.sql).toEqual([]);
    });

    it('uses only private channel abort, drops late answers and preserves native error rejection', async () => {
        const f = fixture(); await f.boot(); const held = f.hold('readState');
        const ticket = f.state.MindwtrHost.iosCalendarPushStart(); f.state.MindwtrHost.cancel(ticket);
        expect(await f.poll(ticket)).toMatchObject({ ok: false }); expect(f.aborted).toEqual(['io:1']);
        held.release(); f.state.__pumpTimers(); f.state.__resumeHostCalls();
        expect(f.state.fixture.subscriptions()).toBe(0);
        f.failNext('Calendar native read failed');
        expect(await f.call('iosCalendarPushStart')).toEqual({ ok: false, error: 'Calendar native read failed' });
        expect(await f.call('iosCalendarPushStart')).toEqual({ ok: true, value: true }); expect(f.sql).toEqual([]);
    });

    it.each([{}, [], null, { ids: false }, { ids: [''] }, { ids: ['x', 'x'] }, { ids: ['a'.repeat(501)] },
        { ids: ['漢'.repeat(400)] }, { ids: Array(10_001).fill('x') }, { ids: [], extra: true }].map((input) => ({ input })))('closes run grammar before provider work', async ({ input }) => {
        const f = fixture(); await f.boot();
        expect(await f.call('iosCalendarPushRun', input)).toMatchObject({ ok: false, error: expect.stringContaining('INVALID_INPUT') });
        expect(f.privateCalls).toEqual([]); expect(f.sql).toEqual([]);
    });

    it.each([{}, setting({ type: 'systemEnabled', enabled: true }), setting({ type: 'removeFeed', feedId: 'PRIVATE' }),
        { ...setting({ type: 'push', before: false, enabled: true }), extra: true },
        setting({ type: 'push', before: false, enabled: 'PRIVATE' })])('restricts Settings to shared validated push commands: %j', async (input) => {
        const f = fixture(); await f.boot();
        expect(await f.call('iosCalendarPushSetting', input)).toMatchObject({ ok: false, error: expect.stringContaining('INVALID_INPUT') });
        expect(f.privateCalls).toEqual([]); expect(f.sql).toEqual([]);
    });

    it('accepts exact distinct IDs and rejects oversized UTF8 and malformed JSON without parser excerpts', async () => {
        const f = fixture({ enabled: false }); await f.boot();
        expect(await f.call('iosCalendarPushRun', { ids: ['é', 'e\u0301', ' opaque ', '😀'.repeat(250)] })).toEqual({ ok: true, value: null });
        for (const json of ['{"ids":PRIVATE secret}', `{"ids":null}${'漢'.repeat(350_000)}`]) {
            const result = await f.raw('iosCalendarPushRun', json);
            expect(result).toMatchObject({ ok: false, error: expect.stringContaining('INVALID_INPUT') });
            expect(JSON.stringify(result)).not.toContain('PRIVATE');
        }
    });

    it('keeps passive Calendar reads usable outside an owned facade', async () => {
        const f = fixture(); await f.boot();
        expect(await f.call('iosCalendarRead', { op: 'openSettings' })).toMatchObject({ ok: true });
        expect(f.privateCalls.some((call) => call.op === 'readState')).toBe(true);
        expect(f.privateCalls.every((call) => call.op !== 'write')).toBe(true);
        expect(f.state.fixture.subscriptions()).toBe(0); expect(f.sql).toEqual([]);
    });

    it('forces awaited closed diagnostics without content and cannot change settlement when the sink fails', async () => {
        const f = fixture(); await f.boot();
        for (const operation of ['createCalendar', 'updateCalendar', 'deleteCalendar', 'createEvent', 'updateEvent', 'deleteEvent', 'restore']) {
            expect(await f.call('iosCalendarPushDiagnostic', { operation, outcome: 'saved' })).toEqual({ ok: true, value: null });
        }
        const entries = f.logText().trim().split('\n').map((line) => JSON.parse(line));
        expect(entries).toHaveLength(7);
        expect(entries[0]).toMatchObject({ message: 'Native iOS calendar push outcome', context: {
            releaseCheck: 'v1.3.5/ios-calendar-push', operation: 'createCalendar', outcome: 'saved' } });
        expect(f.logText()).not.toContain('PRIVATE'); expect(f.sql).toEqual([]); expect(f.privateCalls).toEqual([]);
        for (const input of [{ operation: 'read', outcome: 'saved' }, { operation: 'createEvent', outcome: 'PRIVATE' },
            { operation: 'createEvent', outcome: 'saved', taskId: 'PRIVATE' }, { operation: ['createEvent'], outcome: 'saved' }]) {
            expect(await f.call('iosCalendarPushDiagnostic', input)).toMatchObject({ ok: false, error: expect.stringContaining('INVALID_INPUT') });
        }
        f.failLog(); expect(await f.call('iosCalendarPushDiagnostic', { operation: 'restore', outcome: 'blocked' })).toEqual({ ok: true, value: null });
    });
});
