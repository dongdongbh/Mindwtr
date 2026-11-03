import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyTodoistImport, parseTodoistImportSource, type ParsedTodoistProject } from './todoist-import';
import { hasTimeComponent } from './date';
import { getTaskReminderPlan } from './schedule-utils';
import { mockAppData } from './sync-test-utils';
import type { Person, Project, Task } from './types';

describe('todoist import', () => {
    it('parses a CSV export with sections, labels, notes, subtasks, and recurring tasks', () => {
        const csv = [
            'TYPE,CONTENT,PRIORITY,INDENT,DATE,DESCRIPTION',
            'section,Planning,,,,',
            'task,Plan launch @work,1,1,2026-04-02,Write launch brief',
            'note,Share with leadership,,,,',
            'task,Follow up @ops,4,2,2026-04-03,Check dependencies',
            'task,Weekly review @home,2,1,every Monday,',
        ].join('\n');

        const result = parseTodoistImportSource({
            fileName: 'Launch.csv',
            text: csv,
        });

        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
        expect(result.preview).toMatchObject({
            fileName: 'Launch.csv',
            projectCount: 1,
            taskCount: 2,
            checklistItemCount: 1,
            sectionCount: 1,
            recurringCount: 1,
        });
        expect(result.warnings).toContain('1 recurring Todoist task will be imported once.');

        const [project] = result.parsedProjects;
        expect(project).toMatchObject({
            name: 'Launch',
            sections: ['Planning'],
            checklistItemCount: 1,
            recurringCount: 1,
        });
        expect(project.tasks).toHaveLength(2);
        expect(project.tasks[0]).toMatchObject({
            title: 'Plan launch',
            tags: ['#work', '#ops'],
            checklist: ['Follow up'],
            sectionName: 'Planning',
            priority: 'urgent',
            dueDate: '2026-04-02',
        });
        expect(project.tasks[0].description).toContain('Write launch brief');
        expect(project.tasks[0].description).toContain('Share with leadership');
        expect(project.tasks[0].description).toContain('Subtask "Follow up": Check dependencies | Due: 2026-04-03');
        expect(project.tasks[1]).toMatchObject({
            title: 'Weekly review',
            tags: ['#home'],
            priority: 'high',
            recurringText: 'every Monday',
            sectionName: 'Planning',
        });
        expect(project.tasks[1].description).toContain('Imported from Todoist recurring schedule: every Monday');
    });

    it('does not fabricate a due date when a DATE cell is "constructor" (SEC-13)', () => {
        const csv = [
            'TYPE,CONTENT,PRIORITY,INDENT,DATE,DESCRIPTION',
            'task,Odd date value,4,1,constructor,',
        ].join('\n');

        const result = parseTodoistImportSource({
            fileName: 'Bug.csv',
            text: csv,
        });

        expect(result.valid).toBe(true);
        expect(result.parsedProjects[0]?.tasks[0]?.dueDate).toBeUndefined();
        expect(result.warnings).toContain('1 Todoist due date could not be parsed and was skipped.');
    });

    it('parses a Todoist ZIP export and skips unsupported archive entries', () => {
        const inboxCsv = 'TYPE,CONTENT\n task,Inbox task';
        const errandsCsv = [
            'TYPE;CONTENT;INDENT',
            'section;Errands;',
            'task;Buy milk;1',
        ].join('\n');
        const archive = zipSync({
            'Inbox.csv': strToU8(inboxCsv),
            'Errands.csv': strToU8(errandsCsv),
            'notes.txt': strToU8('skip me'),
            'nested.zip': new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
        });

        const result = parseTodoistImportSource({
            fileName: 'todoist-backup.zip',
            bytes: archive,
        });

        expect(result.valid).toBe(true);
        expect(result.parsedProjects).toHaveLength(2);
        expect(result.preview).toMatchObject({
            projectCount: 2,
            taskCount: 2,
            sectionCount: 1,
        });
        expect(result.warnings).toContain('1 non-CSV file inside the Todoist ZIP was skipped.');
        expect(result.warnings).toContain('1 nested ZIP file inside the Todoist archive was skipped.');
        expect(result.parsedProjects.map((project) => project.name)).toEqual(['Inbox', 'Errands']);
        expect(result.parsedProjects[1]?.sections).toEqual(['Errands']);
    });

    it('warns when a Todoist CSV ends with an unclosed quoted field', () => {
        const csv = [
            'TYPE,CONTENT,DESCRIPTION',
            'task,Valid task,Imported cleanly',
            'task,"Broken task',
        ].join('\n');

        const result = parseTodoistImportSource({
            fileName: 'Broken.csv',
            text: csv,
        });

        expect(result.valid).toBe(true);
        expect(result.parsedProjects[0]?.tasks.map((task) => task.title)).toEqual(['Valid task', 'Broken task']);
        expect(result.warnings).toContain('1 Todoist CSV file ended with an unclosed quoted field and was imported best-effort.');
    });

    it('imports parsed Todoist projects into new Mindwtr projects and preserves a recovery-friendly warning trail', () => {
        const existingProject: Project = {
            id: 'project-existing',
            title: 'Launch',
            status: 'active',
            color: '#111827',
            order: 0,
            tagIds: [],
            createdAt: '2026-03-01T00:00:00.000Z',
            updatedAt: '2026-03-01T00:00:00.000Z',
        };
        const parsedProjects: ParsedTodoistProject[] = [
            {
                name: 'Launch',
                sections: ['Planning'],
                checklistItemCount: 1,
                recurringCount: 0,
                tasks: [
                    {
                        title: 'Plan launch',
                        tags: ['#work'],
                        checklist: ['Call vendor'],
                        sectionName: 'Planning',
                        priority: 'high',
                        dueDate: '2026-04-02',
                        description: 'Brief the team.',
                    },
                ],
            },
        ];

        const existingPerson: Person = {
            id: 'person-existing',
            name: 'Alex',
            createdAt: '2026-03-01T00:00:00.000Z',
            updatedAt: '2026-03-01T00:00:00.000Z',
        };
        const currentData = mockAppData([], [existingProject], []);
        currentData.people = [existingPerson];

        const result = applyTodoistImport(
            currentData,
            parsedProjects,
            { now: '2026-03-30T12:00:00.000Z' }
        );

        expect(result.importedProjectCount).toBe(1);
        expect(result.importedSectionCount).toBe(1);
        expect(result.importedTaskCount).toBe(1);
        expect(result.importedChecklistItemCount).toBe(1);
        expect(result.warnings).toContain('Imported project "Launch" was renamed to "Launch (Todoist)" to avoid a title conflict.');
        expect(result.data.settings.deviceId).toBeTruthy();
        expect(result.data.people).toEqual([existingPerson]);

        const importedProject = result.data.projects.find((project) => project.id !== existingProject.id);
        expect(importedProject).toMatchObject({
            title: 'Launch (Todoist)',
            status: 'active',
            order: 1,
        });

        const importedSection = result.data.sections[0];
        expect(importedSection).toMatchObject({
            projectId: importedProject?.id,
            title: 'Planning',
            order: 0,
        });

        const importedTask = result.data.tasks[0];
        expect(importedTask).toMatchObject({
            title: 'Plan launch',
            status: 'next',
            taskMode: 'list',
            projectId: importedProject?.id,
            sectionId: importedSection?.id,
            priority: 'high',
            dueDate: '2026-04-02',
            description: 'Brief the team.',
            tags: ['#work'],
        });
        expect(importedTask.checklist).toHaveLength(1);
        expect(importedTask.checklist?.[0]?.title).toBe('Call vendor');
        expect(importedTask.rev).toBe(1);
        expect(importedTask.revBy).toBe(result.data.settings.deviceId);
    });

    it('does not duplicate Todoist records when the same import is applied again', () => {
        const parsedProjects: ParsedTodoistProject[] = [
            {
                name: 'Launch',
                sections: ['Planning'],
                checklistItemCount: 1,
                recurringCount: 0,
                tasks: [
                    {
                        title: 'Plan launch',
                        tags: ['#work'],
                        checklist: ['Call vendor'],
                        sectionName: 'Planning',
                        priority: 'high',
                        dueDate: '2026-04-02',
                        description: 'Brief the team.',
                    },
                ],
            },
        ];

        const first = applyTodoistImport(mockAppData([], [], []), parsedProjects, { now: '2026-03-30T12:00:00.000Z' });
        const second = applyTodoistImport(first.data, parsedProjects, { now: '2026-03-31T12:00:00.000Z' });

        expect(second.importedProjectCount).toBe(0);
        expect(second.importedSectionCount).toBe(0);
        expect(second.importedTaskCount).toBe(0);
        expect(second.importedChecklistItemCount).toBe(0);
        expect(second.data.projects).toHaveLength(first.data.projects.length);
        expect(second.data.sections).toHaveLength(first.data.sections.length);
        expect(second.data.tasks).toHaveLength(first.data.tasks.length);
        expect(second.data.tasks.map((task) => task.id)).toEqual(first.data.tasks.map((task) => task.id));
    });
});


describe('todoist import > relative and text dates stay date-only', () => {
    const parseDateCell = (cell: string) => parseTodoistImportSource({
        fileName: 'Dates.csv',
        text: [
            'TYPE,CONTENT,PRIORITY,INDENT,DATE,DESCRIPTION',
            `task,Dated task,4,1,${cell},`,
        ].join('\n'),
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    const freeze = () => {
        vi.useFakeTimers();

        vi.setSystemTime(new Date(2026, 8, 15, 14, 37, 0));
    };

    it.each([
        ['today', '2026-09-15'],
        ['tomorrow', '2026-09-16'],
        ['in 3 days', '2026-09-18'],
        ['in 2 weeks', '2026-09-29'],
        ['friday', '2026-09-18'],
        ['5 Mar 2027', '2027-03-05'],
    ])('stores "%s" as %s without a clock time', (cell, expected) => {
        freeze();

        const dueDate = parseDateCell(cell).parsedProjects[0]?.tasks[0]?.dueDate;

        expect(dueDate).toBe(expected);
        expect(hasTimeComponent(dueDate ?? '')).toBe(false);
    });

    it('skips a free-text date without a year instead of inventing one', () => {
        freeze();

        const result = parseDateCell('Mar 5');

        expect(result.parsedProjects[0]?.tasks[0]?.dueDate).toBeUndefined();
        expect(result.warnings).toContain('1 Todoist due date could not be parsed and was skipped.');
    });

    it('keeps a real clock time from the source text', () => {
        freeze();

        const dueDate = parseDateCell('2026-03-05 14:00').parsedProjects[0]?.tasks[0]?.dueDate;

        expect(hasTimeComponent(dueDate ?? '')).toBe(true);
    });

    it('plans no reminder for an imported relative date', () => {
        freeze();
        const dueDate = parseDateCell('tomorrow').parsedProjects[0]?.tasks[0]?.dueDate;
        const task: Task = {
            id: 't',
            title: 'x',
            status: 'next',
            tags: [],
            contexts: [],
            createdAt: '2026-09-15T00:00:00.000Z',
            updatedAt: '2026-09-15T00:00:00.000Z',
            dueDate,
        };

        const plan = getTaskReminderPlan(task, new Date());

        expect(plan.next).toBeNull();
        expect(plan.repeats).toEqual([]);
    });
});
