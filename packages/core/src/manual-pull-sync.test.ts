import { describe, expect, it, vi } from 'vitest';
import { runManualPullSync, type ManualPullSyncDeps } from './manual-pull-sync';
import { getSyncConflictCount } from './mobile-sync-utils';
import { isLikelyOfflineSyncError } from './sync-service-utils';


const deps = (overrides: Partial<ManualPullSyncDeps> = {}): ManualPullSyncDeps => ({
    getConfigurationStatus: async () => ({ configured: true, backend: 'webdav', cloudProvider: undefined }),
    getActivityState: () => 'idle',
    performSync: async () => ({ success: true }),
    isLikelyOfflineSyncError,
    getSyncConflictCount,

    t: (key) => key,
    ...overrides,
});

describe('runManualPullSync', () => {
    it('runs one manual sync and ends on success, with no toast', async () => {
        const performSync = vi.fn(async () => ({ success: true }));
        expect(await runManualPullSync(deps({ performSync }))).toEqual({ indicator: 'success', toast: null });
        expect(performSync).toHaveBeenCalledTimes(1);
    });

    it('asks for setup instead of syncing while sync is off, unless a sync already runs (#1033)', async () => {
        const performSync = vi.fn(async () => ({ success: true }));
        const off = deps({ performSync, getConfigurationStatus: async () => ({ configured: false, backend: 'webdav', cloudProvider: undefined }) });
        expect(await runManualPullSync(off)).toEqual({ indicator: 'error', toast: {
            title: 'Notice', message: 'Please set a WebDAV URL first', tone: 'warning', durationMs: 3600,
        } });
        expect(performSync).not.toHaveBeenCalled();
        expect(await runManualPullSync({ ...off, getActivityState: () => 'syncing' })).toEqual({ indicator: 'success', toast: null });
        expect(performSync).toHaveBeenCalledTimes(1);
    });

    it('tells offline from an unreachable server', async () => {
        expect((await runManualPullSync(deps({ performSync: async () => ({ success: false, skipped: 'offline' }) }))).toast?.title).toBe('Offline');
        expect((await runManualPullSync(deps({ performSync: async () => ({ success: false, skipped: 'offline', offlineCause: 'request' }) }))).toast)
            .toMatchObject({ title: 'Notice', message: expect.stringContaining("Couldn't reach the sync server") });
    });

    it('turns a failure, thrown or reported, into the error flash with its message', async () => {
        expect(await runManualPullSync(deps({ performSync: async () => { throw new Error('boom'); } }))).toEqual({ indicator: 'error', toast: {
            title: 'Sync failed', message: 'boom', tone: 'error', durationMs: 5200,
        } });
        expect((await runManualPullSync(deps({ performSync: async () => ({ success: false, error: 'Server said no' }) }))).toast?.message).toBe('Server said no');
    });

    it('ends a deferred attachment write at once, with its guidance', async () => {
        expect(await runManualPullSync(deps({ performSync: async () => ({ success: true, attachmentWriteDeferred: true }) })))
            .toMatchObject({ indicator: 'idle', toast: { message: expect.stringContaining('Some attachment changes could not finish') } });
    });
});
