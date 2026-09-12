import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Alert } from 'react-native';
import {
  buildBulkOrganizeTaskUpdates,
  buildBulkTaskTokenUpdates,
  collectBulkTaskTokens,
  tFallback,
  updateRangeSelection,
  type BulkOrganizeTaskUpdateInput,
  type StoreActionResult,
  type Task,
  type TaskStatus,
} from '@mindwtr/core';
import { logError } from '../lib/app-log';
import { getBulkActionFailureMessage } from './task-list-utils';
import { useToast } from '../contexts/toast-context';

type UseTaskListSelectionParams = {
  batchDeleteTasks: (ids: string[]) => Promise<void | StoreActionResult>;
  batchMoveTasks: (ids: string[], status: TaskStatus) => Promise<void | StoreActionResult>;
  batchUpdateTasks: (updates: { id: string; updates: Partial<Task> }[]) => Promise<void | StoreActionResult>;
  canSelectTaskId?: (taskId: string) => boolean;
  restoreActionLabel: string;
  restoreTask: (id: string) => Promise<void | StoreActionResult>;
  t: (key: string) => string;
  tasksById: Record<string, Task>;
};

type ToggleMultiSelectOptions = {
  visibleTaskIds?: readonly string[];
};

// Core batch actions (batchDeleteTasks/batchUpdateTasks/…) are all-or-nothing:
// on a bad input (e.g. an id removed by a sync merge between opening the confirm
// Alert and tapping it) they return `{ success: false }` WITHOUT throwing. Turn
// that into a throw so runBulkAction's catch shows the error toast and the
// caller never reaches its exitSelectionMode()/success-toast lines.
export function assertBulkActionSucceeded(result: void | StoreActionResult): void {
  if (result && result.success === false) {
    throw new Error(result.error ?? '');
  }
}

/**
 * Drops selected ids that are no longer on screen. Every surface that hides rows
 * — a filter, a search, a folded grouping heading — must call this with the ids
 * it actually renders: rows a bulk action still reaches after they disappear are
 * worse than not hiding them at all (#963, #970).
 */
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
  batchDeleteTasks,
  batchMoveTasks,
  batchUpdateTasks,
  canSelectTaskId,
  restoreActionLabel,
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
        message: `${selectedIdsArray.length} ${t('common.tasks')}`,
        tone: 'success',
      });
    });
  }, [batchMoveTasks, bulkActionLoading, exitSelectionMode, hasSelection, runBulkAction, selectedIdsArray, showToast, t]);

  const handleBatchDelete = useCallback(async () => {
    if (!hasSelection || bulkActionLoading) return;
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
                message: `${deletedIds.length} ${t('common.tasks')}`,
                tone: 'success',
                actionLabel: restoreActionLabel,
                onAction: () => {
                  void runBulkAction(restoreActionLabel, async () => {
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
  }, [batchDeleteTasks, bulkActionLoading, exitSelectionMode, hasSelection, restoreActionLabel, restoreTask, runBulkAction, selectedIdsArray, showToast, t]);

  // Both directions go through the same core builder desktop uses. Hand-rolling
  // the merge here meant a task the lookup missed was written back as
  // `tags: [newTag]` — every other tag on it silently gone.
  const handleBatchAddTag = useCallback(async () => {
    const input = tagInput.trim();
    if (!hasSelection || !input || bulkActionLoading) return;
    await runBulkAction(t('bulk.addTag'), async () => {
      const updates = buildBulkTaskTokenUpdates(selectedIdsArray, tasksById, 'tags', input, 'add');
      setTagInput('');
      setTagModalVisible(false);
      if (updates.length === 0) return;
      assertBulkActionSucceeded(await batchUpdateTasks(updates));
      exitSelectionMode();
      showToast({
        title: t('common.done'),
        message: `${updates.length} ${t('common.tasks')}`,
        tone: 'success',
      });
    });
  }, [batchUpdateTasks, bulkActionLoading, exitSelectionMode, hasSelection, runBulkAction, selectedIdsArray, showToast, t, tagInput, tasksById]);

  // Removal offers only the tags the selection actually carries, so a typo can
  // never look like a silent no-op.
  const removableTagOptions = useMemo(
    () => collectBulkTaskTokens(selectedIdsArray, tasksById, 'tags'),
    [selectedIdsArray, tasksById]
  );

  const handleBatchRemoveTags = useCallback(async (tags: string[]) => {
    if (!hasSelection || tags.length === 0 || bulkActionLoading) return;
    await runBulkAction(tFallback(t, 'bulk.removeTag', 'Remove tag'), async () => {
      const updates = buildBulkTaskTokenUpdates(selectedIdsArray, tasksById, 'tags', tags, 'remove');
      setRemoveTagPickerVisible(false);
      if (updates.length === 0) return;
      assertBulkActionSucceeded(await batchUpdateTasks(updates));
      exitSelectionMode();
      showToast({
        title: t('common.done'),
        message: `${updates.length} ${t('common.tasks')}`,
        tone: 'success',
      });
    });
  }, [batchUpdateTasks, bulkActionLoading, exitSelectionMode, hasSelection, runBulkAction, selectedIdsArray, showToast, t, tasksById]);

  const handleBatchOrganize = useCallback(async (input: BulkOrganizeTaskUpdateInput) => {
    if (!hasSelection || bulkActionLoading) return;
    const updates = buildBulkOrganizeTaskUpdates(selectedIdsArray, tasksById, input);
    if (updates.length === 0) return;
    await runBulkAction(tFallback(t, 'bulk.organize', 'Bulk organize'), async () => {
      assertBulkActionSucceeded(await batchUpdateTasks(updates));
      exitSelectionMode();
      showToast({
        title: t('common.done'),
        message: `${updates.length} ${t('common.tasks')}`,
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
