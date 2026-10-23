import { describe, expect, it } from 'vitest';

import {
    advancePomodoroState,
    createPomodoroCustomPreset,
    createPomodoroState,
    DEFAULT_POMODORO_DURATIONS,
    formatPomodoroClock,
    getPomodoroPresetOptions,
    getPomodoroPhaseSeconds,
    getPomodoroFocusSessionsCompletedToday,
    recordPomodoroFocusSessions,
    sanitizePomodoroDurations,
    sanitizePomodoroSessionHistory,
    tickPomodoroState,
    POMODORO_PRESETS,
    type PomodoroAutoStartOptions,
    type PomodoroDurations,
    type PomodoroEvent,
    type PomodoroState,
} from './pomodoro';

// Bounded reference to the previous elapsed-second algorithm. Large catch-up
// cases below use worked expectations, never this oracle.
const advanceByTicks = (
    state: PomodoroState,
    durations: PomodoroDurations,
    elapsedSeconds: number,
    options: PomodoroAutoStartOptions,
) => {
    let nextState = state;
    let lastEvent: PomodoroEvent | null = null;
    for (let i = 0; i < Math.max(0, Math.floor(elapsedSeconds)); i += 1) {
        const next = tickPomodoroState(nextState, durations, options);
        nextState = next.state;
        if (next.switchedPhase) {
            lastEvent = next.completedFocusSession ? 'focus-finished' : 'break-finished';
        }
        if (!nextState.isRunning) break;
    }
    return { state: nextState, lastEvent };
};

describe('pomodoro helpers', () => {
    it('sanitizes durations into a safe range', () => {
        expect(sanitizePomodoroDurations({ focusMinutes: -2, breakMinutes: 500 })).toEqual({
            focusMinutes: 1,
            breakMinutes: 180,
        });
    });

    it('creates default focus state', () => {
        expect(createPomodoroState()).toEqual({
            phase: 'focus',
            remainingSeconds: DEFAULT_POMODORO_DURATIONS.focusMinutes * 60,
            isRunning: false,
            completedFocusSessions: 0,
        });
    });

    it('adds one custom preset when the saved duration differs from the built-in presets', () => {
        expect(createPomodoroCustomPreset({ focusMinutes: 30, breakMinutes: 6 })).toEqual({
            id: 'custom',
            label: '30/6',
            focusMinutes: 30,
            breakMinutes: 6,
        });
        expect(getPomodoroPresetOptions({ focusMinutes: 30, breakMinutes: 6 })).toHaveLength(4);
    });

    it('reuses built-in presets when custom durations match them', () => {
        expect(createPomodoroCustomPreset({ focusMinutes: 25, breakMinutes: 5 })).toBeNull();
        expect(getPomodoroPresetOptions({ focusMinutes: 25, breakMinutes: 5 })).toHaveLength(3);
    });

    it('switches from focus to break and increments completed session', () => {
        const state = {
            phase: 'focus' as const,
            remainingSeconds: 1,
            isRunning: true,
            completedFocusSessions: 2,
        };
        const result = tickPomodoroState(state, { focusMinutes: 25, breakMinutes: 5 });
        expect(result.switchedPhase).toBe(true);
        expect(result.completedFocusSession).toBe(true);
        expect(result.state.phase).toBe('break');
        expect(result.state.isRunning).toBe(false);
        expect(result.state.remainingSeconds).toBe(getPomodoroPhaseSeconds('break', { focusMinutes: 25, breakMinutes: 5 }));
        expect(result.state.completedFocusSessions).toBe(3);
    });

    it('auto-starts breaks when configured', () => {
        const result = tickPomodoroState({
            phase: 'focus',
            remainingSeconds: 1,
            isRunning: true,
            completedFocusSessions: 0,
        }, { focusMinutes: 25, breakMinutes: 5 }, { autoStartBreaks: true });

        expect(result.state.phase).toBe('break');
        expect(result.state.isRunning).toBe(true);
        expect(result.completedFocusSession).toBe(true);
    });

    it('advances through an auto-started next phase', () => {
        const result = advancePomodoroState({
            phase: 'focus',
            remainingSeconds: 1,
            isRunning: true,
            completedFocusSessions: 4,
        }, { focusMinutes: 25, breakMinutes: 5 }, 3, { autoStartBreaks: true });

        expect(result.lastEvent).toBe('focus-finished');
        expect(result.state).toEqual({
            phase: 'break',
            remainingSeconds: getPomodoroPhaseSeconds('break', { focusMinutes: 25, breakMinutes: 5 }) - 2,
            isRunning: true,
            completedFocusSessions: 5,
        });
    });

    it('ignores nonfinite elapsed time without completing a running phase', () => {
        const state = {
            phase: 'focus' as const,
            remainingSeconds: 3,
            isRunning: true,
            completedFocusSessions: 4,
        };
        // Default auto-start stops after one phase, so the old Infinity behavior
        // fails promptly here instead of hanging the test process.
        for (const elapsedSeconds of [NaN, Infinity, -Infinity]) {
            expect(advancePomodoroState(state, DEFAULT_POMODORO_DURATIONS, elapsedSeconds)).toEqual({
                state,
                lastEvent: null,
            });
        }
    });

    it('matches iterative ticks across presets, options, partial phases and boundaries', () => {
        const durationCases = [
            ...POMODORO_PRESETS,
            { focusMinutes: 1.4, breakMinutes: -2 },
            { focusMinutes: NaN, breakMinutes: Infinity },
        ];
        for (const durations of durationCases) {
            const cycleSeconds = getPomodoroPhaseSeconds('focus', durations)
                + getPomodoroPhaseSeconds('break', durations);
            for (const phase of ['focus', 'break'] as const) {
                const phaseSeconds = getPomodoroPhaseSeconds(phase, durations);
                const nextPhaseSeconds = cycleSeconds - phaseSeconds;
                for (const remainingSeconds of [phaseSeconds, phaseSeconds + 3, phaseSeconds - 2, 2.25, 1.25, 1, 0.25, 0, -3]) {
                    const boundary = Math.max(1, Math.ceil(remainingSeconds));
                    const elapsedCases = [
                        -1, 0, 0.9, 1, 1.9,
                        boundary - 1, boundary, boundary + 1,
                        boundary + nextPhaseSeconds - 1,
                        boundary + nextPhaseSeconds,
                        boundary + cycleSeconds,
                        boundary + cycleSeconds * 2 + 3,
                    ];
                    for (const autoStartFocus of [false, true]) {
                        for (const autoStartBreaks of [false, true]) {
                            const options = { autoStartFocus, autoStartBreaks };
                            const state = { phase, remainingSeconds, isRunning: true, completedFocusSessions: 4 };
                            for (const elapsedSeconds of elapsedCases) {
                                expect(
                                    advancePomodoroState(state, durations, elapsedSeconds, options),
                                    JSON.stringify({ durations, state, elapsedSeconds, options }),
                                ).toEqual(advanceByTicks(state, durations, elapsedSeconds, options));
                            }
                            expect(state).toEqual({ phase, remainingSeconds, isRunning: true, completedFocusSessions: 4 });
                        }
                    }
                }
            }
        }
    }, 30_000);

    it('leaves paused and nonpositive elapsed states untouched', () => {
        const state = { phase: 'break' as const, remainingSeconds: 31.25, isRunning: false, completedFocusSessions: 7 };
        for (const elapsedSeconds of [-100, 0, 0.99, 1, 100 * 365.25 * 24 * 60 * 60]) {
            const result = advancePomodoroState(state, DEFAULT_POMODORO_DURATIONS, elapsedSeconds, {
                autoStartFocus: true, autoStartBreaks: true,
            });
            expect(result.state).toBe(state);
            expect(result.lastEvent).toBeNull();
        }
    });

    it('catches up a century from a partial focus with exact count, residual and last event', () => {
        // 100 Julian years contain exactly 1,753,200 classic 25/5 cycles.
        // Seven seconds finish the partial focus; one additional second runs
        // the break after those cycles, leaving 299 seconds on that break.
        expect(advancePomodoroState({
            phase: 'focus', remainingSeconds: 7, isRunning: true, completedFocusSessions: 4,
        }, DEFAULT_POMODORO_DURATIONS, 3_155_760_008, {
            autoStartFocus: true, autoStartBreaks: true,
        })).toEqual({
            state: { phase: 'break', remainingSeconds: 299, isRunning: true, completedFocusSessions: 1_753_205 },
            lastEvent: 'focus-finished',
        });
    });

    it('ends complete cycles at the original full phase and reports the final transition', () => {
        for (const phase of ['focus', 'break'] as const) {
            expect(advancePomodoroState({
                ...createPomodoroState(DEFAULT_POMODORO_DURATIONS, phase, 4), isRunning: true,
            }, DEFAULT_POMODORO_DURATIONS, 3_155_760_000, {
                autoStartFocus: true, autoStartBreaks: true,
            })).toEqual({
                state: {
                    phase, remainingSeconds: phase === 'focus' ? 1500 : 300,
                    isRunning: true, completedFocusSessions: 1_753_204,
                },
                lastEvent: phase === 'focus' ? 'break-finished' : 'focus-finished',
            });
        }
    });

    it('preserves large integer counts where repeated plus-one increments stop changing them', () => {
        const durations = { focusMinutes: 1, breakMinutes: 1 };
        for (const completedFocusSessions of [2 ** 53 - 2, 2 ** 53 - 1, 2 ** 53, 2 ** 53 + 2, 2 ** 54]) {
            for (const phase of ['focus', 'break'] as const) {
                const state = { phase, remainingSeconds: 1, isRunning: true, completedFocusSessions };
                const options = { autoStartFocus: true, autoStartBreaks: true };
                expect(advancePomodoroState(state, durations, 1201, options))
                    .toEqual(advanceByTicks(state, durations, 1201, options));
            }
        }
    });

    it('formats timer clock values', () => {
        expect(formatPomodoroClock(0)).toBe('00:00');
        expect(formatPomodoroClock(65)).toBe('01:05');
        expect(formatPomodoroClock(3605)).toBe('1:00:05');
    });

    it('sanitizes persisted local session history', () => {
        expect(sanitizePomodoroSessionHistory({
            totalCompletedFocusSessions: 1.2,
            completedFocusSessionsByTaskId: {
                ' task-1 ': 2.8,
                'task-2': -1,
                '': 4,
            },
        }, 5, '2026-08-17')).toEqual({
            totalCompletedFocusSessions: 5,
            completedFocusSessionsByTaskId: {
                'task-1': 2,
            },
            todayDayKey: '2026-08-17',
            completedTodayFocusSessions: 0,
        });
    });

    it('keeps the today-count within its day and zeroes it on rollover', () => {
        const stored = {
            totalCompletedFocusSessions: 9,
            completedFocusSessionsByTaskId: {},
            todayDayKey: '2026-08-17',
            completedTodayFocusSessions: 4,
        };

        const sameDay = sanitizePomodoroSessionHistory(stored, 0, '2026-08-17');
        expect(sameDay.completedTodayFocusSessions).toBe(4);
        expect(getPomodoroFocusSessionsCompletedToday(sameDay, '2026-08-17')).toBe(4);

        const nextDay = sanitizePomodoroSessionHistory(stored, 0, '2026-08-18');
        expect(nextDay.completedTodayFocusSessions).toBe(0);
        expect(nextDay.totalCompletedFocusSessions).toBe(9);
        // Display-time guard: a stale in-memory history reads as zero too.
        expect(getPomodoroFocusSessionsCompletedToday(stored, '2026-08-18')).toBe(0);
    });

    it('records completed focus sessions in local task history', () => {
        const previous = {
            totalCompletedFocusSessions: 2,
            completedFocusSessionsByTaskId: {
                'task-1': 1,
            },
            todayDayKey: '2026-08-17',
            completedTodayFocusSessions: 1,
        };

        const next = recordPomodoroFocusSessions(previous, 'task-1', 2, '2026-08-17');

        expect(next).toEqual({
            totalCompletedFocusSessions: 4,
            completedFocusSessionsByTaskId: {
                'task-1': 3,
            },
            todayDayKey: '2026-08-17',
            completedTodayFocusSessions: 3,
        });
        expect(previous.totalCompletedFocusSessions).toBe(2);

        // A session credited after midnight lands on the new day's count.
        const rolled = recordPomodoroFocusSessions(previous, 'task-1', 1, '2026-08-18');
        expect(rolled.completedTodayFocusSessions).toBe(1);
        expect(rolled.totalCompletedFocusSessions).toBe(3);
    });
});
