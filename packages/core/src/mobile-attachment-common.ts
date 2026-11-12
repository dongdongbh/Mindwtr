


import type { Attachment } from './types';
import { applyAttachmentContentStat, bumpAttachmentContentRevision, checkAttachmentContentChange, isStaleCopyOfRemoteWinner, logUninstalledRemoteWinner } from './attachment-change-detection';
import { computeSha256Hex, isSha256Hex } from './attachment-hash';
import { isAttachmentPresenceRepairCandidate, repairMissingRemoteAttachments } from './attachment-presence-repair';
import {
  assertBufferedAttachmentUploadSize,
  AttachmentUploadSizeUnavailableError,
  reportProgress,
  runAttachmentTransferLifecycle,
  validateAttachmentHash,
  type AttachmentDownloadExpectation,
  type AttachmentTransferLifecycleOptions,
  type AttachmentTransferResult,
} from './attachment-transfer';
import { bytesToBase64 } from './base64-bytes';
import { MAX_DOWNLOAD_BYTES, ResponseTooLargeError } from './http-utils';
import { encryptSyncArtifact, inspectSyncArtifact, SyncCryptoUnsupportedError, type SyncCryptoPrimitives, type SyncKeyMaterial } from './sync-crypto';
import { buildSyncEncryptionRemoteReadExtra, SYNC_ENCRYPTION_LOG_EVENTS, type SyncEncryptionRemoteReadLogInput } from './sync-encryption-diagnostics';
import { assertSyncAttachmentEncryptionPosture, decryptRemoteArtifactOrThrow, SyncEncryptionPartlyEncryptedError, SyncEncryptionTerminalError } from './sync-encryption';
import { WebDavRemoteWriteConflictError } from './webdav';
import { assertMobileWebdavConnection } from './mobile-sync-utils';
import { DEFAULT_ATTACHMENT_CONTENT_TYPE, isHttpAttachmentUri, type MobileAttachmentFiles, type MobileAttachmentFileSystemPort } from './mobile-attachment-files';
import type { AttachmentFileInstallResult, MobileAttachmentInstaller } from './mobile-attachment-installer';
import type { MobileSyncEncryptionPort } from './mobile-sync-service';

const DOWNLOAD_READ_CHUNK_BYTES = 64 * 1024;
const WEBDAV_STREAM_UPLOAD_TIMEOUT_MS = 30_000;


export const CLOUD_ATTACHMENT_PRESENCE_MAX_CHECKS_PER_PASS = 200;

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

const assertUploadNotAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  throw createUploadAbortError(signal);
};

const assertAttachmentDownloadSize = (size: number): void => {
  if (!Number.isFinite(size) || size < 0 || size > MAX_DOWNLOAD_BYTES) {
    throw new ResponseTooLargeError(MAX_DOWNLOAD_BYTES);
  }
};

type AttachmentDownloadFileSnapshot = {
  modificationTime: number | null;
  size: number;
};

const snapshotsMatch = (
  before: AttachmentDownloadFileSnapshot,
  after: AttachmentDownloadFileSnapshot,
): boolean => (
  before.size === after.size
  && (
    before.modificationTime === null
    || after.modificationTime === null
    || before.modificationTime === after.modificationTime
  )
);

const isInstallerUnavailableError = (error: unknown): boolean => error instanceof Error
  && (error as Error & { code?: unknown }).code === 'ATTACHMENT_FILE_INSTALLER_UNAVAILABLE';


const installStagedDownloadWithoutNativeInstaller = (
  stagedPath: string,
): AttachmentFileInstallResult => ({ status: 'conflict', preservedPath: stagedPath });

type InstallStagedAttachmentDownloadOptions = {
  attachment: Attachment;
  stagedPath: string;
  targetPath: string;
  expectation: AttachmentDownloadExpectation;
  signal?: AbortSignal;
  expectedStagedHash?: string;
};

export type PreparedPlaintextDownloadInput = Readonly<{
  attachmentId: string;
  targetURI: string;
  expectation: Readonly<{ kind: 'absent' }>;
  sha256: string;
  size: number;
}>;


export type PreparedPlaintextDownloadSource = Readonly<{
  kind: 'prepared-source';
  sourceToken: string;
}>;

export type PreparedAttachmentDownloadBytes = Readonly<{
  kind: 'prepared-plaintext';
  sourceToken: string;
  sha256: string;
  size: number;
}>;

const assertExpectedAttachmentDownloadHash = (attachment: Attachment, sha256: string): void => {
  if (isSha256Hex(attachment.fileHash) && attachment.fileHash.toLowerCase() !== sha256) {
    throw new Error('Integrity validation failed');
  }
};

const isPreparedPlaintextDownloadSource = (value: unknown): value is PreparedPlaintextDownloadSource => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes('kind') || !keys.includes('sourceToken')) return false;
  const source = value as Record<string, unknown>;
  return source.kind === 'prepared-source'
    && typeof source.sourceToken === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(source.sourceToken);
};


export const resolveAttachmentDownloadTargetPath = (
  attachment: Attachment,
  fallbackTargetPath: string,
  expectation: AttachmentDownloadExpectation,
): string => (
  expectation.kind === 'present' && attachment.uri
    ? attachment.uri
    : fallbackTargetPath
);

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

export type BespokeAttachmentRemoteWinnerCheck =
  | { kind: 'none'; metadataChanged: boolean }
  | { kind: 'local-edit-race'; metadataChanged: false }
  | { kind: 'download'; metadataChanged: false; expectation: AttachmentDownloadExpectation };

export type MobileAttachmentUploadProgressEvent = { totalBytesSent?: number; totalBytesExpectedToSend?: number };


export type MobileAttachmentUploadTask = {
  uploadAsync(): Promise<unknown>;
  cancelAsync?(): Promise<unknown>;
};


export type MobileAttachmentUploadPort = {


  createUploadTask(
    url: string,
    fileUri: string,
    options: { httpMethod: 'PUT'; headers: Record<string, string> },
    onProgress: (event: MobileAttachmentUploadProgressEvent) => void,
  ): MobileAttachmentUploadTask | null | undefined;
};

export type MobileAttachmentCommonHost = {
  fs: MobileAttachmentFileSystemPort;
  files: MobileAttachmentFiles;
  crypto: SyncCryptoPrimitives;
  encryption: Pick<MobileSyncEncryptionPort, 'logSyncEncryptionEvent' | 'getSyncEncryptionStatus'>;
  installer: Pick<MobileAttachmentInstaller, 'installAttachmentFileGeneration'>;


  installerMayBeMissing(): boolean;

  timersPaused(): boolean;
  uploads: MobileAttachmentUploadPort;


  preparePlaintextDownload?: (
    input: PreparedPlaintextDownloadInput,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ) => Promise<PreparedPlaintextDownloadSource>;
};

export const createMobileAttachmentCommon = (host: MobileAttachmentCommonHost) => {
  const { fs, files } = host;
  const preparePlaintextDownload = host.preparePlaintextDownload;
  let uploadSnapshotSequence = 0;
  let downloadStageSequence = 0;


  const logAttachmentByteRemoteRead = (input: SyncEncryptionRemoteReadLogInput): void => {
    void host.encryption.logSyncEncryptionEvent(SYNC_ENCRYPTION_LOG_EVENTS.remoteRead, buildSyncEncryptionRemoteReadExtra(input));
  };

  const assertEncryptionPosture = async (material: SyncKeyMaterial | null | undefined): Promise<void> =>
    assertSyncAttachmentEncryptionPosture(await host.encryption.getSyncEncryptionStatus(), material);


  const sealAttachmentBytesForUpload = async (
    bytes: Uint8Array,
    material: SyncKeyMaterial | null | undefined,
    artifact?: string | null,
  ): Promise<Uint8Array> => {
    await assertEncryptionPosture(material);
    if (material) {
      logAttachmentByteRemoteRead({ artifact: artifact ?? '', exists: null, kind: 'encrypted', decision: 'seal' });
      return encryptSyncArtifact(bytes, material, host.crypto, { kind: 'attachment', cloudKey: artifact ?? '' });
    }
    logAttachmentByteRemoteRead({ artifact: artifact ?? '', exists: null, kind: 'plaintext', decision: 'seal' });
    return bytes;
  };


  const openAttachmentBytesFromDownload = async (
    bytes: Uint8Array,
    material: SyncKeyMaterial | null | undefined,
    artifact?: string | null,
  ): Promise<Uint8Array> => {
    await assertEncryptionPosture(material);
    if (!material) {


      if (inspectSyncArtifact(bytes).kind !== 'plaintext') {
        logAttachmentByteRemoteRead({ artifact: artifact ?? '', exists: true, kind: 'encrypted', decision: 'no-key' });
        throw new SyncEncryptionPartlyEncryptedError();
      }
      return bytes;
    }
    const inspected = inspectSyncArtifact(bytes);
    if (inspected.kind === 'plaintext') {
      throw new SyncEncryptionTerminalError(new SyncCryptoUnsupportedError('SYNC_ENCRYPTION_PLAINTEXT_ATTACHMENT: restore the attachment from a trusted local copy'));
    }
    if (inspected.kind === 'unsupported') {
      logAttachmentByteRemoteRead({ artifact: artifact ?? '', exists: true, kind: 'unsupported', decision: 'decrypt' });
      throw new SyncEncryptionTerminalError(new SyncCryptoUnsupportedError(inspected.reason));
    }
    logAttachmentByteRemoteRead({
      artifact: artifact ?? '',
      exists: true,
      kind: 'encrypted',
      headerSalt: inspected.salt,
      headerKdf: inspected.params,
      decision: 'decrypt',
    });
    return decryptRemoteArtifactOrThrow(bytes, material.key, host.crypto, { kind: 'attachment', cloudKey: artifact ?? '' });
  };

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

  const deleteAttachmentDownloadStageBestEffort = async (stagedPath: string): Promise<void> => {
    await fs.delete(stagedPath).catch(() => undefined);
  };

  const readAttachmentDownloadFileSnapshot = async (
    path: string,
  ): Promise<AttachmentDownloadFileSnapshot> => {
    const info = await fs.getInfo(path);
    if (!info.exists || typeof info.size !== 'number') {
      throw new Error('Attachment download scratch file is unavailable');
    }
    assertAttachmentDownloadSize(info.size);
    return {
      modificationTime: typeof info.modificationTime === 'number' ? info.modificationTime : null,
      size: info.size,
    };
  };


  const copyAttachmentDownloadToStage = async (
    attachment: Attachment,
    attachmentsDir: string,
    sourcePath: string,
  ): Promise<string> => {
    const stagedPath = buildAttachmentDownloadStagePath(attachmentsDir, attachment);
    const sourceBefore = await fs.getInfo(sourcePath)
      .then((info): AttachmentDownloadFileSnapshot | null => {
        if (!info.exists || typeof info.size !== 'number') return null;
        assertAttachmentDownloadSize(info.size);
        return {
          modificationTime: typeof info.modificationTime === 'number' ? info.modificationTime : null,
          size: info.size,
        };
      })
      .catch((error) => {
        if (error instanceof ResponseTooLargeError) throw error;
        return null;
      });
    let copied = false;
    try {
      await fs.copy(sourcePath, stagedPath);
      const staged = await readAttachmentDownloadFileSnapshot(stagedPath);
      if (sourceBefore) {
        const sourceAfter = await readAttachmentDownloadFileSnapshot(sourcePath);
        if (!snapshotsMatch(sourceBefore, sourceAfter) || sourceAfter.size !== staged.size) {
          throw new Error('File Sync attachment changed while staging');
        }
      }
      copied = true;
      return stagedPath;
    } finally {
      if (!copied) await deleteAttachmentDownloadStageBestEffort(stagedPath);
    }
  };


  const readAttachmentDownloadStageBytes = async (
    stagedPath: string,
  ): Promise<Uint8Array> => {
    const before = await readAttachmentDownloadFileSnapshot(stagedPath);
    const chunks: Uint8Array[] = [];
    let offset = 0;
    while (offset < before.size) {
      const length = Math.min(DOWNLOAD_READ_CHUNK_BYTES, before.size - offset);
      const chunk = await fs.readBytesRange(stagedPath, offset, length);
      if (chunk.byteLength !== length) {
        throw new Error('Attachment download scratch file changed while reading');
      }
      chunks.push(chunk);
      offset += chunk.byteLength;
    }
    const after = await readAttachmentDownloadFileSnapshot(stagedPath);
    if (!snapshotsMatch(before, after)) {
      throw new Error('Attachment download scratch file changed while reading');
    }
    const bytes = new Uint8Array(before.size);
    let resultOffset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, resultOffset);
      resultOffset += chunk.byteLength;
    }
    return bytes;
  };


  const installStagedAttachmentDownload = async ({
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
      const stagedBefore = await readAttachmentDownloadFileSnapshot(stagedPath);
      let actualStagedHash: string;
      if (isSha256Hex(expectedStagedHash)) {
        actualStagedHash = expectedStagedHash.toLowerCase();
        assertExpectedAttachmentDownloadHash(attachment, actualStagedHash);
      } else {
        const stagedBytes = await readAttachmentDownloadStageBytes(stagedPath);
        const computedStagedHash = await computeSha256Hex(stagedBytes);
        if (!computedStagedHash) throw new Error('Attachment download hash is unavailable');
        await validateAttachmentHash(attachment, stagedBytes);
        actualStagedHash = computedStagedHash;
      }
      const stagedAfter = await readAttachmentDownloadFileSnapshot(stagedPath);
      if (!snapshotsMatch(stagedBefore, stagedAfter)) {
        throw new Error('Attachment download scratch file changed before installation');
      }
      assertAttachmentSyncNotAborted(signal);
      nativeInstallStarted = true;
      let result: AttachmentFileInstallResult;
      try {
        result = await host.installer.installAttachmentFileGeneration(
          stagedPath,
          targetPath,
          expectation,
          actualStagedHash,
        );
      } catch (error) {


        if (!isInstallerUnavailableError(error) || !host.installerMayBeMissing()) throw error;
        nativeInstallStarted = false;
        result = installStagedDownloadWithoutNativeInstaller(stagedPath);
      }
      if (result.status !== 'installed') {
        reportProgress(
          attachment.id,
          'download',
          0,
          attachment.size ?? 0,
          'failed',
          'Attachment changed locally during download',
        );
        return false;
      }
      attachment.fileHash = actualStagedHash;
      await deleteAttachmentDownloadStageBestEffort(stagedPath);
      return true;
    } catch (error) {
      const installerUnavailable = error instanceof Error
        && (error as Error & { code?: unknown }).code === 'ATTACHMENT_FILE_INSTALLER_UNAVAILABLE';
      if (!nativeInstallStarted || installerUnavailable) {
        await deleteAttachmentDownloadStageBestEffort(stagedPath);
      }
      throw error;
    }
  };


  const installAttachmentDownloadBytes = async (
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
      await files.writeBytesSafely(stagedPath, bytes);
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


  const prepareAttachmentDownloadBytes = preparePlaintextDownload ? async (
    attachment: Attachment,
    targetURI: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<PreparedAttachmentDownloadBytes> => {
    assertAttachmentSyncNotAborted(signal);
    const size = bytes.byteLength;
    assertAttachmentDownloadSize(size);
    const sha256 = await computeSha256Hex(bytes);
    assertAttachmentSyncNotAborted(signal);
    if (!sha256) throw new Error('Attachment download hash is unavailable');
    assertExpectedAttachmentDownloadHash(attachment, sha256);
    const source = await preparePlaintextDownload({
      attachmentId: attachment.id,
      targetURI,
      expectation: { kind: 'absent' },
      sha256,
      size,
    }, bytes, signal);
    assertAttachmentSyncNotAborted(signal);
    if (!isPreparedPlaintextDownloadSource(source)) throw new Error('Attachment download source is invalid');
    return { kind: 'prepared-plaintext', sourceToken: source.sourceToken, sha256, size };
  } : undefined;

  const createMobileAttachmentUploadSnapshotWithLimit = async (
    sourcePath: string,
    attachment: Attachment,
    maxBufferedUploadBytes?: number,
    assertUploadStat?: AttachmentTransferLifecycleOptions['assertUploadStat'],
  ) => {
    const baseDir = fs.cacheDirectory() || fs.documentDirectory();
    if (!baseDir) return null;

    const sourceStatBefore = sourcePath.startsWith('content://')
      ? null
      : await files.statAttachmentFile(sourcePath);
    if (!sourcePath.startsWith('content://') && !sourceStatBefore && maxBufferedUploadBytes !== undefined) {
      throw new AttachmentUploadSizeUnavailableError();
    }
    if (sourceStatBefore && maxBufferedUploadBytes !== undefined) {
      assertBufferedAttachmentUploadSize(sourceStatBefore.size, maxBufferedUploadBytes);
    }

    const normalizedBaseDir = baseDir.endsWith('/') ? baseDir : `${baseDir}/`;
    uploadSnapshotSequence += 1;
    const stagedPath = `${normalizedBaseDir}mindwtr-upload-${Date.now()}-${uploadSnapshotSequence}-${attachment.id}`;
    let retainStagedFile = false;
    try {
      await fs.copy(sourcePath, stagedPath);
      const stagedStat = await files.statAttachmentFile(stagedPath);
      if (!stagedStat && maxBufferedUploadBytes !== undefined) {
        throw new AttachmentUploadSizeUnavailableError();
      }
      if (stagedStat && maxBufferedUploadBytes !== undefined) {
        assertBufferedAttachmentUploadSize(stagedStat.size, maxBufferedUploadBytes);
      }

      const hostHashed = Boolean(fs.sha256 && stagedStat);
      const [staged, sourceStatAfter] = await Promise.all([
        hostHashed
          ? files.computeAttachmentFileHash(stagedPath).then((fileHash) => ({ fileHash, size: stagedStat!.size }))
          : files.readFileAsBytes(stagedPath).then(async (stagedBytes) => {
            if (maxBufferedUploadBytes !== undefined) {
              assertBufferedAttachmentUploadSize(stagedBytes.byteLength, maxBufferedUploadBytes);
            }
            assertUploadStat?.({ size: stagedBytes.byteLength, mtimeMs: stagedStat?.mtimeMs ?? 0 });
            return { fileHash: await computeSha256Hex(stagedBytes), size: stagedBytes.byteLength };
          }),
        sourcePath.startsWith('content://') ? Promise.resolve(null) : files.statAttachmentFile(sourcePath),
      ]);
      const { fileHash } = staged;
      if (!fileHash) return null;
      if (
        sourceStatBefore
        && (
          !sourceStatAfter
          || sourceStatBefore.mtimeMs !== sourceStatAfter.mtimeMs
          || sourceStatBefore.size !== sourceStatAfter.size
          || sourceStatAfter.size !== staged.size
        )
      ) {
        return null;
      }

      retainStagedFile = true;
      return {
        sourcePath: stagedPath,
        fileHash,
        stat: sourceStatAfter ?? stagedStat ?? { mtimeMs: 0, size: staged.size },
        dispose: async () => {
          await fs.delete(stagedPath);
        },
      };
    } finally {
      if (!retainStagedFile) {
        await fs.delete(stagedPath).catch(() => undefined);
      }
    }
  };


  const createMobileAttachmentUploadSnapshot: NonNullable<
    AttachmentTransferLifecycleOptions['createUploadSnapshot']
  > = async (sourcePath, attachment) => createMobileAttachmentUploadSnapshotWithLimit(
    sourcePath,
    attachment,
  );


  async function runMobileAttachmentLifecycle(
    options: Omit<
      AttachmentTransferLifecycleOptions,
      'resolveLocalPath' | 'canUploadFrom' | 'createUploadSnapshot' | 'requireUploadSnapshot'
    > & { maxBufferedUploadBytes?: number }
  ): Promise<AttachmentTransferResult> {
    return await runAttachmentTransferLifecycle({
      ...options,
      resolveLocalPath: (uri) => uri,
      canUploadFrom: files.canUploadAttachmentFrom,
      createUploadSnapshot: (sourcePath, attachment) => createMobileAttachmentUploadSnapshotWithLimit(
        sourcePath,
        attachment,
        options.maxBufferedUploadBytes,
        options.assertUploadStat,
      ),
      requireUploadSnapshot: true,
    });
  }


  const prepareBespokeAttachmentContentCandidate = async (
    attachment: Attachment,
    localPath: string,
    maxBufferedUploadBytes?: number,
  ): Promise<boolean> => {
    if (
      attachment.pendingContentUpload === true
      && !isSha256Hex(attachment.fileHash?.trim().toLowerCase())
    ) {
      const snapshot = await createMobileAttachmentUploadSnapshotWithLimit(localPath, attachment, maxBufferedUploadBytes);
      if (!snapshot) return false;
      try {
        const snapshotHash = snapshot.fileHash.trim().toLowerCase();
        if (!isSha256Hex(snapshotHash)) return false;
        applyAttachmentContentStat(attachment, snapshot.stat, snapshotHash);
        return true;
      } finally {
        await snapshot.dispose().catch((error) => {
          files.logAttachmentWarn(`Failed to clean up attachment upload snapshot ${attachment.id}`, error);
        });
      }
    }
    const stat = await files.statAttachmentFile(localPath);
    if (!stat) {
      if (maxBufferedUploadBytes !== undefined) throw new AttachmentUploadSizeUnavailableError();
      return false;
    }
    const check = await checkAttachmentContentChange(
      attachment,
      stat,
      () => {
        if (maxBufferedUploadBytes !== undefined) assertBufferedAttachmentUploadSize(stat.size, maxBufferedUploadBytes);
        return files.computeAttachmentFileHash(localPath);
      },
    );
    if (!check.changed) {
      if (check.stat.mtimeMs === attachment.contentMtimeMs && check.stat.size === attachment.contentSize) {
        return false;
      }
      applyAttachmentContentStat(attachment, check.stat, check.hash);
      return true;
    }
    if (!check.hash) return false;
    if (isStaleCopyOfRemoteWinner(attachment, check.hash)) {


      logUninstalledRemoteWinner(attachment);
      return false;
    }
    applyAttachmentContentStat(attachment, check.stat, check.hash);
    attachment.contentRev = bumpAttachmentContentRevision(attachment);
    attachment.pendingContentUpload = true;
    return true;
  };


  const pendingBespokeAttachmentContentStillMatches = async (
    attachment: Attachment,
    localPath: string,
  ): Promise<boolean> => {
    const stat = await files.statAttachmentFile(localPath);
    if (!stat) return false;
    const check = await checkAttachmentContentChange(
      attachment,
      stat,
      () => files.computeAttachmentFileHash(localPath),
    );
    if (check.changed) return false;
    if (check.stat.mtimeMs !== attachment.contentMtimeMs || check.stat.size !== attachment.contentSize) {
      applyAttachmentContentStat(attachment, check.stat, check.hash);
    }
    return true;
  };


  const checkBespokeAttachmentRemoteWinner = async (
    attachment: Attachment,
    localPath: string,
    maxBufferedUploadBytes?: number,
  ): Promise<BespokeAttachmentRemoteWinnerCheck> => {
    if (attachment.pendingContentUpload === true) {
      return { kind: 'none', metadataChanged: false };
    }

    const stat = await files.statAttachmentFile(localPath);
    if (!stat) {
      if (maxBufferedUploadBytes !== undefined) throw new AttachmentUploadSizeUnavailableError();
      return { kind: 'none', metadataChanged: false };
    }
    const check = await checkAttachmentContentChange(
      attachment,
      stat,
      () => {
        if (maxBufferedUploadBytes !== undefined) assertBufferedAttachmentUploadSize(stat.size, maxBufferedUploadBytes);
        return files.computeAttachmentFileHash(localPath);
      },
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

    const restat = await files.statAttachmentFile(localPath);
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


  const refreshBespokeAttachmentDownloadedContentStat = async (
    attachment: Attachment,
    localPath: string,
  ): Promise<boolean> => {

    attachment.staleContentHash = undefined;
    const expectedRemoteHash = attachment.fileHash?.trim().toLowerCase();
    if (!isSha256Hex(expectedRemoteHash)) return false;
    const stat = await files.statAttachmentFile(localPath);
    if (!stat) return false;
    const hash = await files.computeAttachmentFileHash(localPath);
    const restat = await files.statAttachmentFile(localPath);
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


  const migrateAttachmentsLocallyBeforeSync = async (
    attachmentsById: Map<string, Attachment>,
    signal?: AbortSignal,
    maxBufferedUploadBytes?: number,
    assertUploadStat?: AttachmentTransferLifecycleOptions['assertUploadStat'],
  ): Promise<Map<string, Attachment>> => {
    const migrateAttachmentLocally = files.createAttachmentLocalMigrationLimiter();
    const patches = new Map<string, Attachment>();
    for (const original of attachmentsById.values()) {
      assertAttachmentSyncNotAborted(signal);
      if (original.kind !== 'file' || original.deletedAt) continue;
      const attachment: Attachment = { ...original };
      if (files.attachmentNeedsManagedLocalCopy(attachment)) {
        const presence = await files.getLocalAttachmentPresence(attachment.uri || '');
        if (presence === 'unreadable') {
          attachmentsById.delete(attachment.id);
          continue;
        }
        if (presence === 'confirmed-not-found') continue;
        if (maxBufferedUploadBytes !== undefined || assertUploadStat) {
          const stat = await files.statAttachmentFile(attachment.uri || '');
          assertUploadStat?.(stat);
          if (maxBufferedUploadBytes !== undefined) {
            assertBufferedAttachmentUploadSize(stat?.size ?? NaN, maxBufferedUploadBytes);
          }
        }
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


  const reconcileRemoteAttachmentPresence = async (options: {
    label: string;
    attachmentsById: Map<string, Attachment>;


    createProbe: () => Promise<((attachment: Attachment) => Promise<boolean | null>) | null>;
    recordPatch: (attachment: Attachment) => void;
    maxChecks?: number;
    signal?: AbortSignal;
  }): Promise<boolean> => {
    const candidates: Attachment[] = [];
    for (const original of options.attachmentsById.values()) {
      assertAttachmentSyncNotAborted(options.signal);
      if (!isAttachmentPresenceRepairCandidate(original)) continue;
      const uri = original.uri || '';
      if (!uri || isHttpAttachmentUri(uri) || !files.canUploadAttachmentFrom(uri)) continue;
      if (await files.getLocalAttachmentPresence(uri) !== 'present') continue;
      candidates.push(original);
    }
    if (candidates.length === 0) return true;

    const probe = await options.createProbe();
    if (!probe) return false;

    const result = await repairMissingRemoteAttachments({
      candidates,
      probe,
      clear: (original) => options.recordPatch({ ...original, cloudKey: undefined }),
      maxChecks: options.maxChecks,
      log: files.logAttachmentInfo,
    });
    files.logAttachmentInfo(`${options.label} attachment presence pass`, {
      checked: String(result.checked),
      cleared: String(result.cleared),
      complete: result.complete ? 'true' : 'false',
    });
    return result.complete;
  };

  const waitForAttachmentSyncDelay = async (ms: number, signal?: AbortSignal): Promise<void> => {
    assertAttachmentSyncNotAborted(signal);
    if (ms <= 0) return;


    if (host.timersPaused()) return;
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

  const runUploadTask = async <T,>(
    task: { uploadAsync: () => Promise<T> },
    signal?: AbortSignal,
    timeoutMs?: number,
    timeoutMessage = 'Streamed upload timed out',
  ): Promise<T> => {
    await assertEncryptionPosture(null);
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


      };
      onAbort = () => beginCancellation(createUploadAbortError(signal));

      signal?.addEventListener('abort', onAbort, { once: true });


      if (timeoutMs !== undefined && !host.timersPaused()) {
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

  const createProgressListener = (
    onProgress: ((sent: number, total: number) => void) | undefined,
    totalBytes: number | undefined,
  ) => (event: MobileAttachmentUploadProgressEvent) => {
    if (!onProgress) return;
    const sent = Number(event.totalBytesSent ?? 0);
    const expected = Number(event.totalBytesExpectedToSend ?? totalBytes ?? 0);
    if (expected > 0) {
      onProgress(sent, expected);
    }
  };

  const uploadWebdavFileWithFileSystem = async (
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


    assertMobileWebdavConnection(url, allowInsecureHttp);
    await assertEncryptionPosture(null);
    assertUploadNotAborted(signal);
    if (!fileUri.startsWith('file://')) return false;


    if (expectedEtag !== null) return false;

    const authHeader = buildBasicAuthHeader(username, password);
    const headers: Record<string, string> = {
      'Content-Type': contentType || DEFAULT_ATTACHMENT_CONTENT_TYPE,
      'If-None-Match': '*',
    };
    if (authHeader) headers.Authorization = authHeader;


    const task = host.uploads.createUploadTask(
      url,
      fileUri,
      { httpMethod: 'PUT', headers },
      createProgressListener(onProgress, totalBytes),
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
  };

  return {
    assertEncryptionPosture,
    sealAttachmentBytesForUpload,
    openAttachmentBytesFromDownload,
    deleteAttachmentDownloadStageBestEffort,
    copyAttachmentDownloadToStage,
    readAttachmentDownloadStageBytes,
    installStagedAttachmentDownload,
    installAttachmentDownloadBytes,
    ...(prepareAttachmentDownloadBytes ? { prepareAttachmentDownloadBytes } : {}),

    createAttachmentDownloadStagePath: buildAttachmentDownloadStagePath,
    createMobileAttachmentUploadSnapshot,
    createMobileAttachmentUploadSnapshotWithLimit,
    runMobileAttachmentLifecycle,
    prepareBespokeAttachmentContentCandidate,
    pendingBespokeAttachmentContentStillMatches,
    checkBespokeAttachmentRemoteWinner,
    refreshBespokeAttachmentDownloadedContentStat,
    migrateAttachmentsLocallyBeforeSync,
    reconcileRemoteAttachmentPresence,
    waitForAttachmentSyncDelay,
    uploadWebdavFileWithFileSystem,
  };
};

export type MobileAttachmentCommon = ReturnType<typeof createMobileAttachmentCommon>;
