import { useEffect } from 'react';

import { type PomodoroAutoStartOptions, useTaskStore } from '@mindwtr/core';

import { mobilePomodoroController, useMobilePomodoroNotificationState } from '@/lib/pomodoro-controller';
import {
  cancelMobilePomodoroCompletionNotification,
  scheduleMobilePomodoroCompletionNotification,
} from '@/lib/notification-service';

export function useRootLayoutPomodoro({
  dataReady,
  disabled = false,
  resolveText,
}: {
  dataReady: boolean;
  disabled?: boolean;
  resolveText: (key: string, fallback: string) => string;
}) {
  const snapshot = useMobilePomodoroNotificationState();
  const completionAlertEnabled = useTaskStore((state) => state.settings.gtd?.pomodoro?.completionAlert !== false);
  const autoStartBreaks = useTaskStore((state) => state.settings.gtd?.pomodoro?.autoStartBreaks === true);
  const autoStartFocus = useTaskStore((state) => state.settings.gtd?.pomodoro?.autoStartFocus === true);

  useEffect(() => {
    if (!dataReady || disabled) return;
    const options: PomodoroAutoStartOptions = { autoStartBreaks, autoStartFocus };
    void mobilePomodoroController.ensureHydrated(options);
    const interval = setInterval(() => {
      mobilePomodoroController.reconcile(options);
    }, 1000);
    return () => clearInterval(interval);
  }, [autoStartBreaks, autoStartFocus, dataReady, disabled]);

  useEffect(() => {
    if (!dataReady || disabled || snapshot.isHydrating) return;
    if (!completionAlertEnabled || !snapshot.isRunning || !snapshot.phaseEndsAt) {
      void cancelMobilePomodoroCompletionNotification(
        !completionAlertEnabled
          ? 'completion-alert-off'
          : !snapshot.isRunning
            ? 'timer-not-running'
            : 'no-phase-end',
      );
      return;
    }
    const phase = snapshot.phase;
    const title = resolveText('pomodoro.mobileTitle', 'Pomodoro Timer');
    const message = phase === 'focus'
      ? resolveText('pomodoro.focusComplete', 'Focus session complete. Take a short break.')
      : resolveText('pomodoro.breakComplete', 'Break complete. Ready for the next focus session.');
    void scheduleMobilePomodoroCompletionNotification(title, message, new Date(snapshot.phaseEndsAt), {
      phase: phase === 'focus' ? 'focus-complete' : 'break-complete',
    });
  }, [
    completionAlertEnabled,
    dataReady,
    disabled,
    resolveText,
    snapshot.isHydrating,
    snapshot.phaseEndsAt,
    snapshot.isRunning,
    snapshot.phase,
  ]);
}
