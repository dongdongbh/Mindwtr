import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Platform } from 'react-native';
import { getWaitingPerson, safeParseDueDate, useTaskStore } from '@mindwtr/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Task, TaskStatus, TimeEstimate } from '@mindwtr/core';
import { useTheme } from '../../contexts/theme-context';
import { useLanguage } from '../../contexts/language-context';
import { Folder, PauseCircle } from 'lucide-react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useThemeColors } from '@/hooks/use-theme-colors';
import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { projectMatchesAreaFilter, taskMatchesAreaFilter } from '@/lib/area-filter';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';
import { SwipeableTaskItem } from '../swipeable-task-item';
import { TaskEditModal } from '../task-edit-modal';
import {
  MOBILE_TIME_ESTIMATE_OPTIONS,
  formatTimeEstimateChipLabel,
  matchesSelectedTimeEstimates,
} from '../time-estimate-filter-utils';



export function WaitingView() {
  const { tasks, projects, updateTask, updateProject, deleteTask, highlightTaskId, setHighlightTask, settings } = useTaskStore();
  const { isDark } = useTheme();
  const { t } = useLanguage();
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [selectedWaitingPerson, setSelectedWaitingPerson] = useState('');
  const [selectedTimeEstimates, setSelectedTimeEstimates] = useState<TimeEstimate[]>([]);
  const router = useRouter();

  const tc = useThemeColors();
  const timeEstimatesEnabled = settings?.features?.timeEstimates !== false;
  const insets = useSafeAreaInsets();
  const navBarInset = Platform.OS === 'android' && insets.bottom >= 24 ? insets.bottom : 0;
  const { areaById, resolvedAreaFilter } = useMobileAreaFilter();
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const taskListContentStyle = useMemo(
    () => [styles.taskListContent, navBarInset ? { paddingBottom: 16 + navBarInset } : null],
    [navBarInset],
  );

  const waitingTasks = useMemo(() => {
    return tasks
      .filter((task) => (
        !task.deletedAt
        && task.status === 'waiting'
        && taskMatchesAreaFilter(task, resolvedAreaFilter, projectById, areaById)
      ))
      .sort((a, b) => {
        if (a.dueDate && !b.dueDate) return -1;
        if (!a.dueDate && b.dueDate) return 1;
        if (a.dueDate && b.dueDate) {
          const aDue = safeParseDueDate(a.dueDate);
          const bDue = safeParseDueDate(b.dueDate);
          if (aDue && bDue) return aDue.getTime() - bDue.getTime();
        }
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
  }, [tasks, resolvedAreaFilter, projectById, areaById]);
  const waitingPeople = useMemo(() => {
    const people = new Map<string, string>();
    for (const task of waitingTasks) {
      const person = getWaitingPerson(task);
      if (!person) continue;
      const key = person.toLowerCase();
      if (!people.has(key)) people.set(key, person);
    }
    return [...people.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }, [waitingTasks]);
  const filteredWaitingTasks = useMemo(() => {
    return waitingTasks.filter((task) => {
      if (selectedWaitingPerson) {
        const person = getWaitingPerson(task);
        if (!person || person.toLowerCase() !== selectedWaitingPerson.toLowerCase()) {
          return false;
        }
      }
      if (timeEstimatesEnabled && !matchesSelectedTimeEstimates(task, selectedTimeEstimates)) {
        return false;
      }
      return true;
    });
  }, [selectedTimeEstimates, selectedWaitingPerson, timeEstimatesEnabled, waitingTasks]);
  const deferredProjects = useMemo(() => {
    return [...projects]
      .filter((project) => (
        !project.deletedAt
        && project.status === 'waiting'
        && projectMatchesAreaFilter(project, resolvedAreaFilter, areaById)
      ))
      .sort((a, b) => {
        const aOrder = Number.isFinite(a.order) ? (a.order as number) : Number.POSITIVE_INFINITY;
        const bOrder = Number.isFinite(b.order) ? (b.order as number) : Number.POSITIVE_INFINITY;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return a.title.localeCompare(b.title);
      });
  }, [projects, resolvedAreaFilter, areaById]);

  useEffect(() => {
    if (!selectedWaitingPerson) return;
    const selected = selectedWaitingPerson.toLowerCase();
    if (!waitingPeople.some((person) => person.toLowerCase() === selected)) {
      setSelectedWaitingPerson('');
    }
  }, [selectedWaitingPerson, waitingPeople]);

  useEffect(() => {
    if (!timeEstimatesEnabled && selectedTimeEstimates.length > 0) {
      setSelectedTimeEstimates([]);
    }
  }, [selectedTimeEstimates.length, timeEstimatesEnabled]);

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
          <Text style={styles.statValue}>{filteredWaitingTasks.length}</Text>
          <Text style={styles.statLabel}>{t('waiting.count')}</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={styles.statValue}>
            {filteredWaitingTasks.filter((task) => task.dueDate).length}
          </Text>
          <Text style={styles.statLabel}>{t('waiting.withDeadline')}</Text>
        </View>
      </View>

      <View style={[styles.filterSection, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
        <Text style={[styles.filterLabel, { color: tc.secondaryText }]}>
          {t('process.delegateWhoLabel')}
        </Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterChips}>
          <TouchableOpacity
            onPress={() => setSelectedWaitingPerson('')}
            style={[
              styles.filterChip,
              { borderColor: tc.border, backgroundColor: !selectedWaitingPerson ? tc.tint : tc.filterBg },
            ]}
          >
            <Text style={[styles.filterChipText, { color: !selectedWaitingPerson ? tc.onTint : tc.text }]}>
              {t('common.all')}
            </Text>
          </TouchableOpacity>
          {waitingPeople.map((person) => {
            const isActive = selectedWaitingPerson.toLowerCase() === person.toLowerCase();
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
        {selectedWaitingPerson && (
          <TouchableOpacity
            onPress={() => setSelectedWaitingPerson('')}
            style={[styles.clearFilterButton, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
          >
            <Text style={[styles.clearFilterText, { color: tc.text }]}>{t('common.clear')}</Text>
          </TouchableOpacity>
        )}
        {timeEstimatesEnabled && (
          <>
            <Text style={[styles.filterLabel, { color: tc.secondaryText, marginTop: 4 }]}>
              {t('filters.timeEstimate')}
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterChips}>
              <TouchableOpacity
                onPress={() => setSelectedTimeEstimates([])}
                style={[
                  styles.filterChip,
                  { borderColor: tc.border, backgroundColor: selectedTimeEstimates.length === 0 ? tc.tint : tc.filterBg },
                ]}
              >
                <Text style={[styles.filterChipText, { color: selectedTimeEstimates.length === 0 ? tc.onTint : tc.text }]}>
                  {t('common.all')}
                </Text>
              </TouchableOpacity>
              {MOBILE_TIME_ESTIMATE_OPTIONS.map((estimate) => {
                const isActive = selectedTimeEstimates.includes(estimate);
                return (
                  <TouchableOpacity
                    key={estimate}
                    onPress={() => setSelectedTimeEstimates((prev) => (
                      prev.includes(estimate)
                        ? prev.filter((value) => value !== estimate)
                        : [...prev, estimate]
                    ))}
                    style={[
                      styles.filterChip,
                      { borderColor: tc.border, backgroundColor: isActive ? tc.tint : tc.filterBg },
                    ]}
                  >
                    <Text style={[styles.filterChipText, { color: isActive ? tc.onTint : tc.text }]}>
                      {formatTimeEstimateChipLabel(estimate)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </>
        )}
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
        {filteredWaitingTasks.length > 0 ? (
          filteredWaitingTasks.map((task) => (
            <SwipeableTaskItem
              key={task.id}
              task={task}
              isDark={isDark}
              tc={tc}
              onPress={() => setEditingTask(task)}
              onStatusChange={(status) => handleStatusChange(task.id, status)}
              onDelete={() => deleteTask(task.id)}
              isHighlighted={task.id === highlightTaskId}
              onProjectPress={openProjectScreen}
              onContextPress={openContextsScreen}
              onTagPress={openContextsScreen}
            />
          ))
        ) : deferredProjects.length === 0 ? (
          <View style={styles.emptyState}>
            <PauseCircle size={48} color={tc.secondaryText} strokeWidth={1.5} style={styles.emptyIcon} />
            <Text style={[styles.emptyTitle, { color: tc.text }]}>{t('waiting.empty')}</Text>
            <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
              {t('waiting.emptyHint')}
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
  },
});
