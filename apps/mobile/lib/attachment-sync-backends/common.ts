import type { Attachment, SyncKeyMaterial } from '@mindwtr/core';
import {
  decryptRemoteArtifactOrThrow,
  encryptSyncArtifact,
  inspectSyncArtifact,
  runAttachmentTransferLifecycle,
  SyncCryptoUnsupportedError,
  SyncEncryptionTerminalError,
  type AttachmentTransferLifecycleOptions,
  type AttachmentTransferResult,
} from '@mindwtr/core';
import * as FileSystem from '../file-system';
import {
  bytesToBase64,
  canUploadAttachmentFrom,
  createAttachmentLocalMigrationLimiter,
  DEFAULT_CONTENT_TYPE,
} from '../attachment-sync-utils';
import { mobileSyncCryptoPrimitives } from '../sync-crypto-native';
import { assertMobileWebdavConnection } from '../webdav-request-options';

/**
 * Attachment bytes at the storage seam (#1056). Local attachment files always stay
 * plaintext — only what leaves the device is sealed — and attachments keep their exact
 * remote names (`cloudKey` is identity-keyed and immutable-once-uploaded), so the only
 * change is the byte content.
 *
 * `null` material is the encryption-off path and returns the input untouched.
 */
export const sealAttachmentBytesForUpload = async (
  bytes: Uint8Array,
  material: SyncKeyMaterial | null | undefined,
): Promise<Uint8Array> => (
  material ? encryptSyncArtifact(bytes, material, mobileSyncCryptoPrimitives) : bytes
);

/**
 * Inverse of the above. A remote attachment that is still plaintext is passed through:
 * an interrupted enable-transition legitimately leaves some attachments unmigrated, and
 * `validateAttachmentHash` downstream is the backstop for content that is neither. Bytes
 * that DO carry the MWENC1 magic must decrypt or fail closed — a broken container is
 * never quietly treated as file content.
 */
export const openAttachmentBytesFromDownload = async (
  bytes: Uint8Array,
  material: SyncKeyMaterial | null | undefined,
): Promise<Uint8Array> => {
  if (!material) return bytes;
  const inspected = inspectSyncArtifact(bytes);
  if (inspected.kind === 'plaintext') return bytes;
  if (inspected.kind === 'unsupported') {
    throw new SyncEncryptionTerminalError(new SyncCryptoUnsupportedError(inspected.reason));
  }
  return decryptRemoteArtifactOrThrow(bytes, material.key, mobileSyncCryptoPrimitives);
};

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

export const createAttachmentAbortError = (
  message = 'Attachment sync aborted',
  signal?: AbortSignal
): Error => {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === 'string' && reason.trim() ? reason : message);
  error.name = 'AbortError';
  return error;
};

const createUploadAbortError = (signal?: AbortSignal): Error =>
  createAttachmentAbortError('Attachment upload aborted', signal);

export const assertAttachmentSyncNotAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  throw createAttachmentAbortError('Attachment sync aborted', signal);
};

export const isAttachmentSyncAbortError = (error: unknown, signal?: AbortSignal): boolean => (
  Boolean(signal?.aborted) || (error instanceof Error && error.name === 'AbortError')
);

/**
 * Thin adapter over core's shared reconciliation loop (`runAttachmentTransferLifecycle`),
 * mirroring desktop's `syncBasicRemoteAttachments` (apps/desktop/src/lib/sync-attachments.ts).
 * The one platform-specific override: expo-file-system needs the uri verbatim (including its
 * `file://`/`content://` scheme) — unlike Tauri's native absolute paths, there's nothing to
 * strip, so `resolveLocalPath` is the identity function rather than the core default (which
 * strips `file://`).
 *
 * Like core's lifecycle it never writes to the attachments it is given: changes come back as
 * patches for `applyAttachmentPatches` to fold into a fresh document.
 */
export async function runMobileAttachmentLifecycle(
  options: Omit<AttachmentTransferLifecycleOptions, 'resolveLocalPath' | 'canUploadFrom'>
): Promise<AttachmentTransferResult> {
  return await runAttachmentTransferLifecycle({
    ...options,
    resolveLocalPath: (uri) => uri,
    canUploadFrom: canUploadAttachmentFrom,
  });
}

/**
 * Pre-pass run before the reconciliation loop (or a backend's own bespoke loop): migrates any
 * attachment whose uri still points outside the managed attachments dir — legacy Android
 * content:// / SAF references — into it, capped per call by
 * `createAttachmentLocalMigrationLimiter`. An attachment that hits the cap is removed from the
 * map entirely, same as the old per-backend `if (skipped) continue;` — so nothing downstream
 * (lifecycle or bespoke loop) touches it again this round. A migration attempt that fails
 * (rather than being capped) leaves the attachment in the map with its uri unchanged, so the
 * caller still tries to upload/copy straight from wherever the file currently lives.
 *
 * Pure with respect to the document: the migration writes to a per-attachment working copy,
 * which is returned as a patch AND put back into `attachmentsById` so the lifecycle (or a
 * bespoke loop) that runs next reads the migrated uri.
 */
export const migrateAttachmentsLocallyBeforeSync = async (
  attachmentsById: Map<string, Attachment>,
  signal?: AbortSignal
): Promise<Map<string, Attachment>> => {
  const migrateAttachmentLocally = createAttachmentLocalMigrationLimiter();
  const patches = new Map<string, Attachment>();
  for (const original of attachmentsById.values()) {
    assertAttachmentSyncNotAborted(signal);
    if (original.kind !== 'file' || original.deletedAt) continue;
    const attachment: Attachment = { ...original };
    const result = await migrateAttachmentLocally(attachment);
    if (result.migrated) {
      patches.set(attachment.id, attachment);
      attachmentsById.set(attachment.id, attachment);
    }
    if (result.skipped) attachmentsById.delete(attachment.id);
  }
  return patches;
};

export const waitForAttachmentSyncDelay = async (ms: number, signal?: AbortSignal): Promise<void> => {
  assertAttachmentSyncNotAborted(signal);
  if (ms <= 0) return;
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(createAttachmentAbortError('Attachment sync aborted', signal));
    };
    timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
};

const assertUploadNotAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  throw createUploadAbortError(signal);
};

const cancelUploadTask = async (task: unknown): Promise<void> => {
  const cancelAsync = (task as { cancelAsync?: unknown } | null)?.cancelAsync;
  if (typeof cancelAsync !== 'function') return;
  await cancelAsync.call(task);
};

const runUploadTask = async <T,>(task: { uploadAsync: () => Promise<T> }, signal?: AbortSignal): Promise<T> => {
  assertUploadNotAborted(signal);
  if (!signal) {
    return task.uploadAsync();
  }

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let onAbort: () => void;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    onAbort = () => {
      void cancelUploadTask(task).catch(() => undefined);
      finish(() => reject(createUploadAbortError(signal)));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    task.uploadAsync().then(
      (result) => finish(() => resolve(result)),
      (error) => finish(() => reject(error))
    );
  });
};

export const uploadWebdavFileWithFileSystem = async (
  url: string,
  fileUri: string,
  contentType: string,
  username: string,
  password: string,
  allowInsecureHttp: boolean | undefined,
  onProgress?: (sent: number, total: number) => void,
  totalBytes?: number,
  signal?: AbortSignal
): Promise<boolean> => {
  // Before anything is read or sent: this uploader bypasses core's transports, so it is
  // the only place the cleartext guard can run for it (SEC-10a).
  assertMobileWebdavConnection(url, allowInsecureHttp);
  assertUploadNotAborted(signal);
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
  if (typeof createUploadTask === 'function' && (onProgress || signal)) {
    const task = createUploadTask(
      url,
      fileUri,
      {
        httpMethod: 'PUT',
        headers,
        uploadType,
      },
      (event: { totalBytesSent?: number; totalBytesExpectedToSend?: number }) => {
        if (!onProgress) return;
        const sent = Number(event.totalBytesSent ?? 0);
        const expected = Number(event.totalBytesExpectedToSend ?? totalBytes ?? 0);
        if (expected > 0) {
          onProgress(sent, expected);
        }
      }
    );
    const result = await runUploadTask(task, signal);
    const status = Number((result as { status?: number } | null)?.status ?? 0);
    if (status && (status < 200 || status >= 300)) {
      const error = new Error(`WebDAV File PUT failed (${status})`);
      (error as { status?: number }).status = status;
      throw error;
    }
    return true;
  }

  if (signal) return false;

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

export const uploadCloudFileWithFileSystem = async (
  url: string,
  fileUri: string,
  contentType: string,
  token: string,
  onProgress?: (sent: number, total: number) => void,
  totalBytes?: number,
  signal?: AbortSignal
): Promise<boolean> => {
  assertUploadNotAborted(signal);
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
  if (typeof createUploadTask === 'function' && (onProgress || signal)) {
    const task = createUploadTask(
      url,
      fileUri,
      {
        httpMethod: 'PUT',
        headers,
        uploadType,
      },
      (event: { totalBytesSent?: number; totalBytesExpectedToSend?: number }) => {
        if (!onProgress) return;
        const sent = Number(event.totalBytesSent ?? 0);
        const expected = Number(event.totalBytesExpectedToSend ?? totalBytes ?? 0);
        if (expected > 0) {
          onProgress(sent, expected);
        }
      }
    );
    const result = await runUploadTask(task, signal);
    const status = Number((result as { status?: number } | null)?.status ?? 0);
    if (status && (status < 200 || status >= 300)) {
      const error = new Error(`Cloud File PUT failed (${status})`);
      (error as { status?: number }).status = status;
      throw error;
    }
    return true;
  }

  if (signal) return false;

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
