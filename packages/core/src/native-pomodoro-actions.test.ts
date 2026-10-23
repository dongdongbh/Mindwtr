import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeNativePomodoroSession, nativePomodoroReceiptPayload, prepareNativePomodoroTransition,
    type NativePomodoroRequest } from './native-pomodoro-session';
import { loadNativeRequestReceipts, NativeReceiptSqliteAdapter, resetNativeRequestReceipts } from './native-request-receipts';
import { openScratchSqlite } from './screen-parity.replay';
import { SqliteAdapter, type SqliteClient } from './sqlite-adapter';
import { TASK_SQLITE_COLUMNS } from './task-sync-schema';
import { getStorageAdapter, setStorageAdapter, useTaskStore } from './store';
import type { AppData } from './types';

const ID = '11111111-1111-4111-8111-111111111111';
const NEXT = '22222222-2222-4222-8222-222222222222';
const AT = '2026-10-10T00:00:00.000Z';
const now = Date.parse(AT);
const original: AppData = { tasks: [
    { id: 'task', title: 'Old selection', status: 'next', contexts: [], tags: [], createdAt: AT, updatedAt: AT, rev: 1, timeSpentMinutes: 4 },
    { id: 'next-task', title: 'Next selection', status: 'next', contexts: [], tags: [], createdAt: AT, updatedAt: AT, rev: 1, timeSpentMinutes: 10 },
], projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'device' } };
const resources: { close: () => void; directory: string }[] = [];
const root = fileURLToPath(new URL('../../../.orchestrator/tmp/task524/', import.meta.url));
const oldAdapter = getStorageAdapter();
const oldStore = useTaskStore.getState();

async function open(action: { action: 'setDurations'; durations: { focusMinutes: number; breakMinutes: number } }
    | { action: 'selectTask'; taskId: string | null } = { action: 'setDurations', durations: { focusMinutes: 50, breakMinutes: 10 } }) {
    mkdirSync(root, { recursive: true }); const directory = mkdtempSync(join(root, 'pomodoro-action-'));
    const sql = openScratchSqlite(join(directory, 'library.sqlite')); resources.push({ close: sql.close, directory });
    await new SqliteAdapter(sql.client).saveData(structuredClone(original));
    resetNativeRequestReceipts(); await loadNativeRequestReceipts(sql.client, { durableCommands: ['pomodoroTransition'] });
    const statements: string[] = [];
    const hooks: { beforeRun?: (statement: string) => Promise<void>; afterRun?: (statement: string) => Promise<void> } = {};
    const client: SqliteClient = { ...sql.client, run: async (statement, params) => {
        statements.push(statement); await hooks.beforeRun?.(statement); await sql.client.run(statement, params); await hooks.afterRun?.(statement);
    } };
    const adapter = new NativeReceiptSqliteAdapter(client, { rejectConcurrentWrites: true });
    await adapter.getData(); setStorageAdapter(adapter);
    useTaskStore.setState({ ...oldStore, _allTasks: [], _tasksById: new Map(), tasks: [], settings: {}, persistenceFailure: null,
        editLockCount: 0, lastDataChangeAt: 0, error: null });
    await useTaskStore.getState().fetchData({ recoveryLoad: true, throwOnError: true });
    const initial = prepareNativePomodoroTransition({ request: { action: 'initialize', requestId: ID, observedAtMs: now,
        localDayKey: '2026-10-10', durations: { focusMinutes: 25, breakMinutes: 5 } }, session: { raw: null, state: null }, target: null, deviceId: null })!;
    const state = decodeNativePomodoroSession(initial.sessionAfter);
    state.session.timerState.isRunning = true; state.session.phaseEndsAt = AT; state.session.selectedTaskId = 'task';
    const raw = JSON.stringify(state); await sql.client.run('INSERT INTO native_pomodoro_session (id,state_json) VALUES (1,?)', [raw]);
    const row = (await sql.client.all<Record<string, string | number | null>>('SELECT * FROM tasks WHERE id=?', ['task']))[0];
    const request: NativePomodoroRequest = { ...action, requestId: NEXT, observedAtMs: now, localDayKey: '2026-10-10',
        autoStart: { autoStartFocus: false, autoStartBreaks: false } };
    const plan = prepareNativePomodoroTransition({ request, session: { raw, state },
        target: { id: 'task', row: TASK_SQLITE_COLUMNS.map((name) => row[name]) }, deviceId: 'device' })!;
    const tables = async () => ({ tasks: await sql.client.all<Record<string, unknown>>('SELECT * FROM tasks ORDER BY id'),
        sessions: await sql.client.all('SELECT * FROM native_pomodoro_session'), receipts: await sql.client.all<Record<string, unknown>>('SELECT * FROM native_request_receipts'),
        settings: await sql.client.all('SELECT * FROM settings') });
    statements.length = 0;
    return { sql, client, adapter, plan, hooks, statements, tables };
}
afterEach(() => {
    resetNativeRequestReceipts(); setStorageAdapter(oldAdapter); useTaskStore.setState(oldStore, true);
    for (const item of resources.splice(0).reverse()) { item.close(); rmSync(item.directory, { recursive: true, force: true }); }
});

describe('native Pomodoro actions through the existing atomic SQLite owner', () => {
    it.each([{ action: 'setDurations', durations: { focusMinutes: 50, breakMinutes: 10 } },
        { action: 'selectTask', taskId: 'next-task' }, { action: 'selectTask', taskId: null }] as const)(
        'commits overdue %j with old-task old-duration credit and exact replay without another domain write', async (action) => {
            const env = await open(action); const before = await env.tables();
            const answer = await env.adapter.savePomodoroTransitionWithReceipt(env.plan);
            expect(answer).toEqual({ result: env.plan.result, replayed: false, projectionReloaded: true });
            const after = await env.tables();
            expect(after.tasks.find((row) => row.id === 'task')!.timeSpentMinutes).toBe(29);
            expect(after.tasks.find((row) => row.id === 'next-task')).toEqual(before.tasks.find((row) => row.id === 'next-task'));
            expect(after.sessions).toEqual([{ id: 1, state_json: env.plan.sessionAfter }]);
            expect(after.receipts).toHaveLength(1); expect(after.receipts[0].method).toBe(nativePomodoroReceiptPayload(env.plan));
            expect(after.receipts[0].reply).toBe(JSON.stringify(env.plan.result)); expect(after.settings).toEqual(before.settings);
            expect(env.statements.filter((s) => s === 'BEGIN IMMEDIATE')).toHaveLength(1);
            expect(env.statements.filter((s) => s === 'COMMIT')).toHaveLength(1);
            expect(useTaskStore.getState()._tasksById.get('task')!.timeSpentMinutes).toBe(29);
            env.statements.length = 0;
            expect((await env.adapter.savePomodoroTransitionWithReceipt(env.plan)).replayed).toBe(true);
            expect(await env.tables()).toEqual(after);
            expect(env.statements.some((s) => /^(UPDATE|INSERT)/u.test(s))).toBe(false);
        });
    it.each(['UPDATE tasks', 'UPDATE native_pomodoro_session', 'INSERT INTO native_request_receipts', 'COMMIT'])(
        'rolls action, session and receipt back on %s failure, then exact retry credits only once', async (fault) => {
            const env = await open(); const before = await env.tables(); let failures = 0;
            env.hooks.beforeRun = async (statement) => { if (statement.startsWith(fault) && failures++ === 0) throw new Error('injected action failure'); };
            await expect(env.adapter.savePomodoroTransitionWithReceipt(env.plan)).rejects.toThrow(/Pomodoro/);
            expect(await env.tables()).toEqual(before);
            env.hooks.beforeRun = undefined;
            expect((await env.adapter.savePomodoroTransitionWithReceipt(env.plan)).result.creditedMinutes).toBe(25);
            const after = await env.tables(); expect(after.receipts).toHaveLength(1);
            expect(after.tasks.find((row) => row.id === 'task')!.timeSpentMinutes).toBe(29);
            await env.adapter.savePomodoroTransitionWithReceipt(env.plan); expect(await env.tables()).toEqual(after);
        });
    it('recovers a lost actual COMMIT reply from the cold receipt before checking later session/task state', async () => {
        const env = await open({ action: 'selectTask', taskId: 'next-task' }); let once = true;
        env.hooks.afterRun = async (statement) => { if (statement === 'COMMIT' && once) { once = false; throw new Error('lost action reply'); } };
        await expect(env.adapter.savePomodoroTransitionWithReceipt(env.plan)).rejects.toThrow(/Pomodoro/);
        env.hooks.afterRun = undefined;
        await env.sql.client.run('UPDATE tasks SET timeSpentMinutes=?,title=? WHERE id=?', [99, 'Later durable edit', 'task']);
        await env.sql.client.run('UPDATE native_pomodoro_session SET state_json=? WHERE id=1', ['later session owner']);
        resetNativeRequestReceipts(); await loadNativeRequestReceipts(env.sql.client, { durableCommands: ['pomodoroTransition'] });
        const cold = new NativeReceiptSqliteAdapter(env.client, { rejectConcurrentWrites: true }); setStorageAdapter(cold);
        const before = await env.tables(); env.statements.length = 0;
        expect(await cold.readPomodoroTransitionOutcome(env.plan)).toEqual(env.plan.result);
        expect((await cold.savePomodoroTransitionWithReceipt(env.plan)).replayed).toBe(true);
        expect(await env.tables()).toEqual(before); expect(env.statements.some((s) => /^(UPDATE|INSERT)/u.test(s))).toBe(false);
    });
    it.each(['old-target', 'session'] as const)('refuses changed %s raw baseline without partial credit or receipt', async (target) => {
        const env = await open({ action: 'selectTask', taskId: 'next-task' });
        if (target === 'old-target') await env.sql.client.run('UPDATE tasks SET tags=? WHERE id=?', [' [ ] ', 'task']);
        else await env.sql.client.run('UPDATE native_pomodoro_session SET state_json=? WHERE id=1', [' ' + env.plan.sessionBefore]);
        const before = await env.tables();
        await expect(env.adapter.savePomodoroTransitionWithReceipt(env.plan)).rejects.toThrow(/baseline/);
        expect(await env.tables()).toEqual(before);
    });
    it('permits unrelated cold changes but refuses a second UUID owning the same old completion range', async () => {
        const env = await open();
        await env.sql.client.run('UPDATE tasks SET title=? WHERE id=?', ['Unrelated cold edit', 'next-task']);
        const unrelated = (await env.tables()).tasks.find((row) => row.id === 'next-task');
        await env.adapter.savePomodoroTransitionWithReceipt(env.plan); const before = await env.tables();
        await expect(env.adapter.savePomodoroTransitionWithReceipt({ ...env.plan, request: { ...env.plan.request, requestId: ID } })).rejects.toThrow(/baseline/);
        expect(await env.tables()).toEqual(before); expect(before.tasks.find((row) => row.id === 'next-task')).toEqual(unrelated);
    });
});
