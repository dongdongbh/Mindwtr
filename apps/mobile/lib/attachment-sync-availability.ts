import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from './file-system';
import type { Attachment } from '@mindwtr/core';
import { cloudGetFile, webdavGetFile, withRetry } from '@mindwtr/core';
import { downloadDropboxFile } from './dropbox-sync';
import {
  CLOUD_PROVIDER_KEY,
  SYNC_BACKEND_KEY,
  SYNC_PATH_KEY,
} from './sync-constants';
import {
  base64ToBytes,
  CLOUD_PROVIDER_DROPBOX,
  copyFileSafely,
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
  reportProgress,
  resolveFileSyncDir,
  runDropboxAuthorized,
  StorageAccessFramework,
  validateAttachmentHash,
  writeBytesSafely,
} from './attachment-sync-utils';
import { getMobileCloudRequestOptions, getMobileWebDavRequestOptions } from './webdav-request-options';
import { openAttachmentBytesFromDownload } from './attachment-sync-backends/common';
import { readSyncArtifactBytes } from './storage-file-encryption';
import { getSyncEncryptionMaterial } from './sync-encryption-state';

const downloadLocks = new Map<string, Promise<Attachment | null>>();

const ensureFileAttachmentAvailable = async (
  attachment: Attachment,
  syncPath: string
): Promise<Attachment | null> => {
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
    return { ...attachment, uri: targetUri, localStatus: 'available' };
  }

  try {
    // #1056: the local attachments directory always holds plaintext, so an encrypted
    // sync folder's bytes are opened on the way in. `null` material keeps the
    // byte-for-byte pre-feature behavior, including the plain `copyFileSafely` fast
    // path. Inside the try: S3 — an `enabled`-but-no-key device throws instead of
    // returning `null`, and that must fail this fetch closed (logged, `null` result),
    // never fall through to the plaintext `copyFileSafely` path as if encryption were off.
    const material = await getSyncEncryptionMaterial();
    if (syncDir.type === 'file') {
      const sourceUri = `${syncDir.attachmentsDirUri}${filename}`;
      const sourcePresence = await getLocalAttachmentPresence(sourceUri);
      if (sourcePresence !== 'present') return null;
      if (!material) {
        await copyFileSafely(sourceUri, targetUri);
        return { ...attachment, uri: targetUri, localStatus: 'available' };
      }
      const sourceBytes = await readSyncArtifactBytes(sourceUri);
      if (!sourceBytes) return null;
      await writeBytesSafely(targetUri, await openAttachmentBytesFromDownload(sourceBytes, material));
      return { ...attachment, uri: targetUri, localStatus: 'available' };
    }
    const entry = await findSafEntry(syncDir.attachmentsDirUri, filename);
    if (!entry || !StorageAccessFramework?.readAsStringAsync) return null;
    const base64 = await StorageAccessFramework.readAsStringAsync(entry, { encoding: FileSystem.EncodingType.Base64 });
    await writeBytesSafely(targetUri, await openAttachmentBytesFromDownload(base64ToBytes(base64), material));
    return { ...attachment, uri: targetUri, localStatus: 'available' };
  } catch (error) {
    logAttachmentWarn(`Failed to copy attachment ${attachment.id} from sync folder`, error);
    return null;
  }
};

const ensureAttachmentAvailableInternal = async (attachment: Attachment): Promise<Attachment | null> => {
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

  if (backend === 'cloud' && localAttachment.cloudKey) {
    const attachmentsDir = await getAttachmentsDir();
    if (!attachmentsDir) return null;
    const filename = localAttachment.cloudKey.split('/').pop() || `${localAttachment.id}${extractExtension(localAttachment.title)}`;
    const targetUri = `${attachmentsDir}${filename}`;
    const targetPresence = await getLocalAttachmentPresence(targetUri);
    if (targetPresence === 'unreadable') return null;
    if (targetPresence === 'present') {
      return { ...localAttachment, uri: targetUri, localStatus: 'available' };
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
        await validateAttachmentHash(localAttachment, bytes);
        await writeBytesSafely(targetUri, bytes);
        reportProgress(localAttachment.id, 'download', bytes.length, bytes.length, 'completed');
        return { ...localAttachment, uri: targetUri, localStatus: 'available' };
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
      await validateAttachmentHash(localAttachment, bytes);
      await writeBytesSafely(targetUri, bytes);
      reportProgress(localAttachment.id, 'download', bytes.length, bytes.length, 'completed');
      return { ...localAttachment, uri: targetUri, localStatus: 'available' };
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
      return { ...localAttachment, uri: targetUri, localStatus: 'available' };
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
      await validateAttachmentHash(localAttachment, bytes);
      await writeBytesSafely(targetUri, bytes);
      reportProgress(localAttachment.id, 'download', bytes.length, bytes.length, 'completed');
      return { ...localAttachment, uri: targetUri, localStatus: 'available' };
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

export const ensureAttachmentAvailable = async (attachment: Attachment): Promise<Attachment | null> => {
  if (attachment.kind !== 'file') return attachment;
  const existing = downloadLocks.get(attachment.id);
  if (existing) return existing;
  const downloadPromise = ensureAttachmentAvailableInternal(attachment);
  downloadLocks.set(attachment.id, downloadPromise);
  try {
    return await downloadPromise;
  } finally {
    downloadLocks.delete(attachment.id);
  }
};
