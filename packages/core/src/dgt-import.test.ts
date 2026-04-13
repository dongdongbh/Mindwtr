import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { applyDgtImport, parseDgtImportSource } from './dgt-import';
import { mockAppData } from './sync-test-utils';
import type { Area, Project } from './types';

const buildSampleExport = () => ({
    version: 3,
    FOLDER: [
        {
            ID: 1,
            CREATED: '2026-04-10 08:00:00.000',
            MODIFIED: '2026-04-10 08:15:00.000',
            TITLE: 'Personal',
            COLOR: -689365405,
            ORDINAL: 0,
        },
    ],
    CONTEXT: [
        {
            ID: 1,
            TITLE: 'errands',
        },
    ],
    TAG: [
        {
            ID: 1,
            TITLE: 'deep',
        },
    ],
    TASK: [
        {
            ID: 10,
            CREATED: '2026-04-10 09:00:00.000',
            MODIFIED: '2026-04-10 09:30:00.000',
            TITLE: 'House Renovation',
            TYPE: 1,
            FOLDER: 1,
            NOTE: 'Project support note',
            DUE_DATE: '2026-04-20',
            DUE_TIME_SET: 0,
            STATUS: 0,
        },
        {
            ID: 11,
            CREATED: '2026-04-11 10:00:00.000',
            MODIFIED: '2026-04-11 10:30:00.000',
            TITLE: 'Buy paint',
            TYPE: 0,
            PARENT: 10,
            CONTEXT: 1,
            TAG: [1],
            PRIORITY: 2,
            STATUS: 1,
            NOTE: 'Eggshell white',
            DUE_DATE: '2026-04-16 15:00',
            DUE_TIME_SET: 1,
        },
        {
            ID: 12,
            CREATED: '2026-04-11 11:00:00.000',
            MODIFIED: '2026-04-11 11:10:00.000',
            TITLE: 'Packing list',
            TYPE: 2,
            FOLDER: 1,
        },
        {
            ID: 13,
            TITLE: 'Tape',
            TYPE: 3,
            PARENT: 12,
        },
        {
            ID: 14,
            TITLE: 'Boxes',
            TYPE: 3,
            PARENT: 12,
            COMPLETED: '2026-04-10 09:00:00.000',
        },
        {
            ID: 15,
            TITLE: 'Weekly review',
            TYPE: 0,
            REPEAT_NEW: 'Every 6 Weeks',
            DUE_DATE: '2026-04-13 13:00',
            DUE_TIME_SET: 1,
        },
        {
            ID: 16,
            TITLE: 'Month end close',
            TYPE: 0,
            REPEAT_NEW: 'Last day of every month',
            DUE_DATE: '2026-04-30 09:00',
            DUE_TIME_SET: 1,
        },
        {
            ID: 17,
            TITLE: 'Archived errand',
            TYPE: 0,
            COMPLETED: '2026-04-11 12:00:00.000',
        },
        {
            ID: 18,
            TITLE: 'Legacy active',
            TYPE: 0,
            STATUS: 4,
        },
    ],
});

describe('dgt import', () => {
    it('parses a DGT JSON export with folders, projects, checklists, and recurring tasks', () => {
        const result = parseDgtImportSource({
            fileName: 'backup.json',
            text: JSON.stringify(buildSampleExport()),
        });

        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
        expect(result.preview).toMatchObject({
            areaCount: 1,
            projectCount: 1,
            taskCount: 6,
            checklistItemCount: 2,
            recurringCount: 1,
            standaloneTaskCount: 5,
        });
        expect(result.warnings).toContain('1 DGT recurring task could not be mapped and will be imported once.');
        expect(result.warnings).toContain('1 DGT task status could not be mapped and was imported to Inbox.');

        const parsed = result.parsedData;
        expect(parsed).not.toBeNull();
        expect(parsed?.areas[0]).toMatchObject({
            name: 'Personal',
            order: 0,
        });
        expect(parsed?.projects[0]).toMatchObject({
            name: 'House Renovation',
            areaSourceId: 1,
            dueDate: '2026-04-20',
        });
        expect(parsed?.projects[0]?.supportNotes).toContain('Project support note');

        const projectTask = parsed?.tasks.find((task) => task.title === 'Buy paint');
        expect(projectTask).toMatchObject({
            projectSourceId: 10,
            status: 'next',
            priority: 'medium',
            dueDate: '2026-04-16T15:00',
            contexts: ['@errands'],
            tags: ['#deep'],
        });
        expect(projectTask?.description).toContain('Eggshell white');

        const checklistTask = parsed?.tasks.find((task) => task.title === 'Packing list');
        expect(checklistTask?.checklist).toHaveLength(2);
        expect(checklistTask?.checklist[0]).toMatchObject({ title: 'Tape', isCompleted: false });
        expect(checklistTask?.checklist[1]).toMatchObject({ title: 'Boxes', isCompleted: true });

        const recurringTask = parsed?.tasks.find((task) => task.title === 'Weekly review');
        expect(recurringTask?.recurrence).toMatchObject({
            rule: 'weekly',
            rrule: 'FREQ=WEEKLY;INTERVAL=6',
        });

        const unsupportedRecurringTask = parsed?.tasks.find((task) => task.title === 'Month end close');
        expect(unsupportedRecurringTask?.recurrence).toBeUndefined();
        expect(unsupportedRecurringTask?.description).toContain('Original DGT repeat: Last day of every month');

        const completedTask = parsed?.tasks.find((task) => task.title === 'Archived errand');
        expect(completedTask).toMatchObject({
            status: 'done',
            completedAt: '2026-04-11T12:00:00.000',
        });

        const unmappedStatusTask = parsed?.tasks.find((task) => task.title === 'Legacy active');
        expect(unmappedStatusTask?.status).toBe('inbox');
    });

    it('parses a zipped DGT export and skips unsupported archive entries', () => {
        const archive = zipSync({
            'backup.json': strToU8(JSON.stringify(buildSampleExport())),
            'readme.txt': strToU8('skip me'),
            'nested.zip': new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
        });

        const result = parseDgtImportSource({
            fileName: 'backup.zip',
            bytes: archive,
        });

        expect(result.valid).toBe(true);
        expect(result.preview).toMatchObject({
            areaCount: 1,
            projectCount: 1,
            taskCount: 6,
        });
        expect(result.warnings).toContain('1 non-JSON file inside the DGT archive was skipped.');
        expect(result.warnings).toContain('1 nested ZIP file inside the DGT archive was skipped.');
    });

    it('imports parsed DGT data into areas, projects, and tasks while preserving parse warnings', () => {
        const parseResult = parseDgtImportSource({
            fileName: 'backup.json',
            text: JSON.stringify(buildSampleExport()),
        });
        if (!parseResult.valid || !parseResult.parsedData) {
            throw new Error('Expected sample DGT export to parse.');
        }

        const existingArea: Area = {
            id: 'area-existing',
            name: 'Personal',
            color: '#111111',
            order: 0,
            createdAt: '2026-04-01T00:00:00.000Z',
            updatedAt: '2026-04-01T00:00:00.000Z',
        };
        const existingProject: Project = {
            id: 'project-existing',
            title: 'House Renovation',
            status: 'active',
            color: '#222222',
            order: 0,
            tagIds: [],
            createdAt: '2026-04-01T00:00:00.000Z',
            updatedAt: '2026-04-01T00:00:00.000Z',
        };

        const result = applyDgtImport(
            {
                ...mockAppData([], [existingProject], []),
                areas: [existingArea],
            },
            parseResult.parsedData,
            { now: '2026-04-15T12:00:00.000Z' }
        );

        expect(result.importedAreaCount).toBe(1);
        expect(result.importedProjectCount).toBe(1);
        expect(result.importedTaskCount).toBe(6);
        expect(result.importedChecklistItemCount).toBe(2);
        expect(result.warnings).toContain('Imported area "Personal" was renamed to "Personal (DGT)" to avoid a name conflict.');
        expect(result.warnings).toContain('Imported project "House Renovation" was renamed to "House Renovation (DGT)" to avoid a title conflict.');
        expect(result.warnings).toContain('1 DGT recurring task could not be mapped and will be imported once.');
        expect(result.warnings).toContain('1 DGT task status could not be mapped and was imported to Inbox.');
        expect(result.data.settings.deviceId).toBeTruthy();

        const importedArea = result.data.areas.find((area) => area.id !== existingArea.id);
        expect(importedArea).toMatchObject({
            name: 'Personal (DGT)',
        });

        const importedProject = result.data.projects.find((project) => project.id !== existingProject.id);
        expect(importedProject).toMatchObject({
            title: 'House Renovation (DGT)',
            areaId: importedArea?.id,
            dueDate: '2026-04-20',
        });
        expect(importedProject?.supportNotes).toContain('Project support note');

        const projectTask = result.data.tasks.find((task) => task.title === 'Buy paint');
        expect(projectTask).toMatchObject({
            status: 'next',
            projectId: importedProject?.id,
            contexts: ['@errands'],
            tags: ['#deep'],
            priority: 'medium',
            dueDate: '2026-04-16T15:00',
        });

        const checklistTask = result.data.tasks.find((task) => task.title === 'Packing list');
        expect(checklistTask?.taskMode).toBe('list');
        expect(checklistTask?.areaId).toBe(importedArea?.id);
        expect(checklistTask?.checklist).toHaveLength(2);
        expect(checklistTask?.checklist?.[1]).toMatchObject({ title: 'Boxes', isCompleted: true });

        const recurringTask = result.data.tasks.find((task) => task.title === 'Weekly review');
        expect(recurringTask?.recurrence).toMatchObject({
            rule: 'weekly',
            rrule: 'FREQ=WEEKLY;INTERVAL=6',
        });

        const completedTask = result.data.tasks.find((task) => task.title === 'Archived errand');
        expect(completedTask).toMatchObject({
            status: 'done',
            completedAt: '2026-04-11T12:00:00.000',
        });
    });
});
