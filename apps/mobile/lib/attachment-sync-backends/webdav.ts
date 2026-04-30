import type { AppData, Attachment } from '@mindwtr/core';
import {
  getErrorStatus,
  isWebdavRateLimitedError,
  validateAttachmentForUpload,
  webdavFileExists,
  webdavGetFile,
  webdavMakeDirectory,
  webdavPutFile,
  withRetry,
} from '@mindwtr/core';
import { sanitizeLogMessage } from '../app-log';
import {
  ATTACHMENTS_DIR_NAME,
  buildCloudKey,
  clearWebdavDownloadBackoff,
  collectAttachments,
  DEFAULT_CONTENT_TYPE,
  extractExtension,
  fileExists,
  getAttachmentByteSize,
  getAttachmentLocalStatus,
  getAttachmentsDir,
  getWebdavDownloadBackoff,
  isContentAttachmentUri,
  isHttpAttachmentUri,
  logAttachmentInfo,
  logAttachmentWarn,
  markAttachmentUnrecoverable,
  pruneWebdavDownloadBackoff,
  readAttachmentBytesForUpload,
  reportProgress,
  setWebdavDownloadBackoff,
  sleep,
  toArrayBuffer,
  type WebDavConfig,
  validateAttachmentHash,
  WEBDAV_ATTACHMENT_COOLDOWN_MS,
  WEBDAV_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC,
  WEBDAV_ATTACHMENT_MAX_UPLOADS_PER_SYNC,
  WEBDAV_ATTACHMENT_MIN_INTERVAL_MS,
  WEBDAV_ATTACHMENT_RETRY_OPTIONS,
  writeBytesSafely,
} from '../attachment-sync-utils';
import { MOBILE_WEBDAV_REQUEST_OPTIONS } from '../webdav-request-options';
import { uploadWebdavFileWithFileSystem } from './common';

export const syncWebdavAttachments = async (
  appData: AppData,
  webDavConfig: WebDavConfig,
  baseSyncUrl: string
): Promise<boolean> => {
  let lastRequestAt = 0;
  let blockedUntil = 0;
  const waitForSlot = async (): Promise<void> => {
    const now = Date.now();
    if (blockedUntil && now < blockedUntil) {
      throw new Error(`WebDAV rate limited for ${blockedUntil - now}ms`);
    }
    const elapsed = now - lastRequestAt;
    if (elapsed < WEBDAV_ATTACHMENT_MIN_INTERVAL_MS) {
      await sleep(WEBDAV_ATTACHMENT_MIN_INTERVAL_MS - elapsed);
    }
    lastRequestAt = Date.now();
  };
  const handleRateLimit = (error: unknown): boolean => {
    if (!isWebdavRateLimitedError(error)) return false;
    blockedUntil = Date.now() + WEBDAV_ATTACHMENT_COOLDOWN_MS;
    logAttachmentWarn('WebDAV rate limited; pausing attachment sync', error);
    return true;
  };

  const attachmentsDirUrl = `${baseSyncUrl}/${ATTACHMENTS_DIR_NAME}`;
  try {
    await webdavMakeDirectory(attachmentsDirUrl, {
      ...MOBILE_WEBDAV_REQUEST_OPTIONS,
      username: webDavConfig.username,
      password: webDavConfig.password,
    });
  } catch (error) {
    logAttachmentWarn('Failed to ensure WebDAV attachments directory', error);
  }

  const attachmentsDir = await getAttachmentsDir();
  const attachmentsById = collectAttachments(appData);

  pruneWebdavDownloadBackoff();

  logAttachmentInfo('WebDAV attachment sync start', {
    count: String(attachmentsById.size),
  });

  let didMutate = false;
  const downloadQueue: Attachment[] = [];
  let abortedByRateLimit = false;
  let uploadCount = 0;
  let uploadLimitLogged = false;
  for (const attachment of attachmentsById.values()) {
    if (attachment.kind !== 'file') continue;
    if (attachment.deletedAt) continue;
    if (abortedByRateLimit) break;

    const uri = attachment.uri || '';
    const isHttp = isHttpAttachmentUri(uri);
    const isContent = isContentAttachmentUri(uri);
    const hasLocalPath = Boolean(uri) && !isHttp;
    logAttachmentInfo('WebDAV attachment check', {
      id: attachment.id,
      title: attachment.title || 'attachment',
      uri,
      cloud: attachment.cloudKey ? 'set' : 'missing',
      localStatus: attachment.localStatus || '',
      uriKind: isHttp ? 'http' : (isContent ? 'content' : 'file'),
    });
    const existsStart = Date.now();
    const existsLocally = hasLocalPath ? await fileExists(uri) : false;
    logAttachmentInfo('WebDAV attachment exists check', {
      id: attachment.id,
      exists: existsLocally ? 'true' : 'false',
      ms: String(Date.now() - existsStart),
    });
    const nextStatus = getAttachmentLocalStatus(uri, existsLocally);
    if (attachment.localStatus !== nextStatus) {
      attachment.localStatus = nextStatus;
      didMutate = true;
    }
    if (existsLocally || isContent || isHttp) {
      clearWebdavDownloadBackoff(attachment.id);
    }

    if (attachment.cloudKey && hasLocalPath && existsLocally && !isHttp) {
      try {
        const remoteExists = await withRetry(
          async () => {
            await waitForSlot();
            return await webdavFileExists(`${baseSyncUrl}/${attachment.cloudKey}`, {
              ...MOBILE_WEBDAV_REQUEST_OPTIONS,
              username: webDavConfig.username,
              password: webDavConfig.password,
            });
          },
          WEBDAV_ATTACHMENT_RETRY_OPTIONS
        );
        logAttachmentInfo('WebDAV attachment remote exists', {
          id: attachment.id,
          exists: remoteExists ? 'true' : 'false',
        });
        if (!remoteExists) {
          attachment.cloudKey = undefined;
          clearWebdavDownloadBackoff(attachment.id);
          didMutate = true;
        }
      } catch (error) {
        if (handleRateLimit(error)) {
          abortedByRateLimit = true;
          break;
        }
        logAttachmentWarn('WebDAV attachment remote check failed', error);
      }
    }

    if (!attachment.cloudKey && !hasLocalPath) {
      logAttachmentInfo('Skip upload (no local uri)', {
        id: attachment.id,
        title: attachment.title || 'attachment',
      });
      continue;
    }
    if (hasLocalPath && !existsLocally && !isHttp && !isContent) {
      if (!attachment.cloudKey) {
        logAttachmentWarn(`Attachment file missing for ${attachment.title}`, new Error(`uri:${uri}`));
        continue;
      }
    }

    if (!attachment.cloudKey && hasLocalPath && existsLocally && !isHttp) {
      let localReadFailed = false;
      if (uploadCount >= WEBDAV_ATTACHMENT_MAX_UPLOADS_PER_SYNC) {
        if (!uploadLimitLogged) {
          logAttachmentInfo('WebDAV attachment upload limit reached', {
            limit: String(WEBDAV_ATTACHMENT_MAX_UPLOADS_PER_SYNC),
          });
          uploadLimitLogged = true;
        }
        continue;
      }
      uploadCount += 1;
      try {
        let size = await getAttachmentByteSize(attachment, uri);
        let fileData: Uint8Array | null = null;
        if (!Number.isFinite(size ?? NaN)) {
          const readResult = await readAttachmentBytesForUpload(uri);
          if (readResult.readFailed) {
            localReadFailed = true;
            throw readResult.error;
          }
          fileData = readResult.data;
          size = fileData.byteLength;
        }
        const validation = await validateAttachmentForUpload(attachment, size);
        if (!validation.valid) {
          logAttachmentWarn(`Attachment validation failed (${validation.error}) for ${attachment.title}`);
          continue;
        }
        const cloudKey = buildCloudKey(attachment);
        const startedAt = Date.now();
        const uploadBytes = Math.max(0, Number(size ?? 0));
        reportProgress(attachment.id, 'upload', 0, uploadBytes, 'active');
        const uploadUrl = `${baseSyncUrl}/${cloudKey}`;
        let uploadedWithFileSystem = false;
        if (uploadUrl) {
          logAttachmentInfo('WebDAV attachment upload start', {
            id: attachment.id,
            bytes: String(uploadBytes),
            cloudKey,
          });
          uploadedWithFileSystem = await withRetry(
            async () => {
              await waitForSlot();
              return await uploadWebdavFileWithFileSystem(
                uploadUrl,
                uri,
                attachment.mimeType || DEFAULT_CONTENT_TYPE,
                webDavConfig.username,
                webDavConfig.password,
                (loaded, total) => reportProgress(attachment.id, 'upload', loaded, total, 'active'),
                uploadBytes
              );
            },
            {
              ...WEBDAV_ATTACHMENT_RETRY_OPTIONS,
              onRetry: (error, attempt, delayMs) => {
                logAttachmentInfo('Retrying WebDAV attachment upload', {
                  id: attachment.id,
                  attempt: String(attempt + 1),
                  delayMs: String(delayMs),
                  error: sanitizeLogMessage(error instanceof Error ? error.message : String(error)),
                });
              },
            }
          );
        }
        if (!uploadedWithFileSystem) {
          const readStart = Date.now();
          logAttachmentInfo('WebDAV attachment read start', {
            id: attachment.id,
            uri,
          });
          let uploadData = fileData;
          if (!uploadData) {
            const readResult = await readAttachmentBytesForUpload(uri);
            if (readResult.readFailed) {
              localReadFailed = true;
              throw readResult.error;
            }
            uploadData = readResult.data;
          }
          logAttachmentInfo('WebDAV attachment read done', {
            id: attachment.id,
            bytes: String(uploadData.byteLength),
            ms: String(Date.now() - readStart),
          });
          const buffer = toArrayBuffer(uploadData);
          await withRetry(
            async () => {
              await waitForSlot();
              return await webdavPutFile(
                uploadUrl,
                buffer,
                attachment.mimeType || DEFAULT_CONTENT_TYPE,
                {
                  ...MOBILE_WEBDAV_REQUEST_OPTIONS,
                  username: webDavConfig.username,
                  password: webDavConfig.password,
                }
              );
            },
            {
              ...WEBDAV_ATTACHMENT_RETRY_OPTIONS,
              onRetry: (error, attempt, delayMs) => {
                logAttachmentInfo('Retrying WebDAV attachment upload', {
                  id: attachment.id,
                  attempt: String(attempt + 1),
                  delayMs: String(delayMs),
                  error: sanitizeLogMessage(error instanceof Error ? error.message : String(error)),
                });
              },
            }
          );
        }
        attachment.cloudKey = cloudKey;
        if (!Number.isFinite(attachment.size ?? NaN) && Number.isFinite(size ?? NaN)) {
          attachment.size = Number(size);
        }
        attachment.localStatus = 'available';
        didMutate = true;
        reportProgress(attachment.id, 'upload', uploadBytes, uploadBytes, 'completed');
        logAttachmentInfo('Attachment uploaded', {
          id: attachment.id,
          bytes: String(uploadBytes),
          ms: String(Date.now() - startedAt),
        });
      } catch (error) {
        if (handleRateLimit(error)) {
          abortedByRateLimit = true;
          break;
        }
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

  if (attachmentsDir && !abortedByRateLimit) {
    let downloadCount = 0;
    for (const attachment of downloadQueue) {
      if (attachment.kind !== 'file') continue;
      if (attachment.deletedAt) continue;
      if (abortedByRateLimit) break;
      if (!attachment.cloudKey) continue;
      if (getWebdavDownloadBackoff(attachment.id)) continue;
      if (downloadCount >= WEBDAV_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC) {
        logAttachmentInfo('WebDAV attachment download limit reached', {
          limit: String(WEBDAV_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC),
        });
        break;
      }
      downloadCount += 1;

      const cloudKey = attachment.cloudKey;
      try {
        const downloadUrl = `${baseSyncUrl}/${cloudKey}`;
        const fileData = await withRetry(
          async () => {
            await waitForSlot();
            return await webdavGetFile(downloadUrl, {
              ...MOBILE_WEBDAV_REQUEST_OPTIONS,
              username: webDavConfig.username,
              password: webDavConfig.password,
              onProgress: (loaded, total) => reportProgress(attachment.id, 'download', loaded, total, 'active'),
            });
          },
          WEBDAV_ATTACHMENT_RETRY_OPTIONS
        );
        const bytes = fileData instanceof ArrayBuffer ? new Uint8Array(fileData) : new Uint8Array(fileData as ArrayBuffer);
        await validateAttachmentHash(attachment, bytes);
        const filename = cloudKey.split('/').pop() || `${attachment.id}${extractExtension(attachment.title)}`;
        const targetUri = `${attachmentsDir}${filename}`;
        await writeBytesSafely(targetUri, bytes);
        attachment.uri = targetUri;
        if (attachment.localStatus !== 'available') {
          attachment.localStatus = 'available';
          didMutate = true;
        }
        clearWebdavDownloadBackoff(attachment.id);
        reportProgress(attachment.id, 'download', bytes.length, bytes.length, 'completed');
      } catch (error) {
        if (handleRateLimit(error)) {
          abortedByRateLimit = true;
          break;
        }
        const status = getErrorStatus(error);
        if (status === 404 && attachment.cloudKey) {
          clearWebdavDownloadBackoff(attachment.id);
          if (markAttachmentUnrecoverable(attachment)) {
            didMutate = true;
          }
          logAttachmentInfo('Cleared missing WebDAV cloud key after 404', {
            id: attachment.id,
          });
        } else {
          setWebdavDownloadBackoff(attachment.id, error);
        }
        if (status !== 404 && attachment.localStatus !== 'missing') {
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
  }

  if (abortedByRateLimit) {
    logAttachmentWarn('WebDAV attachment sync aborted due to rate limiting');
  }
  logAttachmentInfo('WebDAV attachment sync done', {
    mutated: didMutate ? 'true' : 'false',
  });
  return didMutate;
};
