import { createSyncOrchestrator } from './sync-orchestrator';
import { resolveSyncFailureCooldownMs } from './sync-runtime-utils';

type SyncResult = {
    success: boolean;
    error?: string;
};

/** The three pacing numbers a platform may vary at runtime. Desktop keeps them
 *  fixed for the life of the controller; mobile swaps the whole set per sync
 *  backend (File Sync is far cheaper to leave alone than a remote one). */
export type AutoSyncCadence = {
    minIntervalMs: number;
    debounceFirstChangeMs: number;
    debounceContinuousChangeMs: number;
};

/** Mobile pacing policy (#766). Three coupled behaviours, one switch:
 *  1. the throttle interval is measured from cycle END, not cycle start, so a
 *     cycle that runs longer than the interval cannot roll straight into the next;
 *  2. the interval stretches to `min(cycleDuration * durationMultiplier, maxIntervalMs)`,
 *     which caps the share of the JS thread sync occupies on a busy device;
 *  3. a follow-up queued during a cycle re-runs at the ordinary cadence instead
 *     of repeating the original request's interval override.
 *  Desktop leaves this unset and keeps cycle-start anchoring. */
export type AutoSyncAdaptivePacing = {
    durationMultiplier: number;
    maxIntervalMs: number;
};

export type AutoSyncControllerOptions = {
    performSync: () => Promise<SyncResult>;
    flushPendingSave: () => Promise<void>;
    reportError: (label: string, error: unknown) => void;
    isRuntimeActive: () => boolean;
    /** Absent means "always allowed"; desktop gates on its own sync runtime. */
    canSync?: () => Promise<boolean>;
    /** #1056 decision #5: the encryption states that hold automatic and background sync off
     *  for a backend until the user acts, or `null` when nothing is holding it. Two states
     *  qualify and they are opposites — `remote-encrypted-no-key` (the remote is encrypted
     *  and this device has no key) and `remote-plaintext` (this device is encrypted and the
     *  remote went back to plaintext) — so the suppression log names the one it got instead
     *  of asserting the first. A MANUAL run is deliberately still allowed through: it is how
     *  the user finds out, and it surfaces the typed failure instead of doing nothing. */
    syncEncryptionSuspension?: () => Promise<'remote-encrypted-no-key' | 'remote-plaintext' | null>;
    onSyncFailure?: (error: string) => void;
    /** Desktop: the task editor lock. Holds window-driven syncs off mid-edit. */
    shouldPauseWindowSync?: () => boolean;
    /** Desktop: blur only syncs when this device has something to push. */
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
    /** Overrides the three fixed pacing numbers on every read. Mobile returns the
     *  cadence for the currently selected backend. */
    getCadence?: () => AutoSyncCadence;
    /** Awaited before a debounced data-change fires, so a platform that reads its
     *  cadence from storage can refresh it first. Desktop leaves it unset and the
     *  debounced trigger stays synchronous. */
    refreshCadence?: () => Promise<unknown>;
    /** Last gate before a debounced data change syncs. Mobile compares the sync
     *  payload fingerprint here, once per quiet period rather than per write (#766). */
    shouldSyncOnDebouncedChange?: () => boolean;
    adaptivePacing?: AutoSyncAdaptivePacing;
    /** Mobile: the app is backgrounded. A request that arrives while a cycle
     *  started in that state is remembered but not chained onto — Android pauses
     *  background JS timers, so a follow-up there would not run reliably anyway. */
    isSuspended?: () => boolean;
    /** Mobile: the first-change debounce applies once per foreground session, not
     *  once per quiet period. After the first debounced sync every later edit keeps
     *  the continuous-change delay until the runtime suspends. Desktop resets to
     *  the first-change delay after each debounced sync. */
    continuousDebounceUntilSuspend?: boolean;
    /** Mobile: an internal retry (a throttle or cooldown timer firing) that a newer
     *  cycle has already overtaken is satisfied by that cycle and dropped. Desktop
     *  queues it as a follow-up. Only internal retries are affected; a genuinely new
     *  request always queues. */
    skipRetryWhileCycleRunning?: boolean;
    /** Failures this platform does not treat as a reason to back off: no cooldown,
     *  no `onSyncFailure`. Mobile exempts offline errors and result-shaped failures
     *  that carry no message. */
    isIgnorableFailure?: (error: string | undefined) => boolean;
};

type AutoSyncRequest = {
    minIntervalMs?: number;
    source: string;
    bypassFailureCooldown: boolean;
};

export type AutoSyncController = {
    /** A user-initiated run: bypasses the failure cooldown. */
    requestSync: (minIntervalMs?: number) => Promise<void>;
    /** An automatic run: waits out the failure cooldown like every other trigger (#948). */
    requestAutoSync: (minIntervalMs?: number, source?: string) => Promise<void>;
    handleFocus: () => void;
    handleBlur: () => void;
    handleDataChange: () => void;
    scheduleInitialSync: () => void;
    /** The runtime is going away (mobile background). Drops the pacing timers it
     *  cannot honour, but never a failure-owned retry deadline. */
    handleSuspend: () => void;
    /** A successful sync that ran outside this controller (mobile's manual button)
     *  cancels the automatic retry left by an earlier failure (#948). */
    notifyExternalSyncSuccess: () => void;
    /** Reads and clears "a request arrived while the runtime was suspended and a
     *  cycle was already running". Mobile runs it on the next foreground. */
    takePendingSuspendedRequest: () => boolean;
    getLastAutoSyncAt: () => number;
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

export const createAutoSyncController = (
    options: AutoSyncControllerOptions
): AutoSyncController => {
    const now = options.now ?? (() => Date.now());
    const setTimer = options.setTimer ?? setTimeout;
    const clearTimer = options.clearTimer ?? clearTimeout;
    const staticCadence: AutoSyncCadence = {
        minIntervalMs: options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
        debounceFirstChangeMs: options.debounceFirstChangeMs ?? DEFAULT_DEBOUNCE_FIRST_CHANGE_MS,
        debounceContinuousChangeMs: options.debounceContinuousChangeMs ?? DEFAULT_DEBOUNCE_CONTINUOUS_CHANGE_MS,
    };
    const cadence = (): AutoSyncCadence => options.getCadence?.() ?? staticCadence;
    const focusMinIntervalMs = options.focusMinIntervalMs ?? DEFAULT_FOCUS_MIN_INTERVAL_MS;
    const autoFailureCooldownMs = options.autoFailureCooldownMs ?? DEFAULT_AUTO_FAILURE_COOLDOWN_MS;
    const maxFailureCooldownMs = options.maxFailureCooldownMs ?? DEFAULT_MAX_FAILURE_COOLDOWN_MS;
    const initialSyncDelayMs = options.initialSyncDelayMs ?? DEFAULT_INITIAL_SYNC_DELAY_MS;
    // `null` means "no heartbeat" and must not fall back to the default: mobile
    // relies on that, because Android pauses background JS timers and its
    // periodic sync is a platform job, not a timer here.
    const periodicSyncIntervalMs = options.periodicSyncIntervalMs === undefined
        ? DEFAULT_PERIODIC_SYNC_INTERVAL_MS
        : options.periodicSyncIntervalMs;
    const periodicSyncEnabled = typeof periodicSyncIntervalMs === 'number'
        && Number.isFinite(periodicSyncIntervalMs)
        && periodicSyncIntervalMs > 0;
    const adaptivePacing = options.adaptivePacing;

    let lastAutoSyncAt = 0;
    let lastCycleDurationMs = 0;
    let syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let syncThrottleTimer: ReturnType<typeof setTimeout> | null = null;
    let initialSyncTimer: ReturnType<typeof setTimeout> | null = null;
    let periodicSyncTimer: ReturnType<typeof setTimeout> | null = null;
    let autoSyncRetryAfter = 0;
    let consecutiveAutoSyncFailures = 0;
    let lastFocusTriggerAt = 0;
    let requestedWhileSuspended = false;
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
            void requestAutoSync(0, 'failure-cooldown', true).catch((error) => options.reportError('Sync failed', error));
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

    // An explicit 0 (a manual run, a lifecycle transition, an internal retry)
    // bypasses pacing entirely; every other request is stretched by how long the
    // last cycle actually took on this device.
    const resolveEffectiveMinIntervalMs = (requestedMinIntervalMs: number | undefined) => {
        const requested = typeof requestedMinIntervalMs === 'number'
            ? requestedMinIntervalMs
            : cadence().minIntervalMs;
        if (!adaptivePacing || requested <= 0) return requested;
        return Math.max(
            requested,
            Math.min(lastCycleDurationMs * adaptivePacing.durationMultiplier, adaptivePacing.maxIntervalMs),
        );
    };

    const autoSyncOrchestrator = createSyncOrchestrator<AutoSyncRequest, void>({
        runCycle: async (request, controls) => {
            if (!options.isRuntimeActive()) return;
            if (!request.bypassFailureCooldown && !shouldRunAutoSyncNow(request.source)) return;

            const effectiveMinIntervalMs = resolveEffectiveMinIntervalMs(request.minIntervalMs);
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
                        void requestAutoSync(0, 'throttle', true);
                    }, waitMs);
                }
                return;
            }

            // Captured here, not after the awaits below: a lifecycle transition can
            // land during an awaited port and would otherwise misclassify a cycle
            // that started in the foreground as a background one.
            const cycleStartedSuspended = options.isSuspended?.() ?? false;

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

            if (options.canSync && !(await options.canSync())) return;

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
            const ignorableFailure = result.success
                ? false
                : (options.isIgnorableFailure?.(result.error) ?? false);
            if (result.success) {
                autoSyncRetryAfter = 0;
                consecutiveAutoSyncFailures = 0;
                // A manual run can recover before a scheduled automatic retry.
                // Its successful cycle already includes the pending local work.
                clearSyncThrottle();
            } else if (!ignorableFailure) {
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
            if (!result.success && result.error && !ignorableFailure) {
                options.onSyncFailure?.(result.error);
            }

            if (adaptivePacing) {
                const cycleEndedAt = now();
                lastCycleDurationMs = cycleEndedAt - nowMs;
                lastAutoSyncAt = cycleEndedAt;
                if (cycleStartedSuspended && requestedWhileSuspended) {
                    // The next trigger will run this work; chaining a cycle while
                    // backgrounded is what the platform will not let finish anyway.
                    requestedWhileSuspended = false;
                    autoSyncOrchestrator.clearFollowUp();
                } else if (autoSyncOrchestrator.getState().queued) {
                    controls.requestFollowUp({
                        minIntervalMs: cadence().minIntervalMs,
                        source: 'follow-up',
                        bypassFailureCooldown: false,
                    });
                }
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

    const requestAutoSync = async (
        overrideMinIntervalMs: number | undefined,
        source: string,
        internalRetry = false,
    ): Promise<void> => {
        if (!options.isRuntimeActive()) return;
        if (options.isSuspended?.() && autoSyncOrchestrator.getState().inFlight) {
            requestedWhileSuspended = true;
        }
        if (internalRetry && options.skipRetryWhileCycleRunning && autoSyncOrchestrator.getState().inFlight) return;
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
        requestAutoSync: (overrideMinIntervalMs?: number, source = 'external') => (
            requestAutoSync(overrideMinIntervalMs, source)
        ),
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
            const activeCadence = cadence();
            const debounceMs = hadTimer
                ? activeCadence.debounceContinuousChangeMs
                : activeCadence.debounceFirstChangeMs;
            trace('Auto sync data change queued', {
                debounceMs: String(debounceMs),
                hadTimer: String(hadTimer),
            });
            syncDebounceTimer = setTimer(() => {
                if (!options.continuousDebounceUntilSuspend) syncDebounceTimer = null;
                if (!options.isRuntimeActive()) return;
                if (options.shouldSyncOnDebouncedChange && !options.shouldSyncOnDebouncedChange()) return;
                trace('Auto sync trigger', { source: 'data-change' });
                const fire = () => {
                    void requestAutoSync(undefined, 'data-change').catch((error) => options.reportError('Sync failed', error));
                };
                if (!options.refreshCadence) {
                    fire();
                    return;
                }
                void options.refreshCadence()
                    .then(fire)
                    .catch((error) => options.reportError('Sync failed', error));
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
        handleSuspend: () => {
            clearSyncDebounce();
            // Normal pacing should not block the next attempt, but a failure retry
            // must keep its owned deadline even when the runtime suspends.
            if (autoSyncRetryAfter === 0) clearSyncThrottle();
        },
        notifyExternalSyncSuccess: () => {
            autoSyncRetryAfter = 0;
            consecutiveAutoSyncFailures = 0;
            clearSyncThrottle();
        },
        takePendingSuspendedRequest: () => {
            const pending = requestedWhileSuspended;
            requestedWhileSuspended = false;
            return pending;
        },
        getLastAutoSyncAt: () => lastAutoSyncAt,
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
