import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  SectionList,
  StyleSheet,
  Pressable,
  ScrollView,
  Modal,
  TouchableOpacity,
} from 'react-native';
import { format } from 'date-fns';
import { useLocalSearchParams } from 'expo-router';
import { SlidersHorizontal, X } from 'lucide-react-native';

import {
  sortFocusNextActions,
  translateWithFallback,
  useTaskStore,
  isDueForReview,
  safeParseDate,
  safeParseDueDate,
  type Task,
  type TaskStatus,
  type TaskPriority,
  type TaskEnergyLevel,
  type TimeEstimate,
} from '@mindwtr/core';
import { SwipeableTaskItem } from '@/components/swipeable-task-item';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useTheme } from '../../../contexts/theme-context';
import { useLanguage } from '../../../contexts/language-context';
import { TaskEditModal } from '@/components/task-edit-modal';
import { PomodoroPanel } from '@/components/pomodoro-panel';
import {
  formatFocusTimeEstimateLabel,
  getFocusTokenOptions,
  NO_PROJECT_FILTER_ID,
  splitFocusedTasks,
  taskMatchesFocusFilters,
} from '@/lib/focus-screen-utils';
import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { projectMatchesAreaFilter, taskMatchesAreaFilter } from '@/lib/area-filter';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';

const PRIORITY_OPTIONS: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
const ENERGY_LEVEL_OPTIONS: TaskEnergyLevel[] = ['low', 'medium', 'high'];
const DEFAULT_TIME_ESTIMATE_PRESETS: TimeEstimate[] = ['10min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+'];

function filterSelectionStable<T>(current: T[], predicate: (item: T) => boolean): T[] {
  const next = current.filter(predicate);
  return next.length === current.length && next.every((item, index) => item === current[index]) ? current : next;
}

export default function FocusScreen() {
  const { taskId, openToken } = useLocalSearchParams<{ taskId?: string; openToken?: string }>();
  const { tasks, projects, settings, updateTask, deleteTask, highlightTaskId, setHighlightTask } = useTaskStore();
  const { isDark } = useTheme();
  const { t } = useLanguage();
  const tc = useThemeColors();
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [filtersVisible, setFiltersVisible] = useState(false);
  const [selectedTokens, setSelectedTokens] = useState<string[]>([]);
  const [selectedProjects, setSelectedProjects] = useState<string[]>([]);
  const [selectedPriorities, setSelectedPriorities] = useState<TaskPriority[]>([]);
  const [selectedEnergyLevels, setSelectedEnergyLevels] = useState<TaskEnergyLevel[]>([]);
  const [selectedTimeEstimates, setSelectedTimeEstimates] = useState<TimeEstimate[]>([]);
  const [expandedSections, setExpandedSections] = useState({
    focus: true,
    schedule: true,
    next: true,
    reviewDue: true,
  });
  const lastOpenedFromNotificationRef = useRef<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pomodoroEnabled = settings?.features?.pomodoro === true;
  const prioritiesEnabled = settings?.features?.priorities !== false;
  const timeEstimatesEnabled = settings?.features?.timeEstimates !== false;
  const { areaById, resolvedAreaFilter } = useMobileAreaFilter();
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const visibleProjects = useMemo(() => (
    projects.filter((project) => !project.deletedAt && projectMatchesAreaFilter(project, resolvedAreaFilter, areaById))
  ), [projects, resolvedAreaFilter, areaById]);
  const visibleTasks = useMemo(() => (
    tasks.filter((task) => taskMatchesAreaFilter(task, resolvedAreaFilter, projectById, areaById))
  ), [tasks, resolvedAreaFilter, projectById, areaById]);
  const activeTasks = useMemo(() => (
    visibleTasks.filter((task) => (
      !task.deletedAt
      && task.status !== 'done'
      && task.status !== 'reference'
    ))
  ), [visibleTasks]);
  const tokenOptions = useMemo(() => getFocusTokenOptions(activeTasks), [activeTasks]);
  const activeProjectIds = useMemo(() => (
    new Set(activeTasks.map((task) => task.projectId).filter((projectId): projectId is string => Boolean(projectId)))
  ), [activeTasks]);
  const projectOptions = useMemo(() => (
    visibleProjects
      .filter((project) => activeProjectIds.has(project.id))
      .sort((a, b) => {
        const aOrder = Number.isFinite(a.order) ? (a.order as number) : Number.POSITIVE_INFINITY;
        const bOrder = Number.isFinite(b.order) ? (b.order as number) : Number.POSITIVE_INFINITY;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return a.title.localeCompare(b.title);
      })
  ), [activeProjectIds, visibleProjects]);
  const showNoProjectOption = useMemo(() => activeTasks.some((task) => !task.projectId), [activeTasks]);
  const effectiveTimeEstimatePresets = useMemo<TimeEstimate[]>(() => {
    const saved = settings?.gtd?.timeEstimatePresets;
    return saved?.length ? saved : DEFAULT_TIME_ESTIMATE_PRESETS;
  }, [settings?.gtd?.timeEstimatePresets]);
  const filteredActiveTasks = useMemo(() => (
    activeTasks.filter((task) => taskMatchesFocusFilters(task, {
      tokens: selectedTokens,
      projects: selectedProjects,
      priorities: prioritiesEnabled ? selectedPriorities : [],
      energyLevels: selectedEnergyLevels,
      timeEstimates: timeEstimatesEnabled ? selectedTimeEstimates : [],
    }))
  ), [
    activeTasks,
    prioritiesEnabled,
    selectedEnergyLevels,
    selectedPriorities,
    selectedProjects,
    selectedTimeEstimates,
    selectedTokens,
    timeEstimatesEnabled,
  ]);
  const resolveText = useCallback((key: string, fallback: string) => {
    return translateWithFallback(t, key, fallback);
  }, [t]);
  const toggleToken = useCallback((token: string) => {
    setSelectedTokens((current) => (
      current.includes(token) ? current.filter((item) => item !== token) : [...current, token]
    ));
  }, []);
  const toggleProject = useCallback((projectId: string) => {
    setSelectedProjects((current) => (
      current.includes(projectId) ? current.filter((item) => item !== projectId) : [...current, projectId]
    ));
  }, []);
  const togglePriority = useCallback((priority: TaskPriority) => {
    setSelectedPriorities((current) => (
      current.includes(priority) ? current.filter((item) => item !== priority) : [...current, priority]
    ));
  }, []);
  const toggleEnergyLevel = useCallback((energyLevel: TaskEnergyLevel) => {
    setSelectedEnergyLevels((current) => (
      current.includes(energyLevel) ? current.filter((item) => item !== energyLevel) : [...current, energyLevel]
    ));
  }, []);
  const toggleTimeEstimate = useCallback((estimate: TimeEstimate) => {
    setSelectedTimeEstimates((current) => (
      current.includes(estimate) ? current.filter((item) => item !== estimate) : [...current, estimate]
    ));
  }, []);
  const clearFilters = useCallback(() => {
    setSelectedTokens([]);
    setSelectedProjects([]);
    setSelectedPriorities([]);
    setSelectedEnergyLevels([]);
    setSelectedTimeEstimates([]);
  }, []);

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

  useEffect(() => {
    setSelectedTokens((current) => filterSelectionStable(current, (token) => tokenOptions.includes(token)));
  }, [tokenOptions]);

  useEffect(() => {
    const validProjectIds = new Set(projectOptions.map((project) => project.id));
    setSelectedProjects((current) => filterSelectionStable(current, (projectId) => (
      projectId === NO_PROJECT_FILTER_ID ? showNoProjectOption : validProjectIds.has(projectId)
    )));
  }, [projectOptions, showNoProjectOption]);

  useEffect(() => {
    if (prioritiesEnabled) return;
    if (selectedPriorities.length === 0) return;
    setSelectedPriorities([]);
  }, [prioritiesEnabled, selectedPriorities.length]);

  useEffect(() => {
    if (timeEstimatesEnabled) return;
    if (selectedTimeEstimates.length === 0) return;
    setSelectedTimeEstimates([]);
  }, [selectedTimeEstimates.length, timeEstimatesEnabled]);

  const sequentialProjectIds = useMemo(() => {
    return new Set(visibleProjects.filter((project) => project.isSequential).map((project) => project.id));
  }, [visibleProjects]);

  const sequentialFirstTaskIds = useMemo(() => {
    if (sequentialProjectIds.size === 0) return new Set<string>();
    const tasksByProject = new Map<string, Task[]>();
    filteredActiveTasks.forEach((task) => {
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
  }, [filteredActiveTasks, sequentialProjectIds]);

  const { focusedTasks, schedule, nextActions, reviewDue } = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const { focusedTasks: allFocusedTasks, otherTasks: nonFocusedTasks } = splitFocusedTasks(filteredActiveTasks);
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

    const reviewDueItems = nonFocusedTasks
      .filter((task) => isDueForReview(task.reviewAt, now))
      .sort((a, b) => {
        const aReview = safeParseDate(a.reviewAt)?.getTime() ?? Number.POSITIVE_INFINITY;
        const bReview = safeParseDate(b.reviewAt)?.getTime() ?? Number.POSITIVE_INFINITY;
        if (aReview !== bReview) return aReview - bReview;
        return a.title.localeCompare(b.title);
      });

    return {
      focusedTasks: focusedItems,
      schedule: scheduleItems,
      nextActions: sortFocusNextActions(nextItems, {
        now,
        prioritizeByPriority: prioritiesEnabled,
      }),
      reviewDue: reviewDueItems,
    };
  }, [filteredActiveTasks, prioritiesEnabled, sequentialProjectIds, sequentialFirstTaskIds]);

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
      },
      {
        title: t('agenda.reviewDue') ?? 'Review Due',
        data: expandedSections.reviewDue ? reviewDue : [],
        totalCount: reviewDue.length,
        expanded: expandedSections.reviewDue,
        type: 'reviewDue' as const,
      }
    );

    return nextSections;
  }, [expandedSections.focus, expandedSections.next, expandedSections.reviewDue, expandedSections.schedule, focusedTasks, schedule, nextActions, reviewDue, t]);
  const hasTasks = focusedTasks.length > 0 || schedule.length > 0 || nextActions.length > 0 || reviewDue.length > 0;
  const hasFilters = (
    selectedTokens.length > 0
    || selectedProjects.length > 0
    || selectedPriorities.length > 0
    || selectedEnergyLevels.length > 0
    || selectedTimeEstimates.length > 0
  );
  const activeFilterCount = (
    selectedTokens.length
    + selectedProjects.length
    + selectedPriorities.length
    + selectedEnergyLevels.length
    + selectedTimeEstimates.length
  );
  const activeFilterChips = useMemo(() => {
    const chips: Array<{ id: string; label: string; onPress: () => void }> = [];
    selectedTokens.forEach((token) => {
      chips.push({
        id: `token:${token}`,
        label: token,
        onPress: () => toggleToken(token),
      });
    });
    selectedProjects.forEach((projectId) => {
      if (projectId === NO_PROJECT_FILTER_ID) {
        chips.push({
          id: `project:${projectId}`,
          label: resolveText('taskEdit.noProjectOption', 'No project'),
          onPress: () => toggleProject(projectId),
        });
        return;
      }
      const project = projectById.get(projectId);
      if (!project) return;
      chips.push({
        id: `project:${project.id}`,
        label: project.title,
        onPress: () => toggleProject(project.id),
      });
    });
    selectedPriorities.forEach((priority) => {
      chips.push({
        id: `priority:${priority}`,
        label: t(`priority.${priority}`),
        onPress: () => togglePriority(priority),
      });
    });
    selectedEnergyLevels.forEach((energyLevel) => {
      chips.push({
        id: `energy:${energyLevel}`,
        label: t(`energyLevel.${energyLevel}`),
        onPress: () => toggleEnergyLevel(energyLevel),
      });
    });
    selectedTimeEstimates.forEach((estimate) => {
      chips.push({
        id: `time:${estimate}`,
        label: formatFocusTimeEstimateLabel(estimate),
        onPress: () => toggleTimeEstimate(estimate),
      });
    });
    return chips;
  }, [
    projectById,
    resolveText,
    selectedEnergyLevels,
    selectedPriorities,
    selectedProjects,
    selectedTimeEstimates,
    selectedTokens,
    t,
    toggleEnergyLevel,
    togglePriority,
    toggleProject,
    toggleTimeEstimate,
    toggleToken,
  ]);
  const emptyTitle = hasFilters ? resolveText('filters.noMatch', 'No tasks match these filters.') : t('agenda.allClear');
  const emptySubtitle = hasFilters ? resolveText('filters.label', 'Filters') : t('agenda.noTasks');
  const pomodoroTasks = useMemo(() => {
    const byId = new Map<string, Task>();
    [...focusedTasks, ...schedule, ...nextActions, ...reviewDue].forEach((task) => {
      if (task.deletedAt) return;
      byId.set(task.id, task);
    });
    return Array.from(byId.values());
  }, [focusedTasks, schedule, nextActions, reviewDue]);

  const onEdit = useCallback((task: Task) => {
    setEditingTask(task);
    setIsModalVisible(true);
  }, []);

  const onSaveTask = useCallback((taskId: string, updates: Partial<Task>) => {
    updateTask(taskId, updates);
  }, [updateTask]);

  const toggleSection = useCallback((sectionType: 'focus' | 'schedule' | 'next' | 'reviewDue') => {
    setExpandedSections((current) => ({
      ...current,
      [sectionType]: !current[sectionType],
    }));
  }, []);
  const renderFilterChip = useCallback((label: string, selected: boolean, onPress: () => void) => (
    <TouchableOpacity
      key={label}
      onPress={onPress}
      style={[
        styles.filterChip,
        {
          backgroundColor: selected ? tc.tint : tc.filterBg,
          borderColor: selected ? tc.tint : tc.border,
        },
      ]}
    >
      <Text style={[styles.filterChipText, { color: selected ? tc.onTint : tc.text }]}>
        {label}
      </Text>
    </TouchableOpacity>
  ), [tc.border, tc.filterBg, tc.onTint, tc.text, tc.tint]);

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
            <View style={styles.headerTopRow}>
              <Text style={[styles.dateText, { color: tc.secondaryText }]}>
                {format(new Date(), 'PPPP')}
              </Text>
              <Pressable
                accessibilityLabel={resolveText('filters.label', 'Filters')}
                accessibilityRole="button"
                onPress={() => setFiltersVisible(true)}
                style={({ pressed }) => [
                  styles.filterButton,
                  {
                    borderColor: hasFilters ? tc.tint : tc.border,
                    backgroundColor: hasFilters ? tc.filterBg : 'transparent',
                    opacity: pressed ? 0.78 : 1,
                  },
                ]}
              >
                <SlidersHorizontal size={16} color={hasFilters ? tc.tint : tc.secondaryText} />
                {hasFilters ? (
                  <View style={[styles.filterBadge, { backgroundColor: tc.tint }]}>
                    <Text style={[styles.filterBadgeText, { color: tc.onTint }]}>
                      {activeFilterCount}
                    </Text>
                  </View>
                ) : null}
              </Pressable>
            </View>
            {hasFilters ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.activeChipsRow}
                style={styles.activeChipsScroller}
              >
                {activeFilterChips.map((chip) => renderFilterChip(chip.label, true, chip.onPress))}
                <TouchableOpacity onPress={clearFilters} style={styles.clearFiltersButton}>
                  <Text style={[styles.clearFiltersText, { color: tc.secondaryText }]}>
                    {resolveText('filters.clear', 'Clear')}
                  </Text>
                </TouchableOpacity>
              </ScrollView>
            ) : null}
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
            <Text style={[styles.emptyTitle, { color: tc.text }]}>{emptyTitle}</Text>
            <Text style={[styles.emptySubtitle, { color: tc.secondaryText }]}>{emptySubtitle}</Text>
          </View>
        ) : null}
      />
      <Modal
        animationType="fade"
        transparent
        visible={filtersVisible}
        onRequestClose={() => setFiltersVisible(false)}
      >
        <View style={styles.sheetRoot}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={resolveText('common.close', 'Close')}
            onPress={() => setFiltersVisible(false)}
            style={styles.sheetBackdrop}
          />
          <View style={[styles.sheet, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            <View style={styles.sheetHeader}>
              <Text style={[styles.sheetTitle, { color: tc.text }]}>
                {resolveText('filters.label', 'Filters')}
              </Text>
              <View style={styles.sheetHeaderActions}>
                {hasFilters ? (
                  <TouchableOpacity onPress={clearFilters} style={styles.sheetTextButton}>
                    <Text style={[styles.sheetTextButtonText, { color: tc.tint }]}>
                      {resolveText('filters.clear', 'Clear')}
                    </Text>
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity onPress={() => setFiltersVisible(false)} style={styles.sheetIconButton}>
                  <X size={18} color={tc.secondaryText} />
                </TouchableOpacity>
              </View>
            </View>
            <ScrollView
              style={styles.sheetScroll}
              contentContainerStyle={styles.sheetContent}
              showsVerticalScrollIndicator={false}
            >
              {tokenOptions.length > 0 ? (
                <>
                  <Text style={[styles.sheetSectionLabel, { color: tc.secondaryText }]}>
                    {resolveText('filters.contexts', 'Contexts & tags')}
                  </Text>
                  <View style={styles.sheetChipRow}>
                    {tokenOptions.map((token) => renderFilterChip(token, selectedTokens.includes(token), () => toggleToken(token)))}
                  </View>
                </>
              ) : null}

              {(showNoProjectOption || projectOptions.length > 0) ? (
                <>
                  <Text style={[styles.sheetSectionLabel, { color: tc.secondaryText }]}>
                    {resolveText('filters.projects', 'Projects')}
                  </Text>
                  <View style={styles.sheetChipRow}>
                    {showNoProjectOption ? renderFilterChip(
                      resolveText('taskEdit.noProjectOption', 'No project'),
                      selectedProjects.includes(NO_PROJECT_FILTER_ID),
                      () => toggleProject(NO_PROJECT_FILTER_ID),
                    ) : null}
                    {projectOptions.map((project) => (
                      renderFilterChip(project.title, selectedProjects.includes(project.id), () => toggleProject(project.id))
                    ))}
                  </View>
                </>
              ) : null}

              {prioritiesEnabled ? (
                <>
                  <Text style={[styles.sheetSectionLabel, { color: tc.secondaryText }]}>
                    {resolveText('filters.priority', 'Priority')}
                  </Text>
                  <View style={styles.sheetChipRow}>
                    {PRIORITY_OPTIONS.map((priority) => (
                      renderFilterChip(t(`priority.${priority}`), selectedPriorities.includes(priority), () => togglePriority(priority))
                    ))}
                  </View>
                </>
              ) : null}

              <Text style={[styles.sheetSectionLabel, { color: tc.secondaryText }]}>
                {resolveText('taskEdit.energyLevel', 'Energy level')}
              </Text>
              <View style={styles.sheetChipRow}>
                {ENERGY_LEVEL_OPTIONS.map((energyLevel) => (
                  renderFilterChip(t(`energyLevel.${energyLevel}`), selectedEnergyLevels.includes(energyLevel), () => toggleEnergyLevel(energyLevel))
                ))}
              </View>

              {timeEstimatesEnabled && effectiveTimeEstimatePresets.length > 0 ? (
                <>
                  <Text style={[styles.sheetSectionLabel, { color: tc.secondaryText }]}>
                    {resolveText('filters.timeEstimate', 'Time estimate')}
                  </Text>
                  <View style={styles.sheetChipRow}>
                    {effectiveTimeEstimatePresets.map((estimate) => (
                      renderFilterChip(
                        formatFocusTimeEstimateLabel(estimate),
                        selectedTimeEstimates.includes(estimate),
                        () => toggleTimeEstimate(estimate),
                      )
                    ))}
                  </View>
                </>
              ) : null}
            </ScrollView>
          </View>
        </View>
      </Modal>
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
  headerTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  activeChipsScroller: {
    marginTop: 8,
    marginHorizontal: -4,
  },
  activeChipsRow: {
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 4,
  },
  filterButton: {
    minWidth: 40,
    minHeight: 36,
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  filterBadge: {
    minWidth: 16,
    height: 16,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  filterBadgeText: {
    fontSize: 10,
    fontWeight: '700',
  },
  filterChip: {
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  filterChipText: {
    fontSize: 12,
    fontWeight: '600',
  },
  clearFiltersButton: {
    justifyContent: 'center',
    paddingHorizontal: 4,
    minHeight: 32,
  },
  clearFiltersText: {
    fontSize: 12,
    fontWeight: '600',
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
  sheetRoot: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheetBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
  },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 20,
    maxHeight: '78%',
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 12,
  },
  sheetTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  sheetHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sheetTextButton: {
    paddingHorizontal: 6,
    paddingVertical: 6,
  },
  sheetTextButtonText: {
    fontSize: 13,
    fontWeight: '600',
  },
  sheetIconButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetScroll: {
    maxHeight: '100%',
  },
  sheetContent: {
    gap: 14,
    paddingBottom: 12,
  },
  sheetSectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  sheetChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
});
