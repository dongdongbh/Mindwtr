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
                    status:['inbox','next','reference'][index],tags:[],contexts:[],createdAt:at,updatedAt:at,rev:1,revBy:'fixture'})),
                    _allProjects:identities.slice(1).map((id,index)=>({id,title:'PRIVATE_PROJECT'+index,status:'active',color:'#123456',order:index,tagIds:[],createdAt:at,updatedAt:at,rev:1,revBy:'fixture'})),
                    _allAreas:[{id:'area',name:'PRIVATE_AREA',order:0,createdAt:at,updatedAt:at}]});
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
        editor: (id:string) => poll(state.MindwtrHost.editorModel(id)),
        bulk: (input: unknown) => poll(state.MindwtrHost.menuRead('bulk', JSON.stringify(input))),
        boot: async (add = true, recovery = false) => { const boot = recovery ? state.MindwtrHost.bootRecovery : state.MindwtrHost.boot; expect(await poll(bootMode === undefined ? boot('', '') : boot('', '', bootMode))).toMatchObject({ ok: true }); const id = add ? await state.fixture.add() : ''; writes.length = 0; logText = ''; return id; },
    };
    fixtures.push(f); return f;
};
const WRITE = '00000000-0000-4000-8000-000000001021';

const prepare=async(f:ReturnType<typeof fixture>,ids:{id:string;targetId:string;otherId:string})=>{
    const opening=await f.editor(ids.id);expect(opening.ok).toBe(true);
    const base={id:ids.id,requestId:WRITE,taskRevision:opening.value.taskRevision,source:'row',draft:opening.value.draft,scheduleBase:opening.value.scheduleBase};
    const before=f.database.query('SELECT * FROM tasks ORDER BY id').all();expect(await f.call('rowTaskDatesPrepare',base)).toEqual({ok:true,value:{kind:'unchanged',result:{id:ids.id}}});expect(f.database.query('SELECT * FROM tasks ORDER BY id').all()).toEqual(before);expect(f.database.query('SELECT * FROM native_request_receipts').all()).toEqual([]);
    const edited=await f.call('editDraft',{id:ids.id,draft:opening.value.draft,edit:{type:'pickDate',field:'startTime',date:'2030-11-03'}});expect(edited.ok).toBe(true);
    const request={...base,draft:edited.value.draft},plan=await f.call('rowTaskDatesPrepare',request);expect(plan).toMatchObject({ok:true,value:{kind:'prepared',prepared:{version:2,kind:'rowDates',result:{id:ids.id}}}});
    expect(plan.value.prepared.checklist.version).toBe(2);expect(Object.keys(plan.value.prepared).sort()).toEqual(['version','kind','request','rawBefore','checklist','result'].sort());return{request,prepared:plan.value.prepared};
};
describe('actual exported iOS ordinary row Dates',()=>{
    it('keeps unchanged receipt-free, edited data narrow, exact cold receipt and private marker',async()=>{
        const f=fixture(),ids=await f.boot(),e=await prepare(f,ids);expect(f.writes).toEqual([]);
        expect(await f.call('rowTaskDatesValidate',e)).toEqual({ok:true,value:{id:ids.id}});expect(await f.call('rowTaskDatesOutcome',e)).toEqual({ok:true,value:null});
        expect(await f.call('rowTaskDatesCommit',e)).toEqual({ok:true,value:{id:ids.id}});const source=f.database.query('SELECT startTime,rev,status FROM tasks WHERE id=?').get(ids.id);expect(source).toEqual({startTime:e.prepared.checklist.effect.tasks[0].after.startTime,rev:2,status:'next'});
        expect(f.database.query('SELECT startTime FROM tasks WHERE id=?').get(ids.otherId)).toEqual({startTime:null});await f.call('logShare');const diagnostics=f.log();
        f.database.query('UPDATE tasks SET title=?,status=? WHERE id=?').run('Later title','reference',ids.id);
        const cold=fixture('ios',undefined,f.database);await cold.boot(false,true);const writes=[...cold.writes],before=cold.database.query('SELECT * FROM tasks ORDER BY id').all();expect(await cold.call('rowTaskDatesOutcome',e)).toEqual({ok:true,value:{id:ids.id}});expect(await cold.call('rowTaskDatesCommit',e)).toEqual({ok:true,value:{id:ids.id}});expect(cold.writes).toEqual(writes);expect(cold.database.query('SELECT * FROM tasks ORDER BY id').all()).toEqual(before);
        expect(cold.database.query<{method:string},[]>('SELECT method FROM native_request_receipts').all().map(row=>row.method.split(':')[0])).toEqual(['rowTaskDates']);
        const entries=diagnostics.trim().split('\n').map(line=>JSON.parse(line)).filter(e=>e.context?.releaseCheck==='v1.3.8/ios-row-dates');expect(entries).toHaveLength(1);expect(entries[0].context).toEqual({releaseCheck:'v1.3.8/ios-row-dates',outcome:'changed',category:'storage'});expect(JSON.stringify(entries)).not.toContain('PRIVATE');expect(JSON.stringify(entries)).not.toContain(ids.id);expect(JSON.stringify(entries)).not.toContain('2030');
    });
    it.each([undefined,'journaled'] as const)('refuses all four new exports before SQL in Android %s',async bootMode=>{
        const ios=fixture(),e=await prepare(ios,await ios.boot()),android=fixture('android',bootMode);await android.boot();const before=[...android.sqlCalls];for(const suffix of ['Prepare','Validate','Commit','Outcome']){expect(await android.call('rowTaskDates'+suffix,suffix==='Prepare'?e.request:e)).toEqual({ok:false,error:expect.stringContaining('requires iOS')});expect(android.sqlCalls).toEqual(before);}
    });
});
