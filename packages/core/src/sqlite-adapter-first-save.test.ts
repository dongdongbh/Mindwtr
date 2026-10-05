import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openScratchSqlite } from './screen-parity.replay';
import { SqliteAdapter } from './sqlite-adapter';
import type { AppData, Task } from './types';

// A cold start's first save (the native host's boot sync, D9): the adapter has no fingerprints of its own yet, so it compares
// against the rows its last full read saw instead of rewriting every row. Those rows stand in only while nothing was written.

const AT = '2026-09-01T00:00:00.000Z';
const task = (id: string, extra: Partial<Task> = {}): Task => ({
    id, title: `Task ${id} ✓ Grüße 😀`, status: 'next', tags: ['#a'], contexts: ['@home'], createdAt: AT, updatedAt: AT, rev: 1, revBy: 'device-a', ...extra,
});
const library = (): AppData => ({
    tasks: [
        task('t1', { description: 'line\nline', dueDate: '2026-09-02T10:00:00.000Z', projectId: 'p1', sectionId: 's1', areaId: 'a1' }),
        task('t2', { checklist: [{ id: 'c1', title: 'one', isCompleted: true }], isFocusedToday: true, priority: 'high' }),
        task('t3', { recurrence: { rule: 'weekly', strategy: 'strict' }, startTime: '2026-09-03T08:00:00.000Z', assignedTo: 'Ana' }),
        task('t4', { status: 'done', completedAt: AT, attachments: [{ id: 'l1', kind: 'link', title: 'x', uri: 'https://example.com', createdAt: AT, updatedAt: AT }] }),
        task('t5', { deletedAt: AT, rev: 3 }),
    ],
    projects: [{ id: 'p1', title: 'Project', status: 'active', color: '#94a3b8', createdAt: AT, updatedAt: AT, rev: 1, revBy: 'device-a', areaId: 'a1' }],
    sections: [{ id: 's1', projectId: 'p1', title: 'Section', order: 0, createdAt: AT, updatedAt: AT, rev: 1, revBy: 'device-a' }],
    areas: [{ id: 'a1', name: 'Area', order: 0, createdAt: AT, updatedAt: AT, rev: 1, revBy: 'device-a' }],
    people: [{ id: 'u1', name: 'Ana', createdAt: AT, updatedAt: AT, rev: 1, revBy: 'device-a' }],
    settings: { language: 'en', savedFilters: [{ id: 'f1', name: 'Mine', criteria: { contexts: ['@home'] }, createdAt: AT, updatedAt: AT }] },
} as AppData);

describe('SqliteAdapter first save after a cold start', () => {
    const dirs: string[] = [];
    const closers: (() => void)[] = [];
    afterEach(() => {
        closers.splice(0).forEach((close) => close());
        dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
    });
    const seeded = async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mindwtr-first-save-'));
        dirs.push(dir);
        const path = join(dir, 'mindwtr.db');
        const connect = () => {
            const opened = openScratchSqlite(path);
            closers.push(opened.close);
            return opened.client;
        };
        const writer = new SqliteAdapter(connect(), { rejectConcurrentWrites: true });
        await writer.getData();
        await writer.saveData(library());
        // A new process: a new adapter on the same file, whose first act is the boot's full read.
        const adapter = new SqliteAdapter(connect(), { rejectConcurrentWrites: true });
        return { adapter, data: await adapter.getData(), reader: () => new SqliteAdapter(connect()).getData() };
    };

    it('writes only the rows that changed, not every row', async () => {
        const { adapter, data } = await seeded();
        await adapter.saveData(data);
        expect(adapter.getLastSaveDataStats()).toMatchObject({ writtenRows: 0, settingsWritten: false });

        const { adapter: again, data: read, reader: readAgain } = await seeded();
        const edited = { ...read, tasks: read.tasks.map((row) => (row.id === 't2' ? { ...row, title: 'edited', rev: 2, updatedAt: '2026-09-02T00:00:00.000Z' } : row)) };
        await again.saveData(edited);
        expect(again.getLastSaveDataStats()).toMatchObject({ writtenRows: 1 });
        expect((await readAgain()).tasks.find((row) => row.id === 't2')?.title).toBe('edited');
    });

    it('forgets the read once a write started: a save after it writes every row it holds', async () => {
        const { adapter, data, reader } = await seeded();
        const original = data.tasks.find((row) => row.id === 't1')!;
        // The same revision, so the save's revision guard lets either version through: only the comparison decides.
        await adapter.saveTask({ ...original, title: 'changed by a single-row save' });
        // A stale snapshot saved after the single-row write: its t1 equals what the read saw, so a read-based comparison would
        // skip it and leave the single-row write in place. The save writes it, as every save without fingerprints did.
        await adapter.saveData(data);
        expect((await reader()).tasks.find((row) => row.id === 't1')?.title).toBe(original.title);
    });
});
