import { describe, expect, it } from 'vitest';

import { startProcessInboxSession } from './process-inbox-session';
import {
    commitProcessInboxWorkflowEvent,
    resolveProcessInboxContainerFields,
    resolveProcessInboxWorkflowEvent,
} from './process-inbox-workflow';

describe('resolveProcessInboxWorkflowEvent', () => {
    it('turns discard into a delete effect', () => {
        expect(resolveProcessInboxWorkflowEvent({ type: 'discard' })).toEqual({ type: 'delete' });
    });

    it.each([
        ['someday', 'someday'],
        ['reference', 'reference'],
        ['complete', 'done'],
    ] as const)('maps %s to the matching terminal status', (type, status) => {
        expect(resolveProcessInboxWorkflowEvent({ type })).toEqual({
            type: 'update',
            updates: { status },
        });
    });

    it.each(['someday', 'reference', 'complete'] as const)(
        'keeps the picked project when %s ends the processing pass (#958)',
        (type) => {
            expect(resolveProcessInboxWorkflowEvent({
                type,
                fields: resolveProcessInboxContainerFields('project-1', 'area-1'),
            })).toMatchObject({
                type: 'update',
                updates: { projectId: 'project-1', areaId: undefined },
            });
        },
    );

    it('drops the area once a project is picked, and keeps it otherwise', () => {
        expect(resolveProcessInboxContainerFields('project-1', 'area-1'))
            .toEqual({ projectId: 'project-1', areaId: undefined });
        expect(resolveProcessInboxContainerFields(null, 'area-1'))
            .toEqual({ projectId: undefined, areaId: 'area-1' });
        expect(resolveProcessInboxContainerFields('', ''))
            .toEqual({ projectId: undefined, areaId: undefined });
    });

    it('preserves the fields supplied by a platform for a next action', () => {
        expect(resolveProcessInboxWorkflowEvent({
            type: 'next',
            fields: {
                projectId: 'project-1',
                areaId: undefined,
                contexts: ['@office'],
                startTime: '2026-07-15',
            },
        })).toEqual({
            type: 'update',
            updates: {
                status: 'next',
                projectId: 'project-1',
                areaId: undefined,
                contexts: ['@office'],
                startTime: '2026-07-15',
            },
        });
    });

    it('uses next status for Later while retaining an explicit cleared date', () => {
        expect(resolveProcessInboxWorkflowEvent({
            type: 'later',
            fields: { startTime: undefined },
        })).toEqual({
            type: 'update',
            updates: { status: 'next', startTime: undefined },
        });
    });

    it('normalizes the assignee and lets delegate follow-up override review', () => {
        expect(resolveProcessInboxWorkflowEvent({
            type: 'waiting',
            fields: {
                assignedTo: '  Alice  ',
                reviewAt: '2026-07-16',
                dueDate: '2026-07-15',
            },
            followUpAt: '2026-07-20',
        })).toEqual({
            type: 'update',
            updates: {
                status: 'waiting',
                assignedTo: 'Alice',
                reviewAt: '2026-07-20',
                dueDate: '2026-07-15',
            },
        });
    });

    it('keeps an empty assignee as an explicit clear', () => {
        expect(resolveProcessInboxWorkflowEvent({
            type: 'waiting',
            fields: { assignedTo: '   ' },
        })).toEqual({
            type: 'update',
            updates: { status: 'waiting', assignedTo: undefined },
        });
    });

    it('writes clarified fields without changing status when a candidate is skipped', () => {
        expect(resolveProcessInboxWorkflowEvent({
            type: 'skip',
            fields: { contexts: ['@office'], assignedTo: '  Alice  ' },
        })).toEqual({
            type: 'update',
            updates: { contexts: ['@office'], assignedTo: 'Alice' },
        });
    });

    it('advances only after the task write succeeds', async () => {
        const candidates = [{ id: 'task-1' }, { id: 'task-2' }];
        const session = startProcessInboxSession(candidates);
        const failed = await commitProcessInboxWorkflowEvent(
            session,
            candidates,
            { type: 'complete' },
            {
                deleteTask: async () => ({ success: true }),
                updateTask: async () => ({ success: false, error: 'disk full' }),
            },
        );

        expect(failed.session.currentTaskId).toBe('task-1');
        expect(failed.writeResult).toEqual({ success: false, error: 'disk full' });

        const committed = await commitProcessInboxWorkflowEvent(
            session,
            candidates,
            { type: 'complete' },
            {
                deleteTask: async () => ({ success: true }),
                updateTask: async (_taskId, updates) => {
                    expect(updates).toEqual({ status: 'done', title: 'Clarified title' });
                    return { success: true };
                },
            },
            { taskUpdates: { title: 'Clarified title' } },
        );

        expect(committed.session.currentTaskId).toBe('task-2');
    });

    it('records a successful skip so the candidate is not revisited', async () => {
        const candidates = [{ id: 'task-1' }, { id: 'task-2' }];
        const session = startProcessInboxSession(candidates);
        const committed = await commitProcessInboxWorkflowEvent(
            session,
            candidates,
            { type: 'skip', fields: { tags: ['#later'] } },
            {
                deleteTask: async () => ({ success: true }),
                updateTask: async (_taskId, updates) => {
                    expect(updates).toEqual({ tags: ['#later'], title: 'Clarified title' });
                    return { success: true };
                },
            },
            { taskUpdates: { title: 'Clarified title' } },
        );

        expect(committed.session.currentTaskId).toBe('task-2');
        expect(committed.session.skippedTaskIds).toEqual(new Set(['task-1']));
    });
});
