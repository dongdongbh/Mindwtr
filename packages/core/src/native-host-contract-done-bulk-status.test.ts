import { afterEach, describe, expect, it, vi } from 'vitest';
import { createArchivedTasksRestoreMethods, type NativeArchivedTasksRestoreEnvelope } from './native-host-contract-archive-bulk-restore';
import { openSqliteHost } from './screen-parity.replay';
import { taskRevisionOf } from './native-request-receipts';
import { flushPendingSave, getStorageAdapter, resetForTests, useTaskStore } from './store';
import { buildSaveSnapshot } from './store-helpers';
import { getBulkMoveStatusOptions } from './task-list-bulk-actions';
import type { AppData, Task, TaskStatus } from './types';

const NOW = '2026-10-03T13:00:00.000Z';
const BEFORE = '2026-10-02T12:34:56.789Z';
const UUID = '00000000-0000-4000-8000-000000000183';
const DEVICE = 'move-device';
const clone = <T>(input: T): T => JSON.parse(JSON.stringify(input)) as T;
const value = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`); return result.value;
};
const task = (id: string, fields: Partial<Task> = {}): Task => ({ id, title: `Task ${id}`, status: 'done',
    createdAt: BEFORE, updatedAt: BEFORE, completedAt: BEFORE, tags: [], contexts: [], rev: 3, revBy: DEVICE, ...fields });
const seed = (): Partial<AppData> => ({ tasks: [task('b', { projectId: 'p2', sectionId: 's2',
    recurrence: { rule: 'daily', strategy: 'strict', seriesId: 'series' },
    attachments: [{ id: 'link', kind: 'link', title: 'Fixture', uri: 'https://example.com', createdAt: BEFORE, updatedAt: BEFORE }],
    checklist: [{ id: 'step', title: 'Step', isCompleted: true }], timeSpentMinutes: 45,
    dueDate: '2026-10-05', startTime: '2026-10-04', reviewAt: '2026-10-06' }),
task('a', { projectId: 'p1', sectionId: 's1' }), task('sibling', { status: 'next', completedAt: undefined, projectId: 'p1', order: 8, orderNum: 8 }),
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
const rows = () => clone(buildSaveSnapshot(useTaskStore.getState()));
const canonical = async () => getStorageAdapter().saveData(buildSaveSnapshot(useTaskStore.getState()));
const methods = () => createArchivedTasksRestoreMethods({ readiness: () => ({ ok: true, value: null }), save: async () => {
    try { await flushPendingSave(); } catch { return { ok: false, error: { code: 'SAVE_FAILED', message: 'Injected failure' } }; }
    return useTaskStore.getState().persistenceFailure
        ? { ok: false, error: { code: 'SAVE_FAILED', message: 'Unresolved failure' } } : { ok: true, value: null };
} });
const request = (status: Exclude<TaskStatus, 'done'> = 'inbox', taskIds = ['a', 'b'], requestId = UUID) => ({ requestId,
    taskIds, taskRevisions: Object.fromEntries(taskIds.map((id) => [id, taskRevisionOf(useTaskStore.getState()._tasksById.get(id)!)])), source: 'done' as const, status });
const prepare = async (host = methods(), input = request()) => ({ request: input, prepared: value(await host.prepareArchivedTasksRestore(input)).prepared });
const clock = () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); };
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); });

describe('guarded Done bulk Move status', () => {
    it.each(getBulkMoveStatusOptions('done') as Exclude<TaskStatus, 'done'>[])('matches actual RN batchMoveTasks full AppData/all nine canonical tables for %s', async (status) => {
        clock(); const selected = ['a', 'b']; const rn = await openSqliteHost(seed()); let expected; let expectedRaw;
        try {
            await canonical(); expect(await useTaskStore.getState().batchMoveTasks(selected, status)).toEqual({ success: true });
            await flushPendingSave(); expected = rows(); expectedRaw = await raw(rn);
        } finally { await rn.close(); }
        const sqlite = await openSqliteHost(seed());
        try {
            await canonical(); const host = methods(); const command = await prepare(host, request(status));
            expect(value(host.validatePreparedArchivedTasksRestore(command))).toEqual({ count: 2, status });
            expect(value(await host.commitPreparedArchivedTasksRestore(command))).toEqual({ count: 2, status });
            expect(rows()).toEqual(expected); expect(await raw(sqlite)).toEqual(expectedRaw);
            expect(rows().tasks).toHaveLength(5); expect(command.prepared.effect.projects).toEqual([]);
            expect(await sqlite.receiptIds()).toEqual([UUID]);
        } finally { await sqlite.close(); }
    });

    it('refuses invalid tagged requests and protected rows atomically without selecting incoming rows', async () => {
        clock(); const initial = seed(); initial.tasks!.push(task('archived', { status: 'archived', archivedAt: BEFORE }),
            task('deleted', { deletedAt: BEFORE }), task('purged', { deletedAt: BEFORE, purgedAt: BEFORE }));
        const sqlite = await openSqliteHost(initial);
        try {
            const host = methods(); const valid = request(); const before = await raw(sqlite);
            for (const input of [{ ...valid, source: undefined }, { ...valid, status: undefined }, { ...valid, source: 'archive' },
                { ...valid, status: 'done' }, { ...valid, status: 'unknown' }, { ...valid, status: null },
                { ...valid, taskIds: [] }, { ...valid, taskIds: ['a', 'a'] }, { ...valid, taskRevisions: { a: 'stale', b: valid.taskRevisions.b } },
                { ...valid, taskRevisions: { ...valid.taskRevisions, extra: 'revision' } }, { ...valid, requestId: 'bad' },
                request('next', ['archived']), request('next', ['deleted']), request('next', ['purged']),
                { ...valid, taskIds: ['missing'], taskRevisions: { missing: 'revision' } },
                { ...valid, taskIds: ['recurring_projection'], taskRevisions: { recurring_projection: 'revision' } }])
                expect(await host.prepareArchivedTasksRestore(input as never)).toMatchObject({ ok: false });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            for (const lifecycle of ['archived', 'deleted'] as const) {
                await sqlite.client().run(lifecycle === 'archived' ? 'UPDATE projects SET status = ? WHERE id = ?'
                    : 'UPDATE projects SET status = ?, deletedAt = ? WHERE id = ?', lifecycle === 'archived' ? ['archived', 'p1'] : ['active', NOW, 'p1']);
                await sqlite.restart(undefined, { recoveryLoad: true }); const protectedState = await raw(sqlite);
                expect(await methods().prepareArchivedTasksRestore(request('next'))).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
                expect(await raw(sqlite)).toEqual(protectedState); expect(await sqlite.receiptIds()).toEqual([]);
            }
        } finally { await sqlite.close(); }
    });

    it('rejects malformed source/target/result/effect/scope journals before any SQLite operation', async () => {
        clock(); const sql = vi.fn(); const sqlite = await openSqliteHost(seed(), (client) => ({ ...client,
            all: async (query, params) => { sql(query); return client.all(query, params); },
            run: async (query, params) => { sql(query); return client.run(query, params); },
            exec: async (query) => { sql(query); return client.exec(query); },
            get: async (query, params) => { sql(query); return client.get(query, params); },
        }));
        try {
            const host = methods(); const command = await prepare(host, request('waiting'));
            for (const mutate of [
                (item: NativeArchivedTasksRestoreEnvelope) => { delete item.request.source; delete item.request.status; delete item.prepared.request.source; delete item.prepared.request.status; },
                (item: NativeArchivedTasksRestoreEnvelope) => { (item.request as { status: string }).status = 'done'; (item.prepared.request as { status: string }).status = 'done'; },
                (item: NativeArchivedTasksRestoreEnvelope) => { (item.request as { status: string }).status = 'reference'; (item.prepared.request as { status: string }).status = 'reference'; },
                (item: NativeArchivedTasksRestoreEnvelope) => { item.prepared.result.status = 'inbox'; },
                (item: NativeArchivedTasksRestoreEnvelope) => { item.prepared.result.count = 99; },
                (item: NativeArchivedTasksRestoreEnvelope) => { item.prepared.effect.tasks[0].after.description = 'Forged'; },
                (item: NativeArchivedTasksRestoreEnvelope) => { item.prepared.scope.tasks.push(task('extra')); },
                (item: NativeArchivedTasksRestoreEnvelope) => { item.prepared.scope.projects[0].status = 'archived'; },
                (item: NativeArchivedTasksRestoreEnvelope) => { item.prepared.futureBoundary = NOW; },
            ]) {
                const forged = clone(command); mutate(forged); sql.mockClear();
                expect(host.validatePreparedArchivedTasksRestore(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(await host.commitPreparedArchivedTasksRestore(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(sql).not.toHaveBeenCalled();
            }

            const durable = value(await import('./native-host-contract-area-durable').then((module) => module.readAreaDurableData(false, true)));
            for (const rawRequest of [{ ...command.request, source: 'other' }, { ...command.request, status: 'done' }, { ...command.request, source: undefined }]) {
                const input = { ...command.prepared, request: rawRequest }; const before = await raw(sqlite);
                expect(await useTaskStore.getState().commitPreparedArchivedTasksRestore(input as never, durable.authority)).toMatchObject({ success: false });
                expect(await raw(sqlite)).toEqual(before);
            }
        } finally { await sqlite.close(); }
    });

    it('guards complete raw selected/parent/sibling/section/area membership even when revisions stay unchanged', async () => {
        clock(); const initial = seed(); initial.projects![0].areaId = 'area';
        const edits: Array<(sqlite: Sqlite) => Promise<unknown>> = [
            (sqlite) => sqlite.client().run('UPDATE tasks SET focusOrder = 3 WHERE id = ?', ['a']),
            (sqlite) => sqlite.client().run('UPDATE tasks SET description = ? WHERE id = ?', ['Later sibling', 'sibling']),
            (sqlite) => sqlite.client().run('UPDATE projects SET title = ? WHERE id = ?', ['Later parent', 'p1']),
            (sqlite) => sqlite.client().run('UPDATE projects SET status = ? WHERE id = ?', ['archived', 'p1']),
            (sqlite) => sqlite.client().run('UPDATE sections SET description = ? WHERE id = ?', ['Later section', 's1']),
            (sqlite) => sqlite.client().run('UPDATE areas SET name = ? WHERE id = ?', ['Later area', 'area']),
            (sqlite) => sqlite.client().run('UPDATE tasks SET projectId = ? WHERE id = ?', ['p1', 'unrelated']),
            (sqlite) => sqlite.client().run('UPDATE tasks SET projectId = NULL WHERE id = ?', ['sibling']),
        ];
        for (const edit of edits) {
            const sqlite = await openSqliteHost(initial);
            try {
                const command = await prepare(methods(), request('next')); await edit(sqlite); await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
                expect(await methods().commitPreparedArchivedTasksRestore(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
                expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            } finally { await sqlite.close(); }
        }
    }, 15_000);

    it.each(['same-host', 'cold'] as const)('recovers two failed COMMITs through %s exact UUID while preserving raw unrelated NULL cells', async (recovery) => {
        clock(); const fault = { commits: 0 }; const sqlite = await openSqliteHost(seed(), (client) => ({ ...client,
            run: async (sql, params) => { if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('injected COMMIT failure'); } return client.run(sql, params); },
        }));
        try {
            await sqlite.client().run('UPDATE tasks SET focusOrder = 2, pushCount = NULL WHERE id = ?', ['a']);
            await sqlite.client().run('UPDATE tasks SET pushCount = NULL WHERE id = ?', ['unrelated']);
            await sqlite.restart(undefined, { recoveryLoad: true }); let host = methods(); const command = clone(await prepare(host, request('next'))); const before = await raw(sqlite);
            expect(command.prepared.scope.tasks.find((row) => row.id === 'a')?.focusOrder).toBe(2);
            for (let attempt = 0; attempt < 2; attempt++) {
                fault.commits = 10; expect(await host.commitPreparedArchivedTasksRestore(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
                expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]); expect(value(host.archivedTasksRestoreOutcome(command))).toBeNull();
            }
            fault.commits = 0;
            if (recovery === 'cold') { await sqlite.restart(undefined, { recoveryLoad: true }); host = methods(); }
            expect(value(await host.commitPreparedArchivedTasksRestore(command))).toEqual({ count: 2, status: 'next' });
            const after = await raw(sqlite); expect((after.tasks as Array<{ id: string }>).find((row) => row.id === 'unrelated'))
                .toEqual((before.tasks as Array<{ id: string }>).find((row) => row.id === 'unrelated'));
            expect(await sqlite.receiptIds()).toEqual([UUID]); await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(methods().archivedTasksRestoreOutcome(command))).toEqual({ count: 2, status: 'next' });
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 25_000);

    it('rechecks raw parent authority on owned save retry and refuses a concurrent same-revision edit', async () => {
        clock(); const fault = { commits: 0 }; const sqlite = await openSqliteHost(seed(), (client) => ({ ...client,
            run: async (sql, params) => { if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('injected COMMIT failure'); } return client.run(sql, params); },
        }));
        try {
            const host = methods(); const command = await prepare(host, request('next')); fault.commits = 10;
            expect(await host.commitPreparedArchivedTasksRestore(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); fault.commits = 0;
            await sqlite.client().run('UPDATE projects SET supportNotes = ? WHERE id = ?', ['Later raw parent', 'p1']); const before = await raw(sqlite);
            expect(await host.commitPreparedArchivedTasksRestore(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { fault.commits = 0; await sqlite.close(); }
    });

    it('prioritizes exact cold terminal acknowledgment after later rename/status/delete/restore and rejects unused UUID equal AFTER', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const host = methods(); const command = await prepare(host, request('waiting')); const unused = clone(command);
            unused.request.requestId = '00000000-0000-4000-8000-000000000184'; unused.prepared.request.requestId = unused.request.requestId;
            value(await host.commitPreparedArchivedTasksRestore(command)); await sqlite.restart(undefined, { recoveryLoad: true }); let fresh = methods(); const landed = await raw(sqlite);
            expect(value(fresh.archivedTasksRestoreOutcome(unused))).toBeNull();
            expect(await fresh.commitPreparedArchivedTasksRestore(unused)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } }); expect(await raw(sqlite)).toEqual(landed);
            expect(await useTaskStore.getState().batchDeleteTasks(['a'])).toEqual({ success: true }); await flushPendingSave();
            expect(await useTaskStore.getState().restoreTask('a')).toEqual({ success: true }); await flushPendingSave();
            await sqlite.client().run('UPDATE tasks SET title = ?, status = ?, rev = rev + 1 WHERE id = ?', ['Later selected', 'reference', 'a']);
            await sqlite.client().run('UPDATE projects SET deletedAt = ? WHERE id = ?', [NOW, 'p1']);
            await sqlite.restart(undefined, { recoveryLoad: true }); fresh = methods(); const before = await raw(sqlite);
            const receipt = await sqlite.sql('SELECT rowid AS _rowid, * FROM native_request_receipts ORDER BY rowid');
            expect(value(fresh.archivedTasksRestoreOutcome(command))).toEqual({ count: 2, status: 'waiting' });
            expect(value(await fresh.commitPreparedArchivedTasksRestore(command))).toEqual({ count: 2, status: 'waiting' });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.sql('SELECT rowid AS _rowid, * FROM native_request_receipts ORDER BY rowid')).toEqual(receipt);
            const otherPayload = clone(command); otherPayload.request.taskIds.reverse(); otherPayload.prepared.request.taskIds.reverse();
            expect(value(fresh.validatePreparedArchivedTasksRestore(otherPayload))).toEqual({ count: 2, status: 'waiting' });
            expect(await fresh.commitPreparedArchivedTasksRestore(otherPayload)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } }); expect(await raw(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    });

    it.each(['same-host', 'cold'] as const)('freezes missing device initialization through failed save and %s retry', async (recovery) => {
        clock(); const fault = { commits: 0 }; const sqlite = await openSqliteHost(seed(), (client) => ({ ...client,
            run: async (sql, params) => { if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('injected COMMIT failure'); } return client.run(sql, params); },
        }));
        try {
            await sqlite.client().run("UPDATE settings SET data = json_remove(data, '$.deviceId') WHERE id = 1");
            await sqlite.restart(undefined, { recoveryLoad: true }); let host = methods(); const command = clone(await prepare(host, request('reference'))); const before = await raw(sqlite);
            expect(command.prepared.deviceIdBefore).toBeNull(); expect(command.prepared.deviceIdToInitialize).toMatch(/^[0-9a-f-]{36}$/);
            expect(command.prepared.effect.tasks.every((pair) => pair.after.revBy === command.prepared.deviceIdToInitialize)).toBe(true);
            fault.commits = 10; expect(await host.commitPreparedArchivedTasksRestore(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]); fault.commits = 0;
            if (recovery === 'cold') { await sqlite.restart(undefined, { recoveryLoad: true }); host = methods(); }
            value(await host.commitPreparedArchivedTasksRestore(command)); await sqlite.restart(undefined, { recoveryLoad: true });
            expect(useTaskStore.getState().settings.deviceId).toBe(command.prepared.deviceIdToInitialize);
            expect(value(methods().archivedTasksRestoreOutcome(command))).toEqual({ count: 2, status: 'reference' }); expect(await sqlite.receiptIds()).toEqual([UUID]);
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 25_000);

    it('preserves harmless current settings only when shared replan/device yields the identical full effect', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const command = await prepare(methods(), request('next'));
            await getStorageAdapter().saveData({ ...buildSaveSnapshot(useTaskStore.getState()), settings: { ...useTaskStore.getState().settings, theme: 'dark', gtd: { autoArchiveDays: 30 } } });
            await sqlite.restart(undefined, { recoveryLoad: true }); value(await methods().commitPreparedArchivedTasksRestore(command));
            expect(useTaskStore.getState().settings.theme).toBe('dark'); expect(useTaskStore.getState().settings.gtd?.autoArchiveDays).toBe(30);
        } finally { await sqlite.close(); }
        const changed = await openSqliteHost(seed());
        try {
            const command = await prepare(methods(), request('next'));
            await getStorageAdapter().saveData({ ...buildSaveSnapshot(useTaskStore.getState()), settings: { ...useTaskStore.getState().settings, deviceId: 'later-device' } });
            await changed.restart(undefined, { recoveryLoad: true }); const before = await raw(changed);
            expect(await methods().commitPreparedArchivedTasksRestore(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(changed)).toEqual(before); expect(await changed.receiptIds()).toEqual([]);
        } finally { await changed.close(); }
    });

    it('retains explicit legacy strict raw mismatch from RN whole-save, with exact selected rows and full loaded equality', async () => {
        clock(); const setup = async () => {
            const sqlite = await openSqliteHost(seed()); await canonical();
            await sqlite.client().run('UPDATE tasks SET focusOrder = 2, pushCount = NULL WHERE id = ?', ['a']);
            await sqlite.client().run('UPDATE tasks SET pushCount = NULL WHERE id = ?', ['unrelated']); await sqlite.restart(); return sqlite;
        };
        const rn = await setup(); let expected; let expectedRaw;
        try {
            expect(await useTaskStore.getState().batchMoveTasks(['a', 'b'], 'next')).toEqual({ success: true }); await flushPendingSave(); expected = rows(); expectedRaw = await raw(rn);
        } finally { await rn.close(); }
        const sqlite = await setup();
        try {
            const host = methods(); const command = await prepare(host, request('next')); const before = await raw(sqlite); value(await host.commitPreparedArchivedTasksRestore(command)); const actual = await raw(sqlite);
            expect(actual).not.toEqual(expectedRaw);
            const differences = [];
            for (const table of Object.keys(actual)) {
                const left = expectedRaw![table] as Array<Record<string, unknown>>; const right = actual[table] as Array<Record<string, unknown>>;
                expect(left).toHaveLength(right.length);
                for (let index = 0; index < left.length; index++) for (const field of Object.keys(left[index]))
                    if (JSON.stringify(left[index][field]) !== JSON.stringify(right[index][field])) differences.push({ table, row: left[index].id, field, rn: left[index][field], native: right[index][field] });
            }
            expect(differences).toEqual([{ table: 'tasks', row: 'unrelated', field: 'pushCount', rn: 0, native: null }]);
            expect((actual.tasks as Array<{ id: string }>).find((row) => row.id === 'unrelated')).toEqual((before.tasks as Array<{ id: string }>).find((row) => row.id === 'unrelated'));
            await sqlite.restart(); expect(rows()).toEqual(expected);
        } finally { await sqlite.close(); }
    });

    it('fails prewrite reads without landed receipts and accepts 140 revisions but rejects oversized UTF8 journal scope', async () => {
        clock(); const fault = { read: false }; const sqlite = await openSqliteHost(seed(), (client) => ({ ...client,
            all: async (sql, params) => { if (fault.read && sql.includes('FROM tasks')) throw new Error('injected read failure'); return client.all(sql, params); },
        }));
        try {
            const host = methods(); const command = await prepare(host); const before = await raw(sqlite); fault.read = true;
            expect(await host.commitPreparedArchivedTasksRestore(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); fault.read = false;
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]); value(await host.commitPreparedArchivedTasksRestore(command));
        } finally { fault.read = false; await sqlite.close(); }
        const initial = seed(); initial.tasks = Array.from({ length: 140 }, (_, index) => task(`selected-${index}`)); initial.projects = []; initial.sections = [];
        const many = await openSqliteHost(initial);
        try {
            const host = methods(); const command = await prepare(host, request('archived', initial.tasks.map((row) => row.id)));
            expect(value(await host.commitPreparedArchivedTasksRestore(command))).toEqual({ count: 140, status: 'archived' });
        } finally { await many.close(); }
        const huge = await openSqliteHost({ ...seed(), tasks: [task('a', { description: '界'.repeat(700_000) }), task('b')], projects: [], sections: [] });
        try {
            const before = await raw(huge); expect(await methods().prepareArchivedTasksRestore(request()))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('select fewer') } });
            expect(await raw(huge)).toEqual(before); expect(await huge.receiptIds()).toEqual([]);
        } finally { await huge.close(); }
    }, 15_000);
});
