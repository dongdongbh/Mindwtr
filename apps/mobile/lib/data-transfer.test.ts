import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_IMPORT_SOURCE_LIMITS, getBackupSourceFileDiagnostic, MAX_BACKUP_SOURCE_BYTES, type AppData } from '@mindwtr/core';
import type { ParsedTodoistProject } from '@mindwtr/core/todoist-import';

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
  writeError: null as Error | null,
  getInfoAsync: vi.fn(),
  readAsStringAsync: vi.fn(),
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
  StorageAccessFramework: null,
  documentDirectory: 'file://document/',
  cacheDirectory: 'file://cache/',
  getInfoAsync: fileSystemMocks.getInfoAsync,
  readAsStringAsync: fileSystemMocks.readAsStringAsync,
  writeAsStringAsync: vi.fn(),
  EncodingType: {
    Base64: 'base64',
  },
}));

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
    delete() { fileSystemMocks.fileContents.delete(this.uri); }
    move(destination: { uri: string }) {
      const contents = fileSystemMocks.fileContents.get(this.uri) ?? '';
      fileSystemMocks.fileContents.delete(this.uri);
      fileSystemMocks.fileContents.set(destination.uri, contents);
      this.uri = destination.uri;
    }
    write(text: string) {
      if (fileSystemMocks.writeError) throw fileSystemMocks.writeError;
      fileSystemMocks.fileWrites.push(text);
      fileSystemMocks.fileContents.set(this.uri, text);
    }
    async text() { return fileSystemMocks.fileContents.get(this.uri) ?? '{}'; }
    async bytes() { return new Uint8Array(); }
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
  createMobileRecoverySnapshot,
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
    vi.clearAllMocks();
    fileSystemMocks.fileContents.clear();
    fileSystemMocks.fileWrites = [];
    fileSystemMocks.writeError = null;
    fileSystemMocks.readAsStringAsync.mockResolvedValue('');
    fileSystemMocks.getInfoAsync.mockResolvedValue({ exists: true, size: 1 });
    storeStateRef.current = {
      lastDataChangeAt: 1,
      fetchData: vi.fn().mockResolvedValue(undefined),
    };
    coreMocks.flushPendingSave.mockResolvedValue(undefined);
    coreMocks.useTaskStoreGetState.mockImplementation(() => storeStateRef.current);
    storageMocks.getData.mockResolvedValue(emptyData);
    storageMocks.saveData.mockResolvedValue(undefined);
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
    // One more than MAX_LOCAL_SNAPSHOTS, so a stray empty file would evict a real one.
    const existing = Array.from({ length: 6 }, (_unused, index) =>
      `file://document/snapshots/data.2026-08-0${index + 1}T00-00-00.000.snapshot.json`);
    existing.forEach((uri) => fileSystemMocks.fileContents.set(uri, '{}'));
    fileSystemMocks.writeError = new Error('No space left on device');

    await expect(createMobileRecoverySnapshot()).rejects.toThrow('No space left on device');

    expect([...fileSystemMocks.fileContents.keys()].sort()).toEqual([...existing].sort());
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
