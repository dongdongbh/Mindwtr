import { getProjectAccentColor } from '@mindwtr/core';
import React from 'react';
import {
    DndContext,
    DragOverlay,
    useDroppable,
    DragEndEvent,
    DragStartEvent,
    closestCorners,
    closestCenter,
    pointerWithin,
    rectIntersection,
    getFirstCollision,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    type CollisionDetection,
} from '@dnd-kit/core';
import {
    SortableContext,
    sortableKeyboardCoordinates,
    useSortable,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { TaskItem } from '../TaskItem';
import { ErrorBoundary } from '../ErrorBoundary';
import { shallow, useTaskStore, sortTasksBy, sortTasksByBoardOrder, buildProjectOrderMap, compareTasksByProjectThenOrder, getSequentialFirstTaskIds, getTaskSequencing, hasTaskSequences, isSequentialChainStatus, isTaskSequenceBlocked, translateWithFallback, createTaskFilterPredicate, hasActiveFilterCriteria, getUsedTaskTokens, tFallback } from '@mindwtr/core';
import { buildActiveFilterChips, removeFilterChipFromCriteria } from './list/active-filter-chips';
import { resolveBoardDragEnd } from './board-view-dnd';
import type { Task, TaskStatus, FilterCriteria } from '@mindwtr/core';
import { useLanguage } from '../../contexts/language-context';
import { Filter, GripVertical } from 'lucide-react';
import { useUiStore } from '../../store/ui-store';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import { checkBudget } from '../../config/performanceBudgets';
import { isTaskVisibleInArea, projectMatchesAreaFilterSelection } from '@mindwtr/core';
import { useAreaVisibility } from '../../hooks/useVisibleTaskContext';
import { usePersistedViewState } from '../../hooks/usePersistedViewState';
import { useTaskListScope } from './list/task-list-scope';
import { LIST_END_GAP, ToolbarButton, VIEW_FILTER_INPUT } from './list/list-toolbar';
import { resolveNonDoneTaskSortBy } from '@mindwtr/core';
import { BoardFiltersPanel } from './board/BoardFiltersPanel';
import type { DesktopActiveFilterChip } from './list/FilterDisclosure';
import { beginRendererActivity, recordRendererActivity } from '../../lib/renderer-navigation-diagnostics';

const BOARD_VIEW_STATE_STORAGE_KEY = 'mindwtr:view:board:v1';

type BoardPersistedViewState = {
    filtersOpen: boolean;
};

const DEFAULT_BOARD_VIEW_STATE: BoardPersistedViewState = {
    filtersOpen: false,
};

function sanitizeBoardViewState(value: unknown, fallback: BoardPersistedViewState): BoardPersistedViewState {
    const parsed = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Partial<BoardPersistedViewState>
        : {};
    return {
        filtersOpen: typeof parsed.filtersOpen === 'boolean' ? parsed.filtersOpen : fallback.filtersOpen,
    };
}

const COLUMN_STATUSES: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'done'];

const getColumns = (t: (key: string) => string): { id: TaskStatus; label: string }[] => [
    { id: 'inbox', label: tFallback(t, 'list.inbox', 'Inbox') },
    { id: 'next', label: t('list.next') },
    { id: 'waiting', label: t('list.waiting') },
    { id: 'someday', label: t('list.someday') },
    { id: 'done', label: t('list.done') },
];

const DUE_DATE_PRESETS = ['today', 'this_week', 'this_month', 'overdue', 'no_date'] as const;
type DueDatePreset = (typeof DUE_DATE_PRESETS)[number];

const STATUS_BORDER: Record<TaskStatus, string> = {
    inbox: 'border-t-[hsl(var(--status-inbox))]',
    next: 'border-t-[hsl(var(--status-next))]',
    waiting: 'border-t-[hsl(var(--status-waiting))]',
    someday: 'border-t-[hsl(var(--status-someday))]',
    reference: 'border-t-[hsl(var(--status-reference))]',
    done: 'border-t-[hsl(var(--status-done))]',
    archived: 'border-t-[hsl(var(--status-archived))]',
};

function DroppableColumn({
    id,
    label,
    tasks,
    emptyState,
    onQuickAdd,
    dragLabel,
    compact,
}: {
    id: TaskStatus;
    label: string;
    tasks: Task[];
    emptyState: { title: string; body: string; action: string };
    onQuickAdd: (status: TaskStatus) => void;
    dragLabel: string;
    compact?: boolean;
}) {
    const { setNodeRef } = useDroppable({ id });
    // No bottom padding on the card: it sits outside the column's scroller, so
    // it reads as a strip the list can never reach. The gap lives on the
    // scrolled content instead (#977).
    const columnPadding = compact ? 'px-2 pt-2' : 'px-3 pt-3';
    const headerMargin = compact ? 'mb-3' : 'mb-4';
    const listSpacing = compact ? 'space-y-2' : 'space-y-3';
    const columnMinWidth = compact ? 'min-w-[36ch]' : 'min-w-[40ch]';

    return (
        <div
            ref={setNodeRef}
            className={`flex flex-col h-full ${columnMinWidth} flex-1 bg-muted/20 rounded-xl border border-border/30 border-t-[3px] ${columnPadding} ${STATUS_BORDER[id]}`}
        >
            <h3 className={`font-semibold ${headerMargin} flex items-center justify-between text-sm`}>
                {label}
                <span className="text-[11px] font-medium bg-muted/60 px-2 py-0.5 rounded-full text-muted-foreground">{tasks.length}</span>
            </h3>
            <div
                className="flex-1 overflow-y-auto min-h-[100px] focus:outline-none focus:ring-2 focus:ring-primary/50 rounded-md px-1"
                tabIndex={0}
                role="list"
                aria-label={`${label} tasks list`}
            >
                <div data-list-end className={`${listSpacing} ${LIST_END_GAP}`}>
                {tasks.length === 0 ? (
                    <div className="flex flex-col items-center justify-center text-center text-xs text-muted-foreground py-6 px-2 gap-2">
                        <div className="text-sm font-medium text-foreground">{emptyState.title}</div>
                        <div>{emptyState.body}</div>
                        <button
                            type="button"
                            onClick={() => onQuickAdd(id)}
                            className="mt-1 text-xs px-2 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                        >
                            {emptyState.action}
                        </button>
                    </div>
                ) : (
                    <SortableContext items={tasks.map((task) => task.id)} strategy={verticalListSortingStrategy}>
                        {tasks.map((task) => (
                            <DraggableTask key={task.id} task={task} dragLabel={dragLabel} />
                        ))}
                    </SortableContext>
                )}
                </div>
            </div>
        </div>
    );
}

function DraggableTask({ task, dragLabel }: { task: Task; dragLabel: string }) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: task.id,
        data: { task },
    });

    const style = transform || transition ? {
        transform: CSS.Transform.toString(transform),
        transition,
    } : undefined;

    if (isDragging) {
        return (
            <div ref={setNodeRef} style={style} className="opacity-50" role="listitem">
                <TaskItem
                    task={task}
                    readOnly={task.status === 'done'}
                    showStatusSelect={false}
                    showProjectBadgeInActions={false}
                    actionsOverlay
                    showHoverHint={false}
                    enableDoubleClickEdit
                    editorPresentation="modal"
                />
            </div>
        );
    }

    return (
        <div ref={setNodeRef} style={style} className="touch-none" role="listitem">
            <TaskItem
                task={task}
                readOnly={task.status === 'done'}
                showStatusSelect={false}
                showProjectBadgeInActions={false}
                actionsOverlay
                showHoverHint={false}
                dragHandle={(
                    <button
                        type="button"
                        {...listeners}
                        {...attributes}
                        onClick={(event) => event.stopPropagation()}
                        className="text-muted-foreground/70 hover:text-foreground p-1 rounded hover:bg-muted/50 cursor-grab active:cursor-grabbing"
                        aria-label={dragLabel}
                        title={dragLabel}
                    >
                        <GripVertical className="w-4 h-4" />
                    </button>
                )}
                enableDoubleClickEdit
                editorPresentation="modal"
            />
        </div>
    );
}

export function BoardView() {
    const perf = usePerformanceMonitor('BoardView');
    const { tasks, moveTask, reorderBoardTasks, settings, projects, sections } = useTaskStore(
        (state) => ({
            tasks: state.tasks,
            moveTask: state.moveTask,
            reorderBoardTasks: state.reorderBoardTasks,
            settings: state.settings,
            projects: state.projects,
            sections: state.sections,
        }),
        shallow
    );
    const { t } = useLanguage();
    const sortBy = resolveNonDoneTaskSortBy(settings?.taskSortBy, settings);
    const isDense = (settings?.appearance?.density ?? 'comfortable') !== 'comfortable';

    const [activeTask, setActiveTask] = React.useState<Task | null>(null);
    const [computeSequential, setComputeSequential] = React.useState(false);
    const sequentialActivity = React.useRef<ReturnType<typeof beginRendererActivity>>(null);
    const sequentialPhase = React.useRef<'scheduled' | 'fired' | 'committed'>('scheduled');
    const [searchQuery, setSearchQuery] = React.useState('');
    const boardFilters = useUiStore((state) => state.boardFilters);
    const setBoardFilters = useUiStore((state) => state.setBoardFilters);
    const [persistedViewState, setPersistedViewState] = usePersistedViewState(
        BOARD_VIEW_STATE_STORAGE_KEY,
        DEFAULT_BOARD_VIEW_STATE,
        sanitizeBoardViewState
    );
    const criteria = boardFilters.criteria;
    const COLUMNS = getColumns(t);
    const hasFilters = hasActiveFilterCriteria(criteria);
    const hasSearch = searchQuery.trim().length > 0;
    const hasBoardFilters = hasFilters || hasSearch;
    const showFiltersPanel = persistedViewState.filtersOpen;
    const selectedContexts = criteria.contexts ?? [];
    const selectedTags = criteria.tags ?? [];
    const excludedContexts = criteria.excludedContexts ?? [];
    const excludedTags = criteria.excludedTags ?? [];
    const selectedTokens = [...selectedContexts, ...selectedTags];
    const excludedTokens = [...excludedContexts, ...excludedTags];
    const selectedProjectIds = criteria.projects ?? [];
    const selectedDuePreset = criteria.dueDateRange && 'preset' in criteria.dueDateRange
        ? criteria.dueDateRange.preset
        : undefined;
    const visibility = useAreaVisibility();
    const { areaById, resolvedAreaFilter } = visibility;
    const sortedProjects = React.useMemo(
        () =>
            projects
                .filter((project) => !project.deletedAt)
                .filter((project) => projectMatchesAreaFilterSelection(project, resolvedAreaFilter, areaById))
                .sort((a, b) => a.title.localeCompare(b.title)),
        [projects, resolvedAreaFilter, areaById]
    );
    const projectOrderMap = React.useMemo(() => buildProjectOrderMap(projects), [projects]);
    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: {
                distance: 6,
            },
        }),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    );

    React.useEffect(() => {
        if (!perf.enabled) return;
        const timer = window.setTimeout(() => {
            checkBudget('BoardView', perf.metrics, 'complex');
        }, 0);
        return () => window.clearTimeout(timer);
    }, [perf.enabled]);

    React.useEffect(() => {
        const activity = beginRendererActivity('board-sequential');
        sequentialActivity.current = activity;
        sequentialPhase.current = 'scheduled';
        let fired = false;
        recordRendererActivity(activity, 'scheduled');
        const timer = window.setTimeout(() => {
            fired = true;
            sequentialPhase.current = 'fired';
            recordRendererActivity(activity, 'fired');
            setComputeSequential(true);
        }, 0);
        return () => {
            window.clearTimeout(timer);
            recordRendererActivity(activity, 'cleanup', { outcome: fired ? 'already-fired' : 'cancelled' });
        };
    }, []);
    const updateCriteria = (next: FilterCriteria) => {
        setBoardFilters({ criteria: next });
    };
    const toggleStringValue = (key: 'contexts' | 'tags' | 'projects', value: string) => {
        const current = criteria[key] ?? [];
        const next = current.includes(value)
            ? current.filter((item) => item !== value)
            : [...current, value];
        updateCriteria({ ...criteria, [key]: next.length > 0 ? next : undefined });
    };
    const toggleToken = (token: string) => {
        const isTag = token.trim().startsWith('#');
        const includeKey = isTag ? 'tags' : 'contexts';
        const excludeKey = isTag ? 'excludedTags' : 'excludedContexts';
        const included = criteria[includeKey] ?? [];
        const excluded = criteria[excludeKey] ?? [];
        // Tri-state cycle: neutral → included → excluded → neutral, same as
        // Focus, the shared list panel and mobile. A token is only ever on one
        // side, so each transition clears the other.
        const next = included.includes(token)
            ? { include: included.filter((item) => item !== token), exclude: [...excluded, token] }
            : excluded.includes(token)
                ? { include: included, exclude: excluded.filter((item) => item !== token) }
                : { include: [...included, token], exclude: excluded };
        updateCriteria({
            ...criteria,
            [includeKey]: next.include.length > 0 ? next.include : undefined,
            [excludeKey]: next.exclude.length > 0 ? next.exclude : undefined,
        });
    };
    const toggleProjectFilter = (projectId: string) => {
        toggleStringValue('projects', projectId);
    };
    const toggleDuePreset = (preset: DueDatePreset) => {
        updateCriteria({
            ...criteria,
            dueDateRange: selectedDuePreset === preset ? undefined : { preset },
        });
    };
    const setMatchMode = (kind: 'context' | 'tag', mode: 'any' | 'all') => {
        const key = kind === 'context' ? 'contextMatchMode' : 'tagMatchMode';
        updateCriteria({ ...criteria, [key]: mode });
    };
    const clearFilters = () => {
        updateCriteria({});
        setSearchQuery('');
    };

    const handleDragStart = (event: DragStartEvent) => {
        setActiveTask(event.active.data.current?.task || null);
    };

    // Sort tasks for consistency, filter out deleted
    const sortedTasks = React.useMemo(
        () => sortTasksBy(tasks.filter(t => !t.deletedAt), sortBy),
        [tasks, sortBy],
    );
    const areaFilteredTasks = React.useMemo(
        () => sortedTasks.filter((task) => isTaskVisibleInArea(task, visibility)),
        [sortedTasks, visibility]
    );
    const allTokens = React.useMemo(
        () => getUsedTaskTokens(areaFilteredTasks, (task) => [...(task.contexts || []), ...(task.tags || [])], { includeAncestors: true }),
        [areaFilteredTasks]
    );
    const criteriaFilteredTasks = React.useMemo(() => {
        const now = new Date();
        return hasFilters
            ? areaFilteredTasks.filter(createTaskFilterPredicate(criteria, { projects, now }))
            : areaFilteredTasks;
    }, [areaFilteredTasks, criteria, hasFilters, projects]);
    const normalizedSearchQuery = React.useMemo(() => searchQuery.trim().toLowerCase(), [searchQuery]);
    const filteredTasks = React.useMemo(() => {
        if (!normalizedSearchQuery) return criteriaFilteredTasks;
        return criteriaFilteredTasks.filter((task) => task.title.toLowerCase().includes(normalizedSearchQuery));
    }, [criteriaFilteredTasks, normalizedSearchQuery]);
    // One core answer for which tasks are in a sequence, Per section projects included (#1429).
    const sequencing = React.useMemo(() => getTaskSequencing(projects, sections), [projects, sections]);

    const sequentialProjectFirstTasks = React.useMemo(() => {
        perf.trackUseMemo();
        return perf.measure('sequentialProjectFirstTasks', () => {
            if (!computeSequential) return new Set<string>();
            if (!hasTaskSequences(sequencing)) return new Set<string>();
            // Waiting tasks hold their chain slot too (a waiting first step
            // blocks the later ones), so they join the slot computation even
            // though the board never renders them in the Next column.
            // Sequences come from the area-visible list, before criteria and search: a filter
            // that hides step 1 must hide the step, not promote step 2 (#1429 review N1).
            const chainTasks = areaFilteredTasks.filter((task) => !task.deletedAt && isSequentialChainStatus(task.status));
            return getSequentialFirstTaskIds(chainTasks, sequencing.sequentialProjectIds, {
                sectionScopedProjectIds: sequencing.sectionScopedProjectIds,
                sequentialSectionKeys: sequencing.sequentialSectionKeys,
                sections,
            });
        });
    }, [areaFilteredTasks, computeSequential, sections, sequencing]);

    const sortByProjectOrder = React.useCallback(
        (items: Task[]) => [...items].sort(compareTasksByProjectThenOrder(projectOrderMap)),
        [projectOrderMap],
    );

    const getColumnTasks = React.useCallback((status: TaskStatus) => {
        let list = filteredTasks.filter((task) => task.status === status);
        if (status === 'next') {
            list = list.filter((task) => (
                !computeSequential || !isTaskSequenceBlocked(task, sequencing, sequentialProjectFirstTasks)
            ));
            if (sortBy === 'default') {
                list = sortByProjectOrder(list);
            }
        }
        return sortBy === 'default' ? sortTasksByBoardOrder(list) : list;
    }, [computeSequential, filteredTasks, sequencing, sequentialProjectFirstTasks, sortBy, sortByProjectOrder]);

    const columnIdSet = React.useMemo(
        () => new Set<string>(getColumns(t).map((column) => column.id)),
        [t]
    );

    // Keyboard order matches the reading order of the board: column by column,
    // card by card.
    const visibleTasks = React.useMemo(
        () => COLUMN_STATUSES.flatMap((status) => getColumnTasks(status)),
        [getColumnTasks],
    );
    React.useEffect(() => {
        if (!computeSequential || sequentialPhase.current !== 'fired') return;
        sequentialPhase.current = 'committed';
        recordRendererActivity(sequentialActivity.current, 'committed', {
            filteredCount: filteredTasks.length, visibleCount: visibleTasks.length,
            sequentialProjectCount: sequencing.sequentialProjectIds.size + sequencing.sequentialSectionKeys.size,
            sequentialResultCount: sequentialProjectFirstTasks.size,
        });
    }, [computeSequential, filteredTasks, visibleTasks, sequencing, sequentialProjectFirstTasks]);
    const [selectedTaskIndex, setSelectedTaskIndex] = React.useState(0);
    useTaskListScope({
        getTasks: () => visibleTasks,
        getSelectedIndex: () => selectedTaskIndex,
        setSelectedIndex: setSelectedTaskIndex,
        t,
    });
    // Lock onto the column the drag is over, then snap to the closest card *within* that
    // column (by the dragged item's rect, not the raw pointer). Without this, releasing in
    // the gap between cards falls through to the column droppable and lands at the bottom,
    // which made cross-column placement feel inconsistent (#791).
    const collisionDetection = React.useCallback<CollisionDetection>((args) => {
        const pointerHits = pointerWithin(args);
        const intersections = pointerHits.length > 0 ? pointerHits : rectIntersection(args);
        const overId = getFirstCollision(intersections, 'id');
        if (overId == null) return closestCorners(args);

        if (columnIdSet.has(String(overId))) {
            const cardIds = new Set(getColumnTasks(overId as TaskStatus).map((task) => task.id));
            const columnCards = args.droppableContainers.filter((container) => cardIds.has(String(container.id)));
            if (columnCards.length > 0) {
                const closest = closestCenter({ ...args, droppableContainers: columnCards });
                if (closest.length > 0) return closest;
            }
        }
        return [{ id: overId }];
    }, [columnIdSet, getColumnTasks]);

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        setActiveTask(null);
        if (!over) return;

        const currentTask = tasks.find((task) => task.id === active.id);
        if (activeTask && currentTask && currentTask.status !== activeTask.status) return;

        const overTask = over.data.current?.task as Task | undefined;
        const action = resolveBoardDragEnd({
            activeId: String(active.id),
            overId: String(over.id),
            columnIds: COLUMNS.map((column) => column.id),
            activeStatus: currentTask?.status,
            overStatus: overTask?.status,
            columnTaskIds: currentTask ? getColumnTasks(currentTask.status).map((task) => task.id) : [],
            overColumnTaskIds: overTask ? getColumnTasks(overTask.status).map((task) => task.id) : undefined,
            canReorder: sortBy === 'default',
        });
        if (action.type === 'move') {
            moveTask(action.taskId, action.status);
        } else if (action.type === 'reorder') {
            void reorderBoardTasks(action.status, action.orderedIds);
        } else if (action.type === 'moveAndReorder') {
            // Change status first (keeps recurrence handling), then place at the dropped index.
            void (async () => {
                await moveTask(action.taskId, action.status);
                await reorderBoardTasks(action.status, action.orderedIds);
            })();
        }
    };

    const resolveText = React.useCallback((key: string, fallback: string) => {
        return translateWithFallback(t, key, fallback);
    }, [t]);
    const searchTasksLabel = resolveText('filters.searchTasks', 'Search task titles');
    const activeFilterChips: DesktopActiveFilterChip[] = [];
    const normalizedSearch = searchQuery.trim();
    if (normalizedSearch) {
        activeFilterChips.push({
            id: 'search',
            label: `${searchTasksLabel}: ${normalizedSearch}`,
            onRemove: () => setSearchQuery(''),
        });
    }
    buildActiveFilterChips(criteria, {
        t,
        resolveText,
        getProject: (projectId) => projects.find((candidate) => candidate.id === projectId),
        getAreaColor: (areaId) => areaById.get(areaId)?.color,
        getAreaLabel: (areaId) => areaById.get(areaId)?.name,
    }, { duePresetAsBasic: true, metadataAsAdvanced: true }).forEach((chip) => {
        activeFilterChips.push({
            ...chip,
            onRemove: () => updateCriteria(removeFilterChipFromCriteria(criteria, chip.id)),
        });
    });

    const openQuickAdd = (status: TaskStatus) => {
        window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
            detail: { initialProps: { status } },
        }));
    };

    const getEmptyState = (status: TaskStatus) => {
        switch (status) {
            case 'inbox':
                return {
                    title: tFallback(t, 'list.inbox', 'Inbox'),
                    body: resolveText('inbox.emptyAddHint', 'Inbox is clear. Capture something new.'),
                    action: tFallback(t, 'common.add', 'Add'),
                };
            case 'next':
                return {
                    title: tFallback(t, 'list.next', 'Next Actions'),
                    body: resolveText('list.noTasks', 'No next actions yet.'),
                    action: tFallback(t, 'common.add', 'Add'),
                };
            case 'waiting':
                return {
                    title: resolveText('waiting.empty', tFallback(t, 'list.waiting', 'Waiting')),
                    body: resolveText('waiting.emptyHint', 'Track delegated or pending items.'),
                    action: tFallback(t, 'common.add', 'Add'),
                };
            case 'someday':
                return {
                    title: resolveText('someday.empty', tFallback(t, 'list.someday', 'Someday')),
                    body: resolveText('someday.emptyHint', 'Store ideas for later.'),
                    action: tFallback(t, 'common.add', 'Add'),
                };
            case 'done':
                return {
                    title: tFallback(t, 'list.done', 'Done'),
                    body: resolveText('list.noTasks', 'Completed tasks appear here.'),
                    action: tFallback(t, 'common.add', 'Add'),
                };
            default:
                return {
                    title: tFallback(t, 'list.inbox', 'Inbox'),
                    body: resolveText('list.noTasks', 'No tasks yet.'),
                    action: tFallback(t, 'common.add', 'Add'),
                };
        }
    };

    return (
        <ErrorBoundary>
            <div className="flex h-full min-h-0 flex-col">
                <div className="shrink-0 px-4 pb-4">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <h2 className="text-2xl font-bold tracking-tight">{t('board.title')}</h2>
                            <span className="text-xs text-muted-foreground">
                                {filteredTasks.length} {t('common.tasks')}
                            </span>
                        </div>
                        <div className="flex items-center gap-2">
                            <ToolbarButton
                                active={showFiltersPanel || hasBoardFilters}
                                onClick={() => setPersistedViewState((current) => ({ filtersOpen: !current.filtersOpen }))}
                                aria-expanded={showFiltersPanel}
                                aria-controls="board-filters-panel"
                                icon={<Filter className="h-3.5 w-3.5" aria-hidden="true" />}
                            >
                                {t('filters.label')}
                            </ToolbarButton>
                        </div>
                    </div>
                    <div className="mt-3">
                        <input
                            type="text"
                            data-view-filter-input
                            placeholder={searchTasksLabel}
                            aria-label={searchTasksLabel}
                            value={searchQuery}
                            onChange={(event) => setSearchQuery(event.target.value)}
                            className={VIEW_FILTER_INPUT}
                        />
                    </div>
                    {sortBy !== 'default' && (
                        <p className="mt-2 text-xs text-muted-foreground">
                            {resolveText('board.reorderFollowsSort', 'Ordering follows the selected sort. Switch to default sort to reorder cards.')}
                        </p>
                    )}

                    {(showFiltersPanel || hasBoardFilters) && (
                        <BoardFiltersPanel
                            activeFilterChips={activeFilterChips}
                            allTokens={allTokens}
                            // The board filter passes no tokenMatchMode, so core
                            // matches with "any" — the control shows that, unlike
                            // the List and Focus panels which filter with "all".
                            contextMatchMode={criteria.contextMatchMode ?? 'any'}
                            duePresets={DUE_DATE_PRESETS}
                            excludedTokens={excludedTokens}
                            hasFilters={hasBoardFilters}
                            onClearFilters={clearFilters}
                            onClose={() => setPersistedViewState((current) => ({ ...current, filtersOpen: false }))}
                            onContextMatchModeChange={(mode) => setMatchMode('context', mode)}
                            onTagMatchModeChange={(mode) => setMatchMode('tag', mode)}
                            onToggleDuePreset={(preset) => toggleDuePreset(preset as DueDatePreset)}
                            onToggleProject={toggleProjectFilter}
                            onToggleToken={toggleToken}
                            projectOptions={sortedProjects.map((project) => ({
                                id: project.id,
                                title: project.title,
                                dotColor: getProjectAccentColor(project, areaById),
                            }))}
                            selectedDuePreset={selectedDuePreset}
                            selectedProjectIds={selectedProjectIds}
                            selectedTokens={selectedTokens}
                            showFiltersPanel={showFiltersPanel}
                            tagMatchMode={criteria.tagMatchMode ?? 'any'}
                            t={t}
                        />
                    )}
                </div>

                <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden">
                    <div className="flex gap-4 h-full min-w-full pb-4 px-4">
                        <DndContext
                            onDragStart={handleDragStart}
                            onDragEnd={handleDragEnd}
                            collisionDetection={collisionDetection}
                            sensors={sensors}
                        >
                            {COLUMNS.map((col) => (
                                <DroppableColumn
                                    key={col.id}
                                    id={col.id}
                                    label={col.label}
                                    tasks={getColumnTasks(col.id)}
                                    emptyState={getEmptyState(col.id)}
                                    onQuickAdd={openQuickAdd}
                                    dragLabel={tFallback(t, 'board.dragTask', 'Drag task')}
                                    compact={isDense}
                                />
                            ))}

                            <DragOverlay>
                                {activeTask ? (
                                    <div className="w-80 rotate-3 cursor-grabbing">
                                        <TaskItem
                                            task={activeTask}
                                            showStatusSelect={false}
                                            showProjectBadgeInActions={false}
                                            actionsOverlay
                                            showHoverHint={false}
                                        />
                                    </div>
                                ) : null}
                            </DragOverlay>
                        </DndContext>
                    </div>
                </div>
            </div>
        </ErrorBoundary>
    );
}
