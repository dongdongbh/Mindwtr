import * as nodeCrypto from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_DOWNLOAD_BYTES, type Attachment } from '@mindwtr/core';

// On-demand attachment fetch (`ensureAttachmentAvailable`) had no coverage at all: it is
// the path a user hits when tapping an attachment that only exists on the remote, it has
// one branch per sync backend, and it is the last place integrity validation runs before
// bytes land on disk.

const sha256Hex = (bytes: Uint8Array): string => nodeCrypto.createHash('sha256').update(bytes).digest('hex');
const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;

const fileSystemMock = vi.hoisted(() => ({
  __esModule: true,
  documentDirectory: 'file://document/',
  cacheDirectory: 'file://cache/',
  StorageAccessFramework: {
    readDirectoryAsync: vi.fn().mockResolvedValue([]),
    makeDirectoryAsync: vi.fn().mockResolvedValue('content://attachments'),
    createFileAsync: vi.fn().mockResolvedValue('content://attachments/file'),
    readAsStringAsync: vi.fn().mockResolvedValue(''),
    writeAsStringAsync: vi.fn().mockResolvedValue(undefined),
  },
  EncodingType: { Base64: 'base64' },
  getInfoAsync: vi.fn(),
  makeDirectoryAsync: vi.fn().mockResolvedValue(undefined),
  readAsStringAsync: vi.fn(),
  writeAsStringAsync: vi.fn().mockResolvedValue(undefined),
  readDirectoryAsync: vi.fn().mockResolvedValue([]),
  deleteAsync: vi.fn().mockResolvedValue(undefined),
  copyAsync: vi.fn().mockResolvedValue(undefined),
  moveAsync: vi.fn().mockResolvedValue(undefined),
}));

const attachmentFileInstallerMock = vi.hoisted(() => ({
  installAttachmentFileGeneration: vi.fn(),
}));

const cloudKitSyncMock = vi.hoisted(() => {
  class CloudKitAttachmentNotFoundError extends Error {}
  return {
    CloudKitAttachmentNotFoundError,
    fetchCloudKitAttachmentAsset: vi.fn(),
    isCloudKitAttachmentNotFoundError: (error: unknown) => error instanceof CloudKitAttachmentNotFoundError,
  };
});

vi.mock('expo-file-system/legacy', () => fileSystemMock);
vi.mock('./attachment-file-installer', () => attachmentFileInstallerMock);
vi.mock('./cloudkit-sync', () => cloudKitSyncMock);

const asyncStorageMock = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    api: {
      getItem: vi.fn(async (key: string) => store.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
      removeItem: vi.fn(async (key: string) => { store.delete(key); }),
    },
  };
});

vi.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: asyncStorageMock.api,
}));

vi.mock('./secure-config', () => ({
  getSecureConfigValue: vi.fn(async (key: string) => asyncStorageMock.store.get(key) ?? null),
  setSecureConfigValue: vi.fn().mockResolvedValue(undefined),
  deleteSecureConfigValue: vi.fn().mockResolvedValue(undefined),
  isSecretConfigKey: vi.fn().mockReturnValue(true),
}));

// Encryption off: the plaintext path is what every branch below exercises.
vi.mock('./sync-encryption-state', () => ({
  getSyncEncryptionMaterial: vi.fn().mockResolvedValue(null),
}));

vi.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { dropboxAppKey: 'dropbox-app-key' } } },
}));

vi.mock('./dropbox-sync', () => ({
  DropboxFileNotFoundError: class DropboxFileNotFoundError extends Error {},
  DropboxUnauthorizedError: class DropboxUnauthorizedError extends Error {},
  downloadDropboxFile: vi.fn(),
  uploadDropboxFile: vi.fn(),
}));

vi.mock('./dropbox-auth', () => ({
  forceRefreshDropboxAccessToken: vi.fn().mockResolvedValue('dropbox-token'),
  getValidDropboxAccessToken: vi.fn().mockResolvedValue('dropbox-token'),
}));

vi.mock('./app-log', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  sanitizeLogMessage: (value: string) => value,
}));

// Network transports only — the real hash validation and path/key derivation run.
vi.mock('@mindwtr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mindwtr/core')>();
  return {
    ...actual,
    cloudGetFile: vi.fn(),
    webdavGetFile: vi.fn(),
    withRetry: vi.fn(async (fn: () => Promise<unknown>) => await fn()),
  };
});

const REMOTE_BYTES = new Uint8Array([9, 8, 7, 6]);

const makeAttachment = (id: string, overrides: Partial<Attachment> = {}): Attachment => ({
  id,
  kind: 'file',
  title: `${id}.txt`,
  uri: '',
  cloudKey: `attachments/${id}.txt`,
  localStatus: 'missing',
  createdAt: '2026-04-18T10:00:00.000Z',
  updatedAt: '2026-04-18T10:00:00.000Z',
  ...overrides,
});

describe('ensureAttachmentAvailable', () => {
  // Loaded once, in a hook. The first import pulls the real @mindwtr/core barrel through
  // `importOriginal` and measured ~4s on its own (the call it sets up takes ~1ms). Inside a
  // test body that cost lands on whichever test happens to run first and blows the 5s test
  // timeout under parallel load — which is exactly how this file went red in CI. A hook is
  // paid once and against hookTimeout, raised here because 4s of import has no headroom
  // under a loaded machine. The work itself cannot be lightened: running the real core is
  // the point of this suite (TEST-01).
  let ensureAttachmentAvailable: typeof import('./attachment-sync-availability')['ensureAttachmentAvailable'];
  let ensureAttachmentAvailableDetailed: typeof import('./attachment-sync-availability')['ensureAttachmentAvailableDetailed'];
  let getAttachmentAvailabilityPatch: typeof import('./attachment-sync-availability')['getAttachmentAvailabilityPatch'];
  let getAttachmentUnrecoverablePatch: typeof import('./attachment-sync-availability')['getAttachmentUnrecoverablePatch'];

  beforeAll(async () => {
    ({
      ensureAttachmentAvailable,
      ensureAttachmentAvailableDetailed,
      getAttachmentAvailabilityPatch,
      getAttachmentUnrecoverablePatch,
    } = await import('./attachment-sync-availability'));
  }, 30_000);

  beforeEach(() => {
    vi.clearAllMocks();
    asyncStorageMock.store.clear();
    fileSystemMock.getInfoAsync.mockReset();
    // Nothing is in the managed attachments dir yet, so every branch has to fetch.
    fileSystemMock.getInfoAsync.mockImplementation(async (uri: string) => (
      uri.includes('.mindwtr-download-')
        ? { exists: true, size: REMOTE_BYTES.byteLength, modificationTime: 1000 }
        : { exists: false }
    ));
    fileSystemMock.copyAsync.mockResolvedValue(undefined);
    fileSystemMock.moveAsync.mockResolvedValue(undefined);
    fileSystemMock.readAsStringAsync.mockResolvedValue(Buffer.from(REMOTE_BYTES).toString('base64'));
    fileSystemMock.writeAsStringAsync.mockResolvedValue(undefined);
    fileSystemMock.StorageAccessFramework.readDirectoryAsync.mockResolvedValue([]);
    fileSystemMock.StorageAccessFramework.readAsStringAsync.mockResolvedValue(
      Buffer.from(REMOTE_BYTES).toString('base64'),
    );
    attachmentFileInstallerMock.installAttachmentFileGeneration.mockResolvedValue({ status: 'installed' });
    cloudKitSyncMock.fetchCloudKitAttachmentAsset.mockResolvedValue({
      attachmentId: 'unused',
      ownerType: 'task',
      ownerId: 'task-1',
      title: 'stale-title.txt',
      mimeType: 'application/x-stale',
      size: REMOTE_BYTES.byteLength,
      updatedAt: '2026-04-17T10:00:00.000Z',
    });
  });

  it('does not download or mutate storage when a content uri is unreadable', async () => {
    fileSystemMock.getInfoAsync.mockRejectedValue(new Error('Permission denied'));
    asyncStorageMock.store.set('@mindwtr_sync_backend', 'cloud');
    asyncStorageMock.store.set('@mindwtr_cloud_url', 'https://cloud.example/v1/data');
    asyncStorageMock.store.set('@mindwtr_cloud_token', 'cloud-token');
    const core = await import('@mindwtr/core');

    const result = await ensureAttachmentAvailable(makeAttachment('unreadable', {
      uri: 'content://provider/document/unreadable',
      localStatus: 'available',
    }));

    expect(result).toBeNull();
    expect(core.cloudGetFile).not.toHaveBeenCalled();
    expect(fileSystemMock.copyAsync).not.toHaveBeenCalled();
    expect(fileSystemMock.writeAsStringAsync).not.toHaveBeenCalled();
  });

  it('natively stages plaintext from a path-based File Sync folder without a base64 read', async () => {
    asyncStorageMock.store.set('@mindwtr_sync_backend', 'file');
    asyncStorageMock.store.set('@mindwtr_sync_path', 'file://sync/data.json');
    let stagedPath = '';
    fileSystemMock.copyAsync.mockImplementation(async ({ to }: { from: string; to: string }) => {
      stagedPath = to;
    });
    fileSystemMock.getInfoAsync.mockImplementation(async (uri: string) => (
      uri === 'file://sync/attachments/a-file.txt' || uri === stagedPath
        ? { exists: true, size: REMOTE_BYTES.byteLength, modificationTime: 1000 }
        : { exists: false }
    ));

    const result = await ensureAttachmentAvailable(makeAttachment('a-file', {
      fileHash: sha256Hex(REMOTE_BYTES),
    }));

    expect(result).toMatchObject({
      uri: 'file://document/attachments/a-file.txt',
      localStatus: 'available',
      fileHash: sha256Hex(REMOTE_BYTES),
    });
    expect(fileSystemMock.copyAsync).toHaveBeenCalledWith({
      from: 'file://sync/attachments/a-file.txt',
      to: expect.stringMatching(/\.mindwtr-download-.*\.staged$/),
    });
    expect(fileSystemMock.readAsStringAsync).not.toHaveBeenCalled();
    expect(fileSystemMock.StorageAccessFramework.readAsStringAsync).not.toHaveBeenCalled();
    expect(attachmentFileInstallerMock.installAttachmentFileGeneration).toHaveBeenCalledWith(
      expect.stringMatching(/\.mindwtr-download-.*\.staged$/),
      'file://document/attachments/a-file.txt',
      { kind: 'absent' },
      sha256Hex(REMOTE_BYTES),
    );
  });

  it('reads an unverified File Sync scratch in bounded chunks before installation', async () => {
    asyncStorageMock.store.set('@mindwtr_sync_backend', 'file');
    asyncStorageMock.store.set('@mindwtr_sync_path', 'file://sync/data.json');
    const sourceUri = 'file://sync/attachments/a-file-unverified.txt';
    let stagedPath = '';
    fileSystemMock.copyAsync.mockImplementation(async ({ to }: { from: string; to: string }) => {
      stagedPath = to;
    });
    fileSystemMock.getInfoAsync.mockImplementation(async (uri: string) => (
      uri === sourceUri || uri === stagedPath
        ? { exists: true, size: REMOTE_BYTES.byteLength, modificationTime: 1000 }
        : { exists: false }
    ));

    const result = await ensureAttachmentAvailable(makeAttachment('a-file-unverified'));

    expect(fileSystemMock.copyAsync).toHaveBeenCalledWith({
      from: sourceUri,
      to: expect.stringMatching(/\.mindwtr-download-.*\.staged$/),
    });
    expect(fileSystemMock.readAsStringAsync).toHaveBeenCalledWith(
      stagedPath,
      { encoding: 'base64', position: 0, length: REMOTE_BYTES.byteLength },
    );
    expect(attachmentFileInstallerMock.installAttachmentFileGeneration).toHaveBeenCalledWith(
      stagedPath,
      'file://document/attachments/a-file-unverified.txt',
      { kind: 'absent' },
      sha256Hex(REMOTE_BYTES),
    );
    expect(result).toMatchObject({ localStatus: 'available', fileHash: sha256Hex(REMOTE_BYTES) });
  });

  it('opens encrypted path-based File Sync bytes before staging and native installation', async () => {
    const core = await import('@mindwtr/core');
    const { setSyncCryptoNativeModuleForTests } = await import('./sync-crypto-native');
    setSyncCryptoNativeModuleForTests({
      argon2: () => { throw new Error('not needed: the key is constructed directly'); },
      createCipheriv: (a, k, i) => nodeCrypto.createCipheriv(a, k, i) as never,
      createDecipheriv: (a, k, i) => nodeCrypto.createDecipheriv(a, k, i) as never,
      createHash: (a) => nodeCrypto.createHash(a) as never,
      randomBytes: (size) => new Uint8Array(nodeCrypto.randomBytes(size)),
    });
    const material = {
      key: new Uint8Array(32).fill(7),
      salt: new Uint8Array(16).fill(3),
      params: core.SYNC_CRYPTO_DEFAULT_KDF_PARAMS,
    };
    const { getSyncEncryptionMaterial } = await import('./sync-encryption-state');
    vi.mocked(getSyncEncryptionMaterial).mockResolvedValue(material as never);
    const sealed = await core.encryptSyncArtifact(
      REMOTE_BYTES,
      material,
      (await import('./sync-crypto-native')).mobileSyncCryptoPrimitives,
    );
    asyncStorageMock.store.set('@mindwtr_sync_backend', 'file');
    asyncStorageMock.store.set('@mindwtr_sync_path', 'file://sync/data.json');
    let stagedPath = '';
    let stagedSize = sealed.length;
    fileSystemMock.copyAsync.mockImplementation(async ({ to }: { from: string; to: string }) => {
      stagedPath = to;
    });
    fileSystemMock.moveAsync.mockImplementation(async ({ to }: { from: string; to: string }) => {
      if (to === stagedPath) stagedSize = REMOTE_BYTES.byteLength;
    });
    fileSystemMock.getInfoAsync.mockImplementation(async (uri: string) => (
      uri === 'file://sync/attachments/a-file-sealed.txt'
        ? { exists: true, size: sealed.length, modificationTime: 1000 }
        : uri === stagedPath
          ? { exists: true, size: stagedSize, modificationTime: 1000 }
          : { exists: false }
    ));
    fileSystemMock.readAsStringAsync.mockImplementation(async (uri: string) => (
      uri === stagedPath
        ? Buffer.from(sealed).toString('base64')
        : Buffer.from(REMOTE_BYTES).toString('base64')
    ));

    const result = await ensureAttachmentAvailable(makeAttachment('a-file-sealed', {
      fileHash: sha256Hex(REMOTE_BYTES),
    }));

    expect(fileSystemMock.writeAsStringAsync).toHaveBeenCalledWith(
      expect.stringMatching(/\.mindwtr-download-.*\.staged\.tmp-/),
      Buffer.from(REMOTE_BYTES).toString('base64'),
      { encoding: 'base64' },
    );
    expect(attachmentFileInstallerMock.installAttachmentFileGeneration).toHaveBeenCalledWith(
      expect.stringMatching(/\.mindwtr-download-.*\.staged$/),
      'file://document/attachments/a-file-sealed.txt',
      { kind: 'absent' },
      sha256Hex(REMOTE_BYTES),
    );
    expect(result).toMatchObject({ localStatus: 'available', fileHash: sha256Hex(REMOTE_BYTES) });
    setSyncCryptoNativeModuleForTests(null);
    vi.mocked(getSyncEncryptionMaterial).mockResolvedValue(null);
  });

  it('natively stages plaintext from SAF without a base64 read', async () => {
    const syncFileUri = 'content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FMindwtr%20Backup/document/primary%3ADocuments%2FMindwtr%20Backup%2Fdata.json';
    const attachmentsDirUri = 'content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FMindwtr%20Backup/document/primary%3ADocuments%2FMindwtr%20Backup%2Fattachments/';
    const remoteFileUri = `${attachmentsDirUri}a-saf.txt`;
    asyncStorageMock.store.set('@mindwtr_sync_backend', 'file');
    asyncStorageMock.store.set('@mindwtr_sync_path', syncFileUri);
    fileSystemMock.StorageAccessFramework.readDirectoryAsync.mockImplementation(async (uri: string) => {
      if (uri === attachmentsDirUri) return [remoteFileUri];
      if (uri.includes('primary%3ADocuments%2FMindwtr%20Backup')) return [attachmentsDirUri];
      return [];
    });
    let stagedPath = '';
    fileSystemMock.copyAsync.mockImplementation(async ({ to }: { from: string; to: string }) => {
      stagedPath = to;
    });
    fileSystemMock.getInfoAsync.mockImplementation(async (uri: string) => (
      uri === remoteFileUri || uri === stagedPath
        ? { exists: true, size: REMOTE_BYTES.byteLength, modificationTime: 1000 }
        : { exists: false }
    ));

    const result = await ensureAttachmentAvailable(makeAttachment('a-saf', {
      fileHash: sha256Hex(REMOTE_BYTES),
    }));

    expect(fileSystemMock.copyAsync).toHaveBeenCalledWith({
      from: remoteFileUri,
      to: expect.stringMatching(/\.mindwtr-download-.*\.staged$/),
    });
    expect(fileSystemMock.StorageAccessFramework.readAsStringAsync).not.toHaveBeenCalled();
    expect(fileSystemMock.readAsStringAsync).not.toHaveBeenCalled();
    expect(attachmentFileInstallerMock.installAttachmentFileGeneration).toHaveBeenCalledWith(
      expect.stringMatching(/\.mindwtr-download-.*\.staged$/),
      'file://document/attachments/a-saf.txt',
      { kind: 'absent' },
      sha256Hex(REMOTE_BYTES),
    );
    expect(result).toMatchObject({
      uri: 'file://document/attachments/a-saf.txt',
      localStatus: 'available',
      fileHash: sha256Hex(REMOTE_BYTES),
    });
  });

  it('rejects an oversized path-based File Sync attachment before reading or installing it', async () => {
    asyncStorageMock.store.set('@mindwtr_sync_backend', 'file');
    asyncStorageMock.store.set('@mindwtr_sync_path', 'file://sync/data.json');
    const sourceUri = 'file://sync/attachments/a-file-large.txt';
    fileSystemMock.getInfoAsync.mockImplementation(async (uri: string) => (
      uri === sourceUri
        ? { exists: true, size: MAX_DOWNLOAD_BYTES + 1, modificationTime: 1000 }
        : { exists: false }
    ));

    const result = await ensureAttachmentAvailable(makeAttachment('a-file-large', {
      fileHash: sha256Hex(REMOTE_BYTES),
    }));

    expect(result).toBeNull();
    expect(fileSystemMock.copyAsync).not.toHaveBeenCalled();
    expect(fileSystemMock.readAsStringAsync).not.toHaveBeenCalled();
    expect(fileSystemMock.StorageAccessFramework.readAsStringAsync).not.toHaveBeenCalled();
    expect(fileSystemMock.writeAsStringAsync).not.toHaveBeenCalled();
    expect(attachmentFileInstallerMock.installAttachmentFileGeneration).not.toHaveBeenCalled();
  });

  it('rejects an oversized File Sync scratch created by a copy race before reading or installing it', async () => {
    asyncStorageMock.store.set('@mindwtr_sync_backend', 'file');
    asyncStorageMock.store.set('@mindwtr_sync_path', 'file://sync/data.json');
    const sourceUri = 'file://sync/attachments/a-file-copy-race.txt';
    let stagedPath = '';
    fileSystemMock.copyAsync.mockImplementation(async ({ to }: { from: string; to: string }) => {
      stagedPath = to;
    });
    fileSystemMock.getInfoAsync.mockImplementation(async (uri: string) => {
      if (uri === sourceUri) {
        return { exists: true, size: REMOTE_BYTES.byteLength, modificationTime: 1000 };
      }
      if (uri === stagedPath) {
        return { exists: true, size: MAX_DOWNLOAD_BYTES + 1, modificationTime: 1001 };
      }
      return { exists: false };
    });

    const result = await ensureAttachmentAvailable(makeAttachment('a-file-copy-race', {
      fileHash: sha256Hex(REMOTE_BYTES),
    }));

    expect(result).toBeNull();
    expect(fileSystemMock.copyAsync).toHaveBeenCalledOnce();
    expect(fileSystemMock.readAsStringAsync).not.toHaveBeenCalled();
    expect(fileSystemMock.StorageAccessFramework.readAsStringAsync).not.toHaveBeenCalled();
    expect(fileSystemMock.writeAsStringAsync).not.toHaveBeenCalled();
    expect(attachmentFileInstallerMock.installAttachmentFileGeneration).not.toHaveBeenCalled();
    expect(fileSystemMock.deleteAsync).toHaveBeenCalledWith(stagedPath, { idempotent: true });
  });

  it('downloads through Dropbox when the cloud backend uses the Dropbox provider', async () => {
    asyncStorageMock.store.set('@mindwtr_sync_backend', 'cloud');
    asyncStorageMock.store.set('@mindwtr_cloud_provider', 'dropbox');
    const dropbox = await import('./dropbox-sync');
    vi.mocked(dropbox.downloadDropboxFile).mockResolvedValue(toArrayBuffer(REMOTE_BYTES) as never);

    const result = await ensureAttachmentAvailable(
      makeAttachment('a-dropbox', { fileHash: sha256Hex(REMOTE_BYTES) })
    );

    expect(dropbox.downloadDropboxFile).toHaveBeenCalledWith('dropbox-token', 'attachments/a-dropbox.txt');
    expect(result).toMatchObject({
      uri: 'file://document/attachments/a-dropbox.txt',
      localStatus: 'available',
      fileHash: sha256Hex(REMOTE_BYTES),
    });
    expect(fileSystemMock.writeAsStringAsync).toHaveBeenCalledWith(
      expect.stringMatching(/^file:\/\/document\/attachments\/\.mindwtr-download-.*\.staged\.tmp-/),
      Buffer.from(REMOTE_BYTES).toString('base64'),
      { encoding: 'base64' }
    );
    expect(attachmentFileInstallerMock.installAttachmentFileGeneration).toHaveBeenCalledWith(
      expect.stringMatching(/\.mindwtr-download-.*\.staged$/),
      'file://document/attachments/a-dropbox.txt',
      { kind: 'absent' },
      sha256Hex(REMOTE_BYTES),
    );
  });

  it('downloads from the self-hosted cloud when no Dropbox provider is configured', async () => {
    asyncStorageMock.store.set('@mindwtr_sync_backend', 'cloud');
    asyncStorageMock.store.set('@mindwtr_cloud_url', 'https://cloud.example/v1/data');
    asyncStorageMock.store.set('@mindwtr_cloud_token', 'cloud-token');
    const core = await import('@mindwtr/core');
    vi.mocked(core.cloudGetFile).mockResolvedValue(toArrayBuffer(REMOTE_BYTES) as never);

    const result = await ensureAttachmentAvailable(
      makeAttachment('a-cloud', { fileHash: sha256Hex(REMOTE_BYTES) })
    );

    expect(core.cloudGetFile).toHaveBeenCalledWith(
      'https://cloud.example/v1/attachments/a-cloud.txt',
      expect.objectContaining({ token: 'cloud-token' })
    );
    expect(result).toMatchObject({
      uri: 'file://document/attachments/a-cloud.txt',
      localStatus: 'available',
      fileHash: sha256Hex(REMOTE_BYTES),
    });
    expect(attachmentFileInstallerMock.installAttachmentFileGeneration).toHaveBeenCalledWith(
      expect.stringMatching(/\.mindwtr-download-.*\.staged$/),
      'file://document/attachments/a-cloud.txt',
      { kind: 'absent' },
      sha256Hex(REMOTE_BYTES),
    );
  });

  it('returns null and preserves the staged generation when the target is created during an on-demand download', async () => {
    const id = 'a-cloud-collision';
    asyncStorageMock.store.set('@mindwtr_sync_backend', 'cloud');
    asyncStorageMock.store.set('@mindwtr_cloud_url', 'https://cloud.example/v1/data');
    asyncStorageMock.store.set('@mindwtr_cloud_token', 'cloud-token');
    const core = await import('@mindwtr/core');
    vi.mocked(core.cloudGetFile).mockResolvedValue(toArrayBuffer(REMOTE_BYTES) as never);
    attachmentFileInstallerMock.installAttachmentFileGeneration.mockResolvedValue({
      status: 'conflict',
      preservedPath: 'file://document/attachments/.mindwtr-preserved-on-demand.staged',
    });
    const attachment = makeAttachment(id, { fileHash: sha256Hex(REMOTE_BYTES) });

    const result = await ensureAttachmentAvailableDetailed(attachment);

    expect(result).toEqual({ status: 'generation-conflict' });
    expect(attachmentFileInstallerMock.installAttachmentFileGeneration).toHaveBeenCalledWith(
      expect.stringMatching(/\.mindwtr-download-.*\.staged$/),
      `file://document/attachments/${id}.txt`,
      { kind: 'absent' },
      sha256Hex(REMOTE_BYTES),
    );
    const stagedPath = attachmentFileInstallerMock.installAttachmentFileGeneration.mock.calls[0]?.[0];
    expect(fileSystemMock.deleteAsync).not.toHaveBeenCalledWith(stagedPath, expect.anything());
    expect(fileSystemMock.writeAsStringAsync).not.toHaveBeenCalledWith(
      `file://document/attachments/${id}.txt`,
      expect.anything(),
      expect.anything(),
    );
    expect(core.globalProgressTracker.getProgress(id)).toMatchObject({
      status: 'failed',
      error: 'Attachment changed locally during download',
    });
    expect(attachment).toMatchObject({
      uri: '',
      localStatus: 'missing',
      fileHash: sha256Hex(REMOTE_BYTES),
    });
  });

  it('does not share an in-flight download across different immutable content identities', async () => {
    asyncStorageMock.store.set('@mindwtr_sync_backend', 'cloud');
    asyncStorageMock.store.set('@mindwtr_cloud_url', 'https://cloud.example/v1/data');
    asyncStorageMock.store.set('@mindwtr_cloud_token', 'cloud-token');
    const core = await import('@mindwtr/core');
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    vi.mocked(core.cloudGetFile)
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
        return toArrayBuffer(REMOTE_BYTES) as never;
      })
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => { releaseSecond = resolve; });
        return toArrayBuffer(REMOTE_BYTES) as never;
      });
    const firstAttachment = makeAttachment('identity-race', {
      cloudKey: 'attachments/identity-race-h1.txt',
      contentRev: 1,
      fileHash: sha256Hex(REMOTE_BYTES),
    });
    const secondAttachment = makeAttachment('identity-race', {
      cloudKey: 'attachments/identity-race-h2.txt',
      contentRev: 2,
      fileHash: sha256Hex(REMOTE_BYTES),
    });

    const first = ensureAttachmentAvailableDetailed(firstAttachment);
    const second = ensureAttachmentAvailableDetailed(secondAttachment);
    await vi.waitFor(() => expect(core.cloudGetFile).toHaveBeenCalledTimes(2));
    releaseSecond();
    releaseFirst();

    await expect(first).resolves.toMatchObject({ status: 'available' });
    await expect(second).resolves.toMatchObject({ status: 'available' });
    expect(core.cloudGetFile).toHaveBeenNthCalledWith(
      1,
      'https://cloud.example/v1/attachments/identity-race-h1.txt',
      expect.anything(),
    );
    expect(core.cloudGetFile).toHaveBeenNthCalledWith(
      2,
      'https://cloud.example/v1/attachments/identity-race-h2.txt',
      expect.anything(),
    );
  });

  it('never accepts stale H1 bytes as an available H2 generation after concurrent absent installs', async () => {
    const h1Bytes = new Uint8Array([1, 1, 1, 1]);
    const h2Bytes = new Uint8Array([2, 2, 2, 2]);
    const targetUri = 'file://document/attachments/shared-generation.txt';
    const scratchBytes = new Map<string, string>();
    fileSystemMock.writeAsStringAsync.mockImplementation(async (uri: string, base64: string) => {
      scratchBytes.set(uri, base64);
    });
    fileSystemMock.moveAsync.mockImplementation(async ({ from, to }: { from: string; to: string }) => {
      const base64 = scratchBytes.get(from);
      if (base64) scratchBytes.set(to, base64);
    });
    fileSystemMock.readAsStringAsync.mockImplementation(async (uri: string) => (
      scratchBytes.get(uri) ?? Buffer.from(REMOTE_BYTES).toString('base64')
    ));
    asyncStorageMock.store.set('@mindwtr_sync_backend', 'cloud');
    asyncStorageMock.store.set('@mindwtr_cloud_url', 'https://cloud.example/v1/data');
    asyncStorageMock.store.set('@mindwtr_cloud_token', 'cloud-token');
    const core = await import('@mindwtr/core');
    let releaseH1!: () => void;
    let releaseH2!: () => void;
    vi.mocked(core.cloudGetFile)
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => { releaseH1 = resolve; });
        return toArrayBuffer(h1Bytes) as never;
      })
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => { releaseH2 = resolve; });
        return toArrayBuffer(h2Bytes) as never;
      });
    attachmentFileInstallerMock.installAttachmentFileGeneration
      .mockResolvedValueOnce({ status: 'installed' })
      .mockResolvedValueOnce({
        status: 'conflict',
        preservedPath: 'file://document/attachments/.mindwtr-preserved-h2.staged',
      });
    const h1 = makeAttachment('shared-generation', {
      cloudKey: 'attachments/shared-generation.txt',
      contentRev: 1,
      fileHash: sha256Hex(h1Bytes),
    });
    const h2 = makeAttachment('shared-generation', {
      cloudKey: 'attachments/shared-generation.txt',
      contentRev: 2,
      fileHash: sha256Hex(h2Bytes),
    });

    const h1Run = ensureAttachmentAvailableDetailed(h1);
    const h2Run = ensureAttachmentAvailableDetailed(h2);
    await vi.waitFor(() => expect(core.cloudGetFile).toHaveBeenCalledTimes(2));
    releaseH1();
    await expect(h1Run).resolves.toMatchObject({ status: 'available' });
    releaseH2();
    await expect(h2Run).resolves.toEqual({ status: 'generation-conflict' });

    fileSystemMock.getInfoAsync.mockImplementation(async (uri: string) => ({
      exists: uri === targetUri,
      size: h1Bytes.length,
    }));
    fileSystemMock.readAsStringAsync.mockImplementation(async (uri: string) => (
      uri === targetUri
        ? Buffer.from(h1Bytes).toString('base64')
        : Buffer.from(h2Bytes).toString('base64')
    ));

    await expect(ensureAttachmentAvailableDetailed(h2)).resolves.toEqual({
      status: 'generation-conflict',
    });
    expect(core.cloudGetFile).toHaveBeenCalledTimes(2);
  });

  it('downloads CloudKit assets to native scratch without falling through to stale WebDAV settings', async () => {
    asyncStorageMock.store.set('@mindwtr_sync_backend', 'cloudkit');
    asyncStorageMock.store.set('@mindwtr_webdav_url', 'https://stale-webdav.example/remote.php/dav/files/mindwtr');
    asyncStorageMock.store.set('@mindwtr_webdav_username', 'stale-user');
    asyncStorageMock.store.set('@mindwtr_webdav_password', 'stale-password');
    const core = await import('@mindwtr/core');
    const attachment = makeAttachment('cloudkit-on-demand', {
      cloudKey: 'cloudkit:cloudkit-on-demand',
      title: 'Current plan.pdf',
      mimeType: 'application/pdf',
      fileHash: sha256Hex(REMOTE_BYTES),
    });

    const result = await ensureAttachmentAvailableDetailed(attachment);

    expect(cloudKitSyncMock.fetchCloudKitAttachmentAsset).toHaveBeenCalledWith(
      'cloudkit-on-demand',
      expect.stringMatching(/\.mindwtr-download-.*\.staged$/),
    );
    expect(core.webdavGetFile).not.toHaveBeenCalled();
    expect(attachmentFileInstallerMock.installAttachmentFileGeneration).toHaveBeenCalledWith(
      expect.stringMatching(/\.mindwtr-download-.*\.staged$/),
      'file://document/attachments/cloudkit-on-demand.pdf',
      { kind: 'absent' },
      sha256Hex(REMOTE_BYTES),
    );
    expect(result).toMatchObject({
      status: 'available',
      attachment: {
        title: 'Current plan.pdf',
        mimeType: 'application/pdf',
        uri: 'file://document/attachments/cloudkit-on-demand.pdf',
        localStatus: 'available',
      },
    });
  });

  it('terminates CloudKit progress when the absent-generation installer reports a conflict', async () => {
    asyncStorageMock.store.set('@mindwtr_sync_backend', 'cloudkit');
    attachmentFileInstallerMock.installAttachmentFileGeneration.mockResolvedValue({
      status: 'conflict',
      preservedPath: 'file://document/attachments/.mindwtr-preserved-cloudkit.staged',
    });
    const attachment = makeAttachment('cloudkit-conflict', {
      cloudKey: 'cloudkit:cloudkit-conflict',
      fileHash: sha256Hex(REMOTE_BYTES),
    });
    const core = await import('@mindwtr/core');

    await expect(ensureAttachmentAvailableDetailed(attachment)).resolves.toEqual({
      status: 'generation-conflict',
    });
    expect(core.globalProgressTracker.getProgress(attachment.id)).toMatchObject({
      status: 'failed',
      error: 'Attachment changed locally during download',
    });
  });

  it('returns an explicit terminal patch when the CloudKit asset is confirmed missing', async () => {
    asyncStorageMock.store.set('@mindwtr_sync_backend', 'cloudkit');
    cloudKitSyncMock.fetchCloudKitAttachmentAsset.mockRejectedValue(
      new cloudKitSyncMock.CloudKitAttachmentNotFoundError(),
    );
    const attachment = makeAttachment('cloudkit-terminal-missing', {
      cloudKey: 'cloudkit:cloudkit-terminal-missing',
      fileHash: sha256Hex(REMOTE_BYTES),
      title: 'Current title.pdf',
      mimeType: 'application/pdf',
    });

    const result = await ensureAttachmentAvailableDetailed(attachment);

    expect(result).toMatchObject({
      status: 'unrecoverable',
      attachment: {
        title: 'Current title.pdf',
        mimeType: 'application/pdf',
        cloudKey: undefined,
        fileHash: undefined,
        localStatus: 'missing',
        deletedAt: expect.any(String),
      },
    });
    expect(attachment).toMatchObject({
      cloudKey: 'cloudkit:cloudkit-terminal-missing',
      fileHash: sha256Hex(REMOTE_BYTES),
    });
    expect(attachment).not.toHaveProperty('deletedAt');
    expect(fileSystemMock.deleteAsync).toHaveBeenCalledWith(
      expect.stringMatching(/\.mindwtr-download-.*\.staged$/),
      { idempotent: true },
    );
    expect(attachmentFileInstallerMock.installAttachmentFileGeneration).not.toHaveBeenCalled();
    if (result.status !== 'unrecoverable') throw new Error('Expected terminal CloudKit outcome');
    expect(getAttachmentUnrecoverablePatch(result.attachment)).toEqual({
      cloudKey: undefined,
      fileHash: undefined,
      localStatus: 'missing',
      deletedAt: result.attachment.deletedAt,
      updatedAt: result.attachment.updatedAt,
    });
  });

  it('patches only local availability and adopts a verified hash only for a legacy missing-hash record', () => {
    const legacy = makeAttachment('legacy', { fileHash: undefined });
    const verified = makeAttachment('legacy', {
      title: 'Stale remote title.txt',
      mimeType: 'application/x-stale',
      uri: 'file://document/attachments/legacy.txt',
      localStatus: 'available',
      fileHash: sha256Hex(REMOTE_BYTES),
    });
    expect(getAttachmentAvailabilityPatch(legacy, verified)).toEqual({
      uri: 'file://document/attachments/legacy.txt',
      localStatus: 'available',
      fileHash: sha256Hex(REMOTE_BYTES),
    });

    const current = makeAttachment('legacy', { fileHash: 'a'.repeat(64) });
    expect(getAttachmentAvailabilityPatch(current, verified)).toEqual({
      uri: 'file://document/attachments/legacy.txt',
      localStatus: 'available',
    });
  });

  it('decrypts a self-hosted cloud download before validating and writing it', async () => {
    // The cloud branch was the only one building bytes straight from the response: with
    // sync encryption on it either failed integrity validation or wrote the MWENC1
    // container to disk as the user's file.
    const core = await import('@mindwtr/core');
    const { setSyncCryptoNativeModuleForTests } = await import('./sync-crypto-native');
    setSyncCryptoNativeModuleForTests({
      argon2: () => { throw new Error('not needed: the key is constructed directly'); },
      createCipheriv: (a, k, i) => nodeCrypto.createCipheriv(a, k, i) as never,
      createDecipheriv: (a, k, i) => nodeCrypto.createDecipheriv(a, k, i) as never,
      createHash: (a) => nodeCrypto.createHash(a) as never,
      randomBytes: (size) => new Uint8Array(nodeCrypto.randomBytes(size)),
    });
    const material = {
      key: new Uint8Array(32).fill(7),
      salt: new Uint8Array(16).fill(3),
      params: core.SYNC_CRYPTO_DEFAULT_KDF_PARAMS,
    };
    const { getSyncEncryptionMaterial } = await import('./sync-encryption-state');
    vi.mocked(getSyncEncryptionMaterial).mockResolvedValue(material as never);
    const sealed = await core.encryptSyncArtifact(
      REMOTE_BYTES,
      material,
      (await import('./sync-crypto-native')).mobileSyncCryptoPrimitives,
    );
    expect(core.inspectSyncArtifact(sealed).kind).toBe('encrypted');

    asyncStorageMock.store.set('@mindwtr_sync_backend', 'cloud');
    asyncStorageMock.store.set('@mindwtr_cloud_url', 'https://cloud.example/v1/data');
    asyncStorageMock.store.set('@mindwtr_cloud_token', 'cloud-token');
    vi.mocked(core.cloudGetFile).mockResolvedValue(toArrayBuffer(sealed) as never);

    const result = await ensureAttachmentAvailable(
      // fileHash describes the PLAINTEXT — it is a plaintext-domain value inside the
      // synced document and must stay stable across re-encryptions.
      makeAttachment('a-sealed', { fileHash: sha256Hex(REMOTE_BYTES) })
    );

    expect(result).toMatchObject({
      uri: 'file://document/attachments/a-sealed.txt',
      localStatus: 'available',
    });
    expect(fileSystemMock.writeAsStringAsync).toHaveBeenCalledWith(
      expect.stringMatching(/^file:\/\/document\/attachments\/\.mindwtr-download-.*\.staged\.tmp-/),
      Buffer.from(REMOTE_BYTES).toString('base64'),
      { encoding: 'base64' }
    );
    expect(attachmentFileInstallerMock.installAttachmentFileGeneration).toHaveBeenCalledWith(
      expect.stringMatching(/\.mindwtr-download-.*\.staged$/),
      'file://document/attachments/a-sealed.txt',
      { kind: 'absent' },
      sha256Hex(REMOTE_BYTES),
    );
    setSyncCryptoNativeModuleForTests(null);
    vi.mocked(getSyncEncryptionMaterial).mockResolvedValue(null);
  });

  it('falls back to WebDAV for any other backend that has a cloud key', async () => {
    asyncStorageMock.store.set('@mindwtr_sync_backend', 'webdav');
    asyncStorageMock.store.set('@mindwtr_webdav_url', 'https://dav.example/data.json');
    asyncStorageMock.store.set('@mindwtr_webdav_username', 'u');
    asyncStorageMock.store.set('@mindwtr_webdav_password', 'p');
    const core = await import('@mindwtr/core');
    vi.mocked(core.webdavGetFile).mockResolvedValue(toArrayBuffer(REMOTE_BYTES) as never);

    const result = await ensureAttachmentAvailable(
      makeAttachment('a-dav', { fileHash: sha256Hex(REMOTE_BYTES) })
    );

    expect(core.webdavGetFile).toHaveBeenCalledWith(
      'https://dav.example/attachments/a-dav.txt',
      expect.objectContaining({ username: 'u', password: 'p' })
    );
    expect(result).toMatchObject({
      uri: 'file://document/attachments/a-dav.txt',
      localStatus: 'available',
      fileHash: sha256Hex(REMOTE_BYTES),
    });
    expect(attachmentFileInstallerMock.installAttachmentFileGeneration).toHaveBeenCalledWith(
      expect.stringMatching(/\.mindwtr-download-.*\.staged$/),
      'file://document/attachments/a-dav.txt',
      { kind: 'absent' },
      sha256Hex(REMOTE_BYTES),
    );
  });

  it('cleans a bad-hash stage without publishing it to the canonical target', async () => {
    asyncStorageMock.store.set('@mindwtr_sync_backend', 'cloud');
    asyncStorageMock.store.set('@mindwtr_cloud_url', 'https://cloud.example/v1/data');
    asyncStorageMock.store.set('@mindwtr_cloud_token', 'cloud-token');
    const core = await import('@mindwtr/core');
    vi.mocked(core.cloudGetFile).mockResolvedValue(toArrayBuffer(REMOTE_BYTES) as never);

    const result = await ensureAttachmentAvailable(
      makeAttachment('a-tampered', { fileHash: sha256Hex(new Uint8Array([1, 1, 1, 1])) })
    );

    expect(result).toBeNull();
    expect(attachmentFileInstallerMock.installAttachmentFileGeneration).not.toHaveBeenCalled();
    const stagedPath = (fileSystemMock.moveAsync.mock.calls[0]?.[0] as { to?: string } | undefined)?.to;
    expect(stagedPath).toMatch(/\.mindwtr-download-.*\.staged$/);
    expect(fileSystemMock.deleteAsync).toHaveBeenCalledWith(stagedPath, { idempotent: true });
    expect(fileSystemMock.writeAsStringAsync).not.toHaveBeenCalledWith(
      'file://document/attachments/a-tampered.txt',
      expect.anything(),
      expect.anything(),
    );
  });

  it('collapses concurrent requests for the same attachment into a single fetch', async () => {
    asyncStorageMock.store.set('@mindwtr_sync_backend', 'cloud');
    asyncStorageMock.store.set('@mindwtr_cloud_url', 'https://cloud.example/v1/data');
    asyncStorageMock.store.set('@mindwtr_cloud_token', 'cloud-token');
    const core = await import('@mindwtr/core');
    let releaseDownload: (() => void) | null = null;
    vi.mocked(core.cloudGetFile).mockImplementation(async () => {
      await new Promise<void>((resolve) => { releaseDownload = resolve; });
      return toArrayBuffer(REMOTE_BYTES) as never;
    });

    const attachment = makeAttachment('a-shared', { fileHash: sha256Hex(REMOTE_BYTES) });
    const first = ensureAttachmentAvailable(attachment);
    const second = ensureAttachmentAvailable(attachment);

    await vi.waitFor(() => expect(releaseDownload).not.toBeNull());
    releaseDownload!();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(core.cloudGetFile).toHaveBeenCalledTimes(1);
    expect(firstResult).toMatchObject({ localStatus: 'available' });
    expect(secondResult).toBe(firstResult);
  });
});
