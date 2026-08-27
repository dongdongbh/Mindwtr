import { createHash } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncRemoteMutationFenceLostError, type AppData, type Attachment } from '@mindwtr/core';

/** Real digests, not fixtures: core's `validateAttachmentHash` now fails closed, and the
 *  node test env has `crypto.subtle`, so the values the code computes must be the values
 *  the tests expect. */
const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const base64Of = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

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
  EncodingType: {
    Base64: 'base64',
  },
  getInfoAsync: vi.fn(),
  makeDirectoryAsync: vi.fn().mockResolvedValue(undefined),
  readAsStringAsync: vi.fn(),
  writeAsStringAsync: vi.fn().mockResolvedValue(undefined),
  readDirectoryAsync: vi.fn().mockResolvedValue([]),
  deleteAsync: vi.fn().mockResolvedValue(undefined),
  copyAsync: vi.fn().mockResolvedValue(undefined),
  moveAsync: vi.fn().mockResolvedValue(undefined),
  uploadAsync: vi.fn(),
  createUploadTask: vi.fn(),
}));

vi.mock('expo-file-system/legacy', () => fileSystemMock);

vi.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

// Only the network transports are stubbed. Everything else — the shared transfer
// lifecycle (packages/core/src/attachment-transfer.ts), SHA-256 hashing and
// fail-closed hash validation, cloud-key/path derivation, upload validation, the
// WebDAV download backoff — is the REAL core code, so what this file asserts is
// what actually ships. (It used to be a vi.hoisted hand-copy of the lifecycle
// with `computeSha256Hex` pinned to null, which proved nothing about core and
// covered none of #1057's check-on-touch behaviour.)
vi.mock('@mindwtr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mindwtr/core')>();
  return {
    ...actual,
    cloudGetFile: vi.fn(),
    cloudDeleteFile: vi.fn(),
    cloudPutFile: vi.fn(),
    webdavGetFile: vi.fn(),
    webdavHeadFile: vi.fn(),
    webdavFileExists: vi.fn(),
    webdavMakeDirectory: vi.fn(),
    webdavPutFile: vi.fn(),
    webdavPutFileVersioned: vi.fn(),
    // Retry/backoff is transport timing, not behaviour under test: the real
    // helper sleeps up to a minute between attempts.
    withRetry: vi.fn(async (fn: () => Promise<unknown>) => await fn()),
    sleep: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('./dropbox-sync', () => ({
  DropboxConflictError: class DropboxConflictError extends Error {},
  DropboxFileNotFoundError: class DropboxFileNotFoundError extends Error {},
  DropboxUnauthorizedError: class DropboxUnauthorizedError extends Error {},
  downloadDropboxFile: vi.fn(),
  getDropboxFileMetadata: vi.fn(),
  uploadDropboxFile: vi.fn(),
  uploadDropboxFileVersioned: vi.fn(),
}));

// Only the three functions the CloudKit attachment backend uses; nothing else in this
// test's module graph imports ./cloudkit-sync.
vi.mock('./cloudkit-sync', () => ({
  saveCloudKitAttachmentAsset: vi.fn(),
  fetchCloudKitAttachmentAsset: vi.fn(),
  deleteCloudKitAttachmentAssets: vi.fn(),
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

// Loaded once, in a hook: the first import pulls the real @mindwtr/core barrel through
// `importOriginal` and costs seconds. Inside a test body that cost lands on whichever test
// runs first and can blow the 5s test timeout under parallel load.
let attachmentSync: typeof import('./attachment-sync');

/**
 * The backends never write to the document they are given: they return the folded copy, or
 * `false` when nothing changed. `data` is where a test reads the post-sync values.
 */
const syncResult = (result: AppData | boolean | null | undefined, input: AppData) => {
  const folded = typeof result === 'object' && result !== null;
  return { didMutate: folded, data: (folded ? result : input) as AppData };
};

const deepFreeze = <T,>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
};

beforeAll(async () => {
  attachmentSync = await import('./attachment-sync');
}, 30_000);

describe('attachment sync', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    fileSystemMock.uploadAsync.mockReset();
    fileSystemMock.createUploadTask.mockReset();
    // The real lifecycle keeps a module-scoped "stat we already failed to hash" map
    // (BUG-16); leaking it between tests would silently skip a re-read a later test
    // is asserting on.
    const core = await import('@mindwtr/core');
    core.resetUnhashableAttachmentStatsForTests();
    vi.mocked(core.webdavHeadFile).mockResolvedValue({
      exists: false,
      fingerprint: null,
      etag: null,
      lastModified: null,
      contentLength: null,
    });
    const dropbox = await import('./dropbox-sync');
    vi.mocked(dropbox.getDropboxFileMetadata).mockResolvedValue({ rev: null });
    fileSystemMock.getInfoAsync.mockReset();
    fileSystemMock.makeDirectoryAsync.mockResolvedValue(undefined);
    fileSystemMock.copyAsync.mockResolvedValue(undefined);
    fileSystemMock.moveAsync.mockResolvedValue(undefined);
    fileSystemMock.writeAsStringAsync.mockResolvedValue(undefined);
    fileSystemMock.deleteAsync.mockResolvedValue(undefined);
    fileSystemMock.readAsStringAsync.mockReset();
    fileSystemMock.StorageAccessFramework.readDirectoryAsync.mockResolvedValue([]);
    fileSystemMock.StorageAccessFramework.makeDirectoryAsync.mockResolvedValue('content://attachments');
    fileSystemMock.StorageAccessFramework.createFileAsync.mockResolvedValue('content://attachments/file');
    fileSystemMock.StorageAccessFramework.writeAsStringAsync.mockResolvedValue(undefined);
  });

  it('persists generic Android content uris with a native copy into managed storage', async () => {
    const contentUri = 'content://com.android.providers.downloads.documents/document/msf%3A1000006030';
    fileSystemMock.getInfoAsync
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce({ exists: true, size: 3 });

    const { persistAttachmentLocally } = attachmentSync;

    const result = await persistAttachmentLocally({
      id: 'att-1',
      kind: 'file',
      title: 'Embosser.png',
      uri: contentUri,
      createdAt: '2026-03-06T05:14:32.399Z',
      updatedAt: '2026-03-06T05:14:32.399Z',
    });

    // Native copyAsync streams the content:// bytes straight into a temp file
    // beside the target; no JS-side base64 read happens on the happy path.
    expect(fileSystemMock.copyAsync).toHaveBeenCalledTimes(1);
    expect(fileSystemMock.copyAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        from: contentUri,
        to: expect.stringMatching(/^file:\/\/document\/attachments\/att-1\.png\.tmp-/),
      })
    );
    expect(fileSystemMock.moveAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        from: expect.stringMatching(/^file:\/\/document\/attachments\/att-1\.png\.tmp-/),
        to: 'file://document/attachments/att-1.png',
      })
    );
    expect(fileSystemMock.readAsStringAsync).not.toHaveBeenCalled();
    expect(result.uri).toBe('file://document/attachments/att-1.png');
    expect(result.localStatus).toBe('available');
    expect(result.size).toBe(3);
  });

  it('persists local file attachments by reading bytes when direct copy fails', async () => {
    const sourceUri = 'file://document/mindwtr-audio-20260628-225702.m4a';
    fileSystemMock.getInfoAsync.mockResolvedValueOnce({ exists: false });
    fileSystemMock.copyAsync.mockRejectedValue(new Error('copy failed'));
    fileSystemMock.readAsStringAsync.mockResolvedValue('AQID');

    const { persistAttachmentLocally } = attachmentSync;

    const result = await persistAttachmentLocally({
      id: 'audio-1',
      kind: 'file',
      title: 'Audio Note.m4a',
      uri: sourceUri,
      mimeType: 'audio/mp4',
      size: 112780,
      createdAt: '2026-06-29T02:57:02.559Z',
      updatedAt: '2026-06-29T02:57:02.559Z',
      localStatus: 'available',
    });

    expect(fileSystemMock.copyAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        from: sourceUri,
        to: expect.stringMatching(/^file:\/\/document\/attachments\/audio-1\.m4a\.tmp-/),
      })
    );
    expect(fileSystemMock.readAsStringAsync).toHaveBeenCalledWith(
      sourceUri,
      { encoding: 'base64' }
    );
    expect(fileSystemMock.writeAsStringAsync).toHaveBeenCalledWith(
      expect.stringMatching(/^file:\/\/document\/attachments\/audio-1\.m4a\.tmp-/),
      'AQID',
      { encoding: 'base64' }
    );
    expect(result.uri).toBe('file://document/attachments/audio-1.m4a');
    expect(result.localStatus).toBe('available');
    expect(result.size).toBe(112780);
  });

  it('normalizes legacy content-uri attachments when ensuring availability', async () => {
    const contentUri = 'content://com.android.providers.downloads.documents/document/msf%3A1000006031';
    fileSystemMock.getInfoAsync
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce({ exists: true, size: 3 });
    fileSystemMock.readAsStringAsync.mockResolvedValue('AQID');

    const { ensureAttachmentAvailable } = attachmentSync;

    const result = await ensureAttachmentAvailable({
      id: 'att-available',
      kind: 'file',
      title: 'Legacy.png',
      uri: contentUri,
      createdAt: '2026-03-06T05:14:32.399Z',
      updatedAt: '2026-03-06T05:14:32.399Z',
    });

    expect(result?.uri).toBe('file://document/attachments/att-available.png');
    expect(result?.localStatus).toBe('available');
    expect(result?.size).toBe(3);
    expect(fileSystemMock.copyAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        from: contentUri,
        to: expect.stringMatching(/^file:\/\/document\/attachments\/att-available\.png\.tmp-/),
      })
    );
  });

  it('reuses an existing SAF attachments directory even when Android returns it with a trailing slash', async () => {
    const syncFileUri = 'content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FMindwtr%20Backup/document/primary%3ADocuments%2FMindwtr%20Backup%2Fdata.json';
    const attachmentsDirUri = 'content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FMindwtr%20Backup/document/primary%3ADocuments%2FMindwtr%20Backup%2Fattachments/';

    fileSystemMock.StorageAccessFramework.readDirectoryAsync.mockImplementation(async (uri: string) => {
      if (uri.includes('primary%3ADocuments%2FMindwtr%20Backup')) {
        return [attachmentsDirUri];
      }
      return [];
    });

    const { resolveFileSyncDir } = await import('./attachment-sync-utils');

    const resolved = await resolveFileSyncDir(syncFileUri);

    expect(resolved).toEqual({
      type: 'saf',
      dirUri: 'content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FMindwtr%20Backup/document/primary%3ADocuments%2FMindwtr%20Backup',
      attachmentsDirUri,
    });
    expect(fileSystemMock.StorageAccessFramework.makeDirectoryAsync).not.toHaveBeenCalled();
  });

  it('avoids creating duplicate SAF attachments folders on repeated file-sync attachment checks', async () => {
    const syncFileUri = 'content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FMindwtr%20Backup/document/primary%3ADocuments%2FMindwtr%20Backup%2Fdata.json';
    const attachmentsDirUri = 'content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FMindwtr%20Backup/document/primary%3ADocuments%2FMindwtr%20Backup%2Fattachments/';
    const remoteFileUri = `${attachmentsDirUri}f7d7d7-photo.jpg`;

    fileSystemMock.getInfoAsync.mockResolvedValue({ exists: true, size: 3 });
    fileSystemMock.StorageAccessFramework.readDirectoryAsync.mockImplementation(async (uri: string) => {
      if (uri === attachmentsDirUri) {
        return [remoteFileUri];
      }
      if (uri.includes('primary%3ADocuments%2FMindwtr%20Backup')) {
        return [attachmentsDirUri];
      }
      return [];
    });

    const { syncFileAttachments } = attachmentSync;

    const didMutate = await syncFileAttachments({
      tasks: [
        {
          id: 'task-1',
          title: 'Task',
          status: 'inbox',
          tags: [],
          contexts: [],
          attachments: [
            {
              id: 'f7d7d7-photo',
              kind: 'file',
              title: 'photo.jpg',
              uri: 'file://document/attachments/f7d7d7-photo.jpg',
              cloudKey: 'attachments/f7d7d7-photo.jpg',
              localStatus: 'available',
              createdAt: '2026-04-18T10:00:00.000Z',
              updatedAt: '2026-04-18T10:00:00.000Z',
            },
          ],
          createdAt: '2026-04-18T10:00:00.000Z',
          updatedAt: '2026-04-18T10:00:00.000Z',
        },
      ],
      projects: [],
      sections: [],
      areas: [],
      settings: {},
    }, syncFileUri);

    expect(didMutate).toBe(false);
    expect(fileSystemMock.StorageAccessFramework.makeDirectoryAsync).not.toHaveBeenCalled();
    expect(fileSystemMock.StorageAccessFramework.createFileAsync).not.toHaveBeenCalled();
    expect(fileSystemMock.StorageAccessFramework.writeAsStringAsync).not.toHaveBeenCalled();
  });

  it('proves a remote-only SAF attachment during file-backend activation', async () => {
    const syncFileUri = 'content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FMindwtr%20Backup/document/primary%3ADocuments%2FMindwtr%20Backup%2Fdata.json';
    const attachmentsDirUri = 'content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FMindwtr%20Backup/document/primary%3ADocuments%2FMindwtr%20Backup%2Fattachments/';
    const remoteFileUri = `${attachmentsDirUri}remote-only.txt`;

    fileSystemMock.StorageAccessFramework.readDirectoryAsync.mockImplementation(async (uri: string) => {
      if (uri === attachmentsDirUri) return [remoteFileUri];
      if (uri.includes('primary%3ADocuments%2FMindwtr%20Backup')) return [attachmentsDirUri];
      return [];
    });

    const { syncFileAttachments } = attachmentSync;
    const appData: AppData = {
      tasks: [{
        id: 'task-remote-only',
        title: 'Remote only',
        status: 'inbox',
        tags: [],
        contexts: [],
        attachments: [{
          id: 'remote-only',
          kind: 'file',
          title: 'remote-only.txt',
          uri: '',
          cloudKey: 'attachments/remote-only.txt',
          localStatus: 'missing',
          createdAt: '2026-04-18T10:00:00.000Z',
          updatedAt: '2026-04-18T10:00:00.000Z',
        }],
        createdAt: '2026-04-18T10:00:00.000Z',
        updatedAt: '2026-04-18T10:00:00.000Z',
      }],
      projects: [],
      sections: [],
      areas: [],
      settings: {},
    };

    const { didMutate, data } = syncResult(
      await syncFileAttachments(appData, syncFileUri, undefined, { activationProbe: true }),
      appData,
    );

    expect(didMutate).toBe(true);
    expect(data.tasks[0]?.attachments?.[0]).toMatchObject({
      cloudKey: 'attachments/remote-only.txt',
      localStatus: 'available',
    });
    expect(fileSystemMock.StorageAccessFramework.createFileAsync).not.toHaveBeenCalled();
    expect(fileSystemMock.StorageAccessFramework.writeAsStringAsync).not.toHaveBeenCalled();
  });

  it('reads the SAF attachments directory once per file-sync pass', async () => {
    const syncFileUri = 'content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FMindwtr%20Backup/document/primary%3ADocuments%2FMindwtr%20Backup%2Fdata.json';
    const attachmentsDirUri = 'content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FMindwtr%20Backup/document/primary%3ADocuments%2FMindwtr%20Backup%2Fattachments/';
    const firstRemoteFileUri = `${attachmentsDirUri}first.txt`;
    const secondRemoteFileUri = `${attachmentsDirUri}second.txt`;

    fileSystemMock.getInfoAsync.mockResolvedValue({ exists: true, size: 3 });
    fileSystemMock.StorageAccessFramework.readDirectoryAsync.mockImplementation(async (uri: string) => {
      if (uri === attachmentsDirUri) {
        return [firstRemoteFileUri, secondRemoteFileUri];
      }
      if (uri.includes('primary%3ADocuments%2FMindwtr%20Backup')) {
        return [attachmentsDirUri];
      }
      return [];
    });

    const { syncFileAttachments } = attachmentSync;

    const didMutate = await syncFileAttachments({
      tasks: [
        {
          id: 'task-1',
          title: 'Task',
          status: 'inbox',
          tags: [],
          contexts: [],
          attachments: [
            {
              id: 'first',
              kind: 'file',
              title: 'first.txt',
              uri: 'file://document/attachments/first.txt',
              cloudKey: 'attachments/first.txt',
              localStatus: 'available',
              createdAt: '2026-04-18T10:00:00.000Z',
              updatedAt: '2026-04-18T10:00:00.000Z',
            },
            {
              id: 'second',
              kind: 'file',
              title: 'second.txt',
              uri: 'file://document/attachments/second.txt',
              cloudKey: 'attachments/second.txt',
              localStatus: 'available',
              createdAt: '2026-04-18T10:00:00.000Z',
              updatedAt: '2026-04-18T10:00:00.000Z',
            },
          ],
          createdAt: '2026-04-18T10:00:00.000Z',
          updatedAt: '2026-04-18T10:00:00.000Z',
        },
      ],
      projects: [],
      sections: [],
      areas: [],
      settings: {},
    }, syncFileUri);

    const attachmentDirReads = fileSystemMock.StorageAccessFramework.readDirectoryAsync.mock.calls
      .filter(([uri]) => uri === attachmentsDirUri);

    expect(didMutate).toBe(false);
    expect(attachmentDirReads).toHaveLength(1);
    expect(fileSystemMock.StorageAccessFramework.createFileAsync).not.toHaveBeenCalled();
    expect(fileSystemMock.StorageAccessFramework.writeAsStringAsync).not.toHaveBeenCalled();
  });

  it('migrates legacy content-uri attachments into app-managed storage during sync', async () => {
    const syncFileUri = 'content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FMindwtr%20Backup/document/primary%3ADocuments%2FMindwtr%20Backup%2Fdata.json';
    const attachmentsDirUri = 'content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FMindwtr%20Backup/document/primary%3ADocuments%2FMindwtr%20Backup%2Fattachments/';
    const remoteFileUri = `${attachmentsDirUri}legacy.txt`;
    const legacyContentUri = 'content://com.android.providers.downloads.documents/document/msf%3A42';
    const managedUri = 'file://document/attachments/legacy.txt';

    fileSystemMock.getInfoAsync
      .mockResolvedValueOnce({ exists: false, size: 0 })
      .mockResolvedValue({ exists: true, size: 3 });
    fileSystemMock.readAsStringAsync.mockResolvedValue('AQID');
    fileSystemMock.StorageAccessFramework.readDirectoryAsync.mockImplementation(async (uri: string) => {
      if (uri === attachmentsDirUri) {
        return [remoteFileUri];
      }
      if (uri.includes('primary%3ADocuments%2FMindwtr%20Backup')) {
        return [attachmentsDirUri];
      }
      return [];
    });

    const { syncFileAttachments } = attachmentSync;
    const appData: AppData = {
      tasks: [
        {
          id: 'task-1',
          title: 'Task',
          status: 'inbox',
          tags: [],
          contexts: [],
          attachments: [
            {
              id: 'legacy',
              kind: 'file',
              title: 'legacy.txt',
              uri: legacyContentUri,
              cloudKey: 'attachments/legacy.txt',
              size: 3,
              createdAt: '2026-04-18T10:00:00.000Z',
              updatedAt: '2026-04-18T10:00:00.000Z',
            },
          ],
          createdAt: '2026-04-18T10:00:00.000Z',
          updatedAt: '2026-04-18T10:00:00.000Z',
        },
      ],
      projects: [],
      sections: [],
      areas: [],
      settings: {},
    };

    const { didMutate, data } = syncResult(await syncFileAttachments(appData, syncFileUri), appData);
    const attachment = data.tasks[0].attachments?.[0];

    expect(didMutate).toBe(true);
    expect(attachment?.uri).toBe(managedUri);
    expect(attachment?.localStatus).toBe('available');
    // The document handed in is never written to.
    expect(appData.tasks[0].attachments?.[0]?.uri).toBe(legacyContentUri);
    expect(fileSystemMock.copyAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        from: legacyContentUri,
        to: expect.stringMatching(/^file:\/\/document\/attachments\/legacy\.txt\.tmp-/),
      })
    );
    expect(fileSystemMock.StorageAccessFramework.createFileAsync).not.toHaveBeenCalled();
  });

  it('limits legacy content-uri migration work per attachment sync pass', async () => {
    const syncFileUri = 'content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FMindwtr%20Backup/document/primary%3ADocuments%2FMindwtr%20Backup%2Fdata.json';
    const attachmentsDirUri = 'content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FMindwtr%20Backup/document/primary%3ADocuments%2FMindwtr%20Backup%2Fattachments/';

    fileSystemMock.getInfoAsync
      .mockResolvedValueOnce({ exists: false, size: 0 })
      .mockResolvedValueOnce({ exists: true, size: 3 })
      .mockResolvedValueOnce({ exists: false, size: 0 })
      .mockResolvedValueOnce({ exists: true, size: 3 })
      .mockResolvedValueOnce({ exists: false, size: 0 })
      .mockResolvedValueOnce({ exists: true, size: 3 });
    fileSystemMock.readAsStringAsync.mockResolvedValue('AQID');
    fileSystemMock.StorageAccessFramework.readDirectoryAsync.mockImplementation(async (uri: string) => {
      if (uri === attachmentsDirUri) {
        return ['legacy-0.txt', 'legacy-1.txt', 'legacy-2.txt', 'legacy-3.txt'].map((name) => `${attachmentsDirUri}${name}`);
      }
      if (uri.includes('primary%3ADocuments%2FMindwtr%20Backup')) {
        return [attachmentsDirUri];
      }
      return [];
    });

    const { ATTACHMENT_LOCAL_MIGRATION_MAX_PER_SYNC, syncFileAttachments } = attachmentSync;
    const appData: AppData = {
      tasks: [
        {
          id: 'task-1',
          title: 'Task',
          status: 'inbox',
          tags: [],
          contexts: [],
          attachments: Array.from({ length: ATTACHMENT_LOCAL_MIGRATION_MAX_PER_SYNC + 1 }, (_, index) => ({
            id: `legacy-${index}`,
            kind: 'file' as const,
            title: `legacy-${index}.txt`,
            uri: `content://com.android.providers.downloads.documents/document/msf%3A${index}`,
            cloudKey: `attachments/legacy-${index}.txt`,
            size: 3,
            createdAt: '2026-04-18T10:00:00.000Z',
            updatedAt: '2026-04-18T10:00:00.000Z',
          })),
          createdAt: '2026-04-18T10:00:00.000Z',
          updatedAt: '2026-04-18T10:00:00.000Z',
        },
      ],
      projects: [],
      sections: [],
      areas: [],
      settings: {},
    };

    const { didMutate, data } = syncResult(await syncFileAttachments(appData, syncFileUri), appData);
    const attachments = data.tasks[0].attachments ?? [];

    expect(didMutate).toBe(true);
    expect(fileSystemMock.copyAsync).toHaveBeenCalledTimes(ATTACHMENT_LOCAL_MIGRATION_MAX_PER_SYNC);
    expect(attachments.slice(0, ATTACHMENT_LOCAL_MIGRATION_MAX_PER_SYNC).every((attachment) =>
      attachment.uri.startsWith('file://document/attachments/')
    )).toBe(true);
    expect(attachments[ATTACHMENT_LOCAL_MIGRATION_MAX_PER_SYNC].uri).toMatch(/^content:\/\//);
    expect(fileSystemMock.StorageAccessFramework.createFileAsync).not.toHaveBeenCalled();
  });

  it('detects pending attachment work from metadata without touching stable managed files', async () => {
    const { hasPendingAttachmentSyncWork } = attachmentSync;
    const makeData = (attachment: Attachment, settings: AppData['settings'] = {}): AppData => ({
      tasks: [
        {
          id: 'task-1',
          title: 'Task',
          status: 'inbox',
          tags: [],
          contexts: [],
          attachments: [attachment],
          createdAt: '2026-04-18T10:00:00.000Z',
          updatedAt: '2026-04-18T10:00:00.000Z',
        },
      ],
      projects: [],
      sections: [],
      areas: [],
      settings,
    });
    const baseAttachment = {
      id: 'stable',
      kind: 'file' as const,
      title: 'stable.txt',
      uri: 'file://document/attachments/stable.txt',
      cloudKey: 'attachments/stable.txt',
      localStatus: 'available' as const,
      createdAt: '2026-04-18T10:00:00.000Z',
      updatedAt: '2026-04-18T10:00:00.000Z',
    };

    await expect(hasPendingAttachmentSyncWork(makeData(baseAttachment))).resolves.toBe(false);
    expect(fileSystemMock.makeDirectoryAsync).not.toHaveBeenCalled();
    expect(fileSystemMock.readDirectoryAsync).not.toHaveBeenCalled();
    expect(fileSystemMock.StorageAccessFramework.readDirectoryAsync).not.toHaveBeenCalled();

    // #1057 (review B3): the exact same steady-state attachment (cloudKey + managed
    // local file + localStatus 'available') must count as pending work once a backend
    // wires check-on-touch content detection — otherwise both attachment phases never
    // run on mobile and content edits/cross-device updates are never detected.
    await expect(
      hasPendingAttachmentSyncWork(makeData(baseAttachment), { contentCheckEnabled: true }),
    ).resolves.toBe(true);

    const legacyManagedAttachment: Attachment = {
      ...baseAttachment,
      id: 'legacy-managed',
      uri: 'file://document/attachments/legacy-managed.txt',
      localStatus: undefined,
    };
    await expect(hasPendingAttachmentSyncWork(makeData(legacyManagedAttachment))).resolves.toBe(true);
    expect(fileSystemMock.makeDirectoryAsync).not.toHaveBeenCalled();

    const pendingUploadAttachment: Attachment = {
      id: 'pending-upload',
      kind: 'file',
      title: 'pending-upload.txt',
      uri: 'file://document/attachments/pending-upload.txt',
      localStatus: 'available',
      createdAt: '2026-04-18T10:00:00.000Z',
      updatedAt: '2026-04-18T10:00:00.000Z',
    };
    await expect(hasPendingAttachmentSyncWork(makeData(pendingUploadAttachment))).resolves.toBe(true);

    await expect(hasPendingAttachmentSyncWork(makeData({
      ...baseAttachment,
      id: 'legacy-content-uri',
      uri: 'content://com.android.providers.downloads.documents/document/msf%3A42',
    }))).resolves.toBe(true);

    await expect(hasPendingAttachmentSyncWork(makeData({
      ...baseAttachment,
      id: 'missing-download',
      uri: '',
      localStatus: 'missing',
    }))).resolves.toBe(true);

    await expect(hasPendingAttachmentSyncWork(makeData(baseAttachment, {
      attachments: {
        pendingRemoteDeletes: [
          { cloudKey: 'attachments/deleted.txt' },
        ],
      },
    }))).resolves.toBe(true);
  });

  it('uploads a pending SAF file attachment into the existing attachments directory', async () => {
    const syncFileUri = 'content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FMindwtr%20Backup/document/primary%3ADocuments%2FMindwtr%20Backup%2Fdata.json';
    const attachmentsDirUri = 'content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FMindwtr%20Backup/document/primary%3ADocuments%2FMindwtr%20Backup%2Fattachments/';
    const createdRemoteFileUri = `${attachmentsDirUri}upload-me.jpg`;

    fileSystemMock.getInfoAsync.mockImplementation(async (uri: string) => {
      const exists = uri === 'file://document/attachments/upload-me.jpg'
        || uri.startsWith('file://cache/mindwtr-upload-');
      return { exists, size: exists ? 3 : 0, modificationTime: 1 };
    });
    fileSystemMock.readAsStringAsync.mockResolvedValue('AQID');
    fileSystemMock.StorageAccessFramework.readDirectoryAsync.mockImplementation(async (uri: string) => {
      if (uri === attachmentsDirUri) {
        return [];
      }
      if (uri.includes('primary%3ADocuments%2FMindwtr%20Backup')) {
        return [attachmentsDirUri];
      }
      return [];
    });
    fileSystemMock.StorageAccessFramework.createFileAsync.mockResolvedValue(createdRemoteFileUri);

    const { syncFileAttachments } = attachmentSync;

    const appData: AppData = {
      tasks: [
        {
          id: 'task-1',
          title: 'Task',
          status: 'inbox',
          tags: [],
          contexts: [],
          attachments: [
            {
              id: 'upload-me',
              kind: 'file' as const,
              title: 'photo.jpg',
              uri: 'file://document/attachments/upload-me.jpg',
              localStatus: 'available' as const,
              createdAt: '2026-04-18T10:00:00.000Z',
              updatedAt: '2026-04-18T10:00:00.000Z',
            },
          ],
          createdAt: '2026-04-18T10:00:00.000Z',
          updatedAt: '2026-04-18T10:00:00.000Z',
        },
      ],
      projects: [],
      sections: [],
      areas: [],
      settings: {},
    };

    const { didMutate, data } = syncResult(await syncFileAttachments(appData, syncFileUri), appData);
    const attachment = data.tasks[0].attachments?.[0];

    expect(didMutate).toBe(true);
    expect(attachment?.cloudKey).toBe('attachments/upload-me.jpg');
    expect(appData.tasks[0].attachments?.[0]?.cloudKey).toBeUndefined();
    expect(fileSystemMock.StorageAccessFramework.makeDirectoryAsync).not.toHaveBeenCalled();
    expect(fileSystemMock.StorageAccessFramework.createFileAsync).toHaveBeenCalledWith(
      attachmentsDirUri,
      'upload-me.jpg',
      'application/octet-stream'
    );
    expect(fileSystemMock.writeAsStringAsync).toHaveBeenCalledWith(
      createdRemoteFileUri,
      'AQID',
      { encoding: 'base64' }
    );
  });

  it('aborts file attachment sync before writing stale bytes', async () => {
    const syncFileUri = 'content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FMindwtr%20Backup/document/primary%3ADocuments%2FMindwtr%20Backup%2Fdata.json';
    const attachmentsDirUri = 'content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FMindwtr%20Backup/document/primary%3ADocuments%2FMindwtr%20Backup%2Fattachments/';
    const controller = new AbortController();

    fileSystemMock.getInfoAsync.mockResolvedValue({ exists: true, size: 3, modificationTime: 1 });
    fileSystemMock.StorageAccessFramework.readDirectoryAsync.mockImplementation(async (uri: string) => {
      if (uri === attachmentsDirUri) {
        return [];
      }
      if (uri.includes('primary%3ADocuments%2FMindwtr%20Backup')) {
        return [attachmentsDirUri];
      }
      return [];
    });
    fileSystemMock.readAsStringAsync.mockImplementation(async () => {
      controller.abort('File attachment sync cancelled');
      return 'AQID';
    });

    const { syncFileAttachments } = attachmentSync;
    const appData: AppData = {
      tasks: [
        {
          id: 'task-1',
          title: 'Task',
          status: 'inbox',
          tags: [],
          contexts: [],
          attachments: [
            {
              id: 'upload-me',
              kind: 'file',
              title: 'photo.jpg',
              uri: 'file://document/attachments/upload-me.jpg',
              localStatus: 'available',
              createdAt: '2026-04-18T10:00:00.000Z',
              updatedAt: '2026-04-18T10:00:00.000Z',
            },
          ],
          createdAt: '2026-04-18T10:00:00.000Z',
          updatedAt: '2026-04-18T10:00:00.000Z',
        },
      ],
      projects: [],
      sections: [],
      areas: [],
      settings: {},
    };

    await expect(syncFileAttachments(appData, syncFileUri, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'File attachment sync cancelled',
    });
    expect(fileSystemMock.StorageAccessFramework.writeAsStringAsync).not.toHaveBeenCalled();
  });

  it('passes abort signals through WebDAV attachment transfers', async () => {
    fileSystemMock.getInfoAsync.mockResolvedValue({ exists: true, size: 3, modificationTime: 1 });
    fileSystemMock.readAsStringAsync.mockResolvedValue('AQID');
    const core = await import('@mindwtr/core');
    vi.mocked(core.webdavPutFileVersioned).mockResolvedValue(undefined);
    vi.mocked(core.webdavFileExists).mockResolvedValue(false);

    const controller = new AbortController();
    const { syncWebdavAttachments } = attachmentSync;
    const appData: AppData = {
      tasks: [
        {
          id: 'task-1',
          title: 'Task',
          status: 'inbox',
          tags: [],
          contexts: [],
          attachments: [
            {
              id: 'webdav-upload',
              kind: 'file',
              title: 'photo.jpg',
              uri: 'file://document/attachments/webdav-upload.jpg',
              localStatus: 'available',
              createdAt: '2026-04-18T10:00:00.000Z',
              updatedAt: '2026-04-18T10:00:00.000Z',
            },
          ],
          createdAt: '2026-04-18T10:00:00.000Z',
          updatedAt: '2026-04-18T10:00:00.000Z',
        },
      ],
      projects: [],
      sections: [],
      areas: [],
      settings: {},
    };

    await syncWebdavAttachments(
      appData,
      { url: 'https://example.com/data.json', username: 'u', password: 'p' },
      'https://example.com',
      controller.signal
    );

    expect(core.webdavMakeDirectory).toHaveBeenCalledWith('https://example.com/attachments', expect.objectContaining({
      signal: controller.signal,
    }));
    expect(core.webdavPutFileVersioned).toHaveBeenCalledWith(
      'https://example.com/attachments/webdav-upload.jpg',
      expect.any(ArrayBuffer),
      'application/octet-stream',
      null,
      expect.objectContaining({ signal: controller.signal })
    );
  });

  it.each([false, true])(
    'prevents a mobile WebDAV attachment PUT after lease takeover (activation=%s)',
    async (activationProbe) => {
      fileSystemMock.getInfoAsync.mockResolvedValue({ exists: true, size: 3, modificationTime: 1 });
      fileSystemMock.readAsStringAsync.mockResolvedValue('AQID');
      const core = await import('@mindwtr/core');
      const lost = new SyncRemoteMutationFenceLostError();
      const assertRemoteMutationFenceHeld = vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(lost);
      const appData: AppData = {
        tasks: [{
          id: 'task-lease', title: 'Task', status: 'inbox', tags: [], contexts: [],
          attachments: [{
            id: 'webdav-lease', kind: 'file', title: 'lease.txt',
            uri: 'file://document/attachments/lease.txt', localStatus: 'available',
            createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z',
          }],
          createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z',
        }],
        projects: [], sections: [], areas: [], settings: {},
      };

      await expect(attachmentSync.syncWebdavAttachments(
        appData,
        { url: 'https://example.com/data.json', username: 'u', password: 'p' },
        'https://example.com',
        undefined,
        { activationProbe, assertRemoteMutationFenceHeld },
      )).rejects.toBe(lost);

      expect(assertRemoteMutationFenceHeld).toHaveBeenCalledTimes(2);
      expect(core.webdavPutFileVersioned).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'prevents a mobile self-hosted Cloud attachment PUT after lease takeover (activation=%s)',
    async (activationProbe) => {
      const localUri = 'file://document/attachments/cloud-lease.txt';
      fileSystemMock.getInfoAsync.mockImplementation(async (uri: string) => (
        uri === localUri ? { exists: true, size: 3 } : { exists: false }
      ));
      fileSystemMock.readAsStringAsync.mockResolvedValue('AQID');
      // The streamed uploader reports unsupported after the first fence check;
      // the buffered fallback must revalidate instead of inheriting that check.
      fileSystemMock.createUploadTask.mockReturnValue(undefined);
      const core = await import('@mindwtr/core');
      const lost = new SyncRemoteMutationFenceLostError();
      const assertRemoteMutationFenceHeld = vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(lost);
      const appData: AppData = {
        tasks: [{
          id: 'task-cloud-lease', title: 'Task', status: 'inbox', tags: [], contexts: [],
          attachments: [{
            id: 'cloud-lease', kind: 'file', title: 'cloud-lease.txt',
            uri: localUri, localStatus: 'available',
            createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z',
          }],
          createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z',
        }],
        projects: [], sections: [], areas: [], settings: {},
      };

      await expect(attachmentSync.syncCloudAttachments(
        appData,
        { url: 'https://cloud.example/v1/data', token: 'token' },
        'https://cloud.example/v1',
        { activationProbe, assertRemoteMutationFenceHeld },
      )).rejects.toBe(lost);

      expect(assertRemoteMutationFenceHeld).toHaveBeenNthCalledWith(1, 35_000);
      expect(assertRemoteMutationFenceHeld).toHaveBeenNthCalledWith(2, 35_000);
      expect(fileSystemMock.createUploadTask).toHaveBeenCalledTimes(1);
      expect(core.cloudPutFile).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'does not start a mobile self-hosted Cloud streamed upload after fence loss (activation=%s)',
    async (activationProbe) => {
      const localUri = 'file://document/attachments/cloud-stream-lease.txt';
      fileSystemMock.getInfoAsync.mockImplementation(async (uri: string) => (
        uri === localUri ? { exists: true, size: 3 } : { exists: false }
      ));
      fileSystemMock.readAsStringAsync.mockResolvedValue('AQID');
      const core = await import('@mindwtr/core');
      const lost = new SyncRemoteMutationFenceLostError();
      const assertRemoteMutationFenceHeld = vi.fn().mockRejectedValue(lost);
      const appData: AppData = {
        tasks: [{
          id: 'task-cloud-stream-lease', title: 'Task', status: 'inbox', tags: [], contexts: [],
          attachments: [{
            id: 'cloud-stream-lease', kind: 'file', title: 'cloud-stream-lease.txt',
            uri: localUri, localStatus: 'available',
            createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z',
          }],
          createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z',
        }],
        projects: [], sections: [], areas: [], settings: {},
      };

      await expect(attachmentSync.syncCloudAttachments(
        appData,
        { url: 'https://cloud.example/v1/data', token: 'token' },
        'https://cloud.example/v1',
        { activationProbe, assertRemoteMutationFenceHeld },
      )).rejects.toBe(lost);

      expect(assertRemoteMutationFenceHeld).toHaveBeenCalledWith(35_000);
      expect(fileSystemMock.createUploadTask).not.toHaveBeenCalled();
      expect(core.cloudPutFile).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'prevents a mobile Dropbox attachment upload after lease takeover (activation=%s)',
    async (activationProbe) => {
      fileSystemMock.getInfoAsync.mockResolvedValue({ exists: true, size: 3 });
      fileSystemMock.readAsStringAsync.mockResolvedValue('AQID');
      const dropbox = await import('./dropbox-sync');
      const lost = new SyncRemoteMutationFenceLostError();
      const assertRemoteMutationFenceHeld = vi.fn().mockRejectedValue(lost);
      const appData: AppData = {
        tasks: [{
          id: 'task-lease', title: 'Task', status: 'inbox', tags: [], contexts: [],
          attachments: [{
            id: 'dropbox-lease', kind: 'file', title: 'lease.txt',
            uri: 'file://document/attachments/lease.txt', localStatus: 'available',
            createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z',
          }],
          createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z',
        }],
        projects: [], sections: [], areas: [], settings: {},
      };

      await expect(attachmentSync.syncDropboxAttachments(
        appData,
        'dropbox-client-id',
        fetch,
        { activationProbe, assertRemoteMutationFenceHeld },
      )).rejects.toBe(lost);

      expect(dropbox.getDropboxFileMetadata).toHaveBeenCalled();
      expect(dropbox.uploadDropboxFileVersioned).not.toHaveBeenCalled();
    },
  );

  // SEC-07: `uri` travels inside the synced document, so an attachment that still points
  // outside the managed attachments directory after the migration pre-pass is refused as
  // an upload source — its bytes are never read for upload and never leave the device —
  // while its localStatus is still reconciled like any other attachment.
  it('never uploads a cloud attachment whose uri stayed outside the managed attachments directory', async () => {
    const originalUri = 'file://document/audio-captures/audio.m4a';
    const managedUri = 'file://document/attachments/audio.m4a';
    fileSystemMock.getInfoAsync.mockImplementation(async (uri: string) => {
      if (uri === managedUri) return { exists: false };
      if (uri === originalUri) return { exists: true, size: 3 };
      return { exists: false };
    });
    // Migration into the managed dir fails, so the uri stays where the document put it.
    fileSystemMock.copyAsync.mockRejectedValueOnce(new Error('copy failed'));
    fileSystemMock.writeAsStringAsync.mockRejectedValueOnce(new Error('write failed'));
    fileSystemMock.readAsStringAsync.mockResolvedValue('AQID');
    const core = await import('@mindwtr/core');
    const appData: AppData = {
      tasks: [
        {
          id: 'task-1',
          title: 'Task',
          status: 'inbox',
          tags: [],
          contexts: [],
          attachments: [
            {
              id: 'audio',
              kind: 'file',
              title: 'Audio Note',
              uri: originalUri,
              mimeType: 'audio/mp4',
              size: 3,
              localStatus: 'missing',
              createdAt: '2026-06-09T14:26:59.059Z',
              updatedAt: '2026-06-09T14:26:59.059Z',
            },
          ],
          createdAt: '2026-06-09T14:26:59.059Z',
          updatedAt: '2026-06-09T14:26:59.059Z',
        },
      ],
      projects: [],
      sections: [],
      areas: [],
      settings: {},
    };

    const { syncCloudAttachments } = attachmentSync;

    const { didMutate, data } = syncResult(
      await syncCloudAttachments(
        appData,
        { url: 'https://cloud.example/v1/data', token: 'token' },
        'https://cloud.example/v1'
      ),
      appData,
    );

    expect(core.cloudPutFile).not.toHaveBeenCalled();
    // The single read is the migration pre-pass's byte fallback; the refused upload
    // adds none of its own (without the guard it reads the file a second time).
    expect(fileSystemMock.readAsStringAsync).toHaveBeenCalledTimes(1);
    expect(didMutate).toBe(true);
    expect(data.tasks[0].attachments?.[0]).toMatchObject({
      localStatus: 'available',
      uri: originalUri,
    });
    expect(data.tasks[0].attachments?.[0]?.cloudKey).toBeUndefined();
  });

  it('uploads a candidate-cleared local attachment when proving a cloud backend', async () => {
    const localUri = 'file://document/attachments/notes.txt';
    fileSystemMock.getInfoAsync.mockImplementation(async (uri: string) => (
      uri === localUri ? { exists: true, size: 3 } : { exists: false }
    ));
    fileSystemMock.readAsStringAsync.mockResolvedValue('AQID');
    const core = await import('@mindwtr/core');
    const appData: AppData = {
      tasks: [{
        id: 'task-1',
        title: 'Task',
        status: 'inbox',
        tags: [],
        contexts: [],
        attachments: [{
          id: 'notes',
          kind: 'file',
          title: 'notes.txt',
          uri: localUri,
          localStatus: 'available',
          createdAt: '2026-08-03T10:00:00.000Z',
          updatedAt: '2026-08-03T10:00:00.000Z',
        }],
        createdAt: '2026-08-03T10:00:00.000Z',
        updatedAt: '2026-08-03T10:00:00.000Z',
      }],
      projects: [],
      sections: [],
      areas: [],
      settings: {},
    };

    const { syncCloudAttachments } = attachmentSync;
    const { didMutate, data } = syncResult(
      await syncCloudAttachments(
        appData,
        { url: 'https://candidate.example/v1/data', token: 'candidate-token' },
        'https://candidate.example/v1',
        { activationProbe: true },
      ),
      appData,
    );

    expect(didMutate).toBe(true);
    expect(core.cloudPutFile).toHaveBeenCalledWith(
      'https://candidate.example/v1/attachments/notes.txt',
      expect.any(ArrayBuffer),
      'application/octet-stream',
      { token: 'candidate-token' },
    );
    expect(fileSystemMock.copyAsync).toHaveBeenCalledWith({
      from: localUri,
      to: expect.stringMatching(/^file:\/\/cache\/mindwtr-upload-/),
    });
    expect(fileSystemMock.readAsStringAsync.mock.calls.every(([uri]) => (
      typeof uri === 'string' && uri.startsWith('file://cache/mindwtr-upload-')
    ))).toBe(true);
    expect(data.tasks[0]?.attachments?.[0]).toMatchObject({
      cloudKey: 'attachments/notes.txt',
      fileHash: sha256Hex(new Uint8Array([1, 2, 3])),
      localStatus: 'available',
    });
  });

  it('proves an existing candidate cloud attachment with a bounded GET and hash check', async () => {
    const remoteBytes = new Uint8Array([1, 2, 3]);
    fileSystemMock.getInfoAsync.mockResolvedValue({ exists: false });
    const core = await import('@mindwtr/core');
    vi.mocked(core.cloudGetFile).mockResolvedValue(remoteBytes.slice().buffer as ArrayBuffer);
    const appData: AppData = {
      tasks: [{
        id: 'task-1',
        title: 'Task',
        status: 'inbox',
        tags: [],
        contexts: [],
        attachments: [{
          id: 'remote-notes',
          kind: 'file',
          title: 'notes.txt',
          uri: '',
          cloudKey: 'attachments/remote-notes.txt',
          fileHash: sha256Hex(remoteBytes),
          localStatus: 'missing',
          createdAt: '2026-08-03T10:00:00.000Z',
          updatedAt: '2026-08-03T10:00:00.000Z',
        }],
        createdAt: '2026-08-03T10:00:00.000Z',
        updatedAt: '2026-08-03T10:00:00.000Z',
      }],
      projects: [],
      sections: [],
      areas: [],
      settings: {},
    };

    const { syncCloudAttachments } = attachmentSync;
    const { didMutate, data } = syncResult(
      await syncCloudAttachments(
        appData,
        { url: 'https://candidate.example/v1/data', token: 'candidate-token' },
        'https://candidate.example/v1',
        { activationProbe: true, phase: 'post-merge' },
      ),
      appData,
    );

    expect(core.cloudGetFile).toHaveBeenCalledWith(
      'https://candidate.example/v1/attachments/remote-notes.txt',
      { token: 'candidate-token' },
    );
    expect(didMutate).toBe(true);
    expect(data.tasks[0]?.attachments?.[0]).toMatchObject({
      cloudKey: 'attachments/remote-notes.txt',
      localStatus: 'available',
    });
  });

  it('does not delete a deterministic cloud target when local data changes after upload', async () => {
    fileSystemMock.getInfoAsync.mockResolvedValue({ exists: true, size: 3 });
    fileSystemMock.readAsStringAsync.mockResolvedValue('AQID');
    const core = await import('@mindwtr/core');
    const abortError = new Error('Local changes detected during sync');
    let assertCalls = 0;
    const appData: AppData = {
      tasks: [
        {
          id: 'task-1',
          title: 'Task',
          status: 'inbox',
          tags: [],
          contexts: [],
          attachments: [
            {
              id: 'race',
              kind: 'file' as const,
              title: 'race.txt',
              uri: 'file://document/attachments/race.txt',
              localStatus: 'available' as const,
              createdAt: '2026-04-18T10:00:00.000Z',
              updatedAt: '2026-04-18T10:00:00.000Z',
            },
          ],
          createdAt: '2026-04-18T10:00:00.000Z',
          updatedAt: '2026-04-18T10:00:00.000Z',
        },
      ],
      projects: [],
      sections: [],
      areas: [],
      settings: {},
    };

    const { syncCloudAttachments } = attachmentSync;

    await expect(syncCloudAttachments(
      appData,
      { url: 'https://cloud.example/v1/data', token: 'token' },
      'https://cloud.example/v1',
      {
        assertCurrent: () => {
          assertCalls += 1;
          if (assertCalls > 1) throw abortError;
        },
      }
    )).rejects.toBe(abortError);

    expect(core.cloudPutFile).toHaveBeenCalledWith(
      'https://cloud.example/v1/attachments/race.txt',
      expect.any(ArrayBuffer),
      'application/octet-stream',
      { token: 'token' }
    );
    expect(core.cloudDeleteFile).not.toHaveBeenCalled();
    expect(appData.tasks[0].attachments?.[0]?.cloudKey).toBeUndefined();
  });

  it('propagates abort signals into cloud attachment uploads', async () => {
    fileSystemMock.getInfoAsync.mockResolvedValue({ exists: true, size: 3 });
    fileSystemMock.readAsStringAsync.mockResolvedValue('AQID');
    const core = await import('@mindwtr/core');
    const abortController = new AbortController();
    const uploadError = new Error('Upload aborted by sync lifecycle');
    const appData: AppData = {
      tasks: [
        {
          id: 'task-1',
          title: 'Task',
          status: 'inbox',
          tags: [],
          contexts: [],
          attachments: [
            {
              id: 'mid-upload',
              kind: 'file' as const,
              title: 'mid-upload.txt',
              uri: 'file://document/attachments/mid-upload.txt',
              localStatus: 'available' as const,
              createdAt: '2026-04-18T10:00:00.000Z',
              updatedAt: '2026-04-18T10:00:00.000Z',
            },
          ],
          createdAt: '2026-04-18T10:00:00.000Z',
          updatedAt: '2026-04-18T10:00:00.000Z',
        },
      ],
      projects: [],
      sections: [],
      areas: [],
      settings: {},
    };

    vi.mocked(core.cloudPutFile).mockImplementationOnce(async (_url, _data, _contentType, options) => {
      expect(options?.signal).toBe(abortController.signal);
      abortController.abort();
      throw uploadError;
    });

    const { syncCloudAttachments } = attachmentSync;

    await expect(syncCloudAttachments(
      appData,
      { url: 'https://cloud.example/v1/data', token: 'token' },
      'https://cloud.example/v1',
      { signal: abortController.signal }
    )).rejects.toBe(uploadError);

    expect(core.cloudDeleteFile).not.toHaveBeenCalled();
    expect(appData.tasks[0].attachments?.[0]?.cloudKey).toBeUndefined();
  });

  it('propagates abort signals from Dropbox attachment uploads', async () => {
    fileSystemMock.getInfoAsync.mockResolvedValue({ exists: true, size: 3 });
    fileSystemMock.readAsStringAsync.mockResolvedValue('AQID');
    const dropbox = await import('./dropbox-sync');
    const abortController = new AbortController();
    const uploadError = new Error('Dropbox upload aborted by sync lifecycle');
    const appData: AppData = {
      tasks: [
        {
          id: 'task-1',
          title: 'Task',
          status: 'inbox',
          tags: [],
          contexts: [],
          attachments: [
            {
              id: 'dropbox-mid-upload',
              kind: 'file' as const,
              title: 'dropbox-mid-upload.txt',
              uri: 'file://document/attachments/dropbox-mid-upload.txt',
              localStatus: 'available' as const,
              createdAt: '2026-04-18T10:00:00.000Z',
              updatedAt: '2026-04-18T10:00:00.000Z',
            },
          ],
          createdAt: '2026-04-18T10:00:00.000Z',
          updatedAt: '2026-04-18T10:00:00.000Z',
        },
      ],
      projects: [],
      sections: [],
      areas: [],
      settings: {},
    };

    vi.mocked(dropbox.uploadDropboxFileVersioned).mockImplementationOnce(async () => {
      abortController.abort();
      throw uploadError;
    });

    const { syncDropboxAttachments } = attachmentSync;

    await expect(syncDropboxAttachments(
      appData,
      'dropbox-client-id',
      fetch,
      { signal: abortController.signal }
    )).rejects.toBe(uploadError);

    expect(appData.tasks[0].attachments?.[0]?.cloudKey).toBeUndefined();
  });

  it('cancels a stalled Dropbox attachment body after headers without retrying or writing', async () => {
    const core = await import('@mindwtr/core');
    const dropbox = await import('./dropbox-sync');
    const abortController = new AbortController();
    const resolveAccessToken = vi.fn().mockResolvedValue('dropbox-token');
    const cancelBody = vi.fn();
    const networkFetch = vi.fn(async () => new Response(new ReadableStream({
      pull: () => new Promise<void>(() => undefined),
      cancel: cancelBody,
    }), { status: 200 })) as typeof fetch;
    const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    Object.defineProperty(AbortSignal, 'any', {
      configurable: true,
      value: undefined,
    });

    try {
      const fetcher = core.createAbortableFetch(networkFetch, {
        baseSignal: abortController.signal,
      });
      vi.mocked(dropbox.downloadDropboxFile).mockImplementationOnce(
        (accessToken, path, requestFetcher, requestOptions) => core.downloadDropboxFile(
          accessToken,
          path,
          requestFetcher,
          requestOptions,
        ),
      );
      fileSystemMock.getInfoAsync.mockResolvedValue({ exists: false });
      const appData: AppData = {
        tasks: [{
          id: 'task-stalled-download',
          title: 'Task',
          status: 'inbox',
          tags: [],
          contexts: [],
          attachments: [{
            id: 'stalled-download',
            kind: 'file',
            title: 'stalled.txt',
            uri: 'file://document/attachments/stalled.txt',
            cloudKey: 'attachments/stalled.txt',
            localStatus: 'missing',
            createdAt: '2026-08-27T00:00:00.000Z',
            updatedAt: '2026-08-27T00:00:00.000Z',
          }],
          createdAt: '2026-08-27T00:00:00.000Z',
          updatedAt: '2026-08-27T00:00:00.000Z',
        }],
        projects: [],
        sections: [],
        areas: [],
        settings: {},
      };

      const syncPromise = attachmentSync.syncDropboxAttachments(
        appData,
        'dropbox-client-id',
        fetcher,
        { signal: abortController.signal, resolveAccessToken },
      );
      await vi.waitFor(() => expect(networkFetch).toHaveBeenCalledOnce());

      abortController.abort(new DOMException('Sync cycle cancelled', 'AbortError'));

      await expect(syncPromise).rejects.toMatchObject({ name: 'AbortError' });
      expect(cancelBody).toHaveBeenCalledOnce();
      expect(dropbox.downloadDropboxFile).toHaveBeenCalledOnce();
      expect(resolveAccessToken).toHaveBeenCalledOnce();
      expect(fileSystemMock.writeAsStringAsync).not.toHaveBeenCalled();
      expect(fileSystemMock.StorageAccessFramework.writeAsStringAsync).not.toHaveBeenCalled();
    } finally {
      if (anyDescriptor) {
        Object.defineProperty(AbortSignal, 'any', anyDescriptor);
      } else {
        Reflect.deleteProperty(AbortSignal, 'any');
      }
    }
  });

  it('uses a candidate Dropbox token resolver when no durable credentials exist', async () => {
    const localUri = 'file://document/attachments/first-connect.txt';
    fileSystemMock.getInfoAsync.mockImplementation(async (uri: string) => (
      uri === localUri ? { exists: true, size: 3 } : { exists: false }
    ));
    fileSystemMock.readAsStringAsync.mockResolvedValue('AQID');
    const dropbox = await import('./dropbox-sync');
    const dropboxAuth = await import('./dropbox-auth');
    vi.mocked(dropbox.uploadDropboxFileVersioned).mockResolvedValue({ rev: null });
    vi.mocked(dropboxAuth.getValidDropboxAccessToken).mockRejectedValue(
      new Error('Dropbox is not connected'),
    );
    const resolveAccessToken = vi.fn().mockResolvedValue('candidate-token');
    const appData: AppData = {
      tasks: [{
        id: 'task-1',
        title: 'Task',
        status: 'inbox',
        tags: [],
        contexts: [],
        attachments: [{
          id: 'first-connect',
          kind: 'file',
          title: 'first-connect.txt',
          uri: localUri,
          localStatus: 'available',
          createdAt: '2026-08-03T10:00:00.000Z',
          updatedAt: '2026-08-03T10:00:00.000Z',
        }],
        createdAt: '2026-08-03T10:00:00.000Z',
        updatedAt: '2026-08-03T10:00:00.000Z',
      }],
      projects: [],
      sections: [],
      areas: [],
      settings: {},
    };

    const { syncDropboxAttachments } = attachmentSync;
    const { didMutate, data } = syncResult(
      await syncDropboxAttachments(appData, 'dropbox-client-id', fetch, { activationProbe: true, resolveAccessToken }),
      appData,
    );

    expect(didMutate).toBe(true);
    expect(resolveAccessToken).toHaveBeenCalledWith(false);
    expect(dropboxAuth.getValidDropboxAccessToken).not.toHaveBeenCalled();
    expect(dropbox.uploadDropboxFileVersioned).toHaveBeenCalledWith(
      'candidate-token',
      'attachments/first-connect.txt',
      expect.any(ArrayBuffer),
      null,
      fetch,
      expect.anything(),
    );
    expect(data.tasks[0].attachments?.[0]).toMatchObject({
      cloudKey: 'attachments/first-connect.txt',
      localStatus: 'available',
    });
  });

  it('refreshes candidate Dropbox credentials without falling back to an old account', async () => {
    const localUri = 'file://document/attachments/reconnect.txt';
    fileSystemMock.getInfoAsync.mockImplementation(async (uri: string) => (
      uri === localUri ? { exists: true, size: 3 } : { exists: false }
    ));
    fileSystemMock.readAsStringAsync.mockResolvedValue('AQID');
    const dropbox = await import('./dropbox-sync');
    const dropboxAuth = await import('./dropbox-auth');
    vi.mocked(dropboxAuth.getValidDropboxAccessToken).mockResolvedValue('old-account-token');
    vi.mocked(dropbox.uploadDropboxFileVersioned)
      .mockRejectedValueOnce(new Error('Dropbox upload failed: HTTP 401'))
      .mockResolvedValueOnce({ rev: null });
    const resolveAccessToken = vi.fn(async (forceRefresh: boolean) => (
      forceRefresh ? 'candidate-refreshed-token' : 'candidate-access-token'
    ));
    const appData: AppData = {
      tasks: [{
        id: 'task-1',
        title: 'Task',
        status: 'inbox',
        tags: [],
        contexts: [],
        attachments: [{
          id: 'reconnect',
          kind: 'file',
          title: 'reconnect.txt',
          uri: localUri,
          localStatus: 'available',
          createdAt: '2026-08-03T10:00:00.000Z',
          updatedAt: '2026-08-03T10:00:00.000Z',
        }],
        createdAt: '2026-08-03T10:00:00.000Z',
        updatedAt: '2026-08-03T10:00:00.000Z',
      }],
      projects: [],
      sections: [],
      areas: [],
      settings: {},
    };

    const { syncDropboxAttachments } = attachmentSync;
    const { didMutate, data } = syncResult(
      await syncDropboxAttachments(appData, 'dropbox-client-id', fetch, { activationProbe: true, resolveAccessToken }),
      appData,
    );

    expect(didMutate).toBe(true);
    expect(resolveAccessToken).toHaveBeenNthCalledWith(1, false);
    expect(resolveAccessToken).toHaveBeenNthCalledWith(2, false);
    expect(resolveAccessToken).toHaveBeenNthCalledWith(3, true);
    expect(dropboxAuth.getValidDropboxAccessToken).not.toHaveBeenCalled();
    expect(vi.mocked(dropbox.uploadDropboxFileVersioned).mock.calls.map(([token]) => token)).toEqual([
      'candidate-access-token',
      'candidate-refreshed-token',
    ]);
    expect(data.tasks[0].attachments?.[0]?.cloudKey).toBe('attachments/reconnect.txt');
  });

  it('does not leave partial cloud metadata when a later attachment aborts the batch', async () => {
    fileSystemMock.getInfoAsync.mockResolvedValue({ exists: true, size: 3 });
    fileSystemMock.readAsStringAsync.mockResolvedValue('AQID');
    const core = await import('@mindwtr/core');
    const abortError = new Error('Local changes detected during sync');
    let assertCalls = 0;
    const appData: AppData = {
      tasks: [
        {
          id: 'task-1',
          title: 'Task',
          status: 'inbox',
          tags: [],
          contexts: [],
          attachments: [
            {
              id: 'first',
              kind: 'file' as const,
              title: 'first.txt',
              uri: 'file://document/attachments/first.txt',
              localStatus: 'available' as const,
              createdAt: '2026-04-18T10:00:00.000Z',
              updatedAt: '2026-04-18T10:00:00.000Z',
            },
            {
              id: 'second',
              kind: 'file' as const,
              title: 'second.txt',
              uri: 'file://document/attachments/second.txt',
              localStatus: 'available' as const,
              createdAt: '2026-04-18T10:00:00.000Z',
              updatedAt: '2026-04-18T10:00:00.000Z',
            },
          ],
          createdAt: '2026-04-18T10:00:00.000Z',
          updatedAt: '2026-04-18T10:00:00.000Z',
        },
      ],
      projects: [],
      sections: [],
      areas: [],
      settings: {},
    };

    const { syncCloudAttachments } = attachmentSync;

    await expect(syncCloudAttachments(
      appData,
      { url: 'https://cloud.example/v1/data', token: 'token' },
      'https://cloud.example/v1',
      {
        assertCurrent: () => {
          assertCalls += 1;
          if (assertCalls > 3) throw abortError;
        },
      }
    )).rejects.toBe(abortError);

    expect(appData.tasks[0].attachments?.[0]?.cloudKey).toBeUndefined();
    expect(appData.tasks[0].attachments?.[1]?.cloudKey).toBeUndefined();
    expect(core.cloudDeleteFile).not.toHaveBeenCalled();
  });

  it('keeps uncertain cloud targets after a network failure without dropping earlier successful metadata', async () => {
    fileSystemMock.getInfoAsync.mockResolvedValue({ exists: true, size: 3 });
    fileSystemMock.readAsStringAsync.mockResolvedValue('AQID');
    const core = await import('@mindwtr/core');
    const networkError = new Error('network flap');
    const appData: AppData = {
      tasks: [
        {
          id: 'task-1',
          title: 'Task',
          status: 'inbox',
          tags: [],
          contexts: [],
          attachments: [
            {
              id: 'first',
              kind: 'file' as const,
              title: 'first.txt',
              uri: 'file://document/attachments/first.txt',
              localStatus: 'available' as const,
              createdAt: '2026-04-18T10:00:00.000Z',
              updatedAt: '2026-04-18T10:00:00.000Z',
            },
            {
              id: 'second',
              kind: 'file' as const,
              title: 'second.txt',
              uri: 'file://document/attachments/second.txt',
              localStatus: 'available' as const,
              createdAt: '2026-04-18T10:00:00.000Z',
              updatedAt: '2026-04-18T10:00:00.000Z',
            },
          ],
          createdAt: '2026-04-18T10:00:00.000Z',
          updatedAt: '2026-04-18T10:00:00.000Z',
        },
      ],
      projects: [],
      sections: [],
      areas: [],
      settings: {},
    };
    vi.mocked(core.cloudPutFile)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(networkError);

    const { syncCloudAttachments } = attachmentSync;

    const { didMutate, data } = syncResult(
      await syncCloudAttachments(
        appData,
        { url: 'https://cloud.example/v1/data', token: 'token' },
        'https://cloud.example/v1'
      ),
      appData,
    );

    expect(didMutate).toBe(true);
    expect(data.tasks[0].attachments?.[0]?.cloudKey).toBe('attachments/first.txt');
    expect(data.tasks[0].attachments?.[1]?.cloudKey).toBeUndefined();
    expect(core.cloudDeleteFile).not.toHaveBeenCalled();
  });

  // #1057 check-on-touch content detection, running through the REAL core lifecycle.
  // The same stat+hash mismatch means opposite things in the two halves of a sync
  // cycle, and getting the direction backwards would ping-pong two devices' uploads
  // against each other forever — so each direction is pinned per backend.
  describe('check-on-touch content changes', () => {
    const OLD_BYTES = new Uint8Array([1, 2, 3]);
    const NEW_BYTES = new Uint8Array([1, 2, 3, 4]);
    const NEWER_BYTES = new Uint8Array([1, 2, 3, 4, 5]);

    const makeEditedAppData = (id: string, overrides: Partial<Attachment> = {}): AppData => ({
      tasks: [
        {
          id: 'task-1',
          title: 'Task',
          status: 'inbox',
          tags: [],
          contexts: [],
          attachments: [
            {
              id,
              kind: 'file',
              title: `${id}.txt`,
              uri: `file://document/attachments/${id}.txt`,
              cloudKey: `attachments/${id}.txt`,
              localStatus: 'available',
              fileHash: sha256Hex(OLD_BYTES),
              contentMtimeMs: 1000,
              contentSize: OLD_BYTES.length,
              createdAt: '2026-04-18T10:00:00.000Z',
              updatedAt: '2026-04-18T10:00:00.000Z',
              ...overrides,
            },
          ],
          createdAt: '2026-04-18T10:00:00.000Z',
          updatedAt: '2026-04-18T10:00:00.000Z',
        },
      ],
      projects: [],
      sections: [],
      areas: [],
      settings: {},
    });

    it('records a changed file-backend attachment without writing it during prepare', async () => {
      const syncPath = 'file://sync/data.json';
      const localUri = 'file://document/attachments/edited.txt';
      const remoteUri = 'file://sync/attachments/edited.txt';

      fileSystemMock.getInfoAsync.mockImplementation(async (uri: string) => {
        if (uri === localUri) return { exists: true, size: NEW_BYTES.length, modificationTime: 2 };
        if (uri === remoteUri) return { exists: true, size: OLD_BYTES.length };
        return { exists: false };
      });
      fileSystemMock.readAsStringAsync.mockResolvedValue(base64Of(NEW_BYTES));

      const { syncFileAttachments } = attachmentSync;
      const appData = makeEditedAppData('edited');

      const { didMutate, data } = syncResult(
        await syncFileAttachments(appData, syncPath, undefined, { phase: 'prepare' }),
        appData,
      );
      const attachment = data.tasks[0].attachments?.[0];

      expect(didMutate).toBe(true);
      expect(fileSystemMock.copyAsync).not.toHaveBeenCalled();
      expect(attachment?.fileHash).toBe(sha256Hex(NEW_BYTES));
      expect(attachment?.contentMtimeMs).toBe(2000);
      expect(attachment?.contentSize).toBe(NEW_BYTES.length);
      expect(attachment?.contentRev).toBe(1);
      expect(attachment?.pendingContentUpload).toBe(true);
    });

    it('defers a cloud edit and refuses to upload different bytes that land after prepare', async () => {
      const localUri = 'file://document/attachments/edited-cloud.txt';
      const core = await import('@mindwtr/core');
      const { syncCloudAttachments } = attachmentSync;
      let liveBytes = NEW_BYTES;
      let modificationTime = 2;
      fileSystemMock.getInfoAsync.mockImplementation(async (uri: string) => (
        uri === localUri
          ? { exists: true, size: liveBytes.length, modificationTime }
          : { exists: false }
      ));
      fileSystemMock.readAsStringAsync.mockImplementation(async () => base64Of(liveBytes));

      const prepared = makeEditedAppData('edited-cloud');
      const preparedResult = syncResult(
        await syncCloudAttachments(
          prepared,
          { url: 'https://cloud.example/v1/data', token: 'token' },
          'https://cloud.example/v1',
          { phase: 'prepare' },
        ),
        prepared,
      );
      const preparedAttachment = preparedResult.data.tasks[0].attachments?.[0];

      expect(core.cloudPutFile).not.toHaveBeenCalled();
      expect(preparedAttachment).toMatchObject({
        fileHash: sha256Hex(NEW_BYTES),
        contentRev: 1,
        pendingContentUpload: true,
      });

      vi.clearAllMocks();
      liveBytes = NEWER_BYTES;
      modificationTime = 3;
      const postMergeResult = syncResult(
        await syncCloudAttachments(
          preparedResult.data,
          { url: 'https://cloud.example/v1/data', token: 'token' },
          'https://cloud.example/v1',
          { phase: 'post-merge' },
        ),
        preparedResult.data,
      );

      expect(core.cloudPutFile).not.toHaveBeenCalled();
      expect(postMergeResult.data.tasks[0].attachments?.[0]).toMatchObject({
        fileHash: sha256Hex(NEW_BYTES),
        contentRev: 1,
        pendingContentUpload: true,
      });
    });

    it('defers a Dropbox edit and refuses to upload different bytes that land after prepare', async () => {
      const localUri = 'file://document/attachments/edited-dropbox.txt';
      const dropbox = await import('./dropbox-sync');
      const { syncDropboxAttachments } = attachmentSync;
      let liveBytes = NEW_BYTES;
      let modificationTime = 2;
      fileSystemMock.getInfoAsync.mockImplementation(async (uri: string) => (
        uri === localUri
          ? { exists: true, size: liveBytes.length, modificationTime }
          : { exists: false }
      ));
      fileSystemMock.readAsStringAsync.mockImplementation(async () => base64Of(liveBytes));

      const prepared = makeEditedAppData('edited-dropbox');
      const preparedResult = syncResult(
        await syncDropboxAttachments(
          prepared,
          'dropbox-client-id',
          fetch,
          { phase: 'prepare' },
        ),
        prepared,
      );
      const preparedAttachment = preparedResult.data.tasks[0].attachments?.[0];

      expect(dropbox.uploadDropboxFileVersioned).not.toHaveBeenCalled();
      expect(preparedAttachment).toMatchObject({
        fileHash: sha256Hex(NEW_BYTES),
        contentRev: 1,
        pendingContentUpload: true,
      });

      vi.clearAllMocks();
      liveBytes = NEWER_BYTES;
      modificationTime = 3;
      const postMergeResult = syncResult(
        await syncDropboxAttachments(
          preparedResult.data,
          'dropbox-client-id',
          fetch,
          { phase: 'post-merge' },
        ),
        preparedResult.data,
      );

      expect(dropbox.getDropboxFileMetadata).not.toHaveBeenCalled();
      expect(dropbox.uploadDropboxFileVersioned).not.toHaveBeenCalled();
      expect(postMergeResult.data.tasks[0].attachments?.[0]).toMatchObject({
        fileHash: sha256Hex(NEW_BYTES),
        contentRev: 1,
        pendingContentUpload: true,
      });
    });

    it('never puts an attachment title or file name into a log line (SEC-16, #854)', async () => {
      const appLog = await import('./app-log');
      const { syncWebdavAttachments } = attachmentSync;
      const core = await import('@mindwtr/core');
      const appData = makeEditedAppData('logged-webdav');
      const attachment = appData.tasks[0].attachments![0];
      attachment.title = 'Divorce settlement draft.pdf';
      attachment.uri = 'file://elsewhere/Divorce settlement draft.pdf';
      fileSystemMock.getInfoAsync.mockResolvedValue({ exists: true, size: 4, modificationTime: 2 });
      fileSystemMock.readAsStringAsync.mockResolvedValue(base64Of(NEW_BYTES));
      vi.mocked(core.webdavFileExists).mockResolvedValue(true);

      await syncWebdavAttachments(
        appData,
        { url: 'https://example.com/data.json', username: 'u', password: 'p' },
        'https://example.com',
      );

      const logged = [...vi.mocked(appLog.logInfo).mock.calls, ...vi.mocked(appLog.logWarn).mock.calls];
      expect(logged.length).toBeGreaterThan(0);
      expect(JSON.stringify(logged)).not.toContain('Divorce settlement draft');
    });

    it('refuses a public http WebDAV target before making any request (SEC-10a)', async () => {
      // The expo-file-system uploader talks to the server directly, so core's cleartext
      // guard never sees it; without the mobile guard this streamed Basic credentials
      // and the file's bytes in the clear.
      const core = await import('@mindwtr/core');
      const { syncWebdavAttachments } = attachmentSync;
      const config = { url: 'http://public.example/data.json', username: 'u', password: 'p' };

      await expect(
        syncWebdavAttachments(makeEditedAppData('insecure-webdav'), config, 'http://public.example')
      ).rejects.toThrow(/HTTPS/);

      expect(core.webdavMakeDirectory).not.toHaveBeenCalled();
      expect(core.webdavPutFileVersioned).not.toHaveBeenCalled();
    });

    it('does not finish a timed-out streamed upload until cancellation and the upload both settle', async () => {
      const cancellation = deferred();
      const upload = deferred<{ status: number }>();
      const cancelAsync = vi.fn(() => cancellation.promise);
      const uploadAsync = vi.fn(() => upload.promise);
      fileSystemMock.createUploadTask.mockReturnValue({ uploadAsync, cancelAsync });
      const { uploadWebdavFileWithFileSystem } = await import('./attachment-sync-backends/common');

      let settled = false;
      const pending = uploadWebdavFileWithFileSystem(
        'https://example.com/attachments/a.bin',
        'file://document/attachments/a.bin',
        'application/octet-stream',
        'u',
        'p',
        false,
        undefined,
        3,
        undefined,
        null,
        1,
      ).finally(() => { settled = true; });

      await vi.waitFor(() => expect(cancelAsync).toHaveBeenCalledOnce());
      expect(settled).toBe(false);
      cancellation.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      upload.reject(new Error('native upload cancelled'));
      await expect(pending).rejects.toThrow('WebDAV streamed upload timed out');
      expect(uploadAsync).toHaveBeenCalledTimes(1);
    });

    it('bounds a cloud streamed upload and allows the next upload after it terminates', async () => {
      const upload = deferred<{ status: number }>();
      const cancelAsync = vi.fn(async () => undefined);
      const nextUploadAsync = vi.fn().mockResolvedValue({ status: 200 });
      fileSystemMock.createUploadTask
        .mockReturnValueOnce({ uploadAsync: () => upload.promise, cancelAsync })
        .mockReturnValueOnce({ uploadAsync: nextUploadAsync, cancelAsync: vi.fn() });
      const { uploadCloudFileWithFileSystem } = await import('./attachment-sync-backends/common');

      const pending = uploadCloudFileWithFileSystem(
        'https://sync.example/attachments/a.bin',
        'file://document/attachments/a.bin',
        'application/octet-stream',
        'token',
        undefined,
        3,
        undefined,
        1,
      );

      await vi.waitFor(() => expect(cancelAsync).toHaveBeenCalledOnce());
      await Promise.resolve();
      upload.reject(new Error('native upload cancelled'));
      await expect(pending).rejects.toThrow('Cloud streamed upload timed out');

      await expect(uploadCloudFileWithFileSystem(
        'https://sync.example/attachments/b.bin',
        'file://document/attachments/b.bin',
        'application/octet-stream',
        'token',
        undefined,
        3,
        undefined,
        100,
      )).resolves.toBe(true);
      expect(nextUploadAsync).toHaveBeenCalledOnce();
    });

    it('does not finish after cancellation acknowledgement while the native upload is still live', async () => {
      const upload = deferred<{ status: number }>();
      const cancelAsync = vi.fn(async () => undefined);
      fileSystemMock.createUploadTask.mockReturnValue({ uploadAsync: () => upload.promise, cancelAsync });
      const { uploadWebdavFileWithFileSystem } = await import('./attachment-sync-backends/common');

      let settled = false;
      const pending = uploadWebdavFileWithFileSystem(
        'https://example.com/attachments/a.bin',
        'file://document/attachments/a.bin',
        'application/octet-stream',
        'u',
        'p',
        false,
        undefined,
        3,
        undefined,
        null,
        1,
      ).finally(() => { settled = true; });

      await vi.waitFor(() => expect(cancelAsync).toHaveBeenCalledOnce());
      await Promise.resolve();
      expect(settled).toBe(false);
      upload.reject(new Error('native upload cancelled'));
      await expect(pending).rejects.toThrow('WebDAV streamed upload timed out');
    });

    it('fails safely after the upload terminates even when cancellation never acknowledges', async () => {
      const cancellation = deferred();
      const upload = deferred<{ status: number }>();
      const cancelAsync = vi.fn(() => cancellation.promise);
      fileSystemMock.createUploadTask.mockReturnValue({ uploadAsync: () => upload.promise, cancelAsync });

      let settled = false;
      const {
        StreamedUploadCancellationUnconfirmedError,
        uploadWebdavFileWithFileSystem,
      } = await import('./attachment-sync-backends/common');
      const pending = uploadWebdavFileWithFileSystem(
        'https://example.com/attachments/a.bin',
        'file://document/attachments/a.bin',
        'application/octet-stream',
        'u',
        'p',
        false,
        undefined,
        3,
        undefined,
        null,
        1,
      ).finally(() => { settled = true; });

      await vi.waitFor(() => expect(cancelAsync).toHaveBeenCalledOnce());
      expect(settled).toBe(false);
      upload.reject(new Error('native upload terminated'));
      await expect(pending).rejects.toBeInstanceOf(StreamedUploadCancellationUnconfirmedError);
      expect(settled).toBe(true);
    });

    it.each([
      ['rejects cancellation', vi.fn(async () => { throw new Error('cancel failed'); })],
      ['has no cancellation API', undefined],
    ])('waits for terminal upload settlement when the native task %s', async (_case, cancelAsync) => {
      const upload = deferred<{ status: number }>();
      fileSystemMock.createUploadTask.mockReturnValue({ uploadAsync: () => upload.promise, cancelAsync });
      const {
        StreamedUploadCancellationUnconfirmedError,
        uploadWebdavFileWithFileSystem,
      } = await import('./attachment-sync-backends/common');

      let settled = false;
      const pending = uploadWebdavFileWithFileSystem(
        'https://example.com/attachments/a.bin',
        'file://document/attachments/a.bin',
        'application/octet-stream',
        'u',
        'p',
        false,
        undefined,
        3,
        undefined,
        null,
        1,
      ).finally(() => { settled = true; });

      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(settled).toBe(false);
      upload.reject(new Error('native upload terminated'));
      await expect(pending).rejects.toBeInstanceOf(StreamedUploadCancellationUnconfirmedError);
    });

    it('defers a WebDAV edit during prepare and downloads when newer remote content wins', async () => {
      const localUri = 'file://document/attachments/edited-webdav.txt';
      const config = { url: 'https://example.com/data.json', username: 'u', password: 'p' };
      const core = await import('@mindwtr/core');
      const { syncWebdavAttachments } = attachmentSync;

      const primeFileSystem = () => {
        fileSystemMock.getInfoAsync.mockImplementation(async (uri: string) => (
          uri === localUri
            ? { exists: true, size: NEW_BYTES.length, modificationTime: 2 }
            : { exists: false }
        ));
        fileSystemMock.readAsStringAsync.mockResolvedValue(base64Of(NEW_BYTES));
        vi.mocked(core.webdavFileExists).mockResolvedValue(true);
        vi.mocked(core.webdavPutFileVersioned).mockResolvedValue(undefined);
        // Remote still holds the bytes the recorded fileHash describes.
        vi.mocked(core.webdavGetFile).mockResolvedValue(
          OLD_BYTES.slice().buffer as ArrayBuffer
        );
      };

      primeFileSystem();
      const prepared = makeEditedAppData('edited-webdav');
      const preparedResult = syncResult(
        await syncWebdavAttachments(prepared, config, 'https://example.com', undefined, { phase: 'prepare' }),
        prepared,
      );

      expect(core.webdavPutFileVersioned).not.toHaveBeenCalled();
      expect(core.webdavGetFile).not.toHaveBeenCalled();
      expect(preparedResult.data.tasks[0].attachments?.[0]?.fileHash).toBe(sha256Hex(NEW_BYTES));
      expect(preparedResult.data.tasks[0].attachments?.[0]?.contentRev).toBe(1);
      expect(preparedResult.data.tasks[0].attachments?.[0]?.pendingContentUpload).toBe(true);

      vi.clearAllMocks();
      (await import('@mindwtr/core')).resetUnhashableAttachmentStatsForTests();
      primeFileSystem();
      const merged = makeEditedAppData('edited-webdav', {
        contentRev: 2,
        contentMtimeMs: undefined,
        contentSize: undefined,
        pendingContentUpload: undefined,
      });
      await syncWebdavAttachments(merged, config, 'https://example.com', undefined, { phase: 'post-merge' });

      expect(core.webdavPutFileVersioned).not.toHaveBeenCalled();
      expect(core.webdavGetFile).toHaveBeenCalledWith(
        'https://example.com/attachments/edited-webdav.txt',
        expect.anything()
      );
      // The stale local copy is overwritten with the remote bytes (temp-then-rename).
      expect(fileSystemMock.writeAsStringAsync).toHaveBeenCalledWith(
        expect.stringMatching(/^file:\/\/document\/attachments\/edited-webdav\.txt\.tmp-/),
        base64Of(OLD_BYTES),
        { encoding: 'base64' }
      );
    });

    // BUG-16: an attachment predating `fileHash` cannot have had newer remote content
    // adopted by the merge (fileHash is synced), so post-merge records what is on disk
    // as the baseline instead of downloading over it. Prepare still treats the same
    // state as this device's edit candidate, but defers the remote write until merge.
    it('adopts a missing hash post-merge and defers the prepare-side candidate', async () => {
      const localUri = 'file://document/attachments/nohash.txt';
      const config = { url: 'https://example.com/data.json', username: 'u', password: 'p' };
      const core = await import('@mindwtr/core');
      const { syncWebdavAttachments } = attachmentSync;

      fileSystemMock.getInfoAsync.mockImplementation(async (uri: string) => (
        uri === localUri
          ? { exists: true, size: NEW_BYTES.length, modificationTime: 2 }
          : { exists: false }
      ));
      fileSystemMock.readAsStringAsync.mockResolvedValue(base64Of(NEW_BYTES));
      vi.mocked(core.webdavFileExists).mockResolvedValue(true);
      vi.mocked(core.webdavPutFileVersioned).mockResolvedValue(undefined);

      const merged = makeEditedAppData('nohash', { fileHash: undefined });
      const mergedResult = syncResult(
        await syncWebdavAttachments(merged, config, 'https://example.com', undefined, { phase: 'post-merge' }),
        merged,
      );
      const mergedAttachment = mergedResult.data.tasks[0].attachments?.[0];

      expect(mergedResult.didMutate).toBe(true);
      expect(core.webdavGetFile).not.toHaveBeenCalled();
      expect(core.webdavPutFileVersioned).not.toHaveBeenCalled();
      expect(mergedAttachment?.fileHash).toBe(sha256Hex(NEW_BYTES));
      expect(mergedAttachment?.contentMtimeMs).toBe(2000);
      expect(mergedAttachment?.contentRev).toBeUndefined();

      const prepared = makeEditedAppData('nohash', { fileHash: undefined });
      const preparedResult = syncResult(
        await syncWebdavAttachments(prepared, config, 'https://example.com', undefined, { phase: 'prepare' }),
        prepared,
      );

      expect(core.webdavPutFileVersioned).not.toHaveBeenCalled();
      expect(preparedResult.data.tasks[0].attachments?.[0]?.contentRev).toBe(1);
      expect(preparedResult.data.tasks[0].attachments?.[0]?.pendingContentUpload).toBe(true);
    });

    // BUG-16: an unhashable file used to be re-read (up to the 50 MB cap) every single
    // cycle with nothing to show for it. The retry now waits for the stat to move again.
    it('re-reads an unhashable changed file only once per observed stat', async () => {
      const syncPath = 'file://sync/data.json';
      const localUri = 'file://document/attachments/unhashable.txt';

      fileSystemMock.getInfoAsync.mockImplementation(async (uri: string) => {
        if (uri === localUri) return { exists: true, size: NEW_BYTES.length, modificationTime: 2 };
        if (uri === 'file://sync/attachments/unhashable.txt') return { exists: true, size: OLD_BYTES.length };
        return { exists: false };
      });
      fileSystemMock.readAsStringAsync.mockRejectedValue(new Error('permission revoked'));

      const { syncFileAttachments } = attachmentSync;
      // Each cycle carries the previous cycle's folded document forward, exactly as the
      // sync run does after persisting it.
      let current = makeEditedAppData('unhashable');

      current = syncResult(
        await syncFileAttachments(current, syncPath, undefined, { phase: 'prepare' }),
        current,
      ).data;
      expect(fileSystemMock.readAsStringAsync).toHaveBeenCalledTimes(1);

      current = syncResult(
        await syncFileAttachments(current, syncPath, undefined, { phase: 'prepare' }),
        current,
      ).data;
      expect(fileSystemMock.readAsStringAsync).toHaveBeenCalledTimes(1);

      // Nothing is published on an unconfirmed guess.
      const attachment = current.tasks[0].attachments?.[0];
      expect(attachment?.fileHash).toBe(sha256Hex(OLD_BYTES));
      expect(attachment?.contentMtimeMs).toBe(1000);
      expect(attachment?.contentRev).toBeUndefined();
    });
  });

  // The teeth of the purity contract: a deep-frozen document makes any in-place write throw
  // (strict mode), so a backend that still mutates its input fails loudly here.
  describe('backend purity (frozen input document)', () => {
    const BYTES = new Uint8Array([1, 2, 3]);
    const localUri = 'file://document/attachments/pure.txt';

    /** A locally-available attachment with no cloud key: every backend has real work to do. */
    const frozenData = (): AppData => deepFreeze({
      tasks: [{
        id: 'task-1',
        title: 'Task',
        status: 'inbox' as const,
        tags: [],
        contexts: [],
        attachments: [{
          id: 'pure',
          kind: 'file' as const,
          title: 'pure.txt',
          uri: localUri,
          localStatus: 'available' as const,
          createdAt: '2026-04-18T10:00:00.000Z',
          updatedAt: '2026-04-18T10:00:00.000Z',
        }],
        createdAt: '2026-04-18T10:00:00.000Z',
        updatedAt: '2026-04-18T10:00:00.000Z',
      }],
      projects: [],
      sections: [],
      areas: [],
      settings: { attachments: { pendingRemoteDeletes: [{ cloudKey: 'cloudkit:old-attachment' }] } },
    });

    beforeEach(async () => {
      fileSystemMock.getInfoAsync.mockImplementation(async (uri: string) => {
        const exists = uri === localUri || uri.startsWith('file://cache/mindwtr-upload-');
        return exists
          ? { exists: true, size: BYTES.length, modificationTime: 1 }
          : { exists: false };
      });
      fileSystemMock.readAsStringAsync.mockResolvedValue(base64Of(BYTES));
      const core = await import('@mindwtr/core');
      vi.mocked(core.webdavFileExists).mockResolvedValue(false);
      vi.mocked(core.webdavPutFileVersioned).mockResolvedValue(undefined);
      vi.mocked(core.cloudPutFile).mockResolvedValue(undefined);
    });

    const expectUploadedCopy = (result: AppData | boolean | null | undefined, input: AppData, cloudKey: string) => {
      const { didMutate, data } = syncResult(result, input);
      expect(didMutate).toBe(true);
      expect(data.tasks[0].attachments?.[0]?.cloudKey).toBe(cloudKey);
      expect(input.tasks[0].attachments?.[0]?.cloudKey).toBeUndefined();
    };

    it('file', async () => {
      const appData = frozenData();
      expectUploadedCopy(
        await attachmentSync.syncFileAttachments(appData, 'file://sync/data.json', undefined, { phase: 'post-merge' }),
        appData,
        'attachments/pure.txt',
      );
    });

    it('webdav', async () => {
      const appData = frozenData();
      expectUploadedCopy(
        await attachmentSync.syncWebdavAttachments(
          appData,
          { url: 'https://example.com/data.json', username: 'u', password: 'p' },
          'https://example.com',
          undefined,
          { phase: 'post-merge' },
        ),
        appData,
        'attachments/pure.txt',
      );
    });

    it('cloud', async () => {
      const appData = frozenData();
      expectUploadedCopy(
        await attachmentSync.syncCloudAttachments(
          appData,
          { url: 'https://cloud.example/v1/data', token: 'token' },
          'https://cloud.example/v1',
          { phase: 'post-merge' },
        ),
        appData,
        'attachments/pure.txt',
      );
    });

    it('dropbox', async () => {
      const appData = frozenData();
      expectUploadedCopy(
        await attachmentSync.syncDropboxAttachments(appData, 'dropbox-client-id', fetch, { phase: 'post-merge' }),
        appData,
        'attachments/pure.txt',
      );
    });

    it('cloudkit, including the pending-remote-delete flush', async () => {
      const cloudkit = await import('./cloudkit-sync');
      vi.mocked(cloudkit.deleteCloudKitAttachmentAssets).mockResolvedValue(undefined);
      vi.mocked(cloudkit.saveCloudKitAttachmentAsset).mockResolvedValue(undefined as never);

      const appData = frozenData();
      const { didMutate, data } = syncResult(
        await attachmentSync.syncCloudKitAttachments(appData, undefined, { phase: 'post-merge' }),
        appData,
      );

      expect(didMutate).toBe(true);
      expect(data.tasks[0].attachments?.[0]?.cloudKey).toBe('cloudkit:pure');
      expect(data.settings.attachments?.pendingRemoteDeletes).toBeUndefined();
      expect(appData.tasks[0].attachments?.[0]?.cloudKey).toBeUndefined();
      expect(appData.settings.attachments?.pendingRemoteDeletes).toHaveLength(1);
    });
  });
});
