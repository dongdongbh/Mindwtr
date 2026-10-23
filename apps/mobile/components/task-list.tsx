import React, { useState, useMemo, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { View, FlatList, Text, RefreshControl, Modal, Pressable, Switch, TouchableOpacity, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useNavigation } from 'expo-router';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, GripVertical } from 'lucide-react-native';
import DraggableFlatList, { type DragEndParams, type RenderItemParams } from 'react-native-draggable-flatlist';
import {
  useTaskStore,
  Task,
  type Section,
  TaskStatus,
  sortTasksBy,
  getUsedTaskTokens,
  type TaskSortBy,
  type ProjectSequenceTaskCue,
  shallow,
  normalizeFocusTaskLimit,
  resolveFeatureFlags,
  tFallback,
  isTaskInActiveProject,
  isTaskVisibleInInbox,
  getTaskMetadataFilterVisibility,
  buildProjectTaskListModel,
  selectProjectTaskListTasks,
  taskMatchesAreaFilterSelection,
  DONE_TASK_LIST_SORT_OPTIONS,
  TASK_LIST_SORT_OPTIONS,
  getTaskSortByLabel,
  TIME_ESTIMATE_OPTIONS,
  buildStatusListFilterOptions,
  buildStatusListFilterSummary,
  buildStatusListModel,
  DONE_LIST_GROUP_OPTIONS,
  REFERENCE_ARCHIVED_CHIP_ID,
  selectStatusListTasks,
  TASK_LIST_GROUP_OPTIONS,
  getBulkMoveStatusOptions,
  getTaskListRemoveTagPickerText,
  type StatusListKind,
} from '@mindwtr/core';

import { TaskEditModal } from './task-edit-modal';
import { ErrorBoundary } from './ErrorBoundary';
import { CompactText } from './compact-text';
import { ListEmptyState } from './list-empty-state';
import {
  SwipeableTaskItem,
  readTaskRowRenderCount,
  type SwipeableTaskItemRowContext,
  type TaskRowActions,
} from './swipeable-task-item';
import { TASK_LIST_WINDOWING_PROPS, shouldRemoveClippedSubviews } from './task-list-windowing';
import { useTheme } from '../contexts/theme-context';
import { useLanguage } from '../contexts/language-context';

import { buildTaskGroupSections, getTaskGroupByLabel, type TaskGroupBy } from '@/lib/task-group-sections';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { useToast } from '@/contexts/toast-context';
import { PullSyncIndicator } from '@/components/PullSyncIndicator';
import { useManualPullSync } from '@/hooks/use-manual-pull-sync';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';
import { logError, logInfo } from '../lib/app-log';
import {
  beginMobilePerformanceDiagnostic,
  finishMobilePerformanceDiagnostic,
  logMobilePerformanceDiagnostic,
  resolveMobilePerformanceRoute,
} from '../lib/performance-diagnostics';
import {
  TaskListBulkBar,
  type TaskListBulkBarProps,
} from './task-list/TaskListBulkBar';
import {
  TaskListBulkOrganizeModal,
} from './task-list/TaskListBulkOrganizeModal';
import {
  TaskListHeader,
  type TaskListActiveFilterChip,
} from './task-list/TaskListHeader';
import {
  TaskListSortModal,
} from './task-list/TaskListSortModal';
import {
  TaskListTagModal,
} from './task-list/TaskListTagModal';
import { TokenPickerModal } from './token-picker-modal';
import { styles } from './task-list/task-list.styles';
import {
  buildProjectTaskReorderGroups,
  flattenProjectReorderGroups,
  resolveProjectReorderDropPlan,
  type ProjectReorderFlatItem,
  type ProjectTaskReorderGroup,
} from './task-list-utils';
import { TaskFilterSheet } from './task-filter-sheet';
import {
  taskMatchesFilterSelections,
  useTaskFilterSelections,
} from '@/hooks/use-task-filter-selections';
import { usePruneSelectionToVisible, useTaskListSelection } from './use-task-list-selection';
import { useLocalDayKey } from '@/hooks/use-local-day-key';
import { useAndroidActivitySession } from '@/hooks/use-android-activity-session';
import { resolveTaskListSortBy } from '@/lib/task-list-sort';
import { useCollapsedTaskGroups } from '@/lib/view-state/task-group-collapse-state';

const PROJECT_REORDER_ITEM_HEIGHT = 80;
const PROJECT_REORDER_ANIMATION_CONFIG = {
  damping: 28,
  mass: 0.15,
  overshootClamping: true,
  restDisplacementThreshold: 0.1,
  restSpeedThreshold: 0.1,
  stiffness: 240,
} as const;
const SLOW_TASK_LIST_DERIVE_MS = 250;
const SLOW_TASK_LIST_COMMIT_MS = 500;

type TaskListActivitySession = {
  editingTaskId: string | null;
  scrollOffset: number;
};

const isTaskListActivitySession = (value: unknown): value is TaskListActivitySession => {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<TaskListActivitySession>;
  return (snapshot.editingTaskId === null || typeof snapshot.editingTaskId === 'string')
    && typeof snapshot.scrollOffset === 'number'
    && Number.isFinite(snapshot.scrollOffset)
    && snapshot.scrollOffset >= 0;
};

const hashTaskListScope = (scope: string, seed: number): string => {
  let hash = seed >>> 0;
  for (let index = 0; index < scope.length; index += 1) {
    hash ^= scope.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36);
};

export function buildTaskListActivitySessionOwnerId(options: {
  explicitScope?: string;
  projectId?: string;
  statusFilter: TaskStatus | 'all';
  title: string;
}): string {
  const scope = options.explicitScope
    ?? `${options.statusFilter}\u0000${options.projectId ?? ''}\u0000${options.title}`;
  return `task-list:${hashTaskListScope(scope, 2166136261)}-${hashTaskListScope(scope, 2246822519)}`;
}

export type TaskListGroupBy = TaskGroupBy;

/**
 * The project workspace mode, in one prop. None of it means anything to the
 * three status screens, so it stays behind a single seam instead of widening
 * the interface they read — see ProjectTaskList, its only author.
 */
export interface TaskListProjectOptions {
  /** Scopes the list to one project; also switches on the project-only chrome. */
  id: string;
  sortBy?: TaskSortBy;
  includeArchived?: boolean;
  includeDone?: boolean;
  groupCompletedTasksLast?: boolean;
  getTaskSequenceCue?: (task: Task) => ProjectSequenceTaskCue | undefined;
  sequenceCueLabels?: Record<ProjectSequenceTaskCue, string>;
  enableBulkOrganize?: boolean;
  enableReorder?: boolean;
  /** Historical project workspace: rows remain viewable but expose no mutations. */
  readOnly?: boolean;
  reorderMode?: boolean;
  onReorderModeChange?: (active: boolean) => void;
}

const NO_PROJECT_OPTIONS: Partial<TaskListProjectOptions> = {};
const NO_TASKS: Task[] = [];
const NO_SECTIONS: Section[] = [];

/** What the list shows: which tasks, in what order, grouped how. */
interface TaskListContentProps {
  statusFilter: TaskStatus | 'all';
  title: string;
  /**
   * Render this pool instead of the store's own. The project workspace scopes
   * the list this way; the reference pile below still reads the full visible
   * pool, because a tag-matched reference can live in another project (#1000).
   */
  taskSource?: Task[];
  viewSortBy?: TaskSortBy;
  onChangeViewSortBy?: (value: TaskSortBy) => void;
  groupBy?: TaskListGroupBy;
  onChangeGroupBy?: (value: TaskListGroupBy) => void;
  project?: TaskListProjectOptions;
}

/** The scroll container itself: which render path, its padding, refs and scroll events. */
interface TaskListScrollProps {
  contentPaddingBottom?: number;
  /** Element rendered inside the virtualized list, scrolling away with the rows (e.g. the project sheet's details/notes header). */
  listHeaderComponent?: React.ReactElement | null;
  /** Ref to the underlying FlatList (virtualized path only). */
  listRef?: React.Ref<FlatList>;
  /** Scroll events from the virtualized list (virtualized path only). */
  onListScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
}

/** Everything drawn around the rows: header, empty state, filter and sort controls. */
interface TaskListChromeProps {
  /** Put the neutral overflow in the native navigation header instead of an inline row. */
  overflowPlacement?: 'inline' | 'navigation';
  showHeader?: boolean;
  showSort?: boolean;
  showFilterButton?: boolean;
  showTimeEstimateFilters?: boolean;
  onFilterStateChange?: (state: { activeCount: number; hasActive: boolean }) => void;
  externalFilterOpenSignal?: number;
  emptyText?: string;
  emptyHint?: string;
  emptyActionLabel?: string;
  onEmptyAction?: () => void;
  headerAccessory?: React.ReactNode;
  primaryActionRow?: React.ReactNode;
}

function TaskListNavigationOverflow({ headerRight }: { headerRight: () => React.ReactNode }) {
  const navigation = useNavigation();

  useLayoutEffect(() => {
    navigation.setOptions({ headerRight });
    return () => navigation.setOptions({ headerRight: undefined });
  }, [headerRight, navigation]);

  return null;
}

/** Which interactions this instance is allowed to offer at all. */
interface TaskListCapabilityProps {
  /** Stable semantic scope for Activity-remount recovery when a screen mounts peer lists with identical titles. */
  activitySessionScope?: string;
  defaultEditTab?: 'task' | 'view';
  enableBulkActions?: boolean;
  enableInboxBulkOrganize?: boolean;
  bulkBarPlacement?: 'inline' | 'external';
  onBulkBarPropsChange?: (props: TaskListBulkBarProps | null) => void;
}

// Flat on the wire on purpose: TaskList is React.memo'd and sits on the app's
// hottest render path (#766), so nesting these groups into object props would
// break memoisation on every parent render unless every call site memoised them
// by hand. `project` is the one exception, and it earns it: ProjectTaskList is
// its only author and memoises it there, once.
export interface TaskListProps
  extends TaskListContentProps, TaskListScrollProps, TaskListChromeProps, TaskListCapabilityProps {}

function TaskListComponent({
  statusFilter,
  title,
  taskSource,
  overflowPlacement = 'inline',
  showHeader = true,
  showTimeEstimateFilters: showTimeEstimateFiltersProp = true,
  enableBulkActions = true,
  enableInboxBulkOrganize = false,
  bulkBarPlacement = 'inline',
  onBulkBarPropsChange,
  showSort = true,
  emptyText,
  emptyHint,
  emptyActionLabel,
  onEmptyAction,
  headerAccessory,
  primaryActionRow,
  showFilterButton = true,
  onFilterStateChange,
  defaultEditTab,
  contentPaddingBottom,
  externalFilterOpenSignal = 0,
  viewSortBy,
  onChangeViewSortBy,
  groupBy,
  onChangeGroupBy,
  listHeaderComponent,
  listRef,
  onListScroll,
  project,
  activitySessionScope,
}: TaskListProps) {
  const {
    id: projectId,
    sortBy: projectSortBy,
    includeArchived = false,
    includeDone = true,
    groupCompletedTasksLast = false,
    getTaskSequenceCue,
    sequenceCueLabels,
    enableBulkOrganize: enableProjectBulkOrganize = false,
    enableReorder: enableProjectReorder = false,
    readOnly: projectReadOnly = false,
    reorderMode: projectReorderModeProp,
    onReorderModeChange: onProjectReorderModeChange,
  } = project ?? NO_PROJECT_OPTIONS;
  const taskListRenderStartedAt = Date.now();
  const rowRenderCountAtRenderStart = readTaskRowRenderCount();
  const { isDark } = useTheme();
  const { t } = useLanguage();
  const { showToast } = useToast();
  const { width: windowWidth } = useWindowDimensions();
  const {
    tasks,
    projects,
    allProjects,
    sections,
    allSections,
    areas,
    addTask,
    allVisibleTasks,
    updateTask,
    deleteTask,
    restoreTask,
    batchMoveTasks,
    batchDeleteTasks,
    batchUpdateTasks,
    reorderProjectTasks,
    reorderSections,
    settings,
    updateSettings,
    highlightTaskId,
    setHighlightTask,
    getFocusedCount,
  } = useTaskStore((state) => ({
    tasks: taskSource ?? (includeArchived ? state._allTasks : state.tasks),
    // References tag-matched to the project can live in other projects, so the
    // reference pile reads the full visible pool even when taskSource narrows
    // the main list to one project's tasks (#1000).
    allVisibleTasks: state.tasks,
    projects: state.projects,
    allProjects: state._allProjects ?? state.projects,
    sections: state.sections,
    allSections: state._allSections,
    areas: state.areas,
    addTask: state.addTask,
    updateTask: state.updateTask,
    deleteTask: state.deleteTask,
    restoreTask: state.restoreTask,
    batchMoveTasks: state.batchMoveTasks,
    batchDeleteTasks: state.batchDeleteTasks,
    batchUpdateTasks: state.batchUpdateTasks,
    reorderProjectTasks: state.reorderProjectTasks,
    reorderSections: state.reorderSections,
    settings: state.settings,
    updateSettings: state.updateSettings,
    highlightTaskId: state.highlightTaskId,
    setHighlightTask: state.setHighlightTask,
    getFocusedCount: state.getFocusedCount,
  }), shallow);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [sortModalVisible, setSortModalVisible] = useState(false);
  const [referenceGroupModalVisible, setReferenceGroupModalVisible] = useState(false);
  const [filtersVisible, setFiltersVisible] = useState(false);
  const [bulkOrganizeVisible, setBulkOrganizeVisible] = useState(false);
  const [internalProjectReorderMode, setInternalProjectReorderMode] = useState(false);
  const [completedTasksCollapsed, setCompletedTasksCollapsed] = useState(true);
  const [includeArchivedReferenceProjects, setIncludeArchivedReferenceProjects] = useState(false);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reduceMotion = useReducedMotion();
  // Tracks the highlightTaskId we already scrolled to, so an id is centred once
  // (when it first appears in the rendered data) rather than re-scrolling on
  // every unrelated list re-render during its ~3.5s highlight window (#916).
  const scrolledHighlightIdRef = useRef<string | null>(null);
  const pullSync = useManualPullSync();

  // Dynamic colors based on theme
  const themeColors = useThemeColors();

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
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const allProjectById = useMemo(() => new Map(allProjects.map((project) => [project.id, project])), [allProjects]);
  const isTaskReadOnly = useCallback((task: Task) => {
    if (projectReadOnly) return true;
    if (!task.projectId) return false;
    const owningProject = allProjectById.get(task.projectId);
    return Boolean(owningProject?.deletedAt || owningProject?.status === 'archived');
  }, [allProjectById, projectReadOnly]);
  const canSelectTaskId = useCallback((taskId: string) => {
    const task = tasksById[taskId];
    return task ? !isTaskReadOnly(task) : true;
  }, [isTaskReadOnly, tasksById]);
  const {
    bulkActionLabel,
    bulkActionLoading,
    exitSelectionMode,
    handleBatchAddTag,
    handleBatchDelete,
    handleBatchOrganize,
    handleBatchMove,
    handleBatchRemoveTags,
    hasSelection,
    multiSelectedIds,
    rangeSelectMode,
    removableTagOptions,
    removeTagPickerVisible,
    selectedIdsArray,
    selectionMode,
    setMultiSelectedIds,
    setRemoveTagPickerVisible,
    setTagInput,
    setTagModalVisible,
    tagInput,
    tagModalVisible,
    toggleRangeSelectMode,
    toggleMultiSelect,
  } = useTaskListSelection({
    batchDeleteTasks,
    batchMoveTasks,
    batchUpdateTasks,
    restoreTask,
    t,
    tasksById,
    canSelectTaskId,
  });

  const sortBy = resolveTaskListSortBy({
    globalSortBy: settings?.taskSortBy,
    projectSortBy,
    settings,
    statusFilter,
    viewSortBy,
  });
  const activeGroupBy: TaskListGroupBy = groupBy ?? 'none';
  // Folds are per list and per axis. Project views group by section instead, so
  // they share nothing with these and keep their own Completed toggle below.
  const { collapsedGroupIds, toggleGroup } = useCollapsedTaskGroups(statusFilter, activeGroupBy);
  const localDayKey = useLocalDayKey(activeGroupBy === 'completedDate');
  const handleChangeGroupBy = onChangeGroupBy;
  const effectiveBulkActions = enableBulkActions && !projectReadOnly;
  const canUseProjectReorder = Boolean(!projectReadOnly && enableProjectReorder && projectId && sortBy === 'default');
  const shouldGroupCompletedTasks = Boolean(groupCompletedTasksLast && projectId && statusFilter === 'all');
  const projectReorderMode = projectReorderModeProp ?? internalProjectReorderMode;
  const focusTaskLimit = normalizeFocusTaskLimit(settings?.gtd?.focusTaskLimit);
  const focusedCount = getFocusedCount();
  const resolvedFeatureFlags = resolveFeatureFlags(settings);
  const prioritiesEnabled = resolvedFeatureFlags.priorities;
  const timeEstimatesEnabled = resolvedFeatureFlags.timeEstimates;
  const timeSpentEnabled = resolvedFeatureFlags.pomodoro
    && settings?.gtd?.pomodoro?.linkTask === true;
  const showTaskAge = settings?.appearance?.showTaskAge === true;
  const showStatusBadge = !settings?.gtd?.taskEditor?.hidden?.includes('status');
  const sectionById = useMemo(() => new Map(sections.map((section) => [section.id, section])), [sections]);
  const rowContext = useMemo<SwipeableTaskItemRowContext>(() => ({
    addTask,
    updateTask,
    restoreTask,
    projects,
    sectionById,
    areas,
    focusedCount,
    focusTaskLimit,
    prioritiesEnabled,
    timeEstimatesEnabled,
    timeSpentEnabled,
    showTaskAge,
    showStatusBadge,
  }), [
    addTask,
    areas,
    focusedCount,
    focusTaskLimit,
    prioritiesEnabled,
    projects,
    sectionById,
    restoreTask,
    showTaskAge,
    showStatusBadge,
    timeEstimatesEnabled,
    timeSpentEnabled,
    updateTask,
  ]);
  const timeEstimateFiltersEnabled = showTimeEstimateFiltersProp && timeEstimatesEnabled && statusFilter !== 'inbox';
  const canBulkOrganizeInbox = enableInboxBulkOrganize && statusFilter === 'inbox';
  const canBulkOrganizeProject = enableProjectBulkOrganize && Boolean(projectId);
  const canBulkOrganizeSelection = canBulkOrganizeInbox || canBulkOrganizeProject;
  const { areaById, resolvedAreaFilter } = useMobileAreaFilter();

  // Track the last-seen signal so a remount (e.g. toggling reorder mode swaps the
  // scroll container component type) doesn't re-open the sheet from a stale value.
  const lastFilterOpenSignalRef = useRef(externalFilterOpenSignal);
  useEffect(() => {
    if (externalFilterOpenSignal === lastFilterOpenSignalRef.current) return;
    lastFilterOpenSignalRef.current = externalFilterOpenSignal;
    if (externalFilterOpenSignal <= 0) return;
    setFiltersVisible(true);
  }, [externalFilterOpenSignal]);

  const lastProjectIdRef = useRef(projectId);
  const setProjectReorderMode = useCallback((active: boolean) => {
    if (projectReorderModeProp === undefined) {
      setInternalProjectReorderMode(active);
    }
    onProjectReorderModeChange?.(active);
  }, [onProjectReorderModeChange, projectReorderModeProp]);

  useEffect(() => {
    if (lastProjectIdRef.current === projectId) return;
    lastProjectIdRef.current = projectId;
    setProjectReorderMode(false);
  }, [projectId, setProjectReorderMode]);

  useEffect(() => {
    setCompletedTasksCollapsed(true);
  }, [groupCompletedTasksLast, projectId]);

  useEffect(() => {
    if (!canUseProjectReorder && projectReorderMode) {
      setProjectReorderMode(false);
    }
  }, [canUseProjectReorder, projectReorderMode, setProjectReorderMode]);

  useEffect(() => {
    if (projectReorderMode && selectionMode) {
      exitSelectionMode();
    }
  }, [exitSelectionMode, projectReorderMode, selectionMode]);

  useEffect(() => {
    if (!projectReadOnly) return;
    if (selectionMode) exitSelectionMode();
    if (projectReorderMode) setProjectReorderMode(false);
  }, [exitSelectionMode, projectReadOnly, projectReorderMode, selectionMode, setProjectReorderMode]);

  const taskListDeriveStartedAt = Date.now();
  // Inbox, Reference and Done are core's status-list model, shared with the native host.
  const statusListKind: StatusListKind | null = !projectId && (statusFilter === 'inbox' || statusFilter === 'reference' || statusFilter === 'done')
    ? statusFilter
    : null;
  const filterableTasks = useMemo(() => {
    if (statusListKind) {
      return selectStatusListTasks({
        kind: statusListKind,
        tasks,
        projects,
        allProjects,
        resolvedAreaFilter,
        areaById,
        includeArchivedProjects: includeArchivedReferenceProjects,
      });
    }
    const isVisibleInArea = (task: Task) => (statusFilter === 'inbox'
      ? isTaskVisibleInInbox(task, { projectById })
      : taskMatchesAreaFilterSelection(task, resolvedAreaFilter, projectById, areaById));
    if (projectId) {
      return selectProjectTaskListTasks(tasks, {
        projectId,
        statusFilter,
        includeArchived,
        includeDone,
        isVisible: isVisibleInArea,
      });
    }
    return tasks.filter((task) => {
      if (task.deletedAt) return false;
      if (statusFilter === 'all' && task.status === 'reference') return false;
      if (statusFilter === 'all' && !includeDone && task.status === 'done') return false;
      const matchesStatus = statusFilter === 'all' ? true : task.status === statusFilter;
      if (!isTaskInActiveProject(task, projectById)) return false;
      return isVisibleInArea(task) && matchesStatus;
    });
  }, [allProjects, areaById, includeArchived, includeArchivedReferenceProjects, includeDone, projectById, projectId, projects, resolvedAreaFilter, statusFilter, statusListKind, tasks]);
  // Scanning every visible task for its tokens only pays off once the sheet is
  // open; until then the selected ones are all the chips anyone can see.
  const statusListFilterOptions = useMemo(() => (statusListKind
    ? buildStatusListFilterOptions({
      kind: statusListKind,
      tasks: filterableTasks,
      allProjects,
      settings,
      t,
      timeEstimateFilters: showTimeEstimateFiltersProp,
      withTokens: filtersVisible,
    })
    : null), [allProjects, filterableTasks, filtersVisible, settings, showTimeEstimateFiltersProp, statusListKind, t]);
  const referenceProjectFilterOptions = statusListFilterOptions?.projects ?? undefined;
  const metadataFilterVisibility = useMemo(() => statusListFilterOptions?.visibility
    ?? getTaskMetadataFilterVisibility(filterableTasks, {
      prioritiesEnabled,
      timeEstimatesEnabled: timeEstimateFiltersEnabled,
    }), [filterableTasks, prioritiesEnabled, statusListFilterOptions, timeEstimateFiltersEnabled]);
  const resetReferenceFilters = useCallback(() => setIncludeArchivedReferenceProjects(false), []);
  const selections = useTaskFilterSelections({
    view: 'list',
    t,
    visibility: metadataFilterVisibility,
    retainProjects: statusListFilterOptions?.retainProjects,
    getProjectLabel: statusListFilterOptions?.getProjectLabel,
    onClear: resetReferenceFilters,
  });
  const { criteria: filterCriteria, searchQuery: filterSearchQuery } = selections;
  const tokenFilterOptions = useMemo(() => {
    if (!filtersVisible) return Array.from(new Set([...selections.tokens, ...selections.excludedTokens]));
    return statusListFilterOptions?.tokens
      ?? getUsedTaskTokens(filterableTasks, (task) => [...(task.contexts ?? []), ...(task.tags ?? [])], { includeAncestors: true });
  }, [filterableTasks, filtersVisible, selections.tokens, selections.excludedTokens, statusListFilterOptions]);
  const archivedReferenceFilterActive = statusFilter === 'reference' && includeArchivedReferenceProjects;
  // Inbox, Reference and Done: the header's chips and counts and the empty state, as core summarizes them.
  const filterSummary = useMemo(() => (statusListKind
    ? buildStatusListFilterSummary({
      kind: statusListKind,
      chips: selections.chips.map(({ id, label, excluded }) => ({ id, label, excluded: excluded === true })),
      activeCount: selections.activeCount,
      hasActive: selections.hasActive,
      includeArchivedProjects: archivedReferenceFilterActive,
      settings,
      t,
    })
    : null), [archivedReferenceFilterActive, selections.activeCount, selections.chips, selections.hasActive, settings, statusListKind, t]);
  const hasActiveTaskFilters = selections.hasActive;
  const totalFilterActiveCount = filterSummary?.activeCount ?? selections.activeCount;
  const hasAnyActiveFilters = filterSummary?.hasActive ?? hasActiveTaskFilters;
  useEffect(() => {
    onFilterStateChange?.({ activeCount: totalFilterActiveCount, hasActive: hasAnyActiveFilters });
  }, [hasAnyActiveFilters, onFilterStateChange, totalFilterActiveCount]);
  const activeFilterChips = useMemo<TaskListActiveFilterChip[]>(
    () => (filterSummary
      ? filterSummary.chips.map((chip) => (chip.id === REFERENCE_ARCHIVED_CHIP_ID
        ? { id: chip.id, label: chip.label, onPress: () => setIncludeArchivedReferenceProjects(false) }
        : selections.chips.find((candidate) => candidate.id === chip.id)!))
      : selections.chips),
    [filterSummary, selections.chips],
  );
  const clearAllFilters = selections.clear;
  const filteredEmptyMessage = filterSummary?.empty.message ?? (hasActiveTaskFilters
    ? tFallback(t, 'filters.noMatch', 'No tasks match these filters.')
    : emptyMessage);
  const filteredEmptyHint = filterSummary?.empty.hint ?? (hasActiveTaskFilters
    ? activeFilterChips.slice(0, 3).map((chip) => chip.label).join(', ')
    : emptyHint);
  const filteredEmptyActionLabel = (filterSummary ? filterSummary.empty.actionLabel : hasActiveTaskFilters
    ? tFallback(t, 'filters.clear', 'Clear')
    : null) ?? emptyActionLabel;
  const filteredEmptyAction = hasActiveTaskFilters ? clearAllFilters : onEmptyAction;

  // A project's list (which tasks, their order, its sections, and the Completed
  // and Reference piles) is one core model, shared with the native host.
  const projectTaskList = useMemo(() => {
    if (!projectId) return null;
    return buildProjectTaskListModel({
      project: {
        id: projectId,
        status: projectReadOnly ? 'archived' : 'active',
        tagIds: projectById.get(projectId)?.tagIds,
        isSequential: projectById.get(projectId)?.isSequential,
        perSectionFlow: projectById.get(projectId)?.perSectionFlow,
      },
      tasks: filterableTasks,
      visibleTasks: allVisibleTasks,
      sections,
      allSections,
      statusFilter,
      criteria: filterCriteria,
      searchQuery: filterSearchQuery,
      sortBy,
      projectOrder: enableProjectReorder,
      reorderMode: projectReorderMode,
      groupCompletedTasksLast,
      completedCollapsed: completedTasksCollapsed,
      t,
    });
  }, [
    allSections,
    allVisibleTasks,
    completedTasksCollapsed,
    enableProjectReorder,
    filterCriteria,
    filterSearchQuery,
    filterableTasks,
    groupCompletedTasksLast,
    projectById,
    projectId,
    projectReadOnly,
    projectReorderMode,
    sections,
    sortBy,
    statusFilter,
    t,
  ]);

  const statusListModel = useMemo(() => {
    if (!statusListKind) return null;
    // localDayKey is not read here; it is in the dependency list so crossing
    // midnight re-buckets the completedDate axis.
    void localDayKey;
    return buildStatusListModel({
      kind: statusListKind,
      tasks: filterableTasks,
      projects,
      areas,
      settings,
      groupBy: activeGroupBy,
      viewSortBy,
      criteria: filterCriteria,
      searchQuery: filterSearchQuery,
      collapsedGroupIds,
      t,
    });
  }, [activeGroupBy, areas, collapsedGroupIds, filterCriteria, filterSearchQuery, filterableTasks, localDayKey, projects, settings, statusListKind, t, viewSortBy]);

  const filteredTasks = useMemo(() => {
    if (projectId || statusListKind) return NO_TASKS;
    const filterSelections = { criteria: filterCriteria, searchQuery: filterSearchQuery };
    return filterableTasks.filter((task) => taskMatchesFilterSelections(task, filterSelections));
  }, [filterCriteria, filterSearchQuery, filterableTasks, projectId, statusListKind]);

  const orderedTasks = useMemo(() => {
    if (projectTaskList) return projectTaskList.orderedTasks;
    if (statusListModel) return statusListModel.orderedTasks;
    return sortTasksBy(filteredTasks, sortBy);
  }, [filteredTasks, projectTaskList, sortBy, statusListModel]);
  // #784 next-round evidence: the visible order at Task-order enter/exit. An
  // exit digest that differs from what the list later shows — with no Drop
  // line between — proves the order changed after the write, and the id:order
  // pairs name the field. Only logs on mode transitions.
  const previousReorderModeRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (!projectId) return;
    if (previousReorderModeRef.current === projectReorderMode) return;
    const isFirstObservation = previousReorderModeRef.current === null;
    previousReorderModeRef.current = projectReorderMode;
    if (isFirstObservation && !projectReorderMode) return;
    const digest = orderedTasks
      .slice(0, 200)
      .map((task) => `${task.id.slice(0, 8)}:${String(task.order ?? task.orderNum ?? '-')}`)
      .join(' ');
    void logInfo(`[Reorder] Task order mode ${projectReorderMode ? 'entered' : 'exited'}`, {
      scope: 'project',
      extra: { projectId, taskCount: String(orderedTasks.length), digest },
    });
  }, [orderedTasks, projectId, projectReorderMode]);

  const projectSections = projectTaskList?.sections ?? NO_SECTIONS;

  type ListItem =
    | { type: 'section'; id: string; title: string; count: number; muted?: boolean; collapsible?: boolean; collapsed?: boolean; synthetic?: 'none' | 'completed' | 'reference'; flowLabel?: string }
    | { type: 'task'; task: Task; reorderSectionId?: string | null; groupId?: string };

  const listItems = useMemo<ListItem[]>(() => {
    if (projectTaskList) return projectTaskList.items;
    if (statusListModel) {
      return statusListModel.items.map((item): ListItem => (item.type === 'section'
        ? item
        : { type: 'task', task: item.task, ...(item.groupId ? { groupId: item.groupId } : { reorderSectionId: item.task.sectionId }) }));
    }
    if (activeGroupBy !== 'none') {
      // localDayKey is not read here; it is in the dependency list so crossing
      // midnight re-buckets the completedDate axis.
      void localDayKey;
      return buildTaskGroupSections({
        groupBy: activeGroupBy,
        tasks: orderedTasks,
        areas,
        projectById,
        t,
        collapsedGroupIds,
      });
    }
    return orderedTasks.map((task): ListItem => ({ type: 'task', task, reorderSectionId: task.sectionId }));
  }, [activeGroupBy, areas, collapsedGroupIds, localDayKey, orderedTasks, projectById, projectTaskList, statusListModel, t]);
  // Android can leave filtered rows detached when clipping flips off after a
  // long list shrinks. Keep clipping on until this list unmounts (#1272).
  const clipListSubviewsRef = useRef(false);
  clipListSubviewsRef.current ||= shouldRemoveClippedSubviews(listItems.length);
  const loggedRetainedClippingRef = useRef(false);
  useEffect(() => {
    if (!clipListSubviewsRef.current || shouldRemoveClippedSubviews(listItems.length) || loggedRetainedClippingRef.current) return;
    loggedRetainedClippingRef.current = true;
    void logInfo('Android task list clipping retained after filtering', {
      scope: 'list',
      extra: { releaseCheck: 'v1.3.3/android-task-list-filter-render', count: String(listItems.length) },
    });
  }, [listItems.length]);
  const orderedTaskIds = useMemo(
    () => Array.from(new Set(listItems.flatMap((item) => (item.type === 'task' ? [item.task.id] : [])))),
    [listItems],
  );
  const selectableOrderedTaskIds = useMemo(
    () => orderedTaskIds.filter(canSelectTaskId),
    [canSelectTaskId, orderedTaskIds],
  );
  usePruneSelectionToVisible(setMultiSelectedIds, selectableOrderedTaskIds);
  const performanceRoute = useMemo(
    () => resolveMobilePerformanceRoute({ projectId, statusFilter }),
    [projectId, statusFilter],
  );
  const listItemCountForDiagnostics = orderedTaskIds.length;
  const taskListDeriveMs = Date.now() - taskListDeriveStartedAt;
  useLayoutEffect(() => {
    if (settings?.diagnostics?.loggingEnabled !== true) return;
    const taskListCommitMs = Date.now() - taskListRenderStartedAt;
    if (taskListDeriveMs >= SLOW_TASK_LIST_DERIVE_MS) {
      void logMobilePerformanceDiagnostic({
        operation: 'task_list_derive',
        route: performanceRoute,
        elapsedMs: taskListDeriveMs,
        listItemCount: listItemCountForDiagnostics,
        filterCount: totalFilterActiveCount,
      });
    }
    if (taskListCommitMs >= SLOW_TASK_LIST_COMMIT_MS) {
      void logMobilePerformanceDiagnostic({
        operation: 'task_list_commit',
        route: performanceRoute,
        elapsedMs: taskListCommitMs,
        listItemCount: listItemCountForDiagnostics,
        filterCount: totalFilterActiveCount,
        rowRenderCount: readTaskRowRenderCount() - rowRenderCountAtRenderStart,
      });
    }
  }, [
    listItemCountForDiagnostics,
    performanceRoute,
    rowRenderCountAtRenderStart,
    settings?.diagnostics?.loggingEnabled,
    taskListDeriveMs,
    taskListRenderStartedAt,
    totalFilterActiveCount,
  ]);
  const getListItemKey = useCallback((item: ListItem) => (
    item.type === 'section' ? `section-${item.id}` : (item.groupId ? `${item.groupId}:${item.task.id}` : item.task.id)
  ), []);
  // The row key never folds in the list index: a moved row must keep its
  // identity so its mounted state moves with it.
  // No getItemLayout here on purpose: rows have variable heights, and frames
  // built from estimates shift every offset when a real measurement lands,
  // visibly nudging the list as a scroll settles (#831). Native measurement
  // keeps the scroll position anchored and also removes the estimate-vs-row
  // disagreement behind the 2026-07-06 mid-list gap report.

  const projectReorderGroups = useMemo<ProjectTaskReorderGroup<Task>[]>(() => {
    if (!canUseProjectReorder) return [];
    const reorderItems = shouldGroupCompletedTasks
      ? listItems.filter((item) => (item.type === 'section' ? item.synthetic !== 'completed' : item.task.status !== 'done'))
      : listItems;
    return buildProjectTaskReorderGroups<Task>(reorderItems, { includeEmptySections: projectSections.length > 0 });
  }, [canUseProjectReorder, listItems, projectSections.length, shouldGroupCompletedTasks]);
  const projectSectionIds = useMemo(() => projectSections.map((section) => section.id), [projectSections]);
  const hasProjectReorderItems = projectReorderGroups.some((group) => group.tasks.length > 0) || projectSections.length > 1;
  const projectReorderFlatItems = useMemo(
    () => flattenProjectReorderGroups(projectReorderGroups),
    [projectReorderGroups],
  );
  const projectReorderHasHeaders = useMemo(
    () => projectReorderFlatItems.some((item) => item.type === 'header'),
    [projectReorderFlatItems],
  );
  // Grouping by completion only says anything in a list of finished work, so
  // Done gets the extra axis rather than every list growing it (#945).
  const groupByOptions: readonly TaskListGroupBy[] = statusFilter === 'done'
    ? DONE_LIST_GROUP_OPTIONS
    : TASK_LIST_GROUP_OPTIONS;
  const getGroupByLabel = useCallback((groupBy: TaskListGroupBy) => getTaskGroupByLabel(groupBy, t), [t]);
  const groupByLabel = getGroupByLabel(activeGroupBy);
  const groupLabel = tFallback(t, 'list.groupBy', 'Group');
  const showGroupControl = !projectId && Boolean(handleChangeGroupBy);
  // Keep the draggable pan handler on the handle strip so vertical scrolling still works.
  // DraggableFlatList gesture props: https://github.com/computerjazz/react-native-draggable-flatlist#props
  const projectDragHitSlop = useMemo(() => ({
    bottom: 0,
    left: -Math.max(windowWidth - 96, 0),
    right: 0,
    top: 0,
  }), [windowWidth]);

  const handleToggleProjectReorderMode = useCallback(() => {
    if (!canUseProjectReorder) return;
    exitSelectionMode();
    setProjectReorderMode(!projectReorderMode);
  }, [canUseProjectReorder, exitSelectionMode, projectReorderMode, setProjectReorderMode]);

  // Entering Task order mounts a fresh DraggableFlatList at the top; start it on
  // the task the user was looking at instead (#765). The first visible task is
  // tracked via native viewability (no manual frames — see #831), and the entry
  // scroll retries briefly because a freshly mounted list clamps the jump until
  // enough rows render.
  const firstViewableTaskIdRef = useRef<string | null>(null);
  const reorderListRef = useRef<FlatList<ProjectReorderFlatItem<Task>> | null>(null);
  // The normal FlatList's ref is owned by the parent (listRef prop); keep an
  // internal handle too so this component can scroll a freshly added row into
  // view without stealing the parent's ref.
  const internalListRef = useRef<FlatList<ListItem> | null>(null);
  const taskListScrollOffsetRef = useRef(0);
  const pendingActivityScrollOffsetRef = useRef<number | null>(null);
  const setListRef = useCallback((node: FlatList<ListItem> | null) => {
    internalListRef.current = node;
    if (node && pendingActivityScrollOffsetRef.current !== null) {
      node.scrollToOffset({ offset: pendingActivityScrollOffsetRef.current, animated: false });
      pendingActivityScrollOffsetRef.current = null;
    }
    if (typeof listRef === 'function') {
      listRef(node);
    } else if (listRef) {
      (listRef as React.MutableRefObject<FlatList | null>).current = node;
    }
  }, [listRef]);
  const projectReorderFlatItemsRef = useRef(projectReorderFlatItems);
  projectReorderFlatItemsRef.current = projectReorderFlatItems;
  const lastDroppedProjectReorderItemsRef = useRef<ProjectReorderFlatItem<Task>[] | null>(null);
  const projectReorderScrollOffsetRef = useRef(0);
  const taskListActivitySessionOwnerId = useMemo(() => buildTaskListActivitySessionOwnerId({
    explicitScope: activitySessionScope,
    projectId,
    statusFilter,
    title,
  }), [activitySessionScope, projectId, statusFilter, title]);
  const restoreTaskListActivitySession = useCallback((snapshot: TaskListActivitySession) => {
    if (snapshot.editingTaskId) {
      const restoredTask = tasksById[snapshot.editingTaskId];
      if (restoredTask && !restoredTask.deletedAt) {
        setEditingTask(restoredTask);
        setIsModalVisible(true);
      }
    }
    taskListScrollOffsetRef.current = snapshot.scrollOffset;
    if (internalListRef.current) {
      internalListRef.current.scrollToOffset({ offset: snapshot.scrollOffset, animated: false });
    } else {
      pendingActivityScrollOffsetRef.current = snapshot.scrollOffset;
    }
  }, [tasksById]);
  const { clear: clearTaskListActivitySession } = useAndroidActivitySession({
    getValue: () => ({
      editingTaskId: isModalVisible ? editingTask?.id ?? null : null,
      scrollOffset: projectReorderMode
        ? projectReorderScrollOffsetRef.current
        : taskListScrollOffsetRef.current,
    }),
    onRestore: restoreTaskListActivitySession,
    ownerId: taskListActivitySessionOwnerId,
    validate: isTaskListActivitySession,
  });
  const listViewabilityConfig = useRef({ itemVisiblePercentThreshold: 10 }).current;
  const handleListViewableItemsChanged = useRef((info: { viewableItems: { item?: unknown }[] }) => {
    const firstTask = info.viewableItems.find((entry) => {
      const item = entry.item as ListItem | undefined;
      return item?.type === 'task';
    });
    firstViewableTaskIdRef.current = firstTask
      ? (firstTask.item as Extract<ListItem, { type: 'task' }>).task.id
      : null;
  }).current;
  const handleProjectReorderScrollOffsetChange = useCallback((offset: number) => {
    projectReorderScrollOffsetRef.current = offset;
  }, []);
  const handleTaskListScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    taskListScrollOffsetRef.current = Math.max(0, event.nativeEvent.contentOffset.y);
    onListScroll?.(event);
  }, [onListScroll]);
  const handleReorderScrollToIndexFailed = useCallback((info: { index: number; averageItemLength: number }) => {
    const estimate = (info.averageItemLength || PROJECT_REORDER_ITEM_HEIGHT) * info.index;
    reorderListRef.current?.scrollToOffset({ offset: estimate, animated: false });
    setTimeout(() => {
      try {
        reorderListRef.current?.scrollToIndex({ index: info.index, animated: false, viewPosition: 0 });
      } catch {
        // List changed under the retry; the estimated offset stands.
      }
    }, 120);
  }, []);
  const prevProjectReorderModeRef = useRef(projectReorderMode);
  useEffect(() => {
    const wasReordering = prevProjectReorderModeRef.current;
    prevProjectReorderModeRef.current = projectReorderMode;
    if (wasReordering || !projectReorderMode || !canUseProjectReorder) return undefined;
    const taskId = firstViewableTaskIdRef.current;
    if (!taskId) return undefined;
    const index = projectReorderFlatItemsRef.current.findIndex(
      (item) => item.type === 'task' && item.task.id === taskId,
    );
    if (index <= 0) return undefined;
    projectReorderScrollOffsetRef.current = 0;
    // How long entering Task order leaves the viewport parked on unrendered
    // rows: the entry jump only sticks once the target has rendered, so the
    // settle time IS the blank window slow devices report (#784).
    const enteredAt = Date.now();
    let entryLogged = false;
    const logEntrySettled = (retriesUsed: number) => {
      if (entryLogged) return;
      entryLogged = true;
      if (useTaskStore.getState().settings?.diagnostics?.loggingEnabled !== true) return;
      void logMobilePerformanceDiagnostic({
        operation: 'project_reorder_enter',
        route: 'project',
        elapsedMs: Date.now() - enteredAt,
        listItemCount: projectReorderFlatItemsRef.current.length,
        scrollRetryCount: retriesUsed,
      });
    };
    const scrollToTarget = () => {
      try {
        reorderListRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0 });
      } catch {
        // Out-of-render index without getItemLayout — the failed handler covers it.
      }
    };
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const retry = () => {
      timer = null;
      // Stop once the list actually moved off the top (a clamped first jump
      // keeps it at 0) or the retries run out.
      if (projectReorderScrollOffsetRef.current > 1) {
        logEntrySettled(attempts);
        return;
      }
      scrollToTarget();
      attempts += 1;
      if (attempts < 5) {
        timer = setTimeout(retry, 250);
      } else {
        logEntrySettled(attempts);
      }
    };
    const frame = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(scrollToTarget)
      : null;
    timer = setTimeout(retry, 250);
    return () => {
      if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      if (timer !== null) clearTimeout(timer);
    };
  }, [canUseProjectReorder, projectReorderMode]);

  // Exiting Task order returns the normal list to the region the REORDER view
  // was showing, not the pre-reorder offset — after dragging a task to the
  // top, restoring the old offset yanked the viewport away from where the
  // task just landed, which read as the reorder not sticking (#784). Anchor
  // on the first task in the reorder viewport (fixed-height rows make that a
  // plain division) and scroll the remounted normal list to it; offset ~0
  // needs nothing, since the list mounts at the top.
  const prevProjectReorderExitRef = useRef(projectReorderMode);
  useEffect(() => {
    const wasReordering = prevProjectReorderExitRef.current;
    prevProjectReorderExitRef.current = projectReorderMode;
    if (!wasReordering || projectReorderMode) return;
    const offset = projectReorderScrollOffsetRef.current;
    projectReorderScrollOffsetRef.current = 0;
    const droppedReorderItems = lastDroppedProjectReorderItemsRef.current;
    lastDroppedProjectReorderItemsRef.current = null;
    if (offset <= 1) return;
    const reorderItems = droppedReorderItems ?? projectReorderFlatItemsRef.current;
    if (reorderItems.length === 0) return;
    const approxIndex = Math.min(
      reorderItems.length - 1,
      Math.max(0, Math.round(offset / PROJECT_REORDER_ITEM_HEIGHT)),
    );
    let anchorTaskId: string | null = null;
    for (let i = approxIndex; i < reorderItems.length; i += 1) {
      const item = reorderItems[i];
      if (item.type === 'task') {
        anchorTaskId = item.task.id;
        break;
      }
    }
    if (!anchorTaskId) return;
    const index = listItems.findIndex(
      (item) => item.type === 'task' && item.task.id === anchorTaskId,
    );
    if (index < 0) return;
    // In-bounds index: an unmeasured row reports through onScrollToIndexFailed,
    // which runs the estimate-then-retry path below.
    internalListRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0 });
  }, [listItems, projectReorderMode]);

  // FlatList row heights vary, so a scrollToIndex to an unmeasured row reports
  // failure via this callback; estimate the offset, jump there, then retry the
  // exact index once rows near the target have mounted (mirrors the
  // reorder-mode fallback). The retry runs 120ms later against a list that may
  // have shrunk or reordered meanwhile, and scrollToIndex throws an invariant
  // for an out-of-bounds index — swallow that instead of crashing; the row is
  // already near the estimated offset.
  const handleListScrollToIndexFailed = useCallback(
    (info: { index: number; averageItemLength: number }) => {
      const list = internalListRef.current;
      if (!list) return;
      const estimate = (info.averageItemLength || 88) * info.index;
      list.scrollToOffset({ offset: estimate, animated: false });
      setTimeout(() => {
        try {
          internalListRef.current?.scrollToIndex({ index: info.index, animated: false, viewPosition: 0.5 });
        } catch {
          // List changed under the retry; the estimated offset stands.
        }
      }, 120);
    },
    [],
  );

  // Scroll a highlighted task into view once it is actually present in the
  // rendered row model. Driven by the shared highlightTaskId, so a task captured
  // through the quick-capture sheet flashes and scrolls here without stacking
  // scrolls: each id centres once (see
  // scrolledHighlightIdRef). Normal mode only — reorder swaps in a different
  // list. A task filtered out of this view never enters listItems, so nothing
  // scrolls (#916).
  useEffect(() => {
    if (!highlightTaskId) {
      scrolledHighlightIdRef.current = null;
      return;
    }
    if (projectReorderMode) return;
    if (scrolledHighlightIdRef.current === highlightTaskId) return;
    const index = listItems.findIndex(
      (item) => item.type === 'task' && item.task.id === highlightTaskId,
    );
    if (index < 0) return;
    scrolledHighlightIdRef.current = highlightTaskId;
    const list = internalListRef.current;
    if (!list) return;
    // An unmeasured target row does not throw here — VirtualizedList reports it
    // through the onScrollToIndexFailed prop, which runs the estimate-then-retry
    // path. The index is in bounds (found in listItems above), so no try/catch.
    list.scrollToIndex({ index, viewPosition: 0.5, animated: !reduceMotion });
  }, [highlightTaskId, listItems, projectReorderMode, reduceMotion]);

  const handleProjectTaskDragEnd = useCallback((params: DragEndParams<ProjectReorderFlatItem<Task>>) => {
    if (!projectId) return;
    if (params.from === params.to) return;
    const moved = params.data[params.to];
    if (!moved || moved.type !== 'task') return;
    const plan = resolveProjectReorderDropPlan(params.data, moved.task.id);
    if (!plan) return;
    // DraggableFlatList already renders this order, but the persisted store
    // update below is asynchronous. Preserve the list the user can currently
    // see so exiting Task order before the store rerenders anchors to the
    // post-drop viewport instead of stale props (#784).
    lastDroppedProjectReorderItemsRef.current = params.data;
    // #784 next-round evidence: what the drop asked for, so a later mismatch
    // separates "wrong write" from "write lost afterwards".
    const movedAt = plan.orderedIds.indexOf(moved.task.id);
    void logInfo('[Reorder] Drop', {
      scope: 'project',
      extra: {
        taskId: moved.task.id,
        from: String(params.from),
        to: String(params.to),
        sectionId: plan.sectionId ?? '',
        prevId: plan.orderedIds[movedAt - 1] ?? '',
        nextId: plan.orderedIds[movedAt + 1] ?? '',
      },
    });
    const reportFailure = (error: unknown) => {
      void logError(error, { scope: 'project', extra: { message: 'Failed to reorder project tasks' } });
      showToast({
        title: t('common.notice'),
        message: tFallback(t, 'projects.taskReorderFailed', 'Failed to reorder tasks.'),
        tone: 'error',
      });
    };
    const sourceSectionId = moved.task.sectionId ?? null;
    if (sourceSectionId === plan.sectionId) {
      void Promise.resolve(reorderProjectTasks(projectId, plan.orderedIds, plan.sectionId, moved.task.id)).catch(reportFailure);
      return;
    }
    // Crossing a header re-homes the task into the section it was dropped in.
    void (async () => {
      await Promise.resolve(updateTask(moved.task.id, {
        sectionId: plan.sectionId ?? undefined,
      }));
      await Promise.resolve(reorderProjectTasks(projectId, plan.orderedIds, plan.sectionId, moved.task.id));
    })().catch(reportFailure);
  }, [projectId, reorderProjectTasks, showToast, t, updateTask]);

  const handleProjectSectionMove = useCallback((sectionId: string, offset: -1 | 1) => {
    if (!projectId) return;
    const currentIndex = projectSectionIds.indexOf(sectionId);
    const nextIndex = currentIndex + offset;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= projectSectionIds.length) return;
    const nextIds = [...projectSectionIds];
    const [moved] = nextIds.splice(currentIndex, 1);
    if (!moved) return;
    nextIds.splice(nextIndex, 0, moved);
    void Promise.resolve(reorderSections(projectId, nextIds)).catch((error) => {
      void logError(error, { scope: 'project', extra: { message: 'Failed to reorder project sections' } });
      showToast({
        title: t('common.notice'),
        message: tFallback(t, 'projects.sectionReorderFailed', 'Failed to reorder sections.'),
        tone: 'error',
      });
    });
  }, [projectId, projectSectionIds, reorderSections, showToast, t]);

  const bulkMoveStatusOptions = useMemo(
    () => getBulkMoveStatusOptions(statusFilter),
    [statusFilter],
  );
  const removeTagPickerText = useMemo(() => getTaskListRemoveTagPickerText(t), [t]);

  const bulkBarProps = useMemo<TaskListBulkBarProps | null>(() => {
    if (!effectiveBulkActions || !selectionMode || projectReorderMode) return null;
    return {
      bulkActionLabel,
      bulkActionLoading,
      handleBatchDelete,
      handleBatchMove,
      hasSelection,
      onExitSelectionMode: exitSelectionMode,
      onOpenOrganize: canBulkOrganizeSelection ? () => setBulkOrganizeVisible(true) : undefined,
      onOpenTagModal: () => setTagModalVisible(true),
      onOpenRemoveTagPicker: () => setRemoveTagPickerVisible(true),
      canRemoveTags: removableTagOptions.length > 0,
      onToggleRangeSelectMode: toggleRangeSelectMode,
      rangeSelectMode,
      selectedCount: selectedIdsArray.length,
      statusOptions: bulkMoveStatusOptions,
      t,
      themeColors: themeColors,
    };
  }, [
    bulkActionLabel,
    bulkActionLoading,
    bulkMoveStatusOptions,
    canBulkOrganizeSelection,
    effectiveBulkActions,
    exitSelectionMode,
    handleBatchDelete,
    handleBatchMove,
    hasSelection,
    projectReorderMode,
    rangeSelectMode,
    removableTagOptions.length,
    selectedIdsArray.length,
    selectionMode,
    setRemoveTagPickerVisible,
    setTagModalVisible,
    t,
    themeColors,
    toggleRangeSelectMode,
  ]);

  useEffect(() => {
    onBulkBarPropsChange?.(bulkBarProps);
  }, [bulkBarProps, onBulkBarPropsChange]);

  useEffect(() => () => {
    onBulkBarPropsChange?.(null);
  }, [onBulkBarPropsChange]);

  const shouldRenderInlineBulkBar = Boolean(
    bulkBarProps && (bulkBarPlacement !== 'external' || !onBulkBarPropsChange),
  );

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

  const handleEditTask = useCallback((task: Task) => {
    setEditingTask(task);
    setIsModalVisible(true);
  }, []);

  const onSaveTask = useCallback((taskId: string, updates: Partial<Task>) => {
    if (projectReadOnly) return { success: false };
    const state = useTaskStore.getState();
    const liveTask = state._allTasks?.find((task) => task.id === taskId);
    const owningProjectId = liveTask?.projectId ?? projectId;
    if (owningProjectId) {
      const liveProject = state._allProjects?.find((project) => project.id === owningProjectId);
      if (!liveProject || liveProject.deletedAt || liveProject.status === 'archived') return { success: false };
    }
    const diagnostic = beginMobilePerformanceDiagnostic({
      operation: 'task_save_to_list',
      route: performanceRoute,
      listItemCount: listItemCountForDiagnostics,
    });
    const result = state.updateTask(taskId, updates);
    clearTaskListActivitySession();
    setIsModalVisible(false);
    setEditingTask(null);
    void Promise.resolve(result).finally(() => {
      void finishMobilePerformanceDiagnostic(diagnostic, {
        visibleItemCount: listItemCountForDiagnostics,
      });
    });
    // The editor closes above, so the save result has to reach `reportSaveResult`
    // or a `{ success: false }` write reads as saved.
    return result;
  }, [clearTaskListActivitySession, listItemCountForDiagnostics, performanceRoute, projectId, projectReadOnly]);

  const handleCloseTaskEdit = useCallback(() => {
    clearTaskListActivitySession();
    setIsModalVisible(false);
    setEditingTask(null);
  }, [clearTaskListActivitySession]);
  const editingTaskReadOnly = useMemo(
    () => Boolean(editingTask && isTaskReadOnly(editingTask)),
    [editingTask, isTaskReadOnly],
  );

  const sortOptions = statusFilter === 'done'
    ? DONE_TASK_LIST_SORT_OPTIONS
    : TASK_LIST_SORT_OPTIONS;
  // Single-status lists (inbox/next/waiting/someday/done/reference) repeat the same status on every
  // row, so show a compact icon button to change status instead of the redundant status-name badge.
  // The 'all' list keeps the labeled badge because its rows have mixed statuses.
  const statusBadgeAsIconForList = statusFilter !== 'all';
  const hideChecklistProgressForList = statusFilter === 'inbox';
  const handleTaskStatusChange = useCallback((taskId: string, status: TaskStatus) => {
    const diagnostic = beginMobilePerformanceDiagnostic({
      operation: status === 'done' ? 'task_done_to_list' : 'task_mutation',
      route: performanceRoute,
      listItemCount: listItemCountForDiagnostics,
    });
    const result = updateTask(taskId, { status });
    void Promise.resolve(result).finally(() => {
      void finishMobilePerformanceDiagnostic(diagnostic, {
        visibleItemCount: listItemCountForDiagnostics,
      });
    });
    return result;
  }, [listItemCountForDiagnostics, performanceRoute, updateTask]);

  // The row handlers are rebuilt on every render because they close over the
  // current list (selectableOrderedTaskIds above all), so rows reach them through
  // one object that never changes identity and reads the latest closures from a
  // ref (#766). A row that captured old ids would break range select.
  const rowActionSourcesRef = useRef({
    deleteTask,
    handleEditTask,
    handleTaskStatusChange,
    orderedTaskIds: selectableOrderedTaskIds,
    toggleMultiSelect,
  });
  rowActionSourcesRef.current = {
    deleteTask,
    handleEditTask,
    handleTaskStatusChange,
    orderedTaskIds: selectableOrderedTaskIds,
    toggleMultiSelect,
  };
  const rowActions = useMemo<TaskRowActions>(() => ({
    edit: (task) => rowActionSourcesRef.current.handleEditTask(task),
    changeStatus: (task, status) => {
      if (isTaskReadOnly(task)) return undefined;
      return rowActionSourcesRef.current.handleTaskStatusChange(task.id, status);
    },
    remove: (task) => {
      if (isTaskReadOnly(task)) return undefined;
      return rowActionSourcesRef.current.deleteTask(task.id);
    },
    toggleSelect: effectiveBulkActions
      ? (task) => {
        if (isTaskReadOnly(task)) return;
        const sources = rowActionSourcesRef.current;
        sources.toggleMultiSelect(task.id, { visibleTaskIds: sources.orderedTaskIds });
      }
      : undefined,
  }), [effectiveBulkActions, isTaskReadOnly]);

  const renderTask = useCallback(({ item }: { item: Task }) => {
    const sequenceCue = getTaskSequenceCue?.(item);
    const itemReadOnly = isTaskReadOnly(item);

    return (
      <ErrorBoundary>
        <SwipeableTaskItem
          actions={rowActions}
          hideDetails
          hideChecklistProgress={hideChecklistProgressForList}
          hideProjectMeta={Boolean(projectId)}
          isDark={isDark}
          isHighlighted={item.id === highlightTaskId}
          interactionDisabled={itemReadOnly}
          allowInspectionWhenDisabled={itemReadOnly}
          isMultiSelected={!itemReadOnly && effectiveBulkActions && multiSelectedIds.has(item.id)}
          onProjectPress={projectId ? undefined : openProjectScreen}
          onContextPress={openContextsScreen}
          onTagPress={openContextsScreen}
          rowContext={rowContext}
          selectionMode={!itemReadOnly && effectiveBulkActions ? selectionMode : false}
          sequenceCue={sequenceCue}
          sequenceLabel={sequenceCue ? sequenceCueLabels?.[sequenceCue] : undefined}
          statusBadgeAsIcon={statusBadgeAsIconForList}
          task={item}
          tc={themeColors}
        />
      </ErrorBoundary>
    );
  }, [
    effectiveBulkActions,
    getTaskSequenceCue,
    highlightTaskId,
    isDark,
    multiSelectedIds,
    rowActions,
    selectionMode,
    hideChecklistProgressForList,
    statusBadgeAsIconForList,
    themeColors,
    projectId,
    sequenceCueLabels,
    rowContext,
    isTaskReadOnly,
  ]);

  const getProjectReorderItemLayout = useCallback((_: ArrayLike<ProjectReorderFlatItem<Task>> | null | undefined, index: number) => ({
    index,
    length: PROJECT_REORDER_ITEM_HEIGHT,
    offset: PROJECT_REORDER_ITEM_HEIGHT * index,
  }), []);

  const renderProjectReorderTaskRow = useCallback((task: Task, drag: () => void, isActive: boolean) => {
    const statusLabel = t(`status.${task.status}`);

    return (
      <View
        style={[
          styles.projectDragTaskRow,
          { height: PROJECT_REORDER_ITEM_HEIGHT },
          isActive && styles.projectDragTaskRowActive,
        ]}
        testID={`project-task-reorder-row-${task.id}`}
      >
        <View
          style={[
            styles.projectReorderTaskCard,
            { backgroundColor: themeColors.taskItemBg, borderColor: themeColors.border },
          ]}
        >
          <Text
            numberOfLines={2}
            style={[styles.projectReorderTaskTitle, { color: themeColors.text }]}
          >
            {task.title}
          </Text>
          <CompactText
            numberOfLines={1}
            style={[styles.projectReorderTaskMeta, { color: themeColors.secondaryText }]}
          >
            {statusLabel}
          </CompactText>
        </View>
        <TouchableOpacity
          accessibilityLabel={`${tFallback(t, 'board.dragTask', 'Drag task')}: ${task.title}`}
          accessibilityRole="button"
          activeOpacity={0.85}
          disabled={isActive}
          onPressIn={drag}
          style={[
            styles.projectDragHandle,
            { backgroundColor: themeColors.filterBg, borderColor: themeColors.border },
          ]}
          testID={`project-task-drag-handle-${task.id}`}
        >
          <GripVertical size={20} color={themeColors.secondaryText} />
        </TouchableOpacity>
      </View>
    );
  }, [
    t,
    themeColors.border,
    themeColors.filterBg,
    themeColors.secondaryText,
    themeColors.taskItemBg,
    themeColors.text,
  ]);

  const toggleSection = useCallback((section: Extract<ListItem, { type: 'section' }>) => {
    // The project Completed pile is a fixed part of that screen with its own
    // single boolean; every other collapsible header is a grouping heading.
    if (section.synthetic === 'completed') {
      setCompletedTasksCollapsed((value) => !value);
      return;
    }
    toggleGroup(section.id);
  }, [toggleGroup]);

  const renderListItem = useCallback(({ item }: { item: ListItem }) => {
    if (item.type === 'section') {
      if (item.collapsible) {
        return (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityState={{ expanded: item.collapsed !== true }}
            onPress={() => toggleSection(item)}
            style={styles.sectionHeader}
          >
            <View style={styles.sectionHeaderTitleBlock}>
              {item.collapsed ? (
                <ChevronRight size={15} color={themeColors.secondaryText} />
              ) : (
                <ChevronDown size={15} color={themeColors.secondaryText} />
              )}
              <Text style={[styles.sectionTitle, { color: item.muted ? themeColors.secondaryText : themeColors.text }]}>
                {item.title}
              </Text>
            </View>
            <Text style={[styles.sectionCount, { color: themeColors.secondaryText }]}>
              {item.count}
            </Text>
          </TouchableOpacity>
        );
      }

      const title = (
        <Text style={[styles.sectionTitle, { color: item.muted ? themeColors.secondaryText : themeColors.text }]}>
          {item.title}
        </Text>
      );
      return (
        <View style={styles.sectionHeader}>
          {item.flowLabel ? (
            <View style={styles.sectionHeaderTitleBlock}>
              {title}
              <Text testID={`project-section-flow-label-${item.id}`} style={[styles.sectionCount, { color: themeColors.secondaryText }]}>
                {item.flowLabel}
              </Text>
            </View>
          ) : title}
          <Text style={[styles.sectionCount, { color: themeColors.secondaryText }]}>
            {item.count}
          </Text>
        </View>
      );
    }
    return renderTask({ item: item.task });
  }, [renderTask, themeColors.secondaryText, themeColors.text, toggleSection]);

  const renderProjectReorderHeader = useCallback((group: ProjectTaskReorderGroup<Task>) => {
    const sectionIndex = typeof group.sectionId === 'string' ? projectSectionIds.indexOf(group.sectionId) : -1;
    const canReorderSection = sectionIndex >= 0 && projectSectionIds.length > 1;
    const canMoveSectionUp = canReorderSection && sectionIndex > 0;
    const canMoveSectionDown = canReorderSection && sectionIndex < projectSectionIds.length - 1;
    const moveSectionUpLabel = tFallback(t, 'projects.moveSectionUp', 'Move section up');
    const moveSectionDownLabel = tFallback(t, 'projects.moveSectionDown', 'Move section down');

    return (
      <View style={styles.sectionHeader}>
        <View style={styles.sectionHeaderTitleBlock}>
          <Text style={[styles.sectionTitle, { color: group.muted ? themeColors.secondaryText : themeColors.text }]} numberOfLines={1}>
            {group.title}
          </Text>
          <Text style={[styles.sectionCount, { color: themeColors.secondaryText }]}>
            {group.tasks.length}
          </Text>
        </View>
        {canReorderSection && typeof group.sectionId === 'string' ? (
          <View style={styles.sectionReorderControls}>
            <TouchableOpacity
              accessibilityLabel={`${moveSectionUpLabel}: ${group.title}`}
              accessibilityRole="button"
              disabled={!canMoveSectionUp}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              onPress={() => handleProjectSectionMove(group.sectionId as string, -1)}
              style={[
                styles.sectionReorderButton,
                { borderColor: themeColors.border, backgroundColor: themeColors.filterBg },
                !canMoveSectionUp && styles.sectionReorderButtonDisabled,
              ]}
            >
              <ArrowUp size={16} color={themeColors.secondaryText} />
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityLabel={`${moveSectionDownLabel}: ${group.title}`}
              accessibilityRole="button"
              disabled={!canMoveSectionDown}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              onPress={() => handleProjectSectionMove(group.sectionId as string, 1)}
              style={[
                styles.sectionReorderButton,
                { borderColor: themeColors.border, backgroundColor: themeColors.filterBg },
                !canMoveSectionDown && styles.sectionReorderButtonDisabled,
              ]}
            >
              <ArrowDown size={16} color={themeColors.secondaryText} />
            </TouchableOpacity>
          </View>
        ) : null}
      </View>
    );
  }, [
    handleProjectSectionMove,
    projectSectionIds,
    t,
    themeColors.border,
    themeColors.filterBg,
    themeColors.secondaryText,
    themeColors.text,
  ]);

  const renderProjectReorderItem = useCallback(({ drag, isActive, item }: RenderItemParams<ProjectReorderFlatItem<Task>>) => {
    if (item.type === 'header') {
      return renderProjectReorderHeader(item.group);
    }
    return renderProjectReorderTaskRow(item.task, drag, isActive);
  }, [renderProjectReorderHeader, renderProjectReorderTaskRow]);

  const renderNavigationOverflow = useCallback(() => (
    <TaskListHeader
      activeFilterChips={activeFilterChips}
      count={orderedTasks.length}
      filterActiveCount={totalFilterActiveCount}
      groupByLabel={showGroupControl ? groupByLabel : undefined}
      hasActiveFilters={hasAnyActiveFilters}
      onClearFilters={clearAllFilters}
      onOpenFilters={() => setFiltersVisible(true)}
      onOpenGroup={showGroupControl ? () => setReferenceGroupModalVisible(true) : undefined}
      onOpenSort={() => setSortModalVisible(true)}
      renderOverflowOnly
      showHeader={false}
      showFilterButton={showFilterButton}
      showSort={showSort}
      sortByLabel={getTaskSortByLabel(sortBy, t)}
      t={t}
      themeColors={themeColors}
      title={title}
    />
  ), [
    activeFilterChips,
    clearAllFilters,
    groupByLabel,
    hasAnyActiveFilters,
    orderedTasks.length,
    showFilterButton,
    showGroupControl,
    showSort,
    sortBy,
    t,
    themeColors,
    title,
    totalFilterActiveCount,
  ]);

  return (
    <View style={[styles.container, { backgroundColor: themeColors.bg }]}>
      {overflowPlacement === 'navigation' ? (
        <TaskListNavigationOverflow headerRight={renderNavigationOverflow} />
      ) : null}
      <TaskListHeader
        activeFilterChips={activeFilterChips}
        count={orderedTasks.length}
        directControls={statusFilter === 'inbox' && overflowPlacement === 'inline'}
        filterActiveCount={totalFilterActiveCount}
        groupByLabel={showGroupControl ? groupByLabel : undefined}
        hasActiveFilters={hasAnyActiveFilters}
        headerAccessory={headerAccessory}
        onClearFilters={clearAllFilters}
        onOpenFilters={() => setFiltersVisible(true)}
        onOpenGroup={showGroupControl ? () => setReferenceGroupModalVisible(true) : undefined}
        onOpenSort={() => setSortModalVisible(true)}
        showHeader={showHeader}
        showFilterButton={showFilterButton}
        showOverflow={overflowPlacement !== 'navigation'}
        showSort={showSort}
        sortByLabel={getTaskSortByLabel(sortBy, t)}
        t={t}
        themeColors={themeColors}
        title={title}
      />

      {primaryActionRow}

      <TaskFilterSheet
        visible={filtersVisible}
        onClose={() => setFiltersVisible(false)}
        selections={selections}
        options={{
          tokens: tokenFilterOptions,
          projects: referenceProjectFilterOptions,
          timeEstimates: TIME_ESTIMATE_OPTIONS,
          visibility: metadataFilterVisibility,
        }}
        hasAdditionalActiveFilters={archivedReferenceFilterActive}
        themeColors={themeColors}
        t={t}
        topContent={statusFilter === 'reference' ? (
          <View style={styles.referenceArchiveToggleRow}>
            <Text style={[styles.referenceArchiveToggleLabel, { color: themeColors.text }]}>
              {t('reference.includeArchivedProjects')}
            </Text>
            <Switch
              accessibilityLabel={t('reference.includeArchivedProjects')}
              accessibilityRole="switch"
              accessibilityState={{ checked: includeArchivedReferenceProjects }}
              onValueChange={setIncludeArchivedReferenceProjects}
              trackColor={{ false: themeColors.border, true: themeColors.tint }}
              value={includeArchivedReferenceProjects}
            />
          </View>
        ) : undefined}
      />

      {shouldRenderInlineBulkBar && bulkBarProps ? (
        <TaskListBulkBar {...bulkBarProps} />
      ) : null}

      {canUseProjectReorder && hasProjectReorderItems && projectReorderMode && (
        <View style={[styles.projectReorderModeBar, { backgroundColor: themeColors.cardBg, borderBottomColor: themeColors.border }]}>
          <Text style={[styles.projectReorderTitle, { color: themeColors.text }]}>
            {projectSections.length > 1
              ? tFallback(t, 'projects.projectOrder', 'Project order')
              : tFallback(t, 'projects.taskOrder', 'Task order')}
          </Text>
          <TouchableOpacity
            accessibilityLabel={projectReorderMode
              ? t('common.done')
              : tFallback(t, 'projects.reorderTasks', 'Order tasks')}
            accessibilityRole="button"
            onPress={handleToggleProjectReorderMode}
            style={[
              styles.projectReorderModeButton,
              {
                backgroundColor: themeColors.tint,
                borderColor: themeColors.tint,
              },
            ]}
            testID="project-task-reorder-toggle"
          >
            <Text style={[
              styles.projectReorderModeButtonText,
              { color: themeColors.onTint },
            ]}>
              {t('common.done')}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {projectReorderMode && canUseProjectReorder ? (
        // One flat self-scrolling list for sectioned and section-less projects alike:
        // section headers are fixed rows, so dragging a task past a header drops it
        // into that section (per-section nested lists could never move tasks across
        // sections, and the nested variant also disabled windowing — #784).
        <DraggableFlatList
          // DraggableFlatList forwards its ref to the inner FlatList but types
          // it as the gesture-handler wrapper; the runtime instance is the RN
          // FlatList the scroll calls need.
          ref={reorderListRef as never}
          data={projectReorderFlatItems}
          keyExtractor={(item) => item.key}
          getItemLayout={projectReorderHasHeaders ? undefined : getProjectReorderItemLayout}
          renderItem={renderProjectReorderItem}
          onDragEnd={handleProjectTaskDragEnd}
          onScrollOffsetChange={handleProjectReorderScrollOffsetChange}
          onScrollToIndexFailed={handleReorderScrollToIndexFailed}
          activationDistance={2}
          animationConfig={PROJECT_REORDER_ANIMATION_CONFIG}
          autoscrollThreshold={80}
          autoscrollSpeed={120}
          dragItemOverflow
          dragHitSlop={projectDragHitSlop}
          keyboardShouldPersistTaps="handled"
          initialNumToRender={14}
          maxToRenderPerBatch={12}
          windowSize={7}
          removeClippedSubviews={false}
          // DraggableFlatList's outer container takes containerStyle; `style`
          // lands on the inner FlatList. Without flex on the container it
          // auto-sizes to the inner list's flex basis of 0, rendering an
          // empty screen in reorder mode (#784).
          containerStyle={styles.projectDragSelfScrollList}
          style={styles.projectDragSelfScrollList}
          contentContainerStyle={styles.projectDragSelfScrollContent}
        />
      ) : (
        <FlatList
          ref={setListRef}
          data={listItems}
          renderItem={renderListItem}
          keyExtractor={getListItemKey}
          ListHeaderComponent={listHeaderComponent ?? undefined}
          viewabilityConfig={listViewabilityConfig}
          onViewableItemsChanged={handleListViewableItemsChanged}
          onScrollToIndexFailed={handleListScrollToIndexFailed}
          onScroll={handleTaskListScroll}
          scrollEventThrottle={onListScroll ? 16 : 100}
          style={styles.list}
          contentContainerStyle={listContentStyle}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          {...TASK_LIST_WINDOWING_PROPS}
          // Android enables clipping once the list grows large; the ref keeps
          // it enabled when filtering shrinks the list again.
          removeClippedSubviews={clipListSubviewsRef.current}
          // iOS only bounces (and thus allows pull-to-refresh) when content
          // exceeds the viewport unless bounce is forced; short lists like a
          // freshly processed Inbox must still be able to pull to sync.
          alwaysBounceVertical
          refreshControl={
            <RefreshControl
              refreshing={pullSync.refreshing}
              onRefresh={pullSync.onRefresh}
              tintColor="transparent"
              colors={['transparent']}
              progressBackgroundColor="transparent"
            />
          }
          ListEmptyComponent={
            <ListEmptyState
              message={filteredEmptyMessage}
              hint={filteredEmptyHint}
              backgroundColor={themeColors.cardBg}
              borderColor={themeColors.border}
              textColor={themeColors.text}
              mutedTextColor={themeColors.secondaryText}
              actionLabel={filteredEmptyActionLabel}
              onAction={filteredEmptyAction}
            />
          }
        />
      )}

      <PullSyncIndicator state={pullSync.indicatorState} />

      <TaskListTagModal
        onChangeTag={setTagInput}
        onClose={() => {
          setTagModalVisible(false);
          setTagInput('');
        }}
        onSave={handleBatchAddTag}
        t={t}
        tagInput={tagInput}
        themeColors={themeColors}
        visible={tagModalVisible}
      />

      <TokenPickerModal
        visible={removeTagPickerVisible}
        title={removeTagPickerText.title}
        description={removeTagPickerText.description}
        tokens={removableTagOptions}
        placeholder={removeTagPickerText.placeholder}
        multiSelect
        onClose={() => setRemoveTagPickerVisible(false)}
        onConfirm={(values) => {
          void handleBatchRemoveTags(values);
        }}
      />

      <TaskListBulkOrganizeModal
        areas={areas}
        isApplying={bulkActionLoading}
        onApply={async (input) => {
          await handleBatchOrganize(input);
          setBulkOrganizeVisible(false);
        }}
        onClose={() => setBulkOrganizeVisible(false)}
        projects={projects}
        selectedCount={selectedIdsArray.length}
        t={t}
        themeColors={themeColors}
        visible={bulkOrganizeVisible}
      />

      <TaskListSortModal
        onClose={() => setSortModalVisible(false)}
        onSelect={(option) => {
          if (statusFilter === 'done' && onChangeViewSortBy) {
            onChangeViewSortBy(option);
          } else {
            void updateSettings({ taskSortBy: option });
          }
          setSortModalVisible(false);
        }}
        sortBy={sortBy}
        sortOptions={sortOptions}
        t={t}
        themeColors={themeColors}
        visible={sortModalVisible}
      />

      {showGroupControl && (
        <Modal
          visible={referenceGroupModalVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setReferenceGroupModalVisible(false)}
        >
          <Pressable style={styles.modalOverlay} onPress={() => setReferenceGroupModalVisible(false)}>
            <View style={[styles.modalCard, { backgroundColor: themeColors.cardBg }]}>
              <Text style={[styles.modalTitle, { color: themeColors.text }]}>{groupLabel}</Text>
              <View style={styles.sortList}>
                {groupByOptions.map((option) => (
                  <Pressable
                    key={option}
                    onPress={() => {
                      handleChangeGroupBy?.(option);
                      setReferenceGroupModalVisible(false);
                    }}
                    style={[
                      styles.sortItem,
                      option === activeGroupBy && { backgroundColor: themeColors.filterBg },
                    ]}
                  >
                    <Text style={[styles.sortItemText, { color: themeColors.text }]}>
                      {getGroupByLabel(option)}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          </Pressable>
        </Modal>
      )}

      <ErrorBoundary>
        <TaskEditModal
          visible={isModalVisible}
          task={editingTask}
          readOnly={editingTaskReadOnly}
          onClose={handleCloseTaskEdit}
          onSave={onSaveTask}
          automaticDefaultTab={defaultEditTab}
          onProjectNavigate={projectId ? undefined : openProjectScreen}
          onContextNavigate={openContextsScreen}
          onTagNavigate={openContextsScreen}
        />
      </ErrorBoundary>
    </View>
  );
}

export const TaskList = React.memo(TaskListComponent);
