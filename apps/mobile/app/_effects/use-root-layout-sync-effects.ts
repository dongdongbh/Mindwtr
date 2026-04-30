import { useCallback, useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, type AppStateStatus, Platform } from 'react-native';

import { flushPendingSave, useTaskStore } from '@mindwtr/core';

import type { ToastOptions } from '@/contexts/toast-context';
import { getNotificationPermissionStatus, startMobileNotifications, stopMobileNotifications } from '@/lib/notification-service';
import { getCalendarPushEnabled, runFullCalendarSync, startCalendarPushSync, stopCalendarPushSync } from '@/lib/calendar-push-sync';
import { abortMobileSync, performMobileSync } from '@/lib/sync-service';
import { classifySyncFailure, coerceSupportedBackend, isLikelyOfflineSyncError, resolveBackend, type SyncBackend } from '@/lib/sync-service-utils';
import { SYNC_BACKEND_KEY } from '@/lib/sync-constants';
import { isCloudKitAvailable, subscribeToCloudKitChanges } from '@/lib/cloudkit-sync';
import { updateMobileWidgetFromStore } from '@/lib/widget-service';
import { hasActiveMobileNotificationFeature } from '@/lib/mobile-notification-settings';
import { logError, logWarn } from '@/lib/app-log';

type Localize = (english: string, chinese: string) => string;

type UseRootLayoutSyncEffectsParams = {
    localize: Localize;
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
    syncIssueGenericMessage: string;
    syncIssueMisconfiguredMessage: string;
    syncIssuePermissionMessage: string;
    syncIssueRateLimitedMessage: string;
    syncIssueTitle: string;
};

const AUTO_SYNC_BACKEND_CACHE_TTL_MS = 5_000;
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

const buildSyncUiCopy = (localize: Localize): SyncUiCopy => ({
    syncIssueTitle: localize('Sync issue', '同步异常'),
    syncIssueGenericMessage: localize(
        'Background sync failed. Open Settings → Sync to review the connection and retry.',
        '后台同步失败。请打开“设置 → 同步”检查连接并重试。'
    ),
    syncIssueAuthMessage: localize(
        'Background sync needs updated credentials. Open Settings → Sync to re-authenticate and retry.',
        '后台同步需要更新凭据。请打开“设置 → 同步”重新验证并重试。'
    ),
    syncIssuePermissionMessage: localize(
        'Background sync cannot write to the selected file or folder. Re-select the sync location in Settings → Sync.',
        '后台同步无法写入当前选择的文件或文件夹。请在“设置 → 同步”中重新选择同步位置。'
    ),
    syncIssueRateLimitedMessage: localize(
        'Background sync is being rate limited. Mindwtr will retry shortly; review Settings → Sync if it keeps happening.',
        '后台同步正在被限流。Mindwtr 将稍后重试；如果持续发生，请检查“设置 → 同步”。'
    ),
    syncIssueMisconfiguredMessage: localize(
        'Background sync is missing required sync settings. Open Settings → Sync to finish setup.',
        '后台同步缺少必要的同步设置。请打开“设置 → 同步”完成配置。'
    ),
    syncIssueConflictMessage: localize(
        'Background sync hit a sync conflict or stale remote state. Open Settings → Sync to review and retry.',
        '后台同步遇到冲突或远端状态已过期。请打开“设置 → 同步”检查后重试。'
    ),
    notificationsDisabledTitle: localize('Notifications disabled', '通知已禁用'),
    notificationsDisabledMessage: localize(
        'Mindwtr can no longer schedule reminders until notification access is restored.',
        '在恢复通知权限之前，Mindwtr 无法继续安排提醒。'
    ),
    openActionLabel: localize('Open', '打开'),
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

export function useRootLayoutSyncEffects({
    localize,
    openNotificationsSettings,
    openSyncSettings,
    showToast,
}: UseRootLayoutSyncEffectsParams) {
    const appState = useRef(AppState.currentState);
    const lastAutoSyncAt = useRef(0);
    const syncDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const syncThrottleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const widgetRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const syncInFlight = useRef<Promise<void> | null>(null);
    const syncPending = useRef(false);
    const backgroundSyncPending = useRef(false);
    const isActive = useRef(true);
    const lastLoggedAutoSyncError = useRef<string | null>(null);
    const lastLoggedAutoSyncErrorAt = useRef(0);
    const notificationPermissionWarningShown = useRef(false);
    const syncCadenceRef = useRef<AutoSyncCadence>(AUTO_SYNC_CADENCE_REMOTE);
    const syncBackendCacheRef = useRef<{ backend: SyncBackend; readAt: number }>({
        backend: 'off',
        readAt: 0,
    });
    const showToastRef = useRef(showToast);
    const openSyncSettingsRef = useRef(openSyncSettings);
    const openNotificationsSettingsRef = useRef(openNotificationsSettings);
    const syncUiCopyRef = useRef<SyncUiCopy>(buildSyncUiCopy(localize));

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
        syncUiCopyRef.current = buildSyncUiCopy(localize);
    }, [localize]);

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

    const runSync = useCallback((minIntervalMs?: number) => {
        const effectiveMinIntervalMs = typeof minIntervalMs === 'number'
            ? minIntervalMs
            : syncCadenceRef.current.minIntervalMs;
        if (!isActive.current) return;
        if (syncInFlight.current && appState.current !== 'active') {
            backgroundSyncPending.current = true;
            syncPending.current = true;
            return;
        }
        if (syncInFlight.current) {
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

        const appStateAtSyncStart = appState.current;
        syncInFlight.current = (async () => {
            await flushPendingSave().catch(logAppError);
            const result = await performMobileSync().catch((error) => ({ success: false, error: String(error) }));
            if (!result.success && result.error) {
                if (isLikelyOfflineSyncError(result.error)) {
                    return;
                }
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
            if (appStateAtSyncStart !== 'active' && backgroundSyncPending.current) {
                backgroundSyncPending.current = false;
                syncPending.current = true;
                return;
            }
            if (syncPending.current && isActive.current) {
                runSync(syncCadenceRef.current.minIntervalMs);
            }
        });
    }, []);

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
        const unsubscribe = useTaskStore.subscribe((state, prevState) => {
            if (state.lastDataChangeAt === prevState.lastDataChangeAt) return;
            const cadence = syncCadenceRef.current;
            const hadTimer = !!syncDebounceTimer.current;
            if (syncDebounceTimer.current) {
                clearTimeout(syncDebounceTimer.current);
            }
            const debounceMs = hadTimer ? cadence.debounceContinuousChangeMs : cadence.debounceFirstChangeMs;
            syncDebounceTimer.current = setTimeout(() => {
                if (!isActive.current) return;
                requestSync();
            }, debounceMs);
        });

        return () => {
            unsubscribe();
            if (syncDebounceTimer.current) {
                clearTimeout(syncDebounceTimer.current);
            }
            if (syncThrottleTimer.current) {
                clearTimeout(syncThrottleTimer.current);
            }
        };
    }, [requestSync, refreshSyncCadence]);

    useEffect(() => {
        const handleAppStateChange = (nextAppState: AppStateStatus) => {
            if (!isActive.current) return;
            const previousState = appState.current;
            const wasInactiveOrBackground = previousState === 'inactive' || previousState === 'background';
            const nextInactiveOrBackground = nextAppState === 'inactive' || nextAppState === 'background';
            if (wasInactiveOrBackground && nextAppState === 'active') {
                if (backgroundSyncPending.current) {
                    backgroundSyncPending.current = false;
                    requestSync(0);
                } else {
                    void refreshSyncCadence()
                        .then((cadence) => {
                            const now = Date.now();
                            if (now - lastAutoSyncAt.current > cadence.foregroundMinIntervalMs) {
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
                if (syncDebounceTimer.current) {
                    clearTimeout(syncDebounceTimer.current);
                    syncDebounceTimer.current = null;
                }
                if (syncThrottleTimer.current) {
                    clearTimeout(syncThrottleTimer.current);
                    syncThrottleTimer.current = null;
                }
                abortMobileSync();
                requestSync(0);
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
            if (syncThrottleTimer.current) {
                clearTimeout(syncThrottleTimer.current);
            }
            if (widgetRefreshTimer.current) {
                clearTimeout(widgetRefreshTimer.current);
            }
            syncInFlight.current = null;
            flushPendingSave().catch(logAppError);
        };
    }, [refreshSyncCadence, requestSync]);

    useEffect(() => {
        let previousEnabled = hasActiveMobileNotificationFeature(useTaskStore.getState().settings);
        const unsubscribe = useTaskStore.subscribe((state) => {
            const enabled = hasActiveMobileNotificationFeature(state.settings);
            if (enabled === previousEnabled) return;
            previousEnabled = enabled;

            if (enabled === false) {
                stopMobileNotifications().catch(logAppError);
            } else {
                startMobileNotifications().catch(logAppError);
            }
        });

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
