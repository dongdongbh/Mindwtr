import { createSyncOrchestrator, resolveSyncFailureCooldownMs } from '@mindwtr/core';

type SyncResult = {
    success: boolean;
    error?: string;
};

type DesktopAutoSyncControllerOptions = {
    canSync: () => Promise<boolean>;
    /** #1056 decision #5: the encryption states that hold automatic and background sync off
     *  for a backend until the user acts, or `null` when nothing is holding it. Two states
     *  qualify and they are opposites — `remote-encrypted-no-key` (the remote is encrypted
     *  and this device has no key) and `remote-plaintext` (this device is encrypted and the
     *  remote went back to plaintext) — so the suppression log names the one it got instead
     *  of asserting the first. A MANUAL run is deliberately still allowed through: it is how
     *  the user finds out, and it surfaces the typed failure instead of doing nothing. */
    syncEncryptionSuspension?: () => Promise<'remote-encrypted-no-key' | 'remote-plaintext' | null>;
    performSync: () => Promise<SyncResult>;
    flushPendingSave: () => Promise<void>;
    reportError: (label: string, error: unknown) => void;
    onSyncFailure?: (error: string) => void;
    isRuntimeActive: () => boolean;
    shouldPauseWindowSync?: () => boolean;
    hasPendingLocalChanges?: () => boolean;
    logInfo?: (message: string, extra?: Record<string, string>) => void;
    now?: () => number;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
    minIntervalMs?: number;
    focusMinIntervalMs?: number;
    debounceFirstChangeMs?: number;
    debounceContinuousChangeMs?: number;
    autoFailureCooldownMs?: number;
    maxFailureCooldownMs?: number;
    initialSyncDelayMs?: number;
    periodicSyncIntervalMs?: number | null;
};

type AutoSyncRequest = {
    minIntervalMs?: number;
    source: string;
    bypassFailureCooldown: boolean;
};

export type DesktopAutoSyncController = {
    requestSync: (minIntervalMs?: number) => Promise<void>;
    handleFocus: () => void;
    handleBlur: () => void;
    handleDataChange: () => void;
    scheduleInitialSync: () => void;
    dispose: () => void;
};

const DEFAULT_MIN_INTERVAL_MS = 5_000;
const DEFAULT_FOCUS_MIN_INTERVAL_MS = 30_000;
const DEFAULT_DEBOUNCE_FIRST_CHANGE_MS = 2_000;
const DEFAULT_DEBOUNCE_CONTINUOUS_CHANGE_MS = 5_000;
const DEFAULT_AUTO_FAILURE_COOLDOWN_MS = 60_000;
const DEFAULT_MAX_FAILURE_COOLDOWN_MS = 10 * 60_000;
const DEFAULT_INITIAL_SYNC_DELAY_MS = 1_500;
const DEFAULT_PERIODIC_SYNC_INTERVAL_MS = 15 * 60 * 1000;
const FOCUS_TRIGGER_DEDUPE_MS = 1_000;

export const createDesktopAutoSyncController = (
    options: DesktopAutoSyncControllerOptions
): DesktopAutoSyncController => {
    const now = options.now ?? (() => Date.now());
    const setTimer = options.setTimer ?? setTimeout;
    const clearTimer = options.clearTimer ?? clearTimeout;
    const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    const focusMinIntervalMs = options.focusMinIntervalMs ?? DEFAULT_FOCUS_MIN_INTERVAL_MS;
    const debounceFirstChangeMs = options.debounceFirstChangeMs ?? DEFAULT_DEBOUNCE_FIRST_CHANGE_MS;
    const debounceContinuousChangeMs = options.debounceContinuousChangeMs ?? DEFAULT_DEBOUNCE_CONTINUOUS_CHANGE_MS;
    const autoFailureCooldownMs = options.autoFailureCooldownMs ?? DEFAULT_AUTO_FAILURE_COOLDOWN_MS;
    const maxFailureCooldownMs = options.maxFailureCooldownMs ?? DEFAULT_MAX_FAILURE_COOLDOWN_MS;
    const initialSyncDelayMs = options.initialSyncDelayMs ?? DEFAULT_INITIAL_SYNC_DELAY_MS;
    const periodicSyncIntervalMs = options.periodicSyncIntervalMs ?? DEFAULT_PERIODIC_SYNC_INTERVAL_MS;
    const periodicSyncEnabled = typeof periodicSyncIntervalMs === 'number'
        && Number.isFinite(periodicSyncIntervalMs)
        && periodicSyncIntervalMs > 0;

    let lastAutoSyncAt = 0;
    let syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let syncThrottleTimer: ReturnType<typeof setTimeout> | null = null;
    let initialSyncTimer: ReturnType<typeof setTimeout> | null = null;
    let periodicSyncTimer: ReturnType<typeof setTimeout> | null = null;
    let autoSyncRetryAfter = 0;
    let consecutiveAutoSyncFailures = 0;
    let lastFocusTriggerAt = 0;
    let disposed = false;

    const trace = (message: string, extra?: Record<string, string>) => {
        options.logInfo?.(message, extra);
    };

    const clearSyncDebounce = () => {
        if (!syncDebounceTimer) return;
        clearTimer(syncDebounceTimer);
        syncDebounceTimer = null;
    };

    const clearSyncThrottle = () => {
        if (!syncThrottleTimer) return;
        clearTimer(syncThrottleTimer);
        syncThrottleTimer = null;
    };

    const clearInitialSync = () => {
        if (!initialSyncTimer) return;
        clearTimer(initialSyncTimer);
        initialSyncTimer = null;
    };

    const clearPeriodicSync = () => {
        if (!periodicSyncTimer) return;
        clearTimer(periodicSyncTimer);
        periodicSyncTimer = null;
    };

    const schedulePeriodicSync = () => {
        clearPeriodicSync();
        if (!periodicSyncEnabled || disposed) return;
        periodicSyncTimer = setTimer(() => {
            periodicSyncTimer = null;
            if (disposed) return;
            if (options.isRuntimeActive() && !options.shouldPauseWindowSync?.()) {
                trace('Auto sync trigger', { source: 'periodic' });
                void requestAutoSync(undefined, 'periodic').catch((error) => options.reportError('Sync failed', error));
            }
            schedulePeriodicSync();
        }, periodicSyncIntervalMs);
    };

    const scheduleAutoRetryAfterCooldown = (source: string, replaceExisting = false) => {
        const waitMs = Math.max(0, autoSyncRetryAfter - now());
        if (replaceExisting) {
            clearSyncThrottle();
            trace('Auto sync retry scheduled after failure', {
                source,
                waitMs: String(waitMs),
            });
        } else {
            trace('Auto sync skipped during failure cooldown', {
                source,
                waitMs: String(waitMs),
            });
            if (syncThrottleTimer) return;
        }
        syncThrottleTimer = setTimer(() => {
            syncThrottleTimer = null;
            if (disposed) return;
            trace('Auto sync trigger', { source: 'failure-cooldown' });
            void requestAutoSync(0, 'failure-cooldown').catch((error) => options.reportError('Sync failed', error));
        }, waitMs);
    };

    const shouldRunAutoSyncNow = (source: string) => {
        if (now() >= autoSyncRetryAfter) return true;
        scheduleAutoRetryAfterCooldown(source);
        return false;
    };

    const canRunWindowSync = () => (
        options.isRuntimeActive()
        && !options.shouldPauseWindowSync?.()
    );

    const shouldRunBlurSync = () => (
        canRunWindowSync()
        && (options.hasPendingLocalChanges?.() ?? true)
    );

    const autoSyncOrchestrator = createSyncOrchestrator<AutoSyncRequest, void>({
        runCycle: async (request) => {
            if (!options.isRuntimeActive()) return;
            if (!request.bypassFailureCooldown && !shouldRunAutoSyncNow(request.source)) return;

            const effectiveMinIntervalMs = typeof request.minIntervalMs === 'number'
                ? request.minIntervalMs
                : minIntervalMs;
            const nowMs = now();
            if (nowMs - lastAutoSyncAt < effectiveMinIntervalMs) {
                if (!syncThrottleTimer) {
                    const waitMs = Math.max(0, effectiveMinIntervalMs - (nowMs - lastAutoSyncAt));
                    trace('Auto sync throttled', {
                        waitMs: String(waitMs),
                        minIntervalMs: String(effectiveMinIntervalMs),
                    });
                    syncThrottleTimer = setTimer(() => {
                        syncThrottleTimer = null;
                        trace('Auto sync trigger', { source: 'throttle' });
                        void requestAutoSync(0, 'throttle');
                    }, waitMs);
                }
                return;
            }

            const suspension = request.source === 'manual'
                ? null
                : await options.syncEncryptionSuspension?.() ?? null;
            if (suspension) {
                trace(
                    suspension === 'remote-plaintext'
                        ? 'Auto sync suppressed while this device is encrypted and the remote is not'
                        : 'Auto sync suppressed while the remote is encrypted and unreadable',
                    { source: request.source, state: suspension },
                );
                return;
            }

            if (!(await options.canSync())) return;

            lastAutoSyncAt = nowMs;
            trace('Auto sync run start', {
                minIntervalMs: String(effectiveMinIntervalMs),
            });
            await options.flushPendingSave().catch((error) => options.reportError('Save failed', error));

            const result = await options.performSync();
            trace('Auto sync run complete', {
                success: String(result.success),
                error: result.error ?? '',
            });
            if (result.success) {
                autoSyncRetryAfter = 0;
                consecutiveAutoSyncFailures = 0;
                // A manual run can recover before a scheduled automatic retry.
                // Its successful cycle already includes the pending local work.
                clearSyncThrottle();
            } else {
                // CloudKit answers a throttle with the delay it wants; honour it
                // rather than retrying on a fixed 60s that keeps tripping the
                // same limit. Arm the retry now instead of waiting for another
                // edit, focus change, or heartbeat to discover the cooldown.
                consecutiveAutoSyncFailures += 1;
                const cooldownMs = resolveSyncFailureCooldownMs({
                    error: result.error,
                    consecutiveFailures: consecutiveAutoSyncFailures,
                    baseMs: autoFailureCooldownMs,
                    maxMs: maxFailureCooldownMs,
                });
                trace('Auto sync cooldown', {
                    cooldownMs: String(cooldownMs),
                    consecutiveFailures: String(consecutiveAutoSyncFailures),
                });
                autoSyncRetryAfter = Math.max(autoSyncRetryAfter, now() + cooldownMs);
                scheduleAutoRetryAfterCooldown(request.source, true);
            }
            if (!result.success && result.error) {
                options.onSyncFailure?.(result.error);
            }
        },
        onQueuedRunError: (error) => options.reportError('Sync failed', error),
    });

    const requestSync = async (overrideMinIntervalMs?: number): Promise<void> => {
        if (!options.isRuntimeActive()) return;
        await autoSyncOrchestrator.run({
            minIntervalMs: overrideMinIntervalMs,
            source: 'manual',
            bypassFailureCooldown: true,
        });
    };

    const requestAutoSync = async (overrideMinIntervalMs: number | undefined, source: string): Promise<void> => {
        if (!options.isRuntimeActive()) return;
        if (!shouldRunAutoSyncNow(source)) return;
        await autoSyncOrchestrator.run({
            minIntervalMs: overrideMinIntervalMs,
            source,
            bypassFailureCooldown: false,
        });
    };

    schedulePeriodicSync();

    return {
        requestSync,
        handleFocus: () => {
            if (!canRunWindowSync()) return;
            const nowMs = now();
            if (nowMs - lastFocusTriggerAt < FOCUS_TRIGGER_DEDUPE_MS) return;
            if (nowMs - lastAutoSyncAt > focusMinIntervalMs) {
                lastFocusTriggerAt = nowMs;
                trace('Auto sync trigger', { source: 'focus' });
                void requestAutoSync(undefined, 'focus').catch((error) => options.reportError('Sync failed', error));
            }
        },
        handleBlur: () => {
            if (!shouldRunBlurSync()) return;
            trace('Auto sync trigger', { source: 'blur' });
            void requestAutoSync(undefined, 'blur').catch((error) => options.reportError('Sync failed', error));
        },
        handleDataChange: () => {
            if (!options.isRuntimeActive()) return;
            const hadTimer = !!syncDebounceTimer;
            clearSyncDebounce();
            const debounceMs = hadTimer ? debounceContinuousChangeMs : debounceFirstChangeMs;
            trace('Auto sync data change queued', {
                debounceMs: String(debounceMs),
                hadTimer: String(hadTimer),
            });
            syncDebounceTimer = setTimer(() => {
                syncDebounceTimer = null;
                if (!options.isRuntimeActive()) return;
                trace('Auto sync trigger', { source: 'data-change' });
                void requestAutoSync(undefined, 'data-change').catch((error) => options.reportError('Sync failed', error));
            }, debounceMs);
        },
        scheduleInitialSync: () => {
            clearInitialSync();
            initialSyncTimer = setTimer(() => {
                initialSyncTimer = null;
                if (!options.isRuntimeActive()) return;
                trace('Auto sync trigger', { source: 'initial' });
                void requestAutoSync(undefined, 'initial').catch((error) => options.reportError('Sync failed', error));
            }, initialSyncDelayMs);
        },
        dispose: () => {
            disposed = true;
            clearSyncDebounce();
            clearSyncThrottle();
            clearInitialSync();
            clearPeriodicSync();
            autoSyncOrchestrator.reset();
        },
    };
};
