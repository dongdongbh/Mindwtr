import { useCallback, useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, type AppStateStatus, Platform } from 'react-native';

import { flushPendingSave, getInMemorySyncChangeFingerprint, hasActiveMobileNotificationFeature, nameNotifyListener, resolveSyncFailureCooldownMs, useTaskStore } from '@mindwtr/core';

import type { ToastOptions } from '@/contexts/toast-context';
import { getNotificationPermissionStatus, startMobileNotifications, stopMobileNotifications } from '@/lib/notification-service';
import { getCalendarPushEnabled, runFullCalendarSync, startCalendarPushSync, stopCalendarPushSync } from '@/lib/calendar-push-sync';
import { abortMobileSync, performMobileSync } from '@/lib/sync-service';
import { syncMobileBackgroundSyncRegistration } from '@/lib/background-sync-task';
import { classifySyncFailure, coerceSupportedBackend, isLikelyOfflineSyncError, resolveBackend, type SyncBackend } from '@/lib/sync-service-utils';
import { SYNC_BACKEND_KEY } from '@/lib/sync-constants';
import { isCloudKitAvailable, subscribeToCloudKitChanges } from '@/lib/cloudkit-sync';
import { updateMobileWidgetFromStore } from '@/lib/widget-service';
import { logError, logWarn } from '@/lib/app-log';

type ResolveText = (key: string, fallback: string) => string;

type UseRootLayoutSyncEffectsParams = {
    resolveText: ResolveText;
    openNotificationsSettings: () => void;
    openSyncSettings: () => void;
    showToast: (options: ToastOptions) => void;
};

type AutoSyncCadence = {
    minIntervalMs: number;
    debounceFirstChangeMs: number;
    debounceContinuousChangeMs: number;
    foregroundMinIntervalMs: number;
};

type SyncUiCopy = {
    notificationsDisabledMessage: string;
    notificationsDisabledTitle: string;
    openActionLabel: string;
    syncIssueAuthMessage: string;
    syncIssueConflictMessage: string;
    syncIssueEncryptionMessage: string;
    syncIssueEncryptionStateMessage: string;
    syncIssueFileLockUnavailableMessage: string;
    syncIssueGenericMessage: string;
    syncIssueMisconfiguredMessage: string;
    syncIssuePermissionMessage: string;
    syncIssueRateLimitedMessage: string;
    syncIssueTitle: string;
};

const AUTO_SYNC_BACKEND_CACHE_TTL_MS = 5_000;
const APP_STATE_TRIGGER_DEDUPE_MS = 1_000;
// Auto-sync pacing adapts to how long cycles actually take on this device/dataset:
// period = cycle duration T + idle gap, and share = T / period is the fraction of
// time sync occupies the JS thread. Gap = 9T (capped) makes period = 10T, so a
// continuously-editing device spends ~10% of its time syncing instead of ~33%
// at gap = 2T (#766).
const ADAPTIVE_SYNC_DURATION_MULTIPLIER = 9;
const MAX_ADAPTIVE_SYNC_INTERVAL_MS = 5 * 60_000;
// Same base and ceiling as the desktop auto-sync controller.
const AUTO_SYNC_FAILURE_COOLDOWN_MS = 60_000;
const MAX_AUTO_SYNC_FAILURE_COOLDOWN_MS = 10 * 60_000;
const AUTO_SYNC_CADENCE_FILE: AutoSyncCadence = {
    minIntervalMs: 30_000,
    debounceFirstChangeMs: 8_000,
    debounceContinuousChangeMs: 15_000,
    foregroundMinIntervalMs: 45_000,
};
const AUTO_SYNC_CADENCE_REMOTE: AutoSyncCadence = {
    minIntervalMs: 5_000,
    debounceFirstChangeMs: 2_000,
    debounceContinuousChangeMs: 5_000,
    foregroundMinIntervalMs: 30_000,
};
const AUTO_SYNC_CADENCE_OFF: AutoSyncCadence = {
    minIntervalMs: 60_000,
    debounceFirstChangeMs: 15_000,
    debounceContinuousChangeMs: 30_000,
    foregroundMinIntervalMs: 60_000,
};

const buildSyncUiCopy = (resolveText: ResolveText): SyncUiCopy => ({
    syncIssueTitle: resolveText('settings.syncBadgeWarning', 'Sync issue'),
    syncIssueGenericMessage: resolveText('settings.syncFailureGeneric', 'Review Settings → Sync and try again.'),
    syncIssueAuthMessage: resolveText('settings.syncFailureAuth', 'Re-authenticate or review your sync credentials in Settings → Sync.'),
    syncIssuePermissionMessage: resolveText('settings.syncFailurePermission', 'Re-select the sync file or folder, or grant access again in Settings → Sync.'),
    syncIssueRateLimitedMessage: resolveText('settings.syncFailureRateLimited', 'The sync backend is rate limiting requests. Wait a moment and try again.'),
    syncIssueMisconfiguredMessage: resolveText('settings.syncFailureMisconfigured', 'Finish configuring the selected sync backend in Settings → Sync.'),
    syncIssueConflictMessage: resolveText('settings.syncFailureConflict', 'Another device or backend reported a sync conflict. Retry after both sides finish syncing.'),
    syncIssueEncryptionMessage: resolveText('settings.syncFailureEncryption', 'This sync location is encrypted. Enter its passphrase in Settings → Sync to continue.'),
    syncIssueEncryptionStateMessage: resolveText('settings.syncEncryptionStateUnavailable', 'Sync stopped because this device could not read its local encryption state. Restart Mindwtr and try again. If the problem continues, reconnect this sync location before syncing.'),
    syncIssueFileLockUnavailableMessage: resolveText('settings.syncFileLockUnavailable', 'Mindwtr cannot safely lock this File Sync location. Re-select the folder, restart or update Mindwtr, or use WebDAV.'),
    notificationsDisabledTitle: resolveText('settings.notificationsDisabled', 'Notifications disabled'),
    notificationsDisabledMessage: resolveText('settings.notificationsDisabledMessage', 'Mindwtr can no longer schedule reminders until notification access is restored.'),
    openActionLabel: resolveText('common.open', 'Open'),
});

const getCadenceForBackend = (backend: SyncBackend): AutoSyncCadence => {
    if (backend === 'file') return AUTO_SYNC_CADENCE_FILE;
    if (backend === 'webdav' || backend === 'cloud' || backend === 'cloudkit') return AUTO_SYNC_CADENCE_REMOTE;
    return AUTO_SYNC_CADENCE_OFF;
};

const supportsNativeICloudSync = (): boolean =>
    Platform.OS === 'ios' && isCloudKitAvailable();

const logAppError = (error: unknown) => {
    void logError(error, { scope: 'app' });
};

const reconcileBackgroundSyncTask = () => {
    void syncMobileBackgroundSyncRegistration().catch(logAppError);
};

export function useRootLayoutSyncEffects({
    resolveText,
    openNotificationsSettings,
    openSyncSettings,
    showToast,
}: UseRootLayoutSyncEffectsParams) {
    const appState = useRef(AppState.currentState);
    const lastAutoSyncAt = useRef(0);
    const lastSyncDurationMs = useRef(0);
    const syncDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const syncThrottleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const widgetRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const syncInFlight = useRef<Promise<void> | null>(null);
    const syncPending = useRef(false);
    const backgroundSyncPending = useRef(false);
    const isActive = useRef(true);
    const lastLoggedAutoSyncError = useRef<string | null>(null);
    const lastLoggedAutoSyncErrorAt = useRef(0);
    const autoSyncRetryAfter = useRef(0);
    const consecutiveSyncFailures = useRef(0);
    const notificationPermissionWarningShown = useRef(false);
    const syncCadenceRef = useRef<AutoSyncCadence>(AUTO_SYNC_CADENCE_REMOTE);
    const syncBackendCacheRef = useRef<{ backend: SyncBackend; readAt: number }>({
        backend: 'off',
        readAt: 0,
    });
    const lastAutoSyncPayloadFingerprint = useRef<string | null>(null);
    const lastAppStateSyncTriggerAt = useRef(-APP_STATE_TRIGGER_DEDUPE_MS);
    const showToastRef = useRef(showToast);
    const openSyncSettingsRef = useRef(openSyncSettings);
    const openNotificationsSettingsRef = useRef(openNotificationsSettings);
    const syncUiCopyRef = useRef<SyncUiCopy>(buildSyncUiCopy(resolveText));

    useEffect(() => {
        showToastRef.current = showToast;
    }, [showToast]);

    useEffect(() => {
        openSyncSettingsRef.current = openSyncSettings;
    }, [openSyncSettings]);

    useEffect(() => {
        openNotificationsSettingsRef.current = openNotificationsSettings;
    }, [openNotificationsSettings]);

    useEffect(() => {
        syncUiCopyRef.current = buildSyncUiCopy(resolveText);
    }, [resolveText]);

    const refreshSyncCadence = useCallback(async (): Promise<AutoSyncCadence> => {
        const now = Date.now();
        const cached = syncBackendCacheRef.current;
        if (now - cached.readAt <= AUTO_SYNC_BACKEND_CACHE_TTL_MS) {
            syncCadenceRef.current = getCadenceForBackend(cached.backend);
            return syncCadenceRef.current;
        }
        const rawBackend = await AsyncStorage.getItem(SYNC_BACKEND_KEY);
        const backend = coerceSupportedBackend(resolveBackend(rawBackend), supportsNativeICloudSync());
        syncBackendCacheRef.current = { backend, readAt: now };
        syncCadenceRef.current = getCadenceForBackend(backend);
        return syncCadenceRef.current;
    }, []);

    // Device-local bookkeeping (lastSync*, pendingRemoteWrite*, network) is not
    // part of a sync payload, so the change fingerprint ignores it for free —
    // no separate strip pass needed.
    const readCurrentSyncChangeFingerprint = useCallback((): string | null => {
        try {
            return getInMemorySyncChangeFingerprint();
        } catch (error) {
            logAppError(error);
            return null;
        }
    }, []);

    const shouldDedupeAppStateSyncTrigger = useCallback((now: number): boolean => {
        const currentFingerprint = readCurrentSyncChangeFingerprint();
        const previousFingerprint = lastAutoSyncPayloadFingerprint.current;
        if (currentFingerprint) {
            lastAutoSyncPayloadFingerprint.current = currentFingerprint;
        }
        if (!currentFingerprint || !previousFingerprint || currentFingerprint !== previousFingerprint) {
            return false;
        }
        return now - lastAppStateSyncTriggerAt.current < APP_STATE_TRIGGER_DEDUPE_MS;
    }, [readCurrentSyncChangeFingerprint]);

    const markAppStateSyncTrigger = useCallback((now: number) => {
        lastAppStateSyncTriggerAt.current = now;
    }, []);

    const clearSyncThrottleTimer = useCallback(() => {
        if (!syncThrottleTimer.current) return;
        clearTimeout(syncThrottleTimer.current);
        syncThrottleTimer.current = null;
    }, []);

    const runSync = useCallback((minIntervalMs?: number) => {
        const requestedMinIntervalMs = typeof minIntervalMs === 'number'
            ? minIntervalMs
            : syncCadenceRef.current.minIntervalMs;
        // Explicit 0 (manual sync, app-state transitions) bypasses pacing entirely;
        // auto triggers stretch the interval when cycles run long on this device.
        const effectiveMinIntervalMs = requestedMinIntervalMs > 0
            ? Math.max(
                requestedMinIntervalMs,
                Math.min(lastSyncDurationMs.current * ADAPTIVE_SYNC_DURATION_MULTIPLIER, MAX_ADAPTIVE_SYNC_INTERVAL_MS),
            )
            : requestedMinIntervalMs;
        if (!isActive.current) return;
        if (syncInFlight.current && appState.current !== 'active') {
            backgroundSyncPending.current = true;
            syncPending.current = true;
            return;
        }
        if (syncInFlight.current) {
            return;
        }
        // A failed cycle parks the automatic triggers until its cooldown expires,
        // so a CloudKit throttle is not met with another request on the next
        // debounce. Pending edits stay queued and the timer below retries once.
        // Every trigger here is automatic — app-state changes, CloudKit change
        // notifications, startup — so every one of them waits. Exempting the
        // explicit-0 callers let a throttled device fire again on the very next
        // foreground/background switch, which is how testing across two devices
        // stayed stuck (#948). The user-facing Sync now button does not come
        // through here; it calls performMobileSync directly and still forces a
        // run. This matches the desktop controller, where only `manual` sets
        // bypassFailureCooldown.
        if (Date.now() < autoSyncRetryAfter.current) {
            if (!syncThrottleTimer.current) {
                const waitMs = Math.max(0, autoSyncRetryAfter.current - Date.now());
                syncThrottleTimer.current = setTimeout(() => {
                    syncThrottleTimer.current = null;
                    runSync(0);
                }, waitMs);
            }
            return;
        }
        const now = Date.now();
        if (now - lastAutoSyncAt.current < effectiveMinIntervalMs) {
            if (!syncThrottleTimer.current) {
                const waitMs = Math.max(0, effectiveMinIntervalMs - (now - lastAutoSyncAt.current));
                syncThrottleTimer.current = setTimeout(() => {
                    syncThrottleTimer.current = null;
                    runSync(0);
                }, waitMs);
            }
            return;
        }
        lastAutoSyncAt.current = now;
        syncPending.current = false;

        const syncStartedAt = now;
        const appStateAtSyncStart = appState.current;
        syncInFlight.current = (async () => {
            await flushPendingSave().catch(logAppError);
            const result = await performMobileSync().catch((error) => ({ success: false, error: String(error) }));
            if (result.success) {
                autoSyncRetryAfter.current = 0;
                consecutiveSyncFailures.current = 0;
                // A successful automatic cycle satisfies the pending work.
                clearSyncThrottleTimer();
            }
            if (!result.success && result.error) {
                if (isLikelyOfflineSyncError(result.error)) {
                    return;
                }
                // Honour the delay CloudKit asked for (CKErrorRetryAfterKey);
                // otherwise back off from the same base the desktop uses (#948).
                consecutiveSyncFailures.current += 1;
                autoSyncRetryAfter.current = Date.now() + resolveSyncFailureCooldownMs({
                    error: result.error,
                    consecutiveFailures: consecutiveSyncFailures.current,
                    baseMs: AUTO_SYNC_FAILURE_COOLDOWN_MS,
                    maxMs: MAX_AUTO_SYNC_FAILURE_COOLDOWN_MS,
                });
                // This timer is shared with ordinary pacing. A failure takes
                // ownership immediately and a later failure replaces it with
                // the newly-grown deadline, so no lifecycle trigger is needed.
                clearSyncThrottleTimer();
                const retryWaitMs = Math.max(0, autoSyncRetryAfter.current - Date.now());
                syncThrottleTimer.current = setTimeout(() => {
                    syncThrottleTimer.current = null;
                    runSync(0);
                }, retryWaitMs);
                const nowMs = Date.now();
                const shouldLog = result.error !== lastLoggedAutoSyncError.current
                    || nowMs - lastLoggedAutoSyncErrorAt.current > 10 * 60 * 1000;
                if (shouldLog) {
                    lastLoggedAutoSyncError.current = result.error;
                    lastLoggedAutoSyncErrorAt.current = nowMs;
                    void logWarn('Auto-sync failed', {
                        scope: 'sync',
                        extra: { error: result.error },
                    });
                    const uiCopy = syncUiCopyRef.current;
                    const syncIssueMessage = (() => {
                        switch (classifySyncFailure(result.error)) {
                            case 'auth':
                                return uiCopy.syncIssueAuthMessage;
                            case 'permission':
                                return uiCopy.syncIssuePermissionMessage;
                            case 'rateLimited':
                                return uiCopy.syncIssueRateLimitedMessage;
                            case 'misconfigured':
                                return uiCopy.syncIssueMisconfiguredMessage;
                            case 'conflict':
                                return uiCopy.syncIssueConflictMessage;
                            case 'encryptionState':
                                return uiCopy.syncIssueEncryptionStateMessage;
                            case 'encryption':
                                return uiCopy.syncIssueEncryptionMessage;
                            case 'fileLockUnavailable':
                                return uiCopy.syncIssueFileLockUnavailableMessage;
                            default:
                                return uiCopy.syncIssueGenericMessage;
                        }
                    })();
                    showToastRef.current({
                        title: uiCopy.syncIssueTitle,
                        message: syncIssueMessage,
                        tone: 'warning',
                        durationMs: 5200,
                        actionLabel: uiCopy.openActionLabel,
                        onAction: () => {
                            openSyncSettingsRef.current();
                        },
                    });
                }
            }
        })().finally(() => {
            syncInFlight.current = null;
            // Measure the pacing interval from cycle END: a cycle that runs longer
            // than the interval must not roll straight into the next one (#766).
            lastSyncDurationMs.current = Date.now() - syncStartedAt;
            lastAutoSyncAt.current = Date.now();
            if (appStateAtSyncStart !== 'active' && backgroundSyncPending.current) {
                backgroundSyncPending.current = false;
                syncPending.current = true;
                return;
            }
            if (syncPending.current && isActive.current) {
                runSync(syncCadenceRef.current.minIntervalMs);
            }
        });
    }, [clearSyncThrottleTimer]);

    const requestSync = useCallback((minIntervalMs?: number) => {
        syncPending.current = true;
        if (typeof minIntervalMs === 'number') {
            runSync(minIntervalMs);
            return;
        }
        void refreshSyncCadence()
            .then((cadence) => runSync(cadence.minIntervalMs))
            .catch(logAppError);
    }, [refreshSyncCadence, runSync]);

    useEffect(() => {
        void refreshSyncCadence().catch(logAppError);
        reconcileBackgroundSyncTask();
        lastAutoSyncPayloadFingerprint.current = readCurrentSyncChangeFingerprint();
        const unsubscribe = useTaskStore.subscribe(nameNotifyListener('auto-sync-trigger', (state, prevState) => {
            const currentSyncStatus = state.settings?.lastSyncStatus;
            const previousSyncStatus = prevState.settings?.lastSyncStatus;
            const syncCompleted = currentSyncStatus === 'success' || currentSyncStatus === 'conflict';
            if (
                syncCompleted
                && (
                    currentSyncStatus !== previousSyncStatus
                    || state.settings?.lastSyncAt !== prevState.settings?.lastSyncAt
                )
            ) {
                // Manual sync bypasses this hook, but its successful status
                // update must still cancel an automatic retry left by a prior
                // failure.
                autoSyncRetryAfter.current = 0;
                consecutiveSyncFailures.current = 0;
                clearSyncThrottleTimer();
            }
            // Cheap check first: the fingerprint reads a small tuple digest, not the
            // whole dataset, but it still must not run on every store update (#766).
            // Data writes always bump lastDataChangeAt, so skipping the fingerprint
            // here is safe.
            if (state.lastDataChangeAt === prevState.lastDataChangeAt) return;
            const cadence = syncCadenceRef.current;
            const hadTimer = !!syncDebounceTimer.current;
            if (syncDebounceTimer.current) {
                clearTimeout(syncDebounceTimer.current);
            }
            const debounceMs = hadTimer ? cadence.debounceContinuousChangeMs : cadence.debounceFirstChangeMs;
            syncDebounceTimer.current = setTimeout(() => {
                if (!isActive.current) return;
                // The fingerprint dedupe runs here, once per quiet period, so a burst
                // of edits pays for the tuple digest once instead of on every write
                // (#766).
                const currentFingerprint = readCurrentSyncChangeFingerprint();
                const previousFingerprint = lastAutoSyncPayloadFingerprint.current;
                if (currentFingerprint) {
                    lastAutoSyncPayloadFingerprint.current = currentFingerprint;
                }
                if (currentFingerprint && previousFingerprint && currentFingerprint === previousFingerprint) return;
                requestSync();
            }, debounceMs);
        }));

        return () => {
            unsubscribe();
            if (syncDebounceTimer.current) {
                clearTimeout(syncDebounceTimer.current);
            }
            clearSyncThrottleTimer();
        };
    }, [clearSyncThrottleTimer, readCurrentSyncChangeFingerprint, requestSync, refreshSyncCadence]);

    useEffect(() => {
        const handleAppStateChange = (nextAppState: AppStateStatus) => {
            if (!isActive.current) return;
            const previousState = appState.current;
            const wasInactiveOrBackground = previousState === 'inactive' || previousState === 'background';
            const nextInactiveOrBackground = nextAppState === 'inactive' || nextAppState === 'background';
            if (wasInactiveOrBackground && nextAppState === 'active') {
                reconcileBackgroundSyncTask();
                if (backgroundSyncPending.current) {
                    backgroundSyncPending.current = false;
                    requestSync(0);
                } else {
                    void refreshSyncCadence()
                        .then((cadence) => {
                            const now = Date.now();
                            if (now - lastAutoSyncAt.current > cadence.foregroundMinIntervalMs) {
                                if (shouldDedupeAppStateSyncTrigger(now)) return;
                                markAppStateSyncTrigger(now);
                                requestSync(0);
                            }
                        })
                        .catch(logAppError);
                }
                updateMobileWidgetFromStore().catch(logAppError);
                if (widgetRefreshTimer.current) {
                    clearTimeout(widgetRefreshTimer.current);
                }
                widgetRefreshTimer.current = setTimeout(() => {
                    if (!isActive.current) return;
                    updateMobileWidgetFromStore().catch(logAppError);
                }, 800);
                if (Platform.OS === 'android' && hasActiveMobileNotificationFeature(useTaskStore.getState().settings)) {
                    getNotificationPermissionStatus()
                        .then((permission) => {
                            if (!isActive.current) return;
                            if (!permission.granted) {
                                stopMobileNotifications().catch(logAppError);
                                if (!notificationPermissionWarningShown.current) {
                                    notificationPermissionWarningShown.current = true;
                                    const uiCopy = syncUiCopyRef.current;
                                    showToastRef.current({
                                        title: uiCopy.notificationsDisabledTitle,
                                        message: uiCopy.notificationsDisabledMessage,
                                        tone: 'warning',
                                        durationMs: 5200,
                                        actionLabel: uiCopy.openActionLabel,
                                        onAction: () => {
                                            openNotificationsSettingsRef.current();
                                        },
                                    });
                                }
                                return;
                            }
                            notificationPermissionWarningShown.current = false;
                            startMobileNotifications().catch(logAppError);
                        })
                        .catch(logAppError);
                }
            }
            if (previousState === 'active' && nextInactiveOrBackground) {
                reconcileBackgroundSyncTask();
                if (syncDebounceTimer.current) {
                    clearTimeout(syncDebounceTimer.current);
                    syncDebounceTimer.current = null;
                }
                // Normal pacing should not block the background attempt, but a
                // failure retry must keep its owned deadline even if this
                // lifecycle transition is deduped.
                if (autoSyncRetryAfter.current === 0) {
                    clearSyncThrottleTimer();
                }
                abortMobileSync();
                const now = Date.now();
                if (!shouldDedupeAppStateSyncTrigger(now)) {
                    markAppStateSyncTrigger(now);
                    requestSync(0);
                }
            }
            appState.current = nextAppState;
        };

        const subscription = AppState.addEventListener('change', handleAppStateChange);
        const unsubscribeCloudKit = subscribeToCloudKitChanges(() => {
            requestSync(0);
        });

        return () => {
            subscription?.remove();
            unsubscribeCloudKit();
            isActive.current = false;
            if (syncDebounceTimer.current) {
                clearTimeout(syncDebounceTimer.current);
            }
            clearSyncThrottleTimer();
            if (widgetRefreshTimer.current) {
                clearTimeout(widgetRefreshTimer.current);
            }
            syncInFlight.current = null;
            flushPendingSave().catch(logAppError);
        };
    }, [
        clearSyncThrottleTimer,
        markAppStateSyncTrigger,
        refreshSyncCadence,
        requestSync,
        shouldDedupeAppStateSyncTrigger,
    ]);

    useEffect(() => {
        let previousEnabled = hasActiveMobileNotificationFeature(useTaskStore.getState().settings);
        const unsubscribe = useTaskStore.subscribe(nameNotifyListener('notification-feature-watcher', (state) => {
            const enabled = hasActiveMobileNotificationFeature(state.settings);
            if (enabled === previousEnabled) return;
            previousEnabled = enabled;

            if (enabled === false) {
                stopMobileNotifications().catch(logAppError);
            } else {
                startMobileNotifications().catch(logAppError);
            }
        }));

        return () => unsubscribe();
    }, []);

    // Start calendar push sync on mount if enabled; stop on unmount.
    useEffect(() => {
        let stopSync: (() => void) | null = null;
        void getCalendarPushEnabled().then((enabled) => {
            if (!enabled) return;
            stopSync = startCalendarPushSync();
            void runFullCalendarSync();
        });
        return () => {
            stopSync?.();
            stopCalendarPushSync();
        };
    }, []);

    return { requestSync };
}
