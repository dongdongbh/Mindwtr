import { describe, expect, it } from 'vitest';
import type { Task } from '@mindwtr/core';
import { setTaskDraftField } from '@mindwtr/core/task-draft';

import {
    buildTaskEditUpdatePatch,
    createTaskEditDraft,
    isTaskEditDraftDirty,
} from './task-edit-draft-adapter';

const baseTask: Task = {
    id: 'task-1',
    title: 'Plan launch',
    status: 'next',
    tags: ['#launch'],
    contexts: ['@office'],
    startTime: '2026-07-14T09:00:00.000Z',
    dueDate: '2026-07-18',
    reviewAt: '2026-07-16',
    relativeStartOffset: { amount: -4, unit: 'day' },
    projectId: 'project-1',
    sectionId: 'section-1',
    checklist: [{ id: 'check-1', title: 'Invite reviewers', isCompleted: false }],
    attachments: [{
        id: 'attachment-1',
        kind: 'link',
        uri: 'https://example.com/brief',
        title: 'Brief',
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
    }],
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
};

describe('mobile task edit draft', () => {
    it('owns one fresh TaskDraft with independent checklist and attachment buffers', () => {
        const state = createTaskEditDraft(baseTask);

        expect(state.draft).toMatchObject({
            title: 'Plan launch',
            projectId: 'project-1',
            sectionId: 'section-1',
            contexts: '@office',
        });
        expect(state.checklist).toBe(baseTask.checklist);
        expect(state.attachments).toBe(baseTask.attachments);
        expect(isTaskEditDraftDirty(state, baseTask)).toBe(false);
    });

    it('keeps TaskDraft cascades authoritative', () => {
        const focusedTask: Task = {
            ...baseTask,
            status: 'done',
            isFocusedToday: true,
            completedAt: '2026-07-14T12:00:00.000Z',
        };
        const state = createTaskEditDraft(focusedTask);

        const next = {
            ...state,
            draft: setTaskDraftField(state.draft, 'status', 'inbox'),
        };

        expect(next).not.toBe(state);
        expect(next.draft.status).toBe('inbox');
        expect(next.draft.focusedToday).toBe(false);
        expect(next.draft.completedAt).toBe('');
        expect(buildTaskEditUpdatePatch(next, focusedTask)).toMatchObject({
            status: 'inbox',
            isFocusedToday: false,
            completedAt: undefined,
        });
        expect(focusedTask).toMatchObject({
            status: 'done',
            isFocusedToday: true,
        });
    });

    it('preserves accumulated direct draft edits', () => {
        const state = createTaskEditDraft(baseTask);
        const described = setTaskDraftField(state.draft, 'description', 'Revised brief');
        const located = setTaskDraftField(described, 'location', 'Studio');

        expect(buildTaskEditUpdatePatch({ ...state, draft: located }, baseTask)).toMatchObject({
            description: 'Revised brief',
            location: 'Studio',
        });
    });

    it('serializes recurrence and Container changes through the shared TaskDraft patch', () => {
        const recurringTask: Task = {
            ...baseTask,
            recurrence: {
                rule: 'weekly',
                strategy: 'strict',
                completedOccurrences: 2,
            },
        };
        const state = createTaskEditDraft(recurringTask);
        let draft = setTaskDraftField(state.draft, 'projectId', '');
        draft = setTaskDraftField(draft, 'sectionId', '');
        draft = setTaskDraftField(draft, 'areaId', 'area-1');
        draft = setTaskDraftField(draft, 'location', '  Studio  ');
        draft = setTaskDraftField(draft, 'recurrenceStrategy', 'fluid');
        draft = setTaskDraftField(draft, 'recurrenceRRule', 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5');

        const patch = buildTaskEditUpdatePatch({ ...state, draft }, recurringTask, {
            title: '  Plan launch v2  ',
            description: 'Revised brief',
        });

        expect(patch).toMatchObject({
            title: 'Plan launch v2',
            description: 'Revised brief',
            projectId: undefined,
            sectionId: undefined,
            areaId: 'area-1',
            location: 'Studio',
            recurrence: {
                rule: 'weekly',
                strategy: 'fluid',
                byDay: ['MO', 'WE'],
                count: 5,
                completedOccurrences: 2,
                rrule: 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5',
            },
        });
        expect(patch).not.toHaveProperty('startTime');
        expect(patch).not.toHaveProperty('dueDate');
        expect(patch).not.toHaveProperty('attachments');
        expect(patch).not.toHaveProperty('checklist');
    });

    it('keeps checklist and attachment buffers independent from scalar draft fields', () => {
        const removedAt = '2026-07-15T00:00:00.000Z';
        const state = {
            ...createTaskEditDraft(baseTask),
            checklist: [],
            attachments: baseTask.attachments?.map((attachment) => ({
                ...attachment,
                deletedAt: removedAt,
            })),
        };

        expect(isTaskEditDraftDirty(state, baseTask)).toBe(true);
        expect(state.draft.description).toBe('');
        expect(buildTaskEditUpdatePatch(state, baseTask)).toMatchObject({
            checklist: [],
            attachments: [{ id: 'attachment-1', deletedAt: removedAt }],
        });
        expect(buildTaskEditUpdatePatch(state, baseTask)).not.toHaveProperty('description');
    });

    it('drops blank checklist rows at save so return-minted empties never persist (#1045)', () => {
        const state = {
            ...createTaskEditDraft(baseTask),
            checklist: [
                ...(baseTask.checklist ?? []),
                { id: 'blank-1', title: '   ', isCompleted: false },
            ],
        };

        expect(buildTaskEditUpdatePatch(state, baseTask)).not.toHaveProperty('checklist');

        const withRealEdit = {
            ...createTaskEditDraft(baseTask),
            checklist: [
                ...(baseTask.checklist ?? []),
                { id: 'new-1', title: 'Real item', isCompleted: false },
                { id: 'blank-2', title: '', isCompleted: false },
            ],
        };
        expect(buildTaskEditUpdatePatch(withRealEdit, baseTask)).toMatchObject({
            checklist: [
                ...(baseTask.checklist ?? []),
                { id: 'new-1', title: 'Real item', isCompleted: false },
            ],
        });
    });
});
