import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { applyOmniFocusImport, parseOmniFocusImportSource } from './omnifocus-import';
import { mockAppData } from './sync-test-utils';
import type { Project } from './types';

const encodeUtf16Le = (value: string): Uint8Array => {
    const buffer = new Uint8Array(2 + (value.length * 2));
    buffer[0] = 0xff;
    buffer[1] = 0xfe;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        buffer[2 + index * 2] = code & 0xff;
        buffer[3 + index * 2] = code >> 8;
    }
    return buffer;
};

const buildOmniFocusJsonZip = (): Uint8Array => zipSync({
    'OmniFocus.json': strToU8(JSON.stringify({
        tasks: [
            {
                id: 'project-1',
                name: 'Test project',
                note: 'Root project note',
                dueDate: null,
                deferDate: null,
                plannedDate: null,
                flagged: false,
                completed: false,
                tagIds: ['tag-1'],
                parentTaskId: null,
                repetition: null,
                projectId: 'project-1',
                completionDate: null,
            },
            {
                id: 'task-1',
                name: 'Plan sprint',
                note: 'Plan details',
                dueDate: '2026-04-23T21:00:00.000Z',
                deferDate: '2026-04-20',
                plannedDate: '2026-04-22',
                flagged: true,
                completed: false,
                tagIds: ['tag-1'],
                parentTaskId: 'project-1',
                repetition: {
                    byDay: 'MO,WE',
                    fromCompletion: true,
                    interval: 2,
                    unit: 'weekly',
                },
                projectId: 'project-1',
                completionDate: null,
            },
            {
                id: 'task-1a',
                name: 'Confirm scope',
                note: '',
                dueDate: null,
                deferDate: null,
                plannedDate: null,
                flagged: false,
                completed: true,
                tagIds: [],
                parentTaskId: 'task-1',
                repetition: null,
                projectId: 'project-1',
                completionDate: '2026-04-21T08:00:00.000Z',
            },
            {
                id: 'task-1b',
                name: 'Book room',
                note: 'Need room',
                dueDate: '2026-04-24',
                deferDate: null,
                plannedDate: null,
                flagged: false,
                completed: false,
                tagIds: ['tag-1'],
                parentTaskId: 'task-1',
                repetition: null,
                projectId: 'project-1',
                completionDate: null,
            },
            {
                id: 'task-1c',
                name: 'Share agenda',
                note: 'Email team',
                dueDate: null,
                deferDate: null,
                plannedDate: null,
                flagged: false,
                completed: false,
                tagIds: [],
                parentTaskId: 'task-1b',
                repetition: null,
                projectId: 'project-1',
                completionDate: null,
            },
            {
                id: 'inbox-1',
                name: 'Inbox capture',
                note: '',
                dueDate: null,
                deferDate: null,
                plannedDate: null,
                flagged: false,
                completed: false,
                tagIds: [],
                parentTaskId: null,
                repetition: null,
                projectId: null,
                completionDate: null,
            },
        ],
    })),
    'metadata.json': strToU8(JSON.stringify({
        projects: [
            {
                id: 'project-1',
                name: 'Test project',
                note: 'Metadata project note',
                folderId: 'folder-1',
                folderName: 'Work',
                completed: false,
                status: 'active',
                creationDate: '2026-04-01T00:00:00.000Z',
            },
        ],
        tags: [
            { id: 'tag-1', name: 'Tag 1' },
        ],
    })),
});

describe('omnifocus import', () => {
    it('parses OmniFocus CSV rows into projects and tasks, preserving unmapped fields in notes', () => {
        const csv = [
            'Task ID,Type,Name,Status,Project,Context,Start Date,Planned Date,Due Date,Completion Date,Duration,Flagged,Notes,Tags',
            '1,Project,House Renovation,Active,,,,,2026-05-10,,,0,Project support note,Home',
            '2,Action,Buy paint,Available,House Renovation,Errands,2026-05-01,2026-05-03,2026-05-06,,45m,1,Eggshell white,Deep Work',
            '3,Action,Inbox follow-up,Completed,,Calls,"May 7, 2026","May 8, 2026","May 9, 2026","May 10, 2026",,0,Call contractor,Phone',
            '4,Action Group,Pack tools,Available,House Renovation,,,,,,0,,Prep list,Workshop',
        ].join('\n');

        const result = parseOmniFocusImportSource({
            fileName: 'OmniFocus Export.csv',
            text: csv,
        });

        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
        expect(result.preview).toMatchObject({
            fileName: 'OmniFocus Export.csv',
            projectCount: 1,
            taskCount: 3,
            standaloneTaskCount: 1,
            projects: [{ name: 'House Renovation', taskCount: 2 }],
        });
        expect(result.warnings).toContain('4 OmniFocus dates could not be mapped directly and were preserved in notes.');

        const parsed = result.parsedData;
        expect(parsed).not.toBeNull();
        expect(parsed?.projects[0]).toMatchObject({
            name: 'House Renovation',
            status: 'active',
            dueDate: '2026-05-10',
            tagIds: ['#home'],
        });
        expect(parsed?.projects[0]?.supportNotes).toContain('Project support note');

        const projectTask = parsed?.tasks.find((task) => task.title === 'Buy paint');
        expect(projectTask).toMatchObject({
            projectSourceKey: 'house renovation',
            contexts: ['@Errands'],
            tags: ['#deep work'],
            startTime: '2026-05-01',
            dueDate: '2026-05-06',
            priority: 'high',
            status: 'inbox',
        });
        expect(projectTask?.description).toContain('Eggshell white');
        expect(projectTask?.description).toContain('Planned date in OmniFocus: 2026-05-03');
        expect(projectTask?.description).toContain('Estimated duration in OmniFocus: 45m');

        const completedStandaloneTask = parsed?.tasks.find((task) => task.title === 'Inbox follow-up');
        expect(completedStandaloneTask).toMatchObject({
            status: 'done',
            projectSourceKey: undefined,
            contexts: ['@Calls'],
            tags: ['#phone'],
        });
        expect(completedStandaloneTask?.description).toContain('Original OmniFocus start date: May 7, 2026');
        expect(completedStandaloneTask?.description).toContain('Original OmniFocus planned date: May 8, 2026');
        expect(completedStandaloneTask?.description).toContain('Original OmniFocus due date: May 9, 2026');
        expect(completedStandaloneTask?.description).toContain('Original OmniFocus completion date: May 10, 2026');
    });

    it('parses UTF-16 OmniFocus CSV files', () => {
        const csv = [
            'Task ID,Type,Name,Status,Project,Context,Start Date,Planned Date,Due Date,Completion Date,Duration,Flagged,Notes,Tags',
            '1,Action,Sample inbox task,Available,,,,,,,,0,,',
        ].join('\n');

        const result = parseOmniFocusImportSource({
            fileName: 'OmniFocus UTF16.csv',
            bytes: encodeUtf16Le(csv),
        });

        expect(result.valid).toBe(true);
        expect(result.preview).toMatchObject({
            projectCount: 0,
            taskCount: 1,
            standaloneTaskCount: 1,
        });
        expect(result.parsedData?.tasks[0]).toMatchObject({
            title: 'Sample inbox task',
            status: 'inbox',
        });
    });

    it('imports parsed OmniFocus data into projects and standalone inbox tasks', () => {
        const parseResult = parseOmniFocusImportSource({
            fileName: 'OmniFocus Export.csv',
            text: [
                'Task ID,Type,Name,Status,Project,Context,Start Date,Planned Date,Due Date,Completion Date,Duration,Flagged,Notes,Tags',
                '1,Project,House Renovation,Active,,,,,2026-05-10,,,0,Project support note,Home',
                '2,Action,Buy paint,Available,House Renovation,Errands,2026-05-01,,2026-05-06,,45m,1,Eggshell white,Deep Work',
                '3,Action,Inbox follow-up,Available,,Calls,,,,,,0,Call contractor,Phone',
            ].join('\n'),
        });
        if (!parseResult.valid || !parseResult.parsedData) {
            throw new Error('Expected OmniFocus sample export to parse.');
        }

        const existingProject: Project = {
            id: 'project-existing',
            title: 'House Renovation',
            status: 'active',
            color: '#111827',
            order: 0,
            tagIds: [],
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
        };

        const result = applyOmniFocusImport(
            mockAppData([], [existingProject], []),
            parseResult.parsedData,
            { now: '2026-05-02T12:00:00.000Z' }
        );

        expect(result.importedProjectCount).toBe(1);
        expect(result.importedTaskCount).toBe(2);
        expect(result.importedStandaloneTaskCount).toBe(1);
        expect(result.warnings).toContain('Imported project "House Renovation" was renamed to "House Renovation (OmniFocus)" to avoid a title conflict.');
        expect(result.data.settings.deviceId).toBeTruthy();

        const importedProject = result.data.projects.find((project) => project.id !== existingProject.id);
        expect(importedProject).toMatchObject({
            title: 'House Renovation (OmniFocus)',
            status: 'active',
            dueDate: '2026-05-10',
            supportNotes: 'Project support note',
            tagIds: ['#home'],
        });

        const projectTask = result.data.tasks.find((task) => task.title === 'Buy paint');
        expect(projectTask).toMatchObject({
            projectId: importedProject?.id,
            status: 'inbox',
            priority: 'high',
            tags: ['#deep work'],
            contexts: ['@Errands'],
            dueDate: '2026-05-06',
            startTime: '2026-05-01',
        });
        expect(projectTask?.description).toContain('Eggshell white');

        const standaloneTask = result.data.tasks.find((task) => task.title === 'Inbox follow-up');
        expect(standaloneTask).toMatchObject({
            status: 'inbox',
            tags: ['#phone'],
            contexts: ['@Calls'],
            description: 'Call contractor',
        });
    });

    it('parses OmniFocus Omni Automation JSON ZIP exports into projects, checklist items, and recurring tasks', () => {
        const result = parseOmniFocusImportSource({
            fileName: 'omnifocus-json-export.zip',
            bytes: buildOmniFocusJsonZip(),
        });

        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
        expect(result.preview).toMatchObject({
            areaCount: 1,
            checklistItemCount: 1,
            fileName: 'omnifocus-json-export.zip',
            projectCount: 1,
            taskCount: 4,
            standaloneTaskCount: 1,
            projects: [{ name: 'Test project', taskCount: 3 }],
        });
        expect(result.warnings).toContain(
            '2 nested OmniFocus tasks were flattened because Mindwtr cannot preserve their hierarchy directly.'
        );

        const parsed = result.parsedData;
        expect(parsed?.areas[0]).toMatchObject({
            name: 'Work',
        });
        expect(parsed?.projects[0]).toMatchObject({
            areaSourceKey: 'omnifocus-area:folder-1',
            name: 'Test project',
            status: 'active',
            tagIds: ['#tag 1'],
        });
        expect(parsed?.projects[0]?.supportNotes).toContain('Metadata project note');
        expect(parsed?.projects[0]?.supportNotes).toContain('Root project note');

        const parentTask = parsed?.tasks.find((task) => task.title === 'Plan sprint');
        expect(parentTask).toMatchObject({
            checklist: [{ title: 'Confirm scope', isCompleted: true }],
            dueDate: '2026-04-23T21:00:00.000Z',
            priority: 'high',
            projectSourceKey: 'omnifocus-project:project-1',
            recurrence: {
                byDay: ['MO', 'WE'],
                rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE',
                rule: 'weekly',
                strategy: 'fluid',
            },
            startTime: '2026-04-20',
            status: 'inbox',
            tags: ['#tag 1'],
        });
        expect(parentTask?.description).toContain('Plan details');
        expect(parentTask?.description).toContain('Planned date in OmniFocus: 2026-04-22');

        const flattenedChild = parsed?.tasks.find((task) => task.title === 'Plan sprint -> Book room');
        expect(flattenedChild).toMatchObject({
            dueDate: '2026-04-24',
            projectSourceKey: 'omnifocus-project:project-1',
            tags: ['#tag 1'],
        });
        expect(flattenedChild?.description).toContain('Original OmniFocus hierarchy: Plan sprint');

        const deepFlattenedChild = parsed?.tasks.find((task) => task.title === 'Plan sprint -> Book room -> Share agenda');
        expect(deepFlattenedChild?.description).toContain('Original OmniFocus hierarchy: Plan sprint > Book room');
    });

    it('imports OmniFocus Omni Automation JSON ZIP exports into areas, projects, and checklist tasks', () => {
        const parseResult = parseOmniFocusImportSource({
            fileName: 'omnifocus-json-export.zip',
            bytes: buildOmniFocusJsonZip(),
        });
        if (!parseResult.valid || !parseResult.parsedData) {
            throw new Error('Expected OmniFocus JSON ZIP export to parse.');
        }

        const result = applyOmniFocusImport(
            mockAppData([], [], []),
            parseResult.parsedData,
            { now: '2026-05-02T12:00:00.000Z' }
        );

        expect(result.importedAreaCount).toBe(1);
        expect(result.importedChecklistItemCount).toBe(1);
        expect(result.importedProjectCount).toBe(1);
        expect(result.importedTaskCount).toBe(4);
        expect(result.importedStandaloneTaskCount).toBe(1);

        const importedArea = result.data.areas[0];
        expect(importedArea).toMatchObject({
            name: 'Work',
        });

        const importedProject = result.data.projects[0];
        expect(importedProject).toMatchObject({
            areaId: importedArea?.id,
            status: 'active',
            tagIds: ['#tag 1'],
            title: 'Test project',
        });

        const checklistTask = result.data.tasks.find((task) => task.title === 'Plan sprint');
        expect(checklistTask).toMatchObject({
            checklist: [{ title: 'Confirm scope', isCompleted: true }],
            dueDate: '2026-04-23T21:00:00.000Z',
            priority: 'high',
            projectId: importedProject?.id,
            recurrence: {
                byDay: ['MO', 'WE'],
                rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE',
                rule: 'weekly',
                strategy: 'fluid',
            },
            startTime: '2026-04-20',
            tags: ['#tag 1'],
            taskMode: 'list',
        });

        const flattenedTask = result.data.tasks.find((task) => task.title === 'Plan sprint -> Book room');
        expect(flattenedTask?.description).toContain('Original OmniFocus hierarchy: Plan sprint');

        const standaloneTask = result.data.tasks.find((task) => task.title === 'Inbox capture');
        expect(standaloneTask).toMatchObject({
            status: 'inbox',
        });
    });
});
