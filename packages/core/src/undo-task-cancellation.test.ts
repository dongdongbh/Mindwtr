import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runSerializedSyncDocumentWriteOperation } from './data-transfer-transaction';
import { runStoreCommand, runSyncStoreSave } from './store-write-gate';
import type { Task } from './types';
import { createTaskCancellationUndo } from './undo-task-cancellation';

const mocks = vi.hoisted(() => ({ state: null as any, flush: vi.fn() }));
vi.mock('./store', () => ({
    useTaskStore: { getState: () => mocks.state },
    flushPendingSave: mocks.flush,
}));

const cancelledAt = '2026-09-24T12:00:00.000Z';
const before: Task = {
    id: 'task-1', title: 'Plan launch', status: 'next', tags: [], contexts: [],
    isFocusedToday: true, focusOrder: 3, boardOrder: 7,
    recurrence: { rule: 'daily', strategy: 'strict' },
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
};

describe('createTaskCancellationUndo', () => {
    beforeEach(() => {
        const cancelled: Task = {
            ...before, status: 'archived', cancelledAt,
            isFocusedToday: false, focusOrder: undefined, boardOrder: undefined,
        };
        mocks.flush.mockReset().mockResolvedValue(undefined);
        mocks.state = {
            _tasksById: new Map([[before.id, cancelled]]),
            updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
                const current = mocks.state._tasksById.get(id)!;
                mocks.state._tasksById.set(id, { ...current, ...patch });
                return { success: true };
            }),
            persistSnapshot: vi.fn().mockResolvedValue(undefined),
        };
    });

    it('restores only cancellation fields, retaining later edits and recurrence', async () => {
        const undo = createTaskCancellationUndo(before, cancelledAt);
        mocks.state._tasksById.set(before.id, { ...mocks.state._tasksById.get(before.id), description: 'Later edit' });

        expect(await undo()).toEqual({ success: true });
        expect(mocks.state.updateTask).toHaveBeenCalledExactlyOnceWith(before.id, {
            status: 'next', cancelledAt: undefined, completedAt: undefined,
            isFocusedToday: true, focusOrder: 3, boardOrder: 7,
        });
        expect(mocks.state._tasksById.get(before.id)).toMatchObject({
            status: 'next', description: 'Later edit', isFocusedToday: true,
            recurrence: before.recurrence,
        });
        expect(mocks.flush).toHaveBeenCalledOnce();
        expect(await undo()).toEqual({ success: true });
        expect(mocks.state.updateTask).toHaveBeenCalledOnce();
    });

    it.each([
        ['superseded', { cancelledAt: '2026-09-25T12:00:00.000Z' }],
        ['deleted', { deletedAt: cancelledAt }],
        ['purged', { purgedAt: cancelledAt }],
    ])('rejects a %s cancellation before mutation', async (_case, patch) => {
        mocks.state._tasksById.set(before.id, { ...mocks.state._tasksById.get(before.id), ...patch });
        const undo = createTaskCancellationUndo(before, cancelledAt);
        expect(await undo()).toEqual({ success: false, retryable: false });
        expect(mocks.state.updateTask).not.toHaveBeenCalled();
    });

    it('checks the cancelled row on the state a sync save published while the Undo waited', async () => {
        // updateTask as the store runs it: a command behind the write gate.
        const apply = mocks.state.updateTask;
        mocks.state.updateTask = vi.fn((id: string, patch: Partial<Task>) => runStoreCommand(() => apply(id, patch)));
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        // Another device moved the task on; the sync save publishes it before the Undo is admitted.
        const save = runSyncStoreSave(async () => {
            await held;
            mocks.state._tasksById.set(before.id, { ...mocks.state._tasksById.get(before.id), status: 'waiting', cancelledAt: undefined });
        });
        const undo = createTaskCancellationUndo(before, cancelledAt)();
        release();
        await save;
        expect(await undo).toEqual({ success: false, retryable: false });
        expect(mocks.state._tasksById.get(before.id).status).toBe('waiting');
    });

    it('retries a failed mutation when no restore was applied', async () => {
        mocks.state.updateTask = vi.fn()
            .mockResolvedValueOnce({ success: false, error: 'save refused' })
            .mockImplementationOnce(async (id: string, patch: Partial<Task>) => {
                mocks.state._tasksById.set(id, { ...mocks.state._tasksById.get(id), ...patch });
                return { success: true };
            });
        const undo = createTaskCancellationUndo(before, cancelledAt);
        expect(await undo()).toEqual({ success: false, error: 'save refused', retryable: true });
        expect(await undo()).toEqual({ success: true });
        expect(mocks.state.updateTask).toHaveBeenCalledTimes(2);
    });

    it('requeues the latest state after failed persistence without repeating the restore', async () => {
        mocks.flush.mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce(undefined);
        const undo = createTaskCancellationUndo(before, cancelledAt);
        expect(await undo()).toEqual({ success: false, error: 'disk full', retryable: true });
        const afterFirstWrite = mocks.state._tasksById.get(before.id);
        mocks.state._tasksById.set(before.id, {
            ...afterFirstWrite, title: 'Later title', isFocusedToday: false,
            focusOrder: undefined, boardOrder: 12,
        });

        expect(await undo()).toEqual({ success: true });
        expect(mocks.state.updateTask).toHaveBeenCalledOnce();
        expect(mocks.state.persistSnapshot).toHaveBeenCalledOnce();
        expect(mocks.state._tasksById.get(before.id).title).toBe('Later title');
        expect(mocks.state._tasksById.get(before.id).boardOrder).toBe(12);
        expect(mocks.state._tasksById.get(before.id).isFocusedToday).toBe(false);
    });

    it.each([
        ['recancelled', { status: 'archived', cancelledAt: '2026-09-25T12:00:00.000Z' }],
        ['deleted', { deletedAt: cancelledAt }],
    ])('rejects a persistence retry after another writer %s the task', async (_case, patch) => {
        mocks.flush.mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce(undefined);
        const undo = createTaskCancellationUndo(before, cancelledAt);
        expect(await undo()).toEqual({ success: false, error: 'disk full', retryable: true });
        mocks.state._tasksById.set(before.id, { ...mocks.state._tasksById.get(before.id), ...patch });

        expect(await undo()).toEqual({ success: false, retryable: false });
        expect(mocks.state.updateTask).toHaveBeenCalledOnce();
        expect(mocks.state.persistSnapshot).not.toHaveBeenCalled();
        expect(mocks.flush).toHaveBeenCalledOnce();
    });

    it('rejects success when another writer supersedes the restore during persistence', async () => {
        mocks.flush.mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce(undefined);
        const undo = createTaskCancellationUndo(before, cancelledAt);
        expect(await undo()).toMatchObject({ success: false, retryable: true });
        mocks.state.persistSnapshot = vi.fn(async () => {
            mocks.state._tasksById.set(before.id, {
                ...mocks.state._tasksById.get(before.id), status: 'archived', cancelledAt,
            });
        });

        expect(await undo()).toEqual({ success: false, retryable: false });
        expect(mocks.state.updateTask).toHaveBeenCalledOnce();
        expect(mocks.state.persistSnapshot).toHaveBeenCalledOnce();
    });

    it('checks cancellation after a queued transfer write finishes', async () => {
        let releaseTransfer!: () => void;
        let transferStarted!: () => void;
        const transferGate = new Promise<void>((resolve) => { releaseTransfer = resolve; });
        const started = new Promise<void>((resolve) => { transferStarted = resolve; });
        const transfer = runSerializedSyncDocumentWriteOperation(async () => {
            transferStarted();
            await transferGate;
            mocks.state._tasksById.set(before.id, {
                ...mocks.state._tasksById.get(before.id), cancelledAt: '2026-09-25T12:00:00.000Z',
            });
        });
        await started;
        const undo = createTaskCancellationUndo(before, cancelledAt);
        const pending = undo();
        expect(mocks.state.updateTask).not.toHaveBeenCalled();
        releaseTransfer();
        await transfer;
        expect(await pending).toEqual({ success: false, retryable: false });
        expect(mocks.state.updateTask).not.toHaveBeenCalled();
    });

    it('does not repeat a synchronous optimistic write whose promise rejects', async () => {
        mocks.state.updateTask = vi.fn((id: string, patch: Partial<Task>) => {
            mocks.state._tasksById.set(id, { ...mocks.state._tasksById.get(id), ...patch });
            return Promise.reject(new Error('save rejected'));
        });
        const undo = createTaskCancellationUndo(before, cancelledAt);
        expect(await undo()).toEqual({ success: false, error: 'save rejected', retryable: true });
        expect(await undo()).toEqual({ success: true });
        expect(mocks.state.updateTask).toHaveBeenCalledOnce();
        expect(mocks.state.persistSnapshot).toHaveBeenCalledOnce();
    });

    it('does not repeat a delayed optimistic write whose promise rejects', async () => {
        mocks.state.updateTask = vi.fn(async (id: string, patch: Partial<Task>) => {
            await Promise.resolve();
            mocks.state._tasksById.set(id, { ...mocks.state._tasksById.get(id), ...patch });
            throw new Error('delayed save rejected');
        });
        const undo = createTaskCancellationUndo(before, cancelledAt);
        expect(await undo()).toEqual({ success: false, error: 'delayed save rejected', retryable: true });
        expect(await undo()).toEqual({ success: true });
        expect(mocks.state.updateTask).toHaveBeenCalledOnce();
        expect(mocks.state.persistSnapshot).toHaveBeenCalledOnce();
    });
});
