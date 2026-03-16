import { usePathname } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTaskStore } from '@mindwtr/core';

import { useLanguage } from '../contexts/language-context';
import {
    getMobileSyncActivityState,
    getMobileSyncConfigurationStatus,
    subscribeMobileSyncActivityState,
} from '../lib/sync-service';
import { MOBILE_SYNC_BADGE_COLORS, resolveMobileSyncBadgeState } from '../lib/sync-badge';

export function useMobileSyncBadge() {
    const pathname = usePathname();
    const { localize } = useLanguage();
    const settings = useTaskStore((state) => state.settings);
    const [syncConfigured, setSyncConfigured] = useState(false);
    const [syncActivityState, setSyncActivityState] = useState(() => getMobileSyncActivityState());

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
        lastSyncStatus: settings.lastSyncStatus,
        lastSyncAt: settings.lastSyncAt,
    }), [
        settings.lastSyncAt,
        settings.lastSyncStatus,
        settings.pendingRemoteWriteAt,
        syncActivityState,
        syncConfigured,
    ]);

    const syncBadgeColor = syncBadgeState === 'hidden' ? undefined : MOBILE_SYNC_BADGE_COLORS[syncBadgeState];

    const syncBadgeAccessibilityLabel = useMemo(() => {
        if (syncBadgeState === 'hidden') return undefined;
        if (syncBadgeState === 'syncing') {
            return localize('Sync in progress', '同步进行中');
        }
        if (syncBadgeState === 'healthy') {
            return localize('Sync healthy', '同步正常');
        }
        return localize('Sync needs attention', '同步需要关注');
    }, [localize, syncBadgeState]);

    return {
        refreshSyncBadgeConfig,
        syncBadgeAccessibilityLabel,
        syncBadgeColor,
        syncBadgeState,
    };
}
