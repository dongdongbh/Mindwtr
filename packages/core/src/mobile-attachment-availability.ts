// On-demand attachment fetch: what runs when a user opens an attachment whose bytes exist
// only on the sync remote. One branch per backend (File Sync, CloudKit, self-hosted cloud,
// Dropbox, WebDAV); each downloads into scratch and publishes through the native installer
// only while the managed target is still absent. It moved here from React Native's
// `apps/mobile/lib/attachment-sync-availability.ts` so the native apps run the same rules.
//
// Data safety: a failed download never deletes local bytes, a target already on disk is used
// only when its bytes prove they are the current remote generation, and a CloudKit not-found, a
// WebDAV or self-hosted cloud 404, or a Dropbox path-not-found is terminal (the attachment is marked unrecoverable).
import type { Attachment } from './types';
import { computeSha256Hex, isSha256Hex } from './attachment-hash';
import { extractExtension, getBaseSyncUrl, getCloudBaseUrl } from './attachment-paths';
import { reportProgress, validateAttachmentHash } from './attachment-transfer';
import { markAttachmentUnrecoverable } from './attachment-validation';
import { cloudGetFile } from './cloud';
import { parseCloudKitAttachmentKey } from './cloudkit-attachments';
import { DropboxFileNotFoundError, downloadDropboxFile } from './dropbox';
import { withRetry } from './retry-utils';
import { getErrorStatus } from './sync-runtime-utils';
import { isSandboxMode } from './sandbox';
import { CLOUD_PROVIDER_DROPBOX } from './sync-client-helpers';
import { CLOUD_PROVIDER_KEY, SYNC_BACKEND_KEY, SYNC_PATH_KEY, type SyncKeyValueStoragePort } from './sync-storage-keys';
import { webdavGetFile } from './webdav';
import { getMobileCloudRequestOptions, getMobileWebDavRequestOptions } from './mobile-sync-utils';
import { isHttpAttachmentUri, type MobileAttachmentFiles } from './mobile-attachment-files';
import { assertAttachmentSyncNotAborted, type MobileAttachmentCommon, type PreparedAttachmentDownloadBytes } from './mobile-attachment-common';
import type { MobileSyncEncryptionPort } from './mobile-sync-service';

export type AttachmentAvailabilityOutcome =
  | { status: 'available'; attachment: Attachment }
  | { status: 'generation-conflict' }
  | { status: 'unrecoverable'; attachment: Attachment }
  | { status: 'unavailable' };

/** Remote download naming; unlike managed copies, only the title supplies a fallback extension. */
export const getAttachmentDownloadFileName = (attachment: Attachment): string =>
  attachment.cloudKey?.split('/').pop() || `${attachment.id}${extractExtension(attachment.title)}`;

/** Private candidate only. Its source is not installed or checkpointed availability. */
export type PreparedAttachmentAvailabilityOutcome = AttachmentAvailabilityOutcome | {
  status: 'prepared';
  attachment: Attachment;
  sourceToken: string;
  sha256: string;
  size: number;
};

const GENERATION_CONFLICT = Symbol('attachment-generation-conflict');
type InternalUnrecoverableOutcome = {
  availabilityStatus: 'unrecoverable';
  attachment: Attachment;
};
type InternalAvailabilityOutcome =
  | Attachment
  | InternalUnrecoverableOutcome
  | null
  | typeof GENERATION_CONFLICT;
type InternalPreparedOutcome = PreparedAttachmentDownloadBytes & {
  availabilityStatus: 'prepared';
  attachment: Attachment;
};
type InternalPreparationOutcome = InternalAvailabilityOutcome | InternalPreparedOutcome;

/** A download may only be shared while it represents the same immutable remote bytes. */
export const getAttachmentDownloadIdentity = (attachment: Attachment): string => JSON.stringify([
  attachment.id,
  attachment.cloudKey ?? null,
  attachment.fileHash ?? null,
  attachment.contentRev ?? 0,
]);

export const hasAttachmentDownloadIdentity = (
  attachment: Attachment | undefined,
  identity: string,
): attachment is Attachment => Boolean(attachment && getAttachmentDownloadIdentity(attachment) === identity);

/** Descriptive metadata belongs to the current document. A completed download may
 * only publish device-local availability and fill a previously absent verified hash. */
export const getAttachmentAvailabilityPatch = (
  current: Attachment,
  resolved: Attachment,
): Partial<Attachment> => ({
  uri: resolved.uri,
  localStatus: resolved.localStatus,
  ...(!current.fileHash && resolved.fileHash ? { fileHash: resolved.fileHash } : {}),
});

/** Terminal remote absence may clear only lifecycle fields. Descriptive metadata remains
 * owned by the latest document selected by the caller's download-identity guard. */
export const getAttachmentUnrecoverablePatch = (
  resolved: Attachment,
): Partial<Attachment> => ({
  cloudKey: resolved.cloudKey,
  fileHash: resolved.fileHash,
  localStatus: resolved.localStatus,
  deletedAt: resolved.deletedAt,
  updatedAt: resolved.updatedAt,
});

/** Core functions called through here so a host's tests can replace them the way they
 *  replace `@mindwtr/core`. A host that passes nothing gets core's own. */
export type MobileAttachmentAvailabilityCoreFunctions = {
  isSandboxMode: typeof isSandboxMode;
  withRetry: typeof withRetry;
  cloudGetFile: typeof cloudGetFile;
  webdavGetFile: typeof webdavGetFile;
  downloadDropboxFile: (accessToken: string, path: string) => Promise<ArrayBuffer>;
  /** Dropbox's path-not-found refusal (a host whose Dropbox client throws its own error class says which). */
  isDropboxFileNotFoundError: (error: unknown) => boolean;
};

/** iCloud attachment assets (iOS only). */
export type MobileAttachmentCloudKitPort = {
  /** Downloads the record's asset into `stagedUri`. */
  fetchAttachmentAsset(recordName: string, stagedUri: string): Promise<unknown>;
  isAttachmentNotFoundError(error: unknown): boolean;
};

export type MobileAttachmentAvailabilityHost = {
  files: MobileAttachmentFiles;
  common: MobileAttachmentCommon;
  /** The device key-value store (React Native: AsyncStorage). */
  storage: Pick<SyncKeyValueStoragePort, 'getItem'>;
  encryption: Pick<MobileSyncEncryptionPort, 'getSyncEncryptionMaterial'>;
  /** The build's Dropbox app key, or '' when none is configured. */
  getDropboxClientId(): Promise<string>;
  /** A host without CloudKit reports every `cloudkit` attachment as unavailable. */
  cloudKit?: MobileAttachmentCloudKitPort;
  core?: Partial<MobileAttachmentAvailabilityCoreFunctions>;
};

export const createMobileAttachmentAvailability = (host: MobileAttachmentAvailabilityHost) => {
  const core: MobileAttachmentAvailabilityCoreFunctions = {
    isSandboxMode,
    withRetry,
    cloudGetFile,
    webdavGetFile,
    downloadDropboxFile: (accessToken, path) => downloadDropboxFile(accessToken, path),
    isDropboxFileNotFoundError: (error) => error instanceof DropboxFileNotFoundError,
    ...host.core,
  };
  const { files, common } = host;
  const prepareAttachmentDownloadBytes = common.prepareAttachmentDownloadBytes;
  const downloadLocks = new Map<string, Promise<AttachmentAvailabilityOutcome>>();

  /**
   * A failed on-demand download: progress fails, and a remote that answers the file is gone ([notFound]) is terminal, as the
   * sync pass treats it: the attachment is marked unrecoverable (on a copy; local bytes are never deleted), so a retry asks
   * the server nothing. Any other failure stays retryable.
   */
  const downloadFailed = (
    attachment: Attachment,
    error: unknown,
    notFound: boolean,
    terminalLog: { message: string; releaseCheck: string },
  ): InternalAvailabilityOutcome => {
    reportProgress(
      attachment.id,
      'download',
      0,
      attachment.size ?? 0,
      'failed',
      notFound ? 'Attachment is no longer available' : error instanceof Error ? error.message : String(error)
    );
    if (notFound) {
      markAttachmentUnrecoverable(attachment);
      files.logAttachmentWarn(terminalLog.message, error, { releaseCheck: terminalLog.releaseCheck });
      return { availabilityStatus: 'unrecoverable', attachment };
    }
    files.logAttachmentWarn(`Failed to download attachment ${attachment.id}`, error);
    return null;
  };

  /** A managed target left by a prior attempt is usable only when its bytes prove
   * they are the current remote generation. Without a remote hash there is no safe
   * way to distinguish a crash retry from a stale generation that won the absent CAS. */
  const resolveMatchingManagedTarget = async (
    attachment: Attachment,
    targetUri: string,
    signal?: AbortSignal,
  ): Promise<InternalAvailabilityOutcome> => {
    assertAttachmentSyncNotAborted(signal);
    if (!isSha256Hex(attachment.fileHash)) return GENERATION_CONFLICT;
    try {
      const bytes = await files.readFileAsBytes(targetUri);
      assertAttachmentSyncNotAborted(signal);
      await validateAttachmentHash(attachment, bytes);
      assertAttachmentSyncNotAborted(signal);
      return { ...attachment, uri: targetUri, localStatus: 'available' };
    } catch (error) {
      assertAttachmentSyncNotAborted(signal);
      files.logAttachmentWarn(`Managed attachment ${attachment.id} does not match the requested generation`, error);
      return GENERATION_CONFLICT;
    }
  };

  /**
   * Publish an on-demand download only while the managed target is still absent.
   * The native installer owns the scratch generation once invoked; a false result
   * is a late local create and already records centralized failed progress.
   */
  const installMissingAttachmentBytes = async (
    attachment: Attachment,
    attachmentsDir: string,
    targetUri: string,
    bytes: Uint8Array,
    purpose: 'install' | 'prepare' = 'install',
    signal?: AbortSignal,
  ): Promise<InternalPreparationOutcome> => {
    if (purpose === 'prepare') {
      if (!prepareAttachmentDownloadBytes) throw new Error('Attachment download preparation is unavailable');
      const prepared = await prepareAttachmentDownloadBytes(attachment, targetUri, bytes, signal);
      return {
        ...prepared,
        availabilityStatus: 'prepared',
        attachment: { ...attachment, uri: targetUri, localStatus: 'available', fileHash: prepared.sha256 },
      };
    }
    const installed = await common.installAttachmentDownloadBytes(
      attachment,
      attachmentsDir,
      targetUri,
      bytes,
      { kind: 'absent' },
    );
    if (!installed) return GENERATION_CONFLICT;
    return { ...attachment, uri: targetUri, localStatus: 'available' };
  };

  const installMissingAttachmentStage = async (
    attachment: Attachment,
    stagedPath: string,
    targetUri: string,
    material: Awaited<ReturnType<MobileSyncEncryptionPort['getSyncEncryptionMaterial']>>,
  ): Promise<InternalAvailabilityOutcome> => {
    let installHelperOwnsStage = false;
    try {
      let expectedStagedHash = !material && isSha256Hex(attachment.fileHash)
        ? attachment.fileHash.toLowerCase()
        : null;
      if (!expectedStagedHash) {
        const wireBytes = await common.readAttachmentDownloadStageBytes(stagedPath);
        const plaintextBytes = await common.openAttachmentBytesFromDownload(wireBytes, material);
        const plaintextHash = await computeSha256Hex(plaintextBytes);
        if (!plaintextHash) throw new Error('Attachment download hash is unavailable');
        await validateAttachmentHash(attachment, plaintextBytes);
        if (plaintextBytes !== wireBytes) {
          await files.writeBytesSafely(stagedPath, plaintextBytes);
        }
        expectedStagedHash = plaintextHash;
      }
      installHelperOwnsStage = true;
      const installed = await common.installStagedAttachmentDownload({
        attachment,
        stagedPath,
        targetPath: targetUri,
        expectation: { kind: 'absent' },
        expectedStagedHash,
      });
      if (!installed) return GENERATION_CONFLICT;
      return { ...attachment, uri: targetUri, localStatus: 'available' };
    } catch (error) {
      if (!installHelperOwnsStage) {
        await common.deleteAttachmentDownloadStageBestEffort(stagedPath);
      }
      throw error;
    }
  };

  const ensureFileAttachmentAvailable = async (
    attachment: Attachment,
    syncPath: string
  ): Promise<InternalAvailabilityOutcome> => {
    const syncDir = await files.resolveFileSyncDir(syncPath);
    if (!syncDir) return null;
    if (!attachment.cloudKey) return null;
    const attachmentsDir = await files.getAttachmentsDir();
    if (!attachmentsDir) return null;
    const filename = getAttachmentDownloadFileName(attachment);
    const targetUri = `${attachmentsDir}${filename}`;
    const targetPresence = await files.getLocalAttachmentPresence(targetUri);
    if (targetPresence === 'unreadable') return null;
    if (targetPresence === 'present') {
      return resolveMatchingManagedTarget(attachment, targetUri);
    }

    let stagedPath: string | null = null;
    let installerOwnsStage = false;
    try {
      // #1056: the local attachments directory always holds plaintext, so an encrypted
      // sync folder's bytes are opened on the way in. `null` material keeps the
      // byte-for-byte pre-feature behavior. Inside the try: S3 — an enabled-but-no-key
      // device throws instead of returning `null`, and that must fail this fetch closed
      // (logged, `null` result), never fall through to a plaintext path as if encryption
      // were off.
      const material = await host.encryption.getSyncEncryptionMaterial();
      let sourceUri: string;
      if (syncDir.type === 'file') {
        sourceUri = `${syncDir.attachmentsDirUri}${filename}`;
        const sourcePresence = await files.getLocalAttachmentPresence(sourceUri);
        if (sourcePresence !== 'present') return null;
      } else {
        const entry = await files.findSafEntry(syncDir.attachmentsDirUri, filename);
        if (!entry) return null;
        sourceUri = entry;
      }
      stagedPath = await common.copyAttachmentDownloadToStage(attachment, attachmentsDir, sourceUri);
      installerOwnsStage = true;
      return await installMissingAttachmentStage(attachment, stagedPath, targetUri, material);
    } catch (error) {
      if (stagedPath && !installerOwnsStage) {
        await common.deleteAttachmentDownloadStageBestEffort(stagedPath);
      }
      files.logAttachmentWarn(`Failed to make attachment ${attachment.id} available from sync folder`, error);
      return null;
    }
  };

  const ensureCloudKitAttachmentAvailable = async (
    attachment: Attachment,
    cloudKit: MobileAttachmentCloudKitPort,
  ): Promise<InternalAvailabilityOutcome> => {
    const recordName = parseCloudKitAttachmentKey(attachment.cloudKey);
    if (!recordName) return null;
    const attachmentsDir = await files.getAttachmentsDir();
    if (!attachmentsDir) return null;
    const extension = extractExtension(attachment.title) || extractExtension(attachment.uri);
    const targetUri = `${attachmentsDir}${attachment.id}${extension}`;
    const targetPresence = await files.getLocalAttachmentPresence(targetUri);
    if (targetPresence === 'unreadable') return null;
    if (targetPresence === 'present') {
      return resolveMatchingManagedTarget(attachment, targetUri);
    }

    const stagedUri = common.createAttachmentDownloadStagePath(attachmentsDir, attachment);
    let installerOwnsStage = false;
    try {
      reportProgress(attachment.id, 'download', 0, attachment.size ?? 0, 'active');
      await cloudKit.fetchAttachmentAsset(recordName, stagedUri);
      installerOwnsStage = true;
      const installed = await common.installStagedAttachmentDownload({
        attachment,
        stagedPath: stagedUri,
        targetPath: targetUri,
        expectation: { kind: 'absent' },
      });
      if (!installed) return GENERATION_CONFLICT;
      reportProgress(
        attachment.id,
        'download',
        attachment.size ?? 0,
        attachment.size ?? 0,
        'completed',
      );
      return { ...attachment, uri: targetUri, localStatus: 'available' };
    } catch (error) {
      if (!installerOwnsStage) {
        await common.deleteAttachmentDownloadStageBestEffort(stagedUri);
      }
      const terminalNotFound = cloudKit.isAttachmentNotFoundError(error);
      reportProgress(
        attachment.id,
        'download',
        0,
        attachment.size ?? 0,
        'failed',
        terminalNotFound
          ? 'Attachment is no longer available'
          : error instanceof Error ? error.message : String(error),
      );
      if (terminalNotFound) {
        markAttachmentUnrecoverable(attachment);
        files.logAttachmentWarn(`CloudKit attachment ${attachment.id} is no longer available`, error);
        return { availabilityStatus: 'unrecoverable', attachment };
      }
      files.logAttachmentWarn(`Failed to download CloudKit attachment ${attachment.id}`, error);
      return null;
    }
  };

  function ensureAttachmentAvailableInternal(attachment: Attachment): Promise<InternalAvailabilityOutcome>;
  function ensureAttachmentAvailableInternal(attachment: Attachment, purpose: 'prepare', signal?: AbortSignal): Promise<InternalPreparationOutcome>;
  async function ensureAttachmentAvailableInternal(
    attachment: Attachment,
    purpose: 'install' | 'prepare' = 'install',
    signal?: AbortSignal,
  ): Promise<InternalPreparationOutcome> {
    const preparing = purpose === 'prepare';
    assertAttachmentSyncNotAborted(signal);
    if (attachment.kind !== 'file') return preparing ? null : attachment;
    const localAttachment = { ...attachment };
    if (preparing && (!localAttachment.cloudKey || localAttachment.deletedAt)) return null;
    const preparedBackend = preparing ? await host.storage.getItem(SYNC_BACKEND_KEY) : undefined;
    assertAttachmentSyncNotAborted(signal);
    if (preparing && preparedBackend !== 'webdav') return null;
    const uri = localAttachment.uri || '';
    if (uri && isHttpAttachmentUri(uri)) {
      if (preparing) return null;
      return { ...localAttachment, localStatus: 'available' };
    }

    if (uri) {
      const sourcePresence = await files.getLocalAttachmentPresence(uri);
      assertAttachmentSyncNotAborted(signal);
      if (sourcePresence === 'unreadable') return null;
      if (sourcePresence === 'present') {
        if (preparing) return resolveMatchingManagedTarget(localAttachment, uri, signal);
        if (await files.ensureAttachmentStoredLocally(localAttachment)) {
          return localAttachment;
        }
        return { ...localAttachment, localStatus: 'available' };
      }
    }

    const backend = preparing ? preparedBackend : await host.storage.getItem(SYNC_BACKEND_KEY);
    if (backend === 'file') {
      const syncPath = await host.storage.getItem(SYNC_PATH_KEY);
      if (syncPath) {
        const resolved = await ensureFileAttachmentAvailable(localAttachment, syncPath);
        if (resolved) return resolved;
      }
      return null;
    }

    if (backend === 'cloudkit') {
      if (!host.cloudKit) return null;
      return ensureCloudKitAttachmentAvailable(localAttachment, host.cloudKit);
    }

    if (backend === 'cloud' && localAttachment.cloudKey) {
      const attachmentsDir = await files.getAttachmentsDir();
      if (!attachmentsDir) return null;
      const filename = getAttachmentDownloadFileName(localAttachment);
      const targetUri = `${attachmentsDir}${filename}`;
      const targetPresence = await files.getLocalAttachmentPresence(targetUri);
      if (targetPresence === 'unreadable') return null;
      if (targetPresence === 'present') {
        return resolveMatchingManagedTarget(localAttachment, targetUri);
      }
      const cloudProvider = ((await host.storage.getItem(CLOUD_PROVIDER_KEY)) || '').trim();
      if (cloudProvider === CLOUD_PROVIDER_DROPBOX) {
        const dropboxClientId = await host.getDropboxClientId();
        if (!dropboxClientId) return null;
        try {
          const data = await files.runDropboxAuthorized(
            dropboxClientId,
            (accessToken) => core.downloadDropboxFile(accessToken, localAttachment.cloudKey as string),
          );
          const bytes = await common.openAttachmentBytesFromDownload(
            data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer),
            await host.encryption.getSyncEncryptionMaterial(),
          );
          const installedAttachment = await installMissingAttachmentBytes(
            localAttachment,
            attachmentsDir,
            targetUri,
            bytes,
          );
          if (installedAttachment === GENERATION_CONFLICT) return GENERATION_CONFLICT;
          if (!installedAttachment) return null;
          reportProgress(localAttachment.id, 'download', bytes.length, bytes.length, 'completed');
          return installedAttachment;
        } catch (error) {
          return downloadFailed(localAttachment, error, core.isDropboxFileNotFoundError(error), {
            message: `Dropbox attachment ${localAttachment.id} is no longer available`,
            releaseCheck: 'v1.3.4/dropbox-download-not-found',
          });
        }
      }
      const config = await files.loadCloudConfig();
      if (!config?.url) return null;
      const baseSyncUrl = getCloudBaseUrl(config.url);
      try {
        const data = await core.withRetry(() =>
          core.cloudGetFile(`${baseSyncUrl}/${localAttachment.cloudKey}`, {
            ...getMobileCloudRequestOptions(config.allowInsecureHttp),
            token: config.token,
            onProgress: (loaded, total) => reportProgress(localAttachment.id, 'download', loaded, total, 'active'),
          })
        );
        const bytes = await common.openAttachmentBytesFromDownload(
          data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer),
          await host.encryption.getSyncEncryptionMaterial(),
        );
        const installedAttachment = await installMissingAttachmentBytes(
          localAttachment,
          attachmentsDir,
          targetUri,
          bytes,
        );
        if (installedAttachment === GENERATION_CONFLICT) return GENERATION_CONFLICT;
        if (!installedAttachment) return null;
        reportProgress(localAttachment.id, 'download', bytes.length, bytes.length, 'completed');
        return installedAttachment;
      } catch (error) {
        return downloadFailed(localAttachment, error, getErrorStatus(error) === 404, {
          message: `Cloud attachment ${localAttachment.id} is no longer available`,
          releaseCheck: 'v1.3.4/cloud-download-not-found',
        });
      }
    }

    if (localAttachment.cloudKey) {
      const config = await files.loadWebDavConfig();
      assertAttachmentSyncNotAborted(signal);
      if (!config?.url) return null;
      const baseSyncUrl = getBaseSyncUrl(config.url);
      const attachmentsDir = preparing ? files.getManagedAttachmentsDir() : await files.getAttachmentsDir();
      assertAttachmentSyncNotAborted(signal);
      if (!attachmentsDir) return null;
      const filename = getAttachmentDownloadFileName(localAttachment);
      const targetUri = `${attachmentsDir}${filename}`;
      const targetPresence = await files.getLocalAttachmentPresence(targetUri);
      assertAttachmentSyncNotAborted(signal);
      if (targetPresence === 'unreadable') return null;
      if (targetPresence === 'present') {
        return resolveMatchingManagedTarget(localAttachment, targetUri, signal);
      }
      try {
        const data = await core.withRetry(() => {
          assertAttachmentSyncNotAborted(signal);
          return core.webdavGetFile(`${baseSyncUrl}/${localAttachment.cloudKey}`, {
            ...getMobileWebDavRequestOptions(config.allowInsecureHttp),
            username: config.username,
            password: config.password,
            ...(preparing ? { signal } : {}),
            onProgress: (loaded, total) => reportProgress(localAttachment.id, 'download', loaded, total, 'active'),
          });
        });
        assertAttachmentSyncNotAborted(signal);
        const wireBytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer);
        const material = await host.encryption.getSyncEncryptionMaterial();
        assertAttachmentSyncNotAborted(signal);
        const bytes = await common.openAttachmentBytesFromDownload(
          wireBytes,
          material,
        );
        assertAttachmentSyncNotAborted(signal);
        const installedAttachment = await installMissingAttachmentBytes(
          localAttachment,
          attachmentsDir,
          targetUri,
          bytes,
          purpose,
          signal,
        );
        assertAttachmentSyncNotAborted(signal);
        if (installedAttachment === GENERATION_CONFLICT) return GENERATION_CONFLICT;
        if (!installedAttachment) return null;
        if ('availabilityStatus' in installedAttachment && installedAttachment.availabilityStatus === 'prepared') return installedAttachment;
        reportProgress(localAttachment.id, 'download', bytes.length, bytes.length, 'completed');
        return installedAttachment;
      } catch (error) {
        assertAttachmentSyncNotAborted(signal);
        return downloadFailed(localAttachment, error, getErrorStatus(error) === 404, {
          message: `WebDAV attachment ${localAttachment.id} is no longer available`,
          releaseCheck: 'v1.3.4/webdav-download-not-found',
        });
      }
    }

    return null;
  }

  const ensureAttachmentAvailableDetailed = async (
    attachment: Attachment,
  ): Promise<AttachmentAvailabilityOutcome> => {
    if (core.isSandboxMode()) return { status: 'unavailable' };
    if (attachment.kind !== 'file') return { status: 'available', attachment };
    const identity = getAttachmentDownloadIdentity(attachment);
    const existing = downloadLocks.get(identity);
    if (existing) return existing;
    const downloadPromise = ensureAttachmentAvailableInternal(attachment).then((result): AttachmentAvailabilityOutcome => {
      if (result === GENERATION_CONFLICT) return { status: 'generation-conflict' };
      if (!result) return { status: 'unavailable' };
      if ('availabilityStatus' in result) {
        return { status: 'unrecoverable', attachment: result.attachment };
      }
      return { status: 'available', attachment: result };
    });
    downloadLocks.set(identity, downloadPromise);
    try {
      return await downloadPromise;
    } finally {
      downloadLocks.delete(identity);
    }
  };

  /** Compatibility wrapper for existing non-UI callers. Detailed callers retain conflicts. */
  const ensureAttachmentAvailable = async (attachment: Attachment): Promise<Attachment | null> => {
    const outcome = await ensureAttachmentAvailableDetailed(attachment);
    return outcome.status === 'available' ? outcome.attachment : null;
  };

  const prepareAttachmentAvailableDetailed = prepareAttachmentDownloadBytes ? async (
    attachment: Attachment,
    signal?: AbortSignal,
  ): Promise<PreparedAttachmentAvailabilityOutcome> => {
    assertAttachmentSyncNotAborted(signal);
    if (core.isSandboxMode()) return { status: 'unavailable' };
    // A source token belongs to this invocation; never use ordinary downloadLocks.
    const result = await ensureAttachmentAvailableInternal(attachment, 'prepare', signal);
    assertAttachmentSyncNotAborted(signal);
    if (result === GENERATION_CONFLICT) return { status: 'generation-conflict' };
    if (!result) return { status: 'unavailable' };
    if ('availabilityStatus' in result) {
      if (result.availabilityStatus === 'prepared') {
        return {
          status: 'prepared', attachment: result.attachment, sourceToken: result.sourceToken,
          sha256: result.sha256, size: result.size,
        };
      }
      return { status: 'unrecoverable', attachment: result.attachment };
    }
    return { status: 'available', attachment: result };
  } : undefined;

  return {
    ensureAttachmentAvailableDetailed,
    ensureAttachmentAvailable,
    ...(prepareAttachmentAvailableDetailed ? { prepareAttachmentAvailableDetailed } : {}),
  };
};

export type MobileAttachmentAvailability = ReturnType<typeof createMobileAttachmentAvailability>;
