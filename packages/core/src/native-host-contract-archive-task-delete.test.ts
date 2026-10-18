import { afterEach, describe, expect, it, vi, onTestFinished } from 'vitest';
import { openSqliteHost } from './screen-parity.replay';
import { taskRevisionOf } from './native-request-receipts';
import { flushPendingSave, resetForTests, useTaskStore, setSaveRetrySleepForTests } from './store';
import type { AppData, Project, Section, Task } from './types';

const NOW = '2026-10-02T13:00:00.000Z';
const DELETE_ID = '00000000-0000-4000-8000-000000000174';
const TASK_ID = 'archive-task';
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const value = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const task = (overrides: Partial<Task> = {}): Task => ({
    id: TASK_ID, title: 'Archived source', status: 'archived',
    createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-30T12:00:00.000Z',
    archivedAt: '2026-09-30T12:00:00.000Z', rev: 3, revBy: 'device-a',
    tags: [], contexts: [], projectId: 'archive-project', sectionId: 'archive-section',
    description: 'Keep every byte of this note',
    checklist: [{ id: 'check-1', title: 'Keep this checklist item', isCompleted: true }],
    attachments: [{ id: 'attach-1', kind: 'file', title: 'proof.txt', uri: 'file:///owned/proof.txt',
        createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-01T12:00:00.000Z' }],
    recurrence: { rule: 'daily', strategy: 'strict', seriesId: TASK_ID },
    ...overrides,
});
const project: Project = {
    id: 'archive-project', title: 'Archived parent', status: 'archived',
    createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-30T12:00:00.000Z',
    archivedAt: '2026-09-30T12:00:00.000Z', color: '#94a3b8', order: 0, tagIds: [],
};
const section: Section = {
    id: 'archive-section', projectId: project.id, title: 'Archived section', order: 0,
    createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-30T12:00:00.000Z',
};
const seed = (source: Task = task()): Partial<AppData> => ({
    tasks: [source, task({ id: 'archive-sibling', title: 'Sibling', recurrence: undefined,
        checklist: [], attachments: [] })],
    projects: [project], sections: [section], settings: { deviceId: 'device-a',
        analyticsProfileId: '00000000-0000-4000-8000-000000000175' },
});
const rows = () => {
    const state = useTaskStore.getState();
    return clone({ tasks: state._allTasks, projects: state._allProjects, sections: state._allSections,
        areas: state._allAreas, people: state._allPeople, settings: state.settings });
};
const request = () => ({ requestId: DELETE_ID, taskId: TASK_ID,
    taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get(TASK_ID)!), source: 'archive' as const });

afterEach(async () => {
    await flushPendingSave();
    resetForTests();
    vi.useRealTimers();
});

describe('Archive Task Delete through the prepared Task Delete writer', () => {
    it.each([
        ['archived parent', task()],
        ['cancelled archived task', task({ cancelledAt: '2026-09-30T12:00:00.000Z' })],
        ['independent archived task', task({ projectId: undefined, sectionId: undefined })],
    ])('matches the RN deleteTask whole-data effect for %s', async (_name, source) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const rn = await openSqliteHost(seed(source));
        let expected: ReturnType<typeof rows>;
        try {
            expect((await useTaskStore.getState().deleteTask(TASK_ID)).success).toBe(true);
            await flushPendingSave();
            expected = rows();
        } finally { await rn.close(); }

        const native = await openSqliteHost(seed(source));
        try {
            const saved = clone(rows());
            const prepared = value(native.host.prepareTaskDelete(request())).prepared;
            expect(prepared.board.prepared.before.status).toBe('archived');
            expect(value(await native.host.commitPreparedTaskDelete({ request: prepared.request, prepared })))
                .toEqual(prepared.result);
            expect(rows()).toEqual(expected);
            expect(rows().projects).toEqual(saved.projects);
            expect(rows().sections).toEqual(saved.sections);
            expect(rows().tasks[1]).toEqual(saved.tasks[1]);
            expect(rows().tasks[0]).toMatchObject({ status: 'archived', description: 'Keep every byte of this note',
                attachments: saved.tasks[0].attachments, recurrence: saved.tasks[0].recurrence });
        } finally { await native.close(); }
    });

    it('refuses wrong source, non-archived and tombstoned rows, and forged archive proof', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const valid = request();
            expect(sqlite.host.prepareTaskDelete({ ...valid, source: 'other' as never }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(sqlite.host.prepareTaskDelete({ ...valid, source: undefined }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            const prepared = value(sqlite.host.prepareTaskDelete(valid)).prepared;
            const envelope = { request: valid, prepared };
            expect(value(sqlite.host.validatePreparedTaskDelete(envelope))).toEqual(prepared.result);
            const forged = clone(envelope);
            forged.prepared.board.prepared.before.status = 'next';
            forged.prepared.board.prepared.after.status = 'next';
            expect(sqlite.host.validatePreparedTaskDelete(forged))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            const nested = clone(envelope);
            nested.prepared.board.request.action.taskId = 'other-task';
            expect(sqlite.host.validatePreparedTaskDelete(nested))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            const before = rows();
            expect(await sqlite.host.commitPreparedTaskDelete(forged))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(rows()).toEqual(before);
        } finally { await sqlite.close(); }
        for (const bad of [task({ status: 'next' }), task({ status: 'reference' }),
            task({ deletedAt: NOW }), task({ purgedAt: NOW })]) {
            const next = await openSqliteHost(seed(bad));
            try {
                expect(next.host.prepareTaskDelete(request()))
                    .toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
                expect(next.host.prepareTaskDelete({ ...request(), taskId: `${TASK_ID}:projected-recurrence` }))
                    .toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
            } finally { await next.close(); }
        }
    });

    it('requires the exact saved before row and a UUID-bound durable receipt, even after later edits', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const original = request();
            const prepared = value(sqlite.host.prepareTaskDelete(original)).prepared;
            const envelope = { request: original, prepared };
            expect(value(sqlite.host.taskDeleteOutcome(envelope))).toBeNull();
            const alternate = clone(envelope);
            alternate.request.requestId = '00000000-0000-4000-8000-000000000176';
            alternate.prepared.request.requestId = alternate.request.requestId;
            alternate.prepared.board.request.requestId = alternate.request.requestId;
            alternate.prepared.board.prepared.request.requestId = alternate.request.requestId;
            expect(value(sqlite.host.validatePreparedTaskDelete(alternate))).toEqual(prepared.result);

            expect(value(await sqlite.host.commitPreparedTaskDelete(envelope))).toEqual(prepared.result);
            expect(value(sqlite.host.taskDeleteOutcome(envelope))).toEqual(prepared.result);
            expect(value(sqlite.host.taskDeleteOutcome(alternate))).toBeNull();
            const afterDelete = rows();
            expect(await sqlite.host.commitPreparedTaskDelete(alternate))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(rows()).toEqual(afterDelete);
            await sqlite.client().run('UPDATE tasks SET description = ?, rev = rev + 1, updatedAt = ? WHERE id = ?',
                ['Edited later in Trash', '2026-10-02T13:00:01.000Z', TASK_ID]);
            await sqlite.restart();
            const beforeReplay = rows();
            const receipts = await sqlite.receiptIds();
            expect(value(sqlite.host.taskDeleteOutcome(envelope))).toEqual(prepared.result);
            expect(value(await sqlite.host.commitPreparedTaskDelete(envelope))).toEqual(prepared.result);
            expect(rows()).toEqual(beforeReplay);
            expect(await sqlite.receiptIds()).toEqual(receipts);
            expect(useTaskStore.getState()._tasksById.get(TASK_ID)?.description).toBe('Edited later in Trash');
            const forged = clone(envelope);
            forged.prepared.result.deletion.message = 'Another notification';
            expect(sqlite.host.taskDeleteOutcome(forged))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        } finally { await sqlite.close(); }
    });

    it('rejects a saved-row edit after confirmation without deleting the newer content', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const original = request();
            const prepared = value(sqlite.host.prepareTaskDelete(original)).prepared;
            await sqlite.client().run('UPDATE tasks SET title = ?, rev = rev + 1, updatedAt = ? WHERE id = ?',
                ['Newer title', '2026-10-02T13:00:01.000Z', TASK_ID]);
            await sqlite.restart();
            const newer = rows();
            expect(await sqlite.host.commitPreparedTaskDelete({ request: original, prepared }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(rows()).toEqual(newer);
            expect(value(sqlite.host.taskDeleteOutcome({ request: original, prepared }))).toBeNull();
        } finally { await sqlite.close(); }
    });

    it('cold-retries a failed SQLite COMMIT without a partial Task or receipt', async () => {
        // The store's retry waits are recorded (vitest.setup.ts skips them in every test): the schedule stays 250, 500, 1000, 2000 ms.
        const retryWaits: number[] = [];
        setSaveRetrySleepForTests(async (ms) => { retryWaits.push(ms); });
        onTestFinished(() => setSaveRetrySleepForTests(null));
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
        const fault = { commits: 0 };
        const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('injected commit failure'); }
            return client.run(sql, params);
        } }));
        try {
            const original = request();
            const prepared = value(sqlite.host.prepareTaskDelete(original)).prepared;
            const before = await sqlite.sql('SELECT * FROM tasks ORDER BY id');
            const receiptIds = await sqlite.receiptIds();
            fault.commits = 10;
            expect(await sqlite.host.commitPreparedTaskDelete({ request: original, prepared }))
                .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(retryWaits).toEqual([250, 500, 1000, 2000]);
            expect(await sqlite.sql('SELECT * FROM tasks ORDER BY id')).toEqual(before);
            expect(await sqlite.receiptIds()).toEqual(receiptIds);
            fault.commits = 0;
            resetForTests();
            await sqlite.restart();
            expect(value(sqlite.host.taskDeleteOutcome({ request: original, prepared }))).toBeNull();
            expect(value(await sqlite.host.commitPreparedTaskDelete({ request: original, prepared }))).toEqual(prepared.result);
            expect(useTaskStore.getState()._tasksById.get(TASK_ID)?.deletedAt).toBe(NOW);
            await sqlite.restart();
            expect(value(sqlite.host.taskDeleteOutcome({ request: original, prepared }))).toEqual(prepared.result);
        } finally { await sqlite.close(); }
    });
});
