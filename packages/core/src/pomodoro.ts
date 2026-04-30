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
    if (safeElapsedSeconds <= 0) {
        return {
            state,
            lastEvent: null,
        };
    }

    let nextState = state;
    let lastEvent: PomodoroEvent | null = null;

    for (let i = 0; i < safeElapsedSeconds; i += 1) {
        const next = tickPomodoroState(nextState, durations, options);
        nextState = next.state;
        if (next.switchedPhase) {
            lastEvent = next.completedFocusSession ? 'focus-finished' : 'break-finished';
            if (!nextState.isRunning) break;
        } else if (!nextState.isRunning) {
            break;
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
