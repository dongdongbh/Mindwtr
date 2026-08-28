import { describe, expect, it } from 'vitest';
import { mapSqliteTaskRow, taskToSqliteRow } from './sqlite-adapter';
import { toAttachments } from './entity-sync-schema';
import { findPendingAttachmentUploads } from './sync-helpers';
import { TASK_SQLITE_COLUMNS, TASK_SYNC_SCHEMA_FIXTURE } from './task-sync-schema';
import type { Task, Project, Section, Area, Person } from './types';
import {
    PROJECT_SQLITE_COLUMNS,
    PROJECT_SYNC_SCHEMA_FIXTURE,
    projectFromSqliteRow,
    projectToSqliteRow,
} from './project-sync-schema';
import {
    SECTION_SQLITE_COLUMNS,
    SECTION_SYNC_SCHEMA_FIXTURE,
    sectionFromSqliteRow,
    sectionToSqliteRow,
} from './section-sync-schema';
import {
    AREA_SQLITE_COLUMNS,
    AREA_SYNC_SCHEMA_FIXTURE,
    areaFromSqliteRow,
    areaToSqliteRow,
} from './area-sync-schema';
import {
    PERSON_SQLITE_COLUMNS,
    PERSON_SYNC_SCHEMA_FIXTURE,
    personFromSqliteRow,
    personToSqliteRow,
} from './person-sync-schema';

// One generic round-trip guard covering every entity's SQLite row codec (toRow/fromRow, added
// to the *-sync-schema.ts files alongside the already-generated column lists). Before this,
// only `task` had any test touching its row VALUES at all (the older, weaker
// "keeps SQLite columns, serialization, and row mapping exhaustive" test in
// task-sync-schema.test.ts, which only asserts presence, not correctness) — project, section,
// area, and person had zero coverage on their value arrays, because those lived as inline,
// unexported positional literals in sqlite-adapter.ts.
//
// This assert reconstructs the fixture from its own row and checks full equality, so a value
// landing in the wrong column (or a column silently missing a value) fails immediately instead
// of corrupting data on disk. See the "deliberate corruption" demonstration referenced in this
// batch's task handoff: temporarily inserting an unwired field into any one of the four
// project/section/area/person fixture+schema JSON files reliably fails the matching case below.
const zipRow = (columns: readonly string[], row: unknown[]): Record<string, unknown> =>
    Object.fromEntries(columns.map((column, index) => [column, row[index]]));

type RowCodecCase<T> = {
    name: string;
    columns: readonly string[];
    toRow: (entity: T) => unknown[];
    fromRow: (row: Record<string, unknown>) => T;
    fixture: T;
    // A fixture with every optional field absent — the case the "dense" fixture above can't
    // cover, and the one real disk data hits constantly. Catches a NULL SQLite column getting
    // read back as `null` instead of `undefined` for a field declared `field?: T` (not
    // `field?: T | null`) in types.ts (see fromOptional in entity-sync-schema.ts). Fields that
    // are booleans coerce a missing value to `false` by established, pre-existing design
    // (fromBool/toBool never preserved undefined, on any entity, before or after this task) —
    // sparse fixtures set those explicitly to keep the round-trip meaningful rather than
    // asserting a behaviour this task didn't change.
    sparseFixture: T;
};

const ISO = '2026-01-01T00:00:00.000Z';

const sparseTask: Task = {
    id: 'task-sparse', title: 'Sparse task', status: 'inbox', tags: [], contexts: [],
    createdAt: ISO, updatedAt: ISO,
    showFutureRecurrence: false, isFocusedToday: false, suppressMindwtrReminders: false,
    // Nullable BY DESIGN (`T | null`, not just `T | undefined`): the write side collapses an
    // absent value to SQLite NULL (`?? null`), so "omitted" can never round-trip back to
    // `undefined` — only ever `null`. Set explicitly rather than asserting an impossible round
    // trip.
    completedAtBeforeProjectArchive: null,
    isFocusedTodayBeforeProjectArchive: null,
};

const sparseProject: Project = {
    id: 'project-sparse', title: 'Sparse project', status: 'active', color: '#000000',
    order: 0, tagIds: [], createdAt: ISO, updatedAt: ISO,
    isSequential: false, isFocused: false,
};

const sparseSection: Section = {
    id: 'section-sparse', projectId: 'project-sparse', title: 'Sparse section', order: 0,
    createdAt: ISO, updatedAt: ISO, isCollapsed: false,
    // Nullable BY DESIGN — see sparseTask's comment above.
    deletedAtBeforeProjectArchive: null,
};

const sparseArea: Area = {
    id: 'area-sparse', name: 'Sparse area', order: 0, createdAt: ISO, updatedAt: ISO,
};

const sparsePerson: Person = {
    id: 'person-sparse', name: 'Sparse person', createdAt: ISO, updatedAt: ISO,
};

const cases: RowCodecCase<any>[] = [
    { name: 'task', columns: TASK_SQLITE_COLUMNS, toRow: taskToSqliteRow, fromRow: mapSqliteTaskRow, fixture: TASK_SYNC_SCHEMA_FIXTURE, sparseFixture: sparseTask },
    { name: 'project', columns: PROJECT_SQLITE_COLUMNS, toRow: projectToSqliteRow, fromRow: projectFromSqliteRow, fixture: PROJECT_SYNC_SCHEMA_FIXTURE, sparseFixture: sparseProject },
    { name: 'section', columns: SECTION_SQLITE_COLUMNS, toRow: sectionToSqliteRow, fromRow: sectionFromSqliteRow, fixture: SECTION_SYNC_SCHEMA_FIXTURE, sparseFixture: sparseSection },
    { name: 'area', columns: AREA_SQLITE_COLUMNS, toRow: areaToSqliteRow, fromRow: areaFromSqliteRow, fixture: AREA_SYNC_SCHEMA_FIXTURE, sparseFixture: sparseArea },
    { name: 'person', columns: PERSON_SQLITE_COLUMNS, toRow: personToSqliteRow, fromRow: personFromSqliteRow, fixture: PERSON_SYNC_SCHEMA_FIXTURE, sparseFixture: sparsePerson },
];

describe('SQLite row codec round-trip', () => {
    it.each(cases)('$name: fromRow(zip(columns, toRow(fixture))) reproduces the fixture', ({ columns, toRow, fromRow, fixture }) => {
        const row = toRow(fixture);
        expect(row).toHaveLength(columns.length);
        expect(fromRow(zipRow(columns, row))).toEqual(fixture);
    });

    it.each(cases)('$name: fromRow(zip(columns, toRow(sparseFixture))) reproduces a fixture with every optional field absent', ({ columns, toRow, fromRow, sparseFixture }) => {
        const row = toRow(sparseFixture);
        expect(row).toHaveLength(columns.length);
        expect(fromRow(zipRow(columns, row))).toEqual(sparseFixture);
    });

    it.each([
        {
            name: 'task',
            columns: TASK_SQLITE_COLUMNS,
            toRow: taskToSqliteRow,
            fromRow: mapSqliteTaskRow,
            fixture: sparseTask,
        },
        {
            name: 'project',
            columns: PROJECT_SQLITE_COLUMNS,
            toRow: projectToSqliteRow,
            fromRow: projectFromSqliteRow,
            fixture: sparseProject,
        },
    ])('$name: preserves the durable local attachment-upload retry marker', ({ name, columns, toRow, fromRow, fixture }) => {
        const attachment = {
            id: 'pending-replacement',
            kind: 'file' as const,
            title: 'replacement.txt',
            uri: '/managed/pending-replacement.txt',
            cloudKey: 'attachments/pending-replacement.txt',
            fileHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            contentRev: 2,
            contentMtimeMs: 2000,
            contentSize: 20,
            localStatus: 'available' as const,
            pendingContentUpload: true as const,
            createdAt: ISO,
            updatedAt: ISO,
        };
        const entity = { ...fixture, attachments: [attachment] };
        const reloaded = fromRow(zipRow(columns, toRow(entity)));

        expect(reloaded.attachments?.[0]?.pendingContentUpload).toBe(true);
        if (name === 'task') {
            expect(findPendingAttachmentUploads({
                tasks: [reloaded as Task],
                projects: [],
                sections: [],
                areas: [],
                settings: {},
            })).toEqual([
                expect.objectContaining({
                    attachmentId: attachment.id,
                    reason: 'content-replacement',
                }),
            ]);
        }
    });

    it('accepts only literal true for the local retry marker', () => {
        const base = {
            id: 'attachment',
            kind: 'file',
            title: 'attachment.txt',
            uri: '/managed/attachment.txt',
        };
        expect(toAttachments([{ ...base, pendingContentUpload: true }])?.[0]?.pendingContentUpload).toBe(true);
        for (const invalid of [false, 1, 'true', {}, []]) {
            expect(toAttachments([{ ...base, pendingContentUpload: invalid }])?.[0]?.pendingContentUpload).toBeUndefined();
        }
    });
});
