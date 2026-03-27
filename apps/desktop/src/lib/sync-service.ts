
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
    injectExternalCalendars as injectExternalCalendarsForSync,
    persistExternalCalendars as persistExternalCalendarsForSync,
    withRetry,
    isRetryableWebdavReadError,
    isWebdavInvalidJsonError,
    CLOCK_SKEW_THRESHOLD_MS,
    appendSyncHistory,
    cloneAppData,
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
const WEBDAV_READ_RETRY_OPTIONS = {
    maxAttempts: 5,
    baseDelayMs: 2000,
    maxDelayMs: 30_000,
    shouldRetry: isRetryableWebdavReadError,
};
type SyncServiceDependencies = {
    isTauriRuntime: () => boolean;
    invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
    getTauriFetch: () => Promise<typeof fetch | undefined>;
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
};

let syncServiceDependencies: SyncServiceDependencies = {
    ...defaultSyncServiceDependencies,
};

const isTauriRuntimeEnv = () => syncServiceDependencies.isTauriRuntime();

const logSyncWarning = (message: string, error?: unknown) => {
    const extra = error
        ? { error: sanitizeLogMessage(error instanceof Error ? error.message : String(error)) }
        : undefined;
    void logWarn(message, { scope: 'sync', extra });
};

const logSyncInfo = (message: string, extra?: Record<string, string>) => {
    void logInfo(message, { scope: 'sync', extra });
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
    load: () => ExternalCalendarService.getCalendars(),
    save: (calendars: AppData['settings']['externalCalendars'] | undefined) =>
        ExternalCalendarService.setCalendars(calendars ?? []),
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

    const state = useTaskStore.getState();
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
    markLocalWrite(data);
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
    reportError,
    startFileWatcher: () => SyncService.startFileWatcher(),
    tauriInvoke,
});

export class SyncService {
    private static didMigrate = false;
    private static syncInFlight: Promise<{ success: boolean; stats?: MergeStats; error?: string }> | null = null;
    private static syncQueued = false;
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
    private static externalSyncTimer: ReturnType<typeof setTimeout> | null = null;
    private static pendingExternalSyncChange: ExternalSyncChange | null = null;
    private static externalSyncChangeListeners = new Set<(change: ExternalSyncChange | null) => void>();

    private static getMonotonicNow(): number {
        if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
            return performance.now();
        }
        return Date.now();
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
        SyncService.externalSyncTimer = null;
        SyncService.pendingExternalSyncChange = null;
        SyncService.externalSyncChangeListeners.clear();
        clearAttachmentSyncState();
        clearAttachmentValidationFailures();
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
            reportError('Failed to migrate legacy sync config', error);
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
            reportError('Failed to check Dropbox connection status', error);
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
        SyncService.ignoreFileEventsUntil = SyncService.getMonotonicNow() + 2000;
    }

    private static hasPendingLocalChangesForExternalSync(): boolean {
        const state = useTaskStore.getState();
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
                await flushPendingSave();
                const localData = await injectExternalCalendars(await readLocalDataForSync());
                const sanitized = sanitizeAppDataForRemote(localData);
                await SyncService.markSyncWrite(sanitized);
                await tauriInvoke('write_sync_file', { data: sanitized });
                return await SyncService.performSync();
            }

            await flushPendingSave();
            const externalData = normalizeAppData(await tauriInvoke<AppData>('read_sync_file'));
            await persistLocalDataForSync(externalData);
            await useTaskStore.getState().fetchData({ silent: true });
            const now = new Date().toISOString();
            const nextHistory = appendSyncHistory(useTaskStore.getState().settings, {
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
            await useTaskStore.getState().updateSettings({
                lastSyncAt: now,
                lastSyncStatus: 'success',
                lastSyncError: undefined,
                lastSyncHistory: nextHistory,
            });
            SyncService.lastSuccessfulSyncLocalChangeAt = useTaskStore.getState().lastDataChangeAt;
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
                const localState = useTaskStore.getState();
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
                    .catch((error) => reportError('Sync failed', error));
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
        await useTaskStore.getState().fetchData({ silent: true });
    }

    static async listDataSnapshots(): Promise<string[]> {
        if (!isTauriRuntimeEnv()) return [];
        try {
            return await tauriInvoke<string[]>('list_data_snapshots');
        } catch (error) {
            reportError('Failed to list snapshots', error);
            return [];
        }
    }

    static async restoreDataSnapshot(snapshotFileName: string): Promise<{ success: boolean; error?: string }> {
        if (!isTauriRuntimeEnv()) return { success: false, error: 'Desktop runtime is required.' };
        try {
            await tauriInvoke<boolean>('restore_data_snapshot', { snapshotFileName });
            await useTaskStore.getState().fetchData({ silent: true });
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
    static async performSync(): Promise<{ success: boolean; stats?: MergeStats; error?: string }> {
        if (SyncService.syncInFlight) {
            SyncService.syncQueued = true;
            SyncService.updateSyncStatus({ queued: true });
            return SyncService.syncInFlight;
        }
        // Consume any queued follow-up token only when this cycle has actually started.
        SyncService.syncQueued = false;
        let inFlightSettled = false;
        let resolveInFlight: ((value: { success: boolean; stats?: MergeStats; error?: string }) => void) | null = null;
        const inFlightPromise = new Promise<{ success: boolean; stats?: MergeStats; error?: string }>((resolve) => {
            resolveInFlight = resolve;
        });
        const settleInFlight = (value: { success: boolean; stats?: MergeStats; error?: string }) => {
            if (inFlightSettled) return;
            inFlightSettled = true;
            resolveInFlight?.(value);
        };
        SyncService.syncInFlight = inFlightPromise;
        let step = 'init';
        let backend: SyncBackend = 'off';
        let syncUrl: string | undefined;
        let localSnapshotChangeAt = 0;
        let networkWentOffline = false;
        let removeNetworkListener: (() => void) | null = null;
        const requestAbortController = new AbortController();
        let preSyncedLocalData: AppData | null = null;
        let wroteLocal = false;
        const persistLocalDataWithTracking = async (data: AppData): Promise<void> => {
            if (isTauriRuntimeEnv()) {
                await persistLocalDataForSync(data);
            } else {
                await webStorage.saveData(data);
            }
            wroteLocal = true;
        };
        const persistPreSyncedLocalDataIfNeeded = async (): Promise<void> => {
            if (!preSyncedLocalData || wroteLocal) return;
            const inMemorySnapshot = getInMemoryAppDataSnapshot();
            const reconciledData = mergeAppData(preSyncedLocalData, inMemorySnapshot);
            await persistLocalDataWithTracking(reconciledData);
        };

        SyncService.updateSyncStatus({
            inFlight: true,
            queued: false,
            step,
            lastResult: SyncService.syncStatus.lastResult,
            lastResultAt: SyncService.syncStatus.lastResultAt,
        });
        await yieldToRenderer();

        const setStep = (next: string) => {
            step = next;
            SyncService.updateSyncStatus({ step: next });
        };

        const runSync = async (): Promise<{ success: boolean; stats?: MergeStats; error?: string }> => {
            const createFetchWithAbort = (baseFetch: typeof fetch): typeof fetch =>
                createAbortableFetch(baseFetch, { baseSignal: requestAbortController.signal });
            const ensureNetworkStillAvailable = () => {
                if (backend !== 'cloud' && backend !== 'webdav' && backend !== 'cloudkit') return;
                if (
                    networkWentOffline
                    || (typeof navigator !== 'undefined' && navigator.onLine === false)
                ) {
                    requestAbortController.abort();
                    throw new Error('Sync paused: offline state detected');
                }
            };
            // 1. Flush pending writes so disk reflects the latest state
            setStep('flush');
            await yieldToRenderer();
            await flushPendingSave();
            localSnapshotChangeAt = useTaskStore.getState().lastDataChangeAt;

            // 2. Read/merge/write via shared core orchestration.
            backend = await SyncService.getSyncBackend();
            if (backend === 'off') {
                return { success: true };
            }
            if ((backend === 'cloud' || backend === 'webdav' || backend === 'cloudkit') && typeof window !== 'undefined') {
                const handleOffline = () => {
                    networkWentOffline = true;
                    requestAbortController.abort();
                };
                window.addEventListener('offline', handleOffline);
                removeNetworkListener = () => {
                    window.removeEventListener('offline', handleOffline);
                    removeNetworkListener = null;
                };
            }
            if (isTauriRuntimeEnv()) {
                setStep('snapshot');
                await yieldToRenderer();
                try {
                    await tauriInvoke<string>('create_data_snapshot');
                } catch (error) {
                    logSyncWarning('Failed to create pre-sync snapshot', error);
                }
            }
            if ((backend === 'cloud' || backend === 'webdav' || backend === 'cloudkit') && typeof navigator !== 'undefined' && navigator.onLine === false) {
                throw new Error('Offline: network connection is unavailable for remote sync.');
            }
            const webdavConfig = backend === 'webdav' ? await SyncService.getWebDavConfig() : null;
            const cloudProvider = backend === 'cloud' ? await SyncService.getCloudProvider() : 'selfhosted';
            const cloudConfig = backend === 'cloud' && cloudProvider === 'selfhosted'
                ? await SyncService.getCloudConfig()
                : null;
            const dropboxAppKey = backend === 'cloud' && cloudProvider === 'dropbox'
                ? (await SyncService.getDropboxAppKey()).trim()
                : '';
            if (backend === 'cloud' && cloudProvider === 'dropbox' && !dropboxAppKey) {
                throw new Error('Dropbox app key is not configured');
            }
            let dropboxDataRev: string | null = null;
            let cachedDropboxAccessToken: string | null = null;
            const resolveDropboxAccessToken = async (forceRefresh = false): Promise<string> => {
                if (!dropboxAppKey) {
                    throw new Error('Dropbox app key is not configured');
                }
                if (!cachedDropboxAccessToken || forceRefresh) {
                    cachedDropboxAccessToken = await SyncService.getDropboxAccessToken(dropboxAppKey, { forceRefresh });
                }
                return cachedDropboxAccessToken;
            };
            const runDropboxWithRetry = async <T>(operation: (token: string) => Promise<T>): Promise<T> => {
                try {
                    const token = await resolveDropboxAccessToken(false);
                    return await operation(token);
                } catch (error) {
                    if (error instanceof DropboxUnauthorizedError) {
                        const refreshed = await resolveDropboxAccessToken(true);
                        return await operation(refreshed);
                    }
                    throw error;
                }
            };
            const syncPath = backend === 'file' ? await SyncService.getSyncPath() : '';
            const fileBaseDir = backend === 'file' ? getFileSyncDir(syncPath, SYNC_FILE_NAME, LEGACY_SYNC_FILE_NAME) : '';
            let remoteDataForCompare: AppData | null = null;
            let webdavRemoteCorrupted = false;
            const ensureLocalSnapshotFresh = () => {
                if (useTaskStore.getState().lastDataChangeAt > localSnapshotChangeAt) {
                    SyncService.syncQueued = true;
                    SyncService.updateSyncStatus({ queued: true });
                    throw new LocalSyncAbort();
                }
            };

            // Pre-sync local attachments so cloudKeys exist before writing remote data.
            if (isTauriRuntimeEnv() && (backend === 'webdav' || backend === 'file' || backend === 'cloud')) {
                setStep('attachments_prepare');
                await yieldToRenderer();
                try {
                    const localData = await readLocalDataForSync();
                    let preMutated = false;
                    if (backend === 'webdav' && webdavConfig?.url) {
                        ensureNetworkStillAvailable();
                        const baseUrl = getBaseSyncUrl(webdavConfig.url);
                        const syncedData = await syncAttachments(localData, webdavConfig, baseUrl, attachmentBackendDeps);
                        preMutated = syncedData !== null;
                        if (syncedData) {
                            preSyncedLocalData = syncedData;
                        }
                    } else if (backend === 'file' && fileBaseDir) {
                        preMutated = await syncFileAttachments(localData, fileBaseDir, attachmentBackendDeps);
                    } else if (backend === 'cloud' && cloudProvider === 'selfhosted' && cloudConfig?.url) {
                        ensureNetworkStillAvailable();
                        const baseUrl = getCloudBaseUrl(cloudConfig.url);
                        preMutated = await syncCloudAttachments(localData, cloudConfig, baseUrl, attachmentBackendDeps);
                    } else if (backend === 'cloud' && cloudProvider === 'dropbox') {
                        ensureNetworkStillAvailable();
                        preMutated = await syncDropboxAttachments(localData, resolveDropboxAccessToken, attachmentBackendDeps);
                    }
                    if (preMutated) {
                        preSyncedLocalData = preSyncedLocalData ?? localData;
                        ensureLocalSnapshotFresh();
                    }
                } catch (error) {
                    if (error instanceof LocalSyncAbort) {
                        throw error;
                    }
                    logSyncWarning('Attachment pre-sync warning', error);
                }
            }

            // CloudKit setup: ensure zone and subscription exist before syncing.
            if (backend === 'cloudkit') {
                setStep('cloudkit_setup');
                await yieldToRenderer();
                await ensureCloudKitReady();
            }

            const readRemoteDataByBackend = async (): Promise<AppData | null> => {
                ensureNetworkStillAvailable();
                if (backend === 'cloudkit') {
                    return await readRemoteCloudKit();
                }
                if (backend === 'webdav') {
                    try {
                        if (isTauriRuntimeEnv()) {
                            if (!webdavConfig?.url) {
                                throw new Error('WebDAV URL not configured');
                            }
                            syncUrl = webdavConfig.url;
                            const data = await withRetry(
                                () => tauriInvoke<AppData>('webdav_get_json'),
                                WEBDAV_READ_RETRY_OPTIONS,
                            );
                            webdavRemoteCorrupted = false;
                            remoteDataForCompare = data ?? null;
                            return data;
                        }
                        if (!webdavConfig?.url) {
                            throw new Error('WebDAV URL not configured');
                        }
                        const normalizedUrl = normalizeWebdavUrl(webdavConfig.url);
                        syncUrl = normalizedUrl;
                        const fetcher = createFetchWithAbort((await getTauriFetch()) ?? fetch);
                        const data = await withRetry(
                            () => webdavGetJson<AppData>(normalizedUrl, {
                                username: webdavConfig.username,
                                password: webdavConfig.password || '',
                                fetcher,
                            }),
                            WEBDAV_READ_RETRY_OPTIONS,
                        );
                        webdavRemoteCorrupted = false;
                        remoteDataForCompare = data ?? null;
                        return data;
                    } catch (error) {
                        if (isWebdavInvalidJsonError(error)) {
                            webdavRemoteCorrupted = true;
                            remoteDataForCompare = null;
                            logSyncWarning('WebDAV remote data.json appears corrupted; treating as missing for repair write', error);
                            return null;
                        }
                        throw error;
                    }
                }
                if (backend === 'cloud') {
                    if (cloudProvider === 'selfhosted') {
                        if (!cloudConfig?.url) {
                            throw new Error('Self-hosted URL not configured');
                        }
                        const normalizedUrl = normalizeCloudUrl(cloudConfig.url);
                        syncUrl = normalizedUrl;
                        const fetcher = createFetchWithAbort((await getTauriFetch()) ?? fetch);
                        const data = await cloudGetJson<AppData>(normalizedUrl, { token: cloudConfig.token, fetcher });
                        remoteDataForCompare = data ?? null;
                        return data;
                    }
                    if (!dropboxAppKey) {
                        throw new Error('Dropbox app key is not configured');
                    }
                    syncUrl = 'dropbox:///Apps/Mindwtr/data.json';
                    const fetcher = createFetchWithAbort((await getTauriFetch()) ?? fetch);
                    const remote = await runDropboxWithRetry((token) =>
                        downloadDropboxAppData(token, fetcher)
                    );
                    dropboxDataRev = remote.rev;
                    remoteDataForCompare = remote.data ?? null;
                    return remote.data;
                }
                if (!isTauriRuntimeEnv()) {
                    throw new Error('File sync is not available in the web app.');
                }
                const data = await tauriInvoke<AppData>('read_sync_file');
                remoteDataForCompare = data ?? null;
                return data;
            };

            const writeRemoteDataByBackend = async (data: AppData): Promise<void> => {
                ensureNetworkStillAvailable();
                if (backend === 'cloudkit') {
                    const sanitized = sanitizeAppDataForRemote(data);
                    await writeRemoteCloudKit(sanitized as AppData);
                    return;
                }
                assertNoPendingAttachmentUploads(data);
                const sanitized = sanitizeAppDataForRemote(data);
                const remoteSanitized = remoteDataForCompare
                    ? sanitizeAppDataForRemote(remoteDataForCompare)
                    : null;
                if (remoteSanitized && areSyncPayloadsEqual(remoteSanitized, sanitized)) {
                    return;
                }
                if (backend === 'webdav') {
                    if (isTauriRuntimeEnv()) {
                        if (webdavRemoteCorrupted) {
                            logSyncInfo('Repairing corrupted WebDAV data.json with current merged data');
                        }
                        await tauriInvoke('webdav_put_json', { data: sanitized });
                        remoteDataForCompare = sanitized;
                        webdavRemoteCorrupted = false;
                        return;
                    }
                    const { url, username, password } = await SyncService.getWebDavConfig();
                    const normalizedUrl = normalizeWebdavUrl(url);
                    const fetcher = createFetchWithAbort((await getTauriFetch()) ?? fetch);
                    if (webdavRemoteCorrupted) {
                        logSyncInfo('Repairing corrupted WebDAV data.json with current merged data');
                    }
                    await webdavPutJson(normalizedUrl, sanitized, { username, password: password || '', fetcher });
                    remoteDataForCompare = sanitized;
                    webdavRemoteCorrupted = false;
                    return;
                }
                if (backend === 'cloud') {
                    if (cloudProvider === 'selfhosted') {
                        const { url, token } = await SyncService.getCloudConfig();
                        const normalizedUrl = normalizeCloudUrl(url);
                        const fetcher = createFetchWithAbort((await getTauriFetch()) ?? fetch);
                        await cloudPutJson(normalizedUrl, sanitized, { token, fetcher });
                        remoteDataForCompare = sanitized;
                        return;
                    }
                    if (!dropboxAppKey) {
                        throw new Error('Dropbox app key is not configured');
                    }
                    const fetcher = createFetchWithAbort((await getTauriFetch()) ?? fetch);
                    try {
                        const uploaded = await runDropboxWithRetry((token) =>
                            uploadDropboxAppData(token, sanitized, dropboxDataRev, fetcher)
                        );
                        dropboxDataRev = uploaded.rev;
                        remoteDataForCompare = sanitized;
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
                remoteDataForCompare = sanitized;
            };

            const syncResult = await performSyncCycle({
                readLocal: async () => {
                    const inMemorySnapshot = getInMemoryAppDataSnapshot();
                    const baseData = preSyncedLocalData
                        ? mergeAppData(preSyncedLocalData, inMemorySnapshot)
                        : mergeAppData(await readLocalDataForSync(), inMemorySnapshot);
                    const data = await injectExternalCalendars(baseData);
                    localSnapshotChangeAt = useTaskStore.getState().lastDataChangeAt;
                    return data;
                },
                readRemote: readRemoteDataByBackend,
                writeLocal: async (data) => {
                    ensureLocalSnapshotFresh();
                    await persistLocalDataWithTracking(data);
                },
                writeRemote: async (data) => {
                    ensureLocalSnapshotFresh();
                    await writeRemoteDataByBackend(data);
                },
                onStep: (next) => {
                    setStep(next);
                },
                yieldToUi: yieldToRenderer,
                historyContext: {
                    backend,
                    type: 'merge',
                },
            });
            const stats = syncResult.stats;
            let mergedData = syncResult.data;
            await persistExternalCalendars(mergedData);
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
            if (isTauriRuntimeEnv() && (conflictCount > 0 || maxClockSkewMs > CLOCK_SKEW_THRESHOLD_MS || timestampAdjustments > 0)) {
                const conflictIds = [
                    ...(stats.tasks.conflictIds || []),
                    ...(stats.projects.conflictIds || []),
                    ...(stats.sections.conflictIds || []),
                    ...(stats.areas.conflictIds || []),
                ].slice(0, 6);
                void logInfo(
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
            ensureLocalSnapshotFresh();

            if ((backend === 'webdav' || backend === 'file' || backend === 'cloud') && isTauriRuntimeEnv()) {
                setStep('attachments');
                await yieldToRenderer();
                try {
                    const applyAttachmentSyncMutation = async (
                        syncAttachmentsOp: (candidateData: AppData) => Promise<AppData | boolean | null>
                    ): Promise<void> => {
                        const candidateData = cloneAppData(mergedData);
                        const mutationResult = await syncAttachmentsOp(candidateData);
                        const nextData = mutationResult && typeof mutationResult === 'object'
                            ? mutationResult
                            : mutationResult
                                ? candidateData
                                : null;
                        if (!nextData) return;
                        ensureLocalSnapshotFresh();
                        mergedData = nextData;
                        await persistLocalDataWithTracking(mergedData);
                        await yieldToRenderer();
                    };

                    ensureLocalSnapshotFresh();
                    if (backend === 'webdav') {
                        ensureNetworkStillAvailable();
                        const config = await SyncService.getWebDavConfig();
                        const baseUrl = config.url ? getBaseSyncUrl(config.url) : '';
                        if (baseUrl) {
                            await applyAttachmentSyncMutation((candidateData) =>
                                syncAttachments(candidateData, config, baseUrl, attachmentBackendDeps)
                            );
                        }
                    } else if (backend === 'file') {
                        if (fileBaseDir) {
                            await applyAttachmentSyncMutation((candidateData) =>
                                syncFileAttachments(candidateData, fileBaseDir, attachmentBackendDeps)
                            );
                        }
                    } else if (backend === 'cloud') {
                        ensureNetworkStillAvailable();
                        if (cloudProvider === 'selfhosted') {
                            const config = cloudConfig ?? await SyncService.getCloudConfig();
                            const baseUrl = config.url ? getCloudBaseUrl(config.url) : '';
                            if (baseUrl) {
                                await applyAttachmentSyncMutation((candidateData) =>
                                    syncCloudAttachments(candidateData, config, baseUrl, attachmentBackendDeps)
                                );
                            }
                        } else if (cloudProvider === 'dropbox') {
                            await applyAttachmentSyncMutation((candidateData) =>
                                syncDropboxAttachments(candidateData, resolveDropboxAccessToken, attachmentBackendDeps)
                            );
                        }
                    }
                } catch (error) {
                    if (error instanceof LocalSyncAbort) {
                        throw error;
                    }
                    logSyncWarning('Attachment sync warning', error);
                }
            }

            await cleanupAttachmentTempFiles(getAttachmentCleanupDeps());

            if (isTauriRuntimeEnv() && shouldRunAttachmentCleanup(mergedData.settings.attachments?.lastCleanupAt, CLEANUP_INTERVAL_MS)) {
                setStep('attachments_cleanup');
                await yieldToRenderer();
                ensureLocalSnapshotFresh();
                ensureNetworkStillAvailable();
                mergedData = await cleanupOrphanedAttachments(mergedData, backend, getAttachmentCleanupDeps());
                await persistLocalDataWithTracking(mergedData);
            }

            // 7. Refresh UI Store
            setStep('refresh');
            await yieldToRenderer();
            ensureLocalSnapshotFresh();
            await useTaskStore.getState().fetchData({ silent: true });

            const syncStatus = syncResult.status;
            const now = new Date().toISOString();
            try {
                await useTaskStore.getState().updateSettings({
                    lastSyncAt: now,
                    lastSyncStatus: syncStatus,
                    lastSyncError: undefined,
                });
            } catch (error) {
                logSyncWarning('Failed to persist sync status', error);
            }
            SyncService.lastSuccessfulSyncLocalChangeAt = useTaskStore.getState().lastDataChangeAt;
            SyncService.setPendingExternalSyncChange(null);

            useTaskStore.getState().setError(null);
            return { success: true, stats };
        };

        const resultPromise = runSync().catch(async (error) => {
            if (error instanceof LocalSyncAbort) {
                await persistPreSyncedLocalDataIfNeeded();
                return { success: true };
            }
            logSyncWarning('Sync failed', error);
            const now = new Date().toISOString();
            const safeMessage = sanitizeLogMessage(String(error));
            let logHint = '';
            try {
                const logPath = await logSyncError(error, {
                    backend,
                    step,
                    url: syncUrl,
                });
                logHint = logPath ? ` (log: ${logPath})` : '';
            } catch (logError) {
                logSyncWarning('Failed to write sync error log', logError);
            }
            const finalErrorMessage = `${safeMessage}${logHint}`;
            const nextHistory = appendSyncHistory(useTaskStore.getState().settings, {
                at: now,
                status: 'error',
                backend,
                type: 'merge',
                conflicts: 0,
                conflictIds: [],
                maxClockSkewMs: 0,
                timestampAdjustments: 0,
                details: step,
                error: finalErrorMessage,
            });
            useTaskStore.getState().setError(finalErrorMessage);
            try {
                await useTaskStore.getState().fetchData({ silent: true });
                await useTaskStore.getState().updateSettings({
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

        let result: { success: boolean; stats?: MergeStats; error?: string };
        try {
            result = await resultPromise;
        } finally {
            requestAbortController.abort();
            try {
                const releaseNetworkListener = removeNetworkListener as (() => void) | null;
                if (typeof releaseNetworkListener === 'function') {
                    releaseNetworkListener();
                }
                removeNetworkListener = null;
            } catch (error) {
                logSyncWarning('Failed to unsubscribe network listener after sync', error);
            }
            SyncService.syncInFlight = null;
        }
        SyncService.updateSyncStatus({
            inFlight: false,
            step: null,
            queued: SyncService.syncQueued,
            lastResult: result.success ? 'success' : 'error',
            lastResultAt: new Date().toISOString(),
        });

        if (SyncService.syncQueued) {
            void SyncService.performSync()
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
