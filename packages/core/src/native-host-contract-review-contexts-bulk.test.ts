import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqliteHost as openHost } from './screen-parity.replay';
import { taskRevisionOf } from './native-request-receipts';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import * as logger from './logger';
import type { AppData, Task } from './types';

const openSqliteHost: typeof openHost = (seed, wrap, bindings) => openHost(seed, wrap, bindings, { rejectConcurrentWrites: true });
const NOW = '2026-11-04T13:00:00.000Z';
const BEFORE = '2026-11-02T12:34:56.789Z';
const DEVICE = 'review-contexts-device';
const value = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`); return result.value;
};
const task = (id: string, fields: Partial<Task> = {}): Task => ({ id, title: `Task ${id}`, status: 'next',
    createdAt: BEFORE, updatedAt: BEFORE, tags: [], contexts: [], rev: 2, revBy: DEVICE, ...fields });
const seed = (): Partial<AppData> => ({
    tasks: [task('home-1', { contexts: ['@home'], projectId: 'p1' }), task('home-2', { contexts: ['@home'], status: 'waiting' }),
        task('work', { contexts: ['@work'], projectId: 'p1' }), task('later', { status: 'someday', projectId: 'p2' })],
    projects: [{ id: 'p1', title: 'Garden', status: 'active', color: '#94a3b8', order: 0, tagIds: [], createdAt: BEFORE, updatedAt: BEFORE, rev: 1, revBy: DEVICE },
        { id: 'p2', title: 'Shed', status: 'active', color: '#94a3b8', order: 1, tagIds: [], createdAt: BEFORE, updatedAt: BEFORE, rev: 1, revBy: DEVICE }],
    settings: { deviceId: DEVICE },
});
const revisions = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, taskRevisionOf(useTaskStore.getState()._tasksById.get(id)!)]));
const id = (n: number) => `00000000-0000-4000-8000-0000000019${String(n).padStart(2, '0')}`;
const REVIEW = { scope: 'all', expandedAreaIds: ['area:none'], expandedProjectIds: ['project:p1', 'project:p2', 'single:area:none'], expandedLaterProjectIds: [] };
const CONTEXTS_FILTERS = { searchQuery: '', tokens: [], excludedTokens: [], projects: [], priorities: [], energyLevels: [], timeEstimates: [], location: '', contextMatchMode: 'all', tagMatchMode: 'all' };
const CONTEXTS = { tokens: ['@home'], matchMode: 'all', searchQuery: '', filters: CONTEXTS_FILTERS, savedFilterId: null };
const clock = () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); };
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Review and Contexts bulk selection through the shared bulk read and status-list families', () => {
    it('selects drawn Review rows, offers every status and the share text, and moves them durably', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const bulk = value(sqlite.host.getBulkActions({ list: 'review', params: REVIEW, taskIds: ['home-1'], selectionEdit: { taskId: 'later' } }));
            expect(bulk.selectedIds).toEqual(['home-1', 'later']);
            expect(bulk.bar.statuses.map((status) => status.status)).toEqual(['inbox', 'next', 'waiting', 'someday', 'done', 'reference']);
            expect([bulk.bar.organize, bulk.bar.removeTag, bulk.removeTag, bulk.moveToSection]).toEqual([null, null, null, null]);
            expect(bulk.shareText).toContain('Task home-1');
            expect(value(sqlite.host.getBulkActions({ list: 'waiting', params: {}, taskIds: [] })).shareText).toBeUndefined();
            const log = vi.spyOn(logger, 'logInfo');
            const input = { requestId: id(1), source: 'review', taskIds: bulk.selectedIds, taskRevisions: revisions(bulk.selectedIds), status: 'reference', params: REVIEW };
            const command = { request: input, prepared: value(await sqlite.host.prepareInboxTasksMove(input as never)).prepared } as never;
            expect(value(await sqlite.host.commitPreparedInboxTasksMove(command))).toEqual({ count: 2, status: 'reference' });
            expect(['home-1', 'later', 'work'].map((row) => useTaskStore.getState()._tasksById.get(row)?.status)).toEqual(['reference', 'reference', 'next']);
            expect(log).toHaveBeenCalledWith('Native Review bulk status confirmed', expect.objectContaining({ force: true,
                context: { releaseCheck: 'v1.3.8/ios-status-list-bulk-status', count: 2, status: 'reference', outcome: 'moved' } }));
        } finally { await sqlite.close(); }
    });

    it('refuses a Review row its folded project hides, and foreign Review params', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const folded = { ...REVIEW, expandedProjectIds: ['project:p1'] };
            expect(value(sqlite.host.getBulkActions({ list: 'review', params: folded, taskIds: ['home-1', 'later'] })).selectedIds).toEqual(['home-1']);
            const hidden = { requestId: id(2), source: 'review', taskIds: ['later'], taskRevisions: revisions(['later']), status: 'next', params: folded };
            expect(await sqlite.host.prepareInboxTasksMove(hidden as never)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION', message: expect.stringContaining('Review') } });
            expect(await sqlite.host.prepareInboxTasksMove({ ...hidden, params: { ...REVIEW, person: 'Ann' } } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(sqlite.host.getBulkActions({ list: 'review', params: { ...REVIEW, person: 'Ann' }, taskIds: [] })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('selects only Contexts rows the token selection shows and moves, tags, deletes and restores them', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const bulk = value(sqlite.host.getBulkActions({ list: 'contexts', params: CONTEXTS, taskIds: ['home-1', 'work'], selectionEdit: { taskId: 'home-2' } }));
            expect(bulk.selectedIds).toEqual(['home-1', 'home-2']);
            expect(sqlite.host.getBulkActions({ list: 'contexts', params: CONTEXTS, selectionEdit: { taskId: 'work' } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            const hidden = { requestId: id(3), source: 'contexts', taskIds: ['work'], taskRevisions: revisions(['work']), status: 'someday', params: CONTEXTS };
            expect(await sqlite.host.prepareInboxTasksMove(hidden as never)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION', message: expect.stringContaining('Contexts') } });
            const log = vi.spyOn(logger, 'logInfo');
            const tag = { requestId: id(4), source: 'contexts', taskIds: ['home-1', 'home-2'], taskRevisions: revisions(['home-1', 'home-2']), tag: '#errand', params: CONTEXTS };
            const tagged = { request: tag, prepared: (value(await sqlite.host.prepareInboxTasksAddTag(tag as never)) as { prepared: unknown }).prepared } as never;
            expect(value(await sqlite.host.commitPreparedInboxTasksAddTag(tagged))).toEqual({ count: 2, changed: true });
            expect(useTaskStore.getState()._tasksById.get('home-2')?.tags).toContain('#errand');
            expect(log).toHaveBeenCalledWith('Native Contexts bulk tag confirmed', expect.objectContaining({ force: true,
                context: { releaseCheck: 'v1.3.8/ios-status-list-bulk-tag', count: 2, outcome: 'added' } }));
            const move = { requestId: id(5), source: 'contexts', taskIds: ['home-1', 'home-2'], taskRevisions: revisions(['home-1', 'home-2']), status: 'someday', params: CONTEXTS };
            const moved = { request: move, prepared: value(await sqlite.host.prepareInboxTasksMove(move as never)).prepared } as never;
            expect(value(await sqlite.host.commitPreparedInboxTasksMove(moved))).toEqual({ count: 2, status: 'someday' });
            const remove = { requestId: id(6), source: 'contexts', taskIds: ['home-1'], taskRevisions: revisions(['home-1']), params: CONTEXTS };
            const deletion = { request: remove, prepared: value(await sqlite.host.prepareArchivedTasksDelete(remove as never)).prepared } as never;
            expect((value(await sqlite.host.commitPreparedArchivedTasksDelete(deletion)) as { count: number }).count).toBe(1);
            expect(useTaskStore.getState()._tasksById.get('home-1')?.deletedAt).toBeTruthy();
            expect(log).toHaveBeenCalledWith('Native Contexts bulk Trash confirmed', expect.objectContaining({ force: true,
                context: { releaseCheck: 'v1.3.8/ios-status-list-bulk-trash', count: 1, outcome: 'deleted' } }));
            const undoRequest = { requestId: id(7), deleteRequestId: remove.requestId };
            const undo = { request: undoRequest, prepared: value(await sqlite.host.prepareArchivedTasksDeleteUndo({ request: undoRequest, delete: deletion } as never)).prepared } as never;
            expect(value(await sqlite.host.commitPreparedArchivedTasksDeleteUndo(undo))).toEqual({ count: 1 });
            expect(useTaskStore.getState()._tasksById.get('home-1')?.deletedAt).toBeFalsy();
        } finally { await sqlite.close(); }
    });

    it('refuses a hidden Contexts delete, a delete without view params, and Review Remove tag', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const hidden = { requestId: id(8), source: 'contexts', taskIds: ['work'], taskRevisions: revisions(['work']), params: CONTEXTS };
            expect(await sqlite.host.prepareArchivedTasksDelete(hidden as never)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            const bare = { requestId: id(9), source: 'review', taskIds: ['home-1'], taskRevisions: revisions(['home-1']) };
            expect(await sqlite.host.prepareArchivedTasksDelete(bare as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            const removeTag = { requestId: id(10), source: 'review', taskIds: ['home-1'], taskRevisions: revisions(['home-1']), tags: ['#x'], params: REVIEW };
            expect(await sqlite.host.prepareInboxTasksRemoveTag(removeTag as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(sqlite.host.getBulkActions({ list: 'review', params: REVIEW, taskIds: ['home-1'], picker: { kind: 'removeTag' } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });
});
