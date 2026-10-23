import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqliteHost } from './screen-parity.replay';
import { taskRevisionOf } from './native-request-receipts';
import { flushPendingSave, getStorageAdapter, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Task } from './types';
import { undoTaskCompletion } from './undo-task-completion';

const NOW = '2026-10-13T12:00:00.000Z';
const ID = 'board-complete-task';
const UUID = '00000000-0000-4000-8000-000000000731';
const UNDO = '00000000-0000-4000-8000-000000000732';
const value = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const task = (patch: Partial<Task> = {}): Task => ({
    id: ID, title: 'Board completion', status: 'next', sectionId: 'section',
    createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-12T12:00:00.000Z',
    rev: 3, revBy: 'device-a', tags: ['#keep'], contexts: ['@home'],
    checklist: [{ id: 'first', title: 'Keep order', isCompleted: false }],
    attachments: [{ id: 'first', kind: 'file', title: 'first.txt', uri: 'file:///first', createdAt: NOW },
        { id: 'second', kind: 'file', title: 'second.txt', uri: 'file:///second', createdAt: NOW }], ...patch,
});
const seed = (source = task()): Partial<AppData> => ({
    tasks: [source], projects: [{ id: 'parent', title: 'Parent', status: 'active', color: '#94a3b8', order: 0,
        tagIds: [], createdAt: NOW, updatedAt: NOW, rev: 2, revBy: 'device-a' }],
    sections: [{ id: 'section', projectId: 'parent', title: 'Section', order: 0, createdAt: NOW, updatedAt: NOW }],
    areas: [], people: [], settings: { deviceId: 'device-a', analyticsProfileId: UNDO, gtd: { focusTaskLimit: 3, autoArchiveDays: 0 } },
});
type Sqlite = Awaited<ReturnType<typeof openSqliteHost>>;
const raw = async (sqlite: Sqlite) => Object.fromEntries(await Promise.all(
    ['tasks', 'projects', 'sections', 'settings', 'native_request_receipts'].map(async table =>
        [table, await sqlite.sql(`SELECT * FROM ${table} ORDER BY rowid`)])));
const request = () => ({ id: ID, requestId: UUID, source: 'board' as const,
    taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get(ID)!) });
const prepare = async (sqlite: Sqlite) => {
    const input = request(); const planned = value(await sqlite.host.prepareTaskCompletion(input as never));
    return { request: input, prepared: planned.prepared };
};
const prepareUndo = async (sqlite: Sqlite, completion: Awaited<ReturnType<typeof prepare>>) => {
    const input = { requestId: UNDO, completionRequestId: UUID };
    return { request: input, prepared: value(await sqlite.host.prepareTaskCompletionUndo({ request: input, completion })).prepared };
};
const changeContainer = async (sqlite: Sqlite, change: string) => {
    if (change === 'reparent') {
        await sqlite.client().run("INSERT INTO projects (id,title,status,color,orderNum,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)",
            ['other-parent', 'Other', 'active', '#94a3b8', 1, NOW, NOW]);
        await sqlite.client().run('UPDATE sections SET projectId=? WHERE id=?', ['other-parent', 'section']);
    } else if (change === 'archive') await sqlite.client().run('UPDATE projects SET status=? WHERE id=?', ['archived', 'parent']);
    else if (change === 'delete') await sqlite.client().run('UPDATE projects SET deletedAt=? WHERE id=?', [NOW, 'parent']);
    else if (change === 'purge') await sqlite.client().run('UPDATE projects SET purgedAt=? WHERE id=?', [NOW, 'parent']);
    else await sqlite.client().run('UPDATE sections SET deletedAt=? WHERE id=?', [NOW, 'section']);
};
// Same physical SQLite test-adapter queue used by the Reference RN parity
// harness; public Undo performs two updates without waiting for direct SQL.
const serializeRNTaskWrites = () => {
    const adapter = getStorageAdapter(); const save = adapter.saveTask?.bind(adapter);
    if (!save) return;
    let tail: Promise<void> = Promise.resolve();
    setStorageAdapter(new Proxy(adapter, { get(target, name) {
        if (name === 'saveTask') {
            if (!target.saveTask) return undefined;
            return (...args: Parameters<NonNullable<typeof adapter.saveTask>>) => {
                const next = tail.then(() => save(...args)); tail = next.catch(() => {}); return next;
            };
        }
        const value = Reflect.get(target, name, target); return typeof value === 'function' ? value.bind(target) : value;
    } }));
};
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Board completion uses the existing durable completion owner', () => {
    it.each(['inbox', 'next', 'waiting', 'someday'] as const)('completes and publicly Undoes %s with ordered metadata and scoped witness', async status => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed(task({ status })));
        try {
            const before = JSON.parse(JSON.stringify(useTaskStore.getState()._tasksById.get(ID)!)) as Task;
            const card = value(sqlite.host.getBoardView({ limit: 100 })).columns.flatMap(c => c.cards).find(c => c.row.id === ID)!;
            expect(card.completeAllowed).toBe(true);
            expect(value(sqlite.host.getBoardView({ limit: 1 })).cardActions.complete.label).toBe('Done');
            const completion = await prepare(sqlite);
            expect(value(sqlite.host.validatePreparedTaskCompletion(completion))).toEqual(completion.prepared.result);
            expect(value(await sqlite.host.commitPreparedTaskCompletion(completion))).toEqual(completion.prepared.result);
            expect(useTaskStore.getState()._tasksById.get(ID)).toMatchObject({ status: 'done', completedAt: NOW,
                attachments: before.attachments, checklist: before.checklist });
            const undoRequest = { requestId: UNDO, completionRequestId: UUID };
            const undo = { request: undoRequest,
                prepared: value(await sqlite.host.prepareTaskCompletionUndo({ request: undoRequest, completion })).prepared };
            expect(undo.prepared).toMatchObject({ version: 2, kind: 'boardCompleteUndo' });
            expect(value(sqlite.host.validatePreparedTaskCompletionUndo(undo))).toEqual({ id: ID });
            expect(value(await sqlite.host.commitPreparedTaskCompletionUndo(undo))).toEqual({ id: ID });
            expect(useTaskStore.getState()._tasksById.get(ID)).toMatchObject({ status, attachments: before.attachments, checklist: before.checklist });
            expect(await sqlite.receiptIds()).toHaveLength(2);
        } finally { await sqlite.close(); }
    });

    it('binds the Section-only parent and refuses its archive after preparation without partial writes', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const envelope = await prepare(sqlite);
            expect(envelope.prepared).toMatchObject({ version: 2, kind: 'boardComplete' });
            expect(envelope.prepared.checklist.witness.lists.projects.map(row => row.id)).toContain('parent');
            await sqlite.client().run('UPDATE projects SET status=? WHERE id=?', ['archived', 'parent']);
            const before = await raw(sqlite);
            expect(await sqlite.host.commitPreparedTaskCompletion(envelope as never))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before);
            expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it.each(['complete', 'undo'] as const)('refuses Section/parent races after %s preparation and keeps every durable row/receipt unchanged', async operation => {
        for (const change of ['reparent', 'archive', 'delete', 'purge', 'deleted-section']) {
            vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
            const sqlite = await openSqliteHost(seed());
            try {
                const completion = await prepare(sqlite);
                if (operation === 'undo') value(await sqlite.host.commitPreparedTaskCompletion(completion));
                const undo = operation === 'undo' ? await prepareUndo(sqlite, completion) : null;
                const revision = useTaskStore.getState()._tasksById.get(ID)!.rev;
                await changeContainer(sqlite, change); const before = await raw(sqlite);
                expect(await (undo ? sqlite.host.commitPreparedTaskCompletionUndo(undo) : sqlite.host.commitPreparedTaskCompletion(completion)), change)
                    .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
                expect(await raw(sqlite), change).toEqual(before);
                expect(useTaskStore.getState()._tasksById.get(ID)!.rev, change).toBe(revision);
            } finally { await sqlite.close(); }
        }
    });

    it.each(['complete', 'undo'] as const)('rejects a container memory race between authority read and atomic %s apply', async operation => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        const originalApply = useTaskStore.getState().commitPreparedChecklistEffect;
        try {
            const completion = await prepare(sqlite);
            if (operation === 'undo') value(await sqlite.host.commitPreparedTaskCompletion(completion));
            const undo = operation === 'undo' ? await prepareUndo(sqlite, completion) : null;
            const before = await raw(sqlite);
            useTaskStore.setState({ commitPreparedChecklistEffect: async (effect, options) => {
                useTaskStore.setState({ _allProjects: useTaskStore.getState()._allProjects.map(row => ({ ...row, status: 'archived' })) });
                return originalApply(effect, options);
            } });
            expect(await (undo ? sqlite.host.commitPreparedTaskCompletionUndo(undo) : sqlite.host.commitPreparedTaskCompletion(completion)))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before);
        } finally { useTaskStore.setState({ commitPreparedChecklistEffect: originalApply }); await sqlite.close(); }
    });

    it.each(['complete', 'undo'] as const)('rechecks containers on owed %s failed-COMMIT retry and cold adoption', async operation => {
        for (const cold of [false, true]) {
            vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
            const fault = { commits: 0 };
            const sqlite = await openSqliteHost(seed(), client => ({ ...client, run: async (sql, params) => {
                if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('Injected Board COMMIT failure'); }
                return client.run(sql, params);
            } }));
            try {
                const completion = await prepare(sqlite);
                if (operation === 'undo') value(await sqlite.host.commitPreparedTaskCompletion(completion));
                const undo = operation === 'undo' ? await prepareUndo(sqlite, completion) : null;
                const commit = () => undo ? sqlite.host.commitPreparedTaskCompletionUndo(undo) : sqlite.host.commitPreparedTaskCompletion(completion);
                const before = await raw(sqlite); fault.commits = 10;
                expect(await commit()).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
                expect(await raw(sqlite)).toEqual(before);
                fault.commits = 0;
                await changeContainer(sqlite, 'archive');
                if (cold) { resetForTests(); await sqlite.restart(undefined, { recoveryLoad: true }); }
                const after = await raw(sqlite);
                expect(await commit()).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
                expect(await raw(sqlite)).toEqual(after);
            } finally { fault.commits = 0; resetForTests(); await sqlite.close(); }
        }
    }, 30_000);

    it('gives proven receipts precedence after parent changes, while fresh UUID and retagged origin cannot borrow them', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const completion = await prepare(sqlite); value(await sqlite.host.commitPreparedTaskCompletion(completion));
            const undo = await prepareUndo(sqlite, completion); value(await sqlite.host.commitPreparedTaskCompletionUndo(undo));
            await changeContainer(sqlite, 'archive'); await sqlite.restart(undefined, { recoveryLoad: true });
            const before = await raw(sqlite);
            expect(value(sqlite.host.taskCompletionOutcome(completion))).toEqual(completion.prepared.result);
            expect(value(await sqlite.host.commitPreparedTaskCompletion(completion))).toEqual(completion.prepared.result);
            expect(value(sqlite.host.taskCompletionUndoOutcome(undo))).toEqual({ id: ID });
            expect(value(await sqlite.host.commitPreparedTaskCompletionUndo(undo))).toEqual({ id: ID });
            const fresh = structuredClone(completion);
            fresh.request.requestId = fresh.prepared.request.requestId = UNDO;
            fresh.prepared.checklist.request.requestId = UNDO;
            expect(sqlite.host.taskCompletionOutcome(fresh)).toMatchObject({ ok: false });
            const retagged = structuredClone(completion);
            retagged.request.source = retagged.prepared.request.source = 'reference';
            expect(sqlite.host.validatePreparedTaskCompletion(retagged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await raw(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    });

    it.each(['complete', 'undo'] as const)('refuses a durable parent change before %s preparation even with unchanged displayed Task revision', async operation => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed());
        try {
            const completion = operation === 'undo' ? await prepare(sqlite) : null;
            if (completion) value(await sqlite.host.commitPreparedTaskCompletion(completion));
            await changeContainer(sqlite, 'archive'); const before = await raw(sqlite);
            const result = completion ? await sqlite.host.prepareTaskCompletionUndo({ request: { requestId: UNDO, completionRequestId: UUID }, completion })
                : await sqlite.host.prepareTaskCompletion(request());
            expect(result).toMatchObject({ ok: false });
            expect(await raw(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    });

    it.each([
        ['Section-only', task(), false, 0],
        ['focused Today', task({ projectId: 'parent', isFocusedToday: true, focusOrder: 2 }), true, 0],
        ['focused Today at full cap', task({ projectId: 'parent', isFocusedToday: true, focusOrder: 2 }), true, 3],
    ] as const)('matches actual RN completion/Undo preserving %s association and later unrelated edits', async (_name, source, wasFocusedToday, peers) => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const domain = async (sqlite: Sqlite) => {
            const { native_request_receipts: _receipts, ...data } = await raw(sqlite); return data;
        };
        const data = seed(source);
        data.tasks!.push(...Array.from({ length: peers }, (_, i) => task({ id: `focused-peer-${i}`, projectId: undefined, sectionId: undefined, isFocusedToday: true, focusOrder: i })));
        const rn = await openSqliteHost(data); serializeRNTaskWrites();
        let completed: Awaited<ReturnType<typeof domain>>; let undone: Awaited<ReturnType<typeof domain>>;
        try {
            expect(await useTaskStore.getState().updateTask(ID, { status: 'done' })).toEqual({ success: true });
            await flushPendingSave(); completed = await domain(rn);
            expect(useTaskStore.getState()._tasksById.get(ID)!.sectionId).toBe('section');
            expect(await useTaskStore.getState().updateTask(ID, { description: 'Later unrelated edit' })).toEqual({ success: true });
            await flushPendingSave(); vi.setSystemTime(new Date('2026-10-13T12:01:00.000Z'));
            await undoTaskCompletion(ID, 'next', wasFocusedToday); await flushPendingSave(); undone = await domain(rn);
        } finally { await rn.close(); }
        vi.setSystemTime(new Date(NOW)); const native = await openSqliteHost(data);
        try {
            const completion = await prepare(native); value(await native.host.commitPreparedTaskCompletion(completion));
            expect(await domain(native)).toEqual(completed!);
            expect(await useTaskStore.getState().updateTask(ID, { description: 'Later unrelated edit' })).toEqual({ success: true });
            await flushPendingSave(); vi.setSystemTime(new Date('2026-10-13T12:01:00.000Z'));
            const undo = await prepareUndo(native, completion);
            expect(undo.prepared.witness.lists.sections.map(row => row.id)).toContain('section');
            expect(undo.prepared.witness.lists.projects.map(row => row.id)).toContain('parent');
            value(await native.host.commitPreparedTaskCompletionUndo(undo));
            expect(await domain(native)).toEqual(undone!);
        } finally { await native.close(); }
    });

    it.each(['none', 'direct', 'section'] as const)('admits the %s container control without library-wide witness rows', async container => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const data = seed(task(container === 'none' ? { sectionId: undefined } : container === 'direct' ? { sectionId: undefined, projectId: 'parent' } : {}));
        data.tasks!.push(task({ id: 'unrelated', projectId: undefined, sectionId: undefined }));
        data.projects!.push({ ...data.projects![0], id: 'unrelated-parent' });
        data.sections!.push({ ...data.sections![0], id: 'unrelated-section', projectId: 'unrelated-parent' });
        const sqlite = await openSqliteHost(data);
        try {
            const completion = await prepare(sqlite);
            expect(completion.prepared.checklist.witness.lists.tasks.map(row => row.id)).not.toContain('unrelated');
            expect(completion.prepared.checklist.witness.lists.projects.map(row => row.id)).not.toContain('unrelated-parent');
            expect(completion.prepared.checklist.witness.lists.sections.map(row => row.id)).not.toContain('unrelated-section');
            value(await sqlite.host.commitPreparedTaskCompletion(completion));
        } finally { await sqlite.close(); }
    });

    it.each(['stale', 'done', 'archived', 'reference', 'deleted', 'purged', 'projected', 'missing-parent', 'missing-section',
        'archived-parent', 'deleted-parent', 'purged-parent', 'deleted-section', 'duplicate-parent', 'duplicate-section', 'contradictory'])(
        'fails closed for the %s displayed Board source', async invalid => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
            const sqlite = await openSqliteHost(seed());
            try {
                const state = useTaskStore.getState(); const displayed = request();
                if (invalid === 'projected') {
                    const current = { ...state._tasksById.get(ID)!, id: `${ID}:projected-recurrence` };
                    useTaskStore.setState({ _allTasks: [current], _tasksById: new Map([[ID, current]]) });
                }
                if (['done', 'archived', 'reference', 'deleted', 'purged', 'contradictory'].includes(invalid)) {
                    const current = { ...state._tasksById.get(ID)!, ...(invalid === 'deleted' ? { deletedAt: NOW }
                        : invalid === 'purged' ? { purgedAt: NOW } : invalid === 'contradictory' ? { projectId: 'other' } : { status: invalid as Task['status'] }) };
                    useTaskStore.setState({ _allTasks: [current], _tasksById: new Map([[ID, current]]) });
                }
                if (invalid === 'missing-parent') useTaskStore.setState({ _allProjects: [] });
                if (invalid === 'missing-section') useTaskStore.setState({ _allSections: [] });
                if (invalid === 'archived-parent') useTaskStore.setState({ _allProjects: [{ ...state._allProjects[0], status: 'archived' }] });
                if (invalid === 'deleted-parent') useTaskStore.setState({ _allProjects: [{ ...state._allProjects[0], deletedAt: NOW }] });
                if (invalid === 'purged-parent') useTaskStore.setState({ _allProjects: [{ ...state._allProjects[0], purgedAt: NOW }] });
                if (invalid === 'deleted-section') useTaskStore.setState({ _allSections: [{ ...state._allSections[0], deletedAt: NOW }] });
                if (invalid === 'duplicate-parent') useTaskStore.setState({ _allProjects: [...state._allProjects, state._allProjects[0]] });
                if (invalid === 'duplicate-section') useTaskStore.setState({ _allSections: [...state._allSections, state._allSections[0]] });
                const input = { ...displayed, ...(invalid === 'stale' ? { taskRevision: 'stale' } : {}),
                    ...(invalid === 'projected' ? { id: `${ID}:projected-recurrence` } : {}) };
                const before = await raw(sqlite);
                expect(await sqlite.host.prepareTaskCompletion(input), invalid).toMatchObject({ ok: false });
                const shown = value(sqlite.host.getBoardView({ limit: 100 })).columns.flatMap(c => c.cards).find(c => c.row.id === ID);
                if (shown && invalid !== 'stale') expect(shown.completeAllowed, invalid).toBe(false);
                expect(await raw(sqlite), invalid).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
            } finally { await sqlite.close(); }
    });

    it('rejects malformed origin/kind/version, omitted/duplicate parent witnesses, raw bindings and borrowed Undo proof before SQL', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const sqlite = await openSqliteHost(seed());
        try {
            const completion = await prepare(sqlite); const before = await raw(sqlite);
            for (const patch of [{ source: 'Board' }, { source: null }, { requestId: 'A0000000-0000-4000-8000-000000000731' }, { extra: true }, { status: 'done' }, { taskRevision: '' }])
                expect(await sqlite.host.prepareTaskCompletion({ ...request(), ...patch } as never)).toMatchObject({ ok: false });
            for (const invalid of ['kind', 'version', 'origin', 'inner-patch', 'missing-parent', 'duplicate-parent', 'missing-section', 'raw-before', 'effect']) {
                const forged = structuredClone(completion);
                if (invalid === 'kind') (forged.prepared as unknown as { kind: string }).kind = 'referenceComplete';
                if (invalid === 'version') (forged.prepared as unknown as { version: number }).version = 1;
                if (invalid === 'origin') delete forged.request.source;
                if (invalid === 'inner-patch') forged.prepared.checklist.request.patch.title = 'Forged';
                if (invalid === 'missing-parent') forged.prepared.checklist.witness.lists.projects = [];
                if (invalid === 'duplicate-parent') forged.prepared.checklist.witness.lists.projects.push(forged.prepared.checklist.witness.lists.projects[0]);
                if (invalid === 'missing-section') forged.prepared.checklist.witness.lists.sections = [];
                if (invalid === 'raw-before' && forged.prepared.version === 2) forged.prepared.rawBefore.tasks[0].before!.title = 'Forged';
                if (invalid === 'effect') forged.prepared.checklist.effect.tasks[0].after.title = 'Forged';
                expect(sqlite.host.validatePreparedTaskCompletion(forged), invalid).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(await sqlite.host.commitPreparedTaskCompletion(forged), invalid).toMatchObject({ ok: false });
            }
            const input = { requestId: UNDO, completionRequestId: UUID };
            expect(await sqlite.host.prepareTaskCompletionUndo({ request: input, completion })).toMatchObject({ ok: false });
            expect(await raw(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it.each(['strict', 'after-completion'] as const)('freezes exactly one %s recurring child across failed COMMIT, exact Retry, cold receipt and Undo', async strategy => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); const fault = { commits: 0 };
        const sqlite = await openSqliteHost(seed(task({ projectId: 'parent', dueDate: '2026-10-13',
            recurrence: { rule: 'daily', strategy, seriesId: ID } })), client => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('Injected recurring COMMIT failure'); }
            return client.run(sql, params);
        } }));
        try {
            const completion = await prepare(sqlite);
            const child = completion.prepared.checklist.effect.tasks.find(row => row.before === null)!.after;
            expect(child).toMatchObject({ status: 'next', dueDate: '2026-10-14', recurrence: { seriesId: ID } });
            const before = await raw(sqlite); fault.commits = 10;
            expect(await sqlite.host.commitPreparedTaskCompletion(completion)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await raw(sqlite)).toEqual(before); expect(value(sqlite.host.taskCompletionOutcome(completion))).toBeNull();
            fault.commits = 0; value(await sqlite.host.commitPreparedTaskCompletion(completion));
            const saved = await raw(sqlite); await sqlite.restart(undefined, { recoveryLoad: true });
            vi.setSystemTime(new Date('2026-10-13T12:01:00.000Z'));
            expect(value(await sqlite.host.commitPreparedTaskCompletion(completion))).toEqual(completion.prepared.result);
            expect(await raw(sqlite)).toEqual(saved); expect(useTaskStore.getState()._allTasks).toHaveLength(2);
            const undo = await prepareUndo(sqlite, completion); value(await sqlite.host.commitPreparedTaskCompletionUndo(undo));
            expect(useTaskStore.getState()._tasksById.get(child.id)).toMatchObject({ id: child.id, deletedAt: '2026-10-13T12:01:00.000Z' });
            expect(useTaskStore.getState()._tasksById.get(ID)).toMatchObject({ status: 'next', dueDate: '2026-10-13' });
        } finally { fault.commits = 0; resetForTests(); await sqlite.close(); }
    }, 30_000);

    it.each(['before', 'after'] as const)('refuses an edited owned child %s Undo preparation without partial tombstones', async phase => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed(task({ projectId: 'parent', dueDate: '2026-10-13', recurrence: { rule: 'daily', seriesId: ID } })));
        try {
            const completion = await prepare(sqlite); value(await sqlite.host.commitPreparedTaskCompletion(completion));
            const child = completion.prepared.checklist.effect.tasks.find(row => row.before === null)!.after;
            const undo = phase === 'after' ? await prepareUndo(sqlite, completion) : null;
            expect(await useTaskStore.getState().updateTask(child.id, { title: 'Later child edit' })).toEqual({ success: true });
            await flushPendingSave(); const before = await raw(sqlite);
            expect(await (undo ? sqlite.host.commitPreparedTaskCompletionUndo(undo)
                : sqlite.host.prepareTaskCompletionUndo({ request: { requestId: UNDO, completionRequestId: UUID }, completion })))
                .toMatchObject({ ok: false });
            expect(await raw(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    });

    it('preserves an existing recurring follow-up through Complete and Undo instead of claiming child ownership', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const source = task({ projectId: 'parent', dueDate: '2026-10-13', recurrence: { rule: 'daily', strategy: 'after-completion', seriesId: ID } });
        const existing = task({ id: 'existing-followup', projectId: 'parent', title: source.title, dueDate: '2026-10-14', recurrence: source.recurrence });
        const data = seed(source); data.tasks!.push(existing); const sqlite = await openSqliteHost(data);
        try {
            const before = await sqlite.sql('SELECT * FROM tasks WHERE id=?', [existing.id]);
            const completion = await prepare(sqlite); expect(completion.prepared.checklist.effect.tasks.filter(row => row.before === null)).toHaveLength(0);
            value(await sqlite.host.commitPreparedTaskCompletion(completion));
            const undo = await prepareUndo(sqlite, completion); value(await sqlite.host.commitPreparedTaskCompletionUndo(undo));
            expect(await sqlite.sql('SELECT * FROM tasks WHERE id=?', [existing.id])).toEqual(before);
        } finally { await sqlite.close(); }
    });

    it.each(['count', 'limit', 'device'] as const)('rechecks current durable %s before Focus-restoring Undo', async change => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
        const sqlite = await openSqliteHost(seed(task({ projectId: 'parent', isFocusedToday: true, focusOrder: 2 })));
        try {
            const completion = await prepare(sqlite); value(await sqlite.host.commitPreparedTaskCompletion(completion));
            const undo = await prepareUndo(sqlite, completion);
            if (change === 'count') {
                const peer = task({ id: 'new-focused', projectId: undefined, sectionId: undefined, isFocusedToday: true });
                const { SqliteAdapter } = await import('./sqlite-adapter');
                await new SqliteAdapter(sqlite.client()).saveTask(peer);
            } else {
                const [row] = await sqlite.sql<{ data: string }>('SELECT data FROM settings WHERE id=1'); const settings = JSON.parse(row.data);
                if (change === 'device') settings.deviceId = 'other-device'; else settings.gtd.focusTaskLimit = 1;
                await sqlite.client().run('UPDATE settings SET data=? WHERE id=1', [JSON.stringify(settings)]);
            }
            const before = await raw(sqlite);
            expect(await sqlite.host.commitPreparedTaskCompletionUndo(undo)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await raw(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    });
});
