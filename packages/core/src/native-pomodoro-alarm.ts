import { tFallback } from './i18n';
import { buildPomodoroAlarmDetails, isExplicitPomodoroAlarmCancellation, isPomodoroAlarmImmediate,
    readPomodoroAlarmEntry } from './mobile-reminder-alarms';
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

/** RN's own late limit (its library's discardStaleOneShot): an alert more than a day late is dropped. */
export const NATIVE_POMODORO_LATE_LIMIT_MS = 24 * 60 * 60 * 1000;

/**
 * The RN Pomodoro alert owed at the native Android upgrade. RN's alarm that fell due after the native app replaced RN
 * (`upgradedAtMs`: PackageInfo.lastUpdateTime at the first native start, never firstInstallTime, which is RN's) and
 * before its first start was dropped, because RN's receiver is gone. It is shown once at that start (the host's delivery
 * ledger keeps it to once: RN's record does not change), at most a day late, as RN's boot receiver would show it. An
 * alarm due before the upgrade was RN's to show; one still ahead is armed from the adopted session. `raw` is RN's stored
 * record (POMODORO_ALARM_STORAGE_KEY).
 */
export function buildNativePomodoroLegacyAlert(input: {
    raw: string | null; settings: AppSettings; nowMs: number; upgradedAtMs: number; t: (key: string) => string;
}) {
    const none = { kind: 'none' as const };
    if (input.settings.gtd?.pomodoro?.completionAlert === false) return none;
    let entry: ReturnType<typeof readPomodoroAlarmEntry>;
    try { entry = readPomodoroAlarmEntry(input.raw); } catch { return none; }
    const fireAtMs = entry?.fireAtMs;
    if (!entry || entry.id === undefined || entry.notifiedImmediately || fireAtMs === undefined) return none;
    if (fireAtMs <= input.upgradedAtMs || fireAtMs > input.nowMs || input.nowMs - fireAtMs > NATIVE_POMODORO_LATE_LIMIT_MS) return none;
    const phase = entry.phase === 'break-complete' ? 'break-complete' : 'focus-complete';
    const title = tFallback(input.t, 'pomodoro.mobileTitle', 'Pomodoro Timer');
    const message = phase === 'focus-complete'
        ? tFallback(input.t, 'pomodoro.focusComplete', 'Focus session complete. Take a short break.')
        : tFallback(input.t, 'pomodoro.breakComplete', 'Break complete. Ready for the next focus session.');
    return { kind: 'show' as const, fireAtMs, identifier: `rn:${fireAtMs}:${phase}`,
        details: buildPomodoroAlarmDetails(title, message, { phase, endsAtMs: String(fireAtMs) }) };
}
