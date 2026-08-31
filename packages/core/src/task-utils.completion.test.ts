import { describe, expect, it } from 'vitest';
import { getCompletionDateGroup, shouldAutoArchiveCompletedTask, sortTasksBy } from './task-utils';
import type { Task } from './types';

const task = (id: string, overrides: Partial<Task> = {}): Task => ({
    id,
    title: id,
    status: 'done',
    tags: [],
    contexts: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
});

describe('completed sort (#945)', () => {
    it('orders by completion newest first and puts never-completed tasks last', () => {
        const sorted = sortTasksBy([
            task('never'),
            task('older', { completedAt: '2026-03-01T09:00:00.000Z' }),
            task('newest', { completedAt: '2026-03-05T09:00:00.000Z' }),
            task('middle', { completedAt: '2026-03-03T09:00:00.000Z' }),
        ], 'completed');

        expect(sorted.map((item) => item.id)).toEqual(['newest', 'middle', 'older', 'never']);
    });

    it('does not fall back to updatedAt the way the Done default order does', () => {
        // sortDoneTasksForListView ranks these by updatedAt; the named sort must
        // not, or an archived task never completed sorts in among real completions.
        const sorted = sortTasksBy([
            task('archived-never', { updatedAt: '2026-09-09T00:00:00.000Z' }),
            task('completed', { completedAt: '2026-03-01T09:00:00.000Z' }),
        ], 'completed');

        expect(sorted.map((item) => item.id)).toEqual(['completed', 'archived-never']);
    });

    it('breaks ties on title so the order is stable', () => {
        const sorted = sortTasksBy([
            task('b', { completedAt: '2026-03-01T09:00:00.000Z' }),
            task('a', { completedAt: '2026-03-01T09:00:00.000Z' }),
        ], 'completed');

        expect(sorted.map((item) => item.id)).toEqual(['a', 'b']);
    });
});

describe('getCompletionDateGroup (#945)', () => {
    // Late enough in the day that a rolling 24h window would disagree with
    // calendar days for every case below.
    const now = new Date('2026-03-10T23:30:00');

    it('buckets on local calendar days, not rolling 24-hour windows', () => {
        expect(getCompletionDateGroup({ completedAt: '2026-03-10T00:05:00' }, now)).toBe('today');
        // 23h55m earlier, but the previous calendar day.
        expect(getCompletionDateGroup({ completedAt: '2026-03-09T23:35:00' }, now)).toBe('yesterday');
        expect(getCompletionDateGroup({ completedAt: '2026-03-08T12:00:00' }, now)).toBe('previous7Days');
        expect(getCompletionDateGroup({ completedAt: '2026-03-03T12:00:00' }, now)).toBe('previous7Days');
        expect(getCompletionDateGroup({ completedAt: '2026-03-02T12:00:00' }, now)).toBe('earlier');
    });

    it('treats a missing or unparseable completion as not completed', () => {
        expect(getCompletionDateGroup({}, now)).toBe('notCompleted');
        expect(getCompletionDateGroup({ completedAt: 'not a date' }, now)).toBe('notCompleted');
    });

    it('keeps a completion stamped slightly ahead of now in today', () => {
        expect(getCompletionDateGroup({ completedAt: '2026-03-11T00:10:00' }, now)).toBe('today');
    });
});

describe('sortTasksBy case coverage', () => {
    // Adding the 'completed' case initially deleted 'created-desc' outright, and
    // no core test noticed — a dropped case falls through to `default`, which
    // still returns a plausible order. Pinning the direction of each date sort
    // explicitly is the only thing that catches that; iterating the roster
    // cannot, because a missing case still produces sorted output.
    const tasks = [
        task('mid', { createdAt: '2026-02-02T00:00:00.000Z' }),
        task('newest', { createdAt: '2026-02-03T00:00:00.000Z' }),
        task('oldest', { createdAt: '2026-02-01T00:00:00.000Z' }),
    ];

    it('sorts created oldest first', () => {
        expect(sortTasksBy(tasks, 'created').map((item) => item.id)).toEqual(['oldest', 'mid', 'newest']);
    });

    it('sorts created-desc newest first', () => {
        expect(sortTasksBy(tasks, 'created-desc').map((item) => item.id)).toEqual(['newest', 'mid', 'oldest']);
    });

    // #1107: shortest estimate first, no estimate last, createdAt breaking ties.
    // Two unestimated tasks both rank +Infinity, so this also pins that the
    // comparator reaches the createdAt tie-break instead of returning NaN.
    it('sorts timeEstimate shortest first and leaves unestimated tasks last', () => {
        const estimated = [
            task('none-later', { createdAt: '2026-02-04T00:00:00.000Z' }),
            task('hour', { createdAt: '2026-02-02T00:00:00.000Z', timeEstimate: '1hr' }),
            task('none-earlier', { createdAt: '2026-02-03T00:00:00.000Z' }),
            task('quarter', { createdAt: '2026-02-01T00:00:00.000Z', timeEstimate: '15min' }),
        ];
        expect(sortTasksBy(estimated, 'timeEstimate').map((item) => item.id))
            .toEqual(['quarter', 'hour', 'none-earlier', 'none-later']);
    });

    it('breaks equal time estimates by createdAt ascending', () => {
        const sameEstimate = [
            task('second', { createdAt: '2026-02-02T00:00:00.000Z', timeEstimate: '30min' }),
            task('first', { createdAt: '2026-02-01T00:00:00.000Z', timeEstimate: '30min' }),
        ];
        expect(sortTasksBy(sameEstimate, 'timeEstimate').map((item) => item.id)).toEqual(['first', 'second']);
    });
});

describe('shouldAutoArchiveCompletedTask (#959)', () => {
    const settings = { gtd: { autoArchiveDays: 7 } } as never;
    const nowMs = new Date('2026-07-29T12:00:00.000Z').getTime();
    const task = (overrides: Record<string, unknown>) => ({
        status: 'done',
        completedAt: '2026-07-29T09:00:00.000Z',
        updatedAt: '2026-07-29T09:00:00.000Z',
        ...overrides,
    } as never);

    it('files a completion older than the window', () => {
        expect(shouldAutoArchiveCompletedTask(task({ completedAt: '2025-06-01T00:00:00.000Z' }), settings, nowMs)).toBe(true);
    });

    it('leaves a recent completion, a live task and a deleted one alone', () => {
        expect(shouldAutoArchiveCompletedTask(task({}), settings, nowMs)).toBe(false);
        expect(shouldAutoArchiveCompletedTask(task({ status: 'next', completedAt: '2025-01-01T00:00:00.000Z' }), settings, nowMs)).toBe(false);
        expect(shouldAutoArchiveCompletedTask(task({ completedAt: '2025-01-01T00:00:00.000Z', deletedAt: '2026-07-01T00:00:00.000Z' }), settings, nowMs)).toBe(false);
    });

    it('never fires when auto-archiving is switched off', () => {
        expect(shouldAutoArchiveCompletedTask(
            task({ completedAt: '2020-01-01T00:00:00.000Z' }),
            { gtd: { autoArchiveDays: 0 } } as never,
            nowMs,
        )).toBe(false);
    });

    it('falls back to updatedAt for rows completed before completedAt existed', () => {
        expect(shouldAutoArchiveCompletedTask(
            task({ completedAt: undefined, updatedAt: '2025-06-01T00:00:00.000Z' }),
            settings,
            nowMs,
        )).toBe(true);
    });
});
