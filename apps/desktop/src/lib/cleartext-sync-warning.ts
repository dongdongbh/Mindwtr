import { deterministicHash128Hex, isAllowedInsecureUrl, normalizeCloudUrl, normalizeWebdavUrl } from '@mindwtr/core';
import { getWorkspaceCache } from './workspace-cache';

/** Device-local banner acknowledgment; never changes permission to use HTTP. */
export function getCleartextSyncDestination(backend: 'webdav' | 'cloud', rawUrl: string): string | null {
    try {
        const url = new URL(rawUrl.trim());
        if (url.protocol !== 'http:' || isAllowedInsecureUrl(url.href)) return null;
        url.username = '';
        url.password = '';
        url.hash = '';
        const endpoint = backend === 'webdav' ? normalizeWebdavUrl(url.href) : normalizeCloudUrl(url.href);
        // Query strings may contain credentials: persist only an endpoint fingerprint.
        return `mindwtr:cleartextSyncDismissed:${backend}:${deterministicHash128Hex(endpoint)}`;
    } catch {
        return null;
    }
}

export function isCleartextSyncDismissed(destination: string): boolean {
    try {
        return getWorkspaceCache()?.getItem(destination) === 'true';
    } catch {
        return false;
    }
}

export function dismissCleartextSyncWarning(destination: string): void {
    try {
        getWorkspaceCache()?.setItem(destination, 'true');
    } catch {
        // Storage unavailable: Layout keeps the acknowledgment for this mount.
    }
}
