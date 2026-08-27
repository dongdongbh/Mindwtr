import * as nodeCrypto from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Attachment } from '@mindwtr/core';

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

vi.mock('expo-file-system/legacy', () => fileSystemMock);

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

  beforeAll(async () => {
    ({ ensureAttachmentAvailable } = await import('./attachment-sync-availability'));
  }, 30_000);

  beforeEach(() => {
    vi.clearAllMocks();
    asyncStorageMock.store.clear();
    fileSystemMock.getInfoAsync.mockReset();
    // Nothing is in the managed attachments dir yet, so every branch has to fetch.
    fileSystemMock.getInfoAsync.mockResolvedValue({ exists: false });
    fileSystemMock.copyAsync.mockResolvedValue(undefined);
    fileSystemMock.moveAsync.mockResolvedValue(undefined);
    fileSystemMock.writeAsStringAsync.mockResolvedValue(undefined);
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

  it('copies the bytes out of the sync folder on the file backend', async () => {
    asyncStorageMock.store.set('@mindwtr_sync_backend', 'file');
    asyncStorageMock.store.set('@mindwtr_sync_path', 'file://sync/data.json');
    fileSystemMock.getInfoAsync.mockImplementation(async (uri: string) => ({
      exists: uri === 'file://sync/attachments/a-file.txt',
      size: 4,
    }));

    const result = await ensureAttachmentAvailable(makeAttachment('a-file'));

    expect(result).toMatchObject({
      uri: 'file://document/attachments/a-file.txt',
      localStatus: 'available',
    });
    expect(fileSystemMock.copyAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'file://sync/attachments/a-file.txt',
        to: expect.stringMatching(/^file:\/\/document\/attachments\/a-file\.txt\.tmp-/),
      })
    );
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
    });
    expect(fileSystemMock.writeAsStringAsync).toHaveBeenCalledWith(
      expect.stringMatching(/^file:\/\/document\/attachments\/a-dropbox\.txt\.tmp-/),
      Buffer.from(REMOTE_BYTES).toString('base64'),
      { encoding: 'base64' }
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
      expect.stringMatching(/^file:\/\/document\/attachments\/a-sealed\.txt\.tmp-/),
      Buffer.from(REMOTE_BYTES).toString('base64'),
      { encoding: 'base64' }
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
    });
  });

  it('refuses bytes that do not match the recorded fileHash and writes nothing to disk', async () => {
    asyncStorageMock.store.set('@mindwtr_sync_backend', 'cloud');
    asyncStorageMock.store.set('@mindwtr_cloud_url', 'https://cloud.example/v1/data');
    asyncStorageMock.store.set('@mindwtr_cloud_token', 'cloud-token');
    const core = await import('@mindwtr/core');
    vi.mocked(core.cloudGetFile).mockResolvedValue(toArrayBuffer(REMOTE_BYTES) as never);

    const result = await ensureAttachmentAvailable(
      makeAttachment('a-tampered', { fileHash: sha256Hex(new Uint8Array([1, 1, 1, 1])) })
    );

    expect(result).toBeNull();
    expect(fileSystemMock.writeAsStringAsync).not.toHaveBeenCalled();
    expect(fileSystemMock.moveAsync).not.toHaveBeenCalled();
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
