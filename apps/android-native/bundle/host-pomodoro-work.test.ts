import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { taskEditValuesEqual } from '../../../packages/core/src/json-value-equality';
import { decodeNativePomodoroSession, drainNativePomodoroLegacyCredits, nativePomodoroOwedTaskIds,
    prepareNativePomodoroTransition, validatePreparedNativePomodoroTransition,
    type NativePomodoroRequest, type NativePomodoroSessionRead, type PreparedNativePomodoroTransition } from '../../../packages/core/src/native-pomodoro-session';
import { isTaskActionable, isTaskCancelled } from '../../../packages/core/src/task-status';
import { taskRevisionOf } from '../../../packages/core/src/native-request-receipts';
import { TASK_SQLITE_COLUMNS, taskToSqliteRow } from '../../../packages/core/src/task-sync-schema';
import type { Task } from '../../../packages/core/src/types';

const entry = readFileSync(new URL('./host-entry.ts', import.meta.url), 'utf8');
const from = entry.indexOf('const preparePomodoroRequest = async');
const to = entry.indexOf('let iosPomodoroAlarmTurn:', from);
const submitFrom = entry.indexOf('const submit = (work:');
const submitTo = entry.indexOf('const isFossBuild', submitFrom);
if ([from, to, submitFrom, submitTo].some(index => index < 0)) throw new Error('Native Pomodoro runtime unavailable');
const source = new Bun.Transpiler({ loader: 'ts' }).transformSync(`${entry.slice(submitFrom, submitTo)}
${entry.slice(from, to)}
globalThis.port = { prepare: preparePomodoroRequest, submit };`);
const AT = Date.parse('2026-11-16T12:00:00.000Z');
const ID = '11111111-1111-4111-8111-111111111111';
const NEXT = '22222222-2222-4222-8222-222222222222';
const credit = { id: '33333333-3333-4333-8333-333333333333', taskId: 'a', minutes: 2 };

const fixture = (timer: NativePomodoroSessionRead = { raw: null, state: null }) => {
    let task: Task = { id: 'a', title: 'Private', status: 'next', tags: [], contexts: [], rev: 1,
        createdAt: new Date(AT).toISOString(), updatedAt: new Date(AT).toISOString(), timeSpentMinutes: 4 };
    const state = { _allTasks: [task], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        get _tasksById(): Map<string, Task> { return new Map(this._allTasks.map(task => [task.id, task])); },
        settings: { deviceId: 'device' }, lastDataChangeAt: 0, editLockCount: 0, isLoading: false };
    const events: string[] = []; const receipts = new Map<string, number>();
    const adapter = {
        readRowBaseline: async () => true,
        getData: async () => { events.push('baseline'); return { tasks: state._allTasks, projects: [], sections: [], areas: [], people: [], settings: state.settings }; },
        readPomodoroSession: async () => timer,
        savePomodoroTransitionWithReceipt: async (plan: PreparedNativePomodoroTransition) => {
            events.push('commit'); timer = { raw: plan.sessionAfter, state: decodeNativePomodoroSession(plan.sessionAfter) };
            if (plan.taskPatch) { task = { ...state._allTasks[0], ...plan.taskPatch }; state._allTasks = [task]; }
            return { result: plan.result, replayed: false, projectionReloaded: true };
        },
    };
    const pending = new Map<number, { done: boolean; value?: unknown; error?: string }>();
    const context = { state, events, pending, nextId: 1, nativePomodoroSettlementPending: false, nativePomodoroCompletionRevision: null,
        AbortController, TextEncoder, pomodoroWarmAdmission: null,
        Date: class extends Date { constructor() { super(AT + 1_000_000); } static now() { return AT + 1_000_000; } },
        port: undefined as unknown as { prepare: (json: string) => Promise<{ kind: string; planJSON: string }>; submit: (work: () => Promise<unknown>) => string },
        useTaskStore: { getState: () => state }, bootAdapter: adapter, getStorageAdapter: () => adapter,
        pomodoroAdapter: () => adapter, requireSaved: () => undefined, unwrap: (value: unknown) => value,
        contract: { getDataSettings: () => ({}) }, getPersistenceStatus: () => ({ generation: 0 }),
        pomodoroJSON: (json: string) => JSON.parse(json), isSandboxMode: () => false, isWorkspaceTransitionActive: () => false,
        stripSensitiveSettings: (value: unknown) => value, normalizeTaskForLoad: (value: unknown) => value,
        hasRawReadRow: () => true, rawReadRow: (_value: unknown, row: unknown) => ({ row }), taskToSqliteRow,
        TASK_SQLITE_COLUMNS, taskEditValuesEqual, drainNativePomodoroLegacyCredits, nativePomodoroOwedTaskIds,
        prepareNativePomodoroTransition: (input: Parameters<typeof prepareNativePomodoroTransition>[0]) =>
            prepareNativePomodoroTransition(JSON.parse(JSON.stringify(input))),
        validatePreparedNativePomodoroTransition, taskRevisionOf, isTaskActionable, isTaskCancelled, generateUUID: () => NEXT,
        logWarn: () => { events.push('deferred'); },
        applyPomodoroCredit: async (pendingCredit: typeof credit) => {
            events.push('drain');
            if (!receipts.has(pendingCredit.id)) {
                receipts.set(pendingCredit.id, pendingCredit.minutes);
                task = { ...task, timeSpentMinutes: (task.timeSpentMinutes ?? 0) + pendingCredit.minutes };
                state._allTasks = [task];
            }
            return 'applied';
        },
    };
    vm.runInNewContext(source, context);
    return { ...context, adapter, session: () => timer };
};

describe('native Pomodoro work bridge', () => {
    it('drains UUID work before freezing the SQL baseline and retains exact migration request bytes on retry', async () => {
        const host = fixture();
        const request: NativePomodoroRequest = { action: 'adoptLegacy', requestId: NEXT, observedAtMs: AT,
            localDayKey: '2026-11-16', autoStart: { autoStartFocus: false, autoStartBreaks: false },
            legacy: { version: 1, namespace: 'native.fixture', collapsedRaw: 'true', sessionRaw: JSON.stringify({
                selectedTaskId: 'a', workSecondsByTaskId: { a: 31 }, pendingCredits: [credit],
            }) } };
        const result = await host.port.prepare(JSON.stringify(request));
        expect(host.events.indexOf('drain')).toBeLessThan(host.events.indexOf('baseline'));
        const plan = validatePreparedNativePomodoroTransition(JSON.parse(result.planJSON));
        expect(plan.request).toEqual(request); expect(plan.taskPatch).toBeNull();
        expect(host.state._allTasks[0].timeSpentMinutes).toBe(6);
        const retry = await host.port.prepare(JSON.stringify(request));
        expect(JSON.parse(retry.planJSON)).toEqual(plan);
        expect(host.state._allTasks[0].timeSpentMinutes).toBe(6);
    });
    it.each([false, true])('settles completion from another native command without an open timer panel (deferred=%s)', async deferred => {
        const initialized = prepareNativePomodoroTransition({ request: { action: 'initialize', requestId: ID, observedAtMs: AT,
            localDayKey: '2026-11-16', durations: { focusMinutes: 25, breakMinutes: 5 } },
            session: { raw: null, state: null }, target: null, deviceId: null })!;
        const timer = decodeNativePomodoroSession(initialized.sessionAfter);
        timer.session.selectedTaskId = 'a'; timer.session.timerState.isRunning = true;
        timer.session.phaseEndsAt = new Date(AT + 1_500_000).toISOString();
        const host = fixture({ raw: JSON.stringify(timer), state: timer });
        if (deferred) {
            const save = host.adapter.savePomodoroTransitionWithReceipt; let first = true;
            host.adapter.savePomodoroTransitionWithReceipt = async plan => {
                if (first) { first = false; throw new Error('storage temporarily busy'); }
                return save(plan);
            };
        }
        const id = host.port.submit(async () => {
            host.state._allTasks = [{ ...host.state._allTasks[0], status: 'done', completedAt: new Date(AT + 91_000).toISOString() }];
            return 'task saved';
        });
        for (let turn = 0; turn < 100 && !host.pending.get(Number(id))?.done; turn += 1) await Promise.resolve();
        expect(host.pending.get(Number(id))).toMatchObject({ done: true, value: 'task saved' });
        if (deferred) {
            expect(host.state._allTasks[0].timeSpentMinutes).toBe(4); expect(host.events).toContain('deferred');
            const retry = host.port.submit(async () => 'ordinary host read');
            for (let turn = 0; turn < 100 && !host.pending.get(Number(retry))?.done; turn += 1) await Promise.resolve();
            expect(host.pending.get(Number(retry))).toMatchObject({ done: true, value: 'ordinary host read' });
        } else expect(host.events).not.toContain('deferred');
        expect(host.events).toContain('commit');
        expect(host.state._allTasks[0].timeSpentMinutes).toBe(5);
        expect(host.session().state?.session).toMatchObject({ workSecondsByTaskId: { a: 31 }, timerState: { isRunning: false, remainingSeconds: 1409 } });
        expect(host.session().state?.session.selectedTaskId).toBeUndefined();
    });
});
