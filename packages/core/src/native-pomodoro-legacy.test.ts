import { describe, expect, it } from 'vitest';
import { decodeNativePomodoroSession, nativePomodoroReceiptPayload, prepareNativePomodoroTransition,
    validatePreparedNativePomodoroTransition, type NativePomodoroRequest } from './native-pomodoro-session';
import { resolvePomodoroSession, serializePomodoroSession, type StoredPomodoroSession } from './pomodoro-session';
import { TASK_SQLITE_COLUMNS } from './task-sync-schema';
import { TIME_SPENT_MAX_MINUTES } from './time-spent';

const ID = '11111111-1111-4111-8111-111111111111';
const AT = '2026-10-10T00:00:00.000Z';
const now = Date.parse(AT);
const request = (sessionRaw: string | null, collapsedRaw: string | null = null): Extract<NativePomodoroRequest, { action: 'adoptLegacy' }> => ({
    action: 'adoptLegacy', requestId: ID, observedAtMs: now, localDayKey: '2026-10-10',
    autoStart: { autoStartFocus: false, autoStartBreaks: false },
    legacy: { version: 1, namespace: 'NativeUITests.fixture', sessionRaw, collapsedRaw },
});
const selectedRow = (cells: Record<string, string | number | null> = {}) => ({ id: 'task',
    row: TASK_SQLITE_COLUMNS.map((name) => ({ id: 'task', status: 'next', timeSpentMinutes: 4, rev: 1, ...cells } as Record<string, string | number | null>)[name] ?? null) });
const running = (changes: StoredPomodoroSession = {}): StoredPomodoroSession => ({
    durations: { focusMinutes: 25, breakMinutes: 5 },
    timerState: { phase: 'focus', remainingSeconds: 1, isRunning: true, completedFocusSessions: 3 },
    selectedTaskId: 'task', phaseEndsAt: new Date(now).toISOString(), ...changes,
});
const prepare = (source: StoredPomodoroSession) => prepareNativePomodoroTransition({ request: request(JSON.stringify(source)),
    session: { raw: null, state: null }, target: source.selectedTaskId ? selectedRow() : null, deviceId: 'device' })!;

describe('native Pomodoro legacy adoption', () => {
    it('creates paused defaults only from successful source absence and retains collapse provenance', () => {
        const plan = prepareNativePomodoroTransition({ request: request(null, 'true'),
            session: { raw: null, state: null }, target: null, deviceId: null })!;
        expect(decodeNativePomodoroSession(plan.sessionAfter)).toEqual({ version: 1, sessionID: ID, generation: 0,
            session: { durations: { focusMinutes: 25, breakMinutes: 5 },
                timerState: { phase: 'focus', remainingSeconds: 1500, isRunning: false, completedFocusSessions: 0 },
                sessionHistory: { totalCompletedFocusSessions: 0, completedFocusSessionsByTaskId: {},
                    todayDayKey: '2026-10-10', completedTodayFocusSessions: 0 }, updatedAtMs: 0 } });
        expect(plan.request).toEqual(request(null, 'true'));
        expect(plan.result).toEqual({ sessionID: ID, generation: 0, completedFocusSessions: 0,
            creditedMinutes: 0, creditDisposition: 'none' });
        expect(plan.taskPatch).toBeNull(); expect(plan.sessionBefore).toBeNull();
    });
    it('normalizes old history without recrediting it and credits the new expired focus at the restored 50-minute rate', () => {
        const sessionRaw = JSON.stringify({ durations: { focusMinutes: 50, breakMinutes: 10 },
            timerState: { phase: 'focus', remainingSeconds: 1, isRunning: true, completedFocusSessions: 3 },
            sessionHistory: { totalCompletedFocusSessions: 5, completedFocusSessionsByTaskId: { task: 3 } },
            selectedTaskId: 'task', phaseEndsAt: new Date(now).toISOString(), updatedAtMs: now - 1000 });
        const plan = prepareNativePomodoroTransition({ request: request(sessionRaw), session: { raw: null, state: null },
            target: selectedRow(), deviceId: 'device' })!;
        expect(plan.taskPatch).toEqual({ timeSpentMinutes: 54, rev: 2, revBy: 'device', updatedAt: new Date(now).toISOString() });
        expect(plan.result).toMatchObject({ completedFocusSessions: 6, creditedMinutes: 50, creditDisposition: 'credited' });
        expect(decodeNativePomodoroSession(plan.sessionAfter).session).toEqual({
            durations: { focusMinutes: 50, breakMinutes: 10 },
            timerState: { phase: 'break', remainingSeconds: 600, isRunning: false, completedFocusSessions: 6 },
            selectedTaskId: 'task', sessionHistory: { totalCompletedFocusSessions: 6,
                completedFocusSessionsByTaskId: { task: 4 }, todayDayKey: '2026-10-10', completedTodayFocusSessions: 1 },
            updatedAtMs: now - 1000 });
    });
    it.each([{}, { durations: { focusMinutes: 50 } }, { timerState: { completedFocusSessions: 3 } },
        { sessionHistory: { completedFocusSessionsByTaskId: { task: 2, zero: 0 } } },
        { timerState: { isRunning: true } }, { timerState: { remainingSeconds: 12.9 } }])(
        'normalizes recognized optional historical fields without task credit: %j', (source) => {
            const plan = prepare(source); const state = decodeNativePomodoroSession(plan.sessionAfter).session;
            expect(state).toEqual({ ...serializePomodoroSession(resolvePomodoroSession(source, now, {}, '2026-10-10')), updatedAtMs: 0 });
            expect(state.timerState.isRunning).toBe(false); expect(plan.taskPatch).toBeNull(); expect(plan.result.creditedMinutes).toBe(0);
        });
    it.each([false, true].flatMap((autoStartFocus) => [false, true].flatMap((autoStartBreaks) =>
        (['focus', 'break'] as const).flatMap((phase) => [0, 2500_000, -123_000].map((overdue) =>
            ({ autoStartFocus, autoStartBreaks, phase, overdue }))))))(
        'matches frozen RN phase/deadline policy %j', ({ autoStartFocus, autoStartBreaks, phase, overdue }) => {
            const source = running({ timerState: { phase, isRunning: true, remainingSeconds: 1, completedFocusSessions: 3 },
                phaseEndsAt: new Date(now - overdue).toISOString(), sessionHistory: {
                    totalCompletedFocusSessions: 3, completedFocusSessionsByTaskId: { task: 3 },
                    todayDayKey: '2026-10-10', completedTodayFocusSessions: 2 } });
            const options = { autoStartFocus, autoStartBreaks };
            const plan = prepareNativePomodoroTransition({ request: { ...request(JSON.stringify(source)), autoStart: options },
                session: { raw: null, state: null }, target: selectedRow(), deviceId: 'device' })!;
            const expected = resolvePomodoroSession(source, now, options, '2026-10-10');
            expect(decodeNativePomodoroSession(plan.sessionAfter).session).toEqual({ ...serializePomodoroSession(expected), updatedAtMs: 0 });
            expect(plan.result.creditedMinutes).toBe((expected.sessionHistory.totalCompletedFocusSessions - 3) * 25);
            if (overdue === 0) {
                expect(expected.timerState.phase).toBe(phase === 'focus' ? 'break' : 'focus');
                expect(expected.timerState.isRunning).toBe(phase === 'focus' ? autoStartBreaks : autoStartFocus);
                expect(plan.result.completedFocusSessions).toBe(phase === 'focus' ? 4 : 3);
            }
        });
    it('rolls the frozen day but preserves the restored future mutation clock and negative-clock RN clamp', () => {
        const source = running({ updatedAtMs: now + 60_000, sessionHistory: { totalCompletedFocusSessions: 10,
            completedFocusSessionsByTaskId: { task: 10 }, todayDayKey: '2026-10-09', completedTodayFocusSessions: 9 } });
        const state = decodeNativePomodoroSession(prepare(source).sessionAfter).session;
        expect(state.updatedAtMs).toBe(now + 60_000); expect(state.sessionHistory).toEqual({ totalCompletedFocusSessions: 11,
            completedFocusSessionsByTaskId: { task: 11 }, todayDayKey: '2026-10-10', completedTodayFocusSessions: 1 });
        expect(decodeNativePomodoroSession(prepare({ updatedAtMs: -100 }).sessionAfter).session.updatedAtMs).toBe(0);
    });
    it.each(['missing', 'deleted', 'archived', 'unlinked', 'capped', 'partial-cap'] as const)(
        'retains elapsed history with existing %s credit disposition', (kind) => {
            const source = running(kind === 'unlinked' ? { selectedTaskId: undefined } : {});
            const target = kind === 'unlinked' ? null : kind === 'missing' ? { id: 'task', row: null }
                : selectedRow(kind === 'deleted' ? { deletedAt: '2026-10-09' } : kind === 'archived' ? { status: 'archived' }
                    : { timeSpentMinutes: kind === 'capped' ? TIME_SPENT_MAX_MINUTES : TIME_SPENT_MAX_MINUTES - 10, rev: 2_147_483_647 });
            const plan = prepareNativePomodoroTransition({ request: request(JSON.stringify(source)), session: { raw: null, state: null },
                target, deviceId: kind === 'partial-cap' ? 'device' : null })!;
            expect(plan.result.completedFocusSessions).toBe(4);
            expect(plan.result.creditDisposition).toBe(kind === 'unlinked' ? 'unlinked' : kind === 'capped' ? 'capped'
                : kind === 'partial-cap' ? 'credited' : 'unavailable');
            expect(plan.result.creditedMinutes).toBe(kind === 'partial-cap' ? 10 : 0);
            if (kind === 'partial-cap') expect(plan.taskPatch).toMatchObject({ timeSpentMinutes: TIME_SPENT_MAX_MINUTES, rev: 2_147_483_647 });
            else expect(plan.taskPatch).toBeNull();
        });
    it('requires device authority only for actual credit and exact old selection/native absence', () => {
        const r = request(JSON.stringify(running()));
        for (const deviceId of [null, '', ' __proto__', 'constructor', 'x'.repeat(201)]) {
            expect(() => prepareNativePomodoroTransition({ request: r, session: { raw: null, state: null }, target: selectedRow(), deviceId })).toThrow();
        }
        expect(() => prepareNativePomodoroTransition({ request: r, session: { raw: null, state: null },
            target: { ...selectedRow(), id: 'other' }, deviceId: 'device' })).toThrow();
        const existing = prepare({});
        expect(() => prepareNativePomodoroTransition({ request: r,
            session: { raw: existing.sessionAfter, state: decodeNativePomodoroSession(existing.sessionAfter) },
            target: selectedRow(), deviceId: 'device' })).toThrow();
    });
    it.each(['', ' ', 'null', '[]', '1', '{"version":1}', '{"durations":null}', '{"durations":{"focusMinutes":"50"}}',
        '{"durations":{"focusMinutes":181}}', '{"timerState":{"phase":"other"}}', '{"timerState":{"isRunning":1}}',
        '{"timerState":{"remainingSeconds":-1}}', '{"timerState":{"completedFocusSessions":0.5}}',
        '{"timerState":{"completedFocusSessions":9007199254740992}}', '{"updatedAtMs":1.5}', '{"updatedAtMs":8640000000000001}',
        '{"phaseEndsAt":"not a date"}', '{"selectedTaskId":" task"}', '{"selectedTaskId":"__proto__"}',
        '{"sessionHistory":{"todayDayKey":"2026-02-30"}}', '{"sessionHistory":{"completedTodayFocusSessions":false}}',
        '{"sessionHistory":{"completedFocusSessionsByTaskId":[]}}', '{"sessionHistory":{"completedFocusSessionsByTaskId":{"prototype":1}}}',
        '{"sessionHistory":{"completedFocusSessionsByTaskId":{"a":9007199254740991,"b":1}}}',
        '{"updatedAtMs":1,"updatedAtMs":2}', '{"timerState":{"phase":"focus","ph\\u0061se":"break"}}',
        '{"sessionHistory":{"completedFocusSessionsByTaskId":{"a":1,"\\u0061":2}}}',
        `{"unknown":${'['.repeat(33)}0${']'.repeat(33)}}`])('refuses malformed present source without absence fallback: %s', (raw) => {
            expect(() => prepareNativePomodoroTransition({ request: request(raw), session: { raw: null, state: null },
                target: null, deviceId: null })).toThrow(/Invalid native Pomodoro/);
        });
    it('enforces closed Engine augmentation, canonical namespace and UTF8/source/request/plan budgets', () => {
        const invalidRequests = [ { ...request(null), extra: true }, { ...request(null), legacy: { ...request(null).legacy, extra: 1 } },
            ...['', 'x'.repeat(256), 'a/b', 'é', 'a b', 'a\n'].map((namespace) => ({ ...request(null), legacy: { ...request(null).legacy, namespace } })),
            { ...request(null), legacy: { ...request(null).legacy, version: 2 } },
            { ...request(null), legacy: { ...request(null).legacy, collapsedRaw: false } },
            request(null, 'é'.repeat(500_001)), request('{}' + ' '.repeat(999_999)),
            request('{}' + ' '.repeat(999_998), 'x'.repeat(1_000_000)), request(null, '\\'.repeat(1_000_000)) ];
        for (const value of invalidRequests) expect(() => prepareNativePomodoroTransition({ request: value as NativePomodoroRequest,
            session: { raw: null, state: null }, target: null, deviceId: null })).toThrow();
        expect(prepareNativePomodoroTransition({ request: request(null, 'é'.repeat(500_000)),
            session: { raw: null, state: null }, target: null, deviceId: null })!.request).toEqual(request(null, 'é'.repeat(500_000)));
        // Each source fits; adding the normalized history to the complete plan cannot.
        const counts = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => ['x'.repeat(400) + i, 1]));
        const raw = JSON.stringify({ sessionHistory: { completedFocusSessionsByTaskId: counts } });
        expect(raw.length).toBeLessThan(1_000_000);
        expect(() => prepareNativePomodoroTransition({ request: request(raw, 'x'.repeat(400_000)),
            session: { raw: null, state: null }, target: null, deviceId: null })).toThrow();
        expect(() => prepare({ sessionHistory: { completedFocusSessionsByTaskId: Object.fromEntries(
            Array.from({ length: 10_001 }, (_, i) => [`task-${i}`, 1])) } })).toThrow();
    });
    it('retains exact raw identity and reconstructs frozen plans while refusing forged credit/source/schema', () => {
        const raw = ' {"updatedAtMs":10} ';
        const plan = prepareNativePomodoroTransition({ request: request(raw, 'TRUE'), session: { raw: null, state: null }, target: null, deviceId: null })!;
        expect(plan.request).toEqual(request(raw, 'TRUE')); expect(validatePreparedNativePomodoroTransition(plan)).toEqual(plan);
        const reencoded = prepare({ updatedAtMs: 10 }); expect(plan.sessionAfter).toBe(reencoded.sessionAfter);
        expect(nativePomodoroReceiptPayload(plan)).not.toBe(nativePomodoroReceiptPayload(reencoded));
        for (const forged of [{ ...plan, result: { ...plan.result, creditedMinutes: 25 } },
            { ...plan, request: { ...plan.request, legacy: { ...request(raw).legacy, sessionRaw: '{"updatedAtMs":11}' } } },
            { ...plan, sessionAfter: plan.sessionAfter + ' ' }, { ...plan, extra: true }])
            expect(() => validatePreparedNativePomodoroTransition(forged)).toThrow();
    });
    describe('RN owed credits (pendingCredits)', () => {
        const rowFor = (id: string, cells: Record<string, string | number | null> = {}) => ({ id,
            row: TASK_SQLITE_COLUMNS.map((name) => ({ id, status: 'next', timeSpentMinutes: 4, rev: 1, ...cells } as Record<string, string | number | null>)[name] ?? null) });
        const owing = (pendingCredits: unknown[], changes: StoredPomodoroSession = {}) => JSON.stringify({ ...running(changes), pendingCredits });
        const adopt = (sessionRaw: string, target: ReturnType<typeof rowFor> | null, owed?: ReturnType<typeof rowFor>[]) =>
            prepareNativePomodoroTransition({ request: request(sessionRaw), session: { raw: null, state: null }, target,
                ...(owed ? { owed } : {}), deviceId: 'device' })!;
        const patch = (timeSpentMinutes: number) => ({ timeSpentMinutes, rev: 2, revBy: 'device', updatedAt: new Date(now).toISOString() });
        it('adopts a session with owed credits and credits each once: the selected task in its patch, another task in owed', () => {
            const other = rowFor('other', { timeSpentMinutes: 10 });
            const plan = adopt(owing([{ taskId: 'task', from: 4, to: 29 }, { taskId: 'other', from: 10, to: 35 }]), rowFor('task'), [other]);
            // The owed 25 minutes land first; the expired focus adds its own 25 on top.
            expect(plan.taskPatch).toEqual(patch(54));
            expect(plan.owed).toEqual([{ target: other, taskPatch: patch(35) }]);
            expect(plan.result).toMatchObject({ creditedMinutes: 25, creditDisposition: 'credited' });
            expect(validatePreparedNativePomodoroTransition(plan)).toEqual(plan);
            const paused = adopt(owing([{ taskId: 'task', from: 4, to: 29 }], { timerState: { isRunning: false, completedFocusSessions: 3 } }), rowFor('task'));
            expect(paused.taskPatch).toEqual(patch(29)); expect(paused).not.toHaveProperty('owed');
            expect(paused.result).toMatchObject({ creditedMinutes: 0, creditDisposition: 'none' });
            const unlinked = adopt(owing([{ taskId: 'other', to: 25 }], { selectedTaskId: undefined }), null, [rowFor('other', { timeSpentMinutes: null })]);
            expect(unlinked.taskPatch).toBeNull(); expect(unlinked.owed![0].taskPatch).toEqual(patch(25));
            expect(unlinked.deviceId).toBe('device');
        });
        it('gives no credit to a task already past from, and chains credits in their stored order', () => {
            const paused = { timerState: { isRunning: false, completedFocusSessions: 3 } };
            for (const cells of [{ timeSpentMinutes: 29 }, { timeSpentMinutes: 12 }, { timeSpentMinutes: null }, { deletedAt: AT },
                { status: 'archived' }]) {
                const plan = adopt(owing([{ taskId: 'task', from: 4, to: 29 }], paused), rowFor('task', cells));
                expect(plan.taskPatch).toBeNull(); expect(plan.deviceId).toBeNull();
            }
            expect(adopt(owing([{ taskId: 'task', from: 4, to: 29 }], paused), { id: 'task', row: null }).taskPatch).toBeNull();
            // RN reads a stored 0 as no time, so its credit has no `from`; a `from: null` reads the same way.
            for (const credit of [{ taskId: 'task', to: 25 }, { taskId: 'task', from: null, to: 25 }]) {
                expect(adopt(owing([credit], paused), rowFor('task', { timeSpentMinutes: 0 })).taskPatch).toEqual(patch(25));
                expect(adopt(owing([credit], paused), rowFor('task', { timeSpentMinutes: null })).taskPatch).toEqual(patch(25));
            }
            // The first credit is already on the task (its save landed before the stop); the second still takes it.
            expect(adopt(owing([{ taskId: 'task', from: 4, to: 29 }, { taskId: 'task', from: 29, to: 54 }], paused),
                rowFor('task', { timeSpentMinutes: 29 })).taskPatch).toEqual(patch(54));
        });
        it('refuses owed rows that do not match the stored credits and malformed credits', () => {
            const raw = owing([{ taskId: 'other', from: 10, to: 35 }, { taskId: 'third', from: 1, to: 26 }, { taskId: 'other', from: 35, to: 60 }]);
            const other = rowFor('other', { timeSpentMinutes: 10 }); const third = rowFor('third', { timeSpentMinutes: 1 });
            expect(adopt(raw, rowFor('task'), [other, third]).owed).toHaveLength(2);
            for (const owed of [undefined, [], [other], [third, other], [other, third, third], [other, rowFor('task')]])
                expect(() => adopt(raw, rowFor('task'), owed)).toThrow(/Invalid native Pomodoro/);
            for (const credits of [{}, [null], [{ taskId: 'other' }], [{ taskId: 'other', to: 1.5 }], [{ taskId: 'other', to: -1 }],
                [{ taskId: 'other', to: TIME_SPENT_MAX_MINUTES + 1 }], [{ taskId: 'other', from: '1', to: 2 }], [{ taskId: ' other', to: 2 }],
                [{ taskId: 'other', to: 2, extra: true }]])
                expect(() => adopt(JSON.stringify({ ...running(), pendingCredits: credits }), rowFor('task'), [other]))
                    .toThrow(/Invalid native Pomodoro/);
            const plan = adopt(raw, rowFor('task'), [other, third]);
            for (const forged of [{ ...plan, owed: [] }, { ...plan, owed: [plan.owed![1], plan.owed![0]] },
                { ...plan, owed: [{ ...plan.owed![0], taskPatch: null }, plan.owed![1]] }])
                expect(() => validatePreparedNativePomodoroTransition(forged)).toThrow();
        });
    });
    it('documents both historical independent-write variants without inferring repair from task minutes', () => {
        // Saved history landed, task credit failed: the historical session is never recredited.
        const historyLanded = prepare(running({ timerState: { isRunning: false, completedFocusSessions: 3 },
            sessionHistory: { totalCompletedFocusSessions: 3, completedFocusSessionsByTaskId: { task: 3 } } }));
        expect(historyLanded.taskPatch).toBeNull(); expect(historyLanded.result.creditedMinutes).toBe(0);
        // Task credit landed, history save failed: the same beyond-saved interval may already be in these minutes.
        const taskLanded = prepareNativePomodoroTransition({ request: request(JSON.stringify(running())),
            session: { raw: null, state: null }, target: selectedRow({ timeSpentMinutes: 79 }), deviceId: 'device' })!;
        expect(taskLanded.taskPatch!.timeSpentMinutes).toBe(104); expect(taskLanded.result.creditedMinutes).toBe(25);
        // This is the approved RN hydration delta, not a promise of historical crash repair.
    });
});
