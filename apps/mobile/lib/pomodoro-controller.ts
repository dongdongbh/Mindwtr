import { workspaceSessionStorage as AsyncStorage } from '@/lib/workspace-session-storage';
import {
  addTimeSpentMinutes,
  acknowledgePomodoroCredits,
  applyPomodoroCredit,
  generateUUID,
  settlePomodoroWork,
  type PomodoroCredit,
  createPomodoroState,
  DEFAULT_POMODORO_DURATIONS,
  resetPomodoroState,
  flushPendingSave,
  runStoreCommand,
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

  flush?: () => Promise<void>;
};


type LegacyPomodoroCredit = { taskId: string; from?: number; to: number };
type PendingPomodoroCredit = PomodoroCredit | LegacyPomodoroCredit;

const readCredits = (value: unknown): PendingPomodoroCredit[] => (Array.isArray(value) ? value : []).flatMap((item): PendingPomodoroCredit[] => {
  if (!item || typeof item !== 'object' || typeof item.taskId !== 'string') return [];
  if (typeof item.id === 'string' && Number.isSafeInteger(item.minutes) && item.minutes > 0) {
    return [{ id: item.id, taskId: item.taskId, minutes: item.minutes }];
  }
  if (typeof item.to !== 'number' || !Number.isFinite(item.to)) return [];
  const from = typeof item.from === 'number' && Number.isFinite(item.from) ? item.from : undefined;
  return [{ taskId: item.taskId, ...(from === undefined ? {} : { from }), to: item.to }];
});

type ControllerOptions = {
  storage?: Storage;
  getTaskStore?: TaskStoreAccess;
  now?: () => number;
  applyCredit?: typeof applyPomodoroCredit;
  acknowledgeCredits?: typeof acknowledgePomodoroCredits;
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
  && JSON.stringify(left.workSecondsByTaskId) === JSON.stringify(right.workSecondsByTaskId)
);

const initialSession = resolvePomodoroSession({
  durations: DEFAULT_POMODORO_DURATIONS,
  timerState: createPomodoroState(DEFAULT_POMODORO_DURATIONS),
});

export function createMobilePomodoroController(options: ControllerOptions = {}) {
  const storage = options.storage ?? AsyncStorage;
  const getTaskStore = options.getTaskStore ?? (() => {
    const state = useTaskStore.getState();
    return {
      tasks: state._allTasks ?? state.tasks,
      updateTask: state.updateTask,


      flush: async () => {
        await flushPendingSave();
        if (useTaskStore.getState().persistenceFailure !== null) throw new Error('The task store has an unsaved change');
      },
    };
  });
  const now = options.now ?? (() => Date.now());
  const applyCredit = options.applyCredit ?? applyPomodoroCredit;
  const acknowledgeCredits = options.acknowledgeCredits ?? acknowledgePomodoroCredits;
  let state: MobilePomodoroControllerState = {
    ...initialSession,
    isHydrating: true,
    updatedAtMs: 0,
  };
  let workCheckpoint: ResolvedPomodoroSession = state;
  let workCheckpointAtMs = 0;
  let hydrationPromise: Promise<void> | null = null;
  let persistenceQueue: Promise<void> = Promise.resolve();

  let pendingCredits: PendingPomodoroCredit[] = [];

  let loadedCredits = new Set<PendingPomodoroCredit>();

  const writtenCredits = new WeakSet<PendingPomodoroCredit>();
  const listeners = new Set<() => void>();

  const emit = () => listeners.forEach((listener) => listener());

  const payloadOf = (credits: PendingPomodoroCredit[]): StoredPomodoroSession & { pendingCredits?: PendingPomodoroCredit[] } => ({
    ...serializePomodoroSession(state),
    updatedAtMs: state.updatedAtMs,
    ...(credits.length > 0 ? { pendingCredits: credits.slice() } : {}),
  });


  const settleCredits = async (credits: PendingPomodoroCredit[]): Promise<PendingPomodoroCredit[]> => {
    let settled = 0;
    for (const credit of credits) {
      if ('id' in credit) {
        try {
          const outcome = await applyCredit(credit);
          void logInfo('Pomodoro partial work credit settled', {
            scope: 'pomodoro',
            extra: { releaseCheck: 'v1.3.9/pomodoro-partial-work', outcome, minutes: credit.minutes },
          });
          settled += 1;
        } catch {
          break;
        }
        continue;
      }

      const outcome = await runStoreCommand(async () => {
        const task = getTaskStore().tasks.find((candidate) => candidate.id === credit.taskId);
        if (!task) return 'already-applied';

        if (task.timeSpentMinutes === credit.to && credit.to !== credit.from) return 'written';
        if (task.timeSpentMinutes !== credit.from) {


          if (loadedCredits.has(credit) || writtenCredits.has(credit)) return 'already-applied';
          const from = task.timeSpentMinutes;
          let chainTo = credit.to;
          credit.to = addTimeSpentMinutes(from, credit.to - (credit.from ?? 0)) ?? credit.to;
          if (from === undefined) delete credit.from; else credit.from = from;

          let movedTo = credit.to;
          for (const later of pendingCredits.slice(pendingCredits.indexOf(credit) + 1)) {
            if ('id' in later || later.taskId !== credit.taskId || later.from !== chainTo || loadedCredits.has(later)) continue;
            chainTo = later.to;
            later.to = addTimeSpentMinutes(movedTo, later.to - later.from) ?? later.to;
            later.from = movedTo;
            movedTo = later.to;
          }

          if (!await storage.setItem(POMODORO_SESSION_STORAGE_KEY, JSON.stringify(payloadOf(pendingCredits))).then(() => true, () => false)) return null;
          void logInfo('Pomodoro credit moved onto the task time', {
            scope: 'pomodoro',
            extra: { releaseCheck: 'v1.3.8/pomodoro-credit-moved', outcome: 'moved' },
          });
        }
        const result = await getTaskStore().updateTask(credit.taskId, { timeSpentMinutes: credit.to }).catch(() => ({ success: false }));
        if ((result as { success?: boolean } | undefined)?.success === false) return null;
        writtenCredits.add(credit);
        return 'applied';
      });
      if (!outcome) break;


      if (outcome !== 'already-applied' && !await (getTaskStore().flush?.() ?? Promise.resolve()).then(() => true, () => false)) {
        void logWarn('Pomodoro credit kept owed: the task save did not finish', {
          scope: 'pomodoro',
          extra: { releaseCheck: 'v1.3.8/pomodoro-credit-durable', outcome: 'owed' },
        });
        break;
      }
      settled += 1;
      if (loadedCredits.has(credit)) {
        void logInfo('Pomodoro credit replayed after a restart', {
          scope: 'pomodoro',

          extra: { releaseCheck: 'v1.3.5/pomodoro-credit-once', outcome: outcome === 'written' ? 'already-applied' : outcome },
        });
      }
    }
    return credits.slice(0, settled);
  };

  let requestedPayload: ReturnType<typeof payloadOf> | null = null;
  let latestPayload = payloadOf([]);
  let isPersisting = false;

  const persist = () => {
    latestPayload = payloadOf(pendingCredits);
    requestedPayload = latestPayload;
    if (isPersisting) return;
    isPersisting = true;
    persistenceQueue = persistenceQueue.catch(() => undefined).then(async () => {
      try {
        while (requestedPayload) {
          const payload = requestedPayload;
          requestedPayload = null;
          await storage.setItem(POMODORO_SESSION_STORAGE_KEY, JSON.stringify(payload));
          const settled = await settleCredits(payload.pendingCredits ?? []);
          if (settled.length === 0) continue;
          const done = new Set(settled);
          const remaining = pendingCredits.filter((credit) => !done.has(credit));
          const removalSource = latestPayload;
          const removalPayload = { ...removalSource, pendingCredits: remaining.length > 0 ? remaining : undefined };
          await storage.setItem(POMODORO_SESSION_STORAGE_KEY, JSON.stringify(removalPayload));
          pendingCredits = pendingCredits.filter((credit) => !done.has(credit));
          latestPayload = latestPayload === removalSource
            ? removalPayload
            : { ...latestPayload, pendingCredits: pendingCredits.length > 0 ? pendingCredits.slice() : undefined };
          if (requestedPayload) requestedPayload = latestPayload;
          await acknowledgeCredits(settled.flatMap((credit) => 'id' in credit ? [credit.id] : [])).catch(() => undefined);
        }
      } finally {
        isPersisting = false;
      }
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
    config: { persist?: boolean; updatedAtMs?: number; settle?: boolean } = {},
  ): boolean => {
    const owed = pendingCredits.length;
    if (config.settle !== false) {
      const settled = settlePomodoroWork(next.workSecondsByTaskId ?? {});
      next = { ...next, workSecondsByTaskId: settled.workSecondsByTaskId };
      pendingCredits.push(...settled.credits.map((credit) => ({ ...credit, id: generateUUID() })));

    }
    const changed = !sessionEquals(state, next)
      || (config.updatedAtMs !== undefined && config.updatedAtMs !== state.updatedAtMs)
      || state.isHydrating
      || pendingCredits.length > owed;
    if (!changed) return false;
    state = {
      ...next,
      isHydrating: false,
      updatedAtMs: config.updatedAtMs ?? state.updatedAtMs,
    };
    if (config.settle !== false) {
      workCheckpoint = state;
      workCheckpointAtMs = now();
    }
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

        pendingCredits = readCredits(parsed.pendingCredits);
        loadedCredits = new Set(pendingCredits);
        const updatedAtMs = typeof parsed.updatedAtMs === 'number' && Number.isFinite(parsed.updatedAtMs)
          ? Math.max(0, parsed.updatedAtMs)
          : 0;
        const task = getTaskStore().tasks.find((candidate) => candidate.id === parsed.selectedTaskId);
        const terminal = task && (task.status === 'done' || task.status === 'archived' || !!task.deletedAt);
        const completedAtMs = task?.completedAt ? Date.parse(task.completedAt) : NaN;
        const resolveAtMs = terminal && Number.isFinite(completedAtMs) && completedAtMs >= updatedAtMs
          ? Math.min(now(), completedAtMs)
          : now();
        const resolved = resolvePomodoroSession(parsed, resolveAtMs, autoStartOptions);
        if (terminal) {
          resolved.timerState = { ...resolved.timerState, isRunning: false };
          resolved.selectedTaskId = undefined;
          resolved.phaseEndsAt = undefined;
          resolved.lastEvent = null;
        }
        replaceSession(resolved, { updatedAtMs });
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
    if (state.isHydrating) return false;
    if (reconcileTaskCompletion(autoStartOptions, nowMs)) return true;
    if (!state.timerState.isRunning) return false;
    const next = resolvePomodoroSession(state, nowMs, autoStartOptions);
    const structuralChange = next.timerState.phase !== state.timerState.phase
      || next.timerState.isRunning !== state.timerState.isRunning
      || next.phaseEndsAt !== state.phaseEndsAt
      || !historyEquals(next.sessionHistory, state.sessionHistory);
    return replaceSession(next, { persist: structuralChange, settle: structuralChange });
  };

  const mutate = (
    mutation: (current: ResolvedPomodoroSession, nowMs: number) => ResolvedPomodoroSession,
    autoStartOptions: PomodoroAutoStartOptions = {},
    nowMs = now(),
  ): boolean => {
    reconcileTaskCompletion(autoStartOptions, nowMs);
    const completedBeforeAction = state.sessionHistory.totalCompletedFocusSessions;
    const current = resolvePomodoroSession(state, nowMs, autoStartOptions);
    const updatedAtMs = Math.max(nowMs, state.updatedAtMs + 1);
    const changed = replaceSession(mutation(current, nowMs), { updatedAtMs });
    if (changed && current.sessionHistory.totalCompletedFocusSessions > completedBeforeAction) {
      void logInfo('Pomodoro elapsed focus boundary resolved before action', {
        scope: 'pomodoro',
        extra: { releaseCheck: 'v1.3.5/pomodoro-rn-boundary', outcome: 'elapsed-focus-resolved' },
      }).catch(() => undefined);
    }
    return changed;
  };

  const completeSelectedTask = (autoStartOptions: PomodoroAutoStartOptions = {}, completedAtMs = now()): boolean => {
    if (state.isHydrating || !state.selectedTaskId) return false;
    const source = workCheckpoint.selectedTaskId === state.selectedTaskId
      && workCheckpoint.timerState.isRunning
      && completedAtMs >= workCheckpointAtMs
      ? workCheckpoint
      : state;
    const resolutionAtMs = completedAtMs >= workCheckpointAtMs ? completedAtMs : now();
    const current = resolvePomodoroSession(source, resolutionAtMs, autoStartOptions);
    return replaceSession({
      ...current,
      timerState: { ...current.timerState, isRunning: false },
      selectedTaskId: undefined,
      phaseEndsAt: undefined,
      lastEvent: null,
    }, { updatedAtMs: Math.max(now(), state.updatedAtMs + 1) });
  };

  const reconcileTaskCompletion = (autoStartOptions: PomodoroAutoStartOptions = {}, nowMs = now()): boolean => {
    if (state.isHydrating || !state.selectedTaskId) return false;
    const task = getTaskStore().tasks.find((candidate) => candidate.id === state.selectedTaskId);
    if (!task || (!task.deletedAt && task.status !== 'done' && task.status !== 'archived')) return false;
    const completedAtMs = task.completedAt ? Date.parse(task.completedAt) : NaN;
    return completeSelectedTask(autoStartOptions, Number.isFinite(completedAtMs) ? Math.min(nowMs, completedAtMs) : nowMs);
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


      persist();
      await persistenceQueue;
      return 'already-applied';
    }

    const commandNowMs = now();
    reconcileTaskCompletion(autoStartOptions, commandNowMs);
    const current = resolvePomodoroSession(state, commandNowMs, autoStartOptions);
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
      if (!next.timerState.isRunning) next = startPomodoroSession(next, commandNowMs, autoStartOptions);
    } else if (command.action === 'pause') {
      if (next.timerState.isRunning) next = pausePomodoroSession(next, commandNowMs, autoStartOptions);
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
    completeSelectedTask,
    reconcileTaskCompletion,
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
      workCheckpoint = state;
      workCheckpointAtMs = 0;
      hydrationPromise = null;
      persistenceQueue = Promise.resolve();
      pendingCredits = [];
      loadedCredits = new Set();
      requestedPayload = null;
      latestPayload = payloadOf([]);
      isPersisting = false;
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


export const useMobilePomodoroNotificationState = (): MobilePomodoroNotificationState => (
  useSyncExternalStore(
    mobilePomodoroController.subscribe,
    getNotificationSnapshot,
    getNotificationSnapshot,
  )
);
