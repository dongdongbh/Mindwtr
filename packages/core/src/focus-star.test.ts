import { describe, expect, it } from 'vitest';
import type { Task } from './types';
import { createTaskDraft, setTaskDraftField } from './task-draft';
import {
    canStarNewCapture,
    getFocusStarBlockedText,
    resolveFocusStarAction,
    resolveRowFocusStarAction,
    resolveTaskEditorFocusStar,
    resolveTaskFocusCreation,
    resolveTaskFocusUpdate,
    type FocusStarContext,
} from './focus-star';

const makeTask = (overrides: Partial<Task>): Task => ({
    id: 'task-1',
    title: 'Task',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
});

const baseContext = (overrides: Partial<FocusStarContext> = {}): FocusStarContext => ({
    tasks: [],
    projects: [],
    sections: [],
    focusedCount: 0,
    focusTaskLimit: 3,
    ...overrides,
});

describe('resolveFocusStarAction', () => {
    it('allows starring an eligible next task under the cap', () => {
        const action = resolveFocusStarAction(makeTask({}), baseContext());
        expect(action).toMatchObject({
            isFocused: false,
            canToggle: true,
            blockedReason: null,
            labelKey: 'agenda.addToFocus',
            patch: { isFocusedToday: true },
        });
    });

    it('always allows removing a star, even over the cap', () => {
        const action = resolveFocusStarAction(
            makeTask({ isFocusedToday: true }),
            baseContext({ focusedCount: 5, focusTaskLimit: 3 }),
        );
        expect(action).toMatchObject({
            canToggle: true,
            blockedReason: null,
            labelKey: 'agenda.removeFromFocus',
            patch: { isFocusedToday: false },
        });
    });

    it('blocks unclarified tasks unless the surface allows them', () => {
        const inboxTask = makeTask({ status: 'inbox' });
        expect(resolveFocusStarAction(inboxTask, baseContext()).blockedReason).toBe('clarify');
        expect(
            resolveFocusStarAction(inboxTask, baseContext({ allowUnclarified: true })).canToggle,
        ).toBe(true);
    });

    it('blocks at the focus cap', () => {
        const action = resolveFocusStarAction(makeTask({}), baseContext({ focusedCount: 3 }));
        expect(action).toMatchObject({ canToggle: false, blockedReason: 'limit' });
    });

    it('queues future-start next actions without using a current Focus slot', () => {
        const deferred = makeTask({ startTime: '2099-01-01T00:00:00.000Z' });
        const action = resolveFocusStarAction(deferred, baseContext({ focusedCount: 3 }));
        expect(action).toMatchObject({ canToggle: true, blockedReason: null });
        const recurring = makeTask({ recurrence: { rule: 'daily' }, dueDate: '2099-01-01' });
        expect(resolveFocusStarAction(recurring, baseContext()).blockedReason).toBe('deferred');
    });
});

describe('resolveRowFocusStarAction', () => {
    it('stars an Inbox task as Next, with status next in the same patch (#1464)', () => {
        const action = resolveRowFocusStarAction(makeTask({ status: 'inbox' }), baseContext());
        expect(action).toMatchObject({ canToggle: true, blockedReason: null, patch: { isFocusedToday: true, status: 'next' } });
    });

    it('refuses an Inbox task the Next rules refuse', () => {
        // The plain resolver refuses every Inbox task; the row judges it as Next instead.
        expect(resolveFocusStarAction(makeTask({ status: 'inbox' }), baseContext()).blockedReason).toBe('clarify');
        const refused = resolveRowFocusStarAction(makeTask({ status: 'inbox' }), baseContext({ focusedCount: 3 }));
        expect(refused).toMatchObject({ canToggle: false, blockedReason: 'limit' });
        // A refused star carries no status: nothing in its patch may move the task out of Inbox.
        expect(refused.patch).toEqual({ isFocusedToday: true });
    });

    it('leaves other statuses and star removal to resolveFocusStarAction', () => {
        for (const task of [makeTask({ status: 'waiting' }), makeTask({ status: 'someday' }), makeTask({ status: 'inbox', isFocusedToday: true })]) {
            expect(resolveRowFocusStarAction(task, baseContext())).toEqual(resolveFocusStarAction(task, baseContext()));
        }
    });
});

describe('resolveTaskEditorFocusStar', () => {
    const now = new Date('2026-09-28T12:00:00.000Z');
    it('uses draft status and start date, and keeps queued stars outside the current cap', () => {
        const task = makeTask({ status: 'inbox' });
        const draft = setTaskDraftField(createTaskDraft(task), 'startTime', '2026-10-04');
        const action = resolveTaskEditorFocusStar(task, draft, baseContext({ now, focusedCount: 3, tasks: [task] }));
        expect(action).toMatchObject({ canToggle: true, queued: true, blockedReason: null });
        expect(resolveTaskEditorFocusStar(task, setTaskDraftField(draft, 'status', 'waiting'),
            baseContext({ now, focusedCount: 3, tasks: [task] })).blockedReason).toBe('deferred');
        expect(resolveTaskEditorFocusStar(task, setTaskDraftField(draft, 'startTime', ''),
            baseContext({ now, focusedCount: 3, tasks: [task] })).blockedReason).toBe('limit');
    });

    it('preserves the incumbent Focus slot while toggling a saved star in the draft', () => {
        const task = makeTask({ isFocusedToday: true });
        const draft = setTaskDraftField(createTaskDraft(task), 'focusedToday', false);
        expect(resolveTaskEditorFocusStar(task, draft, baseContext({ tasks: [task], focusedCount: 3 })))
            .toMatchObject({ canToggle: true, blockedReason: null });
        expect(resolveTaskEditorFocusStar(task, createTaskDraft(task), baseContext({ tasks: [task], focusedCount: 3 })))
            .toMatchObject({ isFocused: true, canToggle: true });
    });

    it('does not treat a due date alone as a queued Focus request', () => {
        const task = makeTask({});
        const draft = setTaskDraftField(createTaskDraft(task), 'dueDate', '2026-10-04');
        expect(resolveTaskEditorFocusStar(task, draft, baseContext({ now, focusedCount: 3, tasks: [task] })))
            .toMatchObject({ queued: false, blockedReason: 'limit' });
    });

    it('evaluates future due and review dates against the draft recurrence', () => {
        for (const field of ['dueDate', 'reviewAt'] as const) {
            const recurring = makeTask({ [field]: '2026-10-04', recurrence: { rule: 'daily' } });
            const removed = setTaskDraftField(createTaskDraft(recurring), 'recurrence', '');
            expect(resolveTaskEditorFocusStar(recurring, removed, baseContext({ now, tasks: [recurring] })))
                .toMatchObject({ canToggle: true, blockedReason: null });

            const oneOff = makeTask({ [field]: '2026-10-04' });
            const added = setTaskDraftField(createTaskDraft(oneOff), 'recurrence', 'daily');
            expect(resolveTaskEditorFocusStar(oneOff, added, baseContext({ now, tasks: [oneOff] })))
                .toMatchObject({ canToggle: false, blockedReason: 'deferred' });
        }
    });

    it('blocks Done, Reference and deleted drafts while allowing Inbox clarification', () => {
        const inbox = makeTask({ status: 'inbox' });
        expect(resolveTaskEditorFocusStar(inbox, createTaskDraft(inbox), baseContext({ tasks: [inbox] })))
            .toMatchObject({ canToggle: true });
        for (const status of ['done', 'reference'] as const) {
            const task = makeTask({ status, reviewAt: '2020-01-01' });
            expect(resolveTaskEditorFocusStar(task, createTaskDraft(task), baseContext({ tasks: [task] })))
                .toMatchObject({ canToggle: false, blockedReason: 'clarify' });
            const oldStar = { ...task, isFocusedToday: true };
            expect(resolveTaskEditorFocusStar(oldStar, createTaskDraft(oldStar), baseContext({ tasks: [oldStar] })))
                .toMatchObject({ isFocused: true, canToggle: true, blockedReason: null });
        }
        const deleted = makeTask({ deletedAt: '2026-01-02T00:00:00.000Z' });
        expect(resolveTaskEditorFocusStar(deleted, createTaskDraft(deleted), baseContext()))
            .toMatchObject({ canToggle: false });
    });
});

describe('getFocusStarBlockedText', () => {
    const passthrough = (key: string) => key;

    it('interpolates the focus limit into the cap message', () => {
        const text = getFocusStarBlockedText(
            () => 'Max {{count}} focus items.',
            { blockedReason: 'limit' },
            5,
        );
        expect(text).toBe('Max 5 focus items.');
    });

    it('falls back to English per reason and returns null when unblocked', () => {
        expect(getFocusStarBlockedText(passthrough, { blockedReason: 'clarify' }, 3))
            .toBe('Clarify this task before adding it to Focus.');
        expect(getFocusStarBlockedText((key) => (key === 'agenda.focusUnavailableSequential' ? 'Übersetzt' : key), { blockedReason: 'sequential' }, 3))
            .toBe('Übersetzt');
        expect(getFocusStarBlockedText(passthrough, { blockedReason: null }, 3)).toBeNull();
    });
});

describe('canStarNewCapture', () => {
    it('gates only on the cap', () => {
        expect(canStarNewCapture({ focusedCount: 2, focusTaskLimit: 3 })).toBe(true);
        expect(canStarNewCapture({ focusedCount: 3, focusTaskLimit: 3 })).toBe(false);
    });
});

describe('resolveTaskFocusCreation', () => {
    it('promotes an eligible starred Inbox capture only when the star lands', () => {
        const decision = resolveTaskFocusCreation(
            makeTask({ status: 'inbox', isFocusedToday: true }),
            baseContext(),
        );

        expect(decision).toEqual({
            status: 'next',
            isFocusedToday: true,
            outcome: 'focused',
        });
    });

    it('refuses a full-cap star without changing the requested status', () => {
        const context = baseContext({ focusedCount: 3, focusTaskLimit: 3 });

        expect(resolveTaskFocusCreation(
            makeTask({ status: 'inbox', isFocusedToday: true }),
            context,
        )).toEqual({
            status: 'inbox',
            isFocusedToday: false,
            outcome: 'refused-limit',
        });
        expect(resolveTaskFocusCreation(
            makeTask({ status: 'next', isFocusedToday: true }),
            context,
        )).toEqual({
            status: 'next',
            isFocusedToday: false,
            outcome: 'refused-limit',
        });
    });

    it('queues a future-start star and preserves eligible review-due statuses', () => {
        expect(resolveTaskFocusCreation(
            makeTask({ status: 'next', isFocusedToday: true, startTime: '2099-01-01' }),
            baseContext({ focusedCount: 3 }),
        )).toEqual({
            status: 'next',
            isFocusedToday: true,
            outcome: 'focused',
        });

        for (const status of ['waiting', 'someday'] as const) {
            expect(resolveTaskFocusCreation(
                makeTask({ status, isFocusedToday: true, reviewAt: '2020-01-01' }),
                baseContext(),
            )).toEqual({
                status,
                isFocusedToday: true,
                outcome: 'focused',
            });
        }
    });
});

describe('resolveTaskFocusUpdate', () => {
    const now = new Date();
    const update = (before: Partial<Task>, after: Partial<Task>, focusedCount: number, focusTaskLimit = 3) =>
        resolveTaskFocusUpdate(makeTask(before), makeTask({ ...before, ...after }), { focusedCount, focusTaskLimit, now });

    it('admits a new star below the cap and refuses it at the configured cap', () => {
        expect(update({}, { isFocusedToday: true }, 2)).toEqual({ outcome: 'focused' });
        expect(update({}, { isFocusedToday: true }, 3)).toEqual({ outcome: 'refused-limit', message: 'Focus limit of 3 reached' });
        expect(update({}, { isFocusedToday: true }, 5, 5)).toEqual({ outcome: 'refused-limit', message: 'Focus limit of 5 reached' });
        expect(update({ status: 'inbox' }, { status: 'next', isFocusedToday: true }, 0, 1)).toEqual({ outcome: 'focused' });
    });

    it('leaves existing stars, removed stars, and uncounted statuses alone at the cap', () => {
        expect(update({ isFocusedToday: true }, { title: 'Edited' }, 3)).toEqual({ outcome: 'unchanged' });
        expect(update({ isFocusedToday: true }, { isFocusedToday: false }, 3)).toEqual({ outcome: 'unchanged' });
        for (const status of ['done', 'reference', 'archived'] as const) {
            expect(update({ status }, { isFocusedToday: true }, 3)).toEqual({ outcome: 'unchanged' });
        }
        expect(update({ deletedAt: '2026-01-01T00:00:00.000Z' }, { isFocusedToday: true }, 3)).toEqual({ outcome: 'unchanged' });
    });

    it('queues a later-day star and takes a slot when a queued star becomes current', () => {
        expect(update({ startTime: '2099-01-01' }, { isFocusedToday: true }, 3)).toEqual({ outcome: 'queued' });
        expect(update({ startTime: '2099-01-01', isFocusedToday: true }, { startTime: undefined }, 1, 1))
            .toEqual({ outcome: 'refused-limit', message: 'Focus limit of 1 reached' });
        expect(update({ startTime: '2099-01-01', isFocusedToday: true }, { startTime: undefined }, 0, 1))
            .toEqual({ outcome: 'focused' });
    });

    it('counts a review-due waiting star like any other star', () => {
        expect(update({ status: 'waiting', reviewAt: '2020-01-01' }, { isFocusedToday: true }, 2)).toEqual({ outcome: 'focused' });
        expect(update({ status: 'waiting', reviewAt: '2020-01-01' }, { isFocusedToday: true }, 3).outcome).toBe('refused-limit');
    });
});
