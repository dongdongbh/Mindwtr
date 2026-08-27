import { describe, expect, it } from 'vitest';

import { startProcessInboxSession } from './process-inbox-session';
import {
    commitProcessInboxWorkflowEvent,
    mergeParsedProcessInboxFields,
    resolveProcessInboxContainerFields,
    resolveProcessInboxWorkflowEvent,
    withParsedProcessInboxFields,
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
});

describe('withParsedProcessInboxFields', () => {
    const parsed = {
        contexts: ['@phone'],
        tags: ['#urgent'],
        assignedTo: 'Bob',
        energyLevel: 'low' as const,
    };

    it('adds parsed tokens to the chips the user toggled instead of replacing them', () => {
        const event = withParsedProcessInboxFields(
            { type: 'next', fields: { contexts: ['@office'], tags: ['#home'] } },
            parsed,
        );
        expect(event).toEqual({
            type: 'next',
            fields: {
                contexts: ['@office', '@phone'],
                tags: ['#home', '#urgent'],
                assignedTo: 'Bob',
                energyLevel: 'low',
            },
        });
    });

    it('keeps a delegate follow-up date while folding the tokens in', () => {
        const event = withParsedProcessInboxFields(
            { type: 'waiting', fields: {}, followUpAt: '2026-09-01T09:00:00.000Z' },
            parsed,
        );
        expect(event).toMatchObject({
            type: 'waiting',
            followUpAt: '2026-09-01T09:00:00.000Z',
            fields: { contexts: ['@phone'], assignedTo: 'Bob' },
        });
    });

    it('leaves a discard alone — trashing writes nothing for a token to land on', () => {
        expect(withParsedProcessInboxFields({ type: 'discard' }, parsed)).toEqual({ type: 'discard' });
    });
});

describe('mergeParsedProcessInboxFields container exclusivity', () => {
    it('drops a picked area when the title names a project (#958)', () => {
        expect(mergeParsedProcessInboxFields({ areaId: 'a1' }, { projectId: 'p1' }))
            .toEqual({ projectId: 'p1', areaId: undefined });
    });

    it('leaves a picked project alone when the title only names an area', () => {
        expect(mergeParsedProcessInboxFields({ projectId: 'p1' }, { areaId: 'a1' }))
            .toEqual({ projectId: 'p1', areaId: undefined });
    });

    it('is a no-op when the title carried no tokens', () => {
        const fields = { contexts: ['@office'], projectId: 'p1' };
        expect(mergeParsedProcessInboxFields(fields, {})).toEqual(fields);
    });
});
