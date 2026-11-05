import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqliteHost as openHost, value } from './screen-parity.replay';
const openSqliteHost: typeof openHost = (seed, wrap, bindings) => openHost(seed, wrap, bindings, { rejectConcurrentWrites: true });
import { getStorageAdapter, flushPendingSave, resetForTests, useTaskStore } from './store';
import { mutateTasks, sanitizeRestoredTaskContainerReferences } from './store-tasks';
import { taskRevisionOf } from './native-request-receipts';
import { canMoveTaskToChecklist, checklistItemIdForMovedTask, isChecklistMoveTarget } from './task-checklist-move';
import { resolveQuickCaptureDefaultAreaId } from './quick-capture-model';
import type { AppData, Task } from './types';
import type { NativeTaskChecklistMoveEnvelope } from './native-host-contract-task-checklist-move';
const NOW='2026-11-02T12:00:00.000Z',OLD='2026-10-01T12:00:00.000Z',MOVE='00000000-0000-4000-8000-000000003001',UNDO='00000000-0000-4000-8000-000000003002';
const sourceId='源-e\u0301',targetId='target';
const task=(id:string,patch:Partial<Task>={}):Task=>({id,title:id===sourceId?'  Eggs  ':id,status:id===sourceId?'inbox':'next',tags:[],contexts:[],createdAt:OLD,updatedAt:OLD,rev:3,revBy:'device',...patch});
const seed=():Partial<AppData>=>({tasks:[task(sourceId),task(targetId,{checklist:[{id:'milk',title:'Milk',isCompleted:true}]}),task('unrelated')],projects:[],sections:[],areas:[],people:[],settings:{deviceId:'device',analyticsProfileId:MOVE}});
type Db=Awaited<ReturnType<typeof openSqliteHost>>;
const clock=()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(NOW));};
const clone=<T,>(v:T):T=>JSON.parse(JSON.stringify(v));
const rows=()=>{const s=useTaskStore.getState();return clone({tasks:s._allTasks,projects:s._allProjects,sections:s._allSections,areas:s._allAreas,people:s._allPeople,settings:s.settings});};
const raw=async(db:Db)=>Object.fromEntries(await Promise.all(['tasks','projects','sections','areas','people','settings','saved_filters','schema_migrations','calendar_sync'].map(async table=>[table,await db.sql(`SELECT rowid AS _rowid,* FROM ${table} ORDER BY rowid`)])));
const request=()=>({requestId:MOVE,id:sourceId,taskRevision:taskRevisionOf(useTaskStore.getState()._tasksById.get(sourceId)!),targetId,targetRevision:taskRevisionOf(useTaskStore.getState()._tasksById.get(targetId)!)});
const prepare=async(db:Db)=>{const input=request();return{request:input,prepared:value(await db.host.prepareTaskChecklistMove(input)).prepared};};
const prepareUndo=async(db:Db,move:NativeTaskChecklistMoveEnvelope)=>{const input={requestId:UNDO,moveRequestId:MOVE};return{request:input,prepared:value(await db.host.prepareTaskChecklistMoveUndo({request:input,move})).prepared};};
// The donor's actual mutateTasks select/buildUpdates path, with only its save
// callback captured so the same real SQLite adapter writes the RN snapshot.
const rn=async(isUndo:boolean)=>{
    const itemId=checklistItemIdForMovedTask(sourceId),snapshots:AppData[]=[];
    const result=await mutateTasks({set:useTaskStore.setState,debouncedSave:data=>{snapshots.push(data);}}, {
        selectTasks:state=>{const source=state._tasksById.get(sourceId),target=state._tasksById.get(targetId);
            if(isUndo)return[...(target&&target.id!==sourceId&&target.checklist?.some(item=>item.id===itemId)?[target]:[]),...(source?.deletedAt&&!source.purgedAt?[source]:[])];
            if(!source||!target||!isChecklistMoveTarget(target,sourceId)||!canMoveTaskToChecklist(source,resolveQuickCaptureDefaultAreaId(state.settings,state.areas)))return[];
            return target.checklist?.some(item=>item.id===itemId)?[source]:[target,source];},
        buildUpdates:(row,{now,state})=>row.id===sourceId?isUndo?{deletedAt:undefined,...sanitizeRestoredTaskContainerReferences(row,state)}:{deletedAt:now}
            :isUndo?{checklist:(row.checklist??[]).filter(item=>item.id!==itemId).length?(row.checklist??[]).filter(item=>item.id!==itemId):undefined}
                :{checklist:[...(row.checklist??[]),{id:itemId,title:state._tasksById.get(sourceId)!.title.trim(),isCompleted:false}]},missingMessage:'Task not found'});
    for(const data of snapshots)await getStorageAdapter().saveData(data);return result;
};
afterEach(async()=>{await flushPendingSave();resetForTests();vi.restoreAllMocks();vi.useRealTimers();});
describe('native Add to checklist and current-row Undo',()=>{
    it('matches donor mutateTasks complete state and nine SQL domains for Move and Undo',async()=>{
        clock();const donor=await openSqliteHost(seed());let moved,moveRaw,undone,undoRaw;
        try{expect((await rn(false)).success).toBe(true);moved=rows();moveRaw=await raw(donor);vi.setSystemTime(new Date('2026-11-02T12:01:00.000Z'));expect((await rn(true)).success).toBe(true);undone=rows();undoRaw=await raw(donor);}finally{await donor.close();}
        vi.setSystemTime(new Date(NOW));const db=await openSqliteHost(seed());
        try{const move=await prepare(db);expect(Object.keys(move.prepared).sort()).toEqual(['version','kind','request','scope','rawBefore','effect','deviceIdBefore','deviceIdToInitialize','updateAt','clock','result'].sort());
            expect(value(db.host.validatePreparedTaskChecklistMove(move))).toEqual({id:targetId});expect(value(await db.host.commitPreparedTaskChecklistMove(move))).toEqual({id:targetId});expect(rows()).toEqual(moved);expect(await raw(db)).toEqual(moveRaw);
            vi.setSystemTime(new Date('2026-11-02T12:01:00.000Z'));const undo=await prepareUndo(db,move);expect(value(await db.host.commitPreparedTaskChecklistMoveUndo(undo))).toEqual({id:sourceId});expect(rows()).toEqual(undone);expect(await raw(db)).toEqual(undoRaw);
        }finally{await db.close();}
    });
    it.each([null,0,30] as const)('guards due-reminder metadata %s stored in its column',async lead=>{
        clock();const db=await openSqliteHost(seed());
        try{await db.client().run('UPDATE tasks SET dueReminderLeadMinutes=? WHERE id=?',[lead,sourceId]);const before=await raw(db);
            if(lead===30){expect(await db.host.prepareTaskChecklistMove(request())).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});expect(await raw(db)).toEqual(before);return;}
            const move=await prepare(db);value(await db.host.commitPreparedTaskChecklistMove(move));expect((await db.sql<{dueReminderLeadMinutes:number|null}>('SELECT dueReminderLeadMinutes FROM tasks WHERE id=?',[sourceId]))[0].dueReminderLeadMinutes).toBe(lead);
            await db.client().run('UPDATE tasks SET dueReminderLeadMinutes=? WHERE id=?',[45,sourceId]);const undo=await prepareUndo(db,move);value(await db.host.commitPreparedTaskChecklistMoveUndo(undo));
            expect((await db.sql<{dueReminderLeadMinutes:number}>('SELECT dueReminderLeadMinutes FROM tasks WHERE id=?',[sourceId]))[0].dueReminderLeadMinutes).toBe(45);
        }finally{await db.close();}
    });    it('returns exact paged/query/label shape with checklist-first ordering and stale revision refusal',async()=>{
        clock();const db=await openSqliteHost(seed());try{const ref=request(),input={id:sourceId,taskRevision:ref.taskRevision,query:'',offset:0,limit:1,revision:null};
            const before=await raw(db),first=value(await db.host.getTaskChecklistMoveOptions(input));expect(Object.keys(first).sort()).toEqual(['title','searchPlaceholder','cancelLabel','noMatchesLabel','addedMessage','undoLabel','taskId','taskRevision','revision','query','offset','total','hasMore','items'].sort());
            expect(first).toMatchObject({taskId:sourceId,query:'',offset:0,total:2,hasMore:true,addedMessage:'Added to checklist',undoLabel:'Undo',items:[{id:targetId,completedCount:1,totalCount:1}]});
            const second=value(await db.host.getTaskChecklistMoveOptions({...input,offset:1,revision:first.revision}));expect(second.items.map(row=>row.id)).toEqual(['unrelated']);expect(second.hasMore).toBe(false);
            const query='  TARGET  ';expect(value(await db.host.getTaskChecklistMoveOptions({...input,query}))).toMatchObject({query,total:1});
            expect(await db.host.getTaskChecklistMoveOptions({...input,query,revision:first.revision})).toMatchObject({ok:false,error:{code:'STALE_REVISION'}});
            await db.client().run('UPDATE tasks SET title=? WHERE id=?',['Renamed',targetId]);const saved=await raw(db);expect(await db.host.getTaskChecklistMoveOptions({...input,offset:1,revision:first.revision})).toMatchObject({ok:false,error:{code:'STALE_REVISION'}});expect(await raw(db)).toEqual(saved);expect(await db.receiptIds()).toEqual([]);expect(before.tasks).toHaveLength(3);
        }finally{await db.close();}
    });
    it('classifies pathological derived title bytes and failed persistence as SAVE_FAILED, not ineligible source',async()=>{
        clock();const fixture=seed();fixture.tasks!.push(task('huge',{title:'x'.repeat(2_100_001)}));const db=await openSqliteHost(fixture);
        try{let r=request();const input={id:sourceId,taskRevision:r.taskRevision,query:'',offset:0,limit:100,revision:null},before=await raw(db);
            expect(await db.host.getTaskChecklistMoveOptions(input)).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});expect(await raw(db)).toEqual(before);
            await db.client().run('DELETE FROM tasks WHERE id=?',['huge']);await db.restart(undefined,{recoveryLoad:true});useTaskStore.setState({persistenceFailure:{message:'Owed failed persistence',failedAt:NOW,retrying:false}});r=request();const pending=await raw(db);
            expect(await db.host.getTaskChecklistMoveOptions({...input,taskRevision:r.taskRevision})).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});expect(await raw(db)).toEqual(pending);useTaskStore.setState({persistenceFailure:null});
        }finally{await db.close();}
    });
    it.each(['archived','deleted'] as const)('keeps canonical open-target eligibility under a %s owning Project',async kind=>{
        clock();const fixture=seed();fixture.projects=[{id:'parent',title:'Parent',status:'active',tagIds:[],order:0,color:'#94a3b8',createdAt:OLD,updatedAt:OLD}];fixture.tasks![1].projectId='parent';
        const db=await openSqliteHost(fixture);try{if(kind==='archived')await db.client().run('UPDATE projects SET status=? WHERE id=?',['archived','parent']);else await db.client().run('UPDATE projects SET deletedAt=? WHERE id=?',[OLD,'parent']);
            useTaskStore.setState(state=>({_allProjects:state._allProjects.map(row=>({...row,...(kind==='archived'?{status:'archived' as const}:{deletedAt:OLD})}))}));
            const e=await prepare(db);value(await db.host.commitPreparedTaskChecklistMove(e));expect(useTaskStore.getState()._tasksById.get(targetId)?.projectId).toBe('parent');expect(useTaskStore.getState()._tasksById.get(targetId)?.checklist).toHaveLength(2);}finally{await db.close();}
    });
    it('deletes only the source when its deterministic item already exists',async()=>{
        clock();const fixture=seed();fixture.tasks![1].checklist!.push({id:checklistItemIdForMovedTask(sourceId),title:'Existing item edit',isCompleted:true});const db=await openSqliteHost(fixture);
        try{const e=await prepare(db),before=await raw(db);expect(e.prepared.effect.tasks.map(row=>row.before.id)).toEqual([sourceId]);value(await db.host.commitPreparedTaskChecklistMove(e));const after=await raw(db);expect(after.tasks.find((row:Record<string,unknown>)=>row.id===targetId)).toEqual(before.tasks.find((row:Record<string,unknown>)=>row.id===targetId));}finally{await db.close();}
    });
    it.each(['missing-source','purged-source','source-already-restored','target-missing','archived-target','deleted-target'] as const)('Undo uses current rows and preserves later edits: %s',async kind=>{
        clock();const db=await openSqliteHost(seed());try{const move=await prepare(db);value(await db.host.commitPreparedTaskChecklistMove(move));
            if(kind==='missing-source')await db.client().run('DELETE FROM tasks WHERE id=?',[sourceId]);
            if(kind==='purged-source')await db.client().run('UPDATE tasks SET purgedAt=? WHERE id=?',[NOW,sourceId]);
            if(kind==='source-already-restored')await db.client().run('UPDATE tasks SET deletedAt=NULL,title=? WHERE id=?',['Source later edit',sourceId]);
            if(kind==='target-missing')await db.client().run('DELETE FROM tasks WHERE id=?',[targetId]);
            if(kind==='archived-target')await db.client().run('UPDATE tasks SET status=?,completedAt=?,archivedAt=? WHERE id=?',['archived',OLD,OLD,targetId]);
            if(kind==='deleted-target')await db.client().run('UPDATE tasks SET deletedAt=? WHERE id=?',[OLD,targetId]);
            if(kind!=='target-missing'){const target=(await db.sql<{checklist:string}>('SELECT checklist FROM tasks WHERE id=?',[targetId]))[0];const list=JSON.parse(target.checklist);list.push({id:'later',title:'Later edit',isCompleted:true});await db.client().run('UPDATE tasks SET checklist=?,description=? WHERE id=?',[JSON.stringify(list),'Keep later memo',targetId]);}
            await db.restart(undefined,{recoveryLoad:true});const undo=await prepareUndo(db,move);value(await db.host.commitPreparedTaskChecklistMoveUndo(undo));
            const target=useTaskStore.getState()._tasksById.get(targetId),source=useTaskStore.getState()._tasksById.get(sourceId);
            if(target){expect(target.checklist?.map(row=>row.id)).toEqual(['milk','later']);expect(target.description).toBe('Keep later memo');if(kind==='archived-target')expect(target.status).toBe('archived');if(kind==='deleted-target')expect(target.deletedAt).toBe(OLD);}
            if(kind==='missing-source')expect(source).toBeUndefined();else if(kind==='purged-source')expect(source?.purgedAt).toBe(NOW);else{expect(source?.deletedAt).toBeUndefined();if(kind==='source-already-restored')expect(source?.title).toBe('Source later edit');}
        }finally{await db.close();}
    });
    it.each(['source','target'] as const)('refuses a stale %s revision and a changed prepared raw row',async which=>{
        clock();const db=await openSqliteHost(seed());try{const input=request(),bad={...input,[which==='source'?'taskRevision':'targetRevision']:'old'},before=await raw(db);
            expect(await db.host.prepareTaskChecklistMove(bad)).toMatchObject({ok:false,error:{code:'STALE_REVISION'}});expect(await raw(db)).toEqual(before);
            const e=await prepare(db);await db.client().run('UPDATE tasks SET description=? WHERE id=?',['Concurrent',which==='source'?sourceId:targetId]);const changed=await raw(db);expect(await db.host.commitPreparedTaskChecklistMove(e)).toMatchObject({ok:false,error:{code:'STALE_REVISION'}});expect(await raw(db)).toEqual(changed);expect(await db.receiptIds()).toEqual([]);
        }finally{await db.close();}
    });
    it('refuses prospective Undo overflow at Prepare and Commit while the validated Move itself fits',async()=>{
        clock();const small=await openSqliteHost(seed());let move:NativeTaskChecklistMoveEnvelope;
        try{move=clone(await prepare(small));}finally{await small.close();}
        const description='x'.repeat(350_000),fixture=seed();fixture.tasks![1].description=description;const db=await openSqliteHost(fixture);
        try{move!.prepared.scope.target!.description=description;const pair=move!.prepared.effect.tasks.find(row=>row.before.id===targetId)!;pair.before.description=description;pair.after.description=description;move!.prepared.rawBefore.tasks.find(row=>row.id===targetId)!.before!.description=description;
            expect(new TextEncoder().encode(JSON.stringify(move!)).length).toBeLessThan(2_100_000);expect(db.host.validatePreparedTaskChecklistMove(move!).ok).toBe(true);const before=await raw(db);
            expect(await db.host.prepareTaskChecklistMove(request())).toMatchObject({ok:false,error:{code:'INVALID_INPUT',message:'Checklist move Undo journal would be too large'}});
            expect(await db.host.commitPreparedTaskChecklistMove(move!)).toMatchObject({ok:false,error:{code:'INVALID_INPUT',message:'Checklist move Undo journal would be too large'}});
            expect(await raw(db)).toEqual(before);expect(await db.receiptIds()).toEqual([]);
        }finally{await db.close();}
    });
    it('binds the capture default-area exception and refuses a later default change before writing',async()=>{
        clock();const fixture=seed();fixture.tasks![0].areaId='default';fixture.areas=[{id:'default',name:'Default',order:0,createdAt:OLD,updatedAt:OLD}];fixture.settings!.gtd={defaultAreaMode:'fixed',defaultAreaId:'default'};const db=await openSqliteHost(fixture);
        try{const e=await prepare(db);await db.client().run("UPDATE settings SET data=json_set(data,'$.gtd.defaultAreaMode','none') WHERE id=1");const before=await raw(db);
            expect(await db.host.commitPreparedTaskChecklistMove(e)).toMatchObject({ok:false,error:{code:'STALE_REVISION'}});expect(await raw(db)).toEqual(before);expect(await db.receiptIds()).toEqual([]);
        }finally{await db.close();}
    });
    it('freezes operated target publication through timezone-changing cold Move and Undo',async()=>{
        clock();vi.stubEnv('TZ','UTC');vi.setSystemTime(new Date('2026-11-02T02:00:00.000Z'));const fixture=seed();Object.assign(fixture.tasks![1],{status:'waiting',isFocusedToday:true,startTime:'2026-11-02T06:00:00.000Z'});const db=await openSqliteHost(fixture);
        try{const move=clone(await prepare(db)),bytes=JSON.stringify(move);vi.stubEnv('TZ','America/New_York');await db.restart(undefined,{recoveryLoad:true});value(await db.host.commitPreparedTaskChecklistMove(move));expect(useTaskStore.getState()._tasksById.get(targetId)?.isFocusedToday).toBe(true);expect(JSON.stringify(move)).toBe(bytes);
            vi.stubEnv('TZ','UTC');const undo=clone(await prepareUndo(db,move)),undoBytes=JSON.stringify(undo);vi.stubEnv('TZ','America/New_York');await db.restart(undefined,{recoveryLoad:true});value(await db.host.commitPreparedTaskChecklistMoveUndo(undo));expect(useTaskStore.getState()._tasksById.get(targetId)?.isFocusedToday).toBe(true);expect(JSON.stringify(undo)).toBe(undoBytes);
        }finally{await db.close();vi.unstubAllEnvs();}
    });
    it('requires the original durable receipt before Undo admission and freezes later current row edits',async()=>{
        clock();const db=await openSqliteHost(seed());try{const move=await prepare(db);value(await db.host.commitPreparedTaskChecklistMove(move));const e=await prepareUndo(db,move);
            await db.client().run('UPDATE tasks SET description=? WHERE id=?',['Target later edit',targetId]);let before=await raw(db);expect(await db.host.commitPreparedTaskChecklistMoveUndo(e)).toMatchObject({ok:false,error:{code:'STALE_REVISION'}});expect(await raw(db)).toEqual(before);
            await db.client().run('DELETE FROM native_request_receipts WHERE request_id=?',[MOVE]);before=await raw(db);expect(value(db.host.taskChecklistMoveOutcome(move))).toEqual({id:targetId});expect(await db.host.prepareTaskChecklistMoveUndo({request:{requestId:UNDO,moveRequestId:MOVE},move})).toMatchObject({ok:false,error:{code:'STALE_REVISION'}});expect(await raw(db)).toEqual(before);
        }finally{await db.close();}
    });

});
