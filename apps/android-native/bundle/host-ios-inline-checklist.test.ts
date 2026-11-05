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
        throw new Error('Inline bridge did not settle');
    };
    const f = { state, database, writes, sqlCalls, log: () => logText,
        call: (name: string, input?: unknown) => poll(input === undefined ? state.MindwtrHost[name]() : state.MindwtrHost[name](JSON.stringify(input))),
        boot: async () => { expect(await poll(bootMode === undefined ? state.MindwtrHost.boot('', '') : state.MindwtrHost.boot('', '', bootMode))).toMatchObject({ ok: true }); const id = await state.fixture.add(); writes.length = 0; logText = ''; return id; },
    };
    fixtures.push(f); return f;
};
describe('actual exported iOS inline checklist bridge', () => {
    it('uses unchanged taskView, persists once and retains safe proof with diagnostics off', async () => {
        const f = fixture(); const id = await f.boot(); const read = await f.call('taskView', { id });
        expect(read.ok).toBe(true); expect(read.value.checklistBase).toEqual([{ id: 'one', title: 'PRIVATE_ITEM', isCompleted: false }]);
        const keys = Object.keys(read.value).sort();
        const request = { id, taskRevision: read.value.taskRevision, requestId: '00000000-0000-4000-8000-000000000801', action: 'append', title: 'PRIVATE_APPEND' };
        const planned = await f.call('inlineChecklistPrepare', request); expect(planned).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        expect(f.writes).toEqual([]); const envelope = { request, prepared: planned.value.prepared };
        expect(await f.call('inlineChecklistValidate', envelope)).toEqual({ ok: true, value: { id } });
        expect(await f.call('inlineChecklistOutcome', envelope)).toEqual({ ok: true, value: null });
        expect(await f.call('inlineChecklistCommit', envelope)).toEqual({ ok: true, value: { id } });
        const writes = [...f.writes];
        expect(await f.call('inlineChecklistCommit', envelope)).toEqual({ ok: true, value: { id } });
        expect(await f.call('inlineChecklistOutcome', envelope)).toEqual({ ok: true, value: { id } });
        expect(f.writes).toEqual(writes);
        const after = await f.call('taskView', { id }); expect(Object.keys(after.value).sort()).toEqual(keys);
        expect(after.value.checklistBase).toHaveLength(2);
        await f.call('logShare');
        const entries = f.log().trim().split('\n').map(line => JSON.parse(line)).filter(e => e.message === 'Native iOS inline checklist confirmed');
        expect(entries.length).toBeGreaterThan(0);
        for (const entry of entries) expect(entry.context).toEqual({ releaseCheck: 'v1.3.8/ios-inline-checklist', action: 'append', outcome: 'confirmed', category: 'storage' });
        expect(JSON.stringify(entries)).not.toContain('PRIVATE'); expect(JSON.stringify(entries)).not.toContain(id);
    });
    it.each([undefined, 'journaled'] as const)('refuses all four methods before SQL on Android boot mode %s', async bootMode => {
        const ios = fixture(); const iosID = await ios.boot(); const iosView = await ios.call('taskView', { id: iosID });
        const iosRequest = { id: iosID, taskRevision: iosView.value.taskRevision, requestId: '00000000-0000-4000-8000-000000000801', action: 'append', title: 'PRIVATE_APPEND' };
        const iosPlan = await ios.call('inlineChecklistPrepare', iosRequest);
        expect(iosPlan).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        const f = fixture('android', bootMode); const id = await f.boot(); const view = await f.call('taskView', { id });
        const before = [...f.writes], sqlBefore = [...f.sqlCalls];
        const request = { id, taskRevision: view.value.taskRevision, requestId: '00000000-0000-4000-8000-000000000801', action: 'setCompleted', itemId: 'one', isCompleted: true };
        const planned = await f.call('inlineChecklistPrepare', request);
        const envelope = planned.ok ? { request, prepared: planned.value.prepared } : { request: iosRequest, prepared: iosPlan.value.prepared };
        const answers = [planned, await f.call('inlineChecklistValidate', envelope),
            await f.call('inlineChecklistCommit', envelope), await f.call('inlineChecklistOutcome', envelope)];
        expect(answers).toEqual(Array.from({ length: 4 }, () => ({ ok: false, error: expect.stringContaining('requires iOS') })));
        expect(f.writes).toEqual(before); expect(f.sqlCalls).toEqual(sqlBefore);
    });
});
