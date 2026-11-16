import { describe, expect, it } from 'vitest';
import { decodeNativePomodoroSession, nativePomodoroOwedTaskIds, prepareNativePomodoroTransition,
    validatePreparedNativePomodoroTransition, type NativePomodoroRequest, type NativePomodoroSessionRead } from './native-pomodoro-session';
import { taskToSqliteRow } from './task-sync-schema';

const AT = Date.parse('2026-11-16T12:00:00.000Z');
const ID = '11111111-1111-4111-8111-111111111111';
const NEXT = '22222222-2222-4222-8222-222222222222';
const autoStart = { autoStartFocus: true, autoStartBreaks: true };
const task = (id = 'a', minutes = 4, changes = {}) => ({ id, row: taskToSqliteRow({
    id, title: 'Private', status: 'next', tags: [], contexts: [], createdAt: new Date(AT).toISOString(),
    updatedAt: new Date(AT).toISOString(), rev: 1, timeSpentMinutes: minutes, ...changes,
}) });
const initial = (): NativePomodoroSessionRead => {
    const initialized = prepareNativePomodoroTransition({ request: { action: 'initialize', requestId: ID, observedAtMs: AT,
        localDayKey: '2026-11-16', durations: { focusMinutes: 25, breakMinutes: 5 } },
        session: { raw: null, state: null }, target: null, deviceId: null })!;
    const state = decodeNativePomodoroSession(initialized.sessionAfter);
    state.session.selectedTaskId = 'a'; state.session.timerState.isRunning = true;
    state.session.phaseEndsAt = new Date(AT + 1_500_000).toISOString();
    return { raw: JSON.stringify(state), state };
};
const request = (action: 'reconcile' | 'toggle' | 'reset' | 'switchPhase', seconds: number): NativePomodoroRequest => ({
    action, requestId: NEXT, observedAtMs: AT + seconds * 1000, localDayKey: '2026-11-16', autoStart,
});
const read = (raw: string): NativePomodoroSessionRead => ({ raw, state: decodeNativePomodoroSession(raw) });

describe('native partial Pomodoro work', () => {
    it('settles pause once and only new resumed work after restart, keeping completed counts separate', () => {
        const paused = prepareNativePomodoroTransition({ request: request('toggle', 91), session: initial(), target: task(), deviceId: 'device' })!;
        expect(paused.taskPatch?.timeSpentMinutes).toBe(5);
        expect(read(paused.sessionAfter).state?.session).toMatchObject({ workSecondsByTaskId: { a: 31 },
            timerState: { remainingSeconds: 1409, isRunning: false, completedFocusSessions: 0 } });
        const resumed = prepareNativePomodoroTransition({ request: request('toggle', 900), session: read(paused.sessionAfter),
            target: task('a', 5), deviceId: 'device' })!;
        expect(resumed.taskPatch).toBeNull();
        expect(prepareNativePomodoroTransition({ request: request('reconcile', 920), session: read(resumed.sessionAfter),
            target: task('a', 5), deviceId: 'device' })).toBeNull();
        const second = prepareNativePomodoroTransition({ request: request('toggle', 929), session: read(resumed.sessionAfter),
            target: task('a', 5), deviceId: 'device' })!;
        expect(second.taskPatch?.timeSpentMinutes).toBe(6);
        expect(read(second.sessionAfter).state?.session.workSecondsByTaskId).toEqual({});
        expect(second.result.completedFocusSessions).toBe(0);
        expect(validatePreparedNativePomodoroTransition(second)).toEqual(second);
    });
    it('keeps subminute remainders with their owner while switching active tasks', () => {
        const select = (taskId: string, seconds: number) => ({ ...request('reconcile', seconds), action: 'selectTask' as const, taskId });
        const first = prepareNativePomodoroTransition({ request: select('b', 40), session: initial(), target: task(), deviceId: 'device' })!;
        const second = prepareNativePomodoroTransition({ request: select('a', 70), session: read(first.sessionAfter), target: task('b'), deviceId: 'device' })!;
        expect(second.taskPatch).toBeNull();
        expect(read(second.sessionAfter).state?.session.workSecondsByTaskId).toEqual({ a: 40, b: 30 });
        const third = prepareNativePomodoroTransition({ request: request('toggle', 90), session: read(second.sessionAfter), target: task(), deviceId: 'device' })!;
        expect(third.taskPatch?.timeSpentMinutes).toBe(5);
        expect(read(third.sessionAfter).state?.session.workSecondsByTaskId).toEqual({ b: 30 });
    });
    it.each(['reset', 'switchPhase', 'setDurations'] as const)('settles work before %s without counting a completed session', action => {
        const input: NativePomodoroRequest = action === 'setDurations' ? { ...request('reconcile', 91), action,
            durations: { focusMinutes: 50, breakMinutes: 10 } } : request(action, 91);
        const plan = prepareNativePomodoroTransition({ request: input, session: initial(), target: task(), deviceId: 'device' })!;
        expect(plan.taskPatch?.timeSpentMinutes).toBe(5);
        expect(plan.result.completedFocusSessions).toBe(0);
        expect(read(plan.sessionAfter).state?.session).toMatchObject({ workSecondsByTaskId: { a: 31 }, timerState: { isRunning: false } });
    });
    it('caps late task completion at its actual time, then pauses and detaches without selecting another task', () => {
        const plan = prepareNativePomodoroTransition({ request: request('reconcile', 1000), session: initial(),
            target: task('a', 4, { status: 'done', completedAt: new Date(AT + 91_000).toISOString() }), deviceId: 'device' })!;
        expect(plan.taskPatch?.timeSpentMinutes).toBe(5);
        const session = read(plan.sessionAfter);
        expect(session.state?.session).toMatchObject({ workSecondsByTaskId: { a: 31 },
            timerState: { remainingSeconds: 1409, isRunning: false, completedFocusSessions: 0 } });
        expect(session.state?.session.selectedTaskId).toBeUndefined();
        expect(session.state?.session.phaseEndsAt).toBeUndefined();
        expect(prepareNativePomodoroTransition({ request: request('reconcile', 1200), session, target: null, deviceId: 'device' })).toBeNull();
        expect(validatePreparedNativePomodoroTransition(plan)).toEqual(plan);
    });
    it('settles owed map entries through the existing atomic multi-task plan', () => {
        const session = initial(); session.state!.session.workSecondsByTaskId = { b: 91 };
        const updated = read(JSON.stringify(session.state)); const input = request('toggle', 30);
        expect(nativePomodoroOwedTaskIds(input, updated)).toEqual(['b']);
        const plan = prepareNativePomodoroTransition({ request: input, session: updated, target: task(), owed: [task('b')], deviceId: 'device' })!;
        expect(plan.taskPatch).toBeNull(); expect(plan.owed?.[0].taskPatch?.timeSpentMinutes).toBe(5);
        expect(read(plan.sessionAfter).state?.session.workSecondsByTaskId).toEqual({ a: 30, b: 31 });
        expect(validatePreparedNativePomodoroTransition(plan)).toEqual(plan);
    });
    it('strictly rejects invalid work maps and refuses to downgrade map-bearing session receipts', () => {
        for (const work of [{ a: -1 }, { a: 0.5 }, { a: Number.MAX_SAFE_INTEGER + 1 }, JSON.parse('{"__proto__":60}'), { constructor: 60 }]) {
            const session = initial(); session.state!.session.workSecondsByTaskId = work;
            expect(() => decodeNativePomodoroSession(JSON.stringify(session.state))).toThrow();
        }
        const plan = prepareNativePomodoroTransition({ request: request('toggle', 91), session: initial(), target: task(), deviceId: 'device' })!;
        const after = decodeNativePomodoroSession(plan.sessionAfter); delete after.session.workSecondsByTaskId;
        expect(() => validatePreparedNativePomodoroTransition({ ...plan, sessionAfter: JSON.stringify(after) })).toThrow();
    });
});
