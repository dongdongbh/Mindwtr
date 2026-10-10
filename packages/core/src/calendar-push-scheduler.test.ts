import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCalendarPushScheduler } from './calendar-push-scheduler';

const flushPromises = () => vi.advanceTimersByTimeAsync(0);

describe('createCalendarPushScheduler', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('coalesces rapid changes into one debounced partial run', async () => {
        const runPartial = vi.fn(async () => undefined);
        const scheduler = createCalendarPushScheduler({
            debounceMs: 2500,
            runFull: async () => undefined,
            runPartial,
        });

        scheduler.scheduleDebounced(['a', 'b']);
        vi.advanceTimersByTime(2000);
        scheduler.scheduleDebounced(['b', 'c']);
        expect(runPartial).not.toHaveBeenCalled();

        vi.advanceTimersByTime(2000);
        expect(runPartial).not.toHaveBeenCalled();

        vi.advanceTimersByTime(500);
        await vi.runAllTimersAsync();

        expect(runPartial).toHaveBeenCalledTimes(1);
        expect(runPartial.mock.calls[0]?.[0]).toEqual(['a', 'b', 'c']);
    });

    it('starts a fresh batch after the debounce fires', async () => {
        const runPartial = vi.fn(async () => undefined);
        const scheduler = createCalendarPushScheduler({ debounceMs: 10, runFull: async () => undefined, runPartial });

        scheduler.scheduleDebounced(['a']);
        await vi.runAllTimersAsync();
        scheduler.scheduleDebounced(['b']);
        await vi.runAllTimersAsync();

        expect(runPartial.mock.calls.map((call) => call[0])).toEqual([['a'], ['b']]);
    });

    it('hands coalesced IDs to admission after 2500ms without waiting for the run queue or starting a partial run', async () => {
        const runPartial = vi.fn(async () => undefined);
        const onPartialDue = vi.fn();
        let releaseFull: (() => void) | undefined;
        const scheduler = createCalendarPushScheduler({
            runFull: () => new Promise<void>((resolve) => { releaseFull = resolve; }),
            runPartial,
            onPartialDue,
        });

        const full = scheduler.runFull();
        await flushPromises();
        scheduler.scheduleDebounced(['a', 'b']);
        vi.advanceTimersByTime(2000);
        scheduler.scheduleDebounced(['b', 'c']);
        vi.advanceTimersByTime(2499);
        expect(onPartialDue).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(onPartialDue.mock.calls).toEqual([[['a', 'b', 'c']]]);
        expect(runPartial).not.toHaveBeenCalled();

        releaseFull?.();
        await full;
        scheduler.scheduleDebounced(['d']);
        vi.advanceTimersByTime(2500);
        expect(onPartialDue.mock.calls).toEqual([[['a', 'b', 'c']], [['d']]]);
        expect(runPartial).not.toHaveBeenCalled();
    });

    it('snapshots admitted partial IDs and serializes them with full and arbitrary queued work', async () => {
        const order: string[] = [];
        let releaseFull: (() => void) | undefined;
        let releasePartial: (() => void) | undefined;
        let fullCount = 0;
        const runPartial = vi.fn(async (taskIds: string[]) => {
            order.push(`partial:${taskIds.join(',')}`);
            await new Promise<void>((resolve) => { releasePartial = resolve; });
            order.push('partial:end');
        });
        const scheduler = createCalendarPushScheduler({
            runFull: async () => {
                fullCount += 1;
                order.push(`full:${fullCount}`);
                if (fullCount === 1) await new Promise<void>((resolve) => { releaseFull = resolve; });
            },
            runPartial,
            onPartialDue: () => undefined,
        });

        const firstFull = scheduler.runFull();
        await flushPromises();
        const taskIds = ['a', 'b'];
        const partial = scheduler.runPartial(taskIds);
        taskIds.splice(0, taskIds.length, 'mutated');
        const arbitrary = scheduler.enqueue(async () => { order.push('arbitrary'); });
        const secondFull = scheduler.runFull();
        await flushPromises();
        expect(order).toEqual(['full:1']);

        releaseFull?.();
        await firstFull;
        await flushPromises();
        expect(order).toEqual(['full:1', 'partial:a,b']);
        expect(runPartial.mock.calls).toEqual([[['a', 'b']]]);

        releasePartial?.();
        await Promise.all([partial, arbitrary, secondFull]);
        expect(order).toEqual(['full:1', 'partial:a,b', 'partial:end', 'arbitrary', 'full:2']);
    });

    it('drops the pending batch when cancelled', async () => {
        const runPartial = vi.fn(async () => undefined);
        const scheduler = createCalendarPushScheduler({ debounceMs: 10, runFull: async () => undefined, runPartial });

        scheduler.scheduleDebounced(['a']);
        scheduler.cancelPending();
        await vi.runAllTimersAsync();

        expect(runPartial).not.toHaveBeenCalled();

        scheduler.scheduleDebounced(['b']);
        await vi.runAllTimersAsync();
        expect(runPartial.mock.calls.map((call) => call[0])).toEqual([['b']]);
    });

    it.each(['cancelPending', 'reset'] as const)('drops the pending admission handoff on %s', (cancel) => {
        const runPartial = vi.fn(async () => undefined);
        const onPartialDue = vi.fn();
        const scheduler = createCalendarPushScheduler({ runFull: async () => undefined, runPartial, onPartialDue });

        scheduler.scheduleDebounced(['cancelled']);
        scheduler[cancel]();
        vi.advanceTimersByTime(2500);
        expect(onPartialDue).not.toHaveBeenCalled();
        expect(runPartial).not.toHaveBeenCalled();

        scheduler.scheduleDebounced(['fresh']);
        vi.advanceTimersByTime(2500);
        expect(onPartialDue.mock.calls).toEqual([[['fresh']]]);
        expect(runPartial).not.toHaveBeenCalled();
    });

    it('serializes a full sync against a debounced partial sync', async () => {
        const order: string[] = [];
        let releaseFull: (() => void) | null = null;
        const scheduler = createCalendarPushScheduler({
            debounceMs: 10,
            runFull: async () => {
                order.push('full:start');
                await new Promise<void>((resolve) => {
                    releaseFull = resolve;
                });
                order.push('full:end');
            },
            runPartial: async () => {
                order.push('partial');
            },
        });

        void scheduler.runFull();
        await flushPromises();
        scheduler.scheduleDebounced(['a']);
        await vi.advanceTimersByTimeAsync(10);

        expect(order).toEqual(['full:start']);

        releaseFull?.();
        await flushPromises();

        expect(order).toEqual(['full:start', 'full:end', 'partial']);
    });

    it('keeps running queued work after a failed run', async () => {
        const runPartial = vi.fn(async () => undefined);
        const scheduler = createCalendarPushScheduler({
            debounceMs: 10,
            runFull: async () => {
                throw new Error('calendar unavailable');
            },
            runPartial,
        });

        await expect(scheduler.runFull()).rejects.toThrow('calendar unavailable');
        scheduler.scheduleDebounced(['a']);
        await vi.runAllTimersAsync();

        expect(runPartial).toHaveBeenCalledTimes(1);
    });
});
