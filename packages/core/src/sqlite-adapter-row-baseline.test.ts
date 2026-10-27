import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openScratchSqlite } from './screen-parity.replay';
import { SqliteAdapter } from './sqlite-adapter';
import type { AppData, Person, Task } from './types';

// readRowBaseline: the native boot's check after activation (apps/android-native/bundle/host-entry.ts, activateAndVerify) reads
// row versions instead of whole rows. It must leave the adapter as a full getData() would, or return null.

const AT = '2026-09-01T00:00:00.000Z';
const task = (id: string): Task => ({ id, title: id, status: 'next', tags: [], contexts: [], createdAt: AT, updatedAt: AT, rev: 1, revBy: 'device-a' });
const person = (id: string): Person => ({ id, name: id, createdAt: AT, updatedAt: AT, rev: 1, revBy: 'device-a' });
const empty: AppData = { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} };

type Known = Map<string, Map<string, { rowId: number | null; rev: number | null; updatedAt: string | null }>>;
/** The deletion baseline (private): what a later save may delete by omission, and under which rowid and version. */
const known = (adapter: SqliteAdapter) => (adapter as unknown as { lastKnownRowVersions: Known | null }).lastKnownRowVersions;
const plain = (map: Known | null) => (map ? Object.fromEntries([...map].map(([table, rows]) => [table, Object.fromEntries(rows)])) : null);

describe('SqliteAdapter.readRowBaseline', () => {
    const dirs: string[] = [];
    const closers: (() => void)[] = [];
    afterEach(() => {
        closers.splice(0).forEach((close) => close());
        dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
    });
    const file = () => {
        const dir = mkdtempSync(join(tmpdir(), 'mindwtr-row-baseline-'));
        dirs.push(dir);
        return join(dir, 'mindwtr.db');
    };
    const connect = (path: string) => {
        const opened = openScratchSqlite(path);
        closers.push(opened.close);
        return opened.client;
    };

    it('after a save that created rows, leaves the baseline a full read leaves (their real rowids)', async () => {
        const path = file();
        const adapter = new SqliteAdapter(connect(path), { rejectConcurrentWrites: true });
        await adapter.getData();
        // As an activation that backfills a person: the save knows its new rows only as submitted (no rowid).
        await adapter.saveData({ ...empty, tasks: [task('t1')], people: [person('p1')] });
        expect(known(adapter)?.get('people')?.get('p1')?.rowId).toBeNull();

        const light = await adapter.readRowBaseline();
        const full = new SqliteAdapter(connect(path), { rejectConcurrentWrites: true });
        const data = await full.getData();
        expect(light?.ids).toEqual({
            tasks: data.tasks.map((row) => row.id), projects: [], sections: [], areas: [], people: data.people.map((row) => row.id),
        });
        expect(plain(known(adapter))).toEqual(plain(known(full)));
        expect(known(adapter)?.get('people')?.get('p1')?.rowId).toEqual(expect.any(Number));
        // The epoch it accepted is the one its last full read saw: the next save is not refused as an external change.
        await adapter.saveData({ ...data, tasks: [...data.tasks, task('t2')] });
    });

    it('returns null and changes nothing after another connection committed since the last read', async () => {
        const path = file();
        const adapter = new SqliteAdapter(connect(path), { rejectConcurrentWrites: true });
        await adapter.getData();
        await adapter.saveData({ ...empty, tasks: [task('t1')] });
        const before = known(adapter);
        const other = new SqliteAdapter(connect(path));
        await other.saveTask(task('t2'));

        expect(await adapter.readRowBaseline()).toBeNull();
        expect(known(adapter)).toBe(before);
        // Only a full read is a current baseline now; after it, writes go on.
        const data = await adapter.getData();
        expect(data.tasks.map((row) => row.id).sort()).toEqual(['t1', 't2']);
        await adapter.saveData({ ...data, tasks: [...data.tasks, task('t3')] });
    });

    it('returns null without a full read before it (no accepted epoch)', async () => {
        const adapter = new SqliteAdapter(connect(file()), { rejectConcurrentWrites: true });
        expect(await adapter.readRowBaseline()).toBeNull();
    });

    it('maps the settings row and the saved filters table as getData does', async () => {
        const path = file();
        const client = connect(path);
        const adapter = new SqliteAdapter(client, { rejectConcurrentWrites: true });
        await adapter.getData();
        await client.run('INSERT OR REPLACE INTO settings (id, data) VALUES (1, ?)', [JSON.stringify({ theme: 'dark', ai: { provider: 'openai', apiKey: 'stored' } })]);
        const filter = (id: string, name: string) => [id, name, 'focus', '{}', AT, AT];
        for (const row of [filter('f1', 'One'), filter('f2', 'Two'), filter('', 'Blank id')]) {
            await client.run('INSERT INTO saved_filters (id, name, view, criteria, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)', row);
        }
        const data = await adapter.getData();
        const light = await adapter.readRowBaseline();
        expect(light?.settings).toEqual(data.settings);
        // A blank id maps to nothing, so the table's count (3) and the mapped list (2) differ: the host's check sees it.
        expect(light?.settings.savedFilters?.map((saved) => saved.id)).toEqual(['f1', 'f2']);
    });

    describe('reuse while nothing changed the rows', () => {
        const ROW_READ = 'SELECT rowid AS _rowid, id, rev, updatedAt FROM tasks';
        /** The client with a count of task row-version reads, the part of readRowBaseline a reuse skips. */
        const counting = (path: string) => {
            const client = connect(path);
            const counter = { rowReads: 0 };
            const counted = new Proxy(client, { get: (target, name, receiver) => {
                const value = Reflect.get(target, name, receiver);
                if (name !== 'all' || typeof value !== 'function') return typeof value === 'function' ? value.bind(target) : value;
                return (sql: string, ...rest: unknown[]) => {
                    if (sql === ROW_READ) counter.rowReads += 1;
                    return value.call(target, sql, ...rest);
                };
            } });
            return { client: counted, counter };
        };
        const ready = async (path: string) => {
            const { client, counter } = counting(path);
            const adapter = new SqliteAdapter(client, { rejectConcurrentWrites: true });
            await adapter.getData();
            await adapter.saveData({ ...empty, tasks: [task('t1')] });
            return { adapter, client, counter };
        };

        it('(d) reads the rows once, and the reused result equals a fresh read', async () => {
            const path = file();
            const { adapter, counter } = await ready(path);
            const first = await adapter.readRowBaseline();
            const knownAfterFirst = plain(known(adapter));
            const second = await adapter.readRowBaseline();
            expect(counter.rowReads).toBe(1);
            const fresh = new SqliteAdapter(connect(path), { rejectConcurrentWrites: true });
            await fresh.getData();
            expect(second).toEqual(await fresh.readRowBaseline());
            expect(second).toEqual(first);
            // New objects each call, as a read builds them: a caller's change to one result never reaches the next.
            expect(second).not.toBe(first);
            expect(second?.ids.tasks).not.toBe(first?.ids.tasks);
            expect(second?.settings).not.toBe(first?.settings);
            expect(plain(known(adapter))).toEqual(knownAfterFirst);
        });

        it('(a) a write by this adapter since makes it read the rows again', async () => {
            const { adapter, counter } = await ready(file());
            await adapter.readRowBaseline();
            await adapter.saveTask(task('t2'));
            const light = await adapter.readRowBaseline();
            expect(counter.rowReads).toBe(2);
            expect(light?.ids.tasks.sort()).toEqual(['t1', 't2']);
        });

        it('(a) a write through withConnection since makes it read the rows again', async () => {
            const { adapter, client, counter } = await ready(file());
            await adapter.readRowBaseline();
            await adapter.withConnection(() => client.run("UPDATE tasks SET rev = 2 WHERE id = 't1'"), { write: true });
            await adapter.readRowBaseline();
            expect(counter.rowReads).toBe(2);
            expect(known(adapter)?.get('tasks')?.get('t1')?.rev).toBe(2);
        });

        it("(b) another connection's commit since: null, and after a full read the rows are read again", async () => {
            const path = file();
            const { adapter, counter } = await ready(path);
            await adapter.readRowBaseline();
            await new SqliteAdapter(connect(path)).saveTask(task('t2'));
            expect(await adapter.readRowBaseline()).toBeNull();
            await adapter.getData();
            const light = await adapter.readRowBaseline();
            expect(counter.rowReads).toBe(2);
            expect(light?.ids.tasks.sort()).toEqual(['t1', 't2']);
        });

        it('(c) a direct-SQL invalidation since: no reuse (null until a full read)', async () => {
            const { adapter, counter } = await ready(file());
            await adapter.readRowBaseline();
            (adapter as unknown as { invalidateWriteBaselineAfterDirectSQL(): void }).invalidateWriteBaselineAfterDirectSQL();
            expect(await adapter.readRowBaseline()).toBeNull();
            await adapter.getData();
            await adapter.readRowBaseline();
            expect(counter.rowReads).toBe(2);
        });

        it('(f) never reuses rows older than a full read since (a same-connection change outside the adapter, then getData)', async () => {
            const { adapter, client, counter } = await ready(file());
            await adapter.readRowBaseline();
            await client.run("UPDATE settings SET data = '{\"theme\":\"dark\"}' WHERE id = 1");
            expect((await adapter.getData()).settings.theme).toBe('dark');
            const light = await adapter.readRowBaseline();
            expect(counter.rowReads).toBe(2);
            expect(light?.settings.theme).toBe('dark');
        });

        it('(g) a same-connection change outside the adapter with no full read since: total_changes() makes it read again', async () => {
            const { adapter, client, counter } = await ready(file());
            await adapter.readRowBaseline();
            await client.run("UPDATE settings SET data = '{\"theme\":\"dark\"}' WHERE id = 1");
            const light = await adapter.readRowBaseline();
            expect(counter.rowReads).toBe(2);
            expect(light?.settings.theme).toBe('dark');
        });

        it('(h) a same-connection change landing after the row reads is not taken as read (total_changes() read before them)', async () => {
            const path = file();
            const { client, counter } = counting(path);
            let inject = false;
            const racing = new Proxy(client, { get: (target, name, receiver) => {
                const value = Reflect.get(target, name, receiver);
                if (name !== 'all' || typeof value !== 'function') return typeof value === 'function' ? value.bind(target) : value;
                return async (sql: string, ...rest: unknown[]) => {
                    const rows = await value.call(target, sql, ...rest);
                    // A raw write right after the last row read of this readRowBaseline, before it returns.
                    if (inject && sql.startsWith('SELECT rowid as _rowid, * FROM saved_filters')) {
                        inject = false;
                        await target.run("UPDATE settings SET data = '{\"theme\":\"dark\"}' WHERE id = 1");
                    }
                    return rows;
                };
            } });
            const adapter = new SqliteAdapter(racing, { rejectConcurrentWrites: true });
            await adapter.getData();
            await adapter.saveData({ ...empty, tasks: [task('t1')] });
            inject = true;
            await adapter.readRowBaseline();
            const light = await adapter.readRowBaseline();
            expect(counter.rowReads).toBe(2);
            expect(light?.settings.theme).toBe('dark');
        });

        it("a reuse still runs the subclass's check of the read", async () => {
            const path = file();
            const checks: number[] = [];
            class Checked extends SqliteAdapter {
                fail = false;
                protected override async afterReadNow(loaded: (table: 'tasks') => number): Promise<void> {
                    checks.push(loaded('tasks'));
                    if (this.fail) throw new Error('check failed');
                }
            }
            const adapter = new Checked(connect(path), { rejectConcurrentWrites: true });
            await adapter.getData();
            await adapter.saveData({ ...empty, tasks: [task('t1')] });
            await adapter.readRowBaseline();
            adapter.fail = true;
            await expect(adapter.readRowBaseline()).rejects.toThrow('check failed');
            expect(checks.slice(-2)).toEqual([1, 1]);
        });
    });
});
