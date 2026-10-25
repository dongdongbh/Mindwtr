import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppData, Task } from '@mindwtr/core';

const {
  asyncStorageMock,
  localStorageMock,
  logInfoMock,
  logWarnMock,
  sqliteAdapterSaveTask,
  updateMobileWidgetFromDataMock,
  appStateListeners,
  appStateCurrentState,
  mockPlatformOS,
} = vi.hoisted(() => ({
  asyncStorageMock: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
  localStorageMock: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
  logInfoMock: vi.fn(),
  logWarnMock: vi.fn(),
  sqliteAdapterSaveTask: vi.fn(),
  updateMobileWidgetFromDataMock: vi.fn(),
  appStateListeners: [] as Array<(state: string) => void>,
  appStateCurrentState: { value: undefined as string | undefined },
  mockPlatformOS: { value: 'android' as 'android' | 'ios' },
}));

vi.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    appOwnership: 'standalone',
  },
}));

vi.mock('react-native', async () => {
  const actual = await vi.importActual<typeof import('react-native')>('react-native');
  return {
    ...actual,
    Platform: {
      ...actual.Platform,
      get OS() {
        return mockPlatformOS.value;
      },
    },
    NativeModules: {
      ...actual.NativeModules,
      OPSQLite: { install: vi.fn(() => true) },
    },
    AppState: {
      get currentState() {
        return appStateCurrentState.value;
      },
      addEventListener: vi.fn((_event: string, listener: (state: string) => void) => {
        appStateListeners.push(listener);
        return { remove: vi.fn() };
      }),
    },
  };
});

vi.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: asyncStorageMock,
}));

vi.mock('./widget-service', () => ({
  updateMobileWidgetFromData: updateMobileWidgetFromDataMock,
}));

vi.mock('./app-log', () => ({
  logError: vi.fn(),
  logWarn: logWarnMock,
  logInfo: logInfoMock,
}));

vi.mock('./startup-profiler', () => ({
  markStartupPhase: vi.fn(),
  measureStartupPhase: vi.fn(async (_name: string, work: () => Promise<unknown>) => work()),
}));

const makeWidgetTask = (id: string): Task => ({
  id,
  title: `Task ${id}`,
  status: 'next',
  tags: [],
  contexts: [],
  createdAt: '2026-06-15T00:00:00.000Z',
  updatedAt: '2026-06-15T00:00:00.000Z',
});

const makeWidgetSnapshot = (task: Task): AppData => ({
  tasks: [task],
  projects: [],
  sections: [],
  areas: [],
  people: [],
  settings: {},
});

const setupForegroundWidgetStorage = async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-30T00:00:00.000Z'));
  appStateCurrentState.value = 'active';
  const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
  if (!mobileStorage.saveTask) {
    throw new Error('Expected mobile storage to support saveTask');
  }
  __mobileStorageTestUtils.setSqliteStateForTests({
    adapter: { saveTask: sqliteAdapterSaveTask },
    client: {},
  });
  return { saveTask: mobileStorage.saveTask, testUtils: __mobileStorageTestUtils };
};

describe('mobile storage adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockPlatformOS.value = 'android';
    appStateListeners.length = 0;
    appStateCurrentState.value = undefined;
    asyncStorageMock.getItem.mockResolvedValue(null);
    asyncStorageMock.setItem.mockResolvedValue(undefined);
    sqliteAdapterSaveTask.mockResolvedValue(undefined);
    updateMobileWidgetFromDataMock.mockResolvedValue(undefined);
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage: localStorageMock },
    });
  });

  afterEach(async () => {
    // beforeEach's resetModules orphans this test's module instance, but any
    // coalesced-backup timer it armed keeps running and would write the backup
    // (and its version marker) through the SHARED AsyncStorage mock into a
    // LATER test's stored map — the load-dependent cross-test failure seen in
    // CI. Reset the instance while it is still importable to disarm the timer.
    const { __mobileStorageTestUtils } = await import('./storage-adapter');
    __mobileStorageTestUtils.reset();
  });

  it('uses the JSON fallback without loading op-sqlite when the native module is absent', async () => {
    const { NativeModules } = await import('react-native');
    const nativeModules = NativeModules as typeof NativeModules & { OPSQLite?: unknown };
    const installedModule = nativeModules.OPSQLite;
    nativeModules.OPSQLite = null;
    try {
      const { mobileStorage } = await import('./storage-adapter');

      await expect(mobileStorage.getData()).resolves.toEqual({
        tasks: [],
        projects: [],
        sections: [],
        areas: [],
        people: [],
        settings: {},
      });
      expect(logWarnMock).toHaveBeenCalledWith(
        '[Storage] SQLite load failed, falling back to JSON backup',
        expect.objectContaining({
          scope: 'storage',
          extra: expect.objectContaining({
            error: 'Native SQLite module unavailable; rebuild or reinstall the app so op-sqlite is included',
          }),
        }),
      );
      expect(logInfoMock).not.toHaveBeenCalledWith(
        'SQLite project archive metadata loaded in canonical form',
        expect.anything(),
      );
    } finally {
      nativeModules.OPSQLite = installedModule;
    }
  }, 30_000);

  it('coalesces a burst of calendar SQLite calls when the native module is unavailable', async () => {
    const nativeModuleError = new Error('Base module not found. Did you do a pod install/clear the gradle cache?');
    const initializeSqlite = vi.fn().mockRejectedValue(nativeModuleError);
    const { getCalendarSyncEntry, __mobileStorageTestUtils } = await import('./storage-adapter');
    __mobileStorageTestUtils.setSqliteInitializerForTests(initializeSqlite);
    const calls = Array.from({ length: 8 }, (_, index) => (
      getCalendarSyncEntry(`task-${index}`, 'android')
    ));

    const results = await Promise.allSettled(calls);

    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(results.map((result) => (
      result.status === 'rejected' ? String(result.reason) : 'fulfilled'
    ))).toEqual(Array(8).fill('Error: Base module not found. Did you do a pod install/clear the gradle cache?'));
    expect(initializeSqlite).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('allows one new SQLite initialization after the failure cooldown', async () => {
    vi.useFakeTimers();
    try {
      const nativeModuleError = new Error('Base module not found. Did you do a pod install/clear the gradle cache?');
      const getCalendarEntry = vi.fn().mockResolvedValue(undefined);
      const initializeSqlite = vi.fn()
        .mockRejectedValueOnce(nativeModuleError)
        .mockResolvedValue({
          adapter: { getCalendarSyncEntry: getCalendarEntry },
          client: {},
        });
      const { getCalendarSyncEntry, __mobileStorageTestUtils } = await import('./storage-adapter');
      __mobileStorageTestUtils.setSqliteInitializerForTests(initializeSqlite as never);

      await expect(getCalendarSyncEntry('task-1', 'android')).rejects.toThrow('Base module not found');
      await expect(getCalendarSyncEntry('task-2', 'android')).rejects.toThrow('Base module not found');
      expect(initializeSqlite).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);

      await expect(getCalendarSyncEntry('task-3', 'android')).resolves.toBeUndefined();
      expect(initializeSqlite).toHaveBeenCalledTimes(2);
      expect(getCalendarEntry).toHaveBeenCalledWith('task-3', 'android');
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  it('refreshes the JSON startup backup after a successful incremental task save', async () => {
    const currentTask: Task = {
      id: 'task-current',
      title: 'Current task',
      status: 'next',
      tags: [],
      contexts: [],
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
    };
    const currentSnapshot: AppData = {
      tasks: [currentTask],
      projects: [],
      sections: [],
      areas: [],
      people: [],
      settings: {},
    };

    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    if (!mobileStorage.saveTask) {
      throw new Error('Expected mobile storage to support saveTask');
    }
    __mobileStorageTestUtils.setSqliteStateForTests({
      adapter: { saveTask: sqliteAdapterSaveTask },
      client: {},
    });

    await mobileStorage.saveTask(currentTask, currentSnapshot);

    expect(sqliteAdapterSaveTask).toHaveBeenCalledWith(currentTask);
    // The backup is deferred off the save path (#766): the save resolves after
    // the SQLite write, and the JSON copy lands coalesced afterwards.
    expect(asyncStorageMock.setItem).not.toHaveBeenCalledWith('mindwtr-data', expect.anything());

    await __mobileStorageTestUtils.flushPendingStartupJsonBackup();
    // Widget refresh runs on its own decoupled schedule (#766) and needs its
    // own flush.
    await __mobileStorageTestUtils.flushPendingWidgetRefresh();

    expect(asyncStorageMock.setItem).toHaveBeenCalledWith(
      'mindwtr-data',
      JSON.stringify(currentSnapshot),
    );
    expect(asyncStorageMock.setItem).toHaveBeenCalledWith(
      'mindwtr-data:startup-backup-version',
      '2',
    );
    expect(asyncStorageMock.setItem).toHaveBeenCalledWith(
      'mindwtr-data:startup-backup-updated-at',
      expect.stringMatching(/^\d+$/),
    );
    expect(updateMobileWidgetFromDataMock).toHaveBeenCalledWith(currentSnapshot);
  }, 10_000);

  it('skips a JSON backup Android could never read back, and refuses it as a fallback (#766)', async () => {
    const makeTask = (id: string): Task => ({
      id,
      title: `Task ${id} ${'padding '.repeat(20)}`,
      status: 'next',
      tags: [],
      contexts: [],
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
    });
    const hugeSnapshot: AppData = {
      tasks: Array.from({ length: 6_000 }, (_, index) => makeTask(`task-${index}`)),
      projects: [],
      sections: [],
      areas: [],
      people: [],
      settings: {},
    };
    expect(JSON.stringify(hugeSnapshot).length).toBeGreaterThan(1_500_000);

    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    if (!mobileStorage.saveTask) {
      throw new Error('Expected mobile storage to support saveTask');
    }
    __mobileStorageTestUtils.setSqliteStateForTests({
      adapter: { saveTask: sqliteAdapterSaveTask },
      client: {},
    });

    await mobileStorage.saveTask(hugeSnapshot.tasks[0], hugeSnapshot);
    await __mobileStorageTestUtils.flushPendingStartupJsonBackup();

    // Past Android's ~2MB CursorWindow the row cannot be read back, so writing it
    // is seconds of JS thread for a copy nothing can load.
    expect(asyncStorageMock.setItem).not.toHaveBeenCalledWith('mindwtr-data', expect.anything());
    expect(asyncStorageMock.setItem).not.toHaveBeenCalledWith(
      'mindwtr-data:startup-backup-version',
      expect.anything(),
    );
    expect(logWarnMock).toHaveBeenCalledWith(
      '[Storage] Skipped JSON backup; library exceeds the readable AsyncStorage size',
      expect.objectContaining({ scope: 'storage' }),
    );

    // A failing SQLite read must now surface instead of pinning every read to a
    // backup that only throws "Row too big" behind a 60s cooldown.
    __mobileStorageTestUtils.setSqliteInitializerForTests(async () => {
      throw new Error('SQLite read timed out');
    });
    await expect(mobileStorage.getData()).rejects.toThrow('SQLite read timed out');
  }, 20_000);

  it('stops re-serializing a library already known to exceed the backup cap (#766)', async () => {
    const makeTask = (id: string): Task => ({
      id,
      title: `Task ${id} ${'padding '.repeat(20)}`,
      status: 'next',
      tags: [],
      contexts: [],
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
    });
    const hugeSnapshot: AppData = {
      tasks: Array.from({ length: 6_000 }, (_, index) => makeTask(`task-${index}`)),
      projects: [],
      sections: [],
      areas: [],
      people: [],
      settings: {},
    };

    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    if (!mobileStorage.saveTask) {
      throw new Error('Expected mobile storage to support saveTask');
    }
    __mobileStorageTestUtils.setSqliteStateForTests({
      adapter: { saveTask: sqliteAdapterSaveTask },
      client: {},
    });

    const oversizeWarnings = () => logWarnMock.mock.calls.filter(
      ([message]) => message === '[Storage] Skipped JSON backup; library exceeds the readable AsyncStorage size',
    ).length;

    await mobileStorage.saveTask(hugeSnapshot.tasks[0], hugeSnapshot);
    await __mobileStorageTestUtils.flushPendingStartupJsonBackup();
    expect(oversizeWarnings()).toBe(1);

    // flush() bypasses the backup's throttle (app background, SQLite-failure
    // fallback), so without a guard every one of those re-serialized multiple MB
    // on the JS thread only to discard the string again.
    await mobileStorage.saveTask(hugeSnapshot.tasks[1], hugeSnapshot);
    await __mobileStorageTestUtils.flushPendingStartupJsonBackup();
    expect(oversizeWarnings()).toBe(1);

    // Still treated as absent, so nothing downstream trusts a backup that was
    // never written.
    __mobileStorageTestUtils.setSqliteInitializerForTests(async () => {
      throw new Error('SQLite read timed out');
    });
    await expect(mobileStorage.getData()).rejects.toThrow('SQLite read timed out');
  }, 20_000);

  it('lets a contended SQLite read outlast the fail-fast cap when the JSON backup is unusable (#766)', async () => {
    const makeTask = (id: string): Task => ({
      id,
      title: `Task ${id} ${'padding '.repeat(20)}`,
      status: 'next',
      tags: [],
      contexts: [],
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
    });
    const hugeSnapshot = {
      tasks: Array.from({ length: 6_000 }, (_, index) => makeTask(`task-${index}`)),
      projects: [],
      sections: [],
      areas: [],
      people: [],
      settings: {},
    } satisfies AppData;

    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    if (!mobileStorage.saveTask) {
      throw new Error('Expected mobile storage to support saveTask');
    }
    __mobileStorageTestUtils.setSqliteStateForTests({
      adapter: { saveTask: sqliteAdapterSaveTask },
      client: {},
    });
    // Oversized library ⇒ the JSON backup is skipped, so no fallback exists.
    await mobileStorage.saveTask(hugeSnapshot.tasks[0], hugeSnapshot);
    await __mobileStorageTestUtils.flushPendingStartupJsonBackup();
    expect(logWarnMock).toHaveBeenCalledWith(
      '[Storage] Skipped JSON backup; library exceeds the readable AsyncStorage size',
      expect.objectContaining({ scope: 'storage' }),
    );

    vi.useFakeTimers();
    try {
      // A read that takes 5s (past the 3.5s fail-fast cap) while sync writes
      // contend must still complete instead of failing the sync cycle.
      __mobileStorageTestUtils.setSqliteStateForTests({
        adapter: {
          saveTask: sqliteAdapterSaveTask,
          getData: () => new Promise((resolve) => {
            setTimeout(() => resolve(hugeSnapshot), 5_000);
          }),
        },
        client: {},
      });
      const read = mobileStorage.getData();
      read.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(read).resolves.toEqual(
        expect.objectContaining({ tasks: expect.arrayContaining([expect.objectContaining({ id: 'task-0' })]) }),
      );
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  // A library over the Android cap never writes the JSON backup, and the
  // oversize flag lives only in memory. On a cold start the first read used to
  // fail fast at 3.5s into a backup that was never written and report an empty
  // library, which the store treats as a fresh install.
  it('waits out a slow cold-start SQLite read instead of reporting an empty library when no JSON backup is stored', async () => {
    const library = {
      ...makeWidgetSnapshot(makeWidgetTask('task-real')),
      people: [],
      settings: { language: 'de' },
    } satisfies AppData;
    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    vi.useFakeTimers();
    try {
      __mobileStorageTestUtils.setSqliteStateForTests({
        adapter: {
          saveTask: sqliteAdapterSaveTask,
          getData: () => new Promise((resolve) => {
            setTimeout(() => resolve(library), 5_000);
          }),
        },
        client: {},
      });
      const read = mobileStorage.getData();
      read.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(read).resolves.toEqual(library);
      expect(logWarnMock).toHaveBeenCalledWith(
        '[Storage] No JSON backup stored; SQLite is the only readable copy',
        expect.objectContaining({ force: true, extra: { releaseCheck: 'v1.3.8/rn-load-no-backup' } }),
      );
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it('surfaces a failed SQLite load instead of an empty library when no JSON backup is stored', async () => {
    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    __mobileStorageTestUtils.setSqliteInitializerForTests(async () => {
      throw new Error('SQLite read timed out');
    });
    await expect(mobileStorage.getData()).rejects.toThrow('SQLite read timed out');
    // The failed read must not pin later reads to the absent backup either.
    await expect(mobileStorage.getData()).rejects.toThrow('SQLite read timed out');
  }, 10_000);

  const storedAsyncStorage = () => {
    const stored = new Map<string, string>();
    asyncStorageMock.getItem.mockImplementation(async (key: string) => stored.get(key) ?? null);
    asyncStorageMock.setItem.mockImplementation(async (key: string, value: string) => {
      stored.set(key, value);
    });
    asyncStorageMock.removeItem.mockImplementation(async (key: string) => {
      stored.delete(key);
    });
    return stored;
  };

  const makeOversizedLibrary = (): AppData => ({
    ...makeWidgetSnapshot(makeWidgetTask('task-0')),
    tasks: Array.from({ length: 6_000 }, (_, index) => ({
      ...makeWidgetTask(`task-${index}`),
      title: `Task ${index} ${'padding '.repeat(20)}`,
    })),
  });

  const storeStaleBackup = (stored: Map<string, string>) => {
    stored.set('mindwtr-data', JSON.stringify({
      ...makeWidgetSnapshot(makeWidgetTask('task-stale')),
      settings: { language: 'fr' },
    }));
    stored.set('mindwtr-data:startup-backup-version', '2');
    stored.set('mindwtr-data:startup-backup-updated-at', '1');
    // getLegacyJson promotes this copy whenever DATA_KEY is absent.
    stored.set('focus-gtd-data', JSON.stringify(makeWidgetSnapshot(makeWidgetTask('task-legacy'))));
  };

  // A library that outgrows the cap leaves its last small backup behind, stamp
  // and all. A later slow cold start used to fail fast into that old copy and
  // load its tasks and settings.
  it('marks a stale backup outgrown once the library outgrows the cap, so a slow cold start waits for SQLite instead of loading it', async () => {
    const stored = storedAsyncStorage();
    storeStaleBackup(stored);
    const library = {
      ...makeWidgetSnapshot(makeWidgetTask('task-real')),
      people: [],
      settings: { language: 'de' },
    } satisfies AppData;
    const oversized = makeOversizedLibrary();

    const firstRun = await import('./storage-adapter');
    firstRun.__mobileStorageTestUtils.setSqliteStateForTests({
      adapter: { saveTask: sqliteAdapterSaveTask },
      client: {},
    });
    await firstRun.mobileStorage.saveTask!(oversized.tasks[0], oversized);
    await firstRun.__mobileStorageTestUtils.flushPendingStartupJsonBackup();
    // Nothing is deleted; the marker only stops the fallbacks from trusting it.
    expect(stored.has('mindwtr-data:startup-backup-outgrown-at')).toBe(true);
    expect(stored.has('mindwtr-data')).toBe(true);
    expect(stored.has('mindwtr-data:startup-backup-updated-at')).toBe(true);
    expect(stored.has('focus-gtd-data')).toBe(true);
    firstRun.__mobileStorageTestUtils.reset();

    vi.resetModules();
    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    vi.useFakeTimers();
    try {
      __mobileStorageTestUtils.setSqliteStateForTests({
        adapter: {
          saveTask: sqliteAdapterSaveTask,
          getData: () => new Promise((resolve) => {
            setTimeout(() => resolve(library), 5_000);
          }),
        },
        client: {},
      });
      const read = mobileStorage.getData();
      read.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(read).resolves.toEqual(library);
    } finally {
      vi.useRealTimers();
    }
    const { getMobileStartupSnapshotFromBackup } = await import('./storage-adapter');
    await expect(getMobileStartupSnapshotFromBackup()).resolves.toBeNull();
  }, 30_000);

  it('clears the outgrown marker once a backup fits again, so a slow read falls back to that copy', async () => {
    const stored = storedAsyncStorage();
    stored.set('mindwtr-data:sqlite-json-reconcile-v1', '1');
    storeStaleBackup(stored);
    stored.set('mindwtr-data:startup-backup-outgrown-at', '1');
    const library = makeWidgetSnapshot(makeWidgetTask('task-small'));
    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    __mobileStorageTestUtils.setSqliteStateForTests({
      adapter: { saveTask: sqliteAdapterSaveTask },
      client: {},
    });

    await mobileStorage.saveTask!(library.tasks[0], library);
    await __mobileStorageTestUtils.flushPendingStartupJsonBackup();
    expect(stored.has('mindwtr-data:startup-backup-outgrown-at')).toBe(false);
    expect(stored.get('mindwtr-data')).toBe(JSON.stringify(library));

    vi.useFakeTimers();
    try {
      __mobileStorageTestUtils.setSqliteStateForTests({
        adapter: { saveTask: sqliteAdapterSaveTask, getData: () => new Promise<never>(() => {}) },
        client: {},
      });
      const read = mobileStorage.getData();
      read.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(4_000);
      await expect(read).resolves.toEqual(library);
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it('serves no outgrown or legacy copy on the JSON fast path while the outgrown marker is set', async () => {
    const stored = storedAsyncStorage();
    storeStaleBackup(stored);
    stored.delete('mindwtr-data');
    stored.set('mindwtr-data:startup-backup-updated-at', String(Date.now() + 60_000));
    stored.set('mindwtr-data:startup-backup-outgrown-at', '1');
    sqliteAdapterSaveTask.mockRejectedValue(new Error('disk I/O error'));
    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    __mobileStorageTestUtils.setSqliteStateForTests({
      adapter: { saveTask: sqliteAdapterSaveTask, getData: vi.fn().mockResolvedValue(makeWidgetSnapshot(makeWidgetTask('task-sqlite'))) },
      client: {},
    });
    // A failed task save with no snapshot no longer pins reads to a copy that
    // is no fallback at all; the next read goes to SQLite.
    await expect(mobileStorage.saveTask!(makeWidgetTask('task-1'))).rejects.toThrow('disk I/O error');

    await expect(mobileStorage.getData()).resolves.toEqual(expect.objectContaining({
      tasks: [expect.objectContaining({ id: 'task-sqlite' })],
    }));
    expect(stored.has('mindwtr-data')).toBe(false);
  }, 10_000);

  it('keeps the old backup when an oversized write skips it while the JSON copy is ahead of SQLite', async () => {
    const stored = storedAsyncStorage();
    storeStaleBackup(stored);
    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    __mobileStorageTestUtils.setSqliteInitializerForTests(() => Promise.reject(new Error('disk I/O error')));

    await expect(mobileStorage.saveData(makeOversizedLibrary())).rejects.toThrow('too large for the JSON backup');

    // The marker says this copy holds writes SQLite never took; only the
    // next launch's recovery may consume it.
    expect(stored.get('mindwtr-data:json-ahead-of-sqlite')).toBe('1');
    expect(stored.has('mindwtr-data')).toBe(true);
    expect(stored.has('mindwtr-data:startup-backup-updated-at')).toBe(true);
    expect(stored.has('mindwtr-data:startup-backup-outgrown-at')).toBe(false);
  }, 20_000);

  it('refuses a stamp without its backup when SQLite fails instead of serving an empty library', async () => {
    const stored = storedAsyncStorage();
    stored.set('mindwtr-data:sqlite-json-reconcile-v1', '1');
    stored.set('mindwtr-data:startup-backup-updated-at', '1');
    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    __mobileStorageTestUtils.setSqliteInitializerForTests(() => Promise.reject(new Error('disk I/O error')));

    await expect(mobileStorage.getData()).rejects.toThrow('nothing to serve from get_data_fallback');
    // A fallback with nothing to serve must not pin later reads to it.
    await expect(mobileStorage.getData()).rejects.toThrow('nothing to serve from get_data_fallback');
  }, 10_000);

  // The first-launch migration writes the backup before SQLite holds the rows,
  // so there the JSON copy may be the only one. When that migration fails, the
  // next read of the empty SQLite schedules a backup that the throttle skips:
  // that skip must not cost the copy the next launch migrates from.
  it('keeps an over-cap JSON copy when migrating it into an empty SQLite fails, so the next launch migrates it', async () => {
    const stored = storedAsyncStorage();
    const oversized = makeOversizedLibrary();
    stored.set('mindwtr-data', JSON.stringify(oversized));
    stored.set('mindwtr-data:startup-backup-version', '2');
    stored.set('mindwtr-data:startup-backup-updated-at', '1');
    stored.set('focus-gtd-data', JSON.stringify(makeWidgetSnapshot(makeWidgetTask('task-legacy'))));
    const emptySqlite = (): AppData => ({ ...makeWidgetSnapshot(makeWidgetTask('unused')), tasks: [] });
    const client = { get: vi.fn().mockResolvedValue({ count: 0 }) };

    const firstRun = await import('./storage-adapter');
    const failingAdapter = {
      getData: vi.fn().mockImplementation(async () => emptySqlite()),
      saveData: vi.fn().mockRejectedValue(new Error('disk I/O error')),
    };
    await expect(
      firstRun.__mobileStorageTestUtils.prepareSqliteDataForTests(failingAdapter as never, client as never),
    ).rejects.toThrow('disk I/O error');
    expect(failingAdapter.saveData).toHaveBeenCalledTimes(1);
    firstRun.__mobileStorageTestUtils.setSqliteStateForTests({
      adapter: { saveTask: sqliteAdapterSaveTask, getData: failingAdapter.getData },
      client: {},
    });
    await expect(firstRun.mobileStorage.getData()).resolves.toEqual(expect.objectContaining({ tasks: [] }));
    await firstRun.__mobileStorageTestUtils.flushPendingStartupJsonBackup();
    expect(stored.get('mindwtr-data')).toBe(JSON.stringify(oversized));
    expect(stored.has('focus-gtd-data')).toBe(true);
    firstRun.__mobileStorageTestUtils.reset();

    vi.resetModules();
    const { __mobileStorageTestUtils } = await import('./storage-adapter');
    const adapter = {
      getData: vi.fn().mockImplementation(async () => emptySqlite()),
      saveData: vi.fn().mockResolvedValue(undefined),
    };
    await __mobileStorageTestUtils.prepareSqliteDataForTests(adapter as never, client as never);
    expect(adapter.saveData).toHaveBeenCalledWith(expect.objectContaining({
      tasks: expect.arrayContaining([expect.objectContaining({ id: 'task-5999' })]),
    }));
  }, 30_000);

  // A failed first-launch migration used to return a healthy state over the
  // empty database: reads showed an empty library, and the next backup write
  // (about 1 s later under the size cap, past the 5-minute throttle over it)
  // put that empty library over the only copy.
  it('serves the JSON copy and blocks writes after a failed first-launch migration, so nothing writes the empty SQLite over it', async () => {
    const stored = storedAsyncStorage();
    const oversized = makeOversizedLibrary();
    stored.set('mindwtr-data', JSON.stringify(oversized));
    stored.set('mindwtr-data:startup-backup-version', '2');
    stored.set('mindwtr-data:startup-backup-updated-at', '1');
    const emptySqlite = (): AppData => ({ ...makeWidgetSnapshot(makeWidgetTask('unused')), tasks: [] });
    const client = { get: vi.fn().mockResolvedValue({ count: 0 }) };
    const failingAdapter = {
      getData: vi.fn().mockImplementation(async () => emptySqlite()),
      saveData: vi.fn().mockRejectedValue(new Error('disk I/O error')),
      queryTasks: vi.fn().mockResolvedValue([]),
    };
    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    __mobileStorageTestUtils.setSqliteInitializerForTests(() => (
      __mobileStorageTestUtils.prepareSqliteStateForTests(failingAdapter as never, client as never)
    ));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const data = await mobileStorage.getData();
      vi.setSystemTime(Date.now() + 6 * 60_000);
      await __mobileStorageTestUtils.flushPendingStartupJsonBackup();
      expect(stored.get('mindwtr-data')).toBe(JSON.stringify(oversized));
      expect(data.tasks).toHaveLength(6_000);
      await expect(mobileStorage.queryTasks!({})).resolves.toHaveLength(6_000);
      expect(failingAdapter.queryTasks).not.toHaveBeenCalled();
      // The user's first edits cannot lift the block or write a small backup.
      await expect(mobileStorage.saveData(emptySqlite())).rejects.toThrow('moving your data into the database failed');
      await expect(mobileStorage.saveTask!(makeWidgetTask('task-new'), emptySqlite()))
        .rejects.toThrow('moving your data into the database failed');
      await __mobileStorageTestUtils.flushPendingStartupJsonBackup();
      expect(stored.get('mindwtr-data')).toBe(JSON.stringify(oversized));
      expect(logWarnMock).toHaveBeenCalledWith(
        '[Storage] JSON migration into SQLite failed; saving is blocked',
        expect.objectContaining({ force: true, extra: expect.objectContaining({ releaseCheck: 'v1.3.8/rn-migration-write-block' }) }),
      );
    } finally {
      vi.useRealTimers();
    }

    const healthyAdapter = {
      getData: vi.fn().mockImplementation(async () => emptySqlite()),
      saveData: vi.fn().mockResolvedValue(undefined),
    };
    const state = await __mobileStorageTestUtils.prepareSqliteStateForTests(healthyAdapter as never, client as never);
    expect(state.writeBlockedReason).toBeUndefined();
    expect(healthyAdapter.saveData).toHaveBeenCalledWith(expect.objectContaining({
      tasks: expect.arrayContaining([expect.objectContaining({ id: 'task-5999' })]),
    }));
  }, 30_000);

  const storeVersionedBackup = (stored: Map<string, string>, data?: AppData) => {
    if (data) stored.set('mindwtr-data', JSON.stringify(data));
    stored.set('mindwtr-data:startup-backup-version', '2');
    stored.set('mindwtr-data:startup-backup-updated-at', '1');
  };

  const failSetItemFor = (match: (key: string) => boolean) => {
    const setItem = asyncStorageMock.setItem.getMockImplementation()!;
    asyncStorageMock.setItem.mockImplementation(async (key: string, value: string) => {
      if (match(key)) throw new Error('database or disk is full (code 13 SQLITE_FULL)');
      return setItem(key, value);
    });
  };

  const isReconcileMarker = (key: string) => key === 'mindwtr-data:sqlite-json-reconcile-v1';

  // A failed reconcile used to make the app read-only. It now keeps SQLite as
  // the source and only freezes the backup that would overwrite the unmerged copy.
  it('keeps saving to SQLite after a failed reconcile, but writes no backup over the unmerged JSON copy until a later start merges it', async () => {
    const stored = storedAsyncStorage();
    const backup = makeWidgetSnapshot(makeWidgetTask('task-json-only'));
    storeVersionedBackup(stored, backup);
    const client = { get: vi.fn().mockResolvedValue({ count: 1 }) };
    const sqliteData = makeWidgetSnapshot(makeWidgetTask('task-sqlite'));
    const adapter = {
      getData: vi.fn().mockImplementation(async () => structuredClone(sqliteData)),
      saveData: vi.fn().mockRejectedValueOnce(new Error('disk I/O error')).mockResolvedValue(undefined),
    };
    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    __mobileStorageTestUtils.setSqliteInitializerForTests(() => (
      __mobileStorageTestUtils.prepareSqliteStateForTests(adapter as never, client as never)
    ));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const data = await mobileStorage.getData();
      expect(data.tasks.map((task) => task.id)).toEqual(['task-sqlite']);
      await expect(mobileStorage.saveData(data)).resolves.toBeUndefined();
      vi.setSystemTime(Date.now() + 6 * 60_000);
      await __mobileStorageTestUtils.flushPendingStartupJsonBackup();
    } finally {
      vi.useRealTimers();
    }
    expect(adapter.saveData).toHaveBeenCalledTimes(2);
    expect(stored.get('mindwtr-data')).toBe(JSON.stringify(backup));
    expect(stored.has('mindwtr-data:sqlite-json-reconcile-v1')).toBe(false);
    expect(logWarnMock).toHaveBeenCalledWith(
      '[Storage] JSON reconcile into SQLite failed; JSON backup frozen',
      expect.objectContaining({ force: true, extra: expect.objectContaining({ step: 'reconcile' }) }),
    );

    // SQLite failing too must not put a backup over the frozen copy either.
    adapter.saveData.mockRejectedValue(new Error('disk I/O error'));
    await expect(mobileStorage.saveData(sqliteData)).rejects.toThrow('not yet merged');
    await __mobileStorageTestUtils.flushPendingStartupJsonBackup();
    expect(stored.get('mindwtr-data')).toBe(JSON.stringify(backup));
    expect(stored.has('mindwtr-data:json-ahead-of-sqlite')).toBe(false);

    __mobileStorageTestUtils.reset();
    vi.resetModules();
    const nextLaunch = await import('./storage-adapter');
    const healthyAdapter = {
      getData: vi.fn().mockImplementation(async () => structuredClone(sqliteData)),
      saveData: vi.fn().mockResolvedValue(undefined),
    };
    await nextLaunch.__mobileStorageTestUtils.prepareSqliteStateForTests(healthyAdapter as never, client as never);
    const merged = healthyAdapter.saveData.mock.calls[0]?.[0] as AppData;
    expect(merged.tasks.map((task) => task.id).sort()).toEqual(['task-json-only', 'task-sqlite']);
  }, 20_000);

  it('serves SQLite and keeps saving when only the reconcile marker write fails, and no copy is stored', async () => {
    const stored = storedAsyncStorage();
    storeVersionedBackup(stored);
    failSetItemFor(isReconcileMarker);
    const client = { get: vi.fn().mockResolvedValue({ count: 1 }) };
    const sqliteData = makeWidgetSnapshot(makeWidgetTask('task-sqlite'));
    const adapter = {
      getData: vi.fn().mockImplementation(async () => structuredClone(sqliteData)),
      saveData: vi.fn().mockResolvedValue(undefined),
    };
    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    __mobileStorageTestUtils.setSqliteInitializerForTests(() => (
      __mobileStorageTestUtils.prepareSqliteStateForTests(adapter as never, client as never)
    ));

    const data = await mobileStorage.getData();

    expect(data.tasks.map((task) => task.id)).toEqual(['task-sqlite']);
    await expect(mobileStorage.saveData(data)).resolves.toBeUndefined();
  }, 10_000);

  it('neither shows nor saves an unversioned legacy copy when only the reconcile marker write fails', async () => {
    const stored = storedAsyncStorage();
    stored.set('mindwtr-data', JSON.stringify(makeWidgetSnapshot(makeWidgetTask('task-legacy-stale'))));
    failSetItemFor(isReconcileMarker);
    const client = { get: vi.fn().mockResolvedValue({ count: 1 }) };
    const sqliteData = makeWidgetSnapshot(makeWidgetTask('task-sqlite'));
    const adapter = {
      getData: vi.fn().mockImplementation(async () => structuredClone(sqliteData)),
      saveData: vi.fn().mockResolvedValue(undefined),
    };
    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    __mobileStorageTestUtils.setSqliteInitializerForTests(() => (
      __mobileStorageTestUtils.prepareSqliteStateForTests(adapter as never, client as never)
    ));

    const data = await mobileStorage.getData();
    await mobileStorage.saveData(data);

    expect(data.tasks.map((task) => task.id)).toEqual(['task-sqlite']);
    expect(adapter.saveData).toHaveBeenCalledTimes(1);
    expect((adapter.saveData.mock.calls[0]?.[0] as AppData).tasks.map((task) => task.id)).toEqual(['task-sqlite']);
  }, 10_000);

  it('reads the newer SQLite row and freezes the backup when the reconcile marker cannot be read', async () => {
    const stored = storedAsyncStorage();
    const oldCopy = { ...makeWidgetSnapshot({ ...makeWidgetTask('task-1'), title: 'Old title', rev: 1 }) };
    storeVersionedBackup(stored, oldCopy);
    const getItem = asyncStorageMock.getItem.getMockImplementation()!;
    asyncStorageMock.getItem.mockImplementation(async (key: string) => {
      if (isReconcileMarker(key)) throw new Error('transient AsyncStorage read failure');
      return getItem(key);
    });
    const client = { get: vi.fn().mockResolvedValue({ count: 1 }) };
    const sqliteData = makeWidgetSnapshot({ ...makeWidgetTask('task-1'), title: 'New title', rev: 9 });
    const adapter = {
      getData: vi.fn().mockImplementation(async () => structuredClone(sqliteData)),
      saveData: vi.fn().mockResolvedValue(undefined),
    };
    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    __mobileStorageTestUtils.setSqliteInitializerForTests(() => (
      __mobileStorageTestUtils.prepareSqliteStateForTests(adapter as never, client as never)
    ));

    const data = await mobileStorage.getData();
    await mobileStorage.saveData(data);
    await __mobileStorageTestUtils.flushPendingStartupJsonBackup();

    expect(data.tasks[0]?.title).toBe('New title');
    expect((adapter.saveData.mock.calls[0]?.[0] as AppData).tasks[0]?.title).toBe('New title');
    expect(stored.get('mindwtr-data')).toBe(JSON.stringify(oldCopy));
  }, 10_000);

  it('freezes the backup when the JSON copy cannot be read for the reconcile, so it survives to a later start', async () => {
    const stored = storedAsyncStorage();
    const copy = makeWidgetSnapshot(makeWidgetTask('task-json-only'));
    storeVersionedBackup(stored, copy);
    let failCopyRead = true;
    const getItem = asyncStorageMock.getItem.getMockImplementation()!;
    asyncStorageMock.getItem.mockImplementation(async (key: string) => {
      if (failCopyRead && key === 'mindwtr-data') throw new Error('transient AsyncStorage read failure');
      return getItem(key);
    });
    const client = { get: vi.fn().mockResolvedValue({ count: 1 }) };
    const sqliteData = makeWidgetSnapshot(makeWidgetTask('task-sqlite'));
    const adapter = {
      getData: vi.fn().mockImplementation(async () => structuredClone(sqliteData)),
      saveData: vi.fn().mockResolvedValue(undefined),
    };
    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    __mobileStorageTestUtils.setSqliteInitializerForTests(() => (
      __mobileStorageTestUtils.prepareSqliteStateForTests(adapter as never, client as never)
    ));

    const data = await mobileStorage.getData();
    failCopyRead = false;
    await mobileStorage.saveData(data);
    await __mobileStorageTestUtils.flushPendingStartupJsonBackup();

    expect(stored.get('mindwtr-data')).toBe(JSON.stringify(copy));
    expect(stored.has('mindwtr-data:sqlite-json-reconcile-v1')).toBe(false);
  }, 10_000);

  // While the backup is frozen SQLite is the only source: the unmerged copy is
  // never served, pinned or judged stale, so a healthy SQLite keeps serving.
  const startFrozen = async (sqliteData: AppData, adapterExtra: Record<string, unknown> = {}) => {
    const stored = storedAsyncStorage();
    storeVersionedBackup(stored, { ...makeWidgetSnapshot(makeWidgetTask('task-old')), settings: { theme: 'light' } });
    const getItem = asyncStorageMock.getItem.getMockImplementation()!;
    asyncStorageMock.getItem.mockImplementation(async (key: string) => {
      if (isReconcileMarker(key)) throw new Error('transient AsyncStorage read failure');
      return getItem(key);
    });
    const client = { get: vi.fn().mockResolvedValue({ count: 1 }) };
    const adapter = {
      getData: vi.fn().mockImplementation(async () => structuredClone(sqliteData)),
      saveData: vi.fn().mockResolvedValue(undefined),
      saveTask: vi.fn().mockResolvedValue(undefined),
      ...adapterExtra,
    };
    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    __mobileStorageTestUtils.setSqliteInitializerForTests(() => (
      __mobileStorageTestUtils.prepareSqliteStateForTests(adapter as never, client as never)
    ));
    return { stored, adapter, mobileStorage };
  };

  it('keeps reading SQLite after a save and a failed query while the backup is frozen', async () => {
    const sqliteData = makeWidgetSnapshot(makeWidgetTask('task-sqlite'));
    const { mobileStorage } = await startFrozen(sqliteData, {
      queryTasks: vi.fn().mockRejectedValueOnce(new Error('database is locked')).mockResolvedValue(sqliteData.tasks),
      searchAll: vi.fn().mockRejectedValueOnce(new Error('database is locked')).mockResolvedValue({ tasks: sqliteData.tasks, projects: [] }),
    });

    await mobileStorage.saveData(await mobileStorage.getData());

    await expect(mobileStorage.queryTasks!({})).resolves.toEqual([expect.objectContaining({ id: 'task-sqlite' })]);
    await expect(mobileStorage.searchAll!('Task')).resolves.toEqual(expect.objectContaining({
      tasks: [expect.objectContaining({ id: 'task-sqlite' })],
    }));
    await expect(mobileStorage.getData()).resolves.toEqual(expect.objectContaining({
      tasks: [expect.objectContaining({ id: 'task-sqlite' })],
    }));
  }, 10_000);

  it('does not pin reads to the frozen copy when the freeze refuses a save', async () => {
    const sqliteData = makeWidgetSnapshot(makeWidgetTask('task-sqlite'));
    const { stored, adapter, mobileStorage } = await startFrozen(sqliteData);
    adapter.saveData.mockRejectedValue(new Error('database or disk is full'));
    adapter.saveTask.mockRejectedValue(new Error('database or disk is full'));
    const view = await mobileStorage.getData();

    await expect(mobileStorage.saveData(view)).rejects.toThrow('not yet merged');
    await expect(mobileStorage.saveTask!(makeWidgetTask('task-new'), view)).rejects.toThrow('not yet merged');

    await expect(mobileStorage.getData()).resolves.toEqual(expect.objectContaining({
      tasks: [expect.objectContaining({ id: 'task-sqlite' })],
    }));
    expect(JSON.parse(stored.get('mindwtr-data')!).tasks[0].id).toBe('task-old');
  }, 10_000);

  it('gives a slow SQLite read the long bound while the backup is frozen', async () => {
    const sqliteData = makeWidgetSnapshot(makeWidgetTask('task-sqlite'));
    let slow = false;
    const { mobileStorage } = await startFrozen(sqliteData, {
      getData: vi.fn().mockImplementation(async () => {
        if (slow) await new Promise((resolve) => setTimeout(resolve, 4_000));
        return structuredClone(sqliteData);
      }),
    });
    await mobileStorage.saveData(await mobileStorage.getData());
    slow = true;

    await expect(mobileStorage.getData()).resolves.toEqual(expect.objectContaining({
      tasks: [expect.objectContaining({ id: 'task-sqlite' })],
    }));
  }, 20_000);

  it('never serves the frozen copy when a SQLite read fails, so no save can write it over SQLite', async () => {
    const sqliteData = { ...makeWidgetSnapshot(makeWidgetTask('task-sqlite')), settings: { theme: 'dark' } } as AppData;
    let fail = false;
    const { adapter, mobileStorage } = await startFrozen(sqliteData, {
      getData: vi.fn().mockImplementation(async () => {
        if (fail) throw new Error('database is locked');
        return structuredClone(sqliteData);
      }),
    });
    await mobileStorage.getData();
    fail = true;

    await expect(mobileStorage.getData()).rejects.toThrow('database is locked');
    expect(adapter.saveData).not.toHaveBeenCalled();
  }, 10_000);

  it('fails the first read instead of serving the copy when the reconcile fails and SQLite cannot be read', async () => {
    const { adapter, mobileStorage } = await startFrozen(makeWidgetSnapshot(makeWidgetTask('task-sqlite')), {
      getData: vi.fn().mockRejectedValue(new Error('database is locked')),
    });

    await expect(mobileStorage.getData()).rejects.toThrow('database is locked');
    expect(adapter.saveData).not.toHaveBeenCalled();
  }, 10_000);

  // A slow init lets the first read fall back to the copy and pin reads to it
  // before the reconcile fails; the freeze must hand reads back to SQLite.
  // Finding B: SQLite opened slowly while the reconcile was still pending, the
  // first read fell back to the old copy, and the store's next save wrote that
  // copy's settings row whole over the newer one in SQLite.
  it('waits for SQLite instead of serving the copy while the reconcile is pending, so a save cannot write old settings back', async () => {
    const stored = storedAsyncStorage();
    storeVersionedBackup(stored, { ...makeWidgetSnapshot(makeWidgetTask('task-old')), settings: { theme: 'light' } });
    const sqliteData = { ...makeWidgetSnapshot(makeWidgetTask('task-sqlite')), settings: { theme: 'dark' } } as AppData;
    const client = {
      get: vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 4_500));
        return { count: 1 };
      }),
    };
    const adapter = {
      getData: vi.fn().mockImplementation(async () => structuredClone(sqliteData)),
      saveData: vi.fn().mockResolvedValue(undefined),
    };
    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    __mobileStorageTestUtils.setSqliteInitializerForTests(() => (
      __mobileStorageTestUtils.prepareSqliteStateForTests(adapter as never, client as never)
    ));

    const view = await mobileStorage.getData();
    adapter.saveData.mockClear();
    await mobileStorage.saveData(view);

    expect(view.tasks.map((task) => task.id)).toEqual(['task-sqlite']);
    expect((adapter.saveData.mock.calls[0]?.[0] as AppData).settings).toEqual(expect.objectContaining({ theme: 'dark' }));
  }, 20_000);

  it('lets reads fall back to the copy again once this run has merged it', async () => {
    const stored = storedAsyncStorage();
    storeVersionedBackup(stored, makeWidgetSnapshot(makeWidgetTask('task-copy')));
    stored.set('mindwtr-data:startup-backup-updated-at', String(Date.now() + 60_000));
    let failRead = false;
    const client = { get: vi.fn().mockResolvedValue({ count: 1 }) };
    const adapter = {
      getData: vi.fn().mockImplementation(async () => {
        if (failRead) throw new Error('database is locked');
        return makeWidgetSnapshot(makeWidgetTask('task-sqlite'));
      }),
      saveData: vi.fn().mockResolvedValue(undefined),
    };
    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    __mobileStorageTestUtils.setSqliteInitializerForTests(() => (
      __mobileStorageTestUtils.prepareSqliteStateForTests(adapter as never, client as never)
    ));
    asyncStorageMock.setItem.mockImplementation(async (key: string, value: string) => {
      // The marker write fails; this run still knows it merged the copy.
      if (key === 'mindwtr-data:sqlite-json-reconcile-v1') throw new Error('database or disk is full');
      stored.set(key, value);
    });

    await mobileStorage.getData();
    failRead = true;

    // Served by the fallback, which first lands the backup of SQLite's read.
    await expect(mobileStorage.getData()).resolves.toEqual(expect.objectContaining({
      tasks: [expect.objectContaining({ id: 'task-sqlite' })],
    }));
    // The reconcile's read, the first read, then the read that failed.
    expect(adapter.getData).toHaveBeenCalledTimes(3);
  }, 10_000);

  // P2: a frozen run leaves the copy older than SQLite. The next run's reconcile
  // merges it, and a second read that times out must not get the old copy back.
  it('refreshes the copy when the reconcile merges it, so a timed-out read after it serves SQLite data', async () => {
    const stored = storedAsyncStorage();
    const oldTask = { ...makeWidgetTask('task-1'), title: 'Old title', rev: 1 };
    storeVersionedBackup(stored, { ...makeWidgetSnapshot(oldTask), settings: { theme: 'light' } });
    const newTask = { ...makeWidgetTask('task-1'), title: 'New title', rev: 9 };
    const sqliteData = { ...makeWidgetSnapshot(newTask), settings: { theme: 'dark' } } as AppData;
    const client = { get: vi.fn().mockResolvedValue({ count: 1 }) };
    const adapter = {
      // The reconcile's own read is fast; the reads after it are slow.
      getData: vi.fn().mockImplementation(async () => {
        if (adapter.getData.mock.calls.length > 1) await new Promise((resolve) => setTimeout(resolve, 4_500));
        return structuredClone(sqliteData);
      }),
      saveData: vi.fn().mockResolvedValue(undefined),
    };
    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    let init: Promise<unknown> = Promise.resolve();
    __mobileStorageTestUtils.setSqliteInitializerForTests(() => {
      const state = __mobileStorageTestUtils.prepareSqliteStateForTests(adapter as never, client as never);
      init = state;
      return state;
    });

    const firstRead = mobileStorage.getData();
    await vi.waitFor(() => expect(adapter.getData.mock.calls.length).toBeGreaterThan(0));
    await init;
    const view = await mobileStorage.getData();
    await firstRead;
    adapter.saveData.mockClear();
    await mobileStorage.saveData(view);

    const written = adapter.saveData.mock.calls[0]?.[0] as AppData;
    expect(written.tasks[0]?.title).toBe('New title');
    expect(written.settings).toEqual(expect.objectContaining({ theme: 'dark' }));
  }, 30_000);

  const startReconcile = async (sqliteData: AppData, failSetItem: (key: string) => boolean) => {
    const stored = storedAsyncStorage();
    storeVersionedBackup(stored, makeWidgetSnapshot(makeWidgetTask('task-old')));
    failSetItemFor(failSetItem);
    const client = { get: vi.fn().mockResolvedValue({ count: 1 }) };
    const adapter = {
      getData: vi.fn().mockImplementation(async () => structuredClone(sqliteData)),
      saveData: vi.fn().mockResolvedValue(undefined),
    };
    const { __mobileStorageTestUtils } = await import('./storage-adapter');
    const state = await __mobileStorageTestUtils.prepareSqliteStateForTests(adapter as never, client as never);
    const frozen = logWarnMock.mock.calls.some(([message]) => message === '[Storage] JSON reconcile into SQLite failed; JSON backup frozen');
    return { stored, state, frozen };
  };

  it('marks the old copy outgrown when the merged library is too large to refresh it', async () => {
    const { stored, frozen } = await startReconcile(makeOversizedLibrary(), () => false);

    expect(JSON.parse(stored.get('mindwtr-data')!).tasks[0].id).toBe('task-old');
    expect(stored.has('mindwtr-data:startup-backup-outgrown-at')).toBe(true);
    expect(stored.get('mindwtr-data:sqlite-json-reconcile-v1')).toBe('1');
    expect(frozen).toBe(false);
  }, 20_000);

  it('marks the old copy outgrown when the refresh write fails, so the next start does not merge again', async () => {
    const { stored, frozen } = await startReconcile(
      makeWidgetSnapshot(makeWidgetTask('task-sqlite')),
      (key) => key === 'mindwtr-data',
    );

    expect(stored.has('mindwtr-data:startup-backup-outgrown-at')).toBe(true);
    expect(stored.get('mindwtr-data:sqlite-json-reconcile-v1')).toBe('1');
    expect(frozen).toBe(false);
  }, 10_000);

  it('freezes the backup when the old copy can be neither refreshed nor marked outgrown', async () => {
    const { stored, state, frozen } = await startReconcile(
      makeWidgetSnapshot(makeWidgetTask('task-sqlite')),
      (key) => key === 'mindwtr-data' || key === 'mindwtr-data:startup-backup-outgrown-at',
    );

    expect(state.writeBlockedReason).toBeUndefined();
    expect(frozen).toBe(true);
    expect(stored.has('mindwtr-data:sqlite-json-reconcile-v1')).toBe(false);
  }, 10_000);

  // The in-flight read: a read already falling back to the copy when the
  // reconcile fails returned that copy, and a save wrote its settings back.
  it('returns no copy a later save can write back when the reconcile fails during a read', async () => {
    const stored = storedAsyncStorage();
    storeVersionedBackup(stored, { ...makeWidgetSnapshot(makeWidgetTask('task-old')), settings: { theme: 'light' } });
    const getItem = asyncStorageMock.getItem.getMockImplementation()!;
    asyncStorageMock.getItem.mockImplementation(async (key: string) => {
      if (isReconcileMarker(key) && adapter.getData.mock.calls.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 4_000));
        throw new Error('transient AsyncStorage read failure');
      }
      if (key === 'mindwtr-data') await new Promise((resolve) => setTimeout(resolve, 1_500));
      return getItem(key);
    });
    const sqliteData = { ...makeWidgetSnapshot(makeWidgetTask('task-sqlite')), settings: { theme: 'dark' } } as AppData;
    const client = { get: vi.fn().mockResolvedValue({ count: 1 }) };
    const adapter = {
      getData: vi.fn().mockImplementation(async () => structuredClone(sqliteData)),
      saveData: vi.fn().mockResolvedValue(undefined),
    };
    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    __mobileStorageTestUtils.setSqliteInitializerForTests(() => (
      __mobileStorageTestUtils.prepareSqliteStateForTests(adapter as never, client as never)
    ));

    const view = await mobileStorage.getData();
    await mobileStorage.saveData(view);

    expect(view.tasks.map((task) => task.id)).toEqual(['task-sqlite']);
    expect((adapter.saveData.mock.calls.at(-1)?.[0] as AppData).settings).toEqual(expect.objectContaining({ theme: 'dark' }));
  }, 20_000);

  it('hands pinned reads back to SQLite when a slow reconcile then fails', async () => {
    const stored = storedAsyncStorage();
    storeVersionedBackup(stored, makeWidgetSnapshot(makeWidgetTask('task-old')));
    // The first read sees the marker (a normal slow start); the reconcile's
    // own read of it then fails, which freezes the backup mid-read.
    stored.set('mindwtr-data:sqlite-json-reconcile-v1', '1');
    let markerReads = 0;
    const getItem = asyncStorageMock.getItem.getMockImplementation()!;
    asyncStorageMock.getItem.mockImplementation(async (key: string) => {
      if (isReconcileMarker(key) && markerReads++ > 0) {
        await new Promise((resolve) => setTimeout(resolve, 4_000));
        throw new Error('transient AsyncStorage read failure');
      }
      return getItem(key);
    });
    const client = { get: vi.fn().mockResolvedValue({ count: 1 }) };
    const sqliteData = makeWidgetSnapshot(makeWidgetTask('task-sqlite'));
    const adapter = {
      getData: vi.fn().mockImplementation(async () => structuredClone(sqliteData)),
      saveData: vi.fn().mockResolvedValue(undefined),
    };
    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    let init: Promise<unknown> = Promise.resolve();
    __mobileStorageTestUtils.setSqliteInitializerForTests(() => {
      const state = __mobileStorageTestUtils.prepareSqliteStateForTests(adapter as never, client as never);
      init = state;
      return state;
    });

    await expect(mobileStorage.getData()).resolves.toEqual(expect.objectContaining({
      tasks: [expect.objectContaining({ id: 'task-old' })],
    }));
    await init;

    await expect(mobileStorage.getData()).resolves.toEqual(expect.objectContaining({
      tasks: [expect.objectContaining({ id: 'task-sqlite' })],
    }));
  }, 20_000);

  // A pin can still land after the freeze: a fallback read already past the
  // frozen check when the reconcile fails. The fast path must ignore it.
  it('reads SQLite, not a pin set after the freeze, once the backup is frozen', async () => {
    const stored = storedAsyncStorage();
    storeVersionedBackup(stored, makeWidgetSnapshot(makeWidgetTask('task-old')));
    // The first read sees the marker (a normal slow start); the reconcile's
    // own read of it then fails, which freezes the backup mid-read.
    stored.set('mindwtr-data:sqlite-json-reconcile-v1', '1');
    let markerReads = 0;
    const getItem = asyncStorageMock.getItem.getMockImplementation()!;
    asyncStorageMock.getItem.mockImplementation(async (key: string) => {
      if (isReconcileMarker(key) && markerReads++ > 0) {
        await new Promise((resolve) => setTimeout(resolve, 4_000));
        throw new Error('transient AsyncStorage read failure');
      }
      if (key === 'mindwtr-data') await new Promise((resolve) => setTimeout(resolve, 1_500));
      return getItem(key);
    });
    const client = { get: vi.fn().mockResolvedValue({ count: 1 }) };
    const sqliteData = makeWidgetSnapshot(makeWidgetTask('task-sqlite'));
    const adapter = {
      getData: vi.fn().mockImplementation(async () => structuredClone(sqliteData)),
      saveData: vi.fn().mockResolvedValue(undefined),
    };
    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    let init: Promise<unknown> = Promise.resolve();
    __mobileStorageTestUtils.setSqliteInitializerForTests(() => {
      const state = __mobileStorageTestUtils.prepareSqliteStateForTests(adapter as never, client as never);
      init = state;
      return state;
    });

    await mobileStorage.getData();
    await init;

    await expect(mobileStorage.getData()).resolves.toEqual(expect.objectContaining({
      tasks: [expect.objectContaining({ id: 'task-sqlite' })],
    }));
  }, 20_000);

  it('serves no startup snapshot while the reconcile marker is absent or unreadable', async () => {
    const stored = storedAsyncStorage();
    storeVersionedBackup(stored, makeWidgetSnapshot(makeWidgetTask('task-old')));
    const { getMobileStartupSnapshotFromBackup, __mobileStorageTestUtils } = await import('./storage-adapter');
    await expect(getMobileStartupSnapshotFromBackup()).resolves.toBeNull();
    // The answer is cached per run; each case below is a new start.
    __mobileStorageTestUtils.reset();

    const getItem = asyncStorageMock.getItem.getMockImplementation()!;
    asyncStorageMock.getItem.mockImplementation(async (key: string) => {
      if (isReconcileMarker(key)) throw new Error('transient AsyncStorage read failure');
      return getItem(key);
    });
    await expect(getMobileStartupSnapshotFromBackup()).resolves.toBeNull();

    asyncStorageMock.getItem.mockImplementation(getItem);
    __mobileStorageTestUtils.reset();
    stored.set('mindwtr-data:sqlite-json-reconcile-v1', '1');
    await expect(getMobileStartupSnapshotFromBackup()).resolves.toEqual(expect.objectContaining({
      tasks: [expect.objectContaining({ id: 'task-old' })],
    }));
  }, 10_000);

  // Core saveData reads each saved filter's id; the copy's raw settings once
  // carried a null entry into it, so every move failed the same way.
  it('drops broken saved filters from the copy so the move into SQLite succeeds', async () => {
    const stored = storedAsyncStorage();
    stored.set('mindwtr-data', JSON.stringify({
      ...makeWidgetSnapshot(makeWidgetTask('task-a')),
      settings: { theme: 'dark', savedFilters: [null] },
    }));
    const client = { get: vi.fn().mockResolvedValue({ count: 0 }) };
    const adapter = {
      getData: vi.fn().mockResolvedValue({ ...makeWidgetSnapshot(makeWidgetTask('unused')), tasks: [] }),
      saveData: vi.fn(async (data: AppData) => {
        (data.settings.savedFilters ?? []).forEach((filter) => filter.id);
      }),
    };
    const { __mobileStorageTestUtils } = await import('./storage-adapter');

    const state = await __mobileStorageTestUtils.prepareSqliteStateForTests(adapter as never, client as never);

    expect(state.writeBlockedReason).toBeUndefined();
    expect((adapter.saveData.mock.calls[0]?.[0] as AppData).settings).toEqual(expect.objectContaining({
      theme: 'dark',
      savedFilters: [],
    }));
  }, 10_000);

  it('keeps device-local settings when it recovers JSON-ahead writes into a SQLite with no settings', async () => {
    const stored = storedAsyncStorage();
    const settings = { theme: 'dark', notificationsEnabled: false, syncPreferences: { appearance: false } } as AppData['settings'];
    stored.set('mindwtr-data', JSON.stringify({ ...makeWidgetSnapshot(makeWidgetTask('task-a')), settings }));
    stored.set('mindwtr-data:json-ahead-of-sqlite', '1');
    const client = { get: vi.fn().mockResolvedValue({ count: 0 }) };
    const adapter = {
      getData: vi.fn().mockResolvedValue({ ...makeWidgetSnapshot(makeWidgetTask('unused')), tasks: [] }),
      saveData: vi.fn().mockResolvedValue(undefined),
    };
    const { __mobileStorageTestUtils } = await import('./storage-adapter');

    await __mobileStorageTestUtils.prepareSqliteStateForTests(adapter as never, client as never);

    for (const [written] of adapter.saveData.mock.calls) {
      expect((written as AppData).settings).toEqual(expect.objectContaining(settings));
    }
    expect(adapter.saveData).toHaveBeenCalled();
  }, 10_000);

  it("shows the startup snapshot on a fresh install's second start", async () => {
    const stored = storedAsyncStorage();
    const client = { get: vi.fn().mockResolvedValue({ count: 0 }) };
    const adapter = {
      getData: vi.fn().mockResolvedValue({ ...makeWidgetSnapshot(makeWidgetTask('unused')), tasks: [] }),
      saveData: vi.fn().mockResolvedValue(undefined),
    };
    const { getMobileStartupSnapshotFromBackup, __mobileStorageTestUtils } = await import('./storage-adapter');
    await __mobileStorageTestUtils.prepareSqliteStateForTests(adapter as never, client as never);
    // The first run's first backup lands after the user adds a task.
    storeVersionedBackup(stored, makeWidgetSnapshot(makeWidgetTask('task-new')));

    await expect(getMobileStartupSnapshotFromBackup()).resolves.toEqual(expect.objectContaining({
      tasks: [expect.objectContaining({ id: 'task-new' })],
    }));
  }, 10_000);

  it("keeps the copy's device-local settings when another process writes settings during the first move", async () => {
    const stored = storedAsyncStorage();
    stored.set('mindwtr-data', JSON.stringify({
      ...makeWidgetSnapshot(makeWidgetTask('task-a')),
      settings: { theme: 'dark', notificationsEnabled: false, savedFilters: [null] },
    }));
    const client = { get: vi.fn().mockResolvedValue({ count: 0 }) };
    const adapter = {
      // Empty at the probe; a second process wrote a setting before the re-read.
      getData: vi.fn().mockResolvedValue({ ...makeWidgetSnapshot(makeWidgetTask('unused')), tasks: [], settings: { language: 'de' } }),
      saveData: vi.fn().mockResolvedValue(undefined),
    };
    const { __mobileStorageTestUtils } = await import('./storage-adapter');

    await __mobileStorageTestUtils.prepareSqliteStateForTests(adapter as never, client as never);

    expect((adapter.saveData.mock.calls[0]?.[0] as AppData).settings).toEqual(expect.objectContaining({
      theme: 'dark',
      notificationsEnabled: false,
      language: 'de',
      savedFilters: [],
    }));
  }, 10_000);

  // M2: a copy SQLite always rejects used to fail every move the same way and
  // leave saving blocked for good. The move now repairs it first.
  const rejectLikeSqlite = async (data: AppData) => {
    if (data.tasks.some((task) => task.title == null)) throw new Error('NOT NULL constraint failed: tasks.title');
    const projectIds = new Set(data.projects.map((project) => project.id));
    if (data.sections.some((section) => !projectIds.has(section.projectId))) throw new Error('FOREIGN KEY constraint failed');
  };
  const brokenCopy = (): AppData => ({
    ...makeWidgetSnapshot({ ...makeWidgetTask('task-untitled'), title: null as unknown as string, description: 'Private note' }),
    sections: [{ id: 'section-orphan', projectId: 'project-gone', title: 'Orphan', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
  } as AppData);
  const expectRepairLogged = (step: string) => {
    const call = logWarnMock.mock.calls.find(([message]) => message === '[Storage] Repaired the JSON copy before moving it into SQLite');
    expect(call?.[1]).toEqual(expect.objectContaining({
      force: true,
      extra: expect.objectContaining({ releaseCheck: 'v1.3.8/rn-copy-repair', step, untitledTasks: '1', orphanSections: '1' }),
    }));
    expect(JSON.stringify(call)).not.toContain('Private note');
  };

  it('repairs a copy SQLite rejects so the first move succeeds and saving is not blocked', async () => {
    const stored = storedAsyncStorage();
    stored.set('mindwtr-data', JSON.stringify(brokenCopy()));
    const client = { get: vi.fn().mockResolvedValue({ count: 0 }) };
    const adapter = {
      getData: vi.fn().mockResolvedValue({ ...makeWidgetSnapshot(makeWidgetTask('unused')), tasks: [] }),
      saveData: vi.fn(rejectLikeSqlite),
    };
    const { __mobileStorageTestUtils } = await import('./storage-adapter');

    const state = await __mobileStorageTestUtils.prepareSqliteStateForTests(adapter as never, client as never);

    expect(state.writeBlockedReason).toBeUndefined();
    const moved = adapter.saveData.mock.calls[0]?.[0] as AppData;
    expect(moved.tasks).toEqual([expect.objectContaining({ id: 'task-untitled', title: 'Untitled', description: 'Private note' })]);
    expect(moved.sections).toEqual([]);
    // The old copy is rewritten with the repaired library.
    expect(JSON.parse(stored.get('mindwtr-data')!).tasks[0].title).toBe('Untitled');
    expectRepairLogged('migrate');
  }, 10_000);

  it('repairs a copy SQLite rejects in the reconcile, so the backup is not frozen', async () => {
    const stored = storedAsyncStorage();
    storeVersionedBackup(stored, brokenCopy());
    const client = { get: vi.fn().mockResolvedValue({ count: 1 }) };
    const adapter = {
      getData: vi.fn().mockResolvedValue(makeWidgetSnapshot(makeWidgetTask('task-sqlite'))),
      saveData: vi.fn(rejectLikeSqlite),
    };
    const { __mobileStorageTestUtils } = await import('./storage-adapter');

    await __mobileStorageTestUtils.prepareSqliteStateForTests(adapter as never, client as never);

    const frozen = logWarnMock.mock.calls.some(([message]) => message === '[Storage] JSON reconcile into SQLite failed; JSON backup frozen');
    expect(frozen).toBe(false);
    expect(stored.get('mindwtr-data:sqlite-json-reconcile-v1')).toBe('1');
    expect((adapter.saveData.mock.calls[0]?.[0] as AppData).tasks.map((task) => task.id).sort()).toEqual(['task-sqlite', 'task-untitled']);
    expectRepairLogged('reconcile');
  }, 10_000);

  it('repairs a copy SQLite rejects when it recovers JSON-ahead writes', async () => {
    const stored = storedAsyncStorage();
    stored.set('mindwtr-data', JSON.stringify(brokenCopy()));
    stored.set('mindwtr-data:json-ahead-of-sqlite', '1');
    const client = { get: vi.fn().mockResolvedValue({ count: 1 }) };
    const adapter = {
      getData: vi.fn().mockResolvedValue(makeWidgetSnapshot(makeWidgetTask('task-sqlite'))),
      saveData: vi.fn(rejectLikeSqlite),
    };
    const { __mobileStorageTestUtils } = await import('./storage-adapter');

    await expect(__mobileStorageTestUtils.prepareSqliteStateForTests(adapter as never, client as never)).resolves.toBeDefined();

    expect(stored.has('mindwtr-data:json-ahead-of-sqlite')).toBe(false);
    expect(JSON.parse(stored.get('mindwtr-data')!).tasks.find((task: Task) => task.id === 'task-untitled').title).toBe('Untitled');
    expectRepairLogged('recover');
  }, 10_000);

  it('keeps today\'s block when a repaired copy still fails, and shows the repaired copy', async () => {
    const stored = storedAsyncStorage();
    storeVersionedBackup(stored, brokenCopy());
    const client = { get: vi.fn().mockResolvedValue({ count: 0 }) };
    const adapter = {
      getData: vi.fn().mockResolvedValue({ ...makeWidgetSnapshot(makeWidgetTask('unused')), tasks: [] }),
      saveData: vi.fn().mockRejectedValue(new Error('disk I/O error')),
    };
    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    __mobileStorageTestUtils.setSqliteInitializerForTests(() => (
      __mobileStorageTestUtils.prepareSqliteStateForTests(adapter as never, client as never)
    ));

    const view = await mobileStorage.getData();

    expect(view.tasks).toEqual([expect.objectContaining({ id: 'task-untitled', title: 'Untitled' })]);
    expect(view.sections).toEqual([]);
    await expect(mobileStorage.saveData(view)).rejects.toThrow('moving your data into the database failed');
  }, 10_000);

  // A recovery that could neither rewrite nor mark the copy left it unsafe to
  // serve. A per-init freeze lost that on the next init; it must hold until a
  // backup lands, and stop no backup from landing.
  it('keeps a copy the recovery left unsafe out of reads across inits, until a backup lands', async () => {
    const stored = storedAsyncStorage();
    storeVersionedBackup(stored, makeWidgetSnapshot(makeWidgetTask('task-ahead')));
    stored.set('mindwtr-data:json-ahead-of-sqlite', '1');
    stored.set('mindwtr-data:sqlite-json-reconcile-v1', '1');
    let storageFull = true;
    failSetItemFor((key) => storageFull && (key === 'mindwtr-data' || key === 'mindwtr-data:startup-backup-outgrown-at'));
    let failRead = false;
    let slowRead = false;
    const client = { get: vi.fn().mockResolvedValue({ count: 1 }) };
    const adapter = {
      getData: vi.fn().mockImplementation(async () => {
        if (failRead) throw new Error('database is locked');
        if (slowRead) await new Promise((resolve) => setTimeout(resolve, 4_000));
        return makeWidgetSnapshot(makeWidgetTask('task-sqlite'));
      }),
      saveData: vi.fn().mockResolvedValue(undefined),
    };
    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    __mobileStorageTestUtils.setSqliteInitializerForTests(() => (
      __mobileStorageTestUtils.prepareSqliteStateForTests(adapter as never, client as never)
    ));

    await mobileStorage.getData();
    failRead = true;
    await expect(mobileStorage.getData()).rejects.toThrow('database is locked');
    // A later init recovers again (the marker stayed) and must not forget it.
    failRead = false;
    await __mobileStorageTestUtils.prepareSqliteStateForTests(adapter as never, client as never);
    expect(stored.get('mindwtr-data:json-ahead-of-sqlite')).toBe('1');
    failRead = true;
    await expect(mobileStorage.getData()).rejects.toThrow('database is locked');
    // With no copy to fall back to, a slow read gets the long bound.
    failRead = false;
    slowRead = true;
    await expect(mobileStorage.getData()).resolves.toEqual(expect.objectContaining({
      tasks: [expect.objectContaining({ id: 'task-sqlite' })],
    }));
    slowRead = false;

    // Once a backup lands the copy is a fallback again.
    storageFull = false;
    failRead = false;
    await mobileStorage.getData();
    await __mobileStorageTestUtils.flushPendingStartupJsonBackup();
    failRead = true;
    await expect(mobileStorage.getData()).resolves.toEqual(expect.objectContaining({
      tasks: [expect.objectContaining({ id: 'task-sqlite' })],
    }));
  }, 30_000);

  // The JSON-ahead marker is what makes the next start recover again. It must
  // outlive a copy that could be neither replaced nor marked outgrown.
  const startRecoveryWithFullStorage = async (failKey: (key: string) => boolean) => {
    const stored = storedAsyncStorage();
    stored.set('mindwtr-data', JSON.stringify(makeWidgetSnapshot(makeWidgetTask('task-ahead'))));
    stored.set('mindwtr-data:json-ahead-of-sqlite', '1');
    stored.set('mindwtr-data:sqlite-json-reconcile-v1', '1');
    failSetItemFor(failKey);
    const client = { get: vi.fn().mockResolvedValue({ count: 1 }) };
    const adapter = {
      getData: vi.fn().mockResolvedValue(makeWidgetSnapshot(makeWidgetTask('task-sqlite'))),
      saveData: vi.fn().mockResolvedValue(undefined),
    };
    const { __mobileStorageTestUtils } = await import('./storage-adapter');
    await __mobileStorageTestUtils.prepareSqliteStateForTests(adapter as never, client as never);
    return { stored, adapter };
  };

  it('keeps the JSON-ahead marker when the recovered copy can be neither replaced nor marked outgrown', async () => {
    const { stored, adapter } = await startRecoveryWithFullStorage(
      (key) => key === 'mindwtr-data' || key === 'mindwtr-data:startup-backup-outgrown-at',
    );

    expect(adapter.saveData).toHaveBeenCalled();
    expect(stored.get('mindwtr-data:json-ahead-of-sqlite')).toBe('1');
  }, 10_000);

  it('clears the JSON-ahead marker once the recovered copy is marked outgrown', async () => {
    const { stored } = await startRecoveryWithFullStorage((key) => key === 'mindwtr-data');

    expect(stored.has('mindwtr-data:startup-backup-outgrown-at')).toBe(true);
    expect(stored.has('mindwtr-data:json-ahead-of-sqlite')).toBe(false);
  }, 10_000);

  // The last unchecked pin: a saveTask with no snapshot, after init failed,
  // pinned reads to a copy that was never merged.
  it('does not pin reads to an unmerged copy when a saveTask without a snapshot fails', async () => {
    const stored = storedAsyncStorage();
    storeVersionedBackup(stored, makeWidgetSnapshot(makeWidgetTask('task-old')));
    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    __mobileStorageTestUtils.setSqliteInitializerForTests(() => Promise.reject(new Error('disk I/O error')));

    await expect(mobileStorage.saveTask!(makeWidgetTask('task-new'))).rejects.toThrow('disk I/O error');

    await expect(mobileStorage.getData()).rejects.toThrow('disk I/O error');
  }, 30_000);

  it('starts from a legacy-key copy when AsyncStorage is full', async () => {
    const stored = storedAsyncStorage();
    stored.set('focus-gtd-data', JSON.stringify(makeWidgetSnapshot(makeWidgetTask('task-legacy'))));
    failSetItemFor(() => true);
    const client = { get: vi.fn().mockResolvedValue({ count: 0 }) };
    const adapter = {
      getData: vi.fn().mockResolvedValue({ ...makeWidgetSnapshot(makeWidgetTask('unused')), tasks: [] }),
      saveData: vi.fn().mockResolvedValue(undefined),
    };
    const { __mobileStorageTestUtils } = await import('./storage-adapter');

    const state = await __mobileStorageTestUtils.prepareSqliteStateForTests(adapter as never, client as never);

    expect(state.writeBlockedReason).toBeUndefined();
    expect(adapter.saveData).toHaveBeenCalledWith(expect.objectContaining({
      tasks: [expect.objectContaining({ id: 'task-legacy' })],
    }));
  }, 10_000);

  it('still moves the JSON copy into SQLite when AsyncStorage is full', async () => {
    const stored = storedAsyncStorage();
    stored.set('mindwtr-data', JSON.stringify(makeWidgetSnapshot(makeWidgetTask('task-a'))));
    failSetItemFor(() => true);
    const client = { get: vi.fn().mockResolvedValue({ count: 0 }) };
    const adapter = {
      getData: vi.fn().mockResolvedValue({ ...makeWidgetSnapshot(makeWidgetTask('unused')), tasks: [] }),
      saveData: vi.fn().mockResolvedValue(undefined),
    };
    const { __mobileStorageTestUtils } = await import('./storage-adapter');

    const state = await __mobileStorageTestUtils.prepareSqliteStateForTests(adapter as never, client as never);

    expect(state.writeBlockedReason).toBeUndefined();
    expect(adapter.saveData).toHaveBeenCalledWith(expect.objectContaining({
      tasks: [expect.objectContaining({ id: 'task-a' })],
    }));
  }, 10_000);

  // Since e15fa3642 the migrate merge started from SQLite's empty settings, and
  // the sync merge drops device-local ones, so they reset on the move.
  it('keeps device-local settings when it moves the JSON copy into SQLite, and in the blocked view', async () => {
    const settings = {
      theme: 'dark',
      notificationsEnabled: false,
      dailyDigestMorningEnabled: true,
      syncPreferences: { appearance: false, language: false },
    } as AppData['settings'];
    const copy = { ...makeWidgetSnapshot(makeWidgetTask('task-a')), settings };
    const emptySqlite = (): AppData => ({ ...makeWidgetSnapshot(makeWidgetTask('unused')), tasks: [] });
    const client = { get: vi.fn().mockResolvedValue({ count: 0 }) };
    const stored = storedAsyncStorage();
    stored.set('mindwtr-data', JSON.stringify(copy));
    const adapter = {
      getData: vi.fn().mockImplementation(async () => emptySqlite()),
      saveData: vi.fn().mockResolvedValue(undefined),
    };
    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    await __mobileStorageTestUtils.prepareSqliteStateForTests(adapter as never, client as never);
    expect((adapter.saveData.mock.calls[0]?.[0] as AppData).settings).toEqual(expect.objectContaining(settings));
    expect(JSON.parse(stored.get('mindwtr-data')!).settings).toEqual(expect.objectContaining(settings));

    stored.set('mindwtr-data', JSON.stringify(copy));
    adapter.saveData.mockRejectedValue(new Error('disk I/O error'));
    __mobileStorageTestUtils.setSqliteInitializerForTests(() => (
      __mobileStorageTestUtils.prepareSqliteStateForTests(adapter as never, client as never)
    ));
    await expect(mobileStorage.getData()).resolves.toEqual(expect.objectContaining({
      settings: expect.objectContaining(settings),
    }));
  }, 10_000);

  // The block lifts on the 60 s retry; the store then saves the view it holds.
  it('lifts the block on the retry after the cooldown and then saves the full library to SQLite', async () => {
    const stored = storedAsyncStorage();
    const copy = { ...makeWidgetSnapshot(makeWidgetTask('task-a')), tasks: [makeWidgetTask('task-a'), makeWidgetTask('task-b')] };
    storeVersionedBackup(stored, copy);
    const client = { get: vi.fn().mockResolvedValue({ count: 0 }) };
    const adapter = {
      getData: vi.fn().mockResolvedValue({ ...makeWidgetSnapshot(makeWidgetTask('unused')), tasks: [] }),
      saveData: vi.fn().mockRejectedValueOnce(new Error('disk I/O error')).mockResolvedValue(undefined),
    };
    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    __mobileStorageTestUtils.setSqliteInitializerForTests(() => (
      __mobileStorageTestUtils.prepareSqliteStateForTests(adapter as never, client as never)
    ));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const view = await mobileStorage.getData();
      await expect(mobileStorage.saveData(view)).rejects.toThrow('Mindwtr tries again every minute');
      vi.setSystemTime(Date.now() + 61_000);
      await expect(mobileStorage.saveData(view)).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    // Failed migration, retried migration, then the store's save.
    expect(adapter.saveData).toHaveBeenCalledTimes(3);
    for (const [written] of adapter.saveData.mock.calls.slice(1)) {
      expect((written as AppData).tasks.map((task) => task.id).sort()).toEqual(['task-a', 'task-b']);
    }
  }, 10_000);

  // A slow first init pinned reads to the JSON copy; a refused save then
  // marked a queued write, so every pinned read refused that copy as stale.
  it('keeps serving pinned JSON reads after a blocked save', async () => {
    const stored = storedAsyncStorage();
    stored.set('mindwtr-data:sqlite-json-reconcile-v1', '1');
    storeVersionedBackup(stored, makeWidgetSnapshot(makeWidgetTask('task-a')));
    const client = { get: vi.fn().mockResolvedValue({ count: 0 }) };
    let failMigration: () => void = () => undefined;
    const adapter = {
      getData: vi.fn().mockResolvedValue({ ...makeWidgetSnapshot(makeWidgetTask('unused')), tasks: [] }),
      saveData: vi.fn(() => new Promise<void>((_, reject) => {
        failMigration = () => reject(new Error('disk I/O error'));
      })),
    };
    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    __mobileStorageTestUtils.setSqliteInitializerForTests(() => (
      __mobileStorageTestUtils.prepareSqliteStateForTests(adapter as never, client as never)
    ));

    const first = await mobileStorage.getData();
    failMigration();
    await expect(mobileStorage.saveData(first)).rejects.toThrow('moving your data into the database failed');

    await expect(mobileStorage.getData()).resolves.toEqual(expect.objectContaining({
      tasks: [expect.objectContaining({ id: 'task-a' })],
    }));
  }, 20_000);

  it('migrates nothing from a corrupt JSON copy and keeps SQLite writable', async () => {
    const stored = storedAsyncStorage();
    stored.set('mindwtr-data', '{"tasks": [');
    const client = { get: vi.fn().mockResolvedValue({ count: 0 }) };
    const adapter = {
      getData: vi.fn().mockResolvedValue({ ...makeWidgetSnapshot(makeWidgetTask('unused')), tasks: [] }),
      saveData: vi.fn().mockResolvedValue(undefined),
    };
    const { __mobileStorageTestUtils } = await import('./storage-adapter');

    const state = await __mobileStorageTestUtils.prepareSqliteStateForTests(adapter as never, client as never);

    expect(state.writeBlockedReason).toBeUndefined();
    expect(adapter.saveData).not.toHaveBeenCalled();
    expect(stored.get('mindwtr-data:sqlite-json-reconcile-v1')).toBe('1');
  }, 10_000);

  it('pins reads to the JSON fast path when a SQLite query fails and a backup is stored', async () => {
    const stored = storedAsyncStorage();
    stored.set('mindwtr-data:sqlite-json-reconcile-v1', '1');
    storeStaleBackup(stored);
    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    __mobileStorageTestUtils.setSqliteStateForTests({
      adapter: {
        saveTask: sqliteAdapterSaveTask,
        getData: vi.fn().mockResolvedValue(makeWidgetSnapshot(makeWidgetTask('task-real'))),
        queryTasks: vi.fn().mockRejectedValue(new Error('database is locked')),
      } as never,
      client: {},
    });

    await expect(mobileStorage.queryTasks!({})).resolves.toEqual([expect.objectContaining({ id: 'task-stale' })]);
  }, 10_000);

  it('does not pin reads to the JSON fast path when a SQLite query fails and no backup is stored', async () => {
    storedAsyncStorage();
    const library = makeWidgetSnapshot(makeWidgetTask('task-real'));
    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    __mobileStorageTestUtils.setSqliteStateForTests({
      adapter: {
        saveTask: sqliteAdapterSaveTask,
        getData: vi.fn().mockResolvedValue(library),
        queryTasks: vi.fn().mockRejectedValue(new Error('database is locked')),
        searchAll: vi.fn().mockRejectedValue(new Error('database is locked')),
      } as never,
      client: {},
    });

    await expect(mobileStorage.queryTasks!({})).resolves.toEqual(library.tasks);
    await expect(mobileStorage.searchAll!('Task')).resolves.toEqual(expect.objectContaining({
      tasks: [expect.objectContaining({ id: 'task-real' })],
    }));
  }, 10_000);

  it('writes and trusts an oversized JSON backup on iOS, where it is the only fallback when SQLite fails (#979)', async () => {
    mockPlatformOS.value = 'ios';
    const stored = new Map<string, string>();
    stored.set('mindwtr-data:sqlite-json-reconcile-v1', '1');
    asyncStorageMock.getItem.mockImplementation(async (key: string) => stored.get(key) ?? null);
    asyncStorageMock.setItem.mockImplementation(async (key: string, value: string) => {
      stored.set(key, value);
    });
    const makeTask = (id: string): Task => ({
      id,
      title: `Task ${id} ${'padding '.repeat(20)}`,
      status: 'next',
      tags: [],
      contexts: [],
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
    });
    const hugeSnapshot: AppData = {
      tasks: Array.from({ length: 6_000 }, (_, index) => makeTask(`task-${index}`)),
      projects: [],
      sections: [],
      areas: [],
      people: [],
      settings: {},
    };
    expect(JSON.stringify(hugeSnapshot).length).toBeGreaterThan(1_500_000);

    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    if (!mobileStorage.saveTask) {
      throw new Error('Expected mobile storage to support saveTask');
    }
    __mobileStorageTestUtils.setSqliteStateForTests({
      adapter: { saveTask: sqliteAdapterSaveTask },
      client: {},
    });

    await mobileStorage.saveTask(hugeSnapshot.tasks[0], hugeSnapshot);
    await __mobileStorageTestUtils.flushPendingStartupJsonBackup();

    // iOS AsyncStorage has no CursorWindow row limit, so the backup is written
    // in full instead of skipped as oversized (#979).
    expect(asyncStorageMock.setItem).toHaveBeenCalledWith('mindwtr-data', expect.any(String));
    expect(logWarnMock).not.toHaveBeenCalledWith(
      '[Storage] Skipped JSON backup; library exceeds the readable AsyncStorage size',
      expect.anything(),
    );

    // With SQLite failing, the oversized backup must still serve as a readable
    // fallback rather than being refused as unreadable (the #979 regression:
    // this used to throw and leave the device unable to load or save at all).
    __mobileStorageTestUtils.setSqliteInitializerForTests(async () => {
      throw new Error('SQLite read timed out');
    });
    await expect(mobileStorage.getData()).resolves.toEqual(
      expect.objectContaining({ tasks: expect.arrayContaining([expect.objectContaining({ id: 'task-0' })]) }),
    );
  }, 20_000);

  it('coalesces a burst of task saves into a single backup write with the newest payload (#766)', async () => {
    const makeTask = (id: string): Task => ({
      id,
      title: `Task ${id}`,
      status: 'next',
      tags: [],
      contexts: [],
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
    });
    const makeSnapshot = (task: Task): AppData => ({
      tasks: [task],
      projects: [],
      sections: [],
      areas: [],
      people: [],
      settings: {},
    });

    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    if (!mobileStorage.saveTask) {
      throw new Error('Expected mobile storage to support saveTask');
    }
    __mobileStorageTestUtils.setSqliteStateForTests({
      adapter: { saveTask: sqliteAdapterSaveTask },
      client: {},
    });

    const first = makeTask('task-1');
    const second = makeTask('task-2');
    const third = makeTask('task-3');
    await mobileStorage.saveTask(first, makeSnapshot(first));
    await mobileStorage.saveTask(second, makeSnapshot(second));
    await mobileStorage.saveTask(third, makeSnapshot(third));

    await __mobileStorageTestUtils.flushPendingStartupJsonBackup();
    // Widget refresh runs on its own decoupled schedule (#766) and needs its
    // own flush.
    await __mobileStorageTestUtils.flushPendingWidgetRefresh();

    const dataWrites = asyncStorageMock.setItem.mock.calls.filter(([key]) => key === 'mindwtr-data');
    expect(dataWrites).toHaveLength(1);
    expect(dataWrites[0]?.[1]).toBe(JSON.stringify(makeSnapshot(third)));
    expect(updateMobileWidgetFromDataMock).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('throttles the JSON backup to at most one write per 5 minutes while saves keep arriving (#766)', async () => {
    const makeTask = (id: string): Task => ({
      id,
      title: `Task ${id}`,
      status: 'next',
      tags: [],
      contexts: [],
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
    });
    const makeSnapshot = (task: Task): AppData => ({
      tasks: [task],
      projects: [],
      sections: [],
      areas: [],
      people: [],
      settings: {},
    });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-30T00:00:00.000Z'));
      const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
      if (!mobileStorage.saveTask) {
        throw new Error('Expected mobile storage to support saveTask');
      }
      __mobileStorageTestUtils.setSqliteStateForTests({
        adapter: { saveTask: sqliteAdapterSaveTask },
        client: {},
      });

      const first = makeTask('task-first');
      await mobileStorage.saveTask(first, makeSnapshot(first));
      await vi.advanceTimersByTimeAsync(1_000);
      const writesAfterFirst = asyncStorageMock.setItem.mock.calls.filter(([key]) => key === 'mindwtr-data');
      expect(writesAfterFirst).toHaveLength(1);

      // Keep saving well inside the 5-minute throttle window (~50s of churn).
      let lastChurnTask = first;
      for (let index = 0; index < 5; index += 1) {
        lastChurnTask = makeTask(`task-churn-${index}`);
        await mobileStorage.saveTask(lastChurnTask, makeSnapshot(lastChurnTask));
        await vi.advanceTimersByTimeAsync(10_000);
      }
      const writesDuringChurn = asyncStorageMock.setItem.mock.calls.filter(([key]) => key === 'mindwtr-data');
      expect(writesDuringChurn).toHaveLength(1);

      // Advance past the remainder of the 5-minute window; the newest pending
      // payload lands in a single second write.
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      const finalWrites = asyncStorageMock.setItem.mock.calls.filter(([key]) => key === 'mindwtr-data');
      expect(finalWrites).toHaveLength(2);
      expect(finalWrites[1]?.[1]).toBe(JSON.stringify(makeSnapshot(lastChurnTask)));
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  it('flushPendingStartupJsonBackup writes the newest payload immediately during the throttle window (#766)', async () => {
    const makeTask = (id: string): Task => ({
      id,
      title: `Task ${id}`,
      status: 'next',
      tags: [],
      contexts: [],
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
    });
    const makeSnapshot = (task: Task): AppData => ({
      tasks: [task],
      projects: [],
      sections: [],
      areas: [],
      people: [],
      settings: {},
    });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-30T00:00:00.000Z'));
      const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
      if (!mobileStorage.saveTask) {
        throw new Error('Expected mobile storage to support saveTask');
      }
      __mobileStorageTestUtils.setSqliteStateForTests({
        adapter: { saveTask: sqliteAdapterSaveTask },
        client: {},
      });

      const first = makeTask('task-first');
      await mobileStorage.saveTask(first, makeSnapshot(first));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(asyncStorageMock.setItem.mock.calls.filter(([key]) => key === 'mindwtr-data')).toHaveLength(1);

      const second = makeTask('task-second');
      await mobileStorage.saveTask(second, makeSnapshot(second));
      // Still well inside the throttle window; no timer has fired yet.
      expect(asyncStorageMock.setItem.mock.calls.filter(([key]) => key === 'mindwtr-data')).toHaveLength(1);

      await __mobileStorageTestUtils.flushPendingStartupJsonBackup();

      const writes = asyncStorageMock.setItem.mock.calls.filter(([key]) => key === 'mindwtr-data');
      expect(writes).toHaveLength(2);
      expect(writes[1]?.[1]).toBe(JSON.stringify(makeSnapshot(second)));
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  it('flushPendingStartupJsonBackup drains a payload that arrives while an earlier write is still in flight (#766)', async () => {
    const makeTask = (id: string): Task => ({
      id,
      title: `Task ${id}`,
      status: 'next',
      tags: [],
      contexts: [],
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
    });
    const makeSnapshot = (task: Task): AppData => ({
      tasks: [task],
      projects: [],
      sections: [],
      areas: [],
      people: [],
      settings: {},
    });

    const stored = new Map<string, string>();
    stored.set('mindwtr-data:sqlite-json-reconcile-v1', '1');
    let resolveFirstDataWrite: (() => void) | undefined;
    let firstDataWriteStarted = false;
    asyncStorageMock.getItem.mockImplementation(async (key: string) => stored.get(key) ?? null);
    // Stall only the FIRST write to the data key so we can inject a
    // concurrent save while it's still in flight, then let it land.
    asyncStorageMock.setItem.mockImplementation((key: string, value: string) => {
      if (key === 'mindwtr-data' && !firstDataWriteStarted) {
        firstDataWriteStarted = true;
        return new Promise<void>((resolve) => {
          resolveFirstDataWrite = () => {
            stored.set(key, value);
            resolve();
          };
        });
      }
      stored.set(key, value);
      return Promise.resolve();
    });

    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    if (!mobileStorage.saveTask) {
      throw new Error('Expected mobile storage to support saveTask');
    }
    __mobileStorageTestUtils.setSqliteStateForTests({
      adapter: { saveTask: sqliteAdapterSaveTask },
      client: {},
    });

    const first = makeTask('task-first');
    await mobileStorage.saveTask(first, makeSnapshot(first));

    const flushPromise = __mobileStorageTestUtils.flushPendingStartupJsonBackup();

    // Let the first write actually start (and stall on the mocked setItem)
    // before injecting a concurrent save behind it.
    for (let index = 0; index < 10 && !firstDataWriteStarted; index += 1) {
      await Promise.resolve();
    }
    expect(firstDataWriteStarted).toBe(true);

    const second = makeTask('task-second');
    await mobileStorage.saveTask(second, makeSnapshot(second));

    let flushSettled = false;
    void flushPromise.then(() => { flushSettled = true; });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // The flush must not resolve until the newer payload lands too — not
    // just the one that was pending when flush was called.
    expect(flushSettled).toBe(false);

    resolveFirstDataWrite?.();
    await flushPromise;
    expect(flushSettled).toBe(true);

    expect(stored.get('mindwtr-data')).toBe(JSON.stringify(makeSnapshot(second)));

    // Exercise the exact failure mode this guards against: a fallback read
    // racing the flush must see the newest payload and its freshness stamp,
    // not be refused as stale.
    __mobileStorageTestUtils.setSqliteStateForTests({
      adapter: {
        saveTask: sqliteAdapterSaveTask,
        getData: vi.fn().mockRejectedValue(new Error('database is locked')),
      } as never,
      client: {},
    });
    const data = await mobileStorage.getData();
    expect(data.tasks.map((task) => task.id)).toEqual(['task-second']);
  }, 10_000);

  it('keeps widget refresh on its short coalesce cadence while the JSON backup is throttled (#766)', async () => {
    const makeTask = (id: string): Task => ({
      id,
      title: `Task ${id}`,
      status: 'next',
      tags: [],
      contexts: [],
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
    });
    const makeSnapshot = (task: Task): AppData => ({
      tasks: [task],
      projects: [],
      sections: [],
      areas: [],
      people: [],
      settings: {},
    });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-30T00:00:00.000Z'));
      const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
      if (!mobileStorage.saveTask) {
        throw new Error('Expected mobile storage to support saveTask');
      }
      __mobileStorageTestUtils.setSqliteStateForTests({
        adapter: { saveTask: sqliteAdapterSaveTask },
        client: {},
      });

      // Five saves spaced 2s apart (10s total), well inside the 5-minute
      // backup throttle window but each past the widget's 1s coalesce delay.
      for (let index = 0; index < 5; index += 1) {
        const task = makeTask(`task-${index}`);
        await mobileStorage.saveTask(task, makeSnapshot(task));
        await vi.advanceTimersByTimeAsync(2_000);
      }

      const backupWrites = asyncStorageMock.setItem.mock.calls.filter(([key]) => key === 'mindwtr-data').length;
      expect(backupWrites).toBe(1);
      expect(updateMobileWidgetFromDataMock).toHaveBeenCalledTimes(5);
      expect(updateMobileWidgetFromDataMock.mock.calls.length).toBeGreaterThan(backupWrites);
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  it('throttles foreground widget refreshes to one render per 5 minutes with the newest payload (#766)', async () => {
    try {
      const { saveTask, testUtils } = await setupForegroundWidgetStorage();

      const first = makeWidgetTask('widget-first');
      await saveTask(first, makeWidgetSnapshot(first));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(updateMobileWidgetFromDataMock).toHaveBeenCalledTimes(1);

      const second = makeWidgetTask('widget-second');
      await saveTask(second, makeWidgetSnapshot(second));
      await vi.advanceTimersByTimeAsync(2_000);
      await testUtils.flushPendingStartupJsonBackup();

      expect(updateMobileWidgetFromDataMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(updateMobileWidgetFromDataMock).toHaveBeenCalledTimes(2);
      expect(updateMobileWidgetFromDataMock).toHaveBeenLastCalledWith(makeWidgetSnapshot(second));
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  it('flushes the newest throttled widget refresh when the app moves to background (#766)', async () => {
    try {
      const { saveTask } = await setupForegroundWidgetStorage();

      const first = makeWidgetTask('widget-first');
      await saveTask(first, makeWidgetSnapshot(first));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(updateMobileWidgetFromDataMock).toHaveBeenCalledTimes(1);

      const second = makeWidgetTask('widget-second');
      const newest = makeWidgetTask('widget-newest');
      await saveTask(second, makeWidgetSnapshot(second));
      await saveTask(newest, makeWidgetSnapshot(newest));
      expect(updateMobileWidgetFromDataMock).toHaveBeenCalledTimes(1);

      appStateCurrentState.value = 'background';
      appStateListeners.forEach((listener) => listener('background'));
      await vi.advanceTimersByTimeAsync(0);

      expect(updateMobileWidgetFromDataMock).toHaveBeenCalledTimes(2);
      expect(updateMobileWidgetFromDataMock).toHaveBeenLastCalledWith(makeWidgetSnapshot(newest));
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  it('re-arms a foreground widget refresh queued during an in-flight render and flushes it on demand (#766)', async () => {
    try {
      let resolveFirstWidgetRefresh!: () => void;
      updateMobileWidgetFromDataMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveFirstWidgetRefresh = resolve;
      }));
      const { saveTask, testUtils } = await setupForegroundWidgetStorage();

      const first = makeWidgetTask('widget-first');
      await saveTask(first, makeWidgetSnapshot(first));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(updateMobileWidgetFromDataMock).toHaveBeenCalledTimes(1);

      const second = makeWidgetTask('widget-second');
      await saveTask(second, makeWidgetSnapshot(second));
      resolveFirstWidgetRefresh();
      await vi.advanceTimersByTimeAsync(0);
      await testUtils.flushPendingStartupJsonBackup();

      expect(updateMobileWidgetFromDataMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      await testUtils.flushPendingWidgetRefresh();
      expect(updateMobileWidgetFromDataMock).toHaveBeenCalledTimes(2);
      expect(updateMobileWidgetFromDataMock).toHaveBeenLastCalledWith(makeWidgetSnapshot(second));
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  // Headless RN instances (background sync, context automation) are destroyed the
  // moment their task promise settles. A throttled backup or widget render still
  // pending at that point resolves on a dead Hermes runtime and takes the process
  // down with a native SIGSEGV, so quiescing must land the work immediately rather
  // than leave it behind a multi-minute timer.
  it('quiesces throttled backup and widget work without waiting out the window', async () => {
    try {
      const { saveTask } = await setupForegroundWidgetStorage();
      const { quiesceMobileStorage } = await import('./storage-adapter');

      const first = makeWidgetTask('widget-first');
      await saveTask(first, makeWidgetSnapshot(first));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(updateMobileWidgetFromDataMock).toHaveBeenCalledTimes(1);

      const second = makeWidgetTask('widget-second');
      await saveTask(second, makeWidgetSnapshot(second));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(updateMobileWidgetFromDataMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      await quiesceMobileStorage();

      expect(updateMobileWidgetFromDataMock).toHaveBeenCalledTimes(2);
      expect(updateMobileWidgetFromDataMock).toHaveBeenLastCalledWith(makeWidgetSnapshot(second));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  it('flushes the pending JSON backup when the app moves to background (#766)', async () => {
    const currentTask: Task = {
      id: 'task-background',
      title: 'Background flush task',
      status: 'next',
      tags: [],
      contexts: [],
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
    };
    const currentSnapshot: AppData = {
      tasks: [currentTask],
      projects: [],
      sections: [],
      areas: [],
      people: [],
      settings: {},
    };

    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    if (!mobileStorage.saveTask) {
      throw new Error('Expected mobile storage to support saveTask');
    }
    __mobileStorageTestUtils.setSqliteStateForTests({
      adapter: { saveTask: sqliteAdapterSaveTask },
      client: {},
    });
    expect(appStateListeners.length).toBeGreaterThan(0);

    await mobileStorage.saveTask(currentTask, currentSnapshot);
    expect(asyncStorageMock.setItem).not.toHaveBeenCalledWith('mindwtr-data', expect.anything());

    appStateListeners.forEach((listener) => listener('background'));
    // The listener flushes fire-and-forget; give its promise chain a couple
    // of real event-loop turns to settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(asyncStorageMock.setItem).toHaveBeenCalledWith(
      'mindwtr-data',
      JSON.stringify(currentSnapshot),
    );
  }, 10_000);

  it('flushes a pending deferred backup before serving a JSON fallback read (#766)', async () => {
    const stored = new Map<string, string>();
    stored.set('mindwtr-data:sqlite-json-reconcile-v1', '1');
    asyncStorageMock.getItem.mockImplementation(async (key: string) => stored.get(key) ?? null);
    asyncStorageMock.setItem.mockImplementation(async (key: string, value: string) => {
      stored.set(key, value);
    });

    const currentTask: Task = {
      id: 'task-pending',
      title: 'Pending backup task',
      status: 'next',
      tags: [],
      contexts: [],
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
    };
    const currentSnapshot: AppData = {
      tasks: [currentTask],
      projects: [],
      sections: [],
      areas: [],
      people: [],
      settings: {},
    };

    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    if (!mobileStorage.saveTask) {
      throw new Error('Expected mobile storage to support saveTask');
    }
    __mobileStorageTestUtils.setSqliteStateForTests({
      adapter: {
        saveTask: sqliteAdapterSaveTask,
        // A read through this adapter fails, forcing the JSON fallback path.
        getData: vi.fn().mockRejectedValue(new Error('database is locked')),
      } as never,
      client: {},
    });

    // The save resolves with the backup still pending (deferred off the queue).
    await mobileStorage.saveTask(currentTask, currentSnapshot);
    expect(stored.has('mindwtr-data')).toBe(false);

    // The fallback read must land the pending backup first instead of refusing
    // it as stale (freshness invariant: backupUpdatedAt >= latest queued write).
    const data = await mobileStorage.getData();
    expect(data.tasks.map((task) => task.id)).toEqual(['task-pending']);
  }, 10_000);

  it('writes the JSON backup before a failed SQLite task save resolves', async () => {
    const currentTask: Task = {
      id: 'task-fallback',
      title: 'Fallback task',
      status: 'next',
      tags: [],
      contexts: [],
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
    };
    const currentSnapshot: AppData = {
      tasks: [currentTask],
      projects: [],
      sections: [],
      areas: [],
      people: [],
      settings: {},
    };

    sqliteAdapterSaveTask.mockRejectedValue(new Error('disk I/O error'));
    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    if (!mobileStorage.saveTask) {
      throw new Error('Expected mobile storage to support saveTask');
    }
    __mobileStorageTestUtils.setSqliteStateForTests({
      adapter: { saveTask: sqliteAdapterSaveTask },
      client: {},
    });

    await mobileStorage.saveTask(currentTask, currentSnapshot);

    // SQLite failed, so the JSON backup is the durable copy and must have
    // landed by the time the save resolves.
    expect(asyncStorageMock.setItem).toHaveBeenCalledWith(
      'mindwtr-data',
      JSON.stringify(currentSnapshot),
    );
  }, 10_000);

  it('waits for queued SQLite writes before reading from SQLite', async () => {
    const currentSnapshot: AppData = {
      tasks: [],
      projects: [
        {
          id: 'project-current',
          title: 'Current project',
          status: 'active',
          order: 0,
          color: '#888888',
          tagIds: [],
          createdAt: '2026-06-30T00:00:00.000Z',
          updatedAt: '2026-06-30T00:00:00.000Z',
        },
      ],
      sections: [],
      areas: [],
      people: [],
      settings: {},
    };
    let finishSqliteWrite!: () => void;
    let writeFinished = false;
    const sqliteAdapterSaveData = vi.fn(() => new Promise<void>((resolve) => {
      finishSqliteWrite = () => {
        writeFinished = true;
        resolve();
      };
    }));
    const sqliteAdapterGetData = vi.fn(async () => {
      if (!writeFinished) {
        throw new Error('read started before queued write finished');
      }
      return currentSnapshot;
    });

    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    __mobileStorageTestUtils.setSqliteStateForTests({
      adapter: {
        getData: sqliteAdapterGetData,
        saveData: sqliteAdapterSaveData,
        saveTask: sqliteAdapterSaveTask,
      } as any,
      client: {},
    });

    const savePromise = mobileStorage.saveData(currentSnapshot);
    for (let index = 0; index < 5 && sqliteAdapterSaveData.mock.calls.length === 0; index += 1) {
      await Promise.resolve();
    }
    expect(sqliteAdapterSaveData).toHaveBeenCalledTimes(1);

    const readPromise = mobileStorage.getData();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sqliteAdapterGetData).not.toHaveBeenCalled();

    finishSqliteWrite();
    await savePromise;
    await expect(readPromise).resolves.toEqual(currentSnapshot);
    expect(sqliteAdapterGetData).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('falls back to a fresh JSON backup instead of hanging when a queued SQLite write stalls', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-30T00:00:00.000Z'));
      const freshBackupUpdatedAt = String(Date.now() + 1);
      const backupSnapshot: AppData = {
        tasks: [],
        projects: [
          {
            id: 'project-backup',
            title: 'Backup project',
            status: 'active',
            order: 0,
            color: '#888888',
            tagIds: [],
            createdAt: '2026-06-30T00:00:00.000Z',
            updatedAt: '2026-06-30T00:00:00.000Z',
          },
        ],
        sections: [],
        areas: [],
        people: [],
        settings: {},
      };
      asyncStorageMock.getItem.mockImplementation((key: string) => {
        if (key === 'mindwtr-data:sqlite-json-reconcile-v1') return Promise.resolve('1');
        if (key === 'mindwtr-data:startup-backup-updated-at') return Promise.resolve(freshBackupUpdatedAt);
        if (key === 'mindwtr-data') return Promise.resolve(JSON.stringify(backupSnapshot));
        return Promise.resolve(null);
      });

      // A SQLite write that never settles, e.g. a lost-promise native bridge call.
      const stalledSave = vi.fn(() => new Promise<void>(() => {}));
      const sqliteAdapterGetData = vi.fn(async () => {
        throw new Error('SQLite read should not run while a write is stalled');
      });

      const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
      __mobileStorageTestUtils.setSqliteStateForTests({
        adapter: {
          getData: sqliteAdapterGetData,
          saveData: stalledSave,
          saveTask: sqliteAdapterSaveTask,
        } as any,
        client: {},
      });

      void mobileStorage.saveData(backupSnapshot);
      await vi.advanceTimersByTimeAsync(0);
      expect(stalledSave).toHaveBeenCalledTimes(1);

      const readPromise = mobileStorage.getData();
      let settled = false;
      void readPromise.then(() => { settled = true; }, () => { settled = true; });

      // Advance well past the bounded wait; the read must give up waiting and fall back.
      await vi.advanceTimersByTimeAsync(6_000);
      expect(settled).toBe(true);

      const data = await readPromise;
      expect(data.projects).toEqual(backupSnapshot.projects);
      expect(sqliteAdapterGetData).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  it('rejects a stale JSON backup when a queued SQLite write stalls', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-30T00:00:00.000Z'));
      const staleBackupUpdatedAt = String(Date.now() - 1);
      const staleBackup: AppData = {
        tasks: [],
        projects: [
          {
            id: 'project-stale-backup',
            title: 'Stale backup project',
            status: 'active',
            order: 0,
            color: '#888888',
            tagIds: [],
            createdAt: '2026-06-29T00:00:00.000Z',
            updatedAt: '2026-06-29T00:00:00.000Z',
          },
        ],
        sections: [],
        areas: [],
        people: [],
        settings: {},
      };
      asyncStorageMock.getItem.mockImplementation((key: string) => {
        if (key === 'mindwtr-data:sqlite-json-reconcile-v1') return Promise.resolve('1');
        if (key === 'mindwtr-data:startup-backup-updated-at') return Promise.resolve(staleBackupUpdatedAt);
        if (key === 'mindwtr-data') return Promise.resolve(JSON.stringify(staleBackup));
        return Promise.resolve(null);
      });

      const stalledSave = vi.fn(() => new Promise<void>(() => {}));
      const sqliteAdapterGetData = vi.fn(async () => staleBackup);

      const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
      __mobileStorageTestUtils.setSqliteStateForTests({
        adapter: {
          getData: sqliteAdapterGetData,
          saveData: stalledSave,
          saveTask: sqliteAdapterSaveTask,
        } as any,
        client: {},
      });

      void mobileStorage.saveData(staleBackup);
      await vi.advanceTimersByTimeAsync(0);
      expect(stalledSave).toHaveBeenCalledTimes(1);

      const readPromise = mobileStorage.getData();
      const readExpectation = expect(readPromise).rejects.toThrow('JSON backup is older than the latest queued SQLite write');
      await vi.advanceTimersByTimeAsync(6_000);

      await readExpectation;
      expect(sqliteAdapterGetData).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  it('runs every SQLite statement one by one on the shared op-sqlite connection', async () => {
    const executedStatements: Array<{ sql: string; args: unknown[] }> = [];
    const execute = vi.fn(async (sql: string, args: unknown[]) => {
      executedStatements.push({ sql, args });
      return { rows: [] };
    });
    const db = { execute };

    const { __mobileStorageTestUtils } = await import('./storage-adapter');
    const { SQLITE_BASE_SCHEMA } = await import('@mindwtr/core');
    const client = __mobileStorageTestUtils.createOpSqliteClientForTests(db);
    expect(client.exec).toBeDefined();

    await client.exec?.(SQLITE_BASE_SCHEMA);
    await client.run('BEGIN IMMEDIATE');
    await client.run('INSERT INTO tasks (id) VALUES (?)', ['task-1']);
    await client.run('COMMIT');

    const statements = executedStatements.map((entry) => entry.sql);
    // Connection pragmas apply for real (a wrapper transaction would no-op them)…
    // …including temp_store, without which a spilled statement journal fails with
    // "disk I/O error" on Android (#964).
    expect(statements.slice(0, 4)).toEqual([
      'PRAGMA journal_mode = WAL',
      'PRAGMA foreign_keys = ON',
      'PRAGMA busy_timeout = 5000',
      'PRAGMA temp_store = MEMORY',
    ]);
    // …the schema flows through the same direct path…
    expect(statements.some((statement) => statement.startsWith('CREATE TABLE IF NOT EXISTS tasks'))).toBe(true);
    // …and adapter-managed transactions stay intact instead of committing per statement (#766).
    expect(statements.slice(-3)).toEqual([
      'BEGIN IMMEDIATE',
      'INSERT INTO tasks (id) VALUES (?)',
      'COMMIT',
    ]);
    expect(executedStatements[executedStatements.length - 2]?.args).toEqual(['task-1']);
  }, 10_000);

  it('reconciles rc.1 JSON-only writes into SQLite without reviving older live data', async () => {
    const makeTask = (
      id: string,
      title: string,
      rev: number,
      revBy: string,
      deletedAt?: string,
    ): Task => ({
      id,
      title,
      status: 'next',
      tags: [],
      contexts: [],
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: `2026-07-16T00:00:0${rev}.000Z`,
      rev,
      revBy,
      ...(deletedAt ? { deletedAt } : {}),
    });
    const sqliteData: AppData = {
      tasks: [
        makeTask('edited-on-rc1', 'Old SQLite title', 1, 'sqlite-device'),
        makeTask('sqlite-only', 'SQLite only', 1, 'sqlite-device'),
        makeTask('deleted-before-rc1', 'Deleted', 3, 'sqlite-device', '2026-07-16T00:00:03.000Z'),
      ],
      projects: [],
      sections: [],
      areas: [],
      people: [],
      settings: {},
    };
    const backupData: AppData = {
      tasks: [
        makeTask('edited-on-rc1', 'Edited while rc.1 used JSON', 2, 'rc1-device'),
        makeTask('backup-only', 'Created while rc.1 used JSON', 1, 'rc1-device'),
        makeTask('deleted-before-rc1', 'Stale live copy', 2, 'rc1-device'),
      ],
      projects: [],
      sections: [],
      areas: [],
      people: [],
      settings: {},
    };
    const stored = new Map<string, string>([
      ['mindwtr-data', JSON.stringify(backupData)],
      ['mindwtr-data:startup-backup-version', '2'],
    ]);
    asyncStorageMock.getItem.mockImplementation(async (key: string) => stored.get(key) ?? null);
    asyncStorageMock.setItem.mockImplementation(async (key: string, value: string) => {
      stored.set(key, value);
    });
    const getData = vi.fn().mockResolvedValue(sqliteData);
    const saveData = vi.fn().mockResolvedValue(undefined);

    const { __mobileStorageTestUtils } = await import('./storage-adapter');
    await __mobileStorageTestUtils.reconcileJsonBackupIntoSqliteForTests({
      getData,
      saveData,
    } as never);

    expect(saveData).toHaveBeenCalledTimes(1);
    const merged = saveData.mock.calls[0]?.[0] as AppData;
    expect(merged.tasks.find((task) => task.id === 'edited-on-rc1')?.title)
      .toBe('Edited while rc.1 used JSON');
    expect(merged.tasks.some((task) => task.id === 'sqlite-only')).toBe(true);
    expect(merged.tasks.some((task) => task.id === 'backup-only')).toBe(true);
    expect(merged.tasks.find((task) => task.id === 'deleted-before-rc1')?.deletedAt)
      .toBe('2026-07-16T00:00:03.000Z');
    expect(stored.get('mindwtr-data:sqlite-json-reconcile-v1')).toBe('1');

    await __mobileStorageTestUtils.reconcileJsonBackupIntoSqliteForTests({
      getData,
      saveData,
    } as never);
    expect(getData).toHaveBeenCalledTimes(1);
    expect(saveData).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('treats a one-shot count failure as unknown and preserves newer SQLite rows', async () => {
    const makeTask = (id: string, title: string, rev: number, revBy: string): Task => ({
      id,
      title,
      status: 'next',
      tags: [],
      contexts: [],
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: `2026-07-21T00:00:0${rev}.000Z`,
      rev,
      revBy,
    });
    const backup: AppData = {
      tasks: [makeTask('shared', 'Stale backup title', 1, 'backup-device')],
      projects: [],
      sections: [],
      areas: [],
      people: [],
      settings: {},
    };
    let sqliteData: AppData = {
      tasks: [
        makeTask('shared', 'Newer SQLite title', 2, 'sqlite-device'),
        makeTask('sqlite-only', 'SQLite only', 1, 'sqlite-device'),
      ],
      projects: [],
      sections: [],
      areas: [],
      people: [],
      settings: {},
    };
    const stored = new Map<string, string>([
      ['mindwtr-data', JSON.stringify(backup)],
      ['mindwtr-data:startup-backup-version', '2'],
    ]);
    asyncStorageMock.getItem.mockImplementation(async (key: string) => stored.get(key) ?? null);
    asyncStorageMock.setItem.mockImplementation(async (key: string, value: string) => {
      stored.set(key, value);
    });
    let failNextCount = true;
    const client = {
      get: vi.fn(async (sql: string) => {
        if (failNextCount && sql.includes('COUNT(*)')) {
          failNextCount = false;
          throw new Error('one-shot count failure');
        }
        return { count: sql.includes('FROM tasks') ? sqliteData.tasks.length : 0 };
      }),
    };
    const adapter = {
      getData: vi.fn(async () => sqliteData),
      saveData: vi.fn(async (data: AppData) => {
        sqliteData = data;
      }),
    };

    const { __mobileStorageTestUtils } = await import('./storage-adapter');
    await __mobileStorageTestUtils.prepareSqliteDataForTests(
      adapter as never,
      client as never,
    );
    expect(adapter.getData).toHaveBeenCalledTimes(1);
    expect(adapter.saveData).toHaveBeenCalledTimes(1);
    expect(sqliteData.tasks.map((task) => task.id).sort()).toEqual(['shared', 'sqlite-only']);
    expect(sqliteData.tasks.find((task) => task.id === 'shared')?.title).toBe('Newer SQLite title');
  }, 10_000);

  it('merges a legacy backup with a fresh SQLite read before first migration', async () => {
    const makeTask = (id: string, title: string): Task => ({
      id,
      title,
      status: 'next',
      tags: [],
      contexts: [],
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
      rev: 1,
      revBy: 'device-a',
    });
    const backup: AppData = {
      tasks: [makeTask('backup-only', 'Backup only')],
      projects: [],
      sections: [],
      areas: [],
      people: [],
      settings: {},
    };
    const current: AppData = {
      tasks: [makeTask('concurrent-sqlite', 'Inserted after probe')],
      projects: [],
      sections: [],
      areas: [],
      people: [],
      settings: {},
    };
    const stored = new Map<string, string>([['mindwtr-data', JSON.stringify(backup)]]);
    asyncStorageMock.getItem.mockImplementation(async (key: string) => stored.get(key) ?? null);
    asyncStorageMock.setItem.mockImplementation(async (key: string, value: string) => {
      stored.set(key, value);
    });
    const client = { get: vi.fn().mockResolvedValue({ count: 0 }) };
    const saveData = vi.fn().mockResolvedValue(undefined);

    const { __mobileStorageTestUtils } = await import('./storage-adapter');
    await __mobileStorageTestUtils.prepareSqliteDataForTests({
      getData: vi.fn().mockResolvedValue(current),
      saveData,
    } as never, client as never);

    const migrated = saveData.mock.calls[0]?.[0] as AppData;
    expect(migrated.tasks.map((task) => task.id).sort()).toEqual(['backup-only', 'concurrent-sqlite']);
    expect(JSON.parse(stored.get('mindwtr-data') ?? '{}').tasks.map((task: Task) => task.id).sort())
      .toEqual(['backup-only', 'concurrent-sqlite']);
  }, 10_000);

  it.each(['sections', 'people', 'saved_filters'])(
    'recognizes a %s-only SQLite store as non-empty',
    async (populatedTable) => {
      const client = {
        get: vi.fn(async (sql: string) => ({ count: sql.includes(`FROM ${populatedTable}`) ? 1 : 0 })),
      };
      const { __mobileStorageTestUtils } = await import('./storage-adapter');

      await expect(__mobileStorageTestUtils.sqliteHasAnyDataForTests(client as never)).resolves.toBe(true);
    },
  );

  it('does not mark JSON reconciliation complete until the merged SQLite save succeeds', async () => {
    const stored = new Map<string, string>([
      ['mindwtr-data', JSON.stringify({
        tasks: [],
        projects: [],
        sections: [],
        areas: [],
        people: [],
        settings: {},
      } satisfies AppData)],
      ['mindwtr-data:startup-backup-version', '2'],
    ]);
    asyncStorageMock.getItem.mockImplementation(async (key: string) => stored.get(key) ?? null);
    asyncStorageMock.setItem.mockImplementation(async (key: string, value: string) => {
      stored.set(key, value);
    });
    const saveData = vi.fn().mockRejectedValue(new Error('disk I/O error'));

    const { __mobileStorageTestUtils } = await import('./storage-adapter');
    await expect(__mobileStorageTestUtils.reconcileJsonBackupIntoSqliteForTests({
      getData: vi.fn().mockResolvedValue({
        tasks: [],
        projects: [],
        sections: [],
        areas: [],
        people: [],
        settings: {},
      }),
      saveData,
    } as never)).rejects.toThrow('disk I/O error');

    expect(stored.has('mindwtr-data:sqlite-json-reconcile-v1')).toBe(false);
  }, 10_000);

  it('does not merge an unmarked legacy JSON snapshot into an existing SQLite store', async () => {
    const stored = new Map<string, string>([
      ['mindwtr-data', JSON.stringify({
        tasks: [{
          id: 'stale-task',
          title: 'Stale legacy task',
          status: 'next',
          tags: [],
          contexts: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }],
        projects: [],
        sections: [],
        areas: [],
        people: [],
        settings: {},
      } satisfies AppData)],
    ]);
    asyncStorageMock.getItem.mockImplementation(async (key: string) => stored.get(key) ?? null);
    asyncStorageMock.setItem.mockImplementation(async (key: string, value: string) => {
      stored.set(key, value);
    });
    const getData = vi.fn();
    const saveData = vi.fn();

    const { __mobileStorageTestUtils } = await import('./storage-adapter');
    await __mobileStorageTestUtils.reconcileJsonBackupIntoSqliteForTests({
      getData,
      saveData,
    } as never);

    expect(getData).not.toHaveBeenCalled();
    expect(saveData).not.toHaveBeenCalled();
    expect(stored.get('mindwtr-data:sqlite-json-reconcile-v1')).toBe('1');
  }, 10_000);

  it('maps op-sqlite rows and binds undefined params as null', async () => {
    const executedStatements: Array<{ sql: string; args: unknown[] }> = [];
    const execute = vi.fn(async (sql: string, args: unknown[]) => {
      executedStatements.push({ sql, args });
      if (sql.startsWith('SELECT')) {
        return { rows: [{ id: 'task-1' }, { id: 'task-2' }] };
      }
      return { rows: [] };
    });
    const db = { execute };

    const { __mobileStorageTestUtils } = await import('./storage-adapter');
    const client = __mobileStorageTestUtils.createOpSqliteClientForTests(db);

    await expect(client.all('SELECT id FROM tasks')).resolves.toEqual([
      { id: 'task-1' },
      { id: 'task-2' },
    ]);
    await expect(client.get('SELECT id FROM tasks')).resolves.toEqual({ id: 'task-1' });
    await expect(client.get('UPDATE tasks SET title = ?', ['x'])).resolves.toBeUndefined();

    await client.run('INSERT INTO tasks (id, title) VALUES (?, ?)', ['task-3', undefined]);
    expect(executedStatements[executedStatements.length - 1]?.args).toEqual(['task-3', null]);
  }, 10_000);

  it('ignores an unmarked JSON backup startup snapshot', async () => {
    const staleBackup = {
      tasks: [
        {
          id: 'deleted-task',
          title: 'Deleted task',
          status: 'next',
          tags: [],
          contexts: [],
          createdAt: '2026-06-15T00:00:00.000Z',
          updatedAt: '2026-06-15T00:00:00.000Z',
        },
      ],
      projects: [],
      sections: [],
      areas: [],
      people: [],
      settings: {},
    };
    asyncStorageMock.getItem.mockImplementation((key: string) => (
      key === 'mindwtr-data' ? Promise.resolve(JSON.stringify(staleBackup)) : Promise.resolve(null)
    ));

    const { getMobileStartupSnapshotFromBackup } = await import('./storage-adapter');
    const snapshot = await getMobileStartupSnapshotFromBackup();

    expect(snapshot).toBeNull();
  }, 10_000);

  it('preserves people when reading the JSON backup startup snapshot', async () => {
    const backup = {
      tasks: [],
      projects: [],
      sections: [],
      areas: [],
      people: [
        {
          id: 'person-1',
          name: 'Alex',
          createdAt: '2026-04-01T00:00:00.000Z',
          updatedAt: '2026-04-01T00:00:00.000Z',
        },
      ],
      settings: {},
    };
    asyncStorageMock.getItem.mockImplementation((key: string) => {
      if (key === 'mindwtr-data:startup-backup-version') {
        return Promise.resolve('2');
      }
      if (key === 'mindwtr-data:sqlite-json-reconcile-v1') {
        return Promise.resolve('1');
      }
      if (key === 'mindwtr-data') {
        return Promise.resolve(JSON.stringify(backup));
      }
      return Promise.resolve(null);
    });

    const { getMobileStartupSnapshotFromBackup } = await import('./storage-adapter');
    const snapshot = await getMobileStartupSnapshotFromBackup();

    expect(snapshot?.people).toEqual(backup.people);
  }, 10_000);

  // #964: SQLite kept reading fine while every write failed, so the JSON copy
  // took the writes and nothing ever read it back — each restart looked like the
  // app had rolled back to the last state SQLite accepted.
  describe('when SQLite refuses writes but still reads (#964)', () => {
    const backupTask: Task = {
      id: 'task-new',
      title: 'Written while SQLite was down',
      status: 'inbox',
      tags: [],
      contexts: [],
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z',
    };
    const staleSqliteData: AppData = {
      tasks: [],
      projects: [],
      sections: [],
      areas: [],
      people: [],
      settings: {},
    };
    const jsonBackup: AppData = { ...staleSqliteData, tasks: [backupTask] };

    const stubStoredKeys = (keys: Record<string, string | null>) => {
      asyncStorageMock.getItem.mockImplementation((key: string) => Promise.resolve(keys[key] ?? null));
    };

    // Wires a live Map-backed AsyncStorage (so a marker/counter written by one
    // call is readable by the next) and primes the in-memory jsonAheadOfSqlite
    // marker the same way the app does: a real failed saveData that falls back
    // to the JSON backup. Returns the backing store so a test can flip
    // `dataKeyError` to make the *next* backup read fail deliberately.
    const primeJsonAheadMarker = async () => {
      const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
      const stored = new Map<string, string>();
      const dataKeyError = { current: null as Error | null };
      asyncStorageMock.getItem.mockImplementation(async (key: string) => {
        if (key === 'mindwtr-data' && dataKeyError.current) {
          throw dataKeyError.current;
        }
        return stored.get(key) ?? null;
      });
      asyncStorageMock.setItem.mockImplementation(async (key: string, value: string) => {
        stored.set(key, value);
      });
      asyncStorageMock.removeItem.mockImplementation(async (key: string) => {
        stored.delete(key);
      });

      __mobileStorageTestUtils.setSqliteInitializerForTests(() => Promise.reject(new Error('disk I/O error')));
      await mobileStorage.saveData(jsonBackup);
      expect(stored.get('mindwtr-data:json-ahead-of-sqlite')).toBe('1');

      return { mobileStorage, __mobileStorageTestUtils, stored, dataKeyError };
    };

    it('marks the JSON backup as ahead when it takes a write SQLite rejected', async () => {
      const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
      __mobileStorageTestUtils.setSqliteInitializerForTests(() => Promise.reject(new Error('disk I/O error')));

      await mobileStorage.saveData(jsonBackup);

      expect(asyncStorageMock.setItem).toHaveBeenCalledWith('mindwtr-data:json-ahead-of-sqlite', '1');
      expect(asyncStorageMock.setItem).toHaveBeenCalledWith('mindwtr-data', JSON.stringify(jsonBackup));
      const persistedKeys = asyncStorageMock.setItem.mock.calls.map(([key]) => key);
      expect(persistedKeys.indexOf('mindwtr-data:json-ahead-of-sqlite'))
        .toBeLessThan(persistedKeys.indexOf('mindwtr-data'));
    }, 10_000);

    it('reports failure instead of accepting an unmarked JSON-only write', async () => {
      asyncStorageMock.setItem.mockImplementation((key: string) => (
        key === 'mindwtr-data:json-ahead-of-sqlite'
          ? Promise.reject(new Error('marker write failed'))
          : Promise.resolve()
      ));
      const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
      __mobileStorageTestUtils.setSqliteInitializerForTests(() => Promise.reject(new Error('disk I/O error')));

      await expect(mobileStorage.saveData(jsonBackup)).rejects.toThrow('marker write failed');
      expect(asyncStorageMock.setItem).not.toHaveBeenCalledWith('mindwtr-data', JSON.stringify(jsonBackup));
    }, 10_000);

    it('merges those writes back into SQLite on the next launch and clears the marker', async () => {
      stubStoredKeys({
        'mindwtr-data:json-ahead-of-sqlite': '1',
        'mindwtr-data': JSON.stringify(jsonBackup),
      });
      const saveData = vi.fn().mockResolvedValue(undefined);
      const adapter = { getData: vi.fn().mockResolvedValue(staleSqliteData), saveData } as any;
      const client = { get: vi.fn().mockResolvedValue({ count: 0 }) } as any;
      const { __mobileStorageTestUtils } = await import('./storage-adapter');

      await __mobileStorageTestUtils.prepareSqliteDataForTests(adapter, client);

      expect(saveData).toHaveBeenCalled();
      expect(saveData.mock.calls[0][0].tasks.map((task: Task) => task.id)).toEqual(['task-new']);
      expect(asyncStorageMock.removeItem).toHaveBeenCalledWith('mindwtr-data:json-ahead-of-sqlite');
    }, 10_000);

    it('fails initialization when SQLite still refuses the recovered writes, so reads use the JSON copy', async () => {
      stubStoredKeys({
        'mindwtr-data:json-ahead-of-sqlite': '1',
        'mindwtr-data': JSON.stringify(jsonBackup),
      });
      const adapter = {
        getData: vi.fn().mockResolvedValue(staleSqliteData),
        saveData: vi.fn().mockRejectedValue(new Error('disk I/O error')),
      } as any;
      const client = { get: vi.fn().mockResolvedValue({ count: 0 }) } as any;
      const { __mobileStorageTestUtils } = await import('./storage-adapter');

      await expect(__mobileStorageTestUtils.prepareSqliteDataForTests(adapter, client))
        .rejects.toThrow('disk I/O error');
      // Still ahead: the writes are only in the backup, so the marker must stay.
      expect(asyncStorageMock.removeItem).not.toHaveBeenCalledWith('mindwtr-data:json-ahead-of-sqlite');
    }, 10_000);

    // #975: once the marker is set, SQLite reads keep succeeding but serve
    // progressively stale data. Reads must prefer the JSON backup instead of
    // trusting SQLite, and must never let that stale read overwrite the newer
    // backup.
    it('serves the JSON backup for getData and does not let a succeeding SQLite read overwrite it (#975)', async () => {
      const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
      const stored = new Map<string, string>();
      asyncStorageMock.getItem.mockImplementation(async (key: string) => stored.get(key) ?? null);
      asyncStorageMock.setItem.mockImplementation(async (key: string, value: string) => {
        stored.set(key, value);
      });
      __mobileStorageTestUtils.setSqliteInitializerForTests(() => Promise.reject(new Error('disk I/O error')));

      // SQLite refuses the write; the marker is set and the backup takes it.
      await mobileStorage.saveData(jsonBackup);
      expect(stored.get('mindwtr-data')).toBe(JSON.stringify(jsonBackup));

      // SQLite recovers enough to serve reads again, but what it holds predates
      // the write above — the marker says the backup is still ahead.
      const sqliteAdapterGetData = vi.fn().mockResolvedValue(staleSqliteData);
      __mobileStorageTestUtils.setSqliteStateForTests({
        adapter: { saveTask: sqliteAdapterSaveTask, getData: sqliteAdapterGetData } as never,
        client: {},
      });

      const data = await mobileStorage.getData();

      expect(data).toEqual(jsonBackup);
      expect(sqliteAdapterGetData).not.toHaveBeenCalled();
      await __mobileStorageTestUtils.flushPendingStartupJsonBackup();
      expect(stored.get('mindwtr-data')).toBe(JSON.stringify(jsonBackup));
    }, 10_000);

    it('falls through to the SQLite read and skips scheduling a backup write when the marker is set but the JSON backup is unusable (#975)', async () => {
      const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
      const makeHugeTask = (id: string): Task => ({
        id,
        title: `Task ${id} ${'padding '.repeat(20)}`,
        status: 'next',
        tags: [],
        contexts: [],
        createdAt: '2026-07-29T00:00:00.000Z',
        updatedAt: '2026-07-29T00:00:00.000Z',
      });
      const hugeSnapshot: AppData = {
        ...jsonBackup,
        tasks: Array.from({ length: 6_000 }, (_, index) => makeHugeTask(`task-${index}`)),
      };
      expect(JSON.stringify(hugeSnapshot).length).toBeGreaterThan(1_500_000);

      const stored = new Map<string, string>();
      asyncStorageMock.getItem.mockImplementation(async (key: string) => stored.get(key) ?? null);
      asyncStorageMock.setItem.mockImplementation(async (key: string, value: string) => {
        stored.set(key, value);
      });

      __mobileStorageTestUtils.setSqliteInitializerForTests(() => Promise.reject(new Error('disk I/O error')));
      // SQLite refuses the write; the fallback backup is too large for Android's
      // AsyncStorage to read back, so the marker ends up set with an unusable backup.
      await expect(mobileStorage.saveData(hugeSnapshot)).rejects.toThrow('too large for the JSON backup');
      expect(stored.has('mindwtr-data')).toBe(false);

      const sqliteAdapterGetData = vi.fn().mockResolvedValue(staleSqliteData);
      __mobileStorageTestUtils.setSqliteStateForTests({
        adapter: { saveTask: sqliteAdapterSaveTask, getData: sqliteAdapterGetData } as never,
        client: {},
      });

      const data = await mobileStorage.getData();

      expect(data).toEqual(staleSqliteData);
      expect(sqliteAdapterGetData).toHaveBeenCalledTimes(1);
      await __mobileStorageTestUtils.flushPendingStartupJsonBackup();
      expect(stored.has('mindwtr-data')).toBe(false);
    }, 20_000);

    it('recoverJsonAheadWrites keeps the marker and rethrows on a transient AsyncStorage read error, but still clears it when the backup is absent (#975)', async () => {
      const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
      const adapter = { getData: vi.fn(), saveData: vi.fn() } as any;

      // Prime the in-memory marker the same way the app does: a real failed
      // saveData that falls back to the JSON backup.
      __mobileStorageTestUtils.setSqliteInitializerForTests(() => Promise.reject(new Error('disk I/O error')));
      await mobileStorage.saveData(jsonBackup);
      expect(asyncStorageMock.setItem).toHaveBeenCalledWith('mindwtr-data:json-ahead-of-sqlite', '1');

      // Transient read error: keep the marker and propagate so init fails loudly.
      asyncStorageMock.getItem.mockImplementation((key: string) => (
        key === 'mindwtr-data'
          ? Promise.reject(new Error('AsyncStorage getItem failed: I/O error'))
          : Promise.resolve(null)
      ));

      await expect(__mobileStorageTestUtils.recoverJsonAheadWritesForTests(adapter))
        .rejects.toThrow('AsyncStorage getItem failed');
      expect(asyncStorageMock.removeItem).not.toHaveBeenCalledWith('mindwtr-data:json-ahead-of-sqlite');
      expect(adapter.getData).not.toHaveBeenCalled();
      expect(adapter.saveData).not.toHaveBeenCalled();

      // Pin the existing predicate: an absent backup still clears the marker.
      asyncStorageMock.removeItem.mockClear();
      asyncStorageMock.getItem.mockResolvedValue(null);

      await __mobileStorageTestUtils.recoverJsonAheadWritesForTests(adapter);
      expect(asyncStorageMock.removeItem).toHaveBeenCalledWith('mindwtr-data:json-ahead-of-sqlite');
      expect(adapter.saveData).not.toHaveBeenCalled();
    }, 10_000);

    it('recoverJsonAheadWrites keeps acknowledged recovery intent across repeated transient read failures (#975)', async () => {
      const { __mobileStorageTestUtils, stored, dataKeyError } = await primeJsonAheadMarker();
      const adapter = { getData: vi.fn(), saveData: vi.fn() } as any;
      dataKeyError.current = new Error('AsyncStorage getItem failed: I/O error');

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(__mobileStorageTestUtils.recoverJsonAheadWritesForTests(adapter))
          .rejects.toThrow('AsyncStorage getItem failed');
        expect(stored.get('mindwtr-data:json-ahead-of-sqlite')).toBe('1');
      }
      expect(adapter.getData).not.toHaveBeenCalled();
      expect(adapter.saveData).not.toHaveBeenCalled();
    }, 10_000);

    it('quarantines SQLite writes when the persisted JSON-ahead marker cannot be read (#975)', async () => {
      const markerReadError = new Error('AsyncStorage marker read failed');
      asyncStorageMock.getItem.mockImplementation((key: string) => (
        key === 'mindwtr-data:json-ahead-of-sqlite'
          ? Promise.reject(markerReadError)
          : Promise.resolve(null)
      ));
      const adapter = {
        getData: vi.fn().mockResolvedValue(staleSqliteData),
        saveData: vi.fn().mockResolvedValue(undefined),
      } as any;
      const client = { get: vi.fn().mockResolvedValue({ count: 1 }) } as any;
      const { __mobileStorageTestUtils } = await import('./storage-adapter');

      await expect(__mobileStorageTestUtils.prepareSqliteStateForTests(adapter, client))
        .resolves.toMatchObject({ writeBlockedReason: 'json-ahead-recovery-read' });

      expect(adapter.getData).not.toHaveBeenCalled();
      expect(adapter.saveData).not.toHaveBeenCalled();
      expect(asyncStorageMock.setItem).not.toHaveBeenCalled();
    }, 10_000);

    it('requires a canonical SQLite reload after marker-unknown quarantine even when no marker exists (#975)', async () => {
      vi.useFakeTimers();
      try {
        const staleJsonData: AppData = {
          ...jsonBackup,
          settings: { theme: 'light' },
        };
        const newerSqliteData: AppData = {
          ...jsonBackup,
          tasks: [{
            ...backupTask,
            title: 'Newer SQLite task',
            updatedAt: '2026-07-30T00:00:00.000Z',
            rev: 2,
          }],
          settings: { theme: 'dark' },
        };
        let sqliteData = newerSqliteData;
        let markerReadFails = true;
        const stored = new Map<string, string>([
          ['mindwtr-data', JSON.stringify(staleJsonData)],
          ['mindwtr-data:sqlite-json-reconcile-v1', '1'],
        ]);
        asyncStorageMock.getItem.mockImplementation(async (key: string) => {
          if (key === 'mindwtr-data:json-ahead-of-sqlite' && markerReadFails) {
            throw new Error('AsyncStorage marker read failed');
          }
          return stored.get(key) ?? null;
        });
        asyncStorageMock.setItem.mockImplementation(async (key: string, value: string) => {
          stored.set(key, value);
        });
        asyncStorageMock.removeItem.mockImplementation(async (key: string) => {
          stored.delete(key);
        });
        const adapter = {
          getData: vi.fn().mockImplementation(async () => sqliteData),
          saveData: vi.fn().mockImplementation(async (data: AppData) => {
            sqliteData = data;
          }),
          saveTask: vi.fn().mockResolvedValue(undefined),
        } as any;
        const client = { get: vi.fn().mockResolvedValue({ count: 1 }) } as any;
        const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
        __mobileStorageTestUtils.setSqliteInitializerForTests(() => (
          __mobileStorageTestUtils.prepareSqliteStateForTests(adapter, client)
        ));

        await expect(mobileStorage.getData()).resolves.toEqual(newerSqliteData);
        // The unknown marker sets conservative JSON read authority until retry,
        // so this second read demonstrates the stale snapshot that must not save.
        const staleRead = await mobileStorage.getData();
        expect(staleRead).toEqual(staleJsonData);

        markerReadFails = false;
        vi.setSystemTime(Date.now() + 60_000);
        await expect(mobileStorage.saveData(staleRead))
          .rejects.toThrow('Reload Mindwtr before saving again');
        expect(adapter.saveData).not.toHaveBeenCalled();
        expect(sqliteData).toEqual(newerSqliteData);

        // A background sync read is canonical, but it did not replace the
        // foreground store snapshot and therefore must not release the barrier.
        const backgroundCanonical = await mobileStorage.getData();
        expect(backgroundCanonical).toEqual(newerSqliteData);
        const structurallyEqualClone = { ...backgroundCanonical };
        expect(structurallyEqualClone).toEqual(backgroundCanonical);
        mobileStorage.acknowledgeDataLoad?.(structurallyEqualClone);
        await expect(mobileStorage.saveData(staleRead))
          .rejects.toThrow('Reload Mindwtr before saving again');
        expect(adapter.saveData).not.toHaveBeenCalled();

        const canonical = await mobileStorage.getData();
        expect(canonical).toEqual(newerSqliteData);
        const { acknowledgeDataLoad } = mobileStorage;
        expect(acknowledgeDataLoad).toBeTypeOf('function');
        const staleSaveQueuedBeforeAcknowledgement = mobileStorage.saveData(staleRead);
        acknowledgeDataLoad?.(canonical);
        await expect(staleSaveQueuedBeforeAcknowledgement)
          .rejects.toThrow('Reload Mindwtr before saving again');
        expect(adapter.saveData).not.toHaveBeenCalled();
        await mobileStorage.saveData(canonical);
        expect(adapter.saveData).toHaveBeenCalledTimes(1);
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    }, 10_000);

    it('serves stale SQLite read-only while a transient JSON-ahead recovery read failure is quarantined (#975)', async () => {
      vi.useFakeTimers();
      try {
        const { mobileStorage, __mobileStorageTestUtils, stored, dataKeyError } = await primeJsonAheadMarker();
        if (!mobileStorage.saveTask) {
          throw new Error('Expected mobile storage to support saveTask');
        }
        const recoveryBackup: AppData = {
          ...jsonBackup,
          settings: { theme: 'dark' },
        };
        stored.set('mindwtr-data', JSON.stringify(recoveryBackup));
        const pendingBackup = stored.get('mindwtr-data');
        const replacementSnapshot: AppData = {
          ...staleSqliteData,
          tasks: [{ ...backupTask, id: 'task-replacement', title: 'Must not replace pending backup' }],
        };
        let sqliteData = staleSqliteData;
        const adapter = {
          getData: vi.fn().mockImplementation(async () => sqliteData),
          saveData: vi.fn().mockImplementation(async (data: AppData) => {
            sqliteData = data;
          }),
          saveTask: vi.fn().mockResolvedValue(undefined),
        } as any;
        const client = { get: vi.fn().mockResolvedValue({ count: 1 }) } as any;
        // Keep the test focused on JSON-ahead recovery, not the older one-time
        // rc.1 reconciliation pass that follows ordinary SQLite initialization.
        stored.set('mindwtr-data:sqlite-json-reconcile-v1', '1');
        dataKeyError.current = new Error('AsyncStorage getItem failed: I/O error');
        asyncStorageMock.setItem.mockClear();
        asyncStorageMock.removeItem.mockClear();
        __mobileStorageTestUtils.setSqliteInitializerForTests(() => (
          __mobileStorageTestUtils.prepareSqliteStateForTests(adapter, client)
        ));

        await expect(mobileStorage.getData()).resolves.toEqual(staleSqliteData);
        await expect(mobileStorage.saveData(replacementSnapshot))
          .rejects.toThrow('Saving is temporarily disabled');
        await expect(mobileStorage.saveTask(replacementSnapshot.tasks[0], replacementSnapshot))
          .rejects.toThrow('Saving is temporarily disabled');

        expect(adapter.getData).toHaveBeenCalledTimes(1);
        expect(adapter.saveData).not.toHaveBeenCalled();
        expect(adapter.saveTask).not.toHaveBeenCalled();
        expect(asyncStorageMock.setItem).not.toHaveBeenCalled();
        expect(stored.get('mindwtr-data')).toBe(pendingBackup);
        expect(stored.get('mindwtr-data:json-ahead-of-sqlite')).toBe('1');

        dataKeyError.current = null;
        await vi.advanceTimersByTimeAsync(60_000);
        await expect(mobileStorage.saveData(replacementSnapshot))
          .rejects.toThrow('Reload Mindwtr before saving again');

        // Recovery itself landed, but the stale snapshot that triggered it was
        // refused. Otherwise SqliteAdapter would treat the newly recovered row
        // as an observed omission and delete it immediately.
        expect(adapter.saveData).toHaveBeenCalledTimes(1);
        expect(adapter.saveData.mock.calls[0][0].tasks.map((task: Task) => task.id)).toEqual([backupTask.id]);
        expect(sqliteData.tasks.map((task) => task.id)).toEqual([backupTask.id]);
        expect(sqliteData.settings).toMatchObject(recoveryBackup.settings);
        expect(stored.has('mindwtr-data:json-ahead-of-sqlite')).toBe(false);
        const markerClearOrder = asyncStorageMock.removeItem.mock.invocationCallOrder[0];
        expect(adapter.saveData.mock.invocationCallOrder[0]).toBeLessThan(markerClearOrder);

        const recovered = await mobileStorage.getData();
        expect(recovered.tasks.map((task) => task.id)).toEqual([backupTask.id]);
        mobileStorage.acknowledgeDataLoad?.(recovered);
        const replacementTask = replacementSnapshot.tasks[0];
        const refreshedSnapshot: AppData = {
          ...recovered,
          tasks: [...recovered.tasks, replacementTask],
        };
        await mobileStorage.saveData(refreshedSnapshot);

        expect(adapter.saveData).toHaveBeenCalledTimes(2);
        expect(adapter.saveData.mock.calls[1][0]).toBe(refreshedSnapshot);
        expect(sqliteData.tasks.map((task) => task.id)).toEqual([backupTask.id, replacementTask.id]);
        expect(sqliteData.settings).toMatchObject(recoveryBackup.settings);
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    }, 10_000);

    it.each([
      ['Row too big to fit into CursorWindow'],
      ['Cursor window allocation of 2048 kb failed'],
    ])('recoverJsonAheadWrites clears the marker on a permanent read error: %s (#975)', async (message) => {
      const { __mobileStorageTestUtils, stored, dataKeyError } = await primeJsonAheadMarker();
      const adapter = { getData: vi.fn(), saveData: vi.fn() } as any;
      dataKeyError.current = new Error(message);

      await __mobileStorageTestUtils.recoverJsonAheadWritesForTests(adapter);

      expect(stored.has('mindwtr-data:json-ahead-of-sqlite')).toBe(false);
      expect(adapter.getData).not.toHaveBeenCalled();
      expect(adapter.saveData).not.toHaveBeenCalled();
    }, 10_000);

    it('recoverJsonAheadWrites clears the marker when the backup is corrupt JSON', async () => {
      const { __mobileStorageTestUtils, stored } = await primeJsonAheadMarker();
      const adapter = { getData: vi.fn(), saveData: vi.fn() } as any;
      stored.set('mindwtr-data', '{ not valid json');

      await __mobileStorageTestUtils.recoverJsonAheadWritesForTests(adapter);

      expect(stored.has('mindwtr-data:json-ahead-of-sqlite')).toBe(false);
      expect(adapter.getData).not.toHaveBeenCalled();
      expect(adapter.saveData).not.toHaveBeenCalled();
    }, 10_000);

    // Review finding 2: an absent backup key must fall through to the SQLite
    // read (SQLite is healthy here), not resolve as an empty library — the
    // store would otherwise treat that as a fresh install and save emptiness
    // over a healthy database.
    it('getData falls through to the SQLite read, never empty data, when the marker is set but the backup key is absent (#975)', async () => {
      const { mobileStorage, __mobileStorageTestUtils, stored } = await primeJsonAheadMarker();
      // Simulate the marker surviving without a backup behind it (e.g. the
      // marker write landed but the backup write that should have followed
      // did not).
      stored.delete('mindwtr-data');

      const sqliteAdapterGetData = vi.fn().mockResolvedValue(staleSqliteData);
      __mobileStorageTestUtils.setSqliteStateForTests({
        adapter: { saveTask: sqliteAdapterSaveTask, getData: sqliteAdapterGetData } as never,
        client: {},
      });

      const data = await mobileStorage.getData();

      expect(data).toEqual(staleSqliteData);
      expect(sqliteAdapterGetData).toHaveBeenCalledTimes(1);
    }, 10_000);

    // Review Q6: queryTasks/searchAll must not read SQLite directly while the
    // marker is set, since that bypasses getData()'s read-authority guard.
    it('queryTasks and searchAll serve the JSON backup instead of a direct SQLite query while the marker is set (#975)', async () => {
      const { mobileStorage, __mobileStorageTestUtils } = await primeJsonAheadMarker();
      if (!mobileStorage.queryTasks || !mobileStorage.searchAll) {
        throw new Error('Expected mobile storage to support queryTasks and searchAll');
      }
      const sqliteAdapterQueryTasks = vi.fn().mockResolvedValue([staleSqliteData]);
      const sqliteAdapterSearchAll = vi.fn().mockResolvedValue([]);
      __mobileStorageTestUtils.setSqliteStateForTests({
        adapter: {
          saveTask: sqliteAdapterSaveTask,
          queryTasks: sqliteAdapterQueryTasks,
          searchAll: sqliteAdapterSearchAll,
        } as never,
        client: {},
      });

      const tasks = await mobileStorage.queryTasks({});
      const searchResults = await mobileStorage.searchAll('Written');

      expect(tasks.map((task) => task.id)).toEqual([backupTask.id]);
      expect(searchResults.tasks.some((task) => task.id === backupTask.id)).toBe(true);
      expect(sqliteAdapterQueryTasks).not.toHaveBeenCalled();
      expect(sqliteAdapterSearchAll).not.toHaveBeenCalled();
    }, 10_000);
  });
});
