import { View, Text, ScrollView, Pressable, StyleSheet, TextInput } from 'react-native';
import { useTaskStore, getUsedTaskTokens, sortTasksBy, matchesHierarchicalToken, type Task, type TaskSortBy, type TaskStatus } from '@mindwtr/core';
import { useState } from 'react';
import { useTheme } from '../../contexts/theme-context';
import { useLanguage } from '../../contexts/language-context';

import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { taskMatchesAreaFilter } from '@/lib/area-filter';
import { TaskEditModal } from '../task-edit-modal';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SwipeableTaskItem } from '../swipeable-task-item';


export function ContextsView() {
  const { tasks, projects, updateTask, deleteTask, settings } = useTaskStore();
  const { isDark } = useTheme();
  const { t } = useLanguage();
  const [selectedContexts, setSelectedContexts] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [editingTask, setEditingTask] = useState<Task | null>(null);

  const tc = useThemeColors();
  const { areaById, resolvedAreaFilter } = useMobileAreaFilter();
  const projectById = new Map(projects.map((project) => [project.id, project]));

  const NO_CONTEXT_TOKEN = '__no_context__';

  // Combine preset contexts with contexts from tasks
  const contextSourceTasks = tasks.filter((task) => (
    !task.deletedAt
    && task.status !== 'archived'
    && taskMatchesAreaFilter(task, resolvedAreaFilter, projectById, areaById)
  ));
  const allContexts = getUsedTaskTokens(
    contextSourceTasks,
    (task) => [...(task.contexts || []), ...(task.tags || [])]
  );

  // Filter contexts by search query
  const filteredContexts = searchQuery
    ? allContexts.filter((ctx) => ctx.toLowerCase().includes(searchQuery.toLowerCase()))
    : allContexts;

  // ...

  const activeTasks = contextSourceTasks;
  const hasContext = (task: Task) => (task.contexts?.length || 0) > 0 || (task.tags?.length || 0) > 0;
  const matchesSelected = (task: Task, context: string) => {
    const tokens = [...(task.contexts || []), ...(task.tags || [])];
    return tokens.some(token => matchesHierarchicalToken(context, token));
  };
  const noContextSelected = selectedContexts.includes(NO_CONTEXT_TOKEN);
  const filteredTasks = noContextSelected
    ? activeTasks.filter((t) => !hasContext(t))
    : selectedContexts.length > 0
      ? activeTasks.filter((t) => selectedContexts.every((ctx) => matchesSelected(t, ctx)))
      : activeTasks.filter((t) => hasContext(t));

  const sortBy = (settings?.taskSortBy ?? 'default') as TaskSortBy;
  const sortedTasks = sortTasksBy(filteredTasks, sortBy);

  const handleStatusChange = (taskId: string, newStatus: TaskStatus) => {
    updateTask(taskId, { status: newStatus });
  };

  const handleDelete = (taskId: string) => {
    deleteTask(taskId);
  };

  const handleSaveTask = (taskId: string, updates: Partial<Task>) => {
    updateTask(taskId, updates);
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={[styles.container, { backgroundColor: tc.bg }]}>
        {/* Search box for contexts */}
        <View style={[styles.searchContainer, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
          <TextInput
            style={[styles.searchInput, { backgroundColor: tc.inputBg, color: tc.text }]}
            placeholder={t('contexts.search')}
            placeholderTextColor={tc.secondaryText}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={[styles.contextsBar, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}
          contentContainerStyle={styles.contextsBarContent}
        >
          <Pressable
            style={[
              styles.contextButton,
              {
                backgroundColor: selectedContexts.length === 0 ? tc.tint : tc.filterBg,
                borderColor: tc.border,
              },
            ]}
            onPress={() => setSelectedContexts([])}
          >
            <Text
              style={[
                styles.contextButtonText,
                { color: selectedContexts.length === 0 ? '#FFFFFF' : tc.text },
              ]}
            >
              {t('contexts.all')}
            </Text>
            <View
              style={[
                styles.contextBadge,
                {
                  backgroundColor:
                    selectedContexts.length === 0
                      ? 'rgba(255, 255, 255, 0.25)'
                      : isDark
                        ? 'rgba(255, 255, 255, 0.12)'
                        : 'rgba(0, 0, 0, 0.08)',
                },
              ]}
            >
              <Text style={[styles.contextBadgeText, { color: selectedContexts.length === 0 ? '#FFFFFF' : tc.secondaryText }]}>
              {activeTasks.filter((t) => (t.contexts?.length || 0) > 0 || (t.tags?.length || 0) > 0).length}
            </Text>
          </View>
        </Pressable>

          <Pressable
            style={[
              styles.contextButton,
              {
                backgroundColor: noContextSelected ? tc.tint : tc.filterBg,
                borderColor: tc.border,
              },
            ]}
            onPress={() => setSelectedContexts(noContextSelected ? [] : [NO_CONTEXT_TOKEN])}
          >
            <Text
              style={[
                styles.contextButtonText,
                { color: noContextSelected ? '#FFFFFF' : tc.text },
              ]}
            >
              {t('contexts.none')}
            </Text>
            <View
              style={[
                styles.contextBadge,
                {
                  backgroundColor: noContextSelected
                    ? 'rgba(255, 255, 255, 0.25)'
                    : isDark
                      ? 'rgba(255, 255, 255, 0.12)'
                      : 'rgba(0, 0, 0, 0.08)',
                },
              ]}
            >
              <Text style={[styles.contextBadgeText, { color: noContextSelected ? '#FFFFFF' : tc.secondaryText }]}>
                {activeTasks.filter((t) => !hasContext(t)).length}
              </Text>
            </View>
          </Pressable>

          {filteredContexts.map((context) => {
            const count = activeTasks.filter((t) => matchesSelected(t, context)).length;
            const isActive = selectedContexts.includes(context);
            return (
              <Pressable
                key={context}
                style={[
                  styles.contextButton,
                  { backgroundColor: isActive ? tc.tint : tc.filterBg, borderColor: tc.border },
                ]}
                onPress={() => setSelectedContexts((prev) => {
                  if (prev.includes(NO_CONTEXT_TOKEN)) {
                    return [context];
                  }
                  return prev.includes(context) ? prev.filter((item) => item !== context) : [...prev, context];
                })}
              >
                <Text
                  style={[
                    styles.contextButtonText,
                    { color: isActive ? '#FFFFFF' : tc.text },
                  ]}
                >
                  {context}
                </Text>
                <View
                  style={[
                    styles.contextBadge,
                    {
                      backgroundColor: isActive
                        ? 'rgba(255, 255, 255, 0.25)'
                        : isDark
                          ? 'rgba(255, 255, 255, 0.12)'
                          : 'rgba(0, 0, 0, 0.08)',
                    },
                  ]}
                >
                  <Text style={[styles.contextBadgeText, { color: isActive ? '#FFFFFF' : tc.secondaryText }]}>{count}</Text>
                </View>
              </Pressable>
            );
          })}
        </ScrollView>

        <View style={styles.content}>
          <View style={[styles.contentHeader, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
            <Text style={[styles.contentTitle, { color: tc.text }]}>
              {noContextSelected
                ? t('contexts.none')
                : (selectedContexts.length > 0 ? selectedContexts.join(', ') : t('contexts.all'))}
            </Text>
            <Text style={[styles.contentCount, { color: tc.secondaryText }]}>{sortedTasks.length} {t('common.tasks')}</Text>
          </View>

          <ScrollView style={[styles.taskList, { backgroundColor: tc.bg }]} showsVerticalScrollIndicator={false}>
            {sortedTasks.length > 0 ? (
              sortedTasks.map((task) => (
                <SwipeableTaskItem
                  key={task.id}
                  task={task}
                  isDark={isDark}
                  tc={tc}
                  onPress={() => setEditingTask(task)}
                  onStatusChange={(status) => handleStatusChange(task.id, status)}
                  onDelete={() => handleDelete(task.id)}
                />
              ))
            ) : (
              <View style={styles.emptyState}>
                {allContexts.length === 0 ? (
                  <>
                    <Text style={styles.emptyIcon}>🏷️</Text>
                    <Text style={[styles.emptyTitle, { color: tc.text }]}>{t('contexts.noContexts').split('.')[0]}</Text>
                    <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
                      {t('contexts.noContexts')}
                    </Text>
                  </>
                ) : (
                  <>
                    <Text style={styles.emptyIcon}>✓</Text>
                    <Text style={[styles.emptyTitle, { color: tc.text }]}>{t('contexts.noTasks')}</Text>
                    <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
                      {selectedContexts.length > 0
                        ? `${t('contexts.noTasks')} ${selectedContexts.join(', ')}`
                        : t('contexts.noTasks')}
                    </Text>
                  </>
                )}
              </View>
            )}
          </ScrollView>
        </View>

        {/* Task Edit Modal */}
        <TaskEditModal
          visible={editingTask !== null}
          task={editingTask}
          onClose={() => setEditingTask(null)}
          onSave={handleSaveTask}
          defaultTab="view"
        />
      </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  searchContainer: {
    padding: 12,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  searchInput: {
    height: 40,
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 16,
  },
  contextsBar: {
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
    maxHeight: 48,
  },
  contextsBarContent: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 6,
    alignItems: 'center',
  },
  contextButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#F3F4F6',
    borderWidth: 1,
  },
  contextButtonText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#4B5563',
  },
  contextBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 8,
    minWidth: 18,
    alignItems: 'center',
  },
  contextBadgeText: {
    fontSize: 10,
    fontWeight: '600',
  },
  content: {
    flex: 1,
  },
  contentHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  contentTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
  },
  contentCount: {
    fontSize: 14,
    color: '#6B7280',
  },
  taskList: {
    flex: 1,
    padding: 16,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
    paddingHorizontal: 24,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
  },
});
