import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_SYNC_REVISION } from './sync-revision';
import { createAreaColorMethods, type NativeAreaColorRequest } from './native-host-contract-area-color';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Area, Project } from './types';
import { DEFAULT_PROJECT_COLOR } from './color-constants';
import { planAreaColorChange } from './store-projects/area-actions';
import { mergeAppData } from './sync';

const id = '00000000-0000-4000-8000-000000000361';
const now = '2026-09-28T15:00:00.000Z';
const area = (overrides: Partial<Area> = {}): Area => ({
    id: 'area-work', name: 'Work', color: '#3b82f6', order: 0, rev: 3, revBy: 'old-device',
    createdAt: now, updatedAt: now, ...overrides,
});
const project = (projectId: string, overrides: Partial<Project> = {}): Project => ({
    id: projectId, title: projectId, color: '#3b82f6', areaId: 'area-work', areaTitle: 'Work',
    order: 0, status: 'active', tagIds: [], rev: 5, revBy: 'old-device',
    createdAt: now, updatedAt: now, ...overrides,
});

async function open(initial: Partial<AppData> = {}, fail?: () => boolean) {
    await flushPendingSave();
    resetForTests();
    let data: AppData = { tasks: [], projects: [], sections: [], areas: [], people: [],
        settings: { deviceId: 'area-device' }, ...initial };
    let saves = 0;
    setStorageAdapter({ getData: async () => data, saveData: async (next) => {
        if (fail?.()) throw new Error('disk unavailable');
        data = structuredClone(next);
        saves++;
    } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    const methods = createAreaColorMethods({
        readiness: () => ({ ok: true, value: null }),
        save: async () => {
            try { await flushPendingSave(); return { ok: true as const, value: null }; }
            catch (error) { return { ok: false as const, error: { code: 'SAVE_FAILED' as const,
                message: error instanceof Error ? error.message : String(error) } }; }
        },
        revision: () => 'revision',
        sortedAreas: () => useTaskStore.getState()._allAreas.filter((row) => !row.deletedAt),
    });
    const request = (color: string | null = '#ef4444', overrides: Partial<NativeAreaColorRequest> = {}): NativeAreaColorRequest => {
        const current = useTaskStore.getState()._allAreas.find((row) => row.id === 'area-work')!;
        return { requestId: id, areaId: current.id, color,
            expected: { name: current.name, color: current.color ?? null,
                rev: current.rev ?? null, revBy: current.revBy ?? null, updatedAt: current.updatedAt }, ...overrides };
    };
    return { methods, request, data: () => data, saves: () => saves };
}

afterEach(async () => { vi.useRealTimers(); await flushPendingSave(); resetForTests(); });

describe('prepared native Area color', () => {
    it('matches the actual RN updateArea color-only action for stale title repair', async () => {
        const linked = project('linked', { color: '#ef4444', areaTitle: 'Old' });
        const { methods, request } = await open({ areas: [area()], projects: [linked] });
        const options = methods.getAreaColorOptions();
        expect(options).toMatchObject({ ok: true, value: {
            areas: [{ id: 'area-work', name: 'Work', color: '#3b82f6', rev: 3, revBy: 'old-device' }] } });
        if (options.ok) expect(options.value.colors[0]).toBe('#3b82f6');
        const input = request();
        const prepared = methods.prepareAreaColor(input);
        if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
        expect((await useTaskStore.getState().updateArea(input.areaId, { color: input.color! })).success).toBe(true);
        await flushPendingSave();
        const currentArea = useTaskStore.getState()._allAreas.find((row) => row.id === input.areaId)!;
        const currentProject = useTaskStore.getState()._allProjects.find((row) => row.id === linked.id)!;
        expect({ ...currentArea, updatedAt: prepared.value.prepared.updateAt })
            .toEqual(prepared.value.prepared.effect.area.after);
        expect({ ...currentProject, updatedAt: prepared.value.prepared.updateAt })
            .toEqual(prepared.value.prepared.effect.projects[0].after);
    });

    it('repairs stale or missing linked Project areaTitle even when color already matches', async () => {
        const stale = project('stale', { color: '#ef4444', areaTitle: 'Old' });
        const missing = project('missing', { color: '#ef4444', areaTitle: undefined,
            deletedAt: '2026-09-27T15:00:00.000Z' });
        const { methods, request, data } = await open({ areas: [area()], projects: [stale, missing] });
        const input = request();
        const prepared = methods.prepareAreaColor(input);
        if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
        expect(prepared).toMatchObject({ ok: true, value: { prepared: { effect: { projects: [
            { after: { id: 'stale', color: '#ef4444', areaTitle: 'Work', rev: 6 } },
            { after: { id: 'missing', color: '#ef4444', areaTitle: 'Work', rev: 6 } },
        ] } } } });
        if (!prepared.ok) return;
        expect(await methods.commitPreparedAreaColor({ request: input, prepared: prepared.value.prepared }))
            .toMatchObject({ ok: true, value: { id: 'area-work', color: '#ef4444' } });
        expect(data().projects.map((row) => row.areaTitle)).toEqual(['Work', 'Work']);
        expect(data().projects[1].deletedAt).toBe(missing.deletedAt);
    });

    it('matches RN color and None policy, including same-swatch revisions and deleted linked Projects', async () => {
        const linked = project('live', { areaTitle: 'stale' });
        const deleted = project('deleted', { deletedAt: '2026-09-27T15:00:00.000Z', color: '#22c55e' });
        const unrelated = project('other', { areaId: 'other-area' });
        const { methods, request, data } = await open({ areas: [area(), area({ id: 'other-area', name: 'Other' })],
            projects: [linked, deleted, unrelated] });
        const input = request(null);
        const prepared = methods.prepareAreaColor(input);
        if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
        const effect = prepared.value.prepared.effect;
        const rnPlan = planAreaColorChange(area(), [linked, deleted, unrelated], undefined,
            'area-device', prepared.value.prepared.updateAt);
        expect(effect.area.after).toEqual(rnPlan.area);
        expect(effect.projects.map(({ after }) => after)).toEqual(rnPlan.projects.filter((row) => row.areaId === 'area-work'));
        expect(effect.projects.map(({ after }) => [after.id, after.color, after.areaTitle, after.rev]))
            .toEqual([['live', DEFAULT_PROJECT_COLOR, 'Work', 6], ['deleted', DEFAULT_PROJECT_COLOR, 'Work', 6]]);
        expect(await methods.commitPreparedAreaColor({ request: input, prepared: prepared.value.prepared }))
            .toMatchObject({ ok: true, value: { id: 'area-work', color: null } });
        expect(data().areas[0].color).toBeUndefined();
        expect(data().projects.find((row) => row.id === 'other')).toEqual(unrelated);
        expect(data().projects.find((row) => row.id === 'deleted')?.deletedAt).toBe(deleted.deletedAt);
        const canonical = mergeAppData(data(), data(), { nowIso: now });
        expect(mergeAppData(canonical, data(), { nowIso: now })).toEqual(canonical);

        const sameColor = request(null);
        const same = methods.prepareAreaColor(sameColor);
        if (!same.ok) throw new Error(JSON.stringify(same.error));
        expect(same.value.prepared.effect.projects).toEqual([]);
        expect(same.value.prepared.effect.area.after.rev).toBe(5);
        expect(await methods.commitPreparedAreaColor({ request: sameColor, prepared: same.value.prepared })).toMatchObject({ ok: true });
        expect(data().areas[0].rev).toBe(5);
    });

    it('refuses a stale selection, deleted target, changed linked Project, or new link before first apply', async () => {
        const { methods, request, saves } = await open({ areas: [area()], projects: [project('live')] });
        const input = request();
        const planned = methods.prepareAreaColor(input);
        if (!planned.ok) throw new Error(JSON.stringify(planned.error));
        const envelope = { request: input, prepared: planned.value.prepared };
        const before = saves();
        useTaskStore.setState({ _allProjects: [project('live'), project('new')] });
        expect(await methods.commitPreparedAreaColor(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(before);
        useTaskStore.setState({ _allProjects: [project('live', { title: 'later edit' })] });
        expect(await methods.commitPreparedAreaColor(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(before);
        useTaskStore.setState({ _allProjects: [project('live')], _allAreas: [area({ deletedAt: now })] });
        expect(await methods.commitPreparedAreaColor(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(methods.prepareAreaColor(request())).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        useTaskStore.setState({ _allAreas: [area({ color: '#22c55e', rev: 4 })] });
        expect(methods.prepareAreaColor(input)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(before);
    });

    it('retries failed persistence with one exact effect and accepts a full receipt before changed mutable inputs', async () => {
        let failed = true;
        const { methods, request, data, saves } = await open({ areas: [area()],
            projects: [project('live', { areaTitle: 'Old' })] }, () => failed);
        const input = request();
        const plan = methods.prepareAreaColor(input);
        if (!plan.ok) throw new Error(JSON.stringify(plan.error));
        const envelope = { request: input, prepared: plan.value.prepared };
        expect(await methods.commitPreparedAreaColor(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(data().areas[0].rev).toBe(3);
        expect(useTaskStore.getState()._allAreas[0].rev).toBe(4);
        failed = false;
        expect(await methods.commitPreparedAreaColor(envelope)).toMatchObject({ ok: true, value: { id: 'area-work' } });
        expect(data().areas[0].rev).toBe(4);
        expect(data().projects[0].rev).toBe(6);
        const count = saves();
        useTaskStore.setState({ _allAreas: [...useTaskStore.getState()._allAreas,
            area({ id: 'later-area', name: 'Other', order: 99 })],
            settings: { ...useTaskStore.getState().settings, language: 'fr' } });
        expect(await methods.commitPreparedAreaColor(envelope)).toMatchObject({ ok: true });
        expect(saves()).toBe(count);
        expect(useTaskStore.getState()._allAreas[0].rev).toBe(4);
    });

    it.each([1, 2] as const)('recognizes a complete v%s cold recolor receipt with initialized device ID', async (version) => {
        const first = await open({ areas: [area()], projects: [project('linked', { areaTitle: 'Old' })], settings: {} });
        useTaskStore.setState({ settings: {} });
        const input = first.request();
        const plan = first.methods.prepareAreaColor(input);
        if (!plan.ok) throw new Error(JSON.stringify(plan.error));
        expect(plan.value.prepared.deviceIdBefore).toBeNull();
        expect(plan.value.prepared.deviceIdToInitialize).toMatch(/^[0-9a-f]{8}-/);
        expect(plan.value.prepared.version).toBe(2);
        const envelope = { request: input, prepared: { ...plan.value.prepared, version } };
        expect(await first.methods.commitPreparedAreaColor(envelope)).toMatchObject({ ok: true });
        const saved = structuredClone(first.data());
        expect(saved.settings.deviceId).toBe(plan.value.prepared.deviceIdToInitialize);
        const second = await open(saved);
        await flushPendingSave();
        const before = second.saves();
        const normalized = structuredClone(second.data());
        expect(second.methods.validatePreparedAreaColor(envelope)).toMatchObject({ ok: true });
        expect(await second.methods.commitPreparedAreaColor(envelope)).toMatchObject({ ok: true });
        expect(second.saves()).toBe(before);
        expect(second.data()).toEqual(normalized);
    });

    it('refuses a partial after-state instead of overwriting a later linked Project edit', async () => {
        const { methods, request, saves } = await open({ areas: [area()], projects: [project('live')] });
        const input = request();
        const plan = methods.prepareAreaColor(input);
        if (!plan.ok) throw new Error(JSON.stringify(plan.error));
        const envelope = { request: input, prepared: plan.value.prepared };
        expect(await methods.commitPreparedAreaColor(envelope)).toMatchObject({ ok: true });
        const current = useTaskStore.getState()._allProjects[0];
        useTaskStore.setState({ _allProjects: [{ ...current, title: 'Later edit', rev: 7 }] });
        const count = saves();
        expect(await methods.commitPreparedAreaColor(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(useTaskStore.getState()._allProjects[0].title).toBe('Later edit');
        expect(saves()).toBe(count);
    });

    it('refuses journal field omissions hidden by SQLite defaults without changing live rows', async () => {
        const { methods, request, data, saves } = await open({ areas: [area()], projects: [project('live', { isSequential: false })] });
        const input = request();
        const plan = methods.prepareAreaColor(input);
        if (!plan.ok) throw new Error(JSON.stringify(plan.error));
        const before = structuredClone(data());
        const count = saves();
        for (const field of ['tagIds', 'order', 'isSequential'] as const) {
            const forged = structuredClone(plan.value.prepared);
            for (const row of [forged.scope.projects[0], forged.effect.projects[0].before,
                forged.effect.projects[0].after]) delete (row as unknown as Record<string, unknown>)[field];
            if (field !== 'isSequential') expect(methods.validatePreparedAreaColor({ request: input, prepared: forged }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await methods.commitPreparedAreaColor({ request: input, prepared: forged }))
                .toMatchObject({ ok: false, error: { code: field === 'isSequential' ? 'STALE_REVISION' : 'INVALID_INPUT' } });
            expect(useTaskStore.getState()._allProjects).toEqual(before.projects);
            expect(useTaskStore.getState()._allAreas).toEqual(before.areas);
            expect(data()).toEqual(before);
            expect(saves()).toBe(count);
        }
    });

    it('refuses an indistinguishable capped-revision receipt before new links can bypass first-apply guards', async () => {
        const initial = area({ rev: MAX_SYNC_REVISION, revBy: 'area-device' });
        const { methods, request, data, saves } = await open({ areas: [initial] });
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(now));
        const input = request(initial.color!);
        const count = saves();
        expect(methods.prepareAreaColor(input)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(data().areas).toEqual([initial]);
        expect(saves()).toBe(count);
        vi.setSystemTime(new Date(Date.parse(now) + 1));
        const next = methods.prepareAreaColor(input);
        if (!next.ok) throw new Error(JSON.stringify(next.error));
        const forged = structuredClone(next.value.prepared);
        forged.updateAt = now;
        forged.effect.area.after.updatedAt = now;
        expect(methods.validatePreparedAreaColor({ request: input, prepared: forged }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        // A different stamp makes the receipt observable; mutable guards still run before first apply.
        useTaskStore.setState({ _allProjects: [project('newly-linked', { color: '#ef4444' })] });
        expect(await methods.commitPreparedAreaColor({ request: input, prepared: next.value.prepared }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(count);
    });

    it('validates exact request/effect and byte bound, and nil-pending probe never writes', async () => {
        const { methods, request, saves } = await open({ areas: [area()], projects: [project('live')] });
        const input = request();
        const plan = methods.prepareAreaColor(input);
        if (!plan.ok) throw new Error(JSON.stringify(plan.error));
        const before = saves();
        expect(methods.validatePreparedAreaColor({ request: { ...input, color: null }, prepared: plan.value.prepared }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const forged = structuredClone(plan.value.prepared);
        forged.effect.projects[0].after.title = 'forged';
        expect(methods.validatePreparedAreaColor({ request: input, prepared: forged }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(methods.probeAreaColorOutcome(input)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(before);
        useTaskStore.setState({ _allProjects: [project('huge', { title: 'é'.repeat(1_100_000) })] });
        expect(methods.prepareAreaColor(input)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(saves()).toBe(before);
    });
});
