import { tFallback } from './i18n';
import { buildPomodoroAlarmDetails, isExplicitPomodoroAlarmCancellation, isPomodoroAlarmImmediate } from './mobile-reminder-alarms';
import { decodeNativePomodoroSession } from './native-pomodoro-session';
import type { AppSettings } from './types';

/** Saved timer policy only. Native owns permission, durable publication and notification inventory. */
export function buildNativePomodoroAlarmIntent(input: {
    raw: string | null; settings: AppSettings; nowMs: number; t: (key: string) => string;
}) {
    if (!Number.isSafeInteger(input.nowMs) || Math.abs(input.nowMs) > 8_640_000_000_000_000)
        throw new Error('Invalid Pomodoro alarm observation');
    const cancel = (reason: 'completion-alert-off' | 'timer-not-running') => ({
        kind: 'cancel' as const, reason, preserveDue: !isExplicitPomodoroAlarmCancellation(reason), observedAtMs: input.nowMs,
    });
    // Explicit off may withdraw owned alarms even when timer storage cannot be decoded.
    if (input.settings.gtd?.pomodoro?.completionAlert === false) return cancel('completion-alert-off');
    if (input.raw === null) return { kind: 'uninitialized' as const };
    const state = decodeNativePomodoroSession(input.raw), session = state.session;
    if (!session.timerState.isRunning) return cancel('timer-not-running');
    const fireAtMs = Date.parse(session.phaseEndsAt!);
    const phase = session.timerState.phase;
    const title = tFallback(input.t, 'pomodoro.mobileTitle', 'Pomodoro Timer');
    const message = phase === 'focus'
        ? tFallback(input.t, 'pomodoro.focusComplete', 'Focus session complete. Take a short break.')
        : tFallback(input.t, 'pomodoro.breakComplete', 'Break complete. Ready for the next focus session.');
    return { kind: 'schedule' as const, sessionID: state.sessionID, phase, fireAtMs,
        observedAtMs: input.nowMs, immediate: isPomodoroAlarmImmediate(fireAtMs, input.nowMs),
        details: buildPomodoroAlarmDetails(title, message, { phase: phase + '-complete' }) };
}
