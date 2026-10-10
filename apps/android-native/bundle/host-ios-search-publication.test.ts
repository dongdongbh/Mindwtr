import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import vm from 'node:vm';
import { build } from 'esbuild';
import type { AppData, Task } from '../../../packages/core/src/types';

let source: string;
const fixtures: ReturnType<typeof fixture>[] = [];
const at = '2026-10-09T00:00:00.000Z';
const task = (id: string, extra: Partial<Task> = {}): Task => ({
    id, title: `PRIVATE ${id}`, status: 'inbox', contexts: [], tags: [], createdAt: at, updatedAt: at, ...extra,
});
const data = (tasks: Task[] = []): AppData => ({ tasks, projects: [], sections: [], areas: [], settings: {} });

beforeAll(async () => {
    const built = await build({ stdin: { contents: `
        import './host-entry';
        import { useTaskStore, getStorageAdapter, setStorageAdapter, getPersistenceStatus, flushPendingSave, resetForTests } from '../../../packages/core/src/store';
        import { acquireWorkspaceTransitionLock, initializeSandboxRuntime } from '../../../packages/core/src/sandbox';
        import { getNextFutureStartRevealAt } from '../../../packages/core/src/task-utils';
        globalThis.fixture = { state: useTaskStore.getState, set: useTaskStore.setState,
            adapter: getStorageAdapter, replaceAdapter: setStorageAdapter, persistence: getPersistenceStatus,
            flush: flushPendingSave, reset: resetForTests, reveal: tasks => getNextFutureStartRevealAt(tasks),
            sandbox: () => initializeSandboxRuntime(true), transition: acquireWorkspaceTransitionLock,
            install: d => { useTaskStore.setState({ _allTasks: d.tasks, _allProjects: d.projects,
                _allSections: d.sections, _allAreas: d.areas, settings: d.settings });
                useTaskStore.getState().tasks = d.tasks.slice(0, 1); },
        };
    `, resolveDir: import.meta.dir, loader: 'ts' }, bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent' });
    source = built.outputFiles[0].text;
});

afterEach(async () => {
    for (const f of fixtures.splice(0)) { await f.state.fixture.flush(); f.state.fixture.reset(); f.database.close(); }
});

const fixture = () => {
    const database = new Database(':memory:'), writes: string[] = [];
    let clock = new Date(2026, 9, 9, 10).getTime(), zone = 'fixture-zone', offset = new Date(clock).getTimezoneOffset();
    class Clock extends Date {
        constructor(...args: any[]) { super(...(args.length ? args : [clock]) as [any]); }
        static now() { return clock; }
        getTimezoneOffset() { return offset; }
    }
    const state: Record<string, any> = {
        AbortController, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout, Date: Clock,
        Intl: { ...Intl, Collator: Intl.Collator, DateTimeFormat: class extends Intl.DateTimeFormat {
            resolvedOptions() { return { ...super.resolvedOptions(), timeZone: zone }; }
        } },
        __mindwtrHostPlatform: 'ios', console: { info() {}, warn() {}, error() {}, log() {} },
        __mindwtrNative: {
            sqlExec: (sql: string) => { writes.push('sqlExec'); database.exec(sql); return null; },
            sqlRun: (sql: string, params: string) => { writes.push('sqlRun'); database.query(sql).run(...JSON.parse(params)); return null; },
            sqlAll: (sql: string, params: string) => JSON.stringify(database.query(sql).all(...JSON.parse(params))),
            nowMs: () => clock, randomBytes: (count: number) => JSON.stringify(Array(count).fill(7)), log() {},
            logFile: (operation: string) => operation === 'size' ? '0' : operation === 'isAbsent' ? '1' : '',
            rnStateCommit: () => { writes.push('rnStateCommit'); return null; }, kvGet: () => '[null]',
            kvSet: () => { writes.push('kvSet'); return null; }, kvRemove: () => { writes.push('kvRemove'); return null; },
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
    const f = { state, database, writes, poll, now: () => clock,
        time: (time: number) => { clock = time; }, zone: (value: string, minutes = offset) => { zone = value; offset = minutes; },
        boot: async (seed = data()) => {
            expect(await poll(state.MindwtrHost.boot('', ''))).toMatchObject({ ok: true });
            state.fixture.install(seed); writes.length = 0;
        },
        observe: (...args: unknown[]) => JSON.parse(state.MindwtrHost.iosSearchObservation(...args)),
        open: (...args: unknown[]) => poll(state.MindwtrHost.iosSearchOpen(...args)),
    };
    fixtures.push(f); return f;
};

describe('actual iOS search publication bridge', () => {
    it('returns closed immediate observations without projecting task titles or scanning unchanged starts', async () => {
        const f = fixture(), row = task('one'); await f.boot(data([row]));
        let reads = 0;
        Object.defineProperty(row, 'startTime', { get() { reads++; return undefined; } });
        Object.defineProperty(row, 'title', { get() { throw new Error('Observation must not project private text'); } });
        const first = f.observe(), readCount = reads;
        expect(first).toEqual({ ready: true, revision: expect.any(Number), nextAt: new Date(2026, 9, 10).getTime() });
        expect(readCount).toBeGreaterThan(0);
        f.time(f.now() + 1_000);
        expect(f.observe()).toEqual(first); expect(reads).toBe(readCount); expect(f.writes).toEqual([]);
    });

    it.each(['_allTasks', '_allProjects', '_allSections', '_allAreas', 'settings'])('tracks changed full-store %s references', async (field) => {
        const f = fixture(); await f.boot(data([task('one')]));
        const before = f.observe();
        f.state.fixture.set({ [field]: field === 'settings' ? {} : f.state.fixture.state()[field].slice() });
        expect(f.observe()).toEqual({ ...before, revision: before.revision + 1 });
        expect(f.writes).toEqual([]);
    });

    it('uses full-store shared reveal time beyond both visible rows and snapshot list caps', async () => {
        const f = fixture(), deadline = f.now() + 60_000;
        const rows = Array.from({ length: 60 }, (_, i) => task(`a-${i}`, { status: 'next' }));
        rows.push(task('z-hidden', { status: 'next', startTime: new Date(deadline).toISOString() }));
        await f.boot({ ...data(rows), settings: { taskSortBy: 'title', gtd: { focusIncludeStartDates: false } } });
        expect(f.state.fixture.state().tasks).toHaveLength(1);
        const snapshot = await f.poll(f.state.MindwtrHost.iosSearchSnapshot());
        expect(snapshot.ok).toBe(true);
        expect(snapshot.value.items.some((row: Task) => row.id === 'z-hidden')).toBe(false);
        expect(f.observe().nextAt).toBe(f.state.fixture.reveal(rows));
        const before = f.observe(); f.time(deadline - 1); expect(f.observe()).toEqual(before);
        f.time(deadline); expect(f.observe()).toEqual({ ...before, revision: before.revision + 1, nextAt: new Date(2026, 9, 10).getTime() });
        expect(f.writes).toEqual([]);
    });

    it('invalidates for backward clock, local day and timezone even at the same offset', async () => {
        const f = fixture(); await f.boot();
        let before = f.observe(); f.time(f.now() - 1_000); expect(f.observe().revision).toBe(before.revision + 1);
        before = f.observe(); f.zone('another-zone'); expect(f.observe().revision).toBe(before.revision + 1);
        before = f.observe(); f.zone('another-zone', 999); expect(f.observe().revision).toBe(before.revision + 1);
        before = f.observe(); f.time(new Date(2026, 9, 10, 10).getTime());
        expect(f.observe()).toEqual({ ready: true, revision: before.revision + 1, nextAt: new Date(2026, 9, 11).getTime() });
        expect(f.writes).toEqual([]);
    });

    it.each(['boot', 'sandbox', 'transition', 'adapter', 'loading', 'load-error', 'failed'])('fails closed for %s for observation and exact open', async (guard) => {
        const f = fixture(); if (guard !== 'boot') await f.boot(data([task('one')]));
        if (guard === 'sandbox') f.state.fixture.sandbox();
        if (guard === 'transition') f.state.fixture.transition();
        if (guard === 'adapter') f.state.fixture.replaceAdapter({});
        if (guard === 'loading') f.state.fixture.set({ isLoading: true });
        if (guard === 'load-error') f.state.fixture.set({ error: 'Failed to fetch data: private failure' });
        if (guard === 'failed') f.state.fixture.set({ persistenceFailure: { message: 'private failure' } });
        expect(f.observe()).toEqual({ ready: false, revision: expect.any(Number), nextAt: null });
        expect(await f.open('one')).toMatchObject({ ok: false, error: expect.stringMatching(/^(NOT_READY|SAVE_FAILED):/) });
        expect(f.writes).toEqual([]);
    });

    it('tracks failed readiness and recovery without a changed data reference', async () => {
        const f = fixture(); await f.boot(); const first = f.observe();
        f.state.fixture.set({ persistenceFailure: { message: 'private failure' } });
        expect(f.observe()).toEqual({ ready: false, revision: first.revision + 1, nextAt: null });
        f.state.fixture.set({ persistenceFailure: null });
        expect(f.observe()).toEqual({ ...first, revision: first.revision + 2 }); expect(f.writes).toEqual([]);
    });

    it.each(['queued', 'inFlight', 'immediate', 'retrying'])('refuses %s saves without completing them', async (kind) => {
        const f = fixture(); await f.boot({ ...data([task('one')]), settings: { deviceId: 'search-fixture' } });
        const adapter = f.state.fixture.adapter(), save = adapter.saveData.bind(adapter), schema = adapter.ensureSchema.bind(adapter);
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        adapter.saveData = async (d: AppData) => { await held; return save(d); };
        if (kind === 'immediate') adapter.ensureSchema = async () => { await held; return schema(); };
        let saving: Promise<unknown> | undefined;
        if (kind === 'immediate') saving = f.state.fixture.state().updateTask('one', { title: 'changed' });
        else {
            await f.state.fixture.state().addTask('private task');
            if (kind === 'inFlight') saving = f.state.fixture.flush();
            if (kind === 'retrying') saving = f.state.fixture.state().retryPersistence();
        }
        try {
            expect(f.state.fixture.persistence()[kind]).toBeTruthy();
            expect(f.observe().ready).toBe(false); expect(f.observe().nextAt).toBeNull();
            expect(await f.open('one')).toMatchObject({ ok: false, error: expect.stringContaining('NOT_READY:') });
            expect(f.state.fixture.persistence()[kind]).toBeTruthy(); expect(f.writes).toEqual([]);
        } finally { release(); await saving; await f.state.fixture.flush(); }
        f.writes.length = 0; expect(f.observe().ready).toBe(true); expect(await f.open('one')).toEqual({ ok: true, value: { type: 'task', taskId: 'one' } });
        expect(f.writes).toEqual([]);
    });

    it('opens exact Unicode, whitespace and case identities; foreign, deleted and missing identities reach Inbox', async () => {
        const ids = ['é', 'e\u0301', 'ID', 'id', ' opaque /漢+😀 ', ' ', '😀'.repeat(250)];
        const f = fixture(); await f.boot(data([...ids.map((id) => task(id)), task('deleted', { deletedAt: at })]));
        const before = f.state.fixture.state();
        for (const id of ids) expect(await f.open(id)).toEqual({ ok: true, value: { type: 'task', taskId: id } });
        for (const id of ['foreign-library', 'deleted', 'missing', 'opaque /漢+😀']) expect(await f.open(id)).toEqual({ ok: true, value: { type: 'inbox' } });
        await f.state.fixture.flush();
        const after = f.state.fixture.state();
        for (const field of ['_allTasks', '_allProjects', '_allSections', '_allAreas', 'settings']) expect(after[field]).toBe(before[field]);
        expect(f.writes).toEqual([]);
    });

    it.each([[], [undefined], [null], [1], [{}], [[]], [''], ['😀'.repeat(250) + 'x'], ['one', 'extra']].map((args) => ({ args })))('rejects closed open arguments %#', async ({ args }) => {
        const f = fixture(); await f.boot(data([task('one')]));
        expect(await f.open(...args)).toMatchObject({ ok: false, error: expect.stringContaining('INVALID_INPUT:') });
        expect(f.writes).toEqual([]);
    });

    it('rejects extra observation arguments and Android for both methods', async () => {
        const f = fixture(); await f.boot();
        expect(() => f.observe(undefined)).toThrow('INVALID_INPUT:');
        f.state.__mindwtrHostPlatform = 'android';
        expect(() => f.observe()).toThrow('NOT_READY:');
        expect(await f.open('one')).toMatchObject({ ok: false, error: expect.stringContaining('NOT_READY:') });
        expect(f.writes).toEqual([]);
    });

    it('fails closed when the reveal scan changes source ownership', async () => {
        const f = fixture(), row = task('one'); await f.boot(data([row]));
        Object.defineProperty(row, 'startTime', { get() { f.state.fixture.set({ _allSections: [] }); return undefined; } });
        expect(f.observe()).toEqual({ ready: false, revision: expect.any(Number), nextAt: null });
        expect(f.writes).toEqual([]);
    });

    it('fails closed for an invalid clock and recovers on a fresh clock observation', async () => {
        const f = fixture(); await f.boot(); const first = f.observe();
        f.time(NaN); expect(f.observe()).toEqual({ ready: false, revision: first.revision + 1, nextAt: null });
        f.time(new Date(2026, 9, 9, 10).getTime());
        expect(f.observe()).toEqual({ ...first, revision: first.revision + 2 }); expect(f.writes).toEqual([]);
    });

    it('refuses an open if canonical adapter ownership changes during lookup', async () => {
        const f = fixture(); await f.boot(data([task('one')]));
        const map = f.state.fixture.state()._tasksById, get = map.get.bind(map);
        map.get = (id: string) => { f.state.fixture.replaceAdapter({}); return get(id); };
        expect(await f.open('one')).toMatchObject({ ok: false, error: expect.stringContaining('NOT_READY:') });
        expect(f.writes).toEqual([]);
    });
});
