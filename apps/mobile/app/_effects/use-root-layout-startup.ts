import { useEffect, useRef, useState } from 'react';
import { Alert, Platform } from 'react-native';
import * as Application from 'expo-application';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
    generateUUID,
    sendDailyHeartbeat,
    SQLITE_SCHEMA_VERSION,
    useTaskStore,
} from '@mindwtr/core';

import { startMobileNotifications } from '@/lib/notification-service';
import { updateMobileWidgetFromStore } from '@/lib/widget-service';
import { markStartupPhase, measureStartupPhase } from '@/lib/startup-profiler';
import { verifyPolyfills } from '@/utils/verify-polyfills';
import { logError, logInfo } from '@/lib/app-log';
import { coerceSupportedBackend, resolveBackend } from '@/lib/sync-service-utils';
import { SYNC_BACKEND_KEY } from '@/lib/sync-constants';
import { isCloudKitAvailable } from '@/lib/cloudkit-sync';

type UseRootLayoutStartupParams = {
    analyticsHeartbeatUrl: string;
    appVersion: string;
    isExpoGo: boolean;
    isFossBuild: boolean;
    requestSync: (minIntervalMs?: number) => void;
    storageInitError: Error | null;
};

const ANALYTICS_DISTINCT_ID_KEY = 'mindwtr-analytics-distinct-id';

type PlatformExtras = typeof Platform & {
    isPad?: boolean;
    constants?: {
        Release?: string;
    };
};

const platformExtras = Platform as PlatformExtras;

const supportsNativeICloudSync = (): boolean =>
    Platform.OS === 'ios' && isCloudKitAvailable();

const getMobileAnalyticsChannel = async (isFossBuild: boolean): Promise<string> => {
    if (Platform.OS === 'ios') return 'app-store';
    if (Platform.OS !== 'android') return Platform.OS || 'mobile';
    if (isFossBuild) return 'android-sideload';
    try {
        const referrer = await Application.getInstallReferrerAsync();
        return (referrer || '').trim() ? 'play-store' : 'android-sideload';
    } catch {
        return 'android-unknown';
    }
};

const getOrCreateAnalyticsDistinctId = async (): Promise<string> => {
    const existing = (await AsyncStorage.getItem(ANALYTICS_DISTINCT_ID_KEY) || '').trim();
    if (existing) return existing;
    const generated = generateUUID();
    await AsyncStorage.setItem(ANALYTICS_DISTINCT_ID_KEY, generated);
    return generated;
};

const getMobileDeviceClass = (): string => {
    if (Platform.OS === 'ios') return platformExtras.isPad === true ? 'tablet' : 'phone';
    if (Platform.OS === 'android') return 'phone';
    return 'desktop';
};

const getMobileOsMajor = (): string => {
    if (Platform.OS === 'ios') {
        const raw = String(Platform.Version ?? '');
        const major = raw.match(/\d+/)?.[0];
        return major ? `ios-${major}` : 'ios';
    }
    if (Platform.OS === 'android') {
        const raw = String(platformExtras.constants?.Release ?? Platform.Version ?? '');
        const major = raw.match(/\d+/)?.[0];
        return major ? `android-${major}` : 'android';
    }
    return Platform.OS || 'mobile';
};

const getDeviceLocale = (): string => {
    try {
        return String(Intl.DateTimeFormat().resolvedOptions().locale || '').trim();
    } catch {
        return '';
    }
};

const getStartupLoggingReason = (loggingEnabled: boolean): string =>
    loggingEnabled ? 'user-enabled' : 'startup-force';

export function useRootLayoutStartup({
    analyticsHeartbeatUrl,
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
                await measureStartupPhase('js.store.fetch_data', async () => {
                    await store.fetchData();
                });
                if (cancelled) return;
                setDataReady(true);
                markStartupPhase('js.store.fetch_data.applied');
                if (!startupContextLogged.current) {
                    startupContextLogged.current = true;
                    const rawBackend = await AsyncStorage.getItem(SYNC_BACKEND_KEY);
                    const syncBackend = coerceSupportedBackend(resolveBackend(rawBackend), supportsNativeICloudSync());
                    const channel = await getMobileAnalyticsChannel(isFossBuild).catch(() => Platform.OS || 'mobile');
                    void logInfo('App started', {
                        scope: 'startup',
                        force: true,
                        extra: {
                            version: appVersion,
                            platform: Platform.OS,
                            osMajor: getMobileOsMajor(),
                            locale: getDeviceLocale(),
                            channel,
                            syncBackend,
                            schemaVersion: String(SQLITE_SCHEMA_VERSION),
                            deviceClass: getMobileDeviceClass(),
                            buildType: isFossBuild ? 'foss' : 'standard',
                            loggingReason: getStartupLoggingReason(store.settings.diagnostics?.loggingEnabled === true),
                        },
                    }).catch(() => {});
                }
                if (!isFossBuild && !isExpoGo && !__DEV__ && analyticsHeartbeatUrl) {
                    try {
                        const [distinctId, channel] = await Promise.all([
                            getOrCreateAnalyticsDistinctId(),
                            getMobileAnalyticsChannel(isFossBuild),
                        ]);
                        await measureStartupPhase('js.analytics.heartbeat', async () => {
                            await sendDailyHeartbeat({
                                enabled: true,
                                endpointUrl: analyticsHeartbeatUrl,
                                distinctId,
                                platform: Platform.OS,
                                channel,
                                appVersion,
                                deviceClass: getMobileDeviceClass(),
                                osMajor: getMobileOsMajor(),
                                locale: getDeviceLocale(),
                                storage: AsyncStorage,
                            });
                        });
                    } catch {
                        // Keep analytics heartbeat failures silent on mobile.
                    }
                }
                if (store.settings.notificationsEnabled !== false) {
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
    }, [analyticsHeartbeatUrl, appVersion, isExpoGo, isFossBuild, requestSync, storageInitError]);

    return { dataReady };
}
