import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createNativeHostContract } from './native-host-contract';
import type { AppLockRequest } from './native-host-contract-app-lock';
import { NativeReceiptSqliteAdapter, loadNativeRequestReceipts, resetNativeRequestReceipts } from './native-request-receipts';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { SqliteClient } from './sqlite-adapter';
import type { AppData, Task } from './types';

const require = createRequire(import.meta.url);
type Statement = { run: (...params: unknown[]) => unknown; all: (...params: unknown[]) => unknown[];
    get: (...params: unknown[]) => unknown };
type Database = { exec: (sql: string) => void; prepare: (sql: string) => Statement; close: () => void };
const DatabaseSync = (require('node:sqlite') as { DatabaseSync: new (path: string) => Database }).DatabaseSync;
const clientOf = (db: Database, fault: { commits: number }): SqliteClient => ({
    run: async (sql, params = []) => {
        if (sql === 'COMMIT' && fault.commits > 0) { fault.commits -= 1; throw new Error('injected commit failure'); }
        db.prepare(sql).run(...params);
    },
    all: async <T,>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params) as T[],
    get: async <T,>(sql: string, params: unknown[] = []) => db.prepare(sql).get(...params) as T | undefined,
    exec: async (sql) => { db.exec(sql); },
});
const ID = '00000000-0000-4000-8000-000000000102';
const AT = '2026-09-01T00:00:00.000Z';
const task: Task = { id: 'raw', title: 'Raw', status: 'done', tags: [], contexts: [],
    focusOrder: 9, deletedAt: AT, createdAt: AT, updatedAt: AT, rev: 7 };
const initial = (): AppData => ({ tasks: [task], projects: [], sections: [], areas: [], people: [],
    settings: { deviceId: 'device', security: { sibling: 'keep' }, syncPreferencesUpdatedAt: { language: AT } } as AppData['settings'] });

const tempRoot = join(process.cwd(), '../../.orchestrator/tmp');
mkdirSync(tempRoot, { recursive: true });
const directories: string[] = [];
const databases: Database[] = [];
afterEach(async () => {
    await flushPendingSave(); resetForTests(); resetNativeRequestReceipts();
    for (const db of databases.splice(0)) db.close();
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function open(path: string, seed = false) {
    await flushPendingSave(); resetForTests(); resetNativeRequestReceipts();
    const db = new DatabaseSync(path); databases.push(db);
    const fault = { commits: 0 };
    const client = clientOf(db, fault);
    if (seed) await new NativeReceiptSqliteAdapter(client).saveData(initial());
    const adapter = new NativeReceiptSqliteAdapter(client, { rejectConcurrentWrites: true });
    await loadNativeRequestReceipts(client, { durableCommands: ['appLock'] });
    setStorageAdapter(adapter);
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    const host = createNativeHostContract();
    expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
    await flushPendingSave();
    return { db, client, adapter, host, fault };
}

describe('App lock SQLite receipt', () => {
    it('requeues the exact raw overlay after a same-host failed save and then commits its receipt', async () => {
        const dir = mkdtempSync(join(tempRoot, 'app-lock-')); directories.push(dir);
        const path = join(dir, 'library.db');
        const first = await open(path, true);
        const beforeTask = first.db.prepare('SELECT * FROM tasks WHERE id = ?').get('raw');
        const options = await first.host.getAppLockOptions({});
        if (!options.ok) throw new Error(JSON.stringify(options));
        const request: AppLockRequest = { requestId: ID, value: true, expected: options.value.expected };
        const plan = await first.host.prepareAppLock(request);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        const envelope = { request, prepared: plan.value.prepared };
        first.fault.commits = 10;
        expect(await first.host.commitPreparedAppLock(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(first.db.prepare('SELECT COUNT(*) AS n FROM native_request_receipts').get()).toMatchObject({ n: 0 });
        first.fault.commits = 0;
        expect(await first.host.commitPreparedAppLock(envelope)).toEqual({ ok: true, value: { changed: true, value: true } });
        expect(first.db.prepare('SELECT * FROM tasks WHERE id = ?').get('raw')).toEqual(beforeTask);
        expect((await first.adapter.getData()).settings.security).toEqual({ sibling: 'keep', mobileAppLockEnabled: true });
        expect(first.db.prepare('SELECT COUNT(*) AS n FROM native_request_receipts').get()).toMatchObject({ n: 1 });
    });

    it('keeps the exact UUID reply after process death and intervening local changes', async () => {
        const dir = mkdtempSync(join(tempRoot, 'app-lock-')); directories.push(dir);
        const path = join(dir, 'library.db');
        const first = await open(path, true);
        const beforeTask = first.db.prepare('SELECT * FROM tasks WHERE id = ?').get('raw');
        const options = await first.host.getAppLockOptions({});
        if (!options.ok) throw new Error(JSON.stringify(options));
        const request: AppLockRequest = { requestId: ID, value: true, expected: options.value.expected };
        const plan = await first.host.prepareAppLock(request);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        const envelope = { request, prepared: plan.value.prepared };
        expect(await first.host.commitPreparedAppLock(envelope)).toEqual({ ok: true, value: { changed: true, value: true } });
        expect(first.db.prepare('SELECT * FROM tasks WHERE id = ?').get('raw')).toEqual(beforeTask);
        expect((await first.adapter.getData()).settings.security).toEqual({ sibling: 'keep', mobileAppLockEnabled: true });
        const receipt = first.db.prepare('SELECT method, reply FROM native_request_receipts WHERE request_id = ?').get(ID) as { method: string; reply: string };
        expect(receipt.method).toBe(JSON.stringify(['appLock', true, true, false, null]));
        expect(JSON.parse(receipt.reply)).toEqual({ changed: true, value: true });

        const changed = await first.adapter.getData();
        changed.settings.security = { mobileAppLockEnabled: false, sibling: 'later' } as never;
        await first.adapter.saveData(changed);
        first.db.close(); databases.splice(databases.indexOf(first.db), 1);
        const cold = await open(path);
        expect(cold.host.probeAppLockOutcome(request)).toEqual({ ok: true, value: { changed: true, value: true } });
        expect(await cold.host.commitPreparedAppLock(envelope)).toEqual({ ok: true, value: { changed: true, value: true } });
        expect((await cold.adapter.getData()).settings.security).toEqual({ mobileAppLockEnabled: false, sibling: 'later' });
    });

    it('refuses a cold receipt-less result even after saved target equality or ABA', async () => {
        const dir = mkdtempSync(join(tempRoot, 'app-lock-')); directories.push(dir);
        const path = join(dir, 'library.db');
        const first = await open(path, true);
        const options = await first.host.getAppLockOptions({});
        if (!options.ok) throw new Error(JSON.stringify(options));
        const request: AppLockRequest = { requestId: ID, value: true, expected: options.value.expected };
        const plan = await first.host.prepareAppLock(request);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        const envelope = { request, prepared: plan.value.prepared };

        first.db.close(); databases.splice(databases.indexOf(first.db), 1);
        const cold = await open(path);
        expect(await cold.host.commitPreparedAppLock(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        let saved = await cold.adapter.getData();
        saved.settings.security = { mobileAppLockEnabled: true };
        await cold.adapter.saveData(saved);
        expect(await cold.host.commitPreparedAppLock(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        saved = await cold.adapter.getData();
        saved.settings.security = { sibling: 'keep' } as never;
        await cold.adapter.saveData(saved);
        expect(await cold.host.commitPreparedAppLock(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(cold.db.prepare('SELECT COUNT(*) AS n FROM native_request_receipts').get()).toMatchObject({ n: 0 });
    });
});
