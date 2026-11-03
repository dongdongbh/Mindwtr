import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBoardRecorder, loadBoardViewsFixture, seedBoardStore } from './board-view-model.replay';
import { createNativeHostContract } from './native-host-contract';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import type { NativePreparedBoardAction } from './native-host-contract-board';

const fixture = loadBoardViewsFixture().board;
const requestId = '97bb2a90-d834-44b0-aed3-c2f7d0e48e5a';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const value = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};

async function open(saveData?: (data: unknown) => Promise<void>) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(fixture.now));
    const recorder = createBoardRecorder();
    await seedBoardStore(fixture, { name: 'prepared', settings: 'base', actions: [] }, recorder, { saveData });
    const host = createNativeHostContract();
    value(await host.activate({ writeSafetyReady: true }));
    recorder.log.length = 0;
    return { host, recorder };
}

async function restart() {
    const host = createNativeHostContract();
    value(await host.activate({ writeSafetyReady: true, recoveryLoad: true }));
    return host;
}

function prepare(host: ReturnType<typeof createNativeHostContract>, type: 'duplicateTask' | 'trashTask', taskId = 'n-draft') {
    const result = value(host.prepareBoardAction({ requestId, action: { type, taskId } }));
    if (result.kind !== 'prepared') throw new Error('Expected prepared write');
    return clone(result.prepared);
}
const commit = (host: ReturnType<typeof createNativeHostContract>, prepared: NativePreparedBoardAction) =>
    host.commitPreparedBoardAction({ request: prepared.request, prepared });

afterEach(async () => {
    await flushPendingSave();
    resetForTests();
    vi.useRealTimers();
});

describe('native prepared Board actions', () => {
    it('duplicates the saved source while an unrelated editor draft remains unsaved', async () => {
        const { host } = await open();
        const source = clone(useTaskStore.getState()._tasksById.get('n-draft'));
        const opening = value(host.getTaskEditorModel({ id: 'n-draft' }));
        const edited = value(host.editTaskDraft({ id: 'n-draft', draft: opening.draft,
            edit: { type: 'fields', patch: { title: 'Unsaved editor title', description: 'Unsaved editor note' } } }));
        expect(edited.draft.title).toBe('Unsaved editor title');
        expect(useTaskStore.getState()._tasksById.get('n-draft')).toEqual(source);

        const prepared = prepare(host, 'duplicateTask');
        expect(prepared.before).toEqual(source);
        expect(prepared.after.title).toBe(source.title);
        expect(prepared.after.description).toBe(source.description);
        expect(value(await commit(host, prepared))).toEqual(prepared.result);
        expect(useTaskStore.getState()._tasksById.get('n-draft')).toEqual(source);
        expect(useTaskStore.getState()._tasksById.get(requestId)).toEqual(prepared.after);
    });

    it('prepares without writes and refuses re-deleting a later restored task', async () => {
        const { host, recorder } = await open();
        const before = clone(useTaskStore.getState()._allTasks);
        const prepared = prepare(host, 'trashTask', 'n-bulbs');
        expect(useTaskStore.getState()._allTasks).toEqual(before);
        expect(recorder.log).toEqual([]);
        expect(value(await commit(host, prepared))).toEqual(prepared.result);
        await useTaskStore.getState().restoreTask('n-bulbs');
        await flushPendingSave();
        const reopened = await restart();
        const restored = clone(useTaskStore.getState()._allTasks);
        recorder.log.length = 0;
        expect(await commit(reopened, prepared)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(useTaskStore.getState()._allTasks).toEqual(restored);
        expect(recorder.log).toEqual([]);
    });

    it('acknowledges the exact frozen copy before checking a later changed or deleted source', async () => {
        const { host } = await open();
        const prepared = prepare(host, 'duplicateTask');
        expect(value(await commit(host, prepared))).toEqual(prepared.result);
        expect(prepared.result.open?.taskId).toBe(requestId);
        await useTaskStore.getState().updateTask('n-draft', { title: 'Synthetic newer source' });
        await useTaskStore.getState().deleteTask('n-draft');
        await flushPendingSave();
        const reopened = await restart();
        const before = clone(useTaskStore.getState()._allTasks);
        expect(value(await commit(reopened, prepared))).toEqual(prepared.result);
        expect(useTaskStore.getState()._allTasks).toEqual(before);
        expect(before.filter((task) => task.id === requestId)).toHaveLength(1);
    });

    it('refuses a changed source before creating its copy and a copy edited then reverted', async () => {
        const { host } = await open();
        const prepared = prepare(host, 'duplicateTask');
        await useTaskStore.getState().updateTask('n-draft', { description: 'Newer description' });
        await flushPendingSave();
        const before = clone(useTaskStore.getState()._allTasks);
        expect(await commit(host, prepared)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(useTaskStore.getState()._allTasks).toEqual(before);
        const fresh = prepare(host, 'duplicateTask');
        value(await commit(host, fresh));
        await useTaskStore.getState().updateTask(requestId, { title: 'Temporary edit' });
        await useTaskStore.getState().updateTask(requestId, { title: fresh.after.title });
        await flushPendingSave();
        expect(await commit(await restart(), fresh)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });
    it.each(['duplicateTask', 'trashTask'] as const)('retries an owed %s save without a second mutation and keeps exact result', async (kind) => {
        let fail = false;
        const saveData = vi.fn(async () => { if (fail) throw new Error('synthetic disk failure'); });
        const { host } = await open(saveData);
        const prepared = prepare(host, kind);
        fail = true;
        expect(await commit(host, prepared)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        const landed = clone(useTaskStore.getState()._allTasks);
        const forged = clone(prepared);
        forged.request.requestId = '97bb2a90-d834-44b0-aed3-c2f7d0e48e5b';
        expect(await host.commitPreparedBoardAction({ request: prepared.request, prepared: forged }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(useTaskStore.getState()._allTasks).toEqual(landed);
        fail = false;
        expect(value(await commit(host, prepared))).toEqual(prepared.result);
        expect(useTaskStore.getState()._allTasks).toEqual(landed);
        expect(value(await commit(await restart(), prepared))).toEqual(prepared.result);
    });

    it.each(['next', 'reference'] as const)('preserves %s duplicate fields and generated identities through clock changes and source-independent replay', async (status) => {
        const { host } = await open();
        const state = useTaskStore.getState();
        const source = state._tasksById.get('n-draft')!;
        await state.updateTask(source.id, {
            status,
            checklist: [{ id: 'old-step', title: 'Synthetic step', isCompleted: true },
                { id: 'old-open-step', title: 'Unfinished step', isCompleted: false }],
            attachments: [
                { id: 'old-link', kind: 'link', title: 'Synthetic link', uri: 'https://example.invalid/test', createdAt: fixture.now, updatedAt: fixture.now },
                { id: 'old-file', kind: 'file', title: 'Synthetic file', uri: 'file:///synthetic', createdAt: fixture.now, updatedAt: fixture.now },
            ],
        });
        await flushPendingSave();
        const before = clone(useTaskStore.getState()._allTasks);
        const prepared = prepare(host, 'duplicateTask');
        expect(prepared.after.checklist).toMatchObject([{ title: 'Synthetic step', isCompleted: true },
            { title: 'Unfinished step', isCompleted: false }]);
        const childIds = prepared.after.checklist!.map((item) => item.id);
        expect(childIds.every((id) => !['old-step', 'old-open-step', source.id, requestId].includes(id))).toBe(true);
        expect(new Set(childIds).size).toBe(childIds.length);
        expect(prepared.after.attachments).toMatchObject([{ kind: 'link', uri: 'https://example.invalid/test' }]);
        expect(prepared.after.attachments).toHaveLength(1);
        vi.setSystemTime(new Date('2036-10-02T16:00:00.000Z'));
        value(await commit(host, prepared));
        expect(clone(useTaskStore.getState()._allTasks.filter((task) => task.id !== requestId))).toEqual(before);
        const created = clone(useTaskStore.getState()._tasksById.get(requestId));
        expect(created).toEqual(prepared.after);
        expect(value(await commit(await restart(), prepared))).toEqual(prepared.result);
        expect(clone(useTaskStore.getState()._tasksById.get(requestId))).toEqual(created);
        expect(host.prepareBoardAction(prepared.request)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('recovers exact retained v1 duplicate journals through commit and terminal validation', async () => {
        const { host } = await open();
        await useTaskStore.getState().updateTask('n-draft', { status: 'reference', checklist: [
            { id: 'checked', title: 'Completed step', isCompleted: true },
            { id: 'open', title: 'Remaining step', isCompleted: false },
        ] });
        await flushPendingSave();
        const current = prepare(host, 'duplicateTask');
        expect(current.version).toBe(2);
        const legacy: NativePreparedBoardAction = { ...clone(current), version: 1,
            after: { ...clone(current.after), checklist: current.after.checklist!.map((item) => ({ ...item, isCompleted: false })) } };
        const before = clone(useTaskStore.getState()._allTasks);
        const cold = createNativeHostContract();
        expect(value(cold.validatePreparedBoardAction({ request: legacy.request, prepared: legacy }))).toEqual(legacy.result);
        expect(useTaskStore.getState()._allTasks).toEqual(before);
        const forged = clone(legacy);
        forged.after.checklist![0].isCompleted = true;
        expect(cold.validatePreparedBoardAction({ request: forged.request, prepared: forged }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const resetCurrent = { ...clone(legacy), version: 2 as const };
        expect(cold.validatePreparedBoardAction({ request: resetCurrent.request, prepared: resetCurrent }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const changedCurrent = clone(current);
        changedCurrent.after.checklist![1].isCompleted = true;
        expect(cold.validatePreparedBoardAction({ request: changedCurrent.request, prepared: changedCurrent }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

        expect(value(await commit(host, legacy))).toEqual(legacy.result);
        expect(useTaskStore.getState()._tasksById.get(requestId)).toEqual(legacy.after);
        expect(useTaskStore.getState()._tasksById.get('n-draft')).toEqual(legacy.before);
        await useTaskStore.getState().deleteTask('n-draft');
        await flushPendingSave();
        const landed = clone(useTaskStore.getState()._allTasks);

        expect(value(createNativeHostContract().validatePreparedBoardAction({ request: legacy.request, prepared: legacy })))
            .toEqual(legacy.result);
        expect(value(await commit(await restart(), legacy))).toEqual(legacy.result);
        expect(useTaskStore.getState()._allTasks).toEqual(landed);
    });

    it('keeps Trash on version 1 and refuses a version 2 Trash envelope', async () => {
        const { host } = await open();
        const prepared = prepare(host, 'trashTask');
        expect(prepared.version).toBe(1);
        prepared.version = 2;
        expect(host.validatePreparedBoardAction({ request: prepared.request, prepared: prepared }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('strictly rejects unsupported requests and forged effects before any save', async () => {
        const saveData = vi.fn(async () => undefined);
        const { host } = await open(saveData);
        const prepared = prepare(host, 'duplicateTask');
        const trash = prepare(host, 'trashTask');
        const before = clone(useTaskStore.getState()._allTasks);
        const saves = saveData.mock.calls.length;
        for (const input of [null, {}, { ...prepared.request, extra: true },
            { ...prepared.request, requestId: 'bad' },
            { ...prepared.request, action: { type: 'moveCard', taskId: 'n-draft', status: 'done' } },
            { ...prepared.request, action: { type: 'duplicateTask', taskId: 'n-draft', title: 'forged' } }]) {
            expect(host.prepareBoardAction(input as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        const mutations: ((value: NativePreparedBoardAction) => void)[] = [
            (value) => { value.after.title = 'Forged title'; },
            (value) => { value.after.id = '97bb2a90-d834-44b0-aed3-c2f7d0e48e5b'; },
            (value) => { value.request.action.taskId = 'n-rent'; },
            (value) => { value.after.status = 'done'; },
            (value) => { value.result.open = null; },
            (value) => { value.after.rev = 4; },
            (value) => { Object.assign(value, { extra: true }); },
        ];
        for (const mutate of mutations) {
            const forged = clone(prepared); mutate(forged);
            expect(await commit(host, forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        trash.after.description = 'Unrequested Trash edit';
        expect(await commit(host, trash)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(useTaskStore.getState()._allTasks).toEqual(before);
        expect(saveData).toHaveBeenCalledTimes(saves);
    });

    it('returns an already-trashed no-op without minting a journal or saving', async () => {
        const saveData = vi.fn(async () => undefined);
        const { host } = await open(saveData);
        const saves = saveData.mock.calls.length;
        expect(value(host.prepareBoardAction({ requestId, action: { type: 'trashTask', taskId: 't-trashed' } })))
            .toEqual({ kind: 'noop', result: { changed: false, open: null } });
        expect(saveData).toHaveBeenCalledTimes(saves);
    });

    it.each(['projectOrder', 'boardOrder', 'container'] as const)('guards changed %s only before the copy exists', async (dependency) => {
        const { host } = await open();
        const prepared = prepare(host, 'duplicateTask');
        if (dependency === 'projectOrder') {
            await useTaskStore.getState().addTask('Synthetic order reservation', { status: 'next', projectId: prepared.before.projectId });
        } else if (dependency === 'boardOrder') {
            await useTaskStore.getState().updateTask('n-rent', { boardOrder: prepared.before.boardOrder! + 1 });
        } else {

            useTaskStore.setState((state) => ({ _allProjects: state._allProjects.map((project) => project.id === prepared.before.projectId
                ? { ...project, deletedAt: fixture.now, rev: (project.rev ?? 0) + 1 } : project) }));
            await useTaskStore.getState().persistSnapshot();
        }
        await flushPendingSave();
        const before = clone(useTaskStore.getState()._allTasks);
        expect(await commit(host, prepared)).toMatchObject({ ok: false });
        expect(useTaskStore.getState()._allTasks).toEqual(before);
        expect(useTaskStore.getState()._tasksById.has(requestId)).toBe(false);
    });

    it.each(['archived', 'completed'] as const)('refuses a duplicate when its destination project becomes %s before commit', async (status) => {
        const { host } = await open();
        const prepared = prepare(host, 'duplicateTask');
        useTaskStore.setState((state) => ({ _allProjects: state._allProjects.map((project) => project.id === prepared.before.projectId
            ? { ...project, status, rev: (project.rev ?? 0) + 1 } : project) }));
        await useTaskStore.getState().persistSnapshot();
        const before = clone(useTaskStore.getState()._allTasks);
        expect(await commit(host, prepared)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(useTaskStore.getState()._allTasks).toEqual(before);
        expect(useTaskStore.getState()._tasksById.has(requestId)).toBe(false);
    });

    it('refuses a duplicate if the saved source was deleted before the copy exists', async () => {
        const { host } = await open();
        const prepared = prepare(host, 'duplicateTask');
        expect((await useTaskStore.getState().deleteTask('n-draft')).success).toBe(true);
        await flushPendingSave();
        const before = clone(useTaskStore.getState()._allTasks);
        expect(await commit(await restart(), prepared)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(useTaskStore.getState()._allTasks).toEqual(before);
        expect(useTaskStore.getState()._tasksById.has(requestId)).toBe(false);
    });

    it('validates terminal envelope authority without activation, mutable reads or saves', async () => {
        const saveData = vi.fn(async () => undefined);
        const { host } = await open(saveData);
        const prepared = prepare(host, 'duplicateTask');
        const unactivated = createNativeHostContract();
        const saves = saveData.mock.calls.length;
        const read = vi.spyOn(useTaskStore, 'getState').mockImplementation(() => { throw new Error('Immutable validation must not read store'); });
        try {
            expect(value(unactivated.validatePreparedBoardAction({ request: prepared.request, prepared }))).toEqual(prepared.result);
            for (const forged of [
                { ...prepared, before: {}, after: {} },
                { ...prepared, after: { ...prepared.after, title: 'Forged terminal title' } },
                { ...prepared, deviceIdToInitialize: {} },
                { ...prepared, result: { changed: true, open: null } },
            ]) {
                expect(unactivated.validatePreparedBoardAction({ request: prepared.request, prepared: forged } as never))
                    .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            }
            expect(saveData).toHaveBeenCalledTimes(saves);
        } finally { read.mockRestore(); }
    });

});
