import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqliteHost } from './screen-parity.replay';
import { taskRevisionOf } from './native-request-receipts';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import type { AppData, Area, Project, Section, Task } from './types';


vi.setConfig({ testTimeout: 30_000 });

const NOW = '2026-10-02T13:00:00.000Z';
const TASK_ID = 'done-task';
const DELETE_ID = '00000000-0000-4000-8000-000000000176';
const UNDO_ID = '00000000-0000-4000-8000-000000000177';
const clone = <T,>(source: T): T => JSON.parse(JSON.stringify(source)) as T;
const value = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const task = (overrides: Partial<Task> = {}): Task => ({
    id: TASK_ID, title: 'Done source', status: 'done',
    createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-30T12:00:00.000Z',
    completedAt: '2026-09-30T12:00:00.000Z', rev: 3, revBy: 'device-a',
    tags: ['tag'], contexts: ['home'], projectId: 'done-project', sectionId: 'done-section',
    description: 'Keep every byte of this note',
    checklist: [{ id: 'check-1', title: 'Keep this checklist item', isCompleted: true }],
    attachments: [{ id: 'attach-1', kind: 'file', title: 'proof.txt', uri: 'file:///owned/proof.txt',
        createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-01T12:00:00.000Z' }],
    recurrence: { rule: 'daily', strategy: 'strict', seriesId: TASK_ID },
    ...overrides,
});
const project = (overrides: Partial<Project> = {}): Project => ({
    id: 'done-project', title: 'Parent', status: 'active',
    createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-30T12:00:00.000Z',
    color: '#94a3b8', order: 0, tagIds: [], ...overrides,
});
const section: Section = {
    id: 'done-section', projectId: 'done-project', title: 'Section', order: 0,
    createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-30T12:00:00.000Z',
};
const removedArea: Area = { id: 'removed-area', name: 'Removed Area', order: 0,
    createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-30T12:00:00.000Z',
    deletedAt: '2026-09-30T12:00:00.000Z' };
const seed = (source: Task = task(), parent: Project = project(), areas: Area[] = []): Partial<AppData> => ({
    tasks: [source, task({ id: 'done-sibling', title: 'Sibling', recurrence: undefined,
        checklist: [], attachments: [] })],
    projects: [parent], sections: [section], areas, settings: { deviceId: 'device-a',
        analyticsProfileId: '00000000-0000-4000-8000-000000000178' },
});
const rows = () => {
    const state = useTaskStore.getState();
    return clone({ tasks: state._allTasks, projects: state._allProjects, sections: state._allSections,
        areas: state._allAreas, people: state._allPeople, settings: state.settings });
};
const request = () => ({ requestId: DELETE_ID, taskId: TASK_ID,
    taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get(TASK_ID)!), source: 'done' as const });

afterEach(async () => {
    await flushPendingSave();
    resetForTests();
    vi.useRealTimers();
});

describe('Done Task Delete and Undo use saved RN task policy', () => {
    it.each([
        ['recurring Done', task(), []],
        ['ordinary Done', task({ recurrence: undefined }), []],
        ['deleted Area link', task({ projectId: undefined, sectionId: undefined, areaId: removedArea.id }), [removedArea]],
    ])('matches RN deleteTask and restoreTask whole-data effects for %s', async (_name, source, areas) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const rn = await openSqliteHost(seed(source, project(), areas));
        let expectedDelete: ReturnType<typeof rows>;
        let expectedUndo: ReturnType<typeof rows>;
        try {
            expect((await useTaskStore.getState().deleteTask(TASK_ID)).success).toBe(true);
            await flushPendingSave();
            expectedDelete = rows();
            expect((await useTaskStore.getState().restoreTask(TASK_ID)).success).toBe(true);
            await flushPendingSave();
            expectedUndo = rows();
        } finally { await rn.close(); }

        const native = await openSqliteHost(seed(source, project(), areas));
        try {
            const saved = rows();
            const original = request();
            const prepared = value(native.host.prepareTaskDelete(original)).prepared;
            const deleted = { request: original, prepared };
            expect(value(await native.host.commitPreparedTaskDelete(deleted))).toEqual(prepared.result);
            expect(rows()).toEqual(expectedDelete);
            const undoRequest = { requestId: UNDO_ID, deleteRequestId: DELETE_ID };
            const undoPrepared = value(native.host.prepareTaskDeleteUndo({ request: undoRequest, delete: deleted })).prepared;
            const undo = { request: undoRequest, prepared: undoPrepared };
            expect(value(await native.host.commitPreparedTaskDeleteUndo(undo))).toEqual({ id: TASK_ID });
            expect(rows()).toEqual(expectedUndo);
            expect(rows().tasks[1]).toEqual(saved.tasks[1]);
            expect(rows().tasks[0]).toMatchObject({ status: 'done', completedAt: source.completedAt,
                description: source.description, attachments: source.attachments, checklist: source.checklist });
            expect(rows().tasks[0].recurrence).toEqual(saved.tasks[0].recurrence);
        } finally { await native.close(); }
    });

    it('binds Done status, saved revision and the RN archived-parent read-only rule', async () => {
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
            alternate.request.requestId = '00000000-0000-4000-8000-000000000179';
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
            const receipts = await sqlite.receiptIds();
            expect(value(sqlite.host.taskDeleteOutcome(envelope))).toEqual(prepared.result);
            expect(value(await sqlite.host.commitPreparedTaskDelete(envelope))).toEqual(prepared.result);
            expect(rows()).toEqual(later);
            expect(await sqlite.receiptIds()).toEqual(receipts);
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
            alternate.request.requestId = '00000000-0000-4000-8000-000000000179';
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
            const receipts = await sqlite.receiptIds();
            expect(value(sqlite.host.taskDeleteUndoOutcome(envelope))).toEqual({ id: TASK_ID });
            expect(value(await sqlite.host.commitPreparedTaskDeleteUndo(envelope))).toEqual({ id: TASK_ID });
            expect(rows()).toEqual(later);
            expect(await sqlite.receiptIds()).toEqual(receipts);
            expect(value(sqlite.host.taskDeleteUndoOutcome(alternate))).toBeNull();
        } finally { await sqlite.close(); }
    });

    it('rechecks the archived-parent read-only guard when the Project changes after prepare', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const original = request();
            const prepared = value(sqlite.host.prepareTaskDelete(original)).prepared;
            await sqlite.client().run('UPDATE projects SET status = ?, archivedAt = ?, rev = rev + 1, updatedAt = ? WHERE id = ?',
                ['archived', NOW, NOW, 'done-project']);
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
            const beforeDelete = await sqlite.sql('SELECT * FROM tasks ORDER BY id');
            expect(prepared.board.prepared.before.pushCount).toBe(0);
            expect(await sqlite.sql('SELECT pushCount FROM tasks WHERE id = ?', [TASK_ID])).toEqual([{ pushCount: null }]);
            const beforeReceipts = await sqlite.receiptIds();
            fault.commits = 10;
            expect(await sqlite.host.commitPreparedTaskDelete(deleted))
                .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await sqlite.sql('SELECT * FROM tasks ORDER BY id')).toEqual(beforeDelete);
            expect(await sqlite.receiptIds()).toEqual(beforeReceipts);
            fault.commits = 0;
            resetForTests();
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(useTaskStore.getState()._tasksById.get(TASK_ID)?.pushCount).toBeUndefined();
            expect(value(sqlite.host.taskDeleteOutcome(deleted))).toBeNull();
            value(await sqlite.host.commitPreparedTaskDelete(deleted));
            const undoRequest = { requestId: UNDO_ID, deleteRequestId: DELETE_ID };
            const undoPrepared = value(sqlite.host.prepareTaskDeleteUndo({ request: undoRequest, delete: deleted })).prepared;
            const undo = { request: undoRequest, prepared: undoPrepared };
            const beforeUndo = await sqlite.sql('SELECT * FROM tasks ORDER BY id');
            const beforeUndoReceipts = await sqlite.receiptIds();
            fault.commits = 10;
            expect(await sqlite.host.commitPreparedTaskDeleteUndo(undo))
                .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await sqlite.sql('SELECT * FROM tasks ORDER BY id')).toEqual(beforeUndo);
            expect(await sqlite.receiptIds()).toEqual(beforeUndoReceipts);
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
            const receipts = await sqlite.receiptIds();
            expect(await sqlite.host.commitPreparedTaskDelete({ request: original, prepared }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await sqlite.sql('SELECT * FROM tasks ORDER BY id')).toEqual(before);
            expect(await sqlite.receiptIds()).toEqual(receipts);
        } finally { await sqlite.close(); }
    });
});
