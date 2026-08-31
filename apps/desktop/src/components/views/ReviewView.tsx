import { useCallback, useEffect, useMemo, useState } from 'react';
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

import { collectBulkTaskTokens, shallow, sortTasksBy, useTaskStore, type BulkOrganizeTaskUpdateInput, type Task, type TaskStatus } from '@mindwtr/core';

import { PromptModal } from '../PromptModal';
import { TokenPickerModal } from '../TokenPickerModal';
import { useLanguage } from '../../contexts/language-context';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import { checkBudget } from '../../config/performanceBudgets';
import { isTaskVisibleInArea } from '@mindwtr/core';
import { useAreaVisibility } from '../../hooks/useVisibleTaskContext';
import { useUiStore } from '../../store/ui-store';
import { usePersistedViewState } from '../../hooks/usePersistedViewState';
import { CONTEXTS_AXES, groupTasks, sanitizeAxis, type ContextsGroupBy, type TaskGroup } from './list/next-grouping';
import { GroupedTaskSections } from './list/GroupedTaskSections';
import { useTaskSelection } from './list/useTaskSelection';
import { resolveNonDoneTaskSortBy } from '../../lib/task-list-sort';

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
    const { tasks, projects, areas, settings, updateSettings, batchMoveTasks, batchDeleteTasks, batchUpdateTasks, restoreTask, highlightTaskId } = useTaskStore(
        (state) => ({
            tasks: state.tasks,
            projects: state.projects,
            areas: state.areas,
            settings: state.settings,
            updateSettings: state.updateSettings,
            batchMoveTasks: state.batchMoveTasks,
            batchDeleteTasks: state.batchDeleteTasks,
            batchUpdateTasks: state.batchUpdateTasks,
            restoreTask: state.restoreTask,
            highlightTaskId: state.highlightTaskId,
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
            const nextOpenTasks: Task[] = [];
            tasks.forEach((task) => {
                nextTasksById[task.id] = task;
                if (task.status === 'reference') return;
                if (!isTaskVisibleInArea(task, visibility)) return;
                nextVisibleTasks.push(task);
                if (task.status !== 'done') {
                    nextOpenTasks.push(task);
                    nextStatusCounts.all += 1;
                }
                if (nextStatusCounts[task.status] !== undefined) {
                    nextStatusCounts[task.status] += 1;
                }
            });

            const list = filterStatus === 'all'
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
    }, [filterStatus, normalizedSearchQuery, sortBy, tasks, visibility]);

    const filteredTaskIds = useMemo(() => filteredTasks.map((task) => task.id), [filteredTasks]);
    const {
        activeAction,
        allVisibleTasksSelected,
        clearTaskSelection,
        deleteSelectedTasks,
        exitSelectionMode,
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
        () => groupTasks(groupBy, { tasks: filteredTasks, areas, projectMap: projectMapById, t, theme: settings?.theme }),
        [areas, filteredTasks, groupBy, projectMapById, settings?.theme, t],
    );
    const isGrouping = groupBy !== 'none' && filteredTasks.length > 0;

    const bulkStatuses: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'reference', 'done'];

    useEffect(() => {
        exitSelectionMode();
    }, [filterStatus, exitSelectionMode]);

    // Grouping reorders the rows, so the keyboard walks the grouped order.
    const keyboardVisibleTasks = useMemo(
        () => (isGrouping ? groupedTasks.flatMap((group) => group.tasks) : filteredTasks),
        [filteredTasks, groupedTasks, isGrouping],
    );
    const [selectedTaskIndex, setSelectedTaskIndex] = useState(0);
    useTaskListScope({
        getTasks: () => keyboardVisibleTasks,
        getSelectedIndex: () => selectedTaskIndex,
        setSelectedIndex: setSelectedTaskIndex,
        t,
        toggleSelect: (task) => toggleMultiSelect(task.id),
    });

    const handleBatchMove = useCallback(async (newStatus: TaskStatus) => {
        await moveSelectedTasks(newStatus, { afterSuccess: () => setMoveToStatus('') });
    }, [moveSelectedTasks]);

    const handleBatchDelete = deleteSelectedTasks;

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
                <div className="review-toolbar relative z-10 flex flex-wrap items-center gap-2">
                    <input
                        type="text"
                        data-view-filter-input
                        placeholder={t('common.search')}
                        aria-label={t('common.search')}
                        value={searchQuery}
                        onChange={(event) => setSearchQuery(event.target.value)}
                        className="h-9 min-w-[220px] flex-1 rounded-lg border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                    <ReviewFiltersBar
                        filterStatus={filterStatus}
                        statusOptions={statusOptions}
                        statusCounts={statusCounts}
                        onSelect={setFilterStatus}
                        t={t}
                    />
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
                        <ReviewBulkActions
                            selectionCount={selectedIdsArray.length}
                            moveToStatus={moveToStatus}
                            onMoveToStatus={handleBatchMove}
                            onChangeMoveToStatus={setMoveToStatus}
                            onBulkOrganize={() => setBulkOrganizeOpen(true)}
                            onAddTag={handleBatchAddTag}
                            onRemoveTag={handleBatchRemoveTag}
                            disableRemoveTag={removableTagOptions.length === 0}
                            onDelete={handleBatchDelete}
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
                ) : (
                    <ReviewTaskList
                        tasks={filteredTasks}
                        showListDetails={showListDetails}
                        selectionMode={selectionMode}
                        multiSelectedIds={multiSelectedIds}
                        highlightTaskId={highlightTaskId}
                        onToggleSelect={toggleMultiSelect}
                        emptyMessage={normalizedSearchQuery ? t('filters.noMatch') : t('review.noTasks')}
                        t={t}
                    />
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
