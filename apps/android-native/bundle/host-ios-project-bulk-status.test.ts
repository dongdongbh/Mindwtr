import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import vm from 'node:vm';
import { build } from 'esbuild';
import { resolve } from 'node:path';

let source: string;
const fixtures: ReturnType<typeof fixture>[] = [];
beforeAll(async () => {
    const built = await build({ stdin: { contents: `
        import './host-entry';
        import { useTaskStore, flushPendingSave, resetForTests } from '../../../packages/core/src/store';
        globalThis.fixture = {
            add: async () => {
                const project = await useTaskStore.getState().addProject('PRIVATE_PROJECT', '#94a3b8');
                if (!project) throw new Error('Missing fixture project');
                await flushPendingSave();
                await useTaskStore.getState().addTask('PRIVATE_FIRST', { projectId: project.id, status: 'next' });
                await flushPendingSave();
                await useTaskStore.getState().addTask('PRIVATE_SECOND', { projectId: project.id, status: 'waiting' });
                await flushPendingSave(); return { projectId: project.id, ids: useTaskStore.getState()._allTasks.map(task => task.id) };
            },
            flush: flushPendingSave, reset: resetForTests,
        };
    `, resolveDir: import.meta.dir, loader: 'ts' }, alias: { '@mindwtr/core': resolve(import.meta.dir, '../../../packages/core/src/index.ts') },
        bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent' });
    source = built.outputFiles[0].text;
});
afterEach(async () => {
    const closed = new Set<Database>();
    for (const f of fixtures.splice(0)) { await f.state.fixture.flush(); f.state.fixture.reset(); if (!closed.has(f.database)) { f.database.close(); closed.add(f.database); } }
});
const fixture = (platform = 'ios', bootMode?: 'journaled', database = new Database(':memory:')) => { let logText = ''; let randomCounter = 0; const writes: string[] = [], sqlCalls: string[] = [];
    const state: Record<string, any> = {
        AbortController, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout,
        __mindwtrHostPlatform: platform, console: { info() {}, warn() {}, error() {}, log() {} },
        __mindwtrNative: {
            sqlExec: (sql: string) => { sqlCalls.push(sql); writes.push(sql); database.exec(sql); return null; },
            sqlRun: (sql: string, params: string) => { sqlCalls.push(sql); writes.push(sql); database.query(sql).run(...JSON.parse(params)); return null; },
            sqlAll: (sql: string, params: string) => { sqlCalls.push(sql); return JSON.stringify(database.query(sql).all(...JSON.parse(params))); },
            nowMs: () => Date.now(), randomBytes: (n: number) => JSON.stringify(Array.from({ length: n }, () => ++randomCounter % 256)), log() {},
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
const WRITE = '00000000-0000-4000-8000-000000000941';
const prepare = async (f: ReturnType<typeof fixture>, seeded: { projectId: string; ids: string[] }) => {
    const taskRevisions: Record<string, string> = {};
    for (const id of seeded.ids) {
        const view = await f.call('taskView', { id }); expect(view).toMatchObject({ ok: true }); taskRevisions[id] = view.value.taskRevision;
    }
    const request = { requestId: WRITE, source: 'project', taskIds: seeded.ids, taskRevisions, status: 'waiting',
        params: { projectId: seeded.projectId, showCompleted: true, completedCollapsed: false, filters: {} } };
    const plan = await f.call('projectTasksMovePrepare', request);
    expect(plan).toMatchObject({ ok: true, value: { kind: 'prepared', prepared: { version: 1, result: { count: 2, status: 'waiting' } } } });
    return { request, prepared: plan.value.prepared };
};
describe('actual exported iOS Project bulk status bridge', () => {
    it('persists its exact project receipt through cold boot and logs only count/status/outcome with diagnostics off', async () => {
        const f = fixture(), seeded = await f.boot(), e = await prepare(f, seeded);
        expect(f.writes).toEqual([]); expect(await f.call('projectTasksMoveValidate', e)).toEqual({ ok: true, value: { count: 2, status: 'waiting' } });
        expect(await f.call('projectTasksMoveOutcome', e)).toEqual({ ok: true, value: null });
        expect(await f.call('projectTasksMoveCommit', e)).toEqual({ ok: true, value: { count: 2, status: 'waiting' } });
        const after = f.database.query('SELECT * FROM tasks ORDER BY id').all();
        const cold = fixture('ios', undefined, f.database); await cold.boot(false, true);
        expect(await cold.call('projectTasksMoveOutcome', e)).toEqual({ ok: true, value: { count: 2, status: 'waiting' } });
        const before = [...cold.writes]; expect(await cold.call('projectTasksMoveCommit', e)).toEqual({ ok: true, value: { count: 2, status: 'waiting' } });
        expect(cold.writes).toEqual(before); expect(cold.database.query('SELECT * FROM tasks ORDER BY id').all()).toEqual(after);
        const receipts = cold.database.query<{ method: string }, []>('SELECT method FROM native_request_receipts').all();
        expect(receipts.map(row => row.method.split(':')[0])).toEqual(['projectTasksMove']);
        for (const status of ['inbox', 'next', 'waiting', 'someday', 'done', 'reference']) {
            const notice = await cold.call('projectTasksMoveNotice', { count: 2, status });
            expect(notice).toEqual({ ok: true, value: { message: '2 tasks' } });
        }
        await cold.call('logShare'); const entries = cold.log().trim().split('\n').map(line => JSON.parse(line)).filter(e => e.message === 'Native Project bulk status confirmed');
        expect(entries.length).toBeGreaterThan(0);
        for (const entry of entries) expect(entry.context).toEqual({ releaseCheck: 'v1.3.8/ios-project-bulk-status', count: '2', status: 'waiting', outcome: 'moved', category: 'storage' });
        expect(JSON.stringify(entries)).not.toContain('PRIVATE'); expect(JSON.stringify(entries)).not.toContain(seeded.projectId);
        expect(await cold.call('inboxTasksMovePrepare', e.request)).toMatchObject({ ok: false, error: expect.stringContaining('INVALID_INPUT') });
        expect(await cold.call('referenceTasksMovePrepare', e.request)).toMatchObject({ ok: false, error: expect.stringContaining('INVALID_INPUT') });
    });
    it.each([undefined, 'journaled'] as const)('refuses all four Project methods without SQL on Android %s', async bootMode => {
        const ios = fixture(), e = await prepare(ios, await ios.boot());
        const android = fixture('android', bootMode); await android.boot(); const before = [...android.sqlCalls];
        for (const [method, input] of [['projectTasksMovePrepare', e.request], ['projectTasksMoveValidate', e], ['projectTasksMoveCommit', e], ['projectTasksMoveOutcome', e]] as const) {
            expect(await android.call(method, input)).toEqual({ ok: false, error: expect.stringContaining('requires iOS') }); expect(android.sqlCalls).toEqual(before);
        }
        expect(await android.call('projectTasksMoveNotice', { count: 2, status: 'waiting' })).toEqual({ ok: false, error: expect.stringContaining('requires iOS') });
        expect(android.sqlCalls).toEqual(before);
    });
});
