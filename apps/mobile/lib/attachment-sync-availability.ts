import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from './file-system';
import type { Attachment } from '@mindwtr/core';
import {
  cloudGetFile,
  isSha256Hex,
  parseCloudKitAttachmentKey,
  validateAttachmentHash,
  webdavGetFile,
  withRetry,
} from '@mindwtr/core';
import { downloadDropboxFile } from './dropbox-sync';
import {
  CLOUD_PROVIDER_KEY,
  SYNC_BACKEND_KEY,
  SYNC_PATH_KEY,
} from './sync-constants';
import {
  base64ToBytes,
  CLOUD_PROVIDER_DROPBOX,
  ensureAttachmentStoredLocally,
  extractExtension,
  findSafEntry,
  getAttachmentsDir,
  getBaseSyncUrl,
  getCloudBaseUrl,
  getDropboxClientId,
  getLocalAttachmentPresence,
  isHttpAttachmentUri,
  loadCloudConfig,
  loadWebDavConfig,
  logAttachmentWarn,
  readFileAsBytes,
  reportProgress,
  resolveFileSyncDir,
  runDropboxAuthorized,
  StorageAccessFramework,
} from './attachment-sync-utils';
import { getMobileCloudRequestOptions, getMobileWebDavRequestOptions } from './webdav-request-options';
import {
  createAttachmentDownloadStagePath,
  deleteAttachmentDownloadStageBestEffort,
  installAttachmentDownloadBytes,
  installStagedAttachmentDownload,
  openAttachmentBytesFromDownload,
} from './attachment-sync-backends/common';
import { fetchCloudKitAttachmentAsset } from './cloudkit-sync';
import { getSyncEncryptionMaterial } from './sync-encryption-state';

export type AttachmentAvailabilityOutcome =
  | { status: 'available'; attachment: Attachment }
  | { status: 'generation-conflict' }
  | { status: 'unavailable' };

const GENERATION_CONFLICT = Symbol('attachment-generation-conflict');
type InternalAvailabilityOutcome = Attachment | null | typeof GENERATION_CONFLICT;

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

const downloadLocks = new Map<string, Promise<AttachmentAvailabilityOutcome>>();

/** A managed target left by a prior attempt is usable only when its bytes prove
 * they are the current remote generation. Without a remote hash there is no safe
 * way to distinguish a crash retry from a stale generation that won the absent CAS. */
const resolveMatchingManagedTarget = async (
  attachment: Attachment,
  targetUri: string,
): Promise<InternalAvailabilityOutcome> => {
  if (!isSha256Hex(attachment.fileHash)) return GENERATION_CONFLICT;
  try {
    await validateAttachmentHash(attachment, await readFileAsBytes(targetUri));
    return { ...attachment, uri: targetUri, localStatus: 'available' };
  } catch (error) {
    logAttachmentWarn(`Managed attachment ${attachment.id} does not match the requested generation`, error);
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
): Promise<InternalAvailabilityOutcome> => {
  const installed = await installAttachmentDownloadBytes(
    attachment,
    attachmentsDir,
    targetUri,
    bytes,
    { kind: 'absent' },
  );
  if (!installed) return GENERATION_CONFLICT;
  return { ...attachment, uri: targetUri, localStatus: 'available' };
};

const ensureFileAttachmentAvailable = async (
  attachment: Attachment,
  syncPath: string
): Promise<InternalAvailabilityOutcome> => {
  const syncDir = await resolveFileSyncDir(syncPath);
  if (!syncDir) return null;
  if (!attachment.cloudKey) return null;
  const attachmentsDir = await getAttachmentsDir();
  if (!attachmentsDir) return null;
  const filename = attachment.cloudKey.split('/').pop() || `${attachment.id}${extractExtension(attachment.title)}`;
  const targetUri = `${attachmentsDir}${filename}`;
  const targetPresence = await getLocalAttachmentPresence(targetUri);
  if (targetPresence === 'unreadable') return null;
  if (targetPresence === 'present') {
    return resolveMatchingManagedTarget(attachment, targetUri);
  }

  try {
    // #1056: the local attachments directory always holds plaintext, so an encrypted
    // sync folder's bytes are opened on the way in. `null` material keeps the
    // byte-for-byte pre-feature behavior. Inside the try: S3 — an enabled-but-no-key
    // device throws instead of
    // returning `null`, and that must fail this fetch closed (logged, `null` result),
    // never fall through to a plaintext path as if encryption were off.
    const material = await getSyncEncryptionMaterial();
    if (syncDir.type === 'file') {
      const sourceUri = `${syncDir.attachmentsDirUri}${filename}`;
      const sourcePresence = await getLocalAttachmentPresence(sourceUri);
      if (sourcePresence !== 'present') return null;
      const sourceBytes = await readFileAsBytes(sourceUri);
      const bytes = await openAttachmentBytesFromDownload(sourceBytes, material);
      return await installMissingAttachmentBytes(attachment, attachmentsDir, targetUri, bytes);
    }
    const entry = await findSafEntry(syncDir.attachmentsDirUri, filename);
    if (!entry || !StorageAccessFramework?.readAsStringAsync) return null;
    const base64 = await StorageAccessFramework.readAsStringAsync(entry, { encoding: FileSystem.EncodingType.Base64 });
    const bytes = await openAttachmentBytesFromDownload(base64ToBytes(base64), material);
    return await installMissingAttachmentBytes(attachment, attachmentsDir, targetUri, bytes);
  } catch (error) {
    logAttachmentWarn(`Failed to make attachment ${attachment.id} available from sync folder`, error);
    return null;
  }
};

const ensureCloudKitAttachmentAvailable = async (
  attachment: Attachment,
): Promise<InternalAvailabilityOutcome> => {
  const recordName = parseCloudKitAttachmentKey(attachment.cloudKey);
  if (!recordName) return null;
  const attachmentsDir = await getAttachmentsDir();
  if (!attachmentsDir) return null;
  const extension = extractExtension(attachment.title) || extractExtension(attachment.uri);
  const targetUri = `${attachmentsDir}${attachment.id}${extension}`;
  const targetPresence = await getLocalAttachmentPresence(targetUri);
  if (targetPresence === 'unreadable') return null;
  if (targetPresence === 'present') {
    return resolveMatchingManagedTarget(attachment, targetUri);
  }

  const stagedUri = createAttachmentDownloadStagePath(attachmentsDir, attachment);
  let installerOwnsStage = false;
  try {
    reportProgress(attachment.id, 'download', 0, attachment.size ?? 0, 'active');
    await fetchCloudKitAttachmentAsset(recordName, stagedUri);
    installerOwnsStage = true;
    const installed = await installStagedAttachmentDownload({
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
      await deleteAttachmentDownloadStageBestEffort(stagedUri);
    }
    reportProgress(
      attachment.id,
      'download',
      0,
      attachment.size ?? 0,
      'failed',
      error instanceof Error ? error.message : String(error),
    );
    logAttachmentWarn(`Failed to download CloudKit attachment ${attachment.id}`, error);
    return null;
  }
};

const ensureAttachmentAvailableInternal = async (
  attachment: Attachment,
): Promise<InternalAvailabilityOutcome> => {
  if (attachment.kind !== 'file') return attachment;
  const localAttachment = { ...attachment };
  const uri = localAttachment.uri || '';
  if (uri && isHttpAttachmentUri(uri)) {
    return { ...localAttachment, localStatus: 'available' };
  }

  if (uri) {
    const sourcePresence = await getLocalAttachmentPresence(uri);
    if (sourcePresence === 'unreadable') return null;
    if (sourcePresence === 'present') {
      if (await ensureAttachmentStoredLocally(localAttachment)) {
        return localAttachment;
      }
      return { ...localAttachment, localStatus: 'available' };
    }
  }

  const backend = await AsyncStorage.getItem(SYNC_BACKEND_KEY);
  if (backend === 'file') {
    const syncPath = await AsyncStorage.getItem(SYNC_PATH_KEY);
    if (syncPath) {
      const resolved = await ensureFileAttachmentAvailable(localAttachment, syncPath);
      if (resolved) return resolved;
    }
    return null;
  }

  if (backend === 'cloudkit') {
    return ensureCloudKitAttachmentAvailable(localAttachment);
  }

  if (backend === 'cloud' && localAttachment.cloudKey) {
    const attachmentsDir = await getAttachmentsDir();
    if (!attachmentsDir) return null;
    const filename = localAttachment.cloudKey.split('/').pop() || `${localAttachment.id}${extractExtension(localAttachment.title)}`;
    const targetUri = `${attachmentsDir}${filename}`;
    const targetPresence = await getLocalAttachmentPresence(targetUri);
    if (targetPresence === 'unreadable') return null;
    if (targetPresence === 'present') {
      return resolveMatchingManagedTarget(localAttachment, targetUri);
    }
    const cloudProvider = ((await AsyncStorage.getItem(CLOUD_PROVIDER_KEY)) || '').trim();
    if (cloudProvider === CLOUD_PROVIDER_DROPBOX) {
      const dropboxClientId = await getDropboxClientId();
      if (!dropboxClientId) return null;
      try {
        const data = await runDropboxAuthorized(
          dropboxClientId,
          (accessToken) => downloadDropboxFile(accessToken, localAttachment.cloudKey as string),
        );
        const bytes = await openAttachmentBytesFromDownload(
          data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer),
          await getSyncEncryptionMaterial(),
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
        reportProgress(
          localAttachment.id,
          'download',
          0,
          localAttachment.size ?? 0,
          'failed',
          error instanceof Error ? error.message : String(error)
        );
        logAttachmentWarn(`Failed to download attachment ${localAttachment.id}`, error);
        return null;
      }
    }
    const config = await loadCloudConfig();
    if (!config?.url) return null;
    const baseSyncUrl = getCloudBaseUrl(config.url);
    try {
      const data = await withRetry(() =>
        cloudGetFile(`${baseSyncUrl}/${localAttachment.cloudKey}`, {
          ...getMobileCloudRequestOptions(config.allowInsecureHttp),
          token: config.token,
          onProgress: (loaded, total) => reportProgress(localAttachment.id, 'download', loaded, total, 'active'),
        })
      );
      const bytes = await openAttachmentBytesFromDownload(
        data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer),
        await getSyncEncryptionMaterial(),
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
      reportProgress(
        localAttachment.id,
        'download',
        0,
        localAttachment.size ?? 0,
        'failed',
        error instanceof Error ? error.message : String(error)
      );
      logAttachmentWarn(`Failed to download attachment ${localAttachment.id}`, error);
      return null;
    }
  }

  if (localAttachment.cloudKey) {
    const config = await loadWebDavConfig();
    if (!config?.url) return null;
    const baseSyncUrl = getBaseSyncUrl(config.url);
    const attachmentsDir = await getAttachmentsDir();
    if (!attachmentsDir) return null;
    const filename = localAttachment.cloudKey.split('/').pop() || `${localAttachment.id}${extractExtension(localAttachment.title)}`;
    const targetUri = `${attachmentsDir}${filename}`;
    const targetPresence = await getLocalAttachmentPresence(targetUri);
    if (targetPresence === 'unreadable') return null;
    if (targetPresence === 'present') {
      return resolveMatchingManagedTarget(localAttachment, targetUri);
    }
    try {
      const data = await withRetry(() =>
        webdavGetFile(`${baseSyncUrl}/${localAttachment.cloudKey}`, {
          ...getMobileWebDavRequestOptions(config.allowInsecureHttp),
          username: config.username,
          password: config.password,
          onProgress: (loaded, total) => reportProgress(localAttachment.id, 'download', loaded, total, 'active'),
        })
      );
      const bytes = await openAttachmentBytesFromDownload(
        data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer),
        await getSyncEncryptionMaterial(),
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
      reportProgress(
        localAttachment.id,
        'download',
        0,
        localAttachment.size ?? 0,
        'failed',
        error instanceof Error ? error.message : String(error)
      );
      logAttachmentWarn(`Failed to download attachment ${localAttachment.id}`, error);
      return null;
    }
  }

  return null;
};

export const ensureAttachmentAvailableDetailed = async (
  attachment: Attachment,
): Promise<AttachmentAvailabilityOutcome> => {
  if (attachment.kind !== 'file') return { status: 'available', attachment };
  const identity = getAttachmentDownloadIdentity(attachment);
  const existing = downloadLocks.get(identity);
  if (existing) return existing;
  const downloadPromise = ensureAttachmentAvailableInternal(attachment).then((result): AttachmentAvailabilityOutcome => {
    if (result === GENERATION_CONFLICT) return { status: 'generation-conflict' };
    if (!result) return { status: 'unavailable' };
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
export const ensureAttachmentAvailable = async (attachment: Attachment): Promise<Attachment | null> => {
  const outcome = await ensureAttachmentAvailableDetailed(attachment);
  return outcome.status === 'available' ? outcome.attachment : null;
};
