import { afterEach, describe, expect, it } from 'vitest';
import { createSomedaySectionBulkMoveMethods, validatePreparedSomedaySectionBulkMove, validatePreparedSomedaySectionBulkMoveUndo,
    type NativeSomedaySectionBulkMoveEnvelope, type NativeSomedaySectionBulkMoveUndoEnvelope } from './native-host-contract-someday-section-move';
import { revisionOf } from './native-request-receipts';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Task } from './types';

const stamp = '2026-09-01T12:00:00.000Z';
const task = (id: string, someday: string | undefined, extra: Partial<Task> = {}): Task => ({ id, title: id, status: 'someday',
    tags: [], contexts: [], rev: 3, revBy: 'prior', createdAt: stamp, updatedAt: stamp,
    viewSectionIds: someday ? { someday, future: 'retain' } : { future: 'retain' }, ...extra });
const sections = [{ id: 'ideas', title: 'Ideas', order: 0 }, { id: 'later', title: 'Later', order: 1 }];
const library = (tasks: Task[]): AppData => ({ tasks, projects: [], sections: [], areas: [], people: [],
    settings: { deviceId: 'device', gtd: { viewSections: { someday: sections } } } });
type Methods = ReturnType<typeof createSomedaySectionBulkMoveMethods>;
const value = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const row = (id: string) => useTaskStore.getState()._allTasks.find((entry) => entry.id === id)!;
const revisions = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, revisionOf(row(id))]));

async function open(data: AppData, fails?: () => boolean) {
    resetForTests();
    let stored = structuredClone(data);
    const adapter = { getData: async () => stored, saveData: async (next: AppData) => {
        if (fails?.()) throw new Error('disk unavailable');
        stored = structuredClone(next);
    } };
    setStorageAdapter(adapter);
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    const methods: Methods = createSomedaySectionBulkMoveMethods({ readiness: () => ({ ok: true, value: null }),
        save: async () => {
            try { await flushPendingSave(); return { ok: true as const, value: null }; }
            catch (error) { return { ok: false as const, error: { code: 'SAVE_FAILED' as const,
                message: error instanceof Error ? error.message : String(error) } }; }
        }, revision: () => 'revision', t: () => (key) => key });
    return { methods, stored: () => stored };
}
const prepareMove = (methods: Methods, ids: string[], sectionId: string | null): NativeSomedaySectionBulkMoveEnvelope => {
    const request = { requestId: crypto.randomUUID(), taskIds: ids, taskRevisions: revisions(ids), sectionId };
    const prepared = value(methods.prepareSomedaySectionBulkMove(request));
    if (prepared.kind !== 'prepared') throw new Error('Expected a prepared move');
    return { request, prepared: prepared.prepared };
};
const prepareUndo = (methods: Methods, move: NativeSomedaySectionBulkMoveEnvelope): NativeSomedaySectionBulkMoveUndoEnvelope => {
    const request = { requestId: crypto.randomUUID(), moveRequestId: move.request.requestId };
    const prepared = value(methods.prepareSomedaySectionBulkMoveUndo({ request, move }));
    if (prepared.kind !== 'prepared') throw new Error('Expected a prepared Undo');
    return { request, prepared: prepared.prepared };
};
afterEach(async () => { await flushPendingSave().catch(() => undefined); resetForTests(); });

describe('prepared native Someday bulk section move and Undo', () => {
    it('offers the RN picker for a mixed selection with a per-choice moved count and pages it', async () => {
        const { methods } = await open(library([task('a', 'ideas'), task('b', undefined), task('c', 'later')]));
        const first = value(methods.getSomedaySectionBulkMoveOptions({ taskIds: ['a', 'b', 'c'], limit: 2 }));
        expect(first.taskIds).toEqual(['a', 'b', 'c']);
        expect(first.taskRevisions).toEqual(revisions(['a', 'b', 'c']));
        expect(first.choices.total).toBe(3);
        expect(first.choices.items.map((item) => [item.sectionId, item.selected])).toEqual([[null, false], ['ideas', false]]);
        expect(first.choices.items.map((item) => item.toast)).toEqual(['Moved to No section (2)', 'Moved to Ideas (2)']);
        const second = value(methods.getSomedaySectionBulkMoveOptions({ taskIds: ['a', 'b', 'c'], offset: 2, revision: first.revision }));
        expect(second.choices.items.map((item) => item.sectionId)).toEqual(['later']);
        expect(methods.getSomedaySectionBulkMoveOptions({ taskIds: ['a', 'b'], revision: 'old' }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(methods.getSomedaySectionBulkMoveOptions({ taskIds: ['a', 'missing'] }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const same = value(methods.getSomedaySectionBulkMoveOptions({ taskIds: ['a'] }));
        expect(same.choices.items.find((item) => item.selected)?.sectionId).toBe('ideas');
    });

    it('moves only the tasks not already there, keeps other scopes, and Undo restores each original section', async () => {
        const host = await open(library([task('a', 'ideas'), task('b', undefined), task('c', 'later')]));
        const move = prepareMove(host.methods, ['a', 'b', 'c'], 'ideas');
        expect(move.prepared.rows.map((entry) => entry.id)).toEqual(['b', 'c']);
        expect(validatePreparedSomedaySectionBulkMove(move)).toEqual({ ok: true,
            value: { taskIds: ['b', 'c'], changed: true, sectionId: 'ideas' } });
        expect(value(await host.methods.commitPreparedSomedaySectionBulkMove(move)))
            .toEqual({ taskIds: ['b', 'c'], changed: true, sectionId: 'ideas' });
        expect(['a', 'b', 'c'].map((id) => row(id).viewSectionIds)).toEqual([
            { future: 'retain', someday: 'ideas' }, { future: 'retain', someday: 'ideas' }, { future: 'retain', someday: 'ideas' }]);
        expect([row('a').rev, row('b').rev, row('c').rev]).toEqual([3, 4, 4]);
        expect(row('b').revBy).toBe('device');
        expect(host.methods.probeSomedaySectionBulkMoveOutcome(move)).toMatchObject({ ok: true });
        expect(value(await host.methods.commitPreparedSomedaySectionBulkMove(move)).taskIds).toEqual(['b', 'c']);
        expect(row('b').rev).toBe(4);

        await useTaskStore.getState().updateTask('c', { viewSectionIds: { someday: 'later', future: 'retain' } });
        const undo = prepareUndo(host.methods, move);
        expect(undo.prepared.rows.map((entry) => entry.id)).toEqual(['b']);
        expect(validatePreparedSomedaySectionBulkMoveUndo(undo)).toEqual({ ok: true, value: { taskIds: ['b'], changed: true } });
        expect(value(await host.methods.commitPreparedSomedaySectionBulkMoveUndo(undo))).toEqual({ taskIds: ['b'], changed: true });
        expect(row('b').viewSectionIds).toEqual({ future: 'retain' });
        expect(row('c').viewSectionIds?.someday).toBe('later');
        expect(host.methods.prepareSomedaySectionBulkMoveUndo({ request: { requestId: crypto.randomUUID(),
            moveRequestId: move.request.requestId }, move })).toEqual({ ok: true,
            value: { kind: 'noop', result: { taskIds: [], changed: false } } });
        await flushPendingSave();
        expect(host.stored().tasks.find((entry) => entry.id === 'b')?.viewSectionIds).toEqual({ future: 'retain' });
    });

    it('answers a selection already in the section with a no-op and refuses stale or tampered requests', async () => {
        const { methods } = await open(library([task('a', 'ideas'), task('b', 'ideas')]));
        const request = { requestId: crypto.randomUUID(), taskIds: ['a', 'b'], taskRevisions: revisions(['a', 'b']), sectionId: 'ideas' };
        expect(methods.prepareSomedaySectionBulkMove(request)).toEqual({ ok: true,
            value: { kind: 'noop', result: { taskIds: [], changed: false, sectionId: 'ideas' } } });
        expect(methods.prepareSomedaySectionBulkMove({ ...request, taskRevisions: { a: 'old', b: request.taskRevisions.b } }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(methods.prepareSomedaySectionBulkMove({ ...request, sectionId: 'gone' }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(methods.prepareSomedaySectionBulkMove({ ...request, taskIds: ['a', 'a'] }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const move = prepareMove(methods, ['a', 'b'], null);
        const tampered = structuredClone(move);
        tampered.prepared.rows[0].after = { someday: 'later' };
        expect(validatePreparedSomedaySectionBulkMove(tampered)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(validatePreparedSomedaySectionBulkMove({ ...move, prepared: { ...move.prepared, result: { ...move.prepared.result, taskIds: ['a'] } } }))
            .toMatchObject({ ok: false });
    });

    it('writes nothing when any selected row changed after preparation', async () => {
        const host = await open(library([task('a', undefined), task('b', undefined)]));
        const move = prepareMove(host.methods, ['a', 'b'], 'later');
        await useTaskStore.getState().updateTask('b', { title: 'edited elsewhere' });
        expect(await host.methods.commitPreparedSomedaySectionBulkMove(move)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect([row('a').viewSectionIds, row('b').viewSectionIds]).toEqual([{ future: 'retain' }, { future: 'retain' }]);
        expect(row('a').rev).toBe(3);
    });

    it('lands once when the first save fails and the same envelope is retried', async () => {
        let failing = true;
        const host = await open(library([task('a', undefined), task('b', 'ideas')]), () => failing);
        const move = prepareMove(host.methods, ['a', 'b'], 'later');
        expect(await host.methods.commitPreparedSomedaySectionBulkMove(move)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        failing = false;
        expect(value(await host.methods.commitPreparedSomedaySectionBulkMove(move)).taskIds).toEqual(['a', 'b']);
        expect([row('a').rev, row('b').rev]).toEqual([4, 4]);
        expect(host.stored().tasks.map((entry) => entry.viewSectionIds?.someday)).toEqual(['later', 'later']);
    });

    it('commits a batch of prepared task edits all together or not at all', async () => {
        await open(library([task('a', undefined), task('b', undefined)]));
        const store = useTaskStore.getState();
        const stale = { ...row('b'), dueDate: '2030-01-01' };
        expect(await store.commitPreparedTaskEdits([{ before: row('a'), changes: { viewSectionIds: { someday: 'ideas' } } },
            { before: stale, changes: { viewSectionIds: { someday: 'ideas' } } }])).toMatchObject({ success: false, reason: 'conflict' });
        expect(row('a').viewSectionIds?.someday).toBeUndefined();
        expect(await store.commitPreparedTaskEdits([{ before: row('a'), changes: { viewSectionIds: { someday: 'ideas' } } },
            { before: row('b'), changes: { viewSectionIds: { someday: 'later' } } }])).toMatchObject({ success: true, ids: ['a', 'b'] });
        expect([row('a').viewSectionIds?.someday, row('b').viewSectionIds?.someday]).toEqual(['ideas', 'later']);
    });
});
