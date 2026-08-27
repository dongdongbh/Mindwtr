import {
  applyAttachmentContentStat,
  bumpAttachmentContentRevision,
  checkAttachmentContentChange,
  computeSha256Hex,
  decryptRemoteArtifactOrThrow,
  encryptSyncArtifact,
  inspectSyncArtifact,
  isSha256Hex,
  runAttachmentTransferLifecycle,
  SyncCryptoUnsupportedError,
  SyncEncryptionTerminalError,
  WebDavRemoteWriteConflictError,
  type Attachment,
  type AttachmentDownloadExpectation,
  type AttachmentTransferLifecycleOptions,
  type AttachmentTransferResult,
  type SyncKeyMaterial,
} from '@mindwtr/core';
import * as FileSystem from '../file-system';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import {
  bytesToBase64,
  attachmentNeedsManagedLocalCopy,
  canUploadAttachmentFrom,
  computeAttachmentFileHash,
  createAttachmentLocalMigrationLimiter,
  DEFAULT_CONTENT_TYPE,
  getLocalAttachmentPresence,
  readFileAsBytes,
  statAttachmentFile,
  validateAttachmentHash,
  writeBytesSafely,
} from '../attachment-sync-utils';
import { installAttachmentFileGeneration } from '../attachment-file-installer';
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

let uploadSnapshotSequence = 0;
let downloadStageSequence = 0;

const buildAttachmentDownloadStagePath = (
  attachmentsDir: string,
  attachment: Attachment,
): string => {
  const normalizedDir = attachmentsDir.endsWith('/') ? attachmentsDir : `${attachmentsDir}/`;
  downloadStageSequence += 1;
  const random = Math.random().toString(16).slice(2, 10);
  const safeId = attachment.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'attachment';
  return `${normalizedDir}.mindwtr-download-${Date.now()}-${downloadStageSequence}-${random}-${safeId}.staged`;
};

export const deleteAttachmentDownloadStageBestEffort = async (stagedPath: string): Promise<void> => {
  await FileSystem.deleteAsync(stagedPath, { idempotent: true }).catch(() => undefined);
};

type InstallStagedAttachmentDownloadOptions = {
  attachment: Attachment;
  stagedPath: string;
  targetPath: string;
  expectation: AttachmentDownloadExpectation;
  signal?: AbortSignal;
  expectedStagedHash?: string;
};

/**
 * Validate the exact app-private scratch file, then hand publication to the
 * native generation-bound installer. Once native installation starts, JS must
 * never delete the scratch path: a conflict or interrupted journal may name it
 * as the only preserved copy of one generation.
 */
export const installStagedAttachmentDownload = async ({
  attachment,
  stagedPath,
  targetPath,
  expectation,
  signal,
  expectedStagedHash,
}: InstallStagedAttachmentDownloadOptions): Promise<boolean> => {
  let nativeInstallStarted = false;
  try {
    assertAttachmentSyncNotAborted(signal);
    const stagedBytes = await readFileAsBytes(stagedPath);
    const actualStagedHash = await computeSha256Hex(stagedBytes);
    if (!actualStagedHash) throw new Error('Attachment download hash is unavailable');
    if (expectedStagedHash && actualStagedHash !== expectedStagedHash) {
      throw new Error('Attachment download scratch file changed before installation');
    }
    await validateAttachmentHash(attachment, stagedBytes);
    assertAttachmentSyncNotAborted(signal);
    nativeInstallStarted = true;
    const result = await installAttachmentFileGeneration(
      stagedPath,
      targetPath,
      expectation,
      actualStagedHash,
    );
    if (result.status !== 'installed') return false;
    attachment.fileHash = actualStagedHash;
    await deleteAttachmentDownloadStageBestEffort(stagedPath);
    return true;
  } catch (error) {
    if (!nativeInstallStarted) await deleteAttachmentDownloadStageBestEffort(stagedPath);
    throw error;
  }
};

/** Write plaintext download bytes to a unique managed scratch file and install
 * that exact generation. A false result is a local-generation conflict; the
 * native result owns every preserved path, so no JS cleanup occurs. */
export const installAttachmentDownloadBytes = async (
  attachment: Attachment,
  attachmentsDir: string,
  targetPath: string,
  bytes: Uint8Array,
  expectation: AttachmentDownloadExpectation,
  signal?: AbortSignal,
): Promise<boolean> => {
  const stagedPath = buildAttachmentDownloadStagePath(attachmentsDir, attachment);
  const expectedStagedHash = await computeSha256Hex(bytes);
  if (!expectedStagedHash) {
    throw new Error('Attachment download hash is unavailable');
  }
  try {
    assertAttachmentSyncNotAborted(signal);
    await writeBytesSafely(stagedPath, bytes);
  } catch (error) {
    await deleteAttachmentDownloadStageBestEffort(stagedPath);
    throw error;
  }
  return installStagedAttachmentDownload({
    attachment,
    stagedPath,
    targetPath,
    expectation,
    signal,
    expectedStagedHash,
  });
};

/** CloudKit's native fetch must receive scratch, never the canonical target. */
export const createAttachmentDownloadStagePath = buildAttachmentDownloadStagePath;

/** A present expectation was hashed from attachment.uri, so publication must
 * CAS that exact path even when remote metadata now suggests another suffix. */
export const resolveAttachmentDownloadTargetPath = (
  attachment: Attachment,
  fallbackTargetPath: string,
  expectation: AttachmentDownloadExpectation,
): string => (
  expectation.kind === 'present' && attachment.uri
    ? attachment.uri
    : fallbackTargetPath
);

/**
 * Copy the live attachment into an app-private file before hashing or uploading
 * it. Native streaming transports and every retry then read the same immutable
 * source instead of reopening a URI that another app may still be editing.
 */
export const createMobileAttachmentUploadSnapshot: NonNullable<
  AttachmentTransferLifecycleOptions['createUploadSnapshot']
> = async (sourcePath, attachment) => {
  const baseDir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
  if (!baseDir) return null;

  const sourceStatBefore = sourcePath.startsWith('content://')
    ? null
    : await statAttachmentFile(sourcePath);

  const normalizedBaseDir = baseDir.endsWith('/') ? baseDir : `${baseDir}/`;
  uploadSnapshotSequence += 1;
  const stagedPath = `${normalizedBaseDir}mindwtr-upload-${Date.now()}-${uploadSnapshotSequence}-${attachment.id}`;
  let retainStagedFile = false;
  try {
    await FileSystem.copyAsync({ from: sourcePath, to: stagedPath });
    const [stagedStat, stagedBytes, sourceStatAfter] = await Promise.all([
      statAttachmentFile(stagedPath),
      readFileAsBytes(stagedPath),
      sourcePath.startsWith('content://') ? Promise.resolve(null) : statAttachmentFile(sourcePath),
    ]);
    const fileHash = await computeSha256Hex(stagedBytes);
    if (!fileHash) return null;
    if (
      sourceStatBefore
      && (
        !sourceStatAfter
        || sourceStatBefore.mtimeMs !== sourceStatAfter.mtimeMs
        || sourceStatBefore.size !== sourceStatAfter.size
        || sourceStatAfter.size !== stagedBytes.byteLength
      )
    ) {
      return null;
    }

    retainStagedFile = true;
    return {
      sourcePath: stagedPath,
      fileHash,
      stat: sourceStatAfter ?? stagedStat ?? { mtimeMs: 0, size: stagedBytes.byteLength },
      dispose: async () => {
        await FileSystem.deleteAsync(stagedPath, { idempotent: true });
      },
    };
  } finally {
    if (!retainStagedFile) {
      await FileSystem.deleteAsync(stagedPath, { idempotent: true }).catch(() => undefined);
    }
  }
};

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
  options: Omit<
    AttachmentTransferLifecycleOptions,
    'resolveLocalPath' | 'canUploadFrom' | 'createUploadSnapshot' | 'requireUploadSnapshot'
  >
): Promise<AttachmentTransferResult> {
  return await runAttachmentTransferLifecycle({
    ...options,
    resolveLocalPath: (uri) => uri,
    canUploadFrom: canUploadAttachmentFrom,
    createUploadSnapshot: createMobileAttachmentUploadSnapshot,
    requireUploadSnapshot: true,
  });
}

/**
 * Cloud and Dropbox keep bespoke transfer loops for their batch/credential semantics.
 * Give those loops the same prepare-side content candidate behavior as the shared
 * lifecycle: a confirmed local edit updates only local metadata and is uploaded only
 * if that identity survives merge.
 */
export const prepareBespokeAttachmentContentCandidate = async (
  attachment: Attachment,
  localPath: string,
): Promise<boolean> => {
  const stat = await statAttachmentFile(localPath);
  if (!stat) return false;
  const check = await checkAttachmentContentChange(
    attachment,
    stat,
    () => computeAttachmentFileHash(localPath),
  );
  if (!check.changed) {
    if (check.stat.mtimeMs === attachment.contentMtimeMs && check.stat.size === attachment.contentSize) {
      return false;
    }
    applyAttachmentContentStat(attachment, check.stat, check.hash);
    return true;
  }
  if (!check.hash) return false;
  applyAttachmentContentStat(attachment, check.stat, check.hash);
  attachment.contentRev = bumpAttachmentContentRevision(attachment);
  attachment.pendingContentUpload = true;
  return true;
};

/** Fail closed if a pending winner's on-disk bytes changed after the merge candidate
 * was recorded. A later prepare pass will record the newer identity and retry. */
export const pendingBespokeAttachmentContentStillMatches = async (
  attachment: Attachment,
  localPath: string,
): Promise<boolean> => {
  const stat = await statAttachmentFile(localPath);
  if (!stat) return false;
  const check = await checkAttachmentContentChange(
    attachment,
    stat,
    () => computeAttachmentFileHash(localPath),
  );
  if (check.changed) return false;
  if (check.stat.mtimeMs !== attachment.contentMtimeMs || check.stat.size !== attachment.contentSize) {
    applyAttachmentContentStat(attachment, check.stat, check.hash);
  }
  return true;
};

export type BespokeAttachmentRemoteWinnerCheck =
  | { kind: 'none'; metadataChanged: boolean }
  | { kind: 'local-edit-race'; metadataChanged: false }
  | { kind: 'download'; metadataChanged: false; expectation: AttachmentDownloadExpectation };

/**
 * Post-merge companion to `prepareBespokeAttachmentContentCandidate` for the
 * Cloud and Dropbox adapters that cannot use core's generic transfer loop.
 *
 * The merged attachment already names the winning remote content generation.
 * A hash-confirmed mismatch therefore needs a generation-bound download, but
 * only while the live file still has the exact stat that was hashed. This is
 * the same hash + immediate re-stat rule used by core's lifecycle before its
 * `{ kind: 'present' }` download callback.
 */
export const checkBespokeAttachmentRemoteWinner = async (
  attachment: Attachment,
  localPath: string,
): Promise<BespokeAttachmentRemoteWinnerCheck> => {
  if (attachment.pendingContentUpload === true) {
    return { kind: 'none', metadataChanged: false };
  }

  const stat = await statAttachmentFile(localPath);
  if (!stat) return { kind: 'none', metadataChanged: false };
  const check = await checkAttachmentContentChange(
    attachment,
    stat,
    () => computeAttachmentFileHash(localPath),
  );
  if (!check.changed) {
    const metadataChanged = check.stat.mtimeMs !== attachment.contentMtimeMs
      || check.stat.size !== attachment.contentSize;
    if (metadataChanged) {
      applyAttachmentContentStat(attachment, check.stat, check.hash);
    }
    return { kind: 'none', metadataChanged };
  }
  if (!check.hash || !isSha256Hex(check.hash.trim().toLowerCase())) {
    return { kind: 'none', metadataChanged: false };
  }
  const expectedRemoteHash = attachment.fileHash?.trim().toLowerCase();
  if (!attachment.fileHash) {
    applyAttachmentContentStat(attachment, check.stat, check.hash);
    return { kind: 'none', metadataChanged: true };
  }
  if (!isSha256Hex(expectedRemoteHash)) {
    return { kind: 'none', metadataChanged: false };
  }

  const restat = await statAttachmentFile(localPath);
  if (
    !restat
    || restat.mtimeMs !== check.stat.mtimeMs
    || restat.size !== check.stat.size
  ) {
    return { kind: 'local-edit-race', metadataChanged: false };
  }
  return {
    kind: 'download',
    metadataChanged: false,
    expectation: { kind: 'present', sha256: check.hash.trim().toLowerCase() },
  };
};

/**
 * Record a downloaded generation as the local baseline only if the path still
 * contains the exact remote bytes and remains stable across hash + stat. A
 * writer that edits immediately after native publication is left for the next
 * prepare pass instead of being mislabeled as the remote baseline.
 */
export const refreshBespokeAttachmentDownloadedContentStat = async (
  attachment: Attachment,
  localPath: string,
): Promise<boolean> => {
  const expectedRemoteHash = attachment.fileHash?.trim().toLowerCase();
  if (!isSha256Hex(expectedRemoteHash)) return false;
  const stat = await statAttachmentFile(localPath);
  if (!stat) return false;
  const hash = await computeAttachmentFileHash(localPath);
  const restat = await statAttachmentFile(localPath);
  if (
    hash?.trim().toLowerCase() !== expectedRemoteHash
    || !restat
    || restat.mtimeMs !== stat.mtimeMs
    || restat.size !== stat.size
  ) {
    return false;
  }
  applyAttachmentContentStat(attachment, restat, expectedRemoteHash);
  return true;
};

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
    if (attachmentNeedsManagedLocalCopy(attachment)) {
      const presence = await getLocalAttachmentPresence(attachment.uri || '');
      if (presence === 'unreadable') {
        attachmentsById.delete(attachment.id);
        continue;
      }
      if (presence === 'confirmed-not-found') continue;
    }
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
const CLOUD_STREAM_UPLOAD_TIMEOUT_MS = 30_000;

const runUploadTask = async <T,>(
  task: { uploadAsync: () => Promise<T> },
  signal?: AbortSignal,
  timeoutMs?: number,
  timeoutMessage = 'Streamed upload timed out',
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
        beginCancellation(new Error(timeoutMessage));
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
    const result = await runUploadTask(task, signal, timeoutMs, 'WebDAV streamed upload timed out');
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
  signal?: AbortSignal,
  timeoutMs = CLOUD_STREAM_UPLOAD_TIMEOUT_MS,
): Promise<boolean> => {
  assertUploadNotAborted(signal);
  const uploadAsync = LegacyFileSystem.uploadAsync;
  if (typeof uploadAsync !== 'function') return false;
  if (!fileUri.startsWith('file://')) return false;

  const authHeader = buildBearerAuthHeader(token);
  const headers: Record<string, string> = {
    'Content-Type': contentType || DEFAULT_CONTENT_TYPE,
  };
  if (authHeader) headers.Authorization = authHeader;

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
    const result = await runUploadTask(task, signal, timeoutMs, 'Cloud streamed upload timed out');
    const status = Number((result as { status?: number } | null)?.status ?? 0);
    if (status && (status < 200 || status >= 300)) {
      const error = new Error(`Cloud File PUT failed (${status})`);
      (error as { status?: number }).status = status;
      throw error;
    }
    return true;
  }

  // uploadAsync has no cancellation handle. Fall back to core's bounded byte PUT
  // rather than start a request that can occupy the singleton sync indefinitely.
  return false;
};
