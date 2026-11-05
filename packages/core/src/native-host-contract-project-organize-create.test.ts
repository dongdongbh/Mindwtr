import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqliteHost as openHost, value } from './screen-parity.replay';
import { flushPendingSave, getStorageAdapter, resetForTests, useTaskStore } from './store';
import { buildSaveSnapshot } from './store-helpers';
import { loadNativeRequestReceipts, taskRevisionOf } from './native-request-receipts';
import { EMPTY_BULK_ORGANIZE_DRAFT, BULK_ORGANIZE_NONE, type BulkOrganizeDraft } from './task-list-bulk-actions';
import { createBulkOrganizeArea, createBulkOrganizeProject } from './bulk-organize-create';
import { readInboxOrganizeDestinationCreateEnvelope } from './native-host-contract-inbox-organize-create';
import type { NativeProjectOrganizeDestinationCreateRequest as Request, NativeProjectOrganizeDestinationCreateEnvelope as Envelope } from './native-host-contract-project-organize-create';
import type { AppData, Task } from './types';
import * as uuid from './uuid';
import * as logger from './logger';

const open: typeof openHost = (seed, wrap, bindings) => openHost(seed, wrap, bindings, { rejectConcurrentWrites: true });
type Sqlite = Awaited<ReturnType<typeof open>>;
const OLD = '2026-10-12T12:00:00.000Z', NOW = '2026-11-02T12:00:00.000Z';
const ID = '00000000-0000-4000-8000-000000001021', DEVICE = 'creation-device';
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, title: id, status: 'next', projectId: 'project',
    tags: [], contexts: [], createdAt: OLD, updatedAt: OLD, rev: 2, revBy: DEVICE, ...extra });
const selected = ['selected', 'archived', 'cancelled', 'reference'];
const params = { projectId: 'project', showCompleted: true, completedCollapsed: false, filters: {} };
const seed = (restore = false): Partial<AppData> => ({ tasks: [task('selected'),
    task('archived', { status: 'archived', completedAt: OLD, archivedAt: OLD }),
    task('cancelled', { status: 'archived', cancelledAt: OLD, archivedAt: OLD }),
    task('reference', { status: 'reference', projectId: 'foreign', tags: ['#linked'] }),
    task('unrelated', { projectId: 'unrelated' }),
    ...(restore ? [task('restored-task', { projectId: 'old-project', areaId: 'old-area', sectionId: 'old-section', deletedAt: OLD })] : [])],
    projects: [...['project', 'foreign', 'unrelated'].map(id => ({ id, title: id, status: 'active' as const, color: '#ef4444',
        tagIds: id === 'project' ? ['#linked'] : [], order: 2, createdAt: OLD, updatedAt: OLD, rev: 2, revBy: DEVICE })),
        ...(restore ? [{ id: 'old-project', title: 'Old', status: 'active' as const, color: '#ef4444', tagIds: [], order: 0,
            areaId: 'old-area', deletedAt: OLD, createdAt: OLD, updatedAt: OLD, rev: 2, revBy: DEVICE }] : [])],
    sections: restore ? [{ id: 'old-section', projectId: 'old-project', title: 'Old section', order: 0, deletedAt: OLD,
        createdAt: OLD, updatedAt: OLD, rev: 2, revBy: DEVICE }] : [],
    areas: [{ id: 'area', name: 'Home', color: '#ef4444', order: 3, createdAt: OLD, updatedAt: OLD, rev: 2, revBy: DEVICE },
        ...(restore ? [{ id: 'old-area', name: 'Restored', color: '#ef4444', order: 1, deletedAt: OLD,
            createdAt: OLD, updatedAt: OLD, rev: 2, revBy: DEVICE }] : [])],
    settings: { deviceId: DEVICE, analyticsProfileId: ID, gtd: { defaultProjectFlowMode: 'sequential', autoArchiveDays: 0 } } });
const raw = async (db: Sqlite) => Object.fromEntries(await Promise.all(['tasks', 'projects', 'sections', 'areas', 'people', 'settings',
    'saved_filters', 'schema_migrations', 'calendar_sync'].map(async table => [table, await db.sql(`SELECT * FROM ${table} ORDER BY rowid`)])));
const rows = () => clone(buildSaveSnapshot(useTaskStore.getState()));
const canonical = () => getStorageAdapter().saveData(buildSaveSnapshot(useTaskStore.getState()));
const clock = () => { vi.stubEnv('TZ', 'UTC'); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); };
const request = (db: Sqlite, kind: 'project' | 'area' = 'project', name = 'New destination', edit: Partial<BulkOrganizeDraft> = {}, ids = selected): Request => {
    const draft = { ...EMPTY_BULK_ORGANIZE_DRAFT, ...edit };
    const view = value(db.host.getBulkActions({ list: 'project', params, taskIds: ids, organize: { draft }, picker: { kind, query: name, offset: 0, limit: 100 } }));
    return { requestId: ID, source: 'project', kind, name, draft, offerRevision: view.revision, taskIds: ids,
        taskRevisions: view.taskRevisions, params };
};
const prepare = async (db: Sqlite, input = request(db)): Promise<Envelope> => {
    const planned = value(await db.host.prepareProjectOrganizeDestinationCreate(input));
    return clone({ request: input, prepared: planned.prepared });
};
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('Project Organize creation RN parity and boundaries', () => {
    it.each([
        ['project', 'Garden', { areaChoice: 'area' }, false],
        ['project', 'Garden', {}, false],
        ['project', 'Garden', { areaChoice: BULK_ORGANIZE_NONE }, false],
        ['area', 'New area', {}, false],
        ['area', 'Restored', {}, true],
    ] as const)('matches actual RN factory and nine SQL domains for %s %s restore=%s', async (kind, name, draft, restore) => {
        clock(); const initial = seed(restore), rn = await open(initial); let expected, expectedRows;
        try { await canonical(); vi.spyOn(uuid, 'generateUUID').mockReturnValue(ID);
            expect(kind === 'project' ? await createBulkOrganizeProject(name, 'areaChoice' in draft && draft.areaChoice === 'area' ? 'area' : undefined)
                : await createBulkOrganizeArea(name)).not.toBeNull();
            await flushPendingSave(); expected = await raw(rn); expectedRows = rows(); }
        finally { await rn.close(); vi.restoreAllMocks(); }
        const db = await open(initial);
        try { await canonical(); const e = await prepare(db, request(db, kind, name, draft)), before = await raw(db);
            expect(readInboxOrganizeDestinationCreateEnvelope(e)).toBeNull();
            expect(value(db.host.validatePreparedProjectOrganizeDestinationCreate(e))).toEqual(e.prepared.result);
            expect(await raw(db)).toEqual(before); expect(value(await db.host.commitPreparedProjectOrganizeDestinationCreate(e)))
                .toEqual({ id: restore ? 'old-area' : ID, changed: true });
            expect(await raw(db)).toEqual(expected); expect(rows()).toEqual(expectedRows); expect(await db.receiptIds()).toEqual([ID]); }
        finally { await db.close(); }
    });
    it('accepts an incomplete Waiting creation draft without applying it and rejects source/offer/existing-name changes', async () => {
        clock(); const db = await open(seed());
        try { const input = request(db, 'area', 'Waiting area', { status: 'waiting', delegateWho: '' });
            const before = clone(useTaskStore.getState()._allTasks);
            for (const bad of [{ ...input, source: 'inbox' }, { ...input, extra: true }, { ...input, draft: {} },
                { ...input, offerRevision: 'stale' }, { ...input, params: { ...params, filterSheetOpen: true } }])
                expect(await db.host.prepareProjectOrganizeDestinationCreate(bad as never)).toMatchObject({ ok: false });
            expect(await db.host.prepareInboxOrganizeDestinationCreate(input as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await db.host.prepareProjectOrganizeDestinationCreate(request(db, 'project', 'project'))).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            const e = await prepare(db, input); value(await db.host.commitPreparedProjectOrganizeDestinationCreate(e));
            expect(useTaskStore.getState()._allTasks).toEqual(before); }
        finally { await db.close(); }
    });
    it.each(['foreign read-only', 'outside Project'] as const)('refuses %s selection', async kind => {
        clock(); const fixture = seed(); if (kind === 'foreign read-only') fixture.projects![1].status = 'archived';
        const db = await open(fixture);
        try { const id = kind === 'foreign read-only' ? 'reference' : 'unrelated';
            const input = request(db, 'project', 'New destination', {}, [id]);
            input.taskRevisions = { [id]: taskRevisionOf(useTaskStore.getState()._tasksById.get(id)!) }; const before = await raw(db);
            expect(await db.host.prepareProjectOrganizeDestinationCreate(input)).toMatchObject({ ok: false });
            expect(await raw(db)).toEqual(before); expect(await db.receiptIds()).toEqual([]); }
        finally { await db.close(); }
    });
    it.each([
        ['membership', 'UPDATE projects SET tagIds=? WHERE id=?', ['[]', 'project']],
        ['selected raw', 'UPDATE tasks SET title=? WHERE id=?', ['Concurrent', 'selected']],
        ['Project option', 'UPDATE projects SET title=? WHERE id=?', ['Renamed', 'foreign']],
        ['Area order', 'UPDATE areas SET orderNum=? WHERE id=?', [99, 'area']],
        ['default flow', "UPDATE settings SET data=json_set(data,'$.gtd.defaultProjectFlowMode','parallel') WHERE id=1", []],
    ] as const)('refuses saved %s drift before writing', async (_label, sql, args) => {
        clock(); const db = await open(seed());
        try { const e = await prepare(db); await db.client().run(sql, [...args]); const before = await raw(db);
            expect(await db.host.commitPreparedProjectOrganizeDestinationCreate(e)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            await flushPendingSave(); expect(await raw(db)).toEqual(before); expect(await db.receiptIds()).toEqual([]); }
        finally { await db.close(); }
    });
    it('rejects forged scope/result and requires the new durable family before prepare, commit and outcome', async () => {
        clock(); const db = await open(seed());
        try { const e = await prepare(db), forged = clone(e); forged.prepared.result.id = 'forged';
            expect(db.host.validatePreparedProjectOrganizeDestinationCreate(forged)).toMatchObject({ ok: false });
            const rawBefore = await raw(db), scope = clone(e); scope.prepared.scope.inbox.tasks[0].title = 'Forged raw source';
            expect(await db.host.commitPreparedProjectOrganizeDestinationCreate(scope)).toMatchObject({ ok: false });
            expect(await raw(db)).toEqual(rawBefore); expect(await db.receiptIds()).toEqual([]);
            const input = request(db); await loadNativeRequestReceipts(db.client(), { durableCommands: ['projectTasksOrganize'] }); const before = await raw(db);
            expect(await db.host.prepareProjectOrganizeDestinationCreate(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await db.host.commitPreparedProjectOrganizeDestinationCreate(e)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(db.host.projectOrganizeDestinationCreateOutcome(e)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(db)).toEqual(before); expect(await db.receiptIds()).toEqual([]); }
        finally { await db.close(); }
    });
});

describe('Project creation exact receipts, retry and temporal publication', () => {
    it('replays failed COMMIT cold and keeps exact saved outcome after destination deletion', async () => {
        clock(); let fail = false; const db = await open(seed(), c => ({ ...c, run: async (sql, args) => {
            if (fail && sql === 'COMMIT') throw new Error('Injected Project create COMMIT'); return c.run(sql, args);
        } }));
        try { const e = await prepare(db), bytes = JSON.stringify(e), before = await raw(db), logs = vi.spyOn(logger, 'logInfo'); fail = true;
            expect(await db.host.commitPreparedProjectOrganizeDestinationCreate(e)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(db)).toEqual(before); expect(await db.receiptIds()).toEqual([]);
            fail = false; await db.restart(undefined, { recoveryLoad: true }); value(await db.host.commitPreparedProjectOrganizeDestinationCreate(e));
            expect(logs).toHaveBeenCalledWith('Native Project Organize destination confirmed', expect.objectContaining({ force: true, context: {
                releaseCheck: 'v1.3.9/ios-project-organize-destination-create', kind: 'project', outcome: 'saved' } }));
            await db.client().run('DELETE FROM projects WHERE id=?', [ID]); await db.restart(undefined, { recoveryLoad: true }); const saved = await raw(db);
            const count = logs.mock.calls.filter(([message]) => message === 'Native Project Organize destination confirmed').length;
            expect(value(db.host.projectOrganizeDestinationCreateOutcome(e))).toEqual(e.prepared.result);
            expect(value(await db.host.commitPreparedProjectOrganizeDestinationCreate(e))).toEqual(e.prepared.result);
            expect(await raw(db)).toEqual(saved); expect(JSON.stringify(e)).toBe(bytes);
            expect(logs.mock.calls.filter(([message]) => message === 'Native Project Organize destination confirmed')).toHaveLength(count); }
        finally { fail = false; await db.close(); }
    }, 30_000);
    it('refuses destination drift after failed save and explicit flushing never leaks the creation', async () => {
        clock(); let fail = false; const db = await open(seed(), c => ({ ...c, run: async (sql, args) => {
            if (fail && sql === 'COMMIT') throw new Error('Injected Project create COMMIT'); return c.run(sql, args);
        } }));
        try { const e = await prepare(db); fail = true;
            expect(await db.host.commitPreparedProjectOrganizeDestinationCreate(e)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            fail = false; await db.client().run('UPDATE areas SET orderNum=? WHERE id=?', [99, 'area']); const before = await raw(db);
            expect(await db.host.commitPreparedProjectOrganizeDestinationCreate(e)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            await flushPendingSave(); expect(await raw(db)).toEqual(before); expect(await db.receiptIds()).toEqual([]); }
        finally { fail = false; await db.close(); }
    }, 30_000);
    it('freezes selection and restoration normalization through timezone-changing cold recovery', async () => {
        clock(); vi.setSystemTime(new Date('2026-11-02T02:00:00.000Z')); const fixture = seed(true);
        fixture.tasks![0] = task('selected', { status: 'reference', isFocusedToday: true, startTime: '2026-11-02T06:00:00.000Z' });
        Object.assign(fixture.tasks!.find(row => row.id === 'restored-task')!, { status: 'waiting', isFocusedToday: true, startTime: '2026-11-02T06:00:00.000Z' });
        const db = await open(fixture);
        try { const e = await prepare(db, request(db, 'area', 'Restored')), bytes = JSON.stringify(e);
            expect(e.prepared.dates.some(row => row.value === '2026-11-02T06:00:00.000Z')).toBe(true);
            vi.stubEnv('TZ', 'America/New_York'); await db.restart(undefined, { recoveryLoad: true });
            value(await db.host.commitPreparedProjectOrganizeDestinationCreate(e));
            expect(useTaskStore.getState()._tasksById.get('selected')?.isFocusedToday).toBe(true);
            expect(useTaskStore.getState()._tasksById.get('restored-task')).toMatchObject({ isFocusedToday: true });
            expect(useTaskStore.getState()._tasksById.get('restored-task')?.deletedAt).toBeUndefined();
            const saved = await raw(db); await db.restart(undefined, { recoveryLoad: true });
            expect(value(db.host.projectOrganizeDestinationCreateOutcome(e))).toEqual(e.prepared.result);
            value(await db.host.commitPreparedProjectOrganizeDestinationCreate(e)); expect(await raw(db)).toEqual(saved); expect(JSON.stringify(e)).toBe(bytes); }
        finally { await db.close(); }
    });
});
