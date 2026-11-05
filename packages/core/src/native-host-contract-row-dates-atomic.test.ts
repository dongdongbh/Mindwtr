import {afterEach,describe,it,expect,vi} from 'vitest';
import {openSqliteHost,value} from './screen-parity.replay';
import {flushPendingSave,resetForTests,useTaskStore} from './store';
import {loadNativeRequestReceipts} from './native-request-receipts';
import type {Task,AppData} from './types';
import type {NativeRowTaskDatesEnvelope,NativeRowTaskDatesRequest} from './native-host-contract-task-checklist';
const NOW='2026-11-02T12:00:00.000Z',OLD='2026-10-01T12:00:00.000Z',ID='row-dates-atomic',UUID='00000000-0000-4000-8000-000000004101';
const seed=():Partial<AppData>=>({tasks:['row-dates-atomic','sibling'].map((id):Task=>({id,title:id,status:'next',tags:[],contexts:[],createdAt:OLD,updatedAt:OLD,rev:3,revBy:'device'})),projects:[],sections:[],areas:[],people:[],settings:{deviceId:'device',analyticsProfileId:UUID}});
type Db=Awaited<ReturnType<typeof openSqliteHost>>;
const raw=async(db:Db)=>Object.fromEntries(await Promise.all(['tasks','projects','sections','areas','people','settings','saved_filters','schema_migrations','calendar_sync'].map(async table=>[table,await db.sql(`SELECT rowid AS _rowid,* FROM ${table} ORDER BY rowid`)])));
const clock=()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(NOW));};
const prepare=async(db:Db):Promise<NativeRowTaskDatesEnvelope>=>{const model=value(db.host.getTaskEditorModel({id:ID})),edited=value(db.host.editTaskDraft({id:ID,draft:model.draft,edit:{type:'pickDate',field:'dueDate',date:'2026-11-05'}}));
    const request=JSON.parse(JSON.stringify({id:ID,requestId:UUID,taskRevision:model.taskRevision,source:'row',draft:edited.draft,scheduleBase:model.scheduleBase})) as NativeRowTaskDatesRequest;
    const result=value(await db.host.prepareRowTaskDates(request));if(result.kind!=='prepared')throw new Error('Expected changed Dates');return{request,prepared:result.prepared};};
afterEach(async()=>{await flushPendingSave();resetForTests();vi.restoreAllMocks();vi.useRealTimers();vi.unstubAllEnvs();});
describe('row Dates exact owned receipts and raw write refusal',()=>{
    it.each(['warm repeated failed flush','successful explicit flush','cold'] as const)('retains exact failed-COMMIT bytes through %s and saved receipt before later edits',async mode=>{
        clock();let fail=false;const db=await openSqliteHost(seed(),c=>({...c,run:async(sql,args)=>{if(fail&&sql==='COMMIT')throw new Error('Injected Dates COMMIT');return c.run(sql,args);}}));
        try{const e=await prepare(db),bytes=JSON.stringify(e),before=await raw(db);fail=true;expect(await db.host.commitPreparedRowTaskDates(e)).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});expect(await raw(db)).toEqual(before);expect(await db.receiptIds()).toEqual([]);
            if(mode==='warm repeated failed flush'){await useTaskStore.getState().persistSnapshot();await expect(flushPendingSave()).rejects.toThrow();expect(await raw(db)).toEqual(before);expect(await db.receiptIds()).toEqual([]);}
            fail=false;if(mode==='successful explicit flush'){await useTaskStore.getState().persistSnapshot();await flushPendingSave();expect(await db.receiptIds()).toEqual([UUID]);expect(value(db.host.rowTaskDatesOutcome(e))).toEqual({id:ID});}
            if(mode==='cold')await db.restart(undefined,{recoveryLoad:true});value(await db.host.commitPreparedRowTaskDates(e));expect(JSON.stringify(e)).toBe(bytes);expect(await db.receiptIds()).toEqual([UUID]);
            const unused=JSON.parse(bytes) as NativeRowTaskDatesEnvelope,fresh='00000000-0000-4000-8000-000000004102';unused.request.requestId=fresh;unused.prepared.request.requestId=fresh;unused.prepared.checklist.request.requestId=fresh;expect(value(db.host.rowTaskDatesOutcome(unused))).toBeNull();expect(await db.host.commitPreparedRowTaskDates(unused)).toMatchObject({ok:false,error:{code:'STALE_REVISION'}});
            await db.client().run('UPDATE tasks SET title=?,status=? WHERE id=?',['Later edit','reference',ID]);await db.restart(undefined,{recoveryLoad:true});const later=await raw(db);expect(value(db.host.rowTaskDatesOutcome(e))).toEqual({id:ID});value(await db.host.commitPreparedRowTaskDates(e));expect(await raw(db)).toEqual(later);
        }finally{fail=false;await db.close();}
    },30000);
    it.each(['new reference','in-place edit'] as const)('refuses exact retry after unrelated %s instead of overwriting current work',async change=>{
        clock();let fail=false;const db=await openSqliteHost(seed(),c=>({...c,run:async(sql,args)=>{if(fail&&sql==='COMMIT')throw new Error('Injected Dates COMMIT');return c.run(sql,args);}}));
        try{const e=await prepare(db);fail=true;expect(await db.host.commitPreparedRowTaskDates(e)).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});const before=await raw(db);
            if(change==='new reference')useTaskStore.setState({_allPeople:[{id:'later',name:'Later',createdAt:NOW,updatedAt:NOW}]});else useTaskStore.getState()._allTasks.find(row=>row.id==='sibling')!.title='Later in-place edit';
            fail=false;expect(await db.host.commitPreparedRowTaskDates(e)).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});expect(await raw(db)).toEqual(before);expect(await db.receiptIds()).toEqual([]);
        }finally{fail=false;await db.close();}
    },30000);
    it('does not poison a request or mint a null receipt after a pre-landing saved-read failure',async()=>{
        clock();let fail=false,hits=0;const db=await openSqliteHost(seed(),c=>({...c,all:async(sql,args)=>{if(fail&&sql.includes('FROM tasks')){hits++;throw new Error('Injected saved read');}return c.all(sql,args);}}));
        try{const e=await prepare(db),before=await raw(db);fail=true;expect(await db.host.commitPreparedRowTaskDates(e)).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});fail=false;expect(hits).toBeGreaterThan(0);await useTaskStore.getState().persistSnapshot();await flushPendingSave();expect(await raw(db)).toEqual(before);expect(await db.receiptIds()).toEqual([]);value(await db.host.commitPreparedRowTaskDates(e));
        }finally{fail=false;await db.close();}
    });
    it('keeps generic/old row proof grammars closed and requires new durable registration',async()=>{
        clock();const db=await openSqliteHost(seed());try{const e=await prepare(db),before=await raw(db);expect(db.host.validatePreparedTaskChecklistWrite({request:e.prepared.checklist.request,prepared:e.prepared.checklist} as never)).toMatchObject({ok:false});expect(db.host.validatePreparedRowTaskDestination(e as never)).toMatchObject({ok:false});
            for(const mutate of [(x:NativeRowTaskDatesEnvelope)=>{x.prepared.checklist.request.patch.status='done';},(x:NativeRowTaskDatesEnvelope)=>{x.prepared.checklist.witness.direct.dueDate='2030-01-01';},(x:NativeRowTaskDatesEnvelope)=>{x.prepared.result.id='other';}]){const forged=JSON.parse(JSON.stringify(e));mutate(forged);expect(db.host.validatePreparedRowTaskDates(forged)).toMatchObject({ok:false});expect(await db.host.commitPreparedRowTaskDates(forged)).toMatchObject({ok:false});}
            await loadNativeRequestReceipts(db.client(),{durableCommands:['rowTaskDestination']});expect(db.host.validatePreparedRowTaskDates(e).ok).toBe(true);expect(await db.host.prepareRowTaskDates(e.request)).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});expect(await db.host.commitPreparedRowTaskDates(e)).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});expect(db.host.rowTaskDatesOutcome(e)).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});expect(await raw(db)).toEqual(before);expect(await db.receiptIds()).toEqual([]);
        }finally{await db.close();}
    });
    it('binds exact raw source and refuses an oversized complete proof before any write',async()=>{
        clock();const db=await openSqliteHost(seed());try{const e=await prepare(db);await db.client().run('UPDATE tasks SET description=? WHERE id=?',['Same-revision concurrent memo',ID]);const before=await raw(db);expect(await db.host.commitPreparedRowTaskDates(e)).toMatchObject({ok:false,error:{code:'STALE_REVISION'}});expect(await raw(db)).toEqual(before);expect(await db.receiptIds()).toEqual([]);
        }finally{await db.close();}
        const huge=seed();huge.tasks![0].description='x'.repeat(350_000);const large=await openSqliteHost(huge);try{const opening=value(large.host.getTaskEditorModel({id:ID})),edited=value(large.host.editTaskDraft({id:ID,draft:opening.draft,edit:{type:'date',field:'dueDate',value:'2026-11-05'}}));const input=JSON.parse(JSON.stringify({id:ID,requestId:UUID,taskRevision:opening.taskRevision,source:'row',draft:edited.draft,scheduleBase:opening.scheduleBase}));expect(new TextEncoder().encode(JSON.stringify(input)).length).toBeLessThan(2_100_000);const before=await raw(large);expect(await large.host.prepareRowTaskDates(input)).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});expect(await raw(large)).toEqual(before);expect(await large.receiptIds()).toEqual([]);
        }finally{await large.close();}
    });
});
