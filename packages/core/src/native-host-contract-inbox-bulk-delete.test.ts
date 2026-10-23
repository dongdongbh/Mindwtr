import { afterEach, describe, expect, it, vi } from 'vitest';
import { createArchivedTasksDeleteMethods, type NativeArchivedTasksDeleteEnvelope } from './native-host-contract-archive-bulk-delete';
import { buildSaveSnapshot } from './store-helpers';
import { taskRevisionOf } from './native-request-receipts';
import { openSqliteHost } from './screen-parity.replay';
import { flushPendingSave, getStorageAdapter, resetForTests, useTaskStore } from './store';
import type { Task } from './types';
import { deterministicHash128 } from './uuid';
import { getProjectedRecurringTaskId } from './recurrence';

const NOW = '2026-10-03T13:00:00.000Z';
const BEFORE = '2026-09-30T12:34:56.789Z';
const DEVICE = 'inbox-delete-device';
const DELETE_ID = '00000000-0000-4000-8000-000000000739';
const UNDO_ID = '00000000-0000-4000-8000-000000000740';
const source = (id = 'source', fields: Partial<Task> = {}): Task => ({ id, title: 'Retained fixture', status: 'inbox',
    createdAt: BEFORE, updatedAt: BEFORE, tags: [], contexts: [], rev: 3, revBy: DEVICE, ...fields });
const seed = () => ({ tasks: [source('rich', { projectId: 'parent-a', sectionId: 'section',
    recurrence: { rule: 'weekly', strategy: 'strict', seriesId: 'series', weekdays: [1, 3] }, dueDate: '2026-10-12', reviewAt: '2026-10-09',
    timeSpentMinutes: 45, checklist: [{ id: 'step', title: 'Step', isCompleted: true }],
    attachments: [{ id: 'link', kind: 'link', title: 'Fixture', uri: 'https://example.com', createdAt: BEFORE, updatedAt: BEFORE }] }),
source('source', { projectId: 'parent-b' }), source('sibling')],
projects: ['parent-a', 'parent-b'].map((id) => ({ id, title: 'Parent', status: 'active' as const, color: '#94a3b8', order: 0,
    tagIds: [], createdAt: BEFORE, updatedAt: BEFORE, rev: 2, revBy: DEVICE })),
sections: [{ id: 'section', projectId: 'parent-a', title: 'Section', order: 0, createdAt: BEFORE, updatedAt: BEFORE }],
areas: [], people: [], settings: { deviceId: DEVICE, analyticsProfileId: DELETE_ID } });
const clone = <T>(item: T): T => JSON.parse(JSON.stringify(item)) as T;
const value = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`); return result.value;
};
const methods = () => createArchivedTasksDeleteMethods({ readiness: () => ({ ok: true, value: null }),
    t: () => (key: string) => key, save: async () => {
        try { await flushPendingSave(); } catch { return { ok: false, error: { code: 'SAVE_FAILED', message: 'Injected failure' } }; }
        return useTaskStore.getState().persistenceFailure
            ? { ok: false, error: { code: 'SAVE_FAILED', message: 'Unresolved failure' } } : { ok: true, value: null };
    } });
const request = (taskIds = ['source'], requestId = DELETE_ID) => ({ requestId, source: 'inbox' as const, taskIds,
    taskRevisions: Object.fromEntries(taskIds.map((id) => [id, taskRevisionOf(useTaskStore.getState()._tasksById.get(id)!)])) });
const prepare = async (host = methods(), input = request()) => ({ request: input, prepared: value(await host.prepareArchivedTasksDelete(input)).prepared });
const prepareUndo = async (host: ReturnType<typeof methods>, deletion: NativeArchivedTasksDeleteEnvelope, requestId = UNDO_ID) => {
    const input = { requestId, deleteRequestId: deletion.request.requestId };
    return { request: input, prepared: value(await host.prepareArchivedTasksDeleteUndo({ request: input, delete: deletion })).prepared };
};
const rows = () => clone(buildSaveSnapshot(useTaskStore.getState()));
const canonical = async () => getStorageAdapter().saveData(buildSaveSnapshot(useTaskStore.getState()));
const payload = (prefix: string, envelope: unknown) => JSON.stringify([prefix, envelope], (_name, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const receiptMethod = (prefix: string, envelope: unknown) => `${prefix}:${deterministicHash128(payload(prefix, envelope)).map((part) => part.toString(16).padStart(8, '0')).join('')}`;
const raw = async (sqlite: Awaited<ReturnType<typeof openSqliteHost>>) => Object.fromEntries(await Promise.all([
    'tasks', 'projects', 'sections', 'areas', 'people', 'settings', 'saved_filters', 'schema_migrations', 'calendar_sync',
].map(async (table) => [table, {
    columns: await sqlite.sql(`PRAGMA table_info(${table})`), indexes: await sqlite.sql(`PRAGMA index_list(${table})`),
    foreignKeys: await sqlite.sql(`PRAGMA foreign_key_list(${table})`),
    definitions: await sqlite.sql('SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name = ? ORDER BY type,name', [table]),
    rows: await sqlite.sql<Record<string, unknown>>(`SELECT rowid AS _rowid, * FROM ${table} ORDER BY rowid`),
}])));
const receipts = (sqlite: Awaited<ReturnType<typeof openSqliteHost>>) => sqlite.sql('SELECT rowid AS _rowid, * FROM native_request_receipts ORDER BY request_id');
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); });
const clock = () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); };

describe('guarded Inbox bulk Trash and public Undo', () => {
    it('matches actual RN batch Trash/restore while retaining Inbox status and distinct durable receipt fingerprints', async () => {
        clock(); const selected = ['source', 'rich'];
        const rn = await openSqliteHost(seed()); let deleted; let deletedRaw; let restored; let restoredRaw;
        try {
            await canonical(); expect(await useTaskStore.getState().batchDeleteTasks(selected)).toEqual({ success: true });
            await flushPendingSave(); deleted = rows(); deletedRaw = await raw(rn);
            vi.setSystemTime(new Date('2026-10-03T13:01:00.000Z'));
            expect(await Promise.all(selected.map(id => useTaskStore.getState().restoreTask(id)))).toEqual([{ success: true }, { success: true }]);
            await flushPendingSave(); restored = rows(); restoredRaw = await raw(rn);
        } finally { await rn.close(); }
        vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try {
            await canonical(); const host = methods(); const deletion = await prepare(host, request(selected));
            expect(deletion.prepared.version).toBe(1); expect(deletion.request.source).toBe('inbox');
            expect(deletion.prepared.projects?.map(row => row.id)).toEqual(['parent-a', 'parent-b']);
            expect(value(await host.commitPreparedArchivedTasksDelete(deletion)).count).toBe(2);
            expect(deletion.prepared.after.map(row => row.status)).toEqual(['inbox', 'inbox']);
            expect(rows()).toEqual(deleted); expect(await raw(sqlite)).toEqual(deletedRaw);
            vi.setSystemTime(new Date('2026-10-03T13:01:00.000Z')); const undo = await prepareUndo(host, deletion);
            expect(value(await host.commitPreparedArchivedTasksDeleteUndo(undo))).toEqual({ count: 2 });
            expect(rows()).toEqual(restored); expect(await raw(sqlite)).toEqual(restoredRaw);
            expect(await sqlite.sql('SELECT request_id,method,reply,saved_at FROM native_request_receipts ORDER BY request_id')).toEqual([
                { request_id: DELETE_ID, method: receiptMethod('inboxTasksDelete', deletion), reply: JSON.stringify(deletion.prepared.result), saved_at: NOW },
                { request_id: UNDO_ID, method: receiptMethod('inboxTasksDeleteUndo', undo), reply: JSON.stringify(undo.prepared.result), saved_at: '2026-10-03T13:01:00.000Z' },
            ]);
        } finally { await sqlite.close(); }
    });

    it.each([
        ['active', true], ['focused-parked', true], ['unfocused-parked', false],
        ['missing', true], ['archived-focused', false], ['deleted', false],
    ] as const)('uses Inbox visibility/read-only eligibility for %s parent, independently of selected Area', async (kind, allowed) => {
        clock(); const sqlite = await openSqliteHost({ ...seed(), tasks: seed().tasks.map(row => ({ ...row, areaId: 'elsewhere' })),
            areas: ['chosen', 'elsewhere'].map(id => ({ id, name: id, color: '#94a3b8', order: 0, createdAt: BEFORE, updatedAt: BEFORE })),
            settings: { ...seed().settings, filters: { areaId: 'chosen', areaIds: ['chosen'], excludedAreaIds: [] } } });
        try {
            if (kind === 'missing') {
                await sqlite.client().exec('PRAGMA foreign_keys = OFF'); await sqlite.client().run('DELETE FROM projects WHERE id = ?', ['parent-b']); await sqlite.client().exec('PRAGMA foreign_keys = ON');
            } else if (kind === 'deleted') await sqlite.client().run('UPDATE projects SET deletedAt = ? WHERE id = ?', [BEFORE, 'parent-b']);
            else if (kind !== 'active') await sqlite.client().run('UPDATE projects SET status = ?, isFocused = ? WHERE id = ?',
                [kind === 'archived-focused' ? 'archived' : 'someday', kind === 'unfocused-parked' ? 0 : 1, 'parent-b']);
            await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
            const selected = value(sqlite.host.getBulkActions({ list: 'inbox', params: { groupBy: 'none' }, taskIds: ['rich', 'source'] }));
            expect(selected.selectedIds.includes('source')).toBe(allowed); expect(selected.selectedIds).toContain('rich');
            const result = await methods().prepareArchivedTasksDelete(request(['rich', 'source']));
            if (allowed) expect(result).toMatchObject({ ok: true, value: { prepared: { request: { source: 'inbox' } } } });
            else expect(result).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it.each(['parked', 'archived-focused', 'deleted', 'raw-parent'] as const)('rechecks %s parent changes after Prepare without partial Trash', async kind => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const host = methods(); const deletion = await prepare(host, request(['source', 'rich']));
            if (kind === 'deleted') await sqlite.client().run('UPDATE projects SET deletedAt = ? WHERE id = ?', [NOW, 'parent-b']);
            else if (kind === 'raw-parent') await sqlite.client().run('UPDATE projects SET supportNotes = ? WHERE id = ?', ['Changed without revision', 'parent-b']);
            else await sqlite.client().run('UPDATE projects SET status = ?, isFocused = ? WHERE id = ?', [kind === 'parked' ? 'someday' : 'archived', kind === 'archived-focused' ? 1 : 0, 'parent-b']);
            const before = await raw(sqlite); const memory = useTaskStore.getState();
            expect(await host.commitPreparedArchivedTasksDelete(deletion)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(useTaskStore.getState()._allTasks).toBe(memory._allTasks); expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('binds legacy raw optional Task/Project fields and refuses selected SQL drift without a revision bump', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const attachment = [{ id: 'raw-link', kind: 'link', title: 'Fixture', uri: 'https://example.com', createdAt: BEFORE }];
            await sqlite.client().run('UPDATE tasks SET attachments = ?, tags = NULL, contexts = NULL WHERE id = ?', [JSON.stringify(attachment), 'source']);
            await sqlite.client().run('UPDATE projects SET tagIds = NULL, attachments = ? WHERE id = ?', [JSON.stringify(attachment), 'parent-b']);
            await sqlite.restart(undefined, { recoveryLoad: true }); const host = methods(); const deletion = await prepare(host);
            expect(Object.hasOwn(deletion.prepared.before[0], 'tags')).toBe(false); expect(Object.hasOwn(deletion.prepared.before[0], 'contexts')).toBe(false);
            expect(Object.hasOwn(deletion.prepared.before[0].attachments![0], 'updatedAt')).toBe(false);
            expect(Object.hasOwn(deletion.prepared.projects![0], 'tagIds')).toBe(false); expect(Object.hasOwn(deletion.prepared.projects![0].attachments![0], 'updatedAt')).toBe(false);
            await sqlite.client().run('UPDATE tasks SET focusOrder = 3 WHERE id = ?', ['source']); const before = await raw(sqlite);
            expect(await host.commitPreparedArchivedTasksDelete(deletion)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it.each(['delete', 'wrong-source', 'wrong-reply', 'wrong-date'] as const)('requires fresh durable origin after warm ACK and %s drift, with saved own Undo precedence', async drift => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const host = methods(); const deletion = await prepare(host); value(await host.commitPreparedArchivedTasksDelete(deletion)); const undo = await prepareUndo(host, deletion);
            const original = (await sqlite.sql<{ method: string; reply: string; saved_at: string }>('SELECT * FROM native_request_receipts WHERE request_id = ?', [DELETE_ID]))[0];
            if (drift === 'delete') await sqlite.client().run('DELETE FROM native_request_receipts WHERE request_id = ?', [DELETE_ID]);
            else if (drift === 'wrong-source') await sqlite.client().run('UPDATE native_request_receipts SET method = ? WHERE request_id = ?', [receiptMethod('referenceTasksDelete', deletion), DELETE_ID]);
            else if (drift === 'wrong-reply') await sqlite.client().run('UPDATE native_request_receipts SET reply = ? WHERE request_id = ?', [JSON.stringify({ count: 99 }), DELETE_ID]);
            else await sqlite.client().run('UPDATE native_request_receipts SET saved_at = ? WHERE request_id = ?', ['invalid', DELETE_ID]);
            expect(value(host.archivedTasksDeleteOutcome(deletion))).not.toBeNull(); const before = await raw(sqlite); const proof = await receipts(sqlite);
            expect(await host.prepareArchivedTasksDeleteUndo({ request: undo.request, delete: deletion })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await host.commitPreparedArchivedTasksDeleteUndo(undo)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual(proof);
            await sqlite.client().run('INSERT INTO native_request_receipts(request_id,method,reply,saved_at) VALUES(?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET method=excluded.method,reply=excluded.reply,saved_at=excluded.saved_at', [DELETE_ID, original.method, original.reply, original.saved_at]);
            value(await host.commitPreparedArchivedTasksDeleteUndo(undo));
            await sqlite.client().run('DELETE FROM native_request_receipts WHERE request_id = ?', [DELETE_ID]);
            await sqlite.client().run('UPDATE tasks SET description = ? WHERE id = ?', ['Later edit', 'source']); const later = await raw(sqlite);
            expect(value(await host.commitPreparedArchivedTasksDeleteUndo(undo))).toEqual({ count: 1 }); expect(await raw(sqlite)).toEqual(later);
        } finally { await sqlite.close(); }
    });

    it.each(['remove', 'query-error'] as const)('checks original receipt inside the Undo transaction after %s race and permits exact retry', async drift => {
        clock(); let armed = false; let preflight = false; let inTransaction = false; let proofReads = 0; let failRead = false;
        const sqlite = await openSqliteHost(seed(), client => ({ ...client, all: async (...args) => {
            const origin = args[0].includes('FROM native_request_receipts WHERE request_id');
            if (origin && inTransaction) proofReads++; if (origin && failRead) throw new Error('injected transaction proof error');
            const result = await client.all(...args); if (armed && origin) preflight = true; return result;
        }, run: async (sql, params) => {
            if (armed && preflight && sql === 'BEGIN IMMEDIATE') { armed = false;
                if (drift === 'remove') await client.run('DELETE FROM native_request_receipts WHERE request_id = ?', [DELETE_ID]); else failRead = true;
            }
            const result = await client.run(sql, params);
            if (sql === 'BEGIN IMMEDIATE') inTransaction = true; else if (sql === 'COMMIT' || sql === 'ROLLBACK') inTransaction = false; return result;
        } }));
        try {
            const host = methods(); const deletion = await prepare(host); value(await host.commitPreparedArchivedTasksDelete(deletion)); const undo = await prepareUndo(host, deletion);
            const original = (await sqlite.sql<{ method: string; reply: string; saved_at: string }>('SELECT * FROM native_request_receipts WHERE request_id = ?', [DELETE_ID]))[0];
            const before = await raw(sqlite); proofReads = 0; armed = true;
            expect(await host.commitPreparedArchivedTasksDeleteUndo(undo)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            failRead = false; expect(armed).toBe(false); expect(preflight).toBe(true); expect(proofReads).toBeGreaterThan(0); expect(inTransaction).toBe(false);
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).not.toContain(UNDO_ID);
            await sqlite.client().run('INSERT INTO native_request_receipts(request_id,method,reply,saved_at) VALUES(?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET method=excluded.method,reply=excluded.reply,saved_at=excluded.saved_at', [DELETE_ID, original.method, original.reply, original.saved_at]);
            expect(value(await host.commitPreparedArchivedTasksDeleteUndo(undo))).toEqual({ count: 1 });
        } finally { armed = false; failRead = false; await sqlite.close(); }
    }, 15_000);

    it('retains exact owed Delete/Undo through failed COMMIT and cold retry', async () => {
        clock(); let fault = false; const sqlite = await openSqliteHost(seed(), client => ({ ...client, run: async (...args) => {
            if (fault && args[0] === 'COMMIT') throw new Error('injected COMMIT'); return client.run(...args);
        } }));
        try {
            let host = methods(); const deletion = clone(await prepare(host)); const exactDelete = JSON.stringify(deletion); const before = await raw(sqlite);
            fault = true; expect(await host.commitPreparedArchivedTasksDelete(deletion)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); fault = false;
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            await sqlite.restart(undefined, { recoveryLoad: true }); host = methods(); expect(JSON.stringify(deletion)).toBe(exactDelete);
            value(await host.commitPreparedArchivedTasksDelete(deletion)); const deleted = await raw(sqlite); const undo = clone(await prepareUndo(host, deletion)); const exactUndo = JSON.stringify(undo);
            fault = true; expect(await host.commitPreparedArchivedTasksDeleteUndo(undo)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); fault = false;
            expect(await raw(sqlite)).toEqual(deleted); expect(await sqlite.receiptIds()).toEqual([DELETE_ID]);
            await sqlite.restart(undefined, { recoveryLoad: true }); host = methods(); expect(JSON.stringify(undo)).toBe(exactUndo);
            expect(value(await host.commitPreparedArchivedTasksDeleteUndo(undo))).toEqual({ count: 1 }); expect(await sqlite.receiptIds()).toEqual([DELETE_ID, UNDO_ID]);
        } finally { fault = false; await sqlite.close(); }
    }, 15_000);

    it.each(['tag', 'context'] as const)('uses complete cross-page Inbox range and deduplicates/prunes %s groups without writes', async groupBy => {
        clock(); const tasks = Array.from({ length: 140 }, (_, index) => source(`inbox-${String(index).padStart(3, '0')}`, {
            title: `Inbox ${String(index).padStart(3, '0')}${index >= 130 ? ' tail' : ''}`,
            tags: index < 70 ? ['#first', '#duplicate'] : ['#second'], contexts: index < 70 ? ['@first', '@duplicate'] : ['@second'] }));
        const sqlite = await openSqliteHost({ ...seed(), tasks, settings: { ...seed().settings, taskSortBy: 'title' } });
        try {
            const host = sqlite.host; const before = await raw(sqlite); const params = { groupBy: 'none' as const, sortBy: 'title' as const };
            const page = value(host.getInboxView({ ...params, offset: 0, limit: 100 }));
            const next = value(host.getInboxView({ ...params, offset: 100, limit: 100, revision: page.revision }));
            expect(next.items.some(item => item.type === 'task' && item.row.id === 'inbox-130')).toBe(true);
            const first = value(host.getBulkActions({ list: 'inbox', params, selectionEdit: { taskId: 'inbox-005' } }));
            const range = value(host.getBulkActions({ list: 'inbox', params, taskIds: first.selectedIds, anchorId: first.anchorId,
                selectionEdit: { taskId: 'inbox-130', range: true } }));
            expect(range.selectedIds).toEqual(Array.from({ length: 126 }, (_, index) => `inbox-${String(index + 5).padStart(3, '0')}`));
            expect(Object.keys(range.taskRevisions)).toEqual(range.selectedIds); expect(range.selectAll).toBeNull();
            const filtered = value(host.getBulkActions({ list: 'inbox', params: { ...params, filters: { searchQuery: 'tail' } }, taskIds: range.selectedIds }));
            expect(filtered.selectedIds).toEqual(['inbox-130']);
            const prefix = groupBy === 'tag' ? 'tag:#' : 'context:@';
            const folded = value(host.getBulkActions({ list: 'inbox', params: { ...params, groupBy, collapsedGroupIds: [prefix + 'first', prefix + 'duplicate'] }, taskIds: range.selectedIds }));
            expect(folded.selectedIds).toEqual(Array.from({ length: 61 }, (_, index) => `inbox-${String(index + 70).padStart(3, '0')}`));
            const duplicate = value(host.getBulkActions({ list: 'inbox', params: { ...params, groupBy }, taskIds: ['inbox-005'] }));
            expect(duplicate.selectedIds).toEqual(['inbox-005']); expect(duplicate.selectedCount).toBe(1);
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('keeps literal UTF-8 IDs and revision keys distinct, and rejects forged source/parent/effects', async () => {
        clock(); const nfd = 'inbox-e\u0301'; const nfc = 'inbox-\u00e9';
        const sqlite = await openSqliteHost({ ...seed(), tasks: [source(nfd, { projectId: 'parent-b' }), source(nfc)] });
        try {
            const host = methods(); const deletion = await prepare(host, request([nfd])); const before = await raw(sqlite);
            for (const mutate of [(e: NativeArchivedTasksDeleteEnvelope) => { e.request.source = 'reference'; e.prepared.request.source = 'reference'; },
                (e: NativeArchivedTasksDeleteEnvelope) => { delete e.prepared.projects; },
                (e: NativeArchivedTasksDeleteEnvelope) => { e.prepared.after[0].status = 'done'; }]) {
                const forged = clone(deletion); mutate(forged);
                expect(host.validatePreparedArchivedTasksDelete(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(await host.commitPreparedArchivedTasksDelete(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            }
            expect(await host.prepareArchivedTasksDelete({ ...request([nfd]), taskRevisions: { [nfc]: request([nfd]).taskRevisions[nfd] } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            value(await host.commitPreparedArchivedTasksDelete(deletion));
            expect((await raw(sqlite)).tasks.rows.find(row => row.id === nfc)).toEqual(before.tasks.rows.find(row => row.id === nfc));
            const freshUUID = clone(deletion); freshUUID.request.requestId = '00000000-0000-4000-8000-000000000741'; freshUUID.prepared.request.requestId = freshUUID.request.requestId;
            expect(await host.commitPreparedArchivedTasksDelete(freshUUID)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await sqlite.receiptIds()).toEqual([DELETE_ID]);
        } finally { await sqlite.close(); }
    });

    it.each([550_000, 1_050_000])('refuses oversized Delete/nested Undo %i without effects', async length => {
        clock(); const sqlite = await openSqliteHost({ ...seed(), tasks: [source('source', { description: 'x'.repeat(length) })] });
        try {
            const before = await raw(sqlite);
            expect(await methods().prepareArchivedTasksDelete(request())).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('select fewer') } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('rejects malformed/cross-status/projected/stale selections without partial writes', async () => {
        clock(); const projected = getProjectedRecurringTaskId('source');
        const sqlite = await openSqliteHost({ ...seed(), tasks: [...seed().tasks, source('done', { status: 'done', completedAt: BEFORE }),
            source('deleted', { deletedAt: BEFORE }), source('purged', { deletedAt: BEFORE, purgedAt: BEFORE }), source(projected)] });
        try {
            const host = methods(); const before = await raw(sqlite);
            for (const input of [{ ...request(), source: 'archive' }, { ...request(), source: null }, { ...request(), taskIds: [] },
                { ...request(), taskIds: ['source', 'source'] }, { ...request(), taskRevisions: { source: 'stale' } },
                { ...request(), taskRevisions: { ...request().taskRevisions, extra: 'revision' } }, { ...request(), requestId: 'bad' },
                request(['done']), request(['deleted']), request(['purged']), request([projected]),
                { ...request(), taskIds: ['missing'], taskRevisions: { missing: 'revision' } }]) {
                expect(await host.prepareArchivedTasksDelete(input as never)).toMatchObject({ ok: false });
                expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            }
        } finally { await sqlite.close(); }
    });

    it.each(['taskAttachments', 'taskRecurrence', 'projectAttachments'] as const)('fails closed on initially corrupt raw %s instead of normalizing it', async field => {
        clock(); let mutations = 0; const sqlite = await openSqliteHost(seed(), client => ({ ...client,
            run: async (...args) => { mutations++; return client.run(...args); } }));
        try {
            await sqlite.client().run(`DROP TRIGGER ${field === 'projectAttachments' ? 'projects' : 'tasks'}_validate_update`);
            await sqlite.client().run(field === 'projectAttachments' ? 'UPDATE projects SET attachments = ? WHERE id = ?'
                : `UPDATE tasks SET ${field === 'taskAttachments' ? 'attachments' : 'recurrence'} = ? WHERE id = ?`, ['{broken', field === 'projectAttachments' ? 'parent-b' : 'source']);
            await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite); const count = mutations;
            expect(await methods().prepareArchivedTasksDelete(request())).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(mutations).toBe(count); expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });
});
