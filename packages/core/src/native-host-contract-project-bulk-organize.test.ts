import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqliteHost as openHost, value } from './screen-parity.replay';
import { flushPendingSave, getStorageAdapter, resetForTests, useTaskStore } from './store';
import { loadNativeRequestReceipts, taskRevisionOf } from './native-request-receipts';
import { buildSaveSnapshot } from './store-helpers';
import { EMPTY_BULK_ORGANIZE_DRAFT, BULK_ORGANIZE_NONE, buildBulkOrganizeInput, planBulkOrganize, type BulkOrganizeDraft } from './task-list-bulk-actions';
import { readInboxTasksOrganizeEnvelope } from './native-host-contract-inbox-bulk-organize';
import { readAreaDurableData } from './native-host-contract-area-durable';
import { referenceBatchModules } from './store-reference-batch-modules';
import type { NativeProjectTasksOrganizeEnvelope } from './native-host-contract-project-bulk-organize';
import type { AppData, Task } from './types';
import * as uuid from './uuid';
import * as logger from './logger';

const openSqliteHost: typeof openHost = (seed, wrap, bindings) => openHost(seed, wrap, bindings, { rejectConcurrentWrites: true });
const NOW = '2026-11-01T05:30:00.000Z', OLD = '2026-10-12T12:00:00.000Z';
const WRITE = '00000000-0000-4000-8000-000000000945';
const DEVICE = 'project-organize-device';
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, title: `PRIVATE task ${id}`, status: 'next', projectId: 'project', sectionId: 'section',
    createdAt: OLD, updatedAt: OLD, rev: 3, revBy: DEVICE, tags: ['#old', 'raw'], contexts: ['@old'], order: 2, orderNum: 2,
    description: 'Retain rich notes', timeSpentMinutes: 17, reminderPolicy: 'inherit', dueReminderLeadMinutes: 0,
    checklist: [{ id: 'one', title: 'Retain checked', isCompleted: true }], taskMode: 'list',
    attachments: [{ id: 'link', kind: 'link', title: 'Retain link', uri: 'https://example.invalid', createdAt: OLD }], ...extra });
const selected = ['next', 'waiting', 'inbox', 'someday', 'done', 'archived', 'cancelled', 'reference'];
const params = { projectId: 'project', showCompleted: true, completedCollapsed: false, filters: {} };
const seed = (): Partial<AppData> => ({ tasks: [
    task('next', { recurrence: { rule: 'daily', strategy: 'strict', seriesId: 'series' }, startTime: '2026-11-02', dueDate: '2026-11-03', reviewAt: '2026-11-04' }),
    task('waiting', { status: 'waiting', pushCount: 2, delegatedTo: 'Prior delegate' }), task('inbox', { status: 'inbox' }), task('someday', { status: 'someday' }),
    task('done', { status: 'done', completedAt: OLD }), task('archived', { status: 'archived', completedAt: OLD, archivedAt: OLD }),
    task('cancelled', { status: 'archived', cancelledAt: OLD, archivedAt: OLD }),
    task('reference', { status: 'reference', projectId: 'foreign', sectionId: 'foreign-section', tags: ['#match', '#old'] }),
    task('destination-member', { projectId: 'destination', sectionId: 'destination-section', order: 17, orderNum: 17 }),
    task('unselected'), task('unrelated', { projectId: 'unrelated', sectionId: undefined }),
], projects: ['project', 'foreign', 'destination', 'unrelated', 'option'].map(id => ({ id, title: `PRIVATE Project ${id}`, status: 'active',
    areaId: 'area', tagIds: id === 'project' ? ['#match'] : [], createdAt: OLD, updatedAt: OLD, rev: 2, revBy: DEVICE, order: 0, color: '#94a3b8' })),
sections: [['section', 'project'], ['foreign-section', 'foreign'], ['destination-section', 'destination']].map(([id, projectId]) =>
    ({ id, projectId, title: id, order: 0, createdAt: OLD, updatedAt: OLD })),
areas: ['area', 'destination-area'].map(id => ({ id, name: `PRIVATE ${id}`, order: 0, createdAt: OLD, updatedAt: OLD })),
people: [{ id: 'person', name: 'Person', createdAt: OLD, updatedAt: OLD }],
settings: { deviceId: DEVICE, analyticsProfileId: WRITE, gtd: { autoArchiveDays: 7 } } });
type Sqlite = Awaited<ReturnType<typeof openSqliteHost>>;
const raw = async (s: Sqlite) => Object.fromEntries(await Promise.all([
    'tasks', 'projects', 'sections', 'areas', 'people', 'settings', 'saved_filters', 'schema_migrations', 'calendar_sync',
].map(async table => [table, {
    columns: await s.sql(`PRAGMA table_info(${table})`), indexes: await s.sql(`PRAGMA index_list(${table})`),
    foreignKeys: await s.sql(`PRAGMA foreign_key_list(${table})`),
    definitions: await s.sql('SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name = ? ORDER BY type,name', [table]),
    rows: await s.sql(`SELECT rowid AS _rowid,* FROM ${table} ORDER BY rowid`),
}])));
const request = (draft: Partial<BulkOrganizeDraft> = { tags: 'new' }, taskIds = selected, scope = params) => ({ requestId: WRITE, source: 'project' as const, taskIds,
    taskRevisions: Object.fromEntries(taskIds.map(id => [id, taskRevisionOf(useTaskStore.getState()._tasksById.get(id)!)])),
    draft: { ...EMPTY_BULK_ORGANIZE_DRAFT, ...draft }, params: scope });
const prepare = async (s: Sqlite, input = request()): Promise<NativeProjectTasksOrganizeEnvelope> => {
    const result = value(await s.host.prepareProjectTasksOrganize(input));
    if (result.kind !== 'prepared') throw new Error('Expected changed Organize');
    return clone({ request: input, prepared: result.prepared });
};
const receipts = (s: Sqlite) => s.sql('SELECT rowid AS _rowid,* FROM native_request_receipts ORDER BY rowid');
const clock = () => { vi.stubEnv('TZ', 'America/New_York'); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); };
const identities = () => { let i = 0; vi.spyOn(uuid, 'generateUUID').mockImplementation(() => `10000000-0000-4000-8000-${String(i++).padStart(12, '0')}`); };
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('Project Organize actual RN/raw SQLite parity', () => {
    it.each([
        ['ordered additive Unicode tokens', { tags: 'raw,#old,新 #École #école', contexts: 'office,@old,@École @école' }],
        ['same Project and section clearing', { projectChoice: 'project' }],
        ['None Project keeps effective area', { projectChoice: BULK_ORGANIZE_NONE }],
        ['None Project and Area', { projectChoice: BULK_ORGANIZE_NONE, areaChoice: BULK_ORGANIZE_NONE }],
        ['Area only', { areaChoice: 'destination-area' }],
        ['Project wins over chosen Area and reserves destination order', { projectChoice: 'destination', areaChoice: 'destination-area' }],
        ['Waiting delegate and review', { status: 'waiting', delegateWho: '  PRIVATE team  ', reviewDate: '2026-11-02' }],
        ['date-only DST', { startDate: '2026-11-01', dueDate: '2026-11-02', reviewDate: '2026-11-03' }],
        ['Done recurrence with mixed previous statuses', { status: 'done', dueDate: '2026-11-10' }],
        ['Reference clears scheduling', { status: 'reference', startDate: '2026-11-01', dueDate: '2026-11-02' }],
        ['Next preserves ordinary status policy', { status: 'next' }],
        ['Inbox returns selected tasks for reprocessing', { status: 'inbox' }],
    ] satisfies [string, Partial<BulkOrganizeDraft>][])('matches real planBulkOrganize/buildBulkOrganizeInput/batchUpdateTasks across nine SQL domains: %s', async (_label, draft) => {
        clock(); const initial = seed(), rn = await openSqliteHost(initial); let expected, expectedRows, count = 0;
        try {
            await getStorageAdapter().saveData(buildSaveSnapshot(useTaskStore.getState())); identities();
            const plan = planBulkOrganize(selected, useTaskStore.getState()._tasksById, buildBulkOrganizeInput({ ...EMPTY_BULK_ORGANIZE_DRAFT, ...draft }));
            if (plan?.kind !== 'update') throw new Error('Expected RN update'); count = plan.updates.length;
            expect(await useTaskStore.getState().batchUpdateTasks(plan.updates)).toEqual({ success: true }); await flushPendingSave();
            expect(useTaskStore.getState().persistenceFailure).toBeNull(); expected = await raw(rn); expectedRows = clone(buildSaveSnapshot(useTaskStore.getState()));
        } finally { await rn.close(); }
        const s = await openSqliteHost(initial);
        try {
            await getStorageAdapter().saveData(buildSaveSnapshot(useTaskStore.getState())); identities(); const e = await prepare(s, request(draft));
            const before = await raw(s); expect(e.prepared.result).toEqual({ count, changed: true });
            expect(value(s.host.validatePreparedProjectTasksOrganize(e))).toEqual(e.prepared.result); expect(await raw(s)).toEqual(before);
            expect(value(await s.host.commitPreparedProjectTasksOrganize(e))).toEqual({ count, changed: true });
            expect(await raw(s)).toEqual(expected); expect(clone(buildSaveSnapshot(useTaskStore.getState()))).toEqual(expectedRows);
            expect(await s.receiptIds()).toEqual([WRITE]);
        } finally { await s.close(); }
    });
    it('all-Keep/no tokens is a validated no-op with no write, UUID allocation, device initialization, receipt or success log', async () => {
        clock(); const writes = vi.fn(); const s = await openSqliteHost(seed(), c => ({ ...c, run: async (sql, args) => {
            if (/^(INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)/i.test(sql)) writes(sql); return c.run(sql, args);
        } }));
        try {
            await s.client().run("UPDATE settings SET data=json_remove(data,'$.deviceId') WHERE id=1"); await s.restart(undefined, { recoveryLoad: true });
            const before = await raw(s); writes.mockClear(); const allocate = vi.spyOn(uuid, 'generateUUID'); const logs = vi.spyOn(logger, 'logInfo');
            expect(value(await s.host.prepareProjectTasksOrganize(request({ tags: ' , ', contexts: ' , ' })))).toEqual({ kind: 'noop', result: { count: 0, changed: false } });
            expect(await raw(s)).toEqual(before); expect(writes).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled(); expect(await receipts(s)).toEqual([]);
            expect(logs.mock.calls.filter(([message]) => message === 'Native Project bulk Organize confirmed')).toEqual([]);
            expect(await s.host.prepareProjectTasksOrganize(request({}, ['unrelated']))).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        } finally { await s.close(); }
    });
});

describe('Project Organize exact boundary and source scope', () => {
    it('validates every complete draft field, source and canonical Project params before any no-op', async () => {
        clock(); const s = await openSqliteHost(seed());
        try {
            const good = request({}), before = await raw(s);
            for (const bad of [{ ...good, source: 'inbox' }, { ...good, unknown: true }, { ...good, draft: {} },
                ...Object.keys(EMPTY_BULK_ORGANIZE_DRAFT).map(field => ({ ...good, draft: { ...good.draft, [field]: 1 } })),
                { ...good, draft: { ...good.draft, extra: true } }, { ...good, draft: { ...good.draft, status: 'waiting', delegateWho: ' ' } },
                { ...good, params: { ...params, offset: 0 } }, { ...good, params: { ...params, filterSheetOpen: true } },
                { ...good, taskRevisions: {} }]) {
                expect(await s.host.prepareProjectTasksOrganize(bad as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            }
            expect(await s.host.prepareInboxTasksOrganize(good as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await raw(s)).toEqual(before); expect(await receipts(s)).toEqual([]);
        } finally { await s.close(); }
    });
    it.each(['archived Project', 'readonly foreign Reference', 'hidden Done', 'filtered', 'stale revision'] as const)('refuses %s membership even for a no-op', async kind => {
        clock(); const f = seed(); if (kind === 'archived Project') f.projects![0].status = 'archived';
        if (kind === 'readonly foreign Reference') f.projects![1].status = 'archived'; const s = await openSqliteHost(f);
        try {
            const input = request({}, kind === 'readonly foreign Reference' ? ['reference'] : kind === 'hidden Done' ? ['done'] : ['next']);
            if (kind === 'hidden Done') input.params = { ...params, showCompleted: false };
            if (kind === 'filtered') input.params = { ...params, filters: { searchQuery: 'absent title' } };
            if (kind === 'stale revision') input.taskRevisions.next = 'stale'; const before = await raw(s);
            expect(await s.host.prepareProjectTasksOrganize(input)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(s)).toEqual(before); expect(await receipts(s)).toEqual([]);
        } finally { await s.close(); }
    });
    it.each([
        ['selected raw', 'UPDATE tasks SET description=? WHERE id=?', ['Concurrent', 'next']],
        ['destination order member', 'UPDATE tasks SET orderNum=? WHERE id=?', [99, 'destination-member']],
        ['picker Project option', 'UPDATE projects SET title=? WHERE id=?', ['Renamed', 'option']],
        ['picker Area option', 'UPDATE areas SET name=? WHERE id=?', ['Renamed', 'destination-area']],
        ['source Section', 'UPDATE sections SET title=? WHERE id=?', ['Renamed', 'section']],
        ['foreign parent', 'UPDATE projects SET status=? WHERE id=?', ['archived', 'foreign']],
        ['source membership', 'UPDATE projects SET tagIds=? WHERE id=?', ['[]', 'project']],
        ['settings', "UPDATE settings SET data=json_set(data,'$.gtd.autoArchiveDays',0) WHERE id=1", []],
    ] as const)('refuses stale %s saved authority before writing any cell', async (_label, sql, args) => {
        clock(); const s = await openSqliteHost(seed());
        try { const e = await prepare(s, request({ projectChoice: 'destination', tags: 'new' })); await s.client().run(sql, [...args]);
            await s.restart(undefined, { recoveryLoad: true }); const before = await raw(s);
            expect(await s.host.commitPreparedProjectTasksOrganize(e)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(s)).toEqual(before); expect(await receipts(s)).toEqual([]);
        } finally { await s.close(); }
    });
    it('keeps old Inbox reader closed and independently rejects forged raw BEFORE/count/effect or missing Project atomic slot', async () => {
        clock(); const s = await openSqliteHost(seed()), original = referenceBatchModules.projectOrganize;
        try {
            const e = await prepare(s), before = await raw(s);
            expect(readInboxTasksOrganizeEnvelope(e)).toBeNull();
            for (const mutate of [(x: NativeProjectTasksOrganizeEnvelope) => { x.prepared.effect.tasks[0].before.description = 'Forged'; },
                (x: NativeProjectTasksOrganizeEnvelope) => { x.prepared.result.count++; },
                (x: NativeProjectTasksOrganizeEnvelope) => { x.request.source = 'inbox' as never; x.prepared.request.source = 'inbox' as never; }]) {
                const bad = clone(e); mutate(bad); expect(s.host.validatePreparedProjectTasksOrganize(bad)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            }
            referenceBatchModules.projectOrganize = undefined;
            const read = value(await readAreaDurableData(false, true));
            expect(await useTaskStore.getState().commitPreparedProjectTasksOrganize(e.prepared, read.authority)).toMatchObject({ success: false });
            expect(read.authority.saveBoundary).toBeUndefined(); expect(await raw(s)).toEqual(before); expect(await receipts(s)).toEqual([]);
        } finally { referenceBatchModules.projectOrganize = original; await s.close(); }
    });
});

describe('Project Organize durable exact retry and frozen replay', () => {
    it.each(['before prepare', 'after prepared', 'after saved'] as const)('refuses unavailable durable receipt ownership %s', async when => {
        clock(); const s = await openSqliteHost(seed());
        try {
            const e = when === 'before prepare' ? null : await prepare(s);
            if (when === 'after saved') value(await s.host.commitPreparedProjectTasksOrganize(e!));
            await loadNativeRequestReceipts(s.client(), { durableCommands: ['projectTasksMove'] }); const before = await raw(s), saved = await receipts(s);
            expect(await s.host.prepareProjectTasksOrganize(request())).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            if (e) { expect(await s.host.commitPreparedProjectTasksOrganize(e)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
                expect(s.host.projectTasksOrganizeOutcome(e)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); }
            expect(await raw(s)).toEqual(before); expect(await receipts(s)).toEqual(saved);
        } finally { await s.close(); }
    });
    it('replays failed save cold, then keeps the saved receipt after later edits/deletion without a second log or write', async () => {
        clock(); let fail = false; const s = await openSqliteHost(seed(), c => ({ ...c, run: async (sql, args) => {
            if (fail && sql === 'COMMIT') throw new Error('Project Organize failed COMMIT'); return c.run(sql, args);
        } }));
        try {
            const e = await prepare(s), bytes = JSON.stringify(e), before = await raw(s), logs = vi.spyOn(logger, 'logInfo'); fail = true;
            expect(await s.host.commitPreparedProjectTasksOrganize(e)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(s)).toEqual(before); expect(await receipts(s)).toEqual([]); expect(value(s.host.projectTasksOrganizeOutcome(e))).toBeNull();
            expect(logs.mock.calls.filter(([message]) => message === 'Native Project bulk Organize confirmed')).toEqual([]);
            fail = false; await s.restart(undefined, { recoveryLoad: true });
            expect(value(await s.host.commitPreparedProjectTasksOrganize(e))).toEqual(e.prepared.result);
            expect(logs).toHaveBeenCalledWith('Native Project bulk Organize confirmed', expect.objectContaining({ force: true, context: {
                releaseCheck: 'v1.3.9/ios-project-bulk-organize', count: e.prepared.result.count, outcome: 'organized' } }));
            const savedReceipts = await receipts(s), logCount = logs.mock.calls.filter(([message]) => message === 'Native Project bulk Organize confirmed').length;
            await s.client().run('DELETE FROM tasks WHERE id=?', ['waiting']); await s.restart(undefined, { recoveryLoad: true }); const saved = await raw(s);
            expect(value(s.host.projectTasksOrganizeOutcome(e))).toEqual(e.prepared.result); expect(value(await s.host.commitPreparedProjectTasksOrganize(e))).toEqual(e.prepared.result);
            expect(await raw(s)).toEqual(saved); expect(await receipts(s)).toEqual(savedReceipts); expect(JSON.stringify(e)).toBe(bytes);
            expect(logs.mock.calls.filter(([message]) => message === 'Native Project bulk Organize confirmed')).toHaveLength(logCount);
            const forged = clone(e); forged.request.draft.tags = '#new'; forged.prepared.request.draft.tags = '#new';
            expect(await s.host.commitPreparedProjectTasksOrganize(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        } finally { fail = false; await s.close(); }
    });
    it.each([
        ['datetime', '2026-11-02T02:00:00.000Z', '2026-11-02T06:00:00.000Z', 'America/New_York'],
        ['date-only', '2026-11-02T12:00:00.000Z', '2026-11-03', 'Asia/Tokyo'],
    ])('freezes hidden/queued Focus normalization at atomic apply for %s through unlanded and saved cold replay', async (_label, now, startTime, timezone) => {
        clock(); vi.stubEnv('TZ', 'UTC'); vi.setSystemTime(new Date(now));
        const f = seed(); f.tasks = [task('queued', { status: 'reference', isFocusedToday: true, startTime })];
        const s = await openSqliteHost(f);
        try {
            const e = await prepare(s, request({ tags: 'new' }, ['queued'])), bytes = JSON.stringify(e);
            vi.stubEnv('TZ', timezone); await s.restart(undefined, { recoveryLoad: true });
            expect(value(s.host.validatePreparedProjectTasksOrganize(e))).toEqual(e.prepared.result);
            expect(value(await s.host.commitPreparedProjectTasksOrganize(e))).toEqual(e.prepared.result);
            const saved = await raw(s); await s.restart(undefined, { recoveryLoad: true });
            expect(value(s.host.projectTasksOrganizeOutcome(e))).toEqual(e.prepared.result);
            expect(value(await s.host.commitPreparedProjectTasksOrganize(e))).toEqual(e.prepared.result);
            expect(await raw(s)).toEqual(saved); expect(JSON.stringify(e)).toBe(bytes); expect(await s.receiptIds()).toEqual([WRITE]);
        } finally { await s.close(); }
    });
    it.each([false, true])('freezes date-only normalization, recurrence and allocated IDs across timezone restart (saved=%s)', async saved => {
        clock(); identities(); const s = await openSqliteHost(seed());
        try {
            const e = await prepare(s, request({ status: 'done', startDate: '2026-11-01', dueDate: '2026-11-02', reviewDate: '2026-11-03' })), bytes = JSON.stringify(e);
            expect(e.prepared.preparedOffsetMinutes).toBe(240); expect(e.prepared.boundaryOffsetMinutes).toBe(300); expect(e.prepared.allocatedIds).toHaveLength(3);
            if (saved) value(await s.host.commitPreparedProjectTasksOrganize(e));
            vi.stubEnv('TZ', 'Pacific/Auckland'); vi.setSystemTime(new Date('2027-03-25T10:30:00Z')); await s.restart(undefined, { recoveryLoad: true });
            expect(value(s.host.validatePreparedProjectTasksOrganize(e))).toEqual(e.prepared.result);
            expect(value(await s.host.commitPreparedProjectTasksOrganize(e))).toEqual(e.prepared.result);
            expect(value(s.host.projectTasksOrganizeOutcome(e))).toEqual(e.prepared.result); expect(JSON.stringify(e)).toBe(bytes);
            expect(e.prepared.effect.createdTasks).toHaveLength(1);
            for (const child of e.prepared.effect.createdTasks) expect(useTaskStore.getState()._tasksById.get(child.id)).toEqual(child);
            expect(await s.receiptIds()).toEqual([WRITE]);
        } finally { await s.close(); }
    });
});
