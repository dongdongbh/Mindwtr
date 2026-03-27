import * as FileSystem from 'expo-file-system/legacy';
import type { AppData, Attachment } from '@mindwtr/core';
import {
  cloudPutFile,
  getErrorStatus,
  isWebdavRateLimitedError,
  validateAttachmentForUpload,
  webdavFileExists,
  webdavGetFile,
  webdavMakeDirectory,
  webdavPutFile,
  withRetry,
} from '@mindwtr/core';
import {
  DropboxFileNotFoundError,
  downloadDropboxFile,
  uploadDropboxFile,
} from './dropbox-sync';
import { sanitizeLogMessage } from './app-log';
import {
  ATTACHMENTS_DIR_NAME,
  bytesToBase64,
  buildCloudKey,
  clearWebdavDownloadBackoff,
  collectAttachments,
  copyFileSafely,
  DEFAULT_CONTENT_TYPE,
  DROPBOX_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC,
  DROPBOX_ATTACHMENT_MAX_UPLOADS_PER_SYNC,
  extractExtension,
  fileExists,
  FILE_BACKEND_VALIDATION_CONFIG,
  findSafEntry,
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
  readFileAsBytes,
  reportProgress,
  resolveFileSyncDir,
  runDropboxAuthorized,
  setWebdavDownloadBackoff,
  sleep,
  StorageAccessFramework,
  toArrayBuffer,
  type CloudConfig,
  type WebDavConfig,
  validateAttachmentHash,
  WEBDAV_ATTACHMENT_COOLDOWN_MS,
  WEBDAV_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC,
  WEBDAV_ATTACHMENT_MAX_UPLOADS_PER_SYNC,
  WEBDAV_ATTACHMENT_MIN_INTERVAL_MS,
  WEBDAV_ATTACHMENT_RETRY_OPTIONS,
  writeBytesSafely,
} from './attachment-sync-utils';

const encodeBase64Utf8 = (value: string): string => {
  const Encoder = typeof TextEncoder === 'function' ? TextEncoder : undefined;
  if (Encoder) {
    return bytesToBase64(new Encoder().encode(value));
  }
  try {
    const encoded = encodeURIComponent(value);
    const bytes: number[] = [];
    for (let i = 0; i < encoded.length; i += 1) {
      const ch = encoded[i];
      if (ch === '%') {
        const hex = encoded.slice(i + 1, i + 3);
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
      } else {
        bytes.push(ch.charCodeAt(0));
      }
    }
    return bytesToBase64(new Uint8Array(bytes));
  } catch {
    const bytes = new Uint8Array(value.split('').map((ch) => ch.charCodeAt(0) & 0xff));
    return bytesToBase64(bytes);
  }
};

const buildBasicAuthHeader = (username?: string, password?: string): string | null => {
  if (!username && !password) return null;
  return `Basic ${encodeBase64Utf8(`${username || ''}:${password || ''}`)}`;
};

const buildBearerAuthHeader = (token?: string): string | null => {
  if (!token) return null;
  return `Bearer ${token}`;
};

const resolveUploadType = (): any => {
  const types = (FileSystem as any).FileSystemUploadType;
  return types?.BINARY_CONTENT ?? types?.BINARY ?? undefined;
};

const uploadWebdavFileWithFileSystem = async (
  url: string,
  fileUri: string,
  contentType: string,
  username: string,
  password: string,
  onProgress?: (sent: number, total: number) => void,
  totalBytes?: number
): Promise<boolean> => {
  const uploadAsync = (FileSystem as any).uploadAsync;
  if (typeof uploadAsync !== 'function') return false;
  if (!fileUri.startsWith('file://')) return false;

  const authHeader = buildBasicAuthHeader(username, password);
  const headers: Record<string, string> = {
    'Content-Type': contentType || DEFAULT_CONTENT_TYPE,
  };
  if (authHeader) headers.Authorization = authHeader;

  const uploadType = resolveUploadType();
  const createUploadTask = (FileSystem as any).createUploadTask;
  if (typeof createUploadTask === 'function' && onProgress) {
    const task = createUploadTask(
      url,
      fileUri,
      {
        httpMethod: 'PUT',
        headers,
        uploadType,
      },
      (event: { totalBytesSent?: number; totalBytesExpectedToSend?: number }) => {
        const sent = Number(event.totalBytesSent ?? 0);
        const expected = Number(event.totalBytesExpectedToSend ?? totalBytes ?? 0);
        if (expected > 0) {
          onProgress(sent, expected);
        }
      }
    );
    const result = await task.uploadAsync();
    const status = Number((result as { status?: number } | null)?.status ?? 0);
    if (status && (status < 200 || status >= 300)) {
      const error = new Error(`WebDAV File PUT failed (${status})`);
      (error as { status?: number }).status = status;
      throw error;
    }
    return true;
  }

  const result = await uploadAsync(url, fileUri, { httpMethod: 'PUT', headers, uploadType });
  const status = Number((result as { status?: number } | null)?.status ?? 0);
  if (status && (status < 200 || status >= 300)) {
    const error = new Error(`WebDAV File PUT failed (${status})`);
    (error as { status?: number }).status = status;
    throw error;
  }
  if (onProgress && Number.isFinite(totalBytes ?? NaN) && (totalBytes ?? 0) > 0) {
    onProgress(totalBytes ?? 0, totalBytes ?? 0);
  }
  return true;
};

const uploadCloudFileWithFileSystem = async (
  url: string,
  fileUri: string,
  contentType: string,
  token: string,
  onProgress?: (sent: number, total: number) => void,
  totalBytes?: number
): Promise<boolean> => {
  const uploadAsync = (FileSystem as any).uploadAsync;
  if (typeof uploadAsync !== 'function') return false;
  if (!fileUri.startsWith('file://')) return false;

  const authHeader = buildBearerAuthHeader(token);
  const headers: Record<string, string> = {
    'Content-Type': contentType || DEFAULT_CONTENT_TYPE,
  };
  if (authHeader) headers.Authorization = authHeader;

  const uploadType = resolveUploadType();
  const createUploadTask = (FileSystem as any).createUploadTask;
  if (typeof createUploadTask === 'function' && onProgress) {
    const task = createUploadTask(
      url,
      fileUri,
      {
        httpMethod: 'PUT',
        headers,
        uploadType,
      },
      (event: { totalBytesSent?: number; totalBytesExpectedToSend?: number }) => {
        const sent = Number(event.totalBytesSent ?? 0);
        const expected = Number(event.totalBytesExpectedToSend ?? totalBytes ?? 0);
        if (expected > 0) {
          onProgress(sent, expected);
        }
      }
    );
    const result = await task.uploadAsync();
    const status = Number((result as { status?: number } | null)?.status ?? 0);
    if (status && (status < 200 || status >= 300)) {
      const error = new Error(`Cloud File PUT failed (${status})`);
      (error as { status?: number }).status = status;
      throw error;
    }
    return true;
  }

  const result = await uploadAsync(url, fileUri, { httpMethod: 'PUT', headers, uploadType });
  const status = Number((result as { status?: number } | null)?.status ?? 0);
  if (status && (status < 200 || status >= 300)) {
    const error = new Error(`Cloud File PUT failed (${status})`);
    (error as { status?: number }).status = status;
    throw error;
  }
  if (onProgress && Number.isFinite(totalBytes ?? NaN) && (totalBytes ?? 0) > 0) {
    onProgress(totalBytes ?? 0, totalBytes ?? 0);
  }
  return true;
};

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
