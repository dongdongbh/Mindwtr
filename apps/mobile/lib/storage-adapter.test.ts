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

  it('logs the archive metadata release proof only after a successful SQLite load', async () => {
    const now = '2026-09-05T12:00:00.000Z';
    const sqliteData: AppData = {
      tasks: [makeWidgetTask('task-sqlite-proof')],
      projects: [{
        id: 'project-sqlite-proof',
        title: 'SQLite project',
        status: 'active',
        color: '#6B7280',
        order: 0,
        tagIds: [],
        createdAt: now,
        updatedAt: now,
      }],
      sections: [{
        id: 'section-sqlite-proof',
        projectId: 'project-sqlite-proof',
        title: 'SQLite section',
        order: 0,
        isCollapsed: false,
        createdAt: now,
        updatedAt: now,
      }],
      areas: [],
      people: [],
      settings: {},
    };
    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    __mobileStorageTestUtils.setSqliteStateForTests({
      adapter: { getData: vi.fn().mockResolvedValue(sqliteData), saveTask: vi.fn() },
      client: {},
    });

    await expect(mobileStorage.getData()).resolves.toBe(sqliteData);

    expect(logInfoMock).toHaveBeenCalledWith(
      'SQLite project archive metadata loaded in canonical form',
      {
        scope: 'storage',
        extra: {
          releaseCheck: 'v1.2.8/archive-metadata-canonical',
          count: '2',
        },
      },
    );
  });

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

  it('writes and trusts an oversized JSON backup on iOS, where it is the only fallback when SQLite fails (#979)', async () => {
    mockPlatformOS.value = 'ios';
    const stored = new Map<string, string>();
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
