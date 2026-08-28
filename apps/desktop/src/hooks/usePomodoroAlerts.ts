import { useEffect, useMemo, useRef } from 'react';
import { resolveFeatureFlags, translateWithFallback, useTaskStore, type PomodoroAutoStartOptions, type PomodoroEvent } from '@mindwtr/core';
import { useLanguage } from '../contexts/language-context';
import { sendDesktopPomodoroCompletionAlert } from '../lib/pomodoro-alert';
import { reconcilePomodoroSnapshot, usePomodoroStore } from '../store/pomodoro-store';

/**
 * Runs the pomodoro clock and its completion alert app-wide.
 *
 * Both used to live in PomodoroPanel, which only mounts inside Agenda, so a
 * timer left running while the user worked in another view — or another
 * workspace, which is the whole point of the timer — never ticked to zero and
 * never alerted until Agenda was reopened. Reconciliation is timestamp-based,
 * so the clock still read correctly on return; only the sound, notification and
 * taskbar flash were missed (#528).
 *
 * Covers both phases: the break end alerts the same way the focus end does,
 * once the break is actually running (auto-start breaks, or Start pressed).
 *
 * Deliberately not gated on the Task reminders setting: that switch governs
 * date-driven reminders, it is off on every fresh install, and gating on it
 * meant the completion alert of a timer the user had just started silently
 * never fired (#528). The opt-out now lives with the feature, in Pomodoro
 * settings, and defaults on; the OS notification permission is the outer gate.
 */
export function usePomodoroAlerts(): void {
    const pomodoroEnabled = useTaskStore((state) => resolveFeatureFlags(state.settings).pomodoro);
    const completionAlertEnabled = useTaskStore((state) => state.settings.gtd?.pomodoro?.completionAlert !== false);
    const autoStartBreaks = useTaskStore((state) => state.settings.gtd?.pomodoro?.autoStartBreaks === true);
    const autoStartFocus = useTaskStore((state) => state.settings.gtd?.pomodoro?.autoStartFocus === true);
    const isRunning = usePomodoroStore((state) => state.snapshot.timerState.isRunning);
    const lastEvent = usePomodoroStore((state) => state.snapshot.lastEvent);
    const hasHydrated = usePomodoroStore((state) => state.hasHydrated);
    const commitSnapshot = usePomodoroStore((state) => state.commitPomodoro);
    const { t } = useLanguage();
    // `undefined` = no baseline yet. The hook mounts with App, before the store
    // hydrates, so a ref seeded here would hold the empty pre-hydration event and
    // treat the session hydration replays as brand new.
    const previousEventRef = useRef<PomodoroEvent | null | undefined>(undefined);

    const autoStartOptions = useMemo<PomodoroAutoStartOptions>(
        () => ({ autoStartBreaks, autoStartFocus }),
        [autoStartBreaks, autoStartFocus]
    );

    useEffect(() => {
        if (!pomodoroEnabled || !isRunning) return;
        const intervalId = window.setInterval(() => {
            commitSnapshot((prev) => reconcilePomodoroSnapshot(prev, Date.now(), autoStartOptions));
        }, 1000);
        return () => window.clearInterval(intervalId);
    }, [autoStartOptions, commitSnapshot, isRunning, pomodoroEnabled]);

    useEffect(() => {
        if (!hasHydrated) return;
        const previous = previousEventRef.current;
        previousEventRef.current = lastEvent;
        // A session that ran out while the app was closed surfaces as the first
        // event after hydration. Its minutes are credited silently on purpose, so
        // the sound, notification and taskbar flash stay silent with them (#528).
        if (previous === undefined) return;
        if (!lastEvent || lastEvent === previous || !completionAlertEnabled) return;
        const message = lastEvent === 'focus-finished'
            ? translateWithFallback(t, 'pomodoro.focusComplete', 'Focus session complete. Take a short break.')
            : translateWithFallback(t, 'pomodoro.breakComplete', 'Break complete. Ready for the next focus session.');
        void sendDesktopPomodoroCompletionAlert(
            translateWithFallback(t, 'pomodoro.title', 'Pomodoro Focus'),
            message
        );
    }, [completionAlertEnabled, hasHydrated, lastEvent, t]);
}
