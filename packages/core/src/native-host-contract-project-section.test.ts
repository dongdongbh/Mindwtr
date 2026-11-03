import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectSectionMethods, type NativePreparedProjectSectionCreate,
    type NativeProjectSectionCreateRequest } from './native-host-contract-project-section';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Project, Section, Task } from './types';

const NOW = '2026-09-28T16:00:00.000Z';
const ID = '73799899-d143-40c1-84bd-a09172bba5a4';
const project = (id = 'target', overrides: Partial<Project> = {}): Project => ({
    id, title: 'Project', status: 'active', color: '#3b82f6', order: 0, tagIds: ['#work'],
    rev: 3, revBy: 'old-device', createdAt: NOW, updatedAt: NOW, ...overrides,
});
const section = (id: string, order: number, overrides: Partial<Section> = {}): Section => ({
    id, projectId: 'target', title: 'Repeated title', order, rev: 2, revBy: 'old-device',
    createdAt: NOW, updatedAt: NOW, ...overrides,
});
const task = (): Task => ({ id: 'linked-task', projectId: 'target', title: 'Keep raw task',
    status: 'next', tags: [], contexts: [], rev: 4, revBy: 'old-device',
    createdAt: NOW, updatedAt: NOW });

async function open(initial: Partial<AppData> = {}, failing?: () => boolean) {
    await flushPendingSave(); resetForTests();
    let data: AppData = { tasks: [], projects: [project()], sections: [], areas: [], people: [],
        settings: { deviceId: 'section-device' }, ...initial };
    let saves = 0;
    setStorageAdapter({ getData: async () => data, saveData: async (next) => {
        if (failing?.()) throw new Error('disk unavailable');
        data = structuredClone(next); saves++;
    } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    const methods = createProjectSectionMethods({ readiness: () => ({ ok: true, value: null }),
        save: async () => {
            try { await flushPendingSave(); return { ok: true as const, value: null }; }
            catch (error) { return { ok: false as const, error: { code: 'SAVE_FAILED' as const,
                message: error instanceof Error ? error.message : String(error) } }; }
        }, revision: () => 'stable-revision' });
    const request = (title = '  Repeated title  '): NativeProjectSectionCreateRequest =>
        ({ requestId: ID, projectId: 'target', title });
    const prepare = (input = request()): NativePreparedProjectSectionCreate => {
        const outcome = methods.prepareProjectSectionCreate(input);
        if (!outcome.ok || outcome.value.kind !== 'prepared') throw new Error(JSON.stringify(outcome));
        return outcome.value.prepared;
    };
    return { methods, request, prepare, data: () => data, saves: () => saves };
}

afterEach(async () => { vi.useRealTimers(); await flushPendingSave(); resetForTests(); });

describe('prepared native Project Section creation', () => {
    it('matches RN defaults, order, and duplicate-title behavior while touching only the new row', async () => {
        vi.useFakeTimers(); vi.setSystemTime(new Date(NOW));
        const projects = [project(), project('other', { title: 'Other' })];
        const sections = [section('first', 2), section('last', 7),
            section('deleted', 99, { deletedAt: NOW }),
            section('elsewhere', 50, { projectId: 'other' })];
        const originalTask = task();
        const { request, prepare } = await open({ projects, sections, tasks: [originalTask] });
        const input = request();
        const prepared = prepare(input);
        expect(prepared).toMatchObject({ version: 1, scope: { orderMax: 7 },
            result: { id: ID, projectId: 'target' }, section: {
                id: ID, projectId: 'target', title: 'Repeated title', order: 8,
                isCollapsed: false, rev: 1, revBy: 'section-device', createdAt: NOW, updatedAt: NOW,
            } });
        const rn = await useTaskStore.getState().addSection('target', input.title);
        expect(rn && { ...rn, id: ID }).toEqual(prepared.section);

        const native = await open({ projects, sections, tasks: [originalTask] });
        const planned = native.prepare(input);
        const taskBefore = structuredClone(useTaskStore.getState()._allTasks);
        expect(await native.methods.commitPreparedProjectSectionCreate({ request: input, prepared: planned }))
            .toEqual({ ok: true, value: { id: ID, projectId: 'target' } });
        expect(native.data().sections).toEqual([...sections, planned.section]);
        expect(native.data().projects).toEqual(projects);
        expect(native.data().tasks).toEqual(taskBefore);
        expect(native.saves()).toBe(1);
    });

    it.each(['active', 'waiting', 'someday'] as const)('allows %s parent and preserves raw legacy nulls', async (status) => {
        vi.useFakeTimers(); vi.setSystemTime(new Date(NOW));
        const raw = project('target', { status, startDate: null as never, dueDate: null as never,
            supportNotes: null as never });
        const { methods, request, prepare, data } = await open({ projects: [raw] });

        useTaskStore.setState({ _allProjects: [raw] });
        const input = request(' New ');
        const planned = prepare(input);
        expect(planned.scope.project).toMatchObject({ startDate: null, dueDate: null, supportNotes: null });
        expect(methods.validatePreparedProjectSectionCreate({ request: input, prepared: planned }))
            .toEqual({ ok: true, value: { id: ID, projectId: 'target' } });
        expect(await methods.commitPreparedProjectSectionCreate({ request: input, prepared: planned }))
            .toMatchObject({ ok: true });
        expect(data().projects[0]).toEqual(raw);
    });

    it('reads sorted live and archived historical sections without a write', async () => {
        const archivedAt = '2026-09-20T00:00:00.000Z';
        const { methods, saves } = await open({ projects: [project('target', { status: 'archived' })],
            sections: [section('later', 9, { deletedAt: archivedAt, projectArchivedAt: archivedAt }),
                section('earlier', 1), section('old-deleted', 0, { deletedAt: '2026-01-01T00:00:00.000Z' })] });
        expect(methods.getProjectSectionOptions({ projectId: 'target' })).toEqual({ ok: true,
            value: { revision: 'stable-revision', project: { id: 'target', title: 'Project', status: 'archived' },
                canCreate: false, sections: [{ id: 'earlier', title: 'Repeated title' },
                    { id: 'later', title: 'Repeated title' }] } });
        expect(methods.prepareProjectSectionCreate({ requestId: ID, projectId: 'target', title: 'New' }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(0);
    });

    it('refuses unavailable parents and invalid or unbounded inputs', async () => {
        const { methods, request, saves } = await open();
        const invalid = [request('   '), { ...request(), requestId: ID.toUpperCase() },
            { ...request(), projectId: 'x'.repeat(501) }, { ...request(), title: 'x'.repeat(100_001) },
            { ...request(), unexpected: true }];
        for (const input of invalid) expect(methods.prepareProjectSectionCreate(input))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(methods.getProjectSectionOptions({ projectId: 'x'.repeat(501) }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        for (const unavailable of [undefined, 'deleted', 'purged'] as const) {
            useTaskStore.setState({ _allProjects: unavailable === undefined ? [] :
                [project('target', unavailable === 'deleted' ? { deletedAt: NOW } : { purgedAt: NOW })] });
            expect(methods.getProjectSectionOptions({ projectId: 'target' }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(methods.prepareProjectSectionCreate(request()))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        }
        useTaskStore.setState({ _allProjects: [project()],
            _allSections: [section('oversized', 0, { title: 'x'.repeat(2_100_000) })] });
        expect(methods.getProjectSectionOptions({ projectId: 'target' }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(saves()).toBe(0);
    });

    it('rejects forged envelope, request, parent, and Section row before storage', async () => {
        const { methods, request, prepare, saves } = await open();
        const input = request();
        const prepared = prepare(input);
        const mutations: Array<(value: NativePreparedProjectSectionCreate) => void> = [
            (p) => { p.version = 2 as never; },
            (p) => { p.request.title = 'other'; },
            (p) => { p.result.id = 'other'; },
            (p) => { p.section.id = 'other'; },
            (p) => { p.section.order += 1; },
            (p) => { p.section.rev = 2; },
            (p) => { p.section.createdAt = '2020-01-01T00:00:00.000Z'; },
            (p) => { p.section.description = 'forged'; },
            (p) => { (p.section as Section & { extra?: string }).extra = 'forged'; },
            (p) => { p.scope.orderMax += 1; },
            (p) => { p.scope.project.status = 'archived'; },
            (p) => { p.scope.project.deletedAt = NOW; },
            (p) => { p.preparedAt = 'not a timestamp'; },
            (p) => { p.deviceIdBefore = 'other-device'; },
        ];
        for (const mutate of mutations) {
            const forged = structuredClone(prepared);
            mutate(forged);
            expect(methods.validatePreparedProjectSectionCreate({ request: input, prepared: forged }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(saves()).toBe(0);
    });

    it('requires current parent/order/device witnesses and refuses every ID collision', async () => {
        const { methods, request, prepare, saves } = await open();
        const input = request();
        const planned = prepare(input);
        const baseline = useTaskStore.getState();
        const conflicts: Array<() => void> = [
            () => useTaskStore.setState({ _allProjects: [project('target', { title: 'Renamed' })] }),
            () => useTaskStore.setState({ _allProjects: [project('target', { status: 'archived' })] }),
            () => useTaskStore.setState({ _allProjects: [project('target', { deletedAt: NOW })] }),
            () => useTaskStore.setState({ _allSections: [section('concurrent', 8)] }),
            () => useTaskStore.setState({ settings: { deviceId: 'other-device' } }),
            () => useTaskStore.setState({ _allSections: [section(ID, 0)] }),
            () => useTaskStore.setState({ _allSections: [section(ID, 0, { deletedAt: NOW })] }),
        ];
        for (const conflict of conflicts) {
            useTaskStore.setState({ _allProjects: baseline._allProjects,
                _allSections: baseline._allSections, settings: baseline.settings });
            conflict();
            expect(await methods.commitPreparedProjectSectionCreate({ request: input, prepared: planned }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        }
        expect(saves()).toBe(0);
    });

    it('uses the exact full-row receipt before changed parent/order, with matching initialized device', async () => {
        vi.useFakeTimers(); vi.setSystemTime(new Date(NOW));
        const { methods, request, prepare, data, saves } = await open({ settings: {} });
        useTaskStore.setState({ settings: {} });
        const input = request();
        const planned = prepare(input);
        expect(planned.deviceIdBefore).toBeNull();
        expect(planned.deviceIdToInitialize).toBeTruthy();
        expect(await methods.commitPreparedProjectSectionCreate({ request: input, prepared: planned }))
            .toMatchObject({ ok: true });
        const persisted = structuredClone(data());
        useTaskStore.setState({ _allProjects: [project('target', { title: 'Later', status: 'archived',
            deletedAt: NOW })], _allSections: [...persisted.sections, section('later', 20)] });
        expect(await methods.commitPreparedProjectSectionCreate({ request: input, prepared: planned }))
            .toEqual({ ok: true, value: planned.result });
        expect(saves()).toBe(1);
        useTaskStore.setState({ settings: {} });
        expect(await methods.commitPreparedProjectSectionCreate({ request: input, prepared: planned }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('does not accept partial or tombstoned receipt rows; nil-pending probe is read-only', async () => {
        const { methods, request, prepare, saves } = await open();
        const input = request();
        const planned = prepare(input);
        expect(methods.probeProjectSectionCreateOutcome(input))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        for (const row of [
            { ...planned.section, rev: 2 }, { ...planned.section, deletedAt: NOW },
            { ...planned.section, title: 'Other' },
        ]) {
            useTaskStore.setState({ _allSections: [row] });
            expect(await methods.commitPreparedProjectSectionCreate({ request: input, prepared: planned }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        }
        useTaskStore.setState({ _allSections: [{ ...planned.section, rev: 2 }] });
        expect(methods.probeProjectSectionCreateOutcome(input)).toEqual({ ok: true, value: planned.result });
        useTaskStore.setState({ _allSections: [{ ...planned.section, deletedAt: NOW }] });
        expect(methods.probeProjectSectionCreateOutcome(input))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(0);
    });

    it('retains a failed prepared write for exact same-UUID retry', async () => {
        let fail = true;
        const { methods, request, prepare, data, saves } = await open({}, () => fail);
        const input = request();
        const planned = prepare(input);
        expect(await methods.commitPreparedProjectSectionCreate({ request: input, prepared: planned }))
            .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(data().sections).toEqual([]);
        expect(methods.validatePreparedProjectSectionCreate({ request: input, prepared: planned }))
            .toEqual({ ok: true, value: planned.result });
        fail = false;
        expect(await methods.commitPreparedProjectSectionCreate({ request: input, prepared: planned }))
            .toEqual({ ok: true, value: planned.result });
        expect(data().sections).toEqual([planned.section]);
        expect(saves()).toBe(1);
    });
});
