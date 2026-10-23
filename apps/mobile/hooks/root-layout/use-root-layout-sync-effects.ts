import { useCallback, useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, type AppStateStatus, Platform } from 'react-native';

import { flushPendingSave, getInMemorySyncChangeFingerprint, hasActiveMobileNotificationFeature, nameNotifyListener, useTaskStore } from '@mindwtr/core';
import { createMobileSyncTriggers, type MobileSyncTriggers } from '@mindwtr/core/mobile-sync-triggers';

import type { ToastOptions } from '@/contexts/toast-context';
import { getNotificationPermissionStatus, startMobileNotifications, stopMobileNotifications } from '@/lib/notification-service';
import { getCalendarPushEnabled, runFullCalendarSync, startCalendarPushSync, stopCalendarPushSync } from '@/lib/calendar-push-sync';
import { abortMobileSync, performMobileSync, waitForMobileSyncIdle } from '@/lib/sync-service';
import { syncMobileBackgroundSyncRegistration } from '@/lib/background-sync-task';
import { classifySyncFailure, coerceSupportedBackend, isLikelyOfflineSyncError, resolveBackend } from '@/lib/sync-service-utils';
import { SYNC_BACKEND_KEY } from '@/lib/sync-constants';
import { isCloudKitAvailable, subscribeToCloudKitChanges } from '@/lib/cloudkit-sync';
import { updateMobileWidgetFromStore } from '@/lib/widget-service';
import { logError, logInfo, logWarn } from '@/lib/app-log';
import { setMobileLocalChangePending } from '@/lib/sync-badge';
import { beginIosBackgroundTask } from '@/modules/ios-scene-lifecycle';

type ResolveText = (key: string, fallback: string) => string;

type UseRootLayoutSyncEffectsParams = {
    disabled?: boolean;
    resolveText: ResolveText;
    openNotificationsSettings: () => void;
    openSyncSettings: () => void;
    showToast: (options: ToastOptions) => void;
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

const supportsNativeICloudSync = (): boolean =>
    Platform.OS === 'ios' && isCloudKitAvailable();

const logAppError = (error: unknown) => {
    void logError(error, { scope: 'app' });
};

const reconcileBackgroundSyncTask = () => {
    void syncMobileBackgroundSyncRegistration().catch(logAppError);
};

export function useRootLayoutSyncEffects({
    disabled = false,
    resolveText,
    openNotificationsSettings,
    openSyncSettings,
    showToast,
}: UseRootLayoutSyncEffectsParams) {
    const appStateAtMount = useRef(AppState.currentState);
    const widgetRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const notificationPermissionWarningShown = useRef(false);
    const showToastRef = useRef(showToast);
    const openSyncSettingsRef = useRef(openSyncSettings);
    const openNotificationsSettingsRef = useRef(openNotificationsSettings);
    const syncUiCopyRef = useRef<SyncUiCopy>(buildSyncUiCopy(resolveText));
    const triggersRef = useRef<MobileSyncTriggers | null>(null);

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

    const showSyncIssue = useCallback((classification: string) => {
        const uiCopy = syncUiCopyRef.current;
        const syncIssueMessage = (() => {
            switch (classification) {
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

    // The trigger rules live in core (mobile-sync-triggers.ts) with the shared pacing machine;
    // one instance for the life of the hook. Everything they do not own — AppState and store
    // wiring, widget and notification recomputes, the toast copy — stays here.
    const getTriggers = useCallback((): MobileSyncTriggers => {
        triggersRef.current ??= createMobileSyncTriggers({
            initialAppState: appStateAtMount.current,
            performSync: () => performMobileSync(),
            abortSync: () => abortMobileSync(),
            flushPendingSave: () => flushPendingSave(),
            reconcileBackgroundSync: reconcileBackgroundSyncTask,
            readStoredBackend: () => AsyncStorage.getItem(SYNC_BACKEND_KEY),
            resolveSupportedBackend: (rawBackend) => coerceSupportedBackend(resolveBackend(rawBackend), supportsNativeICloudSync()),
            getSyncChangeFingerprint: () => getInMemorySyncChangeFingerprint(),
            isLikelyOfflineSyncError: (error) => isLikelyOfflineSyncError(error),
            classifySyncFailure: (error) => classifySyncFailure(error),
            reportError: logAppError,
            logWarn: (message, context) => logWarn(message, context),
            logInfo: (message, context) => logInfo(message, context),
            onLocalChangePendingChange: setMobileLocalChangePending,
            showSyncIssue,
            // iOS only: null elsewhere, so Android keeps its behavior.
            holdBackgroundExecution: (onExpire) => beginIosBackgroundTask('Mindwtr sync', onExpire),
            waitForSyncIdle: () => waitForMobileSyncIdle(),
        });
        return triggersRef.current;
    }, [showSyncIssue]);

    const requestSync = useCallback((minIntervalMs?: number) => {
        if (disabled) return;
        getTriggers().requestSync(minIntervalMs);
    }, [disabled, getTriggers]);

    useEffect(() => {
        if (disabled) return undefined;
        const triggers = getTriggers();
        triggers.start();
        const unsubscribe = useTaskStore.subscribe(nameNotifyListener('auto-sync-trigger', (state, prevState) => {
            triggers.handleStoreChange(state, prevState);
        }));

        return () => {
            unsubscribe();
        };
    }, [disabled, getTriggers]);

    useEffect(() => {
        if (disabled) return undefined;
        const triggers = getTriggers();
        const handleAppStateChange = (nextAppState: AppStateStatus) => {
            if (triggers.handleAppStateChange(nextAppState) !== 'resumed') return;
            updateMobileWidgetFromStore().catch(logAppError);
            if (widgetRefreshTimer.current) {
                clearTimeout(widgetRefreshTimer.current);
            }
            widgetRefreshTimer.current = setTimeout(() => {
                if (!triggers.isRuntimeActive()) return;
                updateMobileWidgetFromStore().catch(logAppError);
            }, 800);
            if (Platform.OS === 'android' && hasActiveMobileNotificationFeature(useTaskStore.getState().settings)) {
                getNotificationPermissionStatus()
                    .then((permission) => {
                        if (!triggers.isRuntimeActive()) return;
                        if (!permission.granted) {
                            // The same cleanup as a denied start: the Pomodoro alarm goes too.
                            stopMobileNotifications({ permissionDenied: true }).catch(logAppError);
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
        };

        const subscription = AppState.addEventListener('change', handleAppStateChange);
        const unsubscribeCloudKit = subscribeToCloudKitChanges(() => {
            triggers.handleCloudKitChange();
        });

        return () => {
            subscription?.remove();
            unsubscribeCloudKit();
            triggers.dispose();
            if (widgetRefreshTimer.current) {
                clearTimeout(widgetRefreshTimer.current);
            }
            flushPendingSave().catch(logAppError);
        };
    }, [disabled, getTriggers]);

    useEffect(() => {
        if (disabled) return undefined;
        const unsubscribe = useTaskStore.subscribe(nameNotifyListener('focus-widget-setting', (state, previous) => {
            if (state.settings.gtd?.focusIncludeStartDates === previous.settings.gtd?.focusIncludeStartDates) return;
            updateMobileWidgetFromStore().catch(logAppError);
        }));
        return () => unsubscribe();
    }, [disabled]);

    useEffect(() => {
        if (disabled) return undefined;
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
    }, [disabled]);

    // Start calendar push sync on mount if enabled; stop on unmount.
    useEffect(() => {
        if (disabled) return undefined;
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
    }, [disabled]);

    return { requestSync };
}
