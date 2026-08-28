import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppData } from '@mindwtr/core';
import { Directory } from 'expo-file-system';
import * as DocumentPicker from 'expo-document-picker';
import { Platform } from 'react-native';

import { pickAndParseSyncFolder, readSyncFile, writeSyncFile } from './storage-file';

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
    cacheDirectory: 'file://cache/',
    documentDirectory: 'file://document/',
  };
});

vi.mock('./file-system', () => fileSystemMock);

vi.mock('expo-document-picker', () => ({
  getDocumentAsync: vi.fn(),
}));

vi.mock('expo-sharing', () => ({
  isAvailableAsync: vi.fn(),
  shareAsync: vi.fn(),
}));

const expoFilesMock = vi.hoisted(() => new Map<string, string>());
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
    write(content: string) {
      if (streamWriteState.failNext) {
        streamWriteState.failNext = false;
        throw new Error('Unable to open output stream for URI: ' + this.uri);
      }
      expoFilesMock.set(this.uri, content);
      // content:// writes land in the same store the SAF read mock serves, so
      // writeSyncFile's read-back verification sees what the stream wrote.
      if (this.uri.startsWith('content://')) {
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
      return expoFilesMock.get(this.uri) ?? '';
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
    fileSystemMock.__setStoredText('');
    expoFilesMock.clear();
    fileSystemMock.StorageAccessFramework.readDirectoryAsync.mockResolvedValue([]);
    fileSystemMock.readDirectoryAsync.mockResolvedValue([]);
  });

  it('pads shorter SAF writes so stale bytes cannot corrupt data.json', async () => {
    const previous = JSON.stringify(
      appData({
        syncPreferences: { appearance: true, language: true, gtd: true },
        appearance: { showTaskAge: true },
        weekStart: 'monday',
        dateFormat: 'ymd',
        timeFormat: '24h',
      }),
      null,
      2
    );
    const nextData = appData({
      syncPreferences: { language: true },
      weekStart: 'monday',
    });
    const next = JSON.stringify(nextData, null, 2);
    fileSystemMock.__setStoredText(previous);

    await writeSyncFile(syncFileUri, nextData);

    const written = fileSystemMock.StorageAccessFramework.writeAsStringAsync.mock.calls[0]?.[1] as string;
    expect(fileSystemMock.__getUtf8ByteLength(written)).toBeGreaterThanOrEqual(
      fileSystemMock.__getUtf8ByteLength(previous)
    );
    expect(written.startsWith(next)).toBe(true);
    expect(written.slice(next.length)).toMatch(/^\s+$/);
    expect(JSON.parse(fileSystemMock.__getStoredText())).toEqual(nextData);
  }, 10_000);

  // The RSAF shape from #1001: the provider never declares FLAG_SUPPORTS_WRITE,
  // so expo's legacy SAF write refuses every attempt and waiting cannot help —
  // the raw output-stream write must carry the sync file instead.
  it('falls back to the output-stream write when the provider pre-check reports not writable', async () => {
    const nextData = appData({ weekStart: 'monday' });
    fileSystemMock.StorageAccessFramework.writeAsStringAsync.mockRejectedValueOnce(
      new Error(
        "Call to function 'ExponentFileSystem.writeAsStringAsync' has been rejected.\n→ Caused by: java.io.IOException: Location 'content://com.chiller3.rsaf.documents/tree/Crypt/document/Crypt%2Fdata.json' isn't writable."
      )
    );

    await writeSyncFile(syncFileUri, nextData);

    expect(fileSystemMock.StorageAccessFramework.writeAsStringAsync).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fileSystemMock.__getStoredText())).toEqual(nextData);
  }, 10_000);

  it('retries the provider write once when the stream fallback also fails', async () => {
    const nextData = appData({ weekStart: 'monday' });
    fileSystemMock.StorageAccessFramework.writeAsStringAsync.mockRejectedValueOnce(
      new Error("Location 'content://x/data.json' isn't writable.")
    );
    streamWriteState.failNext = true;

    await writeSyncFile(syncFileUri, nextData);

    expect(fileSystemMock.StorageAccessFramework.writeAsStringAsync).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fileSystemMock.__getStoredText())).toEqual(nextData);
  }, 10_000);

  it('fails closed when the encrypted-sibling discovery listing is unavailable', async () => {
    fileSystemMock.StorageAccessFramework.readDirectoryAsync.mockRejectedValue(
      new Error('provider listing denied')
    );

    await expect(readSyncFile(syncFileUri)).rejects.toThrow('provider listing denied');
  }, 10_000);

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

    expect(result?.__fileUri).toBe(dataUri);
  });
});

describe('iOS sync file bookmarks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('writes the sync file through the bookmarked native path when available', async () => {
    bookmarkMocks.supportsBookmarkedSyncFileIO.mockReturnValue(true);
    bookmarkMocks.writeBookmarkedSyncFileText.mockResolvedValue(undefined);

    const data = appData({});
    await writeSyncFile('file:///gdrive/Mindwtr/backup.json', data, { bookmark: 'bm-token' });

    expect(bookmarkMocks.writeBookmarkedSyncFileText).toHaveBeenCalledWith(
      'bm-token',
      JSON.stringify(data, null, 2)
    );
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
