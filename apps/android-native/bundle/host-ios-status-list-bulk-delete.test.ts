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
                await useTaskStore.getState().addTask('PRIVATE_FIRST', { status: 'waiting', contexts: ['@home'] });
                await flushPendingSave();
                await useTaskStore.getState().addTask('PRIVATE_SECOND', { status: 'waiting', contexts: ['@home'] });
                await flushPendingSave(); return { ids: useTaskStore.getState()._allTasks.map(task => task.id) };
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
        bulk: (input: unknown) => poll(state.MindwtrHost.menuRead('bulk', JSON.stringify(input))),
        boot: async (add = true, recovery = false) => { const boot = recovery ? state.MindwtrHost.bootRecovery : state.MindwtrHost.boot; expect(await poll(bootMode === undefined ? boot('', '') : boot('', '', bootMode))).toMatchObject({ ok: true }); const id = add ? await state.fixture.add() : ''; writes.length = 0; logText = ''; return id; },
    };
    fixtures.push(f); return f;
};
const ids = (n: number) => `00000000-0000-4000-8000-00000000${String(n).padStart(4, '0')}`;
const revisions = async (f: ReturnType<typeof fixture>, taskIds: string[]) => {
    const taskRevisions: Record<string, string> = {};
    for (const id of taskIds) { const view = await f.call('taskView', { id }); expect(view.ok).toBe(true); taskRevisions[id] = view.value.taskRevision; }
    return taskRevisions;
};
const CONTEXTS = { tokens: ['@home'], matchMode: 'all', searchQuery: '', filters: { searchQuery: '', tokens: [], excludedTokens: [], projects: [], priorities: [], energyLevels: [], timeEstimates: [], location: '', contextMatchMode: 'all', tagMatchMode: 'all' }, savedFilterId: null };

describe('actual exported iOS status-list bulk Trash keeps durable receipts for its Undo', () => {
    it.each([
        ['waiting', {}],
        ['contexts', CONTEXTS],
    ] as const)('deletes and restores a %s selection', async (source, params) => {
        const f = fixture(), seeded = await f.boot() as { ids: string[] };
        const taskIds = seeded.ids, n = ['waiting', 'contexts'].indexOf(source) * 2 + 1;
        const request = { requestId: ids(n), taskIds, taskRevisions: await revisions(f, taskIds), source, ...(source === 'contexts' ? { params } : {}) };
        const planned = await f.call('archivedTasksDeletePrepare', request);
        expect(planned).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        const deletion = { request, prepared: planned.value.prepared };
        expect(await f.call('archivedTasksDeleteCommit', deletion)).toEqual({ ok: true, value: deletion.prepared.result });
        const undoRequest = { requestId: ids(n + 1), deleteRequestId: request.requestId };
        const undoPlanned = await f.call('archivedTasksDeleteUndoPrepare', { request: undoRequest, delete: deletion });
        expect(undoPlanned).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        expect(await f.call('archivedTasksDeleteUndoCommit', { request: undoRequest, prepared: undoPlanned.value.prepared })).toEqual({ ok: true, value: { count: 2 } });
        expect(f.database.query<{ deletedAt: string | null }, []>('SELECT deletedAt FROM tasks').all().every(row => !row.deletedAt)).toBe(true);
        expect(f.database.query<{ method: string }, []>('SELECT method FROM native_request_receipts').all().map(row => row.method.split(':')[0]).sort())
            .toEqual([`${source}TasksDelete`, `${source}TasksDeleteUndo`]);
    });
});
