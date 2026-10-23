import { getProjectAccentColor } from '@mindwtr/core';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
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
import { shallow, useTaskStore, TaskPriority, TimeEstimate, TIME_ESTIMATE_OPTIONS, buildFocusPools, compareProjectsByOrder, planFocusFilterCriterionRemoval, formatFocusTaskLimitText,
    getFocusHiddenByAreaLabel, logInfo, getFocusStarBlockedText, formatTimeEstimateLabel, generateUUID, getUsedTaskTokens, deriveFocusTaskLists, getProjectDeadlineBoostLabel, getTaskMetadataFilterVisibility, isTaskFutureFocusCandidate, markSavedFilterDeleted, normalizeFocusTaskLimit, resolveFeatureFlags, resolveTaskPerspectiveForFeatures, safeFormatDate, safeParseDate, selectFocusSavedFilters, isDueForReview, shouldShowTaskForStart, splitTodayTasksByStartTime, translateWithFallback, tFallback, updateSettingsFromLatest } from '@mindwtr/core';
import { DEFAULT_FOCUS_SORT_BY } from '@mindwtr/core';
import type { MultiValueFilterMatchMode, SavedFilter, SortField, Task, TaskEnergyLevel } from '@mindwtr/core';
import { useTaskFilterSelections } from '@mindwtr/core/task-filter-selections';
import { buildAdvancedChips, buildSelectionChips, type ActiveFilterChipDeps } from './list/active-filter-chips';
import { useLanguage } from '../../contexts/language-context';
import { cn } from '../../lib/utils';
import { useUiStore } from '../../store/ui-store';
import { AlertCircle, CalendarDays, ChevronDown, ChevronRight, Clock, ArrowRight, Folder, CheckCircle2, MoreHorizontal, Trash2 } from 'lucide-react';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import { checkBudget } from '../../config/performanceBudgets';
import { isTaskVisibleInArea, taskMatchesAreaFilterSelection, projectMatchesAreaFilterSelection } from '@mindwtr/core';
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
const AGENDA_ACTIVE_STATUSES: Task['status'][] = ['inbox', 'next', 'waiting', 'someday'];
const FOCUS_VIEW_STATE_STORAGE_KEY = 'mindwtr:view:focus:v1';

type FocusSectionKey = 'focus' | 'schedule' | 'nextActions' | 'upcoming' | 'reviewDue' | 'reviewProjects';
type SetFocusCollapsedGroups = (
    updater: (current: CollapsedGroups<NextGroupBy>) => CollapsedGroups<NextGroupBy>,
) => void;

type FocusPersistedViewState = {
    expandedSections: Record<FocusSectionKey, boolean>;
    collapsedGroups: CollapsedGroups<NextGroupBy>;
};

const DEFAULT_FOCUS_VIEW_STATE: FocusPersistedViewState = {
    expandedSections: {
        focus: true,
        schedule: true,
        nextActions: true,
        upcoming: true,
        reviewDue: true,
        reviewProjects: true,
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
            focus: typeof expandedSections.focus === 'boolean' ? expandedSections.focus : fallback.expandedSections.focus,
            schedule: typeof expandedSections.schedule === 'boolean' ? expandedSections.schedule : fallback.expandedSections.schedule,
            nextActions: typeof expandedSections.nextActions === 'boolean' ? expandedSections.nextActions : fallback.expandedSections.nextActions,
            upcoming: typeof expandedSections.upcoming === 'boolean' ? expandedSections.upcoming : fallback.expandedSections.upcoming,
            reviewDue: typeof expandedSections.reviewDue === 'boolean' ? expandedSections.reviewDue : fallback.expandedSections.reviewDue,
            reviewProjects: typeof expandedSections.reviewProjects === 'boolean' ? expandedSections.reviewProjects : fallback.expandedSections.reviewProjects,
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

function SavedFocusFilterChip({
    filter,
    isActive,
    onApply,
    onDelete,
    resolveText,
}: {
    filter: SavedFilter;
    isActive: boolean;
    onApply: (filter: SavedFilter) => void;
    onDelete: (filter: SavedFilter) => Promise<void>;
    resolveText: (key: string, fallback: string) => string;
}) {
    const menuAnchorRef = useRef<HTMLDivElement | null>(null);
    const menuButtonRef = useRef<HTMLButtonElement | null>(null);
    const menuPanelRef = useRef<HTMLDivElement | null>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const [menuStyle, setMenuStyle] = useState<CSSProperties>({ position: 'fixed', top: 0, left: 0 });
    const moreOptionsLabel = `${resolveText('taskEdit.moreOptions', 'More options')}: ${filter.name}`;
    const deleteLabel = `${resolveText('common.delete', 'Delete')} ${resolveText('savedFilters.label', 'saved filter')} ${filter.name}`;

    useLayoutEffect(() => {
        if (!menuOpen) return;
        const place = () => {
            const rect = menuAnchorRef.current?.getBoundingClientRect();
            if (!rect) return;
            const menuWidth = 176;
            setMenuStyle({
                position: 'fixed',
                top: rect.bottom + 4,
                left: Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8)),
            });
        };
        place();
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        return () => {
            window.removeEventListener('resize', place);
            window.removeEventListener('scroll', place, true);
        };
    }, [menuOpen]);

    useEffect(() => {
        if (!menuOpen) return;
        menuPanelRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
        const handlePointer = (event: Event) => {
            const target = event.target as Node;
            if (menuAnchorRef.current?.contains(target) || menuPanelRef.current?.contains(target)) return;
            setMenuOpen(false);
        };
        const handleKey = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            setMenuOpen(false);
            menuButtonRef.current?.focus();
        };
        window.addEventListener('mousedown', handlePointer);
        window.addEventListener('keydown', handleKey);
        return () => {
            window.removeEventListener('mousedown', handlePointer);
            window.removeEventListener('keydown', handleKey);
        };
    }, [menuOpen]);

    return (
        <div ref={menuAnchorRef} className="inline-flex shrink-0 items-center">
            <button
                type="button"
                onClick={() => onApply(filter)}
                aria-pressed={isActive}
                className={cn(
                    'inline-flex max-w-[220px] shrink-0 items-center gap-1.5 rounded-l-full border px-3 py-1.5 text-xs font-medium transition-colors',
                    isActive
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
            >
                {filter.icon && <span aria-hidden="true">{filter.icon}</span>}
                <span className="truncate">{filter.name}</span>
            </button>
            <button
                ref={menuButtonRef}
                type="button"
                onClick={() => setMenuOpen((open) => !open)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label={moreOptionsLabel}
                title={moreOptionsLabel}
                className={cn(
                    'inline-flex h-[30px] w-8 shrink-0 items-center justify-center rounded-r-full border border-l-0 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                    isActive
                        ? 'border-primary bg-primary text-primary-foreground hover:bg-primary/90'
                        : 'border-border bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
            >
                <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            {menuOpen && typeof document !== 'undefined' && createPortal(
                <div
                    ref={menuPanelRef}
                    role="menu"
                    aria-label={moreOptionsLabel}
                    style={menuStyle}
                    className="z-50 min-w-44 rounded-md border border-border bg-card p-1 shadow-lg"
                    onKeyDown={(event) => {
                        if (event.key !== 'Tab') return;
                        setMenuOpen(false);
                        menuButtonRef.current?.focus();
                    }}
                >
                    <button
                        type="button"
                        role="menuitem"
                        aria-label={deleteLabel}
                        onClick={() => {
                            setMenuOpen(false);
                            void onDelete(filter);
                        }}
                        className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-destructive transition-colors hover:bg-muted focus:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                    >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                        <span>{resolveText('common.delete', 'Delete')}</span>
                    </button>
                </div>,
                document.body,
            )}
        </div>
    );
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
    const { projects, sections: projectSections, areas, updateTask, reorderFocusedTasks, settings, error, highlightTaskId, setHighlightTask, taskChangeToken, hasAnyTasks } = useTaskStore(
        (state) => ({
            projects: state.projects,
            sections: state.sections,
            areas: state.areas,
            updateTask: state.updateTask,
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
        focusedTasks: globalFocusedTasks,
        projectMap,
        tasksById,
    } = getDerivedState();
    const { t } = useLanguage();
    const { requestConfirmation, confirmModal } = useConfirmDialog();
    const localDayKey = useLocalDayKey();
    const { showListDetails, focusGroupBy, setListOptions, collapseAllTaskDetails, setProjectView, showToast } = useUiStore((state) => ({
        showListDetails: state.listOptions.showDetails,
        focusGroupBy: state.listOptions.focusGroupBy,
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
            allTokens: getUsedTaskTokens(active, (task) => [...(task.contexts || []), ...(task.tags || [])], { includeAncestors: true }),
        };
    }, [baseActiveTasks, localDayKey, futureStartTick]);
    const priorityOptions: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
    const energyLevelOptions: TaskEnergyLevel[] = ['low', 'medium', 'high'];
    const timeEstimateOptions = TIME_ESTIMATE_OPTIONS;
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
                dotColor: getProjectAccentColor(project, areaById),
            }));
    }, [activeTasks, areaById, projects]);
    const showNoProjectOption = activeTasks.some((task) => !task.projectId);
    const formatEstimate = (value: TimeEstimate) => formatTimeEstimateLabel(value, { t });
    const savedFocusFilters = useMemo(() => selectFocusSavedFilters(settings?.savedFilters), [settings?.savedFilters]);
    const filterSelections = useTaskFilterSelections({
        view: 'focus',
        t,
        visibility: metadataFilterVisibility,
        savedFilters: savedFocusFilters,
        rawSavedFilters: settings?.savedFilters,
        onClear: resetFocusSort,
    });
    const {
        anyDateRange,
        setAnyDateRange,
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
    // A saved or stored 'priority' sort/group stops taking effect while
    // Priorities is off (the preference survives for re-enable) — otherwise
    // Focus would keep ordering and bucketing by a field hidden everywhere
    // else in the UI.
    const {
        effectiveSortBy: effectiveFocusSortBy,
        effectiveGroupBy: effectiveNextGroupBy,
        isDefaultPerspective: isDefaultFocusPerspective,
        canSavePerspective: canSaveFocusPerspective,
    } = resolveTaskPerspectiveForFeatures({
        sortBy: activeSavedFilter?.sortBy ?? focusSortBy,
        groupBy: normalizeAgendaGroupBy(activeSavedFilter?.groupBy ?? focusGroupBy),
        settings,
        hasActiveFilters: hasTaskFilters,
        hasCurrentCriteria: hasCurrentFilterCriteria,
        activeSavedFilterId,
    });
    const effectiveContextMatchMode = effectiveFilterCriteria.contextMatchMode ?? 'all';
    const effectiveTagMatchMode = effectiveFilterCriteria.tagMatchMode ?? 'all';
    const normalizedSearchQuery = searchQuery.trim().toLowerCase();
    const matchesSearchQuery = useCallback((title: string) => {
        if (!normalizedSearchQuery) return true;
        return title.toLowerCase().includes(normalizedSearchQuery);
    }, [normalizedSearchQuery]);
    const resolveText = useCallback((key: string, fallback: string) => {
        return translateWithFallback(t, key, fallback);
    }, [t]);
    const removeAdvancedSavedFilterCriterion = useCallback((chipId: string) => {
        // Saved-filter writes edit the list as stored when they are admitted: only the edited filter
        // changes, so a filter another device added, changed or deleted since stays as synced.
        const nowIso = new Date().toISOString();
        void updateSettingsFromLatest((latest) => planFocusFilterCriterionRemoval({
            activeSavedFilter,
            criterionId: chipId,
            savedFilters: latest.savedFilters,
            nowIso,
        })).catch(() => undefined);
    }, [activeSavedFilter]);
    const chipDeps = useMemo<ActiveFilterChipDeps>(() => ({
        t,
        resolveText,
        getProject: (projectId) => projectMap.get(projectId),
        getAreaColor: (areaId) => areaById.get(areaId)?.color,
        getAreaLabel: (areaId) => areaById.get(areaId)?.name,
    }), [areaById, projectMap, resolveText, t]);
    const removeSelectionChip = useCallback((chipId: string) => {
        if (chipId.startsWith('token:')) {
            // Picker tokens are tri-state; summary chips are direct removal
            // controls. Advancing twice clears included → excluded → neutral
            // without changing the picker cycle itself.
            const token = chipId.slice('token:'.length);
            toggleTokenFilter(token);
            toggleTokenFilter(token);
        } else if (chipId.startsWith('excluded-token:')) {
            toggleTokenFilter(chipId.slice('excluded-token:'.length));
        } else if (chipId.startsWith('project:')) {
            toggleProjectFilter(chipId.slice('project:'.length));
        } else if (chipId.startsWith('priority:')) {
            togglePriorityFilter(chipId.slice('priority:'.length) as TaskPriority);
        } else if (chipId.startsWith('energy:')) {
            toggleEnergyFilter(chipId.slice('energy:'.length) as TaskEnergyLevel);
        } else if (chipId.startsWith('time:')) {
            toggleTimeFilter(chipId.slice('time:'.length) as TimeEstimate);
        }
    }, [toggleEnergyFilter, togglePriorityFilter, toggleProjectFilter, toggleTimeFilter, toggleTokenFilter]);
    const activeFilterChips = useMemo<AgendaActiveFilterChip[]>(() => {
        const chips: AgendaActiveFilterChip[] = [];
        const normalizedSearch = searchQuery.trim();
        if (normalizedSearch) {
            chips.push({
                id: 'search',
                label: `${resolveText('filters.searchTasks', 'Search task titles')}: ${normalizedSearch}`,
                onRemove: () => setSearchQuery(''),
            });
        }
        // The pickers are tri-state here, so a chip's Remove maps back to the
        // hook action that clears that one value rather than to a criteria edit.
        buildSelectionChips(currentFilterCriteria, chipDeps).forEach((chip) => {
            if (chip.id.startsWith('priority:') && filterSelections.chips.some((item) => item.id === 'preserved:priority')) return;
            if (chip.id.startsWith('time:') && filterSelections.chips.some((item) => item.id === 'preserved:timeEstimates')) return;
            chips.push({ ...chip, onRemove: () => removeSelectionChip(chip.id) });
        });
        filterSelections.chips.filter((chip) => chip.id === 'anyDateRange' || chip.id.startsWith('advanced:') || chip.id.startsWith('preserved:')).forEach((chip) => {
            chips.push({ ...chip, onRemove: chip.onPress });
        });
        const normalizedLocationFilter = locationFilter.trim();
        if (normalizedLocationFilter && !activeSavedFilter && !filterSelections.chips.some((chip) => chip.id.startsWith('advanced:location:'))) {
            chips.push({
                id: `location:${normalizedLocationFilter}`,
                label: `${resolveText('taskEdit.locationLabel', 'Location')}: ${normalizedLocationFilter}`,
                onRemove: () => updateLocationFilter(''),
            });
        }
        if (activeSavedFilter) {
            // Advanced criteria come from the saved filter, not from the pickers,
            // so they are built from its own criteria and removed through it.
            chips.push(...buildAdvancedChips({ ...effectiveFilterCriteria, anyDateRange: undefined }, chipDeps).map((chip) => ({
                ...chip,
                onRemove: () => removeAdvancedSavedFilterCriterion(chip.id.slice('advanced:'.length)),
            })));
        }
        return chips;
    }, [
        activeSavedFilter,
        chipDeps,
        currentFilterCriteria,
        effectiveFilterCriteria,
        filterSelections.chips,
        removeSelectionChip,
        removeAdvancedSavedFilterCriterion,
        resolveText,
        searchQuery,
        locationFilter,
        setSearchQuery,
        updateLocationFilter,
    ]);
    const activeFilterCount = filterSelections.activeCount;
    const saveFilterDefaultName = getSavedFilterDefaultName(activeFilterChips, resolveText('savedFilters.defaultName', 'Focus filter'));

    const { focusPools, upcomingAppearsAtById, scheduleAppearsAtById } = useMemo(() => {
        void localDayKey;
        // Next Actions and Review due hide a later-today start until its time
        // arrives, so their pools have to leave a row the moment that time hits
        // rather than waiting for midnight.
        void futureStartTick;
        const now = new Date();
        const pools = buildFocusPools({
            tasks: globalFocusedTasks,
            visibleTasks: baseActiveTasks,
            isAreaVisible: (task) => taskMatchesAreaFilterSelection(task, resolvedAreaFilter, projectMap, areaById),
            projects,
            criteria: effectiveFilterCriteria,
            now,
            keep: (task) => matchesSearchQuery(task.title),
        });
        return {
            focusPools: pools,
            // Showing the date is the whole point of the section, so it rides the
            // row rather than the metadata that "show list details" hides.
            upcomingAppearsAtById: new Map(pools.upcoming.map((entry) => (
                [entry.task.id, safeFormatDate(entry.appearsAt, 'P')]
            ))),
            // A Today row whose timed start hasn't arrived yet gets the same
            // appears-at treatment as Upcoming, formatted as a time (it's today)
            // so it drops the moment the start passes.
            scheduleAppearsAtById: new Map(
                pools.schedule
                    .filter((task) => !shouldShowTaskForStart(task, { now, granularity: 'time' }))
                    .map((task) => [task.id, safeFormatDate(task.startTime, 'p')]),
            ),
        };
    }, [areaById, baseActiveTasks, effectiveFilterCriteria, futureStartTick, globalFocusedTasks, localDayKey, matchesSearchQuery, projectMap, projects, resolvedAreaFilter]);

    const focusHiddenByAreaLabel = getFocusHiddenByAreaLabel(focusPools.selection, t);
    useEffect(() => {
        if (!focusPools.selection.hiddenByAreaCount) return;
        void logInfo('Focus area selection projected', { scope: 'focus', force: true, context: {
            releaseCheck: 'v1.3.7/focus-area-selection',
            globalCount: focusPools.selection.globalCount, hiddenByAreaCount: focusPools.selection.hiddenByAreaCount,
        } });
    }, [focusPools.selection.globalCount, focusPools.selection.hiddenByAreaCount]);

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
    const shouldRenderFiltersPanel = filtersOpen || activeFilterCount > 0;
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
        if (activeSavedFilterId === filter.id) {
            clearAllFilters();
            return;
        }
        applySavedSelections(filter);
        setFocusSortBy(filter.sortBy ?? DEFAULT_FOCUS_SORT_BY);
        setFiltersOpen(false);
    }, [activeSavedFilterId, applySavedSelections, clearAllFilters]);
    const handleSaveFilterConfirm = useCallback((name: string) => {
        const trimmedName = name.trim();
        if (!trimmedName || !canSaveFocusPerspective) return;
        const nowIso = new Date().toISOString();
        const nextFilter: SavedFilter = {
            id: generateUUID(),
            name: trimmedName,
            view: 'focus',
            criteria: currentFilterCriteria,
            ...(effectiveFocusSortBy !== DEFAULT_FOCUS_SORT_BY ? { sortBy: effectiveFocusSortBy } : {}),
            ...(effectiveNextGroupBy !== 'none' ? { groupBy: effectiveNextGroupBy } : {}),
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        void updateSettingsFromLatest((latest) => ({
            savedFilters: [...(latest.savedFilters ?? []), nextFilter],
        })).then(() => {
            setSaveFilterPromptOpen(false);
            applySavedSelections(nextFilter);
        }).catch(() => undefined);
    }, [applySavedSelections, canSaveFocusPerspective, currentFilterCriteria, effectiveFocusSortBy, effectiveNextGroupBy]);
    const handleDeleteSavedFilter = useCallback(async (filter: SavedFilter) => {
        const confirmed = await requestConfirmation({
            title: resolveText('savedFilters.deleteTitle', 'Delete saved filter?'),
            description: filter.name,
            confirmLabel: resolveText('common.delete', 'Delete'),
            cancelLabel: t('common.cancel'),
        });
        if (!confirmed) return;
        void updateSettingsFromLatest((latest) => ({ savedFilters: markSavedFilterDeleted(latest.savedFilters, filter.id) })).then(() => {
            if (activeSavedFilterId === filter.id) {
                unbindSavedFilter();
            }
        }).catch(() => undefined);
    }, [activeSavedFilterId, requestConfirmation, resolveText, t, unbindSavedFilter]);

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
    // Manual drag order (focusOrder) is a full-list concept, so dragging is only
    // enabled when all three hold: the sort is the default (an explicit or saved
    // sort takes over and disables dragging), no search query is active, and no
    // filter criteria are active. Reordering a filtered/searched subset would
    // write focusOrder indices 0..n over only the visible rows, leaving hidden
    // focused tasks with stale positions that surprise-interleave once the filter
    // clears. Clearing the filter is the correction path.
    const focusDragEnabled = effectiveFocusSortBy === DEFAULT_FOCUS_SORT_BY && !hasTaskFilters;

    // Today's Focus, Today, Review Due, Next actions and Upcoming, from the one
    // derivation the mobile screen and every widget payload also use.
    const sections = useMemo(() => {
        void localDayKey;
        return deriveFocusTaskLists(focusPools, {
            now: new Date(),
            projects,
            sections: projectSections,
            sortBy: effectiveFocusSortBy,
            prioritiesEnabled,
            sortOrder: activeSavedFilter?.sortOrder,
            focusIncludeStartDates: settings?.gtd?.focusIncludeStartDates,
        });
    }, [
        activeSavedFilter?.sortOrder,
        effectiveFocusSortBy,
        focusPools,
        localDayKey,
        prioritiesEnabled,
        projects,
        projectSections,
        settings?.gtd?.focusIncludeStartDates,
    ]);
    const focusedTasks = sections.focusedTasks;
    const nextActionGroups = useMemo(() => (
        groupTasks(effectiveNextGroupBy, { tasks: sections.nextActions, areas, projectMap, t, theme: settings?.theme })
    ), [areas, effectiveNextGroupBy, projectMap, sections.nextActions, settings?.theme, t]);
    const todayTaskGroups = useMemo(() => {
        void futureStartTick;
        void localDayKey;
        return splitTodayTasksByStartTime(sections.schedule, new Date());
    }, [futureStartTick, localDayKey, sections.schedule]);
    const orderedTodayTasks = useMemo(() => (
        [...todayTaskGroups.ready, ...todayTaskGroups.laterToday]
    ), [todayTaskGroups]);
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
    const visibleOtherSectionKeys: FocusSectionKey[] = [];
    if (sections.schedule.length > 0) visibleOtherSectionKeys.push('schedule');
    if (sections.nextActions.length > 0) visibleOtherSectionKeys.push('nextActions');
    if (sections.reviewDue.length > 0) visibleOtherSectionKeys.push('reviewDue');
    if (sections.upcoming.length > 0) visibleOtherSectionKeys.push('upcoming');
    if (reviewDueProjects.length > 0) visibleOtherSectionKeys.push('reviewProjects');
    const canToggleOtherSections = visibleOtherSectionKeys.length > 0;
    const collapseOtherSections = visibleOtherSectionKeys
        .some((sectionKey) => expandedSections[sectionKey]);

    // The keyboard scope walks exactly what is on screen, in render order:
    // collapsed sections and collapsed groups contribute no rows.
    const visibleTasks = useMemo(() => {
        const visible = expandedSections.focus ? [...focusedTasks] : [];
        if (expandedSections.schedule) visible.push(...orderedTodayTasks);
        if (expandedSections.nextActions) visible.push(...visibleNextActions);
        if (expandedSections.reviewDue) visible.push(...sections.reviewDue);
        if (expandedSections.upcoming) visible.push(...sections.upcoming);
        return visible;
    }, [
        expandedSections,
        focusedTasks,
        orderedTodayTasks,
        sections,
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
        void updateTask(taskId, action.patch).then((result) => {
            if (!result.success) showToast(result.error || t('task.updateFailed'), 'error');
        });
    }, [focusTaskLimit, showToast, t, tasksById, updateTask]);

    const buildFocusToggle = useCallback((task: Task) => {
        const isFocused = Boolean(task.isFocusedToday);
        const queued = isTaskFutureFocusCandidate(task);
        // Cheap cap-only gate at render time (rows are many); full eligibility
        // is enforced on click via the core focus-star module, which toasts
        // the blocked reason.
        const canToggle = isFocused || queued || focusedCount < focusTaskLimit;
        const title = isFocused
            ? t('agenda.removeFromFocus')
            : !queued && focusedCount >= focusTaskLimit
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

    const buildUpcomingFocusToggle = useCallback((task: Task) => {
        const toggle = buildFocusToggle(task);
        if (toggle.isFocused || isTaskFutureFocusCandidate(task)) return toggle;
        const title = getFocusStarBlockedText(t, { blockedReason: 'deferred' }, focusTaskLimit) ?? toggle.title;
        return { ...toggle, canToggle: false, title, ariaLabel: title };
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
    const toggleOtherSections = useCallback(() => {
        const expanded = !collapseOtherSections;
        setPersistedViewState((current) => ({
            ...current,
            expandedSections: {
                ...current.expandedSections,
                schedule: expanded,
                reviewDue: expanded,
                nextActions: expanded,
                upcoming: expanded,
                reviewProjects: expanded,
            },
        }));
    }, [collapseOtherSections, setPersistedViewState]);
    const nextActionsCount = sections.nextActions.length;
    const hasAgendaContent = focusedCount > 0
        || sections.schedule.length > 0
        || sections.nextActions.length > 0
        || sections.upcoming.length > 0
        || sections.reviewDue.length > 0
        || reviewDueProjects.length > 0;
    const pomodoroTasks = (() => {
        const ordered = [
            ...focusedTasks,
            ...orderedTodayTasks,
            ...sections.nextActions,
            ...sections.reviewDue,
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

    const todaysFocusSection = focusedCount > 0 ? (
        <div
            data-testid="todays-focus-section"
            className="rounded-xl border border-border/70 border-l-4 border-l-amber-400 bg-card/70 p-6 shadow-sm dark:border-border/60 dark:border-l-amber-400/80 dark:bg-card/60"
        >
            <h3 className={cn(expandedSections.focus && 'mb-4')}>
                <button
                    type="button"
                    onClick={() => toggleSection('focus')}
                    aria-expanded={expandedSections.focus}
                    aria-controls="agenda-section-focus"
                    className="flex w-full items-center gap-2 rounded-md text-left text-lg font-bold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                    {expandedSections.focus
                        ? <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                        : <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
                    <FocusStarIcon className="h-5 w-5" filled />
                    <span>{t('agenda.todaysFocus')}</span>
                    <span className="text-sm font-normal text-muted-foreground">
                        ({focusedCount}/{focusTaskLimit})
                    </span>
                </button>
            </h3>

            {focusHiddenByAreaLabel && <p className="mb-3 text-sm text-muted-foreground" data-testid="focus-hidden-by-area">{focusHiddenByAreaLabel}</p>}
            {expandedSections.focus && <div id="agenda-section-focus">{focusListBody}</div>}
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
                focusSortBy={effectiveFocusSortBy}
                canToggleOtherSections={canToggleOtherSections}
                collapseOtherSections={collapseOtherSections}
                onChangeGroupBy={updateFocusGroupBy}
                onChangeSortBy={updateFocusSortBy}
                onToggleFilters={() => setFiltersOpen((prev) => !prev)}
                onToggleDetails={handleToggleDetails}
                onToggleOtherSections={toggleOtherSections}
                resolveText={resolveText}
                showListDetails={showListDetails}
                t={t}
            />
            {savedFocusFilters.length > 0 && (
                <div className="flex items-center gap-2 overflow-x-auto pb-1">
                    <button
                        type="button"
                        onClick={clearAllFilters}
                        aria-pressed={isDefaultFocusPerspective}
                        className={cn(
                            'shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                            isDefaultFocusPerspective
                                ? 'border-primary bg-primary text-primary-foreground'
                                : 'border-border bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
                        )}
                    >
                        {resolveText('common.all', 'All')}
                    </button>
                    {savedFocusFilters.map((filter) => {
                        const isActive = activeSavedFilterId === filter.id;
                        return (
                            <SavedFocusFilterChip
                                key={filter.id}
                                filter={filter}
                                isActive={isActive}
                                onApply={applySavedFocusFilter}
                                onDelete={handleDeleteSavedFilter}
                                resolveText={resolveText}
                            />
                        );
                    })}
                </div>
            )}

            {pomodoroEnabled && <PomodoroPanel tasks={pomodoroTasks} />}

            {shouldRenderFiltersPanel && (
                <AgendaFiltersPanel
                    anyDateRange={anyDateRange}
                    onAnyDateRangeChange={setAnyDateRange}
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
                        {todayTaskGroups.ready.length > 0 && (
                            <AgendaTaskList
                                tasks={todayTaskGroups.ready}
                                buildFocusToggle={buildFocusToggle}
                                getAppearsAtLabel={getScheduleAppearsAtLabel}
                                showListDetails={showListDetails}
                                highlightTaskId={highlightTaskId}
                            />
                        )}
                        {todayTaskGroups.laterToday.length > 0 && (
                            <div className={cn(todayTaskGroups.ready.length > 0 && 'mt-4 border-t border-border/40 pt-3')}>
                                <h4 className="mb-2 px-1 text-sm font-semibold text-muted-foreground">
                                    {resolveText('agenda.laterToday', 'Later today')}
                                </h4>
                                <AgendaTaskList
                                    tasks={todayTaskGroups.laterToday}
                                    buildFocusToggle={buildFocusToggle}
                                    getAppearsAtLabel={getScheduleAppearsAtLabel}
                                    showListDetails={showListDetails}
                                    highlightTaskId={highlightTaskId}
                                />
                            </div>
                        )}
                    </AgendaCollapsibleSection>
                )}

                {effectiveNextGroupBy === 'none' ? (
                    sections.nextActions.length > 0 && (
                        <AgendaCollapsibleSection
                            title={t('agenda.nextActions')}
                            icon={ArrowRight}
                            color="text-muted-foreground"
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
                            color="text-muted-foreground"
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
                        areaById={areaById}
                    title={tFallback(t, 'agenda.reviewDueProjects', 'Projects to review')}
                    icon={Folder}
                    onProjectPress={handleOpenReviewProject}
                    projects={reviewDueProjects}
                    color="text-status-reference"
                    controlsId="agenda-section-reviewProjects"
                    expanded={expandedSections.reviewProjects}
                    onToggle={() => toggleSection('reviewProjects')}
                    t={t}
                />
            </div>

            {!hasAgendaContent && (
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
