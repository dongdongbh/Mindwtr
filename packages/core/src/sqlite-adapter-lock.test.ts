import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { consoleLogger, setLogger, type LogPayload } from './logger';
import { createNativeRequestReceipts, loadNativeRequestReceipts, NativeReceiptSqliteAdapter, resetNativeRequestReceipts } from './native-request-receipts';
import { openScratchSqlite } from './screen-parity.replay';
import { SqliteAdapter, type SqliteClient, type SqliteReadToken } from './sqlite-adapter';
import { runStoreCommand, runSyncStoreSave } from './store-write-gate';
import type { AppData, Task } from './types';

// D9b change 1 (design.md W2-W4): one lock over a guarded adapter's SQL, a read token per snapshot, and the epoch
// bracket around a validated read. A sliced sync cycle (later changes) relies on each rule; every test here fails
// with its rule removed.

const AT = '2026-10-15T00:00:00.000Z';
const task = (id: string, title = id): Task => ({ id, title, status: 'next', tags: [], contexts: [], createdAt: AT, updatedAt: AT, rev: 1, revBy: 'device-a' });
const doc = (tasks: Task[]): AppData => ({ tasks, projects: [], sections: [], areas: [], people: [], settings: {} });
const ENTITY_TABLES = ['tasks', 'projects', 'sections', 'areas', 'people'] as const;
const stale = () => new Error('stale-db');
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type Gate = { wait: Promise<void>; open: () => void };
const gate = (): Gate => {
    let open!: () => void;
    const wait = new Promise<void>((resolve) => { open = resolve; });
    return { wait, open };
};

/** A client that logs each statement and lets a test hold the statement after a matching one. */
const instrumented = (inner: SqliteClient) => {
    const log: string[] = [];
    const hooks: { before?: (sql: string) => Promise<void> | void } = {};
    const step = async (sql: string) => { log.push(sql.trim()); await hooks.before?.(sql.trim()); };
    const client: SqliteClient = {
        run: async (sql, params) => { await step(sql); return inner.run(sql, params); },
        all: async <T,>(sql: string, params?: unknown[]) => { await step(sql); return inner.all<T>(sql, params); },
        get: async <T,>(sql: string, params?: unknown[]) => { await step(sql); return inner.get<T>(sql, params); },
        exec: async (sql) => { await step(sql); return inner.exec!(sql); },
    };
    return { client, log, hooks };
};

/** host-entry's ValidatedSqliteAdapter check, in the read's own hold: the database's row counts equal the read's. */
class CountingAdapter extends NativeReceiptSqliteAdapter {
    constructor(private readonly raw: SqliteClient, options?: ConstructorParameters<typeof NativeReceiptSqliteAdapter>[1]) {
        super(raw, options);
    }

    protected override async afterReadNow(loaded: (table: typeof ENTITY_TABLES[number]) => number): Promise<void> {
        for (const table of ENTITY_TABLES) {
            const rows = await this.raw.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
            if (loaded(table) !== rows?.n) throw new Error(`Incomplete ${table} load`);
        }
    }
}

describe('SqliteAdapter lock, read tokens and epoch bracket', () => {
    const dirs: string[] = [];
    const closers: (() => void)[] = [];
    afterEach(() => {
        resetNativeRequestReceipts();
        closers.splice(0).forEach((close) => close());
        dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
    });
    const file = () => {
        const dir = mkdtempSync(join(tmpdir(), 'mindwtr-adapter-lock-'));
        dirs.push(dir);
        return join(dir, 'mindwtr.db');
    };
    const open = (path: string) => {
        const sql = openScratchSqlite(path);
        closers.push(sql.close);
        return sql.client;
    };
    const seeded = async (tasks: Task[] = [task('a'), task('b')]) => {
        const path = file();
        await new SqliteAdapter(open(path)).saveData(doc(tasks));
        return path;
    };

    it('runs no SQL of a queued search, calendar read or host read while a guarded save holds its transaction', async () => {
        const io = instrumented(open(await seeded()));
        const adapter = new SqliteAdapter(io.client, { rejectConcurrentWrites: true });
        await adapter.getData();
        const held = gate();
        let paused = false;
        io.hooks.before = async (sql) => {
            if (!paused && sql.startsWith('INSERT INTO tasks')) { paused = true; await held.wait; }
        };
        const save = adapter.saveData(doc([task('a', 'renamed'), task('b')]));
        while (!paused) await tick();
        const at = io.log.length;
        const queued = [
            adapter.queryTasks({}),
            adapter.searchAll('renamed'),
            adapter.getCalendarSyncEntry('a', 'android'),
            adapter.withConnection(() => io.client.get('SELECT COUNT(*) AS n FROM tasks')),
        ];
        for (let i = 0; i < 5; i += 1) await tick();
        expect(io.log.slice(at)).toEqual([]);
        const logs: LogPayload[] = [];
        setLogger((payload) => { logs.push(payload); });
        held.open();
        await save;
        const [tasks] = await Promise.all(queued);
        setLogger(consoleLogger);
        // The tester's proof: one line per adapter, for the first caller that waited.
        expect(logs.filter((entry) => entry.context?.releaseCheck === 'v1.3.7/sqlite-adapter-lock')
            .map((entry) => [entry.message, entry.context?.operation, entry.force])).toEqual([['SQLite adapter lock serialized a caller', 'queryTasks', true]]);
        expect((tasks as Task[]).find((row) => row.id === 'a')?.title).toBe('renamed');
        expect(io.log.indexOf('COMMIT')).toBeLessThan(io.log.findIndex((sql, index) => index > at && sql.startsWith('SELECT * FROM tasks')));
    });

    it('leaves an unguarded adapter (React Native) unserialized', async () => {
        const io = instrumented(open(await seeded()));
        const adapter = new SqliteAdapter(io.client);
        await adapter.getData();
        const held = gate();
        let paused = false;
        io.hooks.before = async (sql) => {
            if (!paused && sql.startsWith('INSERT INTO tasks')) { paused = true; await held.wait; }
        };
        const save = adapter.saveData(doc([task('a', 'renamed'), task('b')]));
        while (!paused) await tick();
        const tasks = await adapter.queryTasks({});
        expect(tasks.find((row) => row.id === 'a')?.title).toBe('a');
        held.open();
        await save;
    });

    it('validates a read in the read\'s own hold, so a capture save queued during it never looks like an incomplete load', async () => {
        const io = instrumented(open(await seeded()));
        const adapter = new CountingAdapter(io.client, { rejectConcurrentWrites: true });
        await adapter.getData();
        for (const read of [() => adapter.getData(), () => adapter.readRowBaseline()]) {
            let queued: Promise<void> | null = null;
            io.hooks.before = (sql) => {
                if (!queued && sql === 'SELECT data FROM settings WHERE id = 1') {
                    queued = adapter.saveTask(task(`capture-${io.log.length}`));
                }
            };
            await expect(read()).resolves.toBeTruthy();
            io.hooks.before = undefined;
            await queued;
        }
    });

    it('keeps the "Incomplete … load" error for a validation failure with no external commit', async () => {
        const path = await seeded();
        const raw = open(path);
        const adapter = new (class extends CountingAdapter {
            protected override async afterReadNow(): Promise<void> { throw new Error('Incomplete tasks load'); }
        })(raw, { rejectConcurrentWrites: true });
        await expect(adapter.getData()).rejects.toThrow('Incomplete tasks load');
        await expect(adapter.getData({ onStale: stale })).rejects.toThrow('Incomplete tasks load');
    });

    it('turns an external commit during validation into onStale, passing validation or not', async () => {
        const path = await seeded();
        const other = new SqliteAdapter(open(path));
        await other.getData();
        let commits = 0;
        for (const failing of [false, true]) {
            const raw = open(path);
            const adapter = new (class extends CountingAdapter {
                protected override async afterReadNow(): Promise<void> {
                    // A title-only change on another connection leaves every count equal.
                    commits += 1;
                    await other.saveData(doc([task('a', `external-${commits}`), task('b')]));
                    if (failing) throw new Error('Incomplete tasks load');
                }
            })(raw, { rejectConcurrentWrites: true });
            await expect(adapter.getData({ onStale: stale })).rejects.toThrow('stale-db');
            // Without onStale (every caller today), a failure caused by the commit is the external-change error.
            if (failing) await expect(adapter.getData()).rejects.toThrow(/^SQLITE_BUSY: .*database changed while loading/);
        }
    });

    it('does not deadlock a document save whose commit hook measures the library under the lock', async () => {
        const path = await seeded();
        const raw = open(path);
        resetNativeRequestReceipts();
        await loadNativeRequestReceipts(raw, { durableCommands: ['backupDocument'] });
        const adapter = new NativeReceiptSqliteAdapter(raw, { rejectConcurrentWrites: true });
        const expectedCurrent = await adapter.getData();
        const save = adapter.saveDocumentWithReceipt({
            requestId: '11111111-1111-4111-8111-111111111111',
            payload: JSON.stringify(['backupDocument', 'merge', '22222222-2222-4222-8222-222222222222', 'a'.repeat(64)]),
            expectedCurrent,
            data: doc([task('a', 'imported'), task('b')]),
            reply: { snapshotName: 'data.2026-10-15T00-00-00.000.snapshot.json', added: 0, updated: 1 },
            maxLibraryBytes: 1024 * 1024 * 1024,
        });
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('deadlock')), 2000));
        await expect(Promise.race([save, timeout])).resolves.toMatchObject({ replayed: false });
        expect((await adapter.getData()).tasks.find((row) => row.id === 'a')?.title).toBe('imported');
    });

    it('authorizes a save only by its own read\'s token, and refuses one after any other write', async () => {
        const path = await seeded();
        const io = instrumented(open(path));
        const adapter = new NativeReceiptSqliteAdapter(io.client, { rejectConcurrentWrites: true });
        const readA = await adapter.getData();
        const tokenA = adapter.readTokenOf(readA) as SqliteReadToken;
        expect(tokenA).toBeTruthy();

        // A local write (a capture) after the read voids the token; the refused save writes nothing.
        await adapter.saveTask(task('capture'));
        const before = io.log.length;
        await expect(adapter.saveData(doc([task('a', 'stale'), task('b')]), { token: tokenA, onStale: stale })).rejects.toThrow('stale-db');
        expect(io.log.slice(before).filter((sql) => /^(INSERT|UPDATE|DELETE)/.test(sql))).toEqual([]);
        expect((await new SqliteAdapter(open(path)).getData()).tasks.map((row) => row.title).sort()).toEqual(['a', 'b', 'capture']);

        // A newer read authorizes only its own snapshot; the successor token authorizes only the next save.
        const readB = await adapter.getData();
        const saved = doc([...readB.tasks.map((row) => (row.id === 'a' ? { ...row, title: 'merged', rev: 2 } : row))]);
        await adapter.saveData(saved, { token: adapter.readTokenOf(readB), onStale: stale });
        const successor = adapter.readTokenOf(saved);
        expect(successor).toBeTruthy();
        await adapter.upsertCalendarSyncEntry({ taskId: 'a', calendarEventId: 'e', calendarId: 'c', platform: 'android', lastSyncedAt: AT });
        await expect(adapter.saveData(saved, { token: successor, onStale: stale })).rejects.toThrow('stale-db');

        // A missing token fails closed.
        await expect(adapter.saveData(saved, { onStale: stale })).rejects.toThrow(/no read token/);
    });

    it('voids the successor token with a receipt-only commit and a host write', async () => {
        const path = await seeded();
        const raw = open(path);
        resetNativeRequestReceipts();
        await loadNativeRequestReceipts(raw, { durableCommands: ['appLock'] });
        const adapter = new NativeReceiptSqliteAdapter(raw, { rejectConcurrentWrites: true });
        const receipts = createNativeRequestReceipts({
            save: async () => ({ ok: true, value: null }),
            receiptOnly: (requestId, payload) => adapter.commitReceiptOnly(requestId, payload),
        });
        const writes = [
            () => adapter.withConnection(() => raw.run('DELETE FROM native_request_receipts WHERE 0'), { write: true }),
            async () => {
                const reply = await receipts.run('11111111-1111-4111-8111-111111111111', JSON.stringify(['appLock', true]), async () => ({ ok: true, value: 'locked' }));
                expect(reply).toEqual({ ok: true, value: 'locked' });
                expect(await raw.all('SELECT request_id FROM native_request_receipts')).toHaveLength(1);
            },
        ];
        for (const write of writes) {
            const read = await adapter.getData();
            await adapter.saveData(read, { token: adapter.readTokenOf(read), onStale: stale });
            const successor = adapter.readTokenOf(read);
            await write();
            await expect(adapter.saveData(read, { token: successor, onStale: stale })).rejects.toThrow('stale-db');
        }
    });

    it('keeps the last save\'s fingerprints after a refused save, so the next save is no full rewrite', async () => {
        const tasks = Array.from({ length: 20 }, (_, index) => task(`t${index}`));
        const path = await seeded(tasks);
        const adapter = new SqliteAdapter(open(path), { rejectConcurrentWrites: true });
        const read = await adapter.getData();
        await adapter.saveData(read, { token: adapter.readTokenOf(read), onStale: stale });
        const successor = adapter.readTokenOf(read);
        await adapter.saveTask({ ...read.tasks[0], title: 'capture', rev: 2 });
        await expect(adapter.saveData(read, { token: successor, onStale: stale })).rejects.toThrow('stale-db');
        // No read in between: the fingerprints of the last committed save stand in (task 0's capture differs from them too).
        await adapter.saveData({ ...read, tasks: read.tasks.map((row, index) => (index === 1 ? { ...row, title: 'one', rev: 2 } : row)) });
        expect(adapter.getLastSaveDataStats()).toMatchObject({ incremental: true, writtenRows: 2 });
    });

    it('keeps the cold-start read\'s rows after a refused first save, so the next save is no full rewrite', async () => {
        const tasks = Array.from({ length: 20 }, (_, index) => task(`t${index}`));
        const adapter = new SqliteAdapter(open(await seeded(tasks)), { rejectConcurrentWrites: true });
        const read = await adapter.getData();
        await adapter.upsertCalendarSyncEntry({ taskId: 't0', calendarEventId: 'e', calendarId: 'c', platform: 'android', lastSyncedAt: AT });
        await expect(adapter.saveData(read, { token: adapter.readTokenOf(read), onStale: stale })).rejects.toThrow('stale-db');
        await adapter.saveData({ ...read, tasks: read.tasks.map((row, index) => (index === 1 ? { ...row, title: 'one', rev: 2 } : row)) });
        expect(adapter.getLastSaveDataStats()).toMatchObject({ incremental: true, writtenRows: 1 });
    });

    it('runs no public adapter method or store command from inside a lock hold', () => {
        const source = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
        const hostEntry = readFileSync(fileURLToPath(new URL('../../../apps/android-native/bundle/host-entry.ts', import.meta.url)), 'utf8');
        const block = (text: string, open: number, [opener, closer]: [string, string] = ['{', '}']) => {
            let depth = 0;
            for (let end = open; end < text.length; end += 1) {
                if (text[end] === opener) depth += 1;
                else if (text[end] === closer && --depth === 0) return text.slice(open, end + 1);
            }
            throw new Error('unbalanced');
        };
        // The public API runs outside any hold (each public method only takes the lock and runs its body). Every other method
        // of the three adapter classes can run inside a hold: …Now bodies, hooks, and the private helpers they call.
        const outsideHold = new Set(['constructor', 'getData', 'saveData', 'saveTask', 'readRowBaseline', 'queryTasks', 'searchAll',
            'ensureSchema', 'libraryBytes', 'commitReceiptOnly', 'readDurableReceipt', 'hasForeignKeyViolations', 'withConnection',
            'saveDocumentWithReceipt', 'getCalendarSyncEntry', 'upsertCalendarSyncEntry', 'deleteCalendarSyncEntry',
            'getAllCalendarSyncEntries', 'verifyActivation', 'armReceiptPrerequisite', 'clearReceiptPrerequisite',
            'getLastSaveDataStats', 'readTokenOf', 'concurrentWritesGuarded']);
        const held: string[] = [];
        const classes: [string, string][] = [[source('./sqlite-adapter.ts'), 'export class SqliteAdapter {'],
            [source('./native-request-receipts.ts'), 'export class NativeReceiptSqliteAdapter extends SqliteAdapter {'],
            [hostEntry, 'class ValidatedSqliteAdapter extends NativeReceiptSqliteAdapter {']];
        for (const [text, header] of classes) {
            const body = block(text, text.indexOf('{', text.indexOf(header)));
            const methods = /\n {4}(?:(?:protected|private|public|override|async|static|get)\s+)*(\w+)\s*(?:<[^\n(]*>)?\(/g;
            for (let match = methods.exec(body); match; match = methods.exec(body)) {
                if (outsideHold.has(match[1])) continue;
                held.push(`${match[1]}: ${block(body, body.indexOf(' {\n', match.index) + 1)}`);
            }
            // The document save's whole hold.
            const document = body.indexOf("this.exclusive('saveDocumentWithReceipt'");
            if (document >= 0) held.push(`saveDocumentWithReceipt: ${block(body, body.indexOf('(', document), ['(', ')'])}`);
        }
        // The host's own SQL: each callback it hands withConnection.
        const calls = /\b(?:withConnection|withHostConnection)\(/g;
        for (let match = calls.exec(hostEntry); match; match = calls.exec(hostEntry)) {
            held.push(`withConnection: ${block(hostEntry, match.index + match[0].length - 1, ['(', ')'])}`);
        }
        const names = held.map((body) => body.slice(0, body.indexOf(':')));
        for (const name of ['ensureSchemaNow', 'ensureSchemaInternal', 'ensureFtsPopulated', 'getDataNow', 'readRowBaselineNow', 'saveTaskNow',
            'saveDataNow', 'libraryBytesNow', 'commitReceiptOnlyNow', 'readCurrentReceipt', 'beforeCommit', 'afterReadNow', 'validate',
            'saveDocumentWithReceipt']) expect(names).toContain(name);
        expect(names.filter((name) => name === 'withConnection').length).toBeGreaterThanOrEqual(7);
        const publicCall = [...outsideHold].filter((name) => name !== 'constructor' && name !== 'readTokenOf').join('|');
        const reentry = new RegExp(`\\.(?:${publicCall})\\(|\\brunStoreCommand\\(|\\brunSyncStoreSave\\(|\\buseTaskStore\\b|\\bfetchData\\(`);
        expect(held.filter((body) => reentry.test(body)).map((body) => body.slice(0, 80))).toEqual([]);
    });

    it('runs the SQL of every public method of the three adapter classes inside a lock hold', async () => {
        const path = await seeded();
        const raw = open(path);
        resetNativeRequestReceipts();
        await loadNativeRequestReceipts(raw, { durableCommands: ['appLock', 'backupDocument'] });
        let adapter: CountingAdapter | null = null;
        const outside: string[] = [];
        const held = () => (adapter as unknown as { lockHeld: boolean } | null)?.lockHeld === true;
        const check = (sql: string) => { if (!held()) outside.push(sql.trim().slice(0, 60)); };
        const strict: SqliteClient = {
            run: async (sql, params) => { check(sql); return raw.run(sql, params); },
            all: async <T,>(sql: string, params?: unknown[]) => { check(sql); return raw.all<T>(sql, params); },
            get: async <T,>(sql: string, params?: unknown[]) => { check(sql); return raw.get<T>(sql, params); },
            exec: async (sql) => { check(sql); return raw.exec!(sql); },
        };
        // CountingAdapter stands in for host-entry's ValidatedSqliteAdapter: its check reads the raw client, in the hold.
        adapter = new CountingAdapter(strict, { rejectConcurrentWrites: true });
        const receipts = createNativeRequestReceipts({
            save: async () => ({ ok: true, value: null }),
            receiptOnly: (requestId, payload) => adapter!.commitReceiptOnly(requestId, payload),
        });
        const calls: [string, () => Promise<unknown>][] = [
            ['ensureSchema', () => adapter!.ensureSchema()],
            ['getData', () => adapter!.getData()],
            ['readRowBaseline', () => adapter!.readRowBaseline()],
            ['queryTasks', () => adapter!.queryTasks({})],
            ['searchAll', () => adapter!.searchAll('a')],
            ['saveTask', () => adapter!.saveTask(task('c'))],
            ['saveData', async () => adapter!.saveData(await adapter!.getData())],
            ['upsertCalendarSyncEntry', () => adapter!.upsertCalendarSyncEntry({ taskId: 'a', calendarEventId: 'e', calendarId: 'c', platform: 'android', lastSyncedAt: AT })],
            ['getCalendarSyncEntry', () => adapter!.getCalendarSyncEntry('a', 'android')],
            ['getAllCalendarSyncEntries', () => adapter!.getAllCalendarSyncEntries('android')],
            ['deleteCalendarSyncEntry', () => adapter!.deleteCalendarSyncEntry('a', 'android')],
            ['withConnection', () => adapter!.withConnection(() => strict.get('SELECT 1 AS one'))],
            ['readDurableReceipt', () => adapter!.readDurableReceipt('11111111-1111-4111-8111-111111111111', '["appLock",true]')],
            ['hasForeignKeyViolations', () => adapter!.hasForeignKeyViolations()],
            ['libraryBytes', () => adapter!.libraryBytes()],
            ['commitReceiptOnly', () => receipts.run('11111111-1111-4111-8111-111111111111', JSON.stringify(['appLock', true]), async () => ({ ok: true, value: 'locked' }))],
            ['saveDocumentWithReceipt', async () => adapter!.saveDocumentWithReceipt({
                requestId: '33333333-3333-4333-8333-333333333333',
                payload: JSON.stringify(['backupDocument', 'merge', '22222222-2222-4222-8222-222222222222', 'a'.repeat(64)]),
                expectedCurrent: await adapter!.getData(), data: doc([task('a', 'imported'), task('b'), task('c')]),
                reply: { snapshotName: 'data.2026-10-15T00-00-00.000.snapshot.json', added: 0, updated: 1 },
            })],
        ];
        for (const [name, call] of calls) {
            outside.length = 0;
            await call();
            expect([name, outside]).toEqual([name, []]);
        }
        expect(await raw.all('SELECT request_id FROM native_request_receipts')).toHaveLength(2);
    });

    it('turns two moved read attempts into onStale, and keeps today\'s error without one', async () => {
        const raw = open(await seeded());
        let epoch = 0;
        const moving: SqliteClient = {
            ...raw,
            // Another connection commits between every two reads of data_version.
            get: async <T,>(sql: string, params?: unknown[]) => (sql === 'PRAGMA data_version'
                ? ({ data_version: ++epoch } as T) : raw.get<T>(sql, params)),
        };
        const adapter = new SqliteAdapter(moving, { rejectConcurrentWrites: true });
        await expect(adapter.getData({ onStale: stale })).rejects.toThrow('stale-db');
        await expect(adapter.getData()).rejects.toThrow(/^SQLITE_BUSY: .*database changed while loading/);
    });

    it('refuses a stale token without onStale with the external-change error, not a TypeError', async () => {
        const adapter = new SqliteAdapter(open(await seeded()), { rejectConcurrentWrites: true });
        const read = await adapter.getData();
        await adapter.saveTask(task('capture'));
        await expect(adapter.saveData(read, { token: adapter.readTokenOf(read) })).rejects.toThrow(/^SQLITE_BUSY: .*stale read token/);
    });

    it('lets a command wait on the lock inside the store gate while a host body holds it, and a sync save wait on the gate', async () => {
        const adapter = new SqliteAdapter(open(await seeded()), { rejectConcurrentWrites: true });
        await adapter.getData();
        const order: string[] = [];
        const held = gate();
        const host = adapter.withConnection(async () => { order.push('host'); await held.wait; });
        // Gate, then lock: the command holds the gate and queues on the adapter lock behind the host body.
        const command = runStoreCommand(async () => { const data = await adapter.getData(); order.push('command'); return data; });
        const save = runSyncStoreSave(async () => { await adapter.saveData(doc([task('a', 'synced'), task('b')])); order.push('save'); });
        for (let i = 0; i < 5; i += 1) await tick();
        expect(order).toEqual(['host']);
        held.open();
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('deadlock')), 2000));
        await expect(Promise.race([Promise.all([host, command, save]), timeout])).resolves.toBeTruthy();
        expect(order).toEqual(['host', 'command', 'save']);
    });

    it('keeps queued callers out of a guarded save that rolls back, and commits their writes after it', async () => {
        const path = await seeded();
        const io = instrumented(open(path));
        const adapter = new SqliteAdapter(io.client, { rejectConcurrentWrites: true });
        await adapter.getData();
        const held = gate();
        let paused = false;
        let wroteTask = false;
        io.hooks.before = async (sql) => {
            // The renamed row is written inside the transaction; the statement after it fails and rolls the save back.
            if (wroteTask && !paused) {
                paused = true;
                await held.wait;
                throw new Error('injected commit failure');
            }
            if (sql.startsWith('INSERT INTO tasks')) wroteTask = true;
        };
        const save = adapter.saveData(doc([task('a', 'renamed'), task('b')]));
        while (!paused) await tick();
        const read = adapter.queryTasks({});
        const capture = adapter.saveTask(task('capture'));
        held.open();
        await expect(save).rejects.toThrow('injected commit failure');
        expect((await read).map((row) => row.title).sort()).toEqual(['a', 'b']);
        await capture;
        expect((await new SqliteAdapter(open(path)).getData()).tasks.map((row) => row.title).sort()).toEqual(['a', 'b', 'capture']);
    });

    it('gives no row baseline when another connection commits during the row-version read\'s check', async () => {
        const path = await seeded();
        const other = new SqliteAdapter(open(path));
        await other.getData();
        let commit = false;
        const adapter = new (class extends CountingAdapter {
            protected override async afterReadNow(loaded: (table: 'tasks' | 'projects' | 'sections' | 'areas' | 'people') => number): Promise<void> {
                await super.afterReadNow(loaded);
                if (commit) await other.saveData(doc([task('a', 'external'), task('b')]));
            }
        })(open(path), { rejectConcurrentWrites: true });
        await adapter.getData();
        commit = true;
        expect(await adapter.readRowBaseline()).toBeNull();
    });

    it('requeues an external commit through onStale on a token save, and keeps today\'s error without one', async () => {
        const path = await seeded();
        const adapter = new SqliteAdapter(open(path), { rejectConcurrentWrites: true });
        const other = new SqliteAdapter(open(path));
        const read = await adapter.getData();
        await other.getData();
        await other.saveData(doc([task('a', 'external'), task('b')]));
        await expect(adapter.saveData(read, { token: adapter.readTokenOf(read), onStale: stale })).rejects.toThrow('stale-db');
        await expect(adapter.saveData(read)).rejects.toThrow(/^SQLITE_BUSY: .*external commit/);
    });

    it('lets queued SQL run while a search waits out another process\'s FTS rebuild lock', async () => {
        const path = await seeded();
        const io = instrumented(open(path));
        const adapter = new SqliteAdapter(io.client, { rejectConcurrentWrites: true });
        await adapter.getData();
        await io.client.run('CREATE TABLE IF NOT EXISTS fts_lock (id INTEGER PRIMARY KEY, owner TEXT, acquiredAt INTEGER)');
        await io.client.run('INSERT OR REPLACE INTO fts_lock (id, owner, acquiredAt) VALUES (1, ?, ?)', ['other-process', Date.now()]);
        let failed = false;
        io.hooks.before = (sql) => {
            if (!failed && sql.includes('tasks_fts MATCH')) { failed = true; throw new Error('database disk image is malformed'); }
        };
        const search = adapter.searchAll('a');
        while (!failed) await tick();
        const startedAt = Date.now();
        await adapter.queryTasks({});
        expect(Date.now() - startedAt).toBeLessThan(150);
        await search;
    });
});
