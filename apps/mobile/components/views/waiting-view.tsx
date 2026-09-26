import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Platform } from 'react-native';
import { buildWaitingViewModel, shallow, tFallback, useTaskStore } from '@mindwtr/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Task, TaskStatus } from '@mindwtr/core';
import { useTheme } from '../../contexts/theme-context';
import { useLanguage } from '../../contexts/language-context';
import { PauseCircle } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useToast } from '@/contexts/toast-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useVisibleTaskContext } from '@/hooks/use-visible-tasks';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';
import { TaskEditModal } from '../task-edit-modal';
import { getBulkMoveStatusOptions } from '../task-list/TaskListBulkBar';
import { useTaskListSelection } from '../use-task-list-selection';
import { settleStoreAction } from '../store-action-result';
import { TaskListView } from '../task-list-view';
import { DeferredProjectsSection } from './deferred-projects-section';

export function WaitingView() {
  const { tasks, projects, updateTask, updateProject, deleteTask, restoreTask, batchMoveTasks, batchDeleteTasks, batchUpdateTasks, highlightTaskId, setHighlightTask } = useTaskStore((state) => ({
    tasks: state.tasks,
    projects: state.projects,
    updateTask: state.updateTask,
    updateProject: state.updateProject,
    deleteTask: state.deleteTask,
    restoreTask: state.restoreTask,
    batchMoveTasks: state.batchMoveTasks,
    batchDeleteTasks: state.batchDeleteTasks,
    batchUpdateTasks: state.batchUpdateTasks,
    highlightTaskId: state.highlightTaskId,
    setHighlightTask: state.setHighlightTask,
  }), shallow);
  const { isDark } = useTheme();
  const { t } = useLanguage();
  const { showToast } = useToast();
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [selectedWaitingPerson, setSelectedWaitingPerson] = useState('');
  const router = useRouter();

  const tc = useThemeColors();
  const insets = useSafeAreaInsets();
  const navBarInset = Platform.OS === 'android' && insets.bottom >= 24 ? insets.bottom : 0;
  const { areaById, resolvedAreaFilter, visibleTasks } = useVisibleTaskContext();
  const tasksById = useMemo(() => {
    return tasks.reduce((acc, task) => {
      acc[task.id] = task;
      return acc;
    }, {} as Record<string, Task>);
  }, [tasks]);
  const taskListContentStyle = useMemo(
    () => [styles.taskListContent, navBarInset ? { paddingBottom: 16 + navBarInset } : null],
    [navBarInset],
  );

  // Rows, people, counts and parked projects come from core, shared with the native host.
  const model = useMemo(() => buildWaitingViewModel({
    tasks: visibleTasks,
    projects,
    resolvedAreaFilter,
    areaById,
    person: selectedWaitingPerson,
    t,
  }), [areaById, projects, resolvedAreaFilter, selectedWaitingPerson, t, visibleTasks]);
  const { deferredProjects, labels, people: waitingPeople, tasks: filteredWaitingTasks } = model;

  useEffect(() => {
    if (!model.personOffered) setSelectedWaitingPerson('');
  }, [model.personOffered]);

  const selection = useTaskListSelection({
    batchDeleteTasks,
    batchMoveTasks,
    batchUpdateTasks,
    restoreTask,
    t,
    tasksById,
  });
  const bulkMoveStatusOptions = useMemo(() => getBulkMoveStatusOptions('waiting'), []);

  const handleStatusChange = (task: Task, status: TaskStatus) => {
    return updateTask(task.id, { status });
  };
  const handleActivateProject = (projectId: string) => {
    void settleStoreAction(() => updateProject(projectId, { status: 'active' })).then((outcome) => {
      if (outcome.ok) return;
      showToast({
        title: tFallback(t, 'common.error', 'Error'),
        message: outcome.message || tFallback(t, 'projects.reactivateFailed', 'Failed to reactivate project'),
        tone: 'error',
        durationMs: 4200,
      });
    });
  };
  const handleOpenProject = (projectId: string) => {
    router.push({ pathname: '/projects-screen', params: { projectId } });
  };

  const handleSaveTask = (taskId: string, updates: Partial<Task>) => {
    return updateTask(taskId, updates);
  };

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

  return (
    <View style={[styles.container, { backgroundColor: tc.bg }]}>
      <View style={[styles.stats, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
        <View style={styles.statItem}>
          <Text style={styles.statValue}>{model.count}</Text>
          <Text style={[styles.statLabel, { color: tc.secondaryText }]}>{labels.count}</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={styles.statValue}>{model.withDeadlineCount}</Text>
          <Text style={[styles.statLabel, { color: tc.secondaryText }]}>{labels.withDeadline}</Text>
        </View>
      </View>

      <View style={[styles.filterSection, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
        <Text style={[styles.filterLabel, { color: tc.secondaryText }]}>
          {labels.filter}
        </Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterChips}>
          <TouchableOpacity
            onPress={() => setSelectedWaitingPerson('')}
            style={[
              styles.filterChip,
              { borderColor: tc.border, backgroundColor: !model.person ? tc.tint : tc.filterBg },
            ]}
          >
            <Text style={[styles.filterChipText, { color: !model.person ? tc.onTint : tc.text }]}>
              {labels.all}
            </Text>
          </TouchableOpacity>
          {waitingPeople.map((person) => {
            const isActive = model.person.toLowerCase() === person.toLowerCase();
            return (
              <TouchableOpacity
                key={person}
                onPress={() => setSelectedWaitingPerson(person)}
                style={[
                  styles.filterChip,
                  { borderColor: tc.border, backgroundColor: isActive ? tc.tint : tc.filterBg },
                ]}
              >
                <Text style={[styles.filterChipText, { color: isActive ? tc.onTint : tc.text }]} numberOfLines={1}>
                  {person}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
        {model.person && (
          <TouchableOpacity
            onPress={() => setSelectedWaitingPerson('')}
            style={[styles.clearFilterButton, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
          >
            <Text style={[styles.clearFilterText, { color: tc.text }]}>{labels.clear}</Text>
          </TouchableOpacity>
        )}
      </View>

      <TaskListView
        tasks={filteredWaitingTasks}
        isDark={isDark}
        themeColors={tc}
        t={t}
        onPressTask={setEditingTask}
        onChangeTaskStatus={handleStatusChange}
        onDeleteTask={(task) => deleteTask(task.id)}
        highlightTaskId={highlightTaskId}
        selection={selection}
        bulkStatusOptions={bulkMoveStatusOptions}
        contentContainerStyle={taskListContentStyle}
        ListHeaderComponent={(
          <DeferredProjectsSection
            projects={deferredProjects}
            areaById={areaById}
            themeColors={tc}
            t={t}
            onActivateProject={handleActivateProject}
            onOpenProject={handleOpenProject}
          />
        )}
        ListEmptyComponent={deferredProjects.length === 0 ? (
          <View style={styles.emptyState}>
            <PauseCircle size={48} color={tc.secondaryText} strokeWidth={1.5} style={styles.emptyIcon} />
            <Text style={[styles.emptyTitle, { color: tc.text }]}>{labels.emptyTitle}</Text>
            <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
              {labels.emptyHint}
            </Text>
          </View>
        ) : null}
      />

      <TaskEditModal
        visible={editingTask !== null}
        task={editingTask}
        onClose={() => setEditingTask(null)}
        onSave={handleSaveTask}
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
    backgroundColor: '#F9FAFB',
  },
  stats: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
    gap: 24,
  },
  filterSection: {
    borderBottomWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
  },
  filterLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  filterChips: {
    gap: 8,
    alignItems: 'center',
  },
  filterChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    maxWidth: 180,
  },
  filterChipText: {
    fontSize: 12,
    fontWeight: '600',
  },
  clearFilterButton: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  clearFilterText: {
    fontSize: 12,
    fontWeight: '600',
  },
  statItem: {
    alignItems: 'center',
  },
  statValue: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#F59E0B',
  },
  statLabel: {
    fontSize: 12,
    marginTop: 4,
  },
  taskListContent: {
    padding: 16,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
    paddingHorizontal: 24,
  },
  emptyIcon: {
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
