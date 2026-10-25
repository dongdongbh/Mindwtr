import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeHostContract } from './native-host-contract';
import { taskRevisionOf, type NativeReplayTokens } from './native-request-receipts';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Task } from './types';
import { generateUUID } from './uuid';

const T0 = '2026-09-01T00:00:00.000Z';
const task = (id: string): Task => ({ id, title: id, status: 'next', createdAt: T0, updatedAt: T0, rev: 7 });

describe('native host replay tokens', () => {
    let durable: AppData;
    let saveData: ReturnType<typeof vi.fn>;
    const stored = (id = 'a') => useTaskStore.getState()._tasksById.get(id)!;
    const persist = async (data: AppData) => { durable = structuredClone(data); };
    const open = async (replayTokens?: NativeReplayTokens) => {
        durable = { tasks: [task('a'), task('b')], projects: [], sections: [], areas: [], people: [], settings: {} };
        saveData = vi.fn(persist);
        setStorageAdapter({ getData: async () => structuredClone(durable), saveData });
        resetForTests();
        useTaskStore.setState({
            _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
            settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
        });
        const host = createNativeHostContract(replayTokens ? { replayTokens } : {});
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        await flushPendingSave();
        saveData.mockClear();
        return host;
    };
    afterEach(async () => {
        saveData.mockImplementation(persist);
        await flushPendingSave();
        resetForTests();
        vi.restoreAllMocks();
    });

    it('required (the journaling Android host): a write without its tokens is refused and writes nothing', async () => {
        const host = await open('required');
        const before = stored();
        expect(await host.completeTask({ id: 'a' } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.saveTaskDraft({ id: 'a', base: { title: 'a' }, patch: { title: 'Mine' } })).toEqual({
            ok: false, error: { code: 'INVALID_INPUT', message: 'A request UUID is required' },
        });
        expect(stored()).toBe(before);
        expect(saveData).not.toHaveBeenCalled();
    });

    it('optional (the default): a completion without its revision completes, as before journaling', async () => {
        const host = await open();
        expect(await host.completeTask({ id: 'a' } as never)).toMatchObject({ ok: true, value: { id: 'a' } });
        expect(stored()).toMatchObject({ status: 'done', rev: 8 });
        // A revision it sends is still checked.
        const b = taskRevisionOf(stored('b'));
        expect((await useTaskStore.getState().updateTask('b', { title: 'Other writer' })).success).toBe(true);
        expect(await host.completeTask({ id: 'b', taskRevision: b })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(stored('b').status).toBe('next');
    });

    it.each(['required', 'optional'] as const)('the Trash selection carries its revisions only while tokens are required: %s', async (mode) => {
        const host = await open(mode);
        expect((await useTaskStore.getState().deleteTask('a')).success).toBe(true);
        const view = host.getTrashView({ selected: { taskIds: ['a'], projectIds: [] }, offset: 0, limit: 10 });
        if (!view.ok) throw new Error(view.error.message);
        expect(view.value.selected).toEqual(mode === 'required'
            ? { taskIds: ['a'], projectIds: [], taskRevisions: { a: taskRevisionOf(stored()) }, projectRevisions: {} }
            : { taskIds: ['a'], projectIds: [] });
    });

    it('optional: a draft save without a request UUID saves, and its retry after a failed save only saves', async () => {
        const host = await open();
        const input = { id: 'a', base: { title: 'a' }, patch: { title: 'Mine' } };
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.saveTaskDraft(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        const applied = stored();
        expect(applied).toMatchObject({ title: 'Mine', rev: 8 });
        saveData.mockImplementation(persist);
        saveData.mockClear();
        expect(await host.saveTaskDraft(input)).toMatchObject({ ok: true, value: { id: 'a', draft: { title: 'Mine' } } });
        expect(stored()).toBe(applied);
        expect(saveData).toHaveBeenCalledTimes(1);
        // A request UUID it sends still answers from its receipt.
        const withRequest = { id: 'b', base: { title: 'b' }, patch: { title: 'Yours' }, requestId: generateUUID() };
        expect(await host.saveTaskDraft(withRequest)).toMatchObject({ ok: true });
        const saved = stored('b');
        expect(await host.saveTaskDraft(withRequest)).toMatchObject({ ok: true, value: { draft: { title: 'Yours' } } });
        expect(stored('b')).toBe(saved);
    });
});
