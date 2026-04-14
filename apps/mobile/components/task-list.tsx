import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { View, FlatList, TouchableOpacity, Text, RefreshControl, ActivityIndicator, Keyboard } from 'react-native';
import { router } from 'expo-router';
import {
  useTaskStore,
  Task,
  TaskStatus,
  TimeEstimate,
  sortTasksBy,
  parseQuickAdd,
  safeParseDate,
  getUsedTaskTokens,
  createAIProvider,
  type AIProviderId,
  type TaskSortBy,
  DEFAULT_PROJECT_COLOR,
  getTranslationsSync,
  shallow,
} from '@mindwtr/core';

import { TaskEditModal } from './task-edit-modal';
import { ErrorBoundary } from './ErrorBoundary';
import { ListEmptyState } from './list-empty-state';
import { SwipeableTaskItem } from './swipeable-task-item';
import { useTheme } from '../contexts/theme-context';
import { useLanguage } from '../contexts/language-context';

import { useThemeColors } from '@/hooks/use-theme-colors';
import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { useToast } from '@/contexts/toast-context';
import { taskMatchesAreaFilter } from '@/lib/area-filter';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';
import { buildCopilotConfig, isAIKeyRequired, loadAIKey } from '../lib/ai-config';
import { logError } from '../lib/app-log';
import {
  TaskListBulkBar,
} from './task-list/TaskListBulkBar';
import {
  TaskListHeader,
} from './task-list/TaskListHeader';
import {
  TaskListQuickAdd,
} from './task-list/TaskListQuickAdd';
import {
  TaskListSortModal,
} from './task-list/TaskListSortModal';
import {
  TaskListTagModal,
} from './task-list/TaskListTagModal';
import { styles } from './task-list/task-list.styles';
import {
  matchesSelectedTimeEstimates,
} from './time-estimate-filter-utils';
import { useTaskListSelection } from './use-task-list-selection';

export interface TaskListProps {
  statusFilter: TaskStatus | 'all';
  title: string;
  showHeader?: boolean;
  allowAdd?: boolean;
  projectId?: string;
  staticList?: boolean;
  enableBulkActions?: boolean;
  showSort?: boolean;
  showQuickAddHelp?: boolean;
  emptyText?: string;
  emptyHint?: string;
  headerAccessory?: React.ReactNode;
  enableCopilot?: boolean;
  defaultEditTab?: 'task' | 'view';
  contentPaddingBottom?: number;
}

// ... inside TaskList component
function TaskListComponent({
  statusFilter,
  title,
  showHeader = true,
  allowAdd = true,
  projectId,
  staticList = false,
  enableBulkActions = true,
  showSort = true,
  showQuickAddHelp = true,
  emptyText,
  emptyHint,
  headerAccessory,
  enableCopilot = true,
  defaultEditTab,
  contentPaddingBottom,
}: TaskListProps) {
  const { isDark } = useTheme();
  const { t, language } = useLanguage();
  const { showToast } = useToast();
  const {
    tasks,
    projects,
    sections,
    areas,
    addTask,
    addProject,
    updateTask,
    deleteTask,
    restoreTask,
    fetchData,
    batchMoveTasks,
    batchDeleteTasks,
    batchUpdateTasks,
    settings,
    updateSettings,
    highlightTaskId,
    setHighlightTask,
  } = useTaskStore((state) => ({
    tasks: state.tasks,
    projects: state.projects,
    sections: state.sections,
    areas: state.areas,
    addTask: state.addTask,
    addProject: state.addProject,
    updateTask: state.updateTask,
    deleteTask: state.deleteTask,
    restoreTask: state.restoreTask,
    fetchData: state.fetchData,
    batchMoveTasks: state.batchMoveTasks,
    batchDeleteTasks: state.batchDeleteTasks,
    batchUpdateTasks: state.batchUpdateTasks,
    settings: state.settings,
    updateSettings: state.updateSettings,
    highlightTaskId: state.highlightTaskId,
    setHighlightTask: state.setHighlightTask,
  }), shallow);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [aiKey, setAiKey] = useState('');
  const [copilotSuggestion, setCopilotSuggestion] = useState<{ context?: string; timeEstimate?: Task['timeEstimate']; tags?: string[] } | null>(null);
  const [copilotApplied, setCopilotApplied] = useState(false);
  const [copilotContext, setCopilotContext] = useState<string | undefined>(undefined);
  const [copilotTags, setCopilotTags] = useState<string[]>([]);
  const [copilotThinking, setCopilotThinking] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [sortModalVisible, setSortModalVisible] = useState(false);
  const [selectedTimeEstimates, setSelectedTimeEstimates] = useState<TimeEstimate[]>([]);
  const [inputSelection, setInputSelection] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const [typeaheadOpen, setTypeaheadOpen] = useState(false);
  const [typeaheadIndex, setTypeaheadIndex] = useState(0);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copilotAbortRef = useRef<AbortController | null>(null);
  const copilotRequestIdRef = useRef(0);
  const restoreActionLabel = getTranslationsSync(language)['trash.restoreToInbox']
    || getTranslationsSync('en')['trash.restoreToInbox']
    || 'Restore';

  // Dynamic colors based on theme
  const themeColors = useThemeColors();
  const themeColorsMemo = useMemo(
    () => ({
      bg: themeColors.bg,
      cardBg: themeColors.cardBg,
      taskItemBg: themeColors.taskItemBg,
      text: themeColors.text,
      secondaryText: themeColors.secondaryText,
      icon: themeColors.icon,
      border: themeColors.border,
      tint: themeColors.tint,
      onTint: themeColors.onTint,
      tabIconDefault: themeColors.tabIconDefault,
      tabIconSelected: themeColors.tabIconSelected,
      inputBg: themeColors.inputBg,
      danger: themeColors.danger,
      success: themeColors.success,
      warning: themeColors.warning,
      filterBg: themeColors.filterBg,
    }),
    [
      themeColors.bg,
      themeColors.cardBg,
      themeColors.taskItemBg,
      themeColors.text,
      themeColors.secondaryText,
      themeColors.icon,
      themeColors.border,
      themeColors.tint,
      themeColors.onTint,
      themeColors.tabIconDefault,
      themeColors.tabIconSelected,
      themeColors.inputBg,
      themeColors.danger,
      themeColors.success,
      themeColors.warning,
      themeColors.filterBg,
    ],
  );

  const listContentStyle = useMemo(() => {
    if (!contentPaddingBottom || contentPaddingBottom <= 0) {
      return styles.listContent;
    }
    return [styles.listContent, { paddingBottom: 12 + contentPaddingBottom }];
  }, [contentPaddingBottom]);
  const emptyMessage = emptyText || t('list.noTasks');

  const tasksById = useMemo(() => {
    return tasks.reduce((acc, task) => {
      acc[task.id] = task;
      return acc;
    }, {} as Record<string, Task>);
  }, [tasks]);
  const {
    bulkActionLabel,
    bulkActionLoading,
    exitSelectionMode,
    handleBatchAddTag,
    handleBatchDelete,
    handleBatchMove,
    hasSelection,
    multiSelectedIds,
    selectedIdsArray,
    selectionMode,
    setSelectionMode,
    setTagInput,
    setTagModalVisible,
    tagInput,
    tagModalVisible,
    toggleMultiSelect,
  } = useTaskListSelection({
    batchDeleteTasks,
    batchMoveTasks,
    batchUpdateTasks,
    restoreActionLabel,
    restoreTask,
    t,
    tasksById,
  });

  const sortBy = (settings?.taskSortBy ?? 'default') as TaskSortBy;
  const aiEnabled = settings?.ai?.enabled === true;
  const aiProvider = (settings?.ai?.provider ?? 'openai') as AIProviderId;
  const keyRequired = isAIKeyRequired(settings);
  const timeEstimatesEnabled = settings?.features?.timeEstimates !== false;
  const showTimeEstimateFilters = timeEstimatesEnabled && statusFilter !== 'inbox';
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const hasActiveTimeEstimateFilters = showTimeEstimateFilters && selectedTimeEstimates.length > 0;
  const { areaById, resolvedAreaFilter, selectedAreaIdForNewTasks } = useMobileAreaFilter();

  useEffect(() => {
    if (!showTimeEstimateFilters && selectedTimeEstimates.length > 0) {
      setSelectedTimeEstimates([]);
    }
  }, [selectedTimeEstimates.length, showTimeEstimateFilters]);

  const toggleTimeEstimate = useCallback((estimate: TimeEstimate) => {
    setSelectedTimeEstimates((prev) => (
      prev.includes(estimate)
        ? prev.filter((value) => value !== estimate)
        : [...prev, estimate]
    ));
  }, []);

  // Memoize filtered and sorted tasks for performance
  const filteredTasks = useMemo(() => {
    const now = new Date();
    const filtered = tasks.filter(t => {
      // Filter out soft-deleted tasks
      if (t.deletedAt) return false;
      if (statusFilter === 'all' && t.status === 'reference') return false;
      const matchesStatus = statusFilter === 'all' ? true : t.status === statusFilter;
      const matchesProject = projectId ? t.projectId === projectId : true;
      if (statusFilter === 'inbox') {
        const start = safeParseDate(t.startTime);
        if (start && start > now) return false;
      }
      if (showTimeEstimateFilters && !matchesSelectedTimeEstimates(t, selectedTimeEstimates)) return false;
      if (!taskMatchesAreaFilter(t, resolvedAreaFilter, projectById, areaById)) return false;
      return matchesStatus && matchesProject;
    });
    return filtered;
  }, [tasks, statusFilter, projectId, selectedTimeEstimates, showTimeEstimateFilters, resolvedAreaFilter, projectById, areaById]);

  const orderedTasks = useMemo(() => {
    return sortTasksBy(filteredTasks, sortBy);
  }, [filteredTasks, sortBy]);

  const projectSections = useMemo(() => {
    if (!projectId) return [];
    return sections
      .filter((section) => section.projectId === projectId && !section.deletedAt)
      .sort((a, b) => {
        const aOrder = Number.isFinite(a.order) ? a.order : 0;
        const bOrder = Number.isFinite(b.order) ? b.order : 0;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return a.title.localeCompare(b.title);
      });
  }, [projectId, sections]);

  type ListItem =
    | { type: 'section'; id: string; title: string; count: number; muted?: boolean }
    | { type: 'task'; task: Task };

  const LIST_CONTENT_VERTICAL_PADDING = 12;
  const ESTIMATED_SECTION_HEIGHT = 32;
  const ESTIMATED_TASK_HEIGHT = 86;

  const listItems = useMemo<ListItem[]>(() => {
    if (statusFilter === 'reference' && !projectId) {
      const activeAreas = [...areas].filter((area) => !area.deletedAt).sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        return a.name.localeCompare(b.name);
      });
      const areaIds = new Set(activeAreas.map((area) => area.id));
      const grouped = new Map<string, Task[]>();
      const generalTasks: Task[] = [];

      orderedTasks.forEach((task) => {
        const projectAreaId = task.projectId ? projectById.get(task.projectId)?.areaId : undefined;
        const resolvedAreaId = task.areaId || projectAreaId;
        if (resolvedAreaId && areaIds.has(resolvedAreaId)) {
          const items = grouped.get(resolvedAreaId) ?? [];
          items.push(task);
          grouped.set(resolvedAreaId, items);
        } else {
          generalTasks.push(task);
        }
      });

      const items: ListItem[] = [];
      if (generalTasks.length > 0) {
        items.push({
          type: 'section',
          id: 'general',
          title: t('settings.general') === 'settings.general' ? 'General' : t('settings.general'),
          count: generalTasks.length,
          muted: true,
        });
        generalTasks.forEach((task) => items.push({ type: 'task', task }));
      }

      activeAreas.forEach((area) => {
        const tasksForArea = grouped.get(area.id) ?? [];
        if (tasksForArea.length === 0) return;
        items.push({ type: 'section', id: area.id, title: area.name, count: tasksForArea.length });
        tasksForArea.forEach((task) => items.push({ type: 'task', task }));
      });
      return items;
    }

    const shouldGroup = Boolean(projectId) && (projectSections.length > 0 || orderedTasks.some((task) => task.sectionId));
    if (!shouldGroup) {
      return orderedTasks.map((task) => ({ type: 'task', task }));
    }
    const sectionIds = new Set(projectSections.map((section) => section.id));
    const tasksBySection = new Map<string, Task[]>();
    const unsectioned: Task[] = [];
    orderedTasks.forEach((task) => {
      const sectionId = task.sectionId && sectionIds.has(task.sectionId) ? task.sectionId : null;
      if (sectionId) {
        const list = tasksBySection.get(sectionId) ?? [];
        list.push(task);
        tasksBySection.set(sectionId, list);
      } else {
        unsectioned.push(task);
      }
    });
    const items: ListItem[] = [];
    projectSections.forEach((section) => {
      const tasksForSection = tasksBySection.get(section.id) ?? [];
      if (tasksForSection.length === 0) return;
      items.push({ type: 'section', id: section.id, title: section.title, count: tasksForSection.length });
      tasksForSection.forEach((task) => items.push({ type: 'task', task }));
    });
    if (unsectioned.length > 0) {
      items.push({
        type: 'section',
        id: 'no-section',
        title: t('projects.noSection'),
        count: unsectioned.length,
        muted: true,
      });
      unsectioned.forEach((task) => items.push({ type: 'task', task }));
    }
    return items;
  }, [areas, orderedTasks, projectById, projectId, projectSections, statusFilter, t]);
  const itemHeightsRef = useRef<Record<string, number>>({});
  const [itemLayoutVersion, setItemLayoutVersion] = useState(0);
  const getListItemKey = useCallback((item: ListItem) => (
    item.type === 'section' ? `section-${item.id}` : item.task.id
  ), []);
  const estimateItemHeight = useCallback((item: ListItem) => (
    item.type === 'section' ? ESTIMATED_SECTION_HEIGHT : ESTIMATED_TASK_HEIGHT
  ), []);
  const registerItemHeight = useCallback((itemKey: string, height: number) => {
    const rounded = Math.round(height);
    if (!Number.isFinite(rounded) || rounded <= 0) return;
    if (itemHeightsRef.current[itemKey] === rounded) return;
    itemHeightsRef.current[itemKey] = rounded;
    setItemLayoutVersion((prev) => prev + 1);
  }, []);
  const itemLayouts = useMemo(() => {
    // itemLayoutVersion invalidates memoized offsets when ref-backed row heights change.
    void itemLayoutVersion;
    let offset = LIST_CONTENT_VERTICAL_PADDING;
    return listItems.map((item) => {
      const key = getListItemKey(item);
      const length = itemHeightsRef.current[key] ?? estimateItemHeight(item);
      const layout = { length, offset };
      offset += length;
      return layout;
    });
  }, [estimateItemHeight, getListItemKey, itemLayoutVersion, listItems]);
  const getItemLayout = useCallback((_: ArrayLike<ListItem> | null | undefined, index: number) => {
    const measured = itemLayouts[index];
    if (measured) {
      return { index, length: measured.length, offset: measured.offset };
    }
    return {
      index,
      length: ESTIMATED_TASK_HEIGHT,
      offset: LIST_CONTENT_VERTICAL_PADDING + (ESTIMATED_TASK_HEIGHT * index),
    };
  }, [itemLayouts]);

  const contextOptions = useMemo(() => {
    return getUsedTaskTokens(tasks, (task) => task.contexts, { prefix: '@' });
  }, [tasks]);
  const tagOptions = useMemo(() => {
    return getUsedTaskTokens(tasks, (task) => task.tags, { prefix: '#' });
  }, [tasks]);

  type TriggerType = 'project' | 'context';
  type TriggerState = { type: TriggerType; start: number; end: number; query: string };
  type Option =
    | { kind: 'create'; label: string; value: string }
    | { kind: 'project'; label: string; value: string }
    | { kind: 'context'; label: string; value: string };

  const getTrigger = useCallback((text: string, caret: number): TriggerState | null => {
    if (caret < 0) return null;
    const before = text.slice(0, caret);
    const lastSpace = Math.max(before.lastIndexOf(' '), before.lastIndexOf('\n'), before.lastIndexOf('\t'));
    const start = lastSpace + 1;
    const token = before.slice(start);
    if (!token.startsWith('+') && !token.startsWith('@')) return null;
    return {
      type: token.startsWith('+') ? 'project' : 'context',
      start,
      end: caret,
      query: token.slice(1),
    };
  }, []);

  const trigger = useMemo(() => {
    return getTrigger(newTaskTitle, inputSelection.start ?? newTaskTitle.length);
  }, [getTrigger, inputSelection.start, newTaskTitle]);

  const typeaheadOptions = useMemo<Option[]>(() => {
    if (!trigger) return [];
    const query = trigger.query.trim().toLowerCase();
    if (trigger.type === 'project') {
      const matches = projects.filter((project) => project.title.toLowerCase().includes(query));
      const hasExact = query.length > 0 && projects.some((project) => project.title.toLowerCase() === query);
      const result: Option[] = [];
      if (!hasExact && query.length > 0) {
        result.push({
          kind: 'create' as const,
          label: `Create \"${trigger.query.trim()}\"`,
          value: trigger.query.trim(),
        });
      }
      result.push(
        ...matches.map((project) => ({
          kind: 'project' as const,
          label: project.title,
          value: project.title,
        }))
      );
      return result;
    }
    const matches = contextOptions.filter((context) => {
      const raw = context.startsWith('@') || context.startsWith('#') ? context.slice(1) : context;
      return raw.toLowerCase().includes(query);
    });
    return matches.map((context) => ({
      kind: 'context' as const,
      label: context,
      value: context,
    }));
  }, [contextOptions, projects, trigger]);

  useEffect(() => {
    if (!trigger || typeaheadOptions.length === 0) {
      setTypeaheadOpen(false);
      return;
    }
    setTypeaheadOpen(true);
  }, [trigger, typeaheadOptions.length]);

  useEffect(() => {
    loadAIKey(aiProvider).then(setAiKey).catch((error) => {
      void logError(error, { scope: 'ai', extra: { message: 'Failed to load AI key' } });
      showToast({
        title: t('ai.errorTitle'),
        message: t('ai.disabledBody'),
        tone: 'warning',
        durationMs: 4200,
      });
    });
  }, [aiProvider, showToast, t]);

  useEffect(() => {
    if (!enableCopilot || !aiEnabled || (keyRequired && !aiKey)) {
      setCopilotSuggestion(null);
      setCopilotThinking(false);
      return;
    }
    const title = newTaskTitle.trim();
    if (title.length < 4) {
      setCopilotSuggestion(null);
      setCopilotThinking(false);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      const requestId = copilotRequestIdRef.current + 1;
      copilotRequestIdRef.current = requestId;
      setCopilotThinking(true);
      try {
        if (copilotAbortRef.current) copilotAbortRef.current.abort();
        const abortController = typeof AbortController === 'function' ? new AbortController() : null;
        copilotAbortRef.current = abortController;
        const provider = createAIProvider(buildCopilotConfig(settings, aiKey));
        const suggestion = await provider.predictMetadata(
          { title, contexts: contextOptions, tags: tagOptions },
          abortController ? { signal: abortController.signal } : undefined
        );
        if (cancelled) return;
        if (!suggestion.context && (!timeEstimatesEnabled || !suggestion.timeEstimate) && !suggestion.tags?.length) {
          setCopilotSuggestion(null);
        } else {
          setCopilotSuggestion(suggestion);
        }
      } catch {
        if (!cancelled) {
          setCopilotSuggestion(null);
        }
      } finally {
        if (!cancelled && copilotRequestIdRef.current === requestId) {
          setCopilotThinking(false);
        }
      }
    }, 800);
    return () => {
      cancelled = true;
      clearTimeout(handle);
      if (copilotAbortRef.current) {
        copilotAbortRef.current.abort();
        copilotAbortRef.current = null;
      }
    };
  }, [aiEnabled, aiKey, aiProvider, contextOptions, enableCopilot, keyRequired, newTaskTitle, settings, statusFilter, tagOptions, timeEstimatesEnabled]);

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

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  }, [fetchData]);

  const handleAddTask = async () => {
    if (!newTaskTitle.trim()) return;

    const defaultStatus: TaskStatus = projectId
      ? 'next'
      : (statusFilter !== 'all' ? statusFilter : 'inbox');

    const { title: parsedTitle, props, projectTitle, invalidDateCommands } = parseQuickAdd(newTaskTitle, projects, new Date(), areas);
    if (invalidDateCommands && invalidDateCommands.length > 0) {
      showToast({
        title: t('common.notice'),
        message: `${t('quickAdd.invalidDateCommand')}: ${invalidDateCommands.join(', ')}`,
        tone: 'warning',
        durationMs: 4200,
      });
      return;
    }
    const finalTitle = parsedTitle || newTaskTitle;
    if (!finalTitle.trim()) return;

    const initialProps: Partial<Task> = { projectId, status: defaultStatus, ...props };
    if (!props.status) initialProps.status = defaultStatus;
    if (!props.projectId && projectId) initialProps.projectId = projectId;
    if (!initialProps.projectId && projectTitle) {
      const created = await addProject(projectTitle, DEFAULT_PROJECT_COLOR);
      if (!created) return;
      initialProps.projectId = created.id;
    }
    if (!initialProps.projectId && !initialProps.areaId && selectedAreaIdForNewTasks) {
      initialProps.areaId = selectedAreaIdForNewTasks;
    }
    if (initialProps.projectId) {
      initialProps.areaId = undefined;
    }
    if (copilotContext) {
      const nextContexts = Array.from(new Set([...(initialProps.contexts ?? []), copilotContext]));
      initialProps.contexts = nextContexts;
    }
    if (copilotTags.length) {
      const nextTags = Array.from(new Set([...(initialProps.tags ?? []), ...copilotTags]));
      initialProps.tags = nextTags;
    }

    await addTask(finalTitle, initialProps);
    setNewTaskTitle('');
    setTypeaheadOpen(false);
    setCopilotSuggestion(null);
    setCopilotApplied(false);
    setCopilotContext(undefined);
    setCopilotTags([]);
    Keyboard.dismiss();
  };

  const applyTypeaheadOption = useCallback(async (option: Option) => {
    if (!trigger) return;
    let tokenValue = option.value;
    if (option.kind === 'create') {
      const title = option.value.trim();
      if (title) {
        await addProject(title, DEFAULT_PROJECT_COLOR);
      }
    }
    if (trigger.type === 'project') {
      tokenValue = `+${tokenValue}`;
    } else {
      tokenValue = tokenValue.startsWith('@') ? tokenValue : `@${tokenValue}`;
    }
    const before = newTaskTitle.slice(0, trigger.start);
    const after = newTaskTitle.slice(trigger.end);
    const needsSpace = after.length > 0 && !/^\s/.test(after);
    const nextValue = `${before}${tokenValue}${needsSpace ? ' ' : ''}${after}`;
    setNewTaskTitle(nextValue);
    const caret = before.length + tokenValue.length + (needsSpace ? 1 : 0);
    setInputSelection({ start: caret, end: caret });
    setTypeaheadOpen(false);
    setTypeaheadIndex(0);
  }, [addProject, newTaskTitle, trigger]);

  const handleEditTask = useCallback((task: Task) => {
    setEditingTask(task);
    setIsModalVisible(true);
  }, []);

  const onSaveTask = useCallback((taskId: string, updates: Partial<Task>) => {
    updateTask(taskId, updates);
    setIsModalVisible(false);
    setEditingTask(null);
  }, [updateTask]);

  const sortOptions: TaskSortBy[] = ['default', 'due', 'start', 'review', 'title', 'created', 'created-desc'];
  const hideStatusBadgeForList = statusFilter === 'next' || statusFilter === 'waiting';
  const hideChecklistProgressForList = statusFilter === 'inbox';

  const renderTask = useCallback(({ item }: { item: Task }) => (
    <ErrorBoundary>
      <SwipeableTaskItem
        task={item}
        isDark={isDark}
        tc={themeColorsMemo}
        onPress={() => handleEditTask(item)}
        selectionMode={enableBulkActions ? selectionMode : false}
        isMultiSelected={enableBulkActions && multiSelectedIds.has(item.id)}
        onToggleSelect={enableBulkActions ? () => toggleMultiSelect(item.id) : undefined}
        onStatusChange={(status) => updateTask(item.id, { status: status as TaskStatus })}
        onDelete={() => deleteTask(item.id)}
        isHighlighted={item.id === highlightTaskId}
        hideStatusBadge={hideStatusBadgeForList}
        hideChecklistProgress={hideChecklistProgressForList}
        onProjectPress={projectId ? undefined : openProjectScreen}
        onContextPress={openContextsScreen}
        onTagPress={openContextsScreen}
      />
    </ErrorBoundary>
  ), [
    deleteTask,
    enableBulkActions,
    handleEditTask,
    highlightTaskId,
    isDark,
    multiSelectedIds,
    selectionMode,
    hideChecklistProgressForList,
    hideStatusBadgeForList,
    themeColorsMemo,
    toggleMultiSelect,
    updateTask,
    projectId,
  ]);

  const renderListItem = useCallback(({ item }: { item: ListItem }) => {
    const itemKey = getListItemKey(item);
    if (item.type === 'section') {
      return (
        <View
          style={styles.sectionHeader}
          onLayout={(event) => registerItemHeight(itemKey, event.nativeEvent.layout.height)}
        >
          <Text style={[styles.sectionTitle, { color: item.muted ? themeColorsMemo.secondaryText : themeColorsMemo.text }]}>
            {item.title}
          </Text>
          <Text style={[styles.sectionCount, { color: themeColorsMemo.secondaryText }]}>
            {item.count}
          </Text>
        </View>
      );
    }
    return (
      <View onLayout={(event) => registerItemHeight(itemKey, event.nativeEvent.layout.height)}>
        {renderTask({ item: item.task })}
      </View>
    );
  }, [getListItemKey, registerItemHeight, renderTask, themeColorsMemo.secondaryText, themeColorsMemo.text]);
  return (
    <View style={[styles.container, { backgroundColor: themeColorsMemo.bg }]}>
      <TaskListHeader
        count={orderedTasks.length}
        enableBulkActions={enableBulkActions}
        hasActiveTimeEstimateFilters={hasActiveTimeEstimateFilters}
        headerAccessory={headerAccessory}
        onOpenSort={() => setSortModalVisible(true)}
        onToggleSelectionMode={() => (selectionMode ? exitSelectionMode() : setSelectionMode(true))}
        selectedTimeEstimates={selectedTimeEstimates}
        selectionMode={selectionMode}
        setTimeEstimates={() => setSelectedTimeEstimates([])}
        showHeader={showHeader}
        showSort={showSort}
        showTimeEstimateFilters={showTimeEstimateFilters}
        sortByLabel={t(`sort.${sortBy}`)}
        t={t}
        themeColors={themeColorsMemo}
        title={title}
        toggleTimeEstimate={toggleTimeEstimate}
      />

      {enableBulkActions && selectionMode && (
        <TaskListBulkBar
          bulkActionLabel={bulkActionLabel}
          bulkActionLoading={bulkActionLoading}
          handleBatchDelete={handleBatchDelete}
          handleBatchMove={handleBatchMove}
          hasSelection={hasSelection}
          onOpenTagModal={() => setTagModalVisible(true)}
          selectedCount={selectedIdsArray.length}
          t={t}
          themeColors={themeColorsMemo}
        />
      )}

      {allowAdd && (
        <TaskListQuickAdd
          aiEnabled={aiEnabled}
          applyTypeaheadOption={applyTypeaheadOption}
          copilotApplied={copilotApplied}
          copilotContext={copilotContext}
          copilotSuggestion={copilotSuggestion}
          copilotTags={copilotTags}
          copilotThinking={copilotThinking}
          enableCopilot={enableCopilot}
          handleAddTask={handleAddTask}
          newTaskTitle={newTaskTitle}
          onApplyCopilot={() => {
            setCopilotContext(copilotSuggestion?.context);
            setCopilotTags(copilotSuggestion?.tags ?? []);
            setCopilotApplied(true);
          }}
          onChangeText={(text) => {
            setNewTaskTitle(text);
            setInputSelection({ start: text.length, end: text.length });
            setCopilotApplied(false);
            setCopilotContext(undefined);
            setCopilotTags([]);
          }}
          onSelectionChange={(selection) => {
            setInputSelection(selection);
            setTypeaheadOpen(Boolean(getTrigger(newTaskTitle, selection.start ?? newTaskTitle.length)));
          }}
          projectId={projectId}
          setTypeaheadIndex={setTypeaheadIndex}
          showQuickAddHelp={showQuickAddHelp}
          t={t}
          themeColors={themeColorsMemo}
          title={title}
          trigger={trigger}
          typeaheadIndex={typeaheadIndex}
          typeaheadOpen={typeaheadOpen}
          typeaheadOptions={typeaheadOptions}
        />
      )}

      {staticList ? (
        <View style={styles.staticList}>
          {listItems.length === 0 ? (
            <ListEmptyState
              message={emptyMessage}
              hint={emptyHint}
              backgroundColor={themeColorsMemo.cardBg}
              borderColor={themeColorsMemo.border}
              textColor={themeColorsMemo.text}
              mutedTextColor={themeColorsMemo.secondaryText}
            />
          ) : (
            listItems.map((item) => (
              <View key={item.type === 'section' ? `section-${item.id}` : item.task.id} style={styles.staticItem}>
                {renderListItem({ item })}
              </View>
            ))
          )}
        </View>
      ) : (
        <FlatList
          data={listItems}
          renderItem={renderListItem}
          keyExtractor={(item) => (item.type === 'section' ? `section-${item.id}` : item.task.id)}
          style={styles.list}
          contentContainerStyle={listContentStyle}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          getItemLayout={getItemLayout}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={5}
          updateCellsBatchingPeriod={50}
          removeClippedSubviews={listItems.length >= 25}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          ListEmptyComponent={
            <ListEmptyState
              message={emptyMessage}
              hint={emptyHint}
              backgroundColor={themeColorsMemo.cardBg}
              borderColor={themeColorsMemo.border}
              textColor={themeColorsMemo.text}
              mutedTextColor={themeColorsMemo.secondaryText}
            />
          }
        />
      )}

      <TaskListTagModal
        onChangeTag={setTagInput}
        onClose={() => {
          setTagModalVisible(false);
          setTagInput('');
        }}
        onSave={handleBatchAddTag}
        t={t}
        tagInput={tagInput}
        themeColors={themeColorsMemo}
        visible={tagModalVisible}
      />

      <TaskListSortModal
        onClose={() => setSortModalVisible(false)}
        onSelect={(option) => {
          updateSettings({ taskSortBy: option });
          setSortModalVisible(false);
        }}
        sortBy={sortBy}
        sortOptions={sortOptions}
        t={t}
        themeColors={themeColorsMemo}
        visible={sortModalVisible}
      />

      <ErrorBoundary>
        <TaskEditModal
          visible={isModalVisible}
          task={editingTask}
          onClose={() => setIsModalVisible(false)}
          onSave={onSaveTask}
          defaultTab={defaultEditTab}
          onProjectNavigate={projectId ? undefined : openProjectScreen}
          onContextNavigate={openContextsScreen}
          onTagNavigate={openContextsScreen}
          onFocusMode={(taskId) => {
            setIsModalVisible(false);
            router.push(`/check-focus?id=${taskId}`);
          }}
        />
      </ErrorBoundary>
    </View>
  );
}

export const TaskList = React.memo(TaskListComponent);
