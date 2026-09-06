import { useEffect, useRef, useState } from 'react';
import { Alert, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { requireOptionalNativeModule } from 'expo-modules-core';

import {
    type AppData,
    hasActiveMobileNotificationFeature,
    SQLITE_SCHEMA_VERSION,
    useTaskStore,
} from '@mindwtr/core';

import { startMobileNotifications } from '@/lib/notification-service';
import { getMobileStartupSnapshotFromBackup } from '@/lib/storage-adapter';
import { updateMobileWidgetFromStore } from '@/lib/widget-service';
import { markStartupPhase, measureStartupPhase } from '@/lib/startup-profiler';
import { verifyPolyfills } from '@/utils/verify-polyfills';
import { logError, logInfo } from '@/lib/app-log';
import { coerceSupportedBackend, resolveBackend } from '@/lib/sync-service-utils';
import { SYNC_BACKEND_KEY } from '@/lib/sync-constants';
import { isCloudKitAvailable } from '@/lib/cloudkit-sync';
import {
    getMobileStartupAnalyticsContext,
    sendMobileDailyHeartbeat,
} from '@/lib/analytics-heartbeat';

type UseRootLayoutStartupParams = {
    analyticsHeartbeatUrl: string;
    analyticsHeartbeatChannel?: string;
    appVersion: string;
    isExpoGo: boolean;
    isFossBuild: boolean;
    requestSync: (minIntervalMs?: number) => void;
    storageInitError: Error | null;
};

const supportsNativeICloudSync = (): boolean =>
    Platform.OS === 'ios' && isCloudKitAvailable();

const getStartupLoggingReason = (loggingEnabled: boolean): string =>
    loggingEnabled ? 'user-enabled' : 'startup-force';

const hasRenderableStartupSnapshot = (data: AppData | null): data is AppData => {
    if (!data) return false;
    return data.tasks.length > 0
        || data.projects.length > 0
        || data.sections.length > 0
        || data.areas.length > 0;
};

const applyStartupSnapshotToStore = (data: AppData): void => {
    const allTasks = Array.isArray(data.tasks) ? data.tasks : [];
    const allProjects = Array.isArray(data.projects) ? data.projects : [];
    const allSections = Array.isArray(data.sections) ? data.sections : [];
    const allAreas = Array.isArray(data.areas) ? data.areas : [];
    const settings = data.settings && typeof data.settings === 'object' ? data.settings : {};

    // Keep lastDataChangeAt untouched so the canonical storage fetch can still apply.
    useTaskStore.setState({
        settings,
        _allTasks: allTasks,
        _allProjects: allProjects,
        _allSections: allSections,
        _allAreas: allAreas,
        isLoading: false,
        error: null,
    });
};

export function useRootLayoutStartup({
    analyticsHeartbeatUrl,
    analyticsHeartbeatChannel,
    appVersion,
    isExpoGo,
    isFossBuild,
    requestSync,
    storageInitError,
}: UseRootLayoutStartupParams) {
    const [dataReady, setDataReady] = useState(false);
    const retryLoadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const widgetRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const storageWarningShown = useRef(false);
    const loadAttempts = useRef(0);
    const startupContextLogged = useRef(false);

    useEffect(() => {
        if (storageInitError && !storageWarningShown.current) {
            storageWarningShown.current = true;
            Alert.alert(
                '⚠️ Storage Error',
                'Failed to initialize storage. Your data will NOT be saved. Please restart the app.\n\nError: ' + storageInitError.message,
                [{ text: 'OK' }]
            );
        }

        let cancelled = false;
        const loadData = async () => {
            try {
                loadAttempts.current += 1;
                markStartupPhase('js.data_load.attempt_start', { attempt: loadAttempts.current });
                if (retryLoadTimer.current) {
                    clearTimeout(retryLoadTimer.current);
                    retryLoadTimer.current = null;
                }
                if (cancelled || storageInitError) {
                    return;
                }
                if (__DEV__) {
                    verifyPolyfills();
                }

                const store = useTaskStore.getState();
                let canonicalFetchCompleted = false;
                const fetchPromise = measureStartupPhase('js.store.fetch_data', async () => {
                    await store.fetchData({ silent: true });
                    canonicalFetchCompleted = true;
                });
                void measureStartupPhase('js.store.backup_snapshot.read', async () =>
                    getMobileStartupSnapshotFromBackup()
                ).then((startupSnapshot) => {
                    if (cancelled || canonicalFetchCompleted || !hasRenderableStartupSnapshot(startupSnapshot)) {
                        return;
                    }
                    applyStartupSnapshotToStore(startupSnapshot);
                    setDataReady(true);
                    markStartupPhase('js.store.backup_snapshot.applied');
                }).catch((error) => {
                    void logError(error, { scope: 'app', extra: { message: 'Failed to read startup backup snapshot' } });
                });
                await fetchPromise;
                if (cancelled) return;
                const loadedStore = useTaskStore.getState();
                setDataReady(true);
                markStartupPhase('js.store.fetch_data.applied');
                if (!startupContextLogged.current) {
                    startupContextLogged.current = true;
                    const rawBackend = await AsyncStorage.getItem(SYNC_BACKEND_KEY);
                    const syncBackend = coerceSupportedBackend(resolveBackend(rawBackend), supportsNativeICloudSync());
                    const analyticsContext = await getMobileStartupAnalyticsContext(
                        isFossBuild,
                        analyticsHeartbeatChannel
                    );
                    void logInfo('App started', {
                        scope: 'startup',
                        force: true,
                        extra: {
                            version: appVersion,
                            platform: analyticsContext.platform,
                            osMajor: analyticsContext.osMajor,
                            locale: analyticsContext.locale,
                            channel: analyticsContext.channel,
                            syncBackend,
                            schemaVersion: String(SQLITE_SCHEMA_VERSION),
                            deviceClass: analyticsContext.deviceClass,
                            buildType: isFossBuild ? 'foss' : 'standard',
                            loggingReason: getStartupLoggingReason(loadedStore.settings.diagnostics?.loggingEnabled === true),
                        },
                    }).catch(() => {});
                    if (Platform.OS === 'android') {
                        // #1150 proof: the native listener must have bounded OkHttp's connect
                        // before the first request, or an IPv6 blackhole still eats the 30 s timer.
                        const connectTimeoutMs = requireOptionalNativeModule<{ httpConnectTimeoutMs?: number }>('SyncFileLock')
                            ?.httpConnectTimeoutMs ?? 0;
                        void logInfo('Android HTTP connect timeout installed', {
                            scope: 'startup',
                            extra: {
                                releaseCheck: 'v1.2.8/android-http-connect-timeout',
                                connectTimeoutMs: String(connectTimeoutMs),
                            },
                        }).catch(() => {});
                    }
                }
                if (analyticsHeartbeatUrl) {
                    try {
                        await measureStartupPhase('js.analytics.heartbeat', async () => {
                            await sendMobileDailyHeartbeat(
                                {
                                    analyticsHeartbeatUrl,
                                    analyticsHeartbeatChannel,
                                    appVersion,
                                    isExpoGo,
                                    isFossBuild,
                                },
                                loadedStore.settings
                            );
                        });
                    } catch {
                        // Keep analytics heartbeat failures silent on mobile.
                    }
                }
                if (hasActiveMobileNotificationFeature(loadedStore.settings)) {
                    startMobileNotifications().catch((error) => {
                        void logError(error, { scope: 'app' });
                    });
                }
                updateMobileWidgetFromStore().catch((error) => {
                    void logError(error, { scope: 'app' });
                });
                if (widgetRefreshTimer.current) {
                    clearTimeout(widgetRefreshTimer.current);
                }
                widgetRefreshTimer.current = setTimeout(() => {
                    if (cancelled) return;
                    updateMobileWidgetFromStore().catch((error) => {
                        void logError(error, { scope: 'app' });
                    });
                }, 800);
                if (!cancelled) {
                    requestSync(0);
                }
                markStartupPhase('js.data_load.attempt_success', { attempt: loadAttempts.current });
            } catch (error) {
                markStartupPhase('js.data_load.attempt_error', { attempt: loadAttempts.current });
                void logError(error, { scope: 'app', extra: { message: 'Failed to load data' } });
                if (cancelled) return;
                if (loadAttempts.current < 3) {
                    if (retryLoadTimer.current) {
                        clearTimeout(retryLoadTimer.current);
                    }
                    retryLoadTimer.current = setTimeout(() => {
                        loadData();
                    }, 2000);
                    markStartupPhase('js.data_load.retry_scheduled', { attempt: loadAttempts.current, delayMs: 2000 });
                    return;
                }
                setDataReady(true);
                Alert.alert(
                    '⚠️ Data Load Error',
                    'Failed to load your data. Some tasks may be missing.\n\nError: ' + (error as Error).message,
                    [{ text: 'OK' }]
                );
            } finally {
                if (!cancelled) {
                    markStartupPhase('js.data_load.marked_ready');
                }
            }
        };

        if (!storageInitError) {
            void loadData();
        }

        return () => {
            cancelled = true;
            if (retryLoadTimer.current) {
                clearTimeout(retryLoadTimer.current);
                retryLoadTimer.current = null;
            }
            if (widgetRefreshTimer.current) {
                clearTimeout(widgetRefreshTimer.current);
                widgetRefreshTimer.current = null;
            }
        };
    }, [analyticsHeartbeatUrl, analyticsHeartbeatChannel, appVersion, isExpoGo, isFossBuild, requestSync, storageInitError]);

    return { dataReady };
}
