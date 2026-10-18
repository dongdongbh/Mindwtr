import { strToU8, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';

import {
    applyTickTickImport,
    parseTickTickImportSource,
    type ParsedTickTickImportData,
} from './ticktick-import';
import { mockAppData } from './sync-test-utils';
import { withQuickJsArgumentLimit } from './quickjs-test-utils';
import type { Area, Person, Project } from './types';

const csvRow = (cells: string[]): string => cells
    .map((cell) => `"${cell.replace(/"/gu, '""')}"`)
    .join(',');

const buildTickTickCsv = (rows: string[][]): string => [
    '"Date: 2026-06-17+0000"',
    '"Version: 7.1"',
    '"Status:\n0 Normal\n1 Completed\n2 Archived"',
    csvRow([
        'Folder Name',
        'List Name',
        'Title',
        'Kind',
        'Tags',
        'Content',
        'Is Check list',
        'Start Date',
        'Due Date',
        'Reminder',
        'Repeat',
        'Priority',
        'Status',
        'Created Time',
        'Completed Time',
        'Order',
        'Timezone',
        'Is All Day',
        'Is Floating',
        'Column Name',
        'Column Order',
        'View Mode',
        'taskId',
        'parentId',
    ]),
    ...rows.map(csvRow),
].join('\n');

const sampleTickTickCsv = buildTickTickCsv([
    [
        'Work',
        'Launch',
        'Book venue',
        'TEXT',
        '#ops',
        'Confirm capacity',
        'N',
        '',
        '',
        '',
        '',
        '1',
        '1',
        '2026-06-12T12:00:00+0000',
        '2026-06-13T12:00:00+0000',
        '-1',
        'America/New_York',
        'false',
        'false',
        'Not Sectioned',
        '-1',
        'list',
        '101',
        '100',
    ],
    [
        'Work',
        'Launch',
        'Plan release',
        'TEXT',
        '#work, focus',
        'Write launch brief',
        'N',
        '2026-06-17T04:00:00+0000',
        '2026-06-18T04:00:00+0000',
        '',
        'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;WKST=MO',
        '5',
        '0',
        '2026-06-11T12:00:00+0000',
        '',
        '-2',
        'America/New_York',
        'true',
        'false',
        'Not Sectioned',
        '-1',
        'list',
        '100',
        '',
    ],
    [
        'Work',
        'Launch',
        'Packing list',
        'CHECKLIST',
        'travel',
        '▫Passport\n▪Tickets',
        'Y',
        '',
        '',
        '',
        '',
        '3',
        '2',
        '2026-06-10T12:00:00+0000',
        '2026-06-15T12:00:00+0000',
        '-3',
        'America/New_York',
        'false',
        'false',
        'Not Sectioned',
        '-1',
        'list',
        '102',
        '',
    ],
]);

describe('ticktick import', () => {
    it('rejects the cumulative checklist limit before allocating checklist UUIDs', () => {
        const randomUuid = vi.spyOn(globalThis.crypto, 'randomUUID');
        const oversizedChecklist = Array.from({ length: 100_001 }, () => '▫ x').join('\n');
        try {
            const result = parseTickTickImportSource({
                fileName: 'oversized-checklist.csv',
                text: buildTickTickCsv([[
                    '', 'List', 'Checklist', 'CHECKLIST', '', oversizedChecklist, 'true',
                    '', '', '', '', '0', '0', '', '', '0', '', 'true', 'false', '', '', '', '',
                ]]),
            });

            expect(result.valid).toBe(false);
            expect(result.errors[0]).toContain('100000 checklist items');
            expect(randomUuid).not.toHaveBeenCalled();
        } finally {
            randomUuid.mockRestore();
        }
    });
    it('parses a TickTick CSV backup with folders, lists, dates, recurrence, checklists, and parent rows', () => {
        const result = parseTickTickImportSource({
            fileName: 'TickTick-backup.csv',
            text: sampleTickTickCsv,
        });

        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
        expect(result.preview).toMatchObject({
            fileName: 'TickTick-backup.csv',
            areaCount: 1,
            projectCount: 1,
            taskCount: 2,
            checklistItemCount: 3,
            recurringCount: 1,
        });

        expect(result.parsedData?.areas).toMatchObject([
            {
                name: 'Work',
                sourceKey: 'folder:work',
            },
        ]);
        expect(result.parsedData?.projects).toMatchObject([
            {
                name: 'Launch',
                areaSourceKey: 'folder:work',
                sourceKey: 'folder:work/list:launch',
            },
        ]);

        const [releaseTask, packingTask] = result.parsedData?.tasks ?? [];
        expect(releaseTask).toMatchObject({
            title: 'Plan release',
            projectSourceKey: 'folder:work/list:launch',
            tags: ['#work', '#focus', '#ops'],
            description: expect.stringContaining('Write launch brief'),
            dueDate: '2026-06-18',
            startTime: '2026-06-17',
            priority: 'high',
            status: 'inbox',
            recurrence: {
                rule: 'weekly',
                byDay: ['MO', 'WE'],
                weekStart: 'MO',
            },
        });
        expect(releaseTask?.description).toContain('Subtask "Book venue": Confirm capacity');
        expect(releaseTask?.checklist).toMatchObject([
            {
                title: 'Book venue',
                isCompleted: true,
            },
        ]);

        expect(packingTask).toMatchObject({
            title: 'Packing list',
            tags: ['#travel'],
            priority: 'medium',
            status: 'archived',
            completedAt: '2026-06-15T12:00:00.000Z',
            checklist: [
                { title: 'Passport', isCompleted: false },
                { title: 'Tickets', isCompleted: true },
            ],
        });
    });

    it('flattens nested TickTick child tasks into the nearest imported parent checklist', () => {
        const nestedCsv = buildTickTickCsv([
            [
                'Work',
                'Launch',
                'Parent task',
                'TEXT',
                '#root',
                'Parent notes',
                'N',
                '',
                '',
                '',
                '',
                '0',
                '0',
                '2026-06-10T12:00:00+0000',
                '',
                '1',
                'America/New_York',
                'false',
                'false',
                'Not Sectioned',
                '-1',
                'list',
                'parent-1',
                '',
            ],
            [
                'Work',
                'Launch',
                'Child task',
                'TEXT',
                '#child',
                'Child notes',
                'N',
                '',
                '',
                '',
                '',
                '0',
                '0',
                '2026-06-10T12:00:00+0000',
                '',
                '2',
                'America/New_York',
                'false',
                'false',
                'Not Sectioned',
                '-1',
                'list',
                'child-1',
                'parent-1',
            ],
            [
                'Work',
                'Launch',
                'Grandchild task',
                'TEXT',
                '#deep',
                'Grandchild notes',
                'N',
                '',
                '',
                '',
                '',
                '0',
                '0',
                '2026-06-10T12:00:00+0000',
                '',
                '3',
                'America/New_York',
                'false',
                'false',
                'Not Sectioned',
                '-1',
                'list',
                'grandchild-1',
                'child-1',
            ],
        ]);

        const result = parseTickTickImportSource({
            fileName: 'nested.csv',
            text: nestedCsv,
        });

        expect(result.valid).toBe(true);
        expect(result.preview).toMatchObject({
            taskCount: 1,
            checklistItemCount: 2,
        });
        expect(result.warnings).toContain('2 TickTick child tasks were imported as checklist items on their parent tasks.');

        const importedTask = result.parsedData?.tasks[0];
        expect(importedTask?.title).toBe('Parent task');
        expect(importedTask?.tags).toEqual(['#root', '#child', '#deep']);
        expect(importedTask?.description).toContain('Subtask "Child task": Child notes');
        expect(importedTask?.description).toContain('Subtask "Grandchild task": Grandchild notes');
        expect(importedTask?.checklist).toMatchObject([
            { title: 'Child task', isCompleted: false },
            { title: 'Grandchild task', isCompleted: false },
        ]);
    });

    it('keeps TickTick all-day dates on the exported local day when timezone is empty', () => {
        const csv = buildTickTickCsv([
            [
                '',
                'Inbox',
                'All-day task',
                'TEXT',
                '',
                '',
                'N',
                '2026-06-17T23:30:00-0200',
                '2026-06-18T23:30:00-0200',
                '',
                '',
                '0',
                '0',
                '2026-06-10T12:00:00+0000',
                '',
                '1',
                '',
                'true',
                'false',
                'Not Sectioned',
                '-1',
                'list',
                'all-day-1',
                '',
            ],
        ]);

        const result = parseTickTickImportSource({
            fileName: 'all-day.csv',
            text: csv,
        });

        expect(result.valid).toBe(true);
        expect(result.parsedData?.tasks[0]).toMatchObject({
            title: 'All-day task',
            startTime: '2026-06-17',
            dueDate: '2026-06-18',
        });
    });

    it('imports one zipped backup with more rows than a QuickJS call takes arguments', () => {
        const rows = Array.from({ length: 70_000 }, (_, index) => ['', 'Inbox', `Task ${index}`, 'TEXT', '', '', 'N', '', '', '', '', '0', '0',
            '', '', '', '', '', '', '', '', '', `task-${index}`, '']);
        const bytes = zipSync({ 'backup.csv': strToU8(buildTickTickCsv(rows)) });
        const result = withQuickJsArgumentLimit(() => parseTickTickImportSource({ fileName: 'ticktick.zip', bytes }));
        expect(result.errors).toEqual([]);
        expect(result.parsedData?.tasks).toHaveLength(70_000);
    }, 30_000);

    it('parses a zipped TickTick backup and skips unsupported archive entries', () => {
        const archive = zipSync({
            'backup.csv': strToU8(sampleTickTickCsv),
            'notes.txt': strToU8('skip me'),
            'nested.zip': new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
        });

        const result = parseTickTickImportSource({
            fileName: 'ticktick.zip',
            bytes: archive,
        });

        expect(result.valid).toBe(true);
        expect(result.preview).toMatchObject({
            projectCount: 1,
            taskCount: 2,
        });
        expect(result.warnings).toContain('1 non-CSV file inside the TickTick archive was skipped.');
        expect(result.warnings).toContain('1 nested ZIP file inside the TickTick archive was skipped.');
    });

    it('imports parsed TickTick data into areas, projects, and tasks while preserving a recovery-friendly warning trail', () => {
        const existingArea: Area = {
            id: 'area-existing',
            name: 'Work',
            color: '#123456',
            order: 0,
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
        };
        const existingProject: Project = {
            id: 'project-existing',
            title: 'Launch',
            status: 'active',
            color: '#111827',
            order: 0,
            tagIds: [],
            areaId: existingArea.id,
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
        };
        const existingPerson: Person = {
            id: 'person-existing',
            name: 'Taylor',
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
        };
        const parsedData = parseTickTickImportSource({
            fileName: 'TickTick-backup.csv',
            text: sampleTickTickCsv,
        }).parsedData as ParsedTickTickImportData;

        const currentData = mockAppData([], [existingProject], []);
        currentData.areas = [existingArea];
        currentData.people = [existingPerson];

        const result = applyTickTickImport(currentData, parsedData, { now: '2026-06-17T12:00:00.000Z' });

        expect(result.importedAreaCount).toBe(1);
        expect(result.importedProjectCount).toBe(1);
        expect(result.importedTaskCount).toBe(2);
        expect(result.importedChecklistItemCount).toBe(3);
        expect(result.warnings).toContain('Imported area "Work" was renamed to "Work (TickTick)" to avoid a name conflict.');
        expect(result.warnings).not.toContain('Imported project "Launch" was renamed to "Launch (TickTick)" to avoid a title conflict.');
        expect(result.data.settings.deviceId).toBeTruthy();
        expect(result.data.people).toEqual([existingPerson]);

        const importedArea = result.data.areas.find((area) => area.id !== existingArea.id);
        expect(importedArea).toMatchObject({
            name: 'Work (TickTick)',
            order: 1,
            rev: 1,
            revBy: result.data.settings.deviceId,
        });

        const importedProject = result.data.projects.find((project) => project.id !== existingProject.id);
        expect(importedProject).toMatchObject({
            title: 'Launch',
            areaId: importedArea?.id,
            status: 'active',
            rev: 1,
            revBy: result.data.settings.deviceId,
        });

        const importedTask = result.data.tasks.find((task) => task.title === 'Plan release');
        expect(importedTask).toMatchObject({
            status: 'next',
            taskMode: 'list',
            projectId: importedProject?.id,
            priority: 'high',
            dueDate: '2026-06-18',
            startTime: '2026-06-17',
            tags: ['#work', '#focus', '#ops'],
            rev: 1,
            revBy: result.data.settings.deviceId,
        });
        expect(importedTask?.checklist).toHaveLength(1);

        const importedArchivedTask = result.data.tasks.find((task) => task.title === 'Packing list');
        expect(importedArchivedTask).toMatchObject({
            status: 'archived',
            projectId: importedProject?.id,
            completedAt: '2026-06-15T12:00:00.000Z',
            rev: 1,
            revBy: result.data.settings.deviceId,
        });
    });

    it('does not duplicate TickTick records when the same import is applied again', () => {
        const parsedData = parseTickTickImportSource({
            fileName: 'TickTick-backup.csv',
            text: sampleTickTickCsv,
        }).parsedData as ParsedTickTickImportData;

        const first = applyTickTickImport(mockAppData([], [], []), parsedData, { now: '2026-06-17T12:00:00.000Z' });
        const second = applyTickTickImport(first.data, parsedData, { now: '2026-06-18T12:00:00.000Z' });

        expect(second.importedAreaCount).toBe(0);
        expect(second.importedProjectCount).toBe(0);
        expect(second.importedTaskCount).toBe(0);
        expect(second.importedChecklistItemCount).toBe(0);
        expect(second.data.areas).toHaveLength(first.data.areas.length);
        expect(second.data.projects).toHaveLength(first.data.projects.length);
        expect(second.data.tasks).toHaveLength(first.data.tasks.length);
        expect(second.data.tasks.map((task) => task.id)).toEqual(first.data.tasks.map((task) => task.id));
    });
});
