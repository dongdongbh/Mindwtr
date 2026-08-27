import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const languageMocks = vi.hoisted(() => ({
    t: vi.fn((key: string) => key),
}));

vi.mock('../../../lib/app-log', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../lib/app-log')>();
    return {
        ...actual,
        logError: vi.fn(),
    };
});

vi.mock('../../../lib/settings-open-diagnostics', () => ({
    markSettingsOpenTrace: vi.fn(),
    measureSettingsOpenStep: vi.fn(async (_step: string, fn: () => unknown) => fn()),
}));

vi.mock('../../../contexts/language-context', () => ({
    useLanguage: () => ({ t: languageMocks.t, language: 'en' }),
}));

import {
    BackupSourceFileError,
    isConnectionAllowed,
    SYNC_LOCAL_INSECURE_URL_OPTIONS,
    type SyncBackend,
} from '@mindwtr/core';
import { SyncService } from '../../../lib/sync-service';
import { useUiStore } from '../../../store/ui-store';
import { isValidHttpUrl } from './sync/sync-page-utils';
import { useSyncSettings } from './useSyncSettings';
import * as dataTransfer from '../../../lib/data-transfer';

const initialUiState = useUiStore.getState();
const COMMITTED_RESULT = {
    committed: true,
    cleanupPending: false,
    handleFinalized: true,
} as const;
const dropboxConfigurationSnapshot = (
    backend: 'cloud' | 'off' = 'cloud',
): Awaited<ReturnType<typeof SyncService.getPersistedSyncConfigurationSnapshot>> => ({
    backend,
    syncPath: '',
    webdav: {
        url: '',
        username: '',
        password: '',
        passwordAuthority: 'known',
        hasPassword: false,
        allowInsecureHttp: false,
        allowWeakFingerprint: false,
    },
    cloudProvider: 'dropbox',
    cloud: {
        url: '',
        token: '',
        tokenAuthority: 'known',
        rememberToken: false,
        allowInsecureHttp: false,
    },
});

type TargetInputs = {
    syncBackend: SyncBackend;
    syncPath: string;
    webdavUrl: string;
    webdavAllowInsecureHttp: boolean;
    cloudUrl: string;
    cloudAllowInsecureHttp: boolean;
    cloudProvider: 'selfhosted' | 'dropbox';
    dropboxAppKey: string;
    dropboxConfigured: boolean;
    dropboxConnected: boolean;
};

/**
 * The pre-move expression, copied verbatim from SettingsSyncPage before
 * `isSyncTargetValid` was folded into useSyncSettings. Pinned here on purpose:
 * asserting the hook against the old predicate over a fixed candidate list
 * catches a branch quietly going missing, which a test that only re-derives the
 * new implementation would not.
 */
const legacyIsSyncTargetValid = (p: TargetInputs): boolean => {
    const webdavUrlError = p.webdavUrl.trim() ? !isValidHttpUrl(p.webdavUrl.trim()) : false;
    const cloudUrlError = p.cloudUrl.trim() ? !isValidHttpUrl(p.cloudUrl.trim()) : false;
    const webdavConnectionAllowed = !webdavUrlError && p.webdavUrl.trim()
        ? isConnectionAllowed(p.webdavUrl.trim(), {
            ...SYNC_LOCAL_INSECURE_URL_OPTIONS,
            allowInsecureHttp: p.webdavAllowInsecureHttp,
        })
        : !p.webdavUrl.trim();
    const cloudConnectionAllowed = !cloudUrlError && p.cloudUrl.trim()
        ? isConnectionAllowed(p.cloudUrl.trim(), {
            ...SYNC_LOCAL_INSECURE_URL_OPTIONS,
            allowInsecureHttp: p.cloudAllowInsecureHttp,
        })
        : !p.cloudUrl.trim();
    return p.syncBackend === 'file'
        ? !!p.syncPath.trim()
        : p.syncBackend === 'cloudkit'
            ? true
            : p.syncBackend === 'webdav'
                ? !!p.webdavUrl.trim() && !webdavUrlError && webdavConnectionAllowed
                : p.syncBackend === 'cloud'
                    ? (p.cloudProvider === 'selfhosted'
                        ? !!p.cloudUrl.trim() && !cloudUrlError && cloudConnectionAllowed
                        : p.dropboxConfigured && !!p.dropboxAppKey.trim() && p.dropboxConnected)
                    : false;
};

const NO_TARGET: TargetInputs = {
    syncBackend: 'off',
    syncPath: '',
    webdavUrl: '',
    webdavAllowInsecureHttp: false,
    cloudUrl: '',
    cloudAllowInsecureHttp: false,
    cloudProvider: 'selfhosted',
    dropboxAppKey: '',
    dropboxConfigured: false,
    dropboxConnected: false,
};

describe('useSyncSettings cloud token validation', () => {
    beforeEach(() => {
        languageMocks.t.mockImplementation((key: string) => key);
        SyncService.forgetPendingDropboxCredentialHandleForSession();
        act(() => {
            useUiStore.setState(initialUiState, true);
        });
        vi.spyOn(SyncService, 'getSyncPath').mockResolvedValue('');
        vi.spyOn(SyncService, 'getSyncBackend').mockResolvedValue('off');
        vi.spyOn(SyncService, 'getWebDavConfig').mockResolvedValue({
            url: '',
            username: '',
            password: '',
            hasPassword: false,
            allowInsecureHttp: false,
        });
        vi.spyOn(SyncService, 'getCloudConfig').mockResolvedValue({
            url: '',
            token: '',
            rememberToken: false,
            allowInsecureHttp: false,
        });
        vi.spyOn(SyncService, 'getCloudProvider').mockResolvedValue('selfhosted');
        vi.spyOn(SyncService, 'getDropboxAppKey').mockResolvedValue('');
        vi.spyOn(SyncService, 'getDropboxRedirectUri').mockResolvedValue('http://127.0.0.1:53682/oauth/dropbox/callback');
        vi.spyOn(SyncService, 'isDropboxConnected').mockResolvedValue(false);
        vi.spyOn(SyncService, 'connectDropbox').mockResolvedValue('opaque-candidate-handle');
        vi.spyOn(SyncService, 'discardDropboxCredentials').mockResolvedValue(undefined);
        vi.spyOn(SyncService, 'rollbackDropboxCredentials').mockResolvedValue(undefined);
        vi.spyOn(SyncService, 'disconnectDropbox').mockResolvedValue(undefined);
        vi.spyOn(SyncService, 'testDropboxConnection').mockResolvedValue(undefined);
        vi.spyOn(SyncService, 'testWebDavConnection').mockResolvedValue(undefined);
        vi.spyOn(SyncService, 'listDataSnapshots').mockResolvedValue([]);
        vi.spyOn(SyncService, 'subscribeSyncStatus').mockImplementation(() => () => {});
        vi.spyOn(SyncService, 'setSyncBackend').mockResolvedValue(undefined);
        vi.spyOn(SyncService, 'setCloudProvider').mockResolvedValue(undefined);
        vi.spyOn(SyncService, 'setCloudConfig').mockResolvedValue(undefined);
        vi.spyOn(SyncService, 'commitProvenSyncConfiguration').mockResolvedValue(COMMITTED_RESULT);
        vi.spyOn(SyncService, 'performSync').mockResolvedValue({ success: true });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    const setup = (showSaved = vi.fn(), requestConfirmation = vi.fn().mockResolvedValue(true)) => renderHook(() => useSyncSettings({
        appVersion: '1.0.0',
        isTauri: false,
        showSaved,
        selectSyncFolderTitle: 'Select folder',
        lastSyncNeverLabel: 'Never',
        requestConfirmation,
    }));

    it('uses localized copy for desktop backup completion', async () => {
        languageMocks.t.mockImplementation((key: string) => `localized:${key}`);
        const showToast = vi.fn();
        useUiStore.setState({ showToast } as never);
        vi.spyOn(dataTransfer, 'exportDesktopBackup').mockResolvedValue(undefined);

        const { result } = setup();
        await waitFor(() => expect(SyncService.getCloudConfig).toHaveBeenCalled());
        await act(async () => {
            await result.current.dataTransferProps.onExportBackup();
        });

        expect(showToast).toHaveBeenCalledWith('localized:settings.exportSuccess', 'success');
    });

    // #Q-03: the snapshot name used to appear only as text in a toast that vanished,
    // leaving Settings → snapshots → match-the-name as the only rollback.
    const setupTodoistImport = () => {
        vi.spyOn(dataTransfer, 'inspectDesktopTodoistImport').mockResolvedValue({
            valid: true,
            diagnostics: [],
            parsedProjects: [],
            preview: {
                taskCount: 1,
                projectCount: 1,
                sectionCount: 0,
                checklistItemCount: 0,
                projects: [{ name: 'Inbox', taskCount: 1 }],
                warnings: [],
            },
        } as never);
        vi.spyOn(dataTransfer, 'importDesktopTodoistData').mockResolvedValue({
            snapshotName: 'data.2026-08-13T10-00-00.000.snapshot.json',
            result: { importedTaskCount: 1, importedProjectCount: 1, warnings: [] },
        } as never);
    };

    it('offers Undo import on the result and restores that exact snapshot', async () => {
        languageMocks.t.mockImplementation((key: string) => `localized:${key}`);
        const showToast = vi.fn();
        useUiStore.setState({ showToast } as never);
        const requestConfirmation = vi.fn().mockResolvedValue(true);
        const restoreDataSnapshot = vi.spyOn(SyncService, 'restoreDataSnapshot')
            .mockResolvedValue({ success: true } as never);
        vi.spyOn(SyncService, 'listDataSnapshots').mockResolvedValue([] as never);
        setupTodoistImport();

        const { result } = setup(vi.fn(), requestConfirmation);
        await waitFor(() => expect(SyncService.getCloudConfig).toHaveBeenCalled());
        await act(async () => {
            await result.current.dataTransferProps.onImportTodoist();
        });

        const calls = showToast.mock.calls;
        const action = calls[calls.length - 1]?.[3];
        expect(action?.label).toBe('localized:settings.undoImport');

        await act(async () => {
            action.onClick();
            await Promise.resolve();
        });

        // Same weight as a manual snapshot restore, and it names the snapshot.
        const confirmCalls = requestConfirmation.mock.calls;
        const confirmCall = confirmCalls[confirmCalls.length - 1]?.[0];
        expect(confirmCall.title).toBe('localized:settings.undoImportConfirmTitle');
        expect(restoreDataSnapshot).toHaveBeenCalledWith('data.2026-08-13T10-00-00.000.snapshot.json');
    });

    it('does not restore anything when the Undo confirmation is declined', async () => {
        languageMocks.t.mockImplementation((key: string) => `localized:${key}`);
        const showToast = vi.fn();
        useUiStore.setState({ showToast } as never);
        // true for the import confirmation, false for the undo confirmation.
        const requestConfirmation = vi.fn()
            .mockResolvedValueOnce(true)
            .mockResolvedValue(false);
        const restoreDataSnapshot = vi.spyOn(SyncService, 'restoreDataSnapshot')
            .mockResolvedValue({ success: true } as never);
        vi.spyOn(SyncService, 'listDataSnapshots').mockResolvedValue([] as never);
        setupTodoistImport();

        const { result } = setup(vi.fn(), requestConfirmation);
        await waitFor(() => expect(SyncService.getCloudConfig).toHaveBeenCalled());
        await act(async () => {
            await result.current.dataTransferProps.onImportTodoist();
        });

        await act(async () => {
            showToast.mock.calls[showToast.mock.calls.length - 1]?.[3].onClick();
            await Promise.resolve();
        });

        expect(restoreDataSnapshot).not.toHaveBeenCalled();
    });

    it('exports CSV through the shared save path and reports it', async () => {
        languageMocks.t.mockImplementation((key: string) => `localized:${key}`);
        const showToast = vi.fn();
        useUiStore.setState({ showToast } as never);
        const exportCsv = vi.spyOn(dataTransfer, 'exportDesktopCsv').mockResolvedValue(undefined);

        const { result } = setup();
        await waitFor(() => expect(SyncService.getCloudConfig).toHaveBeenCalled());
        await act(async () => {
            await result.current.dataTransferProps.onExportCsv();
        });

        expect(exportCsv).toHaveBeenCalledTimes(1);
        expect(showToast).toHaveBeenCalledWith('localized:settings.exportCsvSuccess', 'success');
    });

    it('uses the active locale for sync setup feedback', async () => {
        languageMocks.t.mockImplementation((key: string) => (
            key === 'settings.sync.readyToVerify' ? 'Paramètres prêts à vérifier.' : key
        ));
        const showToast = vi.fn();
        useUiStore.setState({ showToast } as never);

        const { result } = setup();
        await waitFor(() => expect(SyncService.getCloudConfig).toHaveBeenCalled());
        act(() => result.current.syncPageProps.onSyncPathChange('/sync'));
        await act(async () => {
            await result.current.syncPageProps.onSaveSyncPath();
        });

        expect(showToast).toHaveBeenCalledWith('Paramètres prêts à vérifier.', 'info');
    });

    it('renders structured backup warnings through the active desktop locale', async () => {
        languageMocks.t.mockImplementation((key: string) => `localized:${key}`);
        const requestConfirmation = vi.fn().mockResolvedValue(false);
        vi.spyOn(dataTransfer, 'inspectDesktopBackup').mockResolvedValue({
            valid: true,
            data: { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} },
            errors: [],
            warnings: ['raw newer-version warning'],
            diagnostics: [{
                code: 'backup-newer-version',
                params: { version: '2.0.0' },
                severity: 'warning',
            }],
            metadata: { taskCount: 0, projectCount: 0, sectionCount: 0, areaCount: 0 },
        });

        const { result } = setup(vi.fn(), requestConfirmation);
        await waitFor(() => expect(SyncService.getCloudConfig).toHaveBeenCalled());
        await act(async () => {
            await result.current.dataTransferProps.onRestoreBackup();
        });

        expect(requestConfirmation.mock.calls[0]?.[0].message).toContain('localized:settings.backupDiagnostics.newerVersion');
        expect(requestConfirmation.mock.calls[0]?.[0].message).not.toContain('raw newer-version warning');
    });

    it('localizes a structured oversized-backup error on desktop', async () => {
        languageMocks.t.mockImplementation((key: string) => `localized:${key}`);
        const showToast = vi.fn();
        useUiStore.setState({ showToast } as never);
        vi.spyOn(dataTransfer, 'inspectDesktopBackup').mockRejectedValue(new BackupSourceFileError(
            'backup-source-too-large',
            'raw oversized error',
            { maxSizeMb: 128 },
        ));

        const { result } = setup();
        await waitFor(() => expect(SyncService.getCloudConfig).toHaveBeenCalled());
        await act(async () => {
            await result.current.dataTransferProps.onRestoreBackup();
        });

        expect(showToast).toHaveBeenCalledWith('localized:settings.backupDiagnostics.tooLarge', 'error');
    });

    it('keeps an explicit self-hosted save in session state until sync proves it', async () => {
        const showToast = vi.fn();
        useUiStore.setState({ showToast } as never);

        const { result } = setup();
        await waitFor(() => expect(SyncService.getCloudConfig).toHaveBeenCalled());

        act(() => {
            result.current.syncPageProps.onCloudUrlChange('https://example.com');
            result.current.syncPageProps.onCloudTokenChange('a'.repeat(24));
        });

        await act(async () => {
            await result.current.syncPageProps.onSaveCloud();
        });

        expect(SyncService.setCloudConfig).not.toHaveBeenCalled();
        expect(SyncService.setSyncBackend).not.toHaveBeenCalled();
        expect(SyncService.commitProvenSyncConfiguration).not.toHaveBeenCalled();
        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Sync now'), 'info');
    });

    it('does not let a delayed persisted snapshot overwrite newer editor intent', async () => {
        let resolveSnapshot!: (value: Awaited<ReturnType<
            typeof SyncService.getPersistedSyncConfigurationSnapshot
        >>) => void;
        const snapshotGate = new Promise<Awaited<ReturnType<
            typeof SyncService.getPersistedSyncConfigurationSnapshot
        >>>((resolve) => {
            resolveSnapshot = resolve;
        });
        vi.spyOn(SyncService, 'getPersistedSyncConfigurationSnapshot').mockReturnValue(snapshotGate);
        const { result } = setup();

        act(() => {
            void result.current.syncPageProps.onSetSyncBackend('webdav');
            result.current.syncPageProps.onSyncPathChange('/new/path');
            result.current.syncPageProps.onWebdavUrlChange('https://new.example.com/dav');
            result.current.syncPageProps.onCloudUrlChange('https://new.example.com');
            void result.current.syncPageProps.onCloudProviderChange('dropbox');
        });
        await act(async () => {
            resolveSnapshot({
                backend: 'cloud',
                syncPath: '/old/path',
                webdav: {
                    url: 'https://old.example.com/dav',
                    username: 'old-user',
                    password: 'old-password',
                    passwordAuthority: 'known',
                    hasPassword: true,
                    allowInsecureHttp: false,
                    allowWeakFingerprint: true,
                },
                cloud: {
                    url: 'https://old.example.com',
                    token: 'old-token',
                    tokenAuthority: 'known',
                    rememberToken: false,
                    allowInsecureHttp: false,
                },
                cloudProvider: 'selfhosted',
            });
            await snapshotGate;
        });

        expect(result.current.syncPageProps.syncBackend).toBe('webdav');
        expect(result.current.syncPageProps.syncPath).toBe('/new/path');
        expect(result.current.syncPageProps.webdavUrl).toBe('https://new.example.com/dav');
        expect(result.current.syncPageProps.cloudUrl).toBe('https://new.example.com');
        expect(result.current.syncPageProps.cloudProvider).toBe('dropbox');
    });

    it('rejects a short cloud token and does not save', async () => {
        const { result } = setup();
        await waitFor(() => expect(SyncService.getCloudConfig).toHaveBeenCalled());

        act(() => {
            result.current.syncPageProps.onCloudUrlChange('https://example.com');
            result.current.syncPageProps.onCloudTokenChange('short-token');
        });

        await act(async () => {
            await result.current.syncPageProps.onSaveCloud();
        });

        expect(SyncService.setCloudConfig).not.toHaveBeenCalled();
        expect(result.current.syncPageProps.syncError).toBe(
            'Sync token must be 20-512 characters using letters, numbers, or . _ ~ + / = -'
        );
    });

    it.each([
        ['offline', { success: true, skipped: 'offline' as const }],
        ['transport error', { success: false, error: 'connection failed' }],
        ['deferred write', { success: true, remoteWriteDeferred: true, error: 'retrying later' }],
        ['requeue', { success: true, skipped: 'requeued' as const }],
    ])('preserves the proven backend on %s', async (_label, syncResult) => {
        vi.mocked(SyncService.performSync).mockResolvedValueOnce(syncResult);
        const showSaved = vi.fn();
        const { result } = setup(showSaved);
        await waitFor(() => expect(SyncService.getCloudConfig).toHaveBeenCalled());

        act(() => {
            void result.current.syncPageProps.onSetSyncBackend('cloud');
            result.current.syncPageProps.onCloudUrlChange('https://example.com');
            result.current.syncPageProps.onCloudTokenChange('a'.repeat(24));
        });

        await act(async () => {
            await result.current.syncPageProps.onSyncNow();
        });

        expect(SyncService.performSync).toHaveBeenCalledWith({
            activationProbe: true,
            configOverride: expect.objectContaining({
                backend: 'cloud',
                cloudProvider: 'selfhosted',
                cloud: expect.objectContaining({ url: 'https://example.com' }),
            }),
            manual: true,
        });
        expect(SyncService.setCloudConfig).not.toHaveBeenCalled();
        expect(SyncService.setCloudProvider).not.toHaveBeenCalled();
        expect(SyncService.setSyncBackend).not.toHaveBeenCalled();
        expect(SyncService.commitProvenSyncConfiguration).not.toHaveBeenCalled();
        expect(showSaved).not.toHaveBeenCalled();
    });

    it('requires WebDAV conditional-write capability before candidate activation', async () => {
        vi.mocked(SyncService.testWebDavConnection).mockRejectedValueOnce(
            new Error('WebDAV conditional writes are not enforced'),
        );
        const { result } = setup();
        await waitFor(() => expect(SyncService.getCloudConfig).toHaveBeenCalled());

        act(() => {
            void result.current.syncPageProps.onSetSyncBackend('webdav');
            result.current.syncPageProps.onWebdavUrlChange('https://dav.example.com/mindwtr/');
            result.current.syncPageProps.onWebdavUsernameChange('alice');
            result.current.syncPageProps.onWebdavPasswordChange('secret');
        });

        await act(async () => {
            await result.current.syncPageProps.onSyncNow();
        });

        expect(SyncService.testWebDavConnection).toHaveBeenCalledWith({
            allowInsecureHttp: false,
            hasPassword: false,
            password: 'secret',
            url: 'https://dav.example.com/mindwtr/',
            username: 'alice',
        });
        expect(SyncService.performSync).not.toHaveBeenCalled();
        expect(SyncService.commitProvenSyncConfiguration).not.toHaveBeenCalled();
    });

    it('activates the configuration when the probe finds an encrypted remote it has no key for (#1001)', async () => {
        // The probe DID reach the sync location — refusing to activate would
        // deadlock joining an encrypted remote: unlock requires a durable
        // backend, and the backend could only become durable through a sync
        // that needs the key.
        vi.mocked(SyncService.performSync).mockResolvedValueOnce({
            success: false,
            error: 'SYNC_ENCRYPTION_REMOTE_ENCRYPTED: the WebDAV remote is encrypted and this device has no key',
        });
        vi.spyOn(SyncService, 'getSyncEncryptionStatus').mockResolvedValue({ state: 'remote-encrypted-no-key' });
        const { result } = setup();
        await waitFor(() => expect(SyncService.getCloudConfig).toHaveBeenCalled());

        act(() => {
            void result.current.syncPageProps.onSetSyncBackend('cloud');
            result.current.syncPageProps.onCloudUrlChange('https://example.com');
            result.current.syncPageProps.onCloudTokenChange('a'.repeat(24));
        });

        await act(async () => {
            await result.current.syncPageProps.onSyncNow();
        });

        expect(SyncService.commitProvenSyncConfiguration).toHaveBeenCalledWith(
            expect.objectContaining({ backend: 'cloud' }),
        );
        // No follow-up sync — it would only fail with the same no-key error.
        expect(SyncService.performSync).toHaveBeenCalledTimes(1);
    });

    it('does not activate on an encrypted-remote error when the persisted state disagrees', async () => {
        vi.mocked(SyncService.performSync).mockResolvedValueOnce({
            success: false,
            error: 'SYNC_ENCRYPTION_REMOTE_ENCRYPTED: the WebDAV remote is encrypted and this device has no key',
        });
        vi.spyOn(SyncService, 'getSyncEncryptionStatus').mockResolvedValue({ state: 'off' });
        const { result } = setup();
        await waitFor(() => expect(SyncService.getCloudConfig).toHaveBeenCalled());

        act(() => {
            void result.current.syncPageProps.onSetSyncBackend('cloud');
            result.current.syncPageProps.onCloudUrlChange('https://example.com');
            result.current.syncPageProps.onCloudTokenChange('a'.repeat(24));
        });

        await act(async () => {
            await result.current.syncPageProps.onSyncNow();
        });

        expect(SyncService.commitProvenSyncConfiguration).not.toHaveBeenCalled();
    });

    it('treats an empty token as "unchanged, use keyring" in the transient sync config', async () => {
        const { result } = setup();
        await waitFor(() => expect(SyncService.getCloudConfig).toHaveBeenCalled());

        act(() => {
            void result.current.syncPageProps.onSetSyncBackend('cloud');
            result.current.syncPageProps.onCloudUrlChange('https://example.com');
            result.current.syncPageProps.onCloudTokenChange('');
        });

        await act(async () => {
            await result.current.syncPageProps.onSyncNow();
        });

        expect(SyncService.performSync).toHaveBeenCalledWith(
            expect.objectContaining({
                activationProbe: true,
                configOverride: expect.objectContaining({
                    cloud: expect.objectContaining({ token: '' }),
                }),
            }),
        );
    });

    it('commits cloud credentials, provider and backend only after a successful round trip', async () => {
        const showSaved = vi.fn();
        const { result } = setup(showSaved);
        await waitFor(() => expect(SyncService.getCloudConfig).toHaveBeenCalled());

        const validToken = 'a'.repeat(24);
        act(() => {
            void result.current.syncPageProps.onSetSyncBackend('cloud');
            result.current.syncPageProps.onCloudUrlChange('https://example.com');
            result.current.syncPageProps.onCloudTokenChange(validToken);
        });

        await act(async () => {
            await result.current.syncPageProps.onSyncNow();
        });

        expect(SyncService.commitProvenSyncConfiguration).toHaveBeenCalledWith(
            expect.objectContaining({
                backend: 'cloud',
                cloudProvider: 'selfhosted',
                cloud: expect.objectContaining({ token: validToken }),
            }),
        );
        expect(SyncService.performSync).toHaveBeenCalledTimes(2);
        expect(SyncService.performSync).toHaveBeenNthCalledWith(1, {
            activationProbe: true,
            configOverride: expect.objectContaining({
                backend: 'cloud',
                cloudProvider: 'selfhosted',
            }),
            manual: true,
        });
        expect(SyncService.performSync).toHaveBeenNthCalledWith(2, {
            manual: true,
            ignorePendingRemoteWriteBackoff: true,
        });
        expect(vi.mocked(SyncService.performSync).mock.invocationCallOrder[0]).toBeLessThan(
            vi.mocked(SyncService.commitProvenSyncConfiguration).mock.invocationCallOrder[0],
        );
        expect(vi.mocked(SyncService.commitProvenSyncConfiguration).mock.invocationCallOrder[0]).toBeLessThan(
            vi.mocked(SyncService.performSync).mock.invocationCallOrder[1],
        );
        expect(showSaved).toHaveBeenCalledTimes(1);
    });

    it('lets Off supersede a gated activation probe and resolves only its captured candidate', async () => {
        vi.mocked(SyncService.getCloudProvider).mockResolvedValue('dropbox');
        vi.mocked(SyncService.getDropboxAppKey).mockResolvedValue('dropbox-app-key');
        vi.mocked(SyncService.isDropboxConnected).mockResolvedValue(true);
        SyncService.rememberPendingDropboxCredentialHandleForSession('opaque-candidate-handle');
        let releaseProbe!: () => void;
        const probeGate = new Promise<{ success: true }>((resolve) => {
            releaseProbe = () => resolve({ success: true });
        });
        vi.mocked(SyncService.performSync).mockImplementationOnce(() => probeGate);
        const showSaved = vi.fn();
        const { result } = setup(showSaved);
        await waitFor(() => {
            expect(result.current.syncPageProps.cloudProvider).toBe('dropbox');
            expect(result.current.syncPageProps.dropboxConnected).toBe(true);
        });
        await act(async () => {
            await result.current.syncPageProps.onSetSyncBackend('cloud');
        });

        let syncPromise!: Promise<void>;
        act(() => {
            syncPromise = result.current.syncPageProps.onSyncNow();
        });
        await waitFor(() => expect(SyncService.performSync).toHaveBeenCalledTimes(1));
        await act(async () => {
            await result.current.syncPageProps.onSetSyncBackend('off');
        });
        await act(async () => {
            releaseProbe();
            await syncPromise;
        });

        expect(SyncService.setSyncBackend).toHaveBeenCalledWith('off');
        expect(SyncService.commitProvenSyncConfiguration).not.toHaveBeenCalled();
        expect(SyncService.performSync).toHaveBeenCalledTimes(1);
        expect(SyncService.discardDropboxCredentials).toHaveBeenCalledWith('opaque-candidate-handle');
        expect(SyncService.getPendingDropboxCredentialHandleForSession()).toBeNull();
        expect(result.current.syncPageProps.syncBackend).toBe('off');
        expect(showSaved).toHaveBeenCalledTimes(1);
    });

    it('keeps a commit-window Off action authoritative without stale saved UI or follow-up sync', async () => {
        let releaseCommit!: () => void;
        const commitGate = new Promise<typeof COMMITTED_RESULT>((resolve) => {
            releaseCommit = () => resolve(COMMITTED_RESULT);
        });
        vi.mocked(SyncService.commitProvenSyncConfiguration).mockImplementation(() => commitGate);
        vi.mocked(SyncService.setSyncBackend).mockImplementation(async () => {
            await commitGate;
        });
        const showSaved = vi.fn();
        const { result } = setup(showSaved);
        await waitFor(() => expect(SyncService.getCloudConfig).toHaveBeenCalled());
        act(() => {
            void result.current.syncPageProps.onSetSyncBackend('cloud');
            result.current.syncPageProps.onCloudUrlChange('https://example.com');
            result.current.syncPageProps.onCloudTokenChange('a'.repeat(24));
        });

        let syncPromise!: Promise<void>;
        act(() => {
            syncPromise = result.current.syncPageProps.onSyncNow();
        });
        await waitFor(() => expect(SyncService.commitProvenSyncConfiguration).toHaveBeenCalledTimes(1));
        let disablePromise!: Promise<void>;
        act(() => {
            disablePromise = result.current.syncPageProps.onSetSyncBackend('off');
        });
        await act(async () => {
            releaseCommit();
            await Promise.all([syncPromise, disablePromise]);
        });

        expect(result.current.syncPageProps.syncBackend).toBe('off');
        expect(SyncService.performSync).toHaveBeenCalledTimes(1);
        expect(SyncService.setSyncBackend).toHaveBeenCalledWith('off');
        expect(showSaved).toHaveBeenCalledTimes(1);
    });

    it('keeps a non-Off change made during commit pending for its own activation', async () => {
        let releaseCommit!: () => void;
        const commitGate = new Promise<typeof COMMITTED_RESULT>((resolve) => {
            releaseCommit = () => resolve(COMMITTED_RESULT);
        });
        vi.mocked(SyncService.commitProvenSyncConfiguration)
            .mockImplementationOnce(() => commitGate)
            .mockResolvedValue(COMMITTED_RESULT);
        const showSaved = vi.fn();
        const { result } = setup(showSaved);
        await waitFor(() => expect(SyncService.getCloudConfig).toHaveBeenCalled());
        act(() => {
            void result.current.syncPageProps.onSetSyncBackend('cloud');
            result.current.syncPageProps.onCloudUrlChange('https://example.com');
            result.current.syncPageProps.onCloudTokenChange('a'.repeat(24));
        });

        let firstSync!: Promise<void>;
        act(() => {
            firstSync = result.current.syncPageProps.onSyncNow();
        });
        await waitFor(() => expect(SyncService.commitProvenSyncConfiguration).toHaveBeenCalledTimes(1));
        await act(async () => {
            await result.current.syncPageProps.onSetSyncBackend('webdav');
            result.current.syncPageProps.onWebdavUrlChange('https://dav.example.com');
        });
        await act(async () => {
            releaseCommit();
            await firstSync;
        });

        expect(result.current.syncPageProps.syncBackend).toBe('webdav');
        expect(SyncService.performSync).toHaveBeenCalledTimes(1);
        expect(showSaved).not.toHaveBeenCalled();

        await act(async () => {
            await result.current.syncPageProps.onSyncNow();
        });

        expect(SyncService.performSync).toHaveBeenNthCalledWith(2, {
            activationProbe: true,
            configOverride: expect.objectContaining({
                backend: 'webdav',
                webdav: expect.objectContaining({ url: 'https://dav.example.com' }),
            }),
            manual: true,
        });
        expect(SyncService.performSync).toHaveBeenCalledTimes(3);
        expect(SyncService.commitProvenSyncConfiguration).toHaveBeenCalledTimes(2);
        expect(showSaved).toHaveBeenCalledTimes(1);
    });

    it.each([
        {
            label: 'Off',
            applyNewIntent: async (result: ReturnType<typeof setup>['result']) => {
                await result.current.syncPageProps.onSetSyncBackend('off');
            },
            assertIntent: (result: ReturnType<typeof setup>['result']) => {
                expect(result.current.syncPageProps.syncBackend).toBe('off');
            },
        },
        {
            label: 'provider change',
            applyNewIntent: async (result: ReturnType<typeof setup>['result']) => {
                await result.current.syncPageProps.onCloudProviderChange('selfhosted');
            },
            assertIntent: (result: ReturnType<typeof setup>['result']) => {
                expect(result.current.syncPageProps.cloudProvider).toBe('selfhosted');
            },
        },
    ])('discards a deferred OAuth result when a later $label intent wins', async ({
        applyNewIntent,
        assertIntent,
    }) => {
        vi.mocked(SyncService.getCloudProvider).mockResolvedValue('dropbox');
        vi.mocked(SyncService.getDropboxAppKey).mockResolvedValue('dropbox-app-key');
        let resolveConnect!: () => void;
        const connectGate = new Promise<void>((resolve) => {
            resolveConnect = resolve;
        });
        vi.mocked(SyncService.connectDropbox).mockImplementation(async () => {
            await connectGate;
            SyncService.rememberPendingDropboxCredentialHandleForSession('late-candidate-handle');
            return 'late-candidate-handle';
        });
        const showToast = vi.fn();
        useUiStore.setState({ showToast } as never);
        const { result } = setup();
        await waitFor(() => expect(result.current.syncPageProps.dropboxConfigured).toBe(true));

        let connectPromise!: Promise<void>;
        act(() => {
            connectPromise = result.current.syncPageProps.onConnectDropbox();
        });
        await waitFor(() => expect(SyncService.connectDropbox).toHaveBeenCalledTimes(1));
        await act(async () => {
            await applyNewIntent(result);
        });
        await act(async () => {
            resolveConnect();
            await connectPromise;
        });

        assertIntent(result);
        expect(SyncService.discardDropboxCredentials).toHaveBeenCalledWith('late-candidate-handle');
        expect(SyncService.getPendingDropboxCredentialHandleForSession()).toBeNull();
        expect(result.current.syncPageProps.dropboxConnected).toBe(false);
        expect(showToast).not.toHaveBeenCalledWith(
            expect.stringContaining('authorization ready'),
            'info',
        );
    });

    it('skips the Dropbox connection probe while Dropbox is not the selected transport', async () => {
        vi.mocked(SyncService.getDropboxAppKey).mockResolvedValue('dropbox-app-key');
        const { result } = setup();
        await waitFor(() => expect(result.current.syncPageProps.dropboxConfigured).toBe(true));

        expect(SyncService.isDropboxConnected).not.toHaveBeenCalled();
        expect(result.current.syncPageProps.dropboxConnected).toBe(false);
    });

    it('does not publish a stale connect error after its durable connection refresh is overtaken', async () => {
        vi.mocked(SyncService.getDropboxAppKey).mockResolvedValue('dropbox-app-key');
        // The visit probe only runs while Dropbox is the selected transport.
        vi.spyOn(SyncService, 'getPersistedSyncConfigurationSnapshot')
            .mockResolvedValue(dropboxConfigurationSnapshot('cloud'));
        vi.mocked(SyncService.connectDropbox).mockRejectedValue(new Error('stale OAuth failure'));
        let resolveConnectionRefresh!: (connected: boolean) => void;
        const connectionRefreshGate = new Promise<boolean>((resolve) => {
            resolveConnectionRefresh = resolve;
        });
        vi.mocked(SyncService.isDropboxConnected)
            .mockResolvedValueOnce(false)
            .mockImplementationOnce(() => connectionRefreshGate);
        const showToast = vi.fn();
        useUiStore.setState({ showToast } as never);
        const { result } = setup();
        await waitFor(() => {
            expect(result.current.syncPageProps.dropboxConfigured).toBe(true);
            expect(SyncService.isDropboxConnected).toHaveBeenCalledTimes(1);
        });

        let connectPromise!: Promise<void>;
        act(() => {
            connectPromise = result.current.syncPageProps.onConnectDropbox();
        });
        await waitFor(() => expect(SyncService.isDropboxConnected).toHaveBeenCalledTimes(2));
        act(() => {
            result.current.syncPageProps.onSyncPathChange('/newer/intent');
        });
        await act(async () => {
            resolveConnectionRefresh(true);
            await connectPromise;
        });

        expect(result.current.syncPageProps.syncPath).toBe('/newer/intent');
        expect(result.current.syncPageProps.dropboxConnected).toBe(false);
        expect(result.current.syncPageProps.dropboxTestState).toBe('idle');
        expect(result.current.syncPageProps.syncError).toBeNull();
        expect(result.current.syncPageProps.dropboxBusy).toBe(false);
        expect(result.current.syncPageProps.dropboxAuthInProgress).toBe(false);
        expect(showToast).not.toHaveBeenCalledWith('stale OAuth failure', 'error');
    });

    it('refreshes the durable sync baselines after disconnecting an active Dropbox backend', async () => {
        vi.mocked(SyncService.getDropboxAppKey).mockResolvedValue('dropbox-app-key');
        vi.mocked(SyncService.isDropboxConnected).mockResolvedValue(true);
        vi.spyOn(SyncService, 'getPersistedSyncConfigurationSnapshot')
            .mockResolvedValueOnce(dropboxConfigurationSnapshot('cloud'))
            .mockResolvedValueOnce(dropboxConfigurationSnapshot('off'));
        const showToast = vi.fn();
        useUiStore.setState({ showToast } as never);
        const { result } = setup();
        await waitFor(() => {
            expect(result.current.syncPageProps.syncBackend).toBe('cloud');
            expect(result.current.syncPageProps.cloudProvider).toBe('dropbox');
            expect(result.current.syncPageProps.dropboxConnected).toBe(true);
        });

        await act(async () => {
            await result.current.syncPageProps.onDisconnectDropbox();
        });

        expect(SyncService.disconnectDropbox).toHaveBeenCalledWith('dropbox-app-key');
        expect(SyncService.getPersistedSyncConfigurationSnapshot).toHaveBeenCalledTimes(2);
        expect(result.current.syncPageProps.syncBackend).toBe('off');
        expect(result.current.syncPageProps.cloudProvider).toBe('dropbox');
        expect(result.current.syncPageProps.dropboxConnected).toBe(false);
        expect(result.current.syncPageProps.dropboxTestState).toBe('idle');
        expect(result.current.syncPageProps.syncError).toBeNull();
        expect(showToast).toHaveBeenCalledWith('Disconnected from Dropbox.', 'success');
    });

    it('does not overwrite newer editor intent when a queued Dropbox disconnect finishes', async () => {
        vi.mocked(SyncService.getDropboxAppKey).mockResolvedValue('dropbox-app-key');
        vi.mocked(SyncService.isDropboxConnected).mockResolvedValue(true);
        vi.spyOn(SyncService, 'getPersistedSyncConfigurationSnapshot')
            .mockResolvedValueOnce(dropboxConfigurationSnapshot('cloud'))
            .mockResolvedValueOnce(dropboxConfigurationSnapshot('off'));
        let releaseDisconnect!: () => void;
        const disconnectGate = new Promise<void>((resolve) => {
            releaseDisconnect = resolve;
        });
        vi.mocked(SyncService.disconnectDropbox).mockReturnValue(disconnectGate);
        const showToast = vi.fn();
        useUiStore.setState({ showToast } as never);
        const { result } = setup();
        await waitFor(() => expect(result.current.syncPageProps.dropboxConnected).toBe(true));

        let disconnectPromise!: Promise<void>;
        act(() => {
            disconnectPromise = result.current.syncPageProps.onDisconnectDropbox();
        });
        await waitFor(() => expect(SyncService.disconnectDropbox).toHaveBeenCalledTimes(1));
        await act(async () => {
            await result.current.syncPageProps.onCloudProviderChange('selfhosted');
        });
        await act(async () => {
            releaseDisconnect();
            await disconnectPromise;
        });

        expect(result.current.syncPageProps.syncBackend).toBe('cloud');
        expect(result.current.syncPageProps.cloudProvider).toBe('selfhosted');
        expect(result.current.syncPageProps.dropboxBusy).toBe(false);
        expect(showToast).not.toHaveBeenCalledWith('Disconnected from Dropbox.', 'success');
    });

    it('never clears a newer pending authorization while resolving a stale OAuth result', async () => {
        vi.mocked(SyncService.getCloudProvider).mockResolvedValue('dropbox');
        vi.mocked(SyncService.getDropboxAppKey).mockResolvedValue('dropbox-app-key');
        let resolveConnect!: () => void;
        const connectGate = new Promise<void>((resolve) => {
            resolveConnect = resolve;
        });
        vi.mocked(SyncService.connectDropbox).mockImplementation(async () => {
            await connectGate;
            SyncService.rememberPendingDropboxCredentialHandleForSession('stale-candidate-handle');
            SyncService.forgetPendingDropboxCredentialHandleForSession('stale-candidate-handle');
            SyncService.rememberPendingDropboxCredentialHandleForSession('newer-candidate-handle');
            return 'stale-candidate-handle';
        });
        const { result } = setup();
        await waitFor(() => expect(result.current.syncPageProps.dropboxConfigured).toBe(true));

        let connectPromise!: Promise<void>;
        act(() => {
            connectPromise = result.current.syncPageProps.onConnectDropbox();
        });
        await waitFor(() => expect(SyncService.connectDropbox).toHaveBeenCalledTimes(1));
        act(() => {
            result.current.syncPageProps.onSyncPathChange('/newer/intent');
        });
        await act(async () => {
            resolveConnect();
            await connectPromise;
        });

        expect(SyncService.discardDropboxCredentials).not.toHaveBeenCalledWith('newer-candidate-handle');
        expect(SyncService.getPendingDropboxCredentialHandleForSession()).toBe('newer-candidate-handle');
    });

    it('does not let an older backend cleanup overwrite a later backend selection', async () => {
        SyncService.rememberPendingDropboxCredentialHandleForSession('pending-handle');
        let releaseCleanup!: () => void;
        const cleanupGate = new Promise<void>((resolve) => {
            releaseCleanup = resolve;
        });
        vi.mocked(SyncService.discardDropboxCredentials).mockImplementation(() => cleanupGate);
        const { result } = setup();

        let olderSelection!: Promise<void>;
        act(() => {
            olderSelection = result.current.syncPageProps.onSetSyncBackend('file');
        });
        await waitFor(() => expect(SyncService.discardDropboxCredentials).toHaveBeenCalled());
        await act(async () => {
            await result.current.syncPageProps.onSetSyncBackend('cloud');
        });
        await act(async () => {
            releaseCleanup();
            await olderSelection;
        });

        expect(result.current.syncPageProps.syncBackend).toBe('cloud');
    });

    it('does not let an older provider cleanup overwrite a later provider selection', async () => {
        vi.mocked(SyncService.getCloudProvider).mockResolvedValue('dropbox');
        SyncService.rememberPendingDropboxCredentialHandleForSession('pending-handle');
        let releaseCleanup!: () => void;
        const cleanupGate = new Promise<void>((resolve) => {
            releaseCleanup = resolve;
        });
        vi.mocked(SyncService.discardDropboxCredentials).mockImplementation(() => cleanupGate);
        const { result } = setup();
        await waitFor(() => expect(result.current.syncPageProps.cloudProvider).toBe('dropbox'));

        let olderSelection!: Promise<void>;
        act(() => {
            olderSelection = result.current.syncPageProps.onCloudProviderChange('selfhosted');
        });
        await waitFor(() => expect(SyncService.discardDropboxCredentials).toHaveBeenCalled());
        await act(async () => {
            await result.current.syncPageProps.onCloudProviderChange('dropbox');
        });
        await act(async () => {
            releaseCleanup();
            await olderSelection;
        });

        expect(result.current.syncPageProps.cloudProvider).toBe('dropbox');
    });

    it('does not let a completed older Off write overwrite a newer non-Off choice', async () => {
        let releaseOff!: () => void;
        const offGate = new Promise<void>((resolve) => {
            releaseOff = resolve;
        });
        vi.mocked(SyncService.setSyncBackend).mockImplementation(() => offGate);
        const showSaved = vi.fn();
        const { result } = setup(showSaved);

        let offSelection!: Promise<void>;
        act(() => {
            offSelection = result.current.syncPageProps.onSetSyncBackend('off');
        });
        await waitFor(() => expect(SyncService.setSyncBackend).toHaveBeenCalledWith('off'));
        await act(async () => {
            await result.current.syncPageProps.onSetSyncBackend('file');
        });
        await act(async () => {
            releaseOff();
            await offSelection;
        });

        expect(result.current.syncPageProps.syncBackend).toBe('file');
        expect(showSaved).not.toHaveBeenCalled();
    });

    it('runs one normal sync for an already proven unchanged backend', async () => {
        vi.mocked(SyncService.getSyncBackend).mockResolvedValue('cloud');
        vi.mocked(SyncService.getCloudProvider).mockResolvedValue('selfhosted');
        vi.mocked(SyncService.getCloudConfig).mockResolvedValue({
            url: 'https://example.com',
            token: 'a'.repeat(24),
            rememberToken: false,
            allowInsecureHttp: false,
        });
        const { result } = setup();
        await waitFor(() => expect(result.current.syncPageProps.syncBackend).toBe('cloud'));

        await act(async () => {
            await result.current.syncPageProps.onSyncNow();
        });

        expect(SyncService.performSync).toHaveBeenCalledTimes(1);
        expect(SyncService.performSync).toHaveBeenCalledWith({
            manual: true,
            ignorePendingRemoteWriteBackoff: false,
        });
        expect(SyncService.setCloudConfig).not.toHaveBeenCalled();
        expect(SyncService.setSyncBackend).not.toHaveBeenCalled();
        expect(SyncService.commitProvenSyncConfiguration).not.toHaveBeenCalled();
    });

    it('promotes a same-provider Dropbox reconnect only after the staged proof succeeds', async () => {
        vi.mocked(SyncService.getSyncBackend).mockResolvedValue('cloud');
        vi.mocked(SyncService.getCloudProvider).mockResolvedValue('dropbox');
        vi.mocked(SyncService.getDropboxAppKey).mockResolvedValue('dropbox-app-key');
        vi.mocked(SyncService.isDropboxConnected).mockResolvedValue(true);
        const showSaved = vi.fn();
        const { result } = setup(showSaved);
        await waitFor(() => {
            expect(result.current.syncPageProps.syncBackend).toBe('cloud');
            expect(result.current.syncPageProps.cloudProvider).toBe('dropbox');
            expect(result.current.syncPageProps.dropboxConnected).toBe(true);
        });

        await act(async () => {
            await result.current.syncPageProps.onConnectDropbox();
        });
        await act(async () => {
            await result.current.syncPageProps.onSyncNow();
        });

        expect(SyncService.performSync).toHaveBeenNthCalledWith(1, {
            activationProbe: true,
            configOverride: {
                backend: 'cloud',
                cloudProvider: 'dropbox',
                dropboxCredentialHandle: 'opaque-candidate-handle',
            },
            manual: true,
        });
        expect(SyncService.commitProvenSyncConfiguration).toHaveBeenCalledWith({
            backend: 'cloud',
            cloudProvider: 'dropbox',
            dropboxCredentialHandle: 'opaque-candidate-handle',
        });
        expect(SyncService.discardDropboxCredentials).not.toHaveBeenCalled();
        expect(showSaved).toHaveBeenCalledTimes(1);
    });

    it('treats cleanup-pending Dropbox activation as committed without reusing its handle', async () => {
        vi.mocked(SyncService.getSyncBackend).mockResolvedValue('cloud');
        vi.mocked(SyncService.getCloudProvider).mockResolvedValue('dropbox');
        vi.mocked(SyncService.getDropboxAppKey).mockResolvedValue('dropbox-app-key');
        vi.mocked(SyncService.isDropboxConnected).mockResolvedValue(true);
        vi.mocked(SyncService.commitProvenSyncConfiguration).mockImplementation(async (config) => {
            // The real service atomically moves this handle from Candidate to
            // its private finalize-retry registry before returning this result.
            SyncService.forgetPendingDropboxCredentialHandleForSession(config.dropboxCredentialHandle);
            return {
                committed: true,
                cleanupPending: true,
                handleFinalized: false,
            };
        });
        const showSaved = vi.fn();
        const { result } = setup(showSaved);
        await waitFor(() => expect(result.current.syncPageProps.dropboxConnected).toBe(true));

        await act(async () => {
            await result.current.syncPageProps.onConnectDropbox();
        });
        await act(async () => {
            await result.current.syncPageProps.onSyncNow();
        });

        expect(showSaved).toHaveBeenCalledTimes(1);
        expect(SyncService.getPendingDropboxCredentialHandleForSession()).toBeNull();
        expect(result.current.syncPageProps.syncBackend).toBe('cloud');
        expect(result.current.syncPageProps.cloudProvider).toBe('dropbox');

        vi.mocked(SyncService.performSync).mockClear();
        vi.mocked(SyncService.commitProvenSyncConfiguration).mockClear();
        await act(async () => {
            await result.current.syncPageProps.onSyncNow();
        });

        expect(SyncService.performSync).toHaveBeenCalledTimes(1);
        expect(SyncService.performSync).toHaveBeenCalledWith({
            manual: true,
            ignorePendingRemoteWriteBackoff: false,
        });
        expect(SyncService.commitProvenSyncConfiguration).not.toHaveBeenCalled();
    });

    it('discards a failed reconnect candidate while preserving the old Dropbox connection and backend', async () => {
        vi.mocked(SyncService.getSyncBackend).mockResolvedValue('cloud');
        vi.mocked(SyncService.getCloudProvider).mockResolvedValue('dropbox');
        vi.mocked(SyncService.getDropboxAppKey).mockResolvedValue('dropbox-app-key');
        vi.mocked(SyncService.isDropboxConnected).mockResolvedValue(true);
        vi.mocked(SyncService.performSync).mockResolvedValueOnce({
            success: false,
            error: 'candidate account cannot write',
        });
        const { result } = setup();
        await waitFor(() => expect(result.current.syncPageProps.dropboxConnected).toBe(true));

        await act(async () => {
            await result.current.syncPageProps.onConnectDropbox();
        });
        await act(async () => {
            await result.current.syncPageProps.onSyncNow();
        });

        expect(SyncService.discardDropboxCredentials).toHaveBeenCalledWith('opaque-candidate-handle');
        expect(SyncService.commitProvenSyncConfiguration).not.toHaveBeenCalled();
        expect(SyncService.setSyncBackend).not.toHaveBeenCalled();
        expect(result.current.syncPageProps.dropboxConnected).toBe(true);
    });

    it('retains the staged handle when rollback cleanup fails so recovery can be retried', async () => {
        vi.mocked(SyncService.getSyncBackend).mockResolvedValue('cloud');
        vi.mocked(SyncService.getCloudProvider).mockResolvedValue('dropbox');
        vi.mocked(SyncService.getDropboxAppKey).mockResolvedValue('dropbox-app-key');
        vi.mocked(SyncService.isDropboxConnected).mockResolvedValue(true);
        vi.mocked(SyncService.commitProvenSyncConfiguration).mockRejectedValue(
            new Error('Previous Dropbox credentials could not be restored; sync remains disabled'),
        );
        vi.mocked(SyncService.discardDropboxCredentials).mockRejectedValue(
            new Error('Promoted Dropbox credentials must be rolled back, not discarded'),
        );
        vi.mocked(SyncService.rollbackDropboxCredentials).mockRejectedValue(
            new Error('Previous Dropbox credentials are still unavailable'),
        );
        const firstHook = setup();
        const { result } = firstHook;
        await waitFor(() => expect(result.current.syncPageProps.dropboxConnected).toBe(true));

        await act(async () => {
            await result.current.syncPageProps.onConnectDropbox();
        });
        await act(async () => {
            await result.current.syncPageProps.onSyncNow();
        });
        await act(async () => {
            await result.current.syncPageProps.onTestDropboxConnection();
        });
        await act(async () => {
            await result.current.syncPageProps.onConnectDropbox();
        });

        expect(SyncService.discardDropboxCredentials).toHaveBeenCalledWith('opaque-candidate-handle');
        expect(SyncService.testDropboxConnection).toHaveBeenCalledWith('dropbox-app-key', {
            credentialHandle: 'opaque-candidate-handle',
        });
        expect(SyncService.connectDropbox).toHaveBeenCalledTimes(1);

        vi.mocked(SyncService.testDropboxConnection).mockClear();
        firstHook.unmount();
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        const remounted = setup();
        await waitFor(() => {
            expect(remounted.result.current.syncPageProps.dropboxConfigured).toBe(true);
            expect(remounted.result.current.syncPageProps.dropboxConnected).toBe(true);
        });
        await act(async () => {
            await remounted.result.current.syncPageProps.onTestDropboxConnection();
        });
        expect(SyncService.testDropboxConnection).toHaveBeenCalledWith('dropbox-app-key', {
            credentialHandle: 'opaque-candidate-handle',
        });
    });

    it('clears the staged handle after a discard failure is recovered by rollback', async () => {
        vi.mocked(SyncService.getSyncBackend).mockResolvedValue('cloud');
        vi.mocked(SyncService.getCloudProvider).mockResolvedValue('dropbox');
        vi.mocked(SyncService.getDropboxAppKey).mockResolvedValue('dropbox-app-key');
        vi.mocked(SyncService.isDropboxConnected).mockResolvedValue(true);
        vi.mocked(SyncService.commitProvenSyncConfiguration).mockRejectedValue(
            new Error('Previous Dropbox credentials could not be restored; sync remains disabled'),
        );
        vi.mocked(SyncService.discardDropboxCredentials).mockRejectedValue(
            new Error('Promoted Dropbox credentials must be rolled back, not discarded'),
        );
        const { result } = setup();
        await waitFor(() => expect(result.current.syncPageProps.dropboxConnected).toBe(true));

        await act(async () => {
            await result.current.syncPageProps.onConnectDropbox();
        });
        await act(async () => {
            await result.current.syncPageProps.onSyncNow();
        });
        await act(async () => {
            await result.current.syncPageProps.onTestDropboxConnection();
        });

        expect(SyncService.rollbackDropboxCredentials).toHaveBeenCalledWith('opaque-candidate-handle');
        expect(SyncService.testDropboxConnection).toHaveBeenCalledWith('dropbox-app-key', {
            credentialHandle: undefined,
        });
    });
});

describe('useSyncSettings sync target validity', () => {
    const CASES: Array<Omit<TargetInputs, 'dropboxConfigured'>> = [
        { ...NO_TARGET, syncBackend: 'off' },
        { ...NO_TARGET, syncBackend: 'file' },
        { ...NO_TARGET, syncBackend: 'file', syncPath: '/home/user/sync' },
        { ...NO_TARGET, syncBackend: 'file', syncPath: '   ' },
        { ...NO_TARGET, syncBackend: 'cloudkit' },
        { ...NO_TARGET, syncBackend: 'webdav' },
        { ...NO_TARGET, syncBackend: 'webdav', webdavUrl: 'https://dav.example.com/remote.php' },
        { ...NO_TARGET, syncBackend: 'webdav', webdavUrl: 'not a url' },
        { ...NO_TARGET, syncBackend: 'webdav', webdavUrl: 'http://public.example.com/dav' },
        {
            ...NO_TARGET,
            syncBackend: 'webdav',
            webdavUrl: 'http://public.example.com/dav',
            webdavAllowInsecureHttp: true,
        },
        { ...NO_TARGET, syncBackend: 'webdav', webdavUrl: 'http://127.0.0.1:8080/dav' },
        { ...NO_TARGET, syncBackend: 'cloud' },
        { ...NO_TARGET, syncBackend: 'cloud', cloudUrl: 'https://cloud.example.com' },
        { ...NO_TARGET, syncBackend: 'cloud', cloudUrl: 'http://public.example.com' },
        {
            ...NO_TARGET,
            syncBackend: 'cloud',
            cloudUrl: 'http://public.example.com',
            cloudAllowInsecureHttp: true,
        },
        { ...NO_TARGET, syncBackend: 'cloud', cloudProvider: 'dropbox' },
        {
            ...NO_TARGET,
            syncBackend: 'cloud',
            cloudProvider: 'dropbox',
            dropboxAppKey: 'app-key',
            dropboxConnected: false,
        },
        {
            ...NO_TARGET,
            syncBackend: 'cloud',
            cloudProvider: 'dropbox',
            dropboxAppKey: 'app-key',
            dropboxConnected: true,
        },
    ];

    const setupCase = (input: Omit<TargetInputs, 'dropboxConfigured'>) => {
        act(() => {
            useUiStore.setState(initialUiState, true);
        });
        vi.spyOn(SyncService, 'getSyncPath').mockResolvedValue(input.syncPath);
        vi.spyOn(SyncService, 'getSyncBackend').mockResolvedValue(input.syncBackend);
        vi.spyOn(SyncService, 'getWebDavConfig').mockResolvedValue({
            url: input.webdavUrl,
            username: '',
            password: '',
            hasPassword: false,
            allowInsecureHttp: input.webdavAllowInsecureHttp,
        });
        vi.spyOn(SyncService, 'getCloudConfig').mockResolvedValue({
            url: input.cloudUrl,
            token: '',
            rememberToken: false,
            allowInsecureHttp: input.cloudAllowInsecureHttp,
        });
        vi.spyOn(SyncService, 'getCloudProvider').mockResolvedValue(input.cloudProvider);
        vi.spyOn(SyncService, 'getDropboxAppKey').mockResolvedValue(input.dropboxAppKey);
        vi.spyOn(SyncService, 'getDropboxRedirectUri').mockResolvedValue('http://127.0.0.1:53682/oauth/dropbox/callback');
        vi.spyOn(SyncService, 'isDropboxConnected').mockResolvedValue(input.dropboxConnected);
        vi.spyOn(SyncService, 'listDataSnapshots').mockResolvedValue([]);
        vi.spyOn(SyncService, 'subscribeSyncStatus').mockImplementation(() => () => {});

        return renderHook(() => useSyncSettings({
            appVersion: '1.0.0',
            isTauri: false,
            showSaved: vi.fn(),
            selectSyncFolderTitle: 'Select folder',
            lastSyncNeverLabel: 'Never',
            requestConfirmation: vi.fn().mockResolvedValue(true),
        }));
    };

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('keeps the pre-move SettingsSyncPage verdict for every backend shape', async () => {
        const verdicts: boolean[] = [];

        for (const input of CASES) {
            // `dropboxConfigured` is not stored; the hook derives it from the app key.
            const expected = legacyIsSyncTargetValid({
                ...input,
                dropboxConfigured: Boolean(input.dropboxAppKey.trim()),
            });
            const { result, unmount } = setupCase(input);

            await waitFor(() => {
                expect(result.current.syncPageProps.syncBackend).toBe(input.syncBackend);
                expect(result.current.syncPageProps.dropboxConnected).toBe(input.dropboxConnected);
            });

            expect(
                result.current.syncPageProps.isSyncTargetValid,
                `backend=${input.syncBackend} webdav=${input.webdavUrl || '-'} cloud=${input.cloudUrl || '-'} provider=${input.cloudProvider} insecure=${input.webdavAllowInsecureHttp || input.cloudAllowInsecureHttp}`,
            ).toBe(expected);

            verdicts.push(expected);
            unmount();
            vi.restoreAllMocks();
        }

        // Guards against a candidate list that has collapsed to one verdict and
        // would then agree with any implementation.
        expect(verdicts).toContain(true);
        expect(verdicts).toContain(false);
    });
});
