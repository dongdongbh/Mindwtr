import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serializeBackupData } from './backup-transfer';
import { applySiriReminderAction, getSiriReminderItem, type SiriReminderAction } from './siri-reminder-actions';
import { SqliteAdapter, type SqliteClient } from './sqlite-adapter';
import { resetForTests, setStorageAdapter, useTaskStore } from './store';
import { sanitizeAppDataForRemote } from './sync-helpers';
import type { AppData, Task } from './types';

const createId = '00000000-0000-4000-8000-000000000001';
const updateId = '00000000-0000-4000-8000-000000000002';
const taskId = '00000000-0000-4000-8000-000000000003';
const siblingId = '00000000-0000-4000-8000-000000000004';
const dueDate = '2030-02-28';
const at = '2026-01-01T00:00:00.000Z';
const allow = () => true;
const timing = (id: string, now = Date.now()) => ({ id, createdAt: now, expiresAt: now + 120_000 });
const create = (id = createId): SiriReminderAction => ({ operation: 'create', ...timing(id), title: ' Call Lee ', dueDate });
const task = (id = taskId): Task => ({ id, title: 'Call Lee', status: 'inbox', tags: [], contexts: [], createdAt: at, updatedAt: at, rev: 1 });
const snapshot = (tasks: Task[]): AppData => ({ tasks, projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'device' } });
const clientOf = (db: DatabaseSync): SqliteClient => ({
    exec: async (sql) => { db.exec(sql); },
    run: async (sql, params = []) => { db.prepare(sql).run(...params as SQLInputValue[]); },
    all: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params as SQLInputValue[]) as T[],
    get: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).get(...params as SQLInputValue[]) as T | undefined,
});

describe('durable Siri reminders', () => {
    let db: DatabaseSync;
    let client: SqliteClient;
    let adapter: SqliteAdapter;

    const restart = () => {
        resetForTests();
        adapter = new SqliteAdapter(client);
        setStorageAdapter(adapter);
        useTaskStore.setState({ _allTasks: [], settings: {} });
    };

    beforeEach(async () => {
        db = new DatabaseSync(':memory:');
        client = clientOf(db);
        restart();
        await adapter.saveData(snapshot([]));
    });

    afterEach(() => {
        resetForTests();
        db.close();
    });

    it('persists one Inbox task before returning and replays after restart and deletion', async () => {
        const request = create();
        const result = await applySiriReminderAction(request, allow, [request.id]);
        expect(result).toMatchObject({ outcome: 'persisted', task: { id: createId, title: 'Call Lee', dueDate } });
        const stored = await adapter.getData();
        expect(stored.tasks).toEqual([expect.objectContaining({ id: createId, title: 'Call Lee', status: 'inbox', dueDate, rev: 1, revBy: 'device' })]);
        expect(useTaskStore.getState().tasks.map((item) => item.id)).toEqual([createId]);
        db.prepare('UPDATE tasks SET deletedAt = ?, rev = rev + 1 WHERE id = ?').run(at, createId);
        restart();
        expect(await applySiriReminderAction(request, allow, [request.id])).toEqual(result);
        expect((await adapter.getData()).tasks).toEqual([expect.objectContaining({ id: createId, deletedAt: at, rev: 2 })]);
        expect(await applySiriReminderAction({ ...request, dueDate: '2030-02-27' }, allow)).toEqual({ outcome: 'rejected', reason: 'invalid' });
        expect(serializeBackupData(stored)).not.toContain('fingerprint');
        expect(JSON.stringify(sanitizeAppDataForRemote(stored))).not.toContain('fingerprint');
    });

    it('sets and clears the exact task due date and rejects a stale revision', async () => {
        const original = task();
        await adapter.saveData(snapshot([original, task(siblingId)]));
        const token = getSiriReminderItem(original)?.token ?? '';
        const request: SiriReminderAction = { operation: 'update', ...timing(updateId), targetId: taskId, expectedToken: token, dueDate };
        const result = await applySiriReminderAction(request, allow);
        expect(result).toMatchObject({ outcome: 'persisted', task: { id: taskId, dueDate } });
        const applied = await adapter.getData();
        const updated = applied.tasks.find((item) => item.id === taskId);
        expect(updated).toMatchObject({ id: taskId, dueDate, rev: 2 });
        expect(applied.tasks.find((item) => item.id === siblingId)).toMatchObject({ id: siblingId, rev: 1 });
        expect(applied.tasks.find((item) => item.id === siblingId)?.dueDate).toBeUndefined();

        const clear = { ...request, ...timing(createId), dueDate: null };
        expect(await applySiriReminderAction(clear, allow)).toEqual({ outcome: 'rejected', reason: 'stale' });
        expect(updated).toBeDefined();
        if (!updated) throw new Error('Missing updated task');
        await expect(applySiriReminderAction({ ...clear, expectedToken: getSiriReminderItem(updated)?.token ?? '' }, allow))
            .resolves.toMatchObject({ outcome: 'persisted', task: { id: taskId } });
        restart();
        expect(await applySiriReminderAction(request, allow)).toEqual(result);
        const saved = (await adapter.getData()).tasks.find((item) => item.id === taskId);
        expect(saved).toMatchObject({ rev: 3 });
        expect(saved?.dueDate).toBeUndefined();
    });

    it('rolls back a task when its same-transaction receipt fails and retries the original command', async () => {
        let deny = true;
        const run = client.run;
        client.run = async (sql, params) => {
            if (deny && sql.startsWith('INSERT INTO siri_reminder_receipts')) throw new Error('Receipt write failed');
            await run(sql, params);
        };
        const request = create();
        await expect(applySiriReminderAction(request, allow)).rejects.toThrow('Receipt write failed');
        expect((await adapter.getData()).tasks).toEqual([]);
        expect(await adapter.getSiriReminderReceipt(createId)).toBeNull();
        expect(useTaskStore.getState().tasks).toEqual([]);
        deny = false;
        await expect(applySiriReminderAction(request, allow)).resolves.toMatchObject({ outcome: 'persisted' });
    });

    it('rolls back if App Lock closes before COMMIT', async () => {
        let unlocked = true;
        const run = client.run;
        client.run = async (sql, params) => {
            await run(sql, params);
            if (sql.startsWith('INSERT INTO siri_reminder_receipts')) unlocked = false;
        };
        await expect(applySiriReminderAction(create(), () => unlocked)).rejects.toThrow('workspace is unavailable');
        expect((await adapter.getData()).tasks).toEqual([]);
        expect(await adapter.getSiriReminderReceipt(createId)).toBeNull();
    });

    it('keeps a committed receipt for an outstanding claim and refuses expired commands without one', async () => {
        const request = create();
        const result = await applySiriReminderAction(request, allow, [request.id]);
        db.prepare('UPDATE siri_reminder_receipts SET saved_at = 0').run();
        await applySiriReminderAction(create(updateId), allow, [request.id, updateId]);
        expect(await applySiriReminderAction(request, allow, [request.id])).toEqual(result);
        expect(await applySiriReminderAction({ ...create(siblingId), ...timing(siblingId, Date.now() - 120_001) }, allow))
            .toEqual({ outcome: 'rejected', reason: 'expired' });
        expect((await adapter.getData()).tasks).toHaveLength(2);
    });

    it('replays a committed request from another access session and cancels an uncommitted request', async () => {
        const committed = create();
        const result = await applySiriReminderAction(committed, allow);
        expect(result.outcome).toBe('persisted');
        const prior = await adapter.getData();
        restart();
        const pending = create(updateId);
        const claims = [committed.id, pending.id];
        expect(await applySiriReminderAction(committed, allow, claims, { replayOnly: true })).toEqual(result);
        expect(await applySiriReminderAction(pending, allow, claims, { replayOnly: true }))
            .toEqual({ outcome: 'rejected', reason: 'cancelled' });
        expect(await adapter.getData()).toEqual(prior);
        expect(await adapter.getSiriReminderReceipt(pending.id)).toBeNull();
    });

    it('keeps non-Inbox tasks out of the snapshot and rejects an ineligible exact target', async () => {
        const original = { ...task(), recurrence: 'daily' as const };
        await adapter.saveData(snapshot([original]));
        expect(getSiriReminderItem(original)).toBeNull();
        expect(getSiriReminderItem({ ...task(), projectId: siblingId })).toBeNull();
        expect(getSiriReminderItem({ ...task(), status: 'reference' })).toBeNull();
        expect(await applySiriReminderAction({ operation: 'update', ...timing(updateId), targetId: taskId,
            expectedToken: '1::' + at, dueDate }, allow)).toEqual({ outcome: 'rejected', reason: 'stale' });
        expect((await adapter.getData()).tasks[0].dueDate).toBeUndefined();
    });
});
