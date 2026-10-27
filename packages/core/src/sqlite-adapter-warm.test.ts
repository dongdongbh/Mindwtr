import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openScratchSqlite } from './screen-parity.replay';
import { SqliteAdapter, warmTaskRowEntries } from './sqlite-adapter';
import type { AppData, Task } from './types';

// The first save after a cold start built every task's row (about 108 ms at 5,000 tasks on the S23's QuickJS). The native host
// warms the rows while idle, through the same row cache the save uses.
const AT = '2026-10-27T10:00:00.000Z';
const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const library = (count: number): AppData => ({
    tasks: Array.from({ length: count }, (_, i) => ({ id: `t${i}`, title: `Task ${i}`, status: i % 3 ? 'next' : 'inbox', tags: ['#a'], contexts: [],
        createdAt: AT, updatedAt: AT, rev: 1, revBy: 'device', pushCount: 0 } as Task)),
    projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'device' },
});
// A library on disk, then a cold adapter (as after a process start) and its full read.
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
            // Unwarmed: a fingerprint per read row and per task row. Warmed: the read rows' fingerprints and the one changed task.
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
