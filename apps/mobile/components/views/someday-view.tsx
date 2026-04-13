import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Platform } from 'react-native';
import { useTaskStore } from '@mindwtr/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Task, TaskStatus } from '@mindwtr/core';
import { useTheme } from '../../contexts/theme-context';
import { useLanguage } from '../../contexts/language-context';
import { Folder, Lightbulb } from 'lucide-react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { projectMatchesAreaFilter, taskMatchesAreaFilter } from '@/lib/area-filter';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';
import { SwipeableTaskItem } from '../swipeable-task-item';
import { TaskEditModal } from '../task-edit-modal';



export function SomedayView() {
  const { tasks, projects, updateTask, updateProject, deleteTask, highlightTaskId, setHighlightTask } = useTaskStore();
  const { isDark } = useTheme();
  const { t } = useLanguage();
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const router = useRouter();

  const tc = useThemeColors();
  const insets = useSafeAreaInsets();
  const { areaById, resolvedAreaFilter } = useMobileAreaFilter();
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const navBarInset = Platform.OS === 'android' && insets.bottom >= 24 ? insets.bottom : 0;
  const taskListContentStyle = useMemo(
    () => [styles.taskListContent, navBarInset ? { paddingBottom: 16 + navBarInset } : null],
    [navBarInset],
  );

  const somedayTasks = tasks
    .filter((task) => (
      !task.deletedAt
      && task.status === 'someday'
      && taskMatchesAreaFilter(task, resolvedAreaFilter, projectById, areaById)
    ))
    .sort((a, b) => {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  const deferredProjects = useMemo(() => {
    return [...projects]
      .filter((project) => (
        !project.deletedAt
        && project.status === 'someday'
        && projectMatchesAreaFilter(project, resolvedAreaFilter, areaById)
      ))
      .sort((a, b) => {
        const aOrder = Number.isFinite(a.order) ? (a.order as number) : Number.POSITIVE_INFINITY;
        const bOrder = Number.isFinite(b.order) ? (b.order as number) : Number.POSITIVE_INFINITY;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return a.title.localeCompare(b.title);
      });
  }, [projects, resolvedAreaFilter, areaById]);

  const handleStatusChange = (id: string, status: TaskStatus) => {
    updateTask(id, { status });
  };
  const handleActivateProject = (projectId: string) => {
    updateProject(projectId, { status: 'active' });
  };
  const handleOpenProject = (projectId: string) => {
    router.push({ pathname: '/projects-screen', params: { projectId } });
  };

  const handleSaveTask = (taskId: string, updates: Partial<Task>) => {
    updateTask(taskId, updates);
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

      <ScrollView style={styles.taskList} showsVerticalScrollIndicator={false} contentContainerStyle={taskListContentStyle}>
        {deferredProjects.length > 0 && (
          <View style={[styles.projectSection, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            <Text style={[styles.sectionLabel, { color: tc.secondaryText }]}>
              {t('projects.title') || 'Projects'}
            </Text>
            {deferredProjects.map((project) => {
              const projectArea = project.areaId ? areaById.get(project.areaId) : undefined;
              return (
                <Swipeable
                  key={project.id}
                  renderLeftActions={() => (
                    <View style={[styles.activateAction, { backgroundColor: tc.tint, borderColor: tc.border }]}>
                      <Text style={styles.activateActionText}>{t('projects.reactivate')}</Text>
                    </View>
                  )}
                  onSwipeableLeftOpen={() => handleActivateProject(project.id)}
                >
                  <TouchableOpacity
                    style={[styles.projectRow, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                    onPress={() => handleOpenProject(project.id)}
                  >
                    <Folder size={18} color={project.color || tc.secondaryText} />
                    <View style={styles.projectText}>
                      <Text style={[styles.projectTitle, { color: tc.text }]} numberOfLines={1}>
                        {project.title}
                      </Text>
                      {projectArea && (
                        <Text style={[styles.projectMeta, { color: tc.secondaryText }]} numberOfLines={1}>
                          {projectArea.name}
                        </Text>
                      )}
                    </View>
                  </TouchableOpacity>
                </Swipeable>
              );
            })}
          </View>
        )}
        {somedayTasks.length > 0 ? (
          somedayTasks.map((task) => (
            <SwipeableTaskItem
              key={task.id}
              task={task}
              isDark={isDark}
              tc={tc}
              onPress={() => setEditingTask(task)}
              onStatusChange={(status) => handleStatusChange(task.id, status as TaskStatus)}
              onDelete={() => deleteTask(task.id)}
              isHighlighted={task.id === highlightTaskId}
              onProjectPress={openProjectScreen}
              onContextPress={openContextsScreen}
              onTagPress={openContextsScreen}
            />
          ))
        ) : deferredProjects.length === 0 ? (
          <View style={styles.emptyState}>
            <Lightbulb size={48} color={tc.secondaryText} strokeWidth={1.5} style={styles.emptyIcon} />
            <Text style={[styles.emptyTitle, { color: tc.text }]}>{t('someday.empty')}</Text>
            <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
              {t('someday.emptyHint')}
            </Text>
          </View>
        ) : null}
      </ScrollView>

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
  taskList: {
    flex: 1,
  },
  taskListContent: {
    padding: 16,
  },
  projectSection: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    gap: 8,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  projectRow: {
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  projectText: {
    flex: 1,
  },
  projectTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  projectMeta: {
    fontSize: 12,
    marginTop: 2,
  },
  activateAction: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: 1,
  },
  activateActionText: {
    color: '#FFFFFF',
    fontWeight: '600',
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
