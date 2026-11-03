import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqliteHost } from './screen-parity.replay';
import { taskRevisionOf } from './native-request-receipts';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import type { AppData, Area, Project, Section, Task } from './types';


vi.setConfig({ testTimeout: 30_000 });

const NOW = '2026-10-02T13:00:00.000Z';
const TASK_ID = 'reference-task';
const DELETE_ID = '00000000-0000-4000-8000-000000000186';
const UNDO_ID = '00000000-0000-4000-8000-000000000187';
const clone = <T,>(source: T): T => JSON.parse(JSON.stringify(source)) as T;
const value = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const task = (overrides: Partial<Task> = {}): Task => ({
    id: TASK_ID, title: 'Reference source', status: 'reference',
    createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-30T12:00:00.000Z',
    rev: 3, revBy: 'device-a',
    tags: ['tag'], contexts: ['home'], projectId: 'reference-project', sectionId: 'reference-section',
    description: 'Keep every byte of this note',
    checklist: [{ id: 'check-1', title: 'Keep this checklist item', isCompleted: true }],
    attachments: [{ id: 'attach-1', kind: 'file', title: 'proof.txt', uri: 'file:///owned/proof.txt',
        createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-01T12:00:00.000Z' }],
    recurrence: { rule: 'daily', strategy: 'strict', seriesId: TASK_ID },
    ...overrides,

});
const project = (overrides: Partial<Project> = {}): Project => ({
    id: 'reference-project', title: 'Parent', status: 'active',
    createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-30T12:00:00.000Z',
    color: '#94a3b8', order: 0, tagIds: [], ...overrides,
});
const section: Section = {
    id: 'reference-section', projectId: 'reference-project', title: 'Section', order: 0,
    createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-30T12:00:00.000Z',
};
const removedArea: Area = { id: 'removed-area', name: 'Removed Area', order: 0,
    createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-30T12:00:00.000Z',
    deletedAt: '2026-09-30T12:00:00.000Z' };
const seed = (source: Task = task(), parent: Project = project(), areas: Area[] = []): Partial<AppData> => ({
    tasks: [source, task({ id: 'reference-sibling', title: 'Sibling', recurrence: undefined,
        checklist: [], attachments: [] })],
    projects: [parent], sections: [section], areas, settings: { deviceId: 'device-a',
        analyticsProfileId: '00000000-0000-4000-8000-000000000188' },
});
const rows = () => {
    const state = useTaskStore.getState();
    return clone({ tasks: state._allTasks, projects: state._allProjects, sections: state._allSections,
        areas: state._allAreas, people: state._allPeople, settings: state.settings });
};
const request = () => ({ requestId: DELETE_ID, taskId: TASK_ID,
    taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get(TASK_ID)!), source: 'reference' as const });
type SqliteHost = Awaited<ReturnType<typeof openSqliteHost>>;
const tables = ['tasks', 'projects', 'sections', 'areas', 'people', 'settings',
    'saved_filters', 'calendar_sync', 'schema_migrations'];
const sqlSnapshot = async (sqlite: SqliteHost) => Object.fromEntries(await Promise.all(tables.map(async (table) => [table, {
    schema: await sqlite.sql(`PRAGMA table_info(${table})`),
    rows: await sqlite.sql(`SELECT rowid AS evidenceRowid, * FROM ${table} ORDER BY rowid`),
}])));
const receiptSnapshot = async (sqlite: SqliteHost) => ({
    schema: await sqlite.sql('PRAGMA table_info(native_request_receipts)'),
    rows: await sqlite.sql('SELECT rowid AS evidenceRowid, * FROM native_request_receipts ORDER BY rowid'),
});

afterEach(async () => {
    await flushPendingSave();
    resetForTests();
    vi.useRealTimers();
});

describe('Reference Task Delete and Undo use saved RN task policy', () => {
    it.each([
        ['recurring Reference', task(), []],
        ['ordinary Reference', task({ recurrence: undefined }), []],
        ['deleted Area link', task({ projectId: undefined, sectionId: undefined, areaId: removedArea.id }), [removedArea]],
    ])('matches RN deleteTask and restoreTask whole-data effects for %s', async (_name, source, areas) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const rn = await openSqliteHost(seed(source, project(), areas));
        let expectedDelete: ReturnType<typeof rows>;
        let expectedUndo: ReturnType<typeof rows>;
        let expectedDeleteSql: Awaited<ReturnType<typeof sqlSnapshot>>;
        let expectedUndoSql: Awaited<ReturnType<typeof sqlSnapshot>>;
        try {
            expect((await useTaskStore.getState().deleteTask(TASK_ID)).success).toBe(true);
            await flushPendingSave();
            expectedDelete = rows();
            expectedDeleteSql = await sqlSnapshot(rn);
            expect((await useTaskStore.getState().restoreTask(TASK_ID)).success).toBe(true);
            await flushPendingSave();
            expectedUndo = rows();
            expectedUndoSql = await sqlSnapshot(rn);
        } finally { await rn.close(); }

        const native = await openSqliteHost(seed(source, project(), areas));
        try {
            const saved = rows();
            const original = request();
            const prepared = value(native.host.prepareTaskDelete(original)).prepared;
            const deleted = { request: original, prepared };
            expect(value(await native.host.commitPreparedTaskDelete(deleted))).toEqual(prepared.result);
            expect(rows()).toEqual(expectedDelete);
            expect(await sqlSnapshot(native)).toEqual(expectedDeleteSql);
            const undoRequest = { requestId: UNDO_ID, deleteRequestId: DELETE_ID };
            const undoPrepared = value(native.host.prepareTaskDeleteUndo({ request: undoRequest, delete: deleted })).prepared;
            const undo = { request: undoRequest, prepared: undoPrepared };
            expect(value(await native.host.commitPreparedTaskDeleteUndo(undo))).toEqual({ id: TASK_ID });
            expect(rows()).toEqual(expectedUndo);
            expect(await sqlSnapshot(native)).toEqual(expectedUndoSql);
            expect(rows().tasks[1]).toEqual(saved.tasks[1]);
            expect(rows().tasks[0]).toMatchObject({ status: 'reference',
                description: source.description, attachments: source.attachments, checklist: source.checklist });
            expect(rows().tasks[0].completedAt).toBeUndefined();
            expect(rows().tasks[0].recurrence).toEqual(saved.tasks[0].recurrence);
        } finally { await native.close(); }
    });

    it('binds Reference status, saved revision and the RN archived-parent read-only rule', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        for (const source of [task({ status: 'next', completedAt: undefined }), task({ deletedAt: NOW }),
            task({ purgedAt: NOW })]) {
            const sqlite = await openSqliteHost(seed(source));
            try {
                expect(sqlite.host.prepareTaskDelete(request()))
                    .toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
            } finally { await sqlite.close(); }
        }
        const archived = await openSqliteHost(seed(task(), project({ status: 'archived', archivedAt: NOW })));
        try {
            expect(archived.host.prepareTaskDelete(request()))
                .toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
        } finally { await archived.close(); }
        const sqlite = await openSqliteHost(seed());
        try {
            const original = request();
            expect(sqlite.host.prepareTaskDelete({ ...original, source: 'wrong' as never }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(sqlite.host.prepareTaskDelete({ ...original, taskId: `${TASK_ID}:projected-recurrence` }))
                .toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
            const prepared = value(sqlite.host.prepareTaskDelete(original)).prepared;
            const forged = clone({ request: original, prepared });
            forged.prepared.board.prepared.before.status = 'next';
            forged.prepared.board.prepared.after.status = 'next';
            expect(sqlite.host.validatePreparedTaskDelete(forged))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            await useTaskStore.getState().updateTask(TASK_ID, { title: 'Later title' });
            await flushPendingSave();
            expect(sqlite.host.prepareTaskDelete(original))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await sqlite.host.commitPreparedTaskDelete({ request: original, prepared }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        } finally { await sqlite.close(); }
    });

    it('requires exact BEFORE and an attributable Delete receipt after cold later edits', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const original = request();
            const prepared = value(sqlite.host.prepareTaskDelete(original)).prepared;
            const envelope = { request: original, prepared };
            const alternate = clone(envelope);
            alternate.request.requestId = '00000000-0000-4000-8000-000000000189';
            alternate.prepared.request.requestId = alternate.request.requestId;
            alternate.prepared.board.request.requestId = alternate.request.requestId;
            alternate.prepared.board.prepared.request.requestId = alternate.request.requestId;
            expect(value(sqlite.host.taskDeleteOutcome(envelope))).toBeNull();
            expect(value(await sqlite.host.commitPreparedTaskDelete(envelope))).toEqual(prepared.result);
            await sqlite.restart(undefined, { recoveryLoad: true });
            const deleted = rows();
            expect(await sqlite.host.commitPreparedTaskDelete(alternate))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(rows()).toEqual(deleted);
            await sqlite.client().run('UPDATE tasks SET title = ?, rev = rev + 1, updatedAt = ? WHERE id = ?',
                ['Edited in Trash', '2026-10-02T13:00:01.000Z', TASK_ID]);
            await sqlite.restart();
            const later = rows();
            const receipts = await receiptSnapshot(sqlite);
            expect(value(sqlite.host.taskDeleteOutcome(envelope))).toEqual(prepared.result);
            expect(value(await sqlite.host.commitPreparedTaskDelete(envelope))).toEqual(prepared.result);
            expect(rows()).toEqual(later);
            expect(await receiptSnapshot(sqlite)).toEqual(receipts);
            expect(value(sqlite.host.taskDeleteOutcome(alternate))).toBeNull();
        } finally { await sqlite.close(); }
    });

    it('requires exact BEFORE and an attributable Undo receipt after cold later edits', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const original = request();
            const prepared = value(sqlite.host.prepareTaskDelete(original)).prepared;
            const deleted = { request: original, prepared };
            value(await sqlite.host.commitPreparedTaskDelete(deleted));
            const undoRequest = { requestId: UNDO_ID, deleteRequestId: DELETE_ID };
            const undoPrepared = value(sqlite.host.prepareTaskDeleteUndo({ request: undoRequest, delete: deleted })).prepared;
            const envelope = { request: undoRequest, prepared: undoPrepared };
            const alternate = clone(envelope);
            alternate.request.requestId = '00000000-0000-4000-8000-000000000189';
            alternate.prepared.request.requestId = alternate.request.requestId;
            expect(value(sqlite.host.taskDeleteUndoOutcome(envelope))).toBeNull();
            expect(value(await sqlite.host.commitPreparedTaskDeleteUndo(envelope))).toEqual({ id: TASK_ID });
            await sqlite.restart(undefined, { recoveryLoad: true });
            const restored = rows();
            expect(await sqlite.host.commitPreparedTaskDeleteUndo(alternate))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(rows()).toEqual(restored);
            await sqlite.client().run('UPDATE tasks SET title = ?, rev = rev + 1, updatedAt = ? WHERE id = ?',
                ['Later restored edit', '2026-10-02T13:00:01.000Z', TASK_ID]);
            await sqlite.restart(undefined, { recoveryLoad: true });
            const later = rows();
            const receipts = await receiptSnapshot(sqlite);
            expect(value(sqlite.host.taskDeleteUndoOutcome(envelope))).toEqual({ id: TASK_ID });
            expect(value(await sqlite.host.commitPreparedTaskDeleteUndo(envelope))).toEqual({ id: TASK_ID });
            expect(rows()).toEqual(later);
            expect(await receiptSnapshot(sqlite)).toEqual(receipts);
            expect(value(sqlite.host.taskDeleteUndoOutcome(alternate))).toBeNull();
        } finally { await sqlite.close(); }
    });

    it.each(['archived', 'deleted', 'purged'] as const)('rechecks the %s-parent read-only guard after prepare', async (protection) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const original = request();
            const prepared = value(sqlite.host.prepareTaskDelete(original)).prepared;
            if (protection === 'archived') await sqlite.client().run('UPDATE projects SET status = ?, archivedAt = ?, rev = rev + 1, updatedAt = ? WHERE id = ?',
                ['archived', NOW, NOW, 'reference-project']);
            else await sqlite.client().run(`UPDATE projects SET deletedAt=?${protection === 'purged' ? ',purgedAt=?' : ''} WHERE id=?`,
                protection === 'purged' ? [NOW, NOW, 'reference-project'] : [NOW, 'reference-project']);
            await sqlite.restart(undefined, { recoveryLoad: true });
            const before = rows();
            expect(await sqlite.host.commitPreparedTaskDelete({ request: original, prepared }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(rows()).toEqual(before);
            expect(value(sqlite.host.taskDeleteOutcome({ request: original, prepared }))).toBeNull();
        } finally { await sqlite.close(); }
    });

    it('cold-retries failed SQLite COMMITs without a partial Delete, Undo, or receipt', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const fault = { commits: 0 };
        const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('injected commit failure'); }
            return client.run(sql, params);
        } }));
        try {


            await sqlite.client().run('UPDATE tasks SET pushCount = NULL WHERE id = ?', [TASK_ID]);
            await sqlite.restart();
            const original = request();
            const prepared = value(sqlite.host.prepareTaskDelete(original)).prepared;
            const deleted = { request: original, prepared };
            const beforeDelete = await sqlSnapshot(sqlite);
            expect(prepared.board.prepared.before.pushCount).toBe(0);
            expect(await sqlite.sql('SELECT pushCount FROM tasks WHERE id = ?', [TASK_ID])).toEqual([{ pushCount: null }]);
            const beforeReceipts = await receiptSnapshot(sqlite);
            fault.commits = 10;
            expect(await sqlite.host.commitPreparedTaskDelete(deleted))
                .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await sqlSnapshot(sqlite)).toEqual(beforeDelete);
            expect(await receiptSnapshot(sqlite)).toEqual(beforeReceipts);
            fault.commits = 0;
            resetForTests();
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(useTaskStore.getState()._tasksById.get(TASK_ID)?.pushCount).toBeUndefined();
            expect(value(sqlite.host.taskDeleteOutcome(deleted))).toBeNull();
            value(await sqlite.host.commitPreparedTaskDelete(deleted));
            const undoRequest = { requestId: UNDO_ID, deleteRequestId: DELETE_ID };
            const undoPrepared = value(sqlite.host.prepareTaskDeleteUndo({ request: undoRequest, delete: deleted })).prepared;
            const undo = { request: undoRequest, prepared: undoPrepared };
            const beforeUndo = await sqlSnapshot(sqlite);
            const beforeUndoReceipts = await receiptSnapshot(sqlite);
            fault.commits = 10;
            expect(await sqlite.host.commitPreparedTaskDeleteUndo(undo))
                .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await sqlSnapshot(sqlite)).toEqual(beforeUndo);
            expect(await receiptSnapshot(sqlite)).toEqual(beforeUndoReceipts);
            fault.commits = 0;
            resetForTests();
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(sqlite.host.taskDeleteUndoOutcome(undo))).toBeNull();
            expect(value(await sqlite.host.commitPreparedTaskDeleteUndo(undo))).toEqual({ id: TASK_ID });
            await sqlite.restart();
            expect(value(sqlite.host.taskDeleteUndoOutcome(undo))).toEqual({ id: TASK_ID });
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 25_000);

    it.each([
        ['nonzero pushCount', 'pushCount', 1],
        ['negative pushCount', 'pushCount', -1],
        ['title', 'title', 'Concurrent title'],
        ['revision', 'rev', 4],
        ['recurrence', 'recurrence', JSON.stringify({ rule: 'weekly', strategy: 'strict', seriesId: TASK_ID })],
    ])('refuses a cold concurrent %s change despite the missing pushCount default', async (_name, column, changed) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            await sqlite.client().run('UPDATE tasks SET pushCount = NULL WHERE id = ?', [TASK_ID]);
            await sqlite.restart();
            const original = request();
            const prepared = value(sqlite.host.prepareTaskDelete(original)).prepared;
            expect(prepared.board.prepared.before.pushCount).toBe(0);
            await sqlite.client().run(`UPDATE tasks SET ${column} = ? WHERE id = ?`, [changed, TASK_ID]);
            await sqlite.restart(undefined, { recoveryLoad: true });
            const before = await sqlite.sql('SELECT * FROM tasks ORDER BY id');
            const receipts = await receiptSnapshot(sqlite);
            expect(await sqlite.host.commitPreparedTaskDelete({ request: original, prepared }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await sqlite.sql('SELECT * FROM tasks ORDER BY id')).toEqual(before);
            expect(await receiptSnapshot(sqlite)).toEqual(receipts);
        } finally { await sqlite.close(); }
    });
    it('initializes a missing durable device exactly once across owned retry, cold recovery and Undo', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        let fail = false;
        const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fail) throw new Error('injected commit failure');
            return client.run(sql, params);
        } }));
        try {
            useTaskStore.setState((state) => ({ settings: { ...state.settings, deviceId: undefined } }));
            await useTaskStore.getState().persistSnapshot();
            await flushPendingSave();
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(useTaskStore.getState().settings.deviceId).toBeUndefined();
            const original = request();
            const prepared = value(sqlite.host.prepareTaskDelete(original)).prepared;
            const deleted = { request: original, prepared };
            const deviceId = prepared.board.prepared.deviceIdToInitialize!;
            expect(deviceId).toMatch(/^[0-9a-f-]{36}$/);
            expect(prepared.board.prepared.after.revBy).toBe(deviceId);
            const before = await sqlSnapshot(sqlite);
            const receiptsBefore = await receiptSnapshot(sqlite);
            fail = true;
            expect(await sqlite.host.commitPreparedTaskDelete(deleted)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await sqlSnapshot(sqlite)).toEqual(before);
            expect(await receiptSnapshot(sqlite)).toEqual(receiptsBefore);
            fail = false;
            value(await sqlite.host.commitPreparedTaskDelete(deleted));
            const saved = await receiptSnapshot(sqlite);
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(await receiptSnapshot(sqlite)).toEqual(saved);
            expect(useTaskStore.getState().settings.deviceId).toBe(deviceId);
            const undoRequest = { requestId: UNDO_ID, deleteRequestId: DELETE_ID };
            const restored = value(sqlite.host.prepareTaskDeleteUndo({ request: undoRequest, delete: deleted })).prepared;
            expect(restored.deviceIdBefore).toBe(deviceId);
            expect(restored.deviceIdToInitialize).toBeNull();
            expect(restored.after.revBy).toBe(deviceId);
            value(await sqlite.host.commitPreparedTaskDeleteUndo({ request: undoRequest, prepared: restored }));
            const finalReceipts = await receiptSnapshot(sqlite);
            expect(finalReceipts.rows).toHaveLength(2);
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(await receiptSnapshot(sqlite)).toEqual(finalReceipts);
            expect(useTaskStore.getState().settings.deviceId).toBe(deviceId);
            expect(useTaskStore.getState()._tasksById.get(TASK_ID)?.revBy).toBe(deviceId);
        } finally { fail = false; await sqlite.close(); }
    }, 20_000);

    it('deletes one saved identity shown in multiple tag groups and restores the current query and folds', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed(task({ tags: ['#first', '#second'] })));
        try {
            const params = { offset: 0, limit: 100, groupBy: 'tag' as const,
                filters: { searchQuery: 'Reference source' } };
            const displayed = value(sqlite.host.getReferenceView(params));
            const occurrences = displayed.items.filter((item) => item.type === 'task');
            expect(occurrences).toHaveLength(2);
            expect(new Set(occurrences.map((item) => item.groupId)).size).toBe(2);
            expect(occurrences.map((item) => item.row.id)).toEqual([TASK_ID, TASK_ID]);
            const original = { ...request(), taskRevision: occurrences[0].row.taskRevision };
            const folded = { ...params, collapsedGroupIds: [occurrences[1].groupId] };
            expect(value(sqlite.host.getReferenceView(folded)).items.filter((item) => item.type === 'task')).toHaveLength(1);
            const prepared = value(sqlite.host.prepareTaskDelete(original)).prepared;
            const deleted = { request: original, prepared };
            value(await sqlite.host.commitPreparedTaskDelete(deleted));
            expect(value(sqlite.host.getReferenceView(folded)).items.filter((item) => item.type === 'task')).toHaveLength(0);
            expect(rows().tasks.filter((entry: Task) => entry.id === TASK_ID)).toHaveLength(1);
            const undoRequest = { requestId: UNDO_ID, deleteRequestId: DELETE_ID };
            const restored = value(sqlite.host.prepareTaskDeleteUndo({ request: undoRequest, delete: deleted })).prepared;
            value(await sqlite.host.commitPreparedTaskDeleteUndo({ request: undoRequest, prepared: restored }));
            const refreshed = value(sqlite.host.getReferenceView(folded));
            expect(refreshed.collapsedGroupIds).toEqual(folded.collapsedGroupIds);
            expect(refreshed.items.filter((item) => item.type === 'task').map((item) => item.row.id)).toEqual([TASK_ID]);
            expect(value(sqlite.host.getReferenceView(params)).items.filter((item) => item.type === 'task')).toHaveLength(2);
        } finally { await sqlite.close(); }
    });

    it('rejects malformed and forged Reference journals before any SQL', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const calls: string[] = [];
        const sqlite = await openSqliteHost(seed(), (client) => new Proxy(client, { get: (target, property) => {
            const method = Reflect.get(target, property);
            return typeof method === 'function' ? (...args: unknown[]) => {
                calls.push(String(args[0]));
                return method(...args);
            } : method;
        } }));
        try {
            const original = request();
            const prepared = value(sqlite.host.prepareTaskDelete(original)).prepared;
            const envelope = { request: original, prepared };
            const status = clone(envelope);
            status.prepared.board.prepared.before.status = 'next';
            status.prepared.board.prepared.after.status = 'next';
            const after = clone(envelope);
            after.prepared.board.prepared.after.description = 'Forged';
            const nested = clone(envelope);
            nested.prepared.board.request.action.taskId = 'other';
            const excess = { ...envelope, extra: true };
            const wrong = { ...envelope, request: { ...original, source: 'other' } };
            calls.length = 0;
            for (const malformed of [status, after, nested, excess, wrong, { request: original }]) {
                expect(sqlite.host.validatePreparedTaskDelete(malformed as never))
                    .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(await sqlite.host.commitPreparedTaskDelete(malformed as never))
                    .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(sqlite.host.taskDeleteOutcome(malformed as never))
                    .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            }
            expect(calls).toEqual([]);
            value(await sqlite.host.commitPreparedTaskDelete(envelope));
            const undoRequest = { requestId: UNDO_ID, deleteRequestId: DELETE_ID };
            const restored = value(sqlite.host.prepareTaskDeleteUndo({ request: undoRequest, delete: envelope })).prepared;
            const forged = { request: undoRequest, prepared: clone(restored) };
            forged.prepared.after.description = 'Forged Undo';
            calls.length = 0;
            expect(sqlite.host.validatePreparedTaskDeleteUndo(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await sqlite.host.commitPreparedTaskDeleteUndo(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(sqlite.host.taskDeleteUndoOutcome(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(calls).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('preserves legacy Reference focusOrder and retries the same owned failed Delete and Undo saves', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        let fail = false;
        const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fail) throw new Error('injected commit failure');
            return client.run(sql, params);
        } }));
        try {
            await sqlite.client().run('UPDATE tasks SET focusOrder=2,pushCount=NULL WHERE id=?', [TASK_ID]);
            await sqlite.restart();
            const original = request();
            const prepared = value(sqlite.host.prepareTaskDelete(original)).prepared;
            const deleted = { request: original, prepared };
            expect(prepared.board.prepared.before.focusOrder).toBe(2);
            expect(prepared.board.prepared.before.pushCount).toBe(0);
            const before = await sqlSnapshot(sqlite);
            const beforeReceipts = await receiptSnapshot(sqlite);
            fail = true;
            for (let attempt = 0; attempt < 2; attempt++) {
                expect(await sqlite.host.commitPreparedTaskDelete(deleted)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
                expect(await sqlSnapshot(sqlite)).toEqual(before);
                expect(await receiptSnapshot(sqlite)).toEqual(beforeReceipts);
            }
            fail = false;
            expect(value(await sqlite.host.commitPreparedTaskDelete(deleted))).toEqual(prepared.result);
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(useTaskStore.getState()._tasksById.get(TASK_ID)?.focusOrder).toBe(2);
            const undoRequest = { requestId: UNDO_ID, deleteRequestId: DELETE_ID };
            const restored = value(sqlite.host.prepareTaskDeleteUndo({ request: undoRequest, delete: deleted })).prepared;
            const undo = { request: undoRequest, prepared: restored };
            const beforeUndo = await sqlSnapshot(sqlite);
            const receiptsBeforeUndo = await receiptSnapshot(sqlite);
            fail = true;
            for (let attempt = 0; attempt < 2; attempt++) {
                expect(await sqlite.host.commitPreparedTaskDeleteUndo(undo)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
                expect(await sqlSnapshot(sqlite)).toEqual(beforeUndo);
                expect(await receiptSnapshot(sqlite)).toEqual(receiptsBeforeUndo);
            }
            fail = false;
            expect(value(await sqlite.host.commitPreparedTaskDeleteUndo(undo))).toEqual({ id: TASK_ID });
            const saved = await receiptSnapshot(sqlite);
            expect(saved.rows).toHaveLength(2);
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(await receiptSnapshot(sqlite)).toEqual(saved);
            expect(value(await sqlite.host.commitPreparedTaskDeleteUndo(undo))).toEqual({ id: TASK_ID });
            expect(await receiptSnapshot(sqlite)).toEqual(saved);
            expect(useTaskStore.getState()._tasksById.get(TASK_ID)).toMatchObject({ status: 'reference', focusOrder: 2, pushCount: 0 });
        } finally { fail = false; await sqlite.close(); }
    }, 25_000);

    it('matches RN all-nine writes from raw NULL count and absent attachment timestamp after true failed-save recovery', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const legacy = async (sqlite: SqliteHost) => {
            const attachments = clone(task().attachments!);
            delete attachments[0].updatedAt;
            await sqlite.client().run('UPDATE tasks SET focusOrder=2,pushCount=NULL,attachments=? WHERE id=?',
                [JSON.stringify(attachments), TASK_ID]);
            await sqlite.restart();
        };
        const rn = await openSqliteHost(seed());
        let expectedDelete: ReturnType<typeof rows>, expectedUndo: ReturnType<typeof rows>;
        let expectedDeleteSql: Awaited<ReturnType<typeof sqlSnapshot>>, expectedUndoSql: Awaited<ReturnType<typeof sqlSnapshot>>;
        try {
            await legacy(rn);
            expect((await useTaskStore.getState().deleteTask(TASK_ID)).success).toBe(true);
            await flushPendingSave();
            expectedDelete = rows(); expectedDeleteSql = await sqlSnapshot(rn);
            expect((await useTaskStore.getState().restoreTask(TASK_ID)).success).toBe(true);
            await flushPendingSave();
            expectedUndo = rows(); expectedUndoSql = await sqlSnapshot(rn);
        } finally { await rn.close(); }
        let fail = false;
        const native = await openSqliteHost(seed(), (client) => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fail) throw new Error('injected commit failure');
            return client.run(sql, params);
        } }));
        try {
            await legacy(native);
            const raw = await native.sql<{ focusOrder: number; pushCount: null; attachments: string }>(
                'SELECT focusOrder,pushCount,attachments FROM tasks WHERE id=?', [TASK_ID]);
            expect(raw[0].focusOrder).toBe(2);
            expect(raw[0].pushCount).toBeNull();
            expect(JSON.parse(raw[0].attachments)[0]).not.toHaveProperty('updatedAt');
            const original = request();
            const prepared = value(native.host.prepareTaskDelete(original)).prepared;
            const deleted = { request: original, prepared };
            expect(prepared.board.prepared.before.attachments![0].updatedAt).toBe('');
            const before = await sqlSnapshot(native), beforeReceipts = await receiptSnapshot(native);
            fail = true;
            expect(await native.host.commitPreparedTaskDelete(deleted)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await sqlSnapshot(native)).toEqual(before);
            expect(await receiptSnapshot(native)).toEqual(beforeReceipts);
            fail = false;
            resetForTests();
            await native.restart(undefined, { recoveryLoad: true });
            expect(useTaskStore.getState()._tasksById.get(TASK_ID)?.pushCount).toBeUndefined();
            value(await native.host.commitPreparedTaskDelete(deleted));
            expect(rows()).toEqual(expectedDelete);
            expect(await sqlSnapshot(native)).toEqual(expectedDeleteSql);
            const undoRequest = { requestId: UNDO_ID, deleteRequestId: DELETE_ID };
            const restored = value(native.host.prepareTaskDeleteUndo({ request: undoRequest, delete: deleted })).prepared;
            value(await native.host.commitPreparedTaskDeleteUndo({ request: undoRequest, prepared: restored }));
            expect(rows()).toEqual(expectedUndo);
            expect(await sqlSnapshot(native)).toEqual(expectedUndoSql);
        } finally { fail = false; await native.close(); }
    }, 20_000);

    it.each(['archived-project', 'deleted-project', 'purged-project', 'deleted-section', 'deleted-area'] as const)
    ('matches RN Undo sanitizer without resurrecting %s', async (removed) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const area = { ...removedArea, deletedAt: undefined };
        const source = removed === 'deleted-area'
            ? task({ projectId: undefined, sectionId: undefined, areaId: area.id }) : task();
        const changeContainer = async (sqlite: SqliteHost) => {
            if (removed === 'deleted-area') await sqlite.client().run('UPDATE areas SET deletedAt=? WHERE id=?', [NOW, area.id]);
            else if (removed === 'deleted-section') await sqlite.client().run('UPDATE sections SET deletedAt=? WHERE id=?', [NOW, section.id]);
            else if (removed === 'archived-project') await sqlite.client().run('UPDATE projects SET status=?,archivedAt=? WHERE id=?', ['archived', NOW, project().id]);
            else await sqlite.client().run(`UPDATE projects SET deletedAt=?${removed === 'purged-project' ? ',purgedAt=?' : ''} WHERE id=?`,
                removed === 'purged-project' ? [NOW, NOW, project().id] : [NOW, project().id]);
            await sqlite.restart(undefined, { recoveryLoad: true });
        };
        const rn = await openSqliteHost(seed(source, project(), [area]));
        let expected: ReturnType<typeof rows>;
        let expectedSql: Awaited<ReturnType<typeof sqlSnapshot>>;
        try {
            expect((await useTaskStore.getState().deleteTask(TASK_ID)).success).toBe(true);
            await flushPendingSave();
            await changeContainer(rn);
            expect((await useTaskStore.getState().restoreTask(TASK_ID)).success).toBe(true);
            await flushPendingSave();
            expected = rows();
            expectedSql = await sqlSnapshot(rn);
        } finally { await rn.close(); }
        const native = await openSqliteHost(seed(source, project(), [area]));
        try {
            const original = request();
            const prepared = value(native.host.prepareTaskDelete(original)).prepared;
            const deleted = { request: original, prepared };
            value(await native.host.commitPreparedTaskDelete(deleted));
            await changeContainer(native);
            const undoRequest = { requestId: UNDO_ID, deleteRequestId: DELETE_ID };
            const restored = value(native.host.prepareTaskDeleteUndo({ request: undoRequest, delete: deleted })).prepared;
            value(await native.host.commitPreparedTaskDeleteUndo({ request: undoRequest, prepared: restored }));
            expect(rows()).toEqual(expected);
            expect(await sqlSnapshot(native)).toEqual(expectedSql);
            expect(rows().tasks[0].status).toBe('reference');
            if (removed === 'archived-project') expect(rows().projects[0].status).toBe('archived');
            if (removed === 'deleted-project' || removed === 'purged-project') {
                expect(rows().tasks[0].projectId).toBeUndefined();
                expect(rows().tasks[0].sectionId).toBeUndefined();
                expect(rows().projects[0].deletedAt).toBe(NOW);
            }
        } finally { await native.close(); }
    });
});
