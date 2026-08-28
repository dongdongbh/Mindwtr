import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hashAttachmentFileGeneration,
  installAttachmentFileGeneration,
  publishImmutableAttachmentFileGeneration,
} from './attachment-file-installer';

const { hashAsync, installAsync, publishImmutableAsync, requireNativeModule } = vi.hoisted(() => ({
  hashAsync: vi.fn(),
  installAsync: vi.fn(),
  publishImmutableAsync: vi.fn(),
  requireNativeModule: vi.fn(() => ({ hashAsync, installAsync, publishImmutableAsync })),
}));
const downloadHash = 'd'.repeat(64);

vi.mock('expo-modules-core', () => ({
  requireNativeModule,
}));
describe('installAttachmentFileGeneration', () => {
  beforeEach(() => {
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
