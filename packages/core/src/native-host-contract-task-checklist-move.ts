import { deterministicHash128 } from './uuid';
import type { NativeHostResult } from './native-host-contract';
import type { AppData, Task, Project, Section, Area } from './types';
import type { PreparedAreaAuthority, PreparedChecklistRawBefore, PreparedNativeSaveBoundary } from './store-types';
import { exact, iso, record } from './native-host-contract-project-shared';
import { validSection } from './native-host-contract-project-section-rename';
import { validFrozenFocusDate } from './native-host-contract-task-focus';
import { historyRowLoadProjection } from './native-host-contract-task-checklist';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { validReferenceBatchTask, validReferenceBatchProject, validReferenceBatchArea, referenceBatchSettingsReadable } from './native-host-contract-reference-bulk-status';
import { rawReadTaskSnapshot, rawReadProjectSnapshot, rawReadAreaSnapshot } from './sqlite-raw-snapshot';
import { TASK_SQLITE_COLUMNS, taskFromSqliteRow, taskToSqliteRow } from './task-sync-schema';
import { createAreaSaveGuard, readAreaDurableData } from './native-host-contract-area-durable';
import { createNativeRequestReceipts, isNativeRequestReceiptDurable, NativeReceiptSqliteAdapter, taskRevisionOf } from './native-request-receipts';
import { getStorageAdapter, getPersistenceStatus, useTaskStore } from './store';
import { planTaskMutations, sanitizeRestoredTaskContainerReferences } from './store-tasks';
import { taskEditValuesEqual as same } from './json-value-equality';
import { ensureDeviceId, selectVisibleTasks } from './store-helpers';
import { projectFocusDateValues, type FocusDateProjection } from './task-utils';
import { resolveQuickCaptureDefaultAreaId } from './quick-capture-model';
import { canMoveTaskToChecklist, checklistItemIdForMovedTask, getChecklistMoveTargets, isChecklistMoveTarget,
    isTaskChecklistMoveSourceDetailsEmpty, type TaskChecklistMoveSourceDetails } from './task-checklist-move';
import { isProjectedRecurringTaskId } from './recurrence';
import { tFallback } from './i18n';
import { logInfo } from './logger';

export type NativeTaskChecklistMoveRequest = { requestId: string; id: string; taskRevision: string; targetId: string; targetRevision: string };
export type NativeTaskChecklistMoveUndoRequest = { requestId: string; moveRequestId: string };
type Clock = { preparedLocalDay: string; preparedOffsetMinutes: number; boundaryOffsetMinutes: number; futureBoundary: string; dates: FocusDateProjection[] };
type Scope = { source: Task | null; target: Task | null; projects: Project[]; sections: Section[]; areas: Area[];
    settings: AppData['settings']; sourceDetails: TaskChecklistMoveSourceDetails | null };
type Effect = { tasks: { before: Task; after: Task }[] };
type Base = { version: 1; scope: Scope; rawBefore: PreparedChecklistRawBefore; effect: Effect;
    deviceIdBefore: string | null; deviceIdToInitialize: string | null; updateAt: string; clock: Clock; result: { id: string } };
export type NativePreparedTaskChecklistMove = Base & { kind: 'taskChecklistMove'; request: NativeTaskChecklistMoveRequest };
export type NativeTaskChecklistMoveEnvelope = { request: NativeTaskChecklistMoveRequest; prepared: NativePreparedTaskChecklistMove };
export type NativePreparedTaskChecklistMoveUndo = Base & { kind: 'taskChecklistMoveUndo'; request: NativeTaskChecklistMoveUndoRequest; move: NativeTaskChecklistMoveEnvelope };
export type NativeTaskChecklistMoveUndoEnvelope = { request: NativeTaskChecklistMoveUndoRequest; prepared: NativePreparedTaskChecklistMoveUndo };
type Envelope = NativeTaskChecklistMoveEnvelope | NativeTaskChecklistMoveUndoEnvelope;
export type NativeTaskChecklistMoveOptionsInput = { id: string; taskRevision: string; query: string; offset: number; limit: number; revision: string | null };
export type NativeTaskChecklistMoveOptions = { title: string; searchPlaceholder: string; cancelLabel: string; noMatchesLabel: string; addedMessage: string; undoLabel: string;
    taskId: string; taskRevision: string; revision: string; query: string; offset: number; total: number; hasMore: boolean;
    items: { id: string; taskRevision: string; title: string; completedCount: number; totalCount: number }[] };
const BYTES=2_100_000, UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const text=(v:unknown,n:number):v is string=>typeof v==='string'&&Boolean(v.trim())&&v.length<=n;
const fail=(code:'INVALID_INPUT'|'STALE_REVISION'|'SAVE_FAILED'|'TASK_NOT_FOUND',message:string):NativeHostResult<never>=>({ok:false,error:{code,message}});
const canonical=(v:unknown)=>JSON.stringify(v,(_name,item)=>record(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);
const detach=<T,>(v:unknown,cap=BYTES):T|null=>{
    const valid=(x:unknown,d:number):boolean=>d<=32&&(x===null||typeof x==='string'||typeof x==='boolean'||typeof x==='number'&&Number.isFinite(x)
        ||Array.isArray(x)&&x.length<=100_000&&x.every(y=>valid(y,d+1))||record(x)&&[Object.prototype,null].includes(Object.getPrototypeOf(x))
        &&Object.keys(x).length<=128&&Object.entries(x).every(([k,y])=>!['__proto__','constructor','prototype'].includes(k)&&valid(y,d+1)));
    return isNativeJsonWithinBytes(v,cap)&&valid(v,0)?JSON.parse(JSON.stringify(v)) as T:null;
};
const readMove=(v:unknown):NativeTaskChecklistMoveRequest|null=>{
    const r=detach<Record<string,unknown>>(v,4096);return r&&exact(r,['requestId','id','taskRevision','targetId','targetRevision'])
        &&typeof r.requestId==='string'&&UUID.test(r.requestId)&&text(r.id,500)&&text(r.targetId,500)&&r.id!==r.targetId
        &&text(r.taskRevision,200)&&text(r.targetRevision,200)?r as NativeTaskChecklistMoveRequest:null;
};
const readUndo=(v:unknown):NativeTaskChecklistMoveUndoRequest|null=>{
    const r=detach<Record<string,unknown>>(v,4096);return r&&exact(r,['requestId','moveRequestId'])&&typeof r.requestId==='string'&&UUID.test(r.requestId)
        &&typeof r.moveRequestId==='string'&&UUID.test(r.moveRequestId)&&r.requestId!==r.moveRequestId?r as NativeTaskChecklistMoveUndoRequest:null;
};
const undo=(e:Envelope):e is NativeTaskChecklistMoveUndoEnvelope=>e.prepared.kind==='taskChecklistMoveUndo';
const moveOf=(e:Envelope)=>undo(e)?e.prepared.move:e;
const prefix=(e:Envelope)=>undo(e)?'taskChecklistMoveUndo':'taskChecklistMove';
const payload=(e:Envelope)=>canonical([prefix(e),e]);
const scopeTasks=(s:Scope)=>[s.source,s.target].filter((r):r is Task=>r!==null);
const dateValues=(s:Scope)=>[...new Set(scopeTasks(s).flatMap(r=>[r.startTime,r.dueDate,r.reviewAt].filter((v):v is string=>typeof v==='string')))].sort();
const clock=(s:Scope,at:string):Clock=>{const now=new Date(at),end=new Date(now);end.setHours(23,59,59,999);return{
    preparedLocalDay:new Date(now.getTime()-now.getTimezoneOffset()*60_000).toISOString().slice(0,10),preparedOffsetMinutes:now.getTimezoneOffset(),
    boundaryOffsetMinutes:end.getTimezoneOffset(),futureBoundary:end.toISOString(),dates:projectFocusDateValues(dateValues(s))};};
const temporal=(p:Base)=>({futureBoundary:p.clock.futureBoundary,dates:new Map(p.clock.dates.map(r=>[r.value,r]))});
const validClock=(c:unknown,s:Scope,at:string):c is Clock=>record(c)&&exact(c,['preparedLocalDay','preparedOffsetMinutes','boundaryOffsetMinutes','futureBoundary','dates'])
    &&typeof c.preparedLocalDay==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(c.preparedLocalDay)&&Number.isInteger(c.preparedOffsetMinutes)&&Math.abs(c.preparedOffsetMinutes as number)<=840
    &&Number.isInteger(c.boundaryOffsetMinutes)&&Math.abs(c.boundaryOffsetMinutes as number)<=840&&iso(c.futureBoundary)&&Array.isArray(c.dates)&&c.dates.every(validFrozenFocusDate)
    &&same(c.dates.map(r=>r.value),dateValues(s))&&new Date(Date.parse(at)-(c.preparedOffsetMinutes as number)*60_000).toISOString().slice(0,10)===c.preparedLocalDay
    &&new Date(Date.parse(c.preparedLocalDay+'T23:59:59.999Z')+(c.boundaryOffsetMinutes as number)*60_000).toISOString()===c.futureBoundary;
const settings=(data:AppData,isUndo:boolean):AppData['settings']=>JSON.parse(JSON.stringify({deviceId:data.settings.deviceId,...(!isUndo?{
    filters:data.settings.filters,gtd:{defaultAreaMode:data.settings.gtd?.defaultAreaMode,defaultAreaId:data.settings.gtd?.defaultAreaId}}:{})}));
const makeScope=(data:AppData,id:string,targetId:string,isUndo:boolean,sourceDetails:TaskChecklistMoveSourceDetails|null):Scope|null=>{
    const source=data.tasks.find(r=>r.id===id),target=data.tasks.find(r=>r.id===targetId),rows=[source,target].filter((r):r is Task=>Boolean(r));
    const sections=(data.sections??[]).filter(r=>rows.some(t=>t.sectionId===r.id));const parents=new Set([...rows.flatMap(r=>r.projectId?[r.projectId]:[]),...sections.map(r=>r.projectId)]);
    const projects=data.projects.filter(r=>parents.has(r.id)).map(rawReadProjectSnapshot),raw=rows.map(rawReadTaskSnapshot);
    if(projects.some(r=>r===null)||raw.some(r=>r===null))return null;
    return{source:source?rawReadTaskSnapshot(source):null,target:target?rawReadTaskSnapshot(target):null,projects:projects as Project[],sections,
        areas:(data.areas??[]).map(rawReadAreaSnapshot),settings:settings(data,isUndo),sourceDetails};
};
const validDetails=(v:unknown):v is TaskChecklistMoveSourceDetails=>record(v)&&(v.column===false?exact(v,['column']):v.column===true&&exact(v,['column','value'])
    &&(v.value===null||typeof v.value==='number'&&Number.isFinite(v.value)||typeof v.value==='string'&&v.value.length<=200));
const validScope=(s:unknown,isUndo:boolean):s is Scope=>record(s)&&exact(s,['source','target','projects','sections','areas','settings','sourceDetails'])
    &&(s.source===null||validReferenceBatchTask(s.source))&&(s.target===null||validReferenceBatchTask(s.target))&&record(s.settings)
    &&Object.keys(s.settings).every(name=>(isUndo?['deviceId']:['deviceId','filters','gtd']).includes(name))
    &&(s.settings.deviceId===undefined||text(s.settings.deviceId,500))
    &&(s.settings.gtd===undefined||record(s.settings.gtd)&&Object.keys(s.settings.gtd).every(name=>['defaultAreaMode','defaultAreaId'].includes(name)))
    &&Array.isArray(s.projects)&&s.projects.every(validReferenceBatchProject)&&new Set(s.projects.map(r=>r.id)).size===s.projects.length
    &&Array.isArray(s.sections)&&s.sections.every(r=>record(r)&&text(r.id,500)&&text(r.projectId,500)&&validSection(r,r.id,r.projectId))
    &&new Set(s.sections.map(r=>r.id)).size===s.sections.length&&Array.isArray(s.areas)&&s.areas.every(validReferenceBatchArea)
    &&new Set(s.areas.map(r=>r.id)).size===s.areas.length&&(isUndo?s.sourceDetails===null:validDetails(s.sourceDetails)&&isTaskChecklistMoveSourceDetailsEmpty(s.sourceDetails));
const effect=(p:Base,id:string,targetId:string,isUndo:boolean):Effect|null=>{
    const s=p.scope,source=s.source&&historyRowLoadProjection(s.source,p.updateAt,temporal(p)),target=s.target&&historyRowLoadProjection(s.target,p.updateAt,temporal(p));
    if(s.source&&s.source.id!==id||s.target&&s.target.id!==targetId)return null;
    const itemId=checklistItemIdForMovedTask(id),hasItem=Boolean(target?.checklist?.some(i=>i.id===itemId));let selected:Task[];
    if(!isUndo){if(!source||!target||isProjectedRecurringTaskId(id)||isProjectedRecurringTaskId(targetId)||!s.sourceDetails
        ||!canMoveTaskToChecklist(source,resolveQuickCaptureDefaultAreaId(s.settings,s.areas),{dueReminderLeadMinutes:s.sourceDetails.column?s.sourceDetails.value:undefined})
        ||!isChecklistMoveTarget(target,id))return null;selected=hasItem?[source]:[target,source];}
    else selected=[...(target&&hasItem?[target]:[]),...(source?.deletedAt&&!source.purgedAt?[source]:[])];
    if(!selected.length)return null;
    const planned=planTaskMutations({tasks:selected,state:{_allProjects:s.projects,_allSections:s.sections,_allAreas:s.areas},now:p.updateAt,
        deviceId:p.deviceIdBefore??p.deviceIdToInitialize!,buildUpdates:(row,{state,now})=>row.id===id
            ?isUndo?{deletedAt:undefined,...sanitizeRestoredTaskContainerReferences(row,state)}:{deletedAt:now}
            :isUndo?{checklist:(row.checklist??[]).filter(i=>i.id!==itemId).length?(row.checklist??[]).filter(i=>i.id!==itemId):undefined}
                :{checklist:[...(row.checklist??[]),{id:itemId,title:source!.title.trim(),isCompleted:false}]}});
    return{tasks:planned.map((after,index)=>({before:(selected[index].id===id?s.source:s.target)!,after}))};
};
const rawBefore=(e:Effect):PreparedChecklistRawBefore=>({tasks:e.tasks.map(r=>({id:r.before.id,before:r.before})),projects:[],sections:[]});
const readEnvelope=(v:unknown,isUndo:boolean):Envelope|null=>{
    const e=detach<{request:unknown;prepared:Record<string,unknown>}>(v);if(!e||!exact(e,['request','prepared'])||!record(e.prepared))return null;
    const r=isUndo?readUndo(e.request):readMove(e.request),p=e.prepared;
    if(!r||!exact(p,['version','kind','request','scope','rawBefore','effect','deviceIdBefore','deviceIdToInitialize','updateAt','clock','result',...(isUndo?['move']:[])])
        ||p.version!==1||p.kind!==(isUndo?'taskChecklistMoveUndo':'taskChecklistMove')||!same(p.request,r)||!validScope(p.scope,isUndo)||!iso(p.updateAt)
        ||!validClock(p.clock,p.scope,p.updateAt)||p.deviceIdBefore!==(p.scope.settings.deviceId??null)
        ||(p.deviceIdBefore===null?typeof p.deviceIdToInitialize!=='string'||!UUID.test(p.deviceIdToInitialize):p.deviceIdToInitialize!==null))return null;
    const original=isUndo?readEnvelope(p.move,false) as NativeTaskChecklistMoveEnvelope|null:null;if(isUndo&&(!original||(r as NativeTaskChecklistMoveUndoRequest).moveRequestId!==original.request.requestId))return null;
    const ids=original?.request??r as NativeTaskChecklistMoveRequest;
    try{const prepared=p as unknown as Base,expected=effect(prepared,ids.id,ids.targetId,isUndo);
        if(!expected||!same(expected,p.effect)||!same(rawBefore(expected),p.rawBefore)||!same(p.result,{id:isUndo?ids.id:ids.targetId}))return null;
        if(!isUndo&&(!p.scope.source||!p.scope.target||taskRevisionOf(historyRowLoadProjection(p.scope.source,p.updateAt,temporal(prepared)))!==(r as NativeTaskChecklistMoveRequest).taskRevision
            ||taskRevisionOf(historyRowLoadProjection(p.scope.target,p.updateAt,temporal(prepared)))!==(r as NativeTaskChecklistMoveRequest).targetRevision))return null;
        return e as unknown as Envelope;
    }catch{return null;}
};


// The prospective Undo uses this Move's frozen clock and SQL-normalized AFTER rows.
// It is checked again at Commit so a valid standalone Move envelope cannot bypass the bound.
const immediateUndoFits=(move:NativeTaskChecklistMoveEnvelope,data:AppData):boolean=>{
    const p=move.prepared,tasks=data.tasks.map(row=>{const changed=p.effect.tasks.find(r=>r.after.id===row.id)?.after;if(!changed)return row;
        const values=taskToSqliteRow(changed);return taskFromSqliteRow(Object.fromEntries(TASK_SQLITE_COLUMNS.map((name,index)=>[name,values[index]])));});
    const future={...data,tasks,settings:p.deviceIdToInitialize?{...data.settings,deviceId:p.deviceIdToInitialize}:data.settings};
    const scope=makeScope(future,move.request.id,move.request.targetId,true,null);if(!scope)return false;
    const request={requestId:move.request.requestId==='00000000-0000-4000-8000-000000000000'?'00000000-0000-4000-8000-000000000001':'00000000-0000-4000-8000-000000000000',moveRequestId:move.request.requestId};
    const base={version:1 as const,scope,deviceIdBefore:scope.settings.deviceId??null,deviceIdToInitialize:null,updateAt:p.updateAt,clock:p.clock};
    const planned=effect(base as Base,move.request.id,move.request.targetId,true);if(!planned)return false;
    return Boolean(readEnvelope(JSON.parse(JSON.stringify({request,prepared:{...base,kind:'taskChecklistMoveUndo',request,rawBefore:rawBefore(planned),effect:planned,result:{id:move.request.id},move}})),true));
};

export function createTaskChecklistMoveMethods(deps:{readiness:()=>NativeHostResult<null>;save:()=>Promise<NativeHostResult<null>>;t:()=>((key:string)=>string)}){
    const guard=():NativeHostResult<null>=>isNativeRequestReceiptDurable('taskChecklistMove')&&isNativeRequestReceiptDurable('taskChecklistMoveUndo')
        &&getStorageAdapter() instanceof NativeReceiptSqliteAdapter&&(getStorageAdapter() as NativeReceiptSqliteAdapter).concurrentWritesGuarded
        ?{ok:true,value:null}:fail('SAVE_FAILED','Checklist move requires guarded durable receipt storage');
    const readReady=():NativeHostResult<null>=>{const ready=deps.readiness();if(!ready.ok)return ready;const status=getPersistenceStatus();
        return useTaskStore.getState().persistenceFailure||status.queued||status.inFlight||status.immediate||status.retrying
            ?fail('SAVE_FAILED','Checklist targets require saved task state'):{ok:true,value:null};};
    const saves=createAreaSaveGuard(deps.save);let pending:{envelope:Envelope;adapter:NativeReceiptSqliteAdapter;boundary:PreparedNativeSaveBoundary|undefined}|null=null;
    const saved=(e:Envelope)=>{const reply=receipts.saved<{id:string}>(e.request.requestId,payload(e));return reply?.ok&&!same(reply.value,e.prepared.result)?fail('INVALID_INPUT','Saved checklist move result differs'):reply;};
    const prove=async(e:NativeTaskChecklistMoveEnvelope,adapter:NativeReceiptSqliteAdapter):Promise<NativeHostResult<null>>=>{const r=await adapter.readDurableReceipt(e.request.requestId,payload(e));
        return !r.ok?r:r.value!==null&&same(r.value,e.prepared.result)?{ok:true,value:null}:fail('STALE_REVISION','Checklist move has no exact current durable receipt');};
    const arm=(e:Envelope,adapter:NativeReceiptSqliteAdapter)=>{if(undo(e)){adapter.armReceiptPrerequisite(e.request.requestId,payload(e),e.prepared.move.request.requestId,payload(e.prepared.move),e.prepared.move.prepared.result);
        return()=>adapter.clearReceiptPrerequisite(e.request.requestId,payload(e));}
        adapter.armTaskChecklistMoveCompatibility(e.request.requestId,payload(e),e.request.id,e.prepared.scope.sourceDetails!);return()=>adapter.clearTaskChecklistMoveCompatibility(e.request.requestId,payload(e));};
    const authority=async(e:Envelope,a:PreparedAreaAuthority,adapter:NativeReceiptSqliteAdapter):Promise<NativeHostResult<null>>=>{
        if(getStorageAdapter()!==adapter)return fail('STALE_REVISION','Checklist move storage changed');const allowed=guard();if(!allowed.ok)return allowed;
        const original=moveOf(e),details=undo(e)?{ok:true as const,value:null}:await adapter.readTaskChecklistMoveSourceDetails(original.request.id);if(!details.ok)return details;
        if(!referenceBatchSettingsReadable(a.snapshot.settings))return fail('SAVE_FAILED','Saved checklist move settings are unreadable');
        const current=makeScope(a.snapshot,original.request.id,original.request.targetId,undo(e),details.value);
        if(!current||!same(current,e.prepared.scope))return fail('STALE_REVISION','Checklist move rows or context changed');
        return !undo(e)&&!immediateUndoFits(e,a.snapshot)?fail('INVALID_INPUT','Checklist move Undo journal would be too large'):{ok:true,value:null};
    };
    const apply=(e:Envelope,a:PreparedAreaAuthority)=>useTaskStore.getState().commitPreparedTaskChecklistMove({before:e.prepared.effect.tasks.map(r=>r.before),after:e.prepared.effect.tasks.map(r=>r.after),
        deviceIdBefore:e.prepared.deviceIdBefore,deviceIdToInitialize:e.prepared.deviceIdToInitialize,updateAt:e.prepared.updateAt,frozenTemporal:temporal(e.prepared)},a);
    const receipts=createNativeRequestReceipts({save:async requestId=>{const owned=pending;if(!owned||owned.envelope.request.requestId!==requestId)return fail('SAVE_FAILED','Checklist move has no owned save');
        arm(owned.envelope,owned.adapter);
        if(useTaskStore.getState().persistenceFailure){if(!saves.mayApply(owned.envelope,owned.adapter))return fail('SAVE_FAILED','Checklist move has unrelated failed persistence');
            const read=await readAreaDurableData(true,true);if(!read.ok)return read;if(read.value.adapter!==owned.adapter)return fail('STALE_REVISION','Checklist move storage changed');
            if(undo(owned.envelope)){const proof=await prove(owned.envelope.prepared.move,owned.adapter);if(!proof.ok)return proof;}
            const checked=await authority(owned.envelope,read.value.authority,owned.adapter);if(!checked.ok)return checked;const applied=await apply(owned.envelope,read.value.authority);
            if(!applied.success||applied.outcome!=='applied')return fail('STALE_REVISION','Checklist move retry changed');owned.boundary=read.value.authority.saveBoundary;
        }else if(undo(owned.envelope)){const proof=await prove(owned.envelope.prepared.move,owned.adapter);if(!proof.ok)return proof;}
        const result=await saves.finish(owned.envelope,owned.adapter,false,owned.boundary);if(result.ok)pending=null;return result;}});
    const commit=async(e:Envelope):Promise<NativeHostResult<{id:string}>>=>{const ready=deps.readiness();if(!ready.ok)return ready;const allowed=guard();if(!allowed.ok)return allowed;const prior=saved(e);if(prior)return prior;
        let notSaved:NativeHostResult<never>|null=null;
        const beforeApplyFailure=(error:Extract<NativeHostResult<null>,{ok:false}>)=>{
            // receipts.run reserves SAVE_FAILED for an effect that already owes a save.
            if(error.error.code==='SAVE_FAILED'){notSaved=error;return fail('INVALID_INPUT','Checklist move could not validate saved authority');}
            return error;
        };
        const result=await receipts.run(e.request.requestId,payload(e),async()=>{
            if(useTaskStore.getState().persistenceFailure){notSaved=fail('SAVE_FAILED','Checklist move has unresolved persistence failure');return fail('INVALID_INPUT','Checklist move cannot start');}
            const read=await readAreaDurableData(false,true);if(!read.ok){notSaved=read;return fail('INVALID_INPUT','Checklist move could not read');}
            const adapter=read.value.adapter as NativeReceiptSqliteAdapter;if(undo(e)){const proof=await prove(e.prepared.move,adapter);if(!proof.ok)return beforeApplyFailure(proof);}
            const checked=await authority(e,read.value.authority,adapter);if(!checked.ok)return beforeApplyFailure(checked);const disarm=arm(e,adapter);let applied;
            try{applied=await apply(e,read.value.authority);}catch(error){disarm();throw error;}if(!applied.success||applied.outcome!=='applied'){disarm();return fail('STALE_REVISION','Checklist move conflicts with saved data');}
            pending={envelope:e,adapter,boundary:read.value.authority.saveBoundary};return{ok:true as const,value:e.prepared.result};
        });if(notSaved)return notSaved;if(result.ok&&!same(result.value,e.prepared.result))return fail('INVALID_INPUT','Saved checklist move result differs');
        if(result.ok)try{logInfo('Native iOS task checklist move confirmed',{scope:'native-host',category:'storage',force:true,context:{releaseCheck:'v1.3.8/ios-task-checklist-move',outcome:undo(e)?'undone':'moved'}});}catch{}
        return result;
    };
    const build=(request:NativeTaskChecklistMoveRequest|NativeTaskChecklistMoveUndoRequest,scope:Scope,isUndo:boolean,original?:NativeTaskChecklistMoveEnvelope):Envelope|null=>{
        const device=ensureDeviceId(scope.settings),at=new Date().toISOString();const base={version:1 as const,scope,deviceIdBefore:scope.settings.deviceId??null,deviceIdToInitialize:device.updated?device.deviceId:null,updateAt:at,clock:clock(scope,at)};
        const ids=original?.request??request as NativeTaskChecklistMoveRequest;const planned=effect(base as Base,ids.id,ids.targetId,isUndo);if(!planned)return null;
        const prepared={...base,kind:isUndo?'taskChecklistMoveUndo':'taskChecklistMove',request,rawBefore:rawBefore(planned),effect:planned,result:{id:isUndo?ids.id:ids.targetId},...(original?{move:original}:{})};
        return readEnvelope(JSON.parse(JSON.stringify({request,prepared})),isUndo);
    };
    const sourceRead=async(id:string,revision:string)=>{const ready=readReady();if(!ready.ok)return ready;const allowed=guard();if(!allowed.ok)return allowed;
        const read=await readAreaDurableData(false,true);if(!read.ok)return read;const adapter=read.value.adapter as NativeReceiptSqliteAdapter,data=read.value.authority.snapshot,at=new Date().toISOString();
        if(!referenceBatchSettingsReadable(data.settings))return fail('SAVE_FAILED','Saved checklist move settings are unreadable');const raw=data.tasks.find(r=>r.id===id);
        if(!raw||raw.deletedAt||raw.purgedAt||isProjectedRecurringTaskId(id))return fail('TASK_NOT_FOUND','Checklist move source is unavailable');if(raw.title.length>BYTES)return fail('SAVE_FAILED','Checklist source exceeds the bounded read');const source=historyRowLoadProjection(raw,at);
        if(taskRevisionOf(source)!==revision)return fail('STALE_REVISION','Source changed since it was shown');const details=await adapter.readTaskChecklistMoveSourceDetails(id);if(!details.ok)return details;
        if(!canMoveTaskToChecklist(source,resolveQuickCaptureDefaultAreaId(data.settings,data.areas??[]),{dueReminderLeadMinutes:details.value.column?details.value.value:undefined}))return fail('INVALID_INPUT','Only a title-only Inbox task can move to a checklist');
        return{ok:true as const,value:{source,data,details:details.value,adapter,at}};
    };
    return{
        async getTaskChecklistMoveOptions(input:NativeTaskChecklistMoveOptionsInput):Promise<NativeHostResult<NativeTaskChecklistMoveOptions>>{
            const r=detach<NativeTaskChecklistMoveOptionsInput>(input,16_384);if(!r||!exact(r,['id','taskRevision','query','offset','limit','revision'])||!text(r.id,500)||!text(r.taskRevision,200)
                ||typeof r.query!=='string'||r.query.length>2000||!Number.isSafeInteger(r.offset)||r.offset<0||!Number.isInteger(r.limit)||r.limit<1||r.limit>100||!(r.revision===null||text(r.revision,200)))return fail('INVALID_INPUT','Invalid checklist target page');
            const read=await sourceRead(r.id,r.taskRevision);if(!read.ok)return read;const {source,data,details,at}=read.value;
            const targets=getChecklistMoveTargets(selectVisibleTasks(data.tasks.map(row=>historyRowLoadProjection(row,at))),r.id,r.query);
            const page=targets.slice(r.offset,r.offset+r.limit);
            if(targets.some(row=>row.title.length>BYTES)||page.reduce((sum,row)=>sum+row.title.length,0)>BYTES)return fail('SAVE_FAILED','Checklist target page exceeds the bounded response');
            const targetVersions=targets.map(row=>deterministicHash128(canonical({id:row.id,revision:taskRevisionOf(row),title:row.title,
                completedCount:(row.checklist??[]).filter(i=>i.isCompleted).length,totalCount:row.checklist?.length??0})));
            const revision='checklistMove:'+deterministicHash128(canonical({source,details,query:r.query,defaultAreaId:resolveQuickCaptureDefaultAreaId(data.settings,data.areas??[]),targetVersions})).map(part=>part.toString(16).padStart(8,'0')).join('');if(r.revision!==null&&r.revision!==revision)return fail('STALE_REVISION','Checklist target page changed');
            const t=deps.t(),result:NativeTaskChecklistMoveOptions={title:tFallback(t,'task.addToChecklist','Add to checklist…'),searchPlaceholder:tFallback(t,'common.search','Search'),cancelLabel:tFallback(t,'common.cancel','Cancel'),
                noMatchesLabel:tFallback(t,'common.noMatches','No matches'),addedMessage:tFallback(t,'task.addedToChecklist','Added to checklist'),undoLabel:tFallback(t,'common.undo','Undo'),
                taskId:r.id,taskRevision:r.taskRevision,revision,query:r.query,offset:r.offset,total:targets.length,hasMore:r.offset+r.limit<targets.length,
                items:page.map(row=>({id:row.id,taskRevision:taskRevisionOf(row),title:row.title,completedCount:(row.checklist??[]).filter(i=>i.isCompleted).length,totalCount:row.checklist?.length??0}))};
            return isNativeJsonWithinBytes(result,BYTES)?{ok:true,value:result}:fail('SAVE_FAILED','Checklist target page exceeds the bounded response');
        },
        async prepareTaskChecklistMove(input:NativeTaskChecklistMoveRequest):Promise<NativeHostResult<{kind:'prepared';prepared:NativePreparedTaskChecklistMove}>>{
            const request=readMove(input);if(!request)return fail('INVALID_INPUT','An exact source and target revision is required');const read=await sourceRead(request.id,request.taskRevision);if(!read.ok)return read;
            const target=read.value.data.tasks.find(r=>r.id===request.targetId);if(!target||isProjectedRecurringTaskId(target.id)||!isChecklistMoveTarget(target,request.id))return fail('INVALID_INPUT','Checklist target is unavailable');
            if(taskRevisionOf(historyRowLoadProjection(target,read.value.at))!==request.targetRevision)return fail('STALE_REVISION','Target changed since it was shown');
            const scope=makeScope(read.value.data,request.id,request.targetId,false,read.value.details),e=scope&&build(request,scope,false) as NativeTaskChecklistMoveEnvelope|null;if(!e)return fail('INVALID_INPUT','Checklist move cannot produce a bounded journal');
            if(!immediateUndoFits(e,read.value.data))return fail('INVALID_INPUT','Checklist move Undo journal would be too large');
            return{ok:true,value:{kind:'prepared',prepared:e.prepared}};
        },
        validatePreparedTaskChecklistMove(input:NativeTaskChecklistMoveEnvelope):NativeHostResult<{id:string}>{const e=readEnvelope(input,false);return e?{ok:true,value:e.prepared.result}:fail('INVALID_INPUT','Invalid prepared checklist move');},
        async commitPreparedTaskChecklistMove(input:NativeTaskChecklistMoveEnvelope){const e=readEnvelope(input,false);return e?commit(e):fail('INVALID_INPUT','Invalid prepared checklist move');},
        taskChecklistMoveOutcome(input:NativeTaskChecklistMoveEnvelope){const e=readEnvelope(input,false);if(!e)return fail('INVALID_INPUT','Invalid prepared checklist move');const allowed=guard();return allowed.ok?saved(e)??{ok:true as const,value:null}:allowed;},
        async prepareTaskChecklistMoveUndo(input:{request:NativeTaskChecklistMoveUndoRequest;move:NativeTaskChecklistMoveEnvelope}):Promise<NativeHostResult<{kind:'prepared';prepared:NativePreparedTaskChecklistMoveUndo}>>{
            const v=detach<typeof input>(input),request=v&&exact(v,['request','move'])?readUndo(v.request):null,original=v?readEnvelope(v.move,false) as NativeTaskChecklistMoveEnvelope|null:null;
            if(!request||!original||request.moveRequestId!==original.request.requestId)return fail('INVALID_INPUT','Exact confirmed checklist move is required');const ready=readReady();if(!ready.ok)return ready;const allowed=guard();if(!allowed.ok)return allowed;
            const read=await readAreaDurableData(false,true);if(!read.ok)return read;const proof=await prove(original,read.value.adapter as NativeReceiptSqliteAdapter);if(!proof.ok)return proof;
            const scope=makeScope(read.value.authority.snapshot,original.request.id,original.request.targetId,true,null),e=scope&&build(request,scope,true,original) as NativeTaskChecklistMoveUndoEnvelope|null;
            return e?{ok:true,value:{kind:'prepared',prepared:e.prepared}}:fail('INVALID_INPUT','Checklist move has no bounded current Undo effect');
        },
        validatePreparedTaskChecklistMoveUndo(input:NativeTaskChecklistMoveUndoEnvelope):NativeHostResult<{id:string}>{const e=readEnvelope(input,true);return e?{ok:true,value:e.prepared.result}:fail('INVALID_INPUT','Invalid prepared checklist move Undo');},
        async commitPreparedTaskChecklistMoveUndo(input:NativeTaskChecklistMoveUndoEnvelope){const e=readEnvelope(input,true);return e?commit(e):fail('INVALID_INPUT','Invalid prepared checklist move Undo');},
        taskChecklistMoveUndoOutcome(input:NativeTaskChecklistMoveUndoEnvelope){const e=readEnvelope(input,true);if(!e)return fail('INVALID_INPUT','Invalid prepared checklist move Undo');const allowed=guard();return allowed.ok?saved(e)??{ok:true as const,value:null}:allowed;},
    };
}
