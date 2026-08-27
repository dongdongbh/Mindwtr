import {
  decryptRemoteArtifactOrThrow,
  encryptSyncArtifact,
  inspectSyncArtifact,
  runAttachmentTransferLifecycle,
  SyncCryptoUnsupportedError,
  SyncEncryptionTerminalError,
  WebDavRemoteWriteConflictError,
  type Attachment,
  type AttachmentTransferLifecycleOptions,
  type AttachmentTransferResult,
  type SyncKeyMaterial,
} from '@mindwtr/core';
import * as FileSystem from '../file-system';
import * as LegacyFileSystem from 'expo-file-system/legacy';
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

export class StreamedUploadCancellationUnconfirmedError extends Error {
  readonly cancellationError: unknown;

  constructor(cause: Error, cancellationError: unknown) {
    super('Streamed upload cancellation could not be confirmed after the native upload terminated');
    this.name = 'StreamedUploadCancellationUnconfirmedError';
    this.cancellationError = cancellationError;
    (this as Error & { cause?: unknown }).cause = cause;
  }
}

const cancelUploadTask = async (task: unknown): Promise<void> => {
  const cancelAsync = (task as { cancelAsync?: unknown } | null)?.cancelAsync;
  if (typeof cancelAsync !== 'function') {
    throw new Error('Native upload task has no cancellation API');
  }
  await cancelAsync.call(task);
};

const WEBDAV_STREAM_UPLOAD_TIMEOUT_MS = 30_000;

const runUploadTask = async <T,>(
  task: { uploadAsync: () => Promise<T> },
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<T> => {
  assertUploadNotAborted(signal);
  if (!signal && timeoutMs === undefined) {
    return task.uploadAsync();
  }

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let cancellationStarted = false;
    let cancellationCause: Error | null = null;
    let cancellationState:
      | { state: 'pending' }
      | { state: 'confirmed' }
      | { state: 'failed'; error: unknown } = { state: 'pending' };
    let onAbort: (() => void) | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const uploadOutcome = Promise.resolve().then(() => task.uploadAsync()).then(
      (value) => ({ state: 'fulfilled', value } as const),
      (error) => ({ state: 'rejected', error } as const),
    );
    const cleanupTriggers = () => {
      if (timeoutId !== null) clearTimeout(timeoutId);
      timeoutId = null;
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      onAbort = null;
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanupTriggers();
      fn();
    };
    const beginCancellation = (cause: Error) => {
      if (settled || cancellationStarted) return;
      cancellationStarted = true;
      cancellationCause = cause;
      cleanupTriggers();
      void cancelUploadTask(task).then(
        () => { cancellationState = { state: 'confirmed' }; },
        (error) => { cancellationState = { state: 'failed', error }; },
      );
      // Do not reject until the native request is terminal. Otherwise the retry/finally
      // path can release the remote mutation fence while the old PUT is still live.
    };
    onAbort = () => beginCancellation(createUploadAbortError(signal));

    signal?.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs !== undefined) {
      timeoutId = setTimeout(() => {
        beginCancellation(new Error('WebDAV streamed upload timed out'));
      }, timeoutMs);
    }
    void uploadOutcome.then((outcome) => {
      if (!cancellationStarted) {
        if (outcome.state === 'fulfilled') finish(() => resolve(outcome.value));
        else finish(() => reject(outcome.error));
        return;
      }

      const cause = cancellationCause ?? new Error('Streamed upload cancelled');
      if (cancellationState.state === 'confirmed') {
        finish(() => reject(cause));
        return;
      }
      const cancellationError = cancellationState.state === 'failed'
        ? cancellationState.error
        : new Error('Native upload cancellation did not acknowledge before the upload terminated');
      finish(() => reject(new StreamedUploadCancellationUnconfirmedError(cause, cancellationError)));
    });
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
  signal?: AbortSignal,
  expectedEtag: string | null | undefined = undefined,
  timeoutMs = WEBDAV_STREAM_UPLOAD_TIMEOUT_MS,
): Promise<boolean> => {
  // Before anything is read or sent: this uploader bypasses core's transports, so it is
  // the only place the cleartext guard can run for it (SEC-10a).
  assertMobileWebdavConnection(url, allowInsecureHttp);
  assertUploadNotAborted(signal);
  const uploadAsync = LegacyFileSystem.uploadAsync;
  if (typeof uploadAsync !== 'function') return false;
  if (!fileUri.startsWith('file://')) return false;

  const authHeader = buildBasicAuthHeader(username, password);
  const headers: Record<string, string> = {
    'Content-Type': contentType || DEFAULT_CONTENT_TYPE,
  };
  if (authHeader) headers.Authorization = authHeader;
  if (expectedEtag === null) headers['If-None-Match'] = '*';
  else if (expectedEtag !== undefined) headers['If-Match'] = expectedEtag;

  const uploadType = resolveUploadType();
  const createUploadTask = LegacyFileSystem.createUploadTask;
  if (typeof createUploadTask === 'function') {
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
    if (!task || typeof task.uploadAsync !== 'function') return false;
    const result = await runUploadTask(task, signal, timeoutMs);
    const status = Number((result as { status?: number } | null)?.status ?? 0);
    if (status && (status < 200 || status >= 300)) {
      if (status === 409 || status === 412) throw new WebDavRemoteWriteConflictError(status);
      const error = new Error(`WebDAV File PUT failed (${status})`);
      (error as { status?: number }).status = status;
      throw error;
    }
    return true;
  }

  // uploadAsync has no cancellation handle. Fall back to the bounded byte PUT
  // path rather than start an upload that can outlive the remote mutation lease.
  return false;
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
