import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { openScratchSqlite, openSqliteHost as openHost } from './screen-parity.replay';
import { taskRevisionOf, NativeReceiptSqliteAdapter } from './native-request-receipts';
import { flushPendingSave, getStorageAdapter, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { readAreaDurableData } from './native-host-contract-area-durable';
import { buildSaveSnapshot } from './store-helpers';
import { EMPTY_BULK_ORGANIZE_DRAFT, BULK_ORGANIZE_NONE, buildBulkOrganizeInput,
    planBulkOrganize, type BulkOrganizeDraft } from './task-list-bulk-actions';
import type { AppData, Task } from './types';
import { retainTaxonomyEffects } from './taxonomy-catalog';
import type { NativeInboxTasksOrganizeEnvelope } from './native-host-contract-inbox-bulk-organize';
import { inboxTasksOrganizeEffect, inboxTasksOrganizeScope } from './native-host-contract-inbox-bulk-organize';
import { rawReferenceBatchScope } from './native-host-contract-reference-bulk-status';
import * as uuid from './uuid';
import * as logger from './logger';
import { referenceBatchModules } from './store-reference-batch-modules';

const openSqliteHost: typeof openHost = (seed, wrap, bindings) => openHost(seed, wrap, bindings, { rejectConcurrentWrites: true });
const NOW = '2026-11-01T05:30:00.000Z';
const BEFORE = '2026-10-02T12:34:56.789Z';
const REQUEST_ID = '00000000-0000-4000-8000-000000000743';
const DEVICE = 'inbox-organize-device';
const ORIGINAL_TZ = process.env.TZ;
const clone = <T>(input: T): T => JSON.parse(JSON.stringify(input)) as T;
const value = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`); return result.value;
};
const task = (id: string, fields: Partial<Task> = {}): Task => ({ id, title: `Task ${id}`, status: 'inbox',
    createdAt: BEFORE, updatedAt: BEFORE, tags: ['#old', 'raw'], contexts: ['@old'], rev: 3, revBy: DEVICE, ...fields });
const seed = (): Partial<AppData> => ({ tasks: [task('b', { projectId: 'p2', sectionId: 's2', description: 'Rich fixture',
    attachments: [{ id: 'link', kind: 'link', title: 'Fixture', uri: 'https://example.com', createdAt: BEFORE, updatedAt: BEFORE }],
    checklist: [{ id: 'step', title: 'Step', isCompleted: true }], timeSpentMinutes: 45,
    dueDate: '2026-11-03', startTime: '2026-11-02', reviewAt: '2026-11-04', focusOrder: 9 }),
    task('a', { projectId: 'p1', sectionId: 's1' }), task('destination-member', { status: 'next', projectId: 'p3', order: 17, orderNum: 17 }),
    task('sibling', { status: 'next', projectId: 'p1', order: 8, orderNum: 8 }),
    task('history', { status: 'done', projectId: 'p1', deletedAt: BEFORE }), task('unselected'),
    task('sentinel', { status: 'next', description: 'Untouched sentinel' })],
    projects: ['p1', 'p2', 'p3', 'option'].map(id => ({ id, title: `Parent ${id}`, status: 'active', color: '#94a3b8', order: 0,
        tagIds: [], areaId: 'area', createdAt: BEFORE, updatedAt: BEFORE, rev: 2, revBy: DEVICE })),
    sections: ['s1', 's2', 's3'].map((id, index) => ({ id, projectId: `p${index + 1}`, title: `Section ${id}`, order: 0,
        createdAt: BEFORE, updatedAt: BEFORE, rev: 1, revBy: DEVICE })),
    areas: ['area', 'destination-area'].map(id => ({ id, name: id, order: 0, createdAt: BEFORE, updatedAt: BEFORE })),
    people: [{ id: 'person', name: 'Person', createdAt: BEFORE, updatedAt: BEFORE }],
    settings: { deviceId: DEVICE, analyticsProfileId: REQUEST_ID, gtd: { autoArchiveDays: 7 } } });
type Sqlite = Awaited<ReturnType<typeof openSqliteHost>>;
const raw = async (sqlite: Sqlite) => Object.fromEntries(await Promise.all([
    'tasks', 'projects', 'sections', 'areas', 'people', 'settings', 'saved_filters', 'schema_migrations', 'calendar_sync',
].map(async table => [table, {
    columns: await sqlite.sql(`PRAGMA table_info(${table})`), indexes: await sqlite.sql(`PRAGMA index_list(${table})`),
    foreignKeys: await sqlite.sql(`PRAGMA foreign_key_list(${table})`),
    definitions: await sqlite.sql('SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name = ? ORDER BY type,name', [table]),
    rows: await sqlite.sql(`SELECT rowid AS _rowid, * FROM ${table} ORDER BY rowid`),
}])));
const rows = () => clone(buildSaveSnapshot(useTaskStore.getState()));
const canonical = async () => getStorageAdapter().saveData(buildSaveSnapshot(useTaskStore.getState()));
const request = (draft: Partial<BulkOrganizeDraft> = { tags: 'new' }, taskIds = ['a', 'b'], params = {}) => ({ requestId: REQUEST_ID, source: 'inbox' as const,
    taskIds, taskRevisions: Object.fromEntries(taskIds.map(id => [id, taskRevisionOf(useTaskStore.getState()._tasksById.get(id)!)])),
    draft: { ...EMPTY_BULK_ORGANIZE_DRAFT, ...draft }, params });
const receipts = (sqlite: Sqlite) => sqlite.sql('SELECT rowid AS _rowid,* FROM native_request_receipts ORDER BY rowid');
const prepare = async (sqlite: Sqlite, input = request()): Promise<NativeInboxTasksOrganizeEnvelope> => {
    const result = value(await sqlite.host.prepareInboxTasksOrganize(input)); expect(result.kind).toBe('prepared');
    if (result.kind !== 'prepared') throw new Error('Nonempty Organize must prepare');
    return clone({ request: input, prepared: result.prepared });
};
const clock = () => { process.env.TZ = 'America/New_York'; vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); };
const ids = () => {
    let index = 0;
    vi.spyOn(uuid, 'generateUUID').mockImplementation(() => `10000000-0000-4000-8000-${String(index++).padStart(12, '0')}`);
};
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.restoreAllMocks(); vi.useRealTimers(); if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ; });

describe('Inbox Organize RN/store parity', () => {
    it.each([
        ['additive raw/Unicode/token order', { contexts: 'office,@old, @École @école', tags: 'raw,#old,新 #École #école raw' }],
        ['explicit same-value project', { projectChoice: 'p1' }],
        ['None clears project and keeps area', { projectChoice: BULK_ORGANIZE_NONE }],
        ['None clears both containers', { projectChoice: BULK_ORGANIZE_NONE, areaChoice: BULK_ORGANIZE_NONE }],
        ['area move with Keep project', { areaChoice: 'destination-area' }],
        ['project wins over chosen area', { projectChoice: 'p3', areaChoice: 'destination-area' }],
        ['Waiting trims person and local follow-up', { status: 'waiting', delegateWho: '  Person or team  ', reviewDate: '2026-11-02' }],
        ['date-only across DST', { startDate: '2026-11-01', dueDate: '2026-11-02', reviewDate: '2026-11-03' }],
        ['Done with existing recurrence', { status: 'done', dueDate: '2026-11-10' }],
        ['Reference clears actionable scheduling', { status: 'reference', startDate: '2026-11-01', dueDate: '2026-11-02' }],
    ] satisfies [string, Partial<BulkOrganizeDraft>][])('matches actual RN builder/batchUpdateTasks all AppData and nine raw SQLite domains: %s', async (_label, draft) => {
        clock(); const initial = seed();
        if (draft.status === 'done') initial.tasks![0].recurrence = { rule: 'daily', strategy: 'strict', seriesId: 'series' };
        const rn = await openSqliteHost(initial); let expected; let expectedRaw; let count = 0;
        try {
            await canonical(); ids(); const write = planBulkOrganize(['a', 'b'], useTaskStore.getState()._tasksById,
                buildBulkOrganizeInput({ ...EMPTY_BULK_ORGANIZE_DRAFT, ...draft }));
            expect(write?.kind).toBe('update'); if (write?.kind !== 'update') throw new Error('Expected update'); count = write.updates.length;
            expect(await useTaskStore.getState().batchUpdateTasks(write.updates)).toEqual({ success: true });
            await flushPendingSave(); expect(useTaskStore.getState().persistenceFailure).toBeNull(); expected = rows(); expectedRaw = await raw(rn);
        } finally { await rn.close(); }
        const sqlite = await openSqliteHost(initial);
        try {
            await canonical(); ids(); const command = await prepare(sqlite, request(draft));
            expect(command.prepared.result).toEqual({ count, changed: true });
            expect(value(await sqlite.host.commitPreparedInboxTasksOrganize(command))).toEqual({ count, changed: true });
            expect(rows()).toEqual(expected); expect(await raw(sqlite)).toEqual(expectedRaw); expect(await sqlite.receiptIds()).toEqual([REQUEST_ID]);
        } finally { await sqlite.close(); }
    });
    it('explicit unchanged tokens still count while all Keep/blank makes zero writes, allocations, notice or receipt', async () => {
        clock(); const writes = vi.fn(); const sqlite = await openSqliteHost(seed(), client => ({ ...client, run: async (sql, params) => {
            if (/^(INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)/i.test(sql)) writes(sql); return client.run(sql, params);
        } }));
        try {
            await sqlite.client().run("UPDATE settings SET data = json_remove(data, '$.deviceId') WHERE id = 1");
            await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite); writes.mockClear();
            const allocate = vi.spyOn(uuid, 'generateUUID').mockImplementation(() => { throw new Error('No-op allocated'); });
            const logs = vi.spyOn(logger, 'logInfo');
            expect(value(await sqlite.host.prepareInboxTasksOrganize(request({ contexts: ' , ', tags: ' , ' })))).toEqual({ kind: 'noop', result: { count: 0, changed: false } });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]); expect(writes).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled();
            expect(logs.mock.calls.filter(([message]) => message === 'Native Inbox bulk Organize confirmed')).toEqual([]);
            allocate.mockRestore();
            const command = await prepare(sqlite, request({ tags: '#old' }));
            expect(command.prepared.result).toEqual({ count: 2, changed: true });
            value(await sqlite.host.commitPreparedInboxTasksOrganize(command));
            expect(useTaskStore.getState()._tasksById.get('a')!.rev).toBe(4); expect(await sqlite.receiptIds()).toEqual([REQUEST_ID]);
        } finally { await sqlite.close(); }
    });
    it('replays frozen dates and recurrence after clock and timezone changes', async () => {
        clock(); const initial = seed(); initial.tasks![0].recurrence = { rule: 'daily', strategy: 'after-completion', seriesId: 'series' };
        const sqlite = await openSqliteHost(initial);
        try {
            const command = await prepare(sqlite, request({ status: 'done', startDate: '2026-11-01', dueDate: '2026-11-02', reviewDate: '2026-11-03' }));
            expect(command.prepared.preparedOffsetMinutes).toBe(240); expect(command.prepared.boundaryOffsetMinutes).toBe(300);
            process.env.TZ = 'Pacific/Auckland'; vi.setSystemTime(new Date('2027-03-25T10:30:00Z'));
            expect(value(sqlite.host.validatePreparedInboxTasksOrganize(command))).toEqual({ count: 2, changed: true });
            value(await sqlite.host.commitPreparedInboxTasksOrganize(command));
            for (const pair of command.prepared.effect.tasks) expect(useTaskStore.getState()._tasksById.get(pair.after.id)).toEqual(pair.after);
            expect(useTaskStore.getState()._tasksById.get('b')!.dueDate).toBe('2026-11-02');
        } finally { await sqlite.close(); }
    });
    it('retains shared archived-project reactivation effects while strict entry refuses its read-only selection', async () => {
        clock(); const active = await openSqliteHost(seed()); let command;
        try { command = await prepare(active, request({ status: 'next' })); } finally { await active.close(); }
        const initial = seed(); initial.projects![0].status = 'archived';
        const sqlite = await openSqliteHost(initial);
        try {
            await canonical(); const input = request({ status: 'next' }); const before = rows();
            const scope = rawReferenceBatchScope(inboxTasksOrganizeScope(input, before))!;
            const effect = inboxTasksOrganizeEffect({ ...command.prepared, request: input, scope });
            expect(effect?.projects.some(pair => pair.before.id === 'p1' && pair.after.status === 'active')).toBe(true);
            expect(await sqlite.host.prepareInboxTasksOrganize(input)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            const write = planBulkOrganize(input.taskIds, useTaskStore.getState()._tasksById, buildBulkOrganizeInput(input.draft));
            if (write?.kind !== 'update' || !effect) throw new Error('Expected reactivation update');
            expect(await useTaskStore.getState().batchUpdateTasks(write.updates)).toEqual({ success: true }); await flushPendingSave();
            const overlay = <T extends { id: string }>(raw: T[], changes: { before: T; after: T }[]) =>
                raw.map(row => changes.find(pair => pair.before.id === row.id)?.after ?? row);
            expect(rows()).toEqual(clone({ ...before, tasks: [...overlay(before.tasks, effect.tasks), ...effect.createdTasks],
                projects: overlay(before.projects, effect.projects), sections: overlay(before.sections, effect.sections),
                settings: retainTaxonomyEffects(before.settings, effect.tasks, effect.projects) }));
        } finally { await sqlite.close(); }
    });
});

describe('Inbox Organize strict boundary and authority', () => {
    it('rejects closed request/draft/params/revisions before raw reads or writes', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const input = request(); const before = await raw(sqlite); const reads = vi.spyOn(getStorageAdapter(), 'getData'); reads.mockClear();
            for (const invalid of [
                { ...input, source: 'reference' }, { ...input, extra: true }, { ...input, taskIds: ['a', 'a'] },
                { ...input, taskRevisions: { a: input.taskRevisions.a } }, { ...input, requestId: 'wrong' },
                { ...input, params: { offset: 0 } }, { ...input, params: { includeArchivedProjects: false } },
                { ...input, params: { filters: { bad: [] } } }, { ...input, draft: {} },
                { ...input, draft: { ...input.draft, extra: true } }, { ...input, draft: { ...input.draft, status: 'inbox' } },
                { ...input, draft: { ...input.draft, dueDate: '2026-02-30' } },
                { ...input, draft: { ...input.draft, tags: 'x'.repeat(2001) } },
                { ...input, draft: { ...input.draft, status: 'waiting', delegateWho: '   ' } },
            ]) expect(await sqlite.host.prepareInboxTasksOrganize(invalid as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(reads).not.toHaveBeenCalled(); expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]);
        } finally { await sqlite.close(); }
    });
    it.each([
        ['selected', 'UPDATE tasks SET description = ? WHERE id = ?', ['Changed', 'a']],
        ['unselected Inbox', 'UPDATE tasks SET description = ? WHERE id = ?', ['Changed', 'unselected']],
        ['parent member', 'UPDATE tasks SET description = ? WHERE id = ?', ['Changed', 'sibling']],
        ['destination member', 'UPDATE tasks SET orderNum = ? WHERE id = ?', [99, 'destination-member']],
        ['project option', 'UPDATE projects SET title = ? WHERE id = ?', ['Renamed option', 'option']],
        ['area option', 'UPDATE areas SET name = ? WHERE id = ?', ['Renamed area', 'destination-area']],
        ['section', 'UPDATE sections SET title = ? WHERE id = ?', ['Renamed section', 's1']],
        ['settings', "UPDATE settings SET data = json_set(data, '$.gtd.autoArchiveDays', 0) WHERE id = 1", []],
    ] as const)('refuses stale %s raw authority without changing any SQLite cell', async (_label, sql, args) => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const command = await prepare(sqlite, request({ projectChoice: 'p3', tags: 'new' })); await sqlite.client().run(sql, [...args]);
            await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
            expect(await sqlite.host.commitPreparedInboxTasksOrganize(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]);
        } finally { await sqlite.close(); }
    });
    it('rejects stale selected revisions even for all-Keep and rejects hidden/folded/read-only/projected rows', async () => {
        clock(); const initial = seed(); initial.tasks!.push(task('a:projected-recurrence:2026-11-02')); const sqlite = await openSqliteHost(initial);
        try {
            const input = request({}); input.taskRevisions.a = 'wrong';
            expect(await sqlite.host.prepareInboxTasksOrganize(input)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await sqlite.host.prepareInboxTasksOrganize(request({}, ['a'], { filters: { searchQuery: 'not-present' } }))).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await sqlite.host.prepareInboxTasksOrganize(request({}, ['a'], { groupBy: 'project', collapsedGroupIds: ['project:p1'] }))).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await sqlite.host.prepareInboxTasksOrganize(request({}, ['a:projected-recurrence:2026-11-02']))).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            await sqlite.client().run('UPDATE projects SET status = ? WHERE id = ?', ['archived', 'p1']); await sqlite.restart(undefined, { recoveryLoad: true });
            expect(await sqlite.host.prepareInboxTasksOrganize(request({}, ['a']))).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await sqlite.host.prepareInboxTasksOrganize(request({ projectChoice: 'p1' }, ['b']))).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        } finally { await sqlite.close(); }
    });
    it.each(['unselected Inbox', 'picker option'] as const)('refuses an oversized %s witness without cropping, including no-op', async (kind) => {
        clock(); const initial = seed();
        if (kind === 'unselected Inbox') initial.tasks![5].description = '界'.repeat(700_000);
        else initial.projects![3].supportNotes = '界'.repeat(700_000);
        const sqlite = await openSqliteHost(initial);
        try { const before = await raw(sqlite);
            expect(await sqlite.host.prepareInboxTasksOrganize(request({}, ['a']))).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]);
        } finally { await sqlite.close(); }
    });
    it('retains imported raw-before cells and untouched raw sentinels through the shared field normalizers', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            await sqlite.client().run('UPDATE tasks SET tags = ?, contexts = ?, checklist = ? WHERE id = ?', ['["raw","#old","#old"]', null, '[]', 'a']);
            await sqlite.client().run('UPDATE tasks SET tags = ?, contexts = ? WHERE id = ?', ['["raw","raw"]', null, 'sentinel']);
            await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
            const command = await prepare(sqlite, request({ tags: '#old,新', contexts: '@École,office' }));
            expect(command.prepared.effect.tasks.find(pair => pair.before.id === 'a')!.before.tags).toEqual(['raw', '#old', '#old']);
            value(await sqlite.host.commitPreparedInboxTasksOrganize(command)); const after = await raw(sqlite);
            expect(useTaskStore.getState()._tasksById.get('a')!.tags).toEqual(['raw', '#old', '#新']);
            expect(after.tasks.rows.find((row: { id: string }) => row.id === 'sentinel')).toEqual(before.tasks.rows.find((row: { id: string }) => row.id === 'sentinel'));
            expect(after.projects).toEqual(before.projects); expect(after.sections).toEqual(before.sections); expect(after.areas).toEqual(before.areas);
        } finally { await sqlite.close(); }
    });
    it('rejects forged effect/count/raw witness/family and missing registry; raw-before CAS independently rejects approved forgery', async () => {
        clock(); const sqlite = await openSqliteHost(seed()); const original = referenceBatchModules.inboxOrganize;
        try {
            const command = await prepare(sqlite); const before = await raw(sqlite);
            for (const edit of [
                (c: NativeInboxTasksOrganizeEnvelope) => { c.prepared.effect.tasks[0].after.title = 'Forged'; },
                (c: NativeInboxTasksOrganizeEnvelope) => { c.prepared.result.count = 1; },
                (c: NativeInboxTasksOrganizeEnvelope) => { c.prepared.scope.tasks[0].description = 'Forged raw'; },
                (c: NativeInboxTasksOrganizeEnvelope) => { c.prepared.dates.push({ value: 'bad' } as never); },
                (c: NativeInboxTasksOrganizeEnvelope) => { c.prepared.allocatedIds.push(REQUEST_ID); },
                (c: NativeInboxTasksOrganizeEnvelope) => { (c.request as { source: string }).source = 'reference'; },
            ]) { const changed = clone(command); edit(changed);
                expect(await sqlite.host.commitPreparedInboxTasksOrganize(changed)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } }); }
            referenceBatchModules.inboxOrganize = undefined;
            const read = value(await readAreaDurableData(false, true));
            expect(await useTaskStore.getState().commitPreparedInboxTasksOrganize(command.prepared, read.authority)).toMatchObject({ success: false });
            referenceBatchModules.inboxOrganize = () => ({ validateEnvelope: () => true, authorityMatches: () => true });
            const forged = clone(command); forged.prepared.effect.tasks[0].before.description = 'Forged raw before';
            expect(await useTaskStore.getState().commitPreparedInboxTasksOrganize(forged.prepared, read.authority)).toMatchObject({ success: false });
            expect(read.authority.saveBoundary).toBeUndefined(); expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]);
        } finally { referenceBatchModules.inboxOrganize = original; await sqlite.close(); }
    });
    it('refuses storage replacement while the prepared store commit yields', async () => {
        clock(); const sqlite = await openSqliteHost(seed()); const adapter = getStorageAdapter();
        try {
            const command = await prepare(sqlite); const read = value(await readAreaDurableData(false, true)); const memory = useTaskStore.getState(); const before = await raw(sqlite);
            const committing = memory.commitPreparedInboxTasksOrganize(command.prepared, read.authority);
            setStorageAdapter(new NativeReceiptSqliteAdapter(sqlite.client(), { rejectConcurrentWrites: true }));
            expect(await committing).toMatchObject({ success: false }); expect(useTaskStore.getState()).toBe(memory);
            expect(read.authority.saveBoundary).toBeUndefined(); expect(await raw(sqlite)).toEqual(before);
        } finally { setStorageAdapter(adapter); await sqlite.close(); }
    });
    it.each(['noop', 'changed'] as const)('refuses %s preparation when memory changes across the awaited FK probe', async kind => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const adapter = getStorageAdapter() as NativeReceiptSqliteAdapter; const original = adapter.hasForeignKeyViolations.bind(adapter);
            let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
            let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
            vi.spyOn(adapter, 'hasForeignKeyViolations').mockImplementation(async () => { entered(); await gate; return original(); });
            const before = await raw(sqlite); const preparing = sqlite.host.prepareInboxTasksOrganize(request(kind === 'noop' ? {} : { tags: 'new' }));
            await started; const state = useTaskStore.getState();
            useTaskStore.setState({ _allTasks: state._allTasks.map(row => row.id === 'a' ? { ...row, rev: row.rev! + 1, title: 'Concurrent memory edit' } : row) });
            release(); expect(await preparing).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]);
        } finally { await sqlite.close(); }
    });
    it('refuses invalid saved foreign keys even for no-op and never treats an equal target as a receipt', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const command = await prepare(sqlite); value(await sqlite.host.commitPreparedInboxTasksOrganize(command));
            await sqlite.client().run('DELETE FROM native_request_receipts'); await sqlite.restart(undefined, { recoveryLoad: true });
            const landed = await raw(sqlite);
            expect(value(sqlite.host.inboxTasksOrganizeOutcome(command))).toBeNull();
            expect(await sqlite.host.commitPreparedInboxTasksOrganize(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(landed); expect(await receipts(sqlite)).toEqual([]);
            await sqlite.client().run('PRAGMA foreign_keys = OFF');
            await sqlite.client().run('UPDATE tasks SET projectId = ? WHERE id = ?', ['missing-project', 'sentinel']);
            await sqlite.client().run('PRAGMA foreign_keys = ON'); await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
            for (const draft of [{}, { tags: 'other' }]) expect(await sqlite.host.prepareInboxTasksOrganize(request(draft)))
                .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]);
        } finally { await sqlite.close(); }
    });
    it.each([
        ['selected raw', 'UPDATE tasks SET description = ? WHERE id = ?', ['Concurrent', 'a']],
        ['unrelated raw', 'UPDATE tasks SET description = ? WHERE id = ?', ['Concurrent', 'sentinel']],
        ['settings', "UPDATE settings SET data = json_set(data, '$.theme', 'dark') WHERE id = 1", []],
    ] as const)('uses second-connection BEGIN epoch fence for %s', async (_label, sql, args) => {
        clock(); const race: { ready: boolean; mutate?: () => Promise<void> } = { ready: false };
        const sqlite = await openSqliteHost(seed(), client => ({ ...client, run: async (query, params) => {
            if (query === 'BEGIN IMMEDIATE' && race.ready) { race.ready = false; await race.mutate!(); } return client.run(query, params);
        } })); const other = openScratchSqlite(join(sqlite.dir, 'mindwtr.db'));
        try {
            const command = await prepare(sqlite); let externalRaw;
            race.mutate = async () => { await other.client.run(sql, [...args]); externalRaw = await raw(sqlite); }; race.ready = true;
            expect(await sqlite.host.commitPreparedInboxTasksOrganize(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(externalRaw); expect(await receipts(sqlite)).toEqual([]);
        } finally { other.close(); await sqlite.close(); }
    });
});

describe('Inbox Organize durable receipts', () => {
    it('refuses an already receipted request UUID from another write family', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const command = await prepare(sqlite); const input = request();
            const moveRequest = { requestId: REQUEST_ID, source: 'inbox' as const, taskIds: input.taskIds, taskRevisions: input.taskRevisions, status: 'next' as const, params: {} };
            const moved = value(await sqlite.host.prepareInboxTasksMove(moveRequest));
            value(await sqlite.host.commitPreparedInboxTasksMove({ request: moveRequest, prepared: moved.prepared }));
            const before = await raw(sqlite); const saved = await receipts(sqlite);
            expect(await sqlite.host.commitPreparedInboxTasksOrganize(command)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual(saved);
        } finally { await sqlite.close(); }
    });
    it('returns its original cold receipt after later edits/deletion without replaying the effect or accepting changed request bytes', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const command = await prepare(sqlite); const logs = vi.spyOn(logger, 'logInfo');
            expect(value(sqlite.host.inboxTasksOrganizeOutcome(command))).toBeNull();
            expect(value(await sqlite.host.commitPreparedInboxTasksOrganize(command))).toEqual({ count: 2, changed: true });
            expect(logs).toHaveBeenCalledWith('Native Inbox bulk Organize confirmed', expect.objectContaining({ context: {
                releaseCheck: 'v1.3.5/ios-inbox-bulk-organize', count: 2, outcome: 'organized' } }));
            const saved = await receipts(sqlite); expect(saved).toHaveLength(1);
            await sqlite.client().run('DELETE FROM tasks WHERE id IN (?,?)', ['a', 'b']); await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
            expect(value(sqlite.host.inboxTasksOrganizeOutcome(command))).toEqual({ count: 2, changed: true });
            expect(value(await sqlite.host.commitPreparedInboxTasksOrganize(command))).toEqual({ count: 2, changed: true });
            const changed = clone(command); changed.request.draft.tags = '#new'; changed.prepared.request.draft.tags = '#new';
            expect(value(sqlite.host.validatePreparedInboxTasksOrganize(changed))).toEqual({ count: 2, changed: true });
            expect(await sqlite.host.commitPreparedInboxTasksOrganize(changed)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual(saved);
        } finally { await sqlite.close(); }
    });
    it('retains exact original failed debt for warm retry and has no cold receipt until durable acknowledgment', async () => {
        clock(); const fault = { commits: 0 }; const sqlite = await openSqliteHost(seed(), client => ({ ...client,
            run: async (sql, params) => { if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('Injected Organize failure'); } return client.run(sql, params); } }));
        try {
            const command = await prepare(sqlite); const before = await raw(sqlite); const logs = vi.spyOn(logger, 'logInfo');
            fault.commits = 10;
            expect(await sqlite.host.commitPreparedInboxTasksOrganize(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]); expect(value(sqlite.host.inboxTasksOrganizeOutcome(command))).toBeNull();
            expect(logs.mock.calls.filter(([message]) => message === 'Native Inbox bulk Organize confirmed')).toEqual([]);
            fault.commits = 0;
            expect(value(await sqlite.host.commitPreparedInboxTasksOrganize(command))).toEqual({ count: 2, changed: true });
            expect(useTaskStore.getState()._tasksById.get('a')!.rev).toBe(4); const saved = await receipts(sqlite);
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(sqlite.host.inboxTasksOrganizeOutcome(command))).toEqual({ count: 2, changed: true }); expect(await receipts(sqlite)).toEqual(saved);
        } finally { fault.commits = 0; await sqlite.close(); }
    });
    it('returns no cold outcome after failed COMMIT and performs no data write while checking recovery', async () => {
        clock(); const fault = { fail: false }; const sqlite = await openSqliteHost(seed(), client => ({ ...client,
            run: async (sql, params) => { if (sql === 'COMMIT' && fault.fail) throw new Error('Injected Organize failure'); return client.run(sql, params); } }));
        try {
            const command = await prepare(sqlite); const before = await raw(sqlite); fault.fail = true;
            expect(await sqlite.host.commitPreparedInboxTasksOrganize(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            fault.fail = false; await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(sqlite.host.inboxTasksOrganizeOutcome(command))).toBeNull(); expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]);
        } finally { fault.fail = false; await sqlite.close(); }
    });
});
