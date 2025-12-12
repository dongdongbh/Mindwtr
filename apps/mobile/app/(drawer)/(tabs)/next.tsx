import React, { useCallback, useState } from 'react';
import { useRouter } from 'expo-router';
import { View, Text, FlatList, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { useTaskStore, PRESET_CONTEXTS, sortTasksBy, matchesHierarchicalToken, type Task, type Project, type TaskSortBy } from '@mindwtr/core';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { TaskEditModal } from '@/components/task-edit-modal';

import { useTheme } from '../../../contexts/theme-context';
import { useLanguage } from '../../../contexts/language-context';

import { useThemeColors } from '@/hooks/use-theme-colors';
import { SwipeableTaskItem } from '@/components/swipeable-task-item';


export default function NextActionsScreen() {
  const router = useRouter();
  const { tasks, projects, updateTask, deleteTask, settings } = useTaskStore();
  const { isDark } = useTheme();
  const { t } = useLanguage();
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [selectedContext, setSelectedContext] = useState<string | null>(null);

  // Theme colors
  // Theme colors
  const tc = useThemeColors();
  const sortBy = (settings?.taskSortBy ?? 'default') as TaskSortBy;

  // Get all unique contexts from tasks (merge with presets)
  const allContexts = Array.from(new Set([
    ...PRESET_CONTEXTS,
    ...tasks.flatMap(t => t.contexts || [])
  ])).sort();

  const projectMap = React.useMemo(() => {
    return projects.reduce((acc, project) => {
      acc[project.id] = project;
      return acc;
    }, {} as Record<string, Project>);
  }, [projects]);

  // For sequential projects, find the first (oldest) next task per project
  const sequentialProjectFirstTasks = React.useMemo(() => {
    const sequentialProjects = projects.filter(p => p.isSequential);
    const firstTaskIds = new Set<string>();

    for (const project of sequentialProjects) {
      const projectTasks = tasks
        .filter(t => t.projectId === project.id && t.status === 'next' && !t.deletedAt)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

      if (projectTasks.length > 0) {
        firstTaskIds.add(projectTasks[0].id);
      }
    }
    return firstTaskIds;
  }, [tasks, projects]);

  const matchesSelectedContext = (task: Task, context: string | null) => {
    if (!context) return true;
    return (task.contexts || []).some(ctx => matchesHierarchicalToken(context, ctx));
  };

  const nextTasks = sortTasksBy(tasks.filter(t => {
    if (t.deletedAt) return false;
    if (t.status !== 'next') return false;
    if (!matchesSelectedContext(t, selectedContext)) return false;
    // Sequential project filter
    if (t.projectId) {
      const project = projectMap[t.projectId];
      if (project?.isSequential && !sequentialProjectFirstTasks.has(t.id)) return false;
    }
    return true;
  }), sortBy);

  const todoTasks = sortTasksBy(tasks.filter(t => {
    if (t.deletedAt) return false;
    if (t.status !== 'todo') return false;
    if (!matchesSelectedContext(t, selectedContext)) return false;
    return true;
  }), sortBy);

  const handlePromote = useCallback((taskId: string) => {
    updateTask(taskId, { status: 'next' });
  }, [updateTask]);



  const onEdit = useCallback((task: Task) => {
    setEditingTask(task);
    setIsModalVisible(true);
  }, []);

  const onSaveTask = useCallback((taskId: string, updates: Partial<Task>) => {
    updateTask(taskId, updates);
  }, [updateTask]);

  const renderContextFilter = () => (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={[styles.contextBar, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}
      contentContainerStyle={styles.contextBarContent}
    >
      <TouchableOpacity
        style={[
          styles.contextChip,
          { backgroundColor: tc.filterBg },
          selectedContext === null && styles.contextChipActive
        ]}
        onPress={() => setSelectedContext(null)}
      >
        <Text style={[
          styles.contextChipText,
          selectedContext === null && styles.contextChipTextActive
        ]}>
          {t('common.all')}
        </Text>
      </TouchableOpacity>
      {allContexts.map(context => {
        const count = tasks.filter(t =>
          (t.status === 'next' || t.status === 'todo') &&
          matchesSelectedContext(t, context)
        ).length;
        return (
          <TouchableOpacity
            key={context}
            style={[
              styles.contextChip,
              { backgroundColor: tc.filterBg },
              selectedContext === context && styles.contextChipActive
            ]}
            onPress={() => setSelectedContext(context)}
          >
            <Text style={[
              styles.contextChipText,
              selectedContext === context && styles.contextChipTextActive
            ]}>
              {context} {count > 0 && `(${count})`}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );

  const renderNextItem = useCallback(({ item }: { item: Task }) => (
    <SwipeableTaskItem
      task={item}
      isDark={isDark}
      tc={tc}
      onPress={() => onEdit(item)}
      onStatusChange={(status) => updateTask(item.id, { status })}
      onDelete={() => deleteTask(item.id)}
    />
  ), [onEdit, tc, updateTask, deleteTask, isDark]);

  const renderTodoItem = useCallback(({ item }: { item: Task }) => (
    <View style={[styles.todoItem, { backgroundColor: tc.filterBg }]}>
      <View style={styles.todoContent}>
        <Text style={[styles.todoTitle, { color: tc.secondaryText }]}>{item.title}</Text>
        {item.contexts && item.contexts.length > 0 && (
          <Text style={[styles.contextBadge, { color: '#3B82F6' }]}>
            {item.contexts[0]}
          </Text>
        )}
      </View>
      <TouchableOpacity onPress={() => handlePromote(item.id)} style={styles.promoteButton}>
        <IconSymbol name="arrow.up.circle.fill" size={24} color="#3B82F6" />
      </TouchableOpacity>
    </View>
  ), [handlePromote, tc]);

  return (
    <View style={[styles.container, { backgroundColor: tc.bg }]}>
      <View style={[styles.header, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
        <Text style={[styles.headerTitle, { color: tc.text }]}>{t('next.title')}</Text>
        <Text style={[styles.headerSubtitle, { color: tc.secondaryText }]}>
          {nextTasks.length} {t('next.ready')}
          {selectedContext && ` • ${selectedContext} `}
        </Text>
      </View>

      {renderContextFilter()}

      {/* Next Actions Warning */}
      {nextTasks.length > 15 && (
        <View style={[styles.warningBanner, { backgroundColor: isDark ? '#78350F' : '#FEF3C7', borderColor: '#F59E0B' }]}>
          <Text style={[styles.warningText, { color: isDark ? '#FCD34D' : '#92400E' }]}>
            ⚠️ {nextTasks.length} items in Next Actions. Consider focusing on fewer projects.
          </Text>
        </View>
      )}

      <FlatList
        data={nextTasks}
        renderItem={renderNextItem}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          todoTasks.length > 0 ? (
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: tc.text }]}>{t('next.current')}</Text>
            </View>
          ) : null
        }
        ListFooterComponent={
          todoTasks.length > 0 ? (
            <View style={[styles.todoSection, { borderTopColor: tc.border }]}>
              <View style={styles.sectionHeader}>
                <Text style={[styles.sectionTitle, { color: tc.text }]}>{t('next.promote')} ({todoTasks.length})</Text>
                <Text style={[styles.sectionSubtitle, { color: tc.secondaryText }]}>{t('next.promoteHint')}</Text>
              </View>
              <FlatList
                data={todoTasks}
                renderItem={renderTodoItem}
                keyExtractor={item => item.id}
                scrollEnabled={false}
              />
            </View>
          ) : (
            <View style={styles.emptyContainer}>
              <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
                {selectedContext
                  ? `${t('next.noContext')} ${selectedContext} `
                  : t('next.noTasks')}
              </Text>
            </View>
          )
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
              {selectedContext
                ? `${t('next.noContext')} ${selectedContext} `
                : t('next.noTasks')}
            </Text>
          </View>
        }
      />

      <TaskEditModal
        visible={isModalVisible}
        task={editingTask}
        onClose={() => setIsModalVisible(false)}
        onSave={onSaveTask}
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
  headerTitle: {
    fontSize: 24,
    fontWeight: 'bold',
  },
  headerSubtitle: {
    fontSize: 14,
    marginTop: 4,
  },
  contextBar: {
    minHeight: 50,
    flexGrow: 0,
    zIndex: 10,
    elevation: 5,
  },
  contextBarContent: {
    paddingHorizontal: 10,
    paddingVertical: 12,
    gap: 6,
    alignItems: 'center',
  },
  contextChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    marginRight: 6,
  },
  contextChipActive: {
    backgroundColor: '#3B82F6',
  },
  contextChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#000000',
    textDecorationLine: 'none',
  },
  contextChipTextActive: {
    color: '#FFFFFF',
  },
  listContent: {
    padding: 16,
    paddingBottom: 100,
  },
  sectionHeader: {
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  sectionSubtitle: {
    fontSize: 12,
  },
  contextBadge: {
    fontSize: 12,
    fontWeight: '500',
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  todoSection: {
    marginTop: 24,
    paddingTop: 24,
    borderTopWidth: 1,
  },
  todoItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 8,
    marginBottom: 8,
  },
  todoContent: {
    flex: 1,
  },
  todoTitle: {
    fontSize: 14,
  },
  promoteButton: {
    padding: 8,
  },
  emptyContainer: {
    padding: 24,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 14,
    textAlign: 'center',
  },
  warningBanner: {
    marginHorizontal: 16,
    marginTop: 8,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  warningText: {
    fontSize: 13,
    fontWeight: '500',
    textAlign: 'center',
  },
});
