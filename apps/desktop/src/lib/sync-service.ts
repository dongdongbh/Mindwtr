
import {
    AppData,
    Attachment,
    useTaskStore,
    MergeStats,
    webdavGetJson,
    webdavPutJson,
    cloudGetJson,
    cloudPutJson,
    flushPendingSave,
    performSyncCycle,
    mergeAppData,
    normalizeAppData,
    normalizeWebdavUrl,
    normalizeCloudUrl,
    sanitizeAppDataForRemote,
    areSyncPayloadsEqual,
    assertNoPendingAttachmentUploads,
    findPendingAttachmentUploads,
    injectExternalCalendars as injectExternalCalendarsForSync,
    persistExternalCalendars as persistExternalCalendarsForSync,
    withRetry,
    isRetryableWebdavReadError,
    isWebdavInvalidJsonError,
    CLOCK_SKEW_THRESHOLD_MS,
    appendSyncHistory,
    cloneAppData,
    formatSyncErrorMessage,
    LocalSyncAbort,
    getInMemoryAppDataSnapshot,
    shouldRunAttachmentCleanup,
    createAbortableFetch,
    type CloudProvider,
} from '@mindwtr/core';
import { isTauriRuntime } from './runtime';
import { reportError } from './report-error';
import { logInfo, logSyncError, logWarn, sanitizeLogMessage } from './app-log';
import { useUiStore } from '../store/ui-store';
import { markLocalWrite } from './local-data-watcher';
import { ExternalCalendarService } from './external-calendar-service';
import { webStorage } from './storage-adapter-web';
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
import type { SyncBackend } from './sync-service-utils';
import {
    downloadDropboxAppData,
    DropboxConflictError,
    DropboxUnauthorizedError,
    testDropboxAccess,
    uploadDropboxAppData,
} from './dropbox-sync';
import {
    CLOUD_TOKEN_KEY,
    CLOUD_URL_KEY,
    SYNC_BACKEND_KEY,
    WEBDAV_PASSWORD_KEY,
    WEBDAV_URL_KEY,
    WEBDAV_USERNAME_KEY,
    getCloudConfigLocal,
    getSyncBackendLocal,
    getWebDavConfigLocal,
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

const SYNC_FILE_NAME = 'data.json';
const LEGACY_SYNC_FILE_NAME = 'mindwtr-sync.json';
const DROPBOX_AUTH_RETRY_LIMIT = 1;
const WEBDAV_READ_RETRY_OPTIONS = {
    maxAttempts: 5,
    baseDelayMs: 2000,
    maxDelayMs: 30_000,
    shouldRetry: isRetryableWebdavReadError,
};
const ATTACHMENT_WARNING_TOAST_THRESHOLD = 2;
const ATTACHMENT_WARNING_TOAST_COOLDOWN_MS = 10 * 60 * 1000;
const ATTACHMENT_WARNING_TOAST_MESSAGE = 'Attachment sync is still failing. Files will retry in the background.';
type SyncServiceDependencies = {
    isTauriRuntime: () => boolean;
    invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
    getTauriFetch: () => Promise<typeof fetch | undefined>;
    getStoreState: typeof useTaskStore.getState;
    flushPendingSave: typeof flushPendingSave;
    performSyncCycle: typeof performSyncCycle;
    getInMemoryAppDataSnapshot: typeof getInMemoryAppDataSnapshot;
    markLocalWrite: typeof markLocalWrite;
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

const defaultInvoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    const mod = await import('@tauri-apps/api/core');
    return mod.invoke<T>(command as any, args as any);
};

const defaultGetTauriFetch = async (): Promise<typeof fetch | undefined> => {
    if (!syncServiceDependencies.isTauriRuntime()) return undefined;
    try {
        const mod = await import('@tauri-apps/plugin-http');
        return mod.fetch;
    } catch (error) {
        logSyncWarning('Failed to load tauri http fetch', error);
        return undefined;
    }
};

const defaultSyncServiceDependencies: SyncServiceDependencies = {
    isTauriRuntime,
    invoke: defaultInvoke,
    getTauriFetch: defaultGetTauriFetch,
    getStoreState: useTaskStore.getState,
    flushPendingSave,
    performSyncCycle,
    getInMemoryAppDataSnapshot,
    markLocalWrite,
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

const logSyncWarning = (message: string, error?: unknown) => {
    const extra = error
        ? { error: syncServiceDependencies.sanitizeLogMessage(error instanceof Error ? error.message : String(error)) }
        : undefined;
    void syncServiceDependencies.logWarn(message, { scope: 'sync', extra });
};

const logSyncInfo = (message: string, extra?: Record<string, string>) => {
    void syncServiceDependencies.logInfo(message, { scope: 'sync', extra });
};

const buildConflictDiagnosticsLogExtra = (stats: MergeStats): Record<string, string> => {
    const reasonCountsByEntity = Object.fromEntries(
        Object.entries({
            tasks: stats.tasks.conflictReasonCounts ?? {},
            projects: stats.projects.conflictReasonCounts ?? {},
            sections: stats.sections.conflictReasonCounts ?? {},
            areas: stats.areas.conflictReasonCounts ?? {},
        }).filter(([, counts]) => Object.keys(counts).length > 0)
    );
    const conflictSamples = [
        ...(stats.tasks.conflictSamples ?? []).map((sample) => ({ entity: 'task', ...sample })),
        ...(stats.projects.conflictSamples ?? []).map((sample) => ({ entity: 'project', ...sample })),
        ...(stats.sections.conflictSamples ?? []).map((sample) => ({ entity: 'section', ...sample })),
        ...(stats.areas.conflictSamples ?? []).map((sample) => ({ entity: 'area', ...sample })),
    ].slice(0, 6);
    const extra: Record<string, string> = {};
    if (Object.keys(reasonCountsByEntity).length > 0) {
        extra.conflictReasonCounts = JSON.stringify(reasonCountsByEntity);
    }
    if (conflictSamples.length > 0) {
        extra.conflictSamples = JSON.stringify(conflictSamples);
    }
    return extra;
};

const externalCalendarProvider = {
    load: () => syncServiceDependencies.getExternalCalendars(),
    save: (calendars: AppData['settings']['externalCalendars'] | undefined) =>
        syncServiceDependencies.setExternalCalendars(calendars ?? []),
    onWarn: (message: string, error?: unknown) => logSyncWarning(message, error),
};

const injectExternalCalendars = async (data: AppData): Promise<AppData> =>
    injectExternalCalendarsForSync(data, externalCalendarProvider);

const persistExternalCalendars = async (data: AppData): Promise<void> =>
    persistExternalCalendarsForSync(data, externalCalendarProvider);

// Sync should start from persisted data so startup sync cannot overwrite settings with an unhydrated store snapshot.
const readLocalDataForSync = async (): Promise<AppData> => {
    if (isTauriRuntimeEnv()) {
        try {
            const persisted = await tauriInvoke<AppData>('get_data');
            return normalizeAppData(persisted);
        } catch (error) {
            logSyncWarning('Failed to read persisted local data for sync; using in-memory snapshot', error);
        }
    } else {
        const persisted = await webStorage.getData();
        return normalizeAppData(persisted);
    }

    const state = getStoreState();
    return normalizeAppData({
        tasks: [...state._allTasks],
        projects: [...state._allProjects],
        sections: [...state._allSections],
        areas: [...state._allAreas],
        settings: state.settings ?? {},
    });
};

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    return syncServiceDependencies.invoke<T>(command, args);
}

async function persistLocalDataForSync(data: AppData): Promise<void> {
    syncServiceDependencies.markLocalWrite(data);
    await tauriInvoke('save_data', { data });
}

const DROPBOX_REDIRECT_URI_FALLBACK = 'http://127.0.0.1:53682/oauth/dropbox/callback';
const DROPBOX_TEST_TIMEOUT_MS = 15_000;

const withTimeout = async <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        if (timer) clearTimeout(timer);
    }
};

async function getTauriFetch(): Promise<typeof fetch | undefined> {
    return syncServiceDependencies.getTauriFetch();
}

async function resolveWebdavPassword(config: WebDavConfig): Promise<string> {
    if (typeof config.password === 'string') return config.password;
    if (config.hasPassword === false) return '';
    if (!isTauriRuntimeEnv()) return '';
    try {
        return await tauriInvoke<string>('get_webdav_password');
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

const getAttachmentCleanupDeps = (): AttachmentCleanupDeps => ({
    getCloudConfig: () => SyncService.getCloudConfig(),
    getCloudProvider: () => SyncService.getCloudProvider(),
    getDropboxAccessToken: (clientId, options) => SyncService.getDropboxAccessToken(clientId, options),
    getDropboxAppKey: () => SyncService.getDropboxAppKey(),
    getSyncPath: () => SyncService.getSyncPath(),
    getTauriFetch,
    getWebDavConfig: () => SyncService.getWebDavConfig(),
    isTauriRuntimeEnv,
    logSyncInfo,
    logSyncWarning,
    resolveWebdavPassword,
});

const getSyncConfigDeps = () => ({
    isTauriRuntimeEnv,
    maybeMigrateLegacyLocalStorageToConfig: () => SyncService.maybeMigrateLegacyLocalStorageToConfig(),
    reportError: syncServiceDependencies.reportError,
    startFileWatcher: () => SyncService.startFileWatcher(),
    tauriInvoke,
});

type SyncRunResult = {
    success: boolean;
    stats?: MergeStats;
    error?: string;
    skipped?: 'requeued';
};

type SyncRunOptions = {
    backendOverride?: SyncBackend;
};

type SyncExecutionContext = {
    backend: SyncBackend;
    step: string;
    syncUrl?: string;
    localSnapshotChangeAt: number;
    networkWentOffline: boolean;
    removeNetworkListener: (() => void) | null;
    requestAbortController: AbortController;
    preSyncedLocalData: AppData | null;
    wroteLocal: boolean;
    remoteDataForCompare: AppData | null;
    webdavRemoteCorrupted: boolean;
    webdavConfig: WebDavConfig | null;
    cloudProvider: CloudProvider;
    cloudConfig: CloudConfig | null;
    dropboxAppKey: string;
    dropboxDataRev: string | null;
    cachedDropboxAccessToken: string | null;
    syncPath: string;
    fileBaseDir: string;
    hadAttachmentWarning: boolean;
};

type SyncExecutionHelpers = {
    setStep: (next: string) => void;
    createFetchWithAbort: (baseFetch: typeof fetch) => typeof fetch;
    ensureNetworkStillAvailable: () => void;
    ensureLocalSnapshotFresh: () => void;
    persistLocalDataWithTracking: (data: AppData) => Promise<void>;
    resolveDropboxAccessToken: (forceRefresh?: boolean) => Promise<string>;
    runDropboxWithRetry: <T>(operation: (token: string) => Promise<T>) => Promise<T>;
};

export class SyncService {
    private static didMigrate = false;
    private static syncInFlight: Promise<SyncRunResult> | null = null;
    private static syncQueued = false;
    private static syncQueueVersion = 0;
    private static syncStatus: {
        inFlight: boolean;
        queued: boolean;
        step: string | null;
        lastResult: 'success' | 'error' | null;
        lastResultAt: string | null;
    } = {
        inFlight: false,
        queued: false,
        step: null,
        lastResult: null,
        lastResultAt: null,
    };
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

    private static requestQueuedSyncRun() {
        SyncService.syncQueued = true;
        SyncService.syncQueueVersion += 1;
        SyncService.updateSyncStatus({ queued: true });
    }

    static getSyncStatus() {
        return SyncService.syncStatus;
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
        await SyncService.stopFileWatcher();
        SyncService.didMigrate = false;
        SyncService.syncInFlight = null;
        SyncService.syncQueued = false;
        SyncService.syncQueueVersion = 0;
        SyncService.syncStatus = {
            inFlight: false,
            queued: false,
            step: null,
            lastResult: null,
            lastResultAt: null,
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
        clearAttachmentSyncState();
        clearAttachmentValidationFailures();
    }

    private static finalizeAttachmentWarningState(context: Pick<SyncExecutionContext, 'hadAttachmentWarning'>, result: Pick<SyncRunResult, 'success'>) {
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
                useUiStore.getState().showToast(ATTACHMENT_WARNING_TOAST_MESSAGE, 'error', 6000);
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
        SyncService.syncListeners.forEach((listener) => listener(SyncService.syncStatus));
    }

    static async maybeMigrateLegacyLocalStorageToConfig() {
        if (!isTauriRuntimeEnv() || SyncService.didMigrate) return;
        SyncService.didMigrate = true;

        const legacyBackend = getSyncBackendLocal();
        const legacyWebdav = getWebDavConfigLocal();
        const legacyCloud = getCloudConfigLocal();
        const hasLegacyBackend = legacyBackend === 'webdav' || legacyBackend === 'cloud';
        const hasLegacyWebdav = Boolean(legacyWebdav.url);
        const hasLegacyCloud = Boolean(legacyCloud.url || legacyCloud.token);
        if (!hasLegacyBackend && !hasLegacyWebdav && !hasLegacyCloud) return;

        try {
            const [currentBackend, currentWebdav, currentCloud] = await Promise.all([
                tauriInvoke<string>('get_sync_backend'),
                tauriInvoke<WebDavConfig>('get_webdav_config'),
                tauriInvoke<CloudConfig>('get_cloud_config'),
            ]);

            let migrated = false;
            if (hasLegacyBackend && normalizeSyncBackend(currentBackend) === 'file') {
                await tauriInvoke('set_sync_backend', { backend: legacyBackend });
                migrated = true;
            }

            if (hasLegacyWebdav && !currentWebdav.url) {
                await tauriInvoke('set_webdav_config', legacyWebdav);
                migrated = true;
            }

            if (hasLegacyCloud && !currentCloud.url && !currentCloud.token) {
                await tauriInvoke('set_cloud_config', { url: legacyCloud.url, token: legacyCloud.token });
                migrated = true;
            }

            if (migrated) {
                localStorage.removeItem(SYNC_BACKEND_KEY);
                localStorage.removeItem(WEBDAV_URL_KEY);
                localStorage.removeItem(WEBDAV_USERNAME_KEY);
                localStorage.removeItem(WEBDAV_PASSWORD_KEY);
                localStorage.removeItem(CLOUD_URL_KEY);
                localStorage.removeItem(CLOUD_TOKEN_KEY);
                sessionStorage.removeItem(WEBDAV_PASSWORD_KEY);
                sessionStorage.removeItem(CLOUD_TOKEN_KEY);
            }
        } catch (error) {
            syncServiceDependencies.reportError('Failed to migrate legacy sync config', error);
        }
    }

    static async getSyncBackend(): Promise<SyncBackend> {
        return readSyncBackend(getSyncConfigDeps());
    }

    static async setSyncBackend(backend: SyncBackend): Promise<void> {
        return writeSyncBackend(backend, getSyncConfigDeps());
    }

    static async getWebDavConfig(options?: { silent?: boolean }): Promise<WebDavConfig> {
        return readWebDavConfig(getSyncConfigDeps(), options);
    }

    static async setWebDavConfig(config: { url: string; username?: string; password?: string }): Promise<void> {
        return writeWebDavConfig(config, getSyncConfigDeps());
    }

    static async testWebDavConnection(config: { url: string; username?: string; password?: string; hasPassword?: boolean }): Promise<void> {
        const normalizedUrl = normalizeWebdavUrl(config.url.trim());
        if (!normalizedUrl) {
            throw new Error('WebDAV URL not configured');
        }
        const fetcher = await getTauriFetch();
        const password = await resolveWebdavPassword({
            url: config.url,
            username: config.username || '',
            password: config.password,
            hasPassword: config.hasPassword,
        });
        await webdavGetJson<unknown>(normalizedUrl, {
            username: config.username?.trim(),
            password,
            timeoutMs: 10_000,
            fetcher: fetcher ?? fetch,
        });
    }

    static async getCloudConfig(options?: { silent?: boolean }): Promise<CloudConfig> {
        return readCloudConfig(getSyncConfigDeps(), options);
    }

    static async setCloudConfig(config: { url: string; token?: string }): Promise<void> {
        return writeCloudConfig(config, getSyncConfigDeps());
    }

    static async getCloudProvider(): Promise<CloudProvider> {
        return readCloudProvider();
    }

    static async setCloudProvider(provider: CloudProvider): Promise<void> {
        return writeCloudProvider(provider);
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
            return await tauriInvoke<string>('get_dropbox_redirect_uri');
        } catch {
            return DROPBOX_REDIRECT_URI_FALLBACK;
        }
    }

    static async isDropboxConnected(clientId: string): Promise<boolean> {
        const normalized = clientId.trim();
        if (!normalized) return false;
        if (!isTauriRuntimeEnv()) return false;
        try {
            return await tauriInvoke<boolean>('is_dropbox_connected', { clientId: normalized });
        } catch (error) {
            syncServiceDependencies.reportError('Failed to check Dropbox connection status', error);
            return false;
        }
    }

    static async connectDropbox(clientId: string): Promise<void> {
        const normalized = clientId.trim();
        if (!normalized) {
            throw new Error('Dropbox app key is required');
        }
        if (!isTauriRuntimeEnv()) {
            throw new Error('Dropbox sync is only available in the desktop app.');
        }
        await tauriInvoke('connect_dropbox', { clientId: normalized });
    }

    static async disconnectDropbox(clientId: string): Promise<void> {
        const normalized = clientId.trim();
        if (!normalized) {
            throw new Error('Dropbox app key is required');
        }
        if (!isTauriRuntimeEnv()) {
            throw new Error('Dropbox sync is only available in the desktop app.');
        }
        await tauriInvoke('disconnect_dropbox', { clientId: normalized });
    }

    static async getDropboxAccessToken(clientId: string, options?: { forceRefresh?: boolean }): Promise<string> {
        const normalized = clientId.trim();
        if (!normalized) {
            throw new Error('Dropbox app key is required');
        }
        if (!isTauriRuntimeEnv()) {
            throw new Error('Dropbox sync is only available in the desktop app.');
        }
        return await tauriInvoke<string>('get_dropbox_access_token', {
            clientId: normalized,
            forceRefresh: options?.forceRefresh === true,
        });
    }

    static async testDropboxConnection(clientId: string): Promise<void> {
        const normalized = clientId.trim();
        if (!normalized) {
            throw new Error('Dropbox app key is required');
        }
        const fetcher = await getTauriFetch();
        const runTest = async (forceRefresh: boolean) => {
            const accessToken = await SyncService.getDropboxAccessToken(normalized, { forceRefresh });
            await withTimeout(
                testDropboxAccess(accessToken, fetcher ?? fetch),
                DROPBOX_TEST_TIMEOUT_MS,
                'Dropbox connection test timed out. Please try again.'
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

    private static async runDropboxWithRetry<T>(
        resolveAccessToken: (forceRefresh?: boolean) => Promise<string>,
        operation: (token: string) => Promise<T>
    ): Promise<T> {
        let forceRefresh = false;
        let unauthorizedRetries = 0;
        while (true) {
            try {
                const token = await resolveAccessToken(forceRefresh);
                return await operation(token);
            } catch (error) {
                if (!(error instanceof DropboxUnauthorizedError) || unauthorizedRetries >= DROPBOX_AUTH_RETRY_LIMIT) {
                    throw error;
                }
                unauthorizedRetries += 1;
                forceRefresh = true;
            }
        }
    }

    private static async persistSuccessfulSyncStatus(
        syncStatus: NonNullable<AppData['settings']['lastSyncStatus']>,
        now: string,
        lastSyncHistory?: ReturnType<typeof appendSyncHistory>
    ): Promise<boolean> {
        const state = getStoreState();
        try {
            await state.updateSettings({
                lastSyncAt: now,
                lastSyncStatus: syncStatus,
                lastSyncError: undefined,
                ...(lastSyncHistory ? { lastSyncHistory } : {}),
            });
            SyncService.lastSuccessfulSyncLocalChangeAt = state.lastDataChangeAt;
            return true;
        } catch (error) {
            logSyncWarning('Failed to persist sync status', error);
            return false;
        }
    }

    private static createSyncExecutionContext(): SyncExecutionContext {
        return {
            backend: 'off',
            step: 'init',
            syncUrl: undefined,
            localSnapshotChangeAt: 0,
            networkWentOffline: false,
            removeNetworkListener: null,
            requestAbortController: new AbortController(),
            preSyncedLocalData: null,
            wroteLocal: false,
            remoteDataForCompare: null,
            webdavRemoteCorrupted: false,
            webdavConfig: null,
            cloudProvider: 'selfhosted',
            cloudConfig: null,
            dropboxAppKey: '',
            dropboxDataRev: null,
            cachedDropboxAccessToken: null,
            syncPath: '',
            fileBaseDir: '',
            hadAttachmentWarning: false,
        };
    }

    private static async persistPreSyncedLocalDataIfNeeded(
        context: SyncExecutionContext,
        persistLocalDataWithTracking: (data: AppData) => Promise<void>
    ): Promise<void> {
        if (!context.preSyncedLocalData || context.wroteLocal) return;
        const inMemorySnapshot = syncServiceDependencies.getInMemoryAppDataSnapshot();
        const reconciledData = mergeAppData(context.preSyncedLocalData, inMemorySnapshot);
        await persistLocalDataWithTracking(reconciledData);
    }

    private static async readLocalDataForSyncCycle(context: SyncExecutionContext): Promise<AppData> {
        const inMemorySnapshot = syncServiceDependencies.getInMemoryAppDataSnapshot();
        const baseData = context.preSyncedLocalData
            ? mergeAppData(context.preSyncedLocalData, inMemorySnapshot)
            : mergeAppData(await readLocalDataForSync(), inMemorySnapshot);
        const data = await injectExternalCalendars(baseData);
        context.localSnapshotChangeAt = getStoreState().lastDataChangeAt;
        return data;
    }

    private static async prepareSyncExecutionContext(
        context: SyncExecutionContext,
        options: SyncRunOptions,
        helpers: Pick<SyncExecutionHelpers, 'setStep'>
    ): Promise<void> {
        context.backend = options.backendOverride ?? await SyncService.getSyncBackend();
        if (context.backend === 'off') {
            return;
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
            helpers.setStep('snapshot');
            await yieldToRenderer();
            try {
                await tauriInvoke<string>('create_data_snapshot');
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

        context.webdavConfig = context.backend === 'webdav' ? await SyncService.getWebDavConfig() : null;
        context.cloudProvider = context.backend === 'cloud' ? await SyncService.getCloudProvider() : 'selfhosted';
        context.cloudConfig = context.backend === 'cloud' && context.cloudProvider === 'selfhosted'
            ? await SyncService.getCloudConfig()
            : null;
        context.dropboxAppKey = context.backend === 'cloud' && context.cloudProvider === 'dropbox'
            ? (await SyncService.getDropboxAppKey()).trim()
            : '';
        if (context.backend === 'cloud' && context.cloudProvider === 'dropbox' && !context.dropboxAppKey) {
            throw new Error('Dropbox app key is not configured');
        }
        context.syncPath = context.backend === 'file' ? await SyncService.getSyncPath() : '';
        context.fileBaseDir = context.backend === 'file'
            ? getFileSyncDir(context.syncPath, SYNC_FILE_NAME, LEGACY_SYNC_FILE_NAME)
            : '';
    }

    private static async runPreSyncAttachmentPhase(
        context: SyncExecutionContext,
        helpers: Pick<
            SyncExecutionHelpers,
            'setStep' | 'ensureNetworkStillAvailable' | 'ensureLocalSnapshotFresh' | 'resolveDropboxAccessToken'
        >
    ): Promise<void> {
        if (!isTauriRuntimeEnv() || (context.backend !== 'webdav' && context.backend !== 'file' && context.backend !== 'cloud')) {
            return;
        }

        helpers.setStep('attachments_prepare');
        await yieldToRenderer();
        try {
            const localData = await readLocalDataForSync();
            let preMutated = false;
            if (context.backend === 'webdav' && context.webdavConfig?.url) {
                helpers.ensureNetworkStillAvailable();
                const baseUrl = getBaseSyncUrl(context.webdavConfig.url);
                const syncedData = await syncAttachments(localData, context.webdavConfig, baseUrl, attachmentBackendDeps);
                preMutated = syncedData !== null;
                if (syncedData) {
                    context.preSyncedLocalData = syncedData;
                }
            } else if (context.backend === 'file' && context.fileBaseDir) {
                preMutated = await syncFileAttachments(localData, context.fileBaseDir, attachmentBackendDeps);
            } else if (context.backend === 'cloud' && context.cloudProvider === 'selfhosted' && context.cloudConfig?.url) {
                helpers.ensureNetworkStillAvailable();
                const baseUrl = getCloudBaseUrl(context.cloudConfig.url);
                preMutated = await syncCloudAttachments(localData, context.cloudConfig, baseUrl, attachmentBackendDeps);
            } else if (context.backend === 'cloud' && context.cloudProvider === 'dropbox') {
                helpers.ensureNetworkStillAvailable();
                preMutated = await syncDropboxAttachments(localData, helpers.resolveDropboxAccessToken, attachmentBackendDeps);
            }

            if (preMutated) {
                context.preSyncedLocalData = context.preSyncedLocalData ?? localData;
                helpers.ensureLocalSnapshotFresh();
            }
        } catch (error) {
            if (error instanceof LocalSyncAbort) {
                throw error;
            }
            context.hadAttachmentWarning = true;
            logSyncWarning('Attachment pre-sync warning', error);
        }
    }

    private static async readRemoteDataByBackend(
        context: SyncExecutionContext,
        helpers: Pick<SyncExecutionHelpers, 'createFetchWithAbort' | 'ensureNetworkStillAvailable' | 'runDropboxWithRetry'>
    ): Promise<AppData | null> {
        helpers.ensureNetworkStillAvailable();
        if (context.backend === 'cloudkit') {
            const data = await syncServiceDependencies.readRemoteCloudKit();
            context.remoteDataForCompare = data ?? null;
            return data;
        }
        if (context.backend === 'webdav') {
            try {
                if (isTauriRuntimeEnv()) {
                    if (!context.webdavConfig?.url) {
                        throw new Error('WebDAV URL not configured');
                    }
                    context.syncUrl = context.webdavConfig.url;
                    const data = await withRetry(
                        () => tauriInvoke<AppData>('webdav_get_json'),
                        WEBDAV_READ_RETRY_OPTIONS,
                    );
                    context.webdavRemoteCorrupted = false;
                    context.remoteDataForCompare = data ?? null;
                    return data;
                }
                if (!context.webdavConfig?.url) {
                    throw new Error('WebDAV URL not configured');
                }
                const webdavConfig = context.webdavConfig;
                const normalizedUrl = normalizeWebdavUrl(webdavConfig.url);
                context.syncUrl = normalizedUrl;
                const fetcher = helpers.createFetchWithAbort((await getTauriFetch()) ?? fetch);
                const data = await withRetry(
                    () => webdavGetJson<AppData>(normalizedUrl, {
                        username: webdavConfig.username,
                        password: webdavConfig.password || '',
                        fetcher,
                    }),
                    WEBDAV_READ_RETRY_OPTIONS,
                );
                context.webdavRemoteCorrupted = false;
                context.remoteDataForCompare = data ?? null;
                return data;
            } catch (error) {
                if (isWebdavInvalidJsonError(error)) {
                    context.webdavRemoteCorrupted = true;
                    context.remoteDataForCompare = null;
                    logSyncWarning('WebDAV remote data.json appears corrupted; treating as missing for repair write', error);
                    return null;
                }
                throw error;
            }
        }
        if (context.backend === 'cloud') {
            if (context.cloudProvider === 'selfhosted') {
                if (!context.cloudConfig?.url) {
                    throw new Error('Self-hosted URL not configured');
                }
                const normalizedUrl = normalizeCloudUrl(context.cloudConfig.url);
                context.syncUrl = normalizedUrl;
                const fetcher = helpers.createFetchWithAbort((await getTauriFetch()) ?? fetch);
                const data = await cloudGetJson<AppData>(normalizedUrl, {
                    token: context.cloudConfig.token,
                    fetcher,
                });
                context.remoteDataForCompare = data ?? null;
                return data;
            }
            if (!context.dropboxAppKey) {
                throw new Error('Dropbox app key is not configured');
            }
            context.syncUrl = 'dropbox:///Apps/Mindwtr/data.json';
            const fetcher = helpers.createFetchWithAbort((await getTauriFetch()) ?? fetch);
            const remote = await helpers.runDropboxWithRetry((token) =>
                downloadDropboxAppData(token, fetcher)
            );
            context.dropboxDataRev = remote.rev;
            context.remoteDataForCompare = remote.data ?? null;
            return remote.data;
        }
        if (!isTauriRuntimeEnv()) {
            throw new Error('File sync is not available in the web app.');
        }
        const data = await tauriInvoke<AppData>('read_sync_file');
        context.remoteDataForCompare = data ?? null;
        return data;
    }

    private static async prepareRemoteWriteData(
        context: SyncExecutionContext,
        data: AppData,
        helpers: Pick<
            SyncExecutionHelpers,
            'setStep' | 'ensureNetworkStillAvailable' | 'resolveDropboxAccessToken'
        >
    ): Promise<AppData> {
        if (findPendingAttachmentUploads(data).length === 0) {
            return data;
        }

        helpers.setStep('attachments_finalize');
        await yieldToRenderer();

        if (context.backend === 'webdav' && context.webdavConfig?.url) {
            helpers.ensureNetworkStillAvailable();
            const baseUrl = getBaseSyncUrl(context.webdavConfig.url);
            const syncedData = await syncAttachments(data, context.webdavConfig, baseUrl, attachmentBackendDeps);
            return syncedData ?? data;
        }

        if (context.backend === 'file' && context.fileBaseDir) {
            await syncFileAttachments(data, context.fileBaseDir, attachmentBackendDeps);
            return data;
        }

        if (context.backend === 'cloud' && context.cloudProvider === 'selfhosted' && context.cloudConfig?.url) {
            helpers.ensureNetworkStillAvailable();
            const baseUrl = getCloudBaseUrl(context.cloudConfig.url);
            await syncCloudAttachments(data, context.cloudConfig, baseUrl, attachmentBackendDeps);
            return data;
        }

        if (context.backend === 'cloud' && context.cloudProvider === 'dropbox') {
            helpers.ensureNetworkStillAvailable();
            await syncDropboxAttachments(data, helpers.resolveDropboxAccessToken, attachmentBackendDeps);
        }

        return data;
    }

    private static async writeRemoteDataByBackend(
        context: SyncExecutionContext,
        data: AppData,
        helpers: Pick<SyncExecutionHelpers, 'createFetchWithAbort' | 'ensureNetworkStillAvailable' | 'runDropboxWithRetry'>
    ): Promise<void> {
        helpers.ensureNetworkStillAvailable();
        if (context.backend === 'cloudkit') {
            const sanitized = sanitizeAppDataForRemote(data);
            const remoteSanitized = context.remoteDataForCompare
                ? sanitizeAppDataForRemote(context.remoteDataForCompare)
                : null;
            if (remoteSanitized && areSyncPayloadsEqual(remoteSanitized, sanitized)) {
                return;
            }
            await syncServiceDependencies.writeRemoteCloudKit(sanitized as AppData);
            context.remoteDataForCompare = sanitized;
            return;
        }

        assertNoPendingAttachmentUploads(data);
        const sanitized = sanitizeAppDataForRemote(data);
        const remoteSanitized = context.remoteDataForCompare
            ? sanitizeAppDataForRemote(context.remoteDataForCompare)
            : null;
        if (remoteSanitized && areSyncPayloadsEqual(remoteSanitized, sanitized)) {
            return;
        }

        if (context.backend === 'webdav') {
            if (isTauriRuntimeEnv()) {
                if (context.webdavRemoteCorrupted) {
                    logSyncInfo('Repairing corrupted WebDAV data.json with current merged data');
                }
                await tauriInvoke('webdav_put_json', { data: sanitized });
                context.remoteDataForCompare = sanitized;
                context.webdavRemoteCorrupted = false;
                return;
            }
            const { url, username, password } = await SyncService.getWebDavConfig();
            const normalizedUrl = normalizeWebdavUrl(url);
            const fetcher = helpers.createFetchWithAbort((await getTauriFetch()) ?? fetch);
            if (context.webdavRemoteCorrupted) {
                logSyncInfo('Repairing corrupted WebDAV data.json with current merged data');
            }
            await webdavPutJson(normalizedUrl, sanitized, { username, password: password || '', fetcher });
            context.remoteDataForCompare = sanitized;
            context.webdavRemoteCorrupted = false;
            return;
        }

        if (context.backend === 'cloud') {
            if (context.cloudProvider === 'selfhosted') {
                const { url, token } = context.cloudConfig ?? await SyncService.getCloudConfig();
                const normalizedUrl = normalizeCloudUrl(url);
                const fetcher = helpers.createFetchWithAbort((await getTauriFetch()) ?? fetch);
                await cloudPutJson(normalizedUrl, sanitized, { token, fetcher });
                context.remoteDataForCompare = sanitized;
                return;
            }
            if (!context.dropboxAppKey) {
                throw new Error('Dropbox app key is not configured');
            }
            const fetcher = helpers.createFetchWithAbort((await getTauriFetch()) ?? fetch);
            try {
                const uploaded = await helpers.runDropboxWithRetry((token) =>
                    uploadDropboxAppData(token, sanitized, context.dropboxDataRev, fetcher)
                );
                context.dropboxDataRev = uploaded.rev;
                context.remoteDataForCompare = sanitized;
                return;
            } catch (error) {
                if (error instanceof DropboxConflictError) {
                    throw new Error('Dropbox changed during sync. Please run Sync again.');
                }
                throw error;
            }
        }

        await SyncService.markSyncWrite(sanitized);
        await tauriInvoke('write_sync_file', { data: sanitized });
        context.remoteDataForCompare = sanitized;
    }

    private static logSyncMergeSummary(stats: MergeStats): void {
        const conflictCount = (stats.tasks.conflicts || 0)
            + (stats.projects.conflicts || 0)
            + (stats.sections.conflicts || 0)
            + (stats.areas.conflicts || 0);
        const maxClockSkewMs = Math.max(
            stats.tasks.maxClockSkewMs || 0,
            stats.projects.maxClockSkewMs || 0,
            stats.sections.maxClockSkewMs || 0,
            stats.areas.maxClockSkewMs || 0
        );
        const timestampAdjustments = (stats.tasks.timestampAdjustments || 0)
            + (stats.projects.timestampAdjustments || 0)
            + (stats.sections.timestampAdjustments || 0)
            + (stats.areas.timestampAdjustments || 0);
        if (!isTauriRuntimeEnv() || (conflictCount === 0 && maxClockSkewMs <= CLOCK_SKEW_THRESHOLD_MS && timestampAdjustments === 0)) {
            return;
        }

        const conflictIds = [
            ...(stats.tasks.conflictIds || []),
            ...(stats.projects.conflictIds || []),
            ...(stats.sections.conflictIds || []),
            ...(stats.areas.conflictIds || []),
        ].slice(0, 6);
        void syncServiceDependencies.logInfo(
            `Sync merge summary: ${conflictCount} conflicts, max skew ${Math.round(maxClockSkewMs)}ms, ${timestampAdjustments} timestamp fixes.`,
            {
                scope: 'sync',
                extra: {
                    conflicts: String(conflictCount),
                    maxClockSkewMs: String(Math.round(maxClockSkewMs)),
                    timestampFixes: String(timestampAdjustments),
                    conflictIds: conflictIds.join(','),
                    ...buildConflictDiagnosticsLogExtra(stats),
                },
            }
        );
    }

    private static async runPostMergeAttachmentPhase(
        context: SyncExecutionContext,
        mergedData: AppData,
        helpers: Pick<
            SyncExecutionHelpers,
            'setStep' | 'ensureNetworkStillAvailable' | 'ensureLocalSnapshotFresh' | 'persistLocalDataWithTracking' | 'resolveDropboxAccessToken'
        >
    ): Promise<AppData> {
        if (!isTauriRuntimeEnv() || (context.backend !== 'webdav' && context.backend !== 'file' && context.backend !== 'cloud')) {
            return mergedData;
        }

        helpers.setStep('attachments');
        await yieldToRenderer();
        try {
            let nextMergedData = mergedData;
            const applyAttachmentSyncMutation = async (
                syncAttachmentsOp: (candidateData: AppData) => Promise<AppData | boolean | null>
            ): Promise<void> => {
                const candidateData = cloneAppData(nextMergedData);
                const mutationResult = await syncAttachmentsOp(candidateData);
                const nextData = mutationResult && typeof mutationResult === 'object'
                    ? mutationResult
                    : mutationResult
                        ? candidateData
                        : null;
                if (!nextData) return;
                helpers.ensureLocalSnapshotFresh();
                nextMergedData = nextData;
                await helpers.persistLocalDataWithTracking(nextMergedData);
                await yieldToRenderer();
            };

            helpers.ensureLocalSnapshotFresh();
            if (context.backend === 'webdav') {
                helpers.ensureNetworkStillAvailable();
                const config = context.webdavConfig ?? await SyncService.getWebDavConfig();
                const baseUrl = config.url ? getBaseSyncUrl(config.url) : '';
                if (baseUrl) {
                    await applyAttachmentSyncMutation((candidateData) =>
                        syncAttachments(candidateData, config, baseUrl, attachmentBackendDeps)
                    );
                }
            } else if (context.backend === 'file') {
                if (context.fileBaseDir) {
                    await applyAttachmentSyncMutation((candidateData) =>
                        syncFileAttachments(candidateData, context.fileBaseDir, attachmentBackendDeps)
                    );
                }
            } else if (context.backend === 'cloud') {
                helpers.ensureNetworkStillAvailable();
                if (context.cloudProvider === 'selfhosted') {
                    const config = context.cloudConfig ?? await SyncService.getCloudConfig();
                    const baseUrl = config.url ? getCloudBaseUrl(config.url) : '';
                    if (baseUrl) {
                        await applyAttachmentSyncMutation((candidateData) =>
                            syncCloudAttachments(candidateData, config, baseUrl, attachmentBackendDeps)
                        );
                    }
                } else if (context.cloudProvider === 'dropbox') {
                    await applyAttachmentSyncMutation((candidateData) =>
                        syncDropboxAttachments(candidateData, helpers.resolveDropboxAccessToken, attachmentBackendDeps)
                    );
                }
            }

            return nextMergedData;
        } catch (error) {
            if (error instanceof LocalSyncAbort) {
                throw error;
            }
            context.hadAttachmentWarning = true;
            logSyncWarning('Attachment sync warning', error);
            return mergedData;
        }
    }

    private static hasPendingLocalChangesForExternalSync(): boolean {
        const state = getStoreState();
        if (!state.settings?.lastSyncAt) return false;
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
                await syncServiceDependencies.flushPendingSave();
                const localData = await injectExternalCalendars(await readLocalDataForSync());
                const sanitized = sanitizeAppDataForRemote(localData);
                await SyncService.markSyncWrite(sanitized);
                try {
                    await tauriInvoke('write_sync_file', { data: sanitized });
                    return await SyncService.performSync();
                } catch (error) {
                    SyncService.finalizeSyncWriteIgnoreWindow();
                    throw error;
                }
            }

            await syncServiceDependencies.flushPendingSave();
            const externalData = normalizeAppData(await tauriInvoke<AppData>('read_sync_file'));
            await persistLocalDataForSync(externalData);
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
            const syncData = await tauriInvoke<AppData>('read_sync_file');
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
                            const conflicts = (result.stats?.tasks.conflicts || 0) + (result.stats?.projects.conflicts || 0);
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
        const backend = await SyncService.getSyncBackend();
        const data = await tauriInvoke<AppData>('get_data');
        const cleaned = await cleanupOrphanedAttachments(data, backend, getAttachmentCleanupDeps());
        await persistLocalDataForSync(cleaned);
        await getStoreState().fetchData({ silent: true });
    }

    static async listDataSnapshots(): Promise<string[]> {
        if (!isTauriRuntimeEnv()) return [];
        try {
            return await tauriInvoke<string[]>('list_data_snapshots');
        } catch (error) {
            syncServiceDependencies.reportError('Failed to list snapshots', error);
            return [];
        }
    }

    static async createDataSnapshot(): Promise<string | null> {
        if (!isTauriRuntimeEnv()) return null;
        try {
            return await tauriInvoke<string>('create_data_snapshot');
        } catch (error) {
            syncServiceDependencies.reportError('Failed to create snapshot', error);
            return null;
        }
    }

    static async restoreDataSnapshot(snapshotFileName: string): Promise<{ success: boolean; error?: string }> {
        if (!isTauriRuntimeEnv()) return { success: false, error: 'Desktop runtime is required.' };
        try {
            await tauriInvoke<boolean>('restore_data_snapshot', { snapshotFileName });
            await getStoreState().fetchData({ silent: true });
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
        if (SyncService.syncInFlight) {
            SyncService.requestQueuedSyncRun();
            return SyncService.syncInFlight;
        }
        // Consume queued follow-up requests by snapshotting the version at cycle start.
        const cycleQueueVersion = SyncService.syncQueueVersion;
        SyncService.syncQueued = false;
        let inFlightSettled = false;
        let resolveInFlight: ((value: SyncRunResult) => void) | null = null;
        const inFlightPromise = new Promise<SyncRunResult>((resolve) => {
            resolveInFlight = resolve;
        });
        const settleInFlight = (value: SyncRunResult) => {
            if (inFlightSettled) return;
            inFlightSettled = true;
            resolveInFlight?.(value);
        };
        SyncService.syncInFlight = inFlightPromise;
        const context = SyncService.createSyncExecutionContext();
        const persistLocalDataWithTracking = async (data: AppData): Promise<void> => {
            if (isTauriRuntimeEnv()) {
                await persistLocalDataForSync(data);
            } else {
                await webStorage.saveData(data);
            }
            context.wroteLocal = true;
        };

        SyncService.updateSyncStatus({
            inFlight: true,
            queued: false,
            step: context.step,
            lastResult: SyncService.syncStatus.lastResult,
            lastResultAt: SyncService.syncStatus.lastResultAt,
        });
        await yieldToRenderer();

        const setStep = (next: string) => {
            context.step = next;
            SyncService.updateSyncStatus({ step: next });
        };
        const createFetchWithAbort = (baseFetch: typeof fetch): typeof fetch =>
            createAbortableFetch(baseFetch, { baseSignal: context.requestAbortController.signal });
        const ensureNetworkStillAvailable = () => {
            if (context.backend !== 'cloud' && context.backend !== 'webdav' && context.backend !== 'cloudkit') return;
            if (
                context.networkWentOffline
                || (typeof navigator !== 'undefined' && navigator.onLine === false)
            ) {
                context.requestAbortController.abort();
                throw new Error('Sync paused: offline state detected');
            }
        };
        const ensureLocalSnapshotFresh = () => {
            if (getStoreState().lastDataChangeAt > context.localSnapshotChangeAt) {
                SyncService.requestQueuedSyncRun();
                throw new LocalSyncAbort();
            }
        };
        const resolveDropboxAccessToken = async (forceRefresh = false): Promise<string> => {
            if (!context.dropboxAppKey) {
                throw new Error('Dropbox app key is not configured');
            }
            if (!context.cachedDropboxAccessToken || forceRefresh) {
                context.cachedDropboxAccessToken = await SyncService.getDropboxAccessToken(context.dropboxAppKey, { forceRefresh });
            }
            return context.cachedDropboxAccessToken;
        };
        const helpers: SyncExecutionHelpers = {
            setStep,
            createFetchWithAbort,
            ensureNetworkStillAvailable,
            ensureLocalSnapshotFresh,
            persistLocalDataWithTracking,
            resolveDropboxAccessToken,
            runDropboxWithRetry: <T>(operation: (token: string) => Promise<T>) =>
                SyncService.runDropboxWithRetry(resolveDropboxAccessToken, operation),
        };

        const runSync = async (): Promise<SyncRunResult> => {
            // 1. Flush pending writes so disk reflects the latest state
            setStep('flush');
            await yieldToRenderer();
            await syncServiceDependencies.flushPendingSave();
            context.localSnapshotChangeAt = getStoreState().lastDataChangeAt;

            // 2. Read/merge/write via shared core orchestration.
            await SyncService.prepareSyncExecutionContext(context, options, helpers);
            if (context.backend === 'off') {
                return { success: true };
            }

            // Pre-sync local attachments so cloudKeys exist before writing remote data.
            await SyncService.runPreSyncAttachmentPhase(context, helpers);

            // CloudKit setup: ensure zone and subscription exist before syncing.
            if (context.backend === 'cloudkit') {
                setStep('cloudkit_setup');
                await yieldToRenderer();
                await syncServiceDependencies.ensureCloudKitReady();
            }

            const syncResult = await syncServiceDependencies.performSyncCycle({
                readLocal: () => SyncService.readLocalDataForSyncCycle(context),
                readRemote: () => SyncService.readRemoteDataByBackend(context, helpers),
                writeLocal: async (data) => {
                    ensureLocalSnapshotFresh();
                    await persistLocalDataWithTracking(data);
                },
                prepareRemoteWrite: (data) => SyncService.prepareRemoteWriteData(context, data, helpers),
                writeRemote: async (data) => {
                    ensureLocalSnapshotFresh();
                    await SyncService.writeRemoteDataByBackend(context, data, helpers);
                },
                onStep: (next) => {
                    setStep(next);
                },
                yieldToUi: yieldToRenderer,
                historyContext: {
                    backend: context.backend,
                    type: 'merge',
                },
            });
            const stats = syncResult.stats;
            let mergedData = syncResult.data;
            await persistExternalCalendars(mergedData);
            SyncService.logSyncMergeSummary(stats);
            ensureLocalSnapshotFresh();

            mergedData = await SyncService.runPostMergeAttachmentPhase(context, mergedData, helpers);

            await cleanupAttachmentTempFiles(getAttachmentCleanupDeps());

            if (isTauriRuntimeEnv() && shouldRunAttachmentCleanup(mergedData.settings.attachments?.lastCleanupAt, CLEANUP_INTERVAL_MS)) {
                setStep('attachments_cleanup');
                await yieldToRenderer();
                ensureLocalSnapshotFresh();
                ensureNetworkStillAvailable();
                mergedData = await cleanupOrphanedAttachments(mergedData, context.backend, getAttachmentCleanupDeps());
                await persistLocalDataWithTracking(mergedData);
            }

            // 7. Refresh UI Store
            setStep('refresh');
            await yieldToRenderer();
            ensureLocalSnapshotFresh();
            await getStoreState().fetchData({ silent: true });

            const syncStatus = syncResult.status;
            const now = new Date().toISOString();
            await SyncService.persistSuccessfulSyncStatus(syncStatus, now);
            SyncService.setPendingExternalSyncChange(null);

            getStoreState().setError(null);
            return { success: true, stats };
        };

        const resultPromise = runSync().catch(async (error) => {
            if (error instanceof LocalSyncAbort) {
                await SyncService.persistPreSyncedLocalDataIfNeeded(context, persistLocalDataWithTracking);
                return { success: true, skipped: 'requeued' as const };
            }
            logSyncWarning('Sync failed', error);
            const now = new Date().toISOString();
            const safeMessage = formatSyncErrorMessage(error, context.backend);
            let logHint = '';
            try {
                const logPath = await syncServiceDependencies.logSyncError(error, {
                    backend: context.backend,
                    step: context.step,
                    url: context.syncUrl,
                });
                logHint = logPath ? ` (log: ${logPath})` : '';
            } catch (logError) {
                logSyncWarning('Failed to write sync error log', logError);
            }
            const finalErrorMessage = `${safeMessage}${logHint}`;
            const nextHistory = appendSyncHistory(getStoreState().settings, {
                at: now,
                status: 'error',
                backend: context.backend,
                type: 'merge',
                conflicts: 0,
                conflictIds: [],
                maxClockSkewMs: 0,
                timestampAdjustments: 0,
                details: context.step,
                error: finalErrorMessage,
            });
            getStoreState().setError(finalErrorMessage);
            try {
                await getStoreState().fetchData({ silent: true });
                await getStoreState().updateSettings({
                    lastSyncAt: now,
                    lastSyncStatus: 'error',
                    lastSyncError: finalErrorMessage,
                    lastSyncHistory: nextHistory,
                });
            } catch (e) {
                logSyncWarning('Failed to persist sync error', e);
            }
            return { success: false, error: finalErrorMessage };
        });

        let result: SyncRunResult;
        try {
            result = await resultPromise;
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
            SyncService.syncInFlight = null;
        }
        const skippedRequeue = result.skipped === 'requeued';
        if (!skippedRequeue) {
            SyncService.finalizeAttachmentWarningState(context, result);
        }
        const hasQueuedFollowUp = SyncService.syncQueueVersion > cycleQueueVersion;
        SyncService.syncQueued = hasQueuedFollowUp;
        SyncService.updateSyncStatus({
            inFlight: false,
            step: null,
            queued: SyncService.syncQueued,
            lastResult: skippedRequeue
                ? SyncService.syncStatus.lastResult
                : result.success
                    ? 'success'
                    : 'error',
            lastResultAt: skippedRequeue
                ? SyncService.syncStatus.lastResultAt
                : new Date().toISOString(),
        });

        if (hasQueuedFollowUp) {
            void SyncService.performSync(options)
                .then((queuedResult) => {
                    if (!queuedResult.success) {
                        logSyncWarning('Queued sync failed', queuedResult.error);
                        try {
                            useUiStore.getState().showToast(queuedResult.error || 'Queued sync failed.', 'error', 6000);
                        } catch {
                            // UI store may be unavailable during shutdown/tests.
                        }
                    }
                })
                .catch((error) => {
                    logSyncWarning('Queued sync crashed', error);
                });
        }

        settleInFlight(result);
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
    },
    async persistLocalDataForTests(data: AppData) {
        await persistLocalDataForSync(data);
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
};
