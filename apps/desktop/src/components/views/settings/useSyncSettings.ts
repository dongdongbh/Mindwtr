import { useCallback, useEffect, useState } from 'react';
import { SyncService, type CloudProvider } from '../../../lib/sync-service';
import { useUiStore } from '../../../store/ui-store';
import { logError } from '../../../lib/app-log';
import { markSettingsOpenTrace, measureSettingsOpenStep } from '../../../lib/settings-open-diagnostics';
import type { SyncBackend } from '@mindwtr/core';

export type { SyncBackend };
export type DropboxTestState = 'idle' | 'success' | 'error';
export type WebDavTestState = 'idle' | 'success' | 'error';

type UseSyncSettingsOptions = {
    isTauri: boolean;
    showSaved: () => void;
    selectSyncFolderTitle: string;
};

export const useSyncSettings = ({ isTauri, showSaved, selectSyncFolderTitle }: UseSyncSettingsOptions) => {
    const [syncPath, setSyncPath] = useState('');
    const [syncStatus, setSyncStatus] = useState(() => SyncService.getSyncStatus());
    const [syncError, setSyncError] = useState<string | null>(null);
    const [syncBackend, setSyncBackend] = useState<SyncBackend>('off');
    const [webdavUrl, setWebdavUrl] = useState('');
    const [webdavUsername, setWebdavUsername] = useState('');
    const [webdavPassword, setWebdavPassword] = useState('');
    const [webdavHasPassword, setWebdavHasPassword] = useState(false);
    const [isSavingWebDav, setIsSavingWebDav] = useState(false);
    const [isTestingWebDav, setIsTestingWebDav] = useState(false);
    const [webdavTestState, setWebdavTestState] = useState<WebDavTestState>('idle');
    const [cloudUrl, setCloudUrl] = useState('');
    const [cloudToken, setCloudToken] = useState('');
    const [cloudProvider, setCloudProvider] = useState<CloudProvider>('selfhosted');
    const [dropboxAppKey, setDropboxAppKey] = useState('');
    const [dropboxConfigured, setDropboxConfigured] = useState(false);
    const [dropboxConnected, setDropboxConnected] = useState(false);
    const [dropboxBusy, setDropboxBusy] = useState(false);
    const [dropboxRedirectUri, setDropboxRedirectUri] = useState('http://127.0.0.1:53682/oauth/dropbox/callback');
    const [dropboxTestState, setDropboxTestState] = useState<DropboxTestState>('idle');
    const [snapshots, setSnapshots] = useState<string[]>([]);
    const [isLoadingSnapshots, setIsLoadingSnapshots] = useState(false);
    const [isRestoringSnapshot, setIsRestoringSnapshot] = useState(false);
    const showToast = useUiStore((state) => state.showToast);

    const formatSyncPathError = useCallback((message?: string): string => {
        const normalized = (message || '').toLowerCase();
        if (normalized.includes('must be a directory')) {
            return 'Select a folder for sync, not a backup JSON file.';
        }
        if (normalized.includes('permission denied') || normalized.includes('operation not permitted')) {
            return 'Mindwtr cannot access this folder. Choose a folder you own, then try again.';
        }
        return message || 'Failed to save sync folder.';
    }, []);

    const toErrorMessage = useCallback((error: unknown, fallback: string): string => {
        if (error instanceof Error && error.message.trim()) return error.message.trim();
        const text = String(error || '').trim();
        return text || fallback;
    }, []);

    useEffect(() => {
        markSettingsOpenTrace('sync-settings-effect');
        const unsubscribe = SyncService.subscribeSyncStatus(setSyncStatus);
        const loadSnapshots = async () => {
            if (!isTauri) return;
            setIsLoadingSnapshots(true);
            try {
                setSnapshots(await measureSettingsOpenStep('sync-load-snapshots', () => SyncService.listDataSnapshots()));
            } finally {
                setIsLoadingSnapshots(false);
            }
        };
        measureSettingsOpenStep('sync-load-path', () => SyncService.getSyncPath())
            .then(setSyncPath)
            .catch((error) => {
                setSyncError('Failed to load sync path.');
                void logError(error, { scope: 'sync', step: 'loadPath' });
            });
        measureSettingsOpenStep('sync-load-backend', () => SyncService.getSyncBackend())
            .then(setSyncBackend)
            .catch((error) => {
                setSyncError('Failed to load sync backend.');
                void logError(error, { scope: 'sync', step: 'loadBackend' });
            });
        measureSettingsOpenStep('sync-load-webdav', () => SyncService.getWebDavConfig({ silent: true }))
            .then((cfg) => {
                setWebdavUrl(cfg.url);
                setWebdavUsername(cfg.username);
                setWebdavPassword(cfg.password ?? '');
                setWebdavHasPassword(cfg.hasPassword === true);
            })
            .catch((error) => {
                setSyncError('Failed to load WebDAV config.');
                void logError(error, { scope: 'sync', step: 'loadWebDav' });
            });
        measureSettingsOpenStep('sync-load-cloud', () => SyncService.getCloudConfig({ silent: true }))
            .then((cfg) => {
                setCloudUrl(cfg.url);
                setCloudToken(cfg.token);
            })
            .catch((error) => {
                setSyncError('Failed to load Cloud config.');
                void logError(error, { scope: 'sync', step: 'loadCloud' });
            });
        measureSettingsOpenStep('sync-load-cloud-provider', () => SyncService.getCloudProvider())
            .then(setCloudProvider)
            .catch((error) => {
                setSyncError('Failed to load cloud provider.');
                void logError(error, { scope: 'sync', step: 'loadCloudProvider' });
            });
        measureSettingsOpenStep('sync-load-dropbox-app-key', () => SyncService.getDropboxAppKey())
            .then((value) => {
                const trimmed = value.trim();
                setDropboxAppKey(trimmed);
                setDropboxConfigured(Boolean(trimmed));
            })
            .catch((error) => {
                setDropboxConfigured(false);
                setSyncError('Failed to load Dropbox app key.');
                void logError(error, { scope: 'sync', step: 'loadDropboxAppKey' });
            });
        measureSettingsOpenStep('sync-load-dropbox-redirect-uri', () => SyncService.getDropboxRedirectUri())
            .then(setDropboxRedirectUri)
            .catch((error) => {
                void logError(error, { scope: 'sync', step: 'loadDropboxRedirectUri' });
            });
        loadSnapshots().catch((error) => {
            void logError(error, { scope: 'sync', step: 'loadSnapshots' });
        });
        return unsubscribe;
    }, [isTauri]);

    useEffect(() => {
        let cancelled = false;
        const loadDropboxConnection = async () => {
            const appKey = dropboxAppKey.trim();
            if (!appKey) {
                if (!cancelled) {
                    setDropboxConnected(false);
                    setDropboxTestState('idle');
                }
                return;
            }
            try {
                const connected = await SyncService.isDropboxConnected(appKey);
                if (!cancelled) {
                    setDropboxConnected(connected);
                    if (!connected) {
                        setDropboxTestState('idle');
                    }
                }
            } catch (error) {
                if (!cancelled) {
                    setDropboxConnected(false);
                    setDropboxTestState('idle');
                }
                void logError(error, { scope: 'sync', step: 'loadDropboxConnected' });
            }
        };
        void loadDropboxConnection();
        return () => {
            cancelled = true;
        };
    }, [dropboxAppKey]);

    useEffect(() => {
        setWebdavTestState('idle');
    }, [webdavUrl, webdavUsername, webdavPassword]);

    const handleSaveSyncPath = useCallback(async () => {
        if (!syncPath.trim()) return;
        const result = await SyncService.setSyncPath(syncPath.trim());
        if (result.success) {
            setSyncError(null);
            showSaved();
            return;
        }
        const message = formatSyncPathError(result.error);
        setSyncError(message);
        showToast(message, 'error');
    }, [formatSyncPathError, showSaved, showToast, syncPath]);

    const handleChangeSyncLocation = useCallback(async () => {
        try {
            if (!isTauri) return;

            const { open } = await import('@tauri-apps/plugin-dialog');
            const selected = await open({
                directory: true,
                multiple: false,
                title: selectSyncFolderTitle,
            });

            if (selected && typeof selected === 'string') {
                setSyncPath(selected);
                const result = await SyncService.setSyncPath(selected);
                if (result.success) {
                    setSyncError(null);
                    showSaved();
                    return;
                }
                const message = formatSyncPathError(result.error);
                setSyncError(message);
                showToast(message, 'error');
            }
        } catch (error) {
            setSyncError('Failed to change sync location.');
            void logError(error, { scope: 'sync', step: 'changeLocation' });
        }
    }, [formatSyncPathError, isTauri, selectSyncFolderTitle, showSaved, showToast]);

    const handleSetSyncBackend = useCallback(async (backend: SyncBackend) => {
        setSyncBackend(backend);
        await SyncService.setSyncBackend(backend);
        showSaved();
    }, [showSaved]);

    const handleSaveWebDav = useCallback(async () => {
        const trimmedUrl = webdavUrl.trim();
        const trimmedPassword = webdavPassword.trim();
        setIsSavingWebDav(true);
        try {
            await SyncService.setWebDavConfig({
                url: trimmedUrl,
                username: webdavUsername.trim(),
                ...(trimmedPassword ? { password: trimmedPassword } : {}),
            });
            if (!trimmedUrl) {
                setWebdavHasPassword(false);
                setWebdavPassword('');
            } else if (trimmedPassword) {
                setWebdavHasPassword(true);
            }
            showSaved();
        } finally {
            setIsSavingWebDav(false);
        }
    }, [showSaved, webdavPassword, webdavUrl, webdavUsername]);

    const handleTestWebDavConnection = useCallback(async () => {
        const trimmedUrl = webdavUrl.trim();
        if (!trimmedUrl) {
            const message = 'Enter a WebDAV URL first.';
            setWebdavTestState('error');
            setSyncError(message);
            showToast(message, 'error');
            return;
        }

        setIsTestingWebDav(true);
        try {
            await SyncService.testWebDavConnection({
                url: trimmedUrl,
                username: webdavUsername.trim(),
                password: webdavPassword,
                hasPassword: webdavHasPassword,
            });
            setWebdavTestState('success');
            setSyncError(null);
            showToast('WebDAV endpoint is reachable.', 'success');
        } catch (error) {
            const message = toErrorMessage(error, 'WebDAV connection failed.');
            setWebdavTestState('error');
            setSyncError(message);
            showToast(message, 'error');
        } finally {
            setIsTestingWebDav(false);
        }
    }, [showToast, toErrorMessage, webdavPassword, webdavUrl, webdavUsername]);

    const handleSaveCloud = useCallback(async () => {
        await SyncService.setCloudConfig({
            url: cloudUrl.trim(),
            token: cloudToken.trim(),
        });
        showSaved();
    }, [cloudUrl, cloudToken, showSaved]);

    const handleSetCloudProvider = useCallback(async (provider: CloudProvider) => {
        setCloudProvider(provider);
        if (provider !== 'dropbox') {
            setDropboxTestState('idle');
        }
        await SyncService.setCloudProvider(provider);
        showSaved();
    }, [showSaved]);

    const handleConnectDropbox = useCallback(async () => {
        const appKey = dropboxAppKey.trim();
        if (!appKey) {
            showToast('Dropbox app key is not configured in this build.', 'error');
            return;
        }
        setDropboxBusy(true);
        try {
            await SyncService.connectDropbox(appKey);
            setDropboxConnected(true);
            setDropboxTestState('idle');
            showToast('Connected to Dropbox.', 'success');
            showSaved();
        } catch (error) {
            const message = toErrorMessage(error, 'Failed to connect Dropbox.');
            setDropboxConnected(false);
            setDropboxTestState('error');
            setSyncError(message);
            showToast(message, 'error');
        } finally {
            setDropboxBusy(false);
        }
    }, [dropboxAppKey, showSaved, showToast, toErrorMessage]);

    const handleDisconnectDropbox = useCallback(async () => {
        const appKey = dropboxAppKey.trim();
        if (!appKey) {
            setDropboxConnected(false);
            setDropboxTestState('idle');
            return;
        }
        setDropboxBusy(true);
        try {
            await SyncService.disconnectDropbox(appKey);
            setDropboxConnected(false);
            setDropboxTestState('idle');
            showToast('Disconnected from Dropbox.', 'success');
        } catch (error) {
            const message = toErrorMessage(error, 'Failed to disconnect Dropbox.');
            setDropboxTestState('error');
            setSyncError(message);
            showToast(message, 'error');
        } finally {
            setDropboxBusy(false);
        }
    }, [dropboxAppKey, showToast, toErrorMessage]);

    const handleTestDropboxConnection = useCallback(async () => {
        const appKey = dropboxAppKey.trim();
        if (!appKey) {
            showToast('Dropbox app key is not configured in this build.', 'error');
            return;
        }
        setDropboxBusy(true);
        try {
            const connected = await SyncService.isDropboxConnected(appKey);
            if (!connected) {
                setDropboxConnected(false);
                setDropboxTestState('error');
                showToast('Connect Dropbox first.', 'error');
                return;
            }
            await SyncService.testDropboxConnection(appKey);
            setDropboxConnected(true);
            setDropboxTestState('success');
            showToast('Dropbox account is reachable.', 'success');
        } catch (error) {
            const message = toErrorMessage(error, 'Dropbox connection failed.');
            setDropboxConnected(false);
            setDropboxTestState('error');
            setSyncError(message);
            showToast(message, 'error');
        } finally {
            setDropboxBusy(false);
        }
    }, [dropboxAppKey, showToast, toErrorMessage]);

    const handleSync = useCallback(async () => {
        try {
            setSyncError(null);

            if (syncBackend === 'off') {
                return;
            }
            if (syncBackend === 'webdav') {
                if (!webdavUrl.trim()) return;
                await handleSaveWebDav();
            }
            if (syncBackend === 'cloud') {
                if (cloudProvider === 'selfhosted') {
                    if (!cloudUrl.trim()) return;
                    await handleSaveCloud();
                } else {
                    const appKey = dropboxAppKey.trim();
                    if (!appKey) {
                        const message = 'Dropbox app key is not configured in this build.';
                        setSyncError(message);
                        showToast(message, 'error');
                        return;
                    }
                    const connected = await SyncService.isDropboxConnected(appKey);
                    if (!connected) {
                        const message = 'Connect Dropbox first.';
                        setSyncError(message);
                        showToast(message, 'error');
                        setDropboxConnected(false);
                        return;
                    }
                    setDropboxConnected(true);
                }
            }
            if (syncBackend === 'file') {
                const path = syncPath.trim();
                if (path) {
                    const setPathResult = await SyncService.setSyncPath(path);
                    if (!setPathResult.success) {
                        const message = formatSyncPathError(setPathResult.error);
                        setSyncError(message);
                        showToast(message, 'error');
                        return;
                    }
                }
            }

            const result = await SyncService.performSync();
            if (result.success) {
                showToast('Sync completed', 'success');
                if (isTauri) {
                    setSnapshots(await SyncService.listDataSnapshots());
                }
            } else if (result.error) {
                showToast(result.error, 'error');
            }
        } catch (error) {
            void logError(error, { scope: 'sync', step: 'perform' });
            const message = toErrorMessage(error, 'Sync failed');
            setSyncError(message);
            showToast(message, 'error');
        }
    }, [
        cloudProvider,
        cloudUrl,
        dropboxAppKey,
        formatSyncPathError,
        handleSaveCloud,
        handleSaveWebDav,
        isTauri,
        showToast,
        syncBackend,
        syncPath,
        toErrorMessage,
        webdavUrl,
    ]);

    const handleRestoreSnapshot = useCallback(async (snapshotFileName: string) => {
        if (!snapshotFileName) return false;
        setIsRestoringSnapshot(true);
        try {
            const result = await SyncService.restoreDataSnapshot(snapshotFileName);
            if (!result.success) {
                showToast(result.error || 'Failed to restore snapshot.', 'error');
                return false;
            }
            showToast('Snapshot restored.', 'success');
            setSnapshots(await SyncService.listDataSnapshots());
            return true;
        } finally {
            setIsRestoringSnapshot(false);
        }
    }, [showToast]);

    return {
        syncPath,
        setSyncPath,
        isSyncing: syncStatus.inFlight,
        syncQueued: syncStatus.queued,
        syncLastResult: syncStatus.lastResult,
        syncLastResultAt: syncStatus.lastResultAt,
        syncError,
        syncBackend,
        setSyncBackend,
        webdavUrl,
        setWebdavUrl,
        webdavUsername,
        setWebdavUsername,
        webdavPassword,
        setWebdavPassword,
        webdavHasPassword,
        isSavingWebDav,
        isTestingWebDav,
        webdavTestState,
        cloudUrl,
        setCloudUrl,
        cloudToken,
        setCloudToken,
        cloudProvider,
        setCloudProvider,
        dropboxAppKey,
        dropboxConfigured,
        dropboxConnected,
        dropboxBusy,
        dropboxRedirectUri,
        dropboxTestState,
        snapshots,
        isLoadingSnapshots,
        isRestoringSnapshot,
        handleSaveSyncPath,
        handleChangeSyncLocation,
        handleSetSyncBackend,
        handleSaveWebDav,
        handleTestWebDavConnection,
        handleSaveCloud,
        handleSetCloudProvider,
        handleConnectDropbox,
        handleDisconnectDropbox,
        handleTestDropboxConnection,
        handleSync,
        handleRestoreSnapshot,
    };
};
