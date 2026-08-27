
import {
    assertWebdavStrongEtagSupport,
    AppData,
    AppSettings,
    Attachment,
    useTaskStore,
    MergeStats,
    webdavGetSyncDocument,
    type SyncEncryptionRemotePort,
    type SyncEncryptionStatus,
    type SyncEncryptionTransitionProgress,
    webdavHeadFile,
    webdavPutSyncDocument,
    syncEncryptedArtifactName,
    SyncCryptoUnsupportedError,
    SyncEncryptionRemotePlaintextError,
    SyncEncryptionRemoteVersionUnavailableError,
    SyncEncryptionTerminalError,
    SyncEncryptionTransitionIncompleteError,
    buildCloudCalendarFeedUrl,
    cloudGetJson,
    cloudHeadJson,
    cloudPutJson,
    cloudRequestJson,
    getCloudCalendarFeedEndpoint,
    flushPendingSave,
    performSyncCycle,
    normalizeAppData,
    normalizeWebdavUrl,
    normalizeStrongWebdavEtag,
    normalizeCloudUrl,
    runDataTransferTransactionWithoutSnapshot,
    runSerializedSyncDocumentOperation,
    runSerializedSyncDocumentWriteOperation,
    createSyncBackendIO,
    acquireSyncRemoteMutationFence,
    createDropboxSyncRemoteMutationFencePort,
    createWebdavSyncRemoteMutationFencePort,
    runSharedSyncCycle,
    SyncRemoteWriteConflict,
    sanitizeAppDataForRemote,
    computeSyncPayloadFingerprint,
    buildSyncPayloadDiffTraceExtra,
    buildSyncPayloadTraceExtra,
    isSyncPayloadTraceEnabled,
    SYNC_TRACE_EVENT_MESSAGES,
    computeCoveredSettingsFingerprint,
    areSyncPayloadsEqual,
    collectAttachmentsById,
    findDeletedAttachmentsForFileCleanup,
    findOrphanedAttachments,
    injectExternalCalendars as injectExternalCalendarsForSync,
    persistExternalCalendars as persistExternalCalendarsForSync,
    summarizeMergeStats,
    withTimeout,
    withRetry,
    isRetryableError,
    isRetryableWebdavReadError,
    appendSyncHistory,
    createSyncOrchestrator,
    createSerializedAsyncQueue,
    formatSyncErrorMessage,
    getInMemoryAppDataSnapshot,
    createAbortableFetch,
    ensureFreshLocalSyncSnapshot,
    getTranslator,
    resolveI18nText,
    LEGACY_SYNC_FILE_NAME,
    SYNC_FILE_NAME,
    type CloudCalendarFeed,
    type CloudJsonWriteResult,
    type CloudProvider,
    type FileSyncReadResult,
    type RemoteJsonWriteResult,
    type SyncBackendContext,
    type SyncBackendIO,
    type SyncRunCycleSetup,
    type SyncRunResult,
    type SyncTransport,
    type WebdavSyncReadResult,
} from '@mindwtr/core';
import { isTauriRuntime } from './runtime';
import { getTauriHttpFetch } from './tauri-http';
import { invokeNative } from './tauri-invoke';
import { reportError } from './report-error';
import { logInfo, logSyncError, logWarn, sanitizeLogMessage } from './app-log';
import { useUiStore } from '../store/ui-store';
import { markLocalSqliteWrite, markLocalWrite } from './local-data-watcher';
import { ExternalCalendarService } from './external-calendar-service';
import { webStorage } from './storage-adapter-web';
import { buildChangedEntityBaseline } from './storage-save-baseline';
import {
    cleanupAttachmentTempFiles,
    cleanupOrphanedAttachments,
    type AttachmentCleanupDeps,
} from './sync-attachment-cleanup';
import {
    clearAttachmentSyncState,
    type AttachmentBackendDeps,
    type CloudConfig,
    syncCloudAttachments,
    syncCloudKitAttachments,
    syncDropboxAttachments,
    syncFileAttachments,
    syncWebdavAttachments as syncAttachments,
    type WebDavConfig,
} from './sync-attachment-backends';
import {
    ensureCloudKitReady,
    readRemoteCloudKit,
    writeRemoteCloudKit,
} from './cloudkit-sync';
import {
    getBaseSyncUrl,
    getCloudBaseUrl,
} from './sync-attachments';
import {
    classifySyncEncryptionFailure,
    createDropboxRemotePort,
    createWebdavRemotePort,
    desktopSyncCryptoPrimitives,
    getSyncEncryptionMaterial,
    getSyncEncryptionStatus as readSyncEncryptionStatus,
    isSyncEncryptionFailure,
    markRemoteSyncEncryptionDiscovered,
    markRemoteSyncEncryptionPlaintext,
    runChangePassphraseOverRemote,
    runDisableLocalOnly,
    runDisableOverRemote,
    runEnableLocalOnly,
    runEnableOverRemote,
    SYNC_ENCRYPTION_REMOTE_ENCRYPTED,
    runProvidePassphraseOverRemote,
} from './sync-encryption-service';
import {
    getFileSyncDir,
    hashString,
    isSyncFilePath,
    normalizeSyncBackend,
    toStableJson,
    yieldToRenderer,
} from './sync-service-utils';
import {
    clearAttachmentValidationFailures,
    getAttachmentValidationFailureAttempts,
    handleAttachmentValidationFailure,
} from './sync-attachment-validation';
import {
    ensureWebdavCapabilityProof,
    rememberWebdavCapabilityProof,
} from './webdav-capability-proof';
import type { SyncBackend } from './sync-service-utils';
import type { DropboxDownloadResult } from '@mindwtr/core';
import {
    downloadDropboxAppData,
    DropboxUnauthorizedError,
    getDropboxAppDataMetadata,
    testDropboxAccess,
    uploadDropboxAppData,
} from './dropbox-sync';
import {
    CLOUD_ALLOW_INSECURE_HTTP_KEY,
    CLOUD_PROVIDER_KEY,
    CLOUD_REMEMBER_TOKEN_KEY,
    CLOUD_TOKEN_KEY,
    CLOUD_URL_KEY,
    SYNC_BACKEND_KEY,
    WEBDAV_ALLOW_INSECURE_HTTP_KEY,
    WEBDAV_ALLOW_WEAK_FINGERPRINT_KEY,
    WEBDAV_PASSWORD_KEY,
    WEBDAV_URL_KEY,
    WEBDAV_USERNAME_KEY,
    clearSyncPath,
    readCloudConfig,
    readCloudProvider,
    readDropboxAppKey,
    readSyncBackend,
    readSyncPath,
    readWebDavConfig,
    writeCloudConfig,
    writeCloudProvider,
    writeDropboxAppKey,
    writeSyncBackend,
    writeSyncPath,
    writeWebDavConfig,
} from './sync-service-config';
import {
    commitProvenSyncConfiguration as commitProvenSyncConfigurationTransaction,
    SyncConfigurationDisabledError,
    type SyncConfigurationCandidate as DesktopSyncConfigOverride,
    type PersistedSyncConfiguration as PersistedDesktopSyncConfiguration,
    type SyncConfigurationCommitResult,
    type SyncConfigurationSecretRequirements,
} from '@mindwtr/core';
import {
    buildFastSyncScope,
    clearLocalSyncStatus,
    clearFastSyncState,
    readLocalSyncStatus,
    readFastSyncState,
    writeLocalSyncStatus,
    writeFastSyncState,
} from './sync-service-fast-sync';

export type ExternalSyncChangeResolution = 'keep-local' | 'use-external' | 'merge';
export type { CloudProvider };

export type ExternalSyncChange = {
    at: string;
    incomingHash: string;
    syncPath: string;
    hasLocalChanges: boolean;
    localChangeAt: number;
    lastSyncAt?: string;
};

const DROPBOX_TRANSIENT_RETRY_OPTIONS = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 8000, shouldRetry: isRetryableError };
const WEBDAV_READ_RETRY_OPTIONS = {
    maxAttempts: 5,
    baseDelayMs: 2000,
    maxDelayMs: 30_000,
    shouldRetry: isRetryableWebdavReadError,
};
const ATTACHMENT_WARNING_TOAST_THRESHOLD = 2;
const ATTACHMENT_WARNING_TOAST_COOLDOWN_MS = 10 * 60 * 1000;
type SyncServiceDependencies = {
    isTauriRuntime: () => boolean;
    invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
    getTauriFetch: () => Promise<typeof fetch | undefined>;
    getStoreState: typeof useTaskStore.getState;
    applySyncedDataToStore: (data: AppData) => void;
    flushPendingSave: typeof flushPendingSave;
    performSyncCycle: typeof performSyncCycle;
    getInMemoryAppDataSnapshot: typeof getInMemoryAppDataSnapshot;
    markLocalWrite: typeof markLocalWrite;
    markLocalSqliteWrite: typeof markLocalSqliteWrite;
    reportError: typeof reportError;
    logInfo: typeof logInfo;
    logWarn: typeof logWarn;
    logSyncError: typeof logSyncError;
    sanitizeLogMessage: typeof sanitizeLogMessage;
    getExternalCalendars: typeof ExternalCalendarService.getCalendars;
    setExternalCalendars: typeof ExternalCalendarService.setCalendars;
    ensureCloudKitReady: typeof ensureCloudKitReady;
    readRemoteCloudKit: typeof readRemoteCloudKit;
    writeRemoteCloudKit: typeof writeRemoteCloudKit;
};

const defaultGetTauriFetch = async (): Promise<typeof fetch | undefined> => {
    if (!syncServiceDependencies.isTauriRuntime()) return undefined;
    try {
        return await getTauriHttpFetch();
    } catch (error) {
        logSyncWarning('Failed to load tauri http fetch', error);
        return undefined;
    }
};

const applySyncedDataToStore = (data: AppData): void => {
    const normalized = normalizeAppData(data);
    const allTasks = Array.isArray(normalized.tasks) ? normalized.tasks : [];
    const allProjects = Array.isArray(normalized.projects) ? normalized.projects : [];
    const allSections = Array.isArray(normalized.sections) ? normalized.sections : [];
    const allAreas = Array.isArray(normalized.areas) ? normalized.areas : [];
    const allPeople = Array.isArray(normalized.people) ? normalized.people : [];

    useTaskStore.setState((state) => ({
        _allTasks: allTasks,
        _allProjects: allProjects,
        _allSections: allSections,
        _allAreas: allAreas,
        _allPeople: allPeople,
        settings: normalized.settings ?? state.settings,
    }));
};

const defaultSyncServiceDependencies: SyncServiceDependencies = {
    isTauriRuntime,
    invoke: invokeNative,
    getTauriFetch: defaultGetTauriFetch,
    getStoreState: useTaskStore.getState,
    applySyncedDataToStore,
    flushPendingSave,
    performSyncCycle,
    getInMemoryAppDataSnapshot,
    markLocalWrite,
    markLocalSqliteWrite,
    reportError,
    logInfo,
    logWarn,
    logSyncError,
    sanitizeLogMessage,
    getExternalCalendars: () => ExternalCalendarService.getCalendars(),
    setExternalCalendars: (calendars) => ExternalCalendarService.setCalendars(calendars),
    ensureCloudKitReady,
    readRemoteCloudKit,
    writeRemoteCloudKit,
};

let syncServiceDependencies: SyncServiceDependencies = {
    ...defaultSyncServiceDependencies,
};

const isTauriRuntimeEnv = () => syncServiceDependencies.isTauriRuntime();
const getStoreState = () => syncServiceDependencies.getStoreState();
const syncRestoreQueue = createSerializedAsyncQueue();
const runSyncRestoreExclusive = <T>(operation: () => Promise<T>): Promise<T> => (
    syncRestoreQueue.run(operation)
);
const runSyncDocumentExclusive = <T>(operation: () => Promise<T>): Promise<T> => (
    runSyncRestoreExclusive(() => runSerializedSyncDocumentOperation(operation))
);
const runSyncDocumentWriteExclusive = <T>(operation: () => Promise<T>): Promise<T> => (
    runSyncRestoreExclusive(() => runSerializedSyncDocumentWriteOperation(operation))
);

const resolveSyncText = (key: string, fallback: string): string => resolveI18nText(
    getTranslator(getStoreState().settings?.language ?? 'en'),
    key,
    { fallback },
);

/** A failed decrypt is never a permission problem and never "corrupt data we repaired" — it
 *  always means this device needs the sync passphrase again (#1056 decision #4). Mapping it
 *  here keeps it out of the generic failure toast. The message is built into a variable
 *  because desktop's toast-i18n test scans showToast's FIRST argument for prose literals.
 *  Phase 3 owns the settings surface that turns this into a re-entry prompt; the fallbacks
 *  carry the wording until its locale keys land. */
const resolveSyncFailureMessage = (rawError: string | undefined): string => {
    switch (classifySyncEncryptionFailure(rawError)) {
        case 'local-state-unavailable':
            return resolveSyncText(
                'settings.syncEncryptionStateUnavailable',
                'Sync is paused because this device could not read its local encryption state. Restart Mindwtr and try again. If the problem continues, keep sync paused and contact support before changing this sync setup.',
            );
        case 'transition-incomplete':
            return resolveSyncText(
                'settings.syncEncryptionErrorTransitionIncomplete',
                'This encryption change may be incomplete. Sync remains paused. Retry the same encryption action before changing or disconnecting this sync location.',
            );
        case 'remote-plaintext':
            return resolveSyncText(
                'settings.syncEncryptionRemotePlaintext',
                'Sync stopped: this sync location is no longer encrypted. Turn sync encryption off on this device, or turn it back on at the sync location.',
            );
        case 'remote-encrypted-no-key':
            return resolveSyncText(
                'settings.syncEncryptionRemoteEncrypted',
                'This sync location is encrypted. Enter its sync passphrase to continue syncing.',
            );
        case 'needs-passphrase':
            return resolveSyncText(
                'settings.syncEncryptionPassphraseNeeded',
                'Sync stopped: the sync passphrase for this location did not work. Enter it again to continue.',
            );
        default:
            return rawError || resolveSyncText('settings.queuedSyncFailed', 'Queued sync failed.');
    }
};

const logSyncWarning = (message: string, error?: unknown) => {
    const extra = error
        ? { error: syncServiceDependencies.sanitizeLogMessage(error instanceof Error ? error.message : String(error)) }
        : undefined;
    void syncServiceDependencies.logWarn(message, { scope: 'sync', extra });
};

const logSyncInfo = (message: string, extra?: Record<string, string>) => {
    void syncServiceDependencies.logInfo(message, { scope: 'sync', extra });
};

const logSyncPayloadTrace = (
    message: string,
    data: AppData | null | undefined,
    extra?: Record<string, string>,
): void => {
    if (!isSyncPayloadTraceEnabled(getStoreState().settings)) return;
    logSyncInfo(message, buildSyncPayloadTraceExtra(data, extra));
};

const externalCalendarProvider = {
    load: () => syncServiceDependencies.getExternalCalendars(),
    save: (calendars: AppSettings['externalCalendars'] | undefined) =>
        syncServiceDependencies.setExternalCalendars(calendars ?? []),
    onWarn: (message: string, error?: unknown) => logSyncWarning(message, error),
};

const injectExternalCalendars = async (data: AppData): Promise<AppData> =>
    injectExternalCalendarsForSync(data, externalCalendarProvider);

const persistExternalCalendars = async (data: AppData): Promise<void> =>
    persistExternalCalendarsForSync(data, externalCalendarProvider);

const mergeLocalSyncStatus = (data: AppData): AppData => {
    const localStatus = readLocalSyncStatus();
    if (!localStatus) return data;
    return normalizeAppData({
        ...data,
        settings: {
            ...(data.settings ?? {}),
            ...localStatus,
        },
    });
};

// Sync should start from persisted data so startup sync cannot overwrite settings with an unhydrated store snapshot.
let lastObservedPersistedDataForSync: AppData | null = null;

const readLocalDataForSync = async (): Promise<AppData> => {
    if (isTauriRuntimeEnv()) {
        try {
            const persisted = await invokeSyncNative<AppData>('get_data');
            lastObservedPersistedDataForSync = persisted;
            return mergeLocalSyncStatus(normalizeAppData(persisted));
        } catch (error) {
            logSyncWarning('Failed to read persisted local data for sync; using in-memory snapshot', error);
        }
    } else {
        const persisted = await webStorage.getData();
        lastObservedPersistedDataForSync = null;
        return normalizeAppData(persisted);
    }

    lastObservedPersistedDataForSync = null;
    const state = getStoreState();
    return normalizeAppData({
        tasks: [...state._allTasks],
        projects: [...state._allProjects],
        sections: [...state._allSections],
        areas: [...state._allAreas],
        people: [...state._allPeople],
        settings: state.settings ?? {},
    });
};

/** Native command call routed through the sync service's injectable transport. */
async function invokeSyncNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    return syncServiceDependencies.invoke<T>(command, args);
}

type LocalDataSaveOptions = {
    baseline?: AppData;
    mode?: 'exact';
};

async function persistLocalDataForSync(
    data: AppData,
    options: LocalDataSaveOptions = {},
): Promise<AppData> {
    syncServiceDependencies.markLocalWrite(data);
    syncServiceDependencies.markLocalSqliteWrite();
    const baseline = options.baseline ?? lastObservedPersistedDataForSync;
    const baselineEntities = options.mode
        ? undefined
        : baseline
            ? buildChangedEntityBaseline(baseline, data)
            : undefined;
    const args: Record<string, unknown> = { data };
    if (baselineEntities) args.baselineEntities = baselineEntities;
    if (options.mode) args.mode = options.mode;
    const canonical = await invokeSyncNative<AppData>('save_data', args);
    // The sync store receives this target. Do not make canonical-only,
    // concurrently added rows eligible for omission before a persisted read.
    lastObservedPersistedDataForSync = data;
    syncServiceDependencies.markLocalSqliteWrite();
    return canonical;
}

async function persistSyncSettings(updates: Partial<AppSettings>): Promise<void> {
    if (isTauriRuntimeEnv()) {
        writeLocalSyncStatus(updates, logSyncWarning);
        useTaskStore.setState((state) => ({
            settings: {
                ...(state.settings ?? {}),
                ...updates,
            },
        }));
        return;
    }
    await getStoreState().updateSettings(updates);
}

const DROPBOX_REDIRECT_URI_FALLBACK = 'http://127.0.0.1:53682/oauth/dropbox/callback';
const DROPBOX_TEST_TIMEOUT_MS = 15_000;

async function getTauriFetch(): Promise<typeof fetch | undefined> {
    return syncServiceDependencies.getTauriFetch();
}

type DropboxCredentialHandleOptions = {
    forceRefresh?: boolean;
    credentialHandle?: string;
};

// Native token/status commands run crash-journal recovery. Public entry points
// serialize them with configuration commits; sync/test code already holding
// that queue must use these direct primitives to avoid nesting the queue.
async function getDropboxAccessTokenDirect(
    clientId: string,
    options?: DropboxCredentialHandleOptions,
): Promise<string> {
    const normalized = clientId.trim();
    if (!normalized) {
        throw new Error('Dropbox app key is required');
    }
    if (!isTauriRuntimeEnv()) {
        throw new Error('Dropbox sync is only available in the desktop app.');
    }
    return invokeSyncNative<string>('get_dropbox_access_token', {
        clientId: normalized,
        credentialHandle: options?.credentialHandle?.trim() || undefined,
        forceRefresh: options?.forceRefresh === true,
    });
}

// The connection-status probe reruns on every settings visit and auto-sync
// tick, so a persistently broken keyring would re-toast the same error
// forever (#1060). Each distinct failure is reported once; a successful
// probe re-arms reporting so a new breakage is loud again.
let lastReportedDropboxStatusFailure: string | null = null;

async function isDropboxConnectedDirect(clientId: string): Promise<boolean> {
    const normalized = clientId.trim();
    if (!normalized || !isTauriRuntimeEnv()) return false;
    try {
        const connected = await invokeSyncNative<boolean>('is_dropbox_connected', { clientId: normalized });
        lastReportedDropboxStatusFailure = null;
        return connected;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== lastReportedDropboxStatusFailure) {
            lastReportedDropboxStatusFailure = message;
            syncServiceDependencies.reportError('Failed to check Dropbox connection status', error);
        }
        return false;
    }
}

async function testDropboxConnectionDirect(
    clientId: string,
    options?: Pick<DropboxCredentialHandleOptions, 'credentialHandle'>,
): Promise<void> {
    const normalized = clientId.trim();
    if (!normalized) {
        throw new Error('Dropbox app key is required');
    }
    const fetcher = await getTauriFetch();
    const runTest = async (forceRefresh: boolean) => {
        const accessToken = await getDropboxAccessTokenDirect(normalized, {
            credentialHandle: options?.credentialHandle,
            forceRefresh,
        });
        await withTimeout(
            testDropboxAccess(accessToken, fetcher ?? fetch),
            DROPBOX_TEST_TIMEOUT_MS,
            'Dropbox connection test timed out. Please try again.',
        );
    };
    try {
        await runTest(false);
    } catch (error) {
        if (error instanceof DropboxUnauthorizedError) {
            await runTest(true);
            return;
        }
        throw error;
    }
}

function resolveRequestedDropboxCredentialHandleAtExecution(
    requestedHandle?: string,
): string | undefined {
    const normalizedRequestedHandle = requestedHandle?.trim();
    if (!normalizedRequestedHandle) return undefined;
    const pendingHandle = SyncService.getPendingDropboxCredentialHandleForSession();
    if (!pendingHandle) {
        // A commit queued ahead of this request finalized the candidate. The
        // durable credential is now authoritative, so do not send a stale handle.
        return undefined;
    }
    if (pendingHandle !== normalizedRequestedHandle) {
        throw new Error('A different Dropbox authorization is pending; retry after it is resolved');
    }
    return pendingHandle;
}

async function resolveWebdavPassword(config: WebDavConfig): Promise<string> {
    if (typeof config.password === 'string') return config.password;
    if (config.hasPassword === false) return '';
    if (!isTauriRuntimeEnv()) return '';
    try {
        return await invokeSyncNative<string>('get_webdav_password');
    } catch (error) {
        logSyncWarning('Failed to load WebDAV password', error);
        return '';
    }
}

const attachmentBackendDeps: AttachmentBackendDeps = {
    getTauriFetch,
    isTauriRuntimeEnv,
    logSyncInfo,
    logSyncWarning,
    resolveWebdavPassword,
};

const getAttachmentCleanupDeps = (
    dropboxCredentialHandle?: string | null,
): AttachmentCleanupDeps => ({
    getCloudConfig: () => SyncService.getCloudConfig(),
    getCloudProvider: () => SyncService.getCloudProvider(),
    getDropboxAccessToken: (clientId, options) => getDropboxAccessTokenDirect(clientId, {
        ...options,
        credentialHandle: dropboxCredentialHandle ?? undefined,
    }),
    getDropboxAppKey: () => SyncService.getDropboxAppKey(),
    getSyncPath: () => SyncService.getSyncPath(),
    getTauriFetch,
    getWebDavConfig: () => SyncService.getWebDavConfig(),
    isTauriRuntimeEnv,
    logSyncInfo,
    logSyncWarning,
    resolveWebdavPassword,
});

/**
 * Pure in-memory gate for the attachment phases, mirroring mobile's
 * `hasPendingAttachmentSyncWork`. `preSyncAttachmentsBeforeFastCheck` makes the
 * prepare phase run on every tick (#1057), and every desktop backend opens with
 * directory-ensure / rate-limit-probe IO before it looks at a single attachment —
 * so a store with no file attachments paid a network round trip per cycle for
 * loops it was always going to run zero times. Same shape as the
 * `runAttachmentCleanup` short-circuit below: no IO, only what is already loaded.
 */
const hasAttachmentSyncWork = (data: AppData): boolean => {
    if ((data.settings.attachments?.pendingRemoteDeletes?.length ?? 0) > 0) return true;
    for (const attachment of collectAttachmentsById(data).values()) {
        if (attachment.kind !== 'file') continue;
        if (attachment.deletedAt) continue;
        return true;
    }
    return false;
};

const getSyncConfigDeps = () => ({
    isTauriRuntimeEnv,
    maybeMigrateLegacyLocalStorageToConfig: () => SyncService.maybeMigrateLegacyLocalStorageToConfig(),
    reportError: syncServiceDependencies.reportError,
    startFileWatcher: () => SyncService.startFileWatcher(),
    invokeNative: invokeSyncNative,
});

// NOTE: also the config transaction's `writeBackend` dependency, which writes an
// intermediate 'off' on every commit — user-visible backend-change notifications
// live in the explicit entry points (setSyncBackend, disconnectDropbox,
// commitProvenSyncConfiguration), never here.
const writeSyncBackendDirect = (backend: SyncBackend): Promise<void> => (
    writeSyncBackend(backend, getSyncConfigDeps())
);
const readCloudProviderDirect = (): Promise<CloudProvider> => (
    readCloudProvider(getSyncConfigDeps())
);
const writeCloudProviderDirect = (provider: CloudProvider): Promise<void> => (
    writeCloudProvider(provider, getSyncConfigDeps())
);
const recoverDropboxCredentialsBeforeConfigurationDirect = async (): Promise<void> => {
    if (!isTauriRuntimeEnv()) return;
    const settled = await invokeSyncNative<boolean>('recover_dropbox_credentials_before_sync_configuration');
    if (settled !== true) {
        throw new Error('Dropbox credential recovery did not settle');
    }
};

export type { DesktopSyncConfigOverride };

type SyncRunOptions = {
    backendOverride?: SyncBackend;
    /** Session-only transport values used to prove a new configuration before
     *  the settings UI commits it to durable storage. */
    configOverride?: DesktopSyncConfigOverride;
    /** User-initiated sync: always run the full read/merge cycle, never the
     *  fast-check skip, so a stale cached fingerprint can't hide remote data. */
    manual?: boolean;
    /** Isolated candidate transport proof. The shared machine keeps merged
     *  local writes in memory and suppresses durable/finalization side effects. */
    activationProbe?: boolean;
    /** The candidate was just activated; do not inherit the previous
     *  transport's retry deadline on this first durable cycle. */
    ignorePendingRemoteWriteBackoff?: boolean;
};

/** Desktop transport state for one sync cycle. Cycle sequencing/state lives in
 *  the core machine (`runSharedSyncCycle`, ADR 0014); this carries only what
 *  the desktop backend adapters need. */
type DesktopSyncCycleContext = {
    backend: SyncBackend;
    usesConfigOverride: boolean;
    networkWentOffline: boolean;
    removeNetworkListener: (() => void) | null;
    requestAbortController: AbortController;
    webdavConfig: WebDavConfig | null;
    cloudProvider: CloudProvider;
    cloudConfig: CloudConfig | null;
    dropboxAppKey: string;
    dropboxCredentialHandle: string | null;
    cachedDropboxAccessToken: string | null;
    syncPath: string;
    fileBaseDir: string;
};

const createDesktopSyncCycleContext = (): DesktopSyncCycleContext => ({
    backend: 'off',
    usesConfigOverride: false,
    networkWentOffline: false,
    removeNetworkListener: null,
    requestAbortController: new AbortController(),
    webdavConfig: null,
    cloudProvider: 'selfhosted',
    cloudConfig: null,
    dropboxAppKey: '',
    dropboxCredentialHandle: null,
    cachedDropboxAccessToken: null,
    syncPath: '',
    fileBaseDir: '',
});

const createFetchWithAbortForContext = async (context: DesktopSyncCycleContext): Promise<typeof fetch> => {
    const baseFetch = (await getTauriFetch()) ?? fetch;
    return createAbortableFetch(baseFetch, { baseSignal: context.requestAbortController.signal });
};

const resolveDropboxAccessTokenForContext = async (
    context: DesktopSyncCycleContext,
    forceRefresh = false
): Promise<string> => {
    if (!context.dropboxAppKey) {
        throw new Error('Dropbox app key is not configured');
    }
    if (!context.cachedDropboxAccessToken || forceRefresh) {
        context.cachedDropboxAccessToken = await getDropboxAccessTokenDirect(context.dropboxAppKey, {
            credentialHandle: context.dropboxCredentialHandle ?? undefined,
            forceRefresh,
        });
    }
    return context.cachedDropboxAccessToken;
};

// Synchronous mirror of the last observed sync backend, so the footer's sync
// affordances render correctly on the first frame instead of blinking while the
// async config read resolves (#1001). The persisted config stays the authority;
// this is display seed data only.
const SYNC_BACKEND_HINT_KEY = 'mindwtr-last-known-sync-backend';
const SYNC_BACKEND_VALUES: readonly SyncBackend[] = ['off', 'file', 'webdav', 'cloud', 'cloudkit'];
const readSyncBackendHint = (): SyncBackend | null => {
    try {
        const value = window.localStorage.getItem(SYNC_BACKEND_HINT_KEY);
        return (SYNC_BACKEND_VALUES as readonly string[]).includes(value ?? '') ? value as SyncBackend : null;
    } catch {
        return null;
    }
};
const writeSyncBackendHint = (backend: SyncBackend): void => {
    try {
        window.localStorage.setItem(SYNC_BACKEND_HINT_KEY, backend);
    } catch {
        // Display seed only; losing it costs one blink, nothing else.
    }
};

export class SyncService {
    private static didMigrate = false;
    private static legacyMigrationPromise: Promise<void> | null = null;
    private static queuedSyncOptions: SyncRunOptions | null = null;
    // OAuth token bytes stay in native/keyring storage. The renderer keeps only
    // the opaque native handle, at session scope, so a settings unmount cannot
    // orphan a candidate that still needs discard/rollback recovery.
    private static pendingDropboxCredentialHandle: string | null = null;
    private static pendingDropboxFinalizeHandles = new Set<string>();
    private static pendingDropboxCredentialHandleListeners = new Set<(handle: string | null) => void>();
    private static syncStatus: {
        inFlight: boolean;
        queued: boolean;
        step: string | null;
        lastResult: 'success' | 'error' | null;
        lastResultAt: string | null;
        /** Persisted sync backend; `null` until first read. Lets the UI hide
         *  sync affordances when sync is off (#1001). */
        backend: SyncBackend | null;
    } = {
        inFlight: false,
        queued: false,
        step: null,
        lastResult: null,
        lastResultAt: null,
        backend: readSyncBackendHint(),
    };
    private static readonly syncOrchestrator = createSyncOrchestrator<SyncRunOptions, SyncRunResult>({
        runCycle: async (options) => SyncService.runSyncCycle(options),
        onQueueStateChange: (queued) => {
            SyncService.updateSyncStatus({ queued });
        },
        onDrained: () => {
            SyncService.queuedSyncOptions = null;
        },
        onQueuedRunComplete: (queuedResult) => {
            if (!queuedResult.success) {
                logSyncWarning('Queued sync failed', queuedResult.error);
                try {
                    const message = resolveSyncFailureMessage(queuedResult.error);
                    useUiStore.getState().showToast(message, 'error', 6000);
                } catch {
                    // UI store may be unavailable during shutdown/tests.
                }
            }
        },
        onQueuedRunError: (error) => {
            logSyncWarning('Queued sync crashed', error);
        },
    });
    private static syncListeners = new Set<(status: typeof SyncService.syncStatus) => void>();
    private static fileWatcherStop: (() => void) | null = null;
    private static fileWatcherPath: string | null = null;
    private static fileWatcherBackend: SyncBackend | null = null;
    private static lastWrittenHash: string | null = null;
    private static lastObservedHash: string | null = null;
    private static lastSuccessfulSyncLocalChangeAt = 0;
    private static ignoreFileEventsUntil = 0;
    private static fileWriteIgnoreActive = false;
    private static externalSyncTimer: ReturnType<typeof setTimeout> | null = null;
    private static pendingExternalSyncChange: ExternalSyncChange | null = null;
    private static externalSyncChangeListeners = new Set<(change: ExternalSyncChange | null) => void>();
    private static consecutiveAttachmentWarningRuns = 0;
    private static lastAttachmentWarningToastAt = 0;

    private static getMonotonicNow(): number {
        if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
            return performance.now();
        }
        return Date.now();
    }

    private static requestQueuedSyncRun(nextOptions?: SyncRunOptions, preferLatest = true) {
        if (nextOptions && (preferLatest || !SyncService.queuedSyncOptions)) {
            SyncService.queuedSyncOptions = nextOptions;
        }
        const queuedOptions = SyncService.queuedSyncOptions ?? nextOptions;
        logSyncInfo('Sync trace follow-up requested', {
            hasQueuedOptions: String(Boolean(queuedOptions)),
            preferLatest: String(preferLatest),
        });
        if (queuedOptions) {
            SyncService.syncOrchestrator.requestFollowUp(queuedOptions);
            return;
        }
        SyncService.syncOrchestrator.requestFollowUp();
    }

    private static areSyncRunOptionsEquivalent(left?: SyncRunOptions | null, right?: SyncRunOptions | null): boolean {
        return (left?.backendOverride ?? undefined) === (right?.backendOverride ?? undefined)
            && (left?.configOverride ?? undefined) === (right?.configOverride ?? undefined)
            && (left?.activationProbe ?? false) === (right?.activationProbe ?? false)
            && (left?.ignorePendingRemoteWriteBackoff ?? false)
                === (right?.ignorePendingRemoteWriteBackoff ?? false);
    }

    /** Covered-snapshot check for the core machine's acceptCoveredSnapshot
     *  hook: a mid-cycle store change is benign when the in-memory payload
     *  already matches what this cycle synced. The machine owns the snapshot
     *  stamp bookkeeping. */
    private static isCoveredLocalSnapshot(expectedData: AppData): boolean {
        const currentChangeAt = getStoreState().lastDataChangeAt;
        const currentData = normalizeAppData(syncServiceDependencies.getInMemoryAppDataSnapshot());
        const syncedData = normalizeAppData(expectedData);
        const currentFingerprint = computeSyncPayloadFingerprint(currentData);
        const syncedFingerprint = computeSyncPayloadFingerprint(syncedData);
        const rawPayloadsEqual = areSyncPayloadsEqual(currentData, syncedData);
        if (currentFingerprint !== syncedFingerprint) {
            logSyncInfo('Sync trace covered local snapshot differs', {
                currentChangeAt: String(currentChangeAt),
                currentFingerprint,
                syncedFingerprint,
                rawPayloadsEqual: String(rawPayloadsEqual),
                ...buildSyncPayloadDiffTraceExtra(currentData, syncedData),
            });
            return false;
        }

        // The payload fingerprint is blind to device-local settings (the
        // sanitizer strips them), but finalize applies expectedData.settings to
        // the store wholesale — accepting coverage while e.g. the sidebar area
        // filter changed mid-cycle would revert that change (#316). A mismatch
        // here falls back to the normal requeue path.
        const currentSettingsFingerprint = computeCoveredSettingsFingerprint(currentData.settings);
        const syncedSettingsFingerprint = computeCoveredSettingsFingerprint(syncedData.settings);
        if (currentSettingsFingerprint !== syncedSettingsFingerprint) {
            logSyncInfo('Sync trace covered local snapshot differs in device-local settings', {
                currentChangeAt: String(currentChangeAt),
                currentSettingsFingerprint,
                syncedSettingsFingerprint,
            });
            return false;
        }

        logSyncInfo('Sync trace covered local snapshot accepted', {
            currentChangeAt: String(currentChangeAt),
            currentFingerprint,
            rawPayloadsEqual: String(rawPayloadsEqual),
        });
        return true;
    }

    private static clearCoveredQueuedSyncRun(localSnapshotChangeAt: number, options: SyncRunOptions): void {
        if (!SyncService.syncOrchestrator.getState().queued) return;
        if (!SyncService.areSyncRunOptionsEquivalent(SyncService.queuedSyncOptions, options)) return;
        if (getStoreState().lastDataChangeAt > localSnapshotChangeAt) return;

        SyncService.queuedSyncOptions = null;
        SyncService.syncOrchestrator.clearFollowUp();
    }

    static getSyncStatus() {
        return SyncService.syncStatus;
    }

    /** Seed `syncStatus.backend` from the persisted configuration. Later changes
     *  flow through `writeSyncBackendDirect`, the single home for durable
     *  backend writes. */
    static async refreshSyncBackendStatus(): Promise<void> {
        try {
            const backend = await SyncService.getSyncBackend();
            SyncService.updateSyncStatus({ backend });
        } catch (error) {
            logSyncWarning('Failed to read sync backend for status', error);
        }
    }

    /** Call only for a user-visible backend change (turn off, disconnect,
     *  committed configuration) — never for the config transaction's
     *  intermediate 'off' write, which would blink the footer and wipe the
     *  error text a failed save just produced. */
    static async noteSyncBackendPersisted(backend: SyncBackend): Promise<void> {
        SyncService.updateSyncStatus({ backend });
        if (backend !== 'off') return;
        // Sync reporting ends with sync: once no future sync can clear it, a
        // stale conflict/error status would re-toast at every launch (#1001).
        try {
            await persistSyncSettings({
                lastSyncStatus: 'idle',
                lastSyncError: undefined,
                lastSyncStats: undefined,
            });
        } catch (error) {
            logSyncWarning('Failed to clear sync status after disabling sync', error);
        }
    }

    static getPendingDropboxCredentialHandleForSession(): string | null {
        return SyncService.pendingDropboxCredentialHandle;
    }

    static subscribePendingDropboxCredentialHandleForSession(
        listener: (handle: string | null) => void,
    ): () => void {
        SyncService.pendingDropboxCredentialHandleListeners.add(listener);
        listener(SyncService.pendingDropboxCredentialHandle);
        return () => SyncService.pendingDropboxCredentialHandleListeners.delete(listener);
    }

    static rememberPendingDropboxCredentialHandleForSession(credentialHandle: string): void {
        const normalizedHandle = credentialHandle.trim();
        if (!normalizedHandle) {
            throw new Error('Dropbox credential handle is required');
        }
        const existingHandle = SyncService.pendingDropboxCredentialHandle;
        if (existingHandle && existingHandle !== normalizedHandle) {
            throw new Error('A pending Dropbox authorization must be resolved before connecting another account');
        }
        if (existingHandle === normalizedHandle) return;
        SyncService.pendingDropboxCredentialHandle = normalizedHandle;
        SyncService.pendingDropboxCredentialHandleListeners.forEach((listener) => listener(normalizedHandle));
    }

    static forgetPendingDropboxCredentialHandleForSession(expectedHandle?: string): void {
        const normalizedExpectedHandle = expectedHandle?.trim();
        if (
            normalizedExpectedHandle
            && SyncService.pendingDropboxCredentialHandle !== normalizedExpectedHandle
        ) {
            return;
        }
        if (!SyncService.pendingDropboxCredentialHandle) return;
        SyncService.pendingDropboxCredentialHandle = null;
        SyncService.pendingDropboxCredentialHandleListeners.forEach((listener) => listener(null));
    }

    private static moveDropboxCredentialToFinalizeRetry(credentialHandle: string): void {
        const normalizedHandle = credentialHandle.trim();
        if (!normalizedHandle) return;
        // Record the committed phase before withdrawing the Candidate from UI
        // so every synchronous subscriber sees a lifecycle with an owner.
        SyncService.pendingDropboxFinalizeHandles.add(normalizedHandle);
        SyncService.forgetPendingDropboxCredentialHandleForSession(normalizedHandle);
    }

    private static forgetDropboxFinalizeRetryHandle(credentialHandle: string): void {
        const normalizedHandle = credentialHandle.trim();
        if (!normalizedHandle) return;
        SyncService.pendingDropboxFinalizeHandles.delete(normalizedHandle);
    }

    private static async retryDropboxCredentialFinalizations(
        expectedHandle?: string,
    ): Promise<void> {
        const normalizedExpected = expectedHandle?.trim();
        const handles = normalizedExpected
            ? [normalizedExpected]
            : Array.from(SyncService.pendingDropboxFinalizeHandles);
        let firstError: unknown = null;
        for (const handle of handles) {
            if (!SyncService.pendingDropboxFinalizeHandles.has(handle)) continue;
            try {
                await SyncService.finalizeDropboxCredentials(handle);
            } catch (error) {
                firstError ??= error;
            }
        }
        if (firstError) throw firstError;
    }

    static async retryPendingDropboxCredentialFinalizationForSession(): Promise<void> {
        return runSyncRestoreExclusive(() => SyncService.retryDropboxCredentialFinalizations());
    }

    private static async recoverDropboxCredentialsBeforeConfigurationMutation(): Promise<void> {
        await recoverDropboxCredentialsBeforeConfigurationDirect();
        // The native recovery barrier removes committed orphan promotion
        // entries only after exact marker recovery succeeds. Any renderer
        // finalize handles are therefore stale, while Candidate ownership is
        // intentionally unchanged.
        SyncService.pendingDropboxFinalizeHandles.clear();
    }

    static subscribeSyncStatus(listener: (status: typeof SyncService.syncStatus) => void): () => void {
        SyncService.syncListeners.add(listener);
        listener(SyncService.syncStatus);
        return () => SyncService.syncListeners.delete(listener);
    }

    static getPendingExternalSyncChange(): ExternalSyncChange | null {
        return SyncService.pendingExternalSyncChange;
    }

    static subscribeExternalSyncChange(listener: (change: ExternalSyncChange | null) => void): () => void {
        SyncService.externalSyncChangeListeners.add(listener);
        listener(SyncService.pendingExternalSyncChange);
        return () => SyncService.externalSyncChangeListeners.delete(listener);
    }

    private static notifyExternalSyncChange() {
        SyncService.externalSyncChangeListeners.forEach((listener) => listener(SyncService.pendingExternalSyncChange));
    }

    private static setPendingExternalSyncChange(change: ExternalSyncChange | null) {
        SyncService.pendingExternalSyncChange = change;
        SyncService.notifyExternalSyncChange();
    }

    static async resetForTests(): Promise<void> {
        // A requeued sync may already have entered the serialized restore queue.
        // Detach it from the orchestrator, then wait for it to finish before a
        // following test replaces the service dependencies underneath it.
        SyncService.syncOrchestrator.reset();
        await runSyncDocumentExclusive(async () => undefined);
        await SyncService.legacyMigrationPromise?.catch(() => undefined);
        await SyncService.stopFileWatcher();
        SyncService.didMigrate = false;
        SyncService.legacyMigrationPromise = null;
        SyncService.syncOrchestrator.reset();
        SyncService.queuedSyncOptions = null;
        SyncService.syncStatus = {
            inFlight: false,
            queued: false,
            step: null,
            lastResult: null,
            lastResultAt: null,
            backend: null,
        };
        SyncService.syncListeners.clear();
        SyncService.fileWatcherStop = null;
        SyncService.fileWatcherPath = null;
        SyncService.fileWatcherBackend = null;
        SyncService.lastWrittenHash = null;
        SyncService.lastObservedHash = null;
        SyncService.lastSuccessfulSyncLocalChangeAt = 0;
        SyncService.ignoreFileEventsUntil = 0;
        SyncService.fileWriteIgnoreActive = false;
        SyncService.externalSyncTimer = null;
        SyncService.pendingExternalSyncChange = null;
        SyncService.externalSyncChangeListeners.clear();
        SyncService.consecutiveAttachmentWarningRuns = 0;
        SyncService.lastAttachmentWarningToastAt = 0;
        SyncService.pendingDropboxCredentialHandle = null;
        SyncService.pendingDropboxFinalizeHandles.clear();
        SyncService.pendingDropboxCredentialHandleListeners.clear();
        clearFastSyncState();
        clearLocalSyncStatus();
        clearAttachmentSyncState();
        clearAttachmentValidationFailures();
    }

    private static finalizeAttachmentWarningState(context: { hadAttachmentWarning: boolean }, result: Pick<SyncRunResult, 'success'>) {
        if (context.hadAttachmentWarning) {
            SyncService.consecutiveAttachmentWarningRuns += 1;
            if (SyncService.consecutiveAttachmentWarningRuns < ATTACHMENT_WARNING_TOAST_THRESHOLD) {
                return;
            }
            const now = Date.now();
            if (now - SyncService.lastAttachmentWarningToastAt < ATTACHMENT_WARNING_TOAST_COOLDOWN_MS) {
                return;
            }
            SyncService.lastAttachmentWarningToastAt = now;
            try {
                useUiStore.getState().showToast(
                    resolveSyncText(
                        'settings.attachmentSyncRetryWarning',
                        'Attachment sync is still failing. Files will retry in the background.',
                    ),
                    'error',
                    6000,
                );
            } catch {
                // UI store may be unavailable during shutdown/tests.
            }
            return;
        }
        if (result.success) {
            SyncService.consecutiveAttachmentWarningRuns = 0;
        }
    }

    private static updateSyncStatus(partial: Partial<typeof SyncService.syncStatus>) {
        SyncService.syncStatus = { ...SyncService.syncStatus, ...partial };
        if (partial.backend != null) writeSyncBackendHint(partial.backend);
        SyncService.syncListeners.forEach((listener) => listener(SyncService.syncStatus));
    }

    static async maybeMigrateLegacyLocalStorageToConfig() {
        if (!isTauriRuntimeEnv() || SyncService.didMigrate) return;
        if (SyncService.legacyMigrationPromise) {
            return SyncService.legacyMigrationPromise;
        }

        const migrationPromise = (async () => {
            // Snapshot renderer-owned state without invoking the browser getters:
            // getCloudConfigLocal intentionally relocates a non-remembered legacy
            // token into sessionStorage, which would destroy the retry source if
            // native migration failed and the app then closed.
            const capturedLocalEntries = new Map<string, string | null>([
                [SYNC_BACKEND_KEY, localStorage.getItem(SYNC_BACKEND_KEY)],
                [WEBDAV_URL_KEY, localStorage.getItem(WEBDAV_URL_KEY)],
                [WEBDAV_USERNAME_KEY, localStorage.getItem(WEBDAV_USERNAME_KEY)],
                [WEBDAV_PASSWORD_KEY, localStorage.getItem(WEBDAV_PASSWORD_KEY)],
                [WEBDAV_ALLOW_INSECURE_HTTP_KEY, localStorage.getItem(WEBDAV_ALLOW_INSECURE_HTTP_KEY)],
                [WEBDAV_ALLOW_WEAK_FINGERPRINT_KEY, localStorage.getItem(WEBDAV_ALLOW_WEAK_FINGERPRINT_KEY)],
                [CLOUD_URL_KEY, localStorage.getItem(CLOUD_URL_KEY)],
                [CLOUD_TOKEN_KEY, localStorage.getItem(CLOUD_TOKEN_KEY)],
                [CLOUD_ALLOW_INSECURE_HTTP_KEY, localStorage.getItem(CLOUD_ALLOW_INSECURE_HTTP_KEY)],
                [CLOUD_REMEMBER_TOKEN_KEY, localStorage.getItem(CLOUD_REMEMBER_TOKEN_KEY)],
                [CLOUD_PROVIDER_KEY, localStorage.getItem(CLOUD_PROVIDER_KEY)],
            ]);
            const capturedSessionEntries = new Map<string, string | null>([
                [WEBDAV_PASSWORD_KEY, sessionStorage.getItem(WEBDAV_PASSWORD_KEY)],
                [CLOUD_TOKEN_KEY, sessionStorage.getItem(CLOUD_TOKEN_KEY)],
            ]);
            const localValue = (key: string): string | null => capturedLocalEntries.get(key) ?? null;
            const sessionValue = (key: string): string | null => capturedSessionEntries.get(key) ?? null;
            const legacyBackend = normalizeSyncBackend(localValue(SYNC_BACKEND_KEY));
            const legacyWebdavPassword = sessionValue(WEBDAV_PASSWORD_KEY)
                ?? localValue(WEBDAV_PASSWORD_KEY)
                ?? '';
            const legacyWebdav: WebDavConfig = {
                url: localValue(WEBDAV_URL_KEY) ?? '',
                username: localValue(WEBDAV_USERNAME_KEY) ?? '',
                password: legacyWebdavPassword,
                hasPassword: Boolean(legacyWebdavPassword),
                allowInsecureHttp: localValue(WEBDAV_ALLOW_INSECURE_HTTP_KEY) === 'true',
                allowWeakFingerprint: localValue(WEBDAV_ALLOW_WEAK_FINGERPRINT_KEY) !== 'false',
            };
            const legacyCloudRememberToken = localValue(CLOUD_REMEMBER_TOKEN_KEY) === 'true';
            const legacyLocalCloudToken = localValue(CLOUD_TOKEN_KEY) ?? '';
            const legacySessionCloudToken = sessionValue(CLOUD_TOKEN_KEY) ?? '';
            const legacyCloud: CloudConfig = {
                url: localValue(CLOUD_URL_KEY) ?? '',
                token: legacyCloudRememberToken
                    ? (legacyLocalCloudToken || legacySessionCloudToken)
                    : (legacySessionCloudToken || legacyLocalCloudToken),
                allowInsecureHttp: localValue(CLOUD_ALLOW_INSECURE_HTTP_KEY) === 'true',
                rememberToken: legacyCloudRememberToken,
            };
            const rawLegacyCloudProvider = localValue(CLOUD_PROVIDER_KEY);
            const legacyCloudProvider: CloudProvider | null = rawLegacyCloudProvider === 'dropbox'
                || rawLegacyCloudProvider === 'selfhosted'
                ? rawLegacyCloudProvider
                : null;
            const hasLegacyBackend = legacyBackend === 'webdav' || legacyBackend === 'cloud';
            const hasLegacyWebdav = Boolean(legacyWebdav.url);
            const hasLegacyCloud = Boolean(legacyCloud.url || legacyCloud.token);
            const hasLegacyRendererState = Array.from(capturedLocalEntries.values()).some((value) => value !== null)
                || Array.from(capturedSessionEntries.values()).some((value) => value !== null);
            if (!hasLegacyRendererState) {
                return;
            }

            // Migration can run either inside the lifecycle queue (atomic
            // snapshot/commit) or from a legacy individual getter. Use the
            // direct native barrier here to avoid queue reentrancy while still
            // settling any crash-left Dropbox journal before config writes.
            await recoverDropboxCredentialsBeforeConfigurationDirect();

            // Read one tolerant native snapshot instead of consulting each
            // secret authority. A dormant WebDAV or Cloud credential can be
            // opaque in a sandboxed package without blocking File sync.
            const current = await invokeSyncNative<
                PersistedDesktopSyncConfiguration & { cloudProviderAuthority: string }
            >('get_sync_configuration_snapshot', {
                requireWebdavPassword: false,
                requireCloudToken: false,
            });

            if (hasLegacyWebdav && !current.webdav.url) {
                if (
                    current.webdav.passwordAuthority === 'opaque'
                    && !legacyWebdav.password
                ) {
                    throw new Error('WebDAV password authority is unavailable for legacy migration');
                }
                await invokeSyncNative('set_webdav_config', legacyWebdav);
                const persistedWebdav = await invokeSyncNative<WebDavConfig>('get_webdav_config');
                if (
                    persistedWebdav.url !== legacyWebdav.url
                    || persistedWebdav.username !== legacyWebdav.username
                    || persistedWebdav.hasPassword !== legacyWebdav.hasPassword
                    || persistedWebdav.allowInsecureHttp !== legacyWebdav.allowInsecureHttp
                    || persistedWebdav.allowWeakFingerprint !== legacyWebdav.allowWeakFingerprint
                ) {
                    throw new Error('Legacy WebDAV sync configuration did not persist correctly');
                }
            }

            if (hasLegacyCloud && !current.cloud.url) {
                if (
                    current.cloud.tokenAuthority === 'opaque'
                    && !legacyCloud.token
                ) {
                    throw new Error('Self-hosted cloud token authority is unavailable for legacy migration');
                }
                const hasKnownNativeCloudToken = current.cloud.tokenAuthority === 'known'
                    && Boolean(current.cloud.token);
                const tokenToPersist = hasKnownNativeCloudToken
                    ? current.cloud.token ?? ''
                    : legacyCloud.token;
                await invokeSyncNative('set_cloud_config', {
                    url: legacyCloud.url,
                    token: tokenToPersist,
                    allowInsecureHttp: legacyCloud.allowInsecureHttp === true,
                });
                const persistedCloud = await invokeSyncNative<CloudConfig>('get_cloud_config');
                if (
                    persistedCloud.url !== legacyCloud.url
                    || persistedCloud.token !== tokenToPersist
                    || persistedCloud.allowInsecureHttp !== legacyCloud.allowInsecureHttp
                ) {
                    throw new Error('Legacy self-hosted sync configuration did not persist correctly');
                }
            }

            // The provider selects the cloud transport, so make it durable and
            // verify it before a legacy cloud backend can be activated.
            if (rawLegacyCloudProvider !== null) {
                if (
                    (current.cloudProvider !== 'selfhosted'
                        && current.cloudProvider !== 'dropbox')
                    || (current.cloudProviderAuthority !== 'uninitialized'
                        && current.cloudProviderAuthority !== 'native')
                ) {
                    throw new Error('Invalid persisted cloud provider state');
                }
                if (legacyCloudProvider && current.cloudProviderAuthority === 'uninitialized') {
                    await invokeSyncNative('set_sync_cloud_provider', { provider: legacyCloudProvider });
                    const persistedState = await invokeSyncNative<{ provider: string; authority: string }>(
                        'get_sync_cloud_provider_state',
                    );
                    if (
                        persistedState.provider !== legacyCloudProvider
                        || persistedState.authority !== 'native'
                    ) {
                        throw new Error('Legacy cloud sync provider did not persist correctly');
                    }
                }
            }

            if (hasLegacyBackend && current.backend === 'file') {
                await invokeSyncNative('set_sync_backend', { backend: legacyBackend });
                const persistedBackend = normalizeSyncBackend(
                    await invokeSyncNative<string>('get_sync_backend'),
                );
                if (persistedBackend !== legacyBackend) {
                    throw new Error('Legacy sync backend did not persist correctly');
                }
            }

            // Every native read/write above completed successfully. Retire only
            // the exact values inspected by this migration so a concurrent
            // renderer update is never mistaken for legacy state.
            capturedLocalEntries.forEach((value, key) => {
                if (value !== null && localStorage.getItem(key) === value) {
                    localStorage.removeItem(key);
                }
            });
            capturedSessionEntries.forEach((value, key) => {
                if (value !== null && sessionStorage.getItem(key) === value) {
                    sessionStorage.removeItem(key);
                }
            });
        })();
        SyncService.legacyMigrationPromise = migrationPromise;

        try {
            await migrationPromise;
            SyncService.didMigrate = true;
        } catch (error) {
            syncServiceDependencies.reportError('Failed to migrate legacy sync config', error);
            throw error;
        } finally {
            if (SyncService.legacyMigrationPromise === migrationPromise) {
                SyncService.legacyMigrationPromise = null;
            }
        }
    }

    static async getSyncBackend(): Promise<SyncBackend> {
        return readSyncBackend(getSyncConfigDeps());
    }

    private static async readPersistedSyncConfiguration(
        requirements: SyncConfigurationSecretRequirements = {},
    ): Promise<PersistedDesktopSyncConfiguration> {
        if (isTauriRuntimeEnv()) {
            await SyncService.maybeMigrateLegacyLocalStorageToConfig();
            return invokeSyncNative<PersistedDesktopSyncConfiguration>(
                'get_sync_configuration_snapshot',
                {
                    requireWebdavPassword: requirements.requireWebdavPassword === true,
                    requireCloudToken: requirements.requireCloudToken === true,
                },
            );
        }

        const [backend, syncPath, webdav, cloud, cloudProvider] = await Promise.all([
            SyncService.getSyncBackend(),
            SyncService.getSyncPath(),
            SyncService.getWebDavConfig(),
            SyncService.getCloudConfig(),
            SyncService.getCloudProvider(),
        ]);
        const password = webdav.password ?? '';
        return {
            backend,
            syncPath,
            webdav: {
                ...webdav,
                password,
                passwordAuthority: 'known',
                hasPassword: Boolean(password) || webdav.hasPassword === true,
                allowInsecureHttp: webdav.allowInsecureHttp === true,
                allowWeakFingerprint: webdav.allowWeakFingerprint !== false,
            },
            cloud: {
                ...cloud,
                token: cloud.token ?? '',
                tokenAuthority: 'known',
                allowInsecureHttp: cloud.allowInsecureHttp === true,
                rememberToken: cloud.rememberToken === true,
            },
            cloudProvider,
        };
    }

    static async getPersistedSyncConfigurationSnapshot(): Promise<PersistedDesktopSyncConfiguration> {
        return runSyncRestoreExclusive(() => SyncService.readPersistedSyncConfiguration());
    }

    static async setSyncBackend(backend: SyncBackend): Promise<void> {
        return runSyncRestoreExclusive(async () => {
            await SyncService.recoverDropboxCredentialsBeforeConfigurationMutation();
            await writeSyncBackendDirect(backend);
            await SyncService.noteSyncBackendPersisted(backend);
        });
    }

    static async getWebDavConfig(options?: { silent?: boolean }): Promise<WebDavConfig> {
        return readWebDavConfig(getSyncConfigDeps(), options);
    }

    // -----------------------------------------------------------------
    // Sync encryption (#1056). The surface phase 3's settings UI calls.
    //
    // A transition is an explicit maintenance pass over the whole remote artifact set, so it
    // runs wherever that set can be enumerated:
    //   * File Sync -> Rust, which owns the folder's IO and can walk it directly.
    //   * WebDAV and Dropbox -> core's shared `run*OverRemote` orchestration from TS, because
    //     the attachment set is enumerated from the sync document (a TS-side concern) and one
    //     shared implementation beats a second Rust one. Rust still owns the per-CYCLE WebDAV
    //     crypto seam; it picks up the key this transition cached.
    // Either way the key lives only in Rust's keyring — TS keeps no cache of its own.
    // -----------------------------------------------------------------

    private static async resolveEncryptionTarget(): Promise<
        { kind: 'native' } | { kind: 'remote'; remote: SyncEncryptionRemotePort } | { kind: 'local' }
    > {
        const backend = await SyncService.getSyncBackend();
        if (backend === 'file') return { kind: 'native' };

        // No durable backend yet (a typed-but-unproven WebDAV config is still 'off' until
        // its activation probe passes). Enable/disable stay available as local-only key
        // management so the passphrase can be set BEFORE the first sync ever uploads a
        // byte (#1001); operations that must read or convert remote artifacts reject with
        // SYNC_ENCRYPTION_BACKEND_REQUIRED instead of a misleading generic failure.
        if (backend === 'off') return { kind: 'local' };

        // `cloud` covers two very different providers; only Dropbox is a blob store this
        // feature applies to. Never branch on a bare `backend === 'cloud'` here.
        if (backend === 'cloud' && (await SyncService.getCloudProvider()) === 'dropbox') {
            const clientId = await SyncService.getDropboxAppKey();
            const fetcher = (await getTauriFetch()) ?? fetch;
            return {
                kind: 'remote',
                remote: createDropboxRemotePort(
                    async (operation) => operation(await getDropboxAccessTokenDirect(clientId)),
                    fetcher,
                ),
            };
        }

        if (backend === 'webdav') {
            const config = await SyncService.getWebDavConfig();
            const password = await resolveWebdavPassword(config);
            return {
                kind: 'remote',
                remote: createWebdavRemotePort({
                    baseUrl: getBaseSyncUrl(config.url),
                    options: {
                        allowInsecureHttp: config.allowInsecureHttp,
                        username: config.username,
                        password,
                        fetcher: (await getTauriFetch()) ?? fetch,
                    },
                }),
            };
        }

        // CloudKit and the self-hosted cloud backend are out of scope for #1056 — they are not
        // blob stores this app writes whole documents to.
        throw new Error(`Sync encryption is not available for the ${backend} backend.`);
    }

    static async getSyncEncryptionStatus(): Promise<SyncEncryptionStatus> {
        return readSyncEncryptionStatus();
    }

    static async enableSyncEncryption(
        passphrase: string,
        onProgress?: (progress: SyncEncryptionTransitionProgress) => void,
    ): Promise<void> {
        // Serialized against sync runs and restores by the same exclusive gate every other
        // configuration mutation uses; the Rust side additionally holds the sync-folder lock.
        return runSyncRestoreExclusive(async () => {
            const target = await SyncService.resolveEncryptionTarget();
            if (target.kind === 'native') {
                await invokeSyncNative('enable_sync_encryption', { passphrase });
                return;
            }
            if (target.kind === 'local') {
                await runEnableLocalOnly(passphrase);
                return;
            }
            await runEnableOverRemote(passphrase, target.remote, onProgress);
        });
    }

    static async disableSyncEncryption(
        onProgress?: (progress: SyncEncryptionTransitionProgress) => void,
    ): Promise<void> {
        return runSyncRestoreExclusive(async () => {
            const target = await SyncService.resolveEncryptionTarget();
            if (target.kind === 'native') {
                await invokeSyncNative('disable_sync_encryption');
                return;
            }
            if (target.kind === 'local') {
                await runDisableLocalOnly();
                return;
            }
            await runDisableOverRemote(target.remote, onProgress);
        });
    }

    static async changeSyncEncryptionPassphrase(
        currentPassphrase: string,
        nextPassphrase: string,
        onProgress?: (progress: SyncEncryptionTransitionProgress) => void,
    ): Promise<void> {
        return runSyncRestoreExclusive(async () => {
            // Confirm the current passphrase before rewrapping anything: the cached key is
            // what actually decrypts, so an unverified "current" would let a typo rotate the
            // folder to a passphrase the user did not intend.
            if ((await SyncService.provideSyncEncryptionPassphraseUnlocked(currentPassphrase)) !== 'ok') {
                throw new Error('SYNC_ENCRYPTION_WRONG_PASSPHRASE');
            }
            const target = await SyncService.resolveEncryptionTarget();
            if (target.kind === 'native') {
                await invokeSyncNative('change_sync_encryption_passphrase', { nextPassphrase });
                return;
            }
            if (target.kind === 'local') {
                // Rotation rewraps remote artifacts; with no backend there is nothing to
                // rewrap AND no way to verify the current passphrase against the folder —
                // and a local-only "rotation" while an old sync location still holds
                // ciphertext would silently strand it under the previous key.
                throw new Error('SYNC_ENCRYPTION_BACKEND_REQUIRED');
            }
            await runChangePassphraseOverRemote(currentPassphrase, nextPassphrase, target.remote, onProgress);
        });
    }

    private static async provideSyncEncryptionPassphraseUnlocked(
        passphrase: string,
    ): Promise<'ok' | 'wrong-passphrase'> {
        const target = await SyncService.resolveEncryptionTarget();
        if (target.kind === 'native') {
            return invokeSyncNative<'ok' | 'wrong-passphrase'>('provide_sync_encryption_passphrase', {
                passphrase,
            });
        }
        if (target.kind === 'local') {
            // A passphrase can only be VALIDATED against remote artifacts; with no
            // backend there are none to check against.
            throw new Error('SYNC_ENCRYPTION_BACKEND_REQUIRED');
        }
        return runProvidePassphraseOverRemote(passphrase, target.remote);
    }

    /** Validates against the remote's own header and caches the key on success. Never mutates
     *  the remote, whichever way it answers. */
    static async provideSyncEncryptionPassphrase(passphrase: string): Promise<'ok' | 'wrong-passphrase'> {
        return runSyncRestoreExclusive(() =>
            SyncService.provideSyncEncryptionPassphraseUnlocked(passphrase),
        );
    }

    /** "Not now". The no-key state was already persisted at discovery, so this only re-affirms
     *  it — a dismissal must never re-arm automatic sync against ciphertext this device cannot
     *  read. Kept as a stable call for phase 3 rather than letting the UI infer a no-op. */
    static async declineSyncEncryptionPassphrase(): Promise<void> {
        const status = await readSyncEncryptionStatus();
        if (status.state !== 'remote-encrypted-no-key') return;
        logSyncInfo('Sync encryption passphrase declined; automatic sync stays paused for this backend');
    }

    static async setWebDavConfig(config: { url: string; username?: string; password?: string; allowInsecureHttp?: boolean; allowWeakFingerprint?: boolean; replacePassword?: boolean }): Promise<void> {
        return writeWebDavConfig(config, getSyncConfigDeps());
    }

    private static async probeWebDavStrongEtagSupport(config: { url: string; username?: string; password?: string; hasPassword?: boolean; allowInsecureHttp?: boolean }): Promise<void> {
        const normalizedUrl = normalizeWebdavUrl(config.url.trim());
        if (!normalizedUrl) {
            throw new Error('WebDAV URL not configured');
        }
        const fetcher = await getTauriFetch();
        // The settings form leaves the password field empty after a restart
        // (the secret stays in the keyring, only hasPassword survives). An
        // empty string must mean "unchanged", not "no password", or the test
        // 401s on saved credentials that sync itself uses fine (#899).
        const password = await resolveWebdavPassword({
            url: config.url,
            username: config.username || '',
            password: config.password?.trim() ? config.password : undefined,
            hasPassword: config.hasPassword,
        });
        try {
            await assertWebdavStrongEtagSupport(normalizedUrl, {
                allowInsecureHttp: config.allowInsecureHttp,
                username: config.username?.trim(),
                password,
                timeoutMs: 10_000,
                fetcher: fetcher ?? fetch,
            });
        } catch (error) {
            logSyncWarning('WebDAV connection test failed', error);
            throw error;
        }
    }

    static async testWebDavConnection(config: { url: string; username?: string; password?: string; hasPassword?: boolean; allowInsecureHttp?: boolean }): Promise<void> {
        await SyncService.probeWebDavStrongEtagSupport(config);
        rememberWebdavCapabilityProof(config);
    }

    static async getCloudConfig(options?: { silent?: boolean }): Promise<CloudConfig> {
        return readCloudConfig(getSyncConfigDeps(), options);
    }

    static async setCloudConfig(config: { url: string; token?: string; allowInsecureHttp?: boolean; rememberToken?: boolean }): Promise<void> {
        return writeCloudConfig(config, getSyncConfigDeps());
    }

    /** Read, rotate or revoke the self-hosted server's iCalendar feed token (#952).
     *  `null` means no feed is published; the subscription URL is derived from the
     *  configured sync URL, not from whatever the server reports. */
    static async requestCalendarFeed(action: 'read' | 'rotate' | 'revoke'): Promise<{ feed: CloudCalendarFeed | null; url: string | null }> {
        const config = await SyncService.getCloudConfig();
        const url = config.url?.trim();
        if (!url) throw new Error('Self-hosted server URL is not configured.');
        const endpoint = getCloudCalendarFeedEndpoint(url);
        const options = {
            allowInsecureHttp: config.allowInsecureHttp,
            token: config.token,
            fetcher: (await getTauriFetch()) ?? fetch,
        };
        const body = action === 'read'
            ? await cloudGetJson<{ feed: CloudCalendarFeed | null }>(endpoint, options)
            : await cloudRequestJson<{ feed: CloudCalendarFeed | null }>(
                action === 'rotate' ? 'POST' : 'DELETE',
                endpoint,
                undefined,
                options,
            );
        const feed = body?.feed ?? null;
        return { feed, url: feed ? buildCloudCalendarFeedUrl(url, feed.token) : null };
    }

    static async getCloudProvider(): Promise<CloudProvider> {
        return readCloudProviderDirect();
    }

    static async setCloudProvider(provider: CloudProvider): Promise<void> {
        return runSyncRestoreExclusive(async () => {
            await SyncService.recoverDropboxCredentialsBeforeConfigurationMutation();
            await writeCloudProviderDirect(provider);
        });
    }

    static async commitProvenSyncConfiguration(
        config: DesktopSyncConfigOverride,
    ): Promise<SyncConfigurationCommitResult> {
        const credentialHandle = config.dropboxCredentialHandle?.trim();
        let result: SyncConfigurationCommitResult;
        try {
            result = await runSyncRestoreExclusive(async () => {
                const encryptionStatus = await readSyncEncryptionStatus();
                if (encryptionStatus.incompleteTransition) {
                    throw new SyncEncryptionTransitionIncompleteError(
                        encryptionStatus.incompleteTransition,
                    );
                }
                const committed = await commitProvenSyncConfigurationTransaction(config, {
                    recoverDropboxCredentialsBeforeConfiguration: () => (
                        SyncService.recoverDropboxCredentialsBeforeConfigurationMutation()
                    ),
                    readConfiguration: (requirements) => SyncService.readPersistedSyncConfiguration(requirements),
                    writeBackend: writeSyncBackendDirect,
                    writeSyncPath: (path) => SyncService.setSyncPath(path),
                    clearSyncPath: () => clearSyncPath(getSyncConfigDeps()),
                    writeWebDav: (webdav) => SyncService.setWebDavConfig({
                        ...webdav,
                        replacePassword: true,
                    }),
                    writeCloud: (cloud) => SyncService.setCloudConfig(cloud),
                    writeCloudProvider: writeCloudProviderDirect,
                    promoteDropboxCredentials: (handle) => (
                        SyncService.promoteDropboxCredentials(handle)
                    ),
                    discardDropboxCredentials: (handle) => (
                        SyncService.discardDropboxCredentials(handle)
                    ),
                    rollbackDropboxCredentials: (handle) => (
                        SyncService.rollbackDropboxCredentials(handle)
                    ),
                    finalizeDropboxCredentials: (handle) => (
                        SyncService.finalizeDropboxCredentials(handle)
                    ),
                });
                if (committed.cleanupPending && credentialHandle) {
                    // Phase ownership changes before releasing the lifecycle queue;
                    // a queued Off/disconnect barrier must see and settle this slot.
                    SyncService.moveDropboxCredentialToFinalizeRetry(credentialHandle);
                }
                return committed;
            });
        } catch (error) {
            // A SyncConfigurationDisabledError is the transaction's own assertion
            // that it left sync durably off (rollback could not restore). Reflect
            // that without any config IO — after a failed native recovery, no
            // further configuration read may run (fail-closed).
            if (error instanceof SyncConfigurationDisabledError) {
                SyncService.updateSyncStatus({ backend: 'off' });
            }
            throw error;
        }
        // The transaction's internal intermediate 'off' write is deliberately not
        // observed; only the committed configuration is (#1001). On any other
        // throw/rollback the persisted backend is unchanged, so the status needs
        // no correction.
        await SyncService.refreshSyncBackendStatus();
        if (result.cleanupPending && credentialHandle) {
            // Schedule the post-commit notice/retry behind anything that was
            // already queued during commit. A newer Off/disconnect barrier may
            // settle and clear this handle first, in which case no stale notice
            // or finalize attempt is emitted.
            void runSyncRestoreExclusive(async () => {
                if (!SyncService.pendingDropboxFinalizeHandles.has(credentialHandle)) return;
                logSyncWarning('Dropbox setup committed; credential cleanup will retry');
                try {
                    useUiStore.getState().showToast(
                        resolveSyncText('settings.dropboxCleanupRetry', 'Dropbox setup was saved. Credential cleanup will retry.'),
                        'info',
                        6000,
                    );
                } catch {
                    // The UI store can be unavailable during shutdown/tests.
                }
                try {
                    // Native finalize is idempotent at the committed marker,
                    // including a lost response after cleanup.
                    await SyncService.retryDropboxCredentialFinalizations(credentialHandle);
                } catch {
                    logSyncWarning('Dropbox credential cleanup retry is still pending');
                }
            });
        }
        return result;
    }

    static async getDropboxAppKey(): Promise<string> {
        return readDropboxAppKey();
    }

    static async setDropboxAppKey(value: string): Promise<void> {
        return writeDropboxAppKey(value);
    }

    static async getDropboxRedirectUri(): Promise<string> {
        if (!isTauriRuntimeEnv()) return DROPBOX_REDIRECT_URI_FALLBACK;
        try {
            return await invokeSyncNative<string>('get_dropbox_redirect_uri');
        } catch {
            return DROPBOX_REDIRECT_URI_FALLBACK;
        }
    }

    static async isDropboxConnected(clientId: string): Promise<boolean> {
        return runSyncRestoreExclusive(() => isDropboxConnectedDirect(clientId));
    }

    static async connectDropbox(clientId: string): Promise<string> {
        const normalized = clientId.trim();
        if (!normalized) {
            throw new Error('Dropbox app key is required');
        }
        if (!isTauriRuntimeEnv()) {
            throw new Error('Dropbox sync is only available in the desktop app.');
        }
        return runSyncRestoreExclusive(async () => {
            if (SyncService.pendingDropboxCredentialHandle) {
                throw new Error('A pending Dropbox authorization must be resolved before connecting another account');
            }
            // Renderer finalize ownership is session-only and may be empty
            // after reload. Native recovery must settle any prior promotion
            // journal before a new OAuth candidate is allowed to mutate it.
            await SyncService.recoverDropboxCredentialsBeforeConfigurationMutation();
            const credentialHandle = await invokeSyncNative<string>('connect_dropbox', { clientId: normalized });
            SyncService.rememberPendingDropboxCredentialHandleForSession(credentialHandle);
            return credentialHandle;
        });
    }

    static async disconnectDropbox(clientId: string): Promise<void> {
        const normalized = clientId.trim();
        if (!normalized) {
            throw new Error('Dropbox app key is required');
        }
        if (!isTauriRuntimeEnv()) {
            throw new Error('Dropbox sync is only available in the desktop app.');
        }
        await runSyncRestoreExclusive(async () => {
            const pendingCredentialHandle = SyncService.pendingDropboxCredentialHandle;
            await SyncService.recoverDropboxCredentialsBeforeConfigurationMutation();
            const current = await SyncService.readPersistedSyncConfiguration();
            const activeDropbox = current.backend === 'cloud'
                && current.cloudProvider === 'dropbox';
            if (activeDropbox) {
                await writeSyncBackendDirect('off');
                const disabled = await SyncService.readPersistedSyncConfiguration();
                if (disabled.backend !== 'off') {
                    throw new Error('Dropbox could not be disconnected because sync is not durably disabled');
                }
                await SyncService.noteSyncBackendPersisted('off');

                SyncService.syncOrchestrator.reset();
                SyncService.queuedSyncOptions = null;
                SyncService.updateSyncStatus({ queued: false });
                await SyncService.stopFileWatcher();
                clearFastSyncState();
                clearLocalSyncStatus();
                clearAttachmentSyncState();
            }
            await invokeSyncNative('disconnect_dropbox', { clientId: normalized });
            if (pendingCredentialHandle) {
                SyncService.forgetPendingDropboxCredentialHandleForSession(pendingCredentialHandle);
            }
        });
    }

    private static async invokeStagedDropboxCredentialCommand(
        command: string,
        credentialHandle: string,
    ): Promise<void> {
        const normalizedHandle = credentialHandle.trim();
        if (!normalizedHandle) {
            throw new Error('Dropbox credential handle is required');
        }
        const clientId = (await SyncService.getDropboxAppKey()).trim();
        if (!clientId) {
            throw new Error('Dropbox app key is required');
        }
        if (!isTauriRuntimeEnv()) {
            throw new Error('Dropbox sync is only available in the desktop app.');
        }
        await invokeSyncNative(command, {
            clientId,
            credentialHandle: normalizedHandle,
        });
    }

    static async resolvePendingDropboxCredentialForSession(credentialHandle: string): Promise<void> {
        const normalizedHandle = credentialHandle.trim();
        if (!normalizedHandle) {
            throw new Error('Dropbox credential handle is required');
        }
        await runSyncRestoreExclusive(async () => {
            if (SyncService.pendingDropboxFinalizeHandles.has(normalizedHandle)) {
                // This handle is past the exact active-backend commit point.
                // Its only legal transition is idempotent finalize.
                await SyncService.retryDropboxCredentialFinalizations(normalizedHandle);
                return;
            }
            const pendingHandle = SyncService.pendingDropboxCredentialHandle;
            // A transaction or disconnect that ran first already resolved this
            // handle. A different handle must never be touched by stale cleanup.
            if (!pendingHandle) return;
            if (pendingHandle !== normalizedHandle) {
                throw new Error('A different Dropbox authorization is pending recovery');
            }
            try {
                // Native discard is idempotent for a missing/expired Candidate.
                // Promoted entries are never TTL-pruned and deliberately reject
                // discard, so rollback remains the safe second phase.
                await SyncService.discardDropboxCredentials(normalizedHandle);
            } catch (discardError) {
                try {
                    await SyncService.rollbackDropboxCredentials(normalizedHandle);
                } catch (rollbackError) {
                    const discardMessage = discardError instanceof Error
                        ? discardError.message
                        : String(discardError);
                    const rollbackMessage = rollbackError instanceof Error
                        ? rollbackError.message
                        : String(rollbackError);
                    throw new Error(
                        `Pending Dropbox authorization could not be discarded (${discardMessage}) or rolled back (${rollbackMessage})`,
                    );
                }
            }
        });
    }

    static async promoteDropboxCredentials(credentialHandle: string): Promise<void> {
        await SyncService.invokeStagedDropboxCredentialCommand(
            'promote_staged_dropbox_credentials',
            credentialHandle,
        );
    }

    static async rollbackDropboxCredentials(credentialHandle: string): Promise<void> {
        await SyncService.invokeStagedDropboxCredentialCommand(
            'rollback_staged_dropbox_credentials',
            credentialHandle,
        );
        SyncService.forgetPendingDropboxCredentialHandleForSession(credentialHandle);
    }

    static async finalizeDropboxCredentials(credentialHandle: string): Promise<void> {
        await SyncService.invokeStagedDropboxCredentialCommand(
            'finalize_staged_dropbox_credentials',
            credentialHandle,
        );
        SyncService.forgetPendingDropboxCredentialHandleForSession(credentialHandle);
        SyncService.forgetDropboxFinalizeRetryHandle(credentialHandle);
    }

    static async discardDropboxCredentials(credentialHandle: string): Promise<void> {
        await SyncService.invokeStagedDropboxCredentialCommand(
            'discard_staged_dropbox_credentials',
            credentialHandle,
        );
        SyncService.forgetPendingDropboxCredentialHandleForSession(credentialHandle);
    }

    static async getDropboxAccessToken(
        clientId: string,
        options?: DropboxCredentialHandleOptions,
    ): Promise<string> {
        return runSyncRestoreExclusive(() => getDropboxAccessTokenDirect(clientId, {
            ...options,
            credentialHandle: resolveRequestedDropboxCredentialHandleAtExecution(
                options?.credentialHandle,
            ),
        }));
    }

    static async testDropboxConnection(
        clientId: string,
        options?: { credentialHandle?: string },
    ): Promise<void> {
        return runSyncRestoreExclusive(() => testDropboxConnectionDirect(clientId, {
            credentialHandle: resolveRequestedDropboxCredentialHandleAtExecution(
                options?.credentialHandle,
            ),
        }));
    }

    /**
     * Get the currently configured sync path from the backend
     */
    static async getSyncPath(): Promise<string> {
        return readSyncPath(getSyncConfigDeps());
    }

    /**
     * Set the sync path in the backend
     */
    static async setSyncPath(path: string): Promise<{ success: boolean; path: string; error?: string }> {
        return writeSyncPath(path, getSyncConfigDeps());
    }

    private static async markSyncWrite(data: AppData) {
        const hash = await hashString(toStableJson(data));
        SyncService.lastWrittenHash = hash;
        SyncService.fileWriteIgnoreActive = true;
        SyncService.ignoreFileEventsUntil = Number.POSITIVE_INFINITY;
    }

    private static finalizeSyncWriteIgnoreWindow() {
        if (!SyncService.fileWriteIgnoreActive) return;
        SyncService.fileWriteIgnoreActive = false;
        SyncService.ignoreFileEventsUntil = SyncService.getMonotonicNow() + 2000;
    }

    /** Desktop's own transient-retry policy for one Dropbox transport call
     *  (network/5xx failures, per `DROPBOX_TRANSIENT_RETRY_OPTIONS`). The
     *  401-triggered token-refresh-and-retry-once policy is shared and lives
     *  in `createSyncBackendIO` (`packages/core/src/sync-backend-io.ts`);
     *  `isRetryableError` already excludes 401s, so this wrap never competes
     *  with that policy — it only covers the same operation's transient failures. */
    private static async runDropboxTransientRetry<T>(operation: () => Promise<T>): Promise<T> {
        return withRetry(operation, DROPBOX_TRANSIENT_RETRY_OPTIONS);
    }

    private static async persistSuccessfulSyncStatus(
        syncStatus: NonNullable<AppSettings['lastSyncStatus']>,
        now: string,
        lastSyncHistory?: ReturnType<typeof appendSyncHistory>
    ): Promise<boolean> {
        try {
            await persistSyncSettings({
                lastSyncAt: now,
                lastSyncStatus: syncStatus,
                lastSyncError: undefined,
                ...(lastSyncHistory ? { lastSyncHistory } : {}),
            });
            SyncService.lastSuccessfulSyncLocalChangeAt = getStoreState().lastDataChangeAt;
            return true;
        } catch (error) {
            logSyncWarning('Failed to persist sync status', error);
            return false;
        }
    }

    /** Resolve backend config and construct the cycle's transport adapter —
     *  the core machine's setupCycle hook. */
    private static async setupDesktopCycle(
        context: DesktopSyncCycleContext,
        options: SyncRunOptions,
        setStep: (step: string) => void
    ): Promise<SyncRunCycleSetup> {
        const configOverride = options.configOverride;
        context.usesConfigOverride = Boolean(configOverride);
        context.backend = configOverride?.backend
            ?? options.backendOverride
            ?? await SyncService.getSyncBackend();
        if (context.backend === 'off') {
            return { kind: 'disabled' };
        }

        const encryptionStatus = await readSyncEncryptionStatus();
        if (encryptionStatus.incompleteTransition) {
            if (!options.manual && !options.activationProbe) return { kind: 'disabled' };
            throw new SyncEncryptionTransitionIncompleteError(encryptionStatus.incompleteTransition);
        }

        if (
            (context.backend === 'cloud' || context.backend === 'webdav' || context.backend === 'cloudkit')
            && typeof window !== 'undefined'
        ) {
            const handleOffline = () => {
                context.networkWentOffline = true;
                context.requestAbortController.abort();
            };
            window.addEventListener('offline', handleOffline);
            context.removeNetworkListener = () => {
                window.removeEventListener('offline', handleOffline);
                context.removeNetworkListener = null;
            };
        }

        if (isTauriRuntimeEnv()) {
            setStep('snapshot');
            await yieldToRenderer();
            try {
                await invokeSyncNative<string>('create_data_snapshot');
            } catch (error) {
                logSyncWarning('Failed to create pre-sync snapshot', error);
            }
        }

        if (
            (context.backend === 'cloud' || context.backend === 'webdav' || context.backend === 'cloudkit')
            && typeof navigator !== 'undefined'
            && navigator.onLine === false
        ) {
            throw new Error('Offline: network connection is unavailable for remote sync.');
        }

        context.webdavConfig = context.backend === 'webdav'
            ? configOverride?.webdav ?? await SyncService.getWebDavConfig()
            : null;
        if (context.webdavConfig) {
            await ensureWebdavCapabilityProof(
                context.webdavConfig,
                () => SyncService.probeWebDavStrongEtagSupport(context.webdavConfig!),
            );
        }
        context.cloudProvider = context.backend === 'cloud'
            ? configOverride?.cloudProvider ?? await SyncService.getCloudProvider()
            : 'selfhosted';
        context.cloudConfig = context.backend === 'cloud' && context.cloudProvider === 'selfhosted'
            ? configOverride?.cloud ?? await SyncService.getCloudConfig()
            : null;
        context.dropboxAppKey = context.backend === 'cloud' && context.cloudProvider === 'dropbox'
            ? (await SyncService.getDropboxAppKey()).trim()
            : '';
        context.dropboxCredentialHandle = context.backend === 'cloud' && context.cloudProvider === 'dropbox'
            ? configOverride?.dropboxCredentialHandle?.trim() || null
            : null;
        if (context.backend === 'cloud' && context.cloudProvider === 'dropbox' && !context.dropboxAppKey) {
            throw new Error('Dropbox app key is not configured');
        }
        context.syncPath = context.backend === 'file'
            ? configOverride?.syncPath ?? await SyncService.getSyncPath()
            : '';
        context.fileBaseDir = context.backend === 'file'
            ? getFileSyncDir(context.syncPath, SYNC_FILE_NAME, LEGACY_SYNC_FILE_NAME)
            : '';

        // CloudKit setup: ensure zone and subscription exist before syncing.
        if (context.backend === 'cloudkit') {
            setStep('cloudkit_setup');
            await yieldToRenderer();
            await syncServiceDependencies.ensureCloudKitReady();
        }

        return {
            kind: 'ready',
            backend: context.backend,
            cloudProvider: context.cloudProvider,
            io: SyncService.createBackendIO(context),
            fastSyncScope: buildFastSyncScope(context),
        };
    }

    /** Ladder-visible config for `createSyncBackendIO` (ADR 0014's shared
     *  `SyncBackendIO` implementation, `packages/core/src/sync-backend-io.ts`).
     *  A separate, minimal object from `DesktopSyncCycleContext` — the ladder
     *  only needs enough to pick a branch and normalize a url; the transport
     *  closures below keep reading the rich `context` for everything else. */
    private static createBackendContext(context: DesktopSyncCycleContext): SyncBackendContext {
        return {
            backend: context.backend,
            cloudProvider: context.cloudProvider,
            webdav: context.webdavConfig?.url ? { url: context.webdavConfig.url } : null,
            cloud: context.cloudConfig?.url ? { url: context.cloudConfig.url } : null,
            filePath: context.fileBaseDir,
            dropboxAppKey: context.dropboxAppKey,
            dropboxRev: null,
        };
    }

    /** Backend transport adapter for the core machine (ADR 0014). The ladder
     *  (which backend, url normalization, the Dropbox rev fingerprint format,
     *  the conflict mapping, and the auth-retry-once policy) lives in
     *  `createSyncBackendIO`; this only supplies desktop's transport truths. */
    private static createBackendIO(context: DesktopSyncCycleContext): SyncBackendIO {
        const ctx = SyncService.createBackendContext(context);

        const transport: SyncTransport = {
            acquireWebdavRemoteMutationFence: async () => {
                const webdavConfig = context.webdavConfig;
                if (!webdavConfig?.url) throw new Error('WebDAV URL not configured');
                const password = await resolveWebdavPassword(webdavConfig);
                const fetcher = await createFetchWithAbortForContext(context);
                return acquireSyncRemoteMutationFence(
                    createWebdavSyncRemoteMutationFencePort(
                        normalizeWebdavUrl(webdavConfig.url),
                        {
                            allowInsecureHttp: webdavConfig.allowInsecureHttp,
                            username: webdavConfig.username,
                            password,
                            fetcher,
                        },
                    ),
                    { ownerId: 'mindwtr-desktop', purpose: 'ordinary-sync' },
                );
            },
            acquireDropboxRemoteMutationFence: async (token) => {
                const fetcher = await createFetchWithAbortForContext(context);
                return acquireSyncRemoteMutationFence(
                    createDropboxSyncRemoteMutationFencePort(token, fetcher),
                    { ownerId: 'mindwtr-desktop', purpose: 'ordinary-sync' },
                );
            },
            webdavGet: async () => {
                // Error context must carry the file URL the request targets,
                // not the configured base folder — a folder-only url field
                // made #898 (and #758) logs unreadable for pinpointing the
                // failing request.
                const normalizedUrl = ctx.syncUrl!;
                // A "missing" remote on a folder that other devices populate
                // means the app is reading the wrong URL or the server hid
                // the file; make it visible in shared logs (#898).
                const logMissingRemote = (remote: WebdavSyncReadResult): WebdavSyncReadResult => {
                    if (remote.data == null) {
                        logSyncInfo('WebDAV remote read returned no data', { url: normalizedUrl });
                    }
                    return remote;
                };
                if (isTauriRuntimeEnv() && !context.usesConfigOverride) {
                    return logMissingRemote(await withRetry(
                        () => invokeSyncNative<WebdavSyncReadResult>('webdav_get_json'),
                        WEBDAV_READ_RETRY_OPTIONS,
                    ));
                }
                const webdavConfig = context.webdavConfig!;
                const password = await resolveWebdavPassword(webdavConfig);
                const fetcher = await createFetchWithAbortForContext(context);
                const material = (await getSyncEncryptionMaterial()) ?? undefined;
                const result = await withRetry(
                    () => webdavGetSyncDocument<AppData>(normalizedUrl, {
                        allowInsecureHttp: webdavConfig.allowInsecureHttp,
                        username: webdavConfig.username,
                        password,
                        fetcher,
                        material,
                        cryptoPrims: desktopSyncCryptoPrimitives,
                    }),
                    WEBDAV_READ_RETRY_OPTIONS,
                );
                if (result.state === 'encrypted-no-key') {
                    if (!normalizeStrongWebdavEtag(result.strongEtag)) {
                        throw new SyncEncryptionRemoteVersionUnavailableError(
                            'WebDAV encrypted sync document',
                        );
                    }
                    await markRemoteSyncEncryptionDiscovered({ salt: result.salt, params: result.params });
                    // Carries the Rust-mirrored sentinel so string-form classification
                    // (classifySyncEncryptionFailure on a probe result's error text)
                    // recognizes this as no-key, same as the native path.
                    throw new SyncEncryptionTerminalError(
                        new SyncCryptoUnsupportedError(`${SYNC_ENCRYPTION_REMOTE_ENCRYPTED}: the WebDAV remote is encrypted and this device has no key`),
                    );
                }
                if (result.state === 'remote-plaintext') {
                    await markRemoteSyncEncryptionPlaintext();
                    throw new SyncEncryptionRemotePlaintextError('the WebDAV remote is no longer encrypted');
                }
                return logMissingRemote({
                    data: result.data,
                    exists: result.exists,
                    strongEtag: result.strongEtag,
                });
            },
            webdavPut: async (sanitized, expectedEtag) => {
                if (isTauriRuntimeEnv() && !context.usesConfigOverride) {
                    return invokeSyncNative<RemoteJsonWriteResult | boolean>('webdav_put_json', {
                        data: sanitized,
                        expectedEtag,
                    });
                }
                const config = context.webdavConfig ?? await SyncService.getWebDavConfig();
                const normalizedUrl = normalizeWebdavUrl(config.url);
                ctx.syncUrl = normalizedUrl;
                const password = await resolveWebdavPassword(config);
                const fetcher = await createFetchWithAbortForContext(context);
                const material = (await getSyncEncryptionMaterial()) ?? undefined;
                return webdavPutSyncDocument(normalizedUrl, sanitized, {
                    allowInsecureHttp: config.allowInsecureHttp,
                    username: config.username,
                    password,
                    fetcher,
                    material,
                    cryptoPrims: desktopSyncCryptoPrimitives,
                    expectedEtag,
                });
            },
            webdavHead: async () => {
                const webdavConfig = context.webdavConfig!;
                const password = await resolveWebdavPassword(webdavConfig);
                const fetcher = await createFetchWithAbortForContext(context);
                // The HEAD has to target the artifact that actually exists, or the change
                // probe 404s every cycle on an encrypted remote. The fingerprint it builds
                // stays a change-detection heuristic either way.
                const material = await getSyncEncryptionMaterial();
                const headUrl = material ? syncEncryptedArtifactName(ctx.syncUrl!) : ctx.syncUrl!;
                return webdavHeadFile(headUrl, {
                    allowInsecureHttp: webdavConfig.allowInsecureHttp,
                    allowWeakFingerprint: webdavConfig.allowWeakFingerprint,
                    username: webdavConfig.username,
                    password,
                    fetcher,
                });
            },
            cloudGet: async () => {
                if (isTauriRuntimeEnv() && !context.usesConfigOverride) {
                    return invokeSyncNative<AppData | null>('cloud_get_json');
                }
                const fetcher = await createFetchWithAbortForContext(context);
                return cloudGetJson<AppData>(ctx.syncUrl!, {
                    allowInsecureHttp: context.cloudConfig!.allowInsecureHttp,
                    token: context.cloudConfig!.token,
                    fetcher,
                });
            },
            cloudPut: async (sanitized) => {
                const config = context.cloudConfig ?? await SyncService.getCloudConfig();
                const normalizedUrl = normalizeCloudUrl(config.url);
                ctx.syncUrl = normalizedUrl;
                if (isTauriRuntimeEnv() && !context.usesConfigOverride) {
                    return invokeSyncNative<CloudJsonWriteResult | boolean>('cloud_put_json', { data: sanitized });
                }
                const fetcher = await createFetchWithAbortForContext(context);
                return cloudPutJson(normalizedUrl, sanitized, {
                    allowInsecureHttp: config.allowInsecureHttp,
                    token: config.token,
                    fetcher,
                });
            },
            cloudHead: async () => {
                const fetcher = await createFetchWithAbortForContext(context);
                return cloudHeadJson(ctx.syncUrl!, {
                    allowInsecureHttp: context.cloudConfig!.allowInsecureHttp,
                    token: context.cloudConfig!.token,
                    fetcher,
                });
            },
            fileRead: async () => {
                if (!isTauriRuntimeEnv()) {
                    throw new Error('File sync is not available in the web app.');
                }
                return invokeSyncNative<FileSyncReadResult>('read_sync_file_versioned', context.usesConfigOverride
                    ? { path: context.syncPath }
                    : undefined);
            },
            fileWrite: async (sanitized, expectedFingerprint) => {
                await SyncService.markSyncWrite(sanitized);
                try {
                    await invokeSyncNative('write_sync_file', {
                        data: sanitized,
                        ...(expectedFingerprint ? { expectedFingerprint } : {}),
                        ...(context.usesConfigOverride ? { path: context.syncPath } : {}),
                    });
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    if (message.includes('SYNC_FILE_WRITE_CONFLICT')) {
                        throw new SyncRemoteWriteConflict();
                    }
                    throw error;
                }
            },
            cloudKitRead: async () => syncServiceDependencies.readRemoteCloudKit(),
            cloudKitWrite: async (sanitized) => {
                await syncServiceDependencies.writeRemoteCloudKit(sanitized);
            },
            resolveDropboxToken: (forceRefresh) => SyncService.runDropboxTransientRetry(
                () => resolveDropboxAccessTokenForContext(context, forceRefresh)
            ),
            dropboxDownload: (token) => SyncService.downloadDropboxWithFallback(context, token),
            dropboxUpload: async (token, sanitized, expectedRev) => {
                const fetcher = await createFetchWithAbortForContext(context);
                const material = (await getSyncEncryptionMaterial()) ?? undefined;
                return SyncService.runDropboxTransientRetry(
                    () => uploadDropboxAppData(token, sanitized, expectedRev, fetcher, {
                        material,
                        cryptoPrims: desktopSyncCryptoPrimitives,
                    })
                );
            },
            dropboxMetadata: async (token) => {
                const fetcher = await createFetchWithAbortForContext(context);
                const material = (await getSyncEncryptionMaterial()) ?? undefined;
                return SyncService.runDropboxTransientRetry(
                    () => getDropboxAppDataMetadata(token, fetcher, { material })
                );
            },
            syncWebdavAttachments: async (data, helpers) => {
                const baseUrl = getBaseSyncUrl(context.webdavConfig!.url);
                return syncAttachments(data, context.webdavConfig!, baseUrl, attachmentBackendDeps, helpers);
            },
            syncCloudKitAttachments: async (data, helpers) => syncCloudKitAttachments(
                data,
                attachmentBackendDeps,
                helpers,
            ),
            syncFileAttachments: async (data, helpers) => syncFileAttachments(
                data,
                context.fileBaseDir,
                attachmentBackendDeps,
                helpers,
            ),
            syncCloudAttachments: async (data, helpers) => {
                const baseUrl = getCloudBaseUrl(context.cloudConfig!.url);
                return syncCloudAttachments(data, context.cloudConfig!, baseUrl, attachmentBackendDeps, helpers);
            },
            syncDropboxAttachments: async (data, helpers) => syncDropboxAttachments(
                data,
                (forceRefresh) => resolveDropboxAccessTokenForContext(context, forceRefresh),
                attachmentBackendDeps,
                helpers,
            ),
        };

        return createSyncBackendIO(ctx, transport);
    }

    /** Dropbox remote read: try the native (Tauri) fetcher first, fall back to
     *  the browser fetcher when it comes back empty. Desktop-only truth — the
     *  Tauri http client and the browser fetch client can see different
     *  network paths (e.g. proxy configuration), so a native miss is worth a
     *  second try before treating the remote as empty. */
    private static async downloadDropboxWithFallback(
        context: DesktopSyncCycleContext,
        token: string
    ): Promise<{ data: AppData | null; rev: string | null }> {
        const nativeFetch = await getTauriFetch();
        const browserFetcher = createAbortableFetch(fetch, { baseSignal: context.requestAbortController.signal });
        // `undefined` material is the encryption-off path and produces byte-for-byte the same
        // request Dropbox saw before this feature existed.
        const material = (await getSyncEncryptionMaterial()) ?? undefined;
        const crypto = { material, cryptoPrims: desktopSyncCryptoPrimitives };

        // A discovery means the remote is encrypted and this device has no key: persist the
        // state and stop the run. Never "no data" — that would let the merge treat an encrypted
        // remote as empty and push a full plaintext document over it.
        const settle = async (result: DropboxDownloadResult): Promise<DropboxDownloadResult> => {
            if (result.encryptedNoKey) {
                await markRemoteSyncEncryptionDiscovered(result.encryptedNoKey);
                // Sentinel-prefixed for the same string-form classification as the
                // WebDAV path above.
                throw new SyncEncryptionTerminalError(
                    new SyncCryptoUnsupportedError(`${SYNC_ENCRYPTION_REMOTE_ENCRYPTED}: the Dropbox remote is encrypted and this device has no key`),
                );
            }
            // The mirror case: this device has a key and the remote is back in plaintext, so a
            // peer disabled encryption there. Also never "no data" — merging would fork the
            // account into two generations, and writing plaintext would follow whoever removed
            // the ciphertext down to it.
            if (result.remotePlaintext) {
                await markRemoteSyncEncryptionPlaintext();
                throw new SyncEncryptionRemotePlaintextError('the Dropbox remote is no longer encrypted');
            }
            return result;
        };

        if (!nativeFetch) {
            return settle(
                await SyncService.runDropboxTransientRetry(() =>
                    downloadDropboxAppData(token, browserFetcher, crypto)
                )
            );
        }

        const nativeFetcher = createAbortableFetch(nativeFetch, { baseSignal: context.requestAbortController.signal });
        const nativeRemote = await settle(
            await SyncService.runDropboxTransientRetry(() => downloadDropboxAppData(token, nativeFetcher, crypto))
        );
        if (nativeRemote.data !== null) {
            return nativeRemote;
        }

        logSyncInfo('Retrying Dropbox remote read with browser fetch fallback');
        try {
            const browserRemote = await settle(
                await SyncService.runDropboxTransientRetry(() =>
                    downloadDropboxAppData(token, browserFetcher, crypto)
                )
            );
            if (browserRemote.data !== null) {
                logSyncInfo('Recovered Dropbox remote read via browser fetch fallback');
                return browserRemote;
            }
            return nativeRemote;
        } catch (error) {
            if (isSyncEncryptionFailure(error)) throw error;
            logSyncWarning('Dropbox browser fetch fallback failed', error);
            return nativeRemote;
        }
    }

    private static hasPendingLocalChangesForExternalSync(): boolean {
        const state = getStoreState();
        if (!state.settings?.lastSyncAt) return false;
        if (state.lastDataChangeAt <= 0) return false;
        return state.lastDataChangeAt > SyncService.lastSuccessfulSyncLocalChangeAt;
    }

    static hasPendingLocalChangesForAutoSync(): boolean {
        const state = getStoreState();
        if (state.lastDataChangeAt <= 0) return false;
        return state.lastDataChangeAt > SyncService.lastSuccessfulSyncLocalChangeAt;
    }

    static async resolveExternalSyncChange(
        resolution: ExternalSyncChangeResolution
    ): Promise<{ success: boolean; stats?: MergeStats; error?: string }> {
        if (!isTauriRuntimeEnv()) return { success: false, error: 'Desktop runtime is required.' };
        const backend = await SyncService.getSyncBackend();
        if (backend !== 'file') return { success: false, error: 'External file conflict handling is only available for file sync.' };

        const pendingChange = SyncService.pendingExternalSyncChange;
        SyncService.setPendingExternalSyncChange(null);

        try {
            if (resolution === 'merge') {
                return await SyncService.performSync();
            }

            if (resolution === 'keep-local') {
                await runSyncDocumentExclusive(async () => {
                    await syncServiceDependencies.flushPendingSave();
                    const localData = await injectExternalCalendars(await readLocalDataForSync());
                    const sanitized = sanitizeAppDataForRemote(localData);
                    await SyncService.markSyncWrite(sanitized);
                    try {
                        await invokeSyncNative('write_sync_file', { data: sanitized });
                    } catch (error) {
                        SyncService.finalizeSyncWriteIgnoreWindow();
                        throw error;
                    }
                });
                return await SyncService.performSync();
            }

            return await runSyncDocumentWriteExclusive(async () => {
                await syncServiceDependencies.flushPendingSave();
                const externalData = normalizeAppData(await invokeSyncNative<AppData>('read_sync_file'));
                await persistLocalDataForSync(externalData, { mode: 'exact' });
                await getStoreState().fetchData({ silent: true });
                const now = new Date().toISOString();
                const nextHistory = appendSyncHistory(getStoreState().settings, {
                    at: now,
                    status: 'success',
                    backend: 'file',
                    type: 'pull',
                    conflicts: 0,
                    conflictIds: [],
                    maxClockSkewMs: 0,
                    timestampAdjustments: 0,
                    details: 'external_override',
                });
                const persisted = await SyncService.persistSuccessfulSyncStatus('success', now, nextHistory);
                if (!persisted) {
                    throw new Error('Failed to persist sync status');
                }
                if (pendingChange?.incomingHash) {
                    SyncService.lastObservedHash = pendingChange.incomingHash;
                }
                return { success: true };
            });
        } catch (error) {
            SyncService.setPendingExternalSyncChange(pendingChange);
            const message = error instanceof Error ? error.message : String(error);
            return { success: false, error: message };
        }
    }

    private static async handleFileChange(paths: string[]) {
        if (!isTauriRuntimeEnv()) return;
        if (SyncService.getMonotonicNow() < SyncService.ignoreFileEventsUntil) return;

        const hasSyncFile = paths.some((path) => isSyncFilePath(path, SYNC_FILE_NAME, LEGACY_SYNC_FILE_NAME));
        if (!hasSyncFile) return;

        try {
            const syncData = await invokeSyncNative<AppData>('read_sync_file');
            const normalized = normalizeAppData(syncData);
            const hash = await hashString(toStableJson(normalized));
            if (hash === SyncService.lastWrittenHash) {
                return;
            }
            if (hash === SyncService.lastObservedHash) {
                return;
            }
            SyncService.lastObservedHash = hash;

            if (SyncService.hasPendingLocalChangesForExternalSync()) {
                if (SyncService.externalSyncTimer) {
                    clearTimeout(SyncService.externalSyncTimer);
                    SyncService.externalSyncTimer = null;
                }
                const localState = getStoreState();
                const syncPath = SyncService.fileWatcherPath ?? await SyncService.getSyncPath();
                const pending = SyncService.pendingExternalSyncChange;
                if (!pending || pending.incomingHash !== hash) {
                    SyncService.setPendingExternalSyncChange({
                        at: new Date().toISOString(),
                        incomingHash: hash,
                        syncPath,
                        hasLocalChanges: true,
                        localChangeAt: localState.lastDataChangeAt,
                        lastSyncAt: localState.settings?.lastSyncAt,
                    });
                }
                return;
            }

            if (SyncService.externalSyncTimer) {
                clearTimeout(SyncService.externalSyncTimer);
            }
            SyncService.externalSyncTimer = setTimeout(() => {
                SyncService.performSync()
                    .then((result) => {
                        if (result.success) {
                            SyncService.setPendingExternalSyncChange(null);
                            const conflicts = summarizeMergeStats(result.stats).conflicts;
                            const message = conflicts > 0
                                ? `Data updated from sync (${conflicts} conflict${conflicts === 1 ? '' : 's'} resolved).`
                                : 'Data updated from sync.';
                            try {
                                useUiStore.getState().showToast(message, 'info', 5000);
                            } catch {
                                // UI store may be unavailable during bootstrap/tests.
                            }
                        }
                    })
                    .catch((error) => syncServiceDependencies.reportError('Sync failed', error));
            }, 750);
        } catch (error) {
            logSyncWarning('Failed to process external sync change', error);
        }
    }

    private static resolveUnwatch(unwatch: unknown): (() => void) | null {
        if (typeof unwatch === 'function') return unwatch as () => void;
        if (unwatch && typeof (unwatch as any).stop === 'function') {
            return () => (unwatch as any).stop();
        }
        if (unwatch && typeof (unwatch as any).unwatch === 'function') {
            return () => (unwatch as any).unwatch();
        }
        return null;
    }

    static async startFileWatcher(): Promise<void> {
        if (!isTauriRuntimeEnv()) return;
        const backend = await SyncService.getSyncBackend();
        if (backend !== 'file') {
            await SyncService.stopFileWatcher();
            return;
        }
        const syncPath = await SyncService.getSyncPath();
        if (!syncPath) {
            await SyncService.stopFileWatcher();
            return;
        }
        const watchPath = syncPath;
        if (SyncService.fileWatcherStop && SyncService.fileWatcherPath === watchPath && SyncService.fileWatcherBackend === backend) {
            return;
        }

        await SyncService.stopFileWatcher();

        try {
            const { watch } = await import('@tauri-apps/plugin-fs');
            const unwatch = await watch(watchPath, (event: any) => {
                const paths = Array.isArray(event?.paths)
                    ? event.paths
                    : event?.path
                        ? [event.path]
                        : [];
                if (paths.length === 0) return;
                void SyncService.handleFileChange(paths);
            });
            SyncService.fileWatcherStop = SyncService.resolveUnwatch(unwatch);
            SyncService.fileWatcherPath = watchPath;
            SyncService.fileWatcherBackend = backend;
        } catch (error) {
            logSyncWarning('Failed to start sync file watcher', error);
        }
    }

    static async stopFileWatcher(): Promise<void> {
        if (SyncService.fileWatcherStop) {
            try {
                SyncService.fileWatcherStop();
            } catch (error) {
                logSyncWarning('Failed to stop sync watcher', error);
            }
        }
        if (SyncService.externalSyncTimer) {
            clearTimeout(SyncService.externalSyncTimer);
            SyncService.externalSyncTimer = null;
        }
        SyncService.fileWatcherStop = null;
        SyncService.fileWatcherPath = null;
        SyncService.fileWatcherBackend = null;
        SyncService.setPendingExternalSyncChange(null);
    }

    static async cleanupAttachmentsNow(): Promise<void> {
        if (!isTauriRuntimeEnv()) return;
        await runSyncDocumentExclusive(async () => {
            await syncServiceDependencies.flushPendingSave();
            const localSnapshotChangeAt = getStoreState().lastDataChangeAt;
            const ensureLocalSnapshotFresh = () => {
                ensureFreshLocalSyncSnapshot({
                    localSnapshotChangeAt,
                    getCurrentChangeAt: () => getStoreState().lastDataChangeAt,
                    requestFollowUp: () => SyncService.requestQueuedSyncRun(),
                });
            };
            const backend = await SyncService.getSyncBackend();
            const data = await invokeSyncNative<AppData>('get_data');
            ensureLocalSnapshotFresh();
            const cleaned = await cleanupOrphanedAttachments(
                data,
                backend,
                getAttachmentCleanupDeps(),
                { ensureLocalSnapshotFresh },
            );
            ensureLocalSnapshotFresh();
            await persistLocalDataForSync(cleaned, { baseline: data });
            await getStoreState().fetchData({ silent: true });
        });
    }

    static async listDataSnapshots(): Promise<string[]> {
        if (!isTauriRuntimeEnv()) return [];
        try {
            return await invokeSyncNative<string[]>('list_data_snapshots');
        } catch (error) {
            syncServiceDependencies.reportError('Failed to list snapshots', error);
            return [];
        }
    }

    static async createDataSnapshot(): Promise<string | null> {
        if (!isTauriRuntimeEnv()) return null;
        try {
            return await invokeSyncNative<string>('create_data_snapshot');
        } catch (error) {
            syncServiceDependencies.reportError('Failed to create snapshot', error);
            return null;
        }
    }

    static async restoreDataSnapshot(snapshotFileName: string): Promise<{ success: boolean; error?: string }> {
        if (!isTauriRuntimeEnv()) return { success: false, error: 'Desktop runtime is required.' };
        try {
            await runSyncRestoreExclusive(() => runDataTransferTransactionWithoutSnapshot({
                operation: 'restoreDataSnapshot',
                flushPendingSave: syncServiceDependencies.flushPendingSave,
                getCurrentChangeAt: () => getStoreState().lastDataChangeAt,
                readCurrentData: () => invokeSyncNative<AppData>('get_data'),
                apply: (data) => ({ data, result: null }),
                persistData: async () => {
                    await invokeSyncNative<boolean>('restore_data_snapshot', { snapshotFileName });
                },
                refreshData: () => getStoreState().fetchData({ silent: true }),
            }));
            return { success: true };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { success: false, error: message };
        }
    }

    /**
     * Perform a full sync cycle:
     * 1. Read Local & Remote Data
     * 2. Merge (Last-Write-Wins)
     * 3. Write merged data back to both Local & Remote
     * 4. Refresh Core Store
     */
    static async performSync(options: SyncRunOptions = {}): Promise<SyncRunResult> {
        const wasInFlight = SyncService.syncOrchestrator.getState().inFlight;
        if (wasInFlight && options.activationProbe) {
            // A candidate must be proven by the call that will commit it. Do not
            // queue transient credentials after returning a requeue result.
            return { success: true, skipped: 'requeued' };
        }
        if (wasInFlight) {
            SyncService.queuedSyncOptions = options;
        }
        const result = SyncService.syncOrchestrator.run(options);
        if (wasInFlight && options.configOverride) {
            // The orchestrator returns the active cycle's promise when it queues
            // another request. That active result did not use this transient
            // config and must never authorize the settings UI to persist it.
            void result.catch((error) => logSyncWarning('Active sync failed while a settings proof was queued', error));
            return { success: true, skipped: 'requeued' };
        }
        return result;
    }

    private static runSyncCycle(options: SyncRunOptions): Promise<SyncRunResult> {
        return runSyncDocumentExclusive(() => SyncService.runSyncCycleExclusive(options));
    }

    private static async runSyncCycleExclusive(options: SyncRunOptions): Promise<SyncRunResult> {
        SyncService.queuedSyncOptions = null;
        try {
            await SyncService.retryDropboxCredentialFinalizations();
        } catch (error) {
            // The active configuration is already committed and durable. A
            // cleanup retry must not block sync through those credentials.
            logSyncWarning('Dropbox credential cleanup remains pending', error);
        }
        const context = createDesktopSyncCycleContext();
        const persistLocalData = async (data: AppData): Promise<AppData | void> => {
            if (isTauriRuntimeEnv()) {
                return persistLocalDataForSync(data);
            } else {
                await webStorage.saveData(data);
            }
        };

        SyncService.updateSyncStatus({
            inFlight: true,
            step: 'init',
            lastResult: SyncService.syncStatus.lastResult,
            lastResultAt: SyncService.syncStatus.lastResultAt,
        });
        await yieldToRenderer();

        let result: SyncRunResult;
        try {
            result = await runSharedSyncCycle({
                options: {
                    manual: options.manual,
                    activationProbe: options.activationProbe,
                    ignorePendingRemoteWriteBackoff: options.ignorePendingRemoteWriteBackoff,
                },
                storage: {
                    readPersistedLocal: () => readLocalDataForSync(),
                    persistLocal: persistLocalData,
                    applyDataToStore: (data) => syncServiceDependencies.applySyncedDataToStore(data),
                    persistSyncStatus: (updates) => persistSyncSettings(updates),
                    readFastSyncState: async (scope) => readFastSyncState(scope),
                    writeFastSyncState: async (state) => writeFastSyncState(state, logSyncWarning),
                    injectExternalCalendars: (data) => injectExternalCalendars(data),
                    persistExternalCalendars: (data) => persistExternalCalendars(data),
                },
                notifier: {
                    setStep: (step) => SyncService.updateSyncStatus({ step }),
                    logInfo: (message, extra) => logSyncInfo(message, extra),
                    logWarning: (message, error) => logSyncWarning(message, error),
                    logWarningExtra: (message, extra) => {
                        void syncServiceDependencies.logWarn(message, { scope: 'sync', extra });
                    },
                    sanitizeLogMessage: (message) => syncServiceDependencies.sanitizeLogMessage(message),
                    logSyncError: (error, errorContext) => syncServiceDependencies.logSyncError(error, {
                        backend: errorContext.backend,
                        step: errorContext.step,
                        url: errorContext.url,
                    }),
                    logMergeSummary: (mergeLog) => {
                        if (!isTauriRuntimeEnv()) return;
                        void syncServiceDependencies.logInfo(
                            mergeLog.message,
                            {
                                scope: 'sync',
                                extra: mergeLog.extra,
                                // Resolved conflicts must stay auditable in mindwtr.log even when
                                // diagnostics logging is off; the extra carries ids and field names
                                // only, never task content (#854).
                                force: mergeLog.summary.conflicts > 0,
                            }
                        );
                    },
                    tracePayload: (event, data, extra) => logSyncPayloadTrace(SYNC_TRACE_EVENT_MESSAGES[event], data, extra),
                    yieldToUi: () => yieldToRenderer(),
                },
                store: {
                    getLastDataChangeAt: () => getStoreState().lastDataChangeAt,
                    getInMemorySnapshot: () => syncServiceDependencies.getInMemoryAppDataSnapshot(),
                    flushPendingSave: () => syncServiceDependencies.flushPendingSave(),
                    setUiError: (message) => getStoreState().setError(message),
                    getSettings: () => getStoreState().settings,
                },
                hooks: {
                    setupCycle: (setupContext) => SyncService.setupDesktopCycle(context, options, setupContext.setStep),
                    requestFollowUp: () => SyncService.requestQueuedSyncRun(options, false),
                    ensureNetworkStillAvailable: () => {
                        if (context.backend !== 'cloud' && context.backend !== 'webdav' && context.backend !== 'cloudkit') return;
                        if (
                            context.networkWentOffline
                            || (typeof navigator !== 'undefined' && navigator.onLine === false)
                        ) {
                            context.requestAbortController.abort();
                            throw new Error('Sync paused: offline state detected');
                        }
                    },
                    acceptCoveredSnapshot: (expectedData) => SyncService.isCoveredLocalSnapshot(expectedData),
                    cleanupAttachmentTempFiles: () => cleanupAttachmentTempFiles(getAttachmentCleanupDeps()),
                    shouldRunAttachmentPhase: async (data) => hasAttachmentSyncWork(data),
                    runAttachmentCleanup: async (data, cleanupContext) => {
                        const orphanedAttachments = findOrphanedAttachments(data);
                        const deletedAttachments = findDeletedAttachmentsForFileCleanup(data);
                        const pendingRemoteDeletes = data.settings.attachments?.pendingRemoteDeletes ?? [];
                        if (orphanedAttachments.length === 0 && deletedAttachments.length === 0 && pendingRemoteDeletes.length === 0) {
                            return null;
                        }
                        cleanupContext.setStep('attachments_cleanup');
                        await yieldToRenderer();
                        cleanupContext.ensureLocalSnapshotFresh(data);
                        await cleanupContext.ensureNetworkStillAvailable();
                        const ensureLocalSnapshotFresh = () => cleanupContext.ensureLocalSnapshotFresh(data);
                        const cleanedData = await cleanupOrphanedAttachments(
                            data,
                            context.backend,
                            getAttachmentCleanupDeps(context.dropboxCredentialHandle),
                            { ensureLocalSnapshotFresh },
                        );
                        return {
                            data: cleanedData,
                            invalidateFastSyncState: orphanedAttachments.length > 0,
                        };
                    },
                    formatErrorMessage: (error, backend) => formatSyncErrorMessage(error, backend),
                    finalizeErrorStatus: async ({ at, message, history }) => {
                        getStoreState().setError(message);
                        await getStoreState().fetchData({ silent: true });
                        await persistSyncSettings({
                            lastSyncAt: at,
                            lastSyncStatus: 'error',
                            lastSyncError: message,
                            lastSyncHistory: history,
                        });
                    },
                    finalizeSuccess: (mergedData, info) => {
                        syncServiceDependencies.applySyncedDataToStore(mergedData);
                        info.acceptCoveredSnapshot(mergedData);
                        SyncService.lastSuccessfulSyncLocalChangeAt = getStoreState().lastDataChangeAt;
                        SyncService.setPendingExternalSyncChange(null);
                        getStoreState().setError(null);
                        SyncService.clearCoveredQueuedSyncRun(info.getLocalSnapshotChangeAt(), options);
                    },
                    onUnchangedSkip: () => {
                        SyncService.lastSuccessfulSyncLocalChangeAt = getStoreState().lastDataChangeAt;
                        SyncService.setPendingExternalSyncChange(null);
                    },
                },
                policy: {
                    // #1057 (review S1): must run before the fast unchanged-check, or an
                    // attachment-only edit (which changes no document field) has its
                    // fingerprint compared as "unchanged" and the pre-pass never runs at
                    // all — content propagation would only ever happen on a manual sync
                    // (which bypasses the fast check) or piggyback on an unrelated edit.
                    preSyncAttachmentsBeforeFastCheck: true,
                    enableReadCheckSkip: false,
                    postMergeAttachmentErrorPolicy: 'warn',
                    attachmentPhasesEnabled: isTauriRuntimeEnv(),
                },
                performSyncCycle: (io) => syncServiceDependencies.performSyncCycle(io),
            });
        } finally {
            context.requestAbortController.abort();
            try {
                const releaseNetworkListener = context.removeNetworkListener as (() => void) | null;
                if (typeof releaseNetworkListener === 'function') {
                    releaseNetworkListener();
                }
                context.removeNetworkListener = null;
            } catch (error) {
                logSyncWarning('Failed to unsubscribe network listener after sync', error);
            }
            SyncService.finalizeSyncWriteIgnoreWindow();
        }
        const skippedRequeue = result.skipped === 'requeued';
        if (!options.activationProbe && !skippedRequeue) {
            SyncService.finalizeAttachmentWarningState(
                { hadAttachmentWarning: result.hadAttachmentWarning === true },
                result
            );
        }
        SyncService.updateSyncStatus({
            inFlight: false,
            step: null,
            lastResult: options.activationProbe || skippedRequeue
                ? SyncService.syncStatus.lastResult
                : result.success
                    ? 'success'
                    : 'error',
            lastResultAt: options.activationProbe || skippedRequeue
                ? SyncService.syncStatus.lastResultAt
                : new Date().toISOString(),
        });

        if (!SyncService.syncOrchestrator.getState().queued) {
            SyncService.queuedSyncOptions = null;
        }

        return result;
    }
}

export const __syncServiceTestUtils = {
    setDependenciesForTests(overrides: Partial<SyncServiceDependencies>) {
        syncServiceDependencies = {
            ...syncServiceDependencies,
            ...overrides,
        };
    },
    resetDependenciesForTests() {
        syncServiceDependencies = {
            ...defaultSyncServiceDependencies,
        };
        lastObservedPersistedDataForSync = null;
        lastReportedDropboxStatusFailure = null;
    },
    async persistLocalDataForTests(data: AppData) {
        await persistLocalDataForSync(data);
    },
    runSyncRestoreExclusiveForTests<T>(operation: () => Promise<T>) {
        return runSyncRestoreExclusive(operation);
    },
    runSyncDocumentExclusiveForTests<T>(operation: () => Promise<T>) {
        return runSyncDocumentExclusive(operation);
    },
    clearWebdavDownloadBackoff() {
        clearAttachmentSyncState();
    },
    clearAttachmentValidationFailures() {
        clearAttachmentValidationFailures();
    },
    simulateAttachmentValidationFailure(attachment: Attachment, error?: string) {
        return handleAttachmentValidationFailure(attachment, error);
    },
    getAttachmentValidationFailureAttempts(attachmentId: string) {
        return getAttachmentValidationFailureAttempts(attachmentId);
    },
    resolveDropboxCleanupTokenForTests(
        clientId: string,
        credentialHandle: string,
        forceRefresh = false,
    ) {
        return getAttachmentCleanupDeps(credentialHandle).getDropboxAccessToken(clientId, { forceRefresh });
    },
};
