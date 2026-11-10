import { usePathname } from 'expo-router';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { getSettingsSyncBadge, useTaskStore } from '@mindwtr/core';

import { useLanguage } from '../contexts/language-context';
import { useThemePreset } from './use-eink-safe-color';
import {
    getMobileSyncActivityState,
    getMobileSyncConfigurationStatus,
    subscribeMobileSyncActivityState,
} from '../lib/sync-service';
import {
    getMobileLocalChangePending,
    resolveMobileSyncBadgeState,
    subscribeMobileLocalChangePending,
} from '../lib/sync-badge';

export function useMobileSyncBadge() {
    const pathname = usePathname();
    const { t } = useLanguage();
    const themePreset = useThemePreset();
    const settings = useTaskStore((state) => state.settings);
    const [syncConfigured, setSyncConfigured] = useState(false);
    const [syncActivityState, setSyncActivityState] = useState(() => getMobileSyncActivityState());
    const localChangePending = useSyncExternalStore(subscribeMobileLocalChangePending, getMobileLocalChangePending);

    const refreshSyncBadgeConfig = useCallback(async () => {
        try {
            const status = await getMobileSyncConfigurationStatus();
            setSyncConfigured(status.configured);
        } catch {
            setSyncConfigured(false);
        }
    }, []);

    useEffect(() => {
        const unsubscribe = subscribeMobileSyncActivityState(setSyncActivityState);
        return unsubscribe;
    }, []);

    useEffect(() => {
        void refreshSyncBadgeConfig();
    }, [
        pathname,
        refreshSyncBadgeConfig,
        settings.lastSyncAt,
        settings.lastSyncStatus,
        settings.pendingRemoteWriteAt,
    ]);

    const syncBadgeState = useMemo(() => resolveMobileSyncBadgeState({
        configured: syncConfigured,
        activityState: syncActivityState,
        pendingRemoteWriteAt: settings.pendingRemoteWriteAt,
        localChangePending,
        lastSyncStatus: settings.lastSyncStatus,
        lastSyncAt: settings.lastSyncAt,
    }), [
        localChangePending,
        settings.lastSyncAt,
        settings.lastSyncStatus,
        settings.pendingRemoteWriteAt,
        syncActivityState,
        syncConfigured,
    ]);

    const syncBadge = useMemo(() => getSettingsSyncBadge(syncBadgeState, t, themePreset), [syncBadgeState, t, themePreset]);

    return {
        refreshSyncBadgeConfig,
        syncBadgeAccessibilityLabel: syncBadge?.accessibilityLabel,
        syncBadgeColor: syncBadge?.color,
        syncBadgeIcon: syncBadge?.icon,
        syncBadgeState,
    };
}
