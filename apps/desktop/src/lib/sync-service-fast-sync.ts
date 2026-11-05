import {
    buildFastSyncScope as buildCoreFastSyncScope,
    parseFastSyncState,
    serializeFastSyncState,
    type AppSettings,
    type CloudProvider,
    type FastSyncState,
} from '@mindwtr/core';

import type { CloudConfig, WebDavConfig } from './sync-attachment-backends';
import type { SyncBackend } from './sync-service-utils';

export { hasPendingSyncSideEffects } from '@mindwtr/core';
export type { FastSyncState } from '@mindwtr/core';

const FAST_SYNC_STATE_KEY = 'mindwtr-fast-sync-state-v1';
const LOCAL_SYNC_STATUS_KEY = 'mindwtr-local-sync-status-v1';
type LocalSyncStatus = Pick<AppSettings, 'lastSyncAt' | 'lastSyncStatus' | 'lastSyncError' | 'lastSyncStats' | 'lastSyncHistory'>;

type FastSyncScopeContext = {
    backend: SyncBackend;
    webdavConfig: WebDavConfig | null;
    cloudProvider: CloudProvider;
    cloudConfig: CloudConfig | null;
    dropboxAppKey: string;
};

export function readFastSyncState(scope: string): FastSyncState | null {
    if (typeof localStorage === 'undefined') return null;
    try {
        const raw = localStorage.getItem(FAST_SYNC_STATE_KEY);
        return parseFastSyncState(raw, scope);
    } catch {
        return null;
    }
}

export function writeFastSyncState(
    state: FastSyncState,
    logWarning: (message: string, error?: unknown) => void
): void {
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.setItem(FAST_SYNC_STATE_KEY, serializeFastSyncState(state));
    } catch (error) {
        logWarning('Failed to cache sync fast-check state', error);
    }
}

const sanitizeLocalSyncStatus = (value: Partial<LocalSyncStatus>): Partial<LocalSyncStatus> => {
    const next: Partial<LocalSyncStatus> = {};
    if (typeof value.lastSyncAt === 'string') next.lastSyncAt = value.lastSyncAt;
    if (
        value.lastSyncStatus === 'idle'
        || value.lastSyncStatus === 'syncing'
        || value.lastSyncStatus === 'success'
        || value.lastSyncStatus === 'error'
        || value.lastSyncStatus === 'conflict'
    ) {
        next.lastSyncStatus = value.lastSyncStatus;
    }
    if (typeof value.lastSyncError === 'string') next.lastSyncError = value.lastSyncError;
    if (value.lastSyncStats && typeof value.lastSyncStats === 'object') next.lastSyncStats = value.lastSyncStats;
    if (Array.isArray(value.lastSyncHistory)) next.lastSyncHistory = value.lastSyncHistory;
    return next;
};

export function readLocalSyncStatus(): Partial<LocalSyncStatus> | null {
    if (typeof localStorage === 'undefined') return null;
    try {
        const raw = localStorage.getItem(LOCAL_SYNC_STATUS_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<LocalSyncStatus>;
        const status = sanitizeLocalSyncStatus(parsed);
        return Object.keys(status).length > 0 ? status : null;
    } catch {
        return null;
    }
}

export function writeLocalSyncStatus(
    updates: Partial<LocalSyncStatus>,
    logWarning: (message: string, error?: unknown) => void
): void {
    if (typeof localStorage === 'undefined') return;
    try {
        const next = sanitizeLocalSyncStatus({
            ...(readLocalSyncStatus() ?? {}),
            ...updates,
        });
        localStorage.setItem(LOCAL_SYNC_STATUS_KEY, JSON.stringify(next));
    } catch (error) {
        logWarning('Failed to cache local sync status', error);
    }
}

export function clearLocalSyncStatus(): void {
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.removeItem(LOCAL_SYNC_STATUS_KEY);
    } catch {

    }
}

export function clearFastSyncState(): void {
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.removeItem(FAST_SYNC_STATE_KEY);
    } catch {

    }
}

export function buildFastSyncScope(context: FastSyncScopeContext): string | null {
    return buildCoreFastSyncScope(context);
}
