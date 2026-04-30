import type { AppData } from '@mindwtr/core';
import { validateAttachmentForUpload } from '@mindwtr/core';
import * as FileSystem from '../file-system';
import {
  buildCloudKey,
  bytesToBase64,
  collectAttachments,
  copyFileSafely,
  DEFAULT_CONTENT_TYPE,
  extractExtension,
  FILE_BACKEND_VALIDATION_CONFIG,
  fileExists,
  findSafEntry,
  getAttachmentByteSize,
  getAttachmentLocalStatus,
  getAttachmentsDir,
  isContentAttachmentUri,
  isHttpAttachmentUri,
  logAttachmentWarn,
  readFileAsBytes,
  resolveFileSyncDir,
  StorageAccessFramework,
  writeBytesSafely,
} from '../attachment-sync-utils';

export const syncFileAttachments = async (
  appData: AppData,
  syncPath: string
): Promise<boolean> => {
  const syncDir = await resolveFileSyncDir(syncPath);
  if (!syncDir) return false;

  const attachmentsDir = await getAttachmentsDir();
  if (!attachmentsDir) return false;

  const attachmentsById = collectAttachments(appData);

  let didMutate = false;
  for (const attachment of attachmentsById.values()) {
    if (attachment.kind !== 'file') continue;
    if (attachment.deletedAt) continue;

    const uri = attachment.uri || '';
    const isHttp = isHttpAttachmentUri(uri);
    const hasLocal = Boolean(uri) && !isHttp;
    const existsLocally = hasLocal ? await fileExists(uri) : false;
    const nextStatus = getAttachmentLocalStatus(uri, existsLocally);
    if (attachment.localStatus !== nextStatus) {
      attachment.localStatus = nextStatus;
      didMutate = true;
    }

    if (hasLocal && existsLocally && !isHttp) {
      const cloudKey = attachment.cloudKey || buildCloudKey(attachment);
      const filename = cloudKey.split('/').pop() || `${attachment.id}${extractExtension(attachment.title)}`;
      let remoteExists = false;
      if (syncDir.type === 'file') {
        const targetUri = `${syncDir.attachmentsDirUri}${filename}`;
        remoteExists = await fileExists(targetUri);
      } else {
        remoteExists = Boolean(await findSafEntry(syncDir.attachmentsDirUri, filename));
      }
      if (!remoteExists) {
        try {
          const size = await getAttachmentByteSize(attachment, uri);
          if (size != null) {
            const validation = await validateAttachmentForUpload(attachment, size, FILE_BACKEND_VALIDATION_CONFIG);
            if (!validation.valid) {
              logAttachmentWarn(`Attachment validation failed (${validation.error}) for ${attachment.title}`);
              continue;
            }
          }
          if (syncDir.type === 'file') {
            const targetUri = `${syncDir.attachmentsDirUri}${filename}`;
            if (isContentAttachmentUri(uri)) {
              const bytes = await readFileAsBytes(uri);
              await writeBytesSafely(targetUri, bytes);
            } else {
              await copyFileSafely(uri, targetUri);
            }
          } else {
            const base64 = await readFileAsBytes(uri).then(bytesToBase64);
            let targetUri = await findSafEntry(syncDir.attachmentsDirUri, filename);
            if (!targetUri && StorageAccessFramework?.createFileAsync) {
              targetUri = await StorageAccessFramework.createFileAsync(syncDir.attachmentsDirUri, filename, attachment.mimeType || DEFAULT_CONTENT_TYPE);
            }
            if (targetUri && StorageAccessFramework?.writeAsStringAsync) {
              await StorageAccessFramework.writeAsStringAsync(targetUri, base64, { encoding: FileSystem.EncodingType.Base64 });
            }
          }
        } catch (error) {
          logAttachmentWarn(`Failed to copy attachment ${attachment.title} to sync folder`, error);
          continue;
        }
      }
      if (!attachment.cloudKey) {
        attachment.cloudKey = cloudKey;
        attachment.localStatus = 'available';
        didMutate = true;
      }
    }
  }

  return didMutate;
};
