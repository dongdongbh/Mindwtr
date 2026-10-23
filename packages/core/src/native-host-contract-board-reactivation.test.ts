import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqliteHost } from './screen-parity.replay';
import { createNativeHostContract } from './native-host-contract';
import { NativeReceiptSqliteAdapter } from './native-request-receipts';
import { noopStorage } from './storage';
import { taskRevisionOf } from './native-request-receipts';
import { flushPendingSave, getStorageAdapter, setStorageAdapter, resetForTests, useTaskStore } from './store';
import type { AppData, Task } from './types';

const NOW = '2026-10-13T12:00:00.000Z';
const ID = 'board-reactivate-task';
const UUID = '00000000-0000-4000-8000-000000000732';
const value = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const task = (patch: Partial<Task> = {}): Task => ({ id: ID, title: 'Reactivate', status: 'done',
    projectId: 'parent', sectionId: 'section', completedAt: '2026-10-12T12:00:00.000Z',
    createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-12T12:00:00.000Z',
    rev: 3, revBy: 'device-a', order: 17, orderNum: 17, boardOrder: 42,
    tags: ['#keep'], contexts: ['@home'], checklist: [{ id: 'first', title: 'Keep order', isCompleted: false }],
    attachments: [{ id: 'first', kind: 'file', title: 'first.txt', uri: 'file:///first', createdAt: NOW },
        { id: 'second', kind: 'file', title: 'second.txt', uri: 'file:///second', createdAt: NOW }], ...patch });
const seed = (source = task()): Partial<AppData> => ({ tasks: [source],
    projects: [{ id: 'parent', title: 'Parent', status: 'active', color: '#94a3b8', order: 0,
        tagIds: [], createdAt: NOW, updatedAt: NOW, rev: 2, revBy: 'device-a' }],
    sections: [{ id: 'section', projectId: 'parent', title: 'Section', order: 0, createdAt: NOW, updatedAt: NOW }],
    areas: [], people: [], settings: { deviceId: 'device-a', analyticsProfileId: UUID, gtd: { focusTaskLimit: 3, autoArchiveDays: 0 } } });
type Sqlite = Awaited<ReturnType<typeof openSqliteHost>>;
const open = (data = seed(), wrap?: Parameters<typeof openSqliteHost>[1]) => openSqliteHost(data, wrap, {}, { rejectConcurrentWrites: true });
const raw = async (sqlite: Sqlite) => Object.fromEntries(await Promise.all(
    ['tasks', 'projects', 'sections', 'settings', 'native_request_receipts'].map(async table =>
        [table, await sqlite.sql(`SELECT * FROM ${table} ORDER BY rowid`)])));
const prepare = (sqlite: Sqlite, status: 'inbox' | 'next' | 'waiting' | 'someday' = 'next') => {
    const source = useTaskStore.getState()._tasksById.get(ID)!;
    const request = { requestId: UUID, action: { type: 'moveCard' as const, taskId: ID, status,
        taskRevision: taskRevisionOf(source), filters: value(sqlite.host.getBoardView({ limit: 100 })).filters } };
    const planned = value(sqlite.host.prepareBoardAction(request));
    if (planned.kind !== 'prepared') throw new Error('Done move was not prepared');
    return { request, prepared: planned.prepared };
};
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Board Done reactivation through the existing prepared Move', () => {
    it.each((['inbox', 'next', 'waiting', 'someday'] as const).flatMap(status => [
        { status, inferred: false }, { status, inferred: true }]))('matches actual persisted RN Done → $status (Section-only=$inferred)', async ({ status, inferred }) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const data = seed(task({ ...(inferred ? { projectId: undefined } : {}) })); const rn = await open(data); let expected: Awaited<ReturnType<typeof raw>>;
        try { await useTaskStore.getState().updateTask(ID, { status }); await flushPendingSave();
            expected = await raw(rn);
        } finally { await rn.close(); }
        const native = await open(data);
        try {
            const card = value(native.host.getBoardView({ limit: 100 })).columns.flatMap(c => c.cards).find(c => c.row.id === ID)!;
            expect(card.moveAllowed).toBe(true); expect(card.completeAllowed).toBe(false);
            const envelope = prepare(native, status); const before = await raw(native);
            expect(value(native.host.validatePreparedBoardAction(envelope))).toEqual({ changed: true, open: null });
            expect(value(await native.host.commitPreparedBoardAction(envelope))).toEqual({ changed: true, open: null });
            const after = await raw(native); expect(after.tasks).toEqual(expected!.tasks);
            expect(after.projects).toEqual(before.projects); expect(after.sections).toEqual(before.sections); expect(after.settings).toEqual(expected!.settings);
            await native.restart(); const reopened = await raw(native);
            expect(reopened.tasks).toEqual(expected!.tasks); expect(reopened.settings).toEqual(expected!.settings);
        } finally { await native.close(); }
    });

    it.each(['archive', 'reparent'] as const)('refuses durable %s without a Task revision change', async change => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await open(seed(task({ projectId: undefined })));
        try {
            const envelope = prepare(sqlite);
            if (change === 'archive') await sqlite.client().run('UPDATE projects SET status=? WHERE id=?', ['archived', 'parent']);
            else {
                await sqlite.client().run('INSERT INTO projects (id,title,status,color,orderNum,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)',
                    ['other', 'Other', 'active', '#94a3b8', 1, NOW, NOW]);
                await sqlite.client().run('UPDATE sections SET projectId=? WHERE id=?', ['other', 'section']);
            }
            const before = await raw(sqlite);
            expect(await sqlite.host.commitPreparedBoardAction(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    });

    it.each([false, true])('rechecks archived parent on failed-COMMIT retry (cold=%s)', async cold => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const fault = { count: 0 };
        const sqlite = await open(seed(), client => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fault.count > 0) { fault.count--; throw new Error('Injected Reactivation COMMIT failure'); }
            return client.run(sql, params);
        } }));
        try {
            const envelope = prepare(sqlite); const before = await raw(sqlite); fault.count = 10;
            expect(await sqlite.host.commitPreparedBoardAction(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); fault.count = 0;
            await sqlite.client().run('UPDATE projects SET status=? WHERE id=?', ['archived', 'parent']);
            if (cold) { resetForTests(); await sqlite.restart(undefined, { recoveryLoad: true }); }
            const after = await raw(sqlite);
            const retried = await sqlite.host.commitPreparedBoardAction(envelope);
            expect(await raw(sqlite)).toEqual(after);
            expect(retried).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        } finally { fault.count = 0; resetForTests(); await sqlite.close(); }
    });
});


describe('Done Move durable proof and closed admission', () => {
    it('proves the exact owner and full durable after-row with zero DML/save/retry; later edits refuse', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const statements: string[] = [];
        const sqlite = await open(seed(), client => ({ ...client, run: async (sql, params) => { statements.push(sql); return client.run(sql, params); } }));
        try {
            const envelope = prepare(sqlite);
            expect(value(await sqlite.host.boardMoveOutcome(envelope))).toBeNull();
            value(await sqlite.host.commitPreparedBoardAction(envelope));
            const before = await raw(sqlite); statements.length = 0;
            const save = vi.spyOn(getStorageAdapter(), 'saveData'); const retry = vi.spyOn(useTaskStore.getState(), 'retryPersistence');
            const snapshot = vi.spyOn(useTaskStore.getState(), 'persistSnapshot');
            expect(value(await sqlite.host.boardMoveOutcome(envelope))).toEqual(envelope.prepared.result);
            expect(statements.filter(sql => /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)/i.test(sql))).toEqual([]);
            expect(save).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled(); expect(snapshot).not.toHaveBeenCalled();
            expect(await raw(sqlite)).toEqual(before);
            await sqlite.restart();
            await sqlite.client().run('UPDATE projects SET status=? WHERE id=?', ['archived', 'parent']);
            const changedParent = await raw(sqlite);
            expect(value(await sqlite.host.commitPreparedBoardAction(envelope))).toEqual(envelope.prepared.result);
            expect(await raw(sqlite)).toEqual(changedParent);
            await sqlite.client().run('UPDATE tasks SET title=? WHERE id=?', ['Later edit', ID]);
            expect(value(await sqlite.host.boardMoveOutcome(envelope))).toBeNull();
            const after = await raw(sqlite);
            expect(await sqlite.host.commitPreparedBoardAction(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(after);
        } finally { await sqlite.close(); }
    });

    it.each(['missing', 'ordered-attachment', 'receipt'] as const)('does not claim a %s durable result', async change => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await open();
        try {
            const envelope = prepare(sqlite); value(await sqlite.host.commitPreparedBoardAction(envelope));
            if (change === 'missing') await sqlite.client().run('DELETE FROM tasks WHERE id=?', [ID]);
            else if (change === 'receipt') await sqlite.client().run('DELETE FROM native_request_receipts WHERE request_id=?', [UUID]);
            else await sqlite.client().run('UPDATE tasks SET attachments=? WHERE id=?', [JSON.stringify([...envelope.prepared.after.attachments!].reverse()), ID]);
            const before = await raw(sqlite);
            expect(value(await sqlite.host.boardMoveOutcome(envelope))).toBeNull(); expect(await raw(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    });

    it('refuses an external receipt deletion after its read rather than adopting a new row epoch', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await open();
        const external = new DatabaseSync(`${sqlite.dir}/mindwtr.db`);
        try {
            const envelope = prepare(sqlite); value(await sqlite.host.commitPreparedBoardAction(envelope));
            const adapter = getStorageAdapter() as import('./native-request-receipts').NativeReceiptSqliteAdapter;
            const receipt = adapter.readDurableReceipt.bind(adapter);
            vi.spyOn(adapter, 'readDurableReceipt').mockImplementation(async (...args) => {
                const result = await receipt(...args); external.prepare('DELETE FROM native_request_receipts WHERE request_id=?').run(UUID); return result;
            });
            expect(await sqlite.host.boardMoveOutcome(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await sqlite.receiptIds()).toEqual([]);
        } finally { external.close(); await sqlite.close(); }
    });

    it('refuses a commit-time external container race and revalidates its failed save retry', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await open();
        const external = new DatabaseSync(`${sqlite.dir}/mindwtr.db`); const original = useTaskStore.getState().commitPreparedTaskDraftV2;
        try {
            const envelope = prepare(sqlite);
            useTaskStore.setState({ commitPreparedTaskDraftV2: async (...args) => {
                external.prepare('UPDATE projects SET status=? WHERE id=?').run('archived', 'parent'); return original(...args);
            } });
            expect(await sqlite.host.commitPreparedBoardAction(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            const before = await raw(sqlite); expect((before.projects as { status: string }[])[0].status).toBe('archived');
            expect((before.tasks as { status: string }[])[0].status).toBe('done'); expect(before.native_request_receipts).toEqual([]);
            expect(await sqlite.host.commitPreparedBoardAction(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before);
        } finally { useTaskStore.setState({ commitPreparedTaskDraftV2: original }); external.close(); resetForTests(); await sqlite.close(); }
    });

    it('retries its own failed COMMIT and survives cold lost reply without repeating the row', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const fault = { count: 0 };
        const sqlite = await open(seed(), client => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fault.count > 0) { fault.count--; throw new Error('Injected Reactivation COMMIT failure'); } return client.run(sql, params);
        } }));
        try {
            const envelope = prepare(sqlite); const before = await raw(sqlite); fault.count = 10;
            expect(await sqlite.host.commitPreparedBoardAction(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before);
            expect(await sqlite.host.boardMoveOutcome(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            fault.count = 0; expect(value(await sqlite.host.commitPreparedBoardAction(envelope))).toEqual(envelope.prepared.result);
            const saved = await raw(sqlite); expect((saved.tasks as { rev: number }[])[0].rev).toBe(4);
            await sqlite.restart(); expect(value(await sqlite.host.commitPreparedBoardAction(envelope))).toEqual(envelope.prepared.result);
            expect(await raw(sqlite)).toEqual(saved);
            const borrowed = JSON.parse(JSON.stringify(envelope)); borrowed.request.requestId = borrowed.prepared.request.requestId = '00000000-0000-4000-8000-000000000733';
            expect(value(await sqlite.host.boardMoveOutcome(borrowed))).toBeNull();
            expect(await sqlite.host.commitPreparedBoardAction(borrowed)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(saved);
        } finally { fault.count = 0; resetForTests(); await sqlite.close(); }
    });

    it.each(['archived', 'deleted-parent', 'purged-parent', 'deleted-section', 'missing-parent', 'conflict'] as const)('refuses %s source policy without a write', async scenario => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const data = seed();
        if (scenario === 'archived') data.projects![0].status = 'archived';
        else if (scenario === 'deleted-parent') data.projects![0].deletedAt = NOW;
        else if (scenario === 'purged-parent') data.projects![0].purgedAt = NOW;
        else if (scenario === 'deleted-section') data.sections![0].deletedAt = NOW;
        else if (scenario === 'missing-parent') { data.tasks![0].projectId = undefined; data.sections![0].projectId = 'missing'; }
        else { data.projects!.push({ ...data.projects![0], id: 'other' }); data.tasks![0].projectId = 'other'; }
        // Missing parent cannot be stored with FK constraints; exercise the
        // same raw in-memory contract admission with the corrupt identity.
        if (scenario === 'missing-parent') data.sections![0].projectId = 'parent';
        const sqlite = await open(data);
        try {
            // Normal hydration sanitizes invalid container links. Restore only
            // those source references in memory to exercise admission itself;
            // the database is still the real persisted invalid-policy fixture.
            if (['deleted-parent', 'deleted-section', 'conflict'].includes(scenario)) {
                useTaskStore.setState({ _allTasks: useTaskStore.getState()._allTasks.map(row => row.id === ID
                    ? { ...row, projectId: data.tasks![0].projectId, sectionId: 'section' } : row),
                    _allProjects: data.projects!, _allSections: data.sections! });
            }
            if (scenario === 'missing-parent') useTaskStore.setState({ _allSections: [{ ...useTaskStore.getState()._allSections[0], projectId: 'missing' }] });
            const before = await raw(sqlite); const source = useTaskStore.getState()._tasksById.get(ID)!;
            const request = { requestId: UUID, action: { type: 'moveCard' as const, taskId: ID, status: 'next' as const,
                taskRevision: taskRevisionOf(source), filters: {} } };
            expect(sqlite.host.prepareBoardAction(request)).toMatchObject({ ok: false }); expect(await raw(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    });

    it('refuses duplicate container identities and hidden/stale/projected sources', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await open();
        try {
            const source = useTaskStore.getState()._tasksById.get(ID)!; const request = { requestId: UUID,
                action: { type: 'moveCard' as const, taskId: ID, status: 'next' as const, taskRevision: taskRevisionOf(source), filters: {} } };
            for (const field of ['_allProjects', '_allSections'] as const) {
                const original = useTaskStore.getState()[field]; useTaskStore.setState({ [field]: [...original, original[0]] });
                expect(sqlite.host.prepareBoardAction(request)).toMatchObject({ ok: false }); useTaskStore.setState({ [field]: original });
            }
            expect(sqlite.host.prepareBoardAction({ ...request, action: { ...request.action, taskRevision: 'stale' } })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(sqlite.host.prepareBoardAction({ ...request, action: { ...request.action, filters: { searchQuery: 'no match' } } })).toMatchObject({ ok: false });
            const envelope = prepare(sqlite); const forged = JSON.parse(JSON.stringify(envelope)); forged.prepared.after.title = 'forged';
            expect(sqlite.host.validatePreparedBoardAction(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await sqlite.host.boardMoveOutcome(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        } finally { await sqlite.close(); }
    });

    it('refuses a stale public completion Undo after reactivation', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const data = seed(task({ status: 'next', completedAt: undefined })); const sqlite = await open(data);
        try {
            const request = { id: ID, requestId: '00000000-0000-4000-8000-000000000734', source: 'board' as const,
                taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get(ID)!) };
            const completion = { request, prepared: value(await sqlite.host.prepareTaskCompletion(request)).prepared };
            value(await sqlite.host.commitPreparedTaskCompletion(completion));
            const undoRequest = { requestId: '00000000-0000-4000-8000-000000000735', completionRequestId: request.requestId };
            const undo = { request: undoRequest, prepared: value(await sqlite.host.prepareTaskCompletionUndo({ request: undoRequest, completion })).prepared };
            const envelope = prepare(sqlite); value(await sqlite.host.commitPreparedBoardAction(envelope));
            const before = await raw(sqlite);
            expect(await sqlite.host.commitPreparedTaskCompletionUndo(undo)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    });
});


describe('Done Move current capacity and source admission', () => {
    it('matches RN at full Focus capacity without restoring a hidden Done star', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const data = seed(task({ isFocusedToday: true, focusOrder: 2 }));
        data.tasks!.push(...[1, 2, 3].map(index => task({ id: `peer-${index}`, status: 'next', completedAt: undefined,
            projectId: undefined, sectionId: undefined, isFocusedToday: true, focusOrder: index })));
        const rn = await open(data); let expected: unknown;
        try { await useTaskStore.getState().updateTask(ID, { status: 'next' }); await flushPendingSave(); expected = (await raw(rn)).tasks; }
        finally { await rn.close(); }
        const sqlite = await open(data);
        try {
            const envelope = prepare(sqlite); value(await sqlite.host.commitPreparedBoardAction(envelope));
            expect((await raw(sqlite)).tasks).toEqual(expected);
            expect(useTaskStore.getState()._tasksById.get(ID)).toMatchObject({ status: 'next', isFocusedToday: false });
        } finally { await sqlite.close(); }
    });
    it('rechecks a durable Focus limit change without relying on a Task revision', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await open();
        try {
            const envelope = prepare(sqlite);
            await sqlite.client().run("UPDATE settings SET data=json_set(data,'$.gtd.focusTaskLimit',4) WHERE id=1");
            const before = await raw(sqlite);
            expect(await sqlite.host.commitPreparedBoardAction(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    });
    it('rejects queued proof reads without flushing and rejects legacy envelopes for the new outcome', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await open();
        try {
            const envelope = prepare(sqlite); const original = useTaskStore.getState().commitPreparedTaskDraftV2;
            const save = vi.spyOn(getStorageAdapter(), 'saveData');
            useTaskStore.setState({ commitPreparedTaskDraftV2: async (...args) => {
                const applied = await original(...args);
                expect(await sqlite.host.boardMoveOutcome(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
                expect(save).not.toHaveBeenCalled(); return applied;
            } });
            value(await sqlite.host.commitPreparedBoardAction(envelope)); useTaskStore.setState({ commitPreparedTaskDraftV2: original });
            const legacy = { request: { ...envelope.request, action: { ...envelope.request.action, type: 'trashTask' as const } }, prepared: envelope.prepared };
            expect(await sqlite.host.boardMoveOutcome(legacy as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        } finally { await sqlite.close(); }
    });
});


describe('Done Move real boot adapter order', () => {
    it.each(['commit-first', 'outcome-first'] as const)('constructs before SQLite install and binds after activation (%s)', async first => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        setStorageAdapter(noopStorage);
        const earlyHost = createNativeHostContract({ replayTokens: 'required' });
        const sqlite = await open();
        try {
            const envelope = prepare(sqlite);
            expect(await earlyHost.boardMoveOutcome(envelope)).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
            expect(await earlyHost.commitPreparedBoardAction(envelope)).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
            if (first === 'outcome-first') value(await sqlite.host.commitPreparedBoardAction(envelope));
            value(await earlyHost.setLanguage({ storedLanguage: 'en', systemLocale: null }));
            value(await earlyHost.activate({ writeSafetyReady: true, recoveryLoad: first === 'outcome-first' }));
            if (first === 'commit-first') value(await earlyHost.commitPreparedBoardAction(envelope));
            const saved = await raw(sqlite);
            expect(value(await earlyHost.boardMoveOutcome(envelope))).toEqual(envelope.prepared.result);
            expect(value(await earlyHost.commitPreparedBoardAction(envelope))).toEqual(envelope.prepared.result);
            expect(await raw(sqlite)).toEqual(saved);
            const replacement = new NativeReceiptSqliteAdapter(sqlite.client(), { rejectConcurrentWrites: true });
            setStorageAdapter(replacement);
            expect(await earlyHost.boardMoveOutcome(envelope)).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
            value(await earlyHost.activate({ writeSafetyReady: true, recoveryLoad: true }));
            const replaced = await raw(sqlite);
            expect(await earlyHost.boardMoveOutcome(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await earlyHost.commitPreparedBoardAction(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(replaced);
        } finally { await sqlite.close(); }
    });
});
