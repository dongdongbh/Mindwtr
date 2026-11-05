import {afterEach,describe,it,expect,vi} from 'vitest';
import {openSqliteHost,value} from './screen-parity.replay';
import {flushPendingSave,resetForTests,useTaskStore} from './store';
import {taskDraftToChangedUpdatePatch} from './task-draft';
import {taskRevisionOf} from './native-request-receipts';
import {projectFocusDateValues} from './task-utils';
import type {NativeRowTaskDatesEnvelope,NativeRowTaskDatesRequest} from './native-host-contract-task-checklist';
import type {Task,AppData} from './types';
const NOW='2026-11-02T12:00:00.000Z',OLD='2026-10-01T12:00:00.000Z',ID='row-dates',UUID='00000000-0000-4000-8000-000000004001';
const task=(patch:Partial<Task>={}):Task=>({id:ID,title:'Keep title',status:'inbox',tags:[],contexts:[],createdAt:OLD,updatedAt:OLD,rev:3,revBy:'device',...patch});
const seed=(source=task()):Partial<AppData>=>({tasks:[source,task({id:'sibling',status:'next',title:'Sibling'})],projects:[],sections:[],areas:[],people:[],settings:{deviceId:'device',analyticsProfileId:UUID}});
type Db=Awaited<ReturnType<typeof openSqliteHost>>;
const raw=async(db:Db)=>Object.fromEntries(await Promise.all(['tasks','projects','sections','areas','people','settings','saved_filters','schema_migrations','calendar_sync'].map(async table=>[table,await db.sql(`SELECT rowid AS _rowid,* FROM ${table} ORDER BY rowid`)])));
const rows=()=>{const state=useTaskStore.getState();return JSON.parse(JSON.stringify({tasks:state._allTasks,projects:state._allProjects,sections:state._allSections,areas:state._allAreas,people:state._allPeople,settings:state.settings}));};
const request=(db:Db,edit?:Parameters<Db['host']['editTaskDraft']>[0]['edit'])=>{const opening=value(db.host.getTaskEditorModel({id:ID}));const model=edit?value(db.host.editTaskDraft({id:ID,draft:opening.draft,edit})):opening;
    return JSON.parse(JSON.stringify({id:ID,requestId:UUID,taskRevision:opening.taskRevision,source:'row',draft:model.draft,scheduleBase:opening.scheduleBase})) as NativeRowTaskDatesRequest;};
const prepare=async(db:Db,input:ReturnType<typeof request>):Promise<NativeRowTaskDatesEnvelope>=>{const result=value(await db.host.prepareRowTaskDates(input));if(result.kind!=='prepared')throw new Error('Expected changed Dates');return{request:input,prepared:result.prepared};};
afterEach(async()=>{await flushPendingSave();resetForTests();vi.restoreAllMocks();vi.useRealTimers();vi.unstubAllEnvs();});
describe('ordinary row quick Dates',()=>{
    it('reuses pure editDraft while preserving an untouched legacy invalid date',async()=>{
        vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(NOW));const db=await openSqliteHost(seed(task({startTime:'legacy-invalid-date'})));
        try{const model=value(db.host.getTaskEditorModel({id:ID}));expect(model.draft.startTime).toBe('legacy-invalid-date');
            const edited=db.host.editTaskDraft({id:ID,draft:model.draft,edit:{type:'date',field:'dueDate',value:'2026-11-03'}});expect(edited).toMatchObject({ok:true,value:{draft:{startTime:'legacy-invalid-date',dueDate:'2026-11-03'}}});
        }finally{await db.close();}
    });
    it.each(['inbox','next','waiting','someday'] as const)('returns unchanged for %s before device initialization, domain writes or receipts',async status=>{
        vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(NOW));const db=await openSqliteHost(seed(task({status})));try{
            await db.client().run("UPDATE settings SET data=json_remove(data,'$.deviceId') WHERE id=1");await db.restart(undefined,{recoveryLoad:true});const before=await raw(db),input=request(db);
            expect(await db.host.prepareRowTaskDates(input)).toEqual({ok:true,value:{kind:'unchanged',result:{id:ID}}});expect(await raw(db)).toEqual(before);expect(await db.receiptIds()).toEqual([]);expect(useTaskStore.getState().settings.deviceId).toBeUndefined();
        }finally{await db.close();}
    });
    it.each([
        ['Inbox Start',task(),{type:'pickDate',field:'startTime',date:'2026-11-03'}],
        ['linked Due',task({status:'waiting',dueDate:'2026-11-02T10:00:00.000Z',startTime:'2026-11-02T08:00:00.000Z',relativeStartOffset:{amount:-2,unit:'hour'}}),{type:'pickDate',field:'dueDate',date:'2026-11-05'}],
        ...(['next','waiting','someday'] as const).map(status=>[`${status} Start`,task({status,description:'Keep memo',checklist:[{id:'keep',title:'Keep checklist',isCompleted:true}],recurrence:{rule:'daily'}}),{type:'pickDate' as const,field:'startTime' as const,date:'2026-11-03'}] as const),
        ['Inbox Due only',task(),{type:'pickDate',field:'dueDate',date:'2026-11-03'}],
        ['Inbox clear Start',task({startTime:'2026-11-03'}),{type:'date',field:'startTime',value:''}],
        ['same Start ends link',task({status:'waiting',startTime:'2026-11-02',dueDate:'2026-11-03',relativeStartOffset:{amount:-1,unit:'day'}}),{type:'date',field:'startTime',value:'2026-11-02'}],
        ['Due clear ends link',task({status:'someday',startTime:'2026-11-02',dueDate:'2026-11-03',relativeStartOffset:{amount:-1,unit:'day'}}),{type:'date',field:'dueDate',value:''}],
        ['legacy Start retained',task({startTime:'legacy-invalid-date'}),{type:'pickDate',field:'dueDate',date:'2026-11-03'}],

    ] as const)('matches actual RN changed-draft patch and all nine SQL domains for %s',async(_name,source,edit)=>{
        vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(NOW));const rn=await openSqliteHost(seed(source));let expected:ReturnType<typeof rows>,expectedRaw:Awaited<ReturnType<typeof raw>>;
        try{const input=request(rn,edit),before=useTaskStore.getState()._tasksById.get(ID)!,patch=taskDraftToChangedUpdatePatch(input.draft,before)!;expect(Object.keys(patch).every(field=>['startTime','dueDate','relativeStartOffset'].includes(field))).toBe(true);
            expect(await useTaskStore.getState().updateTask(ID,patch)).toEqual({success:true});await flushPendingSave();expected=rows();expectedRaw=await raw(rn);
        }finally{await rn.close();}
        const db=await openSqliteHost(seed(source));try{const e=await prepare(db,request(db,edit));expect(Object.keys(e.prepared).sort()).toEqual(['version','kind','request','rawBefore','checklist','result'].sort());expect(db.host.validatePreparedRowTaskDates(e)).toEqual({ok:true,value:{id:ID}});value(await db.host.commitPreparedRowTaskDates(e));expect(rows()).toEqual(expected!);expect(await raw(db)).toEqual(expectedRaw!);expect(await db.receiptIds()).toEqual([UUID]);
        }finally{await db.close();}
    });
    it('rejects changed invalid dates and forged untouched-date baselines in existing pure readers',async()=>{
        vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(NOW));const db=await openSqliteHost(seed(task({startTime:'legacy-invalid-date'})));try{const model=value(db.host.getTaskEditorModel({id:ID}));const before=await raw(db);
            for(const mutate of [(draft:typeof model.draft)=>{draft.startTime='different-invalid';},(draft:typeof model.draft)=>{draft.dateInputBaseline!.startTime.raw='different-invalid';},(draft:typeof model.draft)=>{draft.dateInputBaseline!.taskId='other';}]){const draft=JSON.parse(JSON.stringify(model.draft));mutate(draft);
                expect(db.host.editTaskDraft({id:ID,draft,edit:{type:'date',field:'dueDate',value:'2026-11-03'}})).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
                expect(db.host.getTaskDraftDestinationPicker({id:ID,draft,query:''})).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
                expect(await db.host.prepareRowTaskDates({...request(db),draft})).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
            }expect(await raw(db)).toEqual(before);expect(await db.receiptIds()).toEqual([]);
        }finally{await db.close();}
    });

    it('keeps a linked Due edit across a DST gap frozen during cold timezone replay',async()=>{
        vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-03-05T12:00:00.000Z'));vi.stubEnv('TZ','America/New_York');
        const db=await openSqliteHost(seed(task({status:'waiting',createdAt:'2026-02-01T12:00:00.000Z',updatedAt:'2026-02-01T12:00:00.000Z',dueDate:'2026-03-06T07:30:00.000Z',startTime:'2026-03-05T07:30:00.000Z',relativeStartOffset:{amount:-1,unit:'day'}})));
        try{const e=await prepare(db,request(db,{type:'pickDate',field:'dueDate',date:'2026-03-09'})),bytes=JSON.stringify(e);expect(e.prepared.checklist.effect.tasks[0].after.startTime).toBe('2026-03-08T07:30:00.000Z');
            const before=await raw(db);
            for(const mutate of [
                (x:NativeRowTaskDatesEnvelope)=>{const bad='2026-03-08T08:30:00.000Z';x.request.draft.startTime=bad;x.prepared.request.draft.startTime=bad;x.prepared.checklist.request.patch.startTime=bad;x.prepared.checklist.witness.direct.startTime=bad;x.prepared.checklist.effect.tasks[0].after.startTime=bad;x.prepared.checklist.witness.focusDates!.push(projectFocusDateValues([bad])[0]);x.prepared.checklist.witness.focusDates!.sort((a,b)=>a.value<b.value?-1:a.value>b.value?1:0);},
                (x:NativeRowTaskDatesEnvelope)=>{x.prepared.checklist.witness.direct.relativeStartOffset={amount:-2,unit:'day'};x.prepared.checklist.request.patch.relativeStartOffset={amount:-2,unit:'day'};x.prepared.checklist.effect.tasks[0].after.relativeStartOffset={amount:-2,unit:'day'};},
                (x:NativeRowTaskDatesEnvelope)=>{const nominal=x.prepared.checklist.witness.focusDates!.find(row=>row.value==='2026-03-08T02:30:00.000')!;nominal.parsedAt!+=3_600_000;nominal.dueAt!+=3_600_000;},
            ]){const forged=JSON.parse(JSON.stringify(e));mutate(forged);expect(db.host.validatePreparedRowTaskDates(forged)).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});expect(await db.host.commitPreparedRowTaskDates(forged)).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});expect(await raw(db)).toEqual(before);expect(await db.receiptIds()).toEqual([]);}
            vi.stubEnv('TZ','UTC');await db.restart(undefined,{recoveryLoad:true});expect(db.host.validatePreparedRowTaskDates(e)).toEqual({ok:true,value:{id:ID}});value(await db.host.commitPreparedRowTaskDates(e));expect(useTaskStore.getState()._tasksById.get(ID)!.startTime).toBe('2026-03-08T07:30:00.000Z');expect(JSON.stringify(e)).toBe(bytes);
        }finally{await db.close();}
    });

    it('uses existing default schedule time through pure pickDate without Swift date derivation',async()=>{
        vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(NOW));const fixture=seed();fixture.settings!.gtd={defaultScheduleTime:'09:15'};const db=await openSqliteHost(fixture);
        try{const e=await prepare(db,request(db,{type:'pickDate',field:'startTime',date:'2026-11-03'}));expect(e.request.draft.startTime).toBe('2026-11-03T09:15');value(await db.host.commitPreparedRowTaskDates(e));expect(useTaskStore.getState()._tasksById.get(ID)).toMatchObject({status:'next',startTime:'2026-11-03T09:15'});
        }finally{await db.close();}
    });
    it.each(['done','reference','archived'] as const)('refuses %s sources even for unchanged drafts',async status=>{
        vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(NOW));const db=await openSqliteHost(seed(task({status,...(status==='done'?{completedAt:NOW}:{})})));
        try{const before=await raw(db);expect(await db.host.prepareRowTaskDates(request(db))).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});expect(await raw(db)).toEqual(before);expect(await db.receiptIds()).toEqual([]);
        }finally{await db.close();}
    });
    it('refuses nondate edits, changed links, stale/source/shape and schedule baseline mismatch before writing',async()=>{
        vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(NOW));const db=await openSqliteHost(seed());try{const input=request(db),before=await raw(db);
            for(const patch of [{title:'Changed title'},{reviewAt:'2026-11-03'},{status:'done'},{relativeStartOffset:{amount:-1,unit:'day'}}])expect(await db.host.prepareRowTaskDates({...input,draft:{...input.draft,...patch}} as never)).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
            expect(await db.host.prepareRowTaskDates({...input,taskRevision:'old'})).toMatchObject({ok:false,error:{code:'STALE_REVISION'}});expect(await db.host.prepareRowTaskDates({...input,source:'reference'} as never)).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
            expect(await db.host.prepareRowTaskDates({...input,scheduleBase:{...input.scheduleBase,reviewAt:'2026-11-03'}})).toMatchObject({ok:false,error:{code:'STALE_REVISION'}});expect(await raw(db)).toEqual(before);expect(await db.receiptIds()).toEqual([]);
        }finally{await db.close();}
    });

    it.each(['floating default time','date-only UTC boundary'] as const)('freezes RN Date.parse reschedule count for %s across cold zones',async mode=>{
        vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(NOW));vi.stubEnv('TZ','America/New_York');const fixture=seed(task({status:'waiting',dueDate:mode==='floating default time'?'2026-11-02T12:00:00.000Z':'2026-11-02T01:00:00.000Z',pushCount:4}));fixture.settings!.gtd=mode==='floating default time'?{defaultScheduleTime:'09:00'}:{};
        const db=await openSqliteHost(fixture);try{const opening=value(db.host.getTaskEditorModel({id:ID})),cleared=value(db.host.editTaskDraft({id:ID,draft:opening.draft,edit:{type:'date',field:'dueDate',value:''}})),picked=value(db.host.editTaskDraft({id:ID,draft:cleared.draft,edit:{type:'pickDate',field:'dueDate',date:'2026-11-02'}}));
            const input=JSON.parse(JSON.stringify({id:ID,requestId:UUID,taskRevision:opening.taskRevision,source:'row',draft:picked.draft,scheduleBase:opening.scheduleBase})) as NativeRowTaskDatesRequest,e=await prepare(db,input),expected=mode==='floating default time'?5:4;
            expect(e.prepared.checklist.effect.tasks[0].after.pushCount).toBe(expected);const before=await raw(db),forged=JSON.parse(JSON.stringify(e)) as NativeRowTaskDatesEnvelope;forged.prepared.checklist.effect.tasks[0].after.pushCount=expected+1;expect(db.host.validatePreparedRowTaskDates(forged)).toMatchObject({ok:false});expect(await db.host.commitPreparedRowTaskDates(forged)).toMatchObject({ok:false});expect(await raw(db)).toEqual(before);
            if(mode==='floating default time'){const projection=JSON.parse(JSON.stringify(e)) as NativeRowTaskDatesEnvelope,nominal=projection.prepared.checklist.witness.focusDates!.find(row=>row.value==='2026-11-02T09:00:00.000')!;nominal.parsedAt!+=3_600_000;nominal.dueAt!+=3_600_000;nominal.parsedOffsetMinutes!+=60;expect(db.host.validatePreparedRowTaskDates(projection)).toMatchObject({ok:false});}
            vi.stubEnv('TZ','UTC');await db.restart(undefined,{recoveryLoad:true});expect(db.host.validatePreparedRowTaskDates(e)).toEqual({ok:true,value:{id:ID}});value(await db.host.commitPreparedRowTaskDates(e));expect(useTaskStore.getState()._tasksById.get(ID)!.pushCount).toBe(expected);
        }finally{await db.close();}
    });

    it.each(['project','section'] as const)('refuses a current readonly %s before an unchanged Dates acknowledgment',async kind=>{
        vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(NOW));const fixture=seed(task({projectId:'parent',sectionId:'section'}));fixture.projects=[{id:'parent',title:'Parent',status:'active',color:'#123456',order:0,tagIds:[],createdAt:OLD,updatedAt:OLD}];fixture.sections=[{id:'section',projectId:'parent',title:'Section',order:0,createdAt:OLD,updatedAt:OLD}];const db=await openSqliteHost(fixture);
        try{const input=request(db);if(kind==='project')await db.client().run('UPDATE projects SET status=? WHERE id=?',['archived','parent']);else await db.client().run('UPDATE sections SET deletedAt=? WHERE id=?',[NOW,'section']);const before=await raw(db);expect(await db.host.prepareRowTaskDates(input)).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});expect(await raw(db)).toEqual(before);expect(await db.receiptIds()).toEqual([]);
        }finally{await db.close();}
    });
    it('uses the displayed revision for consecutive Dates after a backwards clock write',async()=>{
        vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-02T12:00:00.000Z'));const db=await openSqliteHost(seed(task({createdAt:NOW,updatedAt:NOW})));
        try{const first=await prepare(db,request(db,{type:'date',field:'startTime',value:'2026-11-03'}));value(await db.host.commitPreparedRowTaskDates(first));const secondInput={...request(db,{type:'date',field:'dueDate',value:'2026-11-05'}),requestId:'00000000-0000-4000-8000-000000004002'},second=await prepare(db,secondInput);value(await db.host.commitPreparedRowTaskDates(second));expect(await db.receiptIds()).toEqual([UUID,secondInput.requestId]);expect(useTaskStore.getState()._tasksById.get(ID)).toMatchObject({startTime:'2026-11-03',dueDate:'2026-11-05'});
        }finally{await db.close();}
    });

});
