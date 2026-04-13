import { useCallback, useMemo, useState } from 'react';
import { Alert } from 'react-native';
import type { StoreActionResult, Task, TaskStatus } from '@mindwtr/core';
import { logError } from '../lib/app-log';
import { getBulkActionFailureMessage } from './task-list-utils';
import { useToast } from '../contexts/toast-context';

type UseTaskListSelectionParams = {
  batchDeleteTasks: (ids: string[]) => Promise<void | StoreActionResult>;
  batchMoveTasks: (ids: string[], status: TaskStatus) => Promise<void | StoreActionResult>;
  batchUpdateTasks: (updates: { id: string; updates: Partial<Task> }[]) => Promise<void | StoreActionResult>;
  restoreActionLabel: string;
  restoreTask: (id: string) => Promise<void | StoreActionResult>;
  t: (key: string) => string;
  tasksById: Record<string, Task>;
};

export function useTaskListSelection({
  batchDeleteTasks,
  batchMoveTasks,
  batchUpdateTasks,
  restoreActionLabel,
  restoreTask,
  t,
  tasksById,
}: UseTaskListSelectionParams) {
  const { showToast } = useToast();
  const [selectionMode, setSelectionMode] = useState(false);
  const [multiSelectedIds, setMultiSelectedIds] = useState<Set<string>>(new Set());
  const [tagModalVisible, setTagModalVisible] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [bulkActionLoading, setBulkActionLoading] = useState(false);
  const [bulkActionLabel, setBulkActionLabel] = useState('');

  const selectedIdsArray = useMemo(() => Array.from(multiSelectedIds), [multiSelectedIds]);
  const hasSelection = selectedIdsArray.length > 0;

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setMultiSelectedIds(new Set());
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

  const toggleMultiSelect = useCallback((taskId: string) => {
    if (!selectionMode) setSelectionMode(true);
    setMultiSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, [selectionMode]);

  const handleBatchMove = useCallback(async (newStatus: TaskStatus) => {
    if (!hasSelection || bulkActionLoading) return;
    await runBulkAction(t('bulk.moveTo'), async () => {
      await batchMoveTasks(selectedIdsArray, newStatus);
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
      t('bulk.confirmDeleteTitle') || t('common.delete'),
      t('bulk.confirmDeleteBody') || t('list.confirmBatchDelete'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: async () => {
            const deletedIds = [...selectedIdsArray];
            await runBulkAction(t('common.delete'), async () => {
              await batchDeleteTasks(deletedIds);
              exitSelectionMode();
              showToast({
                title: t('common.done'),
                message: `${deletedIds.length} ${t('common.tasks')}`,
                tone: 'success',
                actionLabel: restoreActionLabel,
                onAction: () => {
                  deletedIds.forEach((id) => {
                    void restoreTask(id);
                  });
                },
              });
            });
          },
        },
      ]
    );
  }, [batchDeleteTasks, bulkActionLoading, exitSelectionMode, hasSelection, restoreActionLabel, restoreTask, runBulkAction, selectedIdsArray, showToast, t]);

  const handleBatchAddTag = useCallback(async () => {
    const input = tagInput.trim();
    if (!hasSelection || !input || bulkActionLoading) return;
    const tag = input.startsWith('#') ? input : `#${input}`;
    await runBulkAction(t('bulk.addTag'), async () => {
      await batchUpdateTasks(selectedIdsArray.map((id) => {
        const task = tasksById[id];
        const existingTags = task?.tags || [];
        const nextTags = Array.from(new Set([...existingTags, tag]));
        return { id, updates: { tags: nextTags } };
      }));
      setTagInput('');
      setTagModalVisible(false);
      exitSelectionMode();
      showToast({
        title: t('common.done'),
        message: `${selectedIdsArray.length} ${t('common.tasks')}`,
        tone: 'success',
      });
    });
  }, [batchUpdateTasks, bulkActionLoading, exitSelectionMode, hasSelection, runBulkAction, selectedIdsArray, showToast, t, tagInput, tasksById]);

  return {
    bulkActionLabel,
    bulkActionLoading,
    exitSelectionMode,
    handleBatchAddTag,
    handleBatchDelete,
    handleBatchMove,
    hasSelection,
    multiSelectedIds,
    selectedIdsArray,
    selectionMode,
    setSelectionMode,
    setTagInput,
    setTagModalVisible,
    tagInput,
    tagModalVisible,
    toggleMultiSelect,
  };
}
