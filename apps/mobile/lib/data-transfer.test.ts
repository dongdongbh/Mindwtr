import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_IMPORT_SOURCE_LIMITS, getBackupSourceFileDiagnostic, MAX_BACKUP_SOURCE_BYTES, type AppData } from '@mindwtr/core';
import type { ParsedTodoistProject } from '@mindwtr/core/todoist-import';
import { Platform } from 'react-native';

const emptyData: AppData = {
  tasks: [],
  projects: [],
  sections: [],
  areas: [],
  people: [],
  settings: {},
};

const storageMocks = vi.hoisted(() => ({
  getData: vi.fn(),
  saveData: vi.fn(),
}));

const storeStateRef = vi.hoisted(() => ({
  current: {
    lastDataChangeAt: 1,
    fetchData: vi.fn(),
  },
}));

const coreMocks = vi.hoisted(() => ({
  flushPendingSave: vi.fn(),
  useTaskStoreGetState: vi.fn(),
}));

const logMocks = vi.hoisted(() => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

const fileSystemMocks = vi.hoisted(() => ({
  fileContents: new Map<string, string>(),
  fileWrites: [] as string[],
  fileReads: [] as string[],
  fileSizes: new Map<string, number>(),
  writeError: null as Error | null,
  deleteError: null as Error | null,
  truncateThenThrow: null as Error | null,
  getInfoAsync: vi.fn(),
  readAsStringAsync: vi.fn(),
  writeAsStringAsync: vi.fn(),
  requestDirectoryPermissionsAsync: vi.fn(),
  createSafFileAsync: vi.fn(),
  writeSafFileAsync: vi.fn(),
  deleteSafFileAsync: vi.fn(),
  readSafDirectoryAsync: vi.fn(),
  deletedDocuments: new Set<string>(),
}));

const sharingMocks = vi.hoisted(() => ({
  isAvailableAsync: vi.fn(),
  shareAsync: vi.fn(),
}));

vi.mock('@mindwtr/core', async () => {
  const actual = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
  return {
    ...actual,
    flushPendingSave: coreMocks.flushPendingSave,
    useTaskStore: {
      getState: coreMocks.useTaskStoreGetState,
    },
  };
});

vi.mock('expo-document-picker', () => ({
  getDocumentAsync: vi.fn(),
}));

vi.mock('./file-system', () => ({
  StorageAccessFramework: {
    requestDirectoryPermissionsAsync: fileSystemMocks.requestDirectoryPermissionsAsync,
    createFileAsync: fileSystemMocks.createSafFileAsync,
    writeAsStringAsync: fileSystemMocks.writeSafFileAsync,
    deleteAsync: fileSystemMocks.deleteSafFileAsync,
    readDirectoryAsync: fileSystemMocks.readSafDirectoryAsync,
  },
  documentDirectory: 'file://document/',
  cacheDirectory: 'file://cache/',
  getInfoAsync: fileSystemMocks.getInfoAsync,
  readAsStringAsync: fileSystemMocks.readAsStringAsync,
  writeAsStringAsync: fileSystemMocks.writeAsStringAsync,
  EncodingType: {
    Base64: 'base64',
  },
}));

vi.mock('expo-sharing', () => sharingMocks);

vi.mock('expo-file-system', () => ({
  Paths: {
    document: {
      uri: 'file://document',
    },
  },
  Directory: class Directory {
    uri: string;
    exists = true;

    constructor(uri: string) {
      this.uri = uri;
    }

    create() {}
    list() {
      return Array.from(fileSystemMocks.fileContents.keys())
        .filter((uri) => uri.startsWith(`${this.uri}/`))
        .map((uri) => ({ uri }));
    }
  },
  File: class File {
    uri: string;

    constructor(uri: string) {
      this.uri = uri;
    }

    get exists() { return fileSystemMocks.fileContents.has(this.uri); }
    create() { fileSystemMocks.fileContents.set(this.uri, ''); }
    delete() { if (fileSystemMocks.deleteError) throw fileSystemMocks.deleteError; fileSystemMocks.fileContents.delete(this.uri); }
    move(destination: { uri: string }) {
      const contents = fileSystemMocks.fileContents.get(this.uri) ?? '';
      fileSystemMocks.fileContents.delete(this.uri);
      fileSystemMocks.fileContents.set(destination.uri, contents);
      this.uri = destination.uri;
    }
    write(text: string) {
      if (fileSystemMocks.writeError) throw fileSystemMocks.writeError;

      const cut = fileSystemMocks.truncateThenThrow;
      if (cut) { fileSystemMocks.truncateThenThrow = null; fileSystemMocks.fileContents.set(this.uri, ''); throw cut; }
      fileSystemMocks.fileWrites.push(text);
      fileSystemMocks.fileContents.set(this.uri, text);
    }
    async text() { fileSystemMocks.fileReads.push(this.uri); return fileSystemMocks.fileContents.get(this.uri) ?? '{}'; }
    textSync() { return fileSystemMocks.fileContents.get(this.uri) ?? '{}'; }
    async bytes() { return new Uint8Array(); }
    get size() { return fileSystemMocks.fileSizes.get(this.uri) ?? (fileSystemMocks.fileContents.get(this.uri) ?? '').length; }
  },
}));

vi.mock('./storage-adapter', () => ({
  mobileStorage: {
    getData: storageMocks.getData,
    saveData: storageMocks.saveData,
  },
}));

vi.mock('./app-log', () => ({
  logError: logMocks.logError,
  logInfo: logMocks.logInfo,
}));

import {
  cleanupInterruptedBackupExport,
  createMobileRecoverySnapshot,
  exportCurrentDataBackup,
  importTodoistData,
  inspectBackupDocument,
  inspectMindwtrCsvDocument,
  listLocalDataSnapshots,
  restoreLocalDataSnapshot,
} from './data-transfer';

const parsedProjects: ParsedTodoistProject[] = [{
  name: 'Todoist',
  sections: [],
  checklistItemCount: 0,
  recurringCount: 0,
  tasks: [{
    title: 'Imported task',
    tags: [],
    checklist: [],
  }],
}];

const SNAPSHOT_FILE_NAME_PATTERN =
  /^data\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}(?:\.\d+)?\.snapshot\.json$/u;

describe('mobile data transfer', () => {
  beforeEach(() => {
    Platform.OS = 'web';
    vi.clearAllMocks();
    fileSystemMocks.fileContents.clear();
    fileSystemMocks.fileReads.length = 0;
    fileSystemMocks.fileSizes.clear();
    fileSystemMocks.fileWrites = [];
    fileSystemMocks.writeError = null;
    fileSystemMocks.deleteError = null;
    fileSystemMocks.truncateThenThrow = null;
    fileSystemMocks.readAsStringAsync.mockResolvedValue('');
    fileSystemMocks.getInfoAsync.mockResolvedValue({ exists: true, size: 1 });
    fileSystemMocks.writeAsStringAsync.mockResolvedValue(undefined);
    fileSystemMocks.requestDirectoryPermissionsAsync.mockResolvedValue({ granted: false });
    fileSystemMocks.createSafFileAsync.mockResolvedValue(
      'content://com.android.providers.downloads.documents/document/downloads%3AMindwtr%20Backup.json'
    );
    fileSystemMocks.writeSafFileAsync.mockResolvedValue(undefined);
    fileSystemMocks.deletedDocuments.clear();

    fileSystemMocks.deleteSafFileAsync.mockImplementation(async (uri: string) => { fileSystemMocks.deletedDocuments.add(uri); });
    fileSystemMocks.getInfoAsync.mockImplementation(async (uri: string) => (
      uri.startsWith('content://') ? { exists: !fileSystemMocks.deletedDocuments.has(uri) } : { exists: true, size: 1 }));
    fileSystemMocks.readSafDirectoryAsync.mockResolvedValue([]);
    sharingMocks.isAvailableAsync.mockResolvedValue(true);
    sharingMocks.shareAsync.mockResolvedValue(undefined);
    storeStateRef.current = {
      lastDataChangeAt: 1,
      fetchData: vi.fn().mockResolvedValue(undefined),
    };
    coreMocks.flushPendingSave.mockResolvedValue(undefined);
    coreMocks.useTaskStoreGetState.mockImplementation(() => storeStateRef.current);
    storageMocks.getData.mockResolvedValue(emptyData);
    storageMocks.saveData.mockResolvedValue(undefined);
  });

  it('marks only a completed Android SAF backup write for release confirmation', async () => {
    Platform.OS = 'android';
    const directoryUri = 'content://com.android.providers.downloads.documents/tree/downloads';
    const fileUri =
      'content://com.android.providers.downloads.documents/document/downloads%3AMindwtr%20Backup.json';
    fileSystemMocks.requestDirectoryPermissionsAsync.mockResolvedValue({
      granted: true,
      directoryUri,
    });
    fileSystemMocks.createSafFileAsync.mockResolvedValue(fileUri);
    let resolveWrite!: () => void;
    fileSystemMocks.writeSafFileAsync.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        resolveWrite = resolve;
      })
    );

    const exportPromise = exportCurrentDataBackup(emptyData);
    await vi.waitFor(() => expect(fileSystemMocks.writeSafFileAsync).toHaveBeenCalledOnce());
    expect(logMocks.logInfo).not.toHaveBeenCalledWith(
      'Backup export complete',
      expect.anything()
    );
    resolveWrite();
    await exportPromise;

    expect(fileSystemMocks.writeSafFileAsync).toHaveBeenCalledWith(
      fileUri,
      expect.any(String)
    );
    expect(logMocks.logInfo).toHaveBeenCalledWith(
      'Backup export complete',
      expect.objectContaining({
        scope: 'transfer',
        extra: expect.objectContaining({
          operation: 'exportBackup',
          source: 'local',
          releaseCheck: 'v1.3.0/android-saf-backup-write',
        }),
      })
    );
    expect(sharingMocks.shareAsync).not.toHaveBeenCalled();
  });

  it('removes the empty document when the Android SAF backup write fails', async () => {
    Platform.OS = 'android';
    const fileUri =
      'content://com.android.providers.downloads.documents/document/downloads%3AMindwtr%20Backup.json';
    fileSystemMocks.requestDirectoryPermissionsAsync.mockResolvedValue({
      granted: true,
      directoryUri: 'content://com.android.providers.downloads.documents/tree/downloads',
    });
    fileSystemMocks.createSafFileAsync.mockResolvedValue(fileUri);
    fileSystemMocks.writeSafFileAsync.mockRejectedValueOnce(new Error('SAF write unavailable'));

    await exportCurrentDataBackup(emptyData);

    expect(fileSystemMocks.deleteSafFileAsync).toHaveBeenCalledWith(fileUri, { idempotent: true });
    expect(fileSystemMocks.deleteSafFileAsync.mock.invocationCallOrder[0])
      .toBeLessThan(sharingMocks.shareAsync.mock.invocationCallOrder[0]);
    expect(sharingMocks.shareAsync).toHaveBeenCalledOnce();
    const completion = logMocks.logInfo.mock.calls.find(([message]) => message === 'Backup export complete');
    expect(completion?.[1]?.extra).not.toHaveProperty('releaseCheck');
  });

  const RECORD = 'file://document/export-pending.json';
  const listedUris = () => (JSON.parse(fileSystemMocks.fileContents.get(RECORD) ?? '{"pending":[]}').pending as (string | { uri?: string; name?: string })[])
    .map((entry) => (typeof entry === 'string' ? entry : entry.uri ?? `name:${entry.name}`));

  it('lists the document by its URI before the first byte and clears it once the write finishes', async () => {
    Platform.OS = 'android';
    const fileUri = 'content://com.android.providers.downloads.documents/document/downloads%3AMindwtr%20Backup.json';
    fileSystemMocks.requestDirectoryPermissionsAsync.mockResolvedValue({ granted: true, directoryUri: 'content://tree/downloads' });
    let listedAtCreate: string[] = ['unread'];
    fileSystemMocks.createSafFileAsync.mockImplementationOnce(async () => { listedAtCreate = listedUris(); return fileUri; });
    let listedDuringWrite: string[] = [];
    fileSystemMocks.writeSafFileAsync.mockImplementationOnce(async () => { listedDuringWrite = listedUris(); });

    await exportCurrentDataBackup(emptyData);

    expect(listedAtCreate).toEqual([]);
    expect(listedDuringWrite).toEqual([fileUri]);
    expect(listedUris()).toEqual([]);
  });


  it('an older backup with the same name survives an export that died before its document existed', async () => {
    Platform.OS = 'android';
    fileSystemMocks.requestDirectoryPermissionsAsync.mockResolvedValue({ granted: true, directoryUri: 'content://tree/downloads' });
    let name = '';
    fileSystemMocks.createSafFileAsync.mockImplementationOnce(async (_tree: string, requested: string) => { name = requested; throw new Error('process died'); });
    await exportCurrentDataBackup(emptyData);

    const older = `content://com.android.externalstorage.documents/tree/primary%3ADownload/document/primary%3ADownload%2F${encodeURIComponent(name)}`;
    fileSystemMocks.readSafDirectoryAsync.mockResolvedValue([older]);
    vi.resetModules();
    const nextStart = await import('./data-transfer');
    await nextStart.cleanupInterruptedBackupExport();

    expect(fileSystemMocks.deleteSafFileAsync).not.toHaveBeenCalled();
    expect(listedUris()).toEqual([]);
  });

  it('deletes a folder document a process death left half written, then its entry', async () => {
    const fileUri = 'content://com.android.providers.downloads.documents/document/downloads%3AHalf.json';
    fileSystemMocks.fileContents.set(RECORD, JSON.stringify({ pending: [{ uri: fileUri, owner: 'an-earlier-run' }] }));

    await cleanupInterruptedBackupExport();

    expect(fileSystemMocks.deleteSafFileAsync).toHaveBeenCalledWith(fileUri, { idempotent: true });
    expect(listedUris()).toEqual([]);
  });


  it('cleans the older one-document record', async () => {
    const fileUri = 'content://com.android.providers.downloads.documents/document/downloads%3AOlder.json';
    fileSystemMocks.fileContents.set(RECORD, JSON.stringify({ uri: fileUri }));

    await cleanupInterruptedBackupExport();

    expect(fileSystemMocks.deleteSafFileAsync).toHaveBeenCalledWith(fileUri, { idempotent: true });
    expect(listedUris()).toEqual([]);
  });

  it('cleans an interrupted folder write before the next export', async () => {
    Platform.OS = 'android';
    const half = 'content://com.android.providers.downloads.documents/document/downloads%3AHalf.json';
    fileSystemMocks.fileContents.set(RECORD, JSON.stringify({ pending: [half] }));

    await exportCurrentDataBackup(emptyData);

    expect(fileSystemMocks.deleteSafFileAsync).toHaveBeenCalledWith(half, { idempotent: true });
  });


  it('a finished folder write whose entry cannot leave the list fails the export and deletes its own file', async () => {
    Platform.OS = 'android';
    const fileUri = 'content://com.android.providers.downloads.documents/document/downloads%3AFinished.json';
    fileSystemMocks.requestDirectoryPermissionsAsync.mockResolvedValue({ granted: true, directoryUri: 'content://tree/downloads' });
    fileSystemMocks.createSafFileAsync.mockResolvedValue(fileUri);
    fileSystemMocks.writeSafFileAsync.mockImplementationOnce(async () => { fileSystemMocks.writeError = new Error('disk full'); });

    await exportCurrentDataBackup(emptyData);

    expect(fileSystemMocks.deleteSafFileAsync).toHaveBeenCalledWith(fileUri, { idempotent: true });
    expect(sharingMocks.shareAsync).toHaveBeenCalledOnce();
  });


  it('a document whose URI cannot be listed is deleted at once and never looked up by name later', async () => {
    Platform.OS = 'android';
    const fileUri = 'content://com.android.providers.downloads.documents/document/downloads%3ALost.json';
    fileSystemMocks.requestDirectoryPermissionsAsync.mockResolvedValue({ granted: true, directoryUri: 'content://tree/downloads' });
    fileSystemMocks.createSafFileAsync.mockImplementationOnce(async () => { fileSystemMocks.writeError = new Error('disk full'); return fileUri; });

    await exportCurrentDataBackup(emptyData);
    fileSystemMocks.writeError = null;

    expect(fileSystemMocks.deleteSafFileAsync).toHaveBeenCalledWith(fileUri, { idempotent: true });
    expect(fileSystemMocks.writeSafFileAsync).not.toHaveBeenCalled();
    expect(listedUris()).toEqual([]);
  });


  it('keeps an entry whose delete resolved but whose document is still there', async () => {
    const fileUri = 'content://com.android.providers.downloads.documents/document/downloads%3AKept.json';
    fileSystemMocks.fileContents.set(RECORD, JSON.stringify({ pending: [fileUri] }));
    fileSystemMocks.deleteSafFileAsync.mockResolvedValueOnce(undefined);

    await cleanupInterruptedBackupExport();

    expect(listedUris()).toEqual([fileUri]);
  });


  it('reads a whole pending list before the record it was replacing', async () => {
    const finished = 'content://com.android.providers.downloads.documents/document/downloads%3AFinished.json';
    fileSystemMocks.fileContents.set(RECORD, JSON.stringify({ pending: [finished] }));
    fileSystemMocks.fileContents.set(`${RECORD}.pending`, JSON.stringify({ pending: [] }));

    await cleanupInterruptedBackupExport();

    expect(fileSystemMocks.deleteSafFileAsync).not.toHaveBeenCalled();
  });


  it('keeps a recovered pending list through a second interrupted write', async () => {
    Platform.OS = 'android';
    const half = 'content://com.android.providers.downloads.documents/document/downloads%3AHalf.json';
    fileSystemMocks.fileContents.set(`${RECORD}.pending`, JSON.stringify({ pending: [{ uri: half, owner: 'an-earlier-run' }] }));
    fileSystemMocks.requestDirectoryPermissionsAsync.mockResolvedValue({ granted: true, directoryUri: 'content://tree/downloads' });
    fileSystemMocks.createSafFileAsync.mockImplementationOnce(async () => {
      fileSystemMocks.truncateThenThrow = new Error('process died mid-write');
      return 'content://com.android.providers.downloads.documents/document/downloads%3ANext.json';
    });
    fileSystemMocks.deleteSafFileAsync.mockRejectedValue(new Error('provider unavailable'));

    await exportCurrentDataBackup(emptyData);

    expect(listedUris()).toEqual([half]);
  });


  it('keeps an interrupted write the provider could not delete, through the next export, until a cleanup succeeds', async () => {
    Platform.OS = 'android';
    const half = 'content://com.android.providers.downloads.documents/document/downloads%3AHalf.json';
    const next = 'content://com.android.providers.downloads.documents/document/downloads%3ANext.json';
    fileSystemMocks.fileContents.set(RECORD, JSON.stringify({ pending: [half] }));
    fileSystemMocks.deleteSafFileAsync.mockRejectedValueOnce(new Error('provider unavailable'));
    await cleanupInterruptedBackupExport();
    expect(listedUris()).toEqual([half]);

    fileSystemMocks.deleteSafFileAsync.mockRejectedValueOnce(new Error('provider unavailable'));
    fileSystemMocks.requestDirectoryPermissionsAsync.mockResolvedValue({ granted: true, directoryUri: 'content://tree/downloads' });
    fileSystemMocks.createSafFileAsync.mockResolvedValue(next);
    await exportCurrentDataBackup(emptyData);
    expect(listedUris()).toEqual([half]);

    await cleanupInterruptedBackupExport();
    expect(fileSystemMocks.deleteSafFileAsync).toHaveBeenLastCalledWith(half, { idempotent: true });
    expect(listedUris()).toEqual([]);
  });

  it('leaves nothing to remove when the folder permission is refused', async () => {
    Platform.OS = 'android';
    fileSystemMocks.requestDirectoryPermissionsAsync.mockResolvedValue({ granted: false });

    await exportCurrentDataBackup(emptyData);

    expect(fileSystemMocks.createSafFileAsync).not.toHaveBeenCalled();
    expect(fileSystemMocks.deleteSafFileAsync).not.toHaveBeenCalled();
    expect(sharingMocks.shareAsync).toHaveBeenCalledOnce();
  });

  it('does not mark the share fallback as a completed SAF backup write', async () => {
    Platform.OS = 'android';

    await exportCurrentDataBackup(emptyData);

    expect(fileSystemMocks.writeSafFileAsync).not.toHaveBeenCalled();
    expect(sharingMocks.shareAsync).toHaveBeenCalledOnce();
    const completion = logMocks.logInfo.mock.calls.find(([message]) => message === 'Backup export complete');
    expect(completion?.[1]?.extra).not.toHaveProperty('releaseCheck');
  });

  it('aborts Todoist import without creating a snapshot when local data changes', async () => {
    storageMocks.getData.mockImplementation(async () => {
      storeStateRef.current = {
        ...storeStateRef.current,
        lastDataChangeAt: 2,
      };
      return emptyData;
    });

    await expect(importTodoistData(parsedProjects)).rejects.toMatchObject({
      name: 'LocalSyncAbort',
    });

    expect(storageMocks.saveData).not.toHaveBeenCalled();
    expect(storeStateRef.current.fetchData).not.toHaveBeenCalled();
    expect(coreMocks.flushPendingSave).toHaveBeenCalledOnce();
    expect(storageMocks.getData).toHaveBeenCalledOnce();
    expect(fileSystemMocks.fileWrites).toHaveLength(0);
    expect(logMocks.logInfo).toHaveBeenCalledWith(
      'Data transfer aborted after local data changed',
      expect.objectContaining({
        scope: 'transfer',
        extra: expect.objectContaining({
          operation: 'importTodoist',
          snapshotChangeAt: '1',
          currentChangeAt: '2',
        }),
      })
    );
  });

  it('creates a recovery snapshot before persisting and refreshing a Todoist import', async () => {
    const transfer = await importTodoistData(parsedProjects);

    expect(transfer.snapshotName).toMatch(SNAPSHOT_FILE_NAME_PATTERN);
    expect(transfer.result.importedTaskCount).toBe(1);
    expect(coreMocks.flushPendingSave).toHaveBeenCalledOnce();
    expect(storageMocks.getData).toHaveBeenCalledOnce();
    expect(fileSystemMocks.fileWrites).toHaveLength(1);
    expect(storageMocks.saveData).toHaveBeenCalledWith(expect.objectContaining({
      tasks: [expect.objectContaining({ title: 'Imported task' })],
    }));
    expect(storeStateRef.current.fetchData).toHaveBeenCalledWith({ silent: true });
  });

  it('creates a recovery snapshot of the current persisted data without rewriting it', async () => {
    await expect(createMobileRecoverySnapshot()).resolves.toMatch(SNAPSHOT_FILE_NAME_PATTERN);

    expect(coreMocks.flushPendingSave).toHaveBeenCalledOnce();
    expect(storageMocks.getData).toHaveBeenCalledOnce();
    expect(fileSystemMocks.fileWrites).toHaveLength(1);
    expect(storageMocks.saveData).not.toHaveBeenCalled();
    expect(storeStateRef.current.fetchData).not.toHaveBeenCalled();
  });

  it('keeps and restores both recovery snapshots created at the same instant', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-09T12:34:05.123Z'));
    try {
      const firstSnapshot = await createMobileRecoverySnapshot();
      const secondSnapshot = await createMobileRecoverySnapshot();

      expect(firstSnapshot).toBe('data.2026-08-09T12-34-05.123.snapshot.json');
      expect(secondSnapshot).toBe('data.2026-08-09T12-34-05.123.1.snapshot.json');
      await expect(listLocalDataSnapshots()).resolves.toEqual([
        secondSnapshot,
        firstSnapshot,
      ]);
      expect(fileSystemMocks.fileContents).toHaveLength(2);
      await expect(restoreLocalDataSnapshot(secondSnapshot)).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-authors restored snapshots above current revisions and carries current-only tombstones', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-09T12:34:05.123Z'));
    try {
      const snapshotName = 'data.2026-08-08T12-00-00.000.snapshot.json';
      const task = {
        id: 'restored-task',
        title: 'Restored task',
        status: 'next' as const,
        tags: [],
        contexts: [],
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      };
      const snapshot: AppData = {
        ...emptyData,
        tasks: [{ ...task, rev: 1, revBy: 'snapshot-device' }],
      };
      const current: AppData = {
        ...emptyData,
        tasks: [
          {
            ...task,
            rev: 10,
            revBy: 'current-device',
            deletedAt: '2026-08-08T00:00:00.000Z',
          },
          {
            ...task,
            id: 'current-only-task',
            title: 'Current only',
            rev: 7,
            revBy: 'current-device',
          },
        ],
      };
      fileSystemMocks.fileContents.set(
        `file://document/snapshots/${snapshotName}`,
        JSON.stringify(snapshot),
      );
      storageMocks.getData.mockResolvedValue(current);

      await restoreLocalDataSnapshot(snapshotName);

      const saved = storageMocks.saveData.mock.calls[0]?.[0] as AppData;
      const restoredTask = saved.tasks.find((item) => item.id === task.id);
      expect(restoredTask).toMatchObject({
        title: 'Restored task',
        rev: 11,
        revBy: 'backup-restore',
      });
      expect(restoredTask?.deletedAt).toBeUndefined();
      expect(saved.tasks.find((item) => item.id === 'current-only-task')).toMatchObject({
        rev: 8,
        revBy: 'backup-restore',
        deletedAt: '2026-08-09T12:34:05.123Z',
      });
      expect(saved.settings.pendingRemoteWriteAt).toBe('2026-08-09T12:34:05.123Z');
    } finally {
      vi.useRealTimers();
    }
  });


  it('a snapshot restore keeps this device\'s enabled App Lock', async () => {
    const snapshotName = 'data.2026-08-08T12-00-00.000.snapshot.json';
    fileSystemMocks.fileContents.set(`file://document/snapshots/${snapshotName}`, JSON.stringify({ ...emptyData, settings: { security: { mobileAppLockEnabled: false } } }));
    storageMocks.getData.mockResolvedValue({ ...emptyData, settings: { security: { mobileAppLockEnabled: true } } });

    await restoreLocalDataSnapshot(snapshotName);

    const saved = storageMocks.saveData.mock.calls.at(-1)?.[0] as AppData;
    expect(saved.settings.security).toEqual({ mobileAppLockEnabled: true });
  });

  it('does not write a recovery snapshot from a stale local read', async () => {
    storageMocks.getData.mockImplementation(async () => {
      storeStateRef.current = {
        ...storeStateRef.current,
        lastDataChangeAt: 2,
      };
      return emptyData;
    });

    await expect(createMobileRecoverySnapshot()).rejects.toThrow('Local data changed');

    expect(fileSystemMocks.fileWrites).toHaveLength(0);
  });

  it('leaves no snapshot file behind and prunes nothing when the snapshot write fails', async () => {

    const existing = Array.from({ length: 6 }, (_unused, index) =>
      `file://document/snapshots/data.2026-08-0${index + 1}T00-00-00.000.snapshot.json`);
    existing.forEach((uri) => fileSystemMocks.fileContents.set(uri, '{}'));
    fileSystemMocks.writeError = new Error('No space left on device');

    await expect(createMobileRecoverySnapshot()).rejects.toThrow('No space left on device');

    expect([...fileSystemMocks.fileContents.keys()].sort()).toEqual([...existing].sort());
  });

  it('keeps the snapshot it just wrote when the clock went back behind five newer ones', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-09T12:34:05.123Z'));
    try {

      Array.from({ length: 5 }, (_unused, index) =>
        `file://document/snapshots/data.2027-01-0${index + 1}T00-00-00.000.snapshot.json`)
        .forEach((uri) => fileSystemMocks.fileContents.set(uri, '{}'));

      const written = await createMobileRecoverySnapshot();

      expect(fileSystemMocks.fileContents.has(`file://document/snapshots/${written}`)).toBe(true);
      await expect(restoreLocalDataSnapshot(written)).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a recovery snapshot over the backup size limit before reading it', async () => {
    const name = 'data.2026-08-08T12-00-00.000.snapshot.json';
    const uri = `file://document/snapshots/${name}`;
    fileSystemMocks.fileContents.set(uri, JSON.stringify(emptyData));
    fileSystemMocks.fileSizes.set(uri, MAX_BACKUP_SOURCE_BYTES + 1);

    await expect(restoreLocalDataSnapshot(name)).rejects.toThrow();

    expect(fileSystemMocks.fileReads).not.toContain(uri);
    expect(storageMocks.saveData).not.toHaveBeenCalled();
  });

  it('fails explicitly instead of looping forever when one instant is fully collided', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-09T12:34:05.123Z'));
    try {
      const base = 'file://document/snapshots/data.2026-08-09T12-34-05.123';
      fileSystemMocks.fileContents.set(`${base}.snapshot.json`, '{}');
      for (let index = 1; index <= 100; index += 1) {
        fileSystemMocks.fileContents.set(`${base}.${index}.snapshot.json`, '{}');
      }

      await expect(createMobileRecoverySnapshot()).rejects.toThrow('too many snapshots from this instant');
      expect(fileSystemMocks.fileWrites).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an oversized picked import before reading it into memory', async () => {
    fileSystemMocks.getInfoAsync.mockResolvedValue({
      exists: true,
      size: DEFAULT_IMPORT_SOURCE_LIMITS.maxInputBytes + 1,
    });

    await expect(inspectMindwtrCsvDocument({
      fileName: 'large.csv',
      size: DEFAULT_IMPORT_SOURCE_LIMITS.maxInputBytes + 1,
      uri: 'content://large.csv',
    })).rejects.toThrow('Choose a file no larger than 16 MB');

    expect(fileSystemMocks.readAsStringAsync).not.toHaveBeenCalled();
  });

  it('rejects an oversized picked backup before reading it into memory', async () => {
    fileSystemMocks.getInfoAsync.mockResolvedValue({
      exists: true,
      size: MAX_BACKUP_SOURCE_BYTES + 1,
    });

    await expect(inspectBackupDocument({
      fileName: 'large.json',
      size: MAX_BACKUP_SOURCE_BYTES + 1,
      uri: 'content://large.json',
    })).rejects.toThrow('backup file is too large');

    expect(fileSystemMocks.readAsStringAsync).not.toHaveBeenCalled();
  });

  it('trusts the copied backup URI size over smaller picker metadata without a bulk read', async () => {
    fileSystemMocks.getInfoAsync.mockResolvedValue({
      exists: true,
      size: MAX_BACKUP_SOURCE_BYTES + 1,
    });

    await expect(inspectBackupDocument({
      fileName: 'lying-size.json',
      size: 1,
      uri: 'file://cache/lying-size.json',
    })).rejects.toThrow('backup file is too large');

    expect(fileSystemMocks.getInfoAsync).toHaveBeenCalledWith('file://cache/lying-size.json');
    expect(fileSystemMocks.readAsStringAsync).not.toHaveBeenCalled();
  });

  it('rejects a size-less backup when its copied URI size cannot be verified', async () => {
    fileSystemMocks.getInfoAsync.mockResolvedValue({ exists: true });

    await expect(inspectBackupDocument({
      fileName: 'unknown.json',
      size: null,
      uri: 'file://cache/unknown.json',
    })).rejects.toThrow('could not verify the selected backup file size');

    expect(fileSystemMocks.readAsStringAsync).not.toHaveBeenCalled();
  });

  it('surfaces an unknown copied-backup size as a structured diagnostic', async () => {
    fileSystemMocks.getInfoAsync.mockResolvedValue({ exists: true });

    let failure: unknown;
    try {
      await inspectBackupDocument({
        fileName: 'unknown.json',
        size: null,
        uri: 'file://cache/unknown.json',
      });
    } catch (error) {
      failure = error;
    }

    expect(getBackupSourceFileDiagnostic(failure)).toMatchObject({
      code: 'backup-source-size-unknown',
      severity: 'error',
    });
  });

  it('stats a size-less cached import and rejects it before any bulk read', async () => {
    fileSystemMocks.getInfoAsync.mockResolvedValue({
      exists: true,
      size: DEFAULT_IMPORT_SOURCE_LIMITS.maxInputBytes + 1,
    });

    await expect(inspectMindwtrCsvDocument({
      fileName: 'large.csv',
      size: null,
      uri: 'file://cache/large.csv',
    })).rejects.toThrow('Choose a file no larger than 16 MB');

    expect(fileSystemMocks.getInfoAsync).toHaveBeenCalledWith('file://cache/large.csv');
    expect(fileSystemMocks.readAsStringAsync).not.toHaveBeenCalled();
  });

  it('rejects a size-less import when its copied URI size cannot be verified', async () => {
    fileSystemMocks.getInfoAsync.mockResolvedValue({ exists: true });

    await expect(inspectMindwtrCsvDocument({
      fileName: 'unknown.csv',
      size: null,
      uri: 'file://cache/unknown.csv',
    })).rejects.toThrow('could not verify the selected import file size');

    expect(fileSystemMocks.readAsStringAsync).not.toHaveBeenCalled();
  });
});
