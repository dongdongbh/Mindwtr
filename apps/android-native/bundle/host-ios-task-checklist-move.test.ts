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
                const identities=['源-e\u0301','é','e\u0301'],at=new Date().toISOString();
                useTaskStore.setState({_allTasks:identities.map((id,index)=>({id,title:['PRIVATE_SOURCE','PRIVATE_TARGET','PRIVATE_OTHER'][index],
                    status:['inbox','next','reference'][index],tags:[],contexts:[],createdAt:at,updatedAt:at,rev:1,revBy:'fixture'}))});
                await useTaskStore.getState().persistSnapshot();await flushPendingSave();return {id:identities[0],targetId:identities[1],otherId:identities[2]};
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

const UNDO='00000000-0000-4000-8000-000000001022';
const prepare=async(f:ReturnType<typeof fixture>,ids:{id:string;targetId:string;otherId:string})=>{
    const source=await f.call('taskView',{id:ids.id}),target=await f.call('taskView',{id:ids.targetId});expect(source.ok).toBe(true);expect(target.ok).toBe(true);
    const input={id:ids.id,taskRevision:source.value.taskRevision,query:'',offset:0,limit:100,revision:null};
    const options=await f.call('taskChecklistMoveOptions',input);expect(options).toMatchObject({ok:true,value:{taskId:ids.id,addedMessage:'Added to checklist',undoLabel:'Undo',total:2}});
    expect(options.value.items.map((row:{id:string})=>row.id)).toEqual([ids.targetId,ids.otherId]);
    const longQuery=await f.call('taskChecklistMoveOptions',{...input,query:'界'.repeat(2000)});expect(longQuery).toMatchObject({ok:true,value:{total:0}});
    const request={requestId:WRITE,id:ids.id,taskRevision:source.value.taskRevision,targetId:ids.targetId,targetRevision:target.value.taskRevision};
    const planned=await f.call('taskChecklistMovePrepare',request);expect(planned).toMatchObject({ok:true,value:{kind:'prepared',prepared:{version:1,kind:'taskChecklistMove',result:{id:ids.targetId}}}});
    return {request,prepared:planned.value.prepared};
};
const undo=async(f:ReturnType<typeof fixture>,move:Awaited<ReturnType<typeof prepare>>)=>{const request={requestId:UNDO,moveRequestId:WRITE};const plan=await f.call('taskChecklistMoveUndoPrepare',{request,move});expect(plan.ok).toBe(true);return{request,prepared:plan.value.prepared};};
describe('actual exported iOS Add to checklist and Undo',()=>{
    it('keeps literal Unicode identities, exact cold receipts and privacy-safe diagnostics',async()=>{
        const f=fixture(),ids=await f.boot(),move=await prepare(f,ids);expect(f.writes).toEqual([]);
        expect(await f.call('taskChecklistMoveValidate',move)).toEqual({ok:true,value:{id:ids.targetId}});expect(await f.call('taskChecklistMoveOutcome',move)).toEqual({ok:true,value:null});
        expect(await f.call('taskChecklistMoveCommit',move)).toEqual({ok:true,value:{id:ids.targetId}});expect(f.database.query('SELECT deletedAt FROM tasks WHERE id=?').get(ids.id)).toEqual({deletedAt:expect.any(String)});
        expect(JSON.parse((f.database.query('SELECT checklist FROM tasks WHERE id=?').get(ids.targetId) as {checklist:string}).checklist)).toHaveLength(1);expect(f.database.query('SELECT checklist FROM tasks WHERE id=?').get(ids.otherId)).toEqual({checklist:null});
        const restored=await undo(f,move);expect(await f.call('taskChecklistMoveUndoValidate',restored)).toEqual({ok:true,value:{id:ids.id}});expect(await f.call('taskChecklistMoveUndoCommit',restored)).toEqual({ok:true,value:{id:ids.id}});
        await f.call('logShare');const diagnostics=f.log(),rows=f.database.query('SELECT * FROM tasks ORDER BY id').all();f.database.query('DELETE FROM native_request_receipts WHERE request_id=?').run(WRITE);
        const cold=fixture('ios',undefined,f.database);await cold.boot(false,true);const before=[...cold.writes];expect(await cold.call('taskChecklistMoveUndoOutcome',restored)).toEqual({ok:true,value:{id:ids.id}});expect(await cold.call('taskChecklistMoveUndoCommit',restored)).toEqual({ok:true,value:{id:ids.id}});expect(cold.writes).toEqual(before);expect(cold.database.query('SELECT * FROM tasks ORDER BY id').all()).toEqual(rows);
        expect(cold.database.query<{method:string},[]>('SELECT method FROM native_request_receipts').all().map(row=>row.method.split(':')[0])).toEqual(['taskChecklistMoveUndo']);
        const entries=diagnostics.trim().split('\n').map(line=>JSON.parse(line)).filter(e=>e.context?.releaseCheck==='v1.3.9/ios-task-checklist-move');expect(entries).toHaveLength(2);expect(entries.map(e=>e.context)).toEqual(['moved','undone'].map(outcome=>({releaseCheck:'v1.3.9/ios-task-checklist-move',outcome,category:'storage'})));expect(JSON.stringify(entries)).not.toContain('PRIVATE');expect(JSON.stringify(entries)).not.toContain(ids.id);
    });
    it.each([undefined,'journaled'] as const)('refuses all nine exports before SQL in Android %s',async bootMode=>{
        const ios=fixture(),move=await prepare(ios,await ios.boot());await ios.call('taskChecklistMoveCommit',move);const restored=await undo(ios,move),android=fixture('android',bootMode);await android.boot();const before=[...android.sqlCalls];
        for(const family of ['taskChecklistMove','taskChecklistMoveUndo'])for(const suffix of (family==='taskChecklistMove'?['Options']:[]).concat(['Prepare','Validate','Commit','Outcome'])){
            const input=suffix==='Options'?{id:move.request.id,taskRevision:move.request.taskRevision,query:'',offset:0,limit:100,revision:null}:suffix==='Prepare'?(family==='taskChecklistMove'?move.request:{request:restored.request,move}):family==='taskChecklistMove'?move:restored;
            expect(await android.call(family+suffix,input)).toEqual({ok:false,error:expect.stringContaining('requires iOS')});expect(android.sqlCalls).toEqual(before);
        }
    });
});
