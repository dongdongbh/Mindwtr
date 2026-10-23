import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_POMODORO_DURATIONS, getPomodoroLocalDayKey, runStoreCommand, runSyncStoreSave, useTaskStore, type Task } from '@mindwtr/core';
import { logInfo } from './app-log';

vi.mock('./app-log', () => ({ logInfo: vi.fn(async () => undefined), logWarn: vi.fn(async () => undefined) }));

// eslint-disable-next-line import/first
import { createMobilePomodoroController } from './pomodoro-controller';
// eslint-disable-next-line import/first
import { POMODORO_SESSION_STORAGE_KEY } from './pomodoro-session';

const makeStorage = (stored: unknown = null) => ({
  getItem: vi.fn(async () => stored === null ? null : JSON.stringify(stored)),
  setItem: vi.fn(async () => undefined),
});

describe('mobile pomodoro controller', () => {
  let nowMs = 10_000;

  beforeEach(() => {
    nowMs = 10_000;
    vi.mocked(logInfo).mockClear();
  });

  it.each([
    ['focus', 'unlink'], ['break', 'unlink'],
    ['focus', 'select'], ['break', 'select'],
    ['focus', 'dismiss'], ['break', 'dismiss'],
  ] as const)('preserves auto-start at a %s deadline when task controls %s', async (phase, action) => {
    const options = { autoStartBreaks: true, autoStartFocus: true };
    const controller = createMobilePomodoroController({ storage: makeStorage(), now: () => nowMs });
    await controller.ensureHydrated(options);
    controller.setDurations({ focusMinutes: 1, breakMinutes: 1 }, options);
    controller.setSelectedTaskId('linked', options);
    if (phase === 'break') controller.switchPhase(options);
    controller.toggle(options);

    nowMs += 60_000;
    if (action === 'unlink') controller.setSelectedTaskId(undefined, options);
    if (action === 'select') controller.setSelectedTaskId('another', options);
    if (action === 'dismiss') controller.clearLastEvent(options);

    expect(controller.getSnapshot().timerState).toMatchObject({
      phase: phase === 'focus' ? 'break' : 'focus', remainingSeconds: 60, isRunning: true,
      completedFocusSessions: phase === 'focus' ? 1 : 0,
    });
    expect(controller.getSnapshot().phaseEndsAt).toBe(new Date(nowMs + 60_000).toISOString());
    expect(controller.getSnapshot().sessionHistory.completedFocusSessionsByTaskId.linked ?? 0)
      .toBe(phase === 'focus' ? 1 : 0);
  });

  it.each([
    ['focus', 'start', 'focus-finished'],
    ['focus', 'reset', 'focus-finished'],
    ['focus', 'switch-phase', 'focus-finished'],
    ['focus', 'dismiss', 'focus-finished'],
    ['break', 'start', 'break-finished'],
    ['break', 'reset', 'break-finished'],
    ['break', 'switch-phase', 'break-finished'],
    ['break', 'dismiss', 'break-finished'],
  ] as const)('keeps %s completion feedback through idle ticks until %s', async (phase, action, event) => {
    const controller = createMobilePomodoroController({ storage: makeStorage(), now: () => nowMs });
    await controller.ensureHydrated();
    controller.setDurations({ focusMinutes: 1, breakMinutes: 1 });
    if (phase === 'break') controller.switchPhase();
    controller.toggle();

    nowMs += 60_000;
    controller.reconcile();
    expect(controller.getSnapshot().lastEvent).toBe(event);

    for (let idleTick = 0; idleTick < 3; idleTick += 1) {
      nowMs += 1_000;
      controller.reconcile();
    }
    expect(controller.getSnapshot().lastEvent).toBe(event);

    if (action === 'start') controller.toggle();
    if (action === 'reset') controller.reset();
    if (action === 'switch-phase') controller.switchPhase();
    if (action === 'dismiss') controller.clearLastEvent();
    expect(controller.getSnapshot().lastEvent).toBeNull();
  });

  it('treats Watch actions as timestamped idempotent setters', async () => {
    const storage = makeStorage();
    const controller = createMobilePomodoroController({ storage, now: () => nowMs });
    await controller.ensureHydrated();

    expect(await controller.applyWatchCommand({ action: 'start', createdAt: new Date(20_000).toISOString() })).toBe('applied');
    expect(controller.getSnapshot().timerState.isRunning).toBe(true);
    expect(await controller.applyWatchCommand({ action: 'start', createdAt: new Date(20_000).toISOString() })).toBe('already-applied');

    nowMs = 21_000;
    expect(await controller.applyWatchCommand({ action: 'pause', createdAt: new Date(21_000).toISOString() })).toBe('applied');
    expect(controller.getSnapshot().timerState.isRunning).toBe(false);
  });

  it('keeps a command retryable until its timer session is durable', async () => {
    const storage = makeStorage();
    storage.setItem.mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined);
    const controller = createMobilePomodoroController({ storage, now: () => nowMs });
    await controller.ensureHydrated();
    const command = { action: 'start' as const, createdAt: new Date(20_000).toISOString() };

    await expect(controller.applyWatchCommand(command)).rejects.toThrow('disk full');
    await expect(controller.applyWatchCommand(command)).resolves.toBe('already-applied');
    expect(storage.setItem).toHaveBeenCalledTimes(2);
  });

  it('rejects an offline Watch command older than a phone-side mutation', async () => {
    const controller = createMobilePomodoroController({ storage: makeStorage(), now: () => nowMs });
    await controller.ensureHydrated();
    controller.toggle();
    expect(controller.getSnapshot().updatedAtMs).toBe(10_000);

    expect(await controller.applyWatchCommand({
      action: 'pause',
      createdAt: new Date(9_000).toISOString(),
    })).toBe('stale');
    expect(controller.getSnapshot().timerState.isRunning).toBe(true);
  });

  it('keeps a later phone action authoritative across Watch clock skew', async () => {
    const controller = createMobilePomodoroController({ storage: makeStorage(), now: () => nowMs });
    await controller.ensureHydrated();
    const watchTime = new Date(20_000).toISOString();
    expect(await controller.applyWatchCommand({ action: 'start', createdAt: watchTime })).toBe('applied');

    nowMs = 11_000;
    controller.toggle();
    expect(controller.getSnapshot().timerState.isRunning).toBe(false);
    expect(controller.getSnapshot().updatedAtMs).toBe(20_001);

    expect(await controller.applyWatchCommand({ action: 'start', createdAt: watchTime })).toBe('stale');
    expect(controller.getSnapshot().timerState.isRunning).toBe(false);
  });

  it('respects the phone link-task setting and rejects a terminal Watch task link', async () => {
    const openTask = { id: 'open', title: 'Open', status: 'next' } as Task;
    const doneTask = { id: 'done', title: 'Done', status: 'done' } as Task;
    const controller = createMobilePomodoroController({
      storage: makeStorage(),
      now: () => nowMs,
      getTaskStore: () => ({ tasks: [openTask, doneTask], updateTask: vi.fn(async () => ({ success: true })) }),
    });
    await controller.ensureHydrated();
    nowMs = 11_000;
    controller.setSelectedTaskId(openTask.id);

    expect(await controller.applyWatchCommand(
      { action: 'start', taskId: openTask.id, createdAt: new Date(20_000).toISOString() },
      {},
      { linkTaskEnabled: false },
    )).toBe('applied');
    expect(controller.getSnapshot().selectedTaskId).toBeUndefined();

    nowMs = 20_500;
    controller.setSelectedTaskId(openTask.id);
    expect(await controller.applyWatchCommand(
      { action: 'pause', taskId: doneTask.id, createdAt: new Date(21_000).toISOString() },
      {},
      { linkTaskEnabled: true },
    )).toBe('applied');
    expect(controller.getSnapshot().selectedTaskId).toBeUndefined();
  });

  it('credits a completed linked focus session once across repeated reconciliation', async () => {
    const task = { id: 'task-1', title: 'Write', timeSpentMinutes: 5 } as Task;
    const updateTask = vi.fn(async () => ({ success: true }));
    const stored = {
      durations: DEFAULT_POMODORO_DURATIONS,
      timerState: {
        phase: 'focus',
        remainingSeconds: 1,
        isRunning: true,
        completedFocusSessions: 0,
      },
      selectedTaskId: task.id,
      phaseEndsAt: new Date(9_000).toISOString(),
      sessionHistory: {
        totalCompletedFocusSessions: 0,
        completedFocusSessionsByTaskId: {},
        todayDayKey: getPomodoroLocalDayKey(nowMs),
        completedTodayFocusSessions: 0,
      },
    };
    const controller = createMobilePomodoroController({
      storage: makeStorage(stored),
      now: () => nowMs,
      getTaskStore: () => ({ tasks: [task], updateTask }),
    });

    await controller.ensureHydrated();
    controller.reconcile();
    controller.reconcile();
    // The credit goes to its task once the session that owes it is stored.
    await controller.flushPersistence();

    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(updateTask).toHaveBeenCalledWith(task.id, {
      timeSpentMinutes: 5 + DEFAULT_POMODORO_DURATIONS.focusMinutes,
    });
  });

  it('credits the expired old interval before replacing its durations', async () => {
    const task = { id: 'task-a', title: 'Write', timeSpentMinutes: 5 } as Task;
    const updateTask = vi.fn(async () => ({ success: true }));
    const controller = createMobilePomodoroController({
      storage: makeStorage(),
      now: () => nowMs,
      getTaskStore: () => ({ tasks: [task], updateTask }),
    });
    await controller.ensureHydrated();
    controller.setSelectedTaskId(task.id);
    controller.toggle();

    nowMs += 25 * 60_000;
    controller.setDurations({ focusMinutes: 50, breakMinutes: 10 });
    await controller.flushPersistence();

    expect(updateTask).toHaveBeenCalledExactlyOnceWith(task.id, { timeSpentMinutes: 30 });
    expect(logInfo).toHaveBeenCalledExactlyOnceWith('Pomodoro elapsed focus boundary resolved before action', {
      scope: 'pomodoro',
      extra: { releaseCheck: 'v1.3.5/pomodoro-rn-boundary', outcome: 'elapsed-focus-resolved' },
    });
    expect(controller.getSnapshot()).toMatchObject({
      durations: { focusMinutes: 50, breakMinutes: 10 },
      timerState: { phase: 'break', remainingSeconds: 600, isRunning: false, completedFocusSessions: 1 },
      selectedTaskId: task.id,
      lastEvent: null,
      sessionHistory: { totalCompletedFocusSessions: 1, completedFocusSessionsByTaskId: { 'task-a': 1 } },
    });
    expect(controller.getSnapshot().phaseEndsAt).toBeUndefined();
    controller.reconcile();
    controller.setDurations({ focusMinutes: 50, breakMinutes: 10 });
    await controller.flushPersistence();
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledTimes(1);
  });

  it('uses restored durations to credit hydration rather than the default in-memory pair', async () => {
    const task = { id: 'restored-task', title: 'Write', timeSpentMinutes: 5 } as Task;
    const updateTask = vi.fn(async () => ({ success: true }));
    const controller = createMobilePomodoroController({
      storage: makeStorage({
        durations: { focusMinutes: 50, breakMinutes: 10 },
        timerState: { phase: 'focus', remainingSeconds: 1, isRunning: true, completedFocusSessions: 0 },
        selectedTaskId: task.id,
        phaseEndsAt: new Date(9_000).toISOString(),
      }),
      now: () => nowMs,
      getTaskStore: () => ({ tasks: [task], updateTask }),
    });
    await controller.ensureHydrated();
    controller.reconcile();
    await controller.flushPersistence();

    expect(updateTask).toHaveBeenCalledExactlyOnceWith(task.id, { timeSpentMinutes: 55 });
    expect(controller.getSnapshot()).toMatchObject({
      durations: { focusMinutes: 50, breakMinutes: 10 },
      timerState: { phase: 'break', remainingSeconds: 600, completedFocusSessions: 1 },
    });
    expect(logInfo).not.toHaveBeenCalled();
  });

  it('journals the expired old duration before retrying its task credit after a restart', async () => {
    const task = { id: 'task-a', title: 'Write', timeSpentMinutes: 5 } as Task;
    const device = new Map<string, string>();
    const storage = {
      getItem: async (key: string) => device.get(key) ?? null,
      setItem: async (key: string, value: string) => { device.set(key, value); },
    };
    let rejectCredit = true;
    const updateTask = vi.fn(async (_id: string, updates: Partial<Task>) => {
      if (rejectCredit) return { success: false };
      Object.assign(task, updates);
      return { success: true };
    });
    const options = { storage, now: () => nowMs, getTaskStore: () => ({ tasks: [task], updateTask }) };
    const first = createMobilePomodoroController(options);
    await first.ensureHydrated();
    first.setSelectedTaskId(task.id);
    first.toggle();

    nowMs += 25 * 60_000;
    first.setDurations({ focusMinutes: 50, breakMinutes: 10 });
    await first.flushPersistence();

    expect(task.timeSpentMinutes).toBe(5);
    expect(JSON.parse(device.get(POMODORO_SESSION_STORAGE_KEY)!)).toMatchObject({
      durations: { focusMinutes: 50, breakMinutes: 10 },
      pendingCredits: [{ taskId: task.id, from: 5, to: 30 }],
    });
    expect(updateTask).toHaveBeenCalledExactlyOnceWith(task.id, { timeSpentMinutes: 30 });

    rejectCredit = false;
    const restarted = createMobilePomodoroController(options);
    await restarted.ensureHydrated();
    await restarted.flushPersistence();
    await restarted.flushPersistence();
    expect(task.timeSpentMinutes).toBe(30);
    expect(updateTask).toHaveBeenCalledTimes(2);
    expect(JSON.parse(device.get(POMODORO_SESSION_STORAGE_KEY)!)).not.toHaveProperty('pendingCredits');

    const third = createMobilePomodoroController(options);
    await third.ensureHydrated();
    await third.flushPersistence();
    expect(task.timeSpentMinutes).toBe(30);
    expect(updateTask).toHaveBeenCalledTimes(2);
  });

  it.each((['focus', 'break'] as const).flatMap((phase) => (
    [false, true].flatMap((autoStartBreaks) => (
      [false, true].flatMap((autoStartFocus) => (
        ['task-b', undefined].map((selectedTaskId) => ({ phase, autoStartBreaks, autoStartFocus, selectedTaskId }))
      ))
    ))
  )))('settles the old $phase selection with breaks=$autoStartBreaks focus=$autoStartFocus before selecting $selectedTaskId', async ({
    phase, autoStartBreaks, autoStartFocus, selectedTaskId,
  }) => {
    const taskA = { id: 'task-a', title: 'Write', timeSpentMinutes: 5 } as Task;
    const taskB = { id: 'task-b', title: 'Read', timeSpentMinutes: 10 } as Task;
    const updateTask = vi.fn(async () => ({ success: true }));
    const controller = createMobilePomodoroController({
      storage: makeStorage(),
      now: () => nowMs,
      getTaskStore: () => ({ tasks: [taskA, taskB], updateTask }),
    });
    await controller.ensureHydrated();
    controller.setSelectedTaskId(taskA.id);
    if (phase === 'break') controller.switchPhase();
    controller.toggle();
    nowMs += (phase === 'focus' ? 25 : 5) * 60_000;
    const autoStartOptions = { autoStartBreaks, autoStartFocus };

    controller.setSelectedTaskId(selectedTaskId, autoStartOptions);
    await controller.flushPersistence();

    const isRunning = phase === 'focus' ? autoStartBreaks : autoStartFocus;
    const remainingSeconds = phase === 'focus' ? 300 : 1500;
    expect(controller.getSnapshot()).toMatchObject({
      selectedTaskId,
      timerState: { phase: phase === 'focus' ? 'break' : 'focus', remainingSeconds, isRunning },
      lastEvent: phase === 'focus' ? 'focus-finished' : 'break-finished',
    });
    expect(controller.getSnapshot().phaseEndsAt).toBe(isRunning
      ? new Date(nowMs + remainingSeconds * 1000).toISOString()
      : undefined);
    if (phase === 'focus') {
      expect(updateTask).toHaveBeenCalledExactlyOnceWith(taskA.id, { timeSpentMinutes: 30 });
      expect(controller.getSnapshot().sessionHistory.completedFocusSessionsByTaskId).toEqual({ 'task-a': 1 });
    } else {
      expect(updateTask).not.toHaveBeenCalled();
    }
    controller.setSelectedTaskId(selectedTaskId, autoStartOptions);
    controller.reconcile(autoStartOptions);
    await controller.flushPersistence();
    expect(updateTask).toHaveBeenCalledTimes(phase === 'focus' ? 1 : 0);
  });
});

/** A finished focus session's task credit across the two stores it touches (the session on the device, the task in the database). */
describe('Pomodoro task credit', () => {
  const NOW = Date.now();
  const stored = JSON.stringify({
    durations: { focusMinutes: 25, breakMinutes: 5 },
    timerState: { phase: 'focus', remainingSeconds: 600, isRunning: true, completedFocusSessions: 0 },
    selectedTaskId: 't1',
    phaseEndsAt: new Date(NOW - 60_000).toISOString(),
    updatedAtMs: NOW - 1_500_000,
  });
  const makeTasks = () => [{ id: 't1', title: 'One', status: 'next', timeSpentMinutes: 5 } as Task];

  function open(device: Map<string, string>, tasks: Task[], options: { failWrites?: () => boolean; failUpdates?: () => boolean } = {}) {
    return createMobilePomodoroController({
      storage: {
        getItem: async (key) => device.get(key) ?? null,
        setItem: async (key, value) => {
          if (options.failWrites?.()) throw new Error('disk full');
          device.set(key, value);
        },
      },
      getTaskStore: () => ({
        tasks,
        updateTask: async (id, updates) => {
          if (options.failUpdates?.()) return { success: false, error: 'locked' };
          Object.assign(tasks.find((task) => task.id === id)!, updates);
          return { success: true };
        },
      }),
    });
  }

  const settle = async (controller: ReturnType<typeof open>) => {
    await controller.flushPersistence().catch(() => undefined);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };

  it('credits once when the session write failed and the app restarts', async () => {
    const tasks = makeTasks();
    const device = new Map([[POMODORO_SESSION_STORAGE_KEY, stored]]);
    const first = open(device, tasks, { failWrites: () => true });
    await first.ensureHydrated();
    await settle(first);
    const second = open(device, tasks);
    await second.ensureHydrated();
    await settle(second);
    expect(tasks[0].timeSpentMinutes).toBe(30);
  });

  it('credits once when the task write failed after the session was stored', async () => {
    const tasks = makeTasks();
    const device = new Map([[POMODORO_SESSION_STORAGE_KEY, stored]]);
    const first = open(device, tasks, { failUpdates: () => true });
    await first.ensureHydrated();
    await settle(first);
    expect(tasks[0].timeSpentMinutes).toBe(5);
    const second = open(device, tasks);
    await second.ensureHydrated();
    await settle(second);
    expect(tasks[0].timeSpentMinutes).toBe(30);
    // A third start finds nothing owed.
    const third = open(device, tasks);
    await third.ensureHydrated();
    await settle(third);
    expect(tasks[0].timeSpentMinutes).toBe(30);
  });

  it('credits once when the app stopped after the task write and before the session was stored again', async () => {
    const tasks = makeTasks();
    const device = new Map([[POMODORO_SESSION_STORAGE_KEY, stored]]);
    let writes = 0;
    // The first session write (the credit owed) lands; the next (the credit settled) does not.
    const first = open(device, tasks, { failWrites: () => (writes += 1) > 1 });
    await first.ensureHydrated();
    await settle(first);
    expect(tasks[0].timeSpentMinutes).toBe(30);
    const second = open(device, tasks);
    await second.ensureHydrated();
    await settle(second);
    expect(tasks[0].timeSpentMinutes).toBe(30);
  });

  it('credits once when the app stopped while the task save was still in flight', async () => {
    // The real store answers updateTask from memory and saves later: the credit counts only once the save is on disk.
    const device = new Map([[POMODORO_SESSION_STORAGE_KEY, stored]]);
    const memory = makeTasks();
    const first = createMobilePomodoroController({
      storage: { getItem: async (key) => device.get(key) ?? null, setItem: async (key, value) => { device.set(key, value); } },
      getTaskStore: () => ({
        tasks: memory,
        updateTask: async (_id, updates) => { Object.assign(memory[0], updates); return { success: true }; },
        // The app stops before the save lands.
        flush: () => new Promise<void>(() => undefined),
      }),
    });
    await first.ensureHydrated();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(memory[0].timeSpentMinutes).toBe(30);

    const restarted = makeTasks();
    const second = open(device, restarted);
    await second.ensureHydrated();
    await settle(second);
    expect(restarted[0].timeSpentMinutes).toBe(30);
  });

  it('keeps a credit owed when the task save failed', async () => {
    const tasks = makeTasks();
    const device = new Map([[POMODORO_SESSION_STORAGE_KEY, stored]]);
    const first = createMobilePomodoroController({
      storage: { getItem: async (key) => device.get(key) ?? null, setItem: async (key, value) => { device.set(key, value); } },
      getTaskStore: () => ({
        tasks,
        updateTask: async (_id, updates) => { Object.assign(tasks[0], updates); return { success: true }; },
        flush: async () => { throw new Error('disk full'); },
      }),
    });
    await first.ensureHydrated();
    await settle(first);
    expect(JSON.parse(device.get(POMODORO_SESSION_STORAGE_KEY)!).pendingCredits).toEqual([{ taskId: 't1', from: 5, to: 30 }]);
  });

  it('keeps a credit owed when the real store gave up on its save, though its flush resolves', async () => {
    // The default store port: core's flushPendingSave finds nothing queued (the failed save was dropped), but the failure
    // is still recorded, so the time is not on disk.
    const tasks = makeTasks();
    const device = new Map([[POMODORO_SESSION_STORAGE_KEY, stored]]);
    const before = useTaskStore.getState();
    useTaskStore.setState({
      tasks,
      _allTasks: tasks,
      // The task changes in memory; its save then fails for good, so the store records the failure and drops the save.
      updateTask: async (_id: string, updates: Partial<Task>) => {
        Object.assign(tasks[0], updates);
        useTaskStore.setState({ persistenceFailure: { message: 'disk full', at: NOW } } as never);
        return { success: true };
      },
    } as never);
    try {
      const controller = createMobilePomodoroController({
        storage: { getItem: async (key) => device.get(key) ?? null, setItem: async (key, value) => { device.set(key, value); } },
      });
      await controller.ensureHydrated();
      await settle(controller);
      expect(tasks[0].timeSpentMinutes).toBe(30);
      expect(JSON.parse(device.get(POMODORO_SESSION_STORAGE_KEY)!).pendingCredits).toEqual([{ taskId: 't1', from: 5, to: 30 }]);
    } finally {
      useTaskStore.setState({ tasks: before.tasks, _allTasks: before._allTasks, updateTask: before.updateTask, persistenceFailure: null } as never);
    }
  });

  it('keeps a credit owed through later session writes while the task save keeps failing', async () => {
    const tasks = makeTasks();
    const device = new Map([[POMODORO_SESSION_STORAGE_KEY, stored]]);
    let flushes = 0;
    const controller = createMobilePomodoroController({
      storage: { getItem: async (key) => device.get(key) ?? null, setItem: async (key, value) => { device.set(key, value); } },
      getTaskStore: () => ({
        tasks,
        updateTask: async (_id, updates) => { Object.assign(tasks[0], updates); return { success: true }; },
        flush: async () => { flushes += 1; throw new Error('disk full'); },
      }),
    });
    await controller.ensureHydrated();
    await settle(controller);
    // A later change writes the session again: the time is already in memory, so only its save is retried.
    controller.setSelectedTaskId(undefined);
    await settle(controller);
    expect(flushes).toBe(2);
    expect(JSON.parse(device.get(POMODORO_SESSION_STORAGE_KEY)!).pendingCredits).toEqual([{ taskId: 't1', from: 5, to: 30 }]);
  });

  it('checks a credit against the time a sync save published while the credit waited', async () => {
    const tasks = makeTasks();
    const device = new Map([[POMODORO_SESSION_STORAGE_KEY, stored]]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    // Another device logged time on the task; the sync save publishes it.
    const save = runSyncStoreSave(async () => { await held; tasks[0].timeSpentMinutes = 12; });
    const controller = createMobilePomodoroController({
      storage: { getItem: async (key) => device.get(key) ?? null, setItem: async (key, value) => { device.set(key, value); } },
      // A store command, as the real updateTask is: it waits for the save.
      getTaskStore: () => ({ tasks, updateTask: (_id, updates) => runStoreCommand(async () => { Object.assign(tasks[0], updates); return { success: true }; }) }),
    });
    await controller.ensureHydrated();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    release();
    await save;
    await settle(controller);
    // The focus time was never on the task: it adds to the synced time instead of being lost (as desktop does).
    expect(tasks[0].timeSpentMinutes).toBe(37);
  });

  it('credits the expired focus on top of a task changed since its stored owed credit', async () => {
    // The stored credit is overtaken (the task is neither at its from nor its to), so it counts as given; the focus that
    // expired while the app was closed was never given and still adds its 25 minutes.
    const tasks = [{ id: 't1', title: 'One', status: 'next', timeSpentMinutes: 12 } as Task];
    const device = new Map([[POMODORO_SESSION_STORAGE_KEY, JSON.stringify({ ...JSON.parse(stored), pendingCredits: [{ taskId: 't1', from: 5, to: 30 }] })]]);
    const controller = open(device, tasks);
    await controller.ensureHydrated();
    await settle(controller);
    await settle(controller);
    expect(tasks[0].timeSpentMinutes).toBe(37);
    expect(JSON.parse(device.get(POMODORO_SESSION_STORAGE_KEY)!)).not.toHaveProperty('pendingCredits');
    expect(logInfo).toHaveBeenCalledWith('Pomodoro credit moved onto the task time', {
      scope: 'pomodoro', extra: { releaseCheck: 'v1.3.8/pomodoro-credit-moved', outcome: 'moved' },
    });
  });

  it('stores a moved credit before its task write, so a stop before the save lands credits it at the restart', async () => {
    const device = new Map([[POMODORO_SESSION_STORAGE_KEY, JSON.stringify({ ...JSON.parse(stored), pendingCredits: [{ taskId: 't1', from: 5, to: 30 }] })]]);
    const memory = [{ id: 't1', title: 'One', status: 'next', timeSpentMinutes: 12 } as Task];
    const first = createMobilePomodoroController({
      storage: { getItem: async (key) => device.get(key) ?? null, setItem: async (key, value) => { device.set(key, value); } },
      getTaskStore: () => ({
        tasks: memory,
        updateTask: async (_id, updates) => { Object.assign(memory[0], updates); return { success: true }; },
        // The app stops before the moved credit's save lands.
        flush: () => new Promise<void>(() => undefined),
      }),
    });
    await first.ensureHydrated();
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
    expect(memory[0].timeSpentMinutes).toBe(37);
    const disk = [{ id: 't1', title: 'One', status: 'next', timeSpentMinutes: 12 } as Task];
    const second = open(device, disk);
    await second.ensureHydrated();
    await settle(second);
    await settle(second);
    expect(disk[0].timeSpentMinutes).toBe(37);
  });

  it('stores a moved credit and the credit chained from it before the task changes, so a stop credits each once', async () => {
    // A stored credit was overtaken (task at 12); the restart's expired focus (B) and a later one (C) chain from it.
    const device = new Map([[POMODORO_SESSION_STORAGE_KEY, JSON.stringify({ ...JSON.parse(stored), pendingCredits: [{ taskId: 't1', from: 5, to: 30 }] })]]);
    const memory = [{ id: 't1', title: 'One', status: 'next', timeSpentMinutes: 12 } as Task];
    let nowMs = NOW;
    const first = createMobilePomodoroController({
      storage: { getItem: async (key) => device.get(key) ?? null, setItem: async (key, value) => { device.set(key, value); } },
      getTaskStore: () => ({
        tasks: memory,
        updateTask: async (_id, updates) => { Object.assign(memory[0], updates); return { success: true }; },
        // B's save lands; the app stops before C's does.
        flush: () => (memory[0].timeSpentMinutes === 62 ? new Promise<void>(() => undefined) : Promise.resolve()),
      }),
      now: () => nowMs,
    });
    await first.ensureHydrated({ autoStartFocus: true, autoStartBreaks: true });
    nowMs += 31 * 60_000;
    first.reconcile({ autoStartFocus: true, autoStartBreaks: true });
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
    expect(memory[0].timeSpentMinutes).toBe(62);
    expect(JSON.parse(device.get(POMODORO_SESSION_STORAGE_KEY)!).pendingCredits)
      .toEqual([{ taskId: 't1', from: 5, to: 30 }, { taskId: 't1', from: 12, to: 37 }, { taskId: 't1', from: 37, to: 62 }]);
    // On disk the task holds B only.
    const disk = [{ id: 't1', title: 'One', status: 'next', timeSpentMinutes: 37 } as Task];
    const second = open(device, disk);
    await second.ensureHydrated();
    await settle(second);
    expect(disk[0].timeSpentMinutes).toBe(62);
  });

  it('never moves a credit this run already wrote when the task changes before its save lands', async () => {
    const tasks = makeTasks();
    const device = new Map([[POMODORO_SESSION_STORAGE_KEY, stored]]);
    let fail = true;
    const updateTask = vi.fn(async (_id: string, updates: Partial<Task>) => { Object.assign(tasks[0], updates); return { success: true }; });
    const controller = createMobilePomodoroController({
      storage: { getItem: async (key) => device.get(key) ?? null, setItem: async (key, value) => { device.set(key, value); } },
      getTaskStore: () => ({ tasks, updateTask, flush: async () => { if (fail) throw new Error('disk full'); } }),
    });
    await controller.ensureHydrated();
    await settle(controller);
    expect(tasks[0].timeSpentMinutes).toBe(30);
    // A sync save replaces the time before the credit's save landed: the change wins, and the credit is not given again.
    tasks[0].timeSpentMinutes = 12; fail = false;
    controller.setSelectedTaskId(undefined);
    await settle(controller);
    expect(tasks[0].timeSpentMinutes).toBe(12);
    expect(updateTask).toHaveBeenCalledOnce();
  });

  it('credits two sessions of one task in a row', async () => {
    const tasks = makeTasks();
    const device = new Map([[POMODORO_SESSION_STORAGE_KEY, JSON.stringify({
      ...JSON.parse(stored),
      durations: { focusMinutes: 1, breakMinutes: 1 },
      timerState: { phase: 'focus', remainingSeconds: 60, isRunning: true },
    })]]);
    let nowMs = NOW;
    const controller = createMobilePomodoroController({
      storage: { getItem: async (key) => device.get(key) ?? null, setItem: async (key, value) => { device.set(key, value); } },
      getTaskStore: () => ({ tasks, updateTask: async (_id, updates) => { Object.assign(tasks[0], updates); return { success: true }; } }),
      now: () => nowMs,
    });
    await controller.ensureHydrated({ autoStartBreaks: true, autoStartFocus: true });
    nowMs += 61_000;
    controller.reconcile({ autoStartBreaks: true, autoStartFocus: true });
    nowMs += 61_000;
    controller.reconcile({ autoStartBreaks: true, autoStartFocus: true });
    await settle(controller);
    expect(tasks[0].timeSpentMinutes).toBe(7);
  });
});
