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
        getTimerCount: () => timers.size,
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
            periodicSyncIntervalMs: null,
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
            periodicSyncIntervalMs: null,
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
            periodicSyncIntervalMs: null,
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

    it('backs off automatic retries after a failed sync without blocking manual sync', async () => {
        const scheduler = createManualScheduler();
        const logInfo = vi.fn();

        const performSync = vi.fn(async () => ({
            success: false,
            error: 'WebDAV error: 503 Service Unavailable',
        }));
        const controller = createDesktopAutoSyncController({
            canSync: async () => true,
            performSync,
            flushPendingSave: async () => undefined,
            reportError: vi.fn(),
            isRuntimeActive: () => true,
            now: scheduler.now,
            setTimer: scheduler.setTimer,
            clearTimer: scheduler.clearTimer,
            minIntervalMs: 0,
            autoFailureCooldownMs: 60_000,
            periodicSyncIntervalMs: null,
            logInfo,
        });

        controller.handleDataChange();
        await scheduler.advanceBy(2_000);
        await waitForAssertion(() => {
            expect(performSync).toHaveBeenCalledTimes(1);
        });

        controller.handleDataChange();
        await scheduler.advanceBy(2_000);
        await Promise.resolve();

        expect(performSync).toHaveBeenCalledTimes(1);
        expect(logInfo).toHaveBeenCalledWith(
            'Auto sync skipped during failure cooldown',
            expect.objectContaining({ source: 'data-change' })
        );

        await controller.requestSync(0);

        expect(performSync).toHaveBeenCalledTimes(2);
    });

    it('waits exactly as long as CloudKit asked before retrying (#948)', async () => {
        const scheduler = createManualScheduler();
        // CloudKit answers a throttle with the delay it wants. Retrying on the
        // fixed 60s cooldown either hammers a limit that wanted longer, or sits
        // idle when it only wanted a few seconds.
        const performSync = vi.fn(async () => ({
            success: false,
            error: 'CloudKit error: Request Rate Limited [retryAfter=180]',
        }));
        const controller = createDesktopAutoSyncController({
            canSync: async () => true,
            performSync,
            flushPendingSave: async () => undefined,
            reportError: vi.fn(),
            isRuntimeActive: () => true,
            now: scheduler.now,
            setTimer: scheduler.setTimer,
            clearTimer: scheduler.clearTimer,
            minIntervalMs: 0,
            autoFailureCooldownMs: 60_000,
            periodicSyncIntervalMs: null,
        });

        controller.handleDataChange();
        await scheduler.advanceBy(2_000);
        await waitForAssertion(() => {
            expect(performSync).toHaveBeenCalledTimes(1);
        });

        // The failed cycle itself arms the retry; no later edit or lifecycle
        // event is required.
        await scheduler.advanceBy(179_999);
        expect(performSync).toHaveBeenCalledTimes(1);

        await scheduler.advanceBy(1);
        await waitForAssertion(() => {
            expect(performSync).toHaveBeenCalledTimes(2);
        });

        controller.dispose();
    });

    it('rearms the automatic retry when consecutive failures grow the cooldown (#948)', async () => {
        const scheduler = createManualScheduler();
        const performSync = vi.fn(async () => ({
            success: false,
            error: 'CloudKit error: Request Rate Limited [retryAfter=10]',
        }));
        const controller = createDesktopAutoSyncController({
            canSync: async () => true,
            performSync,
            flushPendingSave: async () => undefined,
            reportError: vi.fn(),
            isRuntimeActive: () => true,
            now: scheduler.now,
            setTimer: scheduler.setTimer,
            clearTimer: scheduler.clearTimer,
            minIntervalMs: 0,
            periodicSyncIntervalMs: 0,
        });

        controller.handleDataChange();
        await scheduler.advanceBy(2_000);
        await waitForAssertion(() => {
            expect(performSync).toHaveBeenCalledTimes(1);
        });

        await scheduler.advanceBy(10_000);
        await waitForAssertion(() => {
            expect(performSync).toHaveBeenCalledTimes(2);
        });

        // The second failure doubles the requested 10s delay to 20s.
        await scheduler.advanceBy(19_999);
        expect(performSync).toHaveBeenCalledTimes(2);

        await scheduler.advanceBy(1);
        await waitForAssertion(() => {
            expect(performSync).toHaveBeenCalledTimes(3);
        });

        controller.dispose();
    });

    it('cancels a pending automatic retry after a successful manual recovery (#948)', async () => {
        const scheduler = createManualScheduler();
        const performSync = vi.fn()
            .mockResolvedValueOnce({
                success: false,
                error: 'CloudKit error: Request Rate Limited [retryAfter=180]',
            })
            .mockResolvedValue({ success: true });
        const controller = createDesktopAutoSyncController({
            canSync: async () => true,
            performSync,
            flushPendingSave: async () => undefined,
            reportError: vi.fn(),
            isRuntimeActive: () => true,
            now: scheduler.now,
            setTimer: scheduler.setTimer,
            clearTimer: scheduler.clearTimer,
            minIntervalMs: 0,
            periodicSyncIntervalMs: 0,
        });

        controller.handleDataChange();
        await scheduler.advanceBy(2_000);
        await waitForAssertion(() => {
            expect(performSync).toHaveBeenCalledTimes(1);
        });
        expect(scheduler.getTimerCount()).toBe(1);

        await controller.requestSync(0);

        await waitForAssertion(() => {
            expect(performSync).toHaveBeenCalledTimes(2);
        });
        expect(scheduler.getTimerCount()).toBe(0);

        await scheduler.advanceBy(180_000);
        expect(performSync).toHaveBeenCalledTimes(2);
    });

    it('delays a queued auto follow-up when the in-flight sync enters failure cooldown', async () => {
        const scheduler = createManualScheduler();
        const logInfo = vi.fn();
        let finishSync: (result: { success: boolean; error?: string }) => void = () => undefined;
        const performSync = vi.fn(() => new Promise<{ success: boolean; error?: string }>((resolve) => {
            finishSync = resolve;
        }));
        const controller = createDesktopAutoSyncController({
            canSync: async () => true,
            performSync,
            flushPendingSave: async () => undefined,
            reportError: vi.fn(),
            isRuntimeActive: () => true,
            now: scheduler.now,
            setTimer: scheduler.setTimer,
            clearTimer: scheduler.clearTimer,
            minIntervalMs: 0,
            autoFailureCooldownMs: 60_000,
            periodicSyncIntervalMs: null,
            logInfo,
        });

        controller.handleDataChange();
        await scheduler.advanceBy(2_000);
        await waitForAssertion(() => {
            expect(performSync).toHaveBeenCalledTimes(1);
        });

        controller.handleBlur();
        finishSync({ success: false, error: 'WebDAV error: 503 Service Unavailable' });
        await Promise.resolve();
        await Promise.resolve();

        expect(performSync).toHaveBeenCalledTimes(1);
        await waitForAssertion(() => {
            expect(logInfo).toHaveBeenCalledWith(
                'Auto sync skipped during failure cooldown',
                expect.objectContaining({ source: 'blur' })
            );
        });

        await scheduler.advanceBy(59_999);
        expect(performSync).toHaveBeenCalledTimes(1);

        await scheduler.advanceBy(1);
        await waitForAssertion(() => {
            expect(performSync).toHaveBeenCalledTimes(2);
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
            periodicSyncIntervalMs: null,
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

    it('keeps focus sync for remote pulls but skips blur sync when there are no pending local changes', async () => {
        const scheduler = createManualScheduler(50_000);
        let pendingLocalChanges = false;

        const performSync = vi.fn(async () => ({ success: true }));
        const controller = createDesktopAutoSyncController({
            canSync: async () => true,
            performSync,
            flushPendingSave: async () => undefined,
            reportError: vi.fn(),
            isRuntimeActive: () => true,
            hasPendingLocalChanges: () => pendingLocalChanges,
            now: scheduler.now,
            setTimer: scheduler.setTimer,
            clearTimer: scheduler.clearTimer,
            minIntervalMs: 0,
            periodicSyncIntervalMs: null,
        });

        controller.handleBlur();
        await Promise.resolve();

        expect(performSync).not.toHaveBeenCalled();

        controller.handleFocus();
        await waitForAssertion(() => {
            expect(performSync).toHaveBeenCalledTimes(1);
        });

        pendingLocalChanges = true;
        controller.handleBlur();
        await waitForAssertion(() => {
            expect(performSync).toHaveBeenCalledTimes(2);
        });
    });

    it('dedupes duplicate focus events before they queue a follow-up sync', async () => {
        const scheduler = createManualScheduler(50_000);
        let finishSync: (result: { success: boolean }) => void = () => undefined;
        const performSync = vi.fn(() => new Promise<{ success: boolean }>((resolve) => {
            finishSync = resolve;
        }));
        const controller = createDesktopAutoSyncController({
            canSync: async () => true,
            performSync,
            flushPendingSave: async () => undefined,
            reportError: vi.fn(),
            isRuntimeActive: () => true,
            now: scheduler.now,
            setTimer: scheduler.setTimer,
            clearTimer: scheduler.clearTimer,
            minIntervalMs: 0,
            periodicSyncIntervalMs: null,
        });

        controller.handleFocus();
        controller.handleFocus();
        await waitForAssertion(() => {
            expect(performSync).toHaveBeenCalledTimes(1);
        });

        finishSync({ success: true });
        await Promise.resolve();
        await Promise.resolve();

        expect(performSync).toHaveBeenCalledTimes(1);
    });

    it('runs a periodic heartbeat while the runtime is active', async () => {
        const scheduler = createManualScheduler();
        let pauseWindowSync = false;

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
            periodicSyncIntervalMs: 15 * 60 * 1000,
        });

        await scheduler.advanceBy(15 * 60 * 1000 - 1);
        expect(performSync).not.toHaveBeenCalled();

        await scheduler.advanceBy(1);
        await waitForAssertion(() => {
            expect(performSync).toHaveBeenCalledTimes(1);
        });

        pauseWindowSync = true;
        await scheduler.advanceBy(15 * 60 * 1000);
        expect(performSync).toHaveBeenCalledTimes(1);

        pauseWindowSync = false;
        await scheduler.advanceBy(15 * 60 * 1000);
        await waitForAssertion(() => {
            expect(performSync).toHaveBeenCalledTimes(2);
        });

        controller.dispose();
    });

    it('names the encryption state that suppressed an automatic run', async () => {
        // The Dropbox device test logged "the remote is encrypted and unreadable" for a
        // device that was itself the encrypted side of a remote that had gone plaintext.
        const cases = [
            ['remote-plaintext', 'Auto sync suppressed while this device is encrypted and the remote is not'],
            ['remote-encrypted-no-key', 'Auto sync suppressed while the remote is encrypted and unreadable'],
        ] as const;

        for (const [state, message] of cases) {
            const logInfo = vi.fn();
            const performSync = vi.fn(async () => ({ success: true }));
            const controller = createDesktopAutoSyncController({
                canSync: async () => true,
                syncEncryptionSuspension: async () => state,
                performSync,
                flushPendingSave: async () => undefined,
                reportError: vi.fn(),
                isRuntimeActive: () => true,
                minIntervalMs: 0,
                periodicSyncIntervalMs: null,
                logInfo,
            });

            controller.handleBlur();
            await waitForAssertion(() => {
                expect(logInfo).toHaveBeenCalledWith(message, { source: 'blur', state });
            });
            expect(performSync).not.toHaveBeenCalled();

            // A manual run still goes through: it is how the user finds out.
            await controller.requestSync();
            await waitForAssertion(() => {
                expect(performSync).toHaveBeenCalledTimes(1);
            });
            controller.dispose();
        }
    });

    it('cleans up the periodic heartbeat timer on dispose', async () => {
        const scheduler = createManualScheduler();

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
            periodicSyncIntervalMs: 15 * 60 * 1000,
        });

        expect(scheduler.getTimerCount()).toBe(1);
        controller.dispose();
        expect(scheduler.getTimerCount()).toBe(0);

        await scheduler.advanceBy(15 * 60 * 1000);
        expect(performSync).not.toHaveBeenCalled();
    });
});
