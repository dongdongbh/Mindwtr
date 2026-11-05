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
            add: async () => { await useTaskStore.getState().addTask('PRIVATE_TASK', { checklist: [{ id: 'one', title: 'PRIVATE_ITEM', isCompleted: false }] }); await flushPendingSave(); return useTaskStore.getState()._allTasks[0].id; },
            flush: flushPendingSave, reset: resetForTests,
        };
    `, resolveDir: import.meta.dir, loader: 'ts' }, bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent' });
    source = built.outputFiles[0].text;
});
afterEach(async () => {
    for (const f of fixtures.splice(0)) { await f.state.fixture.flush(); f.state.fixture.reset(); f.database.close(); }
});
const fixture = (platform = 'ios', bootMode?: 'journaled') => {
    const database = new Database(':memory:'); let logText = ''; const writes: string[] = [], sqlCalls: string[] = [];
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
        boot: async () => { expect(await poll(bootMode === undefined ? state.MindwtrHost.boot('', '') : state.MindwtrHost.boot('', '', bootMode))).toMatchObject({ ok: true }); const id = await state.fixture.add(); writes.length = 0; logText = ''; return id; },
    };
    fixtures.push(f); return f;
};
describe('actual exported iOS row quick status bridge', () => {
    it('reads sealed options, writes once and retains safe proof with logging disabled', async () => {
        const f = fixture(); const id = await f.boot(); const view = await f.call('taskView', { id });
        const ref = { id, taskRevision: view.value.taskRevision };
        const options = await f.call('rowQuickStatusOptions', ref);
        expect(options.ok).toBe(true); expect(Object.keys(options.value).sort()).toEqual(['options', 'status', 'taskId', 'taskRevision', 'title']);
        expect(options.value.options.map((o: { status: string }) => o.status)).toEqual(['inbox', 'next', 'waiting', 'someday', 'done', 'reference']);
        const request = { ...ref, requestId: '00000000-0000-4000-8000-000000000901', status: 'waiting' };
        const plan = await f.call('rowQuickStatusPrepare', request); expect(plan).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        const e = { request, prepared: plan.value.prepared }; expect(f.writes).toEqual([]);
        expect(await f.call('rowQuickStatusValidate', e)).toEqual({ ok: true, value: { id } });
        expect(await f.call('rowQuickStatusOutcome', e)).toEqual({ ok: true, value: null });
        expect(await f.call('rowQuickStatusCommit', e)).toEqual({ ok: true, value: { id } }); const writes = [...f.writes];
        expect(await f.call('rowQuickStatusCommit', e)).toEqual({ ok: true, value: { id } });
        expect(await f.call('rowQuickStatusOutcome', e)).toEqual({ ok: true, value: { id } }); expect(f.writes).toEqual(writes);
        const after = await f.call('taskView', { id }); expect(Object.keys(after.value).sort()).toEqual(Object.keys(view.value).sort());
        expect(f.database.query('SELECT status FROM tasks WHERE id=?').get(id)).toEqual({ status: 'waiting' });
        await f.call('logShare'); const entries = f.log().trim().split('\n').map(line => JSON.parse(line)).filter(e => e.message === 'Native iOS row quick status confirmed');
        expect(entries.length).toBeGreaterThan(0);
        for (const e of entries) expect(e.context).toEqual({ releaseCheck: 'v1.3.8/ios-row-quick-status', target: 'waiting', outcome: 'confirmed', category: 'storage' });
        expect(JSON.stringify(entries)).not.toContain('PRIVATE'); expect(JSON.stringify(entries)).not.toContain(id);
        expect(await f.call('rowQuickStatusPrepare', { ...request, status: 'done' })).toMatchObject({ ok: false, error: expect.stringContaining('INVALID_INPUT') });
    });
    it.each([undefined, 'journaled'] as const)('refuses all five methods before any SQL on Android %s', async bootMode => {
        const ios = fixture(); const id = await ios.boot(); const view = await ios.call('taskView', { id });
        const ref = { id, taskRevision: view.value.taskRevision }, request = { ...ref, requestId: '00000000-0000-4000-8000-000000000901', status: 'waiting' };
        const plan = await ios.call('rowQuickStatusPrepare', request); expect(plan).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        const e = { request, prepared: plan.value.prepared };
        const f = fixture('android', bootMode); await f.boot(); const before = [...f.sqlCalls];
        const responses = [await f.call('rowQuickStatusOptions', ref), await f.call('rowQuickStatusPrepare', request),
            await f.call('rowQuickStatusValidate', e), await f.call('rowQuickStatusCommit', e), await f.call('rowQuickStatusOutcome', e)];
        expect(responses).toEqual(Array.from({ length: 5 }, () => ({ ok: false, error: expect.stringContaining('requires iOS') })));
        expect(f.sqlCalls).toEqual(before);
    });
});
