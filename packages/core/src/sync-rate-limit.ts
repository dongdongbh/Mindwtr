import { isWebdavRateLimitedError } from './sync-runtime-utils';
import type { SyncBackend } from './sync-service-utils';

export const WEBDAV_SYNC_COOLDOWN_MS = 60_000;

export type WebdavSyncRateLimitController = {
    assertReady: (backend: SyncBackend) => void;
    noteError: (backend: SyncBackend, error: unknown) => boolean;
    reset: () => void;
    getBlockedUntil: () => number;
};


export const createWebdavSyncRateLimitController = (
    options?: { now?: () => number; cooldownMs?: number }
): WebdavSyncRateLimitController => {
    const now = options?.now ?? (() => Date.now());
    const cooldownMs = options?.cooldownMs ?? WEBDAV_SYNC_COOLDOWN_MS;
    let blockedUntil = 0;

    return {
        assertReady(backend: SyncBackend) {
            if (backend !== 'webdav') return;
            if (!blockedUntil) return;
            const nowMs = now();
            if (nowMs >= blockedUntil) {
                blockedUntil = 0;
                return;
            }
            const error = new Error(`WebDAV rate limited for ${blockedUntil - nowMs}ms`);
            (error as { status?: number }).status = 429;
            throw error;
        },
        noteError(backend: SyncBackend, error: unknown) {
            if (backend !== 'webdav' || !isWebdavRateLimitedError(error)) return false;
            blockedUntil = now() + cooldownMs;
            return true;
        },
        reset() {
            blockedUntil = 0;
        },
        getBlockedUntil() {
            if (!blockedUntil) return 0;
            if (now() >= blockedUntil) {
                blockedUntil = 0;
                return 0;
            }
            return blockedUntil;
        },
    };
};
