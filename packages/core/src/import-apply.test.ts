import { describe, expect, it } from 'vitest';

import { applyImport, type ImportSource } from './import-apply';
import { mockAppData } from './sync-test-utils';
import type { Area, Project, Task } from './types';


const idFor = (kind: 'area' | 'project' | 'section' | 'task', sourceKey: string): string => `${kind}::${sourceKey}`;

const OPTS = {
    fallbacks: { area: 'Imported Area', project: 'Imported Project' },
    idFor,
    suffix: ' (Test)',
};

describe('applyImport', () => {


    it('dedupes repeated sourceKeys but keeps distinct ones apart', () => {
        const parsed = {
            areas: [],
            projects: [],
            warnings: [],
            tasks: [
                { order: 0, sourceKey: 'a', status: 'inbox', title: 'A' },
                { order: 1, sourceKey: 'b', status: 'inbox', title: 'B' },
            ],
        } as unknown as ImportSource;

        const first = applyImport(mockAppData([], [], []), parsed, { ...OPTS, now: '2026-06-17T12:00:00.000Z' });
        expect(first.data.tasks.map((task) => task.title)).toEqual(['A', 'B']);

        const second = applyImport(first.data, parsed, { ...OPTS, now: '2026-06-18T12:00:00.000Z' });
        expect(second.data.tasks).toHaveLength(2);
    });

    it('renames on name collision, allocates order after existing siblings, and stamps a fresh rev', () => {


        const existingArea: Area = {
            id: idFor('area', 'src-area'),
            name: 'Work',
            color: '#123456',
            order: 0,
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
        };
        const siblingProject: Project = {
            id: 'project-sibling',
            title: 'Something Else',
            status: 'active',
            color: '#111827',
            order: 0,
            tagIds: [],
            areaId: existingArea.id,
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
        };
        const nameCollisionProject: Project = {
            id: 'project-name-collision',
            title: 'Launch',
            status: 'active',
            color: '#111827',
            order: 0,
            tagIds: [],
            areaId: existingArea.id,
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
        };
        const siblingTask: Task = {
            id: 'task-sibling',
            title: 'Existing area task',
            status: 'inbox',
            taskMode: 'task',
            contexts: [],
            tags: [],
            pushCount: 0,
            areaId: existingArea.id,
            order: 0,
            orderNum: 0,
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
        };

        const currentData = mockAppData([siblingTask], [siblingProject, nameCollisionProject], []);
        currentData.areas = [existingArea];

        const parsed: ImportSource = {
            areas: [{ name: 'Work', order: 0, sourceKey: 'src-area' }],
            projects: [{ name: 'Launch', order: 1, sourceKey: 'src-proj', areaSourceKey: 'src-area' }],
            tasks: [{
                title: 'Standalone follow-up',
                order: 1,
                status: 'inbox',
                sourceKey: 'src-task',
                areaSourceKey: 'src-area',
            }],
            warnings: [],
        };

        const result = applyImport(currentData, parsed, { ...OPTS, now: '2026-06-17T12:00:00.000Z' });


        expect(result.importedAreaCount).toBe(0);
        expect(result.data.areas).toHaveLength(1);

        expect(result.importedProjectCount).toBe(1);
        const importedProject = result.data.projects.find((project) => project.id === idFor('project', 'src-proj'));
        expect(importedProject).toMatchObject({
            title: 'Launch (Test)',
            areaId: existingArea.id,
            order: 1,
            rev: 1,
            revBy: result.data.settings.deviceId,
        });
        expect(result.warnings).toContain('Imported project "Launch" was renamed to "Launch (Test)" to avoid a title conflict.');

        expect(result.importedTaskCount).toBe(1);
        expect(result.importedStandaloneTaskCount).toBe(1);
        const importedTask = result.data.tasks.find((task) => task.id === idFor('task', 'src-task'));
        expect(importedTask).toMatchObject({
            areaId: existingArea.id,
            order: 1,
            rev: 1,
            revBy: result.data.settings.deviceId,
        });
    });

    it('carries a project startDate through the same as dueDate', () => {
        const currentData = mockAppData([], [], []);
        const parsed: ImportSource = {
            areas: [],
            projects: [{
                name: 'Launch',
                order: 0,
                sourceKey: 'src-proj',
                dueDate: '2026-07-01',
                startDate: '2026-06-15',
            }],
            tasks: [],
            warnings: [],
        };

        const result = applyImport(currentData, parsed, { ...OPTS, now: '2026-06-17T12:00:00.000Z' });

        const importedProject = result.data.projects.find((project) => project.id === idFor('project', 'src-proj'));
        expect(importedProject?.dueDate).toBe('2026-07-01');
        expect(importedProject?.startDate).toBe('2026-06-15');
    });

    it('does not duplicate entities when the same source is imported again', () => {
        const parsed: ImportSource = {
            areas: [{ name: 'Work', order: 0, sourceKey: 'src-area' }],
            projects: [{ name: 'Launch', order: 0, sourceKey: 'src-proj', areaSourceKey: 'src-area' }],
            tasks: [{ title: 'Plan release', order: 0, status: 'inbox', sourceKey: 'src-task', projectSourceKey: 'src-proj' }],
            warnings: [],
        };

        const first = applyImport(mockAppData([], [], []), parsed, { ...OPTS, now: '2026-06-17T12:00:00.000Z' });
        expect(first.importedAreaCount).toBe(1);
        expect(first.importedProjectCount).toBe(1);
        expect(first.importedTaskCount).toBe(1);

        const second = applyImport(first.data, parsed, { ...OPTS, now: '2026-06-18T12:00:00.000Z' });

        expect(second.importedAreaCount).toBe(0);
        expect(second.importedProjectCount).toBe(0);
        expect(second.importedTaskCount).toBe(0);
        expect(second.data.areas).toHaveLength(first.data.areas.length);
        expect(second.data.projects).toHaveLength(first.data.projects.length);
        expect(second.data.tasks).toHaveLength(first.data.tasks.length);
        expect(second.data.tasks.map((task) => task.id)).toEqual(first.data.tasks.map((task) => task.id));
    });

    it('does not resurrect a tombstoned entity on re-import', () => {
        const parsed: ImportSource = {
            areas: [],
            projects: [{ name: 'Launch', order: 0, sourceKey: 'src-proj' }],
            tasks: [],
            warnings: [],
        };

        const first = applyImport(mockAppData([], [], []), parsed, { ...OPTS, now: '2026-06-17T12:00:00.000Z' });
        expect(first.importedProjectCount).toBe(1);
        const importedProjectId = idFor('project', 'src-proj');
        const importedProject = first.data.projects.find((project) => project.id === importedProjectId);
        expect(importedProject).toBeDefined();


        const deletedAt = '2026-06-19T00:00:00.000Z';
        const dataWithTombstone: typeof first.data = {
            ...first.data,
            projects: first.data.projects.map((project) => (
                project.id === importedProjectId
                    ? { ...project, deletedAt, rev: (project.rev ?? 1) + 1 }
                    : project
            )),
        };

        const second = applyImport(dataWithTombstone, parsed, { ...OPTS, now: '2026-06-20T12:00:00.000Z' });

        expect(second.importedProjectCount).toBe(0);
        const stillTombstoned = second.data.projects.find((project) => project.id === importedProjectId);
        expect(stillTombstoned?.deletedAt).toBe(deletedAt);

        expect(second.data.projects.filter((project) => project.title === 'Launch' && !project.deletedAt)).toHaveLength(0);
    });

    it('creates sections and the newer optional task fields, and dedupes the section on re-import', () => {
        const parsed: ImportSource = {
            areas: [],
            projects: [{ name: 'Launch', order: 0, sourceKey: 'src-proj' }],
            sections: [{ name: 'Backlog', order: 0, sourceKey: 'src-proj:backlog', projectSourceKey: 'src-proj' }],
            tasks: [{
                title: 'Plan release',
                order: 0,
                status: 'inbox',
                sourceKey: 'src-task',
                projectSourceKey: 'src-proj',
                sectionSourceKey: 'src-proj:backlog',
                assignedTo: 'Alex',
                energyLevel: 'low',
                location: 'Office',
                reviewAt: '2026-07-01',
            }],
            warnings: [],
        };

        const first = applyImport(mockAppData([], [], []), parsed, { ...OPTS, now: '2026-06-17T12:00:00.000Z' });
        expect(first.importedSectionCount).toBe(1);
        const section = first.data.sections[0];
        const task = first.data.tasks[0];
        expect(task).toMatchObject({
            sectionId: section.id,
            assignedTo: 'Alex',
            energyLevel: 'low',
            location: 'Office',
            reviewAt: '2026-07-01',
        });


        const second = applyImport(first.data, parsed, { ...OPTS, now: '2026-06-18T12:00:00.000Z' });
        expect(second.importedSectionCount).toBe(0);
        expect(second.data.sections).toHaveLength(1);
    });


    it('clears scheduling fields on an imported reference task', () => {
        const parsed: ImportSource = {
            areas: [],
            projects: [],
            tasks: [{
                title: 'Reference material',
                order: 0,
                status: 'reference',
                sourceKey: 'src-ref',
                dueDate: '2026-07-01',
                startTime: '2026-06-20T09:00:00.000Z',
                reviewAt: '2026-07-05',
                priority: 'high',
                recurrence: { rule: 'weekly' },
                isFocusedToday: true,
            }],
            warnings: [],
        } as unknown as ImportSource;

        const result = applyImport(mockAppData([], [], []), parsed, { ...OPTS, now: '2026-06-17T12:00:00.000Z' });
        const task = result.data.tasks[0];
        expect(task.status).toBe('reference');
        expect(task.dueDate).toBeUndefined();
        expect(task.startTime).toBeUndefined();
        expect(task.reviewAt).toBeUndefined();
        expect(task.priority).toBeUndefined();
        expect(task.recurrence).toBeUndefined();
        expect(task.isFocusedToday).toBe(false);
    });
});
