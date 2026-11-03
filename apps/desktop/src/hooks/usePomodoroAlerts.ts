import { useEffect, useMemo, useRef } from 'react';
import { isSandboxMode, resolveFeatureFlags, translateWithFallback, useTaskStore, type PomodoroAutoStartOptions, type PomodoroEvent } from '@mindwtr/core';
import { useLanguage } from '../contexts/language-context';
import { sendDesktopPomodoroCompletionAlert } from '../lib/pomodoro-alert';
import { reconcilePomodoroSnapshot, usePomodoroStore } from '../store/pomodoro-store';


export function usePomodoroAlerts(): void {
    const personalServicesAllowed = !isSandboxMode();
    const pomodoroEnabled = useTaskStore((state) => resolveFeatureFlags(state.settings).pomodoro);
    const completionAlertEnabled = useTaskStore((state) => state.settings.gtd?.pomodoro?.completionAlert !== false);
    const autoStartBreaks = useTaskStore((state) => state.settings.gtd?.pomodoro?.autoStartBreaks === true);
    const autoStartFocus = useTaskStore((state) => state.settings.gtd?.pomodoro?.autoStartFocus === true);
    const isRunning = usePomodoroStore((state) => state.snapshot.timerState.isRunning);
    const lastEvent = usePomodoroStore((state) => state.snapshot.lastEvent);
    const hasHydrated = usePomodoroStore((state) => state.hasHydrated);
    const commitSnapshot = usePomodoroStore((state) => state.commitPomodoro);
    const { t } = useLanguage();


    const previousEventRef = useRef<PomodoroEvent | null | undefined>(undefined);

    const autoStartOptions = useMemo<PomodoroAutoStartOptions>(
        () => ({ autoStartBreaks, autoStartFocus }),
        [autoStartBreaks, autoStartFocus]
    );

    useEffect(() => {
        if (!personalServicesAllowed || !pomodoroEnabled || !isRunning) return;
        const intervalId = window.setInterval(() => {
            commitSnapshot((prev) => reconcilePomodoroSnapshot(prev, Date.now(), autoStartOptions));
        }, 1000);
        return () => window.clearInterval(intervalId);
    }, [autoStartOptions, commitSnapshot, isRunning, personalServicesAllowed, pomodoroEnabled]);

    useEffect(() => {
        if (!personalServicesAllowed || !hasHydrated) return;
        const previous = previousEventRef.current;
        previousEventRef.current = lastEvent;


        if (previous === undefined) return;
        if (!lastEvent || lastEvent === previous || !completionAlertEnabled) return;
        const message = lastEvent === 'focus-finished'
            ? translateWithFallback(t, 'pomodoro.focusComplete', 'Focus session complete. Take a short break.')
            : translateWithFallback(t, 'pomodoro.breakComplete', 'Break complete. Ready for the next focus session.');
        void sendDesktopPomodoroCompletionAlert(
            translateWithFallback(t, 'pomodoro.title', 'Pomodoro Focus'),
            message
        );
    }, [completionAlertEnabled, hasHydrated, lastEvent, personalServicesAllowed, t]);
}
