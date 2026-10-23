import { describe, expect, it } from 'vitest';
import { buildNativePomodoroAlarmIntent } from './native-pomodoro-alarm';
import { decodeNativePomodoroSession, prepareNativePomodoroTransition } from './native-pomodoro-session';
import type { AppSettings } from './types';

const now = Date.parse('2026-10-10T12:00:00.000Z');
const id = '11111111-1111-4111-8111-111111111111';
const initial = () => decodeNativePomodoroSession(prepareNativePomodoroTransition({
    request: { action: 'initialize', requestId: id, observedAtMs: now, localDayKey: '2026-10-10',
        durations: { focusMinutes: 25, breakMinutes: 5 } }, session: { raw: null, state: null }, target: null, deviceId: null,
})!.sessionAfter);
const intent = (raw: string | null, settings: AppSettings = {}, nowMs = now) =>
    buildNativePomodoroAlarmIntent({ raw, settings, nowMs, t: (key) => key });

describe('native Pomodoro alarm intent follows RN root policy', () => {
    it('waits for real initialization, and never treats malformed timer storage as stopped', () => {
        expect(intent(null)).toEqual({ kind: 'uninitialized' });
        for (const raw of ['', '{', '{}', 'null', JSON.stringify({ ...initial(), generation: -1 })])
            expect(() => intent(raw)).toThrow();
        for (const time of [NaN, Infinity, 1.2, 8_640_000_000_000_001]) expect(() => intent(null, {}, time)).toThrow();
    });
    it('explicit alert-off cancels even with unreadable timer storage, while a passive stop preserves due alarms', () => {
        expect(intent('{', { gtd: { pomodoro: { completionAlert: false } } })).toEqual({
            kind: 'cancel', reason: 'completion-alert-off', preserveDue: false, observedAtMs: now,
        });
        expect(intent(JSON.stringify(initial()))).toEqual({
            kind: 'cancel', reason: 'timer-not-running', preserveDue: true, observedAtMs: now,
        });
    });
    it('schedules the saved phase independently of feature visibility and task-reminder settings', () => {
        const state = initial(); state.session.timerState.isRunning = true;
        state.session.phaseEndsAt = new Date(now + 60_000).toISOString();
        state.session.selectedTaskId = 'private-task-content-is-not-an-alarm';
        const raw = JSON.stringify(state);
        const value = intent(raw, { features: { pomodoro: false }, notificationsEnabled: false });
        expect(value).toMatchObject({ kind: 'schedule', sessionID: id, phase: 'focus', fireAtMs: now + 60_000,
            observedAtMs: now, immediate: false, details: { title: 'Pomodoro Timer', has_button: false,
                has_complete_action: false, data: { kind: 'pomodoro', phase: 'focus-complete' } } });
        expect(JSON.stringify(value)).not.toContain(state.session.selectedTaskId);
        expect(JSON.stringify(state)).toBe(raw);
    });
    it('uses shared immediate threshold and does not credit or advance an overdue phase during a read', () => {
        const state = initial(); state.session.timerState.isRunning = true;
        state.session.phaseEndsAt = new Date(now - 1_000).toISOString();
        const raw = JSON.stringify(state), value = intent(raw);
        expect(value).toMatchObject({ kind: 'schedule', phase: 'focus', immediate: true, fireAtMs: now - 1_000 });
        expect(JSON.stringify(state)).toBe(raw); expect(state.session.timerState.completedFocusSessions).toBe(0);
    });
    it('keeps alarm identity stable across task linking and local generation changes, and uses break text', () => {
        const state = initial(); state.session.timerState.isRunning = true; state.session.timerState.phase = 'break'; state.session.timerState.remainingSeconds = 300;
        state.session.phaseEndsAt = new Date(now + 60_000).toISOString();
        const before = intent(JSON.stringify(state));
        state.generation += 1; state.session.selectedTaskId = 'different';
        expect(intent(JSON.stringify(state))).toEqual(before);
        expect(before).toMatchObject({ phase: 'break', details: {
            message: 'Break complete. Ready for the next focus session.', data: { phase: 'break-complete' } } });
    });
});
