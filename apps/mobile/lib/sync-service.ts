import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { AppData, Attachment, MergeStats, createSyncOrchestrator, useTaskStore, webdavGetJson, webdavPutJson, cloudGetJson, cloudPutJson, flushPendingSave, performSyncCycle, findOrphanedAttachments, removeOrphanedAttachmentsFromData, removeAttachmentsByIdFromData, webdavDeleteFile, cloudDeleteFile, CLOCK_SKEW_THRESHOLD_MS, appendSyncHistory, withRetry, isRetryableWebdavReadError, isWebdavInvalidJsonError, normalizeWebdavUrl, normalizeCloudUrl, sanitizeAppDataForRemote, areSyncPayloadsEqual, assertNoPendingAttachmentUploads, findPendingAttachmentUploads, injectExternalCalendars as injectExternalCalendarsForSync, persistExternalCalendars as persistExternalCalendarsForSync, mergeAppData, cloneAppData, LocalSyncAbort, getInMemoryAppDataSnapshot, shouldRunAttachmentCleanup, createAbortableFetch, normalizeCloudProvider as normalizeCoreCloudProvider, CLOUD_PROVIDER_DROPBOX, CLOUD_PROVIDER_SELF_HOSTED, type CloudProvider } from '@mindwtr/core';
import { mobileStorage } from './storage-adapter';
import { logInfo, logSyncError, logWarn, sanitizeLogMessage } from './app-log';
import { readSyncFile, resolveSyncFileUri, writeSyncFile } from './storage-file';
import { resolveSyncPathBookmark } from './sync-path-bookmarks';
import { getBaseSyncUrl, getCloudBaseUrl, syncCloudAttachments, syncDropboxAttachments, syncFileAttachments, syncWebdavAttachments, cleanupAttachmentTempFiles } from './attachment-sync';
import { getExternalCalendars, saveExternalCalendars } from './external-calendar';
import { forceRefreshDropboxAccessToken, getValidDropboxAccessToken } from './dropbox-auth';
import {
  DropboxConflictError,
  DropboxUnauthorizedError,
  deleteDropboxFile,
  downloadDropboxAppData,
  uploadDropboxAppData,
} from './dropbox-sync';
import * as FileSystem from 'expo-file-system/legacy';
import * as Network from 'expo-network';
import { coerceSupportedBackend, formatSyncErrorMessage, getFileSyncBaseDir, isLikelyFilePath, isLikelyOfflineSyncError, isRemoteSyncBackend, normalizeFileSyncPath, resolveBackend, type SyncBackend } from './sync-service-utils';
import { ensureCloudKitReady, readRemoteCloudKit, writeRemoteCloudKit, isCloudKitAvailable } from './cloudkit-sync';
import { createWebdavSyncRateLimitController } from './sync-rate-limit';
import {
  SYNC_PATH_KEY,
  SYNC_BACKEND_KEY,
  WEBDAV_URL_KEY,
  WEBDAV_USERNAME_KEY,
  WEBDAV_PASSWORD_KEY,
  CLOUD_URL_KEY,
  CLOUD_TOKEN_KEY,
  CLOUD_PROVIDER_KEY,
  SYNC_PATH_BOOKMARK_KEY,
  DROPBOX_LAST_REV_KEY,
} from './sync-constants';

const DEFAULT_SYNC_TIMEOUT_MS = 30_000;
const WEBDAV_RETRY_OPTIONS = { maxAttempts: 5, baseDelayMs: 2000, maxDelayMs: 30_000 };
const WEBDAV_READ_RETRY_OPTIONS = { ...WEBDAV_RETRY_OPTIONS, shouldRetry: isRetryableWebdavReadError };
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ATTACHMENT_CLEANUP_BATCH_LIMIT = 25;
const SYNC_CONFIG_CACHE_TTL_MS = 30_000;
const SYNC_FILE_NAME = 'data.json';
const syncConfigCache = new Map<string, { value: string | null; readAt: number }>();
const IOS_TEMP_INBOX_PATH_PATTERN = /\/tmp\/[^/]*-Inbox\//i;
const INVALID_CONFIG_CHAR_PATTERN = /[\u0000-\u001F\u007F]/;
type MobileSyncActivityState = 'idle' | 'syncing';
type MobileSyncActivityListener = (state: MobileSyncActivityState) => void;
type MobileSyncSkipReason = 'offline' | 'requeued';
type MobileSyncResult = { success: boolean; stats?: MergeStats; error?: string; skipped?: MobileSyncSkipReason };
const isFossBuild = (() => {
  const extra = Constants.expoConfig?.extra as { isFossBuild?: unknown } | undefined;
  return extra?.isFossBuild === true || extra?.isFossBuild === 'true';
})();
const DROPBOX_SYNC_ENABLED = !isFossBuild;

const decodeUriSafe = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const logSyncWarning = (message: string, error?: unknown) => {
  const extra = error ? { error: sanitizeLogMessage(error instanceof Error ? error.message : String(error)) } : undefined;
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

const sanitizeConfigValue = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  if (!value) return null;
  if (INVALID_CONFIG_CHAR_PATTERN.test(value)) return null;
  return value;
};

const resolveCloudProvider = (value: string | null): CloudProvider => (
  normalizeCoreCloudProvider(value, { allowDropbox: DROPBOX_SYNC_ENABLED })
);

const getDropboxAppKey = (): string => {
  const extra = Constants.expoConfig?.extra as { dropboxAppKey?: unknown } | undefined;
  return typeof extra?.dropboxAppKey === 'string' ? extra.dropboxAppKey.trim() : '';
};

const isDropboxUnauthorizedError = (error: unknown): boolean => {
  if (error instanceof DropboxUnauthorizedError) return true;
  const message = sanitizeLogMessage(error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes('http 401')
    || message.includes('invalid_access_token')
    || message.includes('expired_access_token')
    || message.includes('unauthorized');
};

const externalCalendarProvider = {
  load: () => getExternalCalendars(),
  save: (calendars: AppData['settings']['externalCalendars'] | undefined) =>
    saveExternalCalendars(calendars ?? []),
  onWarn: (message: string, error?: unknown) => logSyncWarning(message, error),
};

const injectExternalCalendars = async (data: AppData): Promise<AppData> =>
  injectExternalCalendarsForSync(data, externalCalendarProvider);

const persistExternalCalendars = async (data: AppData): Promise<void> =>
  persistExternalCalendarsForSync(data, externalCalendarProvider);

let mobileSyncActivityState: MobileSyncActivityState = 'idle';
const mobileSyncActivityListeners = new Set<MobileSyncActivityListener>();
const webdavSyncRateLimitController = createWebdavSyncRateLimitController();
let activeMobileSyncAbortController: AbortController | null = null;
let activeMobileSyncAbortReason: 'lifecycle' | null = null;

const setMobileSyncActivityState = (next: MobileSyncActivityState) => {
  if (mobileSyncActivityState === next) return;
  mobileSyncActivityState = next;
  mobileSyncActivityListeners.forEach((listener) => {
    try {
      listener(next);
    } catch (error) {
      logSyncWarning('Failed to notify sync activity listener', error);
    }
  });
};

export const getMobileSyncActivityState = (): MobileSyncActivityState => mobileSyncActivityState;

export const subscribeMobileSyncActivityState = (listener: MobileSyncActivityListener): (() => void) => {
  mobileSyncActivityListeners.add(listener);
  listener(mobileSyncActivityState);
  return () => {
    mobileSyncActivityListeners.delete(listener);
  };
};

const readConfigValue = async (key: string, useCache = true): Promise<string | null> => {
  if (!useCache) {
    return sanitizeConfigValue(await AsyncStorage.getItem(key));
  }
  const now = Date.now();
  const cached = syncConfigCache.get(key);
  if (cached && now - cached.readAt <= SYNC_CONFIG_CACHE_TTL_MS) {
    return cached.value;
  }
  const value = sanitizeConfigValue(await AsyncStorage.getItem(key));
  syncConfigCache.set(key, { value, readAt: now });
  return value;
};

const getCachedConfigValue = async (key: string): Promise<string | null> => {
  return readConfigValue(key, true);
};

const getPathLeaf = (path: string): string => {
  const stripped = path.split('?')[0]?.split('#')[0]?.replace(/\/+$/, '') ?? '';
  const lastSlash = Math.max(stripped.lastIndexOf('/'), stripped.lastIndexOf('\\'));
  return lastSlash >= 0 ? stripped.slice(lastSlash + 1) : stripped;
};

const resolveBookmarkedFileSyncPath = async (syncPath: string | null): Promise<string | null> => {
  if (Platform.OS !== 'ios') return syncPath;

  const bookmark = (await getCachedConfigValue(SYNC_PATH_BOOKMARK_KEY))?.trim() ?? null;
  if (!bookmark) return syncPath;

  const bookmarkUri = await resolveSyncPathBookmark(bookmark);
  if (!bookmarkUri) return syncPath;

  let resolvedPath = bookmarkUri;
  if (syncPath && isLikelyFilePath(syncPath) && !isLikelyFilePath(bookmarkUri)) {
    const leafName = getPathLeaf(syncPath) || SYNC_FILE_NAME;
    resolvedPath = `${bookmarkUri.replace(/\/+$/, '')}/${leafName}`;
  }

  if (!syncPath || resolvedPath !== syncPath) {
    await AsyncStorage.setItem(SYNC_PATH_KEY, resolvedPath);
    syncConfigCache.set(SYNC_PATH_KEY, { value: resolvedPath, readAt: Date.now() });
    logSyncInfo('Resolved iOS sync-folder bookmark', {
      bookmarkPath: bookmarkUri,
      filePath: resolvedPath,
    });
  }

  return resolvedPath;
};

const getSupportedBackend = (rawBackend: string | null): SyncBackend =>
  coerceSupportedBackend(resolveBackend(rawBackend), isCloudKitAvailable());

export async function getMobileSyncConfigurationStatus(): Promise<{ backend: SyncBackend; configured: boolean }> {
  const rawBackend = (await readConfigValue(SYNC_BACKEND_KEY, false))?.trim() ?? null;
  const backend: SyncBackend = getSupportedBackend(rawBackend);

  if (backend === 'off') {
    return { backend, configured: false };
  }
  if (backend === 'file') {
    const syncPath = (await readConfigValue(SYNC_PATH_KEY, false))?.trim();
    return { backend, configured: Boolean(syncPath) };
  }
  if (backend === 'webdav') {
    const webdavUrl = (await readConfigValue(WEBDAV_URL_KEY, false))?.trim();
    return { backend, configured: Boolean(webdavUrl) };
  }
  if (backend === 'cloudkit') {
    // CloudKit is always "configured" if the module is available — no user credentials needed.
    return { backend, configured: isCloudKitAvailable() };
  }

  const cloudProvider = resolveCloudProvider((await readConfigValue(CLOUD_PROVIDER_KEY, false))?.trim() ?? null);
  if (cloudProvider === CLOUD_PROVIDER_DROPBOX) {
    return {
      backend,
      configured: DROPBOX_SYNC_ENABLED && getDropboxAppKey().length > 0,
    };
  }

  const cloudUrl = (await readConfigValue(CLOUD_URL_KEY, false))?.trim();
  const cloudToken = (await readConfigValue(CLOUD_TOKEN_KEY, false))?.trim();
  return {
    backend,
    configured: Boolean(cloudUrl && cloudToken),
  };
}

const getAttachmentsArray = (attachments: Attachment[] | undefined): Attachment[] => (
  Array.isArray(attachments) ? attachments : []
);

const buildOfflineSkipResult = (): MobileSyncResult => ({
  success: true,
  skipped: 'offline',
});

const buildRequeuedSkipResult = (): MobileSyncResult => ({
  success: true,
  skipped: 'requeued',
});

const shouldSkipSyncForOfflineState = async (backend: SyncBackend): Promise<boolean> => {
  if (!isRemoteSyncBackend(backend)) return false;
  try {
    const state = await Network.getNetworkStateAsync();
    const isConnected = state.isConnected ?? false;
    const isInternetReachable = state.isInternetReachable ?? isConnected;
    const isAirplaneModeEnabled = (() => {
      const value = (state as { isAirplaneModeEnabled?: unknown }).isAirplaneModeEnabled;
      return typeof value === 'boolean' ? value : false;
    })();

    if (isAirplaneModeEnabled || !isInternetReachable) {
      logSyncInfo('Sync skipped: offline/airplane mode', {
        backend,
        isConnected: String(isConnected),
        isInternetReachable: String(isInternetReachable),
        isAirplaneModeEnabled: String(isAirplaneModeEnabled),
      });
      return true;
    }
  } catch (error) {
    logSyncWarning('Failed to read network state before sync', error);
  }
  return false;
};

const findDeletedAttachmentsForFileCleanupLocal = (appData: AppData): Attachment[] => {
  const deleted = new Map<string, Attachment>();

  for (const task of appData.tasks) {
    for (const attachment of getAttachmentsArray(task.attachments)) {
      if (!attachment.deletedAt) continue;
      deleted.set(attachment.id, attachment);
    }
  }

  for (const project of appData.projects) {
    for (const attachment of getAttachmentsArray(project.attachments)) {
      if (!attachment.deletedAt) continue;
      deleted.set(attachment.id, attachment);
    }
  }

  return Array.from(deleted.values());
};

const deleteAttachmentFile = async (uri?: string): Promise<void> => {
  if (!uri) return;
  if (uri.startsWith('content://') || /^https?:\/\//i.test(uri)) return;
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch (error) {
    logSyncWarning('Failed to delete attachment file', error);
  }
};

const mobileSyncOrchestrator = createSyncOrchestrator<string | undefined, MobileSyncResult>({
  runCycle: async (syncPathOverride, { requestFollowUp }) => {
    const rawBackend = (await getCachedConfigValue(SYNC_BACKEND_KEY))?.trim() ?? null;
    const backend: SyncBackend = getSupportedBackend(rawBackend);

    if (backend === 'off') {
      return { success: true };
    }
    if (await shouldSkipSyncForOfflineState(backend)) {
      return buildOfflineSkipResult();
    }

    setMobileSyncActivityState('syncing');
    logSyncInfo('Sync start', { backend });

    let step = 'init';
    let syncUrl: string | undefined;
    let wroteLocal = false;
    let localSnapshotChangeAt = useTaskStore.getState().lastDataChangeAt;
    let networkWentOffline = false;
    let networkSubscription: { remove?: () => void } | null = null;
    let preSyncedLocalData: AppData | null = null;
    const requestAbortController = new AbortController();
    activeMobileSyncAbortController = requestAbortController;
    activeMobileSyncAbortReason = null;
    const fetchWithAbort = createAbortableFetch(fetch, { baseSignal: requestAbortController.signal });
    const ensureLocalSnapshotFresh = () => {
      if (useTaskStore.getState().lastDataChangeAt > localSnapshotChangeAt) {
        requestFollowUp(syncPathOverride);
        throw new LocalSyncAbort();
      }
    };
    const ensureWebdavSyncNotRateLimited = () => {
      webdavSyncRateLimitController.assertReady(backend);
    };
    const handleWebdavRateLimit = (error: unknown) => {
      if (!webdavSyncRateLimitController.noteError(backend, error)) return;
      logSyncWarning('WebDAV rate limited; pausing remote sync', error);
    };
    const ensureNetworkStillAvailable = async () => {
      if (!isRemoteSyncBackend(backend)) return;
      if (networkWentOffline) {
        requestAbortController.abort();
        throw new Error('Sync paused: offline state detected');
      }
      if (await shouldSkipSyncForOfflineState(backend)) {
        networkWentOffline = true;
        requestAbortController.abort();
        throw new Error('Sync paused: offline state detected');
      }
    };
    try {
      if (isRemoteSyncBackend(backend)) {
        try {
          networkSubscription = Network.addNetworkStateListener((state) => {
            const isConnected = state.isConnected ?? false;
            const isInternetReachable = state.isInternetReachable ?? isConnected;
            const isAirplaneModeEnabled = (() => {
              const value = (state as { isAirplaneModeEnabled?: unknown }).isAirplaneModeEnabled;
              return typeof value === 'boolean' ? value : false;
            })();
            if (isAirplaneModeEnabled || !isInternetReachable) {
              networkWentOffline = true;
              requestAbortController.abort();
            }
          });
        } catch (error) {
          logSyncWarning('Failed to subscribe to network state during sync', error);
        }
      }
      let webdavConfig: { url: string; username: string; password: string } | null = null;
      let cloudConfig: { url: string; token: string } | null = null;
      let cloudProvider: CloudProvider = CLOUD_PROVIDER_SELF_HOSTED;
      let dropboxClientId = '';
      let dropboxLastRev: string | null = null;
      let fileSyncPath: string | null = null;
      let remoteDataForCompare: AppData | null = null;
      let webdavRemoteCorrupted = false;
      step = 'flush';
      await flushPendingSave();
      localSnapshotChangeAt = useTaskStore.getState().lastDataChangeAt;
      if (backend === 'file') {
        const configuredSyncPath = (await getCachedConfigValue(SYNC_PATH_KEY))?.trim() ?? null;
        fileSyncPath = syncPathOverride || configuredSyncPath;
        fileSyncPath = await resolveBookmarkedFileSyncPath(fileSyncPath);
        if (!fileSyncPath) {
          return { success: true };
        }
        const normalizedPath = normalizeFileSyncPath(fileSyncPath, Platform.OS);
        if (normalizedPath && normalizedPath !== fileSyncPath) {
          fileSyncPath = normalizedPath;
          await AsyncStorage.setItem(SYNC_PATH_KEY, normalizedPath);
          syncConfigCache.set(SYNC_PATH_KEY, { value: normalizedPath, readAt: Date.now() });
          logSyncInfo('Normalized file sync path to iOS file URI');
        }
        if (fileSyncPath.startsWith('file://') && IOS_TEMP_INBOX_PATH_PATTERN.test(decodeUriSafe(fileSyncPath))) {
          throw new Error('Selected iOS sync file is in a temporary Inbox location and is read-only. Re-select a folder in Settings -> Data & Sync.');
        }
        if (fileSyncPath.startsWith('content://')) {
          try {
            const resolvedPath = await resolveSyncFileUri(fileSyncPath, { createIfMissing: true });
            if (resolvedPath && resolvedPath !== fileSyncPath) {
              await AsyncStorage.setItem(SYNC_PATH_KEY, resolvedPath);
              syncConfigCache.set(SYNC_PATH_KEY, { value: resolvedPath, readAt: Date.now() });
              logSyncInfo('Normalized SAF sync path');
              fileSyncPath = resolvedPath;
            }
          } catch (error) {
            logSyncWarning('Failed to normalize SAF sync path', error);
          }
        } else if (!isLikelyFilePath(fileSyncPath)) {
          const trimmed = fileSyncPath.replace(/\/+$/, '');
          fileSyncPath = `${trimmed}/${SYNC_FILE_NAME}`;
        }
      }
      if (backend === 'webdav') {
        const url = (await getCachedConfigValue(WEBDAV_URL_KEY))?.trim() ?? null;
        if (!url) throw new Error('WebDAV URL not configured');
        syncUrl = normalizeWebdavUrl(url);
        const username = (await getCachedConfigValue(WEBDAV_USERNAME_KEY)) ?? '';
        const password = (await getCachedConfigValue(WEBDAV_PASSWORD_KEY)) ?? '';
        webdavConfig = { url: syncUrl, username, password };
      }
      if (backend === 'cloud') {
        const storedCloudProvider = (await getCachedConfigValue(CLOUD_PROVIDER_KEY))?.trim() ?? null;
        cloudProvider = resolveCloudProvider(storedCloudProvider);
        if (!DROPBOX_SYNC_ENABLED && storedCloudProvider === CLOUD_PROVIDER_DROPBOX) {
          logSyncInfo('Dropbox cloud provider disabled in FOSS build; using self-hosted backend');
        }
        if (cloudProvider === CLOUD_PROVIDER_DROPBOX) {
          dropboxClientId = getDropboxAppKey();
          if (!dropboxClientId) {
            throw new Error('Dropbox app key is not configured');
          }
          dropboxLastRev = (await getCachedConfigValue(DROPBOX_LAST_REV_KEY))?.trim() ?? null;
          syncUrl = 'dropbox://Apps/Mindwtr/data.json';
        } else {
          const url = (await getCachedConfigValue(CLOUD_URL_KEY))?.trim() ?? null;
          if (!url) throw new Error('Self-hosted URL not configured');
          syncUrl = normalizeCloudUrl(url);
          const token = (await getCachedConfigValue(CLOUD_TOKEN_KEY))?.trim() ?? '';
          cloudConfig = { url: syncUrl, token };
        }
      }
      const runDropboxOperation = async <T,>(
        operation: (accessToken: string) => Promise<T>
      ): Promise<T> => {
        let accessToken = await getValidDropboxAccessToken(dropboxClientId, fetchWithAbort);
        try {
          return await operation(accessToken);
        } catch (error) {
          if (!isDropboxUnauthorizedError(error)) throw error;
          accessToken = await forceRefreshDropboxAccessToken(dropboxClientId, fetchWithAbort);
          return operation(accessToken);
        }
      };

      // CloudKit setup — ensure zone and subscription exist before sync cycle.
      if (backend === 'cloudkit') {
        if (!isCloudKitAvailable()) {
          throw new Error('CloudKit is not available on this platform');
        }
        step = 'cloudkit_setup';
        logSyncInfo('Sync step', { step });
        await ensureCloudKitReady();
      }

      // Pre-sync local attachments so cloudKeys exist before writing remote data.
      step = 'attachments_prepare';
      logSyncInfo('Sync step', { step });
      try {
        const persistedData = await mobileStorage.getData();
        const localData = mergeAppData(persistedData, getInMemoryAppDataSnapshot());
        let preMutated = false;
        if (backend === 'webdav' && webdavConfig?.url) {
          const baseSyncUrl = getBaseSyncUrl(webdavConfig.url);
          preMutated = await syncWebdavAttachments(localData, webdavConfig, baseSyncUrl);
        } else if (backend === 'cloud' && cloudProvider === CLOUD_PROVIDER_SELF_HOSTED && cloudConfig?.url) {
          const baseSyncUrl = getCloudBaseUrl(cloudConfig.url);
          preMutated = await syncCloudAttachments(localData, cloudConfig, baseSyncUrl);
        } else if (backend === 'cloud' && cloudProvider === CLOUD_PROVIDER_DROPBOX) {
          preMutated = await syncDropboxAttachments(localData, dropboxClientId, fetchWithAbort);
        } else if (backend === 'file' && fileSyncPath) {
          preMutated = await syncFileAttachments(localData, fileSyncPath);
        }
        if (preMutated) {
          // Capture pre-sync attachment mutations before stale-snapshot checks so we can persist them on abort.
          preSyncedLocalData = localData;
          ensureLocalSnapshotFresh();
        }
        logSyncInfo('Attachment pre-sync complete', {
          backend,
          mutated: preMutated ? 'true' : 'false',
        });
      } catch (error) {
        if (error instanceof LocalSyncAbort) {
          throw error;
        }
        logSyncWarning('Attachment pre-sync warning; continuing sync merge', error);
      }

      const readRemoteDataByBackend = async (): Promise<AppData | null> => {
        await ensureNetworkStillAvailable();
        if (backend === 'webdav' && webdavConfig?.url) {
          ensureWebdavSyncNotRateLimited();
          try {
            const data = await withRetry(
              () =>
                webdavGetJson<AppData>(webdavConfig.url, {
                  username: webdavConfig.username,
                  password: webdavConfig.password,
                  timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
                  fetcher: fetchWithAbort,
                }),
              WEBDAV_READ_RETRY_OPTIONS
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
            handleWebdavRateLimit(error);
            throw error;
          }
        }
        if (backend === 'cloud' && cloudConfig?.url) {
          const data = await cloudGetJson<AppData>(cloudConfig.url, {
            token: cloudConfig.token,
            timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
            fetcher: fetchWithAbort,
          });
          remoteDataForCompare = data ?? null;
          return data;
        }
        if (backend === 'cloud' && cloudProvider === CLOUD_PROVIDER_DROPBOX) {
          const { data, rev } = await runDropboxOperation((accessToken) =>
            downloadDropboxAppData(accessToken, fetchWithAbort)
          );
          dropboxLastRev = rev;
          if (rev) {
            await AsyncStorage.setItem(DROPBOX_LAST_REV_KEY, rev);
            syncConfigCache.set(DROPBOX_LAST_REV_KEY, { value: rev, readAt: Date.now() });
          } else {
            await AsyncStorage.removeItem(DROPBOX_LAST_REV_KEY);
            syncConfigCache.set(DROPBOX_LAST_REV_KEY, { value: null, readAt: Date.now() });
          }
          remoteDataForCompare = data ?? null;
          return data;
        }
        if (backend === 'cloudkit') {
          const data = await readRemoteCloudKit();
          remoteDataForCompare = data ?? null;
          return data;
        }
        if (!fileSyncPath) {
          throw new Error('No sync folder configured');
        }
        const data = await readSyncFile(fileSyncPath);
        remoteDataForCompare = data ?? null;
        return data;
      };

      const prepareRemoteWriteData = async (data: AppData): Promise<AppData> => {
        const pendingUploads = findPendingAttachmentUploads(data);
        if (pendingUploads.length === 0) {
          return data;
        }

        step = 'attachments_finalize';
        logSyncInfo('Sync step', { step });
        logSyncInfo('Attachment final sync start', {
          backend,
          pending: String(pendingUploads.length),
        });

        if (backend === 'webdav' && webdavConfig?.url) {
          await ensureNetworkStillAvailable();
          const baseSyncUrl = getBaseSyncUrl(webdavConfig.url);
          await syncWebdavAttachments(data, webdavConfig, baseSyncUrl);
        } else if (backend === 'cloud' && cloudProvider === CLOUD_PROVIDER_SELF_HOSTED && cloudConfig?.url) {
          await ensureNetworkStillAvailable();
          const baseSyncUrl = getCloudBaseUrl(cloudConfig.url);
          await syncCloudAttachments(data, cloudConfig, baseSyncUrl);
        } else if (backend === 'cloud' && cloudProvider === CLOUD_PROVIDER_DROPBOX) {
          await ensureNetworkStillAvailable();
          await syncDropboxAttachments(data, dropboxClientId, fetchWithAbort);
        } else if (backend === 'file' && fileSyncPath) {
          await syncFileAttachments(data, fileSyncPath);
        }

        const remainingUploads = findPendingAttachmentUploads(data);
        logSyncInfo('Attachment final sync done', {
          backend,
          pending: String(remainingUploads.length),
        });

        return data;
      };

      const writeRemoteDataByBackend = async (data: AppData): Promise<void> => {
        await ensureNetworkStillAvailable();
        assertNoPendingAttachmentUploads(data);
        const sanitized = sanitizeAppDataForRemote(data);
        const remoteSanitized = remoteDataForCompare
          ? sanitizeAppDataForRemote(remoteDataForCompare)
          : null;
        if (remoteSanitized && areSyncPayloadsEqual(remoteSanitized, sanitized)) {
          return;
        }
        if (backend === 'webdav') {
          if (!webdavConfig?.url) throw new Error('WebDAV URL not configured');
          ensureWebdavSyncNotRateLimited();
          if (webdavRemoteCorrupted) {
            logSyncInfo('Repairing corrupted WebDAV data.json with current merged data');
          }
          try {
            await withRetry(
              () =>
                webdavPutJson(webdavConfig.url, sanitized, {
                  username: webdavConfig.username,
                  password: webdavConfig.password,
                  timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
                  fetcher: fetchWithAbort,
                }),
              WEBDAV_RETRY_OPTIONS
            );
          } catch (error) {
            handleWebdavRateLimit(error);
            throw error;
          }
          remoteDataForCompare = sanitized;
          webdavRemoteCorrupted = false;
          return;
        }
        if (backend === 'cloud') {
          if (cloudProvider === CLOUD_PROVIDER_DROPBOX) {
            try {
              const result = await runDropboxOperation((accessToken) =>
                uploadDropboxAppData(accessToken, sanitized, dropboxLastRev, fetchWithAbort)
              );
              dropboxLastRev = result.rev;
              if (result.rev) {
                await AsyncStorage.setItem(DROPBOX_LAST_REV_KEY, result.rev);
                syncConfigCache.set(DROPBOX_LAST_REV_KEY, { value: result.rev, readAt: Date.now() });
              } else {
                await AsyncStorage.removeItem(DROPBOX_LAST_REV_KEY);
                syncConfigCache.set(DROPBOX_LAST_REV_KEY, { value: null, readAt: Date.now() });
              }
              remoteDataForCompare = sanitized;
              return;
            } catch (error) {
              if (error instanceof DropboxConflictError) {
                // Another device wrote between readRemote and writeRemote; retry next cycle.
                requestFollowUp(syncPathOverride);
                throw new LocalSyncAbort();
              }
              throw error;
            }
          }
          if (!cloudConfig?.url) throw new Error('Self-hosted URL not configured');
          await cloudPutJson(cloudConfig.url, sanitized, {
            token: cloudConfig.token,
            timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
            fetcher: fetchWithAbort,
          });
          remoteDataForCompare = sanitized;
          return;
        }
        if (backend === 'cloudkit') {
          await writeRemoteCloudKit(sanitized as AppData);
          remoteDataForCompare = sanitized;
          return;
        }
        if (!fileSyncPath) throw new Error('No sync folder configured');
        await writeSyncFile(fileSyncPath, sanitized);
        remoteDataForCompare = sanitized;
      };

      const syncResult = await performSyncCycle({
        readLocal: async () => {
          const inMemorySnapshot = getInMemoryAppDataSnapshot();
          const baseData = preSyncedLocalData
            ? mergeAppData(preSyncedLocalData, inMemorySnapshot)
            : mergeAppData(await mobileStorage.getData(), inMemorySnapshot);
          const data = await injectExternalCalendars(baseData);
          localSnapshotChangeAt = useTaskStore.getState().lastDataChangeAt;
          return data;
        },
        readRemote: readRemoteDataByBackend,
        writeLocal: async (data) => {
          ensureLocalSnapshotFresh();
          await mobileStorage.saveData(data);
          wroteLocal = true;
        },
        prepareRemoteWrite: prepareRemoteWriteData,
        writeRemote: async (data) => {
          ensureLocalSnapshotFresh();
          await writeRemoteDataByBackend(data);
        },
        onStep: (next) => {
          step = next;
          logSyncInfo('Sync step', { step });
        },
        historyContext: {
          backend,
          type: 'merge',
        },
      });

      const stats = syncResult.stats;
      const conflictCount = (stats.tasks.conflicts || 0)
        + (stats.projects.conflicts || 0)
        + (stats.sections.conflicts || 0)
        + (stats.areas.conflicts || 0);
      const maxClockSkewMs = Math.max(
        stats.tasks.maxClockSkewMs || 0,
        stats.projects.maxClockSkewMs || 0,
        stats.sections.maxClockSkewMs || 0,
        stats.areas.maxClockSkewMs || 0,
      );
      const timestampAdjustments = (stats.tasks.timestampAdjustments || 0)
        + (stats.projects.timestampAdjustments || 0)
        + (stats.sections.timestampAdjustments || 0)
        + (stats.areas.timestampAdjustments || 0);
      if (conflictCount > 0 || maxClockSkewMs > CLOCK_SKEW_THRESHOLD_MS || timestampAdjustments > 0) {
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
      let mergedData = syncResult.data;
      ensureLocalSnapshotFresh();
      await persistExternalCalendars(mergedData);

      const webdavConfigValue = webdavConfig as { url: string; username: string; password: string } | null;
      const cloudConfigValue = cloudConfig as { url: string; token: string } | null;
      const applyAttachmentSyncMutation = async (
        syncAttachments: (candidateData: AppData) => Promise<boolean>
      ): Promise<void> => {
        const candidateData = cloneAppData(mergedData);
        const mutated = await syncAttachments(candidateData);
        if (!mutated) return;
        ensureLocalSnapshotFresh();
        mergedData = candidateData;
        await mobileStorage.saveData(mergedData);
        wroteLocal = true;
      };

      if (backend === 'webdav' && webdavConfigValue?.url) {
        step = 'attachments';
        logSyncInfo('Sync step', { step });
        ensureLocalSnapshotFresh();
        await ensureNetworkStillAvailable();
        const baseSyncUrl = getBaseSyncUrl(webdavConfigValue.url);
        await applyAttachmentSyncMutation((candidateData) =>
          syncWebdavAttachments(candidateData, webdavConfigValue, baseSyncUrl)
        );
      }

      if (backend === 'cloud' && cloudProvider === CLOUD_PROVIDER_SELF_HOSTED && cloudConfigValue?.url) {
        step = 'attachments';
        logSyncInfo('Sync step', { step });
        ensureLocalSnapshotFresh();
        await ensureNetworkStillAvailable();
        const baseSyncUrl = getCloudBaseUrl(cloudConfigValue.url);
        await applyAttachmentSyncMutation((candidateData) =>
          syncCloudAttachments(candidateData, cloudConfigValue, baseSyncUrl)
        );
      }

      if (backend === 'cloud' && cloudProvider === CLOUD_PROVIDER_DROPBOX) {
        step = 'attachments';
        logSyncInfo('Sync step', { step });
        ensureLocalSnapshotFresh();
        await ensureNetworkStillAvailable();
        await applyAttachmentSyncMutation((candidateData) =>
          syncDropboxAttachments(candidateData, dropboxClientId, fetchWithAbort)
        );
      }

      if (backend === 'file' && fileSyncPath) {
        step = 'attachments';
        logSyncInfo('Sync step', { step });
        ensureLocalSnapshotFresh();
        await applyAttachmentSyncMutation((candidateData) =>
          syncFileAttachments(candidateData, fileSyncPath)
        );
      }

      await cleanupAttachmentTempFiles();

      if (shouldRunAttachmentCleanup(mergedData.settings.attachments?.lastCleanupAt, CLEANUP_INTERVAL_MS)) {
        step = 'attachments_cleanup';
        logSyncInfo('Sync step', { step });
        ensureLocalSnapshotFresh();
        await ensureNetworkStillAvailable();
        const orphaned = findOrphanedAttachments(mergedData);
        const deletedAttachments = findDeletedAttachmentsForFileCleanupLocal(mergedData);
        const cleanupTargets = new Map<string, Attachment>();
        for (const attachment of orphaned) cleanupTargets.set(attachment.id, attachment);
        for (const attachment of deletedAttachments) cleanupTargets.set(attachment.id, attachment);
        if (cleanupTargets.size > 0) {
          const isFileBackend = backend === 'file';
          const isWebdavBackend = backend === 'webdav' && webdavConfigValue?.url;
          const isCloudBackend = backend === 'cloud'
            && cloudProvider === CLOUD_PROVIDER_SELF_HOSTED
            && cloudConfigValue?.url;
          const isDropboxBackend = backend === 'cloud'
            && cloudProvider === CLOUD_PROVIDER_DROPBOX;
          const fileBaseDir = isFileBackend && fileSyncPath && !fileSyncPath.startsWith('content://')
            ? getFileSyncBaseDir(fileSyncPath)
            : null;
          let processedCount = 0;
          const reachedBatchLimit = cleanupTargets.size > ATTACHMENT_CLEANUP_BATCH_LIMIT;
          const orphanedIds = new Set(orphaned.map((attachment) => attachment.id));
          const processedOrphanedIds = new Set<string>();

          for (const attachment of cleanupTargets.values()) {
            if (processedCount >= ATTACHMENT_CLEANUP_BATCH_LIMIT) {
              break;
            }
            processedCount += 1;
            if (orphanedIds.has(attachment.id)) {
              processedOrphanedIds.add(attachment.id);
            }
            ensureLocalSnapshotFresh();
            await deleteAttachmentFile(attachment.uri);
            if (attachment.cloudKey) {
              try {
                if (isWebdavBackend && webdavConfigValue) {
                  const baseSyncUrl = getBaseSyncUrl(webdavConfigValue.url);
                  await webdavDeleteFile(`${baseSyncUrl}/${attachment.cloudKey}`, {
                    username: webdavConfigValue.username,
                    password: webdavConfigValue.password,
                    timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
                    fetcher: fetchWithAbort,
                  });
                } else if (isCloudBackend && cloudConfigValue) {
                  const baseSyncUrl = getCloudBaseUrl(cloudConfigValue.url);
                  await cloudDeleteFile(`${baseSyncUrl}/${attachment.cloudKey}`, {
                    token: cloudConfigValue.token,
                    timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
                    fetcher: fetchWithAbort,
                  });
                } else if (isDropboxBackend) {
                  await runDropboxOperation((accessToken) =>
                    deleteDropboxFile(accessToken, attachment.cloudKey as string, fetchWithAbort)
                  );
                } else if (fileBaseDir) {
                  const targetPath = `${fileBaseDir}/${attachment.cloudKey}`;
                  await FileSystem.deleteAsync(targetPath, { idempotent: true });
                }
              } catch (error) {
                logSyncWarning('Failed to delete remote attachment', error);
              }
            }
          }
          if (reachedBatchLimit) {
            logSyncInfo('Attachment cleanup batch limit reached', {
              limit: String(ATTACHMENT_CLEANUP_BATCH_LIMIT),
              total: String(cleanupTargets.size),
            });
          }
          if (orphaned.length > 0 && reachedBatchLimit) {
            mergedData = removeAttachmentsByIdFromData(mergedData, processedOrphanedIds);
          } else if (orphaned.length > 0) {
            mergedData = removeOrphanedAttachmentsFromData(mergedData);
          }
        }
        mergedData.settings.attachments = {
          ...mergedData.settings.attachments,
          lastCleanupAt: new Date().toISOString(),
        };
        ensureLocalSnapshotFresh();
        await mobileStorage.saveData(mergedData);
        wroteLocal = true;
      }

      step = 'refresh';
      ensureLocalSnapshotFresh();
      await useTaskStore.getState().fetchData();
      const now = new Date().toISOString();
      try {
        await useTaskStore.getState().updateSettings({
          lastSyncAt: now,
          lastSyncStatus: syncResult.status,
          lastSyncError: undefined,
        });
      } catch (error) {
        logSyncWarning('[Mobile] Failed to persist sync status', error);
      }
      return { success: true, stats: syncResult.stats };
    } catch (error) {
      if (requestAbortController.signal.aborted && activeMobileSyncAbortReason === 'lifecycle') {
        logSyncInfo('Sync aborted by app lifecycle transition', { backend, step });
        requestFollowUp(syncPathOverride);
        return { success: true };
      }
      if (error instanceof LocalSyncAbort) {
        if (preSyncedLocalData && !wroteLocal) {
          const inMemorySnapshot = getInMemoryAppDataSnapshot();
          const reconciledData = mergeAppData(preSyncedLocalData, inMemorySnapshot);
          await mobileStorage.saveData(reconciledData);
          wroteLocal = true;
        }
        return buildRequeuedSkipResult();
      }
      if (isRemoteSyncBackend(backend) && (networkWentOffline || isLikelyOfflineSyncError(error))) {
        if (preSyncedLocalData && !wroteLocal) {
          const inMemorySnapshot = getInMemoryAppDataSnapshot();
          const reconciledData = mergeAppData(preSyncedLocalData, inMemorySnapshot);
          await mobileStorage.saveData(reconciledData);
          wroteLocal = true;
        }
        if (wroteLocal) {
          try {
            await useTaskStore.getState().fetchData();
          } catch (fetchError) {
            logSyncWarning('[Mobile] Failed to refresh store after offline sync skip', fetchError);
          }
        }
        logSyncInfo('Sync skipped after offline detection', { backend, step });
        return buildOfflineSkipResult();
      }
      const now = new Date().toISOString();
      const logPath = await logSyncError(error, { backend, step, url: syncUrl });
      const logHint = logPath ? ` (log: ${logPath})` : '';
      const safeMessage = formatSyncErrorMessage(error, backend);
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
        error: `${safeMessage}${logHint}`,
      });
      try {
        if (wroteLocal) {
          await useTaskStore.getState().fetchData();
        }
        await useTaskStore.getState().updateSettings({
          lastSyncAt: now,
          lastSyncStatus: 'error',
          lastSyncError: `${safeMessage}${logHint}`,
          lastSyncStats: undefined,
          lastSyncHistory: nextHistory,
        });
      } catch (e) {
        logSyncWarning('[Mobile] Failed to persist sync error', e);
      }

      return { success: false, error: `${safeMessage}${logHint}` };
    } finally {
      if (activeMobileSyncAbortController === requestAbortController) {
        activeMobileSyncAbortController = null;
        activeMobileSyncAbortReason = null;
      }
      try {
        networkSubscription?.remove?.();
      } catch (error) {
        logSyncWarning('Failed to unsubscribe network listener after sync', error);
      }
    }
  },
  onQueuedRunComplete: (queuedResult) => {
    if (!queuedResult.success) {
      logSyncWarning('[Mobile] Queued sync failed', queuedResult.error);
    }
  },
  onQueuedRunError: (error) => {
    logSyncWarning('[Mobile] Queued sync crashed', error);
  },
  onDrained: () => {
    setMobileSyncActivityState('idle');
  },
});

export async function performMobileSync(syncPathOverride?: string): Promise<MobileSyncResult> {
  return mobileSyncOrchestrator.run(syncPathOverride);
}

export function abortMobileSync(): boolean {
  if (!activeMobileSyncAbortController) return false;
  activeMobileSyncAbortReason = 'lifecycle';
  activeMobileSyncAbortController.abort();
  return true;
}

export const __mobileSyncTestUtils = {
  reset() {
    mobileSyncOrchestrator.reset();
    syncConfigCache.clear();
    mobileSyncActivityListeners.clear();
    mobileSyncActivityState = 'idle';
    webdavSyncRateLimitController.reset();
    activeMobileSyncAbortController = null;
    activeMobileSyncAbortReason = null;
  },
  getWebdavSyncBlockedUntil() {
    return webdavSyncRateLimitController.getBlockedUntil();
  },
};
