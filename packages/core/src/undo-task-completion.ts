import { normalizeFocusTaskLimit } from './focus-utils';
import { formatI18nTemplate, translateWithFallback } from './i18n';
import { useTaskStore } from './store';
import { logStaleWriteRefused } from './store-latest-updates';
import { runStoreCommand } from './store-write-gate';
import type { Task, TaskStatus } from './types';

type TranslateFn = (key: string) => string;

// One copy of the completion/move toast text for every surface that completes a
// task on either platform: keyboard scopes, the row's own done button, the status
// chord, mobile search. The copies had already drifted, one of them untranslated.
// The single/double brace split follows the keys as they already ship.
export function formatTaskMarkedDoneMessage(t: TranslateFn, title: string): string {
    return formatI18nTemplate(translateWithFallback(t, 'task.markedDone', '{title} marked Done'), { title });
}

export function formatTaskMovedMessage(t: TranslateFn, title: string, status: TaskStatus): string {
    return formatI18nTemplate(translateWithFallback(t, 'task.movedToStatus', '{{title}} moved to {{status}}'), {
        title,
        status: translateWithFallback(t, `status.${status}`, status),
    });
}

const STALE_RESTORE = 'STALE_REVISION: The task changed on another device after this action; it was not undone';

/**
 * Whether another device wrote [taskId] after this device's last write: a restore of the fields this device saw then
 * would overwrite what sync brought since. SQLite refused that lower-revision write before the store write gate.
 */
const changedElsewhere = (taskId: string): boolean => {
    const state = useTaskStore.getState();
    const task = state._tasksById.get(taskId);
    const deviceId = state.settings.deviceId;
    const changed = Boolean(task?.revBy && deviceId && task.revBy !== deviceId);
    if (changed) logStaleWriteRefused('undo-restore');
    return changed;
};

/** Undo's restore of a task's saved fields ([restoreUpdates]), refused when another device changed the task since. */
export function restoreTaskSnapshot(taskId: string, restoreUpdates: Partial<Task>) {
    return runStoreCommand(async () => (changedElsewhere(taskId)
        ? { success: false, error: STALE_RESTORE }
        : useTaskStore.getState().updateTask(taskId, restoreUpdates)));
}

// Completing a task force-clears its Today star (applyTaskUpdates), so
// undoing a completion must restore the star along with the status. The star
// only comes back while the focus cap has room — same rule as starring by hand.
// One store command reads the task and restores it (store-write-gate.ts).
export function undoTaskCompletion(
    taskId: string,
    previousStatus: TaskStatus,
    wasFocusedToday: boolean,
    options: { restoreUpdates?: Partial<Task> } = {},
): Promise<void> {
    return runStoreCommand(() => undoTaskCompletionNow(taskId, previousStatus, wasFocusedToday, options));
}

async function undoTaskCompletionNow(
    taskId: string,
    previousStatus: TaskStatus,
    wasFocusedToday: boolean,
    options: { restoreUpdates?: Partial<Task> },
): Promise<void> {
    if (options.restoreUpdates && changedElsewhere(taskId)) throw new Error(STALE_RESTORE);
    const state = useTaskStore.getState();
    const completedTask = state._allTasks.find((task) => task.id === taskId);
    const recurrence = completedTask?.recurrence;
    const seriesId = recurrence && typeof recurrence === 'object'
        ? recurrence.seriesId?.trim() || taskId
        : typeof recurrence === 'string'
            ? taskId
            : undefined;
    const generatedOccurrence = seriesId && completedTask?.completedAt
        ? state._allTasks.find((task) => (
            task.id !== taskId
            && !task.deletedAt
            && task.createdAt === completedTask.completedAt
            && task.recurrence
            && typeof task.recurrence === 'object'
            && task.recurrence.seriesId === seriesId
        ))
        : undefined;

    if (generatedOccurrence) {
        const deleteResult = await Promise.resolve(state.deleteTask(generatedOccurrence.id));
        if (!deleteResult.success) {
            throw new Error(deleteResult.error || 'Failed to remove recurring follow-up');
        }
    }

    const {
        isFocusedToday: _restoreFocusedToday,
        focusOrder: previousFocusOrder,
        ...restoreUpdates
    } = options.restoreUpdates ?? {};
    const moveResult = options.restoreUpdates
        ? await Promise.resolve(state.updateTask(taskId, {
            ...restoreUpdates,
            status: previousStatus,
            isFocusedToday: false,
            focusOrder: undefined,
        }))
        : await Promise.resolve(state.moveTask(taskId, previousStatus));
    if (!moveResult.success) {
        if (generatedOccurrence) {
            await Promise.resolve(useTaskStore.getState().restoreTask(generatedOccurrence.id));
        }
        throw new Error(moveResult.error || 'Failed to restore task status');
    }
    if (!wasFocusedToday) return;

    const current = useTaskStore.getState();
    const focusTaskLimit = normalizeFocusTaskLimit(current.settings.gtd?.focusTaskLimit);
    if (current.getFocusedCount() >= focusTaskLimit) return;
    const focusResult = await Promise.resolve(current.updateTask(taskId, {
        isFocusedToday: true,
        ...(previousFocusOrder !== undefined ? { focusOrder: previousFocusOrder } : {}),
    }));
    if (!focusResult.success) {
        throw new Error(focusResult.error || 'Failed to restore task focus');
    }
}
