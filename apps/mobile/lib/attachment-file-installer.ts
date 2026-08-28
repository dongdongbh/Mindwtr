import { requireNativeModule } from 'expo-modules-core';
import { SyncFileGenerationCorruptError } from '@mindwtr/core';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type AttachmentFileExpectedGeneration =
  | { kind: 'absent' }
  | { kind: 'present'; sha256: string };

export type AttachmentFileInstallResult =
  | { status: 'installed'; preservedPath?: string }
  | { status: 'conflict'; preservedPath: string };

export type AttachmentFileHashSnapshot = {
  sha256: string;
  size: number;
  modificationTimeMs: number;
};

export type ImmutableAttachmentFilePublishResult =
  | { status: 'published' }
  | { status: 'alreadyExists' };

export type FileSyncAttachmentPublicationReservation = {
  operationId: string;
  stagedPath: string;
  targetPath: string;
};

type NativeOwnedStageIdentity = {
  stagedIdentity: string;
  directoryIdentity: string;
};

type NativePreparedStageIdentity = NativeOwnedStageIdentity & {
  privateDirectoryIdentity: string;
  stagedPath: string;
};

type NativeAttachmentFileInstaller = {
  installAsync(
    stagedPath: string,
    targetPath: string,
    expected: { kind: 'absent' } | { kind: 'present'; sha256: string },
    expectedDownloadSha256: string,
  ): Promise<unknown>;
  publishImmutableAsync(
    stagedPath: string,
    targetPath: string,
    expectedStagedSha256: string,
    expectedStagedIdentity: string,
    expectedDirectoryIdentity: string,
    expectedPrivateDirectoryIdentity: string,
  ): Promise<unknown>;
  prepareImmutableStageAsync(
    targetPath: string,
    operationId: string,
  ): Promise<unknown>;
  snapshotImmutableStageAsync(
    stagedPath: string,
    targetPath: string,
    expectedStagedSha256: string,
  ): Promise<unknown>;
  cleanupImmutableStageAsync(
    stagedPath: string,
    targetPath: string,
    operationId: string,
    expectedStagedSha256: string | null,
    expectedStagedIdentity: string | null,
    expectedDirectoryIdentity: string | null,
    expectedPrivateDirectoryIdentity: string | null,
  ): Promise<unknown>;
  hashAsync(path: string): Promise<unknown>;
};

export class AttachmentFileInstallerUnavailableError extends Error {
  readonly code = 'ATTACHMENT_FILE_INSTALLER_UNAVAILABLE';

  constructor(cause?: unknown) {
    super('Attachment file installer native module is unavailable');
    this.name = 'AttachmentFileInstallerUnavailableError';
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

let resolvedModule: NativeAttachmentFileInstaller | null | undefined;
let resolutionError: AttachmentFileInstallerUnavailableError | undefined;

const getNativeModule = (): NativeAttachmentFileInstaller => {
  if (resolvedModule) return resolvedModule;
  if (resolvedModule === null) {
    throw resolutionError ?? new AttachmentFileInstallerUnavailableError();
  }
  try {
    resolvedModule = requireNativeModule<NativeAttachmentFileInstaller>('AttachmentFileInstaller');
  } catch (error) {
    resolvedModule = null;
    resolutionError = new AttachmentFileInstallerUnavailableError(error);
    throw resolutionError;
  }
  return resolvedModule;
};

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const FILE_SYNC_PUBLICATION_RESERVATIONS_KEY = '@mindwtr/file-sync-publication-reservations-v1';
const FILE_SYNC_PUBLICATION_STAGE_PREFIX = '.mindwtr-generation-stage-';
const FILE_SYNC_PUBLICATION_PRIVATE_PREFIX = '.mindwtr-install-';
const FILE_SYNC_PUBLICATION_PRIVATE_SUFFIX = '.candidate';
const FILE_SYNC_PUBLICATION_MAX_RESERVATIONS = 128;
const FILE_SYNC_PUBLICATION_MAX_INVALID_TARGET_ATTEMPTS = 3;

type FileSyncPublicationReservationRecord = {
  version: 2 | 3;
  operationId: string | null;
  stagedPath: string | null;
  targetPath: string;
  expectedStagedSha256: string | null;
  stagedIdentity: string | null;
  directoryIdentity: string | null;
  privateDirectoryIdentity: string | null;
  invalidTargetAttempts: number;
  state: 'reserved' | 'invalid-target';
};

let reservationQueue: Promise<void> = Promise.resolve();

const withReservationLock = async <T>(operation: () => Promise<T>): Promise<T> => {
  const previous = reservationQueue;
  let release!: () => void;
  reservationQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
};

const parentPath = (path: string): string => {
  const separator = path.lastIndexOf('/') + 1;
  if (separator <= 0) throw new Error('File Sync attachment target parent is unavailable');
  return path.slice(0, separator);
};

const parseReservationRecords = (raw: string | null): FileSyncPublicationReservationRecord[] => {
  if (raw == null) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error('File Sync attachment publication recovery state is unreadable', { cause: error });
  }
  if (!Array.isArray(value) || value.length > FILE_SYNC_PUBLICATION_MAX_RESERVATIONS) {
    throw new Error('File Sync attachment publication recovery state is invalid');
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error('File Sync attachment publication recovery state is invalid');
    }
    const record = entry as Record<string, unknown>;
    if (
      (record.version !== 1 && record.version !== 2 && record.version !== 3)
      || typeof record.targetPath !== 'string'
      || !record.targetPath.startsWith('file://')
      || (record.operationId !== null && typeof record.operationId !== 'string')
      || (record.stagedPath !== null && typeof record.stagedPath !== 'string')
      || (record.expectedStagedSha256 !== null && (
        typeof record.expectedStagedSha256 !== 'string'
        || !SHA256_HEX_PATTERN.test(record.expectedStagedSha256)
      ))
      || (record.version !== 1 && record.stagedIdentity !== null && typeof record.stagedIdentity !== 'string')
      || (record.version !== 1 && record.directoryIdentity !== null && typeof record.directoryIdentity !== 'string')
      || (record.version === 3 && record.privateDirectoryIdentity !== null
        && typeof record.privateDirectoryIdentity !== 'string')
      || !Number.isInteger(record.invalidTargetAttempts)
      || (record.invalidTargetAttempts as number) < 0
      || (record.state !== 'reserved' && record.state !== 'invalid-target')
    ) {
      throw new Error('File Sync attachment publication recovery state is invalid');
    }
    const operationId = record.operationId as string | null;
    const stagedPath = record.stagedPath as string | null;
    if (
      (record.state === 'reserved' && (!operationId || !stagedPath || !record.expectedStagedSha256))
      || (record.state === 'invalid-target' && ((operationId == null) !== (stagedPath == null)))
      || (stagedPath != null && (record.version === 3
        ? stagedPath !== `${parentPath(record.targetPath)}${FILE_SYNC_PUBLICATION_PRIVATE_PREFIX}${operationId}${FILE_SYNC_PUBLICATION_PRIVATE_SUFFIX}/stage`
        : parentPath(stagedPath) !== parentPath(record.targetPath)
          || stagedPath !== `${parentPath(record.targetPath)}${FILE_SYNC_PUBLICATION_STAGE_PREFIX}${operationId}.tmp`))
      || (record.version !== 1 && ((record.stagedIdentity == null) !== (record.directoryIdentity == null)))
      || (record.version === 3 && record.privateDirectoryIdentity != null && record.directoryIdentity == null)
    ) {
      throw new Error('File Sync attachment publication recovery state is invalid');
    }
    return {
      ...(record as Omit<FileSyncPublicationReservationRecord, 'version' | 'stagedIdentity' | 'directoryIdentity' | 'privateDirectoryIdentity'>),
      version: record.version === 3 ? 3 : 2,
      stagedIdentity: record.version !== 1 ? record.stagedIdentity as string | null : null,
      directoryIdentity: record.version !== 1 ? record.directoryIdentity as string | null : null,
      privateDirectoryIdentity: record.version === 3
        ? record.privateDirectoryIdentity as string | null
        : null,
    };
  });
};

const loadReservationRecords = async (): Promise<FileSyncPublicationReservationRecord[]> =>
  parseReservationRecords(await AsyncStorage.getItem(FILE_SYNC_PUBLICATION_RESERVATIONS_KEY));

const storeReservationRecords = async (records: FileSyncPublicationReservationRecord[]): Promise<void> => {
  if (records.length === 0) {
    await AsyncStorage.removeItem(FILE_SYNC_PUBLICATION_RESERVATIONS_KEY);
    return;
  }
  await AsyncStorage.setItem(FILE_SYNC_PUBLICATION_RESERVATIONS_KEY, JSON.stringify(records));
};

const parseNativeOwnedStageIdentity = (value: unknown): NativeOwnedStageIdentity => {
  if (!value || typeof value !== 'object') {
    throw new Error('Attachment file publisher returned an invalid stage identity');
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.stagedIdentity !== 'string'
    || candidate.stagedIdentity.length === 0
    || typeof candidate.directoryIdentity !== 'string'
    || candidate.directoryIdentity.length === 0
  ) {
    throw new Error('Attachment file publisher returned an invalid stage identity');
  }
  return {
    stagedIdentity: candidate.stagedIdentity,
    directoryIdentity: candidate.directoryIdentity,
  };
};

const parseNativePreparedStageIdentity = (value: unknown): NativePreparedStageIdentity => {
  const identity = parseNativeOwnedStageIdentity(value);
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.privateDirectoryIdentity !== 'string'
    || candidate.privateDirectoryIdentity.length === 0
    || typeof candidate.stagedPath !== 'string'
    || !candidate.stagedPath.startsWith('file://')
  ) {
    throw new Error('Attachment file publisher returned an invalid private stage identity');
  }
  return {
    ...identity,
    privateDirectoryIdentity: candidate.privateDirectoryIdentity,
    stagedPath: candidate.stagedPath,
  };
};

const cleanupReservationStage = async (
  record: FileSyncPublicationReservationRecord,
): Promise<'removed' | 'missing'> => {
  if (!record.stagedPath || !record.operationId) return 'missing';
  const value = await getNativeModule().cleanupImmutableStageAsync(
    record.stagedPath,
    record.targetPath,
    record.operationId,
    record.expectedStagedSha256,
    record.stagedIdentity,
    record.directoryIdentity,
    record.privateDirectoryIdentity,
  );
  if (!value || typeof value !== 'object') {
    throw new Error('Attachment file publisher returned an invalid cleanup result');
  }
  const result = value as Record<string, unknown>;
  if (result.status === 'removed' || result.status === 'missing') return result.status;
  if (result.status === 'conflict') {
    throw new Error('File Sync attachment publication recovery found a different generation');
  }
  throw new Error('Attachment file publisher returned an invalid cleanup result');
};

/** Recover only exact private publication namespaces previously reserved in
 * device-local state. The shared folder is deliberately never scanned. */
export const recoverFileSyncAttachmentPublications = async (
  attachmentsDirectoryPath: string,
): Promise<void> => withReservationLock(async () => {
  const normalizedDirectory = assertPath(attachmentsDirectoryPath, 'File Sync attachments directory');
  if (!normalizedDirectory.startsWith('file://')) return;
  const directory = normalizedDirectory.endsWith('/') ? normalizedDirectory : `${normalizedDirectory}/`;
  const records = await loadReservationRecords();
  const retained: FileSyncPublicationReservationRecord[] = [];
  for (const record of records) {
    if (parentPath(record.targetPath) !== directory) {
      retained.push(record);
      continue;
    }
    await cleanupReservationStage(record);
    if (record.state === 'invalid-target') {
      retained.push({
        ...record,
        operationId: null,
        stagedPath: null,
        expectedStagedSha256: null,
        stagedIdentity: null,
        directoryIdentity: null,
        privateDirectoryIdentity: null,
      });
    }
  }
  await storeReservationRecords(retained);
});

/** Persist exact ownership before native code creates the private stage. */
export const reserveFileSyncAttachmentPublication = async (
  targetPath: string,
  expectedStagedSha256: string,
): Promise<FileSyncAttachmentPublicationReservation> => withReservationLock(async () => {
  const target = assertPath(targetPath, 'File Sync attachment target');
  if (!target.startsWith('file://')) throw new Error('File Sync attachment target must be a file URI');
  const digest = expectedStagedSha256.trim().toLowerCase();
  if (!SHA256_HEX_PATTERN.test(digest)) {
    throw new Error('Expected staged attachment SHA-256 must be 64 lowercase hexadecimal characters');
  }
  const records = await loadReservationRecords();
  const prior = records.find((record) => record.targetPath === target);
  if (prior?.state === 'reserved') {
    throw new Error('File Sync attachment publication requires recovery before retry');
  }
  const invalidTargetAttempts = prior?.invalidTargetAttempts ?? 0;
  if (invalidTargetAttempts >= FILE_SYNC_PUBLICATION_MAX_INVALID_TARGET_ATTEMPTS) {
    throw new SyncFileGenerationCorruptError();
  }
  const recordsWithoutTarget = records.filter((record) => record.targetPath !== target);
  if (recordsWithoutTarget.length >= FILE_SYNC_PUBLICATION_MAX_RESERVATIONS) {
    throw new Error('File Sync attachment publication recovery state has reached its entry limit');
  }
  const operationId = Array.from({ length: 4 }, () => Math.floor(Math.random() * 0x1_0000_0000)
    .toString(16).padStart(8, '0')).join('');
  const stagedPath = `${parentPath(target)}${FILE_SYNC_PUBLICATION_PRIVATE_PREFIX}${operationId}${FILE_SYNC_PUBLICATION_PRIVATE_SUFFIX}/stage`;
  const next: FileSyncPublicationReservationRecord = {
    version: 3,
    operationId,
    stagedPath,
    targetPath: target,
    expectedStagedSha256: digest,
    stagedIdentity: null,
    directoryIdentity: null,
    privateDirectoryIdentity: null,
    invalidTargetAttempts,
    state: 'reserved',
  };
  await storeReservationRecords([...recordsWithoutTarget, next]);
  const prepared = parseNativePreparedStageIdentity(
    await getNativeModule().prepareImmutableStageAsync(target, operationId),
  );
  if (prepared.stagedPath !== stagedPath) {
    throw new Error('Attachment file publisher prepared an unexpected private stage path');
  }
  await storeReservationRecords([...recordsWithoutTarget, {
    ...next,
    stagedIdentity: prepared.stagedIdentity,
    directoryIdentity: prepared.directoryIdentity,
    privateDirectoryIdentity: prepared.privateDirectoryIdentity,
  }]);
  return { operationId, stagedPath, targetPath: target };
});

/** Bind the durable reservation to the exact fully-written inode before native
 * publication. Recovery never deletes an unclaimed or replaced pathname. */
export const claimFileSyncAttachmentPublication = async (
  reservation: FileSyncAttachmentPublicationReservation,
): Promise<void> => withReservationLock(async () => {
  const records = await loadReservationRecords();
  const record = records.find((candidate) => candidate.targetPath === reservation.targetPath);
  if (
    !record
    || record.operationId !== reservation.operationId
    || record.stagedPath !== reservation.stagedPath
    || !record.expectedStagedSha256
  ) {
    throw new Error('File Sync attachment publication reservation no longer matches');
  }
  const identity = parseNativeOwnedStageIdentity(await getNativeModule().snapshotImmutableStageAsync(
    record.stagedPath,
    record.targetPath,
    record.expectedStagedSha256,
  ));
  if (
    record.stagedIdentity != null && identity.stagedIdentity !== record.stagedIdentity
    || record.directoryIdentity != null && identity.directoryIdentity !== record.directoryIdentity
  ) {
    throw new Error('File Sync attachment publication stage identity changed before claim');
  }
  await storeReservationRecords(records.map((candidate) => candidate === record ? {
    ...candidate,
    ...identity,
  } : candidate));
});

const settleReservation = async (
  reservation: FileSyncAttachmentPublicationReservation,
  outcome: 'complete' | 'abandon' | 'invalid-target',
): Promise<void> => withReservationLock(async () => {
  const records = await loadReservationRecords();
  const record = records.find((candidate) => candidate.targetPath === reservation.targetPath);
  if (
    !record
    || record.operationId !== reservation.operationId
    || record.stagedPath !== reservation.stagedPath
  ) {
    throw new Error('File Sync attachment publication reservation no longer matches');
  }
  if (outcome !== 'invalid-target') {
    await cleanupReservationStage(record);
  }
  const remaining = records.filter((candidate) => candidate !== record);
  if (outcome === 'invalid-target') {
    remaining.push({
      ...record,
      invalidTargetAttempts: record.invalidTargetAttempts + 1,
      state: 'invalid-target',
    });
  }
  await storeReservationRecords(remaining);
});

export const completeFileSyncAttachmentPublication = async (
  reservation: FileSyncAttachmentPublicationReservation,
): Promise<void> => settleReservation(reservation, 'complete');

export const abandonFileSyncAttachmentPublication = async (
  reservation: FileSyncAttachmentPublicationReservation,
): Promise<void> => settleReservation(reservation, 'abandon');

export const retainFileSyncAttachmentPublicationForInvalidTarget = async (
  reservation: FileSyncAttachmentPublicationReservation,
): Promise<void> => settleReservation(reservation, 'invalid-target');

/** Clear bounded-collision history only after the canonical target has been
 * independently verified as the requested immutable generation. */
export const clearFileSyncAttachmentPublicationRecovery = async (
  targetPath: string,
): Promise<void> => withReservationLock(async () => {
  const target = assertPath(targetPath, 'File Sync attachment target');
  const records = await loadReservationRecords();
  const matching = records.filter((record) => record.targetPath === target);
  for (const record of matching) {
    if (record.stagedPath) {
      await cleanupReservationStage(record);
    }
  }
  await storeReservationRecords(records.filter((record) => record.targetPath !== target));
});

const assertPath = (value: string, label: string): string => {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
};

const parseNativeResult = (value: unknown): AttachmentFileInstallResult => {
  if (!value || typeof value !== 'object') {
    throw new Error('Attachment file installer returned an invalid result');
  }
  const result = value as Record<string, unknown>;
  if (result.status === 'installed') {
    return typeof result.preservedPath === 'string' && result.preservedPath.trim()
      ? { status: 'installed', preservedPath: result.preservedPath }
      : { status: 'installed' };
  }
  if (
    result.status === 'conflict'
    && typeof result.preservedPath === 'string'
    && result.preservedPath.trim()
  ) {
    return { status: 'conflict', preservedPath: result.preservedPath };
  }
  throw new Error('Attachment file installer returned an invalid result');
};

const parseNativeHashSnapshot = (value: unknown): AttachmentFileHashSnapshot => {
  if (!value || typeof value !== 'object') {
    throw new Error('Attachment file installer returned an invalid hash snapshot');
  }
  const snapshot = value as Record<string, unknown>;
  const sha256 = typeof snapshot.sha256 === 'string' ? snapshot.sha256.trim().toLowerCase() : '';
  if (
    !SHA256_HEX_PATTERN.test(sha256)
    || typeof snapshot.size !== 'number'
    || !Number.isFinite(snapshot.size)
    || snapshot.size < 0
    || typeof snapshot.modificationTimeMs !== 'number'
    || !Number.isFinite(snapshot.modificationTimeMs)
    || snapshot.modificationTimeMs < 0
  ) {
    throw new Error('Attachment file installer returned an invalid hash snapshot');
  }
  return { sha256, size: snapshot.size, modificationTimeMs: snapshot.modificationTimeMs };
};

const parseNativePublishResult = (value: unknown): ImmutableAttachmentFilePublishResult => {
  if (!value || typeof value !== 'object') {
    throw new Error('Attachment file publisher returned an invalid result');
  }
  const status = (value as Record<string, unknown>).status;
  if (status === 'published' || status === 'alreadyExists') return { status };
  throw new Error('Attachment file publisher returned an invalid result');
};

export const installAttachmentFileGeneration = async (
  stagedPath: string,
  targetPath: string,
  expected: AttachmentFileExpectedGeneration,
  expectedDownloadSha256: string,
): Promise<AttachmentFileInstallResult> => {
  const normalizedStagedPath = assertPath(stagedPath, 'Staged attachment path');
  const normalizedTargetPath = assertPath(targetPath, 'Target attachment path');
  const normalizedExpected = expected.kind === 'present'
    ? { kind: 'present' as const, sha256: expected.sha256.trim().toLowerCase() }
    : { kind: 'absent' as const };
  if (normalizedExpected.kind === 'present' && !SHA256_HEX_PATTERN.test(normalizedExpected.sha256)) {
    throw new Error('Expected attachment SHA-256 must be 64 lowercase hexadecimal characters');
  }
  const normalizedDownloadSha256 = expectedDownloadSha256.trim().toLowerCase();
  if (!SHA256_HEX_PATTERN.test(normalizedDownloadSha256)) {
    throw new Error('Expected download SHA-256 must be 64 lowercase hexadecimal characters');
  }

  const result = await getNativeModule().installAsync(
    normalizedStagedPath,
    normalizedTargetPath,
    normalizedExpected,
    normalizedDownloadSha256,
  );
  return parseNativeResult(result);
};

/** Hash a managed canonical attachment in native code without materializing its
 * bytes in JS. The native side also binds the digest to a stable size/mtime
 * snapshot and rejects non-regular or out-of-root paths. */
export const hashAttachmentFileGeneration = async (
  path: string,
): Promise<AttachmentFileHashSnapshot> => {
  const value = await getNativeModule().hashAsync(assertPath(path, 'Attachment path'));
  return parseNativeHashSnapshot(value);
};

/** Publish an immutable File Sync generation from a verified same-directory
 * stage. Native code uses create-no-replace semantics; an existing target is
 * reported without modifying either path. */
export const publishImmutableAttachmentFileGeneration = async (
  stagedPath: string,
  targetPath: string,
  expectedStagedSha256: string,
): Promise<ImmutableAttachmentFilePublishResult> => {
  const digest = expectedStagedSha256.trim().toLowerCase();
  if (!SHA256_HEX_PATTERN.test(digest)) {
    throw new Error('Expected staged attachment SHA-256 must be 64 lowercase hexadecimal characters');
  }
  const staged = assertPath(stagedPath, 'Staged attachment path');
  const target = assertPath(targetPath, 'Target attachment path');
  return withReservationLock(async () => {
    const record = (await loadReservationRecords()).find((candidate) => (
      candidate.stagedPath === staged && candidate.targetPath === target
    ));
    if (
      !record?.stagedIdentity
      || !record.directoryIdentity
      || !record.privateDirectoryIdentity
    ) {
      throw new Error('File Sync attachment publication identity is unavailable');
    }
    const result = await getNativeModule().publishImmutableAsync(
      staged,
      target,
      digest,
      record.stagedIdentity,
      record.directoryIdentity,
      record.privateDirectoryIdentity,
    );
    return parseNativePublishResult(result);
  });
};
