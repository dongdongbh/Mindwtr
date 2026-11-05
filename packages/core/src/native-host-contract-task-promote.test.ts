import { afterEach, describe, expect, it } from 'vitest';
import { createNativeHostContract, type NativeHostResult } from './native-host-contract';
import type { NativeTaskPromotionRequest } from './native-host-contract-task-promote';
import { taskRevisionOf } from './native-request-receipts';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Area, Project, Task } from './types';

const at = '2026-10-01T12:00:00.000Z';
const requestId = '00000000-0000-4000-8000-000000000139';
const task = (patch: Partial<Task> = {}): Task => ({
    id: 'source-task', title: 'Saved title', status: 'next', description: ' Saved notes ',
    tags: ['#one', '#one', ' #two '], contexts: ['@desk'],
    createdAt: at, updatedAt: at, rev: 2, revBy: 'prior-device', ...patch,
});
const project = (id: string, patch: Partial<Project> = {}): Project => ({
    id, title: 'Parent', color: '#445566', order: 0, status: 'active', tagIds: [],
    createdAt: at, updatedAt: at, rev: 1, revBy: 'prior-device', ...patch,
});
const area = (id: string, patch: Partial<Area> = {}): Area => ({
    id, name: 'Work', order: 0, createdAt: at, updatedAt: at, ...patch,
});
const unwrap = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
async function open(options: { tasks?: Task[]; projects?: Project[]; areas?: Area[];
    settings?: AppData['settings']; onSave?: (data: AppData) => Promise<void> } = {}) {
    await flushPendingSave();
    resetForTests();
    let data: AppData = { tasks: options.tasks ?? [task()], projects: options.projects ?? [],
        sections: [], areas: options.areas ?? [], people: [],
        settings: options.settings ?? { deviceId: 'promote-device' } };
    let saves = 0;
    setStorageAdapter({ getData: async () => data, saveData: async (next) => {
        await options.onSave?.(next);
        data = JSON.parse(JSON.stringify(next)) as AppData;
        saves++;
    } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false,
        editLockCount: 0, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    const host = createNativeHostContract();
    expect(await host.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' })).toMatchObject({ ok: true });
    expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
    return { host, saved: () => data, saves: () => saves };
}
const request = (title = ' Draft project ', patch: Partial<NativeTaskPromotionRequest> = {}): NativeTaskPromotionRequest => ({
    requestId, taskId: 'source-task', taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get('source-task')!),
    title, ...patch,
});
const prepare = (host: ReturnType<typeof createNativeHostContract>, input: NativeTaskPromotionRequest) =>
    unwrap(host.prepareTaskPromotion(input)).prepared;

afterEach(async () => { await flushPendingSave(); resetForTests(); });

describe('prepared native task promotion', () => {
    it('uses saved notes/tags/Area, draft title, defaults, exact rows, and a cold receipt', async () => {
        const original = task({ projectId: 'parent', sectionId: 'old-section', areaId: undefined });
        const parent = project('parent', { areaId: 'work' });
        const { host, saved, saves } = await open({ tasks: [original], projects: [parent], areas: [area('work')],
            settings: { deviceId: 'promote-device', gtd: { defaultProjectFlowMode: 'sequential' } } });
        const input = request();
        const before = saves();
        const prepared = prepare(host, input);
        expect(saves()).toBe(before);
        expect(prepared.result).toEqual({ id: requestId, reused: false });
        expect(prepared.projects[0].after).toMatchObject({ id: requestId, title: 'Draft project',
            supportNotes: 'Saved notes', tagIds: ['#one', '#two'], areaId: 'work', areaTitle: 'Work',
            isSequential: true, order: 1 });
        expect(prepared.tasks[0].after).toMatchObject({ id: original.id, title: original.title,
            projectId: requestId, description: original.description, contexts: original.contexts,
            rev: (prepared.sourceBefore.rev ?? 0) + 1 });
        expect(prepared.tasks[0].after.sectionId).toBeUndefined();
        expect(prepared.tasks[0].after.areaId).toBeUndefined();
        expect(unwrap(host.validatePreparedTaskPromotion({ request: input, prepared }))).toEqual(prepared.result);
        expect(unwrap(await host.commitPreparedTaskPromotion({ request: input, prepared }))).toEqual(prepared.result);
        expect(saved().tasks).toHaveLength(1);
        expect(saved().projects).toHaveLength(2);
        const cold = await open({ tasks: saved().tasks, projects: saved().projects, areas: [area('work')],
            settings: { deviceId: 'promote-device', gtd: { defaultProjectFlowMode: 'parallel' } } });
        const coldSaves = cold.saves();
        expect(unwrap(await cold.host.commitPreparedTaskPromotion({ request: input, prepared }))).toEqual(prepared.result);
        expect(cold.saves()).toBe(coldSaves);
        expect(cold.saved().projects).toHaveLength(2);
    });

    it('reuses only the same-title same-Area project and replays after its unrelated rename', async () => {
        const work = area('work');
        const target = project('existing', { title: 'draft project', areaId: 'work', order: 5 });
        const other = project('other-project', { title: 'Draft project', areaId: 'other' });
        const { host, saved, saves } = await open({ tasks: [task({ areaId: 'work' })],
            projects: [other, target], areas: [work, area('other', { name: 'Other' })] });
        const input = request();
        const prepared = prepare(host, input);
        expect(prepared.result).toEqual({ id: 'existing', reused: true });
        expect(prepared.projects).toEqual([]);
        expect(prepared.tasks[0].after.order).toBe(0);
        expect(unwrap(await host.commitPreparedTaskPromotion({ request: input, prepared }))).toEqual(prepared.result);
        const renamed = { ...target, title: 'Later rename', rev: 2 };
        const cold = await open({ tasks: saved().tasks, projects: [other, renamed], areas: [work, area('other', { name: 'Other' })],
            settings: { deviceId: 'changed-after-ack' } });
        const before = cold.saves();
        expect(unwrap(await cold.host.commitPreparedTaskPromotion({ request: input, prepared }))).toEqual(prepared.result);
        expect(cold.saves()).toBe(before);
        expect(saves()).toBeGreaterThan(0);
    });

    it('refuses stale source, Area, match decision, destination order, and project defaults without writing', async () => {
        const cases = ['source', 'area', 'match', 'order', 'default'] as const;
        for (const kind of cases) {
            const { host, saves } = await open({ tasks: [task({ areaId: 'work' })], areas: [area('work')],
                settings: { deviceId: 'promote-device', gtd: { defaultProjectFlowMode: 'parallel' } } });
            const input = request();
            const prepared = prepare(host, input);
            const state = useTaskStore.getState();
            if (kind === 'source') {
                const changed = { ...state._allTasks[0], title: 'Changed' };
                useTaskStore.setState({ _allTasks: [changed], _tasksById: new Map([[changed.id, changed]]) });
            } else if (kind === 'area') {
                const changed = { ...state._allAreas[0], name: 'Renamed' };
                useTaskStore.setState({ _allAreas: [changed], _areasById: new Map([[changed.id, changed]]) });
            } else if (kind === 'match') {
                const duplicate = project('other', { title: 'Draft project', areaId: 'work' });
                useTaskStore.setState({ _allProjects: [duplicate], _projectsById: new Map([[duplicate.id, duplicate]]) });
            } else if (kind === 'order') {
                const ordered = project('other', { title: 'Other', areaId: 'work', order: 7 });
                useTaskStore.setState({ _allProjects: [ordered], _projectsById: new Map([[ordered.id, ordered]]) });
            } else {
                useTaskStore.setState({ settings: { ...state.settings, gtd: { defaultProjectFlowMode: 'sequential' } } });
            }
            const before = saves();
            expect(await host.commitPreparedTaskPromotion({ request: input, prepared }), kind)
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(saves(), kind).toBe(before);
        }
    });

    it('rejects forged effects before any write', async () => {
        const { host, saves } = await open();
        const input = request();
        const prepared = prepare(host, input);
        const forged = structuredClone(prepared);
        forged.tasks[0].after.title = 'Forged source edit';
        const before = saves();
        expect(host.validatePreparedTaskPromotion({ request: input, prepared: forged }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.commitPreparedTaskPromotion({ request: input, prepared: forged }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(saves()).toBe(before);
    });

    it('refuses a source project archived between preparation and first commit', async () => {
        const parent = project('parent', { areaId: 'work' });
        const { host, saves } = await open({ tasks: [task({ projectId: parent.id })],
            projects: [parent], areas: [area('work')] });
        const input = request();
        const prepared = prepare(host, input);
        const archived = { ...parent, status: 'archived' as const, archivedAt: at };
        useTaskStore.setState({ _allProjects: [archived], _projectsById: new Map([[archived.id, archived]]) });
        const before = saves();
        expect(await host.commitPreparedTaskPromotion({ request: input, prepared }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(before);
    });

    it.each(['absent', 'deleted'] as const)('refuses an inherited Area restored from %s before commit', async (origin) => {
        const originalArea = area('work', origin === 'deleted' ? { deletedAt: at } : {});
        const { host, saves } = await open({ tasks: [task({ areaId: 'work' })],
            areas: origin === 'deleted' ? [originalArea] : [] });


        const source = { ...useTaskStore.getState()._allTasks[0], areaId: 'work' };
        useTaskStore.setState({ _allTasks: [source], _tasksById: new Map([[source.id, source]]) });
        const input = request();
        const prepared = prepare(host, input);
        expect(prepared.sourceBefore.areaId ?? prepared.sourceProject?.areaId).toBe('work');
        expect(prepared.selectedArea).toBeNull();
        expect(prepared.projects[0].after.areaId).toBeUndefined();
        const restored = { ...originalArea, deletedAt: undefined };
        useTaskStore.setState({ _allAreas: [restored], _areasById: new Map([[restored.id, restored]]) });
        const before = saves();
        expect(await host.commitPreparedTaskPromotion({ request: input, prepared }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(before);
        expect(useTaskStore.getState()._allProjects).toHaveLength(0);
    });

    it('does not accept a later source edit as a lost acknowledgment', async () => {
        const { host, saved } = await open();
        const input = request();
        const prepared = prepare(host, input);
        expect(unwrap(await host.commitPreparedTaskPromotion({ request: input, prepared }))).toEqual(prepared.result);
        const edited = { ...saved().tasks[0], title: 'Edited after promotion', rev: (saved().tasks[0].rev ?? 0) + 1 };
        const cold = await open({ tasks: [edited], projects: saved().projects });
        const before = cold.saves();
        expect(await cold.host.commitPreparedTaskPromotion({ request: input, prepared }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(cold.saves()).toBe(before);
        expect(cold.saved().projects).toHaveLength(1);
    });

    it('retries one failed durable save, then refuses a partial receipt', async () => {
        let failSave = false;
        const { host, saved } = await open({ onSave: async () => { if (failSave) throw new Error('disk unavailable'); } });
        const input = request();
        const prepared = prepare(host, input);
        failSave = true;
        expect(await host.commitPreparedTaskPromotion({ request: input, prepared }))
            .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(saved().projects).toHaveLength(0);
        failSave = false;
        expect(unwrap(await host.commitPreparedTaskPromotion({ request: input, prepared }))).toEqual(prepared.result);
        const altered = { ...saved().projects[0], title: 'Edited after commit', rev: 2 };
        const cold = await open({ tasks: saved().tasks, projects: [altered] });
        expect(await cold.host.commitPreparedTaskPromotion({ request: input, prepared }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(cold.saved().projects).toHaveLength(1);
    });
});
