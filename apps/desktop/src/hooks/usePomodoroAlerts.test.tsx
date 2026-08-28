import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { createPomodoroState, DEFAULT_POMODORO_DURATIONS, sanitizePomodoroSessionHistory, useTaskStore } from '@mindwtr/core';
import { LanguageProvider } from '../contexts/language-context';
import { DESKTOP_POMODORO_SESSION_STORAGE_KEY, usePomodoroStore } from '../store/pomodoro-store';
import { usePomodoroAlerts } from './usePomodoroAlerts';

const sendAlert = vi.fn();
vi.mock('../lib/pomodoro-alert', () => ({
    sendDesktopPomodoroCompletionAlert: (...args: unknown[]) => sendAlert(...args),
}));

// Deliberately renders nothing: the point is that the timer alerts from App,
// with no pomodoro UI mounted anywhere (#528).
function Harness() {
    usePomodoroAlerts();
    return null;
}

const runningSnapshot = (phase: 'focus' | 'break', remainingSeconds: number, updatedAtMs = Date.now()) => ({
    durations: DEFAULT_POMODORO_DURATIONS,
    timerState: { ...createPomodoroState(DEFAULT_POMODORO_DURATIONS, phase), remainingSeconds, isRunning: true },
    selectedTaskId: undefined,
    lastEvent: null,
    updatedAtMs,
    sessionHistory: sanitizePomodoroSessionHistory(),
});

const startRunningPhase = (phase: 'focus' | 'break', remainingSeconds: number) => {
    usePomodoroStore.setState({ hasHydrated: true, snapshot: runningSnapshot(phase, remainingSeconds) });
};

describe('usePomodoroAlerts', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        sendAlert.mockClear();
        window.localStorage.clear();
        useTaskStore.setState({
            tasks: [],
            _allTasks: [],
            settings: { features: { pomodoro: true } },
            error: null,
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('alerts when a focus session finishes with no panel mounted', () => {
        startRunningPhase('focus', 2);
        render(<LanguageProvider><Harness /></LanguageProvider>);

        act(() => {
            vi.advanceTimersByTime(3000);
        });

        expect(sendAlert).toHaveBeenCalledTimes(1);
        expect(sendAlert.mock.calls[0][1]).toContain('Focus session complete');
    });

    it('alerts when a break finishes too', () => {
        startRunningPhase('break', 2);
        render(<LanguageProvider><Harness /></LanguageProvider>);

        act(() => {
            vi.advanceTimersByTime(3000);
        });

        expect(sendAlert).toHaveBeenCalledTimes(1);
        expect(sendAlert.mock.calls[0][1]).toContain('Break complete');
    });

    it('stays quiet for a session that ran out while the app was closed', () => {
        // The hook mounts with App, before the store hydrates, so the FIRST
        // lastEvent it ever sees is the one reconciliation replays for a session
        // that ended possibly hours ago. Its minutes are credited silently and
        // the alert must stay silent with them (#528).
        window.localStorage.setItem(
            DESKTOP_POMODORO_SESSION_STORAGE_KEY,
            JSON.stringify(runningSnapshot('focus', 5, Date.now() - 60 * 60 * 1000)),
        );
        usePomodoroStore.setState({
            hasHydrated: false,
            snapshot: { ...runningSnapshot('focus', 5), timerState: createPomodoroState(DEFAULT_POMODORO_DURATIONS) },
        });
        render(<LanguageProvider><Harness /></LanguageProvider>);

        act(() => {
            usePomodoroStore.getState().hydratePomodoro({ autoStartBreaks: false, autoStartFocus: false });
        });

        expect(usePomodoroStore.getState().snapshot.lastEvent).toBe('focus-finished');
        expect(sendAlert).not.toHaveBeenCalled();
    });

    it('still alerts for a session that finishes after hydration', () => {
        usePomodoroStore.setState({ hasHydrated: false, snapshot: runningSnapshot('focus', 2) });
        render(<LanguageProvider><Harness /></LanguageProvider>);

        act(() => {
            usePomodoroStore.setState({ hasHydrated: true });
        });
        act(() => {
            vi.advanceTimersByTime(3000);
        });

        expect(sendAlert).toHaveBeenCalledTimes(1);
    });

    it('stays quiet when the session-end alert is switched off', () => {
        useTaskStore.setState({
            settings: { features: { pomodoro: true }, gtd: { pomodoro: { completionAlert: false } } },
        });
        startRunningPhase('focus', 2);
        render(<LanguageProvider><Harness /></LanguageProvider>);

        act(() => {
            usePomodoroStore.setState({ hasHydrated: true });
        });
        act(() => {
            vi.advanceTimersByTime(3000);
        });

        expect(sendAlert).not.toHaveBeenCalled();
    });

    it('alerts while task reminders are off', () => {
        // Task reminders are off on every fresh install, and the completion alert
        // used to be gated on them, so a timer the user started never alerted (#528).
        useTaskStore.setState({ settings: { features: { pomodoro: true }, notificationsEnabled: false } });
        startRunningPhase('focus', 2);
        render(<LanguageProvider><Harness /></LanguageProvider>);

        act(() => {
            usePomodoroStore.setState({ hasHydrated: true });
        });
        act(() => {
            vi.advanceTimersByTime(3000);
        });

        expect(sendAlert).toHaveBeenCalledTimes(1);
    });
});
