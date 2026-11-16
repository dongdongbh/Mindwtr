import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_POMODORO_DURATIONS, getPomodoroLocalDayKey, runStoreCommand, runSyncStoreSave, useTaskStore, type Task } from '@mindwtr/core';
import { logInfo } from './app-log';

vi.mock('./app-log', () => ({ logInfo: vi.fn(async () => undefined), logWarn: vi.fn(async () => undefined) }));

// eslint-disable-next-line import/first
import { createMobilePomodoroController as createController } from './pomodoro-controller';
// eslint-disable-next-line import/first
import { POMODORO_SESSION_STORAGE_KEY } from './pomodoro-session';

const receiptIds = new WeakMap<Task, Set<string>>();
const createMobilePomodoroController = (options: Parameters<typeof createController>[0] = {}) => createController({
  ...options,
  ...(options.getTaskStore ? {
    applyCredit: async (credit) => {
      const store = options.getTaskStore!();
      const outcome = await runStoreCommand(async () => {
        const task = store.tasks.find((candidate) => candidate.id === credit.taskId);
        if (!task) return 'missing-task';
        const applied = receiptIds.get(task) ?? new Set<string>();
        if (applied.has(credit.id)) return 'already-applied';
        const result = await store.updateTask(credit.taskId, { timeSpentMinutes: (task.timeSpentMinutes ?? 0) + credit.minutes });
        if ((result as { success?: boolean })?.success === false) throw new Error('task write failed');
        applied.add(credit.id);
        receiptIds.set(task, applied);
        return 'applied';
      });
      await store.flush?.();
      return outcome;
    },
    acknowledgeCredits: async () => undefined,
  } : {}),
});

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
    expect(logInfo).toHaveBeenCalledWith('Pomodoro elapsed focus boundary resolved before action', {
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
    expect(logInfo).toHaveBeenCalledTimes(2);
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
    expect(logInfo).toHaveBeenCalledWith('Pomodoro partial work credit settled', expect.any(Object));
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
      pendingCredits: [{ id: expect.any(String), taskId: task.id, minutes: 25 }],
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

    const third = open(device, tasks);
    await third.ensureHydrated();
    await settle(third);
    expect(tasks[0].timeSpentMinutes).toBe(30);
  });

  it('credits once when the app stopped after the task write and before the session was stored again', async () => {
    const tasks = makeTasks();
    const device = new Map([[POMODORO_SESSION_STORAGE_KEY, stored]]);
    let writes = 0;

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

    const device = new Map([[POMODORO_SESSION_STORAGE_KEY, stored]]);
    const memory = makeTasks();
    const first = createMobilePomodoroController({
      storage: { getItem: async (key) => device.get(key) ?? null, setItem: async (key, value) => { device.set(key, value); } },
      getTaskStore: () => ({
        tasks: memory,
        updateTask: async (_id, updates) => { Object.assign(memory[0], updates); return { success: true }; },

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
    expect(JSON.parse(device.get(POMODORO_SESSION_STORAGE_KEY)!).pendingCredits).toEqual([{ id: expect.any(String), taskId: 't1', minutes: 25 }]);
  });

  it('keeps a credit owed when the real store gave up on its save, though its flush resolves', async () => {


    const tasks = makeTasks();
    const device = new Map([[POMODORO_SESSION_STORAGE_KEY, JSON.stringify({ ...JSON.parse(stored), timerState: { phase: 'break', remainingSeconds: 300, isRunning: false }, workSecondsByTaskId: {}, pendingCredits: [{ taskId: 't1', from: 5, to: 30 }] })]]);
    const before = useTaskStore.getState();
    useTaskStore.setState({
      tasks,
      _allTasks: tasks,

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

    controller.setSelectedTaskId(undefined);
    await settle(controller);
    expect(flushes).toBe(2);
    expect(JSON.parse(device.get(POMODORO_SESSION_STORAGE_KEY)!).pendingCredits).toEqual([{ id: expect.any(String), taskId: 't1', minutes: 25 }]);
  });

  it('checks a credit against the time a sync save published while the credit waited', async () => {
    const tasks = makeTasks();
    const device = new Map([[POMODORO_SESSION_STORAGE_KEY, stored]]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });

    const save = runSyncStoreSave(async () => { await held; tasks[0].timeSpentMinutes = 12; });
    const controller = createMobilePomodoroController({
      storage: { getItem: async (key) => device.get(key) ?? null, setItem: async (key, value) => { device.set(key, value); } },

      getTaskStore: () => ({ tasks, updateTask: (_id, updates) => runStoreCommand(async () => { Object.assign(tasks[0], updates); return { success: true }; }) }),
    });
    await controller.ensureHydrated();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    release();
    await save;
    await settle(controller);

    expect(tasks[0].timeSpentMinutes).toBe(37);
  });

  it('credits the expired focus on top of a task changed since its stored owed credit', async () => {


    const tasks = [{ id: 't1', title: 'One', status: 'next', timeSpentMinutes: 12 } as Task];
    const device = new Map([[POMODORO_SESSION_STORAGE_KEY, JSON.stringify({ ...JSON.parse(stored), pendingCredits: [{ taskId: 't1', from: 5, to: 30 }] })]]);
    const controller = open(device, tasks);
    await controller.ensureHydrated();
    await settle(controller);
    await settle(controller);
    expect(tasks[0].timeSpentMinutes).toBe(37);
    expect(JSON.parse(device.get(POMODORO_SESSION_STORAGE_KEY)!)).not.toHaveProperty('pendingCredits');
    expect(logInfo).toHaveBeenCalledWith('Pomodoro partial work credit settled', expect.any(Object));
  });

  it('stores a moved credit before its task write, so a stop before the save lands credits it at the restart', async () => {
    const device = new Map([[POMODORO_SESSION_STORAGE_KEY, JSON.stringify({ ...JSON.parse(stored), pendingCredits: [{ taskId: 't1', from: 5, to: 30 }] })]]);
    const memory = [{ id: 't1', title: 'One', status: 'next', timeSpentMinutes: 12 } as Task];
    const first = createMobilePomodoroController({
      storage: { getItem: async (key) => device.get(key) ?? null, setItem: async (key, value) => { device.set(key, value); } },
      getTaskStore: () => ({
        tasks: memory,
        updateTask: async (_id, updates) => { Object.assign(memory[0], updates); return { success: true }; },

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

    const device = new Map([[POMODORO_SESSION_STORAGE_KEY, JSON.stringify({ ...JSON.parse(stored), pendingCredits: [{ taskId: 't1', from: 5, to: 30 }] })]]);
    const memory = [{ id: 't1', title: 'One', status: 'next', timeSpentMinutes: 12 } as Task];
    let nowMs = NOW;
    const first = createMobilePomodoroController({
      storage: { getItem: async (key) => device.get(key) ?? null, setItem: async (key, value) => { device.set(key, value); } },
      getTaskStore: () => ({
        tasks: memory,
        updateTask: async (_id, updates) => { Object.assign(memory[0], updates); return { success: true }; },

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
      .toEqual([{ taskId: 't1', from: 5, to: 30 }, { id: expect.any(String), taskId: 't1', minutes: 25 }, { id: expect.any(String), taskId: 't1', minutes: 25 }]);

    const disk = [{ id: 't1', title: 'One', status: 'next', timeSpentMinutes: 37 } as Task];
    const persistedCredits = JSON.parse(device.get(POMODORO_SESSION_STORAGE_KEY)!).pendingCredits;
    receiptIds.set(disk[0], new Set([persistedCredits[1].id]));
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


describe('partial linked work accounting', () => {
  const createHarness = () => {
    let nowMs = Date.parse('2026-11-16T12:00:00Z');
    const tasks = [
      { id: 'partial-a', title: 'First', status: 'next', timeSpentMinutes: 5 } as Task,
      { id: 'partial-b', title: 'Second', status: 'next', timeSpentMinutes: 10 } as Task,
    ];
    const device = new Map<string, string>();
    const receipts = new Set<string>();
    const storage = {
      getItem: vi.fn(async (id: string) => device.get(id) ?? null),
      setItem: vi.fn(async (id: string, value: string) => { device.set(id, value); }),
    };
    const applyCredit = vi.fn(async (credit: { id: string; taskId: string; minutes: number }): Promise<'applied' | 'already-applied' | 'missing-task'> => {
      const journal = JSON.parse(device.get(POMODORO_SESSION_STORAGE_KEY)!);
      expect(journal.pendingCredits.some((pending: { id?: string }) => pending.id === credit.id)).toBe(true);
      if (receipts.has(credit.id)) return 'already-applied';
      const task = tasks.find((candidate) => candidate.id === credit.taskId);
      if (!task) return 'missing-task';
      task.timeSpentMinutes = (task.timeSpentMinutes ?? 0) + credit.minutes;
      receipts.add(credit.id);
      return 'applied';
    });
    const acknowledgeCredits = vi.fn(async (ids: string[]) => { ids.forEach((id) => receipts.delete(id)); });
    const open = () => createController({
      storage, now: () => nowMs, applyCredit, acknowledgeCredits,
      getTaskStore: () => ({ tasks, updateTask: vi.fn(async () => ({ success: true })) }),
    });
    return { tasks, device, storage, receipts, applyCredit, acknowledgeCredits, open, advance: (seconds: number) => { nowMs += seconds * 1000; }, now: () => nowMs };
  };

  it('carries three twenty-second runs through pause and restart without per-tick task writes', async () => {
    const h = createHarness();
    let controller = h.open();
    await controller.ensureHydrated();
    controller.setSelectedTaskId(h.tasks[0].id);
    for (let run = 0; run < 3; run += 1) {
      controller.toggle();
      await controller.flushPersistence();
      const writes = h.storage.setItem.mock.calls.length;
      for (let tick = 0; tick < 20; tick += 1) {
        h.advance(1);
        controller.reconcile();
      }
      expect(h.storage.setItem).toHaveBeenCalledTimes(writes);
      expect(h.applyCredit).toHaveBeenCalledTimes(0);
      controller.toggle();
      await controller.flushPersistence();
      if (run < 2) {
        expect(h.tasks[0].timeSpentMinutes).toBe(5);
        controller = h.open();
        await controller.ensureHydrated();
        await controller.flushPersistence();
      }
    }
    expect(h.tasks[0].timeSpentMinutes).toBe(6);
    expect(controller.getSnapshot().workSecondsByTaskId?.[h.tasks[0].id] ?? 0).toBe(0);
    expect(controller.getSnapshot().sessionHistory.totalCompletedFocusSessions).toBe(0);
  });

  it('credits eight, four and thirteen minutes without crediting pauses or a second completed session', async () => {
    const h = createHarness();
    const controller = h.open();
    await controller.ensureHydrated();
    controller.setSelectedTaskId(h.tasks[0].id);
    for (const minutes of [8, 4, 13]) {
      controller.toggle();
      h.advance(minutes * 60);
      controller.reconcile();
      if (controller.getSnapshot().timerState.isRunning) controller.toggle();
      await controller.flushPersistence();
      h.advance(300);
      controller.reconcile();
    }
    expect(h.tasks[0].timeSpentMinutes).toBe(30);
    expect(controller.getSnapshot().sessionHistory.totalCompletedFocusSessions).toBe(1);
    expect(h.applyCredit.mock.calls.map(([credit]) => credit.minutes)).toEqual([8, 4, 13]);
  });

  it('settles reset, preset and task switch to each original owner while retaining remainders', async () => {
    const h = createHarness();
    const controller = h.open();
    await controller.ensureHydrated();
    controller.setSelectedTaskId(h.tasks[0].id);
    controller.toggle();
    h.advance(40);
    controller.reset();
    controller.toggle();
    h.advance(40);
    controller.setDurations({ focusMinutes: 50, breakMinutes: 10 });
    controller.toggle();
    h.advance(40);
    controller.setSelectedTaskId(h.tasks[1].id);
    h.advance(80);
    controller.switchPhase();
    controller.toggle();
    h.advance(80);
    controller.toggle();
    await controller.flushPersistence();
    expect(h.tasks.map((task) => task.timeSpentMinutes)).toEqual([7, 11]);
    expect(controller.getSnapshot().workSecondsByTaskId?.[h.tasks[1].id]).toBe(20);
    expect(controller.getSnapshot().sessionHistory.totalCompletedFocusSessions).toBe(0);
  });

  it('settles the previous owner when Watch starts another task on the running timer', async () => {
    const h = createHarness();
    const controller = h.open();
    await controller.applyWatchCommand({ action: 'start', taskId: h.tasks[0].id, createdAt: new Date(h.now()).toISOString() });
    h.advance(80);
    await controller.applyWatchCommand({ action: 'start', taskId: h.tasks[1].id, createdAt: new Date(h.now()).toISOString() });
    h.advance(80);
    await controller.applyWatchCommand({ action: 'pause', createdAt: new Date(h.now()).toISOString() });
    expect(h.tasks.map((task) => task.timeSpentMinutes)).toEqual([6, 11]);
    expect(controller.getSnapshot().workSecondsByTaskId).toEqual({ [h.tasks[0].id]: 20, [h.tasks[1].id]: 20 });
  });

  it('caps global completion at completedAt after later ticks, detaches and keeps effort after undo', async () => {
    const h = createHarness();
    const controller = h.open();
    await controller.ensureHydrated();
    controller.setSelectedTaskId(h.tasks[0].id);
    controller.toggle();
    h.advance(95);
    const completedAt = new Date(h.now()).toISOString();
    h.advance(50);
    controller.reconcile();
    h.tasks[0].status = 'done';
    h.tasks[0].completedAt = completedAt;
    controller.reconcileTaskCompletion();
    await controller.flushPersistence();
    expect(h.tasks[0].timeSpentMinutes).toBe(6);
    expect(controller.getSnapshot()).toMatchObject({
      timerState: { isRunning: false },
      workSecondsByTaskId: { [h.tasks[0].id]: 35 },
    });
    expect(controller.getSnapshot().selectedTaskId).toBeUndefined();
    h.tasks[0].status = 'next';
    h.tasks.push({ ...h.tasks[0], id: 'recurring-next', timeSpentMinutes: undefined });
    h.advance(600);
    controller.reconcile();
    await controller.flushPersistence();
    expect(h.tasks[0].timeSpentMinutes).toBe(6);
    expect(h.tasks.at(-1)?.timeSpentMinutes).toBeUndefined();
  });

  it('pauses a restored completed task at its completion timestamp before hydration credits elapsed time', async () => {
    const h = createHarness();
    const controller = h.open();
    await controller.ensureHydrated();
    controller.setSelectedTaskId(h.tasks[0].id);
    controller.toggle();
    await controller.flushPersistence();
    h.advance(90);
    h.tasks[0].completedAt = new Date(h.now()).toISOString();
    h.tasks[0].status = 'done';
    h.advance(600);
    const restarted = h.open();
    await restarted.ensureHydrated();
    await restarted.flushPersistence();
    expect(h.tasks[0].timeSpentMinutes).toBe(6);
    expect(restarted.getSnapshot().timerState.isRunning).toBe(false);
    expect(restarted.getSnapshot().selectedTaskId).toBeUndefined();
    expect(restarted.getSnapshot().workSecondsByTaskId?.[h.tasks[0].id]).toBe(30);
  });

  it('preserves credited effort when a backdated completion predates the latest resume', async () => {
    const h = createHarness();
    const controller = h.open();
    await controller.ensureHydrated();
    controller.setSelectedTaskId(h.tasks[0].id);
    controller.toggle();
    h.advance(120);
    controller.toggle();
    await controller.flushPersistence();
    const oldCompletion = new Date(h.now() - 60_000).toISOString();
    h.advance(30);
    controller.toggle();
    h.advance(60);
    h.tasks[0].status = 'done';
    h.tasks[0].completedAt = oldCompletion;
    controller.reconcileTaskCompletion();
    await controller.flushPersistence();
    expect(h.tasks[0].timeSpentMinutes).toBe(8);
    expect(controller.getSnapshot().timerState).toMatchObject({ remainingSeconds: 1320, isRunning: false });
  });

  it('replays the stable receipt after removal persistence fails even if manual time equals its old target', async () => {
    const h = createHarness();
    const controller = h.open();
    await controller.ensureHydrated();
    controller.setSelectedTaskId(h.tasks[0].id);
    controller.toggle();
    await controller.flushPersistence();
    h.advance(120);
    let writes = 0;
    const setItem = h.storage.setItem.getMockImplementation()!;
    h.storage.setItem.mockImplementation(async (id, value) => {
      writes += 1;
      if (writes === 2) throw new Error('removal failed');
      await setItem(id, value);
    });
    controller.toggle();
    await expect(controller.flushPersistence()).rejects.toThrow('removal failed');
    const creditId = h.applyCredit.mock.calls[0][0].id;
    expect(h.receipts.has(creditId)).toBe(true);
    expect(h.acknowledgeCredits).not.toHaveBeenCalledWith([creditId]);
    h.tasks[0].timeSpentMinutes = 5;
    const restarted = h.open();
    await restarted.ensureHydrated();
    await restarted.flushPersistence();
    expect(h.tasks[0].timeSpentMinutes).toBe(5);
    expect(h.applyCredit.mock.calls.at(-1)?.[0].id).toBe(creditId);
    expect(h.receipts.has(creditId)).toBe(false);
    expect(JSON.parse(h.device.get(POMODORO_SESSION_STORAGE_KEY)!)).not.toHaveProperty('pendingCredits');
  });

  it('drains a second transition queued while the first receipt is being applied', async () => {
    const h = createHarness();
    const apply = h.applyCredit.getMockImplementation()!;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    h.applyCredit.mockImplementationOnce(async (credit) => { await waiting; return apply(credit); });
    const controller = h.open();
    await controller.ensureHydrated();
    controller.setSelectedTaskId(h.tasks[0].id);
    controller.toggle();
    await controller.flushPersistence();
    h.advance(60);
    controller.toggle();
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    controller.toggle();
    h.advance(60);
    controller.toggle();
    release();
    await controller.flushPersistence();
    expect(h.tasks[0].timeSpentMinutes).toBe(7);
    expect(h.applyCredit.mock.calls).toHaveLength(2);
    expect(new Set(h.applyCredit.mock.calls.map(([credit]) => credit.id)).size).toBe(2);
    expect(JSON.parse(h.device.get(POMODORO_SESSION_STORAGE_KEY)!)).not.toHaveProperty('pendingCredits');
  });

  it('retains a new credit requested while the prior receipt removal is being stored', async () => {
    const h = createHarness();
    const controller = h.open();
    await controller.ensureHydrated();
    controller.setSelectedTaskId(h.tasks[0].id);
    controller.toggle();
    await controller.flushPersistence();
    let release!: () => void;
    let held = false;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const write = h.storage.setItem.getMockImplementation()!;
    h.storage.setItem.mockImplementation(async (id, value) => {
      if (!held && h.applyCredit.mock.calls.length === 1 && !JSON.parse(value).pendingCredits) {
        held = true;
        await waiting;
      }
      await write(id, value);
    });
    h.advance(60);
    controller.toggle();
    await vi.waitFor(() => expect(held).toBe(true));
    controller.toggle();
    h.advance(60);
    controller.toggle();
    release();
    await controller.flushPersistence();
    expect(h.tasks[0].timeSpentMinutes).toBe(7);
    expect(h.applyCredit).toHaveBeenCalledTimes(2);
    expect(JSON.parse(h.device.get(POMODORO_SESSION_STORAGE_KEY)!)).not.toHaveProperty('pendingCredits');
  });

});
