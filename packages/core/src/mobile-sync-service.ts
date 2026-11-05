


import type { AppData, Attachment } from './types';
import type { SqliteReadToken, SqliteStaleOption } from './sqlite-adapter';
import { SYNC_ENCRYPTION_LOG_EVENTS, buildSyncEncryptionActivationExtra, buildSyncEncryptionErrorExtra, buildSyncEncryptionRemoteReadExtra, buildSyncEncryptionStateExtra, type SyncEncryptionStateDecision } from './sync-encryption-diagnostics';
import { buildSyncLocationScope, isSyncEncryptionPartlyEncryptedError, markRemoteEncryptionDiscovered, SyncEncryptionPartlyEncryptedError, markRemotePlaintextDiscovered, restoreVerifiedRemoteEncryption, syncEncryptedArtifactName, SyncEncryptionRemoteConflictError, SyncEncryptionRemotePlaintextError, SyncEncryptionRemoteVersionUnavailableError, SyncEncryptionTerminalError, SyncEncryptionTransitionIncompleteError, type SyncEncryptionState } from './sync-encryption';
import { SyncEncryptionNoKeyError, SyncEncryptionStateUnavailableError, type SyncEncryptionStateStore } from './sync-encryption-local-state';
import type { SyncCryptoPrimitives, SyncKeyMaterial } from './sync-crypto';
import type { AttachmentTransferAdmission } from './attachment-transfer';
import { UNREACHABLE_ATTACHMENTS_KEY } from './unreachable-attachments';
import type { SyncEncryptionService } from './sync-encryption-service';
import { acquireSyncRemoteMutationFence, SYNC_REMOTE_MUTATION_REQUEST_HORIZON_MS } from './sync-remote-fence';
import { createDropboxSyncRemoteMutationFencePort, createWebdavSyncRemoteMutationFencePort, webdavMutationFenceUrl } from './sync-remote-fence-providers';
import { clearIdleSyncCycleSnapshot, runSharedSyncCycle } from './sync-run';
import { SyncRemoteWriteConflict, type SyncEncryptionPosture, type SyncFollowUpReason, type SyncRunDiagnosticEvent, type SyncRunNotifier, type SyncRunPlatformHooks, type SyncRunResult, type SyncRunStorage } from './sync-run-ports';
import { createSyncBackendIO, type FileSyncReadResult, type SyncBackendContext, type SyncTransport } from './sync-backend-io';
import type { SyncBackendIO } from './sync-run-ports';
import { createSyncOrchestrator } from './sync-orchestrator';
import { NativeAttachmentCleanupUnconfirmedError } from './native-attachment-cleanup';
import { runSerializedSyncDocumentOperation } from './data-transfer-transaction';
import { isRetryableError, isRetryableWebdavReadError, isWebdavInvalidJsonError, withRetry } from './retry-utils';
import { cloudGetJson, cloudHeadJson, cloudPutJson } from './cloud';
import { probeWebdavSyncCompatibility, webdavGetSyncDocument, webdavHeadFile, webdavPutSyncDocument } from './webdav';
import { deleteDropboxFileVersioned, downloadDropboxAppData, DropboxFileNotFoundError, getDropboxAppDataMetadata, getDropboxFileMetadata, isDropboxUnauthorizedError, uploadDropboxAppData } from './dropbox';
import { hasPendingSyncSideEffects, injectExternalCalendars as injectExternalCalendarsForSync, normalizeCloudUrl, normalizeWebdavUrl, persistExternalCalendars as persistExternalCalendarsForSync } from './sync-helpers';
import { buildFastSyncScope, parseFastSyncState, serializeFastSyncState, type FastSyncState } from './sync-fast-sync';
import { CLOUD_PROVIDER_DROPBOX, CLOUD_PROVIDER_SELF_HOSTED, applySyncedDataToStore, captureInMemoryAppDataSnapshot, createAbortableFetch, getInMemoryAppDataSnapshot, loadLeavesStorePass, prepareSyncedDataPublishPass, normalizeCloudProvider as normalizeCoreCloudProvider, type CloudProvider } from './sync-client-helpers';
import { buildSyncPayloadSurfaceTraceExtra, buildSyncPayloadTraceExtra, isSyncPayloadTraceEnabled, SYNC_TRACE_EVENT_MESSAGES } from './sync-payload-trace';
import { isLikelyOfflineSyncError, isRemoteSyncBackend, SYNC_FILE_NAME, SyncFileLockUnavailableError, type SyncBackend } from './sync-service-utils';
import { summarizeTaskLifecycleCounts } from './task-utils';
import { decodeUriSafe } from './async-utils';
import { flushPendingSave, lastStoreLoadWasRecovery, sameStoreData, storeDataOf, useTaskStore } from './store';
import { getStoreListenerCount } from './store-notify-profiler';
import { createSlicer, runSliced, type CooperativePass } from './cooperative';
import { isSandboxMode, isWorkspaceTransitionActive } from './sandbox';
import { performSyncCycle } from './sync';
import { isSecretConfigKey } from './sync-secret-storage';
import { traceSectionAsync } from './perf-trace';
import { redactSyncText } from './sync-settings-model';
import { createWebdavSyncRateLimitController } from './sync-rate-limit';
import type { WebdavCapabilityProofStore } from './webdav-capability-proof';
import type { DropboxAccessTokenResolution, DropboxAuthTokens } from './dropbox-auth-tokens';
import {
  CLOUD_ALLOW_INSECURE_HTTP_KEY,
  CLOUD_PROVIDER_KEY,
  CLOUD_TOKEN_KEY,
  CLOUD_URL_KEY,
  DROPBOX_LAST_REV_KEY,
  FAST_SYNC_STATE_KEY,
  SYNC_BACKEND_KEY,
  SYNC_PATH_BOOKMARK_KEY,
  SYNC_PATH_KEY,
  WEBDAV_ALLOW_INSECURE_HTTP_KEY,
  WEBDAV_ALLOW_WEAK_FINGERPRINT_KEY,
  WEBDAV_PASSWORD_KEY,
  WEBDAV_URL_KEY,
  WEBDAV_USERNAME_KEY,
  type SyncKeyValueStoragePort,
} from './sync-storage-keys';
import {
  classifySyncFailure,
  coerceSupportedBackend,
  formatMobileSyncErrorMessage as formatSyncErrorMessage,
  getMobileCloudRequestOptions,
  getMobileWebDavRequestOptions,
  isLikelyFilePath,
  normalizeFileSyncPath,
  resolveBackend,
} from './mobile-sync-utils';


const isSyncEncryptionError = (error: unknown): boolean =>
  error instanceof SyncEncryptionNoKeyError
  || error instanceof SyncEncryptionStateUnavailableError
  || error instanceof SyncEncryptionRemotePlaintextError
  || error instanceof SyncEncryptionTerminalError
  || error instanceof SyncEncryptionTransitionIncompleteError
  || error instanceof SyncEncryptionPartlyEncryptedError;

const DEFAULT_SYNC_TIMEOUT_MS = 30_000;
const WEBDAV_RETRY_OPTIONS = { maxAttempts: 5, baseDelayMs: 2000, maxDelayMs: 30_000 };
const WEBDAV_READ_RETRY_OPTIONS = { ...WEBDAV_RETRY_OPTIONS, shouldRetry: isRetryableWebdavReadError };
const DROPBOX_RETRY_OPTIONS = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 8000 };
const SYNC_CONFIG_CACHE_TTL_MS = 30_000;
const LOCAL_SYNC_STATUS_KEY = '@mindwtr_local_sync_status_v1';

type LocalSyncStatus = Pick<AppData['settings'], 'lastSyncAt' | 'lastSyncStatus' | 'lastSyncError' | 'lastSyncStats' | 'lastSyncHistory'>;

const IOS_TEMP_INBOX_PATH_PATTERN = /\/tmp\/[^/]*-Inbox\//i;

// eslint-disable-next-line no-control-regex
const INVALID_CONFIG_CHAR_PATTERN = /[\u0000-\u001F\u007F]/;
type MobileSyncActivityState = 'idle' | 'syncing';
type MobileSyncActivityListener = (state: MobileSyncActivityState) => void;


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

const sanitizeConfigValue = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  if (!value) return null;
  if (INVALID_CONFIG_CHAR_PATTERN.test(value)) return null;
  return value;
};

const getPathLeaf = (path: string): string => {
  const stripped = path.split('?')[0]?.split('#')[0]?.replace(/\/+$/, '') ?? '';
  const lastSlash = Math.max(stripped.lastIndexOf('/'), stripped.lastIndexOf('\\'));
  return lastSlash >= 0 ? stripped.slice(lastSlash + 1) : stripped;
};

const SYNC_BOOKMARK_EXPIRED_MESSAGE =
  'Sync location access expired. Please re-select the sync folder or file in Settings -> Data & Sync.';

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

type MobileSyncRequest = {
  syncPathOverride?: string;
  manual?: boolean;
  activationProbe?: boolean;
  acceptMissingAttachmentIds?: readonly string[];
  fileSyncLockBusyRetryAttempt?: number;
  ignorePendingRemoteWriteBackoff?: boolean;
  configOverride?: MobileSyncConfigOverride;
};

type MobileRequestFollowUp = (nextArg?: MobileSyncRequest) => void;
type MobileRequestFollowUpAfter = (delayMs: number, nextArg?: MobileSyncRequest) => void;


const MIN_FOLLOW_UP_DELAY_MS = 1_000;

const FOLLOW_UP_QUIET_MS = 2_000;
const MAX_FOLLOW_UP_DELAY_MS = 5 * 60_000;


export type MobileSyncNetworkState = {
  isConnected?: boolean | null;
  isInternetReachable?: boolean | null;
  isAirplaneModeEnabled?: unknown;
};


export type MobileSyncNetworkPort = {
  getState(): Promise<MobileSyncNetworkState>;
  subscribe(listener: (state: MobileSyncNetworkState) => void): { remove?: () => void };
};

export type MobileSyncLogContext = { scope?: string; extra?: Record<string, string>; force?: boolean };


export type MobileSyncLogPort = {
  info(message: string, context?: MobileSyncLogContext): unknown;
  warn(message: string, context?: MobileSyncLogContext): unknown;

  syncError(error: unknown, context: { backend: string; step: string; url?: string }): Promise<string | null | undefined>;

  sanitize(message: string): string;
};

export type MobileSyncFileAccessOptions = {
  bookmark?: string | null;
  locationScope?: string | null;
  expectedFingerprint?: string;
  material?: SyncKeyMaterial | null;
};


export type MobileSyncFileSyncPort<Lease> = {
  readVersioned(path: string, options: MobileSyncFileAccessOptions): Promise<FileSyncReadResult>;
  write(path: string, data: AppData, options: MobileSyncFileAccessOptions): Promise<void>;

  resolveUri(uri: string, options: { createIfMissing: boolean }): Promise<string>;

  isBookmarksAvailable(): boolean;
  resolveBookmark(bookmark: string): Promise<{ uri: string; refreshedBookmark: string | null } | null>;
  acquireLease(path: string): Promise<Lease>;
  revalidateLease(lease: Lease): Promise<void>;
  releaseLease(lease: Lease): Promise<void>;
};

type AttachmentPassResult = Promise<AppData | boolean | null | undefined>;

export type MobileSyncAttachmentCleanupOptions = {
  appData: AppData;
  backend: SyncBackend;
  webdavConfig: MobileWebDavSyncConfig | null;
  cloudConfig: MobileCloudSyncConfig | null;
  cloudProvider: CloudProvider;
  fetcher: typeof fetch;
  ensureLocalSnapshotFresh: () => void;
  assertRemoteMutationFenceHeld?: (minRemainingMs?: number) => Promise<void>;
  deleteDropboxAttachment: (cloudKey: string, ensureBeforeProviderDelete: () => void) => Promise<void>;
  isRemoteMissingError: (error: unknown) => boolean;
  logSyncInfo: (message: string, extra?: Record<string, string>) => void;
  logSyncWarning: (message: string, error?: unknown) => void;
};


export type MobileSyncAttachmentsPort = {
  syncWebdav(data: AppData, config: MobileWebDavSyncConfig, signal: AbortSignal, options: {
    activationProbe: boolean;
    activationContinuation?: boolean;
    phase?: 'prepare' | 'post-merge';
    assertRemoteMutationFenceHeld?: (minRemainingMs?: number) => Promise<void>;
    onTransferBatchDeferred?: () => void;
    material?: SyncKeyMaterial;
    transferAdmission?: AttachmentTransferAdmission;
  }): AttachmentPassResult;
  syncCloud(data: AppData, config: MobileCloudSyncConfig, options: {
    activationProbe: boolean;
    assertCurrent: () => void;
    assertRemoteMutationFenceHeld?: (minRemainingMs?: number) => Promise<void>;
    phase?: 'prepare' | 'post-merge';
    signal: AbortSignal;
    transferAdmission?: AttachmentTransferAdmission;
  }): AttachmentPassResult;
  syncDropbox(data: AppData, clientId: string, fetcher: typeof fetch, options: {
    activationProbe: boolean;
    phase?: 'prepare' | 'post-merge';
    resolveAccessToken: (forceRefresh: boolean) => Promise<string>;
    signal: AbortSignal;
    assertRemoteMutationFenceHeld?: (minRemainingMs?: number) => Promise<void>;
    material?: SyncKeyMaterial;
    transferAdmission?: AttachmentTransferAdmission;
  }): AttachmentPassResult;
  syncFile(data: AppData, syncPath: string, signal: AbortSignal, options: {
    activationProbe: boolean;
    phase?: 'prepare' | 'post-merge';
    material?: SyncKeyMaterial;
    transferAdmission?: AttachmentTransferAdmission;
  }): AttachmentPassResult;
  cleanupTempFiles(): Promise<void>;

  hasCompletedPresenceReconciliation(): Promise<boolean>;
  hasPendingWork(data: AppData, options: { contentCheckEnabled?: boolean }): Promise<boolean>;
  runCleanup(options: MobileSyncAttachmentCleanupOptions): Promise<{ appData: AppData; shouldInvalidateFastSyncState: boolean }>;

  clearDownloadBackoff?(): void;
};


export type MobileSyncCloudKitPort = {
  isAvailable(): boolean;
  ensureReady(options: { signal: AbortSignal }): Promise<void>;
  read(options: { signal: AbortSignal }): Promise<AppData | null>;
  write(data: AppData, options: { signal: AbortSignal }): Promise<void>;
  syncAttachments(data: AppData, signal: AbortSignal, options: {
    activationProbe: boolean;
    phase?: 'prepare' | 'post-merge';
  }): AttachmentPassResult;
};


export type MobileSyncDropboxAuthPort = {
  isConnected(): Promise<boolean>;
  getValidAccessToken(clientId: string, fetcher: typeof fetch): Promise<string>;
  forceRefreshAccessToken(clientId: string, fetcher: typeof fetch): Promise<string>;
  getValidAccessTokenForTokens(clientId: string, tokens: DropboxAuthTokens, fetcher: typeof fetch): Promise<DropboxAccessTokenResolution>;
  forceRefreshAccessTokenForTokens(clientId: string, tokens: DropboxAuthTokens, fetcher: typeof fetch): Promise<DropboxAccessTokenResolution>;
};


export type MobileSyncEncryptionPort = Pick<
  SyncEncryptionStateStore,
  | 'flushSyncEncryptionLocalState'
  | 'getSyncEncryptionStatus'
  | 'getSyncEncryptionMaterial'
  | 'isSyncEncryptionBlocked'
  | 'isSyncEncryptionPostureUnestablished'
  | 'loadSyncEncryptionLocalState'
  | 'logSyncEncryptionEvent'
  | 'syncEncryptionLocalState'
> & {


  probeLocationCiphertext?: (target?: Parameters<SyncEncryptionService['probeSyncLocationCiphertext']>[0]) => Promise<'plaintext' | 'encrypted' | 'mixed'>;
};


export type MobileSyncCoreFunctions = {
  useTaskStore: Pick<typeof useTaskStore, 'getState' | 'setState'>;
  flushPendingSave: typeof flushPendingSave;
  getInMemoryAppDataSnapshot: typeof getInMemoryAppDataSnapshot;
  isSandboxMode: typeof isSandboxMode;
  isWorkspaceTransitionActive: typeof isWorkspaceTransitionActive;
  performSyncCycle: typeof performSyncCycle;
  withRetry: typeof withRetry;
  probeWebdavSyncCompatibility: typeof probeWebdavSyncCompatibility;
  webdavGetSyncDocument: typeof webdavGetSyncDocument;
  webdavPutSyncDocument: typeof webdavPutSyncDocument;
  webdavHeadFile: typeof webdavHeadFile;
  cloudGetJson: typeof cloudGetJson;
  cloudPutJson: typeof cloudPutJson;
  cloudHeadJson: typeof cloudHeadJson;
  acquireSyncRemoteMutationFence: typeof acquireSyncRemoteMutationFence;
  createWebdavSyncRemoteMutationFencePort: typeof createWebdavSyncRemoteMutationFencePort;
  createDropboxSyncRemoteMutationFencePort: typeof createDropboxSyncRemoteMutationFencePort;
  downloadDropboxAppData: typeof downloadDropboxAppData;
  uploadDropboxAppData: typeof uploadDropboxAppData;
  getDropboxAppDataMetadata: typeof getDropboxAppDataMetadata;
  getDropboxFileMetadata: typeof getDropboxFileMetadata;
  deleteDropboxFileVersioned: typeof deleteDropboxFileVersioned;
};

const CORE_FUNCTIONS: MobileSyncCoreFunctions = {
  useTaskStore,
  flushPendingSave,
  getInMemoryAppDataSnapshot,
  isSandboxMode,
  isWorkspaceTransitionActive,
  performSyncCycle,
  withRetry,
  probeWebdavSyncCompatibility,
  webdavGetSyncDocument,
  webdavPutSyncDocument,
  webdavHeadFile,
  cloudGetJson,
  cloudPutJson,
  cloudHeadJson,
  acquireSyncRemoteMutationFence,
  createWebdavSyncRemoteMutationFencePort,
  createDropboxSyncRemoteMutationFencePort,
  downloadDropboxAppData,
  uploadDropboxAppData,
  getDropboxAppDataMetadata,
  getDropboxFileMetadata,
  deleteDropboxFileVersioned,
};

const CLOUDKIT_UNAVAILABLE: MobileSyncCloudKitPort = {
  isAvailable: () => false,
  ensureReady: async () => {
    throw new Error('CloudKit is not available on this platform');
  },
  read: async () => null,
  write: async () => undefined,
  syncAttachments: async () => false,
};

export type MobileSyncServiceHost<Lease> = {

  allowQueuedFollowUp?: boolean;


  sliceYield?(): Promise<void>;

  storage: SyncKeyValueStoragePort;

  getSecureConfigValue(key: string): Promise<string | null>;
  platform: {

    os(): string;

    isFossBuild: boolean;

    dropboxAppKey(): string;
  };
  network: MobileSyncNetworkPort;

  localData: {
    getData(options?: SqliteStaleOption): Promise<AppData>;
    saveData(data: AppData, options?: { token?: SqliteReadToken } & SqliteStaleOption): Promise<AppData | void>;

    readTokenOf?(data: AppData): SqliteReadToken | undefined;

    prepareSave?(data: AppData): CooperativePass<void>;
  };
  log: MobileSyncLogPort;
  externalCalendars: {
    load(): Promise<AppData['settings']['externalCalendars']>;
    save(calendars: NonNullable<AppData['settings']['externalCalendars']>): Promise<void>;
  };

  fetch: typeof fetch;
  crypto: SyncCryptoPrimitives;
  encryption: MobileSyncEncryptionPort;
  ensureWebdavCapabilityProof: WebdavCapabilityProofStore['ensureWebdavCapabilityProof'];
  dropboxAuth: MobileSyncDropboxAuthPort;
  fileSync: MobileSyncFileSyncPort<Lease>;
  attachments: MobileSyncAttachmentsPort;
  cloudKit?: MobileSyncCloudKitPort;
  core?: Partial<MobileSyncCoreFunctions>;
};

export const createMobileSyncService = <Lease>(host: MobileSyncServiceHost<Lease>) => {

  if (host.sliceYield && !host.localData.readTokenOf) {
    throw new Error('A slicing sync host must bind localData.readTokenOf');
  }
  const allowQueuedFollowUp = host.allowQueuedFollowUp !== false;

  let fatalCleanupError: NativeAttachmentCleanupUnconfirmedError | null = null;
  const core: MobileSyncCoreFunctions = { ...CORE_FUNCTIONS, ...host.core };
  const cloudKit = host.cloudKit ?? CLOUDKIT_UNAVAILABLE;
  const syncConfigCache = new Map<string, { value: string | null; readAt: number }>();
  const dropboxSyncEnabled = !host.platform.isFossBuild;


  const cycleSecrets = new Set<string>();
  const rememberSecret = (secret: string | null | undefined): void => {
    if (secret) cycleSecrets.add(secret);
  };
  const redact = (text: string): string => (cycleSecrets.size > 0 ? redactSyncText(text, [...cycleSecrets]) : text);
  const redactExtra = (extra: Record<string, string> | undefined): Record<string, string> | undefined => (
    extra && cycleSecrets.size > 0 ? Object.fromEntries(Object.entries(extra).map(([key, value]) => [key, redact(value)])) : extra
  );
  const redactError = (error: unknown): unknown => {
    if (cycleSecrets.size === 0) return error;
    if (!(error instanceof Error)) return redact(String(error));
    const copy = Object.assign(Object.create(Object.getPrototypeOf(error)) as Error, error);
    Object.defineProperty(copy, 'message', { value: redact(error.message), writable: true, configurable: true });
    Object.defineProperty(copy, 'stack', { value: error.stack === undefined ? undefined : redact(error.stack), writable: true, configurable: true });
    return copy;
  };


  const FAILURE_KIND_WORDS: Partial<Record<string, string>> = {
    auth: 'unauthorized',
    rateLimited: 'rate limit',
    permission: 'permission denied',
    misconfigured: 'not configured',
    conflict: 'conflict',
  };
  const redactFailure = (text: string): string => {
    const redacted = redact(text);
    if (redacted === text) return text;
    const kind = classifySyncFailure(text);
    const words = FAILURE_KIND_WORDS[kind];
    return classifySyncFailure(redacted) === kind || !words ? redacted : `${redacted} (${words})`;
  };

  const redactSyncStatus = <T extends Partial<Pick<AppData['settings'], 'lastSyncError' | 'lastSyncHistory'>>>(settings: T): T => {
    if (cycleSecrets.size === 0) return settings;
    const next = { ...settings };
    if (typeof next.lastSyncError === 'string') next.lastSyncError = redactFailure(next.lastSyncError);
    if (Array.isArray(next.lastSyncHistory)) {
      next.lastSyncHistory = next.lastSyncHistory.map((entry) => (typeof entry?.error === 'string' ? { ...entry, error: redactFailure(entry.error) } : entry));
    }
    return next;
  };
  const redactSyncData = (data: AppData): AppData => {
    const settings = data?.settings ? redactSyncStatus(data.settings) : data?.settings;
    return settings === data?.settings ? data : { ...data, settings };
  };
  const log: MobileSyncLogPort = {
    info: (message, context) => host.log.info(redact(message), context && { ...context, extra: redactExtra(context.extra) }),
    warn: (message, context) => host.log.warn(redact(message), context && { ...context, extra: redactExtra(context.extra) }),
    syncError: (error, context) => host.log.syncError(redactError(error), { ...context, url: context.url === undefined ? undefined : redact(context.url) }),
    sanitize: (message) => redact(host.log.sanitize(message)),
  };

  const logSyncWarning = (message: string, error?: unknown) => {
    const extra = error ? { error: log.sanitize(error instanceof Error ? error.message : String(error)) } : undefined;
    void log.warn(message, { scope: 'sync', extra });
  };

  const logSyncInfo = (message: string, extra?: Record<string, string>) => {
    void log.info(message, { scope: 'sync', extra });
  };

  const followUpReceipts = new Set<string>();
  let followUpIdleLogged = false;
  let previousCycleRequestedContribution = false;
  let contributionComparisonCaptured = false;
  let activeFollowUpContext: { backend: SyncBackend; step: string } | null = null;
  const logFollowUpDecision = (
    reason: SyncFollowUpReason | 'lifecycle' | 'busy-request',
    backend: string,
    step: string,
    request: Pick<MobileSyncRequest, 'manual' | 'activationProbe'>,
    suppressed = !allowQueuedFollowUp,
    extra: Record<string, string> = {},
  ): void => {
    try {
      if (core.isSandboxMode() && !isSyncPayloadTraceEnabled(core.useTaskStore.getState().settings)) return;
      const requestClass = request.activationProbe ? 'probe' : request.manual ? 'manual' : 'auto';
      const receipt = `${reason}:${requestClass}:${extra.comparison ?? ''}`;
      if (followUpReceipts.has(receipt)) return;
      followUpReceipts.add(receipt);
      void Promise.resolve(log.info('Mobile sync follow-up decision', {
        scope: 'sync', force: true,
        extra: { releaseCheck: 'v1.3.5/mobile-sync-follow-up', reason, backend, step, requestClass,
          outcome: suppressed ? 'suppressed' : 'requested', ...extra },
      })).catch(() => {});
    } catch {                                                    }
  };

  const resolveCloudProvider = (value: string | null): CloudProvider => (
    normalizeCoreCloudProvider(value, { allowDropbox: dropboxSyncEnabled })
  );

  const externalCalendarProvider = {
    load: () => host.externalCalendars.load(),
    save: (calendars: AppData['settings']['externalCalendars'] | undefined) =>
      host.externalCalendars.save(calendars ?? []),
    onWarn: (message: string, error?: unknown) => logSyncWarning(message, error),
  };

  const injectExternalCalendars = async (data: AppData): Promise<AppData> =>
    injectExternalCalendarsForSync(data, externalCalendarProvider);

  const persistExternalCalendars = async (data: AppData): Promise<void> =>
    persistExternalCalendarsForSync(data, externalCalendarProvider);

  const readFastSyncState = async (scope: string): Promise<FastSyncState | null> => {
    try {
      const raw = await host.storage.getItem(FAST_SYNC_STATE_KEY);
      return parseFastSyncState(raw, scope);
    } catch {
      return null;
    }
  };

  const writeFastSyncState = async (state: FastSyncState): Promise<void> => {
    try {
      await host.storage.setItem(FAST_SYNC_STATE_KEY, serializeFastSyncState(state));
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
      const raw = await host.storage.getItem(LOCAL_SYNC_STATUS_KEY);
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
      await host.storage.setItem(LOCAL_SYNC_STATUS_KEY, JSON.stringify(next));
    } catch (error) {
      logSyncWarning('Failed to cache local sync status', error);
    }
  };

  const applyLocalSyncStatus = async (raw: Partial<LocalSyncStatus>): Promise<void> => {
    const updates = redactSyncStatus(raw);
    await writeLocalSyncStatus(updates);
    core.useTaskStore.setState((state) => ({
      settings: {
        ...(state.settings ?? {}),
        ...updates,
      },
    }));
  };


  const readTokens = new WeakMap<AppData, SqliteReadToken>();
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
  const mobileSyncDrainListeners = new Set<() => void>();
  const webdavSyncRateLimitController = createWebdavSyncRateLimitController();
  let activeMobileSyncAbortController: AbortController | null = null;

  let activeMobileSyncAbortReason: 'lifecycle' | 'deadline' | null = null;

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

  const getMobileSyncActivityState = (): MobileSyncActivityState => mobileSyncActivityState;

  const subscribeMobileSyncActivityState = (listener: MobileSyncActivityListener): (() => void) => {
    mobileSyncActivityListeners.add(listener);
    listener(mobileSyncActivityState);
    return () => {
      mobileSyncActivityListeners.delete(listener);
    };
  };

  const waitForMobileSyncIdle = async (): Promise<void> => {
    if (fatalCleanupError) throw fatalCleanupError;
    if (core.isSandboxMode()) return;
    const isDrained = () => {
      const state = mobileSyncOrchestrator.getState();
      return !state.inFlight && !state.queued;
    };
    if (isDrained()) return;
    await new Promise<void>((resolve, reject) => {
      const onDrained = () => {
        if (!isDrained()) return;
        mobileSyncDrainListeners.delete(onDrained);
        if (fatalCleanupError) reject(fatalCleanupError);
        else resolve();
      };
      mobileSyncDrainListeners.add(onDrained);
      onDrained();
    });
  };

  const notifyMobileSyncDrainListeners = (): void => {
    const state = mobileSyncOrchestrator.getState();
    if (state.inFlight || state.queued) return;
    mobileSyncDrainListeners.forEach((listener) => listener());
  };

  const readStoredConfigValue = async (key: string): Promise<string | null> => {
    if (fatalCleanupError) throw fatalCleanupError;
    return isSecretConfigKey(key) ? host.getSecureConfigValue(key) : host.storage.getItem(key);
  };

  const readConfigValue = async (key: string, useCache = true): Promise<string | null> => {
    if (fatalCleanupError) throw fatalCleanupError;
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


  const clearMobileSyncConfigCache = (): void => {
    syncConfigCache.clear();
    host.attachments.clearDownloadBackoff?.();
  };

  const getCachedConfigValue = async (key: string): Promise<string | null> => {
    return readConfigValue(key, true);
  };

  const resolveBookmarkedFileSyncPath = async (
    syncPath: string | null
  ): Promise<{ path: string | null; bookmark: string | null }> => {
    if (host.platform.os() !== 'ios') return { path: syncPath, bookmark: null };

    const bookmark = (await getCachedConfigValue(SYNC_PATH_BOOKMARK_KEY))?.trim() ?? null;
    if (!bookmark) return { path: syncPath, bookmark: null };

    const resolved = await host.fileSync.resolveBookmark(bookmark);
    if (!resolved?.uri) {
      if (host.fileSync.isBookmarksAvailable()) {
        throw new Error(SYNC_BOOKMARK_EXPIRED_MESSAGE);
      }
      return { path: syncPath, bookmark };
    }

    let activeBookmark = bookmark;
    if (resolved.refreshedBookmark && resolved.refreshedBookmark !== bookmark) {
      await host.storage.setItem(SYNC_PATH_BOOKMARK_KEY, resolved.refreshedBookmark);
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
      await host.storage.setItem(SYNC_PATH_KEY, resolvedPath);
      syncConfigCache.set(SYNC_PATH_KEY, { value: resolvedPath, readAt: Date.now() });
      logSyncInfo('Resolved iOS sync-folder bookmark', {
        bookmarkPath: bookmarkUri,
        filePath: resolvedPath,
      });
    }

    return { path: resolvedPath, bookmark: activeBookmark };
  };

  const getSupportedBackend = (rawBackend: string | null): SyncBackend =>
    coerceSupportedBackend(resolveBackend(rawBackend), cloudKit.isAvailable());


  async function getMobileSelectedSyncBackend(): Promise<SyncBackend> {
    if (fatalCleanupError) throw fatalCleanupError;
    if (core.isSandboxMode()) return 'off';
    const raw = (await readConfigValue(SYNC_BACKEND_KEY, false))?.trim() ?? null;
    const backend = resolveBackend(raw);

    if (backend === 'off' && raw && raw !== 'off') throw new Error('Unknown sync backend selection');
    return backend;
  }

  async function getMobileSyncConfigurationStatus(): Promise<{ backend: SyncBackend; configured: boolean; cloudProvider?: CloudProvider }> {
    if (fatalCleanupError) throw fatalCleanupError;
    if (core.isSandboxMode()) return { backend: 'off', configured: false };
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

      return { backend, configured: cloudKit.isAvailable() };
    }

    const cloudProvider = resolveCloudProvider((await readConfigValue(CLOUD_PROVIDER_KEY, false))?.trim() ?? null);
    if (cloudProvider === CLOUD_PROVIDER_DROPBOX) {
      const dropboxConnected = await host.dropboxAuth.isConnected().catch(() => false);
      return {
        backend,
        cloudProvider,
        configured: dropboxSyncEnabled && host.platform.dropboxAppKey().length > 0 && dropboxConnected,
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

  const shouldSkipSyncForOfflineState = async (
    backend: SyncBackend,
    onOffline?: (status: MobileNetworkStatus) => void
  ): Promise<boolean> => {
    if (!isRemoteSyncBackend(backend)) return false;
    try {
      const state = await host.network.getState();
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


  class MobileSyncRun {
    private readonly backend: SyncBackend;
    private readonly syncPathOverride: string | undefined;
    private readonly manual: boolean;
    private readonly activationProbe: boolean;
    private readonly acceptMissingAttachmentIds: readonly string[] | undefined;
    private readonly fileSyncLockBusyRetryAttempt: number;
    private readonly ignorePendingRemoteWriteBackoff: boolean;
    private readonly configOverride: MobileSyncConfigOverride | undefined;
    private readonly requestFollowUp: MobileRequestFollowUp;
    private readonly requestFollowUpAfter: MobileRequestFollowUpAfter;

    private lastStep = 'init';

    private lastPreparedPublish: { data: AppData; storeData: readonly unknown[] } | null = null;
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
    private readonly fetchWithAbort = createAbortableFetch(host.fetch, { baseSignal: this.requestAbortController.signal });

    private webdavConfig: MobileWebDavSyncConfig | null = null;
    private cloudConfig: MobileCloudSyncConfig | null = null;
    private cloudProvider: CloudProvider = CLOUD_PROVIDER_SELF_HOSTED;
    private dropboxClientId = '';
    private dropboxLastRev: string | null = null;
    private fileSyncPath: string | null = null;
    private fileSyncBookmark: string | null = null;
    private fileSyncLease: Lease | null = null;
    private activationProof: MobileSyncResult['activationProof'];
    private allowLegacyWebdavPlaintext = false;


    private syncEncryptionOff = false;


    private encryptionMaterial: SyncKeyMaterial | null = null;


    private locationScope: string | null = null;


    private deferUploadsUntilDiscovery = false;


    private deferredAttachmentWork = false;

    private locationCiphertext: 'plaintext' | 'encrypted' | 'mixed' | null = null;


    private encryptionStateAtSetup: SyncEncryptionState | 'unknown' = 'unknown';


    private buildLocationScope(): string {
      return buildSyncLocationScope({
        backend: this.backend,
        syncPath: this.fileSyncPath,
        webdavUrl: this.webdavConfig?.url,
        webdavUsername: this.webdavConfig?.username,
        cloudProvider: this.cloudProvider,
        cloudUrl: this.cloudConfig?.url,
      });
    }

    private async assertFileSyncLeaseHeld(): Promise<void> {
      if (this.backend !== 'file') return;
      if (!this.fileSyncLease) throw new SyncFileLockUnavailableError();
      await host.fileSync.revalidateLease(this.fileSyncLease);
    }

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
      this.acceptMissingAttachmentIds = request?.acceptMissingAttachmentIds;
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
      activeFollowUpContext = { backend, step: 'setup' };
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
            acceptMissingAttachmentIds: this.acceptMissingAttachmentIds,
            fileSyncLockBusyRetryAttempt: this.fileSyncLockBusyRetryAttempt,
            ignorePendingRemoteWriteBackoff: this.ignorePendingRemoteWriteBackoff,
          },
          storage: this.createStorage(),
          notifier: this.createNotifier(),
          store: {
            getLastDataChangeAt: () => core.useTaskStore.getState().lastDataChangeAt,
            getInMemorySnapshot: () => core.getInMemoryAppDataSnapshot(),

            captureInMemorySnapshot: () => captureInMemoryAppDataSnapshot(core.useTaskStore),
            listenerCount: () => getStoreListenerCount(),
            flushPendingSave: () => core.flushPendingSave(),
            setUiError: (message) => core.useTaskStore.getState().setError(message),
            getSettings: () => core.useTaskStore.getState().settings,
          },
          hooks: this.createHooks(),
          policy: {
            preSyncAttachmentsBeforeFastCheck: true,


            carryIdleCycleSnapshot: true,


            enableReadCheckSkip: backend !== 'file',
            postMergeAttachmentErrorPolicy: 'fail',
            attachmentPhasesEnabled: true,
          },


          performSyncCycle: async (io) => {
            const result = await core.performSyncCycle({ ...io, writeLocal: (data) => io.writeLocal(redactSyncData(data)) });
            return { ...result, data: redactSyncData(result.data) };
          },
        });
        result = this.activationProof ? { ...cycleResult, activationProof: this.activationProof } : cycleResult;
        await this.logActivationOutcome();
      } catch (error) {
        if (error instanceof NativeAttachmentCleanupUnconfirmedError) {
          fatalCleanupError = error;
          mobileSyncOrchestrator.clearFollowUp();
        }
        throw error;
      } finally {
        previousCycleRequestedContribution = this.requestedServerContribution;
        fileSyncLockCleanupDeferred = await this.releaseResources();
        activeFollowUpContext = null;
      }
      return result.success && fileSyncLockCleanupDeferred
        ? { ...result, fileSyncLockDeferred: 'cleanup' }
        : result;
    }


    private async logActivationOutcome(): Promise<void> {
      if (!this.activationProbe) return;
      const after = await host.encryption.loadSyncEncryptionLocalState().catch(() => null);
      host.encryption.logSyncEncryptionEvent(
        SYNC_ENCRYPTION_LOG_EVENTS.activation,
        buildSyncEncryptionActivationExtra({
          activationProof: this.activationProof ?? null,
          stateBefore: this.encryptionStateAtSetup,
          stateAfter: after?.state ?? 'off',
          backend: this.backend,
        }),
        { force: true },
      );
    }

    private queueFollowUp(): void {
      if (!allowQueuedFollowUp) return;
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
      if (!allowQueuedFollowUp) return;
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
        this.networkSubscription = host.network.subscribe((state) => {
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


      this.fileSyncLease = await host.fileSync.acquireLease(fileSyncPath);
      const normalizedPath = normalizeFileSyncPath(fileSyncPath, host.platform.os());
      if (normalizedPath && normalizedPath !== fileSyncPath) {
        fileSyncPath = normalizedPath;
        if (!this.configOverride?.syncPath) {
          await host.storage.setItem(SYNC_PATH_KEY, normalizedPath);
          syncConfigCache.set(SYNC_PATH_KEY, { value: normalizedPath, readAt: Date.now() });
        }
        logSyncInfo('Normalized file sync path to iOS file URI');
      }
      if (fileSyncPath.startsWith('file://') && IOS_TEMP_INBOX_PATH_PATTERN.test(decodeUriSafe(fileSyncPath))) {
        throw new Error('Selected iOS sync file is in a temporary Inbox location and is read-only. Re-select a folder in Settings -> Sync.');
      }
      if (fileSyncPath.startsWith('content://')) {
        try {
          const resolvedPath = await host.fileSync.resolveUri(fileSyncPath, { createIfMissing: true });
          if (resolvedPath && resolvedPath !== fileSyncPath) {
            if (!this.configOverride?.syncPath) {
              await host.storage.setItem(SYNC_PATH_KEY, resolvedPath);
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
        rememberSecret(this.webdavConfig.password);
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
      rememberSecret(password);
    }

    private async resolveCloudBackendConfig(): Promise<void> {
      const overrideProvider = this.configOverride?.cloudProvider;
      if (overrideProvider) {
        if (!dropboxSyncEnabled && overrideProvider === CLOUD_PROVIDER_DROPBOX) {
          throw new Error('Dropbox sync is unavailable in this build. Choose Self-hosted Cloud or install the Dropbox-enabled build.');
        }
        this.cloudProvider = overrideProvider;
        if (this.cloudProvider === CLOUD_PROVIDER_DROPBOX) {
          this.dropboxClientId = host.platform.dropboxAppKey();
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
        rememberSecret(this.cloudConfig.token);
        return;
      }
      const storedCloudProvider = (await getCachedConfigValue(CLOUD_PROVIDER_KEY))?.trim() ?? null;
      this.cloudProvider = resolveCloudProvider(storedCloudProvider);
      if (!dropboxSyncEnabled && storedCloudProvider === CLOUD_PROVIDER_DROPBOX) {
        throw new Error('Dropbox sync is unavailable in this build. Choose Self-hosted Cloud or install the Dropbox-enabled build.');
      }
      if (this.cloudProvider === CLOUD_PROVIDER_DROPBOX) {
        this.dropboxClientId = host.platform.dropboxAppKey();
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
        rememberSecret(token);
      }
    }


    private dropboxTransientRetryOptions() {
      return {
        ...DROPBOX_RETRY_OPTIONS,
        shouldRetry: (error: unknown) => !this.networkWentOffline
          && !this.requestAbortController.signal.aborted
          && isRetryableError(error),
        onRetry: (error: unknown, attempt: number) => logSyncWarning(`Dropbox request failed (attempt ${attempt}); retrying`, error),
      };
    }


    private async runDropboxOperation<T>(operation: (accessToken: string) => Promise<T>): Promise<T> {
      return core.withRetry(async () => {
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
        const accessToken = forceRefresh
          ? await host.dropboxAuth.forceRefreshAccessToken(this.dropboxClientId, this.fetchWithAbort)
          : await host.dropboxAuth.getValidAccessToken(this.dropboxClientId, this.fetchWithAbort);
        rememberSecret(accessToken);
        return accessToken;
      }
      rememberSecret(stagedCredentials.tokens.accessToken);
      rememberSecret(stagedCredentials.tokens.refreshToken);

      const resolution = forceRefresh
        ? await host.dropboxAuth.forceRefreshAccessTokenForTokens(
          this.dropboxClientId,
          stagedCredentials.tokens,
          this.fetchWithAbort,
        )
        : await host.dropboxAuth.getValidAccessTokenForTokens(
          this.dropboxClientId,
          stagedCredentials.tokens,
          this.fetchWithAbort,
        );


      stagedCredentials.tokens = resolution.tokens;
      rememberSecret(resolution.accessToken);
      rememberSecret(resolution.tokens.accessToken);
      rememberSecret(resolution.tokens.refreshToken);
      return resolution.accessToken;
    }


    private runDropboxTransientRetry<T>(operation: () => Promise<T>): Promise<T> {
      return core.withRetry(operation, this.dropboxTransientRetryOptions());
    }

    private async persistDropboxRev(rev: string | null): Promise<void> {
      this.dropboxLastRev = rev;
      if (this.activationProbe) return;
      if (rev) {
        await host.storage.setItem(DROPBOX_LAST_REV_KEY, rev);
        syncConfigCache.set(DROPBOX_LAST_REV_KEY, { value: rev, readAt: Date.now() });
      } else {
        await host.storage.removeItem(DROPBOX_LAST_REV_KEY);
        syncConfigCache.set(DROPBOX_LAST_REV_KEY, { value: null, readAt: Date.now() });
      }
    }

    private createStorage(): SyncRunStorage {
      return {
        readPersistedLocal: async (options) => {
          if (!options) return mergeLocalSyncStatus(await host.localData.getData());

          const read = await host.localData.getData(options);
          const merged = await mergeLocalSyncStatus(read);
          const token = host.localData.readTokenOf?.(read);
          if (token) readTokens.set(merged, token);
          return merged;
        },
        persistLocal: async (data, options) => {
          await this.assertFileSyncLeaseHeld();
          await (options ? host.localData.saveData(data, options) : host.localData.saveData(data));
        },

        readTokenOf: (data) => host.localData.readTokenOf?.(data) ?? readTokens.get(data),

        afterPersistLocal: () => this.assertFileSyncLeaseHeld(),

        applyDataToStore: (data, prepared) => {
          const swapped = applySyncedDataToStore(data, core.useTaskStore, prepared);
          this.lastPreparedPublish = swapped && prepared
            ? { data, storeData: storeDataOf(core.useTaskStore.getState()) }
            : null;
          return swapped;
        },

        prepareLocalSave: (data) => host.localData.prepareSave?.(data),
        prepareStorePublish: (data) => prepareSyncedDataPublishPass(data, core.useTaskStore),
        persistSyncStatus: async (updates) => {
          await this.assertFileSyncLeaseHeld();
          await applyLocalSyncStatus(updates);
          await this.assertFileSyncLeaseHeld();
        },
        readFastSyncState: (scope) => readFastSyncState(scope),
        writeFastSyncState: (state) => writeFastSyncState(state),
        readUnreachableAttachments: () => host.storage.getItem(UNREACHABLE_ATTACHMENTS_KEY),
        writeUnreachableAttachments: (raw) => host.storage.setItem(UNREACHABLE_ATTACHMENTS_KEY, raw),
        injectExternalCalendars: (data) => injectExternalCalendars(data),
        persistExternalCalendars: (data) => persistExternalCalendars(data),
      };
    }

    private createNotifier(): SyncRunNotifier {


      let lastStepStartedAtMs = 0;
      return {
        setStep: (step) => {
          this.lastStep = step;
          if (activeFollowUpContext) activeFollowUpContext.step = step;
          const nowMs = Date.now();
          const sinceLastStepMs = lastStepStartedAtMs > 0 ? nowMs - lastStepStartedAtMs : 0;
          lastStepStartedAtMs = nowMs;
          logSyncInfo('Sync step', { step, sinceLastStepMs: String(sinceLastStepMs) });
        },
        logInfo: (message, extra) => logSyncInfo(message, extra),
        logWarning: (message, error) => logSyncWarning(message, error),
        logWarningExtra: (message, extra) => {
          void log.warn(message, { scope: 'sync', extra });
        },
        sanitizeLogMessage: (message) => log.sanitize(message),
        ...(host.sliceYield ? { sliceYield: () => host.sliceYield!() } : {}),
        logSyncError: (error, context) => {
          this.logEncryptionFailure(error, context.step);
          return log.syncError(error, {
            backend: context.backend,
            step: context.step,
            url: context.url,
          });
        },
        logMergeSummary: (mergeLog) => {
          void log.info(
            mergeLog.message,
            {
              scope: 'sync',
              extra: mergeLog.extra,


              force: mergeLog.summary.conflicts > 0,
            }
          );
        },


        tracePayload: (event, data, extra) => {
          if (!isSyncPayloadTraceEnabled(core.useTaskStore.getState().settings)) return;
          logSyncInfo(SYNC_TRACE_EVENT_MESSAGES[event], buildSyncPayloadTraceExtra(data, extra));
        },
        onDiagnostic: (event) => this.handleDiagnosticEvent(event),
      };
    }

    private requestedServerContribution = false;

    private handleDiagnosticEvent(event: SyncRunDiagnosticEvent): void {
      const backend = this.backend;
      if (event.event === 'follow-up-requested' && event.followUpReason) {
        const extra: Record<string, string> = {};
        if (event.followUpReason === 'server-contribution') {
          this.requestedServerContribution = true;
          if (allowQueuedFollowUp && previousCycleRequestedContribution && !contributionComparisonCaptured && event.data) {
            contributionComparisonCaptured = true;

            try {
              Object.assign(extra, buildSyncPayloadSurfaceTraceExtra(event.data, 'outgoing'));
              if (event.previousData) Object.assign(extra, buildSyncPayloadSurfaceTraceExtra(event.previousData, 'priorRemote'));
              extra.comparison = event.previousData ? 'captured' : 'prior-remote-unavailable';
            } catch { extra.comparison = 'unavailable'; }
          }
        }
        logFollowUpDecision(event.followUpReason, backend, this.lastStep,
          { manual: this.manual, activationProbe: this.activationProbe }, !allowQueuedFollowUp, extra);
        return;
      }
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


    private supportsSyncEncryption(): boolean {
      if (this.backend === 'file' || this.backend === 'webdav') return true;
      return this.backend === 'cloud' && this.cloudProvider === CLOUD_PROVIDER_DROPBOX;
    }


    private logRemoteRead(input: Parameters<typeof buildSyncEncryptionRemoteReadExtra>[0]): void {
      host.encryption.logSyncEncryptionEvent(
        SYNC_ENCRYPTION_LOG_EVENTS.remoteRead,
        buildSyncEncryptionRemoteReadExtra(input),
      );
    }


    private async assertLocationNotPartlyEncrypted(): Promise<void> {
      if (this.encryptionMaterial) return;
      const probe = host.encryption.probeLocationCiphertext;
      if (!probe || (this.backend !== 'webdav' && !(this.backend === 'cloud' && this.cloudProvider === 'dropbox'))) return;

      if (this.locationCiphertext === null) {
        this.locationCiphertext = await probe(this.backend === 'webdav' ? (this.webdavConfig ? { webdav: this.webdavConfig } : undefined) : {
          dropbox: {
            clientId: this.dropboxClientId,
            runAuthorized: (operation) => this.runDropboxOperation(operation),
            fetcher: this.fetchWithAbort,
          },
        });
        if (this.configOverride && this.backend === 'cloud' && this.cloudProvider === CLOUD_PROVIDER_DROPBOX) {
          void log.warn('Dropbox candidate location ciphertext checked', { scope: 'sync', extra: {
            releaseCheck: 'v1.3.5/dropbox-candidate-encryption-probe', backend: this.backend, found: this.locationCiphertext,
          } });
        } else if (this.configOverride) {
          logSyncInfo('Sync candidate location ciphertext checked', {
            releaseCheck: 'v1.3.5/candidate-ciphertext-probe', backend: this.backend, found: this.locationCiphertext,
          });
        }
      }
      if (this.locationCiphertext !== 'plaintext') throw new SyncEncryptionPartlyEncryptedError();
    }


    private async rememberPartlyEncrypted(): Promise<void> {
      try {
        const current = await host.encryption.loadSyncEncryptionLocalState();
        if (current && (current.state !== 'off' || current.incompleteTransition)) return;
        if (!this.locationScope) return;
        await host.encryption.syncEncryptionLocalState.write({ state: 'off', partlyEncryptedScope: this.locationScope });
        await host.encryption.flushSyncEncryptionLocalState();
      } catch {

      }
    }

    private logEncryptionFailure(error: unknown, step: string): void {
      if (isSyncEncryptionPartlyEncryptedError(error)) void this.rememberPartlyEncrypted();
      if (!isSyncEncryptionError(error)) return;
      const message = error instanceof Error ? error.message : String(error);
      host.encryption.logSyncEncryptionEvent(
        SYNC_ENCRYPTION_LOG_EVENTS.error,
        buildSyncEncryptionErrorExtra({
          errorName: error instanceof Error ? error.name : 'unknown',
          errorMessage: redact(message),
          backend: this.backend,
          step,
          classification: classifySyncFailure(error),
        }),
        { level: 'warn', force: true },
      );
    }

    private markCandidateEncryptedRemoteProven(): void {
      if (this.activationProbe && this.configOverride) {
        this.activationProof = 'remote-encrypted-no-key';
      }
    }

    private createHooks(): SyncRunPlatformHooks {
      return {
        setupCycle: async ({ setStep, setBackend }) => {
          this.deferredAttachmentWork = false;
          const backend = this.backend;
          setBackend(backend);
          if (backend === 'file' && !(await this.resolveFileBackendConfig())) {
            return { kind: 'disabled' };
          }
          if (backend === 'webdav') {
            await this.resolveWebdavBackendConfig();
          }
          if (backend === 'cloud') {
            await this.resolveCloudBackendConfig();
          }


          const fastSyncScope = buildFastSyncScope({
            backend,
            webdavConfig: this.webdavConfig,
            cloudProvider: this.cloudProvider,
            cloudConfig: this.cloudConfig,
            dropboxClientId: this.dropboxClientId,
          });


          let legacyWebdavPostureAllowed = false;
          if (this.supportsSyncEncryption()) {
            const probingCandidate = this.activationProbe && Boolean(this.configOverride);
            this.locationScope = this.buildLocationScope();
            const encryptionStatus = await host.encryption.getSyncEncryptionStatus();
            const incompleteTransition = encryptionStatus.incompleteTransition;


            const localState = await host.encryption.loadSyncEncryptionLocalState().catch(() => null);
            this.encryptionStateAtSetup = localState?.state ?? 'off';


            const logState = (decision: SyncEncryptionStateDecision, hasMaterial: boolean | null) => {
              host.encryption.logSyncEncryptionEvent(
                SYNC_ENCRYPTION_LOG_EVENTS.state,
                buildSyncEncryptionStateExtra({
                  backend,
                  trigger: this.activationProbe ? 'probe' : this.manual ? 'manual' : 'auto',
                  state: localState?.state ?? 'off',
                  hasMaterial,
                  salt: localState?.discoveredSalt,
                  kdf: localState?.discoveredParams,
                  incompleteTransition,
                  discoveredScope: localState?.discoveredScope,
                  activeScope: this.locationScope,
                  decision,
                }),
              );
            };
            legacyWebdavPostureAllowed = backend === 'webdav'
              && encryptionStatus.state === 'off'
              && !incompleteTransition;
            this.allowLegacyWebdavPlaintext = false;


            if (!probingCandidate && localState?.partlyEncryptedScope
              && (this.locationScope === null || localState.partlyEncryptedScope === this.locationScope)) {
              logState('blocked-partly-encrypted', null);
              if (!this.manual) return { kind: 'disabled' };
              throw new SyncEncryptionPartlyEncryptedError();
            }
            if (incompleteTransition) {
              logState('blocked-transition', null);
              if (!this.manual && !probingCandidate) return { kind: 'disabled' };
              throw new SyncEncryptionTransitionIncompleteError(incompleteTransition);
            }


            if (!probingCandidate && await host.encryption.isSyncEncryptionBlocked(this.locationScope)) {
              logState(
                localState?.state === 'remote-plaintext' ? 'blocked-plaintext' : 'blocked-no-key',
                null,
              );
              if (!this.manual) return { kind: 'disabled' };
              throw new SyncEncryptionNoKeyError();
            }


            const hasCompletedCycleAgainstLocation = (
              await host.attachments.hasCompletedPresenceReconciliation()
            ) || (backend !== 'file' && fastSyncScope
              ? (await readFastSyncState(fastSyncScope)) !== null
              : false);
            this.deferUploadsUntilDiscovery = await host.encryption.isSyncEncryptionPostureUnestablished(
              this.locationScope,
              hasCompletedCycleAgainstLocation,
            );
            try {
              this.encryptionMaterial = await host.encryption.getSyncEncryptionMaterial();
            } catch (error) {


              logState('blocked-no-key', false);
              throw error;
            }
            logState(
              probingCandidate ? 'probe' : legacyWebdavPostureAllowed ? 'legacy-plaintext' : 'proceed',
              this.encryptionMaterial !== null,
            );
          }
          this.syncEncryptionOff = legacyWebdavPostureAllowed;
          if (backend === 'webdav') {
            const webdavConfig = this.webdavConfig!;
            const compatibility = await host.ensureWebdavCapabilityProof(webdavConfig, async () => {


              setStep('webdav_probe');


              const compatibility = await core.withRetry(() => core.probeWebdavSyncCompatibility(webdavConfig.url, {
                ...getMobileWebDavRequestOptions(webdavConfig.allowInsecureHttp),
                username: webdavConfig.username,
                password: webdavConfig.password,
                timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
                fetcher: this.fetchWithAbort,
              }, {
                requireStrongEtag: !legacyWebdavPostureAllowed,
              }), WEBDAV_READ_RETRY_OPTIONS);
              if (compatibility === 'legacy-plaintext' && !legacyWebdavPostureAllowed) {
                throw new SyncEncryptionRemoteVersionUnavailableError('WebDAV data.json');
              }
              return compatibility;
            }, { allowLegacyPlaintext: legacyWebdavPostureAllowed });
            this.allowLegacyWebdavPlaintext = compatibility === 'legacy-plaintext';
          }

          if (backend === 'cloudkit') {
            if (!cloudKit.isAvailable()) {
              throw new Error('CloudKit is not available on this platform');
            }
            setStep('cloudkit_setup');
            await cloudKit.ensureReady({ signal: this.requestAbortController.signal });
          }
          return {
            kind: 'ready',
            backend,
            cloudProvider: this.cloudProvider,
            io: this.createBackendIO(),
            fastSyncScope,
            locationScope: this.buildLocationScope(),
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
        hasDeferredAttachmentWork: () => this.deferredAttachmentWork,
        shouldRunAttachmentPhase: async (data, phase) => {
          const backend = this.backend;


          if (phase === 'prepare' && this.deferUploadsUntilDiscovery) {
            this.deferredAttachmentWork = await host.attachments.hasPendingWork(data, {
              contentCheckEnabled: backend === 'file' || backend === 'webdav' || backend === 'cloudkit' || backend === 'cloud',
            });
            logSyncInfo('Attachment pre-sync skipped', {
              backend,
              reason: 'encryption-recheck',
              ...(this.deferredAttachmentWork ? { owed: 'post-merge', releaseCheck: 'v1.3.5/deferred-attachment-pass' } : {}),
            });
            return false;
          }


          const contentCheckEnabled = backend === 'file'
            || backend === 'webdav'
            || backend === 'cloudkit'
            || backend === 'cloud';
          if (phase === 'prepare') {
            const prepareCheckStartedAt = Date.now();
            const hasAttachmentWork = await host.attachments.hasPendingWork(data, { contentCheckEnabled });
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
          const hasAttachmentWork = await host.attachments.hasPendingWork(data, { contentCheckEnabled });
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
        cleanupAttachmentTempFiles: () => host.attachments.cleanupTempFiles(),
        runAttachmentCleanup: async (data, context) => {
          context.setStep('attachments_cleanup');
          context.ensureLocalSnapshotFresh();
          await context.ensureNetworkStillAvailable();
          const cleanupResult = await host.attachments.runCleanup({
            appData: data,
            backend: this.backend,
            webdavConfig: this.webdavConfig,
            cloudConfig: this.cloudConfig,
            cloudProvider: this.cloudProvider,
            fetcher: this.fetchWithAbort,
            ensureLocalSnapshotFresh: () => context.ensureLocalSnapshotFresh(),
            assertRemoteMutationFenceHeld: context.assertRemoteMutationFenceHeld,
            deleteDropboxAttachment: (cloudKey, ensureBeforeProviderDelete) =>
              this.runDropboxOperation(async (accessToken) => {
                const { rev } = await core.getDropboxFileMetadata(
                  accessToken,
                  cloudKey,
                  this.fetchWithAbort,
                  { signal: this.requestAbortController.signal },
                );
                if (!rev) throw new DropboxFileNotFoundError('Dropbox file not found');


                ensureBeforeProviderDelete();
                await context.assertRemoteMutationFenceHeld(35_000);
                return core.deleteDropboxFileVersioned(
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
        formatErrorMessage: (error, backend) => redactFailure(formatSyncErrorMessage(error, backend)),
        handleRunErrorBeforeRequeue: async (_error, context) => {
          if (this.requestAbortController.signal.aborted && activeMobileSyncAbortReason === 'deadline') {
            logSyncInfo('Sync aborted at the background run\'s deadline', { backend: this.backend, step: context.step });


            mobileSyncOrchestrator.clearFollowUp();
            return { success: false, error: 'The background sync deadline passed' };
          }
          if (this.requestAbortController.signal.aborted && activeMobileSyncAbortReason === 'lifecycle') {
            logSyncInfo('Sync aborted by app lifecycle transition', { backend: this.backend, step: context.step });
            logSyncDiagnostic('Sync diagnostic lifecycle abort', this.syncDiagnosticStartedAt, {
              backend: this.backend,
              step: context.step,
              success: 'true',
              aborted: 'lifecycle',
            });
            this.queueFollowUp();
            logFollowUpDecision('lifecycle', this.backend, context.step,
              { manual: this.manual, activationProbe: this.activationProbe });
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
              await core.useTaskStore.getState().fetchData({ silent: true });
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
            await core.useTaskStore.getState().fetchData({ silent: true });
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


          const refreshStartedAt = Date.now();


          const published = this.lastPreparedPublish;
          const storeShowsPublish = () => published !== null && published.data === mergedData
            && !lastStoreLoadWasRecovery() && !core.useTaskStore.getState().isLoading
            && sameStoreData(storeDataOf(core.useTaskStore.getState()), published.storeData);
          let refreshCovered = false;
          if (!info.localWriteSkipped && host.sliceYield && storeShowsPublish()) {
            const shown = core.useTaskStore.getState();
            refreshCovered = await runSliced('sync:refreshCheck',
              loadLeavesStorePass(mergedData, { tasks: shown._allTasks, projects: shown._allProjects }),
              createSlicer(() => host.sliceYield!())) && storeShowsPublish();
          }
          if (refreshCovered) {

            core.useTaskStore.setState((state) => (state.error === null ? state : { error: null }));
          } else if (!info.localWriteSkipped) {
            await traceSectionAsync('sync:storeApply', () => core.useTaskStore.getState().fetchData({ silent: true, preloadedData: mergedData }));
          }
          if (!info.localWriteSkipped) {


            await applyLocalSyncStatus({
              lastSyncAt: mergedData.settings.lastSyncAt,
              lastSyncStatus: mergedData.settings.lastSyncStatus,
              lastSyncError: mergedData.settings.lastSyncError,
              lastSyncStats: mergedData.settings.lastSyncStats,
              lastSyncHistory: mergedData.settings.lastSyncHistory,
            });
          }
          void log.info('Sync status published to the store', {
            scope: 'sync',
            extra: {
              releaseCheck: 'v1.2.7/sync-status-published',
              backend: this.backend,
              statusPublished: info.localWriteSkipped ? 'unchanged' : 'wrote-local',
              ...(refreshCovered ? { storeRefresh: 'dropped' } : {}),
              lastSyncAt: String(mergedData.settings.lastSyncAt ?? 'none'),
              lastSyncStatus: String(mergedData.settings.lastSyncStatus ?? 'none'),
            },
          });
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


    private createBackendContext(): SyncBackendContext {
      return {
        backend: this.backend,
        cloudProvider: this.cloudProvider,
        webdav: this.webdavConfig ? { url: this.webdavConfig.url } : null,
        cloud: this.cloudConfig ? { url: this.cloudConfig.url } : null,
        filePath: this.fileSyncPath ?? '',
        dropboxAppKey: this.dropboxClientId,
        dropboxRev: this.dropboxLastRev,
        allowLegacyWebdavPlaintext: this.allowLegacyWebdavPlaintext,
        syncEncryptionOff: this.syncEncryptionOff,
      };
    }


    private createBackendTransport(ctx: SyncBackendContext): SyncTransport {
      return {


        acquireWebdavRemoteMutationFence: async () => {
          const webdavConfig = this.webdavConfig;
          if (!webdavConfig?.url) throw new Error('WebDAV URL not configured');
          this.ensureWebdavSyncNotRateLimited();


          void log.info('WebDAV sync fence artifact resolved', {
            scope: 'sync',
            extra: {
              releaseCheck: 'v1.2.7/fence-artifact',
              artifact: webdavMutationFenceUrl(webdavConfig.url).split('/').pop() ?? 'none',
            },
          });
          try {
            return await core.acquireSyncRemoteMutationFence(
              core.createWebdavSyncRemoteMutationFencePort(webdavConfig.url, {
                ...getMobileWebDavRequestOptions(webdavConfig.allowInsecureHttp),
                username: webdavConfig.username,
                password: webdavConfig.password,
                timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
                fetcher: host.fetch,
              }),
              { ownerId: 'mindwtr-mobile', purpose: 'ordinary-sync' },
            );
          } catch (error) {
            if (!isSyncEncryptionError(error)) this.handleWebdavRateLimit(error);
            throw error;
          }
        },
        acquireDropboxRemoteMutationFence: (token) => core.acquireSyncRemoteMutationFence(
          core.createDropboxSyncRemoteMutationFencePort(token, host.fetch, {
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


            return await core.withRetry(
              () => core.webdavGetSyncDocument<AppData>(webdavConfig.url, {
                ...requestOptions,
                material: this.encryptionMaterial ?? undefined,
                cryptoPrims: host.crypto,
              }),
              WEBDAV_READ_RETRY_OPTIONS
            );
          } catch (error) {


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
            return await core.withRetry(
              async () => {
                await assertRemoteMutationFenceHeld?.(SYNC_REMOTE_MUTATION_REQUEST_HORIZON_MS);
                return core.webdavPutSyncDocument(webdavConfig.url, sanitized, {
                  ...requestOptions,
                  material: material ?? undefined,
                  cryptoPrims: host.crypto,
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
        webdavPutLegacyPlaintext: async (sanitized, assertRemoteMutationFenceHeld) => {
          const webdavConfig = this.webdavConfig;
          if (!webdavConfig?.url) throw new Error('WebDAV URL not configured');


          if (!ctx.allowLegacyWebdavPlaintext || this.encryptionMaterial) {
            throw new SyncEncryptionRemoteVersionUnavailableError('Encrypted WebDAV sync document');
          }
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
            await assertRemoteMutationFenceHeld?.(SYNC_REMOTE_MUTATION_REQUEST_HORIZON_MS);


            return await core.webdavPutSyncDocument(webdavConfig.url, sanitized, {
              ...requestOptions,
              legacyUnconditionalPlaintext: true,
            });
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
            const metadata = await core.withRetry(
              () =>
                core.webdavHeadFile(headUrl, {
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
          return core.cloudGetJson<AppData>(cloudConfig.url, {
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
          return core.cloudPutJson(cloudConfig.url, sanitized, {
            ...getMobileCloudRequestOptions(cloudConfig.allowInsecureHttp),
            token: cloudConfig.token,
            timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
            fetcher: this.fetchWithAbort,
            signal: this.requestAbortController.signal,
          });
        },
        cloudHead: async () => {
          const cloudConfig = this.cloudConfig!;
          return core.cloudHeadJson(cloudConfig.url, {
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
          await this.assertFileSyncLeaseHeld();


          try {
            const result = await host.fileSync.readVersioned(fileSyncPath, {
              bookmark: this.fileSyncBookmark,
              locationScope: this.locationScope,
              ...(this.encryptionMaterial ? { material: this.encryptionMaterial } : {}),
            });
            await this.assertFileSyncLeaseHeld();
            return result;
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
          await this.assertFileSyncLeaseHeld();
          try {
            await host.fileSync.write(fileSyncPath, sanitized, {
              bookmark: this.fileSyncBookmark,
              expectedFingerprint,
              ...(this.encryptionMaterial ? { material: this.encryptionMaterial } : {}),
            });
            await this.assertFileSyncLeaseHeld();
          } catch (error) {
            if (error instanceof SyncEncryptionRemoteConflictError) {
              throw new SyncRemoteWriteConflict();
            }
            throw error;
          }
        },
        cloudKitRead: async () => cloudKit.read({ signal: this.requestAbortController.signal }),
        cloudKitWrite: async (sanitized) => {
          await cloudKit.write(sanitized, { signal: this.requestAbortController.signal });
        },
        resolveDropboxToken: (forceRefresh) => this.runDropboxTransientRetry(
          () => this.resolveDropboxAccessToken(forceRefresh),
        ),
        dropboxDownload: async (token) => {
          const material = this.encryptionMaterial;
          const result = await this.runDropboxTransientRetry(
            () => core.downloadDropboxAppData(
              token,
              this.fetchWithAbort,
              material ? { material, cryptoPrims: host.crypto } : {},
              { signal: this.requestAbortController.signal },
            )
          );
          if (result.encryptedNoKey) {
            this.logRemoteRead({
              artifact: syncEncryptedArtifactName(SYNC_FILE_NAME),
              exists: true,
              kind: 'encrypted',
              headerSalt: result.encryptedNoKey.salt,
              headerKdf: result.encryptedNoKey.params,
              version: 'n/a',
              foreignSalt: material !== null,
              decision: 'no-key',
            });
            markRemoteEncryptionDiscovered(host.encryption.syncEncryptionLocalState, result.encryptedNoKey, this.locationScope);
            await host.encryption.flushSyncEncryptionLocalState();
            this.markCandidateEncryptedRemoteProven();
            throw new SyncEncryptionNoKeyError();
          }
          if (result.remotePlaintext) {
            this.logRemoteRead({
              artifact: SYNC_FILE_NAME,
              exists: true,
              kind: 'plaintext',
              version: 'n/a',
              decision: 'plaintext-discovered',
            });
            markRemotePlaintextDiscovered(host.encryption.syncEncryptionLocalState, this.locationScope);
            await host.encryption.flushSyncEncryptionLocalState();
            throw new SyncEncryptionRemotePlaintextError();
          }
          this.logRemoteRead({
            artifact: material ? syncEncryptedArtifactName(SYNC_FILE_NAME) : SYNC_FILE_NAME,
            exists: result.data != null,
            kind: result.data == null ? 'absent' : material ? 'encrypted' : 'plaintext',
            headerSalt: material?.salt,
            headerKdf: material?.params,
            version: result.rev ? 'strong' : 'none',
            foreignSalt: false,
            decision: result.data == null ? 'absent' : material ? 'decrypt' : 'plaintext',
          });
          await this.persistDropboxRev(result.rev);
          return result;
        },
        dropboxUpload: async (token, sanitized, expectedRev, assertRemoteMutationFenceHeld) => {
          const material = this.encryptionMaterial;
          const result = await this.runDropboxTransientRetry(
            async () => {
              await assertRemoteMutationFenceHeld?.(SYNC_REMOTE_MUTATION_REQUEST_HORIZON_MS);
              return core.uploadDropboxAppData(
                token,
                sanitized,
                expectedRev,
                this.fetchWithAbort,
                material ? { material, cryptoPrims: host.crypto } : {},
                { signal: this.requestAbortController.signal },
              );
            }
          );
          await this.persistDropboxRev(result.rev);
          return result;
        },
        dropboxMetadata: (token) => this.runDropboxTransientRetry(() => core.getDropboxAppDataMetadata(
          token,
          this.fetchWithAbort,
          {},
          { signal: this.requestAbortController.signal },
        )),


        syncWebdavAttachments: async (data, helpers) => {
          await this.assertLocationNotPartlyEncrypted();
          const webdavConfig = this.webdavConfig!;
          return host.attachments.syncWebdav(data, webdavConfig, this.requestAbortController.signal, {
            activationProbe: helpers.activationProbe,
            activationContinuation: helpers.activationContinuation,
            phase: helpers.phase,
            assertRemoteMutationFenceHeld: helpers.assertRemoteMutationFenceHeld,
            onTransferBatchDeferred: helpers.onTransferBatchDeferred,
            transferAdmission: helpers.transferAdmission,
            ...(this.encryptionMaterial ? { material: this.encryptionMaterial } : {}),
          });
        },
        syncCloudKitAttachments: async (data, helpers) => cloudKit.syncAttachments(
          data,
          this.requestAbortController.signal,
          { activationProbe: helpers.activationProbe, phase: helpers.phase }
        ),
        syncCloudAttachments: async (data, helpers) => {
          const cloudConfig = this.cloudConfig!;
          return host.attachments.syncCloud(data, cloudConfig, {
            activationProbe: helpers.activationProbe,
            assertCurrent: () => helpers.ensureLocalSnapshotFresh(),
            assertRemoteMutationFenceHeld: helpers.assertRemoteMutationFenceHeld,
            phase: helpers.phase,
            signal: this.requestAbortController.signal,
            transferAdmission: helpers.transferAdmission,
          });
        },
        syncDropboxAttachments: async (data, helpers) => {
          await this.assertLocationNotPartlyEncrypted();
          return host.attachments.syncDropbox(data, this.dropboxClientId, this.fetchWithAbort, {
            activationProbe: helpers.activationProbe,
            phase: helpers.phase,
            resolveAccessToken: (forceRefresh) => this.resolveDropboxAccessToken(forceRefresh),
            signal: this.requestAbortController.signal,
            assertRemoteMutationFenceHeld: helpers.assertRemoteMutationFenceHeld,
            transferAdmission: helpers.transferAdmission,
            ...(this.encryptionMaterial ? { material: this.encryptionMaterial } : {}),
          });
        },
        syncFileAttachments: async (data, helpers) => {
          await this.assertFileSyncLeaseHeld();
          const result = await host.attachments.syncFile(
            data,
            this.fileSyncPath!,
            this.requestAbortController.signal,
            {
              activationProbe: helpers.activationProbe,
              phase: helpers.phase,
              transferAdmission: helpers.transferAdmission,
              ...(this.encryptionMaterial ? { material: this.encryptionMaterial } : {}),
            },
          );
          await this.assertFileSyncLeaseHeld();
          return result;
        },
      };
    }


    private createBackendIO(): SyncBackendIO {
      const ctx = this.createBackendContext();


      const encryptionPosture: SyncEncryptionPosture = {
        material: this.encryptionMaterial,
        logRemoteRead: (input) => this.logRemoteRead(input),
        onRemoteEncryptionVerified: async (material) => {
          const restored = await restoreVerifiedRemoteEncryption(host.encryption.syncEncryptionLocalState, material, this.locationScope);
          await host.encryption.flushSyncEncryptionLocalState();
          if (restored) {
            void log.info('Verified encrypted remote cleared stale plaintext state', {
              scope: 'sync',
              extra: { releaseCheck: 'v1.3.3/encrypted-remote-recovery' },
            });
          }
        },


        onRemotePlaintextDiscovered: async () => {
          markRemotePlaintextDiscovered(host.encryption.syncEncryptionLocalState, this.locationScope);
          await host.encryption.flushSyncEncryptionLocalState();
        },
        onRemoteEncryptionDiscovered: async (discovered) => {
          markRemoteEncryptionDiscovered(host.encryption.syncEncryptionLocalState, discovered, this.locationScope);
          await host.encryption.flushSyncEncryptionLocalState();
          this.markCandidateEncryptedRemoteProven();
        },
        noKeyError: () => new SyncEncryptionNoKeyError(),
        onWeakEtagPlaintextRead: (etag) => {


          void log.info('WebDAV read returned no strong ETag; using the plaintext compatibility write', {
            scope: 'sync',
            extra: { etag: String(etag ?? 'none') },
          });
        },
      };
      const io = createSyncBackendIO(ctx, this.createBackendTransport(ctx), encryptionPosture);
      return {
        ...io,


        getSyncUrl: () => ctx.syncUrl ?? this.syncUrl,
      };
    }

    private async releaseResources(): Promise<boolean> {
      let fileSyncLockCleanupDeferred = false;
      if (this.fileSyncLease) {
        const lease = this.fileSyncLease;
        this.fileSyncLease = null;
        if (!fatalCleanupError) {
          try {
            await host.fileSync.releaseLease(lease);
          } catch (error) {
            fileSyncLockCleanupDeferred = true;
            logSyncWarning('Failed to release File Sync lease', error);
          }
        }
      }
      if (activeMobileSyncAbortController === this.requestAbortController) {
        activeMobileSyncAbortController = null;
        activeMobileSyncAbortReason = null;
      }
      try {
        this.networkSubscription?.remove?.();
      } catch (error) {
        if (!fatalCleanupError) logSyncWarning('Failed to unsubscribe network listener after sync', error);
      }
      return fileSyncLockCleanupDeferred;
    }
  }


  let quietMeasuredFrom: number | null = null;
  const quietWaitMs = () => {
    if (!host.sliceYield) return 0;
    const lastEditAt = core.useTaskStore.getState().lastDataChangeAt;
    if (lastEditAt === quietMeasuredFrom) return 0;
    quietMeasuredFrom = lastEditAt;
    return Math.min(FOLLOW_UP_QUIET_MS, Math.max(0, FOLLOW_UP_QUIET_MS - (Date.now() - lastEditAt)));
  };
  const mobileSyncOrchestrator = createSyncOrchestrator<MobileSyncRequest | undefined, MobileSyncResult>({
    getFollowUpWaitMs: quietWaitMs,
    getFollowUpDelayMs: (lastCycleDurationMs, minimumDelayMs) => {
      const pacedDelayMs = Math.min(Math.max(lastCycleDurationMs, MIN_FOLLOW_UP_DELAY_MS), MAX_FOLLOW_UP_DELAY_MS);


      const delayMs = Math.max(pacedDelayMs, minimumDelayMs, quietWaitMs());
      logSyncInfo('Sync follow-up scheduled', {
        delayMs: String(delayMs),
        lastCycleDurationMs: String(lastCycleDurationMs),
        minimumDelayMs: String(minimumDelayMs),
      });
      return delayMs;
    },
    runCycle: async (request, { requestFollowUp, requestFollowUpAfter }) => {
      if (fatalCleanupError) throw fatalCleanupError;
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
      const changeAtStart = core.useTaskStore.getState().lastDataChangeAt;
      try {
        return await runSerializedSyncDocumentOperation(() => syncRun.run());
      } finally {


        if (!fatalCleanupError && mobileSyncOrchestrator.getState().queued && mobileSyncActivityState === 'syncing'
          && core.useTaskStore.getState().lastDataChangeAt === changeAtStart) {
          setMobileSyncActivityState('idle');
          if (!followUpIdleLogged) void Promise.resolve(log.info('Sync activity idle while a follow-up waits', {
            scope: 'sync', force: true, extra: { releaseCheck: 'v1.3.8/follow-up-idle-badge', backend },
          })).catch(() => {});
          followUpIdleLogged = true;
        }
      }
    },
    onQueuedRunComplete: (queuedResult) => {
      if (!queuedResult.success) {
        logSyncWarning('[Mobile] Queued sync failed', queuedResult.error);
      }
    },
    onQueuedRunError: (error) => {
      if (error instanceof NativeAttachmentCleanupUnconfirmedError) return;
      logSyncWarning('[Mobile] Queued sync crashed', error);
    },
    onDrained: () => {
      if (!fatalCleanupError) setMobileSyncActivityState('idle');
      notifyMobileSyncDrainListeners();
    },
  });


  async function performMobileSync(
    syncPathOverride?: string,
    options?: {
      manual?: boolean;
      activationProbe?: boolean;
      acceptMissingAttachmentIds?: readonly string[];
      ignorePendingRemoteWriteBackoff?: boolean;
      configOverride?: MobileSyncConfigOverride;
    }
  ): Promise<MobileSyncResult> {
    if (fatalCleanupError) throw fatalCleanupError;
    if (core.isSandboxMode() || core.isWorkspaceTransitionActive()) {
      return { success: true, skipped: 'disabled' };
    }
    const wasInFlight = mobileSyncOrchestrator.getState().inFlight;
    if (wasInFlight) {
      logFollowUpDecision('busy-request', activeFollowUpContext?.backend ?? 'unknown',
        activeFollowUpContext?.step ?? 'setup', options ?? {}, !allowQueuedFollowUp || options?.activationProbe === true);
    }
    if (wasInFlight && (!allowQueuedFollowUp || options?.activationProbe)) {


      return { success: true, skipped: 'requeued' };
    }
    const result = mobileSyncOrchestrator.run({
      syncPathOverride,
      manual: options?.manual,
      activationProbe: options?.activationProbe,
      acceptMissingAttachmentIds: options?.acceptMissingAttachmentIds,
      ignorePendingRemoteWriteBackoff: options?.ignorePendingRemoteWriteBackoff,
      configOverride: options?.configOverride,
    });
    if (wasInFlight && options?.configOverride) {


      void result.catch((error) => {
        if (!(error instanceof NativeAttachmentCleanupUnconfirmedError)) {
          logSyncWarning('Active sync failed while a settings proof was queued', error);
        }
      });
      return { success: true, skipped: 'requeued' };
    }
    return result;
  }


  function abortMobileSync(reason: 'lifecycle' | 'deadline' = 'lifecycle'): boolean {
    if (!activeMobileSyncAbortController) return false;

    if (activeMobileSyncAbortReason !== 'deadline') activeMobileSyncAbortReason = reason;
    activeMobileSyncAbortController.abort();
    return true;
  }

  const __mobileSyncTestUtils = {
    reset() {
      mobileSyncOrchestrator.reset();


      clearIdleSyncCycleSnapshot();
      clearMobileSyncConfigCache();
      mobileSyncActivityListeners.clear();
      mobileSyncDrainListeners.clear();
      mobileSyncActivityState = 'idle';
      webdavSyncRateLimitController.reset();
      activeMobileSyncAbortController = null;
      activeMobileSyncAbortReason = null;
      fatalCleanupError = null;
      followUpReceipts.clear();
      followUpIdleLogged = false;
      previousCycleRequestedContribution = false;
      contributionComparisonCaptured = false;
      activeFollowUpContext = null;
    },
    getWebdavSyncBlockedUntil() {
      return webdavSyncRateLimitController.getBlockedUntil();
    },
    queueFollowUpForTests() {
      mobileSyncOrchestrator.requestFollowUp(undefined);
    },
    clearFollowUpForTests() {
      mobileSyncOrchestrator.clearFollowUp();
      notifyMobileSyncDrainListeners();
    },
  };

  return {
    performMobileSync,
    getMobileSyncConfigurationStatus,
    getMobileSelectedSyncBackend,
    getMobileSyncActivityState,
    subscribeMobileSyncActivityState,
    waitForMobileSyncIdle,
    clearMobileSyncConfigCache,
    abortMobileSync,
    __mobileSyncTestUtils,
  };
};

export type MobileSyncService<Lease = unknown> = ReturnType<typeof createMobileSyncService<Lease>>;
