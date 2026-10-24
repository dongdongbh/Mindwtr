import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { decodeNativePomodoroSession, MAX_NATIVE_POMODORO_PLAN_BYTES, MAX_NATIVE_POMODORO_SESSION_BYTES, nativePomodoroReceiptPayload,
    prepareNativePomodoroTransition, validatePreparedNativePomodoroTransition, type NativePomodoroRequest } from './native-pomodoro-session';
import { TASK_SQLITE_COLUMNS, taskToSqliteRow } from './task-sync-schema';
import * as logger from './logger';

const ID = '11111111-1111-4111-8111-111111111111';
const NEXT = '22222222-2222-4222-8222-222222222222';
const AT = Date.parse('2026-10-10T00:00:00.000Z');
const day = '2026-10-10';
const initialize = () => prepareNativePomodoroTransition({ request: { action: 'initialize', requestId: ID,
    observedAtMs: AT, localDayKey: day, durations: { focusMinutes: 25, breakMinutes: 5 } },
    session: { raw: null, state: null }, target: null, deviceId: null })!;
const running = (selectedTaskId: string | undefined = 'task') => {
    const state = decodeNativePomodoroSession(initialize().sessionAfter);
    state.session.timerState!.isRunning = true;
    state.session.phaseEndsAt = new Date(AT).toISOString();
    if (selectedTaskId) state.session.selectedTaskId = selectedTaskId;
    const raw = JSON.stringify(state);
    return { raw, state };
};
const task = (extra = {}) => ({ id: 'task', row: taskToSqliteRow({ id: 'task', title: 'Private', status: 'done',
    contexts: [], tags: [], createdAt: new Date(AT).toISOString(), updatedAt: new Date(AT).toISOString(),
    rev: 2, timeSpentMinutes: 4, ...extra }) as (string | number | null)[] });
const reconcile = (extra = {}, target = task()) => prepareNativePomodoroTransition({ request: { action: 'reconcile', requestId: NEXT,
    observedAtMs: AT, localDayKey: day, autoStart: { autoStartFocus: false, autoStartBreaks: false } },
    session: running(), target, deviceId: 'existing-device', ...extra });
// The task row stored by accepted schema4 Pomodoro receipts, before reminderPolicy was appended in schema5.
const SCHEMA4_TASK_COLUMNS = ['id', 'title', 'status', 'priority', 'energyLevel', 'assignedTo', 'taskMode', 'startTime',
    'relativeStartOffset', 'dueDate', 'recurrence', 'showFutureRecurrence', 'pushCount', 'repeatReminderMinutes', 'tags',
    'contexts', 'checklist', 'description', 'textDirection', 'attachments', 'location', 'projectId', 'sectionId', 'areaId',
    'orderNum', 'boardOrder', 'focusOrder', 'isFocusedToday', 'timeEstimate', 'timeSpentMinutes', 'suppressMindwtrReminders',
    'reviewAt', 'completedAt', 'statusBeforeProjectArchive', 'completedAtBeforeProjectArchive', 'isFocusedTodayBeforeProjectArchive',
    'projectArchivedAt', 'rev', 'revBy', 'createdAt', 'updatedAt', 'deletedAt', 'purgedAt', 'viewSectionIds', 'cancelledAt', 'archivedAt'];
const legacyReconcile = () => {
    const plan = structuredClone(reconcile()!); plan.target!.row = plan.target!.row!.slice(0, SCHEMA4_TASK_COLUMNS.length); return plan;
};

describe('strict native Pomodoro preparation', () => {
    it('initializes only paused zero history and derives task credit from the completion cursor', () => {
        const initial = initialize();
        expect(initial.taskPatch).toBeNull();
        expect(decodeNativePomodoroSession(initial.sessionAfter).session.timerState).toEqual({ phase: 'focus', remainingSeconds: 1500,
            isRunning: false, completedFocusSessions: 0 });
        const plan = reconcile()!;
        expect(plan.taskPatch).toEqual({ timeSpentMinutes: 29, rev: 3, revBy: 'existing-device', updatedAt: new Date(AT).toISOString() });
        expect(plan.result).toMatchObject({ creditedMinutes: 25, completedFocusSessions: 1, creditDisposition: 'credited' });
        expect(validatePreparedNativePomodoroTransition(plan)).toEqual(plan);
    });
    it('retains raw before bytes and declines countdown-only ticks and clock rollback', () => {
        const session = running();
        session.state.session.phaseEndsAt = new Date(AT + 60_000).toISOString();
        session.raw = JSON.stringify(session.state, null, 2);
        expect(reconcile({ session })).toBeNull();
        expect(reconcile({ session, request: { action: 'reconcile', requestId: NEXT, observedAtMs: AT - 1,
            localDayKey: day, autoStart: { autoStartFocus: true, autoStartBreaks: true } } })).toBeNull();
        session.state.session.phaseEndsAt = new Date(AT).toISOString();
        session.raw = JSON.stringify(session.state, null, 2);
        expect(reconcile({ session })!.sessionBefore).toBe(session.raw);
    });
    it.each([{ deletedAt: new Date(AT).toISOString() }, { status: 'archived' }])('does not credit unavailable task %j', (extra) => {
        const plan = reconcile({}, task(extra))!;
        expect(plan.taskPatch).toBeNull();
        expect(plan.result.creditDisposition).toBe('unavailable');
    });
    it('consumes missing, unlinked and capped completions without generating a device identity', () => {
        expect(reconcile({ target: { id: 'task', row: null }, deviceId: null })!.result.creditDisposition).toBe('unavailable');
        expect(reconcile({ session: running(''), target: null, deviceId: null })!.result.creditDisposition).toBe('unlinked');
        expect(reconcile({ deviceId: null }, task({ timeSpentMinutes: 100_000 }))!.result.creditDisposition).toBe('capped');
        expect(() => reconcile({ deviceId: null })).toThrow();
    });
    it('rejects forged after, result, target and revision and does not log during capped pure validation', () => {
        const warn = vi.spyOn(logger, 'logWarn');
        const plan = reconcile({}, task({ rev: 2_147_483_647 }))!;
        expect(plan.taskPatch!.rev).toBe(2_147_483_647);
        validatePreparedNativePomodoroTransition(plan);
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
        for (const forged of [{ ...plan, result: { ...plan.result, creditedMinutes: 999 } },
            { ...plan, taskPatch: { ...plan.taskPatch!, rev: 0 } }, { ...plan, sessionAfter: initialize().sessionAfter },
            { ...plan, target: { ...plan.target!, id: 'other' } }]) expect(() => validatePreparedNativePomodoroTransition(forged)).toThrow();
    });
    it('refuses duplicate members, unknown shapes, invalid dates/counters and ambiguous history identities', () => {
        const raw = initialize().sessionAfter;
        expect(() => decodeNativePomodoroSession(raw.replace('"version":1', '"version":1,"version":1'))).toThrow();
        expect(() => decodeNativePomodoroSession(raw.replace('"version":1', '"version":2'))).toThrow();
        for (const modify of [(state: ReturnType<typeof decodeNativePomodoroSession>) => { state.generation = Number.MAX_SAFE_INTEGER + 1; },
            (state: ReturnType<typeof decodeNativePomodoroSession>) => { state.session.phaseEndsAt = 'bad'; },
            (state: ReturnType<typeof decodeNativePomodoroSession>) => { state.session.sessionHistory!.completedFocusSessionsByTaskId = { ' task ': 1 }; }]) {
            const state = JSON.parse(raw); modify(state); expect(() => decodeNativePomodoroSession(JSON.stringify(state))).toThrow();
        }
        expect(TASK_SQLITE_COLUMNS.length).toBe(task().row.length);
    });
    it('accepts the exact escaped receipt byte bound and refuses one more byte before granting write authority', () => {
        const target = task(); const index = TASK_SQLITE_COLUMNS.indexOf('description'); target.row[index] = '';
        const baseline = reconcile({}, target)!;
        const bytes = new TextEncoder().encode(nativePomodoroReceiptPayload(baseline)).length;
        target.row[index] = 'x'.repeat(MAX_NATIVE_POMODORO_PLAN_BYTES - bytes);
        const boundary = reconcile({}, target)!;
        expect(new TextEncoder().encode(nativePomodoroReceiptPayload(boundary)).length).toBe(MAX_NATIVE_POMODORO_PLAN_BYTES);
        target.row[index] += 'x'; expect(() => reconcile({}, target)).toThrow();
        target.row[index] = '漢'.repeat(700_000); expect(() => reconcile({}, target)).toThrow();
    });
    it('validates the exact local cell byte boundary and refuses multibyte overflow without truncating history', () => {
        const state = decodeNativePomodoroSession(initialize().sessionAfter);
        const entries: [string, number][] = Array.from({ length: 2000 }, (_, i) => [String(i).padStart(4, '0') + 'h'.repeat(486), 1]);
        state.session.timerState.completedFocusSessions = 2000;
        state.session.sessionHistory.totalCompletedFocusSessions = 2000;
        state.session.sessionHistory.completedFocusSessionsByTaskId = Object.fromEntries(entries);
        let remaining = MAX_NATIVE_POMODORO_SESSION_BYTES - JSON.stringify(state).length;
        expect(remaining).toBeGreaterThan(0);
        for (const entry of entries) {
            const more = Math.min(10, remaining); entry[0] += 'x'.repeat(more); remaining -= more;
        }
        expect(remaining).toBe(0);
        state.session.sessionHistory.completedFocusSessionsByTaskId = Object.fromEntries(entries);
        const raw = JSON.stringify(state); expect(raw.length).toBe(MAX_NATIVE_POMODORO_SESSION_BYTES);
        expect(decodeNativePomodoroSession(raw).session.sessionHistory.totalCompletedFocusSessions).toBe(2000);
        expect(() => decodeNativePomodoroSession(raw.replace('h', '漢'))).toThrow();
    });
    it('uses bounded catchup for huge ranges but refuses unsafe completion/history totals and generation overflow', () => {
        const session = running();
        const huge = reconcile({ session, request: { action: 'reconcile', requestId: NEXT, observedAtMs: AT + 10_000_000_000_000,
            localDayKey: day, autoStart: { autoStartFocus: true, autoStartBreaks: true } } })!;
        expect(huge.result.completedFocusSessions).toBeGreaterThan(1_000_000);
        expect(huge.taskPatch!.timeSpentMinutes).toBe(100_000);
        session.state.generation = Number.MAX_SAFE_INTEGER; session.raw = JSON.stringify(session.state);
        expect(() => reconcile({ session })).toThrow();
        session.state.generation = 0;
        session.state.session.timerState.completedFocusSessions = Number.MAX_SAFE_INTEGER;
        session.state.session.sessionHistory.totalCompletedFocusSessions = Number.MAX_SAFE_INTEGER;
        session.raw = JSON.stringify(session.state); expect(() => reconcile({ session })).toThrow();
    });
});

describe('native Pomodoro explicit actions', () => {
    it('settles an expired focus using its old duration before resetting the resolved phase to a new preset', () => {
        const session = running();
        const plan = prepareNativePomodoroTransition({ request: { action: 'setDurations', requestId: NEXT,
            observedAtMs: AT, localDayKey: day, autoStart: { autoStartFocus: false, autoStartBreaks: false },
            durations: { focusMinutes: 50, breakMinutes: 10 } }, session, target: task(), deviceId: 'existing-device' })!;
        expect(plan.taskPatch).toEqual({ timeSpentMinutes: 29, rev: 3, revBy: 'existing-device', updatedAt: new Date(AT).toISOString() });
        const after = decodeNativePomodoroSession(plan.sessionAfter);
        expect(after.session.durations).toEqual({ focusMinutes: 50, breakMinutes: 10 });
        expect(after.session.timerState).toEqual({ phase: 'break', remainingSeconds: 600, isRunning: false, completedFocusSessions: 1 });
        expect(after.session.sessionHistory.completedFocusSessionsByTaskId).toEqual({ task: 1 });
        expect(after.session.updatedAtMs).toBe(AT + 1);
        expect(after.generation).toBe(1);
        expect(validatePreparedNativePomodoroTransition(plan)).toEqual(plan);
    });
    it.each([
        ['focus', false, false], ['focus', true, false], ['focus', false, true], ['focus', true, true],
        ['break', false, false], ['break', true, false], ['break', false, true], ['break', true, true],
    ] as const)('toggle retains the just-resolved %s completion with auto-focus=%s auto-break=%s', (phase, autoStartFocus, autoStartBreaks) => {
        const session = running();
        session.state.session.timerState.phase = phase;
        session.state.session.timerState.remainingSeconds = phase === 'focus' ? 1500 : 300;
        session.raw = JSON.stringify(session.state);
        const plan = prepareNativePomodoroTransition({ request: { action: 'toggle', requestId: NEXT, observedAtMs: AT,
            localDayKey: day, autoStart: { autoStartFocus, autoStartBreaks } }, session, target: task(), deviceId: 'existing-device' })!;
        const after = decodeNativePomodoroSession(plan.sessionAfter);
        expect(after.session.timerState).toEqual({ phase: phase === 'focus' ? 'break' : 'focus',
            remainingSeconds: phase === 'focus' ? 300 : 1500,
            isRunning: phase === 'focus' ? autoStartBreaks : autoStartFocus, completedFocusSessions: phase === 'focus' ? 1 : 0 });
        expect(plan.result.creditedMinutes).toBe(phase === 'focus' ? 25 : 0);
        expect(Object.prototype.hasOwnProperty.call(after.session, 'phaseEndsAt')).toBe(after.session.timerState.isRunning);
        expect(validatePreparedNativePomodoroTransition(plan)).toEqual(plan);
    });
    it('toggle before the deadline pauses the remaining interval without credit', () => {
        const session = running(); session.state.session.phaseEndsAt = new Date(AT + 1).toISOString(); session.raw = JSON.stringify(session.state);
        const plan = prepareNativePomodoroTransition({ request: { action: 'toggle', requestId: NEXT, observedAtMs: AT,
            localDayKey: day, autoStart: { autoStartFocus: true, autoStartBreaks: true } }, session, target: task(), deviceId: null })!;
        expect(decodeNativePomodoroSession(plan.sessionAfter).session.timerState).toEqual({ phase: 'focus', remainingSeconds: 1,
            isRunning: false, completedFocusSessions: 0 });
        expect(plan.taskPatch).toBeNull(); expect(plan.result.creditedMinutes).toBe(0);
    });
    it('orders successive same-time and skewed toggles logically but starts at their actual observation', () => {
        let session = { raw: initialize().sessionAfter, state: decodeNativePomodoroSession(initialize().sessionAfter) };
        for (const [offset, stamp, generation, isRunning] of [[0, 1, 1, true], [0, 2, 2, false], [-5000, 3, 3, true]] as const) {
            const plan = prepareNativePomodoroTransition({ request: { action: 'toggle', requestId: `00000000-0000-4000-8000-${String(generation).padStart(12, '0')}`, observedAtMs: AT + offset,
                localDayKey: day, autoStart: { autoStartFocus: false, autoStartBreaks: false } }, session, target: null, deviceId: null })!;
            const after = decodeNativePomodoroSession(plan.sessionAfter);
            expect(after.session.updatedAtMs).toBe(AT + stamp); expect(after.generation).toBe(generation);
            expect(after.session.timerState.isRunning).toBe(isRunning);
            expect(after.session.phaseEndsAt).toBe(isRunning ? new Date(AT + offset + 1_500_000).toISOString() : undefined);
            expect(plan.result.creditedMinutes).toBe(0); expect(plan.taskPatch).toBeNull();
            session = { raw: plan.sessionAfter, state: after };
        }
    });
    it.each([
        [false, false, 'next-task'], [true, false, 'next-task'], [false, true, 'next-task'], [true, true, 'next-task'],
        [false, false, null], [true, false, null], [false, true, null], [true, true, null],
    ] as const)('selection auto-focus=%s auto-break=%s to %s credits only the old task and preserves resolved timer', (autoStartFocus, autoStartBreaks, taskId) => {
        const plan = prepareNativePomodoroTransition({ request: { action: 'selectTask', requestId: NEXT, observedAtMs: AT,
            localDayKey: day, autoStart: { autoStartFocus, autoStartBreaks }, taskId }, session: running(), target: task(), deviceId: 'existing-device' })!;
        const after = decodeNativePomodoroSession(plan.sessionAfter);
        expect(plan.target).toEqual(task()); expect(plan.taskPatch!.timeSpentMinutes).toBe(29);
        expect(after.session.selectedTaskId).toBe(taskId ?? undefined);
        expect(after.session.sessionHistory.completedFocusSessionsByTaskId).toEqual({ task: 1 });
        expect(after.session.timerState).toEqual({ phase: 'break', remainingSeconds: 300, isRunning: autoStartBreaks, completedFocusSessions: 1 });
        expect(after.session.phaseEndsAt).toBe(autoStartBreaks ? new Date(AT + 300_000).toISOString() : undefined);
        expect(validatePreparedNativePomodoroTransition(plan)).toEqual(plan);
    });
    it.each(['reset', 'switchPhase'] as const)('%s acts on the resolved phase and retains completed history', (action) => {
        const plan = prepareNativePomodoroTransition({ request: { action, requestId: NEXT, observedAtMs: AT,
            localDayKey: day, autoStart: { autoStartFocus: true, autoStartBreaks: true } }, session: running(), target: task(), deviceId: 'existing-device' })!;
        const after = decodeNativePomodoroSession(plan.sessionAfter);
        expect(after.session.timerState).toEqual({ phase: action === 'reset' ? 'break' : 'focus', remainingSeconds: action === 'reset' ? 300 : 1500,
            isRunning: false, completedFocusSessions: 1 });
        expect(after.session.phaseEndsAt).toBeUndefined(); expect(after.session.sessionHistory.completedFocusSessionsByTaskId).toEqual({ task: 1 });
        expect(plan.result.creditedMinutes).toBe(25); expect(validatePreparedNativePomodoroTransition(plan)).toEqual(plan);
    });
    it('selects during multiple elapsed cycles without assigning old-duration credit to the new task', () => {
        const plan = prepareNativePomodoroTransition({ request: { action: 'selectTask', requestId: NEXT, observedAtMs: AT + 3_600_000,
            localDayKey: day, autoStart: { autoStartFocus: true, autoStartBreaks: true }, taskId: 'next-task' },
            session: running(), target: task(), deviceId: 'existing-device' })!;
        const after = decodeNativePomodoroSession(plan.sessionAfter);
        expect(plan.result.creditedMinutes).toBe(75); expect(plan.taskPatch!.timeSpentMinutes).toBe(79);
        expect(after.session.sessionHistory.completedFocusSessionsByTaskId).toEqual({ task: 3 });
        expect(after.session.timerState).toEqual({ phase: 'break', remainingSeconds: 300, isRunning: true, completedFocusSessions: 3 });
        expect(after.session.selectedTaskId).toBe('next-task');
    });
    it('tapping the active preset resets an in-progress interval without false credit', () => {
        const session = running(); session.state.session.phaseEndsAt = new Date(AT + 30_000).toISOString(); session.raw = JSON.stringify(session.state);
        const plan = prepareNativePomodoroTransition({ request: { action: 'setDurations', requestId: NEXT, observedAtMs: AT,
            localDayKey: day, autoStart: { autoStartFocus: true, autoStartBreaks: true }, durations: { focusMinutes: 25, breakMinutes: 5 } },
            session, target: task(), deviceId: null })!;
        const after = decodeNativePomodoroSession(plan.sessionAfter);
        expect(after.session.timerState).toEqual({ phase: 'focus', remainingSeconds: 1500, isRunning: false, completedFocusSessions: 0 });
        expect(after.session.phaseEndsAt).toBeUndefined(); expect(plan.taskPatch).toBeNull(); expect(after.generation).toBe(1);
    });
    it.each([{ action: 'reset' }, { action: 'setDurations', durations: { focusMinutes: 25, breakMinutes: 5 } },
        { action: 'selectTask', taskId: null }] as const)('keeps clock-only %j intent while unchanged reconcile remains zero-work', (action) => {
        const session = { raw: initialize().sessionAfter, state: decodeNativePomodoroSession(initialize().sessionAfter) };
        const clock = { requestId: NEXT, observedAtMs: AT, localDayKey: day, autoStart: { autoStartFocus: false, autoStartBreaks: false } };
        expect(prepareNativePomodoroTransition({ request: { ...clock, action: 'reconcile' }, session, target: null, deviceId: null })).toBeNull();
        const plan = prepareNativePomodoroTransition({ request: { ...clock, ...action }, session, target: null, deviceId: null })!;
        const after = decodeNativePomodoroSession(plan.sessionAfter);
        expect(after).toEqual({ ...session.state, generation: 1, session: { ...session.state.session, updatedAtMs: AT + 1 } });
        expect(plan.taskPatch).toBeNull(); expect(plan.result.creditDisposition).toBe('none');
        expect(prepareNativePomodoroTransition({ request: { ...clock, action: 'reconcile' },
            session: { raw: plan.sessionAfter, state: after }, target: null, deviceId: null })).toBeNull();
    });
    it('keeps original initialize/reconcile receipt bytes and accepts their unchanged plans', () => {
        // Frozen independently from the accepted17e3d2411 model before action implementation.
        expect(TASK_SQLITE_COLUMNS).toEqual([...SCHEMA4_TASK_COLUMNS, 'reminderPolicy', 'dueReminderLeadMinutes']);
        for (const [plan, digest] of [[initialize(), '9001a8d3126988bfdab00114e606ff7c2d8f88c8ae6585a790262db10a0a22f1'],
            [legacyReconcile(), '765d1dc0af0b8743c48884a4563c2975928b6849008e01140e7c4618fa2760b6']] as const) {
            expect(createHash('sha256').update(nativePomodoroReceiptPayload(plan)).digest('hex')).toBe(digest);
            expect(validatePreparedNativePomodoroTransition(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
        }
        const current = reconcile()!;
        expect(current.target!.row).toEqual([...legacyReconcile().target!.row!, null, null]);
        const schema5 = structuredClone(current); schema5.target!.row = schema5.target!.row!.slice(0, -1);
        expect(validatePreparedNativePomodoroTransition(schema5)).toEqual(schema5);
        expect(createHash('sha256').update(nativePomodoroReceiptPayload(schema5)).digest('hex'))
            .toBe('5efcd9dc58321034571513e31f2dd68207466f7fa27476df58ce842ec979e7dc');
        expect(createHash('sha256').update(nativePomodoroReceiptPayload(current)).digest('hex'))
            .toBe('aba75ebf597f20420c3cc0a61df92f6f4e9e9eabe11d98cafd56dd92bfaa4757');
        const policy = structuredClone(current); policy.target!.row = [...legacyReconcile().target!.row!, 'skip'];
        expect(validatePreparedNativePomodoroTransition(policy)).toEqual(policy);
        expect(nativePomodoroReceiptPayload(policy)).not.toBe(nativePomodoroReceiptPayload(current));
    });
    it('refuses unrecognized legacy row widths and a reordered historical column prefix', async () => {
        const legacy = legacyReconcile();
        for (const row of [legacy.target!.row!.slice(0, -1), [...task().row, null]]) {
            expect(() => validatePreparedNativePomodoroTransition({ ...legacy, target: { ...legacy.target, row } })).toThrow();
        }
        const columns = [...TASK_SQLITE_COLUMNS]; [columns[1], columns[3]] = [columns[3], columns[1]];
        vi.resetModules();
        vi.doMock('./task-sync-schema', async importOriginal => ({ ...await importOriginal<typeof import('./task-sync-schema')>(),
            TASK_SQLITE_COLUMNS: columns }));
        try {
            const model = await import('./native-pomodoro-session');
            expect(() => model.validatePreparedNativePomodoroTransition(legacy)).toThrow();
        } finally { vi.doUnmock('./task-sync-schema'); vi.resetModules(); }
    });
    it('refuses extra/missing/wrong action members and bounds without accepting caller-provided clocks or target authority', () => {
        const clock = { requestId: NEXT, observedAtMs: AT, localDayKey: day, autoStart: { autoStartFocus: false, autoStartBreaks: false } };
        const requests: NativePomodoroRequest[] = [{ ...clock, action: 'toggle' }, { ...clock, action: 'reset' },
            { ...clock, action: 'switchPhase' }, { ...clock, action: 'setDurations', durations: { focusMinutes: 1, breakMinutes: 180 } },
            { ...clock, action: 'selectTask', taskId: 'x'.repeat(500) }, { ...clock, action: 'selectTask', taskId: null }];
        const session = { raw: initialize().sessionAfter, state: decodeNativePomodoroSession(initialize().sessionAfter) };
        const prepare = (request: unknown) => prepareNativePomodoroTransition({ request: request as NativePomodoroRequest,
            session, target: null, deviceId: null });
        for (const request of requests) {
            expect(prepare(request)).not.toBeNull();
            for (const invalid of [{ ...request, extra: true }, { ...request, updatedAtMs: AT }, { ...request, observedAtMs: NaN },
                { ...request, observedAtMs: Infinity }, { ...request, localDayKey: '2026-02-30' },
                { ...request, requestId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }, { ...request, autoStart: {} },
                { ...request, autoStart: { autoStartFocus: true, autoStartBreaks: 1 } },
                { ...request, autoStart: { ...request.autoStart, extra: true } },
                Object.fromEntries(Object.entries(request).filter(([name]) => name !== 'autoStart')),
                Object.assign(Object.create({ inherited: true }), request)]) expect(() => prepare(invalid)).toThrow();
        }
        for (const durations of [{ focusMinutes: 0, breakMinutes: 5 }, { focusMinutes: 181, breakMinutes: 5 },
            { focusMinutes: 1.5, breakMinutes: 5 }, { focusMinutes: 25 }, { focusMinutes: 25, breakMinutes: 5, extra: 1 }]) {
            expect(() => prepare({ ...clock, action: 'setDurations', durations })).toThrow();
        }
        for (const taskId of [undefined, '', ' x ', 'x'.repeat(501), 1, '__proto__', 'constructor', 'prototype']) {
            expect(() => prepare({ ...clock, action: 'selectTask', taskId })).toThrow();
        }
        expect(() => prepare({ ...clock, action: 'dismiss' })).toThrow();
        expect(() => prepareNativePomodoroTransition({ request: requests[0], session: { raw: null, state: null }, target: null, deviceId: null })).toThrow();
        expect(() => prepareNativePomodoroTransition({ request: { ...clock, action: 'selectTask', taskId: 'next-task' },
            session: running(), target: { id: 'next-task', row: null }, deviceId: null })).toThrow();
    });
    it.each(['missing', 'deleted', 'archived', 'done', 'capped', 'unlinked'] as const)('selection consumes %s old-target completion without assigning it to the new target', (disposition) => {
        const selected = disposition !== 'unlinked';
        const target = !selected ? null : disposition === 'missing' ? { id: 'task', row: null }
            : task(disposition === 'deleted' ? { deletedAt: new Date(AT).toISOString() }
                : disposition === 'archived' ? { status: 'archived' } : disposition === 'capped' ? { timeSpentMinutes: 100_000 } : {});
        const plan = prepareNativePomodoroTransition({ request: { action: 'selectTask', requestId: NEXT, observedAtMs: AT,
            localDayKey: day, autoStart: { autoStartFocus: false, autoStartBreaks: false }, taskId: 'next-task' },
            session: running(selected ? 'task' : ''), target, deviceId: disposition === 'done' ? 'existing-device' : null })!;
        expect(plan.result.completedFocusSessions).toBe(1);
        expect(plan.result.creditDisposition).toBe(disposition === 'done' ? 'credited' : disposition === 'capped' || disposition === 'unlinked' ? disposition : 'unavailable');
        expect(plan.taskPatch?.timeSpentMinutes ?? null).toBe(disposition === 'done' ? 29 : null);
        expect(decodeNativePomodoroSession(plan.sessionAfter).session.selectedTaskId).toBe('next-task');
    });
    it('keeps the frozen local day and rejects unsafe clock, generation, deadline and backwards-time results', () => {
        const clock = { requestId: NEXT, observedAtMs: AT, localDayKey: '2026-10-09', autoStart: { autoStartFocus: false, autoStartBreaks: false } };
        const ambient = vi.spyOn(Date, 'now').mockReturnValue(AT + 86_400_000);
        try {
            const plan = prepareNativePomodoroTransition({ request: { ...clock, action: 'reset' }, session: running(), target: task(), deviceId: 'existing-device' })!;
            expect(decodeNativePomodoroSession(plan.sessionAfter).session.sessionHistory).toMatchObject({ todayDayKey: '2026-10-09', completedTodayFocusSessions: 1 });
        } finally { ambient.mockRestore(); }
        for (const overflow of ['clock', 'generation', 'deadline'] as const) {
            const state = decodeNativePomodoroSession(initialize().sessionAfter);
            if (overflow === 'clock') state.session.updatedAtMs = 8_640_000_000_000_000;
            if (overflow === 'generation') state.generation = Number.MAX_SAFE_INTEGER;
            expect(() => prepareNativePomodoroTransition({ request: { ...clock, action: overflow === 'deadline' ? 'toggle' : 'reset',
                observedAtMs: overflow === 'generation' ? AT : 8_640_000_000_000_000 },
                session: { raw: JSON.stringify(state), state }, target: null, deviceId: null })).toThrow();
        }
        const session = running(); session.state.session.phaseEndsAt = new Date(AT + 1_500_000).toISOString(); session.raw = JSON.stringify(session.state);
        expect(() => prepareNativePomodoroTransition({ request: { ...clock, action: 'selectTask', taskId: null, observedAtMs: AT - 10_000 },
            session, target: task(), deviceId: null })).toThrow();
    });
    it('refuses forged action result, after-state, new target and caller credit during pure validation without diagnostics', () => {
        const plan = prepareNativePomodoroTransition({ request: { action: 'selectTask', requestId: NEXT, observedAtMs: AT,
            localDayKey: day, autoStart: { autoStartFocus: false, autoStartBreaks: false }, taskId: 'next-task' },
            session: running(), target: task(), deviceId: 'existing-device' })!;
        const info = vi.spyOn(logger, 'logInfo'); const warn = vi.spyOn(logger, 'logWarn');
        try {
            validatePreparedNativePomodoroTransition(plan);
            for (const forged of [{ ...plan, result: { ...plan.result, creditedMinutes: 50 } },
                { ...plan, result: { ...plan.result, lastEvent: 'focus-finished' } },
                { ...plan, taskPatch: { ...plan.taskPatch, timeSpentMinutes: 54 } },
                { ...plan, sessionAfter: initialize().sessionAfter }, { ...plan, target: { id: 'next-task', row: null } }]) {
                expect(() => validatePreparedNativePomodoroTransition(forged)).toThrow();
            }
            expect(info).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
        } finally { info.mockRestore(); warn.mockRestore(); }
    });
});
