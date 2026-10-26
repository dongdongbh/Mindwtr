import { afterEach, describe, expect, it } from 'vitest';
import { createNativeHostContract, type NativeHostResult } from './native-host-contract';
import type { NativeTaskToSectionRequest } from './native-host-contract-task-to-section';
import { requestRowId, taskRevisionOf } from './native-request-receipts';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Project, Section, Task } from './types';

const at = '2026-10-01T12:00:00.000Z';
const requestId = '00000000-0000-4000-8000-000000000301';
const task = (id: string, patch: Partial<Task> = {}): Task => ({
    id, title: id, status: 'next', tags: [], contexts: [], createdAt: at, updatedAt: at, rev: 1, revBy: 'other', ...patch,
});
const source = (patch: Partial<Task> = {}) => task('source', { title: ' Pack the kitchen ', description: ' Boxes ', projectId: 'p',
    order: 2, orderNum: 2, tags: ['#home'], checklist: [
        { id: 'c1', title: 'Wrap the glasses', isCompleted: true },
        { id: 'c2', title: '  ', isCompleted: false },
        { id: 'c3', title: ' Empty the fridge ', isCompleted: false },
    ], ...patch });
const project = (id: string, patch: Partial<Project> = {}): Project => ({
    id, title: id, status: 'active', color: '#123456', order: 0, tagIds: [], createdAt: at, updatedAt: at, ...patch,
});
const section = (id: string, order: number): Section => ({ id, projectId: 'p', title: id, order, createdAt: at, updatedAt: at });
const unwrap = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};

async function open(initial: Partial<AppData> = {}, failSave?: () => boolean) {
    await flushPendingSave();
    resetForTests();
    let data: AppData = { tasks: [source(), task('sibling', { projectId: 'p', order: 5, orderNum: 5 })],
        projects: [project('p')], sections: [section('first', 4)], areas: [], people: [], settings: { deviceId: 'device' }, ...initial };
    let saves = 0;
    setStorageAdapter({ getData: async () => structuredClone(data), saveData: async (next) => {
        if (failSave?.()) throw new Error('disk unavailable');
        data = structuredClone(next);
        saves += 1;
    } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [], settings: {},
        error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    const host = createNativeHostContract();
    expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
    return { host, saved: () => data, saves: () => saves };
}
const request = (patch: Partial<NativeTaskToSectionRequest> = {}): NativeTaskToSectionRequest => ({
    requestId, taskId: 'source', taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get('source')!), ...patch,
});

afterEach(async () => { await flushPendingSave(); resetForTests(); });

describe('prepared native Convert to section', () => {
    it('makes RN\'s section, checklist tasks and deleted source under ids from the request, and a replay writes nothing', async () => {
        const { host, saved, saves } = await open();
        const input = request();
        const before = saves();
        const { prepared } = unwrap(host.prepareTaskToSection(input));
        expect(saves()).toBe(before);
        expect(prepared.result).toEqual({ projectId: 'p', sectionId: requestId });
        expect(unwrap(host.validatePreparedTaskToSection({ request: input, prepared }))).toEqual(prepared.result);
        expect(unwrap(await host.commitPreparedTaskToSection({ request: input, prepared }))).toEqual({ projectId: 'p', sectionId: requestId });
        const sections = saved().sections;
        expect(sections.find((row) => row.id === requestId)).toMatchObject({ projectId: 'p', title: 'Pack the kitchen',
            description: 'Boxes', order: 5, revBy: 'device' });
        const made = saved().tasks.filter((row) => row.sectionId === requestId);
        expect(made.map((row) => [row.id, row.title, row.status, row.order])).toEqual([
            [requestRowId(requestId, 'task-to-section:0'), 'Wrap the glasses', 'done', 6],
            [requestRowId(requestId, 'task-to-section:1'), 'Empty the fridge', 'next', 7],
        ]);
        expect(saved().tasks.find((row) => row.id === 'source')?.deletedAt).toBe(prepared.preparedAt);
        // A replay of the landed request (the journal after a restart) answers the same and writes nothing.
        const count = saves();
        expect(unwrap(await host.commitPreparedTaskToSection({ request: input, prepared }))).toEqual(prepared.result);
        const cold = await open({ tasks: saved().tasks, sections: saved().sections });
        const coldCount = cold.saves();
        expect(unwrap(await cold.host.commitPreparedTaskToSection({ request: input, prepared }))).toEqual(prepared.result);
        expect(cold.saves()).toBe(coldCount);
        expect(cold.saved().tasks).toHaveLength(4);
        expect(saves()).toBe(count);
    });

    it('refuses a task changed since the editor opened (STALE_REVISION)', async () => {
        const { host, saves } = await open();
        const input = request({ taskRevision: '0:old:2026-01-01T00:00:00.000Z' });
        expect(host.prepareTaskToSection(input)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        // A change between preparation and commit: nothing is written.
        const fresh = request();
        const { prepared } = unwrap(host.prepareTaskToSection(fresh));
        await useTaskStore.getState().updateTask('source', { title: 'Synced title' });
        await flushPendingSave();
        const count = saves();
        expect(await host.commitPreparedTaskToSection({ request: fresh, prepared })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(useTaskStore.getState()._sectionsById.has(requestId)).toBe(false);
        await flushPendingSave();
        expect(saves()).toBe(count);
    });

    it('never writes against a section or task order the plan did not see', async () => {
        const { host } = await open();
        const input = request();
        const { prepared } = unwrap(host.prepareTaskToSection(input));
        await useTaskStore.getState().addSection('p', 'Synced section');
        expect(await host.commitPreparedTaskToSection({ request: input, prepared })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(useTaskStore.getState()._sectionsById.has(requestId)).toBe(false);
        expect(useTaskStore.getState()._tasksById.get('source')?.deletedAt).toBeUndefined();
    });

    it('refuses a task without a project with RN\'s message', async () => {
        const { host } = await open({ tasks: [task('source')], projects: [], sections: [] });
        expect(host.prepareTaskToSection(request())).toEqual({ ok: false, error: { code: 'INVALID_INPUT', message: 'Task is not in a project' } });
    });

    it('refuses a read-only, projected or forged request', async () => {
        const { host } = await open({ projects: [project('p', { status: 'archived' })] });
        expect(host.prepareTaskToSection(request())).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: 'Task is read-only' } });
        expect(host.prepareTaskToSection({ ...request(), requestId: requestId.toUpperCase() })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const live = await open();
        const input = request();
        const { prepared } = unwrap(live.host.prepareTaskToSection(input));
        const forged = structuredClone(prepared);
        forged.tasks[1].after.title = 'Forged';
        expect(live.host.validatePreparedTaskToSection({ request: input, prepared: forged })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await live.host.commitPreparedTaskToSection({ request: input, prepared: forged })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('answers SAVE_FAILED when the save fails, and the retry lands the same write once', async () => {
        let failing = false;
        const { host, saved } = await open({}, () => failing);
        const input = request();
        const { prepared } = unwrap(host.prepareTaskToSection(input));
        failing = true;
        expect(await host.commitPreparedTaskToSection({ request: input, prepared })).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(saved().sections.some((row) => row.id === requestId)).toBe(false);
        failing = false;
        expect(unwrap(await host.commitPreparedTaskToSection({ request: input, prepared }))).toEqual(prepared.result);
        expect(saved().sections.filter((row) => row.id === requestId)).toHaveLength(1);
        expect(saved().tasks.filter((row) => row.sectionId === requestId)).toHaveLength(2);
    });
});
