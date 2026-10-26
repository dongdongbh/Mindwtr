import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeHostContract } from './native-host-contract';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Project, Section, Task } from './types';

const stamp = '2026-09-01T00:00:00.000Z';
const project: Project = { id: 'p', title: 'Project', status: 'active', order: 0, color: '#123456', tagIds: [],
    createdAt: stamp, updatedAt: stamp };
const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, title: id, projectId: 'p',
    status: 'next', tags: [], contexts: [], createdAt: stamp, updatedAt: stamp, ...extra });
const section = (id: string, order: number): Section => ({ id, projectId: 'p', title: id, order,
    createdAt: stamp, updatedAt: stamp });
const saveData = vi.fn().mockResolvedValue(undefined);

describe('native Project task order read', () => {
    beforeEach(() => {
        saveData.mockClear();
        setStorageAdapter({ getData: vi.fn().mockResolvedValue({ tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} }), saveData });
        useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
            settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0 });
    });
    afterEach(async () => { await flushPendingSave(); resetForTests(); vi.restoreAllMocks(); });

    it('pages 53+ rows with stable section identity and makes no writes', async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        useTaskStore.setState({ _allProjects: [project], _allSections: [section('s1', 0), section('empty', 1)],
            _allTasks: [...Array.from({ length: 53 }, (_, i) => task(`t${i}`, { order: i, sectionId: i < 27 ? 's1' : undefined })),
                task('finished', { status: 'done' }), task('reference', { status: 'reference' })] });
        saveData.mockClear();
        const base = { projectId: 'p', showCompleted: true, filters: {} };
        const first = host.getProjectTaskOrderView({ ...base, offset: 0, limit: 17 });
        if (!first.ok) throw new Error(first.error.code);
        expect(first.value.total).toBe(56); // 53 tasks plus 3 headers; Done and Reference are excluded.
        expect(first.value.canReorder).toBe(true);
        expect(first.value.items[0]).toMatchObject({ type: 'section', id: 's1', sectionId: 's1' });
        const all = [...first.value.items];
        for (let offset = 17; offset < first.value.total; offset += 17) {
            const page = host.getProjectTaskOrderView({ ...base, offset, limit: 17, revision: first.value.revision });
            if (!page.ok) throw new Error(page.error.code);
            expect(page.value.total).toBe(first.value.total);
            expect(page.value.orderToken).toBeNull();
            all.push(...page.value.items);
        }
        expect(all.map((item) => item.type === 'section' ? item.id : item.row.id))
            .toEqual(['s1', ...Array.from({ length: 27 }, (_, i) => `t${i}`), 'empty', 'no-section',
                ...Array.from({ length: 26 }, (_, i) => `t${i + 27}`)]);
        expect(all.find((item) => item.type === 'task' && item.row.id === 't27'))
            .toMatchObject({ type: 'task', sectionId: null });
        // RN's reorder headers show each section's task count beside its title.
        expect(all.filter((item) => item.type === 'section').map((item) => [item.id, item.count]))
            .toEqual([['s1', 27], ['empty', 0], ['no-section', 26]]);
        expect(saveData).not.toHaveBeenCalled();
    });

    it('rejects stale paging and invalid input, including filter changes and byte bounds', async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        useTaskStore.setState({ _allProjects: [project], _allTasks: [task('one', { contexts: ['@work'] }), task('two')] });
        saveData.mockClear();
        const base = { projectId: 'p', showCompleted: false, filters: { tokens: ['@work'] } };
        const first = host.getProjectTaskOrderView({ ...base, offset: 0, limit: 1 });
        if (!first.ok) throw new Error(first.error.code);
        expect(first.value.filters.tokens).toEqual(['@work']);
        expect(first.value.items).toMatchObject([{ type: 'task', row: { id: 'one' } }]);
        expect(host.getProjectTaskOrderView({ ...base, offset: 1, limit: 1 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(host.getProjectTaskOrderView({ ...base, filters: {}, offset: 1, limit: 1, revision: first.value.revision }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(host.getProjectTaskOrderView({ ...base, showCompleted: true, offset: 1, limit: 1, revision: first.value.revision }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        useTaskStore.setState({ _allTasks: [task('new')] });
        expect(host.getProjectTaskOrderView({ ...base, offset: 1, limit: 1, revision: first.value.revision }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        for (const input of [
            { ...base, offset: 0, limit: 101 }, { ...base, offset: -1, limit: 1 },
            { ...base, offset: 0, limit: 1, filters: { projects: ['p'] } },
            { ...base, offset: 0, limit: 1, filters: { timeEstimates: ['15m'] } },
            { ...base, offset: 0, limit: 1, filters: { unknown: true } },
            { ...base, offset: 0, limit: 1, extra: true },
            { ...base, offset: 0, limit: 1, filters: { searchQuery: 'x'.repeat(1_000_000) } },
        ]) {
            expect(host.getProjectTaskOrderView(input as Parameters<typeof host.getProjectTaskOrderView>[0]))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(saveData).not.toHaveBeenCalled();
    });

    it('shows archived and custom-sort rows while disabling reorder', async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        saveData.mockClear();
        useTaskStore.setState({ _allProjects: [{ ...project, taskSortBy: 'title' }], _allTasks: [task('b'), task('a')] });
        const base = { projectId: 'p', showCompleted: false, filters: {}, offset: 0, limit: 10 };
        const custom = host.getProjectTaskOrderView(base);
        if (!custom.ok) throw new Error(custom.error.code);
        expect(custom.value.canReorder).toBe(false);
        expect(custom.value.items.filter((item) => item.type === 'task').length).toBe(2);
        useTaskStore.setState({ _allProjects: [{ ...project, status: 'archived' }], _allTasks: [task('old', { status: 'archived' })] });
        const archived = host.getProjectTaskOrderView(base);
        if (!archived.ok) throw new Error(archived.error.code);
        expect(archived.value).toMatchObject({ readOnly: true, canReorder: false });
        expect(archived.value.items).toMatchObject([{ type: 'task', row: { id: 'old' } }]);
        expect(saveData).not.toHaveBeenCalled();
    });

    it('reports RN reorder targets on Project detail without imposing sort or archive gates', async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        const read = () => host.getProjectDetailFilterView({ projectId: 'p', offset: 0, limit: 10,
            showCompleted: true, completedCollapsed: false, filters: {} });
        useTaskStore.setState({ _allProjects: [project], _allTasks: [task('done', { status: 'done' }),
            task('ref', { status: 'reference' })] });
        const completedOnly = read();
        if (!completedOnly.ok) throw new Error(completedOnly.error.code);
        expect(completedOnly.value.controls.hasReorderTargets).toBe(false);
        useTaskStore.setState({ _allSections: [section('s1', 0), section('s2', 1)] });
        const emptySections = read();
        if (!emptySections.ok) throw new Error(emptySections.error.code);
        expect(emptySections.value.controls.hasReorderTargets).toBe(true);
        useTaskStore.setState({ _allProjects: [{ ...project, taskSortBy: 'title' }],
            _allSections: [], _allTasks: [task('a')] });
        const custom = read();
        if (!custom.ok) throw new Error(custom.error.code);
        expect(custom.value.controls.hasReorderTargets).toBe(true);
    });

    it('prepares a sparse same-section move and an atomic cross-section move', async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        useTaskStore.setState({ _allProjects: [project], _allSections: [section('s1', 0), section('s2', 1)],
            _allTasks: [task('a', { sectionId: 's1', order: 0, orderNum: 0 }),
                task('b', { sectionId: 's1', order: 1024, orderNum: 1024 }),
                task('c', { sectionId: 's2', order: 0, orderNum: 0 })], settings: { deviceId: 'device' } });
        saveData.mockClear();
        const read = () => host.getProjectTaskOrderView({ projectId: 'p', showCompleted: false, filters: {}, offset: 0, limit: 20 });
        const first = read();
        if (!first.ok || !first.value.orderToken) throw new Error('missing order token');
        const request = { requestId: '3fb34adb-9bf8-451f-8f7f-7964b6a0de9b', projectId: 'p', taskId: 'a',
            after: { type: 'task' as const, id: 'b' }, showCompleted: false, filters: {},
            expectedOrder: first.value.orderToken };
        const planned = host.prepareProjectTaskOrder(request);
        if (!planned.ok || planned.value.kind !== 'prepared') throw new Error(JSON.stringify(planned));
        expect(planned.value.prepared.effect.tasks).toHaveLength(1);
        expect(planned.value.prepared.effect.tasks[0].after).toMatchObject({ id: 'a', sectionId: 's1', order: 2048 });
        expect(await host.commitPreparedProjectTaskOrder({ request, prepared: planned.value.prepared }))
            .toEqual({ ok: true, value: { projectId: 'p', taskId: 'a', sectionId: 's1' } });
        const next = read();
        if (!next.ok || !next.value.orderToken) throw new Error('missing next order token');
        const cross = { ...request, requestId: '4fb34adb-9bf8-451f-8f7f-7964b6a0de9b',
            after: { type: 'task' as const, id: 'c' }, expectedOrder: next.value.orderToken };
        const crossPlan = host.prepareProjectTaskOrder(cross);
        if (!crossPlan.ok || crossPlan.value.kind !== 'prepared') throw new Error(JSON.stringify(crossPlan));
        expect(crossPlan.value.prepared.effect.tasks).toHaveLength(1);
        expect(crossPlan.value.prepared.effect.tasks[0].after).toMatchObject({ id: 'a', sectionId: 's2' });
        expect(crossPlan.value.prepared.effect.tasks[0].after.rev)
            .toBe((crossPlan.value.prepared.effect.tasks[0].before.rev ?? 0) + 1);
        expect(await host.commitPreparedProjectTaskOrder({ request: cross, prepared: crossPlan.value.prepared }))
            .toEqual({ ok: true, value: { projectId: 'p', taskId: 'a', sectionId: 's2' } });
        expect(useTaskStore.getState()._allTasks.find((row) => row.id === 'b')).toMatchObject({ order: 1024, sectionId: 's1' });
    });

    it('rejects hidden order drift and forged effects before writing', async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        useTaskStore.setState({ _allProjects: [project], _allTasks: [
            task('a', { order: 0, orderNum: 0, contexts: ['@work'] }),
            task('hidden', { order: 1024, orderNum: 1024 }),
            task('c', { order: 2048, orderNum: 2048, contexts: ['@work'] }),
        ], settings: { deviceId: 'device' } });
        saveData.mockClear();
        const view = host.getProjectTaskOrderView({ projectId: 'p', showCompleted: false,
            filters: { tokens: ['@work'] }, offset: 0, limit: 20 });
        if (!view.ok || !view.value.orderToken) throw new Error('missing order token');
        const request = { requestId: '3fb34adb-9bf8-451f-8f7f-7964b6a0de9b', projectId: 'p', taskId: 'a',
            after: { type: 'task' as const, id: 'c' }, showCompleted: false, filters: { tokens: ['@work'] },
            expectedOrder: view.value.orderToken };
        const planned = host.prepareProjectTaskOrder(request);
        if (!planned.ok || planned.value.kind !== 'prepared') throw new Error(JSON.stringify(planned));
        expect(planned.value.prepared.effect.tasks.map((pair) => pair.after.id)).toEqual(['a']);
        expect(planned.value.prepared.effect.tasks[0].after.order).toBe(3072);
        const forged = structuredClone(planned.value.prepared);
        forged.effect.tasks[0].after.title = 'Forged';
        expect(host.validatePreparedProjectTaskOrder({ request, prepared: forged }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.commitPreparedProjectTaskOrder({ request, prepared: forged }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        useTaskStore.setState({ _allTasks: useTaskStore.getState()._allTasks.map((row) => row.id === 'hidden'
            ? { ...row, order: 4096, orderNum: 4096 } : row) });
        expect(host.prepareProjectTaskOrder(request)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(saveData).not.toHaveBeenCalled();
    });

    it.each(['waiting', 'someday'] as const)('allows RN ordering for %s Projects', async (status) => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        useTaskStore.setState({ _allProjects: [{ ...project, status }],
            _allTasks: [task('a', { order: 0, orderNum: 0 }), task('b', { order: 1024, orderNum: 1024 })],
            settings: { deviceId: 'device' } });
        const view = host.getProjectTaskOrderView({ projectId: 'p', showCompleted: false,
            filters: {}, offset: 0, limit: 20 });
        if (!view.ok || !view.value.orderToken) throw new Error('missing order token');
        expect(view.value.canReorder).toBe(true);
        const request = { requestId: '3fb34adb-9bf8-451f-8f7f-7964b6a0de9b', projectId: 'p', taskId: 'a',
            after: { type: 'task' as const, id: 'b' }, showCompleted: false, filters: {},
            expectedOrder: view.value.orderToken };
        expect(host.prepareProjectTaskOrder(request)).toMatchObject({ ok: true, value: { kind: 'prepared' } });
    });

    it('does not write a no-op and rebalances an exhausted integer gap', async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        useTaskStore.setState({ _allProjects: [project], _allTasks: [
            task('a', { order: 0, orderNum: 0 }), task('b', { order: 1, orderNum: 1 }),
            task('c', { order: 2, orderNum: 2 })], settings: { deviceId: 'device' } });
        saveData.mockClear();
        const view = host.getProjectTaskOrderView({ projectId: 'p', showCompleted: false,
            filters: {}, offset: 0, limit: 10 });
        if (!view.ok || !view.value.orderToken) throw new Error('missing order token');
        const request = { requestId: '3fb34adb-9bf8-451f-8f7f-7964b6a0de9b', projectId: 'p', taskId: 'a',
            after: null, showCompleted: false, filters: {}, expectedOrder: view.value.orderToken };
        expect(host.prepareProjectTaskOrder(request)).toEqual({ ok: true,
            value: { kind: 'noop', result: { projectId: 'p', taskId: 'a', sectionId: null } } });
        expect(saveData).not.toHaveBeenCalled();
        const rebalance = host.prepareProjectTaskOrder({ ...request, taskId: 'c',
            after: { type: 'task', id: 'a' } });
        if (!rebalance.ok || rebalance.value.kind !== 'prepared') throw new Error(JSON.stringify(rebalance));
        expect(rebalance.value.prepared.effect.tasks.length).toBeGreaterThan(1);
        expect(rebalance.value.prepared.effect.tasks.every((pair) => Number.isInteger(pair.after.order))).toBe(true);
    });

    it('keeps a compact exact token for 5,000 tasks without full Notes', async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        useTaskStore.setState({ _allProjects: [project], _allTasks: [
            task('note', { order: 10_000, description: 'secret-note'.repeat(100_000) }),
            ...Array.from({ length: 5000 }, (_, index) => task(`id-${index}`, { order: index })),
        ] });
        const first = host.getProjectTaskOrderView({ projectId: 'p', showCompleted: false,
            filters: {}, offset: 0, limit: 1 });
        if (!first.ok) throw new Error(first.error.code);
        expect(first.value.total).toBe(5001);
        expect(first.value.orderToken?.length).toBeLessThan(2_000_000);
        expect(first.value.orderToken).not.toContain('secret-note');
        expect(first.value.canReorder).toBe(true);
    });

    it('drops an overbound token and refuses an overbound row response', async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        useTaskStore.setState({ _allProjects: [project], _allTasks: Array.from({ length: 5000 }, (_, index) =>
            task(`${index}-${'x'.repeat(440)}`, { title: 'short', order: index })) });
        saveData.mockClear();
        const input = { projectId: 'p', showCompleted: false, filters: {}, offset: 0, limit: 1 };
        const largeToken = host.getProjectTaskOrderView(input);
        if (!largeToken.ok) throw new Error(largeToken.error.code);
        expect(largeToken.value.orderToken).toBeNull();
        expect(largeToken.value.canReorder).toBe(false);
        useTaskStore.setState({ _allTasks: [task('huge', { title: 'x'.repeat(2_100_000) })] });
        expect(host.getProjectTaskOrderView(input)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(saveData).not.toHaveBeenCalled();
    });

    it.each(['no-section', 'project-completed-tasks', 'project-reference-tasks'])(
        'orders into a real Section whose ID collides with %s', async (sectionId) => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        useTaskStore.setState({ _allProjects: [project], _allSections: [section(sectionId, 0)],
            _allTasks: [task('a', { sectionId }), task('loose', { order: 1 })] });
        const view = host.getProjectTaskOrderView({ projectId: 'p', showCompleted: false,
            filters: {}, offset: 0, limit: 10 });
        if (!view.ok || !view.value.orderToken) throw new Error(JSON.stringify(view));
        expect(view.value.canReorder).toBe(true);
        const typed = JSON.parse(view.value.orderToken).items as { type: string; id: string; sectionId?: string | null }[];
        expect(typed.filter((item) => item.type === 'section')).toEqual([
            { type: 'section', id: sectionId, sectionId },
            { type: 'section', id: sectionId === 'no-section' ? 'no-section:1' : 'no-section', sectionId: null },
        ]);
        const prepared = host.prepareProjectTaskOrder({ requestId: '36351d7a-7659-4b8b-a878-f6ee7425d021',
            projectId: 'p', taskId: 'loose', after: { type: 'section', id: sectionId }, showCompleted: false,
            filters: {}, expectedOrder: view.value.orderToken });
        expect(prepared).toMatchObject({ ok: true, value: { kind: 'prepared', prepared: { effect: {
            tasks: [expect.objectContaining({ after: expect.objectContaining({ sectionId }) })],
        } } } });
    });

    it('prepares filtered drops into a real no-section and the synthetic unsectioned bucket', async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        useTaskStore.setState({ _allProjects: [project], _allSections: [section('no-section', 0)],
            _allTasks: [task('real', { sectionId: 'no-section', contexts: ['@work'], order: 0 }),
                task('loose', { contexts: ['@work'], order: 1 }),
                task('hidden', { sectionId: 'no-section', order: 2 })] });
        await flushPendingSave();
        saveData.mockClear();
        const filters = { tokens: ['@work'] };
        const view = host.getProjectTaskOrderView({ projectId: 'p', showCompleted: false, filters, offset: 0, limit: 10 });
        if (!view.ok || !view.value.orderToken) throw new Error(JSON.stringify(view));
        const request = { projectId: 'p', showCompleted: false, filters, expectedOrder: view.value.orderToken };
        const intoReal = host.prepareProjectTaskOrder({ ...request,
            requestId: 'd9e64489-c170-420a-b974-f958651c5e63', taskId: 'loose',
            after: { type: 'section', id: 'no-section' } });
        expect(intoReal).toMatchObject({ ok: true, value: { kind: 'prepared', prepared: { effect: {
            tasks: [expect.objectContaining({ after: expect.objectContaining({ id: 'loose', sectionId: 'no-section' }) })],
        } } } });
        const intoNone = host.prepareProjectTaskOrder({ ...request,
            requestId: 'cb40ab44-22c6-4c5b-aa46-dab0b8583df0', taskId: 'real',
            after: { type: 'section', id: 'no-section:1' } });
        expect(intoNone).toMatchObject({ ok: true, value: { kind: 'prepared', prepared: { effect: {
            tasks: [expect.objectContaining({ after: expect.objectContaining({ id: 'real' }) })],
        } } } });
        if (!intoNone.ok || intoNone.value.kind !== 'prepared') throw new Error(JSON.stringify(intoNone));
        expect(intoNone.value.prepared.effect.tasks[0]?.after.sectionId).toBeUndefined();
        expect(saveData).not.toHaveBeenCalled();
    });

    it('replays the exact UUID after recreation and later parent changes, but rejects an edited receipt', async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        useTaskStore.setState({ _allProjects: [project], _allTasks: [
            task('a', { order: 0, orderNum: 0 }), task('b', { order: 1024, orderNum: 1024 })],
            settings: { deviceId: 'device' } });
        let durable: AppData | null = null;
        saveData.mockImplementation(async (next: AppData) => { durable = structuredClone(next); });
        const view = host.getProjectTaskOrderView({ projectId: 'p', showCompleted: false,
            filters: {}, offset: 0, limit: 10 });
        if (!view.ok || !view.value.orderToken) throw new Error('missing order token');
        const request = { requestId: '3fb34adb-9bf8-451f-8f7f-7964b6a0de9b', projectId: 'p', taskId: 'a',
            after: { type: 'task' as const, id: 'b' }, showCompleted: false, filters: {},
            expectedOrder: view.value.orderToken };
        const planned = host.prepareProjectTaskOrder(request);
        if (!planned.ok || planned.value.kind !== 'prepared') throw new Error(JSON.stringify(planned));
        const journal = JSON.parse(JSON.stringify({ request, prepared: planned.value.prepared }));
        expect(host.validatePreparedProjectTaskOrder(journal)).toEqual({ ok: true, value: planned.value.prepared.result });
        expect(await host.commitPreparedProjectTaskOrder(journal)).toEqual({ ok: true, value: planned.value.prepared.result });
        if (!durable) throw new Error('save did not reach the adapter');
        const reopen = async () => {
            await flushPendingSave(); resetForTests();
            setStorageAdapter({ getData: async () => structuredClone(durable), saveData });
            const next = createNativeHostContract();
            const activation = await next.activate({ writeSafetyReady: true });
            if (!activation.ok) throw new Error(JSON.stringify(activation));
            return next;
        };
        (durable as AppData).projects = [{ ...(durable as AppData).projects[0], title: 'Renamed after save' }];
        (durable as AppData).tasks.push(task('later', { order: 2048, orderNum: 2048 }));
        const renamed = await reopen();
        const count = saveData.mock.calls.length;
        expect(await renamed.commitPreparedProjectTaskOrder(journal))
            .toEqual({ ok: true, value: planned.value.prepared.result });
        expect(saveData).toHaveBeenCalledTimes(count);
        useTaskStore.setState((state) => ({
            _allProjects: [{ ...state._allProjects[0], deletedAt: stamp }],
            _allTasks: state._allTasks.map((row) => row.id === 'later' ? { ...row, title: 'Edited later' } : row),
        }));
        expect(await renamed.commitPreparedProjectTaskOrder(journal))
            .toEqual({ ok: true, value: planned.value.prepared.result });
        useTaskStore.setState((state) => ({ _allTasks: state._allTasks.map((row) => row.id === 'a'
            ? { ...row, title: 'Edited receipt' } : row) }));
        expect(await renamed.commitPreparedProjectTaskOrder(journal))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('validates and commits a prepared envelope after a sorted-key JSON roundtrip', async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        useTaskStore.setState({ _allProjects: [project], _allSections: [section('s1', 0)],
            _allTasks: [task('a', { sectionId: 's1', order: 0, orderNum: 0 }),
                task('b', { sectionId: 's1', order: 1024, orderNum: 1024 })],
            settings: { deviceId: 'device' } });
        const view = host.getProjectTaskOrderView({ projectId: 'p', showCompleted: false,
            filters: {}, offset: 0, limit: 10 });
        if (!view.ok || !view.value.orderToken) throw new Error(JSON.stringify(view));
        const request = { requestId: '368905ca-cd6d-498a-bc26-fe27399d76f2', projectId: 'p', taskId: 'a',
            after: { type: 'task' as const, id: 'b' }, showCompleted: false, filters: {},
            expectedOrder: view.value.orderToken };
        const planned = host.prepareProjectTaskOrder(request);
        if (!planned.ok || planned.value.kind !== 'prepared') throw new Error(JSON.stringify(planned));
        const sortKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(sortKeys)
            : value && typeof value === 'object'
                ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
                    .map(([key, item]) => [key, sortKeys(item)]))
                : value;
        const envelope = JSON.parse(JSON.stringify(sortKeys({ request, prepared: planned.value.prepared })));
        expect(host.validatePreparedProjectTaskOrder(envelope))
            .toEqual({ ok: true, value: planned.value.prepared.result });
        expect(await host.commitPreparedProjectTaskOrder(envelope))
            .toEqual({ ok: true, value: planned.value.prepared.result });
    });

    it('keeps the prepared result across SAVE_FAILED and retries persistence once', async () => {
        const host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        useTaskStore.setState({ _allProjects: [project], _allTasks: [
            task('a', { order: 0, orderNum: 0 }), task('b', { order: 1024, orderNum: 1024 })],
            settings: { deviceId: 'device' } });
        const view = host.getProjectTaskOrderView({ projectId: 'p', showCompleted: false,
            filters: {}, offset: 0, limit: 10 });
        if (!view.ok || !view.value.orderToken) throw new Error('missing order token');
        const request = { requestId: '3fb34adb-9bf8-451f-8f7f-7964b6a0de9b', projectId: 'p', taskId: 'a',
            after: { type: 'task' as const, id: 'b' }, showCompleted: false, filters: {},
            expectedOrder: view.value.orderToken };
        const planned = host.prepareProjectTaskOrder(request);
        if (!planned.ok || planned.value.kind !== 'prepared') throw new Error(JSON.stringify(planned));
        let diskUnavailable = true;
        saveData.mockImplementation(async () => { if (diskUnavailable) throw new Error('disk unavailable'); });
        expect(await host.commitPreparedProjectTaskOrder({ request, prepared: planned.value.prepared }))
            .toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        const changed = structuredClone(useTaskStore.getState()._allTasks);
        diskUnavailable = false;
        expect(await host.commitPreparedProjectTaskOrder({ request, prepared: planned.value.prepared }))
            .toEqual({ ok: true, value: planned.value.prepared.result });
        expect(useTaskStore.getState()._allTasks).toEqual(changed);
    });
});
