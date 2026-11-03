import { afterEach, describe, expect, it, vi } from 'vitest';
import { createArchivedTasksRestoreMethods, type NativeArchivedTasksRestoreEnvelope } from './native-host-contract-archive-bulk-restore';
import { openSqliteHost } from './screen-parity.replay';
import { taskRevisionOf } from './native-request-receipts';
import { flushPendingSave, getStorageAdapter, resetForTests, useTaskStore } from './store';
import { buildSaveSnapshot } from './store-helpers';
import { buildBulkTaskTokenUpdates } from './bulk-task-tokens';
import * as logger from './logger';
import { deterministicHash128 } from './uuid';
import { readAreaDurableData } from './native-host-contract-area-durable';
import type { AppData, Task } from './types';

const NOW = '2026-10-03T13:00:00.000Z';
const BEFORE = '2026-10-02T12:34:56.789Z';
const UUID = '00000000-0000-4000-8000-000000000185';
const DEVICE = 'remove-tag-device';
const clone = <T>(input: T): T => JSON.parse(JSON.stringify(input)) as T;
const value = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`); return result.value;
};
const task = (id: string, fields: Partial<Task> = {}): Task => ({ id, title: `Task ${id}`, status: 'done',
    createdAt: BEFORE, updatedAt: BEFORE, completedAt: BEFORE, tags: ['#keep'], contexts: ['@desk'], rev: 3, revBy: DEVICE, ...fields });
const seed = (): Partial<AppData> => ({ tasks: [task('b', { tags: ['#keep', '#new'], projectId: 'p2', sectionId: 's2',
    recurrence: { rule: 'daily', strategy: 'strict', seriesId: 'series' },
    attachments: [{ id: 'link', kind: 'link', title: 'Fixture', uri: 'https://example.com', createdAt: BEFORE, updatedAt: BEFORE }],
    checklist: [{ id: 'step', title: 'Step', isCompleted: true }], timeSpentMinutes: 45,
    dueDate: '2026-10-05', startTime: '2026-10-04', reviewAt: '2026-10-06' }),
task('a', { projectId: 'p1', sectionId: 's1', tags: ['#keep'] }),
task('sibling', { status: 'next', completedAt: undefined, projectId: 'p1', order: 8, orderNum: 8 }),
task('history', { projectId: 'p1', deletedAt: BEFORE }), task('unrelated')],
projects: ['p1', 'p2'].map((id) => ({ id, title: `Parent ${id}`, status: 'active', color: '#94a3b8', order: 0,
    tagIds: [], createdAt: BEFORE, updatedAt: BEFORE, rev: 2, revBy: DEVICE })),
sections: ['s1', 's2'].map((id, index) => ({ id, projectId: `p${index + 1}`, title: `Section ${id}`, order: 0, createdAt: BEFORE, updatedAt: BEFORE, rev: 1, revBy: DEVICE })),
areas: [{ id: 'area', name: 'Area', order: 0, createdAt: BEFORE, updatedAt: BEFORE }],
people: [{ id: 'person', name: 'Person', createdAt: BEFORE, updatedAt: BEFORE }],
settings: { deviceId: DEVICE, analyticsProfileId: UUID, gtd: { autoArchiveDays: 7 } } });
type Sqlite = Awaited<ReturnType<typeof openSqliteHost>>;
const raw = async (sqlite: Sqlite) => Object.fromEntries(await Promise.all([
    'tasks', 'projects', 'sections', 'areas', 'people', 'settings', 'saved_filters', 'schema_migrations', 'calendar_sync',
].map(async (table) => [table, await sqlite.sql(`SELECT rowid AS _rowid, * FROM ${table} ORDER BY rowid`)])));
const receipts = (sqlite: Sqlite) => sqlite.sql('SELECT rowid AS _rowid, * FROM native_request_receipts ORDER BY rowid');
const rows = () => clone(buildSaveSnapshot(useTaskStore.getState()));
const canonical = async () => getStorageAdapter().saveData(buildSaveSnapshot(useTaskStore.getState()));
const methods = () => createArchivedTasksRestoreMethods({ readiness: () => ({ ok: true, value: null }), save: async () => {
    try { await flushPendingSave(); } catch { return { ok: false, error: { code: 'SAVE_FAILED', message: 'Injected failure' } }; }
    return useTaskStore.getState().persistenceFailure
        ? { ok: false, error: { code: 'SAVE_FAILED', message: 'Unresolved failure' } } : { ok: true, value: null };
} });
const request = (tags = ['new'], taskIds = ['a', 'b'], requestId = UUID) => ({ requestId,
    taskIds, taskRevisions: Object.fromEntries(taskIds.map((id) => [id, taskRevisionOf(useTaskStore.getState()._tasksById.get(id)!)])),
    source: 'done' as const, action: 'removeTag' as const, tags });
const prepare = async (host = methods(), input = request()) => {
    const result = value(await host.prepareArchivedTasksRestore(input));
    expect(result.kind).toBe('prepared');
    if (result.kind !== 'prepared') throw new Error('Changed Remove tag must prepare');
    return { request: input, prepared: result.prepared } as NativeArchivedTasksRestoreEnvelope;
};
const clock = () => { logger.setLogger(() => {}); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); };
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); vi.restoreAllMocks(); logger.setLogger(logger.consoleLogger); });

describe('guarded Done bulk Remove tag', () => {
    it.each([
        ['mixed carriers', ['#new']],
        ['distinct exact picks normalizing to one removal', ['#new', 'new', '@@##new']],
        ['multiple picked tags/all cleared', ['#keep', '#new']],
        ['exact case/Unicode/one comma-space token', ['#École', '#one,two words']],
        ['normalized Task184 2001-unit and imported longer tags', ['#' + 'x'.repeat(2000), '#' + '界'.repeat(5000)]],
    ])('matches actual RN removal builder/batch full AppData and all nine canonical SQL tables: %s', async (_name, tags) => {
        clock(); const initial = seed();
        initial.tasks![0].tags = ['#keep', '#new', '#École', '#école', '#one,two words', '#' + 'x'.repeat(2000), '#' + '界'.repeat(5000)];
        if (tags.length === 2 && tags[0] === '#keep') initial.tasks![0].tags = ['#keep', '#new'];
        const rn = await openSqliteHost(initial); let expected; let expectedRaw; let count = 0;
        try {
            await canonical(); const updates = buildBulkTaskTokenUpdates(['a', 'b'], useTaskStore.getState()._tasksById, 'tags', tags, 'remove');
            count = updates.length; expect(count).toBeGreaterThan(0);
            expect(await useTaskStore.getState().batchUpdateTasks(updates)).toEqual({ success: true });
            await flushPendingSave(); expected = rows(); expectedRaw = await raw(rn);
        } finally { await rn.close(); }
        const sqlite = await openSqliteHost(initial);
        try {
            await canonical(); const host = methods(); const before = rows(); const command = await prepare(host, request(tags));
            expect(value(host.validatePreparedArchivedTasksRestore(command))).toEqual({ count, changed: true });
            expect(value(await host.commitPreparedArchivedTasksRestore(command))).toEqual({ count, changed: true });
            expect(rows()).toEqual(expected); expect(await raw(sqlite)).toEqual(expectedRaw);
            expect(rows().tasks).toHaveLength(5); expect(command.prepared.effect.projects).toEqual([]);
            expect(rows().tasks.find((row) => row.id === 'a')?.rev).toBe(before.tasks.find((row) => row.id === 'a')!.rev + (count === 1 ? 0 : 1));
            expect(await sqlite.receiptIds()).toEqual([UUID]);
            if (tags[0] === '#keep') expect(rows().tasks.filter((row) => ['a', 'b'].includes(row.id)).every((row) => row.tags?.length === 0)).toBe(true);
        } finally { await sqlite.close(); }
    });

    it.each([['#gone'], ['@#@'], ['#NEW']])('returns guarded fresh noop for noncarried/prefix-only/exact-case picks %j without writes or initialization', async (...picked) => {
        clock(); const tags = picked as string[]; const writes = vi.fn(); const sqlite = await openSqliteHost(seed(), (client) => ({ ...client,
            run: async (sql, params) => { if (/^(INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)/i.test(sql)) writes(sql); return client.run(sql, params); },
        }));
        try {
            await sqlite.client().run("UPDATE settings SET data = json_remove(data, '$.deviceId') WHERE id = 1");
            await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite); writes.mockClear(); const logs = vi.spyOn(logger, 'logInfo');
            expect(value(await methods().prepareArchivedTasksRestore(request(tags)))).toEqual({ kind: 'noop', result: { count: 0, changed: false } });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]); expect(writes).not.toHaveBeenCalled(); expect(logs).not.toHaveBeenCalled();
            expect(useTaskStore.getState().settings.deviceId).toBeUndefined();
            const displayed = request(tags); await sqlite.client().run('UPDATE tasks SET rev = rev + 1 WHERE id = ?', ['a']); const changed = await raw(sqlite); writes.mockClear();
            expect(await methods().prepareArchivedTasksRestore(displayed)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(changed); expect(await receipts(sqlite)).toEqual([]); expect(writes).not.toHaveBeenCalled();
        } finally { await sqlite.close(); }
    });
    it('refuses malformed/missing/stale/protected full accepted selections before changed or noop writes', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const host = methods(); const input = request(); const before = await raw(sqlite);
            for (const invalid of [{ ...input, tags: [] }, { ...input, tags: [''] }, { ...input, tags: [' '] },
                { ...input, tags: ['#new', '#new'] }, { ...input, tags: [42] }, { ...input, tags: '#new' },
                { ...input, tags: Array.from({ length: 10_001 }, (_, index) => String(index)) },
                { ...input, tags: ['x'.repeat(2_000_001)] }, { ...input, tags: ['界'.repeat(700_000)] },
                { ...input, tag: '#new' }, { ...input, status: 'inbox' }, { ...input, action: 'other' },
                { ...input, source: 'archived' }, { ...input, source: undefined }, { ...input, requestId: 'bad' },
                { ...input, taskIds: [] }, { ...input, taskIds: ['a', 'a'] },
                { ...input, taskIds: ['missing'], taskRevisions: { missing: 'rev' } },
                { ...input, taskRevisions: { ...input.taskRevisions, a: 'stale' } },
                { ...input, tags: ['#gone'], taskRevisions: { ...input.taskRevisions, a: 'stale' } },
                { ...input, taskRevisions: { ...input.taskRevisions, extra: 'rev' } }])
                expect(await host.prepareArchivedTasksRestore(invalid as never)).toMatchObject({ ok: false });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]);
            for (const [sql, params] of [
                ['UPDATE tasks SET status = ? WHERE id = ?', ['next', 'a']],
                ['UPDATE tasks SET status = ?, deletedAt = ? WHERE id = ?', ['done', NOW, 'a']],
                ['UPDATE tasks SET deletedAt = NULL, purgedAt = ? WHERE id = ?', [NOW, 'a']],
                ['UPDATE tasks SET purgedAt = NULL WHERE id = ?', ['a']],
                ['UPDATE projects SET status = ? WHERE id = ?', ['archived', 'p1']],
                ['UPDATE projects SET status = ?, deletedAt = ? WHERE id = ?', ['active', NOW, 'p1']],
            ] as Array<[string, (string | null)[]]>) {
                await sqlite.client().run(sql, params); await sqlite.restart(undefined, { recoveryLoad: true });
                if (sql.includes('purgedAt = NULL')) continue;
                const saved = await raw(sqlite);
                for (const tags of [['new'], ['#gone']]) expect(await methods().prepareArchivedTasksRestore(request(tags)))
                    .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
                expect(await raw(sqlite)).toEqual(saved); expect(await receipts(sqlite)).toEqual([]);
            }
        } finally { await sqlite.close(); }
    }, 20_000);

    it('rejects forged tags/count/subset/noop journals before all SQL and malformed direct raw-writer intents', async () => {
        clock(); const sql = vi.fn(); const sqlite = await openSqliteHost(seed(), (client) => ({ ...client,
            all: async (query, params) => { sql(query); return client.all(query, params); },
            get: async (query, params) => { sql(query); return client.get(query, params); },
            run: async (query, params) => { sql(query); return client.run(query, params); },
            exec: async (query) => { sql(query); return client.exec(query); },
        }));
        try {
            const host = methods(); const command = await prepare(host);
            const mutations = [
                (item: NativeArchivedTasksRestoreEnvelope) => { (item.request as { tags: string[] }).tags = ['#gone']; (item.prepared.request as { tags: string[] }).tags = ['#gone']; },
                (item: NativeArchivedTasksRestoreEnvelope) => { (item.request as { tag?: string }).tag = '#new'; (item.prepared.request as { tag?: string }).tag = '#new'; },
                (item: NativeArchivedTasksRestoreEnvelope) => { (item.request as { status?: string }).status = 'next'; (item.prepared.request as { status?: string }).status = 'next'; },
                (item: NativeArchivedTasksRestoreEnvelope) => { item.prepared.result.count = 2; },
                (item: NativeArchivedTasksRestoreEnvelope) => { (item.prepared.result as { changed: boolean }).changed = false; },
                (item: NativeArchivedTasksRestoreEnvelope) => { item.prepared.result = { count: 1, status: 'inbox' }; },
                (item: NativeArchivedTasksRestoreEnvelope) => { item.prepared.effect.tasks[0].after.tags = ['#new']; },
                (item: NativeArchivedTasksRestoreEnvelope) => { item.prepared.effect.tasks[0].after.status = 'next'; },
                (item: NativeArchivedTasksRestoreEnvelope) => { item.prepared.effect.tasks = []; },
                (item: NativeArchivedTasksRestoreEnvelope) => { item.prepared.scope.tasks = item.prepared.scope.tasks.filter((row) => row.id !== 'a'); },
                (item: NativeArchivedTasksRestoreEnvelope) => { item.prepared.scope.tasks.push(task('extra')); },
                (item: NativeArchivedTasksRestoreEnvelope) => { item.prepared.dates = []; },
                (item: NativeArchivedTasksRestoreEnvelope) => { item.prepared.futureBoundary = NOW; },
            ];
            for (const mutate of mutations) {
                const forged = clone(command); mutate(forged); sql.mockClear();
                expect(host.validatePreparedArchivedTasksRestore(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(await host.commitPreparedArchivedTasksRestore(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(host.archivedTasksRestoreOutcome(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } }); expect(sql).not.toHaveBeenCalled();
            }
            const noop = { request: command.request, prepared: { kind: 'noop', result: { count: 0, changed: false } } };
            sql.mockClear(); expect(await host.commitPreparedArchivedTasksRestore(noop as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } }); expect(sql).not.toHaveBeenCalled();
            const durable = value(await readAreaDurableData(false, true));
            for (const mutate of [
                (item: NativeArchivedTasksRestoreEnvelope) => { (item.request as { action: string }).action = 'addTag'; },
                (item: NativeArchivedTasksRestoreEnvelope) => { (item.request as { source: string }).source = 'other'; },
                (item: NativeArchivedTasksRestoreEnvelope) => { (item.request as { status?: string }).status = 'inbox'; },
                (item: NativeArchivedTasksRestoreEnvelope) => { (item.request as { tags: string[] }).tags = ['new', 'new']; },
                (item: NativeArchivedTasksRestoreEnvelope) => { item.prepared.effect.tasks[0].after.tags = ['#new']; },
                (item: NativeArchivedTasksRestoreEnvelope) => { item.prepared.effect.tasks = []; },
            ]) {
                const forged = clone(command); mutate(forged); forged.prepared.request = forged.request; const before = await raw(sqlite);
                expect(await useTaskStore.getState().commitPreparedArchivedTasksRestore(forged.prepared, durable.authority)).toMatchObject({ success: false });
                expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]);
            }
        } finally { await sqlite.close(); }
    });
    it('guards unchanged accepted row and complete raw parent/member/section/area/device authority across cold recreation', async () => {
        clock(); const initial = seed(); initial.projects![0].areaId = 'area';
        for (const [sql, params] of [
            ['UPDATE tasks SET focusOrder = 3 WHERE id = ?', ['a']],
            ['UPDATE tasks SET tags = ? WHERE id = ?', ['["#new","#later"]', 'a']],
            ['UPDATE tasks SET description = ? WHERE id = ?', ['Later sibling', 'sibling']],
            ['UPDATE projects SET title = ? WHERE id = ?', ['Later parent', 'p1']],
            ['UPDATE projects SET status = ? WHERE id = ?', ['archived', 'p1']],
            ['UPDATE sections SET description = ? WHERE id = ?', ['Later section', 's1']],
            ['UPDATE areas SET name = ? WHERE id = ?', ['Later area', 'area']],
            ['UPDATE tasks SET projectId = ? WHERE id = ?', ['p1', 'unrelated']],
            ['UPDATE tasks SET projectId = NULL WHERE id = ?', ['sibling']],
            ["UPDATE settings SET data = json_set(data, '$.deviceId', ?) WHERE id = 1", ['later-device']],
        ] as Array<[string, string[]]>) {
            const sqlite = await openSqliteHost(initial);
            try {
                const command = await prepare(); expect(command.prepared.effect.tasks.map((pair) => pair.before.id)).toEqual(['b']);
                await sqlite.client().run(sql, params); await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
                expect(await methods().commitPreparedArchivedTasksRestore(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
                expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]);
            } finally { await sqlite.close(); }
        }
    }, 20_000);

    it.each(['same-host', 'cold'] as const)('recovers two failed COMMITs through %s exact UUID with complete raw SQL/control receipt parity', async (recovery) => {
        clock(); const setup = async (fault: { commits: number }) => {
            const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, run: async (sql, params) => {
                if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('injected COMMIT failure'); }
                return client.run(sql, params);
            } }));
            await canonical();
            await sqlite.client().run('UPDATE tasks SET focusOrder = 2, pushCount = NULL WHERE id = ?', ['b']);
            await sqlite.client().run('UPDATE tasks SET pushCount = NULL WHERE id = ?', ['unrelated']);
            await sqlite.restart(undefined, { recoveryLoad: true }); return sqlite;
        };
        const control = await setup({ commits: 0 }); let expectedRaw; let expectedReceipts; let expectedCommand;
        try {
            expectedCommand = await prepare(); value(await methods().commitPreparedArchivedTasksRestore(expectedCommand));
            expectedRaw = await raw(control); expectedReceipts = await receipts(control);
        } finally { await control.close(); }
        const fault = { commits: 0 }; const sqlite = await setup(fault);
        try {
            let host = methods(); const command = clone(await prepare(host)); const before = await raw(sqlite); const logs = vi.spyOn(logger, 'logInfo');
            expect(command).toEqual(expectedCommand);
            expect(command.prepared.scope.tasks.find((row) => row.id === 'b')?.focusOrder).toBe(2);
            for (let attempt = 0; attempt < 2; attempt++) {
                fault.commits = 10; expect(await host.commitPreparedArchivedTasksRestore(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
                expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]); expect(value(host.archivedTasksRestoreOutcome(command))).toBeNull();
                expect(logs).not.toHaveBeenCalledWith('Native Done bulk tag removal confirmed', expect.anything());
            }
            fault.commits = 0; if (recovery === 'cold') { await sqlite.restart(undefined, { recoveryLoad: true }); host = methods(); }
            expect(value(await host.commitPreparedArchivedTasksRestore(command))).toEqual({ count: 1, changed: true });
            expect(logs).toHaveBeenCalledWith('Native Done bulk tag removal confirmed', { scope: 'native-host', category: 'storage', context: { releaseCheck: 'v1.3.4/ios-done-bulk-tag-remove', outcome: 'removed' } });
            expect(await raw(sqlite)).toEqual(expectedRaw); expect(await receipts(sqlite)).toEqual(expectedReceipts);
            expect((await raw(sqlite)).tasks.find((row: { id: string }) => row.id === 'unrelated')).toEqual(before.tasks.find((row: { id: string }) => row.id === 'unrelated'));
            await sqlite.restart(undefined, { recoveryLoad: true }); const after = await raw(sqlite);
            expect(value(methods().archivedTasksRestoreOutcome(command))).toEqual({ count: 1, changed: true });
            expect(value(await methods().commitPreparedArchivedTasksRestore(command))).toEqual({ count: 1, changed: true });
            expect(await raw(sqlite)).toEqual(after); expect(await receipts(sqlite)).toEqual(expectedReceipts);
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 30_000);

    it('rechecks same-revision unchanged source and parent edits before an owned failed-save retry', async () => {
        clock(); const fault = { commits: 0 }; const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('injected COMMIT failure'); } return client.run(sql, params);
        } }));
        try {
            const host = methods(); const command = await prepare(host); fault.commits = 10;
            expect(await host.commitPreparedArchivedTasksRestore(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); fault.commits = 0;
            await sqlite.client().run('UPDATE projects SET supportNotes = ? WHERE id = ?', ['Later raw parent', 'p1']);
            await sqlite.client().run('UPDATE tasks SET description = ? WHERE id = ?', ['Later unchanged selected', 'a']); const before = await raw(sqlite);
            expect(await host.commitPreparedArchivedTasksRestore(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]);
        } finally { fault.commits = 0; await sqlite.close(); }
    });

    it('uses exact cold receipts before later edits/deletion/container changes, never unused UUID equality or a different bound payload', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const command = await prepare(); const unused = clone(command); unused.request.requestId = '00000000-0000-4000-8000-000000001185'; unused.prepared.request.requestId = unused.request.requestId;
            value(await methods().commitPreparedArchivedTasksRestore(command)); await sqlite.restart(undefined, { recoveryLoad: true }); let fresh = methods(); const landed = await raw(sqlite);
            expect(value(fresh.archivedTasksRestoreOutcome(unused))).toBeNull(); expect(await fresh.commitPreparedArchivedTasksRestore(unused)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(landed);
            expect(await useTaskStore.getState().batchDeleteTasks(['b'])).toEqual({ success: true }); await flushPendingSave();
            expect(await useTaskStore.getState().restoreTask('b')).toEqual({ success: true }); await flushPendingSave();
            await sqlite.client().run('UPDATE tasks SET title = ?, tags = ?, status = ?, rev = rev + 1 WHERE id = ?', ['Later selected', '["#later"]', 'reference', 'b']);
            await sqlite.client().run('UPDATE projects SET deletedAt = ? WHERE id = ?', [NOW, 'p2']);
            await sqlite.restart(undefined, { recoveryLoad: true }); fresh = methods(); const before = await raw(sqlite); const saved = await receipts(sqlite);
            expect(value(fresh.archivedTasksRestoreOutcome(command))).toEqual({ count: 1, changed: true }); expect(value(await fresh.commitPreparedArchivedTasksRestore(command))).toEqual({ count: 1, changed: true });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual(saved);
            const rebound = clone(command); rebound.request.taskIds.reverse(); rebound.prepared.request.taskIds.reverse();
            expect(value(fresh.validatePreparedArchivedTasksRestore(rebound))).toEqual({ count: 1, changed: true });
            expect(fresh.archivedTasksRestoreOutcome(rebound)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await fresh.commitPreparedArchivedTasksRestore(rebound)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } }); expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual(saved);
            const payload = JSON.stringify(['doneTasksRemoveTag', command], (_name, item) => item && typeof item === 'object' && !Array.isArray(item)
                ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
            expect(saved).toEqual([{ _rowid: 1, request_id: UUID, method: `doneTasksRemoveTag:${deterministicHash128(payload).map((part) => part.toString(16).padStart(8, '0')).join('')}`,
                reply: JSON.stringify({ count: 1, changed: true }), saved_at: NOW }]);
        } finally { await sqlite.close(); }
    });

    it.each(['same-host', 'cold'] as const)('freezes missing device initialization through a failed save and %s retry', async (recovery) => {
        clock(); const fault = { commits: 0 }; const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('injected COMMIT failure'); } return client.run(sql, params);
        } }));
        try {
            await sqlite.client().run("UPDATE settings SET data = json_remove(data, '$.deviceId') WHERE id = 1"); await sqlite.restart(undefined, { recoveryLoad: true });
            let host = methods(); const command = clone(await prepare(host)); const before = await raw(sqlite);
            expect(command.prepared.deviceIdBefore).toBeNull(); expect(command.prepared.deviceIdToInitialize).toMatch(/^[0-9a-f-]{36}$/);
            expect(command.prepared.effect.tasks.every((pair) => pair.after.revBy === command.prepared.deviceIdToInitialize)).toBe(true);
            fault.commits = 10; expect(await host.commitPreparedArchivedTasksRestore(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]);
            fault.commits = 0; if (recovery === 'cold') { await sqlite.restart(undefined, { recoveryLoad: true }); host = methods(); }
            value(await host.commitPreparedArchivedTasksRestore(command)); await sqlite.restart(undefined, { recoveryLoad: true });
            expect(useTaskStore.getState().settings.deviceId).toBe(command.prepared.deviceIdToInitialize); expect(value(methods().archivedTasksRestoreOutcome(command))).toEqual({ count: 1, changed: true });
            expect(await sqlite.receiptIds()).toEqual([UUID]);
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 25_000);

    it('preserves current settings when actual RN tags-only replan is identical, including completion-edit-only auto-archive rules', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const command = await prepare(); await getStorageAdapter().saveData({ ...buildSaveSnapshot(useTaskStore.getState()), settings: { ...useTaskStore.getState().settings, theme: 'dark', gtd: { autoArchiveDays: 30 } } });
            await sqlite.restart(undefined, { recoveryLoad: true }); value(await methods().commitPreparedArchivedTasksRestore(command));
            expect(useTaskStore.getState().settings.theme).toBe('dark'); expect(useTaskStore.getState().settings.gtd?.autoArchiveDays).toBe(30);
        } finally { await sqlite.close(); }
        const rn = await openSqliteHost(seed()); let expected; let expectedRaw;
        try {
            await canonical(); await getStorageAdapter().saveData({ ...buildSaveSnapshot(useTaskStore.getState()), settings: { ...useTaskStore.getState().settings, gtd: { autoArchiveDays: 1 } } });
            await rn.restart(undefined, { recoveryLoad: true });
            const updates = buildBulkTaskTokenUpdates(['a', 'b'], useTaskStore.getState()._tasksById, 'tags', ['new'], 'remove');
            expect(await useTaskStore.getState().batchUpdateTasks(updates)).toEqual({ success: true }); await flushPendingSave(); expected = rows(); expectedRaw = await raw(rn);
        } finally { await rn.close(); }
        const changed = await openSqliteHost(seed());
        try {
            await canonical(); const command = await prepare(); await getStorageAdapter().saveData({ ...buildSaveSnapshot(useTaskStore.getState()), settings: { ...useTaskStore.getState().settings, gtd: { autoArchiveDays: 1 } } });
            await changed.restart(undefined, { recoveryLoad: true });
            expect(value(await methods().commitPreparedArchivedTasksRestore(command))).toEqual({ count: 1, changed: true });
            expect(rows()).toEqual(expected); expect(await raw(changed)).toEqual(expectedRaw);


            expect(rows().tasks.find((row) => row.id === 'b')?.status).toBe('done'); expect(useTaskStore.getState().settings.gtd?.autoArchiveDays).toBe(1);
        } finally { await changed.close(); }
    });

    it('keeps the explicit legacy RN whole-save raw mismatch bounded to untouched NULL defaults while selected rows and fresh loaded data match', async () => {
        clock(); const setup = async () => {
            const sqlite = await openSqliteHost(seed()); await canonical();
            await sqlite.client().run('UPDATE tasks SET focusOrder = 2, pushCount = NULL WHERE id = ?', ['b']);
            await sqlite.client().run('UPDATE tasks SET pushCount = NULL WHERE id = ?', ['unrelated']); await sqlite.restart(); return sqlite;
        };
        const rn = await setup(); let expected; let expectedRaw;
        try {
            const updates = buildBulkTaskTokenUpdates(['a', 'b'], useTaskStore.getState()._tasksById, 'tags', ['new'], 'remove');
            expect(await useTaskStore.getState().batchUpdateTasks(updates)).toEqual({ success: true }); await flushPendingSave(); expected = rows(); expectedRaw = await raw(rn);
        } finally { await rn.close(); }
        const sqlite = await setup();
        try {
            const command = await prepare(); const before = await raw(sqlite); value(await methods().commitPreparedArchivedTasksRestore(command)); const actual = await raw(sqlite);
            expect(actual).not.toEqual(expectedRaw);
            const differences = [];
            for (const table of Object.keys(actual)) {
                const left = expectedRaw![table] as Array<Record<string, unknown>>; const right = actual[table] as Array<Record<string, unknown>>; expect(left).toHaveLength(right.length);
                for (let index = 0; index < left.length; index++) for (const field of Object.keys(left[index]))
                    if (JSON.stringify(left[index][field]) !== JSON.stringify(right[index][field])) differences.push({ table, row: left[index].id, field, rn: left[index][field], native: right[index][field] });
            }
            expect(differences).toEqual([{ table: 'tasks', row: 'unrelated', field: 'pushCount', rn: 0, native: null }]);
            expect(actual.tasks.find((row: { id: string }) => row.id === 'unrelated')).toEqual(before.tasks.find((row: { id: string }) => row.id === 'unrelated'));
            await sqlite.restart(); expect(rows()).toEqual(expected);
        } finally { await sqlite.close(); }
    });

    it('does not land prewrite read/unrelated failures and logs only the confirmed privacy-safe durable outcome', async () => {
        clock(); const fault = { read: false }; const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, all: async (sql, params) => {
            if (fault.read && sql.includes('FROM tasks')) throw new Error('injected read failure'); return client.all(sql, params);
        } }));
        try {
            const host = methods(); const command = await prepare(host); const before = await raw(sqlite); const logs = vi.spyOn(logger, 'logInfo'); fault.read = true;
            expect(await host.commitPreparedArchivedTasksRestore(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); fault.read = false;
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]); expect(value(host.archivedTasksRestoreOutcome(command))).toBeNull(); expect(logs).not.toHaveBeenCalled();
            useTaskStore.setState({ persistenceFailure: { message: 'Unrelated failure', failedAt: NOW, retrying: false } });
            expect(await host.commitPreparedArchivedTasksRestore(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); useTaskStore.setState({ persistenceFailure: null });
            expect(await receipts(sqlite)).toEqual([]); expect(logs).not.toHaveBeenCalled(); value(await host.commitPreparedArchivedTasksRestore(command));
            expect(await sqlite.receiptIds()).toEqual([UUID]); expect(logs).toHaveBeenCalledExactlyOnceWith('Native Done bulk tag removal confirmed', { scope: 'native-host', category: 'storage', context: { releaseCheck: 'v1.3.4/ios-done-bulk-tag-remove', outcome: 'removed' } });
            expect(JSON.stringify(logs.mock.calls)).not.toContain('#new');
        } finally { fault.read = false; await sqlite.close(); }
    });

    it('accepts 10000 picked values and more than128 selected revisions, but rejects oversized prepared scope before writes', async () => {
        clock(); const initial = seed(); initial.tasks = Array.from({ length: 140 }, (_, index) => task(`selected-${index}`, { tags: ['#new', '#keep'] })); initial.projects = []; initial.sections = [];
        const sqlite = await openSqliteHost(initial);
        try {
            const host = methods(); const largePicks = Array.from({ length: 10_000 }, (_, index) => `#not-carried-${index}`); const before = await raw(sqlite);
            expect(value(await host.prepareArchivedTasksRestore(request(largePicks, initial.tasks.map((row) => row.id))))).toEqual({ kind: 'noop', result: { count: 0, changed: false } });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual([]);
            const command = await prepare(host, request(['#new'], initial.tasks.map((row) => row.id)));
            expect(value(await host.commitPreparedArchivedTasksRestore(command))).toEqual({ count: 140, changed: true }); expect(await sqlite.receiptIds()).toEqual([UUID]);
        } finally { await sqlite.close(); }
        const huge = await openSqliteHost({ ...seed(), tasks: [task('a', { description: '界'.repeat(700_000), tags: ['#new'] }), task('b', { tags: ['#new'] })], projects: [], sections: [] });
        try {
            const before = await raw(huge); expect(await methods().prepareArchivedTasksRestore(request())).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('select fewer') } });
            expect(await raw(huge)).toEqual(before); expect(await receipts(huge)).toEqual([]);
        } finally { await huge.close(); }
    }, 20_000);
});
