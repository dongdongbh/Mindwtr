import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, RefreshControl, Text, View } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { shallow, useTaskStore, type Task, type TaskStatus } from '@mindwtr/core';
import { SwipeableTaskItem, type TaskRowActions } from '@/components/swipeable-task-item';
import { TaskEditModal } from '@/components/task-edit-modal';
import { TASK_LIST_WINDOWING_PROPS } from '@/components/task-list-windowing';
import { useLanguage } from '@/contexts/language-context';
import { useTheme } from '@/contexts/theme-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { resolveWidgetListDestination } from '@/lib/widget-list-destination';
import { logInfo } from '@/lib/app-log';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';

/** An exact widget list destination, not an additional main navigation item. */
export default function WidgetListScreen() {
  const { id, source } = useLocalSearchParams<{ id?: string | string[]; source?: string }>();
  const data = useTaskStore((state) => ({
    // Match widget publication's canonical pools: parent tombstones must remain
    // present so the shared visibility predicate can exclude their children.
    tasks: state._allTasks?.length ? state._allTasks : state.tasks,
    projects: state._allProjects?.length ? state._allProjects : state.projects,
    sections: state._allSections?.length ? state._allSections : state.sections,
    areas: state._allAreas?.length ? state._allAreas : state.areas,
    settings: state.settings,
  }), shallow);
  const { language, t } = useLanguage();
  const { isDark } = useTheme();
  const tc = useThemeColors();
  const list = useMemo(() => resolveWidgetListDestination(data, language, id), [data, id, language]);
  const title = list?.title ?? t('search.noResults');
  const available = Boolean(list);
  useEffect(() => {
    if (source !== 'shortcut') return;
    void logInfo('Saved list shortcut destination resolved', {
      scope: 'shortcuts',
      extra: { releaseCheck: 'v1.3.3/saved-list-shortcut', available },
    });
  }, [source, id, available]);
  const listKind = id === 'next' ? 'next' : typeof id === 'string' && id.startsWith('project:') ? 'project' : 'filter';
  const { updateTask, deleteTask, fetchData } = useTaskStore((state) => ({
    updateTask: state.updateTask,
    deleteTask: state.deleteTask,
    fetchData: state.fetchData,
  }), shallow);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const handlers = useRef({ updateTask, deleteTask });
  handlers.current = { updateTask, deleteTask };
  const actions = useMemo<TaskRowActions>(() => ({
    edit: setEditingTask,
    changeStatus: (task, status) => handlers.current.updateTask(task.id, { status: status as TaskStatus }),
    remove: (task) => handlers.current.deleteTask(task.id),
  }), []);
  const renderTask = useCallback(({ item }: { item: Task }) => (
    <SwipeableTaskItem
      task={item}
      isDark={isDark}
      tc={tc}
      actions={actions}
      onProjectPress={openProjectScreen}
      onContextPress={openContextsScreen}
      onTagPress={openContextsScreen}
    />
  ), [actions, isDark, tc]);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try { await fetchData(); } finally { setRefreshing(false); }
  }, [fetchData]);
  return (
    <View style={{ flex: 1, backgroundColor: tc.bg }}>
      <Stack.Screen options={{ title }} />
      {/* This pool is already filtered and ordered by the widget's shared core
          projection. Do not apply unrelated in-app area/filter selections again. */}
      <FlatList
        data={list?.tasks ?? []}
        renderItem={renderTask}
        keyExtractor={(task) => task.id}
        contentContainerStyle={{ padding: 16 }}
        {...TASK_LIST_WINDOWING_PROPS}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        ListEmptyComponent={<Text style={{ color: tc.secondaryText, padding: 24, textAlign: 'center' }}>{t('search.noResults')}</Text>}
      />
      <TaskEditModal
        visible={Boolean(editingTask)}
        task={editingTask}
        defaultTab="view"
        onClose={() => setEditingTask(null)}
        onSave={(taskId, updates) => {
          const result = updateTask(taskId, updates);
          setEditingTask(null);
          return result;
        }}
        onProjectNavigate={openProjectScreen}
        onContextNavigate={openContextsScreen}
        onTagNavigate={openContextsScreen}
        onFocusMode={(taskId) => {
          setEditingTask(null);
          router.push(`/check-focus?id=${taskId}`);
        }}
      />
    </View>
  );
}
