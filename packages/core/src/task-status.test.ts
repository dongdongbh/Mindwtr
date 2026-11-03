import { describe, expect, it } from 'vitest';
import {
    isTaskActionable,
    isTaskCancelled,
    isTaskCompleted,
    isTaskFinished,
    normalizeCancellationTimestamp,
    normalizeTaskForLoad,
    TASK_STATUS_VALUES,
} from './task-status';
import type { Task, TaskStatus } from './types';

const NOW_ISO = '2026-07-16T12:00:00.000Z';

const createTask = (overrides: Partial<Task> = {}): Task => ({
    id: 't1',
    title: 'Task',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    rev: 1,
    revBy: 'device-a',
    ...overrides,
});

describe('normalizeTaskForLoad focusOrder invariant', () => {
    it('clears focusOrder when a loaded task is done', () => {
        const task = createTask({
            status: 'done',
            isFocusedToday: true,
            focusOrder: 2,
        });

        const normalized = normalizeTaskForLoad(task, NOW_ISO);

        expect(normalized.isFocusedToday).toBe(false);
        expect(normalized.focusOrder).toBeUndefined();
    });

    it('clears focusOrder when a loaded task is archived', () => {
        const task = createTask({
            status: 'archived',
            isFocusedToday: true,
            focusOrder: 1,
        });

        const normalized = normalizeTaskForLoad(task, NOW_ISO);

        expect(normalized.isFocusedToday).toBe(false);
        expect(normalized.focusOrder).toBeUndefined();
    });

    it('keeps a queued star but clears focusOrder until its future start', () => {
        const task = createTask({
            status: 'next',
            isFocusedToday: true,
            focusOrder: 4,
            startTime: '2099-01-01',
        });

        const normalized = normalizeTaskForLoad(task, NOW_ISO);

        expect(normalized.isFocusedToday).toBe(true);
        expect(normalized.focusOrder).toBeUndefined();
    });

    it('does not touch focusOrder for a live, non-deferred focused task', () => {
        const task = createTask({
            status: 'next',
            isFocusedToday: true,
            focusOrder: 0,
        });

        const normalized = normalizeTaskForLoad(task, NOW_ISO);

        expect(normalized.isFocusedToday).toBe(true);
        expect(normalized.focusOrder).toBe(0);
    });

    it('is idempotent for done tasks', () => {
        const task = createTask({
            status: 'done',
            isFocusedToday: true,
            focusOrder: 2,
        });

        const once = normalizeTaskForLoad(task, NOW_ISO);
        const twice = normalizeTaskForLoad(once, NOW_ISO);

        expect(twice).toEqual(once);
    });

    it('is idempotent for future-start deferred tasks', () => {
        const task = createTask({
            status: 'next',
            isFocusedToday: true,
            focusOrder: 4,
            startTime: '2099-01-01',
        });

        const once = normalizeTaskForLoad(task, NOW_ISO);
        const twice = normalizeTaskForLoad(once, NOW_ISO);

        expect(twice).toEqual(once);
    });

    it('keeps cancellation terminal without manufacturing a completion timestamp', () => {
        const task = createTask({
            status: 'archived',
            cancelledAt: '2026-07-01T08:30:00+02:00',
            completedAt: '2026-07-01T09:00:00.000Z',
            isFocusedToday: true,
            focusOrder: 2,
        });

        const once = normalizeTaskForLoad(task, NOW_ISO);
        const twice = normalizeTaskForLoad(once, '2099-01-01T00:00:00.000Z');

        expect(once).toMatchObject({
            status: 'archived',
            cancelledAt: '2026-07-01T08:30:00+02:00',
            isFocusedToday: false,
        });
        expect(once.completedAt).toBeUndefined();
        expect(once.focusOrder).toBeUndefined();
        expect(twice).toBe(once);
    });

    it('clears stale cancellation markers from completed and active tasks', () => {
        expect(normalizeTaskForLoad(createTask({
            status: 'done',
            cancelledAt: '2026-07-01T08:30:00.000Z',
        }), NOW_ISO).cancelledAt).toBeUndefined();
        expect(normalizeTaskForLoad(createTask({
            status: 'next',
            cancelledAt: '2026-07-01T08:30:00.000Z',
        }), NOW_ISO).cancelledAt).toBeUndefined();
    });
});

describe('cancellation timestamp validation', () => {
    it('accepts ISO datetimes with an explicit timezone', () => {
        expect(normalizeCancellationTimestamp('2026-07-01T08:30:00.000Z'))
            .toBe('2026-07-01T08:30:00.000Z');
        expect(normalizeCancellationTimestamp('2026-07-01T08:30:00+02:00'))
            .toBe('2026-07-01T08:30:00+02:00');
    });

    it.each([
        '2026-07-01',
        '2026-07-01T08:30:00',
        '2026-02-30T08:30:00.000Z',
        '2026-07-01T24:00:00.000Z',
        'not-a-date',
    ])('rejects non-instant cancellation timestamp %s', (value) => {
        expect(normalizeCancellationTimestamp(value)).toBeUndefined();
    });
});


const oldIsFinished = (status: TaskStatus) => status === 'done' || status === 'archived';
const oldIsActionable = (status: TaskStatus) => status !== 'done' && status !== 'archived' && status !== 'reference';

describe('isTaskFinished / isTaskActionable pin the old hand-written predicates', () => {
    it.each(TASK_STATUS_VALUES)('isTaskFinished(%s) matches the old done||archived check', (status) => {
        expect(isTaskFinished(status)).toBe(oldIsFinished(status));
    });

    it.each(TASK_STATUS_VALUES)('isTaskActionable(%s) matches the old !done && !archived && !reference check', (status) => {
        expect(isTaskActionable(status)).toBe(oldIsActionable(status));
    });

    it('accepts a task-like object as well as a bare status', () => {
        expect(isTaskFinished({ status: 'archived' } as Pick<Task, 'status'>)).toBe(true);
        expect(isTaskActionable({ status: 'archived' } as Pick<Task, 'status'>)).toBe(false);
        expect(isTaskFinished(undefined)).toBe(false);
        expect(isTaskActionable(undefined)).toBe(true);
    });

    it('distinguishes cancelled terminal work from completed work', () => {
        const cancelled = createTask({
            status: 'archived',
            cancelledAt: '2026-07-01T08:30:00.000Z',
        });
        const historicalArchive = createTask({ status: 'archived' });

        expect(isTaskFinished(cancelled)).toBe(true);
        expect(isTaskCancelled(cancelled)).toBe(true);
        expect(isTaskCompleted(cancelled)).toBe(false);
        expect(isTaskCompleted(historicalArchive)).toBe(true);
        expect(isTaskCompleted(createTask({ status: 'done' }))).toBe(true);
    });
});
