import {afterEach,describe,it,expect,vi} from 'vitest';
import {openSqliteHost as openHost,value} from './screen-parity.replay';
import {flushPendingSave,resetForTests,useTaskStore} from './store';
import {taskRevisionOf,loadNativeRequestReceipts} from './native-request-receipts';
import type {Task,AppData} from './types';
const open:typeof openHost=(seed,wrap,bindings)=>openHost(seed,wrap,bindings,{rejectConcurrentWrites:true});
const NOW='2026-11-02T12:00:00.000Z',OLD='2026-10-01T12:00:00.000Z',MOVE='00000000-0000-4000-8000-000000003101',UNDO='00000000-0000-4000-8000-000000003102';
const seed=():Partial<AppData>=>({tasks:['source','target','sibling'].map((id):Task=>({id,title:id,status:id==='source'?'inbox':'next',tags:[],contexts:[],createdAt:OLD,updatedAt:OLD,rev:3,revBy:'device'})),projects:[],sections:[],areas:[],settings:{deviceId:'device',analyticsProfileId:MOVE}});
type Db=Awaited<ReturnType<typeof open>>;
const raw=async(db:Db)=>Object.fromEntries(await Promise.all(['tasks','projects','sections','areas','people','settings','saved_filters','schema_migrations','calendar_sync'].map(async table=>[table,await db.sql(`SELECT rowid AS _rowid,* FROM ${table} ORDER BY rowid`)])));
const clock=()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(NOW));};
const prepare=async(db:Db)=>{const request={requestId:MOVE,id:'source',taskRevision:taskRevisionOf(useTaskStore.getState()._tasksById.get('source')!),targetId:'target',targetRevision:taskRevisionOf(useTaskStore.getState()._tasksById.get('target')!)};return{request,prepared:value(await db.host.prepareTaskChecklistMove(request)).prepared};};
const undo=async(db:Db,move:Awaited<ReturnType<typeof prepare>>)=>{const request={requestId:UNDO,moveRequestId:MOVE};return{request,prepared:value(await db.host.prepareTaskChecklistMoveUndo({request,move})).prepared};};
afterEach(async()=>{await flushPendingSave();resetForTests();vi.restoreAllMocks();vi.useRealTimers();vi.unstubAllEnvs();});
describe('checklist move transaction prerequisites and exact owed saves',()=>{
    it.each(['missing','replaced','query-error'] as const)('requires durable original receipt through failed Undo + %s + explicit flushing, with own receipt precedence',async drift=>{
        clock();let fail=false,readFail=false,proofReads=0;const db=await open(seed(),c=>({...c,run:async(sql,args)=>{if(fail&&sql==='COMMIT')throw new Error('Injected checklist Undo COMMIT');return c.run(sql,args);},all:async(sql,args)=>{if(sql.includes('FROM native_request_receipts WHERE request_id')){proofReads++;if(readFail)throw new Error('Injected origin query');}return c.all(sql,args);}}));
        try{const move=await prepare(db);value(await db.host.commitPreparedTaskChecklistMove(move));const e=await undo(db,move),[receipt]=await db.sql<{method:string;reply:string;saved_at:string}>('SELECT * FROM native_request_receipts WHERE request_id=?',[MOVE]);
            fail=true;expect(await db.host.commitPreparedTaskChecklistMoveUndo(e)).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});fail=false;
            if(drift==='missing')await db.client().run('DELETE FROM native_request_receipts WHERE request_id=?',[MOVE]);else if(drift==='replaced')await db.client().run('UPDATE native_request_receipts SET reply=? WHERE request_id=?',[JSON.stringify({id:'other'}),MOVE]);
            const before=await raw(db),reads=proofReads;readFail=drift==='query-error';await useTaskStore.getState().persistSnapshot();await expect(flushPendingSave()).rejects.toThrow();readFail=false;expect(proofReads).toBeGreaterThan(reads);expect(await raw(db)).toEqual(before);expect(await db.receiptIds()).not.toContain(UNDO);
            await db.client().run('INSERT INTO native_request_receipts(request_id,method,reply,saved_at) VALUES(?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET method=excluded.method,reply=excluded.reply,saved_at=excluded.saved_at',[MOVE,receipt.method,receipt.reply,receipt.saved_at]);
            await db.restart(undefined,{recoveryLoad:true});value(await db.host.commitPreparedTaskChecklistMoveUndo(e));await db.client().run('DELETE FROM native_request_receipts WHERE request_id=?',[MOVE]);await db.client().run('UPDATE tasks SET title=? WHERE id=?',['Later source edit','source']);await db.restart(undefined,{recoveryLoad:true});const later=await raw(db);
            expect(value(db.host.taskChecklistMoveUndoOutcome(e))).toEqual({id:'source'});value(await db.host.commitPreparedTaskChecklistMoveUndo(e));expect(await raw(db)).toEqual(later);
        }finally{fail=false;readFail=false;await db.close();}
    },30000);
    it.each(['missing','replaced','query-error'] as const)('rechecks the original receipt inside Undo transaction after %s race',async drift=>{
        clock();let race=false,seen=false,inTransaction=false,readFail=false,transactionReads=0;const db=await open(seed(),c=>({...c,all:async(sql,args)=>{const proof=sql.includes('FROM native_request_receipts WHERE request_id');if(proof&&inTransaction)transactionReads++;if(proof&&readFail)throw new Error('Injected origin read');const result=await c.all(sql,args);if(proof&&race)seen=true;return result;},run:async(sql,args)=>{if(race&&seen&&sql==='BEGIN IMMEDIATE'){race=false;if(drift==='missing')await c.run('DELETE FROM native_request_receipts WHERE request_id=?',[MOVE]);else if(drift==='replaced')await c.run('UPDATE native_request_receipts SET reply=? WHERE request_id=?',[JSON.stringify({id:'other'}),MOVE]);else readFail=true;}const result=await c.run(sql,args);if(sql==='BEGIN IMMEDIATE')inTransaction=true;else if(sql==='COMMIT'||sql==='ROLLBACK')inTransaction=false;return result;}}));
        try{const move=await prepare(db);value(await db.host.commitPreparedTaskChecklistMove(move));const e=await undo(db,move),[receipt]=await db.sql<{method:string;reply:string;saved_at:string}>('SELECT * FROM native_request_receipts WHERE request_id=?',[MOVE]),before=await raw(db);transactionReads=0;race=true;
            expect(await db.host.commitPreparedTaskChecklistMoveUndo(e)).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});readFail=false;expect(race).toBe(false);expect(seen).toBe(true);expect(transactionReads).toBeGreaterThan(0);expect(inTransaction).toBe(false);expect(await raw(db)).toEqual(before);expect(await db.receiptIds()).not.toContain(UNDO);
            await db.client().run('INSERT INTO native_request_receipts(request_id,method,reply,saved_at) VALUES(?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET method=excluded.method,reply=excluded.reply,saved_at=excluded.saved_at',[MOVE,receipt.method,receipt.reply,receipt.saved_at]);value(await db.host.commitPreparedTaskChecklistMoveUndo(e));
        }finally{race=false;readFail=false;await db.close();}
    },30000);
    it('retains exact warm/cold bytes after repeated failed COMMIT in both directions',async()=>{
        clock();let fail=false;const db=await open(seed(),c=>({...c,run:async(sql,args)=>{if(fail&&sql==='COMMIT')throw new Error('Injected Move/Undo COMMIT');return c.run(sql,args);}}));
        try{const move=JSON.parse(JSON.stringify(await prepare(db))),bytes=JSON.stringify(move),before=await raw(db);
            for(let i=0;i<2;i++){fail=true;expect(await db.host.commitPreparedTaskChecklistMove(move)).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});fail=false;expect(await raw(db)).toEqual(before);expect(await db.receiptIds()).toEqual([]);}await db.restart(undefined,{recoveryLoad:true});value(await db.host.commitPreparedTaskChecklistMove(move));expect(JSON.stringify(move)).toBe(bytes);
            const e=JSON.parse(JSON.stringify(await undo(db,move))),undoBytes=JSON.stringify(e),moved=await raw(db);for(let i=0;i<2;i++){fail=true;expect(await db.host.commitPreparedTaskChecklistMoveUndo(e)).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});fail=false;expect(await raw(db)).toEqual(moved);expect(await db.receiptIds()).toEqual([MOVE]);}await db.restart(undefined,{recoveryLoad:true});value(await db.host.commitPreparedTaskChecklistMoveUndo(e));expect(JSON.stringify(e)).toBe(undoBytes);
        }finally{fail=false;await db.close();}
    },30000);
    it.each(['Move metadata','Undo origin'] as const)('does not retain a receipt or poison exact retry after pre-landing %s read failure',async mode=>{
        clock();let readFail=false,hits=0;const db=await open(seed(),c=>({...c,all:async(sql,args)=>{const selected=mode==='Move metadata'?sql==='PRAGMA table_info(tasks)':sql.includes('FROM native_request_receipts WHERE request_id');if(readFail&&selected){hits++;throw new Error('Injected pre-landing read');}return c.all(sql,args);}}));
        try{const move=await prepare(db);if(mode==='Undo origin')value(await db.host.commitPreparedTaskChecklistMove(move));const e=mode==='Undo origin'?await undo(db,move):move,before=await raw(db),ids=await db.receiptIds();
            readFail=true;const failed=mode==='Undo origin'?await db.host.commitPreparedTaskChecklistMoveUndo(e as Awaited<ReturnType<typeof undo>>):await db.host.commitPreparedTaskChecklistMove(move);readFail=false;
            expect(failed).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});expect(hits).toBeGreaterThan(0);expect(await raw(db)).toEqual(before);expect(await db.receiptIds()).toEqual(ids);
            await useTaskStore.getState().persistSnapshot();await flushPendingSave();expect(await raw(db)).toEqual(before);expect(await db.receiptIds()).toEqual(ids);
            value(mode==='Undo origin'?await db.host.commitPreparedTaskChecklistMoveUndo(e as Awaited<ReturnType<typeof undo>>):await db.host.commitPreparedTaskChecklistMove(move));expect(await db.receiptIds()).toContain(mode==='Undo origin'?UNDO:MOVE);
        }finally{readFail=false;await db.close();}
    },30000);
    it('requires both durable families and rejects forged effect before writes',async()=>{
        clock();const db=await open(seed());try{const e=await prepare(db),before=await raw(db),forged=structuredClone(e);forged.prepared.effect.tasks[0].after.title='Forged';expect(db.host.validatePreparedTaskChecklistMove(forged)).toMatchObject({ok:false});expect(await db.host.commitPreparedTaskChecklistMove(forged)).toMatchObject({ok:false});
            await loadNativeRequestReceipts(db.client(),{durableCommands:['taskChecklistMove']});expect(db.host.validatePreparedTaskChecklistMove(e).ok).toBe(true);expect(await db.host.commitPreparedTaskChecklistMove(e)).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});expect(db.host.taskChecklistMoveOutcome(e)).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});expect(await raw(db)).toEqual(before);expect(await db.receiptIds()).toEqual([]);
        }finally{await db.close();}
    });
});
