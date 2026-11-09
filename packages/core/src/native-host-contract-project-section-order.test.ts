import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectSectionOrderMethods } from './native-host-contract-project-section-order';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Project, Section, Task } from './types';

const NOW = '2026-09-28T16:00:00.000Z';
const REQUEST_ID = '3fb34adb-9bf8-451f-8f7f-7964b6a0de9b';
const project = (changes: Partial<Project> = {}): Project => ({
    id: 'parent', title: 'Project', status: 'active', color: '#3b82f6', order: 0, tagIds: [],
    rev: 3, revBy: 'old-device', createdAt: NOW, updatedAt: NOW, ...changes,
});
const section = (id: string, order: number, changes: Partial<Section> = {}): Section => ({
    id, projectId: 'parent', title: id, order, description: 'Keep', isCollapsed: true,
    rev: 4, revBy: 'old-device', createdAt: NOW, updatedAt: NOW, ...changes,
});
const task: Task = { id: 'task', projectId: 'parent', sectionId: 'b', title: 'Keep task',
    status: 'next', tags: [], contexts: [], createdAt: NOW, updatedAt: NOW };

async function open(sections = [section('a', 0), section('b', 1024), section('c', 2048),
    section('deleted', 9, { deletedAt: NOW }), section('foreign', 0, { projectId: 'other' })],
    deviceId: string | null = 'device') {
    await flushPendingSave(); resetForTests();
    let data: AppData = { tasks: [task], projects: [project(), { ...project(), id: 'other' }], sections,
        areas: [], people: [], settings: deviceId ? { deviceId } : {} };
    let saves = 0;
    let failSave = false;
    setStorageAdapter({ getData: async () => data, saveData: async (next) => {
        if (failSave) throw new Error('disk unavailable');
        data = structuredClone(next); saves++;
    } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    if (deviceId === null) useTaskStore.setState({ settings: {} });
    const baseline = { tasks: structuredClone(useTaskStore.getState()._allTasks),
        projects: structuredClone(useTaskStore.getState()._allProjects) };
    const methods = createProjectSectionOrderMethods({ readiness: () => ({ ok: true, value: null }),
        save: async () => {
            try { await flushPendingSave(); return { ok: true as const, value: null }; }
            catch (error) { return { ok: false as const, error: { code: 'SAVE_FAILED' as const,
                message: error instanceof Error ? error.message : String(error) } }; }
        }, revision: () => 'revision' });
    const options = () => methods.getProjectSectionOrderOptions({ projectId: 'parent' });
    const request = (sectionId = 'b', direction: 'up' | 'down' = 'up') => {
        const read = options();
        if (!read.ok) throw new Error(JSON.stringify(read));
        return { requestId: REQUEST_ID, projectId: 'parent', sectionId, direction,
            expectedSections: read.value.token } as const;
    };
    const prepare = (input = request()) => {
        const result = methods.prepareProjectSectionOrder(input);
        if (!result.ok) throw new Error(JSON.stringify(result));
        return result.value.prepared;
    };
    return { methods, request, prepare, options, baseline, data: () => data, saves: () => saves,
        fail: (value: boolean) => { failSave = value; } };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-01T12:00:00.000Z')); });
afterEach(async () => { vi.useRealTimers(); try { await flushPendingSave(); } catch {                                     }
    resetForTests(); });

describe('prepared native Project Section order', () => {
    it('uses the RN sparse plan and preserves unrelated raw data', async () => {
        const { methods, request, prepare, data, options, saves, baseline } = await open();
        const read = options();
        expect(read.ok && read.value.sections).toMatchObject([
            { id: 'a', canMoveUp: false, canMoveDown: true },
            { id: 'b', canMoveUp: true, canMoveDown: true },
            { id: 'c', canMoveUp: true, canMoveDown: false },
        ]);
        const input = request();
        const prepared = prepare(input);
        expect(prepared.result).toEqual({ projectId: 'parent', orderedIds: ['b', 'a', 'c'] });
        expect(prepared.effect.sections).toHaveLength(1);
        expect(prepared.effect.sections[0].after.rev).toBe(prepared.effect.sections[0].before.rev! + 1);
        expect(await methods.commitPreparedProjectSectionOrder({ request: input, prepared }))
            .toEqual({ ok: true, value: prepared.result });
        expect(data().sections.find((row) => row.id === 'deleted')).toEqual(section('deleted', 9, { deletedAt: NOW }));
        expect(data().sections.find((row) => row.id === 'foreign')).toEqual(section('foreign', 0, { projectId: 'other' }));
        expect(data().tasks).toEqual(baseline.tasks);
        expect(data().projects).toEqual(baseline.projects);
        const count = saves();
        expect(await methods.commitPreparedProjectSectionOrder({ request: input, prepared }))
            .toEqual({ ok: true, value: prepared.result });
        expect(saves()).toBe(count);
    });

    it('freezes trusted hydrated rows with explicit undefined optional members', async () => {
        const { methods, request, prepare } = await open();
        const parent = { ...project(), startDate: undefined };
        useTaskStore.setState((state) => {
            const sections = state._allSections.map((row) => row.id === 'b'
                ? { ...row, deletedAt: undefined, projectArchivedAt: undefined } : row);
            return { _allProjects: [parent, state._allProjects[1]],
                _projectsById: new Map([['parent', parent], ['other', state._allProjects[1]]]),
                _allSections: sections, sections: sections.filter((row) => !row.deletedAt) };
        });
        const input = request();
        const prepared = prepare(input);
        expect(prepared.scope.project).not.toHaveProperty('startDate');
        expect(prepared.scope.sections.find((row) => row.id === 'b')).not.toHaveProperty('deletedAt');
        expect(await methods.commitPreparedProjectSectionOrder({ request: input, prepared }))
            .toEqual({ ok: true, value: prepared.result });
    });

    it('rejects edge moves and stale complete scope', async () => {
        const { methods, request, prepare } = await open();
        expect(methods.prepareProjectSectionOrder(request('a', 'up')))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(methods.prepareProjectSectionOrder(request('c', 'down')))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        const input = request();
        const prepared = prepare(input);
        useTaskStore.setState((state) => ({ _allSections: [...state._allSections, section('new', 3072)] }));
        expect(await methods.commitPreparedProjectSectionOrder({ request: input, prepared }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        const changed = project({ startDate: null as never });
        useTaskStore.setState((state) => ({ _allProjects: [changed, state._allProjects[1]],
            _projectsById: new Map([['parent', changed], ['other', state._allProjects[1]]]),
            _allSections: state._allSections.filter((row) => row.id !== 'new') }));
        expect(await methods.commitPreparedProjectSectionOrder({ request: input, prepared }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('refuses partial rebalance receipts and raw Section changes', async () => {
        const { methods, request, prepare, saves } = await open([
            section('a', 0), section('b', 1), section('c', 2), section('d', 3),
        ]);
        const input = request('b', 'down');
        const prepared = prepare(input);
        expect(prepared.effect.sections.length).toBeGreaterThan(1);
        const original = useTaskStore.getState()._allSections;
        const first = prepared.effect.sections[0];
        useTaskStore.setState({ _allSections: original.map((row) => row.id === first.after.id
            ? first.after : row) });
        expect(await methods.commitPreparedProjectSectionOrder({ request: input, prepared }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        useTaskStore.setState({ _allSections: original.map((row) => row.id === 'd'
            ? { ...row, description: null as never } : row) });
        expect(await methods.commitPreparedProjectSectionOrder({ request: input, prepared }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(saves()).toBe(0);
    });

    it('matches the RN writer for a large middle swap and an equal-order rebalance', async () => {
        for (const rows of [
            Array.from({ length: 120 }, (_, index) => section(`s${index}`, index * 1024)),
            [section('a', 0, { title: 'Same' }), section('b', 0, { title: 'Same' }),
                section('c', 0, { title: 'Same' })],
        ]) {
            const { request, prepare, options } = await open(rows);
            const shown = options();
            expect(shown.ok && shown.value.token).toHaveLength(rows.length);
            const input = request(rows.length > 100 ? 's60' : 'b');
            const prepared = prepare(input);
            expect(prepared.effect.sections.length).toBeGreaterThan(0);
            await useTaskStore.getState().reorderSections('parent', prepared.result.orderedIds);
            const stored = useTaskStore.getState()._allSections;
            for (const pair of prepared.effect.sections) {
                expect(stored.find((row) => row.id === pair.after.id)).toMatchObject({
                    order: pair.after.order, rev: pair.after.rev, revBy: pair.after.revBy,
                });
            }
            expect(getOrder(stored)).toEqual(prepared.result.orderedIds);
        }
    });

    it('rejects malformed or forged journals before touching data', async () => {
        const { methods, request, prepare, saves } = await open();
        const input = request();
        const prepared = prepare(input);
        const swiftRoundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_key, part) =>
            part && typeof part === 'object' && !Array.isArray(part)
                ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b)))
                : part)) as T;
        const cold = swiftRoundTrip({ request: input, prepared });
        expect(methods.validatePreparedProjectSectionOrder(cold))
            .toEqual({ ok: true, value: prepared.result });
        const forgeries = [
            { ...cold, request: { ...input, requestId: input.requestId.toUpperCase() } },
            { ...cold, prepared: { ...cold.prepared, result: { projectId: 'other', orderedIds: ['b', 'a', 'c'] } } },
            { ...cold, prepared: { ...cold.prepared, effect: { sections: [] } } },
            { ...cold, prepared: { ...cold.prepared, effect: { sections: [
                ...prepared.effect.sections, prepared.effect.sections[0]] } } },
            { ...cold, prepared: { ...cold.prepared, scope: { ...cold.prepared.scope,
                sections: cold.prepared.scope.sections.slice(1) } } },
        ];
        for (const forged of forgeries) {
            expect(methods.validatePreparedProjectSectionOrder(forged as typeof cold))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await methods.commitPreparedProjectSectionOrder(forged as typeof cold))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(saves()).toBe(0);
        expect(methods.prepareProjectSectionOrder({ ...input,
            expectedSections: [...input.expectedSections, input.expectedSections[0]] }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(methods.probeProjectSectionOrderOutcome(input))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('keeps the frozen UUID/effect through failed persistence and recognizes a late full receipt', async () => {
        const { methods, request, prepare, saves, fail, data } = await open(undefined, null);
        const input = request();
        const prepared = prepare(input);
        expect(prepared.deviceIdBefore).toBeNull();
        expect(prepared.deviceIdToInitialize).toMatch(/^[0-9a-f-]{36}$/);
        fail(true);
        expect(await methods.commitPreparedProjectSectionOrder({ request: input, prepared }))
            .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        const afterFailure = structuredClone(useTaskStore.getState()._allSections);
        fail(false);
        expect(await methods.commitPreparedProjectSectionOrder({ request: input, prepared }))
            .toEqual({ ok: true, value: prepared.result });
        expect(useTaskStore.getState()._allSections).toEqual(afterFailure);
        expect(data().settings.deviceId).toBe(prepared.deviceIdToInitialize);
        const count = saves();
        useTaskStore.setState((state) => ({
            _allProjects: [project({ status: 'archived', title: 'Later' }), { ...project(), id: 'other' }],
            _projectsById: new Map([['parent', project({ status: 'archived', title: 'Later' })],
                ['other', { ...project(), id: 'other' }]]),
            _allSections: [...state._allSections, section('later', 4096)],
        }));
        expect(await methods.commitPreparedProjectSectionOrder({ request: input, prepared }))
            .toEqual({ ok: true, value: prepared.result });
        expect(saves()).toBe(count);
        useTaskStore.setState((state) => ({ _allSections: state._allSections.map((row) =>
            row.id === prepared.effect.sections[0].after.id ? { ...row, rev: 99 } : row) }));
        expect(await methods.commitPreparedProjectSectionOrder({ request: input, prepared }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('keeps archived history read-only and refuses a token over the native byte cap', async () => {
        const { methods } = await open();
        const archived = project({ status: 'archived' });
        useTaskStore.setState((state) => ({ _allProjects: [archived, { ...project(), id: 'other' }],
            _projectsById: new Map([['parent', archived], ['other', state._allProjects[1]]]) }));
        const read = methods.getProjectSectionOrderOptions({ projectId: 'parent' });
        expect(read.ok && read.value.canReorder).toBe(false);
        expect(read.ok && read.value.sections.every((row) => !row.canMoveUp && !row.canMoveDown)).toBe(true);
        const large = await open([section('huge', 0, { description: 'x'.repeat(2_100_000) })]);
        expect(large.methods.getProjectSectionOrderOptions({ projectId: 'parent' }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });
});

const getOrder = (rows: Section[]): string[] => [...rows]
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title)).map((row) => row.id);
