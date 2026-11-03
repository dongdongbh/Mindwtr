import { afterEach, describe, expect, it, vi } from 'vitest';
import { createArchivedTasksDeleteMethods, type NativeArchivedTasksDeleteEnvelope, type NativeArchivedTasksDeleteUndoEnvelope } from './native-host-contract-archive-bulk-delete';
import { buildSaveSnapshot } from './store-helpers';
import { taskRevisionOf } from './native-request-receipts';
import { openSqliteHost } from './screen-parity.replay';
import { flushPendingSave, getStorageAdapter, resetForTests, useTaskStore } from './store';
import type { Task } from './types';
import { deterministicHash128 } from './uuid';


vi.setConfig({ testTimeout: 30_000 });

const NOW = '2026-10-02T13:00:00.000Z';
const BEFORE = '2026-09-30T12:34:56.789Z';
const DEVICE = 'done-delete-device';
const DELETE_ID = '00000000-0000-4000-8000-000000000182';
const UNDO_ID = '00000000-0000-4000-8000-000000000183';
const source = (id = 'source', fields: Partial<Task> = {}): Task => ({ id, title: 'Retained fixture', status: 'done',
    createdAt: BEFORE, updatedAt: BEFORE, completedAt: BEFORE, tags: [], contexts: [], rev: 3, revBy: DEVICE, ...fields });
const seed = () => ({ tasks: [source('rich', { projectId: 'parent-a', sectionId: 'section',
    recurrence: { rule: 'daily', strategy: 'strict', seriesId: 'series' }, timeSpentMinutes: 45,
    checklist: [{ id: 'step', title: 'Step', isCompleted: true }],
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
const request = (taskIds = ['source'], requestId = DELETE_ID) => ({ requestId, source: 'done' as const, taskIds,
    taskRevisions: Object.fromEntries(taskIds.map((id) => [id, taskRevisionOf(useTaskStore.getState()._tasksById.get(id)!)])) });
const prepare = async (host = methods(), input = request()) => ({ request: input, prepared: value(await host.prepareArchivedTasksDelete(input)).prepared });
const prepareUndo = async (host: ReturnType<typeof methods>, deletion: NativeArchivedTasksDeleteEnvelope, requestId = UNDO_ID) => {
    const input = { requestId, deleteRequestId: deletion.request.requestId };
    return { request: input, prepared: value(await host.prepareArchivedTasksDeleteUndo({ request: input, delete: deletion })).prepared };
};
const rows = () => clone(buildSaveSnapshot(useTaskStore.getState()));
const canonical = async () => getStorageAdapter().saveData(buildSaveSnapshot(useTaskStore.getState()));

const receiptMethod = (prefix: string, envelope: unknown) => {
    const payload = JSON.stringify([prefix, envelope], (_name, item) => item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
    return `${prefix}:${deterministicHash128(payload).map((part) => part.toString(16).padStart(8, '0')).join('')}`;
};

const raw = async (sqlite: Awaited<ReturnType<typeof openSqliteHost>>) => Object.fromEntries(await Promise.all([
    'tasks', 'projects', 'sections', 'areas', 'people', 'settings', 'saved_filters', 'schema_migrations', 'calendar_sync',
].map(async (table) => [table, await sqlite.sql(`SELECT rowid AS _rowid, * FROM ${table} ORDER BY rowid`)])));
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); });
const clock = () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); };

describe('guarded Done bulk Delete and Undo', () => {
    it('matches actual RN batchDeleteTasks and Promise.all restoreTask full AppData and all nine canonical SQLite tables', async () => {
        clock(); const selected = ['source', 'rich'];
        const rn = await openSqliteHost(seed()); let deleted; let deletedRaw; let restored; let restoredRaw;
        try {
            await canonical(); expect(await useTaskStore.getState().batchDeleteTasks(selected)).toEqual({ success: true });
            await flushPendingSave(); deleted = rows(); deletedRaw = await raw(rn);
            vi.setSystemTime(new Date('2026-10-02T13:01:00.000Z'));
            expect(await Promise.all(selected.map((id) => useTaskStore.getState().restoreTask(id))))
                .toEqual([{ success: true }, { success: true }]);
            await flushPendingSave(); restored = rows(); restoredRaw = await raw(rn);
        } finally { await rn.close(); }
        vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try {
            await canonical(); const host = methods(); const deletion = await prepare(host, request(selected));
            expect(deletion.prepared.projects?.map((row) => row.id)).toEqual(['parent-a', 'parent-b']);
            expect(value(await host.commitPreparedArchivedTasksDelete(deletion)).count).toBe(2);
            expect(rows()).toEqual(deleted); expect(await raw(sqlite)).toEqual(deletedRaw);
            vi.setSystemTime(new Date('2026-10-02T13:01:00.000Z'));
            const undo = await prepareUndo(host, deletion); expect(value(await host.commitPreparedArchivedTasksDeleteUndo(undo))).toEqual({ count: 2 });
            expect(rows()).toEqual(restored); expect(await raw(sqlite)).toEqual(restoredRaw);
            expect(await sqlite.receiptIds()).toEqual([DELETE_ID, UNDO_ID]);
        } finally { await sqlite.close(); }
    });

    it('refuses malformed and ineligible selections atomically; the shared predicate permits missing parents', async () => {
        clock(); const sqlite = await openSqliteHost({ ...seed(), tasks: [...seed().tasks,
            source('archived', { status: 'archived' }), source('deleted', { deletedAt: BEFORE }), source('purged', { deletedAt: BEFORE, purgedAt: BEFORE })] });
        try {
            const host = methods(); const input = request(); const before = await raw(sqlite);
            for (const invalid of [{ ...input, source: 'archive' }, { ...input, source: null }, { ...input, taskIds: [] },
                { ...input, taskIds: ['source', 'source'] }, { ...input, taskRevisions: { source: 'stale' } },
                { ...input, taskRevisions: { ...input.taskRevisions, extra: 'revision' } }, { ...input, requestId: 'bad' },
                request(['archived']), request(['deleted']), request(['purged']),
                { ...input, taskIds: ['missing'], taskRevisions: { missing: 'revision' } },
                { ...input, taskIds: ['recurring_projection'], taskRevisions: { recurring_projection: 'revision' } }])
                expect(await host.prepareArchivedTasksDelete(invalid as never)).toMatchObject({ ok: false });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            for (const lifecycle of ['archived', 'deleted'] as const) {
                await sqlite.client().run(lifecycle === 'archived' ? 'UPDATE projects SET status = ? WHERE id = ?'
                    : 'UPDATE projects SET status = ?, deletedAt = ? WHERE id = ?',
                lifecycle === 'archived' ? ['archived', 'parent-b'] : ['active', NOW, 'parent-b']);
                await sqlite.restart(undefined, { recoveryLoad: true }); const protectedState = await raw(sqlite);
                expect(await methods().prepareArchivedTasksDelete(request(['source', 'rich']))).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
                expect(await raw(sqlite)).toEqual(protectedState);
            }
            await sqlite.client().exec('PRAGMA foreign_keys = OFF');
            await sqlite.client().run('DELETE FROM projects WHERE id = ?', ['parent-b']);
            await sqlite.client().exec('PRAGMA foreign_keys = ON');
            await sqlite.restart(undefined, { recoveryLoad: true });
            const missing = await prepare(); expect(missing.prepared.projects).toEqual([]);
            expect(value(methods().validatePreparedArchivedTasksDelete(missing)).count).toBe(1);
        } finally { await sqlite.close(); }
    });

    it('rejects forged and cross-source Delete/Undo envelopes before any SQLite operation', async () => {
        clock(); const sql = vi.fn(); const sqlite = await openSqliteHost(seed(), (client) => ({ ...client,
            all: async (query, params) => { sql(query); return client.all(query, params); },
            run: async (query, params) => { sql(query); return client.run(query, params); },
            exec: async (query) => { sql(query); return client.exec(query); },
            get: async (query, params) => { sql(query); return client.get(query, params); },
        }));
        try {
            const host = methods(); const deletion = await prepare(host);
            const mutations = [(item: NativeArchivedTasksDeleteEnvelope) => { delete item.request.source; delete item.prepared.request.source; delete item.prepared.projects; },
                (item: NativeArchivedTasksDeleteEnvelope) => { delete item.prepared.projects; },
                (item: NativeArchivedTasksDeleteEnvelope) => { item.prepared.projects!.push(clone(item.prepared.projects![0])); },
                (item: NativeArchivedTasksDeleteEnvelope) => { item.prepared.projects![0].status = 'archived'; },
                (item: NativeArchivedTasksDeleteEnvelope) => { item.prepared.projects![0].id = 'unrelated'; },
                (item: NativeArchivedTasksDeleteEnvelope) => { item.prepared.after[0].status = 'inbox'; },
                (item: NativeArchivedTasksDeleteEnvelope) => { item.prepared.result.count = 99; },
                (item: NativeArchivedTasksDeleteEnvelope) => { item.prepared.request.source = undefined; }];
            for (const mutate of mutations) {
                const forged = clone(deletion); mutate(forged); sql.mockClear();
                expect(host.validatePreparedArchivedTasksDelete(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(await host.commitPreparedArchivedTasksDelete(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(sql).not.toHaveBeenCalled();
            }
            value(await host.commitPreparedArchivedTasksDelete(deletion)); const undo = await prepareUndo(host, deletion);
            for (const mutate of [(item: NativeArchivedTasksDeleteUndoEnvelope) => { delete item.prepared.delete.request.source; delete item.prepared.delete.prepared.request.source; delete item.prepared.delete.prepared.projects; },
                (item: NativeArchivedTasksDeleteUndoEnvelope) => { item.prepared.after[0].completedAt = NOW; }]) {
                const forged = clone(undo); mutate(forged); sql.mockClear();
                expect(host.validatePreparedArchivedTasksDeleteUndo(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(await host.commitPreparedArchivedTasksDeleteUndo(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(sql).not.toHaveBeenCalled();
            }
        } finally { await sqlite.close(); }
    });

    it.each(['first', 'retry'] as const)('guards complete referenced raw parent scope on %s commit even without a task revision change', async (phase) => {
        clock(); const fault = { commits: 0 }; const sqlite = await openSqliteHost(seed(), (client) => ({ ...client,
            run: async (sql, params) => { if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('injected COMMIT failure'); }
                return client.run(sql, params); },
        }));
        try {
            const host = methods(); const deletion = await prepare(host);
            if (phase === 'retry') { fault.commits = 10; expect(await host.commitPreparedArchivedTasksDelete(deletion)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); fault.commits = 0; }
            await sqlite.client().run('UPDATE projects SET supportNotes = ? WHERE id = ?', ['Later exact context', 'parent-b']); const before = await raw(sqlite);
            expect(await host.commitPreparedArchivedTasksDelete(deletion)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { fault.commits = 0; await sqlite.close(); }
    });

    it('binds exact raw selected rows and Undo scope while retaining unrelated parent and sibling edits', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const host = methods(); const stale = await prepare(host);


            const omittedParent = clone(stale); omittedParent.prepared.projects = [];
            expect(host.validatePreparedArchivedTasksDelete(omittedParent).ok).toBe(true);
            const initial = await raw(sqlite);
            expect(await host.commitPreparedArchivedTasksDelete(omittedParent)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(initial); expect(await sqlite.receiptIds()).toEqual([]);
            await sqlite.client().run('UPDATE tasks SET focusOrder = 3 WHERE id = ?', ['source']); const before = await raw(sqlite);
            expect(await host.commitPreparedArchivedTasksDelete(stale)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); const deletion = await prepare(host);
            await sqlite.client().run('UPDATE projects SET title = ? WHERE id = ?', ['Unrelated parent', 'parent-a']);
            await sqlite.client().run('UPDATE tasks SET description = ? WHERE id = ?', ['Later sibling', 'sibling']);
            value(await host.commitPreparedArchivedTasksDelete(deletion));
            expect((await sqlite.sql<{ description: string }>('SELECT description FROM tasks WHERE id = ?', ['sibling']))[0].description).toBe('Later sibling');
            const undo = await prepareUndo(host, deletion); await sqlite.client().run('UPDATE projects SET status = ? WHERE id = ?', ['archived', 'parent-b']); const edited = await raw(sqlite);
            expect(await host.commitPreparedArchivedTasksDeleteUndo(undo)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(edited); expect(await sqlite.receiptIds()).toEqual([DELETE_ID]);
        } finally { await sqlite.close(); }
    });

    it.each(['same-host', 'cold'] as const)('recovers twice-failed Delete and Undo through %s exact retry, preserving raw unrelated NULL cells', async (recovery) => {
        clock(); const fault = { commits: 0 }; const sqlite = await openSqliteHost(seed(), (client) => ({ ...client,
            run: async (sql, params) => { if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('injected COMMIT failure'); }
                return client.run(sql, params); },
        }));
        try {
            await sqlite.client().run('UPDATE tasks SET focusOrder = 2, pushCount = NULL WHERE id IN (?, ?)', ['source', 'sibling']);
            await sqlite.restart(undefined, { recoveryLoad: true }); let host = methods(); const deletion = clone(await prepare(host)); const before = await raw(sqlite);
            expect(deletion.prepared.before[0]).toMatchObject({ focusOrder: 2 }); expect(deletion.prepared.before[0].pushCount).toBeUndefined();
            for (let attempt = 0; attempt < 2; attempt++) {
                fault.commits = 10; expect(await host.commitPreparedArchivedTasksDelete(deletion)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
                expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]); expect(value(host.archivedTasksDeleteOutcome(deletion))).toBeNull();
            }
            fault.commits = 0;
            if (recovery === 'cold') { await sqlite.restart(undefined, { recoveryLoad: true }); host = methods(); }
            value(await host.commitPreparedArchivedTasksDelete(deletion)); const deleted = await raw(sqlite); const undo = clone(await prepareUndo(host, deletion));
            for (let attempt = 0; attempt < 2; attempt++) {
                fault.commits = 10; expect(await host.commitPreparedArchivedTasksDeleteUndo(undo)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
                expect(await raw(sqlite)).toEqual(deleted); expect(await sqlite.receiptIds()).toEqual([DELETE_ID]);
            }
            fault.commits = 0;
            if (recovery === 'cold') { await sqlite.restart(undefined, { recoveryLoad: true }); host = methods(); }
            value(await host.commitPreparedArchivedTasksDeleteUndo(undo)); const restored = await raw(sqlite);
            expect((restored.tasks as { id: string }[]).find((row) => row.id === 'sibling'))
                .toEqual((before.tasks as { id: string }[]).find((row) => row.id === 'sibling'));
            expect(await sqlite.receiptIds()).toEqual([DELETE_ID, UNDO_ID]);
            await sqlite.restart(undefined, { recoveryLoad: true }); expect(value(methods().archivedTasksDeleteUndoOutcome(undo))).toEqual({ count: 1 });
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 25_000);

    it('resolves exact lost/terminal receipts before later parent edits and preserves Archive receipt bytes', async () => {
        clock(); const sqlite = await openSqliteHost({ ...seed(), tasks: [...seed().tasks, source('archive', { status: 'archived', archivedAt: BEFORE })] });
        try {
            const host = methods(); const deletion = await prepare(host); const result = value(await host.commitPreparedArchivedTasksDelete(deletion));
            const undo = await prepareUndo(host, deletion); value(await host.commitPreparedArchivedTasksDeleteUndo(undo));
            const archiveRequest = { requestId: '00000000-0000-4000-8000-000000000184', taskIds: ['archive'],
                taskRevisions: { archive: taskRevisionOf(useTaskStore.getState()._tasksById.get('archive')!) } };
            const archive = { request: archiveRequest, prepared: value(await host.prepareArchivedTasksDelete(archiveRequest)).prepared };
            expect(Object.keys(archive.prepared).sort()).toEqual(['version', 'request', 'before', 'after', 'deviceIdBefore', 'deviceIdToInitialize', 'updateAt', 'result'].sort());
            value(await host.commitPreparedArchivedTasksDelete(archive));
            const archiveUndo = await prepareUndo(host, archive, '00000000-0000-4000-8000-000000000185');
            expect(Object.keys(archiveUndo.prepared).sort()).toEqual(['version', 'request', 'delete', 'before', 'after', 'scope', 'deviceIdBefore', 'deviceIdToInitialize', 'updateAt', 'result'].sort());
            value(await host.commitPreparedArchivedTasksDeleteUndo(archiveUndo));
            const receipts = await sqlite.sql<{ request_id: string; method: string }>('SELECT * FROM native_request_receipts ORDER BY request_id');
            expect(receipts.map((row) => row.method)).toEqual([receiptMethod('doneTasksDelete', deletion), receiptMethod('doneTasksDeleteUndo', undo),
                receiptMethod('archivedTasksDelete', archive), receiptMethod('archivedTasksDeleteUndo', archiveUndo)]);
            await sqlite.client().run('UPDATE tasks SET title = ?, rev = rev + 1 WHERE id = ?', ['Later selected', 'source']);
            await sqlite.client().run('UPDATE projects SET deletedAt = ? WHERE id = ?', [NOW, 'parent-b']);
            await sqlite.restart(undefined, { recoveryLoad: true }); const fresh = methods(); const before = await raw(sqlite);
            expect(value(await fresh.commitPreparedArchivedTasksDelete(deletion))).toEqual(result); expect(await raw(sqlite)).toEqual(before);
            expect(await sqlite.sql('SELECT * FROM native_request_receipts ORDER BY request_id')).toEqual(receipts);
            await sqlite.client().run('DELETE FROM native_request_receipts WHERE request_id = ?', [DELETE_ID]);
            await sqlite.restart(undefined, { recoveryLoad: true }); const terminal = methods(); const unchanged = await raw(sqlite);
            expect(value(await terminal.commitPreparedArchivedTasksDeleteUndo(undo))).toEqual({ count: 1 }); expect(await raw(sqlite)).toEqual(unchanged);
            expect(value(terminal.archivedTasksDeleteUndoOutcome(undo))).toEqual({ count: 1 });
        } finally { await sqlite.close(); }
    });

    it('refuses unused UUID equal-AFTER and missing Delete receipt as first Undo proof', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const host = methods(); const unused = await prepare(host);
            expect(await useTaskStore.getState().batchDeleteTasks(['source'])).toEqual({ success: true }); await flushPendingSave(); const before = await raw(sqlite);
            expect(await host.prepareArchivedTasksDeleteUndo({ request: { requestId: UNDO_ID, deleteRequestId: DELETE_ID }, delete: unused })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await host.commitPreparedArchivedTasksDelete(unused)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            const deletion = await prepare(host, request(['rich'])); value(await host.commitPreparedArchivedTasksDelete(deletion)); const undo = await prepareUndo(host, deletion);
            await sqlite.client().run('DELETE FROM native_request_receipts WHERE request_id = ?', [DELETE_ID]); await sqlite.restart(undefined, { recoveryLoad: true }); const deleted = await raw(sqlite);
            expect(await methods().commitPreparedArchivedTasksDeleteUndo(undo)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(deleted); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it.each(['same-host', 'cold'] as const)('initializes one frozen missing device after failed save and %s recovery; Undo reuses it', async (recovery) => {
        clock(); const fault = { commits: 0 }; const sqlite = await openSqliteHost(seed(), (client) => ({ ...client,
            run: async (sql, params) => { if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('injected COMMIT failure'); }
                return client.run(sql, params); },
        }));
        try {
            await sqlite.client().run("UPDATE settings SET data = json_remove(data, '$.deviceId') WHERE id = 1");
            await sqlite.restart(undefined, { recoveryLoad: true }); let host = methods(); const deletion = clone(await prepare(host));
            expect(useTaskStore.getState().settings.deviceId).toBeUndefined();
            expect(deletion.prepared.deviceIdBefore).toBeNull(); expect(deletion.prepared.deviceIdToInitialize).toMatch(/^[0-9a-f-]{36}$/);
            const before = await raw(sqlite); fault.commits = 10;
            expect(await host.commitPreparedArchivedTasksDelete(deletion)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); fault.commits = 0;
            if (recovery === 'cold') { await sqlite.restart(undefined, { recoveryLoad: true }); host = methods(); }
            value(await host.commitPreparedArchivedTasksDelete(deletion)); await sqlite.restart(undefined, { recoveryLoad: true }); host = methods();
            expect(useTaskStore.getState().settings.deviceId).toBe(deletion.prepared.deviceIdToInitialize);
            const undo = await prepareUndo(host, deletion); expect(undo.prepared.deviceIdBefore).toBe(deletion.prepared.deviceIdToInitialize); expect(undo.prepared.deviceIdToInitialize).toBeNull();
            expect(undo.prepared.after.every((row) => row.revBy === deletion.prepared.deviceIdToInitialize)).toBe(true);
            value(await host.commitPreparedArchivedTasksDeleteUndo(undo)); await sqlite.restart(undefined, { recoveryLoad: true });
            expect(useTaskStore.getState().settings.deviceId).toBe(deletion.prepared.deviceIdToInitialize);
            expect(value(methods().archivedTasksDeleteUndoOutcome(undo))).toEqual({ count: 1 }); expect(await sqlite.receiptIds()).toEqual([DELETE_ID, UNDO_ID]);
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 25_000);

    it.each([1_050_000, 550_000])('refuses complete Delete/prospective Undo oversized content %i before mutation', async (length) => {
        clock(); const sqlite = await openSqliteHost({ ...seed(), tasks: [source('source', { description: 'x'.repeat(length) })] });
        try {
            const before = await raw(sqlite); expect(await methods().prepareArchivedTasksDelete(request()))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('select fewer') } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('does not mint a receipt on a prewrite read failure; exact retry still applies', async () => {
        clock(); const fault = { read: false }; const sqlite = await openSqliteHost(seed(), (client) => ({ ...client,
            all: async (sql, params) => { if (fault.read && sql.includes('FROM tasks')) throw new Error('injected read failure'); return client.all(sql, params); },
        }));
        try {
            const host = methods(); const deletion = await prepare(host); const before = await raw(sqlite); fault.read = true;
            expect(await host.commitPreparedArchivedTasksDelete(deletion)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            fault.read = false; expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            expect(value(host.archivedTasksDeleteOutcome(deletion))).toBeNull(); value(await host.commitPreparedArchivedTasksDelete(deletion));
            const undo = await prepareUndo(host, deletion); const deleted = await raw(sqlite); fault.read = true;
            expect(await host.commitPreparedArchivedTasksDeleteUndo(undo)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            fault.read = false; expect(await raw(sqlite)).toEqual(deleted); expect(await sqlite.receiptIds()).toEqual([DELETE_ID]);
            value(await host.commitPreparedArchivedTasksDeleteUndo(undo)); expect(await sqlite.receiptIds()).toEqual([DELETE_ID, UNDO_ID]);
        } finally { fault.read = false; await sqlite.close(); }
    });

    it('matches actual RN Undo container sanitizing after parent deletion without parent resurrection or status changes', async () => {
        clock(); const rn = await openSqliteHost(seed()); let expected; let expectedRaw;
        const deleteParent = async (sqlite: Awaited<ReturnType<typeof openSqliteHost>>) =>
            sqlite.client().run('UPDATE projects SET deletedAt = ?, rev = rev + 1 WHERE id = ?', [NOW, 'parent-b']);
        try {
            await canonical(); expect(await useTaskStore.getState().batchDeleteTasks(['source'])).toEqual({ success: true }); await flushPendingSave();
            await deleteParent(rn); await rn.restart(undefined, { recoveryLoad: true });
            expect(await useTaskStore.getState().restoreTask('source')).toEqual({ success: true }); await flushPendingSave();
            expected = rows(); expectedRaw = await raw(rn);
        } finally { await rn.close(); }
        const sqlite = await openSqliteHost(seed());
        try {
            await canonical(); const host = methods(); const deletion = await prepare(host); value(await host.commitPreparedArchivedTasksDelete(deletion));
            await deleteParent(sqlite); const undo = await prepareUndo(host, deletion);
            expect(undo.prepared.after[0]).toMatchObject({ status: 'done', completedAt: BEFORE });
            expect(undo.prepared.after[0].projectId).toBeUndefined(); value(await host.commitPreparedArchivedTasksDeleteUndo(undo));
            expect(rows()).toEqual(expected); expect(await raw(sqlite)).toEqual(expectedRaw);
        } finally { await sqlite.close(); }
    });

    it('matches actual RN after normal load repairs a missing parent, including Delete and Undo complete content', async () => {
        clock();
        const removeAndLoad = async (sqlite: Awaited<ReturnType<typeof openSqliteHost>>) => {
            await sqlite.client().exec('PRAGMA foreign_keys = OFF'); await sqlite.client().run('DELETE FROM projects WHERE id = ?', ['parent-b']);
            await sqlite.client().exec('PRAGMA foreign_keys = ON'); await sqlite.restart(); await flushPendingSave();
            expect(useTaskStore.getState()._tasksById.get('source')?.projectId).toBeUndefined();
        };
        const rn = await openSqliteHost(seed()); let deleted; let deletedRaw; let restored; let restoredRaw;
        try {
            await canonical(); await removeAndLoad(rn);
            expect(await useTaskStore.getState().batchDeleteTasks(['source'])).toEqual({ success: true }); await flushPendingSave();
            deleted = rows(); deletedRaw = await raw(rn);
            expect(await useTaskStore.getState().restoreTask('source')).toEqual({ success: true }); await flushPendingSave();
            restored = rows(); restoredRaw = await raw(rn);
        } finally { await rn.close(); }
        const sqlite = await openSqliteHost(seed());
        try {
            await canonical(); await removeAndLoad(sqlite); const host = methods(); const deletion = await prepare(host);
            expect(deletion.prepared.projects).toEqual([]); value(await host.commitPreparedArchivedTasksDelete(deletion));
            expect(rows()).toEqual(deleted); expect(await raw(sqlite)).toEqual(deletedRaw);
            const undo = await prepareUndo(host, deletion); value(await host.commitPreparedArchivedTasksDeleteUndo(undo));
            expect(rows()).toEqual(restored); expect(await raw(sqlite)).toEqual(restoredRaw);
        } finally { await sqlite.close(); }
    });
});
