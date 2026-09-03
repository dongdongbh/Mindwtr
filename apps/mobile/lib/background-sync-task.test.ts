import { beforeEach, describe, expect, it, vi } from 'vitest';

const backgroundTaskMock = vi.hoisted(() => ({
  BackgroundTaskResult: {
    Success: 1,
    Failed: 2,
  },
  BackgroundTaskStatus: {
    Restricted: 1,
    Available: 2,
  },
  getStatusAsync: vi.fn(),
  registerTaskAsync: vi.fn(),
  unregisterTaskAsync: vi.fn(),
}));

const taskManagerMock = vi.hoisted(() => {
  const state = {
    executor: null as null | (() => Promise<number>),
  };
  return {
    state,
    defineTask: vi.fn((_name: string, executor: () => Promise<number>) => {
      state.executor = executor;
    }),
    isAvailableAsync: vi.fn(),
    isTaskDefined: vi.fn(),
    isTaskRegisteredAsync: vi.fn(),
  };
});

const coreMock = vi.hoisted(() => ({
  flushPendingSave: vi.fn(),
}));

const syncServiceMock = vi.hoisted(() => ({
  abortMobileSync: vi.fn(),
  setMobileSyncRequestDeadline: vi.fn(),
  getMobileSyncConfigurationStatus: vi.fn(),
  performMobileSync: vi.fn(),
}));

const storageAdapterMock = vi.hoisted(() => ({
  quiesceMobileStorage: vi.fn(),
}));

const asyncStorageMock = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
});

vi.mock('expo-background-task', () => backgroundTaskMock);
vi.mock('expo-task-manager', () => taskManagerMock);
vi.mock('@mindwtr/core', () => coreMock);
vi.mock('./sync-service', () => syncServiceMock);
vi.mock('./storage-adapter', () => storageAdapterMock);
vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorageMock }));
vi.mock('./sync-service-utils', () => ({
  isRemoteSyncBackend: (backend: string) => backend === 'webdav' || backend === 'cloud',
}));
const appLogMock = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock('./app-log', () => appLogMock);
vi.mock('./js-timers', () => ({ areJsTimersPaused: vi.fn(() => true) }));
const reactNativeMock = vi.hoisted(() => ({ AppState: { currentState: 'active' as string } }));
vi.mock('react-native', () => reactNativeMock);

const loadModule = async () => import('./background-sync-task');

describe('mobile background sync task', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    taskManagerMock.state.executor = null;
    reactNativeMock.AppState.currentState = 'active';
    taskManagerMock.isTaskDefined.mockReturnValue(false);
    taskManagerMock.isAvailableAsync.mockResolvedValue(true);
    taskManagerMock.isTaskRegisteredAsync.mockResolvedValue(false);
    backgroundTaskMock.getStatusAsync.mockResolvedValue(backgroundTaskMock.BackgroundTaskStatus.Available);
    backgroundTaskMock.registerTaskAsync.mockResolvedValue(undefined);
    backgroundTaskMock.unregisterTaskAsync.mockResolvedValue(undefined);
    coreMock.flushPendingSave.mockResolvedValue(undefined);
    syncServiceMock.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'off', configured: false });
    syncServiceMock.performMobileSync.mockResolvedValue({ success: true });
    storageAdapterMock.quiesceMobileStorage.mockResolvedValue(undefined);
    asyncStorageMock.store.clear();
    asyncStorageMock.getItem.mockClear();
    asyncStorageMock.setItem.mockClear();
    asyncStorageMock.removeItem.mockClear();
  });

  const createDeferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolveFn) => {
      resolve = resolveFn;
    });
    return { promise, resolve };
  };

  it('registers the task for configured remote sync backends', async () => {
    syncServiceMock.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'webdav', configured: true });

    const module = await loadModule();
    const result = await module.syncMobileBackgroundSyncRegistration();

    expect(backgroundTaskMock.registerTaskAsync).toHaveBeenCalledWith(module.MOBILE_BACKGROUND_SYNC_TASK_NAME, {
      minimumInterval: module.MOBILE_BACKGROUND_SYNC_MINIMUM_INTERVAL_MINUTES,
    });
    expect(backgroundTaskMock.unregisterTaskAsync).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      action: 'registered',
      available: true,
      backend: 'webdav',
      configured: true,
      registered: true,
    });
  });

  it('leaves an already live registration alone so a mid-run worker is not cancelled', async () => {
    syncServiceMock.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'webdav', configured: true });
    taskManagerMock.isTaskRegisteredAsync.mockResolvedValue(true);
    const { BACKGROUND_SYNC_LAST_REGISTERED_INTERVAL_KEY } = await import('./sync-constants');
    asyncStorageMock.store.set(BACKGROUND_SYNC_LAST_REGISTERED_INTERVAL_KEY, '15m');

    const module = await loadModule();
    const result = await module.syncMobileBackgroundSyncRegistration();

    expect(backgroundTaskMock.registerTaskAsync).not.toHaveBeenCalled();
    expect(backgroundTaskMock.unregisterTaskAsync).not.toHaveBeenCalled();
    expect(result).toMatchObject({ action: 'unchanged', registered: true, interval: '15m' });
  });

  it('trusts its own registration record off screen so a headless cold start does not cancel the worker that woke it', async () => {
    syncServiceMock.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'webdav', configured: true });
    taskManagerMock.isTaskRegisteredAsync.mockResolvedValue(false);
    const { BACKGROUND_SYNC_LAST_REGISTERED_INTERVAL_KEY } = await import('./sync-constants');
    asyncStorageMock.store.set(BACKGROUND_SYNC_LAST_REGISTERED_INTERVAL_KEY, '15m');
    reactNativeMock.AppState.currentState = 'background';

    const module = await loadModule();
    const deferred = await module.syncMobileBackgroundSyncRegistration();
    expect(backgroundTaskMock.registerTaskAsync).not.toHaveBeenCalled();
    expect(deferred).toMatchObject({ action: 'unchanged', registered: true });
    expect(appLogMock.logInfo).toHaveBeenCalledWith('Mobile background sync registration checked', expect.objectContaining({
      extra: expect.objectContaining({ decision: 'deferred-until-foreground', appState: 'background' }),
    }));

    // On screen the same inputs mean the registration really is gone: register.
    reactNativeMock.AppState.currentState = 'active';
    const registered = await module.syncMobileBackgroundSyncRegistration();
    expect(backgroundTaskMock.registerTaskAsync).toHaveBeenCalledTimes(1);
    expect(registered).toMatchObject({ action: 'registered', registered: true });
  });

  it('unregisters the task when sync is unavailable or unsupported', async () => {
    taskManagerMock.isTaskRegisteredAsync.mockResolvedValue(true);
    syncServiceMock.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'file', configured: true });

    const module = await loadModule();
    const result = await module.syncMobileBackgroundSyncRegistration();

    expect(backgroundTaskMock.registerTaskAsync).not.toHaveBeenCalled();
    expect(backgroundTaskMock.unregisterTaskAsync).toHaveBeenCalledWith(module.MOBILE_BACKGROUND_SYNC_TASK_NAME);
    expect(result).toMatchObject({
      action: 'unregistered',
      backend: 'file',
      registered: false,
    });
  });

  it('skips registration when the platform reports background tasks as restricted', async () => {
    backgroundTaskMock.getStatusAsync.mockResolvedValue(backgroundTaskMock.BackgroundTaskStatus.Restricted);
    syncServiceMock.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'cloud', configured: true });

    const module = await loadModule();
    const result = await module.syncMobileBackgroundSyncRegistration();

    expect(backgroundTaskMock.registerTaskAsync).not.toHaveBeenCalled();
    expect(backgroundTaskMock.unregisterTaskAsync).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      action: 'unchanged',
      available: false,
      backend: 'cloud',
      configured: true,
    });
  });

  it('runs the task body without UI dependencies', async () => {
    syncServiceMock.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'cloudkit', configured: true });
    syncServiceMock.performMobileSync.mockResolvedValue({ success: true });

    await loadModule();
    expect(taskManagerMock.defineTask).toHaveBeenCalledTimes(1);

    const result = await taskManagerMock.state.executor?.();

    expect(coreMock.flushPendingSave).toHaveBeenCalledTimes(1);
    expect(syncServiceMock.performMobileSync).toHaveBeenCalledTimes(1);
    expect(result).toBe(backgroundTaskMock.BackgroundTaskResult.Success);
    // The start/finish pair is the field diagnostic for a run that never settles.
    expect(appLogMock.logInfo).toHaveBeenCalledWith('Mobile background sync started', expect.objectContaining({
      extra: { timersPaused: 'true' },
    }));
    expect(appLogMock.logInfo).toHaveBeenCalledWith('Mobile background sync finished', expect.objectContaining({
      extra: expect.objectContaining({ outcome: 'success' }),
    }));
  });

  it('treats unsupported or unconfigured task runs as a successful no-op', async () => {
    syncServiceMock.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'file', configured: true });

    await loadModule();
    const result = await taskManagerMock.state.executor?.();

    expect(coreMock.flushPendingSave).not.toHaveBeenCalled();
    expect(syncServiceMock.performMobileSync).not.toHaveBeenCalled();
    expect(result).toBe(backgroundTaskMock.BackgroundTaskResult.Success);
  });

  it('returns failed when background sync work fails', async () => {
    syncServiceMock.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'webdav', configured: true });
    syncServiceMock.performMobileSync.mockResolvedValue({ success: false, error: 'auth failed' });

    await loadModule();
    const result = await taskManagerMock.state.executor?.();

    expect(result).toBe(backgroundTaskMock.BackgroundTaskResult.Failed);
  });

  // The task body runs in a headless RN instance that is destroyed as soon as this
  // promise settles. Deferred op-sqlite work left in flight resolves into a freed
  // Hermes heap and kills the process, so quiescing must happen on every exit path.
  it('quiesces deferred storage work on both the success and failure paths', async () => {
    syncServiceMock.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'webdav', configured: true });

    await loadModule();
    await taskManagerMock.state.executor?.();
    expect(storageAdapterMock.quiesceMobileStorage).toHaveBeenCalledTimes(1);

    syncServiceMock.performMobileSync.mockRejectedValue(new Error('network died'));
    const result = await taskManagerMock.state.executor?.();

    expect(result).toBe(backgroundTaskMock.BackgroundTaskResult.Failed);
    expect(storageAdapterMock.quiesceMobileStorage).toHaveBeenCalledTimes(2);
  });

  it('abandons a sync that outlives the job deadline so the job returns before JobScheduler kills it', async () => {
    vi.useFakeTimers();
    try {
      syncServiceMock.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'webdav', configured: true });
      syncServiceMock.performMobileSync.mockImplementation(() => new Promise(() => undefined));

      const module = await loadModule();
      const executor = taskManagerMock.state.executor;
      if (!executor) throw new Error('Expected the background sync task to be defined');

      const run = executor();
      await vi.advanceTimersByTimeAsync(module.MOBILE_BACKGROUND_SYNC_DEADLINE_MS - 1);
      expect(syncServiceMock.abortMobileSync).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(await run).toBe(backgroundTaskMock.BackgroundTaskResult.Failed);
      expect(syncServiceMock.abortMobileSync).toHaveBeenCalledTimes(1);
      expect(storageAdapterMock.quiesceMobileStorage).toHaveBeenCalledTimes(1);
      // A run this long is written even with debug logging off.
      expect(appLogMock.logWarn).toHaveBeenCalledWith('Mobile background sync run took longer than a minute', expect.objectContaining({
        force: true,
        extra: expect.objectContaining({ outcome: 'abandoned' }),
      }));
      // The request deadline is what holds while timers are paused; it must be
      // armed for the run and cleared afterwards.
      const deadlineCalls = syncServiceMock.setMobileSyncRequestDeadline.mock.calls;
      expect(deadlineCalls[0]?.[0]).toBeGreaterThan(Date.now() - 1);
      expect(deadlineCalls.at(-1)?.[0]).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a hung storage quiesce hold the job open either', async () => {
    vi.useFakeTimers();
    try {
      syncServiceMock.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'webdav', configured: true });
      syncServiceMock.performMobileSync.mockResolvedValue({ success: true });
      storageAdapterMock.quiesceMobileStorage.mockImplementation(() => new Promise(() => undefined));

      const module = await loadModule();
      const executor = taskManagerMock.state.executor;
      if (!executor) throw new Error('Expected the background sync task to be defined');

      const run = executor();
      await vi.advanceTimersByTimeAsync(module.MOBILE_BACKGROUND_SYNC_QUIESCE_DEADLINE_MS);

      expect(await run).toBe(backgroundTaskMock.BackgroundTaskResult.Success);
      expect(syncServiceMock.abortMobileSync).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces overlapping invocations into one run without latching', async () => {
    syncServiceMock.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'webdav', configured: true });
    const syncStarted = createDeferred<void>();
    const syncFinished = createDeferred<{ success: boolean }>();
    syncServiceMock.performMobileSync.mockImplementationOnce(() => {
      syncStarted.resolve();
      return syncFinished.promise;
    });

    await loadModule();
    const executor = taskManagerMock.state.executor;
    if (!executor) throw new Error('Expected the background sync task to be defined');

    // expo-background-task delivered three queued events in the same millisecond.
    const overlapping = Promise.all([executor(), executor(), executor()]);
    await syncStarted.promise;
    expect(syncServiceMock.performMobileSync).toHaveBeenCalledTimes(1);

    syncFinished.resolve({ success: true });
    expect(await overlapping).toEqual([
      backgroundTaskMock.BackgroundTaskResult.Success,
      backgroundTaskMock.BackgroundTaskResult.Success,
      backgroundTaskMock.BackgroundTaskResult.Success,
    ]);

    // The guard coalesces concurrent events; it must not block the next window.
    syncServiceMock.performMobileSync.mockResolvedValue({ success: true });
    await executor();
    expect(syncServiceMock.performMobileSync).toHaveBeenCalledTimes(2);
  });

  describe('background sync interval setting', () => {
    it('registers with the stored 1h interval as 60 minutes', async () => {
      syncServiceMock.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'cloud', configured: true });

      const module = await loadModule();
      await module.setMobileBackgroundSyncInterval('1h');
      const result = await module.syncMobileBackgroundSyncRegistration();

      expect(backgroundTaskMock.registerTaskAsync).toHaveBeenCalledWith(module.MOBILE_BACKGROUND_SYNC_TASK_NAME, {
        minimumInterval: 60,
      });
      expect(result).toMatchObject({ action: 'registered', interval: '1h' });
    });

    it('registers with the stored 6h interval as 360 minutes', async () => {
      syncServiceMock.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'cloudkit', configured: true });

      const module = await loadModule();
      await module.setMobileBackgroundSyncInterval('6h');
      const result = await module.syncMobileBackgroundSyncRegistration();

      expect(backgroundTaskMock.registerTaskAsync).toHaveBeenCalledWith(module.MOBILE_BACKGROUND_SYNC_TASK_NAME, {
        minimumInterval: 360,
      });
      expect(result).toMatchObject({ action: 'registered', interval: '6h' });
    });

    it('unregisters when the interval is off even though the backend supports scheduled sync', async () => {
      taskManagerMock.isTaskRegisteredAsync.mockResolvedValue(true);
      syncServiceMock.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'webdav', configured: true });

      const module = await loadModule();
      await module.setMobileBackgroundSyncInterval('off');
      const result = await module.syncMobileBackgroundSyncRegistration();

      expect(backgroundTaskMock.registerTaskAsync).not.toHaveBeenCalled();
      expect(backgroundTaskMock.unregisterTaskAsync).toHaveBeenCalledWith(module.MOBILE_BACKGROUND_SYNC_TASK_NAME);
      expect(result).toMatchObject({ action: 'unregistered', interval: 'off', registered: false });
    });

    it('never registers a File Sync backend regardless of the configured interval', async () => {
      syncServiceMock.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'file', configured: true });

      const module = await loadModule();
      for (const interval of ['15m', '1h', '6h'] as const) {
        await module.setMobileBackgroundSyncInterval(interval);
        const result = await module.syncMobileBackgroundSyncRegistration();
        expect(result.registered).toBe(false);
      }
      expect(backgroundTaskMock.registerTaskAsync).not.toHaveBeenCalled();
    });

    it('re-registers (unregister then register) when the interval changes from 15m to 1h', async () => {
      syncServiceMock.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'webdav', configured: true });
      // Not yet registered on the first reconcile; registered from then on, like a
      // real device after BackgroundTask.registerTaskAsync has actually taken.
      taskManagerMock.isTaskRegisteredAsync.mockResolvedValueOnce(false).mockResolvedValue(true);

      const module = await loadModule();
      await module.setMobileBackgroundSyncInterval('15m');
      const first = await module.syncMobileBackgroundSyncRegistration();
      expect(first).toMatchObject({ action: 'registered', interval: '15m' });
      expect(backgroundTaskMock.registerTaskAsync).toHaveBeenLastCalledWith(module.MOBILE_BACKGROUND_SYNC_TASK_NAME, {
        minimumInterval: 15,
      });

      backgroundTaskMock.registerTaskAsync.mockClear();
      backgroundTaskMock.unregisterTaskAsync.mockClear();
      await module.setMobileBackgroundSyncInterval('1h');
      const second = await module.syncMobileBackgroundSyncRegistration();

      expect(backgroundTaskMock.unregisterTaskAsync).toHaveBeenCalledWith(module.MOBILE_BACKGROUND_SYNC_TASK_NAME);
      expect(backgroundTaskMock.registerTaskAsync).toHaveBeenCalledWith(module.MOBILE_BACKGROUND_SYNC_TASK_NAME, {
        minimumInterval: 60,
      });
      expect(second).toMatchObject({ action: 'registered', interval: '1h' });
    });

    it('does not unregister-then-register again when reconciling with an unchanged interval', async () => {
      syncServiceMock.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'webdav', configured: true });
      taskManagerMock.isTaskRegisteredAsync.mockResolvedValueOnce(false).mockResolvedValue(true);

      const module = await loadModule();
      await module.setMobileBackgroundSyncInterval('15m');
      await module.syncMobileBackgroundSyncRegistration();

      backgroundTaskMock.registerTaskAsync.mockClear();
      backgroundTaskMock.unregisterTaskAsync.mockClear();
      const second = await module.syncMobileBackgroundSyncRegistration();

      expect(backgroundTaskMock.unregisterTaskAsync).not.toHaveBeenCalled();
      expect(second).toMatchObject({ action: 'unchanged', interval: '15m' });
    });
  });
});
