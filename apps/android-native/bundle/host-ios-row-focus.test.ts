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

const flags={status:'inbox',isFocusedToday:false,selectionMode:false,interactionDisabled:false};
const prepare=async(f:ReturnType<typeof fixture>,ids:{id:string})=>{const opening=await f.editor(ids.id);expect(opening.ok).toBe(true);const request={id:ids.id,requestId:WRITE,taskRevision:opening.value.taskRevision,source:'row',focused:true},plan=await f.call('rowTaskFocusPrepare',request);expect(plan).toMatchObject({ok:true,value:{kind:'prepared',prepared:{version:2,kind:'rowFocus',result:{id:ids.id,focused:true}}}});expect(Object.keys(plan.value.prepared).sort()).toEqual(['version','kind','request','rawBefore','checklist','result'].sort());return{request,prepared:plan.value.prepared};};
describe('actual exported iOS swipe and atomic row Focus',()=>{
 it('reads pure donor presentation before boot with zero SQL and strict supplied flags',async()=>{const f=fixture();const before=[...f.sqlCalls];const result=await f.call('taskRowSwipeActions',flags);expect(result).toMatchObject({ok:true,value:{swipeRight:[{id:'done',status:'done'},{id:'focus',focused:false}],swipeLeft:[{id:'organize'},{id:'dates'},{id:'delete'}]}});expect(f.sqlCalls).toEqual(before);expect(await f.call('taskRowSwipeActions',{...flags,interactionDisabled:true})).toEqual({ok:true,value:{swipeRight:[],swipeLeft:[]}});const selection=await f.call('taskRowSwipeActions',{...flags,selectionMode:true});expect([...selection.value.swipeRight,...selection.value.swipeLeft].every((a:any)=>a.enabled===false)).toBe(true);for(const input of [{...flags,unknown:true},{...flags,status:'unknown'},{...flags,selectionMode:0}])expect(await f.call('taskRowSwipeActions',input)).toMatchObject({ok:false});expect(f.sqlCalls).toEqual(before);});
 it('has receipt-free noop, atomic Inbox promotion, exact cold receipt and private diagnostic',async()=>{const f=fixture(),ids=await f.boot(),opening=await f.editor(ids.id);const noop={id:ids.id,requestId:WRITE,taskRevision:opening.value.taskRevision,source:'row',focused:false};const before=f.database.query('SELECT * FROM tasks ORDER BY id').all();expect(await f.call('rowTaskFocusPrepare',noop)).toEqual({ok:true,value:{kind:'noop',result:{id:ids.id,focused:false}}});expect(f.database.query('SELECT * FROM tasks ORDER BY id').all()).toEqual(before);expect(f.database.query('SELECT * FROM native_request_receipts').all()).toEqual([]);const e=await prepare(f,ids);expect(f.writes).toEqual([]);expect(await f.call('rowTaskFocusValidate',e)).toEqual({ok:true,value:{id:ids.id,focused:true}});expect(await f.call('rowTaskFocusCommit',e)).toEqual({ok:true,value:{id:ids.id,focused:true}});expect(f.database.query('SELECT status,isFocusedToday,rev FROM tasks WHERE id=?').get(ids.id)).toEqual({status:'next',isFocusedToday:1,rev:2});await f.call('logShare');const diagnostics=f.log();f.database.query('UPDATE tasks SET title=?,status=? WHERE id=?').run('Later','reference',ids.id);const cold=fixture('ios',undefined,f.database);await cold.boot(false,true);const writes=[...cold.writes],later=cold.database.query('SELECT * FROM tasks ORDER BY id').all();expect(await cold.call('rowTaskFocusOutcome',e)).toEqual({ok:true,value:{id:ids.id,focused:true}});expect(await cold.call('rowTaskFocusCommit',e)).toEqual({ok:true,value:{id:ids.id,focused:true}});expect(cold.writes).toEqual(writes);expect(cold.database.query('SELECT * FROM tasks ORDER BY id').all()).toEqual(later);expect(cold.database.query<{method:string},[]>('SELECT method FROM native_request_receipts').all().map(row=>row.method.split(':')[0])).toEqual(['rowTaskFocus']);const entries=diagnostics.trim().split('\n').map(line=>JSON.parse(line)).filter(e=>e.context?.releaseCheck==='v1.3.8/ios-row-focus');expect(entries).toHaveLength(1);expect(entries[0].context).toEqual({releaseCheck:'v1.3.8/ios-row-focus',outcome:'focused',category:'storage'});expect(JSON.stringify(entries)).not.toContain('PRIVATE');expect(JSON.stringify(entries)).not.toContain(ids.id);});
 it.each([undefined,'journaled'] as const)('refuses all five exports before SQL on Android %s',async bootMode=>{const ios=fixture(),e=await prepare(ios,await ios.boot()),android=fixture('android',bootMode);await android.boot();const before=[...android.sqlCalls];for(const [name,input] of [['taskRowSwipeActions',flags],...['Prepare','Validate','Commit','Outcome'].map(suffix=>['rowTaskFocus'+suffix,suffix==='Prepare'?e.request:e])] as const){expect(await android.call(name,input)).toEqual({ok:false,error:expect.stringContaining('requires iOS')});expect(android.sqlCalls).toEqual(before);}});
});
