import { View, Text, FlatList, Pressable, StyleSheet, Alert } from 'react-native';
import { Check, RotateCcw, Trash2 } from 'lucide-react-native';
import {
  buildTrashTimeline,
  formatTrashCounts,
  formatTrashDeletedDate,
  getProjectAccentColor,
  getInlineMarkdownPreview,
  getTrashEmptyState,
  getTrashPurgeConfirmation,
  getTrashRetentionHint,
  getTrashRowLabels,
  purgeTrashItems,
  resolveTrashClearScope,
  restoreTrashItems,
  safeFormatDate,
  selectTrashedProjects,
  selectTrashedTasks,
  shallow,
  tFallback,
  useTaskStore,
  type ListConfirmation,
  type Area,
  type Project,
  type StoreActionResult,
  type Task,
} from '@mindwtr/core';
import { MarkdownInlineText } from '@/components/markdown-text';
import { assertBulkActionSucceeded } from '@/components/use-task-list-selection';
import { getBulkActionFailureMessage } from '@/components/task-list-utils';
import { useToast } from '@/contexts/toast-context';
import { logError } from '@/lib/app-log';
import { useTheme } from '../../contexts/theme-context';
import { useLanguage } from '../../contexts/language-context';

import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { useThemeColors, ThemeColors } from '@/hooks/use-theme-colors';
import { Swipeable, GestureHandlerRootView } from 'react-native-gesture-handler';
import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

function TrashSwipeRow({
  children,
  onRestore,
  onDelete,
  restoreLabel,
  deleteLabel,
  swipeDisabled,
}: {
  children: ReactNode;
  onRestore: () => void;
  onDelete: () => void;
  restoreLabel: string;
  deleteLabel: string;
  swipeDisabled?: boolean;
}) {
  const swipeableRef = useRef<Swipeable>(null);

  const renderLeftActions = () => (
    <Pressable
      style={styles.swipeActionRestore}
      onPress={() => {
        swipeableRef.current?.close();
        onRestore();
      }}
    >
      <RotateCcw size={18} color="#FFFFFF" />
      <Text style={[styles.swipeActionText, { marginTop: 4 }]}>{restoreLabel}</Text>
    </Pressable>
  );

  const renderRightActions = () => (
    <Pressable
      style={styles.swipeActionDelete}
      onPress={() => {
        swipeableRef.current?.close();
        onDelete();
      }}
    >
      <Trash2 size={18} color="#FFFFFF" />
      <Text style={[styles.swipeActionText, { marginTop: 4 }]}>{deleteLabel}</Text>
    </Pressable>
  );

  return (
    <Swipeable
      ref={swipeableRef}
      renderLeftActions={swipeDisabled ? undefined : renderLeftActions}
      renderRightActions={swipeDisabled ? undefined : renderRightActions}
      overshootLeft={false}
      overshootRight={false}
    >
      {children}
    </Swipeable>
  );
}

function TrashSelectionIndicator({ isSelected, tc }: { isSelected: boolean; tc: ThemeColors }) {
  return (
    <View
      style={[
        styles.selectionIndicator,
        { borderColor: tc.tint, backgroundColor: isSelected ? tc.tint : 'transparent' },
      ]}
    >
      {isSelected && <Check size={14} color={tc.onTint} strokeWidth={3} />}
    </View>
  );
}

function TrashTaskItem({
  task,
  tc,
  onRestore,
  onDelete,
  onToggleSelect,
  selectLabel,
  selectionMode,
  isSelected,
  isHighlighted,
  typeLabel,
  deletedLabel,
  notSetLabel,
  restoreLabel,
  deleteLabel,
}: {
  task: Task;
  tc: ThemeColors;
  onRestore: () => void;
  onDelete: () => void;
  onToggleSelect: () => void;
  selectLabel: string;
  selectionMode: boolean;
  isSelected: boolean;
  isHighlighted?: boolean;
  typeLabel: string;
  deletedLabel: string;
  notSetLabel: string;
  restoreLabel: string;
  deleteLabel: string;
}) {
  return (
    <TrashSwipeRow onRestore={onRestore} onDelete={onDelete} restoreLabel={restoreLabel} deleteLabel={deleteLabel} swipeDisabled={selectionMode}>
      <Pressable
        disabled={!selectionMode}
        onPress={onToggleSelect}
        accessibilityRole={selectionMode ? 'button' : undefined}
        accessibilityLabel={selectionMode ? `${selectLabel} ${task.title}` : undefined}
        accessibilityState={selectionMode ? { selected: isSelected } : undefined}
        style={[
          styles.taskItem,
          { backgroundColor: tc.taskItemBg, borderColor: tc.border },
          isHighlighted && !selectionMode && { borderWidth: 2, borderColor: tc.tint },
          selectionMode && isSelected && { borderWidth: 2, borderColor: tc.tint },
        ]}
      >
        {selectionMode && <TrashSelectionIndicator isSelected={isSelected} tc={tc} />}
        <View style={styles.taskContent}>
          <Text style={[styles.taskTitle, { color: tc.secondaryText }]} numberOfLines={2}>
            {task.title}
          </Text>
          {task.description && (
            <MarkdownInlineText
              markdown={getInlineMarkdownPreview(task.description)}
              tc={tc}
              style={[styles.taskDescription, { color: tc.secondaryText }]}
              numberOfLines={1}
            />
          )}
          <Text style={[styles.archivedDate, { color: tc.secondaryText }]}>{typeLabel}</Text>
          <Text style={[styles.archivedDate, { color: tc.secondaryText }]}>{deletedLabel}: {formatTrashDeletedDate(task.deletedAt, safeFormatDate, notSetLabel)}</Text>
        </View>
        <View style={[styles.statusIndicator, { backgroundColor: '#6B7280' }]} />
      </Pressable>
    </TrashSwipeRow>
  );
}

function TrashProjectItem({
  project,
  areaById,
  tc,
  onRestore,
  onDelete,
  onToggleSelect,
  selectLabel,
  selectionMode,
  isSelected,
  typeLabel,
  deletedLabel,
  notSetLabel,
  restoreLabel,
  deleteLabel,
}: {
  project: Project;
  areaById: Map<string, Area>;
  tc: ThemeColors;
  onRestore: () => void;
  onDelete: () => void;
  onToggleSelect: () => void;
  selectLabel: string;
  selectionMode: boolean;
  isSelected: boolean;
  typeLabel: string;
  deletedLabel: string;
  notSetLabel: string;
  restoreLabel: string;
  deleteLabel: string;
}) {
  const indicatorColor = getProjectAccentColor(project, areaById);
  return (
    <TrashSwipeRow onRestore={onRestore} onDelete={onDelete} restoreLabel={restoreLabel} deleteLabel={deleteLabel} swipeDisabled={selectionMode}>
      <Pressable
        disabled={!selectionMode}
        onPress={onToggleSelect}
        accessibilityRole={selectionMode ? 'button' : undefined}
        accessibilityLabel={selectionMode ? `${selectLabel} ${project.title}` : undefined}
        accessibilityState={selectionMode ? { selected: isSelected } : undefined}
        style={[
          styles.taskItem,
          { backgroundColor: tc.taskItemBg, borderColor: tc.border },
          selectionMode && isSelected && { borderWidth: 2, borderColor: tc.tint },
        ]}
      >
        {selectionMode && <TrashSelectionIndicator isSelected={isSelected} tc={tc} />}
        <View style={styles.taskContent}>
          <Text style={[styles.taskTitle, { color: tc.secondaryText }]} numberOfLines={2}>
            {project.title}
          </Text>
          <Text style={[styles.archivedDate, { color: tc.secondaryText }]}>{typeLabel}</Text>
          <Text style={[styles.archivedDate, { color: tc.secondaryText }]}>{deletedLabel}: {formatTrashDeletedDate(project.deletedAt, safeFormatDate, notSetLabel)}</Text>
        </View>
        {indicatorColor ? <View style={[styles.statusIndicator, { backgroundColor: indicatorColor }]} /> : null}
      </Pressable>
    </TrashSwipeRow>
  );
}

export default function TrashScreen() {
  const {
    _allTasks,
    _allProjects,
    projects,
    restoreTask,
    restoreTasks,
    restoreProject,
    purgeTask,
    purgeTasks,
    purgeProject,
    highlightTaskId,
    setHighlightTask,
  } = useTaskStore((state) => ({
    _allTasks: state._allTasks,
    _allProjects: state._allProjects,
    projects: state.projects,
    restoreTask: state.restoreTask,
    restoreTasks: state.restoreTasks,
    restoreProject: state.restoreProject,
    purgeTask: state.purgeTask,
    purgeTasks: state.purgeTasks,
    purgeProject: state.purgeProject,
    highlightTaskId: state.highlightTaskId,
    setHighlightTask: state.setHighlightTask,
  }), shallow);
  const { t } = useLanguage();
  const { showToast } = useToast();
  useTheme();
  const tc = useThemeColors();
  const { areaById, resolvedAreaFilter } = useMobileAreaFilter();
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);

  const trashedTasks = useMemo(
    () => selectTrashedTasks(_allTasks, resolvedAreaFilter, projectById, areaById),
    [_allTasks, areaById, projectById, resolvedAreaFilter],
  );

  const trashedProjects = useMemo(
    () => selectTrashedProjects(_allProjects, resolvedAreaFilter, areaById),
    [_allProjects, areaById, resolvedAreaFilter],
  );

  const trashItems = useMemo(
    () => buildTrashTimeline(trashedTasks, trashedProjects),
    [trashedProjects, trashedTasks],
  );

  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(new Set());
  const selectionCount = selectedTaskIds.size + selectedProjectIds.size;
  const listExtraData = useMemo(
    () => ({ highlightTaskId, selectedProjectIds, selectedTaskIds, selectionMode }),
    [highlightTaskId, selectedProjectIds, selectedTaskIds, selectionMode],
  );

  useEffect(() => {
    const visibleTaskIds = new Set(trashedTasks.map((task) => task.id));
    setSelectedTaskIds((previous) => {
      const next = new Set(Array.from(previous).filter((id) => visibleTaskIds.has(id)));
      return next.size === previous.size ? previous : next;
    });
    const visibleProjectIds = new Set(trashedProjects.map((project) => project.id));
    setSelectedProjectIds((previous) => {
      const next = new Set(Array.from(previous).filter((id) => visibleProjectIds.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [trashedProjects, trashedTasks]);

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedTaskIds(new Set());
    setSelectedProjectIds(new Set());
  }, []);

  const runTrashBulkAction = useCallback(async (
    label: string,
    action: () => Promise<(void | StoreActionResult)[]>,
  ) => {
    try {
      const results = await action();
      results.forEach(assertBulkActionSucceeded);
      exitSelectionMode();
    } catch (error) {
      void logError(error, { scope: 'tasks', extra: { message: `Trash bulk action failed: ${label}` } });
      showToast({
        title: t('common.notice'),
        message: getBulkActionFailureMessage(error, `${label} failed.`),
        tone: 'warning',
        durationMs: 4200,
      });
    }
  }, [exitSelectionMode, showToast, t]);

  const toggleTaskSelection = useCallback((taskId: string) => {
    setSelectedTaskIds((previous) => {
      const next = new Set(previous);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  const toggleProjectSelection = useCallback((projectId: string) => {
    setSelectedProjectIds((previous) => {
      const next = new Set(previous);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }, []);

  const selectAllItems = useCallback(() => {
    setSelectedTaskIds(new Set(trashedTasks.map((task) => task.id)));
    setSelectedProjectIds(new Set(trashedProjects.map((project) => project.id)));
  }, [trashedProjects, trashedTasks]);

  const handleBulkRestore = useCallback(async () => {
    if (selectionCount === 0) return;
    const taskIds = Array.from(selectedTaskIds);
    const projectIds = Array.from(selectedProjectIds);
    await runTrashBulkAction(t('trash.restore'), () => restoreTrashItems({ restoreTasks, restoreProject }, { taskIds, projectIds }));
  }, [restoreProject, restoreTasks, runTrashBulkAction, selectedProjectIds, selectedTaskIds, selectionCount, t]);

  const handleBulkPurge = useCallback(() => {
    if (selectionCount === 0) return;
    const confirmation = getTrashPurgeConfirmation({ kind: 'selection' }, t);
    Alert.alert(
      confirmation.title,
      confirmation.message,
      [
        { text: confirmation.cancelLabel, style: 'cancel' },
        {
          text: confirmation.confirmLabel,
          style: 'destructive',
          onPress: async () => {
            const taskIds = Array.from(selectedTaskIds);
            const projectIds = Array.from(selectedProjectIds);
            await runTrashBulkAction(t('trash.deletePermanently'), () => purgeTrashItems({ purgeTasks, purgeProject }, { taskIds, projectIds }));
          },
        },
      ],
    );
  }, [purgeProject, purgeTasks, runTrashBulkAction, selectedProjectIds, selectedTaskIds, selectionCount, t]);

  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!highlightTaskId) return;
    if (highlightTimerRef.current) {
      clearTimeout(highlightTimerRef.current);
    }
    highlightTimerRef.current = setTimeout(() => {
      setHighlightTask(null);
    }, 3500);
    return () => {
      if (highlightTimerRef.current) {
        clearTimeout(highlightTimerRef.current);
      }
    };
  }, [highlightTaskId, setHighlightTask]);

  const handleRestoreTask = (taskId: string) => {
    restoreTask(taskId);
  };

  const handleRestoreProject = (projectId: string) => {
    restoreProject(projectId);
  };

  const confirmPurge = (confirmation: ListConfirmation, onPress: () => void) => {
    Alert.alert(
      confirmation.title,
      confirmation.message,
      [
        { text: confirmation.cancelLabel, style: 'cancel' },
        { text: confirmation.confirmLabel, style: 'destructive', onPress },
      ]
    );
  };

  const handleDeleteTask = (taskId: string) => {
    confirmPurge(getTrashPurgeConfirmation({ kind: 'item' }, t), () => purgeTask(taskId));
  };

  const handleDeleteProject = (projectId: string) => {
    confirmPurge(getTrashPurgeConfirmation({ kind: 'item' }, t), () => purgeProject(projectId));
  };

  // Purge cannot be undone, so a filtered list may only clear what it shows.
  const handleClearAll = () => {
    if (trashItems.length === 0) return;
    const scope = resolveTrashClearScope(trashedTasks, trashedProjects, _allTasks, _allProjects);
    const confirmation = getTrashPurgeConfirmation({
      kind: 'clear',
      narrowed: scope.narrowed,
      taskCount: scope.taskIds.length,
      projectCount: scope.projectIds.length,
    }, t);
    Alert.alert(
      confirmation.title,
      confirmation.message,
      [
        { text: confirmation.cancelLabel, style: 'cancel' },
        {
          text: confirmation.confirmLabel,
          style: 'destructive',
          onPress: async () => {
            // Always the ids the alert was opened for, never a fresh whole-store
            // sweep: an item that arrived meanwhile was never shown to the user.
            await runTrashBulkAction(confirmation.confirmLabel, () => purgeTrashItems({ purgeTasks, purgeProject }, scope));
          },
        },
      ]
    );
  };

  const rowLabels = getTrashRowLabels(t);
  const emptyState = getTrashEmptyState(t);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={[styles.container, { backgroundColor: tc.bg }]}>
        {trashItems.length > 0 && (
          <View style={styles.summaryRow}>
            <Text style={[styles.summaryText, { color: tc.secondaryText }]}>
              {formatTrashCounts(trashedTasks.length, trashedProjects.length, t)}
            </Text>
            <View style={styles.summaryActions}>
              <Pressable
                onPress={selectionMode ? exitSelectionMode : () => setSelectionMode(true)}
                accessibilityRole="button"
                accessibilityLabel={selectionMode ? tFallback(t, 'common.done', 'Done') : tFallback(t, 'bulk.select', 'Select')}
                style={[styles.clearButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
              >
                <Text style={[styles.clearButtonText, { color: tc.text }]}>
                  {selectionMode ? tFallback(t, 'common.done', 'Done') : tFallback(t, 'bulk.select', 'Select')}
                </Text>
              </Pressable>
              <Pressable
                onPress={handleClearAll}
                style={[styles.clearButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
              >
                <Text style={[styles.clearButtonText, { color: tc.secondaryText }]}>
                  {tFallback(t, 'trash.clearAll', 'Clear Trash')}
                </Text>
              </Pressable>
            </View>
          </View>
        )}
        {trashItems.length > 0 && (
          <Text style={[styles.retentionHint, { color: tc.secondaryText }]}>
            {getTrashRetentionHint(t)}
          </Text>
        )}
        {selectionMode && (
          <View style={[styles.bulkBar, { borderColor: tc.border, backgroundColor: tc.cardBg }]}>
            <Text
              accessibilityLabel={`${selectionCount} ${t('bulk.selected')}`}
              style={[styles.bulkCount, { color: tc.secondaryText }]}
            >
              {selectionCount} {t('bulk.selected')}
            </Text>
            <View style={styles.bulkActions}>
              <Pressable
                onPress={selectAllItems}
                disabled={trashItems.length === 0 || selectionCount === trashItems.length}
                accessibilityRole="button"
                accessibilityLabel={`${tFallback(t, 'bulk.select', 'Select')} ${tFallback(t, 'common.all', 'all')}`}
                style={[styles.bulkButton, { backgroundColor: tc.taskItemBg }]}
              >
                <Text style={[styles.bulkButtonText, { color: tc.text }]}>
                  {tFallback(t, 'bulk.select', 'Select')} {tFallback(t, 'common.all', 'all')}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => { void handleBulkRestore(); }}
                disabled={selectionCount === 0}
                accessibilityRole="button"
                accessibilityLabel={t('trash.restore')}
                style={[styles.bulkButton, { backgroundColor: tc.taskItemBg }]}
              >
                <Text style={[styles.bulkButtonText, { color: tc.text }]}>
                  {t('trash.restore')}
                </Text>
              </Pressable>
              <Pressable
                onPress={handleBulkPurge}
                disabled={selectionCount === 0}
                accessibilityRole="button"
                accessibilityLabel={t('trash.deletePermanently')}
                style={[styles.bulkButton, { backgroundColor: tc.taskItemBg }]}
              >
                <Text style={[styles.bulkButtonText, { color: tc.danger }]}>
                  {t('trash.deletePermanently')}
                </Text>
              </Pressable>
            </View>
          </View>
        )}
        <FlatList
          data={trashItems}
          renderItem={({ item }) => (
            item.type === 'project'
              ? (
                <TrashProjectItem
                  project={item.project}
                  areaById={areaById}
                  tc={tc}
                  onRestore={() => handleRestoreProject(item.project.id)}
                  onDelete={() => handleDeleteProject(item.project.id)}
                  onToggleSelect={() => toggleProjectSelection(item.project.id)}
                  selectLabel={rowLabels.select}
                  selectionMode={selectionMode}
                  isSelected={selectedProjectIds.has(item.project.id)}
                  typeLabel={rowLabels.projectType}
                  deletedLabel={rowLabels.deleted}
                  notSetLabel={rowLabels.notSet}
                  restoreLabel={rowLabels.restore}
                  deleteLabel={rowLabels.delete}
                />
              )
              : (
                <TrashTaskItem
                  task={item.task}
                  tc={tc}
                  onRestore={() => handleRestoreTask(item.task.id)}
                  onDelete={() => handleDeleteTask(item.task.id)}
                  onToggleSelect={() => toggleTaskSelection(item.task.id)}
                  selectLabel={rowLabels.select}
                  selectionMode={selectionMode}
                  isSelected={selectedTaskIds.has(item.task.id)}
                  isHighlighted={item.task.id === highlightTaskId}
                  typeLabel={rowLabels.taskType}
                  deletedLabel={rowLabels.deleted}
                  notSetLabel={rowLabels.notSet}
                  restoreLabel={rowLabels.restore}
                  deleteLabel={rowLabels.delete}
                />
              )
          )}
          keyExtractor={(item) => item.type === 'project' ? 'project-' + item.project.id : 'task-' + item.task.id}
          extraData={listExtraData}
          style={styles.taskList}
          contentContainerStyle={[
            styles.taskListContent,
            trashItems.length === 0 && styles.emptyContent,
          ]}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={5}
          updateCellsBatchingPeriod={50}
          removeClippedSubviews={false}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Trash2 size={40} color={tc.secondaryText} style={styles.emptyIcon} />
              <Text style={[styles.emptyTitle, { color: tc.text }]}>
                {emptyState.title}
              </Text>
              <Text style={[styles.emptyText, { color: tc.secondaryText }]}>{emptyState.message}</Text>
            </View>
          }
        />
      </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  summaryRow: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  summaryText: {
    fontSize: 13,
    fontWeight: '500',
  },
  retentionHint: {
    fontSize: 12,
    paddingHorizontal: 16,
    paddingTop: 4,
  },
  summaryActions: {
    flexDirection: 'row',
    gap: 8,
  },
  clearButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  clearButtonText: {
    fontSize: 12,
    fontWeight: '600',
  },
  bulkBar: {
    marginHorizontal: 16,
    marginTop: 10,
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    gap: 8,
  },
  bulkCount: {
    fontSize: 12,
    fontWeight: '600',
  },
  bulkActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  bulkButton: {
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  bulkButtonText: {
    fontSize: 12,
    fontWeight: '600',
  },
  selectionIndicator: {
    width: 22,
    height: 22,
    borderWidth: 2,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  selectionMark: {
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 16,
  },
  taskList: {
    flex: 1,
  },
  taskListContent: {
    padding: 16,
  },
  emptyContent: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  taskItem: {
    flexDirection: 'row',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
  },
  taskContent: {
    flex: 1,
  },
  taskTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
    textDecorationLine: 'line-through',
  },
  taskDescription: {
    fontSize: 14,
    marginBottom: 4,
  },
  archivedDate: {
    fontSize: 12,
    fontStyle: 'italic',
  },
  statusIndicator: {
    width: 4,
    borderRadius: 2,
    marginLeft: 12,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
  },
  emptyIcon: {
    marginBottom: 12,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 6,
  },
  emptyText: {
    fontSize: 14,
  },
  swipeActionRestore: {
    backgroundColor: '#22c55e',
    justifyContent: 'center',
    alignItems: 'center',
    width: 120,
    borderRadius: 12,
    marginBottom: 12,
  },
  swipeActionDelete: {
    backgroundColor: '#ef4444',
    justifyContent: 'center',
    alignItems: 'center',
    width: 120,
    borderRadius: 12,
    marginBottom: 12,
  },
  swipeActionText: {
    color: 'white',
    fontWeight: '600',
  },
});
