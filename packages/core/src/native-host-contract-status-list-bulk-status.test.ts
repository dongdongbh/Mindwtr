import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqliteHost as openHost } from './screen-parity.replay';
import { taskRevisionOf } from './native-request-receipts';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import * as logger from './logger';
import type { AppData, Task, TaskStatus } from './types';

const openSqliteHost: typeof openHost = (seed, wrap, bindings) => openHost(seed, wrap, bindings, { rejectConcurrentWrites: true });
const NOW = '2026-11-04T13:00:00.000Z';
const BEFORE = '2026-11-02T12:34:56.789Z';
const REQUEST_ID = '00000000-0000-4000-8000-000000001415';
const DEVICE = 'status-list-move-device';
type Sqlite = Awaited<ReturnType<typeof openSqliteHost>>;
const value = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`); return result.value;
};
const task = (id: string, fields: Partial<Task> = {}): Task => ({ id, title: `Task ${id}`, status: 'waiting',
    createdAt: BEFORE, updatedAt: BEFORE, tags: [], contexts: [], rev: 2, revBy: DEVICE, ...fields });
const seed = (): Partial<AppData> => ({
    tasks: [task('ann-1', { assignedTo: 'Ann' }), task('ann-2', { assignedTo: 'Ann', projectId: 'p1' }), task('bob', { assignedTo: 'Bob' }),
        task('idea', { status: 'someday', tags: ['#maybe'] }), task('plain', { status: 'someday' }), task('inbox-row', { status: 'inbox' })],
    projects: [{ id: 'p1', title: 'Parent', status: 'active', color: '#94a3b8', order: 0, tagIds: [], createdAt: BEFORE, updatedAt: BEFORE, rev: 1, revBy: DEVICE }],
    settings: { deviceId: DEVICE },
});
const revisions = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, taskRevisionOf(useTaskStore.getState()._tasksById.get(id)!)]));
const request = (source: 'waiting' | 'someday', status: TaskStatus, taskIds: string[], params: Record<string, unknown> = {}) => ({
    requestId: REQUEST_ID, source, taskIds, taskRevisions: revisions(taskIds), status, params,
}) as never;
const prepare = async (sqlite: Sqlite, input: never) => ({ request: input, prepared: value(await sqlite.host.prepareInboxTasksMove(input)).prepared }) as never;
const clock = () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); };
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Waiting and Someday bulk Move through the status-list move family', () => {
    it('selects only Waiting rows on screen for the chosen person and moves them durably', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const params = { person: 'Ann' };
            const bulk = value(sqlite.host.getBulkActions({ list: 'waiting', params, taskIds: ['ann-1', 'bob'], selectionEdit: { taskId: 'ann-2' } }));
            expect(bulk.selectedIds).toEqual(['ann-1', 'ann-2']);
            expect(bulk.bar.statuses.map((status) => status.status)).not.toContain('waiting');
            const log = vi.spyOn(logger, 'logInfo');
            const command = await prepare(sqlite, request('waiting', 'next', bulk.selectedIds, params));
            expect(value(await sqlite.host.commitPreparedInboxTasksMove(command))).toEqual({ count: 2, status: 'next' });
            expect(['ann-1', 'ann-2', 'bob'].map((id) => useTaskStore.getState()._tasksById.get(id)?.status)).toEqual(['next', 'next', 'waiting']);
            expect(value(sqlite.host.inboxTasksMoveOutcome(command))).toEqual({ count: 2, status: 'next' });
            expect(log).toHaveBeenCalledWith('Native Waiting bulk status confirmed', expect.objectContaining({ force: true,
                context: { releaseCheck: 'v1.3.8/ios-status-list-bulk-status', count: 2, status: 'next', outcome: 'moved' } }));
            expect(await sqlite.receiptIds()).toEqual([REQUEST_ID]);
        } finally { await sqlite.close(); }
    });

    it('refuses a Waiting row hidden by the person filter, its own status and foreign params', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const hidden = await sqlite.host.prepareInboxTasksMove(request('waiting', 'next', ['bob'], { person: 'Ann' }));
            expect(hidden).toMatchObject({ ok: false, error: { code: 'STALE_REVISION', message: expect.stringContaining('Waiting') } });
            for (const invalid of [request('waiting', 'waiting', ['ann-1']), request('waiting', 'next', ['ann-1'], { groupBy: 'none' }),
                request('waiting', 'next', ['ann-1'], { person: 7 }), request('someday', 'next', ['ann-1'], { person: 'Ann' })]) {
                expect(await sqlite.host.prepareInboxTasksMove(invalid)).toMatchObject({ ok: false });
            }
            expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('moves only filtered Someday rows and refuses a stale Someday selection at commit', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const params = { filters: { tokens: ['#maybe'] } };
            const view = value(sqlite.host.getSomedayView({ offset: 0, limit: 100, ...params }));
            const filters = view.filters.state;
            const bulk = value(sqlite.host.getBulkActions({ list: 'someday', params: { filters }, taskIds: ['idea', 'plain'] }));
            expect(bulk.selectedIds).toEqual(['idea']);
            expect(await sqlite.host.prepareInboxTasksMove(request('someday', 'next', ['plain'], { filters })))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            const command = await prepare(sqlite, request('someday', 'reference', ['idea'], { filters }));
            await sqlite.client().run("UPDATE tasks SET title = 'Changed' WHERE id = 'idea'");
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(await sqlite.host.commitPreparedInboxTasksMove(command)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            const fresh = await prepare(sqlite, request('someday', 'reference', ['idea'], { filters }));
            expect(value(await sqlite.host.commitPreparedInboxTasksMove(fresh))).toEqual({ count: 1, status: 'reference' });
            expect(useTaskStore.getState()._tasksById.get('idea')?.status).toBe('reference');
            expect(useTaskStore.getState()._tasksById.get('plain')?.status).toBe('someday');
        } finally { await sqlite.close(); }
    });

    it('keeps the Inbox Remove tag family closed and the Inbox move family exact', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const selection = { requestId: REQUEST_ID, taskIds: ['ann-1'], taskRevisions: revisions(['ann-1']), params: {} };
            expect(await sqlite.host.prepareInboxTasksAddTag({ ...selection, source: 'waiting', tag: '#x', params: { groupBy: 'none' } } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await sqlite.host.prepareInboxTasksRemoveTag({ ...selection, source: 'someday', tags: ['#x'] } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await sqlite.host.prepareInboxTasksMove({ ...selection, source: 'inbox', status: 'next' } as never)).toMatchObject({ ok: false });
            expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('deletes Waiting and Someday selections with an exact Undo through the archive delete family', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const log = vi.spyOn(logger, 'logInfo');
            for (const [source, ids] of [['waiting', ['ann-1', 'bob']], ['someday', ['idea']]] as const) {
                const input = { requestId: source === 'waiting' ? REQUEST_ID : '00000000-0000-4000-8000-000000001416', taskIds: [...ids], taskRevisions: revisions([...ids]), source };
                const deletion = { request: input, prepared: value(await sqlite.host.prepareArchivedTasksDelete(input as never)).prepared } as never;
                const result = value(await sqlite.host.commitPreparedArchivedTasksDelete(deletion)) as { count: number; deletion: { undoEnabled: boolean } };
                expect(result.count).toBe(ids.length); expect(result.deletion.undoEnabled).toBe(true);
                for (const id of ids) expect(useTaskStore.getState()._tasksById.get(id)?.deletedAt).toBeTruthy();
                expect(log).toHaveBeenCalledWith(`Native ${source === 'waiting' ? 'Waiting' : 'Someday'} bulk Trash confirmed`, expect.objectContaining({ force: true,
                    context: { releaseCheck: 'v1.3.8/ios-status-list-bulk-trash', count: ids.length, outcome: 'deleted' } }));
                const undoRequest = { requestId: source === 'waiting' ? '00000000-0000-4000-8000-000000001417' : '00000000-0000-4000-8000-000000001418', deleteRequestId: input.requestId };
                const undo = { request: undoRequest, prepared: value(await sqlite.host.prepareArchivedTasksDeleteUndo({ request: undoRequest, delete: deletion } as never)).prepared } as never;
                expect(value(await sqlite.host.commitPreparedArchivedTasksDeleteUndo(undo))).toEqual({ count: ids.length });
                for (const id of ids) expect(useTaskStore.getState()._tasksById.get(id)?.deletedAt).toBeFalsy();
            }
        } finally { await sqlite.close(); }
    });

    it('refuses a Waiting delete for a row of another status or a stale revision', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const wrongStatus = { requestId: REQUEST_ID, taskIds: ['idea'], taskRevisions: revisions(['idea']), source: 'waiting' };
            expect(await sqlite.host.prepareArchivedTasksDelete(wrongStatus as never)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            const stale = { requestId: REQUEST_ID, taskIds: ['bob'], taskRevisions: { bob: 'stale' }, source: 'waiting' };
            expect(await sqlite.host.prepareArchivedTasksDelete(stale as never)).toMatchObject({ ok: false });
            expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('adds a tag to Waiting and Someday selections through the Inbox tag family and keeps Remove tag closed', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const log = vi.spyOn(logger, 'logInfo');
            const input = { requestId: REQUEST_ID, source: 'waiting', taskIds: ['ann-1', 'ann-2'], taskRevisions: revisions(['ann-1', 'ann-2']), tag: '#call', params: { person: 'Ann' } };
            const command = { request: input, prepared: (value(await sqlite.host.prepareInboxTasksAddTag(input as never)) as { prepared: unknown }).prepared } as never;
            expect(value(await sqlite.host.commitPreparedInboxTasksAddTag(command))).toEqual({ count: 2, changed: true });
            expect(useTaskStore.getState()._tasksById.get('ann-1')?.tags).toContain('#call');
            expect(log).toHaveBeenCalledWith('Native Waiting bulk tag confirmed', expect.objectContaining({ force: true,
                context: { releaseCheck: 'v1.3.8/ios-status-list-bulk-tag', count: 2, outcome: 'added' } }));
            const hidden = { ...input, requestId: '00000000-0000-4000-8000-000000001419', taskIds: ['bob'], taskRevisions: revisions(['bob']) };
            expect(await sqlite.host.prepareInboxTasksAddTag(hidden as never)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            const someday = { requestId: '00000000-0000-4000-8000-000000001420', source: 'someday', taskIds: ['idea'], taskRevisions: revisions(['idea']), tag: '#maybe', params: {} };
            expect(value(await sqlite.host.prepareInboxTasksAddTag(someday as never))).toEqual({ kind: 'noop', result: { count: 0, changed: false } });
            const remove = { requestId: '00000000-0000-4000-8000-000000001421', source: 'someday', taskIds: ['idea'], taskRevisions: revisions(['idea']), tags: ['#maybe'], params: {} };
            expect(await sqlite.host.prepareInboxTasksRemoveTag(remove as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        } finally { await sqlite.close(); }
    });
});
