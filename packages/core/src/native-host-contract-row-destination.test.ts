import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqliteHost } from './screen-parity.replay';
import { loadNativeRequestReceipts, taskRevisionOf } from './native-request-receipts';
import { flushPendingSave, getPersistenceStatus, resetForTests, useTaskStore } from './store';
import { buildTaskMovePatch, type TaskMoveDestination } from './task-container-rules';
import type { NativeRowTaskDestinationEnvelope } from './native-host-contract-task-checklist';
import type { AppData, Task } from './types';
import { retainTaxonomyEffects } from './taxonomy-catalog';
// Raw-byte preservation cases catalog existing labels before their baseline; legacy RN/native parity cases remain uncatalogued.

const NOW = '2026-10-03T13:00:00.000Z';
const ID = 'reference-destination';
const UUID = '00000000-0000-4000-8000-000000000190';
const value = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`); return result.value;
};
const task = (patch: Partial<Task> = {}): Task => ({
    id: ID, title: '  Reference filing  ', status: 'next', description: 'Retain memo and metadata',
    createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-10-02T12:00:00.000Z', rev: 3, revBy: 'device-a',
    tags: ['#first', '#second'], contexts: ['@home'], projectId: 'parent', sectionId: 'section',
    order: 2, orderNum: 2, boardOrder: 7, timeSpentMinutes: 45, isFocusedToday: true, focusOrder: 2,
    recurrence: { rule: 'daily', strategy: 'after-completion', seriesId: ID }, dueDate: '2026-10-01',
    checklist: [{ id: 'duplicate', title: 'Keep', isCompleted: true }, { id: 'duplicate', title: '  ', isCompleted: false }],
    attachments: [{ id: 'attachment', kind: 'file', title: 'proof.txt', uri: 'file:///proof.txt', createdAt: NOW, updatedAt: NOW }],
    ...patch,
});
const seed = (source = task()): Partial<AppData> => ({
    tasks: [source, task({ id: 'ranked', status: 'next', projectId: 'other', sectionId: undefined, order: 11, orderNum: 11 })],
    projects: ['parent', 'other'].map((id, order) => ({ id, title: id, status: 'active', color: '#94a3b8', order, tagIds: [],
        createdAt: NOW, updatedAt: NOW, rev: 2, revBy: 'device-a' })),
    sections: [{ id: 'section', projectId: 'parent', title: 'Section', order: 0, createdAt: NOW, updatedAt: NOW }],
    areas: [{ id: 'area', name: 'Area', order: 0, createdAt: NOW, updatedAt: NOW }],
    people: [{ id: 'person', name: 'Person', createdAt: NOW, updatedAt: NOW }],
    settings: { deviceId: 'device-a', analyticsProfileId: UUID, gtd: { autoArchiveDays: 1, focusTaskLimit: 1 } },
});
type Sqlite = Awaited<ReturnType<typeof openSqliteHost>>;
const tables = ['tasks', 'projects', 'sections', 'areas', 'people', 'settings', 'saved_filters', 'schema_migrations', 'calendar_sync'];
const raw = async (sqlite: Sqlite) => Object.fromEntries(await Promise.all(tables.map(async table => [table,
    { schema: await sqlite.sql(`PRAGMA table_info(${table})`), rows: await sqlite.sql(`SELECT rowid AS evidenceRowid,* FROM ${table} ORDER BY rowid`) }])));
const rows = () => { const s = useTaskStore.getState(); return JSON.parse(JSON.stringify({ tasks: s._allTasks, projects: s._allProjects,
    sections: s._allSections, areas: s._allAreas, people: s._allPeople, settings: s.settings })) as AppData; };
const displayed = () => ({ id: ID, taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get(ID)!) });
const request = (destination: TaskMoveDestination = { kind: 'none' }) => ({ ...displayed(), requestId: UUID, source: 'row' as const, destination });
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); });
const cases: Array<[string, Partial<Task>, TaskMoveDestination]> = [
    ['none', {}, { kind: 'none' }], ['area', {}, { kind: 'area', id: 'area' }],
    ['different project', {}, { kind: 'project', id: 'other' }],
    ['missing order project', { order: undefined, orderNum: undefined }, { kind: 'project', id: 'other' }],
    ['same project retains section', {}, { kind: 'project', id: 'parent' }],
    ['same area', { projectId: undefined, sectionId: undefined, areaId: 'area' }, { kind: 'area', id: 'area' }],
    ['current None', { projectId: undefined, sectionId: undefined, areaId: undefined }, { kind: 'none' }],
];
describe('ordinary row destination selected direct planner', () => {
    it.each(cases)('matches actual RN full state and all nine SQL tables: %s', async (_name, patch, destination) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const source = task(patch);
        const rn = await openSqliteHost(seed(source)); let expected: AppData; let expectedRaw: Awaited<ReturnType<typeof raw>>;
        try { const loaded = useTaskStore.getState()._tasksById.get(ID)!;
            expect(await useTaskStore.getState().updateTask(ID, buildTaskMovePatch(destination, loaded))).toEqual({ success: true });
            await flushPendingSave(); expected = rows(); expectedRaw = await raw(rn);
        } finally { await rn.close(); }
        const native = await openSqliteHost(seed(source));
        try { const input = request(destination), before = useTaskStore.getState()._tasksById.get(ID)!, prepared = value(await native.host.prepareRowTaskDestination(input)).prepared;
            const envelope = { request: input, prepared }; expect(Object.keys(prepared).sort()).toEqual(['version','kind','request','rawBefore','checklist','result'].sort());
            expect(value(native.host.validatePreparedRowTaskDestination(envelope))).toEqual({id:ID});
            expect(value(await native.host.commitPreparedRowTaskDestination(envelope))).toEqual({id:ID});
            expect(rows()).toEqual(expected!); expect(await raw(native)).toEqual(expectedRaw!); expect(await native.receiptIds()).toEqual([UUID]);
            expect(useTaskStore.getState()._tasksById.get(ID)!.rev).toBe(before.rev!+1);expect(useTaskStore.getState()._allTasks).toHaveLength(2);
        } finally { await native.close(); }
    });
    it.each(['inbox','next','waiting','someday','done','reference','archived'] as const)('matches actual RN row status and metadata normalization for %s', async status => {
        vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(NOW));const fixture=seed(task({status,...(status==='done'?{completedAt:NOW}:{}),...(status==='archived'?{archivedAt:NOW,cancelledAt:NOW}:{}),dueDate:'2026-11-01',isFocusedToday:false}));
        const rn=await openSqliteHost(fixture);let expected:AppData;try{const before=useTaskStore.getState()._tasksById.get(ID)!;expect(await useTaskStore.getState().updateTask(ID,buildTaskMovePatch({kind:'area',id:'area'},before))).toEqual({success:true});await flushPendingSave();expected=rows();}finally{await rn.close();}
        const sqlite=await openSqliteHost(fixture);try{const input=request({kind:'area',id:'area'}),prepared=value(await sqlite.host.prepareRowTaskDestination(input)).prepared;
            value(await sqlite.host.commitPreparedRowTaskDestination({request:input,prepared}));expect(rows()).toEqual(expected!);
            expect(useTaskStore.getState()._tasksById.get(ID)!.status).toBe(status);expect(useTaskStore.getState()._allTasks).toHaveLength(2);expect(prepared.checklist.witness.ids).toEqual([]);expect(prepared.checklist.witness.recurrenceProjection).toBeNull();
        }finally{await sqlite.close();}
    });
    it('returns the exact existing picker shape and paging/search semantics without writes',async()=>{
        vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(NOW));const fixture=seed();fixture.projects!.push(...Array.from({length:103},(_,i)=>({...fixture.projects![0],id:`p${i}`,title:i===102?'Café terminal':`Project ${i}`,order:i+2})));const sqlite=await openSqliteHost(fixture);
        try{const input={...displayed(),query:'',offset:0,limit:100},before=await raw(sqlite),first=value(await sqlite.host.getRowTaskDestinationOptions(input));
            expect(Object.keys(first).sort()).toEqual(['version','id','taskRevision','query','offset','limit','total','hasMore','nextOffset','choices','labels'].sort());expect(Object.keys(first.labels).sort()).toEqual(['title','search','projects','areas','cancel','more','retry','noMatches'].sort());
            expect(first.choices[0]).toEqual({kind:'none',id:'',label:'None',selected:false});expect(first.choices[1]).toMatchObject({kind:'project',id:'parent',selected:true});expect(first.nextOffset).toBe(100);
            const last=value(await sqlite.host.getRowTaskDestinationOptions({...input,offset:100}));expect(last.hasMore).toBe(false);expect(last.nextOffset).toBeNull();
            const search=value(await sqlite.host.getRowTaskDestinationOptions({...input,query:'  CAFÉ  '}));expect(search.query).toBe('  CAFÉ  ');expect(search.choices.map(row=>row.id)).toEqual(['','p102']);
            expect(value(await sqlite.host.getRowTaskDestinationOptions({...input,query:'界'.repeat(2000)})).choices.map(row=>row.id)).toEqual(['']);
            expect(value(await sqlite.host.getRowTaskDestinationOptions({...input,offset:10_000,limit:1})).choices).toEqual([]);expect(await raw(sqlite)).toEqual(before);expect(await sqlite.receiptIds()).toEqual([]);
            await sqlite.client().run('UPDATE projects SET title=? WHERE id=?',['x'.repeat(2_100_000),'other']);const huge=await raw(sqlite);expect(await sqlite.host.getRowTaskDestinationOptions({...input,limit:100})).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});expect(await raw(sqlite)).toEqual(huge);
        }finally{await sqlite.close();}
    });
    it.each(['archived-parent','deleted-parent','purged-parent','deleted-section'] as const)('refuses a readonly %s source before any journal or row write',async reason=>{
        vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(NOW));const sqlite=await openSqliteHost(seed());try{const input=request();
            if(reason==='deleted-section')await sqlite.client().run('UPDATE sections SET deletedAt=? WHERE id=?',[NOW,'section']);else if(reason==='archived-parent')await sqlite.client().run('UPDATE projects SET status=? WHERE id=?',['archived','parent']);else await sqlite.client().run(`UPDATE projects SET ${reason==='purged-parent'?'purgedAt':'deletedAt'}=? WHERE id=?`,[NOW,'parent']);
            const before=await raw(sqlite);expect(await sqlite.host.getRowTaskDestinationOptions({...displayed(),query:'',offset:0,limit:100})).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});expect(await sqlite.host.prepareRowTaskDestination(input)).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});expect(await raw(sqlite)).toEqual(before);expect(await sqlite.receiptIds()).toEqual([]);
        }finally{await sqlite.close();}
    });
    it.each(['project','area','section'] as const)('rechecks selected %s authority at Commit',async kind=>{
        vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(NOW));const sqlite=await openSqliteHost(seed());try{const input=request(kind==='area'?{kind:'area',id:'area'}:{kind:'project',id:kind==='section'?'parent':'other'}),prepared=value(await sqlite.host.prepareRowTaskDestination(input)).prepared;
            if(kind==='project')await sqlite.client().run('UPDATE projects SET status=? WHERE id=?',['archived','other']);else if(kind==='area')await sqlite.client().run('UPDATE areas SET deletedAt=? WHERE id=?',[NOW,'area']);else await sqlite.client().run('UPDATE sections SET projectId=? WHERE id=?',['other','section']);
            const before=await raw(sqlite);expect(await sqlite.host.commitPreparedRowTaskDestination({request:input,prepared})).toMatchObject({ok:false,error:{code:'STALE_REVISION'}});expect(await raw(sqlite)).toEqual(before);expect(await sqlite.receiptIds()).toEqual([]);
        }finally{await sqlite.close();}
    });
    it('rejects stale, missing, unavailable and malformed requests without writes',async()=>{
        vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(NOW));const sqlite=await openSqliteHost(seed());try{const input=request(),before=await raw(sqlite);
            expect(await sqlite.host.prepareRowTaskDestination({...input,taskRevision:'old'})).toMatchObject({ok:false,error:{code:'STALE_REVISION'}});
            for(const invalid of [{...input,source:'reference'},{...input,destination:{kind:'section',id:'section'}},{...input,destination:{kind:'none',id:'extra'}},{...input,extra:true}])expect(await sqlite.host.prepareRowTaskDestination(invalid as never)).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
            expect(await sqlite.host.prepareRowTaskDestination({...input,id:'missing'})).toMatchObject({ok:false,error:{code:'TASK_NOT_FOUND'}});expect(await sqlite.host.prepareRowTaskDestination({...input,destination:{kind:'project',id:'missing'}})).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
            expect(await raw(sqlite)).toEqual(before);expect(await sqlite.receiptIds()).toEqual([]);
            const prepared=value(await sqlite.host.prepareRowTaskDestination(input)).prepared,e={request:input,prepared};expect(sqlite.host.validatePreparedTaskChecklistWrite({request:prepared.checklist.request,prepared:prepared.checklist} as never)).toMatchObject({ok:false});expect(sqlite.host.validatePreparedReferenceTaskDestination(e as never)).toMatchObject({ok:false});
            for(const mutate of [(x:NativeRowTaskDestinationEnvelope)=>{x.prepared.checklist.witness.directClears=[];},(x:NativeRowTaskDestinationEnvelope)=>{x.prepared.result.id='other';},(x:NativeRowTaskDestinationEnvelope)=>{x.prepared.checklist.request.patch.status='done';}]){const forged=JSON.parse(JSON.stringify(e));mutate(forged);expect(sqlite.host.validatePreparedRowTaskDestination(forged)).toMatchObject({ok:false});expect(await sqlite.host.commitPreparedRowTaskDestination(forged)).toMatchObject({ok:false});}
            await loadNativeRequestReceipts(sqlite.client(),{durableCommands:['referenceTaskDestination']});expect(sqlite.host.validatePreparedRowTaskDestination(e).ok).toBe(true);expect(await sqlite.host.prepareRowTaskDestination(input)).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});expect(await sqlite.host.commitPreparedRowTaskDestination(e)).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});expect(sqlite.host.rowTaskDestinationOutcome(e)).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});expect(await raw(sqlite)).toEqual(before);
        }finally{await sqlite.close();}
    });
    it.each(['warm','cold after failed COMMIT','successful owned explicit flush','warm after repeated failed explicit flush'] as const)('retains exact owed bytes through failed COMMIT, %s retry and later edits',async mode=>{
        vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(NOW));let fail=false;const sqlite=await openSqliteHost(seed(),c=>({...c,run:async(sql,args)=>{if(fail&&sql==='COMMIT')throw new Error('Injected row destination COMMIT');return c.run(sql,args);}}));try{const input=request({kind:'project',id:'other'}),e={request:input,prepared:value(await sqlite.host.prepareRowTaskDestination(input)).prepared},bytes=JSON.stringify(e),before=await raw(sqlite);
            fail=true;expect(await sqlite.host.commitPreparedRowTaskDestination(e)).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});expect(await raw(sqlite)).toEqual(before);expect(await sqlite.receiptIds()).toEqual([]);const owned=useTaskStore.getState(),ownedStatus=getPersistenceStatus();if(mode==='warm after repeated failed explicit flush'){await useTaskStore.getState().persistSnapshot();await expect(flushPendingSave()).rejects.toThrow();expect(await raw(sqlite)).toEqual(before);expect(await sqlite.receiptIds()).toEqual([]);const after=useTaskStore.getState(),afterStatus=getPersistenceStatus();expect({tasksSame:owned._allTasks===after._allTasks,settingsSame:owned.settings===after.settings,lastChangeSame:owned.lastDataChangeAt===after.lastDataChangeAt,failureSame:owned.persistenceFailure===after.persistenceFailure,generationSame:ownedStatus.generation===afterStatus.generation}).toEqual({tasksSame:true,settingsSame:true,lastChangeSame:true,failureSame:false,generationSame:false});fail=false;value(await sqlite.host.commitPreparedRowTaskDestination(e));}
            if(mode==='cold after failed COMMIT'){fail=false;await sqlite.restart(undefined,{recoveryLoad:true});}
            if(mode==='successful owned explicit flush'){fail=false;await useTaskStore.getState().persistSnapshot();await flushPendingSave();expect(await sqlite.receiptIds()).toEqual([UUID]);expect(value(sqlite.host.rowTaskDestinationOutcome(e))).toEqual({id:ID});}
            if(mode==='warm'){await flushPendingSave();expect(useTaskStore.getState().persistenceFailure).toBe(owned.persistenceFailure);}
            fail=false;value(await sqlite.host.commitPreparedRowTaskDestination(e));expect(JSON.stringify(e)).toBe(bytes);const unused=JSON.parse(bytes) as NativeRowTaskDestinationEnvelope;const fresh='00000000-0000-4000-8000-000000000191';unused.request.requestId=fresh;unused.prepared.request.requestId=fresh;unused.prepared.checklist.request.requestId=fresh;expect(value(sqlite.host.rowTaskDestinationOutcome(unused))).toBeNull();expect(await sqlite.host.commitPreparedRowTaskDestination(unused)).toMatchObject({ok:false,error:{code:'STALE_REVISION'}});expect(await sqlite.receiptIds()).toEqual([UUID]);await sqlite.client().run('UPDATE tasks SET title=? WHERE id=?',['Later title',ID]);await sqlite.client().run('UPDATE projects SET status=? WHERE id=?',['archived','other']);await sqlite.restart(undefined,{recoveryLoad:true});const later=await raw(sqlite);expect(value(sqlite.host.rowTaskDestinationOutcome(e))).toEqual({id:ID});value(await sqlite.host.commitPreparedRowTaskDestination(e));expect(await raw(sqlite)).toEqual(later);
        }finally{fail=false;await sqlite.close();}
    });
    it('does not poison a request or mint a receipt after a pre-landing saved-read failure',async()=>{
        vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(NOW));let fail=false,hits=0;const sqlite=await openSqliteHost(seed(),c=>({...c,all:async(sql,args)=>{if(fail&&sql.includes('FROM tasks')){hits++;throw new Error('Injected saved read');}return c.all(sql,args);}}));try{const input=request(),e={request:input,prepared:value(await sqlite.host.prepareRowTaskDestination(input)).prepared},before=await raw(sqlite);fail=true;expect(await sqlite.host.commitPreparedRowTaskDestination(e)).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});fail=false;expect(hits).toBeGreaterThan(0);await useTaskStore.getState().persistSnapshot();await flushPendingSave();expect(await raw(sqlite)).toEqual(before);expect(await sqlite.receiptIds()).toEqual([]);value(await sqlite.host.commitPreparedRowTaskDestination(e));
        }finally{fail=false;await sqlite.close();}
    });
    it('replays its frozen load projection across a cold timezone change',async()=>{
        vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-02T02:00:00.000Z'));vi.stubEnv('TZ','UTC');const sqlite=await openSqliteHost(seed(task({status:'waiting',startTime:'2026-11-02T06:00:00.000Z',isFocusedToday:true,dueDate:undefined,recurrence:undefined})));
        try{const input=request({kind:'area',id:'area'}),e={request:input,prepared:value(await sqlite.host.prepareRowTaskDestination(input)).prepared},bytes=JSON.stringify(e);expect(e.prepared.checklist.witness.source.isFocusedToday,'prepared source focus').toBe(true);expect(e.prepared.checklist.effect.tasks[0].after.isFocusedToday,'prepared effect focus').toBe(true);vi.stubEnv('TZ','America/New_York');await sqlite.restart(undefined,{recoveryLoad:true});value(await sqlite.host.commitPreparedRowTaskDestination(e));expect(useTaskStore.getState()._tasksById.get(ID)!.isFocusedToday).toBe(true);expect(JSON.stringify(e)).toBe(bytes);
        }finally{await sqlite.close();vi.unstubAllEnvs();}
    });

    it.each(['new reference','in-place content'] as const)('refuses ownership refresh after an unrelated %s change',async change=>{
        vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(NOW));let fail=false;const sqlite=await openSqliteHost(seed(),c=>({...c,run:async(sql,args)=>{if(fail&&sql==='COMMIT')throw new Error('Injected owned save');return c.run(sql,args);}}));
        try{const input=request(),e={request:input,prepared:value(await sqlite.host.prepareRowTaskDestination(input)).prepared};fail=true;expect(await sqlite.host.commitPreparedRowTaskDestination(e)).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});const before=await raw(sqlite);
            if(change==='new reference')useTaskStore.setState({_allPeople:[...useTaskStore.getState()._allPeople,{id:'later',name:'Later',createdAt:NOW,updatedAt:NOW}]});
            else useTaskStore.getState()._allTasks.find(row=>row.id==='ranked')!.title='Unrelated in-place edit';
            fail=false;expect(await sqlite.host.commitPreparedRowTaskDestination(e)).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});expect(await raw(sqlite)).toEqual(before);expect(await sqlite.receiptIds()).toEqual([]);
        }finally{fail=false;await sqlite.close();}
    });

    it('uses displayed revisions for consecutive same-Project then Area filing after clock rollback',async()=>{
        vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(NOW));const created='2026-11-02T12:00:00.000Z',sqlite=await openSqliteHost(seed(task({createdAt:created,updatedAt:created,recurrence:undefined})));
        try{const firstView=value(sqlite.host.getTaskView({id:ID})),first={...request({kind:'project',id:'parent'}),taskRevision:firstView.taskRevision};
            const one={request:first,prepared:value(await sqlite.host.prepareRowTaskDestination(first)).prepared};value(await sqlite.host.commitPreparedRowTaskDestination(one));
            const next=value(sqlite.host.getTaskView({id:ID})),[saved]=await sqlite.sql<{rev:number;revBy:string;updatedAt:string}>('SELECT rev,revBy,updatedAt FROM tasks WHERE id=?',[ID]);
            expect(saved.updatedAt).toBe(NOW);expect(next.taskRevision).toBe(`${saved.rev}:${saved.revBy}:${created}`);expect(next.taskRevision).not.toBe(`${saved.rev}:${saved.revBy}:${saved.updatedAt}`);
            const ref={id:ID,taskRevision:next.taskRevision};
            expect((await sqlite.host.getRowQuickStatusOptions(ref)).ok).toBe(true);
            const status={...ref,requestId:'00000000-0000-4000-8000-000000000193',status:'waiting' as const},statusPrepared=value(await sqlite.host.prepareRowQuickStatusWrite(status));expect(statusPrepared.kind).toBe('prepared');
            if(statusPrepared.kind==='prepared')expect(sqlite.host.validatePreparedRowQuickStatusWrite({request:status,prepared:statusPrepared.prepared}).ok).toBe(true);
            expect((await sqlite.host.getRowTaskBackdateOptions(ref)).ok).toBe(true);
            const backdate={...ref,requestId:'00000000-0000-4000-8000-000000000194',source:'row' as const,completedAt:NOW,timeSpentText:null},backdatePrepared=value(await sqlite.host.prepareRowTaskBackdate(backdate));expect(sqlite.host.validatePreparedRowTaskBackdate({request:backdate,prepared:backdatePrepared.prepared}).ok).toBe(true);
            const second={...request({kind:'area',id:'area'}),requestId:'00000000-0000-4000-8000-000000000192',taskRevision:next.taskRevision};
            expect((await sqlite.host.getRowTaskDestinationOptions({id:ID,taskRevision:next.taskRevision,query:'',offset:0,limit:100})).ok).toBe(true);
            const two={request:second,prepared:value(await sqlite.host.prepareRowTaskDestination(second)).prepared};value(await sqlite.host.commitPreparedRowTaskDestination(two));
            expect(useTaskStore.getState()._tasksById.get(ID)).toMatchObject({areaId:'area',rev:saved.rev+1});expect(await sqlite.receiptIds()).toEqual([UUID,second.requestId]);
        }finally{await sqlite.close();}
    });

});
