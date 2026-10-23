import { describe, expect, it } from 'vitest';
import { buildNativePomodoroAlarmIntent } from './native-pomodoro-alarm';
import { planNativePomodoroAlarmEffects, prepareNativePomodoroAlarmDispatch,
    type NativePomodoroAlarmObservation } from './native-pomodoro-alarm-effects';
import { decodeNativePomodoroSession, prepareNativePomodoroTransition } from './native-pomodoro-session';

const now = Date.parse('2026-10-11T12:00:00.000Z');
const sessionID = '11111111-1111-4111-8111-111111111111';
const otherSessionID = '22222222-2222-4222-8222-222222222222';
const scope = 'tech.dongdongbh.mindwtr:' + 'a'.repeat(64);
const oldScope = 'tech.dongdongbh.mindwtr:' + 'b'.repeat(64);
const foreignScope = 'tech.dongdongbh.mindwtr:' + 'c'.repeat(64);
const initialized = prepareNativePomodoroTransition({ request: { action: 'initialize', requestId: sessionID,
    observedAtMs: now, localDayKey: '2026-10-11', durations: { focusMinutes: 25, breakMinutes: 5 } },
    session: { raw: null, state: null }, target: null, deviceId: null })!.sessionAfter;
type Intent = ReturnType<typeof buildNativePomodoroAlarmIntent>;
type Schedule = Extract<Intent, { kind: 'schedule' }>;
type Receipt = Pick<Schedule, 'sessionID' | 'phase' | 'fireAtMs' | 'immediate'> & { status: 'attempted' | 'confirmed' };
const scheduleIntent = (fireAtMs = now + 60_000, phase: 'focus' | 'break' = 'focus', id = sessionID, nowMs = now): Schedule => {
    const state = decodeNativePomodoroSession(initialized);
    state.sessionID = id; state.session.timerState.isRunning = true; state.session.timerState.phase = phase;
    state.session.timerState.remainingSeconds = phase === 'focus' ? 1500 : 300;
    state.session.phaseEndsAt = new Date(fireAtMs).toISOString();
    const intent = buildNativePomodoroAlarmIntent({ raw: JSON.stringify(state), settings: {}, nowMs, t: (key) => key });
    if (intent.kind !== 'schedule') throw new Error('Expected schedule fixture');
    return intent;
};
const stopped = buildNativePomodoroAlarmIntent({ raw: initialized, settings: {}, nowMs: now, t: (key) => key });
const off = buildNativePomodoroAlarmIntent({ raw: '{', settings: { gtd: { pomodoro: { completionAlert: false } } },
    nowMs: now, t: (key) => key });
const receipt = (intent = scheduleIntent(), status: Receipt['status'] = 'confirmed'): Receipt => ({
    sessionID: intent.sessionID, phase: intent.phase, fireAtMs: intent.fireAtMs, immediate: intent.immediate, status,
});

const rawState = (alarm: Receipt | null, selectedScope = scope) => JSON.stringify({ version: 1, libraries: [{ scope: selectedScope, alarm }] });
const observation = (intent = scheduleIntent(), selectedScope = scope, suffix = '1'): NativePomodoroAlarmObservation => ({
    identifier: 'mindwtr-native-pomodoro:' + suffix.repeat(64), scope: selectedScope,
    sessionID: intent.sessionID, phase: intent.phase, fireAtMs: intent.fireAtMs,
});
type Input = Parameters<typeof planNativePomodoroAlarmEffects>[0];
const plan = (overrides: Partial<Input> = {}) => planNativePomodoroAlarmEffects({ intent: scheduleIntent(), granted: true,
    raw: null, scope, pending: [], delivered: [], nowMs: now, ...overrides });
const decode = (raw: string | null) => JSON.parse(raw!);

describe('native Pomodoro alarm effect ownership', () => {
    it.each([now + 60_000, now + 1_000, now - 1_000])('publishes an attempted receipt before scheduling deadline %s and confirms only afterward', (fireAtMs) => {
        const intent = scheduleIntent(fireAtMs), result = plan({ intent });
        expect(result.schedule).toEqual(intent); expect(result.outcome).toBe('scheduled');
        expect(decode(result.writeAhead)).toEqual(decode(rawState(receipt(intent, 'attempted'))));
        expect(result.published).toBe(rawState(receipt(intent))); expect(result.after).toBe(result.published);
        expect(result.cancelPending).toEqual([]); expect(result.cancelDelivered).toEqual([]);
    });

    it.each(['pending', 'delivered'] as const)('confirms a matching %s inventory item without scheduling again', (inventory) => {
        const intent = scheduleIntent(now + 1_000), found = observation(intent);
        const result = plan({ intent, raw: rawState(receipt(intent, 'attempted')), [inventory]: [found] });
        expect(result.schedule).toBeNull(); expect(result.outcome).toBe('retained');
        expect(result.writeAhead).toBe(rawState(receipt(intent))); expect(result.published).toBe(result.writeAhead);
        expect(result.cancelPending).toEqual([]); expect(result.cancelDelivered).toEqual([]);
        const withoutReceipt = plan({ intent, [inventory]: [found] });
        expect(withoutReceipt.schedule).toBeNull(); expect(withoutReceipt.published).toBe(rawState(receipt(intent)));
    });

    it('derives a fresh attempt from the actual effect observation rather than a stale intent observation', () => {
        const intent = scheduleIntent(), nowMs = intent.fireAtMs - 1_000;
        const result = plan({ intent, nowMs });
        expect(result.schedule).toEqual({ ...intent, immediate: true, observedAtMs: nowMs });
        expect(result.writeAhead).toBe(rawState({ ...receipt(intent, 'attempted'), immediate: true }));
        expect(result.published).toBe(rawState({ ...receipt(intent), immediate: true }));
    });

    it.each(['attempted', 'confirmed'] as const)('never resends absent immediate inventory with a %s receipt, even after clock rollback', (status) => {
        const intent = scheduleIntent(now + 1_000), raw = rawState(receipt(intent, status));
        for (const nowMs of [now, now + 10_000, now - 60_000]) {
            const result = plan({ intent, raw, nowMs });
            expect(result.schedule).toBeNull(); expect(result.writeAhead).toBe(raw);
            expect(result.published).toBe(raw); expect(result.after).toBe(raw);
            expect(result.outcome).toBe(status === 'attempted' ? 'uncertain' : 'retained');
        }
    });

    it.each(['attempted', 'confirmed'] as const)('repairs absent future inventory with a %s receipt but avoids a second attempt at the immediate boundary', (status) => {
        const intent = scheduleIntent(now + 60_000), raw = rawState(receipt(intent, status));
        const future = plan({ intent, raw, nowMs: intent.fireAtMs - 1_001 });
        expect(future.schedule).toEqual({ ...intent, observedAtMs: intent.fireAtMs - 1_001 });
        expect(future.writeAhead).toBe(rawState(receipt(intent, 'attempted')));
        expect(future.published).toBe(rawState(receipt(intent)));
        for (const nowMs of [intent.fireAtMs - 1_000, intent.fireAtMs, intent.fireAtMs + 1]) {
            const near = plan({ intent, raw, nowMs });
            expect(near.schedule).toBeNull(); expect(near.writeAhead).toBe(raw);
        }
    });

    it.each(['session', 'phase', 'deadline'] as const)('treats a changed %s as a new alarm identity', (change) => {
        const priorIntent = scheduleIntent(now + 60_000);
        const intent = scheduleIntent(change === 'deadline' ? now + 60_001 : priorIntent.fireAtMs,
            change === 'phase' ? 'break' : 'focus', change === 'session' ? otherSessionID : sessionID);
        const previous = observation(priorIntent), result = plan({ intent, raw: rawState(receipt(priorIntent)), pending: [previous] });
        expect(result.schedule).toEqual(intent); expect(result.cancelPending).toEqual([previous]);
        expect(result.published).toBe(rawState(receipt(intent)));
    });

    it('passive stop preserves due pending/delivered alarms and receipts while removing future ones', () => {
        const due = scheduleIntent(now), future = scheduleIntent(now + 1), dueItem = observation(due), futureItem = observation(future, scope, '2');
        const result = plan({ intent: stopped, raw: rawState(receipt(due)), pending: [dueItem, futureItem], delivered: [dueItem, futureItem] });
        expect(result.schedule).toBeNull(); expect(result.writeAhead).toBe(rawState(receipt(due)));
        expect(result.cancelPending).toEqual([futureItem]); expect(result.cancelDelivered).toEqual([futureItem]);
        const stoppedFuture = plan({ intent: stopped, raw: rawState(receipt(future)), pending: [futureItem] });
        expect(stoppedFuture.after).toBe(rawState(null)); expect(stoppedFuture.cancelPending).toEqual([futureItem]);
    });

    it.each(['off', 'denied'] as const)('%s explicitly cancels due alarms and withdraws their receipt', (reason) => {
        const due = scheduleIntent(now - 1), found = observation(due);
        const result = plan({ intent: reason === 'off' ? off : due, granted: reason !== 'denied', raw: rawState(receipt(due)),
            pending: [found], delivered: [found] });
        expect(result.schedule).toBeNull(); expect(result.outcome).toBe('cancelled');
        expect(result.cancelPending).toEqual([found]); expect(result.cancelDelivered).toEqual([found]);
        expect(result.writeAhead).toBe(rawState(null)); expect(result.published).toBe(result.writeAhead); expect(result.after).toBe(result.writeAhead);
    });

    it('preserves an old due alert when a new active phase is scheduled', () => {
        const priorIntent = scheduleIntent(now - 1), dueItem = observation(priorIntent);
        const result = plan({ raw: rawState(receipt(priorIntent)), pending: [dueItem], delivered: [dueItem] });
        expect(result.schedule).toEqual(scheduleIntent()); expect(result.cancelPending).toEqual([]); expect(result.cancelDelivered).toEqual([]);
    });

    it('retains retired known scope authority through writeAhead/published and drops it only in after', () => {
        const oldIntent = scheduleIntent(now - 1), oldReceipt = receipt(oldIntent), oldPending = observation(oldIntent, oldScope);
        const oldDelivered = observation(oldIntent, oldScope, '2'), foreign = observation(oldIntent, foreignScope, '3');
        const raw = rawState(oldReceipt, oldScope), result = plan({ raw, pending: [oldPending, foreign], delivered: [oldDelivered, foreign] });
        expect(result.cancelPending).toEqual([oldPending]); expect(result.cancelDelivered).toEqual([oldDelivered]);
        const oldLibrary = { scope: oldScope, alarm: oldReceipt };
        expect(decode(result.writeAhead)).toEqual({ version: 1, libraries: [oldLibrary, { scope, alarm: receipt(scheduleIntent(), 'attempted') }] });
        expect(decode(result.published)).toEqual({ version: 1, libraries: [oldLibrary, { scope, alarm: receipt() }] });
        expect(result.after).toBe(rawState(receipt()));
        // A crash before native verifies removals must still find the old scope for another cleanup turn.
        for (const retained of [result.writeAhead, result.published]) {
            const retry = plan({ raw: retained, pending: [oldPending, foreign], delivered: [oldDelivered, foreign] });
            expect(retry.cancelPending).toEqual([oldPending]); expect(retry.cancelDelivered).toEqual([oldDelivered]);
            expect(decode(retry.writeAhead).libraries[0]).toEqual(oldLibrary);
        }
        const after = plan({ raw: result.after, pending: [oldPending, foreign], delivered: [oldDelivered, foreign] });
        expect(after.cancelPending).toEqual([]); expect(after.cancelDelivered).toEqual([]);
    });

    it('cleans retired scope inventory during passive stop while leaving unknown foreign scope alone', () => {
        const due = scheduleIntent(now), oldItem = observation(due, oldScope), foreign = observation(due, foreignScope, '2');
        const raw = JSON.stringify({ version: 1, libraries: [{ scope: oldScope, alarm: receipt(due) }, { scope, alarm: receipt(due) }] });
        const result = plan({ intent: stopped, raw, pending: [oldItem, foreign], delivered: [oldItem, foreign] });
        expect(result.schedule).toBeNull(); expect(result.cancelPending).toEqual([oldItem]); expect(result.cancelDelivered).toEqual([oldItem]);
        expect(decode(result.writeAhead)).toEqual(decode(raw)); expect(result.published).toBe(result.writeAhead);
        expect(result.after).toBe(rawState(receipt(due)));
    });

    it('keeps valid uninitialized observations entirely unchanged, but denial can cancel owned inventory', () => {
        const intent = buildNativePomodoroAlarmIntent({ raw: null, settings: {}, nowMs: now, t: (key) => key });
        const found = observation(), raw = '  ' + rawState(receipt()) + '\n';
        expect(plan({ intent, raw, pending: [found], delivered: [found] })).toEqual({ writeAhead: raw, published: raw, after: raw,
            schedule: null, cancelPending: [], cancelDelivered: [], outcome: 'uninitialized' });
        expect(plan({ intent })).toEqual({ writeAhead: null, published: null, after: null,
            schedule: null, cancelPending: [], cancelDelivered: [], outcome: 'uninitialized' });
        const denied = plan({ intent, granted: false, raw, pending: [found], delivered: [found] });
        expect(denied.outcome).toBe('cancelled'); expect(denied.cancelPending).toEqual([found]); expect(denied.cancelDelivered).toEqual([found]);
        expect(denied.after).toBe(rawState(null));
    });

    it('leaves unknown foreign scopes alone even under explicit cancellation', () => {
        const unknown = observation(scheduleIntent(now), foreignScope);
        for (const overrides of [{ intent: off }, { granted: false }]) {
            const result = plan({ ...overrides, pending: [unknown], delivered: [unknown] });
            expect(result.cancelPending).toEqual([]); expect(result.cancelDelivered).toEqual([]);
            expect(result.schedule).toBeNull();
        }
        expect(plan({ intent: stopped })).toEqual({ writeAhead: null, published: null, after: null,
            schedule: null, cancelPending: [], cancelDelivered: [], outcome: 'retained' });
    });
});

describe('native Pomodoro alarm closed state and inventory validation', () => {
    it('refuses malformed state shapes, receipts, bounds and duplicate scopes without planning effects', () => {
        const good = { version: 1, libraries: [{ scope, alarm: receipt() }] };
        const malformed: unknown[] = [null, [], {}, { ...good, extra: true }, { ...good, version: 2 },
            { ...good, libraries: {} }, { ...good, libraries: [good.libraries[0], good.libraries[0]] },
            { ...good, libraries: [{ ...good.libraries[0], extra: true }] },
            { ...good, libraries: [{ scope }] }, { ...good, libraries: [{ scope, alarm: undefined }] },
            { ...good, libraries: [{ scope: 'bad', alarm: null }] }];
        for (const alarm of [{ ...receipt(), extra: true }, { ...receipt(), status: 'unknown' }, { ...receipt(), immediate: 1 },
            { ...receipt(), sessionID: sessionID.toUpperCase().replace('11111111', 'AAAAAAAA') }, { ...receipt(), phase: 'rest' },
            { ...receipt(), fireAtMs: 1.5 }, { ...receipt(), fireAtMs: 8_640_000_000_000_001 }, { ...receipt(), fireAtMs: null }, []])
            malformed.push({ ...good, libraries: [{ scope, alarm }] });
        for (const raw of ['', '{', ...malformed.map((value) => JSON.stringify(value)), ' '.repeat(1024 * 1024 + 1),
            '🧠'.repeat(262_145)]) expect(() => plan({ raw })).toThrow('NOT_READY');
        const tooMany = { version: 1, libraries: Array.from({ length: 65 }, (_, index) => ({ scope: 'library' + index + ':' + 'a'.repeat(64), alarm: null })) };
        expect(() => plan({ raw: JSON.stringify(tooMany) })).toThrow('NOT_READY');
        const empty = { version: 1, libraries: [] }, encoded = JSON.stringify(empty);
        const boundary = encoded + ' '.repeat(1024 * 1024 - encoded.length);
        expect(() => plan({ raw: boundary })).not.toThrow(); expect(() => plan({ raw: boundary + ' ' })).toThrow('NOT_READY');
    });

    it.each(['pending', 'delivered'] as const)('refuses malformed %s inventory including unknown fields and duplicate identifiers', (inventory) => {
        const good = observation();
        for (const value of [null, {}, [null], [{ ...good, extra: true }], [{ ...good, identifier: 'foreign' }],
            [{ ...good, identifier: 'mindwtr-native-pomodoro:' + 'A'.repeat(64) }], [{ ...good, scope: 'invalid' }],
            [{ ...good, sessionID: 'invalid' }], [{ ...good, phase: 'rest' }], [{ ...good, fireAtMs: 1.5 }],
            [{ ...good, fireAtMs: 8_640_000_000_000_001 }], [good, good], Array(4097).fill(good),
            [Object.fromEntries(Object.entries(good).filter(([name]) => name !== 'phase'))]]) {
            expect(() => plan({ [inventory]: value })).toThrow('NOT_READY');
        }
    });

    it('permits the same observation across pending/delivered, but refuses conflicting identity under one identifier', () => {
        const found = observation();
        expect(() => plan({ pending: [found], delivered: [found] })).not.toThrow();
        for (const changed of [{ ...found, scope: foreignScope }, { ...found, sessionID: otherSessionID },
            { ...found, phase: 'break' }, { ...found, fireAtMs: found.fireAtMs + 1 }]) {
            expect(() => plan({ pending: [found], delivered: [changed] })).toThrow('NOT_READY');
        }
    });

    it('accepts bounded 64-library and 4096-observation inventories without acquiring foreign authority', () => {
        const libraries = [{ scope, alarm: null }, ...Array.from({ length: 63 }, (_, index) => ({
            scope: 'library' + index + ':' + 'a'.repeat(64), alarm: null,
        }))];
        const pending = Array.from({ length: 4096 }, (_, index) => ({ ...observation(scheduleIntent(), foreignScope),
            identifier: 'mindwtr-native-pomodoro:' + index.toString(16).padStart(64, '0') }));
        const result = plan({ intent: stopped, raw: JSON.stringify({ version: 1, libraries }), pending, delivered: pending });
        expect(result.schedule).toBeNull(); expect(result.cancelPending).toEqual([]); expect(result.cancelDelivered).toEqual([]);
        expect(decode(result.writeAhead).libraries).toHaveLength(64); expect(result.after).toBe(rawState(null));
    });

    it('validates permission, scope and clock even for uninitialized or explicitly cancelled intents', () => {
        for (const intent of [{ kind: 'uninitialized' } as const, off]) {
            for (const overrides of [{ scope: 'bad' }, { scope: 'x'.repeat(256) + ':' + 'a'.repeat(64) },
                { scope: 'bundle:' + 'A'.repeat(64) }, { granted: 1 }, { nowMs: NaN }, { nowMs: Infinity },
                { nowMs: 1.5 }, { nowMs: 8_640_000_000_000_001 }]) {
                expect(() => plan({ intent, ...overrides } as Partial<Input>)).toThrow('NOT_READY');
            }
            expect(() => plan({ intent, raw: '{}' })).toThrow('NOT_READY');
            expect(() => plan({ intent, pending: [{}] })).toThrow('NOT_READY');
        }
    });
});

describe('native Pomodoro same-owner dispatch refresh', () => {
    it('refreshes a delayed future attempt to immediate and publishes its fence before confirmation, retaining every old scope', () => {
        const attempt = scheduleIntent(), intent = scheduleIntent(attempt.fireAtMs, 'focus', sessionID, attempt.fireAtMs - 1_000);
        const prior = { scope: oldScope, alarm: receipt(scheduleIntent(now - 1)) };
        const other = { scope: foreignScope, alarm: null };
        const raw = JSON.stringify({ version: 1, libraries: [prior, { scope, alarm: receipt(attempt, 'attempted') }, other] });
        const result = prepareNativePomodoroAlarmDispatch({ intent, attempt, raw, scope });
        expect(result.schedule).toEqual(intent); expect(result.schedule.immediate).toBe(true);
        expect(decode(result.writeAhead)).toEqual({ version: 1, libraries: [prior,
            { scope, alarm: { ...receipt(attempt, 'attempted'), immediate: true } }, other] });
        expect(decode(result.published)).toEqual({ version: 1, libraries: [prior,
            { scope, alarm: { ...receipt(attempt), immediate: true } }, other] });
        // The planner still declines another immediate attempt after a crash or missing inventory.
        expect(plan({ intent, raw: result.writeAhead, nowMs: intent.observedAtMs }).schedule).toBeNull();
    });

    it('leaves future write-ahead bytes unchanged when refreshing does not change the durable receipt', () => {
        const attempt = scheduleIntent(), intent = scheduleIntent(attempt.fireAtMs, 'focus', sessionID, now + 1_000);
        const raw = '  ' + rawState(receipt(attempt, 'attempted')) + '\n';
        const result = prepareNativePomodoroAlarmDispatch({ intent, attempt, raw, scope });
        expect(result.schedule).toEqual(intent); expect(result.schedule.immediate).toBe(false);
        expect(result.writeAhead).toBe(raw);
        expect(decode(result.published)).toEqual(decode(rawState(receipt(attempt))));
    });

    it('rejects wrong scope, missing or confirmed receipts and non-scheduling intentions', () => {
        const attempt = scheduleIntent(), raw = rawState(receipt(attempt, 'attempted'));
        const input = { intent: attempt, attempt, raw, scope };
        for (const overrides of [{ scope: oldScope }, { scope: 'invalid' }, { raw: null }, { raw: rawState(null) },
            { raw: rawState(receipt(attempt)) }, { raw: rawState(receipt(attempt, 'attempted'), oldScope) },
            { intent: stopped }, { intent: off }, { intent: { kind: 'uninitialized' } as const }, { attempt: null }]) {
            expect(() => prepareNativePomodoroAlarmDispatch({ ...input, ...overrides })).toThrow('NOT_READY');
        }
    });

    it.each(['session', 'phase', 'deadline'] as const)('rejects mismatched %s in either the native attempt or durable receipt', (change) => {
        const intent = scheduleIntent(), different = scheduleIntent(change === 'deadline' ? intent.fireAtMs + 1 : intent.fireAtMs,
            change === 'phase' ? 'break' : 'focus', change === 'session' ? otherSessionID : sessionID);
        expect(() => prepareNativePomodoroAlarmDispatch({ intent, attempt: different, scope,
            raw: rawState(receipt(intent, 'attempted')) })).toThrow('NOT_READY');
        expect(() => prepareNativePomodoroAlarmDispatch({ intent, attempt: intent, scope,
            raw: rawState(receipt(different, 'attempted')) })).toThrow('NOT_READY');
    });

    it('refuses clock rollback that would downgrade an already durable immediate fence', () => {
        const future = scheduleIntent(), immediate = scheduleIntent(future.fireAtMs, 'focus', sessionID, future.fireAtMs - 1_000);
        const fenced = rawState(receipt(immediate, 'attempted'));
        expect(() => prepareNativePomodoroAlarmDispatch({ intent: future, attempt: immediate, raw: fenced, scope })).toThrow('NOT_READY');
        const stillImmediate = scheduleIntent(future.fireAtMs, 'focus', sessionID, future.fireAtMs + 1);
        const result = prepareNativePomodoroAlarmDispatch({ intent: stillImmediate, attempt: immediate, raw: fenced, scope });
        expect(result.writeAhead).toBe(fenced); expect(result.schedule.immediate).toBe(true);
        expect(result.published).toBe(rawState(receipt(stillImmediate)));
    });
});
