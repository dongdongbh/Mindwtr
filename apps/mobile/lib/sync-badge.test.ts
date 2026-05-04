import { describe, expect, it } from 'vitest';

import { resolveMobileSyncBadgeState } from './sync-badge';

describe('resolveMobileSyncBadgeState', () => {
    it('returns hidden when sync is not configured', () => {
        expect(resolveMobileSyncBadgeState({
            configured: false,
            activityState: 'idle',
        })).toBe('hidden');
    });

    it('returns syncing while activity is in progress', () => {
        expect(resolveMobileSyncBadgeState({
            configured: true,
            activityState: 'syncing',
            lastSyncStatus: 'success',
            lastSyncAt: '2026-03-04T00:00:00.000Z',
        })).toBe('syncing');
    });

    it('returns syncing when there is a pending remote write', () => {
        expect(resolveMobileSyncBadgeState({
            configured: true,
            activityState: 'idle',
            pendingRemoteWriteAt: '2026-03-04T00:00:00.000Z',
            lastSyncStatus: 'success',
        })).toBe('syncing');
    });

    it('returns attention when a pending remote write has failed', () => {
        expect(resolveMobileSyncBadgeState({
            configured: true,
            activityState: 'idle',
            pendingRemoteWriteAt: '2026-03-04T00:00:00.000Z',
            lastSyncStatus: 'error',
        })).toBe('attention');
    });

    it('returns healthy for successful sync', () => {
        expect(resolveMobileSyncBadgeState({
            configured: true,
            activityState: 'idle',
            lastSyncStatus: 'success',
            lastSyncAt: '2026-03-04T00:00:00.000Z',
        })).toBe('healthy');
    });

    it('returns healthy for conflict status because conflicts are auto-resolved', () => {
        expect(resolveMobileSyncBadgeState({
            configured: true,
            activityState: 'idle',
            lastSyncStatus: 'conflict',
            lastSyncAt: '2026-03-04T00:00:00.000Z',
        })).toBe('healthy');
    });

    it('returns attention for error status', () => {
        expect(resolveMobileSyncBadgeState({
            configured: true,
            activityState: 'idle',
            lastSyncStatus: 'error',
            lastSyncAt: '2026-03-04T00:00:00.000Z',
        })).toBe('attention');
    });

    it('returns attention when configured but never synced', () => {
        expect(resolveMobileSyncBadgeState({
            configured: true,
            activityState: 'idle',
            lastSyncStatus: 'idle',
        })).toBe('attention');
    });
});
