import { describe, expect, it } from 'vitest';
import { decodeNativePomodoroSession, nativePomodoroReceiptPayload, parseNativeWatchPomodoroSource,
    prepareNativePomodoroTransition, validatePreparedNativePomodoroTransition, type NativePomodoroRequest } from './native-pomodoro-session';
import { taskToSqliteRow } from './task-sync-schema';

const ID = '11111111-1111-4111-8111-111111111111';
const NEXT = 'abcdef22-2222-4222-8222-222222222222';
const AT = Date.parse('2026-10-10T00:00:00.000Z');
const autoStart = { autoStartFocus: false, autoStartBreaks: false };
const source = (action: 'start' | 'pause' | 'reset', createdAtMs = AT + 1) => JSON.stringify({ protocolVersion: 1,
    id: NEXT, source: 'apple-watch', kind: 'pomodoro', createdAt: new Date(createdAtMs).toISOString(), action, taskId: 'next-task' });
const request = (action: 'start' | 'pause' | 'reset', createdAtMs = AT + 1): Extract<NativePomodoroRequest, { action: 'watch' }> => ({
    action: 'watch', requestId: NEXT, observedAtMs: AT + 10_000, localDayKey: '2026-10-10', autoStart,
    durations: { focusMinutes: 50, breakMinutes: 10 }, selectedTaskId: 'next-task', sourceJSON: source(action, createdAtMs),
});
const initial = () => {
    const plan = prepareNativePomodoroTransition({ request: { action: 'initialize', requestId: ID, observedAtMs: AT,
        localDayKey: '2026-10-10', durations: { focusMinutes: 25, breakMinutes: 5 } },
        session: { raw: null, state: null }, target: null, deviceId: null })!;
    return decodeNativePomodoroSession(plan.sessionAfter);
};
const target = { id: 'old-task', row: taskToSqliteRow({ id: 'old-task', title: 'Private', status: 'next', tags: [], contexts: [],
    createdAt: new Date(AT).toISOString(), updatedAt: new Date(AT).toISOString(), timeSpentMinutes: 4, rev: 2 }) };

describe('native Watch Pomodoro source boundary', () => {
    it('preserves exact wire identity while parsing canonical fields and ISO offsets', () => {
        expect(parseNativeWatchPomodoroSource(source('start'))).toEqual({ id: NEXT, action: 'start', createdAtMs: AT + 1, taskId: 'next-task' });
        const value = JSON.parse(source('pause')); delete value.taskId; value.createdAt = '2026-10-10T01:00:00+01:00';
        expect(parseNativeWatchPomodoroSource(JSON.stringify(value))).toEqual({ id: NEXT, action: 'pause', createdAtMs: AT });
    });
    it.each([
        { protocolVersion: true }, { protocolVersion: 2 }, { id: NEXT.toUpperCase() }, { id: 'bad' }, { source: 'phone' },
        { kind: 'capture' }, { action: 'toggle' }, { createdAt: '2026-02-30T00:00:00Z' }, { createdAt: '2026-10-10' },
        { createdAt: '2026-10-10T24:00:00Z' }, { createdAt: '1999-12-31T23:59:59Z' }, { createdAt: '2100-01-01T00:00:01Z' },
        { taskId: null }, { taskId: '' }, { taskId: ' task' }, { taskId: 'task\ntext' }, { taskId: 'é'.repeat(257) }, { extra: true },
    ])('refuses malformed wire fields %j', (change) => {
        expect(() => parseNativeWatchPomodoroSource(JSON.stringify({ ...JSON.parse(source('start')), ...change }))).toThrow();
    });
    it('refuses duplicate and escaped duplicate fields, invalid JSON and oversized UTF8', () => {
        for (const raw of [source('start').replace('"protocolVersion":1', '"protocolVersion":1,"protocolVersion":1'),
            source('start').replace('"action":"start"', '"action":"start","\\u0061ction":"start"'), '{',
            `${' '.repeat(32 * 1024)}${source('start')}`, `${'é'.repeat(16 * 1024)}${source('start')}`])
            expect(() => parseNativeWatchPomodoroSource(raw)).toThrow();
        const input = request('start'); input.requestId = ID;
        expect(() => prepareNativePomodoroTransition({ request: input, session: { raw: null, state: null }, target: null, deviceId: null })).toThrow();
    });
});

describe('native Watch desired timer transitions', () => {
    it.each(['start', 'pause', 'reset'] as const)('initializes absent state and applies offline %s in one plan', action => {
        const input = request(action, AT - 60_000);
        const plan = prepareNativePomodoroTransition({ request: input, session: { raw: null, state: null }, target: null, deviceId: 'device' })!;
        const after = decodeNativePomodoroSession(plan.sessionAfter);
        expect(after.session).toMatchObject({ durations: input.durations, selectedTaskId: 'next-task', updatedAtMs: AT - 60_000,
            timerState: { phase: 'focus', isRunning: action === 'start', remainingSeconds: 3000, completedFocusSessions: 0 } });
        expect(after.generation).toBe(0); expect(after.sessionID).toBe(NEXT);
        expect(after.session.phaseEndsAt).toBe(action === 'start' ? new Date(input.observedAtMs + 3_000_000).toISOString() : undefined);
        expect(plan.target).toBeNull(); expect(plan.taskPatch).toBeNull(); expect(plan.deviceId).toBeNull();
        expect(validatePreparedNativePomodoroTransition(plan)).toEqual(plan);
    });
    it.each(['start', 'pause', 'reset'] as const)('applies desired %s to stopped, running and expired timers', action => {
        for (const mode of ['stopped', 'running', 'expired']) {
            const before = initial(); before.session.selectedTaskId = target.id; before.session.timerState.remainingSeconds = 120;
            if (mode !== 'stopped') {
                before.session.timerState.isRunning = true;
                before.session.phaseEndsAt = new Date(mode === 'expired' ? AT + 1000 : AT + 90_000).toISOString();
            }
            const plan = prepareNativePomodoroTransition({ request: request(action),
                session: { raw: JSON.stringify(before), state: before }, target, deviceId: 'device' })!;
            const after = decodeNativePomodoroSession(plan.sessionAfter);
            expect(after.session.updatedAtMs).toBe(AT + 1); expect(after.generation).toBe(1);
            expect(after.session.selectedTaskId).toBe('next-task'); expect(after.session.durations).toEqual(before.session.durations);
            expect(after.session.timerState.isRunning).toBe(action === 'start');
            if (mode === 'running' && action === 'start') expect(after.session.phaseEndsAt).toBe(before.session.phaseEndsAt);
            if (mode === 'stopped' && action === 'start') expect(after.session.phaseEndsAt).toBe(new Date(AT + 130_000).toISOString());
            if (mode === 'running' && action === 'pause') expect(after.session.timerState.remainingSeconds).toBe(80);
            if (action === 'reset') expect(after.session.timerState.remainingSeconds).toBe(mode === 'expired' ? 300 : 1500);
            if (mode === 'expired') {
                expect(plan.taskPatch).toMatchObject({ timeSpentMinutes: 29, rev: 3, revBy: 'device' });
                expect(after.session.sessionHistory.completedFocusSessionsByTaskId).toEqual({ 'old-task': 1 });
            } else expect(plan.taskPatch).toBeNull();
            expect(validatePreparedNativePomodoroTransition(plan)).toEqual(plan);
        }
    });
    it.each([-1, 0])('receipts stale/equal commands without resolving expiration or changing exact bytes (%i)', offset => {
        const state = initial(); state.session.timerState.isRunning = true; state.session.phaseEndsAt = new Date(AT - 1000).toISOString();
        state.session.selectedTaskId = target.id; state.generation = Number.MAX_SAFE_INTEGER;
        const raw = ` \n${JSON.stringify(state, null, 2)}\n `;
        for (const action of ['start', 'pause', 'reset'] as const) {
            const plan = prepareNativePomodoroTransition({ request: request(action, AT + offset), session: { raw, state }, target, deviceId: 'device' })!;
            expect(plan.sessionAfter).toBe(raw); expect(plan.sessionBefore).toBe(raw); expect(plan.target).toBeNull(); expect(plan.taskPatch).toBeNull();
            expect(plan.result).toMatchObject({ generation: state.generation, completedFocusSessions: 0, creditedMinutes: 0, creditDisposition: 'none' });
            expect(validatePreparedNativePomodoroTransition(plan)).toEqual(plan);
        }
    });
    it('retains exact source bytes and rejects same-ID payload substitution in plan validation', () => {
        const input = request('start'); input.sourceJSON = ` ${input.sourceJSON}\n`;
        const plan = prepareNativePomodoroTransition({ request: input, session: { raw: null, state: null }, target: null, deviceId: null })!;
        expect(plan.request).toEqual(input); expect(nativePomodoroReceiptPayload(plan)).toContain(JSON.stringify(input.sourceJSON));
        expect(() => validatePreparedNativePomodoroTransition({ ...plan, request: { ...input, sourceJSON: source('pause') } })).toThrow();
    });
});
