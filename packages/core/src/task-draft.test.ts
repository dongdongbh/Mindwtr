import { describe, expect, it } from 'vitest';
import type { Task } from './types';

import {
    areDraftAttachmentsDirty,
    createTaskDraft,
    isTaskDraftDirty,
    setTaskDraftField,
    taskDraftToUpdatePatch,
} from './task-draft';

const baseTask: Task = {
    id: 'task-1',
    title: 'Write report',
    status: 'next',
    tags: ['#work'],
    contexts: ['@office'],
    description: 'First pass',
    projectId: 'project-1',
    sectionId: 'section-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('task-draft', () => {
    it('a fresh draft is never dirty', () => {
        expect(isTaskDraftDirty(createTaskDraft(baseTask), baseTask)).toBe(false);
    });

    it('setTaskDraftField returns the same draft when the value is unchanged', () => {
        const draft = createTaskDraft(baseTask);
        expect(setTaskDraftField(draft, 'title', draft.title)).toBe(draft);
        expect(setTaskDraftField(draft, 'status', draft.status)).toBe(draft);
    });

    it('setTaskDraftField sets a field without touching the original draft', () => {
        const draft = createTaskDraft(baseTask);
        const next = setTaskDraftField(draft, 'title', 'Write report v2');
        expect(next).not.toBe(draft);
        expect(next.title).toBe('Write report v2');
        expect(draft.title).toBe('Write report');
    });

    it('sending a draft back to Inbox drops its focus star', () => {
        const starred: Task = { ...baseTask, isFocusedToday: true };
        const draft = createTaskDraft(starred);
        expect(draft.focusedToday).toBe(true);

        const backToInbox = setTaskDraftField(draft, 'status', 'inbox');
        expect(backToInbox.status).toBe('inbox');
        expect(backToInbox.focusedToday).toBe(false);

        // Any other status keeps the star.
        const toWaiting = setTaskDraftField(draft, 'status', 'waiting');
        expect(toWaiting.focusedToday).toBe(true);
    });

    it('retains a Someday-section assignment across status changes', () => {
        const somedayTask: Task = {
            ...baseTask,
            status: 'someday',
            viewSectionIds: { someday: 'books' },
        };
        const nextDraft = setTaskDraftField(createTaskDraft(somedayTask), 'status', 'next');

        expect(nextDraft.viewSectionIds).toEqual({ someday: 'books' });
        expect(taskDraftToUpdatePatch(nextDraft, somedayTask)).toMatchObject({
            status: 'next',
            viewSectionIds: { someday: 'books' },
        });
    });

    it('compares section maps without insertion order while preserving an explicit clear', () => {
        const assigned: Task = {
            ...baseTask,
            viewSectionIds: { someday: 'books', waiting: 'people' },
        };
        const draft = createTaskDraft(assigned);

        expect(isTaskDraftDirty({
            ...draft,
            viewSectionIds: { waiting: 'people', someday: 'books' },
        }, assigned)).toBe(false);
        expect(isTaskDraftDirty({ ...draft, viewSectionIds: {} }, assigned)).toBe(true);
        expect(isTaskDraftDirty({ ...createTaskDraft(baseTask), viewSectionIds: {} }, baseTask)).toBe(true);
    });

    it('the inbox cascade result round-trips through the dirty check', () => {
        const starred: Task = { ...baseTask, isFocusedToday: true };
        const draft = setTaskDraftField(createTaskDraft(starred), 'status', 'inbox');
        expect(isTaskDraftDirty(draft, starred)).toBe(true);
        expect(taskDraftToUpdatePatch(draft, starred)).toMatchObject({
            status: 'inbox',
            isFocusedToday: false,
        });
    });

    it('owns completion and reminder-handoff fields with the status cascade', () => {
        const completed: Task = {
            ...baseTask,
            status: 'done',
            completedAt: '2026-01-02T12:00:00.000Z',
            suppressMindwtrReminders: true,
        };
        const draft = createTaskDraft(completed);

        expect(draft).toMatchObject({
            completedAt: '2026-01-02T12:00:00.000Z',
            suppressMindwtrReminders: true,
        });
        const reopened = setTaskDraftField(draft, 'status', 'next');
        expect(reopened.completedAt).toBe('');
        expect(taskDraftToUpdatePatch(reopened, completed)).toMatchObject({
            status: 'next',
            completedAt: undefined,
            suppressMindwtrReminders: true,
        });
    });

    it('enforces direction-specific status invariants at the field write seam', () => {
        const inboxDraft = createTaskDraft({ ...baseTask, status: 'inbox' });
        const focusedInbox = setTaskDraftField(inboxDraft, 'focusedToday', true);
        expect(focusedInbox).toMatchObject({ focusedToday: true, status: 'next' });

        const activeDraft = createTaskDraft(baseTask);
        const completedActive = setTaskDraftField(
            activeDraft,
            'completedAt',
            '2026-01-02T12:00:00.000Z',
        );
        expect(completedActive.completedAt).toBe('');
    });

    it('detects a change in any field and ignores token whitespace', () => {
        const draft = createTaskDraft(baseTask);
        expect(isTaskDraftDirty({ ...draft, title: 'Write report v2' }, baseTask)).toBe(true);
        expect(isTaskDraftDirty({ ...draft, focusedToday: true }, baseTask)).toBe(true);
        expect(isTaskDraftDirty({ ...draft, contexts: ' @office ' }, baseTask)).toBe(false);
        expect(isTaskDraftDirty({ ...draft, repeatReminderMinutes: undefined }, baseTask)).toBe(false);
    });

    it('compares relative start offsets structurally', () => {
        const withOffset: Task = { ...baseTask, relativeStartOffset: { amount: 2, unit: 'day' } };
        const draft = createTaskDraft(withOffset);
        expect(isTaskDraftDirty(draft, withOffset)).toBe(false);
        expect(isTaskDraftDirty({ ...draft, relativeStartOffset: undefined }, withOffset)).toBe(true);
    });

    it('counts attachment record changes as dirty', () => {
        const withAttachment: Task = {
            ...baseTask,
            attachments: [{ id: 'a1', kind: 'link', uri: 'https://a', title: 'A', createdAt: baseTask.createdAt, updatedAt: baseTask.updatedAt }],
        };
        const same = withAttachment.attachments;
        expect(areDraftAttachmentsDirty(same, withAttachment)).toBe(false);
        expect(areDraftAttachmentsDirty([], withAttachment)).toBe(true);
        expect(areDraftAttachmentsDirty(
            [{ ...same![0], uri: 'https://b' }],
            withAttachment,
        )).toBe(true);
        expect(areDraftAttachmentsDirty(
            [{ ...same![0], deletedAt: '2026-01-02T00:00:00.000Z' }],
            withAttachment,
        )).toBe(true);
    });

    it('serializes container exclusivity: project home clears area, no project drops section', () => {
        const draft = createTaskDraft(baseTask);
        const withProject = taskDraftToUpdatePatch({ ...draft, areaId: 'area-9' }, baseTask);
        expect(withProject).toMatchObject({ projectId: 'project-1', sectionId: 'section-1', areaId: undefined });

        const noProject = taskDraftToUpdatePatch({ ...draft, projectId: '', areaId: 'area-9' }, baseTask);
        expect(noProject).toMatchObject({ projectId: undefined, sectionId: undefined, areaId: 'area-9' });
    });

    it('falls back to the task title and refuses an unusable one', () => {
        const draft = createTaskDraft(baseTask);
        expect(taskDraftToUpdatePatch({ ...draft, title: '   ' }, baseTask)).toMatchObject({ title: 'Write report' });

        const untitled: Task = { ...baseTask, title: '' };
        expect(taskDraftToUpdatePatch({ ...createTaskDraft(untitled), title: ' ' }, untitled)).toBeNull();
    });

    it('assembles recurrence from the rrule and preserves completed occurrences', () => {
        const recurringTask: Task = {
            ...baseTask,
            recurrence: { rule: 'weekly', strategy: 'strict', completedOccurrences: 3 } as Task['recurrence'],
        };
        const draft = createTaskDraft(recurringTask);
        const patch = taskDraftToUpdatePatch(
            { ...draft, recurrenceRRule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=5;WKST=SU' },
            recurringTask,
        );
        expect(patch?.recurrence).toMatchObject({
            rule: 'weekly',
            strategy: 'strict',
            count: 5,
            weekStart: 'SU',
            completedOccurrences: 3,
            rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=5;WKST=SU',
        });
    });

    it('preserves completed occurrences when recurrence has no rrule', () => {
        const recurringTask: Task = {
            ...baseTask,
            recurrence: { rule: 'daily', strategy: 'strict', completedOccurrences: 4 },
        };
        const draft = createTaskDraft(recurringTask);

        expect(taskDraftToUpdatePatch(draft, recurringTask)?.recurrence).toMatchObject({
            rule: 'daily',
            strategy: 'strict',
            completedOccurrences: 4,
        });
    });

    it('preserves recurrence anchors when an unrelated draft field changes', () => {
        const recurringTask: Task = {
            ...baseTask,
            recurrence: {
                rule: 'monthly',
                strategy: 'strict',
                anchorDay: 31,
                startAnchorDay: 30,
                dueAnchorDay: 31,
                reviewAnchorDay: 29,
            },
        };
        const draft = createTaskDraft(recurringTask);

        expect(taskDraftToUpdatePatch(
            { ...draft, title: 'Write revised report' },
            recurringTask,
        )?.recurrence).toMatchObject({
            rule: 'monthly',
            strategy: 'strict',
            anchorDay: 31,
            startAnchorDay: 30,
            dueAnchorDay: 31,
            reviewAnchorDay: 29,
        });
    });

    it('keeps checklist data out of description patches', () => {
        const withChecklist: Task = {
            ...baseTask,
            checklist: [
                {
                    id: 'check-1',
                    text: 'Standalone checklist item',
                    completed: false,
                    createdAt: baseTask.createdAt,
                    updatedAt: baseTask.updatedAt,
                },
            ],
        };
        const draft = createTaskDraft(withChecklist);
        const patch = taskDraftToUpdatePatch(
            { ...draft, description: '- [ ] Markdown text only' },
            withChecklist,
        );
        expect(patch?.description).toBe('- [ ] Markdown text only');
        expect(patch).not.toHaveProperty('checklist');
    });

    it('splits token fields and drops empties in the patch', () => {
        const draft = createTaskDraft(baseTask);
        const patch = taskDraftToUpdatePatch({ ...draft, contexts: '@office, , @home ', tags: '' }, baseTask);
        expect(patch).toMatchObject({ contexts: ['@office', '@home'], tags: [] });
    });

    it('normalizes bare context/tag tokens to their prefix (#1013)', () => {
        const draft = createTaskDraft(baseTask);
        const patch = taskDraftToUpdatePatch(
            { ...draft, contexts: 'home, @office', tags: 'urgent, #q3' },
            baseTask,
        );
        expect(patch).toMatchObject({
            contexts: ['@home', '@office'],
            tags: ['#urgent', '#q3'],
        });
    });

    it('leaves already-prefixed tokens unchanged (idempotent)', () => {
        const draft = createTaskDraft(baseTask);
        const patch = taskDraftToUpdatePatch(
            { ...draft, contexts: '@home, @office', tags: '#urgent, #q3' },
            baseTask,
        );
        expect(patch).toMatchObject({
            contexts: ['@home', '@office'],
            tags: ['#urgent', '#q3'],
        });
    });

    it('collapses doubled prefixes and drops whitespace-only tokens', () => {
        const draft = createTaskDraft(baseTask);
        const patch = taskDraftToUpdatePatch(
            { ...draft, contexts: '@@home,   ', tags: '  , ##q3' },
            baseTask,
        );
        expect(patch).toMatchObject({
            contexts: ['@home'],
            tags: ['#q3'],
        });
    });
    it('omits the attachments key when the draft buffer is empty or absent', () => {
        const withAttachment: Task = {
            ...baseTask,
            attachments: [{ id: 'a1', kind: 'link', uri: 'https://a', title: 'A', createdAt: baseTask.createdAt, updatedAt: baseTask.updatedAt }],
        };
        const draft = createTaskDraft(withAttachment);
        const noOption = taskDraftToUpdatePatch(draft, withAttachment);
        expect(noOption && 'attachments' in noOption).toBe(false);
        const emptyBuffer = taskDraftToUpdatePatch(draft, withAttachment, { attachments: [] });
        expect(emptyBuffer && 'attachments' in emptyBuffer).toBe(false);
        // A populated buffer (including soft-deleted records) passes through.
        const removedAll = taskDraftToUpdatePatch(draft, withAttachment, {
            attachments: [{ ...withAttachment.attachments![0], deletedAt: '2026-01-02T00:00:00.000Z' }],
        });
        expect(removedAll?.attachments?.[0]?.deletedAt).toBe('2026-01-02T00:00:00.000Z');
    });
});
