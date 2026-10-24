import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqliteHost } from './screen-parity.replay';
import { taskRevisionOf } from './native-request-receipts';
import { flushPendingSave, getStorageAdapter, setStorageAdapter, resetForTests, useTaskStore } from './store';
import { readAreaDurableData } from './native-host-contract-area-durable';
import { undoTaskCompletion } from './undo-task-completion';
import type { NativeTaskCompletionEnvelope, NativeTaskCompletionUndoEnvelope } from './native-host-contract-task-checklist';
import { SqliteAdapter } from './sqlite-adapter';
import type { AppData, Task } from './types';
import { retainTaxonomyEffects } from './taxonomy-catalog';
// Raw-byte preservation cases catalog existing labels before their baseline; legacy RN/native parity cases remain uncatalogued.
const uuidState = vi.hoisted(() => ({ count: 0 }));
vi.mock('./uuid', async (original) => ({ ...await original<typeof import('./uuid')>(), generateUUID: () => `00000000-0000-4000-8000-${String(190 + uuidState.count++).padStart(12, '0')}` }));
const NOW = '2026-10-03T13:00:00.000Z';
const UNDO_AT = '2026-10-03T13:01:00.000Z';
const ID = 'reference-status-task';
const UUID = '00000000-0000-4000-8000-000000000188';
const UNDO = '00000000-0000-4000-8000-000000000189';
const value = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`); return result.value;
};
const task = (patch: Partial<Task> = {}): Task => ({
    id: ID, title: '  Reference rich memo  ', status: 'reference', description: 'Keep every memo byte',
    createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-10-02T12:00:00.000Z', rev: 3, revBy: 'device-a',
    tags: ['#first', '#second'], contexts: ['@home'], projectId: 'parent', sectionId: 'section',
    boardOrder: 7, order: 2, orderNum: 2, timeSpentMinutes: 45,
    checklist: [{ id: 'dup', title: 'Keep', isCompleted: true }, { id: 'dup', title: '  ', isCompleted: false }],
    attachments: [{ id: 'att', kind: 'file', title: 'proof.txt', uri: 'file:///proof.txt', createdAt: NOW, updatedAt: NOW }], ...patch,

});
const seed = (source = task(), cap = 3, peers = 0): Partial<AppData> => ({
    tasks: [source, ...Array.from({ length: peers }, (_, i) => task({ id: `peer-${i}`, title: 'Peer', status: 'next',
        isFocusedToday: true, focusOrder: i, checklist: [], attachments: [] }))],
    projects: [{ id: 'parent', title: 'Parent', status: 'active', color: '#94a3b8', order: 0, tagIds: [],
        createdAt: NOW, updatedAt: NOW, rev: 2, revBy: 'device-a' }],
    sections: [{ id: 'section', projectId: 'parent', title: 'Section', order: 0, createdAt: NOW, updatedAt: NOW }],
    areas: [{ id: 'area', name: 'Area', order: 0, createdAt: NOW, updatedAt: NOW }],
    people: [{ id: 'person', name: 'Person', createdAt: NOW, updatedAt: NOW }],
    settings: { deviceId: 'device-a', analyticsProfileId: UNDO, gtd: { focusTaskLimit: cap, autoArchiveDays: 1 } },
});
type Sqlite = Awaited<ReturnType<typeof openSqliteHost>>;
const tables = ['tasks', 'projects', 'sections', 'areas', 'people', 'settings', 'saved_filters', 'schema_migrations', 'calendar_sync'];
const raw = async (sqlite: Sqlite) => Object.fromEntries(await Promise.all(tables.map(async (table) => [table,
    { schema: await sqlite.sql(`PRAGMA table_info(${table})`), rows: await sqlite.sql(`SELECT rowid AS evidenceRowid,* FROM ${table} ORDER BY rowid`) }])));
const rows = () => { const s = useTaskStore.getState(); return JSON.parse(JSON.stringify({ tasks: s._allTasks, projects: s._allProjects,
    sections: s._allSections, areas: s._allAreas, people: s._allPeople, settings: s.settings })) as AppData; };
const displayed = () => ({ id: ID, taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get(ID)!) });
const statusRequest = (status: 'inbox' | 'waiting' | 'someday' | 'reference') => ({ ...displayed(), requestId: UUID, source: 'reference' as const, status });
const completeRequest = () => ({ ...displayed(), requestId: UUID, source: 'reference' as const });
const prepareComplete = async (sqlite: Sqlite) => {
    const request = completeRequest(); const planned = value(await sqlite.host.prepareTaskCompletion(request as never));
    return { request, prepared: planned.prepared };
};
const serializeRNTaskWrites = () => {
    const adapter = getStorageAdapter(); const save = adapter.saveTask?.bind(adapter);
    if (!save) return; let tail: Promise<void> = Promise.resolve();
    setStorageAdapter(new Proxy(adapter, { get(target, name) {
        if (name === 'saveTask') { const current = target.saveTask; if (!current) return undefined;
            return (...args: Parameters<NonNullable<typeof adapter.saveTask>>) => { const next = tail.then(() => save(...args)); tail = next.catch(() => {}); return next; }; }
        const value = Reflect.get(target, name, target); return typeof value === 'function' ? value.bind(target) : value;
    } }));
};
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); });

describe('Reference status menu preserves the real RN moves, Completion and Undo', () => {
    it.each(['inbox', 'waiting', 'someday'] as const)('matches RN status-only %s full state and all nine raw tables', async (status) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const rn = await openSqliteHost(seed()); let expected: AppData; let expectedRaw: Awaited<ReturnType<typeof raw>>;
        try { expect(await useTaskStore.getState().updateTask(ID, { status })).toEqual({ success: true });
            await flushPendingSave(); expected = rows(); expectedRaw = await raw(rn); } finally { await rn.close(); }
        const native = await openSqliteHost(seed());
        try {
            const request = statusRequest(status); const planned = value(await native.host.prepareDoneTaskStatus(request as never));
            if (planned.kind !== 'prepared') throw new Error('Real Reference move must prepare');
            expect(planned.prepared).toMatchObject({ version: 2, kind: 'referenceStatus', result: { id: ID } });
            expect(Object.keys(planned.prepared).sort()).toEqual(['version', 'kind', 'request', 'rawBeforeTask', 'checklist', 'result'].sort());
            value(await native.host.commitPreparedDoneTaskStatus({ request, prepared: planned.prepared } as never));
            expect(rows()).toEqual(expected!); expect(await raw(native)).toEqual(expectedRaw!);
        } finally { await native.close(); }
    });
    it('returns shared six-choice Reference options and current choice without any write or receipt', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try {
            const before = await raw(sqlite); const options = value(sqlite.host.getDoneTaskStatusOptions({ ...displayed(), source: 'reference' } as never));
            expect(options.status).toBe('reference'); expect(options.options.map((item) => item.status)).toEqual(['inbox', 'next', 'waiting', 'someday', 'done', 'reference']);
            expect(options.options.filter((item) => item.selected).map((item) => item.status)).toEqual(['reference']);
            expect(value(await sqlite.host.prepareDoneTaskStatus(statusRequest('reference') as never))).toEqual({ kind: 'noop', result: { id: ID } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });
    it.each([
        ['ordinary', task()],
        ['recurring rich', task({ recurrence: { rule: 'daily', strategy: 'after-completion', seriesId: ID }, dueDate: '2026-10-01', showFutureRecurrence: true })],
    ])('matches actual RN Reference completion including all rows: %s', async (_name, source) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        uuidState.count = 0; const rn = await openSqliteHost(seed(source)); let expected: AppData; let expectedRaw: Awaited<ReturnType<typeof raw>>;
        try { expect(await useTaskStore.getState().updateTask(ID, { status: 'done' })).toEqual({ success: true });
            await flushPendingSave(); expected = rows(); expectedRaw = await raw(rn); } finally { await rn.close(); }
        uuidState.count = 0; const native = await openSqliteHost(seed(source));
        try {
            const envelope = await prepareComplete(native); expect(envelope.prepared).toMatchObject({ version: 2, kind: 'referenceComplete' });
            expect(Object.keys(envelope.prepared).sort()).toEqual(['version', 'kind', 'request', 'rawBefore', 'checklist', 'notice', 'result'].sort());
            expect(value(await native.host.commitPreparedTaskCompletion(envelope as never))).toEqual(envelope.prepared.result);
            expect(rows()).toEqual(expected!); expect(await raw(native)).toEqual(expectedRaw!);
            expect(rows().tasks.find((row) => row.id === ID)?.checklist).toEqual(source.checklist);
        } finally { await native.close(); }
    });
    it.each([
        ['plain', task(), 3, 0, 1],
        ['hidden-star room', task({ isFocusedToday: true, focusOrder: 2 }), 3, 0, 2],
        ['hidden-star full', task({ isFocusedToday: true, focusOrder: 2 }), 1, 1, 1],
        ['recurring hidden-star room', task({ isFocusedToday: true, focusOrder: 2, recurrence: { rule: 'daily', strategy: 'after-completion', seriesId: ID }, dueDate: '2026-10-01' }), 3, 0, 2],
    ] as const)('matches real undoTaskCompletion including revision attempts and current edits: %s', async (_name, source, cap, peers, delta) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        uuidState.count = 0; const rn = await openSqliteHost(seed(source, cap, peers)); serializeRNTaskWrites(); let expected: AppData; let expectedRaw: Awaited<ReturnType<typeof raw>>;
        try {
            expect(await useTaskStore.getState().updateTask(ID, { status: 'done' })).toEqual({ success: true });
            expect(await useTaskStore.getState().updateTask(ID, { description: 'Current unrelated edit' })).toEqual({ success: true });
            vi.setSystemTime(new Date(UNDO_AT)); await undoTaskCompletion(ID, 'reference', source.isFocusedToday === true);
            await flushPendingSave(); expected = rows(); expectedRaw = await raw(rn);
            expect(expected.tasks.find((row) => row.id === ID)).toMatchObject({ rev: 5 + delta, status: 'reference', isFocusedToday: false, description: 'Current unrelated edit' });
        } finally { await rn.close(); }
        vi.setSystemTime(new Date(NOW)); uuidState.count = 0; const native = await openSqliteHost(seed(source, cap, peers));
        try {
            const completion = await prepareComplete(native); value(await native.host.commitPreparedTaskCompletion(completion as never));
            expect(await useTaskStore.getState().updateTask(ID, { description: 'Current unrelated edit' })).toEqual({ success: true }); await flushPendingSave();
            vi.setSystemTime(new Date(UNDO_AT)); const request = { requestId: UNDO, completionRequestId: UUID };
            const planned = value(await native.host.prepareTaskCompletionUndo({ request, completion } as never));
            expect(planned.prepared).toMatchObject({ version: 2, kind: 'referenceCompleteUndo', result: { id: ID } });
            value(await native.host.commitPreparedTaskCompletionUndo({ request, prepared: planned.prepared } as never));
            expect(rows()).toEqual(expected!); expect(await raw(native)).toEqual(expectedRaw!);
        } finally { await native.close(); }
    });
    it.each(['completion', 'undo'] as const)('preserves raw siblings through repeated failed COMMIT, owned retry and true recoveryLoad: %s', async (operation) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); uuidState.count = 0;
        const fault = { commits: 0 };
        const sqlite = await openSqliteHost({ ...seed(task({ isFocusedToday: true, focusOrder: 2,
            recurrence: { rule: 'daily', strategy: 'after-completion', seriesId: ID }, dueDate: '2026-10-01' })),
            tasks: [task({ isFocusedToday: true, focusOrder: 2, recurrence: { rule: 'daily', strategy: 'after-completion', seriesId: ID }, dueDate: '2026-10-01' }), task({ id: 'raw-sibling', status: 'reference', order: 8 })] },
            (client) => ({ ...client, run: async (sql, params) => { if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('owned injected COMMIT'); } return client.run(sql, params); } }));
        try {
            await sqlite.client().run('UPDATE tasks SET pushCount=NULL, focusOrder=2, attachments=? WHERE id=?',
                ['[{"id":"legacy","kind":"file","title":"old.txt","uri":"file:///old.txt","createdAt":"2026-10-03T13:00:00.000Z"}]', 'raw-sibling']);
            const [stored] = await sqlite.sql<{ data: string }>('SELECT data FROM settings WHERE id=1');
            const settings = retainTaxonomyEffects(JSON.parse(stored.data), rows().tasks.map(after => ({ after }))); settings.savedFilters = [{ id: 'raw-filter', name: 'Raw filter', view: 'tasks', criteria: { tags: ['#first'] }, createdAt: NOW, updatedAt: NOW }];
            await sqlite.client().run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify(settings, null, 2)]);
            await sqlite.client().run('INSERT INTO saved_filters (id,name,view,criteria,createdAt,updatedAt) VALUES (?,?,?,?,?,?)',
                ['raw-filter', 'Raw filter', 'tasks', '{ "tags" : [ "#first" ] }', NOW, NOW]);
            await sqlite.restart(undefined, { recoveryLoad: true });
            const completion = await prepareComplete(sqlite);
            let envelope: NativeTaskCompletionEnvelope | NativeTaskCompletionUndoEnvelope = completion;
            if (operation === 'undo') {
                value(await sqlite.host.commitPreparedTaskCompletion(completion)); vi.setSystemTime(new Date(UNDO_AT));
                const request = { requestId: UNDO, completionRequestId: UUID };
                envelope = { request, prepared: value(await sqlite.host.prepareTaskCompletionUndo({ request, completion })).prepared };
            }
            const commit = () => operation === 'completion' ? sqlite.host.commitPreparedTaskCompletion(envelope as NativeTaskCompletionEnvelope)
                : sqlite.host.commitPreparedTaskCompletionUndo(envelope as NativeTaskCompletionUndoEnvelope);
            const checkpoint = join(sqlite.dir, 'before-command.sqlite'); await sqlite.client().run('VACUUM INTO ?', [checkpoint]);
            const before = await raw(sqlite); const initialReceipts = await sqlite.sql('SELECT * FROM native_request_receipts ORDER BY request_id');
            value(await commit()); const uninterrupted = await raw(sqlite);
            const receipts = await sqlite.sql('SELECT * FROM native_request_receipts ORDER BY request_id');
            const sibling = (uninterrupted.tasks.rows as Array<Record<string, unknown>>).find(row => row.id === 'raw-sibling');
            expect(sibling).toEqual((before.tasks.rows as Array<Record<string, unknown>>).find(row => row.id === 'raw-sibling'));
            expect(uninterrupted.settings).toEqual(before.settings); expect(uninterrupted.saved_filters).toEqual(before.saved_filters);
            await sqlite.restart(checkpoint, { recoveryLoad: true }); fault.commits = 10;
            expect(await commit()).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.sql('SELECT * FROM native_request_receipts ORDER BY request_id')).toEqual(initialReceipts);
            fault.commits = 10; expect(await commit()).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); expect(await raw(sqlite)).toEqual(before);
            fault.commits = 0; expect(value(await commit())).toEqual(envelope.prepared.result);
            expect(await raw(sqlite)).toEqual(uninterrupted); expect(await sqlite.sql('SELECT * FROM native_request_receipts ORDER BY request_id')).toEqual(receipts);
            await sqlite.restart(checkpoint, { recoveryLoad: true }); fault.commits = 10;
            expect(await commit()).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } }); fault.commits = 0;
            resetForTests(); await sqlite.restart(undefined, { recoveryLoad: true }); value(await commit());
            expect(await raw(sqlite)).toEqual(uninterrupted); expect(await sqlite.sql('SELECT * FROM native_request_receipts ORDER BY request_id')).toEqual(receipts);
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 30_000);
    it('refuses a raw-only source edit while preserving its lower-revision durable row and unused UUID', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed(task({ isFocusedToday: true, focusOrder: 2 })));
        try { const envelope = await prepareComplete(sqlite);
            await sqlite.client().run('UPDATE tasks SET focusOrder=3, rev=2 WHERE id=?', [ID]); const before = await raw(sqlite);
            expect(await sqlite.host.commitPreparedTaskCompletion(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });
    it('the existing raw checklist writer independently refuses stale authority, altered raw BEFORE and created-ID collisions', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed(task({ recurrence: { rule: 'daily', strategy: 'after-completion', seriesId: ID } })));
        try { const envelope = await prepareComplete(sqlite); if (envelope.prepared.version !== 2) throw new Error('Expected raw Completion');
            const read = value(await readAreaDurableData(false, true)); const effect = envelope.prepared.checklist.effect;
            const before = await raw(sqlite); useTaskStore.setState({ _allTasks: [...useTaskStore.getState()._allTasks] });
            expect(await useTaskStore.getState().commitPreparedChecklistEffect(effect, { requireBefore: true, authority: read.authority, rawBefore: envelope.prepared.rawBefore })).toMatchObject({ success: false });
            const fresh = value(await readAreaDurableData(false, true)); fresh.authority.snapshot.tasks.find(row => row.id === ID)!.focusOrder = 99;
            expect(await useTaskStore.getState().commitPreparedChecklistEffect(effect, { requireBefore: true, authority: fresh.authority, rawBefore: envelope.prepared.rawBefore })).toMatchObject({ success: false });
            const collision = value(await readAreaDurableData(false, true)); const child = effect.tasks.find(row => row.before === null)!;
            collision.authority.snapshot.tasks.push(child.after);
            expect(await useTaskStore.getState().commitPreparedChecklistEffect(effect, { requireBefore: true, authority: collision.authority, rawBefore: envelope.prepared.rawBefore })).toMatchObject({ success: false });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it.each(['missing-to-empty', 'empty-to-missing'] as const)('binds attachment timestamp member presence across restart and refuses same-revision external edits: %s', async direction => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const attachment = { id: 'att', kind: 'file', title: 'proof.txt', uri: 'file:///proof.txt', createdAt: NOW };
            const beforeAttachment = direction === 'missing-to-empty' ? attachment : { ...attachment, updatedAt: '' };
            const changedAttachment = direction === 'missing-to-empty' ? { ...attachment, updatedAt: '' } : attachment;
            await sqlite.client().run('UPDATE tasks SET attachments=?,pushCount=0 WHERE id=?', [JSON.stringify([beforeAttachment]), ID]);
            await sqlite.restart();
            const unchanged = await sqlite.sql<{ attachments: string }>('SELECT attachments FROM tasks WHERE id=?', [ID]);
            expect(JSON.parse(unchanged[0].attachments)[0]).toEqual(beforeAttachment);
            const envelope = await prepareComplete(sqlite); if (envelope.prepared.version !== 2) throw new Error('Expected raw completion');
            expect(envelope.prepared.rawBefore.tasks[0].before?.attachments?.[0]).toEqual(beforeAttachment);
            await sqlite.client().run('UPDATE tasks SET attachments=? WHERE id=?', [JSON.stringify([changedAttachment]), ID]);
            const before = await raw(sqlite); await sqlite.restart(undefined, { recoveryLoad: true });
            expect(await sqlite.host.commitPreparedTaskCompletion(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });
    it('Reference status uses the same strict raw arm for a legitimate missing timestamp source', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try { const attachment = { id: 'att', kind: 'file', title: 'proof.txt', uri: 'file:///proof.txt', createdAt: NOW };
            await sqlite.client().run('UPDATE tasks SET attachments=?,pushCount=0 WHERE id=?', [JSON.stringify([attachment]), ID]); await sqlite.restart();
            const request = statusRequest('waiting'); const planned = value(await sqlite.host.prepareDoneTaskStatus(request));
            if (planned.kind !== 'prepared' || planned.prepared.kind !== 'referenceStatus') throw new Error('Expected raw status');
            expect(planned.prepared.rawBeforeTask.attachments?.[0]).toEqual(attachment);
            value(await sqlite.host.commitPreparedDoneTaskStatus({ request, prepared: planned.prepared }));
            expect(useTaskStore.getState()._tasksById.get(ID)?.status).toBe('waiting');
        } finally { await sqlite.close(); }
    });

    it('initializes a missing device exactly like RN, keeps current Reference a no-op, and durably retries Completion then Undo', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const initial = { ...seed(), settings: { ...seed().settings, theme: 'dark' as const,
            savedFilters: [{ id: 'kept-filter', name: 'Kept', view: 'reference' as const, criteria: { tags: ['#first'] }, createdAt: NOW, updatedAt: NOW }] } };
        const withoutDevice = async (sqlite: Sqlite) => {
            const settings = (await sqlite.sql<{ data: string }>('SELECT data FROM settings WHERE id=1'))[0];
            const data = JSON.parse(settings.data); delete data.deviceId;
            await sqlite.client().run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify(data)]);
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(useTaskStore.getState().settings.deviceId).toBeUndefined();
        };
        uuidState.count = 0; const rn = await openSqliteHost(initial); let expected: AppData; let expectedRaw: Awaited<ReturnType<typeof raw>>;
        try { await withoutDevice(rn); expect(await useTaskStore.getState().updateTask(ID, { status: 'done' })).toEqual({ success: true });
            await flushPendingSave(); expected = rows(); expectedRaw = await raw(rn);
        } finally { await rn.close(); }
        uuidState.count = 0; const fault = { commits: 0 };
        const native = await openSqliteHost(initial, client => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('missing-device COMMIT'); }
            return client.run(sql, params);
        } }));
        try {
            await withoutDevice(native); const before = await raw(native);
            expect(value(await native.host.prepareDoneTaskStatus(statusRequest('reference')))).toEqual({ kind: 'noop', result: { id: ID } });
            expect(await raw(native)).toEqual(before); expect(await native.receiptIds()).toEqual([]);
            const completion = await prepareComplete(native);
            expect(completion.prepared.checklist.effect.deviceIdBefore).toBeNull();
            expect(completion.prepared.checklist.effect.deviceIdToInitialize).toBe(expected!.settings.deviceId);
            const checkpoint = join(native.dir, 'missing-device.sqlite'); await native.client().run('VACUUM INTO ?', [checkpoint]);
            fault.commits = 10; expect(await native.host.commitPreparedTaskCompletion(completion)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(native)).toEqual(before); expect(await native.receiptIds()).toEqual([]);
            fault.commits = 0; value(await native.host.commitPreparedTaskCompletion(completion));
            expect(rows()).toEqual(expected!); expect(await raw(native)).toEqual(expectedRaw!);
            const receipt = await native.sql('SELECT * FROM native_request_receipts ORDER BY request_id');
            await native.restart(checkpoint, { recoveryLoad: true }); fault.commits = 10;
            expect(await native.host.commitPreparedTaskCompletion(completion)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            fault.commits = 0; resetForTests(); await native.restart(undefined, { recoveryLoad: true });
            value(await native.host.commitPreparedTaskCompletion(completion));
            expect(rows()).toEqual(expected!); expect(await raw(native)).toEqual(expectedRaw!);
            expect(await native.sql('SELECT * FROM native_request_receipts ORDER BY request_id')).toEqual(receipt);
            vi.setSystemTime(new Date(UNDO_AT));
            const request = { requestId: UNDO, completionRequestId: UUID };
            const prepared = value(await native.host.prepareTaskCompletionUndo({ request, completion })).prepared;
            expect(prepared.effect.deviceIdBefore).toBe(expected!.settings.deviceId);
            expect(prepared.effect.deviceIdToInitialize).toBeNull();
            value(await native.host.commitPreparedTaskCompletionUndo({ request, prepared }));
            expect(rows().settings).toEqual(expected!.settings); expect((await native.receiptIds()).length).toBe(2);
        } finally { fault.commits = 0; await native.close(); }
    }, 30_000);

    it.each(['archived-parent', 'deleted-parent', 'purged-parent', 'deleted-section'] as const)(
        'refuses current durable container changes, including a Section-derived parent: %s', async kind => {
            vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
            const sqlite = await openSqliteHost(seed(task({ projectId: undefined })));
            try {
                const envelope = await prepareComplete(sqlite);
                if (kind === 'archived-parent') await sqlite.client().run('UPDATE projects SET status=?,archivedAt=? WHERE id=?', ['archived', NOW, 'parent']);
                else if (kind === 'deleted-parent') await sqlite.client().run('UPDATE projects SET deletedAt=? WHERE id=?', [NOW, 'parent']);
                else if (kind === 'purged-parent') await sqlite.client().run('UPDATE projects SET purgedAt=? WHERE id=?', [NOW, 'parent']);
                else await sqlite.client().run('UPDATE sections SET deletedAt=? WHERE id=?', [NOW, 'section']);
                const before = await raw(sqlite);
                expect(await sqlite.host.commitPreparedTaskCompletion(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
                expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            } finally { await sqlite.close(); }
        });
    it.each(['count', 'limit', 'device'] as const)('rechecks current durable %s before hidden-star Undo, even though its final star is false', async conflict => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed(task({ isFocusedToday: true, focusOrder: 2 }), 3, 1));
        try {
            const completion = await prepareComplete(sqlite); value(await sqlite.host.commitPreparedTaskCompletion(completion));
            vi.setSystemTime(new Date(UNDO_AT)); const request = { requestId: UNDO, completionRequestId: UUID };
            const prepared = value(await sqlite.host.prepareTaskCompletionUndo({ request, completion })).prepared;
            expect(prepared.effect.tasks[0].after.isFocusedToday).toBe(false);
            if (conflict === 'count') await sqlite.client().run('UPDATE tasks SET isFocusedToday=0,focusOrder=NULL WHERE id=?', ['peer-0']);
            else {
                const [row] = await sqlite.sql<{ data: string }>('SELECT data FROM settings WHERE id=1'); const settings = JSON.parse(row.data);
                if (conflict === 'limit') settings.gtd.focusTaskLimit = 2; else settings.deviceId = 'different-device';
                await sqlite.client().run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify(settings)]);
            }
            const before = await raw(sqlite); const receipts = await sqlite.sql('SELECT * FROM native_request_receipts ORDER BY request_id');
            expect(await sqlite.host.commitPreparedTaskCompletionUndo({ request, prepared })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.sql('SELECT * FROM native_request_receipts ORDER BY request_id')).toEqual(receipts);
        } finally { await sqlite.close(); }
    });
    it('preserves harmless current settings, including autoArchiveDays, because status-only Completion does not consume the correction rule', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try {
            const envelope = await prepareComplete(sqlite); expect(envelope.prepared.checklist.effect.guards.autoArchiveDays).toBeNull();
            const [row] = await sqlite.sql<{ data: string }>('SELECT data FROM settings WHERE id=1'); const settings = retainTaxonomyEffects(JSON.parse(row.data), rows().tasks.map(after => ({ after })));
            settings.theme = 'light'; settings.gtd.autoArchiveDays = 365; const encoded = JSON.stringify(settings, null, 2);
            await sqlite.client().run('UPDATE settings SET data=? WHERE id=1', [encoded]);
            value(await sqlite.host.commitPreparedTaskCompletion(envelope));
            expect((await sqlite.sql<{ data: string }>('SELECT data FROM settings WHERE id=1'))[0].data).toBe(encoded);
            expect(rows().settings).toEqual(settings);
        } finally { await sqlite.close(); }
    });
    it('refuses a recurring child edited through the real store before Undo and preserves all current rows/receipts', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed(task({ recurrence: { rule: 'daily', strategy: 'after-completion', seriesId: ID } })));
        try {
            const completion = await prepareComplete(sqlite); value(await sqlite.host.commitPreparedTaskCompletion(completion));
            const child = completion.prepared.checklist.effect.tasks.find(row => row.before === null)!.after;
            expect(await useTaskStore.getState().updateTask(child.id, { description: 'A later child edit' })).toEqual({ success: true }); await flushPendingSave();
            vi.setSystemTime(new Date(UNDO_AT)); const before = await raw(sqlite); const receipts = await sqlite.sql('SELECT * FROM native_request_receipts ORDER BY request_id');
            expect(await sqlite.host.prepareTaskCompletionUndo({ request: { requestId: UNDO, completionRequestId: UUID }, completion }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.sql('SELECT * FROM native_request_receipts ORDER BY request_id')).toEqual(receipts);
        } finally { await sqlite.close(); }
    });
    it.each(['status', 'completion', 'undo'] as const)('returns exact saved %s proof after later raw edits and true cold boot', async operation => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try {
            let commit: () => ReturnType<typeof sqlite.host.commitPreparedDoneTaskStatus> | ReturnType<typeof sqlite.host.commitPreparedTaskCompletion>;
            let outcome: () => ReturnType<typeof sqlite.host.doneTaskStatusOutcome> | ReturnType<typeof sqlite.host.taskCompletionOutcome>;
            let result: unknown;
            if (operation === 'status') {
                const request = statusRequest('waiting'); const planned = value(await sqlite.host.prepareDoneTaskStatus(request));
                if (planned.kind !== 'prepared') throw new Error('Status must prepare'); const envelope = { request, prepared: planned.prepared };
                commit = () => sqlite.host.commitPreparedDoneTaskStatus(envelope); outcome = () => sqlite.host.doneTaskStatusOutcome(envelope); result = envelope.prepared.result;
            } else {
                const completion = await prepareComplete(sqlite);
                if (operation === 'completion') {
                    commit = () => sqlite.host.commitPreparedTaskCompletion(completion); outcome = () => sqlite.host.taskCompletionOutcome(completion); result = completion.prepared.result;
                } else {
                    value(await sqlite.host.commitPreparedTaskCompletion(completion)); vi.setSystemTime(new Date(UNDO_AT));
                    const request = { requestId: UNDO, completionRequestId: UUID };
                    const prepared = value(await sqlite.host.prepareTaskCompletionUndo({ request, completion })).prepared; const envelope = { request, prepared };
                    commit = () => sqlite.host.commitPreparedTaskCompletionUndo(envelope); outcome = () => sqlite.host.taskCompletionUndoOutcome(envelope); result = prepared.result;
                }
            }
            expect(value(await commit())).toEqual(result);
            await sqlite.client().run('UPDATE tasks SET description=?,focusOrder=99,rev=1 WHERE id=?', ['Later raw source', ID]);
            if (operation === 'undo') await sqlite.client().run('DELETE FROM native_request_receipts WHERE request_id=?', [UUID]);
            const before = await raw(sqlite); const receipts = await sqlite.sql('SELECT * FROM native_request_receipts ORDER BY request_id');
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(outcome())).toEqual(result); expect(value(await commit())).toEqual(result);
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.sql('SELECT * FROM native_request_receipts ORDER BY request_id')).toEqual(receipts);
        } finally { await sqlite.close(); }
    });
    it('does not acknowledge equal AFTER under an unused UUID or accept a forged affected-row scope', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try {
            const completion = await prepareComplete(sqlite); if (completion.prepared.version !== 2) throw new Error('Expected raw completion');
            const forged = JSON.parse(JSON.stringify(completion)); forged.prepared.rawBefore.tasks.push(forged.prepared.rawBefore.tasks[0]);
            expect(sqlite.host.validatePreparedTaskCompletion(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            const generic = completion.prepared.checklist;
            expect(sqlite.host.validatePreparedTaskChecklistWrite({ request: generic.request, prepared: generic })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            value(await sqlite.host.commitPreparedTaskCompletion(completion));
            const unused = JSON.parse(JSON.stringify(completion)); unused.request.requestId = UNDO;
            unused.prepared.request.requestId = UNDO; unused.prepared.checklist.request.requestId = UNDO;
            expect(value(sqlite.host.validatePreparedTaskCompletion(unused))).toEqual(unused.prepared.result);
            const before = await raw(sqlite); const receipts = await sqlite.sql('SELECT * FROM native_request_receipts ORDER BY request_id');
            expect(await sqlite.host.commitPreparedTaskCompletion(unused)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.sql('SELECT * FROM native_request_receipts ORDER BY request_id')).toEqual(receipts);
        } finally { await sqlite.close(); }
    });
    it('a pre-write adapter read failure cannot mint an acknowledgment, and exact retry applies only after the read succeeds', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const fault = { reads: false };
        const sqlite = await openSqliteHost(seed(), client => ({ ...client, all: async <T,>(sql: string, params?: unknown[]) => {
            if (fault.reads && sql.includes('FROM tasks')) throw new Error('owned raw read failure');
            return client.all<T>(sql, params);
        } }));
        try {
            const completion = await prepareComplete(sqlite); const before = await raw(sqlite); fault.reads = true;
            expect(await sqlite.host.commitPreparedTaskCompletion(completion)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(value(sqlite.host.taskCompletionOutcome(completion))).toBeNull();
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            fault.reads = false; value(await sqlite.host.commitPreparedTaskCompletion(completion));
            expect(value(sqlite.host.taskCompletionOutcome(completion))).toEqual(completion.prepared.result);
            expect(await sqlite.receiptIds()).toEqual([UUID]);
        } finally { fault.reads = false; await sqlite.close(); }
    });
    it.each(['collision', 'duplicate'] as const)('refuses a durable recurring %s inserted after preparation without overwriting any row', async conflict => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed(task({ recurrence: { rule: 'daily', strategy: 'strict', seriesId: ID }, dueDate: '2026-10-01' })));
        try {
            const completion = await prepareComplete(sqlite); const generated = completion.prepared.checklist.effect.tasks.find(row => row.before === null)!.after;
            await new SqliteAdapter(sqlite.client()).saveTask({ ...generated, id: conflict === 'collision' ? generated.id : 'independent-recurring-child', description: 'Later writer' });
            const before = await raw(sqlite);
            expect(await sqlite.host.commitPreparedTaskCompletion(completion)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });
    it.each((['inbox', 'waiting', 'someday'] as const).flatMap(status => [
        { status, cap: 3, peers: 0 }, { status, cap: 1, peers: 1 },
    ]))('matches actual RN hidden-star status $status with current Focus cap $cap', async ({ status, cap, peers }) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const source = task({ isFocusedToday: true, focusOrder: 2 });
        const rn = await openSqliteHost(seed(source, cap, peers)); let expected: AppData; let expectedRaw: Awaited<ReturnType<typeof raw>>; let success: boolean;
        try { success = (await useTaskStore.getState().updateTask(ID, { status })).success; await flushPendingSave(); expected = rows(); expectedRaw = await raw(rn); }
        finally { await rn.close(); }
        const native = await openSqliteHost(seed(source, cap, peers));
        try {
            const request = statusRequest(status); const prepared = await native.host.prepareDoneTaskStatus(request);
            expect(prepared.ok).toBe(success!);
            if (prepared.ok) { if (prepared.value.kind !== 'prepared') throw new Error('Outbound status must prepare');
                value(await native.host.commitPreparedDoneTaskStatus({ request, prepared: prepared.value.prepared })); }
            expect(rows()).toEqual(expected!); expect(await raw(native)).toEqual(expectedRaw!);
            expect((await native.receiptIds()).length).toBe(success! ? 1 : 0);
        } finally { await native.close(); }
    });

});
