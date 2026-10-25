import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openScratchSqlite } from './screen-parity.replay';
import { SqliteAdapter } from './sqlite-adapter';
import { repairAppDataForSqlite } from './sqlite-copy-repair';
import { mergeAppDataWithStats } from './sync';
import type { AppData } from './types';

const AT = '2026-01-01T00:00:00.000Z';
const task = (fields: Record<string, unknown> = {}) => ({
    id: 't1', title: 'Task', status: 'inbox', tags: [], contexts: [], createdAt: AT, updatedAt: AT, ...fields,
});
const project = (fields: Record<string, unknown> = {}) => ({
    id: 'p1', title: 'Project', status: 'active', color: '#000000', createdAt: AT, updatedAt: AT, ...fields,
});
const section = (fields: Record<string, unknown> = {}) => ({
    id: 's1', projectId: 'p1', title: 'Section', createdAt: AT, updatedAt: AT, ...fields,
});
const area = (fields: Record<string, unknown> = {}) => ({
    id: 'a1', name: 'Area', order: 0, createdAt: AT, updatedAt: AT, ...fields,
});
const copyOf = (fields: Record<string, unknown>): AppData => ({
    tasks: [], projects: [], sections: [], areas: [], people: [], settings: {}, ...fields,
} as unknown as AppData);

// The move the mobile app makes: merge the copy over what SQLite holds, then
// save it, on a real database with foreign keys on as the app opens it.
const moveIntoSqlite = async (copy: AppData) => {
    const { client, close } = openScratchSqlite(join(mkdtempSync(join(tmpdir(), 'mindwtr-copy-repair-')), 'mindwtr.db'));
    try {
        await client.run('PRAGMA foreign_keys = ON');
        const adapter = new SqliteAdapter(client);
        await adapter.ensureSchema();
        const { data } = mergeAppDataWithStats(await adapter.getData(), copy);
        await adapter.saveData(data);
        return await adapter.getData();
    } finally {
        close();
    }
};

// Every shape the probe of the real schema found SQLite (or the merge before
// it) rejecting. Each row: the copy, the repair count it must raise, and what
// the stored library must still hold.
const REJECTED_COPIES: Array<{
    name: string;
    copy: AppData;
    counted: keyof ReturnType<typeof repairAppDataForSqlite>['counts'];
    check: (stored: AppData) => void;
}> = [
    {
        name: 'a null entry in the task, project or area list',
        copy: copyOf({ tasks: [null, task()], projects: [null], areas: [null] }),
        counted: 'nullEntries',
        check: (stored) => expect(stored.tasks.map((item) => item.id)).toEqual(['t1']),
    },
    {
        name: 'a task without a title',
        copy: copyOf({ tasks: [task({ title: undefined }), task({ id: 't2', title: null })] }),
        counted: 'untitledTasks',
        check: (stored) => expect(stored.tasks.map((item) => item.title)).toEqual(['Untitled', 'Untitled']),
    },
    {
        name: 'a project without a title',
        copy: copyOf({ projects: [project({ title: undefined })], tasks: [task({ projectId: 'p1' })] }),
        counted: 'untitledProjects',
        check: (stored) => {
            expect(stored.projects[0]?.title).toBe('Untitled');
            expect(stored.tasks[0]?.projectId).toBe('p1');
        },
    },
    {
        name: 'a project without createdAt',
        copy: copyOf({ projects: [project({ createdAt: undefined, updatedAt: '2026-02-02T00:00:00.000Z' })] }),
        counted: 'missingCreatedAt',
        // createdAt takes updatedAt, both aged past the skew window (see the tie tests).
        check: (stored) => expect(stored.projects[0]).toEqual(expect.objectContaining({
            createdAt: '2026-02-01T23:54:59.999Z',
            updatedAt: '2026-02-01T23:54:59.999Z',
        })),
    },
    {
        name: 'a section without a title or createdAt',
        copy: copyOf({ projects: [project()], sections: [section({ title: undefined, createdAt: undefined })] }),
        counted: 'untitledSections',
        check: (stored) => {
            expect(stored.sections[0]?.title).toBe('Untitled');
            expect(stored.sections[0]?.createdAt).toBe('2025-12-31T23:54:59.999Z');
        },
    },
    {
        name: 'an area without a name',
        copy: copyOf({ areas: [area({ name: undefined })], tasks: [task({ areaId: 'a1' })] }),
        counted: 'unnamedAreas',
        check: (stored) => {
            expect(stored.areas[0]?.name).toBe('Untitled');
            expect(stored.tasks[0]?.areaId).toBe('a1');
        },
    },
    {
        name: 'a section whose project is missing, live or deleted, with a task in it',
        copy: copyOf({
            sections: [section({ id: 's1', projectId: 'gone' }), section({ id: 's2', projectId: 'gone', deletedAt: AT }), section({ id: 's3', projectId: undefined })],
            tasks: [task({ projectId: 'gone', sectionId: 's1' })],
        }),
        counted: 'orphanSections',
        check: (stored) => {
            expect(stored.sections).toEqual([]);
            expect(stored.tasks.map((item) => item.id)).toEqual(['t1']);
            expect(stored.tasks[0]?.sectionId).toBeUndefined();
        },
    },
];

describe('repairAppDataForSqlite', () => {
    for (const { name, copy, counted, check } of REJECTED_COPIES) {
        it(`moves a copy with ${name} once it is repaired`, async () => {
            await expect(moveIntoSqlite(structuredClone(copy))).rejects.toThrow();

            const { data, counts } = repairAppDataForSqlite(structuredClone(copy));

            expect(counts[counted]).toBeGreaterThan(0);
            const stored = await moveIntoSqlite(data);
            check(stored);
        });
    }

    it('keeps a section whose project only SQLite holds', () => {
        const { data, counts } = repairAppDataForSqlite(
            copyOf({ sections: [section({ projectId: 'p-sqlite' })] }),
            copyOf({ projects: [project({ id: 'p-sqlite' })] }),
        );

        expect(data.sections.map((item) => item.id)).toEqual(['s1']);
        expect(counts.orphanSections).toBe(0);
    });

    it('changes nothing and counts nothing in a copy SQLite accepts', () => {
        const copy = copyOf({ tasks: [task({ projectId: 'p1', sectionId: 's1' })], projects: [project()], sections: [section()], areas: [area()] });

        const { data, counts } = repairAppDataForSqlite(structuredClone(copy));

        expect(data).toEqual(copy);
        expect(Object.values(counts).every((count) => count === 0)).toBe(true);
    });

    // A repaired row keeps its revision, so it ties with the good row on another
    // device (or in SQLite). It must lose that tie in both merge directions, with
    // and without revisions; "Untitled" used to win it on signature order.
    const bothWays = (left: AppData, right: AppData) => [
        mergeAppDataWithStats(left, right).data,
        mergeAppDataWithStats(right, left).data,
    ];

    for (const revision of [{ rev: 2, revBy: 'phone' }, {}]) {
        const label = 'rev' in revision ? 'with' : 'without';
        it(`loses a tie to the real title on another device, ${label} revisions`, () => {
            const good = copyOf({ tasks: [task({ title: 'Buy milk', ...revision })] });
            const { data: repaired } = repairAppDataForSqlite(copyOf({ tasks: [task({ title: null, ...revision })] }));

            for (const merged of bothWays(good, repaired)) {
                expect(merged.tasks[0]?.title).toBe('Buy milk');
            }
        });
    }

    it('loses a tie to the real createdAt and to the real section on another device', () => {
        const revision = { rev: 2, revBy: 'phone' };
        const good = copyOf({
            projects: [project({ createdAt: '2025-06-01T00:00:00.000Z', ...revision })],
            sections: [section()],
            tasks: [task({ projectId: 'p1', sectionId: 's1', ...revision })],
        });
        const { data: repaired } = repairAppDataForSqlite(copyOf({
            projects: [project({ createdAt: undefined, ...revision })],
            sections: [section({ projectId: 'gone' })],
            tasks: [task({ projectId: 'p1', sectionId: 's1', ...revision })],
        }));

        for (const merged of bothWays(good, repaired)) {
            expect(merged.projects[0]?.createdAt).toBe('2025-06-01T00:00:00.000Z');
            expect(merged.tasks[0]?.sectionId).toBe('s1');
        }
    });

    it('fills a missing title, name or createdAt from the row SQLite already holds', () => {
        const current = copyOf({
            tasks: [task({ title: 'Real task' })],
            projects: [project({ title: 'Real project', createdAt: '2025-06-01T00:00:00.000Z' })],
            areas: [area({ name: 'Real area' })],
        });

        const { data } = repairAppDataForSqlite(copyOf({
            tasks: [task({ title: null })],
            projects: [project({ title: undefined, createdAt: undefined })],
            areas: [area({ name: undefined })],
        }), current);

        expect(data.tasks[0]?.title).toBe('Real task');
        expect(data.projects[0]).toEqual(expect.objectContaining({ title: 'Real project', createdAt: '2025-06-01T00:00:00.000Z' }));
        expect(data.areas[0]?.name).toBe('Real area');
    });

    it('never leaves a repaired row with updatedAt before createdAt', () => {
        const { data } = repairAppDataForSqlite(copyOf({
            tasks: [task({ title: null, createdAt: AT, updatedAt: AT })],
            projects: [project({ createdAt: undefined })],
        }));

        for (const row of [data.tasks[0]!, data.projects[0]!]) {
            expect(Date.parse(row.updatedAt)).toBeGreaterThanOrEqual(Date.parse(row.createdAt));
        }
    });
});
