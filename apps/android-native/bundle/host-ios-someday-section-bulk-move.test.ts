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
                await useTaskStore.getState().updateSettings({ gtd: { viewSections: { someday: [{ id: 'ideas', title: 'Ideas', order: 0 }, { id: 'later', title: 'Later', order: 1 }] } } });
                await useTaskStore.getState().addTask('PRIVATE_FIRST', { status: 'someday', viewSectionIds: { someday: 'later' } });
                await flushPendingSave();
                await useTaskStore.getState().addTask('PRIVATE_SECOND', { status: 'someday' });
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
        boot: async (add = true, recovery = false) => { const boot = recovery ? state.MindwtrHost.bootRecovery : state.MindwtrHost.boot; expect(await poll(bootMode === undefined ? boot('', '') : boot('', '', bootMode))).toMatchObject({ ok: true }); const id = add ? await state.fixture.add() : ''; writes.length = 0; logText = ''; return id; },
    };
    fixtures.push(f); return f;
};
const ids = (n: number) => `00000000-0000-4000-8000-00000000${String(n).padStart(4, '0')}`;
const sectionOf = (f: ReturnType<typeof fixture>) => f.database.query<{ viewSectionIds: string | null }, []>('SELECT viewSectionIds FROM tasks ORDER BY createdAt')
    .all().map(row => (JSON.parse(row.viewSectionIds ?? '{}') as { someday?: string }).someday ?? null);

describe('actual exported iOS Someday bulk Move to section keeps durable receipts for its Undo', () => {
    it('moves a mixed selection, then Undo restores each original section', async () => {
        const f = fixture(), seeded = await f.boot() as { ids: string[] };
        const options = await f.call('somedaySectionBulkMoveOptions', { taskIds: seeded.ids });
        expect(options).toMatchObject({ ok: true, value: { taskIds: seeded.ids, choices: { total: 3 } } });
        expect(options.value.choices.items.map((item: { sectionId: string | null }) => item.sectionId)).toEqual([null, 'ideas', 'later']);
        const request = { requestId: ids(1), taskIds: seeded.ids, taskRevisions: options.value.taskRevisions, sectionId: 'ideas' };
        const planned = await f.call('somedaySectionBulkMovePrepare', request);
        expect(planned).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        const move = { request, prepared: planned.value.prepared };
        expect(await f.call('somedaySectionBulkMoveValidate', move)).toEqual({ ok: true, value: { taskIds: seeded.ids, changed: true, sectionId: 'ideas' } });
        expect(await f.call('somedaySectionBulkMoveCommit', move)).toEqual({ ok: true, value: { taskIds: seeded.ids, changed: true, sectionId: 'ideas' } });
        expect(sectionOf(f)).toEqual(['ideas', 'ideas']);
        expect(await f.call('somedaySectionBulkMoveRetryOutcome', move)).toMatchObject({ ok: true });
        const undoRequest = { requestId: ids(2), moveRequestId: request.requestId };
        const undoPlanned = await f.call('somedaySectionBulkMoveUndoPrepare', { request: undoRequest, move });
        expect(undoPlanned).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        const undo = { request: undoRequest, prepared: undoPlanned.value.prepared };
        expect(await f.call('somedaySectionBulkMoveUndoValidate', undo)).toMatchObject({ ok: true });
        expect(await f.call('somedaySectionBulkMoveUndoCommit', undo)).toEqual({ ok: true, value: { taskIds: seeded.ids, changed: true } });
        expect(sectionOf(f)).toEqual(['later', null]);
        expect(await f.call('somedaySectionBulkMoveUndoRetryOutcome', undo)).toMatchObject({ ok: true });
        expect(f.database.query<{ method: string }, []>('SELECT method FROM native_request_receipts').all().map(row => row.method.split(':')[0]).sort())
            .toEqual(['somedaySectionBulkMove', 'somedaySectionBulkMoveUndo']);
        expect(f.log().match(/v1\.3\.8\/ios-someday-section-bulk-move/g)?.length).toBe(2);
        expect(f.log()).toContain('"operation":"undo"');
        expect(f.log()).not.toContain('PRIVATE_');
    });
});
