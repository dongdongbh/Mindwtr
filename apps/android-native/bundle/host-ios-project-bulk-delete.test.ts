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
                await useTaskStore.getState().addTask('PRIVATE_FIRST', { projectId: project.id, status: 'next', tags: ['#old'] });
                await flushPendingSave();
                await useTaskStore.getState().addTask('PRIVATE_SECOND', { projectId: project.id, status: 'waiting', tags: ['#old'] });
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
        bulk: (input: unknown) => poll(state.MindwtrHost.menuRead('bulk', JSON.stringify(input))),
        boot: async (add = true, recovery = false) => { const boot = recovery ? state.MindwtrHost.bootRecovery : state.MindwtrHost.boot; expect(await poll(bootMode === undefined ? boot('', '') : boot('', '', bootMode))).toMatchObject({ ok: true }); const id = add ? await state.fixture.add() : ''; writes.length = 0; logText = ''; return id; },
    };
    fixtures.push(f); return f;
};
const WRITE = '00000000-0000-4000-8000-000000001021';

const UNDO = '00000000-0000-4000-8000-000000001022';
const prepare = async (f: ReturnType<typeof fixture>, seeded: {projectId:string;ids:string[]}) => {
    const taskRevisions:Record<string,string>={};
    for(const id of seeded.ids){const view=await f.call('taskView',{id});expect(view.ok).toBe(true);taskRevisions[id]=view.value.taskRevision;}
    const request={requestId:WRITE,source:'project',taskIds:seeded.ids,taskRevisions,
        params:{projectId:seeded.projectId,showCompleted:true,completedCollapsed:false,filters:{}}};
    const planned=await f.call('projectTasksDeletePrepare',request);
    expect(planned).toMatchObject({ok:true,value:{kind:'prepared',prepared:{version:1,result:{count:2}}}});
    return {request,prepared:planned.value.prepared};
};
const prepareUndo=async(f:ReturnType<typeof fixture>,deletion:Awaited<ReturnType<typeof prepare>>)=>{
    const request={requestId:UNDO,deleteRequestId:WRITE};
    const planned=await f.call('projectTasksDeleteUndoPrepare',{request,delete:deletion});
    expect(planned).toMatchObject({ok:true,value:{kind:'prepared',prepared:{version:1,result:{count:2}}}});
    return {request,prepared:planned.value.prepared};
};
describe('actual exported iOS Project selected Trash',()=>{
    it('executes Delete/Undo and retains exact cold receipts with private diagnostics excluded',async()=>{
        const f=fixture(),seeded=await f.boot(),deletion=await prepare(f,seeded);
        expect(f.writes).toEqual([]);
        expect(await f.call('projectTasksDeleteValidate',deletion)).toEqual({ok:true,value:deletion.prepared.result});
        expect(await f.call('projectTasksDeleteOutcome',deletion)).toEqual({ok:true,value:null});
        expect(await f.call('projectTasksDeleteCommit',deletion)).toEqual({ok:true,value:deletion.prepared.result});
        expect(f.database.query<{deletedAt:string},[]>('SELECT deletedAt FROM tasks').all().every(row=>Boolean(row.deletedAt))).toBe(true);
        const undo=await prepareUndo(f,deletion);
        expect(await f.call('projectTasksDeleteUndoValidate',undo)).toEqual({ok:true,value:{count:2}});
        expect(await f.call('projectTasksDeleteUndoOutcome',undo)).toEqual({ok:true,value:null});
        expect(await f.call('projectTasksDeleteUndoCommit',undo)).toEqual({ok:true,value:{count:2}});
        expect(f.database.query<{deletedAt:string|null},[]>('SELECT deletedAt FROM tasks').all().every(row=>!row.deletedAt)).toBe(true);
        await f.call('logShare');const diagnostics=f.log();
        f.database.query('DELETE FROM native_request_receipts WHERE request_id=?').run(WRITE);
        const cold=fixture('ios',undefined,f.database);await cold.boot(false,true);const before=[...cold.writes];
        expect(await cold.call('projectTasksDeleteUndoOutcome',undo)).toEqual({ok:true,value:{count:2}});
        expect(await cold.call('projectTasksDeleteUndoCommit',undo)).toEqual({ok:true,value:{count:2}});
        expect(cold.writes).toEqual(before);
        expect(cold.database.query<{method:string},[]>('SELECT method FROM native_request_receipts').all().map(row=>row.method.split(':')[0])).toEqual(['projectTasksDeleteUndo']);
        const entries=diagnostics.trim().split('\n').map(line=>JSON.parse(line)).filter(e=>e.context?.releaseCheck==='v1.3.9/ios-project-bulk-trash');
        expect(entries).toHaveLength(2);
        expect(entries.map(e=>e.context)).toEqual(['deleted','restored'].map(outcome=>({releaseCheck:'v1.3.9/ios-project-bulk-trash',count:'2',outcome,category:'storage'})));
        expect(JSON.stringify(entries)).not.toContain('PRIVATE');expect(JSON.stringify(entries)).not.toContain(seeded.projectId);
    });
    it.each([undefined,'journaled'] as const)('refuses all eight exports before SQL in Android %s',async bootMode=>{
        const ios=fixture(),deletion=await prepare(ios,await ios.boot());await ios.call('projectTasksDeleteCommit',deletion);const undo=await prepareUndo(ios,deletion);
        const android=fixture('android',bootMode);await android.boot();const before=[...android.sqlCalls];
        for(const action of ['Delete','DeleteUndo'])for(const suffix of ['Prepare','Validate','Commit','Outcome']){
            const input=suffix==='Prepare'?(action==='Delete'?deletion.request:{request:undo.request,delete:deletion}):(action==='Delete'?deletion:undo);
            expect(await android.call('projectTasks'+action+suffix,input)).toEqual({ok:false,error:expect.stringContaining('requires iOS')});expect(android.sqlCalls).toEqual(before);
        }
    });
});
