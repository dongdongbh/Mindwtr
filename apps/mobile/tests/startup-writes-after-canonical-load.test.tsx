import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import React, { useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_POMODORO_DURATIONS,
  getPomodoroLocalDayKey,
  resetForTests as resetCoreForTests,
  setStorageAdapter,
  useTaskStore,
  type AppData,
  type StorageAdapter,
  type Task,
} from '@mindwtr/core';


const QUEUE_DIR = 'file:///docs/pending-captures';
const CAPTURE_FILE = `${QUEUE_DIR}/17.json`;

const mocks = vi.hoisted(() => ({
  files: new Map<string, string>(),
  getMobileStartupSnapshotFromBackup: vi.fn<() => Promise<unknown>>(),
  logInfo: vi.fn(async () => undefined),
  requestSync: vi.fn(),
}));

vi.mock('react-native', async () => {
  const actual = await vi.importActual<typeof import('react-native')>('react-native');
  return {
    ...actual,
    Alert: { alert: vi.fn() },
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
  };
});
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined) },
}));
vi.mock('@/lib/file-system', () => ({
  documentDirectory: 'file:///docs/',
  getInfoAsync: vi.fn(async () => ({ exists: true })),
  readDirectoryAsync: vi.fn(async () => [...mocks.files.keys()].map((uri) => uri.slice(QUEUE_DIR.length + 1))),
  readAsStringAsync: vi.fn(async (uri: string) => {
    const content = mocks.files.get(uri);
    if (content === undefined) throw new Error('missing file');
    return content;
  }),
  deleteAsync: vi.fn(async (uri: string) => { mocks.files.delete(uri); }),
}));
vi.mock('@/lib/storage-adapter', () => ({
  getMobileStartupSnapshotFromBackup: mocks.getMobileStartupSnapshotFromBackup,
  mobileStorage: {},
}));
vi.mock('@/lib/app-log', () => ({
  logError: vi.fn(async () => undefined),
  logInfo: mocks.logInfo,
  logWarn: vi.fn(async () => undefined),
}));
vi.mock('@/lib/startup-profiler', () => ({
  markStartupPhase: vi.fn(),
  measureStartupPhase: async (_name: string, fn: () => unknown) => await fn(),
}));
vi.mock('@/lib/analytics-heartbeat', () => ({
  getMobileStartupAnalyticsContext: vi.fn(async () => ({})),
  sendMobileDailyHeartbeat: vi.fn(async () => undefined),
}));
vi.mock('@/lib/notification-service', () => ({ startMobileNotifications: vi.fn(async () => undefined) }));
vi.mock('@/lib/widget-service', () => ({ updateMobileWidgetFromStore: vi.fn(async () => true) }));
vi.mock('@/lib/cloudkit-sync', () => ({ isCloudKitAvailable: () => false }));
vi.mock('@/lib/sync-service-utils', () => ({
  coerceSupportedBackend: (backend: string | null) => backend ?? 'off',
  resolveBackend: (backend: string | null) => backend ?? 'off',
}));
vi.mock('@/lib/sync-constants', () => ({ SYNC_BACKEND_KEY: 'sync-backend' }));
vi.mock('@/utils/verify-polyfills', () => ({ verifyPolyfills: vi.fn() }));
vi.mock('@/lib/ios-widget-completions', () => ({ ingestIosWidgetCompletions: vi.fn(async () => 0) }));
vi.mock('@/modules/ios-widget', () => ({ getNextPendingCompletionAt: vi.fn(async () => null) }));
vi.mock('@/lib/watch-audio', () => ({ transcribePendingAudio: vi.fn() }));

// eslint-disable-next-line import/first
import { useRootLayoutPendingCaptures } from '@/hooks/root-layout/use-root-layout-pending-captures';
// eslint-disable-next-line import/first
import { useRootLayoutStartup } from '@/hooks/root-layout/use-root-layout-startup';
// eslint-disable-next-line import/first
import { createMobilePomodoroController } from '@/lib/pomodoro-controller';

const RELEASE_CHECK = 'v1.3.3/mobile-startup-writes-after-canonical-load';

const task = (id: string): Task => ({
  id,
  title: `Task ${id}`,
  status: 'inbox',
  tags: [],
  contexts: [],
  rev: 1,
  createdAt: '2026-09-22T10:00:00.000Z',
  updatedAt: '2026-09-22T10:00:00.000Z',
} as Task);

const document = (tasks: Task[]): AppData => ({
  tasks,
  projects: [],
  sections: [],
  areas: [],
  people: [],
  settings: {},
});

const taskIds = () => useTaskStore.getState()._allTasks.map(({ id }) => id);
const storedTask = (id: string) => useTaskStore.getState()._allTasks.find((row) => row.id === id);
const capturedTasks = (tasks: Task[]) => tasks.filter(({ title }) => title === 'Queued capture');

const readiness = {
  dataReady: false,
  canonicalDataReady: false,

  tasksWhenCanonical: null as Task[] | null,
};


function RootLayoutStartupHarness() {
  const { dataReady, canonicalDataReady } = useRootLayoutStartup({
    analyticsHeartbeatUrl: '',
    appVersion: '1.3.3',
    isExpoGo: false,
    isFossBuild: false,
    requestSync: mocks.requestSync,
    storageInitError: null,
  });
  useRootLayoutPendingCaptures({ canonicalDataReady });
  useEffect(() => {
    readiness.dataReady = dataReady;
    readiness.canonicalDataReady = canonicalDataReady;
    if (canonicalDataReady && !readiness.tasksWhenCanonical) {
      readiness.tasksWhenCanonical = structuredClone(useTaskStore.getState()._allTasks);
    }
  }, [canonicalDataReady, dataReady]);
  return null;
}

describe('startup store writes wait for the canonical SQLite load', () => {

  let sqliteRows: Map<string, Task>;
  let firstRead!: { release: () => void; fail: (error: Error) => void };
  let storage: StorageAdapter & {
    getData: ReturnType<typeof vi.fn>;
    saveData: ReturnType<typeof vi.fn>;
    saveTask: ReturnType<typeof vi.fn>;
  };
  let tree: ReactTestRenderer | null = null;

  beforeEach(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = false;
    vi.clearAllMocks();
    resetCoreForTests();
    readiness.dataReady = false;
    readiness.canonicalDataReady = false;
    readiness.tasksWhenCanonical = null;
    useTaskStore.setState({
      settings: {},
      error: null,
      persistenceFailure: null,
      lastDataChangeAt: 0,
      _allTasks: [],
      _allProjects: [],
      _allSections: [],
      _allAreas: [],
      _allPeople: [],
    });
    sqliteRows = new Map([task('11'), task('18')].map((row) => [row.id, row]));
    const firstReadGate = new Promise<void>((release, fail) => { firstRead = { release, fail }; });
    storage = {


      getData: vi.fn(async () => {
        const rows = [...sqliteRows.values()].map((row) => structuredClone(row));
        if (storage.getData.mock.calls.length === 1) await firstReadGate;
        return document(rows);
      }),
      saveTask: vi.fn(async (row: Task) => { sqliteRows.set(row.id, structuredClone(row)); }),
      saveData: vi.fn(async (data: AppData) => {
        data.tasks.forEach((row) => sqliteRows.set(row.id, structuredClone(row)));
      }),
    };
    setStorageAdapter(storage);
    mocks.files.clear();
    mocks.files.set(CAPTURE_FILE, JSON.stringify({ id: '17', title: 'Queued capture' }));
    mocks.getMobileStartupSnapshotFromBackup.mockResolvedValue(document([task('11')]));
  });

  afterEach(() => {
    if (tree) act(() => tree?.unmount());
    tree = null;
    resetCoreForTests();
  });

  const startApp = async () => {
    await act(async () => {
      tree = create(<RootLayoutStartupHarness />);
    });

    await vi.waitFor(() => expect(readiness.dataReady).toBe(true));
    expect(readiness.canonicalDataReady).toBe(false);
    expect(taskIds()).toEqual(['11']);
  };

  const finishFirstRead = async () => {
    await act(async () => { firstRead.release(); });
    await vi.waitFor(() => expect(readiness.canonicalDataReady).toBe(true));
  };

  it('keeps the SQLite-only task and ingests the queued capture exactly once', async () => {
    await startApp();

    expect(mocks.files.has(CAPTURE_FILE)).toBe(true);
    expect(capturedTasks(useTaskStore.getState()._allTasks)).toHaveLength(0);

    await finishFirstRead();
    await vi.waitFor(() => expect(mocks.files.has(CAPTURE_FILE)).toBe(false));


    expect(storage.getData).toHaveBeenCalledOnce();
    expect(readiness.tasksWhenCanonical?.map(({ id }) => id)).toEqual(expect.arrayContaining(['11', '18']));
    expect(taskIds()).toEqual(expect.arrayContaining(['11', '18']));
    expect(capturedTasks(useTaskStore.getState()._allTasks)).toHaveLength(1);

    const saved = storage.saveData.mock.calls.at(-1)?.[0] as AppData;
    expect(saved.tasks.map(({ id }) => id)).toEqual(expect.arrayContaining(['11', '18']));
    expect(capturedTasks(saved.tasks)).toHaveLength(1);
    expect(mocks.logInfo).toHaveBeenCalledWith('Startup capture drain ran after canonical data load', {
      scope: 'capture',
      extra: { releaseCheck: RELEASE_CHECK, elapsedMs: expect.any(Number), count: 1 },
    });
  });

  it('never drains into the snapshot when the canonical load fails', async () => {
    await startApp();

    await act(async () => {
      firstRead.fail(new Error('SQLite unavailable'));
    });
    await vi.waitFor(() => expect(useTaskStore.getState().error).toBeTruthy());

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    expect(readiness.canonicalDataReady).toBe(false);
    expect(mocks.files.get(CAPTURE_FILE)).toBeDefined();
    expect(capturedTasks(useTaskStore.getState()._allTasks)).toHaveLength(0);
    expect(storage.saveData).not.toHaveBeenCalled();
    expect(storage.saveTask).not.toHaveBeenCalled();
  });


  it('re-fetches after a snapshot-window edit and keeps the edit and the SQLite-only task', async () => {
    await startApp();
    await act(async () => {
      await useTaskStore.getState().updateTask('11', { title: 'Edited on the snapshot' });
    });

    await finishFirstRead();

    expect(storage.getData).toHaveBeenCalledTimes(2);
    const whenReady = readiness.tasksWhenCanonical ?? [];
    expect(whenReady.map(({ id }) => id)).toEqual(expect.arrayContaining(['11', '18']));
    expect(whenReady.find(({ id }) => id === '11')?.title).toBe('Edited on the snapshot');
    expect(storedTask('18')).toBeDefined();
    expect(storedTask('11')?.title).toBe('Edited on the snapshot');
    expect(mocks.logInfo).toHaveBeenCalledWith('Canonical data re-fetched after a local change', {
      scope: 'startup',
      extra: { releaseCheck: RELEASE_CHECK, retryCount: 1, outcome: 'applied' },
    });

    await vi.waitFor(() => expect(mocks.files.has(CAPTURE_FILE)).toBe(false));
    expect(capturedTasks(useTaskStore.getState()._allTasks)).toHaveLength(1);
    expect(storedTask('18')).toBeDefined();
  });


  it('re-fetches after the Pomodoro panel credits a session on the snapshot', async () => {
    await startApp();
    const controller = createMobilePomodoroController({
      storage: {
        getItem: async () => JSON.stringify({
          durations: DEFAULT_POMODORO_DURATIONS,
          timerState: { phase: 'focus', remainingSeconds: 1, isRunning: true, completedFocusSessions: 0 },
          selectedTaskId: '11',
          phaseEndsAt: new Date(Date.now() - 1_000).toISOString(),
          sessionHistory: {
            totalCompletedFocusSessions: 0,
            completedFocusSessionsByTaskId: {},
            todayDayKey: getPomodoroLocalDayKey(Date.now()),
            completedTodayFocusSessions: 0,
          },
        }),
        setItem: async () => undefined,
      },
    });
    await act(async () => { await controller.ensureHydrated(); });
    await vi.waitFor(() => expect(storedTask('11')?.timeSpentMinutes).toBe(DEFAULT_POMODORO_DURATIONS.focusMinutes));

    await finishFirstRead();

    expect(storage.getData).toHaveBeenCalledTimes(2);
    const whenReady = readiness.tasksWhenCanonical ?? [];
    expect(whenReady.map(({ id }) => id)).toEqual(expect.arrayContaining(['11', '18']));
    expect(whenReady.find(({ id }) => id === '11')?.timeSpentMinutes).toBe(DEFAULT_POMODORO_DURATIONS.focusMinutes);
    expect(storedTask('18')).toBeDefined();
  });
});

describe('root layout wiring', () => {


  it('gates every startup store writer on canonical data', () => {
    const layout = readFileSync(new URL('../app/_layout.tsx', import.meta.url), 'utf8');
    for (const hook of [
      'useRootLayoutContextAutomation',
      'useRootLayoutExternalCapture',
      'useRootLayoutPomodoro',
      'useRootLayoutPendingCaptures',
      'useRootLayoutAppleRemindersAutoImport',
      'useRootLayoutWatch',
    ]) {
      expect(layout).toMatch(new RegExp(`${hook}\\(\\{\\s*canonicalDataReady,`));
    }
    expect(layout).toMatch(/useRootLayoutNotificationOpenHandler\(\{[^}]*appReady: isFirstPaintReady && canonicalDataReady,/);
  });
});
