import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqliteHost, value } from './screen-parity.replay';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import type { AppData } from './types';

const NOW = '2026-11-03T13:00:00.000Z';
const ID = '00000000-0000-4000-8000-000000000192';
const seed = (): Partial<AppData> => ({ tasks: [], projects: [{ id: 'project', title: 'Project', status: 'active', order: 0,
    color: '#94a3b8', tagIds: [], createdAt: NOW, updatedAt: NOW, rev: 1, revBy: 'device-a' }],
    settings: { deviceId: 'device-a' } });
type Sqlite = Awaited<ReturnType<typeof openSqliteHost>>;
const prepare = async (sqlite: Sqlite, title = 'Next step @home') => {
    const options = value(await sqlite.host.getWeeklyReviewProjectTaskOptions({ projectId: 'project' }));
    const request = { requestId: ID, projectId: options.projectId, projectRevision: options.projectRevision, title, openAfterSave: true };
    const prepared = value(await sqlite.host.prepareWeeklyReviewProjectTask(request)).prepared;
    return { request, prepared };
};
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Weekly Review project task prepared adapter', () => {
    it('reads without writing, freezes project grammar and creates one Next action', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const before = await sqlite.sql('SELECT * FROM tasks');
            const envelope = await prepare(sqlite);
            expect(await sqlite.sql('SELECT * FROM tasks')).toEqual(before);
            expect(envelope.prepared.operation.task).toMatchObject({ id: ID, status: 'next', projectId: 'project', title: 'Next step' });
            expect(value(await sqlite.host.commitPreparedWeeklyReviewProjectTask(envelope))).toEqual({ taskId: ID, title: 'Next step', openAfterSave: true });
            expect(useTaskStore.getState()._allTasks.filter((t) => t.id === ID)).toHaveLength(1);
            expect(await sqlite.receiptIds()).toEqual([ID]);
        } finally { await sqlite.close(); }
    });

    it('returns the durable reply after restart and subsequent task and parent edits without rewriting them', async () => {
        const sqlite = await openSqliteHost(seed());
        try {
            const envelope = await prepare(sqlite, 'Keep unknown +NeverCreated');
            value(await sqlite.host.commitPreparedWeeklyReviewProjectTask(envelope));
            expect(useTaskStore.getState()._allProjects).toHaveLength(1);
            await useTaskStore.getState().updateTask(ID, { title: 'Later edit' });
            await useTaskStore.getState().updateProject('project', { title: 'Renamed later' });
            await flushPendingSave();
            const replayed = await sqlite.replay((host) => host.commitPreparedWeeklyReviewProjectTask(envelope));
            expect(value(replayed.result)).toEqual(envelope.prepared.result);
            expect(replayed.wrote).toBe(false); expect(replayed.receipts).toBe(false);
            expect(useTaskStore.getState()._tasksById.get(ID)?.title).toBe('Later edit');
        } finally { await sqlite.close(); }
    });

    it('rejects stale parent and coherent forged task before writing', async () => {
        const sqlite = await openSqliteHost(seed());
        try {
            const envelope = await prepare(sqlite);
            const altered = structuredClone(envelope);
            altered.prepared.operation.task.title = 'Forged';
            altered.prepared.result.title = 'Forged';
            expect(sqlite.host.validatePreparedWeeklyReviewProjectTask(altered)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await sqlite.host.commitPreparedWeeklyReviewProjectTask(altered)).toMatchObject({ ok: false });
            await useTaskStore.getState().updateProject('project', { title: 'Changed' }); await flushPendingSave();
            expect(await sqlite.host.commitPreparedWeeklyReviewProjectTask(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await sqlite.sql('SELECT * FROM tasks')).toEqual([]); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('refuses a deleted source project without task or receipt writes', async () => {
        const sqlite = await openSqliteHost(seed());
        try {
            const envelope = await prepare(sqlite);
            await useTaskStore.getState().deleteProject('project'); await flushPendingSave();
            expect(await sqlite.host.getWeeklyReviewProjectTaskOptions({ projectId: 'project' })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await sqlite.host.commitPreparedWeeklyReviewProjectTask(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await sqlite.sql('SELECT * FROM tasks')).toEqual([]); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('does not reserve a landed receipt when the prewrite durable read fails', async () => {
        let fault = false;
        const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, all: async (...args) => {
            if (fault && args[0].startsWith('SELECT')) throw new Error('Owned prewrite read failure');
            return client.all(...args);
        } }));
        try {
            const envelope = await prepare(sqlite);
            fault = true;
            expect(await sqlite.host.commitPreparedWeeklyReviewProjectTask(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            fault = false;
            expect(value(sqlite.host.weeklyReviewProjectTaskOutcome(envelope))).toBeNull();
            expect(await sqlite.sql('SELECT * FROM tasks')).toEqual([]); expect(await sqlite.receiptIds()).toEqual([]);
            expect(value(await sqlite.host.commitPreparedWeeklyReviewProjectTask(envelope))).toEqual(envelope.prepared.result);
            expect(await sqlite.receiptIds()).toEqual([ID]);
        } finally { fault = false; await sqlite.close(); }
    });

    it('retains exact frozen creation through failed COMMIT and cold retry', async () => {
        const fault = { commits: 0 };
        const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('Owned Review task COMMIT failure'); }
            return client.run(sql, params);
        } }));
        try {
            const envelope = await prepare(sqlite, 'Frozen /due:2030-07-21');
            fault.commits = 10;
            expect(await sqlite.host.commitPreparedWeeklyReviewProjectTask(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await sqlite.sql('SELECT * FROM tasks')).toEqual([]);
            fault.commits = 0; resetForTests(); const reopened = await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(await reopened.commitPreparedWeeklyReviewProjectTask(envelope))).toEqual(envelope.prepared.result);
            expect(useTaskStore.getState()._tasksById.get(ID)).toMatchObject(envelope.prepared.operation.task);
            expect(await sqlite.receiptIds()).toEqual([ID]);
        } finally { fault.commits = 0; await sqlite.close(); }
    });
});
