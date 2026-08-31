import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
    DndContext,
    DragOverlay,
    KeyboardSensor,
    PointerSensor,
    closestCenter,
    useSensor,
    useSensors,
    type DragEndEvent,
    type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { ErrorBoundary } from '../ErrorBoundary';
import { shallow, useTaskStore, TaskPriority, TimeEstimate, applyFilter, buildAdvancedFilterCriteriaChips, compareProjectsByOrder, removeAdvancedFilterCriteriaChip, formatFocusTaskLimitText,
    getFocusStarBlockedText, formatTimeEstimateLabel, generateUUID, getUsedTaskTokens, getFocusSequentialFirstTaskIds, getProjectDeadlineBoosts, getProjectDeadlineBoostLabel, getTaskMetadataFilterVisibility, markSavedFilterDeleted, normalizeFocusTaskLimit, resolveFeatureFlags, resolveTaskGroupByForFeatures, resolveTaskSortByForFeatures, safeFormatDate, safeParseDate, safeParseDueDate, isDueForReview, SAVED_FILTER_NO_PROJECT_ID, getUpcomingDeferredTasks, shouldShowTaskForStart, sortFocusNextActions, sortTasksByFocusOrder, sortTasksBySavedPreference, translateWithFallback, tFallback } from '@mindwtr/core';
import type { MultiValueFilterMatchMode, ProjectDeadlineBoost, SavedFilter, SortField, Task, TaskEnergyLevel } from '@mindwtr/core';
import { useTaskFilterSelections } from '@mindwtr/core/task-filter-selections';
import { useLanguage } from '../../contexts/language-context';
import { cn } from '../../lib/utils';
import { useUiStore } from '../../store/ui-store';
import { AlertCircle, CalendarDays, Clock, ArrowRight, Folder, CheckCircle2, X } from 'lucide-react';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import { checkBudget } from '../../config/performanceBudgets';
import { isTaskVisibleInArea, projectMatchesAreaFilterSelection } from '@mindwtr/core';
import { useAreaVisibility } from '../../hooks/useVisibleTaskContext';
import { usePersistedViewState } from '../../hooks/usePersistedViewState';
import { PomodoroPanel } from './PomodoroPanel';
import { AgendaFiltersPanel, type AgendaActiveFilterChip, type AgendaProjectFilterOption } from './agenda/AgendaFiltersPanel';
import { AgendaHeader } from './agenda/AgendaHeader';
import { AgendaCollapsibleSection, AgendaProjectSection } from './agenda/AgendaSections';
import { SortableFocusRow } from './agenda/SortableFocusRow';
import { StoreTaskItem } from './list/StoreTaskItem';
import { GroupedTaskSectionHeader } from './list/GroupedTaskSections';
import { useTaskGroupCollapse } from './list/useTaskGroupCollapse';
import { LIST_END_GAP } from './list/list-toolbar';
import { focusTaskRowWhenMounted, useTaskListScope } from './list/task-list-scope';
import {
    emptyCollapsedGroups,
    FOCUS_AXES,
    groupTasks,
    sanitizeAxis,
    sanitizeCollapsedGroups,
    type CollapsedGroups,
    type NextGroupBy,
} from './list/next-grouping';
import { PromptModal } from '../PromptModal';
import { dispatchNavigateEvent } from '../../lib/navigation-events';
import { FocusStarIcon } from '../FocusStarIcon';
import { useFutureStartRevealTick, useLocalDayKey } from '../../hooks/useLocalDayKey';

const AGENDA_VIRTUALIZATION_THRESHOLD = 25;
const NO_PROJECT_FILTER_ID = SAVED_FILTER_NO_PROJECT_ID;
const AGENDA_ACTIVE_STATUSES: Task['status'][] = ['inbox', 'next', 'waiting', 'someday'];
const DEFAULT_FOCUS_SORT_BY: SortField = 'default';
const FOCUS_VIEW_STATE_STORAGE_KEY = 'mindwtr:view:focus:v1';

type FocusSectionKey = 'schedule' | 'nextActions' | 'upcoming' | 'reviewDue';
type SetFocusCollapsedGroups = (
    updater: (current: CollapsedGroups<NextGroupBy>) => CollapsedGroups<NextGroupBy>,
) => void;

type FocusPersistedViewState = {
    expandedSections: Record<FocusSectionKey, boolean>;
    collapsedGroups: CollapsedGroups<NextGroupBy>;
};

const DEFAULT_FOCUS_VIEW_STATE: FocusPersistedViewState = {
    expandedSections: {
        schedule: true,
        nextActions: true,
        upcoming: true,
        reviewDue: true,
    },
    collapsedGroups: emptyCollapsedGroups(FOCUS_AXES),
};

function sanitizeFocusViewState(value: unknown, fallback: FocusPersistedViewState): FocusPersistedViewState {
    const parsed = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Partial<FocusPersistedViewState>
        : {};
    const expandedSections = parsed.expandedSections && typeof parsed.expandedSections === 'object' && !Array.isArray(parsed.expandedSections)
        ? parsed.expandedSections as Partial<Record<FocusSectionKey, boolean>>
        : {};
    return {
        expandedSections: {
            schedule: typeof expandedSections.schedule === 'boolean' ? expandedSections.schedule : fallback.expandedSections.schedule,
            nextActions: typeof expandedSections.nextActions === 'boolean' ? expandedSections.nextActions : fallback.expandedSections.nextActions,
            upcoming: typeof expandedSections.upcoming === 'boolean' ? expandedSections.upcoming : fallback.expandedSections.upcoming,
            reviewDue: typeof expandedSections.reviewDue === 'boolean' ? expandedSections.reviewDue : fallback.expandedSections.reviewDue,
        },
        collapsedGroups: sanitizeCollapsedGroups(FOCUS_AXES, parsed.collapsedGroups, fallback.collapsedGroups),
    };
}

function normalizeAgendaGroupBy(value: unknown): NextGroupBy {
    return sanitizeAxis(FOCUS_AXES, value, 'none');
}

function getAgendaScrollElement(containerElement: HTMLDivElement | null): HTMLElement | null {
    if (containerElement) {
        const closestMainContent = containerElement.closest<HTMLElement>('[data-main-content]');
        if (closestMainContent) return closestMainContent;
    }
    if (typeof document === 'undefined') return null;
    return document.querySelector<HTMLElement>('[data-main-content]');
}

function getAgendaScrollMargin(containerElement: HTMLDivElement, scrollElement: HTMLElement) {
    const containerRect = containerElement.getBoundingClientRect();
    const scrollRect = scrollElement.getBoundingClientRect();
    return containerRect.top - scrollRect.top + scrollElement.scrollTop;
}

function getSavedFilterDefaultName(chips: AgendaActiveFilterChip[], fallback: string): string {
    const label = chips.slice(0, 3).map((chip) => chip.label).join(' + ');
    return label || fallback;
}

function AgendaTaskList({
    tasks,
    buildFocusToggle,
    getAppearsAtLabel,
    getProjectDeadlineLabel,
    showListDetails,
    highlightTaskId,
}: {
    tasks: Task[];
    buildFocusToggle: (task: Task) => {
        isFocused: boolean;
        canToggle: boolean;
        onToggle: () => void;
        title: string;
        ariaLabel: string;
        alwaysVisible?: boolean;
    };
    getAppearsAtLabel?: (taskId: string) => string | undefined;
    getProjectDeadlineLabel?: (taskId: string) => string | undefined;
    showListDetails: boolean;
    highlightTaskId: string | null;
}) {
    const [containerElement, setContainerElement] = useState<HTMLDivElement | null>(null);
    const [scrollMargin, setScrollMargin] = useState(0);
    // Desktop views scroll inside the shared main content pane, not the window.
    const scrollElement = getAgendaScrollElement(containerElement);
    const shouldVirtualize = Boolean(scrollElement) && !highlightTaskId && tasks.length > AGENDA_VIRTUALIZATION_THRESHOLD;
    const rowVirtualizer = useVirtualizer({
        count: shouldVirtualize ? tasks.length : 0,
        getScrollElement: () => scrollElement,
        estimateSize: () => (showListDetails ? 96 : 82),
        overscan: 4,
        scrollMargin,
        getItemKey: (index) => tasks[index]?.id ?? index,
    });

    const updateScrollMargin = useCallback(() => {
        if (!containerElement || !scrollElement) return;
        const nextScrollMargin = getAgendaScrollMargin(containerElement, scrollElement);
        setScrollMargin((current) => (Math.abs(current - nextScrollMargin) < 1 ? current : nextScrollMargin));
    }, [containerElement, scrollElement]);

    useLayoutEffect(() => {
        updateScrollMargin();
    });

    useEffect(() => {
        if (!containerElement || !scrollElement || typeof window === 'undefined') return;
        window.addEventListener('resize', updateScrollMargin);
        const resizeObserver = typeof ResizeObserver === 'function'
            ? new ResizeObserver(() => updateScrollMargin())
            : null;
        resizeObserver?.observe(containerElement);
        resizeObserver?.observe(scrollElement);
        return () => {
            window.removeEventListener('resize', updateScrollMargin);
            resizeObserver?.disconnect();
        };
    }, [containerElement, scrollElement, updateScrollMargin]);

    if (!shouldVirtualize) {
        return (
            <div className="divide-y divide-border/30">
                {tasks.map((task) => (
                    <StoreTaskItem
                        key={task.id}
                        taskId={task.id}
                        buildFocusToggle={buildFocusToggle}
                        showProjectBadgeInActions={false}
                        compactMetaEnabled={showListDetails}
                        enableDoubleClickEdit
                        appearsAtLabel={getAppearsAtLabel?.(task.id)}
                        projectDeadlineLabel={getProjectDeadlineLabel?.(task.id)}
                    />
                ))}
            </div>
        );
    }

    const virtualRows = rowVirtualizer.getVirtualItems();
    return (
        <div
            ref={setContainerElement}
            className="relative"
            style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
        >
            {virtualRows.map((virtualRow) => {
                const task = tasks[virtualRow.index];
                if (!task) return null;
                const isLast = virtualRow.index === tasks.length - 1;
                return (
                    <div
                        key={virtualRow.key}
                        ref={rowVirtualizer.measureElement}
                        data-index={virtualRow.index}
                        className={cn(!isLast && 'border-b border-border/30')}
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            transform: `translateY(${virtualRow.start - scrollMargin}px)`,
                        }}
                    >
                        <StoreTaskItem
                            taskId={task.id}
                            buildFocusToggle={buildFocusToggle}
                            showProjectBadgeInActions={false}
                            compactMetaEnabled={showListDetails}
                            enableDoubleClickEdit
                            appearsAtLabel={getAppearsAtLabel?.(task.id)}
                            projectDeadlineLabel={getProjectDeadlineLabel?.(task.id)}
                        />
                    </div>
                );
            })}
        </div>
    );
}

export function AgendaView() {
    const perf = usePerformanceMonitor('AgendaView');
    const { projects, areas, updateTask, updateSettings, reorderFocusedTasks, settings, error, highlightTaskId, setHighlightTask, taskChangeToken, hasAnyTasks } = useTaskStore(
        (state) => ({
            projects: state.projects,
            areas: state.areas,
            updateTask: state.updateTask,
            updateSettings: state.updateSettings,
            reorderFocusedTasks: state.reorderFocusedTasks,
            settings: state.settings,
            error: state.error,
            highlightTaskId: state.highlightTaskId,
            setHighlightTask: state.setHighlightTask,
            taskChangeToken: state.lastDataChangeAt,
            hasAnyTasks: state.tasks.length > 0,
        }),
        shallow
    );
    const getDerivedState = useTaskStore((state) => state.getDerivedState);
    const {
        activeTasksByStatus,
        focusedCount,
        projectMap,
        sequentialProjectIds,
        sequentialWithinSectionProjectIds,
        tasksById,
    } = getDerivedState();
    const { t } = useLanguage();
    const { requestConfirmation, confirmModal } = useConfirmDialog();
    const localDayKey = useLocalDayKey();
    const { showListDetails, focusGroupBy, top3Only, setListOptions, collapseAllTaskDetails, setProjectView, showToast } = useUiStore((state) => ({
        showListDetails: state.listOptions.showDetails,
        focusGroupBy: state.listOptions.focusGroupBy,
        top3Only: state.listOptions.focusTop3Only,
        setListOptions: state.setListOptions,
        collapseAllTaskDetails: state.collapseAllTaskDetails,
        setProjectView: state.setProjectView,
        showToast: state.showToast,
    }));
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [focusSortBy, setFocusSortBy] = useState<SortField>(DEFAULT_FOCUS_SORT_BY);
    const resetFocusSort = useCallback(() => setFocusSortBy(DEFAULT_FOCUS_SORT_BY), []);
    const [saveFilterPromptOpen, setSaveFilterPromptOpen] = useState(false);
    const filterInputRef = useRef<HTMLInputElement | null>(null);
    const [persistedViewState, setPersistedViewState] = usePersistedViewState(
        FOCUS_VIEW_STATE_STORAGE_KEY,
        DEFAULT_FOCUS_VIEW_STATE,
        sanitizeFocusViewState
    );
    const expandedSections = persistedViewState.expandedSections;
    const {
        priorities: prioritiesEnabled,
        timeEstimates: timeEstimatesEnabled,
        pomodoro: pomodoroEnabled,
    } = resolveFeatureFlags(settings);
    const focusTaskLimit = normalizeFocusTaskLimit(settings?.gtd?.focusTaskLimit);
    const { areaById, resolvedAreaFilter } = useAreaVisibility();
    // The derived `projectMap` on purpose, not the hook's: Focus reads the
    // tombstone-aware map so a task under a just-deleted project resolves the
    // same way here as it does in the store's own derived state.
    const visibility = useMemo(
        () => ({ areaById, projectById: projectMap, resolvedAreaFilter }),
        [areaById, projectMap, resolvedAreaFilter],
    );

    useEffect(() => {
        if (!perf.enabled) return;
        const timer = window.setTimeout(() => {
            checkBudget('AgendaView', perf.metrics, 'complex');
        }, 0);
        return () => window.clearTimeout(timer);
    }, [perf.enabled]);

    const derivedActiveTasks = useMemo(() => (
        AGENDA_ACTIVE_STATUSES.flatMap((status) => activeTasksByStatus.get(status) ?? [])
    ), [activeTasksByStatus, taskChangeToken]);

    // Filter active tasks
    const baseActiveTasks = useMemo(() => (
        derivedActiveTasks.filter((t) => isTaskVisibleInArea(t, visibility))
    ), [derivedActiveTasks, visibility]);

    const futureStartTick = useFutureStartRevealTick(baseActiveTasks);
    const { activeTasks, allTokens } = useMemo(() => {
        void localDayKey;
        void futureStartTick;
        const now = new Date();
        const active = baseActiveTasks.filter((task) => shouldShowTaskForStart(task, { now, granularity: 'time' }));
        return {
            activeTasks: active,
            allTokens: getUsedTaskTokens(active, (task) => [...(task.contexts || []), ...(task.tags || [])]),
        };
    }, [baseActiveTasks, localDayKey, futureStartTick]);
    const priorityOptions: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
    const energyLevelOptions: TaskEnergyLevel[] = ['low', 'medium', 'high'];
    const timeEstimateOptions: TimeEstimate[] = ['5min', '10min', '15min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+'];
    const metadataFilterVisibility = useMemo(() => getTaskMetadataFilterVisibility(activeTasks, {
        prioritiesEnabled,
        timeEstimatesEnabled,
    }), [activeTasks, prioritiesEnabled, timeEstimatesEnabled]);
    const showPriorityFilters = metadataFilterVisibility.priority;
    const showEnergyLevelFilters = metadataFilterVisibility.energyLevel;
    const showTimeEstimateFilters = metadataFilterVisibility.timeEstimate;
    const showLocationFilter = metadataFilterVisibility.location;
    const projectOptions = useMemo<AgendaProjectFilterOption[]>(() => {
        const activeProjectIds = new Set(
            activeTasks
                .map((task) => task.projectId)
                .filter((projectId): projectId is string => Boolean(projectId))
        );
        return [...projects]
            .filter((project) => !project.deletedAt && project.status !== 'archived' && activeProjectIds.has(project.id))
            .sort(compareProjectsByOrder)
            .map((project) => ({
                id: project.id,
                title: project.title,
                dotColor: (project.areaId ? areaById.get(project.areaId)?.color : undefined) || project.color || undefined,
            }));
    }, [activeTasks, areaById, projects]);
    const showNoProjectOption = activeTasks.some((task) => !task.projectId);
    const formatEstimate = (value: TimeEstimate) => formatTimeEstimateLabel(value, { t });
    const savedFocusFilters = (settings?.savedFilters ?? []).filter((filter) => filter.view === 'focus' && !filter.deletedAt);
    const filterSelections = useTaskFilterSelections({
        view: 'focus',
        t,
        visibility: metadataFilterVisibility,
        savedFilters: savedFocusFilters,
        onClear: resetFocusSort,
    });
    const {
        activeSavedFilter,
        activeSavedFilterId,
        applySaved: applySavedSelections,
        clear: clearAllFilters,
        criteria: effectiveFilterCriteria,
        currentCriteria: currentFilterCriteria,
        energyLevels: selectedEnergyLevels,
        excludedTokens,
        hasActive: hasTaskFilters,
        hasCurrentCriteria: hasCurrentFilterCriteria,
        locationQuery: locationFilter,
        priorities: selectedPriorities,
        projects: selectedProjects,
        searchQuery,
        setLocation: updateLocationFilter,
        setMatchMode,
        setSearchQuery,
        timeEstimates: selectedTimeEstimates,
        toggleEnergyLevel: toggleEnergyFilter,
        togglePriority: togglePriorityFilter,
        toggleProject: toggleProjectFilter,
        toggleTimeEstimate: toggleTimeFilter,
        toggleToken: toggleTokenFilter,
        tokens: selectedTokens,
        unbindSaved: unbindSavedFilter,
    } = filterSelections;
    const activePriorities = showPriorityFilters ? selectedPriorities : [];
    const activeTimeEstimates = showTimeEstimateFilters ? selectedTimeEstimates : [];
    // A saved or stored 'priority' sort/group stops taking effect while
    // Priorities is off (the preference survives for re-enable) — otherwise
    // Focus would keep ordering and bucketing by a field hidden everywhere
    // else in the UI.
    const effectiveFocusSortBy = resolveTaskSortByForFeatures(activeSavedFilter?.sortBy ?? focusSortBy, settings);
    const effectiveNextGroupBy = resolveTaskGroupByForFeatures(
        normalizeAgendaGroupBy(activeSavedFilter?.groupBy ?? focusGroupBy),
        settings,
    );
    const effectiveContextMatchMode = effectiveFilterCriteria.contextMatchMode ?? 'all';
    const effectiveTagMatchMode = effectiveFilterCriteria.tagMatchMode ?? 'all';
    const canSaveFocusPerspective = activeSavedFilterId === null
        && (
            hasCurrentFilterCriteria
            || focusSortBy !== DEFAULT_FOCUS_SORT_BY
            || effectiveNextGroupBy !== 'none'
        );
    const normalizedSearchQuery = searchQuery.trim().toLowerCase();
    const matchesSearchQuery = useCallback((title: string) => {
        if (!normalizedSearchQuery) return true;
        return title.toLowerCase().includes(normalizedSearchQuery);
    }, [normalizedSearchQuery]);
    const resolveText = useCallback((key: string, fallback: string) => {
        return translateWithFallback(t, key, fallback);
    }, [t]);
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
        void updateSettings({ savedFilters: nextFilters }).catch(() => undefined);
    }, [activeSavedFilter, settings?.savedFilters, updateSettings]);
    const activeFilterChips = useMemo<AgendaActiveFilterChip[]>(() => {
        const chips: AgendaActiveFilterChip[] = [];
        selectedTokens.forEach((token) => {
            chips.push({
                id: `token:${token}`,
                label: token,
            });
        });
        excludedTokens.forEach((token) => {
            chips.push({
                id: `excluded-token:${token}`,
                label: token,
                excluded: true,
                onRemove: () => toggleTokenFilter(token),
            });
        });
        selectedProjects.forEach((projectId) => {
            if (projectId === NO_PROJECT_FILTER_ID) {
                chips.push({
                    id: `project:${projectId}`,
                    label: resolveText('taskEdit.noProjectOption', 'No project'),
                });
                return;
            }
            const project = projectMap.get(projectId);
            if (!project) return;
            chips.push({
                id: `project:${project.id}`,
                label: project.title,
                dotColor: (project.areaId ? areaById.get(project.areaId)?.color : undefined) || project.color || undefined,
            });
        });
        (showPriorityFilters ? activePriorities : []).forEach((priority) => {
            chips.push({
                id: `priority:${priority}`,
                label: t(`priority.${priority}`),
            });
        });
        (showEnergyLevelFilters ? selectedEnergyLevels : []).forEach((energyLevel) => {
            chips.push({
                id: `energy:${energyLevel}`,
                label: t(`energyLevel.${energyLevel}`),
            });
        });
        (showTimeEstimateFilters ? activeTimeEstimates : []).forEach((estimate) => {
            chips.push({
                id: `time:${estimate}`,
                label: formatEstimate(estimate),
            });
        });
        const normalizedLocationFilter = locationFilter.trim();
        if (showLocationFilter && normalizedLocationFilter && !activeSavedFilter) {
            chips.push({
                id: `location:${normalizedLocationFilter}`,
                label: `${resolveText('taskEdit.locationLabel', 'Location')}: ${normalizedLocationFilter}`,
            });
        }
        if (activeSavedFilter) {
            chips.push(...buildAdvancedFilterCriteriaChips(effectiveFilterCriteria, {
                getAreaColor: (areaId) => areaById.get(areaId)?.color,
                getAreaLabel: (areaId) => areaById.get(areaId)?.name,
                resolveText,
            }).map((chip) => ({
                id: `advanced:${chip.id}`,
                label: chip.label,
                dotColor: chip.color,
                isAdvanced: true,
                onRemove: () => removeAdvancedSavedFilterCriterion(chip.id),
            })));
        }
        return chips;
    }, [
        activeSavedFilter,
        activePriorities,
        activeTimeEstimates,
        areaById,
        effectiveFilterCriteria,
        formatEstimate,
        projectMap,
        removeAdvancedSavedFilterCriterion,
        resolveText,
        selectedEnergyLevels,
        locationFilter,
        selectedProjects,
        selectedTokens,
        excludedTokens,
        t,
        toggleTokenFilter,
    ]);
    const activeFilterCount = filterSelections.activeCount
        + (effectiveFocusSortBy !== DEFAULT_FOCUS_SORT_BY ? 1 : 0)
        + (activeSavedFilterId && filterSelections.activeCount === 0 && effectiveFocusSortBy === DEFAULT_FOCUS_SORT_BY ? 1 : 0);
    const saveFilterDefaultName = getSavedFilterDefaultName(activeFilterChips, resolveText('savedFilters.defaultName', 'Focus filter'));

    const {
        filteredActiveTasks, scheduleCandidates, reviewDueCandidates, upcomingCandidates, upcomingAppearsAtById, scheduleAppearsAtById,
    } = useMemo(() => {
        void localDayKey;
        // Next Actions and Review due hide a later-today start until its time
        // arrives, so their pools have to leave a row the moment that time hits
        // rather than waiting for midnight.
        void futureStartTick;
        const now = new Date();
        const filtered = applyFilter(activeTasks, effectiveFilterCriteria, { projects, now, tokenMatchMode: 'all' })
            .filter((task) => matchesSearchQuery(task.title));
        // Today/schedule membership is decided at day granularity (a later-today
        // start belongs there, by its time), so it draws from baseActiveTasks
        // rather than the time-granularity activeTasks pool — with the same
        // user criteria/search filteredActiveTasks applies. A task deferred to
        // another day must still be excluded here (day-granularity), or a
        // dueDate<=today row with a future-day start would double up in both
        // Today and Upcoming.
        const scheduleBase = applyFilter(
            baseActiveTasks.filter((task) => shouldShowTaskForStart(task, { now })),
            effectiveFilterCriteria,
            { projects, now, tokenMatchMode: 'all' },
        ).filter((task) => matchesSearchQuery(task.title));
        const reviewDueBase = baseActiveTasks
            .filter((task) => {
                if (!shouldShowTaskForStart(task, { now, granularity: 'time' })) return false;
                if (!isDueForReview(task.reviewAt, now)) return false;
                if (!matchesSearchQuery(task.title)) return false;
                return true;
            });
        const reviewDue = applyFilter(reviewDueBase, effectiveFilterCriteria, { projects, now, tokenMatchMode: 'all' });
        // The Upcoming preview draws from baseActiveTasks: the deferral filter that
        // produced activeTasks is exactly what hides these rows today (#1061).
        // Starred tasks are excluded — they render in Today's Focus regardless of
        // deferral, and one task must not appear in both sections.
        const upcomingBase = applyFilter(
            baseActiveTasks.filter((task) => !task.isFocusedToday && matchesSearchQuery(task.title)),
            effectiveFilterCriteria,
            { projects, now, tokenMatchMode: 'all' },
        );
        const upcomingEntries = getUpcomingDeferredTasks(upcomingBase, { now });
        // A Today row whose timed start hasn't arrived yet gets the same
        // appears-at treatment as Upcoming, formatted as a time (it's today) so
        // it drops the moment the start passes — hence the futureStartTick dep.
        const scheduleAppearsAtById = new Map(
            scheduleBase
                .filter((task) => !shouldShowTaskForStart(task, { now, granularity: 'time' }))
                .map((task) => [task.id, safeFormatDate(task.startTime, 'p')]),
        );
        return {
            filteredActiveTasks: filtered,
            scheduleCandidates: scheduleBase,
            reviewDueCandidates: reviewDue,
            upcomingCandidates: upcomingEntries.map((entry) => entry.task),
            // Showing the date is the whole point of the section, so it rides the
            // row rather than the metadata that "show list details" hides.
            upcomingAppearsAtById: new Map(upcomingEntries.map((entry) => (
                [entry.task.id, safeFormatDate(entry.appearsAt, 'P')]
            ))),
            scheduleAppearsAtById,
        };
    }, [activeTasks, baseActiveTasks, effectiveFilterCriteria, futureStartTick, localDayKey, matchesSearchQuery, projects]);
    const getUpcomingAppearsAtLabel = useCallback(
        (taskId: string) => upcomingAppearsAtById.get(taskId),
        [upcomingAppearsAtById],
    );
    const getScheduleAppearsAtLabel = useCallback(
        (taskId: string) => scheduleAppearsAtById.get(taskId),
        [scheduleAppearsAtById],
    );

    const reviewDueProjects = useMemo(() => {
        void localDayKey;
        const now = new Date();
        return projects
            .filter((project) => {
                if (project.deletedAt) return false;
                if (project.status === 'archived') return false;
                if (!projectMatchesAreaFilterSelection(project, resolvedAreaFilter, areaById)) return false;
                if (!matchesSearchQuery(project.title)) return false;
                return isDueForReview(project.reviewAt, now);
            })
            .sort((a, b) => {
                const aReview = safeParseDate(a.reviewAt)?.getTime() ?? Number.POSITIVE_INFINITY;
                const bReview = safeParseDate(b.reviewAt)?.getTime() ?? Number.POSITIVE_INFINITY;
                if (aReview !== bReview) return aReview - bReview;
                return a.title.localeCompare(b.title);
            });
    }, [projects, localDayKey, matchesSearchQuery, resolvedAreaFilter, areaById]);
    const handleOpenReviewProject = useCallback((projectId: string) => {
        setProjectView({ selectedProjectId: projectId });
        dispatchNavigateEvent('projects');
    }, [setProjectView]);
    const showFiltersPanel = filtersOpen;
    const shouldRenderFiltersPanel = filtersOpen
        || hasTaskFilters
        || focusSortBy !== DEFAULT_FOCUS_SORT_BY
        || Boolean(activeSavedFilterId);
    useEffect(() => {
        if (!filtersOpen) return;
        filterInputRef.current?.focus();
    }, [filtersOpen]);
    const updateContextMatchMode = useCallback((mode: MultiValueFilterMatchMode) => {
        setMatchMode('context', mode);
    }, [setMatchMode]);
    const updateTagMatchMode = useCallback((mode: MultiValueFilterMatchMode) => {
        setMatchMode('tag', mode);
    }, [setMatchMode]);
    const updateFocusSortBy = useCallback((value: SortField) => {
        unbindSavedFilter();
        setFocusSortBy(value);
    }, [unbindSavedFilter]);
    const updateFocusGroupBy = useCallback((value: NextGroupBy) => {
        unbindSavedFilter();
        setListOptions({ focusGroupBy: value });
    }, [setListOptions, unbindSavedFilter]);
    const applySavedFocusFilter = useCallback((filter: SavedFilter) => {
        applySavedSelections(filter);
        setFocusSortBy(filter.sortBy ?? DEFAULT_FOCUS_SORT_BY);
        setFiltersOpen(false);
    }, [applySavedSelections]);
    const handleSaveFilterConfirm = useCallback((name: string) => {
        const trimmedName = name.trim();
        if (!trimmedName || !canSaveFocusPerspective) return;
        const nowIso = new Date().toISOString();
        const nextFilter: SavedFilter = {
            id: generateUUID(),
            name: trimmedName,
            view: 'focus',
            criteria: currentFilterCriteria,
            ...(focusSortBy !== DEFAULT_FOCUS_SORT_BY ? { sortBy: focusSortBy } : {}),
            ...(effectiveNextGroupBy !== 'none' ? { groupBy: effectiveNextGroupBy } : {}),
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        void updateSettings({
            savedFilters: [...(settings?.savedFilters ?? []), nextFilter],
        }).then(() => {
            setSaveFilterPromptOpen(false);
            applySavedSelections(nextFilter);
        }).catch(() => undefined);
    }, [applySavedSelections, canSaveFocusPerspective, currentFilterCriteria, effectiveNextGroupBy, focusSortBy, settings?.savedFilters, updateSettings]);
    const handleDeleteSavedFilter = useCallback(async (filter: SavedFilter) => {
        const confirmed = await requestConfirmation({
            title: resolveText('savedFilters.deleteTitle', 'Delete saved filter?'),
            description: filter.name,
            confirmLabel: resolveText('common.delete', 'Delete'),
            cancelLabel: t('common.cancel'),
        });
        if (!confirmed) return;
        const nextFilters = markSavedFilterDeleted(settings?.savedFilters, filter.id);
        void updateSettings({ savedFilters: nextFilters }).then(() => {
            if (activeSavedFilterId === filter.id) {
                unbindSavedFilter();
            }
        }).catch(() => undefined);
    }, [activeSavedFilterId, requestConfirmation, resolveText, settings?.savedFilters, t, unbindSavedFilter, updateSettings]);

    useEffect(() => {
        if (!highlightTaskId) return;
        const el = document.querySelector(`[data-task-id="${highlightTaskId}"]`) as HTMLElement | null;
        if (el && typeof (el as any).scrollIntoView === 'function') {
            el.scrollIntoView({ block: 'center' });
        }
        focusTaskRowWhenMounted(highlightTaskId);
        const timer = window.setTimeout(() => setHighlightTask(null), 4000);
        return () => window.clearTimeout(timer);
    }, [highlightTaskId, setHighlightTask]);
    // Today's Focus: tasks marked as isFocusedToday.
    const sortBySavedPerspective = useCallback((items: Task[]) => {
        if (effectiveFocusSortBy === DEFAULT_FOCUS_SORT_BY) return items;
        return sortTasksBySavedPreference(items, effectiveFocusSortBy, {
            projects,
            prioritizeByPriority: prioritiesEnabled,
            sortOrder: activeSavedFilter?.sortOrder,
        });
    }, [activeSavedFilter?.sortOrder, effectiveFocusSortBy, prioritiesEnabled, projects]);

    // Manual drag order (focusOrder) is a full-list concept, so dragging is only
    // enabled when all three hold: the sort is the default (an explicit or saved
    // sort takes over and disables dragging), no search query is active, and no
    // filter criteria are active. Reordering a filtered/searched subset would
    // write focusOrder indices 0..n over only the visible rows, leaving hidden
    // focused tasks with stale positions that surprise-interleave once the filter
    // clears. Clearing the filter is the correction path.
    const focusDragEnabled = effectiveFocusSortBy === DEFAULT_FOCUS_SORT_BY && !hasTaskFilters;
    const focusedTasks = useMemo(() => {
        // Today's Focus shows every starred task the focus cap counts. It must
        // not inherit the pool's area-visibility or start-time hiding: the star
        // buttons enforce the store-wide count, so a starred task hidden by
        // those rules silently eats a slot no filter change can reveal — the
        // "I can only star 4 when the limit is 5" report. Saved filters and
        // search still apply; the user can see those causes and undo them.
        const focused = applyFilter(
            derivedActiveTasks.filter((t) => t.isFocusedToday),
            effectiveFilterCriteria,
            { projects, now: new Date(), tokenMatchMode: 'all' },
        ).filter((task) => matchesSearchQuery(task.title));
        return focusDragEnabled ? sortTasksByFocusOrder(focused) : sortBySavedPerspective(focused);
    }, [derivedActiveTasks, effectiveFilterCriteria, projects, matchesSearchQuery, focusDragEnabled, sortBySavedPerspective]);

    // Categorize tasks
    const sections = useMemo(() => {
        void localDayKey;
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
        const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
        const priorityRank: Record<TaskPriority, number> = {
            low: 1,
            medium: 2,
            high: 3,
            urgent: 4,
        };
        const sortWith = (items: Task[], getTime: (task: Task) => number) => {
            return [...items].sort((a, b) => {
                const timeDiff = getTime(a) - getTime(b);
                if (timeDiff !== 0) return timeDiff;
                if (prioritiesEnabled) {
                    const priorityDiff = (priorityRank[b.priority as TaskPriority] || 0) - (priorityRank[a.priority as TaskPriority] || 0);
                    if (priorityDiff !== 0) return priorityDiff;
                }
                const aCreated = safeParseDate(a.createdAt)?.getTime() ?? 0;
                const bCreated = safeParseDate(b.createdAt)?.getTime() ?? 0;
                return aCreated - bCreated;
            });
        };
        const sequentialFirstTasks = getFocusSequentialFirstTaskIds(baseActiveTasks, sequentialProjectIds, {
            now,
            sectionScopedProjectIds: sequentialWithinSectionProjectIds,
        });
        const isSequentialBlocked = (task: Task) => {
            if (!task.projectId) return false;
            if (!sequentialProjectIds.has(task.projectId)) return false;
            return !sequentialFirstTasks.has(task.id);
        };
        const schedule = scheduleCandidates.filter((task) => {
            if (task.isFocusedToday) return false;
            if (task.status !== 'next') return false;
            if (isSequentialBlocked(task)) return false;
            const dueDate = safeParseDueDate(task.dueDate);
            const startDate = safeParseDate(task.startTime);
            const startsToday = Boolean(
                startDate
                && startDate >= startOfToday
                && startDate <= endOfToday
            );
            return Boolean(dueDate && dueDate <= endOfToday)
                || startsToday;
        });
        const scheduleIds = new Set(schedule.map((task) => task.id));
        const reviewDue = reviewDueCandidates.filter((task) => (
            !task.isFocusedToday && !scheduleIds.has(task.id)
        ));
        const reviewDueIds = new Set(reviewDue.map((task) => task.id));
        const nextActions = filteredActiveTasks.filter((task) => {
            if (task.status !== 'next' || task.isFocusedToday) return false;
            if (isSequentialBlocked(task)) return false;
            return !scheduleIds.has(task.id) && !reviewDueIds.has(task.id);
        });
        const projectDeadlineBoosts = effectiveFocusSortBy === DEFAULT_FOCUS_SORT_BY
            ? getProjectDeadlineBoosts(nextActions, projects, { now })
            : new Map<string, ProjectDeadlineBoost>();
        const scheduleSortTime = (task: Task) => {
            const due = safeParseDueDate(task.dueDate)?.getTime();
            const start = safeParseDate(task.startTime)?.getTime();
            if (typeof due === 'number' && typeof start === 'number') return Math.min(due, start);
            if (typeof due === 'number') return due;
            if (typeof start === 'number') return start;
            return Number.POSITIVE_INFINITY;
        };

        const sortSchedule = (items: Task[]) => (
            effectiveFocusSortBy === DEFAULT_FOCUS_SORT_BY
                ? sortWith(items, scheduleSortTime)
                : sortBySavedPerspective(items)
        );
        const sortNextActions = (items: Task[]) => (
            effectiveFocusSortBy === DEFAULT_FOCUS_SORT_BY
                ? sortFocusNextActions(items, {
                    now,
                    prioritizeByPriority: prioritiesEnabled,
                    projectDeadlineBoosts,
                })
                : sortBySavedPerspective(items)
        );
        const sortReviewDue = (items: Task[]) => (
            effectiveFocusSortBy === DEFAULT_FOCUS_SORT_BY
                ? sortWith(items, (task) => safeParseDate(task.reviewAt)?.getTime() ?? Number.POSITIVE_INFINITY)
                : sortBySavedPerspective(items)
        );

        return {
            schedule: sortSchedule(schedule),
            nextActions: sortNextActions(nextActions),
            // The forecast keeps reveal-date order even under a custom sort — the
            // date a task appears is the only ordering that means anything here.
            upcoming: upcomingCandidates.filter((task) => !isSequentialBlocked(task)),
            reviewDue: sortReviewDue(reviewDue),
            projectDeadlineBoosts,
        };
    }, [
        baseActiveTasks,
        effectiveFocusSortBy,
        filteredActiveTasks,
        localDayKey,
        prioritiesEnabled,
        projects,
        reviewDueCandidates,
        scheduleCandidates,
        sequentialProjectIds,
        sequentialWithinSectionProjectIds,
        sortBySavedPerspective,
        upcomingCandidates,
    ]);
    const nextActionGroups = useMemo(() => (
        groupTasks(effectiveNextGroupBy, { tasks: sections.nextActions, areas, projectMap, t, theme: settings?.theme })
    ), [areas, effectiveNextGroupBy, projectMap, sections.nextActions, settings?.theme, t]);
    const setCollapsedGroups = useCallback<SetFocusCollapsedGroups>((updater) => {
        setPersistedViewState((current) => ({
            ...current,
            collapsedGroups: updater(current.collapsedGroups),
        }));
    }, [setPersistedViewState]);
    const {
        collapsedGroupIds: collapsedNextActionGroupIds,
        getSectionDomId: getNextActionSectionDomId,
        toggleGroup: toggleNextActionGroup,
        visibleTasks: visibleNextActions,
    } = useTaskGroupCollapse({
        axis: effectiveNextGroupBy,
        groups: nextActionGroups,
        tasks: sections.nextActions,
        idPrefix: 'agenda-next-group',
        collapsedGroups: persistedViewState.collapsedGroups,
        setCollapsedGroups,
    });
    const getProjectDeadlineLabel = useCallback((taskId: string) => (
        getProjectDeadlineBoostLabel(sections.projectDeadlineBoosts.get(taskId), resolveText)
    ), [resolveText, sections.projectDeadlineBoosts]);
    const { top3Tasks, remainingCount } = useMemo(() => {
        const byId = new Map<string, Task>();
        [...sections.schedule, ...sections.reviewDue, ...sections.nextActions].forEach((task) => {
            if (!byId.has(task.id)) {
                byId.set(task.id, task);
            }
        });
        const candidates = Array.from(byId.values());
        const top3 = candidates.slice(0, 3);
        return {
            top3Tasks: top3,
            remainingCount: Math.max(candidates.length - top3.length, 0),
        };
    }, [sections]);

    // The keyboard scope walks exactly what is on screen, in render order:
    // collapsed sections and collapsed groups contribute no rows.
    const visibleTasks = useMemo(() => {
        if (top3Only) return [...focusedTasks, ...top3Tasks];
        const visible = [...focusedTasks];
        if (expandedSections.schedule) visible.push(...sections.schedule);
        if (expandedSections.reviewDue) visible.push(...sections.reviewDue);
        if (expandedSections.nextActions) visible.push(...visibleNextActions);
        if (expandedSections.upcoming) visible.push(...sections.upcoming);
        return visible;
    }, [
        expandedSections,
        focusedTasks,
        sections,
        top3Only,
        top3Tasks,
        visibleNextActions,
    ]);
    const [selectedTaskIndex, setSelectedTaskIndex] = useState(0);
    useTaskListScope({
        getTasks: () => visibleTasks,
        getSelectedIndex: () => selectedTaskIndex,
        setSelectedIndex: setSelectedTaskIndex,
        t,
    });

    const handleToggleFocus = useCallback((taskId: string) => {
        const task = tasksById.get(taskId);
        if (!task) return;
        // Core focus-star module decides eligibility, cap, and the patch;
        // status promotion happens in the store's star↔status rules.
        const action = useTaskStore.getState().getFocusStarAction(task);
        if (!action.canToggle) {
            const blockedText = getFocusStarBlockedText(t, action, focusTaskLimit);
            if (blockedText) showToast(blockedText, 'info');
            return;
        }
        updateTask(taskId, action.patch);
    }, [focusTaskLimit, showToast, t, tasksById, updateTask]);

    const buildFocusToggle = useCallback((task: Task) => {
        const isFocused = Boolean(task.isFocusedToday);
        // Cheap cap-only gate at render time (rows are many); full eligibility
        // is enforced on click via the core focus-star module, which toasts
        // the blocked reason.
        const canToggle = isFocused || focusedCount < focusTaskLimit;
        const title = isFocused
            ? t('agenda.removeFromFocus')
            : focusedCount >= focusTaskLimit
                ? formatFocusTaskLimitText(t('agenda.maxFocusItems'), focusTaskLimit)
                : t('agenda.addToFocus');
        return {
            isFocused,
            canToggle,
            onToggle: () => handleToggleFocus(task.id),
            title,
            ariaLabel: title,
            alwaysVisible: true,
        };
    }, [focusTaskLimit, focusedCount, handleToggleFocus, t]);

    // Every Upcoming row is deferred by construction, so the star can only ever
    // refuse — the cap-only render gate above would show an enabled "Add to Focus"
    // whose sole outcome is a toast. Disabled-with-the-reason instead, matching
    // how the project Order row states an unavailable action rather than hiding it.
    const buildUpcomingFocusToggle = useCallback((task: Task) => {
        const toggle = buildFocusToggle(task);
        if (toggle.isFocused) return toggle;
        const deferredText = getFocusStarBlockedText(t, { blockedReason: 'deferred' }, focusTaskLimit)
            ?? toggle.title;
        return { ...toggle, canToggle: false, title: deferredText, ariaLabel: deferredText };
    }, [buildFocusToggle, focusTaskLimit, t]);

    const toggleSection = useCallback((sectionKey: FocusSectionKey) => {
        setPersistedViewState((current) => ({
            ...current,
            expandedSections: {
                ...current.expandedSections,
                [sectionKey]: !current.expandedSections[sectionKey],
            },
        }));
    }, [setPersistedViewState]);
    const nextActionsCount = sections.nextActions.length;
    const hasAgendaContent = focusedTasks.length > 0
        || sections.schedule.length > 0
        || sections.nextActions.length > 0
        || sections.upcoming.length > 0
        || sections.reviewDue.length > 0
        || reviewDueProjects.length > 0;
    const pomodoroTasks = (() => {
        const ordered = [
            ...focusedTasks,
            ...sections.schedule,
            ...sections.reviewDue,
            ...sections.nextActions,
        ];
        const byId = new Map<string, Task>();
        ordered.forEach((task) => {
            if (task.deletedAt) return;
            byId.set(task.id, task);
        });
        return Array.from(byId.values());
    })();
    const handleToggleDetails = useCallback(() => {
        if (showListDetails) {
            collapseAllTaskDetails();
            setListOptions({ showDetails: false });
            return;
        }
        setListOptions({ showDetails: true });
    }, [collapseAllTaskDetails, setListOptions, showListDetails]);
    const focusDndSensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    );
    const [activeFocusDragId, setActiveFocusDragId] = useState<string | null>(null);
    const handleFocusDragStart = useCallback((event: DragStartEvent) => {
        setActiveFocusDragId(String(event.active.id));
    }, []);
    const handleFocusDragCancel = useCallback(() => setActiveFocusDragId(null), []);
    const handleFocusDragEnd = useCallback((event: DragEndEvent) => {
        setActiveFocusDragId(null);
        const { active, over } = event;
        if (!over || active.id === over.id) return;
        const ids = focusedTasks.map((task) => task.id);
        const oldIndex = ids.indexOf(String(active.id));
        const newIndex = ids.indexOf(String(over.id));
        if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
        // Core diffs against stored focusOrder and writes only the rows that moved.
        void Promise.resolve(reorderFocusedTasks(arrayMove(ids, oldIndex, newIndex))).catch(() => undefined);
    }, [focusedTasks, reorderFocusedTasks]);
    const focusDragAriaLabel = resolveText('projects.reorderTasks', 'Order');
    const activeFocusDragTask = activeFocusDragId
        ? focusedTasks.find((task) => task.id === activeFocusDragId) ?? null
        : null;

    const focusListBody = focusDragEnabled ? (
        <DndContext
            sensors={focusDndSensors}
            collisionDetection={closestCenter}
            onDragStart={handleFocusDragStart}
            onDragCancel={handleFocusDragCancel}
            onDragEnd={handleFocusDragEnd}
        >
            <SortableContext items={focusedTasks.map((task) => task.id)} strategy={verticalListSortingStrategy}>
                <div className="divide-y divide-border/30">
                    {focusedTasks.map(task => (
                        <SortableFocusRow
                            key={task.id}
                            taskId={task.id}
                            dragAriaLabel={focusDragAriaLabel}
                            buildFocusToggle={buildFocusToggle}
                            showProjectBadgeInActions={false}
                            compactMetaEnabled={showListDetails}
                            enableDoubleClickEdit
                        />
                    ))}
                </div>
            </SortableContext>
            <DragOverlay dropAnimation={null}>
                {activeFocusDragTask ? (
                    <div className="pointer-events-none max-w-[280px] truncate rounded-lg border border-border bg-card px-3 py-2 text-sm shadow-lg">
                        {activeFocusDragTask.title}
                    </div>
                ) : null}
            </DragOverlay>
        </DndContext>
    ) : (
        <div className="divide-y divide-border/30">
            {focusedTasks.map(task => (
                <StoreTaskItem
                    key={task.id}
                    taskId={task.id}
                    buildFocusToggle={buildFocusToggle}
                    showProjectBadgeInActions={false}
                    compactMetaEnabled={showListDetails}
                    enableDoubleClickEdit
                />
            ))}
        </div>
    );

    const todaysFocusSection = focusedTasks.length > 0 ? (
        <div
            data-testid="todays-focus-section"
            className="rounded-xl border border-border/70 border-l-4 border-l-amber-400 bg-card/70 p-6 shadow-sm dark:border-border/60 dark:border-l-amber-400/80 dark:bg-card/60"
        >
            <h3 className="font-bold text-lg flex items-center gap-2 mb-4 text-foreground">
                <FocusStarIcon className="w-5 h-5" filled />
                {t('agenda.todaysFocus')}
                <span className="text-sm font-normal text-muted-foreground">
                    ({focusedCount}/{focusTaskLimit})
                </span>
            </h3>

            {focusListBody}
        </div>
    ) : null;

    return (
        <ErrorBoundary>
            <div className={cn("space-y-6 w-full", LIST_END_GAP)} data-list-end>
            <AgendaHeader
                filterCount={activeFilterCount}
                filtersOpen={filtersOpen}
                nextActionsCount={nextActionsCount}
                nextGroupBy={effectiveNextGroupBy}
                onChangeGroupBy={updateFocusGroupBy}
                onToggleFilters={() => setFiltersOpen((prev) => !prev)}
                onToggleDetails={handleToggleDetails}
                onToggleTop3={() => setListOptions({ focusTop3Only: !top3Only })}
                resolveText={resolveText}
                showListDetails={showListDetails}
                t={t}
                top3Only={top3Only}
            />

            {savedFocusFilters.length > 0 && (
                <div className="flex items-center gap-2 overflow-x-auto pb-1">
                    <button
                        type="button"
                        onClick={clearAllFilters}
                        aria-pressed={!hasTaskFilters && !activeSavedFilterId && focusSortBy === DEFAULT_FOCUS_SORT_BY}
                        className={cn(
                            'shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                            !hasTaskFilters && !activeSavedFilterId && focusSortBy === DEFAULT_FOCUS_SORT_BY
                                ? 'border-primary bg-primary text-primary-foreground'
                                : 'border-border bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
                        )}
                    >
                        {resolveText('common.all', 'All')}
                    </button>
                    {savedFocusFilters.map((filter) => {
                        const isActive = activeSavedFilterId === filter.id;
                        return (
                            <div key={filter.id} className="inline-flex shrink-0 items-center">
                                <button
                                    type="button"
                                    onClick={() => applySavedFocusFilter(filter)}
                                    aria-pressed={isActive}
                                    className={cn(
                                        'inline-flex max-w-[220px] shrink-0 items-center gap-1.5 border px-3 py-1.5 text-xs font-medium transition-colors',
                                        isActive ? 'rounded-l-full rounded-r-none' : 'rounded-full',
                                        isActive
                                            ? 'border-primary bg-primary text-primary-foreground'
                                            : 'border-border bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
                                    )}
                                >
                                    {filter.icon && <span aria-hidden="true">{filter.icon}</span>}
                                    <span className="truncate">{filter.name}</span>
                                </button>
                                {isActive && (
                                    <button
                                        type="button"
                                        onClick={() => void handleDeleteSavedFilter(filter)}
                                        aria-label={`${resolveText('common.delete', 'Delete')} ${resolveText('savedFilters.label', 'saved filter')} ${filter.name}`}
                                        title={`${resolveText('common.delete', 'Delete')} ${filter.name}`}
                                        className="inline-flex h-[30px] w-7 shrink-0 items-center justify-center rounded-l-none rounded-r-full border border-l-0 border-primary bg-primary text-primary-foreground transition-colors hover:bg-primary/90"
                                    >
                                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                                    </button>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {pomodoroEnabled && <PomodoroPanel tasks={pomodoroTasks} />}

            {shouldRenderFiltersPanel && (
                <AgendaFiltersPanel
                    allTokens={allTokens}
                    activeFilterChips={activeFilterChips}
                    canSaveFilter={canSaveFocusPerspective}
                    contextMatchMode={effectiveContextMatchMode}
                    contextMatchModeLabels={{
                        title: resolveText('filters.contextMatchMode', 'Context match'),
                        any: resolveText('filters.matchAny', 'Any'),
                        all: resolveText('common.all', 'All'),
                    }}
                    tagMatchMode={effectiveTagMatchMode}
                    tagMatchModeLabels={{
                        title: resolveText('filters.tagMatchMode', 'Tag match'),
                        any: resolveText('filters.matchAny', 'Any'),
                        all: resolveText('common.all', 'All'),
                    }}
                    energyLevelOptions={energyLevelOptions}
                    focusSortBy={effectiveFocusSortBy}
                    formatEstimate={formatEstimate}
                    hasFilters={activeFilterCount > 0}
                    locationFilter={locationFilter}
                    showEnergyLevelFilters={showEnergyLevelFilters}
                    showLocationFilter={showLocationFilter}
                    onClearFilters={clearAllFilters}
                    onLocationChange={updateLocationFilter}
                    onSaveFilter={() => setSaveFilterPromptOpen(true)}
                    onContextMatchModeChange={updateContextMatchMode}
                    onTagMatchModeChange={updateTagMatchMode}
                    onSearchChange={setSearchQuery}
                    onSortChange={updateFocusSortBy}
                    onToggleEnergy={toggleEnergyFilter}
                    onToggleFiltersOpen={() => setFiltersOpen((prev) => !prev)}
                    onToggleProject={toggleProjectFilter}
                    onTogglePriority={togglePriorityFilter}
                    onToggleTime={toggleTimeFilter}
                    onToggleToken={toggleTokenFilter}
                    showPriorityFilters={showPriorityFilters}
                    projectOptions={projectOptions}
                    priorityOptions={priorityOptions}
                    searchInputRef={filterInputRef}
                    searchQuery={searchQuery}
                    saveFilterLabel={resolveText('savedFilters.save', 'Save')}
                    selectedEnergyLevels={selectedEnergyLevels}
                    selectedProjects={selectedProjects}
                    selectedPriorities={selectedPriorities}
                    selectedTimeEstimates={selectedTimeEstimates}
                    selectedTokens={selectedTokens}
                    excludedTokens={excludedTokens}
                    excludedStateLabel={resolveText('filters.excluded', 'Excluded')}
                    showNoProjectOption={showNoProjectOption}
                    showFiltersPanel={showFiltersPanel}
                    t={t}
                    timeEstimateOptions={timeEstimateOptions}
                    showTimeEstimateFilters={showTimeEstimateFilters}
                />
            )}

            {error && (
                <div
                    role="alert"
                    className="flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <div className="min-w-0">
                        <p className="font-medium">{resolveText('errorBoundary.title', 'Something went wrong')}</p>
                        <p className="break-words text-destructive/90">{error}</p>
                    </div>
                </div>
            )}

            {top3Only ? (
                <div className="space-y-4">
                    {todaysFocusSection}
                    <div className="space-y-2">
                        <h3 className="font-semibold">{t('agenda.top3Title')}</h3>
                        {top3Tasks.length > 0 ? (
                            <div className="divide-y divide-border/30">
                                {top3Tasks.map(task => (
                                    <StoreTaskItem
                                        key={task.id}
                                        taskId={task.id}
                                        buildFocusToggle={buildFocusToggle}
                                        showProjectBadgeInActions={false}
                                        compactMetaEnabled={showListDetails}
                                        enableDoubleClickEdit
                                        projectDeadlineLabel={getProjectDeadlineLabel(task.id)}
                                    />
                                ))}
                            </div>
                        ) : (
                            <p className="text-muted-foreground text-sm">{t('agenda.noTasks')}</p>
                        )}
                    </div>
                    {remainingCount > 0 && (
                        <button
                            type="button"
                            onClick={() => setListOptions({ focusTop3Only: false })}
                            className="text-xs px-3 py-2 rounded bg-muted/50 text-muted-foreground hover:bg-muted transition-colors"
                        >
                            {t('agenda.showMore').replace('{{count}}', `${remainingCount}`)}
                        </button>
                    )}
                </div>
            ) : (
                <>
                    {todaysFocusSection}

                    {/* Other Sections */}
                    <div className="space-y-6">
                        {sections.schedule.length > 0 && (
                            <AgendaCollapsibleSection
                                title={tFallback(t, 'focus.schedule', t('agenda.dueToday'))}
                                icon={Clock}
                                color="text-warning"
                                count={sections.schedule.length}
                                expanded={expandedSections.schedule}
                                onToggle={() => toggleSection('schedule')}
                                controlsId="agenda-section-schedule"
                            >
                                <AgendaTaskList
                                    tasks={sections.schedule}
                                    buildFocusToggle={buildFocusToggle}
                                    getAppearsAtLabel={getScheduleAppearsAtLabel}
                                    showListDetails={showListDetails}
                                    highlightTaskId={highlightTaskId}
                                />
                            </AgendaCollapsibleSection>
                        )}

                        {sections.reviewDue.length > 0 && (
                            <AgendaCollapsibleSection
                                title={tFallback(t, 'agenda.reviewDue', 'Review Due')}
                                icon={Clock}
                                color="text-status-someday"
                                count={sections.reviewDue.length}
                                expanded={expandedSections.reviewDue}
                                onToggle={() => toggleSection('reviewDue')}
                                controlsId="agenda-section-reviewDue"
                            >
                                <AgendaTaskList
                                    tasks={sections.reviewDue}
                                    buildFocusToggle={buildFocusToggle}
                                    showListDetails={showListDetails}
                                    highlightTaskId={highlightTaskId}
                                />
                            </AgendaCollapsibleSection>
                        )}

                        {effectiveNextGroupBy === 'none' ? (
                            sections.nextActions.length > 0 && (
                                <AgendaCollapsibleSection
                                    title={t('agenda.nextActions')}
                                    icon={ArrowRight}
                                    color="text-info"
                                    count={sections.nextActions.length}
                                    expanded={expandedSections.nextActions}
                                    onToggle={() => toggleSection('nextActions')}
                                    controlsId="agenda-section-nextActions"
                                >
                                    <AgendaTaskList
                                        tasks={sections.nextActions}
                                        buildFocusToggle={buildFocusToggle}
                                        getProjectDeadlineLabel={getProjectDeadlineLabel}
                                        showListDetails={showListDetails}
                                        highlightTaskId={highlightTaskId}
                                    />
                                </AgendaCollapsibleSection>
                            )
                        ) : (
                            sections.nextActions.length > 0 && (
                                <AgendaCollapsibleSection
                                    title={t('agenda.nextActions')}
                                    icon={ArrowRight}
                                    color="text-info"
                                    count={sections.nextActions.length}
                                    expanded={expandedSections.nextActions}
                                    onToggle={() => toggleSection('nextActions')}
                                    controlsId="agenda-section-nextActions"
                                >
                                    <div className="space-y-2">
                                        {nextActionGroups.map((group, index) => {
                                            const collapsed = collapsedNextActionGroupIds.has(group.id);
                                            const controlsId = getNextActionSectionDomId(group, index);
                                            return (
                                                <div key={group.id} className="overflow-hidden rounded-lg border border-border/50 bg-card/40">
                                                    <GroupedTaskSectionHeader
                                                        group={group}
                                                        collapsed={collapsed}
                                                        controlsId={controlsId}
                                                        onToggleGroup={toggleNextActionGroup}
                                                    />
                                                    {!collapsed && (
                                                        <div id={controlsId} className="ml-4 border-l border-border/40 pl-3">
                                                            <AgendaTaskList
                                                                tasks={group.tasks}
                                                                buildFocusToggle={buildFocusToggle}
                                                                getProjectDeadlineLabel={getProjectDeadlineLabel}
                                                                showListDetails={showListDetails}
                                                                highlightTaskId={highlightTaskId}
                                                            />
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </AgendaCollapsibleSection>
                            )
                        )}

                        {sections.upcoming.length > 0 && (
                            <AgendaCollapsibleSection
                                title={tFallback(t, 'agenda.upcoming', 'Upcoming')}
                                icon={CalendarDays}
                                color="text-muted-foreground"
                                count={sections.upcoming.length}
                                expanded={expandedSections.upcoming}
                                onToggle={() => toggleSection('upcoming')}
                                controlsId="agenda-section-upcoming"
                            >
                                <AgendaTaskList
                                    tasks={sections.upcoming}
                                    buildFocusToggle={buildUpcomingFocusToggle}
                                    getAppearsAtLabel={getUpcomingAppearsAtLabel}
                                    showListDetails={showListDetails}
                                    highlightTaskId={highlightTaskId}
                                />
                            </AgendaCollapsibleSection>
                        )}

                        <AgendaProjectSection
                            title={tFallback(t, 'agenda.reviewDueProjects', 'Projects to review')}
                            icon={Folder}
                            onProjectPress={handleOpenReviewProject}
                            projects={reviewDueProjects}
                            color="text-status-reference"
                            t={t}
                        />
                    </div>
                </>
            )}

            {!top3Only && !hasAgendaContent && (
                <div className="flex flex-col items-center gap-1 py-8 text-center text-muted-foreground">
                    <CheckCircle2 className="h-6 w-6 text-success/80" aria-hidden="true" strokeWidth={1.5} />
                    <p className="text-base font-medium text-foreground">{t('agenda.allClear')}</p>
                    <p className="text-sm">
                        {hasTaskFilters
                            ? t('filters.noMatch')
                            : hasAnyTasks ? t('agenda.noTasks') : t('agenda.emptyStart')}
                    </p>
                </div>
            )}
            <PromptModal
                isOpen={saveFilterPromptOpen}
                title={resolveText('savedFilters.saveTitle', 'Save filter')}
                description={resolveText('savedFilters.saveDescription', 'Name this Focus filter.')}
                placeholder={resolveText('savedFilters.namePlaceholder', 'Filter name')}
                defaultValue={saveFilterDefaultName}
                confirmLabel={resolveText('common.save', 'Save')}
                cancelLabel={t('common.cancel')}
                onConfirm={handleSaveFilterConfirm}
                onCancel={() => setSaveFilterPromptOpen(false)}
            />
            {confirmModal}
            </div>
        </ErrorBoundary>
    );
}
