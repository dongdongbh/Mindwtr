import type { PomodoroDurations, PomodoroState } from './pomodoro';
import { TIME_SPENT_MAX_MINUTES } from './time-spent';

const validTaskId = (taskId: string): boolean => taskId.length > 0 && taskId.trim() === taskId
    && !['__proto__', 'constructor', 'prototype'].includes(taskId);

const workMap = (value: unknown): Record<string, number> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return {};
    return Object.fromEntries(Object.entries(value).filter(([taskId, seconds]) => validTaskId(taskId)
        && typeof seconds === 'number' && Number.isSafeInteger(seconds) && seconds >= 0));
};

export function accumulatePomodoroWork(previous: {
    timerState: PomodoroState;
    durations: PomodoroDurations;
    selectedTaskId?: string;
    workSecondsByTaskId?: Record<string, number>;
}, nextTimerState: PomodoroState): Record<string, number> {
    const workSecondsByTaskId = workMap(previous.workSecondsByTaskId);
    const taskId = previous.selectedTaskId;
    if (!taskId || !validTaskId(taskId)) return workSecondsByTaskId;
    const focusSeconds = previous.durations.focusMinutes * 60;
    const progress = (state: PomodoroState) => state.phase === 'focus'
        ? Math.max(0, focusSeconds - state.remainingSeconds) : 0;
    const previousProgress = progress(previous.timerState);
    const initialSeconds = previous.workSecondsByTaskId === undefined ? previousProgress : workSecondsByTaskId[taskId] ?? 0;
    const elapsedSeconds = previous.timerState.isRunning ? Math.max(0,
        (nextTimerState.completedFocusSessions - previous.timerState.completedFocusSessions) * focusSeconds
            + progress(nextTimerState) - previousProgress) : 0;
    const seconds = initialSeconds + elapsedSeconds;
    if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error('Invalid Pomodoro work seconds');
    if (seconds > 0) workSecondsByTaskId[taskId] = seconds;
    return workSecondsByTaskId;
}

export function settlePomodoroWork(work: Record<string, number>): {
    workSecondsByTaskId: Record<string, number>;
    credits: { taskId: string; minutes: number }[];
} {
    const workSecondsByTaskId: Record<string, number> = {};
    const credits: { taskId: string; minutes: number }[] = [];
    for (const [taskId, seconds] of Object.entries(workMap(work))) {
        const minutes = Math.floor(seconds / 60);
        if (minutes > 0) credits.push({ taskId, minutes: Math.min(TIME_SPENT_MAX_MINUTES, minutes) });
        if (seconds % 60 > 0) workSecondsByTaskId[taskId] = seconds % 60;
    }
    return { workSecondsByTaskId, credits };
}
