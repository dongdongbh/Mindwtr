import type { AppData } from '@mindwtr/core';

export type MobileSyncActivityState = 'idle' | 'syncing';
export type MobileSyncBadgeState = 'hidden' | 'syncing' | 'healthy' | 'attention';

export const MOBILE_SYNC_BADGE_COLORS: Record<Exclude<MobileSyncBadgeState, 'hidden'>, string> = {
    syncing: '#F59E0B',
    healthy: '#22C55E',
    attention: '#EF4444',
};

export function resolveMobileSyncBadgeState(params: {
    configured: boolean;
    activityState: MobileSyncActivityState;
    pendingRemoteWriteAt?: AppData['settings']['pendingRemoteWriteAt'];
    lastSyncStatus?: AppData['settings']['lastSyncStatus'];
    lastSyncAt?: AppData['settings']['lastSyncAt'];
}): MobileSyncBadgeState {
    const {
        configured,
        activityState,
        pendingRemoteWriteAt,
        lastSyncStatus,
        lastSyncAt,
    } = params;

    if (!configured) return 'hidden';
    if (activityState === 'syncing') return 'syncing';
    if (lastSyncStatus === 'error') return 'attention';
    if (Boolean(pendingRemoteWriteAt)) return 'syncing';
    if (lastSyncStatus === 'success' || lastSyncStatus === 'conflict') return 'healthy';
    if (lastSyncAt) return 'healthy';

    return 'attention';
}
