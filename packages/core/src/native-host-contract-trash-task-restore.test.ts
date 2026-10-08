import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createNativeHostContract, type NativeHostResult } from './native-host-contract';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Area, Project, Section, Task } from './types';

const AT = '2026-10-01T12:00:00.000Z';
const DELETED = '2026-10-02T12:00:00.000Z';
// A restored Done row must stay done on the cold reopen: a fixed completion date ages past auto-archive's 7 days.
const RECENTLY_DONE = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const REQUEST_ID = '4bebf523-dd4e-40dc-9fce-37e456295d49';
const ID = 'trash-restore-task';
const copy = <T,>(data: T): T => JSON.parse(JSON.stringify(data)) as T;
const value = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const task = (extra: Partial<Task> = {}): Task => ({ id: ID, title: 'Saved title', status: 'next',
    description: 'Saved **notes**', contexts: ['@work'], tags: ['#kept'],
    checklist: [{ id: 'check-1', title: 'Keep this', isCompleted: true }],
    attachments: [{ id: 'link-1', kind: 'link', title: 'Example', uri: 'https://example.invalid/kept' }],
    recurrence: { rule: 'weekly', strategy: 'strict', byDay: ['MO'] },
    createdAt: AT, updatedAt: DELETED, deletedAt: DELETED, rev: 7, revBy: 'restore-device', ...extra });
const project = (extra: Partial<Project> = {}): Project => ({ id: 'p-live', title: 'Project', status: 'active',
    color: '#123456', order: 0, tagIds: [], createdAt: AT, updatedAt: AT, ...extra });
const section = (extra: Partial<Section> = {}): Section => ({ id: 's-live', projectId: 'p-live',
    title: 'Section', order: 0, createdAt: AT, updatedAt: AT, ...extra });
const area = (extra: Partial<Area> = {}): Area => ({ id: 'a-live', name: 'Area', order: 0,
    createdAt: AT, updatedAt: AT, ...extra });
const initial = (source: Task = task(), overrides: Partial<AppData> = {}): AppData => ({
    tasks: [source], projects: [project()], sections: [section()], areas: [area()], people: [],
    settings: { deviceId: 'restore-device', gtd: { legacySibling: { keep: true } } } as AppData['settings'],
    ...overrides,
});
type RestoreParityCase = { kind: 'action'; action: 'restore'; name: string; task: Task;
    containers: { projects: Partial<Project>[]; sections: Partial<Section>[]; areas: Partial<Area>[] };
    expectedTask: Partial<Task> };
const sharedRestoreCases = (JSON.parse(readFileSync(new URL('./recurrence-local-api-parity.fixtures.json', import.meta.url), 'utf8')) as RestoreParityCase[])
    .filter((entry) => entry.kind === 'action' && entry.action === 'restore');

async function open(start: AppData, shouldFail: () => boolean = () => false, recoveryLoad = false) {
    await flushPendingSave(); resetForTests();
    let durable = copy(start);
    let saves = 0;
    setStorageAdapter({ getData: async () => copy(durable), saveData: async (next) => {
        if (shouldFail()) throw new Error('disk unavailable');
        durable = copy(next); saves += 1;
    } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true, recoveryLoad });
    await flushPendingSave();
    const host = createNativeHostContract();
    value(await host.activate({ writeSafetyReady: true, recoveryLoad }));
    await flushPendingSave();
    saves = 0;
    const current = () => useTaskStore.getState()._tasksById.get(ID)!;
    const request = (requestId = REQUEST_ID) => {
        const view = value(host.getTrashView({ offset: 0, limit: 50 }));
        const item = view.items.find((entry) => entry.type === 'task' && entry.row.id === ID);
        if (!item || item.type !== 'task') throw new Error('Expected saved Trash row');
        return { requestId, taskId: ID, taskRevision: item.row.taskRevision };
    };
    const prepare = () => {
        const selected = request();
        const plan = value(host.prepareTrashTaskRestore(selected));
        expect(plan.kind).toBe('prepared');
        return { request: selected, prepared: plan.prepared };
    };
    const reopen = async () => open(durable, shouldFail);
    return { host, current, request, prepare, reopen, data: () => durable, saves: () => saves };
}

afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); });

describe('prepared single Task restore from Trash', () => {
    it.each([
        { status: 'next' as const },
        { status: 'reference' as const },
        { status: 'done' as const, completedAt: RECENTLY_DONE },
        { status: 'archived' as const, archivedAt: AT },
    ])('restores $status without changing saved content or lifecycle', async (lifecycle) => {
        const source = task(lifecycle);
        const env = await open(initial(source));
        const saved = copy(env.current());
        const envelope = env.prepare();
        expect(envelope.prepared.before).toEqual(saved);
        expect(envelope.prepared.result).toEqual({ id: ID });
        expect(value(env.host.validatePreparedTrashTaskRestore(envelope))).toEqual({ id: ID });
        expect(value(await env.host.commitPreparedTrashTaskRestore(envelope))).toEqual({ id: ID });
        expect(env.current()).toMatchObject({ id: ID, title: source.title, status: lifecycle.status,
            description: source.description, checklist: source.checklist, attachments: source.attachments,
            recurrence: source.recurrence, contexts: source.contexts, tags: source.tags });
        expect(env.current().completedAt).toBe(saved.completedAt);
        expect(env.current().archivedAt).toBe(saved.archivedAt);
        expect(env.current().deletedAt).toBeUndefined();
        expect(env.saves()).toBe(1);
        const cold = await env.reopen();
        expect(value(cold.host.validatePreparedTrashTaskRestore(envelope))).toEqual({ id: ID });
        expect(value(await cold.host.commitPreparedTrashTaskRestore(envelope))).toEqual({ id: ID });
        expect(cold.saves()).toBe(0);
    });

    it('keeps live containers and clears dangling project, section and Area references', async () => {
        const live = await open(initial(task({ projectId: 'p-live', sectionId: 's-live' })));
        const retained = live.prepare();
        expect(retained.prepared.after).toMatchObject({ projectId: 'p-live', sectionId: 's-live' });
        expect(value(await live.host.commitPreparedTrashTaskRestore(retained))).toEqual({ id: ID });
        expect(live.current()).toMatchObject({ projectId: 'p-live', sectionId: 's-live' });

        const dangling = await open(initial(task({ projectId: 'p-live', sectionId: 's-live', areaId: 'a-live' }), {
            projects: [project({ deletedAt: AT })], sections: [section({ deletedAt: AT })], areas: [area({ deletedAt: AT })],
        }));
        const cleared = dangling.prepare();
        expect(cleared.prepared.after.projectId).toBeUndefined();
        expect(cleared.prepared.after.sectionId).toBeUndefined();
        expect(cleared.prepared.after.areaId).toBeUndefined();
        expect(value(await dangling.host.commitPreparedTrashTaskRestore(cleared))).toEqual({ id: ID });
        expect(dangling.current()).toMatchObject({ title: 'Saved title', status: 'next' });
        expect(dangling.current().projectId).toBeUndefined();
        expect(dangling.current().sectionId).toBeUndefined();
        expect(dangling.current().areaId).toBeUndefined();
    });

    it.each(sharedRestoreCases.map((entry) => [entry.name, entry] as const))
    ('uses the shared container parity fixture for %s', async (_name, row) => {
        // The shared parity fixture is historical; move its Trash timestamp inside
        // retention and use the host recovery load to retain raw project+Area rows.
        // A normal UI load already strips Area when projectId is present.
        const source = task({ ...row.task, id: ID, updatedAt: DELETED, deletedAt: DELETED });
        const env = await open(initial(source, {
            projects: row.containers.projects.map((entry) => ({ ...project(), ...entry })),
            sections: row.containers.sections.map((entry) => ({ ...section(), ...entry })),
            areas: row.containers.areas.map((entry) => ({ ...area(), ...entry })),
        }), () => false, true);
        expect(env.current().areaId).toBe(row.task.areaId);
        const envelope = env.prepare();
        expect({ projectId: envelope.prepared.after.projectId, sectionId: envelope.prepared.after.sectionId,
            areaId: envelope.prepared.after.areaId }).toEqual({ projectId: row.expectedTask.projectId,
            sectionId: row.expectedTask.sectionId, areaId: row.expectedTask.areaId });
        expect(value(await env.host.commitPreparedTrashTaskRestore(envelope))).toEqual({ id: ID });
        expect({ projectId: env.current().projectId, sectionId: env.current().sectionId,
            areaId: env.current().areaId }).toEqual({ projectId: row.expectedTask.projectId,
            sectionId: row.expectedTask.sectionId, areaId: row.expectedTask.areaId });
    });

    it('refuses stale Trash rows, changed prepared targets and purged tasks', async () => {
        const env = await open(initial());
        const stale = env.request();
        await useTaskStore.getState().updateTask(ID, { title: 'Newer Trash title' });
        await flushPendingSave();
        expect(env.host.prepareTrashTaskRestore(stale)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        const prepared = env.prepare();
        await useTaskStore.getState().updateTask(ID, { description: 'Newer Trash notes' });
        await flushPendingSave();
        const newer = copy(env.current());
        expect(await env.host.commitPreparedTrashTaskRestore(prepared)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(env.current()).toEqual(newer);
        await useTaskStore.getState().purgeTask(ID);
        await flushPendingSave();
        expect(env.host.prepareTrashTaskRestore(stale)).toMatchObject({ ok: false });
        expect(await env.host.commitPreparedTrashTaskRestore(prepared)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
    });

    it('rejects malformed requests and forged rows, scope, result and effect before storage', async () => {
        const env = await open(initial(task({ projectId: 'p-live', sectionId: 's-live' })));
        const request = env.request();
        for (const invalid of [{ ...request, extra: true }, { ...request, requestId: 'NOT-UUID' },
            { ...request, taskRevision: 'stale' }, { ...request, taskId: 'x'.repeat(201) }]) {
            expect(env.host.prepareTrashTaskRestore(invalid)).toMatchObject({ ok: false });
        }
        const original = env.prepare();
        for (const mutate of [
            (entry: typeof original) => { entry.prepared.before.title = 'Forged source'; },
            (entry: typeof original) => { entry.prepared.after.title = 'Forged result'; },
            (entry: typeof original) => { entry.prepared.scope.projects[0].id = 'other-project'; },
            (entry: typeof original) => { entry.prepared.result.id = 'other-task'; },
            (entry: typeof original) => { entry.prepared.request.taskRevision = 'other-revision'; },
        ]) {
            const forged = copy(original);
            mutate(forged);
            expect(env.host.validatePreparedTrashTaskRestore(forged)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
            expect(await env.host.commitPreparedTrashTaskRestore(forged)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
        }
        const oversized = copy(original);
        oversized.prepared.after.title = 'x'.repeat(2_000_001);
        expect(env.host.validatePreparedTrashTaskRestore(oversized)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        expect(env.saves()).toBe(0);
    });

    it('retries a failed save exactly; a fresh host cannot revive a later target change', async () => {
        let fail = false;
        const env = await open(initial(), () => fail);
        const envelope = env.prepare();
        fail = true;
        expect(await env.host.commitPreparedTrashTaskRestore(envelope)).toMatchObject({ ok: false,
            error: { code: 'SAVE_FAILED' } });
        expect(env.current().deletedAt).toBeUndefined();
        fail = false;
        expect(value(await env.host.commitPreparedTrashTaskRestore(envelope))).toEqual({ id: ID });
        expect(env.saves()).toBe(1);
        await useTaskStore.getState().updateTask(ID, { title: 'Later saved edit' });
        await useTaskStore.getState().updateSettings({ quickAddAutoClean: true });
        await flushPendingSave();
        expect(value(await env.host.commitPreparedTrashTaskRestore(envelope))).toEqual({ id: ID });
        expect(env.current().title).toBe('Later saved edit');
        const cold = await env.reopen();
        expect(await cold.host.commitPreparedTrashTaskRestore(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(cold.current()).toMatchObject({ title: 'Later saved edit' });
        expect(cold.current().deletedAt).toBeUndefined();
        expect(cold.data().settings.quickAddAutoClean).toBe(true);
        expect(cold.saves()).toBe(0);
    });

    it('does not resurrect a task deleted again after a successful Restore', async () => {
        const env = await open(initial());
        const envelope = env.prepare();
        expect(value(await env.host.commitPreparedTrashTaskRestore(envelope))).toEqual({ id: ID });
        await useTaskStore.getState().deleteTask(ID);
        await flushPendingSave();
        const secondDeletion = copy(env.current());
        const cold = await env.reopen();
        expect(await cold.host.commitPreparedTrashTaskRestore(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(cold.current()).toEqual(secondDeletion);
        expect(cold.saves()).toBe(0);
    });
});
