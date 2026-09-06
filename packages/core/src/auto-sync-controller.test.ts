import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAutoSyncController } from './auto-sync-controller';

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

// Timers alone do not finish a cycle: a request runs several awaits before it
// reaches performSync, so drain the microtask queue before asserting a count.
// A "not called" assertion made too early passes for the wrong reason.
const settle = async (times = 40) => {
    for (let index = 0; index < times; index += 1) {
        await Promise.resolve();
    }
};

describe('createAutoSyncController', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('queues a follow-up sync while the current cycle is still running', async () => {
        const performSync = vi.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 25));
            return { success: true };
        });
        const controller = createAutoSyncController({
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
        const controller = createAutoSyncController({
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
        const controller = createAutoSyncController({
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
        const controller = createAutoSyncController({
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
        const controller = createAutoSyncController({
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
        const controller = createAutoSyncController({
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
        const controller = createAutoSyncController({
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
        const controller = createAutoSyncController({
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
        const controller = createAutoSyncController({
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
        const controller = createAutoSyncController({
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
        await settle();

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
        const controller = createAutoSyncController({
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
        await settle();

        expect(performSync).toHaveBeenCalledTimes(1);
    });

    it('runs a periodic heartbeat while the runtime is active', async () => {
        const scheduler = createManualScheduler();
        let pauseWindowSync = false;

        const performSync = vi.fn(async () => ({ success: true }));
        const controller = createAutoSyncController({
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
            const controller = createAutoSyncController({
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
        const controller = createAutoSyncController({
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

// The switches below exist only because mobile needs them. Desktop leaves every
// one of them unset and keeps the behaviour asserted in the suite above.
describe('createAutoSyncController platform policy switches', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    const noopPorts = {
        flushPendingSave: async () => undefined,
        reportError: vi.fn(),
        isRuntimeActive: () => true,
        periodicSyncIntervalMs: null,
    } as const;

    it('measures the adaptive interval from the end of the cycle and stretches it by the cycle duration (#766)', async () => {
        const scheduler = createManualScheduler(10_000);
        const performSync = vi.fn(async () => {
            await new Promise<void>((resolve) => {
                scheduler.setTimer(() => resolve(), 20_000);
            });
            return { success: true };
        });
        const controller = createAutoSyncController({
            ...noopPorts,
            canSync: async () => true,
            performSync,
            minIntervalMs: 5_000,
            adaptivePacing: { durationMultiplier: 9, maxIntervalMs: 300_000 },
            now: scheduler.now,
            setTimer: scheduler.setTimer,
            clearTimer: scheduler.clearTimer,
        });

        void controller.requestAutoSync(undefined, 'test');
        await waitForAssertion(() => expect(performSync).toHaveBeenCalledTimes(1));

        // The 20s cycle ends at t=30_000 and re-anchors pacing there, so the next
        // interval is min(20s * 9, 5 min) = 180s measured from 30_000.
        await scheduler.advanceBy(20_000);
        await waitForAssertion(() => expect(controller.getLastAutoSyncAt()).toBe(30_000));

        await scheduler.advanceBy(170_000);
        void controller.requestAutoSync(undefined, 'test');
        await settle();
        expect(performSync).toHaveBeenCalledTimes(1);
        expect(controller.getLastAutoSyncAt()).toBe(30_000);

        await scheduler.advanceBy(10_000);
        await waitForAssertion(() => expect(performSync).toHaveBeenCalledTimes(2));

        controller.dispose();
    });

    it('skips the failure cooldown and the failure report for a failure the platform ignores', async () => {
        const scheduler = createManualScheduler(10_000);
        const performSync = vi.fn(async () => ({ success: false, error: 'Network request failed' }));
        const onSyncFailure = vi.fn();
        const controller = createAutoSyncController({
            ...noopPorts,
            canSync: async () => true,
            performSync,
            onSyncFailure,
            isIgnorableFailure: (error) => error === 'Network request failed',
            minIntervalMs: 0,
            now: scheduler.now,
            setTimer: scheduler.setTimer,
            clearTimer: scheduler.clearTimer,
        });

        await controller.requestAutoSync(0, 'test');
        expect(performSync).toHaveBeenCalledTimes(1);
        expect(onSyncFailure).not.toHaveBeenCalled();
        // No retry was armed, so nothing holds the next automatic request off.
        expect(scheduler.getTimerCount()).toBe(0);

        await Promise.resolve();
        await Promise.resolve();
        await controller.requestAutoSync(0, 'test');
        expect(performSync).toHaveBeenCalledTimes(2);

        controller.dispose();
    });

    it('holds a public automatic request behind the failure cooldown a manual request bypasses (#948)', async () => {
        const scheduler = createManualScheduler(10_000);
        const performSync = vi.fn(async () => ({ success: false, error: 'boom' }));
        const controller = createAutoSyncController({
            ...noopPorts,
            canSync: async () => true,
            performSync,
            minIntervalMs: 0,
            autoFailureCooldownMs: 60_000,
            now: scheduler.now,
            setTimer: scheduler.setTimer,
            clearTimer: scheduler.clearTimer,
        });

        await controller.requestAutoSync(0, 'test');
        expect(performSync).toHaveBeenCalledTimes(1);

        await Promise.resolve();
        await Promise.resolve();
        await controller.requestAutoSync(0, 'test');
        expect(performSync).toHaveBeenCalledTimes(1);

        await controller.requestSync(0);
        expect(performSync).toHaveBeenCalledTimes(2);

        controller.dispose();
    });

    it('reads the pacing cadence on every use so a platform can switch it at runtime', async () => {
        const scheduler = createManualScheduler(0);
        let cadence = { minIntervalMs: 0, debounceFirstChangeMs: 2_000, debounceContinuousChangeMs: 5_000 };
        const performSync = vi.fn(async () => ({ success: true }));
        const controller = createAutoSyncController({
            ...noopPorts,
            canSync: async () => true,
            performSync,
            getCadence: () => cadence,
            now: scheduler.now,
            setTimer: scheduler.setTimer,
            clearTimer: scheduler.clearTimer,
        });

        controller.handleDataChange();
        await scheduler.advanceBy(2_000);
        await waitForAssertion(() => expect(performSync).toHaveBeenCalledTimes(1));

        // The File Sync cadence debounces for 8s, not 2s.
        cadence = { minIntervalMs: 0, debounceFirstChangeMs: 8_000, debounceContinuousChangeMs: 15_000 };
        controller.handleDataChange();
        await scheduler.advanceBy(2_000);
        await settle();
        expect(performSync).toHaveBeenCalledTimes(1);

        await scheduler.advanceBy(6_000);
        await waitForAssertion(() => expect(performSync).toHaveBeenCalledTimes(2));

        // The continuous-change delay comes from the same live read: 15s, not 5s.
        controller.handleDataChange();
        await scheduler.advanceBy(1_000);
        controller.handleDataChange();
        await scheduler.advanceBy(14_999);
        await settle();
        expect(performSync).toHaveBeenCalledTimes(2);

        await scheduler.advanceBy(1);
        await waitForAssertion(() => expect(performSync).toHaveBeenCalledTimes(3));

        controller.dispose();
    });

    it('reads the minimum interval from the cadence a backend change installed', async () => {
        const scheduler = createManualScheduler(100_000);
        let cadence = { minIntervalMs: 5_000, debounceFirstChangeMs: 2_000, debounceContinuousChangeMs: 5_000 };
        const performSync = vi.fn(async () => ({ success: true }));
        const controller = createAutoSyncController({
            ...noopPorts,
            canSync: async () => true,
            performSync,
            getCadence: () => cadence,
            now: scheduler.now,
            setTimer: scheduler.setTimer,
            clearTimer: scheduler.clearTimer,
        });

        await controller.requestAutoSync(undefined, 'test');
        expect(performSync).toHaveBeenCalledTimes(1);

        // File Sync paces at 30s, so the 5s interval this cycle ran under no longer applies.
        cadence = { minIntervalMs: 30_000, debounceFirstChangeMs: 8_000, debounceContinuousChangeMs: 15_000 };
        await scheduler.advanceBy(29_999);
        void controller.requestAutoSync(undefined, 'test');
        await settle();
        expect(performSync).toHaveBeenCalledTimes(1);

        await scheduler.advanceBy(1);
        await waitForAssertion(() => expect(performSync).toHaveBeenCalledTimes(2));

        controller.dispose();
    });

    it('caps the adaptive interval instead of stretching with an unusually long cycle (#766)', async () => {
        const scheduler = createManualScheduler(10_000);
        const performSync = vi.fn(async () => {
            await new Promise<void>((resolve) => {
                scheduler.setTimer(() => resolve(), 60_000);
            });
            return { success: true };
        });
        const controller = createAutoSyncController({
            ...noopPorts,
            canSync: async () => true,
            performSync,
            minIntervalMs: 5_000,
            adaptivePacing: { durationMultiplier: 9, maxIntervalMs: 300_000 },
            now: scheduler.now,
            setTimer: scheduler.setTimer,
            clearTimer: scheduler.clearTimer,
        });

        void controller.requestAutoSync(undefined, 'test');
        await waitForAssertion(() => expect(performSync).toHaveBeenCalledTimes(1));

        // 60s * 9 is 9 minutes; the cap holds the next interval at 5 minutes.
        await scheduler.advanceBy(60_000);
        await waitForAssertion(() => expect(controller.getLastAutoSyncAt()).toBe(70_000));

        await scheduler.advanceBy(299_999);
        void controller.requestAutoSync(undefined, 'test');
        await settle();
        expect(performSync).toHaveBeenCalledTimes(1);

        await scheduler.advanceBy(1);
        await waitForAssertion(() => expect(performSync).toHaveBeenCalledTimes(2));

        controller.dispose();
    });

    it('keeps the continuous-change delay for later isolated edits until the runtime suspends', async () => {
        const scheduler = createManualScheduler(100_000);
        const performSync = vi.fn(async () => ({ success: true }));
        const controller = createAutoSyncController({
            ...noopPorts,
            canSync: async () => true,
            performSync,
            continuousDebounceUntilSuspend: true,
            minIntervalMs: 0,
            debounceFirstChangeMs: 2_000,
            debounceContinuousChangeMs: 5_000,
            now: scheduler.now,
            setTimer: scheduler.setTimer,
            clearTimer: scheduler.clearTimer,
        });

        controller.handleDataChange();
        await scheduler.advanceBy(2_000);
        await waitForAssertion(() => expect(performSync).toHaveBeenCalledTimes(1));

        // A later isolated edit is still a continuous change: 5s, not the 2s first-change delay.
        controller.handleDataChange();
        await scheduler.advanceBy(2_000);
        await settle();
        expect(performSync).toHaveBeenCalledTimes(1);

        await scheduler.advanceBy(3_000);
        await waitForAssertion(() => expect(performSync).toHaveBeenCalledTimes(2));

        // Suspending ends the session, so the next edit is a first change again.
        controller.handleSuspend();
        controller.handleDataChange();
        await scheduler.advanceBy(2_000);
        await waitForAssertion(() => expect(performSync).toHaveBeenCalledTimes(3));

        controller.dispose();
    });

    it('drops an internal retry a newer cycle already overtook', async () => {
        const scheduler = createManualScheduler(10_000);
        let finishSync: (result: { success: boolean }) => void = () => undefined;
        const performSync = vi.fn(() => new Promise<{ success: boolean }>((resolve) => {
            finishSync = resolve;
        }));
        const controller = createAutoSyncController({
            ...noopPorts,
            canSync: async () => true,
            performSync,
            skipRetryWhileCycleRunning: true,
            minIntervalMs: 5_000,
            now: scheduler.now,
            setTimer: scheduler.setTimer,
            clearTimer: scheduler.clearTimer,
        });

        void controller.requestAutoSync(0, 'first');
        await waitForAssertion(() => expect(performSync).toHaveBeenCalledTimes(1));
        finishSync({ success: true });
        await settle();

        // An edit one second later is throttled, arming a retry for t=15_000.
        await scheduler.advanceBy(1_000);
        void controller.requestAutoSync(undefined, 'data-change');
        await settle();
        expect(performSync).toHaveBeenCalledTimes(1);

        // A CloudKit notification starts a newer cycle that is still running then.
        await scheduler.advanceBy(1_000);
        void controller.requestAutoSync(0, 'cloudkit');
        await waitForAssertion(() => expect(performSync).toHaveBeenCalledTimes(2));

        await scheduler.advanceBy(3_000);
        await settle();
        expect(performSync).toHaveBeenCalledTimes(2);

        // The running cycle satisfied the retry, so nothing follows it.
        finishSync({ success: true });
        await settle();
        expect(performSync).toHaveBeenCalledTimes(2);

        controller.dispose();
    });

    it('lets the platform veto a debounced data change', async () => {
        const scheduler = createManualScheduler(0);
        let allowSync = false;
        const performSync = vi.fn(async () => ({ success: true }));
        const controller = createAutoSyncController({
            ...noopPorts,
            canSync: async () => true,
            performSync,
            shouldSyncOnDebouncedChange: () => allowSync,
            minIntervalMs: 0,
            debounceFirstChangeMs: 2_000,
            now: scheduler.now,
            setTimer: scheduler.setTimer,
            clearTimer: scheduler.clearTimer,
        });

        controller.handleDataChange();
        await scheduler.advanceBy(2_000);
        await settle();
        expect(performSync).not.toHaveBeenCalled();

        allowSync = true;
        controller.handleDataChange();
        await scheduler.advanceBy(2_000);
        await settle();
        expect(performSync).toHaveBeenCalledTimes(1);

        controller.dispose();
    });

    it('waits for the cadence refresh to finish before a debounced data change syncs', async () => {
        const scheduler = createManualScheduler(0);
        let releaseRefresh: (() => void) | null = null;
        const performSync = vi.fn(async () => ({ success: true }));
        const controller = createAutoSyncController({
            ...noopPorts,
            canSync: async () => true,
            performSync,
            refreshCadence: () => new Promise<void>((resolve) => {
                releaseRefresh = resolve;
            }),
            minIntervalMs: 0,
            debounceFirstChangeMs: 2_000,
            now: scheduler.now,
            setTimer: scheduler.setTimer,
            clearTimer: scheduler.clearTimer,
        });

        controller.handleDataChange();
        await scheduler.advanceBy(2_000);
        await settle();
        // The debounce has fired, but the cadence this run should be paced by is
        // still being read.
        expect(releaseRefresh).toBeTypeOf('function');
        expect(performSync).not.toHaveBeenCalled();

        releaseRefresh?.();
        await settle();
        expect(performSync).toHaveBeenCalledTimes(1);

        controller.dispose();
    });

    it('does not chain a follow-up cycle that was requested while the runtime was suspended', async () => {
        const scheduler = createManualScheduler(10_000);
        let suspended = false;
        const performSync = vi.fn(async () => {
            await new Promise<void>((resolve) => {
                scheduler.setTimer(() => resolve(), 1_000);
            });
            return { success: true };
        });
        const controller = createAutoSyncController({
            ...noopPorts,
            canSync: async () => true,
            performSync,
            isSuspended: () => suspended,
            adaptivePacing: { durationMultiplier: 9, maxIntervalMs: 300_000 },
            minIntervalMs: 0,
            now: scheduler.now,
            setTimer: scheduler.setTimer,
            clearTimer: scheduler.clearTimer,
        });

        suspended = true;
        void controller.requestAutoSync(0, 'background');
        await waitForAssertion(() => expect(performSync).toHaveBeenCalledTimes(1));
        void controller.requestAutoSync(0, 'background');

        await scheduler.advanceBy(1_000);
        await settle();
        expect(controller.getLastAutoSyncAt()).toBe(11_000);
        expect(performSync).toHaveBeenCalledTimes(1);

        suspended = false;
        void controller.requestAutoSync(0, 'resume');
        await waitForAssertion(() => expect(performSync).toHaveBeenCalledTimes(2));

        controller.dispose();
    });
});
