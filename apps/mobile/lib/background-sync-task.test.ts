import { beforeEach, describe, expect, it, vi } from 'vitest';

const nativeBackgroundTaskState = vi.hoisted(() => ({ registered: false }));

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
const reactNativeMock = vi.hoisted(() => {
  const headlessTasks = new Map<string, () => () => Promise<void>>();
  const appStateListeners = new Set<(state: string) => void>();
  return {
    headlessTasks,
    appStateListeners,
    AppState: {
      currentState: 'active' as string,
      addEventListener: vi.fn((event: string, listener: (state: string) => void) => {
        if (event === 'change') appStateListeners.add(listener);
        return { remove: () => appStateListeners.delete(listener) };
      }),
    },
    Platform: { OS: 'android' },
    AppRegistry: {
      registerHeadlessTask: vi.fn((name: string, provider: () => () => Promise<void>) => {
        headlessTasks.set(name, provider);
      }),
    },
  };
});

/** Fires every 'change' listener registered via AppState.addEventListener —
 *  the harness has no real OS to deliver the event, so a test drives it directly. */
const emitAppStateChange = (state: string) => {
  reactNativeMock.AppState.currentState = state;
  for (const listener of reactNativeMock.appStateListeners) listener(state);
};
vi.mock('react-native', () => reactNativeMock);

const captureDrainMock = vi.hoisted(() => ({ drainPendingCapturesInBackground: vi.fn() }));
vi.mock('./pending-capture-drain', () => captureDrainMock);
const reminderMock = vi.hoisted(() => vi.fn());
vi.mock('./notification-service-local', () => ({ reconcileLocalMobileNotificationsInBackground: reminderMock }));

const loadModule = async () => import('./background-sync-task');

describe('mobile background sync task', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    taskManagerMock.state.executor = null;
    reactNativeMock.AppState.currentState = 'active';
    reactNativeMock.appStateListeners.clear();
    nativeBackgroundTaskState.registered = false;
    taskManagerMock.isTaskDefined.mockReturnValue(false);
    taskManagerMock.isAvailableAsync.mockResolvedValue(true);
    taskManagerMock.isTaskRegisteredAsync.mockImplementation(async () => nativeBackgroundTaskState.registered);
    backgroundTaskMock.getStatusAsync.mockResolvedValue(backgroundTaskMock.BackgroundTaskStatus.Available);
    backgroundTaskMock.registerTaskAsync.mockImplementation(async () => {
      nativeBackgroundTaskState.registered = true;
    });
    backgroundTaskMock.unregisterTaskAsync.mockImplementation(async () => {
      nativeBackgroundTaskState.registered = false;
    });
    coreMock.flushPendingSave.mockResolvedValue(undefined);
    syncServiceMock.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'off', configured: false });
    syncServiceMock.performMobileSync.mockResolvedValue({ success: true });
    storageAdapterMock.quiesceMobileStorage.mockResolvedValue(undefined);
    captureDrainMock.drainPendingCapturesInBackground.mockResolvedValue(0);
    reminderMock.mockResolvedValue(undefined);
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
  it('skips a background run while the failure cooldown is live and resumes after it', async () => {
    const { BACKGROUND_SYNC_FAILURE_STATE_KEY } = await import('./sync-constants');
    syncServiceMock.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'webdav', configured: true });
    syncServiceMock.performMobileSync.mockResolvedValue({ success: false, error: 'auth failed' });
    const module = await loadModule();
    const intervalMs = module.MOBILE_BACKGROUND_SYNC_MINIMUM_INTERVAL_MINUTES * 60_000;

    const rewind = (intervals: number, consecutiveFailures: number) => {
      asyncStorageMock.store.set(BACKGROUND_SYNC_FAILURE_STATE_KEY, JSON.stringify({
        lastFailureAt: Date.now() - intervals * intervalMs, consecutiveFailures,
      }));
    };

    // Two failures in a row: the second is recorded with an escalated cooldown.
    expect(await taskManagerMock.state.executor?.()).toBe(backgroundTaskMock.BackgroundTaskResult.Failed);
    expect(JSON.parse(asyncStorageMock.store.get(BACKGROUND_SYNC_FAILURE_STATE_KEY)!))
      .toMatchObject({ consecutiveFailures: 1 });
    rewind(1, 1);
    expect(await taskManagerMock.state.executor?.()).toBe(backgroundTaskMock.BackgroundTaskResult.Failed);
    expect(syncServiceMock.performMobileSync).toHaveBeenCalledTimes(2);
    expect(JSON.parse(asyncStorageMock.store.get(BACKGROUND_SYNC_FAILURE_STATE_KEY)!))
      .toMatchObject({ consecutiveFailures: 2 });

    // The third invocation lands one interval later, inside the 2-interval cooldown.
    rewind(1, 2);
    expect(await taskManagerMock.state.executor?.()).toBe(backgroundTaskMock.BackgroundTaskResult.Success);
    expect(syncServiceMock.performMobileSync).toHaveBeenCalledTimes(2);
    expect(storageAdapterMock.quiesceMobileStorage).toHaveBeenCalledTimes(2);
    expect(appLogMock.logInfo).toHaveBeenCalledWith(
      'Mobile background sync skipped during failure cooldown',
      expect.objectContaining({ extra: expect.objectContaining({ consecutiveFailures: '2' }) }),
    );

    // Past the cooldown it runs again, and a success clears the record.
    rewind(3, 2);
    syncServiceMock.performMobileSync.mockResolvedValue({ success: true });
    expect(await taskManagerMock.state.executor?.()).toBe(backgroundTaskMock.BackgroundTaskResult.Success);
    expect(syncServiceMock.performMobileSync).toHaveBeenCalledTimes(3);
    expect(asyncStorageMock.store.has(BACKGROUND_SYNC_FAILURE_STATE_KEY)).toBe(false);
  });

  it('caps the background failure cooldown', async () => {
    const { BACKGROUND_SYNC_FAILURE_STATE_KEY } = await import('./sync-constants');
    syncServiceMock.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'webdav', configured: true });
    const module = await loadModule();
    const setRecord = (waitedMs: number) => {
      asyncStorageMock.store.set(BACKGROUND_SYNC_FAILURE_STATE_KEY, JSON.stringify({
        lastFailureAt: Date.now() - waitedMs, consecutiveFailures: 40,
      }));
    };

    // Far more failures than the ceiling: the wait is the ceiling, never 2^40 intervals.
    setRecord(module.MOBILE_BACKGROUND_SYNC_MAX_FAILURE_COOLDOWN_MS - 60_000);
    expect(await taskManagerMock.state.executor?.()).toBe(backgroundTaskMock.BackgroundTaskResult.Success);
    expect(syncServiceMock.performMobileSync).not.toHaveBeenCalled();

    setRecord(module.MOBILE_BACKGROUND_SYNC_MAX_FAILURE_COOLDOWN_MS + 1);
    expect(await taskManagerMock.state.executor?.()).toBe(backgroundTaskMock.BackgroundTaskResult.Success);
    expect(syncServiceMock.performMobileSync).toHaveBeenCalledTimes(1);
  });

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
      // The deadline's own abort: a lifecycle abort would queue a follow-up cycle that runs once timers resume.
      expect(syncServiceMock.abortMobileSync).toHaveBeenCalledWith('deadline');
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

  it('aborts a sync resumed past its deadline as soon as the app is foregrounded, without waiting for the paused timer', async () => {
    vi.useFakeTimers();
    try {
      syncServiceMock.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'webdav', configured: true });
      // Never settles on its own — only abortMobileSync (called by the deadline
      // handling below) ends the run, same as a CloudKit op stuck mid-request.
      syncServiceMock.performMobileSync.mockImplementation(() => new Promise(() => undefined));

      const module = await loadModule();
      const executor = taskManagerMock.state.executor;
      if (!executor) throw new Error('Expected the background sync task to be defined');

      const startedAt = Date.now();
      const run = executor();
      // Let the run's own awaits (drain, failure-state read) settle so it has
      // reached the deadline race and registered the AppState listener.
      await vi.advanceTimersByTimeAsync(0);

      // The app is suspended mid-operation: the clock moves on, but the OS
      // pauses JavaScript timers, so nothing scheduled with setTimeout fires.
      vi.setSystemTime(startedAt + module.MOBILE_BACKGROUND_SYNC_DEADLINE_MS + 5000);
      expect(syncServiceMock.abortMobileSync).not.toHaveBeenCalled();

      // The app resumes: AppState delivers 'active' the instant JS runs again.
      emitAppStateChange('active');

      expect(await run).toBe(backgroundTaskMock.BackgroundTaskResult.Failed);
      expect(syncServiceMock.abortMobileSync).toHaveBeenCalledTimes(1);
      // One line for both branches, with `stage` telling them apart: which of
      // the two wins on resume is a race the app does not control, so the
      // tester's release check must not depend on it.
      expect(appLogMock.logWarn).toHaveBeenCalledWith(
        'Mobile background sync did not finish before its deadline and was abandoned',
        expect.objectContaining({
          force: true,
          extra: expect.objectContaining({ stage: 'resume', releaseCheck: 'v1.3.2/background-sync-wallclock-abort' }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores an AppState change while the run is still within its deadline', async () => {
    vi.useFakeTimers();
    try {
      syncServiceMock.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'webdav', configured: true });
      syncServiceMock.performMobileSync.mockImplementation(() => new Promise(() => undefined));

      const module = await loadModule();
      const executor = taskManagerMock.state.executor;
      if (!executor) throw new Error('Expected the background sync task to be defined');

      const run = executor();
      await vi.advanceTimersByTimeAsync(0);
      emitAppStateChange('active');
      expect(syncServiceMock.abortMobileSync).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(module.MOBILE_BACKGROUND_SYNC_DEADLINE_MS);
      expect(await run).toBe(backgroundTaskMock.BackgroundTaskResult.Failed);
      expect(syncServiceMock.abortMobileSync).toHaveBeenCalledTimes(1);
      expect(appLogMock.logWarn).toHaveBeenCalledWith(
        'Mobile background sync did not finish before its deadline and was abandoned',
        expect.objectContaining({
          force: true,
          extra: expect.objectContaining({
            stage: 'timer',
            deadlineMs: String(module.MOBILE_BACKGROUND_SYNC_DEADLINE_MS),
            releaseCheck: 'v1.3.2/background-sync-wallclock-abort',
          }),
        }),
      );
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

  describe('automatic background sync schedule', () => {
    it.each(['off', '15m', '1h', '6h', 'invalid'])('ignores the legacy saved %s choice and registers the fixed schedule', async (legacyChoice) => {
      syncServiceMock.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'cloud', configured: true });
      asyncStorageMock.store.set('@mindwtr_background_sync_interval', legacyChoice);

      const module = await loadModule();
      const result = await module.syncMobileBackgroundSyncRegistration();

      expect(backgroundTaskMock.registerTaskAsync).toHaveBeenCalledWith(module.MOBILE_BACKGROUND_SYNC_TASK_NAME, {
        minimumInterval: module.MOBILE_BACKGROUND_SYNC_MINIMUM_INTERVAL_MINUTES,
      });
      expect(result).toMatchObject({ action: 'registered', interval: '15m', registered: true });
    });

    it('leaves an existing fixed registration unchanged and logs readiness once', async () => {
      syncServiceMock.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'webdav', configured: true });
      nativeBackgroundTaskState.registered = true;
      const { BACKGROUND_SYNC_LAST_REGISTERED_INTERVAL_KEY } = await import('./sync-constants');
      asyncStorageMock.store.set(BACKGROUND_SYNC_LAST_REGISTERED_INTERVAL_KEY, '15m');

      const module = await loadModule();
      const first = await module.syncMobileBackgroundSyncRegistration();
      const second = await module.syncMobileBackgroundSyncRegistration();

      expect(backgroundTaskMock.unregisterTaskAsync).not.toHaveBeenCalled();
      expect(backgroundTaskMock.registerTaskAsync).not.toHaveBeenCalled();
      expect(first).toMatchObject({ action: 'unchanged', interval: '15m', registered: true });
      expect(second).toMatchObject({ action: 'unchanged', interval: '15m', registered: true });
      expect(appLogMock.logInfo).toHaveBeenCalledWith('Automatic mobile background sync schedule ready', {
        scope: 'sync',
        extra: {
          releaseCheck: 'v1.3.0/automatic-background-sync',
          interval: '15m',
          outcome: 'unchanged',
        },
      });
      expect(appLogMock.logInfo.mock.calls.filter(([message]) => (
        message === 'Automatic mobile background sync schedule ready'
      ))).toHaveLength(1);
    });

    it.each(['off', '1h', '6h', 'invalid'])('migrates an existing legacy %s registration once in the foreground', async (legacyInterval) => {
      syncServiceMock.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'cloudkit', configured: true });
      nativeBackgroundTaskState.registered = true;
      const { BACKGROUND_SYNC_LAST_REGISTERED_INTERVAL_KEY } = await import('./sync-constants');
      asyncStorageMock.store.set(BACKGROUND_SYNC_LAST_REGISTERED_INTERVAL_KEY, legacyInterval);

      const module = await loadModule();
      const result = await module.syncMobileBackgroundSyncRegistration();

      expect(backgroundTaskMock.unregisterTaskAsync).toHaveBeenCalledTimes(1);
      expect(backgroundTaskMock.registerTaskAsync).toHaveBeenCalledTimes(1);
      expect(backgroundTaskMock.unregisterTaskAsync.mock.invocationCallOrder[0])
        .toBeLessThan(backgroundTaskMock.registerTaskAsync.mock.invocationCallOrder[0]);
      expect(backgroundTaskMock.registerTaskAsync).toHaveBeenCalledWith(module.MOBILE_BACKGROUND_SYNC_TASK_NAME, {
        minimumInterval: 15,
      });
      expect(asyncStorageMock.store.get(BACKGROUND_SYNC_LAST_REGISTERED_INTERVAL_KEY)).toBe('15m');
      expect(result).toMatchObject({ action: 'registered', interval: '15m', registered: true });
    });

    it.each(['background', 'inactive'])('defers every native mutation while the app is %s', async (appState) => {
      syncServiceMock.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'webdav', configured: true });
      nativeBackgroundTaskState.registered = true;
      const { BACKGROUND_SYNC_LAST_REGISTERED_INTERVAL_KEY } = await import('./sync-constants');
      asyncStorageMock.store.set(BACKGROUND_SYNC_LAST_REGISTERED_INTERVAL_KEY, '1h');
      reactNativeMock.AppState.currentState = appState;

      const module = await loadModule();
      const result = await module.syncMobileBackgroundSyncRegistration();

      expect(backgroundTaskMock.unregisterTaskAsync).not.toHaveBeenCalled();
      expect(backgroundTaskMock.registerTaskAsync).not.toHaveBeenCalled();
      expect(result).toMatchObject({ action: 'unchanged', interval: '15m', registered: true });
      expect(appLogMock.logInfo).not.toHaveBeenCalledWith(
        'Automatic mobile background sync schedule ready',
        expect.anything(),
      );
    });

    it('serializes overlapping reads so a later caller applies changed configuration', async () => {
      const firstConfigReadStarted = createDeferred<void>();
      const firstConfigRead = createDeferred<{ backend: 'off'; configured: false }>();
      syncServiceMock.getMobileSyncConfigurationStatus
        .mockImplementationOnce(() => {
          firstConfigReadStarted.resolve();
          return firstConfigRead.promise;
        })
        .mockResolvedValue({ backend: 'webdav', configured: true });

      const module = await loadModule();
      const first = module.syncMobileBackgroundSyncRegistration();
      const second = module.syncMobileBackgroundSyncRegistration();
      await firstConfigReadStarted.promise;
      expect(syncServiceMock.getMobileSyncConfigurationStatus).toHaveBeenCalledTimes(1);

      firstConfigRead.resolve({ backend: 'off', configured: false });
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);

      expect(backgroundTaskMock.registerTaskAsync).toHaveBeenCalledTimes(1);
      expect(backgroundTaskMock.unregisterTaskAsync).not.toHaveBeenCalled();
    });

    it('re-reads changed configuration after a slow native mutation and leaves the current policy applied', async () => {
      let configuration: { backend: 'webdav' | 'off'; configured: boolean } = {
        backend: 'webdav',
        configured: true,
      };
      syncServiceMock.getMobileSyncConfigurationStatus.mockImplementation(async () => ({ ...configuration }));
      const registrationStarted = createDeferred<void>();
      const registrationFinished = createDeferred<void>();
      backgroundTaskMock.registerTaskAsync.mockImplementationOnce(async () => {
        registrationStarted.resolve();
        await registrationFinished.promise;
        nativeBackgroundTaskState.registered = true;
      });

      const module = await loadModule();
      const first = module.syncMobileBackgroundSyncRegistration();
      await registrationStarted.promise;
      configuration = { backend: 'off', configured: false };
      const second = module.syncMobileBackgroundSyncRegistration();
      registrationFinished.resolve();

      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      expect(backgroundTaskMock.registerTaskAsync).toHaveBeenCalledTimes(1);
      expect(backgroundTaskMock.unregisterTaskAsync).toHaveBeenCalledTimes(1);
      expect(nativeBackgroundTaskState.registered).toBe(false);
      expect(appLogMock.logInfo).not.toHaveBeenCalledWith(
        'Automatic mobile background sync schedule ready',
        expect.anything(),
      );
    });

    it('recovers the reconciliation queue after registration fails', async () => {
      syncServiceMock.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'webdav', configured: true });
      backgroundTaskMock.registerTaskAsync.mockRejectedValueOnce(new Error('native registration failed'));

      const module = await loadModule();
      await expect(module.syncMobileBackgroundSyncRegistration()).rejects.toThrow('native registration failed');
      const retry = await module.syncMobileBackgroundSyncRegistration();

      expect(backgroundTaskMock.registerTaskAsync).toHaveBeenCalledTimes(2);
      expect(retry).toMatchObject({ action: 'registered', interval: '15m', registered: true });
    });

    it('waits for active background work before replacing a legacy worker', async () => {
      syncServiceMock.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'webdav', configured: true });
      nativeBackgroundTaskState.registered = true;
      const { BACKGROUND_SYNC_LAST_REGISTERED_INTERVAL_KEY } = await import('./sync-constants');
      asyncStorageMock.store.set(BACKGROUND_SYNC_LAST_REGISTERED_INTERVAL_KEY, '1h');
      const syncStarted = createDeferred<void>();
      const syncFinished = createDeferred<{ success: boolean }>();
      const waitingLogged = createDeferred<void>();
      syncServiceMock.performMobileSync.mockImplementationOnce(() => {
        syncStarted.resolve();
        return syncFinished.promise;
      });
      appLogMock.logInfo.mockImplementation((message, context) => {
        if (
          message === 'Mobile background sync registration checked'
          && context?.extra?.decision === 'waiting-for-background-run'
        ) {
          waitingLogged.resolve();
        }
      });

      const module = await loadModule();
      const executor = taskManagerMock.state.executor;
      if (!executor) throw new Error('Expected the background sync task to be defined');
      const activeRun = executor();
      await syncStarted.promise;
      const reconciliation = module.syncMobileBackgroundSyncRegistration();
      await waitingLogged.promise;
      expect(backgroundTaskMock.unregisterTaskAsync).not.toHaveBeenCalled();

      syncFinished.resolve({ success: true });
      await activeRun;
      const result = await reconciliation;

      expect(backgroundTaskMock.unregisterTaskAsync).toHaveBeenCalledTimes(1);
      expect(backgroundTaskMock.registerTaskAsync).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ action: 'registered', registered: true });
    });

    it('does not cancel an executing worker when reconciliation runs headlessly', async () => {
      syncServiceMock.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'webdav', configured: true });
      nativeBackgroundTaskState.registered = true;
      const { BACKGROUND_SYNC_LAST_REGISTERED_INTERVAL_KEY } = await import('./sync-constants');
      asyncStorageMock.store.set(BACKGROUND_SYNC_LAST_REGISTERED_INTERVAL_KEY, '6h');
      const syncStarted = createDeferred<void>();
      const syncFinished = createDeferred<{ success: boolean }>();
      syncServiceMock.performMobileSync.mockImplementationOnce(() => {
        syncStarted.resolve();
        return syncFinished.promise;
      });

      const module = await loadModule();
      const executor = taskManagerMock.state.executor;
      if (!executor) throw new Error('Expected the background sync task to be defined');
      const activeRun = executor();
      await syncStarted.promise;
      reactNativeMock.AppState.currentState = 'background';

      const result = await module.syncMobileBackgroundSyncRegistration();
      expect(result.action).toBe('unchanged');
      expect(backgroundTaskMock.unregisterTaskAsync).not.toHaveBeenCalled();
      expect(backgroundTaskMock.registerTaskAsync).not.toHaveBeenCalled();

      syncFinished.resolve({ success: true });
      await activeRun;
    });
  });
  describe('queued captures (#1257)', () => {
    const configureSync = () => {
      syncServiceMock.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'webdav', configured: true });
    };

    it('imports queued captures before a scheduled sync', async () => {
      configureSync();
      const order: string[] = [];
      captureDrainMock.drainPendingCapturesInBackground.mockImplementation(async () => {
        order.push('drain');
        return 1;
      });
      syncServiceMock.performMobileSync.mockImplementation(async () => {
        order.push('sync');
        return { success: true };
      });
      await loadModule();

      await taskManagerMock.state.executor?.();

      expect(captureDrainMock.drainPendingCapturesInBackground).toHaveBeenCalledWith('scheduled');
      expect(order).toEqual(['drain', 'sync']);
      expect(reminderMock).toHaveBeenCalledWith('sync');
    });

    it('awaits reminders from a successful background sync without foreground timers', async () => {
      configureSync();
      reactNativeMock.AppState.currentState = 'background';
      const reconciled = createDeferred<void>();
      reminderMock.mockReturnValueOnce(reconciled.promise);
      await loadModule();
      let done = false;
      const run = taskManagerMock.state.executor?.().then(() => { done = true; });
      await vi.waitFor(() => expect(reminderMock).toHaveBeenCalledWith('sync'));
      expect(done).toBe(false);
      reconciled.resolve();
      await run;
    });

    it('does not reconcile after a failed sync', async () => {
      configureSync();
      syncServiceMock.performMobileSync.mockResolvedValueOnce({ success: false });
      await loadModule();
      await taskManagerMock.state.executor?.();
      expect(reminderMock).not.toHaveBeenCalled();
    });

    it('syncs right after a Save from the capture dialog, even during a failure cooldown', async () => {
      configureSync();
      asyncStorageMock.store.set('@mindwtr_background_sync_failure_state_v1', JSON.stringify({
        lastFailureAt: Date.now(),
        consecutiveFailures: 3,
      }));
      captureDrainMock.drainPendingCapturesInBackground.mockResolvedValue(1);
      const { MOBILE_CAPTURE_SYNC_HEADLESS_TASK_NAME } = await loadModule();

      await reactNativeMock.headlessTasks.get(MOBILE_CAPTURE_SYNC_HEADLESS_TASK_NAME)?.()();

      expect(captureDrainMock.drainPendingCapturesInBackground).toHaveBeenCalledWith('capture');
      expect(syncServiceMock.performMobileSync).toHaveBeenCalledTimes(1);
      expect(storageAdapterMock.quiesceMobileStorage).toHaveBeenCalled();
    });

    it('does not sync from the capture trigger when the visible app already imported the queue', async () => {
      configureSync();
      const { MOBILE_CAPTURE_SYNC_HEADLESS_TASK_NAME } = await loadModule();

      await reactNativeMock.headlessTasks.get(MOBILE_CAPTURE_SYNC_HEADLESS_TASK_NAME)?.()();

      expect(syncServiceMock.performMobileSync).not.toHaveBeenCalled();
    });

    it('still runs the scheduled sync when the capture import throws', async () => {
      configureSync();
      captureDrainMock.drainPendingCapturesInBackground.mockRejectedValue(new Error('disk'));
      await loadModule();

      await taskManagerMock.state.executor?.();

      expect(syncServiceMock.performMobileSync).toHaveBeenCalledTimes(1);
    });
  });
});
