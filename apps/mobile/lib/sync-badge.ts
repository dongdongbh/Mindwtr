import { resolveSyncBadgeState, type SyncBadgeState } from '@mindwtr/core/sync-settings-model';

export type MobileSyncActivityState = 'idle' | 'syncing';
export type MobileSyncBadgeState = SyncBadgeState;

export const MOBILE_SYNC_BADGE_COLORS: Record<Exclude<MobileSyncBadgeState, 'hidden'>, string> = {
    syncing: '#F59E0B',
    healthy: '#22C55E',
    attention: '#EF4444',
};

// The rule lives in core (sync-settings-model.ts) so the native app draws the same badge.
export const resolveMobileSyncBadgeState = resolveSyncBadgeState;

// A local change waiting in the automatic-sync scheduler (#1431). The root layout's sync
// triggers set it; the badge reads it, so the dot is not green before the upload starts.
let mobileLocalChangePending = false;
const localChangePendingListeners = new Set<() => void>();

export const setMobileLocalChangePending = (pending: boolean): void => {
    if (mobileLocalChangePending === pending) return;
    mobileLocalChangePending = pending;
    localChangePendingListeners.forEach((listener) => listener());
};

export const getMobileLocalChangePending = (): boolean => mobileLocalChangePending;

export const subscribeMobileLocalChangePending = (listener: () => void): (() => void) => {
    localChangePendingListeners.add(listener);
    return () => {
        localChangePendingListeners.delete(listener);
    };
};
