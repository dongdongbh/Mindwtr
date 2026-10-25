import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeHostContract } from './native-host-contract';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Task } from './types';
import { generateUUID } from './uuid';

// RN 23e2102b3, 3b1a3f4f4 and 376c562b5: each Process Inbox decision's toast offers Undo, bound to a receipt of the item as
// it was before the decision. Undo puts a discarded item back, restores a filed item's fields, and is refused when another
// device changed the item since. The native session's commit (Android's path) answered the toast with no Undo.
const T0 = '2026-09-01T00:00:00.000Z';
const inboxTask = (): Task => ({
    id: 'inbox-a', title: 'Call the plumber', status: 'inbox', contexts: [], tags: [],
    createdAt: T0, updatedAt: T0, rev: 1, revBy: 'phone',
});

describe('native Process Inbox decision Undo', () => {
    let durable: AppData;
    let host: ReturnType<typeof createNativeHostContract>;
    const stored = () => useTaskStore.getState()._tasksById.get('inbox-a')!;

    beforeEach(async () => {
        durable = { tasks: [inboxTask()], projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'phone' } };
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

    const session = () => {
        const started = host.startInboxProcessing({ mode: 'guided' });
        if (!started.ok || !started.value.sessionId) throw new Error('Process Inbox did not start');
        return started.value.sessionId;
    };
    const commit = async (sessionId: string, step: string, choice: string) => {
        const result = await host.commitInboxProcessingStep({ sessionId, taskId: 'inbox-a', step, decision: { choice }, requestId: generateUUID() });
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
    };
    // The receipt crosses the Kotlin bridge as JSON, so the tests send it the same way (an undefined field is dropped there).
    const wire = <T,>(receipt: T): T => JSON.parse(JSON.stringify(receipt));
    const fileLater = async () => {
        const sessionId = session();
        await commit(sessionId, 'actionable', 'later');
        expect(host.getInboxProcessingStep({ sessionId, taskId: 'inbox-a', step: 'later', edit: { type: 'setPickedDate', field: 'startTime', day: '2026-10-05' } }))
            .toMatchObject({ ok: true });
        return commit(sessionId, 'later', 'fileIt');
    };

    it('offers Undo with each committed decision, and Undo puts a discarded item back', async () => {
        const discarded = await commit(session(), 'actionable', 'trash');
        const undo = discarded.toast?.undoReceipt;

        expect(discarded.toast).toEqual(expect.objectContaining({ undoLabel: 'Undo', undoReceipt: expect.objectContaining({ taskId: 'inbox-a', kind: 'discarded' }) }));
        expect(stored().deletedAt).toBeTruthy();
        expect(await host.undoInboxDecision(wire(undo!))).toEqual({ ok: true, value: { taskId: 'inbox-a' } });
        expect(stored().deletedAt).toBeUndefined();
    });

    // A journal replay after a kill sends the same receipt again: the second Undo must change nothing.
    it('changes nothing when the same receipt is sent again', async () => {
        const discarded = await commit(session(), 'actionable', 'trash');
        expect(await host.undoInboxDecision(wire(discarded.toast!.undoReceipt!))).toMatchObject({ ok: true });
        const once = structuredClone(stored());
        expect(await host.undoInboxDecision(wire(discarded.toast!.undoReceipt!))).toMatchObject({ ok: true });
        expect(stored()).toEqual(once);

        const filed = await fileLater();
        expect(await host.undoInboxDecision(wire(filed.toast!.undoReceipt!))).toMatchObject({ ok: true });
        const restored = structuredClone(stored());
        expect(await host.undoInboxDecision(wire(filed.toast!.undoReceipt!))).toMatchObject({ ok: true });
        expect(stored()).toEqual(restored);
    });

    it('restores a filed item\'s fields', async () => {
        const filed = await fileLater();
        expect(stored().startTime).toBe('2026-10-05');

        expect(await host.undoInboxDecision(wire(filed.toast!.undoReceipt!))).toEqual({ ok: true, value: { taskId: 'inbox-a' } });
        expect(stored()).toEqual(expect.objectContaining({ status: 'inbox' }));
        expect(stored().startTime).toBeUndefined();
    });

    it('refuses Undo once another device changed the item since', async () => {
        const filed = await fileLater();
        await flushPendingSave();
        durable = { ...durable, tasks: durable.tasks.map((item) => (item.id === 'inbox-a'
            ? { ...item, title: 'Call the plumber today', rev: (item.rev ?? 0) + 5, revBy: 'desktop' } : item)) };
        await useTaskStore.getState().fetchData({ throwOnError: true });

        expect(await host.undoInboxDecision(wire(filed.toast!.undoReceipt!))).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(stored().startTime).toBe('2026-10-05');
    });
});
