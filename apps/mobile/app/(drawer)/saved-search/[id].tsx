import React, { useMemo, useRef, useState, useCallback } from 'react';
import { View, Text, FlatList, StyleSheet, RefreshControl, TouchableOpacity, Alert } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useTaskStore, filterTasksBySearch, shallow, sortTasksBy, type Task, type TaskStatus, tFallback } from '@mindwtr/core';
import { SwipeableTaskItem, type TaskRowActions } from '@/components/swipeable-task-item';
import { TASK_LIST_WINDOWING_PROPS } from '@/components/task-list-windowing';
import { TaskEditModal } from '@/components/task-edit-modal';
import { useLanguage } from '@/contexts/language-context';
import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { useTheme } from '@/contexts/theme-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { taskMatchesAreaFilterSelection } from '@mindwtr/core';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';
import { Trash2 } from 'lucide-react-native';
import { resolveNonDoneTaskSortBy } from '@/lib/task-list-sort';

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
    updateSettings,
  } = useTaskStore((state) => ({
    tasks: state.tasks,
    projects: state.projects,
    savedSearches: state.settings?.savedSearches,
    settings: state.settings,
    updateTask: state.updateTask,
    deleteTask: state.deleteTask,
    fetchData: state.fetchData,
    updateSettings: state.updateSettings,
  }), shallow);
  const { t } = useLanguage();
  const { isDark } = useTheme();
  const tc = useThemeColors();
  const { areaById, resolvedAreaFilter } = useMobileAreaFilter();

  const goBackOrInbox = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/inbox');
  }, []);

  const savedSearch = savedSearches?.find(s => s.id === id);
  const query = savedSearch?.query || '';
  const sortBy = resolveNonDoneTaskSortBy(settings?.taskSortBy, settings);

  const filteredTasks = useMemo(() => {
    if (!query) return [];
    const projectMap = new Map(projects.map((project) => [project.id, project]));
    return sortTasksBy(
      filterTasksBySearch(tasks, projects, query).filter((task) => (
        taskMatchesAreaFilterSelection(task, resolvedAreaFilter, projectMap, areaById)
      )),
      sortBy,
    );
  }, [tasks, projects, query, sortBy, resolvedAreaFilter, areaById]);

  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  }, [fetchData]);

  const handleDeleteSearch = useCallback(() => {
    if (!savedSearch) return;
    Alert.alert(
      t('common.delete'),
      tFallback(t, 'search.deleteConfirm', `Delete "${savedSearch.name}"?`),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: async () => {
            const updated = (savedSearches || []).filter(s => s.id !== id);
            await updateSettings({ savedSearches: updated });
            goBackOrInbox();
          },
        },
      ]
    );
  }, [savedSearch, id, savedSearches, updateSettings, t, goBackOrInbox]);

  const emptyMessage = (() => {
    if (savedSearch) return t('search.noResults');
    const hasAnySavedSearches = (savedSearches?.length ?? 0) > 0;
    return hasAnySavedSearches ? t('search.noResults') : t('search.noSavedSearches');
  })();

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
              {savedSearch?.name || t('search.savedSearches')}
            </Text>
            {query ? (
              <Text style={[styles.queryText, { color: tc.secondaryText }]} numberOfLines={1}>
                {query}
              </Text>
            ) : null}
          </View>
          {savedSearch && (
            <TouchableOpacity
              onPress={handleDeleteSearch}
              style={styles.deleteButton}
              accessibilityLabel={t('common.delete')}
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
            {!savedSearch && (
              <View style={styles.emptyActions}>
                <TouchableOpacity
                  onPress={() => router.replace('/inbox')}
                  style={[styles.actionButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                >
                  <Text style={[styles.actionText, { color: tc.text }]}>{t('nav.inbox')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={goBackOrInbox}
                  style={[styles.actionButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                >
                  <Text style={[styles.actionText, { color: tc.text }]}>{t('common.back')}</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        }
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
        onFocusMode={(taskId) => {
          setIsModalVisible(false);
          router.push(`/check-focus?id=${taskId}`);
        }}
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
