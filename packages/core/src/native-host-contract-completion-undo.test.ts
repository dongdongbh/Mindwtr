import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeHostContract } from './native-host-contract';
import { taskRevisionOf } from './native-request-receipts';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Task } from './types';

// RN cafdac02d (#834) and efd0d8ac8 (#1051): every completion shows "{title} marked Done" with Undo, and Undo puts the
// task back in its status (and its Today star). The native contract completed a task with nothing to undo it with.
const T0 = '2026-09-01T00:00:00.000Z';
const task = (fields: Partial<Task> = {}): Task => ({
    id: 't1', title: 'Water the plants', status: 'next', tags: [], contexts: [], isFocusedToday: true,
    createdAt: T0, updatedAt: T0, rev: 2, revBy: 'phone', ...fields,
});

describe('native task completion Undo', () => {
    let durable: AppData;
    let host: ReturnType<typeof createNativeHostContract>;
    const stored = () => useTaskStore.getState()._tasksById.get('t1')!;

    beforeEach(async () => {
        durable = { tasks: [task()], projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'phone' } };
        setStorageAdapter({ getData: async () => structuredClone(durable), saveData: async (data) => { durable = structuredClone(data); } });
        resetForTests();
        host = createNativeHostContract();
        expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
        await flushPendingSave();
    });
    afterEach(async () => {
        await flushPendingSave();
        resetForTests();
        vi.restoreAllMocks();
    });

    const complete = async () => {
        const result = await host.completeTask({ id: 't1', taskRevision: taskRevisionOf(stored()) });
        if (!result.ok) throw new Error(result.error.message);
        return result.value as { id: string; undo?: { previousStatus: string; wasFocusedToday: boolean; taskRevision: string }; toast?: { message: string; undoLabel: string } };
    };

    it('answers a completion with RN\'s toast and what its Undo needs', async () => {
        const done = await complete();

        expect(stored().status).toBe('done');
        expect(done.toast).toEqual({ message: 'Water the plants marked Done', undoLabel: 'Undo' });
        expect(done.undo).toEqual({ previousStatus: 'next', wasFocusedToday: true, taskRevision: taskRevisionOf(stored()) });
    });

    it('puts the task back in its status with its Today star, and a repeat changes nothing', async () => {
        const done = await complete();

        expect(await host.undoTaskCompletion({ id: 't1', ...done.undo! })).toEqual({ ok: true, value: { id: 't1' } });
        expect(stored()).toEqual(expect.objectContaining({ status: 'next', isFocusedToday: true }));
        const after = taskRevisionOf(stored());
        expect(await host.undoTaskCompletion({ id: 't1', ...done.undo! })).toEqual({ ok: true, value: { id: 't1' } });
        expect(taskRevisionOf(stored())).toBe(after);
    });

    it('refuses an Undo once the task changed after it was marked done', async () => {
        const done = await complete();
        await useTaskStore.getState().updateTask('t1', { title: 'Water the garden' });

        expect(await host.undoTaskCompletion({ id: 't1', ...done.undo! })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(stored().status).toBe('done');
    });

    it('offers no Undo for a task that was already done', async () => {
        await complete();
        const again = await complete();

        expect(again.undo).toBeUndefined();
        expect(again.toast).toBeUndefined();
    });
});
