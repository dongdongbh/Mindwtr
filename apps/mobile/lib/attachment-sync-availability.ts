import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
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
  extractExtension,
  fileExists,
  findSafEntry,
  getAttachmentsDir,
  getBaseSyncUrl,
  getCloudBaseUrl,
  getDropboxClientId,
  isContentAttachmentUri,
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
  const existing = await fileExists(targetUri);
  if (existing) {
    return { ...attachment, uri: targetUri, localStatus: 'available' };
  }

  try {
    if (syncDir.type === 'file') {
      const sourceUri = `${syncDir.attachmentsDirUri}${filename}`;
      const exists = await fileExists(sourceUri);
      if (!exists) return null;
      await copyFileSafely(sourceUri, targetUri);
      return { ...attachment, uri: targetUri, localStatus: 'available' };
    }
    const entry = await findSafEntry(syncDir.attachmentsDirUri, filename);
    if (!entry || !StorageAccessFramework?.readAsStringAsync) return null;
    const base64 = await StorageAccessFramework.readAsStringAsync(entry, { encoding: FileSystem.EncodingType.Base64 });
    await writeBytesSafely(targetUri, base64ToBytes(base64));
    return { ...attachment, uri: targetUri, localStatus: 'available' };
  } catch (error) {
    logAttachmentWarn(`Failed to copy attachment ${attachment.title} from sync folder`, error);
    return null;
  }
};

const ensureAttachmentAvailableInternal = async (attachment: Attachment): Promise<Attachment | null> => {
  if (attachment.kind !== 'file') return attachment;
  const uri = attachment.uri || '';
  if (uri && (isHttpAttachmentUri(uri) || isContentAttachmentUri(uri))) {
    return { ...attachment, localStatus: 'available' };
  }

  if (uri) {
    const exists = await fileExists(uri);
    if (exists) {
      return { ...attachment, localStatus: 'available' };
    }
  }

  const backend = await AsyncStorage.getItem(SYNC_BACKEND_KEY);
  if (backend === 'file') {
    const syncPath = await AsyncStorage.getItem(SYNC_PATH_KEY);
    if (syncPath) {
      const resolved = await ensureFileAttachmentAvailable(attachment, syncPath);
      if (resolved) return resolved;
    }
    return null;
  }

  if (backend === 'cloud' && attachment.cloudKey) {
    const attachmentsDir = await getAttachmentsDir();
    if (!attachmentsDir) return null;
    const filename = attachment.cloudKey.split('/').pop() || `${attachment.id}${extractExtension(attachment.title)}`;
    const targetUri = `${attachmentsDir}${filename}`;
    const existing = await fileExists(targetUri);
    if (existing) {
      return { ...attachment, uri: targetUri, localStatus: 'available' };
    }
    const cloudProvider = ((await AsyncStorage.getItem(CLOUD_PROVIDER_KEY)) || '').trim();
    if (cloudProvider === CLOUD_PROVIDER_DROPBOX) {
      const dropboxClientId = await getDropboxClientId();
      if (!dropboxClientId) return null;
      try {
        const data = await runDropboxAuthorized(
          dropboxClientId,
          (accessToken) => downloadDropboxFile(accessToken, attachment.cloudKey as string),
        );
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer);
        await validateAttachmentHash(attachment, bytes);
        await writeBytesSafely(targetUri, bytes);
        reportProgress(attachment.id, 'download', bytes.length, bytes.length, 'completed');
        return { ...attachment, uri: targetUri, localStatus: 'available' };
      } catch (error) {
        reportProgress(
          attachment.id,
          'download',
          0,
          attachment.size ?? 0,
          'failed',
          error instanceof Error ? error.message : String(error)
        );
        logAttachmentWarn(`Failed to download attachment ${attachment.title}`, error);
        return null;
      }
    }
    const config = await loadCloudConfig();
    if (!config?.url) return null;
    const baseSyncUrl = getCloudBaseUrl(config.url);
    try {
      const data = await withRetry(() =>
        cloudGetFile(`${baseSyncUrl}/${attachment.cloudKey}`, {
          token: config.token,
          onProgress: (loaded, total) => reportProgress(attachment.id, 'download', loaded, total, 'active'),
        })
      );
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer);
      await validateAttachmentHash(attachment, bytes);
      await writeBytesSafely(targetUri, bytes);
      reportProgress(attachment.id, 'download', bytes.length, bytes.length, 'completed');
      return { ...attachment, uri: targetUri, localStatus: 'available' };
    } catch (error) {
      reportProgress(
        attachment.id,
        'download',
        0,
        attachment.size ?? 0,
        'failed',
        error instanceof Error ? error.message : String(error)
      );
      logAttachmentWarn(`Failed to download attachment ${attachment.title}`, error);
      return null;
    }
  }

  if (attachment.cloudKey) {
    const config = await loadWebDavConfig();
    if (!config?.url) return null;
    const baseSyncUrl = getBaseSyncUrl(config.url);
    const attachmentsDir = await getAttachmentsDir();
    if (!attachmentsDir) return null;
    const filename = attachment.cloudKey.split('/').pop() || `${attachment.id}${extractExtension(attachment.title)}`;
    const targetUri = `${attachmentsDir}${filename}`;
    const existing = await fileExists(targetUri);
    if (existing) {
      return { ...attachment, uri: targetUri, localStatus: 'available' };
    }
    try {
      const data = await withRetry(() =>
        webdavGetFile(`${baseSyncUrl}/${attachment.cloudKey}`, {
          username: config.username,
          password: config.password,
          onProgress: (loaded, total) => reportProgress(attachment.id, 'download', loaded, total, 'active'),
        })
      );
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer);
      await validateAttachmentHash(attachment, bytes);
      await writeBytesSafely(targetUri, bytes);
      reportProgress(attachment.id, 'download', bytes.length, bytes.length, 'completed');
      return { ...attachment, uri: targetUri, localStatus: 'available' };
    } catch (error) {
      reportProgress(
        attachment.id,
        'download',
        0,
        attachment.size ?? 0,
        'failed',
        error instanceof Error ? error.message : String(error)
      );
      logAttachmentWarn(`Failed to download attachment ${attachment.title}`, error);
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
