import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import vm from 'node:vm';
import { build } from 'esbuild';

let source: string;
const fixtures: ReturnType<typeof fixture>[] = [];
beforeAll(async () => {
    const built = await build({ stdin: { contents: `
        import './host-entry';
        import { useTaskStore, flushPendingSave, resetForTests } from '../../../packages/core/src/store';
        globalThis.fixture = {
            add: async () => { await useTaskStore.getState().addTask('PRIVATE_TASK', { status: 'archived', completedAt: '2026-10-12T12:00:00.000Z', archivedAt: '2026-10-12T12:00:00.000Z', checklist: [{ id: 'one', title: 'PRIVATE_ITEM', isCompleted: false }] }); await flushPendingSave(); return useTaskStore.getState()._allTasks[0].id; },
            flush: flushPendingSave, reset: resetForTests,
        };
    `, resolveDir: import.meta.dir, loader: 'ts' }, bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent' });
    source = built.outputFiles[0].text;
});
afterEach(async () => {
    const closed = new Set<Database>();
    for (const f of fixtures.splice(0)) { await f.state.fixture.flush(); f.state.fixture.reset(); if (!closed.has(f.database)) { f.database.close(); closed.add(f.database); } }
});
const fixture = (platform = 'ios', bootMode?: 'journaled', database = new Database(':memory:')) => { let logText = ''; const writes: string[] = [], sqlCalls: string[] = [];
    const state: Record<string, any> = {
        AbortController, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout,
        __mindwtrHostPlatform: platform, console: { info() {}, warn() {}, error() {}, log() {} },
        __mindwtrNative: {
            sqlExec: (sql: string) => { sqlCalls.push(sql); writes.push(sql); database.exec(sql); return null; },
            sqlRun: (sql: string, params: string) => { sqlCalls.push(sql); writes.push(sql); database.query(sql).run(...JSON.parse(params)); return null; },
            sqlAll: (sql: string, params: string) => { sqlCalls.push(sql); return JSON.stringify(database.query(sql).all(...JSON.parse(params))); },
            nowMs: () => Date.now(), randomBytes: (n: number) => JSON.stringify(Array(n).fill(7)), log() {},
            rnStateCommit: () => null, kvGet: () => '[null]', kvSet: () => null, kvRemove: () => null,
            fileList: () => 'null', fileRead: () => '', fileDelete: () => null,
            logFile: (op: string, text: string) => {
                if (op === 'path' || op === 'ensure') return 'files/logs/mindwtr.log';
                if (op === 'size') return String(logText.length);
                if (op === 'read') return logText;
                if (op === 'exists') return logText ? '1' : '';
                if (op === 'isAbsent') return logText ? '' : '1';
                if (op === 'append') { logText += text; return ''; }
                if (op === 'write') { logText = text; return ''; }
                if (op === 'delete') { logText = ''; return '1'; }
                throw new Error('Unexpected log operation');
            },
        },
    };
    vm.runInNewContext(source, state);
    const poll = async (ticket: string) => {
        for (let i = 0; i < 200; i++) {
            const value = state.MindwtrHost.poll(ticket);
            if (value !== null) return JSON.parse(value);
            await new Promise(done => setTimeout(done, 0));
        }
        throw new Error('Status bridge did not settle');
    };
    const f = { state, database, writes, sqlCalls, log: () => logText,
        call: (name: string, input?: unknown) => poll(input === undefined ? state.MindwtrHost[name]() : state.MindwtrHost[name](JSON.stringify(input))),
        boot: async (add = true, recovery = false) => { const boot = recovery ? state.MindwtrHost.bootRecovery : state.MindwtrHost.boot; expect(await poll(bootMode === undefined ? boot('', '') : boot('', '', bootMode))).toMatchObject({ ok: true }); const id = add ? await state.fixture.add() : ''; writes.length = 0; logText = ''; return id; },
    };
    fixtures.push(f); return f;
};
const WRITE = '00000000-0000-4000-8000-000000000911', UNDO = '00000000-0000-4000-8000-000000000912';
const prepare = async (f: ReturnType<typeof fixture>, id: string) => {
    const view = await f.call('taskView', { id });
    const request = { id, taskRevision: view.value.taskRevision, requestId: WRITE, source: 'row' };
    const plan = await f.call('taskCompletionPrepare', request);
    expect(plan).toMatchObject({ ok: true, value: { kind: 'prepared', prepared: { version: 2, kind: 'rowComplete' } } });
    return { request, prepared: plan.value.prepared };
};
describe('actual exported iOS row completion bridge', () => {
    it('persists completion/Undo namespaces through cold host loading and emits content-free forced proof', async () => {
        const first = fixture(); const id = await first.boot(), view = await first.call('taskView', { id });
        const e = await prepare(first, id); expect(first.writes).toEqual([]);
        expect(await first.call('taskCompletionValidate', e)).toEqual({ ok: true, value: e.prepared.result });
        expect(await first.call('taskCompletionOutcome', e)).toEqual({ ok: true, value: null });
        expect(await first.call('taskCompletionCommit', e)).toEqual({ ok: true, value: e.prepared.result });
        expect(first.database.query('SELECT status,completedAt FROM tasks WHERE id=?').get(id)).toEqual({ status: 'done', completedAt: '2026-10-12T12:00:00.000Z' });
        const cold = fixture('ios', undefined, first.database); await cold.boot(false, true);
        expect(await cold.call('taskCompletionOutcome', e)).toEqual({ ok: true, value: e.prepared.result });
        const beforeRetry = [...cold.writes]; expect(await cold.call('taskCompletionCommit', e)).toEqual({ ok: true, value: e.prepared.result }); expect(cold.writes).toEqual(beforeRetry);
        const request = { requestId: UNDO, completionRequestId: WRITE };
        const plan = await cold.call('taskCompletionUndoPrepare', { request, completion: e });
        expect(plan).toMatchObject({ ok: true, value: { kind: 'prepared', prepared: { version: 2, kind: 'rowCompleteUndo' } } });
        const u = { request, prepared: plan.value.prepared };
        expect(await cold.call('taskCompletionUndoValidate', u)).toEqual({ ok: true, value: { id } });
        expect(await cold.call('taskCompletionUndoCommit', u)).toEqual({ ok: true, value: { id } });
        expect(cold.database.query('SELECT status FROM tasks WHERE id=?').get(id)).toEqual({ status: 'archived' });
        const receipts = cold.database.query<{ method: string }, []>('SELECT method FROM native_request_receipts ORDER BY request_id').all();
        expect(receipts.map(row => row.method.split(':')[0])).toEqual(['rowTaskCompletion', 'rowTaskCompletionUndo']);
        const after = await cold.call('taskView', { id }); expect(Object.keys(after.value).sort()).toEqual(Object.keys(view.value).sort());
        await cold.call('logShare'); const entries = cold.log().trim().split('\n').map(line => JSON.parse(line)).filter(e => e.message === 'Native iOS row completion confirmed');
        expect(entries.map(e => e.context.outcome)).toContain('completed'); expect(entries.map(e => e.context.outcome)).toContain('undone');
        for (const entry of entries) expect(Object.keys(entry.context).sort()).toEqual(['category', 'outcome', 'releaseCheck']);
        expect(JSON.stringify(entries)).not.toContain('PRIVATE'); expect(JSON.stringify(entries)).not.toContain(id);
        const coldUndo = fixture('ios', undefined, cold.database); await coldUndo.boot(false, true);
        expect(await coldUndo.call('taskCompletionUndoOutcome', u)).toEqual({ ok: true, value: { id } });
    });
    it.each([undefined, 'journaled'] as const)('refuses all row completion/Undo methods without SQL on Android %s', async bootMode => {
        const ios = fixture(); const id = await ios.boot(), e = await prepare(ios, id);
        await ios.call('taskCompletionCommit', e);
        const request = { requestId: UNDO, completionRequestId: WRITE };
        const plan = await ios.call('taskCompletionUndoPrepare', { request, completion: e });
        const u = { request, prepared: plan.value.prepared };
        const android = fixture('android', bootMode); await android.boot(); const before = [...android.sqlCalls];
        for (const [method, input] of [['taskCompletionPrepare', e.request], ['taskCompletionValidate', e], ['taskCompletionCommit', e], ['taskCompletionOutcome', e],
            ['taskCompletionUndoPrepare', { request, completion: e }], ['taskCompletionUndoValidate', u], ['taskCompletionUndoCommit', u], ['taskCompletionUndoOutcome', u],
            ['referenceProjectNextActionOptions', { origin: { kind: 'completion', envelope: e }, params: { offset: 0, revision: null } }],
            ['referenceProjectNextActionPrepare', { request: {}, origin: { kind: 'completion', envelope: e } }],
            ...['referenceProjectNextActionValidate', 'referenceProjectNextActionCommit', 'referenceProjectNextActionOutcome'].map(method =>
                [method, { request: {}, prepared: { origin: { kind: 'completion', envelope: e } } }] as const)] as const) {
            expect(await android.call(method, input)).toEqual({ ok: false, error: expect.stringContaining('requires iOS') });
            expect(android.sqlCalls).toEqual(before);
        }
    });
});
