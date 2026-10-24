import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeHostContract, type NativeHostResult } from './native-host-contract';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Area, Project, Section, Task } from './types';
import { collectProjectTaskLinks, undoProjectDelete } from './undo-project-delete';

const AT = '2026-10-01T12:00:00.000Z';
const ID = 'project-delete';
const DELETE_ID = '8bebf523-dd4e-40dc-9fce-37e456295d49';
const UNDO_ID = '9bebf523-dd4e-40dc-9fce-37e456295d49';
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const value = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const project = (extra: Partial<Project> = {}): Project => ({ id: ID, title: 'Saved Project', status: 'active',
    color: '#123456', order: 0, tagIds: ['#kept'], supportNotes: 'Keep project notes',
    createdAt: AT, updatedAt: AT, rev: 7, revBy: 'delete-device', ...extra });
const section = (id: string, extra: Partial<Section> = {}): Section => ({ id, projectId: ID,
    title: id, order: 0, createdAt: AT, updatedAt: AT, rev: 2, revBy: 'delete-device', ...extra });
const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, title: id, status: 'next',
    projectId: ID, sectionId: 'section-live', description: 'Keep task notes',
    contexts: ['@home'], tags: ['#kept'], createdAt: AT, updatedAt: AT, rev: 3,
    revBy: 'delete-device', ...extra });
const area = (): Area => ({ id: 'area-live', name: 'Area', order: 0, createdAt: AT, updatedAt: AT });
const initial = (overrides: Partial<AppData> = {}): AppData => ({
    projects: [project()], sections: [section('section-live'), section('section-prior', { deletedAt: AT })],
    tasks: [task('task-linked'), task('task-refiled'), task('task-deleted'),
        task('task-section-only', { projectId: undefined }),
        task('task-prior', { deletedAt: AT }), task('task-unrelated', { projectId: undefined, sectionId: undefined })],
    areas: [area()], people: [], settings: { deviceId: 'delete-device', migrations: { version: 1 } }, ...overrides,
});

async function open(start: AppData = initial(), shouldFail: () => boolean = () => false) {
    await flushPendingSave(); resetForTests();
    let durable = copy(start);
    let saves = 0;
    setStorageAdapter({ getData: async () => copy(durable), saveData: async (next) => {
        if (shouldFail()) throw new Error('disk unavailable');
        durable = copy(next); saves += 1;
    } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0,
        lastDataChangeAt: 0 } as never);
    const host = createNativeHostContract();
    value(await host.activate({ writeSafetyReady: true }));
    await flushPendingSave(); saves = 0;
    const deleteRequest = (requestId = DELETE_ID) => ({ requestId, projectId: ID,
        projectRevision: value(host.getProjectDetail({ projectId: ID, offset: 0, limit: 20 })).projectRevision });
    const prepareDelete = () => {
        const request = deleteRequest();
        const plan = value(host.prepareProjectDelete(request));
        expect(plan.kind).toBe('prepared');
        return { request, prepared: plan.prepared };
    };
    const prepareUndo = (deletion: ReturnType<typeof prepareDelete>) => {
        const request = { requestId: UNDO_ID, deleteRequestId: DELETE_ID };
        const plan = value(host.prepareProjectDeleteUndo({ request, delete: deletion }));
        expect(plan.kind).toBe('prepared');
        return { request, prepared: plan.prepared };
    };
    return { host, deleteRequest, prepareDelete, prepareUndo, saves: () => saves,
        data: () => durable, reopen: async () => open(durable, shouldFail), state: () => useTaskStore.getState() };
}

afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); });

const insertSectionOnlyRow = (id: string) => {
    const state = useTaskStore.getState();
    const row = task(id, { projectId: undefined, sectionId: 'section-live' });
    useTaskStore.setState({ _allTasks: [...state._allTasks, row],
        _tasksById: new Map([...state._tasksById, [id, row]]) } as never);
};

const insertOwnedRow = (id: string, order: number) => {
    const state = useTaskStore.getState();
    const row = task(id, { order, orderNum: order });
    useTaskStore.setState({ _allTasks: [...state._allTasks, row],
        _tasksById: new Map([...state._tasksById, [id, row]]) } as never);
};

describe('prepared Project Delete and Undo', () => {
    it('matches RN Undo from the same legacy deleted document without a catalog', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(AT));
        const original = await open();
        const links = collectProjectTaskLinks(ID);
        const deletion = original.prepareDelete();
        value(await original.host.commitPreparedProjectDelete(deletion));
        // A document saved by the earlier native Delete has no taxonomy catalog.
        const legacyDeleted = copy(original.data()); delete legacyDeleted.settings.taxonomy;
        const rn = await open(legacyDeleted);
        const before = copy(rn.data());
        await undoProjectDelete(ID, links); await flushPendingSave();
        const expected = copy(rn.data());
        // Undo puts the tokens back in use, so neither side writes a catalogue.
        expect(expected.settings.taxonomy).toBeUndefined();
        const native = await open(legacyDeleted);
        expect(native.data()).toEqual(before);
        value(await native.host.commitPreparedProjectDeleteUndo(native.prepareUndo(deletion)));
        expect(native.data()).toEqual(expected);
    });

    it.each([1, 2] as const)('retains the v%s Undo color policy after deleting its Area and cold receipt replay', async (version) => {
        const env = await open(initial({ projects: [project({ areaId: 'area-live', areaTitle: 'Area' })] }));
        const deletion = env.prepareDelete();
        value(await env.host.commitPreparedProjectDelete(deletion));
        await useTaskStore.getState().deleteArea('area-live');
        await flushPendingSave();
        const envelope = env.prepareUndo(deletion);
        expect(envelope.prepared.version).toBe(2);
        envelope.prepared.version = version;
        if (version === 1) envelope.prepared.effect.project.after.color = envelope.prepared.scope.project.color;
        const frozen = copy(envelope);
        expect(value(env.host.validatePreparedProjectDeleteUndo(frozen))).toEqual({ id: ID });
        expect(value(await env.host.commitPreparedProjectDeleteUndo(frozen))).toEqual({ id: ID });
        expect(env.data().projects[0].areaId).toBeUndefined();
        expect(env.data().projects[0].color).toBe(version === 1 ? '#123456' : '#94a3b8');
        const cold = await env.reopen();
        expect(value(await cold.host.commitPreparedProjectDeleteUndo(frozen))).toEqual({ id: ID });
        expect(cold.saves()).toBe(0);
    });

    it('deletes an archived Project, sections and linked live Tasks, preserving content and prior tombstones', async () => {
        const env = await open(initial({ projects: [project({ status: 'archived', archivedAt: AT })] }));
        const envelope = env.prepareDelete();
        // Load repair clears an orphan section-only link under an archived Project.
        expect(envelope.prepared.scope.tasks.map((row) => row.id)).not.toContain('task-section-only');
        expect(envelope.prepared.effect.tasks.map((row) => row.before.id)).not.toContain('task-prior');
        expect(value(env.host.validatePreparedProjectDelete(envelope))).toEqual(envelope.prepared.result);
        expect(envelope.prepared.result.deletion).toMatchObject({ undoEnabled: true });
        expect(value(await env.host.commitPreparedProjectDelete(envelope))).toEqual(envelope.prepared.result);
        const state = env.state();
        expect(state._projectsById.get(ID)).toMatchObject({ status: 'archived', archivedAt: AT,
            supportNotes: 'Keep project notes' });
        expect(state._projectsById.get(ID)?.deletedAt).toBeTruthy();
        expect(state._allSections.find((row) => row.id === 'section-live')?.deletedAt).toBeTruthy();
        expect(state._allSections.find((row) => row.id === 'section-prior')?.deletedAt).toBe(AT);
        for (const id of ['task-linked', 'task-refiled', 'task-deleted', 'task-section-only']) {
            expect(state._tasksById.get(id)).toMatchObject({ description: 'Keep task notes' });
            expect(state._tasksById.get(id)?.projectId).toBeUndefined();
            expect(state._tasksById.get(id)?.sectionId).toBeUndefined();
            expect(state._tasksById.get(id)?.deletedAt).toBeUndefined();
        }
        expect(state._tasksById.get('task-prior')?.deletedAt).toBe(AT);
        expect(env.saves()).toBe(1);
    });

    it('Undo reattaches only currently loose Tasks and keeps later content edits', async () => {
        const env = await open();
        const deletion = env.prepareDelete();
        expect(deletion.prepared.scope.tasks.map((row) => row.id)).toContain('task-section-only');
        expect(value(await env.host.commitPreparedProjectDelete(deletion))).toEqual(deletion.prepared.result);
        await useTaskStore.getState().updateTask('task-linked', { description: 'Later saved content' });
        await useTaskStore.getState().updateTask('task-refiled', { areaId: 'area-live' });
        await useTaskStore.getState().deleteTask('task-deleted');
        await flushPendingSave();
        const undo = env.prepareUndo(deletion);
        expect(value(env.host.validatePreparedProjectDeleteUndo(undo))).toEqual({ id: ID });
        expect(value(await env.host.commitPreparedProjectDeleteUndo(undo))).toEqual({ id: ID });
        const state = env.state();
        expect(state._projectsById.get(ID)?.deletedAt).toBeUndefined();
        expect(state._allSections.find((row) => row.id === 'section-live')?.deletedAt).toBeUndefined();
        expect(state._tasksById.get('task-linked')).toMatchObject({ projectId: ID,
            sectionId: 'section-live', description: 'Later saved content' });
        expect(state._tasksById.get('task-section-only')).toMatchObject({ projectId: ID,
            sectionId: 'section-live' });
        expect(state._tasksById.get('task-refiled')?.projectId).toBeUndefined();
        expect(state._tasksById.get('task-refiled')?.areaId).toBe('area-live');
        expect(state._tasksById.get('task-deleted')?.deletedAt).toBeTruthy();
    });

    it('cold exact-after replay acknowledges Delete and Undo once, but refuses a later child edit', async () => {
        const env = await open();
        const deletion = env.prepareDelete();
        expect(value(await env.host.commitPreparedProjectDelete(deletion))).toEqual(deletion.prepared.result);
        const afterDelete = await env.reopen();
        expect(value(await afterDelete.host.commitPreparedProjectDelete(deletion))).toEqual(deletion.prepared.result);
        expect(afterDelete.saves()).toBe(0);
        const undo = afterDelete.prepareUndo(deletion);
        expect(value(await afterDelete.host.commitPreparedProjectDeleteUndo(undo))).toEqual({ id: ID });
        const afterUndo = await afterDelete.reopen();
        expect(value(await afterUndo.host.commitPreparedProjectDeleteUndo(undo))).toEqual({ id: ID });
        expect(afterUndo.saves()).toBe(0);
        await useTaskStore.getState().updateTask('task-linked', { description: 'Later saved edit' });
        await flushPendingSave();
        const changed = await afterUndo.reopen();
        expect(await changed.host.commitPreparedProjectDeleteUndo(undo)).toMatchObject({
            ok: false, error: { code: 'STALE_REVISION' },
        });
        expect(changed.saves()).toBe(0);
    });

    it('rejects a new section-only member between preparation and either atomic write', async () => {
        const env = await open();
        const deletion = env.prepareDelete();
        insertSectionOnlyRow('new-before-delete');
        expect(await env.host.commitPreparedProjectDelete(deletion)).toMatchObject({
            ok: false, error: { code: 'STALE_REVISION' },
        });
        expect(env.saves()).toBe(0);

        const ready = await open();
        const confirmed = ready.prepareDelete();
        value(await ready.host.commitPreparedProjectDelete(confirmed));
        const undo = ready.prepareUndo(confirmed);
        insertSectionOnlyRow('new-before-undo');
        expect(await ready.host.commitPreparedProjectDeleteUndo(undo)).toMatchObject({
            ok: false, error: { code: 'STALE_REVISION' },
        });
        expect(ready.saves()).toBe(1);
    });

    it('rejects forged effects before a write', async () => {
        const env = await open();
        const deletion = env.prepareDelete();
        const forged = copy(deletion);
        forged.prepared.effect.project.after.title = 'Forged title';
        expect(env.host.validatePreparedProjectDelete(forged)).toMatchObject({
            ok: false, error: { code: 'INVALID_INPUT' },
        });
        expect(await env.host.commitPreparedProjectDelete(forged)).toMatchObject({
            ok: false, error: { code: 'INVALID_INPUT' },
        });
        expect(env.saves()).toBe(0);
        value(await env.host.commitPreparedProjectDelete(deletion));
        const undo = env.prepareUndo(deletion);
        const forgedUndo = copy(undo);
        forgedUndo.prepared.effect.project.after.title = 'Forged restored title';
        expect(env.host.validatePreparedProjectDeleteUndo(forgedUndo)).toMatchObject({
            ok: false, error: { code: 'INVALID_INPUT' },
        });
        expect(await env.host.commitPreparedProjectDeleteUndo(forgedUndo)).toMatchObject({
            ok: false, error: { code: 'INVALID_INPUT' },
        });
        expect(env.saves()).toBe(1);
    });

    it('retries a failed durable save with the same Delete UUID without applying twice', async () => {
        let fail = false;
        const env = await open(initial(), () => fail);
        const deletion = env.prepareDelete();
        fail = true;
        expect(await env.host.commitPreparedProjectDelete(deletion)).toMatchObject({
            ok: false, error: { code: 'SAVE_FAILED' },
        });
        const afterFirst = copy(env.state()._projectsById.get(ID)!);
        expect(afterFirst.deletedAt).toBeTruthy();
        fail = false;
        expect(value(await env.host.commitPreparedProjectDelete(deletion))).toEqual(deletion.prepared.result);
        expect(env.state()._projectsById.get(ID)).toEqual(afterFirst);
        expect(env.saves()).toBe(1);
    });

    it('refuses Undo after a witnessed Area changes, preserving Delete', async () => {
        const env = await open(initial({ projects: [project({ areaId: 'area-live', areaTitle: 'Area' })] }));
        const deletion = env.prepareDelete();
        value(await env.host.commitPreparedProjectDelete(deletion));
        const undo = env.prepareUndo(deletion);
        await useTaskStore.getState().updateArea('area-live', { name: 'Renamed Area' });
        await flushPendingSave();
        expect(await env.host.commitPreparedProjectDeleteUndo(undo)).toMatchObject({
            ok: false, error: { code: 'STALE_REVISION' },
        });
        expect(env.state()._projectsById.get(ID)?.deletedAt).toBeTruthy();
    });

    it('reserves RN batch Project order for each reattached Task, preserving content', async () => {
        const source = initial({ tasks: [task('first', { order: 8, orderNum: 8 }),
            task('second', { order: 2, orderNum: 2 }),
            task('task-prior', { deletedAt: AT })] });
        const native = await open(source);
        const deletion = native.prepareDelete();
        value(await native.host.commitPreparedProjectDelete(deletion));
        insertOwnedRow('current-project-task', 12);
        const undo = native.prepareUndo(deletion);
        value(await native.host.commitPreparedProjectDeleteUndo(undo));
        const actual = ['first', 'second', 'current-project-task'].map((id) => {
            const row = native.state()._tasksById.get(id)!;
            return { id, order: row.order, orderNum: row.orderNum, description: row.description };
        });
        expect(actual).toEqual([
            { id: 'first', order: 13, orderNum: 13, description: 'Keep task notes' },
            { id: 'second', order: 14, orderNum: 14, description: 'Keep task notes' },
            { id: 'current-project-task', order: 12, orderNum: 12, description: 'Keep task notes' },
        ]);

        const rn = await open(source);
        const links = collectProjectTaskLinks(ID);
        await rn.state().deleteProject(ID);
        insertOwnedRow('current-project-task', 12);
        await undoProjectDelete(ID, links);
        expect(['first', 'second', 'current-project-task'].map((id) => {
            const row = rn.state()._tasksById.get(id)!;
            return { id, order: row.order, orderNum: row.orderNum, description: row.description };
        })).toEqual(actual);
    });
});
