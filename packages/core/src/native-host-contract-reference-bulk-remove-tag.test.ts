import { afterEach, describe, expect, it, vi } from 'vitest';
import { openScratchSqlite, openSqliteHost as openHost } from './screen-parity.replay';
import { taskRevisionOf, NativeReceiptSqliteAdapter } from './native-request-receipts';
import { flushPendingSave, getStorageAdapter, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { readAreaDurableData } from './native-host-contract-area-durable';
import { buildSaveSnapshot } from './store-helpers';
import { buildBulkTaskTokenUpdates } from './bulk-task-tokens';
import type { AppData, Task } from './types';
import { retainTaxonomyEffects } from './taxonomy-catalog';
import type { NativeReferenceTasksRemoveTagEnvelope } from './native-host-contract-reference-bulk-remove-tag';
import { deterministicHash128 } from './uuid';
import * as uuid from './uuid';
import * as logger from './logger';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const openSqliteHost: typeof openHost = (seed, wrap, bindings) => openHost(seed, wrap, bindings, { rejectConcurrentWrites: true });
const NOW = '2026-10-03T13:00:00.000Z';
const BEFORE = '2026-10-02T12:34:56.789Z';
const REQUEST_ID = '00000000-0000-4000-8000-000000000196';
const DEVICE = 'reference-move-device';
const ORIGINAL_TZ = process.env.TZ;
const clone = <T>(input: T): T => JSON.parse(JSON.stringify(input)) as T;
const value = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`); return result.value;
};
const task = (id: string, fields: Partial<Task> = {}): Task => ({ id, title: `Task ${id}`, status: 'reference',
    createdAt: BEFORE, updatedAt: BEFORE, tags: ['#new', '#tag', '#large'], contexts: [], rev: 3, revBy: DEVICE, ...fields });
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
const request = (tags: string | string[] = ['new'], taskIds = ['a', 'b'], requestId = REQUEST_ID, params = {}) => ({ requestId,
    taskIds, taskRevisions: Object.fromEntries(taskIds.map((id) => [id, taskRevisionOf(useTaskStore.getState()._tasksById.get(id)!)])), tags: typeof tags === 'string' ? [tags] : tags, params });
const host = (sqlite: Sqlite) => sqlite.host;
const receipts = (sqlite: Sqlite) => sqlite.sql('SELECT rowid AS _rowid,* FROM native_request_receipts ORDER BY rowid');
const prepare = async (sqlite: Sqlite, input = request()): Promise<NativeReferenceTasksRemoveTagEnvelope> => {
    const result = value(await host(sqlite).prepareReferenceTasksRemoveTag(input)); expect(result.kind).toBe('prepared');
    if (result.kind !== 'prepared') throw new Error('Changed tag must prepare');
    return clone({ request: input, prepared: result.prepared });
};
const clock = () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); };
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.restoreAllMocks(); vi.useRealTimers(); if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ; });

describe('guarded Reference bulk Remove tag', () => {
    it.each([
        ['mixed carriers', ['#new']],
        ['distinct raw picks with one normalized removal', ['#new', 'new', '@@##new']],
        ['all cleared', ['#keep', '#new']],
        ['case/Unicode/comma-space', ['#École', '#one,two words']],
        ['normalized 2001-unit and imported 5001-unit', ['#' + 'x'.repeat(2000), '#' + '界'.repeat(5000)]],
    ])('matches actual RN builder/batchUpdateTasks full AppData and all nine SQLite domains: %s', async (_label, tag) => {
        clock(); const initial = seed(); initial.tasks![0].tags = ['#keep', '#new', '#École', '#école', '#one,two words', '#' + 'x'.repeat(2000), '#' + '界'.repeat(5000)]; initial.tasks![1].tags = ['#keep'];
        if (tag[0] === '#keep') initial.tasks![0].tags = ['#keep', '#new'];
        const rn = await openSqliteHost(initial); let expected; let expectedRaw; let count = 0;
        try {
            await canonical(); const updates = buildBulkTaskTokenUpdates(['a', 'b'], useTaskStore.getState()._tasksById, 'tags', tag, 'remove');
            count = updates.length; expect(count).toBeGreaterThan(0);
            expect(await useTaskStore.getState().batchUpdateTasks(updates)).toEqual({ success: true });
            await flushPendingSave(); expect(useTaskStore.getState().persistenceFailure).toBeNull(); expected = rows(); expectedRaw = await raw(rn);
        } finally { await rn.close(); }
        const sqlite = await openSqliteHost(initial);
        try {
            await canonical(); const input = request(tag); const api = host(sqlite);
            expect(api.prepareReferenceTasksRemoveTag).toBeTypeOf('function');
            const result = value(await api.prepareReferenceTasksRemoveTag(input)); expect(result.kind).toBe('prepared');
            if (result.kind !== 'prepared') throw new Error('Changed tag must prepare');
            expect(value(await api.commitPreparedReferenceTasksRemoveTag({ request: input, prepared: result.prepared }))).toEqual({ count, changed: true });
            expect(rows()).toEqual(expected); expect(await raw(sqlite)).toEqual(expectedRaw); expect(await sqlite.receiptIds()).toEqual([REQUEST_ID]);
        } finally { await sqlite.close(); }
    });
    it.each(['#gone', '@#@', ' @@## ', '#NEW'])('fresh no-op preserves all raw cells, missing device and receipts for %s', async (tag) => {
        clock(); const initial = seed(); initial.tasks![0].tags = ['new', '#new', '#new']; initial.tasks![1].tags = ['#keep'];
        const writes = vi.fn(); const sqlite = await openSqliteHost(initial, (client) => ({ ...client, run: async (sql, params) => {
            if (/^(INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)/i.test(sql)) writes(sql); return client.run(sql, params);
        } }));
        try {
            await sqlite.client().run("UPDATE settings SET data = json_remove(data, '$.deviceId') WHERE id = 1");
            await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite); writes.mockClear();
            expect(buildBulkTaskTokenUpdates(['a', 'b'], useTaskStore.getState()._tasksById, 'tags', tag, 'remove')).toEqual([]);
            const logs = vi.spyOn(logger, 'logInfo'); const allocate = vi.spyOn(uuid, 'generateUUID').mockImplementation(() => { throw new Error('No-op allocated'); });
            const api = host(sqlite); expect(api.prepareReferenceTasksRemoveTag).toBeTypeOf('function');
            expect(value(await api.prepareReferenceTasksRemoveTag(request(tag)))).toEqual({ kind: 'noop', result: { count: 0, changed: false } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]); expect(writes).not.toHaveBeenCalled();
            expect(logs.mock.calls.filter(([message]) => message === 'Native Reference bulk Remove tag confirmed')).toEqual([]);
            expect(allocate).not.toHaveBeenCalled(); expect(useTaskStore.getState().settings.deviceId).toBeUndefined();
        } finally { await sqlite.close(); }
    });
});

describe('Reference Remove tag exact authority and durable replay', () => {
    it('refuses a Remove-tag adapter switch during deferred module loading without memory, raw data or save-boundary changes', async () => {
        clock(); const sqlite = await openSqliteHost(seed()); const adapter = getStorageAdapter();
        try {
            await canonical(); const command = await prepare(sqlite); const read = value(await readAreaDurableData(false, true));
            const before = await raw(sqlite); const memory = useTaskStore.getState();
            const replacement = new NativeReceiptSqliteAdapter(sqlite.client(), { rejectConcurrentWrites: true });
            const committing = memory.commitPreparedReferenceTasksRemoveTag(command.prepared, read.authority);
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
            expect(command.request.tags[0]).toBe('  @@## new  ');
            const logs = vi.spyOn(logger, 'logInfo'); const result = { count: 2, changed: true };
            expect(value(host(sqlite).validatePreparedReferenceTasksRemoveTag(command))).toEqual(result);
            expect(value(host(sqlite).referenceTasksRemoveTagOutcome(command))).toBeNull();
            expect(value(await host(sqlite).commitPreparedReferenceTasksRemoveTag(command))).toEqual(result);
            expect(logs).toHaveBeenCalledWith('Native Reference bulk Remove tag confirmed', expect.objectContaining({ context: {
                releaseCheck: 'v1.3.4/ios-reference-bulk-remove-tag', count: 2, outcome: 'removed' } }));
            const payload = JSON.stringify(['referenceTasksRemoveTag', command], (_name, item) => item && typeof item === 'object' && !Array.isArray(item)
                ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
            const fingerprint = `referenceTasksRemoveTag:${deterministicHash128(payload).map((part) => part.toString(16).padStart(8, '0')).join('')}`;
            expect(await receipts(sqlite)).toEqual([{ _rowid: 1, request_id: REQUEST_ID, method: fingerprint, reply: JSON.stringify(result), saved_at: NOW }]);
            await sqlite.client().run('UPDATE tasks SET title = ?, tags = ?, rev = rev + 1 WHERE id = ?', ['Later task', '["#later"]', 'a']);
            await sqlite.client().run('PRAGMA foreign_keys = OFF'); await sqlite.client().run('UPDATE tasks SET projectId = ? WHERE id = ?', ['', 'unrelated']);
            await sqlite.client().run('PRAGMA foreign_keys = ON'); await sqlite.restart(undefined, { recoveryLoad: true });
            const before = await raw(sqlite); const saved = await receipts(sqlite);
            expect(value(host(sqlite).referenceTasksRemoveTagOutcome(command))).toEqual(result);
            expect(value(await host(sqlite).commitPreparedReferenceTasksRemoveTag(command))).toEqual(result);
            const changed = clone(command); changed.request.tags = ['#new']; changed.prepared.request.tags = ['#new'];
            expect(value(host(sqlite).validatePreparedReferenceTasksRemoveTag(changed))).toEqual(result);
            expect(await host(sqlite).commitPreparedReferenceTasksRemoveTag(changed)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual(saved);
            await sqlite.client().run('DELETE FROM tasks WHERE id IN (?,?)', ['a', 'b']); await sqlite.restart(undefined, { recoveryLoad: true }); const deleted = await raw(sqlite);
            expect(value(host(sqlite).referenceTasksRemoveTagOutcome(command))).toEqual(result); expect(value(await host(sqlite).commitPreparedReferenceTasksRemoveTag(command))).toEqual(result);
            expect(await raw(sqlite)).toEqual(deleted); expect(await receipts(sqlite)).toEqual(saved);
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
                fault.commits = 10; expect(await host(sqlite).commitPreparedReferenceTasksRemoveTag(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
                expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]); expect(value(host(sqlite).referenceTasksRemoveTagOutcome(command))).toBeNull();
            }
            expect(logs.mock.calls.filter(([message]) => message === 'Native Reference bulk Remove tag confirmed')).toEqual([]);
            fault.commits = 0; vi.setSystemTime(new Date('2028-10-03T15:00:00.000Z'));
            if (recovery === 'cold') await sqlite.restart(undefined, { recoveryLoad: true });
            const allocate = vi.spyOn(uuid, 'generateUUID').mockImplementation(() => { throw new Error('Replay allocated'); });
            expect(value(await host(sqlite).commitPreparedReferenceTasksRemoveTag(command))).toEqual({ count: 2, changed: true }); allocate.mockRestore();
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(useTaskStore.getState().settings.deviceId).toBe(command.prepared.deviceIdToInitialize);
            expect(value(host(sqlite).referenceTasksRemoveTagOutcome(command))).toEqual({ count: 2, changed: true }); expect(await sqlite.receiptIds()).toEqual([REQUEST_ID]);
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 30_000);
    it('does not adopt an unrelated later failed save generation as ownership', async () => {
        clock(); const fault = { commits: 0 }; const sqlite = await openSqliteHost(seed(), (client) => ({ ...client,
            run: async (sql, params) => { if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('Injected tag failure'); } return client.run(sql, params); } }));
        try {
            const command = await prepare(sqlite); fault.commits = 10;
            expect(await host(sqlite).commitPreparedReferenceTasksRemoveTag(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); const before = await raw(sqlite);
            await useTaskStore.getState().updateTask('unrelated', { description: 'Later writer' }); fault.commits = 10;
            await expect(flushPendingSave()).rejects.toThrow('Injected tag failure');
            expect(await host(sqlite).commitPreparedReferenceTasksRemoveTag(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]);
        } finally { fault.commits = 0; resetForTests(); await sqlite.close(); }
    }, 30_000);
    it.each([
        ['selected same revision', 'UPDATE tasks SET description = ? WHERE id = ?', ['Changed', 'a']],
        ['selected no-op task revision', 'UPDATE tasks SET rev = rev + 1 WHERE id = ?', ['a']],
        ['parent lifecycle', 'UPDATE projects SET status = ? WHERE id = ?', ['archived', 'p1']],
        ['container member', 'UPDATE tasks SET projectId = ? WHERE id = ?', ['p1', 'unrelated']],
        ['area scope', "UPDATE settings SET data = json_set(data, '$.filters', 'missing-area') WHERE id = 1", []],
    ] as const)('rejects unsaved %s drift without domain/receipt writes', async (_label, sql, args) => {
        clock(); const initial = seed(); initial.tasks![1].tags = ['#keep']; const sqlite = await openSqliteHost(initial);
        try {
            const command = await prepare(sqlite); expect(command.prepared.result.count).toBe(1);
            await sqlite.client().run(sql, [...args]); await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
            expect(await host(sqlite).commitPreparedReferenceTasksRemoveTag(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]);
        } finally { await sqlite.close(); }
    });
    it('checks every selected row even for a fresh all-noncarried no-op, plus missing/deleted/archived selection', async () => {
        clock(); const initial = seed(); initial.tasks![0].tags = initial.tasks![1].tags = ['#keep']; const sqlite = await openSqliteHost(initial);
        try {
            const original = request('gone'); await sqlite.client().run('UPDATE tasks SET rev = rev + 1 WHERE id = ?', ['a']); await sqlite.restart(undefined, { recoveryLoad: true });
            expect(await host(sqlite).prepareReferenceTasksRemoveTag(original)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            for (const ids of [['missing'], ['history']]) {
                const input = { ...request(), taskIds: ids, taskRevisions: Object.fromEntries(ids.map((id) => [id, '1:fixture:before'])) };
                expect(await host(sqlite).prepareReferenceTasksRemoveTag(input)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            }
            await sqlite.client().run('UPDATE projects SET status = ? WHERE id = ?', ['archived', 'p1']); await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
            expect(await host(sqlite).prepareReferenceTasksRemoveTag(request('gone', ['a'], REQUEST_ID, { includeArchivedProjects: true }))).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]);
        } finally { await sqlite.close(); }
    });
    it.each([
        ['filtered source', { filters: { searchQuery: 'nonmatching source' } }],
        ['folded project', { groupBy: 'project', collapsedGroupIds: ['project:p1'] }],
    ])('refuses %s selection and allows exact filtered selection across a larger paged list', async (_label, params) => {
        clock(); const initial = seed(); initial.tasks!.push(...Array.from({ length: 130 }, (_, index) => task(`page-${index}`))); const sqlite = await openSqliteHost(initial);
        try {
            expect(await host(sqlite).prepareReferenceTasksRemoveTag(request('new', ['a'], REQUEST_ID, params))).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            const command = await prepare(sqlite, request('new', ['page-129'], REQUEST_ID, { filters: { searchQuery: 'Task page-129' } }));
            expect(value(await host(sqlite).commitPreparedReferenceTasksRemoveTag(command))).toEqual({ count: 1, changed: true });
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
            const command = await prepare(sqlite); let externalRaw: Awaited<ReturnType<typeof raw>> | undefined;
            race.mutate = async () => { await other.client.run(query, [...args]); externalRaw = await raw(sqlite); }; race.ready = true;
            expect(await host(sqlite).commitPreparedReferenceTasksRemoveTag(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            const after = await raw(sqlite); expect(await receipts(sqlite)).toEqual([]);
            expect(after).toEqual(externalRaw); // The external write survives; the rejected transaction changed no domain cell.
            await sqlite.restart(undefined, { recoveryLoad: true });
            if (label === 'settings' || label === 'unrelated row') {
                value(await host(sqlite).commitPreparedReferenceTasksRemoveTag(command)); const final = await raw(sqlite);
                // The successful RN-equivalent write also retains this exact prepared token effect.
                const expectedSettings = clone(after.settings);
                expectedSettings.rows[0].data = JSON.stringify(retainTaxonomyEffects(JSON.parse(expectedSettings.rows[0].data),
                    command.prepared.effect.tasks, command.prepared.effect.projects));
                expect(final.settings).toEqual(expectedSettings);
                expect(final.tasks.rows.find((r: { id: string }) => r.id === 'unrelated')).toEqual(after.tasks.rows.find((r: { id: string }) => r.id === 'unrelated'));
            } else { expect(await host(sqlite).commitPreparedReferenceTasksRemoveTag(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } }); expect(await raw(sqlite)).toEqual(after); }
        } finally { other.close(); await sqlite.close(); }
    }, 30_000);
    it('fails unsupported unguarded adapters and invalid FK/probe authority closed', async () => {
        clock(); const unguarded = await openHost(seed());
        try { expect(await host(unguarded).prepareReferenceTasksRemoveTag(request())).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); expect(await receipts(unguarded)).toEqual([]); }
        finally { await unguarded.close(); }
        const fault = { probe: false }; const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, get: async (sql, params) => {
            if (fault.probe && sql.includes('pragma_foreign_key_check')) throw new Error('Probe failure'); return client.get(sql, params);
        } }));
        try {
            const command = await prepare(sqlite); const input = request(); const before = await raw(sqlite); fault.probe = true;
            expect(await host(sqlite).prepareReferenceTasksRemoveTag(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await host(sqlite).commitPreparedReferenceTasksRemoveTag(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); fault.probe = false;
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]);
            await sqlite.client().run('PRAGMA foreign_keys = OFF'); await sqlite.client().run('UPDATE tasks SET projectId = ? WHERE id = ?', ['', 'unrelated']); await sqlite.client().run('PRAGMA foreign_keys = ON');
            await sqlite.restart(undefined, { recoveryLoad: true }); const malformed = await raw(sqlite);
            expect(await host(sqlite).prepareReferenceTasksRemoveTag(request())).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await host(sqlite).commitPreparedReferenceTasksRemoveTag(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(malformed); expect(await receipts(sqlite)).toEqual([]);
        } finally { fault.probe = false; await sqlite.close(); }
    });
    it('rejects malformed envelope/effect/date/count/input and cross-family UUID reuse before own writes', async () => {
        clock(); const calls = vi.fn(); const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, run: async (sql, params) => {
            if (/^(INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)/i.test(sql)) calls(sql); return client.run(sql, params);
        } }));
        try {
            const command = await prepare(sqlite); const authority = value(await readAreaDurableData(false, true)).authority; const memory = useTaskStore.getState();
            for (const mutate of [
                (e: NativeReferenceTasksRemoveTagEnvelope) => { e.prepared.effect.tasks[0].after.tags = ['#forged']; },
                (e: NativeReferenceTasksRemoveTagEnvelope) => { e.prepared.result.count += 1; },
                (e: NativeReferenceTasksRemoveTagEnvelope) => { e.prepared.futureBoundary = NOW; },
                (e: NativeReferenceTasksRemoveTagEnvelope) => { e.request.tags = ['different']; e.prepared.request.tags = ['different']; },
                (e: NativeReferenceTasksRemoveTagEnvelope) => { e.prepared.scope.tasks.push(task('extra')); },
            ]) { const invalid = clone(command); mutate(invalid); calls.mockClear();
                expect(host(sqlite).validatePreparedReferenceTasksRemoveTag(invalid)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(await host(sqlite).commitPreparedReferenceTasksRemoveTag(invalid)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } }); expect(calls).not.toHaveBeenCalled();
                expect(await useTaskStore.getState().commitPreparedReferenceTasksRemoveTag(invalid.prepared, authority)).toMatchObject({ success: false }); expect(useTaskStore.getState()).toBe(memory); expect(authority.saveBoundary).toBeUndefined(); expect(calls).not.toHaveBeenCalled(); }
            for (const change of [{ tags: [] }, { tags: [''] }, { tags: [' '] }, { tags: ['new', 'new'] }, { tags: [42] }, { tags: 'new' }, { tags: Array.from({ length: 10_001 }, (_, i) => String(i)) }, { tags: ['x'.repeat(2_000_001)] }, { tags: ['界'.repeat(700_000)] }, { extra: true }, { taskIds: ['a', 'a'] }, { tag: {} }]) {
                calls.mockClear(); expect(await host(sqlite).prepareReferenceTasksRemoveTag({ ...request(), ...change } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } }); expect(calls).not.toHaveBeenCalled();
            }
            const moveRequest = { requestId: REQUEST_ID, taskIds: ['a'], taskRevisions: request().taskRevisions, status: 'next' as const, params: {} };
            moveRequest.taskRevisions = { a: moveRequest.taskRevisions.a };
            const move = value(await host(sqlite).prepareReferenceTasksMove(moveRequest)); value(await host(sqlite).commitPreparedReferenceTasksMove({ request: moveRequest, prepared: move.prepared }));
            expect(await host(sqlite).commitPreparedReferenceTasksRemoveTag(command)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await sqlite.receiptIds()).toEqual([REQUEST_ID]);
        } finally { await sqlite.close(); }
    });
    it('binds exact Unicode/protected IDs and NFC/NFD tag bytes to actual RN', async () => {
        clock(); const selected = ['é', 'e\u0301', 'constructor', '__proto__', 'prototype'];
        const initial: Partial<AppData> = { tasks: selected.map((id) => task(id, { tags: ['#é', '#e\u0301', '#É'] })), settings: { deviceId: DEVICE, analyticsProfileId: REQUEST_ID } };
        const rn = await openSqliteHost(initial); let expected;
        try { await canonical(); const updates = buildBulkTaskTokenUpdates(selected, useTaskStore.getState()._tasksById, 'tags', [' ###é '], 'remove'); expect(await useTaskStore.getState().batchUpdateTasks(updates)).toEqual({ success: true }); await flushPendingSave(); expect(useTaskStore.getState().persistenceFailure).toBeNull(); expected = await raw(rn); }
        finally { await rn.close(); }
        const sqlite = await openSqliteHost(initial);
        try { await canonical(); const command = await prepare(sqlite, request([' ###é '], selected)); value(await host(sqlite).commitPreparedReferenceTasksRemoveTag(command)); expect(await raw(sqlite)).toEqual(expected);
            expect(command.request.tags).toEqual([' ###é ']); expect(rows().tasks.every((row) => row.tags?.includes('#e\u0301') && row.tags.includes('#É') && !row.tags.includes('#é'))).toBe(true);
            expect(command.request.taskIds.map((id) => [...new TextEncoder().encode(id)])).toEqual(selected.map((id) => [...new TextEncoder().encode(id)])); }
        finally { await sqlite.close(); }
    });
    it('refuses equal target state without the original receipt after an independent actual RN write', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try { await canonical(); const command = await prepare(sqlite); const updates = buildBulkTaskTokenUpdates(command.request.taskIds, useTaskStore.getState()._tasksById, 'tags', command.request.tags, 'remove');
            expect(await useTaskStore.getState().batchUpdateTasks(updates)).toEqual({ success: true }); await flushPendingSave(); expect(useTaskStore.getState().persistenceFailure).toBeNull();
            await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
            expect(value(host(sqlite).referenceTasksRemoveTagOutcome(command))).toBeNull(); expect(await host(sqlite).commitPreparedReferenceTasksRemoveTag(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]);
        } finally { await sqlite.close(); }
    });
    it('accepts 10,000 distinct exact raw picks and exposes the existing paged union without writes', async () => {
        clock(); const tags = Array.from({ length: 150 }, (_, index) => `#page-${String(index).padStart(3, '0')}`);
        const initial = seed(); initial.tasks![0].tags = tags; initial.tasks![1].tags = ['#keep']; const sqlite = await openSqliteHost(initial);
        try { const before = await raw(sqlite); const first = value(host(sqlite).getBulkActions({ list: 'reference', params: {}, taskIds: ['a', 'b'], picker: { kind: 'removeTag', limit: 25 } }));
            expect(first.selectedIds).toEqual(['a', 'b']); expect(first.picker?.total).toBe(151); expect(first.picker?.items).toHaveLength(25);
            const next = value(host(sqlite).getBulkActions({ list: 'reference', params: {}, taskIds: ['a', 'b'], picker: { kind: 'removeTag', offset: 25, limit: 25, revision: first.revision } }));
            expect(next.picker?.items).toHaveLength(25); expect(next.picker?.items.some((row) => first.picker?.items.some((old) => old.value === row.value))).toBe(false);
            const picked = [' ###page-000 ', ...Array.from({ length: 9_999 }, (_, index) => `not-carried-${index}`)]; const command = await prepare(sqlite, request(picked));
            expect(command.request.tags).toEqual(picked); expect(command.prepared.result).toEqual({ count: 1, changed: true }); expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]);
        } finally { await sqlite.close(); }
    });
    it('preserves raw NULL/legacy JSON provenance and matches actual RN loaded result', async () => {
        clock(); const setup = async () => { const sqlite = await openSqliteHost(seed()); await canonical();
            await sqlite.client().run('UPDATE tasks SET tags = NULL, contexts = NULL, projectId = NULL WHERE id = ?', ['a']);
            await sqlite.client().run('UPDATE tasks SET pushCount = NULL WHERE id = ?', ['unrelated']);
            await sqlite.client().run('UPDATE projects SET tagIds = NULL, attachments = ? WHERE id = ?', [JSON.stringify([{ id: 'legacy-link', kind: 'link', title: 'Fixture', uri: 'https://example.com', createdAt: BEFORE }]), 'p2']);
            await sqlite.restart(undefined, { recoveryLoad: true }); return sqlite; };
        const rn = await setup(); let expected;
        try { const updates = buildBulkTaskTokenUpdates(['a', 'b'], useTaskStore.getState()._tasksById, 'tags', 'new', 'remove'); expect(await useTaskStore.getState().batchUpdateTasks(updates)).toEqual({ success: true }); await flushPendingSave(); expect(useTaskStore.getState().persistenceFailure).toBeNull(); expected = rows(); } finally { await rn.close(); }
        const sqlite = await setup();
        try { const command = await prepare(sqlite); const before = await raw(sqlite);
            expect(Object.hasOwn(command.prepared.scope.tasks.find((r) => r.id === 'a')!, 'tags')).toBe(false);
            value(await host(sqlite).commitPreparedReferenceTasksRemoveTag(command)); const after = await raw(sqlite);
            expect(after.projects).toEqual(before.projects); expect(after.tasks.rows.find((r: { id: string }) => r.id === 'unrelated')).toEqual(before.tasks.rows.find((r: { id: string }) => r.id === 'unrelated'));
            await sqlite.restart(undefined, { recoveryLoad: true }); expect(rows()).toEqual(expected);
        } finally { await sqlite.close(); }
    });
    it.each(['same-host', 'cold'] as const)('preserves blank raw Area timestamps through %s retry', async (recovery) => {
        clock(); const fault = { commits: 0 }; const initial = seed(); initial.projects![0].areaId = 'area';
        const sqlite = await openSqliteHost(initial, (client) => ({ ...client, run: async (sql, params) => { if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('Injected tag failure'); } return client.run(sql, params); } }));
        try { await sqlite.client().run("UPDATE areas SET createdAt = '', updatedAt = '' WHERE id = ?", ['area']); await sqlite.restart(undefined, { recoveryLoad: true });
            const command = await prepare(sqlite); const before = await raw(sqlite); expect(command.prepared.scope.areas[0].createdAt).toBe('');
            fault.commits = 10; expect(await host(sqlite).commitPreparedReferenceTasksRemoveTag(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); fault.commits = 0;
            vi.setSystemTime(new Date('2027-10-03T15:00:00.000Z')); if (recovery === 'cold') await sqlite.restart(undefined, { recoveryLoad: true });
            value(await host(sqlite).commitPreparedReferenceTasksRemoveTag(command)); expect((await raw(sqlite)).areas).toEqual(before.areas);
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 30_000);
    it.each([
        ['spring', '2026-03-08T06:30:00.000Z', 300, 240],
        ['autumn', '2026-11-01T05:30:00.000Z', 240, 300],
    ] as const)('matches actual RN date/hidden-field effects and freezes %s DST policy across cold travel without allocation', async (_label, at, preparedOffset, boundaryOffset) => {
        process.env.TZ = 'America/New_York'; clock(); vi.setSystemTime(new Date(at));
        const day = at.slice(0, 10); const selected = ['strict', 'fluid', 'section-only'];
        const initial = seed(); initial.tasks = [
            task('strict', { projectId: 'p1', sectionId: 's1', recurrence: { rule: 'monthly', strategy: 'strict', seriesId: 'strict-series' },
                startTime: `${day}T23:59:59-04:00`, dueDate: `${day}T23:59:59-05:00`, reviewAt: day, focusOrder: 9, isFocusedToday: true }),
            task('fluid', { projectId: 'p1', recurrence: { rule: 'weekly', strategy: 'fluid', seriesId: 'fluid-series' },
                startTime: '2027-03-01', dueDate: '2027-03-02T10:30:00+09:00', reviewAt: '2027-03-03',
                timeSpentMinutes: 18, attachments: seed().tasks![0].attachments, checklist: seed().tasks![0].checklist }),
            task('section-only', { sectionId: 's2', description: 'Legacy inferred parent', tags: ['#old', '#tag'] }),
            task('unrelated', { status: 'next' }),
        ];
        const rn = await openSqliteHost(initial); let expected;
        try {
            await canonical(); const updates = buildBulkTaskTokenUpdates(selected, useTaskStore.getState()._tasksById, 'tags', 'tag', 'remove');
            const allocate = vi.spyOn(uuid, 'generateUUID').mockImplementation(() => { throw new Error('Tag edit allocated'); });
            expect(await useTaskStore.getState().batchUpdateTasks(updates)).toEqual({ success: true }); await flushPendingSave();
            expect(useTaskStore.getState().persistenceFailure).toBeNull(); expect(allocate).not.toHaveBeenCalled(); allocate.mockRestore(); expected = await raw(rn);
        } finally { await rn.close(); }
        const sqlite = await openSqliteHost(initial);
        try {
            await canonical(); const command = await prepare(sqlite, request('tag', selected));
            expect(command.prepared.preparedOffsetMinutes).toBe(preparedOffset); expect(command.prepared.boundaryOffsetMinutes).toBe(boundaryOffset);
            expect(Object.keys(command.prepared.effect)).toEqual(['tasks', 'projects', 'sections']);
            process.env.TZ = 'Asia/Tokyo'; vi.setSystemTime(new Date('2028-12-01T15:30:00.000Z')); await sqlite.restart(undefined, { recoveryLoad: true });
            const allocate = vi.spyOn(uuid, 'generateUUID').mockImplementation(() => { throw new Error('Replay allocated'); });
            expect(value(host(sqlite).validatePreparedReferenceTasksRemoveTag(command))).toEqual({ count: 3, changed: true });
            expect(value(await host(sqlite).commitPreparedReferenceTasksRemoveTag(command))).toEqual({ count: 3, changed: true }); expect(allocate).not.toHaveBeenCalled(); allocate.mockRestore();
            expect(await raw(sqlite)).toEqual(expected);
        } finally { await sqlite.close(); }
    });
    it('preserves the complete lossless revision dictionary and 150 exact picks for a 140-task actual RN batch', async () => {
        clock(); const selected = Array.from({ length: 140 }, (_, index) => `many-${index}`);
        const tags = Array.from({ length: 150 }, (_, index) => `#pick-${index}`);
        const initial: Partial<AppData> = { tasks: selected.map((id) => task(id, { tags: [...tags, '#keep'] })), settings: { deviceId: DEVICE, analyticsProfileId: REQUEST_ID } };
        const rn = await openSqliteHost(initial); let expected;
        try { await canonical(); const updates = buildBulkTaskTokenUpdates(selected, useTaskStore.getState()._tasksById, 'tags', tags, 'remove');
            expect(await useTaskStore.getState().batchUpdateTasks(updates)).toEqual({ success: true }); await flushPendingSave(); expect(useTaskStore.getState().persistenceFailure).toBeNull(); expected = await raw(rn); }
        finally { await rn.close(); }
        const sqlite = await openSqliteHost(initial);
        try { await canonical(); const command = await prepare(sqlite, request(tags, selected)); expect(Object.keys(command.prepared.request.taskRevisions)).toHaveLength(140); expect(command.prepared.request.tags).toEqual(tags);
            expect(value(await host(sqlite).commitPreparedReferenceTasksRemoveTag(command))).toEqual({ count: 140, changed: true }); expect(await raw(sqlite)).toEqual(expected); }
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
            expect(await host(sqlite).prepareReferenceTasksRemoveTag(command.request)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await host(sqlite).commitPreparedReferenceTasksRemoveTag(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]); }
        finally { await sqlite.close(); }
    });
    it('rejects a real Area timestamp edit rather than ignoring legacy blank timestamps', async () => {
        clock(); const initial = seed(); initial.projects![0].areaId = 'area'; const sqlite = await openSqliteHost(initial);
        try { await sqlite.client().run("UPDATE areas SET createdAt = '', updatedAt = '' WHERE id = ?", ['area']); await sqlite.restart(undefined, { recoveryLoad: true }); const command = await prepare(sqlite);
            await sqlite.client().run('UPDATE areas SET updatedAt = ? WHERE id = ?', [NOW, 'area']); await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
            expect(await host(sqlite).commitPreparedReferenceTasksRemoveTag(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } }); expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]); }
        finally { await sqlite.close(); }
    });
});

// Captured from the exact pre-742 production prepare/commit under the same clock/zone.
it('keeps the complete pre-742 Reference envelope/reply/fingerprint/receipt bytes', async () => {
    process.env.TZ = 'UTC'; clock();
    const sqlite = await openSqliteHost({ tasks: ['a', 'b'].map(id => ({ id, title: id, status: 'reference' as const,
        tags: ['#new', '#keep'], contexts: [], createdAt: BEFORE, updatedAt: BEFORE, rev: 3, revBy: DEVICE })), settings: { deviceId: DEVICE } });
    try {
        const input = request(['  @@## new  ', 'not-carried']); const envelope = await prepare(sqlite, input);
        const reply = await host(sqlite).commitPreparedReferenceTasksRemoveTag(envelope);
        const saved = await sqlite.sql('SELECT request_id,method,reply,saved_at FROM native_request_receipts ORDER BY rowid');
        const bytes = JSON.stringify({ envelope, reply, receipts: saved }) + '\n';
        expect(Buffer.byteLength(bytes)).toBe(2936);
        expect(createHash('sha256').update(bytes).digest('hex')).toBe('b9f27e11f9f91d065aaefc09e5f487af686f3f02718e5de7a633095072260f21');
    } finally { await sqlite.close(); }
});
