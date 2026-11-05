import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createNativeShareCaptureMethods } from './native-share-capture';
import { NativeReceiptSqliteAdapter, loadNativeRequestReceipts, resetNativeRequestReceipts } from './native-request-receipts';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { createNativeHostContract } from './native-host-contract';
import type { SqliteClient } from './sqlite-adapter';
import type { AppData } from './types';

const require = createRequire(import.meta.url);
type Database = { prepare: (sql: string) => { run: (...params: unknown[]) => unknown; all: (...params: unknown[]) => unknown[];
    get: (...params: unknown[]) => unknown }; exec: (sql: string) => void; close: () => void };
const DatabaseSync = (require('node:sqlite') as { DatabaseSync: new (path: string) => Database }).DatabaseSync;
const ID = '00000000-0000-4000-8000-000000000731', AT = '2026-10-30T00:00:00.000Z';
const source = { id: ID, fingerprint: 'a'.repeat(64) };
const root = join(process.cwd(), '.orchestrator/tmp/share-capture'); mkdirSync(root, { recursive: true });
const dirs: string[] = [], databases: Database[] = [];
afterEach(async () => {
    await flushPendingSave(); resetForTests(); resetNativeRequestReceipts();
    for (const database of databases.splice(0)) database.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const seed: AppData = { tasks: [{ id: 'sibling', title: 'Keep sibling', status: 'next', contexts: ['@desk'], tags: ['keep'],
    createdAt: AT, updatedAt: AT, rev: 7 }], projects: [], sections: [], areas: [], people: [],
    settings: { deviceId: 'device', language: 'en', gtd: { saveAudioAttachments: false } } };
const newPath = () => { const dir = mkdtempSync(join(root, 'sqlite-')); dirs.push(dir); return join(dir, 'library.db'); };
async function open(path: string, fresh = false) {
    await flushPendingSave(); resetForTests(); resetNativeRequestReceipts();
    const database = new DatabaseSync(path); databases.push(database);
    const fault = { armed: false, receiptInTransaction: false, fired: 0, commits: [] as boolean[] };
    const client: SqliteClient = {
        run: async (sql, parameters = []) => {
            if (sql.startsWith('INSERT INTO native_request_receipts')) fault.receiptInTransaction = true;
            if (sql === 'COMMIT') {
                fault.commits.push(fault.receiptInTransaction);
                if (fault.armed && fault.receiptInTransaction) { fault.fired++; throw new Error('Injected receipt transaction COMMIT failure'); }
                fault.receiptInTransaction = false;
            }
            if (sql === 'ROLLBACK') fault.receiptInTransaction = false;
            database.prepare(sql).run(...parameters);
        },
        all: async <T,>(sql: string, parameters: unknown[] = []) => database.prepare(sql).all(...parameters) as T[],
        get: async <T,>(sql: string, parameters: unknown[] = []) => database.prepare(sql).get(...parameters) as T | undefined,
        exec: async sql => { database.exec(sql); },
    };
    if (fresh) await new NativeReceiptSqliteAdapter(client).saveData(seed);
    const adapter = new NativeReceiptSqliteAdapter(client, { rejectConcurrentWrites: true });
    await loadNativeRequestReceipts(client, { durableCommands: ['iosShareCapture'] }); setStorageAdapter(adapter);
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [], settings: {},
        persistenceFailure: null, error: null, isLoading: false, lastDataChangeAt: 0 });
    await useTaskStore.getState().fetchData({ throwOnError: true }); await flushPendingSave();
    const contract = createNativeHostContract(); expect(await contract.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
    const methods = createNativeShareCaptureMethods({ contract, current: () => {} });
    const opened = contract.openQuickCapture(); if (!opened.ok) throw new Error(opened.error.code);
    const input = { source, method: 'captureSubmit', requestFingerprint: 'b'.repeat(64),
        capture: { text: 'Edited share title', options: { ...opened.value.options, note: 'Edited share note', addAnother: false }, captureId: ID, openAfterSave: false } };
    return { database, adapter, methods, fault, input };
}
const rows = (db: Database) => db.prepare('SELECT * FROM tasks ORDER BY id').all();
const receipts = (db: Database) => db.prepare('SELECT * FROM native_request_receipts ORDER BY request_id').all();
const plan = async (env: Awaited<ReturnType<typeof open>>) => {
    const prepared = await env.methods.prepare(env.input); if (prepared.kind !== 'prepared') throw new Error('Expected prepared share');
    return prepared.prepared;
};

describe('native share actual atomic SQLite source receipts', () => {
    it('rolls back BOTH task and receipt when COMMIT fails, then exact retry saves once', async () => {
        const env = await open(newPath(), true), before = rows(env.database), command = await plan(env);
        env.fault.commits = []; env.fault.armed = true;
        await expect(env.methods.commit(command)).rejects.toThrow('SAVE_FAILED');
        expect(env.fault.fired).toBe(1); expect(rows(env.database)).toEqual(before); expect(receipts(env.database)).toEqual([]);
        expect(useTaskStore.getState()._allTasks.some(task => task.id === ID)).toBe(false);
        env.fault.armed = false;
        expect(await env.methods.commit(command)).toMatchObject({ kind: 'saved', taskId: ID });
        expect(env.fault.commits).toEqual([true, true]);
        expect(rows(env.database)).toHaveLength(2); expect(receipts(env.database)).toHaveLength(1);
        expect(rows(env.database).find((row: any) => row.id === 'sibling')).toEqual(before[0]);
    });
    it('cold source-only probe proves earlier Save after a legitimate later task edit without rewriting it', async () => {
        const path = newPath(), env = await open(path, true), command = await plan(env);
        await env.methods.commit(command);
        expect(await useTaskStore.getState().updateTask(ID, { title: 'Legitimate later edit', contexts: ['@later'] })).toMatchObject({ success: true });
        await flushPendingSave(); const edited = rows(env.database);
        env.database.close(); databases.splice(databases.indexOf(env.database), 1);
        const cold = await open(path);
        expect(await cold.methods.outcome(source)).toMatchObject({ kind: 'saved', taskId: ID });
        expect(rows(cold.database)).toEqual(edited);
        expect(await cold.methods.commit(command)).toMatchObject({ kind: 'saved', taskId: ID });
        expect(rows(cold.database)).toEqual(edited);
        await expect(cold.methods.prepare({ ...cold.input, requestFingerprint: 'c'.repeat(64) })).rejects.toThrow('INVALID_INPUT');
        await expect(cold.methods.outcome({ ...source, fingerprint: 'd'.repeat(64) })).rejects.toThrow('SAVE_FAILED');
        expect(rows(cold.database)).toEqual(edited); expect(receipts(cold.database)).toHaveLength(1);
    });
});
