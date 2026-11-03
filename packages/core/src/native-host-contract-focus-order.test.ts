import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FOCUS_CONTROL_STATE } from './focus-controls';
import { createFocusOrderMethods, type NativeFocusOrderRequest } from './native-host-contract-focus-order';
import { taskRevisionOf } from './native-request-receipts';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Project, Task } from './types';

const stamp = '2026-09-01T12:00:00.000Z';
const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, title: id, status: 'next',
    isFocusedToday: true, tags: [], contexts: [], rev: 3, revBy: 'prior',
    createdAt: stamp, updatedAt: stamp, ...extra });
const project = (extra: Partial<Project> = {}): Project => ({ id: 'project', title: 'Project',
    status: 'active', order: 0, color: '#123456', tagIds: [], createdAt: stamp, updatedAt: stamp, ...extra });
const sorted = <T>(value: T): T => {
    const walk = (part: unknown): unknown => Array.isArray(part) ? part.map(walk)
        : part && typeof part === 'object' ? Object.fromEntries(Object.entries(part)
            .sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, walk(nested)])) : part;
    return JSON.parse(JSON.stringify(walk(value))) as T;
};

async function open(initial: Partial<AppData> = {}, fails?: () => boolean) {
    resetForTests();
    let stored: AppData = { tasks: [task('a', { focusOrder: 0, dueDate: '2026-10-01' }),
        task('b', { focusOrder: 1, startTime: '2026-09-01T09:00:00' }),
        task('hidden', { isFocusedToday: false, description: 'leave exactly' })],
    projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'device' }, ...initial };
    let saves = 0;
    setStorageAdapter({ getData: async () => stored, saveData: async (next) => {
        if (fails?.()) throw new Error('disk unavailable');
        stored = structuredClone(next); saves++;
    } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0,
        lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    const methods = createFocusOrderMethods({ readiness: () => ({ ok: true, value: null }),
        save: async () => {
            try { await flushPendingSave(); return { ok: true as const, value: null }; }
            catch (error) { return { ok: false as const, error: { code: 'SAVE_FAILED' as const,
                message: error instanceof Error ? error.message : String(error) } }; }
        }, revision: () => 'revision', t: () => (key) => key,
        formatDate: (value, _format, fallback) => fallback ?? String(value) });
    const request = (ids = ['b', 'a']): NativeFocusOrderRequest => {
        const options = methods.getFocusOrderOptions({ controls: DEFAULT_FOCUS_CONTROL_STATE });
        if (!options.ok) throw new Error(JSON.stringify(options));
        return { requestId: 'e2f841a9-fbee-4d80-84d0-c4de923a12bc',
            controls: options.value.controls, ids, expectedOrder: options.value.expectedOrder };
    };
    return { methods, request, stored: () => stored, saves: () => saves };
}

afterEach(async () => { vi.useRealTimers(); await flushPendingSave().catch(() => undefined); resetForTests(); });

describe('prepared Focus order', () => {
    it('reorders an area subset in its global slots, keeps the global cap, and cold replays', async () => {
        const initial: Partial<AppData> = { tasks: [task('a', { focusOrder: 0, areaId: 'work' }),
            task('hidden', { focusOrder: 1, areaId: 'home' }), task('b', { focusOrder: 2, areaId: 'work' }),
            task('candidate', { isFocusedToday: false, areaId: 'work' })],
            areas: ['work', 'home'].map((id, order) => ({ id, name: id, order, createdAt: stamp, updatedAt: stamp })),
            settings: { deviceId: 'device', filters: { areaIds: ['work'] }, gtd: { focusTaskLimit: 3 } } };
        const host = await open(initial);
        expect(await useTaskStore.getState().updateTask('candidate', { isFocusedToday: true }))
            .toMatchObject({ success: false, error: 'Focus limit of 3 reached' });
        const hidden = structuredClone(useTaskStore.getState()._tasksById.get('hidden'));
        const request = host.request(['b', 'a']);
        const plan = host.methods.prepareFocusOrder(request);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        expect(plan.value.prepared.version).toBe(2);
        expect(plan.value.prepared.scope.tasks.map((row) => row.id)).toEqual(['a', 'hidden', 'b']);
        const envelope = sorted({ request, prepared: plan.value.prepared });
        const cold = await open(initial);
        expect(await cold.methods.commitPreparedFocusOrder(envelope)).toEqual({ ok: true, value: { ids: ['b', 'a'] } });
        expect(cold.stored().tasks.find((row) => row.id === 'hidden')).toEqual(hidden);
        expect(cold.stored().tasks.find((row) => row.id === 'b')?.focusOrder).toBe(0);
        expect(cold.stored().tasks.find((row) => row.id === 'a')?.focusOrder).toBe(2);
        await useTaskStore.getState().reorderFocusedTasks(['a', 'b']);
        await flushPendingSave();
        expect(cold.stored().tasks.find((row) => row.id === 'hidden')).toEqual(hidden);
        expect(cold.stored().tasks.find((row) => row.id === 'a')?.focusOrder).toBe(0);
        expect(cold.stored().tasks.find((row) => row.id === 'b')?.focusOrder).toBe(2);
    });

    it('validates and cold commits a historical v1 whole-list journal without reinterpreting its effect', async () => {
        const host = await open();
        const request = host.request();
        const plan = host.methods.prepareFocusOrder(request);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        const envelope = sorted({ request, prepared: { ...plan.value.prepared, version: 1 as const } });
        expect(host.methods.validatePreparedFocusOrder(envelope)).toEqual({ ok: true, value: { ids: ['b', 'a'] } });
        const cold = await open();
        expect(await cold.methods.commitPreparedFocusOrder(envelope)).toEqual({ ok: true, value: { ids: ['b', 'a'] } });
    });

    it('returns the complete bounded list, keeps raw dates and hidden rows, and stamps only changed rows', async () => {
        const host = await open({ tasks: [task('a', { focusOrder: 0, dueDate: '2026-10-01' }),
            task('b', { focusOrder: 1, startTime: '2026-09-01T09:00:00' }),
            task('c', { focusOrder: 2, description: 'unchanged focused row' }),
            task('hidden', { isFocusedToday: false, description: 'leave exactly' })] });
        const options = host.methods.getFocusOrderOptions({ controls: DEFAULT_FOCUS_CONTROL_STATE });
        if (!options.ok) throw new Error(JSON.stringify(options));
        expect(options.value).toMatchObject({ revision: 'revision', canReorder: true,
            rows: [{ id: 'a', moveUp: null, moveDown: ['b', 'a', 'c'] },
                { id: 'b', moveUp: ['b', 'a', 'c'] }, { id: 'c', moveDown: null }] });
        expect(options.value.rows[0].taskRevision).toBe(taskRevisionOf(useTaskStore.getState()._allTasks[0]));
        const request = host.request(['b', 'a', 'c']);
        const planned = host.methods.prepareFocusOrder(request);
        if (!planned.ok || planned.value.kind !== 'prepared') throw new Error(JSON.stringify(planned));
        expect(planned.value.prepared.scope.tasks.map((row) => row.id)).toEqual(['a', 'b', 'c']);
        expect(planned.value.prepared.effect.tasks.map((row) => row.before.id)).toEqual(['b', 'a']);
        const unchanged = structuredClone(useTaskStore.getState()._allTasks.filter((row) => row.id === 'c' || row.id === 'hidden'));
        const envelope = sorted({ request, prepared: planned.value.prepared });
        expect(host.methods.validatePreparedFocusOrder(envelope)).toEqual({ ok: true, value: { ids: ['b', 'a', 'c'] } });
        expect(await host.methods.commitPreparedFocusOrder(envelope)).toEqual({ ok: true, value: { ids: ['b', 'a', 'c'] } });
        expect(useTaskStore.getState()._allTasks.filter((row) => row.id === 'c' || row.id === 'hidden')).toEqual(unchanged);
        expect(host.stored().tasks.find((row) => row.id === 'a')).toMatchObject({ focusOrder: 1, rev: 4, dueDate: '2026-10-01' });
        expect(host.stored().tasks.find((row) => row.id === 'b')).toMatchObject({ focusOrder: 0, rev: 4,
            startTime: '2026-09-01T09:00:00' });
        const count = host.saves();
        expect(await host.methods.commitPreparedFocusOrder(envelope)).toEqual({ ok: true, value: { ids: ['b', 'a', 'c'] } });
        expect(host.saves()).toBe(count);
    });

    it('retries a failed save and a cold before-row journal; applied rows receipt after parent and settings changes', async () => {
        let failing = true;
        const first = await open({ settings: {} }, () => failing);
        useTaskStore.setState({ settings: {} });
        const request = first.request();
        const planned = first.methods.prepareFocusOrder(request);
        if (!planned.ok || planned.value.kind !== 'prepared') throw new Error(JSON.stringify(planned));
        const envelope = sorted({ request, prepared: planned.value.prepared });
        expect(envelope.prepared.deviceIdBefore).toBeNull();
        expect(await first.methods.commitPreparedFocusOrder(envelope)).toMatchObject({ ok: false,
            error: { code: 'SAVE_FAILED' } });
        failing = false;
        expect(await first.methods.commitPreparedFocusOrder(envelope)).toEqual({ ok: true, value: { ids: ['b', 'a'] } });
        const later = structuredClone(first.stored());
        later.projects = [project({ status: 'archived' })];
        later.settings.deviceId = 'later-device';
        const cold = await open(later);
        useTaskStore.setState((state) => ({ _allTasks: [...state._allTasks, task('arrival')],
            _allProjects: [project({ status: 'archived' })] }));
        await flushPendingSave();
        const count = cold.saves();
        expect(await cold.methods.commitPreparedFocusOrder(envelope)).toEqual({ ok: true, value: { ids: ['b', 'a'] } });
        expect(cold.saves()).toBe(count);

        const before = await open();
        useTaskStore.setState({ settings: {} });
        expect(await before.methods.commitPreparedFocusOrder(envelope)).toEqual({ ok: true, value: { ids: ['b', 'a'] } });
    });

    it.each([
        ['rename', (state: ReturnType<typeof useTaskStore.getState>) => ({ _allTasks: state._allTasks.map((row) => row.id === 'a' ? { ...row, title: 'renamed' } : row) })],
        ['status', (state: ReturnType<typeof useTaskStore.getState>) => ({ _allTasks: state._allTasks.map((row) => row.id === 'a' ? { ...row, status: 'done' as const } : row) })],
        ['arrival', (state: ReturnType<typeof useTaskStore.getState>) => ({ _allTasks: [...state._allTasks, task('arrival')] })],
        ['ABA revision', (state: ReturnType<typeof useTaskStore.getState>) => ({ _allTasks: state._allTasks.map((row) => row.id === 'a' ? { ...row, rev: 9 } : row) })],
    ])('refuses first apply after %s changes', async (_name, change) => {
        const initial = { tasks: [task('a', { projectId: 'project', focusOrder: 0 }),
            task('b', { focusOrder: 1 })], projects: [project()] };
        const host = await open(initial);
        const request = host.request();
        const planned = host.methods.prepareFocusOrder(request);
        if (!planned.ok || planned.value.kind !== 'prepared') throw new Error(JSON.stringify(planned));
        useTaskStore.setState(change);
        expect(await host.methods.commitPreparedFocusOrder({ request, prepared: planned.value.prepared }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(host.saves()).toBe(0);
    });

    it('rejects malformed journals and leaves no-op requests unpersisted', async () => {
        const host = await open();
        const request = host.request();
        const planned = host.methods.prepareFocusOrder(request);
        if (!planned.ok || planned.value.kind !== 'prepared') throw new Error(JSON.stringify(planned));
        const envelope = sorted({ request, prepared: planned.value.prepared });
        const invalid = (edit: (value: typeof envelope) => void) => {
            const changed = structuredClone(envelope); edit(changed);
            expect(host.methods.validatePreparedFocusOrder(changed))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        };
        invalid((value) => { value.prepared.effect.tasks[0].after.title = 'forged'; });
        invalid((value) => { value.prepared.scope.tasks[0].title = 'forged'; });
        invalid((value) => { value.prepared.result.ids = ['a', 'b']; });
        invalid((value) => { value.request.ids = ['a', 'a']; });
        invalid((value) => { value.request.requestId = 'BAD'; });
        invalid((value) => { (value.prepared as object as Record<string, unknown>).extra = true; });
        invalid((value) => { value.prepared.scope.tasks[0].description = 'x'.repeat(800_000); });
        expect(host.methods.probeFocusOrderOutcome(request)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(host.methods.prepareFocusOrder(host.request(['a', 'b'])))
            .toEqual({ ok: true, value: { kind: 'noop', result: { ids: ['a', 'b'] } } });
        expect(host.saves()).toBe(0);
    });

    it('lets a parent rename through when all visible rows remain eligible', async () => {
        const host = await open({ tasks: [task('a', { projectId: 'project', focusOrder: 0 }),
            task('b', { focusOrder: 1 })], projects: [project()] });
        const request = host.request();
        const planned = host.methods.prepareFocusOrder(request);
        if (!planned.ok || planned.value.kind !== 'prepared') throw new Error(JSON.stringify(planned));
        useTaskStore.setState({ _allProjects: [project({ title: 'Renamed parent' })] });
        expect(await host.methods.commitPreparedFocusOrder({ request, prepared: planned.value.prepared }))
            .toEqual({ ok: true, value: { ids: ['b', 'a'] } });
    });

    it('honors sort/filter gates and refuses a list over 100 without truncation', async () => {
        const host = await open();
        const sortedControls = { ...DEFAULT_FOCUS_CONTROL_STATE, sortBy: 'due' as const };
        expect(host.methods.getFocusOrderOptions({ controls: sortedControls }))
            .toMatchObject({ ok: true, value: { canReorder: false, rows: [] } });
        const filtered = { ...DEFAULT_FOCUS_CONTROL_STATE,
            filters: { ...DEFAULT_FOCUS_CONTROL_STATE.filters, tokens: ['@work'] } };
        expect(host.methods.getFocusOrderOptions({ controls: filtered }))
            .toMatchObject({ ok: true, value: { canReorder: false, rows: [] } });
        useTaskStore.setState({ _allTasks: Array.from({ length: 101 }, (_, index) => task(`t${index}`)) });
        expect(host.methods.getFocusOrderOptions({ controls: DEFAULT_FOCUS_CONTROL_STATE }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });
});
