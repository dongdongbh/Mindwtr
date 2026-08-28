import React, { memo, useState, useMemo, useDeferredValue, useEffect, useRef, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertTriangle, Folder, HelpCircle } from 'lucide-react';
import { buildProjectOrderMap,
    buildQuickAddParseOptions,
    buildQuickAddPreviewEntries,
    compareTasksByProjectThenOrder,
    createTaskFilterPredicate,
    DEFAULT_AREA_COLOR,
    formatTimeEstimateLabel,
    getQuickAddProjectInitialProps,
    getTaskMetadataFilterVisibility,
    getWaitingPerson,
    hasActiveFilterCriteria,
    isTaskInActiveProject,
    parseQuickAdd,
    getDefaultTaskAreaMode,
    getPersonOptionNames,
    resolveDefaultNewTaskAreaId,
    resolveFeatureFlags,
    shallow,
    shouldShowTaskForStart,
    sortTasksBy,
    TaskPriority,
    TimeEstimate,
    resolveI18nText,
    useTaskStore, tFallback,
    baseTextCollator,
    getInMemoryAppDataSnapshot,
} from '@mindwtr/core';
import type { FilterCriteria, Task, TaskStatus } from '@mindwtr/core';
import type { BulkOrganizeTaskUpdateInput } from '@mindwtr/core';
import type { TaskSortBy } from '@mindwtr/core';
import { ErrorBoundary } from '../ErrorBoundary';
import { ListEmptyState } from './list/ListEmptyState';
import { ListHeader } from './list/ListHeader';
import { BulkSelectionToolbar } from './list/BulkSelectionToolbar';
import { ListBulkActions } from './list/ListBulkActions';
import { ListFiltersPanel } from './list/ListFiltersPanel';
import { ListQuickAdd } from './list/ListQuickAdd';
import { QuickAddPreview } from '../QuickAddPreview';
import { PromptModal } from '../PromptModal';
import { TokenPickerModal } from '../TokenPickerModal';
import { InboxProcessor } from './InboxProcessor';
import { MindSweepModal, MindSweepTrigger } from '../MindSweepModal';
import { TaskBulkOrganizeModal } from './list/TaskBulkOrganizeModal';
import { useLanguage } from '../../contexts/language-context';
import { useKeybindings } from '../../contexts/keybinding-context';
import { useListCopilot } from './list/useListCopilot';
import { useUiStore } from '../../store/ui-store';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import { checkBudget } from '../../config/performanceBudgets';
import { useListViewOptimizations } from '../../hooks/useListViewOptimizations';
import { dispatchNavigateEvent } from '../../lib/navigation-events';
import { reportError } from '../../lib/report-error';
import { nextDensityMode } from '../../lib/density';
import { AREA_FILTER_ALL, AREA_FILTER_NONE, areaFilterSelectionToValue, isTaskVisibleInArea, projectMatchesAreaFilterSelection, taskMatchesAreaFilterSelection } from '@mindwtr/core';
import { useAreaVisibility } from '../../hooks/useVisibleTaskContext';
import { sortDoneTasksForListView } from './list/done-sort';
import { DONE_SORT_OPTIONS, LIST_END_GAP, VIEW_FILTER_INPUT } from './list/list-toolbar';
import {
    DONE_AXES,
    FOCUS_AXES,
    groupTasks,
    LIST_AXES,
    REFERENCE_AXES,
    SOMEDAY_AXES,
    type DoneGroupBy,
    type NextGroupBy,
    type ReferenceGroupBy,
    type SomedayGroupBy,
    type TaskGroup,
    type TaskListGroupBy,
} from './list/next-grouping';
import { GroupedTaskList } from './list/GroupedTaskSections';
import { useCollapsedGroupsViewState, useTaskGroupCollapse } from './list/useTaskGroupCollapse';
import {
    PRIORITY_FILTER_OPTIONS,
    TIME_ESTIMATE_FILTER_OPTIONS,
    useListFilterControls,
} from './list/list-filter-controls';
import { useListSelection } from './list/useListSelection';
import { StoreTaskItem } from './list/StoreTaskItem';
import {
    LIST_VIRTUALIZATION_THRESHOLD,
    LIST_VIRTUAL_HEADER_ESTIMATE,
    LIST_VIRTUAL_OVERSCAN_ROWS,
    LIST_VIRTUAL_ROW_ESTIMATE,
} from './list/virtual-list';
import { QuickAddSyntaxHint } from '../ui/QuickAddSyntaxHint';
import { useFutureStartRevealTick, useLocalDayKey } from '../../hooks/useLocalDayKey';
import { resolveDoneTaskSortBy, resolveNonDoneTaskSortBy } from '../../lib/task-list-sort';


interface ListViewProps {
    title: string;
    statusFilter: TaskStatus | 'all';
}

const EMPTY_PRIORITIES: TaskPriority[] = [];
const EMPTY_ESTIMATES: TimeEstimate[] = [];
const NEXT_WARNING_THRESHOLD = 15;
// Reference kept its own key from when it was the only collapsible list (#734);
// every other status gets its own, so collapsing Someday does not fold Next.
const getListViewStateStorageKey = (statusFilter: string) => (
    statusFilter === 'reference' ? 'mindwtr:view:reference:v1' : `mindwtr:view:list:${statusFilter}:v1`
);
// Same idea for the grouping axis: each list picks its own, so changing "Group
// by" on one no longer regroups the others (#1063).
const LIST_GROUP_BY_KEYS = {
    inbox: 'inboxGroupBy',
    next: 'nextGroupBy',
    waiting: 'waitingGroupBy',
    someday: 'somedayGroupBy',
} as const;
const getListGroupByKey = (statusFilter: string) => (
    LIST_GROUP_BY_KEYS[statusFilter as keyof typeof LIST_GROUP_BY_KEYS] ?? 'nextGroupBy'
);
type ShowToast = (
    message: string,
    tone?: 'success' | 'error' | 'info',
    durationMs?: number,
    action?: { label: string; onClick: () => void }
) => void;

// `message` is localized by the caller; the reportError label stays English (diagnostic).
export function reportArchivedTaskQueryFailure(error: unknown, showToast: ShowToast, message: string): void {
    reportError('Failed to load archived tasks', error);
    showToast(message, 'error');
}

export const ListView = memo(function ListView({ title, statusFilter }: ListViewProps) {
    const perf = usePerformanceMonitor('ListView');
    const {
        tasks,
        projects,
        areas,
        people,
        lastDataChangeAt,
        highlightTaskId,
    } = useTaskStore((state) => ({
        tasks: state.tasks,
        projects: state.projects,
        areas: state.areas,
        people: state.people,
        lastDataChangeAt: state.lastDataChangeAt,
        highlightTaskId: state.highlightTaskId,
    }), shallow);
    const settings = useTaskStore((state) => state.settings);
    const {
        updateSettings,
        addTask,
        addProject,
        updateTask,
        updateProject,
        deleteTask,
        restoreTask,
        batchMoveTasks,
        batchDeleteTasks,
        batchUpdateTasks,
        queryTasks,
        getDerivedState,
        setHighlightTask,
    } = useTaskStore((state) => ({
        updateSettings: state.updateSettings,
        addTask: state.addTask,
        addProject: state.addProject,
        updateTask: state.updateTask,
        updateProject: state.updateProject,
        deleteTask: state.deleteTask,
        restoreTask: state.restoreTask,
        batchMoveTasks: state.batchMoveTasks,
        batchDeleteTasks: state.batchDeleteTasks,
        batchUpdateTasks: state.batchUpdateTasks,
        queryTasks: state.queryTasks,
        getDerivedState: state.getDerivedState,
        setHighlightTask: state.setHighlightTask,
    }), shallow);
    const { t } = useLanguage();
    const { registerTaskListScope } = useKeybindings();
    const globalSortBy = (settings?.taskSortBy ?? 'default') as TaskSortBy;
    const density = settings?.appearance?.density ?? 'comfortable';
    const densityMode: 'comfortable' | 'compact' | 'condensed' =
        density === 'condensed' ? 'condensed' : density === 'compact' ? 'compact' : 'comfortable';
    // Memoized: the resolved selection is an object, and a fresh identity on
    // every render would invalidate every list memo downstream.
    const { areaById, projectById: metadataProjectMap, resolvedAreaFilter } = useAreaVisibility();
    const [newTaskTitle, setNewTaskTitle] = useState('');
    const [quickAddSyntaxOpen, setQuickAddSyntaxOpen] = useState(false);
    const [mindSweepOpen, setMindSweepOpen] = useState(false);
    const {
        criteria: listFilterCriteria,
        filtersOpen,
        selectedTokens,
        excludedTokens,
        selectedPriorities,
        selectedTimeEstimates,
        toggleToken: toggleTokenFilter,
        togglePriority: togglePriorityFilter,
        toggleEstimate: toggleTimeFilter,
        clearFilters,
        setFiltersOpen,
        setListFilters,
    } = useListFilterControls();
    const showToast = useUiStore((state) => state.showToast);
    const resolveText = useCallback((key: string, fallback: string) => {
        return resolveI18nText(t, key, { fallback });
    }, [t]);
    const showListDetails = useUiStore((state) => state.listOptions.showDetails);
    const groupByKey = getListGroupByKey(statusFilter);
    const nextGroupBy = useUiStore((state) => state.listOptions[groupByKey]);
    const referenceGroupBy = useUiStore((state) => state.listOptions.referenceGroupBy);
    const doneGroupBy = useUiStore((state) => state.listOptions.doneGroupBy);
    const doneSortBy = useUiStore((state) => state.listOptions.doneSortBy);
    const setListOptions = useUiStore((state) => state.setListOptions);
    const sortBy: TaskSortBy = statusFilter === 'done'
        ? resolveDoneTaskSortBy(globalSortBy, doneSortBy)
        : resolveNonDoneTaskSortBy(globalSortBy);
    const collapseAllTaskDetails = useUiStore((state) => state.collapseAllTaskDetails);
    const setProjectView = useUiStore((state) => state.setProjectView);
    const [baseTasks, setBaseTasks] = useState<Task[]>(() => (statusFilter === 'archived' ? [] : tasks));
    const queryCacheRef = useRef<Map<string, Task[]>>(new Map());
    const [selectedWaitingPerson, setSelectedWaitingPerson] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const addInputRef = useRef<HTMLInputElement>(null);
    const listScrollRef = useRef<HTMLDivElement>(null);
    const { collapsedGroups, setCollapsedGroups } = useCollapsedGroupsViewState(
        getListViewStateStorageKey(statusFilter),
        LIST_AXES,
    );
    const { priorities: prioritiesEnabled, timeEstimates: timeEstimatesEnabled } = resolveFeatureFlags(settings);
    const undoNotificationsEnabled = settings?.undoNotificationsEnabled !== false;
    const showQuickDone = statusFilter !== 'done' && statusFilter !== 'archived';
    const readOnly = statusFilter === 'done';
    const showViewFilterInput = statusFilter !== 'inbox';
    const normalizedSearchQuery = searchQuery.trim().toLowerCase();
    const listFilterableTasks = useMemo(() => {
        const allowDeferredProjectTasks = statusFilter === 'done' || statusFilter === 'archived';
        return baseTasks.filter((task) => {
            if (task.deletedAt) return false;
            if (statusFilter !== 'all' && task.status !== statusFilter) return false;
            if (!allowDeferredProjectTasks && !isTaskInActiveProject(task, metadataProjectMap)) return false;
            if (!taskMatchesAreaFilterSelection(task, resolvedAreaFilter, metadataProjectMap, areaById)) return false;
            return true;
        });
    }, [baseTasks, areaById, metadataProjectMap, resolvedAreaFilter, statusFilter]);
    const metadataFilterVisibility = useMemo(() => getTaskMetadataFilterVisibility(listFilterableTasks, {
        prioritiesEnabled,
        timeEstimatesEnabled,
    }), [listFilterableTasks, prioritiesEnabled, timeEstimatesEnabled]);
    const showPriorityFilters = metadataFilterVisibility.priority;
    const showTimeEstimateFilters = metadataFilterVisibility.timeEstimate;
    const activePriorities = showPriorityFilters ? selectedPriorities : EMPTY_PRIORITIES;
    const activeTimeEstimates = showTimeEstimateFilters ? selectedTimeEstimates : EMPTY_ESTIMATES;
    const activeListFilterCriteria = useMemo<FilterCriteria>(() => ({
        ...listFilterCriteria,
        priority: showPriorityFilters ? activePriorities : undefined,
        timeEstimates: showTimeEstimateFilters ? activeTimeEstimates : undefined,
        timeEstimateRange: showTimeEstimateFilters ? listFilterCriteria.timeEstimateRange : undefined,
    }), [
        activePriorities,
        activeTimeEstimates,
        listFilterCriteria,
        showPriorityFilters,
        showTimeEstimateFilters,
    ]);
    const defaultAreaMode = getDefaultTaskAreaMode(settings);
    const activeAreaFilterValue = areaFilterSelectionToValue(resolvedAreaFilter);
    const activeNewTaskAreaId = activeAreaFilterValue !== AREA_FILTER_ALL && activeAreaFilterValue !== AREA_FILTER_NONE
        ? activeAreaFilterValue
        : undefined;
    const defaultNewTaskAreaId = defaultAreaMode === 'active'
        ? activeNewTaskAreaId
        : resolveDefaultNewTaskAreaId(settings, areas);

    useEffect(() => {
        if (!perf.enabled) return;
        const timer = window.setTimeout(() => {
            checkBudget('ListView', perf.metrics, 'complex');
        }, 0);
        return () => window.clearTimeout(timer);
    }, [perf.enabled]);

    const [isProcessing, setIsProcessing] = useState(false);
    const [bulkOrganizeOpen, setBulkOrganizeOpen] = useState(false);
    const {
        allContexts,
        allTags,
        projectMap,
        sequentialProjectFirstTasks,
        tasksById,
        tokenCounts,
        nextCount,
    } = useListViewOptimizations(tasks, baseTasks, statusFilter, perf);
    const allTokens = Array.from(new Set([...allContexts, ...allTags])).sort();
    const personOptionNames = useMemo(
        () => getPersonOptionNames(people, tasks),
        [people, tasks],
    );
    const quickAddParseOptions = useMemo(
        () => buildQuickAddParseOptions(settings, { tasks, people }),
        [people, tasks, settings],
    );

    const {
        aiEnabled,
        copilotContext,
        copilotTags,
        pendingCopilotParts,
        applyCopilotPart,
        applyCopilotSuggestion,
        resetCopilot,
    } = useListCopilot({
        settings,
        newTaskTitle,
        allContexts,
        allTags,
    });

    const projectOrderMap = useMemo(() => buildProjectOrderMap(projects), [projects]);

    const sortByProjectOrder = useCallback(
        (items: Task[]) => [...items].sort(compareTasksByProjectThenOrder(projectOrderMap)),
        [projectOrderMap],
    );

    // For sequential projects, get only the first task to show in Next view

    useEffect(() => {
        perf.trackUseEffect();
        let cancelled = false;
        const status = statusFilter === 'all' ? undefined : statusFilter;
        const cacheKey = `${statusFilter}-${lastDataChangeAt}`;
        const cached = queryCacheRef.current.get(cacheKey);
        if (statusFilter !== 'archived') {
            const { activeTasksByStatus } = getDerivedState();
            const indexedTasks = statusFilter === 'all'
                ? tasks
                : activeTasksByStatus.get(statusFilter) ?? [];
            setBaseTasks(indexedTasks);
            queryCacheRef.current.set(cacheKey, indexedTasks);
            if (queryCacheRef.current.size > 10) {
                const firstKey = queryCacheRef.current.keys().next().value;
                if (firstKey) queryCacheRef.current.delete(firstKey);
            }
        } else if (cached) {
            setBaseTasks(cached);
            return;
        }
        if (statusFilter === 'archived') {
            queryTasks({
                status,
                includeArchived: status === 'archived',
                includeDeleted: false,
            }).then((result) => {
                if (cancelled) return;
                setBaseTasks(result);
                queryCacheRef.current.set(cacheKey, result);
                if (queryCacheRef.current.size > 10) {
                    const firstKey = queryCacheRef.current.keys().next().value;
                    if (firstKey) queryCacheRef.current.delete(firstKey);
                }
            }).catch((error) => {
                if (!cancelled) {
                    reportArchivedTaskQueryFailure(error, showToast, resolveText('archive.loadFailed', 'Failed to load archived tasks'));
                    setBaseTasks([]);
                }
            });
        }
        return () => {
            cancelled = true;
        };
    }, [statusFilter, queryTasks, getDerivedState, lastDataChangeAt, showToast, tasks]);

    useEffect(() => {
        setSearchQuery('');
    }, [statusFilter]);

    // The derived `projectMap` on purpose, not the hook's: it carries
    // tombstones, so a task under a just-deleted project stays hidden.
    const waitingVisibility = useMemo(
        () => ({ areaById, projectById: projectMap, resolvedAreaFilter }),
        [areaById, projectMap, resolvedAreaFilter],
    );
    const waitingPeople = useMemo(() => {
        if (statusFilter !== 'waiting') return [];
        const people = new Map<string, string>();
        for (const task of baseTasks) {
            if (task.status !== 'waiting') continue;
            if (!isTaskVisibleInArea(task, waitingVisibility)) continue;
            const person = getWaitingPerson(task);
            if (!person) continue;
            const key = person.toLowerCase();
            if (!people.has(key)) people.set(key, person);
        }
        return [...people.values()].sort((a, b) => baseTextCollator.compare(a, b));
    }, [baseTasks, statusFilter, waitingVisibility]);

    useEffect(() => {
        if (statusFilter !== 'waiting' && selectedWaitingPerson) {
            setSelectedWaitingPerson('');
            return;
        }
        if (!selectedWaitingPerson) return;
        const selectedKey = selectedWaitingPerson.toLowerCase();
        const exists = waitingPeople.some((person) => person.toLowerCase() === selectedKey);
        if (!exists) setSelectedWaitingPerson('');
    }, [selectedWaitingPerson, statusFilter, waitingPeople]);

    // Only show the filtering banner for user-driven filter changes.
    // Background task refreshes can still be deferred without shifting the list UI.
    // Compared as a serialized string, NOT by object identity: a sync-triggered
    // store replace rebuilds these inputs with identical values but fresh
    // identities, and an identity-compared deferred value would flash the
    // banner — shifting the whole list down a row — on every sync (#1079).
    const filterFeedbackKey = useMemo(() => JSON.stringify({
        statusFilter,
        filterCriteria: activeListFilterCriteria,
        resolvedAreaFilter,
        selectedWaitingPerson,
        normalizedSearchQuery,
    }), [
        statusFilter,
        activeListFilterCriteria,
        resolvedAreaFilter,
        selectedWaitingPerson,
        normalizedSearchQuery,
    ]);
    const deferredFilterFeedbackKey = useDeferredValue(filterFeedbackKey);
    const isFiltering = deferredFilterFeedbackKey !== filterFeedbackKey;

    const filterInputs = useMemo(() => ({
        baseTasks,
        statusFilter,
        filterCriteria: activeListFilterCriteria,
        sequentialProjectFirstTasks,
        projectMap,
        projects,
        sortBy,
        sortByProjectOrder,
        resolvedAreaFilter,
        areaById,
        selectedWaitingPerson,
    }), [
        baseTasks,
        statusFilter,
        activeListFilterCriteria,
        sequentialProjectFirstTasks,
        projectMap,
        projects,
        sortBy,
        sortByProjectOrder,
        resolvedAreaFilter,
        areaById,
        selectedWaitingPerson,
    ]);
    const deferredFilterInputs = useDeferredValue(filterInputs);
    const nextVisibilityEnabled = statusFilter === 'next';
    const nextVisibilityDayKey = useLocalDayKey(nextVisibilityEnabled);
    const nextVisibilityTick = useFutureStartRevealTick(baseTasks, nextVisibilityEnabled);

    const filteredTasks = useMemo(() => {
        perf.trackUseMemo();
        return perf.measure('filteredTasks', () => {
            const now = new Date();
            const allowDeferredProjectTasks =
                deferredFilterInputs.statusFilter === 'done'
                || deferredFilterInputs.statusFilter === 'archived';
            const criteriaPredicate = hasActiveFilterCriteria(deferredFilterInputs.filterCriteria)
                ? createTaskFilterPredicate(deferredFilterInputs.filterCriteria, {
                    projects: deferredFilterInputs.projects,
                    tokenMatchMode: 'all',
                })
                : null;
            const filtered = deferredFilterInputs.baseTasks.filter(t => {
                // Always filter out soft-deleted tasks
                if (t.deletedAt) return false;

                if (deferredFilterInputs.statusFilter !== 'all' && t.status !== deferredFilterInputs.statusFilter) return false;
                // Respect statusFilter (handled above).
                if (!allowDeferredProjectTasks && !isTaskInActiveProject(t, deferredFilterInputs.projectMap)) return false;
                if (!taskMatchesAreaFilterSelection(
                    t,
                    deferredFilterInputs.resolvedAreaFilter,
                    deferredFilterInputs.projectMap,
                    deferredFilterInputs.areaById
                )) return false;

                // Sequential project filter: for 'next' status, only show first task from sequential projects
                if (deferredFilterInputs.statusFilter === 'next' && t.projectId) {
                    const project = deferredFilterInputs.projectMap.get(t.projectId);
                    if (project?.isSequential) {
                        // Only include if this is the first task
                        if (!deferredFilterInputs.sequentialProjectFirstTasks.has(t.id)) return false;
                    }
                }


                if (criteriaPredicate && !criteriaPredicate(t)) return false;
                if (deferredFilterInputs.statusFilter === 'waiting' && deferredFilterInputs.selectedWaitingPerson) {
                    const person = getWaitingPerson(t);
                    if (!person || person.toLowerCase() !== deferredFilterInputs.selectedWaitingPerson.toLowerCase()) return false;
                }
                if (showViewFilterInput && normalizedSearchQuery && !t.title.toLowerCase().includes(normalizedSearchQuery)) {
                    return false;
                }

                // A task you cannot start yet is not a next action — it is a
                // tickler item. Deferral is the core predicate, so a recurring
                // chore that only carries a due date stays hidden here exactly
                // as it does in Focus, instead of respawning into Next the
                // moment it is completed (#843, #867, #900).
                if (
                    deferredFilterInputs.statusFilter === 'next'
                    && !shouldShowTaskForStart(t, { now, granularity: 'time' })
                ) {
                    return false;
                }
                return true;
            });

            if (deferredFilterInputs.statusFilter === 'next' && deferredFilterInputs.sortBy === 'default') {
                return deferredFilterInputs.sortByProjectOrder(filtered);
            }
            if (deferredFilterInputs.statusFilter === 'done' && deferredFilterInputs.sortBy === 'default') {
                return sortDoneTasksForListView(filtered);
            }

            return sortTasksBy(filtered, deferredFilterInputs.sortBy);
        });
    }, [deferredFilterInputs, nextVisibilityDayKey, nextVisibilityTick, normalizedSearchQuery, showViewFilterInput]);
    const activeNextGroupBy: NextGroupBy = statusFilter !== 'reference' && statusFilter !== 'done' && statusFilter !== 'someday'
        ? nextGroupBy as NextGroupBy
        : 'none';
    const activeSomedayGroupBy: SomedayGroupBy = statusFilter === 'someday'
        ? nextGroupBy as SomedayGroupBy
        : 'none';
    const activeReferenceGroupBy: ReferenceGroupBy = statusFilter === 'reference' ? (referenceGroupBy ?? 'area') : 'none';
    const activeDoneGroupBy: DoneGroupBy = statusFilter === 'done' ? (doneGroupBy ?? 'none') : 'none';
    const activeGroupBy: TaskListGroupBy = statusFilter === 'reference'
        ? activeReferenceGroupBy
        : statusFilter === 'done'
            ? activeDoneGroupBy
            : statusFilter === 'someday'
                ? activeSomedayGroupBy
                : activeNextGroupBy;
    const completedGroupingDayKey = useLocalDayKey(activeDoneGroupBy === 'completedDate');
    const groupByOptions: readonly TaskListGroupBy[] = statusFilter === 'reference'
        ? REFERENCE_AXES
        : statusFilter === 'done'
            ? DONE_AXES
            : statusFilter === 'someday'
                ? SOMEDAY_AXES
                : FOCUS_AXES;
    const isListGrouping = activeGroupBy !== 'none';
    const groupedTasks = useMemo(() => (
        isListGrouping
            ? groupTasks(activeGroupBy, {
                tasks: filteredTasks,
                areas,
                projectMap,
                t,
                theme: settings?.theme,
                viewSectionDefinitions: settings?.gtd?.viewSections?.someday,
            })
            : [] as TaskGroup[]
    ), [activeGroupBy, areas, completedGroupingDayKey, filteredTasks, isListGrouping, projectMap, settings?.gtd?.viewSections?.someday, settings?.theme, t]);
    const {
        collapsedGroupIds,
        getSectionDomId,
        toggleGroup,
        virtualRows: groupedVirtualRows,
        // What the keyboard, "Select all" and the selection indices walk.
        // Grouping reorders rows, and a collapsed group renders none (#963).
        visibleTasks,
    } = useTaskGroupCollapse({
        axis: activeGroupBy,
        groups: groupedTasks,
        tasks: filteredTasks,
        idPrefix: `${statusFilter}-group`,
        collapsedGroups,
        setCollapsedGroups,
    });
    const firstGroupedRowIndexByTaskId = useMemo(() => {
        const indices = new Map<string, number>();
        groupedVirtualRows?.forEach((row, index) => {
            if (row.kind === 'task' && !indices.has(row.task.id)) {
                indices.set(row.task.id, index);
            }
        });
        return indices;
    }, [groupedVirtualRows]);
    const taskIndexById = useMemo(() => {
        const map = new Map<string, number>();
        visibleTasks.forEach((task, index) => map.set(task.id, index));
        return map;
    }, [visibleTasks]);

    // useListSelection's reveal effect looks the highlighted task up in
    // visibleTasks, which a collapsed group contributes nothing to — so a task
    // sent here by global search (#916) was never scrolled to or flashed. Unfold
    // its group first; the reveal then happens on the next pass.
    useEffect(() => {
        if (!highlightTaskId || !isListGrouping) return;
        // Tag/context grouping can render one task in several groups. Once one
        // containing group is open the row is already reachable; preserve every
        // other collapsed preference instead of unfolding them one per render.
        if (visibleTasks.some((task) => task.id === highlightTaskId)) return;
        const collapsedGroup = groupedTasks.find((group) => (
            collapsedGroupIds.has(group.id) && group.tasks.some((task) => task.id === highlightTaskId)
        ));
        if (collapsedGroup) toggleGroup(collapsedGroup.id);
    }, [collapsedGroupIds, groupedTasks, highlightTaskId, isListGrouping, toggleGroup, visibleTasks]);

    const showDeferredProjects = statusFilter === 'someday' || statusFilter === 'waiting';
    const deferredProjects = showDeferredProjects
        ? [...projects]
            .filter((project) => !project.deletedAt && project.status === statusFilter)
            .filter((project) => projectMatchesAreaFilterSelection(project, resolvedAreaFilter, areaById))
            .sort((a, b) => (a.order - b.order) || a.title.localeCompare(b.title))
        : [];
    const showDeferredProjectSection = showDeferredProjects && deferredProjects.length > 0;
    const showEmptyState = filteredTasks.length === 0 && !showDeferredProjectSection;
    const handleOpenProject = useCallback((projectId: string) => {
        setProjectView({ selectedProjectId: projectId });
        dispatchNavigateEvent('projects');
    }, [setProjectView]);
    const handleReactivateProject = useCallback((projectId: string) => {
        updateProject(projectId, { status: 'active' })
            .catch((error) => {
                reportError('Failed to reactivate project', error);
                showToast(tFallback(t, 'projects.reactivateFailed', 'Failed to reactivate project'), 'error');
            });
    }, [showToast, t, updateProject]);
    const virtualRowCount = groupedVirtualRows?.length ?? filteredTasks.length;
    const shouldVirtualize = virtualRowCount > LIST_VIRTUALIZATION_THRESHOLD;
    const rowVirtualizer = useVirtualizer({
        count: shouldVirtualize ? virtualRowCount : 0,
        getScrollElement: () => listScrollRef.current,
        estimateSize: (index) => (
            groupedVirtualRows?.[index]?.kind === 'header'
                ? LIST_VIRTUAL_HEADER_ESTIMATE
                : densityMode === 'condensed'
                    ? 72
                    : densityMode === 'compact'
                        ? 90
                        : LIST_VIRTUAL_ROW_ESTIMATE
        ),
        overscan: LIST_VIRTUAL_OVERSCAN_ROWS,
        getItemKey: (index) => {
            const row = groupedVirtualRows?.[index];
            if (!row) return filteredTasks[index]?.id ?? index;
            if (!row) return index;
            return row.kind === 'header'
                ? `group:${row.group.id}`
                : `task:${row.group.id}:${row.task.id}`;
        },
    });
    const {
        contextPromptMode,
        contextPromptOpen,
        handleBatchAddContext,
        handleBatchAddTag,
        handleBatchAssignArea,
        handleBatchDelete,
        handleBatchMove,
        handleBatchRemoveContext,
        handleBatchRemoveTag,
        handleConfirmContextPrompt,
        handleConfirmRemoveTags,
        handleConfirmTagPrompt,
        handleSelectIndex,
        isBatchDeleting,
        isBulkOrganizing,
        allVisibleTasksSelected,
        clearTaskSelection,
        multiSelectedIds,
        organizeSelectedTasks,
        removableTagOptions,
        removeTagPickerOpen,
        selectedIdsArray,
        selectedIndex,
        selectAllVisibleTasks,
        selectionMode,
        setContextPromptOpen,
        setRemoveTagPickerOpen,
        setTagPromptOpen,
        tagPromptOpen,
        toggleMultiSelect,
        toggleSelectionMode,
    } = useListSelection({
        addInputRef,
        batchDeleteTasks,
        batchMoveTasks,
        batchUpdateTasks,
        filteredTasks: visibleTasks,
        highlightTaskId,
        isProcessing,
        registerTaskListScope,
        restoreTask,
        scrollToVirtualIndex: (index, align) => {
            const taskId = visibleTasks[index]?.id;
            const virtualIndex = isListGrouping && taskId
                ? firstGroupedRowIndexByTaskId.get(taskId) ?? index
                : index;
            rowVirtualizer.scrollToIndex(virtualIndex, { align });
        },
        selectionResetKey: [
            statusFilter,
            prioritiesEnabled ? '1' : '0',
            timeEstimatesEnabled ? '1' : '0',
            selectedTokens.join('|'),
            excludedTokens.join('|'),
            selectedPriorities.join('|'),
            selectedTimeEstimates.join('|'),
            selectedWaitingPerson,
            activeNextGroupBy,
        ].join('::'),
        setHighlightTask,
        shouldVirtualize,
        showToast,
        t,
        tasksById,
        undoNotificationsEnabled,
    });
    const bulkAreaOptions = [...areas]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((area) => ({ id: area.id, name: area.name }));
    const handleApplyTaskBulkOrganize = useCallback(async (input: BulkOrganizeTaskUpdateInput) => {
        const selectedCount = selectedIdsArray.length;
        await organizeSelectedTasks(input, {
            afterSuccess: () => {
            setBulkOrganizeOpen(false);
            const message = resolveI18nText(t, 'bulk.organizeApplied', {
                fallback: '{{count}} selected tasks organized',
                values: { count: selectedCount },
            });
            showToast(message, 'success');
            },
        });
    }, [
        organizeSelectedTasks,
        selectedIdsArray,
        showToast,
        t,
    ]);

    const handleAddTask = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newTaskTitle.trim()) return;
        try {
            const { title: parsedTitle, props, projectTitle, invalidDateCommands, detectedDate } = parseQuickAdd(
                newTaskTitle,
                projects,
                new Date(),
                areas,
                quickAddParseOptions,
            );
            if (invalidDateCommands && invalidDateCommands.length > 0) {
                showToast(`${t('quickAdd.invalidDateCommand')}: ${invalidDateCommands.join(', ')}`, 'error');
                return;
            }
            const initialProps: Partial<Task> = { ...props };
            const shouldApplyDetectedDate = Boolean(detectedDate?.date && !initialProps.dueDate);
            if (shouldApplyDetectedDate && detectedDate) {
                initialProps.dueDate = detectedDate.date;
            }
            const finalTitle = shouldApplyDetectedDate && detectedDate
                ? detectedDate.titleWithoutDate
                : (parsedTitle || newTaskTitle);
            if (!initialProps.projectId && projectTitle) {
                const created = await addProject(
                    projectTitle,
                    DEFAULT_AREA_COLOR,
                    getQuickAddProjectInitialProps(initialProps, defaultNewTaskAreaId),
                );
                if (!created) return;
                initialProps.projectId = created.id;
            }
            if (!initialProps.projectId && !initialProps.areaId && defaultNewTaskAreaId) {
                initialProps.areaId = defaultNewTaskAreaId;
            }
            // Only set status if we have an explicit filter and parser didn't set one
            if (!initialProps.status && statusFilter !== 'all') {
                initialProps.status = statusFilter;
            }
            if (copilotContext) {
                const existing = initialProps.contexts ?? [];
                initialProps.contexts = Array.from(new Set([...existing, copilotContext]));
            }
            if (copilotTags.length) {
                const existingTags = initialProps.tags ?? [];
                initialProps.tags = Array.from(new Set([...existingTags, ...copilotTags]));
            }
            const result = await addTask(finalTitle, initialProps);
            setNewTaskTitle('');
            resetCopilot();
            // Flash + scroll the freshly created row into view so a batch-entered
            // task added far down a sorted/filtered list is not lost. Reuses the
            // shared highlightTaskId machinery (useListSelection scrolls it to
            // centre and auto-clears; TaskItem paints the flash). Focus stays in
            // the add input, so rapid entry is uninterrupted. If the task is
            // filtered out of the current view, useListSelection finds no row and
            // never scrolls (#916).
            if (result?.success && result.id) {
                setHighlightTask(result.id);
            }
        } catch (error) {
            reportError('Failed to add task from quick add', error);
            showToast(tFallback(t, 'task.addFailed', 'Failed to add task'), 'error');
        }
    };

    // Inbox added per #956: the filter criteria are shared across views, so a
    // selection made in Someday kept narrowing the Inbox with nothing in the
    // toolbar to show what was active or clear it. Deliberately not a blanket
    // pass over every surface (#863) — Reference is still on the old list and
    // has the same gap.
    const showFilters = ['next', 'all', 'done', 'waiting', 'someday', 'inbox'].includes(statusFilter);
    const isInbox = statusFilter === 'inbox';
    const isNextView = statusFilter === 'next';
    const isWaitingView = statusFilter === 'waiting';
    const showQuickAdd = isInbox;
    // Live parse of the draft, with the options handleAddTask submits with, so
    // the strip can never claim something the save would not do.
    const quickAddPreviewEntries = useMemo(() => {
        if (!showQuickAdd || !newTaskTitle.trim()) return [];
        return buildQuickAddPreviewEntries(
            parseQuickAdd(newTaskTitle, projects, new Date(), areas, quickAddParseOptions),
            { t, projects, areas, rawInput: newTaskTitle },
        );
    }, [areas, newTaskTitle, projects, quickAddParseOptions, showQuickAdd, t]);
    const priorityOptions = PRIORITY_FILTER_OPTIONS;
    const timeEstimateOptions = TIME_ESTIMATE_FILTER_OPTIONS;
    const formatEstimate = (value: TimeEstimate) => formatTimeEstimateLabel(value, { t });
    const filterSummary = [
        ...(normalizedSearchQuery ? [`${t('common.search')}: ${searchQuery.trim()}`] : []),
        ...selectedTokens,
        ...excludedTokens.map((token) => `${resolveText('filters.excluded', 'Excluded')}: ${token}`),
        ...(showPriorityFilters ? selectedPriorities.map((priority) => t(`priority.${priority}`)) : []),
        ...(showTimeEstimateFilters ? selectedTimeEstimates.map(formatEstimate) : []),
        ...(selectedWaitingPerson ? [`${t('process.delegateWhoLabel')}: ${selectedWaitingPerson}`] : []),
    ];
    const hasFilters = filterSummary.length > 0;
    const filterSummaryLabel = filterSummary.slice(0, 3).join(', ');
    const filterSummarySuffix = filterSummary.length > 3 ? ` +${filterSummary.length - 3}` : '';
    const showFiltersPanel = filtersOpen;

    useEffect(() => {
        let nextCriteria: FilterCriteria | null = null;
        if (!showPriorityFilters && selectedPriorities.length > 0) {
            nextCriteria = { ...(nextCriteria ?? listFilterCriteria) };
            delete nextCriteria.priority;
        }
        if (!showTimeEstimateFilters && selectedTimeEstimates.length > 0) {
            nextCriteria = { ...(nextCriteria ?? listFilterCriteria) };
            delete nextCriteria.timeEstimates;
            delete nextCriteria.timeEstimateRange;
        }
        if (nextCriteria) setListFilters({ criteria: nextCriteria });
    }, [listFilterCriteria, selectedPriorities.length, selectedTimeEstimates.length, setListFilters, showPriorityFilters, showTimeEstimateFilters]);

    const openQuickAdd = useCallback((status: TaskStatus | 'all', captureMode?: 'text' | 'audio') => {
        const initialStatus = status === 'all' ? 'inbox' : status;
        window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
            detail: { initialProps: { status: initialStatus }, captureMode },
        }));
    }, []);
    const openMindSweep = useCallback(() => setMindSweepOpen(true), []);
    const closeMindSweep = useCallback(() => setMindSweepOpen(false), []);

    const emptyState = (() => {
        switch (statusFilter) {
            case 'inbox':
                return {
                    title: tFallback(t, 'list.inbox', 'Inbox'),
                    body: resolveText('inbox.emptyAddHint', 'Inbox is clear. Capture something new.'),
                    action: tFallback(t, 'nav.addTask', 'Add task'),
                };
            case 'next':
                return {
                    title: tFallback(t, 'list.next', 'Next Actions'),
                    body: resolveText('list.noTasks', 'No next actions yet.'),
                };
            case 'waiting':
                return {
                    title: resolveText('waiting.empty', tFallback(t, 'list.waiting', 'Waiting')),
                    body: resolveText('waiting.emptyHint', 'Track delegated or pending items.'),
                };
            case 'someday':
                return {
                    title: resolveText('someday.empty', tFallback(t, 'list.someday', 'Someday')),
                    body: resolveText('someday.emptyHint', 'Store ideas for later.'),
                };
            case 'reference':
                return {
                    title: resolveText('reference.empty', tFallback(t, 'list.reference', 'Reference')),
                    body: resolveText('reference.emptyHint', 'Reference holds info you might want later — no action required.'),
                };
            case 'done':
                return {
                    title: tFallback(t, 'list.done', 'Done'),
                    body: resolveText('done.emptyHint', 'Completed tasks land here — a running log of what you finished.'),
                };
            default:
                return {
                    title: tFallback(t, 'list.tasks', 'Tasks'),
                    body: resolveText('list.noTasks', 'No tasks yet.'),
                };
        }
    })();
    const renderListTask = useCallback((task: Task) => {
        const index = taskIndexById.get(task.id) ?? 0;
        return (
            <StoreTaskItem
                key={task.id}
                taskId={task.id}
                isSelected={index === selectedIndex}
                index={index}
                onSelectIndex={handleSelectIndex}
                selectionMode={selectionMode}
                isMultiSelected={multiSelectedIds.has(task.id)}
                onToggleSelectId={toggleMultiSelect}
                showQuickDone={showQuickDone}
                readOnly={readOnly}
                compactMetaEnabled={showListDetails}
                showProjectBadgeInActions={false}
            />
        );
    }, [
        handleSelectIndex,
        multiSelectedIds,
        readOnly,
        selectedIndex,
        selectionMode,
        showListDetails,
        showQuickDone,
        taskIndexById,
        toggleMultiSelect,
    ]);
    // filteredTasks, NOT visibleTasks: collapsing a group hides rows, it does not
    // narrow the query, so a collapsed group still exports (#1096).
    const handleExportCsv = useCallback(async () => {
        try {
            // Imported lazily: data-transfer drags in the sync service and both
            // storage adapters, which the list has no other reason to load.
            const { exportDesktopCsv } = await import('../../lib/data-transfer');
            await exportDesktopCsv(getInMemoryAppDataSnapshot(), filteredTasks);
            showToast(resolveText('settings.exportCsvSuccess', 'CSV exported successfully!'), 'success');
        } catch (error) {
            reportError('Failed to export filtered CSV', error);
            showToast(resolveText('settings.exportCsvFailed', 'Failed to export CSV'), 'error');
        }
    }, [filteredTasks, resolveText, showToast]);

    const handleToggleDetails = useCallback(() => {
        if (showListDetails) {
            collapseAllTaskDetails();
            setListOptions({ showDetails: false });
            return;
        }
        setListOptions({ showDetails: true });
    }, [collapseAllTaskDetails, setListOptions, showListDetails]);

    return (
        <ErrorBoundary>
            <div className="flex h-full flex-col">
                <div className="space-y-6">
                    <ListHeader
                        title={title}
                        showNextCount={isNextView}
                        nextCount={nextCount}
                        taskCount={filteredTasks.length}
                        hasFilters={hasFilters}
                        filterSummaryLabel={filterSummaryLabel}
                        filterSummarySuffix={filterSummarySuffix}
                        sortBy={sortBy}
                        onChangeSortBy={(value) => {
                            if (statusFilter === 'done') {
                                setListOptions({ doneSortBy: value });
                                return;
                            }
                            void updateSettings({ taskSortBy: value });
                        }}
                        showGroupBy
                        groupBy={activeGroupBy}
                        groupByOptions={groupByOptions}
                        sortByOptions={statusFilter === 'done' ? DONE_SORT_OPTIONS : undefined}
                        onChangeGroupBy={(value) => {
                            if (statusFilter === 'reference') {
                                setListOptions({ referenceGroupBy: value as ReferenceGroupBy });
                                return;
                            }
                            if (statusFilter === 'done') {
                                setListOptions({ doneGroupBy: value as DoneGroupBy });
                                return;
                            }
                            setListOptions({ [groupByKey]: value as NextGroupBy });
                        }}
                        showFiltersButton={showFilters}
                        filtersOpen={showFiltersPanel}
                        onToggleFilters={() => setFiltersOpen(!filtersOpen)}
                        selectionMode={selectionMode}
                        onToggleSelection={toggleSelectionMode}
                        showListDetails={showListDetails}
                        onToggleDetails={handleToggleDetails}
                        onExportCsv={() => { void handleExportCsv(); }}
                        densityMode={densityMode}
                        onToggleDensity={() => {
                            void updateSettings({
                                appearance: {
                                    density: nextDensityMode(densityMode),
                                },
                            });
                        }}
                        t={t}
                    />

                    {isBatchDeleting && (
                        <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                            {tFallback(t, 'bulk.deleting', 'Deleting selected tasks...')}
                        </div>
                    )}

                    {selectionMode && (
                        <div className="space-y-3">
                            <BulkSelectionToolbar
                                selectionCount={selectedIdsArray.length}
                                totalCount={filteredTasks.length}
                                allSelected={allVisibleTasksSelected}
                                onSelectAll={selectAllVisibleTasks}
                                onClearSelection={clearTaskSelection}
                                t={t}
                            />
                            {selectedIdsArray.length > 0 && (
                                <ListBulkActions
                                    selectionCount={selectedIdsArray.length}
                                    currentStatus={statusFilter}
                                    onMoveToStatus={handleBatchMove}
                                    onAssignArea={handleBatchAssignArea}
                                    areaOptions={bulkAreaOptions}
                                    onBulkOrganize={() => setBulkOrganizeOpen(true)}
                                    onAddTag={handleBatchAddTag}
                                    onRemoveTag={handleBatchRemoveTag}
                                    disableRemoveTag={removableTagOptions.length === 0}
                                    onAddContext={handleBatchAddContext}
                                    onRemoveContext={handleBatchRemoveContext}
                                    onDelete={handleBatchDelete}
                                    isDeleting={isBatchDeleting}
                                    t={t}
                                />
                            )}
                        </div>
                    )}

                    {isNextView && nextCount > NEXT_WARNING_THRESHOLD && (
                        <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 p-4">
                            <AlertTriangle className="mt-0.5 h-5 w-5 text-warning" />
                            <div>
                                <p className="font-medium text-warning">
                                    {nextCount} {t('next.warningCount')}
                                </p>
                                <p className="mt-1 text-sm text-muted-foreground">
                                    {t('next.warningHint')}
                                </p>
                            </div>
                        </div>
                    )}

                    {showDeferredProjectSection && (
                        <div className="rounded-lg border border-border bg-card/50 p-4">
                            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                {tFallback(t, 'projects.title', 'Projects')}
                            </div>
                            <div className="mt-3 space-y-2">
                                {deferredProjects.map((project) => {
                                    const projectArea = project.areaId ? areaById.get(project.areaId) : undefined;
                                    return (
                                        <div
                                            key={project.id}
                                            className="flex w-full items-center justify-between gap-3 rounded-md border border-border/60 bg-background px-3 py-2"
                                        >
                                            <button
                                                type="button"
                                                onClick={() => handleOpenProject(project.id)}
                                                className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-primary"
                                                aria-label={`${tFallback(t, 'projects.title', 'Project')}: ${project.title}`}
                                            >
                                                <Folder className="h-4 w-4 shrink-0" style={{ color: project.color }} />
                                                <span className="truncate text-sm font-medium text-foreground">{project.title}</span>
                                                {projectArea && (
                                                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                                        <span
                                                            className="h-2 w-2 rounded-full"
                                                            style={{ backgroundColor: projectArea.color || DEFAULT_AREA_COLOR }}
                                                        />
                                                        {projectArea.name}
                                                    </span>
                                                )}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => handleReactivateProject(project.id)}
                                                className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                                            >
                                                {t('projects.reactivate')}
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    <InboxProcessor
                        t={t}
                        isInbox={isInbox}
                        tasks={tasks}
                        projects={projects}
                        areas={areas}
                        settings={settings}
                        addTask={addTask}
                        addProject={addProject}
                        updateTask={updateTask}
                        deleteTask={deleteTask}
                        allContexts={allContexts}
                        allTags={allTags}
                        isProcessing={isProcessing}
                        setIsProcessing={setIsProcessing}
                        onOpenMindSweep={openMindSweep}
                    />

                    {showViewFilterInput && !isProcessing && (
                        <input
                            type="text"
                            data-view-filter-input
                            placeholder={t('common.search')}
                            aria-label={t('common.search')}
                            value={searchQuery}
                            onChange={(event) => setSearchQuery(event.target.value)}
                            className={VIEW_FILTER_INPUT}
                        />
                    )}

                    {isWaitingView && !isProcessing && (
                        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                            <span className="text-xs font-medium text-muted-foreground">{t('process.delegateWhoLabel')}</span>
                            <select
                                aria-label={t('process.delegateWhoLabel')}
                                value={selectedWaitingPerson}
                                onChange={(event) => setSelectedWaitingPerson(event.target.value)}
                                className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
                            >
                                <option value="">{t('common.all')}</option>
                                {waitingPeople.map((person) => (
                                    <option key={person} value={person}>
                                        {person}
                                    </option>
                                ))}
                            </select>
                            {selectedWaitingPerson && (
                                <button
                                    type="button"
                                    onClick={() => setSelectedWaitingPerson('')}
                                    className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                                >
                                    {t('common.clear')}
                                </button>
                            )}
                        </div>
                    )}

                    {showFilters && showFiltersPanel && !isProcessing && (
                        <ListFiltersPanel
                            t={t}
                            hasFilters={hasFilters}
                            onClearFilters={clearFilters}
                            allTokens={allTokens}
                            selectedTokens={selectedTokens}
                            excludedTokens={excludedTokens}
                            tokenCounts={tokenCounts}
                            onToggleToken={toggleTokenFilter}
                            showPriorityFilters={showPriorityFilters}
                            priorityOptions={priorityOptions}
                            selectedPriorities={selectedPriorities}
                            onTogglePriority={togglePriorityFilter}
                            showTimeEstimateFilters={showTimeEstimateFilters}
                            timeEstimateOptions={timeEstimateOptions}
                            selectedTimeEstimates={selectedTimeEstimates}
                            onToggleEstimate={toggleTimeFilter}
                            formatEstimate={formatEstimate}
                        />
                    )}

                    {showQuickAdd && (
                        <>
                            <ListQuickAdd
                                value={newTaskTitle}
                                inputRef={addInputRef}
                                projects={projects}
                                areas={areas}
                                contexts={allTokens}
                                people={personOptionNames}
                                t={t}
                                dense={densityMode !== 'comfortable'}
                                onCreateProject={async (title) => {
                                    const created = await addProject(
                                        title,
                                        DEFAULT_AREA_COLOR,
                                        getQuickAddProjectInitialProps({}, defaultNewTaskAreaId),
                                    );
                                    return created?.id ?? null;
                                }}
                                onChange={setNewTaskTitle}
                                onSubmit={handleAddTask}
                                onOpenAudio={() => openQuickAdd(statusFilter, 'audio')}
                                onResetCopilot={resetCopilot}
                            />
                            {aiEnabled && pendingCopilotParts.length > 0 && (
                                <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded border border-border bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
                                    <span>✨ {t('copilot.suggested')}</span>
                                    {pendingCopilotParts.map((part) => (
                                        <button
                                            key={`${part.kind}:${part.value}`}
                                            type="button"
                                            onClick={() => applyCopilotPart(part)}
                                            className="rounded bg-muted/50 px-1.5 py-0.5 text-foreground transition-colors hover:bg-muted"
                                        >
                                            {part.value}
                                        </button>
                                    ))}
                                    {pendingCopilotParts.length > 1 && (
                                        <button
                                            type="button"
                                            onClick={applyCopilotSuggestion}
                                            className="rounded px-1.5 py-0.5 text-primary transition-colors hover:bg-primary/10"
                                        >
                                            {t('copilot.applyAll')}
                                        </button>
                                    )}
                                    <span className="text-muted-foreground/70">{t('copilot.applyHint')}</span>
                                </div>
                            )}
                            {aiEnabled && (copilotContext || copilotTags.length > 0) && (
                                <div className="mt-2 rounded border border-border bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
                                    ✅ {t('copilot.applied')}{' '}
                                    {copilotContext ? `${copilotContext} ` : ''}
                                    {copilotTags.length ? copilotTags.join(' ') : ''}
                                </div>
                            )}
                            {!isProcessing && (
                                <div className="mt-1 space-y-1 text-xs text-muted-foreground">
                                    <div className="flex min-w-0 items-center gap-1.5">
                                        {/* The preview takes the syntax hint's row rather than adding
                                            one: with a draft to describe it is the better use of the
                                            space, and the list below never shifts. */}
                                        <QuickAddPreview entries={quickAddPreviewEntries} className="min-w-0" />
                                        {quickAddPreviewEntries.length === 0 ? (
                                            <span className="min-w-0 truncate">
                                                {t('quickAdd.inlineHint')}
                                            </span>
                                        ) : null}
                                        <button
                                            type="button"
                                            onClick={() => setQuickAddSyntaxOpen((open) => !open)}
                                            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                                            aria-label={t('quickAdd.syntaxHelp')}
                                            aria-expanded={quickAddSyntaxOpen}
                                            title={t('quickAdd.help')}
                                        >
                                            <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
                                        </button>
                                    </div>
                                    {quickAddSyntaxOpen && (
                                        <p className="rounded border border-border bg-muted/30 px-2 py-1 leading-relaxed text-muted-foreground">
                                            <QuickAddSyntaxHint text={t('quickAdd.help')} />
                                        </p>
                                    )}
                                </div>
                            )}
                        </>
                    )}
                </div>
            <div
                ref={listScrollRef}
                className="flex-1 min-h-0 overflow-y-auto pt-3"
                role="list"
                aria-label={tFallback(t, 'list.tasks', 'Task list')}
            >
                {isFiltering && (
                    <div className="px-3 pb-2 text-xs text-muted-foreground">
                        {tFallback(t, 'list.filtering', 'Filtering...')}
                    </div>
                )}
                {showEmptyState ? (
                    <ListEmptyState
                        hasFilters={hasFilters}
                        emptyState={emptyState}
                        onAddTask={() => openQuickAdd(statusFilter)}
                        primaryAction={isInbox && !hasFilters
                            ? <MindSweepTrigger t={t} onOpen={openMindSweep} variant="primary" />
                            : undefined}
                        t={t}
                    />
                ) : (
                    <GroupedTaskList
                        groups={groupedTasks}
                        tasks={filteredTasks}
                        virtualRows={groupedVirtualRows}
                        virtualizer={shouldVirtualize ? rowVirtualizer : null}
                        collapsedGroupIds={collapsedGroupIds}
                        onToggleGroup={isListGrouping ? toggleGroup : undefined}
                        getSectionDomId={getSectionDomId}
                        flatRowClassName={densityMode === 'condensed'
                            ? 'pb-0.5'
                            : densityMode === 'compact'
                                ? 'pb-1'
                                : 'pb-1.5'}
                        renderTask={renderListTask}
                    />
                )}
                <div data-list-end className={LIST_END_GAP} aria-hidden="true" />
            </div>
        </div>
        <MindSweepModal
            isOpen={mindSweepOpen}
            onClose={closeMindSweep}
            t={t}
            addTask={addTask}
        />
        <PromptModal
            isOpen={tagPromptOpen}
            title={t('bulk.addTag')}
            description={t('bulk.addTag')}
            placeholder={t('bulk.tagPlaceholder')}
            defaultValue=""
            confirmLabel={t('common.save')}
            cancelLabel={t('common.cancel')}
            onCancel={() => setTagPromptOpen(false)}
            onConfirm={handleConfirmTagPrompt}
        />
        <PromptModal
            isOpen={contextPromptOpen}
            title={contextPromptMode === 'add' ? t('bulk.addContext') : t('bulk.removeContext')}
            description={contextPromptMode === 'add' ? t('bulk.addContext') : t('bulk.removeContext')}
            placeholder={t('bulk.contextPlaceholder')}
            defaultValue=""
            confirmLabel={t('common.save')}
            cancelLabel={t('common.cancel')}
            onCancel={() => setContextPromptOpen(false)}
            onConfirm={handleConfirmContextPrompt}
        />
        <TokenPickerModal
            isOpen={removeTagPickerOpen}
            title={t('bulk.removeTag')}
            description={t('bulk.removeTag')}
            tokens={removableTagOptions}
            placeholder={t('bulk.tagPlaceholder')}
            multiSelect
            confirmLabel={t('common.save')}
            cancelLabel={t('common.cancel')}
            onCancel={() => setRemoveTagPickerOpen(false)}
            onConfirm={handleConfirmRemoveTags}
        />
        <TaskBulkOrganizeModal
            isOpen={bulkOrganizeOpen}
            selectedCount={selectedIdsArray.length}
            projects={projects}
            areas={areas}
            isApplying={isBulkOrganizing}
            t={t}
            titleKey={isInbox ? 'bulk.organizeInbox' : 'bulk.organizeTasks'}
            titleFallback={isInbox ? 'Bulk organize Inbox' : 'Bulk organize tasks'}
            onCancel={() => setBulkOrganizeOpen(false)}
            onApply={handleApplyTaskBulkOrganize}
        />
        </ErrorBoundary>
    );
});
