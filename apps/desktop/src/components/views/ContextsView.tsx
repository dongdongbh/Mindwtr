import { createPortal } from 'react-dom';
import { ViewSidebarContext } from '../../contexts/view-sidebar-context';
import { useState, useContext, useEffect, useMemo, useCallback, useRef, type DragEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
    useTaskStore,
    taskMatchesContextOrTagSelection,
    shallow,
    sortTasksBy,
    TaskStatus,
    getFrequentTaskTokens,
    getUsedTaskTokens,
    buildContextsTokenIndex,
    buildContextsViewFilterSections,
    getContextsTokenCount,
    collectBulkTaskTokens,
    normalizeBulkTaskTokenInput,
    flushPendingSave,
    formatI18nTemplate,
    tFallback,
    updateTaskFromLatest,
    type Task,
    type ContextOrTagMatchMode,
} from '@mindwtr/core';
import { AtSign, CheckSquare, ChevronDown, ChevronRight, Filter, Hash, List, Tag, type LucideIcon } from 'lucide-react';
import { TokenPickerModal } from '../TokenPickerModal';
import { BulkSelectionToolbar } from './list/BulkSelectionToolbar';
import { ListBulkActions } from './list/ListBulkActions';
import { cn } from '../../lib/utils';
import { useLanguage } from '../../contexts/language-context';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import { checkBudget } from '../../config/performanceBudgets';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';
import { useVisibleTaskContext } from '../../hooks/useVisibleTaskContext';
import { useTaskSelection } from './list/useTaskSelection';
import {
    LIST_VIRTUALIZATION_THRESHOLD,
    LIST_VIRTUAL_HEADER_ESTIMATE,
    LIST_VIRTUAL_OVERSCAN_ROWS,
    LIST_VIRTUAL_ROW_ESTIMATE,
} from './list/virtual-list';
import { StoreTaskItem } from './list/StoreTaskItem';
import { useTaskListScope } from './list/task-list-scope';
import { usePersistedViewState } from '../../hooks/usePersistedViewState';
import {
    CONTEXTS_VIEW_STATE_STORAGE_KEY,
    DEFAULT_CONTEXTS_VIEW_STATE,
    NO_CONTEXT_TOKEN,
    sanitizeContextsViewState,
    subscribeContextsTokenSelection,
    type ContextsViewGroupBy,
} from '../../lib/contexts-view-state';
import { CONTEXTS_AXES, groupTasks, type TaskGroup } from './list/next-grouping';
import { GroupedTaskList } from './list/GroupedTaskSections';
import { useCollapsedGroupsViewState, useTaskGroupCollapse } from './list/useTaskGroupCollapse';
import { LIST_END_GAP, ToolbarButton, VIEW_FILTER_INPUT } from './list/list-toolbar';
import { ViewControls } from './list/ViewControls';
import { useUiStore } from '../../store/ui-store';
import { resolveNonDoneTaskSortBy } from '@mindwtr/core';
import { CALENDAR_TASK_DRAG_MIME, getCalendarTaskDragTaskId } from '../../lib/calendar-task-drag';
import { showUndoToast } from '../../lib/undo-registry';

type BulkTokenPickerState = {
    field: 'tags' | 'contexts';
    action: 'add' | 'remove';
} | null;

const hasContext = (task: Task) => (task.contexts?.length || 0) > 0 || (task.tags?.length || 0) > 0;

// Its own key, not a field on the contexts view state: persistContextsViewSelection
// rewrites that key from a fixed three-field shape, so any fold stored there would be
// dropped the next time another view navigated to a token.
const CONTEXTS_GROUP_COLLAPSE_STORAGE_KEY = 'mindwtr:view:contexts:groups:v1';
const CLEAR_SELECTION_OPTION = '__clear__';

export function ContextsView() {
    const sidebarSlot = useContext(ViewSidebarContext);
    const perf = usePerformanceMonitor('ContextsView');
    const { tasksById, projects, areas, settings, theme, undoNotificationsEnabled, updateSettings } = useTaskStore(
        (state) => ({
            tasksById: state._tasksById,
            projects: state.projects,
            areas: state.areas,
            settings: state.settings,
            theme: state.settings?.theme,
            undoNotificationsEnabled: state.settings?.undoNotificationsEnabled !== false,
            updateSettings: state.updateSettings,
        }),
        shallow
    );
    const batchMoveTasks = useTaskStore((state) => state.batchMoveTasks);
    const batchDeleteTasks = useTaskStore((state) => state.batchDeleteTasks);
    const batchUpdateTasks = useTaskStore((state) => state.batchUpdateTasks);
    const restoreTask = useTaskStore((state) => state.restoreTask);
    const { t } = useLanguage();
    const {
        showToast,
        showListDetails,
        setListOptions,
        collapseAllTaskDetails,
    } = useUiStore((state) => ({
        showToast: state.showToast,
        showListDetails: state.listOptions.showDetails,
        setListOptions: state.setListOptions,
        collapseAllTaskDetails: state.collapseAllTaskDetails,
    }), shallow);
    const [persistedViewState, setPersistedViewState] = usePersistedViewState(
        CONTEXTS_VIEW_STATE_STORAGE_KEY,
        DEFAULT_CONTEXTS_VIEW_STATE,
        sanitizeContextsViewState
    );
    const { collapsedGroups, setCollapsedGroups } = useCollapsedGroupsViewState(
        CONTEXTS_GROUP_COLLAPSE_STORAGE_KEY,
        CONTEXTS_AXES,
    );
    const selectedContexts = persistedViewState.selectedContexts;
    const noContextSelected = selectedContexts.includes(NO_CONTEXT_TOKEN);
    const matchMode = persistedViewState.matchMode;
    const statusFilters = persistedViewState.statusFilters;
    const selectedStatusSet = useMemo(() => new Set(statusFilters), [statusFilters]);
    const sortBy = resolveNonDoneTaskSortBy(settings?.taskSortBy, settings);
    const [searchQuery, setSearchQuery] = useState('');
    const [bulkTokenPicker, setBulkTokenPicker] = useState<BulkTokenPickerState>(null);
    const [contextsCollapsed, setContextsCollapsed] = useState(false);
    const [tagsCollapsed, setTagsCollapsed] = useState(false);
    const [hoveredContext, setHoveredContext] = useState<string | null>(null);
    const pendingContextDrops = useRef(new Set<string>());
    useEffect(() => {
        const clearHover = () => setHoveredContext(null);
        window.addEventListener('dragend', clearHover);
        return () => window.removeEventListener('dragend', clearHover);
    }, []);
    const listScrollRef = useRef<HTMLDivElement>(null);
    const { requestConfirmation, confirmModal } = useConfirmDialog();
    const setSelectedContext = useCallback((value: string | null) => {
        setPersistedViewState((current) => ({
            ...current,
            selectedContexts: value ? [value] : [],
            matchMode: 'all',
        }));
    }, [setPersistedViewState]);
    const toggleSelectedContext = useCallback((value: string) => {
        setPersistedViewState((current) => {
            const next = current.selectedContexts.includes(value)
                ? current.selectedContexts.filter((token) => token !== value)
                : [...current.selectedContexts.filter((token) => token !== NO_CONTEXT_TOKEN), value];
            return { ...current, selectedContexts: next, matchMode: next.length === 0 ? 'all' : current.matchMode };
        });
    }, [setPersistedViewState]);
    const setMatchMode = useCallback((value: ContextOrTagMatchMode) => {
        setPersistedViewState((current) => ({ ...current, matchMode: value }));
    }, [setPersistedViewState]);
    const setStatusFilters = useCallback((updater: (current: TaskStatus[]) => TaskStatus[]) => {
        setPersistedViewState((current) => ({
            ...current,
            statusFilters: updater(current.statusFilters),
        }));
    }, [setPersistedViewState]);
    const clearStatusFilters = useCallback(() => {
        setStatusFilters(() => []);
    }, [setStatusFilters]);
    const toggleStatusFilter = useCallback((value: TaskStatus) => {
        setStatusFilters((current) => (
            current.includes(value)
                ? current.filter((status) => status !== value)
                : [...current, value]
        ));
    }, [setStatusFilters]);
    useEffect(() => subscribeContextsTokenSelection(({ selectedContext: nextSelectedContext }) => {
        setSelectedContext(nextSelectedContext);
        setSearchQuery('');
    }), [setSelectedContext]);
    // Deleted, parked-project and out-of-area tasks are all gone from
    // `activeTasks` — one core predicate, shared with every other list.
    const { projectById: projectMap, visibleTasks: activeTasks } = useVisibleTaskContext();

    useEffect(() => {
        if (!perf.enabled) return;
        const timer = window.setTimeout(() => {
            checkBudget('ContextsView', perf.metrics, 'simple');
        }, 0);
        return () => window.clearTimeout(timer);
    }, [perf.enabled]);

    const hasExplicitStatusFilter = statusFilters.length > 0;
    // One memoized chain from here to sortedTasks: every step feeds a downstream
    // useMemo, the virtualizer's count and getItemKey, and the array handed to
    // useTaskSelection, so a fresh array anywhere invalidates all of them (#856).
    const scopedTasks = useMemo(() => {
        const baseTasks = activeTasks.filter(t =>
            t.status !== 'archived'
            && (selectedStatusSet.has('done') || t.status !== 'done')
        );
        return hasExplicitStatusFilter
            ? baseTasks.filter(t => selectedStatusSet.has(t.status))
            : baseTasks;
    }, [activeTasks, hasExplicitStatusFilter, selectedStatusSet]);

    const tokenIndex = useMemo(() => buildContextsTokenIndex(scopedTasks, { includeFinished: true }), [scopedTasks]);
    const filterSections = useMemo(() => buildContextsViewFilterSections({
        contextTokens: tokenIndex.contextTokens,
        tagTokens: tokenIndex.tagTokens,
        selectedTokens: selectedContexts,
        searchQuery: '',
    }), [tokenIndex, selectedContexts]);
    const allContextTokens = filterSections.find((section) => section.kind === 'contexts')?.tokens ?? [];
    const allTagTokens = filterSections.find((section) => section.kind === 'tags')?.tokens ?? [];
    const allTokens = useMemo(() => [...allContextTokens, ...allTagTokens], [allContextTokens, allTagTokens]);

    const contextFilteredTasks = useMemo(() => {
        if (noContextSelected) return scopedTasks.filter((t) => !hasContext(t));
        if (selectedContexts.length > 0) return scopedTasks.filter(t => taskMatchesContextOrTagSelection(t, selectedContexts, matchMode));
        return scopedTasks.filter((t) => hasContext(t));
    }, [scopedTasks, selectedContexts, noContextSelected, matchMode]);
    const normalizedSearchQuery = searchQuery.trim().toLowerCase();
    const filteredTasks = useMemo(() => (normalizedSearchQuery
        ? contextFilteredTasks.filter((task) => task.title.toLowerCase().includes(normalizedSearchQuery))
        : contextFilteredTasks
    ), [contextFilteredTasks, normalizedSearchQuery]);
    const sortedTasks = useMemo(() => sortTasksBy(filteredTasks, sortBy), [filteredTasks, sortBy]);
    const groupBy = persistedViewState.groupBy;
    const setGroupBy = useCallback((value: ContextsViewGroupBy) => {
        setPersistedViewState((current) => ({
            ...current,
            groupBy: value,
        }));
    }, [setPersistedViewState]);
    const groupedTasks = useMemo<TaskGroup[]>(
        () => groupTasks(groupBy, { tasks: sortedTasks, areas, projectMap, t, theme }),
        [areas, groupBy, projectMap, sortedTasks, t, theme],
    );
    const {
        collapsedGroupIds,
        getSectionDomId,
        toggleGroup,
        virtualRows: groupedVirtualRows,
        // Grouping reorders the rows, so the keyboard walk and "Select all" walk
        // the grouped order. A collapsed group renders no rows, so it contributes
        // no tasks either.
        visibleTasks,
    } = useTaskGroupCollapse({
        axis: groupBy,
        groups: groupedTasks,
        tasks: sortedTasks,
        idPrefix: 'contexts-group',
        collapsedGroups,
        setCollapsedGroups,
    });
    const filteredTaskIds = useMemo(() => visibleTasks.map((task) => task.id), [visibleTasks]);
    const {
        activeAction,
        allVisibleTasksSelected,
        moveSelectedTasksToDestination,
        assignEnergyToSelectedTasks,
        clearTaskSelection,
        deleteSelectedTasks,
        exportSelectedTasks,
        isExporting,
        multiSelectedIds,
        moveSelectedTasks,
        selectedIdsArray,
        selectionMode,
        selectAllVisibleTasks,
        toggleMultiSelect,
        toggleSelectionMode,
        updateSelectedTaskTokens,
    } = useTaskSelection(filteredTaskIds, {
        batchDeleteTasks,
        batchMoveTasks,
        batchUpdateTasks,
        restoreTask,
        showToast,
        t,
        tasksById,
        undoNotificationsEnabled,
    });
    // One engine for both shapes, as in ListView and ArchiveView: grouped rows
    // carry headers, flat rows are the sorted tasks.
    const virtualRowCount = groupedVirtualRows?.length ?? sortedTasks.length;
    const shouldVirtualize = virtualRowCount > LIST_VIRTUALIZATION_THRESHOLD;
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
            if (!row) return sortedTasks[index]?.id ?? index;
            return row.kind === 'header'
                ? `group:${row.group.id}`
                : `task:${row.group.id}:${row.task.id}`;
        },
    });
    const addTagOptions = useMemo(
        () => Array.from(new Set([
            ...getFrequentTaskTokens(activeTasks, (task) => task.tags, 12, { prefix: '#' }),
            ...getUsedTaskTokens(activeTasks, (task) => task.tags, { prefix: '#' }),
        ])),
        [activeTasks]
    );
    const addContextOptions = useMemo(
        () => Array.from(new Set([
            ...getFrequentTaskTokens(activeTasks, (task) => task.contexts, 12, { prefix: '@' }),
            ...getUsedTaskTokens(activeTasks, (task) => task.contexts, { prefix: '@' }),
        ])),
        [activeTasks]
    );

    const [selectedTaskIndex, setSelectedTaskIndex] = useState(0);
    useTaskListScope({
        getTasks: () => visibleTasks,
        getSelectedIds: () => multiSelectedIds,
        getSelectedIndex: () => selectedTaskIndex,
        setSelectedIndex: setSelectedTaskIndex,
        t,
        toggleSelect: (task) => toggleMultiSelect(task.id),
    });
    const removableTagOptions = useMemo(
        () => collectBulkTaskTokens(selectedIdsArray, tasksById, 'tags'),
        [selectedIdsArray, tasksById]
    );
    const removableContextOptions = useMemo(
        () => collectBulkTaskTokens(selectedIdsArray, tasksById, 'contexts'),
        [selectedIdsArray, tasksById]
    );

    const renderContextTask = useCallback((task: Task) => (
        <StoreTaskItem
            key={task.id}
            taskId={task.id}
            selectionMode={selectionMode}
            isMultiSelected={multiSelectedIds.has(task.id)}
            onToggleSelectId={toggleMultiSelect}
            showProjectBadgeInActions={false}
            compactMetaEnabled={showListDetails}
        />
    ), [multiSelectedIds, selectionMode, showListDetails, toggleMultiSelect]);

    const handleToggleDetails = useCallback(() => {
        if (showListDetails) {
            collapseAllTaskDetails();
            setListOptions({ showDetails: false });
            return;
        }
        setListOptions({ showDetails: true });
    }, [collapseAllTaskDetails, setListOptions, showListDetails]);

    const handleBatchMove = moveSelectedTasks;

    const handleBatchDelete = async () => {
        await deleteSelectedTasks({
            confirm: () => requestConfirmation({
                title: tFallback(t, 'common.delete', 'Delete'),
                description: tFallback(t, 'list.confirmBatchDelete', 'Delete selected tasks?'),
                confirmLabel: tFallback(t, 'common.delete', 'Delete'),
                cancelLabel: tFallback(t, 'common.cancel', 'Cancel'),
            }),
        });
    };

    const handleBatchRemoveTag = () => {
        if (selectedIdsArray.length === 0) return;
        setBulkTokenPicker({ field: 'tags', action: 'remove' });
    };

    const handleBatchPickTag = () => {
        if (selectedIdsArray.length === 0) return;
        setBulkTokenPicker({ field: 'tags', action: 'add' });
    };

    const handleBatchPickContext = (action: 'add' | 'remove') => {
        if (selectedIdsArray.length === 0) return;
        setBulkTokenPicker({ field: 'contexts', action });
    };

    const handleBatchRemoveContext = () => {
        if (selectedIdsArray.length === 0) return;
        setBulkTokenPicker({ field: 'contexts', action: 'remove' });
    };

    const handleBatchMoveToDestination = moveSelectedTasksToDestination;

    const handleBatchAssignEnergyLevel = assignEnergyToSelectedTasks;

    const removeTagLabelRaw = t('bulk.removeTag');
    const removeTagLabel = removeTagLabelRaw === 'bulk.removeTag' ? 'Remove tag' : removeTagLabelRaw;
    const tokenPickerTitle = (() => {
        if (!bulkTokenPicker) return '';
        if (bulkTokenPicker.field === 'tags') {
            return bulkTokenPicker.action === 'add' ? t('bulk.addTag') : removeTagLabel;
        }
        return bulkTokenPicker.action === 'add' ? t('bulk.addContext') : t('bulk.removeContext');
    })();
    const tokenPickerOptions = (() => {
        if (!bulkTokenPicker) return [] as string[];
        if (bulkTokenPicker.field === 'tags') {
            return bulkTokenPicker.action === 'add' ? addTagOptions : removableTagOptions;
        }
        return bulkTokenPicker.action === 'add' ? addContextOptions : removableContextOptions;
    })();
    const tokenPickerPlaceholder = bulkTokenPicker?.field === 'tags' ? '#tag' : '@context';

    const statusOptions: Array<{ value: TaskStatus | 'all'; label: string }> = [
        { value: 'all', label: tFallback(t, 'common.all', 'All') },
        { value: 'inbox', label: t('status.inbox') },
        { value: 'next', label: t('status.next') },
        { value: 'waiting', label: t('status.waiting') },
        { value: 'someday', label: t('status.someday') },
        { value: 'reference', label: t('status.reference') },
        { value: 'done', label: t('status.done') },
    ];
    const contextsLabel = tFallback(t, 'taskEdit.contextsLabel', 'Contexts');
    const tagsLabel = tFallback(t, 'taskEdit.tagsLabel', 'Tags');
    const allTokensLabel = `${contextsLabel} & ${tagsLabel}`;

    const contextDropLabel = (key: 'contexts.dropAdd' | 'contexts.dropAdded', context: string) =>
        formatI18nTemplate(t(key), { context });
    const acceptsContextDrop = (event: DragEvent<HTMLButtonElement>, context: string) => {
        if (!Array.from(event.dataTransfer.types).includes(CALENDAR_TASK_DRAG_MIME)) return false;
        const id = getCalendarTaskDragTaskId(event.dataTransfer);
        // Native dragover protects the payload until drop; the MIME still identifies our task drag.
        if (!id) return true;
        const task = useTaskStore.getState()._tasksById.get(id);
        return !!task && !task.deletedAt && !pendingContextDrops.current.has(id)
            && !task.contexts.some((token) => normalizeBulkTaskTokenInput(token, 'contexts') === context);
    };
    const handleContextDrop = async (event: DragEvent<HTMLButtonElement>, context: string) => {
        setHoveredContext(null);
        if (!acceptsContextDrop(event, context)) return;
        event.preventDefault();
        const id = getCalendarTaskDragTaskId(event.dataTransfer);
        if (!id) return;
        const task = useTaskStore.getState()._tasksById.get(id);
        if (!task || task.deletedAt) return;
        pendingContextDrops.current.add(id);
        try {
            // Add and remove the context on the latest row, so a context a sync save added meanwhile is kept.
            const hasContext = (contexts: string[]) => contexts.some((token) => normalizeBulkTaskTokenInput(token, 'contexts') === context);
            const result = await updateTaskFromLatest(id, (latest) => (
                hasContext(latest.contexts) ? null : { contexts: [...latest.contexts, context] }
            ));
            if (!result.success) throw new Error(result.error);
            await flushPendingSave();
            let undone = false;
            const undo = async () => {
                if (undone || pendingContextDrops.current.has(id)) return;
                const latest = useTaskStore.getState()._tasksById.get(id);
                if (!latest || latest.deletedAt) {
                    undone = true;
                    return;
                }
                if (!hasContext(latest.contexts)) {
                    undone = true;
                    return;
                }
                pendingContextDrops.current.add(id);
                try {
                    const result = await updateTaskFromLatest(id, (current) => (hasContext(current.contexts)
                        ? { contexts: current.contexts.filter((token) => normalizeBulkTaskTokenInput(token, 'contexts') !== context) }
                        : null));
                    if (!result.success) throw new Error(result.error);
                    await flushPendingSave();
                    undone = true;
                } catch {
                    showToast(t('contexts.dropUndoFailed'), 'error');
                } finally {
                    pendingContextDrops.current.delete(id);
                }
            };
            const message = contextDropLabel('contexts.dropAdded', context);
            showUndoToast(message, () => { void undo(); }, t);
            if (useTaskStore.getState().settings?.undoNotificationsEnabled === false) showToast(message, 'success');
        } catch {
            showToast(t('contexts.dropFailed'), 'error');
        } finally {
            pendingContextDrops.current.delete(id);
        }
    };

    const renderTokenRow = (token: string, marker: '@' | '#') => {
        const taskCount = getContextsTokenCount(tokenIndex, token);
        const context = normalizeBulkTaskTokenInput(token, 'contexts');
        const isHovered = marker === '@' && hoveredContext === token;
        return (
            <button
                key={token}
                type="button"
                onClick={() => toggleSelectedContext(token)}
                onDragOver={marker === '@' ? (event) => {
                    if (!acceptsContextDrop(event, context)) {
                        setHoveredContext(null);
                        return;
                    }
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    setHoveredContext(token);
                } : undefined}
                onDragLeave={marker === '@' ? (event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHoveredContext(null);
                } : undefined}
                onDrop={marker === '@' ? (event) => { void handleContextDrop(event, context); } : undefined}
                aria-label={`${token} (${taskCount})`}
                aria-pressed={selectedContexts.includes(token)}
                className={cn(
                    "flex w-full items-center gap-2 rounded-lg p-2 text-left text-sm transition-colors",
                    selectedContexts.includes(token) || isHovered ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted/40 text-foreground",
                    isHovered && "ring-2 ring-primary"
                )}
            >
                <span className="w-4 text-center text-muted-foreground">{marker}</span>
                <span className="flex-1 truncate">{isHovered ? contextDropLabel('contexts.dropAdd', context) : token.replace(marker === '@' ? /^@/ : /^#/, '')}</span>
                <span className="text-xs text-muted-foreground">
                    {taskCount}
                </span>
            </button>
        );
    };

    const renderTokenSection = ({
        label,
        tokens,
        marker,
        icon: Icon,
        collapsed,
        onToggle,
    }: {
        label: string;
        tokens: string[];
        marker: '@' | '#';
        icon: LucideIcon;
        collapsed: boolean;
        onToggle: () => void;
    }) => {
        const ToggleIcon = collapsed ? ChevronRight : ChevronDown;
        return (
            <div className="mt-3 border-t border-border/60 pt-3">
                <button
                    type="button"
                    onClick={onToggle}
                    aria-expanded={!collapsed}
                    aria-label={`${label} (${tokens.length})`}
                    className="flex w-full items-center gap-2 px-1 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
                >
                    <ToggleIcon className="h-3.5 w-3.5" aria-hidden="true" />
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="flex-1 text-left">{label}</span>
                    <span>{tokens.length}</span>
                </button>
                {!collapsed && (
                    <div className="mt-1 space-y-1">
                        {tokens.map((token) => renderTokenRow(token, marker))}
                    </div>
                )}
            </div>
        );
    };

    const handleBulkTokenConfirm = async (values: string[]) => {
        if (!bulkTokenPicker || selectedIdsArray.length === 0) return;
        await updateSelectedTaskTokens(
            bulkTokenPicker.field,
            values,
            bulkTokenPicker.action,
            {
                afterNoop: () => setBulkTokenPicker(null),
                afterSuccess: () => setBulkTokenPicker(null),
            },
        );
    };

    const contextNavigation = (
        <div data-context-navigation-root className={sidebarSlot ? "flex flex-col gap-3" : "hidden min-w-[13.5rem] w-[clamp(13.5rem,16vw,15.5rem)] flex-shrink-0 flex-col gap-4 border-r border-border pr-5 lg:flex xl:pr-6"}>
                        <div className="flex items-center justify-between">
                            <h2 className={sidebarSlot ? "text-xs font-semibold uppercase tracking-wide text-muted-foreground" : "text-xl font-bold tracking-tight"}>{t('contexts.title')}</h2>
                            <Filter className="w-5 h-5 text-muted-foreground" />
                        </div>

                        <div className={sidebarSlot ? "space-y-1" : "space-y-1 overflow-y-auto flex-1"}>
                            <button
                                type="button"
                                onClick={() => setSelectedContext(null)}
                                aria-label={`${allTokensLabel} (${scopedTasks.filter((t) => hasContext(t)).length})`}
                                className={cn(
                                    "flex w-full items-center gap-2 rounded-lg p-2 text-left text-sm transition-colors",
                                    selectedContexts.length === 0 ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted/40 text-foreground"
                                )}
                            >
                                <Tag className="w-4 h-4" />
                                <span className="flex-1">{allTokensLabel}</span>
                                <span className="text-xs text-muted-foreground">
                                    {scopedTasks.filter((t) => hasContext(t)).length}
                                </span>
                            </button>

                            <button
                                type="button"
                                onClick={() => setSelectedContext(NO_CONTEXT_TOKEN)}
                                aria-label={`${t('contexts.none')} (${scopedTasks.filter((t) => !hasContext(t)).length})`}
                                className={cn(
                                    "flex w-full items-center gap-2 rounded-lg p-2 text-left text-sm transition-colors",
                                    noContextSelected ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted/40 text-foreground"
                                )}
                            >
                                <Tag className="w-4 h-4" />
                                <span className="flex-1">{t('contexts.none')}</span>
                                <span className="text-xs text-muted-foreground">
                                    {scopedTasks.filter((t) => !hasContext(t)).length}
                                </span>
                            </button>

                            {allTokens.length === 0 ? (
                                <div className="text-sm text-muted-foreground text-center py-8">
                                    {t('contexts.noContexts')}
                                </div>
                            ) : (
                                <>
                                    {renderTokenSection({
                                        label: contextsLabel,
                                        tokens: allContextTokens,
                                        marker: '@',
                                        icon: AtSign,
                                        collapsed: contextsCollapsed,
                                        onToggle: () => setContextsCollapsed((value) => !value),
                                    })}
                                    {renderTokenSection({
                                        label: tagsLabel,
                                        tokens: allTagTokens,
                                        marker: '#',
                                        icon: Hash,
                                        collapsed: tagsCollapsed,
                                        onToggle: () => setTagsCollapsed((value) => !value),
                                    })}
                                </>
                            )}
                            <div data-list-end className={LIST_END_GAP} aria-hidden="true" />
                        </div>
                    </div>
    );

    return (
        <>
            <div className={sidebarSlot ? "h-full px-5 pt-6 lg:px-8" : "h-full px-4 pt-3"}>
                <div className="mx-auto flex h-full w-full max-w-[84rem] min-w-0 gap-0 lg:gap-5 xl:gap-6 2xl:max-w-[88rem]">
                    {sidebarSlot ? createPortal(contextNavigation, sidebarSlot) : contextNavigation}

                    {/* Context Tasks */}
                    <div className="min-w-0 flex-1 flex flex-col h-full overflow-hidden">
                        <header className="mb-6 flex flex-wrap items-center gap-3">
                            <div className="p-2 bg-primary/10 rounded-lg">
                                <Tag className="w-6 h-6 text-primary" />
                            </div>
                            <div className="min-w-0 flex-1">
                                <h2 className="truncate text-2xl font-bold">
                                    {noContextSelected ? t('contexts.none') : (selectedContexts.length ? selectedContexts.join(matchMode === 'any' ? ' / ' : ' + ') : allTokensLabel)}
                                </h2>
                                <p className="text-muted-foreground text-sm">
                                    {filteredTasks.length} {t('common.tasks')}
                                </p>
                            </div>
                            <div className="order-3 w-full lg:hidden">
                                <label htmlFor="contexts-token-select" className="sr-only">{allTokensLabel}</label>
                                <select
                                    id="contexts-token-select"
                                    value={noContextSelected
                                        ? NO_CONTEXT_TOKEN
                                        : selectedContexts.length === 1 ? selectedContexts[0] : ''}
                                    onChange={(event) => {
                                        const value = event.target.value;
                                        if (value === CLEAR_SELECTION_OPTION) setSelectedContext(null);
                                        else if (value === NO_CONTEXT_TOKEN) setSelectedContext(NO_CONTEXT_TOKEN);
                                        else if (value) toggleSelectedContext(value);
                                        else setSelectedContext(null);
                                    }}
                                    className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                                >
                                    <option value="">{allTokensLabel}</option>
                                    {(selectedContexts.length > 0 || noContextSelected) && (
                                        <option value={CLEAR_SELECTION_OPTION}>{t('filters.clear')}</option>
                                    )}
                                    <option value={NO_CONTEXT_TOKEN}>{t('contexts.none')}</option>
                                    <optgroup label={contextsLabel}>
                                        {allContextTokens.map((token) => <option key={token} value={token}>{token}</option>)}
                                    </optgroup>
                                    <optgroup label={tagsLabel}>
                                        {allTagTokens.map((token) => <option key={token} value={token}>{token}</option>)}
                                    </optgroup>
                                </select>
                                {selectedContexts.length > 0 && !noContextSelected && (
                                    <div className="mt-2 flex flex-wrap gap-2" aria-label={allTokensLabel}>
                                        {selectedContexts.map((token) => (
                                            <button
                                                key={token}
                                                type="button"
                                                onClick={() => toggleSelectedContext(token)}
                                                aria-label={`${t('filters.remove')} ${token}`}
                                                className="rounded-full border border-primary/30 bg-primary/10 px-2 py-1 text-xs text-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
                                            >{token} ×</button>
                                        ))}
                                    </div>
                                )}
                            </div>
                            {selectedContexts.length > 1 && !noContextSelected && (
                                <div className="order-3 w-full lg:order-none lg:w-auto" role="group" aria-label={`${allTokensLabel} ${tFallback(t, 'filters.matchAny', 'Any')}/${tFallback(t, 'common.all', 'All')}`}>
                                    <div className="inline-flex rounded-lg border border-border bg-card p-0.5">
                                        {(['all', 'any'] as const).map((mode) => (
                                            <button
                                                key={mode}
                                                type="button"
                                                aria-pressed={matchMode === mode}
                                                onClick={() => setMatchMode(mode)}
                                                className={cn('rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40',
                                                    matchMode === mode ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-muted/40')}
                                            >{mode === 'all' ? tFallback(t, 'common.all', 'All') : tFallback(t, 'filters.matchAny', 'Any')}</button>
                                        ))}
                                    </div>
                                </div>
                            )}
                            <div className="order-4 w-full lg:order-none lg:ml-auto lg:w-auto">
                                <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
                                    <ToolbarButton
                                        active={selectionMode}
                                        data-task-selection-toggle
                                        onClick={toggleSelectionMode}
                                        aria-pressed={selectionMode}
                                        icon={<CheckSquare className="h-3.5 w-3.5" aria-hidden="true" />}
                                    >
                                        {selectionMode ? t('bulk.exitSelect') : t('bulk.select')}
                                    </ToolbarButton>
                                    <ViewControls
                                        sortBy={sortBy}
                                        defaultSortBy="default"
                                        onChangeSortBy={(value) => updateSettings({ taskSortBy: value })}
                                        groupBy={groupBy}
                                        defaultGroupBy={DEFAULT_CONTEXTS_VIEW_STATE.groupBy}
                                        groupByOptions={CONTEXTS_AXES}
                                        onChangeGroupBy={setGroupBy}
                                        t={t}
                                    />
                                    <ToolbarButton
                                        active={showListDetails}
                                        onClick={handleToggleDetails}
                                        title={showListDetails
                                            ? tFallback(t, 'list.hideDetails', 'Hide details')
                                            : tFallback(t, 'list.showDetails', 'Show details')}
                                        icon={<List className="h-3.5 w-3.5" aria-hidden="true" />}
                                    >
                                        {showListDetails
                                            ? tFallback(t, 'list.hideDetails', 'Hide details')
                                            : tFallback(t, 'list.showDetails', 'Show details')}
                                    </ToolbarButton>
                                </div>
                            </div>
                        </header>
                        <div className="mb-4 flex flex-wrap gap-2">
                            {statusOptions.map((option) => {
                                const isActive = option.value === 'all'
                                    ? statusFilters.length === 0
                                    : selectedStatusSet.has(option.value);
                                return (
                                    <button
                                        key={option.value}
                                        onClick={() => {
                                            if (option.value === 'all') {
                                                clearStatusFilters();
                                                return;
                                            }
                                            toggleStatusFilter(option.value);
                                        }}
                                        className={cn(
                                            'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                                            isActive
                                                ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                                                : 'border-border bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground'
                                        )}
                                        aria-pressed={isActive}
                                    >
                                        {option.label}
                                    </button>
                                );
                            })}
                        </div>
                        <div className="mb-4">
                            <input
                                type="text"
                                data-view-filter-input
                                placeholder={t('common.search')}
                                aria-label={t('common.search')}
                                value={searchQuery}
                                onChange={(event) => setSearchQuery(event.target.value)}
                                className={VIEW_FILTER_INPUT}
                            />
                        </div>

                        {selectionMode && (
                            <div className="mb-4">
                                <BulkSelectionToolbar
                                    selectionCount={selectedIdsArray.length}
                                    totalCount={filteredTasks.length}
                                    allSelected={allVisibleTasksSelected}
                                    onSelectAll={selectAllVisibleTasks}
                                    onClearSelection={clearTaskSelection}
                                    t={t}
                                />
                            </div>
                        )}

                        {selectionMode && selectedIdsArray.length > 0 && (
                            <div className="mb-4">
                                <ListBulkActions
                                    selectionCount={selectedIdsArray.length}
                                    onMoveToStatus={handleBatchMove}
                                    onMoveToDestination={handleBatchMoveToDestination}
                                    projects={projects}
                                    areas={areas}
                                    onAssignEnergyLevel={handleBatchAssignEnergyLevel}
                                    onAddTag={handleBatchPickTag}
                                    onRemoveTag={handleBatchRemoveTag}
                                    disableRemoveTag={removableTagOptions.length === 0}
                                    onAddContext={() => handleBatchPickContext('add')}
                                    onRemoveContext={handleBatchRemoveContext}
                                    disableRemoveContext={removableContextOptions.length === 0}
                                    onExportCsv={() => { void exportSelectedTasks(); }}
                                    isExporting={isExporting}
                                    onDelete={handleBatchDelete}
                                    isDeleting={activeAction === 'delete'}
                                    t={t}
                                />
                            </div>
                        )}

                        <div
                            ref={listScrollRef}
                            className="flex-1 min-h-0 overflow-y-auto pr-2"
                        >
                            <div data-list-end className={LIST_END_GAP}>
                            {sortedTasks.length > 0 ? (
                                <GroupedTaskList
                                    groups={groupedTasks}
                                    tasks={sortedTasks}
                                    virtualRows={groupedVirtualRows}
                                    virtualizer={shouldVirtualize ? rowVirtualizer : null}
                                    collapsedGroupIds={collapsedGroupIds}
                                    onToggleGroup={toggleGroup}
                                    getSectionDomId={getSectionDomId}
                                    renderTask={renderContextTask}
                                />
                            ) : (
                                <div className="px-1 py-8 text-left text-sm text-muted-foreground">
                                    {normalizedSearchQuery ? t('filters.noMatch') : t('contexts.noTasks')}
                                </div>
                            )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <TokenPickerModal
                isOpen={bulkTokenPicker !== null}
                title={tokenPickerTitle}
                description={tokenPickerTitle}
                tokens={tokenPickerOptions}
                placeholder={tokenPickerPlaceholder}
                allowCustomValue={bulkTokenPicker?.action === 'add'}
                multiSelect={bulkTokenPicker?.action === 'remove'}
                confirmLabel={t('common.save')}
                cancelLabel={t('common.cancel')}
                onCancel={() => setBulkTokenPicker(null)}
                onConfirm={handleBulkTokenConfirm}
            />
            {confirmModal}
        </>
    );
}
