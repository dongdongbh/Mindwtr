import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectAreaMethods, type NativeProjectAreaRequest } from './native-host-contract-project-area';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Area, Project, Section, Task } from './types';

const now = '2026-09-28T15:00:00.000Z';
const project = (id = 'target', extra: Partial<Project> = {}): Project => ({
    id, title: id, status: 'active', color: '#3b82f6', order: 1, tagIds: ['#work'],
    rev: 3, revBy: 'old-device', createdAt: now, updatedAt: now, ...extra,
});
const area = (id: string, name: string, extra: Partial<Area> = {}): Area => ({
    id, name, color: '#10b981', order: 0, createdAt: now, updatedAt: now, ...extra,
});
const task = (): Task => ({ id: 'linked-task', title: 'Keep task text', status: 'next', projectId: 'target',
    tags: ['#work'], contexts: ['@home'], rev: 5, revBy: 'old-device', createdAt: now, updatedAt: now });
const section = (): Section => ({ id: 'linked-section', projectId: 'target', title: 'Keep section text',
    order: 0, rev: 2, revBy: 'old-device', createdAt: now, updatedAt: now });
const sortKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(sortKeys)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, sortKeys(nested)])) : value;

async function open(initial: Partial<AppData> = {}, shouldFail?: () => boolean) {
    await flushPendingSave(); resetForTests();
    let data: AppData = { tasks: [], projects: [project()], sections: [], areas: [area('a', 'Area A')],
        people: [], settings: { deviceId: 'area-device' }, ...initial };
    let saves = 0;
    setStorageAdapter({ getData: async () => data, saveData: async (next) => {
        if (shouldFail?.()) throw new Error('disk unavailable');
        data = structuredClone(next); saves++;
    } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    const methods = createProjectAreaMethods({ readiness: () => ({ ok: true, value: null }),
        save: async () => {
            try { await flushPendingSave(); return { ok: true as const, value: null }; }
            catch (error) { return { ok: false as const, error: { code: 'SAVE_FAILED' as const,
                message: error instanceof Error ? error.message : String(error) } }; }
        }, revision: () => 'stable-revision',
        sortedAreas: () => useTaskStore.getState().areas,
        t: () => ((key: string) => key === 'projects.noArea' ? 'No Area' : key) });
    const request = (areaId: string | null): NativeProjectAreaRequest => {
        const options = methods.getProjectAreaOptions({ projectId: 'target' });
        if (!options.ok) throw new Error(JSON.stringify(options.error));
        const { id: _id, ...expected } = options.value.project;
        const selected = areaId === null ? null : useTaskStore.getState()._areasById.get(areaId);
        return { requestId: '73799899-d143-40c1-84bd-a09172bba5a4', projectId: 'target',
            areaId, expected, selectedArea: selected ? { id: selected.id, name: selected.name } : null };
    };
    return { methods, request, data: () => data, saves: () => saves };
}

afterEach(async () => { vi.useRealTimers(); await flushPendingSave(); resetForTests(); });

describe('prepared native Project Area assignment', () => {
    it('offers exact bounded options, chooses destination tail and keeps unrelated raw data', async () => {
        vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-28T16:00:00.000Z'));
        const original = project('target', { areaId: 'a', areaTitle: 'Area A', supportNotes: '  keep raw  ',
            reviewAt: '2026-09-28T12:34:56.000Z' });
        const sibling = project('sibling', { areaId: 'b', areaTitle: 'Area B', order: 9 });
        const { methods, request } = await open({ projects: [original, sibling],
            areas: [area('a', 'Area A'), area('b', ' Area B ')] });
        const options = methods.getProjectAreaOptions({ projectId: 'target' });
        expect(options).toMatchObject({ ok: true, value: { revision: 'stable-revision', canEdit: true,
            noAreaLabel: 'No Area', areas: [{ id: 'a', label: 'Area A' }, { id: 'b', label: ' Area B ' }] } });
        if (!options.ok) throw new Error('options failed');
        expect(Object.keys(options.value).sort()).toEqual(['areas', 'canEdit', 'colorOverride', 'colors', 'noAreaLabel', 'project', 'revision']);
        expect(Object.keys(options.value.project).sort()).toEqual([
            'areaId', 'areaTitle', 'id', 'order', 'rev', 'revBy', 'status', 'title', 'updatedAt']);
        const input = request('b');
        const prepared = methods.prepareProjectArea(input);
        if (!prepared.ok || prepared.value.kind !== 'prepared') throw new Error('prepare failed');
        expect(prepared.value.prepared.scope.orderMax).toBe(9);
        expect(prepared.value.prepared.effect.project.after).toMatchObject({ areaId: 'b', areaTitle: 'Area B',
            order: 10, supportNotes: original.supportNotes, reviewAt: original.reviewAt, rev: 4 });
        expect(methods.validatePreparedProjectArea(sortKeys({ request: input, prepared: prepared.value.prepared })))
            .toEqual({ ok: true, value: { id: 'target', areaId: 'b', areaTitle: 'Area B', order: 10 } });
    });

    it('distinguishes No Area from omission, same selection no-op, and stale title repair', async () => {
        const { methods, request, saves } = await open({ projects: [project('target', { areaId: 'a', areaTitle: 'Area A' })] });
        expect(methods.prepareProjectArea(request('a'))).toMatchObject({ ok: true,
            value: { kind: 'noop' } });
        expect(methods.prepareProjectArea(request(null))).toMatchObject({ ok: true,
            value: { kind: 'prepared', prepared: { result: { areaId: null, areaTitle: null } } } });
        expect(saves()).toBe(0);
        useTaskStore.setState({ _allProjects: [project('target', { areaId: 'a', areaTitle: 'Old Name' })] });
        expect(methods.prepareProjectArea(request('a'))).toMatchObject({ ok: true,
            value: { kind: 'prepared', prepared: { result: { areaId: 'a', areaTitle: 'Area A', order: 1 } } } });
    });

    it('treats a hydrated nullable No Area row as an exact no-op without normalizing raw dates', async () => {
        const { methods, request, saves } = await open();
        useTaskStore.setState({ _allProjects: [project('target', { areaId: null as never,
            areaTitle: null as never, reviewAt: null as never, dueDate: null as never })] });
        const input = request(null);
        expect(input.expected).toMatchObject({ areaId: null, areaTitle: null });
        expect(methods.prepareProjectArea(input)).toEqual({ ok: true,
            value: { kind: 'noop', result: { id: 'target', areaId: null, areaTitle: null, order: 1 } } });
        expect(useTaskStore.getState()._projectsById.get('target')).toMatchObject({
            areaId: null, areaTitle: null, reviewAt: null, dueDate: null });
        expect(saves()).toBe(0);
    });

    it('matches RN updateProject move/No Area and preserves Tasks, Sections, tombstones and settings', async () => {
        vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-28T16:00:00.000Z'));
        const original = project('target', { areaId: 'a', areaTitle: 'Area A',
            supportNotes: '  untouched  ', tagIds: ['#keep'], dueDate: '2026-10-01' });
        const tombstone = project('deleted', { areaId: 'b', areaTitle: 'Area B', order: 11, deletedAt: now });
        const initial = { projects: [original, project('other', { areaId: 'b', order: 9 }), tombstone],
            areas: [area('a', 'Area A'), area('b', ' Area B ')], tasks: [task()], sections: [section()],
            settings: { deviceId: 'area-device', language: 'en', taxonomy: { tags: [
                { token: '#keep', rev: 1, revBy: 'area-device', updatedAt: now },
            ] } } };
        const { methods, request } = await open(initial);
        const input = request('b');
        const plan = methods.prepareProjectArea(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        expect(plan.value.prepared.scope.orderMax).toBe(11);
        const frozenUnrelated = { tasks: structuredClone(useTaskStore.getState()._allTasks),
            sections: structuredClone(useTaskStore.getState()._allSections),
            areas: structuredClone(useTaskStore.getState()._allAreas),
            settings: structuredClone(useTaskStore.getState().settings) };
        expect((await useTaskStore.getState().updateProject('target', { areaId: 'b' })).success).toBe(true);
        expect(useTaskStore.getState()._projectsById.get('target')).toEqual(plan.value.prepared.effect.project.after);
        expect(useTaskStore.getState()._allProjects.slice(1)).toEqual(initial.projects.slice(1));
        expect(useTaskStore.getState()._allTasks).toEqual(frozenUnrelated.tasks);
        expect(useTaskStore.getState()._allSections).toEqual(frozenUnrelated.sections);
        expect(useTaskStore.getState()._allAreas).toEqual(frozenUnrelated.areas);
        expect(useTaskStore.getState().settings).toEqual(frozenUnrelated.settings);

        const clear = request(null);
        const clearPlan = methods.prepareProjectArea(clear);
        if (!clearPlan.ok || clearPlan.value.kind !== 'prepared') throw new Error('clear prepare failed');
        expect((await useTaskStore.getState().updateProject('target', { areaId: undefined })).success).toBe(true);
        expect(useTaskStore.getState()._projectsById.get('target')).toEqual(clearPlan.value.prepared.effect.project.after);
        expect(clearPlan.value.prepared.result).toMatchObject({ areaId: null, areaTitle: null });
    });

    it('refuses stale/renamed/deleted Areas, changed destination max and archived Projects without writes', async () => {
        const { methods, request, saves } = await open({ projects: [project('target', { areaId: 'a', areaTitle: 'Area A' })],
            areas: [area('a', 'Area A'), area('b', 'Area B')] });
        const picked = request('b');
        useTaskStore.setState({ _allAreas: [area('a', 'Area A'), area('b', 'Renamed')] });
        expect(methods.prepareProjectArea(picked)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        useTaskStore.setState({ _allAreas: [area('a', 'Area A'), area('b', 'Area B', { deletedAt: now })] });
        expect(methods.prepareProjectArea(picked)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(methods.getProjectAreaOptions({ projectId: 'target' })).toMatchObject({ ok: true,
            value: { areas: [{ id: 'a' }] } });
        useTaskStore.setState({ _allAreas: [area('a', 'Area A'), area('b', 'Area B')] });
        const plan = methods.prepareProjectArea(picked);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        useTaskStore.setState((state) => ({ _allProjects: [...state._allProjects,
            project('race', { areaId: 'b', order: 9 })] }));
        expect(await methods.commitPreparedProjectArea({ request: picked, prepared: plan.value.prepared }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        useTaskStore.setState({ _allProjects: [project('target', { status: 'archived' })] });
        expect(methods.getProjectAreaOptions({ projectId: 'target' })).toMatchObject({ ok: true,
            value: { canEdit: false } });
        expect(methods.prepareProjectArea(request(null))).toMatchObject({ ok: true,
            value: { kind: 'blocked', result: { blocked: '' } } });
        expect(saves()).toBe(0);
    });

    it('refuses a changed v2 Area color witness and rejects noncanonical Project timestamps', async () => {
        const { methods, request } = await open({ projects: [project('target', { areaId: 'a' })],
            areas: [area('a', 'Area A'), area('b', 'Area B')] });
        const input = request('b');
        expect(methods.prepareProjectArea({ ...input, expected: { ...input.expected,
            updatedAt: '2026-09-28T15:00:00Z' } })).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        const plan = methods.prepareProjectArea(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        useTaskStore.setState({ _allAreas: [area('a', 'Area A'), area('b', 'Area B', {
            color: '#ef4444', rev: 99, updatedAt: '2026-09-28T16:00:00.000Z' })] });
        expect(await methods.commitPreparedProjectArea({ request: input, prepared: plan.value.prepared }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        useTaskStore.setState({ _allProjects: [project('target', { updatedAt: '2026-09-28T15:00:00Z' })] });
        expect(methods.getProjectAreaOptions({ projectId: 'target' })).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
    });

    it('uses a complete after-row receipt before mutable Area/order guards; partial after-row is not a receipt', async () => {
        const original = project('target', { areaId: 'a', areaTitle: 'Area A' });
        const { methods, request, saves } = await open({ projects: [original],
            areas: [area('a', 'Area A'), area('b', 'Area B')] });
        const input = request('b');
        const plan = methods.prepareProjectArea(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        const frozen = { request: input, prepared: plan.value.prepared };
        useTaskStore.setState({ _allProjects: [{ ...original, areaId: 'b', areaTitle: 'Area B',
            order: plan.value.prepared.result.order }] });
        expect(await methods.commitPreparedProjectArea(frozen)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        useTaskStore.setState({ _allProjects: [original] });
        expect(await methods.commitPreparedProjectArea(frozen)).toEqual({ ok: true,
            value: plan.value.prepared.result });
        const count = saves();
        useTaskStore.setState((state) => ({ _allAreas: [area('a', 'Area A'), area('b', 'Renamed', { deletedAt: now })],
            _allProjects: [...state._allProjects, project('later', { areaId: 'b', order: 20 })],
            settings: { ...state.settings, deviceId: 'new-device' } }));
        expect(await methods.commitPreparedProjectArea(frozen)).toEqual({ ok: true,
            value: plan.value.prepared.result });
        expect(saves()).toBe(count);
    });

    it('retries failed persistence exactly and accepts the frozen journal after cold reload', async () => {
        let failed = true;
        const first = await open({ projects: [project()], areas: [area('a', ' Area A ')] , settings: {} },
            () => failed);
        useTaskStore.setState({ settings: {} });
        const input = first.request('a');
        const plan = first.methods.prepareProjectArea(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        const frozen = { request: input, prepared: plan.value.prepared };
        expect(plan.value.prepared.deviceIdBefore).toBeNull();
        expect(await first.methods.commitPreparedProjectArea(frozen)).toMatchObject({ ok: false,
            error: { code: 'SAVE_FAILED' } });
        expect(first.data().projects[0].areaId).toBeUndefined();
        failed = false;
        expect(await first.methods.commitPreparedProjectArea(frozen)).toEqual({ ok: true,
            value: plan.value.prepared.result });
        expect(first.data().projects[0]).toMatchObject({ areaId: 'a', areaTitle: 'Area A' });
        const second = await open(structuredClone(first.data()));
        await flushPendingSave();
        const count = second.saves();
        expect(await second.methods.commitPreparedProjectArea(frozen)).toEqual({ ok: true,
            value: plan.value.prepared.result });
        expect(second.saves()).toBe(count);
    });

    it('replays a retained v1 Area journal with its original compatibility-color policy', async () => {
        const first = await open();
        const input = first.request('a');
        const plan = first.methods.prepareProjectArea(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        const prepared = structuredClone(plan.value.prepared);
        prepared.version = 1;
        delete prepared.scope.selectedArea!.color;
        prepared.effect.project.after.color = prepared.scope.project.color;
        const frozen = JSON.parse(JSON.stringify({ request: input, prepared }));
        expect(first.methods.validatePreparedProjectArea(frozen)).toMatchObject({ ok: true });
        const cold = await open(structuredClone(first.data()));
        expect(await cold.methods.commitPreparedProjectArea(frozen)).toMatchObject({ ok: true });
        expect(cold.data().projects[0].color).toBe('#3b82f6');
        const after = await open(structuredClone(cold.data()));
        expect(await after.methods.commitPreparedProjectArea(frozen)).toMatchObject({ ok: true });
        expect(after.saves()).toBe(0);
    });

    it('journals an explicit equal-hue choice, retries a failed save, and cold-replays without another write', async () => {
        let failed = true;
        const initial = { projects: [project('target', { areaId: 'a', areaTitle: 'Area A', color: '#10b981' })] };
        const first = await open(initial, () => failed);
        const input = { ...first.request('a'), colorOverride: '#10b981' };
        const plan = first.methods.prepareProjectArea(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        const frozen = JSON.parse(JSON.stringify({ request: input, prepared: plan.value.prepared }));
        expect(await first.methods.commitPreparedProjectArea(frozen)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(first.data().projects[0].colorOverride).toBeUndefined();
        failed = false;
        expect(await first.methods.commitPreparedProjectArea(frozen)).toMatchObject({ ok: true, value: { colorOverride: '#10b981' } });
        const cold = await open(structuredClone(first.data()));
        expect(await cold.methods.commitPreparedProjectArea(frozen)).toMatchObject({ ok: true });
        expect(cold.saves()).toBe(0);
        const reset = { ...cold.request('a'), colorOverride: null };
        const resetPlan = cold.methods.prepareProjectArea(reset);
        if (!resetPlan.ok || resetPlan.value.kind !== 'prepared') throw new Error('reset prepare failed');
        expect(await cold.methods.commitPreparedProjectArea({ request: reset, prepared: resetPlan.value.prepared }))
            .toMatchObject({ ok: true, value: { colorOverride: null } });
        expect(cold.data().projects[0].colorOverride).toBeNull();
    });

    it('rejects forged requests, witnesses, results and effects before any write', async () => {
        const { methods, request, saves } = await open();
        const input = request('a');
        const plan = methods.prepareProjectArea(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('prepare failed');
        const frozen = JSON.parse(JSON.stringify(sortKeys({ request: input, prepared: plan.value.prepared }))) as
            { request: typeof input; prepared: typeof plan.value.prepared };
        expect(methods.validatePreparedProjectArea(frozen)).toEqual({ ok: true, value: plan.value.prepared.result });
        const mutate = (change: (value: typeof frozen) => void) => {
            const forged = structuredClone(frozen);
            change(forged);
            return forged;
        };
        const forged = [
            mutate((value) => { value.request.selectedArea!.name = 'Wrong'; }),
            mutate((value) => { value.prepared.scope.orderMax = 99; }),
            mutate((value) => { value.prepared.scope.selectedArea!.name = 'Wrong'; }),
            mutate((value) => { value.prepared.result.areaTitle = 'Wrong'; }),
            mutate((value) => { value.prepared.effect.project.after.order = 99; }),
            mutate((value) => { (value.prepared as unknown as Record<string, unknown>).extra = true; }),
        ];
        for (const value of forged) {
            expect(methods.validatePreparedProjectArea(value)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
            expect(await methods.commitPreparedProjectArea(value)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
        }
        expect(methods.prepareProjectArea({ ...input, selectedArea: { id: 'a', name: 'Wrong' } }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(methods.probeProjectAreaOutcome(input)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(0);
    });
});
