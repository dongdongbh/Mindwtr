import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTaskFocusMethods, type NativeTaskFocusRequest } from './native-host-contract-task-focus';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Project, Task } from './types';

const stamp = '2026-09-01T12:00:00.000Z';
const task = (id = 'target', extra: Partial<Task> = {}): Task => ({ id, title: id, status: 'next',
    tags: [], contexts: [], rev: 3, revBy: 'prior', createdAt: stamp, updatedAt: stamp, ...extra });
const project = (extra: Partial<Project> = {}): Project => ({ id: 'project', title: 'Project',
    status: 'active', order: 0, color: '#123456', tagIds: [], createdAt: stamp, updatedAt: stamp, ...extra });
const sortedJson = <T>(value: T): T => {
    const sort = (part: unknown): unknown => Array.isArray(part) ? part.map(sort)
        : part && typeof part === 'object' ? Object.fromEntries(Object.entries(part)
            .sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, sort(nested)])) : part;
    return JSON.parse(JSON.stringify(sort(value))) as T;
};

async function open(initial: Partial<AppData> = {}, fails?: () => boolean) {
    resetForTests();
    let stored: AppData = { tasks: [task(), task('unrelated', { description: 'Retain' })], projects: [],
        sections: [], areas: [], people: [], settings: { deviceId: 'focus-device' }, ...initial };
    let saves = 0;
    setStorageAdapter({ getData: async () => stored, saveData: async (next) => {
        if (fails?.()) throw new Error('disk unavailable');
        stored = structuredClone(next); saves++;
    } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0,
        lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    const methods = createTaskFocusMethods({ readiness: () => ({ ok: true, value: null }),
        save: async () => {
            try { await flushPendingSave(); return { ok: true as const, value: null }; }
            catch (error) { return { ok: false as const, error: { code: 'SAVE_FAILED' as const,
                message: error instanceof Error ? error.message : String(error) } }; }
        }, revision: () => 'revision', t: () => (key) => key });
    const request = (focused = true): NativeTaskFocusRequest => {
        const options = methods.getTaskFocusOptions({ taskId: 'target' });
        if (!options.ok) throw new Error(JSON.stringify(options));
        const { id: _id, ...expected } = options.value.task;
        return { requestId: 'e2f841a9-fbee-4d80-84d0-c4de923a12bc', taskId: 'target', focused, expected };
    };
    return { methods, request, stored: () => stored, saves: () => saves };
}

afterEach(async () => { vi.useRealTimers(); await flushPendingSave().catch(() => undefined); resetForTests(); });

describe('prepared native Task Focus durable replay', () => {
    it('retries a failed save using the exact command, then receipts without a second revision', async () => {
        let failing = true;
        const host = await open({ settings: {} }, () => failing);
        useTaskStore.setState({ settings: {} });
        const request = host.request();
        const planned = host.methods.prepareTaskFocus(request);
        if (!planned.ok || planned.value.kind !== 'prepared') throw new Error(JSON.stringify(planned));
        const envelope = sortedJson({ request, prepared: planned.value.prepared });
        expect(envelope.prepared.deviceIdBefore).toBeNull();
        expect(host.methods.validatePreparedTaskFocus(envelope)).toEqual({ ok: true,
            value: { id: 'target', focused: true } });
        expect(await host.methods.commitPreparedTaskFocus(envelope)).toMatchObject({ ok: false,
            error: { code: 'SAVE_FAILED' } });
        expect(host.stored().tasks[0].isFocusedToday).toBeUndefined();
        failing = false;
        expect(await host.methods.commitPreparedTaskFocus(envelope)).toEqual({ ok: true,
            value: { id: 'target', focused: true } });
        expect(host.stored().tasks[0]).toEqual(envelope.prepared.effect.task.after);
        expect(host.stored().tasks[0].rev).toBe(4);
        expect(host.stored().settings.deviceId).toBe(envelope.prepared.deviceIdToInitialize);
        const count = host.saves();
        expect(await host.methods.commitPreparedTaskFocus(envelope)).toMatchObject({ ok: true });
        expect(host.saves()).toBe(count);
    });

    it('cold-applies a before-row journal and receipts an after-row before mutable parent context', async () => {
        const initial = { tasks: [task('target', { projectId: 'project' }), task('unrelated')],
            projects: [project()] };
        const first = await open(initial);
        const request = first.request();
        const planned = first.methods.prepareTaskFocus(request);
        if (!planned.ok || planned.value.kind !== 'prepared') throw new Error(JSON.stringify(planned));
        const envelope = sortedJson({ request, prepared: planned.value.prepared });
        const cold = await open(structuredClone(first.stored()));
        expect(cold.methods.validatePreparedTaskFocus(envelope)).toMatchObject({ ok: true });
        expect(await cold.methods.commitPreparedTaskFocus(envelope)).toEqual({ ok: true,
            value: { id: 'target', focused: true } });
        expect(cold.stored().tasks[0]).toEqual(envelope.prepared.effect.task.after);
        const after = await open(structuredClone(cold.stored()));
        expect(useTaskStore.getState()._allTasks.find((row) => row.id === 'target'))
            .toMatchObject(envelope.prepared.effect.task.after);
        useTaskStore.setState((state) => ({ _allProjects: [{ ...state._allProjects[0],
            title: 'Renamed after receipt', isSequential: true }],
        _allTasks: [...state._allTasks, task('extra', { isFocusedToday: true })],
        settings: { ...state.settings, gtd: { focusTaskLimit: 1 } } }));
        const count = after.saves();
        const beforeReplay = structuredClone(after.stored());
        expect(await after.methods.commitPreparedTaskFocus(envelope)).toEqual({ ok: true,
            value: { id: 'target', focused: true } });
        expect(after.saves()).toBe(count);
        expect(after.stored()).toEqual(beforeReplay);
    });

    it('receipts a lost acknowledgment after a later device ID change without restoring the old ID', async () => {
        const first = await open({ settings: {} });
        useTaskStore.setState({ settings: {} });
        const request = first.request();
        const planned = first.methods.prepareTaskFocus(request);
        if (!planned.ok || planned.value.kind !== 'prepared') throw new Error(JSON.stringify(planned));
        const envelope = sortedJson({ request, prepared: planned.value.prepared });
        expect(envelope.prepared.deviceIdBefore).toBeNull();
        expect(await first.methods.commitPreparedTaskFocus(envelope)).toEqual({ ok: true,
            value: { id: 'target', focused: true } });
        expect(first.stored().tasks[0]).toEqual(envelope.prepared.effect.task.after);
        expect(first.stored().settings.deviceId).toBe(envelope.prepared.deviceIdToInitialize);


        const later = structuredClone(first.stored());
        later.settings.deviceId = 'later-device';
        const cold = await open(later);
        await flushPendingSave();
        const count = cold.saves();
        const beforeReplay = structuredClone(cold.stored());
        expect(await cold.methods.commitPreparedTaskFocus(envelope)).toEqual({ ok: true,
            value: { id: 'target', focused: true } });
        expect(cold.saves()).toBe(count);
        expect(cold.stored()).toEqual(beforeReplay);
        expect(cold.stored().settings.deviceId).toBe('later-device');
        expect(cold.stored().tasks[0].rev).toBe(4);
    });

    it('refuses first apply after a target or contextual CAS change, without writing', async () => {
        const initial = { tasks: [task('target', { projectId: 'project' }), task('unrelated')],
            projects: [project()] };
        const host = await open(initial);
        const request = host.request();
        const planned = host.methods.prepareTaskFocus(request);
        if (!planned.ok || planned.value.kind !== 'prepared') throw new Error(JSON.stringify(planned));
        const envelope = { request, prepared: planned.value.prepared };
        useTaskStore.setState((state) => ({ _allTasks: state._allTasks.map((row) => row.id === 'target'
            ? { ...row, title: 'Concurrent rename', rev: 4 } : row) }));
        expect(await host.methods.commitPreparedTaskFocus(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        useTaskStore.setState({ _allTasks: initial.tasks,
            _allProjects: [project({ isSequential: true })] });
        expect(await host.methods.commitPreparedTaskFocus(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(host.saves()).toBe(0);
    });

    it('rejects forged, malformed, and oversized envelopes before a write', async () => {
        const host = await open();
        const request = host.request();
        const planned = host.methods.prepareTaskFocus(request);
        if (!planned.ok || planned.value.kind !== 'prepared') throw new Error(JSON.stringify(planned));
        const envelope = sortedJson({ request, prepared: planned.value.prepared });
        const verifyInvalid = (mutate: (value: typeof envelope) => void) => {
            const changed = structuredClone(envelope); mutate(changed);
            expect(host.methods.validatePreparedTaskFocus(changed)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
        };
        verifyInvalid((value) => { value.prepared.effect.task.after.title = 'Forged'; });
        verifyInvalid((value) => { value.prepared.result.focused = false; });
        verifyInvalid((value) => { value.request.requestId = 'not-a-uuid'; });
        verifyInvalid((value) => { (value.prepared as object as Record<string, unknown>).extra = true; });
        verifyInvalid((value) => { delete (value.prepared as object as Record<string, unknown>).dates; });
        verifyInvalid((value) => { value.prepared.scope.task.description = 'x'.repeat(800_000); });
        expect(host.methods.probeTaskFocusOutcome(request)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(host.saves()).toBe(0);
    });
});
