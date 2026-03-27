import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopAutoSyncController } from './auto-sync-controller';

const createManualScheduler = (startMs = 0) => {
    let nowMs = startMs;
    let nextId = 1;
    const timers = new Map<number, { runAt: number; callback: () => void }>();

    const setTimer = ((callback: TimerHandler, delay?: number) => {
        const id = nextId;
        nextId += 1;
        timers.set(id, {
            runAt: nowMs + Math.max(0, Number(delay ?? 0)),
            callback: () => {
                if (typeof callback === 'function') {
                    callback();
                }
            },
        });
        return id as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    const clearTimer = ((timerId: ReturnType<typeof setTimeout>) => {
        timers.delete(Number(timerId));
    }) as unknown as typeof clearTimeout;

    const advanceBy = async (ms: number) => {
        nowMs += ms;
        while (true) {
            const nextTimer = Array.from(timers.entries())
                .filter(([, timer]) => timer.runAt <= nowMs)
                .sort((left, right) => left[1].runAt - right[1].runAt || left[0] - right[0])[0];
            if (!nextTimer) break;
            timers.delete(nextTimer[0]);
            nextTimer[1].callback();
            await Promise.resolve();
            await Promise.resolve();
        }
    };

    return {
        now: () => nowMs,
        setNow: (next: number) => {
            nowMs = next;
        },
        setTimer,
        clearTimer,
        advanceBy,
    };
};

const waitForAssertion = async (assertion: () => void, maxAttempts = 200): Promise<void> => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
            assertion();
            return;
        } catch (error) {
            lastError = error;
            await Promise.resolve();
        }
    }
    throw lastError ?? new Error('Timed out waiting for expectation');
};

describe('createDesktopAutoSyncController', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('queues a follow-up sync while the current cycle is still running', async () => {
        const performSync = vi.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 25));
            return { success: true };
        });
        const controller = createDesktopAutoSyncController({
            canSync: async () => true,
            performSync,
            flushPendingSave: async () => undefined,
            reportError: vi.fn(),
            isRuntimeActive: () => true,
            minIntervalMs: 0,
        });

        const first = controller.requestSync();
        const second = controller.requestSync();

        await Promise.all([first, second]);
        await new Promise((resolve) => setTimeout(resolve, 40));

        expect(performSync).toHaveBeenCalledTimes(2);
    });

    it('throttles repeated sync requests until the minimum interval elapses', async () => {
        const scheduler = createManualScheduler(10_000);

        const performSync = vi.fn(async () => ({ success: true }));
        const controller = createDesktopAutoSyncController({
            canSync: async () => true,
            performSync,
            flushPendingSave: async () => undefined,
            reportError: vi.fn(),
            isRuntimeActive: () => true,
            now: scheduler.now,
            setTimer: scheduler.setTimer,
            clearTimer: scheduler.clearTimer,
        });

        await controller.requestSync();
        expect(performSync).toHaveBeenCalledTimes(1);

        scheduler.setNow(11_000);
        await controller.requestSync();
        expect(performSync).toHaveBeenCalledTimes(1);

        await scheduler.advanceBy(4_000);

        await waitForAssertion(() => {
            expect(performSync).toHaveBeenCalledTimes(2);
        });
    });

    it('debounces repeated data changes before syncing', async () => {
        const scheduler = createManualScheduler();

        const performSync = vi.fn(async () => ({ success: true }));
        const controller = createDesktopAutoSyncController({
            canSync: async () => true,
            performSync,
            flushPendingSave: async () => undefined,
            reportError: vi.fn(),
            isRuntimeActive: () => true,
            setTimer: scheduler.setTimer,
            clearTimer: scheduler.clearTimer,
        });

        controller.handleDataChange();
        await scheduler.advanceBy(1_999);
        expect(performSync).not.toHaveBeenCalled();

        controller.handleDataChange();
        await scheduler.advanceBy(4_999);
        expect(performSync).not.toHaveBeenCalled();

        await scheduler.advanceBy(1);
        await waitForAssertion(() => {
            expect(performSync).toHaveBeenCalledTimes(1);
        });
    });

    it('pauses focus and blur syncs while edits are active without blocking save-driven sync', async () => {
        const scheduler = createManualScheduler(50_000);
        let pauseWindowSync = true;

        const performSync = vi.fn(async () => ({ success: true }));
        const controller = createDesktopAutoSyncController({
            canSync: async () => true,
            performSync,
            flushPendingSave: async () => undefined,
            reportError: vi.fn(),
            isRuntimeActive: () => true,
            shouldPauseWindowSync: () => pauseWindowSync,
            now: scheduler.now,
            setTimer: scheduler.setTimer,
            clearTimer: scheduler.clearTimer,
            minIntervalMs: 0,
        });

        controller.handleBlur();
        controller.handleFocus();
        await Promise.resolve();

        expect(performSync).not.toHaveBeenCalled();

        controller.handleDataChange();
        await scheduler.advanceBy(2_000);
        await waitForAssertion(() => {
            expect(performSync).toHaveBeenCalledTimes(1);
        });

        pauseWindowSync = false;
        controller.handleBlur();
        await waitForAssertion(() => {
            expect(performSync).toHaveBeenCalledTimes(2);
        });
    });
});
