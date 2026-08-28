import React, { useCallback, useMemo, useRef } from 'react';
import { FlatList, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import type { Task, TaskStatus, ViewSectionTaskGroup } from '@mindwtr/core';

import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';
import type { ThemeColors } from '@/hooks/use-theme-colors';
import { SwipeableTaskItem, type SwipeableTaskItemRowContext, type TaskRowActions } from './swipeable-task-item';
import { TASK_LIST_WINDOWING_PROPS } from './task-list-windowing';
import { TaskListBulkBar } from './task-list/TaskListBulkBar';
import { TaskListTagModal } from './task-list/TaskListTagModal';
import type { useTaskListSelection } from './use-task-list-selection';

/**
 * The subset of {@link useTaskListSelection}'s return value that the shared list
 * scaffolding drives. Callers pass the whole hook result — this alias keeps the
 * prop typed without re-listing every field.
 */
export type TaskListViewSelection = ReturnType<typeof useTaskListSelection>;
type TaskListViewRow =
  | { kind: 'heading'; id: string; title: string; muted?: boolean }
  | { kind: 'task'; task: Task };

export interface TaskListViewProps {
  /** Flat, already filtered + sorted rows. The view owns no data logic. */
  tasks: Task[];
  /** Optional headings for views whose grouping is part of their presentation. */
  taskGroups?: readonly ViewSectionTaskGroup[];
  isDark: boolean;
  themeColors: ThemeColors;
  t: (key: string) => string;

  /** Row interaction handlers. */
  onPressTask: (task: Task) => void;
  onChangeTaskStatus: (task: Task, status: TaskStatus) => void | Promise<unknown>;
  onDeleteTask: (task: Task) => void | Promise<unknown>;
  highlightTaskId?: string | null;
  rowContext?: SwipeableTaskItemRowContext;

  /** Selection + bulk-action scaffolding, from useTaskListSelection. */
  selection: TaskListViewSelection;
  /** Statuses offered by the bulk "Move to" control, from getBulkMoveStatusOptions. */
  bulkStatusOptions: readonly TaskStatus[];

  /** Per-view chrome slots rendered inside / around the list. */
  ListHeaderComponent?: React.ComponentProps<typeof FlatList>['ListHeaderComponent'];
  ListFooterComponent?: React.ComponentProps<typeof FlatList>['ListFooterComponent'];
  ListEmptyComponent?: React.ComponentProps<typeof FlatList>['ListEmptyComponent'];

  contentContainerStyle?: StyleProp<ViewStyle>;
  listStyle?: StyleProp<ViewStyle>;
}

/**
 * Chrome-free task list body shared by the simple single-status screens
 * (waiting, someday, ...). It renders the selection bulk bar, a FlatList of
 * SwipeableTaskItem rows, and the tag modal that the bulk bar opens — nothing
 * view-specific. Stat headers, filter chips, deferred-project sections and
 * empty states are passed in as slots so each screen keeps only what is
 * genuinely its own.
 *
 * Presentational only: it subscribes to no store, so it is testable with plain
 * fixtures. The FlatList windowing comes from the shared #766 tuning in
 * {@link TASK_LIST_WINDOWING_PROPS}.
 */
export function TaskListView({
  tasks,
  taskGroups,
  isDark,
  themeColors,
  t,
  onPressTask,
  onChangeTaskStatus,
  onDeleteTask,
  highlightTaskId,
  rowContext,
  selection,
  bulkStatusOptions,
  ListHeaderComponent,
  ListFooterComponent,
  ListEmptyComponent,
  contentContainerStyle,
  listStyle,
}: TaskListViewProps) {
  const {
    bulkActionLabel,
    bulkActionLoading,
    exitSelectionMode,
    handleBatchAddTag,
    handleBatchDelete,
    handleBatchMove,
    hasSelection,
    multiSelectedIds,
    rangeSelectMode,
    selectedIdsArray,
    selectionMode,
    setTagInput,
    setTagModalVisible,
    tagInput,
    tagModalVisible,
    toggleRangeSelectMode,
    toggleMultiSelect,
  } = selection;

  const visibleTaskIds = useMemo(() => tasks.map((task) => task.id), [tasks]);
  const rows = useMemo<TaskListViewRow[]>(() => {
    if (!taskGroups) return tasks.map((task) => ({ kind: 'task' as const, task }));
    return taskGroups.flatMap((group) => [
      { kind: 'heading' as const, id: group.id, title: group.title, muted: group.muted },
      ...group.tasks.map((task) => ({ kind: 'task' as const, task })),
    ]);
  }, [taskGroups, tasks]);

  // The handlers arrive as props and the visible ids change with the data, so
  // rows reach them through one object that never changes identity and reads
  // the latest values from a ref (#766). A row that took `visibleTaskIds` as a
  // prop would be invalidated by every list change; one that took a fresh
  // toggle arrow would be invalidated by every render.
  const rowActionSourcesRef = useRef({
    onPressTask,
    onChangeTaskStatus,
    onDeleteTask,
    toggleMultiSelect,
    visibleTaskIds,
  });
  rowActionSourcesRef.current = {
    onPressTask,
    onChangeTaskStatus,
    onDeleteTask,
    toggleMultiSelect,
    visibleTaskIds,
  };
  const rowActions = useMemo<TaskRowActions>(() => ({
    edit: (task) => rowActionSourcesRef.current.onPressTask(task),
    changeStatus: (task, status) => rowActionSourcesRef.current.onChangeTaskStatus(task, status),
    remove: (task) => rowActionSourcesRef.current.onDeleteTask(task),
    toggleSelect: (task) => {
      const sources = rowActionSourcesRef.current;
      sources.toggleMultiSelect(task.id, { visibleTaskIds: sources.visibleTaskIds });
    },
  }), []);

  const renderTask = useCallback(({ item }: { item: (typeof rows)[number] }) => {
    if (item.kind === 'heading') {
      return (
        <View style={styles.groupHeading}>
          <Text
            accessibilityRole="header"
            style={[styles.groupHeadingText, { color: item.muted ? themeColors.secondaryText : themeColors.text }]}
          >
            {item.title}
          </Text>
        </View>
      );
    }
    const task = item.task;
    return (
      <SwipeableTaskItem
        task={task}
      isDark={isDark}
      tc={themeColors}
      actions={rowActions}
      selectionMode={selectionMode}
      isMultiSelected={multiSelectedIds.has(task.id)}
      isHighlighted={task.id === highlightTaskId}
      statusBadgeAsIcon
      rowContext={rowContext}
      onProjectPress={openProjectScreen}
      onContextPress={openContextsScreen}
      onTagPress={openContextsScreen}
      />
    );
  }, [
    highlightTaskId,
    isDark,
    multiSelectedIds,
    rowActions,
    rowContext,
    selectionMode,
    themeColors,
  ]);

  return (
    <>
      {selectionMode ? (
        <TaskListBulkBar
          bulkActionLabel={bulkActionLabel}
          bulkActionLoading={bulkActionLoading}
          handleBatchDelete={handleBatchDelete}
          handleBatchMove={handleBatchMove}
          hasSelection={hasSelection}
          onExitSelectionMode={exitSelectionMode}
          onOpenTagModal={() => setTagModalVisible(true)}
          onToggleRangeSelectMode={toggleRangeSelectMode}
          rangeSelectMode={rangeSelectMode}
          selectedCount={selectedIdsArray.length}
          statusOptions={bulkStatusOptions}
          t={t}
          themeColors={themeColors}
        />
      ) : null}

      <FlatList
        data={rows}
        renderItem={renderTask}
        keyExtractor={(item) => item.kind === 'heading' ? item.id : item.task.id}
        style={listStyle ?? styles.list}
        contentContainerStyle={contentContainerStyle}
        {...TASK_LIST_WINDOWING_PROPS}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={ListHeaderComponent}
        ListFooterComponent={ListFooterComponent}
        ListEmptyComponent={ListEmptyComponent}
      />

      <TaskListTagModal
        onChangeTag={setTagInput}
        onClose={() => {
          setTagModalVisible(false);
          setTagInput('');
        }}
        onSave={handleBatchAddTag}
        t={t}
        tagInput={tagInput}
        themeColors={themeColors}
        visible={tagModalVisible}
      />
    </>
  );
}

const styles = StyleSheet.create({
  list: {
    flex: 1,
  },
  groupHeading: {
    paddingBottom: 6,
    paddingTop: 18,
  },
  groupHeadingText: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
});
