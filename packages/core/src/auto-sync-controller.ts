import { createSyncOrchestrator } from './sync-orchestrator';
import { resolveSyncFailureCooldownMs } from './sync-runtime-utils';

type SyncResult = {
    success: boolean;
    error?: string;
};


export type AutoSyncCadence = {
    minIntervalMs: number;
    debounceFirstChangeMs: number;
    debounceContinuousChangeMs: number;
};


export type AutoSyncAdaptivePacing = {
    durationMultiplier: number;
    maxIntervalMs: number;
};

export type AutoSyncControllerOptions = {
    performSync: () => Promise<SyncResult>;


    allowDeferredWork?: boolean;
    flushPendingSave: () => Promise<void>;
    reportError: (label: string, error: unknown) => void;
    isRuntimeActive: () => boolean;

    canSync?: () => Promise<boolean>;


    syncEncryptionSuspension?: () => Promise<'remote-encrypted-no-key' | 'remote-plaintext' | null>;
    onSyncFailure?: (error: string) => void;

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


    getCadence?: () => AutoSyncCadence;


    refreshCadence?: () => Promise<unknown>;


    shouldSyncOnDebouncedChange?: () => boolean;
    adaptivePacing?: AutoSyncAdaptivePacing;


    isSuspended?: () => boolean;


    continuousDebounceUntilSuspend?: boolean;


    skipRetryWhileCycleRunning?: boolean;


    isIgnorableFailure?: (error: string | undefined) => boolean;
};

type AutoSyncRequest = {
    minIntervalMs?: number;
    source: string;
    bypassFailureCooldown: boolean;
};

export type AutoSyncController = {

    requestSync: (minIntervalMs?: number) => Promise<void>;

    requestAutoSync: (minIntervalMs?: number, source?: string) => Promise<void>;
    handleFocus: () => void;
    handleBlur: () => void;
    handleDataChange: () => void;
    scheduleInitialSync: () => void;


    handleSuspend: () => void;


    notifyExternalSyncSuccess: () => void;


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


    const periodicSyncIntervalMs = options.periodicSyncIntervalMs === undefined
        ? DEFAULT_PERIODIC_SYNC_INTERVAL_MS
        : options.periodicSyncIntervalMs;
    const periodicSyncEnabled = typeof periodicSyncIntervalMs === 'number'
        && Number.isFinite(periodicSyncIntervalMs)
        && periodicSyncIntervalMs > 0;
    const adaptivePacing = options.adaptivePacing;
    const allowDeferredWork = options.allowDeferredWork ?? true;

    let lastAutoSyncAt = 0;
    let lastCycleDurationMs = 0;
    let lastCycleCarriedLocalChange = false;
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
        if (!allowDeferredWork || !periodicSyncEnabled || disposed) return;
        const scheduledAt = now();
        trace('Auto sync periodic scheduled', { delayMs: String(periodicSyncIntervalMs) });
        periodicSyncTimer = setTimer(() => {
            periodicSyncTimer = null;
            if (disposed) return;
            const runtimeActive = options.isRuntimeActive();

            const editorPause = runtimeActive ? (options.shouldPauseWindowSync?.() ?? false) : null;
            trace('Auto sync periodic fired', {
                delayMs: String(periodicSyncIntervalMs),
                latenessMs: String(Math.max(0, now() - scheduledAt - periodicSyncIntervalMs)),
                runtimeActive: String(runtimeActive),
                editorPause: editorPause === null ? 'not-checked' : String(editorPause),
                outcome: !runtimeActive ? 'inactive' : editorPause ? 'editor-paused' : 'requested',
            });
            if (runtimeActive && !editorPause) {
                trace('Auto sync trigger', { source: 'periodic' });
                void requestAutoSync(undefined, 'periodic').catch((error) => options.reportError('Sync failed', error));
            }
            schedulePeriodicSync();
        }, periodicSyncIntervalMs);
    };

    const scheduleAutoRetryAfterCooldown = (source: string, replaceExisting = false) => {
        if (!allowDeferredWork) return;
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


    const resolveEffectiveMinIntervalMs = (requestedMinIntervalMs: number | undefined) => {
        const requested = typeof requestedMinIntervalMs === 'number'
            ? requestedMinIntervalMs
            : cadence().minIntervalMs;
        if (!adaptivePacing || requested <= 0) return { minIntervalMs: requested, adaptiveMinIntervalMs: requested };
        const adaptiveMinIntervalMs = Math.max(
            requested,
            Math.min(lastCycleDurationMs * adaptivePacing.durationMultiplier, adaptivePacing.maxIntervalMs),
        );
        const freshLocalChange = !lastCycleCarriedLocalChange && (options.hasPendingLocalChanges?.() ?? false);
        return { minIntervalMs: freshLocalChange ? requested : adaptiveMinIntervalMs, adaptiveMinIntervalMs };
    };

    const autoSyncOrchestrator = createSyncOrchestrator<AutoSyncRequest, void>({
        runCycle: async (request, controls) => {
            if (!options.isRuntimeActive()) {
                trace('Auto sync run skipped', { source: request.source, reason: 'inactive' });
                return;
            }
            if (!request.bypassFailureCooldown && !shouldRunAutoSyncNow(request.source)) return;

            const {
                minIntervalMs: effectiveMinIntervalMs,
                adaptiveMinIntervalMs,
            } = resolveEffectiveMinIntervalMs(request.minIntervalMs);
            const nowMs = now();
            const elapsedMs = nowMs - lastAutoSyncAt;
            if (effectiveMinIntervalMs < adaptiveMinIntervalMs && elapsedMs < adaptiveMinIntervalMs) {
                trace('Auto sync local change skipped adaptive pacing', {
                    releaseCheck: 'v1.3.7/local-change-upload',
                    source: request.source,
                    delayMs: String(Math.max(0, effectiveMinIntervalMs - elapsedMs)),
                    adaptiveWaitMs: String(adaptiveMinIntervalMs - elapsedMs),
                });
            }
            if (elapsedMs < effectiveMinIntervalMs) {
                if (allowDeferredWork && !syncThrottleTimer) {
                    const waitMs = Math.max(0, effectiveMinIntervalMs - elapsedMs);
                    trace('Auto sync throttled', {
                        source: request.source,
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


            const cycleStartedSuspended = options.isSuspended?.() ?? false;

            const suspension = request.source === 'manual'
                ? null
                : await options.syncEncryptionSuspension?.() ?? null;
            if (suspension) {
                trace('Auto sync run skipped', { source: request.source, reason: 'encryption-suspended' });
                trace(
                    suspension === 'remote-plaintext'
                        ? 'Auto sync suppressed while this device is encrypted and the remote is not'
                        : 'Auto sync suppressed while the remote is encrypted and unreadable',
                    { source: request.source, state: suspension },
                );
                return;
            }

            if (options.canSync && !(await options.canSync())) {
                trace('Auto sync run skipped', { source: request.source, reason: 'backend-unavailable' });
                return;
            }

            lastAutoSyncAt = nowMs;

            const cycleCarriesLocalChange = !!adaptivePacing && (options.hasPendingLocalChanges?.() ?? false);
            trace('Auto sync run start', {
                source: request.source,
                minIntervalMs: String(effectiveMinIntervalMs),
            });
            await options.flushPendingSave().catch((error) => options.reportError('Save failed', error));

            const result = await options.performSync();
            lastCycleCarriedLocalChange = cycleCarriesLocalChange;
            trace('Auto sync run complete', {
                source: request.source,
                success: String(result.success),
                error: result.error ?? '',
            });
            const ignorableFailure = result.success
                ? false
                : (options.isIgnorableFailure?.(result.error) ?? false);
            if (result.success) {
                autoSyncRetryAfter = 0;
                consecutiveAutoSyncFailures = 0;


                clearSyncThrottle();
            } else if (!ignorableFailure) {


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


                    requestedWhileSuspended = false;
                    autoSyncOrchestrator.clearFollowUp();
                } else if (allowDeferredWork && autoSyncOrchestrator.getState().queued) {
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
        if (!allowDeferredWork && autoSyncOrchestrator.getState().inFlight) return;
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
        if (!options.isRuntimeActive()) {
            trace('Auto sync run skipped', { source, reason: 'inactive' });
            return;
        }
        if (!allowDeferredWork && autoSyncOrchestrator.getState().inFlight) return;
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
            if (!allowDeferredWork || !canRunWindowSync()) return;
            const nowMs = now();
            if (nowMs - lastFocusTriggerAt < FOCUS_TRIGGER_DEDUPE_MS) return;
            if (nowMs - lastAutoSyncAt > focusMinIntervalMs) {
                lastFocusTriggerAt = nowMs;
                trace('Auto sync trigger', { source: 'focus' });
                void requestAutoSync(undefined, 'focus').catch((error) => options.reportError('Sync failed', error));
            }
        },
        handleBlur: () => {
            if (!allowDeferredWork || !shouldRunBlurSync()) return;
            trace('Auto sync trigger', { source: 'blur' });
            void requestAutoSync(undefined, 'blur').catch((error) => options.reportError('Sync failed', error));
        },
        handleDataChange: () => {
            if (!allowDeferredWork || !options.isRuntimeActive()) return;
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
            if (!allowDeferredWork) return;
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
