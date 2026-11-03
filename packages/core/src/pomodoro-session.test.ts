import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolvePomodoroSession, startPomodoroSession, pausePomodoroSession } from './pomodoro-session';
import { getPomodoroLocalDayKey } from './pomodoro';
afterEach(() => vi.useRealTimers());
describe('shared Pomodoro frozen history day', () => {
    it('uses explicit frozen day through reconcile/start/pause after the ambient clock crosses midnight', () => {
        vi.useFakeTimers(); vi.setSystemTime(new Date('2030-06-05T12:00:00.000Z'));
        const observed = Date.parse('2026-10-10T00:00:00.000Z');
        const initial = { durations: { focusMinutes: 25, breakMinutes: 5 }, timerState: { phase: 'focus' as const,
            remainingSeconds: 1, isRunning: true, completedFocusSessions: 0 }, phaseEndsAt: new Date(observed).toISOString(),
            sessionHistory: { totalCompletedFocusSessions: 0, completedFocusSessionsByTaskId: {}, todayDayKey: '2026-10-10', completedTodayFocusSessions: 0 } };
        const resolved = resolvePomodoroSession(initial, observed, {}, '2026-10-10');
        expect(resolved.sessionHistory.todayDayKey).toBe('2026-10-10');
        expect(resolved.sessionHistory.completedTodayFocusSessions).toBe(1);
        expect(startPomodoroSession(resolved, observed, {}, '2026-10-10').sessionHistory).toEqual(resolved.sessionHistory);
        expect(pausePomodoroSession(resolved, observed, {}, '2026-10-10').sessionHistory).toEqual(resolved.sessionHistory);
        expect(resolvePomodoroSession(initial, observed).sessionHistory.todayDayKey).toBe(getPomodoroLocalDayKey());
        expect(resolvePomodoroSession(initial, observed, {}, undefined)).toEqual(resolvePomodoroSession(initial, observed));
    });
});
