import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from './types';
import { buildTaskEditUpdatePatch, createTaskEditDraft } from './task-editor-model';
import * as logger from './logger';

import {
    areDraftAttachmentsDirty,
    createTaskDraft,
    isTaskDraftDirty,
    setTaskDraftField,
    taskDraftToChangedUpdatePatch,
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
    const originalTimezone = process.env.TZ;
    afterEach(() => {
        if (originalTimezone === undefined) delete process.env.TZ;
        else process.env.TZ = originalTimezone;
        vi.restoreAllMocks();
    });

    it('preserves raw timed dates on a title-only save after an editor timezone change and JSON recovery', () => {
        process.env.TZ = 'America/New_York';
        const task = { ...baseTask, startTime: '2026-10-04T14:00:00.000Z', dueDate: '2026-10-05T15:00:00.000Z', reviewAt: '2026-10-06' };
        const opening = createTaskEditDraft(task);
        expect(opening.draft).toMatchObject({ startTime: '2026-10-04T10:00', dueDate: '2026-10-05T11:00' });
        process.env.TZ = 'America/Los_Angeles';
        const recovered = JSON.parse(JSON.stringify(opening));
        const patch = buildTaskEditUpdatePatch(recovered, task, { title: 'After' });

        expect(patch).toEqual({ title: 'After' });
        expect({ ...task, ...patch }).toMatchObject({ startTime: '2026-10-04T14:00:00.000Z', dueDate: '2026-10-05T15:00:00.000Z', reviewAt: '2026-10-06' });
        expect(isTaskDraftDirty(recovered.draft, task)).toBe(false);
    });

    it.each([
        ['absolute Z', '2026-10-05T15:00:00.000Z', '2026-10-05T11:00', true],
        ['absolute offset', '2026-10-05T17:00:00+02:00', '2026-10-05T11:00', true],
        ['floating', '2026-10-05T11:00', '2026-10-05T11:00', false],
        ['date-only', '2026-10-05', '2026-10-05', false],
    ] as const)('preserves %s dates while leaving same-timezone serialization unchanged', (_name, raw, local, shifted) => {
        process.env.TZ = 'America/New_York';
        const task = { ...baseTask, startTime: raw, dueDate: raw, reviewAt: raw };
        const draft = createTaskDraft(task);
        const info = vi.spyOn(logger, 'logInfo').mockImplementation(() => {});
        expect(taskDraftToUpdatePatch(draft, task)).toMatchObject({ startTime: local, dueDate: local, reviewAt: local });
        expect(taskDraftToChangedUpdatePatch(draft, task)).toEqual({});
        expect(info).not.toHaveBeenCalled();

        process.env.TZ = 'America/Los_Angeles';
        const recovered = JSON.parse(JSON.stringify(draft));
        expect(taskDraftToUpdatePatch(recovered, task)).toMatchObject({ startTime: raw, dueDate: raw, reviewAt: raw });
        expect(taskDraftToChangedUpdatePatch({ ...recovered, title: 'After' }, task)).toEqual({ title: 'After' });
        expect(info).toHaveBeenCalledTimes(shifted ? 1 : 0);
        if (shifted) expect(info).toHaveBeenCalledWith('Task draft preserved unchanged dates after timezone change', {
            scope: 'task-draft', category: 'storage', context: { releaseCheck: 'v1.3.3/task-draft-timezone', outcome: 'preserved' },
        });
    });

    it('keeps genuine edits equal to the new timezone projection and explicit date clears', () => {
        process.env.TZ = 'America/New_York';
        const task = { ...baseTask, startTime: '2026-10-04T14:00:00.000Z', dueDate: '2026-10-05T15:00:00.000Z', reviewAt: '2026-10-06T15:00:00.000Z' };
        let draft = createTaskDraft(task);
        process.env.TZ = 'America/Los_Angeles';
        draft = setTaskDraftField(draft, 'dueDate', '2026-10-05T08:00');
        draft = setTaskDraftField(draft, 'startTime', '');
        draft = setTaskDraftField(draft, 'reviewAt', '2026-10-06');
        expect(taskDraftToChangedUpdatePatch(JSON.parse(JSON.stringify(draft)), task)).toEqual({
            dueDate: '2026-10-05T08:00', startTime: undefined, reviewAt: '2026-10-06',
        });
        expect(isTaskDraftDirty(draft, task)).toBe(true);
    });

    it('does not recompute a linked DST schedule for an unrelated edit after a timezone change', () => {
        process.env.TZ = 'America/New_York';
        const task: Task = { ...baseTask, dueDate: '2026-11-01T15:00:00.000Z', startTime: '2026-10-31T14:00:00.000Z', relativeStartOffset: { amount: -1, unit: 'day' } };
        const draft = createTaskDraft(task);
        process.env.TZ = 'UTC';
        expect(taskDraftToChangedUpdatePatch(setTaskDraftField(draft, 'title', 'After'), task)).toEqual({ title: 'After' });
        expect(taskDraftToUpdatePatch(draft, task)).toMatchObject({
            dueDate: '2026-11-01T15:00:00.000Z', startTime: '2026-10-31T14:00:00.000Z', relativeStartOffset: { amount: -1, unit: 'day' },
        });
    });

    it('uses opening projections only for the same task and raw source, never as authoritative raw dates', () => {
        process.env.TZ = 'America/New_York';
        const task = { ...baseTask, dueDate: '2026-10-05T15:00:00.000Z' };
        const draft = createTaskDraft(task);
        process.env.TZ = 'America/Los_Angeles';
        const altered = JSON.parse(JSON.stringify(draft));
        altered.dateInputBaseline.dueDate.raw = '2099-01-01T00:00:00.000Z';
        expect(taskDraftToUpdatePatch(altered, task)?.dueDate).toBe('2026-10-05T11:00');
        expect(taskDraftToUpdatePatch(draft, { ...task, id: 'other' })?.dueDate).toBe('2026-10-05T11:00');
        const changedSource = { ...task, dueDate: '2026-10-05T16:00:00.000Z' };
        expect(taskDraftToUpdatePatch(draft, changedSource)?.dueDate).toBe('2026-10-05T11:00');
        expect(taskDraftToUpdatePatch({ ...draft, dateInputBaseline: undefined }, task)?.dueDate).toBe('2026-10-05T11:00');
    });

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

        // An active Waiting follow-up keeps the star.
        const toWaiting = setTaskDraftField(draft, 'status', 'waiting');
        expect(toWaiting.focusedToday).toBe(true);
    });

    it('drops a draft star on Done or Reference and refuses to star those statuses', () => {
        const starred = createTaskDraft({ ...baseTask, isFocusedToday: true });
        for (const status of ['done', 'reference', 'archived'] as const) {
            const changed = setTaskDraftField(starred, 'status', status);
            expect(changed.focusedToday).toBe(false);
            expect(setTaskDraftField(changed, 'focusedToday', true).focusedToday).toBe(false);
        }
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
        });
        expect(taskDraftToUpdatePatch(reopened, completed)).not.toHaveProperty('suppressMindwtrReminders');
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
        expect(taskDraftToUpdatePatch({ ...draft, title: '  Renamed  ', description: '  Notes\n ' }, baseTask))
            .toMatchObject({ title: 'Renamed', description: '  Notes\n ' });
        const paddedTitle = { ...baseTask, title: '  Original  ' };
        expect(taskDraftToUpdatePatch({ ...createTaskDraft(paddedTitle), title: '   ' }, paddedTitle))
            .toMatchObject({ title: '  Original  ' });

        const untitled: Task = { ...baseTask, title: '' };
        expect(taskDraftToUpdatePatch({ ...createTaskDraft(untitled), title: ' ' }, untitled)).toBeNull();
    });

    it('serializes only fields changed from the task-draft baseline', () => {
        const task: Task = {
            ...baseTask,
            dueDate: '2026-02-01',
            location: 'Office',
            priority: 'high',
        };
        const draft = setTaskDraftField(createTaskDraft(task), 'title', 'Write revised report');

        expect(taskDraftToChangedUpdatePatch(draft, task)).toEqual({
            title: 'Write revised report',
        });
    });

    it('keeps an explicit clear in a changed-only patch', () => {
        const task: Task = { ...baseTask, location: 'Office' };
        const draft = setTaskDraftField(createTaskDraft(task), 'location', '');
        const patch = taskDraftToChangedUpdatePatch(draft, task);

        expect(patch).toHaveProperty('location', undefined);
        expect(Object.keys(patch ?? {})).toEqual(['location']);
    });

    it('keeps explicit submit overrides while omitting unchanged draft fields', () => {
        const draft = createTaskDraft(baseTask);

        expect(taskDraftToChangedUpdatePatch(draft, baseTask, {
            statusOverride: 'done',
        })).toEqual({ status: 'done' });
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


describe('reminder policy draft roundtrip', () => {
    it.each(['inherit', 'send', 'skip'] as const)('preserves %s during an unrelated edit', (reminderPolicy) => {
        const task = { ...baseTask, reminderPolicy, repeatReminderMinutes: 15, suppressMindwtrReminders: true };
        const draft = createTaskDraft(task);
        expect(draft.reminderPolicy).toBe(reminderPolicy);
        expect(isTaskDraftDirty(draft, task)).toBe(false);
        const edited = setTaskDraftField(draft, 'title', 'Renamed');
        expect(taskDraftToChangedUpdatePatch(edited, task)).toEqual({ title: 'Renamed' });
        const patch = taskDraftToUpdatePatch(edited, task)!;
        expect(createTaskDraft({ ...task, ...patch }).reminderPolicy).toBe(reminderPolicy);
        expect(patch.repeatReminderMinutes).toBe(15);
        expect(patch).not.toHaveProperty('suppressMindwtrReminders');
    });

    it.each([undefined, false, true])('retains explicit legacy intent for %s', (suppressMindwtrReminders) => {
        const task = { ...baseTask, suppressMindwtrReminders };
        const draft = createTaskDraft(task);
        expect(draft.reminderPolicy).toBe(suppressMindwtrReminders ? 'skip' : 'send');
        const patch = taskDraftToChangedUpdatePatch(setTaskDraftField(draft, 'title', 'Renamed'), task);
        expect(patch).toEqual({ title: 'Renamed' });
    });

    it('writes an explicit policy from legacy controls and preserves repeat when skipping', () => {
        const task = { ...baseTask, reminderPolicy: 'inherit' as const, repeatReminderMinutes: 15 };
        expect(setTaskDraftField(createTaskDraft(task), 'suppressMindwtrReminders', false).reminderPolicy).toBe('send');
        const skipped = setTaskDraftField(createTaskDraft(task), 'suppressMindwtrReminders', true);
        expect(taskDraftToChangedUpdatePatch(skipped, task)).toEqual({ reminderPolicy: 'skip' });
        expect(skipped.repeatReminderMinutes).toBe(15);
        const sent = setTaskDraftField(skipped, 'suppressMindwtrReminders', false);
        expect(sent.reminderPolicy).toBe('send');
        const inherited = setTaskDraftField(sent, 'reminderPolicy', 'inherit');
        expect(inherited.reminderPolicy).toBe('inherit');
    });
});
