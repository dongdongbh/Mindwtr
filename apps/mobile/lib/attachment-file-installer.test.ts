import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installAttachmentFileGeneration } from './attachment-file-installer';

const { installAsync } = vi.hoisted(() => ({ installAsync: vi.fn() }));
const downloadHash = 'd'.repeat(64);

vi.mock('../modules/attachment-file-installer', () => ({
  default: { installAsync },
}));
describe('installAttachmentFileGeneration', () => {
  beforeEach(() => {
    installAsync.mockReset();
  });

  it('passes the absent generation contract to the native installer', async () => {
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
});
