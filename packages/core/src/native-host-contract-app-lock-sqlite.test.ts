import { afterEach, describe, expect, it, vi } from 'vitest';
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
const clientOf = (db: Database, fault: { commits: number }, statements: string[] = []): SqliteClient => ({
    run: async (sql, params = []) => {
        statements.push(sql);
        if (sql === 'COMMIT' && fault.commits > 0) { fault.commits -= 1; throw new Error('injected commit failure'); }
        db.prepare(sql).run(...params);
    },
    all: async <T,>(sql: string, params: unknown[] = []) => { statements.push(sql); return db.prepare(sql).all(...params) as T[]; },
    get: async <T,>(sql: string, params: unknown[] = []) => { statements.push(sql); return db.prepare(sql).get(...params) as T | undefined; },
    exec: async (sql) => { statements.push(sql); db.exec(sql); },
});
const fullTaskReads = (statements: string[]) => statements.filter((sql) => /^SELECT rowid as _rowid, \* FROM tasks\b/.test(sql)).length;
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

async function open(path: string, seed: boolean | AppData = false) {
    await flushPendingSave(); resetForTests(); resetNativeRequestReceipts();
    const db = new DatabaseSync(path); databases.push(db);
    const fault = { commits: 0 };
    const statements: string[] = [];
    const client = clientOf(db, fault, statements);
    if (seed) await new NativeReceiptSqliteAdapter(client).saveData(seed === true ? initial() : seed);
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
    return { db, client, adapter, host, fault, statements };
}

const largeLibrary = (): AppData => ({ ...initial(), tasks: Array.from({ length: 5000 }, (_, index): Task => ({
    id: `task-${index}`, title: `Task ${index}`, status: 'inbox', tags: [], contexts: [], createdAt: AT, updatedAt: AT, rev: 1 })) });
const savedSecurity = (db: Database, security: Record<string, unknown> | undefined) => {
    const row = db.prepare('SELECT data FROM settings WHERE id = 1').get() as { data: string };
    const settings = JSON.parse(row.data) as Record<string, unknown>;
    if (security) settings.security = security; else delete settings.security;
    db.prepare('UPDATE settings SET data = ? WHERE id = 1').run(JSON.stringify(settings));
};
const savedSecurityOf = (db: Database) =>
    (JSON.parse((db.prepare('SELECT data FROM settings WHERE id = 1').get() as { data: string }).data) as AppData['settings']).security;
const readOptions = async (host: ReturnType<typeof createNativeHostContract>) =>
    [await host.getAppLockOptions({}), await host.getAppLockDelayOptions({})];

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

    it('reads App lock options at 5,000 tasks without a full task read and with the full-read replies', async () => {
        const dir = mkdtempSync(join(tempRoot, 'app-lock-')); directories.push(dir);
        const path = join(dir, 'library.db');
        const seeded = await open(path, largeLibrary());
        const variants: (Record<string, unknown> | undefined)[] = [undefined, { sibling: 'keep' },
            { mobileAppLockEnabled: true, mobileAppLockRelockDelayMinutes: 0 },
            { mobileAppLockEnabled: false, mobileAppLockRelockDelayMinutes: 1 },
            { mobileAppLockEnabled: 'yes', mobileAppLockRelockDelayMinutes: 5 },
            { mobileAppLockEnabled: true, mobileAppLockRelockDelayMinutes: 15 },
            { mobileAppLockEnabled: false, mobileAppLockRelockDelayMinutes: 'soon' }];
        for (const security of variants) {
            savedSecurity(seeded.db, security);
            const env = await open(path);
            expect(fullTaskReads(env.statements)).toBeGreaterThan(0);
            env.statements.length = 0;
            const light = await readOptions(env.host);
            expect(fullTaskReads(env.statements)).toBe(0);
            vi.spyOn(env.adapter, 'readRowBaseline').mockResolvedValue(null);
            env.statements.length = 0;
            const full = await readOptions(env.host);
            expect(fullTaskReads(env.statements)).toBeGreaterThan(0);
            expect(light).toEqual(full);
        }
    }, 60_000);

    it('flushes a queued save before the light App lock read', async () => {
        const dir = mkdtempSync(join(tempRoot, 'app-lock-')); directories.push(dir);
        const env = await open(join(dir, 'library.db'), true);
        expect(await readOptions(env.host)).toMatchObject([{ ok: true, value: { value: false } }, { ok: true, value: { value: 0 } }]);
        await useTaskStore.getState().updateSettings({ security: { mobileAppLockEnabled: true, mobileAppLockRelockDelayMinutes: 15 } });
        expect(savedSecurityOf(env.db)).toEqual({ sibling: 'keep' });
        env.statements.length = 0;
        expect(await readOptions(env.host)).toMatchObject([{ ok: true, value: { value: true } }, { ok: true, value: { value: 15 } }]);
        expect(fullTaskReads(env.statements)).toBe(0);
        expect(savedSecurityOf(env.db)).toMatchObject({ mobileAppLockEnabled: true, mobileAppLockRelockDelayMinutes: 15 });
    });

    it('falls back to the full read after another adapter commits App lock settings', async () => {
        const dir = mkdtempSync(join(tempRoot, 'app-lock-')); directories.push(dir);
        const path = join(dir, 'library.db');
        const env = await open(path, true);
        expect(await readOptions(env.host)).toMatchObject([{ ok: true, value: { value: false } }, { ok: true, value: { value: 0 } }]);
        const otherDb = new DatabaseSync(path); databases.push(otherDb);
        const other = new NativeReceiptSqliteAdapter(clientOf(otherDb, { commits: 0 }), { rejectConcurrentWrites: true });
        const saved = await other.getData();
        saved.settings.security = { mobileAppLockEnabled: true, mobileAppLockRelockDelayMinutes: 5 };
        await other.saveData(saved);
        env.statements.length = 0;
        expect(await readOptions(env.host)).toMatchObject([{ ok: true, value: { value: true } }, { ok: true, value: { value: 5 } }]);
        expect(fullTaskReads(env.statements)).toBe(1);
    });

    it('returns the full-read STALE_REVISION when the store moves during the light App lock read', async () => {
        const dir = mkdtempSync(join(tempRoot, 'app-lock-')); directories.push(dir);
        const env = await open(join(dir, 'library.db'), true);
        const moveStore = () => useTaskStore.setState({ lastDataChangeAt: useTaskStore.getState().lastDataChangeAt + 1 });
        const light = env.adapter.readRowBaseline.bind(env.adapter);
        const lightSpy = vi.spyOn(env.adapter, 'readRowBaseline').mockImplementation(async () => { moveStore(); return light(); });
        env.statements.length = 0;
        const lightReplies = await readOptions(env.host);
        expect(fullTaskReads(env.statements)).toBe(0);
        expect(lightReplies).toEqual([1, 2].map(() => ({ ok: false,
            error: { code: 'STALE_REVISION', message: 'Area data changed while reading saved data' } })));
        lightSpy.mockResolvedValue(null);
        const full = env.adapter.getData.bind(env.adapter);
        vi.spyOn(env.adapter, 'getData').mockImplementation(async (options) => { moveStore(); return full(options); });
        expect(await readOptions(env.host)).toEqual(lightReplies);
    });

    it('returns SAVE_FAILED from the light App lock read when the queued save cannot flush', async () => {
        const dir = mkdtempSync(join(tempRoot, 'app-lock-')); directories.push(dir);
        const env = await open(join(dir, 'library.db'), true);
        await useTaskStore.getState().updateSettings({ security: { mobileAppLockEnabled: true } });
        env.fault.commits = 100;
        env.statements.length = 0;
        expect(await env.host.getAppLockOptions({})).toEqual({ ok: false,
            error: { code: 'SAVE_FAILED', message: 'Area operation could not read saved data' } });
        expect(fullTaskReads(env.statements)).toBe(0);
        expect(savedSecurityOf(env.db)).toEqual({ sibling: 'keep' });
    });
});
