import { useCallback, useEffect, useRef, useState } from 'react';
import {
    SyncService,
    type CloudProvider,
    type DesktopSyncConfigOverride,
} from '../../../lib/sync-service';
import { classifySyncEncryptionFailure } from '../../../lib/sync-encryption-service';
import { useUiStore } from '../../../store/ui-store';
import { logError } from '../../../lib/app-log';
import { markSettingsOpenTrace, measureSettingsOpenStep } from '../../../lib/settings-open-diagnostics';
import { useLanguage } from '../../../contexts/language-context';
import { reportSettingsFailure, resolveSettingsFeedback } from './settings-feedback';
import {
    addBreadcrumb,
    CLOCK_SKEW_THRESHOLD_MS,
    createImportDiagnostics,
    formatImportDiagnostic,
    getBackupSourceFileDiagnostic,
    getInMemoryAppDataSnapshot,
    isConnectionAllowed,
    isSyncEncryptionRemoteVersionUnavailableError,
    isValidCloudSyncToken,
    safeFormatDate,
    SYNC_LOCAL_INSECURE_URL_OPTIONS,
    summarizeBackupMerge,
    summarizeMergeStats,
    useTaskStore,
    type AppData,
    type ImportDiagnostic,
    type SyncBackend,
} from '@mindwtr/core';
import {
    importDesktopDgtData,
    exportDesktopBackup,
    exportDesktopCsv,
    exportDesktopTaskNotes,
    importDesktopMindwtrCsvData,
    importDesktopOmniFocusData,
    importDesktopTickTickData,
    importDesktopTodoistData,
    inspectDesktopDgtImport,
    inspectDesktopBackup,
    inspectDesktopMindwtrCsvImport,
    inspectDesktopOmniFocusImport,
    inspectDesktopTickTickImport,
    inspectDesktopTodoistImport,
    mergeDesktopBackup,
    restoreDesktopBackup,
} from '../../../lib/data-transfer';
import { isValidHttpUrl } from './sync/sync-page-utils';
import { useSyncEncryptionSettings } from './sync/useSyncEncryptionSettings';
import type {
    SettingsDataTransferProps,
    SettingsSyncPageProps,
    SyncPreferences,
    TransferAction,
} from './sync/types';

export type { SyncBackend };
export type DropboxTestState = 'idle' | 'success' | 'error';
export type WebDavTestState = 'idle' | 'success' | 'error';

const IMPORT_DIAGNOSTIC_FALLBACKS: Record<string, string> = {
    'settings.backupDiagnostics.newerVersion': 'This backup was created by a newer Mindwtr version ({{version}}).',
    'settings.backupDiagnostics.noActiveRecords': 'This backup does not contain any active tasks or projects.',
    'settings.backupDiagnostics.olderVersion': 'This backup was created by an older Mindwtr version ({{version}}).',
    'settings.backupDiagnostics.tooLarge': 'The selected backup file is too large. Choose a backup no larger than {{maxSizeMb}} MB.',
    'settings.backupDiagnostics.unknownSize': 'Mindwtr could not verify the selected backup file size. Copy it locally and try again.',
    'settings.importDiagnostics.adjustedRecords': '{{count}} imported record(s) needed an adjustment. Review the imported data.',
    'settings.importDiagnostics.cannotRead': 'Mindwtr could not safely read this export.',
    'settings.importDiagnostics.limitExceeded': 'This export exceeds a safe import limit. Choose a smaller export.',
    'settings.importDiagnostics.missingColumn': 'This export is missing the required column: {{column}}.',
    'settings.importDiagnostics.noImportableRecords': 'No importable records were found in this export.',
    'settings.importDiagnostics.renamedContainer': '“{{from}}” was renamed to “{{to}}” to avoid a duplicate {{kind}} name.',
    'settings.importDiagnostics.duplicateIdentity': '{{count}} duplicate record(s) were skipped.',
    'settings.importDiagnostics.emptyRecords': '{{count}} empty record(s) were skipped.',
    'settings.importDiagnostics.invalidArchiveEntries': '{{count}} archive file(s) could not be parsed and were skipped.',
    'settings.importDiagnostics.missingParent': '{{count}} record(s) had no matching parent and were imported at the nearest safe level.',
    'settings.importDiagnostics.skippedArchiveEntries': '{{count}} unsupported archive entry/entries were skipped.',
    'settings.importDiagnostics.skippedExistingRecords': '{{count}} previously imported or deleted record(s) were skipped.',
    'settings.importDiagnostics.unmappedDate': '{{count}} date value(s) could not be mapped and were omitted.',
    'settings.importDiagnostics.unmappedStatus': '{{count}} status value(s) could not be mapped and used a safe default.',
    'settings.importDiagnostics.unsupportedRecurrence': '{{count}} unsupported repeat rule(s) were kept as notes.',
};

// Restore and merge read the same file and preview it identically; only the sentence about
// what the action does to local data differs.
const buildBackupConfirmation = (
    validation: NonNullable<Awaited<ReturnType<typeof inspectDesktopBackup>>>,
    effect: string,
    formatText: (key: string, fallback: string, replacements: Record<string, string | number>) => string,
    formatDiagnostic: (diagnostic: ImportDiagnostic) => string,
): string => [
    validation.metadata?.backupAt
        ? formatText('settings.backupMobile.backupDateLabel', 'Backup date: {{backupDate}}', {
            backupDate: new Date(validation.metadata.backupAt).toLocaleString(),
        })
        : validation.metadata?.fileName
            ? formatText('settings.backupMobile.fileLabel', 'File: {{fileName}}', {
                fileName: validation.metadata.fileName,
            })
            : null,
    formatText('settings.backupMobile.backupPreviewCounts', 'Contains {{taskCount}} tasks and {{projectCount}} projects.', {
        taskCount: validation.metadata?.taskCount ?? 0,
        projectCount: validation.metadata?.projectCount ?? 0,
    }),
    effect,
    ...(() => {
        const warnings = validation.diagnostics
            .filter((diagnostic) => diagnostic.severity === 'warning')
            .map(formatDiagnostic);
        return warnings.length > 0 ? ['', ...warnings] : [];
    })(),
].filter(Boolean).join('\n');

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
    lastSyncNeverLabel: string;
    requestConfirmation: (options: { title: string; message: string }) => Promise<boolean>;
};

export const useSyncSettings = ({
    appVersion,
    isTauri,
    showSaved,
    selectSyncFolderTitle,
    lastSyncNeverLabel,
    requestConfirmation,
}: UseSyncSettingsOptions) => {
    const [syncPath, setSyncPath] = useState('');
    const [syncStatus, setSyncStatus] = useState(() => SyncService.getSyncStatus());
    const [syncError, setSyncError] = useState<string | null>(null);
    const [syncBackend, setSyncBackend] = useState<SyncBackend>('off');
    const [persistedSyncBackend, setPersistedSyncBackend] = useState<SyncBackend>('off');
    const [webdavUrl, setWebdavUrl] = useState('');
    const [webdavUsername, setWebdavUsername] = useState('');
    const [webdavPassword, setWebdavPassword] = useState('');
    const [webdavHasPassword, setWebdavHasPassword] = useState(false);
    const [webdavAllowInsecureHttp, setWebdavAllowInsecureHttp] = useState(false);
    const [isSavingWebDav, setIsSavingWebDav] = useState(false);
    const [isTestingWebDav, setIsTestingWebDav] = useState(false);
    const [webdavTestState, setWebdavTestState] = useState<WebDavTestState>('idle');
    const [cloudUrl, setCloudUrl] = useState('');
    const [cloudToken, setCloudToken] = useState('');
    const [cloudRememberToken, setCloudRememberToken] = useState(false);
    const [cloudAllowInsecureHttp, setCloudAllowInsecureHttp] = useState(false);
    const [cloudProvider, setCloudProvider] = useState<CloudProvider>('selfhosted');
    const [persistedCloudProvider, setPersistedCloudProvider] = useState<CloudProvider>('selfhosted');
    const hasPendingSyncConfiguration = useRef(false);
    const syncConfigurationGeneration = useRef(0);
    const dropboxOperationGeneration = useRef(0);
    const [calendarFeedUrl, setCalendarFeedUrl] = useState<string | null>(null);
    const [calendarFeedBusy, setCalendarFeedBusy] = useState(false);
    const [calendarFeedReloadToken, setCalendarFeedReloadToken] = useState(0);
    const [dropboxAppKey, setDropboxAppKey] = useState('');
    const [dropboxConfigured, setDropboxConfigured] = useState(false);
    const [dropboxConnected, setDropboxConnected] = useState(false);
    const [dropboxCredentialHandle, setDropboxCredentialHandle] = useState<string | null>(
        () => SyncService.getPendingDropboxCredentialHandleForSession(),
    );
    const dropboxCredentialHandleRef = useRef<string | null>(dropboxCredentialHandle);
    const [dropboxBusy, setDropboxBusy] = useState(false);
    const [dropboxAuthInProgress, setDropboxAuthInProgress] = useState(false);
    const [dropboxRedirectUri, setDropboxRedirectUri] = useState('http://127.0.0.1:53682/oauth/dropbox/callback');
    const [dropboxTestState, setDropboxTestState] = useState<DropboxTestState>('idle');
    const [snapshots, setSnapshots] = useState<string[]>([]);
    const [isLoadingSnapshots, setIsLoadingSnapshots] = useState(false);
    const [isRestoringSnapshot, setIsRestoringSnapshot] = useState(false);
    const [transferAction, setTransferAction] = useState<TransferAction>(null);
    const showToast = useUiStore((state) => state.showToast);
    const settings = useTaskStore((state) => state.settings) ?? ({} as AppData['settings']);
    const updateSettings = useTaskStore((state) => state.updateSettings);
    const { t } = useLanguage();

    const advanceSyncConfigurationGeneration = useCallback((): number => {
        syncConfigurationGeneration.current += 1;
        return syncConfigurationGeneration.current;
    }, []);

    const resolveText = useCallback((key: string, fallback: string): string => {
        return resolveSettingsFeedback(t, key, fallback);
    }, [t]);
    const dropboxCredentialCleanupMessage = resolveText(
        'settings.sync.dropboxCredentialCleanupFailed',
        'Pending Dropbox authorization could not be safely cleared. Try again.',
    );

    const formatSyncPathError = useCallback((message?: string): string => {
        const normalized = (message || '').toLowerCase();
        if (normalized.includes('must be a directory')) {
            return resolveText(
                'settings.sync.folderRequired',
                'Select a folder for sync, not a backup JSON file.',
            );
        }
        if (normalized.includes('permission denied') || normalized.includes('operation not permitted')) {
            return resolveText(
                'settings.sync.folderPermissionDenied',
                'Mindwtr cannot access this folder. Choose a folder you own, then try again.',
            );
        }
        return resolveText('settings.syncMobile.failedToSetSyncPath', 'Failed to set sync path');
    }, [resolveText]);

    const toErrorMessage = useCallback((error: unknown, fallback: string): string => {
        if (error instanceof Error && error.message.trim()) return error.message.trim();
        const text = String(error || '').trim();
        return text || fallback;
    }, []);

    const isManualInsecureOverride = useCallback((url: string, allowInsecureHttp: boolean): boolean => {
        if (!allowInsecureHttp) return false;
        try {
            if (new URL(url).protocol !== 'http:') return false;
        } catch {
            return false;
        }
        return !isConnectionAllowed(url, SYNC_LOCAL_INSECURE_URL_OPTIONS);
    }, []);

    const validateSyncHttpUrl = useCallback((url: string, allowInsecureHttp: boolean): boolean => {
        if (!isValidHttpUrl(url)) {
            const message = resolveText(
                'settings.sync.validHttpUrl',
                'Enter a valid http(s) URL.',
            );
            setSyncError(message);
            showToast(message, 'error');
            return false;
        }
        if (!isConnectionAllowed(url, {
            ...SYNC_LOCAL_INSECURE_URL_OPTIONS,
            allowInsecureHttp,
        })) {
            const message = resolveText(
                'settings.syncMobile.publicHttpSyncUrlsAreBlockedUseHttpsOrEnable',
                'Public HTTP sync URLs are blocked. Use HTTPS, or enable insecure HTTP only for a trusted private network.',
            );
            setSyncError(message);
            showToast(message, 'error');
            return false;
        }
        if (isManualInsecureOverride(url, allowInsecureHttp)) {
            showToast(resolveText(
                'settings.syncMobile.onlyUseThisOnTrustedNetworksSyncDataWillBe',
                'Only use insecure HTTP on trusted networks. Sync data will be sent unencrypted.',
            ), 'info');
        }
        return true;
    }, [isManualInsecureOverride, resolveText, showToast]);

    // An empty token field means "unchanged, use keyring" (#899) and must never be
    // validated or blocked; only a non-empty token that fails the shape check is rejected.
    const validateCloudToken = useCallback((token: string): boolean => {
        if (!token) return true;
        if (!isValidCloudSyncToken(token)) {
            const message = resolveText(
                'settings.sync.invalidToken',
                'Sync token must be 20-512 characters using letters, numbers, or . _ ~ + / = -',
            );
            setSyncError(message);
            showToast(message, 'error');
            return false;
        }
        return true;
    }, [resolveText, showToast]);

    const formatText = useCallback((
        key: string,
        fallback: string,
        replacements: Record<string, string | number>,
    ): string => {
        return resolveSettingsFeedback(t, key, fallback, replacements);
    }, [t]);

    const formatImportDiagnosticText = useCallback((diagnostic: ImportDiagnostic): string => (
        formatImportDiagnostic(diagnostic, (key, values = {}) => formatText(
            key,
            IMPORT_DIAGNOSTIC_FALLBACKS[key] ?? IMPORT_DIAGNOSTIC_FALLBACKS['settings.importDiagnostics.cannotRead'],
            values,
        ))
    ), [formatText]);
    const formatImportMessages = useCallback((messages: readonly string[]): string[] => (
        createImportDiagnostics(messages, 'warning').map(formatImportDiagnosticText)
    ), [formatImportDiagnosticText]);
    const formatImportError = useCallback((diagnostics: readonly ImportDiagnostic[], fallback: string): string => {
        const diagnostic = diagnostics.find((item) => item.severity === 'error');
        return diagnostic ? formatImportDiagnosticText(diagnostic) : fallback;
    }, [formatImportDiagnosticText]);
    const formatThrownBackupError = useCallback((error: unknown, fallback: string): string => {
        const diagnostic = getBackupSourceFileDiagnostic(error);
        return diagnostic ? formatImportDiagnosticText(diagnostic) : toErrorMessage(error, fallback);
    }, [formatImportDiagnosticText, toErrorMessage]);

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
        const configurationLoadGeneration = syncConfigurationGeneration.current;
        measureSettingsOpenStep(
            'sync-load-configuration',
            () => SyncService.getPersistedSyncConfigurationSnapshot(),
        )
            .then((configuration) => {
                // Baselines always describe the durable configuration. Editor
                // values are only initialized if the user has not changed them
                // while this queue-serialized snapshot was waiting.
                setPersistedSyncBackend(configuration.backend);
                setPersistedCloudProvider(configuration.cloudProvider);
                if (syncConfigurationGeneration.current !== configurationLoadGeneration) return;
                setSyncPath(configuration.syncPath);
                setSyncBackend(configuration.backend);
                setWebdavUrl(configuration.webdav.url);
                setWebdavUsername(configuration.webdav.username);
                setWebdavPassword(configuration.webdav.password ?? '');
                setWebdavHasPassword(configuration.webdav.hasPassword === true);
                setWebdavAllowInsecureHttp(configuration.webdav.allowInsecureHttp === true);
                setCloudUrl(configuration.cloud.url);
                setCloudToken(configuration.cloud.token ?? '');
                setCloudRememberToken(configuration.cloud.rememberToken === true);
                setCloudAllowInsecureHttp(configuration.cloud.allowInsecureHttp === true);
                setCloudProvider(configuration.cloudProvider);
            })
            .catch((error) => {
                void logError(error, { scope: 'sync', step: 'loadConfiguration' });
                setSyncError(resolveText('settings.feedback.loadFailed', "Couldn't load this setting. Try again."));
            });
        measureSettingsOpenStep('sync-load-dropbox-app-key', () => SyncService.getDropboxAppKey())
            .then((value) => {
                const trimmed = value.trim();
                setDropboxAppKey(trimmed);
                setDropboxConfigured(Boolean(trimmed));
            })
            .catch((error) => {
                setDropboxConfigured(false);
                void logError(error, { scope: 'sync', step: 'loadDropboxAppKey' });
                setSyncError(resolveText('settings.feedback.loadFailed', "Couldn't load this setting. Try again."));
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
    }, [isTauri, resolveText]);

    useEffect(() => {
        let cancelled = false;
        const loadDropboxConnection = async () => {
            if (dropboxCredentialHandle) {
                if (!cancelled) setDropboxConnected(true);
                return;
            }
            const appKey = dropboxAppKey.trim();
            // Only probe while the Dropbox panel is in play. The probe runs
            // native credential recovery, and on keyring-less systems its
            // failure toasts a Dropbox error to users who never chose
            // Dropbox (#1084); the same relevance gate as auto-sync
            // eligibility keeps real Dropbox breakage loud.
            const dropboxSelected = syncBackend === 'cloud' && cloudProvider === 'dropbox';
            if (!appKey || !dropboxSelected) {
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
    }, [cloudProvider, dropboxAppKey, dropboxCredentialHandle, syncBackend]);

    useEffect(() => {
        const unsubscribe = SyncService.subscribePendingDropboxCredentialHandleForSession((credentialHandle) => {
            dropboxCredentialHandleRef.current = credentialHandle;
            setDropboxCredentialHandle(credentialHandle);
        });
        void SyncService.retryPendingDropboxCredentialFinalizationForSession()
            .catch((error) => {
                void logError(error, { scope: 'sync', step: 'retryDropboxCredentialFinalizationOnMount' });
            });
        return unsubscribe;
    }, []);

    useEffect(() => () => {
        const credentialHandle = dropboxCredentialHandleRef.current;
        if (credentialHandle) {
            void SyncService.resolvePendingDropboxCredentialForSession(credentialHandle)
                .then(() => {
                    // The service owns lifecycle serialization; the explicit
                    // forget remains idempotent for mocked adapters.
                    SyncService.forgetPendingDropboxCredentialHandleForSession(credentialHandle);
                })
                .catch((error) => {
                    // Keep the session-owned handle on uncertain double failure
                    // so a remounted settings view can retry recovery.
                    void logError(error, { scope: 'sync', step: 'resolveDropboxCredentialOnUnmount' });
                });
        }
    }, []);

    useEffect(() => {
        setWebdavTestState('idle');
    }, [webdavUrl, webdavUsername, webdavPassword]);

    // Only the self-hosted server publishes a feed, so this stays off the wire
    // for every other backend. It reads the saved config (not the typed URL), so
    // it must not re-run per keystroke — handleSaveCloud refreshes it instead.
    useEffect(() => {
        if (
            syncBackend !== 'cloud'
            || cloudProvider !== 'selfhosted'
            || persistedSyncBackend !== 'cloud'
            || persistedCloudProvider !== 'selfhosted'
        ) {
            setCalendarFeedUrl(null);
            return;
        }
        let cancelled = false;
        void SyncService.requestCalendarFeed('read')
            .then((result) => {
                if (!cancelled) setCalendarFeedUrl(result.url);
            })
            .catch((error) => {
                // An unreachable or pre-feed server just means "nothing published yet";
                // the explicit Generate action is where a real failure surfaces.
                if (!cancelled) setCalendarFeedUrl(null);
                void logError(error, { scope: 'sync', step: 'loadCalendarFeed' });
            });
        return () => {
            cancelled = true;
        };
    }, [cloudProvider, persistedCloudProvider, persistedSyncBackend, syncBackend, calendarFeedReloadToken]);

    const handleCalendarFeedAction = useCallback(async (action: 'rotate' | 'revoke') => {
        setCalendarFeedBusy(true);
        try {
            const result = await SyncService.requestCalendarFeed(action);
            setCalendarFeedUrl(result.url);
            setSyncError(null);
            showToast(
                action === 'rotate'
                    ? resolveText('settings.sync.calendarFeedGenerated', 'Calendar feed URL generated.')
                    : resolveText('settings.sync.calendarFeedRevoked', 'Calendar feed revoked.'),
                'success',
            );
        } catch (error) {
            const message = resolveText('settings.feedback.actionFailed', "Couldn't complete this action. Try again.");
            void logError(error, { scope: 'sync', step: `calendarFeed:${action}` });
            setSyncError(message);
            showToast(message, 'error');
        } finally {
            setCalendarFeedBusy(false);
        }
    }, [resolveText, showToast]);

    const handleCopyCalendarFeedUrl = useCallback(async () => {
        if (!calendarFeedUrl) return;
        try {
            await navigator.clipboard.writeText(calendarFeedUrl);
            showToast(resolveText('settings.sync.calendarFeedCopied', 'Subscription URL copied.'), 'success');
        } catch (error) {
            void logError(error, { scope: 'sync', step: 'copyCalendarFeedUrl' });
            showToast(resolveText('settings.sync.calendarFeedCopyFailed', 'Could not copy the subscription URL.'), 'error');
        }
    }, [calendarFeedUrl, resolveText, showToast]);

    const handleSaveSyncPath = useCallback(async () => {
        if (!syncPath.trim()) return;
        advanceSyncConfigurationGeneration();
        hasPendingSyncConfiguration.current = true;
        setSyncPath(syncPath.trim());
        setSyncError(null);
        showToast(resolveText('settings.sync.readyToVerify', 'Settings ready. Sync now to verify and save them.'), 'info');
    }, [advanceSyncConfigurationGeneration, resolveText, showToast, syncPath]);

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
                advanceSyncConfigurationGeneration();
                hasPendingSyncConfiguration.current = true;
                setSyncPath(selected);
                setSyncError(null);
                showToast(resolveText('settings.sync.readyToVerify', 'Settings ready. Sync now to verify and save them.'), 'info');
            }
        } catch (error) {
            setSyncError(resolveText('settings.feedback.actionFailed', "Couldn't complete this action. Try again."));
            void logError(error, { scope: 'sync', step: 'changeLocation' });
        }
    }, [advanceSyncConfigurationGeneration, isTauri, resolveText, selectSyncFolderTitle, showToast]);

    const clearLocalDropboxCredentialHandle = useCallback((expectedHandle?: string) => {
        if (expectedHandle && dropboxCredentialHandleRef.current !== expectedHandle) return;
        SyncService.forgetPendingDropboxCredentialHandleForSession(expectedHandle);
        dropboxCredentialHandleRef.current = null;
        setDropboxCredentialHandle(null);
    }, []);

    const discardDropboxCredential = useCallback(async (
        credentialHandle: string | null,
        options: {
            refreshDurableConnection?: boolean;
            expectedGeneration?: number;
        } = {},
    ): Promise<boolean> => {
        let credentialResolved = true;
        if (credentialHandle) {
            try {
                await SyncService.resolvePendingDropboxCredentialForSession(credentialHandle);
                clearLocalDropboxCredentialHandle(credentialHandle);
            } catch (error) {
                credentialResolved = false;
                void logError(error, { scope: 'sync', step: 'resolveDropboxCredential' });
            }
        }
        if (options.refreshDurableConnection) {
            const appKey = dropboxAppKey.trim();
            const connected = appKey
                ? await SyncService.isDropboxConnected(appKey)
                : false;
            if (
                options.expectedGeneration === undefined
                || syncConfigurationGeneration.current === options.expectedGeneration
            ) {
                setDropboxConnected(connected);
            }
        }
        return credentialResolved;
    }, [clearLocalDropboxCredentialHandle, dropboxAppKey]);

    const discardPendingDropboxCredential = useCallback((
        options: {
            refreshDurableConnection?: boolean;
            expectedGeneration?: number;
        } = {},
    ): Promise<boolean> => discardDropboxCredential(
        dropboxCredentialHandleRef.current,
        options,
    ), [discardDropboxCredential]);

    const handleSetSyncBackend = useCallback(async (backend: SyncBackend) => {
        addBreadcrumb(`settings:syncBackend:${backend}`);
        const mutationGeneration = advanceSyncConfigurationGeneration();
        if (backend !== 'cloud' && dropboxCredentialHandleRef.current) {
            const discarded = await discardPendingDropboxCredential({
                refreshDurableConnection: true,
                expectedGeneration: mutationGeneration,
            });
            if (syncConfigurationGeneration.current !== mutationGeneration) return;
            if (!discarded) {
                setSyncError(dropboxCredentialCleanupMessage);
                return;
            }
        }
        if (backend !== 'off') {
            if (backend !== persistedSyncBackend) {
                hasPendingSyncConfiguration.current = true;
            }
            setSyncBackend(backend);
            setSyncError(null);
            return;
        }
        hasPendingSyncConfiguration.current = true;
        try {
            await SyncService.setSyncBackend(backend);
            setPersistedSyncBackend(backend);
            if (syncConfigurationGeneration.current === mutationGeneration) {
                hasPendingSyncConfiguration.current = false;
                setSyncBackend(backend);
                setSyncError(null);
                showSaved();
            }
        } catch (error) {
            void logError(error, { scope: 'sync', step: 'saveBackend' });
            setSyncError(resolveText('settings.feedback.saveFailed', "Couldn't save this setting. Try again."));
        }
    }, [
        advanceSyncConfigurationGeneration,
        discardPendingDropboxCredential,
        dropboxCredentialCleanupMessage,
        persistedSyncBackend,
        resolveText,
        showSaved,
    ]);

    const handleSaveWebDav = useCallback(async () => {
        const trimmedUrl = webdavUrl.trim();
        const trimmedPassword = webdavPassword.trim();
        if (trimmedUrl && !validateSyncHttpUrl(trimmedUrl, webdavAllowInsecureHttp)) return;
        advanceSyncConfigurationGeneration();
        hasPendingSyncConfiguration.current = true;
        setIsSavingWebDav(true);
        try {
            setWebdavUrl(trimmedUrl);
            setWebdavUsername(webdavUsername.trim());
            if (!trimmedUrl) {
                setWebdavHasPassword(false);
                setWebdavPassword('');
            } else if (trimmedPassword) {
                setWebdavHasPassword(true);
            }
            setSyncError(null);
            showToast(resolveText('settings.sync.readyToVerify', 'Settings ready. Sync now to verify and save them.'), 'info');
        } finally {
            setIsSavingWebDav(false);
        }
    }, [
        advanceSyncConfigurationGeneration,
        resolveText,
        showToast,
        validateSyncHttpUrl,
        webdavAllowInsecureHttp,
        webdavPassword,
        webdavUrl,
        webdavUsername,
    ]);

    const handleTestWebDavConnection = useCallback(async () => {
        const trimmedUrl = webdavUrl.trim();
        if (!trimmedUrl) {
            const message = resolveText(
                'settings.syncMobile.pleaseSetAWebdavUrlFirst',
                'Please set a WebDAV URL first',
            );
            setWebdavTestState('error');
            setSyncError(message);
            showToast(message, 'error');
            return;
        }
        if (!validateSyncHttpUrl(trimmedUrl, webdavAllowInsecureHttp)) return;

        setIsTestingWebDav(true);
        try {
            await SyncService.testWebDavConnection({
                url: trimmedUrl,
                username: webdavUsername.trim(),
                password: webdavPassword,
                hasPassword: webdavHasPassword,
                allowInsecureHttp: webdavAllowInsecureHttp,
            });
            setWebdavTestState('success');
            setSyncError(null);
            showToast(resolveText('settings.syncMobile.webdavEndpointIsReachable', 'WebDAV endpoint is reachable.'), 'success');
        } catch (error) {
            const message = isSyncEncryptionRemoteVersionUnavailableError(error)
                ? resolveText(
                    'settings.syncEncryptionErrorBackendIncompatible',
                    'This WebDAV server does not provide or enforce safe version checks (strong ETags and conditional writes), so Mindwtr cannot safely sync or change encryption. Use a compatible WebDAV provider, File Sync, or Dropbox.',
                )
                : resolveText('settings.syncMobile.connectionFailed', 'Connection failed');
            void logError(error, { scope: 'sync', step: 'testWebDavConnection' });
            setWebdavTestState('error');
            setSyncError(message);
            showToast(message, 'error');
        } finally {
            setIsTestingWebDav(false);
        }
    }, [resolveText, showToast, validateSyncHttpUrl, webdavAllowInsecureHttp, webdavHasPassword, webdavPassword, webdavUrl, webdavUsername]);

    const handleSaveCloud = useCallback(async () => {
        const trimmedUrl = cloudUrl.trim();
        const trimmedToken = cloudToken.trim();
        if (trimmedUrl && !validateSyncHttpUrl(trimmedUrl, cloudAllowInsecureHttp)) return;
        if (!validateCloudToken(trimmedToken)) return;
        advanceSyncConfigurationGeneration();
        hasPendingSyncConfiguration.current = true;
        setCloudUrl(trimmedUrl);
        setCloudToken(trimmedToken);
        setSyncError(null);
        showToast(resolveText('settings.sync.readyToVerify', 'Settings ready. Sync now to verify and save them.'), 'info');
    }, [
        advanceSyncConfigurationGeneration,
        cloudAllowInsecureHttp,
        cloudUrl,
        cloudToken,
        resolveText,
        showToast,
        validateCloudToken,
        validateSyncHttpUrl,
    ]);

    const handleSetCloudProvider = useCallback(async (provider: CloudProvider) => {
        const mutationGeneration = advanceSyncConfigurationGeneration();
        if (provider !== 'dropbox' && dropboxCredentialHandleRef.current) {
            const discarded = await discardPendingDropboxCredential({
                refreshDurableConnection: true,
                expectedGeneration: mutationGeneration,
            });
            if (syncConfigurationGeneration.current !== mutationGeneration) return;
            if (!discarded) {
                setSyncError(dropboxCredentialCleanupMessage);
                return;
            }
        }
        if (provider !== persistedCloudProvider) {
            hasPendingSyncConfiguration.current = true;
        }
        setCloudProvider(provider);
        if (provider !== 'dropbox') {
            setDropboxTestState('idle');
            setDropboxAuthInProgress(false);
        }
    }, [advanceSyncConfigurationGeneration, discardPendingDropboxCredential, dropboxCredentialCleanupMessage, persistedCloudProvider]);

    const handleConnectDropbox = useCallback(async () => {
        const appKey = dropboxAppKey.trim();
        if (!appKey) {
            showToast(resolveText(
                'settings.syncMobile.dropboxAppKeyIsNotConfiguredInThisBuild',
                'Dropbox app key is not configured in this build.',
            ), 'error');
            return;
        }
        const connectGeneration = advanceSyncConfigurationGeneration();
        const connectOperation = ++dropboxOperationGeneration.current;
        setDropboxAuthInProgress(true);
        setDropboxBusy(true);
        try {
            const discarded = await discardPendingDropboxCredential();
            if (!discarded) throw new Error(dropboxCredentialCleanupMessage);
            if (syncConfigurationGeneration.current !== connectGeneration) return;
            const credentialHandle = await SyncService.connectDropbox(appKey);
            if (syncConfigurationGeneration.current !== connectGeneration) {
                await discardDropboxCredential(credentialHandle, {
                    refreshDurableConnection: true,
                    expectedGeneration: connectGeneration,
                });
                return;
            }
            SyncService.rememberPendingDropboxCredentialHandleForSession(credentialHandle);
            dropboxCredentialHandleRef.current = credentialHandle;
            setDropboxCredentialHandle(credentialHandle);
            setDropboxConnected(true);
            setDropboxTestState('idle');
            hasPendingSyncConfiguration.current = true;
            setSyncError(null);
            showToast(resolveText('settings.sync.readyToVerify', 'Settings ready. Sync now to verify and save them.'), 'info');
        } catch (error) {
            if (syncConfigurationGeneration.current !== connectGeneration) return;
            const message = resolveText('settings.syncMobile.connectionFailed', 'Connection failed');
            void logError(error, { scope: 'sync', step: 'connectDropbox' });
            let connected = false;
            try {
                connected = await SyncService.isDropboxConnected(appKey);
            } catch (statusError) {
                void logError(statusError, { scope: 'sync', step: 'refreshDropboxConnectedAfterConnectFailure' });
            }
            if (syncConfigurationGeneration.current !== connectGeneration) return;
            setDropboxConnected(connected);
            setDropboxTestState('error');
            setSyncError(message);
            showToast(message, 'error');
        } finally {
            if (dropboxOperationGeneration.current === connectOperation) {
                setDropboxAuthInProgress(false);
                setDropboxBusy(false);
            }
        }
    }, [
        advanceSyncConfigurationGeneration,
        discardDropboxCredential,
        discardPendingDropboxCredential,
        dropboxAppKey,
        dropboxCredentialCleanupMessage,
        resolveText,
        showToast,
    ]);

    const handleDisconnectDropbox = useCallback(async () => {
        const appKey = dropboxAppKey.trim();
        if (!appKey) {
            setDropboxConnected(false);
            setDropboxTestState('idle');
            return;
        }
        const disconnectGeneration = advanceSyncConfigurationGeneration();
        const disconnectOperation = ++dropboxOperationGeneration.current;
        setDropboxAuthInProgress(false);
        setDropboxBusy(true);
        try {
            await discardPendingDropboxCredential();
            if (syncConfigurationGeneration.current !== disconnectGeneration) return;
            await SyncService.disconnectDropbox(appKey);
            const persisted = await SyncService.getPersistedSyncConfigurationSnapshot();
            // Baselines always follow durable state, even if a newer editor
            // intent arrived while disconnect was queued. Only the editor/UI
            // projection is generation guarded.
            setPersistedSyncBackend(persisted.backend);
            setPersistedCloudProvider(persisted.cloudProvider);
            if (syncConfigurationGeneration.current !== disconnectGeneration) return;
            clearLocalDropboxCredentialHandle();
            setSyncBackend(persisted.backend);
            setCloudProvider(persisted.cloudProvider);
            hasPendingSyncConfiguration.current = false;
            setDropboxConnected(false);
            setDropboxTestState('idle');
            setSyncError(null);
            showToast(resolveText('settings.sync.dropboxDisconnected', 'Disconnected from Dropbox.'), 'success');
        } catch (error) {
            if (syncConfigurationGeneration.current !== disconnectGeneration) return;
            const message = resolveText('settings.syncMobile.disconnectFailed', 'Disconnect failed');
            void logError(error, { scope: 'sync', step: 'disconnectDropbox' });
            setDropboxTestState('error');
            setSyncError(message);
            showToast(message, 'error');
        } finally {
            if (dropboxOperationGeneration.current === disconnectOperation) {
                setDropboxBusy(false);
            }
        }
    }, [
        advanceSyncConfigurationGeneration,
        clearLocalDropboxCredentialHandle,
        discardPendingDropboxCredential,
        dropboxAppKey,
        resolveText,
        showToast,
    ]);

    const handleTestDropboxConnection = useCallback(async () => {
        const appKey = dropboxAppKey.trim();
        if (!appKey) {
            showToast(resolveText(
                'settings.syncMobile.dropboxAppKeyIsNotConfiguredInThisBuild',
                'Dropbox app key is not configured in this build.',
            ), 'error');
            return;
        }
        setDropboxBusy(true);
        try {
            const credentialHandle = dropboxCredentialHandleRef.current;
            const connected = credentialHandle
                ? true
                : await SyncService.isDropboxConnected(appKey);
            if (!connected) {
                setDropboxConnected(false);
                setDropboxTestState('error');
                showToast(resolveText('settings.syncMobile.pleaseConnectDropboxFirst', 'Please connect Dropbox first.'), 'error');
                return;
            }
            await SyncService.testDropboxConnection(appKey, {
                credentialHandle: credentialHandle ?? undefined,
            });
            setDropboxConnected(true);
            setDropboxTestState('success');
            showToast(resolveText('settings.syncMobile.dropboxAccountIsReachable', 'Dropbox account is reachable.'), 'success');
        } catch (error) {
            const message = resolveText('settings.syncMobile.connectionFailed', 'Connection failed');
            void logError(error, { scope: 'sync', step: 'testDropboxConnection' });
            setDropboxConnected(Boolean(dropboxCredentialHandleRef.current));
            setDropboxTestState('error');
            setSyncError(message);
            showToast(message, 'error');
        } finally {
            setDropboxBusy(false);
        }
    }, [dropboxAppKey, resolveText, showToast]);

    const commitProvenSyncConfiguration = useCallback(async (
        config: DesktopSyncConfigOverride,
        activationGeneration: number,
    ): Promise<boolean> => {
        let commitResult: Awaited<ReturnType<typeof SyncService.commitProvenSyncConfiguration>>;
        try {
            commitResult = await SyncService.commitProvenSyncConfiguration(config);
        } catch (error) {
            if (config.backend === 'file') {
                const message = error instanceof Error ? error.message : String(error);
                throw new Error(formatSyncPathError(message));
            }
            throw error;
        }
        if (config.dropboxCredentialHandle && commitResult?.handleFinalized !== false) {
            clearLocalDropboxCredentialHandle(config.dropboxCredentialHandle);
        }
        // These fields describe durable state, even when a newer editor change
        // arrived while the transaction was in flight.
        setPersistedSyncBackend(config.backend);
        if (config.backend === 'cloud') {
            setPersistedCloudProvider(config.cloudProvider ?? 'selfhosted');
        }
        if (syncConfigurationGeneration.current !== activationGeneration) {
            hasPendingSyncConfiguration.current = true;
            return false;
        }
        if (config.backend === 'webdav' && config.webdav) {
            setWebdavHasPassword(Boolean(config.webdav.password?.trim()) || config.webdav.hasPassword === true);
        }
        hasPendingSyncConfiguration.current = false;
        showSaved();
        if (config.backend === 'cloud' && config.cloudProvider === 'selfhosted') {
            setCalendarFeedReloadToken((token) => token + 1);
        }
        return true;
    }, [clearLocalDropboxCredentialHandle, formatSyncPathError, showSaved]);

    const handleSync = useCallback(async () => {
        const activationGeneration = syncConfigurationGeneration.current;
        const activationCredentialHandle = dropboxCredentialHandleRef.current;
        const resolveCapturedCredential = async () => {
            if (!activationCredentialHandle) return;
            await discardDropboxCredential(activationCredentialHandle, {
                refreshDurableConnection: true,
            });
        };
        addBreadcrumb('sync:manual');
        try {
            setSyncError(null);

            if (syncBackend === 'off') {
                return;
            }
            const configOverride: DesktopSyncConfigOverride = { backend: syncBackend };
            if (syncBackend === 'webdav') {
                const url = webdavUrl.trim();
                if (!url || !validateSyncHttpUrl(url, webdavAllowInsecureHttp)) return;
                configOverride.webdav = {
                    url,
                    username: webdavUsername.trim(),
                    password: webdavPassword.trim() || undefined,
                    hasPassword: webdavHasPassword,
                    allowInsecureHttp: webdavAllowInsecureHttp,
                };
            }
            if (syncBackend === 'cloud') {
                configOverride.cloudProvider = cloudProvider;
                if (cloudProvider === 'selfhosted') {
                    const url = cloudUrl.trim();
                    const token = cloudToken.trim();
                    if (!url || !validateSyncHttpUrl(url, cloudAllowInsecureHttp)) return;
                    if (!validateCloudToken(token)) return;
                    configOverride.cloud = {
                        url,
                        token,
                        rememberToken: !isTauri && cloudRememberToken,
                        allowInsecureHttp: cloudAllowInsecureHttp,
                    };
                } else {
                    const appKey = dropboxAppKey.trim();
                    if (!appKey) {
                        const message = resolveText(
                            'settings.syncMobile.dropboxAppKeyIsNotConfiguredInThisBuild',
                            'Dropbox app key is not configured in this build.',
                        );
                        setSyncError(message);
                        showToast(message, 'error');
                        return;
                    }
                    const credentialHandle = activationCredentialHandle;
                    if (credentialHandle) {
                        configOverride.dropboxCredentialHandle = credentialHandle;
                    }
                    const connected = credentialHandle
                        ? true
                        : await SyncService.isDropboxConnected(appKey);
                    if (!connected) {
                        const message = resolveText(
                            'settings.syncMobile.pleaseConnectDropboxFirst',
                            'Please connect Dropbox first.',
                        );
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
                if (!path) return;
                configOverride.syncPath = path;
            }

            if (syncConfigurationGeneration.current !== activationGeneration) {
                await resolveCapturedCredential();
                return;
            }

            const needsActivationProbe = hasPendingSyncConfiguration.current
                || Boolean(configOverride.dropboxCredentialHandle)
                || configOverride.backend !== persistedSyncBackend
                || (
                    configOverride.backend === 'cloud'
                    && configOverride.cloudProvider !== persistedCloudProvider
            );
            if (needsActivationProbe) {
                if (configOverride.backend === 'webdav' && configOverride.webdav) {
                    await SyncService.testWebDavConnection(configOverride.webdav);
                }
                const probeResult = await SyncService.performSync({
                    activationProbe: true,
                    configOverride,
                    manual: true,
                });
                if (probeResult.skipped === 'requeued') {
                    if (configOverride.dropboxCredentialHandle) {
                        await resolveCapturedCredential();
                    }
                    showToast(resolveText(
                        'settings.syncQueuedBody',
                        'Local changes arrived during sync. A retry was queued automatically.',
                    ), 'info');
                    return;
                }
                if (
                    !probeResult.success
                    && classifySyncEncryptionFailure(probeResult.error) === 'remote-encrypted-no-key'
                    && (await SyncService.getSyncEncryptionStatus()).state === 'remote-encrypted-no-key'
                ) {
                    // An encrypted remote is transport PROOF, not a failed probe: the
                    // read reached the sync location and found a valid Mindwtr document
                    // this device has no key for (the discovery just persisted the
                    // no-key state). Refusing to activate here would deadlock joining
                    // an already-encrypted location — unlock requires a durable
                    // backend, and the backend could only become durable through a
                    // sync that needs the key (#1001).
                    if (syncConfigurationGeneration.current !== activationGeneration) {
                        await resolveCapturedCredential();
                        return;
                    }
                    const committedEncryptedConfiguration = await commitProvenSyncConfiguration(
                        configOverride,
                        activationGeneration,
                    );
                    if (committedEncryptedConfiguration) {
                        showToast(resolveText(
                            'settings.syncEncryptionRemoteEncrypted',
                            'This sync location is encrypted. Enter its sync passphrase to continue syncing.',
                        ), 'info', 6000);
                    }
                    return;
                }
                if (
                    !probeResult.success
                    || probeResult.remoteWriteDeferred
                    || probeResult.skipped === 'offline'
                    || probeResult.skipped === 'pendingRemoteWriteBackoff'
                ) {
                    if (configOverride.dropboxCredentialHandle) {
                        await resolveCapturedCredential();
                    }
                    if (probeResult.error) {
                        void logError(new Error(probeResult.error), { scope: 'sync', step: 'activationProbe' });
                    }
                    const verificationMessage = resolveText(
                        'settings.sync.verificationFailed',
                        'Sync setup could not be verified. Your previous sync settings are still active.',
                    );
                    // Without the underlying reason the toast reads as "saving is
                    // broken" when the target simply refused one sync (#1001).
                    const probeReason = probeResult.error?.trim().slice(0, 200);
                    const verificationToast = probeReason
                        ? [verificationMessage, probeReason].join('\n')
                        : verificationMessage;
                    showToast(verificationToast, 'error', 6000);
                    return;
                }
                if (syncConfigurationGeneration.current !== activationGeneration) {
                    await resolveCapturedCredential();
                    return;
                }
                const committedCurrentConfiguration = await commitProvenSyncConfiguration(
                    configOverride,
                    activationGeneration,
                );
                if (!committedCurrentConfiguration) return;
            }

            const result = await SyncService.performSync({
                manual: true,
                ignorePendingRemoteWriteBackoff: needsActivationProbe,
            });
            if (result.skipped === 'requeued') {
                showToast(resolveText(
                    'settings.syncQueuedBody',
                    'Local changes arrived during sync. A retry was queued automatically.',
                ), 'info');
            } else if (
                result.success
                && !result.remoteWriteDeferred
                && result.skipped !== 'offline'
                && result.skipped !== 'pendingRemoteWriteBackoff'
            ) {
                const mergeSummary = summarizeMergeStats(result.stats);
                const maxClockSkewMs = mergeSummary.maxClockSkewMs;
                const timestampAdjustments = mergeSummary.timestampAdjustments;
                showToast(resolveText('settings.lastSyncSuccess', 'Sync completed'), 'success');
                if (maxClockSkewMs > CLOCK_SKEW_THRESHOLD_MS) {
                    showToast(
                        formatText(
                            'settings.syncClockSkewWarning',
                            'Large device clock skew detected ({skew}). Check time settings on each device.',
                            { skew: formatClockSkew(maxClockSkewMs) },
                        ),
                        'info',
                        7000
                    );
                } else if (timestampAdjustments > 0) {
                    showToast(
                        formatText(
                            'settings.syncAdjustedTimestamps',
                            'Adjusted {count} future-dated timestamps during sync.',
                            { count: timestampAdjustments },
                        ),
                        'info',
                        7000
                    );
                }
                if (isTauri) {
                    setSnapshots(await SyncService.listDataSnapshots());
                }
            } else {
                if (result.error) {
                    void logError(new Error(result.error), { scope: 'sync', step: 'performResult' });
                }
                const message = isSyncEncryptionRemoteVersionUnavailableError(result.error)
                    ? resolveText(
                        'settings.syncEncryptionErrorBackendIncompatible',
                        'This WebDAV server does not provide or enforce safe version checks (strong ETags and conditional writes), so Mindwtr cannot safely sync or change encryption. Use a compatible WebDAV provider, File Sync, or Dropbox.',
                    )
                    : resolveText(
                        'settings.sync.incomplete',
                        'Sync did not complete. Your previous sync settings are still active.',
                    );
                showToast(message, 'error');
            }
        } catch (error) {
            if (activationCredentialHandle) {
                await resolveCapturedCredential();
            }
            void logError(error, { scope: 'sync', step: 'perform' });
            const message = isSyncEncryptionRemoteVersionUnavailableError(error)
                ? resolveText(
                    'settings.syncEncryptionErrorBackendIncompatible',
                    'This WebDAV server does not provide or enforce safe version checks (strong ETags and conditional writes), so Mindwtr cannot safely sync or change encryption. Use a compatible WebDAV provider, File Sync, or Dropbox.',
                )
                : resolveText('settings.lastSyncError', 'Sync failed');
            setSyncError(message);
            showToast(message, 'error');
        }
    }, [
        cloudProvider,
        cloudAllowInsecureHttp,
        cloudRememberToken,
        cloudToken,
        cloudUrl,
        commitProvenSyncConfiguration,
        discardDropboxCredential,
        discardPendingDropboxCredential,
        dropboxAppKey,
        formatText,
        isTauri,
        persistedCloudProvider,
        persistedSyncBackend,
        resolveText,
        showToast,
        syncBackend,
        syncPath,
        validateCloudToken,
        validateSyncHttpUrl,
        webdavAllowInsecureHttp,
        webdavHasPassword,
        webdavPassword,
        webdavUrl,
        webdavUsername,
    ]);

    const handleSyncPathChange = useCallback((value: string) => {
        advanceSyncConfigurationGeneration();
        hasPendingSyncConfiguration.current = true;
        setSyncPath(value);
    }, [advanceSyncConfigurationGeneration]);
    const handleWebdavUrlChange = useCallback((value: string) => {
        advanceSyncConfigurationGeneration();
        hasPendingSyncConfiguration.current = true;
        setWebdavUrl(value);
    }, [advanceSyncConfigurationGeneration]);
    const handleWebdavUsernameChange = useCallback((value: string) => {
        advanceSyncConfigurationGeneration();
        hasPendingSyncConfiguration.current = true;
        setWebdavUsername(value);
    }, [advanceSyncConfigurationGeneration]);
    const handleWebdavPasswordChange = useCallback((value: string) => {
        advanceSyncConfigurationGeneration();
        hasPendingSyncConfiguration.current = true;
        setWebdavPassword(value);
    }, [advanceSyncConfigurationGeneration]);
    const handleWebdavAllowInsecureHttpChange = useCallback((value: boolean) => {
        advanceSyncConfigurationGeneration();
        hasPendingSyncConfiguration.current = true;
        setWebdavAllowInsecureHttp(value);
    }, [advanceSyncConfigurationGeneration]);
    const handleCloudUrlChange = useCallback((value: string) => {
        advanceSyncConfigurationGeneration();
        hasPendingSyncConfiguration.current = true;
        setCloudUrl(value);
    }, [advanceSyncConfigurationGeneration]);
    const handleCloudTokenChange = useCallback((value: string) => {
        advanceSyncConfigurationGeneration();
        hasPendingSyncConfiguration.current = true;
        setCloudToken(value);
    }, [advanceSyncConfigurationGeneration]);
    const handleCloudRememberTokenChange = useCallback((value: boolean) => {
        advanceSyncConfigurationGeneration();
        hasPendingSyncConfiguration.current = true;
        setCloudRememberToken(value);
    }, [advanceSyncConfigurationGeneration]);
    const handleCloudAllowInsecureHttpChange = useCallback((value: boolean) => {
        advanceSyncConfigurationGeneration();
        hasPendingSyncConfiguration.current = true;
        setCloudAllowInsecureHttp(value);
    }, [advanceSyncConfigurationGeneration]);

    const handleRestoreSnapshot = useCallback(async (snapshotFileName: string) => {
        if (!snapshotFileName) return false;
        addBreadcrumb('transfer:restore');
        setIsRestoringSnapshot(true);
        try {
            const result = await SyncService.restoreDataSnapshot(snapshotFileName);
            if (!result.success) {
                showToast(result.error || resolveText('settings.backupMobile.restoreFailed', 'Restore failed'), 'error');
                return false;
            }
            showToast(resolveText('settings.backupMobile.recoverySnapshotRestored', 'Recovery snapshot restored.'), 'success');
            setSnapshots(await SyncService.listDataSnapshots());
            return true;
        } finally {
            setIsRestoringSnapshot(false);
        }
    }, [resolveText, showToast]);

    // Undo rides the result toast itself, so the affordance dies with the message —
    // no persistent roll-back button anywhere. Restore is destructive, so this goes
    // behind a confirmation of the same weight as a manual snapshot restore.
    const buildUndoAction = useCallback((snapshotName?: string | null) => {
        if (!snapshotName) return undefined;
        return {
            label: resolveText('settings.undoImport', 'Undo'),
            onClick: () => void (async () => {
                const confirmed = await requestConfirmation({
                    title: resolveText('settings.undoImportConfirmTitle', 'Undo this change?'),
                    message: formatText(
                        'settings.undoImportConfirm',
                        'Restore the snapshot taken just before this change ({{snapshotName}})? Anything you changed since is rolled back too.',
                        { snapshotName },
                    ),
                });
                if (!confirmed) return;
                await handleRestoreSnapshot(snapshotName);
            })(),
        };
    }, [formatText, handleRestoreSnapshot, requestConfirmation, resolveText]);

    const handleExportBackup = useCallback(async () => {
        addBreadcrumb('transfer:export');
        setTransferAction('export');
        try {
            await exportDesktopBackup(getInMemoryAppDataSnapshot());
            showToast(resolveText('settings.exportSuccess', 'Data exported successfully!'), 'success');
        } catch (error) {
            showToast(toErrorMessage(error, resolveText('settings.backupMobile.failedToExportBackup', 'Failed to export backup')), 'error');
        } finally {
            setTransferAction(null);
        }
    }, [resolveText, showToast, toErrorMessage]);

    const handleExportCsv = useCallback(async () => {
        addBreadcrumb('transfer:export');
        setTransferAction('export:csv');
        try {
            await exportDesktopCsv(getInMemoryAppDataSnapshot());
            showToast(resolveText('settings.exportCsvSuccess', 'CSV exported successfully!'), 'success');
        } catch (error) {
            showToast(toErrorMessage(error, resolveText('settings.exportCsvFailed', 'Failed to export CSV')), 'error');
        } finally {
            setTransferAction(null);
        }
    }, [resolveText, showToast, toErrorMessage]);

    const handleExportTaskNotes = useCallback(async () => {
        addBreadcrumb('transfer:export');
        setTransferAction('export:tasknotes');
        try {
            await exportDesktopTaskNotes(getInMemoryAppDataSnapshot());
            showToast(resolveText('settings.exportTaskNotesSuccess', 'TaskNotes files exported successfully!'), 'success');
        } catch (error) {
            showToast(toErrorMessage(error, resolveText('settings.exportTaskNotesFailed', 'Failed to export TaskNotes files')), 'error');
        } finally {
            setTransferAction(null);
        }
    }, [resolveText, showToast, toErrorMessage]);

    const handleRestoreBackup = useCallback(async () => {
        addBreadcrumb('transfer:restore');
        setTransferAction('restore');
        try {
            const validation = await inspectDesktopBackup(appVersion);
            if (!validation) return;
            if (!validation.valid || !validation.data) {
                showToast(formatImportError(validation.diagnostics, resolveText('settings.backupMobile.thisFileIsNotAValidMindwtrBackup', 'This file is not a valid Mindwtr backup.')), 'error');
                return;
            }

            const confirmed = await requestConfirmation({
                title: resolveText('settings.backupMobile.restoreBackup', 'Restore backup?'),
                message: buildBackupConfirmation(
                    validation,
                    resolveText('settings.backupMobile.thisWillReplaceAllCurrentLocalDataARecoverySnapshot', 'This will replace all current local data. A recovery snapshot will be saved first.'),
                    formatText,
                    formatImportDiagnosticText,
                ),
            });
            if (!confirmed) return;

            const { snapshotName } = await restoreDesktopBackup(validation.data);
            if (isTauri) {
                setSnapshots(await SyncService.listDataSnapshots());
            }
            showToast(snapshotName
                ? formatText('settings.backupMobile.backupRestoredWithSnapshot', 'Backup restored successfully. Recovery snapshot saved as {{snapshotName}}.', { snapshotName })
                : resolveText('settings.backupMobile.restoreComplete', 'Restore complete'), 'success', 6000, buildUndoAction(snapshotName));
        } catch (error) {
            showToast(formatThrownBackupError(error, resolveText('settings.backupMobile.restoreFailed', 'Restore failed')), 'error');
        } finally {
            setTransferAction(null);
        }
    }, [buildUndoAction, appVersion, formatImportDiagnosticText, formatImportError, formatText, formatThrownBackupError, isTauri, requestConfirmation, resolveText, showToast]);

    const handleMergeBackup = useCallback(async () => {
        addBreadcrumb('transfer:restore');
        setTransferAction('merge');
        try {
            const validation = await inspectDesktopBackup(appVersion);
            if (!validation) return;
            if (!validation.valid || !validation.data) {
                showToast(formatImportError(validation.diagnostics, resolveText('settings.backupMobile.thisFileIsNotAValidMindwtrBackup', 'This file is not a valid Mindwtr backup.')), 'error');
                return;
            }

            const confirmed = await requestConfirmation({
                title: resolveText('settings.mergeBackup', 'Merge Backup'),
                message: buildBackupConfirmation(
                    validation,
                    resolveText(
                        'settings.mergeBackupConfirm',
                        'Newer items from the backup are combined with your current data. Nothing local is removed, and items you deleted here stay deleted. A recovery snapshot is saved first when available.',
                    ),
                    formatText,
                    formatImportDiagnosticText,
                ),
            });
            if (!confirmed) return;

            const { snapshotName, result } = await mergeDesktopBackup(validation.data);
            if (isTauri) {
                setSnapshots(await SyncService.listDataSnapshots());
            }
            const merged = summarizeBackupMerge(result);
            const details = [
                formatText(
                    'settings.mergeBackupSummary',
                    '{{addedCount}} task(s) added, {{updatedCount}} updated.',
                    { addedCount: merged.added, updatedCount: merged.updated },
                ),
                snapshotName ? formatText('settings.backupMobile.recoverySnapshotSaved', 'Recovery snapshot saved as {{snapshotName}}.', { snapshotName }) : null,
            ].filter(Boolean).join('\n');
            showToast(details, 'success', 6000, buildUndoAction(snapshotName));
        } catch (error) {
            showToast(formatThrownBackupError(error, resolveText('settings.mergeBackupFailed', 'Merge failed')), 'error');
        } finally {
            setTransferAction(null);
        }
    }, [buildUndoAction, appVersion, formatImportDiagnosticText, formatImportError, formatText, formatThrownBackupError, isTauri, requestConfirmation, resolveText, showToast]);

    const handleImportTodoist = useCallback(async () => {
        addBreadcrumb('transfer:restore');
        setTransferAction('import:todoist');
        try {
            const parseResult = await inspectDesktopTodoistImport();
            if (!parseResult) return;
            if (!parseResult.valid || !parseResult.preview) {
                showToast(formatImportError(parseResult.diagnostics, resolveText('settings.backupMobile.theSelectedFileIsNotASupportedTodoistExport', 'The selected file is not a supported Todoist export.')), 'error');
                return;
            }

            const preview = parseResult.preview;
            const projectLines = preview.projects
                .slice(0, 4)
                .map((project: { name: string; taskCount: number }) => `- ${project.name}: ${project.taskCount}`);
            if (preview.projects.length > 4) {
                projectLines.push(formatText('settings.backupMobile.moreProjects', '• {{projectCount}} more project(s)…', { projectCount: preview.projects.length - 4 }));
            }

            const confirmed = await requestConfirmation({
                title: resolveText('settings.backupMobile.importTodoistData', 'Import Todoist data?'),
                message: [
                    formatText('settings.backupMobile.importTodoistTasksFromProjects', 'Import {{taskCount}} tasks from {{projectCount}} Todoist project(s)?', { taskCount: preview.taskCount, projectCount: preview.projectCount }),
                    preview.sectionCount > 0 ? formatText('settings.backupMobile.sectionsWillBePreserved', '{{sectionCount}} section(s) will be preserved.', { sectionCount: preview.sectionCount }) : null,
                    preview.checklistItemCount > 0 ? formatText('settings.backupMobile.subtasksWillBecomeChecklistItems', '{{subtaskCount}} subtask(s) will become checklist items.', { subtaskCount: preview.checklistItemCount }) : null,
                    resolveText('settings.backupMobile.importedTasksStayInInboxSoYouCanProcessThem', 'Imported tasks stay in Inbox so you can process them in Mindwtr.'),
                    ...(projectLines.length > 0 ? ['', ...projectLines] : []),
                    ...(preview.warnings.length > 0 ? ['', ...formatImportMessages(preview.warnings)] : []),
                ].filter(Boolean).join('\n'),
            });
            if (!confirmed) return;

            const { snapshotName, result } = await importDesktopTodoistData(parseResult.parsedProjects);
            if (isTauri) {
                setSnapshots(await SyncService.listDataSnapshots());
            }
            const details = [
                formatText(
                    'settings.importTodoistSummary',
                    'Imported {{taskCount}} tasks into {{projectCount}} project(s).',
                    {
                        taskCount: result.importedTaskCount,
                        projectCount: result.importedProjectCount,
                    },
                ),
                result.importedChecklistItemCount > 0 ? formatText('settings.backupMobile.subtasksBecameChecklistItems', '{{subtaskCount}} subtask(s) became checklist items.', { subtaskCount: result.importedChecklistItemCount }) : null,
                snapshotName ? formatText('settings.backupMobile.recoverySnapshotSaved', 'Recovery snapshot saved as {{snapshotName}}.', { snapshotName }) : null,
                ...(result.warnings.length > 0 ? ['', ...formatImportMessages(result.warnings)] : []),
            ].filter(Boolean).join('\n');
            showToast(details, 'success', 7000, buildUndoAction(snapshotName));
        } catch (error) {
            showToast(toErrorMessage(error, resolveText('settings.backupMobile.importFailed', 'Import failed')), 'error');
        } finally {
            setTransferAction(null);
        }
    }, [buildUndoAction, formatImportError, formatImportMessages, formatText, isTauri, requestConfirmation, resolveText, showToast, toErrorMessage]);


    const handleImportTickTick = useCallback(async () => {
        addBreadcrumb('transfer:restore');
        setTransferAction('import:ticktick');
        try {
            const parseResult = await inspectDesktopTickTickImport();
            if (!parseResult) return;
            if (!parseResult.valid || !parseResult.preview || !parseResult.parsedData) {
                showToast(formatImportError(parseResult.diagnostics, resolveText('settings.backupMobile.theSelectedFileIsNotASupportedTicktickBackup', 'The selected file is not a supported TickTick backup.')), 'error');
                return;
            }

            const preview = parseResult.preview;
            const projectLines = preview.projects
                .slice(0, 4)
                .map((project: { areaName?: string; name: string; taskCount: number }) => `- ${project.areaName ? `${project.areaName} / ` : ''}${project.name}: ${project.taskCount}`);
            if (preview.projects.length > 4) {
                projectLines.push(formatText('settings.backupMobile.moreProjects', '• {{projectCount}} more project(s)…', { projectCount: preview.projects.length - 4 }));
            }

            const confirmed = await requestConfirmation({
                title: resolveText('settings.backupMobile.importTicktickData', 'Import TickTick data?'),
                message: [
                    formatText('settings.backupMobile.importTaskCountFromFile', 'Import {{taskCount}} task(s) from {{fileName}}?', { taskCount: preview.taskCount, fileName: preview.fileName }),
                    preview.areaCount > 0 ? formatText('settings.backupMobile.ticktickAreasWillBeCreated', '{{areaCount}} area(s) will be created from TickTick folders.', { areaCount: preview.areaCount }) : null,
                    preview.projectCount > 0 ? formatText('settings.backupMobile.ticktickProjectsWillBeCreated', '{{projectCount}} project(s) will be created from TickTick lists.', { projectCount: preview.projectCount }) : null,
                    preview.checklistItemCount > 0 ? formatText('settings.backupMobile.checklistItemsWillBePreserved', '{{checklistItemCount}} checklist item(s) will be preserved.', { checklistItemCount: preview.checklistItemCount }) : null,
                    preview.recurringCount > 0 ? formatText('settings.backupMobile.recurringTasksWillKeepSupportedRepeatRules', '{{taskCount}} recurring task(s) will keep supported repeat rules.', { taskCount: preview.recurringCount }) : null,
                    resolveText('settings.backupMobile.importedTasksStayInInboxSoYouCanProcessThem', 'Imported tasks stay in Inbox so you can process them in Mindwtr.'),
                    ...(projectLines.length > 0 ? ['', ...projectLines] : []),
                    ...(preview.warnings.length > 0 ? ['', ...formatImportMessages(preview.warnings)] : []),
                ].filter(Boolean).join('\n'),
            });
            if (!confirmed) return;

            const { snapshotName, result } = await importDesktopTickTickData(parseResult.parsedData);
            if (isTauri) {
                setSnapshots(await SyncService.listDataSnapshots());
            }
            const details = [
                formatText(
                    'settings.importTickTickSummary',
                    'Imported {{taskCount}} task(s), {{projectCount}} project(s), and {{areaCount}} area(s).',
                    {
                        taskCount: result.importedTaskCount,
                        projectCount: result.importedProjectCount,
                        areaCount: result.importedAreaCount,
                    },
                ),
                result.importedChecklistItemCount > 0 ? formatText('settings.backupMobile.checklistItemsPreserved', '{{checklistItemCount}} checklist item(s) were preserved.', { checklistItemCount: result.importedChecklistItemCount }) : null,
                snapshotName ? formatText('settings.backupMobile.recoverySnapshotSaved', 'Recovery snapshot saved as {{snapshotName}}.', { snapshotName }) : null,
                ...(result.warnings.length > 0 ? ['', ...formatImportMessages(result.warnings)] : []),
            ].filter(Boolean).join('\n');
            showToast(details, 'success', 8000, buildUndoAction(snapshotName));
        } catch (error) {
            showToast(toErrorMessage(error, resolveText('settings.backupMobile.importFailed', 'Import failed')), 'error');
        } finally {
            setTransferAction(null);
        }
    }, [buildUndoAction, formatImportError, formatImportMessages, formatText, isTauri, requestConfirmation, resolveText, showToast, toErrorMessage]);

    const handleImportDgt = useCallback(async () => {
        addBreadcrumb('transfer:restore');
        setTransferAction('import:dgt');
        try {
            const parseResult = await inspectDesktopDgtImport();
            if (!parseResult) return;
            if (!parseResult.valid || !parseResult.preview || !parseResult.parsedData) {
                showToast(formatImportError(parseResult.diagnostics, resolveText('settings.backupMobile.theSelectedFileIsNotASupportedDgtGtdExport', 'The selected file is not a supported DGT GTD export.')), 'error');
                return;
            }

            const preview = parseResult.preview;
            const projectLines = preview.projects
                .slice(0, 4)
                .map((project: { areaName?: string; name: string; taskCount: number }) => `- ${project.areaName ? `${project.areaName} / ` : ''}${project.name}: ${project.taskCount}`);
            if (preview.projects.length > 4) {
                projectLines.push(formatText('settings.backupMobile.moreProjects', '• {{projectCount}} more project(s)…', { projectCount: preview.projects.length - 4 }));
            }

            const confirmed = await requestConfirmation({
                title: resolveText('settings.backupMobile.importDgtGtdData', 'Import DGT GTD data?'),
                message: [
                    formatText('settings.backupMobile.importTasksFromFile', 'Import {{taskCount}} tasks from {{fileName}}?', { taskCount: preview.taskCount, fileName: preview.fileName }),
                    preview.areaCount > 0 ? formatText('settings.backupMobile.dgtAreasWillBeCreated', '{{areaCount}} area(s) will be created from DGT folders.', { areaCount: preview.areaCount }) : null,
                    preview.projectCount > 0 ? formatText('settings.backupMobile.projectsWillBeCreated', '{{projectCount}} project(s) will be created.', { projectCount: preview.projectCount }) : null,
                    preview.checklistItemCount > 0 ? formatText('settings.backupMobile.checklistItemsWillBePreserved', '{{checklistItemCount}} checklist item(s) will be preserved.', { checklistItemCount: preview.checklistItemCount }) : null,
                    preview.standaloneTaskCount > 0
                        ? formatText('settings.backupMobile.tasksWillStayOutsideProjects', '{{taskCount}} task(s) will stay outside projects so you can process them in Mindwtr.', { taskCount: preview.standaloneTaskCount })
                        : null,
                    ...(projectLines.length > 0 ? ['', ...projectLines] : []),
                    ...(preview.warnings.length > 0 ? ['', ...formatImportMessages(preview.warnings)] : []),
                ].filter(Boolean).join('\n'),
            });
            if (!confirmed) return;

            const { snapshotName, result } = await importDesktopDgtData(parseResult.parsedData);
            if (isTauri) {
                setSnapshots(await SyncService.listDataSnapshots());
            }
            const details = [
                formatText(
                    'settings.importDgtSummary',
                    'Imported {{taskCount}} task(s), {{projectCount}} project(s), and {{areaCount}} area(s).',
                    {
                        taskCount: result.importedTaskCount,
                        projectCount: result.importedProjectCount,
                        areaCount: result.importedAreaCount,
                    },
                ),
                result.importedChecklistItemCount > 0 ? formatText('settings.backupMobile.checklistItemsPreserved', '{{checklistItemCount}} checklist item(s) were preserved.', { checklistItemCount: result.importedChecklistItemCount }) : null,
                snapshotName ? formatText('settings.backupMobile.recoverySnapshotSaved', 'Recovery snapshot saved as {{snapshotName}}.', { snapshotName }) : null,
                ...(result.warnings.length > 0 ? ['', ...formatImportMessages(result.warnings)] : []),
            ].filter(Boolean).join('\n');
            showToast(details, 'success', 8000, buildUndoAction(snapshotName));
        } catch (error) {
            showToast(toErrorMessage(error, resolveText('settings.backupMobile.importFailed', 'Import failed')), 'error');
        } finally {
            setTransferAction(null);
        }
    }, [buildUndoAction, formatImportError, formatImportMessages, formatText, isTauri, requestConfirmation, resolveText, showToast, toErrorMessage]);

    const handleImportOmniFocus = useCallback(async () => {
        addBreadcrumb('transfer:restore');
        setTransferAction('import:omnifocus');
        try {
            const parseResult = await inspectDesktopOmniFocusImport();
            if (!parseResult) return;
            if (!parseResult.valid || !parseResult.preview || !parseResult.parsedData) {
                showToast(formatImportError(parseResult.diagnostics, resolveText('settings.backupMobile.theSelectedFileIsNotASupportedOmnifocusExport', 'The selected file is not a supported OmniFocus export.')), 'error');
                return;
            }

            const preview = parseResult.preview;
            const projectLines = preview.projects
                .slice(0, 4)
                .map((project) => `- ${project.name}: ${project.taskCount}`);
            if (preview.projects.length > 4) {
                projectLines.push(formatText('settings.backupMobile.moreProjects', '• {{projectCount}} more project(s)…', { projectCount: preview.projects.length - 4 }));
            }

            const confirmed = await requestConfirmation({
                title: resolveText('settings.backupMobile.importOmnifocusData', 'Import OmniFocus data?'),
                message: [
                    formatText('settings.backupMobile.importTaskCountFromFile', 'Import {{taskCount}} task(s) from {{fileName}}?', { taskCount: preview.taskCount, fileName: preview.fileName }),
                    preview.projectCount > 0 ? formatText('settings.backupMobile.projectsWillBeCreatedWhenNeeded', '{{projectCount}} project(s) will be created when needed.', { projectCount: preview.projectCount }) : null,
                    preview.areaCount > 0 ? formatText('settings.backupMobile.omnifocusAreasWillBeCreated', '{{areaCount}} area(s) will be created from OmniFocus folders when needed.', { areaCount: preview.areaCount }) : null,
                    preview.checklistItemCount > 0 ? formatText('settings.backupMobile.nestedTasksWillBecomeChecklistItems', '{{taskCount}} nested task(s) will become checklist items when possible.', { taskCount: preview.checklistItemCount }) : null,
                    preview.standaloneTaskCount > 0
                        ? formatText('settings.backupMobile.tasksWillStayOutsideProjects', '{{taskCount}} task(s) will stay outside projects so you can process them in Mindwtr.', { taskCount: preview.standaloneTaskCount })
                        : null,
                    resolveText('settings.backupMobile.importedTasksKeepOmnifocusNotesDatesTagsRecurrenceAndChecklist', 'Imported tasks keep OmniFocus notes, dates, tags, recurrence, and checklist children when supported.'),
                    ...(projectLines.length > 0 ? ['', ...projectLines] : []),
                    ...(preview.warnings.length > 0 ? ['', ...formatImportMessages(preview.warnings)] : []),
                ].filter(Boolean).join('\n'),
            });
            if (!confirmed) return;

            const { snapshotName, result } = await importDesktopOmniFocusData(parseResult.parsedData);
            if (isTauri) {
                setSnapshots(await SyncService.listDataSnapshots());
            }
            const details = [
                formatText(
                    'settings.importOmniFocusSummary',
                    'Imported {{taskCount}} task(s) and {{projectCount}} project(s).',
                    {
                        taskCount: result.importedTaskCount,
                        projectCount: result.importedProjectCount,
                    },
                ),
                result.importedAreaCount > 0 ? formatText('settings.backupMobile.omnifocusAreasCreated', '{{areaCount}} area(s) were created from OmniFocus folders.', { areaCount: result.importedAreaCount }) : null,
                result.importedChecklistItemCount > 0 ? formatText('settings.backupMobile.nestedTasksBecameChecklistItems', '{{taskCount}} nested task(s) became checklist items.', { taskCount: result.importedChecklistItemCount }) : null,
                result.importedStandaloneTaskCount > 0 ? formatText('settings.backupMobile.tasksStayedOutsideProjects', '{{taskCount}} task(s) stayed outside projects.', { taskCount: result.importedStandaloneTaskCount }) : null,
                snapshotName ? formatText('settings.backupMobile.recoverySnapshotSaved', 'Recovery snapshot saved as {{snapshotName}}.', { snapshotName }) : null,
                ...(result.warnings.length > 0 ? ['', ...formatImportMessages(result.warnings)] : []),
            ].filter(Boolean).join('\n');
            showToast(details, 'success', 8000, buildUndoAction(snapshotName));
        } catch (error) {
            showToast(toErrorMessage(error, resolveText('settings.backupMobile.importFailed', 'Import failed')), 'error');
        } finally {
            setTransferAction(null);
        }
    }, [buildUndoAction, formatImportError, formatImportMessages, formatText, isTauri, requestConfirmation, resolveText, showToast, toErrorMessage]);

    const handleImportMindwtrCsv = useCallback(async () => {
        addBreadcrumb('transfer:restore');
        setTransferAction('import:mindwtr-csv');
        try {
            const parseResult = await inspectDesktopMindwtrCsvImport();
            if (!parseResult) return;
            if (!parseResult.valid || !parseResult.preview || !parseResult.parsedData) {
                showToast(formatImportError(parseResult.diagnostics, resolveText('settings.backupMobile.theSelectedFileIsNotASupportedMindwtrCsvFile', 'The selected file is not a supported Mindwtr CSV file.')), 'error');
                return;
            }

            const preview = parseResult.preview;
            const projectLines = preview.projects
                .slice(0, 4)
                .map((project) => `- ${project.areaName ? `${project.areaName} / ` : ''}${project.name}: ${project.taskCount}`);
            if (preview.projects.length > 4) {
                projectLines.push(formatText('settings.backupMobile.moreProjects', '• {{projectCount}} more project(s)…', { projectCount: preview.projects.length - 4 }));
            }

            const confirmed = await requestConfirmation({
                title: resolveText('settings.backupMobile.importMindwtrCsvData', 'Import Mindwtr CSV data?'),
                message: [
                    formatText('settings.backupMobile.importTaskCountFromFile', 'Import {{taskCount}} task(s) from {{fileName}}?', { taskCount: preview.taskCount, fileName: preview.fileName }),
                    preview.areaCount > 0 ? formatText('settings.backupMobile.mindwtrCsvAreasWillBeCreated', '{{areaCount}} area(s) will be created from the Area column.', { areaCount: preview.areaCount }) : null,
                    preview.projectCount > 0 ? formatText('settings.backupMobile.projectsWillBeCreatedWhenNeeded', '{{projectCount}} project(s) will be created when needed.', { projectCount: preview.projectCount }) : null,
                    preview.sectionCount > 0 ? formatText('settings.backupMobile.mindwtrCsvSectionsWillBeCreated', '{{sectionCount}} section(s) will be created from the Section column.', { sectionCount: preview.sectionCount }) : null,
                    preview.checklistItemCount > 0 ? formatText('settings.backupMobile.checklistItemsWillBePreserved', '{{checklistItemCount}} checklist item(s) will be preserved.', { checklistItemCount: preview.checklistItemCount }) : null,
                    preview.standaloneTaskCount > 0
                        ? formatText('settings.backupMobile.tasksWillStayOutsideProjects', '{{taskCount}} task(s) will stay outside projects so you can process them in Mindwtr.', { taskCount: preview.standaloneTaskCount })
                        : null,
                    ...(projectLines.length > 0 ? ['', ...projectLines] : []),
                    ...(preview.warnings.length > 0 ? ['', ...formatImportMessages(preview.warnings)] : []),
                ].filter(Boolean).join('\n'),
            });
            if (!confirmed) return;

            const { snapshotName, result } = await importDesktopMindwtrCsvData(parseResult.parsedData);
            if (isTauri) {
                setSnapshots(await SyncService.listDataSnapshots());
            }
            const details = [
                formatText(
                    'settings.importMindwtrCsvSummary',
                    'Imported {{taskCount}} task(s), {{projectCount}} project(s), {{sectionCount}} section(s), and {{areaCount}} area(s).',
                    {
                        taskCount: result.importedTaskCount,
                        projectCount: result.importedProjectCount,
                        sectionCount: result.importedSectionCount,
                        areaCount: result.importedAreaCount,
                    },
                ),
                result.importedChecklistItemCount > 0 ? formatText('settings.backupMobile.checklistItemsPreserved', '{{checklistItemCount}} checklist item(s) were preserved.', { checklistItemCount: result.importedChecklistItemCount }) : null,
                snapshotName ? formatText('settings.backupMobile.recoverySnapshotSaved', 'Recovery snapshot saved as {{snapshotName}}.', { snapshotName }) : null,
                ...(result.warnings.length > 0 ? ['', ...formatImportMessages(result.warnings)] : []),
            ].filter(Boolean).join('\n');
            showToast(details, 'success', 8000, buildUndoAction(snapshotName));
        } catch (error) {
            showToast(toErrorMessage(error, resolveText('settings.backupMobile.importFailed', 'Import failed')), 'error');
        } finally {
            setTransferAction(null);
        }
    }, [buildUndoAction, formatImportError, formatImportMessages, formatText, isTauri, requestConfirmation, resolveText, showToast, toErrorMessage]);

    const syncPreferences = settings?.syncPreferences ?? {};
    const handleUpdateSyncPreferences = useCallback(
        (updates: Partial<SyncPreferences>) => {
            updateSettings({ syncPreferences: { ...syncPreferences, ...updates } })
                .then(showSaved)
                .catch((error) => reportSettingsFailure(
                    'Failed to update sync preferences',
                    error,
                    resolveText('settings.feedback.saveFailed', "Couldn't save this setting. Try again."),
                ));
        },
        [resolveText, syncPreferences, showSaved, updateSettings],
    );

    const lastSyncAt = settings?.lastSyncAt;
    const lastSyncStats = settings?.lastSyncStats ?? null;
    const lastSyncDisplay = lastSyncAt
        ? safeFormatDate(lastSyncAt, 'PPpp', lastSyncAt)
        : lastSyncNeverLabel;

    // Target validity used to live in SettingsSyncPage; it belongs next to the
    // state it validates so the page stays pure layout.
    const isMacOS = typeof navigator !== 'undefined'
        && /mac/i.test(`${navigator.platform || ''} ${navigator.userAgent || ''}`);
    const webdavUrlError = webdavUrl.trim() ? !isValidHttpUrl(webdavUrl.trim()) : false;
    const cloudUrlError = cloudUrl.trim() ? !isValidHttpUrl(cloudUrl.trim()) : false;
    const webdavConnectionAllowed = !webdavUrlError && webdavUrl.trim()
        ? isConnectionAllowed(webdavUrl.trim(), {
            ...SYNC_LOCAL_INSECURE_URL_OPTIONS,
            allowInsecureHttp: webdavAllowInsecureHttp,
        })
        : !webdavUrl.trim();
    const cloudConnectionAllowed = !cloudUrlError && cloudUrl.trim()
        ? isConnectionAllowed(cloudUrl.trim(), {
            ...SYNC_LOCAL_INSECURE_URL_OPTIONS,
            allowInsecureHttp: cloudAllowInsecureHttp,
        })
        : !cloudUrl.trim();
    const encryption = useSyncEncryptionSettings(syncBackend, cloudProvider, persistedSyncBackend, persistedCloudProvider);
    const isSyncTargetValid =
        syncBackend === 'file'
            ? !!syncPath.trim()
            : syncBackend === 'cloudkit'
                ? true
                : syncBackend === 'webdav'
                    ? !!webdavUrl.trim() && !webdavUrlError && webdavConnectionAllowed
                    : syncBackend === 'cloud'
                        ? (cloudProvider === 'selfhosted'
                            ? !!cloudUrl.trim() && !cloudUrlError && cloudConnectionAllowed
                            : dropboxConfigured && !!dropboxAppKey.trim() && dropboxConnected)
                        : false;

    return {
        syncPageProps: {
            isTauri,
            isMacOS,
            syncBackend,
            onSetSyncBackend: handleSetSyncBackend,
            syncPath,
            onSyncPathChange: handleSyncPathChange,
            onSaveSyncPath: handleSaveSyncPath,
            onBrowseSyncPath: handleChangeSyncLocation,
            webdavUrl,
            webdavUsername,
            webdavPassword,
            webdavHasPassword,
            webdavAllowInsecureHttp,
            webdavUrlError,
            isSavingWebDav,
            isTestingWebDav,
            webdavTestState,
            onWebdavUrlChange: handleWebdavUrlChange,
            onWebdavUsernameChange: handleWebdavUsernameChange,
            onWebdavPasswordChange: handleWebdavPasswordChange,
            onWebdavAllowInsecureHttpChange: handleWebdavAllowInsecureHttpChange,
            onSaveWebDav: handleSaveWebDav,
            onTestWebDavConnection: handleTestWebDavConnection,
            cloudUrl,
            cloudUrlError,
            cloudToken,
            cloudRememberToken,
            cloudAllowInsecureHttp,
            cloudProvider,
            dropboxConfigured,
            dropboxConnected,
            dropboxBusy,
            dropboxAuthInProgress,
            dropboxRedirectUri,
            dropboxTestState,
            onCloudUrlChange: handleCloudUrlChange,
            onCloudTokenChange: handleCloudTokenChange,
            onCloudRememberTokenChange: handleCloudRememberTokenChange,
            onCloudAllowInsecureHttpChange: handleCloudAllowInsecureHttpChange,
            onCloudProviderChange: handleSetCloudProvider,
            onSaveCloud: handleSaveCloud,
            calendarFeedUrl,
            calendarFeedBusy,
            onCopyCalendarFeedUrl: handleCopyCalendarFeedUrl,
            onGenerateCalendarFeed: () => handleCalendarFeedAction('rotate'),
            onRevokeCalendarFeed: () => handleCalendarFeedAction('revoke'),
            onConnectDropbox: handleConnectDropbox,
            onDisconnectDropbox: handleDisconnectDropbox,
            onTestDropboxConnection: handleTestDropboxConnection,
            encryption,
            isSyncTargetValid,
            syncPreferences,
            onUpdateSyncPreferences: handleUpdateSyncPreferences,
            onSyncNow: handleSync,
            isSyncing: syncStatus.inFlight,
            syncQueued: syncStatus.queued,
            syncLastResult: syncStatus.lastResult,
            syncLastResultAt: syncStatus.lastResultAt,
            syncError,
            lastSyncDisplay,
            lastSyncStatus: settings?.lastSyncStatus,
            lastSyncStats,
            lastSyncHistory: settings?.lastSyncHistory ?? [],
            conflictCount: summarizeMergeStats(lastSyncStats).conflicts,
            lastSyncError: settings?.lastSyncError,
            snapshots,
            isLoadingSnapshots,
            isRestoringSnapshot,
            onRestoreSnapshot: handleRestoreSnapshot,
        } satisfies Omit<SettingsSyncPageProps, 't'>,
        dataTransferProps: {
            transferAction,
            onExportBackup: handleExportBackup,
            onExportCsv: handleExportCsv,
            onExportTaskNotes: handleExportTaskNotes,
            onRestoreBackup: handleRestoreBackup,
            onMergeBackup: handleMergeBackup,
            onImportTodoist: handleImportTodoist,
            onImportTickTick: handleImportTickTick,
            onImportDgt: handleImportDgt,
            onImportOmniFocus: handleImportOmniFocus,
            onImportMindwtrCsv: handleImportMindwtrCsv,
        } satisfies SettingsDataTransferProps,
    };
};
