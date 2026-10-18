import { workspaceSessionStorage as AsyncStorage } from '@/lib/workspace-session-storage';
import {
  addTimeSpentMinutes,
  createPomodoroState,
  DEFAULT_POMODORO_DURATIONS,
  resetPomodoroState,
  runStoreCommand,
  sanitizePomodoroSessionHistory,
  type PomodoroAutoStartOptions,
  type PomodoroDurations,
  type PomodoroSessionHistory,
  type Task,
  useTaskStore,
} from '@mindwtr/core';
import { useSyncExternalStore } from 'react';

import { logInfo, logWarn } from './app-log';
import {
  POMODORO_SESSION_STORAGE_KEY,
  pausePomodoroSession,
  resolvePomodoroSession,
  serializePomodoroSession,
  startPomodoroSession,
  type ResolvedPomodoroSession,
  type StoredPomodoroSession,
} from './pomodoro-session';

export type MobilePomodoroControllerState = ResolvedPomodoroSession & {
  isHydrating: boolean;
  updatedAtMs: number;
};

export type PomodoroCommandAction = 'start' | 'pause' | 'reset';
export type PomodoroCommandOutcome = 'applied' | 'already-applied' | 'stale';

type WatchCommandPolicy = {
  linkTaskEnabled?: boolean;
};

type Storage = Pick<typeof AsyncStorage, 'getItem' | 'setItem'>;
type TaskStoreAccess = () => {
  tasks: Task[];
  updateTask: (id: string, updates: Partial<Task>) => Promise<unknown>;
};

/**
 * A finished focus session's time owed to its task: the task's time moves from `from` to `to`. It is stored with the
 * session before the task is written, and leaves the session once the task holds it, so a restart between the two
 * writes credits it exactly once: a task still at `from` takes it, a task at any other time already took it (or was
 * changed since, which wins).
 */
type PomodoroCredit = { taskId: string; from?: number; to: number };

const readCredits = (value: unknown): PomodoroCredit[] => (Array.isArray(value) ? value : []).flatMap((item) => {
  const credit = item as Partial<PomodoroCredit> | null;
  if (!credit || typeof credit.taskId !== 'string' || typeof credit.to !== 'number' || !Number.isFinite(credit.to)) return [];
  const from = typeof credit.from === 'number' && Number.isFinite(credit.from) ? credit.from : undefined;
  return [{ taskId: credit.taskId, ...(from === undefined ? {} : { from }), to: credit.to }];
});

type ControllerOptions = {
  storage?: Storage;
  getTaskStore?: TaskStoreAccess;
  now?: () => number;
};

const historyEquals = (left: PomodoroSessionHistory, right: PomodoroSessionHistory): boolean => (
  left.totalCompletedFocusSessions === right.totalCompletedFocusSessions
  && left.todayDayKey === right.todayDayKey
  && left.completedTodayFocusSessions === right.completedTodayFocusSessions
  && Object.keys(left.completedFocusSessionsByTaskId).length === Object.keys(right.completedFocusSessionsByTaskId).length
  && Object.entries(left.completedFocusSessionsByTaskId).every(([taskId, count]) => (
    right.completedFocusSessionsByTaskId[taskId] === count
  ))
);

const sessionEquals = (left: ResolvedPomodoroSession, right: ResolvedPomodoroSession): boolean => (
  left.durations.focusMinutes === right.durations.focusMinutes
  && left.durations.breakMinutes === right.durations.breakMinutes
  && left.timerState.phase === right.timerState.phase
  && left.timerState.remainingSeconds === right.timerState.remainingSeconds
  && left.timerState.isRunning === right.timerState.isRunning
  && left.timerState.completedFocusSessions === right.timerState.completedFocusSessions
  && left.selectedTaskId === right.selectedTaskId
  && left.phaseEndsAt === right.phaseEndsAt
  && left.lastEvent === right.lastEvent
  && historyEquals(left.sessionHistory, right.sessionHistory)
);

const initialSession = resolvePomodoroSession({
  durations: DEFAULT_POMODORO_DURATIONS,
  timerState: createPomodoroState(DEFAULT_POMODORO_DURATIONS),
});

export function createMobilePomodoroController(options: ControllerOptions = {}) {
  const storage = options.storage ?? AsyncStorage;
  const getTaskStore = options.getTaskStore ?? (() => {
    const state = useTaskStore.getState();
    return { tasks: state.tasks, updateTask: state.updateTask };
  });
  const now = options.now ?? Date.now;
  let state: MobilePomodoroControllerState = {
    ...initialSession,
    isHydrating: true,
    updatedAtMs: 0,
  };
  let hydrationPromise: Promise<void> | null = null;
  let persistenceQueue: Promise<void> = Promise.resolve();
  /** Task credits owed, oldest first; stored with the session until their task holds them. */
  let pendingCredits: PomodoroCredit[] = [];
  /** The owed credits a load found (the app stopped between the two writes): the diagnostics log says how each settled. */
  let loadedCredits = new Set<PomodoroCredit>();
  const listeners = new Set<() => void>();

  const emit = () => listeners.forEach((listener) => listener());

  const queueCredits = (
    previous: PomodoroSessionHistory,
    next: PomodoroSessionHistory,
    focusMinutes: number,
  ) => {
    const { tasks } = getTaskStore();
    for (const [taskId, count] of Object.entries(next.completedFocusSessionsByTaskId)) {
      const delta = count - (previous.completedFocusSessionsByTaskId[taskId] ?? 0);
      if (delta <= 0) continue;
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) continue;
      // After a credit still owed to this task, from the time that credit leaves it at.
      const owed = pendingCredits.filter((credit) => credit.taskId === taskId).pop();
      const from = owed ? owed.to : task.timeSpentMinutes;
      const to = addTimeSpentMinutes(from, delta * focusMinutes);
      if (to === undefined || to === from) continue;
      pendingCredits.push({ taskId, ...(from === undefined ? {} : { from }), to });
    }
  };

  /** Each stored credit given to its task in order; the settled ones leave the session. Answers whether any settled. */
  const settleCredits = async (credits: PomodoroCredit[]): Promise<boolean> => {
    let settled = 0;
    for (const credit of credits) {
      // The from check and the write run as one command, so a time a sync save brought is never overwritten.
      const outcome = await runStoreCommand(async () => {
        const task = getTaskStore().tasks.find((candidate) => candidate.id === credit.taskId);
        if (!task || task.timeSpentMinutes !== credit.from) return 'already-applied';
        const result = await getTaskStore().updateTask(credit.taskId, { timeSpentMinutes: credit.to }).catch(() => ({ success: false }));
        return (result as { success?: boolean } | undefined)?.success === false ? null : 'applied';
      });
      if (!outcome) break;
      settled += 1;
      if (loadedCredits.has(credit)) {
        void logInfo('Pomodoro credit replayed after a restart', {
          scope: 'pomodoro',
          extra: { releaseCheck: 'v1.3.5/pomodoro-credit-once', outcome },
        });
      }
    }
    if (settled === 0) return false;
    const done = new Set(credits.slice(0, settled));
    pendingCredits = pendingCredits.filter((credit) => !done.has(credit));
    return true;
  };

  const persist = () => {
    const credits = pendingCredits.slice();
    const payload: StoredPomodoroSession & { pendingCredits?: PomodoroCredit[] } = {
      ...serializePomodoroSession(state),
      updatedAtMs: state.updatedAtMs,
      ...(credits.length > 0 ? { pendingCredits: credits } : {}),
    };
    persistenceQueue = persistenceQueue
      .catch(() => undefined)
      .then(() => storage.setItem(POMODORO_SESSION_STORAGE_KEY, JSON.stringify(payload)))
      // The credits are stored with the session first; once their task holds them, the session is stored without them.
      .then(async () => {
        if (credits.length > 0 && await settleCredits(credits)) persist();
      });
    void persistenceQueue.catch(() => {
      void logWarn('Failed to persist pomodoro session', {
        scope: 'pomodoro',
        extra: { outcome: 'write-failed' },
      });
    });
  };

  const replaceSession = (
    next: ResolvedPomodoroSession,
    config: { persist?: boolean; updatedAtMs?: number; previousHistory?: PomodoroSessionHistory } = {},
  ): boolean => {
    const previousHistory = config.previousHistory ?? state.sessionHistory;
    const changed = !sessionEquals(state, next)
      || (config.updatedAtMs !== undefined && config.updatedAtMs !== state.updatedAtMs)
      || state.isHydrating;
    if (!changed) return false;
    const owed = pendingCredits.length;
    queueCredits(previousHistory, next.sessionHistory, next.durations.focusMinutes);
    state = {
      ...next,
      isHydrating: false,
      updatedAtMs: config.updatedAtMs ?? state.updatedAtMs,
    };
    emit();
    if (config.persist !== false || pendingCredits.length > owed) persist();
    return true;
  };

  const ensureHydrated = (autoStartOptions: PomodoroAutoStartOptions = {}): Promise<void> => {
    if (hydrationPromise) return hydrationPromise;
    hydrationPromise = (async () => {
      try {
        const raw = await storage.getItem(POMODORO_SESSION_STORAGE_KEY);
        if (!raw) {
          state = { ...state, isHydrating: false };
          emit();
          return;
        }
        const parsed = JSON.parse(raw) as StoredPomodoroSession & { pendingCredits?: unknown };
        // Credits a session stored before its task held them (the app stopped in between): settled with this load.
        pendingCredits = readCredits(parsed.pendingCredits);
        loadedCredits = new Set(pendingCredits);
        const previousHistory = sanitizePomodoroSessionHistory(parsed.sessionHistory);
        const resolved = resolvePomodoroSession(parsed, now(), autoStartOptions);
        const updatedAtMs = typeof parsed.updatedAtMs === 'number' && Number.isFinite(parsed.updatedAtMs)
          ? Math.max(0, parsed.updatedAtMs)
          : 0;
        replaceSession(resolved, { previousHistory, updatedAtMs });
      } catch {
        void logWarn('Failed to restore pomodoro session', {
          scope: 'pomodoro',
          extra: { outcome: 'invalid-stored-session' },
        });
        state = { ...state, isHydrating: false };
        emit();
      }
    })();
    return hydrationPromise;
  };

  const reconcile = (autoStartOptions: PomodoroAutoStartOptions = {}, nowMs = now()): boolean => {
    if (state.isHydrating || !state.timerState.isRunning) return false;
    const next = resolvePomodoroSession(state, nowMs, autoStartOptions);
    const structuralChange = next.timerState.phase !== state.timerState.phase
      || next.timerState.isRunning !== state.timerState.isRunning
      || next.phaseEndsAt !== state.phaseEndsAt
      || !historyEquals(next.sessionHistory, state.sessionHistory);
    return replaceSession(next, { persist: structuralChange });
  };

  const mutate = (
    mutation: (current: ResolvedPomodoroSession, nowMs: number) => ResolvedPomodoroSession,
    autoStartOptions: PomodoroAutoStartOptions = {},
    nowMs = now(),
  ): boolean => {
    const current = resolvePomodoroSession(state, nowMs, autoStartOptions);
    const updatedAtMs = Math.max(nowMs, state.updatedAtMs + 1);
    return replaceSession(mutation(current, nowMs), { updatedAtMs });
  };

  const setDurations = (durations: PomodoroDurations, autoStartOptions: PomodoroAutoStartOptions = {}) => mutate((current) => ({
    ...current,
    durations,
    timerState: resetPomodoroState(current.timerState, durations, current.timerState.phase),
    phaseEndsAt: undefined,
    lastEvent: null,
  }), autoStartOptions);

  const toggle = (autoStartOptions: PomodoroAutoStartOptions = {}) => mutate((current, nowMs) => (
    current.lastEvent
      ? current
      : current.timerState.isRunning
        ? pausePomodoroSession(current, nowMs, autoStartOptions)
        : startPomodoroSession(current, nowMs, autoStartOptions)
  ), autoStartOptions);

  const reset = (autoStartOptions: PomodoroAutoStartOptions = {}) => mutate((current) => ({
    ...current,
    timerState: resetPomodoroState(current.timerState, current.durations, current.timerState.phase),
    phaseEndsAt: undefined,
    lastEvent: null,
  }), autoStartOptions);

  const switchPhase = (autoStartOptions: PomodoroAutoStartOptions = {}) => mutate((current) => ({
    ...current,
    timerState: resetPomodoroState(
      current.timerState,
      current.durations,
      current.timerState.phase === 'focus' ? 'break' : 'focus',
    ),
    phaseEndsAt: undefined,
    lastEvent: null,
  }), autoStartOptions);

  const setSelectedTaskId = (selectedTaskId: string | undefined, autoStartOptions: PomodoroAutoStartOptions = {}) => mutate((current) => ({
    ...current,
    selectedTaskId,
  }), autoStartOptions);

  const clearLastEvent = (autoStartOptions: PomodoroAutoStartOptions = {}) => mutate((current) => ({ ...current, lastEvent: null }), autoStartOptions);

  const applyWatchCommand = async (
    command: { action: PomodoroCommandAction; taskId?: string; createdAt?: string },
    autoStartOptions: PomodoroAutoStartOptions = {},
    policy: WatchCommandPolicy = {},
  ): Promise<PomodoroCommandOutcome> => {
    await ensureHydrated(autoStartOptions);
    const commandMs = command.createdAt ? new Date(command.createdAt).getTime() : now();
    const effectiveCommandMs = Number.isFinite(commandMs) ? commandMs : now();
    if (effectiveCommandMs < state.updatedAtMs) return 'stale';
    if (effectiveCommandMs === state.updatedAtMs && state.updatedAtMs > 0) {
      // A queue replay after a failed AsyncStorage write retries durability;
      // a replay after success is an idempotent extra write.
      persist();
      await persistenceQueue;
      return 'already-applied';
    }

    const current = resolvePomodoroSession(state, now(), autoStartOptions);
    const commandTask = policy.linkTaskEnabled !== false && command.taskId
      ? getTaskStore().tasks.find((task) => (
        task.id === command.taskId
        && !task.deletedAt
        && task.status !== 'done'
        && task.status !== 'archived'
      ))
      : undefined;
    const selectedTaskId = policy.linkTaskEnabled === false
      ? undefined
      : command.taskId
        ? commandTask?.id
        : current.selectedTaskId;
    let next = selectedTaskId === current.selectedTaskId ? current : { ...current, selectedTaskId };
    if (command.action === 'start') {
      if (!next.timerState.isRunning) next = startPomodoroSession(next, now(), autoStartOptions);
    } else if (command.action === 'pause') {
      if (next.timerState.isRunning) next = pausePomodoroSession(next, now(), autoStartOptions);
    } else {
      next = {
        ...next,
        timerState: resetPomodoroState(next.timerState, next.durations, next.timerState.phase),
        phaseEndsAt: undefined,
        lastEvent: null,
      };
    }
    const changed = replaceSession(next, { updatedAtMs: effectiveCommandMs });
    await persistenceQueue;
    return changed ? 'applied' : 'already-applied';
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    ensureHydrated,
    reconcile,
    setDurations,
    toggle,
    reset,
    switchPhase,
    setSelectedTaskId,
    clearLastEvent,
    applyWatchCommand,
    flushPersistence: () => persistenceQueue,
    resetForTests: () => {
      if (process.env.NODE_ENV !== 'test') return;
      listeners.clear();
      state = {
        ...resolvePomodoroSession({
          durations: DEFAULT_POMODORO_DURATIONS,
          timerState: createPomodoroState(DEFAULT_POMODORO_DURATIONS),
        }),
        isHydrating: true,
        updatedAtMs: 0,
      };
      hydrationPromise = null;
      persistenceQueue = Promise.resolve();
      pendingCredits = [];
    },
  };
}

export const mobilePomodoroController = createMobilePomodoroController();

export const useMobilePomodoroControllerState = (): MobilePomodoroControllerState => (
  useSyncExternalStore(
    mobilePomodoroController.subscribe,
    mobilePomodoroController.getSnapshot,
    mobilePomodoroController.getSnapshot,
  )
);

type MobilePomodoroNotificationState = Pick<MobilePomodoroControllerState, 'isHydrating' | 'phaseEndsAt'> & {
  phase: MobilePomodoroControllerState['timerState']['phase'];
  isRunning: boolean;
};

let notificationSnapshot: MobilePomodoroNotificationState | null = null;
const getNotificationSnapshot = (): MobilePomodoroNotificationState => {
  const current = mobilePomodoroController.getSnapshot();
  if (
    notificationSnapshot
    && notificationSnapshot.isHydrating === current.isHydrating
    && notificationSnapshot.phaseEndsAt === current.phaseEndsAt
    && notificationSnapshot.phase === current.timerState.phase
    && notificationSnapshot.isRunning === current.timerState.isRunning
  ) return notificationSnapshot;
  notificationSnapshot = {
    isHydrating: current.isHydrating,
    phaseEndsAt: current.phaseEndsAt,
    phase: current.timerState.phase,
    isRunning: current.timerState.isRunning,
  };
  return notificationSnapshot;
};

/** Stable selector: second-by-second remaining time cannot rerender RootLayout. */
export const useMobilePomodoroNotificationState = (): MobilePomodoroNotificationState => (
  useSyncExternalStore(
    mobilePomodoroController.subscribe,
    getNotificationSnapshot,
    getNotificationSnapshot,
  )
);
