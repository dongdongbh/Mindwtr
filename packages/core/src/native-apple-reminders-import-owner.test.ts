import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createNativeAppleReminderImportOwner } from './native-apple-reminders-import-owner';
import { prepareNativeAppleReminderImportItem, type NativeAppleReminderImportRequest } from './native-apple-reminders-import-item';
import { loadNativeRequestReceipts, NativeReceiptSqliteAdapter, resetNativeRequestReceipts } from './native-request-receipts';
import { openScratchSqlite } from './screen-parity.replay';
import { SqliteAdapter, type SqliteClient } from './sqlite-adapter';
import { TASK_SQLITE_COLUMNS } from './task-sync-schema';
import { flushPendingSave, getStorageAdapter, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData } from './types';

const REQUEST = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const AT = '2026-10-10T00:00:00.000Z';
const root = fileURLToPath(new URL('../../../.orchestrator/tmp/', import.meta.url));
const oldAdapter = getStorageAdapter();
const oldStore = useTaskStore.getState();
const resources: { close: () => void; directory: string }[] = [];
const initial = (): AppData => ({ tasks: [{ id: 'untouched', title: 'Retained', status: 'next', contexts: [], tags: [],
    createdAt: AT, updatedAt: AT, rev: 4 }], projects: [], sections: [], areas: [], people: [],
    settings: { deviceId: 'stored-device', gtd: { defaultAreaMode: 'none' } } });

async function open(existing = false) {
    resetForTests(); resetNativeRequestReceipts();
    mkdirSync(root, { recursive: true }); const directory = mkdtempSync(join(root, 'reminders-item-'));
    const scratch = openScratchSqlite(join(directory, 'library.sqlite'));
    resources.push({ close: scratch.close, directory });
    const data = initial();
    if (existing) data.tasks.push({ ...data.tasks[0], id: TASK, title: 'Existing task', description: 'Keep these notes' });
    await new SqliteAdapter(scratch.client).saveData(data);
    await scratch.client.run("UPDATE tasks SET contexts=' [ ] ', tags=NULL WHERE id='untouched'");
    const statements: string[] = [];
    const faults: { beforeRun?: (sql: string) => void; afterRun?: (sql: string) => void; beforeAll?: (sql: string) => Promise<void> | void } = {};
    const client: SqliteClient = { ...scratch.client,
        run: async (sql, parameters) => {
            statements.push(sql); faults.beforeRun?.(sql); await scratch.client.run(sql, parameters); faults.afterRun?.(sql);
        },
        all: async <T,>(sql: string, parameters?: unknown[]) => { statements.push(sql); await faults.beforeAll?.(sql); return scratch.client.all<T>(sql, parameters); },
        get: async <T,>(sql: string, parameters?: unknown[]) => { statements.push(sql); return scratch.client.get<T>(sql, parameters); },
    };
    let adapter: NativeReceiptSqliteAdapter;
    let ready = true;
    const create = () => createNativeAppleReminderImportOwner({
        readiness: () => ready ? { ok: true, value: null } : { ok: false, error: { code: 'NOT_READY', message: 'Not ready' } },
        save: async () => {
            try { await flushPendingSave(); } catch { /* The saved store failure is checked below. */ }
            return useTaskStore.getState().persistenceFailure
                ? { ok: false, error: { code: 'SAVE_FAILED', message: 'Controlled save failed' } }
                : { ok: true, value: null };
        },
    });
    const restart = async () => {
        resetForTests(); resetNativeRequestReceipts();
        adapter = new NativeReceiptSqliteAdapter(client, { rejectConcurrentWrites: true }); setStorageAdapter(adapter);
        const saved = await adapter.getData({ rawTasks: true });
        useTaskStore.setState({ ...oldStore, _allTasks: saved.tasks, _allProjects: saved.projects, _allSections: saved.sections ?? [],
            _allAreas: saved.areas ?? [], _allPeople: saved.people ?? [], settings: saved.settings,
            error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0 });
        await loadNativeRequestReceipts(client, { durableCommands: ['appleReminderImportItem'] });
        statements.length = 0; return create();
    };
    const owner = await restart();
    const request: NativeAppleReminderImportRequest = { version: 1, requestId: REQUEST,
        list: { id: 'selected-list', sourceId: 'selected-source' },
        reminder: { id: existing ? TASK : 'provider-row', title: 'Literal @home /due:today', notes: 'Original reminder notes', completed: false },
        generatedTaskId: existing ? null : TASK };
    const rows = await scratch.client.all<Record<string, string | number | null>>('SELECT * FROM tasks WHERE id=?', [TASK]);
    const prepared = prepareNativeAppleReminderImportItem({ request,
        target: { id: TASK, row: rows.length ? TASK_SQLITE_COLUMNS.map((name) => rows[0][name]) : null },
        factory: existing ? null : { preparedAt: AT, deviceIdBefore: 'stored-device', deviceIdToInitialize: null, effectiveDefaultAreaId: null } });
    if (!prepared) throw new Error('Expected candidate');
    const envelope = { request, prepared };
    const snapshot = async () => ({ tasks: await scratch.client.all<Record<string, unknown>>('SELECT * FROM tasks ORDER BY id'),
        projects: await scratch.client.all('SELECT * FROM projects'), settings: await scratch.client.all('SELECT * FROM settings'),
        receipts: await scratch.client.all('SELECT * FROM native_request_receipts') });
    return { owner, create, restart, database: join(directory, 'library.sqlite'), client: scratch.client, faults, statements, envelope, snapshot,
        setReady: (value: boolean) => { ready = value; }, get adapter() { return adapter; } };
}

afterEach(() => {
    resetForTests(); resetNativeRequestReceipts(); setStorageAdapter(oldAdapter); useTaskStore.setState(oldStore, true);
    for (const item of resources.splice(0).reverse()) { item.close(); rmSync(item.directory, { recursive: true, force: true }); }
});

describe('inactive native Apple Reminders item receipt owner', () => {
    it('saves a literal Inbox task and receipt without rewriting unrelated raw fields', async () => {
        const env = await open(); const before = await env.snapshot();
        expect(await env.owner.commit(env.envelope)).toEqual({ ok: true, value: env.envelope.prepared.result });
        const after = await env.snapshot(); expect(after.receipts).toHaveLength(1);
        expect(after.tasks.find((row) => row.id === 'untouched')).toEqual(before.tasks[0]);
        expect(after.tasks.find((row) => row.id === TASK)).toMatchObject({ title: 'Literal @home /due:today',
            description: 'Original reminder notes', status: 'inbox', dueDate: null, contexts: '[]' });
        expect(after.settings).toEqual(before.settings); expect(after.projects).toEqual(before.projects);
        expect(await env.owner.outcome(env.envelope)).toEqual({ ok: true, value: env.envelope.prepared.result });
        expect(await env.owner.commit(env.envelope)).toEqual({ ok: true, value: env.envelope.prepared.result });
        expect(await env.snapshot()).toEqual(after);
    });

    it('settles an existing UUID as ownership only, without task or settings writes', async () => {
        const env = await open(true); const before = await env.snapshot(); env.statements.length = 0;
        expect(await env.owner.commit(env.envelope)).toEqual({ ok: true, value: env.envelope.prepared.result });
        const after = await env.snapshot(); expect(after.tasks).toEqual(before.tasks); expect(after.settings).toEqual(before.settings);
        expect(after.receipts).toHaveLength(1);
        expect(env.statements.filter((sql) => /^(UPDATE|INSERT|DELETE)/u.test(sql)).every((sql) => sql.startsWith('INSERT INTO native_request_receipts'))).toBe(true);
    });

    it('replays an exact saved 47-cell existing-item plan after the schema grows without writing again', async () => {
        const env = await open(true);
        const envelope = structuredClone(env.envelope);
        if (envelope.prepared.target.row === null) throw new Error('Expected existing row');
        envelope.prepared.target.row = envelope.prepared.target.row.slice(0, 47);
        const frozen = JSON.stringify(envelope);
        expect(await env.owner.commit(envelope)).toEqual({ ok: true, value: envelope.prepared.result });
        const saved = await env.snapshot();
        expect(saved.receipts).toHaveLength(1);
        await env.client.run('UPDATE tasks SET dueReminderLeadMinutes=15,deletedAt=? WHERE id=?', [AT, TASK]);
        const owner = await env.restart(); env.setReady(false);
        const before = await env.snapshot(); env.statements.length = 0;
        expect(await owner.outcome(JSON.parse(frozen))).toEqual({ ok: true, value: envelope.prepared.result });
        expect(await owner.commit(JSON.parse(frozen))).toEqual({ ok: true, value: envelope.prepared.result });
        expect(await env.snapshot()).toEqual(before);
        expect(before.receipts).toEqual(saved.receipts);
        expect(env.statements.some((sql) => /^(UPDATE|INSERT|DELETE)/u.test(sql))).toBe(false);
        expect(JSON.stringify(envelope)).toBe(frozen);
    });

    it('proves cold replay before changed creation witnesses, readiness or current task liveness', async () => {
        const env = await open(); expect((await env.owner.commit(env.envelope)).ok).toBe(true);
        await env.client.run('UPDATE tasks SET title=?,deletedAt=? WHERE id=?', ['Later edit', AT, TASK]);
        await env.client.run("UPDATE settings SET data=? WHERE id=1", [JSON.stringify({ deviceId: 'later-device' })]);
        const owner = await env.restart(); env.setReady(false); const before = await env.snapshot(); env.statements.length = 0;
        expect(await owner.commit(env.envelope)).toEqual({ ok: true, value: env.envelope.prepared.result });
        expect(await env.snapshot()).toEqual(before);
        expect(env.statements.some((sql) => /^(UPDATE|INSERT|DELETE)/u.test(sql))).toBe(false);
    });

    it('does not accept cached success after its actual SQL receipt disappears', async () => {
        const env = await open(); expect((await env.owner.commit(env.envelope)).ok).toBe(true);
        await env.client.run('DELETE FROM native_request_receipts'); const before = await env.snapshot();
        expect(await env.owner.outcome(env.envelope)).toEqual({ ok: true, value: null });
        expect((await env.owner.commit(env.envelope)).ok).toBe(false);
        expect(await env.snapshot()).toEqual(before);
    });

    it('rejects a changed actual receipt reply despite a cached exact result', async () => {
        const env = await open(); expect((await env.owner.commit(env.envelope)).ok).toBe(true);
        await env.client.run('UPDATE native_request_receipts SET reply=?', [JSON.stringify({ ...env.envelope.prepared.result, taskId: 'another' })]);
        const before = await env.snapshot(); expect((await env.owner.outcome(env.envelope)).ok).toBe(false);
        expect((await env.owner.commit(env.envelope)).ok).toBe(false); expect(await env.snapshot()).toEqual(before);
    });

    it('rejects malformed plans before any storage access', async () => {
        const env = await open(); env.statements.length = 0;
        expect((await env.owner.commit({ ...env.envelope, extra: true })).ok).toBe(false);
        expect((await env.owner.outcome({ ...env.envelope, prepared: { ...env.envelope.prepared, extra: true } })).ok).toBe(false);
        expect(env.statements).toEqual([]);
    });
    it('retries only its failed raw task transaction after an actual COMMIT refusal', async () => {
        const env = await open(); const before = await env.snapshot();
        env.faults.beforeRun = (sql) => { if (sql === 'COMMIT') throw new Error('COMMIT refused'); };
        expect((await env.owner.commit(env.envelope)).ok).toBe(false);
        expect(await env.snapshot()).toEqual(before);
        expect(useTaskStore.getState().persistenceFailure).not.toBeNull();
        env.faults.beforeRun = undefined;
        expect(await env.owner.commit(env.envelope)).toEqual({ ok: true, value: env.envelope.prepared.result });
        const after = await env.snapshot(); expect(after.receipts).toHaveLength(1);
        expect(after.tasks.filter((row) => row.id === TASK)).toHaveLength(1);
        expect(after.tasks.find((row) => row.id === 'untouched')).toEqual(before.tasks[0]);
    });

    it('uses actual receipt proof after a lost COMMIT acknowledgment without inserting again', async () => {
        const env = await open(); let lost = false;
        env.faults.afterRun = (sql) => { if (sql === 'COMMIT' && !lost) { lost = true; throw new Error('COMMIT acknowledgment lost'); } };
        expect(await env.owner.commit(env.envelope)).toEqual({ ok: true, value: env.envelope.prepared.result });
        const after = await env.snapshot(); expect(after.receipts).toHaveLength(1);
        env.faults.afterRun = undefined; env.statements.length = 0;
        expect(await env.owner.commit(env.envelope)).toEqual({ ok: true, value: env.envelope.prepared.result });
        expect(await env.snapshot()).toEqual(after);
        expect(env.statements.some((sql) => /^(UPDATE|INSERT|DELETE)/u.test(sql))).toBe(false);
    });

    it('refuses an occupied target or changed device witness without manufacturing a receipt', async () => {
        for (const change of ['target', 'device'] as const) {
            const env = await open();
            if (change === 'target') await env.client.run('UPDATE tasks SET id=? WHERE id=?', [TASK, 'untouched']);
            else await env.client.run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify({ deviceId: 'changed' })]);
            const before = await env.snapshot();
            expect((await env.owner.commit(env.envelope)).ok).toBe(false);
            expect(await env.snapshot()).toEqual(before);
        }
    });

    it('refuses a concurrent item while a receipt read is held, then permits exact completion', async () => {
        const env = await open(); let release!: () => void; let entered!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        const arrived = new Promise<void>((resolve) => { entered = resolve; });
        let once = true;
        env.faults.beforeAll = async (sql) => {
            if (once && sql.includes('FROM native_request_receipts WHERE')) { once = false; entered(); await held; }
        };
        const first = env.owner.commit(env.envelope); await arrived;
        expect((await env.owner.commit(env.envelope)).ok).toBe(false);
        release(); expect(await first).toEqual({ ok: true, value: env.envelope.prepared.result });
        expect((await env.snapshot()).receipts).toHaveLength(1);
    });

    it('refuses adapter replacement across receipt I/O without writing either library', async () => {
        const env = await open(); const before = await env.snapshot();
        env.faults.beforeAll = (sql) => {
            if (sql.includes('FROM native_request_receipts WHERE')) setStorageAdapter(oldAdapter);
        };
        expect((await env.owner.commit(env.envelope)).ok).toBe(false);
        expect(await env.snapshot()).toEqual(before);
    });

    it('preserves unrelated raw edits in a later item', async () => {
        const env = await open(); expect((await env.owner.commit(env.envelope)).ok).toBe(true);
        await env.client.run("UPDATE tasks SET title='Later title',contexts=' [ ] ' WHERE id='untouched'");
        const owner = await env.restart();
        const request = { ...env.envelope.request, requestId: '33333333-3333-4333-8333-333333333333',
            generatedTaskId: '44444444-4444-4444-8444-444444444444' };
        const prepared = prepareNativeAppleReminderImportItem({ request, target: { id: request.generatedTaskId, row: null },
            factory: { preparedAt: AT, deviceIdBefore: 'stored-device', deviceIdToInitialize: null, effectiveDefaultAreaId: null } });
        const before = await env.snapshot();
        expect((await owner.commit({ request, prepared })).ok).toBe(true);
        const after = await env.snapshot();
        expect(after.tasks.find((row) => row.id === 'untouched')).toEqual(before.tasks.find((row) => row.id === 'untouched'));
        expect(after.receipts).toHaveLength(2);
    });

    it('does not acknowledge a receipt visible only inside an uncertain uncommitted transaction', async () => {
        const env = await open();
        let commitAttempted = false;
        env.faults.beforeRun = (sql) => {
            if (sql === 'COMMIT') commitAttempted = true;
            if (commitAttempted && (sql === 'COMMIT' || sql === 'ROLLBACK')) throw new Error('Transaction settlement unavailable');
        };
        const result = await env.owner.commit(env.envelope);
        env.faults.beforeRun = undefined;
        try { await env.client.run('ROLLBACK'); } catch { /* A correctly fenced path may have rolled back already. */ }
        expect(commitAttempted).toBe(true);
        expect(result.ok).toBe(false);
        expect((await env.snapshot()).receipts).toHaveLength(0);
    });

    it('retries an existing ownership receipt without ever saving task or settings data', async () => {
        const env = await open(true); const before = await env.snapshot();
        env.faults.beforeRun = (sql) => { if (sql === 'COMMIT') throw new Error('Receipt COMMIT refused'); };
        expect((await env.owner.commit(env.envelope)).ok).toBe(false);
        expect(await env.snapshot()).toEqual(before);
        env.faults.beforeRun = undefined;
        expect((await env.owner.commit(env.envelope)).ok).toBe(true);
        const after = await env.snapshot(); expect(after.tasks).toEqual(before.tasks); expect(after.settings).toEqual(before.settings);
        expect(after.receipts).toHaveLength(1);
    });

    it('refuses a changed default Area before creating the prepared task', async () => {
        const env = await open(); const data = await env.adapter.getData({ rawTasks: true });
        data.areas = [{ id: 'later-area', name: 'Later', order: 0, createdAt: AT, updatedAt: AT }];
        data.settings.gtd = { defaultAreaMode: 'fixed', defaultAreaId: 'later-area' };
        await new SqliteAdapter(env.client).saveData(data); const before = await env.snapshot();
        expect((await env.owner.commit(env.envelope)).ok).toBe(false);
        expect(await env.snapshot()).toEqual(before);
    });

    it('refuses a replaced task projection during the accepted-baseline read', async () => {
        const env = await open(); const before = await env.snapshot(); let replaced = false;
        env.faults.beforeAll = (sql) => {
            if (!replaced && sql.startsWith('SELECT rowid AS _rowid')) { replaced = true; useTaskStore.setState({ _allTasks: [...useTaskStore.getState()._allTasks] }); }
        };
        expect((await env.owner.commit(env.envelope)).ok).toBe(false);
        expect(replaced).toBe(true); expect(await env.snapshot()).toEqual(before);
    });

    it('does not adopt an external writer epoch until the store is reloaded', async () => {
        const env = await open(); const other = openScratchSqlite(env.database);
        try { await other.client.run("UPDATE tasks SET title='External edit' WHERE id='untouched'"); } finally { other.close(); }
        const before = await env.snapshot(); expect((await env.owner.commit(env.envelope)).ok).toBe(false);
        expect(await env.snapshot()).toEqual(before);
        const owner = await env.restart(); expect((await owner.commit(env.envelope)).ok).toBe(true);
        expect((await env.snapshot()).tasks.find((row) => row.id === 'untouched')).toEqual(before.tasks[0]);
    });

    it('does not claim another save failure as its exact warm retry', async () => {
        const env = await open(); env.faults.beforeRun = (sql) => { if (sql === 'COMMIT') throw new Error('COMMIT refused'); };
        expect((await env.owner.commit(env.envelope)).ok).toBe(false); env.faults.beforeRun = undefined;
        const ownedFailure = useTaskStore.getState().persistenceFailure;
        expect(ownedFailure).not.toBeNull();
        useTaskStore.setState({ persistenceFailure: { ...ownedFailure! } });
        const before = await env.snapshot(); expect((await env.owner.commit(env.envelope)).ok).toBe(false);
        expect(await env.snapshot()).toEqual(before);
        useTaskStore.setState({ persistenceFailure: ownedFailure });
        expect((await env.owner.commit(env.envelope)).ok).toBe(true);
    });

    it('saves the frozen Skip row even after the reminder default changes, so a recovered journal never wedges', async () => {
        const env = await open();
        const prepared = prepareNativeAppleReminderImportItem({ request: env.envelope.request, target: env.envelope.prepared.target,
            factory: (env.envelope.prepared as { factory: unknown }).factory }, 'skip')!;
        expect(await env.owner.commit({ request: env.envelope.request, prepared })).toEqual({ ok: true, value: prepared.result });
        const [row] = await env.client.all<{ suppressMindwtrReminders: number }>('SELECT suppressMindwtrReminders FROM tasks WHERE id=?', [TASK]);
        expect(row.suppressMindwtrReminders).toBe(1);
    });
});
