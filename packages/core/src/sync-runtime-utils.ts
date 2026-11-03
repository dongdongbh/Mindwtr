import type { AppData } from './types';
import { mapPass, type CooperativePass } from './cooperative';

const cloneValue = <T>(value: T): T => {
    if (typeof globalThis.structuredClone === 'function') {
        try {
            return globalThis.structuredClone(value);
        } catch {

        }
    }
    return JSON.parse(JSON.stringify(value)) as T;
};

export const cloneAppData = (data: AppData): AppData => cloneValue(data);


export function* cloneAppDataPass(data: AppData): CooperativePass<AppData> {
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
        copy[key] = Array.isArray(value) ? yield* mapPass(value, (item) => cloneValue(item)) : cloneValue(value);
    }
    return copy as unknown as AppData;
}

export const getErrorStatus = (error: unknown): number | null => {
    if (!error || typeof error !== 'object') return null;
    const anyError = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
    const status = anyError.status ?? anyError.statusCode ?? anyError.response?.status;
    return typeof status === 'number' ? status : null;
};

export const isWebdavRateLimitedError = (error: unknown): boolean => {
    const status = getErrorStatus(error);
    if (status === 429 || status === 503) return true;
    const message = error instanceof Error ? error.message : String(error || '');
    const normalized = message.toLowerCase();
    return (
        normalized.includes('blockedtemporarily') ||
        normalized.includes('too many requests') ||
        normalized.includes('rate limit') ||
        normalized.includes('rate limited')
    );
};


const CLOUDKIT_RETRY_AFTER_PATTERN = /\[retryAfter=(\d+(?:\.\d+)?)\]/i;


const MAX_HONOURED_RETRY_AFTER_MS = 60 * 60 * 1000;

export const parseCloudKitRetryAfterMs = (error: unknown): number | null => {
    const message = error instanceof Error ? error.message : String(error || '');
    const match = CLOUDKIT_RETRY_AFTER_PATTERN.exec(message);
    if (!match) return null;
    const seconds = Number(match[1]);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return Math.min(MAX_HONOURED_RETRY_AFTER_MS, Math.ceil(seconds * 1000));
};

export type SyncFailureCooldownOptions = {
    error?: unknown;

    consecutiveFailures: number;
    baseMs: number;
    maxMs: number;
};


export const resolveSyncFailureCooldownMs = ({
    error,
    consecutiveFailures,
    baseMs,
    maxMs,
}: SyncFailureCooldownOptions): number => {
    const attempt = Math.max(1, Math.floor(consecutiveFailures));
    const requestedMs = parseCloudKitRetryAfterMs(error);
    if (requestedMs === null) {
        const exponentialMs = baseMs * (2 ** (attempt - 1));
        return Math.min(maxMs, Math.max(baseMs, exponentialMs));
    }


    const ceilingMs = Math.max(maxMs, requestedMs);
    return Math.min(ceilingMs, requestedMs * (2 ** (attempt - 1)));
};

type WebdavDownloadBackoffOptions = {
    missingBackoffMs: number;
    errorBackoffMs: number;
};

export const createWebdavDownloadBackoff = (options: WebdavDownloadBackoffOptions) => {
    const backoff = new Map<string, number>();

    return {
        getBlockedUntil(attachmentId: string): number | null {
            const blockedUntil = backoff.get(attachmentId);
            if (!blockedUntil) return null;
            if (Date.now() >= blockedUntil) {
                backoff.delete(attachmentId);
                return null;
            }
            return blockedUntil;
        },
        setFromError(attachmentId: string, error: unknown): void {
            const status = getErrorStatus(error);
            if (status === 404) {
                backoff.set(attachmentId, Date.now() + options.missingBackoffMs);
                return;
            }
            backoff.set(attachmentId, Date.now() + options.errorBackoffMs);
        },
        prune(now = Date.now()): void {
            for (const [id, blockedUntil] of backoff) {
                if (blockedUntil <= now) {
                    backoff.delete(id);
                }
            }
        },
        deleteEntry(attachmentId: string): void {
            backoff.delete(attachmentId);
        },
        clear(): void {
            backoff.clear();
        },
        size(): number {
            return backoff.size;
        },
    };
};
