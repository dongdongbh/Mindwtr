import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { AppData, acquireSyncRemoteMutationFence, assertWebdavStrongEtagSupport, createDropboxSyncRemoteMutationFencePort, createSyncOrchestrator, createWebdavSyncRemoteMutationFencePort, runSerializedSyncDocumentOperation, runSharedSyncCycle, useTaskStore, webdavGetSyncDocument, webdavHeadFile, webdavPutSyncDocument, syncEncryptedArtifactName, markRemoteEncryptionDiscovered, markRemotePlaintextDiscovered, SyncEncryptionRemoteConflictError, SyncEncryptionRemotePlaintextError, SyncEncryptionRemoteVersionUnavailableError, SyncEncryptionTerminalError, SyncEncryptionTransitionIncompleteError, SyncRemoteWriteConflict, type SyncKeyMaterial, cloudGetJson, cloudHeadJson, cloudPutJson, flushPendingSave, performSyncCycle, withRetry, isRetryableError, isRetryableWebdavReadError, isWebdavInvalidJsonError, normalizeStrongWebdavEtag, normalizeWebdavUrl, normalizeCloudUrl, createSyncBackendIO, buildFastSyncScope, hasPendingSyncSideEffects, injectExternalCalendars as injectExternalCalendarsForSync, persistExternalCalendars as persistExternalCalendarsForSync, getInMemoryAppDataSnapshot, createAbortableFetch, normalizeCloudProvider as normalizeCoreCloudProvider, isDropboxUnauthorizedError, parseFastSyncState, serializeFastSyncState, summarizeTaskLifecycleCounts, decodeUriSafe, buildSyncPayloadTraceExtra, isSyncPayloadTraceEnabled, SYNC_TRACE_EVENT_MESSAGES, SYNC_FILE_NAME, SYNC_REMOTE_MUTATION_REQUEST_HORIZON_MS, CLOUD_PROVIDER_DROPBOX, CLOUD_PROVIDER_SELF_HOSTED, type Attachment, type CloudProvider, type FastSyncState, type SyncBackendContext, type SyncBackendIO, type SyncRunDiagnosticEvent, type SyncRunNotifier, type SyncRunPlatformHooks, type SyncRunResult, type SyncRunStorage, type SyncTransport } from '@mindwtr/core';
import { mobileStorage } from './storage-adapter';
import { logInfo, logSyncError, logWarn, sanitizeLogMessage } from './app-log';
import { readSyncFileVersioned, resolveSyncFileUri, writeSyncFile } from './storage-file';
import { isSyncPathBookmarksAvailable, resolveSyncPathBookmark } from './sync-path-bookmarks';
import { getBaseSyncUrl, getCloudBaseUrl, syncCloudAttachments, syncCloudKitAttachments, syncDropboxAttachments, syncFileAttachments, syncWebdavAttachments, cleanupAttachmentTempFiles, hasPendingAttachmentSyncWork } from './attachment-sync';
import { runMobileAttachmentCleanup } from './sync-attachment-cleanup';
import { getExternalCalendars, saveExternalCalendars } from './external-calendar';
import {
  forceRefreshDropboxAccessToken,
  forceRefreshDropboxAccessTokenForTokens,
  getValidDropboxAccessToken,
  getValidDropboxAccessTokenForTokens,
  isDropboxConnected,
  type DropboxAuthTokens,
} from './dropbox-auth';
import {
  DropboxFileNotFoundError,
  deleteDropboxFileVersioned,
  downloadDropboxAppData,
  getDropboxAppDataMetadata,
  getDropboxFileMetadata,
  uploadDropboxAppData,
} from './dropbox-sync';
import * as Network from 'expo-network';
import { coerceSupportedBackend, formatSyncErrorMessage, isLikelyFilePath, isLikelyOfflineSyncError, isRemoteSyncBackend, normalizeFileSyncPath, resolveBackend, type SyncBackend } from './sync-service-utils';
import { ensureCloudKitReady, readRemoteCloudKit, writeRemoteCloudKit, isCloudKitAvailable } from './cloudkit-sync';
import { createWebdavSyncRateLimitController } from './sync-rate-limit';
import {
  SYNC_PATH_KEY,
  SYNC_BACKEND_KEY,
  WEBDAV_URL_KEY,
  WEBDAV_USERNAME_KEY,
  WEBDAV_PASSWORD_KEY,
  WEBDAV_ALLOW_INSECURE_HTTP_KEY,
  WEBDAV_ALLOW_WEAK_FINGERPRINT_KEY,
  CLOUD_URL_KEY,
  CLOUD_TOKEN_KEY,
  CLOUD_PROVIDER_KEY,
  CLOUD_ALLOW_INSECURE_HTTP_KEY,
  SYNC_PATH_BOOKMARK_KEY,
  DROPBOX_LAST_REV_KEY,
} from './sync-constants';
import { getSecureConfigValue, isSecretConfigKey } from './secure-config';
import { mobileSyncCryptoPrimitives } from './sync-crypto-native';
import {
  flushSyncEncryptionLocalState,
  getIncompleteSyncEncryptionTransition,
  getSyncEncryptionMaterial,
  isSyncEncryptionBlocked,
  SyncEncryptionNoKeyError,
  SyncEncryptionStateUnavailableError,
  syncEncryptionLocalState,
} from './sync-encryption-state';

// Phase 3 imports the sync-encryption surface from the sync-service layer (pinned API
// location); the implementation lives next door in sync-encryption-service.ts.
export {
  changeSyncEncryptionPassphrase,
  declineSyncEncryptionPassphrase,
  disableSyncEncryption,
  enableSyncEncryption,
  getSyncEncryptionStatus,
  provideSyncEncryptionPassphrase,
  type SyncEncryptionTransitionOptions,
} from './sync-encryption-service';

/** Encryption-class failures must never be mistaken for transport failures (they must
 *  not feed the WebDAV rate limiter) nor for generic permission errors in the toast
 *  mapping — see classifySyncFailure in sync-service-utils.ts. */
const isSyncEncryptionError = (error: unknown): boolean =>
  error instanceof SyncEncryptionNoKeyError
  || error instanceof SyncEncryptionStateUnavailableError
  || error instanceof SyncEncryptionRemotePlaintextError
  || error instanceof SyncEncryptionTerminalError
  || error instanceof SyncEncryptionTransitionIncompleteError;
import { getMobileCloudRequestOptions, getMobileWebDavRequestOptions } from './webdav-request-options';
import { ensureWebdavCapabilityProof } from './webdav-capability-proof';
import { acquireMobileFileSyncLease, releaseMobileFileSyncLease } from './sync-file-lock';

const DEFAULT_SYNC_TIMEOUT_MS = 30_000;
const WEBDAV_RETRY_OPTIONS = { maxAttempts: 5, baseDelayMs: 2000, maxDelayMs: 30_000 };
const WEBDAV_READ_RETRY_OPTIONS = { ...WEBDAV_RETRY_OPTIONS, shouldRetry: isRetryableWebdavReadError };
const DROPBOX_RETRY_OPTIONS = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 8000 };
const SYNC_CONFIG_CACHE_TTL_MS = 30_000;
const FAST_SYNC_STATE_KEY = '@mindwtr_fast_sync_state_v1';
const LOCAL_SYNC_STATUS_KEY = '@mindwtr_local_sync_status_v1';
const syncConfigCache = new Map<string, { value: string | null; readAt: number }>();

type LocalSyncStatus = Pick<AppData['settings'], 'lastSyncAt' | 'lastSyncStatus' | 'lastSyncError' | 'lastSyncStats' | 'lastSyncHistory'>;

const IOS_TEMP_INBOX_PATH_PATTERN = /\/tmp\/[^/]*-Inbox\//i;
const INVALID_CONFIG_CHAR_PATTERN = /[\u0000-\u001F\u007F]/;
type MobileSyncActivityState = 'idle' | 'syncing';
type MobileSyncActivityListener = (state: MobileSyncActivityState) => void;
// 'disabled' surfaces from the shared core cycle for any no-op setup: sync off,
// an unresolvable file-backend config, or an automatic run without the
// encryption key. Mobile callers gate on configuration status before syncing,
// so none branch on it today.
// 'network': the OS reported the device offline. 'request': the device looked
// online but the app's requests failed (per-app cellular block, VPN/firewall).
type MobileSyncOfflineCause = 'network' | 'request';
type MobileSyncResult = SyncRunResult & { offlineCause?: MobileSyncOfflineCause; activationProof?: 'remote-encrypted-no-key' };
export type MobileWebDavSyncConfig = { url: string; username: string; password: string; allowInsecureHttp?: boolean; allowWeakFingerprint?: boolean };
export type MobileCloudSyncConfig = { url: string; token: string; allowInsecureHttp?: boolean };
export type MobileDropboxSyncCredentials = { tokens: DropboxAuthTokens };
export type MobileSyncConfigOverride = {
  backend: SyncBackend;
  syncPath?: string;
  syncPathBookmark?: string | null;
  webdav?: MobileWebDavSyncConfig;
  cloudProvider?: CloudProvider;
  cloud?: MobileCloudSyncConfig;
  dropbox?: MobileDropboxSyncCredentials;
};
const isFossBuild = (() => {
  const extra = Constants.expoConfig?.extra as { isFossBuild?: unknown } | undefined;
  return extra?.isFossBuild === true || extra?.isFossBuild === 'true';
})();
const DROPBOX_SYNC_ENABLED = !isFossBuild;

const logSyncWarning = (message: string, error?: unknown) => {
  const extra = error ? { error: sanitizeLogMessage(error instanceof Error ? error.message : String(error)) } : undefined;
  void logWarn(message, { scope: 'sync', extra });
};

const logSyncInfo = (message: string, extra?: Record<string, string>) => {
  void logInfo(message, { scope: 'sync', extra });
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

const readFastSyncState = async (scope: string): Promise<FastSyncState | null> => {
  try {
    const raw = await AsyncStorage.getItem(FAST_SYNC_STATE_KEY);
    return parseFastSyncState(raw, scope);
  } catch {
    return null;
  }
};

const writeFastSyncState = async (state: FastSyncState): Promise<void> => {
  try {
    await AsyncStorage.setItem(FAST_SYNC_STATE_KEY, serializeFastSyncState(state));
  } catch (error) {
    logSyncWarning('Failed to cache sync fast-check state', error);
  }
};

const sanitizeLocalSyncStatus = (value: Partial<LocalSyncStatus>): Partial<LocalSyncStatus> => {
  const next: Partial<LocalSyncStatus> = {};
  if (typeof value.lastSyncAt === 'string') next.lastSyncAt = value.lastSyncAt;
  if (
    value.lastSyncStatus === 'idle'
    || value.lastSyncStatus === 'syncing'
    || value.lastSyncStatus === 'success'
    || value.lastSyncStatus === 'error'
    || value.lastSyncStatus === 'conflict'
  ) {
    next.lastSyncStatus = value.lastSyncStatus;
  }
  if (typeof value.lastSyncError === 'string') next.lastSyncError = value.lastSyncError;
  if (value.lastSyncStats && typeof value.lastSyncStats === 'object') next.lastSyncStats = value.lastSyncStats;
  if (Array.isArray(value.lastSyncHistory)) next.lastSyncHistory = value.lastSyncHistory;
  return next;
};

const readLocalSyncStatus = async (): Promise<Partial<LocalSyncStatus> | null> => {
  try {
    const raw = await AsyncStorage.getItem(LOCAL_SYNC_STATUS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LocalSyncStatus>;
    const status = sanitizeLocalSyncStatus(parsed);
    return Object.keys(status).length > 0 ? status : null;
  } catch {
    return null;
  }
};

const writeLocalSyncStatus = async (updates: Partial<LocalSyncStatus>): Promise<void> => {
  try {
    const next = sanitizeLocalSyncStatus({
      ...(await readLocalSyncStatus() ?? {}),
      ...updates,
    });
    await AsyncStorage.setItem(LOCAL_SYNC_STATUS_KEY, JSON.stringify(next));
  } catch (error) {
    logSyncWarning('Failed to cache local sync status', error);
  }
};

const applyLocalSyncStatus = async (updates: Partial<LocalSyncStatus>): Promise<void> => {
  await writeLocalSyncStatus(updates);
  useTaskStore.setState((state) => ({
    settings: {
      ...(state.settings ?? {}),
      ...updates,
    },
  }));
};

const mergeLocalSyncStatus = async (data: AppData): Promise<AppData> => {
  const status = await readLocalSyncStatus();
  if (!status) return data;
  return {
    ...data,
    settings: {
      ...(data.settings ?? {}),
      ...status,
    },
  };
};

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

const readStoredConfigValue = async (key: string): Promise<string | null> => {
  return isSecretConfigKey(key) ? getSecureConfigValue(key) : AsyncStorage.getItem(key);
};

const readConfigValue = async (key: string, useCache = true): Promise<string | null> => {
  if (!useCache) {
    return sanitizeConfigValue(await readStoredConfigValue(key));
  }
  const now = Date.now();
  const cached = syncConfigCache.get(key);
  if (cached && now - cached.readAt <= SYNC_CONFIG_CACHE_TTL_MS) {
    return cached.value;
  }
  const value = sanitizeConfigValue(await readStoredConfigValue(key));
  syncConfigCache.set(key, { value, readAt: now });
  return value;
};

export const clearMobileSyncConfigCache = (): void => {
  syncConfigCache.clear();
};

const getCachedConfigValue = async (key: string): Promise<string | null> => {
  return readConfigValue(key, true);
};

const getPathLeaf = (path: string): string => {
  const stripped = path.split('?')[0]?.split('#')[0]?.replace(/\/+$/, '') ?? '';
  const lastSlash = Math.max(stripped.lastIndexOf('/'), stripped.lastIndexOf('\\'));
  return lastSlash >= 0 ? stripped.slice(lastSlash + 1) : stripped;
};

const SYNC_BOOKMARK_EXPIRED_MESSAGE =
  'Sync location access expired. Please re-select the sync folder or file in Settings -> Data & Sync.';

const resolveBookmarkedFileSyncPath = async (
  syncPath: string | null
): Promise<{ path: string | null; bookmark: string | null }> => {
  if (Platform.OS !== 'ios') return { path: syncPath, bookmark: null };

  const bookmark = (await getCachedConfigValue(SYNC_PATH_BOOKMARK_KEY))?.trim() ?? null;
  if (!bookmark) return { path: syncPath, bookmark: null };

  const resolved = await resolveSyncPathBookmark(bookmark);
  if (!resolved?.uri) {
    if (isSyncPathBookmarksAvailable()) {
      throw new Error(SYNC_BOOKMARK_EXPIRED_MESSAGE);
    }
    return { path: syncPath, bookmark };
  }

  let activeBookmark = bookmark;
  if (resolved.refreshedBookmark && resolved.refreshedBookmark !== bookmark) {
    await AsyncStorage.setItem(SYNC_PATH_BOOKMARK_KEY, resolved.refreshedBookmark);
    syncConfigCache.set(SYNC_PATH_BOOKMARK_KEY, { value: resolved.refreshedBookmark, readAt: Date.now() });
    activeBookmark = resolved.refreshedBookmark;
    logSyncInfo('Refreshed stale iOS sync-path bookmark');
  }

  const bookmarkUri = resolved.uri;
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

  return { path: resolvedPath, bookmark: activeBookmark };
};

const getSupportedBackend = (rawBackend: string | null): SyncBackend =>
  coerceSupportedBackend(resolveBackend(rawBackend), isCloudKitAvailable());

export async function getMobileSyncConfigurationStatus(): Promise<{ backend: SyncBackend; configured: boolean; cloudProvider?: CloudProvider }> {
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
    const dropboxConnected = await isDropboxConnected().catch(() => false);
    return {
      backend,
      cloudProvider,
      configured: DROPBOX_SYNC_ENABLED && getDropboxAppKey().length > 0 && dropboxConnected,
    };
  }

  const cloudUrl = (await readConfigValue(CLOUD_URL_KEY, false))?.trim();
  const cloudToken = (await readConfigValue(CLOUD_TOKEN_KEY, false))?.trim();
  return {
    backend,
    cloudProvider,
    configured: Boolean(cloudUrl && cloudToken),
  };
}

const getAttachmentsArray = (attachments: Attachment[] | undefined): Attachment[] => (
  Array.isArray(attachments) ? attachments : []
);

const getSyncDiagnosticAttachmentCount = (data: AppData): number => {
  const taskAttachments = data.tasks.reduce(
    (count, task) => count + getAttachmentsArray(task.attachments).length,
    0
  );
  const projectAttachments = data.projects.reduce(
    (count, project) => count + getAttachmentsArray(project.attachments).length,
    0
  );
  return taskAttachments + projectAttachments;
};

const buildSyncDataDiagnostics = (data: AppData | null | undefined): Record<string, string> => {
  if (!data) return { hasData: 'false' };
  const contexts = new Set<string>();
  const tags = new Set<string>();
  for (const task of data.tasks) {
    for (const context of task.contexts) contexts.add(context);
    for (const tag of task.tags) tags.add(tag);
  }
  // The stored task count reads far higher than what the app shows once sync
  // tombstones accumulate; log the content-free composition so shared logs can
  // attribute counts and growth without another instrumentation round (#766).
  const lifecycle = summarizeTaskLifecycleCounts(data.tasks);
  return {
    hasData: 'true',
    tasks: String(data.tasks.length),
    liveTasks: String(lifecycle.live),
    trashedTasks: String(lifecycle.trashed),
    tombstoneTasks: String(lifecycle.tombstones),
    tasksCreatedLast7d: String(lifecycle.createdLast7d),
    projects: String(data.projects.length),
    areas: String(data.areas.length),
    contexts: String(contexts.size),
    tags: String(tags.size),
    checklistItems: String(data.tasks.reduce(
      (count, task) => count + (Array.isArray(task.checklist) ? task.checklist.length : 0),
      0
    )),
    attachments: String(getSyncDiagnosticAttachmentCount(data)),
  };
};

const getSyncDiagnosticElapsedMs = (startedAt: number): string => (
  String(Math.max(0, Date.now() - startedAt))
);

const logSyncDiagnostic = (
  message: string,
  startedAt: number,
  extra?: Record<string, string>
) => {
  logSyncInfo(message, {
    elapsedMs: getSyncDiagnosticElapsedMs(startedAt),
    ...(extra ?? {}),
  });
};

const buildOfflineSkipResult = (offlineCause: MobileSyncOfflineCause): MobileSyncResult => ({
  success: true,
  skipped: 'offline',
  offlineCause,
});

type MobileNetworkStatus = {
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
  isAirplaneModeEnabled: boolean;
};

const getMobileNetworkStatus = (state: {
  isConnected?: boolean | null;
  isInternetReachable?: boolean | null;
  isAirplaneModeEnabled?: unknown;
}): MobileNetworkStatus => ({
  isConnected: typeof state.isConnected === 'boolean' ? state.isConnected : null,
  isInternetReachable: typeof state.isInternetReachable === 'boolean' ? state.isInternetReachable : null,
  isAirplaneModeEnabled: typeof state.isAirplaneModeEnabled === 'boolean' ? state.isAirplaneModeEnabled : false,
});

const isDefinitelyOfflineNetworkStatus = (status: MobileNetworkStatus): boolean => (
  status.isAirplaneModeEnabled
  || status.isConnected === false
  || (status.isConnected !== true && status.isInternetReachable === false)
);

const formatNetworkStatusForLog = (status: MobileNetworkStatus): Record<string, string> => ({
  isConnected: status.isConnected === null ? 'unknown' : String(status.isConnected),
  isInternetReachable: status.isInternetReachable === null ? 'unknown' : String(status.isInternetReachable),
  isAirplaneModeEnabled: String(status.isAirplaneModeEnabled),
});

const shouldSkipSyncForOfflineState = async (
  backend: SyncBackend,
  onOffline?: (status: MobileNetworkStatus) => void
): Promise<boolean> => {
  if (!isRemoteSyncBackend(backend)) return false;
  try {
    const state = await Network.getNetworkStateAsync();
    const status = getMobileNetworkStatus(state);

    if (isDefinitelyOfflineNetworkStatus(status)) {
      onOffline?.(status);
      logSyncInfo('Sync skipped: offline/airplane mode', {
        backend,
        ...formatNetworkStatusForLog(status),
      });
      return true;
    }
  } catch (error) {
    logSyncWarning('Failed to read network state before sync', error);
  }
  return false;
};

type MobileSyncRequest = {
  syncPathOverride?: string;
  manual?: boolean;
  activationProbe?: boolean;
  fileSyncLockBusyRetryAttempt?: number;
  ignorePendingRemoteWriteBackoff?: boolean;
  configOverride?: MobileSyncConfigOverride;
};

type MobileRequestFollowUp = (nextArg?: MobileSyncRequest) => void;
type MobileRequestFollowUpAfter = (delayMs: number, nextArg?: MobileSyncRequest) => void;

// One sync cycle. The shared phase sequencing and cycle state live in the core
// machine (runSharedSyncCycle, ADR 0014); this class carries mobile transport
// state (backend configs, abort controller, WebDAV rate limiting, Dropbox
// tokens/revs) and implements the platform ports. Methods copy field values
// into single-assignment locals (e.g. webdavConfig) where callbacks need
// TypeScript's narrowing to hold across awaits.
class MobileSyncRun {
  private readonly backend: SyncBackend;
  private readonly syncPathOverride: string | undefined;
  private readonly manual: boolean;
  private readonly activationProbe: boolean;
  private readonly fileSyncLockBusyRetryAttempt: number;
  private readonly ignorePendingRemoteWriteBackoff: boolean;
  private readonly configOverride: MobileSyncConfigOverride | undefined;
  private readonly requestFollowUp: MobileRequestFollowUp;
  private readonly requestFollowUpAfter: MobileRequestFollowUpAfter;

  private lastStep = 'init';
  private readonly syncDiagnosticStartedAt = Date.now();
  private syncDiagnosticPhaseStartedAt = this.syncDiagnosticStartedAt;
  private attachmentPrepareStartedAt = this.syncDiagnosticStartedAt;
  private attachmentSyncStartedAt = this.syncDiagnosticStartedAt;
  private mergeCycleStartedAt = this.syncDiagnosticStartedAt;
  private visibleActivityStarted = false;
  private syncUrl: string | undefined;
  private networkWentOffline = false;
  private offlineDetectionCause: string | null = null;
  private lastOfflineNetworkStatus: MobileNetworkStatus | null = null;
  private networkSubscription: { remove?: () => void } | null = null;
  private readonly requestAbortController = new AbortController();
  private readonly fetchWithAbort = createAbortableFetch(fetch, { baseSignal: this.requestAbortController.signal });

  private webdavConfig: MobileWebDavSyncConfig | null = null;
  private cloudConfig: MobileCloudSyncConfig | null = null;
  private cloudProvider: CloudProvider = CLOUD_PROVIDER_SELF_HOSTED;
  private dropboxClientId = '';
  private dropboxLastRev: string | null = null;
  private fileSyncPath: string | null = null;
  private fileSyncBookmark: string | null = null;
  private fileSyncLease: Awaited<ReturnType<typeof acquireMobileFileSyncLease>> | null = null;
  private activationProof: MobileSyncResult['activationProof'];
  /** #1056: resolved once per cycle in setupCycle. `null` is the encryption-off path and
   *  every seam below then behaves byte-for-byte as it did before the feature. */
  private encryptionMaterial: SyncKeyMaterial | null = null;

  constructor(
    backend: SyncBackend,
    request: MobileSyncRequest | undefined,
    requestFollowUp: MobileRequestFollowUp,
    requestFollowUpAfter: MobileRequestFollowUpAfter,
  ) {
    this.backend = backend;
    this.syncPathOverride = request?.syncPathOverride;
    this.manual = request?.manual === true;
    this.activationProbe = request?.activationProbe === true;
    this.fileSyncLockBusyRetryAttempt = request?.fileSyncLockBusyRetryAttempt ?? 0;
    this.ignorePendingRemoteWriteBackoff = request?.ignorePendingRemoteWriteBackoff === true;
    this.configOverride = request?.configOverride;
    this.requestFollowUp = requestFollowUp;
    this.requestFollowUpAfter = requestFollowUpAfter;
    activeMobileSyncAbortController = this.requestAbortController;
    activeMobileSyncAbortReason = null;
  }

  async run(): Promise<MobileSyncResult> {
    const backend = this.backend;
    logSyncInfo('Sync start', { backend });
    logSyncInfo('Sync diagnostic start', { backend });
    let result: MobileSyncResult;
    let fileSyncLockCleanupDeferred = false;
    try {
      this.subscribeNetworkListener();
      const cycleResult = await runSharedSyncCycle({
        options: {
          manual: this.manual,
          activationProbe: this.activationProbe,
          fileSyncLockBusyRetryAttempt: this.fileSyncLockBusyRetryAttempt,
          ignorePendingRemoteWriteBackoff: this.ignorePendingRemoteWriteBackoff,
        },
        storage: this.createStorage(),
        notifier: this.createNotifier(),
        store: {
          getLastDataChangeAt: () => useTaskStore.getState().lastDataChangeAt,
          getInMemorySnapshot: () => getInMemoryAppDataSnapshot(),
          flushPendingSave: () => flushPendingSave(),
          setUiError: (message) => useTaskStore.getState().setError(message),
          getSettings: () => useTaskStore.getState().settings,
        },
        hooks: this.createHooks(),
        policy: {
          preSyncAttachmentsBeforeFastCheck: true,
          // A versioned File Sync read represents an absent canonical document with
          // empty data plus `requiresRemoteRepair`. The read-check shortcut compares
          // only documents and would otherwise return "unchanged" before the CAS
          // create runs. The full cycle still skips equal existing documents.
          enableReadCheckSkip: backend !== 'file',
          postMergeAttachmentErrorPolicy: 'fail',
          attachmentPhasesEnabled: true,
        },
        performSyncCycle: (io) => performSyncCycle(io),
      });
      result = this.activationProof ? { ...cycleResult, activationProof: this.activationProof } : cycleResult;
    } finally {
      fileSyncLockCleanupDeferred = await this.releaseResources();
    }
    return result.success && fileSyncLockCleanupDeferred
      ? { ...result, fileSyncLockDeferred: 'cleanup' }
      : result;
  }

  private queueFollowUp(): void {
    this.requestFollowUp({
      syncPathOverride: this.syncPathOverride,
      manual: this.manual,
      activationProbe: this.activationProbe,
      fileSyncLockBusyRetryAttempt: 0,
      ignorePendingRemoteWriteBackoff: this.ignorePendingRemoteWriteBackoff,
      configOverride: this.configOverride,
    });
  }

  private queueFollowUpAfter(
    delayMs: number,
    fileSyncLockBusyRetryAttempt = 0,
  ): void {
    this.requestFollowUpAfter(delayMs, {
      syncPathOverride: this.syncPathOverride,
      manual: this.manual,
      activationProbe: this.activationProbe,
      fileSyncLockBusyRetryAttempt,
      ignorePendingRemoteWriteBackoff: this.ignorePendingRemoteWriteBackoff,
      configOverride: this.configOverride,
    });
  }

  private logPhaseDiagnostic(phase: string, extra?: Record<string, string>): void {
    logSyncDiagnostic('Sync diagnostic phase', this.syncDiagnosticPhaseStartedAt, {
      backend: this.backend,
      phase,
      step: this.lastStep,
      ...(extra ?? {}),
    });
    this.syncDiagnosticPhaseStartedAt = Date.now();
  }

  private startVisibleSyncActivity(): void {
    if (this.visibleActivityStarted) return;
    this.visibleActivityStarted = true;
    setMobileSyncActivityState('syncing');
  }

  private ensureWebdavSyncNotRateLimited(): void {
    webdavSyncRateLimitController.assertReady(this.backend);
  }

  private handleWebdavRateLimit(error: unknown): void {
    if (!webdavSyncRateLimitController.noteError(this.backend, error)) return;
    logSyncWarning('WebDAV rate limited; pausing remote sync', error);
  }

  private markNetworkOffline(cause: string, status?: MobileNetworkStatus): void {
    this.networkWentOffline = true;
    this.offlineDetectionCause = cause;
    this.lastOfflineNetworkStatus = status ?? this.lastOfflineNetworkStatus;
  }

  private ensureNetworkStillAvailable = async (): Promise<void> => {
    if (!isRemoteSyncBackend(this.backend)) return;
    if (this.networkWentOffline) {
      this.requestAbortController.abort();
      throw new Error('Sync paused: offline state detected');
    }
    if (await shouldSkipSyncForOfflineState(this.backend, (status) => this.markNetworkOffline('network-check', status))) {
      this.requestAbortController.abort();
      throw new Error('Sync paused: offline state detected');
    }
  };

  private subscribeNetworkListener(): void {
    if (!isRemoteSyncBackend(this.backend)) return;
    try {
      this.networkSubscription = Network.addNetworkStateListener((state) => {
        const status = getMobileNetworkStatus(state);
        if (isDefinitelyOfflineNetworkStatus(status)) {
          this.markNetworkOffline('network-listener', status);
          this.requestAbortController.abort();
        }
      });
    } catch (error) {
      logSyncWarning('Failed to subscribe to network state during sync', error);
    }
  }

  /** Resolve and normalize the file-sync path. Returns false when no path is configured. */
  private async resolveFileBackendConfig(): Promise<boolean> {
    const configuredSyncPath = (await getCachedConfigValue(SYNC_PATH_KEY))?.trim() ?? null;
    let fileSyncPath = this.configOverride?.syncPath || this.syncPathOverride || configuredSyncPath;
    if (this.configOverride?.syncPath) {
      this.fileSyncBookmark = this.configOverride.syncPathBookmark ?? null;
    } else {
      const bookmarkResolution = await resolveBookmarkedFileSyncPath(fileSyncPath);
      fileSyncPath = bookmarkResolution.path;
      this.fileSyncBookmark = bookmarkResolution.bookmark;
    }
    if (!fileSyncPath) {
      return false;
    }
    // Take the stable folder lock before SAF/path normalization can create the
    // canonical data document. The lease then remains held through attachment
    // work, document CAS, and final local persistence in `run()`.
    this.fileSyncLease = await acquireMobileFileSyncLease(fileSyncPath);
    const normalizedPath = normalizeFileSyncPath(fileSyncPath, Platform.OS);
    if (normalizedPath && normalizedPath !== fileSyncPath) {
      fileSyncPath = normalizedPath;
      if (!this.configOverride?.syncPath) {
        await AsyncStorage.setItem(SYNC_PATH_KEY, normalizedPath);
        syncConfigCache.set(SYNC_PATH_KEY, { value: normalizedPath, readAt: Date.now() });
      }
      logSyncInfo('Normalized file sync path to iOS file URI');
    }
    if (fileSyncPath.startsWith('file://') && IOS_TEMP_INBOX_PATH_PATTERN.test(decodeUriSafe(fileSyncPath))) {
      throw new Error('Selected iOS sync file is in a temporary Inbox location and is read-only. Re-select a folder in Settings -> Sync.');
    }
    if (fileSyncPath.startsWith('content://')) {
      try {
        const resolvedPath = await resolveSyncFileUri(fileSyncPath, { createIfMissing: true });
        if (resolvedPath && resolvedPath !== fileSyncPath) {
          if (!this.configOverride?.syncPath) {
            await AsyncStorage.setItem(SYNC_PATH_KEY, resolvedPath);
            syncConfigCache.set(SYNC_PATH_KEY, { value: resolvedPath, readAt: Date.now() });
          }
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
    this.fileSyncPath = fileSyncPath;
    return true;
  }

  private async resolveWebdavBackendConfig(): Promise<void> {
    const override = this.configOverride?.webdav;
    if (override) {
      const url = override.url.trim();
      if (!url) throw new Error('WebDAV URL not configured');
      this.syncUrl = normalizeWebdavUrl(url);
      this.webdavConfig = {
        ...override,
        url: this.syncUrl,
        username: override.username.trim(),
      };
      return;
    }
    const url = (await getCachedConfigValue(WEBDAV_URL_KEY))?.trim() ?? null;
    if (!url) throw new Error('WebDAV URL not configured');
    this.syncUrl = normalizeWebdavUrl(url);
    const username = (await getCachedConfigValue(WEBDAV_USERNAME_KEY)) ?? '';
    const password = (await getCachedConfigValue(WEBDAV_PASSWORD_KEY)) ?? '';
    const allowInsecureHttp = (await getCachedConfigValue(WEBDAV_ALLOW_INSECURE_HTTP_KEY)) === 'true';
    const allowWeakFingerprint = (await getCachedConfigValue(WEBDAV_ALLOW_WEAK_FINGERPRINT_KEY)) !== 'false';
    this.webdavConfig = { url: this.syncUrl, username, password, allowInsecureHttp, allowWeakFingerprint };
  }

  private async resolveCloudBackendConfig(): Promise<void> {
    const overrideProvider = this.configOverride?.cloudProvider;
    if (overrideProvider) {
      if (!DROPBOX_SYNC_ENABLED && overrideProvider === CLOUD_PROVIDER_DROPBOX) {
        throw new Error('Dropbox sync is unavailable in this build. Choose Self-hosted Cloud or install the Dropbox-enabled build.');
      }
      this.cloudProvider = overrideProvider;
      if (this.cloudProvider === CLOUD_PROVIDER_DROPBOX) {
        this.dropboxClientId = getDropboxAppKey();
        if (!this.dropboxClientId) {
          throw new Error('Dropbox app key is not configured');
        }
        this.dropboxLastRev = (await getCachedConfigValue(DROPBOX_LAST_REV_KEY))?.trim() ?? null;
        this.syncUrl = 'dropbox://Apps/Mindwtr/data.json';
        return;
      }

      const override = this.configOverride?.cloud;
      const url = override?.url.trim() ?? '';
      if (!url) throw new Error('Self-hosted URL not configured');
      this.syncUrl = normalizeCloudUrl(url);
      this.cloudConfig = {
        ...override,
        url: this.syncUrl,
        token: override?.token.trim() ?? '',
      };
      return;
    }
    const storedCloudProvider = (await getCachedConfigValue(CLOUD_PROVIDER_KEY))?.trim() ?? null;
    this.cloudProvider = resolveCloudProvider(storedCloudProvider);
    if (!DROPBOX_SYNC_ENABLED && storedCloudProvider === CLOUD_PROVIDER_DROPBOX) {
      throw new Error('Dropbox sync is unavailable in this build. Choose Self-hosted Cloud or install the Dropbox-enabled build.');
    }
    if (this.cloudProvider === CLOUD_PROVIDER_DROPBOX) {
      this.dropboxClientId = getDropboxAppKey();
      if (!this.dropboxClientId) {
        throw new Error('Dropbox app key is not configured');
      }
      this.dropboxLastRev = (await getCachedConfigValue(DROPBOX_LAST_REV_KEY))?.trim() ?? null;
      this.syncUrl = 'dropbox://Apps/Mindwtr/data.json';
    } else {
      const url = (await getCachedConfigValue(CLOUD_URL_KEY))?.trim() ?? null;
      if (!url) throw new Error('Self-hosted URL not configured');
      this.syncUrl = normalizeCloudUrl(url);
      const token = (await getCachedConfigValue(CLOUD_TOKEN_KEY))?.trim() ?? '';
      const allowInsecureHttp = (await getCachedConfigValue(CLOUD_ALLOW_INSECURE_HTTP_KEY)) === 'true';
      this.cloudConfig = { url: this.syncUrl, token, allowInsecureHttp };
    }
  }

  // Transient failures here must retry before the offline heuristic sees them: the first
  // request after app resume can die on a stale socket, and Dropbox resets connections
  // under multi-device write contention — both look like "offline" to the error patterns.
  private dropboxTransientRetryOptions() {
    return {
      ...DROPBOX_RETRY_OPTIONS,
      shouldRetry: (error: unknown) => !this.networkWentOffline
        && !this.requestAbortController.signal.aborted
        && isRetryableError(error),
      onRetry: (error: unknown, attempt: number) => logSyncWarning(`Dropbox request failed (attempt ${attempt}); retrying`, error),
    };
  }

  /** Still used by attachment cleanup (`runAttachmentCleanup`, out of this
   *  task's scope), which resolves its own token and needs the 401-refresh
   *  fallback inline. The sync-cycle backend IO below uses the split
   *  `resolveDropboxToken` + `runDropboxTransientRetry` shape instead, so the
   *  shared `SyncBackendIO` port (`createSyncBackendIO`) can own the
   *  401-retry-once policy once for both platforms. */
  private async runDropboxOperation<T>(operation: (accessToken: string) => Promise<T>): Promise<T> {
    return withRetry(async () => {
      let accessToken = await this.resolveDropboxAccessToken(false);
      try {
        return await operation(accessToken);
      } catch (error) {
        if (!isDropboxUnauthorizedError(error)) throw error;
        accessToken = await this.resolveDropboxAccessToken(true);
        return operation(accessToken);
      }
    }, this.dropboxTransientRetryOptions());
  }

  private async resolveDropboxAccessToken(forceRefresh: boolean): Promise<string> {
    const stagedCredentials = this.configOverride?.dropbox;
    if (!stagedCredentials) {
      return forceRefresh
        ? forceRefreshDropboxAccessToken(this.dropboxClientId, this.fetchWithAbort)
        : getValidDropboxAccessToken(this.dropboxClientId, this.fetchWithAbort);
    }

    const resolution = forceRefresh
      ? await forceRefreshDropboxAccessTokenForTokens(
        this.dropboxClientId,
        stagedCredentials.tokens,
        this.fetchWithAbort,
      )
      : await getValidDropboxAccessTokenForTokens(
        this.dropboxClientId,
        stagedCredentials.tokens,
        this.fetchWithAbort,
      );
    // Preserve an OAuth refresh performed during the proof in the in-memory
    // candidate bundle. The settings transaction promotes this exact bundle
    // only after the proof succeeds.
    stagedCredentials.tokens = resolution.tokens;
    return resolution.accessToken;
  }

  /** One Dropbox transport call's transient-retry wrap (network/5xx). The
   *  401-triggered token-refresh-and-retry-once policy lives in
   *  `createSyncBackendIO` (packages/core/src/sync-backend-io.ts) and calls
   *  `resolveDropboxToken`/`dropboxDownload`/`dropboxUpload`/`dropboxMetadata`
   *  directly — `isRetryableError` already excludes 401s, so this wrap never
   *  competes with that policy. */
  private runDropboxTransientRetry<T>(operation: () => Promise<T>): Promise<T> {
    return withRetry(operation, this.dropboxTransientRetryOptions());
  }

  private async persistDropboxRev(rev: string | null): Promise<void> {
    this.dropboxLastRev = rev;
    if (this.activationProbe) return;
    if (rev) {
      await AsyncStorage.setItem(DROPBOX_LAST_REV_KEY, rev);
      syncConfigCache.set(DROPBOX_LAST_REV_KEY, { value: rev, readAt: Date.now() });
    } else {
      await AsyncStorage.removeItem(DROPBOX_LAST_REV_KEY);
      syncConfigCache.set(DROPBOX_LAST_REV_KEY, { value: null, readAt: Date.now() });
    }
  }

  private createStorage(): SyncRunStorage {
    return {
      readPersistedLocal: async () => mergeLocalSyncStatus(await mobileStorage.getData()),
      persistLocal: (data) => mobileStorage.saveData(data),
      persistSyncStatus: (updates) => applyLocalSyncStatus(updates),
      readFastSyncState: (scope) => readFastSyncState(scope),
      writeFastSyncState: (state) => writeFastSyncState(state),
      injectExternalCalendars: (data) => injectExternalCalendars(data),
      persistExternalCalendars: (data) => persistExternalCalendars(data),
    };
  }

  private createNotifier(): SyncRunNotifier {
    // Elapsed time since the previous step start; a shared log then shows
    // which step a slow cycle actually spent its time in (#766).
    let lastStepStartedAtMs = 0;
    return {
      setStep: (step) => {
        this.lastStep = step;
        const nowMs = Date.now();
        const sinceLastStepMs = lastStepStartedAtMs > 0 ? nowMs - lastStepStartedAtMs : 0;
        lastStepStartedAtMs = nowMs;
        logSyncInfo('Sync step', { step, sinceLastStepMs: String(sinceLastStepMs) });
      },
      logInfo: (message, extra) => logSyncInfo(message, extra),
      logWarning: (message, error) => logSyncWarning(message, error),
      logWarningExtra: (message, extra) => {
        void logWarn(message, { scope: 'sync', extra });
      },
      sanitizeLogMessage: (message) => sanitizeLogMessage(message),
      logSyncError: (error, context) => logSyncError(error, {
        backend: context.backend,
        step: context.step,
        url: context.url,
      }),
      logMergeSummary: (mergeLog) => {
        void logInfo(
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
      // Same gate and formatters desktop uses, so a mobile trace reads the
      // same as a desktop one. Ids, field names and fingerprints only (#854).
      tracePayload: (event, data, extra) => {
        if (!isSyncPayloadTraceEnabled(useTaskStore.getState().settings)) return;
        logSyncInfo(SYNC_TRACE_EVENT_MESSAGES[event], buildSyncPayloadTraceExtra(data, extra));
      },
      onDiagnostic: (event) => this.handleDiagnosticEvent(event),
    };
  }

  private handleDiagnosticEvent(event: SyncRunDiagnosticEvent): void {
    const backend = this.backend;
    if (event.event === 'flush') {
      this.logPhaseDiagnostic('flush');
      return;
    }
    if (event.event === 'attachments-prepare-complete') {
      const mutated = event.extra?.mutated ?? 'false';
      logSyncInfo('Attachment pre-sync complete', { backend, mutated });
      logSyncDiagnostic('Sync diagnostic attachment prepare complete', this.attachmentPrepareStartedAt, {
        backend,
        mutated,
        ...buildSyncDataDiagnostics(event.data),
      });
      return;
    }
    if (event.event === 'merge-complete') {
      logSyncDiagnostic('Sync diagnostic merge cycle complete', this.mergeCycleStartedAt, {
        backend,
        status: event.extra?.status ?? 'success',
        // Steady nonzero across cycles = tombstone rev-bump loop (#766).
        tombstoneRepairs: event.extra?.tombstoneRepairs ?? '0',
        ...buildSyncDataDiagnostics(event.data),
      });
      return;
    }
    if (event.event === 'merge-skipped') {
      logSyncDiagnostic('Sync diagnostic skipped', this.mergeCycleStartedAt, {
        backend,
        step: this.lastStep,
        success: 'true',
        skipped: 'pendingRemoteWriteBackoff',
        retryInMs: event.extra?.retryInMs ?? '',
        ...buildSyncDataDiagnostics(event.data),
      });
      return;
    }
    if (event.event === 'attachment-sync-applied') {
      logSyncDiagnostic('Sync diagnostic attachment sync complete', this.attachmentSyncStartedAt, {
        backend,
        mutated: event.extra?.mutated ?? 'false',
        ...buildSyncDataDiagnostics(event.data),
      });
      return;
    }
    if (event.event === 'requeued') {
      const wroteLocal = event.extra?.wroteLocal ?? 'false';
      const step = event.extra?.step ?? this.lastStep;
      logSyncInfo('Sync requeued after local data changed', { backend, step, wroteLocal });
      logSyncDiagnostic('Sync diagnostic requeued', this.syncDiagnosticStartedAt, {
        backend,
        step,
        success: 'true',
        wroteLocal,
      });
    }
  }

  /** The three blob backends #1056 covers. CloudKit and mindwtr-cloud (self-hosted) are
   *  out of scope; Dropbox reaches us as the `cloud` backend with a dropbox provider. */
  private supportsSyncEncryption(): boolean {
    if (this.backend === 'file' || this.backend === 'webdav') return true;
    return this.backend === 'cloud' && this.cloudProvider === CLOUD_PROVIDER_DROPBOX;
  }

  private markCandidateEncryptedRemoteProven(): void {
    if (this.activationProbe && this.configOverride) {
      this.activationProof = 'remote-encrypted-no-key';
    }
  }

  private createHooks(): SyncRunPlatformHooks {
    return {
      setupCycle: async ({ setStep }) => {
        const backend = this.backend;
        if (backend === 'file' && !(await this.resolveFileBackendConfig())) {
          return { kind: 'disabled' };
        }
        if (backend === 'webdav') {
          await this.resolveWebdavBackendConfig();
        }
        if (backend === 'cloud') {
          await this.resolveCloudBackendConfig();
        }
        // #1056: encryption applies to the three blob backends only. A device that knows
        // the remote is encrypted but holds no key must not sync at all — writing a fresh
        // plaintext document beside the ciphertext is exactly the outcome decision #5
        // exists to prevent. Automatic and background runs go quiet; a manual run says why.
        if (this.supportsSyncEncryption()) {
          const probingCandidate = this.activationProbe && Boolean(this.configOverride);
          const incompleteTransition = await getIncompleteSyncEncryptionTransition();
          if (incompleteTransition) {
            if (!this.manual && !probingCandidate) return { kind: 'disabled' };
            throw new SyncEncryptionTransitionIncompleteError(incompleteTransition);
          }
          if (!probingCandidate && await isSyncEncryptionBlocked()) {
            if (!this.manual) return { kind: 'disabled' };
            throw new SyncEncryptionNoKeyError();
          }
          this.encryptionMaterial = await getSyncEncryptionMaterial();
        }
        if (backend === 'webdav') {
          const webdavConfig = this.webdavConfig!;
          await ensureWebdavCapabilityProof(webdavConfig, () => (
            assertWebdavStrongEtagSupport(webdavConfig.url, {
              ...getMobileWebDavRequestOptions(webdavConfig.allowInsecureHttp),
              username: webdavConfig.username,
              password: webdavConfig.password,
              timeoutMs: 10_000,
              fetcher: this.fetchWithAbort,
            })
          ));
        }
        // CloudKit setup — ensure zone and subscription exist before sync cycle.
        if (backend === 'cloudkit') {
          if (!isCloudKitAvailable()) {
            throw new Error('CloudKit is not available on this platform');
          }
          setStep('cloudkit_setup');
          await ensureCloudKitReady({ signal: this.requestAbortController.signal });
        }
        return {
          kind: 'ready',
          backend,
          cloudProvider: this.cloudProvider,
          io: this.createBackendIO(),
          fastSyncScope: buildFastSyncScope({
            backend,
            webdavConfig: this.webdavConfig,
            cloudProvider: this.cloudProvider,
            cloudConfig: this.cloudConfig,
            dropboxClientId: this.dropboxClientId,
          }),
        };
      },
      requestFollowUp: () => this.queueFollowUp(),
      requestFollowUpAfter: (delayMs) => this.queueFollowUpAfter(delayMs),
      requestFileSyncLockBusyFollowUpAfter: (delayMs, nextAttempt) => (
        this.queueFollowUpAfter(delayMs, nextAttempt)
      ),
      ensureNetworkStillAvailable: this.ensureNetworkStillAvailable,
      onStaleSnapshot: ({ localSnapshotChangeAt, currentChangeAt, step }) => {
        logSyncInfo('Sync detected local data changes during cycle; queued follow-up', {
          backend: this.backend,
          step,
          snapshotChangeAt: String(localSnapshotChangeAt),
          currentChangeAt: String(currentChangeAt),
        });
      },
      shouldRunAttachmentPhase: async (data, phase) => {
        const backend = this.backend;
        // #1057 (review B3): every attachment backend now wires check-on-touch
        // content detection, including the bespoke Dropbox/self-hosted Cloud loops.
        // Without this, the steady state — cloudKey + managed local file +
        // localStatus 'available' — reports "no pending work", so neither prepare
        // nor post-merge can detect a local edit or converge a remote winner.
        const contentCheckEnabled = backend === 'file'
          || backend === 'webdav'
          || backend === 'cloudkit'
          || backend === 'cloud';
        if (phase === 'prepare') {
          const prepareCheckStartedAt = Date.now();
          const hasAttachmentWork = await hasPendingAttachmentSyncWork(data, { contentCheckEnabled });
          if (hasPendingSyncSideEffects(data) || hasAttachmentWork) {
            this.startVisibleSyncActivity();
          }
          if (!hasAttachmentWork) {
            logSyncInfo('Attachment pre-sync skipped', { backend, reason: 'no-pending-work' });
            logSyncDiagnostic('Sync diagnostic attachment prepare skipped', prepareCheckStartedAt, {
              backend,
              ...buildSyncDataDiagnostics(data),
            });
            return false;
          }
          this.attachmentPrepareStartedAt = Date.now();
          return true;
        }
        const hasAttachmentWork = await hasPendingAttachmentSyncWork(data, { contentCheckEnabled });
        if (!hasAttachmentWork) {
          logSyncInfo('Attachment sync skipped', { backend, reason: 'no-pending-work' });
          return false;
        }
        this.attachmentSyncStartedAt = Date.now();
        return true;
      },
      onMergePhaseStart: () => {
        this.startVisibleSyncActivity();
        this.mergeCycleStartedAt = Date.now();
      },
      isCycleAborted: () => this.requestAbortController.signal.aborted,
      cleanupAttachmentTempFiles: () => cleanupAttachmentTempFiles(),
      runAttachmentCleanup: async (data, context) => {
        context.setStep('attachments_cleanup');
        context.ensureLocalSnapshotFresh();
        await context.ensureNetworkStillAvailable();
        const cleanupResult = await runMobileAttachmentCleanup({
          appData: data,
          backend: this.backend,
          webdavConfig: this.webdavConfig,
          cloudConfig: this.cloudConfig,
          cloudProvider: this.cloudProvider,
          fileSyncPath: this.fileSyncPath,
          fetcher: this.fetchWithAbort,
          ensureLocalSnapshotFresh: () => context.ensureLocalSnapshotFresh(),
          assertRemoteMutationFenceHeld: context.assertRemoteMutationFenceHeld,
          deleteDropboxAttachment: (cloudKey, ensureBeforeProviderDelete) =>
            this.runDropboxOperation(async (accessToken) => {
              const { rev } = await getDropboxFileMetadata(
                accessToken,
                cloudKey,
                this.fetchWithAbort,
                { signal: this.requestAbortController.signal },
              );
              if (!rev) throw new DropboxFileNotFoundError('Dropbox file not found');
              // Token refresh can yield long enough for a local edit. Guard at
              // the final provider call, not only before resolving credentials.
              ensureBeforeProviderDelete();
              await context.assertRemoteMutationFenceHeld(35_000);
              return deleteDropboxFileVersioned(
                accessToken,
                cloudKey,
                rev,
                this.fetchWithAbort,
                { signal: this.requestAbortController.signal },
              );
            }),
          isRemoteMissingError: (error) => error instanceof DropboxFileNotFoundError,
          logSyncInfo,
          logSyncWarning,
        });
        context.ensureLocalSnapshotFresh();
        return {
          data: cleanupResult.appData,
          invalidateFastSyncState: cleanupResult.shouldInvalidateFastSyncState,
        };
      },
      formatErrorMessage: (error, backend) => formatSyncErrorMessage(error, backend),
      handleRunErrorBeforeRequeue: async (_error, context) => {
        if (this.requestAbortController.signal.aborted && activeMobileSyncAbortReason === 'lifecycle') {
          logSyncInfo('Sync aborted by app lifecycle transition', { backend: this.backend, step: context.step });
          logSyncDiagnostic('Sync diagnostic lifecycle abort', this.syncDiagnosticStartedAt, {
            backend: this.backend,
            step: context.step,
            success: 'true',
            aborted: 'lifecycle',
          });
          this.queueFollowUp();
          return { success: true };
        }
        return null;
      },
      handleRunErrorAfterRequeue: async (error, context) => {
        const backend = this.backend;
        const likelyOfflineRequestError = isLikelyOfflineSyncError(error);
        if (!isRemoteSyncBackend(backend) || (!this.networkWentOffline && !likelyOfflineRequestError)) {
          return null;
        }
        if (!this.offlineDetectionCause && likelyOfflineRequestError) {
          this.offlineDetectionCause = 'request-error';
        }
        await context.persistPreSyncedData();
        if (context.getWroteLocal()) {
          try {
            await useTaskStore.getState().fetchData({ silent: true });
          } catch (fetchError) {
            logSyncWarning('[Mobile] Failed to refresh store after offline sync skip', fetchError);
          }
        }
        logSyncInfo('Sync skipped after offline detection', {
          backend,
          step: context.step,
          reason: this.offlineDetectionCause ?? 'unknown',
          error: formatSyncErrorMessage(error, backend),
          ...(this.lastOfflineNetworkStatus ? formatNetworkStatusForLog(this.lastOfflineNetworkStatus) : {}),
        });
        logSyncDiagnostic('Sync diagnostic offline skip', this.syncDiagnosticStartedAt, {
          backend,
          step: context.step,
          success: 'true',
          skipped: 'offline',
          reason: this.offlineDetectionCause ?? 'unknown',
          error: formatSyncErrorMessage(error, backend),
        });
        return buildOfflineSkipResult(this.networkWentOffline ? 'network' : 'request');
      },
      finalizeErrorStatus: async ({ at, message, step, history, wroteLocal }) => {
        logSyncDiagnostic('Sync diagnostic error', this.syncDiagnosticStartedAt, {
          backend: this.backend,
          step,
          success: 'false',
          error: message,
        });
        if (wroteLocal) {
          await useTaskStore.getState().fetchData({ silent: true });
        }
        await applyLocalSyncStatus({
          lastSyncAt: at,
          lastSyncStatus: 'error',
          lastSyncError: message,
          lastSyncStats: undefined,
          lastSyncHistory: history,
        });
      },
      finalizeSuccess: async (mergedData, info) => {
        // mergedData is exactly what the last writeLocal persisted, so refresh the
        // store from it directly instead of re-reading the full dataset from SQLite.
        const refreshStartedAt = Date.now();
        await useTaskStore.getState().fetchData({ silent: true, preloadedData: mergedData });
        logSyncDiagnostic('Sync diagnostic complete', this.syncDiagnosticStartedAt, {
          backend: this.backend,
          step: this.lastStep,
          status: info.status,
          success: 'true',
          wroteLocal: String(info.wroteLocal),
          refreshMs: String(Date.now() - refreshStartedAt),
          ...buildSyncDataDiagnostics(mergedData),
        });
      },
    };
  }

  /** Ladder-visible config for `createSyncBackendIO` (ADR 0014's shared
   *  `SyncBackendIO` implementation, `packages/core/src/sync-backend-io.ts`).
   *  `dropboxRev` starts from the persisted last-known rev (`this.dropboxLastRev`,
   *  restored from `DROPBOX_LAST_REV_KEY` in `resolveCloudBackendConfig`) —
   *  mobile, unlike desktop, caches this across cycles. */
  private createBackendContext(): SyncBackendContext {
    return {
      backend: this.backend,
      cloudProvider: this.cloudProvider,
      webdav: this.webdavConfig ? { url: this.webdavConfig.url } : null,
      cloud: this.cloudConfig ? { url: this.cloudConfig.url } : null,
      filePath: this.fileSyncPath ?? '',
      dropboxAppKey: this.dropboxClientId,
      dropboxRev: this.dropboxLastRev,
    };
  }

  /** Mobile's transport truths for one sync cycle: WebDAV rate-limit
   *  wrapping (`ensureWebdavSyncNotRateLimited`/`handleWebdavRateLimit`) and
   *  `AbortSignal` plumbing through every remote call. Retry wrapping
   *  (`WEBDAV_READ_RETRY_OPTIONS`/`WEBDAV_RETRY_OPTIONS`/
   *  `runDropboxTransientRetry`) is mobile's own policy and stays here —
   *  `createSyncBackendIO` calls these methods without adding or removing
   *  retries of its own. */
  private createBackendTransport(): SyncTransport {
    return {
      acquireWebdavRemoteMutationFence: async () => {
        const webdavConfig = this.webdavConfig;
        if (!webdavConfig?.url) throw new Error('WebDAV URL not configured');
        this.ensureWebdavSyncNotRateLimited();
        try {
          return await acquireSyncRemoteMutationFence(
            createWebdavSyncRemoteMutationFencePort(webdavConfig.url, {
              ...getMobileWebDavRequestOptions(webdavConfig.allowInsecureHttp),
              username: webdavConfig.username,
              password: webdavConfig.password,
              timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
              fetcher: this.fetchWithAbort,
            }),
            { ownerId: 'mindwtr-mobile', purpose: 'ordinary-sync' },
          );
        } catch (error) {
          if (!isSyncEncryptionError(error)) this.handleWebdavRateLimit(error);
          throw error;
        }
      },
      acquireDropboxRemoteMutationFence: (token) => acquireSyncRemoteMutationFence(
        createDropboxSyncRemoteMutationFencePort(token, this.fetchWithAbort, {
          signal: this.requestAbortController.signal,
          timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
        }),
        { ownerId: 'mindwtr-mobile', purpose: 'ordinary-sync' },
      ),
      webdavGet: async () => {
        const webdavConfig = this.webdavConfig!;
        const requestOptions = {
          ...getMobileWebDavRequestOptions(webdavConfig.allowInsecureHttp),
          username: webdavConfig.username,
          password: webdavConfig.password,
          timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
          fetcher: this.fetchWithAbort,
          signal: this.requestAbortController.signal,
          allowWeakFingerprint: webdavConfig.allowWeakFingerprint,
        };
        this.ensureWebdavSyncNotRateLimited();
        try {
          const result = await withRetry(
            () => webdavGetSyncDocument<AppData>(webdavConfig.url, {
              ...requestOptions,
              material: this.encryptionMaterial ?? undefined,
              cryptoPrims: mobileSyncCryptoPrimitives,
            }),
            WEBDAV_READ_RETRY_OPTIONS
          );
          if (result.state === 'remote-plaintext') {
            // A peer disabled encryption at the sync location. Persist first (the state must
            // survive a restart), then fail the cycle. Nothing on the remote is touched, and
            // this device never follows the remote down to plaintext on its own.
            markRemotePlaintextDiscovered(syncEncryptionLocalState);
            await flushSyncEncryptionLocalState();
            throw new SyncEncryptionRemotePlaintextError();
          }
          if (result.state === 'encrypted-no-key') {
            if (!normalizeStrongWebdavEtag(result.strongEtag)) {
              throw new SyncEncryptionRemoteVersionUnavailableError('WebDAV encrypted sync document');
            }
            // Persist first (decision #5: the state must survive a restart), then fail
            // the cycle. Nothing on the remote is touched on this path.
            markRemoteEncryptionDiscovered(syncEncryptionLocalState, result);
            await flushSyncEncryptionLocalState();
            this.markCandidateEncryptedRemoteProven();
            throw new SyncEncryptionNoKeyError();
          }
          return {
            data: result.data,
            exists: result.exists,
            strongEtag: result.strongEtag,
          };
        } catch (error) {
          // The core machine maps invalid-JSON reads to the repair-write path;
          // only genuine transport failures count toward the rate limiter.
          if (!isWebdavInvalidJsonError(error) && !isSyncEncryptionError(error)) {
            this.handleWebdavRateLimit(error);
          }
          throw error;
        }
      },
      webdavPut: async (sanitized, expectedEtag, assertRemoteMutationFenceHeld) => {
        const webdavConfig = this.webdavConfig;
        if (!webdavConfig?.url) throw new Error('WebDAV URL not configured');
        const requestOptions = {
          ...getMobileWebDavRequestOptions(webdavConfig.allowInsecureHttp),
          username: webdavConfig.username,
          password: webdavConfig.password,
          timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
          fetcher: this.fetchWithAbort,
          signal: this.requestAbortController.signal,
          allowWeakFingerprint: webdavConfig.allowWeakFingerprint,
        };
        this.ensureWebdavSyncNotRateLimited();
        try {
          const material = this.encryptionMaterial;
          return await withRetry(
            async () => {
              await assertRemoteMutationFenceHeld?.(SYNC_REMOTE_MUTATION_REQUEST_HORIZON_MS);
              return webdavPutSyncDocument(webdavConfig.url, sanitized, {
                ...requestOptions,
                material: material ?? undefined,
                cryptoPrims: mobileSyncCryptoPrimitives,
                expectedEtag,
              });
            },
            WEBDAV_RETRY_OPTIONS
          );
        } catch (error) {
          if (!isSyncEncryptionError(error)) this.handleWebdavRateLimit(error);
          throw error;
        }
      },
      webdavHead: async () => {
        const webdavConfig = this.webdavConfig!;
        this.ensureWebdavSyncNotRateLimited();
        try {
          const material = this.encryptionMaterial;
          const headUrl = material ? syncEncryptedArtifactName(webdavConfig.url) : webdavConfig.url;
          const metadata = await withRetry(
            () =>
              webdavHeadFile(headUrl, {
                ...getMobileWebDavRequestOptions(webdavConfig.allowInsecureHttp),
                username: webdavConfig.username,
                password: webdavConfig.password,
                timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
                fetcher: this.fetchWithAbort,
                signal: this.requestAbortController.signal,
                allowWeakFingerprint: webdavConfig.allowWeakFingerprint,
              }),
            WEBDAV_READ_RETRY_OPTIONS
          );
          return metadata;
        } catch (error) {
          this.handleWebdavRateLimit(error);
          throw error;
        }
      },
      cloudGet: async () => {
        const cloudConfig = this.cloudConfig!;
        return cloudGetJson<AppData>(cloudConfig.url, {
          ...getMobileCloudRequestOptions(cloudConfig.allowInsecureHttp),
          token: cloudConfig.token,
          timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
          fetcher: this.fetchWithAbort,
          signal: this.requestAbortController.signal,
        });
      },
      cloudPut: async (sanitized) => {
        const cloudConfig = this.cloudConfig;
        if (!cloudConfig?.url) throw new Error('Self-hosted URL not configured');
        return cloudPutJson(cloudConfig.url, sanitized, {
          ...getMobileCloudRequestOptions(cloudConfig.allowInsecureHttp),
          token: cloudConfig.token,
          timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
          fetcher: this.fetchWithAbort,
          signal: this.requestAbortController.signal,
        });
      },
      cloudHead: async () => {
        const cloudConfig = this.cloudConfig!;
        return cloudHeadJson(cloudConfig.url, {
          ...getMobileCloudRequestOptions(cloudConfig.allowInsecureHttp),
          token: cloudConfig.token,
          timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
          fetcher: this.fetchWithAbort,
          signal: this.requestAbortController.signal,
        });
      },
      fileRead: async () => {
        const fileSyncPath = this.fileSyncPath;
        if (!fileSyncPath) throw new Error('No sync folder configured');
        // The `material` key is added only when encryption is on, so the off-state call
        // is argument-for-argument what it was before this feature (invariant #1).
        try {
          return await readSyncFileVersioned(fileSyncPath, {
            bookmark: this.fileSyncBookmark,
            ...(this.encryptionMaterial ? { material: this.encryptionMaterial } : {}),
          });
        } catch (error) {
          if (error instanceof SyncEncryptionNoKeyError) this.markCandidateEncryptedRemoteProven();
          throw error;
        }
      },
      fileWrite: async (sanitized, expectedFingerprint) => {
        const fileSyncPath = this.fileSyncPath;
        if (!fileSyncPath) throw new Error('No sync folder configured');
        if (!expectedFingerprint) {
          throw new Error('File Sync document version is unavailable; refusing an unconditional write');
        }
        try {
          await writeSyncFile(fileSyncPath, sanitized, {
            bookmark: this.fileSyncBookmark,
            expectedFingerprint,
            ...(this.encryptionMaterial ? { material: this.encryptionMaterial } : {}),
          });
        } catch (error) {
          if (error instanceof SyncEncryptionRemoteConflictError) {
            throw new SyncRemoteWriteConflict();
          }
          throw error;
        }
      },
      cloudKitRead: async () => readRemoteCloudKit({ signal: this.requestAbortController.signal }),
      cloudKitWrite: async (sanitized) => {
        await writeRemoteCloudKit(sanitized, { signal: this.requestAbortController.signal });
      },
      resolveDropboxToken: (forceRefresh) => this.runDropboxTransientRetry(
        () => this.resolveDropboxAccessToken(forceRefresh),
      ),
      dropboxDownload: async (token) => {
        const material = this.encryptionMaterial;
        const result = await this.runDropboxTransientRetry(
          () => downloadDropboxAppData(
            token,
            this.fetchWithAbort,
            material ? { material, cryptoPrims: mobileSyncCryptoPrimitives } : {},
            { signal: this.requestAbortController.signal },
          )
        );
        if (result.encryptedNoKey) {
          markRemoteEncryptionDiscovered(syncEncryptionLocalState, result.encryptedNoKey);
          await flushSyncEncryptionLocalState();
          this.markCandidateEncryptedRemoteProven();
          throw new SyncEncryptionNoKeyError();
        }
        if (result.remotePlaintext) {
          markRemotePlaintextDiscovered(syncEncryptionLocalState);
          await flushSyncEncryptionLocalState();
          throw new SyncEncryptionRemotePlaintextError();
        }
        await this.persistDropboxRev(result.rev);
        return result;
      },
      dropboxUpload: async (token, sanitized, expectedRev, assertRemoteMutationFenceHeld) => {
        const material = this.encryptionMaterial;
        const result = await this.runDropboxTransientRetry(
          async () => {
            await assertRemoteMutationFenceHeld?.(SYNC_REMOTE_MUTATION_REQUEST_HORIZON_MS);
            return uploadDropboxAppData(
              token,
              sanitized,
              expectedRev,
              this.fetchWithAbort,
              material ? { material, cryptoPrims: mobileSyncCryptoPrimitives } : {},
              { signal: this.requestAbortController.signal },
            );
          }
        );
        await this.persistDropboxRev(result.rev);
        return result;
      },
      dropboxMetadata: (token) => this.runDropboxTransientRetry(() => getDropboxAppDataMetadata(
        token,
        this.fetchWithAbort,
        {},
        { signal: this.requestAbortController.signal },
      )),
      syncWebdavAttachments: async (data, helpers) => {
        const webdavConfig = this.webdavConfig!;
        const baseSyncUrl = getBaseSyncUrl(webdavConfig.url);
        return syncWebdavAttachments(data, webdavConfig, baseSyncUrl, this.requestAbortController.signal, {
          activationProbe: helpers.activationProbe,
          phase: helpers.phase,
          assertRemoteMutationFenceHeld: helpers.assertRemoteMutationFenceHeld,
          ...(this.encryptionMaterial ? { material: this.encryptionMaterial } : {}),
        });
      },
      syncCloudKitAttachments: async (data, helpers) => syncCloudKitAttachments(
        data,
        this.requestAbortController.signal,
        { activationProbe: helpers.activationProbe, phase: helpers.phase }
      ),
      syncCloudAttachments: async (data, helpers) => {
        const cloudConfig = this.cloudConfig!;
        const baseSyncUrl = getCloudBaseUrl(cloudConfig.url);
        return syncCloudAttachments(data, cloudConfig, baseSyncUrl, {
          activationProbe: helpers.activationProbe,
          assertCurrent: () => helpers.ensureLocalSnapshotFresh(),
          assertRemoteMutationFenceHeld: helpers.assertRemoteMutationFenceHeld,
          phase: helpers.phase,
          signal: this.requestAbortController.signal,
        });
      },
      syncDropboxAttachments: async (data, helpers) => syncDropboxAttachments(data, this.dropboxClientId, this.fetchWithAbort, {
        activationProbe: helpers.activationProbe,
        phase: helpers.phase,
        resolveAccessToken: (forceRefresh) => this.resolveDropboxAccessToken(forceRefresh),
        signal: this.requestAbortController.signal,
        assertRemoteMutationFenceHeld: helpers.assertRemoteMutationFenceHeld,
        ...(this.encryptionMaterial ? { material: this.encryptionMaterial } : {}),
      }),
      syncFileAttachments: async (data, helpers) => syncFileAttachments(
        data,
        this.fileSyncPath!,
        this.requestAbortController.signal,
        {
          activationProbe: helpers.activationProbe,
          phase: helpers.phase,
          ...(this.encryptionMaterial ? { material: this.encryptionMaterial } : {}),
        }
      ),
    };
  }

  /** Backend transport adapter for the core machine (ADR 0014). The ladder
   *  (which backend, url normalization, the Dropbox rev fingerprint format,
   *  the conflict mapping, and the auth-retry-once policy) lives in
   *  `createSyncBackendIO`; this only supplies mobile's transport truths. */
  private createBackendIO(): SyncBackendIO {
    const ctx = this.createBackendContext();
    const io = createSyncBackendIO(ctx, this.createBackendTransport());
    return {
      ...io,
      // `this.syncUrl` is set during `resolveWebdavBackendConfig`/
      // `resolveCloudBackendConfig` (setup, before this IO exists) and by the
      // ladder itself thereafter via `ctx.syncUrl` — `getSyncUrl` must reflect
      // whichever is freshest, so prefer the ladder's value once it has one.
      getSyncUrl: () => ctx.syncUrl ?? this.syncUrl,
    };
  }

  private async releaseResources(): Promise<boolean> {
    let fileSyncLockCleanupDeferred = false;
    if (this.fileSyncLease) {
      const lease = this.fileSyncLease;
      this.fileSyncLease = null;
      try {
        await releaseMobileFileSyncLease(lease);
      } catch (error) {
        fileSyncLockCleanupDeferred = true;
        logSyncWarning('Failed to release File Sync lease', error);
      }
    }
    if (activeMobileSyncAbortController === this.requestAbortController) {
      activeMobileSyncAbortController = null;
      activeMobileSyncAbortReason = null;
    }
    try {
      this.networkSubscription?.remove?.();
    } catch (error) {
      logSyncWarning('Failed to unsubscribe network listener after sync', error);
    }
    return fileSyncLockCleanupDeferred;
  }
}

// A follow-up cycle (requeued after mid-cycle edits or a lifecycle abort) waits at
// least as long as the finished cycle took, so the app never spends more than half
// its time syncing. The cap bounds staleness; the old one-minute cap defeated the
// half-duty rule exactly on the whale libraries that need it most — an 80s cycle
// got a 60s gap, keeping a 7k-task device near-continuously mid-sync (#766).
const MIN_FOLLOW_UP_DELAY_MS = 1_000;
const MAX_FOLLOW_UP_DELAY_MS = 5 * 60_000;

const mobileSyncOrchestrator = createSyncOrchestrator<MobileSyncRequest | undefined, MobileSyncResult>({
  getFollowUpDelayMs: (lastCycleDurationMs) => {
    const delayMs = Math.min(Math.max(lastCycleDurationMs, MIN_FOLLOW_UP_DELAY_MS), MAX_FOLLOW_UP_DELAY_MS);
    logSyncInfo('Sync follow-up scheduled', {
      delayMs: String(delayMs),
      lastCycleDurationMs: String(lastCycleDurationMs),
    });
    return delayMs;
  },
  runCycle: async (request, { requestFollowUp, requestFollowUpAfter }) => {
    const rawBackend = request?.configOverride?.backend
      ?? (await getCachedConfigValue(SYNC_BACKEND_KEY))?.trim()
      ?? null;
    const backend: SyncBackend = getSupportedBackend(rawBackend);

    if (backend === 'off') {
      return { success: true };
    }
    if (await shouldSkipSyncForOfflineState(backend)) {
      return buildOfflineSkipResult('network');
    }

    const syncRun = new MobileSyncRun(backend, request, requestFollowUp, requestFollowUpAfter);
    return runSerializedSyncDocumentOperation(() => syncRun.run());
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

/** `manual` marks a user-initiated sync: it always runs the full read/merge cycle,
 *  never the fast-check skip, so a stale cached fingerprint can't hide remote data. */
export async function performMobileSync(
  syncPathOverride?: string,
  options?: {
    manual?: boolean;
    activationProbe?: boolean;
    ignorePendingRemoteWriteBackoff?: boolean;
    configOverride?: MobileSyncConfigOverride;
  }
): Promise<MobileSyncResult> {
  const wasInFlight = mobileSyncOrchestrator.getState().inFlight;
  if (wasInFlight && options?.activationProbe) {
    // The caller that owns this session-only config must observe its proof.
    // Never leave transient credentials queued after returning a requeue result.
    return { success: true, skipped: 'requeued' };
  }
  const result = mobileSyncOrchestrator.run({
    syncPathOverride,
    manual: options?.manual,
    activationProbe: options?.activationProbe,
    ignorePendingRemoteWriteBackoff: options?.ignorePendingRemoteWriteBackoff,
    configOverride: options?.configOverride,
  });
  if (wasInFlight && options?.configOverride) {
    // A queued orchestrator call normally receives the active run's promise.
    // That result did not exercise these pending settings, so surface a requeue
    // instead of letting the settings UI treat it as proof and persist them.
    void result.catch((error) => logSyncWarning('Active sync failed while a settings proof was queued', error));
    return { success: true, skipped: 'requeued' };
  }
  return result;
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
    clearMobileSyncConfigCache();
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
