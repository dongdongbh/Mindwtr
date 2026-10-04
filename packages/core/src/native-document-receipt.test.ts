import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createNativeRequestReceipts, loadNativeRequestReceipts, MAX_NATIVE_DOCUMENT_RECEIPT_REPLY_BYTES,
    NativeReceiptSqliteAdapter, resetNativeRequestReceipts, startNativeRequestSession,
    type NativeDocumentReceiptInput,
} from './native-request-receipts';
import { openScratchSqlite } from './screen-parity.replay';
import { SqliteAdapter, type SqliteClient } from './sqlite-adapter';
import * as logger from './logger';
import * as store from './store';
import type { AppData } from './types';

const AT = '2026-10-04T12:00:00.000Z';
const ID = '11111111-1111-4111-8111-111111111111';
const STAGED = '22222222-2222-4222-8222-222222222222';
const payload = (operation: 'merge' | 'restore' = 'merge') => JSON.stringify(['backupDocument', operation, STAGED, 'a'.repeat(64)]);
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const original: AppData = {
    tasks: [
        { id: 'visible', title: 'Original', status: 'next', contexts: [], tags: [], createdAt: AT, updatedAt: AT, rev: 1 },
        { id: 'hidden', title: 'Hidden', status: 'archived', contexts: [], tags: [], createdAt: AT, updatedAt: AT, rev: 1 },
    ], projects: [], sections: [], areas: [], people: [], settings: { language: 'en' },
};
const reply = { snapshotName: 'data.2026-10-04T12-00-00.000.snapshot.json', added: 0, updated: 1 };
const resources: { close: () => void; directory: string }[] = [];
const temporaryRoot = fileURLToPath(new URL('../../../.orchestrator/tmp/', import.meta.url));

async function open() {
    mkdirSync(temporaryRoot, { recursive: true });
    const directory = mkdtempSync(join(temporaryRoot, 'document-receipt-'));
    const file = join(directory, 'document.sqlite');
    const sql = openScratchSqlite(file);
    resources.push({ close: sql.close, directory });
    const seed = new SqliteAdapter(sql.client);
    await seed.saveData(clone(original));
    resetNativeRequestReceipts();
    await loadNativeRequestReceipts(sql.client, { durableCommands: ['backupDocument'] });
    const events: string[] = [];
    const hooks: {
        beforeRun?: (statement: string, params?: unknown[]) => Promise<void>;
        beforeAll?: (statement: string) => Promise<void>;
    } = {};
    const client: SqliteClient = {
        ...sql.client,
        run: async (statement, params) => {
            events.push(statement);
            await hooks.beforeRun?.(statement, params);
            await sql.client.run(statement, params);
        },
        all: async <T,>(statement: string, params?: unknown[]) => {
            events.push(statement);
            await hooks.beforeAll?.(statement);
            return sql.client.all<T>(statement, params);
        },
    };
    const adapter = new NativeReceiptSqliteAdapter(client, { rejectConcurrentWrites: true });
    const expectedCurrent = await adapter.getData();
    const data = clone(expectedCurrent);
    data.tasks[0] = { ...data.tasks[0], title: 'Merged 日本語 🦉', rev: 2 };
    const input: NativeDocumentReceiptInput = { requestId: ID, payload: payload(), expectedCurrent, data, reply: clone(reply) };
    events.length = 0;
    const state = async () => ({
        tasks: await sql.client.all('SELECT * FROM tasks ORDER BY id'),
        settings: await sql.client.all('SELECT * FROM settings'),
        receipts: await sql.client.all('SELECT * FROM native_request_receipts ORDER BY request_id'),
    });
    return { sql, file, adapter, input, events, hooks, state };
}
const gate = () => {
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    return { release, waiting, hold: async () => { entered(); await held; } };
};

afterEach(() => {
    vi.restoreAllMocks();
    resetNativeRequestReceipts();
    for (const item of resources.splice(0).reverse()) { item.close(); rmSync(item.directory, { recursive: true, force: true }); }
});

describe('atomic native complete-document receipts over real SQLite', () => {
    it('commits the document and plain INSERT receipt in the same transaction and owns detached replies', async () => {
        const env = await open();
        const result = await env.adapter.saveDocumentWithReceipt(env.input);
        expect(result).toEqual({ reply, replayed: false });
        expect((await env.adapter.getData()).tasks[0].title).toBe('Merged 日本語 🦉');
        const start = env.events.indexOf('BEGIN IMMEDIATE');
        const receiptIndex = env.events.findIndex((statement) => statement.startsWith('INSERT INTO native_request_receipts'));
        expect(receiptIndex).toBeGreaterThan(start);
        expect(env.events[receiptIndex]).not.toContain('ON CONFLICT');
        expect(env.events.indexOf('COMMIT')).toBeGreaterThan(receiptIndex);
        (result.reply as typeof reply).added = 999;
        const receipts = createNativeRequestReceipts({ save: async () => ({ ok: true, value: null }) });
        expect(receipts.saved(ID, payload())).toEqual({ ok: true, value: reply });
    });

    it('recreates the adapter/session and replays the original reply after intervening durable edits with zero writes', async () => {
        const env = await open();
        await env.adapter.saveDocumentWithReceipt(env.input);
        const later = await env.adapter.getData();
        later.tasks[0] = { ...later.tasks[0], title: 'Later edit', rev: 3 };
        await env.adapter.saveData(later);
        const before = await env.state();
        resetNativeRequestReceipts();
        startNativeRequestSession();
        await loadNativeRequestReceipts(env.sql.client, { durableCommands: ['backupDocument'] });
        const writes: string[] = [];
        const recreated = new NativeReceiptSqliteAdapter({ ...env.sql.client,
            run: async (statement, params) => { writes.push(statement); await env.sql.client.run(statement, params); },
        }, { rejectConcurrentWrites: true });
        expect(await recreated.saveDocumentWithReceipt({ ...env.input, reply: { changed: 'ignored' } })).toEqual({ reply, replayed: true });
        expect(writes).toEqual([]);
        expect(await env.state()).toEqual(before);
    });

    it('refuses a different payload for the same UUID', async () => {
        const env = await open();
        await env.adapter.saveDocumentWithReceipt(env.input);
        const before = await env.state();
        startNativeRequestSession();
        await expect(env.adapter.saveDocumentWithReceipt({ ...env.input, payload: payload('restore') })).rejects.toThrow(/identity/);
        expect(await env.state()).toEqual(before);
    });

    it.each(['null', '{', '{"value":1e999}', ' '.repeat(65_537) + '{}'])('refuses malformed durable replies even when the session cache contains success: %s', async (storedReply) => {
        const env = await open();
        await env.adapter.saveDocumentWithReceipt(env.input);
        await env.sql.client.run('UPDATE native_request_receipts SET reply=? WHERE request_id=?', [storedReply, ID]);
        const before = await env.state();
        await expect(env.adapter.saveDocumentWithReceipt(env.input)).rejects.toThrow('Invalid saved document receipt');
        expect(await env.adapter.readDurableReceipt(ID, payload())).toMatchObject({ ok: false });
        expect(await env.state()).toEqual(before);
        await expect(loadNativeRequestReceipts(env.sql.client, { durableCommands: ['backupDocument'] })).rejects.toThrow('Invalid saved document receipt');
    });

    it('uses the fresh SQL reply rather than its stale successful cache', async () => {
        const env = await open();
        await env.adapter.saveDocumentWithReceipt(env.input);
        const fresh = { ...reply, updated: 7 };
        await env.sql.client.run('UPDATE native_request_receipts SET reply=? WHERE request_id=?', [JSON.stringify(fresh), ID]);
        expect(await env.adapter.saveDocumentWithReceipt(env.input)).toEqual({ reply: fresh, replayed: true });
    });

    it('never replays a stale session reply when the durable row is gone', async () => {
        const env = await open();
        await env.adapter.saveDocumentWithReceipt(env.input);
        await env.sql.client.run('DELETE FROM native_request_receipts WHERE request_id=?', [ID]);
        const before = await env.state();
        await expect(env.adapter.saveDocumentWithReceipt(env.input)).rejects.toThrow('Saved document receipt is missing');
        expect(await env.state()).toEqual(before);
    });

    it('refuses missing proof after durable data returns exactly to the original base, while an unseen UUID still works', async () => {
        const env = await open();
        await env.adapter.saveDocumentWithReceipt(env.input);
        const originalTask = env.input.expectedCurrent.tasks[0];
        await env.sql.client.run('UPDATE tasks SET title=?,rev=? WHERE id=?', [originalTask.title, originalTask.rev, originalTask.id]);
        expect(await env.adapter.getData()).toEqual(env.input.expectedCurrent);
        await env.sql.client.run('DELETE FROM native_request_receipts WHERE request_id=?', [ID]);
        const before = await env.state();
        env.events.length = 0;
        await expect(env.adapter.saveDocumentWithReceipt(env.input)).rejects.toThrow('Saved document receipt is missing');
        expect(env.events).not.toContain('BEGIN IMMEDIATE');
        expect(await env.state()).toEqual(before);
        const unseen = '44444444-4444-4444-8444-444444444444';
        expect(await env.adapter.saveDocumentWithReceipt({ ...env.input, requestId: unseen })).toEqual({ reply, replayed: false });
    });

    it('refuses malformed durable identity or saved timestamps', async () => {
        const env = await open();
        await env.adapter.saveDocumentWithReceipt(env.input);
        await env.sql.client.run('UPDATE native_request_receipts SET saved_at=? WHERE request_id=?', ['not-a-date', ID]);
        await expect(env.adapter.saveDocumentWithReceipt(env.input)).rejects.toThrow('Invalid saved document receipt');
        await env.sql.client.run('UPDATE native_request_receipts SET saved_at=?,method=? WHERE request_id=?', [AT, '["backupDocument","broken"]', ID]);
        await expect(env.adapter.saveDocumentWithReceipt(env.input)).rejects.toThrow('Invalid saved document receipt');
    });

    it.each(['insert', 'commit'] as const)('rolls back document and receipt on %s failure, clears context, and permits exact retry', async (fault) => {
        const env = await open();
        const before = await env.state();
        const warn = vi.spyOn(logger, 'logWarn');
        let fail = true;
        env.hooks.beforeRun = async (statement) => {
            if (fail && (fault === 'insert' ? statement.startsWith('INSERT INTO native_request_receipts') : statement === 'COMMIT')) {
                fail = false;
                throw new Error('private-driver-payload');
            }
        };
        await expect(env.adapter.saveDocumentWithReceipt(env.input)).rejects.toThrow('Document receipt persistence failed');
        expect(await env.state()).toEqual(before);
        expect(JSON.stringify(warn.mock.calls)).not.toContain('private-driver-payload');
        // An ordinary save after the failed direct context cannot carry its receipt.
        const ordinary = await env.adapter.getData();
        await env.adapter.saveData(ordinary);
        expect(await env.sql.client.all('SELECT * FROM native_request_receipts')).toEqual([]);
        expect(await env.adapter.saveDocumentWithReceipt(env.input)).toEqual({ reply, replayed: false });
    });

    it('rolls back an in-transaction duplicate instead of allowing an INSERT conflict to claim success', async () => {
        const env = await open();
        const before = await env.state();
        let inject = true;
        env.hooks.beforeRun = async (statement, params) => {
            if (inject && statement.startsWith('INSERT INTO native_request_receipts')) {
                inject = false;
                await env.sql.client.run(statement, params);
            }
        };
        await expect(env.adapter.saveDocumentWithReceipt(env.input)).rejects.toThrow('Document receipt persistence failed');
        expect(await env.state()).toEqual(before);
        expect(env.events).toContain('ROLLBACK');
    });

    it('recovers a COMMIT that landed before its driver acknowledgment threw, without rewriting later edits', async () => {
        const env = await open();
        let fail = true;
        const uncertain = new NativeReceiptSqliteAdapter({ ...env.sql.client,
            run: async (statement, params) => {
                await env.sql.client.run(statement, params);
                if (statement === 'COMMIT' && fail) {
                    fail = false;
                    throw new Error('private postcommit driver acknowledgment');
                }
            },
        }, { rejectConcurrentWrites: true });
        await expect(uncertain.saveDocumentWithReceipt(env.input)).rejects.toThrow('Document receipt persistence failed');
        expect((await env.state()).receipts).toHaveLength(1);
        const later = await env.adapter.getData();
        later.tasks[0] = { ...later.tasks[0], title: 'Intervening edit after uncertain commit', rev: 3 };
        await env.adapter.saveData(later);
        const before = await env.state();
        resetNativeRequestReceipts();
        await loadNativeRequestReceipts(env.sql.client, { durableCommands: ['backupDocument'] });
        const writes: string[] = [];
        const cold = new NativeReceiptSqliteAdapter({ ...env.sql.client,
            run: async (statement, params) => { writes.push(statement); await env.sql.client.run(statement, params); },
        }, { rejectConcurrentWrites: true });
        expect(await cold.saveDocumentWithReceipt(env.input)).toEqual({ reply, replayed: true });
        expect(writes).toEqual([]);
        expect(await env.state()).toEqual(before);
    });

    it('keeps malformed imported task IDs and foreign references out of document failure warnings', async () => {
        const env = await open();
        const warn = vi.spyOn(logger, 'logWarn');
        const info = vi.spyOn(logger, 'logInfo');
        const error = vi.spyOn(logger, 'logError');
        env.input.data.tasks[0] = { ...env.input.data.tasks[0], id: 'private-import-id',
            projectId: 'private-import-project', sectionId: 'private-import-section',
            title: 'private-import-title', description: 'private-import-description' };
        env.hooks.beforeRun = async (statement) => {
            if (statement === 'COMMIT') throw new Error('private-import-driver-error');
        };
        await expect(env.adapter.saveDocumentWithReceipt(env.input)).rejects.toThrow('Document receipt persistence failed');
        const logs = JSON.stringify([warn.mock.calls, info.mock.calls, error.mock.calls]);
        expect(logs).not.toContain('private-import-');
        const failure = warn.mock.calls.find(([message]) => message === 'SQLite saveData failed');
        expect(failure?.[1]?.context).toEqual({ step: expect.any(String), tasks: 2, projects: 0, sections: 0, areas: 0, people: 0 });
        expect(failure?.[1]?.context).not.toHaveProperty('referenceIssueSamples');
    });

    it('commits a receipt for a no-op document without advancing the store generation', async () => {
        const env = await open();
        const generation = store.getPersistenceStatus().generation;
        expect(await env.adapter.saveDocumentWithReceipt({ ...env.input, data: env.input.expectedCurrent })).toEqual({ reply, replayed: false });
        expect((await env.state()).receipts).toHaveLength(1);
        expect(store.getPersistenceStatus().generation).toBe(generation);
    });

    it.each(['settings', 'hidden', 'array-order'] as const)('refuses stale expected %s data before any document write', async (field) => {
        const env = await open();
        const stale = clone(env.input.expectedCurrent);
        if (field === 'settings') stale.settings.language = 'fr';
        if (field === 'hidden') stale.tasks[1].title = 'Different hidden state';
        if (field === 'array-order') stale.tasks.reverse();
        const before = await env.state();
        await expect(env.adapter.saveDocumentWithReceipt({ ...env.input, expectedCurrent: stale })).rejects.toThrow('Stale document receipt baseline');
        expect(await env.state()).toEqual(before);
        expect(env.events).not.toContain('BEGIN IMMEDIATE');
    });

    it('ignores object member order and omitted undefined fields in the expected canonical JSON', async () => {
        const env = await open();
        const expectedCurrent = { settings: { ignored: undefined, ...env.input.expectedCurrent.settings },
            people: env.input.expectedCurrent.people, areas: env.input.expectedCurrent.areas,
            sections: env.input.expectedCurrent.sections, projects: env.input.expectedCurrent.projects, tasks: env.input.expectedCurrent.tasks };
        expect(await env.adapter.saveDocumentWithReceipt({ ...env.input, expectedCurrent })).toEqual({ reply, replayed: false });
    });

    it('compares a fresh durable read rather than the adapter previous baseline', async () => {
        const env = await open();
        await env.sql.client.run('UPDATE settings SET data=? WHERE id=1', ['{"language":"fr"}']);
        const before = await env.state();
        await expect(env.adapter.saveDocumentWithReceipt(env.input)).rejects.toThrow('Stale document receipt baseline');
        expect(await env.state()).toEqual(before);
    });

    it('refuses an external connection commit after baseline read and before BEGIN', async () => {
        const env = await open();
        const other = openScratchSqlite(env.file);
        try {
            let race = true;
            env.hooks.beforeRun = async (statement) => {
                if (race && statement === 'BEGIN IMMEDIATE') {
                    race = false;
                    await other.client.run('UPDATE settings SET data=? WHERE id=1', ['{"language":"fr"}']);
                }
            };
            await expect(env.adapter.saveDocumentWithReceipt(env.input)).rejects.toThrow('Stale document receipt baseline');
            expect((await env.adapter.getData()).settings.language).toBe('fr');
            expect((await env.adapter.getData()).tasks[0].title).toBe('Original');
            expect(await env.sql.client.all('SELECT * FROM native_request_receipts')).toEqual([]);
        } finally { other.close(); }
    });

    it('detaches all inputs before awaits and refuses overlapping direct and ordinary saves', async () => {
        const env = await open();
        const held = gate();
        env.hooks.beforeAll = async (statement) => {
            if (statement.includes('FROM native_request_receipts')) await held.hold();
        };
        const first = env.adapter.saveDocumentWithReceipt(env.input);
        await held.waiting;
        env.input.data.tasks[0].title = 'Caller mutation';
        env.input.expectedCurrent.tasks[0].title = 'Caller mutation';
        (env.input.reply as typeof reply).added = 999;
        await expect(env.adapter.saveDocumentWithReceipt(env.input)).rejects.toThrow('busy');
        await expect(env.adapter.saveData(original)).rejects.toThrow('busy');
        await expect(env.adapter.saveTask(original.tasks[0])).rejects.toThrow('busy');
        await expect(env.adapter.commitReceiptOnly(ID, payload())).rejects.toThrow('busy');
        held.release();
        expect(await first).toEqual({ reply, replayed: false });
        expect((await env.adapter.getData()).tasks[0].title).toBe('Merged 日本語 🦉');
    });

    it('refuses a direct receipt while an ordinary save is already awaiting IO', async () => {
        const env = await open();
        const held = gate();
        env.hooks.beforeRun = async (statement) => { if (statement === 'BEGIN IMMEDIATE') await held.hold(); };
        const ordinary = env.adapter.saveData(clone(env.input.expectedCurrent));
        await held.waiting;
        await expect(env.adapter.saveDocumentWithReceipt(env.input)).rejects.toThrow('busy');
        held.release();
        await ordinary;
        expect(await env.sql.client.all('SELECT * FROM native_request_receipts')).toEqual([]);
    });

    it('requires guarded storage and rejects pending generation receipts', async () => {
        const env = await open();
        const unguarded = new NativeReceiptSqliteAdapter(env.sql.client);
        await expect(unguarded.saveDocumentWithReceipt(env.input)).rejects.toThrow('requires guarded');
        const receipts = createNativeRequestReceipts({ save: async () => ({ ok: true, value: null }) });
        await receipts.run('33333333-3333-4333-8333-333333333333', JSON.stringify(['backupDocument', 'merge', STAGED, 'b'.repeat(64)]),
            async () => ({ ok: false, error: { code: 'SAVE_FAILED', message: 'owed' }, value: {} }));
        await expect(env.adapter.saveDocumentWithReceipt(env.input)).rejects.toThrow('busy');
    });

    it('refuses queued store work and a UUID reserved by another in-memory action', async () => {
        const env = await open();
        const status = store.getPersistenceStatus();
        const pending = vi.spyOn(store, 'getPersistenceStatus').mockReturnValue({ ...status, queued: 1 });
        await expect(env.adapter.saveDocumentWithReceipt(env.input)).rejects.toThrow('busy');
        pending.mockRestore();
        const receipts = createNativeRequestReceipts({ save: async () => ({ ok: true, value: null }) });
        await receipts.run(ID, '["otherCommand"]', async () => ({ ok: true, value: {} }));
        await expect(env.adapter.saveDocumentWithReceipt(env.input)).rejects.toThrow(/identity/);
    });

    it.each([undefined, null, '🦉'.repeat(MAX_NATIVE_DOCUMENT_RECEIPT_REPLY_BYTES / 4), { nested: BigInt(1) }])('refuses invalid or over-byte-limit reply input', async (badReply) => {
        const env = await open();
        await expect(env.adapter.saveDocumentWithReceipt({ ...env.input, reply: badReply })).rejects.toThrow('Invalid document receipt input');
        expect(env.events).toEqual([]);
    });

    it('accepts a reply exactly at the 64 KiB byte ceiling', async () => {
        const env = await open();
        const atLimit = 'x'.repeat(MAX_NATIVE_DOCUMENT_RECEIPT_REPLY_BYTES - 2);
        expect(await env.adapter.saveDocumentWithReceipt({ ...env.input, reply: atLimit })).toEqual({ reply: atLimit, replayed: false });
    });

    it('logs bounded proof after direct COMMIT only, without making logger failure an import failure', async () => {
        const env = await open();
        let commits = 0;
        env.hooks.beforeRun = async (statement) => { if (statement === 'COMMIT') commits += 1; };
        const info = vi.spyOn(logger, 'logInfo').mockImplementation((message) => {
            if (message === 'Native backup document committed') {
                expect(commits).toBe(1);
                throw new Error('diagnostics unavailable');
            }
        });
        expect(await env.adapter.saveDocumentWithReceipt(env.input)).toEqual({ reply, replayed: false });
        expect(await env.adapter.saveDocumentWithReceipt(env.input)).toEqual({ reply, replayed: true });
        const proof = info.mock.calls.filter(([message]) => message === 'Native backup document committed');
        expect(proof).toEqual([['Native backup document committed', { scope: 'transfer', force: true, context: {
            releaseCheck: 'v1.3.4/native-backup-document', operation: 'merge', outcome: 'committed',
        } }]]);
    });

    it('does not log a committed document proof after persistence failure', async () => {
        const env = await open();
        const info = vi.spyOn(logger, 'logInfo');
        env.hooks.beforeRun = async (statement) => { if (statement === 'COMMIT') throw new Error('disk fault'); };
        await expect(env.adapter.saveDocumentWithReceipt(env.input)).rejects.toThrow('Document receipt persistence failed');
        expect(info.mock.calls.filter(([message]) => message === 'Native backup document committed')).toEqual([]);
    });

    it.each([ID.toUpperCase().replace('1', 'A'), 'not-a-uuid'])('refuses a noncanonical request UUID', async (requestId) => {
        const env = await open();
        await expect(env.adapter.saveDocumentWithReceipt({ ...env.input, requestId })).rejects.toThrow('Invalid document receipt identity');
        expect(env.events).toEqual([]);
    });

    it.each(['["unknown","merge"]', JSON.stringify(['backupDocument', 'merge', STAGED, 'A'.repeat(64)]), ' ' + payload()])('refuses malformed or noncanonical payload tuples', async (badPayload) => {
        const env = await open();
        await expect(env.adapter.saveDocumentWithReceipt({ ...env.input, payload: badPayload })).rejects.toThrow('Invalid document receipt identity');
        expect(env.events).toEqual([]);
    });
});
