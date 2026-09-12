import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    buildBulkOrganizeTaskUpdates,
    buildBulkTaskTokenUpdates,
    updateRangeSelection,
    type BulkOrganizeTaskUpdateInput,
    type RangeSelectionOptions,
    type Task,
    type TaskEnergyLevel,
    type TaskStatus,
} from '@mindwtr/core';
import { reportError } from '../../../lib/report-error';
import { registerUndoableAction } from '../../../lib/undo-registry';
import { useSelectedTasksCsvExport } from './useSelectedTasksCsvExport';

type TaskUpdate = { id: string; updates: Partial<Task> };
type TaskLookup = Map<string, Task> | Record<string, Task | undefined>;
type TaskSelectionAction = 'delete' | 'move' | 'organize' | 'update';
type ShowToast = (
    message: string,
    tone?: 'success' | 'error' | 'info',
    durationMs?: number,
    action?: { label: string; onClick: () => void },
) => void;

type TaskSelectionActions = {
    batchDeleteTasks?: (taskIds: string[]) => Promise<unknown> | unknown;
    batchMoveTasks?: (taskIds: string[], newStatus: TaskStatus) => Promise<unknown> | unknown;
    batchUpdateTasks?: (updates: TaskUpdate[]) => Promise<unknown> | unknown;
    onActionError?: (action: TaskSelectionAction, error: unknown) => void;
    restoreTask?: (taskId: string) => Promise<unknown> | unknown;
    showToast?: ShowToast;
    t?: (key: string) => string;
    tasksById?: TaskLookup;
    undoNotificationsEnabled?: boolean;
};

type RunActionOptions = {
    afterSuccess?: () => void;
    confirm?: () => Promise<boolean>;
};

type TokenActionOptions = Omit<RunActionOptions, 'confirm'> & {
    afterNoop?: () => void;
};

function assertTaskActionSucceeded(result: unknown): void {
    if (
        result
        && typeof result === 'object'
        && 'success' in result
        && result.success === false
    ) {
        const error = 'error' in result && typeof result.error === 'string'
            ? result.error
            : '';
        throw new Error(error);
    }
}

export async function restoreDeletedTasksWithFeedback(
    taskIds: string[],
    restoreTask: (taskId: string) => Promise<unknown> | unknown,
    showToast: ShowToast,
): Promise<void> {
    try {
        const results = await Promise.all(taskIds.map((taskId) => restoreTask(taskId)));
        results.forEach(assertTaskActionSucceeded);
    } catch (error) {
        reportError('Failed to restore deleted tasks', error);
        const message = error instanceof Error && error.message
            ? error.message
            : 'Failed to restore deleted tasks';
        showToast(message, 'error');
    }
}

export function useTaskSelection(
    visibleIds: string[],
    actions: TaskSelectionActions = {},
) {
    const {
        batchDeleteTasks,
        batchMoveTasks,
        batchUpdateTasks,
        onActionError,
        restoreTask,
        showToast,
        t,
        tasksById,
        undoNotificationsEnabled = true,
    } = actions;
    const [selectionMode, setSelectionMode] = useState(false);
    const [multiSelectedIds, setMultiSelectedIds] = useState<Set<string>>(new Set());
    const [activeAction, setActiveAction] = useState<TaskSelectionAction | null>(null);
    const anchorIdRef = useRef<string | null>(null);
    const activeActionRef = useRef<TaskSelectionAction | null>(null);

    const visibleIdSet = useMemo(() => new Set(visibleIds), [visibleIds]);
    // Derive action inputs from the current selectable collection immediately.
    // The effect below also prunes state, but it runs after render; intersecting
    // here closes the window where a newly read-only row could reach a bulk write.
    const selectedIdsArray = useMemo(
        () => Array.from(multiSelectedIds).filter((id) => visibleIdSet.has(id)),
        [multiSelectedIds, visibleIdSet],
    );
    const selectedVisibleCount = selectedIdsArray.length;
    const allVisibleTasksSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;
    const { exportSelectedTasks, isExporting } = useSelectedTasksCsvExport(selectedIdsArray, {
        showToast,
        t,
    });

    useEffect(() => {
        setMultiSelectedIds((previous) => {
            const next = new Set(Array.from(previous).filter((id) => visibleIdSet.has(id)));
            return next.size === previous.size ? previous : next;
        });
        if (anchorIdRef.current && !visibleIdSet.has(anchorIdRef.current)) {
            anchorIdRef.current = null;
        }
    }, [visibleIdSet]);

    const exitSelectionMode = useCallback(() => {
        setSelectionMode(false);
        setMultiSelectedIds(new Set());
        anchorIdRef.current = null;
    }, []);

    const toggleSelectionMode = useCallback(() => {
        if (selectionMode) {
            exitSelectionMode();
            return;
        }
        setSelectionMode(true);
    }, [exitSelectionMode, selectionMode]);

    const toggleMultiSelect = useCallback((taskId: string, options: RangeSelectionOptions = {}) => {
        if (!visibleIdSet.has(taskId)) return;
        setMultiSelectedIds((previous) => {
            const result = updateRangeSelection({
                anchorId: anchorIdRef.current,
                range: options.range,
                selectedIds: previous,
                targetId: taskId,
                visibleIds,
            });
            anchorIdRef.current = result.anchorId;
            setSelectionMode(result.selectedIds.size > 0);
            return result.selectedIds;
        });
    }, [visibleIds, visibleIdSet]);

    const selectAllVisibleTasks = useCallback(() => {
        setSelectionMode(true);
        anchorIdRef.current = visibleIds[0] ?? null;
        setMultiSelectedIds(new Set(visibleIds));
    }, [visibleIds]);

    const clearTaskSelection = useCallback(() => {
        anchorIdRef.current = null;
        setMultiSelectedIds(new Set());
    }, []);

    const translate = useCallback((key: string, fallback: string) => {
        const value = t?.(key);
        return value && value !== key ? value : fallback;
    }, [t]);

    const runSelectedTaskAction = useCallback(async (
        action: TaskSelectionAction,
        write: (taskIds: string[]) => Promise<unknown> | unknown,
        options: RunActionOptions = {},
    ): Promise<boolean> => {
        if (selectedIdsArray.length === 0 || activeActionRef.current) return false;
        if (options.confirm && !(await options.confirm())) return false;

        const taskIds = [...selectedIdsArray];
        activeActionRef.current = action;
        setActiveAction(action);
        try {
            assertTaskActionSucceeded(await Promise.resolve(write(taskIds)));
            options.afterSuccess?.();
            exitSelectionMode();
            return true;
        } catch (error) {
            if (onActionError) {
                onActionError(action, error);
            } else {
                reportError(`Failed to ${action} selected tasks`, error);
            }
            const failure = action === 'delete'
                ? translate('bulk.deleteFailed', 'Failed to delete selected tasks')
                : action === 'organize'
                    ? translate('bulk.organizeFailed', 'Failed to organize selected tasks')
                    : action === 'move'
                        ? translate('bulk.moveFailed', 'Failed to move selected tasks')
                        : translate('bulk.updateFailed', 'Failed to update selected tasks');
            showToast?.(failure, 'error');
            return false;
        } finally {
            activeActionRef.current = null;
            setActiveAction(null);
        }
    }, [exitSelectionMode, onActionError, selectedIdsArray, showToast, translate]);

    const moveSelectedTasks = useCallback((
        newStatus: TaskStatus,
        options?: Omit<RunActionOptions, 'confirm'>,
    ) => {
        if (!batchMoveTasks) return Promise.resolve(false);
        return runSelectedTaskAction(
            'move',
            (taskIds) => batchMoveTasks(taskIds, newStatus),
            options,
        );
    }, [batchMoveTasks, runSelectedTaskAction]);

    const deleteSelectedTasks = useCallback((options?: RunActionOptions) => {
        if (!batchDeleteTasks) return Promise.resolve(false);
        const deletedIds = [...selectedIdsArray];
        return runSelectedTaskAction('delete', batchDeleteTasks, {
            confirm: options?.confirm,
            afterSuccess: () => {
                if (restoreTask) {
                    const undo = registerUndoableAction(() => {
                        void restoreDeletedTasksWithFeedback(
                            deletedIds,
                            restoreTask,
                            showToast ?? (() => undefined),
                        );
                    });
                    if (undoNotificationsEnabled && showToast) {
                        const deletedMessage = deletedIds.length === 1
                            ? translate('list.taskDeleted', 'Task deleted')
                            : translate('list.tasksDeleted', '{{count}} tasks deleted')
                                .replace('{{count}}', String(deletedIds.length));
                        showToast(deletedMessage, 'info', 5000, {
                            label: translate('common.undo', 'Undo'),
                            onClick: undo,
                        });
                    }
                }
                options?.afterSuccess?.();
            },
        });
    }, [
        batchDeleteTasks,
        restoreTask,
        runSelectedTaskAction,
        selectedIdsArray,
        showToast,
        translate,
        undoNotificationsEnabled,
    ]);

    const updateSelectedTasks = useCallback((
        updates: TaskUpdate[] | ((taskIds: string[]) => TaskUpdate[]),
        options?: Omit<RunActionOptions, 'confirm'>,
    ) => {
        if (!batchUpdateTasks) return Promise.resolve(false);
        return runSelectedTaskAction(
            'update',
            (taskIds) => batchUpdateTasks(
                typeof updates === 'function' ? updates(taskIds) : updates,
            ),
            options,
        );
    }, [batchUpdateTasks, runSelectedTaskAction]);

    const assignAreaToSelectedTasks = useCallback((areaId: string | null) => (
        updateSelectedTasks((taskIds) => taskIds.map((id) => ({
            id,
            updates: { areaId: areaId ?? undefined },
        })))
    ), [updateSelectedTasks]);

    const assignEnergyToSelectedTasks = useCallback((energyLevel: TaskEnergyLevel) => (
        updateSelectedTasks((taskIds) => taskIds.map((id) => ({
            id,
            updates: { energyLevel },
        })))
    ), [updateSelectedTasks]);

    const organizeSelectedTasks = useCallback((
        input: BulkOrganizeTaskUpdateInput,
        options?: Omit<RunActionOptions, 'confirm'>,
    ) => {
        if (!tasksById || !batchUpdateTasks || selectedIdsArray.length === 0) {
            return Promise.resolve(false);
        }
        const updates = buildBulkOrganizeTaskUpdates(selectedIdsArray, tasksById, input);
        if (updates.length === 0) return Promise.resolve(false);
        return runSelectedTaskAction(
            'organize',
            () => batchUpdateTasks(updates),
            options,
        );
    }, [batchUpdateTasks, runSelectedTaskAction, selectedIdsArray, tasksById]);

    const updateSelectedTaskTokens = useCallback((
        field: 'tags' | 'contexts',
        value: string | readonly string[],
        action: 'add' | 'remove',
        options?: TokenActionOptions,
    ) => {
        if (!tasksById || selectedIdsArray.length === 0) return Promise.resolve(false);
        const updates = buildBulkTaskTokenUpdates(
            selectedIdsArray,
            tasksById,
            field,
            value,
            action,
        );
        if (updates.length === 0) {
            options?.afterNoop?.();
            return Promise.resolve(false);
        }
        return updateSelectedTasks(updates, options);
    }, [selectedIdsArray, tasksById, updateSelectedTasks]);

    return {
        activeAction,
        allVisibleTasksSelected,
        assignAreaToSelectedTasks,
        assignEnergyToSelectedTasks,
        clearTaskSelection,
        deleteSelectedTasks,
        exitSelectionMode,
        exportSelectedTasks,
        isExporting,
        multiSelectedIds,
        moveSelectedTasks,
        organizeSelectedTasks,
        runSelectedTaskAction,
        selectedIdsArray,
        selectionMode,
        selectAllVisibleTasks,
        setSelectionMode,
        toggleMultiSelect,
        toggleSelectionMode,
        updateSelectedTasks,
        updateSelectedTaskTokens,
    };
}
