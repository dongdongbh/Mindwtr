import { View, Text, StyleSheet, Platform } from 'react-native';
import { groupTasksByViewSection, shallow, sortViewSectionDefinitions, tFallback, useTaskStore } from '@mindwtr/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Task, TaskStatus } from '@mindwtr/core';
import { useTheme } from '../../contexts/theme-context';
import { useLanguage } from '../../contexts/language-context';
import { Lightbulb } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useVisibleTaskContext } from '@/hooks/use-visible-tasks';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';
import { TaskEditModal } from '../task-edit-modal';
import { getBulkMoveStatusOptions } from '../task-list/TaskListBulkBar';
import { useTaskListSelection } from '../use-task-list-selection';
import { TaskListView } from '../task-list-view';
import { DeferredProjectsSection, selectDeferredProjects } from './deferred-projects-section';
import { SomedaySectionManager } from './someday-section-manager';



export function SomedayView() {
  const { tasks, projects, settings, updateTask, updateProject, updateSettings, deleteTask, restoreTask, batchMoveTasks, batchDeleteTasks, batchUpdateTasks, highlightTaskId, setHighlightTask } = useTaskStore((state) => ({
    tasks: state.tasks,
    projects: state.projects,
    settings: state.settings,
    updateTask: state.updateTask,
    updateProject: state.updateProject,
    updateSettings: state.updateSettings,
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
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const router = useRouter();
  const restoreActionLabel = tFallback(t, 'trash.restoreToInbox', 'Restore');

  const tc = useThemeColors();
  const insets = useSafeAreaInsets();
  const { areaById, resolvedAreaFilter, visibleTasks } = useVisibleTaskContext();
  const navBarInset = Platform.OS === 'android' && insets.bottom >= 24 ? insets.bottom : 0;
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

  const somedayTasks = visibleTasks
    .filter((task) => task.status === 'someday')
    .sort((a, b) => {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  const deferredProjects = useMemo(
    () => selectDeferredProjects(projects, 'someday', resolvedAreaFilter, areaById),
    [projects, resolvedAreaFilter, areaById],
  );
  const somedaySections = useMemo(
    () => sortViewSectionDefinitions(settings?.gtd?.viewSections?.someday ?? []),
    [settings?.gtd?.viewSections?.someday],
  );
  const somedayTaskGroups = useMemo(
    () => groupTasksByViewSection(
      somedayTasks,
      'someday',
      somedaySections,
      tFallback(t, 'viewSections.noSection', 'No section'),
    ),
    [somedaySections, somedayTasks, t],
  );
  const handleSectionsChange = (definitions: typeof somedaySections) => updateSettings({
    gtd: {
      ...settings?.gtd,
      viewSections: {
        ...settings?.gtd?.viewSections,
        someday: definitions,
      },
    },
  });

  const selection = useTaskListSelection({
    batchDeleteTasks,
    batchMoveTasks,
    batchUpdateTasks,
    restoreActionLabel,
    restoreTask,
    t,
    tasksById,
  });
  const bulkMoveStatusOptions = useMemo(() => getBulkMoveStatusOptions('someday'), []);

  const handleStatusChange = (task: Task, status: TaskStatus) => {
    return updateTask(task.id, { status });
  };
  const handleActivateProject = (projectId: string) => {
    updateProject(projectId, { status: 'active' });
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
          <Text style={styles.statValue}>{somedayTasks.length}</Text>
          <Text style={styles.statLabel}>{t('someday.ideas')}</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={styles.statValue}>
            {somedayTasks.filter((t) => t.projectId).length}
          </Text>
          <Text style={styles.statLabel}>{t('someday.inProjects')}</Text>
        </View>
      </View>

      <TaskListView
        tasks={somedayTasks}
        taskGroups={somedayTaskGroups}
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
          <View>
            <DeferredProjectsSection
              projects={deferredProjects}
              areaById={areaById}
              themeColors={tc}
              t={t}
              onActivateProject={handleActivateProject}
              onOpenProject={handleOpenProject}
            />
            <SomedaySectionManager
              definitions={somedaySections}
              onChange={handleSectionsChange}
              t={t}
              themeColors={tc}
            />
          </View>
        )}
        ListEmptyComponent={deferredProjects.length === 0 ? (
          <View style={styles.emptyState}>
            <Lightbulb size={48} color={tc.secondaryText} strokeWidth={1.5} style={styles.emptyIcon} />
            <Text style={[styles.emptyTitle, { color: tc.text }]}>{t('someday.empty')}</Text>
            <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
              {t('someday.emptyHint')}
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
  statItem: {
    alignItems: 'center',
  },
  statValue: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#8B5CF6',
  },
  statLabel: {
    fontSize: 12,
    color: '#6B7280',
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
    lineHeight: 20,
  },
});
