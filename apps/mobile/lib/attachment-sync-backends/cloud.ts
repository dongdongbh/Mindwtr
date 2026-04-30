import type { AppData } from '@mindwtr/core';
import { cloudPutFile, validateAttachmentForUpload } from '@mindwtr/core';
import { logAttachmentWarn } from '../attachment-sync-utils';
import {
  buildCloudKey,
  collectAttachments,
  DEFAULT_CONTENT_TYPE,
  fileExists,
  getAttachmentByteSize,
  getAttachmentLocalStatus,
  getAttachmentsDir,
  isHttpAttachmentUri,
  markAttachmentUnrecoverable,
  readAttachmentBytesForUpload,
  reportProgress,
  toArrayBuffer,
  type CloudConfig,
} from '../attachment-sync-utils';
import { uploadCloudFileWithFileSystem } from './common';

export const syncCloudAttachments = async (
  appData: AppData,
  cloudConfig: CloudConfig,
  baseSyncUrl: string
): Promise<boolean> => {
  await getAttachmentsDir();

  const attachmentsById = collectAttachments(appData);

  let didMutate = false;
  for (const attachment of attachmentsById.values()) {
    if (attachment.kind !== 'file') continue;
    if (attachment.deletedAt) continue;

    const uri = attachment.uri || '';
    const isHttp = isHttpAttachmentUri(uri);
    const hasLocalPath = Boolean(uri) && !isHttp;
    const existsLocally = hasLocalPath ? await fileExists(uri) : false;
    const nextStatus = getAttachmentLocalStatus(uri, existsLocally);
    if (attachment.localStatus !== nextStatus) {
      attachment.localStatus = nextStatus;
      didMutate = true;
    }

    if (!attachment.cloudKey && hasLocalPath && existsLocally && !isHttp) {
      let localReadFailed = false;
      try {
        let fileSize = await getAttachmentByteSize(attachment, uri);
        let fileData: Uint8Array | null = null;
        if (!Number.isFinite(fileSize ?? NaN)) {
          const readResult = await readAttachmentBytesForUpload(uri);
          if (readResult.readFailed) {
            localReadFailed = true;
            throw readResult.error;
          }
          fileData = readResult.data;
          fileSize = fileData.byteLength;
        }

        const validation = await validateAttachmentForUpload(attachment, fileSize);
        if (!validation.valid) {
          logAttachmentWarn(`Attachment validation failed (${validation.error}) for ${attachment.title}`);
          continue;
        }
        const totalBytes = Math.max(0, Number(fileSize ?? 0));
        reportProgress(attachment.id, 'upload', 0, totalBytes, 'active');
        const cloudKey = buildCloudKey(attachment);
        const uploadUrl = `${baseSyncUrl}/${cloudKey}`;
        const uploadedWithFileSystem = await uploadCloudFileWithFileSystem(
          uploadUrl,
          uri,
          attachment.mimeType || DEFAULT_CONTENT_TYPE,
          cloudConfig.token,
          (loaded, total) => reportProgress(attachment.id, 'upload', loaded, total, 'active'),
          totalBytes
        );
        if (!uploadedWithFileSystem) {
          let uploadBytes = fileData;
          if (!uploadBytes) {
            const readResult = await readAttachmentBytesForUpload(uri);
            if (readResult.readFailed) {
              localReadFailed = true;
              throw readResult.error;
            }
            uploadBytes = readResult.data;
          }
          const buffer = toArrayBuffer(uploadBytes);
          await cloudPutFile(
            uploadUrl,
            buffer,
            attachment.mimeType || DEFAULT_CONTENT_TYPE,
            { token: cloudConfig.token }
          );
        }
        attachment.cloudKey = cloudKey;
        if (!Number.isFinite(attachment.size ?? NaN) && Number.isFinite(fileSize ?? NaN)) {
          attachment.size = Number(fileSize);
        }
        attachment.localStatus = 'available';
        didMutate = true;
        reportProgress(attachment.id, 'upload', totalBytes, totalBytes, 'completed');
      } catch (error) {
        if (localReadFailed) {
          if (markAttachmentUnrecoverable(attachment)) {
            didMutate = true;
          }
          logAttachmentWarn(`Attachment local file is unreadable; marking unrecoverable (${attachment.title})`, error);
        }
        reportProgress(
          attachment.id,
          'upload',
          0,
          attachment.size ?? 0,
          'failed',
          error instanceof Error ? error.message : String(error)
        );
        logAttachmentWarn(`Failed to upload attachment ${attachment.title}`, error);
      }
    }
  }

  return didMutate;
};
