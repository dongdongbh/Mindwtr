import { describe, expect, it, vi } from 'vitest';
import {
    cloneAppData,
    createWebdavDownloadBackoff,
    getErrorStatus,
    isWebdavRateLimitedError,
    parseCloudKitRetryAfterMs,
    resolveSyncFailureCooldownMs,
} from './sync-runtime-utils';

describe('sync-runtime-utils', () => {
    it('extracts status code across common error shapes', () => {
        expect(getErrorStatus({ status: 429 })).toBe(429);
        expect(getErrorStatus({ statusCode: 503 })).toBe(503);
        expect(getErrorStatus({ response: { status: 404 } })).toBe(404);
        expect(getErrorStatus(new Error('no status'))).toBeNull();
    });

    it('detects webdav rate limit responses from status and message', () => {
        expect(isWebdavRateLimitedError({ status: 429 })).toBe(true);
        expect(isWebdavRateLimitedError({ statusCode: 503 })).toBe(true);
        expect(isWebdavRateLimitedError(new Error('too many requests from server'))).toBe(true);
        expect(isWebdavRateLimitedError(new Error('permission denied'))).toBe(false);
    });

    it('clones app data snapshots without sharing references', () => {
        const source = {
            tasks: [{ id: 't1', title: 'Task', status: 'inbox', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' }],
            projects: [],
            sections: [],
            areas: [],
            settings: { theme: 'dark' },
        } as any;
        const cloned = cloneAppData(source);
        cloned.tasks[0].title = 'Changed';

        expect(source.tasks[0].title).toBe('Task');
        expect(cloned.tasks[0].title).toBe('Changed');
    });

    it('prefers structuredClone when available', () => {
        const source = {
            tasks: [{ id: 't1', title: 'Task', status: 'inbox', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' }],
            projects: [],
            sections: [],
            areas: [],
            settings: { theme: 'dark' },
        } as any;
        const structuredCloneSpy = vi.spyOn(globalThis, 'structuredClone');

        cloneAppData(source);

        expect(structuredCloneSpy).toHaveBeenCalledWith(source);
        structuredCloneSpy.mockRestore();
    });

    it('tracks, prunes, and clears download backoff entries', () => {
        const backoff = createWebdavDownloadBackoff({ missingBackoffMs: 1_000, errorBackoffMs: 2_000 });
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);

        backoff.setFromError('a', { status: 404 });
        expect(backoff.getBlockedUntil('a')).toBe(2_000);

        backoff.setFromError('b', { status: 500 });
        expect(backoff.getBlockedUntil('b')).toBe(3_000);

        nowSpy.mockReturnValue(3_001);
        backoff.prune();
        expect(backoff.size()).toBe(0);

        backoff.setFromError('c', { status: 500 });
        backoff.deleteEntry('c');
        expect(backoff.getBlockedUntil('c')).toBeNull();
        backoff.setFromError('c', { status: 500 });
        backoff.clear();
        expect(backoff.size()).toBe(0);

        nowSpy.mockRestore();
    });

    it('reads the delay CloudKit asked for out of a bridge error (#948)', () => {
        expect(parseCloudKitRetryAfterMs('CloudKit error: Service Unavailable [retryAfter=42]')).toBe(42_000);
        expect(parseCloudKitRetryAfterMs(new Error('rate limited [retryAfter=3.5]'))).toBe(3_500);
        expect(parseCloudKitRetryAfterMs('CloudKit error: Network Failure')).toBeNull();
        expect(parseCloudKitRetryAfterMs('[retryAfter=0]')).toBeNull();
        expect(parseCloudKitRetryAfterMs('[retryAfter=-5]')).toBeNull();

        expect(parseCloudKitRetryAfterMs('[retryAfter=999999]')).toBe(60 * 60 * 1000);
    });

    it('honours the requested delay on the first failure, then escalates while it keeps failing (#948)', () => {
        const baseMs = 60_000;
        const maxMs = 600_000;
        const throttled = 'CloudKit error: Request Rate Limited [retryAfter=5]';


        expect(resolveSyncFailureCooldownMs({ error: throttled, consecutiveFailures: 1, baseMs, maxMs })).toBe(5_000);


        expect(resolveSyncFailureCooldownMs({ error: throttled, consecutiveFailures: 2, baseMs, maxMs })).toBe(10_000);
        expect(resolveSyncFailureCooldownMs({ error: throttled, consecutiveFailures: 4, baseMs, maxMs })).toBe(40_000);
        expect(resolveSyncFailureCooldownMs({ error: throttled, consecutiveFailures: 99, baseMs, maxMs })).toBe(maxMs);


        const patient = 'CloudKit error: Service Unavailable [retryAfter=1800]';
        expect(resolveSyncFailureCooldownMs({ error: patient, consecutiveFailures: 1, baseMs, maxMs })).toBe(1_800_000);
        expect(resolveSyncFailureCooldownMs({ error: patient, consecutiveFailures: 9, baseMs, maxMs })).toBe(1_800_000);


        expect(resolveSyncFailureCooldownMs({ error: 'offline', consecutiveFailures: 1, baseMs, maxMs })).toBe(60_000);
        expect(resolveSyncFailureCooldownMs({ error: 'offline', consecutiveFailures: 3, baseMs, maxMs })).toBe(240_000);
        expect(resolveSyncFailureCooldownMs({ error: 'offline', consecutiveFailures: 99, baseMs, maxMs })).toBe(maxMs);
        expect(resolveSyncFailureCooldownMs({ consecutiveFailures: 0, baseMs, maxMs })).toBe(baseMs);
    });
});
