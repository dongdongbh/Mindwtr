import { describe, expect, it, vi } from 'vitest';
import { canDesktopAutoSync } from './desktop-auto-sync-eligibility';

const createSyncService = (overrides: Partial<Parameters<typeof canDesktopAutoSync>[0]> = {}) => ({
    getSyncBackend: vi.fn(async () => 'off' as const),
    getSyncPath: vi.fn(async () => ''),
    getWebDavConfig: vi.fn(async () => ({ url: '' })),
    getCloudConfig: vi.fn(async () => ({ url: '' })),
    getCloudProvider: vi.fn(async () => 'selfhosted' as const),
    getDropboxAppKey: vi.fn(async () => ''),
    isDropboxConnected: vi.fn(async () => false),
    ...overrides,
});

describe('canDesktopAutoSync', () => {
    it('allows self-hosted cloud autosync when the URL is configured', async () => {
        const syncService = createSyncService({
            getSyncBackend: vi.fn(async () => 'cloud' as const),
            getCloudProvider: vi.fn(async () => 'selfhosted' as const),
            getCloudConfig: vi.fn(async () => ({ url: 'https://sync.example.com' })),
        });

        await expect(canDesktopAutoSync(syncService)).resolves.toBe(true);
        expect(syncService.getCloudConfig).toHaveBeenCalledTimes(1);
        expect(syncService.isDropboxConnected).not.toHaveBeenCalled();
    });

    it('allows Dropbox autosync when an app key is configured and connected', async () => {
        const syncService = createSyncService({
            getSyncBackend: vi.fn(async () => 'cloud' as const),
            getCloudProvider: vi.fn(async () => 'dropbox' as const),
            getDropboxAppKey: vi.fn(async () => 'dropbox-app-key'),
            isDropboxConnected: vi.fn(async () => true),
        });

        await expect(canDesktopAutoSync(syncService)).resolves.toBe(true);
        expect(syncService.getDropboxAppKey).toHaveBeenCalledTimes(1);
        expect(syncService.isDropboxConnected).toHaveBeenCalledWith('dropbox-app-key');
        expect(syncService.getCloudConfig).not.toHaveBeenCalled();
    });

    it('disables Dropbox autosync when the app key is missing or disconnected', async () => {
        const missingKeyService = createSyncService({
            getSyncBackend: vi.fn(async () => 'cloud' as const),
            getCloudProvider: vi.fn(async () => 'dropbox' as const),
            getDropboxAppKey: vi.fn(async () => '   '),
        });
        const disconnectedService = createSyncService({
            getSyncBackend: vi.fn(async () => 'cloud' as const),
            getCloudProvider: vi.fn(async () => 'dropbox' as const),
            getDropboxAppKey: vi.fn(async () => 'dropbox-app-key'),
            isDropboxConnected: vi.fn(async () => false),
        });

        await expect(canDesktopAutoSync(missingKeyService)).resolves.toBe(false);
        await expect(canDesktopAutoSync(disconnectedService)).resolves.toBe(false);
        expect(disconnectedService.isDropboxConnected).toHaveBeenCalledWith('dropbox-app-key');
    });
});
