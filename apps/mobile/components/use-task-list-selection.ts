import { useCallback, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Alert } from 'react-native';
import { NavigationContext } from '@react-navigation/native';
import {
  buildBulkOrganizeTaskUpdates,
  buildBulkTaskTokenUpdates,
  collectBulkTaskTokens,
  formatListItemCount,
  getTrashUndoLabel,
  runStoreCommand,
  tFallback,
  updateRangeSelection,
  useTaskStore,
  type BulkOrganizeTaskUpdateInput,
  type StoreActionResult,
  type Task,
  type TaskStatus,
} from '@mindwtr/core';
import { logError } from '../lib/app-log';
import { addHardwareBackPressListener } from '../lib/hardware-back';
import { getBulkActionFailureMessage } from './task-list-utils';
import { useToast } from '../contexts/toast-context';

type UseTaskListSelectionParams = {

  backExitsSelection?: boolean;
  batchDeleteTasks: (ids: string[]) => Promise<void | StoreActionResult>;
  batchMoveTasks: (ids: string[], status: TaskStatus) => Promise<void | StoreActionResult>;
  batchUpdateTasks: (updates: { id: string; updates: Partial<Task> }[]) => Promise<void | StoreActionResult>;
  canSelectTaskId?: (taskId: string) => boolean;
  restoreTask: (id: string) => Promise<void | StoreActionResult>;
  t: (key: string) => string;
  tasksById: Record<string, Task>;
};

type ToggleMultiSelectOptions = {
  visibleTaskIds?: readonly string[];
};


export function assertBulkActionSucceeded(result: void | StoreActionResult): void {
  if (result && result.success === false) {
    throw new Error(result.error ?? '');
  }
}


export function usePruneSelectionToVisible(
  setMultiSelectedIds: Dispatch<SetStateAction<Set<string>>>,
  visibleTaskIds: readonly string[],
): void {
  useEffect(() => {
    const visibleIds = new Set(visibleTaskIds);
    setMultiSelectedIds((previous) => {
      const next = new Set(Array.from(previous).filter((id) => visibleIds.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [setMultiSelectedIds, visibleTaskIds]);
}

export function useTaskListSelection({
  backExitsSelection = true,
  batchDeleteTasks,
  batchMoveTasks,
  batchUpdateTasks,
  canSelectTaskId,
  restoreTask,
  t,
  tasksById,
}: UseTaskListSelectionParams) {
  const { showToast } = useToast();
  const [selectionMode, setSelectionMode] = useState(false);
  const [multiSelectedIds, setMultiSelectedIds] = useState<Set<string>>(new Set());
  const [tagModalVisible, setTagModalVisible] = useState(false);
  const [removeTagPickerVisible, setRemoveTagPickerVisible] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [bulkActionLoading, setBulkActionLoading] = useState(false);
  const [bulkActionLabel, setBulkActionLabel] = useState('');
  const [rangeSelectMode, setRangeSelectMode] = useState(false);
  const rangeSelectionAnchorIdRef = useRef<string | null>(null);

  const selectedIdsArray = useMemo(
    () => Array.from(multiSelectedIds).filter((taskId) => canSelectTaskId?.(taskId) ?? true),
    [canSelectTaskId, multiSelectedIds],
  );
  const hasSelection = selectedIdsArray.length > 0;

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setMultiSelectedIds(new Set());
    setRangeSelectMode(false);
    rangeSelectionAnchorIdRef.current = null;
  }, []);


  const navigation = useContext(NavigationContext);
  const backOwnsSelection = selectionMode && backExitsSelection && !tagModalVisible && !removeTagPickerVisible;
  useEffect(() => {
    if (!backOwnsSelection) return undefined;
    const subscription = addHardwareBackPressListener(() => {
      if (navigation && !navigation.isFocused()) return false;
      exitSelectionMode();
      return true;
    });
    return () => subscription.remove();
  }, [backOwnsSelection, exitSelectionMode, navigation]);

  const runBulkAction = useCallback(async (label: string, action: () => Promise<void>) => {
    if (bulkActionLoading) return;
    setBulkActionLabel(label);
    setBulkActionLoading(true);
    try {
      await action();
    } catch (error) {
      void logError(error, { scope: 'tasks', extra: { message: `Bulk action failed: ${label}` } });
      showToast({
        title: t('common.notice'),
        message: getBulkActionFailureMessage(error, `${label} failed.`),
        tone: 'warning',
        durationMs: 4200,
      });
    } finally {
      setBulkActionLoading(false);
      setBulkActionLabel('');
    }
  }, [bulkActionLoading, showToast, t]);

  const toggleRangeSelectMode = useCallback(() => {
    if (!hasSelection || bulkActionLoading) return;
    setRangeSelectMode((current) => !current);
  }, [bulkActionLoading, hasSelection]);

  const toggleMultiSelect = useCallback((taskId: string, options: ToggleMultiSelectOptions = {}) => {
    if (canSelectTaskId && !canSelectTaskId(taskId)) return;
    if (!selectionMode) setSelectionMode(true);
    setMultiSelectedIds((prev) => {
      const selectableIds = canSelectTaskId
        ? new Set(Array.from(prev).filter(canSelectTaskId))
        : prev;
      const visibleIds = canSelectTaskId
        ? (options.visibleTaskIds ?? []).filter(canSelectTaskId)
        : (options.visibleTaskIds ?? []);
      const result = updateRangeSelection({
        anchorId: rangeSelectionAnchorIdRef.current,
        range: rangeSelectMode,
        selectedIds: selectableIds,
        targetId: taskId,
        visibleIds,
      });
      rangeSelectionAnchorIdRef.current = result.anchorId;
      return result.selectedIds;
    });
    if (rangeSelectMode) setRangeSelectMode(false);
  }, [canSelectTaskId, rangeSelectMode, selectionMode]);

  const handleBatchMove = useCallback(async (newStatus: TaskStatus) => {
    if (!hasSelection || bulkActionLoading) return;
    await runBulkAction(t('bulk.moveTo'), async () => {
      assertBulkActionSucceeded(await batchMoveTasks(selectedIdsArray, newStatus));
      exitSelectionMode();
      showToast({
        title: t('common.done'),
        message: formatListItemCount(selectedIdsArray.length, 'task', t),
        tone: 'success',
      });
    });
  }, [batchMoveTasks, bulkActionLoading, exitSelectionMode, hasSelection, runBulkAction, selectedIdsArray, showToast, t]);

  const handleBatchDelete = useCallback(async () => {
    if (!hasSelection || bulkActionLoading) return;
    const undoLabel = getTrashUndoLabel(t);
    Alert.alert(
      tFallback(t, 'bulk.confirmDeleteTitle', t('common.delete')),
      tFallback(t, 'bulk.confirmDeleteBody', t('list.confirmBatchDelete')),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: async () => {
            const deletedIds = [...selectedIdsArray];
            await runBulkAction(t('common.delete'), async () => {
              assertBulkActionSucceeded(await batchDeleteTasks(deletedIds));
              exitSelectionMode();
              showToast({
                title: t('common.done'),
                message: formatListItemCount(deletedIds.length, 'task', t),
                tone: 'success',
                actionLabel: undoLabel,
                onAction: () => {
                  void runBulkAction(undoLabel, async () => {
                    const results = await Promise.all(deletedIds.map((id) => restoreTask(id)));
                    results.forEach(assertBulkActionSucceeded);
                  });
                },
              });
            });
          },
        },
      ]
    );
  }, [batchDeleteTasks, bulkActionLoading, exitSelectionMode, hasSelection, restoreTask, runBulkAction, selectedIdsArray, showToast, t]);


  const writeTagUpdates = useCallback((tags: string | string[], mode: 'add' | 'remove') => runStoreCommand(async () => {
    const updates = buildBulkTaskTokenUpdates(selectedIdsArray, useTaskStore.getState()._tasksById, 'tags', tags, mode);
    return { count: updates.length, result: updates.length > 0 ? await batchUpdateTasks(updates) : undefined };
  }), [batchUpdateTasks, selectedIdsArray]);

  const handleBatchAddTag = useCallback(async () => {
    const input = tagInput.trim();
    if (!hasSelection || !input || bulkActionLoading) return;
    await runBulkAction(t('bulk.addTag'), async () => {
      const written = writeTagUpdates(input, 'add');

      setTagModalVisible(false);
      const { count, result } = await written;
      assertBulkActionSucceeded(result);
      setTagInput('');
      if (count === 0) return;
      exitSelectionMode();
      showToast({
        title: t('common.done'),
        message: formatListItemCount(count, 'task', t),
        tone: 'success',
      });
    });
  }, [bulkActionLoading, exitSelectionMode, hasSelection, runBulkAction, showToast, t, tagInput, writeTagUpdates]);


  const removableTagOptions = useMemo(
    () => collectBulkTaskTokens(selectedIdsArray, tasksById, 'tags'),
    [selectedIdsArray, tasksById]
  );

  const handleBatchRemoveTags = useCallback(async (tags: string[]) => {
    if (!hasSelection || tags.length === 0 || bulkActionLoading) return;
    await runBulkAction(tFallback(t, 'bulk.removeTag', 'Remove tag'), async () => {
      const written = writeTagUpdates(tags, 'remove');
      setRemoveTagPickerVisible(false);
      const { count, result } = await written;
      if (count === 0) return;
      assertBulkActionSucceeded(result);
      exitSelectionMode();
      showToast({
        title: t('common.done'),
        message: formatListItemCount(count, 'task', t),
        tone: 'success',
      });
    });
  }, [bulkActionLoading, exitSelectionMode, hasSelection, runBulkAction, showToast, t, writeTagUpdates]);

  const handleBatchOrganize = useCallback(async (input: BulkOrganizeTaskUpdateInput) => {
    if (!hasSelection || bulkActionLoading) return;
    const updates = buildBulkOrganizeTaskUpdates(selectedIdsArray, tasksById, input);
    if (updates.length === 0) return;
    await runBulkAction(tFallback(t, 'bulk.organize', 'Bulk organize'), async () => {

      const { count, result } = await runStoreCommand(async () => {
        const latest = buildBulkOrganizeTaskUpdates(selectedIdsArray, useTaskStore.getState()._tasksById, input);
        return { count: latest.length, result: latest.length > 0 ? await batchUpdateTasks(latest) : undefined };
      });
      if (count === 0) return;
      assertBulkActionSucceeded(result);
      exitSelectionMode();
      showToast({
        title: t('common.done'),
        message: formatListItemCount(count, 'task', t),
        tone: 'success',
      });
    });
  }, [batchUpdateTasks, bulkActionLoading, exitSelectionMode, hasSelection, runBulkAction, selectedIdsArray, showToast, t, tasksById]);

  return {
    bulkActionLabel,
    bulkActionLoading,
    exitSelectionMode,
    handleBatchAddTag,
    handleBatchDelete,
    handleBatchOrganize,
    handleBatchMove,
    handleBatchRemoveTags,
    hasSelection,
    multiSelectedIds,
    rangeSelectMode,
    removableTagOptions,
    removeTagPickerVisible,
    runBulkAction,
    selectedIdsArray,
    selectionMode,
    setMultiSelectedIds,
    setRemoveTagPickerVisible,
    setSelectionMode,
    setTagInput,
    setTagModalVisible,
    tagInput,
    tagModalVisible,
    toggleRangeSelectMode,
    toggleMultiSelect,
  };
}
