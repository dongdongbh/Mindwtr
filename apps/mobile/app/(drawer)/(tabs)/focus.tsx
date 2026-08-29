import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  View,
  Text,
  SectionList,
  StyleSheet,
  Pressable,
  ScrollView,
  Modal,
  TouchableOpacity,
  TextInput,
  Alert,
  LayoutAnimation,
  Platform,
  RefreshControl,
  UIManager,
} from 'react-native';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams } from 'expo-router';
import { BookmarkPlus, Folder, GripVertical, List, SlidersHorizontal, X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DraggableFlatList, {
  ScaleDecorator,
  type DragEndParams,
  type RenderItemParams,
} from 'react-native-draggable-flatlist';

import {
  applyFilter,
  getUpcomingDeferredTasks,
  buildAdvancedFilterCriteriaChips,
  buildFocusTaskGroups,
  getProjectDeadlineBoostLabel,
  removeAdvancedFilterCriteriaChip,
  sortFocusNextActions,
  shouldShowTaskForStart,
  getFocusSequentialFirstTaskIds,
  generateUUID,
  getProjectDeadlineBoosts,
  markSavedFilterDeleted,
  getFocusStarBlockedText,
  normalizeFocusTaskLimit,
  resolveFeatureFlags,
  sortTasksBySavedPreference,
  sortTasksByFocusOrder,
  translateWithFallback,
  useTaskStore,
  getAdvancedReviewDate,
  isTaskActionable,
  isDueForReview,
  safeFormatDate,
  safeParseDate,
  safeParseDueDate,
  getTaskMetadataFilterVisibility,
  hasTimeComponent,
  shallow,
  type Project,
  type Task,
  type FocusGroupBy,
  type SavedFilter,
  type SortField,
  type ProjectDeadlineBoost,
} from '@mindwtr/core';
import { SwipeableTaskItem, type TaskRowActions } from '@/components/swipeable-task-item';
import { settleStoreAction } from '@/components/store-action-result';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useFilledButtonColors } from '@/hooks/use-filled-button-colors';
import { useAndroidKeyboardInset } from '@/lib/use-android-keyboard-inset';
import { CompactText } from '@/components/compact-text';
import { useTheme } from '../../../contexts/theme-context';
import { useLanguage } from '../../../contexts/language-context';
import { useToast } from '../../../contexts/toast-context';
import { addHardwareBackPressListener } from '@/lib/hardware-back';
import { TaskEditModal } from '@/components/task-edit-modal';
import type { TaskEditTab } from '@/components/task-edit/use-task-edit-state';
import { useFutureStartRevealTick, useLocalDayKey } from '@/hooks/use-local-day-key';
import { PomodoroPanel } from '@/components/pomodoro-panel';
import {
  getFocusTokenOptions,
  NO_PROJECT_FILTER_ID,
  splitFocusedTasks,
} from '@/lib/focus-screen-utils';
import { FilterChip, TaskFilterSheet } from '@/components/task-filter-sheet';
import { resolveTimeEstimateFilterOptions } from '@/components/time-estimate-filter-utils';
import { useTaskFilterSelections } from '@/hooks/use-task-filter-selections';
import { useVisibleTaskContext } from '@/hooks/use-visible-tasks';
import { PullSyncIndicator } from '@/components/PullSyncIndicator';
import { useManualPullSync } from '@/hooks/use-manual-pull-sync';
import { projectMatchesAreaFilterSelection } from '@mindwtr/core';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';
import {
  buildFocusListLayoutFrames,
  focusItemLayoutKey,
  focusSectionHeaderLayoutKey,
  reconcileFocusListMeasuredHeights,
  FOCUS_ESTIMATED_TASK_HEIGHT,
  FOCUS_LIST_HEADER_LAYOUT_KEY,
} from '@/components/focus/focus-list-layout';

const FOCUS_GROUP_BY_OPTIONS: FocusGroupBy[] = ['none', 'context', 'project', 'area', 'energy', 'priority', 'person', 'tag'];
const FOCUS_SORT_OPTIONS: SortField[] = ['default', 'due', 'start', 'priority', 'created', 'created-desc'];
const DEFAULT_FOCUS_SORT_BY: SortField = 'default';

function resolveTaskRouteTab(value?: string | string[]): TaskEditTab {
  const routeValue = Array.isArray(value) ? value[0] : value;
  return routeValue === 'task' ? 'task' : 'view';
}

const FOCUS_VIEW_STATE_STORAGE_KEY = 'mindwtr:view:focus:v1';
const FOCUS_REORDER_ITEM_HEIGHT = 80;
const FOCUS_LIST_INITIAL_RENDER_COUNT = 12;
const FOCUS_LIST_BATCH_RENDER_COUNT = 12;
const FOCUS_LIST_WINDOW_SIZE = 5;
const FOCUS_LIST_BOTTOM_CLEARANCE = 150;
const DEFAULT_EXPANDED_SECTIONS = {
  focus: true,
  schedule: true,
  next: true,
  upcoming: true,
  reviewDue: true,
  reviewProjects: true,
};

const isFabricEnabled = Boolean((globalThis as { nativeFabricUIManager?: unknown }).nativeFabricUIManager);

if (Platform.OS === 'android' && !isFabricEnabled && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

function animateFocusReorderLayout() {
  const preset = LayoutAnimation?.Presets?.easeInEaseOut;
  if (preset) LayoutAnimation.configureNext(preset);
}

type FocusExpandedSections = typeof DEFAULT_EXPANDED_SECTIONS;

type FocusFilterChip = {
  id: string;
  label: string;
  onPress?: () => void;
  variant?: 'advanced' | 'excluded';
};

type FocusSectionType = 'focus' | 'schedule' | 'next' | 'upcoming' | 'reviewDue' | 'reviewProjects';

type FocusListItem =
  | { type: 'task'; task: Task; grouped?: boolean }
  | { type: 'project'; project: Project }
  | { type: 'groupHeader'; id: string; title: string; count: number; muted?: boolean; dotColor?: string };

type FocusSection = {
  title: string;
  data: FocusListItem[];
  totalCount: number;
  expanded: boolean;
  type: FocusSectionType;
};

const getStartDateOffset = (days: number): Date => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(0, 0, 0, 0);
  return date;
};

const formatDateOnly = (date: Date): string => safeFormatDate(date, 'yyyy-MM-dd');

function normalizeFocusGroupBy(value: unknown): FocusGroupBy {
  return FOCUS_GROUP_BY_OPTIONS.includes(value as FocusGroupBy) ? value as FocusGroupBy : 'none';
}

const readPersistedFocusExpandedSections = (raw: string | null): Partial<FocusExpandedSections> | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      expandedSections?: {
        focus?: unknown;
        next?: unknown;
        nextActions?: unknown;
        reviewDue?: unknown;
        reviewProjects?: unknown;
        schedule?: unknown;
        upcoming?: unknown;
      };
    };
    const persisted = parsed.expandedSections;
    if (!persisted) return null;
    const next: Partial<FocusExpandedSections> = {};
    if (typeof persisted.focus === 'boolean') next.focus = persisted.focus;
    if (typeof persisted.schedule === 'boolean') next.schedule = persisted.schedule;
    const nextActionsExpanded = typeof persisted.next === 'boolean'
      ? persisted.next
      : persisted.nextActions;
    if (typeof nextActionsExpanded === 'boolean') next.next = nextActionsExpanded;
    if (typeof persisted.upcoming === 'boolean') next.upcoming = persisted.upcoming;
    if (typeof persisted.reviewDue === 'boolean') next.reviewDue = persisted.reviewDue;
    if (typeof persisted.reviewProjects === 'boolean') next.reviewProjects = persisted.reviewProjects;
    return Object.keys(next).length > 0 ? next : null;
  } catch {
    return null;
  }
};

const readPersistedFocusShowDetails = (raw: string | null): boolean | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { showDetails?: unknown };
    return typeof parsed.showDetails === 'boolean' ? parsed.showDetails : null;
  } catch {
    return null;
  }
};

const serializeFocusViewState = (expandedSections: FocusExpandedSections, showDetails: boolean): string => JSON.stringify({
  showDetails,
  expandedSections: {
    focus: expandedSections.focus,
    schedule: expandedSections.schedule,
    next: expandedSections.next,
    nextActions: expandedSections.next,
    upcoming: expandedSections.upcoming,
    reviewDue: expandedSections.reviewDue,
    reviewProjects: expandedSections.reviewProjects,
  },
});

export default function FocusScreen() {
  const { taskId, openToken, taskTab } = useLocalSearchParams<{ taskId?: string; openToken?: string; taskTab?: string }>();
  const insets = useSafeAreaInsets();
  const { tasks, projects, areas, settings, updateTask, deleteTask, reorderFocusedTasks, updateSettings, highlightTaskId, setHighlightTask } = useTaskStore((state) => ({
    tasks: state.tasks,
    projects: state.projects,
    areas: state.areas,
    settings: state.settings,
    updateTask: state.updateTask,
    deleteTask: state.deleteTask,
    reorderFocusedTasks: state.reorderFocusedTasks,
    updateSettings: state.updateSettings,
    highlightTaskId: state.highlightTaskId,
    setHighlightTask: state.setHighlightTask,
  }), shallow);
  const { isDark, themePreset } = useTheme();
  const { t } = useLanguage();
  const { showToast } = useToast();
  const tc = useThemeColors();
  const filledButton = useFilledButtonColors();
  const pullSync = useManualPullSync();
  const localDayKey = useLocalDayKey();
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [taskModalDefaultTab, setTaskModalDefaultTab] = useState<TaskEditTab>('view');
  const [taskModalOpenKey, setTaskModalOpenKey] = useState('manual');
  const [filtersVisible, setFiltersVisible] = useState(false);
  const [deferPickerTask, setDeferPickerTask] = useState<Task | null>(null);
  const [deferPickerDate, setDeferPickerDate] = useState<Date>(() => getStartDateOffset(1));
  const [focusSortBy, setFocusSortBy] = useState<SortField>(DEFAULT_FOCUS_SORT_BY);
  const [focusReorderMode, setFocusReorderMode] = useState(false);
  const [focusReorderDraft, setFocusReorderDraft] = useState<Task[]>([]);
  const [focusReorderPosition, setFocusReorderPosition] = useState<number | null>(null);
  const [showFocusReorderHint, setShowFocusReorderHint] = useState(true);
  const [saveFilterDialogVisible, setSaveFilterDialogVisible] = useState(false);
  const saveFilterKeyboardInset = useAndroidKeyboardInset(filtersVisible && saveFilterDialogVisible);
  const [saveFilterName, setSaveFilterName] = useState('');
  const [expandedSections, setExpandedSections] = useState(DEFAULT_EXPANDED_SECTIONS);
  const [showDetails, setShowDetails] = useState(true);
  const [focusViewStateHydrated, setFocusViewStateHydrated] = useState(false);
  const didToggleSectionRef = useRef(false);
  const didToggleDetailsRef = useRef(false);
  const lastOpenedFromNotificationRef = useRef<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusReorderPositionRef = useRef<number | null>(null);
  const { priorities: prioritiesEnabled, timeEstimates: timeEstimatesEnabled, pomodoro: pomodoroEnabled } = resolveFeatureFlags(settings);
  const focusTaskLimit = normalizeFocusTaskLimit(settings?.gtd?.focusTaskLimit);
  const upcomingFocusBlockedLabel = getFocusStarBlockedText(t, { blockedReason: 'deferred' }, focusTaskLimit)
    ?? undefined;
  const focusGroupBy = normalizeFocusGroupBy(settings?.gtd?.focusGroupBy);
  const { areaById, projectById, resolvedAreaFilter, visibleTasks } = useVisibleTaskContext();
  const visibleProjects = useMemo(() => (
    projects.filter((project) => !project.deletedAt && projectMatchesAreaFilterSelection(project, resolvedAreaFilter, areaById))
  ), [projects, resolvedAreaFilter, areaById]);
  const baseActiveTasks = useMemo(() => (
    visibleTasks.filter(isTaskActionable)
  ), [visibleTasks]);
  const futureStartTick = useFutureStartRevealTick(baseActiveTasks);
  const activeTasks = useMemo(() => {
    void localDayKey;
    void futureStartTick;
    const now = new Date();
    return baseActiveTasks.filter((task) => (
      shouldShowTaskForStart(task, { now, granularity: 'time' })
    ));
  }, [baseActiveTasks, localDayKey, futureStartTick]);
  const tokenOptions = useMemo(() => getFocusTokenOptions(activeTasks), [activeTasks]);
  const metadataFilterVisibility = useMemo(() => getTaskMetadataFilterVisibility(activeTasks, {
    prioritiesEnabled,
    timeEstimatesEnabled,
  }), [activeTasks, prioritiesEnabled, timeEstimatesEnabled]);
  const showPriorityFilters = metadataFilterVisibility.priority;
  const showEnergyLevelFilters = metadataFilterVisibility.energyLevel;
  const showTimeEstimateFilters = metadataFilterVisibility.timeEstimate;
  const showLocationFilter = metadataFilterVisibility.location;
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
  const effectiveTimeEstimatePresets = useMemo(
    () => resolveTimeEstimateFilterOptions(settings?.gtd?.timeEstimatePresets),
    [settings?.gtd?.timeEstimatePresets],
  );
  const savedFocusFilters = useMemo(
    () => (settings?.savedFilters ?? []).filter((filter) => filter.view === 'focus' && !filter.deletedAt),
    [settings?.savedFilters],
  );
  const resolveText = useCallback((key: string, fallback: string) => {
    return translateWithFallback(t, key, fallback);
  }, [t]);
  const projectFilterOptions = useMemo(() => ([
    ...(showNoProjectOption
      ? [{ id: NO_PROJECT_FILTER_ID, title: resolveText('taskEdit.noProjectOption', 'No project') }]
      : []),
    ...projectOptions.map((project) => ({ id: project.id, title: project.title })),
  ]), [projectOptions, resolveText, showNoProjectOption]);
  const projectFilterOptionIds = useMemo(
    () => projectFilterOptions.map((option) => option.id),
    [projectFilterOptions],
  );
  const getProjectFilterLabel = useCallback((projectId: string) => (
    projectId === NO_PROJECT_FILTER_ID
      ? resolveText('taskEdit.noProjectOption', 'No project')
      : projectById.get(projectId)?.title
  ), [projectById, resolveText]);
  const resetFocusSortBy = useCallback(() => setFocusSortBy(DEFAULT_FOCUS_SORT_BY), []);
  const selections = useTaskFilterSelections({
    view: 'focus',
    t,
    visibility: metadataFilterVisibility,
    savedFilters: savedFocusFilters,
    retainTokens: tokenOptions,
    retainProjects: projectFilterOptionIds,
    getProjectLabel: getProjectFilterLabel,
    onClear: resetFocusSortBy,
  });
  const {
    activeSavedFilter,
    applySaved: applySavedSelections,
    clear: clearFilters,
    unbindSaved: unbindSavedFilter,
  } = selections;
  const effectiveFocusSortBy = activeSavedFilter?.sortBy ?? focusSortBy;
  const effectiveFocusGroupBy = normalizeFocusGroupBy(activeSavedFilter?.groupBy ?? focusGroupBy);
  const hasFilters = selections.hasActive;
  // "All" in the saved-filter row: nothing selected, nothing saved applied,
  // and the default sort.
  const isDefaultPerspective = !hasFilters
    && !selections.activeSavedFilterId
    && focusSortBy === DEFAULT_FOCUS_SORT_BY;
  const canSaveFocusPerspective = selections.activeSavedFilterId === null
    && (
      selections.hasCurrentCriteria
      || focusSortBy !== DEFAULT_FOCUS_SORT_BY
      || effectiveFocusGroupBy !== 'none'
    );
  const filteredActiveTasks = useMemo(() => (
    applyFilter(activeTasks, selections.criteria, { projects, tokenMatchMode: 'all' })
  ), [
    activeTasks,
    selections.criteria,
    projects,
  ]);
  // Today/schedule membership is decided at day granularity (a later-today
  // start belongs there, by its time), so it draws from baseActiveTasks rather
  // than the time-granularity activeTasks pool — with the same user criteria
  // filteredActiveTasks applies. A task deferred to another day must still be
  // excluded here (day-granularity), or a dueDate<=today row with a
  // future-day start would double up in both Today and Upcoming.
  const scheduleCandidates = useMemo(() => {
    // Day granularity only cares which calendar day it is, not the clock
    // time, so this does not need futureStartTick (unlike activeTasks above).
    void localDayKey;
    const now = new Date();
    return applyFilter(
      baseActiveTasks.filter((task) => shouldShowTaskForStart(task, { now })),
      selections.criteria,
      { projects, tokenMatchMode: 'all' },
    );
  }, [
    baseActiveTasks,
    localDayKey,
    selections.criteria,
    projects,
  ]);
  // Today's Focus shows every starred task the focus cap counts. It must not
  // inherit the pool's area-visibility or start-time hiding: the star buttons
  // enforce the store-wide count, so a starred task hidden by those rules
  // silently eats a slot no filter change can reveal ("I can only star 4 when
  // the limit is 5"). User filter criteria still apply — that cause is visible.
  const focusedPool = useMemo(() => (
    applyFilter(
      tasks.filter((task) => isTaskActionable(task) && task.isFocusedToday === true),
      selections.criteria,
      { projects, tokenMatchMode: 'all' },
    )
  ), [tasks, selections.criteria, projects]);
  // The Upcoming preview draws from baseActiveTasks: the deferral filter that
  // produced activeTasks is exactly what hides these rows today (#1061).
  // Starred tasks are excluded — they render in Today's Focus regardless of
  // deferral, and one task must not appear in both sections. Membership is
  // day-based (another-day deferrals only), so this doesn't need futureStartTick.
  const upcomingEntries = useMemo(() => {
    void localDayKey;
    const now = new Date();
    return getUpcomingDeferredTasks(
      applyFilter(
        baseActiveTasks.filter((task) => !task.isFocusedToday),
        selections.criteria,
        { projects, tokenMatchMode: 'all' },
      ),
      { now },
    );
  }, [baseActiveTasks, localDayKey, projects, selections.criteria]);
  const upcomingCandidates = useMemo(
    () => upcomingEntries.map((entry) => entry.task),
    [upcomingEntries],
  );
  // The date a deferred row surfaces on is the section's whole point, so it rides
  // the row itself rather than the meta line. Built once per list so the footer
  // node stays identity-stable and the row keeps its memo boundary (#766).
  const upcomingAppearsAtFooters = useMemo(() => {
    const byTaskId = new Map<string, React.ReactNode>();
    for (const entry of upcomingEntries) {
      byTaskId.set(entry.task.id, (
        <Text style={[styles.upcomingAppearsAt, { color: tc.secondaryText }]}>
          {safeFormatDate(entry.appearsAt, 'P')}
        </Text>
      ));
    }
    return byTaskId;
  }, [tc.secondaryText, upcomingEntries]);
  const getFocusGroupByLabel = useCallback((groupBy: FocusGroupBy) => {
    switch (groupBy) {
      case 'context':
        return resolveText('focus.group.context', 'Context');
      case 'project':
        return resolveText('focus.group.project', 'Project');
      case 'area':
        return resolveText('focus.group.area', 'Area');
      case 'energy':
        return resolveText('focus.group.energy', 'Energy');
      case 'priority':
        return resolveText('focus.group.priority', 'Priority');
      case 'person':
        return resolveText('people.title', 'People');
      case 'tag':
        return resolveText('tags.title', 'Tags');
      case 'none':
      default:
        return resolveText('focus.group.none', 'None');
    }
  }, [resolveText]);
  const getFocusSortByLabel = useCallback((sortBy: SortField) => {
    if (sortBy === 'priority') return resolveText('filters.priority', 'Priority');
    return resolveText(`sort.${sortBy}`, sortBy);
  }, [resolveText]);
  const updateFocusSortBy = useCallback((nextSortBy: SortField) => {
    if (nextSortBy === effectiveFocusSortBy && !activeSavedFilter) return;
    unbindSavedFilter();
    setFocusSortBy(nextSortBy);
  }, [activeSavedFilter, effectiveFocusSortBy, unbindSavedFilter]);
  const updateFocusGroupBy = useCallback((nextGroupBy: FocusGroupBy) => {
    if (nextGroupBy === effectiveFocusGroupBy && !activeSavedFilter) return;
    unbindSavedFilter();
    void updateSettings({
      gtd: {
        ...(settings?.gtd ?? {}),
        focusGroupBy: nextGroupBy,
      },
    }).catch(() => undefined);
  }, [activeSavedFilter, effectiveFocusGroupBy, settings?.gtd, unbindSavedFilter, updateSettings]);
  const showTaskUpdateError = useCallback((message?: string) => {
    showToast({
      title: resolveText('common.error', 'Error'),
      message: message || resolveText('task.updateFailed', 'Could not update task.'),
      tone: 'error',
      durationMs: 4200,
    });
  }, [resolveText, showToast]);
  const deferTaskUntil = useCallback((task: Task, selectedDate: Date) => {
    const startDate = new Date(selectedDate);
    startDate.setHours(0, 0, 0, 0);
    const startTime = formatDateOnly(startDate);
    const previousStartTime = task.startTime;
    const previousFocused = task.isFocusedToday === true;
    const deferUpdates: Partial<Task> = {
      startTime,
      ...(previousFocused ? { isFocusedToday: false } : {}),
    };

    void settleStoreAction(() => updateTask(task.id, deferUpdates))
      .then((outcome) => {
        if (!outcome.ok) {
          showTaskUpdateError(outcome.message);
          return;
        }
        showToast({
          title: task.title,
          message: `${resolveText('review.startTime', 'Defer until')} ${safeFormatDate(startDate, 'PP', startTime)}`,
          tone: 'info',
          actionLabel: resolveText('common.undo', 'Undo'),
          onAction: async () => {
            const undoUpdates: Partial<Task> = {
              startTime: previousStartTime,
              ...(previousFocused ? { isFocusedToday: true } : {}),
            };
            const undoOutcome = await settleStoreAction(() => updateTask(task.id, undoUpdates));
            if (!undoOutcome.ok) {
              if ('cause' in undoOutcome) throw undoOutcome.cause;
              throw new Error(undoOutcome.message ?? '');
            }
          },
          durationMs: 5200,
        });
      });
  }, [resolveText, showTaskUpdateError, showToast, updateTask]);
  const markTaskReviewed = useCallback((task: Task) => {
    const previousReviewAt = task.reviewAt;

    void settleStoreAction(() => updateTask(task.id, { reviewAt: undefined }))
      .then((outcome) => {
        if (!outcome.ok) {
          showTaskUpdateError(outcome.message);
          return;
        }
        showToast({
          title: task.title,
          message: resolveText('review.markReviewedDone', 'Marked reviewed'),
          tone: 'success',
          actionLabel: resolveText('common.undo', 'Undo'),
          onAction: async () => {
            const undoOutcome = await settleStoreAction(() => updateTask(task.id, { reviewAt: previousReviewAt }));
            if (!undoOutcome.ok) {
              if ('cause' in undoOutcome) throw undoOutcome.cause;
              throw new Error(undoOutcome.message ?? '');
            }
          },
          durationMs: 5200,
        });
      });
  }, [resolveText, showTaskUpdateError, showToast, updateTask]);
  const advanceTaskReview = useCallback((task: Task) => {
    const previousReviewAt = task.reviewAt;

    void settleStoreAction(() => updateTask(task.id, { reviewAt: getAdvancedReviewDate(task.reviewAt) }))
      .then((outcome) => {
        if (!outcome.ok) {
          showTaskUpdateError(outcome.message);
          return;
        }
        showToast({
          title: task.title,
          message: resolveText('review.advanceWeekDone', 'Next review in 1 week'),
          tone: 'success',
          actionLabel: resolveText('common.undo', 'Undo'),
          onAction: async () => {
            const undoOutcome = await settleStoreAction(() => updateTask(task.id, { reviewAt: previousReviewAt }));
            if (!undoOutcome.ok) {
              if ('cause' in undoOutcome) throw undoOutcome.cause;
              throw new Error(undoOutcome.message ?? '');
            }
          },
          durationMs: 5200,
        });
      });
  }, [resolveText, showTaskUpdateError, showToast, updateTask]);
  const openReviewMenu = useCallback((task: Task) => {
    Alert.alert(
      task.title,
      undefined,
      [
        {
          text: resolveText('review.markReviewed', 'Mark reviewed'),
          onPress: () => markTaskReviewed(task),
        },
        {
          text: resolveText('review.advanceWeek', 'Review in 1 week'),
          onPress: () => advanceTaskReview(task),
        },
        { text: resolveText('common.cancel', 'Cancel'), style: 'cancel' },
      ],
      { cancelable: true },
    );
  }, [advanceTaskReview, markTaskReviewed, resolveText]);
  const openDeferDatePicker = useCallback((task: Task) => {
    setDeferPickerDate(getStartDateOffset(1));
    setDeferPickerTask(task);
  }, []);
  const openDeferMenu = useCallback((task: Task) => {
    Alert.alert(
      resolveText('review.startTime', 'Defer until'),
      task.title,
      [
        {
          text: resolveText('quickDate.tomorrow', 'Tomorrow'),
          onPress: () => deferTaskUntil(task, getStartDateOffset(1)),
        },
        {
          text: resolveText('quickDate.nextWeek', 'Next week'),
          onPress: () => deferTaskUntil(task, getStartDateOffset(7)),
        },
        {
          text: resolveText('recurrence.custom', 'Custom...'),
          onPress: () => openDeferDatePicker(task),
        },
        { text: resolveText('common.cancel', 'Cancel'), style: 'cancel' },
      ],
      { cancelable: true },
    );
  }, [deferTaskUntil, openDeferDatePicker, resolveText]);
  const closeDeferDatePicker = useCallback(() => {
    setDeferPickerTask(null);
  }, []);
  const confirmPickedDeferDate = useCallback(() => {
    const task = deferPickerTask;
    setDeferPickerTask(null);
    if (task) deferTaskUntil(task, deferPickerDate);
  }, [deferPickerDate, deferPickerTask, deferTaskUntil]);
  const handleDeferDateChange = useCallback((event: DateTimePickerEvent, selectedDate?: Date) => {
    if (event.type === 'dismissed') {
      setDeferPickerTask(null);
      return;
    }
    if (!selectedDate) return;
    let nextDate = new Date(selectedDate);
    nextDate.setHours(0, 0, 0, 0);
    // Deferring means "not today": the iOS inline picker has no native
    // minimumDate (see the render site), so enforce the tomorrow floor here.
    const floor = getStartDateOffset(1);
    if (nextDate < floor) nextDate = floor;
    setDeferPickerDate(nextDate);
    if (Platform.OS !== 'ios') {
      const task = deferPickerTask;
      setDeferPickerTask(null);
      if (task) deferTaskUntil(task, nextDate);
    }
  }, [deferPickerTask, deferTaskUntil]);
  const applySavedFocusFilter = useCallback((filter: SavedFilter) => {
    applySavedSelections(filter);
    setFocusSortBy(filter.sortBy ?? DEFAULT_FOCUS_SORT_BY);
    setFiltersVisible(false);
  }, [applySavedSelections]);
  const saveCurrentFilter = useCallback(() => {
    const trimmedName = saveFilterName.trim();
    if (!trimmedName || !canSaveFocusPerspective) return;
    const nowIso = new Date().toISOString();
    const nextFilter: SavedFilter = {
      id: generateUUID(),
      name: trimmedName,
      view: 'focus',
      criteria: selections.currentCriteria,
      ...(focusSortBy !== DEFAULT_FOCUS_SORT_BY ? { sortBy: focusSortBy } : {}),
      ...(effectiveFocusGroupBy !== 'none' ? { groupBy: effectiveFocusGroupBy } : {}),
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    updateSettings({
      savedFilters: [...(settings?.savedFilters ?? []), nextFilter],
    }).then(() => {
      // Binds the new filter as the active one; its criteria are the ones just
      // saved, so re-applying them is a no-op beyond marking it selected.
      applySavedFocusFilter(nextFilter);
      setSaveFilterDialogVisible(false);
    }).catch(() => undefined);
  }, [applySavedFocusFilter, canSaveFocusPerspective, effectiveFocusGroupBy, focusSortBy, saveFilterName, selections.currentCriteria, settings?.savedFilters, updateSettings]);
  // A deleted saved filter drops out of savedFocusFilters, and the selections
  // hook clears its own binding from there.
  const deleteSavedFilter = useCallback((filter: SavedFilter) => {
    const nextFilters = markSavedFilterDeleted(settings?.savedFilters, filter.id);
    updateSettings({ savedFilters: nextFilters }).catch(() => undefined);
  }, [settings?.savedFilters, updateSettings]);
  const confirmDeleteSavedFilter = useCallback((filter: SavedFilter) => {
    Alert.alert(
      resolveText('savedFilters.deleteTitle', 'Delete saved filter?'),
      filter.name,
      [
        { text: resolveText('common.cancel', 'Cancel'), style: 'cancel' },
        {
          text: resolveText('common.delete', 'Delete'),
          style: 'destructive',
          onPress: () => deleteSavedFilter(filter),
        },
      ],
      { cancelable: true },
    );
  }, [deleteSavedFilter, resolveText]);
  const removeAdvancedSavedFilterCriterion = useCallback((chipId: string) => {
    if (!activeSavedFilter) return;
    const nextCriteria = removeAdvancedFilterCriteriaChip(activeSavedFilter.criteria, chipId);
    if (nextCriteria === activeSavedFilter.criteria) return;

    const nowIso = new Date().toISOString();
    const nextFilters = (settings?.savedFilters ?? []).map((filter) => (
      filter.id === activeSavedFilter.id
        ? { ...filter, criteria: nextCriteria, updatedAt: nowIso }
        : filter
    ));
    updateSettings({ savedFilters: nextFilters }).catch(() => undefined);
  }, [activeSavedFilter, settings?.savedFilters, updateSettings]);
  const confirmRemoveAdvancedSavedFilterCriterion = useCallback((chipId: string, label: string) => {
    Alert.alert(
      resolveText('common.delete', 'Delete'),
      label,
      [
        { text: resolveText('common.cancel', 'Cancel'), style: 'cancel' },
        {
          text: resolveText('common.delete', 'Delete'),
          style: 'destructive',
          onPress: () => removeAdvancedSavedFilterCriterion(chipId),
        },
      ],
      { cancelable: true },
    );
  }, [removeAdvancedSavedFilterCriterion, resolveText]);

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(FOCUS_VIEW_STATE_STORAGE_KEY)
      .then((raw) => {
        if (!active) return;
        if (!didToggleSectionRef.current) {
          const persistedExpandedSections = readPersistedFocusExpandedSections(raw);
          if (persistedExpandedSections) {
            setExpandedSections((current) => ({
              ...current,
              ...persistedExpandedSections,
            }));
          }
        }
        if (!didToggleDetailsRef.current) {
          const persistedShowDetails = readPersistedFocusShowDetails(raw);
          if (persistedShowDetails !== null) {
            setShowDetails(persistedShowDetails);
          }
        }
        setFocusViewStateHydrated(true);
      })
      .catch(() => {
        if (active) {
          setFocusViewStateHydrated(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!taskId || typeof taskId !== 'string') return;
    const nextTaskTab = resolveTaskRouteTab(taskTab);
    const openKey = `${taskId}:${typeof openToken === 'string' ? openToken : ''}:${nextTaskTab}`;
    if (lastOpenedFromNotificationRef.current === openKey) return;
    const task = tasks.find((item) => item.id === taskId && !item.deletedAt);
    if (!task) return;
    lastOpenedFromNotificationRef.current = openKey;
    setHighlightTask(task.id);
    setTaskModalDefaultTab(nextTaskTab);
    setTaskModalOpenKey(`route:${openKey}`);
    setEditingTask(task);
    setIsModalVisible(true);
  }, [openToken, setHighlightTask, taskId, taskTab, tasks]);

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
  const sequentialWithinSectionProjectIds = useMemo(() => {
    return new Set(
      visibleProjects
        .filter((project) => project.isSequential && project.sequentialScope === 'section')
        .map((project) => project.id)
    );
  }, [visibleProjects]);
  const sortBySavedPerspective = useCallback((items: Task[]) => {
    if (effectiveFocusSortBy === DEFAULT_FOCUS_SORT_BY) return items;
    return sortTasksBySavedPreference(items, effectiveFocusSortBy, {
      projects,
      prioritizeByPriority: prioritiesEnabled,
      sortOrder: activeSavedFilter?.sortOrder,
    });
  }, [activeSavedFilter?.sortOrder, effectiveFocusSortBy, prioritiesEnabled, projects]);

  const { focusedTasks, schedule, nextActions, upcoming, reviewDue, projectDeadlineBoosts } = useMemo(() => {
    void localDayKey;
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const { otherTasks: nonFocusedTasks } = splitFocusedTasks(filteredActiveTasks);
    const { otherTasks: nonFocusedScheduleTasks } = splitFocusedTasks(scheduleCandidates);
    const allFocusedTasks = focusedPool;
    const sequentialFirstTaskIds = getFocusSequentialFirstTaskIds(baseActiveTasks, sequentialProjectIds, {
      now,
      sectionScopedProjectIds: sequentialWithinSectionProjectIds,
    });

    const isSequentialBlocked = (task: Task) => {
      if (!task.projectId) return false;
      if (!sequentialProjectIds.has(task.projectId)) return false;
      return !sequentialFirstTaskIds.has(task.id);
    };

    const scheduleItems = nonFocusedScheduleTasks.filter((task) => {
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
    const reviewDueItems = nonFocusedTasks
      .filter((task) => !scheduleIds.has(task.id) && isDueForReview(task.reviewAt, now))
      .sort((a, b) => {
        const aReview = safeParseDate(a.reviewAt)?.getTime() ?? Number.POSITIVE_INFINITY;
        const bReview = safeParseDate(b.reviewAt)?.getTime() ?? Number.POSITIVE_INFINITY;
        if (aReview !== bReview) return aReview - bReview;
        return a.title.localeCompare(b.title);
      });
    const reviewDueIds = new Set(reviewDueItems.map((task) => task.id));

    const nextItems = nonFocusedTasks.filter((task) => {
      if (reviewDueIds.has(task.id)) return false;
      if (task.status !== 'next') return false;
      if (isSequentialBlocked(task)) return false;
      return !scheduleIds.has(task.id);
    });
    const nextProjectDeadlineBoosts = effectiveFocusSortBy === DEFAULT_FOCUS_SORT_BY
      ? getProjectDeadlineBoosts(nextItems, projects, { now })
      : new Map<string, ProjectDeadlineBoost>();

    // Mirrors desktop's scheduleSortTime (AgendaView.tsx): the earlier of due
    // and start, so a 09:00 start sorts ahead of a 17:00 due date.
    const scheduleSortTime = (task: Task) => {
      const due = safeParseDueDate(task.dueDate)?.getTime();
      const start = safeParseDate(task.startTime)?.getTime();
      if (typeof due === 'number' && typeof start === 'number') return Math.min(due, start);
      if (typeof due === 'number') return due;
      if (typeof start === 'number') return start;
      return Number.POSITIVE_INFINITY;
    };
    const sortedScheduleItems = [...scheduleItems].sort((a, b) => {
      const timeDiff = scheduleSortTime(a) - scheduleSortTime(b);
      if (timeDiff !== 0) return timeDiff;
      return a.title.localeCompare(b.title);
    });

    return {
      // Default sort honours the manual Today's Focus order (focusOrder); an
      // explicit non-default sort wins and hides the reorder affordance.
      focusedTasks: effectiveFocusSortBy === DEFAULT_FOCUS_SORT_BY
        ? sortTasksByFocusOrder(allFocusedTasks)
        : sortBySavedPerspective(allFocusedTasks),
      schedule: effectiveFocusSortBy === DEFAULT_FOCUS_SORT_BY ? sortedScheduleItems : sortBySavedPerspective(scheduleItems),
      nextActions: effectiveFocusSortBy === DEFAULT_FOCUS_SORT_BY
        ? sortFocusNextActions(nextItems, {
          now,
          prioritizeByPriority: prioritiesEnabled,
          projectDeadlineBoosts: nextProjectDeadlineBoosts,
        })
        : sortBySavedPerspective(nextItems),
      reviewDue: effectiveFocusSortBy === DEFAULT_FOCUS_SORT_BY ? reviewDueItems : sortBySavedPerspective(reviewDueItems),
      // The forecast keeps reveal-date order even under a custom sort — the
      // date a task appears is the only ordering that means anything here.
      upcoming: upcomingCandidates.filter((task) => !isSequentialBlocked(task)),
      projectDeadlineBoosts: nextProjectDeadlineBoosts,
    };
  }, [
    baseActiveTasks,
    effectiveFocusSortBy,
    filteredActiveTasks,
    focusedPool,
    localDayKey,
    prioritiesEnabled,
    projects,
    scheduleCandidates,
    sequentialProjectIds,
    sequentialWithinSectionProjectIds,
    sortBySavedPerspective,
    upcomingCandidates,
  ]);
  const reviewDueProjects = useMemo(() => {
    void localDayKey;
    const now = new Date();
    return visibleProjects
      .filter((project) => project.status !== 'archived' && isDueForReview(project.reviewAt, now))
      .sort((a, b) => {
        const aReview = safeParseDate(a.reviewAt)?.getTime() ?? Number.POSITIVE_INFINITY;
        const bReview = safeParseDate(b.reviewAt)?.getTime() ?? Number.POSITIVE_INFINITY;
        if (aReview !== bReview) return aReview - bReview;
        return a.title.localeCompare(b.title);
      });
  }, [localDayKey, visibleProjects]);

  // Manual focusOrder is a full-list concept. focusedTasks derives from
  // filteredActiveTasks, so an active filter narrows it to a subset; reordering
  // that subset writes focusOrder indices 0..n over only the visible rows and
  // corrupts the positions of hidden focused tasks. Gate reorder on the default
  // sort AND no active filter (the effect below also exits reorder mode if a
  // filter engages mid-reorder). Clearing the filter is the correction path.
  const canReorderFocus = effectiveFocusSortBy === DEFAULT_FOCUS_SORT_BY
    && !hasFilters
    && focusedTasks.length > 0;

  const enterFocusReorder = useCallback(() => {
    animateFocusReorderLayout();
    setFocusReorderDraft(focusedTasks);
    focusReorderPositionRef.current = null;
    setFocusReorderPosition(null);
    setShowFocusReorderHint(true);
    setFocusReorderMode(true);
  }, [focusedTasks]);

  const exitFocusReorder = useCallback(() => {
    animateFocusReorderLayout();
    focusReorderPositionRef.current = null;
    setFocusReorderPosition(null);
    setFocusReorderMode(false);
  }, []);

  const handleFocusReorderDragBegin = useCallback((index: number) => {
    focusReorderPositionRef.current = index;
    setFocusReorderPosition(index);
    setShowFocusReorderHint(false);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
  }, []);

  const handleFocusReorderPlaceholderChange = useCallback((index: number) => {
    if (focusReorderPositionRef.current === index) return;
    focusReorderPositionRef.current = index;
    setFocusReorderPosition(index);
    void Haptics.selectionAsync().catch(() => undefined);
  }, []);

  const handleFocusReorderDragEnd = useCallback(({ data }: DragEndParams<Task>) => {
    focusReorderPositionRef.current = null;
    setFocusReorderPosition(null);
    setFocusReorderDraft(data);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    void Promise.resolve(reorderFocusedTasks(data.map((task) => task.id))).catch(() => {});
  }, [reorderFocusedTasks]);

  useEffect(() => {
    if (!focusReorderMode) return undefined;
    const subscription = addHardwareBackPressListener(() => {
      exitFocusReorder();
      return true;
    });
    return () => subscription.remove();
  }, [exitFocusReorder, focusReorderMode]);

  // Reorder mode owns the whole screen; if the section empties or a non-default
  // sort takes over while it is open, drop back to the normal list.
  useEffect(() => {
    if (focusReorderMode && !canReorderFocus) {
      exitFocusReorder();
    }
  }, [canReorderFocus, exitFocusReorder, focusReorderMode]);

  // Reconcile the dragged order with the live Focus list at render time (a task
  // finishing or arriving mid-reorder) without discarding the user's ordering.
  // Deriving this rather than syncing draft state in an effect avoids a render
  // loop: focusedTasks is a fresh array every render.
  const focusReorderData = useMemo(() => {
    const byId = new Map(focusedTasks.map((task) => [task.id, task] as const));
    const kept = focusReorderDraft
      .filter((task) => byId.has(task.id))
      .map((task) => byId.get(task.id) as Task);
    const keptIds = new Set(kept.map((task) => task.id));
    const added = focusedTasks.filter((task) => !keptIds.has(task.id));
    return [...kept, ...added];
  }, [focusReorderDraft, focusedTasks]);

  const moveFocusReorderTask = useCallback((taskId: string, offset: -1 | 1) => {
    const from = focusReorderData.findIndex((task) => task.id === taskId);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= focusReorderData.length) return;
    const next = [...focusReorderData];
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    setFocusReorderDraft(next);
    setShowFocusReorderHint(false);
    void Haptics.selectionAsync().catch(() => undefined);
    void Promise.resolve(reorderFocusedTasks(next.map((task) => task.id))).catch(() => {});
  }, [focusReorderData, reorderFocusedTasks]);

  const getFocusReorderSecondaryLabel = useCallback((task: Task) => {
    const details: string[] = [];
    const project = task.projectId ? projectById.get(task.projectId) : undefined;
    if (project) details.push(project.title);
    const dueDate = safeParseDueDate(task.dueDate);
    if (dueDate) {
      details.push(safeFormatDate(
        dueDate,
        hasTimeComponent(task.dueDate) ? 'Pp' : 'P',
        task.dueDate,
      ));
    }
    return details.join(' · ');
  }, [projectById]);

  const sections = useMemo<FocusSection[]>(() => {
    if (!focusViewStateHydrated) return [];

    const buildTaskItems = (items: Task[], grouped = false): FocusListItem[] => (
      items.map((task) => ({ type: 'task' as const, task, grouped }))
    );
    const buildProjectItems = (items: Project[]): FocusListItem[] => (
      items.map((project) => ({ type: 'project' as const, project }))
    );
    const buildGroupedNextItems = (): FocusListItem[] => {
      if (!expandedSections.next) return [];
      if (effectiveFocusGroupBy === 'none') {
        return buildTaskItems(nextActions);
      }
      const groups = buildFocusTaskGroups({
        groupBy: effectiveFocusGroupBy,
        tasks: nextActions,
        projects,
        areas,
        resolveText,
        theme: themePreset,
      });
      return groups
        .flatMap((group) => [
          {
            type: 'groupHeader' as const,
            id: group.key,
            title: group.label,
            count: group.tasks.length,
            muted: group.muted,
            dotColor: group.dotColor,
          },
          ...buildTaskItems(group.tasks, true),
        ]);
    };
    const nextSections: FocusSection[] = [];

    if (focusedTasks.length > 0) {
      nextSections.push({
        title: t('agenda.todaysFocus') ?? "Today's Focus",
        data: expandedSections.focus ? buildTaskItems(focusedTasks) : [],
        totalCount: focusedTasks.length,
        expanded: expandedSections.focus,
        type: 'focus',
      });
    }

    nextSections.push(
      {
        title: t('focus.schedule') ?? 'Today',
        data: expandedSections.schedule ? buildTaskItems(schedule) : [],
        totalCount: schedule.length,
        expanded: expandedSections.schedule,
        type: 'schedule',
      },
      {
        title: t('agenda.reviewDue') ?? 'Review Due',
        data: expandedSections.reviewDue ? buildTaskItems(reviewDue) : [],
        totalCount: reviewDue.length,
        expanded: expandedSections.reviewDue,
        type: 'reviewDue',
      },
      {
        title: t('focus.nextActions') ?? t('list.next'),
        data: buildGroupedNextItems(),
        totalCount: nextActions.length,
        expanded: expandedSections.next,
        type: 'next',
      },
      ...(upcoming.length > 0 ? [{
        title: t('agenda.upcoming') ?? 'Upcoming',
        data: expandedSections.upcoming ? buildTaskItems(upcoming) : [],
        totalCount: upcoming.length,
        expanded: expandedSections.upcoming,
        type: 'upcoming' as const,
      }] : []),
      {
        title: t('agenda.reviewDueProjects') ?? 'Projects to review',
        data: expandedSections.reviewProjects ? buildProjectItems(reviewDueProjects) : [],
        totalCount: reviewDueProjects.length,
        expanded: expandedSections.reviewProjects,
        type: 'reviewProjects',
      }
    );

    return nextSections;
  }, [
    areas,
    effectiveFocusGroupBy,
    expandedSections.focus,
    expandedSections.next,
    focusViewStateHydrated,
    expandedSections.reviewDue,
    expandedSections.reviewProjects,
    expandedSections.schedule,
    expandedSections.upcoming,
    focusedTasks,
    nextActions,
    upcoming,
    projects,
    resolveText,
    reviewDue,
    reviewDueProjects,
    schedule,
    t,
    themePreset,
  ]);
  const focusListVersion = useMemo(() => (
    sections.map((section) => {
      const itemVersion = section.data.map((item) => {
        if (item.type === 'task') {
          return [
            'task',
            item.task.id,
            item.task.status,
            item.task.isFocusedToday === true ? 'focused' : 'unfocused',
            item.task.updatedAt ?? '',
            item.task.rev ?? '',
          ].join(':');
        }
        if (item.type === 'project') {
          return [
            'project',
            item.project.id,
            item.project.status,
            item.project.reviewAt ?? '',
            item.project.updatedAt ?? '',
          ].join(':');
        }
        return ['group', item.id, item.count].join(':');
      }).join(',');
      return [section.type, section.expanded ? 'expanded' : 'collapsed', section.totalCount, itemVersion].join('|');
    }).join('||')
  ), [sections]);
  const firstVisibleSectionType = useMemo(
    () => sections.find((section) => section.totalCount > 0)?.type ?? null,
    [sections]
  );
  // Measured-height getItemLayout: without it the
  // SectionList estimates unmounted regions from a running average, and the
  // mixed row heights (group headers vs task rows) make Android's scroll
  // corrections oscillate at the bottom of the list (#826).
  const focusItemHeightsRef = useRef<Record<string, number>>({});
  const [focusLayoutVersion, setFocusLayoutVersion] = useState(0);
  const registerFocusItemHeight = useCallback((itemKey: string, height: number) => {
    const rounded = Math.round(height);
    if (!Number.isFinite(rounded) || rounded <= 0) return;
    if (focusItemHeightsRef.current[itemKey] === rounded) return;
    focusItemHeightsRef.current[itemKey] = rounded;
    setFocusLayoutVersion((prev) => prev + 1);
  }, []);
  const wasPullRefreshingRef = useRef(false);
  useEffect(() => {
    if (wasPullRefreshingRef.current && !pullSync.refreshing) {
      focusItemHeightsRef.current = {};
      setFocusLayoutVersion((prev) => prev + 1);
    }
    wasPullRefreshingRef.current = pullSync.refreshing;
  }, [pullSync.refreshing]);
  useEffect(() => {
    const { heights, changed } = reconcileFocusListMeasuredHeights(
      sections,
      firstVisibleSectionType,
      focusItemHeightsRef.current,
    );
    if (changed) {
      focusItemHeightsRef.current = heights;
      setFocusLayoutVersion((prev) => prev + 1);
    }
  }, [firstVisibleSectionType, sections]);
  const focusItemLayouts = useMemo(() => {
    // focusLayoutVersion invalidates memoized frames when ref-backed heights change.
    void focusLayoutVersion;
    return buildFocusListLayoutFrames(sections, {
      measuredHeights: focusItemHeightsRef.current,
      firstVisibleSectionType,
    });
  }, [firstVisibleSectionType, focusLayoutVersion, sections]);
  const getFocusItemLayout = useCallback((_: unknown, index: number) => {
    const frame = focusItemLayouts[index];
    if (frame) {
      return { index, length: frame.length, offset: frame.offset };
    }
    return {
      index,
      length: FOCUS_ESTIMATED_TASK_HEIGHT,
      offset: FOCUS_ESTIMATED_TASK_HEIGHT * index,
    };
  }, [focusItemLayouts]);
  const hasTasks = focusedTasks.length > 0 || schedule.length > 0 || nextActions.length > 0 || reviewDue.length > 0 || reviewDueProjects.length > 0;
  const activeFilterCount = selections.activeCount;
  // Criteria an applied saved filter carries that no picker can express; they
  // are removed from the saved filter itself rather than from the selections.
  const advancedFilterChips = useMemo<FocusFilterChip[]>(() => {
    if (!activeSavedFilter) return [];
    return buildAdvancedFilterCriteriaChips(selections.criteria, {
      getAreaLabel: (areaId) => areaById.get(areaId)?.name,
      resolveText,
    }).map((chip) => ({
      id: `advanced:${chip.id}`,
      label: chip.label,
      onPress: () => confirmRemoveAdvancedSavedFilterCriterion(chip.id, chip.label),
      variant: 'advanced',
    }));
  }, [activeSavedFilter, areaById, confirmRemoveAdvancedSavedFilterCriterion, selections.criteria, resolveText]);
  const activeFilterChips = useMemo<FocusFilterChip[]>(() => ([
    ...selections.chips.map((chip) => ({
      id: chip.id,
      label: chip.label,
      onPress: chip.onPress,
      variant: chip.excluded ? 'excluded' as const : undefined,
    })),
    ...advancedFilterChips,
  ]), [advancedFilterChips, selections.chips]);
  const openSaveFilterDialog = useCallback(() => {
    const defaultName = activeFilterChips.slice(0, 3).map((chip) => chip.label).join(' + ')
      || resolveText('savedFilters.defaultName', 'Focus filter');
    setSaveFilterName(defaultName);
    setSaveFilterDialogVisible(true);
  }, [activeFilterChips, resolveText]);
  const emptyTitle = hasFilters ? resolveText('filters.noMatch', 'No tasks match these filters.') : t('agenda.allClear');
  const emptySubtitle = hasFilters
    ? resolveText('filters.label', 'Filters')
    : tasks.length > 0 ? t('agenda.noTasks') : t('agenda.emptyStart');
  const pomodoroTasks = useMemo(() => {
    const byId = new Map<string, Task>();
    [...focusedTasks, ...schedule, ...nextActions, ...reviewDue].forEach((task) => {
      if (task.deletedAt) return;
      byId.set(task.id, task);
    });
    return Array.from(byId.values());
  }, [focusedTasks, schedule, nextActions, reviewDue]);

  const onEdit = useCallback((task: Task) => {
    setTaskModalDefaultTab('view');
    setTaskModalOpenKey(`manual:${task.id}`);
    setEditingTask(task);
    setIsModalVisible(true);
  }, []);

  // One object for every row, so a store write does not hand each row a fresh
  // set of arrows and re-render the whole visible list (#766).
  const rowActions = useMemo<TaskRowActions>(() => ({
    edit: onEdit,
    changeStatus: (task, status) => updateTask(task.id, { status }),
    remove: (task) => deleteTask(task.id),
  }), [deleteTask, onEdit, updateTask]);

  const onSaveTask = useCallback((taskId: string, updates: Partial<Task>) => {
    // Returned, not swallowed: the editor reports a failed save from this result.
    return updateTask(taskId, updates);
  }, [updateTask]);

  const toggleSection = useCallback((sectionType: FocusSectionType) => {
    didToggleSectionRef.current = true;
    setExpandedSections((current) => {
      const next = {
        ...current,
        [sectionType]: !current[sectionType],
      };
      AsyncStorage.setItem(FOCUS_VIEW_STATE_STORAGE_KEY, serializeFocusViewState(next, showDetails)).catch(() => {});
      return next;
    });
  }, [showDetails]);
  const toggleShowDetails = useCallback(() => {
    didToggleDetailsRef.current = true;
    setShowDetails((current) => {
      const next = !current;
      AsyncStorage.setItem(FOCUS_VIEW_STATE_STORAGE_KEY, serializeFocusViewState(expandedSections, next)).catch(() => {});
      // Measured row heights key on task.rev only, not on the details flag, so a
      // toggle must invalidate them itself or stale frames make Android's scroll
      // corrections oscillate (#826) — same reset the pull-refresh effect uses.
      focusItemHeightsRef.current = {};
      setFocusLayoutVersion((prev) => prev + 1);
      return next;
    });
  }, [expandedSections]);
  const renderFilterChip = useCallback((
    label: string,
    selected: boolean,
    onPress?: () => void,
    key = label,
    variant?: FocusFilterChip['variant'],
  ) => (
    <FilterChip
      key={key}
      label={label}
      selected={selected}
      themeColors={tc}
      onPress={onPress}
      variant={variant}
      removeLabel={`${resolveText('common.delete', 'Delete')} ${label}`}
      excludedLabel={resolveText('filters.excluded', 'Excluded')}
    />
  ), [resolveText, tc]);

  const renderItem = ({ item, section }: { item: FocusListItem; section: FocusSection }) => {
    // Margin-free measuring wrapper: its height includes the row's own
    // margins, matching the cell frames VirtualizedList measures natively.
    const measureRow = (node: React.ReactNode) => (
      <View
        onLayout={(event) => registerFocusItemHeight(
          focusItemLayoutKey(section.type, item),
          event.nativeEvent.layout.height,
        )}
      >
        {node}
      </View>
    );
    if (item.type === 'groupHeader') {
      return measureRow(
        <View
          accessible
          accessibilityRole="header"
          accessibilityLabel={`${item.title} ${item.count}`}
          style={styles.contextGroupHeader}
        >
          <View
            style={[
              styles.contextGroupDot,
              { backgroundColor: item.muted ? tc.secondaryText : (item.dotColor ?? tc.tint) },
            ]}
          />
          <Text
            style={[
              styles.contextGroupTitle,
              { color: item.muted ? tc.secondaryText : tc.text },
            ]}
          >
            {item.title}
          </Text>
          <Text style={[styles.contextGroupCount, { color: tc.secondaryText }]}>
            {item.count}
          </Text>
        </View>
      );
    }

    if (item.type === 'project') {
      const project = item.project;
      return measureRow(
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={`${resolveText('common.open', 'Open')} ${project.title}`}
          onPress={() => openProjectScreen(project.id)}
          style={[
            styles.projectReviewCard,
            { backgroundColor: tc.cardBg, borderColor: tc.border },
          ]}
        >
          <View style={styles.projectReviewMain}>
            <View
              style={[
                styles.projectReviewIcon,
                { backgroundColor: tc.filterBg, borderColor: project.color || tc.border },
              ]}
            >
              <Folder size={18} color={tc.text} />
            </View>
            <View style={styles.projectReviewTextBlock}>
              <Text numberOfLines={1} style={[styles.projectReviewTitle, { color: tc.text }]}>
                {project.title}
              </Text>
              <Text style={[styles.projectReviewStatus, { color: tc.secondaryText }]}>
                {t(`status.${project.status}`)}
              </Text>
            </View>
          </View>
          {project.reviewAt ? (
            <Text style={[styles.projectReviewDate, { color: tc.secondaryText }]}>
              {safeFormatDate(project.reviewAt, 'P')}
            </Text>
          ) : null}
        </TouchableOpacity>
      );
    }

    const canMarkReviewed = section.type === 'reviewDue' && Boolean(item.task.reviewAt);
    const canDeferTask = !canMarkReviewed && !item.task.dueDate && (item.task.isFocusedToday === true || item.task.status === 'next');
    // Passed by reference, not wrapped: both already take the task, and a fresh
    // arrow here would defeat the row's memo boundary (#766).
    const longPressAction = canMarkReviewed
      ? openReviewMenu
      : canDeferTask
        ? openDeferMenu
        : undefined;
    const longPressActionLabel = canMarkReviewed
      ? resolveText('review.markReviewed', 'Mark reviewed')
      : canDeferTask
        ? resolveText('review.startTime', 'Defer until')
        : undefined;
    const projectDeadlineLabel = getProjectDeadlineBoostLabel(
      projectDeadlineBoosts.get(item.task.id),
      resolveText,
    );

    return measureRow(
      <View
        style={[
          styles.itemWrapper,
          item.grouped ? [styles.contextGroupTaskWrapper, { borderLeftColor: tc.border }] : null,
        ]}
      >
        <SwipeableTaskItem
          task={item.task}
          isDark={isDark}
          tc={tc}
          actions={rowActions}
          isHighlighted={item.task.id === highlightTaskId}
          showFocusToggle
          // Every Upcoming row is deferred by construction, so the star could only
          // ever refuse — disabled with the reason beats a tap that just toasts.
          focusToggleDisabledLabel={section.type === 'upcoming' ? upcomingFocusBlockedLabel : undefined}
          showFocusHighlight={section.type !== 'focus'}
          hideStatusBadge={section.type !== 'reviewDue'}
          hideDetails={!showDetails}
          projectDeadlineLabel={projectDeadlineLabel}
          footerContent={section.type === 'upcoming' ? upcomingAppearsAtFooters.get(item.task.id) : undefined}
          onLongPressAction={longPressAction}
          onLongPressActionLabel={longPressActionLabel}
          onProjectPress={openProjectScreen}
          onContextPress={openContextsScreen}
          onTagPress={openContextsScreen}
        />
      </View>
    );
  };
  const getFocusReorderItemLayout = useCallback((_data: ArrayLike<Task> | null | undefined, index: number) => ({
    length: FOCUS_REORDER_ITEM_HEIGHT,
    offset: FOCUS_REORDER_ITEM_HEIGHT * index,
    index,
  }), []);
  const renderFocusReorderRow = useCallback(({
    item,
    drag,
    getIndex,
    isActive,
  }: RenderItemParams<Task>) => {
    const index = getIndex() ?? focusReorderData.findIndex((task) => task.id === item.id);
    const position = isActive && focusReorderPosition !== null ? focusReorderPosition : index;
    const secondaryLabel = getFocusReorderSecondaryLabel(item);
    const moveUpLabel = resolveText('projects.moveUp', 'Move up');
    const moveDownLabel = resolveText('projects.moveDown', 'Move down');
    const positionLabel = resolveText(
      'focus.reorderPosition',
      '{{title}}. Position {{position}} of {{count}}',
    )
      .replace('{{position}}', String(index + 1))
      .replace('{{count}}', String(focusReorderData.length))
      .replace('{{title}}', item.title);
    const reorderHint = resolveText('focus.reorderHint', 'Long press and drag to reorder');
    const accessibilityActions = [
      ...(index > 0 ? [{ name: 'moveUp', label: moveUpLabel }] : []),
      ...(index >= 0 && index < focusReorderData.length - 1
        ? [{ name: 'moveDown', label: moveDownLabel }]
        : []),
    ];

    return (
      <View style={[styles.reorderRow, { height: FOCUS_REORDER_ITEM_HEIGHT }]}>
        <ScaleDecorator activeScale={1.025}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={positionLabel}
            accessibilityHint={reorderHint}
            accessibilityActions={accessibilityActions}
            onAccessibilityAction={(event) => {
              if (event.nativeEvent.actionName === 'moveUp') moveFocusReorderTask(item.id, -1);
              if (event.nativeEvent.actionName === 'moveDown') moveFocusReorderTask(item.id, 1);
            }}
            activeOpacity={0.9}
            delayLongPress={180}
            onLongPress={drag}
            style={[
              styles.reorderCard,
              { backgroundColor: tc.cardBg, borderColor: tc.border },
              isActive && [
                styles.reorderCardActive,
                { backgroundColor: tc.filterBg, borderColor: tc.tint },
              ],
            ]}
            testID={`focus-reorder-row-${item.id}`}
          >
            <View style={styles.reorderTaskCopy}>
              <Text numberOfLines={1} style={[styles.reorderTaskTitle, { color: tc.text }]}>
                {item.title}
              </Text>
              {secondaryLabel ? (
                <Text numberOfLines={1} style={[styles.reorderTaskMeta, { color: tc.secondaryText }]}>
                  {secondaryLabel}
                </Text>
              ) : null}
            </View>
            {isActive && position >= 0 ? (
              <View style={[styles.reorderPositionBadge, { backgroundColor: tc.tint }]}>
                <Text style={[styles.reorderPositionText, { color: tc.onTint }]}>{position + 1}</Text>
              </View>
            ) : null}
            <View
              pointerEvents="none"
              style={styles.reorderHandle}
              testID={`focus-reorder-handle-${item.id}`}
            >
              <GripVertical size={20} color={isActive ? tc.tint : tc.secondaryText} />
            </View>
          </TouchableOpacity>
        </ScaleDecorator>
      </View>
    );
  }, [
    focusReorderData,
    focusReorderPosition,
    getFocusReorderSecondaryLabel,
    moveFocusReorderTask,
    resolveText,
    tc,
  ]);
  const listBottomPadding = FOCUS_LIST_BOTTOM_CLEARANCE + Math.max(0, insets.bottom);

  return (
    <View style={[styles.container, { backgroundColor: tc.bg }]}>
      {focusReorderMode ? (
        <View style={styles.reorderContainer}>
          <View style={[styles.reorderHeader, { borderBottomColor: tc.border }]}>
            <CompactText
              style={[styles.reorderTitle, { color: tc.text }]}
              numberOfLines={1}
            >
              {t('agenda.todaysFocus') ?? "Today's Focus"}
            </CompactText>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={resolveText('common.done', 'Done')}
              onPress={exitFocusReorder}
              style={[styles.reorderDoneButton, { backgroundColor: filledButton.backgroundColor, borderColor: filledButton.backgroundColor }]}
              testID="focus-reorder-done"
            >
              <Text style={[styles.reorderDoneText, { color: filledButton.textColor ?? tc.onTint }]}>
                {resolveText('common.done', 'Done')}
              </Text>
            </TouchableOpacity>
          </View>
          <DraggableFlatList
            testID="focus-reorder-list"
            data={focusReorderData}
            keyExtractor={(item) => item.id}
            renderItem={renderFocusReorderRow}
            onDragBegin={handleFocusReorderDragBegin}
            onDragEnd={handleFocusReorderDragEnd}
            onPlaceholderIndexChange={handleFocusReorderPlaceholderChange}
            getItemLayout={getFocusReorderItemLayout}
            activationDistance={2}
            autoscrollThreshold={80}
            autoscrollSpeed={120}
            dragItemOverflow
            keyboardShouldPersistTaps="handled"
            initialNumToRender={12}
            maxToRenderPerBatch={12}
            windowSize={7}
            removeClippedSubviews={false}
            containerStyle={styles.reorderListFill}
            style={styles.reorderListFill}
            contentContainerStyle={[styles.reorderListContent, { paddingBottom: listBottomPadding }]}
            ListFooterComponent={showFocusReorderHint ? (
              <Text style={[styles.reorderHint, { color: tc.secondaryText }]}>
                {resolveText('focus.reorderHint', 'Long press and drag to reorder')}
              </Text>
            ) : null}
          />
        </View>
      ) : (
      <SectionList
        sections={hasTasks ? sections : []}
        extraData={focusListVersion}
        keyExtractor={(item) => item.type === 'task' ? item.task.id : item.type === 'project' ? `project:${item.project.id}` : item.id}
        stickySectionHeadersEnabled={false}
        getItemLayout={getFocusItemLayout}
        initialNumToRender={FOCUS_LIST_INITIAL_RENDER_COUNT}
        maxToRenderPerBatch={FOCUS_LIST_BATCH_RENDER_COUNT}
        windowSize={FOCUS_LIST_WINDOW_SIZE}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: listBottomPadding },
        ]}
        scrollIndicatorInsets={{ bottom: listBottomPadding }}
        refreshControl={(
          <RefreshControl
            refreshing={pullSync.refreshing}
            onRefresh={pullSync.onRefresh}
            tintColor="transparent"
            colors={['transparent']}
            progressBackgroundColor="transparent"
          />
        )}
        ListHeaderComponent={(
          <View
            onLayout={(event) => registerFocusItemHeight(
              FOCUS_LIST_HEADER_LAYOUT_KEY,
              event.nativeEvent.layout.height,
            )}
          >
          <View style={styles.header}>
            {pomodoroEnabled && (
              <PomodoroPanel
                tasks={pomodoroTasks}
                onMarkDone={(id) => updateTask(id, { status: 'done', isFocusedToday: false })}
              />
            )}
            <View style={styles.headerTopRow}>
              <View style={styles.headerTextBlock}>
                <Text style={[styles.dateText, { color: tc.secondaryText }]}>
                  {safeFormatDate(new Date(), 'PPPP')}
                </Text>
              </View>
              <View style={styles.headerActions}>
                <Pressable
                  accessibilityLabel={showDetails
                    ? resolveText('list.hideDetails', 'Hide details')
                    : resolveText('list.showDetails', 'Show details')}
                  accessibilityRole="button"
                  onPress={toggleShowDetails}
                  style={({ pressed }) => [
                    styles.filterButton,
                    {
                      opacity: pressed ? 0.78 : 1,
                    },
                  ]}
                >
                  <List size={20} color={showDetails ? tc.tint : tc.secondaryText} />
                </Pressable>
                <Pressable
                  accessibilityLabel={resolveText('filters.label', 'Filters')}
                  accessibilityRole="button"
                  onPress={() => setFiltersVisible(true)}
                  style={({ pressed }) => [
                    styles.filterButton,
                    {
                      opacity: pressed ? 0.78 : 1,
                    },
                  ]}
                >
                  <SlidersHorizontal size={20} color={hasFilters ? tc.tint : tc.secondaryText} />
                  {hasFilters ? (
                    <View style={[styles.filterBadge, { backgroundColor: tc.tint }]}>
                      <Text style={[styles.filterBadgeText, { color: tc.onTint }]}>
                        {activeFilterCount}
                      </Text>
                    </View>
                  ) : null}
                </Pressable>
              </View>
            </View>
            {savedFocusFilters.length > 0 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.savedFiltersRow}
                style={styles.savedFiltersScroller}
              >
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityState={{ selected: isDefaultPerspective }}
                  onPress={clearFilters}
                  style={[
                    styles.savedFilterChip,
                    {
                      borderColor: isDefaultPerspective ? tc.tint : tc.border,
                      backgroundColor: isDefaultPerspective ? tc.tint : tc.filterBg,
                    },
                  ]}
                >
                  <Text style={[styles.savedFilterChipText, { color: isDefaultPerspective ? tc.onTint : tc.text }]}>
                    {resolveText('common.all', 'All')}
                  </Text>
                </TouchableOpacity>
                {savedFocusFilters.map((filter) => {
                  const selected = selections.activeSavedFilterId === filter.id;
                  return (
                    <View key={filter.id} style={styles.savedFilterChipGroup}>
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        onPress={() => applySavedFocusFilter(filter)}
                        style={[
                          styles.savedFilterChip,
                          selected ? styles.savedFilterChipAttached : null,
                          {
                            borderColor: selected ? tc.tint : tc.border,
                            backgroundColor: selected ? tc.tint : tc.filterBg,
                          },
                        ]}
                      >
                        <CompactText
                          style={[styles.savedFilterChipText, { color: selected ? tc.onTint : tc.text }]}
                          numberOfLines={2}
                        >
                          {filter.icon ? `${filter.icon} ` : ''}{filter.name}
                        </CompactText>
                      </TouchableOpacity>
                      {selected ? (
                        <TouchableOpacity
                          accessibilityRole="button"
                          accessibilityLabel={`${resolveText('common.delete', 'Delete')} ${resolveText('savedFilters.label', 'saved filter')} ${filter.name}`}
                          onPress={() => confirmDeleteSavedFilter(filter)}
                          style={[
                            styles.savedFilterDeleteChip,
                            { borderColor: tc.tint, backgroundColor: tc.tint },
                          ]}
                        >
                          <X size={14} color={tc.onTint} />
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  );
                })}
              </ScrollView>
            ) : null}
            {hasFilters ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.activeChipsRow}
                style={styles.activeChipsScroller}
              >
                {activeFilterChips.map((chip) => renderFilterChip(chip.label, true, chip.onPress, chip.id, chip.variant))}
                <TouchableOpacity onPress={clearFilters} style={styles.clearFiltersButton}>
                  <Text style={[styles.clearFiltersText, { color: tc.secondaryText }]}>
                    {resolveText('filters.clear', 'Clear')}
                  </Text>
                </TouchableOpacity>
              </ScrollView>
            ) : null}
          </View>
          </View>
        )}
        renderSectionHeader={({ section }) => (
          section.totalCount > 0 ? (
            <View
              onLayout={(event) => registerFocusItemHeight(
                focusSectionHeaderLayoutKey(section, section.type === firstVisibleSectionType),
                event.nativeEvent.layout.height,
              )}
            >
            <View style={styles.sectionHeaderRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={section.title}
              accessibilityState={{ expanded: section.expanded }}
              onPress={() => toggleSection(section.type)}
              style={[
                styles.sectionHeader,
                styles.sectionHeaderPressable,
                section.type === firstVisibleSectionType ? styles.firstSectionHeader : null,
              ]}
            >
              <Text style={[styles.sectionChevron, { color: tc.secondaryText }]}>
                {section.expanded ? '▾' : '▸'}
              </Text>
              <CompactText
                style={[styles.sectionTitle, { color: tc.secondaryText }]}
                numberOfLines={2}
              >
                {section.title}
              </CompactText>
              <CompactText
                style={[styles.sectionCount, { color: tc.secondaryText }]}
              >
                ({section.totalCount})
              </CompactText>
            </Pressable>
            {section.type === 'focus' && canReorderFocus ? (
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={resolveText('projects.reorderTasks', 'Reorder')}
                accessibilityHint="Opens a focused screen for reordering these tasks"
                onPress={enterFocusReorder}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                activeOpacity={0.65}
                style={styles.focusReorderToggle}
                testID="focus-reorder-toggle"
              >
                <GripVertical size={15} color={tc.secondaryText} />
                <CompactText style={[styles.focusReorderToggleText, { color: tc.secondaryText }]} numberOfLines={1}>
                  {resolveText('projects.reorderTasks', 'Reorder')}
                </CompactText>
              </TouchableOpacity>
            ) : null}
            </View>
            </View>
          ) : null
        )}
        renderItem={renderItem}
        ListEmptyComponent={!hasTasks ? (
          <View style={styles.emptyState}>
            <CompactText
              style={[styles.emptyTitle, { color: tc.text }]}
              numberOfLines={2}
            >
              {emptyTitle}
            </CompactText>
            <CompactText
              style={[styles.emptySubtitle, { color: tc.secondaryText }]}
              numberOfLines={3}
            >
              {emptySubtitle}
            </CompactText>
          </View>
        ) : null}
        removeClippedSubviews={false}
      />
      )}
      <PullSyncIndicator state={pullSync.indicatorState} />
      <TaskFilterSheet
        visible={filtersVisible}
        onClose={() => {
          if (saveFilterDialogVisible) {
            setSaveFilterDialogVisible(false);
            return;
          }
          setFiltersVisible(false);
        }}
        selections={selections}
        options={{
          tokens: tokenOptions,
          projects: projectFilterOptions,
          timeEstimates: effectiveTimeEstimatePresets,
          visibility: metadataFilterVisibility,
        }}
        themeColors={tc}
        t={t}
        headerActions={canSaveFocusPerspective ? (
          <TouchableOpacity
            accessibilityRole="button"
            onPress={openSaveFilterDialog}
            style={styles.sheetSaveButton}
          >
            <BookmarkPlus size={16} color={tc.tint} />
            <Text style={[styles.sheetTextButtonText, { color: tc.tint }]}>
              {resolveText('savedFilters.save', 'Save')}
            </Text>
          </TouchableOpacity>
        ) : null}
        topContent={(
          <>
            <Text style={[styles.sheetSectionLabel, { color: tc.secondaryText }]}>
              {resolveText('sort.label', 'Sort')}
            </Text>
            <View style={styles.sheetChipRow}>
              {FOCUS_SORT_OPTIONS.map((sortBy) => renderFilterChip(
                getFocusSortByLabel(sortBy),
                effectiveFocusSortBy === sortBy,
                () => updateFocusSortBy(sortBy),
                `sort:${sortBy}`,
              ))}
            </View>

            <Text style={[styles.sheetSectionLabel, { color: tc.secondaryText }]}>
              {resolveText('focus.groupBy', 'Group by')}
            </Text>
            <View style={styles.sheetChipRow}>
              {FOCUS_GROUP_BY_OPTIONS.map((groupBy) => renderFilterChip(
                getFocusGroupByLabel(groupBy),
                effectiveFocusGroupBy === groupBy,
                () => updateFocusGroupBy(groupBy),
                `group:${groupBy}`,
              ))}
            </View>

            {activeFilterChips.length > 0 ? (
              <>
                <Text style={[styles.sheetSectionLabel, { color: tc.secondaryText }]}>
                  {resolveText('filters.active', 'Active filters')}
                </Text>
                <View style={styles.sheetChipRow}>
                  {activeFilterChips.map((chip) => renderFilterChip(chip.label, true, chip.onPress, chip.id, chip.variant))}
                </View>
              </>
            ) : null}
          </>
        )}
        overlay={saveFilterDialogVisible ? (
          <View style={saveFilterKeyboardInset > 0
            ? [styles.dialogRoot, { paddingBottom: saveFilterKeyboardInset }]
            : styles.dialogRoot}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={resolveText('common.cancel', 'Cancel')}
              onPress={() => setSaveFilterDialogVisible(false)}
              style={styles.sheetBackdrop}
            />
            <View style={[styles.dialog, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
              <Text style={[styles.dialogTitle, { color: tc.text }]}>
                {resolveText('savedFilters.saveTitle', 'Save filter')}
              </Text>
              <TextInput
                autoFocus
                value={saveFilterName}
                onChangeText={setSaveFilterName}
                placeholder={resolveText('savedFilters.namePlaceholder', 'Filter name')}
                placeholderTextColor={tc.secondaryText}
                style={[styles.dialogInput, { borderColor: tc.border, color: tc.text, backgroundColor: tc.bg }]}
                returnKeyType="done"
                onSubmitEditing={saveCurrentFilter}
              />
              <View style={styles.dialogActions}>
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={() => setSaveFilterDialogVisible(false)}
                  style={styles.dialogButton}
                >
                  <Text style={[styles.dialogButtonText, { color: tc.secondaryText }]}>
                    {resolveText('common.cancel', 'Cancel')}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={saveCurrentFilter}
                  disabled={!saveFilterName.trim()}
                  style={[
                    styles.dialogButton,
                    styles.dialogPrimaryButton,
                    { backgroundColor: saveFilterName.trim() ? filledButton.backgroundColor : tc.filterBg },
                  ]}
                >
                  <Text style={[styles.dialogButtonText, { color: saveFilterName.trim() ? (filledButton.textColor ?? tc.onTint) : tc.secondaryText }]}>
                    {resolveText('common.save', 'Save')}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        ) : undefined}
      />
      {deferPickerTask && Platform.OS === 'ios' ? (
        <Modal
          animationType="fade"
          transparent
          visible
          onRequestClose={closeDeferDatePicker}
        >
          <View style={styles.sheetRoot}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={resolveText('common.cancel', 'Cancel')}
              onPress={closeDeferDatePicker}
              style={styles.sheetBackdrop}
            />
            <View style={[styles.sheet, styles.deferPickerSheet, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
              <View style={styles.sheetHeader}>
                <Text style={[styles.sheetTitle, { color: tc.text }]}>
                  {resolveText('review.startTime', 'Defer until')}
                </Text>
                <View style={styles.sheetHeaderActions}>
                  <TouchableOpacity
                    accessibilityRole="button"
                    onPress={closeDeferDatePicker}
                    style={styles.sheetTextButton}
                  >
                    <Text style={[styles.sheetTextButtonText, { color: tc.secondaryText }]}>
                      {resolveText('common.cancel', 'Cancel')}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    accessibilityRole="button"
                    onPress={confirmPickedDeferDate}
                    style={styles.sheetTextButton}
                  >
                    <Text style={[styles.sheetTextButtonText, { color: tc.tint }]}>
                      {resolveText('common.done', 'Done')}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
              <Text
                numberOfLines={1}
                style={[styles.deferPickerTaskTitle, { color: tc.secondaryText }]}
              >
                {deferPickerTask.title}
              </Text>
              {/* No minimumDate here: on iOS 26 the inline picker's
                  UICalendarView asserts (SIGABRT) when setMinimumDate: replays
                  an animated visible-month update during a Fabric mount
                  transaction. handleDeferDateChange clamps to the same floor
                  instead. */}
              <DateTimePicker
                value={deferPickerDate}
                mode="date"
                display="inline"
                onChange={handleDeferDateChange}
              />
            </View>
          </View>
        </Modal>
      ) : null}
      {deferPickerTask && Platform.OS !== 'ios' ? (
        <DateTimePicker
          value={deferPickerDate}
          mode="date"
          display="default"
          minimumDate={getStartDateOffset(1)}
          onChange={handleDeferDateChange}
        />
      ) : null}
      <TaskEditModal
        key={taskModalOpenKey}
        visible={isModalVisible}
        task={editingTask}
        onClose={() => setIsModalVisible(false)}
        onSave={onSaveTask}
        defaultTab={taskModalDefaultTab}
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
    marginTop: 6,
    marginBottom: 0,
  },
  headerTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  headerTextBlock: {
    flex: 1,
    minWidth: 0,
  },
  subtitleText: {
    marginTop: 2,
    fontSize: 13,
    lineHeight: 18,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  savedFiltersScroller: {
    marginTop: 10,
    marginHorizontal: -4,
  },
  savedFiltersRow: {
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 4,
  },
  savedFilterChipGroup: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  savedFilterChip: {
    maxWidth: 180,
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 22,
    paddingHorizontal: 12,
    paddingVertical: 10,
    justifyContent: 'center',
  },
  savedFilterChipAttached: {
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,
  },
  savedFilterChipText: {
    fontSize: 12,
    fontWeight: '700',
  },
  savedFilterDeleteChip: {
    width: 44,
    height: 44,
    borderWidth: 1,
    borderLeftWidth: 0,
    borderTopRightRadius: 22,
    borderBottomRightRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
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
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  filterBadge: {
    position: 'absolute',
    top: 5,
    right: 5,
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
  clearFiltersButton: {
    justifyContent: 'center',
    paddingHorizontal: 8,
    minHeight: 44,
  },
  clearFiltersText: {
    fontSize: 12,
    fontWeight: '600',
  },
  dateText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sectionHeaderPressable: {
    flex: 1,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 18,
    marginBottom: 10,
  },
  firstSectionHeader: {
    marginTop: 8,
  },
  focusReorderToggle: {
    minHeight: 36,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 6,
  },
  focusReorderToggleText: {
    fontSize: 11,
    fontWeight: '700',
  },
  reorderContainer: {
    flex: 1,
  },
  reorderHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  reorderTitle: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  reorderDoneButton: {
    minHeight: 40,
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 18,
    justifyContent: 'center',
  },
  reorderDoneText: {
    fontSize: 14,
    fontWeight: '700',
  },
  reorderListFill: {
    flex: 1,
  },
  reorderListContent: {
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  reorderRow: {
    paddingVertical: 4,
  },
  reorderCard: {
    flex: 1,
    alignSelf: 'stretch',
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingLeft: 14,
    overflow: 'hidden',
    minHeight: 68,
  },
  reorderCardActive: {
    opacity: 0.98,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.14,
    shadowRadius: 4,
    elevation: 4,
  },
  reorderTaskTitle: {
    fontSize: 15,
    fontWeight: '600',
    lineHeight: 20,
  },
  reorderTaskCopy: {
    flex: 1,
    minWidth: 0,
    gap: 2,
    paddingVertical: 10,
  },
  reorderTaskMeta: {
    fontSize: 12,
    lineHeight: 16,
  },
  reorderPositionBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reorderPositionText: {
    fontSize: 12,
    fontWeight: '700',
  },
  reorderHandle: {
    width: 40,
    alignSelf: 'stretch',
    minHeight: 68,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reorderHint: {
    paddingTop: 16,
    paddingHorizontal: 24,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    flexShrink: 1,
    minWidth: 0,
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
  contextGroupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
    marginBottom: 6,
    paddingHorizontal: 4,
    paddingTop: 4,
  },
  contextGroupDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  contextGroupTitle: {
    flexShrink: 1,
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  contextGroupCount: {
    fontSize: 12,
    fontWeight: '700',
  },
  contextGroupTaskWrapper: {
    marginLeft: 13,
    paddingLeft: 10,
    borderLeftWidth: 2,
  },
  itemWrapper: {
    marginBottom: 8,
  },
  upcomingAppearsAt: {
    marginTop: 4,
    fontSize: 12,
    fontWeight: '600',
  },
  projectReviewCard: {
    minHeight: 72,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  projectReviewMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  projectReviewIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  projectReviewTextBlock: {
    flex: 1,
    minWidth: 0,
  },
  projectReviewTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  projectReviewStatus: {
    marginTop: 2,
    fontSize: 12,
    fontWeight: '600',
  },
  projectReviewDate: {
    flexShrink: 0,
    fontSize: 12,
    fontWeight: '700',
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
  deferPickerSheet: {
    maxHeight: '70%',
  },
  deferPickerTaskTitle: {
    marginBottom: 8,
    fontSize: 13,
    fontWeight: '600',
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
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  sheetSaveButton: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  sheetTextButtonText: {
    fontSize: 13,
    fontWeight: '600',
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
  dialogRoot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  dialog: {
    width: '100%',
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
  },
  dialogTitle: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 12,
  },
  dialogInput: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 15,
  },
  dialogActions: {
    marginTop: 14,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
  },
  dialogButton: {
    minHeight: 44,
    minWidth: 72,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    paddingHorizontal: 12,
  },
  dialogPrimaryButton: {
    paddingHorizontal: 14,
  },
  dialogButtonText: {
    fontSize: 14,
    fontWeight: '700',
  },
});
