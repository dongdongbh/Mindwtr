import { afterEach, describe, expect, it } from 'vitest';
import { createNativeHostContract } from './native-host-contract';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Project } from './types';

const at = '2026-10-01T12:00:00.000Z';
const project = (id: string, order: number, extra: Partial<Project> = {}): Project => ({
    id, title: id, status: 'active', color: '#123456', order, tagIds: [], createdAt: at, updatedAt: at, ...extra,
});
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function open(adjust: (projects: Project[]) => Project[] = (projects) => projects) {
    await flushPendingSave(); resetForTests();
    let data: AppData = { tasks: [], sections: [], people: [], settings: { deviceId: 'device' },
        areas: [{ id: 'a', name: 'Home', order: 0, color: '#10b981', createdAt: at, updatedAt: at }],
        projects: [project('p1', 0, { areaId: 'a', tagIds: ['#x'] }), project('p2', 1, { areaId: 'a' }),
            project('p3', 2, { areaId: 'a', tagIds: ['#x'] }), project('star', 3, { areaId: 'a', isFocused: true }),
            project('q1', 0), project('q2', 1)] };
    data = { ...data, projects: adjust(data.projects) };
    let saves = 0;
    setStorageAdapter({ getData: async () => data, saveData: async (next) => { data = structuredClone(next); saves += 1; } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [], settings: {},
        error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0 } as never);
    const host = createNativeHostContract();
    expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
    return { host, saves: () => saves, data: () => data };
}

type Host = Awaited<ReturnType<typeof open>>['host'];
const shown = (host: Host, tagFilter: string, areaId: string | null) => {
    const view = host.getFilteredProjects({ tagFilter });
    if (!view.ok) throw new Error(view.error.message);
    return view.value.active.find((entry) => entry.areaId === areaId)!.projects.map((row) => row.id);
};
const move = (n: number, projectId: string, direction: 'up' | 'down', order: string[], tagFilter = '__all__') =>
    ({ requestId: uuid(n), projectId, direction, tagFilter, order });
const write = async (host: Host, request: ReturnType<typeof move>) => {
    const prepared = host.prepareProjectMove(request);
    if (!prepared.ok) return prepared;
    const envelope = { request, prepared: prepared.value.prepared };
    expect(host.validatePreparedProjectMove(envelope)).toEqual({ ok: true, value: prepared.value.prepared.result });
    return host.commitPreparedProjectMove(envelope);
};

afterEach(async () => { await flushPendingSave(); resetForTests(); });

describe('iOS Projects list row moves (#1489)', () => {
    it('adds RN\'s moves to the filtered Projects read only when asked, and keeps its keys otherwise', async () => {
        const { host } = await open();
        const plain = host.getFilteredProjects({ tagFilter: '__all__' }) as { ok: true; value: Record<string, unknown> };
        expect(Object.keys(plain.value).sort()).toEqual(['active', 'archived', 'deferred', 'revision', 'tagFilter', 'tagInventory', 'version']);
        const read = host.getFilteredProjects({ tagFilter: '__all__', moves: true });
        if (!read.ok) throw new Error(read.error.message);
        expect(read.value.moves).toMatchObject({ star: { up: false, down: false }, p1: { up: false, down: true },
            p2: { up: true, down: true }, p3: { up: true, down: false }, q1: { up: false, down: true } });
        const filtered = host.getFilteredProjects({ tagFilter: '#x', moves: true });
        if (!filtered.ok) throw new Error(filtered.error.message);
        expect(filtered.value.moves).toEqual({ p1: { up: false, down: true }, p3: { up: true, down: false } });
        expect(host.getFilteredProjects({ tagFilter: '__all__', moves: false } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('swaps a row with its shown neighbour once, and a replay of the journal writes nothing', async () => {
        const { host, saves } = await open();
        expect(shown(host, '__all__', 'a')).toEqual(['star', 'p1', 'p2', 'p3']);
        const request = move(1, 'p3', 'up', ['star', 'p1', 'p2', 'p3']);
        const prepared = host.prepareProjectMove(request);
        if (!prepared.ok) throw new Error(prepared.error.message);
        const envelope = { request, prepared: prepared.value.prepared };
        expect(await host.commitPreparedProjectMove(envelope)).toEqual({ ok: true, value: { projectId: 'p3', orderedIds: ['p1', 'p3', 'p2', 'star'] } });
        expect(shown(host, '__all__', 'a')).toEqual(['star', 'p1', 'p3', 'p2']);
        expect(shown(host, '__all__', null)).toEqual(['q1', 'q2']);
        await flushPendingSave();
        const count = saves();
        expect(await host.commitPreparedProjectMove(envelope)).toMatchObject({ ok: true });
        await flushPendingSave();
        expect(saves()).toBe(count);
        expect(shown(host, '__all__', 'a')).toEqual(['star', 'p1', 'p3', 'p2']);
    });

    it('moves past a hidden project in a tag-filtered list, as RN does', async () => {
        const { host } = await open();
        expect(shown(host, '#x', 'a')).toEqual(['p1', 'p3']);
        expect(await write(host, move(2, 'p3', 'up', ['p1', 'p3'], '#x'))).toMatchObject({ ok: true });
        expect(shown(host, '#x', 'a')).toEqual(['p3', 'p1']);
        expect(shown(host, '__all__', 'a')).toEqual(['star', 'p3', 'p2', 'p1']);
    });

    it('refuses an edge move, a move past a starred project, and a list that changed since it was shown', async () => {
        const { host, saves } = await open();
        const count = saves();
        const order = ['star', 'p1', 'p2', 'p3'];
        for (const [n, id, direction] of [[3, 'p3', 'down'], [4, 'p1', 'up'], [5, 'star', 'down']] as const) {
            expect(host.prepareProjectMove(move(n, id, direction, order))).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        }
        expect(host.prepareProjectMove(move(6, 'p2', 'up', ['star', 'p2', 'p1', 'p3']))).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(host.prepareProjectMove({ ...move(7, 'p2', 'left' as never, order) })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(shown(host, '__all__', 'a')).toEqual(order);
        expect(saves()).toBe(count);
    });

    it('refuses a prepared move once a sync reorders the area, and never overwrites it', async () => {
        const { host } = await open();
        const request = move(8, 'p3', 'up', ['star', 'p1', 'p2', 'p3']);
        const prepared = host.prepareProjectMove(request);
        if (!prepared.ok) throw new Error(prepared.error.message);
        await useTaskStore.getState().reorderProjects(['p2', 'p1', 'p3', 'star'], 'a');
        expect(await host.commitPreparedProjectMove({ request, prepared: prepared.value.prepared }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(shown(host, '__all__', 'a')).toEqual(['star', 'p2', 'p1', 'p3']);
    });

    it('refuses a journal whose effect was edited', async () => {
        const { host } = await open();
        const request = move(9, 'p2', 'down', ['star', 'p1', 'p2', 'p3']);
        const prepared = host.prepareProjectMove(request);
        if (!prepared.ok) throw new Error(prepared.error.message);
        const tampered = structuredClone(prepared.value.prepared);
        tampered.effect.projects[0].after.order = 99;
        expect(host.validatePreparedProjectMove({ request, prepared: tampered })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(host.probeProjectMoveOutcome(request)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('moves past a synced neighbour with a seconds-only date and an unknown key, and keeps that row as stored', async () => {
        const loose = { createdAt: '2024-01-01T00:00:00Z', legacyField: 'kept' } as unknown as Partial<Project>;
        const { host, saves, data } = await open((projects) => projects.map((row) => row.id === 'p2' ? { ...row, ...loose } : row));
        expect(useTaskStore.getState()._projectsById.get('p2')).toMatchObject(loose);
        const order = ['star', 'p1', 'p2', 'p3'];
        expect(host.prepareProjectMove(move(10, 'p2', 'down', order))).toEqual({ ok: false, error: { code: 'INVALID_INPUT',
            message: 'This Project has stored data the native app cannot write, so it cannot be moved' } });
        const request = move(11, 'p3', 'up', order);
        const prepared = host.prepareProjectMove(request);
        if (!prepared.ok) throw new Error(prepared.error.message);
        const envelope = { request, prepared: prepared.value.prepared };
        expect(await host.commitPreparedProjectMove(envelope)).toMatchObject({ ok: true });
        expect(shown(host, '__all__', 'a')).toEqual(['star', 'p1', 'p3', 'p2']);
        await flushPendingSave();
        expect(data().projects.find((row) => row.id === 'p2')).toMatchObject(loose);
        const count = saves();
        expect(await host.commitPreparedProjectMove(envelope)).toMatchObject({ ok: true });
        await flushPendingSave();
        expect(saves()).toBe(count);
        expect(shown(host, '__all__', 'a')).toEqual(['star', 'p1', 'p3', 'p2']);
    });

    it('refuses a move whose journal would pass the size limit with its own message, and writes nothing', async () => {
        const notes = 'n'.repeat(700_000);
        const { host, saves } = await open((projects) => projects.map((row) => row.areaId === 'a' ? { ...row, supportNotes: notes } : row));
        const count = saves();
        expect(host.prepareProjectMove(move(12, 'p3', 'up', ['star', 'p1', 'p2', 'p3']))).toEqual({ ok: false, error: { code: 'INVALID_INPUT',
            message: 'This Area holds too much Project data to save a move safely' } });
        expect(shown(host, '__all__', 'a')).toEqual(['star', 'p1', 'p2', 'p3']);
        expect(saves()).toBe(count);
    });
});
