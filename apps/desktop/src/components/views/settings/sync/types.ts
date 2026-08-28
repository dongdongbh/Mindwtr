import type {
    AppSettings,
    SettingsSyncPreferences,
    SyncBackend,
    SyncEncryptionState,
    SyncEncryptionTransitionProgress,
} from '@mindwtr/core';

export type SettingsSyncLabels = {
    backup: string;
    backupDesc: string;
    importData: string;
    importDataDesc: string;
    gettingStartedContentAction: string;
    gettingStartedContentDesc: string;
    gettingStartedContentConfirmTitle: string;
    gettingStartedContentConfirmDesc: string;
    gettingStartedContentConfirm: string;
    gettingStartedContentContinueTitle: string;
    gettingStartedContentContinueDesc: string;
    syncSetupGuideTitle: string;
    syncSetupGuideDesc: string;
    importSetupGuideTitle: string;
    importSetupGuideDesc: string;
    exportBackup: string;
    exportBackupDesc: string;
    exportCsv: string;
    exportCsvDesc: string;
    exportTaskNotes: string;
    exportTaskNotesDesc: string;
    restoreBackup: string;
    restoreBackupDesc: string;
    mergeBackup: string;
    mergeBackupDesc: string;
    importTodoist: string;
    importTodoistDesc: string;
    importTickTick: string;
    importTickTickDesc: string;
    importDgt: string;
    importDgtDesc: string;
    importOmniFocus: string;
    importOmniFocusDesc: string;
    importMindwtrCsv: string;
    importMindwtrCsvDesc: string;
    diagnostics: string;
    diagnosticsDesc: string;
    analyticsHeartbeat: string;
    analyticsHeartbeatDesc: string;
    analyticsHeartbeatDisableTitle: string;
    analyticsHeartbeatDisableDesc: string;
    analyticsHeartbeatDisableConfirm: string;
    analyticsHeartbeatKeepEnabled: string;
    debugLogging: string;
    debugLoggingDesc: string;
    logFile: string;
    clearLog: string;
    sync: string;
    syncDescription: string;
    syncBackend: string;
    syncBackendOff: string;
    syncBackendFile: string;
    syncBackendWebdav: string;
    syncBackendCloud: string;
    syncBackendCloudkit: string;
    syncBackendChoiceHint: string;
    syncBackendGroupCloud: string;
    syncBackendGroupCloudDesc: string;
    syncBackendGroupFile: string;
    syncBackendGroupFileDesc: string;
    syncBackendGroupAdvanced: string;
    syncBackendGroupAdvancedDesc: string;
    syncPreferences: string;
    syncPreferencesDesc: string;
    syncPreferenceAppearance: string;
    syncPreferenceLanguage: string;
    syncPreferenceGtd: string;
    syncPreferenceSavedFilters: string;
    syncPreferenceExternalCalendars: string;
    syncPreferenceAi: string;
    syncPreferenceAiHint: string;
    backgroundSync: string;
    backgroundSyncDesc: string;
    syncFolderLocation: string;
    savePath: string;
    browse: string;
    testFolder: string;
    testingFolder: string;
    folderTestSucceeded: string;
    portalPathNote: string;
    pathHint: string;
    webdavUrl: string;
    webdavHint: string;
    webdavUsername: string;
    webdavPassword: string;
    webdavSave: string;
    testConnection: string;
    webdavTestHint: string;
    webdavTestAccessibility: string;
    allowInsecureHttp: string;
    allowInsecureHttpHint: string;
    cloudUrl: string;
    cloudHint: string;
    cloudToken: string;
    cloudRememberToken: string;
    cloudRememberTokenHint: string;
    cloudSave: string;
    cloudProvider: string;
    cloudProviderSelfHosted: string;
    cloudProviderDropbox: string;
    cloudProviderCloudkit: string;
    cloudkitDesc: string;
    calendarFeed: string;
    calendarFeedDesc: string;
    calendarFeedWarning: string;
    calendarFeedNone: string;
    calendarFeedCopy: string;
    calendarFeedGenerate: string;
    calendarFeedRegenerate: string;
    calendarFeedRevoke: string;
    dropboxAppKey: string;
    dropboxAppKeyHint: string;
    dropboxRedirectUri: string;
    dropboxStatus: string;
    dropboxConnected: string;
    dropboxNotConnected: string;
    dropboxConnect: string;
    dropboxDisconnect: string;
    dropboxTest: string;
    dropboxTestReachable: string;
    dropboxTestFailed: string;
    syncNow: string;
    syncing: string;
    syncQueued: string;
    lastSync: string;
    lastSyncSuccess: string;
    lastSyncConflict: string;
    lastSyncError: string;
    lastSyncConflicts: string;
    lastSyncSkew: string;
    lastSyncAdjusted: string;
    lastSyncConflictIds: string;
    syncConflictKeptThisDevice: string;
    syncConflictKeptOtherDevice: string;
    syncConflictChanged: string;
    syncConflictDeleteRestore: string;
    syncConflictMore: string;
    syncHistory: string;
    syncHistoryBackend: string;
    syncHistoryType: string;
    syncHistoryDetails: string;
    recoverySnapshots: string;
    recoverySnapshotsDesc: string;
    recoverySnapshotsLoading: string;
    recoverySnapshotsEmpty: string;
    recoverySnapshotsRestore: string;
    recoverySnapshotsRestoreNamed: string;
    recoverySnapshotsConfirm: string;
    recoverySnapshotsConfirmTitle: string;
    recoverySnapshotsConfirmCancel: string;
    attachmentsCleanup: string;
    attachmentsCleanupDesc: string;
    attachmentsCleanupLastRun: string;
    attachmentsCleanupNever: string;
    attachmentsCleanupPendingDeletes: string;
    attachmentsCleanupPendingDeletesClear: string;
    attachmentsCleanupPendingDeletesConfirm: string;
    attachmentsCleanupPendingDeletesConfirmAction: string;
    attachmentsCleanupPendingDeletesConfirmTitle: string;
    attachmentsCleanupRun: string;
    attachmentsCleanupRunning: string;
    syncEncryption: string;
    syncEncryptionDesc: string;
    syncEncryptionEnable: string;
    syncEncryptionPassphrase: string;
    syncEncryptionPassphraseConfirm: string;
    syncEncryptionCurrentPassphrase: string;
    syncEncryptionNewPassphrase: string;
    syncEncryptionShowPassphrase: string;
    syncEncryptionGenerate: string;
    syncEncryptionGeneratedHint: string;
    syncEncryptionWarningLost: string;
    syncEncryptionWarningDevices: string;
    syncEncryptionErrorMismatch: string;
    syncEncryptionErrorWrongPassphrase: string;
    syncEncryptionErrorGeneric: string;
    syncEncryptionErrorRotationFirst: string;
    syncEncryptionErrorBackendRequired: string;
    syncEncryptionErrorBackendIncompatible: string;
    syncEncryptionErrorTransitionIncomplete: string;
    syncEncryptionCleanupDeferred: string;
    syncEncryptionStateUnavailable: string;
    syncEncryptionRetry: string;
    syncEncryptionEnableBeforeFirstSyncHint: string;
    syncEncryptionProgressAttachments: string;
    syncEncryptionProgressDocuments: string;
    syncEncryptionStatusOn: string;
    syncEncryptionChange: string;
    syncEncryptionDisable: string;
    syncEncryptionDisableWarning: string;
    syncEncryptionDisableWarningNoBackend: string;
    syncEncryptionRemotePlaintextDesc: string;
    syncEncryptionLockedTitle: string;
    syncEncryptionLockedDesc: string;
    syncEncryptionUnlock: string;
    syncEncryptionDecline: string;
    syncEncryptionPausedDesc: string;
    syncEncryptionCancel: string;
};

export type CloudProvider = 'selfhosted' | 'dropbox';

/** Which message the section shows after a failed transition. `rotation-first` is
 *  the one terminal case with a real remedy: an interrupted passphrase change left
 *  the sync location on two salts, and only re-running the change can heal it. */
export type SyncEncryptionErrorKind =
    | 'wrong-passphrase'
    | 'rotation-first'
    | 'backend-required'
    | 'transition-incomplete'
    | 'generic';

export type SyncEncryptionWarningKind = 'cleanup-deferred';

/**
 * Everything the Encryption section needs, as one object rather than a dozen flat
 * props: it is a single self-contained flow, and `useSyncEncryptionSettings` is its
 * only producer. Every action resolves to whether it succeeded, so the section can
 * close its form without re-reading state.
 */
export type SyncEncryptionController = {
    /** `null` while the first status read is in flight, unavailable, or the backend cannot encrypt. */
    state: SyncEncryptionState | null;
    stateUnavailable: boolean;
    /** File, WebDAV and Dropbox only — see `isEncryptionCapableBackend`. */
    supported: boolean;
    /** True while no encryption-capable backend is durably active (e.g. a WebDAV config
     *  typed but not yet proven by its first sync). Enable/disable then manage this
     *  device's key only; nothing remote exists to convert. */
    pendingFirstSync: boolean;
    busy: boolean;
    progress: SyncEncryptionTransitionProgress | null;
    error: SyncEncryptionErrorKind | null;
    warning: SyncEncryptionWarningKind | null;
    clearError: () => void;
    clearWarning: () => void;
    retryState: () => Promise<void>;
    generatePassphrase: () => string;
    enable: (passphrase: string) => Promise<boolean>;
    disable: () => Promise<boolean>;
    changePassphrase: (current: string, next: string) => Promise<boolean>;
    unlock: (passphrase: string) => Promise<boolean>;
    decline: () => Promise<void>;
};
export type DropboxTestState = 'idle' | 'success' | 'error';
export type SyncPreferences = SettingsSyncPreferences;

/**
 * Prop groups, one per section component. `useSyncSettings` and
 * `useSettingsDataPage` return these already named as props, so `SettingsView`
 * spreads them instead of re-listing every member (see SettingsView renderPage).
 */
export type SyncConfigurationProps = {
    isTauri: boolean;
    isMacOS: boolean;
    syncBackend: SyncBackend;
    onSetSyncBackend: (backend: SyncBackend) => void;
    syncPath: string;
    onSyncPathChange: (value: string) => void;
    onSaveSyncPath: () => Promise<void> | void;
    onBrowseSyncPath: () => void;
    isTestingSyncPath: boolean;
    onTestSyncPath: () => Promise<void> | void;
    webdavUrl: string;
    webdavUsername: string;
    webdavPassword: string;
    webdavHasPassword: boolean;
    webdavAllowInsecureHttp: boolean;
    webdavUrlError: boolean;
    isSavingWebDav: boolean;
    isTestingWebDav: boolean;
    webdavTestState: 'idle' | 'success' | 'error';
    onWebdavUrlChange: (value: string) => void;
    onWebdavUsernameChange: (value: string) => void;
    onWebdavPasswordChange: (value: string) => void;
    onWebdavAllowInsecureHttpChange: (value: boolean) => void;
    onSaveWebDav: () => Promise<void> | void;
    onTestWebDavConnection: () => Promise<void> | void;
    cloudUrl: string;
    cloudUrlError: boolean;
    cloudToken: string;
    cloudRememberToken: boolean;
    cloudAllowInsecureHttp: boolean;
    cloudProvider: CloudProvider;
    dropboxConfigured: boolean;
    dropboxConnected: boolean;
    dropboxBusy: boolean;
    dropboxAuthInProgress: boolean;
    dropboxRedirectUri: string;
    dropboxTestState: DropboxTestState;
    onCloudUrlChange: (value: string) => void;
    onCloudTokenChange: (value: string) => void;
    onCloudRememberTokenChange: (value: boolean) => void;
    onCloudAllowInsecureHttpChange: (value: boolean) => void;
    onCloudProviderChange: (provider: CloudProvider) => void;
    onSaveCloud: () => Promise<void> | void;
    /** Null until the self-hosted server reports a published iCalendar feed (#952). */
    calendarFeedUrl: string | null;
    calendarFeedBusy: boolean;
    onCopyCalendarFeedUrl: () => Promise<void> | void;
    onGenerateCalendarFeed: () => Promise<void> | void;
    onRevokeCalendarFeed: () => Promise<void> | void;
    onConnectDropbox: () => Promise<void> | void;
    onDisconnectDropbox: () => Promise<void> | void;
    onTestDropboxConnection: () => Promise<void> | void;
};

export type SyncStatusProps = {
    isSyncTargetValid: boolean;
    syncPreferences: AppSettings['syncPreferences'] | undefined;
    onUpdateSyncPreferences: (updates: Partial<SyncPreferences>) => Promise<void> | void;
    onSyncNow: () => Promise<void> | void;
    isSyncing: boolean;
    syncQueued: boolean;
    syncLastResult: 'success' | 'error' | null;
    syncLastResultAt: string | null;
    syncError: string | null;
    lastSyncDisplay: string;
    lastSyncStatus: AppSettings['lastSyncStatus'];
    lastSyncStats: AppSettings['lastSyncStats'] | null;
    lastSyncHistory: AppSettings['lastSyncHistory'] | null;
    conflictCount: number;
    lastSyncError?: string;
    snapshots: string[];
    isLoadingSnapshots: boolean;
    isRestoringSnapshot: boolean;
    onRestoreSnapshot: (snapshotFileName: string) => Promise<boolean | void> | boolean | void;
};

export type SettingsDiagnosticsProps = {
    loggingEnabled: boolean;
    analyticsHeartbeatAvailable: boolean;
    analyticsHeartbeatEnabled: boolean;
    logPath: string;
    onToggleLogging: () => void;
    onAnalyticsHeartbeatChange: (enabled: boolean) => Promise<void> | void;
    onClearLog: () => void;
};

export type TransferAction =
    | null
    | 'export'
    | 'export:csv'
    | 'export:tasknotes'
    | 'restore'
    | 'merge'
    | 'import:todoist'
    | 'import:ticktick'
    | 'import:dgt'
    | 'import:omnifocus'
    | 'import:mindwtr-csv';

export type SettingsDataTransferProps = {
    transferAction: TransferAction;
    onExportBackup: () => Promise<void> | void;
    onExportCsv: () => Promise<void> | void;
    onExportTaskNotes: () => Promise<void> | void;
    onRestoreBackup: () => Promise<void> | void;
    onMergeBackup: () => Promise<void> | void;
    onImportTodoist: () => Promise<void> | void;
    onImportTickTick: () => Promise<void> | void;
    onImportDgt: () => Promise<void> | void;
    onImportOmniFocus: () => Promise<void> | void;
    onImportMindwtrCsv: () => Promise<void> | void;
};

export type SettingsAttachmentsProps = {
    attachmentsLastCleanupDisplay: string;
    pendingRemoteDeleteCount: number;
    onClearPendingRemoteDeletes: () => Promise<void> | void;
    onRunAttachmentsCleanup: () => Promise<void> | void;
    isCleaningAttachments: boolean;
};

export type SettingsSyncPageProps = { t: SettingsSyncLabels; encryption: SyncEncryptionController }
    & SyncConfigurationProps
    & SyncStatusProps;

export type SettingsDataPageProps = { t: SettingsSyncLabels; isTauri: boolean }
    & SettingsDiagnosticsProps
    & SettingsDataTransferProps
    & SettingsAttachmentsProps
    & { onAddGettingStartedContent: () => Promise<void> | void };
