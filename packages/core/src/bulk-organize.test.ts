import { describe, expect, it } from 'vitest';

import {
    buildBulkOrganizeTaskUpdate,
    buildBulkOrganizeTaskUpdates,
    parseBulkOrganizeTokenInput,
    type BulkOrganizeTaskUpdateInput,
} from './bulk-organize';
import type { Task } from './types';

const baseTask = (id: string): Task => ({
    id,
    title: `Task ${id}`,
    status: 'inbox',
    contexts: ['@home'],
    tags: ['#alpha'],
    description: `Description ${id}`,
    createdAt: '2026-06-04T00:00:00.000Z',
    updatedAt: '2026-06-04T00:00:00.000Z',
});

describe('bulk organize', () => {
    it('builds shared organize updates without title or description', () => {
        const input: BulkOrganizeTaskUpdateInput = {
            status: 'next',
            projectId: 'project-1',
            contexts: ['@computer'],
            tags: ['#launch'],
            startTime: '2026-06-05',
            dueDate: '2026-06-10',
        };

        const updates = buildBulkOrganizeTaskUpdate(baseTask('task-1'), input);

        expect(updates).toEqual({
            status: 'next',
            projectId: 'project-1',
            areaId: undefined,
            contexts: ['@home', '@computer'],
            tags: ['#alpha', '#launch'],
            startTime: '2026-06-05',
            dueDate: '2026-06-10',
        });
        expect('title' in updates).toBe(false);
        expect('description' in updates).toBe(false);
    });

    it('lets area assignment win when no project is selected', () => {
        const updates = buildBulkOrganizeTaskUpdate(baseTask('task-1'), {
            status: 'next',
            areaId: 'area-1',
        });

        expect(updates).toMatchObject({
            status: 'next',
            areaId: 'area-1',
            projectId: undefined,
        });
    });

    it('skips missing task ids when building a batch', () => {
        const task = baseTask('task-1');
        const updates = buildBulkOrganizeTaskUpdates(['task-1', 'missing'], new Map([[task.id, task]]), {
            status: 'waiting',
            assignedTo: 'Mina',
            reviewAt: '2026-06-12',
        });

        expect(updates).toEqual([
            {
                id: 'task-1',
                updates: {
                    status: 'waiting',
                    assignedTo: 'Mina',
                    reviewAt: '2026-06-12',
                },
            },
        ]);
    });

    it('applies a section to tasks already in that section\'s project', () => {
        const updates = buildBulkOrganizeTaskUpdate(
            { ...baseTask('task-1'), projectId: 'project-1' },
            { sectionId: 'section-1', sectionProjectId: 'project-1' },
        );

        expect(updates).toEqual({ sectionId: 'section-1' });
    });

    it('applies a section alongside a matching project move', () => {
        const updates = buildBulkOrganizeTaskUpdate(
            { ...baseTask('task-1'), projectId: 'project-2' },
            { projectId: 'project-1', sectionId: 'section-1', sectionProjectId: 'project-1' },
        );

        expect(updates).toEqual({
            projectId: 'project-1',
            areaId: undefined,
            sectionId: 'section-1',
        });
    });

    it('clears the section when the input asks for no section', () => {
        const updates = buildBulkOrganizeTaskUpdate(
            { ...baseTask('task-1'), projectId: 'project-1' },
            { sectionId: null },
        );

        expect(updates).toEqual({ sectionId: undefined });
        expect('sectionId' in updates).toBe(true);
    });

    it('ignores a section that belongs to a different project than the task lands in', () => {
        const movedToAnotherProject = buildBulkOrganizeTaskUpdate(
            { ...baseTask('task-1'), projectId: 'project-1' },
            { projectId: 'project-2', sectionId: 'section-1', sectionProjectId: 'project-1' },
        );
        expect('sectionId' in movedToAnotherProject).toBe(false);

        const taskInAnotherProject = buildBulkOrganizeTaskUpdate(
            { ...baseTask('task-2'), projectId: 'project-9' },
            { sectionId: 'section-1', sectionProjectId: 'project-1' },
        );
        expect('sectionId' in taskInAnotherProject).toBe(false);
    });

    it('ignores a section when the task ends up with no project at all', () => {
        const clearedProject = buildBulkOrganizeTaskUpdate(
            { ...baseTask('task-1'), projectId: 'project-1' },
            { projectId: null, sectionId: 'section-1', sectionProjectId: 'project-1' },
        );
        expect('sectionId' in clearedProject).toBe(false);

        const noProject = buildBulkOrganizeTaskUpdate(baseTask('task-1'), {
            sectionId: 'section-1',
            sectionProjectId: 'project-1',
        });
        expect('sectionId' in noProject).toBe(false);
    });

    it('never applies a section without the owning project id', () => {
        const updates = buildBulkOrganizeTaskUpdate(
            { ...baseTask('task-1'), projectId: 'project-1' },
            { sectionId: 'section-1' },
        );

        expect('sectionId' in updates).toBe(false);
    });

    it('normalizes bulk token input', () => {
        expect(parseBulkOrganizeTokenInput('@home computer,computer', '@')).toEqual(['@home', '@computer']);
        expect(parseBulkOrganizeTokenInput('#launch inbox,launch', '#')).toEqual(['#launch', '#inbox']);
    });

    it('keeps the current status when the input omits status', () => {
        const updates = buildBulkOrganizeTaskUpdate(baseTask('1'), {
            contexts: ['@office'],
        });
        expect('status' in updates).toBe(false);
        expect(updates.contexts).toEqual(['@home', '@office']);
    });

    it('skips tasks entirely when an all-keep input has nothing to change', () => {
        const tasksById = new Map([['1', baseTask('1')]]);
        const updates = buildBulkOrganizeTaskUpdates(['1'], tasksById, {});
        expect(updates).toEqual([]);
    });
});
