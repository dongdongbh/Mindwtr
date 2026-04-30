import type { AppData, Attachment } from '@mindwtr/core';
import { validateAttachmentForUpload } from '@mindwtr/core';
import {
  DropboxFileNotFoundError,
  downloadDropboxFile,
  uploadDropboxFile,
} from '../dropbox-sync';
import {
  buildCloudKey,
  collectAttachments,
  DEFAULT_CONTENT_TYPE,
  DROPBOX_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC,
  DROPBOX_ATTACHMENT_MAX_UPLOADS_PER_SYNC,
  extractExtension,
  fileExists,
  getAttachmentByteSize,
  getAttachmentLocalStatus,
  getAttachmentsDir,
  isContentAttachmentUri,
  isHttpAttachmentUri,
  logAttachmentInfo,
  logAttachmentWarn,
  markAttachmentUnrecoverable,
  readAttachmentBytesForUpload,
  reportProgress,
  runDropboxAuthorized,
  toArrayBuffer,
  validateAttachmentHash,
  writeBytesSafely,
} from '../attachment-sync-utils';

export const syncDropboxAttachments = async (
  appData: AppData,
  dropboxClientId: string,
  fetcher: typeof fetch = fetch
): Promise<boolean> => {
  if (!dropboxClientId) return false;
  const attachmentsDir = await getAttachmentsDir();
  const attachmentsById = collectAttachments(appData);

  let didMutate = false;
  const downloadQueue: Attachment[] = [];
  let uploadCount = 0;
  let uploadLimitLogged = false;

  for (const attachment of attachmentsById.values()) {
    if (attachment.kind !== 'file') continue;
    if (attachment.deletedAt) continue;

    const uri = attachment.uri || '';
    const isHttp = isHttpAttachmentUri(uri);
    const isContent = isContentAttachmentUri(uri);
    const hasLocalPath = Boolean(uri) && !isHttp;
    const existsLocally = hasLocalPath ? await fileExists(uri) : false;
    const nextStatus = getAttachmentLocalStatus(uri, existsLocally);
    if (attachment.localStatus !== nextStatus) {
      attachment.localStatus = nextStatus;
      didMutate = true;
    }

    if (!attachment.cloudKey && hasLocalPath && existsLocally && !isHttp) {
      if (uploadCount >= DROPBOX_ATTACHMENT_MAX_UPLOADS_PER_SYNC) {
        if (!uploadLimitLogged) {
          uploadLimitLogged = true;
          logAttachmentInfo('Dropbox attachment upload limit reached', {
            limit: String(DROPBOX_ATTACHMENT_MAX_UPLOADS_PER_SYNC),
          });
        }
        continue;
      }
      uploadCount += 1;
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
        let uploadBytes = fileData;
        if (!uploadBytes) {
          const readResult = await readAttachmentBytesForUpload(uri);
          if (readResult.readFailed) {
            localReadFailed = true;
            throw readResult.error;
          }
          uploadBytes = readResult.data;
        }
        await runDropboxAuthorized(
          dropboxClientId,
          (accessToken) =>
            uploadDropboxFile(
              accessToken,
              cloudKey,
              toArrayBuffer(uploadBytes),
              attachment.mimeType || DEFAULT_CONTENT_TYPE,
              fetcher
            ),
          fetcher
        );

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

    if (attachment.cloudKey && !existsLocally && !isContent && !isHttp) {
      downloadQueue.push(attachment);
    }
  }

  if (!attachmentsDir) return didMutate;

  let downloadCount = 0;
  for (const attachment of downloadQueue) {
    if (attachment.kind !== 'file') continue;
    if (attachment.deletedAt) continue;
    if (!attachment.cloudKey) continue;
    if (downloadCount >= DROPBOX_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC) {
      logAttachmentInfo('Dropbox attachment download limit reached', {
        limit: String(DROPBOX_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC),
      });
      break;
    }
    downloadCount += 1;

    const cloudKey = attachment.cloudKey;
    try {
      reportProgress(attachment.id, 'download', 0, attachment.size ?? 0, 'active');
      const data = await runDropboxAuthorized(
        dropboxClientId,
        (accessToken) => downloadDropboxFile(accessToken, cloudKey, fetcher),
        fetcher
      );
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer);
      await validateAttachmentHash(attachment, bytes);
      const filename = cloudKey.split('/').pop() || `${attachment.id}${extractExtension(attachment.title)}`;
      const targetUri = `${attachmentsDir}${filename}`;
      await writeBytesSafely(targetUri, bytes);
      if (attachment.uri !== targetUri || attachment.localStatus !== 'available') {
        attachment.uri = targetUri;
        attachment.localStatus = 'available';
        didMutate = true;
      }
      reportProgress(attachment.id, 'download', bytes.length, bytes.length, 'completed');
    } catch (error) {
      if (error instanceof DropboxFileNotFoundError && attachment.cloudKey) {
        if (markAttachmentUnrecoverable(attachment)) {
          didMutate = true;
        }
      }
      if (!(error instanceof DropboxFileNotFoundError) && attachment.localStatus !== 'missing') {
        attachment.localStatus = 'missing';
        didMutate = true;
      }
      reportProgress(
        attachment.id,
        'download',
        0,
        attachment.size ?? 0,
        'failed',
        error instanceof Error ? error.message : String(error)
      );
      logAttachmentWarn(`Failed to download attachment ${attachment.title}`, error);
    }
  }

  return didMutate;
};
