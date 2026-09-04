import { useCallback, useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, type AppStateStatus, Platform } from 'react-native';

import { createAutoSyncController, flushPendingSave, getInMemorySyncChangeFingerprint, hasActiveMobileNotificationFeature, nameNotifyListener, useTaskStore, type AutoSyncController } from '@mindwtr/core';

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
    const widgetRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isActive = useRef(true);
    const lastLoggedAutoSyncError = useRef<string | null>(null);
    const lastLoggedAutoSyncErrorAt = useRef(0);
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
    const controllerRef = useRef<AutoSyncController | null>(null);

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

    const reportAutoSyncFailure = useCallback((error: string) => {
        const nowMs = Date.now();
        const shouldLog = error !== lastLoggedAutoSyncError.current
            || nowMs - lastLoggedAutoSyncErrorAt.current > 10 * 60 * 1000;
        if (!shouldLog) return;
        lastLoggedAutoSyncError.current = error;
        lastLoggedAutoSyncErrorAt.current = nowMs;
        void logWarn('Auto-sync failed', {
            scope: 'sync',
            extra: { error },
        });
        const uiCopy = syncUiCopyRef.current;
        const syncIssueMessage = (() => {
            switch (classifySyncFailure(error)) {
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
    }, []);

    // One controller for the life of the hook: the shared pacing machine in core,
    // configured with the mobile policy switches. Everything the controller does
    // not own — the payload fingerprint, AppState wiring, the per-backend cadence
    // read, widget and notification recomputes — stays here.
    const getController = useCallback((): AutoSyncController => {
        if (controllerRef.current) return controllerRef.current;
        controllerRef.current = createAutoSyncController({
            // A rejected cycle must reach the failure cooldown like any other
            // failed one, so the throw is converted here rather than propagated.
            performSync: () => performMobileSync().catch((error) => ({ success: false, error: String(error) })),
            flushPendingSave,
            reportError: (_label, error) => logAppError(error),
            isRuntimeActive: () => isActive.current,
            onSyncFailure: reportAutoSyncFailure,
            // Being offline is not a backend refusing us: no cooldown, no toast.
            // A failure with no message carries nothing to back off from either.
            isIgnorableFailure: (error) => !error || isLikelyOfflineSyncError(error),
            getCadence: () => syncCadenceRef.current,
            refreshCadence: refreshSyncCadence,
            // The fingerprint runs once per quiet period, not per write (#766).
            shouldSyncOnDebouncedChange: () => {
                const currentFingerprint = readCurrentSyncChangeFingerprint();
                const previousFingerprint = lastAutoSyncPayloadFingerprint.current;
                if (currentFingerprint) {
                    lastAutoSyncPayloadFingerprint.current = currentFingerprint;
                }
                return !(currentFingerprint && previousFingerprint && currentFingerprint === previousFingerprint);
            },
            adaptivePacing: {
                durationMultiplier: ADAPTIVE_SYNC_DURATION_MULTIPLIER,
                maxIntervalMs: MAX_ADAPTIVE_SYNC_INTERVAL_MS,
            },
            isSuspended: () => appState.current !== 'active',
            // Both preserve mobile's existing pacing exactly: the first-change
            // debounce applies once per foreground session, and a throttle or
            // cooldown retry that a newer cycle already overtook is dropped.
            continuousDebounceUntilSuspend: true,
            skipRetryWhileCycleRunning: true,
            autoFailureCooldownMs: AUTO_SYNC_FAILURE_COOLDOWN_MS,
            maxFailureCooldownMs: MAX_AUTO_SYNC_FAILURE_COOLDOWN_MS,
            // No foreground heartbeat on mobile; background sync is a platform job
            // (`background-sync-task.ts`), never a JS timer.
            periodicSyncIntervalMs: null,
        });
        return controllerRef.current;
    }, [reportAutoSyncFailure, readCurrentSyncChangeFingerprint, refreshSyncCadence]);

    // Every trigger routed through here is automatic — app-state changes, CloudKit
    // change notifications, startup — so every one of them waits out a failure
    // cooldown. Exempting them let a throttled device fire again on the very next
    // foreground/background switch, which is how testing across two devices stayed
    // stuck (#948). The user-facing Sync now button does not come through here; it
    // calls performMobileSync directly and still forces a run.
    const requestSync = useCallback((minIntervalMs?: number) => {
        const controller = getController();
        if (typeof minIntervalMs === 'number') {
            void controller.requestAutoSync(minIntervalMs, 'external').catch(logAppError);
            return;
        }
        void refreshSyncCadence()
            .then(() => controller.requestAutoSync(undefined, 'external'))
            .catch(logAppError);
    }, [getController, refreshSyncCadence]);

    useEffect(() => {
        const controller = getController();
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
                controller.notifyExternalSyncSuccess();
            }
            // Cheap check first: the fingerprint reads a small tuple digest, not the
            // whole dataset, but it still must not run on every store update (#766).
            // Data writes always bump lastDataChangeAt, so skipping the fingerprint
            // here is safe.
            if (state.lastDataChangeAt === prevState.lastDataChangeAt) return;
            controller.handleDataChange();
        }));

        return () => {
            unsubscribe();
        };
    }, [getController, readCurrentSyncChangeFingerprint, refreshSyncCadence]);

    useEffect(() => {
        const controller = getController();
        const handleAppStateChange = (nextAppState: AppStateStatus) => {
            if (!isActive.current) return;
            const previousState = appState.current;
            const wasInactiveOrBackground = previousState === 'inactive' || previousState === 'background';
            const nextInactiveOrBackground = nextAppState === 'inactive' || nextAppState === 'background';
            if (wasInactiveOrBackground && nextAppState === 'active') {
                reconcileBackgroundSyncTask();
                if (controller.takePendingSuspendedRequest()) {
                    void controller.requestAutoSync(0, 'app-state-resume').catch(logAppError);
                } else {
                    void refreshSyncCadence()
                        .then((cadence) => {
                            const now = Date.now();
                            if (now - controller.getLastAutoSyncAt() > cadence.foregroundMinIntervalMs) {
                                if (shouldDedupeAppStateSyncTrigger(now)) return;
                                markAppStateSyncTrigger(now);
                                void controller.requestAutoSync(0, 'app-state-active').catch(logAppError);
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
                controller.handleSuspend();
                abortMobileSync();
                const now = Date.now();
                if (!shouldDedupeAppStateSyncTrigger(now)) {
                    markAppStateSyncTrigger(now);
                    void controller.requestAutoSync(0, 'app-state-background').catch(logAppError);
                }
            }
            appState.current = nextAppState;
        };

        const subscription = AppState.addEventListener('change', handleAppStateChange);
        const unsubscribeCloudKit = subscribeToCloudKitChanges(() => {
            void controller.requestAutoSync(0, 'cloudkit').catch(logAppError);
        });

        return () => {
            subscription?.remove();
            unsubscribeCloudKit();
            isActive.current = false;
            controller.dispose();
            controllerRef.current = null;
            if (widgetRefreshTimer.current) {
                clearTimeout(widgetRefreshTimer.current);
            }
            flushPendingSave().catch(logAppError);
        };
    }, [
        getController,
        markAppStateSyncTrigger,
        refreshSyncCadence,
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
