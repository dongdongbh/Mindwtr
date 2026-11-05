import { flushPendingSave, useTaskStore } from './store';
import { runAfterStoreWriteLock } from './data-transfer-transaction';
import { runStoreCommand } from './store-write-gate';
import type { Task } from './types';

type UndoResult = { success: true } | { success: false; error?: string; retryable: boolean };


export const taskCancellationRestoreFields = (before: Task): Partial<Task> => ({
    status: before.status,
    cancelledAt: before.cancelledAt,
    completedAt: before.completedAt,
    isFocusedToday: before.isFocusedToday,
    focusOrder: before.focusOrder,
    boardOrder: before.boardOrder,
});


export function createTaskCancellationUndo(before: Task, cancelledAt: string | undefined): () => Promise<UndoResult> {
    const restoreFields = taskCancellationRestoreFields(before);
    let written = false;
    let retryPersistence = false;
    let finished = false;
    let inFlight: Promise<UndoResult> | null = null;

    const matchesRestoredFields = (task: Task | undefined): boolean => !!task
        && !task.deletedAt && !task.purgedAt
        && Object.entries(restoreFields).every(([key, value]) => task[key as keyof Task] === value);
    const isStillRestored = (task: Task | undefined): boolean => !!task
        && !task.deletedAt && !task.purgedAt
        && task.status === before.status
        && task.cancelledAt === before.cancelledAt
        && task.completedAt === before.completedAt;


    const restore = (): Promise<UndoResult | null> => runStoreCommand(async () => {
        const current = useTaskStore.getState()._tasksById.get(before.id);
        if (!cancelledAt || !current || current.deletedAt || current.purgedAt
            || current.status !== 'archived' || current.cancelledAt !== cancelledAt) {
            return { success: false, retryable: false };
        }
        let applied = false;
        try {
            const write = useTaskStore.getState().updateTask(before.id, restoreFields);


            const immediate = useTaskStore.getState()._tasksById.get(before.id);
            applied = immediate !== current && matchesRestoredFields(immediate);
            const result = await write;
            written = result.success;
            if (!result.success) {
                written = applied || matchesRestoredFields(useTaskStore.getState()._tasksById.get(before.id));
                retryPersistence = written;
                return { success: false, error: result.error, retryable: true };
            }
        } catch (error) {
            written = applied || matchesRestoredFields(useTaskStore.getState()._tasksById.get(before.id));
            retryPersistence = written;
            return { success: false, error: error instanceof Error ? error.message : undefined, retryable: true };
        }
        return null;
    });

    const run = (): Promise<UndoResult> => runAfterStoreWriteLock(async () => {
        if (finished) return { success: true };
        if (!written) {
            const stopped = await restore();
            if (stopped) return stopped;
        }
        try {
            if (!isStillRestored(useTaskStore.getState()._tasksById.get(before.id))) {
                return { success: false, retryable: false };
            }
            if (retryPersistence) await useTaskStore.getState().persistSnapshot();
            await flushPendingSave();
            if (!isStillRestored(useTaskStore.getState()._tasksById.get(before.id))) {
                return { success: false, retryable: false };
            }
            finished = true;
            return { success: true };
        } catch (error) {


            retryPersistence = true;
            return { success: false, error: error instanceof Error ? error.message : undefined, retryable: true };
        }
    });
    return () => {
        if (inFlight) return inFlight;
        inFlight = run().finally(() => { inFlight = null; });
        return inFlight;
    };
}
