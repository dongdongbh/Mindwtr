import React, { memo, useState, useMemo, useDeferredValue, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { AlertTriangle, Folder } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { shallow, useTaskStore, TaskPriority, TimeEstimate, DEFAULT_AREA_COLOR, sortTasksBy, parseQuickAdd, matchesHierarchicalToken, safeParseDate, isTaskInActiveProject, getWaitingPerson } from '@mindwtr/core';
import type { StoreActionResult, Task, TaskStatus } from '@mindwtr/core';
import type { TaskSortBy } from '@mindwtr/core';
import { TaskItem } from '../TaskItem';
import { ConfirmModal } from '../ConfirmModal';
import { ErrorBoundary } from '../ErrorBoundary';
import { ListEmptyState } from './list/ListEmptyState';
import { ListQuickAdd } from './list/ListQuickAdd';
import { PromptModal } from '../PromptModal';
import { InboxProcessor } from './InboxProcessor';
import { ListFiltersPanel } from './list/ListFiltersPanel';
import { ListHeader } from './list/ListHeader';
import { ListBulkActions } from './list/ListBulkActions';
import { useLanguage } from '../../contexts/language-context';
import { useKeybindings } from '../../contexts/keybinding-context';
import { useListCopilot } from './list/useListCopilot';
import { useUiStore } from '../../store/ui-store';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import { checkBudget } from '../../config/performanceBudgets';
import { useListViewOptimizations } from '../../hooks/useListViewOptimizations';
import { reportError } from '../../lib/report-error';
import { AREA_FILTER_ALL, AREA_FILTER_NONE, projectMatchesAreaFilter, resolveAreaFilter, taskMatchesAreaFilter } from '../../lib/area-filter';
import { cn } from '../../lib/utils';
import { sortDoneTasksForListView } from './list/done-sort';
import { groupTasksByArea, groupTasksByContext, type NextGroupBy, type TaskGroup } from './list/next-grouping';


interface ListViewProps {
    title: string;
    statusFilter: TaskStatus | 'all';
}

const EMPTY_PRIORITIES: TaskPriority[] = [];
const EMPTY_ESTIMATES: TimeEstimate[] = [];
const VIRTUALIZATION_THRESHOLD = 25;
const VIRTUAL_ROW_ESTIMATE = 120;
const VIRTUAL_OVERSCAN = 600;
const RESTORE_DELETED_TASKS_FAILED_MESSAGE = 'Failed to restore deleted tasks';

type ShowToast = (
    message: string,
    tone?: 'success' | 'error' | 'info',
    durationMs?: number,
    action?: { label: string; onClick: () => void }
) => void;

export async function restoreDeletedTasksWithFeedback(
    taskIds: string[],
    restoreTask: (taskId: string) => Promise<StoreActionResult>,
    showToast: ShowToast,
): Promise<void> {
    const results = await Promise.allSettled(taskIds.map((taskId) => restoreTask(taskId)));
    const failedRestore = results.find(
        (result): result is PromiseRejectedResult | PromiseFulfilledResult<StoreActionResult> =>
            result.status === 'rejected' || !result.value.success,
    );

    if (!failedRestore) return;

    const message = failedRestore.status === 'rejected'
        ? (failedRestore.reason instanceof Error ? failedRestore.reason.message : RESTORE_DELETED_TASKS_FAILED_MESSAGE)
        : (failedRestore.value.error || RESTORE_DELETED_TASKS_FAILED_MESSAGE);
    const error = failedRestore.status === 'rejected'
        ? failedRestore.reason
        : new Error(message);

    reportError(RESTORE_DELETED_TASKS_FAILED_MESSAGE, error);
    showToast(message, 'error');
}

export function reportArchivedTaskQueryFailure(error: unknown, showToast: ShowToast): void {
    reportError('Failed to load archived tasks', error);
    showToast('Failed to load archived tasks', 'error');
}

export const ListView = memo(function ListView({ title, statusFilter }: ListViewProps) {
    const perf = usePerformanceMonitor('ListView');
    const {
        tasks,
        projects,
        areas,
        settings,
        updateSettings,
        addTask,
        addProject,
        updateTask,
        updateProject,
        deleteTask,
        restoreTask,
        moveTask,
        batchMoveTasks,
        batchDeleteTasks,
        batchUpdateTasks,
        queryTasks,
        lastDataChangeAt,
        highlightTaskId,
        setHighlightTask,
    } = useTaskStore((state) => ({
        tasks: state.tasks,
        projects: state.projects,
        areas: state.areas,
        settings: state.settings,
        updateSettings: state.updateSettings,
        addTask: state.addTask,
        addProject: state.addProject,
        updateTask: state.updateTask,
        updateProject: state.updateProject,
        deleteTask: state.deleteTask,
        restoreTask: state.restoreTask,
        moveTask: state.moveTask,
        batchMoveTasks: state.batchMoveTasks,
        batchDeleteTasks: state.batchDeleteTasks,
        batchUpdateTasks: state.batchUpdateTasks,
        queryTasks: state.queryTasks,
        lastDataChangeAt: state.lastDataChangeAt,
        highlightTaskId: state.highlightTaskId,
        setHighlightTask: state.setHighlightTask,
    }), shallow);
    const { t } = useLanguage();
    const { registerTaskListScope } = useKeybindings();
    const sortBy = (settings?.taskSortBy ?? 'default') as TaskSortBy;
    const isCompact = settings?.appearance?.density === 'compact';
    const densityMode = isCompact ? 'compact' : 'comfortable';
    const resolvedAreaFilter = useMemo(
        () => resolveAreaFilter(settings?.filters?.areaId, areas),
        [settings?.filters?.areaId, areas],
    );
    const [newTaskTitle, setNewTaskTitle] = useState('');
    const listFilters = useUiStore((state) => state.listFilters);
    const setListFilters = useUiStore((state) => state.setListFilters);
    const resetListFilters = useUiStore((state) => state.resetListFilters);
    const showToast = useUiStore((state) => state.showToast);
    const translateWithFallback = useCallback((key: string, fallback: string) => {
        const value = t(key);
        return value === key ? fallback : value;
    }, [t]);
    const showListDetails = useUiStore((state) => state.listOptions.showDetails);
    const nextGroupBy = useUiStore((state) => state.listOptions.nextGroupBy);
    const setListOptions = useUiStore((state) => state.setListOptions);
    const setProjectView = useUiStore((state) => state.setProjectView);
    const [baseTasks, setBaseTasks] = useState<Task[]>(() => (statusFilter === 'archived' ? [] : tasks));
    const queryCacheRef = useRef<Map<string, Task[]>>(new Map());
    const selectedTokens = listFilters.tokens;
    const selectedPriorities = listFilters.priorities;
    const selectedTimeEstimates = listFilters.estimates;
    const filtersOpen = listFilters.open;
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [selectionMode, setSelectionMode] = useState(false);
    const [multiSelectedIds, setMultiSelectedIds] = useState<Set<string>>(new Set());
    const [tagPromptOpen, setTagPromptOpen] = useState(false);
    const [tagPromptIds, setTagPromptIds] = useState<string[]>([]);
    const [contextPromptOpen, setContextPromptOpen] = useState(false);
    const [contextPromptMode, setContextPromptMode] = useState<'add' | 'remove'>('add');
    const [contextPromptIds, setContextPromptIds] = useState<string[]>([]);
    const [selectedWaitingPerson, setSelectedWaitingPerson] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const lastFilterKeyRef = useRef<string>('');
    const pendingSelectionScrollRef = useRef(false);
    const addInputRef = useRef<HTMLInputElement>(null);
    const viewFilterInputRef = useRef<HTMLInputElement>(null);
    const listScrollRef = useRef<HTMLDivElement>(null);
    const [selectionScrollVersion, setSelectionScrollVersion] = useState(0);
    const prioritiesEnabled = settings?.features?.priorities !== false;
    const timeEstimatesEnabled = settings?.features?.timeEstimates !== false;
    const undoNotificationsEnabled = settings?.undoNotificationsEnabled !== false;
    const showQuickDone = statusFilter !== 'done' && statusFilter !== 'archived';
    const readOnly = statusFilter === 'done';
    const showViewFilterInput = statusFilter !== 'inbox';
    const normalizedSearchQuery = searchQuery.trim().toLowerCase();
    const activePriorities = useMemo(
        () => (prioritiesEnabled ? selectedPriorities : EMPTY_PRIORITIES),
        [prioritiesEnabled, selectedPriorities]
    );
    const activeTimeEstimates = useMemo(
        () => (timeEstimatesEnabled ? selectedTimeEstimates : EMPTY_ESTIMATES),
        [timeEstimatesEnabled, selectedTimeEstimates]
    );

    useEffect(() => {
        if (!perf.enabled) return;
        const timer = window.setTimeout(() => {
            checkBudget('ListView', perf.metrics, 'complex');
        }, 0);
        return () => window.clearTimeout(timer);
    }, [perf.enabled]);

    const exitSelectionMode = useCallback(() => {
        setSelectionMode(false);
        setMultiSelectedIds(new Set());
    }, []);

    const requestSelectionScroll = useCallback(() => {
        pendingSelectionScrollRef.current = true;
        setSelectionScrollVersion((current) => current + 1);
    }, []);

    const [isProcessing, setIsProcessing] = useState(false);
    const [isBatchDeleting, setIsBatchDeleting] = useState(false);
    const [pendingDeleteTask, setPendingDeleteTask] = useState<Task | null>(null);
    const [pendingBatchDeleteIds, setPendingBatchDeleteIds] = useState<string[]>([]);
    const {
        allContexts,
        allTags,
        projectMap,
        sequentialProjectFirstTasks,
        tasksById,
        tokenCounts,
        nextCount,
    } = useListViewOptimizations(tasks, baseTasks, statusFilter, perf);
    const allTokens = useMemo(() => {
        return Array.from(new Set([...allContexts, ...allTags])).sort();
    }, [allContexts, allTags]);

    const {
        aiEnabled,
        copilotSuggestion,
        copilotApplied,
        copilotContext,
        copilotTags,
        applyCopilotSuggestion,
        resetCopilot,
    } = useListCopilot({
        settings,
        newTaskTitle,
        allContexts,
        allTags,
    });

    const projectOrderMap = useMemo(() => {
        const sorted = [...projects]
            .filter((project) => !project.deletedAt)
            .sort((a, b) => {
                const aOrder = Number.isFinite(a.order) ? (a.order as number) : Number.POSITIVE_INFINITY;
                const bOrder = Number.isFinite(b.order) ? (b.order as number) : Number.POSITIVE_INFINITY;
                if (aOrder !== bOrder) return aOrder - bOrder;
                return a.title.localeCompare(b.title);
            });
        const map = new Map<string, number>();
        sorted.forEach((project, index) => map.set(project.id, index));
        return map;
    }, [projects]);

    const sortByProjectOrder = useCallback((items: Task[]) => {
        return [...items].sort((a, b) => {
            const aProjectOrder = a.projectId ? (projectOrderMap.get(a.projectId) ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
            const bProjectOrder = b.projectId ? (projectOrderMap.get(b.projectId) ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
            if (aProjectOrder !== bProjectOrder) return aProjectOrder - bProjectOrder;
            const aOrder = Number.isFinite(a.order)
                ? (a.order as number)
                : Number.isFinite(a.orderNum)
                    ? (a.orderNum as number)
                    : Number.POSITIVE_INFINITY;
            const bOrder = Number.isFinite(b.order)
                ? (b.order as number)
                : Number.isFinite(b.orderNum)
                    ? (b.orderNum as number)
                    : Number.POSITIVE_INFINITY;
            if (aOrder !== bOrder) return aOrder - bOrder;
            const aCreated = safeParseDate(a.createdAt)?.getTime() ?? 0;
            const bCreated = safeParseDate(b.createdAt)?.getTime() ?? 0;
            return aCreated - bCreated;
        });
    }, [projectOrderMap]);

    // For sequential projects, get only the first task to show in Next view

    useEffect(() => {
        perf.trackUseEffect();
        let cancelled = false;
        const status = statusFilter === 'all' ? undefined : statusFilter;
        const cacheKey = `${statusFilter}-${lastDataChangeAt}`;
        const cached = queryCacheRef.current.get(cacheKey);
        if (statusFilter !== 'archived') {
            setBaseTasks(tasks);
            queryCacheRef.current.set(cacheKey, tasks);
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
                    reportArchivedTaskQueryFailure(error, showToast);
                    setBaseTasks([]);
                }
            });
        }
        return () => {
            cancelled = true;
        };
    }, [statusFilter, queryTasks, lastDataChangeAt, showToast, tasks]);

    useEffect(() => {
        setSearchQuery('');
    }, [statusFilter]);

    const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
    const waitingPeople = useMemo(() => {
        if (statusFilter !== 'waiting') return [];
        const people = new Map<string, string>();
        for (const task of baseTasks) {
            if (task.deletedAt || task.status !== 'waiting') continue;
            if (!isTaskInActiveProject(task, projectMap)) continue;
            if (!taskMatchesAreaFilter(task, resolvedAreaFilter, projectMap, areaById)) continue;
            const person = getWaitingPerson(task);
            if (!person) continue;
            const key = person.toLowerCase();
            if (!people.has(key)) people.set(key, person);
        }
        return [...people.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    }, [areaById, baseTasks, projectMap, resolvedAreaFilter, statusFilter]);

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
    const filterFeedbackInputs = useMemo(() => ({
        statusFilter,
        selectedTokens,
        activePriorities,
        activeTimeEstimates,
        resolvedAreaFilter,
        selectedWaitingPerson,
        normalizedSearchQuery,
    }), [
        statusFilter,
        selectedTokens,
        activePriorities,
        activeTimeEstimates,
        resolvedAreaFilter,
        selectedWaitingPerson,
        normalizedSearchQuery,
    ]);
    const deferredFilterFeedbackInputs = useDeferredValue(filterFeedbackInputs);
    const isFiltering = deferredFilterFeedbackInputs !== filterFeedbackInputs;

    const filterInputs = useMemo(() => ({
        baseTasks,
        statusFilter,
        selectedTokens,
        activePriorities,
        activeTimeEstimates,
        sequentialProjectFirstTasks,
        projectMap,
        sortBy,
        sortByProjectOrder,
        resolvedAreaFilter,
        areaById,
        selectedWaitingPerson,
    }), [
        baseTasks,
        statusFilter,
        selectedTokens,
        activePriorities,
        activeTimeEstimates,
        sequentialProjectFirstTasks,
        projectMap,
        sortBy,
        sortByProjectOrder,
        resolvedAreaFilter,
        areaById,
        selectedWaitingPerson,
    ]);
    const deferredFilterInputs = useDeferredValue(filterInputs);

    const filteredTasks = useMemo(() => {
        perf.trackUseMemo();
        return perf.measure('filteredTasks', () => {
            const now = new Date();
            const allowDeferredProjectTasks =
                deferredFilterInputs.statusFilter === 'done'
                || deferredFilterInputs.statusFilter === 'archived';
            const filtered = deferredFilterInputs.baseTasks.filter(t => {
                // Always filter out soft-deleted tasks
                if (t.deletedAt) return false;

                if (deferredFilterInputs.statusFilter !== 'all' && t.status !== deferredFilterInputs.statusFilter) return false;
                // Respect statusFilter (handled above).
                if (!allowDeferredProjectTasks && !isTaskInActiveProject(t, deferredFilterInputs.projectMap)) return false;
                if (!taskMatchesAreaFilter(
                    t,
                    deferredFilterInputs.resolvedAreaFilter,
                    deferredFilterInputs.projectMap,
                    deferredFilterInputs.areaById
                )) return false;

                if (deferredFilterInputs.statusFilter === 'inbox') {
                    const start = safeParseDate(t.startTime);
                    if (start && start > now) return false;
                }
                if (deferredFilterInputs.statusFilter === 'next') {
                    const start = safeParseDate(t.startTime);
                    if (start && start > now) return false;
                }

                // Sequential project filter: for 'next' status, only show first task from sequential projects
                if (deferredFilterInputs.statusFilter === 'next' && t.projectId) {
                    const project = deferredFilterInputs.projectMap.get(t.projectId);
                    if (project?.isSequential) {
                        // Only include if this is the first task
                        if (!deferredFilterInputs.sequentialProjectFirstTasks.has(t.id)) return false;
                    }
                }


                const taskTokens = [...(t.contexts || []), ...(t.tags || [])];
                if (deferredFilterInputs.selectedTokens.length > 0) {
                    const matchesAll = deferredFilterInputs.selectedTokens.every((token) =>
                        taskTokens.some((taskToken) => matchesHierarchicalToken(token, taskToken))
                    );
                    if (!matchesAll) return false;
                }
                if (
                    deferredFilterInputs.activePriorities.length > 0
                    && (!t.priority || !deferredFilterInputs.activePriorities.includes(t.priority))
                ) return false;
                if (
                    deferredFilterInputs.activeTimeEstimates.length > 0
                    && (!t.timeEstimate || !deferredFilterInputs.activeTimeEstimates.includes(t.timeEstimate))
                ) return false;
                if (deferredFilterInputs.statusFilter === 'waiting' && deferredFilterInputs.selectedWaitingPerson) {
                    const person = getWaitingPerson(t);
                    if (!person || person.toLowerCase() !== deferredFilterInputs.selectedWaitingPerson.toLowerCase()) return false;
                }
                if (showViewFilterInput && normalizedSearchQuery && !t.title.toLowerCase().includes(normalizedSearchQuery)) {
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
    }, [deferredFilterInputs, normalizedSearchQuery, showViewFilterInput]);
    const resolveText = useCallback((key: string, fallback: string) => {
        const value = t(key);
        return value === key ? fallback : value;
    }, [t]);
    const activeNextGroupBy: NextGroupBy = statusFilter === 'next' ? nextGroupBy : 'none';
    const isReferenceAreaGrouping = statusFilter === 'reference';
    const isNextGrouping = statusFilter === 'next' && activeNextGroupBy !== 'none';
    const referenceAreaGroups = useMemo(() => {
        if (!isReferenceAreaGrouping) return [] as TaskGroup[];
        return groupTasksByArea({
            areas,
            tasks: filteredTasks,
            projectMap,
            generalLabel: resolveText('settings.general', 'General'),
        });
    }, [areas, filteredTasks, isReferenceAreaGrouping, projectMap, resolveText]);
    const nextGroups = useMemo(() => {
        if (!isNextGrouping) return [] as TaskGroup[];
        if (activeNextGroupBy === 'area') {
            return groupTasksByArea({
                areas,
                tasks: filteredTasks,
                projectMap,
                generalLabel: resolveText('settings.general', 'General'),
            });
        }
        return groupTasksByContext({
            tasks: filteredTasks,
            noContextLabel: resolveText('contexts.none', 'No context'),
        });
    }, [activeNextGroupBy, areas, filteredTasks, isNextGrouping, projectMap, resolveText]);
    const groupedTasks = isReferenceAreaGrouping ? referenceAreaGroups : nextGroups;
    const taskIndexById = useMemo(() => {
        const map = new Map<string, number>();
        filteredTasks.forEach((task, index) => map.set(task.id, index));
        return map;
    }, [filteredTasks]);

    const showDeferredProjects = statusFilter === 'someday' || statusFilter === 'waiting';
    const deferredProjects = showDeferredProjects
        ? [...projects]
            .filter((project) => !project.deletedAt && project.status === statusFilter)
            .filter((project) => projectMatchesAreaFilter(project, resolvedAreaFilter, areaById))
            .sort((a, b) => (a.order - b.order) || a.title.localeCompare(b.title))
        : [];
    const showDeferredProjectSection = showDeferredProjects && deferredProjects.length > 0;
    const showEmptyState = filteredTasks.length === 0 && !showDeferredProjectSection;
    const handleOpenProject = useCallback((projectId: string) => {
        setProjectView({ selectedProjectId: projectId });
        window.dispatchEvent(new CustomEvent('mindwtr:navigate', { detail: { view: 'projects' } }));
    }, [setProjectView]);
    const handleReactivateProject = useCallback((projectId: string) => {
        updateProject(projectId, { status: 'active' })
            .catch((error) => {
                reportError('Failed to reactivate project', error);
                showToast(t('projects.reactivateFailed') || 'Failed to reactivate project', 'error');
            });
    }, [showToast, t, updateProject]);

    const shouldVirtualize = !isReferenceAreaGrouping && !isNextGrouping && filteredTasks.length > VIRTUALIZATION_THRESHOLD;
    const rowVirtualizer = useVirtualizer({
        count: shouldVirtualize ? filteredTasks.length : 0,
        getScrollElement: () => listScrollRef.current,
        estimateSize: () => (isCompact ? 90 : VIRTUAL_ROW_ESTIMATE),
        overscan: Math.max(2, Math.ceil(VIRTUAL_OVERSCAN / VIRTUAL_ROW_ESTIMATE)),
        getItemKey: (index) => filteredTasks[index]?.id ?? index,
    });
    const virtualRows = shouldVirtualize ? rowVirtualizer.getVirtualItems() : [];
    const totalHeight = shouldVirtualize ? rowVirtualizer.getTotalSize() : 0;

    useEffect(() => {
        const filterKey = [
            statusFilter,
            prioritiesEnabled ? '1' : '0',
            timeEstimatesEnabled ? '1' : '0',
            selectedTokens.join('|'),
            selectedPriorities.join('|'),
            selectedTimeEstimates.join('|'),
            selectedWaitingPerson,
            resolvedAreaFilter,
            activeNextGroupBy,
        ].join('::');
        if (lastFilterKeyRef.current !== filterKey) {
            lastFilterKeyRef.current = filterKey;
            requestSelectionScroll();
            setSelectedIndex(0);
            exitSelectionMode();
            return;
        }
        if (filteredTasks.length === 0) {
            if (selectedIndex !== 0) {
                setSelectedIndex(0);
            }
            return;
        }
        if (selectedIndex >= filteredTasks.length) {
            requestSelectionScroll();
            setSelectedIndex(filteredTasks.length - 1);
        }
    }, [
        statusFilter,
        selectedTokens,
        selectedPriorities,
        selectedTimeEstimates,
        selectedWaitingPerson,
        prioritiesEnabled,
        timeEstimatesEnabled,
        activeNextGroupBy,
        exitSelectionMode,
        filteredTasks,
        selectedIndex,
        requestSelectionScroll,
    ]);

    useLayoutEffect(() => {
        if (!pendingSelectionScrollRef.current) return;
        pendingSelectionScrollRef.current = false;
        const task = filteredTasks[selectedIndex];
        if (!task) return;
        if (shouldVirtualize && listScrollRef.current) {
            rowVirtualizer.scrollToIndex(selectedIndex, { align: 'auto' });
            return;
        }
        const el = document.querySelector(`[data-task-id="${task.id}"]`) as HTMLElement | null;
        if (el && typeof (el as any).scrollIntoView === 'function') {
            el.scrollIntoView({ block: 'nearest' });
        }
    }, [filteredTasks, selectedIndex, selectionScrollVersion, shouldVirtualize, rowVirtualizer]);

    useEffect(() => {
        if (!highlightTaskId) return;
        const index = filteredTasks.findIndex((task) => task.id === highlightTaskId);
        if (index < 0) return;
        setSelectedIndex(index);
        if (shouldVirtualize && listScrollRef.current) {
            rowVirtualizer.scrollToIndex(index, { align: 'center' });
        }
        const el = document.querySelector(`[data-task-id="${highlightTaskId}"]`) as HTMLElement | null;
        if (el && typeof (el as any).scrollIntoView === 'function') {
            el.scrollIntoView({ block: 'center' });
        }
        const timer = window.setTimeout(() => setHighlightTask(null), 4000);
        return () => window.clearTimeout(timer);
    }, [highlightTaskId, filteredTasks, shouldVirtualize, rowVirtualizer, setHighlightTask]);

    const selectNext = useCallback(() => {
        if (filteredTasks.length === 0) return;
        requestSelectionScroll();
        setSelectedIndex((i) => Math.min(i + 1, filteredTasks.length - 1));
    }, [filteredTasks.length, requestSelectionScroll]);

    const selectPrev = useCallback(() => {
        requestSelectionScroll();
        setSelectedIndex((i) => Math.max(i - 1, 0));
    }, [requestSelectionScroll]);

    const selectFirst = useCallback(() => {
        requestSelectionScroll();
        setSelectedIndex(0);
    }, [requestSelectionScroll]);

    const selectLast = useCallback(() => {
        if (filteredTasks.length > 0) {
            requestSelectionScroll();
            setSelectedIndex(filteredTasks.length - 1);
        }
    }, [filteredTasks.length, requestSelectionScroll]);

    const editSelected = useCallback(() => {
        const task = filteredTasks[selectedIndex];
        if (!task) return;
        const editTrigger = document.querySelector(
            `[data-task-id="${task.id}"] [data-task-edit-trigger]`
        ) as HTMLElement | null;
        editTrigger?.focus();
        editTrigger?.click();
    }, [filteredTasks, selectedIndex]);

    const toggleDoneSelected = useCallback(() => {
        const task = filteredTasks[selectedIndex];
        if (!task) return;
        const nextStatus = task.status === 'done' ? 'inbox' : 'done';
        void moveTask(task.id, nextStatus)
            .then(() => {
                if (!undoNotificationsEnabled || nextStatus !== 'done') return;
                showToast(
                    `${task.title} marked Done`,
                    'info',
                    5000,
                    {
                        label: t('common.undo') || 'Undo',
                        onClick: () => {
                            void moveTask(task.id, task.status);
                        },
                    }
                );
            })
            .catch((error) => reportError('Failed to update task status', error));
    }, [filteredTasks, selectedIndex, moveTask, showToast, undoNotificationsEnabled]);

    const runSingleDelete = useCallback(async (task: Task) => {
        await deleteTask(task.id);
        if (!undoNotificationsEnabled) return;
        showToast(
            t('list.taskDeleted') || 'Task deleted',
            'info',
            5000,
            {
                label: t('common.undo') || 'Undo',
                onClick: () => {
                    void restoreTask(task.id);
                },
            }
        );
    }, [deleteTask, restoreTask, showToast, t, undoNotificationsEnabled]);

    const deleteSelected = useCallback(() => {
        const task = filteredTasks[selectedIndex];
        if (!task) return;
        setPendingDeleteTask(task);
    }, [filteredTasks, selectedIndex]);

    useEffect(() => {
        if (isProcessing) {
            registerTaskListScope(null);
            return;
        }

        registerTaskListScope({
            kind: 'taskList',
            selectNext,
            selectPrev,
            selectFirst,
            selectLast,
            editSelected,
            toggleDoneSelected,
            deleteSelected,
            focusAddInput: () => {
                if (showViewFilterInput) {
                    viewFilterInputRef.current?.focus();
                    return;
                }
                addInputRef.current?.focus();
            },
        });

        return () => registerTaskListScope(null);
    }, [
        registerTaskListScope,
        isProcessing,
        selectNext,
        selectPrev,
        selectFirst,
        selectLast,
        editSelected,
        toggleDoneSelected,
        deleteSelected,
        showViewFilterInput,
    ]);

    const toggleMultiSelect = useCallback((taskId: string) => {
        setMultiSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(taskId)) next.delete(taskId);
            else next.add(taskId);
            return next;
        });
    }, []);

    const handleSelectIndex = useCallback((index: number) => {
        if (!selectionMode) setSelectedIndex(index);
    }, [selectionMode]);

    const selectedIdsArray = useMemo(() => Array.from(multiSelectedIds), [multiSelectedIds]);
    const bulkAreaOptions = useMemo(
        () => [...areas]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((area) => ({ id: area.id, name: area.name })),
        [areas]
    );

    const handleBatchMove = useCallback(async (newStatus: TaskStatus) => {
        if (selectedIdsArray.length === 0) return;
        try {
            await batchMoveTasks(selectedIdsArray, newStatus);
            exitSelectionMode();
        } catch (error) {
            reportError('Failed to batch move tasks', error);
            showToast(translateWithFallback('bulk.moveFailed', 'Failed to update selected tasks'), 'error');
        }
    }, [batchMoveTasks, selectedIdsArray, exitSelectionMode, showToast, translateWithFallback]);

    const handleBatchDelete = useCallback(async () => {
        if (selectedIdsArray.length === 0) return;
        setPendingBatchDeleteIds(selectedIdsArray);
    }, [selectedIdsArray]);

    const confirmBatchDelete = useCallback(async (taskIds: string[]) => {
        setIsBatchDeleting(true);
        try {
            await batchDeleteTasks(taskIds);
            exitSelectionMode();
            if (undoNotificationsEnabled) {
                const deletedMessage = taskIds.length === 1
                    ? (t('list.taskDeleted') || 'Task deleted')
                    : (t('list.tasksDeleted') || '{{count}} tasks deleted').replace('{{count}}', String(taskIds.length));
                showToast(
                    deletedMessage,
                    'info',
                    5000,
                    {
                        label: t('common.undo') || 'Undo',
                        onClick: () => {
                            void restoreDeletedTasksWithFeedback(taskIds, restoreTask, showToast);
                        },
                    }
                );
            }
        } catch (error) {
            reportError('Failed to batch delete tasks', error);
            showToast(translateWithFallback('bulk.deleteFailed', 'Failed to delete selected tasks'), 'error');
        } finally {
            setIsBatchDeleting(false);
            setPendingBatchDeleteIds([]);
        }
    }, [batchDeleteTasks, exitSelectionMode, restoreTask, showToast, t, translateWithFallback, undoNotificationsEnabled]);

    const handleBatchAssignArea = useCallback(async (areaId: string | null) => {
        if (selectedIdsArray.length === 0) return;
        try {
            await batchUpdateTasks(selectedIdsArray.map((id) => ({
                id,
                updates: { areaId: areaId ?? undefined },
            })));
            exitSelectionMode();
        } catch (error) {
            reportError('Failed to batch assign area', error);
            showToast(translateWithFallback('bulk.moveFailed', 'Failed to update selected tasks'), 'error');
        }
    }, [batchUpdateTasks, selectedIdsArray, exitSelectionMode, showToast, translateWithFallback]);

    const handleBatchAddTag = useCallback(async () => {
        if (selectedIdsArray.length === 0) return;
        setTagPromptIds(selectedIdsArray);
        setTagPromptOpen(true);
    }, [batchUpdateTasks, selectedIdsArray, tasksById, t, exitSelectionMode]);

    const handleBatchAddContext = useCallback(() => {
        if (selectedIdsArray.length === 0) return;
        setContextPromptIds(selectedIdsArray);
        setContextPromptMode('add');
        setContextPromptOpen(true);
    }, [selectedIdsArray]);

    const handleBatchRemoveContext = useCallback(() => {
        if (selectedIdsArray.length === 0) return;
        setContextPromptIds(selectedIdsArray);
        setContextPromptMode('remove');
        setContextPromptOpen(true);
    }, [selectedIdsArray]);

    const handleAddTask = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newTaskTitle.trim()) return;
        try {
            const { title: parsedTitle, props, projectTitle, invalidDateCommands } = parseQuickAdd(newTaskTitle, projects, new Date(), areas);
            if (invalidDateCommands && invalidDateCommands.length > 0) {
                showToast(`${t('quickAdd.invalidDateCommand')}: ${invalidDateCommands.join(', ')}`, 'error');
                return;
            }
            const finalTitle = parsedTitle || newTaskTitle;
            const initialProps: Partial<Task> = { ...props };
            if (!initialProps.projectId && projectTitle) {
                const created = await addProject(projectTitle, DEFAULT_AREA_COLOR);
                if (!created) return;
                initialProps.projectId = created.id;
            }
            if (!initialProps.projectId && !initialProps.areaId && resolvedAreaFilter !== AREA_FILTER_ALL && resolvedAreaFilter !== AREA_FILTER_NONE) {
                initialProps.areaId = resolvedAreaFilter;
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
            await addTask(finalTitle, initialProps);
            setNewTaskTitle('');
            resetCopilot();
        } catch (error) {
            reportError('Failed to add task from quick add', error);
            showToast(t('task.addFailed') || 'Failed to add task', 'error');
        }
    };

    const showFilters = ['next', 'all'].includes(statusFilter);
    const isInbox = statusFilter === 'inbox';
    const isNextView = statusFilter === 'next';
    const isWaitingView = statusFilter === 'waiting';
    const NEXT_WARNING_THRESHOLD = 15;
    const priorityOptions: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
    const timeEstimateOptions: TimeEstimate[] = ['5min', '10min', '15min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+'];
    const formatEstimate = (estimate: TimeEstimate) => {
        if (estimate.endsWith('min')) return estimate.replace('min', 'm');
        if (estimate.endsWith('hr+')) return estimate.replace('hr+', 'h+');
        if (estimate.endsWith('hr')) return estimate.replace('hr', 'h');
        return estimate;
    };
    const filterSummary = useMemo(() => {
        return [
            ...(normalizedSearchQuery ? [`${t('common.search')}: ${searchQuery.trim()}`] : []),
            ...selectedTokens,
            ...(prioritiesEnabled ? selectedPriorities.map((priority) => t(`priority.${priority}`)) : []),
            ...(timeEstimatesEnabled ? selectedTimeEstimates.map(formatEstimate) : []),
            ...(selectedWaitingPerson ? [`${t('process.delegateWhoLabel')}: ${selectedWaitingPerson}`] : []),
        ];
    }, [normalizedSearchQuery, prioritiesEnabled, searchQuery, selectedPriorities, selectedTimeEstimates, selectedTokens, selectedWaitingPerson, t, timeEstimatesEnabled]);
    const hasFilters = filterSummary.length > 0;
    const filterSummaryLabel = filterSummary.slice(0, 3).join(', ');
    const filterSummarySuffix = filterSummary.length > 3 ? ` +${filterSummary.length - 3}` : '';
    const showFiltersPanel = filtersOpen || hasFilters;
    const toggleTokenFilter = useCallback((token: string) => {
        const nextTokens = selectedTokens.includes(token)
            ? selectedTokens.filter((item) => item !== token)
            : [...selectedTokens, token];
        setListFilters({ tokens: nextTokens });
    }, [selectedTokens, setListFilters]);
    const togglePriorityFilter = useCallback((priority: TaskPriority) => {
        const nextPriorities = selectedPriorities.includes(priority)
            ? selectedPriorities.filter((item) => item !== priority)
            : [...selectedPriorities, priority];
        setListFilters({ priorities: nextPriorities });
    }, [selectedPriorities, setListFilters]);
    const toggleTimeFilter = useCallback((estimate: TimeEstimate) => {
        const nextEstimates = selectedTimeEstimates.includes(estimate)
            ? selectedTimeEstimates.filter((item) => item !== estimate)
            : [...selectedTimeEstimates, estimate];
        setListFilters({ estimates: nextEstimates });
    }, [selectedTimeEstimates, setListFilters]);
    const clearFilters = () => {
        resetListFilters();
    };

    useEffect(() => {
        if (!prioritiesEnabled && selectedPriorities.length > 0) {
            setListFilters({ priorities: [] });
        }
        if (!timeEstimatesEnabled && selectedTimeEstimates.length > 0) {
            setListFilters({ estimates: [] });
        }
    }, [prioritiesEnabled, timeEstimatesEnabled, selectedPriorities.length, selectedTimeEstimates.length, setListFilters]);

    const openQuickAdd = useCallback((status: TaskStatus | 'all', captureMode?: 'text' | 'audio') => {
        const initialStatus = status === 'all' ? 'inbox' : status;
        window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
            detail: { initialProps: { status: initialStatus }, captureMode },
        }));
    }, []);

    const emptyState = useMemo(() => {
        switch (statusFilter) {
            case 'inbox':
                return {
                    title: t('list.inbox') || 'Inbox',
                    body: resolveText('inbox.emptyAddHint', 'Inbox is clear. Capture something new.'),
                    action: t('nav.addTask') || 'Add task',
                };
            case 'next':
                return {
                    title: t('list.next') || 'Next Actions',
                    body: resolveText('list.noTasks', 'No next actions yet.'),
                    action: t('nav.addTask') || 'Add task',
                };
            case 'waiting':
                return {
                    title: resolveText('waiting.empty', t('list.waiting') || 'Waiting'),
                    body: resolveText('waiting.emptyHint', 'Track delegated or pending items.'),
                    action: t('nav.addTask') || 'Add task',
                };
            case 'someday':
                return {
                    title: resolveText('someday.empty', t('list.someday') || 'Someday'),
                    body: resolveText('someday.emptyHint', 'Store ideas for later.'),
                    action: t('nav.addTask') || 'Add task',
                };
            case 'reference':
                return {
                    title: resolveText('reference.empty', t('list.reference') || 'Reference'),
                    body: resolveText('reference.emptyHint', 'Reference holds info you might want later — no action required.'),
                    action: t('nav.addTask') || 'Add task',
                };
            case 'done':
                return {
                    title: t('list.done') || 'Done',
                    body: resolveText('done.emptyHint', 'Completed tasks land here — a running log of what you finished.'),
                };
            default:
                return {
                    title: t('list.tasks') || 'Tasks',
                    body: resolveText('list.noTasks', 'No tasks yet.'),
                    action: t('nav.addTask') || 'Add task',
                };
        }
    }, [resolveText, statusFilter, t]);

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
                        onChangeSortBy={(value) => updateSettings({ taskSortBy: value })}
                        showGroupBy={isNextView}
                        groupBy={activeNextGroupBy}
                        onChangeGroupBy={(value) => setListOptions({ nextGroupBy: value })}
                        selectionMode={selectionMode}
                        onToggleSelection={() => {
                            if (selectionMode) exitSelectionMode();
                            else setSelectionMode(true);
                        }}
                        showListDetails={showListDetails}
                        onToggleDetails={() => setListOptions({ showDetails: !showListDetails })}
                        densityMode={densityMode}
                        onToggleDensity={() => {
                            void updateSettings({
                                appearance: {
                                    density: densityMode === 'compact' ? 'comfortable' : 'compact',
                                },
                            });
                        }}
                        t={t}
                    />

                    {(isProcessing || isBatchDeleting) && (
                        <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                            {isBatchDeleting
                                ? (t('bulk.deleting') || 'Deleting selected tasks...')
                                : (t('common.loading') || 'Loading...')}
                        </div>
                    )}

                    {selectionMode && selectedIdsArray.length > 0 && (
                        <ListBulkActions
                            selectionCount={selectedIdsArray.length}
                            onMoveToStatus={handleBatchMove}
                            onAssignArea={handleBatchAssignArea}
                            areaOptions={bulkAreaOptions}
                            onAddTag={handleBatchAddTag}
                            onAddContext={handleBatchAddContext}
                            onRemoveContext={handleBatchRemoveContext}
                            onDelete={handleBatchDelete}
                            isDeleting={isBatchDeleting}
                            t={t}
                        />
                    )}

            {/* Next Actions Warning */}
            {isNextView && nextCount > NEXT_WARNING_THRESHOLD && (
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 flex items-start gap-3">
                    <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5" />
                    <div>
                        <p className="font-medium text-amber-700 dark:text-amber-400">
                            {nextCount} {t('next.warningCount')}
                        </p>
                        <p className="text-sm text-amber-600 dark:text-amber-500 mt-1">
                            {t('next.warningHint')}
                        </p>
                    </div>
                </div>
            )}

            {showDeferredProjectSection && (
                <div className="rounded-lg border border-border bg-card/50 p-4">
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {t('projects.title') || 'Projects'}
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
                                        aria-label={`${t('projects.title') || 'Project'}: ${project.title}`}
                                    >
                                        <Folder className="h-4 w-4 shrink-0" style={{ color: project.color }} />
                                        <span className="text-sm font-medium text-foreground truncate">{project.title}</span>
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
                                        className="text-xs px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted/60"
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
                addProject={addProject}
                updateTask={updateTask}
                deleteTask={deleteTask}
                allContexts={allContexts}
                isProcessing={isProcessing}
                setIsProcessing={setIsProcessing}
            />

            {showViewFilterInput && !isProcessing && (
                <input
                    ref={viewFilterInputRef}
                    type="text"
                    data-view-filter-input
                    placeholder={t('common.search')}
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    className="w-full text-sm px-3 py-2 rounded border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
            )}

            {isWaitingView && !isProcessing && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                    <span className="text-xs font-medium text-muted-foreground">{t('process.delegateWhoLabel')}</span>
                    <select
                        value={selectedWaitingPerson}
                        onChange={(event) => setSelectedWaitingPerson(event.target.value)}
                        className="text-xs bg-background text-foreground border border-border rounded px-2 py-1 hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
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
                            className="text-xs px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted/60"
                        >
                            {t('common.clear')}
                        </button>
                    )}
                </div>
            )}

            {/* Filters */}
            {showFilters && !isProcessing && (
                <ListFiltersPanel
                    t={t}
                    hasFilters={hasFilters}
                    showFiltersPanel={showFiltersPanel}
                    onClearFilters={clearFilters}
                    onToggleOpen={() => setListFilters({ open: !filtersOpen })}
                    allTokens={allTokens}
                    selectedTokens={selectedTokens}
                    tokenCounts={tokenCounts}
                    onToggleToken={toggleTokenFilter}
                    prioritiesEnabled={prioritiesEnabled}
                    priorityOptions={priorityOptions}
                    selectedPriorities={selectedPriorities}
                    onTogglePriority={togglePriorityFilter}
                    timeEstimatesEnabled={timeEstimatesEnabled}
                    timeEstimateOptions={timeEstimateOptions}
                    selectedTimeEstimates={selectedTimeEstimates}
                    onToggleEstimate={toggleTimeFilter}
                    formatEstimate={formatEstimate}
                />
            )}

            {/* Only show add task for inbox/next - other views are read-only */}
            {['inbox', 'next'].includes(statusFilter) && (
                <ListQuickAdd
                    inputRef={addInputRef}
                    value={newTaskTitle}
                    projects={projects}
                    areas={areas}
                    contexts={allTokens}
                    t={t}
                    dense={isCompact}
                    onCreateProject={async (title) => {
                        const created = await addProject(title, DEFAULT_AREA_COLOR);
                        return created?.id ?? null;
                    }}
                    onChange={(next) => {
                        setNewTaskTitle(next);
                        resetCopilot();
                    }}
                    onSubmit={handleAddTask}
                    onOpenAudio={() => openQuickAdd(statusFilter, 'audio')}
                    onResetCopilot={resetCopilot}
                />
            )}
            {['inbox', 'next'].includes(statusFilter) && aiEnabled && copilotSuggestion && !copilotApplied && (
                <button
                    type="button"
                    onClick={() => applyCopilotSuggestion(copilotSuggestion)}
                    className="mt-2 text-xs px-2 py-1 rounded bg-muted/30 border border-border text-muted-foreground hover:bg-muted/60 transition-colors text-left"
                >
                    ✨ {t('copilot.suggested')}{' '}
                    {copilotSuggestion.context ? `${copilotSuggestion.context} ` : ''}
                    {copilotSuggestion.tags?.length ? copilotSuggestion.tags.join(' ') : ''}
                    <span className="ml-2 text-muted-foreground/70">{t('copilot.applyHint')}</span>
                </button>
            )}
            {['inbox', 'next'].includes(statusFilter) && aiEnabled && copilotApplied && (
                <div className="mt-2 text-xs px-2 py-1 rounded bg-muted/30 border border-border text-muted-foreground">
                    ✅ {t('copilot.applied')}{' '}
                    {copilotContext ? `${copilotContext} ` : ''}
                    {copilotTags.length ? copilotTags.join(' ') : ''}
                </div>
            )}
            {['inbox', 'next'].includes(statusFilter) && !isProcessing && (
                <p className="text-xs text-muted-foreground">
                    {t('quickAdd.help')}
                </p>
            )}
            </div>
            <div
                ref={listScrollRef}
                className="flex-1 min-h-0 overflow-y-auto pt-3"
                role="list"
                aria-label={t('list.tasks') || 'Task list'}
            >
                {isFiltering && (
                    <div className="px-3 pb-2 text-xs text-muted-foreground">
                        {t('list.filtering') || 'Filtering...'}
                    </div>
                )}
                {showEmptyState ? (
                    <ListEmptyState
                        hasFilters={hasFilters}
                        emptyState={emptyState}
                        onAddTask={() => openQuickAdd(statusFilter)}
                        t={t}
                    />
                ) : shouldVirtualize ? (
                    <div style={{ height: totalHeight, position: 'relative' }}>
                        {virtualRows.map((virtualRow) => {
                            const task = filteredTasks[virtualRow.index];
                            if (!task) return null;
                            return (
                                <div
                                    key={virtualRow.key}
                                    ref={rowVirtualizer.measureElement}
                                    data-index={virtualRow.index}
                                    style={{
                                        position: 'absolute',
                                        top: 0,
                                        left: 0,
                                        width: '100%',
                                        transform: `translateY(${virtualRow.start}px)`,
                                    }}
                                >
                                    <div className={cn(isCompact ? "pb-1" : "pb-1.5")}>
                                        <TaskItem
                                            key={task.id}
                                            task={task}
                                            project={task.projectId ? projectMap.get(task.projectId) : undefined}
                                            isSelected={virtualRow.index === selectedIndex}
                                            onSelect={() => handleSelectIndex(virtualRow.index)}
                                            selectionMode={selectionMode}
                                            isMultiSelected={multiSelectedIds.has(task.id)}
                                            onToggleSelect={() => toggleMultiSelect(task.id)}
                                            showQuickDone={showQuickDone}
                                            readOnly={readOnly}
                                            compactMetaEnabled={showListDetails}
                                            showProjectBadgeInActions={false}
                                        />
                                        <div className="mx-3 mt-1 h-px bg-border/30" />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                ) : isReferenceAreaGrouping || isNextGrouping ? (
                    <div className="space-y-2">
                        {groupedTasks.map((group) => (
                            <div key={group.id} className="rounded-md border border-border/40 bg-card/30">
                                <div className={cn(
                                    'px-3 py-2 text-xs font-semibold uppercase tracking-wide border-b border-border/30',
                                    group.muted ? 'text-muted-foreground' : 'text-foreground/90',
                                )}>
                                    <span className="inline-flex items-center gap-1.5">
                                        {group.dotColor && (
                                            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: group.dotColor }} aria-hidden="true" />
                                        )}
                                        <span>{group.title}</span>
                                    </span>
                                    <span className="ml-2 text-muted-foreground">{group.tasks.length}</span>
                                </div>
                                <div className="divide-y divide-border/30">
                                    {group.tasks.map((task) => {
                                        const index = taskIndexById.get(task.id) ?? 0;
                                        return (
                                            <TaskItem
                                                key={task.id}
                                                task={task}
                                                project={task.projectId ? projectMap.get(task.projectId) : undefined}
                                                isSelected={index === selectedIndex}
                                                onSelect={() => handleSelectIndex(index)}
                                                selectionMode={selectionMode}
                                                isMultiSelected={multiSelectedIds.has(task.id)}
                                                onToggleSelect={() => toggleMultiSelect(task.id)}
                                                showQuickDone={showQuickDone}
                                                readOnly={readOnly}
                                                compactMetaEnabled={showListDetails}
                                                showProjectBadgeInActions={false}
                                            />
                                        );
                                    })}
                                </div>
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="divide-y divide-border/30">
                        {filteredTasks.map((task, index) => (
                            <TaskItem
                                key={task.id}
                                task={task}
                                project={task.projectId ? projectMap.get(task.projectId) : undefined}
                                isSelected={index === selectedIndex}
                                onSelect={() => handleSelectIndex(index)}
                                selectionMode={selectionMode}
                                isMultiSelected={multiSelectedIds.has(task.id)}
                                onToggleSelect={() => toggleMultiSelect(task.id)}
                                showQuickDone={showQuickDone}
                                readOnly={readOnly}
                                compactMetaEnabled={showListDetails}
                                showProjectBadgeInActions={false}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
        <PromptModal
            isOpen={tagPromptOpen}
            title={t('bulk.addTag')}
            description={t('bulk.addTag')}
            placeholder="#tag"
            defaultValue=""
            confirmLabel={t('common.save')}
            cancelLabel={t('common.cancel')}
            onCancel={() => setTagPromptOpen(false)}
            onConfirm={async (value) => {
                const input = value.trim();
                if (!input) return;
                const tag = input.startsWith('#') ? input : `#${input}`;
                await batchUpdateTasks(tagPromptIds.map((id) => {
                    const task = tasksById.get(id);
                    const existingTags = task?.tags || [];
                    const nextTags = Array.from(new Set([...existingTags, tag]));
                    return { id, updates: { tags: nextTags } };
                }));
                setTagPromptOpen(false);
                exitSelectionMode();
            }}
        />
        <PromptModal
            isOpen={contextPromptOpen}
            title={contextPromptMode === 'add' ? t('bulk.addContext') : t('bulk.removeContext')}
            description={contextPromptMode === 'add' ? t('bulk.addContext') : t('bulk.removeContext')}
            placeholder="@context"
            defaultValue=""
            confirmLabel={t('common.save')}
            cancelLabel={t('common.cancel')}
            onCancel={() => setContextPromptOpen(false)}
            onConfirm={async (value) => {
                const input = value.trim();
                if (!input) return;
                const ctx = input.startsWith('@') ? input : `@${input}`;
                await batchUpdateTasks(contextPromptIds.map((id) => {
                    const task = tasksById.get(id);
                    const existing = task?.contexts || [];
                    const nextContexts = contextPromptMode === 'add'
                        ? Array.from(new Set([...existing, ctx]))
                        : existing.filter((token) => token !== ctx);
                    return { id, updates: { contexts: nextContexts } };
                }));
                setContextPromptOpen(false);
                exitSelectionMode();
            }}
        />
        <ConfirmModal
            isOpen={pendingDeleteTask !== null}
            title={t('common.delete') || 'Delete'}
            description={t('task.deleteConfirmBody') || 'Move this task to Trash?'}
            confirmLabel={t('common.delete') || 'Delete'}
            cancelLabel={t('common.cancel')}
            onCancel={() => setPendingDeleteTask(null)}
            onConfirm={() => {
                const task = pendingDeleteTask;
                setPendingDeleteTask(null);
                if (!task) return;
                void runSingleDelete(task).catch((error) => reportError('Failed to delete task', error));
            }}
        />
        <ConfirmModal
            isOpen={pendingBatchDeleteIds.length > 0}
            title={t('common.delete') || 'Delete'}
            description={t('list.confirmBatchDelete') || 'Delete selected tasks?'}
            confirmLabel={t('common.delete') || 'Delete'}
            cancelLabel={t('common.cancel')}
            onCancel={() => setPendingBatchDeleteIds([])}
            onConfirm={() => {
                const taskIds = [...pendingBatchDeleteIds];
                void confirmBatchDelete(taskIds);
            }}
        />
        </ErrorBoundary>
    );
});
