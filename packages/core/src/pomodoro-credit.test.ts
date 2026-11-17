import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acknowledgePomodoroCredits, applyPomodoroCredit, POMODORO_CREDIT_RECEIPT_LIMIT } from './pomodoro-credit';
import { SqliteAdapter, type SqliteClient } from './sqlite-adapter';
import { resetForTests, setStorageAdapter, useTaskStore } from './store';
import { prepareRestoredBackupDataForSync, serializeBackupData } from './backup-transfer';
import { sanitizeAppDataForRemote } from './sync-helpers';
import { StorageConflictError } from './storage';
import { mergeSettingsForSync } from './sync-merge-settings';
import { assertNativeLegacyBackupSafe, mergeLegacyJsonCopy } from './legacy-json-import';
import type { AppData } from './types';

const credit = { id: '00000000-0000-4000-8000-000000000001', taskId: 'task', minutes: 3 };
const initial = (): AppData => ({ tasks: [{ id: 'task', title: 'Task', status: 'next', tags: [], contexts: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', rev: 1, timeSpentMinutes: 5 }],
projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'device' } });

const clientOf = (database: DatabaseSync): SqliteClient => ({
    exec: async (sql) => { database.exec(sql); },
    run: async (sql, params = []) => { database.prepare(sql).run(...params as never[]); },
    all: async <T>(sql: string, params: unknown[] = []) => database.prepare(sql).all(...params as never[]) as T[],
    get: async <T>(sql: string, params: unknown[] = []) => database.prepare(sql).get(...params as never[]) as T | undefined,
});

describe('durable Pomodoro work credits', () => {
    let directory: string;
    let database: DatabaseSync;
    let external: DatabaseSync;
    let adapter: SqliteAdapter;

    beforeEach(async () => {
        resetForTests();
        directory = mkdtempSync(join(homedir(), 'mindwtr-credit-test-'));
        const path = join(directory, 'data.sqlite');
        database = new DatabaseSync(path);
        external = new DatabaseSync(path);
        adapter = new SqliteAdapter(clientOf(database));
        await adapter.saveData(initial());
        setStorageAdapter(adapter);
        useTaskStore.setState({ _allTasks: initial().tasks, settings: initial().settings });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        resetForTests();
        database.close();
        external.close();
        rmSync(directory, { recursive: true, force: true });
    });

    it('replays after restart and a later manual edit without adding the credit again', async () => {
        expect(await applyPomodoroCredit(credit)).toBe('applied');
        expect((await adapter.getData()).tasks[0].timeSpentMinutes).toBe(8);
        external.exec('UPDATE tasks SET timeSpentMinutes=42, rev=rev+1');
        resetForTests();
        adapter = new SqliteAdapter(clientOf(database));
        setStorageAdapter(adapter);
        expect(await applyPomodoroCredit(credit)).toBe('already-applied');
        expect(useTaskStore.getState().tasks[0].timeSpentMinutes).toBe(42);
        expect((await adapter.getData()).tasks[0].timeSpentMinutes).toBe(42);
    });

    it.each([
        ['archived', { status: 'archived' }, 'applied', 8],
        ['soft-deleted', { deletedAt: '2026-01-02T00:00:00.000Z' }, 'applied', 8],
        ['purged', { deletedAt: '2026-01-02T00:00:00.000Z', purgedAt: '2026-01-03T00:00:00.000Z' }, 'missing-task', 5],
    ] as const)('credits work to a %s task unless it is purged', async (_kind, changes, outcome, minutes) => {
        const data = initial(); data.tasks[0] = { ...data.tasks[0], ...changes };
        await adapter.saveData(data); useTaskStore.setState({ _allTasks: data.tasks });
        expect(await applyPomodoroCredit(credit)).toBe(outcome);
        expect((await adapter.getData()).tasks.find((task) => task.id === 'task')?.timeSpentMinutes).toBe(minutes);
    });

    it('rolls back the task when the receipt write fails and retries exactly once later', async () => {
        database.exec("CREATE TRIGGER reject_receipt BEFORE UPDATE ON settings BEGIN SELECT RAISE(FAIL, 'receipt write failed'); END;");
        await expect(applyPomodoroCredit(credit)).rejects.toThrow('receipt write failed');
        expect((await adapter.getData()).tasks[0].timeSpentMinutes).toBe(5);
        expect((await adapter.getData()).settings.pomodoroCredits).toBeUndefined();
        database.exec('DROP TRIGGER reject_receipt');
        expect(await applyPomodoroCredit(credit)).toBe('applied');
        expect((await adapter.getData()).tasks[0].timeSpentMinutes).toBe(8);
    });

    it('replans on the authoritative manual time when another SQLite connection edits before the commit', async () => {
        const conditionalSave = adapter.saveDataIfUnchanged.bind(adapter);
        let moved = false;
        vi.spyOn(adapter, 'saveDataIfUnchanged').mockImplementation(async (data, expected) => {
            if (!moved) {
                moved = true;
                external.exec('UPDATE tasks SET timeSpentMinutes=40, rev=rev+1');
            }
            await conditionalSave(data, expected);
        });
        expect(await applyPomodoroCredit(credit)).toBe('applied');
        expect((await adapter.getData()).tasks[0].timeSpentMinutes).toBe(43);
        expect(adapter.saveDataIfUnchanged).toHaveBeenCalledTimes(2);
    });

    it('rejects a write when an external edit lands between the CAS read and BEGIN', async () => {
        const before = await adapter.getData();
        const next = { ...before, settings: { ...before.settings, pomodoroCredits: { [credit.id]: { taskId: credit.taskId, minutes: credit.minutes } } } };
        const run = clientOf(database).run;
        const client = clientOf(database);
        client.run = async (sql, params) => {
            if (sql === 'BEGIN IMMEDIATE') external.exec('UPDATE tasks SET timeSpentMinutes=40, rev=rev+1');
            return run(sql, params);
        };
        const concurrentAdapter = new SqliteAdapter(client);
        await expect(concurrentAdapter.saveDataIfUnchanged(next, before)).rejects.toBeInstanceOf(StorageConflictError);
        expect((await adapter.getData()).settings.pomodoroCredits).toBeUndefined();
        expect((await adapter.getData()).tasks[0].timeSpentMinutes).toBe(40);
    });

    it('queues an in-app manual edit behind credit publication', async () => {
        const conditionalSave = adapter.saveDataIfUnchanged.bind(adapter);
        let entered!: () => void;
        const ready = new Promise<void>((resolve) => { entered = resolve; });
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        vi.spyOn(adapter, 'saveDataIfUnchanged').mockImplementationOnce(async (data, expected) => {
            entered();
            await held;
            await conditionalSave(data, expected);
        });
        const applied = applyPomodoroCredit(credit);
        await ready;
        const manual = useTaskStore.getState().updateTask('task', { timeSpentMinutes: 23 });
        expect(useTaskStore.getState().tasks[0].timeSpentMinutes).toBe(5);
        release();
        await applied;
        await manual;
        expect(useTaskStore.getState().tasks[0].timeSpentMinutes).toBe(23);
    });

    it('rejects reused identities with changed payload even after a task disappears', async () => {
        await applyPomodoroCredit(credit);
        external.exec("DELETE FROM tasks WHERE id='task'");
        await expect(applyPomodoroCredit({ ...credit, minutes: 4 })).rejects.toThrow('identity changed');
        expect(await applyPomodoroCredit(credit)).toBe('already-applied');
    });

    it('keeps pending receipts at capacity and frees only acknowledged identities', async () => {
        const receipts = Object.fromEntries(Array.from({ length: POMODORO_CREDIT_RECEIPT_LIMIT }, (_, index) => [
            `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`, { taskId: 'task', minutes: 1 },
        ]));
        const before = await adapter.getData();
        await adapter.saveData({ ...before, settings: { ...before.settings, pomodoroCredits: receipts } });
        await expect(applyPomodoroCredit(credit)).rejects.toThrow('capacity');
        expect((await adapter.getData()).tasks[0].timeSpentMinutes).toBe(5);
        await acknowledgePomodoroCredits(Object.keys(receipts).slice(0, 1));
        expect(Object.keys((await adapter.getData()).settings.pomodoroCredits!)).toHaveLength(POMODORO_CREDIT_RECEIPT_LIMIT - 1);
        expect(await applyPomodoroCredit(credit)).toBe('applied');
    });

    it('does not include device receipts in sync or exported backups', async () => {
        await applyPomodoroCredit(credit);
        const data = await adapter.getData();
        expect(data.settings.pomodoroCredits).toEqual({ [credit.id]: { taskId: 'task', minutes: 3 } });
        expect(sanitizeAppDataForRemote(data).settings.pomodoroCredits).toBeUndefined();
        expect(JSON.parse(serializeBackupData(data)).settings.pomodoroCredits).toBeUndefined();
        expect(mergeSettingsForSync({}, data.settings).pomodoroCredits).toBeUndefined();
        expect(prepareRestoredBackupDataForSync(data).settings.pomodoroCredits).toBeUndefined();
        expect(prepareRestoredBackupDataForSync(initial(), { previousData: data }).settings.pomodoroCredits)
            .toEqual(data.settings.pomodoroCredits);
        await acknowledgePomodoroCredits([credit.id]);
        expect((await adapter.getData()).settings.pomodoroCredits).toBeUndefined();
        expect((await adapter.getData()).tasks[0].timeSpentMinutes).toBe(8);
    });

    it('replays once after recovering a JSON fallback task and its local receipt into SQLite', async () => {
        const before = await adapter.getData();
        const copy: AppData = { ...before, tasks: [{ ...before.tasks[0], timeSpentMinutes: 8, rev: 2,
            updatedAt: '2026-11-16T00:00:00.000Z' }], settings: { ...before.settings,
            pomodoroCredits: { [credit.id]: { taskId: 'task', minutes: 3 } } } };
        expect(() => assertNativeLegacyBackupSafe({ jsonAhead: true, backupJson: JSON.stringify(copy) })).not.toThrow();
        const merged = mergeLegacyJsonCopy(before, JSON.parse(JSON.stringify(copy)), 'json-ahead').data;
        await adapter.saveData(merged);
        resetForTests();
        adapter = new SqliteAdapter(clientOf(database));
        setStorageAdapter(adapter);
        expect(await applyPomodoroCredit(credit)).toBe('already-applied');
        expect((await adapter.getData()).tasks[0].timeSpentMinutes).toBe(8);
    });

    it('retains the SQLite credit proof when a stale JSON copy is recovered after its SQL commit', async () => {
        const staleCopy = await adapter.getData();
        await applyPomodoroCredit(credit);
        const canonical = await adapter.getData();
        const merged = mergeLegacyJsonCopy(canonical, staleCopy, 'json-ahead').data;
        await adapter.saveData(merged);
        expect(await applyPomodoroCredit(credit)).toBe('already-applied');
        expect((await adapter.getData()).tasks[0].timeSpentMinutes).toBe(8);
    });

    it('refuses conflicting receipt identities between local recovery copies', async () => {
        await applyPomodoroCredit(credit);
        const canonical = await adapter.getData();
        const copy = { ...canonical, settings: { ...canonical.settings,
            pomodoroCredits: { [credit.id]: { taskId: 'task', minutes: 4 } } } };
        expect(() => mergeLegacyJsonCopy(canonical, copy, 'json-ahead')).toThrow('identity changed');
        expect((await adapter.getData()).tasks[0].timeSpentMinutes).toBe(8);
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 100_001])('rejects invalid minutes %s before writing', async (minutes) => {
        await expect(applyPomodoroCredit({ ...credit, minutes })).rejects.toThrow('Invalid Pomodoro');
        expect((await adapter.getData()).tasks[0].timeSpentMinutes).toBe(5);
    });
});
