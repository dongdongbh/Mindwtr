import { useCallback, useEffect, useState } from 'react';
import { SyncService, type CloudProvider } from '../../../lib/sync-service';
import { useUiStore } from '../../../store/ui-store';
import { logError } from '../../../lib/app-log';
import { markSettingsOpenTrace, measureSettingsOpenStep } from '../../../lib/settings-open-diagnostics';
import {
    addBreadcrumb,
    CLOCK_SKEW_THRESHOLD_MS,
    getInMemoryAppDataSnapshot,
    type SyncBackend,
} from '@mindwtr/core';
import {
    exportDesktopBackup,
    importDesktopTodoistData,
    inspectDesktopBackup,
    inspectDesktopTodoistImport,
    restoreDesktopBackup,
} from '../../../lib/data-transfer';

export type { SyncBackend };
export type DropboxTestState = 'idle' | 'success' | 'error';
export type WebDavTestState = 'idle' | 'success' | 'error';

const formatClockSkew = (ms: number): string => {
    if (!Number.isFinite(ms) || ms <= 0) return '0 ms';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
    const minutes = seconds / 60;
    return `${minutes.toFixed(1)} min`;
};

type UseSyncSettingsOptions = {
    appVersion: string;
    isTauri: boolean;
    showSaved: () => void;
    selectSyncFolderTitle: string;
    requestConfirmation: (options: { title: string; message: string }) => Promise<boolean>;
};

export const useSyncSettings = ({
    appVersion,
    isTauri,
    showSaved,
    selectSyncFolderTitle,
    requestConfirmation,
}: UseSyncSettingsOptions) => {
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
    const [transferAction, setTransferAction] = useState<null | 'export' | 'restore' | 'import'>(null);
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
        addBreadcrumb(`settings:syncBackend:${backend}`);
        setSyncBackend(backend);
        setSyncError(null);
        if (backend === 'cloudkit') {
            return;
        }
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
        addBreadcrumb('sync:manual');
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

            const persistedBackend = await SyncService.getSyncBackend();
            const isPendingCloudKitEnable = syncBackend === 'cloudkit' && persistedBackend !== 'cloudkit';
            const result = await SyncService.performSync(
                isPendingCloudKitEnable ? { backendOverride: 'cloudkit' } : undefined
            );
            if (result.skipped === 'requeued') {
                showToast('Local changes arrived during sync. Retry queued.', 'info');
            } else if (result.success) {
                if (isPendingCloudKitEnable) {
                    await SyncService.setSyncBackend('cloudkit');
                    showSaved();
                }
                const maxClockSkewMs = Math.max(
                    result.stats?.tasks.maxClockSkewMs ?? 0,
                    result.stats?.projects.maxClockSkewMs ?? 0,
                    result.stats?.sections.maxClockSkewMs ?? 0,
                    result.stats?.areas.maxClockSkewMs ?? 0
                );
                const timestampAdjustments = (result.stats?.tasks.timestampAdjustments ?? 0)
                    + (result.stats?.projects.timestampAdjustments ?? 0)
                    + (result.stats?.sections.timestampAdjustments ?? 0)
                    + (result.stats?.areas.timestampAdjustments ?? 0);
                showToast('Sync completed', 'success');
                if (maxClockSkewMs > CLOCK_SKEW_THRESHOLD_MS) {
                    showToast(
                        `Large device clock skew detected during sync (${formatClockSkew(maxClockSkewMs)}). Check time settings on each device.`,
                        'info',
                        7000
                    );
                } else if (timestampAdjustments > 0) {
                    showToast(
                        `Adjusted ${timestampAdjustments} future-dated timestamp${timestampAdjustments === 1 ? '' : 's'} during sync. Check device clocks if this repeats.`,
                        'info',
                        7000
                    );
                }
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
        addBreadcrumb('transfer:restore');
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

    const handleExportBackup = useCallback(async () => {
        addBreadcrumb('transfer:export');
        setTransferAction('export');
        try {
            await exportDesktopBackup(getInMemoryAppDataSnapshot());
            showToast('Backup exported.', 'success');
        } catch (error) {
            showToast(toErrorMessage(error, 'Failed to export backup.'), 'error');
        } finally {
            setTransferAction(null);
        }
    }, [showToast, toErrorMessage]);

    const handleRestoreBackup = useCallback(async () => {
        addBreadcrumb('transfer:restore');
        setTransferAction('restore');
        try {
            const validation = await inspectDesktopBackup(appVersion);
            if (!validation) return;
            if (!validation.valid || !validation.data) {
                showToast(validation.errors[0] || 'Selected file is not a valid Mindwtr backup.', 'error');
                return;
            }

            const lines = [
                validation.metadata?.backupAt
                    ? `Backup date: ${new Date(validation.metadata.backupAt).toLocaleString()}`
                    : validation.metadata?.fileName
                        ? `File: ${validation.metadata.fileName}`
                        : null,
                `Contains ${validation.metadata?.taskCount ?? 0} tasks and ${validation.metadata?.projectCount ?? 0} projects.`,
                'This will replace current local data. A recovery snapshot will be saved first when available.',
                ...(validation.warnings.length > 0 ? ['', ...validation.warnings] : []),
            ].filter(Boolean);
            const confirmed = await requestConfirmation({
                title: 'Restore backup?',
                message: lines.join('\n'),
            });
            if (!confirmed) return;

            const { snapshotName } = await restoreDesktopBackup(validation.data);
            if (isTauri) {
                setSnapshots(await SyncService.listDataSnapshots());
            }
            showToast(snapshotName ? `Backup restored. Snapshot saved as ${snapshotName}.` : 'Backup restored.', 'success', 6000);
        } catch (error) {
            showToast(toErrorMessage(error, 'Failed to restore backup.'), 'error');
        } finally {
            setTransferAction(null);
        }
    }, [appVersion, isTauri, requestConfirmation, showToast, toErrorMessage]);

    const handleImportTodoist = useCallback(async () => {
        addBreadcrumb('transfer:restore');
        setTransferAction('import');
        try {
            const parseResult = await inspectDesktopTodoistImport();
            if (!parseResult) return;
            if (!parseResult.valid || !parseResult.preview) {
                showToast(parseResult.errors[0] || 'The selected file is not a supported Todoist export.', 'error');
                return;
            }

            const preview = parseResult.preview;
            const projectLines = preview.projects
                .slice(0, 4)
                .map((project) => `- ${project.name}: ${project.taskCount}`);
            if (preview.projects.length > 4) {
                projectLines.push(`- ${preview.projects.length - 4} more project(s)...`);
            }

            const confirmed = await requestConfirmation({
                title: 'Import Todoist data?',
                message: [
                    `Import ${preview.taskCount} tasks from ${preview.projectCount} project(s)?`,
                    preview.sectionCount > 0 ? `${preview.sectionCount} section(s) will be preserved.` : null,
                    preview.checklistItemCount > 0 ? `${preview.checklistItemCount} subtask(s) will become checklist items.` : null,
                    'Imported tasks stay in Inbox so you can process them in Mindwtr.',
                    ...(projectLines.length > 0 ? ['', ...projectLines] : []),
                    ...(preview.warnings.length > 0 ? ['', ...preview.warnings] : []),
                ].filter(Boolean).join('\n'),
            });
            if (!confirmed) return;

            const { snapshotName, result } = await importDesktopTodoistData(parseResult.parsedProjects);
            if (isTauri) {
                setSnapshots(await SyncService.listDataSnapshots());
            }
            const details = [
                `Imported ${result.importedTaskCount} tasks into ${result.importedProjectCount} project(s).`,
                result.importedChecklistItemCount > 0 ? `${result.importedChecklistItemCount} subtask(s) became checklist items.` : null,
                snapshotName ? `Snapshot saved as ${snapshotName}.` : null,
                ...(result.warnings.length > 0 ? ['', ...result.warnings] : []),
            ].filter(Boolean).join('\n');
            showToast(details, 'success', 7000);
        } catch (error) {
            showToast(toErrorMessage(error, 'Failed to import Todoist data.'), 'error');
        } finally {
            setTransferAction(null);
        }
    }, [isTauri, requestConfirmation, showToast, toErrorMessage]);

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
        transferAction,
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
        handleExportBackup,
        handleRestoreBackup,
        handleImportTodoist,
    };
};
