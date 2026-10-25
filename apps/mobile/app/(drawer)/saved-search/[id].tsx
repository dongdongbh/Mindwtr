import React, { useMemo, useRef, useState, useCallback } from 'react';
import { View, Text, FlatList, StyleSheet, RefreshControl, TouchableOpacity, Alert } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import {
  buildSavedSearchScreenText,
  deleteSavedSearchById,
  findSavedSearch,
  getSavedSearchGlobalSortLabel,
  getSavedSearchOwnSortBy,
  getTaskListHeaderText,
  getTaskSortByLabel,
  resolveSavedSearchSortBy,
  selectSavedSearchTasks,
  setSavedSearchSortById,
  shallow,
  TASK_LIST_SORT_OPTIONS,
  useTaskStore,
  type Task,
  type TaskStatus,
} from '@mindwtr/core';
import { SwipeableTaskItem, type TaskRowActions } from '@/components/swipeable-task-item';
import { TASK_LIST_WINDOWING_PROPS } from '@/components/task-list-windowing';
import { TaskListSortButton } from '@/components/task-list/TaskListSortButton';
import { TaskListSortModal } from '@/components/task-list/TaskListSortModal';
import { TaskEditModal } from '@/components/task-edit-modal';
import { useLanguage } from '@/contexts/language-context';
import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { useTheme } from '@/contexts/theme-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';
import { Trash2 } from 'lucide-react-native';

export default function SavedSearchScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const {
    tasks,
    projects,
    savedSearches,
    settings,
    updateTask,
    deleteTask,
    fetchData,
  } = useTaskStore((state) => ({
    tasks: state.tasks,
    projects: state.projects,
    savedSearches: state.settings?.savedSearches,
    settings: state.settings,
    updateTask: state.updateTask,
    deleteTask: state.deleteTask,
    fetchData: state.fetchData,
  }), shallow);
  const { t } = useLanguage();
  const { isDark } = useTheme();
  const tc = useThemeColors();
  const { areaById, resolvedAreaFilter } = useMobileAreaFilter();

  const goBackOrInbox = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/inbox');
  }, []);

  const savedSearch = findSavedSearch(savedSearches, id);
  const query = savedSearch?.query || '';
  // The saved search's own sort, else the global one (#1453). Opening the screen writes nothing.
  const sortBy = resolveSavedSearchSortBy(savedSearch, settings);
  const ownSortBy = getSavedSearchOwnSortBy(savedSearch, settings);
  const [sortModalVisible, setSortModalVisible] = useState(false);
  // The header, the delete confirmation and the empty state come from core, as the native host shows them.
  const screenText = buildSavedSearchScreenText({ savedSearch, savedSearches, t });

  const filteredTasks = useMemo(() => selectSavedSearchTasks({
    query,
    tasks,
    projects,
    areaFilter: resolvedAreaFilter,
    areaById,
    sortBy,
  }), [tasks, projects, query, sortBy, resolvedAreaFilter, areaById]);

  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  }, [fetchData]);

  const deleteAction = screenText.deleteAction;
  const handleDeleteSearch = useCallback(() => {
    if (!deleteAction) return;
    Alert.alert(
      deleteAction.confirm.title,
      deleteAction.confirm.message,
      [
        { text: deleteAction.confirm.cancelLabel, style: 'cancel' },
        {
          text: deleteAction.confirm.confirmLabel,
          style: 'destructive',
          onPress: async () => {
            // Delete by ID against the saved searches as they are now: one added or
            // changed while the confirmation was open stays.
            await deleteSavedSearchById(id);
            goBackOrInbox();
          },
        },
      ]
    );
  }, [deleteAction, id, goBackOrInbox]);

  const emptyMessage = screenText.empty.message;
  const sortAccessibilityLabel = getTaskListHeaderText({
    sortByLabel: getTaskSortByLabel(sortBy, t),
    hasActiveFilters: false,
    filterActiveCount: 0,
    t,
  }).sortAccessibilityLabel;
  const chooseSort = (option: typeof ownSortBy) => {
    setSortModalVisible(false);
    void setSavedSearchSortById(id, option);
  };

  // One actions object for every row, reading the current store handlers from a
  // ref, so a result-list re-render leaves untouched rows alone (#766).
  const rowSourcesRef = useRef({ updateTask, deleteTask });
  rowSourcesRef.current = { updateTask, deleteTask };
  const rowActions = useMemo<TaskRowActions>(() => ({
    edit: (task) => {
      setEditingTask(task);
      setIsModalVisible(true);
    },
    changeStatus: (task, status) => rowSourcesRef.current.updateTask(task.id, { status: status as TaskStatus }),
    remove: (task) => rowSourcesRef.current.deleteTask(task.id),
  }), []);

  const renderTask = useCallback(({ item }: { item: Task }) => (
    <SwipeableTaskItem
      task={item}
      isDark={isDark}
      tc={tc}
      actions={rowActions}
      onProjectPress={openProjectScreen}
      onContextPress={openContextsScreen}
      onTagPress={openContextsScreen}
    />
  ), [isDark, rowActions, tc]);

  return (
    <View style={[styles.container, { backgroundColor: tc.bg }]}>
      <View style={[styles.header, { borderBottomColor: tc.border }]}>
        <View style={styles.headerContent}>
          <View style={styles.headerText}>
            <Text style={[styles.title, { color: tc.text }]} accessibilityRole="header">
              {screenText.title}
            </Text>
            {screenText.query ? (
              <Text style={[styles.queryText, { color: tc.secondaryText }]} numberOfLines={1}>
                {screenText.query}
              </Text>
            ) : null}
          </View>
          {savedSearch && (
            <TaskListSortButton
              accessibilityLabel={sortAccessibilityLabel}
              onPress={() => setSortModalVisible(true)}
              themeColors={tc}
            />
          )}
          {deleteAction && (
            <TouchableOpacity
              onPress={handleDeleteSearch}
              style={styles.deleteButton}
              accessibilityRole="button"
              accessibilityLabel={deleteAction.label}
            >
              <Trash2 size={20} color="#EF4444" />
            </TouchableOpacity>
          )}
        </View>
      </View>

      <FlatList
        data={filteredTasks}
        renderItem={renderTask}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        {...TASK_LIST_WINDOWING_PROPS}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
              {emptyMessage}
            </Text>
            {screenText.empty.actions && (
              <View style={styles.emptyActions}>
                <TouchableOpacity
                  onPress={() => router.replace('/inbox')}
                  style={[styles.actionButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                >
                  <Text style={[styles.actionText, { color: tc.text }]}>{screenText.empty.actions.inboxLabel}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={goBackOrInbox}
                  style={[styles.actionButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                >
                  <Text style={[styles.actionText, { color: tc.text }]}>{screenText.empty.actions.backLabel}</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        }
      />

      <TaskListSortModal
        inheritOption={{
          label: getSavedSearchGlobalSortLabel(settings, t),
          selected: ownSortBy === null,
          onSelect: () => chooseSort(null),
        }}
        onClose={() => setSortModalVisible(false)}
        onSelect={chooseSort}
        sortBy={sortBy}
        sortOptions={TASK_LIST_SORT_OPTIONS}
        t={t}
        themeColors={tc}
        visible={sortModalVisible}
      />

      <TaskEditModal
        visible={isModalVisible}
        task={editingTask}
        onClose={() => setIsModalVisible(false)}
        onSave={(taskId, updates) => {
          const result = updateTask(taskId, updates);
          setIsModalVisible(false);
          setEditingTask(null);
          return result;
        }}
        defaultTab="view"
        onProjectNavigate={openProjectScreen}
        onContextNavigate={openContextsScreen}
        onTagNavigate={openContextsScreen}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    padding: 16,
    borderBottomWidth: 1,
  },
  headerContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  headerText: {
    flex: 1,
    gap: 4,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
  },
  queryText: {
    fontSize: 12,
  },
  deleteButton: {
    padding: 8,
    marginLeft: 8,
  },
  listContent: {
    padding: 16,
  },
  emptyContainer: {
    padding: 32,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 16,
  },
  emptyActions: {
    marginTop: 16,
    flexDirection: 'row',
    gap: 12,
  },
  actionButton: {
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  actionText: {
    fontSize: 14,
    fontWeight: '600',
  },
});
