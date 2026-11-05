import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { build } from 'esbuild';
import type { AppData, AppSettings, Project, Task } from '../../../packages/core/src/types';
import type { NativePomodoroSession } from '../../../packages/core/src/native-pomodoro-session';

const now = Date.parse('2026-10-30T12:00:00.000Z');
const at = '2026-10-30T00:00:00.000Z';
const task = (id: string, extra: Partial<Task> = {}): Task => ({
    id, title: `PRIVATE ${id}`, status: 'next', contexts: [], tags: [], createdAt: at, updatedAt: at, ...extra,
});
const project = (id: string, extra: Partial<Project> = {}): Project => ({
    id, title: id, status: 'active', color: '#123456', order: 0, tagIds: [], createdAt: at, updatedAt: at, ...extra,
});
const data = (tasks: Task[] = [], settings: AppSettings = {}, projects: Project[] = []): AppData => ({
    tasks, settings, projects, sections: [], areas: [],
});
const session = (extra: Partial<NativePomodoroSession['session']> = {}): NativePomodoroSession => ({
    version: 1, sessionID: '11111111-1111-4111-8111-111111111111', generation: 0,
    session: { durations: { focusMinutes: 25, breakMinutes: 5 },
        timerState: { phase: 'focus', remainingSeconds: 1500, isRunning: false, completedFocusSessions: 0 },
        sessionHistory: { totalCompletedFocusSessions: 0, completedFocusSessionsByTaskId: {},
            todayDayKey: '2026-10-30', completedTodayFocusSessions: 0 }, updatedAtMs: now, ...extra },
});
let source = '';
const fixtures: ReturnType<typeof fixture>[] = [];

beforeAll(async () => {
    const built = await build({ stdin: { contents: `
        import './host-entry';
        import { useTaskStore, getStorageAdapter, setStorageAdapter, getPersistenceStatus, flushPendingSave, resetForTests } from '../../../packages/core/src/store';
        import { acquireWorkspaceTransitionLock, initializeSandboxRuntime } from '../../../packages/core/src/sandbox';
        import { createWidgetPayloadProjection } from '../../../packages/core/src/widget-payload';
        import { getFocusWidgetFilter, setFocusWidgetFilter } from '../../../packages/core/src/focus-widget-filter';
        const canonical = () => { const s = useTaskStore.getState(); return {
            tasks: s._allTasks, projects: s._allProjects, sections: s._allSections, areas: s._allAreas, settings: s.settings }; };
        globalThis.fixture = { state: useTaskStore.getState, set: useTaskStore.setState,
            focusFilter: setFocusWidgetFilter, currentFocusFilter: getFocusWidgetFilter,
            canonical, shared: () => createWidgetPayloadProjection(canonical(), 'en', { focusFilter: getFocusWidgetFilter() }).build(20),
            adapter: getStorageAdapter, replaceAdapter: setStorageAdapter, persistence: getPersistenceStatus,
            flush: flushPendingSave, reset: resetForTests,
            sandbox: () => initializeSandboxRuntime(true), transition: acquireWorkspaceTransitionLock,
            install: d => { useTaskStore.setState({ _allTasks: d.tasks, _allProjects: d.projects,
                _allSections: d.sections, _allAreas: d.areas, settings: d.settings });
                useTaskStore.getState().tasks = d.tasks.slice(0, 1); },
        };
    `, resolveDir: import.meta.dir, loader: 'ts' }, bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent' });
    source = built.outputFiles[0].text;
});

afterEach(async () => {
    for (const f of fixtures.splice(0)) {
        await f.state.fixture.flush(); f.state.fixture.reset(); f.external.close(); f.database.close(); rmSync(f.directory, { recursive: true });
    }
});

const fixture = () => {
    const tmp = join(import.meta.dir, '../../../.orchestrator/tasks/ios-native-watch-20261030/tmp');
    mkdirSync(tmp, { recursive: true });
    const directory = mkdtempSync(join(tmp, 'host-watch-'));
    const path = join(directory, 'library.sqlite');
    const database = new Database(path), external = new Database(path);
    const writes: string[] = [];
    const kv = new Map<string, string>();
    let logText = '', failLog = false, onRead: ((sql: string) => void) | undefined;
    const state = vm.createContext({
        AbortController, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout, clockNow: now,
        __mindwtrHostPlatform: 'ios', console: { info() {}, warn() {}, error() {}, log() {} },
        __mindwtrNative: {
            sqlExec: (sql: string) => { writes.push('sqlExec'); database.exec(sql); return null; },
            sqlRun: (sql: string, params: string) => { writes.push('sqlRun'); database.query(sql).run(...JSON.parse(params)); return null; },
            sqlAll: (sql: string, params: string) => {
                const rows = database.query(sql).all(...JSON.parse(params)); onRead?.(sql); return JSON.stringify(rows);
            },
            nowMs: () => now, randomBytes: (count: number) => JSON.stringify(Array(count).fill(7)), log: () => {},
            logFile: (operation: string, text: string) => {
                if (failLog) throw new Error('private diagnostic failure');
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
            kvSet: (name: string, value: string) => { writes.push('kvSet'); kv.set(name, value); return null; },
            kvRemove: (name: string) => { writes.push('kvRemove'); kv.delete(name); return null; },
            fileList: () => 'null', fileRead: () => '', fileDelete: () => { writes.push('fileDelete'); return null; },
        },
    });
    vm.runInContext(`const NativeDate = Date; Date = class extends NativeDate {
        constructor(...args) { if (args.length) super(...args); else super(clockNow); } static now() { return clockNow; }
    };`, state);
    vm.runInContext(source, state);
    const poll = async (ticket: string) => {
        for (let step = 0; step < 1000; step++) {
            const answer = state.MindwtrHost.poll(ticket);
            if (answer !== null) return JSON.parse(answer);
            await new Promise((done) => setTimeout(done, 0));
        }
        throw new Error('Host operation did not settle');
    };
    const boot = async (seed = data(), timer?: NativePomodoroSession) => {
        expect(await poll(state.MindwtrHost.boot('', ''))).toMatchObject({ ok: true });
        state.fixture.install(seed); await state.fixture.adapter().saveData(seed);
        if (timer) database.query('INSERT INTO native_pomodoro_session (id, state_json) VALUES (1, ?)').run(JSON.stringify(timer));
        writes.length = 0; logText = '';
    };
    const durable = () => database.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all().map(({ name }) => [name, database.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]);
    const f = { state, database, external, directory, writes, poll, boot, durable, kv,
        snapshot: (...args: unknown[]) => poll(state.MindwtrHost.iosWatchSnapshot(...args)),
        intercept: (hook: (sql: string) => void) => { onRead = hook; },
        failLog: () => { failLog = true; }, logText: () => logText };
    fixtures.push(f); return f;
};

const readonly = async (f: ReturnType<typeof fixture>, saved: unknown, before: AppData) => {
    await f.state.fixture.flush();
    expect(f.durable()).toEqual(saved); expect(f.writes).toEqual([]);
    const after: AppData = f.state.fixture.canonical();
    for (const field of ['tasks', 'projects', 'sections', 'areas', 'settings'] satisfies (keyof AppData)[])
        expect(after[field]).toBe(before[field]);
};

describe('actual iOS Watch snapshot bridge', () => {
    it('uses canonical curated Focus, device criteria/sort and details with the shared 20-row bound', async () => {
        const rows = Array.from({ length: 25 }, (_, i) => task(`t${i}`, { title: `${i}`.padStart(2, '0'), isFocusedToday: true,
            tags: ['keep'], description: 'PRIVATE Unicode 牛奶 🥛', checklist: [{ id: 'milk', title: 'Milk', isCompleted: true }] }));
        rows.push(task('drop-filter', { isFocusedToday: true }), task('plain-next'),
            task('gone', { isFocusedToday: true, deletedAt: at }),
            task('hidden-parent', { isFocusedToday: true, projectId: 'hidden' }));
        const f = fixture(); await f.boot(data(rows, {}, [project('hidden', { status: 'archived' })]));
        f.state.fixture.focusFilter({ criteria: { tags: ['keep'] }, sortBy: 'title', sortOrder: 'desc' });
        const saved = f.durable(), before = f.state.fixture.canonical();
        const expected = f.state.fixture.shared().sections.flatMap((section: { items: { id: string; title: string }[] }) => section.items)
            .map(({ id, title }: { id: string; title: string }) => {
                const row = rows.find((row) => row.id === id);
                return { id, title, createdAt: row?.createdAt, description: row?.description, checklist: row?.checklist };
            });
        const answer = await f.snapshot(); expect(answer.ok).toBe(true);
        expect(answer.value.focus).toEqual(expected); expect(answer.value.focus).toHaveLength(20);
        expect(answer.value.focus[0].id).toBe('t24');
        expect(Object.keys(answer.value)).toEqual(['protocolVersion', 'generatedAt', 'focus', 'pomodoro']);
        expect(answer.value.generatedAt).toBe('2026-10-30T12:00:00.000Z');
        await readonly(f, saved, before);
    });

    it.each(['missing', 'stopped', 'paused', 'running', 'expired'])('reads %s timer without initializing, advancing, crediting or writing receipts', async (mode) => {
        const timer = mode === 'missing' ? undefined : session({ selectedTaskId: 'linked',
            timerState: { phase: 'focus', isRunning: mode === 'running' || mode === 'expired',
                remainingSeconds: mode === 'stopped' ? 1500 : 123, completedFocusSessions: 0 },
            ...(mode === 'running' || mode === 'expired' ? { phaseEndsAt: new Date(now + (mode === 'running' ? 24_500 : -60_000)).toISOString() } : {}),
        });
        const f = fixture(); await f.boot(data([task('linked', { status: 'waiting' })], {
            gtd: { pomodoro: { linkTask: true, completionAlert: false, customDurations: { focusMinutes: 40, breakMinutes: 8 }, autoStartBreaks: true } },
        }), timer);
        const saved = f.durable(), before = f.state.fixture.canonical(), answer = await f.snapshot();
        expect(answer.ok).toBe(true);
        expect(answer.value.pomodoro).toEqual({ phase: 'focus', completionAlert: false,
            isRunning: mode === 'running' || mode === 'expired',
            remainingSeconds: mode === 'missing' ? 2400 : mode === 'stopped' ? 1500 : mode === 'running' ? 25 : mode === 'expired' ? 0 : 123,
            ...(timer?.session.phaseEndsAt ? { phaseEndTime: Date.parse(timer.session.phaseEndsAt) } : {}),
            ...(timer ? { taskId: 'linked', taskTitle: 'PRIVATE linked' } : {}),
        });
        expect(answer.value.focus).toEqual([]);
        await readonly(f, saved, before);
    });

    it.each(['done', 'archived', 'reference', 'cancelled', 'deleted', 'link-disabled'])('hides %s saved links while preserving the saved timer', async (mode) => {
        const linked = task('linked', mode === 'cancelled' ? { status: 'archived', cancelledAt: at }
            : mode === 'deleted' ? { deletedAt: at } : mode === 'link-disabled' ? {} : { status: mode });
        const f = fixture(); await f.boot(data([linked], { gtd: { pomodoro: { linkTask: mode !== 'link-disabled' } } }), session({ selectedTaskId: 'linked' }));
        const saved = f.durable(), before = f.state.fixture.canonical(), answer = await f.snapshot();
        expect(answer.ok).toBe(true); expect(answer.value.pomodoro).not.toHaveProperty('taskId');
        expect(answer.value.pomodoro).not.toHaveProperty('taskTitle'); await readonly(f, saved, before);
    });

    it.each(['boot', 'platform', 'sandbox', 'transition', 'adapter', 'loading', 'failed'])('refuses %s without a success marker', async (guard) => {
        const f = fixture(); if (guard !== 'boot') await f.boot();
        if (guard === 'platform') f.state.__mindwtrHostPlatform = 'android';
        if (guard === 'sandbox') f.state.fixture.sandbox();
        if (guard === 'transition') f.state.fixture.transition();
        if (guard === 'adapter') f.state.fixture.replaceAdapter({});
        if (guard === 'loading') f.state.fixture.set({ isLoading: true });
        if (guard === 'failed') f.state.fixture.set({ persistenceFailure: { message: 'PRIVATE failure' } });
        expect((await f.snapshot()).ok).toBe(false); expect(f.writes).toEqual([]); expect(f.logText()).toBe('');
    });

    it('holds an owed save without flushing it', async () => {
        const f = fixture(); await f.boot(); await f.state.fixture.state().addTask('PRIVATE unsaved');
        expect(f.state.fixture.persistence().queued).toBeGreaterThan(0);
        expect((await f.snapshot()).ok).toBe(false); expect(f.writes).toEqual([]); expect(f.logText()).toBe('');
        expect(f.state.fixture.persistence().queued).toBeGreaterThan(0);
    });

    it.each(['tasks', 'timer'])('refuses an actual concurrent SQLite %s update across the saved timer read', async (target) => {
        const f = fixture(); await f.boot(data([task('linked', { isFocusedToday: true })]), session());
        let changed = false;
        f.intercept((sql) => {
            if (!changed && sql === 'SELECT id, state_json FROM native_pomodoro_session') {
                changed = true;
                if (target === 'tasks') f.external.query('UPDATE tasks SET title = ?, rev = 99 WHERE id = ?').run('PRIVATE changed', 'linked');
                else f.external.query('UPDATE native_pomodoro_session SET state_json = ? WHERE id = 1').run(JSON.stringify(session({
                    timerState: { phase: 'break', remainingSeconds: 300, isRunning: false, completedFocusSessions: 0 },
                })));
            }
        });
        expect(await f.snapshot()).toMatchObject({ ok: false, error: expect.stringContaining('STALE_REVISION:') });
        expect(changed).toBe(true); expect(f.writes).toEqual([]); expect(f.logText()).toBe('');
    });

    it.each(['_allTasks', '_allProjects', '_allSections', '_allAreas', 'settings', 'adapter', 'filter'])('refuses %s replacement during the asynchronous read', async (field) => {
        const f = fixture(); await f.boot(data([task('focus', { isFocusedToday: true })]));
        let changed = false;
        f.intercept((sql) => {
            if (!changed && sql === 'SELECT id, state_json FROM native_pomodoro_session') {
                changed = true;
                if (field === 'adapter') f.state.fixture.replaceAdapter({});
                else if (field === 'filter') f.state.fixture.focusFilter({ criteria: { tags: ['other'] }, sortBy: 'default' });
                else f.state.fixture.set({ [field]: field === 'settings' ? {} : f.state.fixture.state()[field].slice() });
            }
        });
        expect((await f.snapshot()).ok).toBe(false); expect(f.writes).toEqual([]); expect(f.logText()).toBe('');
    });

    it('rejects extra arguments and malformed saved timer state', async () => {
        const f = fixture(); await f.boot();
        expect(await f.snapshot({ focus: [] })).toEqual({ ok: false, error: 'INVALID_INPUT: Watch snapshot takes no arguments' });
        f.database.query('INSERT INTO native_pomodoro_session (id, state_json) VALUES (1, ?)').run('{}');
        expect((await f.snapshot()).ok).toBe(false); expect(f.writes).toEqual([]); expect(f.logText()).toBe('');
    });

    it('logs only fixed successful read fields and tolerates diagnostics failure', async () => {
        const f = fixture(); await f.boot(data([task('PRIVATE-id', { isFocusedToday: true })]));
        expect((await f.snapshot()).ok).toBe(true);
        expect(f.logText().trim().split('\n').map((line) => JSON.parse(line))).toEqual([
            { ts: expect.any(String), level: 'info', scope: 'native-ios', message: 'Native iOS Watch snapshot read',
                context: { releaseCheck: 'v1.3.8/ios-watch-snapshot', operation: 'read', outcome: 'ready' } },
        ]);
        expect(f.logText()).not.toContain('PRIVATE'); f.failLog(); expect((await f.snapshot()).ok).toBe(true); expect(f.writes).toEqual([]);
    });
});

const captureId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const watchEntry = (n: number, fields: Record<string, unknown>) => ({ name: `${captureId(n)}.json`,
    body: JSON.stringify({ protocolVersion: 1, id: captureId(n), source: 'apple-watch', createdAt: at, ...fields }) });
const watchBatch = (entries: ReturnType<typeof watchEntry>[]) => JSON.stringify({ version: 1, requestId: captureId(999), entries });

describe('actual iOS immutable Watch intake batch', () => {
    it('saves text, complete, defer and checklist through shared policy without retiring physical files', async () => {
        const f = fixture();
        await f.boot(data([task('complete'), task('defer'), task('list', { checklist: [{ id: 'milk', title: 'Milk', isCompleted: false }] })]));
        const entries = [watchEntry(1, { kind: 'text', title: 'Synthetic capture' }),
            watchEntry(2, { kind: 'complete', taskId: 'complete' }),
            watchEntry(3, { kind: 'defer', taskId: 'defer', startDate: '2026-11-02' }),
            watchEntry(4, { kind: 'checklist', taskId: 'list', taskCreatedAt: at, itemId: 'milk', itemTitle: 'Milk', isCompleted: true })];
        const answer = await f.poll(f.state.MindwtrHost.iosWatchIngest(watchBatch(entries)));
        expect(answer).toMatchObject({ ok: true, value: { version: 1, ingested: 4 } });
        expect(answer.value.completed).toHaveLength(4);
        expect(await f.poll(f.state.MindwtrHost.iosWatchIngestOutcome(watchBatch(entries))))
            .toEqual({ ok: true, value: answer.value });
        expect(answer.value.completed.find((x: { name: string }) => x.name === entries[3].name).checklistOutcome).toBe('applied');
        const tasks: Task[] = f.state.fixture.state()._allTasks;
        expect(tasks.find(t => t.id === captureId(1))?.status).toBe('inbox');
        expect(tasks.find(t => t.id === 'complete')?.status).toBe('done');
        expect(tasks.find(t => t.id === 'defer')?.startTime).toBe('2026-11-02');
        expect(tasks.find(t => t.id === 'list')?.checklist?.[0].isCompleted).toBe(true);
        expect(f.writes).not.toContain('fileDelete');
        expect(f.database.query('SELECT count(*) AS count FROM native_request_receipts').get()).toMatchObject({ count: 4 });
        const later = JSON.parse(JSON.stringify(tasks)) as Task[];
        later.find(t => t.id === 'complete')!.status = 'next';
        later.find(t => t.id === 'list')!.checklist![0].isCompleted = false;
        const afterPurge = data(later.filter(t => t.id !== captureId(1)));
        f.state.fixture.install(afterPurge); await f.state.fixture.adapter().saveData(afterPurge);
        f.state.fixture.reset(); vm.runInContext(source, f.state);
        expect(await f.poll(f.state.MindwtrHost.boot('', ''))).toMatchObject({ ok: true });
        const before = JSON.stringify(f.state.fixture.state()._allTasks);
        expect(await f.poll(f.state.MindwtrHost.iosWatchIngest(watchBatch(entries)))).toMatchObject({ ok: true, value: { ingested: 4 } });
        expect(JSON.stringify(f.state.fixture.state()._allTasks)).toBe(before);
        f.database.query('DELETE FROM native_request_receipts WHERE request_id=?').run(captureId(1));
        expect(await f.poll(f.state.MindwtrHost.iosWatchIngestOutcome(watchBatch(entries))))
            .toEqual({ ok: true, value: null });
        expect(JSON.stringify(f.state.fixture.state()._allTasks)).toBe(before);
    });

    it('does not return retirement authority when ordering persistence fails, then replays the frozen batch', async () => {
        const f = fixture(); await f.boot(data([task('complete')]));
        const raw = watchBatch([watchEntry(1, { kind: 'complete', taskId: 'complete' })]);
        const write = f.state.__mindwtrNative.kvSet;
        f.state.__mindwtrNative.kvSet = () => { throw new Error('record unavailable'); };
        expect(await f.poll(f.state.MindwtrHost.iosWatchIngest(raw))).toMatchObject({ ok: false, error: expect.stringContaining('SAVE_FAILED:') });
        expect(f.writes).not.toContain('fileDelete');
        f.state.__mindwtrNative.kvSet = write;
        expect(await f.poll(f.state.MindwtrHost.iosWatchIngest(raw))).toMatchObject({ ok: true, value: { ingested: 1 } });
        expect([...f.kv.values()].join('')).toContain(captureId(1));
    });

    it('validates the entire batch before mutating and refuses unsupported, duplicate or mismatched entries', async () => {
        const f = fixture(); await f.boot();
        const valid = watchEntry(1, { kind: 'text', title: 'Synthetic capture' });
        const cases = [[valid, watchEntry(2, { kind: 'audio', audioPath: '/private/file.wav' })],
            [valid, valid], [{ ...valid, name: '../escape.json' }],
            [watchEntry(2, { kind: 'pomodoro', action: 'start' })]];
        for (const entries of cases) {
            expect(await f.poll(f.state.MindwtrHost.iosWatchIngest(watchBatch(entries)))).toMatchObject({ ok: false, error: expect.stringContaining('INVALID_INPUT:') });
        }
        expect(f.state.fixture.state()._allTasks).toEqual([]);
        expect(f.writes).toEqual([]);
    });
});


describe('actual iOS Watch Pomodoro preparation', () => {
    it('initializes from saved settings, links actionable tasks and proves cold source replay without undoing later state', async () => {
        const f = fixture();
        await f.boot(data([task('linked')], { gtd: { pomodoro: { linkTask: true, customDurations: { focusMinutes: 40, breakMinutes: 8 } } } } as AppSettings));
        f.state.fixture.reset(); vm.runInContext(source, f.state);
        expect(await f.poll(f.state.MindwtrHost.boot('', ''))).toMatchObject({ ok: true });
        const body = watchEntry(51, { kind: 'pomodoro', action: 'start', taskId: 'linked' }).body;
        const prepared = await f.poll(f.state.MindwtrHost.iosWatchPomodoroPrepare(body));
        expect(prepared).toMatchObject({ ok: true });
        const original = prepared.value.planJSON, plan = JSON.parse(original);
        expect(plan.request.action).toBe('watch'); expect(plan.request.sourceJSON).toBe(body);
        expect(plan.request.selectedTaskId).toBe('linked'); expect(plan.request.durations.focusMinutes).toBe(40);
        expect(await f.poll(f.state.MindwtrHost.pomodoroTransitionCommit(original, false))).toMatchObject({ ok: true });
        const changed = JSON.parse(plan.sessionAfter);
        changed.session.timerState.isRunning = false; delete changed.session.phaseEndsAt;
        changed.session.selectedTaskId = 'later-phone-selection'; changed.session.updatedAtMs = now + 20_000; changed.generation++;
        f.database.query('UPDATE native_pomodoro_session SET state_json=?').run(JSON.stringify(changed));
        await f.state.fixture.flush(); f.state.fixture.reset(); vm.runInContext(source, f.state);
        expect(await f.poll(f.state.MindwtrHost.boot('', ''))).toMatchObject({ ok: true });
        const replay = await f.poll(f.state.MindwtrHost.iosWatchPomodoroPrepare(body));
        expect(replay.ok).toBe(true); expect(replay.value.planJSON).toBe(original);
        expect(await f.poll(f.state.MindwtrHost.pomodoroTransitionCommit(original, true))).toMatchObject({ ok: true, value: { replayed: true } });
        expect(JSON.parse((f.database.query('SELECT state_json FROM native_pomodoro_session').get() as { state_json: string }).state_json)).toEqual(changed);
        const collision = JSON.stringify({ ...JSON.parse(body), action: 'reset' });
        expect(await f.poll(f.state.MindwtrHost.iosWatchPomodoroPrepare(collision))).toMatchObject({ ok: false });
    });

    it.each(['disabled', 'missing', 'done', 'reference', 'cancelled'])('does not link %s task choices', async mode => {
        const f = fixture();
        const row = task('chosen', mode === 'done' ? { status: 'done' } : mode === 'reference' ? { status: 'reference' }
            : mode === 'cancelled' ? { status: 'archived', cancelledAt: at } : {});
        await f.boot(data(mode === 'missing' ? [] : [row], { gtd: { pomodoro: { linkTask: mode !== 'disabled' } } } as AppSettings));
        f.state.fixture.reset(); vm.runInContext(source, f.state);
        expect(await f.poll(f.state.MindwtrHost.boot('', ''))).toMatchObject({ ok: true });
        const body = watchEntry(52, { kind: 'pomodoro', action: 'start', taskId: 'chosen' }).body;
        const prepared = await f.poll(f.state.MindwtrHost.iosWatchPomodoroPrepare(body));
        expect(prepared).toMatchObject({ ok: true }); expect(JSON.parse(prepared.value.planJSON).request.selectedTaskId).toBeNull();
    });
});


describe('actual owned iOS Watch audio bridge', () => {
    it('uses original source receipts and skips transcription after cold task purge', async () => {
        const f = fixture(); await f.boot();
        const id = 'abcdef11-2222-4222-8222-222222222222';
        const body = JSON.stringify({ protocolVersion: 1, id, source: 'apple-watch', kind: 'audio',
            createdAt: '2026-10-30T12:00:00.000Z', audioPath: `file:///old/Documents/watch-audio/${id}.wav` });
        const raw = (transcript: string | null) => JSON.stringify({ version: 1, requestId: id, name: `${id}.json`, body, transcript });
        expect(await f.poll(f.state.MindwtrHost.iosWatchAudioOutcome(body))).toEqual({ ok: true, value: null });
        expect(await f.poll(f.state.MindwtrHost.iosWatchAudioNeedsTranscript(body))).toEqual({ ok: true, value: true });
        expect((await f.poll(f.state.MindwtrHost.iosWatchAudioIngest(raw(null)))).ok).toBe(false);
        expect(await f.poll(f.state.MindwtrHost.iosWatchAudioIngest(raw('Buy milk /next'))))
            .toMatchObject({ ok: true, value: { ingested: 1, completed: [{ name: `${id}.json` }] } });
        expect(f.state.fixture.canonical().tasks).toMatchObject([{ id, title: 'Buy milk', status: 'next' }]);
        const receipt = f.database.query('SELECT * FROM native_request_receipts WHERE request_id=?').get(id);
        f.database.query('DELETE FROM tasks WHERE id=?').run(id);
        vm.runInContext(source, f.state);
        expect(await f.poll(f.state.MindwtrHost.boot('', ''))).toMatchObject({ ok: true });
        expect(await f.poll(f.state.MindwtrHost.iosWatchAudioOutcome(body))).toMatchObject({ ok: true, value: { ingested: 1 } });
        expect(await f.poll(f.state.MindwtrHost.iosWatchAudioIngest(raw(null)))).toMatchObject({ ok: true, value: { ingested: 1 } });
        expect(f.database.query('SELECT id FROM tasks WHERE id=?').get(id)).toBeNull();
        expect(f.database.query('SELECT * FROM native_request_receipts WHERE request_id=?').get(id)).toEqual(receipt);
    });
});
