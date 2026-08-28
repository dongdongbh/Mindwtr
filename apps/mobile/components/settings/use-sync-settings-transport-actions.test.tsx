import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    CLOUD_PROVIDER_KEY,
    CLOUD_TOKEN_KEY,
    CLOUD_URL_KEY,
    SYNC_BACKEND_KEY,
    SYNC_PATH_KEY,
    WEBDAV_ALLOW_INSECURE_HTTP_KEY,
    WEBDAV_ALLOW_WEAK_FINGERPRINT_KEY,
    WEBDAV_PASSWORD_KEY,
    WEBDAV_URL_KEY,
    WEBDAV_USERNAME_KEY,
} from '@/lib/sync-constants';
import { useSyncSettingsTransportActions } from './use-sync-settings-transport-actions';

const mocked = vi.hoisted(() => ({
    addBreadcrumb: vi.fn(),
    assertWebdavStrongEtagSupport: vi.fn(),
    authorizeDropbox: vi.fn(),
    storageValues: new Map<string, string>(),
    secureValues: new Map<string, string>(),
    asyncStorage: {
        multiGet: vi.fn(),
        multiSet: vi.fn(),
        removeItem: vi.fn(),
        setItem: vi.fn(),
    },
    clearMobileSyncConfigCache: vi.fn(),
    clearDropboxTokens: vi.fn(),
    cloudGetJson: vi.fn(),
    disconnectDropbox: vi.fn(),
    forceRefreshDropboxAccessToken: vi.fn(),
    forceRefreshDropboxAccessTokenForTokens: vi.fn(),
    getStoredDropboxTokens: vi.fn(),
    getValidDropboxAccessToken: vi.fn(),
    getValidDropboxAccessTokenForTokens: vi.fn(),
    getSecureConfigValue: vi.fn(),
    deleteSecureConfigValue: vi.fn(),
    setSecureConfigValue: vi.fn(),
    isConnectionAllowed: vi.fn((url: string, options?: { allowInsecureHttp?: boolean }) => {
        if (options?.allowInsecureHttp) return true;
        try {
            const parsed = new URL(url);
            return parsed.protocol === 'https:' || parsed.hostname === 'nas.local';
        } catch {
            return false;
        }
    }),
    isValidCloudSyncToken: vi.fn((token: string) => /^[A-Za-z0-9._~+/=-]{20,512}$/.test(token.trim())),
    isDropboxConnected: vi.fn(),
    normalizeCloudUrl: vi.fn((url: string) => `${url.replace(/\/+$/, '')}/v1/data`),
    normalizeWebdavUrl: vi.fn((url: string) => {
        const trimmed = url.replace(/\/+$/, '');
        return trimmed.toLowerCase().endsWith('/data.json') || trimmed.toLowerCase().endsWith('.json')
            ? trimmed
            : `${trimmed}/data.json`;
    }),
    getIncompleteSyncEncryptionTransition: vi.fn(),
    isSyncEncryptionBlocked: vi.fn(async () => false),
    resetSyncStatusForBackendSwitch: vi.fn(),
    performMobileSync: vi.fn(),
    revokeDropboxTokens: vi.fn(),
    saveDropboxTokens: vi.fn(),
    syncMobileBackgroundSyncRegistration: vi.fn(),
    showSettingsErrorToast: vi.fn(),
    showSettingsWarning: vi.fn(),
    showToast: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: mocked.asyncStorage,
}));

vi.mock('@/lib/secure-config', () => ({
    deleteSecureConfigValue: mocked.deleteSecureConfigValue,
    getSecureConfigValue: mocked.getSecureConfigValue,
    setSecureConfigValue: mocked.setSecureConfigValue,
}));

// The sync-configuration commit protocol is the behaviour these storage
// assertions are about, so it is pulled in for real rather than stubbed. The
// barrel itself stays mocked: loading it here would drag in LOCALES and the
// settings-search tables at module-load time.
vi.mock('@mindwtr/core', async () => ({
    ...(await vi.importActual<typeof import('../../../../packages/core/src/sync-configuration-transaction')>(
        '../../../../packages/core/src/sync-configuration-transaction',
    )),
    ...(await vi.importActual<typeof import('../../../../packages/core/src/sync-service-utils')>(
        '../../../../packages/core/src/sync-service-utils',
    )),
    ...(await vi.importActual<typeof import('../../../../packages/core/src/sync-client-helpers')>(
        '../../../../packages/core/src/sync-client-helpers',
    )),
    addBreadcrumb: mocked.addBreadcrumb,
    assertWebdavStrongEtagSupport: mocked.assertWebdavStrongEtagSupport,
    CLOCK_SKEW_THRESHOLD_MS: 60_000,
    cloudGetJson: mocked.cloudGetJson,
    isConnectionAllowed: mocked.isConnectionAllowed,
    isSyncEncryptionRemoteVersionUnavailableError: (error: unknown) => (
        String(error ?? '').includes('SYNC_ENCRYPTION_REMOTE_VERSION_UNAVAILABLE')
    ),
    isValidCloudSyncToken: mocked.isValidCloudSyncToken,
    // ./settings.constants imports isValidHttpUrl (a value, not type-only) from this module
    // and builds LANGUAGES from LOCALES at module load time; this test doesn't exercise
    // language selection, so an empty table is enough to satisfy that load.
    LOCALES: {},
    normalizeCloudUrl: mocked.normalizeCloudUrl,
    normalizeWebdavUrl: mocked.normalizeWebdavUrl,
    // ./settings.constants also derives SETTINGS_MENU_KEYWORD_KEYS from these at module load
    // time; this test doesn't exercise settings search, so empty/pass-through stubs are enough.
    getSettingsSearchEntries: () => [],
    getSettingsSearchEntryKeys: () => [],
    resolveSettingsSearchI18nKey: (key: string) => `settings.${key}`,
    SETTINGS_SEARCH_MOBILE_EXCLUSIONS: {},
    SYNC_LOCAL_INSECURE_URL_OPTIONS: { allowLocalHostnames: true, allowPrivateIpRanges: true },
}));

vi.mock('@/lib/storage-file', () => ({
    pickAndParseSyncFolder: vi.fn(),
}));

vi.mock('@/lib/cloudkit-sync', () => ({
    getCloudKitAccountStatus: vi.fn().mockResolvedValue('available'),
}));

vi.mock('@/lib/dropbox-oauth', () => ({
    authorizeDropbox: mocked.authorizeDropbox,
    getDropboxRedirectUri: vi.fn(() => 'mindwtr://dropbox'),
}));

vi.mock('@/lib/dropbox-auth', () => ({
    clearDropboxTokens: mocked.clearDropboxTokens,
    disconnectDropbox: mocked.disconnectDropbox,
    forceRefreshDropboxAccessToken: mocked.forceRefreshDropboxAccessToken,
    forceRefreshDropboxAccessTokenForTokens: mocked.forceRefreshDropboxAccessTokenForTokens,
    getStoredDropboxTokens: mocked.getStoredDropboxTokens,
    getValidDropboxAccessToken: mocked.getValidDropboxAccessToken,
    getValidDropboxAccessTokenForTokens: mocked.getValidDropboxAccessTokenForTokens,
    isDropboxConnected: mocked.isDropboxConnected,
    revokeDropboxTokens: mocked.revokeDropboxTokens,
    saveDropboxTokens: mocked.saveDropboxTokens,
}));

vi.mock('@/lib/sync-service', () => ({
    clearMobileSyncConfigCache: mocked.clearMobileSyncConfigCache,
    performMobileSync: mocked.performMobileSync,
}));

vi.mock('@/lib/background-sync-task', () => ({
    syncMobileBackgroundSyncRegistration: mocked.syncMobileBackgroundSyncRegistration,
}));

vi.mock('@/lib/sync-service-utils', () => ({
    // Mirrors the real classifier's encryption arm closely enough for the
    // encrypted-remote activation tests: the production messages all mention
    // the passphrase or encryption.
    classifySyncFailure: (error: unknown) => (
        /SYNC_FILE_GENERATION_CORRUPT|generation remains corrupt after bounded retries/i.test(String(error ?? ''))
            ? 'fileGenerationCorrupt'
            : /passphrase|encrypt/i.test(String(error ?? ''))
                ? 'encryption'
                : 'unknown'
    ),
    coerceSupportedBackend: (backend: string, supportsNativeICloudSync: boolean) => (
        backend === 'cloudkit' && !supportsNativeICloudSync ? 'off' : backend
    ),
    getSyncConflictCount: vi.fn(() => 0),
    getSyncMaxClockSkewMs: vi.fn(() => 0),
    getSyncTimestampAdjustments: vi.fn(() => 0),
    hasSameUserFacingSyncConflictSummary: vi.fn(() => false),
    isLikelyOfflineSyncError: vi.fn(() => false),
}));

vi.mock('@/lib/sync-encryption-state', () => ({
    getIncompleteSyncEncryptionTransition: mocked.getIncompleteSyncEncryptionTransition,
    isSyncEncryptionBlocked: mocked.isSyncEncryptionBlocked,
}));

vi.mock('@/lib/dropbox-sync', () => ({
    testDropboxAccess: vi.fn(),
}));

vi.mock('@/lib/settings-utils', () => ({
    formatClockSkew: vi.fn((value: number) => `${value} ms`),
    formatError: vi.fn((error: unknown) => String(error)),
    isDropboxUnauthorizedError: vi.fn(() => false),
    logSettingsError: vi.fn(),
}));

let latestHookResult: ReturnType<typeof useSyncSettingsTransportActions> | null = null;
let tree: ReactTestRenderer | null = null;

type HarnessProps = {
    dropboxConfigured?: boolean;
    supportsNativeICloudSync?: boolean;
};

function Harness({
    dropboxConfigured = false,
    supportsNativeICloudSync = false,
}: HarnessProps) {
    latestHookResult = useSyncSettingsTransportActions({
        dropboxAppKey: 'dropbox-app-key',
        dropboxConfigured,
        getCloudKitStatusDetails: (status) => ({
            helpText: status,
            syncEnabled: status === 'available' || status === 'unknown',
        }),
        getSyncFailureToastMessage: () => 'Retry sync later.',
        isExpoGo: false,
        isFossBuild: false,
        lastSyncStats: null,
        lastSyncStatus: 'idle',
        tr: (key: string) =>
            ({
                'settings.syncMobile.connectionOk': 'Connection OK',
                'settings.syncMobile.webdavEndpointIsReachable': 'WebDAV endpoint is reachable.',
            }[key] ?? key),
        resetSyncStatusForBackendSwitch: mocked.resetSyncStatusForBackendSwitch,
        showSettingsErrorToast: mocked.showSettingsErrorToast,
        showSettingsWarning: mocked.showSettingsWarning,
        showToast: mocked.showToast,
        supportsNativeICloudSync,
        t: (key: string) => key,
    });
    return null;
}

const renderHarness = async (props?: HarnessProps) => {
    await act(async () => {
        tree = create(<Harness {...props} />);
        await Promise.resolve();
    });
};

const seedStorage = (entries: readonly (readonly [string, string])[]) => {
    mocked.storageValues.clear();
    for (const [key, value] of entries) mocked.storageValues.set(key, value);
};

const seedSecrets = (entries: readonly (readonly [string, string])[]) => {
    mocked.secureValues.clear();
    for (const [key, value] of entries) mocked.secureValues.set(key, value);
};

let storedDropboxTokens: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
} | null = null;

beforeEach(() => {
    latestHookResult = null;
    mocked.storageValues.clear();
    mocked.secureValues.clear();
    storedDropboxTokens = null;
    mocked.asyncStorage.multiGet.mockReset();
    mocked.asyncStorage.multiSet.mockReset();
    mocked.asyncStorage.removeItem.mockReset();
    mocked.asyncStorage.setItem.mockReset();
    mocked.asyncStorage.multiGet.mockImplementation(async (keys: string[]) => (
        keys.map((key) => [key, mocked.storageValues.get(key) ?? null])
    ));
    mocked.asyncStorage.multiSet.mockImplementation(async (entries: [string, string][]) => {
        for (const [key, value] of entries) mocked.storageValues.set(key, value);
    });
    mocked.asyncStorage.removeItem.mockImplementation(async (key: string) => {
        mocked.storageValues.delete(key);
    });
    mocked.asyncStorage.setItem.mockImplementation(async (key: string, value: string) => {
        mocked.storageValues.set(key, value);
    });
    mocked.getSecureConfigValue.mockReset();
    mocked.deleteSecureConfigValue.mockReset();
    mocked.setSecureConfigValue.mockReset();
    mocked.getSecureConfigValue.mockImplementation(async (key: string) => mocked.secureValues.get(key) ?? null);
    mocked.deleteSecureConfigValue.mockImplementation(async (key: string) => {
        mocked.secureValues.delete(key);
    });
    mocked.setSecureConfigValue.mockImplementation(async (key: string, value: string) => {
        mocked.secureValues.set(key, value);
    });
    mocked.addBreadcrumb.mockReset();
    mocked.assertWebdavStrongEtagSupport.mockReset();
    mocked.assertWebdavStrongEtagSupport.mockResolvedValue(undefined);
    mocked.authorizeDropbox.mockReset();
    mocked.authorizeDropbox.mockResolvedValue({
        accessToken: 'candidate-access-token',
        refreshToken: 'candidate-refresh-token',
        expiresAt: 4_102_444_800_000,
    });
    mocked.clearMobileSyncConfigCache.mockReset();
    mocked.clearDropboxTokens.mockReset();
    mocked.clearDropboxTokens.mockImplementation(async () => {
        storedDropboxTokens = null;
    });
    mocked.cloudGetJson.mockReset();
    mocked.disconnectDropbox.mockReset();
    mocked.disconnectDropbox.mockResolvedValue(undefined);
    mocked.forceRefreshDropboxAccessToken.mockReset();
    mocked.forceRefreshDropboxAccessTokenForTokens.mockReset();
    mocked.getStoredDropboxTokens.mockReset();
    mocked.getStoredDropboxTokens.mockImplementation(async () => storedDropboxTokens);
    mocked.getValidDropboxAccessToken.mockReset();
    mocked.getValidDropboxAccessTokenForTokens.mockReset();
    mocked.isDropboxConnected.mockReset();
    mocked.isDropboxConnected.mockResolvedValue(false);
    mocked.performMobileSync.mockReset();
    mocked.performMobileSync.mockResolvedValue({ success: true });
    mocked.getIncompleteSyncEncryptionTransition.mockReset();
    mocked.getIncompleteSyncEncryptionTransition.mockResolvedValue(null);
    mocked.isSyncEncryptionBlocked.mockReset();
    mocked.isSyncEncryptionBlocked.mockResolvedValue(false);
    mocked.revokeDropboxTokens.mockReset();
    mocked.revokeDropboxTokens.mockResolvedValue(undefined);
    mocked.saveDropboxTokens.mockReset();
    mocked.saveDropboxTokens.mockImplementation(async (tokens) => {
        storedDropboxTokens = { ...tokens };
    });
    mocked.normalizeWebdavUrl.mockClear();
    mocked.resetSyncStatusForBackendSwitch.mockReset();
    mocked.syncMobileBackgroundSyncRegistration.mockReset();
    mocked.syncMobileBackgroundSyncRegistration.mockResolvedValue({ action: 'unchanged' });
    mocked.showSettingsErrorToast.mockReset();
    mocked.showSettingsWarning.mockReset();
    mocked.showToast.mockReset();
});

afterEach(() => {
    if (tree) {
        act(() => {
            tree?.unmount();
        });
    }
    tree = null;
});

describe('useSyncSettingsTransportActions', () => {
    it('loads persisted transport state inside the hook and coerces unsupported CloudKit state', async () => {
        seedStorage([
            [SYNC_PATH_KEY, 'file:///sync-folder/data.json'],
            [SYNC_BACKEND_KEY, 'cloudkit'],
            [WEBDAV_URL_KEY, 'https://dav.example.com'],
            [WEBDAV_USERNAME_KEY, 'alice'],
            [CLOUD_URL_KEY, 'https://cloud.example.com'],
            [CLOUD_PROVIDER_KEY, 'cloudkit'],
        ]);
        seedSecrets([
            [WEBDAV_PASSWORD_KEY, 'secret'],
            [CLOUD_TOKEN_KEY, 'token-123'],
        ]);

        await renderHarness({ supportsNativeICloudSync: false });

        expect(latestHookResult?.syncPath).toBe('file:///sync-folder/data.json');
        expect(latestHookResult?.syncBackend).toBe('off');
        expect(latestHookResult?.cloudProvider).toBe('selfhosted');
        expect(latestHookResult?.webdavUrl).toBe('https://dav.example.com');
        expect(latestHookResult?.webdavUsername).toBe('alice');
        expect(latestHookResult?.webdavPassword).toBe('secret');
        expect(latestHookResult?.cloudUrl).toBe('https://cloud.example.com');
        expect(latestHookResult?.cloudToken).toBe('token-123');
        expect(mocked.asyncStorage.setItem).toHaveBeenCalledWith(SYNC_BACKEND_KEY, 'off');
        expect(mocked.asyncStorage.setItem).toHaveBeenCalledWith(CLOUD_PROVIDER_KEY, 'selfhosted');
    });

    it('disables a persisted Dropbox backend when this build has no Dropbox client', async () => {
        seedStorage([
            [SYNC_BACKEND_KEY, 'cloud'],
            [CLOUD_PROVIDER_KEY, 'dropbox'],
        ]);

        await renderHarness({ dropboxConfigured: false });

        expect(latestHookResult?.syncBackend).toBe('off');
        expect(latestHookResult?.cloudProvider).toBe('selfhosted');
        expect(mocked.asyncStorage.setItem).toHaveBeenCalledWith(SYNC_BACKEND_KEY, 'off');
        expect(mocked.asyncStorage.setItem).toHaveBeenCalledWith(CLOUD_PROVIDER_KEY, 'selfhosted');
    });

    it('updates hook-owned state when selecting a cloud provider and backend', async () => {
        await renderHarness({ supportsNativeICloudSync: true });

        mocked.asyncStorage.multiSet.mockClear();
        mocked.asyncStorage.setItem.mockClear();
        mocked.addBreadcrumb.mockClear();
        mocked.resetSyncStatusForBackendSwitch.mockClear();

        await act(async () => {
            latestHookResult?.handleSelectCloudProvider('cloudkit');
        });

        expect(latestHookResult?.cloudProvider).toBe('cloudkit');
        expect(latestHookResult?.syncBackend).toBe('cloudkit');
        expect(mocked.asyncStorage.multiSet).not.toHaveBeenCalled();

        await act(async () => {
            latestHookResult?.handleSelectSyncBackend('cloud');
        });

        expect(latestHookResult?.syncBackend).toBe('cloudkit');
        expect(mocked.asyncStorage.setItem).not.toHaveBeenCalledWith(SYNC_BACKEND_KEY, 'cloudkit');
        expect(mocked.addBreadcrumb).toHaveBeenCalledWith('settings:syncBackend:cloudkit');
        expect(mocked.resetSyncStatusForBackendSwitch).not.toHaveBeenCalled();
    });

    it('keeps Dropbox selection in session state until its first sync succeeds', async () => {
        await renderHarness({ dropboxConfigured: true });

        mocked.asyncStorage.multiSet.mockClear();
        mocked.resetSyncStatusForBackendSwitch.mockClear();

        await act(async () => {
            latestHookResult?.handleSelectCloudProvider('dropbox');
        });

        expect(latestHookResult?.cloudProvider).toBe('dropbox');
        expect(latestHookResult?.syncBackend).toBe('cloud');
        expect(mocked.asyncStorage.multiSet).not.toHaveBeenCalled();
        expect(mocked.resetSyncStatusForBackendSwitch).not.toHaveBeenCalled();
    });

    it('loads the legacy cloud backend plus Dropbox provider as top-level Dropbox', async () => {
        seedStorage([
            [SYNC_BACKEND_KEY, 'cloud'],
            [CLOUD_PROVIDER_KEY, 'dropbox'],
        ]);

        await renderHarness({ dropboxConfigured: true });

        expect(latestHookResult?.syncBackend).toBe('cloud');
        expect(latestHookResult?.cloudProvider).toBe('dropbox');
        expect(mocked.asyncStorage.setItem).not.toHaveBeenCalledWith(CLOUD_PROVIDER_KEY, 'selfhosted');
    });

    it('normalizes the WebDAV url before testing the mobile connection', async () => {
        await renderHarness();

        await act(async () => {
            await latestHookResult?.handleTestConnection('webdav', {
                webdav: {
                    allowInsecureHttp: false,
                    password: 'secret',
                    url: 'http://nas.local/remote.php/dav/files/alice/mindwtr/',
                    username: 'alice',
                },
            });
        });

        expect(mocked.normalizeWebdavUrl).toHaveBeenCalledWith('http://nas.local/remote.php/dav/files/alice/mindwtr/');
        expect(mocked.assertWebdavStrongEtagSupport).toHaveBeenCalledWith(
            'http://nas.local/remote.php/dav/files/alice/mindwtr/data.json',
            expect.objectContaining({
                password: 'secret',
                timeoutMs: 10_000,
                username: 'alice',
            }),
        );
        expect(mocked.assertWebdavStrongEtagSupport.mock.calls[0][1])
            .not.toMatchObject({ allowInsecureHttp: true });
        expect(mocked.showToast).toHaveBeenCalledWith(expect.objectContaining({
            message: 'WebDAV endpoint is reachable.',
            title: 'Connection OK',
            tone: 'success',
        }));
    });

    it('shows localized strong-ETag guidance when ordinary WebDAV setup is unsafe', async () => {
        mocked.assertWebdavStrongEtagSupport.mockRejectedValueOnce(
            new Error('SYNC_ENCRYPTION_REMOTE_VERSION_UNAVAILABLE: WebDAV data.json has no safe backend version'),
        );
        await renderHarness();

        await act(async () => {
            await latestHookResult?.handleTestConnection('webdav', {
                webdav: {
                    allowInsecureHttp: false,
                    password: 'secret',
                    url: 'https://dav.example.com/mindwtr',
                    username: 'alice',
                },
            });
        });

        expect(mocked.showSettingsErrorToast).toHaveBeenCalledWith(
            'settings.syncMobile.connectionFailed',
            'settings.syncEncryptionErrorBackendIncompatible',
            5200,
        );
        expect(mocked.showToast).not.toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' }));
    });

    it('reports invalid JSON from a 200 WebDAV setup response instead of accepting the endpoint', async () => {
        mocked.assertWebdavStrongEtagSupport.mockRejectedValueOnce(
            new Error('WebDAV GET failed: invalid JSON (Unexpected token <)'),
        );
        await renderHarness();

        await act(async () => {
            await latestHookResult?.handleTestConnection('webdav', {
                webdav: {
                    allowInsecureHttp: false,
                    password: 'secret',
                    url: 'https://dav.example.com/mindwtr',
                    username: 'alice',
                },
            });
        });

        expect(mocked.showSettingsErrorToast).toHaveBeenCalledWith(
            'settings.syncMobile.connectionFailed',
            'Error: WebDAV GET failed: invalid JSON (Unexpected token <)',
            5200,
        );
        expect(mocked.showToast).not.toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' }));
    });

    it('reports a deferred remote write as an error even though performMobileSync succeeded', async () => {
        mocked.performMobileSync.mockResolvedValue({
            success: true,
            remoteWriteDeferred: true,
            error: 'Remote write failed. Retrying in the background.',
        });
        await renderHarness();
        mocked.asyncStorage.multiSet.mockClear();
        mocked.setSecureConfigValue.mockClear();
        mocked.clearMobileSyncConfigCache.mockClear();
        mocked.syncMobileBackgroundSyncRegistration.mockClear();

        await act(async () => {
            await latestHookResult?.handleSync({
                backend: 'webdav',
                webdav: {
                    allowInsecureHttp: false,
                    password: 'new-secret',
                    url: 'https://dav.example.com/mindwtr/',
                    username: 'alice',
                },
            });
        });

        expect(mocked.showToast).not.toHaveBeenCalled();
        expect(mocked.showSettingsErrorToast).toHaveBeenCalledWith('settings.syncMobile.error', 'Retry sync later.');
        expect(mocked.asyncStorage.multiSet).not.toHaveBeenCalled();
        expect(mocked.setSecureConfigValue).not.toHaveBeenCalled();
        expect(mocked.clearMobileSyncConfigCache).not.toHaveBeenCalled();
        expect(mocked.syncMobileBackgroundSyncRegistration).not.toHaveBeenCalled();
    });

    it('waits without activating when a compatible peer owns the candidate sync location', async () => {
        mocked.performMobileSync.mockResolvedValueOnce({
            success: true,
            skipped: 'remoteFenceBusy',
            remoteFenceDeferred: 'busy',
            retryAfterMs: 30_000,
        });
        await renderHarness();
        mocked.asyncStorage.multiSet.mockClear();
        mocked.asyncStorage.setItem.mockClear();

        await act(async () => {
            await latestHookResult?.handleSync({
                backend: 'webdav',
                webdav: {
                    allowInsecureHttp: false,
                    password: 'new-secret',
                    url: 'https://dav.example.com/mindwtr/',
                    username: 'alice',
                },
            });
        });

        expect(mocked.asyncStorage.setItem).not.toHaveBeenCalledWith(SYNC_BACKEND_KEY, 'webdav');
        expect(mocked.asyncStorage.multiSet).not.toHaveBeenCalled();
        expect(mocked.showSettingsWarning).toHaveBeenCalledWith(
            'common.notice',
            'settings.syncRemoteBusy',
            6000,
        );
        expect(mocked.showSettingsErrorToast).not.toHaveBeenCalled();
    });

    it('waits without activating when another operation owns the candidate File Sync lock', async () => {
        seedStorage([[SYNC_PATH_KEY, 'file:///sync-folder/data.json']]);
        mocked.performMobileSync.mockResolvedValueOnce({
            success: true,
            skipped: 'fileSyncLockBusy',
            fileSyncLockDeferred: 'busy',
            retryAfterMs: 5_000,
        });
        await renderHarness();
        mocked.asyncStorage.multiSet.mockClear();
        mocked.asyncStorage.setItem.mockClear();

        await act(async () => {
            await latestHookResult?.handleSync({ backend: 'file' });
        });

        expect(mocked.asyncStorage.setItem).not.toHaveBeenCalledWith(SYNC_BACKEND_KEY, 'file');
        expect(mocked.showToast).toHaveBeenCalledWith({
            title: 'common.notice',
            message: 'settings.syncFileLockActivationBusy',
            tone: 'warning',
            durationMs: 6000,
        });
        expect(mocked.showSettingsErrorToast).not.toHaveBeenCalled();
    });

    it('does not activate a File Sync folder whose attachment generation is terminally corrupt', async () => {
        seedStorage([[SYNC_PATH_KEY, 'file:///sync-folder/data.json']]);
        mocked.performMobileSync.mockResolvedValueOnce({
            success: false,
            fileGenerationCorrupt: true,
            error: 'SYNC_FILE_GENERATION_CORRUPT',
        });
        await renderHarness();
        mocked.asyncStorage.setItem.mockClear();

        await act(async () => {
            await latestHookResult?.handleSync({ backend: 'file' });
        });

        expect(mocked.performMobileSync).toHaveBeenCalledTimes(1);
        expect(mocked.asyncStorage.setItem).not.toHaveBeenCalledWith(SYNC_BACKEND_KEY, 'file');
        expect(mocked.showSettingsErrorToast).toHaveBeenCalledWith(
            'settings.syncMobile.error',
            'settings.syncFileGenerationCorrupt',
        );
        expect(mocked.showToast).not.toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' }));
    });

    it('does not activate File Sync when a local attachment exceeds the buffered cap', async () => {
        seedStorage([[SYNC_PATH_KEY, 'file:///sync-folder/data.json']]);
        mocked.performMobileSync.mockResolvedValueOnce({
            success: false,
            fileAttachmentUploadBlocked: 'too-large',
        });
        await renderHarness();
        mocked.asyncStorage.setItem.mockClear();

        await act(async () => {
            await latestHookResult?.handleSync({ backend: 'file' });
        });

        expect(mocked.performMobileSync).toHaveBeenCalledTimes(1);
        expect(mocked.asyncStorage.setItem).not.toHaveBeenCalledWith(SYNC_BACKEND_KEY, 'file');
        expect(mocked.showSettingsErrorToast).toHaveBeenCalledWith(
            'settings.syncMobile.error',
            'settings.syncFileAttachmentTooLarge',
        );
        expect(mocked.showToast).not.toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' }));
    });

    it('commits a cleanup-deferred File Sync activation and warns without suggesting retry', async () => {
        seedStorage([[SYNC_PATH_KEY, 'file:///sync-folder/data.json']]);
        mocked.performMobileSync
            .mockResolvedValueOnce({ success: true, fileSyncLockDeferred: 'cleanup' });
        await renderHarness();

        await act(async () => {
            await latestHookResult?.handleSync({ backend: 'file' });
        });

        expect(mocked.asyncStorage.setItem).toHaveBeenLastCalledWith(SYNC_BACKEND_KEY, 'file');
        expect(mocked.performMobileSync).toHaveBeenCalledTimes(1);
        expect(mocked.showToast).toHaveBeenCalledWith({
            title: 'common.notice',
            message: 'settings.syncFileLockCleanupDeferred',
            tone: 'warning',
            durationMs: 6000,
        });
        expect(mocked.showSettingsErrorToast).not.toHaveBeenCalled();
    });

    it('commits a cleanup-deferred activation and reports completed cleanup instead of failure', async () => {
        mocked.performMobileSync.mockResolvedValueOnce({
            success: true,
            remoteFenceDeferred: 'cleanup',
            retryAfterMs: 30_000,
        });
        await renderHarness();

        await act(async () => {
            await latestHookResult?.handleSync({
                backend: 'webdav',
                webdav: {
                    allowInsecureHttp: false,
                    password: 'new-secret',
                    url: 'https://dav.example.com/mindwtr/',
                    username: 'alice',
                },
            });
        });

        expect(mocked.asyncStorage.setItem).toHaveBeenLastCalledWith(SYNC_BACKEND_KEY, 'webdav');
        expect(mocked.performMobileSync).toHaveBeenCalledTimes(1);
        expect(mocked.showSettingsWarning).toHaveBeenCalledWith(
            'common.notice',
            'settings.syncRemoteCleanupDeferred',
            6000,
        );
        expect(mocked.showSettingsErrorToast).not.toHaveBeenCalled();
    });

    it('passes WebDAV credentials transiently, then commits and refreshes background sync after success', async () => {
        await renderHarness();
        mocked.asyncStorage.multiSet.mockClear();
        mocked.setSecureConfigValue.mockClear();
        mocked.clearMobileSyncConfigCache.mockClear();
        mocked.syncMobileBackgroundSyncRegistration.mockClear();

        await act(async () => {
            await latestHookResult?.handleSync({
                backend: 'webdav',
                webdav: {
                    allowInsecureHttp: false,
                    password: 'new-secret',
                    url: 'https://dav.example.com/mindwtr/',
                    username: 'alice',
                },
            });
        });

        expect(mocked.asyncStorage.multiSet).toHaveBeenCalledWith([
            [WEBDAV_URL_KEY, 'https://dav.example.com/mindwtr/'],
            [WEBDAV_USERNAME_KEY, 'alice'],
            [WEBDAV_ALLOW_INSECURE_HTTP_KEY, 'false'],
            [WEBDAV_ALLOW_WEAK_FINGERPRINT_KEY, 'false'],
        ]);
        const backendWriteIndexes = mocked.asyncStorage.setItem.mock.calls.flatMap(
            ([key], index) => key === SYNC_BACKEND_KEY ? [index] : [],
        );
        expect(backendWriteIndexes).toHaveLength(2);
        expect(mocked.asyncStorage.setItem.mock.calls[backendWriteIndexes[0]]).toEqual([SYNC_BACKEND_KEY, 'off']);
        expect(mocked.asyncStorage.setItem.mock.calls[backendWriteIndexes[1]]).toEqual([SYNC_BACKEND_KEY, 'webdav']);
        expect(mocked.setSecureConfigValue).toHaveBeenCalledWith(WEBDAV_PASSWORD_KEY, 'new-secret');
        expect(mocked.performMobileSync).toHaveBeenCalledWith(undefined, {
            activationProbe: true,
            manual: true,
            configOverride: {
                backend: 'webdav',
                webdav: {
                    allowInsecureHttp: false,
                    password: 'new-secret',
                    url: 'https://dav.example.com/mindwtr/',
                    username: 'alice',
                },
            },
        });
        expect(mocked.clearMobileSyncConfigCache).toHaveBeenCalledTimes(3);
        expect(mocked.performMobileSync).toHaveBeenNthCalledWith(2, undefined, {
            manual: true,
            ignorePendingRemoteWriteBackoff: true,
        });
        expect(mocked.performMobileSync).toHaveBeenCalledTimes(2);
        expect(mocked.performMobileSync.mock.invocationCallOrder[0]).toBeLessThan(
            mocked.setSecureConfigValue.mock.invocationCallOrder[0]
        );
        expect(mocked.setSecureConfigValue.mock.invocationCallOrder[0]).toBeLessThan(
            mocked.performMobileSync.mock.invocationCallOrder[1]
        );
        expect(mocked.asyncStorage.setItem.mock.invocationCallOrder[backendWriteIndexes[0]]).toBeLessThan(
            mocked.asyncStorage.multiSet.mock.invocationCallOrder[0],
        );
        expect(mocked.asyncStorage.multiSet.mock.invocationCallOrder[0]).toBeLessThan(
            mocked.asyncStorage.setItem.mock.invocationCallOrder[backendWriteIndexes[1]],
        );
        expect(mocked.syncMobileBackgroundSyncRegistration).toHaveBeenCalledTimes(1);
    });

    it('activates the configuration when the probe finds an encrypted remote it has no key for (#1001)', async () => {
        // The probe DID reach the sync location — refusing to activate would
        // deadlock joining an encrypted remote: unlock requires a durable
        // backend, and the backend could only become durable through a sync
        // that needs the key.
        await renderHarness();
        mocked.performMobileSync.mockClear();
        mocked.performMobileSync.mockResolvedValueOnce({
            success: false,
            error: 'This sync folder is encrypted. Enter the sync passphrase to continue.',
            activationProof: 'remote-encrypted-no-key',
        });
        mocked.isSyncEncryptionBlocked.mockResolvedValue(true);

        await act(async () => {
            await latestHookResult?.handleSync({
                backend: 'webdav',
                webdav: {
                    allowInsecureHttp: false,
                    password: 'secret',
                    url: 'https://dav.example.com/mindwtr/',
                    username: 'alice',
                },
            });
        });

        // Committed: backend activated despite the failed probe.
        expect(mocked.asyncStorage.setItem).toHaveBeenLastCalledWith(SYNC_BACKEND_KEY, 'webdav');
        // No follow-up sync — it would only fail with the same no-key error.
        expect(mocked.performMobileSync).toHaveBeenCalledTimes(1);
        expect(mocked.showSettingsWarning).toHaveBeenCalled();
    });

    it('does not activate WebDAV when the mandatory conditional-write probe fails', async () => {
        await renderHarness();
        mocked.performMobileSync.mockClear();
        mocked.assertWebdavStrongEtagSupport.mockRejectedValueOnce(
            new Error('SYNC_ENCRYPTION_REMOTE_VERSION_UNAVAILABLE: WebDAV conditional writes are not enforced'),
        );

        await act(async () => {
            await latestHookResult?.handleSync({
                backend: 'webdav',
                webdav: {
                    allowInsecureHttp: false,
                    password: 'secret',
                    url: 'https://dav.example.com/mindwtr/',
                    username: 'alice',
                },
            });
        });

        expect(mocked.assertWebdavStrongEtagSupport).toHaveBeenCalled();
        expect(mocked.performMobileSync).not.toHaveBeenCalled();
        expect(mocked.asyncStorage.setItem).not.toHaveBeenCalledWith(SYNC_BACKEND_KEY, 'webdav');
        expect(mocked.showSettingsErrorToast).toHaveBeenCalledWith(
            'settings.syncMobile.error',
            'settings.syncEncryptionErrorBackendIncompatible',
        );
    });

    it('does not activate WebDAV while an encryption transition is incomplete', async () => {
        await renderHarness();
        mocked.asyncStorage.multiSet.mockClear();
        mocked.asyncStorage.setItem.mockClear();
        mocked.performMobileSync.mockClear();
        mocked.setSecureConfigValue.mockClear();
        mocked.getIncompleteSyncEncryptionTransition.mockResolvedValue('enable');

        await act(async () => {
            await latestHookResult?.handleSync({
                backend: 'webdav',
                webdav: {
                    allowInsecureHttp: false,
                    password: 'secret',
                    url: 'https://dav.example.com/mindwtr/',
                    username: 'alice',
                },
            });
        });

        expect(mocked.performMobileSync).toHaveBeenCalledTimes(1);
        expect(mocked.performMobileSync).toHaveBeenCalledWith(undefined, {
            activationProbe: true,
            manual: true,
            configOverride: {
                backend: 'webdav',
                webdav: {
                    allowInsecureHttp: false,
                    password: 'secret',
                    url: 'https://dav.example.com/mindwtr/',
                    username: 'alice',
                },
            },
        });
        expect(mocked.asyncStorage.setItem).not.toHaveBeenCalledWith(SYNC_BACKEND_KEY, expect.anything());
        expect(mocked.asyncStorage.multiSet).not.toHaveBeenCalled();
        expect(mocked.setSecureConfigValue).not.toHaveBeenCalled();
        expect(mocked.showSettingsErrorToast).toHaveBeenCalledWith(
            'settings.syncMobile.error',
            'Retry sync later.',
        );
    });

    it('does not activate from stale blocked state when the candidate produced no encryption proof', async () => {
        await renderHarness();
        mocked.performMobileSync.mockClear();
        mocked.performMobileSync.mockResolvedValueOnce({
            success: false,
            error: 'This sync folder is encrypted. Enter the sync passphrase to continue.',
        });
        mocked.isSyncEncryptionBlocked.mockResolvedValue(true);

        await act(async () => {
            await latestHookResult?.handleSync({
                backend: 'webdav',
                webdav: {
                    allowInsecureHttp: false,
                    password: 'wrong-secret',
                    url: 'https://candidate.example.com/mindwtr/',
                    username: 'alice',
                },
            });
        });

        expect(mocked.asyncStorage.setItem).not.toHaveBeenLastCalledWith(SYNC_BACKEND_KEY, 'webdav');
        expect(mocked.performMobileSync).toHaveBeenCalledTimes(1);
    });

    it('does not activate on an encryption failure without persisted no-key evidence', async () => {
        await renderHarness();
        mocked.performMobileSync.mockClear();
        mocked.performMobileSync.mockResolvedValueOnce({
            success: false,
            error: 'This sync folder is encrypted. Enter the sync passphrase to continue.',
        });
        mocked.isSyncEncryptionBlocked.mockResolvedValue(false);

        await act(async () => {
            await latestHookResult?.handleSync({
                backend: 'webdav',
                webdav: {
                    allowInsecureHttp: false,
                    password: 'secret',
                    url: 'https://dav.example.com/mindwtr/',
                    username: 'alice',
                },
            });
        });

        expect(mocked.asyncStorage.setItem).not.toHaveBeenLastCalledWith(SYNC_BACKEND_KEY, 'webdav');
        expect(mocked.performMobileSync).toHaveBeenCalledTimes(1);
    });

    it('runs one normal sync for an already proven unchanged backend', async () => {
        seedStorage([
            [SYNC_BACKEND_KEY, 'webdav'],
            [WEBDAV_URL_KEY, 'https://dav.example.com/mindwtr/'],
            [WEBDAV_USERNAME_KEY, 'alice'],
            [WEBDAV_ALLOW_INSECURE_HTTP_KEY, 'false'],
        ]);
        seedSecrets([[WEBDAV_PASSWORD_KEY, 'persisted-secret']]);
        await renderHarness();
        mocked.asyncStorage.multiSet.mockClear();
        mocked.performMobileSync.mockClear();

        await act(async () => {
            await latestHookResult?.handleSync();
        });

        expect(mocked.performMobileSync).toHaveBeenCalledTimes(1);
        expect(mocked.performMobileSync).toHaveBeenCalledWith(undefined, {
            manual: true,
            ignorePendingRemoteWriteBackoff: false,
        });
        expect(mocked.asyncStorage.multiSet).not.toHaveBeenCalled();
        expect(mocked.setSecureConfigValue).not.toHaveBeenCalled();
    });

    it('shows attachment recovery guidance instead of success for an already proven backend', async () => {
        seedStorage([
            [SYNC_BACKEND_KEY, 'webdav'],
            [WEBDAV_URL_KEY, 'https://dav.example.com/mindwtr/'],
            [WEBDAV_USERNAME_KEY, 'alice'],
            [WEBDAV_ALLOW_INSECURE_HTTP_KEY, 'false'],
        ]);
        seedSecrets([[WEBDAV_PASSWORD_KEY, 'persisted-secret']]);
        await renderHarness();
        mocked.performMobileSync.mockClear();
        mocked.performMobileSync.mockResolvedValueOnce({
            success: true,
            attachmentWriteDeferred: true,
        });

        await act(async () => {
            await latestHookResult?.handleSync();
        });

        expect(mocked.showSettingsWarning).toHaveBeenCalledWith(
            'common.notice',
            'settings.syncAttachmentWriteDeferred',
            6000,
        );
        expect(mocked.showToast).not.toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' }));
    });

    it('shows terminal corrupt-generation recovery guidance without a success toast', async () => {
        seedStorage([
            [SYNC_BACKEND_KEY, 'file'],
            [SYNC_PATH_KEY, 'file:///sync-folder/data.json'],
        ]);
        await renderHarness();
        mocked.performMobileSync.mockClear();
        mocked.performMobileSync.mockResolvedValueOnce({
            success: false,
            fileGenerationCorrupt: true,
            error: 'SYNC_FILE_GENERATION_CORRUPT',
        });

        await act(async () => {
            await latestHookResult?.handleSync();
        });

        expect(mocked.performMobileSync).toHaveBeenCalledTimes(1);
        expect(mocked.showSettingsErrorToast).toHaveBeenCalledWith(
            'settings.syncMobile.error',
            'settings.syncFileGenerationCorrupt',
        );
        expect(mocked.showToast).not.toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' }));
    });

    it('shows actionable File Sync size guidance without a success toast for an active backend', async () => {
        seedStorage([
            [SYNC_BACKEND_KEY, 'file'],
            [SYNC_PATH_KEY, 'file:///sync-folder/data.json'],
        ]);
        await renderHarness();
        mocked.performMobileSync.mockClear();
        mocked.performMobileSync.mockResolvedValueOnce({
            success: true,
            fileAttachmentUploadBlocked: 'too-large',
        });

        await act(async () => {
            await latestHookResult?.handleSync();
        });

        expect(mocked.showSettingsWarning).toHaveBeenCalledWith(
            'common.notice',
            'settings.syncFileAttachmentTooLarge',
            6000,
        );
        expect(mocked.showToast).not.toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' }));
    });

    it.each([
        {
            outcome: 'failed',
            result: { success: false, error: 'Document sync failed.' },
        },
        {
            outcome: 'deferred',
            result: {
                success: true,
                remoteWriteDeferred: true,
                error: 'Remote write failed. Retrying in the background.',
            },
        },
    ])('prioritizes a $outcome document sync result over attachment guidance', async ({ result }) => {
        seedStorage([
            [SYNC_BACKEND_KEY, 'webdav'],
            [WEBDAV_URL_KEY, 'https://dav.example.com/mindwtr/'],
            [WEBDAV_USERNAME_KEY, 'alice'],
            [WEBDAV_ALLOW_INSECURE_HTTP_KEY, 'false'],
        ]);
        seedSecrets([[WEBDAV_PASSWORD_KEY, 'persisted-secret']]);
        await renderHarness();
        mocked.performMobileSync.mockClear();
        mocked.performMobileSync.mockResolvedValueOnce({
            ...result,
            fileAttachmentUploadBlocked: 'too-large',
        });

        await act(async () => {
            await latestHookResult?.handleSync();
        });

        expect(mocked.showSettingsErrorToast).toHaveBeenCalledWith(
            'settings.syncMobile.error',
            'Retry sync later.',
        );
        expect(mocked.showSettingsWarning).not.toHaveBeenCalledWith(
            'common.notice',
            'settings.syncFileAttachmentTooLarge',
            6000,
        );
        expect(mocked.showToast).not.toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' }));
    });

    it.each([
        ['offline', { success: true, skipped: 'offline', offlineCause: 'network' }],
        ['transport error', { success: false, error: 'request failed' }],
        ['requeue', { success: true, skipped: 'requeued' }],
    ])('preserves persisted WebDAV settings on %s', async (_label, syncResult) => {
        mocked.performMobileSync.mockResolvedValue(syncResult);
        await renderHarness();
        mocked.asyncStorage.multiSet.mockClear();
        mocked.setSecureConfigValue.mockClear();
        mocked.clearMobileSyncConfigCache.mockClear();
        mocked.syncMobileBackgroundSyncRegistration.mockClear();

        await act(async () => {
            await latestHookResult?.handleSync({
                backend: 'webdav',
                webdav: {
                    allowInsecureHttp: false,
                    password: 'pending-secret',
                    url: 'https://pending.example.com',
                    username: 'pending-user',
                },
            });
        });

        expect(mocked.asyncStorage.multiSet).not.toHaveBeenCalled();
        expect(mocked.setSecureConfigValue).not.toHaveBeenCalled();
        expect(mocked.clearMobileSyncConfigCache).not.toHaveBeenCalled();
        expect(mocked.syncMobileBackgroundSyncRegistration).not.toHaveBeenCalled();
        if (_label === 'requeue') {
            expect(mocked.showSettingsWarning).toHaveBeenCalledWith(
                'common.notice',
                'settings.syncActivationRequeuedBody',
                4200,
            );
            expect(mocked.showSettingsWarning).not.toHaveBeenCalledWith(
                'settings.syncQueued',
                'settings.syncQueuedBody',
                expect.anything(),
            );
        }
    });

    it('rejects a self-hosted token that is too short and does not persist it', async () => {
        await renderHarness();

        await act(async () => {
            await latestHookResult?.handleSaveSelfHostedSettings({
                allowInsecureHttp: false,
                token: 'too-short',
                url: 'https://cloud.example.com',
            });
        });

        expect(mocked.asyncStorage.multiSet).not.toHaveBeenCalled();
        expect(mocked.setSecureConfigValue).not.toHaveBeenCalled();
        expect(mocked.showSettingsWarning).toHaveBeenCalledWith(
            'settings.syncMobile.error',
            'settings.cloudTokenInvalid'
        );
    });

    it('stages self-hosted settings with an empty token without persisting them', async () => {
        await renderHarness();

        await act(async () => {
            await latestHookResult?.handleSaveSelfHostedSettings({
                allowInsecureHttp: false,
                token: '',
                url: 'https://cloud.example.com',
            });
        });

        expect(mocked.showSettingsWarning).not.toHaveBeenCalled();
        expect(latestHookResult?.cloudToken).toBe('');
        expect(latestHookResult?.cloudUrl).toBe('https://cloud.example.com');
        expect(mocked.setSecureConfigValue).not.toHaveBeenCalled();
        expect(mocked.asyncStorage.multiSet).not.toHaveBeenCalled();
    });

    it('stages a valid self-hosted token without claiming it is persisted', async () => {
        await renderHarness();
        const validToken = 'a'.repeat(24);

        await act(async () => {
            await latestHookResult?.handleSaveSelfHostedSettings({
                allowInsecureHttp: false,
                token: validToken,
                url: 'https://cloud.example.com',
            });
        });

        expect(mocked.showSettingsWarning).not.toHaveBeenCalled();
        expect(latestHookResult?.cloudToken).toBe(validToken);
        expect(mocked.setSecureConfigValue).not.toHaveBeenCalled();
        expect(mocked.asyncStorage.multiSet).not.toHaveBeenCalled();
        expect(mocked.showToast).not.toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' }));
    });

    it('activates Dropbox sync on connect without a manual Sync now tap', async () => {
        // #1033: Android's OAuth redirect deep link can unmount the settings
        // screen, so connect itself must probe and commit — a fresh install
        // must end up with a persisted, enabled Dropbox backend.
        await renderHarness({ dropboxConfigured: true });

        await act(async () => {
            await latestHookResult?.handleConnectDropbox();
        });

        expect(mocked.performMobileSync).toHaveBeenNthCalledWith(1, undefined, {
            activationProbe: true,
            manual: true,
            configOverride: {
                backend: 'cloud',
                cloudProvider: 'dropbox',
                dropbox: {
                    tokens: {
                        accessToken: 'candidate-access-token',
                        refreshToken: 'candidate-refresh-token',
                        expiresAt: 4_102_444_800_000,
                    },
                },
            },
        });
        expect(mocked.storageValues.get(SYNC_BACKEND_KEY)).toBe('cloud');
        expect(mocked.storageValues.get(CLOUD_PROVIDER_KEY)).toBe('dropbox');
        expect(storedDropboxTokens).toEqual({
            accessToken: 'candidate-access-token',
            refreshToken: 'candidate-refresh-token',
            expiresAt: 4_102_444_800_000,
        });
        expect(latestHookResult?.syncBackend).toBe('cloud');
    });

    it('proves a reconnected Dropbox account with staged tokens before promoting them', async () => {
        const candidateTokens = {
            accessToken: 'candidate-access-token',
            refreshToken: 'candidate-refresh-token',
            expiresAt: 4_102_444_800_000,
        };
        seedStorage([
            [SYNC_BACKEND_KEY, 'cloud'],
            [CLOUD_PROVIDER_KEY, 'dropbox'],
        ]);
        mocked.isDropboxConnected.mockResolvedValue(true);
        mocked.authorizeDropbox.mockResolvedValue(candidateTokens);
        await renderHarness({ dropboxConfigured: true });
        mocked.asyncStorage.multiSet.mockClear();
        mocked.performMobileSync.mockClear();

        await act(async () => {
            await latestHookResult?.handleConnectDropbox();
        });

        expect(mocked.performMobileSync).toHaveBeenNthCalledWith(1, undefined, {
            activationProbe: true,
            manual: true,
            configOverride: {
                backend: 'cloud',
                cloudProvider: 'dropbox',
                dropbox: { tokens: candidateTokens },
            },
        });
        expect(mocked.saveDropboxTokens).toHaveBeenCalledWith(candidateTokens);
        expect(mocked.performMobileSync.mock.invocationCallOrder[0]).toBeLessThan(
            mocked.saveDropboxTokens.mock.invocationCallOrder[0],
        );
        expect(mocked.saveDropboxTokens.mock.invocationCallOrder[0]).toBeLessThan(
            mocked.performMobileSync.mock.invocationCallOrder[1],
        );
        expect(mocked.asyncStorage.setItem).toHaveBeenCalledWith(CLOUD_PROVIDER_KEY, 'dropbox');
        expect(mocked.asyncStorage.setItem).toHaveBeenNthCalledWith(1, SYNC_BACKEND_KEY, 'off');
        expect(mocked.asyncStorage.setItem).toHaveBeenLastCalledWith(SYNC_BACKEND_KEY, 'cloud');
    });

    it('promotes the refreshed candidate bundle produced by the activation probe', async () => {
        const candidateTokens = {
            accessToken: 'candidate-access-token',
            refreshToken: 'candidate-refresh-token',
            expiresAt: 4_102_444_800_000,
        };
        const refreshedTokens = {
            accessToken: 'refreshed-access-token',
            refreshToken: 'candidate-refresh-token',
            expiresAt: 4_102_448_400_000,
        };
        seedStorage([
            [SYNC_BACKEND_KEY, 'cloud'],
            [CLOUD_PROVIDER_KEY, 'dropbox'],
        ]);
        mocked.isDropboxConnected.mockResolvedValue(true);
        mocked.authorizeDropbox.mockResolvedValue(candidateTokens);
        await renderHarness({ dropboxConfigured: true });

        let probeAccessToken: string | undefined;
        mocked.performMobileSync.mockImplementationOnce(async (
            _syncPath: string | undefined,
            request?: { configOverride?: { dropbox?: { tokens: typeof candidateTokens } } },
        ) => {
            probeAccessToken = request?.configOverride?.dropbox?.tokens.accessToken;
            if (request?.configOverride?.dropbox) {
                request.configOverride.dropbox.tokens = refreshedTokens;
            }
            return { success: true };
        });

        await act(async () => {
            await latestHookResult?.handleConnectDropbox();
        });

        expect(probeAccessToken).toBe('candidate-access-token');
        expect(mocked.saveDropboxTokens).toHaveBeenCalledWith(refreshedTokens);
        expect(mocked.saveDropboxTokens).not.toHaveBeenCalledWith(candidateTokens);
    });

    it('does not promote reconnected Dropbox tokens when the candidate proof fails', async () => {
        const candidateTokens = {
            accessToken: 'rejected-access-token',
            refreshToken: 'rejected-refresh-token',
            expiresAt: 4_102_444_800_000,
        };
        seedStorage([
            [SYNC_BACKEND_KEY, 'cloud'],
            [CLOUD_PROVIDER_KEY, 'dropbox'],
        ]);
        mocked.isDropboxConnected.mockResolvedValue(true);
        mocked.authorizeDropbox.mockResolvedValue(candidateTokens);
        mocked.performMobileSync.mockResolvedValue({ success: false, error: 'candidate rejected' });
        await renderHarness({ dropboxConfigured: true });
        mocked.asyncStorage.multiSet.mockClear();

        await act(async () => {
            await latestHookResult?.handleConnectDropbox();
        });

        expect(mocked.performMobileSync).toHaveBeenCalledWith(undefined, {
            activationProbe: true,
            manual: true,
            configOverride: {
                backend: 'cloud',
                cloudProvider: 'dropbox',
                dropbox: { tokens: candidateTokens },
            },
        });
        expect(mocked.saveDropboxTokens).not.toHaveBeenCalled();
        expect(mocked.asyncStorage.multiSet).not.toHaveBeenCalled();
    });

    it('disables an active Dropbox backend before revoking its credentials', async () => {
        seedStorage([
            [SYNC_BACKEND_KEY, 'cloud'],
            [CLOUD_PROVIDER_KEY, 'dropbox'],
        ]);
        mocked.isDropboxConnected.mockResolvedValue(true);
        await renderHarness({ dropboxConfigured: true });
        await act(async () => {
            await latestHookResult?.handleConnectDropbox();
        });
        mocked.asyncStorage.setItem.mockClear();
        mocked.clearMobileSyncConfigCache.mockClear();
        mocked.disconnectDropbox.mockClear();
        mocked.revokeDropboxTokens.mockClear();

        await act(async () => {
            await latestHookResult?.handleDisconnectDropbox();
        });

        expect(mocked.asyncStorage.setItem).toHaveBeenCalledWith(SYNC_BACKEND_KEY, 'off');
        expect(mocked.asyncStorage.setItem.mock.invocationCallOrder[0]).toBeLessThan(
            mocked.disconnectDropbox.mock.invocationCallOrder[0],
        );
        expect(mocked.clearMobileSyncConfigCache.mock.invocationCallOrder[0]).toBeLessThan(
            mocked.disconnectDropbox.mock.invocationCallOrder[0],
        );
        // Connect promoted the staged tokens into the durable bundle, so the
        // staged-revoke path is empty; disconnectDropbox owns revocation.
        expect(mocked.revokeDropboxTokens).not.toHaveBeenCalled();
        expect(mocked.disconnectDropbox).toHaveBeenCalledWith('dropbox-app-key');
        expect(latestHookResult?.syncBackend).toBe('off');
    });

    it('keeps staged Dropbox tokens revocable when disconnecting after a failed activation', async () => {
        seedStorage([
            [SYNC_BACKEND_KEY, 'cloud'],
            [CLOUD_PROVIDER_KEY, 'dropbox'],
        ]);
        mocked.isDropboxConnected.mockResolvedValue(true);
        mocked.performMobileSync.mockResolvedValue({ success: false, error: 'activation rejected' });
        await renderHarness({ dropboxConfigured: true });
        await act(async () => {
            await latestHookResult?.handleConnectDropbox();
        });
        mocked.revokeDropboxTokens.mockClear();

        await act(async () => {
            await latestHookResult?.handleDisconnectDropbox();
        });

        expect(mocked.revokeDropboxTokens).toHaveBeenCalledWith(
            'dropbox-app-key',
            expect.objectContaining({ accessToken: 'candidate-access-token' }),
        );
        expect(mocked.revokeDropboxTokens.mock.invocationCallOrder[0]).toBeLessThan(
            mocked.disconnectDropbox.mock.invocationCallOrder[0],
        );
        expect(latestHookResult?.syncBackend).toBe('off');
    });

    it('restores the proven backend after disconnecting a failed staged Dropbox activation', async () => {
        seedStorage([
            [SYNC_BACKEND_KEY, 'off'],
            [CLOUD_PROVIDER_KEY, 'selfhosted'],
        ]);
        mocked.performMobileSync.mockResolvedValue({ success: false, error: 'activation rejected' });
        await renderHarness({ dropboxConfigured: true });

        await act(async () => {
            await latestHookResult?.handleConnectDropbox();
        });
        expect(latestHookResult?.syncBackend).toBe('cloud');
        expect(latestHookResult?.cloudProvider).toBe('dropbox');

        await act(async () => {
            await latestHookResult?.handleDisconnectDropbox();
        });

        expect(latestHookResult?.syncBackend).toBe('off');
        expect(latestHookResult?.cloudProvider).toBe('selfhosted');
        expect(mocked.asyncStorage.setItem).not.toHaveBeenCalledWith(SYNC_BACKEND_KEY, 'off');
    });

    it('clears local Dropbox credentials even when this build cannot revoke them', async () => {
        storedDropboxTokens = {
            accessToken: 'stored-access-token',
            refreshToken: 'stored-refresh-token',
            expiresAt: 4_102_444_800_000,
        };
        await renderHarness({ dropboxConfigured: false });
        mocked.clearDropboxTokens.mockClear();

        await act(async () => {
            await latestHookResult?.handleDisconnectDropbox();
        });

        expect(mocked.clearDropboxTokens).toHaveBeenCalledOnce();
        expect(mocked.disconnectDropbox).not.toHaveBeenCalled();
        expect(latestHookResult?.dropboxConnected).toBe(false);
    });
});
