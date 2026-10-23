import {
  advancePomodoroState,
  createPomodoroState,
  recordPomodoroFocusSessions,
  sanitizePomodoroDurations,
  sanitizePomodoroSessionHistory,
  type PomodoroAutoStartOptions,
  type PomodoroDurations,
  type PomodoroEvent,
  type PomodoroPhase,
  type PomodoroSessionHistory,
  type PomodoroState,
} from './pomodoro';

export interface StoredPomodoroSession {
  durations?: Partial<PomodoroDurations>;
  timerState?: Partial<PomodoroState>;
  selectedTaskId?: string;
  phaseEndsAt?: string;
  sessionHistory?: Partial<PomodoroSessionHistory>;
  /** Device-local mutation clock used to reject delayed Watch timer commands. */
  updatedAtMs?: number;
}

export interface ResolvedPomodoroSession {
  durations: PomodoroDurations;
  timerState: PomodoroState;
  selectedTaskId?: string;
  phaseEndsAt?: string;
  lastEvent: PomodoroEvent | null;
  sessionHistory: PomodoroSessionHistory;
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
  historyDayKey?: string,
): ResolvedPomodoroSession => {
  const durations = sanitizePomodoroDurations(session?.durations);
  const sanitizedTimerState = sanitizePomodoroState(session?.timerState, durations);
  const sessionHistory = sanitizePomodoroSessionHistory(
    session?.sessionHistory,
    sanitizedTimerState.completedFocusSessions,
    historyDayKey
  );
  const timerState: PomodoroState = {
    ...sanitizedTimerState,
    completedFocusSessions: Math.max(
      sanitizedTimerState.completedFocusSessions,
      sessionHistory.totalCompletedFocusSessions
    ),
  };
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
      sessionHistory,
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
      sessionHistory,
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
      sessionHistory,
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
      sessionHistory,
    };
  }

  const endMs = new Date(phaseEndsAt).getTime();
  const elapsedSinceEndSeconds = Math.max(0, Math.floor((nowMs - endMs) / 1000));
  const finished = advancePomodoroState({
    ...timerState,
    isRunning: true,
    remainingSeconds: 1,
  }, durations, elapsedSinceEndSeconds + 1, autoStartOptions);
  const completedSessionDelta = finished.state.completedFocusSessions - timerState.completedFocusSessions;
  const nextSessionHistory = completedSessionDelta > 0
    ? recordPomodoroFocusSessions(sessionHistory, selectedTaskId, completedSessionDelta, historyDayKey)
    : sessionHistory;
  const nextTimerState = {
    ...finished.state,
    completedFocusSessions: Math.max(
      finished.state.completedFocusSessions,
      nextSessionHistory.totalCompletedFocusSessions
    ),
  };

  return {
    durations,
    timerState: nextTimerState,
    selectedTaskId,
    phaseEndsAt: nextTimerState.isRunning
      ? new Date(nowMs + nextTimerState.remainingSeconds * 1000).toISOString()
      : undefined,
    lastEvent: finished.lastEvent,
    sessionHistory: nextSessionHistory,
  };
};

export const startPomodoroSession = (
  session: ResolvedPomodoroSession,
  nowMs: number = Date.now(),
  autoStartOptions: PomodoroAutoStartOptions = {},
  historyDayKey?: string,
): ResolvedPomodoroSession => {
  const resolved = resolvePomodoroSession(session, nowMs, autoStartOptions, historyDayKey);
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
  historyDayKey?: string,
): ResolvedPomodoroSession => {
  const resolved = resolvePomodoroSession(session, nowMs, autoStartOptions, historyDayKey);
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
  sessionHistory: session.sessionHistory,
});
