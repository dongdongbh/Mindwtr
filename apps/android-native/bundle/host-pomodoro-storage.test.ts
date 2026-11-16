import { afterEach, describe, expect, it, setSystemTime } from 'bun:test';
import { Database } from 'bun:sqlite';
import { decodeNativePomodoroSession, type NativePomodoroRequest } from '../../../packages/core/src/native-pomodoro-session';
import { resetNativeRequestReceipts } from '../../../packages/core/src/native-request-receipts';
import { taskRevisionOf } from '../../../packages/core/src/native-request-receipts';
import { flushPendingSave, getStorageAdapter, resetForTests, useTaskStore } from '../../../packages/core/src/store';
import type { AppData } from '../../../packages/core/src/types';

const AT = Date.parse('2026-11-16T12:00:00.000Z');
const NEXT = '22222222-2222-4222-8222-222222222222';
const credit = { id: '33333333-3333-4333-8333-333333333333', taskId: 'a', minutes: 2 };
const databases = new Set<Database>();
const globals = new Map<string, PropertyDescriptor | undefined>();
let sequence = 0;
afterEach(async () => {
    setSystemTime(); await flushPendingSave().catch(() => undefined); resetForTests(); resetNativeRequestReceipts();
    for (const db of databases) db.close(); databases.clear();
    for (const [name, descriptor] of globals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
    globals.clear();
});

async function fixture() {
    for (const name of ['MindwtrHost', '__mindwtrHostPlatform', '__mindwtrNative', '__mindwtrSecrets', '__mindwtrSyncSecrets',
        '__cancelHostCalls', '__resumeHostCalls']) globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    resetForTests(); resetNativeRequestReceipts();
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [], settings: {},
        lastDataChangeAt: 0, persistenceFailure: null, error: null, isLoading: false, editLockCount: 0 });
    const db = new Database(':memory:'); databases.add(db); const kv = new Map<string, string>(); let failCommit = false; let failPomodoro = false;
    Object.assign(globalThis, {
        __mindwtrHostPlatform: 'ios', __mindwtrSyncSecrets: {}, __mindwtrSecrets: {}, __cancelHostCalls() {}, __resumeHostCalls() {},
        __mindwtrNative: {
            sqlExec: (sql: string) => { if (failCommit && sql.trim() === 'COMMIT') throw new Error('synthetic save failure'); db.exec(sql); return null; },
            sqlRun: (sql: string, raw: string) => {
                if (failCommit && sql.trim() === 'COMMIT' || failPomodoro && sql.startsWith('UPDATE native_pomodoro_session')) throw new Error('synthetic save failure');
                db.query(sql).run(...JSON.parse(raw)); return null;
            },
            sqlAll: (sql: string, raw: string) => JSON.stringify(db.query(sql).all(...JSON.parse(raw))),
            nowMs: () => Date.now(), randomBytes: (count: number) => JSON.stringify(Array(count).fill(7)), log() {}, rnStateCommit: () => null,
            kvGet: (name: string) => JSON.stringify([kv.get(name) ?? null]),
            kvMultiGet: (raw: string) => JSON.stringify(JSON.parse(raw).map((name: string) => [name, kv.get(name) ?? null])),
            kvSet: (name: string, value: string) => { kv.set(name, value); return null; }, kvRemove: (name: string) => { kv.delete(name); return null; },
            fileList: () => 'null', fileRead: () => null, fileDelete: () => null,
            logFile: (op: string) => op === 'path' || op === 'ensure' ? 'files/logs/mindwtr.log' : op === 'isAbsent' ? '1' : '0',
        },
    });
    await import(`./host-entry.ts?pomodoroStorageFixture=${++sequence}`);
    const host = Reflect.get(globalThis, 'MindwtrHost');
    const poll = async (ticket: string) => {
        for (let turn = 0; turn < 15000; turn += 1) {
            const raw = host.poll(ticket); if (raw !== null) return JSON.parse(raw);
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        throw new Error('Native Pomodoro command did not settle');
    };
    expect(await poll(host.boot('', ''))).toMatchObject({ ok: true });
    const iso = new Date(AT).toISOString();
    const data: AppData = { tasks: [{ id: 'a', title: 'Private', status: 'next', tags: [], contexts: [], createdAt: iso,
        updatedAt: iso, rev: 1, timeSpentMinutes: 4 }], projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'device' } };
    const adapter = getStorageAdapter(); await adapter.saveData(data);
    await useTaskStore.getState().fetchData({ recoveryLoad: true, throwOnError: true });
    return { host, poll, db, adapter, fail: (value: boolean) => { failCommit = value; }, failPomodoro: (value: boolean) => { failPomodoro = value; } };
}

describe('production native Pomodoro storage bridge', () => {
    it('retries UUID migration and preserves work through generic and prepared completion Undo', async () => {
        setSystemTime(new Date(AT)); const env = await fixture();
        expect(typeof env.adapter.saveDataIfUnchanged).toBe('function');
        const source = JSON.stringify({ selectedTaskId: 'a', workSecondsByTaskId: { a: 31 }, pendingCredits: [credit] });
        const request: NativePomodoroRequest = { action: 'adoptLegacy', requestId: NEXT, observedAtMs: AT,
            localDayKey: '2026-11-16', autoStart: { autoStartFocus: false, autoStartBreaks: false },
            legacy: { version: 1, namespace: 'native.fixture', collapsedRaw: null, sessionRaw: source } };
        env.fail(true);
        expect(await env.poll(env.host.pomodoroTransitionPrepare(JSON.stringify(request)))).toMatchObject({ ok: false });
        env.fail(false);
        const prepared = await env.poll(env.host.pomodoroTransitionPrepare(JSON.stringify(request)));
        expect(prepared).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        const plan = JSON.parse(prepared.value.planJSON);
        expect(plan.request).toEqual(request); expect(plan.taskPatch).toBeNull();
        expect(useTaskStore.getState()._tasksById.get('a')?.timeSpentMinutes).toBe(6);
        expect(await env.poll(env.host.pomodoroTransitionCommit(prepared.value.planJSON, false))).toMatchObject({ ok: true });
        expect(await env.poll(env.host.pomodoroTransitionCommit(prepared.value.planJSON, true))).toMatchObject({ ok: true, value: { replayed: true } });
        expect(useTaskStore.getState()._tasksById.get('a')?.timeSpentMinutes).toBe(6);
        const start = await env.poll(env.host.pomodoroTransitionPrepare(JSON.stringify({ action: 'toggle',
            requestId: '44444444-4444-4444-8444-444444444444', observedAtMs: AT, localDayKey: '2026-11-16',
            autoStart: { autoStartFocus: false, autoStartBreaks: false } })));
        expect(await env.poll(env.host.pomodoroTransitionCommit(start.value.planJSON, false))).toMatchObject({ ok: true });
        setSystemTime(new Date(AT + 91_000));
        const completed = await env.poll(env.host.complete('a'));
        expect(completed).toMatchObject({ ok: true });
        const saved = await env.poll(env.host.pomodoroSessionRead());
        expect(saved).toMatchObject({ ok: true });
        const after = decodeNativePomodoroSession(saved.value.raw);
        expect(after.session.timerState).toMatchObject({ isRunning: false, remainingSeconds: 1409, completedFocusSessions: 0 });
        expect(after.session.selectedTaskId).toBeUndefined(); expect(after.session.workSecondsByTaskId).toEqual({ a: 2 });
        expect(useTaskStore.getState()._tasksById.get('a')?.timeSpentMinutes).toBe(8);
        expect(completed.value.undo).toBeDefined();
        expect(await env.poll(env.host.completeUndo(JSON.stringify({ id: 'a', ...completed.value.undo })))).toMatchObject({ ok: true });
        expect(useTaskStore.getState()._tasksById.get('a')).toMatchObject({ status: 'next', timeSpentMinutes: 8 });
        expect(request.legacy.sessionRaw).toBe(source);
        const link = await env.poll(env.host.pomodoroTransitionPrepare(JSON.stringify({ action: 'selectTask', taskId: 'a',
            requestId: '55555555-5555-4555-8555-555555555555', observedAtMs: AT + 91_000, localDayKey: '2026-11-16',
            autoStart: { autoStartFocus: false, autoStartBreaks: false } })));
        expect(await env.poll(env.host.pomodoroTransitionCommit(link.value.planJSON, false))).toMatchObject({ ok: true });
        const restart = await env.poll(env.host.pomodoroTransitionPrepare(JSON.stringify({ action: 'toggle',
            requestId: '66666666-6666-4666-8666-666666666666', observedAtMs: AT + 91_000, localDayKey: '2026-11-16',
            autoStart: { autoStartFocus: false, autoStartBreaks: false } })));
        expect(await env.poll(env.host.pomodoroTransitionCommit(restart.value.planJSON, false))).toMatchObject({ ok: true });
        setSystemTime(new Date(AT + 151_000));
        const completionRequest = { id: 'a', taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get('a')!),
            requestId: '88888888-8888-4888-8888-888888888888' };
        const completion = await env.poll(env.host.taskCompletionPrepare(JSON.stringify(completionRequest)));
        expect(completion).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        const completionEnvelope = { request: completionRequest, prepared: completion.value.prepared };
        expect(await env.poll(env.host.taskCompletionCommit(JSON.stringify(completionEnvelope)))).toMatchObject({ ok: true });
        expect(useTaskStore.getState()._tasksById.get('a')?.timeSpentMinutes).toBe(9);
        const undoRequest = { requestId: '99999999-9999-4999-8999-999999999999', completionRequestId: completionRequest.requestId };
        const undo = await env.poll(env.host.taskCompletionUndoPrepare(JSON.stringify({ request: undoRequest, completion: completionEnvelope })));
        expect(undo).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        expect(await env.poll(env.host.taskCompletionUndoCommit(JSON.stringify({ request: undoRequest, prepared: undo.value.prepared })))).toMatchObject({ ok: true });
        expect(useTaskStore.getState()._tasksById.get('a')).toMatchObject({ status: 'next', timeSpentMinutes: 9 });
    });
    it('retries deferred work before generic Undo and retains its effort without accepting later manual edits', async () => {
        setSystemTime(new Date(AT)); const env = await fixture();
        const request: NativePomodoroRequest = { action: 'adoptLegacy', requestId: NEXT, observedAtMs: AT,
            localDayKey: '2026-11-16', autoStart: { autoStartFocus: false, autoStartBreaks: false }, legacy: { version: 1,
                namespace: 'native.fixture', collapsedRaw: null, sessionRaw: JSON.stringify({ selectedTaskId: 'a', workSecondsByTaskId: {},
                    timerState: { phase: 'focus', isRunning: true, remainingSeconds: 1500, completedFocusSessions: 0 },
                    phaseEndsAt: new Date(AT + 1_500_000).toISOString() }) } };
        const prepared = await env.poll(env.host.pomodoroTransitionPrepare(JSON.stringify(request)));
        expect(await env.poll(env.host.pomodoroTransitionCommit(prepared.value.planJSON, false))).toMatchObject({ ok: true });
        setSystemTime(new Date(AT + 91_000)); env.failPomodoro(true);
        const completed = await env.poll(env.host.complete('a'));
        expect(completed).toMatchObject({ ok: true });
        expect(useTaskStore.getState()._tasksById.get('a')).toMatchObject({ status: 'done', timeSpentMinutes: 4 });
        env.failPomodoro(false);
        expect(await env.poll(env.host.completeUndo(JSON.stringify({ id: 'a', ...completed.value.undo })))).toMatchObject({ ok: true });
        expect(useTaskStore.getState()._tasksById.get('a')).toMatchObject({ status: 'next', timeSpentMinutes: 5 });
        const second = await env.poll(env.host.complete('a'));
        await useTaskStore.getState().updateTask('a', { description: 'Later manual edit' }); await flushPendingSave();
        expect(await env.poll(env.host.completeUndo(JSON.stringify({ id: 'a', ...second.value.undo })))).toMatchObject({ ok: false });
        expect(useTaskStore.getState()._tasksById.get('a')).toMatchObject({ status: 'done', timeSpentMinutes: 5, description: 'Later manual edit' });
    });
});
