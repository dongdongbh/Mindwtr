import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeHostContract, type NativeHostResult } from './native-host-contract';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Area, Project, Section, Task } from './types';

const AT = '2026-10-01T12:00:00.000Z';
const DELETED = '2026-10-02T12:00:00.000Z';
const PRIOR = '2026-09-30T12:00:00.000Z';
const ID = 'restore-project';
const REQUEST_ID = '5bebf523-dd4e-40dc-9fce-37e456295d49';
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const value = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const project = (extra: Partial<Project> = {}): Project => ({ id: ID, title: 'Saved Project', status: 'active',
    color: '#123456', order: 0, tagIds: ['#kept'], supportNotes: 'Retain notes',
    createdAt: AT, updatedAt: DELETED, deletedAt: DELETED, rev: 7, revBy: 'restore-device', ...extra });
const section = (id: string, extra: Partial<Section> = {}): Section => ({ id, projectId: ID,
    title: id, order: 0, createdAt: AT, updatedAt: DELETED, rev: 2, revBy: 'restore-device', ...extra });
const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, title: id, status: 'next',
    projectId: ID, description: 'Retain task notes', checklist: [{ id: 'check-1', title: 'Keep', isCompleted: true }],
    contexts: ['@home'], tags: ['#kept'], createdAt: AT, updatedAt: DELETED, rev: 3,
    revBy: 'restore-device', ...extra });
const area = (extra: Partial<Area> = {}): Area => ({ id: 'area-live', name: 'Live Area', order: 0,
    createdAt: AT, updatedAt: AT, ...extra });
const initial = (overrides: Partial<AppData> = {}): AppData => ({
    projects: [project()], sections: [section('section-cascade', { deletedAt: DELETED }),
        section('section-prior', { deletedAt: PRIOR })],
    tasks: [task('task-cascade', { sectionId: 'section-cascade', deletedAt: DELETED }),
        task('task-archived', { sectionId: 'section-cascade', status: 'archived', deletedAt: DELETED,
            completedAt: AT, archivedAt: AT, recurrence: { rule: 'weekly', strategy: 'strict', byDay: ['MO'] },
            attachments: [{ id: 'link-1', kind: 'link', title: 'Reference', uri: 'https://example.invalid/saved',
                createdAt: AT, updatedAt: AT }] }),
        task('task-prior', { sectionId: 'section-prior', deletedAt: PRIOR }),
        task('task-detached', { projectId: undefined, sectionId: undefined }),
        task('task-purged', { deletedAt: DELETED, purgedAt: DELETED })],
    areas: [area()], people: [], settings: { deviceId: 'restore-device', migrations: { version: 1 } }, ...overrides,
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
    const request = (requestId = REQUEST_ID) => {
        const view = value(host.getTrashView({ offset: 0, limit: 50 }));
        const row = view.items.find((item) => item.type === 'project' && item.id === ID);
        if (!row || row.type !== 'project') throw new Error('Expected saved Trash Project row');
        return { requestId, projectId: ID, projectRevision: row.projectRevision };
    };
    const prepare = () => {
        const selected = request();
        const plan = value(host.prepareTrashProjectRestore(selected));
        expect(plan.kind).toBe('prepared');
        return { request: selected, prepared: plan.prepared };
    };
    return { host, request, prepare, saves: () => saves, data: () => durable,
        reopen: async () => open(durable, shouldFail), state: () => useTaskStore.getState() };
}

afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); });

describe('prepared single Project restore from Trash', () => {
    it.each([1, 2] as const)('retries v%s restore after Area deletion and cold-replays the original receipt', async (version) => {
        let failed = false;
        const env = await open(initial({ projects: [project({ areaId: 'area-live', areaTitle: 'Live Area' })] }), () => failed);
        await useTaskStore.getState().deleteArea('area-live');
        await flushPendingSave();
        const envelope = env.prepare();
        expect(envelope.prepared.version).toBe(2);
        envelope.prepared.version = version;
        if (version === 1) envelope.prepared.effect.project.after.color = envelope.prepared.scope.project.color;
        const frozen = copy(envelope);
        expect(value(env.host.validatePreparedTrashProjectRestore(frozen))).toEqual({ id: ID });
        failed = true;
        expect(await env.host.commitPreparedTrashProjectRestore(frozen)).toMatchObject({ ok: false,
            error: { code: 'SAVE_FAILED' } });
        failed = false;
        expect(value(await env.host.commitPreparedTrashProjectRestore(frozen))).toEqual({ id: ID });
        expect(env.data().projects[0].color).toBe(version === 1 ? '#123456' : '#94a3b8');
        expect(env.data().projects[0].areaId).toBeUndefined();
        const cold = await env.reopen();
        expect(value(cold.host.validatePreparedTrashProjectRestore(frozen))).toEqual({ id: ID });
        expect(value(await cold.host.commitPreparedTrashProjectRestore(frozen))).toEqual({ id: ID });
        expect(cold.saves()).toBe(0);
    });

    it('restores only cascade-stamped children and retains unrelated saved rows and content', async () => {
        const env = await open();
        const frozen = env.prepare();
        expect(frozen.prepared.scope.tasks.map((row) => row.id)).toEqual([
            'task-cascade', 'task-archived', 'task-prior', 'task-purged']);
        expect(frozen.prepared.scope.sections.map((row) => row.id)).toEqual([
            'section-cascade', 'section-prior']);
        expect(frozen.prepared.effect.tasks.map((pair) => pair.before.id)).toEqual(['task-cascade', 'task-archived']);
        expect(frozen.prepared.effect.sections.map((pair) => pair.before.id)).toEqual(['section-cascade']);
        expect(value(env.host.validatePreparedTrashProjectRestore(frozen))).toEqual({ id: ID });
        expect(value(await env.host.commitPreparedTrashProjectRestore(frozen))).toEqual({ id: ID });
        const state = env.state();
        expect(state._projectsById.get(ID)).toMatchObject({ title: 'Saved Project', supportNotes: 'Retain notes' });
        expect(state._projectsById.get(ID)?.deletedAt).toBeUndefined();
        expect(state._tasksById.get('task-cascade')).toMatchObject({ description: 'Retain task notes',
            checklist: [{ id: 'check-1', title: 'Keep', isCompleted: true }], sectionId: 'section-cascade' });
        expect(state._tasksById.get('task-cascade')?.deletedAt).toBeUndefined();
        expect(state._tasksById.get('task-archived')).toMatchObject({ status: 'archived',
            completedAt: AT, archivedAt: AT, description: 'Retain task notes',
            recurrence: { rule: 'weekly', strategy: 'strict', byDay: ['MO'] },
            attachments: [{ id: 'link-1', kind: 'link', title: 'Reference', uri: 'https://example.invalid/saved',
                createdAt: AT, updatedAt: AT }] });
        expect(state._tasksById.get('task-archived')?.deletedAt).toBeUndefined();
        expect(state._tasksById.get('task-prior')?.deletedAt).toBe(PRIOR);
        expect(state._tasksById.get('task-purged')?.purgedAt).toBeTruthy();
        expect(state._tasksById.get('task-detached')?.projectId).toBeUndefined();
        expect(state._allSections.find((row) => row.id === 'section-prior')?.deletedAt).toBe(PRIOR);
        expect(env.saves()).toBe(1);
    });

    it('keeps a live Area title, repairs a missing Area, and drops a dangling Section link', async () => {
        const live = await open(initial({ projects: [project({ areaId: 'area-live', areaTitle: 'Custom title' })],
            tasks: [task('task-cascade', { deletedAt: DELETED, sectionId: 'missing-section' })] }));
        const livePlan = live.prepare();
        expect(livePlan.prepared.effect.project.after).toMatchObject({ areaId: 'area-live', areaTitle: 'Custom title' });
        expect(livePlan.prepared.effect.tasks[0].after.sectionId).toBeUndefined();
        expect(value(await live.host.commitPreparedTrashProjectRestore(livePlan))).toEqual({ id: ID });
        const missing = await open(initial({ projects: [project({ areaId: 'area-missing', areaTitle: 'Stale title' })] }));
        const missingPlan = missing.prepare();
        expect(missingPlan.prepared.scope.area).toBeNull();
        expect(missingPlan.prepared.effect.project.after.areaId).toBeUndefined();
        expect(missingPlan.prepared.effect.project.after.areaTitle).toBeUndefined();
        expect(value(await missing.host.commitPreparedTrashProjectRestore(missingPlan))).toEqual({ id: ID });
    });

    it('allows a cold exact-after retry without another write but refuses later child edits', async () => {
        const env = await open();
        const envelope = env.prepare();
        expect(value(await env.host.commitPreparedTrashProjectRestore(envelope))).toEqual({ id: ID });
        const cold = await env.reopen();
        expect(value(cold.host.validatePreparedTrashProjectRestore(envelope))).toEqual({ id: ID });
        expect(value(await cold.host.commitPreparedTrashProjectRestore(envelope))).toEqual({ id: ID });
        expect(cold.saves()).toBe(0);
        await useTaskStore.getState().updateTask('task-cascade', { description: 'Later edit' });
        await flushPendingSave();
        const changed = copy(useTaskStore.getState()._tasksById.get('task-cascade'));
        const later = await cold.reopen();
        expect(await later.host.commitPreparedTrashProjectRestore(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(later.state()._tasksById.get('task-cascade')).toEqual(changed);
        expect(later.saves()).toBe(0);
    });

    it('retries a failed save exactly with the same UUID', async () => {
        let fail = false;
        const env = await open(initial(), () => fail);
        const envelope = env.prepare();
        fail = true;
        expect(await env.host.commitPreparedTrashProjectRestore(envelope)).toMatchObject({ ok: false,
            error: { code: 'SAVE_FAILED' } });
        expect(env.state()._projectsById.get(ID)?.deletedAt).toBeUndefined();
        fail = false;
        expect(value(await env.host.commitPreparedTrashProjectRestore(envelope))).toEqual({ id: ID });
        expect(env.state()._projectsById.get(ID)?.rev).toBe(envelope.prepared.effect.project.after.rev);
        expect(env.saves()).toBe(1);
    });

    it('refuses a stale Trash revision, child mutation, and newly linked member without writing', async () => {
        const env = await open();
        const selected = env.request();
        expect(env.host.prepareTrashProjectRestore({ ...selected, projectRevision: 'stale' }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        const envelope = env.prepare();
        const previous = env.state()._tasksById.get('task-prior')!;
        const changed = { ...previous, description: 'Unrelated child edit', rev: (previous.rev ?? 0) + 1 };
        useTaskStore.setState((state) => ({ _allTasks: state._allTasks.map((row) => row.id === changed.id ? changed : row),
            _tasksById: new Map(state._tasksById).set(changed.id, changed) }));
        expect(await env.host.commitPreparedTrashProjectRestore(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(env.state()._projectsById.get(ID)?.deletedAt).toBe(DELETED);
        const fresh = env.prepare();
        const newTask = task('task-new', { deletedAt: PRIOR });
        useTaskStore.setState((state) => ({ _allTasks: [...state._allTasks, newTask],
            _tasksById: new Map(state._tasksById).set(newTask.id, newTask) }));
        expect(await env.host.commitPreparedTrashProjectRestore(fresh)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
    });

    it('refuses a changed Area witness and an oversized cascade without partial writes', async () => {
        const env = await open(initial({ projects: [project({ areaId: 'area-live', areaTitle: 'Live Area' })] }));
        const envelope = env.prepare();
        await useTaskStore.getState().updateArea('area-live', { color: '#ef4444' });
        await flushPendingSave();
        expect(await env.host.commitPreparedTrashProjectRestore(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(env.state()._projectsById.get(ID)?.deletedAt).toBe(DELETED);

        const huge = await open(initial({ tasks: [task('task-huge', { deletedAt: DELETED,
            description: 'x'.repeat(1_000_000) })] }));
        expect(huge.host.prepareTrashProjectRestore(huge.request())).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        expect(huge.saves()).toBe(0);
    });

    it('rejects malformed and forged journals before storage', async () => {
        const env = await open();
        const request = env.request();
        for (const invalid of [{ ...request, extra: true }, { ...request, requestId: 'NOT-UUID' },
            { ...request, projectId: 'x'.repeat(201) }, { ...request, projectRevision: 'x'.repeat(201) }]) {
            expect(env.host.prepareTrashProjectRestore(invalid)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
        }
        const envelope = env.prepare();
        for (const mutate of [
            (entry: typeof envelope) => { entry.prepared.scope.project.title = 'Forged Project'; },
            (entry: typeof envelope) => { entry.prepared.effect.tasks[0].after.title = 'Forged Task'; },
            (entry: typeof envelope) => { entry.prepared.effect.sections[0].after.deletedAt = DELETED; },
            (entry: typeof envelope) => { entry.prepared.result.id = 'wrong'; },
            (entry: typeof envelope) => { entry.prepared.scope.tasks[0].projectId = 'other-project'; },
            (entry: typeof envelope) => { (entry.prepared.scope.project as Project & { archivedAt: unknown }).archivedAt = true; 
                (entry.prepared.effect.project.before as Project & { archivedAt: unknown }).archivedAt = true;
                (entry.prepared.effect.project.after as Project & { archivedAt: unknown }).archivedAt = true; },
        ]) {
            const forged = copy(envelope);
            mutate(forged);
            expect(env.host.validatePreparedTrashProjectRestore(forged)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
            expect(await env.host.commitPreparedTrashProjectRestore(forged)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
        }
        const omitted = copy(envelope);
        omitted.prepared.scope.tasks.splice(0, 1);
        omitted.prepared.effect.tasks.splice(0, 1);
        expect(env.host.validatePreparedTrashProjectRestore(omitted)).toMatchObject({ ok: true });
        expect(await env.host.commitPreparedTrashProjectRestore(omitted)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(env.saves()).toBe(0);
    });
});
