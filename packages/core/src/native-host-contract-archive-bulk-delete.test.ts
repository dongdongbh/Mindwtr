import { afterEach, describe, expect, it, vi } from 'vitest';
import { createArchivedTasksDeleteMethods, type NativeArchivedTasksDeleteEnvelope, type NativeArchivedTasksDeleteUndoEnvelope } from './native-host-contract-archive-bulk-delete';
import { buildSaveSnapshot } from './store-helpers';
import { taskRevisionOf } from './native-request-receipts';
import { openSqliteHost } from './screen-parity.replay';
import { taskEditValuesEqual } from './json-value-equality';
import { historyRowLoadProjection } from './native-host-contract-task-checklist';
import { planTaskMutations } from './store-tasks';
import { flushPendingSave, getStorageAdapter, resetForTests, useTaskStore } from './store';
import { TASK_SQLITE_COLUMNS, taskToSqliteRow } from './sqlite-adapter';
import type { Task } from './types';

const NOW = '2026-10-02T13:00:00.000Z';
const BEFORE = '2026-09-25T12:34:56.789Z';
const DEVICE = 'delete-device';
const source = (id = 'source', fields: Partial<Task> = {}): Task => ({ id, title: 'Retained fixture', status: 'archived',
    createdAt: BEFORE, updatedAt: BEFORE, completedAt: BEFORE, archivedAt: BEFORE, tags: [], contexts: [],
    rev: 3, revBy: DEVICE, ...fields });
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); });

describe('Task181 actual RN raw-source diagnosis', () => {
    it('proves raw-only Delete planning diverges and the existing actual codec/load projection restores exact selected SQL parity', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost({ tasks: [source()], projects: [], sections: [], areas: [], people: [],
            settings: { deviceId: DEVICE, analyticsProfileId: '00000000-0000-4000-8000-000000000181' } });
        try {
            const attachment = { id: 'legacy-link', kind: 'link', title: 'Fixture', uri: 'https://example.com', createdAt: BEFORE };
            await sqlite.client().run('UPDATE tasks SET focusOrder = 2, pushCount = NULL, attachments = ? WHERE id = ?', [JSON.stringify([attachment]), 'source']);
            await sqlite.restart();
            const raw = (await getStorageAdapter().getData({ rawTasks: true })).tasks[0];
            expect(raw.focusOrder).toBe(2); expect(raw.pushCount).toBeUndefined(); expect(raw.attachments?.[0].updatedAt).toBe('');
            expect(useTaskStore.getState()._tasksById.get('source')?.focusOrder).toBeUndefined();
            const buildUpdates = () => ({ deletedAt: NOW });
            const rawAfter = planTaskMutations({ tasks: [raw], state: {}, buildUpdates, now: NOW, deviceId: DEVICE })[0];
            const projectedAfter = planTaskMutations({ tasks: [historyRowLoadProjection(raw, NOW)], state: {}, buildUpdates, now: NOW, deviceId: DEVICE })[0];
            expect(await useTaskStore.getState().batchDeleteTasks(['source'])).toEqual({ success: true }); await flushPendingSave();
            const actual = (await sqlite.sql<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', ['source']))[0];
            const sqlRow = (row: Task) => Object.fromEntries(taskToSqliteRow(row).map((part, index) => [TASK_SQLITE_COLUMNS[index], part]));
            const rawExpected = sqlRow(rawAfter);
            const differences = TASK_SQLITE_COLUMNS.filter((column) => JSON.stringify(rawExpected[column]) !== JSON.stringify(actual[column]))
                .map((field) => ({ field, rawFormula: rawExpected[field], rn: actual[field] }));
            expect(differences).toEqual([{ field: 'pushCount', rawFormula: null, rn: 0 }, { field: 'focusOrder', rawFormula: 2, rn: null }]);
            expect(sqlRow(projectedAfter)).toEqual(actual);
            const durableAfter = (await getStorageAdapter().getData({ rawTasks: true })).tasks[0];
            expect(taskEditValuesEqual(projectedAfter, durableAfter)).toBe(true);
        } finally { await sqlite.close(); }
    });
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const value = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const DELETE_ID = '00000000-0000-4000-8000-000000000181';
const UNDO_ID = '00000000-0000-4000-8000-000000000182';
const methods = () => createArchivedTasksDeleteMethods({ readiness: () => ({ ok: true, value: null }),
    t: () => (key: string) => key, save: async () => {
        try { await flushPendingSave(); } catch { return { ok: false, error: { code: 'SAVE_FAILED', message: 'Injected failure' } }; }
        return useTaskStore.getState().persistenceFailure
            ? { ok: false, error: { code: 'SAVE_FAILED', message: 'Unresolved failure' } } : { ok: true, value: null };
    } });
const request = (taskIds = ['source'], requestId = DELETE_ID) => ({ requestId, taskIds,
    taskRevisions: Object.fromEntries(taskIds.map((id) => [id, taskRevisionOf(useTaskStore.getState()._tasksById.get(id)!)])) });
const rows = () => clone(buildSaveSnapshot(useTaskStore.getState()));
const canonical = async () => getStorageAdapter().saveData(buildSaveSnapshot(useTaskStore.getState()));
const seed = () => ({ tasks: [source('cancelled', { cancelledAt: BEFORE, completedAt: undefined,
    recurrence: { rule: 'daily', strategy: 'strict', seriesId: 'series' }, checklist: [{ id: 'step', title: 'Step', isCompleted: true }],
    attachments: [{ id: 'link', kind: 'link', title: 'Fixture', uri: 'https://example.com', createdAt: BEFORE, updatedAt: BEFORE }],
    timeSpentMinutes: 45, projectId: 'parent' }), source(), source('sibling')],
    projects: [{ id: 'parent', title: 'Parent', status: 'archived' as const, color: '#94a3b8', order: 0,
        tagIds: [], createdAt: BEFORE, updatedAt: BEFORE, archivedAt: BEFORE, completedAt: BEFORE, rev: 2, revBy: DEVICE }],
    sections: [], areas: [], people: [], settings: { deviceId: DEVICE, analyticsProfileId: DELETE_ID } });
const raw = async (sqlite: Awaited<ReturnType<typeof openSqliteHost>>) => Object.fromEntries(await Promise.all([
    'tasks', 'projects', 'sections', 'areas', 'people', 'settings', 'saved_filters', 'schema_migrations', 'calendar_sync',
].map(async (table) => [table, await sqlite.sql(`SELECT rowid AS _rowid, * FROM ${table} ORDER BY rowid`)])));

describe('guarded Archive bulk Delete and Undo', () => {
    it('matches actual RN Delete and Promise.all restoreTask Undo full AppData and all nine canonical SQLite tables', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const selected = ['source', 'cancelled'];
        const rn = await openSqliteHost(seed());
        let deleted; let deletedRaw; let restored; let restoredRaw;
        try {
            await canonical(); expect(await useTaskStore.getState().batchDeleteTasks(selected)).toEqual({ success: true });
            await flushPendingSave(); deleted = rows(); deletedRaw = await raw(rn);
            vi.setSystemTime(new Date('2026-10-02T13:01:00.000Z'));
            expect(await Promise.all(selected.map((id) => useTaskStore.getState().restoreTask(id))))
                .toEqual([{ success: true }, { success: true }]);
            await flushPendingSave(); restored = rows(); restoredRaw = await raw(rn);
        } finally { await rn.close(); }
        vi.setSystemTime(new Date(NOW));
        const native = await openSqliteHost(seed());
        try {
            await canonical(); const host = methods(); const input = request(selected);
            const prepared = value(await host.prepareArchivedTasksDelete(input)).prepared;
            const command = { request: input, prepared };
            expect(value(await host.commitPreparedArchivedTasksDelete(command)).count).toBe(2);
            expect(rows()).toEqual(deleted); expect(await raw(native)).toEqual(deletedRaw);
            vi.setSystemTime(new Date('2026-10-02T13:01:00.000Z'));
            const undoRequest = { requestId: UNDO_ID, deleteRequestId: DELETE_ID };
            const undo = { request: undoRequest, prepared: value(await host.prepareArchivedTasksDeleteUndo({ request: undoRequest, delete: command })).prepared };
            expect(value(await host.commitPreparedArchivedTasksDeleteUndo(undo))).toEqual({ count: 2 });
            expect(rows()).toEqual(restored); expect(await raw(native)).toEqual(restoredRaw);
            expect(await native.receiptIds()).toEqual([DELETE_ID, UNDO_ID]);
        } finally { await native.close(); }
    });
    it('refuses unused Delete UUID equal AFTER as Undo proof', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const host = methods(); const input = request();
            const command = { request: input, prepared: value(await host.prepareArchivedTasksDelete(input)).prepared };
            expect(await useTaskStore.getState().batchDeleteTasks(['source'])).toEqual({ success: true }); await flushPendingSave();
            const before = await raw(sqlite);
            expect(await host.prepareArchivedTasksDeleteUndo({ request: { requestId: UNDO_ID, deleteRequestId: DELETE_ID }, delete: command }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });
});

const prepare = async (host = methods(), input = request()) => ({ request: input, prepared: value(await host.prepareArchivedTasksDelete(input)).prepared });
const prepareUndo = async (host: ReturnType<typeof methods>, deletion: NativeArchivedTasksDeleteEnvelope, requestId = UNDO_ID) => {
    const request = { requestId, deleteRequestId: deletion.request.requestId };
    return { request, prepared: value(await host.prepareArchivedTasksDeleteUndo({ request, delete: deletion })).prepared };
};

describe('Archive bulk Trash boundaries and durable recovery', () => {
    it('rejects malformed, duplicate, missing, stale, non-Archive, deleted and projected selections atomically', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost({ ...seed(), tasks: [...seed().tasks, source('live', { status: 'next' }), source('deleted', { deletedAt: BEFORE })] });
        try {
            const host = methods(); const input = request(); const before = await raw(sqlite);
            for (const invalid of [{ ...input, taskIds: [] }, { ...input, taskIds: ['source', 'source'] },
                { ...input, taskIds: ['missing'], taskRevisions: { missing: 'revision' } }, { ...input, taskRevisions: { source: 'stale' } },
                { ...input, taskRevisions: { ...input.taskRevisions, extra: 'revision' } }, { ...input, requestId: 'bad' },
                request(['live']), request(['deleted']), { ...input, taskIds: ['recurring_projection'], taskRevisions: { recurring_projection: 'revision' } }])
                expect(await host.prepareArchivedTasksDelete(invalid)).toMatchObject({ ok: false });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('rejects forged Delete and Undo journals before any SQLite read or write', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sql = vi.fn();
        const sqlite = await openSqliteHost(seed(), (client) => ({ ...client,
            all: async (query, params) => { sql(query); return client.all(query, params); },
            run: async (query, params) => { sql(query); return client.run(query, params); },
            exec: async (query) => { sql(query); return client.exec(query); },
            get: async (query, params) => { sql(query); return client.get(query, params); },
        }));
        try {
            const host = methods(); const deletion = await prepare(host);
            for (const change of [(item: NativeArchivedTasksDeleteEnvelope) => { item.prepared.after[0].description = 'Forged'; },
                (item: NativeArchivedTasksDeleteEnvelope) => { item.prepared.before = []; },
                (item: NativeArchivedTasksDeleteEnvelope) => { item.prepared.after[0].status = 'inbox'; },
                (item: NativeArchivedTasksDeleteEnvelope) => { item.prepared.result.count = 99; },
                (item: NativeArchivedTasksDeleteEnvelope) => { item.prepared.after.push(source('extra')); },
                (item: NativeArchivedTasksDeleteEnvelope) => { item.prepared.deviceIdToInitialize = DEVICE; }]) {
                const forged = clone(deletion); change(forged); sql.mockClear();
                expect(host.validatePreparedArchivedTasksDelete(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(await host.commitPreparedArchivedTasksDelete(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(sql).not.toHaveBeenCalled();
            }
            value(await host.commitPreparedArchivedTasksDelete(deletion)); const undo = await prepareUndo(host, deletion);
            for (const change of [(item: NativeArchivedTasksDeleteUndoEnvelope) => { item.prepared.after[0].description = 'Forged'; },
                (item: NativeArchivedTasksDeleteUndoEnvelope) => { item.prepared.before[0].rev = 99; },
                (item: NativeArchivedTasksDeleteUndoEnvelope) => { item.prepared.delete.prepared.result.count = 99; },
                (item: NativeArchivedTasksDeleteUndoEnvelope) => { item.prepared.result.count = 99; },
                (item: NativeArchivedTasksDeleteUndoEnvelope) => { item.prepared.scope.areas.push({ id: 'extra', name: 'Extra', createdAt: NOW, updatedAt: NOW }); },
                (item: NativeArchivedTasksDeleteUndoEnvelope) => { item.request.requestId = item.request.deleteRequestId; item.prepared.request = item.request; }]) {
                const forged = clone(undo); change(forged); sql.mockClear();
                expect(host.validatePreparedArchivedTasksDeleteUndo(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(await host.commitPreparedArchivedTasksDeleteUndo(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(sql).not.toHaveBeenCalled();
            }
        } finally { await sqlite.close(); }
    });

    it('strictly binds complete selected raw rows while retaining unrelated later edits', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const deletion = await prepare();
            await sqlite.client().run('UPDATE tasks SET focusOrder = 3 WHERE id = ?', ['source']);
            await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
            expect(await methods().commitPreparedArchivedTasksDelete(deletion)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            const host = methods(); const fresh = await prepare(host);
            await sqlite.client().run('UPDATE tasks SET description = ? WHERE id = ?', ['Later sibling', 'sibling']);
            value(await host.commitPreparedArchivedTasksDelete(fresh));
            expect((await sqlite.sql<{ description: string }>('SELECT description FROM tasks WHERE id = ?', ['sibling']))[0].description).toBe('Later sibling');
            const undo = await prepareUndo(host, fresh);
            await sqlite.client().run('UPDATE tasks SET title = ? WHERE id = ?', ['Later selected', 'source']);
            const edited = await raw(sqlite);
            expect(await host.commitPreparedArchivedTasksDeleteUndo(undo)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(edited); expect(await sqlite.receiptIds()).toEqual([DELETE_ID]);
        } finally { await sqlite.close(); }
    });

    it('repairs containers changed before Undo using actual RN restore policy and guards changes after preparation', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const makeSeed = () => ({ ...seed(), tasks: [source('source', { projectId: 'parent', sectionId: 'section' }), source('sibling')],
            sections: [{ id: 'section', projectId: 'parent', title: 'Section', order: 0, createdAt: BEFORE, updatedAt: BEFORE }] });
        const rn = await openSqliteHost(makeSeed()); let expected; let expectedRaw;
        try {
            await canonical(); value(await rn.host.prepareArchivedTasksDelete(request()));
            expect(await useTaskStore.getState().batchDeleteTasks(['source'])).toEqual({ success: true }); await flushPendingSave();
            await rn.client().run('UPDATE projects SET deletedAt = ?, rev = rev + 1 WHERE id = ?', [NOW, 'parent']);
            await rn.restart(undefined, { recoveryLoad: true });
            expect(await useTaskStore.getState().restoreTask('source')).toEqual({ success: true }); await flushPendingSave();
            expected = rows(); expectedRaw = await raw(rn);
        } finally { await rn.close(); }
        const sqlite = await openSqliteHost(makeSeed());
        try {
            await canonical(); const host = methods(); const deletion = await prepare(host); value(await host.commitPreparedArchivedTasksDelete(deletion));
            await sqlite.client().run('UPDATE projects SET deletedAt = ?, rev = rev + 1 WHERE id = ?', [NOW, 'parent']);
            const undo = await prepareUndo(host, deletion); expect(undo.prepared.after[0].projectId).toBeUndefined();
            expect(undo.prepared.after[0].sectionId).toBeUndefined(); value(await host.commitPreparedArchivedTasksDeleteUndo(undo));
            expect(rows()).toEqual(expected); expect(await raw(sqlite)).toEqual(expectedRaw);
        } finally { await sqlite.close(); }
        const guarded = await openSqliteHost(makeSeed());
        try {
            const host = methods(); const deletion = await prepare(host); value(await host.commitPreparedArchivedTasksDelete(deletion));
            const undo = await prepareUndo(host, deletion);
            await guarded.client().run('UPDATE sections SET title = ? WHERE id = ?', ['Later section', 'section']); const before = await raw(guarded);
            expect(await host.commitPreparedArchivedTasksDeleteUndo(undo)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(guarded)).toEqual(before);
        } finally { await guarded.close(); }
    });

    it('retries two failed COMMITs for both directions using the owned raw save, preserving legacy sibling SQL', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const fault = { commits: 0 };
        const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('injected COMMIT failure'); }
            return client.run(sql, params);
        } }));
        try {
            await sqlite.client().run('UPDATE tasks SET focusOrder = 2, pushCount = NULL WHERE id IN (?, ?)', ['source', 'sibling']);
            await sqlite.restart(); const host = methods(); const deletion = await prepare(host); const before = await raw(sqlite);
            expect(deletion.prepared.before[0].focusOrder).toBe(2); expect(deletion.prepared.before[0].pushCount).toBeUndefined();
            for (let attempt = 0; attempt < 2; attempt++) {
                fault.commits = 10; expect(await host.commitPreparedArchivedTasksDelete(deletion)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
                expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
                expect(value(host.archivedTasksDeleteOutcome(deletion))).toBeNull();
            }
            fault.commits = 0; value(await host.commitPreparedArchivedTasksDelete(deletion));
            const deleted = await raw(sqlite); expect((deleted.tasks as { id: string }[]).find((row) => row.id === 'sibling'))
                .toEqual((before.tasks as { id: string }[]).find((row) => row.id === 'sibling'));
            const undo = await prepareUndo(host, deletion);
            for (let attempt = 0; attempt < 2; attempt++) {
                fault.commits = 10; expect(await host.commitPreparedArchivedTasksDeleteUndo(undo)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
                expect(await raw(sqlite)).toEqual(deleted); expect(await sqlite.receiptIds()).toEqual([DELETE_ID]);
                expect(value(host.archivedTasksDeleteUndoOutcome(undo))).toBeNull();
            }
            fault.commits = 0; value(await host.commitPreparedArchivedTasksDeleteUndo(undo));
            const restored = await raw(sqlite); expect((restored.tasks as { id: string }[]).find((row) => row.id === 'sibling'))
                .toEqual((before.tasks as { id: string }[]).find((row) => row.id === 'sibling'));
            expect(await sqlite.receiptIds()).toEqual([DELETE_ID, UNDO_ID]);
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 25_000);

    it('cold-recovers exact captured Delete and Undo journals after failed COMMIT with raw source guards intact', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const fault = { commits: 0 };
        const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('injected COMMIT failure'); }
            return client.run(sql, params);
        } }));
        try {
            await sqlite.client().run('UPDATE tasks SET focusOrder = 2, pushCount = NULL WHERE id IN (?, ?)', ['source', 'sibling']);
            await sqlite.restart(); const deletion = clone(await prepare()); const before = await raw(sqlite);
            fault.commits = 10; expect(await methods().commitPreparedArchivedTasksDelete(deletion)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); fault.commits = 0; await sqlite.restart(undefined, { recoveryLoad: true });
            expect(useTaskStore.getState()._tasksById.get('source')?.focusOrder).toBe(2);
            const host = methods(); value(await host.commitPreparedArchivedTasksDelete(deletion)); const deleted = await raw(sqlite);
            const undo = clone(await prepareUndo(host, deletion));
            fault.commits = 10; expect(await host.commitPreparedArchivedTasksDeleteUndo(undo)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(deleted); fault.commits = 0; await sqlite.restart(undefined, { recoveryLoad: true });
            value(await methods().commitPreparedArchivedTasksDeleteUndo(undo));
            expect(await sqlite.receiptIds()).toEqual([DELETE_ID, UNDO_ID]);
            expect((await raw(sqlite)).tasks).toEqual((await getStorageAdapter().getData({ rawTasks: true })).tasks.map((row, index) =>
                ({ _rowid: index + 1, ...Object.fromEntries(taskToSqliteRow(row).map((part, at) => [TASK_SQLITE_COLUMNS[at], part])) })));
            expect((await sqlite.sql<{ focusOrder: number; pushCount: null }>('SELECT focusOrder, pushCount FROM tasks WHERE id = ?', ['sibling']))[0])
                .toEqual({ focusOrder: 2, pushCount: null });
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 25_000);

    it('returns exact durable lost acknowledgments after later edits and terminal Undo after its Delete receipt expires', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const host = methods(); const deletion = await prepare(host); const deletedResult = value(await host.commitPreparedArchivedTasksDelete(deletion));
            const undo = await prepareUndo(host, deletion); const undoResult = value(await host.commitPreparedArchivedTasksDeleteUndo(undo));
            await sqlite.client().run('UPDATE tasks SET title = ?, rev = rev + 1 WHERE id = ?', ['Later selected', 'source']);
            await sqlite.restart(undefined, { recoveryLoad: true });
            const beforeDeleteReplay = await raw(sqlite); const lost = methods();
            expect(value(lost.archivedTasksDeleteOutcome(deletion))).toEqual(deletedResult);
            expect(value(await lost.commitPreparedArchivedTasksDelete(deletion))).toEqual(deletedResult);
            expect(await raw(sqlite)).toEqual(beforeDeleteReplay);
            await sqlite.client().run('DELETE FROM native_request_receipts WHERE request_id = ?', [DELETE_ID]);
            await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite); const fresh = methods();
            expect(value(fresh.archivedTasksDeleteUndoOutcome(undo))).toEqual(undoResult);
            expect(value(await fresh.commitPreparedArchivedTasksDeleteUndo(undo))).toEqual(undoResult);
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([UNDO_ID]);
            expect(await fresh.commitPreparedArchivedTasksDelete(deletion)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(deletedResult.count).toBe(1);
        } finally { await sqlite.close(); }
    });

    it('does not mint a receipt on prewrite read failure or unrelated persistence failure and exact retry still applies', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const fault = { read: false };
        const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, all: async (sql, params) => {
            if (fault.read && sql.includes('FROM tasks')) throw new Error('injected read failure'); return client.all(sql, params);
        } }));
        try {
            const host = methods(); const deletion = await prepare(host); const before = await raw(sqlite); fault.read = true;
            expect(await host.commitPreparedArchivedTasksDelete(deletion)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            fault.read = false; expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            expect(value(host.archivedTasksDeleteOutcome(deletion))).toBeNull();
            useTaskStore.setState({ persistenceFailure: { message: 'Unrelated failure', failedAt: NOW, retrying: false } });
            expect(await host.commitPreparedArchivedTasksDelete(deletion)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            useTaskStore.setState({ persistenceFailure: null }); value(await host.commitPreparedArchivedTasksDelete(deletion));
            const undo = await prepareUndo(host, deletion); const deleted = await raw(sqlite); fault.read = true;
            expect(await host.commitPreparedArchivedTasksDeleteUndo(undo)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            fault.read = false; expect(await raw(sqlite)).toEqual(deleted); expect(await sqlite.receiptIds()).toEqual([DELETE_ID]);
            value(await host.commitPreparedArchivedTasksDeleteUndo(undo)); expect(await sqlite.receiptIds()).toEqual([DELETE_ID, UNDO_ID]);
        } finally { fault.read = false; await sqlite.close(); }
    });

    it.each([1_050_000, 600_000])('rejects Delete or prospective full Undo oversized content %i before mutation', async (length) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost({ ...seed(), tasks: [source('source', { description: 'x'.repeat(length) })] });
        try {
            const before = await raw(sqlite);
            expect(await methods().prepareArchivedTasksDelete(request())).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('select fewer') } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('rechecks prospective Undo budget at first Delete commit against current referenced containers', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost({ ...seed(), tasks: [source('source', { projectId: 'parent', description: 'x'.repeat(400_000) })] });
        try {
            const deletion = await prepare(); await sqlite.client().run('UPDATE projects SET supportNotes = ? WHERE id = ?', ['x'.repeat(600_000), 'parent']);
            const before = await raw(sqlite);
            expect(await methods().commitPreparedArchivedTasksDelete(deletion)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('select fewer') } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('supports more than128 exact revisions in nested Delete/Undo envelopes without widening arbitrary object limits', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const tasks = Array.from({ length: 140 }, (_, index) => source(`selected-${index}`));
        const sqlite = await openSqliteHost({ ...seed(), tasks });
        try {
            const host = methods(); const deletion = await prepare(host, request(tasks.map((row) => row.id)));
            value(await host.commitPreparedArchivedTasksDelete(deletion)); const undo = await prepareUndo(host, deletion);
            expect(value(host.validatePreparedArchivedTasksDeleteUndo(undo))).toEqual({ count: 140 });
            expect(value(await host.commitPreparedArchivedTasksDeleteUndo(undo))).toEqual({ count: 140 });
            const forged = clone(undo) as NativeArchivedTasksDeleteUndoEnvelope & { arbitrary?: unknown };
            forged.arbitrary = Object.fromEntries(tasks.map((row) => [row.id, 'value']));
            expect(host.validatePreparedArchivedTasksDeleteUndo(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await sqlite.receiptIds()).toEqual([DELETE_ID, UNDO_ID]);
        } finally { await sqlite.close(); }
    });
});

describe('Undo receipt prerequisite', () => {
    it('refuses first Undo commit when its exact successful Delete receipt is missing, even with equal raw sources', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const host = methods(); const deletion = await prepare(host); value(await host.commitPreparedArchivedTasksDelete(deletion));
            const undo = await prepareUndo(host, deletion);
            await sqlite.client().run('DELETE FROM native_request_receipts WHERE request_id = ?', [DELETE_ID]);
            await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
            expect(await methods().commitPreparedArchivedTasksDeleteUndo(undo)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });
});

describe('Removed and purged Undo parent evidence', () => {
    it.each(['removed', 'purged'] as const)('matches RN restoration after %s parent without reactivation or resurrection', async (mode) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const makeSeed = () => ({ ...seed(), tasks: [source('source', { projectId: 'parent' }), source('sibling')] });
        const remove = async (sqlite: Awaited<ReturnType<typeof openSqliteHost>>) => {
            if (mode === 'purged') await sqlite.client().run('UPDATE projects SET deletedAt = ?, purgedAt = ?, rev = rev + 1 WHERE id = ?', [NOW, NOW, 'parent']);
            else {


                await sqlite.client().exec('PRAGMA foreign_keys = OFF');
                await sqlite.client().run('DELETE FROM projects WHERE id = ?', ['parent']);
                await sqlite.client().exec('PRAGMA foreign_keys = ON');
            }
        };
        const rn = await openSqliteHost(makeSeed()); let expected; let expectedRaw;
        try {
            await canonical(); expect(await useTaskStore.getState().batchDeleteTasks(['source'])).toEqual({ success: true }); await flushPendingSave();
            await remove(rn); await rn.restart(undefined, { recoveryLoad: true });
            expect(await useTaskStore.getState().restoreTask('source')).toEqual({ success: true }); await flushPendingSave();
            expected = rows(); expectedRaw = await raw(rn);
        } finally { await rn.close(); }
        const sqlite = await openSqliteHost(makeSeed());
        try {
            await canonical(); const host = methods(); const deletion = await prepare(host); value(await host.commitPreparedArchivedTasksDelete(deletion));
            await remove(sqlite); const undo = await prepareUndo(host, deletion); value(await host.commitPreparedArchivedTasksDeleteUndo(undo));
            expect(undo.prepared.after[0].projectId).toBeUndefined(); expect(rows()).toEqual(expected); expect(await raw(sqlite)).toEqual(expectedRaw);
            if (mode === 'removed') expect(rows().projects).toEqual([]);
            else expect(rows().projects[0]).toMatchObject({ status: 'archived', deletedAt: NOW, purgedAt: NOW });
        } finally { await sqlite.close(); }
    });
});

describe('Missing saved device initialization', () => {
    it.each(['same-host', 'cold'] as const)('initializes one frozen device after failed Delete save and %s exact retry; Undo reuses it', async (recovery) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const fault = { commits: 0 };
        const sqlite = await openSqliteHost({ ...seed(), settings: { analyticsProfileId: DELETE_ID } }, (client) => ({ ...client,
            run: async (sql, params) => {
                if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('injected COMMIT failure'); }
                return client.run(sql, params);
            },
        }));
        try {


            await sqlite.client().run("UPDATE settings SET data = json_remove(data, '$.deviceId') WHERE id = 1");
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(useTaskStore.getState().settings.deviceId).toBeUndefined();
            expect((await getStorageAdapter().getData({ rawTasks: true })).settings.deviceId).toBeUndefined();
            let host = methods(); const deletion = clone(await prepare(host)); const before = await raw(sqlite);
            const initialized = deletion.prepared.deviceIdToInitialize;
            expect(deletion.prepared.deviceIdBefore).toBeNull();
            expect(initialized).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
            expect(deletion.prepared.after.every((row) => row.revBy === initialized)).toBe(true);
            expect(value(host.validatePreparedArchivedTasksDelete(deletion))).toEqual(deletion.prepared.result);
            fault.commits = 10;
            expect(await host.commitPreparedArchivedTasksDelete(deletion)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            expect(value(host.archivedTasksDeleteOutcome(deletion))).toBeNull();
            fault.commits = 0;
            if (recovery === 'cold') {
                await sqlite.restart(undefined, { recoveryLoad: true }); host = methods();
                expect(useTaskStore.getState().settings.deviceId).toBeUndefined();
            }
            expect(value(await host.commitPreparedArchivedTasksDelete(deletion))).toEqual(deletion.prepared.result);
            expect(useTaskStore.getState().settings.deviceId).toBe(initialized);
            expect((await getStorageAdapter().getData({ rawTasks: true })).settings.deviceId).toBe(initialized);
            expect(await sqlite.receiptIds()).toEqual([DELETE_ID]);
            await sqlite.restart(undefined, { recoveryLoad: true }); host = methods();
            expect(useTaskStore.getState().settings.deviceId).toBe(initialized);
            expect(value(host.archivedTasksDeleteOutcome(deletion))).toEqual(deletion.prepared.result);
            const undo = await prepareUndo(host, deletion);
            expect(undo.prepared.deviceIdBefore).toBe(initialized); expect(undo.prepared.deviceIdToInitialize).toBeNull();
            expect(undo.prepared.after.every((row) => row.revBy === initialized)).toBe(true);
            expect(value(await host.commitPreparedArchivedTasksDeleteUndo(undo))).toEqual({ count: 1 });
            expect((await getStorageAdapter().getData({ rawTasks: true })).settings.deviceId).toBe(initialized);
            expect(await sqlite.receiptIds()).toEqual([DELETE_ID, UNDO_ID]);
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(useTaskStore.getState().settings.deviceId).toBe(initialized);
            expect(value(methods().archivedTasksDeleteUndoOutcome(undo))).toEqual({ count: 1 });
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 25_000);
});
