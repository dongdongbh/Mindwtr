import {
  advancePomodoroState,
  createPomodoroState,
  sanitizePomodoroDurations,
  type PomodoroAutoStartOptions,
  type PomodoroDurations,
  type PomodoroEvent,
  type PomodoroPhase,
  type PomodoroState,
} from '@mindwtr/core';

export const POMODORO_SESSION_STORAGE_KEY = '@mindwtr_pomodoro_state';

export interface StoredPomodoroSession {
  durations?: Partial<PomodoroDurations>;
  timerState?: Partial<PomodoroState>;
  selectedTaskId?: string;
  phaseEndsAt?: string;
}

export interface ResolvedPomodoroSession {
  durations: PomodoroDurations;
  timerState: PomodoroState;
  selectedTaskId?: string;
  phaseEndsAt?: string;
  lastEvent: PomodoroEvent | null;
}

const isPomodoroPhase = (value: unknown): value is PomodoroPhase => value === 'focus' || value === 'break';

const sanitizePomodoroState = (
  value: Partial<PomodoroState> | undefined,
  durations: PomodoroDurations,
): PomodoroState => {
  const phase = isPomodoroPhase(value?.phase) ? value.phase : 'focus';
  const baseState = createPomodoroState(durations, phase, value?.completedFocusSessions);
  const phaseSeconds = createPomodoroState(durations, phase, baseState.completedFocusSessions).remainingSeconds;
  const remainingSeconds = typeof value?.remainingSeconds === 'number' && Number.isFinite(value.remainingSeconds)
    ? Math.max(0, Math.min(phaseSeconds, Math.floor(value.remainingSeconds)))
    : baseState.remainingSeconds;

  return {
    phase,
    remainingSeconds,
    isRunning: value?.isRunning === true,
    completedFocusSessions: baseState.completedFocusSessions,
  };
};

const getRemainingSecondsFromPhaseEnd = (phaseEndsAt: string, nowMs: number): number | null => {
  const endMs = new Date(phaseEndsAt).getTime();
  if (!Number.isFinite(endMs)) return null;
  if (endMs <= nowMs) return 0;
  return Math.max(1, Math.ceil((endMs - nowMs) / 1000));
};

export const resolvePomodoroSession = (
  session?: StoredPomodoroSession | null,
  nowMs: number = Date.now(),
  autoStartOptions: PomodoroAutoStartOptions = {},
): ResolvedPomodoroSession => {
  const durations = sanitizePomodoroDurations(session?.durations);
  const timerState = sanitizePomodoroState(session?.timerState, durations);
  const selectedTaskId = typeof session?.selectedTaskId === 'string' && session.selectedTaskId.trim().length > 0
    ? session.selectedTaskId
    : undefined;

  if (!timerState.isRunning) {
    return {
      durations,
      timerState: { ...timerState, isRunning: false },
      selectedTaskId,
      phaseEndsAt: undefined,
      lastEvent: null,
    };
  }

  const phaseEndsAt = typeof session?.phaseEndsAt === 'string' ? session.phaseEndsAt : undefined;
  if (!phaseEndsAt) {
    return {
      durations,
      timerState: { ...timerState, isRunning: false },
      selectedTaskId,
      phaseEndsAt: undefined,
      lastEvent: null,
    };
  }

  const remainingSeconds = getRemainingSecondsFromPhaseEnd(phaseEndsAt, nowMs);
  if (remainingSeconds === null) {
    return {
      durations,
      timerState: { ...timerState, isRunning: false },
      selectedTaskId,
      phaseEndsAt: undefined,
      lastEvent: null,
    };
  }

  if (remainingSeconds > 0) {
    return {
      durations,
      timerState: {
        ...timerState,
        isRunning: true,
        remainingSeconds,
      },
      selectedTaskId,
      phaseEndsAt,
      lastEvent: null,
    };
  }

  const endMs = new Date(phaseEndsAt).getTime();
  const elapsedSinceEndSeconds = Math.max(0, Math.floor((nowMs - endMs) / 1000));
  const finished = advancePomodoroState({
    ...timerState,
    isRunning: true,
    remainingSeconds: 1,
  }, durations, elapsedSinceEndSeconds + 1, autoStartOptions);

  return {
    durations,
    timerState: finished.state,
    selectedTaskId,
    phaseEndsAt: finished.state.isRunning
      ? new Date(nowMs + finished.state.remainingSeconds * 1000).toISOString()
      : undefined,
    lastEvent: finished.lastEvent,
  };
};

export const startPomodoroSession = (
  session: ResolvedPomodoroSession,
  nowMs: number = Date.now(),
  autoStartOptions: PomodoroAutoStartOptions = {},
): ResolvedPomodoroSession => {
  const resolved = resolvePomodoroSession(session, nowMs, autoStartOptions);
  const remainingSeconds = Math.max(1, resolved.timerState.remainingSeconds);
  return {
    ...resolved,
    timerState: {
      ...resolved.timerState,
      isRunning: true,
      remainingSeconds,
    },
    phaseEndsAt: new Date(nowMs + remainingSeconds * 1000).toISOString(),
    lastEvent: null,
  };
};

export const pausePomodoroSession = (
  session: ResolvedPomodoroSession,
  nowMs: number = Date.now(),
  autoStartOptions: PomodoroAutoStartOptions = {},
): ResolvedPomodoroSession => {
  const resolved = resolvePomodoroSession(session, nowMs, autoStartOptions);
  return {
    ...resolved,
    timerState: {
      ...resolved.timerState,
      isRunning: false,
    },
    phaseEndsAt: undefined,
    lastEvent: null,
  };
};

export const serializePomodoroSession = (session: ResolvedPomodoroSession): StoredPomodoroSession => ({
  durations: session.durations,
  timerState: session.timerState,
  selectedTaskId: session.selectedTaskId,
  phaseEndsAt: session.phaseEndsAt,
});
