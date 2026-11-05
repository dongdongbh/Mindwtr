import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openScratchSqlite } from './screen-parity.replay';
import { SqliteAdapter, warmTaskRowEntries } from './sqlite-adapter';
import type { AppData, Task } from './types';


const AT = '2026-10-27T10:00:00.000Z';
const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const library = (count: number): AppData => ({
    tasks: Array.from({ length: count }, (_, i) => ({ id: `t${i}`, title: `Task ${i}`, status: i % 3 ? 'next' : 'inbox', tags: ['#a'], contexts: [],
        createdAt: AT, updatedAt: AT, rev: 1, revBy: 'device', pushCount: 0 } as Task)),
    projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'device' },
});

const cold = async (data: AppData) => {
    const dir = mkdtempSync(join(tmpdir(), 'warm-adapter-')); directories.push(dir);
    const file = join(dir, 'warm.sqlite');
    const first = openScratchSqlite(file);
    await new SqliteAdapter(first.client).saveData(data);
    first.close();
    const sql = openScratchSqlite(file);
    const adapter = new SqliteAdapter(sql.client, { rejectConcurrentWrites: true });
    const read = await adapter.getData();
    return { sql, adapter, read };
};
const rows = async (sql: ReturnType<typeof openScratchSqlite>) => JSON.stringify(await sql.client.all('SELECT * FROM tasks ORDER BY id'));
const warmRows = (tasks: readonly Task[]) => { for (let from = 0; from < tasks.length;) from = warmTaskRowEntries(tasks, from, 50); };
const stringifiesDuring = async (work: () => Promise<void>) => {
    const spy = vi.spyOn(JSON, 'stringify');
    await work();
    const calls = spy.mock.calls.length;
    spy.mockRestore();
    return calls;
};
const change = (read: AppData): AppData => ({ ...read, tasks: read.tasks.map((task) => task.id === 't5' ? { ...task, title: 'Changed' } : task) });

describe('warming the first save\'s task rows', () => {
    it('leaves the first save no row to build, and it writes what an unwarmed save writes', async () => {
        const data = library(300);
        const plain = await cold(data);
        const warm = await cold(data);
        try {
            const unwarmed = await stringifiesDuring(() => plain.adapter.saveData(change(plain.read)));
            warmRows(warm.read.tasks);
            const next = change(warm.read);
            const warmed = await stringifiesDuring(() => warm.adapter.saveData(next));

            expect(unwarmed).toBeGreaterThanOrEqual(600);
            expect(warmed).toBeLessThanOrEqual(unwarmed - 290);
            expect(await rows(warm.sql)).toBe(await rows(plain.sql));
        } finally { plain.sql.close(); warm.sql.close(); }
    });

    it('rebuilds a task edited after the warm, never serving its old row', async () => {
        const { sql, adapter, read } = await cold(library(40));
        try {
            warmRows(read.tasks);
            await adapter.saveData({ ...read, tasks: read.tasks.map((task) => task.id === 't7' ? { ...task, title: 'Edited after warm', rev: 2 } : task) });
            expect(await sql.client.all('SELECT title, rev FROM tasks WHERE id = ?', ['t7'])).toEqual([{ title: 'Edited after warm', rev: 2 }]);
        } finally { sql.close(); }
    });
});


const warmAll = (adapter: SqliteAdapter, tasks: readonly Task[]) => {
    warmRows(tasks);
    while (!adapter.warmReadFingerprints(50)) {                    }
};

describe('warming the first save\'s read fingerprints', () => {
    it('leaves the first save almost no fingerprint work, and it writes what an unwarmed save writes', async () => {
        const data = library(300);
        const plain = await cold(data);
        const warm = await cold(data);
        try {
            const unwarmed = await stringifiesDuring(() => plain.adapter.saveData(change(plain.read)));
            warmAll(warm.adapter, warm.read.tasks);
            const next = change(warm.read);
            const warmed = await stringifiesDuring(() => warm.adapter.saveData(next));
            expect(unwarmed).toBeGreaterThanOrEqual(600);
            expect(warmed).toBeLessThan(40);
            expect(await rows(warm.sql)).toBe(await rows(plain.sql));
        } finally { plain.sql.close(); warm.sql.close(); }
    });

    it('leaves the warmed fingerprints unused once a write ran after the read', async () => {
        const { sql, adapter, read } = await cold(library(40));
        try {
            warmAll(adapter, read.tasks);
            await adapter.saveTask({ ...read.tasks[3], title: 'Written in between', rev: 2 });
            await adapter.saveData({ ...read, tasks: read.tasks.map((task) => task.id === 't3' ? { ...task, title: 'Saved after', rev: 3 } : task) });
            expect(await sql.client.all('SELECT title, rev FROM tasks WHERE id = ?', ['t3'])).toEqual([{ title: 'Saved after', rev: 3 }]);
            expect(await sql.client.all('SELECT COUNT(*) AS c FROM tasks')).toEqual([{ c: 40 }]);
        } finally { sql.close(); }
    });

    it('writes exactly what an unwarmed save writes when a raw caller edited its read objects in place after the warm', async () => {
        const data = library(60);
        const plainDb = await cold(data);
        const warmDb = await cold(data);
        try {

            const plain = await plainDb.adapter.getData({ rawTasks: true });
            const warm = await warmDb.adapter.getData({ rawTasks: true });
            warmAll(warmDb.adapter, warm.tasks);
            for (const read of [plain, warm]) {
                read.tasks[1].title = 'Edited in place';
                read.tasks[2].tags = ['#edited'];
                read.tasks.splice(4, 1);
            }
            await plainDb.adapter.saveData(plain);
            await warmDb.adapter.saveData(warm);
            expect(await rows(warmDb.sql)).toBe(await rows(plainDb.sql));
            expect(await warmDb.sql.client.all('SELECT title FROM tasks WHERE id = ?', ['t1'])).toEqual([{ title: 'Edited in place' }]);
        } finally { plainDb.sql.close(); warmDb.sql.close(); }
    });
});


describe('the warmed read fingerprints are used only for the same read with no write since', () => {
    const title = async (sql: ReturnType<typeof openScratchSqlite>) => (await sql.client.all<{ title: string }>('SELECT title FROM tasks WHERE id = ?', ['t3']))[0].title;

    it('ignores them after this adapter wrote between the warm and the save (writesStarted)', async () => {
        const { sql, adapter, read } = await cold(library(10));
        try {
            while (!adapter.warmReadFingerprints(3)) {                   }
            await adapter.saveTask({ ...read.tasks[3], title: 'B' });

            await adapter.saveData(read);
            expect(await title(sql)).toBe('Task 3');
        } finally { sql.close(); }
    });

    it('ignores them for a newer read, after another connection committed (the read object)', async () => {
        const data = library(10);
        const dir = mkdtempSync(join(tmpdir(), 'warm-guard-')); directories.push(dir);
        const file = join(dir, 'guard.sqlite');
        const first = openScratchSqlite(file);
        await new SqliteAdapter(first.client).saveData(data);
        first.close();
        const sql = openScratchSqlite(file);
        const adapter = new SqliteAdapter(sql.client, { rejectConcurrentWrites: true });
        try {
            const read = await adapter.getData();
            while (!adapter.warmReadFingerprints(3)) {                   }
            const other = openScratchSqlite(file);
            await other.client.run('UPDATE tasks SET title = ? WHERE id = ?', ['B', 't3']);
            other.close();
            await adapter.getData();
            await adapter.saveData(read);
            expect(await title(sql)).toBe('Task 3');
        } finally { sql.close(); }
    });

    it('fills every table the save compares (tasks, projects, sections, areas, people, saved filters) as a recompute does', async () => {
        const six = (): AppData => ({
            ...library(30),
            projects: [{ id: 'p1', title: 'Project', status: 'active', color: '#123456', order: 0, tagIds: [], createdAt: AT, updatedAt: AT }],
            sections: [{ id: 's1', projectId: 'p1', title: 'Section', order: 0, createdAt: AT, updatedAt: AT }],
            areas: [{ id: 'a1', name: 'Area', order: 0, createdAt: AT, updatedAt: AT }],
            people: [{ id: 'u1', name: 'Person', createdAt: AT, updatedAt: AT }],
            settings: { deviceId: 'device', savedFilters: [{ id: 'f1', name: 'Filter', view: 'tasks', criteria: { tags: ['#a'] }, createdAt: AT, updatedAt: AT }] },
        } as AppData);
        const plain = await cold(six());
        const warm = await cold(six());
        const all = async (sql: ReturnType<typeof openScratchSqlite>) => JSON.stringify(await Promise.all(['tasks', 'projects', 'sections', 'areas', 'people', 'saved_filters', 'settings']
            .map((table) => sql.client.all(`SELECT * FROM ${table} ORDER BY rowid`))));
        try {
            const edit = (read: AppData): AppData => ({ ...read,
                projects: read.projects.map((project) => ({ ...project, title: 'Project renamed' })),
                areas: read.areas.map((area) => ({ ...area, name: 'Area renamed' })) });
            await plain.adapter.saveData(edit(plain.read));
            for (let from = 0; from < warm.read.tasks.length;) from = warmTaskRowEntries(warm.read.tasks, from, 7);
            let slices = 0;
            while (!warm.adapter.warmReadFingerprints(7)) slices += 1;
            expect(slices).toBeGreaterThanOrEqual(4);
            const warmed = await stringifiesDuring(() => warm.adapter.saveData(edit(warm.read)));
            expect(warmed).toBeLessThan(40);
            expect(await all(warm.sql)).toBe(await all(plain.sql));
        } finally { plain.sql.close(); warm.sql.close(); }
    });
});
