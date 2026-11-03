import { describe, expect, it, vi } from 'vitest';
import { createMobileAttachmentInstaller, type NativeAttachmentFileInstaller } from './mobile-attachment-installer';
import { SyncFileGenerationCorruptError } from './sync-service-utils';
import { createMemoryStorage, createRecordingLog } from './__fixtures__/mobile-attachment-fakes';

const RESERVATIONS_KEY = '@mindwtr/file-sync-publication-reservations-v1';
const digest = 'd'.repeat(64);
const target = `file:///sync/attachments/a1.${digest}.txt`;

const createNative = () => {
  const native = {
    installAsync: vi.fn(async (): Promise<unknown> => ({ status: 'installed' })),
    publishImmutableAsync: vi.fn(async (): Promise<unknown> => ({ status: 'published' })),
    prepareImmutableStageAsync: vi.fn(async (targetPath: string, operationId: string): Promise<unknown> => ({
      stagedPath: `${targetPath.slice(0, targetPath.lastIndexOf('/') + 1)}.mindwtr-install-${operationId}.candidate/stage`,
      stagedIdentity: 'stage:1',
      directoryIdentity: 'dir:1',
      privateDirectoryIdentity: 'private:1',
    })),
    snapshotImmutableStageAsync: vi.fn(async (): Promise<unknown> => ({ stagedIdentity: 'stage:1', directoryIdentity: 'dir:1' })),
    cleanupImmutableStageAsync: vi.fn(async (): Promise<unknown> => ({ status: 'removed' })),
    hashAsync: vi.fn(async (): Promise<unknown> => ({ sha256: digest, size: 3, modificationTimeMs: 1 })),
  };
  return native;
};

const setup = (options: { loadNativeModule?: () => NativeAttachmentFileInstaller } = {}) => {
  const native = createNative();
  const { storage, values } = createMemoryStorage();
  const { log, lines } = createRecordingLog();
  const loadNativeModule = vi.fn(options.loadNativeModule ?? (() => native));
  const installer = createMobileAttachmentInstaller({ loadNativeModule, storage, log });
  const records = () => JSON.parse(values.get(RESERVATIONS_KEY) ?? '[]') as Record<string, unknown>[];
  return { installer, native, values, lines, loadNativeModule, records };
};

describe('mobile attachment installer: install', () => {
  it('normalizes paths and hashes before the native install', async () => {
    const { installer, native } = setup();

    await expect(installer.installAttachmentFileGeneration(' file:///cache/stage ', ' file:///files/attachments/a1 ', { kind: 'present', sha256: 'A'.repeat(64) }, digest.toUpperCase()))
      .resolves.toEqual({ status: 'installed' });
    expect(native.installAsync).toHaveBeenCalledWith('file:///cache/stage', 'file:///files/attachments/a1', { kind: 'present', sha256: 'a'.repeat(64) }, digest);
  });

  it('refuses a malformed hash without touching the native installer', async () => {
    const { installer, native } = setup();

    await expect(installer.installAttachmentFileGeneration('file:///s', 'file:///t', { kind: 'absent' }, 'nope')).rejects.toThrow('SHA-256');
    expect(native.installAsync).not.toHaveBeenCalled();
  });

  it('logs the exclusive-copy fallback with its release check', async () => {
    const { installer, native, lines } = setup();
    native.installAsync.mockResolvedValueOnce({ status: 'installed', publication: 'exclusive-copy' });

    await installer.installAttachmentFileGeneration('file:///s', 'file:///t', { kind: 'absent' }, digest);

    expect(lines).toEqual([expect.objectContaining({
      extra: { releaseCheck: 'v1.2.7/android-attachment-link-fallback', publication: 'exclusive-copy' },
    })]);
  });

  it('keeps a native conflict\'s preserved path and rejects an invalid result', async () => {
    const { installer, native } = setup();
    native.installAsync.mockResolvedValueOnce({ status: 'conflict', preservedPath: 'file:///files/attachments/.mindwtr-install-x.quarantine' });
    native.installAsync.mockResolvedValueOnce({ status: 'conflict' });

    await expect(installer.installAttachmentFileGeneration('file:///s', 'file:///t', { kind: 'absent' }, digest))
      .resolves.toEqual({ status: 'conflict', preservedPath: 'file:///files/attachments/.mindwtr-install-x.quarantine' });
    await expect(installer.installAttachmentFileGeneration('file:///s', 'file:///t', { kind: 'absent' }, digest))
      .rejects.toThrow('invalid result');
  });

  it('loads the native module once and latches its absence', async () => {
    const { installer, loadNativeModule } = setup({ loadNativeModule: () => { throw new Error('Cannot find native module'); } });

    for (let i = 0; i < 2; i += 1) {
      await expect(installer.hashAttachmentFileGeneration('file:///t')).rejects.toMatchObject({ code: 'ATTACHMENT_FILE_INSTALLER_UNAVAILABLE' });
    }
    expect(loadNativeModule).toHaveBeenCalledTimes(1);
  });
});

describe('mobile attachment installer: File Sync publication journal', () => {
  it('records the reservation before native code creates the stage, then binds its identity', async () => {
    const { installer, native, records, values } = setup();
    native.prepareImmutableStageAsync.mockImplementationOnce(async (targetPath: string, operationId: string) => {

      expect(JSON.parse(values.get(RESERVATIONS_KEY)!)).toEqual([expect.objectContaining({ operationId, state: 'reserved', stagedIdentity: null })]);
      return {
        stagedPath: `${targetPath.slice(0, targetPath.lastIndexOf('/') + 1)}.mindwtr-install-${operationId}.candidate/stage`,
        stagedIdentity: 'stage:1',
        directoryIdentity: 'dir:1',
        privateDirectoryIdentity: 'private:1',
      };
    });

    const reservation = await installer.reserveFileSyncAttachmentPublication(target, digest);

    expect(reservation.stagedPath).toBe(`file:///sync/attachments/.mindwtr-install-${reservation.operationId}.candidate/stage`);
    expect(records()).toEqual([expect.objectContaining({ version: 3, stagedIdentity: 'stage:1', privateDirectoryIdentity: 'private:1' })]);
    await installer.claimFileSyncAttachmentPublication(reservation);
    await expect(installer.publishImmutableAttachmentFileGeneration(reservation.stagedPath, target, digest)).resolves.toEqual({ status: 'published' });
    await installer.completeFileSyncAttachmentPublication(reservation);
    expect(native.cleanupImmutableStageAsync).toHaveBeenCalledTimes(1);
    expect(values.has(RESERVATIONS_KEY)).toBe(false);
  });

  it('refuses a retry until recovery has settled an open reservation', async () => {
    const { installer, native, records } = setup();
    native.prepareImmutableStageAsync.mockRejectedValueOnce(new Error('process killed'));

    await expect(installer.reserveFileSyncAttachmentPublication(target, digest)).rejects.toThrow('process killed');
    expect(records()).toEqual([expect.objectContaining({ state: 'reserved' })]);
    await expect(installer.reserveFileSyncAttachmentPublication(target, digest)).rejects.toThrow('requires recovery');

    await installer.recoverFileSyncAttachmentPublications('file:///elsewhere/attachments');
    expect(records()).toHaveLength(1);
    await installer.recoverFileSyncAttachmentPublications('file:///sync/attachments');
    expect(records()).toEqual([]);
    await expect(installer.reserveFileSyncAttachmentPublication(target, digest)).resolves.toMatchObject({ targetPath: target });
  });

  it('keeps the journal entry when recovery finds a different generation', async () => {
    const { installer, native, records } = setup();
    native.prepareImmutableStageAsync.mockRejectedValueOnce(new Error('process killed'));
    await expect(installer.reserveFileSyncAttachmentPublication(target, digest)).rejects.toThrow();
    native.cleanupImmutableStageAsync.mockResolvedValueOnce({ status: 'conflict' });

    await expect(installer.recoverFileSyncAttachmentPublications('file:///sync/attachments')).rejects.toThrow('different generation');
    expect(records()).toHaveLength(1);
  });

  it('gives up on a target after three invalid generations', async () => {
    const { installer } = setup();
    for (let i = 0; i < 3; i += 1) {
      const reservation = await installer.reserveFileSyncAttachmentPublication(target, digest);
      await installer.retainFileSyncAttachmentPublicationForInvalidTarget(reservation);
      await installer.recoverFileSyncAttachmentPublications('file:///sync/attachments');
    }

    await expect(installer.reserveFileSyncAttachmentPublication(target, digest)).rejects.toBeInstanceOf(SyncFileGenerationCorruptError);
    await installer.clearFileSyncAttachmentPublicationRecovery(target);
    await expect(installer.reserveFileSyncAttachmentPublication(target, digest)).resolves.toMatchObject({ targetPath: target });
  });

  it('fails closed on an unreadable journal', async () => {
    const { installer, values, native } = setup();
    values.set(RESERVATIONS_KEY, '{not json');

    await expect(installer.recoverFileSyncAttachmentPublications('file:///sync/attachments')).rejects.toThrow('unreadable');
    expect(native.cleanupImmutableStageAsync).not.toHaveBeenCalled();
    expect(values.get(RESERVATIONS_KEY)).toBe('{not json');
  });
});
