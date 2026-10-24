import { describe, expect, it } from 'vitest';
import { buildNativePomodoroPanel, readNativePomodoroPresentation } from './native-pomodoro-panel';
import { getPomodoroTaskChoices } from './pomodoro';
import { taskRevisionOf } from './native-request-receipts';
import { decodeNativePomodoroSession, prepareNativePomodoroTransition } from './native-pomodoro-session';
import type { AppSettings, Task } from './types';

const now = Date.parse('2026-10-10T12:00:00.000Z');
const id = '11111111-1111-4111-8111-111111111111';
const settings: AppSettings = { features: { pomodoro: true }, gtd: { pomodoro: { linkTask: true } } };
const task = (id: string, title = id): Task => ({ id, title, status: 'next', contexts: [], tags: [],
    createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' });
const initial = () => decodeNativePomodoroSession(prepareNativePomodoroTransition({
    request: { action: 'initialize', requestId: id, observedAtMs: now, localDayKey: '2026-10-10',
        durations: { focusMinutes: 25, breakMinutes: 5 } }, session: { raw: null, state: null }, target: null, deviceId: null,
})!.sessionAfter);
const panel = (raw: string | null, options: Partial<Parameters<typeof buildNativePomodoroPanel>[0]> = {}) =>
    buildNativePomodoroPanel({ raw, settings, liveTasks: [], nowMs: now, collapsed: false, lastEvent: null,
        t: (key) => key, ...options });

function ready(value: ReturnType<typeof panel>) {
    expect(value.kind).toBe('ready');
    if (value.kind !== 'ready') throw new Error('Expected ready panel');
    return value;
}

describe('native Pomodoro presentation using RN timer helpers', () => {
    it('accepts only closed bounded presentation state, never caller-supplied timer or task data', () => {
        const lastEvent = { sessionID: id, generation: 4, value: 'focus-finished' };
        expect(readNativePomodoroPresentation({ collapsed: false, lastEvent: null })).toEqual({ collapsed: false, lastEvent: null });
        expect(readNativePomodoroPresentation({ collapsed: true, lastEvent })).toEqual({ collapsed: true, lastEvent });
        for (const input of [Object.assign(Object.create({ collapsed: true }), { lastEvent: null, extra: true }), null, [], {}, { collapsed: 1, lastEvent: null }, { collapsed: false },
            { collapsed: false, lastEvent: null, raw: '{}' },
            ...[{ ...lastEvent, generation: -1 }, { ...lastEvent, generation: 1.5 },
                { ...lastEvent, generation: Number.MAX_SAFE_INTEGER + 1 }, { ...lastEvent, value: 'unknown' },
                { ...lastEvent, sessionID: 'other' }, { ...lastEvent, extra: true }]
                .map((lastEvent) => ({ collapsed: false, lastEvent }))]) {
            expect(() => readNativePomodoroPresentation(input)).toThrow('Invalid Pomodoro presentation');
        }
    });

    it('distinguishes hidden, absent and malformed storage without inventing a timer', () => {
        expect(panel(null, { settings: {} })).toMatchObject({ kind: 'uninitialized', visible: false });
        expect(panel(null)).toMatchObject({ kind: 'uninitialized', visible: true });
        // RN's card while its session loads: the default timer with its controls off and a Loading row, no session of its own.
        expect(panel(null)).toMatchObject({ sessionID: null, generation: null, clock: '25:00', phase: 'focus', isRunning: false,
            needsReconcile: false, selectionMissing: false, selectedTask: null, completedToday: 0,
            text: { loading: 'Loading...', toggle: 'Start', state: 'Paused' } });
        for (const raw of ['{}', 'null', '{', JSON.stringify({ ...initial(), generation: -1 })])
            expect(() => panel(raw)).toThrow();
        for (const nowMs of [NaN, Infinity, 1.5, 8_640_000_000_000_001])
            expect(() => panel(JSON.stringify(initial()), { nowMs })).toThrow();
    });
    it('keeps the root timer and completion-alert policy available when its panel is hidden', () => {
        const state = initial(); state.session.timerState.isRunning = true;
        state.session.phaseEndsAt = new Date(now + 60_000).toISOString();
        const hidden = ready(panel(JSON.stringify(state), { settings: { gtd: { pomodoro: { autoStartBreaks: true } } } }));
        expect(hidden.visible).toBe(false); expect(hidden.isRunning).toBe(true); expect(hidden.clock).toBe('01:00');
        expect(hidden.completionAlert).toBe(true); expect(hidden.autoStart).toEqual({ autoStartFocus: false, autoStartBreaks: true });
    });
    it('uses RN defaults, presets, labels and current-day count', () => {
        const state = initial(); state.session.timerState.completedFocusSessions = 5;
        state.session.sessionHistory.totalCompletedFocusSessions = 5;
        state.session.sessionHistory.completedTodayFocusSessions = 2;
        const view = ready(panel(JSON.stringify(state)));
        expect(view.clock).toBe('25:00'); expect(view.completedToday).toBe(2);
        expect(view.presets.map((p) => [p.label, p.active])).toEqual([['15/3', false], ['25/5', true], ['50/10', false]]);
        expect(view.text.toggle).toBe('Start'); expect(view.text.title).toBe('Pomodoro Timer');
        expect(ready(panel(JSON.stringify(state), { nowMs: now + 86_400_000 })).completedToday).toBe(0);
    });
    it('reads countdown ticks without changing session bytes or completed totals', () => {
        const state = initial(); state.session.timerState.isRunning = true;
        state.session.phaseEndsAt = new Date(now + 24_500).toISOString();
        const raw = JSON.stringify(state);
        const view = ready(panel(raw));
        expect(view.clock).toBe('00:25'); expect(view.needsReconcile).toBe(false);
        expect(view.text.toggle).toBe('Pause'); expect(view.completedToday).toBe(0);
        expect(ready(panel(raw, { nowMs: now + 1_000 })).clock).toBe('00:24');
        expect(JSON.stringify(state)).toBe(raw);
    });
    it('shows no speculative phase, credit or feedback before overdue reconciliation saves', () => {
        const state = initial(); state.session.timerState.isRunning = true;
        state.session.phaseEndsAt = new Date(now - 60_000).toISOString();
        const view = ready(panel(JSON.stringify(state)));
        expect(view.needsReconcile).toBe(true); expect(view.clock).toBe('00:00');
        expect(view.observation).toEqual({ nowMs: now, localDayKey: '2026-10-10' });
        expect(view.completionEvent).toBe('focus-finished');
        expect(view.phase).toBe('focus'); expect(view.completedToday).toBe(0); expect(view.event).toBeNull();
    });
    it('keeps a selected live task outside the Focus picker and does not clear it when linking is off', () => {
        const state = initial(); state.session.selectedTaskId = 'outside'; const raw = JSON.stringify(state);
        const view = ready(panel(raw, { liveTasks: [task('outside', 'Outside current filters')] }));
        expect(view.selectedTask).toEqual({ id: 'outside', title: 'Outside current filters', taskRevision: taskRevisionOf(task('outside')), completionSource: 'ordinary' });
        expect(ready(panel(raw, { liveTasks: [{ ...task('outside'), status: 'reference' }] })).selectedTask?.completionSource).toBe('reference');
        expect(view.selectionMissing).toBe(false);
        expect(ready(panel(raw)).selectionMissing).toBe(true);
        const off = ready(panel(raw, { settings: { features: { pomodoro: true } } }));
        expect(off.selectedTask).toBeNull(); expect(off.selectionMissing).toBe(false);
        expect(JSON.stringify(state)).toBe(raw);
    });
    it('retains completion feedback across idle draws only for the same saved session generation', () => {
        const state = initial(); state.session.timerState.phase = 'break'; state.session.timerState.remainingSeconds = 300;
        const raw = JSON.stringify(state), lastEvent = { sessionID: id, generation: 0, value: 'focus-finished' as const };
        expect(ready(panel(raw, { lastEvent })).event).toBe('Focus session complete. Take a short break.');
        expect(ready(panel(raw, { lastEvent, nowMs: now + 30_000 })).event).toBe('Focus session complete. Take a short break.');
        expect(ready(panel(raw, { lastEvent: { ...lastEvent, generation: 1 } })).event).toBeNull();
        expect(ready(panel(raw, { lastEvent: { ...lastEvent, sessionID: '22222222-2222-4222-8222-222222222222' } })).event).toBeNull();
    });
    it('uses RN custom preset normalization and device-local collapsed presentation', () => {
        const view = ready(panel(JSON.stringify(initial()), { collapsed: true,
            settings: { features: { pomodoro: true }, gtd: { pomodoro: { customDurations: { focusMinutes: 40, breakMinutes: 8 } } } } }));
        expect(view.collapsed).toBe(true); expect(view.text.collapse).toBe('Expand timer');
        expect(view.presets.map((p) => p.label)).toEqual(['15/3', '25/5', '50/10', '40/8']);
    });
    it('uses RN four-pool deduplication, deletion filtering and first-position order', () => {
        const first = task('shared', 'First'), latest = task('shared', 'Latest');
        const pools = { focusedTasks: [first, { ...task('gone'), deletedAt: '2026-10-10' }],
            schedule: [task('schedule'), latest], nextActions: [task('next')], reviewDue: [task('review'), task('next')] };
        const snapshot = JSON.stringify(pools), choices = getPomodoroTaskChoices(pools);
        expect(choices.map((t) => t.id)).toEqual(['shared', 'schedule', 'next', 'review']);
        expect(choices[0]).toBe(latest); expect(JSON.stringify(pools)).toBe(snapshot);
    });
});
