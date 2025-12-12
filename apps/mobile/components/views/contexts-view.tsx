import { View, Text, ScrollView, Pressable, StyleSheet, TextInput } from 'react-native';
import { useTaskStore, PRESET_CONTEXTS, sortTasksBy, matchesHierarchicalToken, type TaskSortBy } from '@mindwtr/core';
import type { Task, TaskStatus } from '@mindwtr/core';
import { useState } from 'react';
import { useTheme } from '../../contexts/theme-context';
import { useLanguage } from '../../contexts/language-context';

import { useThemeColors } from '@/hooks/use-theme-colors';
import { TaskEditModal } from '../task-edit-modal';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SwipeableTaskItem } from '../swipeable-task-item';


export function ContextsView() {
  const { tasks, updateTask, deleteTask, settings } = useTaskStore();
  const { isDark } = useTheme();
  const { t } = useLanguage();
  const [selectedContext, setSelectedContext] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [editingTask, setEditingTask] = useState<Task | null>(null);

  const tc = useThemeColors();

  // Combine preset contexts with contexts from tasks
  const allContexts = Array.from(
    new Set([...PRESET_CONTEXTS, ...tasks.flatMap((t) => [...(t.contexts || []), ...(t.tags || [])])])
  ).sort();

  // Filter contexts by search query
  const filteredContexts = searchQuery
    ? allContexts.filter((ctx) => ctx.toLowerCase().includes(searchQuery.toLowerCase()))
    : allContexts;

  // ...

  const activeTasks = tasks.filter((t) => t.status !== 'done' && t.status !== 'archived' && !t.deletedAt);
  const matchesSelected = (task: Task, context: string) => {
    const tokens = [...(task.contexts || []), ...(task.tags || [])];
    return tokens.some(token => matchesHierarchicalToken(context, token));
  };
  const filteredTasks = selectedContext
    ? activeTasks.filter((t) => matchesSelected(t, selectedContext))
    : activeTasks.filter((t) => (t.contexts?.length || 0) > 0 || (t.tags?.length || 0) > 0);

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
        <View style={[styles.header, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
          <Text style={[styles.title, { color: tc.text }]}>{t('contexts.title')}</Text>
          <Text style={[styles.subtitle, { color: tc.secondaryText }]}>{t('contexts.filter')}</Text>
        </View>

        {/* Search box for contexts */}
        <View style={[styles.searchContainer, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
          <TextInput
            style={[styles.searchInput, { backgroundColor: tc.inputBg, color: tc.text }]}
            placeholder={t('contexts.search') || 'Search contexts...'}
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
              { backgroundColor: isDark ? '#374151' : '#F3F4F6' },
              selectedContext === null && styles.contextButtonActive,
            ]}
            onPress={() => setSelectedContext(null)}
          >
            <Text
              style={[
                styles.contextButtonText,
                { color: isDark ? '#D1D5DB' : '#4B5563' },
                selectedContext === null && styles.contextButtonTextActive,
              ]}
            >
              {t('contexts.all')}
            </Text>
            <View style={styles.contextBadge}>
              <Text style={styles.contextBadgeText}>
                {activeTasks.filter((t) => (t.contexts?.length || 0) > 0 || (t.tags?.length || 0) > 0).length}
              </Text>
            </View>
          </Pressable>

          {filteredContexts.map((context) => {
            const count = activeTasks.filter((t) => matchesSelected(t, context)).length;
            return (
              <Pressable
                key={context}
                style={[
                  styles.contextButton,
                  { backgroundColor: isDark ? '#374151' : '#F3F4F6' },
                  selectedContext === context && styles.contextButtonActive,
                ]}
                onPress={() => setSelectedContext(context)}
              >
                <Text
                  style={[
                    styles.contextButtonText,
                    { color: isDark ? '#D1D5DB' : '#4B5563' },
                    selectedContext === context && styles.contextButtonTextActive,
                  ]}
                >
                  {context}
                </Text>
                <View style={styles.contextBadge}>
                  <Text style={styles.contextBadgeText}>{count}</Text>
                </View>
              </Pressable>
            );
          })}
        </ScrollView>

        <View style={styles.content}>
          <View style={[styles.contentHeader, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
            <Text style={[styles.contentTitle, { color: tc.text }]}>
              {selectedContext || t('contexts.all')}
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
                      {selectedContext
                        ? `${t('contexts.noTasks')} ${selectedContext}`
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
  header: {
    backgroundColor: '#FFFFFF',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#111827',
  },
  subtitle: {
    fontSize: 14,
    color: '#6B7280',
    marginTop: 4,
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
  },
  contextButtonActive: {
    backgroundColor: '#3B82F6',
  },
  contextButtonText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#4B5563',
  },
  contextButtonTextActive: {
    color: '#FFFFFF',
  },
  contextBadge: {
    backgroundColor: 'rgba(0, 0, 0, 0.15)',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 8,
    minWidth: 18,
    alignItems: 'center',
  },
  contextBadgeText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#374151',
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
