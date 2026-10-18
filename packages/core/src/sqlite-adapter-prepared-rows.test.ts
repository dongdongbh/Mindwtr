import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runToEnd } from './cooperative';
import { openScratchSqlite } from './screen-parity.replay';
import { SqliteAdapter } from './sqlite-adapter';
import type { AppData, Project } from './types';

// D9b §2: a sliced sync cycle builds a save's rows before it takes the write gate (prepareSaveRows). The save uses them only
// for that exact document and only while no write transaction ran since; otherwise it builds them in its own transaction.
// The probe: a project changed in place after the preparation. Prepared rows still hold the title it had then.

const AT = '2026-09-01T00:00:00.000Z';
const LATER = '2026-09-02T00:00:00.000Z';
const library = (): AppData => ({
    tasks: [{ id: 't1', title: 'Task', status: 'next', tags: [], contexts: [], createdAt: AT, updatedAt: AT, rev: 1, revBy: 'device-a', projectId: 'p1' }],
    projects: [{ id: 'p1', title: 'Project', status: 'active', color: '#94a3b8', createdAt: AT, updatedAt: AT, rev: 1, revBy: 'device-a' }],
    sections: [],
    areas: [],
    people: [],
    settings: {},
} as AppData);

describe('SqliteAdapter rows prepared before a sliced save (D9b §2)', () => {
    const dirs: string[] = [];
    const closers: (() => void)[] = [];
    afterEach(() => {
        closers.splice(0).forEach((close) => close());
        dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
    });
    const seeded = async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mindwtr-prepared-rows-'));
        dirs.push(dir);
        const opened = openScratchSqlite(join(dir, 'mindwtr.db'));
        closers.push(opened.close);
        await new SqliteAdapter(opened.client).saveData(library());
        const adapter = new SqliteAdapter(opened.client, { rejectConcurrentWrites: true });
        const read = await adapter.getData();
        // The cycle's next document: the project renamed at a new revision, its rows prepared, then changed in place.
        const project: Project = { ...read.projects[0], title: 'Prepared title', rev: 2, updatedAt: LATER };
        const next: AppData = { ...read, projects: [project] };
        runToEnd(adapter.prepareSaveRows(next));
        project.title = 'Changed after preparation';
        const savedTitle = async () => (await adapter.getData()).projects[0].title;
        return { adapter, read, next, savedTitle };
    };

    it('saves the rows prepared for this document, on its read token', async () => {
        const { adapter, read, next, savedTitle } = await seeded();
        await adapter.saveData(next, { token: adapter.readTokenOf(read), onStale: () => new Error('stale') });
        expect(await savedTitle()).toBe('Prepared title');
    });

    it('builds the rows in its transaction when a write ran after the preparation', async () => {
        const { adapter, next, savedTitle } = await seeded();
        await adapter.upsertCalendarSyncEntry({ taskId: 't1', calendarEventId: 'e1', calendarId: 'c', platform: 'android', lastSyncedAt: AT });
        await adapter.saveData(next);
        expect(await savedTitle()).toBe('Changed after preparation');
    });

    it('builds the rows in its transaction for any other document', async () => {
        const { adapter, next, savedTitle } = await seeded();
        await adapter.saveData({ ...next });
        expect(await savedTitle()).toBe('Changed after preparation');
    });
});
