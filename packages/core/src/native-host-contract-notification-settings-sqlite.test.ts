import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createNativeHostContract } from './native-host-contract';
import { readAreaDurableData } from './native-host-contract-area-durable';
import type { NotificationSettingRequest } from './native-host-contract-notification-settings';
import type { NotificationSettingEdit } from './notification-settings-model';
import { NativeReceiptSqliteAdapter, loadNativeRequestReceipts, resetNativeRequestReceipts } from './native-request-receipts';
import { flushPendingSave, getPersistenceStatus, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { SqliteClient } from './sqlite-adapter';
import type { AppData, Task } from './types';

const require = createRequire(import.meta.url);
type Statement = { run: (...params: unknown[]) => unknown; all: (...params: unknown[]) => unknown[];
    get: (...params: unknown[]) => unknown };
type Database = { exec: (sql: string) => void; prepare: (sql: string) => Statement; close: () => void };
const DatabaseSync = (require('node:sqlite') as { DatabaseSync: new (path: string) => Database }).DatabaseSync;
const clientOf = (db: Database, fault: { commits: number; failedCommits: number }): SqliteClient => ({
    run: async (sql, params = []) => {
        if (sql === 'COMMIT' && fault.commits > 0) {
            fault.commits -= 1; fault.failedCommits += 1; throw new Error('injected notification commit failure');
        }
        db.prepare(sql).run(...params);
    },
    all: async <T,>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params) as T[],
    get: async <T,>(sql: string, params: unknown[] = []) => db.prepare(sql).get(...params) as T | undefined,
    exec: async (sql) => { db.exec(sql); },
});
const ID = '00000000-0000-4000-8000-000000000442';
const AT = '2026-09-01T00:00:00.000Z';
const task: Task = { id: 'raw', title: 'Raw', status: 'done', tags: ['keep'], contexts: ['@raw'],
    focusOrder: 9, deletedAt: AT, createdAt: AT, updatedAt: AT, rev: 7 };
const initial = (): AppData => ({ tasks: [task], projects: [], sections: [], areas: [], people: [],
    settings: { deviceId: 'device', notificationsEnabled: true, weeklyReviewDay: { z: false, a: ['old'] },
        dailyDigestEveningTime: { malformed: 'keep' }, reviewAtNotificationsEnabled: true,
        undoNotificationsEnabled: false, syncPreferencesUpdatedAt: { language: AT } } as unknown as AppData['settings'] });

const tempRoot = join(process.cwd(), '../../.orchestrator/tmp');
mkdirSync(tempRoot, { recursive: true });
const directories: string[] = [], databases: Database[] = [];
afterEach(async () => {
    await flushPendingSave(); resetForTests(); resetNativeRequestReceipts();
    for (const db of databases.splice(0)) db.close();
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const newPath = () => {
    const dir = mkdtempSync(join(tempRoot, 'notification-setting-')); directories.push(dir);
    return join(dir, 'library.db');
};
const close = (db: Database) => { db.close(); databases.splice(databases.indexOf(db), 1); };
async function open(path: string, seed = false) {
    await flushPendingSave(); resetForTests(); resetNativeRequestReceipts();
    const db = new DatabaseSync(path); databases.push(db);
    const fault = { commits: 0, failedCommits: 0 }, client = clientOf(db, fault);
    if (seed) await new NativeReceiptSqliteAdapter(client).saveData(initial());
    const adapter = new NativeReceiptSqliteAdapter(client, { rejectConcurrentWrites: true });
    await loadNativeRequestReceipts(client, { durableCommands: ['notificationSetting'] });
    setStorageAdapter(adapter);
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true }); await flushPendingSave();
    const host = createNativeHostContract();
    expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
    await flushPendingSave();
    if (seed) {
        // Actual opaque SQLite spellings must survive a notification-only save, including load-normalized values.
        db.prepare('UPDATE tasks SET contexts = ?, tags = ?, focusOrder = ? WHERE id = ?')
            .run('[ "@raw" ]', '[ "keep" ]', 9, 'raw');
    }
    return { db, adapter, host, fault };
}
async function plan(env: Awaited<ReturnType<typeof open>>, edit: NotificationSettingEdit) {
    const options = await env.host.getNotificationSettingsOptions({});
    if (!options.ok) throw new Error(JSON.stringify(options));
    const request: NotificationSettingRequest = { requestId: ID, edit, expected: options.value.expected[edit.type] };
    const prepared = await env.host.prepareNotificationSetting(request);
    if (!prepared.ok || prepared.value.kind !== 'prepared') throw new Error(JSON.stringify(prepared));
    return { request, envelope: { request, prepared: prepared.value.prepared } };
}
const taskRow = (db: Database) => db.prepare('SELECT * FROM tasks WHERE id = ?').get('raw');
const settingsRow = (db: Database) => db.prepare('SELECT * FROM settings').all();
const receiptRows = (db: Database) => db.prepare('SELECT * FROM native_request_receipts').all();

describe('notification Settings SQLite receipts', () => {
    it('refuses a foreign failure arriving during its held durable read before any live write, enqueue or save', async () => {
        const env = await open(newPath(), true);
        const { envelope } = await plan(env, { type: 'notificationsEnabled', value: false });
        const beforeTask = taskRow(env.db), beforeSettings = settingsRow(env.db);
        const beforeLive = useTaskStore.getState().settings, beforeStatus = getPersistenceStatus();
        const saved = vi.spyOn(env.adapter, 'saveData');
        const getData = env.adapter.getData.bind(env.adapter);
        let entered!: () => void, release!: () => void, heldReads = 0;
        const readEntered = new Promise<void>((resolve) => { entered = resolve; });
        const gate = new Promise<void>((resolve) => { release = resolve; });
        env.adapter.getData = async (options) => {
            heldReads += 1; entered(); await gate; return getData(options);
        };
        const committing = env.host.commitPreparedNotificationSetting(envelope);
        await readEntered;
        const foreign = { message: 'foreign during read', failedAt: AT, retrying: false };
        useTaskStore.setState({ persistenceFailure: foreign }); release();
        const result = await committing;
        env.adapter.getData = getData;
        expect(heldReads).toBe(1);
        expect(result).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        expect(useTaskStore.getState().persistenceFailure).toBe(foreign);
        expect(useTaskStore.getState().settings).toBe(beforeLive);
        expect(getPersistenceStatus()).toEqual({ ...beforeStatus, failed: true });
        expect(saved).not.toHaveBeenCalled();
        expect(settingsRow(env.db)).toEqual(beforeSettings); expect(taskRow(env.db)).toEqual(beforeTask);
        expect(receiptRows(env.db)).toEqual([]);
    });

    it('synchronously refuses a foreign failure at the store action admission boundary', async () => {
        const env = await open(newPath(), true);
        const { request } = await plan(env, { type: 'notificationsEnabled', value: false });
        const read = await readAreaDurableData(false, true);
        if (!read.ok) throw new Error(JSON.stringify(read));
        const beforeTask = taskRow(env.db), beforeSettings = settingsRow(env.db);
        const beforeLive = useTaskStore.getState().settings, beforeStatus = getPersistenceStatus();
        const foreign = { message: 'foreign at admission', failedAt: AT, retrying: false };
        useTaskStore.setState({ persistenceFailure: foreign });
        const saved = vi.spyOn(env.adapter, 'saveData');
        expect(await useTaskStore.getState().commitPreparedNotificationSetting(request, read.value.authority))
            .toMatchObject({ success: false });
        expect(useTaskStore.getState().persistenceFailure).toBe(foreign);
        expect(useTaskStore.getState().settings).toBe(beforeLive);
        expect(getPersistenceStatus()).toEqual({ ...beforeStatus, failed: true });
        expect(saved).not.toHaveBeenCalled();
        expect(settingsRow(env.db)).toEqual(beforeSettings); expect(taskRow(env.db)).toEqual(beforeTask);
        expect(receiptRows(env.db)).toEqual([]);
    });

    it('retries its exact failed raw save and atomically records one UUID without normalizing unrelated rows', async () => {
        const env = await open(newPath(), true);
        const beforeTask = taskRow(env.db), beforeSettings = settingsRow(env.db);
        const savedSettings = (await env.adapter.getData()).settings;
        const { request, envelope } = await plan(env, { type: 'notificationsEnabled', value: false });
        env.fault.commits = 10;
        expect(await env.host.commitPreparedNotificationSetting(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(env.fault.failedCommits).toBeGreaterThan(0);
        expect(receiptRows(env.db)).toEqual([]);
        expect(settingsRow(env.db)).toEqual(beforeSettings);
        expect(taskRow(env.db)).toEqual(beforeTask);
        env.fault.commits = 0;
        const reply = { ok: true, value: { type: request.edit.type, value: false, changed: true } };
        expect(await env.host.commitPreparedNotificationSetting(envelope)).toEqual(reply);
        expect(receiptRows(env.db)).toHaveLength(1);
        expect(taskRow(env.db)).toEqual(beforeTask);
        expect((await env.adapter.getData()).settings).toEqual({ ...savedSettings, notificationsEnabled: false });
        expect(await env.host.commitPreparedNotificationSetting(envelope)).toEqual(reply);
        expect(receiptRows(env.db)).toHaveLength(1);
    });

    it('replays its committed UUID after process death and later choices, including reordered malformed witnesses', async () => {
        const path = newPath(), env = await open(path, true);
        const beforeTask = taskRow(env.db);
        const { request, envelope } = await plan(env, { type: 'weeklyReviewDay', value: 0 });
        const reply = { ok: true, value: { type: 'weeklyReviewDay', value: 0, changed: true } };
        expect(await env.host.commitPreparedNotificationSetting(envelope)).toEqual(reply);
        expect(taskRow(env.db)).toEqual(beforeTask);
        const receipt = receiptRows(env.db);
        expect(receipt).toMatchObject([{ method: expect.stringMatching(/^notificationSetting:[0-9a-f]{32}$/),
            reply: JSON.stringify(reply.value) }]);
        const changed = await env.adapter.getData();
        changed.settings.weeklyReviewDay = 5; changed.settings.dailyDigestEveningTime = '21:33';
        await env.adapter.saveData(changed);
        close(env.db);
        const cold = await open(path);
        const beforeReplayTask = taskRow(cold.db), beforeReplaySettings = settingsRow(cold.db);
        const reordered = { ...request, expected: { present: true, value: { z: false, a: ['old'] } } };
        expect(cold.host.probeNotificationSettingOutcome(reordered)).toEqual(reply);
        expect(await cold.host.commitPreparedNotificationSetting({ request: reordered,
            prepared: { version: 1, request: reordered } })).toEqual(reply);
        expect(settingsRow(cold.db)).toEqual(beforeReplaySettings);
        expect(taskRow(cold.db)).toEqual(beforeReplayTask);
        expect(receiptRows(cold.db)).toEqual(receipt);
        expect((await cold.adapter.getData()).settings.weeklyReviewDay).toBe(5);
    });

    it('refuses cold receipt-less journals before Commit, after target equality and after ABA without writes', async () => {
        const path = newPath(), env = await open(path, true);
        const { request, envelope } = await plan(env, { type: 'notificationsEnabled', value: false });
        close(env.db);
        const cold = await open(path);
        for (const value of [true, false, true]) {
            const changed = await cold.adapter.getData(); changed.settings.notificationsEnabled = value;
            await cold.adapter.saveData(changed);
            const beforeTask = taskRow(cold.db), beforeSettings = settingsRow(cold.db);
            expect(cold.host.validatePreparedNotificationSetting(envelope)).toMatchObject({ ok: true });
            expect(cold.host.probeNotificationSettingOutcome(request)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await cold.host.commitPreparedNotificationSetting(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(settingsRow(cold.db)).toEqual(beforeSettings);
            expect(taskRow(cold.db)).toEqual(beforeTask);
            expect(receiptRows(cold.db)).toEqual([]);
        }
    });

    it('refuses a stale selected saved witness without a receipt or opaque-row changes', async () => {
        const env = await open(newPath(), true);
        const { envelope } = await plan(env, { type: 'weeklyReviewDay', value: 0 });
        const changed = await env.adapter.getData(); changed.settings.weeklyReviewDay = 4;
        await env.adapter.saveData(changed);
        const beforeTask = taskRow(env.db), beforeSettings = settingsRow(env.db);
        expect(await env.host.commitPreparedNotificationSetting(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(settingsRow(env.db)).toEqual(beforeSettings);
        expect(taskRow(env.db)).toEqual(beforeTask);
        expect(receiptRows(env.db)).toEqual([]);
    });

    it('refuses a foreign failure substituted after its actual failed save without clearing or retrying it', async () => {
        const env = await open(newPath(), true);
        const { envelope } = await plan(env, { type: 'notificationsEnabled', value: false });
        env.fault.commits = 10;
        expect(await env.host.commitPreparedNotificationSetting(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(env.fault.failedCommits).toBeGreaterThan(0);
        const ownFailure = useTaskStore.getState().persistenceFailure;
        expect(ownFailure).not.toBeNull();
        const foreign = { message: 'foreign', failedAt: AT, retrying: false };
        useTaskStore.setState({ persistenceFailure: foreign }); env.fault.commits = 0;
        const beforeTask = taskRow(env.db), beforeSettings = settingsRow(env.db), failures = env.fault.failedCommits;
        expect(await env.host.commitPreparedNotificationSetting(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(useTaskStore.getState().persistenceFailure).toBe(foreign);
        expect(env.fault.failedCommits).toBe(failures);
        expect(settingsRow(env.db)).toEqual(beforeSettings); expect(taskRow(env.db)).toEqual(beforeTask);
        expect(receiptRows(env.db)).toEqual([]);
        // Only the original retained failure authorizes this exact raw snapshot retry.
        useTaskStore.setState({ persistenceFailure: ownFailure });
        expect(await env.host.commitPreparedNotificationSetting(envelope)).toMatchObject({ ok: true });
    });
});
