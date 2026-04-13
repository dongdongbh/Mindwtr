import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { View, Text, SectionList, StyleSheet, Pressable } from 'react-native';
import { format } from 'date-fns';
import { useLocalSearchParams } from 'expo-router';

import { useTaskStore, safeParseDate, safeParseDueDate, type Task, type TaskStatus } from '@mindwtr/core';
import { SwipeableTaskItem } from '@/components/swipeable-task-item';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useTheme } from '../../../contexts/theme-context';
import { useLanguage } from '../../../contexts/language-context';
import { TaskEditModal } from '@/components/task-edit-modal';
import { PomodoroPanel } from '@/components/pomodoro-panel';
import { splitFocusedTasks } from '@/lib/focus-screen-utils';
import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { projectMatchesAreaFilter, taskMatchesAreaFilter } from '@/lib/area-filter';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';

export default function FocusScreen() {
  const { taskId, openToken } = useLocalSearchParams<{ taskId?: string; openToken?: string }>();
  const { tasks, projects, settings, updateTask, deleteTask, highlightTaskId, setHighlightTask } = useTaskStore();
  const { isDark } = useTheme();
  const { t } = useLanguage();
  const tc = useThemeColors();
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [expandedSections, setExpandedSections] = useState({
    focus: true,
    schedule: true,
    next: true,
  });
  const lastOpenedFromNotificationRef = useRef<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pomodoroEnabled = settings?.features?.pomodoro === true;
  const { areaById, resolvedAreaFilter } = useMobileAreaFilter();
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const visibleProjects = useMemo(() => (
    projects.filter((project) => !project.deletedAt && projectMatchesAreaFilter(project, resolvedAreaFilter, areaById))
  ), [projects, resolvedAreaFilter, areaById]);
  const visibleTasks = useMemo(() => (
    tasks.filter((task) => taskMatchesAreaFilter(task, resolvedAreaFilter, projectById, areaById))
  ), [tasks, resolvedAreaFilter, projectById, areaById]);

  useEffect(() => {
    if (!taskId || typeof taskId !== 'string') return;
    const openKey = `${taskId}:${typeof openToken === 'string' ? openToken : ''}`;
    if (lastOpenedFromNotificationRef.current === openKey) return;
    const task = tasks.find((item) => item.id === taskId && !item.deletedAt);
    if (!task) return;
    lastOpenedFromNotificationRef.current = openKey;
    setHighlightTask(task.id);
    setEditingTask(task);
    setIsModalVisible(true);
  }, [openToken, setHighlightTask, taskId, tasks]);

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

  const sequentialProjectIds = useMemo(() => {
    return new Set(visibleProjects.filter((project) => project.isSequential).map((project) => project.id));
  }, [visibleProjects]);

  const sequentialFirstTaskIds = useMemo(() => {
    if (sequentialProjectIds.size === 0) return new Set<string>();
    const tasksByProject = new Map<string, Task[]>();
    visibleTasks.forEach((task) => {
      if (task.deletedAt) return;
      if (task.status === 'done' || task.status === 'reference') return;
      if (!task.projectId) return;
      if (!sequentialProjectIds.has(task.projectId)) return;
      const list = tasksByProject.get(task.projectId) ?? [];
      list.push(task);
      tasksByProject.set(task.projectId, list);
    });

    const firstIds = new Set<string>();
    tasksByProject.forEach((projectTasks) => {
      const hasOrder = projectTasks.some((task) => Number.isFinite(task.order) || Number.isFinite(task.orderNum));
      let firstId: string | null = null;
      let bestKey = Number.POSITIVE_INFINITY;
      projectTasks.forEach((task) => {
        const taskOrder = Number.isFinite(task.order)
          ? (task.order as number)
          : Number.isFinite(task.orderNum)
            ? (task.orderNum as number)
            : Number.POSITIVE_INFINITY;
        const key = hasOrder
          ? taskOrder
          : (safeParseDate(task.createdAt)?.getTime() ?? Number.POSITIVE_INFINITY);
        if (!firstId || key < bestKey) {
          firstId = task.id;
          bestKey = key;
        }
      });
      if (firstId) firstIds.add(firstId);
    });

    return firstIds;
  }, [visibleTasks, sequentialProjectIds]);

  const { focusedTasks, schedule, nextActions } = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const activeTasks = visibleTasks.filter((task) => (
      !task.deletedAt
      && task.status !== 'done'
      && task.status !== 'reference'
    ));
    const { focusedTasks: allFocusedTasks, otherTasks: nonFocusedTasks } = splitFocusedTasks(activeTasks);
    const focusedItems = allFocusedTasks.slice(0, 3);

    const isPlannedForFuture = (task: Task) => {
      const start = safeParseDate(task.startTime);
      return Boolean(start && start > endOfToday);
    };
    const isSequentialBlocked = (task: Task) => {
      if (!task.projectId) return false;
      if (!sequentialProjectIds.has(task.projectId)) return false;
      return !sequentialFirstTaskIds.has(task.id);
    };

    const scheduleItems = nonFocusedTasks.filter((task) => {
      if (task.status !== 'next') return false;
      if (isSequentialBlocked(task)) return false;
      const due = safeParseDueDate(task.dueDate);
      const start = safeParseDate(task.startTime);
      const startsToday = Boolean(
        start
        && start >= startOfToday
        && start <= endOfToday
      );
      return Boolean(due && due <= endOfToday) || startsToday;
    });

    const scheduleIds = new Set(scheduleItems.map((task) => task.id));

    const nextItems = nonFocusedTasks.filter((task) => {
      if (task.status !== 'next') return false;
      if (isPlannedForFuture(task)) return false;
      if (isSequentialBlocked(task)) return false;
      return !scheduleIds.has(task.id);
    });

    return { focusedTasks: focusedItems, schedule: scheduleItems, nextActions: nextItems };
  }, [visibleTasks, sequentialProjectIds, sequentialFirstTaskIds]);

  const sections = useMemo(() => {
    const nextSections = [];

    if (focusedTasks.length > 0) {
      nextSections.push({
        title: t('agenda.todaysFocus') ?? "Today's Focus",
        data: expandedSections.focus ? focusedTasks : [],
        totalCount: focusedTasks.length,
        expanded: expandedSections.focus,
        type: 'focus' as const,
      });
    }

    nextSections.push(
      {
        title: t('focus.schedule') ?? 'Today',
        data: expandedSections.schedule ? schedule : [],
        totalCount: schedule.length,
        expanded: expandedSections.schedule,
        type: 'schedule' as const,
      },
      {
        title: t('focus.nextActions') ?? t('list.next'),
        data: expandedSections.next ? nextActions : [],
        totalCount: nextActions.length,
        expanded: expandedSections.next,
        type: 'next' as const,
      }
    );

    return nextSections;
  }, [expandedSections.focus, expandedSections.next, expandedSections.schedule, focusedTasks, schedule, nextActions, t]);
  const hasTasks = focusedTasks.length > 0 || schedule.length > 0 || nextActions.length > 0;
  const pomodoroTasks = useMemo(() => {
    const byId = new Map<string, Task>();
    [...focusedTasks, ...schedule, ...nextActions].forEach((task) => {
      if (task.deletedAt) return;
      byId.set(task.id, task);
    });
    return Array.from(byId.values());
  }, [focusedTasks, schedule, nextActions]);

  const onEdit = useCallback((task: Task) => {
    setEditingTask(task);
    setIsModalVisible(true);
  }, []);

  const onSaveTask = useCallback((taskId: string, updates: Partial<Task>) => {
    updateTask(taskId, updates);
  }, [updateTask]);

  const toggleSection = useCallback((sectionType: 'focus' | 'schedule' | 'next') => {
    setExpandedSections((current) => ({
      ...current,
      [sectionType]: !current[sectionType],
    }));
  }, []);

  const renderItem = ({ item }: { item: Task }) => (
    <View style={styles.itemWrapper}>
      <SwipeableTaskItem
        task={item}
        isDark={isDark}
        tc={tc}
        onPress={() => onEdit(item)}
        onStatusChange={(status) => updateTask(item.id, { status: status as TaskStatus })}
        onDelete={() => deleteTask(item.id)}
        isHighlighted={item.id === highlightTaskId}
        showFocusToggle
        hideStatusBadge
        onProjectPress={openProjectScreen}
        onContextPress={openContextsScreen}
        onTagPress={openContextsScreen}
      />
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: tc.bg }]}>
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={[
          styles.listContent,
        ]}
        ListHeaderComponent={(
          <View style={styles.header}>
            {pomodoroEnabled && (
              <PomodoroPanel
                tasks={pomodoroTasks}
                onMarkDone={(id) => updateTask(id, { status: 'done', isFocusedToday: false })}
              />
            )}
            <Text style={[styles.dateText, { color: tc.secondaryText }]}>
              {format(new Date(), 'PPPP')}
            </Text>
          </View>
        )}
        renderSectionHeader={({ section }) => (
          section.totalCount > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={section.title}
              accessibilityState={{ expanded: section.expanded }}
              onPress={() => toggleSection(section.type)}
              style={styles.sectionHeader}
            >
              <Text style={[styles.sectionChevron, { color: tc.secondaryText }]}>
                {section.expanded ? '▼' : '▶'}
              </Text>
              <Text style={[styles.sectionTitle, { color: tc.tint }]}>{section.title}</Text>
              <Text style={[styles.sectionCount, { color: tc.secondaryText }]}>({section.totalCount})</Text>
              <View style={[styles.sectionLine, { backgroundColor: tc.border }]} />
            </Pressable>
          ) : null
        )}
        renderItem={renderItem}
        ListEmptyComponent={!hasTasks ? (
          <View style={styles.emptyState}>
            <Text style={[styles.emptyTitle, { color: tc.text }]}>{t('agenda.allClear')}</Text>
            <Text style={[styles.emptySubtitle, { color: tc.secondaryText }]}>{t('agenda.noTasks')}</Text>
          </View>
        ) : null}
      />
      <TaskEditModal
        visible={isModalVisible}
        task={editingTask}
        onClose={() => setIsModalVisible(false)}
        onSave={onSaveTask}
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
  listContent: {
    paddingHorizontal: 12,
    paddingBottom: 110,
  },
  header: {
    marginTop: 8,
    marginBottom: 12,
  },
  dateText: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 18,
    marginBottom: 10,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  sectionChevron: {
    fontSize: 12,
    width: 14,
    textAlign: 'center',
  },
  sectionCount: {
    fontSize: 12,
    fontWeight: '600',
  },
  sectionLine: {
    flex: 1,
    height: 1,
    borderRadius: 1,
  },
  itemWrapper: {
    marginBottom: 8,
  },
  emptyState: {
    paddingVertical: 40,
    alignItems: 'center',
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  emptySubtitle: {
    marginTop: 4,
    fontSize: 12,
    fontWeight: '600',
  },
});
