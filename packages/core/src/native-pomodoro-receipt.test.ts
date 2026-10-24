import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeRequestReceipts, loadNativeRequestReceipts, NativeReceiptSqliteAdapter, pruneNativeRequestReceipts, resetNativeRequestReceipts } from './native-request-receipts';
import { decodeNativePomodoroSession, nativePomodoroReceiptPayload, prepareNativePomodoroTransition } from './native-pomodoro-session';
import { openScratchSqlite } from './screen-parity.replay';
import { SqliteAdapter, type SqliteClient } from './sqlite-adapter';
import { TASK_SQLITE_COLUMNS } from './task-sync-schema';
import { flushPendingSave, getStorageAdapter, setStorageAdapter, useTaskStore } from './store';
import { runSyncStoreSave } from './store-write-gate';
import * as logger from './logger';
import type { AppData } from './types';

const ID = '11111111-1111-4111-8111-111111111111';
const NEXT = '22222222-2222-4222-8222-222222222222';
const AT = '2026-10-10T00:00:00.000Z';
const now = Date.parse(AT);
const original: AppData = { tasks: [{ id: 'task', title: 'Private', status: 'next', contexts: [], tags: [], createdAt: AT,
    updatedAt: AT, rev: 1, timeSpentMinutes: 4 }], projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'device' } };
const resources: { close: () => void; directory: string }[] = [];
const root = fileURLToPath(new URL('../../../.orchestrator/tmp/', import.meta.url));
const oldAdapter = getStorageAdapter();
const oldStore = useTaskStore.getState();
const gate = () => {
    let release!: () => void; let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    return { release, waiting, hold: async () => { entered(); await held; } };
};
async function open() {
    mkdirSync(root, { recursive: true }); const directory = mkdtempSync(join(root, 'pomodoro-receipt-'));
    const sql = openScratchSqlite(join(directory, 'library.sqlite')); resources.push({ close: sql.close, directory });
    await new SqliteAdapter(sql.client).saveData(structuredClone(original));
    resetNativeRequestReceipts(); await loadNativeRequestReceipts(sql.client, { durableCommands: ['pomodoroTransition', 'backupDocument'] });
    const events: string[] = [];
    const hooks: { run?: (statement: string) => Promise<void>; all?: (statement: string) => Promise<void>; afterRun?: (statement: string) => Promise<void> } = {};
    const client: SqliteClient = { ...sql.client,
        run: async (statement, params) => { events.push(statement); await hooks.run?.(statement); await sql.client.run(statement, params); await hooks.afterRun?.(statement); },
        all: async <T,>(statement: string, params?: unknown[]) => { events.push(statement); await hooks.all?.(statement); return sql.client.all<T>(statement, params); } };
    const adapter = new NativeReceiptSqliteAdapter(client, { rejectConcurrentWrites: true });
    await adapter.getData();
    setStorageAdapter(adapter);
    useTaskStore.setState({ ...oldStore, _allTasks: [], _tasksById: new Map(), tasks: [], settings: {}, persistenceFailure: null,
        editLockCount: 0, lastDataChangeAt: 0, error: null });
    await useTaskStore.getState().fetchData({ recoveryLoad: true, throwOnError: true });
    const initialize = prepareNativePomodoroTransition({ request: { action: 'initialize', requestId: ID, observedAtMs: now,
        localDayKey: '2026-10-10', durations: { focusMinutes: 25, breakMinutes: 5 } }, session: { raw: null, state: null }, target: null, deviceId: null })!;
    const running = decodeNativePomodoroSession(initialize.sessionAfter);
    running.session.timerState.isRunning = true; running.session.phaseEndsAt = AT; running.session.selectedTaskId = 'task';
    const raw = JSON.stringify(running);
    await sql.client.run('INSERT INTO native_pomodoro_session (id,state_json) VALUES (1,?)', [raw]);
    const row = (await sql.client.all<Record<string, string | number | null>>('SELECT * FROM tasks WHERE id=?', ['task']))[0];
    const plan = prepareNativePomodoroTransition({ request: { action: 'reconcile', requestId: NEXT, observedAtMs: now,
        localDayKey: '2026-10-10', autoStart: { autoStartFocus: false, autoStartBreaks: false } }, session: { raw, state: running },
        target: { id: 'task', row: TASK_SQLITE_COLUMNS.map((name) => row[name]) }, deviceId: 'device' })!;
    const state = async () => ({ tasks: await sql.client.all('SELECT * FROM tasks'), settings: await sql.client.all('SELECT * FROM settings'),
        sessions: await sql.client.all('SELECT * FROM native_pomodoro_session'), receipts: await sql.client.all('SELECT * FROM native_request_receipts') });
    events.length = 0;
    return { sql, client, adapter, plan, initialize, hooks, events, state };
}
async function openLegacy() {
    const env = await open();
    await env.sql.client.run('DELETE FROM native_pomodoro_session');
    const legacy = decodeNativePomodoroSession(env.plan.sessionBefore!).session;
    legacy.durations = { focusMinutes: 50, breakMinutes: 10 }; legacy.updatedAtMs = now - 1000;
    const sessionRaw = ` ${JSON.stringify(legacy)} `;
    const plan = prepareNativePomodoroTransition({ request: { action: 'adoptLegacy', requestId: NEXT, observedAtMs: now,
        localDayKey: '2026-10-10', autoStart: { autoStartFocus: false, autoStartBreaks: false },
        legacy: { version: 1, namespace: 'NativeUITests.fixture', sessionRaw, collapsedRaw: 'true' } },
        session: { raw: null, state: null }, target: env.plan.target, deviceId: 'device' })!;
    env.events.length = 0;
    return { ...env, plan };
}
afterEach(() => {
    vi.restoreAllMocks(); resetNativeRequestReceipts(); setStorageAdapter(oldAdapter); useTaskStore.setState(oldStore, true);
    for (const item of resources.splice(0).reverse()) { item.close(); rmSync(item.directory, { recursive: true, force: true }); }
});

describe('native Pomodoro integration with the SQLite and store write gates', () => {
    it('cold-loads and replays a committed schema4 receipt unchanged after policy and advance-reminder edits', async () => {
        const env = await open(); const legacy = structuredClone(env.plan);
        expect(TASK_SQLITE_COLUMNS).toHaveLength(48); expect(TASK_SQLITE_COLUMNS[46]).toBe('reminderPolicy');
        legacy.target!.row = legacy.target!.row!.slice(0, 46);
        const payload = JSON.stringify(['pomodoroTransition', legacy]);
        await env.sql.client.run('UPDATE tasks SET timeSpentMinutes=?,rev=?,revBy=?,updatedAt=?,reminderPolicy=?,dueReminderLeadMinutes=?,title=? WHERE id=?',
            [legacy.taskPatch!.timeSpentMinutes, legacy.taskPatch!.rev, legacy.taskPatch!.revBy, legacy.taskPatch!.updatedAt,
                'skip', 15, 'Later policy edit', 'task']);
        await env.sql.client.run('UPDATE native_pomodoro_session SET state_json=? WHERE id=1', [legacy.sessionAfter]);
        await env.sql.client.run('INSERT INTO native_request_receipts (request_id,method,reply,saved_at) VALUES (?,?,?,?)',
            [legacy.request.requestId, payload, JSON.stringify(legacy.result), AT]);
        resetNativeRequestReceipts(); const info = vi.spyOn(logger, 'logInfo');
        expect(await loadNativeRequestReceipts(env.sql.client, { durableCommands: ['pomodoroTransition'] })).toBe(1);
        expect(info).toHaveBeenCalledWith('Native Pomodoro legacy receipts accepted', { scope: 'storage', force: true,
            context: { releaseCheck: 'v1.3.7/native-pomodoro-legacy-receipt', count: 1, outcome: 'accepted' } });
        const cold = new NativeReceiptSqliteAdapter(env.client, { rejectConcurrentWrites: true }); setStorageAdapter(cold);
        const before = await env.state(); env.events.length = 0;
        expect(await cold.readPomodoroTransitionOutcome(legacy)).toEqual(legacy.result);
        expect(await cold.savePomodoroTransitionWithReceipt(legacy)).toEqual({ result: legacy.result, replayed: true, projectionReloaded: true });
        expect(await env.state()).toEqual(before);
        expect(env.events.some(statement => /^(UPDATE|INSERT|DELETE)/u.test(statement))).toBe(false);
        expect((before.receipts[0] as { method: string }).method).toBe(payload);
        expect(nativePomodoroReceiptPayload(legacy)).toBe(payload);
        expect(useTaskStore.getState()._tasksById.get('task')!.reminderPolicy).toBe('skip');
        expect(useTaskStore.getState()._tasksById.get('task')!.dueReminderLeadMinutes).toBe(15);
    });
    it('refuses a receiptless schema4 plan and a changed schema5 policy without domain SQL writes', async () => {
        const env = await open(); const legacy = structuredClone(env.plan); legacy.target!.row = legacy.target!.row!.slice(0, 46);
        const before = await env.state(); env.events.length = 0;
        await expect(env.adapter.savePomodoroTransitionWithReceipt(legacy)).rejects.toMatchObject({ code: 'staleBaseline' });
        expect(await env.state()).toEqual(before);
        expect(env.events.some(statement => /^(UPDATE|INSERT|DELETE)/u.test(statement))).toBe(false);
        await env.sql.client.run('UPDATE tasks SET reminderPolicy=? WHERE id=?', ['skip', 'task']);
        const changed = await env.state(); env.events.length = 0;
        await expect(env.adapter.savePomodoroTransitionWithReceipt(env.plan)).rejects.toMatchObject({ code: 'staleBaseline' });
        expect(await env.state()).toEqual(changed);
        expect(env.events.some(statement => /^(UPDATE|INSERT|DELETE)/u.test(statement))).toBe(false);
    });
    it('keeps a queued query outside its transaction and releases the SQL lock before canonical reload', async () => {
        const env = await open(); const held = gate();
        env.hooks.run = async statement => { if (statement.startsWith('UPDATE tasks')) await held.hold(); };
        const write = env.adapter.savePomodoroTransitionWithReceipt(env.plan); await held.waiting;
        const at = env.events.length; const query = env.adapter.queryTasks({});
        try {
            await new Promise(resolve => setTimeout(resolve, 0));
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(env.events.slice(at)).toEqual([]);
        } finally {
            held.release(); env.hooks.run = undefined;
            await expect(write).resolves.toMatchObject({ projectionReloaded: true });
            expect((await query)[0].timeSpentMinutes).toBe(29);
        }
        expect(useTaskStore.getState()._tasksById.get('task')!.timeSpentMinutes).toBe(29);
    });
    it('keeps sync save and publication outside the transaction and canonical reload', async () => {
        const env = await open(); const commit = gate(); const reload = gate(); let syncEntered = false;
        env.hooks.run = async statement => { if (statement === 'COMMIT') await commit.hold(); };
        env.hooks.all = async statement => {
            if (statement.includes('FROM tasks') && !statement.includes('WHERE id')) await reload.hold();
        };
        const write = env.adapter.savePomodoroTransitionWithReceipt(env.plan); await commit.waiting;
        const sync = runSyncStoreSave(async () => { syncEntered = true; });
        try {
            await new Promise(resolve => setTimeout(resolve, 0));
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(syncEntered).toBe(false);
            commit.release(); await reload.waiting;
            expect(syncEntered).toBe(false);
        } finally {
            commit.release(); reload.release(); env.hooks.run = undefined; env.hooks.all = undefined;
            await expect(write).resolves.toMatchObject({ projectionReloaded: true });
            await sync;
        }
        expect(syncEntered).toBe(true);
    });
    it('voids a pre-transition read token so a stale document cannot save after direct task credit', async () => {
        const env = await open(); const before = await env.adapter.getData({ rawTasks: true });
        const token = env.adapter.readTokenOf(before); expect(token).toBeTruthy();
        await expect(env.adapter.savePomodoroTransitionWithReceipt(env.plan)).resolves.toMatchObject({ projectionReloaded: true });
        const committed = await env.state();
        await expect(env.adapter.saveData(before, { token, onStale: () => new Error('stale-pre-pomodoro-token') }))
            .rejects.toThrow('stale-pre-pomodoro-token');
        expect(await env.state()).toEqual(committed);
    });
});

describe('legacy Pomodoro adoption through the unchanged atomic SQLite owner', () => {
    it.each(['scoped', 'all'] as const)('retains one establishment proof through %s expiry and refuses re-adoption after a lost session', async (scope) => {
        const marker = vi.spyOn(logger, 'logInfo');
        const env = await openLegacy();
        await env.adapter.savePomodoroTransitionWithReceipt(env.plan);
        const session = await env.adapter.readPomodoroSession();
        const row = (await env.sql.client.all<Record<string, string | number | null>>("SELECT * FROM tasks WHERE id='task'"))[0];
        const next = prepareNativePomodoroTransition({ request: { action: 'reset', requestId: ID, observedAtMs: now + 1,
            localDayKey: '2026-10-10', autoStart: { autoStartFocus: false, autoStartBreaks: false } }, session,
            target: { id: 'task', row: TASK_SQLITE_COLUMNS.map((name) => row[name]) }, deviceId: 'device' })!;
        await env.adapter.savePomodoroTransitionWithReceipt(next);
        await env.sql.client.run('UPDATE native_request_receipts SET saved_at=?', ['2026-01-01T00:00:00.000Z']);
        await env.sql.client.run('UPDATE native_request_receipts SET saved_at=? WHERE request_id=?', ['2026-01-02T00:00:00.000Z', ID]);
        await loadNativeRequestReceipts(env.sql.client, scope === 'scoped' ? { durableCommands: ['pomodoroTransition'] } : undefined);
        expect(await pruneNativeRequestReceipts(env.sql.client, new Date(AT))).toBe(1);
        expect(await env.sql.client.all('SELECT request_id FROM native_request_receipts')).toEqual([{ request_id: ID }]);
        await env.sql.client.run('DELETE FROM native_pomodoro_session');
        const before = await env.state();
        await expect(env.adapter.readPomodoroSession()).rejects.toThrow('Pomodoro session could not be read');
        const fresh = prepareNativePomodoroTransition({ request: { ...env.plan.request, requestId: '33333333-3333-4333-8333-333333333333' },
            session: { raw: null, state: null }, target: { id: 'task', row: TASK_SQLITE_COLUMNS.map((name) => row[name]) }, deviceId: 'device' })!;
        await expect(env.adapter.savePomodoroTransitionWithReceipt(fresh)).rejects.toThrow();
        expect(await env.state()).toEqual(before);
        expect(marker).toHaveBeenCalledWith('Native Pomodoro refused missing established session', { scope: 'storage', force: true,
            context: { releaseCheck: 'v1.3.5/ios-pomodoro-absence', outcome: 'refused' } });
    });
    it('atomically installs the native session, old-duration task credit and exact raw-source receipt', async () => {
        const env = await openLegacy(); const before = await env.state();
        expect(await env.adapter.savePomodoroTransitionWithReceipt(env.plan)).toEqual({ result: env.plan.result,
            replayed: false, projectionReloaded: true });
        const after = await env.state();
        expect((after.tasks[0] as Record<string, unknown>).timeSpentMinutes).toBe(54);
        expect(after.sessions).toEqual([{ id: 1, state_json: env.plan.sessionAfter }]); expect(after.receipts).toHaveLength(1);
        expect((after.receipts[0] as Record<string, unknown>).method).toBe(nativePomodoroReceiptPayload(env.plan));
        expect(after.settings).toEqual(before.settings);
        expect(useTaskStore.getState()._tasksById.get('task')!.timeSpentMinutes).toBe(54);
        expect(await env.adapter.readPomodoroSession()).toEqual({ raw: env.plan.sessionAfter, state: decodeNativePomodoroSession(env.plan.sessionAfter) });
        env.events.length = 0;
        expect((await env.adapter.savePomodoroTransitionWithReceipt(env.plan)).replayed).toBe(true);
        expect(await env.state()).toEqual(after); expect(env.events.some((sql) => /^(UPDATE|INSERT)/u.test(sql))).toBe(false);
    });
    it.each(['UPDATE tasks', 'INSERT INTO native_pomodoro_session', 'INSERT INTO native_request_receipts', 'COMMIT', 'readback'])(
        'rolls adoption, task and receipt back at %s and applies the exact retry once', async (fault) => {
            const env = await openLegacy(); const before = await env.state(); let once = true;
            env.hooks.run = async (sql) => { if (once && sql.startsWith(fault)) { once = false; throw new Error('fault'); } };
            env.hooks.all = async (sql) => { if (fault === 'readback' && once && env.events.some((s) => s.startsWith('UPDATE tasks'))
                && sql.startsWith('SELECT id, state_json')) { once = false; throw new Error('read fault'); } };
            await expect(env.adapter.savePomodoroTransitionWithReceipt(env.plan)).rejects.toThrow(/Pomodoro/);
            expect(once).toBe(false); expect(await env.state()).toEqual(before);
            env.hooks.run = undefined; env.hooks.all = undefined;
            expect((await env.adapter.savePomodoroTransitionWithReceipt(env.plan)).result.creditedMinutes).toBe(50);
            const after = await env.state(); expect(after.receipts).toHaveLength(1);
            await env.adapter.savePomodoroTransitionWithReceipt(env.plan); expect(await env.state()).toEqual(after);
        });
    async function openOwed(pendingCredits: unknown[], legacyChanges: Record<string, unknown> = {}) {
        const env = await openLegacy();
        await env.sql.client.run(`INSERT INTO tasks (${TASK_SQLITE_COLUMNS.join(', ')}) SELECT ${TASK_SQLITE_COLUMNS.map((name) =>
            name === 'id' ? "'other'" : name === 'timeSpentMinutes' ? '10' : name).join(', ')} FROM tasks WHERE id='task'`);
        await useTaskStore.getState().fetchData({ recoveryLoad: true, throwOnError: true });
        const rows = async (id: string) => {
            const [row] = await env.sql.client.all<Record<string, string | number | null>>('SELECT * FROM tasks WHERE id=?', [id]);
            return { id, row: TASK_SQLITE_COLUMNS.map((name) => row[name]) };
        };
        if (env.plan.request.action !== 'adoptLegacy') throw new Error('fixture');
        const legacy = JSON.parse(env.plan.request.legacy.sessionRaw!) as Record<string, unknown>;
        const sessionRaw = JSON.stringify({ ...legacy, ...legacyChanges, pendingCredits });
        const adopt = async () => prepareNativePomodoroTransition({ request: { ...env.plan.request, legacy: { ...env.plan.request.legacy, sessionRaw } } as typeof env.plan.request,
            session: { raw: null, state: null }, target: await rows('task'), owed: [await rows('other')], deviceId: 'device' })!;
        env.events.length = 0;
        return { ...env, adopt };
    }
    it.each(['second UPDATE tasks', 'COMMIT'])('applies RN owed credits with the adoption once; a crash at %s leaves the RN record to adopt again', async (fault) => {
        // The RN record: a stop after the session save left both credits owed.
        const env = await openOwed([{ taskId: 'task', from: 4, to: 54 }, { taskId: 'other', from: 10, to: 60 }]);
        const { adopt } = env;
        const plan = await adopt(); const before = await env.state(); let updates = 0; let once = true;
        env.hooks.run = async (sql) => {
            if (sql.startsWith('UPDATE tasks')) updates += 1;
            if (once && (fault === 'COMMIT' ? sql === 'COMMIT' : sql.startsWith('UPDATE tasks') && updates === 2)) { once = false; throw new Error('crash'); }
        };
        await expect(env.adapter.savePomodoroTransitionWithReceipt(plan)).rejects.toThrow(/Pomodoro/);
        expect(once).toBe(false); expect(await env.state()).toEqual(before);
        env.hooks.run = undefined;
        // Nothing of the adoption landed, so the same RN record adopts again to the same plan.
        const retry = await adopt(); expect(retry).toEqual(plan); const info = vi.spyOn(logger, 'logInfo');
        expect((await env.adapter.savePomodoroTransitionWithReceipt(retry)).result.creditedMinutes).toBe(50);
        expect(info).toHaveBeenCalledWith('Native Pomodoro adoption settled owed credits', { scope: 'storage', force: true,
            context: { releaseCheck: 'v1.3.8/pomodoro-adopt-owed-credits', count: 2, applied: 2, outcome: 'confirmed' } });
        const minutes = async () => (await env.sql.client.all<{ id: string; timeSpentMinutes: number }>(
            'SELECT id, timeSpentMinutes FROM tasks ORDER BY id')).map((row) => [row.id, row.timeSpentMinutes]);
        expect(await minutes()).toEqual([['other', 60], ['task', 104]]);
        expect(useTaskStore.getState()._tasksById.get('other')!.timeSpentMinutes).toBe(60);
        const after = await env.state(); env.events.length = 0;
        expect((await env.adapter.savePomodoroTransitionWithReceipt(retry)).replayed).toBe(true);
        expect(await env.state()).toEqual(after); expect(env.events.some((sql) => /^(UPDATE|INSERT)/u.test(sql))).toBe(false);
    });
    it.each(['other task', 'device'])('refuses an owed-only adoption whose %s changed after prepare, with no writes', async (change) => {
        // Paused: only the other task's owed credit writes anything.
        const env = await openOwed([{ taskId: 'other', from: 10, to: 35 }], { timerState: { phase: 'focus', remainingSeconds: 60, isRunning: false, completedFocusSessions: 3 } });
        const plan = await env.adopt(); expect(plan.taskPatch).toBeNull(); expect(plan.owed![0].taskPatch).not.toBeNull();
        if (change === 'other task') await env.sql.client.run('UPDATE tasks SET title=? WHERE id=?', ['Edited elsewhere', 'other']);
        else await env.sql.client.run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify({ deviceId: 'another' })]);
        const before = await env.state(); env.events.length = 0;
        await expect(env.adapter.savePomodoroTransitionWithReceipt(plan)).rejects.toMatchObject({ code: 'staleBaseline' });
        expect(await env.state()).toEqual(before); expect(env.events.some((sql) => /^(UPDATE|INSERT|DELETE)/u.test(sql))).toBe(false);
    });
    it('commits an owed-only adoption and reloads the store projection', async () => {
        const env = await openOwed([{ taskId: 'other', from: 10, to: 35 }], { timerState: { phase: 'focus', remainingSeconds: 60, isRunning: false, completedFocusSessions: 3 } });
        const plan = await env.adopt();
        expect(await env.adapter.savePomodoroTransitionWithReceipt(plan)).toEqual({ result: plan.result, replayed: false, projectionReloaded: true });
        expect(useTaskStore.getState()._tasksById.get('other')!.timeSpentMinutes).toBe(35);
        expect(useTaskStore.getState()._tasksById.get('task')!.timeSpentMinutes).toBe(4);
    });
    it('recovers an actual lost COMMIT reply from cold proof before later task/session/source availability', async () => {
        const env = await openLegacy(); let once = true;
        env.hooks.afterRun = async (sql) => { if (sql === 'COMMIT' && once) { once = false; throw new Error('lost reply'); } };
        await expect(env.adapter.savePomodoroTransitionWithReceipt(env.plan)).rejects.toThrow(/Pomodoro/);
        env.hooks.afterRun = undefined;
        await env.sql.client.run('UPDATE tasks SET timeSpentMinutes=?,title=? WHERE id=?', [99, 'Later', 'task']);
        await env.sql.client.run('UPDATE native_pomodoro_session SET state_json=? WHERE id=1', ['later session owner']);
        resetNativeRequestReceipts(); await loadNativeRequestReceipts(env.sql.client, { durableCommands: ['pomodoroTransition'] });
        const cold = new NativeReceiptSqliteAdapter(env.client, { rejectConcurrentWrites: true }); setStorageAdapter(cold);
        const before = await env.state(); env.events.length = 0;
        // Only the retained request is supplied: replay has no source I/O dependency.
        expect(await cold.readPomodoroTransitionOutcome(env.plan)).toEqual(env.plan.result);
        expect((await cold.savePomodoroTransitionWithReceipt(env.plan)).replayed).toBe(true);
        expect(await env.state()).toEqual(before); expect(env.events.some((sql) => /^(UPDATE|INSERT)/u.test(sql))).toBe(false);
    });
    it('binds exact raw source bytes in identity despite semantically equal parsed legacy state', async () => {
        const env = await openLegacy(); await env.adapter.savePomodoroTransitionWithReceipt(env.plan);
        if (env.plan.request.action !== 'adoptLegacy') throw new Error('fixture');
        const changed = prepareNativePomodoroTransition({ request: { ...env.plan.request,
            legacy: { ...env.plan.request.legacy, sessionRaw: env.plan.request.legacy.sessionRaw!.trim() } },
            session: { raw: null, state: null }, target: env.plan.target, deviceId: env.plan.deviceId })!;
        expect(changed.sessionAfter).toBe(env.plan.sessionAfter); const before = await env.state();
        await expect(env.adapter.savePomodoroTransitionWithReceipt(changed)).rejects.toThrow(/identity/);
        expect(await env.state()).toEqual(before);
    });
    it.each(['task', 'native', 'device'] as const)('refuses changed %s baseline without adoption/domain damage', async (kind) => {
        const env = await openLegacy();
        if (kind === 'task') await env.sql.client.run('UPDATE tasks SET tags=? WHERE id=?', [' [ ] ', 'task']);
        else if (kind === 'native') await env.sql.client.run('INSERT INTO native_pomodoro_session (id,state_json) VALUES (1,?)', [env.initialize.sessionAfter]);
        else await env.sql.client.run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify({ deviceId: 'other' })]);
        const before = await env.state(); env.events.length = 0;
        await expect(env.adapter.savePomodoroTransitionWithReceipt(env.plan)).rejects.toThrow(/baseline|identity/);
        expect(await env.state()).toEqual(before); expect(env.events.some((sql) => /^(UPDATE|INSERT)/u.test(sql))).toBe(false);
    });
    it('allows unrelated cold settings but refuses missing proven receipt even with restored absence', async () => {
        const env = await openLegacy();
        await env.sql.client.run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify({ deviceId: 'device', unrelated: true })]);
        await env.adapter.savePomodoroTransitionWithReceipt(env.plan);
        resetNativeRequestReceipts(); await loadNativeRequestReceipts(env.sql.client, { durableCommands: ['pomodoroTransition'] });
        const cold = new NativeReceiptSqliteAdapter(env.client, { rejectConcurrentWrites: true }); setStorageAdapter(cold);
        expect(await cold.readPomodoroTransitionOutcome(env.plan)).toEqual(env.plan.result);
        await env.sql.client.run('DELETE FROM native_request_receipts'); await env.sql.client.run('DELETE FROM native_pomodoro_session');
        const before = await env.state(); env.events.length = 0;
        await expect(cold.savePomodoroTransitionWithReceipt(env.plan)).rejects.toThrow(/Pomodoro/);
        expect(await env.state()).toEqual(before); expect(env.events.some((sql) => /^(UPDATE|INSERT)/u.test(sql))).toBe(false);
    });
});

describe('native Pomodoro atomic storage over real SQLite', () => {
    it('retains raw task cells through canonical reload and a later ordinary save', async () => {
        const env = await open();
        await env.sql.client.run("UPDATE tasks SET contexts=' [ ] ',tags=NULL WHERE id='task'");
        const row = (await env.sql.client.all<Record<string, string | number | null>>("SELECT * FROM tasks WHERE id='task'"))[0];
        const plan = prepareNativePomodoroTransition({ request: env.plan.request,
            session: { raw: env.plan.sessionBefore!, state: decodeNativePomodoroSession(env.plan.sessionBefore!) },
            target: { id: 'task', row: TASK_SQLITE_COLUMNS.map((name) => row[name]) }, deviceId: 'device' })!;
        expect((await env.adapter.savePomodoroTransitionWithReceipt(plan)).projectionReloaded).toBe(true);
        await useTaskStore.getState().addTask('Later ordinary task');
        await flushPendingSave();
        const after = (await env.sql.client.all<Record<string, unknown>>("SELECT contexts,tags,timeSpentMinutes FROM tasks WHERE id='task'"))[0];
        expect(after).toEqual({ contexts: ' [ ] ', tags: null, timeSpentMinutes: 29 });
    });
    it('commits four task cells, local session and exact receipt, adopts canonical projection and keeps JSON local-state-free', async () => {
        const env = await open();
        await env.sql.client.run('UPDATE tasks SET recurrence=?,attachments=? WHERE id=?', [' {"opaque":true} ', ' [ ] ', 'task']);
        const row = (await env.sql.client.all<Record<string, string | number | null>>('SELECT * FROM tasks'))[0];
        env.plan.target!.row = TASK_SQLITE_COLUMNS.map((name) => row[name]);
        const before = await env.state();
        const answer = await env.adapter.savePomodoroTransitionWithReceipt(env.plan);
        expect(answer).toEqual({ result: env.plan.result, replayed: false, projectionReloaded: true });
        const after = await env.state();
        const changed = Object.keys(row).filter((name) => (before.tasks[0] as Record<string, unknown>)[name] !== (after.tasks[0] as Record<string, unknown>)[name]);
        expect(changed.sort()).toEqual(['rev', 'revBy', 'timeSpentMinutes'].sort());
        expect((after.tasks[0] as Record<string, unknown>).timeSpentMinutes).toBe(29);
        expect(after.receipts).toHaveLength(1);
        expect((after.receipts[0] as Record<string, unknown>).method).toBe(nativePomodoroReceiptPayload(env.plan));
        expect(useTaskStore.getState()._tasksById.get('task')!.timeSpentMinutes).toBe(29);
        const data = await env.adapter.getData(); expect(JSON.stringify(data)).not.toContain('sessionID');
        await env.adapter.saveData(data); expect((await env.state()).sessions).toEqual(after.sessions);
    });
    it.each(['UPDATE tasks', 'UPDATE native_pomodoro_session', 'INSERT INTO native_request_receipts', 'COMMIT', 'readback'])('rolls all three tables back on %s failure and retries the same preparation once', async (fault) => {
        const env = await open(); const before = await env.state(); let failures = 0;
        const info = vi.spyOn(logger, 'logInfo');
        env.hooks.run = async (statement) => { if (failures < 2 && statement.startsWith(fault)) { failures += 1; throw new Error('private driver'); } };
        env.hooks.all = async (statement) => { if (fault === 'readback' && failures < 2 && env.events.some((sql) => sql.startsWith('UPDATE tasks'))
            && statement.startsWith('SELECT id, state_json')) { failures += 1; throw new Error('private read'); } };
        for (let attempt = 0; attempt < 2; attempt += 1) {
            await expect(env.adapter.savePomodoroTransitionWithReceipt(env.plan)).rejects.toThrow(/Pomodoro/);
            expect(await env.state()).toEqual(before);
        }
        expect(info.mock.calls.filter((call) => call[0] === 'Native Pomodoro transition confirmed')).toEqual([]);
        env.hooks.run = undefined; env.hooks.all = undefined;
        expect((await env.adapter.savePomodoroTransitionWithReceipt(env.plan)).result.creditedMinutes).toBe(25);
        expect((await env.state()).receipts).toHaveLength(1);
    });
    it('proves an actual lost COMMIT reply and cold replay before later task/session checks without rewriting', async () => {
        const env = await open(); let once = true;
        env.hooks.afterRun = async (statement) => { if (statement === 'COMMIT' && once) { once = false; throw new Error('lost reply'); } };
        await expect(env.adapter.savePomodoroTransitionWithReceipt(env.plan)).rejects.toThrow(/Pomodoro/);
        env.hooks.afterRun = undefined;
        await env.sql.client.run('UPDATE tasks SET timeSpentMinutes=?,title=? WHERE id=?', [99, 'Later', 'task']);
        await env.sql.client.run('UPDATE native_pomodoro_session SET state_json=? WHERE id=1', ['unknown later owner']);
        resetNativeRequestReceipts(); await loadNativeRequestReceipts(env.sql.client, { durableCommands: ['pomodoroTransition'] });
        const fresh = new NativeReceiptSqliteAdapter(env.client, { rejectConcurrentWrites: true }); setStorageAdapter(fresh);
        const before = await env.state(); env.events.length = 0;
        expect(await fresh.readPomodoroTransitionOutcome(env.plan)).toEqual(env.plan.result);
        expect((await fresh.savePomodoroTransitionWithReceipt(env.plan)).replayed).toBe(true);
        expect(await env.state()).toEqual(before);
        expect(env.events.some((s) => /^(UPDATE|INSERT)/u.test(s))).toBe(false);
    });
    it('refuses changed identity, missing known proof, malformed boot proof and overlapping UUID ranges', async () => {
        const env = await open(); await env.adapter.savePomodoroTransitionWithReceipt(env.plan);
        const before = await env.state();
        const changed = prepareNativePomodoroTransition({ request: { ...env.plan.request, observedAtMs: now + 1000 },
            session: { raw: env.plan.sessionBefore!, state: decodeNativePomodoroSession(env.plan.sessionBefore!) },
            target: env.plan.target, deviceId: env.plan.deviceId })!;
        await expect(env.adapter.savePomodoroTransitionWithReceipt(changed)).rejects.toThrow(/identity/);
        await expect(env.adapter.savePomodoroTransitionWithReceipt({ ...env.plan, request: { ...env.plan.request, requestId: ID } })).rejects.toThrow();
        expect(await env.state()).toEqual(before);
        await env.sql.client.run('DELETE FROM native_request_receipts');
        await expect(env.adapter.readPomodoroTransitionOutcome(env.plan)).rejects.toThrow();
        await expect(env.adapter.savePomodoroTransitionWithReceipt(env.plan)).rejects.toThrow();
        resetNativeRequestReceipts(); await loadNativeRequestReceipts(env.sql.client);
        const cold = new NativeReceiptSqliteAdapter(env.client, { rejectConcurrentWrites: true });
        await expect(cold.savePomodoroTransitionWithReceipt({ ...env.plan, request: { ...env.plan.request, requestId: ID } })).rejects.toThrow(/baseline/);
        await env.sql.client.run('INSERT INTO native_request_receipts VALUES (?,?,?,?)', [NEXT, nativePomodoroReceiptPayload(env.plan), '{}', AT]);
        await expect(loadNativeRequestReceipts(env.sql.client)).rejects.toThrow(/Pomodoro/);
    });
    it('guards full target raw bytes and device but permits unrelated cold durable edits', async () => {
        const env = await open(); const before = await env.state();
        await env.sql.client.run('UPDATE tasks SET tags=? WHERE id=?', [' [ ] ', 'task']);
        await expect(env.adapter.savePomodoroTransitionWithReceipt(env.plan)).rejects.toThrow(/baseline/);
        expect((await env.state()).receipts).toEqual([]);
        await env.sql.client.run('UPDATE tasks SET tags=? WHERE id=?', [(before.tasks[0] as Record<string, unknown>).tags, 'task']);
        await env.sql.client.run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify({ deviceId: 'other' })]);
        await expect(env.adapter.savePomodoroTransitionWithReceipt(env.plan)).rejects.toThrow(/identity/);
        await env.sql.client.run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify({ deviceId: 'device', unrelated: true })]);
        expect((await env.adapter.savePomodoroTransitionWithReceipt(env.plan)).result).toEqual(env.plan.result);
        expect((await env.state()).settings).toEqual([{ id: 1, data: JSON.stringify({ deviceId: 'device', unrelated: true }) }]);
    });
    it('retains reload fence after failed/discarded load and retries projection only from receipt', async () => {
        const env = await open(); let fail = true;
        env.hooks.all = async (statement) => { if (fail && statement.includes('FROM tasks') && !statement.includes('WHERE id')) throw new Error('read failed'); };
        const answer = await env.adapter.savePomodoroTransitionWithReceipt(env.plan); expect(answer.projectionReloaded).toBe(false);
        const before = await env.state(); fail = false;
        const data = await env.adapter.getData();
        await expect(env.adapter.saveData(data)).rejects.toThrow(/reload/);
        await expect(env.adapter.commitReceiptOnly(ID, '[]')).rejects.toThrow(/reload/);
        const retry = await env.adapter.savePomodoroTransitionWithReceipt(env.plan);
        expect(retry).toEqual({ result: env.plan.result, replayed: true, projectionReloaded: true });
        expect(await env.state()).toEqual(before);
        await env.adapter.saveData(await env.adapter.getData());
    });
    it.each(['retired fetch', 'stale preloaded adoption', 'mutated accepted content'] as const)(
        'retains every write fence when %s happens after canonical ACK and retries without credit', async (retirement) => {
            const env = await open();
            await env.sql.client.run('UPDATE tasks SET rev=?,revBy=? WHERE id=?', [2_147_483_647, 'device', 'task']);
            await useTaskStore.getState().fetchData({ recoveryLoad: true, throwOnError: true });
            const preCredit = await env.adapter.getData();
            const row = (await env.sql.client.all<Record<string, string | number | null>>('SELECT * FROM tasks'))[0];
            const plan = prepareNativePomodoroTransition({ request: env.plan.request,
                session: { raw: env.plan.sessionBefore!, state: decodeNativePomodoroSession(env.plan.sessionBefore!) },
                target: { id: 'task', row: TASK_SQLITE_COLUMNS.map((name) => row[name]) }, deviceId: 'device' })!;
            const actualFetch = useTaskStore.getState().fetchData;
            const postAck = gate();
            const ownedFetch: typeof actualFetch = async (options) => {
                await actualFetch(options);
                expect(useTaskStore.getState()._tasksById.get('task')!.timeSpentMinutes).toBe(29);
                await postAck.hold();
                if (retirement === 'retired fetch') useTaskStore.setState({ fetchData: actualFetch });
                else if (retirement === 'stale preloaded adoption') await actualFetch({ silent: true, recoveryLoad: true,
                    throwOnError: true, preloadedData: preCredit });
                else useTaskStore.getState()._tasksById.get('task')!.timeSpentMinutes = 4;
            };
            useTaskStore.setState({ fetchData: ownedFetch });
            const generationWrite = vi.fn(async () => ({ ok: true as const, value: 1 }));
            const receipts = createNativeRequestReceipts({ save: async () => ({ ok: true, value: null }) });
            const assertFenced = async () => {
                await expect(env.adapter.saveData(preCredit)).rejects.toThrow(/busy|reload/);
                await expect(env.adapter.saveDocumentWithReceipt({ requestId: ID,
                    payload: JSON.stringify(['backupDocument', 'merge', ID, 'a'.repeat(64)]),
                    expectedCurrent: preCredit, data: preCredit, reply: { unchanged: true } })).rejects.toThrow(/busy|reload/);
                await expect(env.adapter.commitReceiptOnly(ID, '["other"]')).rejects.toThrow(/busy|reload/);
                expect(await receipts.run(ID, '["other"]', generationWrite)).toMatchObject({ ok: false });
                expect(generationWrite).not.toHaveBeenCalled();
            };
            const write = env.adapter.savePomodoroTransitionWithReceipt(plan);
            await postAck.waiting;
            try { await assertFenced(); } finally { postAck.release(); }
            const answer = await write;
            expect(answer).toEqual({ result: plan.result, replayed: false, projectionReloaded: false });
            expect(useTaskStore.getState().fetchData).toBe(retirement === 'retired fetch' ? actualFetch : ownedFetch);
            expect(useTaskStore.getState()._tasksById.get('task')!.timeSpentMinutes).toBe(retirement === 'retired fetch' ? 29 : 4);
            const saved = await env.state();
            expect((saved.tasks[0] as Record<string, unknown>).timeSpentMinutes).toBe(29);
            expect((saved.receipts[0] as Record<string, unknown>).reply).toBe(JSON.stringify(plan.result));
            await assertFenced();
            expect(await env.state()).toEqual(saved);
            useTaskStore.setState({ fetchData: actualFetch });
            env.events.length = 0;
            expect(await env.adapter.savePomodoroTransitionWithReceipt(plan)).toEqual({ result: plan.result,
                replayed: true, projectionReloaded: true });
            expect(env.events.some((sql) => sql.startsWith('UPDATE tasks') || sql.startsWith('UPDATE native_pomodoro_session')
                || sql.startsWith('INSERT INTO native_request_receipts'))).toBe(false);
            expect(await env.state()).toEqual(saved);
            expect(useTaskStore.getState()._tasksById.get('task')!.timeSpentMinutes).toBe(29);
            await useTaskStore.getState().updateTask('task', { title: 'Ordinary edit after exact projection retry' });
            await flushPendingSave();
            expect((await env.adapter.getData()).tasks[0].timeSpentMinutes).toBe(29);
        });
    it('excludes ordinary writes during held SQL and held projection; adapter replacement cannot acknowledge old adoption', async () => {
        const env = await open(); const held = gate();
        env.hooks.run = async (statement) => { if (statement === 'BEGIN IMMEDIATE') await held.hold(); };
        const write = env.adapter.savePomodoroTransitionWithReceipt(env.plan); await held.waiting;
        await expect(env.adapter.getData()).rejects.toThrow(/busy/);
        await expect(env.adapter.saveData(original)).rejects.toThrow(/busy/);
        const generationWrite = vi.fn(async () => ({ ok: true as const, value: 1 }));
        const generationReceipts = createNativeRequestReceipts({ save: async () => ({ ok: true, value: null }) });
        try {
            expect(await generationReceipts.run(ID, '["other"]', generationWrite)).toMatchObject({ ok: false });
            expect(generationWrite).not.toHaveBeenCalled();
        } finally { held.release(); }
        env.hooks.run = undefined; await write;
        // Force a cold proof-based reload against a new adapter, then retire its owner mid-read.
        const fresh = new NativeReceiptSqliteAdapter(env.client, { rejectConcurrentWrites: true }); setStorageAdapter(fresh);
        const load = gate(); env.hooks.all = async (statement) => { if (statement.includes('FROM tasks') && !statement.includes('WHERE id')) await load.hold(); };
        const replay = fresh.savePomodoroTransitionWithReceipt(env.plan); await load.waiting;
        await expect(fresh.saveData(original)).rejects.toThrow(/reload|busy/);
        await expect(fresh.commitReceiptOnly(ID, '[]')).rejects.toThrow(/reload|busy/);
        setStorageAdapter(oldAdapter); load.release();
        expect((await replay).projectionReloaded).toBe(false);
        expect(useTaskStore.getState()._tasksById.get('task')!.timeSpentMinutes).toBe(29);
        await expect(fresh.saveData(original)).rejects.toThrow(/reload/);
    });
    it('initialization does not strand ordinary saves and corrupt local rows stay preserved outside ordinary loads', async () => {
        const env = await open(); await env.sql.client.run('DELETE FROM native_pomodoro_session');
        expect(await env.adapter.readPomodoroSession()).toEqual({ raw: null, state: null });
        expect((await env.adapter.savePomodoroTransitionWithReceipt(env.initialize)).projectionReloaded).toBe(true);
        await env.adapter.saveData(await env.adapter.getData());
        await env.sql.client.run('UPDATE native_pomodoro_session SET state_json=? WHERE id=1', ['{"version":999}']);
        await expect(env.adapter.readPomodoroSession()).rejects.toThrow(/Pomodoro/);
        await loadNativeRequestReceipts(env.sql.client);
        await env.adapter.getData(); expect((await env.state()).sessions).toEqual([{ id: 1, state_json: '{"version":999}' }]);
    });
    it('preserves an unknown local schema and read failures while ordinary canonical data remains readable', async () => {
        const env = await open();
        env.hooks.all = async (statement) => { if (statement.startsWith('PRAGMA table_info(native_pomodoro_session)')) throw new Error('read error'); };
        await expect(env.adapter.readPomodoroSession()).rejects.toThrow('Pomodoro session could not be read');
        env.hooks.all = undefined;
        await env.sql.client.run('ALTER TABLE native_pomodoro_session ADD COLUMN unknown TEXT');
        const before = await env.state();
        await loadNativeRequestReceipts(env.sql.client);
        await expect(env.adapter.readPomodoroSession()).rejects.toThrow('Pomodoro session could not be read');
        await env.adapter.getData(); expect(await env.state()).toEqual(before);
    });
    it('logs only after durable proof and logger failure cannot change the result', async () => {
        const env = await open(); const info = vi.spyOn(logger, 'logInfo');
        await env.adapter.savePomodoroTransitionWithReceipt(env.plan);
        expect(info.mock.calls.filter((call) => call[0] === 'Native Pomodoro transition confirmed')).toEqual([['Native Pomodoro transition confirmed',
            { scope: 'storage', force: true, context: { releaseCheck: 'v1.3.5/ios-pomodoro-credit', outcome: 'confirmed' } }]]);
        info.mockImplementation(() => { throw new Error('logger failed'); });
        expect((await env.adapter.savePomodoroTransitionWithReceipt(env.plan)).result).toEqual(env.plan.result);
    });
    it('refuses Pomodoro while an ordinary write, baseline read, document write or receipt-only transaction owns the connection', async () => {
        const env = await open();
        for (const kind of ['ordinary', 'baseline', 'document'] as const) {
            const held = gate(); let operation: Promise<unknown>;
            if (kind === 'baseline') {
                env.hooks.all = async (statement) => { if (statement.includes('FROM tasks') && !statement.includes('WHERE id')) await held.hold(); };
                operation = env.adapter.getData();
            } else {
                env.hooks.run = async (statement) => { if (statement === 'BEGIN IMMEDIATE') await held.hold(); };
                if (kind === 'ordinary') operation = env.adapter.saveData(await env.adapter.getData());
                else operation = env.adapter.saveDocumentWithReceipt({ requestId: ID,
                    payload: JSON.stringify(['backupDocument', 'merge', ID, 'a'.repeat(64)]),
                    expectedCurrent: await env.adapter.getData(), data: await env.adapter.getData(), reply: { unchanged: true } });
            }
            await held.waiting;
            await expect(env.adapter.savePomodoroTransitionWithReceipt(env.plan)).rejects.toThrow(/busy/);
            held.release(); await operation;
            env.hooks.run = undefined; env.hooks.all = undefined;
        }
        await loadNativeRequestReceipts(env.sql.client);
        const receipts = createNativeRequestReceipts({ save: async () => ({ ok: false, error: { code: 'SAVE_FAILED', message: 'held' } }) });
        const id = '44444444-4444-4444-8444-444444444444';
        await receipts.run(id, '["other"]', async () => ({ ok: true, value: 1 }));
        const held = gate(); env.hooks.run = async (statement) => { if (statement === 'BEGIN IMMEDIATE') await held.hold(); };
        const receiptOnly = env.adapter.commitReceiptOnly(id, '["other"]'); await held.waiting;
        await expect(env.adapter.savePomodoroTransitionWithReceipt(env.plan)).rejects.toThrow(/busy/);
        held.release(); await receiptOnly; env.hooks.run = undefined;
        expect((await env.adapter.savePomodoroTransitionWithReceipt(env.plan)).result).toEqual(env.plan.result);
    });
    it('does not let generic generation/receipt-only writers fabricate a Pomodoro outcome', async () => {
        const env = await open(); const receipts = createNativeRequestReceipts({ save: async () => ({ ok: true, value: null }) });
        const write = vi.fn(async () => ({ ok: true as const, value: env.plan.result }));
        expect(await receipts.run(NEXT, nativePomodoroReceiptPayload(env.plan), write)).toMatchObject({ ok: false });
        expect(write).not.toHaveBeenCalled();
        await expect(env.adapter.commitReceiptOnly(NEXT, nativePomodoroReceiptPayload(env.plan))).rejects.toThrow(/atomic/);
        expect(await env.adapter.readPomodoroTransitionOutcome(env.plan)).toBeNull();
    });
    it('keeps edits made during held projection and cannot acknowledge a discarded canonical result', async () => {
        const env = await open(); const held = gate();
        env.hooks.all = async (statement) => { if (statement.includes('FROM tasks') && !statement.includes('WHERE id')) await held.hold(); };
        const write = env.adapter.savePomodoroTransitionWithReceipt(env.plan); await held.waiting;
        const current = useTaskStore.getState()._allTasks;
        const changed = current.map((task) => ({ ...task, title: 'Retained pending edit' }));
        useTaskStore.setState({ _allTasks: changed, tasks: changed, _tasksById: new Map(changed.map((task) => [task.id, task])), lastDataChangeAt: 1 });
        held.release(); env.hooks.all = undefined;
        expect((await write).projectionReloaded).toBe(false);
        expect(useTaskStore.getState()._tasksById.get('task')!.title).toBe('Retained pending edit');
        const discarded = await env.adapter.getData(); env.adapter.acknowledgeDataLoad(discarded);
        await expect(env.adapter.saveData(discarded)).rejects.toThrow(/reload/);
        const writer = vi.fn(async () => ({ ok: true as const, value: 1 }));
        const receipts = createNativeRequestReceipts({ save: async () => ({ ok: true, value: null }) });
        expect(await receipts.run(ID, '["other"]', writer)).toMatchObject({ ok: false });
        expect(writer).not.toHaveBeenCalled();
        expect((await env.adapter.readPomodoroTransitionOutcome(env.plan))!.creditedMinutes).toBe(25);
    });
    it('refuses warm reapplication after an ambiguous actual COMMIT loses its receipt even if raw BEFORE is restored', async () => {
        const env = await open(); let once = true;
        env.hooks.afterRun = async (statement) => { if (statement === 'COMMIT' && once) { once = false; throw new Error('lost'); } };
        await expect(env.adapter.savePomodoroTransitionWithReceipt(env.plan)).rejects.toThrow();
        env.hooks.afterRun = undefined;
        await env.sql.client.run('DELETE FROM native_request_receipts');
        await env.sql.client.run('UPDATE native_pomodoro_session SET state_json=? WHERE id=1', [env.plan.sessionBefore]);
        const row = env.plan.target!.row!;
        await env.sql.client.run('UPDATE tasks SET timeSpentMinutes=?,rev=?,revBy=?,updatedAt=? WHERE id=?',
            ['timeSpentMinutes', 'rev', 'revBy', 'updatedAt'].map((name) => row[TASK_SQLITE_COLUMNS.indexOf(name)]).concat(['task']));
        const before = await env.state();
        await expect(env.adapter.savePomodoroTransitionWithReceipt(env.plan)).rejects.toThrow();
        expect(await env.state()).toEqual(before);
        await expect(env.adapter.readPomodoroTransitionOutcome(env.plan)).rejects.toThrow();
    });
    it('preserves edits made while SQL is held before projection reload can capture a newer owner', async () => {
        const env = await open(); const held = gate();
        env.hooks.run = async (statement) => { if (statement === 'BEGIN IMMEDIATE') await held.hold(); };
        const write = env.adapter.savePomodoroTransitionWithReceipt(env.plan); await held.waiting;
        const changed = useTaskStore.getState()._allTasks.map((task) => ({ ...task, title: 'Edit during SQL' }));
        useTaskStore.setState({ _allTasks: changed, tasks: changed, _tasksById: new Map(changed.map((task) => [task.id, task])), lastDataChangeAt: 1 });
        held.release(); env.hooks.run = undefined;
        expect((await write).projectionReloaded).toBe(false);
        expect(useTaskStore.getState()._tasksById.get('task')!.title).toBe('Edit during SQL');
        await expect(env.adapter.saveData(original)).rejects.toThrow(/reload/);
    });
    it('refreshes capped identical revision/timestamp and refuses forged oversized plans before BEGIN', async () => {
        const env = await open();
        await env.sql.client.run('UPDATE tasks SET rev=?,revBy=? WHERE id=?', [2_147_483_647, 'device', 'task']);
        await useTaskStore.getState().fetchData({ recoveryLoad: true, throwOnError: true });
        const row = (await env.sql.client.all<Record<string, string | number | null>>('SELECT * FROM tasks'))[0];
        const plan = prepareNativePomodoroTransition({ request: env.plan.request,
            session: { raw: env.plan.sessionBefore!, state: decodeNativePomodoroSession(env.plan.sessionBefore!) },
            target: { id: 'task', row: TASK_SQLITE_COLUMNS.map((name) => row[name]) }, deviceId: 'device' })!;
        expect((await env.adapter.savePomodoroTransitionWithReceipt(plan)).projectionReloaded).toBe(true);
        expect(useTaskStore.getState()._tasksById.get('task')!.timeSpentMinutes).toBe(29);
        const fresh = await env.adapter.getData(); await env.adapter.saveData(fresh);
        expect((await env.adapter.getData()).tasks[0].timeSpentMinutes).toBe(29);
        await useTaskStore.getState().updateTask('task', { title: 'Ordinary edit after adoption' });
        await flushPendingSave();
        expect((await env.adapter.getData()).tasks[0].timeSpentMinutes).toBe(29);
        env.events.length = 0;
        await expect(env.adapter.savePomodoroTransitionWithReceipt({ ...plan, result: { ...plan.result, creditedMinutes: 999 } })).rejects.toThrow();
        expect(env.events).toEqual([]);
    });
    it('refuses entry while a generation callback is running before it has a pending receipt', async () => {
        const env = await open(); await loadNativeRequestReceipts(env.sql.client);
        const held = gate();
        const receipts = createNativeRequestReceipts({ save: async () => ({ ok: false, error: { code: 'SAVE_FAILED', message: 'unsettled' } }) });
        const running = receipts.run(ID, '["other"]', async () => { await held.hold(); return { ok: true, value: 1 }; });
        await held.waiting; env.events.length = 0;
        try {
            await expect(env.adapter.savePomodoroTransitionWithReceipt(env.plan)).rejects.toThrow(/busy/);
            expect(env.events).toEqual([]);
        } finally { held.release(); }
        expect(await running).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
    });
});
