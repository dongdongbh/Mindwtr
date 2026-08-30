import { memo, useMemo, useState, useEffect, useCallback, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ErrorBoundary } from '../ErrorBoundary';
import {
    createTaskFilterPredicate,
    formatTimeEstimateLabel,
    getTaskMetadataFilterVisibility,
    hasActiveFilterCriteria,
    projectMatchesAreaFilterSelection,
    resolveFeatureFlags,
    safeFormatDate,
    shallow,
    sortDoneTasksForListView,
    sortTasksBy,
    taskMatchesAreaFilterSelection,
    tFallback,
    useTaskStore,
} from '@mindwtr/core';
import type { FilterCriteria, Task, Project, TimeEstimate } from '@mindwtr/core';

import { CheckSquare, Filter, SlidersHorizontal, Undo2, Trash2 } from 'lucide-react';
import { useLanguage } from '../../contexts/language-context';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import { checkBudget } from '../../config/performanceBudgets';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';
import { cn } from '../../lib/utils';
import {
    LIST_VIRTUALIZATION_THRESHOLD,
    LIST_VIRTUAL_HEADER_ESTIMATE,
    LIST_VIRTUAL_OVERSCAN_ROWS,
    LIST_VIRTUAL_ROW_ESTIMATE,
} from './list/virtual-list';
import { StoreTaskItem } from './list/StoreTaskItem';
import { BulkSelectionToolbar } from './list/BulkSelectionToolbar';
import { GroupBySelect } from './list/GroupBySelect';
import { GroupedTaskList } from './list/GroupedTaskSections';
import { useCollapsedGroupsViewState, useTaskGroupCollapse } from './list/useTaskGroupCollapse';
import { ListFiltersPanel } from './list/ListFiltersPanel';
import { DONE_SORT_OPTIONS, LIST_END_GAP, SortBySelect, ToolbarButton, VIEW_FILTER_INPUT } from './list/list-toolbar';
import {
    PRIORITY_FILTER_OPTIONS,
    TIME_ESTIMATE_FILTER_OPTIONS,
    useListFilterControls,
} from './list/list-filter-controls';
import {
    DONE_AXES,
    groupTasks,
    type DoneGroupBy,
    type TaskGroup,
} from './list/next-grouping';
import { focusTaskRowWhenMounted, useTaskListScope } from './list/task-list-scope';
import { useTaskSelection } from './list/useTaskSelection';
import { useUiStore } from '../../store/ui-store';
import { useLocalDayKey } from '../../hooks/useLocalDayKey';
import { useAreaVisibility } from '../../hooks/useVisibleTaskContext';
import { resolveDoneTaskSortBy } from '../../lib/task-list-sort';
import { dispatchNavigateEvent } from '../../lib/navigation-events';

type ArchiveProjectRowProps = {
    project: Project;
    areaName?: string;
    onOpen: (projectId: string) => void;
    onRestore: (projectId: string) => void;
    onDelete: (project: Project) => void;
    t: (key: string) => string;
};

const ArchiveProjectRow = memo(function ArchiveProjectRow({
    project,
    areaName,
    onOpen,
    onRestore,
    onDelete,
    t,
}: ArchiveProjectRowProps) {
    const handleOpen = useCallback(() => onOpen(project.id), [onOpen, project.id]);
    const handleRestore = useCallback(() => onRestore(project.id), [onRestore, project.id]);
    const handleDelete = useCallback(() => onDelete(project), [onDelete, project]);
    const archivedText = `${tFallback(t, 'list.done', 'Completed')}: ${project.updatedAt ? safeFormatDate(project.updatedAt, 'Pp', project.updatedAt) : 'Unknown'}`;

    return (
        <div className="rounded-lg px-3 py-3 flex items-center justify-between group hover:bg-muted/50 transition-colors">
            <div className="flex min-w-0 items-center gap-3">
                <button
                    type="button"
                    aria-label={project.title}
                    onClick={handleOpen}
                    className="min-w-0 rounded-md text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                    <h3 className="font-medium text-foreground line-through opacity-70">{project.title}</h3>
                    <p className="text-xs text-muted-foreground mt-1">
                        {archivedText}
                        {areaName ? ` • ${areaName}` : ''}
                    </p>
                </button>
            </div>
            <div className="flex gap-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
                <button
                    onClick={handleRestore}
                    className="p-2 hover:bg-muted rounded-md text-muted-foreground hover:text-primary transition-colors"
                    title={tFallback(t, 'archived.restoreProject', 'Restore project')}
                >
                    <Undo2 className="w-4 h-4" />
                </button>
                <button
                    onClick={handleDelete}
                    className="p-2 hover:bg-destructive/10 rounded-md text-muted-foreground hover:text-destructive transition-colors"
                    title={t('common.delete')}
                >
                    <Trash2 className="w-4 h-4" />
                </button>
            </div>
        </div>
    );
});

type ArchiveSegment = 'tasks' | 'projects';

// Archive keeps its own collapse key, as every list does (#963).
const ARCHIVE_VIEW_STATE_STORAGE_KEY = 'mindwtr:view:archive:v1';

// App-wide flash duration for the shared highlight (#916).
const HIGHLIGHT_FLASH_MS = 4000;

export function ArchiveView() {
    const perf = usePerformanceMonitor('ArchiveView');
    const {
        _allTasks,
        projects,
        areas,
        updateProject,
        deleteProject,
        batchMoveTasks,
        batchDeleteTasks,
        restoreTask,
        settings,
        highlightTaskId,
        setHighlightTask,
    } = useTaskStore(
        (state) => ({
            _allTasks: state._allTasks,
            projects: state.projects,
            areas: state.areas,
            updateProject: state.updateProject,
            deleteProject: state.deleteProject,
            batchMoveTasks: state.batchMoveTasks,
            batchDeleteTasks: state.batchDeleteTasks,
            restoreTask: state.restoreTask,
            settings: state.settings,
            highlightTaskId: state.highlightTaskId,
            setHighlightTask: state.setHighlightTask,
        }),
        shallow
    );
    const { t } = useLanguage();
    const showToast = useUiStore((state) => state.showToast);
    const { requestConfirmation, confirmModal } = useConfirmDialog();
    const [segment, setSegment] = useState<ArchiveSegment>('tasks');
    const [searchQuery, setSearchQuery] = useState('');
    const { collapsedGroups, setCollapsedGroups } = useCollapsedGroupsViewState(
        ARCHIVE_VIEW_STATE_STORAGE_KEY,
        DONE_AXES,
    );
    const listScrollRef = useRef<HTMLDivElement>(null);
    const scrolledHighlightIdRef = useRef<string | null>(null);
    const {
        criteria: listFilterCriteria,
        filtersOpen,
        selectedTokens,
        excludedTokens,
        selectedPriorities,
        selectedTimeEstimates,
        toggleToken,
        togglePriority,
        toggleEstimate,
        clearFilters,
        setFiltersOpen,
    } = useListFilterControls();
    const archivedGroupBy = useUiStore((state) => state.listOptions.archivedGroupBy);
    const archivedSortBy = useUiStore((state) => state.listOptions.archivedSortBy);
    const setListOptions = useUiStore((state) => state.setListOptions);
    // Archive is completed work, so it reads Done's sort roster (which is the
    // only one carrying 'completed') and lands on Done's completion-recency
    // default rather than the global task sort, which orders by due date and
    // priority — neither of which means anything once a task is finished.
    const sortBy = resolveDoneTaskSortBy(settings?.taskSortBy, archivedSortBy);
    const { areaById, projectById, resolvedAreaFilter } = useAreaVisibility();

    useEffect(() => {
        if (!perf.enabled) return;
        const timer = window.setTimeout(() => {
            checkBudget('ArchiveView', perf.metrics, 'simple');
        }, 0);
        return () => window.clearTimeout(timer);
    }, [perf.enabled]);

    // Everything in the archive, before the toolbar narrows it. The filter
    // chips, their counts and the priority/estimate section visibility all read
    // this, so a selection never hides the control that would undo it.
    //
    // The area filter applies here as it does on every other list and on
    // mobile's Archive — but `isTaskVisibleInArea` does not fit: archived work
    // usually sits in archived projects, which that predicate parks.
    const archivedBaseTasks = useMemo(
        () => _allTasks.filter((task) => (
            task.status === 'archived'
            && !task.deletedAt
            && taskMatchesAreaFilterSelection(task, resolvedAreaFilter, projectById, areaById)
        )),
        [_allTasks, areaById, projectById, resolvedAreaFilter]
    );

    const { priorities: prioritiesEnabled, timeEstimates: timeEstimatesEnabled } = resolveFeatureFlags(settings);
    const metadataFilterVisibility = useMemo(
        () => getTaskMetadataFilterVisibility(archivedBaseTasks, { prioritiesEnabled, timeEstimatesEnabled }),
        [archivedBaseTasks, prioritiesEnabled, timeEstimatesEnabled]
    );
    const showPriorityFilters = metadataFilterVisibility.priority;
    const showTimeEstimateFilters = metadataFilterVisibility.timeEstimate;
    const activeFilterCriteria = useMemo<FilterCriteria>(() => ({
        ...listFilterCriteria,
        priority: showPriorityFilters ? selectedPriorities : undefined,
        timeEstimates: showTimeEstimateFilters ? selectedTimeEstimates : undefined,
        timeEstimateRange: showTimeEstimateFilters ? listFilterCriteria.timeEstimateRange : undefined,
    }), [listFilterCriteria, selectedPriorities, selectedTimeEstimates, showPriorityFilters, showTimeEstimateFilters]);

    const { allTokens, tokenCounts } = useMemo(() => {
        const counts: Record<string, number> = {};
        for (const task of archivedBaseTasks) {
            for (const token of new Set([...(task.contexts ?? []), ...(task.tags ?? [])])) {
                counts[token] = (counts[token] ?? 0) + 1;
            }
        }
        // Criteria are shared across every desktop list (#956), so a token
        // picked in Next can be active here while matching nothing archived.
        // Union it in or the panel would offer no way to switch it back off.
        return {
            allTokens: [...new Set([...Object.keys(counts), ...selectedTokens, ...excludedTokens])].sort(),
            tokenCounts: counts,
        };
    }, [archivedBaseTasks, excludedTokens, selectedTokens]);

    const archivedTasks = useMemo(() => {
        const criteriaPredicate = hasActiveFilterCriteria(activeFilterCriteria)
            ? createTaskFilterPredicate(activeFilterCriteria, { projects, tokenMatchMode: 'all' })
            : null;
        const query = searchQuery.trim().toLowerCase();
        const filtered = archivedBaseTasks.filter((task) => {
            if (criteriaPredicate && !criteriaPredicate(task)) return false;
            if (query && !task.title.toLowerCase().includes(query)) return false;
            return true;
        });
        return sortBy === 'default' ? sortDoneTasksForListView(filtered) : sortTasksBy(filtered, sortBy);
    }, [activeFilterCriteria, archivedBaseTasks, projects, searchQuery, sortBy]);

    const areaNameById = useMemo(
        () => new Map(areas.filter((area) => !area.deletedAt).map((area) => [area.id, area.name])),
        [areas]
    );

    const archivedProjects = useMemo(() => {
        const filtered = projects
            .filter((project) => (
                project.status === 'archived'
                && projectMatchesAreaFilterSelection(project, resolvedAreaFilter, areaById)
            ))
            .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
        if (!searchQuery) return filtered;
        const query = searchQuery.toLowerCase();
        return filtered.filter((project) => project.title.toLowerCase().includes(query));
    }, [areaById, projects, resolvedAreaFilter, searchQuery]);
    const isGrouping = archivedGroupBy !== 'none';
    const localDayKey = useLocalDayKey(archivedGroupBy === 'completedDate');
    const groupedTasks = useMemo<TaskGroup[]>(
        () => (isGrouping ? groupTasks(archivedGroupBy, { tasks: archivedTasks, areas, projectMap: projectById, t, theme: settings?.theme }) : []),
        [archivedGroupBy, archivedTasks, areas, isGrouping, localDayKey, projectById, settings?.theme, t]
    );
    const {
        collapsedGroupIds,
        getSectionDomId,
        toggleGroup,
        virtualRows: groupedVirtualRows,
        // Grouped rows render in section order, so keyboard navigation and
        // "select all" have to walk that order rather than the flat sorted one.
        // A collapsed group contributes no rows, so it contributes no tasks.
        visibleTasks: orderedTasks,
    } = useTaskGroupCollapse({
        axis: archivedGroupBy,
        groups: groupedTasks,
        tasks: archivedTasks,
        idPrefix: 'archived-group',
        collapsedGroups,
        setCollapsedGroups,
    });
    const archivedTaskIds = useMemo(() => orderedTasks.map((task) => task.id), [orderedTasks]);
    const {
        allVisibleTasksSelected: allVisibleSelected,
        clearTaskSelection: clearSelection,
        deleteSelectedTasks,
        exitSelectionMode,
        multiSelectedIds: selectedIds,
        moveSelectedTasks,
        selectionMode,
        selectAllVisibleTasks: selectAllVisible,
        toggleMultiSelect: toggleTaskSelection,
        toggleSelectionMode,
    } = useTaskSelection(archivedTaskIds, {
        batchDeleteTasks,
        batchMoveTasks,
        restoreTask,
        showToast,
        t,
        undoNotificationsEnabled: settings?.undoNotificationsEnabled !== false,
    });
    const virtualRowCount = groupedVirtualRows?.length ?? archivedTasks.length;
    const shouldVirtualize = virtualRowCount > LIST_VIRTUALIZATION_THRESHOLD;
    // Keep the Projects segment's layout behavior tied to the old flat-task
    // condition. Grouping only changes how the task segment renders.
    const shouldVirtualizeFlatTasks = !isGrouping && archivedTasks.length > LIST_VIRTUALIZATION_THRESHOLD;
    const shouldFillAvailableHeight = segment === 'tasks' ? shouldVirtualize : shouldVirtualizeFlatTasks;
    // One engine for both shapes, as in ListView: grouped rows carry headers,
    // flat rows are the sorted tasks. Row heights are measured, never assumed
    // — a fabricated offset scrolls past the content and blanks the list (#916).
    const rowVirtualizer = useVirtualizer({
        count: shouldVirtualize ? virtualRowCount : 0,
        getScrollElement: () => listScrollRef.current,
        estimateSize: (index) => (
            groupedVirtualRows?.[index]?.kind === 'header'
                ? LIST_VIRTUAL_HEADER_ESTIMATE
                : LIST_VIRTUAL_ROW_ESTIMATE
        ),
        overscan: LIST_VIRTUAL_OVERSCAN_ROWS,
        getItemKey: (index) => {
            const row = groupedVirtualRows?.[index];
            if (!row) return archivedTasks[index]?.id ?? index;
            if (!row) return index;
            return row.kind === 'header'
                ? `group:${row.group.id}`
                : `task:${row.group.id}:${row.task.id}`;
        },
    });

    const [selectedTaskIndex, setSelectedTaskIndex] = useState(0);
    useTaskListScope({
        // The projects segment renders no task rows, so the keyboard must not
        // act on archived tasks the user cannot see.
        getTasks: () => (segment === 'tasks' ? orderedTasks : []),
        getSelectedIndex: () => selectedTaskIndex,
        setSelectedIndex: setSelectedTaskIndex,
        t,
        toggleSelect: (task) => toggleTaskSelection(task.id),
    });

    const handleBulkRestore = useCallback(async () => {
        await moveSelectedTasks('inbox');
    }, [moveSelectedTasks]);

    const handleBulkDelete = useCallback(async () => {
        await deleteSelectedTasks({
            confirm: () => requestConfirmation({
                title: t('bulk.confirmDeleteTitle'),
                description: t('bulk.confirmDeleteBody'),
                confirmLabel: t('common.delete'),
                cancelLabel: tFallback(t, 'common.cancel', 'Cancel'),
            }),
        });
    }, [deleteSelectedTasks, requestConfirmation, t]);

    const handleRestoreProject = useCallback((projectId: string) => {
        void updateProject(projectId, { status: 'active' });
    }, [updateProject]);

    const handleOpenProject = useCallback((projectId: string) => {
        useUiStore.getState().setProjectView({ selectedProjectId: projectId });
        dispatchNavigateEvent('projects');
    }, []);

    const handleDeleteProject = useCallback(async (project: Project) => {
        const confirmed = await requestConfirmation({
            title: project.title,
            description: t('projects.deleteConfirm'),
            confirmLabel: t('common.delete'),
            cancelLabel: tFallback(t, 'common.cancel', 'Cancel'),
        });
        if (!confirmed) return;
        await deleteProject(project.id);
    }, [deleteProject, requestConfirmation, t]);

    // The same read-only row Done uses, so an archived task's notes, checklist and
    // attachments are readable without restoring it first (#968). Restore, Delete
    // and the completion-time correction all come from TaskItem's read-only
    // actions; Archive no longer hand-rolls a row, a delete confirm or a
    // completion-time prompt of its own.
    const renderArchiveRow = useCallback((task: Task) => (
        <StoreTaskItem
            key={task.id}
            taskId={task.id}
            readOnly
            selectionMode={selectionMode}
            isMultiSelected={selectedIds.has(task.id)}
            onToggleSelectId={toggleTaskSelection}
            showQuickDone={false}
            showProjectBadgeInActions={false}
        />
    ), [selectedIds, selectionMode, toggleTaskSelection]);

    const formatEstimate = useCallback(
        (value: TimeEstimate) => formatTimeEstimateLabel(value, { t }),
        [t]
    );
    const filterSummary = [
        ...(searchQuery.trim() ? [`${t('common.search')}: ${searchQuery.trim()}`] : []),
        ...selectedTokens,
        ...excludedTokens.map((token) => `${tFallback(t, 'filters.excluded', 'Excluded')}: ${token}`),
        ...(showPriorityFilters ? selectedPriorities.map((priority) => t(`priority.${priority}`)) : []),
        ...(showTimeEstimateFilters ? selectedTimeEstimates.map(formatEstimate) : []),
    ];
    const hasFilters = filterSummary.length > 0;
    const filterSummaryLabel = filterSummary.slice(0, 3).join(', ');
    const filterSummarySuffix = filterSummary.length > 3 ? ` +${filterSummary.length - 3}` : '';

    const handleSegmentChange = useCallback((next: ArchiveSegment) => {
        setSegment((current) => {
            if (current === next) return current;
            exitSelectionMode();
            return next;
        });
    }, [exitSelectionMode]);

    // One flash per highlight, owned here rather than by the reveal effect below:
    // that effect re-runs every time a row measures, which would keep sliding the
    // 4s window forward for as long as the user scrolls.
    useEffect(() => {
        if (!highlightTaskId) {
            scrolledHighlightIdRef.current = null;
            return;
        }
        const flashTimer = window.setTimeout(() => setHighlightTask(null), HIGHLIGHT_FLASH_MS);
        return () => window.clearTimeout(flashTimer);
    }, [highlightTaskId, setHighlightTask]);

    // Global search sets the shared highlight before navigating here (#916), and
    // Archive is the view that has to honour it — a task landing in a list that
    // is not showing it looks like the search result went nowhere. Whatever is
    // hiding the row is undone one step at a time (each step re-runs this
    // effect): the Projects segment, then the filters, then a collapsed group.
    // The flash itself is TaskItem's, so it needs nothing beyond a mounted row.
    useEffect(() => {
        if (!highlightTaskId) return;
        if (!archivedBaseTasks.some((task) => task.id === highlightTaskId)) return;

        if (segment !== 'tasks') {
            handleSegmentChange('tasks');
            return;
        }

        if (!archivedTasks.some((task) => task.id === highlightTaskId)) {
            // Landing on a list that cannot show the result is worse than losing
            // a filter, so drop the filter and say so — the same trade global
            // search already makes for the area filter.
            if (!hasActiveFilterCriteria(activeFilterCriteria) && !searchQuery.trim()) return;
            clearFilters();
            setSearchQuery('');
            showToast(tFallback(
                t,
                'archive.filtersClearedForTask',
                'Cleared the archive filters so the selected task is visible.',
            ), 'info');
            return;
        }

        if (isGrouping) {
            // A multi-tag/context task may belong to several groups. If one copy
            // is already rendered, do not consume the user's other collapse
            // preferences while the highlight effect re-runs.
            if (!orderedTasks.some((task) => task.id === highlightTaskId)) {
                const collapsedGroup = groupedTasks.find((group) => (
                    collapsedGroupIds.has(group.id) && group.tasks.some((task) => task.id === highlightTaskId)
                ));
                if (collapsedGroup) {
                    toggleGroup(collapsedGroup.id);
                    return;
                }
            }
        }

        // The obstacle steps above are idempotent, but scrolling is not: without
        // this guard a re-render mid-flash yanks the list back to the highlighted
        // row under the user. The ref is set where a scroll actually lands, so an
        // attempt cut short by a re-render still gets to retry.
        if (scrolledHighlightIdRef.current === highlightTaskId) return;

        if (shouldVirtualize) {
            const rowIndex = groupedVirtualRows
                ? groupedVirtualRows.findIndex((row) => row.kind === 'task' && row.task.id === highlightTaskId)
                : archivedTasks.findIndex((task) => task.id === highlightTaskId);
            if (rowIndex < 0) return;
            rowVirtualizer.scrollToIndex(rowIndex, { align: 'center' });
            scrolledHighlightIdRef.current = highlightTaskId;
            focusTaskRowWhenMounted(highlightTaskId);
            return;
        }

        let retryTimer: number | null = null;
        let cancelled = false;
        let attempts = 0;
        const scrollHighlightedTask = () => {
            if (cancelled) return;
            const element = document.querySelector(`[data-task-id="${highlightTaskId}"]`) as HTMLElement | null;
            if (element && typeof element.scrollIntoView === 'function') {
                element.scrollIntoView({ block: 'center' });
                scrolledHighlightIdRef.current = highlightTaskId;
                focusTaskRowWhenMounted(highlightTaskId);
                return;
            }
            // A row can be a frame behind the state change that revealed it.
            if (attempts >= 8) return;
            attempts += 1;
            retryTimer = window.setTimeout(scrollHighlightedTask, 50);
        };
        scrollHighlightedTask();

        return () => {
            cancelled = true;
            if (retryTimer !== null) window.clearTimeout(retryTimer);
        };
    }, [
        activeFilterCriteria,
        archivedBaseTasks,
        archivedTasks,
        clearFilters,
        collapsedGroupIds,
        groupedTasks,
        groupedVirtualRows,
        handleSegmentChange,
        highlightTaskId,
        isGrouping,
        orderedTasks,
        rowVirtualizer,
        searchQuery,
        segment,
        shouldVirtualize,
        showToast,
        t,
        toggleGroup,
    ]);

    return (
        <ErrorBoundary>
            <div className={shouldFillAvailableHeight ? "flex h-full min-h-0 flex-col gap-6" : "flex flex-col gap-6"}>
            <header className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
                <div className="space-y-1">
                <div className="flex items-center gap-3">
                    <h2 className="text-3xl font-bold tracking-tight">{t('archived.title')}</h2>
                    <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5">
                        <button
                            type="button"
                            onClick={() => handleSegmentChange('tasks')}
                            className={cn(
                                'px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
                                segment === 'tasks'
                                    ? 'bg-primary text-primary-foreground'
                                    : 'text-muted-foreground hover:text-foreground'
                            )}
                        >
                            {t('common.tasks')}
                        </button>
                        <button
                            type="button"
                            onClick={() => handleSegmentChange('projects')}
                            className={cn(
                                'px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
                                segment === 'projects'
                                    ? 'bg-primary text-primary-foreground'
                                    : 'text-muted-foreground hover:text-foreground'
                            )}
                        >
                            {t('projects.title')}
                        </button>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
                    <span>
                        {segment === 'tasks'
                            ? `${archivedTasks.length} ${t('common.tasks')}`
                            : `${archivedProjects.length} ${t('projects.title')}`}
                    </span>
                    {segment === 'tasks' && hasFilters && (
                        <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary sm:max-w-[420px]">
                            <SlidersHorizontal className="h-3 w-3 shrink-0" aria-hidden="true" />
                            <span className="truncate">{filterSummaryLabel}{filterSummarySuffix}</span>
                        </span>
                    )}
                </div>
                </div>

                {segment === 'tasks' && (
                    <div className="flex flex-wrap items-center gap-2 xl:justify-end">
                        <ToolbarButton
                            active={filtersOpen}
                            onClick={() => setFiltersOpen(!filtersOpen)}
                            aria-expanded={filtersOpen}
                            aria-controls="list-filters-panel"
                            icon={<Filter className="h-3.5 w-3.5" aria-hidden="true" />}
                        >
                            {t('filters.label')}
                        </ToolbarButton>
                        {archivedTasks.length > 0 && (
                            <ToolbarButton
                                active={selectionMode}
                                onClick={toggleSelectionMode}
                                aria-pressed={selectionMode}
                                icon={<CheckSquare className="h-3.5 w-3.5" aria-hidden="true" />}
                            >
                                {selectionMode ? t('common.done') : t('bulk.select')}
                            </ToolbarButton>
                        )}
                        <SortBySelect
                            options={DONE_SORT_OPTIONS}
                            value={sortBy}
                            onChange={(value) => setListOptions({ archivedSortBy: value })}
                            t={t}
                            iconTestId="archive-sort-icon"
                        />
                        <GroupBySelect
                            value={archivedGroupBy}
                            axes={DONE_AXES}
                            onChange={(value) => setListOptions({ archivedGroupBy: value as DoneGroupBy })}
                            t={t}
                        />
                    </div>
                )}
            </header>

            {segment === 'tasks' && filtersOpen && (
                <ListFiltersPanel
                    t={t}
                    hasFilters={hasFilters}
                    onClearFilters={clearFilters}
                    allTokens={allTokens}
                    selectedTokens={selectedTokens}
                    excludedTokens={excludedTokens}
                    tokenCounts={tokenCounts}
                    onToggleToken={toggleToken}
                    showPriorityFilters={showPriorityFilters}
                    priorityOptions={PRIORITY_FILTER_OPTIONS}
                    selectedPriorities={selectedPriorities}
                    onTogglePriority={togglePriority}
                    showTimeEstimateFilters={showTimeEstimateFilters}
                    timeEstimateOptions={TIME_ESTIMATE_FILTER_OPTIONS}
                    selectedTimeEstimates={selectedTimeEstimates}
                    onToggleEstimate={toggleEstimate}
                    formatEstimate={formatEstimate}
                />
            )}

            {segment === 'tasks' && selectionMode && (
                <div className="space-y-2">
                    <BulkSelectionToolbar
                        selectionCount={selectedIds.size}
                        totalCount={archivedTasks.length}
                        allSelected={allVisibleSelected}
                        onSelectAll={selectAllVisible}
                        onClearSelection={clearSelection}
                        t={t}
                    />
                    <div className="flex flex-wrap justify-end gap-2">
                        <button
                            type="button"
                            onClick={() => { void handleBulkRestore(); }}
                            disabled={selectedIds.size === 0}
                            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <Undo2 className="h-3.5 w-3.5" />
                            {t('trash.restoreToInbox')}
                        </button>
                        <button
                            type="button"
                            onClick={() => { void handleBulkDelete(); }}
                            disabled={selectedIds.size === 0}
                            className="inline-flex items-center gap-1.5 rounded-md bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <Trash2 className="h-3.5 w-3.5" />
                            {t('common.delete')}
                        </button>
                    </div>
                </div>
            )}

            <div className="relative">
                <input
                    type="text"
                    // Same shape and Escape-back-to-the-list behaviour as every
                    // other view's filter input (#959).
                    data-view-filter-input
                    placeholder={segment === 'projects'
                        ? tFallback(t, 'archived.searchProjectsPlaceholder', 'Search archived projects...')
                        : t('archived.searchPlaceholder')}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className={VIEW_FILTER_INPUT}
                />
            </div>

            {segment === 'projects' ? (
                <div className={shouldVirtualizeFlatTasks ? "flex-1 min-h-0 overflow-y-auto" : undefined}>
                    <div data-list-end className={LIST_END_GAP}>
                    {archivedProjects.length === 0 ? (
                        <div className="px-1 py-8 text-left text-sm text-muted-foreground">
                            <p>{tFallback(t, 'archived.emptyProjects', 'No archived projects')}</p>
                            <p className="text-xs mt-2">{tFallback(t, 'archived.emptyProjectsHint', 'Projects you archive will appear here')}</p>
                        </div>
                    ) : (
                        <div className="divide-y divide-border/30">
                            {archivedProjects.map((project) => (
                                <ArchiveProjectRow
                                    key={project.id}
                                    project={project}
                                    areaName={project.areaId ? areaNameById.get(project.areaId) : undefined}
                                    onOpen={handleOpenProject}
                                    onRestore={handleRestoreProject}
                                    onDelete={handleDeleteProject}
                                    t={t}
                                />
                            ))}
                        </div>
                    )}
                    </div>
                </div>
            ) : (
            <div
                ref={listScrollRef}
                className={shouldVirtualize ? "flex-1 min-h-0 overflow-y-auto" : undefined}
            >
                <div data-list-end className={LIST_END_GAP}>
                {archivedTasks.length === 0 ? (
                    <div className="px-1 py-8 text-left text-sm text-muted-foreground">
                        <p>{t('archived.noTasksFound')}</p>
                        <p className="text-xs mt-2">{t('archived.emptyHint')}</p>
                    </div>
                ) : (
                    <GroupedTaskList
                        groups={groupedTasks}
                        tasks={archivedTasks}
                        virtualRows={groupedVirtualRows}
                        virtualizer={shouldVirtualize ? rowVirtualizer : null}
                        collapsedGroupIds={collapsedGroupIds}
                        onToggleGroup={toggleGroup}
                        getSectionDomId={getSectionDomId}
                        renderTask={renderArchiveRow}
                    />
                )}
                </div>
            </div>
            )}
            </div>
            {confirmModal}
        </ErrorBoundary>
    );
}
