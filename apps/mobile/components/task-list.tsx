import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { View, TextInput, FlatList, StyleSheet, TouchableOpacity, Text, RefreshControl, ScrollView, Modal, Pressable, Alert, ActivityIndicator, Keyboard } from 'react-native';
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
import { taskMatchesAreaFilter } from '@/lib/area-filter';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';
import { buildCopilotConfig, isAIKeyRequired, loadAIKey } from '../lib/ai-config';
import { logError } from '../lib/app-log';
import { getBulkActionFailureMessage } from './task-list-utils';
import {
  MOBILE_TIME_ESTIMATE_OPTIONS,
  formatTimeEstimateChipLabel,
  matchesSelectedTimeEstimates,
} from './time-estimate-filter-utils';

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
  headerAccessory,
  enableCopilot = true,
  defaultEditTab,
  contentPaddingBottom,
}: TaskListProps) {
  const { isDark } = useTheme();
  const { t } = useLanguage();
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
  const [selectionMode, setSelectionMode] = useState(false);
  const [multiSelectedIds, setMultiSelectedIds] = useState<Set<string>>(new Set());
  const [tagModalVisible, setTagModalVisible] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [sortModalVisible, setSortModalVisible] = useState(false);
  const [bulkActionLoading, setBulkActionLoading] = useState(false);
  const [bulkActionLabel, setBulkActionLabel] = useState('');
  const [selectedTimeEstimates, setSelectedTimeEstimates] = useState<TimeEstimate[]>([]);
  const [inputSelection, setInputSelection] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const [typeaheadOpen, setTypeaheadOpen] = useState(false);
  const [typeaheadIndex, setTypeaheadIndex] = useState(0);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copilotAbortRef = useRef<AbortController | null>(null);
  const copilotRequestIdRef = useRef(0);

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

  const sortBy = (settings?.taskSortBy ?? 'default') as TaskSortBy;
  const aiEnabled = settings?.ai?.enabled === true;
  const aiProvider = (settings?.ai?.provider ?? 'openai') as AIProviderId;
  const keyRequired = isAIKeyRequired(settings);
  const timeEstimatesEnabled = settings?.features?.timeEstimates === true;
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const hasActiveTimeEstimateFilters = timeEstimatesEnabled && selectedTimeEstimates.length > 0;
  const { areaById, resolvedAreaFilter, selectedAreaIdForNewTasks } = useMobileAreaFilter();

  useEffect(() => {
    if (!timeEstimatesEnabled && selectedTimeEstimates.length > 0) {
      setSelectedTimeEstimates([]);
    }
  }, [selectedTimeEstimates.length, timeEstimatesEnabled]);

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
      if (timeEstimatesEnabled && !matchesSelectedTimeEstimates(t, selectedTimeEstimates)) return false;
      if (!taskMatchesAreaFilter(t, resolvedAreaFilter, projectById, areaById)) return false;
      return matchesStatus && matchesProject;
    });
    return filtered;
  }, [tasks, statusFilter, projectId, selectedTimeEstimates, timeEstimatesEnabled, resolvedAreaFilter, projectById, areaById]);

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
    });
  }, [aiProvider]);

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
      Alert.alert(t('common.notice'), `${t('quickAdd.invalidDateCommand')}: ${invalidDateCommands.join(', ')}`);
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

  const selectedIdsArray = useMemo(() => Array.from(multiSelectedIds), [multiSelectedIds]);
  const hasSelection = selectedIdsArray.length > 0;

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setMultiSelectedIds(new Set());
  }, []);
  const runBulkAction = useCallback(async (label: string, action: () => Promise<void>) => {
    if (bulkActionLoading) return;
    setBulkActionLabel(label);
    setBulkActionLoading(true);
    try {
      await action();
    } catch (error) {
      void logError(error, { scope: 'tasks', extra: { message: `Bulk action failed: ${label}` } });
      Alert.alert(
        t('common.notice'),
        getBulkActionFailureMessage(error, `${label} failed.`)
      );
    } finally {
      setBulkActionLoading(false);
      setBulkActionLabel('');
    }
  }, [bulkActionLoading, t]);

  const toggleMultiSelect = useCallback((taskId: string) => {
    if (!selectionMode) setSelectionMode(true);
    setMultiSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, [selectionMode]);

  const handleBatchMove = useCallback(async (newStatus: TaskStatus) => {
    if (!hasSelection || bulkActionLoading) return;
    await runBulkAction(t('bulk.moveTo'), async () => {
      await batchMoveTasks(selectedIdsArray, newStatus);
      exitSelectionMode();
      Alert.alert(t('common.done'), `${selectedIdsArray.length} ${t('common.tasks')}`);
    });
  }, [batchMoveTasks, selectedIdsArray, hasSelection, exitSelectionMode, t, bulkActionLoading, runBulkAction]);

  const handleBatchDelete = useCallback(async () => {
    if (!hasSelection || bulkActionLoading) return;
    Alert.alert(
      t('bulk.confirmDeleteTitle') || t('common.delete'),
      t('bulk.confirmDeleteBody') || t('list.confirmBatchDelete'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: async () => {
            const deletedIds = [...selectedIdsArray];
            await runBulkAction(t('common.delete'), async () => {
              await batchDeleteTasks(deletedIds);
              exitSelectionMode();
              Alert.alert(
                t('common.done'),
                `${deletedIds.length} ${t('common.tasks')}`,
                [
                  {
                    text: t('trash.restoreToInbox') === 'trash.restoreToInbox' ? 'Restore' : t('trash.restoreToInbox'),
                    onPress: () => {
                      deletedIds.forEach((id) => {
                        void restoreTask(id);
                      });
                    },
                  },
                  {
                    text: t('common.cancel'),
                    style: 'cancel',
                  },
                ]
              );
            });
          },
        },
      ]
    );
  }, [batchDeleteTasks, selectedIdsArray, hasSelection, exitSelectionMode, t, bulkActionLoading, restoreTask, runBulkAction]);

  const handleBatchAddTag = useCallback(async () => {
    const input = tagInput.trim();
    if (!hasSelection || !input || bulkActionLoading) return;
    const tag = input.startsWith('#') ? input : `#${input}`;
    await runBulkAction(t('bulk.addTag'), async () => {
      await batchUpdateTasks(selectedIdsArray.map((id) => {
        const task = tasksById[id];
        const existingTags = task?.tags || [];
        const nextTags = Array.from(new Set([...existingTags, tag]));
        return { id, updates: { tags: nextTags } };
      }));
      setTagInput('');
      setTagModalVisible(false);
      exitSelectionMode();
      Alert.alert(t('common.done'), `${selectedIdsArray.length} ${t('common.tasks')}`);
    });
  }, [batchUpdateTasks, selectedIdsArray, tasksById, tagInput, hasSelection, exitSelectionMode, t, bulkActionLoading, runBulkAction]);

  const sortOptions: TaskSortBy[] = ['default', 'due', 'start', 'review', 'title', 'created', 'created-desc'];
  const hideStatusBadgeForList = statusFilter === 'next' || statusFilter === 'waiting';

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
      {showHeader ? (
        <View style={[styles.header, { borderBottomColor: themeColorsMemo.border, backgroundColor: themeColorsMemo.cardBg }]}>
          <View style={styles.headerTopRow}>
            <Text style={[styles.title, { color: themeColorsMemo.text }]} accessibilityRole="header" numberOfLines={1}>
              {title}
            </Text>
            <Text style={[styles.count, { color: themeColorsMemo.secondaryText }]} accessibilityLabel={`${orderedTasks.length} tasks`}>
              {orderedTasks.length} {t('common.tasks')}
            </Text>
          </View>
          <View style={styles.headerActions}>
            {showSort && (
              <TouchableOpacity
                onPress={() => setSortModalVisible(true)}
                style={[styles.sortButton, { borderColor: themeColorsMemo.border }]}
                accessibilityRole="button"
                accessibilityLabel={t('sort.label')}
              >
                <Text style={[styles.sortButtonText, { color: themeColorsMemo.secondaryText }]}>
                  {t(`sort.${sortBy}`)}
                </Text>
              </TouchableOpacity>
            )}
            {headerAccessory}
            {enableBulkActions && (
              <TouchableOpacity
                onPress={() => (selectionMode ? exitSelectionMode() : setSelectionMode(true))}
                style={[
                  styles.selectButton,
                  { borderColor: themeColors.border, backgroundColor: selectionMode ? themeColors.filterBg : 'transparent' }
                ]}
                accessibilityRole="button"
                accessibilityLabel={selectionMode ? t('bulk.exitSelect') : t('bulk.select')}
              >
                <Text style={[styles.selectButtonText, { color: themeColors.text }]}>
                  {selectionMode ? t('bulk.exitSelect') : t('bulk.select')}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      ) : headerAccessory ? (
        <View style={styles.headerAccessoryRow}>{headerAccessory}</View>
      ) : null}

      {timeEstimatesEnabled && (
        <View style={[styles.filterSection, { borderBottomColor: themeColorsMemo.border, backgroundColor: themeColorsMemo.cardBg }]}>
          <Text style={[styles.filterLabel, { color: themeColorsMemo.secondaryText }]}>
            {t('filters.timeEstimate')}
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterChips}>
            <TouchableOpacity
              onPress={() => setSelectedTimeEstimates([])}
              style={[
                styles.filterChip,
                {
                  borderColor: themeColorsMemo.border,
                  backgroundColor: !hasActiveTimeEstimateFilters ? themeColorsMemo.tint : themeColorsMemo.filterBg,
                },
              ]}
              accessibilityRole="button"
              accessibilityState={{ selected: !hasActiveTimeEstimateFilters }}
            >
              <Text style={[styles.filterChipText, { color: !hasActiveTimeEstimateFilters ? themeColorsMemo.onTint : themeColorsMemo.text }]}>
                {t('common.all')}
              </Text>
            </TouchableOpacity>
            {MOBILE_TIME_ESTIMATE_OPTIONS.map((estimate) => {
              const isActive = selectedTimeEstimates.includes(estimate);
              return (
                <TouchableOpacity
                  key={estimate}
                  onPress={() => toggleTimeEstimate(estimate)}
                  style={[
                    styles.filterChip,
                    {
                      borderColor: themeColorsMemo.border,
                      backgroundColor: isActive ? themeColorsMemo.tint : themeColorsMemo.filterBg,
                    },
                  ]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isActive }}
                >
                  <Text style={[styles.filterChipText, { color: isActive ? themeColorsMemo.onTint : themeColorsMemo.text }]}>
                    {formatTimeEstimateChipLabel(estimate)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      {enableBulkActions && selectionMode && (
        <View style={[styles.bulkBar, { backgroundColor: themeColors.cardBg, borderBottomColor: themeColors.border }]}>
          <View style={styles.bulkStatusRow}>
            <Text style={[styles.bulkCount, { color: themeColors.secondaryText }]}>
              {selectedIdsArray.length} {t('bulk.selected')}
            </Text>
            {bulkActionLoading && (
              <View style={styles.bulkLoadingRow}>
                <ActivityIndicator size="small" color={themeColors.tint} />
                <Text style={[styles.bulkLoadingText, { color: themeColors.secondaryText }]}>
                  {bulkActionLabel || t('common.loading')}
                </Text>
              </View>
            )}
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.bulkMoveRow}>
            {(['inbox', 'next', 'waiting', 'someday', 'reference', 'done'] as TaskStatus[]).map((status) => (
              <TouchableOpacity
                key={status}
                onPress={() => handleBatchMove(status)}
                disabled={!hasSelection || bulkActionLoading}
                style={[styles.bulkMoveButton, { backgroundColor: themeColors.filterBg, opacity: hasSelection && !bulkActionLoading ? 1 : 0.5 }]}
                accessibilityRole="button"
                accessibilityLabel={`${t('bulk.moveTo')} ${t(`status.${status}`)}`}
              >
                <Text style={[styles.bulkMoveText, { color: themeColors.text }]}>{t(`status.${status}`)}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <View style={styles.bulkActions}>
            <TouchableOpacity
              onPress={() => setTagModalVisible(true)}
              disabled={!hasSelection || bulkActionLoading}
              style={[styles.bulkActionButton, { backgroundColor: themeColors.filterBg, opacity: hasSelection && !bulkActionLoading ? 1 : 0.5 }]}
              accessibilityRole="button"
              accessibilityLabel={t('bulk.addTag')}
            >
              <Text style={[styles.bulkActionText, { color: themeColors.text }]}>{t('bulk.addTag')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleBatchDelete}
              disabled={!hasSelection || bulkActionLoading}
              style={[styles.bulkActionButton, { backgroundColor: themeColors.filterBg, opacity: hasSelection && !bulkActionLoading ? 1 : 0.5 }]}
              accessibilityRole="button"
              accessibilityLabel={t('bulk.delete')}
            >
              <Text style={[styles.bulkActionText, { color: themeColors.text }]}>{t('bulk.delete')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {allowAdd && (
        <>
          <View style={[styles.inputContainer, { borderBottomColor: themeColors.border }]}>
            <TextInput
              style={[styles.input, { backgroundColor: themeColors.inputBg, borderColor: themeColors.border, color: themeColors.text }]}
              autoCapitalize="sentences"
              autoCorrect={false}
              placeholder={t('inbox.addPlaceholder')}
              placeholderTextColor={themeColors.secondaryText}
              value={newTaskTitle}
              onChangeText={(text) => {
                setNewTaskTitle(text);
                setInputSelection({ start: text.length, end: text.length });
                setTypeaheadIndex(0);
                setCopilotApplied(false);
                setCopilotContext(undefined);
                setCopilotTags([]);
              }}
              onSelectionChange={(event) => {
                const selection = event.nativeEvent.selection;
                setInputSelection(selection);
                setTypeaheadOpen(Boolean(getTrigger(newTaskTitle, selection.start ?? newTaskTitle.length)));
              }}
              onSubmitEditing={handleAddTask}
              returnKeyType="done"
              accessibilityLabel={`Input new task for ${title}`}
              accessibilityHint="Type task title, then tap add button or enter"
            />
            <TouchableOpacity
              onPress={handleAddTask}
              style={[
                styles.addButton,
                { backgroundColor: themeColors.tint },
                !newTaskTitle.trim() && styles.addButtonDisabled
              ]}
              disabled={!newTaskTitle.trim()}
              accessibilityLabel="Add Task"
              accessibilityRole="button"
              accessibilityState={{ disabled: !newTaskTitle.trim() }}
            >
              <Text style={styles.addButtonText}>+</Text>
            </TouchableOpacity>
          </View>
          {typeaheadOpen && trigger && typeaheadOptions.length > 0 && (
            <View style={[styles.typeaheadContainer, { backgroundColor: themeColors.cardBg, borderColor: themeColors.border }]}>
              {typeaheadOptions.map((option, index) => (
                <TouchableOpacity
                  key={`${option.kind}:${option.value}`}
                  onPress={() => applyTypeaheadOption(option)}
                  style={[
                    styles.typeaheadRow,
                    index === typeaheadIndex && { backgroundColor: themeColors.filterBg },
                  ]}
                >
                  <Text style={[styles.typeaheadText, { color: themeColors.text }]}>
                    {option.kind === 'create' ? `✨ ${option.label}` : option.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
          {enableCopilot && aiEnabled && copilotSuggestion && !copilotApplied && (
            <TouchableOpacity
              style={[styles.copilotPill, { borderColor: themeColors.border, backgroundColor: themeColors.inputBg }]}
              onPress={() => {
                setCopilotContext(copilotSuggestion.context);
                setCopilotTags(copilotSuggestion.tags ?? []);
                setCopilotApplied(true);
              }}
            >
              <Text style={[styles.copilotText, { color: themeColors.text }]}>
                ✨ {t('copilot.suggested')}{' '}
                {copilotSuggestion.context ? `${copilotSuggestion.context} ` : ''}
                {copilotSuggestion.tags?.length ? copilotSuggestion.tags.join(' ') : ''}
              </Text>
              <Text style={[styles.copilotHint, { color: themeColors.secondaryText }]}>
                {t('copilot.applyHint')}
              </Text>
            </TouchableOpacity>
          )}
          {enableCopilot && aiEnabled && copilotThinking && !copilotSuggestion && !copilotApplied && (
            <View style={[styles.copilotPill, styles.copilotLoadingRow, { borderColor: themeColors.border, backgroundColor: themeColors.inputBg }]}>
              <ActivityIndicator size="small" color={themeColors.tint} />
              <Text style={[styles.copilotHint, { color: themeColors.secondaryText, marginTop: 0 }]}>
                {t('common.loading')}
              </Text>
            </View>
          )}
          {enableCopilot && aiEnabled && copilotApplied && (
            <View style={[styles.copilotPill, { borderColor: themeColors.border, backgroundColor: themeColors.inputBg }]}>
              <Text style={[styles.copilotText, { color: themeColors.text }]}>
                ✅ {t('copilot.applied')}{' '}
                {copilotContext ? `${copilotContext} ` : ''}
                {copilotTags.length ? copilotTags.join(' ') : ''}
              </Text>
            </View>
          )}
          {showQuickAddHelp && !projectId && (
            <Text style={[styles.quickAddHelp, { color: themeColors.secondaryText }]}>
              {t('quickAdd.help')}
            </Text>
          )}
        </>
      )}

      {staticList ? (
        <View style={styles.staticList}>
          {listItems.length === 0 ? (
            <ListEmptyState
              message={emptyMessage}
              backgroundColor={themeColors.cardBg}
              borderColor={themeColors.border}
              textColor={themeColors.text}
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
              backgroundColor={themeColors.cardBg}
              borderColor={themeColors.border}
              textColor={themeColors.text}
            />
          }
        />
      )}

      <Modal
        visible={tagModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setTagModalVisible(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setTagModalVisible(false)}>
          <Pressable
            style={[styles.modalCard, { backgroundColor: themeColors.cardBg }]}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={[styles.modalTitle, { color: themeColors.text }]}>{t('bulk.addTag')}</Text>
            <TextInput
              value={tagInput}
              onChangeText={setTagInput}
              placeholder={t('taskEdit.tagsLabel')}
              placeholderTextColor={themeColors.secondaryText}
              style={[
                styles.modalInput,
                { backgroundColor: themeColors.inputBg, color: themeColors.text, borderColor: themeColors.border }
              ]}
            />
            <View style={styles.modalButtons}>
              <TouchableOpacity
                onPress={() => {
                  setTagModalVisible(false);
                  setTagInput('');
                }}
                style={styles.modalButton}
              >
                <Text style={[styles.modalButtonText, { color: themeColors.secondaryText }]}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleBatchAddTag}
                disabled={!tagInput.trim()}
                style={[styles.modalButton, !tagInput.trim() && styles.modalButtonDisabled]}
              >
                <Text style={[styles.modalButtonText, { color: themeColors.tint }]}>{t('common.save')}</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={sortModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setSortModalVisible(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setSortModalVisible(false)}>
          <View style={[styles.modalCard, { backgroundColor: themeColors.cardBg }]}>
            <Text style={[styles.modalTitle, { color: themeColors.text }]}>{t('sort.label')}</Text>
            <View style={styles.sortList}>
              {sortOptions.map((option) => (
                <Pressable
                  key={option}
                  onPress={() => {
                    updateSettings({ taskSortBy: option });
                    setSortModalVisible(false);
                  }}
                  style={[
                    styles.sortItem,
                    option === sortBy && { backgroundColor: themeColors.filterBg }
                  ]}
                >
                  <Text style={[styles.sortItemText, { color: themeColors.text }]}>
                    {t(`sort.${option}`)}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        </Pressable>
      </Modal>

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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 12,
    borderBottomWidth: 1,
    gap: 10,
  },
  headerTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: 22,
    fontWeight: '700',
  },
  count: {
    fontSize: 13,
    fontWeight: '500',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: 10,
  },
  headerAccessoryRow: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 6,
    alignItems: 'flex-end',
  },
  sortButton: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  sortButtonText: {
    fontSize: 12,
  },
  selectButton: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  selectButtonText: {
    fontSize: 12,
    fontWeight: '600',
  },
  bulkBar: {
    borderBottomWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  bulkCount: {
    fontSize: 12,
    fontWeight: '600',
  },
  bulkStatusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  bulkLoadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  bulkLoadingText: {
    fontSize: 11,
    fontWeight: '500',
  },
  bulkMoveRow: {
    gap: 6,
    paddingVertical: 2,
  },
  bulkMoveButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  bulkMoveText: {
    fontSize: 12,
    fontWeight: '500',
  },
  bulkActions: {
    flexDirection: 'row',
    gap: 8,
  },
  bulkActionButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  bulkActionText: {
    fontSize: 12,
    fontWeight: '600',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalCard: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 12,
    padding: 16,
    gap: 12,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
  },
  modalInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
  },
  modalButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  modalButtonDisabled: {
    opacity: 0.5,
  },
  modalButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  sortList: {
    gap: 6,
  },
  sortItem: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  sortItemText: {
    fontSize: 14,
  },
  inputContainer: {
    flexDirection: 'row',
    padding: 16,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e5e5',
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 16,
  },
  copilotPill: {
    marginTop: 8,
    marginHorizontal: 16,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  copilotText: {
    fontSize: 12,
    fontWeight: '600',
  },
  copilotHint: {
    fontSize: 11,
    marginTop: 2,
  },
  copilotLoadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  addButton: {
    width: 44,
    height: 44,
    backgroundColor: '#007AFF',
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  addButtonDisabled: {
    opacity: 0.5,
  },
  typeaheadContainer: {
    marginTop: 8,
    borderWidth: 1,
    borderRadius: 12,
    overflow: 'hidden',
  },
  typeaheadRow: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  typeaheadText: {
    fontSize: 13,
  },
  addButtonText: {
    color: '#fff',
    fontSize: 24,
    fontWeight: 'bold',
  },
  quickAddHelp: {
    fontSize: 12,
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
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
  },
  filterChipText: {
    fontSize: 12,
    fontWeight: '600',
  },
  list: {
    flex: 1,
  },
  staticList: {
    flex: 1,
  },
  staticItem: {
    marginBottom: 0,
  },
  listContent: {
    padding: 12,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 6,
    paddingTop: 10,
    paddingBottom: 6,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  sectionCount: {
    fontSize: 11,
    fontWeight: '600',
  },
  taskItem: {
    flexDirection: 'row',
    backgroundColor: '#f9f9f9',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    alignItems: 'center',
  },
  taskContent: {
    flex: 1,
  },
  taskTitle: {
    fontSize: 16,
    fontWeight: '500',
    marginBottom: 4,
  },
  taskDescription: {
    fontSize: 14,
    color: '#666',
    marginBottom: 4,
  },
  taskMeta: {
    fontSize: 12,
    color: '#666',
  },
  deleteButton: {
    display: 'none', // Hidden in favor of swipe
  },
  deleteAction: {
    backgroundColor: '#EF4444',
    justifyContent: 'center',
    alignItems: 'center',
    width: 80,
    height: '100%',
  },
  promoteAction: {
    backgroundColor: '#3B82F6',
    justifyContent: 'center',
    alignItems: 'center',
    width: 80,
    height: '100%',
  },
  actionText: {
    color: '#fff',
    fontWeight: '600',
    padding: 20,
  },
  badgeContainer: {
    justifyContent: 'center',
    paddingLeft: 8,
  },
  searchInput: {
    marginHorizontal: 16,
    marginVertical: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    fontSize: 16,
    backgroundColor: '#f9f9f9',
  },
});
