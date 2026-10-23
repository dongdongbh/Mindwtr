import { afterEach, describe, expect, it, vi } from 'vitest';
import { openScratchSqlite, openSqliteHost as openHost } from './screen-parity.replay';
import { taskRevisionOf, NativeReceiptSqliteAdapter } from './native-request-receipts';
import { flushPendingSave, getStorageAdapter, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { readAreaDurableData } from './native-host-contract-area-durable';
import { buildSaveSnapshot } from './store-helpers';
import { buildBulkTaskTokenUpdates } from './bulk-task-tokens';
import type { AppData, Task } from './types';
import { retainTaxonomyEffects } from './taxonomy-catalog';
import type { NativeInboxTasksAddTagEnvelope } from './native-host-contract-inbox-bulk-tag';
import { deterministicHash128 } from './uuid';
import { statusBatchSourcesMatch } from './native-host-contract-reference-bulk-status';
import { historyRowLoadProjection } from './native-host-contract-task-checklist';
import { normalizeTaskForLoad } from './task-status';
import { referenceTasksAddTagEffect } from './native-host-contract-reference-bulk-tag';
import * as uuid from './uuid';
import * as logger from './logger';
import { join } from 'node:path';
const openSqliteHost: typeof openHost = (seed, wrap, bindings) => openHost(seed, wrap, bindings, { rejectConcurrentWrites: true });
const NOW = '2026-10-03T13:00:00.000Z';
const BEFORE = '2026-10-02T12:34:56.789Z';
const REQUEST_ID = '00000000-0000-4000-8000-000000000195';
const DEVICE = 'inbox-move-device';
const ORIGINAL_TZ = process.env.TZ;
const clone = <T>(input: T): T => JSON.parse(JSON.stringify(input)) as T;
const value = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`); return result.value;
};
const task = (id: string, fields: Partial<Task> = {}): Task => ({ id, title: `Task ${id}`, status: 'inbox',
    createdAt: BEFORE, updatedAt: BEFORE, tags: [], contexts: [], rev: 3, revBy: DEVICE, ...fields });
const seed = (): Partial<AppData> => ({ tasks: [task('b', { projectId: 'p2', sectionId: 's2', description: 'Rich fixture',
    recurrence: { rule: 'daily', strategy: 'strict', seriesId: 'series' },
    attachments: [{ id: 'link', kind: 'link', title: 'Fixture', uri: 'https://example.com', createdAt: BEFORE, updatedAt: BEFORE }],
    checklist: [{ id: 'step', title: 'Step', isCompleted: true }], timeSpentMinutes: 45,
    dueDate: '2026-10-05', startTime: '2026-10-04', reviewAt: '2026-10-06', focusOrder: 9 }),
    task('a', { projectId: 'p1', sectionId: 's1' }),
    task('sibling', { status: 'next', projectId: 'p1', order: 8, orderNum: 8 }),
    task('history', { status: 'done', projectId: 'p1', deletedAt: BEFORE }), task('unrelated')],
    projects: ['p1', 'p2'].map((id) => ({ id, title: `Parent ${id}`, status: 'active', color: '#94a3b8', order: 0,
        tagIds: [], createdAt: BEFORE, updatedAt: BEFORE, rev: 2, revBy: DEVICE })),
    sections: ['s1', 's2'].map((id, index) => ({ id, projectId: `p${index + 1}`, title: `Section ${id}`, order: 0,
        createdAt: BEFORE, updatedAt: BEFORE, rev: 1, revBy: DEVICE })),
    areas: [{ id: 'area', name: 'Area', order: 0, createdAt: BEFORE, updatedAt: BEFORE }],
    people: [{ id: 'person', name: 'Person', createdAt: BEFORE, updatedAt: BEFORE }],
    settings: { deviceId: DEVICE, analyticsProfileId: REQUEST_ID, gtd: { autoArchiveDays: 7 } } });
type Sqlite = Awaited<ReturnType<typeof openSqliteHost>>;
const raw = async (sqlite: Sqlite) => Object.fromEntries(await Promise.all([
    'tasks', 'projects', 'sections', 'areas', 'people', 'settings', 'saved_filters', 'schema_migrations', 'calendar_sync',
].map(async (table) => [table, {
    columns: await sqlite.sql(`PRAGMA table_info(${table})`), indexes: await sqlite.sql(`PRAGMA index_list(${table})`),
    foreignKeys: await sqlite.sql(`PRAGMA foreign_key_list(${table})`),
    definitions: await sqlite.sql('SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name = ? ORDER BY type,name', [table]),
    rows: await sqlite.sql(`SELECT rowid AS _rowid, * FROM ${table} ORDER BY rowid`),
}])));
const rows = () => clone(buildSaveSnapshot(useTaskStore.getState()));
const canonical = async () => getStorageAdapter().saveData(buildSaveSnapshot(useTaskStore.getState()));
const request = (tag = 'new', taskIds = ['a', 'b'], requestId = REQUEST_ID, params = {}) => ({ requestId, source: 'inbox' as const,
    taskIds, taskRevisions: Object.fromEntries(taskIds.map((id) => [id, taskRevisionOf(useTaskStore.getState()._tasksById.get(id)!)])), tag, params });
const host = (sqlite: Sqlite) => sqlite.host;
const receipts = (sqlite: Sqlite) => sqlite.sql('SELECT rowid AS _rowid,* FROM native_request_receipts ORDER BY rowid');
const prepare = async (sqlite: Sqlite, input = request()): Promise<NativeInboxTasksAddTagEnvelope> => {
    const result = value(await host(sqlite).prepareInboxTasksAddTag(input)); expect(result.kind).toBe('prepared');
    if (result.kind !== 'prepared') throw new Error('Changed tag must prepare');
    return clone({ request: input, prepared: result.prepared });
};
const clock = () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); };
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.restoreAllMocks(); vi.useRealTimers(); if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ; });

describe('guarded Inbox bulk Add tag', () => {
    it('requires exact Inbox source, revisions and non-paged params before any writes', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const input = request(); const { source: _source, ...withoutSource } = input; const before = await raw(sqlite);
            for (const invalid of [withoutSource, { ...input, source: 'reference' }, { ...input, source: 'done' },
                ...[{ includeArchivedProjects: false }, { includeArchivedProjects: true }, { offset: 0 }, { limit: 100 },
                    { selectAll: true }, { unexpected: true }].map(params => ({ ...input, params })),
                { ...input, taskRevisions: { a: input.taskRevisions.a } }])
                expect(await host(sqlite).prepareInboxTasksAddTag(invalid as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]);
        } finally { await sqlite.close(); }
    });
    it('refuses projected, purged, wrong-source and read-only rows even for blank or already-tagged no-op', async () => {
        clock(); const projected = task('a:projected-recurrence', { tags: ['#new'] });
        const purged = task('purged', { deletedAt: BEFORE, purgedAt: BEFORE, tags: ['#new'] });
        const initial = seed(); initial.tasks!.push(projected, purged, task('ref', { status: 'reference', tags: ['#new'] }));
        const sqlite = await openSqliteHost(initial);
        try {
            const before = await raw(sqlite);
            for (const row of [projected, purged, initial.tasks!.find(row => row.id === 'ref')!]) {
                for (const tag of ['new', ' ']) expect(await host(sqlite).prepareInboxTasksAddTag({ ...request(tag), taskIds: [row.id], taskRevisions: { [row.id]: taskRevisionOf(row) } }))
                    .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            }
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]);
            for (const lifecycle of ['archive', 'cancel', 'delete'] as const) {
                await sqlite.client().run('UPDATE projects SET status = ?, cancelledAt = ?, deletedAt = ? WHERE id = ?',
                    [lifecycle === 'delete' ? 'active' : 'archived', lifecycle === 'cancel' ? NOW : null, lifecycle === 'delete' ? NOW : null, 'p1']);
                await sqlite.restart(undefined, { recoveryLoad: true }); const stable = await raw(sqlite);
                expect(await host(sqlite).prepareInboxTasksAddTag(request(' ', ['a']))).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
                expect(await raw(sqlite)).toEqual(stable); expect(await receipts(sqlite)).toEqual([]);
            }
        } finally { await sqlite.close(); }
    });
    it('binds every unselected Inbox visibility row before even an already-tagged no-op', async () => {
        clock(); const sqlite = await openSqliteHost({ tasks: [task('a'), task('witness')], settings: { deviceId: DEVICE } });
        try {
            const input = request('new', ['a'], REQUEST_ID, { filters: { energyLevels: ['high'] } });
            expect(value(host(sqlite).getInboxView({ offset: 0, limit: 100, ...input.params })).items.some(item => item.type === 'task' && item.row.id === 'a')).toBe(true);
            const command = await prepare(sqlite, input);
            await sqlite.client().run('UPDATE tasks SET energyLevel = ? WHERE id = ?', ['high', 'witness']);
            await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
            expect(value(host(sqlite).getInboxView({ offset: 0, limit: 100, ...input.params })).items.some(item => item.type === 'task' && item.row.id === 'a')).toBe(false);
            expect(await host(sqlite).commitPreparedInboxTasksAddTag(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await host(sqlite).prepareInboxTasksAddTag({ ...input, tag: ' ' })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]);
        } finally { await sqlite.close(); }
    });
    it('refuses an oversized unselected visibility witness even for a blank no-op without cropping it', async () => {
        clock(); const sqlite = await openSqliteHost({ tasks: [task('a'), task('witness', { description: '界'.repeat(700_000) })], settings: { deviceId: DEVICE } });
        try {
            const before = await raw(sqlite);
            for (const tag of ['new', ' ']) expect(await host(sqlite).prepareInboxTasksAddTag(request(tag, ['a']))).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]);
        } finally { await sqlite.close(); }
    });
    it('uses real Inbox priorities while ignoring unrelated global area selection', async () => {
        clock(); const sqlite = await openSqliteHost({ tasks: [task('a'), task('witness', { priority: 'high' })],
            settings: { deviceId: DEVICE, filters: { areaId: 'elsewhere' }, features: { priorities: false } } });
        try {
            const input = request('new', ['a'], REQUEST_ID, { filters: { priorities: ['high'] } }); const command = await prepare(sqlite, input);
            expect(command.prepared.scope.settings).not.toHaveProperty('filters');
            expect(command.prepared.scope.settings.features?.priorities).toBe(false);
            await sqlite.client().run("UPDATE settings SET data=json_set(data,'$.features.priorities',json('true')) WHERE id=1");
            await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
            expect(await host(sqlite).commitPreparedInboxTasksAddTag(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]);
        } finally { await sqlite.close(); }
    });
    it('keeps Reference and Inbox Add-tag envelopes and durable UUID families separate', async () => {
        clock(); const sqlite = await openSqliteHost({ tasks: [task('a'), task('ref', { status: 'reference' })], settings: { deviceId: DEVICE } });
        try {
            const command = await prepare(sqlite, request('new', ['a']));
            const refInput = { requestId: REQUEST_ID, taskIds: ['ref'], taskRevisions: { ref: taskRevisionOf(useTaskStore.getState()._tasksById.get('ref')!) }, tag: 'new', params: {} };
            const refPrepared = value(await host(sqlite).prepareReferenceTasksAddTag(refInput)); if (refPrepared.kind !== 'prepared') throw new Error('Expected Reference change');
            const refCommand = { request: refInput, prepared: refPrepared.prepared };
            expect(host(sqlite).validatePreparedReferenceTasksAddTag(command as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(host(sqlite).validatePreparedInboxTasksAddTag(refCommand as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            value(await host(sqlite).commitPreparedReferenceTasksAddTag(refCommand)); const before = await raw(sqlite);
            expect(await host(sqlite).commitPreparedInboxTasksAddTag(command)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(host(sqlite).inboxTasksAddTagOutcome(command)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toHaveLength(1);
        } finally { await sqlite.close(); }
    });
    it.each(['new', 'different', ' one,two words ', '@@## new', 'École', 'x'.repeat(501), 'x'.repeat(2000)])('matches actual RN builder/batchUpdateTasks full AppData and all nine SQLite domains for %s', async (tag) => {
        clock(); const initial = seed(); initial.tasks![0].tags = ['#a', '#A', '#école', '#排序', '']; initial.tasks![1].tags = ['#new'];
        const rn = await openSqliteHost(initial); let expected; let expectedRaw; let count = 0;
        try {
            await canonical(); const updates = buildBulkTaskTokenUpdates(['a', 'b'], useTaskStore.getState()._tasksById, 'tags', tag.trim(), 'add');
            count = updates.length; expect(count).toBeGreaterThan(0);
            expect(await useTaskStore.getState().batchUpdateTasks(updates)).toEqual({ success: true });
            await flushPendingSave(); expect(useTaskStore.getState().persistenceFailure).toBeNull(); expected = rows(); expectedRaw = await raw(rn);
        } finally { await rn.close(); }
        const sqlite = await openSqliteHost(initial);
        try {
            await canonical(); const input = request(tag); const api = host(sqlite);
            expect(api.prepareInboxTasksAddTag).toBeTypeOf('function');
            const result = value(await api.prepareInboxTasksAddTag(input)); expect(result.kind).toBe('prepared');
            if (result.kind !== 'prepared') throw new Error('Changed tag must prepare');
            expect(value(await api.commitPreparedInboxTasksAddTag({ request: input, prepared: result.prepared }))).toEqual({ count, changed: true });
            expect(rows()).toEqual(expected); expect(await raw(sqlite)).toEqual(expectedRaw); expect(await sqlite.receiptIds()).toEqual([REQUEST_ID]);
        } finally { await sqlite.close(); }
    });
    it.each(['#new', '@#@', ' @@## ', '   '])('fresh no-op preserves all raw cells, missing device and receipts for %s', async (tag) => {
        clock(); const initial = seed(); initial.tasks![0].tags = ['new', '#new', '#new']; initial.tasks![1].tags = ['#new'];
        const writes = vi.fn(); const sqlite = await openSqliteHost(initial, (client) => ({ ...client, run: async (sql, params) => {
            if (/^(INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)/i.test(sql)) writes(sql); return client.run(sql, params);
        } }));
        try {
            await sqlite.client().run("UPDATE settings SET data = json_remove(data, '$.deviceId') WHERE id = 1");
            await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite); writes.mockClear();
            expect(buildBulkTaskTokenUpdates(['a', 'b'], useTaskStore.getState()._tasksById, 'tags', tag.trim(), 'add')).toEqual([]);
            const logs = vi.spyOn(logger, 'logInfo');
            const api = host(sqlite); expect(api.prepareInboxTasksAddTag).toBeTypeOf('function');
            expect(value(await api.prepareInboxTasksAddTag(request(tag)))).toEqual({ kind: 'noop', result: { count: 0, changed: false } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]); expect(writes).not.toHaveBeenCalled();
            expect(logs.mock.calls.filter(([message]) => message === 'Native Inbox bulk tag confirmed')).toEqual([]);
        } finally { await sqlite.close(); }
    });
});

describe('Inbox Add tag exact authority and durable replay', () => {
    it('refuses an Add-tag adapter switch during deferred module loading without memory, raw data or save-boundary changes', async () => {
        clock(); const sqlite = await openSqliteHost(seed()); const adapter = getStorageAdapter();
        try {
            await canonical(); const command = await prepare(sqlite); const read = value(await readAreaDurableData(false, true));
            const before = await raw(sqlite); const memory = useTaskStore.getState();
            const replacement = new NativeReceiptSqliteAdapter(sqlite.client(), { rejectConcurrentWrites: true });
            const committing = memory.commitPreparedInboxTasksAddTag(command.prepared, read.authority);
            // The first await yields before any application; even another guarded
            // adapter over this same SQLite connection is a different authority.
            setStorageAdapter(replacement);
            expect(useTaskStore.getState()).toBe(memory);
            expect(await committing).toMatchObject({ success: false, reason: 'conflict' });
            await flushPendingSave(); expect(useTaskStore.getState()).toBe(memory);
            expect(read.authority.saveBoundary).toBeUndefined(); expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { setStorageAdapter(adapter); await flushPendingSave(); await sqlite.close(); }
    });
    it('keeps raw normalized intent, complete receipt fingerprint/reply and own cold ACK through unrelated edits and invalid FK', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const command = await prepare(sqlite, request('  @@## new  '));
            expect(command.prepared.version).toBe(1); expect(command.prepared.request).toEqual(command.request);
            expect(command.request.tag).toBe('  @@## new  ');
            const logs = vi.spyOn(logger, 'logInfo'); const result = { count: 2, changed: true };
            expect(value(host(sqlite).validatePreparedInboxTasksAddTag(command))).toEqual(result);
            expect(value(host(sqlite).inboxTasksAddTagOutcome(command))).toBeNull();
            expect(value(await host(sqlite).commitPreparedInboxTasksAddTag(command))).toEqual(result);
            expect(logs).toHaveBeenCalledWith('Native Inbox bulk tag confirmed', expect.objectContaining({ context: {
                releaseCheck: 'v1.3.5/ios-inbox-bulk-tag', count: 2, outcome: 'added' } }));
            const payload = JSON.stringify(['inboxTasksAddTag', command], (_name, item) => item && typeof item === 'object' && !Array.isArray(item)
                ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
            const fingerprint = `inboxTasksAddTag:${deterministicHash128(payload).map((part) => part.toString(16).padStart(8, '0')).join('')}`;
            expect(await receipts(sqlite)).toEqual([{ _rowid: 1, request_id: REQUEST_ID, method: fingerprint, reply: JSON.stringify(result), saved_at: NOW }]);
            await sqlite.client().run('UPDATE tasks SET title = ?, tags = ?, rev = rev + 1 WHERE id = ?', ['Later task', '["#later"]', 'a']);
            await sqlite.client().run('PRAGMA foreign_keys = OFF'); await sqlite.client().run('UPDATE tasks SET projectId = ? WHERE id = ?', ['', 'unrelated']);
            await sqlite.client().run('PRAGMA foreign_keys = ON'); await sqlite.restart(undefined, { recoveryLoad: true });
            const before = await raw(sqlite); const saved = await receipts(sqlite);
            expect(value(host(sqlite).inboxTasksAddTagOutcome(command))).toEqual(result);
            expect(value(await host(sqlite).commitPreparedInboxTasksAddTag(command))).toEqual(result);
            const changed = clone(command); changed.request.tag = '#new'; changed.prepared.request.tag = '#new';
            expect(value(host(sqlite).validatePreparedInboxTasksAddTag(changed))).toEqual(result);
            expect(await host(sqlite).commitPreparedInboxTasksAddTag(changed)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual(saved);
        } finally { await sqlite.close(); }
    });
    it.each(['same-host', 'cold'] as const)('retries the exact original tag envelope and missing device through repeated failures and %s recovery', async (recovery) => {
        clock(); const fault = { commits: 0 }; const sqlite = await openSqliteHost(seed(), (client) => ({ ...client,
            run: async (sql, params) => { if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('Injected tag failure'); } return client.run(sql, params); } }));
        try {
            await sqlite.client().run("UPDATE settings SET data = json_remove(data, '$.deviceId') WHERE id = 1"); await sqlite.restart(undefined, { recoveryLoad: true });
            const command = await prepare(sqlite, request(' @#new ')); const before = await raw(sqlite); const logs = vi.spyOn(logger, 'logInfo');
            expect(command.prepared.deviceIdBefore).toBeNull(); expect(command.prepared.deviceIdToInitialize).toMatch(/^[0-9a-f-]{36}$/);
            for (let attempt = 0; attempt < 2; attempt++) {
                fault.commits = 10; expect(await host(sqlite).commitPreparedInboxTasksAddTag(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
                expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]); expect(value(host(sqlite).inboxTasksAddTagOutcome(command))).toBeNull();
            }
            expect(logs.mock.calls.filter(([message]) => message === 'Native Inbox bulk tag confirmed')).toEqual([]);
            fault.commits = 0; vi.setSystemTime(new Date('2028-10-03T15:00:00.000Z'));
            if (recovery === 'cold') await sqlite.restart(undefined, { recoveryLoad: true });
            const allocate = vi.spyOn(uuid, 'generateUUID').mockImplementation(() => { throw new Error('Replay allocated'); });
            expect(value(await host(sqlite).commitPreparedInboxTasksAddTag(command))).toEqual({ count: 2, changed: true }); allocate.mockRestore();
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(useTaskStore.getState().settings.deviceId).toBe(command.prepared.deviceIdToInitialize);
            expect(value(host(sqlite).inboxTasksAddTagOutcome(command))).toEqual({ count: 2, changed: true }); expect(await sqlite.receiptIds()).toEqual([REQUEST_ID]);
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 30_000);
    it('does not adopt an unrelated later failed save generation as ownership', async () => {
        clock(); const fault = { commits: 0 }; const sqlite = await openSqliteHost(seed(), (client) => ({ ...client,
            run: async (sql, params) => { if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('Injected tag failure'); } return client.run(sql, params); } }));
        try {
            const command = await prepare(sqlite); fault.commits = 10;
            expect(await host(sqlite).commitPreparedInboxTasksAddTag(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); const before = await raw(sqlite);
            await useTaskStore.getState().updateTask('unrelated', { description: 'Later writer' }); fault.commits = 10;
            await expect(flushPendingSave()).rejects.toThrow('Injected tag failure');
            expect(await host(sqlite).commitPreparedInboxTasksAddTag(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]);
        } finally { fault.commits = 0; resetForTests(); await sqlite.close(); }
    }, 30_000);
    it.each([
        ['selected same revision', 'UPDATE tasks SET description = ? WHERE id = ?', ['Changed', 'a']],
        ['selected no-op task revision', 'UPDATE tasks SET rev = rev + 1 WHERE id = ?', ['a']],
        ['newer saved focus', 'UPDATE tasks SET isFocusedToday = 1, focusOrder = 77 WHERE id = ?', ['a']],
        ['unselected Inbox raw witness', 'UPDATE tasks SET description = ? WHERE id = ?', ['Changed witness', 'unrelated']],
        ['parent lifecycle', 'UPDATE projects SET status = ? WHERE id = ?', ['archived', 'p1']],
        ['container member', 'UPDATE tasks SET projectId = ? WHERE id = ?', ['p1', 'unrelated']],
        ['priority visibility', "UPDATE settings SET data = json_set(data, '$.features.priorities', json('true')) WHERE id = 1", []],
    ] as const)('rejects unsaved %s drift without domain/receipt writes', async (_label, sql, args) => {
        clock(); const initial = seed(); initial.tasks![1].tags = ['#new']; const sqlite = await openSqliteHost(initial);
        try {
            const command = await prepare(sqlite); expect(command.prepared.result.count).toBe(1);
            await sqlite.client().run(sql, [...args]); await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
            expect(await host(sqlite).commitPreparedInboxTasksAddTag(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]);
        } finally { await sqlite.close(); }
    });
    it('checks every selected row even for a fresh all-already-tagged no-op, plus missing/deleted/archived selection', async () => {
        clock(); const initial = seed(); initial.tasks![0].tags = initial.tasks![1].tags = ['#new']; const sqlite = await openSqliteHost(initial);
        try {
            const original = request(); await sqlite.client().run('UPDATE tasks SET rev = rev + 1 WHERE id = ?', ['a']); await sqlite.restart(undefined, { recoveryLoad: true });
            expect(await host(sqlite).prepareInboxTasksAddTag(original)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            for (const ids of [['missing'], ['history']]) {
                const input = { ...request(), taskIds: ids, taskRevisions: Object.fromEntries(ids.map((id) => [id, '1:fixture:before'])) };
                expect(await host(sqlite).prepareInboxTasksAddTag(input)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            }
            await sqlite.client().run('UPDATE projects SET status = ? WHERE id = ?', ['archived', 'p1']); await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
            expect(await host(sqlite).prepareInboxTasksAddTag(request('new', ['a'], REQUEST_ID, {}))).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]);
        } finally { await sqlite.close(); }
    });
    it.each([
        ['filtered source', { filters: { searchQuery: 'nonmatching source' } }],
        ['folded project', { groupBy: 'project', collapsedGroupIds: ['project:p1'] }],
    ])('refuses %s selection and allows exact filtered selection across a larger paged list', async (_label, params) => {
        clock(); const initial = seed(); initial.tasks!.push(...Array.from({ length: 130 }, (_, index) => task(`page-${index}`))); const sqlite = await openSqliteHost(initial);
        try {
            expect(await host(sqlite).prepareInboxTasksAddTag(request('new', ['a'], REQUEST_ID, params))).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            const command = await prepare(sqlite, request('new', ['page-129'], REQUEST_ID, { filters: { searchQuery: 'Task page-129' } }));
            expect(value(await host(sqlite).commitPreparedInboxTasksAddTag(command))).toEqual({ count: 1, changed: true });
        } finally { await sqlite.close(); }
    });
    it.each([
        ['selected same rev', 'UPDATE tasks SET description = ? WHERE id = ?', ['Concurrent', 'a']],
        ['container member', 'UPDATE tasks SET projectId = ? WHERE id = ?', ['p1', 'unrelated']],
        ['settings', "UPDATE settings SET data = json_set(data, '$.theme', 'dark') WHERE id = 1", []],
        ['unrelated row', 'UPDATE tasks SET description = ? WHERE id = ?', ['Concurrent unrelated', 'unrelated']],
    ] as const)('uses real second-connection BEGIN epoch fence for %s', async (label, query, args) => {
        clock(); const race: { ready: boolean; mutate?: () => Promise<void> } = { ready: false };
        const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, run: async (sql, params) => {
            if (sql === 'BEGIN IMMEDIATE' && race.ready) { race.ready = false; await race.mutate!(); } return client.run(sql, params);
        } })); const other = openScratchSqlite(join(sqlite.dir, 'mindwtr.db'));
        try {
            const command = await prepare(sqlite); race.mutate = async () => { await other.client.run(query, [...args]); }; race.ready = true;
            expect(await host(sqlite).commitPreparedInboxTasksAddTag(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            const after = await raw(sqlite); expect(await receipts(sqlite)).toEqual([]);
            expect((after.tasks.rows as { id: string; tags: string }[]).filter((r) => ['a', 'b'].includes(r.id)).every((r) => r.tags === '[]')).toBe(true);
            await sqlite.restart(undefined, { recoveryLoad: true });
            if (label === 'settings') {
                value(await host(sqlite).commitPreparedInboxTasksAddTag(command)); const final = await raw(sqlite);
                // The successful RN-equivalent write also retains this exact prepared token effect.
                const expectedSettings = clone(after.settings);
                expectedSettings.rows[0].data = JSON.stringify(retainTaxonomyEffects(JSON.parse(expectedSettings.rows[0].data),
                    command.prepared.effect.tasks, command.prepared.effect.projects));
                expect(final.settings).toEqual(expectedSettings);
                expect(final.tasks.rows.find((r: { id: string }) => r.id === 'unrelated')).toEqual(after.tasks.rows.find((r: { id: string }) => r.id === 'unrelated'));
            } else { expect(await host(sqlite).commitPreparedInboxTasksAddTag(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } }); expect(await raw(sqlite)).toEqual(after); }
        } finally { other.close(); await sqlite.close(); }
    }, 30_000);
    it('fails unsupported unguarded adapters and invalid FK/probe authority closed', async () => {
        clock(); const unguarded = await openHost(seed());
        try { expect(await host(unguarded).prepareInboxTasksAddTag(request())).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); expect(await receipts(unguarded)).toEqual([]); }
        finally { await unguarded.close(); }
        const fault = { probe: false }; const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, get: async (sql, params) => {
            if (fault.probe && sql.includes('pragma_foreign_key_check')) throw new Error('Probe failure'); return client.get(sql, params);
        } }));
        try {
            const command = await prepare(sqlite); const input = request(); const before = await raw(sqlite); fault.probe = true;
            expect(await host(sqlite).prepareInboxTasksAddTag(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await host(sqlite).commitPreparedInboxTasksAddTag(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); fault.probe = false;
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]);
            await sqlite.client().run('PRAGMA foreign_keys = OFF'); await sqlite.client().run('UPDATE tasks SET projectId = ? WHERE id = ?', ['', 'unrelated']); await sqlite.client().run('PRAGMA foreign_keys = ON');
            await sqlite.restart(undefined, { recoveryLoad: true }); const malformed = await raw(sqlite);
            expect(await host(sqlite).prepareInboxTasksAddTag(request())).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await host(sqlite).commitPreparedInboxTasksAddTag(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(malformed); expect(await receipts(sqlite)).toEqual([]);
        } finally { fault.probe = false; await sqlite.close(); }
    });
    it('rejects malformed envelope/effect/date/count/input and cross-family UUID reuse before own writes', async () => {
        clock(); const calls = vi.fn(); const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, run: async (sql, params) => {
            if (/^(INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)/i.test(sql)) calls(sql); return client.run(sql, params);
        } }));
        try {
            const command = await prepare(sqlite);
            for (const mutate of [
                (e: NativeInboxTasksAddTagEnvelope) => { e.prepared.effect.tasks[0].after.tags = ['#forged']; },
                (e: NativeInboxTasksAddTagEnvelope) => { e.prepared.result.count += 1; },
                (e: NativeInboxTasksAddTagEnvelope) => { e.prepared.futureBoundary = NOW; },
                (e: NativeInboxTasksAddTagEnvelope) => { e.request.tag = 'different'; },
                (e: NativeInboxTasksAddTagEnvelope) => { e.prepared.scope.tasks.push(task('extra', { status: 'next' })); },
            ]) { const invalid = clone(command); mutate(invalid); calls.mockClear();
                expect(host(sqlite).validatePreparedInboxTasksAddTag(invalid)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(await host(sqlite).commitPreparedInboxTasksAddTag(invalid)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } }); expect(calls).not.toHaveBeenCalled(); }
            for (const change of [{ tag: 'x'.repeat(2001) }, { extra: true }, { taskIds: ['a', 'a'] }, { tag: {} }]) {
                calls.mockClear(); expect(await host(sqlite).prepareInboxTasksAddTag({ ...request(), ...change } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } }); expect(calls).not.toHaveBeenCalled();
            }
            const moveRequest = { requestId: REQUEST_ID, source: 'inbox' as const, taskIds: ['a'], taskRevisions: request().taskRevisions, status: 'next' as const, params: {} };
            moveRequest.taskRevisions = { a: moveRequest.taskRevisions.a };
            const move = value(await host(sqlite).prepareInboxTasksMove(moveRequest)); value(await host(sqlite).commitPreparedInboxTasksMove({ request: moveRequest, prepared: move.prepared }));
            expect(await host(sqlite).commitPreparedInboxTasksAddTag(command)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await sqlite.receiptIds()).toEqual([REQUEST_ID]);
        } finally { await sqlite.close(); }
    });
    it('binds exact Unicode/protected IDs and NFC/NFD tag bytes to actual RN', async () => {
        clock(); const selected = ['é', 'e\u0301', 'constructor', '__proto__', 'prototype'];
        const initial: Partial<AppData> = { tasks: selected.map((id) => task(id, { tags: ['#é', '#e\u0301'] })), settings: { deviceId: DEVICE, analyticsProfileId: REQUEST_ID } };
        const rn = await openSqliteHost(initial); let expected;
        try { await canonical(); const updates = buildBulkTaskTokenUpdates(selected, useTaskStore.getState()._tasksById, 'tags', 'NFD e\u0301'.trim(), 'add'); expect(await useTaskStore.getState().batchUpdateTasks(updates)).toEqual({ success: true }); await flushPendingSave(); expect(useTaskStore.getState().persistenceFailure).toBeNull(); expected = await raw(rn); }
        finally { await rn.close(); }
        const sqlite = await openSqliteHost(initial);
        try { await canonical(); const command = await prepare(sqlite, request('NFD e\u0301', selected)); value(await host(sqlite).commitPreparedInboxTasksAddTag(command)); expect(await raw(sqlite)).toEqual(expected);
            expect(command.request.taskIds.map((id) => [...new TextEncoder().encode(id)])).toEqual(selected.map((id) => [...new TextEncoder().encode(id)])); }
        finally { await sqlite.close(); }
    });
    it('preserves raw NULL/legacy JSON provenance and matches actual RN loaded result', async () => {
        clock(); const setup = async () => { const sqlite = await openSqliteHost(seed()); await canonical();
            await sqlite.client().run('UPDATE tasks SET tags = NULL, contexts = NULL, projectId = NULL WHERE id = ?', ['a']);
            await sqlite.client().run('UPDATE tasks SET pushCount = NULL WHERE id = ?', ['unrelated']);
            await sqlite.client().run('UPDATE projects SET tagIds = NULL, attachments = ? WHERE id = ?', [JSON.stringify([{ id: 'legacy-link', kind: 'link', title: 'Fixture', uri: 'https://example.com', createdAt: BEFORE }]), 'p2']);
            await sqlite.restart(undefined, { recoveryLoad: true }); return sqlite; };
        const rn = await setup(); let expected;
        try { const updates = buildBulkTaskTokenUpdates(['a', 'b'], useTaskStore.getState()._tasksById, 'tags', 'new', 'add'); expect(await useTaskStore.getState().batchUpdateTasks(updates)).toEqual({ success: true }); await flushPendingSave(); expect(useTaskStore.getState().persistenceFailure).toBeNull(); expected = rows(); } finally { await rn.close(); }
        const sqlite = await setup();
        try { const command = await prepare(sqlite); const before = await raw(sqlite);
            expect(Object.hasOwn(command.prepared.scope.tasks.find((r) => r.id === 'a')!, 'tags')).toBe(false);
            value(await host(sqlite).commitPreparedInboxTasksAddTag(command)); const after = await raw(sqlite);
            expect(after.projects).toEqual(before.projects); expect(after.tasks.rows.find((r: { id: string }) => r.id === 'unrelated')).toEqual(before.tasks.rows.find((r: { id: string }) => r.id === 'unrelated'));
            await sqlite.restart(undefined, { recoveryLoad: true }); expect(rows()).toEqual(expected);
        } finally { await sqlite.close(); }
    });
    it.each(['same-host', 'cold'] as const)('preserves blank raw Area timestamps through %s retry', async (recovery) => {
        clock(); const fault = { commits: 0 }; const initial = seed(); initial.projects![0].areaId = 'area';
        const sqlite = await openSqliteHost(initial, (client) => ({ ...client, run: async (sql, params) => { if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('Injected tag failure'); } return client.run(sql, params); } }));
        try { await sqlite.client().run("UPDATE areas SET createdAt = '', updatedAt = '' WHERE id = ?", ['area']); await sqlite.restart(undefined, { recoveryLoad: true });
            const command = await prepare(sqlite); const before = await raw(sqlite); expect(command.prepared.scope.areas[0].createdAt).toBe('');
            fault.commits = 10; expect(await host(sqlite).commitPreparedInboxTasksAddTag(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); fault.commits = 0;
            vi.setSystemTime(new Date('2027-10-03T15:00:00.000Z')); if (recovery === 'cold') await sqlite.restart(undefined, { recoveryLoad: true });
            value(await host(sqlite).commitPreparedInboxTasksAddTag(command)); expect((await raw(sqlite)).areas).toEqual(before.areas);
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 30_000);
    it.each([
        ['spring NY→Tokyo', 'America/New_York', 'Asia/Tokyo', '2026-03-08T06:30:00.000Z', 300, 240],
        ['autumn NY→Tokyo', 'America/New_York', 'Asia/Tokyo', '2026-11-01T05:30:00.000Z', 240, 300],
        ['spring Tokyo→NY', 'Asia/Tokyo', 'America/New_York', '2026-03-08T06:30:00.000Z', -540, -540],
        ['autumn Tokyo→NY', 'Asia/Tokyo', 'America/New_York', '2026-11-01T05:30:00.000Z', -540, -540],
    ] as const)('matches actual RN date/hidden-field effects and freezes %s DST policy across cold travel without allocation', async (_label, sourceZone, targetZone, at, preparedOffset, boundaryOffset) => {
        process.env.TZ = sourceZone; clock(); vi.setSystemTime(new Date(at));
        const day = at.slice(0, 10); const selected = ['strict', 'fluid', 'section-only'];
        const initial = seed(); initial.tasks = [
            task('strict', { projectId: 'p1', sectionId: 's1', recurrence: { rule: 'monthly', strategy: 'strict', seriesId: 'strict-series' },
                startTime: `${day}T23:59:59-04:00`, dueDate: `${day}T23:59:59-05:00`, reviewAt: day, focusOrder: 9, isFocusedToday: true }),
            task('fluid', { projectId: 'p1', recurrence: { rule: 'weekly', strategy: 'fluid', seriesId: 'fluid-series' },
                startTime: '2027-03-01', dueDate: '2027-03-02T10:30:00+09:00', reviewAt: '2027-03-03',
                timeSpentMinutes: 18, attachments: seed().tasks![0].attachments, checklist: seed().tasks![0].checklist }),
            task('section-only', { sectionId: 's2', description: 'Legacy inferred parent', tags: ['#old'] }),
            task('unrelated', { status: 'next' }),
        ];
        const rn = await openSqliteHost(initial); let expected;
        try {
            await canonical(); const updates = buildBulkTaskTokenUpdates(selected, useTaskStore.getState()._tasksById, 'tags', 'tag', 'add');
            const allocate = vi.spyOn(uuid, 'generateUUID').mockImplementation(() => { throw new Error('Tag edit allocated'); });
            expect(await useTaskStore.getState().batchUpdateTasks(updates)).toEqual({ success: true }); await flushPendingSave();
            expect(useTaskStore.getState().persistenceFailure).toBeNull(); expect(allocate).not.toHaveBeenCalled(); allocate.mockRestore(); expected = await raw(rn);
        } finally { await rn.close(); }
        const sqlite = await openSqliteHost(initial);
        try {
            await canonical(); const command = await prepare(sqlite, request('tag', selected));
            expect(command.prepared.preparedOffsetMinutes).toBe(preparedOffset); expect(command.prepared.boundaryOffsetMinutes).toBe(boundaryOffset);
            expect(Object.keys(command.prepared.effect)).toEqual(['tasks', 'projects', 'sections']);
            expect(value(host(sqlite).validatePreparedInboxTasksAddTag(command))).toEqual({ count: 3, changed: true });
            process.env.TZ = targetZone; vi.setSystemTime(new Date('2028-12-01T15:30:00.000Z')); await sqlite.restart(undefined, { recoveryLoad: true });
            const allocate = vi.spyOn(uuid, 'generateUUID').mockImplementation(() => { throw new Error('Replay allocated'); });
            expect(statusBatchSourcesMatch({ ...command.request, status: 'next' }, command.prepared.scope, command.prepared.updateAt), 'frozen source').toBe(true);
            expect(clone(referenceTasksAddTagEffect(command.prepared)), 'frozen effect').toEqual(command.prepared.effect);
            expect(value(host(sqlite).validatePreparedInboxTasksAddTag(command))).toEqual({ count: 3, changed: true });
            expect(value(await host(sqlite).commitPreparedInboxTasksAddTag(command))).toEqual({ count: 3, changed: true }); expect(allocate).not.toHaveBeenCalled(); allocate.mockRestore();
            expect(await raw(sqlite)).toEqual(expected);
        } finally { await sqlite.close(); }
    });
    it('uses frozen parsedAt strictly beyond the boundary with no null/missing live fallback and leaves raw BEFORE intact', () => {
        clock(); process.env.TZ = 'Asia/Tokyo';
        const boundary = Date.parse('2026-03-09T03:59:59.999Z');
        for (const status of ['inbox', 'next', 'done', 'archived'] as const) {
            for (const startTime of [undefined, '', 'not-a-date', '2026-03-10', '2026-03-10T00:30:00', '2026-03-10T00:30:00+09:00']) {
            for (const parsedAt of [boundary - 1, boundary, boundary + 1, null, undefined]) {
                const row = task('frozen', { status, startTime, isFocusedToday: true, focusOrder: 9 }); const before = clone(row);
                const temporal = { futureBoundary: new Date(boundary).toISOString(), dates: new Map(parsedAt === undefined ? [] : [[row.startTime!, { parsedAt }]]) };
                const loaded = historyRowLoadProjection(row, '2026-03-08T06:30:00.000Z', temporal);
                const future = Boolean(startTime) && parsedAt != null && parsedAt > boundary;
                const terminal = status === 'done' || status === 'archived';
                expect(loaded.isFocusedToday).toBe(!terminal && (!future || status === 'next'));
                expect(loaded.focusOrder).toBe(terminal || future ? undefined : 9);
                expect(row).toEqual(before);
            }
            }
        }
        const invalid = task('invalid', { startTime: 'not-a-date', isFocusedToday: true, focusOrder: 9 });
        expect(normalizeTaskForLoad(invalid, NOW)).toEqual(normalizeTaskForLoad(invalid, NOW, { futureBoundary: NOW, dates: new Map([['not-a-date', { parsedAt: null }]]) }));
    });
    it('preserves the complete lossless revision dictionary for a 140-task actual RN batch', async () => {
        clock(); const selected = Array.from({ length: 140 }, (_, index) => `many-${index}`);
        const initial: Partial<AppData> = { tasks: selected.map((id) => task(id)), settings: { deviceId: DEVICE, analyticsProfileId: REQUEST_ID } };
        const rn = await openSqliteHost(initial); let expected;
        try { await canonical(); const updates = buildBulkTaskTokenUpdates(selected, useTaskStore.getState()._tasksById, 'tags', 'large', 'add');
            expect(await useTaskStore.getState().batchUpdateTasks(updates)).toEqual({ success: true }); await flushPendingSave(); expect(useTaskStore.getState().persistenceFailure).toBeNull(); expected = await raw(rn); }
        finally { await rn.close(); }
        const sqlite = await openSqliteHost(initial);
        try { await canonical(); const command = await prepare(sqlite, request('large', selected)); expect(Object.keys(command.prepared.request.taskRevisions)).toHaveLength(140);
            expect(value(await host(sqlite).commitPreparedInboxTasksAddTag(command))).toEqual({ count: 140, changed: true }); expect(await raw(sqlite)).toEqual(expected); }
        finally { await sqlite.close(); }
    });
    it.each([
        ['tags', "DROP TRIGGER tasks_validate_update", "UPDATE tasks SET tags = 'broken-json' WHERE id = 'a'"],
        ['recurrence', "DROP TRIGGER tasks_validate_update", "UPDATE tasks SET recurrence = 'broken-json' WHERE id = 'b'"],
        ['project attachments', "DROP TRIGGER projects_validate_update", "UPDATE projects SET attachments = 'broken-json' WHERE id = 'p1'"],
        ['settings', null, "UPDATE settings SET data = 'broken-json' WHERE id = 1"],
    ])('fails malformed raw %s authority closed before a journal or write', async (_label, dropTrigger, mutation) => {
        clock(); const sqlite = await openSqliteHost(seed());
        try { const command = await prepare(sqlite); if (dropTrigger) await sqlite.client().run(dropTrigger); await sqlite.client().run(mutation!); const before = await raw(sqlite);
            expect(await host(sqlite).prepareInboxTasksAddTag(command.request)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await host(sqlite).commitPreparedInboxTasksAddTag(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]); }
        finally { await sqlite.close(); }
    });
    it('rejects a real Area timestamp edit rather than ignoring legacy blank timestamps', async () => {
        clock(); const initial = seed(); initial.projects![0].areaId = 'area'; const sqlite = await openSqliteHost(initial);
        try { await sqlite.client().run("UPDATE areas SET createdAt = '', updatedAt = '' WHERE id = ?", ['area']); await sqlite.restart(undefined, { recoveryLoad: true }); const command = await prepare(sqlite);
            await sqlite.client().run('UPDATE areas SET updatedAt = ? WHERE id = ?', [NOW, 'area']); await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
            expect(await host(sqlite).commitPreparedInboxTasksAddTag(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } }); expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]); }
        finally { await sqlite.close(); }
    });
});
