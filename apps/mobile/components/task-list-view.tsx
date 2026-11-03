import React, { useCallback, useMemo, useRef } from 'react';
import { FlatList, StyleSheet, Text, TouchableOpacity, View, type StyleProp, type ViewStyle } from 'react-native';
import { formatI18nTemplate, tFallback, type Project, type Task, type TaskStatus, type ViewSectionTaskGroup } from '@mindwtr/core';

import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';
import type { ThemeColors } from '@/hooks/use-theme-colors';
import { SwipeableTaskItem, type SwipeableTaskItemRowContext, type TaskRowActions } from './swipeable-task-item';
import { TASK_LIST_WINDOWING_PROPS } from './task-list-windowing';
import { TaskListBulkBar } from './task-list/TaskListBulkBar';
import { TaskListTagModal } from './task-list/TaskListTagModal';
import type { useTaskListSelection } from './use-task-list-selection';


export type TaskListViewSelection = ReturnType<typeof useTaskListSelection>;
type TaskListViewRow =
  | { kind: 'heading'; id: string; title: string; muted?: boolean }
  | { kind: 'project'; project: Project }
  | { kind: 'task'; task: Task };

export interface TaskListViewProps {

  tasks: Task[];

  taskGroups?: readonly ViewSectionTaskGroup[];

  renderProject?: (project: Project) => React.ReactElement;
  isDark: boolean;
  themeColors: ThemeColors;
  t: (key: string) => string;


  onPressTask: (task: Task) => void;
  onChangeTaskStatus: (task: Task, status: TaskStatus) => void | Promise<unknown>;
  onDeleteTask: (task: Task) => void | Promise<unknown>;
  onMoveTaskToSection?: (task: Task) => void;
  onMoveSelectionToSection?: () => void;
  onAddTaskToSection?: (groupId: string) => void;
  highlightTaskId?: string | null;
  rowContext?: SwipeableTaskItemRowContext;

  showDetails?: boolean;


  selection: TaskListViewSelection;

  bulkStatusOptions: readonly TaskStatus[];


  ListHeaderComponent?: React.ComponentProps<typeof FlatList>['ListHeaderComponent'];
  ListFooterComponent?: React.ComponentProps<typeof FlatList>['ListFooterComponent'];
  ListEmptyComponent?: React.ComponentProps<typeof FlatList>['ListEmptyComponent'];

  contentContainerStyle?: StyleProp<ViewStyle>;
  listStyle?: StyleProp<ViewStyle>;
}


export function TaskListView({
  tasks,
  taskGroups,
  renderProject,
  isDark,
  themeColors,
  t,
  onPressTask,
  onChangeTaskStatus,
  onDeleteTask,
  onMoveTaskToSection,
  onMoveSelectionToSection,
  onAddTaskToSection,
  highlightTaskId,
  rowContext,
  showDetails = true,
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
      ...(renderProject ? group.projects ?? [] : []).map((project) => ({ kind: 'project' as const, project })),
      ...group.tasks.map((task) => ({ kind: 'task' as const, task })),
    ]);
  }, [renderProject, taskGroups, tasks]);


  const rowActionSourcesRef = useRef({
    onPressTask,
    onChangeTaskStatus,
    onDeleteTask,
    onMoveTaskToSection,
    toggleMultiSelect,
    visibleTaskIds,
  });
  rowActionSourcesRef.current = {
    onPressTask,
    onChangeTaskStatus,
    onDeleteTask,
    onMoveTaskToSection,
    toggleMultiSelect,
    visibleTaskIds,
  };
  const hasSectionMove = Boolean(onMoveTaskToSection);
  const rowActions = useMemo<TaskRowActions>(() => ({
    edit: (task) => rowActionSourcesRef.current.onPressTask(task),
    changeStatus: (task, status) => rowActionSourcesRef.current.onChangeTaskStatus(task, status),
    remove: (task) => rowActionSourcesRef.current.onDeleteTask(task),
    ...(hasSectionMove ? {
      moveToSection: (task: Task) => rowActionSourcesRef.current.onMoveTaskToSection?.(task),
    } : {}),
    toggleSelect: (task) => {
      const sources = rowActionSourcesRef.current;
      sources.toggleMultiSelect(task.id, { visibleTaskIds: sources.visibleTaskIds });
    },
  }), [hasSectionMove]);

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
          {onAddTaskToSection ? (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={formatI18nTemplate(tFallback(t, 'viewSections.addTask', 'Add task to {section}'), { section: item.title })}
              onPress={() => onAddTaskToSection(item.id)}
              style={styles.groupAddButton}
            >
              <Text style={{ color: themeColors.tint }}>
                {tFallback(t, 'nav.addTask', 'Add task')}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>
      );
    }
    if (item.kind === 'project') return renderProject?.(item.project) ?? null;
    const task = item.task;
    return (
      <SwipeableTaskItem
        task={task}
        hideDetails={!showDetails}
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
    onAddTaskToSection,
    renderProject,
    t,
    rowContext,
    selectionMode,
    showDetails,
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
          onMoveToSection={onMoveSelectionToSection}
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
        keyExtractor={(item) => item.kind === 'heading' ? item.id : item.kind === 'project' ? `project:${item.project.id}` : item.task.id}
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
    alignItems: 'center',
    flexDirection: 'row',
    paddingBottom: 6,
    paddingTop: 18,
  },
  groupHeadingText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  groupAddButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
});
