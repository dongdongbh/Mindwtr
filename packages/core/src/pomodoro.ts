import type { Task } from './types';

export type PomodoroPhase = 'focus' | 'break';
export type PomodoroEvent = 'focus-finished' | 'break-finished';

export interface PomodoroDurations {
    focusMinutes: number;
    breakMinutes: number;
}

export interface PomodoroAutoStartOptions {
    autoStartFocus?: boolean;
    autoStartBreaks?: boolean;
}

export interface PomodoroState {
    phase: PomodoroPhase;
    remainingSeconds: number;
    isRunning: boolean;
    completedFocusSessions: number;
}

export interface PomodoroSessionHistory {
    totalCompletedFocusSessions: number;
    completedFocusSessionsByTaskId: Record<string, number>;
    /** Local YYYY-MM-DD the today-count belongs to; rolls over automatically. */
    todayDayKey: string;
    /** Sessions completed on todayDayKey — the count the panels display (#833). */
    completedTodayFocusSessions: number;
}

export interface PomodoroTickResult {
    state: PomodoroState;
    switchedPhase: boolean;
    completedFocusSession: boolean;
}

export interface PomodoroAdvanceResult {
    state: PomodoroState;
    lastEvent: PomodoroEvent | null;
}

export interface PomodoroPreset extends PomodoroDurations {
    id: 'quick' | 'classic' | 'deep' | 'custom';
    label: string;
}

export const DEFAULT_POMODORO_DURATIONS: PomodoroDurations = {
    focusMinutes: 25,
    breakMinutes: 5,
};

export const POMODORO_PRESETS: readonly PomodoroPreset[] = [
    { id: 'quick', label: '15/3', focusMinutes: 15, breakMinutes: 3 },
    { id: 'classic', label: '25/5', focusMinutes: 25, breakMinutes: 5 },
    { id: 'deep', label: '50/10', focusMinutes: 50, breakMinutes: 10 },
] as const;

const MIN_MINUTES = 1;
const MAX_MINUTES = 180;

function clampMinutes(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    const rounded = Math.round(value);
    if (rounded < MIN_MINUTES) return MIN_MINUTES;
    if (rounded > MAX_MINUTES) return MAX_MINUTES;
    return rounded;
}

export function sanitizePomodoroDurations(value?: Partial<PomodoroDurations>): PomodoroDurations {
    return {
        focusMinutes: clampMinutes(value?.focusMinutes, DEFAULT_POMODORO_DURATIONS.focusMinutes),
        breakMinutes: clampMinutes(value?.breakMinutes, DEFAULT_POMODORO_DURATIONS.breakMinutes),
    };
}

export function createPomodoroCustomPreset(value?: Partial<PomodoroDurations>): PomodoroPreset | null {
    if (!value || (value.focusMinutes === undefined && value.breakMinutes === undefined)) {
        return null;
    }

    const durations = sanitizePomodoroDurations(value);
    const matchesBuiltInPreset = POMODORO_PRESETS.some(
        (preset) => preset.focusMinutes === durations.focusMinutes && preset.breakMinutes === durations.breakMinutes
    );

    if (matchesBuiltInPreset) return null;

    return {
        id: 'custom',
        label: `${durations.focusMinutes}/${durations.breakMinutes}`,
        ...durations,
    };
}

export function getPomodoroPresetOptions(customDurations?: Partial<PomodoroDurations>): readonly PomodoroPreset[] {
    const customPreset = createPomodoroCustomPreset(customDurations);
    return customPreset ? [...POMODORO_PRESETS, customPreset] : POMODORO_PRESETS;
}

export function getPomodoroPhaseSeconds(phase: PomodoroPhase, durations: PomodoroDurations = DEFAULT_POMODORO_DURATIONS): number {
    const normalized = sanitizePomodoroDurations(durations);
    const minutes = phase === 'focus' ? normalized.focusMinutes : normalized.breakMinutes;
    return minutes * 60;
}

function sanitizeCompletedSessionCount(value: unknown, fallback = 0): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return Math.max(0, Math.floor(fallback));
    return Math.max(0, Math.floor(value));
}

export function getPomodoroLocalDayKey(nowMs = Date.now()): string {
    const date = new Date(nowMs);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export function sanitizePomodoroSessionHistory(
    value?: Partial<PomodoroSessionHistory> | null,
    fallbackTotalCompletedFocusSessions = 0,
    todayDayKey: string = getPomodoroLocalDayKey()
): PomodoroSessionHistory {
    const completedFocusSessionsByTaskId: Record<string, number> = {};
    const rawByTaskId = value?.completedFocusSessionsByTaskId;

    if (rawByTaskId && typeof rawByTaskId === 'object' && !Array.isArray(rawByTaskId)) {
        for (const [rawTaskId, rawCount] of Object.entries(rawByTaskId)) {
            const taskId = rawTaskId.trim();
            if (!taskId) continue;
            const count = sanitizeCompletedSessionCount(rawCount);
            if (count <= 0) continue;
            completedFocusSessionsByTaskId[taskId] = count;
        }
    }

    const taskTotal = Object.values(completedFocusSessionsByTaskId)
        .reduce((sum, count) => sum + count, 0);
    const totalCompletedFocusSessions = Math.max(
        sanitizeCompletedSessionCount(value?.totalCompletedFocusSessions),
        sanitizeCompletedSessionCount(fallbackTotalCompletedFocusSessions),
        taskTotal
    );

    // The today-count survives a reload only while the stored day key still is
    // today; a stale or missing key (including pre-daily-count stored data)
    // starts the day at zero.
    const completedTodayFocusSessions = value?.todayDayKey === todayDayKey
        ? sanitizeCompletedSessionCount(value?.completedTodayFocusSessions)
        : 0;

    return {
        totalCompletedFocusSessions,
        completedFocusSessionsByTaskId,
        todayDayKey,
        completedTodayFocusSessions,
    };
}

/** The count the panels display: today's sessions, zero once the local day rolls. */
export function getPomodoroFocusSessionsCompletedToday(
    history: Partial<PomodoroSessionHistory> | undefined,
    todayDayKey: string = getPomodoroLocalDayKey()
): number {
    if (!history || history.todayDayKey !== todayDayKey) return 0;
    return sanitizeCompletedSessionCount(history.completedTodayFocusSessions);
}

export function recordPomodoroFocusSessions(
    history: Partial<PomodoroSessionHistory> | undefined,
    taskId?: string,
    completedSessions = 1,
    todayDayKey: string = getPomodoroLocalDayKey()
): PomodoroSessionHistory {
    const sanitized = sanitizePomodoroSessionHistory(history, 0, todayDayKey);
    const increment = sanitizeCompletedSessionCount(completedSessions);
    if (increment <= 0) return sanitized;

    const next: PomodoroSessionHistory = {
        totalCompletedFocusSessions: sanitized.totalCompletedFocusSessions + increment,
        completedFocusSessionsByTaskId: { ...sanitized.completedFocusSessionsByTaskId },
        todayDayKey: sanitized.todayDayKey,
        completedTodayFocusSessions: sanitized.completedTodayFocusSessions + increment,
    };
    const normalizedTaskId = taskId?.trim();
    if (normalizedTaskId) {
        next.completedFocusSessionsByTaskId[normalizedTaskId] = (
            next.completedFocusSessionsByTaskId[normalizedTaskId] ?? 0
        ) + increment;
    }

    return next;
}

export function createPomodoroState(
    durations: PomodoroDurations = DEFAULT_POMODORO_DURATIONS,
    phase: PomodoroPhase = 'focus',
    completedFocusSessions = 0
): PomodoroState {
    return {
        phase,
        remainingSeconds: getPomodoroPhaseSeconds(phase, durations),
        isRunning: false,
        completedFocusSessions: Math.max(0, Math.floor(completedFocusSessions)),
    };
}

export function resetPomodoroState(
    state: PomodoroState,
    durations: PomodoroDurations = DEFAULT_POMODORO_DURATIONS,
    phase: PomodoroPhase = state.phase
): PomodoroState {
    return {
        ...createPomodoroState(durations, phase, state.completedFocusSessions),
    };
}

export function tickPomodoroState(
    state: PomodoroState,
    durations: PomodoroDurations = DEFAULT_POMODORO_DURATIONS,
    options: PomodoroAutoStartOptions = {},
): PomodoroTickResult {
    if (!state.isRunning) {
        return {
            state,
            switchedPhase: false,
            completedFocusSession: false,
        };
    }

    if (state.remainingSeconds > 1) {
        return {
            state: {
                ...state,
                remainingSeconds: state.remainingSeconds - 1,
            },
            switchedPhase: false,
            completedFocusSession: false,
        };
    }

    if (state.phase === 'focus') {
        return {
            state: {
                phase: 'break',
                remainingSeconds: getPomodoroPhaseSeconds('break', durations),
                isRunning: options.autoStartBreaks === true,
                completedFocusSessions: state.completedFocusSessions + 1,
            },
            switchedPhase: true,
            completedFocusSession: true,
        };
    }

    return {
        state: {
            phase: 'focus',
            remainingSeconds: getPomodoroPhaseSeconds('focus', durations),
            isRunning: options.autoStartFocus === true,
            completedFocusSessions: state.completedFocusSessions,
        },
        switchedPhase: true,
        completedFocusSession: false,
    };
}

export function advancePomodoroState(
    state: PomodoroState,
    durations: PomodoroDurations = DEFAULT_POMODORO_DURATIONS,
    elapsedSeconds: number,
    options: PomodoroAutoStartOptions = {},
): PomodoroAdvanceResult {
    const safeElapsedSeconds = Math.max(0, Math.floor(elapsedSeconds));
    if (!Number.isFinite(elapsedSeconds) || safeElapsedSeconds <= 0 || !state.isRunning) {
        return {
            state,
            lastEvent: null,
        };
    }

    let nextState = state;
    let lastEvent: PomodoroEvent | null = null;
    let remainingElapsedSeconds = safeElapsedSeconds;

    while (remainingElapsedSeconds > 0 && nextState.isRunning) {
        // A fractional, zero or negative initial countdown still finishes on
        // exactly the tick where tickPomodoroState would switch phases.
        const countdownSeconds = nextState.remainingSeconds > 1
            ? Math.ceil(nextState.remainingSeconds) - 1
            : 0;
        if (remainingElapsedSeconds <= countdownSeconds) {
            nextState = { ...nextState, remainingSeconds: nextState.remainingSeconds - remainingElapsedSeconds };
            break;
        }

        const next = tickPomodoroState({
            ...nextState,
            remainingSeconds: nextState.remainingSeconds - countdownSeconds,
        }, durations, options);
        nextState = next.state;
        remainingElapsedSeconds -= countdownSeconds + 1;
        lastEvent = next.completedFocusSession ? 'focus-finished' : 'break-finished';

        if (nextState.isRunning && options.autoStartFocus === true && options.autoStartBreaks === true) {
            // The first partial phase is now settled. Full focus/break cycles
            // return to this same full phase; the remaining tail spans at most
            // two boundaries, regardless of how long the timer was inactive.
            const cycleSeconds = getPomodoroPhaseSeconds('focus', durations) + getPomodoroPhaseSeconds('break', durations);
            const fullCycles = Math.floor(remainingElapsedSeconds / cycleSeconds);
            if (fullCycles > 0) {
                const count = nextState.completedFocusSessions;
                const incremented = count + 1;
                // Counts from stored sessions are nonnegative integers. Keep
                // repeated +1's IEEE fixed point without truncating the input.
                // shortcut: fractional direct-call counts use arithmetic addition;
                // revisit if a caller stops normalizing completed counts to integers.
                const completedFocusSessions = incremented === count
                    ? count
                    : count >= Number.MAX_SAFE_INTEGER + 1
                        ? incremented
                        : Math.min(count + fullCycles, Number.MAX_SAFE_INTEGER + 1);
                nextState = { ...nextState, completedFocusSessions };
                remainingElapsedSeconds %= cycleSeconds;
                lastEvent = nextState.phase === 'focus' ? 'break-finished' : 'focus-finished';
            }
        }
    }

    return {
        state: nextState,
        lastEvent,
    };
}

export function formatPomodoroClock(totalSeconds: number): string {
    const safeSeconds = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    const seconds = safeSeconds % 60;

    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    const totalMinutes = Math.floor(safeSeconds / 60);
    return `${String(totalMinutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function getPomodoroTaskChoices(pools: {
    focusedTasks: readonly Task[]; schedule: readonly Task[]; nextActions: readonly Task[]; reviewDue: readonly Task[];
}): Task[] {
    const byId = new Map<string, Task>();
    for (const task of [...pools.focusedTasks, ...pools.schedule, ...pools.nextActions, ...pools.reviewDue]) {
        if (!task.deletedAt) byId.set(task.id, task);
    }
    return Array.from(byId.values());
}
