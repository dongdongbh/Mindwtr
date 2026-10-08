// The mobile sync service: one sync cycle per backend (WebDAV, self-hosted cloud, Dropbox as
// `cloud` with provider `dropbox`, File Sync and CloudKit) wired onto the shared cycle machine
// (`runSharedSyncCycle`, ADR 0014), plus the queue, the offline checks, the sync-config cache
// and the visible sync activity. It moved here from React Native's `apps/mobile/lib/sync-service.ts`
// so the native apps run the same policy; each host binds it to its own storage, network,
// log, File Sync folder, attachment passes and CloudKit through `MobileSyncServiceHost`.
//
// Data safety: the fence owner stays `mindwtr-mobile`, the sync keys and the sync file format
// are unchanged, and a candidate configuration is only ever proven here (`activationProbe`),
// never saved — the settings transaction saves it after the proof succeeds.
import type { AppData, Attachment } from './types';
import { SYNC_ENCRYPTION_LOG_EVENTS, buildSyncEncryptionActivationExtra, buildSyncEncryptionErrorExtra, buildSyncEncryptionRemoteReadExtra, buildSyncEncryptionStateExtra, type SyncEncryptionStateDecision } from './sync-encryption-diagnostics';
import { buildSyncLocationScope, isSyncEncryptionPartlyEncryptedError, markRemoteEncryptionDiscovered, SyncEncryptionPartlyEncryptedError, markRemotePlaintextDiscovered, restoreVerifiedRemoteEncryption, syncEncryptedArtifactName, SyncEncryptionRemoteConflictError, SyncEncryptionRemotePlaintextError, SyncEncryptionRemoteVersionUnavailableError, SyncEncryptionTerminalError, SyncEncryptionTransitionIncompleteError, type SyncEncryptionState } from './sync-encryption';
import { SyncEncryptionNoKeyError, SyncEncryptionStateUnavailableError, type SyncEncryptionStateStore } from './sync-encryption-local-state';
import type { SyncCryptoPrimitives, SyncKeyMaterial } from './sync-crypto';
import { acquireSyncRemoteMutationFence, SYNC_REMOTE_MUTATION_REQUEST_HORIZON_MS } from './sync-remote-fence';
import { createDropboxSyncRemoteMutationFencePort, createWebdavSyncRemoteMutationFencePort, webdavMutationFenceUrl } from './sync-remote-fence-providers';
import { clearIdleSyncCycleSnapshot, runSharedSyncCycle } from './sync-run';
import { SyncRemoteWriteConflict, type SyncEncryptionPosture, type SyncRunDiagnosticEvent, type SyncRunNotifier, type SyncRunPlatformHooks, type SyncRunResult, type SyncRunStorage } from './sync-run-ports';
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
import { CLOUD_PROVIDER_DROPBOX, CLOUD_PROVIDER_SELF_HOSTED, createAbortableFetch, getInMemoryAppDataSnapshot, normalizeCloudProvider as normalizeCoreCloudProvider, type CloudProvider } from './sync-client-helpers';
import { buildSyncPayloadTraceExtra, isSyncPayloadTraceEnabled, SYNC_TRACE_EVENT_MESSAGES } from './sync-payload-trace';
import { isLikelyOfflineSyncError, isRemoteSyncBackend, SYNC_FILE_NAME, SyncFileLockUnavailableError, type SyncBackend } from './sync-service-utils';
import { summarizeTaskLifecycleCounts } from './task-utils';
import { decodeUriSafe } from './async-utils';
import { flushPendingSave, useTaskStore } from './store';
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

/** Encryption-class failures must never be mistaken for transport failures (they must
 *  not feed the WebDAV rate limiter) nor for generic permission errors in the toast
 *  mapping — see classifySyncFailure in mobile-sync-utils.ts. */
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
// A stored config value with a control character is corrupt; it reads as unset.
// eslint-disable-next-line no-control-regex
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
  fileSyncLockBusyRetryAttempt?: number;
  ignorePendingRemoteWriteBackoff?: boolean;
  configOverride?: MobileSyncConfigOverride;
};

type MobileRequestFollowUp = (nextArg?: MobileSyncRequest) => void;
type MobileRequestFollowUpAfter = (delayMs: number, nextArg?: MobileSyncRequest) => void;

// A follow-up cycle (requeued after mid-cycle edits or a lifecycle abort) waits at
// least as long as the finished cycle took, so the app never spends more than half
// its time syncing. The cap bounds staleness; the old one-minute cap defeated the
// half-duty rule exactly on the whale libraries that need it most — an 80s cycle
// got a 60s gap, keeping a 7k-task device near-continuously mid-sync (#766).
const MIN_FOLLOW_UP_DELAY_MS = 1_000;
const MAX_FOLLOW_UP_DELAY_MS = 5 * 60_000;

/** Raw network state as the host reads it (React Native: expo-network). */
export type MobileSyncNetworkState = {
  isConnected?: boolean | null;
  isInternetReachable?: boolean | null;
  isAirplaneModeEnabled?: unknown;
};

/** The device's network state, and a listener for changes during a cycle. */
export type MobileSyncNetworkPort = {
  getState(): Promise<MobileSyncNetworkState>;
  subscribe(listener: (state: MobileSyncNetworkState) => void): { remove?: () => void };
};

export type MobileSyncLogContext = { scope?: string; extra?: Record<string, string>; force?: boolean };

/** The host's app log (React Native: `app-log.ts`). */
export type MobileSyncLogPort = {
  info(message: string, context?: MobileSyncLogContext): unknown;
  warn(message: string, context?: MobileSyncLogContext): unknown;
  /** Writes a structured sync error; the returned path becomes the "(log: …)" hint. */
  syncError(error: unknown, context: { backend: string; step: string; url?: string }): Promise<string | null | undefined>;
  /** Redacts credentials and paths before a message enters a log extra. */
  sanitize(message: string): string;
};

export type MobileSyncFileAccessOptions = {
  bookmark?: string | null;
  locationScope?: string | null;
  expectedFingerprint?: string;
  material?: SyncKeyMaterial | null;
};

/** File Sync's folder IO and lock. Stays in the host until pass S5 moves it. */
export type MobileSyncFileSyncPort<Lease> = {
  readVersioned(path: string, options: MobileSyncFileAccessOptions): Promise<FileSyncReadResult>;
  write(path: string, data: AppData, options: MobileSyncFileAccessOptions): Promise<void>;
  /** Resolves an Android SAF folder or document URI to the sync document's URI. */
  resolveUri(uri: string, options: { createIfMissing: boolean }): Promise<string>;
  /** iOS security-scoped bookmarks; a host without them returns false and null. */
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

/** The host's attachment passes, one per backend. They stay in the host until the
 *  attachment passes (A1a, A1b) move them. */
export type MobileSyncAttachmentsPort = {
  syncWebdav(data: AppData, config: MobileWebDavSyncConfig, signal: AbortSignal, options: {
    activationProbe: boolean;
    activationContinuation?: boolean;
    phase?: 'prepare' | 'post-merge';
    assertRemoteMutationFenceHeld?: (minRemainingMs?: number) => Promise<void>;
    onTransferBatchDeferred?: () => void;
    material?: SyncKeyMaterial;
  }): AttachmentPassResult;
  syncCloud(data: AppData, config: MobileCloudSyncConfig, options: {
    activationProbe: boolean;
    assertCurrent: () => void;
    assertRemoteMutationFenceHeld?: (minRemainingMs?: number) => Promise<void>;
    phase?: 'prepare' | 'post-merge';
    signal: AbortSignal;
  }): AttachmentPassResult;
  syncDropbox(data: AppData, clientId: string, fetcher: typeof fetch, options: {
    activationProbe: boolean;
    phase?: 'prepare' | 'post-merge';
    resolveAccessToken: (forceRefresh: boolean) => Promise<string>;
    signal: AbortSignal;
    assertRemoteMutationFenceHeld?: (minRemainingMs?: number) => Promise<void>;
    material?: SyncKeyMaterial;
  }): AttachmentPassResult;
  syncFile(data: AppData, syncPath: string, signal: AbortSignal, options: {
    activationProbe: boolean;
    phase?: 'prepare' | 'post-merge';
    material?: SyncKeyMaterial;
  }): AttachmentPassResult;
  cleanupTempFiles(): Promise<void>;
  /** #1119: a completed attachment pass is recorded for the stored sync location. */
  hasCompletedPresenceReconciliation(): Promise<boolean>;
  hasPendingWork(data: AppData, options: { contentCheckEnabled?: boolean }): Promise<boolean>;
  runCleanup(options: MobileSyncAttachmentCleanupOptions): Promise<{ appData: AppData; shouldInvalidateFastSyncState: boolean }>;
};

/** iCloud (iOS only). A host without it never offers the `cloudkit` backend. */
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

/** Dropbox credentials (core's `createDropboxTokenStore` behind the host's storage). */
export type MobileSyncDropboxAuthPort = {
  isConnected(): Promise<boolean>;
  getValidAccessToken(clientId: string, fetcher: typeof fetch): Promise<string>;
  forceRefreshAccessToken(clientId: string, fetcher: typeof fetch): Promise<string>;
  getValidAccessTokenForTokens(clientId: string, tokens: DropboxAuthTokens, fetcher: typeof fetch): Promise<DropboxAccessTokenResolution>;
  forceRefreshAccessTokenForTokens(clientId: string, tokens: DropboxAuthTokens, fetcher: typeof fetch): Promise<DropboxAccessTokenResolution>;
};

/** The encryption state store members a cycle reads (core's `createSyncEncryptionStateStore`). */
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
  /** Whether the location holds ciphertext beside plaintext (core's encryption service probeSyncLocationCiphertext,
   *  sampled). Asked before a WebDAV or Dropbox attachment pass with no key; absent on a host without the service. */
  /** [target] names the cycle's own WebDAV folder (an activation's candidate is not the stored one); none reads the stored. */
  probeLocationCiphertext?: (target?: { webdav?: MobileWebDavSyncConfig }) => Promise<'plaintext' | 'encrypted' | 'mixed'>;
};

/** Core functions and the store, called through here so a host's tests can replace them the
 *  way they replace `@mindwtr/core`. A host that passes nothing gets core's own. */
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
  /** Defaults to true. False leaves any later cycle to a fresh caller-owned invocation. */
  allowQueuedFollowUp?: boolean;
  /** The device key-value store (React Native: AsyncStorage). */
  storage: SyncKeyValueStoragePort;
  /** Reads a secret sync key (`isSecretConfigKey`) from the keystore. */
  getSecureConfigValue(key: string): Promise<string | null>;
  platform: {
    /** 'ios', 'android' or 'web'; read on every use. */
    os(): string;
    /** FOSS builds never sync with Dropbox. */
    isFossBuild: boolean;
    /** The build's Dropbox app key, or '' when none is configured. */
    dropboxAppKey(): string;
  };
  network: MobileSyncNetworkPort;
  /** The local snapshot on disk (React Native: the SQLite storage adapter). */
  localData: {
    getData(): Promise<AppData>;
    saveData(data: AppData): Promise<AppData | void>;
  };
  log: MobileSyncLogPort;
  externalCalendars: {
    load(): Promise<AppData['settings']['externalCalendars']>;
    save(calendars: NonNullable<AppData['settings']['externalCalendars']>): Promise<void>;
  };
  /** The fetch every sync request uses; the service adds the cycle's abort signal. */
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
  const allowQueuedFollowUp = host.allowQueuedFollowUp !== false;
  // Only a new host/service after native journal recovery may resume sync.
  let fatalCleanupError: NativeAttachmentCleanupUnconfirmedError | null = null;
  const core: MobileSyncCoreFunctions = { ...CORE_FUNCTIONS, ...host.core };
  const cloudKit = host.cloudKit ?? CLOUDKIT_UNAVAILABLE;
  const syncConfigCache = new Map<string, { value: string | null; readAt: number }>();
  const dropboxSyncEnabled = !host.platform.isFossBuild;

  // The WebDAV password and self-hosted token each cycle signed in with. A server can echo one in an error, so every sync
  // text this service logs, returns or stores as status redacts them (redactSyncText), on top of the host's sanitizer.
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
  // A secret can be the very word a failure is classified by (a password "403"): classify the raw text, and when the
  // redacted text no longer reads as that kind, name the kind in words classifySyncFailure reads the same way.
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
  /** A cycle's data as it is stored or shown: its error line and history's errors redacted. */
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
  // 'deadline': the background run gave up at its own deadline; its job retries, so nothing is queued after it.
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
      // CloudKit is always "configured" if the module is available — no user credentials needed.
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
    /** Sync encryption is exactly off for this cycle (state 'off', no incomplete
     *  transition). Gates every "no safe backend version" refusal — those protect
     *  encrypted CAS, and a plaintext cycle degrades instead of failing. */
    private syncEncryptionOff = false;
    /** #1056: resolved once per cycle in setupCycle. `null` is the encryption-off path and
     *  every seam below then behaves byte-for-byte as it did before the feature. */
    private encryptionMaterial: SyncKeyMaterial | null = null;
    /** #1138: which sync location this cycle runs against. Every encryption discovery this
     *  cycle persists is stamped with it, and the pre-read block compares against it, so a
     *  lock set for one backend/folder cannot refuse a sync against another. `null` means the
     *  configuration could not be read, which the block rule treats as doubt. */
    private locationScope: string | null = null;
    /** #1138 / fresh-join-attachment-posture packet -10: this cycle does not yet know the active
     *  location's encryption posture — a stale/mismatched discovery, or no persisted encryption
     *  state at all — so it is running blind like a fresh join. Nothing may be uploaded in the
     *  attachment prepare phase until the document read has established what is actually at this
     *  location. See `isSyncEncryptionPostureUnestablished`. */
    private deferUploadsUntilDiscovery = false;
    /** This cycle's prepare phase was deferred while attachment work was pending (SyncRun's
     *  `hasDeferredAttachmentWork`): the post-merge pass must run even on an unchanged document. */
    private deferredAttachmentWork = false;
    /** What the location held when this cycle asked (assertLocationNotPartlyEncrypted); asked once. */
    private locationCiphertext: 'plaintext' | 'encrypted' | 'mixed' | null = null;
    /** Encryption state as the gate saw it, kept for the `activation` diagnostic line so a
     *  probe reports what the cycle changed rather than only where it ended. */
    private encryptionStateAtSetup: SyncEncryptionState | 'unknown' = 'unknown';

    /** #1138: the location identity this cycle syncs against. Built from the cycle's OWN
     *  resolved configuration rather than from AsyncStorage, for two reasons: an activation
     *  probe runs on a candidate config that AsyncStorage does not hold yet (57f8e2420 depends
     *  on the discovery a failing probe stamps surviving the commit), and the file backend's
     *  configured path is rewritten by bookmark/URI resolution — stamping the pre-resolution
     *  value would make the same folder look like a different location next cycle. Every
     *  `resolve*BackendConfig` above already honours `configOverride`, so this reads whatever
     *  the cycle is actually about to touch. */
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
            getLastDataChangeAt: () => core.useTaskStore.getState().lastDataChangeAt,
            getInMemorySnapshot: () => core.getInMemoryAppDataSnapshot(),
            flushPendingSave: () => core.flushPendingSave(),
            setUiError: (message) => core.useTaskStore.getState().setError(message),
            getSettings: () => core.useTaskStore.getState().settings,
          },
          hooks: this.createHooks(),
          policy: {
            preSyncAttachmentsBeforeFastCheck: true,
            // Battery: back-to-back idle cycles are the common case on a phone,
            // and each one otherwise clones the library, re-reads SQLite and
            // stable-serializes the whole document to reach the same verdict.
            carryIdleCycleSnapshot: true,
            // A versioned File Sync read represents an absent canonical document with
            // empty data plus `requiresRemoteRepair`. The read-check shortcut compares
            // only documents and would otherwise return "unchanged" before the CAS
            // create runs. The full cycle still skips equal existing documents.
            enableReadCheckSkip: backend !== 'file',
            postMergeAttachmentErrorPolicy: 'fail',
            attachmentPhasesEnabled: true,
          },
          // The cycle stores its error line in the library's settings (a failed remote write after the local save):
          // what it writes and returns is redacted like every other status.
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
        fileSyncLockCleanupDeferred = await this.releaseResources();
      }
      return result.success && fileSyncLockCleanupDeferred
        ? { ...result, fileSyncLockDeferred: 'cleanup' }
        : result;
    }

    /** Activation probes are the one place a cycle exists to answer a question about the
     *  remote's encryption posture rather than to sync (57f8e2420). One line per probe, forced,
     *  because the settings UI acts on this result and support has to see what it acted on. */
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
      // Preserve an OAuth refresh performed during the proof in the in-memory
      // candidate bundle. The settings transaction promotes this exact bundle
      // only after the proof succeeds.
      stagedCredentials.tokens = resolution.tokens;
      rememberSecret(resolution.accessToken);
      rememberSecret(resolution.tokens.accessToken);
      rememberSecret(resolution.tokens.refreshToken);
      return resolution.accessToken;
    }

    /** One Dropbox transport call's transient-retry wrap (network/5xx). The
     *  401-triggered token-refresh-and-retry-once policy lives in
     *  `createSyncBackendIO` (packages/core/src/sync-backend-io.ts) and calls
     *  `resolveDropboxToken`/`dropboxDownload`/`dropboxUpload`/`dropboxMetadata`
     *  directly — `isRetryableError` already excludes 401s, so this wrap never
     *  competes with that policy. */
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
        readPersistedLocal: async () => mergeLocalSyncStatus(await host.localData.getData()),
        persistLocal: async (data) => {
          await this.assertFileSyncLeaseHeld();
          await host.localData.saveData(data);
          await this.assertFileSyncLeaseHeld();
        },
        persistSyncStatus: async (updates) => {
          await this.assertFileSyncLeaseHeld();
          await applyLocalSyncStatus(updates);
          await this.assertFileSyncLeaseHeld();
        },
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
          void log.warn(message, { scope: 'sync', extra });
        },
        sanitizeLogMessage: (message) => log.sanitize(message),
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
          if (!isSyncPayloadTraceEnabled(core.useTaskStore.getState().settings)) return;
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

    /** One `remote-read` line per document read seam. Every path that can throw a
     *  SyncEncryption* error emits one first, so a shared log explains the refusal without a
     *  second round-trip to the user. Rides the Debug logging switch like the rest of the
     *  per-cycle detail. */
    private logRemoteRead(input: Parameters<typeof buildSyncEncryptionRemoteReadExtra>[0]): void {
      host.encryption.logSyncEncryptionEvent(
        SYNC_ENCRYPTION_LOG_EVENTS.remoteRead,
        buildSyncEncryptionRemoteReadExtra(input),
      );
    }

    /** The line that ties a user's toast to the trail: emitted where the cycle's failure is
     *  logged, with the classification the settings/toast layer will render. Forced, so it is
     *  present even when the user only turned Debug logging on after the failure. */
    /**
     * With no key, a WebDAV or Dropbox attachment pass first asks whether the location holds ciphertext (an encryption
     * change cut off there): its plaintext must never land beside it. Once per cycle. File Sync's own lock is held by the
     * cycle, so it relies on the download refusal and on the location a change was abandoned at.
     */
    private async assertLocationNotPartlyEncrypted(): Promise<void> {
      if (this.encryptionMaterial) return;
      const probe = host.encryption.probeLocationCiphertext;
      if (!probe || (this.backend !== 'webdav' && !(this.backend === 'cloud' && this.cloudProvider === 'dropbox'))) return;
      // The cycle's own folder: an activation probe's candidate is not the stored location yet.
      if (this.locationCiphertext === null) {
        this.locationCiphertext = await probe(this.backend === 'webdav' && this.webdavConfig ? { webdav: this.webdavConfig } : undefined);
        if (this.configOverride) {
          logSyncInfo('Sync candidate location ciphertext checked', {
            releaseCheck: 'v1.3.5/candidate-ciphertext-probe', backend: this.backend, found: this.locationCiphertext,
          });
        }
      }
      if (this.locationCiphertext !== 'plaintext') throw new SyncEncryptionPartlyEncryptedError();
    }

    /** A cycle that met ciphertext with no key remembers its location as partly encrypted (only while encryption is off
     *  here and no change is unfinished: those states say more). */
    private async rememberPartlyEncrypted(): Promise<void> {
      try {
        const current = await host.encryption.loadSyncEncryptionLocalState();
        if (current && (current.state !== 'off' || current.incompleteTransition)) return;
        if (!this.locationScope) return;
        await host.encryption.syncEncryptionLocalState.write({ state: 'off', partlyEncryptedScope: this.locationScope });
        await host.encryption.flushSyncEncryptionLocalState();
      } catch {
        // The cycle already failed closed; a mark that did not store only means the next cycle checks again.
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
          // Computed once, ahead of the encryption block below (which needs it to answer "has
          // this device already completed a cycle at this location") and reused for the cycle's
          // `fastSyncScope` at the bottom of this hook — same config, same pure builder.
          const fastSyncScope = buildFastSyncScope({
            backend,
            webdavConfig: this.webdavConfig,
            cloudProvider: this.cloudProvider,
            cloudConfig: this.cloudConfig,
            dropboxClientId: this.dropboxClientId,
          });
          // #1056: encryption applies to the three blob backends only. A device that knows
          // the remote is encrypted but holds no key must not sync at all — writing a fresh
          // plaintext document beside the ciphertext is exactly the outcome decision #5
          // exists to prevent. Automatic and background runs go quiet; a manual run says why.
          let legacyWebdavPostureAllowed = false;
          if (this.supportsSyncEncryption()) {
            const probingCandidate = this.activationProbe && Boolean(this.configOverride);
            this.locationScope = this.buildLocationScope();
            const encryptionStatus = await host.encryption.getSyncEncryptionStatus();
            const incompleteTransition = encryptionStatus.incompleteTransition;
            // The raw sidecar carries the salt and the discovery scope the status shape drops;
            // the trail needs both to explain a refusal (#1056 diagnostics). Reads the same
            // hydrated cache the gate below does, so this costs nothing extra.
            const localState = await host.encryption.loadSyncEncryptionLocalState().catch(() => null);
            this.encryptionStateAtSetup = localState?.state ?? 'off';
            // One `state` line per cycle, whatever the gate decides. Emitted immediately before
            // the return/throw it explains so a shared log never shows a refusal with no reason.
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
            // Partly encrypted here (a change cut off, abandoned on this device, or met as ciphertext with no key): this
            // device writes nothing at this location until a check finds it whole (the card's "Check this location again").
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
            // #1138: the block is bound to the location the discovery was made on. A state
            // written before scopes existed does not block at all — this cycle re-checks the
            // location like a fresh join, and the read seams re-mark it WITH a scope.
            if (!probingCandidate && await host.encryption.isSyncEncryptionBlocked(this.locationScope)) {
              logState(
                localState?.state === 'remote-plaintext' ? 'blocked-plaintext' : 'blocked-no-key',
                null,
              );
              if (!this.manual) return { kind: 'disabled' };
              throw new SyncEncryptionNoKeyError();
            }
            // fresh-join-attachment-posture packet -10: closes #1138 result §8 risk 2. A fast-sync
            // record for THIS location's fastSyncScope is the durable "already read this remote
            // once and found it plaintext/absent" fact for the off-state case. The file backend
            // has no fastSyncScope (buildFastSyncScope returns null there), so it falls back to
            // the attachment presence-reconciliation stamp (#1119): that stamp is only ever
            // written at the END of a completed attachment pass, scoped the same way, so its
            // presence for THIS location proves a full cycle already ran here — the correction
            // pass's durable "seen this location" fact for backends with no fast-sync record.
            // Checked as an additional OR for webdav/dropbox too, so a device that completed a
            // presence pass without yet writing a fast-sync record (or vice versa) is still
            // recognized as established either way.
            //
            // No scope argument (review finding B2): `hasCompletedAttachmentPresenceReconciliation`
            // derives its own comparison scope via `readActiveSyncLocationScope`, the SAME
            // derivation `markAttachmentPresenceReconciled` writes with. `this.locationScope`
            // below is built from the resolved file path (`buildLocationScope`), which can differ
            // byte-for-byte from the stored path for an iOS folder bookmark — passing it here
            // compared two different derivations and never matched.
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
              // `enabled` with no resolvable key (keystore invalidation). The line has to
              // precede the throw, or the failure reaches the log with no posture behind it.
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
              // Same budget as the cycle's own reads: a legacy-plaintext result is
              // never pinned, so this probe runs every cycle, and on a slow link
              // a tighter timeout failed syncs whose data.json GET would succeed.
              setStep('webdav_probe');
              // Retried like the cycle's own read: a single 30s timeout on the cold
              // first request must not fail a cycle whose reads would then succeed.
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
          // CloudKit setup — ensure zone and subscription exist before sync cycle.
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
          // #1138 / fresh-join-attachment-posture packet -10: this cycle does not yet know the
          // active location's encryption posture (a re-check for a stale/mismatched discovery,
          // or a device with no persisted encryption state at all), and the pre-sync attachment
          // phase runs BEFORE the document read (`preSyncAttachmentsBeforeFastCheck`). With no
          // key resolved it would upload PLAINTEXT attachment bytes beside ciphertext — exactly
          // what decision #5 forbids — before the read got a chance to discover the folder is
          // still encrypted. Skip the pre-phase; the post-merge phase runs normally once the read
          // has settled the posture.
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
                // Token refresh can yield long enough for a local edit. Guard at
                // the final provider call, not only before resolving credentials.
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
            // A sync asked for while this cycle wound down (the app opened meanwhile) would start once it ends, after the
            // background job let go; the job's next run, or the foreground's next trigger, syncs instead.
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
          // mergedData is exactly what the last writeLocal persisted, so refresh the
          // store from it directly instead of re-reading the full dataset from SQLite.
          // When the cycle wrote nothing locally the merge produced nothing the store
          // does not already hold, and this refresh is an O(all tasks) normalize pass
          // whose result the identity reconcile then discards. Sync status bookkeeping
          // still reaches the store through persistSyncStatus.
          const refreshStartedAt = Date.now();
          if (!info.localWriteSkipped) {
            await traceSectionAsync('sync:storeApply', () => core.useTaskStore.getState().fetchData({ silent: true, preloadedData: mergedData }));
            // The refresh alone never publishes this cycle's status: the store keeps its
            // previous settings object whenever the incoming one differs only in the
            // volatile lastSync* keys (reuseSettingsIfEquivalent, #766), so the Sync
            // screen kept showing an hours-old "Last sync" while cycles kept succeeding.
            // The local-write-skipped path already gets this patch from core's
            // persistSyncStatusOnly; issue it here for every cycle that wrote locally.
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
        allowLegacyWebdavPlaintext: this.allowLegacyWebdavPlaintext,
        syncEncryptionOff: this.syncEncryptionOff,
      };
    }

    /** Mobile's transport truths for one sync cycle: WebDAV rate-limit
     *  wrapping (`ensureWebdavSyncNotRateLimited`/`handleWebdavRateLimit`) and
     *  `AbortSignal` plumbing through every remote call. Retry wrapping
     *  (`WEBDAV_READ_RETRY_OPTIONS`/`WEBDAV_RETRY_OPTIONS`/
     *  `runDropboxTransientRetry`) is mobile's own policy and stays here —
     *  `createSyncBackendIO` calls these methods without adding or removing
     *  retries of its own. */
    private createBackendTransport(ctx: SyncBackendContext): SyncTransport {
      return {
        // Fence ports deliberately skip `fetchWithAbort`: a lifecycle abort mid-cycle
        // (app to background, background-job deadline) used to cancel the release
        // requests in `run()`'s finally, leaving a lease that blocked every device
        // for up to the 5-minute TTL. Fence requests are tiny and bounded by
        // DEFAULT_SYNC_TIMEOUT_MS, so letting them finish is cheaper than a stale lock.
        acquireWebdavRemoteMutationFence: async () => {
          const webdavConfig = this.webdavConfig;
          if (!webdavConfig?.url) throw new Error('WebDAV URL not configured');
          this.ensureWebdavSyncNotRateLimited();
          // #1132 proof: React Native's URL class ignored pathname writes and resolved the
          // fence to the sync document itself. The basename below must never be data.json.
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
            // Raw read only. What an encrypted / plaintext / no-strong-ETag outcome
            // MEANS is decided once by `createSyncBackendIO` through the encryption
            // posture port (`createBackendIO` below).
            return await core.withRetry(
              () => core.webdavGetSyncDocument<AppData>(webdavConfig.url, {
                ...requestOptions,
                material: this.encryptionMaterial ?? undefined,
                cryptoPrims: host.crypto,
              }),
              WEBDAV_READ_RETRY_OPTIONS
            );
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
          // `ctx`, not `this`: the ladder may have degraded this cycle to the plaintext
          // write after a read arrived without a strong ETag.
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
            // Deliberately one-shot: retrying an unconditional legacy PUT after an
            // ambiguous transport failure could overwrite a peer generation.
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
          // The `material` key is added only when encryption is on, so the off-state call
          // is argument-for-argument what it was before this feature (invariant #1).
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
        // Every attachment pass (prepare, post-merge, final, activation) goes through these two, so the
        // partly-encrypted check sits here once.
        syncWebdavAttachments: async (data, helpers) => {
          await this.assertLocationNotPartlyEncrypted();
          const webdavConfig = this.webdavConfig!;
          return host.attachments.syncWebdav(data, webdavConfig, this.requestAbortController.signal, {
            activationProbe: helpers.activationProbe,
            activationContinuation: helpers.activationContinuation,
            phase: helpers.phase,
            assertRemoteMutationFenceHeld: helpers.assertRemoteMutationFenceHeld,
            onTransferBatchDeferred: helpers.onTransferBatchDeferred,
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
              ...(this.encryptionMaterial ? { material: this.encryptionMaterial } : {}),
            },
          );
          await this.assertFileSyncLeaseHeld();
          return result;
        },
      };
    }

    /** Backend transport adapter for the core machine (ADR 0014). The ladder
     *  (which backend, url normalization, the Dropbox rev fingerprint format,
     *  the conflict mapping, and the auth-retry-once policy) lives in
     *  `createSyncBackendIO`; this only supplies mobile's transport truths. */
    private createBackendIO(): SyncBackendIO {
      const ctx = this.createBackendContext();
      // The WebDAV read posture decision lives in the shared machine; this port
      // carries only mobile's own truths — its key material, its diagnostics and
      // durable-state sinks (already bound to this cycle's location scope), and
      // its no-key error class.
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
        // Persist first (decision #5: the state must survive a restart); the machine
        // fails the cycle afterwards. Nothing on the remote is touched on this path.
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
          // Plaintext cycle: the ladder degrades to the bounded legacy write
          // (packages/core/src/sync-backend-io.ts). Log the validator we actually
          // saw so the next report says what the server sent.
          void log.info('WebDAV read returned no strong ETag; using the plaintext compatibility write', {
            scope: 'sync',
            extra: { etag: String(etag ?? 'none') },
          });
        },
      };
      const io = createSyncBackendIO(ctx, this.createBackendTransport(ctx), encryptionPosture);
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

  const mobileSyncOrchestrator = createSyncOrchestrator<MobileSyncRequest | undefined, MobileSyncResult>({
    getFollowUpDelayMs: (lastCycleDurationMs, minimumDelayMs) => {
      const pacedDelayMs = Math.min(Math.max(lastCycleDurationMs, MIN_FOLLOW_UP_DELAY_MS), MAX_FOLLOW_UP_DELAY_MS);
      // A busy remote fence or File Sync lock asks for a longer wait than pacing;
      // log the delay that actually applies so a 229s fence wait stops reading as 1.2s.
      const delayMs = Math.max(pacedDelayMs, minimumDelayMs);
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
      return runSerializedSyncDocumentOperation(() => syncRun.run());
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

  /** `manual` marks a user-initiated sync: it always runs the full read/merge cycle,
   *  never the fast-check skip, so a stale cached fingerprint can't hide remote data. */
  async function performMobileSync(
    syncPathOverride?: string,
    options?: {
      manual?: boolean;
      activationProbe?: boolean;
      ignorePendingRemoteWriteBackoff?: boolean;
      configOverride?: MobileSyncConfigOverride;
    }
  ): Promise<MobileSyncResult> {
    if (fatalCleanupError) throw fatalCleanupError;
    if (core.isSandboxMode() || core.isWorkspaceTransitionActive()) {
      return { success: true, skipped: 'disabled' };
    }
    const wasInFlight = mobileSyncOrchestrator.getState().inFlight;
    if (wasInFlight && (!allowQueuedFollowUp || options?.activationProbe)) {
      // A caller-owned invocation cannot queue work beyond its current owner.
      // A session-only activation config must also observe its own proof.
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
      void result.catch((error) => {
        if (!(error instanceof NativeAttachmentCleanupUnconfirmedError)) {
          logSyncWarning('Active sync failed while a settings proof was queued', error);
        }
      });
      return { success: true, skipped: 'requeued' };
    }
    return result;
  }

  /** Aborts the running cycle: 'lifecycle' (the app changed state) queues a follow-up, 'deadline' (a background run gave up) does not. */
  function abortMobileSync(reason: 'lifecycle' | 'deadline' = 'lifecycle'): boolean {
    if (!activeMobileSyncAbortController) return false;
    // A deadline stop stays one: a lifecycle abort after it (the app closing during its cleanup) must not queue a follow-up.
    if (activeMobileSyncAbortReason !== 'deadline') activeMobileSyncAbortReason = reason;
    activeMobileSyncAbortController.abort();
    return true;
  }

  const __mobileSyncTestUtils = {
    reset() {
      mobileSyncOrchestrator.reset();
      // Each test stands up a fresh fake store; the core cycle's idle snapshot is
      // process-wide because a real app has exactly one.
      clearIdleSyncCycleSnapshot();
      clearMobileSyncConfigCache();
      mobileSyncActivityListeners.clear();
      mobileSyncDrainListeners.clear();
      mobileSyncActivityState = 'idle';
      webdavSyncRateLimitController.reset();
      activeMobileSyncAbortController = null;
      activeMobileSyncAbortReason = null;
      fatalCleanupError = null;
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
    getMobileSyncActivityState,
    subscribeMobileSyncActivityState,
    waitForMobileSyncIdle,
    clearMobileSyncConfigCache,
    abortMobileSync,
    __mobileSyncTestUtils,
  };
};

export type MobileSyncService<Lease = unknown> = ReturnType<typeof createMobileSyncService<Lease>>;
