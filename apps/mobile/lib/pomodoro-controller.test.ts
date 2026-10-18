import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_POMODORO_DURATIONS, getPomodoroLocalDayKey, runStoreCommand, runSyncStoreSave, type Task } from '@mindwtr/core';

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
    expect(tasks[0].timeSpentMinutes).toBe(12);
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
