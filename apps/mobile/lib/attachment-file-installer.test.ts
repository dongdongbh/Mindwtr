import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearFileSyncAttachmentPublicationRecovery,
  recoverFileSyncAttachmentPublications,
  reserveFileSyncAttachmentPublication,
  retainFileSyncAttachmentPublicationForInvalidTarget,
  hashAttachmentFileGeneration,
  installAttachmentFileGeneration,
  publishImmutableAttachmentFileGeneration,
} from './attachment-file-installer';

const { deleteAsync, hashAsync, installAsync, publishImmutableAsync, requireNativeModule, storage } = vi.hoisted(() => ({
  deleteAsync: vi.fn(),
  hashAsync: vi.fn(),
  installAsync: vi.fn(),
  publishImmutableAsync: vi.fn(),
  requireNativeModule: vi.fn(() => ({ hashAsync, installAsync, publishImmutableAsync })),
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
    publishImmutableAsync.mockReset();
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

    await expect(publishImmutableAttachmentFileGeneration(
      ' file:///sync/attachments/.mindwtr-generation-stage-1.tmp ',
      ' file:///sync/attachments/a.hash.txt ',
      downloadHash.toUpperCase(),
    )).resolves.toEqual({ status: 'alreadyExists' });
    expect(publishImmutableAsync).toHaveBeenCalledWith(
      'file:///sync/attachments/.mindwtr-generation-stage-1.tmp',
      'file:///sync/attachments/a.hash.txt',
      downloadHash,
    );
  });

  it('records exact shared-folder scratch ownership before the caller creates it', async () => {
    const target = `file:///sync/attachments/a.${downloadHash}.txt`;

    const reservation = await reserveFileSyncAttachmentPublication(target, downloadHash);

    expect(reservation.targetPath).toBe(target);
    expect(reservation.stagedPath).toBe(
      `file:///sync/attachments/.mindwtr-generation-stage-${reservation.operationId}.tmp`,
    );
    expect(deleteAsync).not.toHaveBeenCalled();
    expect([...storage.values()].join('')).toContain(reservation.stagedPath);
  });

  it('recovers only the exact device-owned scratch after a process dies before native handoff', async () => {
    const target = `file:///sync/attachments/a.${downloadHash}.txt`;
    const reservation = await reserveFileSyncAttachmentPublication(target, downloadHash);

    await recoverFileSyncAttachmentPublications('file:///sync/attachments/');

    expect(deleteAsync).toHaveBeenCalledTimes(1);
    expect(deleteAsync).toHaveBeenCalledWith(reservation.stagedPath, { idempotent: true });
    expect(deleteAsync).not.toHaveBeenCalledWith(target, expect.anything());
    expect(storage.size).toBe(0);
  });

  it('bounds repeated corrupt canonical collisions without accumulating shared scratches', async () => {
    const target = `file:///sync/attachments/a.${downloadHash}.txt`;
    const stages: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const reservation = await reserveFileSyncAttachmentPublication(target, downloadHash);
      stages.push(reservation.stagedPath);
      await retainFileSyncAttachmentPublicationForInvalidTarget(reservation);
      await recoverFileSyncAttachmentPublications('file:///sync/attachments/');
    }

    await expect(reserveFileSyncAttachmentPublication(target, downloadHash))
      .rejects.toThrow('remains corrupt after bounded retries');
    expect(deleteAsync.mock.calls.map(([path]) => path)).toEqual(stages);
    expect(deleteAsync.mock.calls.some(([path]) => path === target)).toBe(false);

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
