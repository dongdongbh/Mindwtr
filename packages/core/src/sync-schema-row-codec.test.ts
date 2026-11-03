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


const zipRow = (columns: readonly string[], row: unknown[]): Record<string, unknown> =>
    Object.fromEntries(columns.map((column, index) => [column, row[index]]));

type RowCodecCase<T> = {
    name: string;
    columns: readonly string[];
    toRow: (entity: T) => unknown[];
    fromRow: (row: Record<string, unknown>) => T;
    fixture: T;


    sparseFixture: T;
};

const ISO = '2026-01-01T00:00:00.000Z';

const sparseTask: Task = {
    id: 'task-sparse', title: 'Sparse task', status: 'inbox', tags: [], contexts: [],
    createdAt: ISO, updatedAt: ISO,


    isFocusedToday: false, suppressMindwtrReminders: false,


};

const sparseProject: Project = {
    id: 'project-sparse', title: 'Sparse project', status: 'active', color: '#000000',
    order: 0, tagIds: [], createdAt: ISO, updatedAt: ISO,
    isSequential: false, isFocused: false,
};

const sparseSection: Section = {
    id: 'section-sparse', projectId: 'project-sparse', title: 'Sparse section', order: 0,
    createdAt: ISO, updatedAt: ISO, isCollapsed: false,

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

    it('task: writes a Swift-sorted checklist in the same form it reads back', () => {
        const task: Task = {
            ...sparseTask,
            rev: 7,
            checklist: [
                { id: 'first', isCompleted: false, title: 'First' },
                { id: 'second', isCompleted: true, title: 'Second' },
            ],
        };
        const checklistIndex = TASK_SQLITE_COLUMNS.indexOf('checklist');
        const firstRow = taskToSqliteRow(task);
        const reloaded = mapSqliteTaskRow(zipRow(TASK_SQLITE_COLUMNS, firstRow));
        const secondRow = taskToSqliteRow(reloaded);

        expect(firstRow[checklistIndex]).toBe(JSON.stringify([
            { id: 'first', title: 'First', isCompleted: false },
            { id: 'second', title: 'Second', isCompleted: true },
        ]));
        expect(reloaded.checklist).toEqual(task.checklist);
        expect(reloaded).toMatchObject({ rev: task.rev, createdAt: task.createdAt, updatedAt: task.updatedAt });
        expect(secondRow).toEqual(firstRow);
    });

    it('task: writes empty and malformed checklists as the existing reader interprets them', () => {
        const checklistIndex = TASK_SQLITE_COLUMNS.indexOf('checklist');
        const cases: unknown[][] = [
            [],
            [{ id: 1, title: 'Invalid', isCompleted: false }],
            [{ id: 'valid', isCompleted: false, title: 'Valid' }, { id: 1, title: 'Invalid' }],
        ];
        for (const checklist of cases) {
            const task = { ...sparseTask, checklist: checklist as Task['checklist'] };
            const written = taskToSqliteRow(task);
            const read = mapSqliteTaskRow(zipRow(TASK_SQLITE_COLUMNS, [
                ...written.slice(0, checklistIndex), JSON.stringify(checklist), ...written.slice(checklistIndex + 1),
            ]));
            expect(written[checklistIndex]).toBe(taskToSqliteRow(read)[checklistIndex]);
        }
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
