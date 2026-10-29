import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_SYNC_REVISION } from './sync-revision';
import { createAreaOrderMethods, type NativeAreaOrderRequest } from './native-host-contract-area-order';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Area } from './types';
import { mergeAppData } from './sync';

const now = '2026-09-28T15:00:00.000Z';
const area = (id: string, name: string, order: number, overrides: Partial<Area> = {}): Area => ({
    id, name, order, color: '#3b82f6', rev: 3, revBy: 'old-device',
    createdAt: now, updatedAt: now, ...overrides,
});
const baseAreas = [area('a', 'Zulu', 3), area('t', 'Tombstone', 4, { deletedAt: now }),
    area('b', 'Alpha', 1), area('c', 'Beta', 2, { color: undefined })];

async function open(initial: Partial<AppData> = {}, fail?: () => boolean) {
    await flushPendingSave();
    resetForTests();
    let data: AppData = { tasks: [], projects: [], sections: [], areas: baseAreas, people: [],
        settings: { deviceId: 'area-device' }, ...initial };
    let saves = 0;
    setStorageAdapter({ getData: async () => data, saveData: async (next) => {
        if (fail?.()) throw new Error('disk unavailable');
        data = structuredClone(next); saves++;
    } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    const methods = createAreaOrderMethods({ readiness: () => ({ ok: true, value: null }),
        save: async () => {
            try { await flushPendingSave(); return { ok: true as const, value: null }; }
            catch (error) { return { ok: false as const, error: { code: 'SAVE_FAILED' as const,
                message: error instanceof Error ? error.message : String(error) } }; }
        }, revision: () => 'revision',
        sortedAreas: () => [...useTaskStore.getState()._allAreas].filter((row) => !row.deletedAt)
            .sort((a, b) => a.order !== b.order ? a.order - b.order : a.name.localeCompare(b.name)),
    });
    const request = (intent: NativeAreaOrderRequest['intent'] = { kind: 'sortName' }): NativeAreaOrderRequest => {
        const options = methods.getAreaOrderOptions();
        if (!options.ok) throw new Error(JSON.stringify(options.error));
        return { requestId: '320bd84a-0fd1-497b-823d-3435ae8fd921', intent,
            expectedAreas: options.value.areas };
    };
    return { methods, request, data: () => data, saves: () => saves };
}

afterEach(async () => { vi.useRealTimers(); await flushPendingSave(); resetForTests(); });

describe('prepared native Area order', () => {
    it('plans exactly the existing RN reorder writer for a complete manager permutation', async () => {
        vi.useFakeTimers(); vi.setSystemTime(new Date(now));
        const { methods, request } = await open();
        const input = request({ kind: 'sortName' });
        const plan = methods.prepareAreaOrder(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        await useTaskStore.getState().reorderAreas(plan.value.prepared.result.orderedIds);
        const actual = useTaskStore.getState()._allAreas;
        for (const { after } of plan.value.prepared.effect.areas) {
            expect(actual.find((row) => row.id === after.id)).toEqual(after);
        }
        expect(actual.find((row) => row.id === 't')).toEqual(baseAreas[1]);
    });

    it('matches RN Move Up and sort, revising every live Area while preserving positions and tombstones', async () => {
        const { methods, request, data } = await open();
        const physicalBefore = useTaskStore.getState()._allAreas.map((row) => row.id);
        const input = request({ kind: 'moveUp', areaId: 'c' });
        expect(input.expectedAreas.map((row) => row.id)).toEqual(['b', 'c', 'a']);
        const planned = methods.prepareAreaOrder(input);
        if (!planned.ok || planned.value.kind !== 'prepared') throw new Error(JSON.stringify(planned));
        expect(planned.value.prepared.result.orderedIds).toEqual(['c', 'b', 'a']);
        expect(planned.value.prepared.effect.areas.map(({ after }) => [after.id, after.order, after.rev]))
            .toEqual([['b', 1, 4], ['c', 0, 4], ['a', 2, 4]]);
        expect(await methods.commitPreparedAreaOrder({ request: input, prepared: planned.value.prepared }))
            .toEqual({ ok: true, value: { orderedIds: ['c', 'b', 'a'] } });
        expect(data().areas.map((row) => row.id)).toEqual(physicalBefore);
        expect(data().areas.find((row) => row.id === 't')).toEqual(baseAreas[1]);
        const canonical = mergeAppData(data(), data(), { nowIso: now });
        expect(mergeAppData(canonical, data(), { nowIso: now })).toEqual(canonical);
        const color = methods.prepareAreaOrder(request({ kind: 'sortColor' }));
        expect(color).toMatchObject({ ok: true, value: { kind: 'prepared' } });
    });

    it('keeps direct partial reorder compatibility and writes an already sorted nonempty list', async () => {
        await open();
        await useTaskStore.getState().reorderAreas(['a']);
        expect(useTaskStore.getState()._allAreas.filter((row) => !row.deletedAt)
            .map((row) => [row.id, row.order, row.rev])).toEqual([
                ['b', 1, 4], ['c', 2, 4], ['a', 0, 4],
            ]);
        const { methods, request } = await open({ areas: [area('only', 'Only', 0)] });
        const planned = methods.prepareAreaOrder(request());
        expect(planned).toMatchObject({ ok: true, value: { kind: 'prepared',
            prepared: { effect: { areas: [{ after: { id: 'only', order: 0, rev: 4 } }] } } } });
    });

    it('returns an explicit zero-row no-write and refuses top Move Up', async () => {
        const { methods, request, saves } = await open({ areas: [] });
        expect(methods.prepareAreaOrder(request())).toEqual({ ok: true,
            value: { kind: 'noop', result: { orderedIds: [] } } });
        expect(saves()).toBe(0);
        const other = await open();
        expect(other.methods.prepareAreaOrder(other.request({ kind: 'moveUp', areaId: 'b' })))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(other.saves()).toBe(0);
    });

    it('refuses changed membership, stale tokens, forged envelope and nil-pending probe without writes', async () => {
        const { methods, request, saves } = await open();
        const input = request();
        const plan = methods.prepareAreaOrder(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        const envelope = { request: input, prepared: plan.value.prepared };
        const before = saves();
        useTaskStore.setState({ _allAreas: [...useTaskStore.getState()._allAreas,
            area('new', 'New', 5)] });
        expect(await methods.commitPreparedAreaOrder(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(before);
        useTaskStore.setState({ _allAreas: baseAreas.map((row) => row.id === 'a' ? { ...row, name: 'Edited' } : row) });
        expect(methods.prepareAreaOrder(input)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(await methods.commitPreparedAreaOrder(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        const forged = structuredClone(envelope);
        forged.prepared.effect.areas[0].after.order = 999;
        expect(methods.validatePreparedAreaOrder(forged)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        expect(methods.probeAreaOrderOutcome(input)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(before);
    });

    it('rejects duplicate, incomplete, oversized, and mismatched requests before persistence', async () => {
        const { methods, request, saves } = await open();
        const input = request();
        expect(methods.prepareAreaOrder({ ...input,
            expectedAreas: [...input.expectedAreas, input.expectedAreas[0]] }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(methods.prepareAreaOrder({ ...input, expectedAreas: input.expectedAreas.slice(1) }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(methods.prepareAreaOrder({ ...input,
            expectedAreas: [{ ...input.expectedAreas[0], name: 'x'.repeat(2_000_001) }] }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const planned = methods.prepareAreaOrder(input);
        if (!planned.ok || planned.value.kind !== 'prepared') throw new Error(JSON.stringify(planned));
        expect(methods.validatePreparedAreaOrder({ request: { ...input,
            intent: { kind: 'sortColor' } }, prepared: planned.value.prepared }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(saves()).toBe(0);
    });

    it('retries failed persistence exactly, then accepts a full receipt before mutable membership guards', async () => {
        let failed = true;
        const { methods, request, data, saves } = await open({}, () => failed);
        const input = request();
        const plan = methods.prepareAreaOrder(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        const envelope = { request: input, prepared: plan.value.prepared };
        expect(await methods.commitPreparedAreaOrder(envelope)).toMatchObject({ ok: false,
            error: { code: 'SAVE_FAILED' } });
        expect(data().areas.find((row) => row.id === 'a')?.rev).toBe(3);
        failed = false;
        expect(await methods.commitPreparedAreaOrder(envelope)).toMatchObject({ ok: true });
        expect(data().areas.find((row) => row.id === 'a')?.rev).toBe(4);
        const count = saves();
        useTaskStore.setState({ _allAreas: [...useTaskStore.getState()._allAreas, area('new', 'New', 5)] });
        expect(await methods.commitPreparedAreaOrder(envelope)).toMatchObject({ ok: true });
        expect(saves()).toBe(count);
        const edited = useTaskStore.getState()._allAreas.map((row) => row.id === 'a'
            ? { ...row, rev: (row.rev ?? 0) + 1 } : row);
        useTaskStore.setState({ _allAreas: edited });
        expect(await methods.commitPreparedAreaOrder(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(count);
    });

    it('recognizes a cold canonical after receipt only with the initialized device ID', async () => {
        const first = await open({ settings: {} });
        useTaskStore.setState({ settings: {} });
        const input = first.request();
        const plan = first.methods.prepareAreaOrder(input);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        expect(plan.value.prepared.deviceIdBefore).toBeNull();
        expect(plan.value.prepared.deviceIdToInitialize).toMatch(/^[0-9a-f]{8}-/);
        const envelope = { request: input, prepared: plan.value.prepared };
        expect(await first.methods.commitPreparedAreaOrder(envelope)).toMatchObject({ ok: true });
        const saved = structuredClone(first.data());
        const second = await open(saved);
        await flushPendingSave();
        const before = second.saves();
        expect(await second.methods.commitPreparedAreaOrder(envelope)).toMatchObject({ ok: true });
        expect(second.saves()).toBe(before);
        useTaskStore.setState({ settings: { ...useTaskStore.getState().settings, deviceId: 'different' } });
        expect(await second.methods.commitPreparedAreaOrder(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(second.saves()).toBe(before);
    });

    it('refuses an indistinguishable capped-revision effect before journal and after fabricated membership', async () => {
        vi.useFakeTimers(); vi.setSystemTime(new Date(now));
        const capped = area('only', 'Only', 0, { rev: MAX_SYNC_REVISION, revBy: 'area-device' });
        const { methods, request, saves } = await open({ areas: [capped] });
        const input = request();
        expect(methods.prepareAreaOrder(input)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const ordinary = area('only', 'Only', 0);
        useTaskStore.setState({ _allAreas: [ordinary] });
        const ordinaryInput = request();
        const ordinaryPlan = methods.prepareAreaOrder(ordinaryInput);
        if (!ordinaryPlan.ok || ordinaryPlan.value.kind !== 'prepared') throw new Error(JSON.stringify(ordinaryPlan));
        const forged = structuredClone(ordinaryPlan.value.prepared);
        forged.request.expectedAreas[0] = { ...forged.request.expectedAreas[0],
            rev: MAX_SYNC_REVISION, revBy: 'area-device' };
        forged.scope.areas[0] = capped;
        forged.effect.areas[0] = { before: capped, after: capped };
        expect(methods.validatePreparedAreaOrder({ request: forged.request, prepared: forged }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        useTaskStore.setState({ _allAreas: [capped, area('new', 'New', 1)] });
        expect(methods.prepareAreaOrder(input)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(0);
    });
});

// Android's Manage areas sheet (#1263, RN 56921ca38): one journaled Menu command runs the prepared order above. The request is the
// order the sheet showed and RN's intent, so a replay that already landed writes nothing and a changed order is refused.
describe('runAreaOrder (#1263)', () => {
    const run = (methods: Awaited<ReturnType<typeof open>>['methods'], intent: NativeAreaOrderRequest['intent'], order: string[]) =>
        methods.runAreaOrder({ requestId: '320bd84a-0fd1-497b-823d-3435ae8fd921', intent, order });
    const shown = () => useTaskStore.getState()._allAreas.filter((row) => !row.deletedAt)
        .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)).map((row) => row.id);

    it('stores RN\'s Move up once, and a replay of the same request writes nothing', async () => {
        const { methods, saves, data } = await open();
        expect(shown()).toEqual(['b', 'c', 'a']);
        expect(await run(methods, { kind: 'moveUp', areaId: 'a' }, ['b', 'c', 'a']))
            .toEqual({ ok: true, value: { outcome: 'saved', orderedIds: ['b', 'a', 'c'] } });
        expect(shown()).toEqual(['b', 'a', 'c']);
        expect(data().areas.find((row) => row.id === 't')).toEqual(baseAreas[1]);
        const count = saves();
        expect(await run(methods, { kind: 'moveUp', areaId: 'a' }, ['b', 'c', 'a']))
            .toEqual({ ok: true, value: { outcome: 'unchanged', orderedIds: ['b', 'a', 'c'] } });
        expect(saves()).toBe(count);
    });

    it('sorts by name and by color as RN does, each a target state', async () => {
        const { methods } = await open();
        expect(await run(methods, { kind: 'sortName' }, ['b', 'c', 'a'])).toMatchObject({ ok: true, value: { outcome: 'unchanged' } });
        expect(await run(methods, { kind: 'sortColor' }, ['b', 'c', 'a'])).toMatchObject({ ok: true, value: { outcome: 'saved' } });
        expect(shown()).toEqual(['b', 'a', 'c']);
        expect(await run(methods, { kind: 'sortName' }, ['b', 'a', 'c'])).toMatchObject({ ok: true, value: { outcome: 'saved' } });
        expect(shown()).toEqual(['b', 'c', 'a']);
    });

    it('refuses the top area\'s Move up and an order that changed since it was shown, writing nothing', async () => {
        const { methods, saves } = await open();
        const count = saves();
        expect(await run(methods, { kind: 'moveUp', areaId: 'b' }, ['b', 'c', 'a'])).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(await run(methods, { kind: 'moveUp', areaId: 'c' }, ['c', 'b', 'a'])).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(await run(methods, { kind: 'moveUp', areaId: 'a' }, ['b', 'a'])).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(shown()).toEqual(['b', 'c', 'a']);
        expect(saves()).toBe(count);
        expect(await methods.runAreaOrder({ requestId: 'nope', intent: { kind: 'sortName' }, order: [] } as never))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('owes a failed save, and the retry finishes it without moving twice', async () => {
        let failing = false;
        const { methods, data } = await open({}, () => failing);
        failing = true;
        expect(await run(methods, { kind: 'moveUp', areaId: 'a' }, ['b', 'c', 'a'])).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        failing = false;
        expect(await run(methods, { kind: 'moveUp', areaId: 'a' }, ['b', 'c', 'a'])).toMatchObject({ ok: true, value: { orderedIds: ['b', 'a', 'c'] } });
        expect(data().areas.filter((row) => !row.deletedAt).sort((x, y) => x.order - y.order).map((row) => row.id)).toEqual(['b', 'a', 'c']);
    });
});

// The sheet's own read (Android only; getAreaOrderOptions keeps the exact keys iOS reads): each area with Settings' revision for its
// writes and whether it holds a live project (RN's Delete is off then), and RN's swatches.
describe('getProjectAreaManager (#1263)', () => {
    it('lists the live areas in order with RN\'s in-use rule and Settings\' revisions', async () => {
        const { methods } = await open({ projects: [{ id: 'p', title: 'P', status: 'active', color: '#000000', order: 0, tagIds: [], areaId: 'c',
            createdAt: now, updatedAt: now }, { id: 'gone', title: 'G', status: 'active', color: '#000000', order: 0, tagIds: [], areaId: 'a',
            createdAt: now, updatedAt: now, deletedAt: now }] });
        const read = methods.getProjectAreaManager();
        if (!read.ok) throw new Error(read.error.message);
        const target = (areaId: string) => ({ type: 'area', id: areaId, revision: `3:old-device:${now}` });
        expect(read.value.areas).toEqual([
            { id: 'b', name: 'Alpha', color: '#3b82f6', inUse: false, delete: target('b') },
            { id: 'c', name: 'Beta', color: null, inUse: true, delete: target('c') },
            { id: 'a', name: 'Zulu', color: '#3b82f6', inUse: false, delete: target('a') },
        ]);
        expect(read.value.newArea).toEqual({ type: 'newArea' });
        expect(read.value.colors[0]).toBe('#3b82f6');
        const ios = methods.getAreaOrderOptions();
        if (!ios.ok) throw new Error(ios.error.message);
        expect(Object.keys(ios.value).sort()).toEqual(['areas', 'revision']);
        expect(Object.keys(ios.value.areas[0]).sort()).toEqual(['color', 'id', 'name', 'order', 'rev', 'revBy', 'updatedAt']);
    });
});
