import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectTasksDeleteMethods, type NativeProjectTasksDeleteEnvelope } from './native-host-contract-project-bulk-delete';
import { buildSaveSnapshot } from './store-helpers';
import { loadNativeRequestReceipts, taskRevisionOf } from './native-request-receipts';
import { openSqliteHost } from './screen-parity.replay';
import { flushPendingSave, getStorageAdapter, resetForTests, useTaskStore } from './store';
import type { Task } from './types';
import { deterministicHash128 } from './uuid';
import { getProjectedRecurringTaskId } from './recurrence';

const NOW = '2026-10-03T13:00:00.000Z';
const BEFORE = '2026-09-30T12:34:56.789Z';
const DEVICE = 'project-delete-device';
const DELETE_ID = '00000000-0000-4000-8000-000000000739';
const UNDO_ID = '00000000-0000-4000-8000-000000000740';
const source = (id = 'source', fields: Partial<Task> = {}): Task => ({ id, title: 'Retained fixture', status: 'next',
    createdAt: BEFORE, updatedAt: BEFORE, tags: [], contexts: [], rev: 3, revBy: DEVICE, ...fields });
const seed = () => ({ tasks: [source('rich', { projectId: 'parent-a', sectionId: 'section',
    recurrence: { rule: 'weekly', strategy: 'strict', seriesId: 'series', weekdays: [1, 3] }, dueDate: '2026-10-12', reviewAt: '2026-10-09',
    timeSpentMinutes: 45, checklist: [{ id: 'step', title: 'Step', isCompleted: true }],
    attachments: [{ id: 'link', kind: 'link', title: 'Fixture', uri: 'https://example.com', createdAt: BEFORE, updatedAt: BEFORE }] }),
source('source', { projectId: 'parent-a' }), source('foreign', { status: 'reference', projectId: 'parent-b', tags: ['#Linked'] }),
...(['inbox', 'waiting', 'someday', 'reference', 'done', 'archived'] as const).map(status => source(status, { status, projectId: 'parent-a', ...(status === 'archived' ? { completedAt: BEFORE, archivedAt: BEFORE } : {}) })),
source('cancelled', { status: 'archived', cancelledAt: BEFORE, archivedAt: BEFORE, projectId: 'parent-a' }), source('sibling')],
projects: ['parent-a', 'parent-b'].map((id) => ({ id, title: 'Parent', status: 'active' as const, color: '#94a3b8', order: 0,
    tagIds: id === 'parent-a' ? ['#linked'] : [], createdAt: BEFORE, updatedAt: BEFORE, rev: 2, revBy: DEVICE })),
sections: [{ id: 'section', projectId: 'parent-a', title: 'Section', order: 0, createdAt: BEFORE, updatedAt: BEFORE }],
areas: [], people: [], settings: { deviceId: DEVICE, analyticsProfileId: DELETE_ID } });
const clone = <T>(item: T): T => JSON.parse(JSON.stringify(item)) as T;
const value = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`); return result.value;
};
const methods = () => createProjectTasksDeleteMethods({ readiness: () => ({ ok: true, value: null }),
    t: () => (key: string) => key, save: async () => {
        try { await flushPendingSave(); } catch { return { ok: false, error: { code: 'SAVE_FAILED', message: 'Injected failure' } }; }
        return useTaskStore.getState().persistenceFailure
            ? { ok: false, error: { code: 'SAVE_FAILED', message: 'Unresolved failure' } } : { ok: true, value: null };
    } });
const request = (taskIds = ['source'], requestId = DELETE_ID) => ({ requestId, source: 'project' as const, params: { projectId: 'parent-a', showCompleted: true, completedCollapsed: false, filters: {} }, taskIds,
    taskRevisions: Object.fromEntries(taskIds.map((id) => [id, taskRevisionOf(useTaskStore.getState()._tasksById.get(id)!)])) });
const prepare = async (host = methods(), input = request()) => ({ request: input, prepared: value(await host.prepareProjectTasksDelete(input)).prepared });
const prepareUndo = async (host: ReturnType<typeof methods>, deletion: NativeProjectTasksDeleteEnvelope, requestId = UNDO_ID) => {
    const input = { requestId, deleteRequestId: deletion.request.requestId };
    return { request: input, prepared: value(await host.prepareProjectTasksDeleteUndo({ request: input, delete: deletion })).prepared };
};
const rows = () => clone(buildSaveSnapshot(useTaskStore.getState()));
const canonical = async () => getStorageAdapter().saveData(buildSaveSnapshot(useTaskStore.getState()));
const payload = (prefix: string, envelope: unknown) => JSON.stringify([prefix, envelope], (_name, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const receiptMethod = (prefix: string, envelope: unknown) => `${prefix}:${deterministicHash128(payload(prefix, envelope)).map((part) => part.toString(16).padStart(8, '0')).join('')}`;
const raw = async (sqlite: Awaited<ReturnType<typeof openSqliteHost>>) => Object.fromEntries(await Promise.all([
    'tasks', 'projects', 'sections', 'areas', 'people', 'settings', 'saved_filters', 'schema_migrations', 'calendar_sync',
].map(async (table) => [table, {
    columns: await sqlite.sql(`PRAGMA table_info(${table})`), indexes: await sqlite.sql(`PRAGMA index_list(${table})`),
    foreignKeys: await sqlite.sql(`PRAGMA foreign_key_list(${table})`),
    definitions: await sqlite.sql('SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name = ? ORDER BY type,name', [table]),
    rows: await sqlite.sql<Record<string, unknown>>(`SELECT rowid AS _rowid, * FROM ${table} ORDER BY rowid`),
}])));
const receipts = (sqlite: Awaited<ReturnType<typeof openSqliteHost>>) => sqlite.sql('SELECT rowid AS _rowid, * FROM native_request_receipts ORDER BY request_id');
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); });
const clock = () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); };

describe('Project Delete/Undo actual RN and raw authority', () => {
    it('matches actual RN mixed-status batchDelete/restore and distinct fingerprints without changing rich metadata', async () => {
        clock(); const selected = ['source', 'rich', 'foreign', 'inbox', 'waiting', 'someday', 'reference', 'done', 'archived', 'cancelled'];
        const rn = await openSqliteHost(seed()); let deleted, deletedRaw, restored, restoredRaw;
        try { await canonical(); expect(await useTaskStore.getState().batchDeleteTasks(selected)).toEqual({ success: true });
            await flushPendingSave(); deleted = rows(); deletedRaw = await raw(rn);
            vi.setSystemTime(new Date('2026-10-03T13:01:00.000Z'));
            for (const id of selected) expect(await useTaskStore.getState().restoreTask(id)).toEqual({ success: true });
            await flushPendingSave(); restored = rows(); restoredRaw = await raw(rn);
        } finally { await rn.close(); }
        vi.setSystemTime(new Date(NOW)); const db = await openSqliteHost(seed());
        try { await canonical(); const host = methods(), deletion = await prepare(host, request(selected));
            expect(Object.keys(deletion.prepared).sort()).toEqual(['version','request','before','after','scope','deviceIdBefore','deviceIdToInitialize','updateAt','preparedLocalDay','preparedOffsetMinutes','boundaryOffsetMinutes','futureBoundary','dates','result'].sort());
            expect(host.validatePreparedProjectTasksDelete(deletion).ok).toBe(true);
            expect(value(await host.commitPreparedProjectTasksDelete(deletion)).count).toBe(selected.length);
            expect(rows()).toEqual(deleted); expect(await raw(db)).toEqual(deletedRaw);
            vi.setSystemTime(new Date('2026-10-03T13:01:00.000Z')); const undo = await prepareUndo(host, deletion);
            expect(value(await host.commitPreparedProjectTasksDeleteUndo(undo))).toEqual({ count: selected.length });
            expect(rows()).toEqual(restored); expect(await raw(db)).toEqual(restoredRaw);
            expect((await db.sql<{method:string}>('SELECT method FROM native_request_receipts ORDER BY request_id')).map(row => row.method))
                .toEqual([receiptMethod('projectTasksDelete', deletion), receiptMethod('projectTasksDeleteUndo', undo)]);
        } finally { await db.close(); }
    });
    it.each(['readonly-owner','outside','filtered','collapsed-completed','hidden-completed','unknown-param'] as const)('refuses %s selection with actual revisions', async kind => {
        clock(); const fixture = seed(); if (kind === 'readonly-owner') fixture.projects[1].status = 'archived' as never;
        const db = await openSqliteHost(fixture);
        try { const id = kind === 'readonly-owner' ? 'foreign' : kind === 'outside' ? 'sibling' : kind.includes('completed') ? 'done' : kind === 'unknown-param' ? 'rich' : 'source';
            const input = request([id]);
            if (kind === 'filtered') input.params.filters = { searchQuery: 'missing' } as never;
            if (kind === 'collapsed-completed') input.params.completedCollapsed = true;
            if (kind === 'hidden-completed') input.params.showCompleted = false;
            if (kind === 'unknown-param') (input.params as Record<string,unknown>).collapsedSectionIds = ['section'];
            const before = await raw(db); expect(await methods().prepareProjectTasksDelete(input)).toMatchObject({ok:false});
            expect(await raw(db)).toEqual(before); expect(await db.receiptIds()).toEqual([]);
        } finally { await db.close(); }
    });
    it.each([
        ['selected', 'UPDATE tasks SET description=? WHERE id=?', ['Concurrent','source']],
        ['membership', 'UPDATE projects SET tagIds=? WHERE id=?', ['[]','parent-a']],
        ['owner', 'UPDATE projects SET supportNotes=? WHERE id=?', ['Concurrent','parent-a']],
        ['options', 'UPDATE areas SET orderNum=? WHERE id=?', [99,'area']],
    ] as const)('refuses %s saved drift before any receipt', async (_kind,sql,args) => {
        clock(); const fixture = seed(); (fixture.areas as unknown[]) = [{id:'area',name:'Home',order:0,color:'#94a3b8',createdAt:BEFORE,updatedAt:BEFORE}];
        const db = await openSqliteHost(fixture);
        try { const host=methods(), deletion=await prepare(host); await db.client().run(sql,[...args]); const before=await raw(db);
            expect(await host.commitPreparedProjectTasksDelete(deletion)).toMatchObject({ok:false,error:{code:'STALE_REVISION'}});
            await flushPendingSave(); expect(await raw(db)).toEqual(before); expect(await db.receiptIds()).toEqual([]);
        } finally { await db.close(); }
    });
    it('rejects source/params/forged clock or scope and requires both Project receipt families', async () => {
        clock(); const db=await openSqliteHost(seed());
        try { const host=methods(), input=request(), deletion=await prepare(host), before=await raw(db);
            expect(await db.host.prepareArchivedTasksDelete(input as never)).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
            for(const bad of [{...input,source:'inbox'},{...input,extra:true},{...input,params:{...input.params,filterSheetOpen:true}}])
                expect(await host.prepareProjectTasksDelete(bad as never)).toMatchObject({ok:false});
            for(const field of ['futureBoundary','preparedLocalDay'] as const) { const bad=clone(deletion); bad.prepared[field]=field==='futureBoundary'?'2026-10-04T23:59:59.999Z':'2026-10-04'; expect(host.validatePreparedProjectTasksDelete(bad)).toMatchObject({ok:false}); }
            const forged=clone(deletion); forged.prepared.scope.tasks[0].title='Forged'; expect(await host.commitPreparedProjectTasksDelete(forged)).toMatchObject({ok:false});
            await loadNativeRequestReceipts(db.client(),{durableCommands:['projectTasksDelete']});
            expect(host.validatePreparedProjectTasksDelete(deletion).ok).toBe(true);
            expect(await host.prepareProjectTasksDelete(input)).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});
            expect(await host.commitPreparedProjectTasksDelete(deletion)).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});
            expect(host.projectTasksDeleteOutcome(deletion)).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});
            expect(await raw(db)).toEqual(before); expect(await db.receiptIds()).toEqual([]);
        } finally { await db.close(); }
    });
    it.each(['delete', 'wrong-source', 'wrong-reply', 'wrong-date'] as const)('requires fresh durable origin after warm ACK and %s drift, with saved own Undo precedence', async drift => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const host = methods(); const deletion = await prepare(host); value(await host.commitPreparedProjectTasksDelete(deletion)); const undo = await prepareUndo(host, deletion);
            const original = (await sqlite.sql<{ method: string; reply: string; saved_at: string }>('SELECT * FROM native_request_receipts WHERE request_id = ?', [DELETE_ID]))[0];
            if (drift === 'delete') await sqlite.client().run('DELETE FROM native_request_receipts WHERE request_id = ?', [DELETE_ID]);
            else if (drift === 'wrong-source') await sqlite.client().run('UPDATE native_request_receipts SET method = ? WHERE request_id = ?', [receiptMethod('referenceTasksDelete', deletion), DELETE_ID]);
            else if (drift === 'wrong-reply') await sqlite.client().run('UPDATE native_request_receipts SET reply = ? WHERE request_id = ?', [JSON.stringify({ count: 99 }), DELETE_ID]);
            else await sqlite.client().run('UPDATE native_request_receipts SET saved_at = ? WHERE request_id = ?', ['invalid', DELETE_ID]);
            expect(value(host.projectTasksDeleteOutcome(deletion))).not.toBeNull(); const before = await raw(sqlite); const proof = await receipts(sqlite);
            expect(await host.prepareProjectTasksDeleteUndo({ request: undo.request, delete: deletion })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await host.commitPreparedProjectTasksDeleteUndo(undo)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual(proof);
            await sqlite.client().run('INSERT INTO native_request_receipts(request_id,method,reply,saved_at) VALUES(?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET method=excluded.method,reply=excluded.reply,saved_at=excluded.saved_at', [DELETE_ID, original.method, original.reply, original.saved_at]);
            value(await host.commitPreparedProjectTasksDeleteUndo(undo));
            await sqlite.client().run('DELETE FROM native_request_receipts WHERE request_id = ?', [DELETE_ID]);
            await sqlite.client().run('UPDATE tasks SET description = ? WHERE id = ?', ['Later edit', 'source']); const later = await raw(sqlite);
            expect(value(await host.commitPreparedProjectTasksDeleteUndo(undo))).toEqual({ count: 1 }); expect(await raw(sqlite)).toEqual(later);
        } finally { await sqlite.close(); }
    });

    it.each(['remove', 'replace', 'query-error'] as const)('checks original receipt inside the Undo transaction after %s race and permits exact retry', async drift => {
        clock(); let armed = false; let preflight = false; let inTransaction = false; let proofReads = 0; let failRead = false;
        const sqlite = await openSqliteHost(seed(), client => ({ ...client, all: async (...args) => {
            const origin = args[0].includes('FROM native_request_receipts WHERE request_id');
            if (origin && inTransaction) proofReads++; if (origin && failRead) throw new Error('injected transaction proof error');
            const result = await client.all(...args); if (armed && origin) preflight = true; return result;
        }, run: async (sql, params) => {
            if (armed && preflight && sql === 'BEGIN IMMEDIATE') { armed = false;
                if (drift === 'remove') await client.run('DELETE FROM native_request_receipts WHERE request_id = ?', [DELETE_ID]);
                else if (drift === 'replace') await client.run('UPDATE native_request_receipts SET reply=? WHERE request_id=?',[JSON.stringify({count:999}),DELETE_ID]); else failRead = true;
            }
            const result = await client.run(sql, params);
            if (sql === 'BEGIN IMMEDIATE') inTransaction = true; else if (sql === 'COMMIT' || sql === 'ROLLBACK') inTransaction = false; return result;
        } }));
        try {
            const host = methods(); const deletion = await prepare(host); value(await host.commitPreparedProjectTasksDelete(deletion)); const undo = await prepareUndo(host, deletion);
            const original = (await sqlite.sql<{ method: string; reply: string; saved_at: string }>('SELECT * FROM native_request_receipts WHERE request_id = ?', [DELETE_ID]))[0];
            const before = await raw(sqlite); proofReads = 0; armed = true;
            expect(await host.commitPreparedProjectTasksDeleteUndo(undo)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            failRead = false; expect(armed).toBe(false); expect(preflight).toBe(true); expect(proofReads).toBeGreaterThan(0); expect(inTransaction).toBe(false);
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).not.toContain(UNDO_ID);
            await sqlite.client().run('INSERT INTO native_request_receipts(request_id,method,reply,saved_at) VALUES(?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET method=excluded.method,reply=excluded.reply,saved_at=excluded.saved_at', [DELETE_ID, original.method, original.reply, original.saved_at]);
            expect(value(await host.commitPreparedProjectTasksDeleteUndo(undo))).toEqual({ count: 1 });
        } finally { armed = false; failRead = false; await sqlite.close(); }
    }, 30_000);

    it('retains exact owed Delete/Undo through failed COMMIT and cold retry', async () => {
        clock(); let fault = false; const sqlite = await openSqliteHost(seed(), client => ({ ...client, run: async (...args) => {
            if (fault && args[0] === 'COMMIT') throw new Error('injected COMMIT'); return client.run(...args);
        } }));
        try {
            let host = methods(); const deletion = clone(await prepare(host)); const exactDelete = JSON.stringify(deletion); const before = await raw(sqlite);
            fault = true; expect(await host.commitPreparedProjectTasksDelete(deletion)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); fault = false;
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            await sqlite.restart(undefined, { recoveryLoad: true }); host = methods(); expect(JSON.stringify(deletion)).toBe(exactDelete);
            value(await host.commitPreparedProjectTasksDelete(deletion)); const deleted = await raw(sqlite); const undo = clone(await prepareUndo(host, deletion)); const exactUndo = JSON.stringify(undo);
            fault = true; expect(await host.commitPreparedProjectTasksDeleteUndo(undo)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); fault = false;
            expect(await raw(sqlite)).toEqual(deleted); expect(await sqlite.receiptIds()).toEqual([DELETE_ID]);
            await sqlite.restart(undefined, { recoveryLoad: true }); host = methods(); expect(JSON.stringify(undo)).toBe(exactUndo);
            expect(value(await host.commitPreparedProjectTasksDeleteUndo(undo))).toEqual({ count: 1 }); expect(await sqlite.receiptIds()).toEqual([DELETE_ID, UNDO_ID]);
        } finally { fault = false; await sqlite.close(); }
    }, 30_000);

    it.each(['missing','replaced','query-error'] as const)('keeps original receipt prerequisite armed after failed Undo and %s then explicit flush', async drift => {
        clock(); let fault=false, readFault=false, proofReads=0;
        const db=await openSqliteHost(seed(),c=>({...c,run:async(sql,args)=>{if(fault&&sql==='COMMIT')throw new Error('Injected Undo COMMIT');return c.run(sql,args);},
            all:async(sql,args)=>{if(sql.includes('FROM native_request_receipts WHERE request_id')){proofReads++;if(readFault)throw new Error('Injected origin read');}return c.all(sql,args);}}));
        try { let host=methods();const deletion=await prepare(host); value(await host.commitPreparedProjectTasksDelete(deletion)); const undo=await prepareUndo(host,deletion);
            const original=(await db.sql<{method:string;reply:string;saved_at:string}>('SELECT * FROM native_request_receipts WHERE request_id=?',[DELETE_ID]))[0];
            fault=true;expect(await host.commitPreparedProjectTasksDeleteUndo(undo)).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});fault=false;
            if(drift==='missing')await db.client().run('DELETE FROM native_request_receipts WHERE request_id=?',[DELETE_ID]);
            else if(drift==='replaced')await db.client().run('UPDATE native_request_receipts SET method=? WHERE request_id=?',['other:receipt',DELETE_ID]);
            const before=await raw(db), readsBefore=proofReads;readFault=drift==='query-error';
            await useTaskStore.getState().persistSnapshot();await expect(flushPendingSave()).rejects.toThrow();readFault=false;expect(proofReads).toBeGreaterThan(readsBefore);
            expect(await raw(db)).toEqual(before);expect(await db.receiptIds()).not.toContain(UNDO_ID);
            await db.client().run('INSERT INTO native_request_receipts(request_id,method,reply,saved_at) VALUES(?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET method=excluded.method,reply=excluded.reply,saved_at=excluded.saved_at',[DELETE_ID,original.method,original.reply,original.saved_at]);
            await db.restart(undefined,{recoveryLoad:true});host=methods();expect(value(await host.commitPreparedProjectTasksDeleteUndo(undo))).toEqual({count:1});
        } finally {fault=false;readFault=false;await db.close();}
    },30000);
    it('freezes focused hidden fields across timezone-changing cold Delete and Undo',async()=>{
        clock();vi.stubEnv('TZ','UTC');vi.setSystemTime(new Date('2026-10-03T02:00:00.000Z'));
        const fixture=seed();Object.assign(fixture.tasks.find(row=>row.id==='source')!,{status:'waiting',isFocusedToday:true,startTime:'2026-10-03T06:00:00.000Z'});
        const db=await openSqliteHost(fixture);
        try {let host=methods();const deletion=clone(await prepare(host));vi.stubEnv('TZ','America/New_York');await db.restart(undefined,{recoveryLoad:true});host=methods();value(await host.commitPreparedProjectTasksDelete(deletion));
            expect(useTaskStore.getState()._tasksById.get('source')).toMatchObject({isFocusedToday:true,status:'waiting'});
            vi.stubEnv('TZ','UTC');const undo=clone(await prepareUndo(host,deletion));vi.stubEnv('TZ','America/New_York');await db.restart(undefined,{recoveryLoad:true});host=methods();value(await host.commitPreparedProjectTasksDeleteUndo(undo));
            expect(useTaskStore.getState()._tasksById.get('source')).toMatchObject({isFocusedToday:true,status:'waiting'});
        }finally{await db.close();}
    });
    it('rejects prospective Undo overflow while the validated Delete envelope fits', async () => {
        clock();
        // Start with a genuine prepared command, then expand only the raw description
        // witnesses and their actual revision to match the larger saved fixture.
        const small = await openSqliteHost(seed()); let deletion: NativeProjectTasksDeleteEnvelope;
        try { deletion = clone(await prepare(methods())); } finally { await small.close(); }
        const description = 'x'.repeat(450_000), fixture = seed(), mutations: string[] = [];
        fixture.tasks.find(row => row.id === 'source')!.description = description;
        const db = await openSqliteHost(fixture, client => ({ ...client, run: async (sql, args) => {
            if (/^(?:INSERT|UPDATE|DELETE)\b/i.test(sql)) mutations.push(sql);
            return client.run(sql, args);
        } }));
        try {
            const host = methods(), input = request();
            deletion.request = input; deletion.prepared.request = input;
            for (const rows of [deletion.prepared.before, deletion.prepared.after, deletion.prepared.scope.tasks])
                rows.find(row => row.id === 'source')!.description = description;
            expect(new TextEncoder().encode(JSON.stringify(deletion)).length).toBeLessThan(2_000_000);
            expect(host.validatePreparedProjectTasksDelete(deletion)).toEqual({ ok: true, value: deletion.prepared.result });
            const before = await raw(db); mutations.length = 0;
            expect(await host.prepareProjectTasksDelete(input)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT',
                message: expect.stringContaining('Delete or Undo journal is too large') } });
            expect(await host.commitPreparedProjectTasksDelete(deletion)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT',
                message: 'Project Undo journal would be too large; select fewer tasks' } });
            expect(mutations).toEqual([]); expect(await raw(db)).toEqual(before); expect(await db.receiptIds()).toEqual([]);
        } finally { await db.close(); }
    });
    it('refuses unreadable durable origin before Undo admission without trusting the warm ACK',async()=>{
        clock();let fail=false;const db=await openSqliteHost(seed(),c=>({...c,all:async(sql,args)=>{if(fail&&sql.includes('FROM native_request_receipts WHERE request_id'))throw new Error('Injected origin read');return c.all(sql,args);}}));
        try{const host=methods(),deletion=await prepare(host);value(await host.commitPreparedProjectTasksDelete(deletion));const before=await raw(db);fail=true;
            expect(await host.prepareProjectTasksDeleteUndo({request:{requestId:UNDO_ID,deleteRequestId:DELETE_ID},delete:deletion})).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});fail=false;
            expect(await raw(db)).toEqual(before);expect(await db.receiptIds()).toEqual([DELETE_ID]);
        }finally{fail=false;await db.close();}
    });
    it('retries repeated failed warm Delete and Undo commits with exact frozen envelopes',async()=>{
        clock();let fail=false;const db=await openSqliteHost(seed(),c=>({...c,run:async(sql,args)=>{if(fail&&sql==='COMMIT')throw new Error('Repeated COMMIT');return c.run(sql,args);}}));
        try{const host=methods(),deletion=await prepare(host),before=await raw(db),bytes=JSON.stringify(deletion);
            for(let i=0;i<2;i++){fail=true;expect(await host.commitPreparedProjectTasksDelete(deletion)).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});fail=false;expect(await raw(db)).toEqual(before);expect(await db.receiptIds()).toEqual([]);}
            value(await host.commitPreparedProjectTasksDelete(deletion));expect(JSON.stringify(deletion)).toBe(bytes);const undo=await prepareUndo(host,deletion),deleted=await raw(db),undoBytes=JSON.stringify(undo);
            for(let i=0;i<2;i++){fail=true;expect(await host.commitPreparedProjectTasksDeleteUndo(undo)).toMatchObject({ok:false,error:{code:'SAVE_FAILED'}});fail=false;expect(await raw(db)).toEqual(deleted);expect(await db.receiptIds()).toEqual([DELETE_ID]);}
            value(await host.commitPreparedProjectTasksDeleteUndo(undo));expect(JSON.stringify(undo)).toBe(undoBytes);expect(await db.receiptIds()).toEqual([DELETE_ID,UNDO_ID]);
        }finally{fail=false;await db.close();}
    },30000);

});
