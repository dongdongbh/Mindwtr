import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqliteHost } from './screen-parity.replay';
import { loadNativeRequestReceipts, taskRevisionOf } from './native-request-receipts';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import { resolveTaskEditorBackdatedCompletion } from './task-editor-model';
import type { NativeRowTaskBackdateEnvelope, NativeRowTaskBackdateRequest } from './native-host-contract-task-checklist';
import type { AppData, Task } from './types';
import { retainTaxonomyEffects } from './taxonomy-catalog';
// Raw-byte preservation cases catalog existing labels before their baseline; legacy RN/native parity cases remain uncatalogued.

const uuidState = vi.hoisted(() => ({ count: 0 }));
vi.mock('./uuid', async original => ({ ...await original<typeof import('./uuid')>(),
    generateUUID: () => `00000000-0000-4000-8000-${String(300 + uuidState.count++).padStart(12, '0')}` }));
const NOW = '2026-10-03T13:00:00.000Z';
const CHOSEN = '2026-10-02T09:12:34.789Z';
const ID = 'row-backdate';
const UUID = '00000000-0000-4000-8000-000000000189';
const value = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`); return result.value;
};
const task = (patch: Partial<Task> = {}): Task => ({
    id: ID, title: '  Reference completion  ', status: 'next', description: 'Retain memo and metadata',
    createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-10-02T12:00:00.000Z', rev: 3, revBy: 'device-a',
    tags: ['#first', '#second'], contexts: ['@home'], projectId: 'parent', sectionId: 'section',
    order: 2, orderNum: 2, boardOrder: 7, timeSpentMinutes: 45,
    checklist: [{ id: 'duplicate', title: 'Keep', isCompleted: true }, { id: 'duplicate', title: '  ', isCompleted: false }],
    attachments: [{ id: 'attachment', kind: 'file', title: 'proof.txt', uri: 'file:///proof.txt', createdAt: NOW, updatedAt: NOW }],
    ...patch,
});
const seed = (source = task(), enabled = false): Partial<AppData> => ({
    tasks: [source],
    projects: [{ id: 'parent', title: 'Parent', status: 'active', color: '#94a3b8', order: 0, tagIds: [],
        createdAt: NOW, updatedAt: NOW, rev: 2, revBy: 'device-a' }],
    sections: [{ id: 'section', projectId: 'parent', title: 'Section', order: 0, createdAt: NOW, updatedAt: NOW }],
    areas: [{ id: 'area', name: 'Area', order: 0, createdAt: NOW, updatedAt: NOW }],
    people: [{ id: 'person', name: 'Person', createdAt: NOW, updatedAt: NOW }],
    settings: { deviceId: 'device-a', analyticsProfileId: UUID, features: { pomodoro: enabled },
        gtd: { autoArchiveDays: 1, focusTaskLimit: 1, pomodoro: { linkTask: enabled } } },
});
type Sqlite = Awaited<ReturnType<typeof openSqliteHost>>;
const tables = ['tasks', 'projects', 'sections', 'areas', 'people', 'settings', 'saved_filters', 'schema_migrations', 'calendar_sync'];
const raw = async (sqlite: Sqlite) => Object.fromEntries(await Promise.all(tables.map(async table => [table,
    { schema: await sqlite.sql(`PRAGMA table_info(${table})`), rows: await sqlite.sql(`SELECT rowid AS evidenceRowid,* FROM ${table} ORDER BY rowid`) }])));
const rows = () => { const s = useTaskStore.getState(); return JSON.parse(JSON.stringify({ tasks: s._allTasks, projects: s._allProjects,
    sections: s._allSections, areas: s._allAreas, people: s._allPeople, settings: s.settings })) as AppData; };
const displayed = () => ({ id: ID, taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get(ID)!) });
const request = (timeSpentText: string | null = null, completedAt = CHOSEN): NativeRowTaskBackdateRequest => ({
    ...displayed(), requestId: UUID, source: 'row', completedAt, timeSpentText,
});
const prepare = async (sqlite: Sqlite, input = request()): Promise<NativeRowTaskBackdateEnvelope> => {
    const result = value(await sqlite.host.prepareRowTaskBackdate(input));
    return { request: input, prepared: result.prepared };
};
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('Shared row backdate uses the exact RN row-completion patch without Undo', () => {
    it('returns null current-time seed and normalized minutes without any write or device initialization', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed(task({ completedAt: CHOSEN, timeSpentMinutes: 100_005 }), true));
        try {
            useTaskStore.setState({ settings: { ...useTaskStore.getState().settings, deviceId: undefined } });
            const before = await raw(sqlite); const options = value(await sqlite.host.getRowTaskBackdateOptions(displayed()));
            expect(Object.keys(options).sort()).toEqual(['title', 'saveLabel', 'cancelLabel', 'taskId', 'taskRevision', 'initialValue',
                'initialEpochMilliseconds', 'showTimeSpent', 'initialTimeSpentMinutes', 'timeSpentLabel', 'timeSpentPlaceholder'].sort());
            expect(options).toMatchObject({ taskId: ID, initialValue: null, initialEpochMilliseconds: null, showTimeSpent: true, initialTimeSpentMinutes: 100_000 });
            expect(useTaskStore.getState().settings.deviceId).toBeUndefined();
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });
    it.each([
        ['hidden preserves', null, false], ['blank clears', '', true], ['leading zero', '00073', true],
        ['clamps', '100001', true], ['zero clears', '0', true], ['shared digit extraction', '1a2', true],
    ] as const)('matches actual RN full content and all nine raw tables: %s', async (_name, text, enabled) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const source = task({ isFocusedToday: true, focusOrder: 2, completedAt: '2020-01-01T00:00:00.123Z' });
        const rn = await openSqliteHost(seed(source, enabled)); let expected: AppData; let expectedRaw: Awaited<ReturnType<typeof raw>>;
        try {
            const patch = resolveTaskEditorBackdatedCompletion({ completedAt: CHOSEN, ...(text !== null ? { timeSpentText: text } : {}) })!;
            expect(await useTaskStore.getState().updateTask(ID, patch)).toEqual({ success: true });
            await flushPendingSave(); expected = rows(); expectedRaw = await raw(rn);
        } finally { await rn.close(); }
        const native = await openSqliteHost(seed(source, enabled));
        try {
            const envelope = await prepare(native, request(text));
            expect(Object.keys(envelope.prepared).sort()).toEqual(['version', 'kind', 'request', 'rawBefore', 'checklist', 'result'].sort());
            expect(envelope.prepared).toMatchObject({ version: 2, kind: 'rowBackdate', result: { id: ID }, checklist: { version: 2, kind: 'save' } });
            expect(value(native.host.validatePreparedRowTaskBackdate(envelope))).toEqual({ id: ID });
            expect(value(await native.host.commitPreparedRowTaskBackdate(envelope))).toEqual({ id: ID });
            expect(rows()).toEqual(expected!); expect(await raw(native)).toEqual(expectedRaw!);
            expect(rows().tasks.find(row => row.id === ID)).toMatchObject({ status: 'done', completedAt: CHOSEN, isFocusedToday: false });
            expect(envelope.prepared.result).not.toHaveProperty('completion');
            if (text === '') expect(envelope.prepared.checklist.witness.directClears).toContain('timeSpentMinutes');
        } finally { await native.close(); }
    });
    it.each([
        ['strict date-only', { recurrence: { rule: 'daily', strategy: 'strict', seriesId: ID }, dueDate: '2026-10-01' }],
        ['after-completion date-only', { recurrence: { rule: 'daily', strategy: 'after-completion', seriesId: ID }, dueDate: '2026-10-01' }],
        ['after-completion datetime DST', { recurrence: { rule: 'weekly', strategy: 'after-completion', seriesId: ID }, startTime: '2026-09-01T09:12:34.789Z', dueDate: '2026-09-02T09:12:34.789Z' }],
        ['COUNT exhausted', { recurrence: { rule: 'daily', strategy: 'after-completion', seriesId: ID, count: 1 } }],
    ] as const)('anchors recurrence to selected time and matches actual RN all rows: %s', async (_name, patch) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); uuidState.count = 0;
        const source = task(patch as Partial<Task>); const rn = await openSqliteHost(seed(source));
        let expected: AppData; let expectedRaw: Awaited<ReturnType<typeof raw>>;
        try { expect(await useTaskStore.getState().updateTask(ID, { status: 'done', completedAt: CHOSEN })).toEqual({ success: true });
            await flushPendingSave(); expected = rows(); expectedRaw = await raw(rn); } finally { await rn.close(); }
        uuidState.count = 0; const native = await openSqliteHost(seed(source));
        try { const envelope = await prepare(native); value(await native.host.commitPreparedRowTaskBackdate(envelope));
            expect(rows()).toEqual(expected!); expect(await raw(native)).toEqual(expectedRaw!);
            expect(new Set(rows().tasks.map(row => row.id)).size).toBe(rows().tasks.length);
            value(await native.host.commitPreparedRowTaskBackdate(envelope)); expect(rows()).toEqual(expected!);
        } finally { await native.close(); }
    });
    it.each(['2026-11-01T05:30:00.789Z', '+020000-01-01T00:00:00.123Z'])('commits exact canonical milliseconds/extended instant %s', async instant => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try { const envelope = await prepare(sqlite, request(null, instant)); value(await sqlite.host.commitPreparedRowTaskBackdate(envelope));
            expect(useTaskStore.getState()._tasksById.get(ID)?.completedAt).toBe(instant);
        } finally { await sqlite.close(); }
    });
    it.each(['inbox','next','waiting','someday','reference','archived','cancelled'] as const)('matches actual RN status/stamp/recurrence policy for %s',async status=>{
        vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(NOW));uuidState.count=0;
        const source=task({status:status==='cancelled'?'archived':status,completedAt:status==='archived'?'2020-01-01T00:00:00.000Z':undefined,
            cancelledAt:status==='cancelled'?'2026-10-01T12:00:00.000Z':undefined,recurrence:{rule:'daily',strategy:'after-completion',seriesId:ID},dueDate:'2026-10-01'});
        const rn=await openSqliteHost(seed(source));let expected:AppData,expectedRaw;
        try{expect(await useTaskStore.getState().updateTask(ID,{status:'done',completedAt:CHOSEN})).toEqual({success:true});await flushPendingSave();expected=rows();expectedRaw=await raw(rn);}finally{await rn.close();}
        uuidState.count=0;const db=await openSqliteHost(seed(source));
        try{const e=await prepare(db);value(await db.host.commitPreparedRowTaskBackdate(e));expect(rows()).toEqual(expected!);expect(await raw(db)).toEqual(expectedRaw);
            expect(useTaskStore.getState()._tasksById.get(ID)).toMatchObject({status:'done',completedAt:CHOSEN});expect(useTaskStore.getState()._tasksById.get(ID)?.cancelledAt).toBeUndefined();
            if(status==='archived'||status==='cancelled')expect(rows().tasks).toHaveLength(1);
            expect(e.prepared.result).toEqual({id:ID});expect(e.prepared.result).not.toHaveProperty('completion');
        }finally{await db.close();}
    });    it('rejects malformed/source/feature requests and keeps generic checklist proof grammar closed',async()=>{
        vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(NOW));const db=await openSqliteHost(seed());
        try{const input=request(),e=await prepare(db),before=await raw(db);
            for(const bad of [{...input,source:'reference'},{...input,completedAt:'2026-10-02'},{...input,timeSpentText:undefined},{...input,timeSpentText:'1'.repeat(201)},{...input,extra:true}])
                expect(await db.host.prepareRowTaskBackdate(bad as NativeRowTaskBackdateRequest)).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
            expect(await db.host.prepareReferenceTaskBackdate(input as never)).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
            expect(await db.host.prepareRowTaskBackdate(request('25'))).toMatchObject({ok:false,error:{code:'STALE_REVISION'}});
            expect(db.host.validatePreparedTaskChecklistWrite({request:e.prepared.checklist.request,prepared:e.prepared.checklist} as never)).toMatchObject({ok:false});
            const forged=JSON.parse(JSON.stringify(e));forged.prepared.checklist.witness.futureBoundary=NOW;expect(db.host.validatePreparedRowTaskBackdate(forged)).toMatchObject({ok:false});
            await loadNativeRequestReceipts(db.client(),{durableCommands:['referenceTaskBackdate']});
            expect(db.host.validatePreparedRowTaskBackdate(e).ok).toBe(true);
            expect(await db.host.prepareRowTaskBackdate(input)).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});
            expect(await db.host.commitPreparedRowTaskBackdate(e)).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});
            expect(db.host.rowTaskBackdateOutcome(e)).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});
            expect(await raw(db)).toEqual(before);expect(await db.receiptIds()).toEqual([]);
        }finally{await db.close();}
    });
    it.each(['done','readonly-project','deleted-section','stale-display'] as const)('refuses %s rows without writing',async kind=>{
        vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(NOW));const fixture=seed();
        if(kind==='done')Object.assign(fixture.tasks![0],{status:'done',completedAt:NOW});
        if(kind==='readonly-project')fixture.projects![0].status='archived';

        const db=await openSqliteHost(fixture);
        try{if(kind==='deleted-section')await db.client().run('UPDATE sections SET deletedAt=? WHERE id=?',[NOW,'section']);
            const input=request();if(kind==='stale-display')input.taskRevision='old';const before=await raw(db);
            expect(await db.host.getRowTaskBackdateOptions({id:ID,taskRevision:input.taskRevision})).toMatchObject({ok:false});
            expect(await db.host.prepareRowTaskBackdate(input)).toMatchObject({ok:false});expect(await raw(db)).toEqual(before);expect(await db.receiptIds()).toEqual([]);
        }finally{await db.close();}
    });
    it.each(['raw-source','effective-parent','time-spent-setting'] as const)('rechecks %s before publishing the receipt',async kind=>{
        vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(NOW));const db=await openSqliteHost(seed(task(),true));
        try{const e=await prepare(db,request('25'));
            if(kind==='raw-source')await db.client().run('UPDATE tasks SET focusOrder=99 WHERE id=?',[ID]);
            else if(kind==='effective-parent')await db.client().run('UPDATE projects SET status=? WHERE id=?',['archived','parent']);
            else await db.client().run("UPDATE settings SET data=json_set(data,'$.gtd.pomodoro.linkTask',json('false')) WHERE id=1");
            const before=await raw(db);expect(await db.host.commitPreparedRowTaskBackdate(e)).toMatchObject({ok:false,error:{code:'STALE_REVISION'}});
            await flushPendingSave();expect(await raw(db)).toEqual(before);expect(await db.receiptIds()).toEqual([]);
        }finally{await db.close();}
    });
    it('retains exact owned bytes/IDs through repeated COMMIT failures and cold retry then uses the saved receipt before later edits',async()=>{
        vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(NOW));uuidState.count=0;let fail=false;
        const fixture=seed(task({recurrence:{rule:'daily',strategy:'after-completion',seriesId:ID},dueDate:'2026-10-01'}));
        fixture.tasks!.push(task({id:'raw-sibling',status:'waiting'}));
        const db=await openSqliteHost(fixture,c=>({...c,run:async(sql,args)=>{if(fail&&sql==='COMMIT')throw new Error('Injected row backdate COMMIT');return c.run(sql,args);}}));
        try{const e=JSON.parse(JSON.stringify(await prepare(db))),bytes=JSON.stringify(e),before=await raw(db);
            for(let i=0;i<2;i++){fail=true;expect(await db.host.commitPreparedRowTaskBackdate(e)).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});fail=false;expect(await raw(db)).toEqual(before);expect(await db.receiptIds()).toEqual([]);}
            await db.restart(undefined,{recoveryLoad:true});const allocationsBeforeCommit=uuidState.count;value(await db.host.commitPreparedRowTaskBackdate(e));expect(uuidState.count).toBe(allocationsBeforeCommit);expect(e.prepared.checklist.effect.tasks.filter((row: {before: Task | null})=>row.before===null).map((row: {after: Task})=>row.after.id)).toEqual(rows().tasks.filter(row=>row.id!==ID&&row.id!=='raw-sibling').map(row=>row.id));expect(JSON.stringify(e)).toBe(bytes);
            const other=JSON.parse(JSON.stringify(e));other.request.requestId='00000000-0000-4000-8000-000000000999';other.prepared.request.requestId=other.request.requestId;other.prepared.checklist.request.requestId=other.request.requestId;
            const landed=await raw(db);expect(value(db.host.rowTaskBackdateOutcome(other))).toBeNull();expect(await db.host.commitPreparedRowTaskBackdate(other)).toMatchObject({ok:false,error:{code:'STALE_REVISION'}});expect(await raw(db)).toEqual(landed);
            await db.client().run('UPDATE tasks SET description=?,rev=rev+1 WHERE id=?',['Later edit',ID]);await db.restart(undefined,{recoveryLoad:true});const later=await raw(db);
            expect(value(db.host.rowTaskBackdateOutcome(e))).toEqual({id:ID});value(await db.host.commitPreparedRowTaskBackdate(e));expect(await raw(db)).toEqual(later);
        }finally{fail=false;await db.close();}
    },30000);
    it('keeps selected date, recurrence and queued hidden Focus projection frozen across timezone-changing cold replay',async()=>{
        vi.useFakeTimers({toFake:['Date']});vi.stubEnv('TZ','UTC');vi.setSystemTime(new Date('2026-10-03T02:00:00.000Z'));uuidState.count=0;
        const fixture=seed(task({status:'waiting',isFocusedToday:true,startTime:'2026-10-03T06:00:00.000Z',recurrence:{rule:'daily',strategy:'after-completion',seriesId:ID}}));
        const db=await openSqliteHost(fixture);
        try{const e=JSON.parse(JSON.stringify(await prepare(db))),bytes=JSON.stringify(e);
            vi.stubEnv('TZ','America/New_York');await db.restart(undefined,{recoveryLoad:true});const allocationsBeforeCommit=uuidState.count;value(await db.host.commitPreparedRowTaskBackdate(e));
            expect(useTaskStore.getState()._tasksById.get(ID)).toMatchObject({status:'done',completedAt:CHOSEN,isFocusedToday:false});expect(uuidState.count).toBe(allocationsBeforeCommit);expect(e.prepared.checklist.effect.tasks.filter((row: {before: Task | null})=>row.before===null).map((row: {after: Task})=>row.after.id)).toEqual(rows().tasks.filter(row=>row.id!==ID&&row.id!=='raw-sibling').map(row=>row.id));expect(JSON.stringify(e)).toBe(bytes);
        }finally{await db.close();}
    });
    it('uses the row durable backdate origin for forced-Done next-action after autoarchive and rejects lost warm origin receipt',async()=>{
        vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(NOW));const fixture=seed();fixture.tasks!.push(task({id:'candidate',status:'waiting',sectionId:undefined}));
        const db=await openSqliteHost(fixture);
        try{const e=await prepare(db,request(null,'2026-09-20T12:00:00.000Z'));value(await db.host.commitPreparedRowTaskBackdate(e));await db.restart();
            expect(useTaskStore.getState()._tasksById.get(ID)?.status).toBe('archived');
            const origin={kind:'backdate' as const,envelope:e},options=value(await db.host.getReferenceProjectNextActionOptions({origin,params:{offset:0,revision:null}}))!;
            expect(options.candidates.items).toEqual(expect.arrayContaining([expect.objectContaining({id:'candidate'})]));
            const input={requestId:'00000000-0000-4000-8000-000000000998',origin:options.origin,promptRevision:options.promptRevision,action:'choose' as const,candidateId:'candidate',candidateRevision:taskRevisionOf(useTaskStore.getState()._tasksById.get('candidate')!)};
            const followup={request:input,prepared:value(await db.host.prepareReferenceProjectNextAction({request:input,origin})).prepared};
            await db.client().run('DELETE FROM native_request_receipts WHERE request_id=?',[UUID]);const before=await raw(db);
            expect(await db.host.getReferenceProjectNextActionOptions({origin,params:{offset:0,revision:null}})).toMatchObject({ok:false,error:{code:'STALE_REVISION'}});
            expect(await db.host.commitPreparedReferenceProjectNextAction(followup)).toMatchObject({ok:false,error:{code:'STALE_REVISION'}});expect(await raw(db)).toEqual(before);
        }finally{await db.close();}
    });
    it.each(['missing','replaced','query-error'] as const)('rolls back next-action after row origin %s race inside the transaction and exact retry succeeds',async drift=>{
        vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(NOW));let race=false,seen=false,inTransaction=false,proofReads=0,readFailure=false;
        const fixture=seed();fixture.tasks!.push(task({id:'candidate',status:'waiting'}));
        const db=await openSqliteHost(fixture,c=>({...c,all:async(sql,args)=>{
            const origin=sql.includes('FROM native_request_receipts WHERE request_id');if(origin&&inTransaction)proofReads++;
            if(origin&&readFailure)throw new Error('Injected row backdate origin read');const result=await c.all(sql,args);if(race&&origin)seen=true;return result;
        },run:async(sql,args)=>{if(race&&seen&&sql==='BEGIN IMMEDIATE'){race=false;
            if(drift==='missing')await c.run('DELETE FROM native_request_receipts WHERE request_id=?',[UUID]);
            else if(drift==='replaced')await c.run('UPDATE native_request_receipts SET reply=? WHERE request_id=?',[JSON.stringify({id:'foreign'}),UUID]);else readFailure=true;
        }const result=await c.run(sql,args);if(sql==='BEGIN IMMEDIATE')inTransaction=true;else if(sql==='COMMIT'||sql==='ROLLBACK')inTransaction=false;return result;}}));
        try{const e=await prepare(db);value(await db.host.commitPreparedRowTaskBackdate(e));const origin={kind:'backdate' as const,envelope:e};
            const options=value(await db.host.getReferenceProjectNextActionOptions({origin,params:{offset:0,revision:null}}))!;
            const input={requestId:'00000000-0000-4000-8000-000000000998',origin:options.origin,promptRevision:options.promptRevision,action:'choose' as const,candidateId:'candidate',candidateRevision:taskRevisionOf(useTaskStore.getState()._tasksById.get('candidate')!)};
            const next={request:input,prepared:value(await db.host.prepareReferenceProjectNextAction({request:input,origin})).prepared};
            const [receipt]=await db.sql<{method:string;reply:string;saved_at:string}>('SELECT * FROM native_request_receipts WHERE request_id=?',[UUID]),before=await raw(db);proofReads=0;race=true;
            expect(await db.host.commitPreparedReferenceProjectNextAction(next)).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});readFailure=false;
            expect(race).toBe(false);expect(seen).toBe(true);expect(proofReads).toBeGreaterThan(0);expect(inTransaction).toBe(false);expect(await raw(db)).toEqual(before);expect(await db.receiptIds()).not.toContain(input.requestId);
            await db.client().run('INSERT INTO native_request_receipts(request_id,method,reply,saved_at) VALUES(?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET method=excluded.method,reply=excluded.reply,saved_at=excluded.saved_at',[UUID,receipt.method,receipt.reply,receipt.saved_at]);
            value(await db.host.commitPreparedReferenceProjectNextAction(next));expect(useTaskStore.getState()._tasksById.get('candidate')?.status).toBe('next');
        }finally{race=false;readFailure=false;await db.close();}
    },30000);

});
