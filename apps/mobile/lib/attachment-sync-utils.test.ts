import { describe, expect, it, vi, beforeEach } from 'vitest';

const fileSystemMock = vi.hoisted(() => ({
  __esModule: true,
  documentDirectory: 'file:///documents/',
  cacheDirectory: 'file:///cache/',
  makeDirectoryAsync: vi.fn(),
  readDirectoryAsync: vi.fn(),
  getInfoAsync: vi.fn(),
  writeAsStringAsync: vi.fn(),
  moveAsync: vi.fn(),
  deleteAsync: vi.fn(),
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  StorageAccessFramework: {},
}));

vi.mock('./file-system', () => fileSystemMock);

vi.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

// Static, not a per-test dynamic import: attachment-sync-utils.ts pulls in a heavy
// module graph, and paying that transform cost inside `it()` (as a dynamic import)
// counted against the per-test timeout and made this file flaky under a parallel
// full-suite run even though it passed reliably alone.
// eslint-disable-next-line import/first
import {
  cleanupAttachmentTempFiles,
  deleteManagedAttachmentFile,
  getLocalAttachmentPresence,
  writeBytesSafely,
} from './attachment-sync-utils';

describe('cleanupAttachmentTempFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileSystemMock.makeDirectoryAsync.mockResolvedValue(undefined);
    fileSystemMock.deleteAsync.mockResolvedValue(undefined);
  });

  it('removes only app-owned scratch files and preserves live temp-extension attachments', async () => {
    fileSystemMock.readDirectoryAsync.mockResolvedValue([
      '4b28a96e-1220-45ce-8a28-641a5b18d936.tmp',
      '5488a0f7-0c25-41a9-85db-85d33ef23c81.partial',
      '.mindwtr-attachment-write-m7v0x9k2-012345abcdef.tmp',
      '.mindwtr-attachment-write-invalid.tmp',
    ]);

    await cleanupAttachmentTempFiles();

    expect(fileSystemMock.deleteAsync).toHaveBeenCalledTimes(1);
    expect(fileSystemMock.deleteAsync).toHaveBeenCalledWith(
      'file:///documents/attachments/.mindwtr-attachment-write-m7v0x9k2-012345abcdef.tmp',
      { idempotent: true },
    );
  });
});

describe('getLocalAttachmentPresence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['file:///documents/attachment.txt', true, 'present'],
    ['content://provider/document/attachment', true, 'present'],
    ['content://provider/document/missing', false, 'confirmed-not-found'],
  ] as const)('classifies %s from an explicit exists result', async (uri, exists, expected) => {
    fileSystemMock.getInfoAsync.mockResolvedValueOnce({ exists });

    await expect(getLocalAttachmentPresence(uri)).resolves.toBe(expected);
  });

  it.each([
    new Error('Permission denied'),
    new Error('Provider timed out'),
    new Error('ambiguous provider failure'),
  ])('treats provider errors as unreadable (%s)', async (error) => {
    fileSystemMock.getInfoAsync.mockRejectedValueOnce(error);

    await expect(getLocalAttachmentPresence('content://provider/document/attachment'))
      .resolves.toBe('unreadable');
  });

  it('accepts an explicit native not-found error without collapsing other errors', async () => {
    fileSystemMock.getInfoAsync.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }));

    await expect(getLocalAttachmentPresence('content://provider/document/missing'))
      .resolves.toBe('confirmed-not-found');
  });

  it('treats an ambiguous getInfo result as unreadable', async () => {
    fileSystemMock.getInfoAsync.mockResolvedValueOnce({});

    await expect(getLocalAttachmentPresence('content://provider/document/attachment'))
      .resolves.toBe('unreadable');
  });
});

// #1057: attachment downloads must be write-temp-then-rename so a cut connection
// can never leave a truncated file at the real target path that a later sync would
// mistake for new content.
describe('writeBytesSafely', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes to a temp uri first, only moving it onto the target once the write succeeds', async () => {
    fileSystemMock.writeAsStringAsync.mockResolvedValue(undefined);
    fileSystemMock.moveAsync.mockResolvedValue(undefined);

    await writeBytesSafely('file://attachments/a1.pdf', new Uint8Array([1, 2, 3]));

    const [tempUri] = fileSystemMock.writeAsStringAsync.mock.calls[0] ?? [];
    expect(tempUri).toMatch(/^file:\/\/attachments\/\.mindwtr-attachment-write-[0-9a-z]+-[0-9a-f]{12}\.tmp$/);
    expect(fileSystemMock.moveAsync).toHaveBeenCalledWith({ from: tempUri, to: 'file://attachments/a1.pdf' });
  });

  it('a failed temp write never touches the target path, so a previously-downloaded file survives intact', async () => {
    const writeError = new Error('connection cut mid-download');
    fileSystemMock.writeAsStringAsync.mockRejectedValueOnce(writeError);

    await expect(writeBytesSafely('file://attachments/a1.pdf', new Uint8Array([1, 2, 3])))
      .rejects.toThrow(writeError);

    // Only the temp write was attempted — the fallback direct-write-to-target
    // branch (used only when the *move* fails, not the initial write) never runs.
    expect(fileSystemMock.writeAsStringAsync).toHaveBeenCalledTimes(1);
    expect(fileSystemMock.writeAsStringAsync.mock.calls[0]?.[0]).not.toBe('file://attachments/a1.pdf');
    expect(fileSystemMock.moveAsync).not.toHaveBeenCalled();
  });
});

describe('deleteManagedAttachmentFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileSystemMock.makeDirectoryAsync.mockResolvedValue(undefined);
    fileSystemMock.deleteAsync.mockResolvedValue(undefined);
  });

  it('deletes the id-named copy inside the managed attachment directory', async () => {
    const attachment = {
      id: 'draft-1',
      kind: 'file' as const,
      title: 'notes.txt',
      uri: 'file:///documents/attachments/draft-1.txt',
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:00:00.000Z',
    };

    await expect(deleteManagedAttachmentFile(attachment)).resolves.toBe(true);
    expect(fileSystemMock.deleteAsync).toHaveBeenCalledWith(attachment.uri, { idempotent: true });
  });

  it('rejects user files, sibling directories, and another attachment id', async () => {
    const base = {
      id: 'draft-1',
      kind: 'file' as const,
      title: 'notes.txt',
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:00:00.000Z',
    };

    await expect(deleteManagedAttachmentFile({ ...base, uri: 'file:///user/notes.txt' })).resolves.toBe(false);
    await expect(deleteManagedAttachmentFile({ ...base, uri: 'file:///documents/attachments-old/draft-1.txt' })).resolves.toBe(false);
    await expect(deleteManagedAttachmentFile({ ...base, uri: 'file:///documents/attachments/other.txt' })).resolves.toBe(false);
    expect(fileSystemMock.deleteAsync).not.toHaveBeenCalled();
  });
});
