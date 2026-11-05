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

const prepare = async(f:ReturnType<typeof fixture>,seeded:{projectId:string;ids:string[]})=>{
    const id=seeded.ids[0],view=await f.call('taskView',{id});expect(view.ok).toBe(true);
    const request={id,taskRevision:view.value.taskRevision,requestId:WRITE,source:'row',completedAt:'2026-10-02T09:12:34.789Z',timeSpentText:null};
    const options=await f.call('rowTaskBackdateOptions',{id,taskRevision:request.taskRevision});
    expect(options).toMatchObject({ok:true,value:{taskId:id,initialValue:null,initialEpochMilliseconds:null,showTimeSpent:false}});
    const planned=await f.call('rowTaskBackdatePrepare',request);expect(planned).toMatchObject({ok:true,value:{kind:'prepared',prepared:{version:2,kind:'rowBackdate',result:{id}}}});
    return {request,prepared:planned.value.prepared};
};
describe('actual exported iOS shared-row backdate',()=>{
    it('persists exact chosen time, id-only ACK, cold namespace and private diagnostics',async()=>{
        const f=fixture(),seeded=await f.boot(),e=await prepare(f,seeded),result={id:e.request.id};
        expect(f.writes).toEqual([]);expect(await f.call('rowTaskBackdateValidate',e)).toEqual({ok:true,value:result});
        expect(await f.call('rowTaskBackdateOutcome',e)).toEqual({ok:true,value:null});expect(await f.call('rowTaskBackdateCommit',e)).toEqual({ok:true,value:result});
        expect(f.database.query('SELECT completedAt FROM tasks WHERE id=?').get(e.request.id)).toEqual({completedAt:e.request.completedAt});
        await f.call('logShare');const diagnostics=f.log(),after=f.database.query('SELECT * FROM tasks ORDER BY id').all();
        const cold=fixture('ios',undefined,f.database);await cold.boot(false,true);const before=[...cold.writes];
        expect(await cold.call('rowTaskBackdateOutcome',e)).toEqual({ok:true,value:result});expect(await cold.call('rowTaskBackdateCommit',e)).toEqual({ok:true,value:result});
        expect(cold.writes).toEqual(before);expect(cold.database.query('SELECT * FROM tasks ORDER BY id').all()).toEqual(after);
        expect(cold.database.query<{method:string},[]>('SELECT method FROM native_request_receipts').all().map(row=>row.method.split(':')[0])).toEqual(['rowTaskBackdate']);
        const entries=diagnostics.trim().split('\n').map(line=>JSON.parse(line)).filter(e=>e.context?.releaseCheck==='v1.3.9/ios-row-backdate');
        expect(entries).toHaveLength(1);expect(entries[0].context).toEqual({releaseCheck:'v1.3.9/ios-row-backdate',outcome:'completed',category:'storage'});
        expect(JSON.stringify(entries)).not.toContain('PRIVATE');expect(JSON.stringify(entries)).not.toContain(e.request.id);
    });
    it.each([undefined,'journaled'] as const)('refuses all new methods and row-origin next-action before SQL in Android %s',async bootMode=>{
        const ios=fixture(),seeded=await ios.boot(),e=await prepare(ios,seeded);
        await ios.call('rowTaskBackdateCommit',e);const origin={kind:'backdate',envelope:e};
        const offered=await ios.call('referenceProjectNextActionOptions',{origin,params:{offset:0,revision:null}});expect(offered.ok).toBe(true);expect(offered.value).not.toBeNull();
        const candidate=offered.value.candidates.items[0];expect(candidate).toBeDefined();
        const request={requestId:'00000000-0000-4000-8000-000000001022',origin:offered.value.origin,promptRevision:offered.value.promptRevision,action:'choose',candidateId:candidate.id,candidateRevision:candidate.taskRevision};
        const plan=await ios.call('referenceProjectNextActionPrepare',{request,origin});expect(plan.ok).toBe(true);const followup={request,prepared:plan.value.prepared};
        const android=fixture('android',bootMode);await android.boot();const before=[...android.sqlCalls];
        for(const suffix of ['Options','Prepare','Validate','Commit','Outcome']){
            const input=suffix==='Options'?{id:e.request.id,taskRevision:e.request.taskRevision}:suffix==='Prepare'?e.request:e;
            expect(await android.call('rowTaskBackdate'+suffix,input)).toEqual({ok:false,error:expect.stringContaining('requires iOS')});expect(android.sqlCalls).toEqual(before);
        }
        for(const suffix of ['Options','Prepare','Validate','Commit','Outcome']){
            const input=suffix==='Options'?{origin,params:{offset:0,revision:null}}:suffix==='Prepare'?{request,origin}:followup;
            expect(await android.call('referenceProjectNextAction'+suffix,input)).toEqual({ok:false,error:expect.stringContaining('requires iOS')});expect(android.sqlCalls).toEqual(before);
        }
    });
});
