import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppData } from '@mindwtr/core';
import { Directory } from 'expo-file-system';
import * as DocumentPicker from 'expo-document-picker';
import { Platform } from 'react-native';

import {
  FileSyncRetainedGenerationError,
  pickAndParseSyncFolder,
  readSyncFile,
  readSyncFileVersioned,
  writeSyncFile,
} from './storage-file';
import { writeSyncArtifactBytes } from './storage-file-encryption';

const fileSystemMock = vi.hoisted(() => {
  let storedText = '';
  return {
    __setStoredText: (value: string) => {
      storedText = value;
    },
    __getStoredText: () => storedText,
    __getUtf8ByteLength: (value: string) => new TextEncoder().encode(value).byteLength,
    StorageAccessFramework: {
      readAsStringAsync: vi.fn(async () => storedText),
      writeAsStringAsync: vi.fn(async (_uri: string, content: string) => {
        storedText = content + storedText.slice(content.length);
      }),
      createFileAsync: vi.fn(),
      readDirectoryAsync: vi.fn(),
      deleteAsync: vi.fn(),
      requestDirectoryPermissionsAsync: vi.fn(),
    },
    getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
    readAsStringAsync: vi.fn(),
    readDirectoryAsync: vi.fn(),
    writeAsStringAsync: vi.fn(),
    copyAsync: vi.fn(),
    deleteAsync: vi.fn(),
    moveAsync: vi.fn(),
    EncodingType: { UTF8: 'utf8', Base64: 'base64' },
    cacheDirectory: 'file://cache/',
    documentDirectory: 'file://document/',
  };
});

vi.mock('./file-system', () => fileSystemMock);

// SafDocumentsCore.kt's listing and lookup through the expo SAF mock's folder, so a test that
// fails expo's listing fails this one too.
vi.mock('./saf-documents', () => ({
  listSafChildren: vi.fn(async (dir: string) => {
    const uris: string[] = await fileSystemMock.StorageAccessFramework.readDirectoryAsync(dir);
    // A path-like provider's display name: the decoded tail of the document ID.
    const nameOf = (uri: string) => {
      const decoded = decodeURIComponent(uri);
      return decoded.slice(Math.max(decoded.lastIndexOf('/'), decoded.lastIndexOf(':')) + 1);
    };
    return uris.map((uri) => ({ uri, name: nameOf(uri), mime: null, size: null, lastModified: null }));
  }),
  statSafDocument: vi.fn(async () => null),
  readSafDocument: vi.fn(async () => ({
    bytes: new TextEncoder().encode(await fileSystemMock.StorageAccessFramework.readAsStringAsync()),
    lengthVerified: true,
  })),
}));

vi.mock('expo-document-picker', () => ({
  getDocumentAsync: vi.fn(),
}));

vi.mock('expo-sharing', () => ({
  isAvailableAsync: vi.fn(),
  shareAsync: vi.fn(),
}));

const expoFilesMock = vi.hoisted(() => new Map<string, string | Uint8Array>());
const streamWriteState = vi.hoisted(() => ({ failNext: false }));

vi.mock('expo-file-system', () => {
  class File {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    get exists() {
      return expoFilesMock.has(this.uri);
    }
    create() {
      expoFilesMock.set(this.uri, '');
    }
    write(content: string | Uint8Array) {
      if (streamWriteState.failNext) {
        streamWriteState.failNext = false;
        throw new Error('Unable to open output stream for URI: ' + this.uri);
      }
      expoFilesMock.set(this.uri, content);
      // content:// writes land in the same store the SAF read mock serves, so
      // writeSyncFile's read-back verification sees what the stream wrote.
      if (this.uri.startsWith('content://') && typeof content === 'string') {
        fileSystemMock.__setStoredText(content);
      }
    }
    delete() {
      expoFilesMock.delete(this.uri);
    }
    copy(target: { uri: string }) {
      expoFilesMock.set(target.uri, expoFilesMock.get(this.uri) ?? '');
    }
    async text() {
      return String(expoFilesMock.get(this.uri) ?? '');
    }
  }
  class Directory {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    static pickDirectoryAsync = vi.fn();
  }
  return { Directory, File };
});

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
}));

vi.mock('./app-log', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const bookmarkMocks = vi.hoisted(() => ({
  createSyncPathBookmark: vi.fn(),
  supportsBookmarkedSyncFileIO: vi.fn(() => false),
  readBookmarkedSyncFileText: vi.fn(),
  writeBookmarkedSyncFileText: vi.fn(),
}));

vi.mock('./sync-path-bookmarks', () => bookmarkMocks);

const syncFileUri =
  'content://com.android.externalstorage.documents/tree/primary%3AMindwtr/document/primary%3AMindwtr%2Fdata.json';

const appData = (settings: AppData['settings']): AppData => ({
  tasks: [],
  projects: [],
  sections: [],
  areas: [],
  settings,
});

describe('storage-file sync writes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    streamWriteState.failNext = false;
    fileSystemMock.__setStoredText('');
    expoFilesMock.clear();
    fileSystemMock.StorageAccessFramework.readDirectoryAsync.mockResolvedValue([]);
    fileSystemMock.readDirectoryAsync.mockResolvedValue([]);
  });

  it('refuses a write without a document version and writes nothing', async () => {
    await expect(writeSyncFile(syncFileUri, appData({ weekStart: 'monday' })))
      .rejects.toThrow('refusing an unconditional write');
    expect(fileSystemMock.StorageAccessFramework.writeAsStringAsync).not.toHaveBeenCalled();
    expect(fileSystemMock.StorageAccessFramework.createFileAsync).not.toHaveBeenCalled();
    expect(expoFilesMock.size).toBe(0);
  });

  // The RSAF shape from #1001: the provider never declares FLAG_SUPPORTS_WRITE,
  // so expo's legacy SAF write refuses every attempt and waiting cannot help —
  // the raw output-stream write must carry the bytes instead.
  it('falls back to the output-stream write when the provider pre-check reports not writable', async () => {
    const bytes = new TextEncoder().encode('{"tasks":[],"projects":[]}');
    fileSystemMock.StorageAccessFramework.writeAsStringAsync.mockRejectedValueOnce(
      new Error(
        "Call to function 'ExponentFileSystem.writeAsStringAsync' has been rejected.\n→ Caused by: java.io.IOException: Location 'content://com.chiller3.rsaf.documents/tree/Crypt/document/Crypt%2Fdata.json' isn't writable."
      )
    );

    await writeSyncArtifactBytes(syncFileUri, bytes);

    expect(fileSystemMock.StorageAccessFramework.writeAsStringAsync).toHaveBeenCalledTimes(1);
    expect(expoFilesMock.get(syncFileUri)).toEqual(bytes);
  }, 10_000);

  it('retries the provider write once when the stream fallback also fails', async () => {
    const bytes = new TextEncoder().encode('{"tasks":[],"projects":[]}');
    fileSystemMock.StorageAccessFramework.writeAsStringAsync.mockRejectedValueOnce(
      new Error("Location 'content://x/data.json' isn't writable.")
    );
    streamWriteState.failNext = true;

    await writeSyncArtifactBytes(syncFileUri, bytes);

    expect(fileSystemMock.StorageAccessFramework.writeAsStringAsync).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('fails closed when the encrypted-sibling discovery listing is unavailable', async () => {
    fileSystemMock.StorageAccessFramework.readDirectoryAsync.mockRejectedValue(
      new Error('provider listing denied')
    );

    await expect(readSyncFile(syncFileUri)).rejects.toThrow('provider listing denied');
  }, 10_000);

  it('refuses a folder where the write probe cannot create a file, and never rewrites data.json (B3)', async () => {
    const treeUri = 'content://com.example.provider/tree/root%3AMindwtr';
    const dataUri = `${treeUri}/document/root%3AMindwtr%2Fdata.json`;
    const stored = JSON.stringify(appData({ weekStart: 'monday' }));
    fileSystemMock.__setStoredText(stored);
    fileSystemMock.StorageAccessFramework.requestDirectoryPermissionsAsync.mockResolvedValue({
      granted: true,
      directoryUri: treeUri,
    });
    fileSystemMock.StorageAccessFramework.readDirectoryAsync.mockResolvedValue([dataUri]);
    fileSystemMock.StorageAccessFramework.createFileAsync.mockRejectedValue(new Error('the provider refused a new document'));

    await expect(pickAndParseSyncFolder()).rejects.toThrow('the provider refused a new document');
    expect(fileSystemMock.StorageAccessFramework.writeAsStringAsync).not.toHaveBeenCalled();
    expect(fileSystemMock.__getStoredText()).toBe(stored);
  });

  it('completes Android folder setup when the test-file content write fails after creation', async () => {
    const treeUri = 'content://com.chiller3.rsaf.documents/tree/remote%3AStaleCheck';
    const dataUri = `${treeUri}/document/remote%3AStaleCheck%2Fdata.json`;
    const testUri = `${treeUri}/document/remote%3AStaleCheck%2Fmindwtr-write-test`;
    fileSystemMock.StorageAccessFramework.requestDirectoryPermissionsAsync.mockResolvedValue({
      granted: true,
      directoryUri: treeUri,
    });
    fileSystemMock.StorageAccessFramework.createFileAsync.mockImplementation(
      async (_dir: string, name: string) => (name === 'data.json' ? dataUri : testUri)
    );
    fileSystemMock.StorageAccessFramework.writeAsStringAsync.mockRejectedValue(
      new Error(`Location '${testUri}' isn't writable.`)
    );

    const result = await pickAndParseSyncFolder();

    // An empty folder is picked as the folder itself; the first sync publishes data.json.
    expect(result?.__fileUri).toBe(`${treeUri}/document/remote%3AStaleCheck`);
    expect(dataUri).toContain('data.json');
  });
});

describe('iOS sync file bookmarks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    streamWriteState.failNext = false;
    fileSystemMock.__setStoredText('');
    expoFilesMock.clear();
    fileSystemMock.StorageAccessFramework.readDirectoryAsync.mockResolvedValue([]);
    fileSystemMock.readDirectoryAsync.mockResolvedValue([]);
    bookmarkMocks.supportsBookmarkedSyncFileIO.mockReturnValue(false);
    bookmarkMocks.createSyncPathBookmark.mockResolvedValue(null);
    (Platform as { OS: string }).OS = 'ios';
  });

  afterEach(() => {
    (Platform as { OS: string }).OS = 'android';
  });

  it('creates a bookmark when falling back to picking an existing sync file', async () => {
    (Directory as unknown as { pickDirectoryAsync: ReturnType<typeof vi.fn> })
      .pickDirectoryAsync.mockRejectedValue(new Error('Operation was canceled'));
    (DocumentPicker.getDocumentAsync as ReturnType<typeof vi.fn>).mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///gdrive/Mindwtr/backup.json' }],
    });
    bookmarkMocks.createSyncPathBookmark.mockResolvedValue('bm-token');
    expoFilesMock.set('file:///gdrive/Mindwtr/backup.json', JSON.stringify(appData({})));

    const result = await pickAndParseSyncFolder();

    expect(bookmarkMocks.createSyncPathBookmark).toHaveBeenCalledWith('file:///gdrive/Mindwtr/backup.json');
    expect(result?.__fileBookmark).toBe('bm-token');
    expect(result?.__fileUri).toBe('file:///gdrive/Mindwtr/backup.json');
  });

  // The fallback sheet looks identical to the folder sheet it follows, so the
  // caller explains it first; declining must not open an uninvited second
  // picker (#1068).
  it('asks before the file fallback and stops when the user declines', async () => {
    (Directory as unknown as { pickDirectoryAsync: ReturnType<typeof vi.fn> })
      .pickDirectoryAsync.mockRejectedValue(new Error('Operation was canceled'));
    (DocumentPicker.getDocumentAsync as ReturnType<typeof vi.fn>).mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///owncloud/Mindwtr/backup.json' }],
    });
    bookmarkMocks.createSyncPathBookmark.mockResolvedValue('bm-token');
    expoFilesMock.set('file:///owncloud/Mindwtr/backup.json', JSON.stringify(appData({})));

    const declined = await pickAndParseSyncFolder({ confirmFileFallback: async () => false });
    expect(declined).toBeNull();
    expect(DocumentPicker.getDocumentAsync).not.toHaveBeenCalled();

    const accepted = await pickAndParseSyncFolder({ confirmFileFallback: async () => true });
    expect(accepted?.__fileUri).toBe('file:///owncloud/Mindwtr/backup.json');
  });

  it('stops instead of repairing from data.json.bak when iCloud has offloaded data.json (B5 guard)', async () => {
    const dir = 'file:///icloud/Mindwtr';
    expoFilesMock.set(`${dir}/.data.json.icloud`, '');
    expoFilesMock.set(`${dir}/data.json.bak`, JSON.stringify(appData({ weekStart: 'sunday' })));
    fileSystemMock.readDirectoryAsync.mockResolvedValue(['.data.json.icloud', 'data.json.bak']);
    fileSystemMock.getInfoAsync.mockImplementation(async (uri: string) => (
      uri.endsWith('/data.json.bak') ? { exists: true, size: 40 } : { exists: false }
    ));

    await expect(readSyncFileVersioned(`${dir}/data.json`)).rejects.toBeInstanceOf(FileSyncRetainedGenerationError);
    fileSystemMock.getInfoAsync.mockResolvedValue({ exists: false });
  });

  it('reads the sync file through the bookmarked native path when available', async () => {
    bookmarkMocks.supportsBookmarkedSyncFileIO.mockReturnValue(true);
    const remote = appData({ weekStart: 'monday' });
    bookmarkMocks.readBookmarkedSyncFileText.mockResolvedValue(JSON.stringify(remote));

    await expect(readSyncFile('file:///gdrive/Mindwtr/backup.json', { bookmark: 'bm-token' }))
      .resolves.toEqual(remote);
  });

  it('falls back to direct file access when the bookmarked read returns null', async () => {
    bookmarkMocks.supportsBookmarkedSyncFileIO.mockReturnValue(true);
    bookmarkMocks.readBookmarkedSyncFileText.mockResolvedValue(null);
    const remote = appData({ weekStart: 'sunday' });
    expoFilesMock.set('file:///gdrive/Mindwtr/backup.json', JSON.stringify(remote));

    await expect(readSyncFile('file:///gdrive/Mindwtr/backup.json', { bookmark: 'bm-token' }))
      .resolves.toEqual(remote);
  });

  it('falls back to direct file access when the bookmarked read fails', async () => {
    bookmarkMocks.supportsBookmarkedSyncFileIO.mockReturnValue(true);
    bookmarkMocks.readBookmarkedSyncFileText.mockRejectedValue(new Error('scope lost'));

    await expect(readSyncFile('file:///gdrive/Mindwtr/backup.json', { bookmark: 'bm-token' }))
      .resolves.toBeNull();
  });
});
