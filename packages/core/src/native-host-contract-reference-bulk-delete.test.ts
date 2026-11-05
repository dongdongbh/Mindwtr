import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { updateRangeSelection } from './range-selection';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createArchivedTasksDeleteMethods, type NativeArchivedTasksDeleteEnvelope } from './native-host-contract-archive-bulk-delete';
import { buildSaveSnapshot } from './store-helpers';
import { taskRevisionOf } from './native-request-receipts';
import { openSqliteHost } from './screen-parity.replay';
import { flushPendingSave, getStorageAdapter, resetForTests, useTaskStore } from './store';
import type { Task } from './types';
import { deterministicHash128 } from './uuid';

const NOW = '2026-10-03T13:00:00.000Z';
const BEFORE = '2026-09-30T12:34:56.789Z';
const DEVICE = 'reference-delete-device';
const DELETE_ID = '00000000-0000-4000-8000-000000000192';
const UNDO_ID = '00000000-0000-4000-8000-000000000193';
const source = (id = 'source', fields: Partial<Task> = {}): Task => ({ id, title: 'Retained fixture', status: 'reference',
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
const request = (taskIds = ['source'], requestId = DELETE_ID) => ({ requestId, source: 'reference' as const, taskIds,
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

describe('guarded Reference bulk Delete and Undo', () => {
    it('matches actual RN batchDeleteTasks and Promise.all restoreTask complete AppData and nine canonical SQLite tables', async () => {
        clock(); const selected = ['source', 'rich'];
        const rn = await openSqliteHost(seed()); let deleted; let deletedRaw; let restored; let restoredRaw;
        try {
            await canonical(); expect(await useTaskStore.getState().batchDeleteTasks(selected)).toEqual({ success: true });
            await flushPendingSave(); deleted = rows(); deletedRaw = await raw(rn);
            vi.setSystemTime(new Date('2026-10-03T13:01:00.000Z'));
            expect(await Promise.all(selected.map((id) => useTaskStore.getState().restoreTask(id)))).toEqual([{ success: true }, { success: true }]);
            await flushPendingSave(); restored = rows(); restoredRaw = await raw(rn);
        } finally { await rn.close(); }
        vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try {
            await canonical(); const host = methods(); const deletion = await prepare(host, request(selected));
            expect(deletion.prepared.before.map((r) => r.id)).toEqual(['rich', 'source']);
            expect(deletion.prepared.projects?.map((r) => r.id)).toEqual(['parent-a', 'parent-b']);
            expect(value(await host.commitPreparedArchivedTasksDelete(deletion)).count).toBe(2);
            expect(rows()).toEqual(deleted); expect(await raw(sqlite)).toEqual(deletedRaw);
            vi.setSystemTime(new Date('2026-10-03T13:01:00.000Z')); const undo = await prepareUndo(host, deletion);
            expect(value(await host.commitPreparedArchivedTasksDeleteUndo(undo))).toEqual({ count: 2 });
            expect(rows()).toEqual(restored); expect(await raw(sqlite)).toEqual(restoredRaw);
            expect(await sqlite.receiptIds()).toEqual([DELETE_ID, UNDO_ID]);
        } finally { await sqlite.close(); }
    });

    it('preserves and strictly binds legacy project JSON with absent tagIds and attachment updatedAt', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const attachments = [{ id: 'parent-link', kind: 'link', title: 'Fixture', uri: 'https://example.com', createdAt: BEFORE }];
            await sqlite.client().run('UPDATE projects SET tagIds = NULL, attachments = ? WHERE id = ?', [JSON.stringify(attachments), 'parent-b']);
            await sqlite.restart(undefined, { recoveryLoad: true }); const host = methods(); const deletion = await prepare(host);
            const project = deletion.prepared.projects![0]; expect(Object.hasOwn(project, 'tagIds')).toBe(false);
            expect(Object.hasOwn(project.attachments![0], 'updatedAt')).toBe(false);
            const before = await raw(sqlite); value(await host.commitPreparedArchivedTasksDelete(deletion));
            expect((await raw(sqlite)).projects).toEqual(before.projects);
            const undo = await prepareUndo(host, deletion); expect(undo.prepared.scope.projects[0]).toEqual(project);
            value(await host.commitPreparedArchivedTasksDeleteUndo(undo)); expect((await raw(sqlite)).projects).toEqual(before.projects);
        } finally { await sqlite.close(); }
    });

    it('requires the current durable Delete receipt after a warm cached ACK and gives own saved Undo precedence', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const host = methods(); const deletion = await prepare(host); value(await host.commitPreparedArchivedTasksDelete(deletion));
            const undo = await prepareUndo(host, deletion); const original = (await sqlite.sql<{ method: string; reply: string; saved_at: string }>('SELECT * FROM native_request_receipts WHERE request_id = ?', [DELETE_ID]))[0];
            await sqlite.client().run('DELETE FROM native_request_receipts WHERE request_id = ?', [DELETE_ID]); const before = await raw(sqlite);
            expect(await host.prepareArchivedTasksDeleteUndo({ request: undo.request, delete: deletion })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await host.commitPreparedArchivedTasksDeleteUndo(undo)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            await sqlite.client().run('INSERT INTO native_request_receipts (request_id, method, reply, saved_at) VALUES (?, ?, ?, ?)', [DELETE_ID, original.method, original.reply, original.saved_at]);
            value(await host.commitPreparedArchivedTasksDeleteUndo(undo));
            await sqlite.client().run('DELETE FROM native_request_receipts WHERE request_id = ?', [DELETE_ID]);
            await sqlite.client().run('UPDATE projects SET deletedAt = ? WHERE id = ?', [NOW, 'parent-b']); const terminal = await raw(sqlite);
            expect(value(await host.commitPreparedArchivedTasksDeleteUndo(undo))).toEqual({ count: 1 }); expect(await raw(sqlite)).toEqual(terminal);
            await sqlite.restart(undefined, { recoveryLoad: true }); expect(value(await methods().commitPreparedArchivedTasksDeleteUndo(undo))).toEqual({ count: 1 });
        } finally { await sqlite.close(); }
    });


    it('uses complete shared Reference range/filter/fold eligibility across pages and duplicate tag occurrences without writes', async () => {
        clock(); const tasks = Array.from({ length: 140 }, (_, index) => source(`ref-${String(index).padStart(3, '0')}`, {
            title: `Reference ${String(index).padStart(3, '0')}`, tags: index < 70 ? ['#first', '#duplicate'] : ['#second'],
            ...(index === 20 ? { projectId: 'parent-a' } : index === 30 ? { projectId: 'parent-b' } : {}) }));
        const sqlite = await openSqliteHost({ ...seed(), tasks, settings: { ...seed().settings, taskSortBy: 'title' } });
        try {
            await sqlite.client().run('UPDATE projects SET status = ? WHERE id = ?', ['archived', 'parent-a']);
            await sqlite.client().run('UPDATE projects SET deletedAt = ? WHERE id = ?', [BEFORE, 'parent-b']);
            await sqlite.restart(undefined, { recoveryLoad: true }); const host = sqlite.host; const before = await raw(sqlite);
            const params = { groupBy: 'none' as const, includeArchivedProjects: true };
            const first = value(host.getReferenceView({ ...params, offset: 0, limit: 100 }));
            const second = value(host.getReferenceView({ ...params, offset: 100, limit: 100, revision: first.revision }));
            expect(second.items.some((item) => item.type === 'task' && item.row.id === 'ref-130')).toBe(true);
            const visibleIds = [...first.items, ...second.items].flatMap((item) => item.type === 'task' && !item.row.readOnly ? [item.row.id] : []);
            const selected = value(host.getBulkActions({ list: 'reference', params, selectionEdit: { taskId: 'ref-005' } }));
            const ranged = value(host.getBulkActions({ list: 'reference', params, taskIds: selected.selectedIds, anchorId: selected.anchorId,
                selectionEdit: { taskId: 'ref-130', range: true } }));
            expect(ranged.selectedIds).toEqual([...updateRangeSelection({ anchorId: selected.anchorId, range: true,
                selectedIds: new Set(selected.selectedIds), targetId: 'ref-130', visibleIds }).selectedIds]);
            expect(ranged.selectedIds).not.toContain('ref-020'); expect(ranged.selectedIds).not.toContain('ref-030');
            expect(ranged.selectAll).toBeNull();
            const filtered = value(host.getBulkActions({ list: 'reference', params: { ...params, filters: { searchQuery: 'Reference 13' } }, taskIds: ranged.selectedIds }));
            expect(filtered.selectedIds).toEqual(['ref-013', 'ref-113', 'ref-130']);
            const folded = value(host.getBulkActions({ list: 'reference', params: { ...params, groupBy: 'tag', collapsedGroupIds: ['tag:#first', 'tag:#duplicate'] }, taskIds: ranged.selectedIds }));
            expect(folded.selectedIds).toEqual(ranged.selectedIds.filter((id) => Number(id.slice(-3)) >= 70));
            const duplicates = value(host.getBulkActions({ list: 'reference', params: { ...params, groupBy: 'tag' }, taskIds: ['ref-005'] }));
            expect(duplicates.selectedIds).toEqual(['ref-005']); expect(duplicates.selectedCount).toBe(1);
            const grouped = value(host.getReferenceView({ ...params, groupBy: 'tag', offset: 0, limit: 100 }));
            const occurrences = [...grouped.items];
            for (let offset = 100; offset < grouped.total; offset += 100) occurrences.push(...value(host.getReferenceView({ ...params, groupBy: 'tag', offset, limit: 100, revision: grouped.revision })).items);
            expect(occurrences.filter((item) => item.type === 'task' && item.row.id === 'ref-005')).toHaveLength(2);
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('rejects malformed/cross-source and forged effects before SQL and rejects stale/ineligible selections atomically', async () => {
        clock(); const sql = vi.fn(); const sqlite = await openSqliteHost({ ...seed(), tasks: [...seed().tasks,
            source('done', { status: 'done', completedAt: BEFORE }), source('deleted', { deletedAt: BEFORE }), source('purged', { deletedAt: BEFORE, purgedAt: BEFORE })] },
        client => ({ ...client, all: async (...args) => { sql(args[0]); return client.all(...args); },
            run: async (...args) => { sql(args[0]); return client.run(...args); }, get: async (...args) => { sql(args[0]); return client.get(...args); },
            exec: async (...args) => { sql(args[0]); return client.exec(...args); } }));
        try {
            const host = methods(); const deletion = await prepare(host); const before = await raw(sqlite);
            for (const input of [{ ...request(), source: 'archive' }, { ...request(), source: null }, { ...request(), taskIds: [] },
                { ...request(), taskIds: ['source', 'source'] }, { ...request(), taskRevisions: { source: 'stale' } },
                { ...request(), taskRevisions: { ...request().taskRevisions, extra: 'revision' } }, { ...request(), requestId: 'bad' },
                request(['done']), request(['deleted']), request(['purged']),
                { ...request(), taskIds: ['missing'], taskRevisions: { missing: 'revision' } }])
                expect(await host.prepareArchivedTasksDelete(input as never)).toMatchObject({ ok: false });
            for (const mutate of [(e: NativeArchivedTasksDeleteEnvelope) => { e.request.source = 'done'; e.prepared.request.source = 'done'; },
                (e: NativeArchivedTasksDeleteEnvelope) => { delete e.prepared.projects; },
                (e: NativeArchivedTasksDeleteEnvelope) => { e.prepared.projects!.push(clone(e.prepared.projects![0])); },
                (e: NativeArchivedTasksDeleteEnvelope) => { e.prepared.projects![0].status = 'archived'; },
                (e: NativeArchivedTasksDeleteEnvelope) => { (e.prepared.projects![0] as unknown as { tagIds: string }).tagIds = 'bad'; },
                (e: NativeArchivedTasksDeleteEnvelope) => { (e.prepared.projects![0] as unknown as { extra: string }).extra = 'bad'; },
                (e: NativeArchivedTasksDeleteEnvelope) => { (e.prepared.projects![0] as unknown as { attachments: string[] }).attachments = ['wrong typed attachment']; },
                (e: NativeArchivedTasksDeleteEnvelope) => { e.prepared.after[0].status = 'inbox'; },
                (e: NativeArchivedTasksDeleteEnvelope) => { e.prepared.result.count = 2; }]) {
                const forged = clone(deletion); mutate(forged); sql.mockClear();
                expect(host.validatePreparedArchivedTasksDelete(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(await host.commitPreparedArchivedTasksDelete(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(sql).not.toHaveBeenCalled();
            }
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            value(await host.commitPreparedArchivedTasksDelete(deletion)); const undo = await prepareUndo(host, deletion);
            const forged = clone(undo); forged.prepared.after[0].status = 'done'; sql.mockClear();
            expect(await host.commitPreparedArchivedTasksDeleteUndo(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } }); expect(sql).not.toHaveBeenCalled();
        } finally { await sqlite.close(); }
    });

    it.each(['first', 'retry'] as const)('guards exact selected rows and complete parent on %s commit without overwriting external edits', async phase => {
        clock(); let fault = false; const sqlite = await openSqliteHost(seed(), client => ({ ...client, run: async (...args) => {
            if (fault && args[0] === 'COMMIT') throw new Error('injected COMMIT'); return client.run(...args);
        } }));
        try {
            const host = methods(); const deletion = await prepare(host);
            if (phase === 'retry') { fault = true; expect(await host.commitPreparedArchivedTasksDelete(deletion)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); fault = false; }
            await sqlite.client().run('UPDATE projects SET supportNotes = ? WHERE id = ?', ['Later parent', 'parent-b']);
            const before = await raw(sqlite); const state = useTaskStore.getState();
            expect(await host.commitPreparedArchivedTasksDelete(deletion)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(useTaskStore.getState()._allTasks).toBe(state._allTasks); expect(useTaskStore.getState().settings).toBe(state.settings);
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { fault = false; await sqlite.close(); }
    });

    it.each([false, true])('distinguishes missing and explicit empty legacy Project attachment metadata, direction %s, including cold CAS', async explicitBefore => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const attachment = { id: 'parent-link', kind: 'link', title: 'Fixture', uri: 'https://example.com', createdAt: BEFORE };
            await sqlite.client().run('UPDATE projects SET attachments = ? WHERE id = ?', [JSON.stringify([{ ...attachment, ...(explicitBefore ? { updatedAt: '' } : {}) }]), 'parent-b']);
            await sqlite.restart(undefined, { recoveryLoad: true }); const deletion = clone(await prepare());
            await sqlite.client().run('UPDATE projects SET attachments = ? WHERE id = ?', [JSON.stringify([{ ...attachment, ...(!explicitBefore ? { updatedAt: '' } : {}) }]), 'parent-b']);
            await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite); const memory = useTaskStore.getState();
            expect(await methods().commitPreparedArchivedTasksDelete(deletion)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(useTaskStore.getState()._allProjects).toBe(memory._allProjects); expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it.each(['same-host', 'cold'] as const)('recovers two failed Delete and Undo commits through %s with exact UUID/full receipts and raw siblings', async recovery => {
        clock(); let fault = false; const sqlite = await openSqliteHost(seed(), client => ({ ...client, run: async (...args) => {
            if (fault && args[0] === 'COMMIT') throw new Error('injected COMMIT'); return client.run(...args);
        } }));
        try {
            await sqlite.client().run('UPDATE tasks SET focusOrder = 2, pushCount = NULL WHERE id IN (?, ?)', ['source', 'sibling']);
            await sqlite.client().run('UPDATE settings SET data = ? WHERE id = 1', [JSON.stringify(seed().settings, null, 2)]);
            await sqlite.restart(undefined, { recoveryLoad: true }); let host = methods(); const deletion = clone(await prepare(host)); const before = await raw(sqlite);
            for (let attempt = 0; attempt < 2; attempt++) {
                fault = true; expect(await host.commitPreparedArchivedTasksDelete(deletion)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
                expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            }
            fault = false; if (recovery === 'cold') { await sqlite.restart(undefined, { recoveryLoad: true }); host = methods(); }
            value(await host.commitPreparedArchivedTasksDelete(deletion)); const deleted = await raw(sqlite); const deleteReceipt = await receipts(sqlite); const undo = clone(await prepareUndo(host, deletion));
            for (let attempt = 0; attempt < 2; attempt++) {
                fault = true; expect(await host.commitPreparedArchivedTasksDeleteUndo(undo)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
                expect(await raw(sqlite)).toEqual(deleted); expect(await receipts(sqlite)).toEqual(deleteReceipt);
            }
            fault = false; if (recovery === 'cold') { await sqlite.restart(undefined, { recoveryLoad: true }); host = methods(); }
            value(await host.commitPreparedArchivedTasksDeleteUndo(undo)); const restored = await raw(sqlite); const saved = await receipts(sqlite);
            expect(restored.tasks.rows.find((row) => row.id === 'sibling')).toEqual(before.tasks.rows.find((row) => row.id === 'sibling'));
            expect(restored.settings).toEqual(before.settings); expect(restored.projects).toEqual(before.projects);
            expect(await sqlite.receiptIds()).toEqual([DELETE_ID, UNDO_ID]);
            await sqlite.restart(undefined, { recoveryLoad: true }); expect(value(methods().archivedTasksDeleteUndoOutcome(undo))).toEqual({ count: 1 });
            expect(await raw(sqlite)).toEqual(restored); expect(await receipts(sqlite)).toEqual(saved);
        } finally { fault = false; await sqlite.close(); }
    }, 25_000);

    it('uses exact NFD task identity with NFC sibling untouched and refuses equal AFTER under an unused UUID', async () => {
        clock(); const nfd = 'ref-e\u0301'; const nfc = 'ref-\u00e9'; const sqlite = await openSqliteHost({ ...seed(), tasks: [source(nfd), source(nfc)] });
        try {
            const host = methods(); const before = await raw(sqlite); const deletion = await prepare(host, request([nfd]));
            value(await host.commitPreparedArchivedTasksDelete(deletion)); const deleted = await raw(sqlite);
            expect(deleted.tasks.rows.find((r) => r.id === nfc)).toEqual(before.tasks.rows.find((r) => r.id === nfc));
            const forged = clone(deletion); forged.request.requestId = '00000000-0000-4000-8000-000000000194'; forged.prepared.request.requestId = forged.request.requestId;
            expect(await host.commitPreparedArchivedTasksDelete(forged)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(deleted); expect(await sqlite.receiptIds()).toEqual([DELETE_ID]);
            value(await host.commitPreparedArchivedTasksDeleteUndo(await prepareUndo(host, deletion))); expect(useTaskStore.getState()._tasksById.get(nfd)?.deletedAt).toBeUndefined();
        } finally { await sqlite.close(); }
    });

    it.each(['delete', 'method', 'reply', 'savedAt'] as const)('rejects exact cached Delete after durable %s proof drift, without writes or descriptor contamination', async drift => {
        clock(); let mutations = 0; const sqlite = await openSqliteHost(seed(), client => ({ ...client, run: async (...args) => { mutations++; return client.run(...args); } }));
        try {
            const host = methods(); const deletion = await prepare(host); value(await host.commitPreparedArchivedTasksDelete(deletion)); const undo = await prepareUndo(host, deletion);
            if (drift === 'delete') await sqlite.client().run('DELETE FROM native_request_receipts WHERE request_id = ?', [DELETE_ID]);
            else if (drift === 'method') await sqlite.client().run('UPDATE native_request_receipts SET method = ? WHERE request_id = ?', ['referenceTasksDelete:00000000000000000000000000000000', DELETE_ID]);
            else if (drift === 'reply') await sqlite.client().run('UPDATE native_request_receipts SET reply = ? WHERE request_id = ?', [JSON.stringify({ count: 999 }), DELETE_ID]);
            else await sqlite.client().run('UPDATE native_request_receipts SET saved_at = ? WHERE request_id = ?', ['not-a-canonical-date', DELETE_ID]);
            expect(value(host.archivedTasksDeleteOutcome(deletion))).not.toBeNull(); const before = await raw(sqlite); const proof = await receipts(sqlite); const count = mutations;
            expect(await host.commitPreparedArchivedTasksDeleteUndo(undo)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(mutations).toBe(count); expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual(proof);
            expect(await useTaskStore.getState().updateTask('sibling', { title: 'Unrelated edit' })).toEqual({ success: true }); await flushPendingSave();
            expect(useTaskStore.getState().persistenceFailure).toBeNull(); expect(await sqlite.receiptIds()).not.toContain(UNDO_ID);
        } finally { await sqlite.close(); }
    });

    it('fails closed on current durable receipt query errors before landing; exact retry applies once and saved own receipt skips proof', async () => {
        clock(); let fault = false; const sqlite = await openSqliteHost(seed(), client => ({ ...client, all: async (...args) => {
            if (fault && args[0].includes('FROM native_request_receipts WHERE request_id')) throw new Error('injected proof read failure'); return client.all(...args);
        } }));
        try {
            const host = methods(); const deletion = await prepare(host); value(await host.commitPreparedArchivedTasksDelete(deletion)); const undo = await prepareUndo(host, deletion); const before = await raw(sqlite);
            fault = true; expect(await host.commitPreparedArchivedTasksDeleteUndo(undo)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); fault = false;
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([DELETE_ID]); expect(value(host.archivedTasksDeleteUndoOutcome(undo))).toBeNull();
            value(await host.commitPreparedArchivedTasksDeleteUndo(undo)); const after = await raw(sqlite); const proof = await receipts(sqlite);
            fault = true; expect(value(await host.commitPreparedArchivedTasksDeleteUndo(undo))).toEqual({ count: 1 }); fault = false;
            expect(await raw(sqlite)).toEqual(after); expect(await receipts(sqlite)).toEqual(proof);
        } finally { fault = false; await sqlite.close(); }
    });

    it.each(['delete', 'replace', 'queryError'] as const)('rolls back the actual domain transaction after original receipt %s race, then retries its exact owned Undo', async drift => {
        clock(); let race = false; let preflightRead = false; let transactionReadFailure = false; let inTransaction = false; let transactionProofReads = 0;
        const sqlite = await openSqliteHost(seed(), client => ({ ...client, all: async (...args) => {
            const prerequisiteQuery = args[0].includes('FROM native_request_receipts WHERE request_id');
            if (prerequisiteQuery && inTransaction) transactionProofReads++;
            if (transactionReadFailure && prerequisiteQuery) throw new Error('injected transactional proof failure');
            const result = await client.all(...args); if (race && prerequisiteQuery) preflightRead = true; return result;
        }, run: async (sql, params) => {
            if (race && preflightRead && sql === 'BEGIN IMMEDIATE') { race = false;
                if (drift === 'delete') await client.run('DELETE FROM native_request_receipts WHERE request_id = ?', [DELETE_ID]);
                else if (drift === 'replace') await client.run('UPDATE native_request_receipts SET reply = ? WHERE request_id = ?', [JSON.stringify({ count: 999 }), DELETE_ID]);
                else transactionReadFailure = true;
            }
            const result = await client.run(sql, params);
            if (sql === 'BEGIN IMMEDIATE') inTransaction = true; else if (sql === 'COMMIT' || sql === 'ROLLBACK') inTransaction = false;
            return result;
        } }));
        try {
            let host = methods(); const deletion = await prepare(host); value(await host.commitPreparedArchivedTasksDelete(deletion)); const undo = await prepareUndo(host, deletion);
            const original = (await sqlite.sql<{ request_id: string; method: string; reply: string; saved_at: string }>('SELECT * FROM native_request_receipts WHERE request_id = ?', [DELETE_ID]))[0];
            await sqlite.sql('PRAGMA wal_checkpoint(TRUNCATE)'); const checkpoint = join(sqlite.dir, 'transaction-before.db'); copyFileSync(join(sqlite.dir, 'mindwtr.db'), checkpoint);
            value(await host.commitPreparedArchivedTasksDeleteUndo(undo)); const normal = await raw(sqlite); const normalReceipts = await receipts(sqlite);
            await sqlite.restart(checkpoint, { recoveryLoad: true }); host = methods(); const before = await raw(sqlite);
            expect(await sqlite.receiptIds()).toEqual([DELETE_ID]); transactionProofReads = 0; race = true;
            expect(await host.commitPreparedArchivedTasksDeleteUndo(undo)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            transactionReadFailure = false; expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual(drift === 'delete' ? [] : [DELETE_ID]);
            expect(preflightRead).toBe(true); expect(race).toBe(false); expect(transactionProofReads).toBeGreaterThan(0); expect(inTransaction).toBe(false);
            expect(value(host.archivedTasksDeleteUndoOutcome(undo))).toBeNull();
            await sqlite.client().run('INSERT INTO native_request_receipts (request_id,method,reply,saved_at) VALUES(?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET method=excluded.method,reply=excluded.reply,saved_at=excluded.saved_at',
                [original.request_id, original.method, original.reply, original.saved_at]);
            value(await host.commitPreparedArchivedTasksDeleteUndo(undo)); expect(await raw(sqlite)).toEqual(normal); expect(await receipts(sqlite)).toEqual(normalReceipts);
            await sqlite.client().run('DELETE FROM native_request_receipts WHERE request_id = ?', [DELETE_ID]);
            expect(await useTaskStore.getState().updateTask('sibling', { title: 'Unrelated after success' })).toEqual({ success: true }); await flushPendingSave();
            expect(useTaskStore.getState().persistenceFailure).toBeNull(); const later = await raw(sqlite);
            expect(value(await host.commitPreparedArchivedTasksDeleteUndo(undo))).toEqual({ count: 1 }); expect(await raw(sqlite)).toEqual(later);
        } finally { race = false; transactionReadFailure = false; await sqlite.close(); }
    }, 15_000);

    it('retains byte-exact old Archive and Done canonical Delete/Undo fingerprints and complete receipt columns', async () => {
        clock(); const sqlite = await openSqliteHost({ ...seed(), tasks: [source('archive', { status: 'archived', archivedAt: BEFORE }), source('done', { status: 'done', completedAt: BEFORE })] });
        try {
            const host = methods(); const expected: { request_id: string; method: string; reply: string; saved_at: string }[] = [];
            for (const [index, id] of ['archive', 'done'].entries()) {
                const input = { requestId: `00000000-0000-4000-8000-00000000019${4 + index * 2}`, taskIds: [id], taskRevisions: { [id]: taskRevisionOf(useTaskStore.getState()._tasksById.get(id)!) }, ...(id === 'done' ? { source: 'done' as const } : {}) };
                const deletion = { request: input, prepared: value(await host.prepareArchivedTasksDelete(input)).prepared };
                expect(Object.keys(deletion.prepared).sort()).toEqual(['version', 'request', 'before', 'after', 'deviceIdBefore', 'deviceIdToInitialize', 'updateAt', 'result', ...(id === 'done' ? ['projects'] : [])].sort());
                value(await host.commitPreparedArchivedTasksDelete(deletion)); const undo = await prepareUndo(host, deletion, `00000000-0000-4000-8000-00000000019${5 + index * 2}`); value(await host.commitPreparedArchivedTasksDeleteUndo(undo));
                const prefix = id === 'done' ? 'doneTasks' : 'archivedTasks';
                expected.push({ request_id: deletion.request.requestId, method: receiptMethod(`${prefix}Delete`, deletion), reply: JSON.stringify(deletion.prepared.result), saved_at: NOW },
                    { request_id: undo.request.requestId, method: receiptMethod(`${prefix}DeleteUndo`, undo), reply: JSON.stringify(undo.prepared.result), saved_at: NOW });
            }
            expect(await sqlite.sql('SELECT request_id,method,reply,saved_at FROM native_request_receipts ORDER BY request_id')).toEqual(expected);
            await sqlite.restart(undefined, { recoveryLoad: true }); expect(await sqlite.sql('SELECT request_id,method,reply,saved_at FROM native_request_receipts ORDER BY request_id')).toEqual(expected);
        } finally { await sqlite.close(); }
    });

    it.each(['deleted', 'purged', 'missing'] as const)('matches actual RN restore sanitizer after %s parent change without resurrection', async lifecycle => {
        clock(); const change = async (sqlite: Awaited<ReturnType<typeof openSqliteHost>>) => {
            if (lifecycle === 'missing') { await sqlite.client().exec('PRAGMA foreign_keys = OFF'); await sqlite.client().run('DELETE FROM projects WHERE id = ?', ['parent-b']); await sqlite.client().exec('PRAGMA foreign_keys = ON'); }
            else await sqlite.client().run('UPDATE projects SET deletedAt = ?, purgedAt = ? WHERE id = ?', [NOW, lifecycle === 'purged' ? NOW : null, 'parent-b']);
        };
        const rn = await openSqliteHost(seed()); let expected; let expectedRaw;
        try {
            await canonical(); expect(await useTaskStore.getState().batchDeleteTasks(['source'])).toEqual({ success: true }); await flushPendingSave(); await change(rn); await rn.restart(undefined, { recoveryLoad: true });
            expect(await useTaskStore.getState().restoreTask('source')).toEqual({ success: true }); await flushPendingSave(); expected = rows(); expectedRaw = await raw(rn);
        } finally { await rn.close(); }
        const sqlite = await openSqliteHost(seed());
        try {
            await canonical(); const host = methods(); const deletion = await prepare(host); value(await host.commitPreparedArchivedTasksDelete(deletion)); await change(sqlite);
            const undo = await prepareUndo(host, deletion); expect(undo.prepared.after[0].status).toBe('reference'); expect(undo.prepared.after[0].projectId).toBeUndefined();
            value(await host.commitPreparedArchivedTasksDeleteUndo(undo)); expect(rows()).toEqual(expected); expect(await raw(sqlite)).toEqual(expectedRaw);
        } finally { await sqlite.close(); }
    });

    it.each([1_050_000, 550_000])('refuses oversized Delete or prospective nested Undo %i before mutation', async length => {
        clock(); const sqlite = await openSqliteHost({ ...seed(), tasks: [source('source', { description: 'x'.repeat(length) })] });
        try {
            const before = await raw(sqlite); expect(await methods().prepareArchivedTasksDelete(request())).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('select fewer') } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('rechecks whole selected raw rows, device and Undo container scope while preserving unrelated row edits', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const host = methods(); const stale = await prepare(host); await sqlite.client().run('UPDATE tasks SET focusOrder = 3 WHERE id = ?', ['source']); const changed = await raw(sqlite);
            expect(await host.commitPreparedArchivedTasksDelete(stale)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } }); expect(await raw(sqlite)).toEqual(changed);
            const deletion = await prepare(host); await sqlite.client().run('UPDATE tasks SET description = ? WHERE id = ?', ['Later sibling', 'sibling']);
            value(await host.commitPreparedArchivedTasksDelete(deletion)); expect((await raw(sqlite)).tasks.rows.find((r) => r.id === 'sibling')?.description).toBe('Later sibling');
            const undo = await prepareUndo(host, deletion); await sqlite.client().run('UPDATE projects SET title = ? WHERE id = ?', ['Changed container', 'parent-b']); const before = await raw(sqlite);
            expect(await host.commitPreparedArchivedTasksDeleteUndo(undo)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } }); expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([DELETE_ID]);
            const freshUndo = await prepareUndo(host, deletion); await sqlite.client().run("UPDATE settings SET data = json_set(data, '$.deviceId', ?) WHERE id = 1", ['different-device']); const device = await raw(sqlite);
            expect(await host.commitPreparedArchivedTasksDeleteUndo(freshUndo)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } }); expect(await raw(sqlite)).toEqual(device);
        } finally { await sqlite.close(); }
    });

    it.each(['archived', 'deleted', 'purged'] as const)('refuses any selected Reference task under a %s parent without partial writes', async lifecycle => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            if (lifecycle === 'archived') await sqlite.client().run('UPDATE projects SET status = ? WHERE id = ?', ['archived', 'parent-b']);
            else await sqlite.client().run('UPDATE projects SET deletedAt = ?, purgedAt = ? WHERE id = ?', [BEFORE, lifecycle === 'purged' ? BEFORE : null, 'parent-b']);
            await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite);
            expect(await methods().prepareArchivedTasksDelete(request(['source', 'rich']))).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it.each(['same-host', 'cold'] as const)('freezes missing device initialization across failed %s Delete and reuses it for Undo', async recovery => {
        clock(); let fault = false; const sqlite = await openSqliteHost(seed(), client => ({ ...client, run: async (...args) => {
            if (fault && args[0] === 'COMMIT') throw new Error('injected COMMIT'); return client.run(...args);
        } }));
        try {
            await sqlite.client().run("UPDATE settings SET data = json_remove(data, '$.deviceId') WHERE id = 1"); await sqlite.restart(undefined, { recoveryLoad: true }); let host = methods(); const deletion = clone(await prepare(host));
            expect(deletion.prepared.deviceIdBefore).toBeNull(); expect(deletion.prepared.deviceIdToInitialize).toMatch(/^[0-9a-f-]{36}$/); const before = await raw(sqlite);
            fault = true; expect(await host.commitPreparedArchivedTasksDelete(deletion)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); expect(await raw(sqlite)).toEqual(before);
            fault = false; if (recovery === 'cold') { await sqlite.restart(undefined, { recoveryLoad: true }); host = methods(); }
            value(await host.commitPreparedArchivedTasksDelete(deletion)); const undo = await prepareUndo(host, deletion); expect(undo.prepared.deviceIdBefore).toBe(deletion.prepared.deviceIdToInitialize); expect(undo.prepared.deviceIdToInitialize).toBeNull();
            value(await host.commitPreparedArchivedTasksDeleteUndo(undo)); await sqlite.restart(undefined, { recoveryLoad: true }); expect(useTaskStore.getState().settings.deviceId).toBe(deletion.prepared.deviceIdToInitialize);
            expect(value(methods().archivedTasksDeleteUndoOutcome(undo))).toEqual({ count: 1 }); expect(await sqlite.receiptIds()).toEqual([DELETE_ID, UNDO_ID]);
        } finally { fault = false; await sqlite.close(); }
    }, 25_000);


    it.each([false, true])('binds operated raw Task attachment member presence direction %s across host recreation', async explicitBefore => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const attachment = { id: 'task-link', kind: 'link', title: 'Fixture', uri: 'https://example.com', createdAt: BEFORE };
            await sqlite.client().run('UPDATE tasks SET attachments = ? WHERE id = ?', [JSON.stringify([{ ...attachment, ...(explicitBefore ? { updatedAt: '' } : {}) }]), 'source']);
            await sqlite.restart(undefined, { recoveryLoad: true }); const deletion = clone(await prepare());
            expect(Object.hasOwn(deletion.prepared.before[0].attachments![0], 'updatedAt')).toBe(explicitBefore);
            await sqlite.client().run('UPDATE tasks SET attachments = ? WHERE id = ?', [JSON.stringify([{ ...attachment, ...(!explicitBefore ? { updatedAt: '' } : {}) }]), 'source']);
            await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite); const memory = useTaskStore.getState();
            expect(await methods().commitPreparedArchivedTasksDelete(deletion)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(useTaskStore.getState()._allTasks).toBe(memory._allTasks); expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });


    it('matches actual RN operated legacy attachment/default arrays without changing raw siblings or parent rows', async () => {
        clock(); const configure = async (sqlite: Awaited<ReturnType<typeof openSqliteHost>>) => {
            await canonical(); await sqlite.client().run('UPDATE tasks SET attachments = ?, tags = NULL, contexts = NULL WHERE id = ?',
                [JSON.stringify([{ id: 'raw-link', kind: 'link', title: 'Fixture', uri: 'https://example.com', createdAt: BEFORE }]), 'source']);
            await sqlite.restart(undefined, { recoveryLoad: true });
        };
        const rn = await openSqliteHost(seed()); let deleted; let deletedRaw; let restored; let restoredRaw;
        try {
            await configure(rn); expect(await useTaskStore.getState().batchDeleteTasks(['source'])).toEqual({ success: true }); await flushPendingSave(); deleted = rows(); deletedRaw = await raw(rn);
            expect(await useTaskStore.getState().restoreTask('source')).toEqual({ success: true }); await flushPendingSave(); restored = rows(); restoredRaw = await raw(rn);
        } finally { await rn.close(); }
        const sqlite = await openSqliteHost(seed());
        try {
            await configure(sqlite); const host = methods(); const deletion = await prepare(host); const before = await raw(sqlite);
            expect(Object.hasOwn(deletion.prepared.before[0], 'tags')).toBe(false); expect(Object.hasOwn(deletion.prepared.before[0], 'contexts')).toBe(false);
            expect(Object.hasOwn(deletion.prepared.before[0].attachments![0], 'updatedAt')).toBe(false);
            value(await host.commitPreparedArchivedTasksDelete(deletion)); expect(rows()).toEqual(deleted); expect(await raw(sqlite)).toEqual(deletedRaw);
            value(await host.commitPreparedArchivedTasksDeleteUndo(await prepareUndo(host, deletion))); expect(rows()).toEqual(restored); expect(await raw(sqlite)).toEqual(restoredRaw);
            expect((await raw(sqlite)).projects).toEqual(before.projects);
        } finally { await sqlite.close(); }
    });


    it('disarms a Reference Undo prerequisite when the existing writer refuses before landing, allowing an unrelated writer', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const host = methods(); const deletion = await prepare(host); value(await host.commitPreparedArchivedTasksDelete(deletion)); const undo = await prepareUndo(host, deletion);
            const before = await raw(sqlite); const state = useTaskStore.getState();
            const writer = vi.spyOn(state, 'commitPreparedArchivedTasksMutation').mockResolvedValueOnce({ success: false, reason: 'conflict', error: 'Fixture refusal' });
            expect(await host.commitPreparedArchivedTasksDeleteUndo(undo)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } }); writer.mockRestore();
            expect(useTaskStore.getState()._allTasks).toBe(state._allTasks); expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([DELETE_ID]);
            await sqlite.client().run('DELETE FROM native_request_receipts WHERE request_id = ?', [DELETE_ID]);
            expect(await useTaskStore.getState().updateTask('sibling', { title: 'Independent' })).toEqual({ success: true }); await flushPendingSave();
            expect(useTaskStore.getState().persistenceFailure).toBeNull(); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { vi.restoreAllMocks(); await sqlite.close(); }
    });

    it('rechecks current durable origin on an owed save retry, retaining exact Undo until original proof is restored', async () => {
        clock(); let fault = false; const sqlite = await openSqliteHost(seed(), client => ({ ...client, run: async (...args) => {
            if (fault && args[0] === 'COMMIT') throw new Error('injected COMMIT'); return client.run(...args);
        } }));
        try {
            const host = methods(); const deletion = await prepare(host); value(await host.commitPreparedArchivedTasksDelete(deletion)); const undo = await prepareUndo(host, deletion);
            const original = (await sqlite.sql<{ request_id: string; method: string; reply: string; saved_at: string }>('SELECT * FROM native_request_receipts WHERE request_id = ?', [DELETE_ID]))[0];
            const deleted = await raw(sqlite); fault = true; expect(await host.commitPreparedArchivedTasksDeleteUndo(undo)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); fault = false;
            await sqlite.client().run('DELETE FROM native_request_receipts WHERE request_id = ?', [DELETE_ID]);
            expect(await host.commitPreparedArchivedTasksDeleteUndo(undo)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(deleted); expect(await sqlite.receiptIds()).toEqual([]); expect(value(host.archivedTasksDeleteUndoOutcome(undo))).toBeNull();
            await sqlite.client().run('INSERT INTO native_request_receipts (request_id,method,reply,saved_at) VALUES(?,?,?,?)', [original.request_id, original.method, original.reply, original.saved_at]);
            expect(value(await host.commitPreparedArchivedTasksDeleteUndo(undo))).toEqual({ count: 1 }); expect(await sqlite.receiptIds()).toEqual([DELETE_ID, UNDO_ID]);
        } finally { fault = false; await sqlite.close(); }
    }, 15_000);


    it.each(['taskAttachments', 'taskRecurrence', 'projectAttachments'] as const)('fails closed on initially corrupt raw %s without any SQL writes or default replacement', async field => {
        clock(); let mutations = 0; const sqlite = await openSqliteHost(seed(), client => ({ ...client, run: async (...args) => { mutations++; return client.run(...args); } }));
        try {

            await sqlite.client().run(`DROP TRIGGER ${field === 'projectAttachments' ? 'projects' : 'tasks'}_validate_update`);
            await sqlite.client().run(field === 'projectAttachments' ? 'UPDATE projects SET attachments = ? WHERE id = ?'
                : `UPDATE tasks SET ${field === 'taskAttachments' ? 'attachments' : 'recurrence'} = ? WHERE id = ?`, ['{broken', field === 'projectAttachments' ? 'parent-b' : 'source']);
            await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite); const count = mutations;
            expect(await methods().prepareArchivedTasksDelete(request())).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(mutations).toBe(count); expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it.each(['taskAttachments', 'taskRecurrence', 'projectAttachments'] as const)('refuses raw %s corruption after preparation across cold host recreation without overwriting cells', async field => {
        clock(); let mutations = 0; const sqlite = await openSqliteHost(seed(), client => ({ ...client, run: async (...args) => { mutations++; return client.run(...args); } }));
        try {
            const deletion = clone(await prepare());
            await sqlite.client().run(`DROP TRIGGER ${field === 'projectAttachments' ? 'projects' : 'tasks'}_validate_update`);
            await sqlite.client().run(field === 'projectAttachments' ? 'UPDATE projects SET attachments = ? WHERE id = ?'
                : `UPDATE tasks SET ${field === 'taskAttachments' ? 'attachments' : 'recurrence'} = ? WHERE id = ?`, ['{broken', field === 'projectAttachments' ? 'parent-b' : 'source']);
            await sqlite.restart(undefined, { recoveryLoad: true }); const before = await raw(sqlite); const count = mutations; const memory = useTaskStore.getState();
            expect(await methods().commitPreparedArchivedTasksDelete(deletion)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(mutations).toBe(count); expect(useTaskStore.getState()._allTasks).toBe(memory._allTasks); expect(useTaskStore.getState()._allProjects).toBe(memory._allProjects);
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('fails closed on corrupt raw Undo parent scope before preparation or current commit without weakening original receipt proof', async () => {
        clock(); let mutations = 0; const sqlite = await openSqliteHost(seed(), client => ({ ...client, run: async (...args) => { mutations++; return client.run(...args); } }));
        try {
            const host = methods(); const deletion = await prepare(host); value(await host.commitPreparedArchivedTasksDelete(deletion)); const undo = clone(await prepareUndo(host, deletion));
            await sqlite.client().run('DROP TRIGGER projects_validate_update');
            await sqlite.client().run('UPDATE projects SET attachments = ? WHERE id = ?', ['{broken', 'parent-b']); await sqlite.restart(undefined, { recoveryLoad: true });
            const before = await raw(sqlite); const proof = await receipts(sqlite); const count = mutations;
            expect(await methods().prepareArchivedTasksDeleteUndo({ request: undo.request, delete: deletion })).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await methods().commitPreparedArchivedTasksDeleteUndo(undo)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(mutations).toBe(count); expect(await raw(sqlite)).toEqual(before); expect(await receipts(sqlite)).toEqual(proof);
        } finally { await sqlite.close(); }
    });

});
