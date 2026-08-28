import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SYNC_FILE_GENERATION_CORRUPT_CODE,
  SyncFileGenerationCorruptError,
} from '@mindwtr/core';
import {
  clearFileSyncAttachmentPublicationRecovery,
  claimFileSyncAttachmentPublication,
  recoverFileSyncAttachmentPublications,
  reserveFileSyncAttachmentPublication,
  retainFileSyncAttachmentPublicationForInvalidTarget,
  hashAttachmentFileGeneration,
  installAttachmentFileGeneration,
  publishImmutableAttachmentFileGeneration,
} from './attachment-file-installer';

const {
  cleanupImmutableStageAsync,
  deleteAsync,
  hashAsync,
  installAsync,
  prepareImmutableStageAsync,
  publishImmutableAsync,
  requireNativeModule,
  snapshotImmutableStageAsync,
  storage,
} = vi.hoisted(() => ({
  cleanupImmutableStageAsync: vi.fn(),
  deleteAsync: vi.fn(),
  hashAsync: vi.fn(),
  installAsync: vi.fn(),
  prepareImmutableStageAsync: vi.fn(),
  publishImmutableAsync: vi.fn(),
  requireNativeModule: vi.fn(() => ({
    cleanupImmutableStageAsync,
    hashAsync,
    installAsync,
    prepareImmutableStageAsync,
    publishImmutableAsync,
    snapshotImmutableStageAsync,
  })),
  snapshotImmutableStageAsync: vi.fn(),
  storage: new Map<string, string>(),
}));
const downloadHash = 'd'.repeat(64);

vi.mock('expo-modules-core', () => ({
  requireNativeModule,
}));
vi.mock('./file-system', () => ({
  deleteAsync,
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { storage.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { storage.delete(key); }),
  },
}));
describe('installAttachmentFileGeneration', () => {
  beforeEach(() => {
    storage.clear();
    deleteAsync.mockReset();
    deleteAsync.mockResolvedValue(undefined);
    installAsync.mockReset();
    hashAsync.mockReset();
    prepareImmutableStageAsync.mockReset();
    prepareImmutableStageAsync.mockImplementation(async (targetPath: string, operationId: string) => ({
      stagedPath: `${targetPath.slice(0, targetPath.lastIndexOf('/') + 1)}.mindwtr-install-${operationId}.candidate/stage`,
      stagedIdentity: 'stage-device:inode',
      directoryIdentity: 'directory-device:inode',
      privateDirectoryIdentity: 'private-device:inode',
    }));
    publishImmutableAsync.mockReset();
    snapshotImmutableStageAsync.mockReset();
    snapshotImmutableStageAsync.mockResolvedValue({
      stagedIdentity: 'stage-device:inode',
      directoryIdentity: 'directory-device:inode',
    });
    cleanupImmutableStageAsync.mockReset();
    cleanupImmutableStageAsync.mockResolvedValue({ status: 'missing' });
  });

  it('passes the absent generation contract to the native installer', async () => {
    expect(requireNativeModule).not.toHaveBeenCalled();
    installAsync.mockResolvedValue({ status: 'installed' });

    await expect(installAttachmentFileGeneration(
      ' file:///private/cache/candidate ',
      ' file:///private/documents/attachments/a1 ',
      { kind: 'absent' },
      downloadHash.toUpperCase(),
    )).resolves.toEqual({ status: 'installed' });

    expect(installAsync).toHaveBeenCalledWith(
      'file:///private/cache/candidate',
      'file:///private/documents/attachments/a1',
      { kind: 'absent' },
      downloadHash,
    );
    expect(requireNativeModule).toHaveBeenCalledWith('AttachmentFileInstaller');
  });

  it('normalizes the expected present hash and preserves a native conflict path', async () => {
    const expectedHash = 'A'.repeat(64);
    installAsync.mockResolvedValue({
      status: 'conflict',
      preservedPath: 'file:///private/documents/attachments/.mindwtr-install-a1.quarantine',
    });

    await expect(installAttachmentFileGeneration(
      'file:///private/cache/candidate',
      'file:///private/documents/attachments/a1',
      { kind: 'present', sha256: expectedHash },
      downloadHash,
    )).resolves.toEqual({
      status: 'conflict',
      preservedPath: 'file:///private/documents/attachments/.mindwtr-install-a1.quarantine',
    });
    expect(installAsync).toHaveBeenCalledWith(
      'file:///private/cache/candidate',
      'file:///private/documents/attachments/a1',
      { kind: 'present', sha256: 'a'.repeat(64) },
      downloadHash,
    );
  });

  it('rejects invalid input before invoking native code', async () => {
    await expect(installAttachmentFileGeneration('', '/target', { kind: 'absent' }, downloadHash))
      .rejects.toThrow('Staged attachment path is required');
    await expect(installAttachmentFileGeneration('/staged', '/target', {
      kind: 'present',
      sha256: 'not-a-hash',
    }, downloadHash)).rejects.toThrow('Expected attachment SHA-256');
    await expect(installAttachmentFileGeneration('/staged', '/target', { kind: 'absent' }, 'bad'))
      .rejects.toThrow('Expected download SHA-256');
    expect(installAsync).not.toHaveBeenCalled();
  });

  it('rejects malformed native outcomes', async () => {
    installAsync.mockResolvedValue({ status: 'conflict', preservedPath: '' });

    await expect(installAttachmentFileGeneration('/staged', '/target', { kind: 'absent' }, downloadHash))
      .rejects.toThrow('invalid result');
  });

  it('returns a normalized native streaming hash snapshot', async () => {
    hashAsync.mockResolvedValue({
      sha256: downloadHash.toUpperCase(),
      size: 42,
      modificationTimeMs: 1_234,
    });

    await expect(hashAttachmentFileGeneration(' file:///private/documents/attachments/a1 '))
      .resolves.toEqual({ sha256: downloadHash, size: 42, modificationTimeMs: 1_234 });
    expect(hashAsync).toHaveBeenCalledWith('file:///private/documents/attachments/a1');
  });

  it('publishes an immutable same-directory generation through native create-no-replace', async () => {
    publishImmutableAsync.mockResolvedValue({ status: 'alreadyExists' });
    const target = `file:///sync/attachments/a.${downloadHash}.txt`;
    const reservation = await reserveFileSyncAttachmentPublication(target, downloadHash);
    await claimFileSyncAttachmentPublication(reservation);

    await expect(publishImmutableAttachmentFileGeneration(
      ` ${reservation.stagedPath} `,
      ` ${target} `,
      downloadHash.toUpperCase(),
    )).resolves.toEqual({ status: 'alreadyExists' });
    expect(publishImmutableAsync).toHaveBeenCalledWith(
      reservation.stagedPath,
      target,
      downloadHash,
      'stage-device:inode',
      'directory-device:inode',
      'private-device:inode',
    );
  });

  it('records exact shared-folder scratch ownership before the caller creates it', async () => {
    const target = `file:///sync/attachments/a.${downloadHash}.txt`;

    const reservation = await reserveFileSyncAttachmentPublication(target, downloadHash);

    expect(reservation.targetPath).toBe(target);
    expect(reservation.stagedPath).toBe(
      `file:///sync/attachments/.mindwtr-install-${reservation.operationId}.candidate/stage`,
    );
    expect(prepareImmutableStageAsync).toHaveBeenCalledWith(target, reservation.operationId);
    expect(deleteAsync).not.toHaveBeenCalled();
    expect([...storage.values()].join('')).toContain(reservation.stagedPath);
  });

  it('recovers only the exact native-prepared private stage after a process dies', async () => {
    const target = `file:///sync/attachments/a.${downloadHash}.txt`;
    const reservation = await reserveFileSyncAttachmentPublication(target, downloadHash);

    await recoverFileSyncAttachmentPublications('file:///sync/attachments/');

    expect(cleanupImmutableStageAsync).toHaveBeenCalledWith(
      reservation.stagedPath,
      target,
      reservation.operationId,
      downloadHash,
      'stage-device:inode',
      'directory-device:inode',
      'private-device:inode',
    );
    expect(deleteAsync).not.toHaveBeenCalled();
    expect(storage.size).toBe(0);
  });

  it('persists the reservation before native private-stage preparation', async () => {
    const target = `file:///sync/attachments/a.${downloadHash}.txt`;
    prepareImmutableStageAsync.mockRejectedValueOnce(new Error('simulated process boundary'));

    await expect(reserveFileSyncAttachmentPublication(target, downloadHash))
      .rejects.toThrow('simulated process boundary');

    const persisted = JSON.parse([...storage.values()][0]!) as Record<string, unknown>[];
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      version: 3,
      targetPath: target,
      stagedIdentity: null,
      directoryIdentity: null,
      privateDirectoryIdentity: null,
    });
    await recoverFileSyncAttachmentPublications('file:///sync/attachments/');
    expect(cleanupImmutableStageAsync).toHaveBeenCalledWith(
      persisted[0]?.stagedPath,
      target,
      persisted[0]?.operationId,
      downloadHash,
      null,
      null,
      null,
    );
    expect(storage.size).toBe(0);
  });

  it('preserves recovery state when native cleanup finds a different generation', async () => {
    const target = `file:///sync/attachments/a.${downloadHash}.txt`;
    const reservation = await reserveFileSyncAttachmentPublication(target, downloadHash);
    snapshotImmutableStageAsync.mockResolvedValueOnce({
      stagedIdentity: 'stage-device:inode',
      directoryIdentity: 'directory-device:inode',
    });
    await claimFileSyncAttachmentPublication(reservation);
    cleanupImmutableStageAsync.mockResolvedValueOnce({ status: 'conflict' });

    await expect(recoverFileSyncAttachmentPublications('file:///sync/attachments/'))
      .rejects.toThrow('different generation');

    expect([...storage.values()].join('')).toContain('stage-device:inode');
    expect(deleteAsync).not.toHaveBeenCalled();
  });

  it('bounds repeated corrupt canonical collisions without accumulating shared scratches', async () => {
    const target = `file:///sync/attachments/a.${downloadHash}.txt`;
    const stages: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const reservation = await reserveFileSyncAttachmentPublication(target, downloadHash);
      stages.push(reservation.stagedPath);
      await claimFileSyncAttachmentPublication(reservation);
      await retainFileSyncAttachmentPublicationForInvalidTarget(reservation);
      cleanupImmutableStageAsync.mockResolvedValueOnce({ status: 'removed' });
      await recoverFileSyncAttachmentPublications('file:///sync/attachments/');
    }

    const terminalError = await reserveFileSyncAttachmentPublication(target, downloadHash)
      .then(() => null, (error: unknown) => error);
    expect(terminalError).toBeInstanceOf(SyncFileGenerationCorruptError);
    expect(terminalError).toMatchObject({
      code: SYNC_FILE_GENERATION_CORRUPT_CODE,
      message: expect.stringContaining('remains corrupt after bounded retries'),
    });
    expect(cleanupImmutableStageAsync).toHaveBeenCalledTimes(3);
    expect(deleteAsync).not.toHaveBeenCalled();

    await clearFileSyncAttachmentPublicationRecovery(target);
    await expect(reserveFileSyncAttachmentPublication(target, downloadHash))
      .resolves.toMatchObject({ targetPath: target });
  });

  it('rejects a distinct 129th reservation without poisoning persisted recovery state', async () => {
    const storageKey = '@mindwtr/file-sync-publication-reservations-v1';
    const records = Array.from({ length: 128 }, (_, index) => ({
      version: 1,
      operationId: null,
      stagedPath: null,
      targetPath: `file:///sync/attachments/a-${index}.${downloadHash}.txt`,
      expectedStagedSha256: null,
      invalidTargetAttempts: 1,
      state: 'invalid-target',
    }));
    const persisted = JSON.stringify(records);
    storage.set(storageKey, persisted);

    await expect(reserveFileSyncAttachmentPublication(
      `file:///sync/attachments/new.${downloadHash}.txt`,
      downloadHash,
    )).rejects.toThrow('recovery state has reached its entry limit');

    expect(storage.get(storageKey)).toBe(persisted);
    expect(JSON.parse(storage.get(storageKey)!)).toHaveLength(128);
    expect(deleteAsync).not.toHaveBeenCalled();
  });

  it('rejects malformed native hash snapshots', async () => {
    hashAsync.mockResolvedValue({ sha256: 'bad', size: 42, modificationTimeMs: 1_234 });

    await expect(hashAttachmentFileGeneration('/target')).rejects.toThrow('invalid hash snapshot');
  });

  it('latches a typed failure when the native module is unavailable', async () => {
    const callsBefore = requireNativeModule.mock.calls.length;
    requireNativeModule.mockImplementationOnce(() => {
      throw new Error('Cannot find native module');
    });
    vi.resetModules();
    const freshInstaller = await import('./attachment-file-installer');

    await expect(freshInstaller.installAttachmentFileGeneration(
      '/staged',
      '/target',
      { kind: 'absent' },
      downloadHash,
    )).rejects.toMatchObject({
      name: 'AttachmentFileInstallerUnavailableError',
      code: 'ATTACHMENT_FILE_INSTALLER_UNAVAILABLE',
    });
    await expect(freshInstaller.installAttachmentFileGeneration(
      '/staged',
      '/target',
      { kind: 'absent' },
      downloadHash,
    )).rejects.toMatchObject({
      code: 'ATTACHMENT_FILE_INSTALLER_UNAVAILABLE',
    });
    expect(requireNativeModule).toHaveBeenCalledTimes(callsBefore + 1);
  });
});
