import { useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorBoundary } from '../ErrorBoundary';
import { ReviewHeader } from './review/ReviewHeader';
import { ReviewFiltersBar } from './review/ReviewFiltersBar';
import { ReviewBulkActions } from './review/ReviewBulkActions';
import { ReviewTaskList } from './review/ReviewTaskList';
import { DailyReviewGuideModal } from './review/DailyReviewModal';
import { WeeklyReviewGuideModal } from './review/WeeklyReviewModal';

import { shallow, sortTasksBy, useTaskStore, type Project, type Task, type TaskStatus, type TaskSortBy, isTaskInActiveProject } from '@mindwtr/core';

import { PromptModal } from '../PromptModal';
import { useLanguage } from '../../contexts/language-context';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import { checkBudget } from '../../config/performanceBudgets';
import { resolveAreaFilter, taskMatchesAreaFilter } from '../../lib/area-filter';
import { useUiStore } from '../../store/ui-store';

const STATUS_OPTIONS: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'done'];

export function ReviewView() {
    const perf = usePerformanceMonitor('ReviewView');
    const { tasks, projects, areas, settings, updateSettings, batchMoveTasks, batchDeleteTasks, batchUpdateTasks, highlightTaskId } = useTaskStore(
        (state) => ({
            tasks: state.tasks,
            projects: state.projects,
            areas: state.areas,
            settings: state.settings,
            updateSettings: state.updateSettings,
            batchMoveTasks: state.batchMoveTasks,
            batchDeleteTasks: state.batchDeleteTasks,
            batchUpdateTasks: state.batchUpdateTasks,
            highlightTaskId: state.highlightTaskId,
        }),
        shallow
    );
    const { t } = useLanguage();
    const [filterStatus, setFilterStatus] = useState<TaskStatus | 'all'>('all');
    const [searchQuery, setSearchQuery] = useState('');
    const [selectionMode, setSelectionMode] = useState(false);
    const [multiSelectedIds, setMultiSelectedIds] = useState<Set<string>>(new Set());
    const [tagPromptOpen, setTagPromptOpen] = useState(false);
    const [tagPromptIds, setTagPromptIds] = useState<string[]>([]);
    const [showGuide, setShowGuide] = useState(false);
    const [showDailyGuide, setShowDailyGuide] = useState(false);
    const [moveToStatus, setMoveToStatus] = useState<TaskStatus | ''>('');
    const showListDetails = useUiStore((state) => state.listOptions.showDetails);
    const setListOptions = useUiStore((state) => state.setListOptions);
    const collapseAllTaskDetails = useUiStore((state) => state.collapseAllTaskDetails);

    const sortBy = (settings?.taskSortBy ?? 'default') as TaskSortBy;
    const normalizedSearchQuery = searchQuery.trim().toLowerCase();
    const statusOptions = STATUS_OPTIONS;
    const projectMapById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
    const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
    const resolvedAreaFilter = useMemo(
        () => resolveAreaFilter(settings?.filters?.areaId, areas),
        [settings?.filters?.areaId, areas],
    );

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
            const nextProjectMap: Record<string, Project> = {};
            const nextTasksById: Record<string, Task> = {};
            const nextStatusCounts: Record<string, number> = { all: 0 };
            statusOptions.forEach((status) => {
                nextStatusCounts[status] = 0;
            });

            projects.forEach((project) => {
                nextProjectMap[project.id] = project;
            });

            const nextVisibleTasks: Task[] = [];
            const nextOpenTasks: Task[] = [];
            tasks.forEach((task) => {
                nextTasksById[task.id] = task;
                if (task.deletedAt) return;
                if (task.status === 'reference') return;
                if (!isTaskInActiveProject(task, nextProjectMap)) return;
                if (!taskMatchesAreaFilter(task, resolvedAreaFilter, projectMapById, areaById)) return;
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
    }, [filterStatus, normalizedSearchQuery, projects, sortBy, tasks, resolvedAreaFilter, projectMapById, areaById]);

    const selectedIdsArray = useMemo(() => Array.from(multiSelectedIds), [multiSelectedIds]);

    const bulkStatuses: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'reference', 'done'];

    const exitSelectionMode = useCallback(() => {
        setSelectionMode(false);
        setMultiSelectedIds(new Set());
    }, []);

    useEffect(() => {
        exitSelectionMode();
    }, [filterStatus, exitSelectionMode]);

    const toggleMultiSelect = useCallback((taskId: string) => {
        if (!selectionMode) setSelectionMode(true);
        setMultiSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(taskId)) next.delete(taskId);
            else next.add(taskId);
            return next;
        });
    }, [selectionMode]);

    const handleBatchMove = useCallback(async (newStatus: TaskStatus) => {
        if (selectedIdsArray.length === 0) return;
        await batchMoveTasks(selectedIdsArray, newStatus);
        setMoveToStatus('');
        exitSelectionMode();
    }, [batchMoveTasks, selectedIdsArray, exitSelectionMode]);

    const handleBatchDelete = useCallback(async () => {
        if (selectedIdsArray.length === 0) return;
        await batchDeleteTasks(selectedIdsArray);
        exitSelectionMode();
    }, [batchDeleteTasks, selectedIdsArray, exitSelectionMode]);

    const handleBatchAddTag = useCallback(async () => {
        if (selectedIdsArray.length === 0) return;
        setTagPromptIds(selectedIdsArray);
        setTagPromptOpen(true);
    }, [batchUpdateTasks, selectedIdsArray, tasksById, t, exitSelectionMode]);

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
            <div className="space-y-6">
                <ReviewHeader
                    title={t('review.title')}
                    taskCountLabel={`${filteredTasks.length} ${t('common.tasks')}`}
                    selectionMode={selectionMode}
                    onToggleSelection={() => {
                        if (selectionMode) exitSelectionMode();
                        else setSelectionMode(true);
                    }}
                    sortBy={sortBy}
                    onChangeSortBy={(value) => updateSettings({ taskSortBy: value })}
                    showListDetails={showListDetails}
                    onToggleDetails={handleToggleDetails}
                    onShowDailyGuide={() => setShowDailyGuide(true)}
                    onShowGuide={() => setShowGuide(true)}
                    t={t}
                    labels={{
                        select: t('bulk.select'),
                        exitSelect: t('bulk.exitSelect'),
                        dailyReview: t('dailyReview.title'),
                        weeklyReview: t('review.openGuide'),
                    }}
                />

                <ReviewFiltersBar
                    filterStatus={filterStatus}
                    statusOptions={statusOptions}
                    statusCounts={statusCounts}
                    onSelect={setFilterStatus}
                    t={t}
                />
                <input
                    type="text"
                    data-view-filter-input
                    placeholder={t('common.search')}
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    className="w-full text-sm px-3 py-2 rounded border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
                />

                {selectionMode && (
                    <ReviewBulkActions
                        selectionCount={selectedIdsArray.length}
                        moveToStatus={moveToStatus}
                        onMoveToStatus={handleBatchMove}
                        onChangeMoveToStatus={setMoveToStatus}
                        onAddTag={handleBatchAddTag}
                        onDelete={handleBatchDelete}
                        statusOptions={bulkStatuses}
                        t={t}
                    />
                )}

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

                {showGuide && (
                    <WeeklyReviewGuideModal onClose={() => setShowGuide(false)} />
                )}

                {showDailyGuide && (
                    <DailyReviewGuideModal onClose={() => setShowDailyGuide(false)} />
                )}

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
                        await batchUpdateTasks(tagPromptIds.map((id) => {
                            const task = tasksById[id];
                            const existingTags = task?.tags || [];
                            const nextTags = Array.from(new Set([...existingTags, tag]));
                            return { id, updates: { tags: nextTags } };
                        }));
                        setTagPromptOpen(false);
                        exitSelectionMode();
                    }}
                />
            </div>
        </ErrorBoundary>
    );
}
