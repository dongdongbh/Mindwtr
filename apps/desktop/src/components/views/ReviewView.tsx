import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorBoundary } from '../ErrorBoundary';
import { ReviewHeader, ReviewListControls } from './review/ReviewHeader';
import { ReviewFiltersBar } from './review/ReviewFiltersBar';
import { ReviewBulkActions } from './review/ReviewBulkActions';
import { ReviewTaskList } from './review/ReviewTaskList';
import { StoreTaskItem } from './list/StoreTaskItem';
import { LIST_END_GAP } from './list/list-toolbar';
import { useTaskListScope } from './list/task-list-scope';
import { BulkSelectionToolbar } from './list/BulkSelectionToolbar';
import { TaskBulkOrganizeModal } from './list/TaskBulkOrganizeModal';
import { DailyReviewGuideModal } from './review/DailyReviewModal';
import { WeeklyReviewGuideModal } from './review/WeeklyReviewModal';

import { collectBulkTaskTokens, flushPendingSave, getReviewOverviewGroups, getReviewOverviewTasks, isTaskDueForReview, shallow, sortTasksBy, useTaskStore, type BulkOrganizeTaskUpdateInput, type ReviewOverviewScope, type Task, type TaskStatus } from '@mindwtr/core';

import { PromptModal } from '../PromptModal';
import { TokenPickerModal } from '../TokenPickerModal';
import { useLanguage } from '../../contexts/language-context';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import { checkBudget } from '../../config/performanceBudgets';
import { isTaskVisibleInArea, isTaskVisibleInInbox } from '@mindwtr/core';
import { useAreaVisibility } from '../../hooks/useVisibleTaskContext';
import { useUiStore } from '../../store/ui-store';
import { usePersistedViewState } from '../../hooks/usePersistedViewState';
import { CONTEXTS_AXES, groupTasks, sanitizeAxis, type ContextsGroupBy, type TaskGroup } from './list/next-grouping';
import { GroupedTaskSections } from './list/GroupedTaskSections';
import { useTaskSelection } from './list/useTaskSelection';
import { resolveNonDoneTaskSortBy } from '@mindwtr/core';

const STATUS_OPTIONS: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'done'];
const REVIEW_VIEW_STATE_STORAGE_KEY = 'mindwtr:view:review:v1';

type ReviewPersistedViewState = {
    filterStatus: TaskStatus | 'all';
    groupBy: ContextsGroupBy;
};

const DEFAULT_REVIEW_VIEW_STATE: ReviewPersistedViewState = {
    filterStatus: 'all',
    groupBy: 'none',
};

function sanitizeReviewViewState(value: unknown, fallback: ReviewPersistedViewState): ReviewPersistedViewState {
    const parsed = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Partial<ReviewPersistedViewState>
        : {};
    const filterStatus = parsed.filterStatus === 'all' || STATUS_OPTIONS.includes(parsed.filterStatus as TaskStatus)
        ? parsed.filterStatus as TaskStatus | 'all'
        : fallback.filterStatus;
    const candidateGroupBy = sanitizeAxis(CONTEXTS_AXES, parsed.groupBy, fallback.groupBy);
    return {
        filterStatus,
        groupBy: filterStatus !== 'all' && candidateGroupBy === 'status' ? 'none' : candidateGroupBy,
    };
}

export function ReviewView() {
    const perf = usePerformanceMonitor('ReviewView');
    const { tasks, projects, sections, areas, settings, updateSettings, batchMoveTasks, batchDeleteTasks, batchUpdateTasks, restoreTask, highlightTaskId, highlightTaskAt } = useTaskStore(
        (state) => ({
            tasks: state.tasks,
            projects: state.projects,
            sections: state.sections,
            areas: state.areas,
            settings: state.settings,
            updateSettings: state.updateSettings,
            batchMoveTasks: state.batchMoveTasks,
            batchDeleteTasks: state.batchDeleteTasks,
            batchUpdateTasks: state.batchUpdateTasks,
            restoreTask: state.restoreTask,
            highlightTaskId: state.highlightTaskId,
            highlightTaskAt: state.highlightTaskAt,
        }),
        shallow
    );
    const { t } = useLanguage();
    const [persistedViewState, setPersistedViewState] = usePersistedViewState(
        REVIEW_VIEW_STATE_STORAGE_KEY,
        DEFAULT_REVIEW_VIEW_STATE,
        sanitizeReviewViewState
    );
    const filterStatus = persistedViewState.filterStatus;
    const setFilterStatus = useCallback((value: TaskStatus | 'all') => {
        setPersistedViewState((current) => ({
            ...current,
            filterStatus: value,
            groupBy: value !== 'all' && current.groupBy === 'status' ? 'none' : current.groupBy,
        }));
    }, [setPersistedViewState]);
    const groupBy = persistedViewState.groupBy;
    const setGroupBy = useCallback((value: ContextsGroupBy) => {
        setPersistedViewState((current) => ({
            ...current,
            groupBy: value,
        }));
    }, [setPersistedViewState]);
    const [searchQuery, setSearchQuery] = useState('');
    const [showLaterInSequence, setShowLaterInSequence] = useState(false);
    const [scope, setScope] = useState<ReviewOverviewScope>('due');
    const [nowTick, setNowTick] = useState(() => Date.now());
    const [reviewSavePending, setReviewSavePending] = useState(false);
    const [reviewWriteBusy, setReviewWriteBusy] = useState(false);
    const [tagPromptOpen, setTagPromptOpen] = useState(false);
    const [removeTagPickerOpen, setRemoveTagPickerOpen] = useState(false);
    const [showGuide, setShowGuide] = useState(false);
    const [showDailyGuide, setShowDailyGuide] = useState(false);
    const [moveToStatus, setMoveToStatus] = useState<TaskStatus | ''>('');
    const [bulkOrganizeOpen, setBulkOrganizeOpen] = useState(false);
    const showListDetails = useUiStore((state) => state.listOptions.showDetails);
    const showToast = useUiStore((state) => state.showToast);
    const setListOptions = useUiStore((state) => state.setListOptions);
    const collapseAllTaskDetails = useUiStore((state) => state.collapseAllTaskDetails);

    const sortBy = resolveNonDoneTaskSortBy(settings?.taskSortBy, settings);
    const normalizedSearchQuery = searchQuery.trim().toLowerCase();
    const statusOptions = STATUS_OPTIONS;
    const visibility = useAreaVisibility();
    const projectMapById = visibility.projectById;

    useEffect(() => {
        const refresh = () => setNowTick(Date.now());
        const interval = window.setInterval(refresh, 60_000);
        window.addEventListener('focus', refresh);
        return () => { window.clearInterval(interval); window.removeEventListener('focus', refresh); };
    }, []);

    useEffect(() => {
        if (!perf.enabled) return;
        const timer = window.setTimeout(() => {
            checkBudget('ReviewView', perf.metrics, 'complex');
        }, 0);
        return () => window.clearTimeout(timer);
    }, [perf.enabled]);

    const { tasksById, statusCounts, filteredTasks } = useMemo(() => {
        perf.trackUseMemo();
        return perf.measure('reviewData', () => {
            const nextTasksById: Record<string, Task> = {};
            const nextStatusCounts: Record<string, number> = { all: 0 };
            statusOptions.forEach((status) => {
                nextStatusCounts[status] = 0;
            });

            const nextVisibleTasks: Task[] = [];
            tasks.forEach((task) => {
                nextTasksById[task.id] = task;
                if (task.status === 'reference') return;
                if (task.status === 'inbox') {
                    if (!isTaskVisibleInInbox(task, visibility)) return;
                } else if (!isTaskVisibleInArea(task, visibility)) return;
                nextVisibleTasks.push(task);
                if (nextStatusCounts[task.status] !== undefined) {
                    nextStatusCounts[task.status] += 1;
                }
            });
            const nextOpenTasks = getReviewOverviewTasks(nextVisibleTasks, 'all', new Date(nowTick));
            nextStatusCounts.all = nextOpenTasks.length;

            const list = scope === 'due'
                ? getReviewOverviewTasks(nextOpenTasks, 'due', new Date(nowTick))
                : filterStatus === 'all'
                    ? nextOpenTasks
                    : nextVisibleTasks.filter((task) => task.status === filterStatus);
            const sortedTasks = sortTasksBy(list, sortBy);
            const searchFilteredTasks = normalizedSearchQuery
                ? sortedTasks.filter((task) => task.title.toLowerCase().includes(normalizedSearchQuery))
                : sortedTasks;

            return {
                tasksById: nextTasksById,
                statusCounts: nextStatusCounts,
                filteredTasks: searchFilteredTasks,
            };
        });
    }, [filterStatus, normalizedSearchQuery, nowTick, scope, sortBy, tasks, visibility]);
    const revealedHighlightRef = useRef<{ id: string; at: number | null } | null>(null);
    useEffect(() => {
        if (!highlightTaskId) {
            revealedHighlightRef.current = null;
            return;
        }
        const previous = revealedHighlightRef.current;
        if (previous?.id === highlightTaskId && previous.at === highlightTaskAt) return;
        const target = tasksById[highlightTaskId];
        if (!target) return;

        revealedHighlightRef.current = { id: highlightTaskId, at: highlightTaskAt };
        if (getReviewOverviewTasks([target], 'all').length === 0) return;
        const revealInAll = scope === 'all' || !isTaskDueForReview(target, new Date(nowTick));
        if (revealInAll) {
            setScope('all');
            if (filterStatus !== 'all' && filterStatus !== target.status) setFilterStatus('all');
        }
        if (normalizedSearchQuery && !target.title.toLowerCase().includes(normalizedSearchQuery)) setSearchQuery('');
    }, [filterStatus, highlightTaskAt, highlightTaskId, normalizedSearchQuery, nowTick, scope, setFilterStatus, tasksById]);
    const sequenceLaterTasks = useMemo(() => getReviewOverviewGroups({
        tasks,
        projects,
        sections,
        orderedAreas: areas,
        areaFilter: { included: [], excluded: [] },
        sortBy,
        scope,
        now: new Date(nowTick),
    }).flatMap((area) => area.projectGroups.flatMap((project) => project.laterTasks)), [areas, nowTick, projects, scope, sections, sortBy, tasks]);
    const laterTaskIds = useMemo(() => new Set(sequenceLaterTasks.map((task) => task.id)), [sequenceLaterTasks]);
    const currentReviewTasks = useMemo(() => filteredTasks.filter((task) => !laterTaskIds.has(task.id)), [filteredTasks, laterTaskIds]);
    const laterReviewTasks = useMemo(() => {
        const visibleIds = new Set(filteredTasks.map((task) => task.id));
        return sequenceLaterTasks.filter((task) => visibleIds.has(task.id));
    }, [filteredTasks, sequenceLaterTasks]);
    const renderedReviewTasks = useMemo(() => showLaterInSequence ? [...currentReviewTasks, ...laterReviewTasks] : currentReviewTasks, [currentReviewTasks, laterReviewTasks, showLaterInSequence]);
    useEffect(() => {
        if (highlightTaskId && laterTaskIds.has(highlightTaskId)) setShowLaterInSequence(true);
    }, [highlightTaskAt, highlightTaskId, laterTaskIds]);
    const filteredTaskIds = useMemo(() => renderedReviewTasks.map((task) => task.id), [renderedReviewTasks]);
    const {
        activeAction,
        allVisibleTasksSelected,
        clearTaskSelection,
        deleteSelectedTasks,
        exitSelectionMode,
        exportSelectedTasks,
        isExporting,
        multiSelectedIds,
        moveSelectedTasks,
        organizeSelectedTasks,
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
        undoNotificationsEnabled: settings?.undoNotificationsEnabled !== false,
    });
    const groupedTasks = useMemo<TaskGroup[]>(
        () => groupTasks(groupBy, { tasks: currentReviewTasks, areas, projectMap: projectMapById, t, theme: settings?.theme }),
        [areas, currentReviewTasks, groupBy, projectMapById, settings?.theme, t],
    );
    const laterGroupedTasks = useMemo<TaskGroup[]>(
        () => groupTasks(groupBy, { tasks: laterReviewTasks, areas, projectMap: projectMapById, t, theme: settings?.theme }),
        [areas, groupBy, laterReviewTasks, projectMapById, settings?.theme, t],
    );
    const isGrouping = groupBy !== 'none' && filteredTasks.length > 0;
    useEffect(() => {
        if (!isGrouping || !highlightTaskId || !filteredTaskIds.includes(highlightTaskId)) return;
        document.querySelector<HTMLElement>(`[data-task-id="${highlightTaskId}"]`)?.scrollIntoView?.({ block: 'start' });
    }, [filteredTaskIds, highlightTaskAt, highlightTaskId, isGrouping]);

    const bulkStatuses: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'reference', 'done'];

    useEffect(() => {
        exitSelectionMode();
    }, [filterStatus, exitSelectionMode]);


    const keyboardVisibleTasks = useMemo(
        () => (isGrouping ? [...groupedTasks, ...(showLaterInSequence ? laterGroupedTasks : [])].flatMap((group) => group.tasks) : renderedReviewTasks),
        [groupedTasks, isGrouping, laterGroupedTasks, renderedReviewTasks, showLaterInSequence],
    );
    const [selectedTaskIndex, setSelectedTaskIndex] = useState(0);
    useTaskListScope({
        getTasks: () => keyboardVisibleTasks,
        getSelectedIds: () => multiSelectedIds,
        getSelectedIndex: () => selectedTaskIndex,
        setSelectedIndex: setSelectedTaskIndex,
        t,
        toggleSelect: (task) => toggleMultiSelect(task.id),
    });

    const handleBatchMove = useCallback(async (newStatus: TaskStatus) => {
        await moveSelectedTasks(newStatus, { afterSuccess: () => setMoveToStatus('') });
    }, [moveSelectedTasks]);

    const handleBatchDelete = deleteSelectedTasks;

    const handleMarkReviewed = useCallback(async () => {
        if (reviewWriteBusy || reviewSavePending || scope !== 'due' || selectedIdsArray.length === 0) return;
        const dueIds = selectedIdsArray.filter((id) => tasksById[id] && isTaskDueForReview(tasksById[id]));
        if (dueIds.length === 0) return;
        setReviewWriteBusy(true);
        try {
            const result = await batchUpdateTasks(dueIds.map((id) => ({ id, updates: { reviewAt: undefined } })));
            if (!result.success) throw new Error(result.error || 'Review update failed');
            setReviewSavePending(true);
            await flushPendingSave();
            setReviewSavePending(false);
            exitSelectionMode();
            showToast(t('review.markReviewedDone'), 'success');
        } catch {
            showToast(t('bulk.updateFailed'), 'error');
        } finally {
            setReviewWriteBusy(false);
        }
    }, [batchUpdateTasks, exitSelectionMode, reviewSavePending, reviewWriteBusy, scope, selectedIdsArray, showToast, t, tasksById]);

    const retryReviewSave = useCallback(async () => {
        setReviewWriteBusy(true);
        try {
            if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            else await flushPendingSave();
            setReviewSavePending(false);
            exitSelectionMode();
            showToast(t('persistence.saved'), 'success');
        } catch {
            showToast(t('bulk.updateFailed'), 'error');
        } finally {
            setReviewWriteBusy(false);
        }
    }, [exitSelectionMode, showToast, t]);

    const handleApplyTaskBulkOrganize = useCallback(async (input: BulkOrganizeTaskUpdateInput) => {
        await organizeSelectedTasks(input, {
            afterSuccess: () => setBulkOrganizeOpen(false),
        });
    }, [organizeSelectedTasks]);

    const handleBatchAddTag = useCallback(() => {
        if (selectedIdsArray.length === 0) return;
        setTagPromptOpen(true);
    }, [selectedIdsArray]);

    const removableTagOptions = useMemo(
        () => collectBulkTaskTokens(selectedIdsArray, tasksById, 'tags'),
        [selectedIdsArray, tasksById],
    );

    const handleBatchRemoveTag = useCallback(() => {
        if (selectedIdsArray.length === 0) return;
        setRemoveTagPickerOpen(true);
    }, [selectedIdsArray]);

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
            <div className={`space-y-5 ${LIST_END_GAP}`} data-list-end>
                <ReviewHeader
                    title={t('review.title')}
                    taskCountLabel={`${filteredTasks.length} ${t('common.tasks')}`}
                    onShowDailyGuide={() => setShowDailyGuide(true)}
                    onShowGuide={() => setShowGuide(true)}
                    labels={{
                        dailyReview: t('dailyReview.title'),
                        weeklyReview: t('review.openGuide'),
                    }}
                />
                <div className="flex flex-wrap items-center gap-3">
                    <div className="inline-flex rounded-lg border border-border p-1" role="group" aria-label={t('review.title')}>
                        {(['due', 'all'] as const).map((choice) => (
                            <button
                                key={choice}
                                type="button"
                                aria-pressed={scope === choice}
                                onClick={() => { if (choice !== scope) { exitSelectionMode(); setFilterStatus('all'); setScope(choice); } }}
                                className={`rounded-md px-3 py-1.5 text-sm ${scope === choice ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
                            >
                                {t(choice === 'due' ? 'review.scopeDue' : 'review.scopeAll')}
                            </button>
                        ))}
                    </div>
                    <span className="text-sm text-muted-foreground">{t(scope === 'due' ? 'review.dueHelp' : 'review.overviewHelp')}</span>
                    {scope === 'all' && <button type="button" aria-label={`${t('nav.done')} ${t('common.tasks')}`} onClick={() => setFilterStatus('done')} className="text-sm text-primary hover:underline">{t('nav.done')}</button>}
                </div>
                {reviewSavePending && (
                    <button type="button" onClick={() => { void retryReviewSave(); }} disabled={reviewWriteBusy} className="rounded border border-destructive px-3 py-2 text-sm text-destructive disabled:opacity-50">
                        {t('common.retry')}
                    </button>
                )}
                <div className="review-toolbar relative z-10 flex flex-col gap-2 lg:flex-row lg:items-center">
                    <input
                        type="text"
                        data-view-filter-input
                        placeholder={t('common.search')}
                        aria-label={t('common.search')}
                        value={searchQuery}
                        onChange={(event) => setSearchQuery(event.target.value)}


                        className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 lg:min-w-48"
                    />
                    <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                        {scope === 'all' && <ReviewFiltersBar
                            filterStatus={filterStatus}
                            statusOptions={statusOptions}
                            statusCounts={statusCounts}
                            onSelect={setFilterStatus}
                            t={t}
                        />}
                        <ReviewListControls
                            selectionMode={selectionMode}
                            onToggleSelection={toggleSelectionMode}
                            sortBy={sortBy}
                            onChangeSortBy={(value) => updateSettings({ taskSortBy: value })}
                            groupBy={groupBy}
                            onChangeGroupBy={setGroupBy}
                            showListDetails={showListDetails}
                            onToggleDetails={handleToggleDetails}
                            disableStatusGrouping={filterStatus !== 'all'}
                            t={t}
                            labels={{
                                select: t('bulk.select'),
                                exitSelect: t('bulk.exitSelect'),
                            }}
                        />
                    </div>
                </div>

                {selectionMode && (
                    <div className="space-y-3">
                        <BulkSelectionToolbar
                            selectionCount={selectedIdsArray.length}
                            totalCount={renderedReviewTasks.length}
                            allSelected={allVisibleTasksSelected}
                            onSelectAll={selectAllVisibleTasks}
                            onClearSelection={clearTaskSelection}
                            t={t}
                        />
                        <ReviewBulkActions
                            selectionCount={selectedIdsArray.length}
                            moveToStatus={moveToStatus}
                            onMoveToStatus={handleBatchMove}
                            onChangeMoveToStatus={setMoveToStatus}
                            onBulkOrganize={() => setBulkOrganizeOpen(true)}
                            onAddTag={handleBatchAddTag}
                            onRemoveTag={handleBatchRemoveTag}
                            disableRemoveTag={removableTagOptions.length === 0}
                            onExportCsv={() => { void exportSelectedTasks(); }}
                            isExporting={isExporting}
                            onDelete={handleBatchDelete}
                            onMarkReviewed={scope === 'due' ? handleMarkReviewed : undefined}
                            markReviewedBusy={reviewWriteBusy || reviewSavePending}
                            statusOptions={bulkStatuses}
                            t={t}
                        />
                    </div>
                )}

                {isGrouping ? (
                    <GroupedTaskSections
                        groups={groupedTasks}
                        renderTask={(task) => (
                            <StoreTaskItem
                                key={task.id}
                                taskId={task.id}
                                compactMetaEnabled={showListDetails}
                                showProjectBadgeInActions={false}
                                selectionMode={selectionMode}
                                isMultiSelected={multiSelectedIds.has(task.id)}
                                onToggleSelectId={toggleMultiSelect}
                            />
                        )}
                    />
                ) : currentReviewTasks.length > 0 || laterReviewTasks.length === 0 ? (
                    <ReviewTaskList
                        tasks={currentReviewTasks}
                        showListDetails={showListDetails}
                        selectionMode={selectionMode}
                        multiSelectedIds={multiSelectedIds}
                        highlightTaskId={highlightTaskId}
                        highlightTaskAt={highlightTaskAt}
                        onToggleSelect={toggleMultiSelect}
                        emptyMessage={normalizedSearchQuery ? t('filters.noMatch') : t(scope === 'due' ? 'review.dueEmpty' : 'review.overviewEmpty')}
                        t={t}
                    />
                ) : null}

                {laterReviewTasks.length > 0 && (
                    <div>
                        <button
                            type="button"
                            aria-expanded={showLaterInSequence}
                            onClick={() => setShowLaterInSequence((expanded) => !expanded)}
                            className="flex items-center gap-2 py-2 text-sm text-muted-foreground hover:text-foreground"
                        >
                            <span aria-hidden="true">{showLaterInSequence ? '▾' : '▸'}</span>
                            {t('projects.laterInSequence')} ({laterReviewTasks.length})
                        </button>
                        {showLaterInSequence && (isGrouping ? (
                            <GroupedTaskSections
                                groups={laterGroupedTasks}
                                renderTask={(task) => (
                                    <StoreTaskItem
                                        key={task.id}
                                        taskId={task.id}
                                        compactMetaEnabled={showListDetails}
                                        showProjectBadgeInActions={false}
                                        selectionMode={selectionMode}
                                        isMultiSelected={multiSelectedIds.has(task.id)}
                                        onToggleSelectId={toggleMultiSelect}
                                    />
                                )}
                            />
                        ) : (
                            <ReviewTaskList
                                tasks={laterReviewTasks}
                                showListDetails={showListDetails}
                                selectionMode={selectionMode}
                                multiSelectedIds={multiSelectedIds}
                                highlightTaskId={highlightTaskId}
                                highlightTaskAt={highlightTaskAt}
                                onToggleSelect={toggleMultiSelect}
                                t={t}
                            />
                        ))}
                    </div>
                )}

                {showGuide && (
                    <WeeklyReviewGuideModal onClose={() => setShowGuide(false)} />
                )}

                {showDailyGuide && (
                    <DailyReviewGuideModal onClose={() => setShowDailyGuide(false)} />
                )}

                <TaskBulkOrganizeModal
                    isOpen={bulkOrganizeOpen}
                    selectedCount={selectedIdsArray.length}
                    projects={projects}
                    areas={areas}
                    isApplying={activeAction === 'organize'}
                    t={t}
                    onCancel={() => setBulkOrganizeOpen(false)}
                    onApply={handleApplyTaskBulkOrganize}
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
                    onConfirm={async (value) => {
                        const input = value.trim();
                        if (!input) return;
                        const tag = input.startsWith('#') ? input : `#${input}`;
                        await updateSelectedTaskTokens('tags', tag, 'add', {
                            afterNoop: () => setTagPromptOpen(false),
                            afterSuccess: () => setTagPromptOpen(false),
                        });
                    }}
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
                    onConfirm={async (values) => {
                        if (values.length === 0) return;
                        await updateSelectedTaskTokens('tags', values, 'remove', {
                            afterNoop: () => setRemoveTagPickerOpen(false),
                            afterSuccess: () => setRemoveTagPickerOpen(false),
                        });
                    }}
                />
            </div>
        </ErrorBoundary>
    );
}
