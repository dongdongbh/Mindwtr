import { useMemo, useCallback, useEffect, useState, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ErrorBoundary } from '../ErrorBoundary';
import { collectBulkTaskTokens, shallow, useTaskStore, filterTasksBySearch, sortTasksBy, tFallback } from '@mindwtr/core';
import type { BulkOrganizeTaskUpdateInput } from '@mindwtr/core';
import { useLanguage } from '../../contexts/language-context';
import { Trash2 } from 'lucide-react';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import { checkBudget } from '../../config/performanceBudgets';
import { ListBulkActions } from './list/ListBulkActions';
import { BulkSelectionToolbar } from './list/BulkSelectionToolbar';
import { TaskBulkOrganizeModal } from './list/TaskBulkOrganizeModal';
import { PromptModal } from '../PromptModal';
import { TokenPickerModal } from '../TokenPickerModal';
import { cn } from '../../lib/utils';
import { resolveAreaFilterSelection, taskMatchesAreaFilterSelection } from '@mindwtr/core';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';
import {
    LIST_VIRTUALIZATION_THRESHOLD,
    LIST_VIRTUAL_OVERSCAN_ROWS,
    LIST_VIRTUAL_ROW_ESTIMATE,
} from './list/virtual-list';
import { StoreTaskItem } from './list/StoreTaskItem';
import { useTaskListScope } from './list/task-list-scope';
import { LIST_END_GAP } from './list/list-toolbar';
import { useTaskSelection } from './list/useTaskSelection';
import { useUiStore } from '../../store/ui-store';
import { resolveNonDoneTaskSortBy } from '../../lib/task-list-sort';

interface SearchViewProps {
    savedSearchId: string;
    onDelete?: () => void;
}

export function SearchView({ savedSearchId, onDelete }: SearchViewProps) {
    const perf = usePerformanceMonitor('SearchView');
    const { tasks, tasksById, projects, areas, settings, updateSettings, batchUpdateTasks, batchDeleteTasks, batchMoveTasks, restoreTask } = useTaskStore(
        (state) => ({
            tasks: state.tasks,
            tasksById: state._tasksById,
            projects: state.projects,
            areas: state.areas,
            settings: state.settings,
            updateSettings: state.updateSettings,
            batchUpdateTasks: state.batchUpdateTasks,
            batchDeleteTasks: state.batchDeleteTasks,
            batchMoveTasks: state.batchMoveTasks,
            restoreTask: state.restoreTask,
        }),
        shallow
    );
    const { t } = useLanguage();
    const showToast = useUiStore((state) => state.showToast);
    const sortBy = resolveNonDoneTaskSortBy(settings?.taskSortBy, settings);
    const [tagPromptOpen, setTagPromptOpen] = useState(false);
    const [removeTagPickerOpen, setRemoveTagPickerOpen] = useState(false);
    const [contextPromptOpen, setContextPromptOpen] = useState(false);
    const [contextPromptMode, setContextPromptMode] = useState<'add' | 'remove'>('add');
    const [bulkOrganizeOpen, setBulkOrganizeOpen] = useState(false);
    const listScrollRef = useRef<HTMLDivElement>(null);
    const { requestConfirmation, confirmModal } = useConfirmDialog();

    const savedSearch = settings?.savedSearches?.find(s => s.id === savedSearchId);
    const query = savedSearch?.query || '';

    useEffect(() => {
        if (!perf.enabled) return;
        const timer = window.setTimeout(() => {
            checkBudget('SearchView', perf.metrics, 'simple');
        }, 0);
        return () => window.clearTimeout(timer);
    }, [perf.enabled]);

    const projectMapById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
    const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
    const bulkAreaOptions = useMemo(
        () => [...areas]
            .filter((area) => !area.deletedAt)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((area) => ({ id: area.id, name: area.name })),
        [areas],
    );
    const resolvedAreaFilter = useMemo(
        () => resolveAreaFilterSelection(settings?.filters, areas),
        [settings?.filters, areas],
    );

    const filteredTasks = useMemo(() => {
        if (!query) return [];
        return sortTasksBy(
            filterTasksBySearch(tasks, projects, query).filter((task) =>
                taskMatchesAreaFilterSelection(task, resolvedAreaFilter, projectMapById, areaById)
            ),
            sortBy
        );
    }, [tasks, projects, query, sortBy, resolvedAreaFilter, projectMapById, areaById]);
    const shouldVirtualize = filteredTasks.length > LIST_VIRTUALIZATION_THRESHOLD;
    const rowVirtualizer = useVirtualizer({
        count: shouldVirtualize ? filteredTasks.length : 0,
        getScrollElement: () => listScrollRef.current,
        estimateSize: () => LIST_VIRTUAL_ROW_ESTIMATE,
        overscan: LIST_VIRTUAL_OVERSCAN_ROWS,
        getItemKey: (index) => filteredTasks[index]?.id ?? index,
    });

    const filteredTaskIds = useMemo(() => filteredTasks.map((task) => task.id), [filteredTasks]);
    const {
        activeAction,
        allVisibleTasksSelected,
        assignAreaToSelectedTasks,
        clearTaskSelection,
        deleteSelectedTasks,
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

    const [selectedTaskIndex, setSelectedTaskIndex] = useState(0);
    useTaskListScope({
        getTasks: () => filteredTasks,
        getSelectedIndex: () => selectedTaskIndex,
        setSelectedIndex: setSelectedTaskIndex,
        t,
        toggleSelect: (task) => toggleMultiSelect(task.id),
    });

    const handleBatchMove = moveSelectedTasks;
    const handleBatchAssignArea = assignAreaToSelectedTasks;

    const handleApplyTaskBulkOrganize = useCallback(async (input: BulkOrganizeTaskUpdateInput) => {
        await organizeSelectedTasks(input, {
            afterSuccess: () => setBulkOrganizeOpen(false),
        });
    }, [organizeSelectedTasks]);

    const handleBatchDelete = useCallback(async () => {
        await deleteSelectedTasks({
            confirm: () => requestConfirmation({
                title: tFallback(t, 'common.delete', 'Delete'),
                description: tFallback(t, 'list.confirmBatchDelete', 'Delete selected tasks?'),
                confirmLabel: tFallback(t, 'common.delete', 'Delete'),
                cancelLabel: tFallback(t, 'common.cancel', 'Cancel'),
            }),
        });
    }, [deleteSelectedTasks, requestConfirmation, t]);

    const handleBatchAddTag = useCallback(() => {
        if (selectedIdsArray.length === 0) return;
        setTagPromptOpen(true);
    }, [selectedIdsArray]);

    const handleBatchAddContext = useCallback(() => {
        if (selectedIdsArray.length === 0) return;
        setContextPromptMode('add');
        setContextPromptOpen(true);
    }, [selectedIdsArray]);

    const handleBatchRemoveContext = useCallback(() => {
        if (selectedIdsArray.length === 0) return;
        setContextPromptMode('remove');
        setContextPromptOpen(true);
    }, [selectedIdsArray]);

    const removableTagOptions = useMemo(
        () => collectBulkTaskTokens(selectedIdsArray, tasksById, 'tags'),
        [selectedIdsArray, tasksById],
    );

    const handleBatchRemoveTag = useCallback(() => {
        if (selectedIdsArray.length === 0) return;
        setRemoveTagPickerOpen(true);
    }, [selectedIdsArray]);

    const handleDelete = useCallback(async () => {
        if (!savedSearch) return;
        const confirmed = await requestConfirmation({
            title: tFallback(t, 'common.delete', 'Delete'),
            description: tFallback(t, 'search.deleteConfirm', `Delete "${savedSearch.name}"?`),
            confirmLabel: tFallback(t, 'common.delete', 'Delete'),
            cancelLabel: tFallback(t, 'common.cancel', 'Cancel'),
        });
        if (!confirmed) return;

        const updated = (settings?.savedSearches || []).filter(s => s.id !== savedSearchId);
        await updateSettings({ savedSearches: updated });
        onDelete?.();
    }, [onDelete, requestConfirmation, savedSearch, savedSearchId, settings?.savedSearches, t, updateSettings]);

    return (
        <ErrorBoundary>
            <div className={cn("flex flex-col gap-4", shouldVirtualize && "h-full min-h-0")}>
            <header className="flex items-center justify-between">
                <div className="space-y-1">
                    <h2 className="text-2xl font-bold tracking-tight">
                        {savedSearch?.name || t('search.savedSearches')}
                    </h2>
                    {query && (
                        <p className="text-sm text-muted-foreground">
                            {query}
                        </p>
                    )}
                </div>
                {savedSearch && (
                    <div className="flex items-center gap-2">
                        <button
                            data-task-selection-toggle
                            onClick={toggleSelectionMode}
                            className={cn(
                                "text-xs px-3 py-1 rounded-md border transition-colors",
                                selectionMode
                                    ? "bg-primary/10 text-primary border-primary"
                                    : "bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground"
                            )}
                        >
                            {selectionMode ? t('bulk.exitSelect') : t('bulk.select')}
                        </button>
                        <button
                            onClick={handleDelete}
                            className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
                            title={tFallback(t, 'common.delete', 'Delete')}
                        >
                            <Trash2 className="w-5 h-5" />
                        </button>
                    </div>
                )}
            </header>

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
                            t={t}
                        />
                    )}
                </div>
            )}

            {filteredTasks.length === 0 && query && (
                <div className="text-sm text-muted-foreground">
                    {t('search.noResults')}
                </div>
            )}

            <div
                ref={listScrollRef}
                className={shouldVirtualize ? "flex-1 min-h-0 overflow-y-auto" : undefined}
            >
                <div data-list-end className={cn(LIST_END_GAP, !shouldVirtualize && "space-y-3")}>
                {shouldVirtualize ? (
                    <div
                        data-testid="virtualized-task-list"
                        style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}
                    >
                        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
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
                                    <div className="pb-3">
                                        <StoreTaskItem
                                            taskId={task.id}
                                            selectionMode={selectionMode}
                                            isMultiSelected={multiSelectedIds.has(task.id)}
                                            onToggleSelectId={toggleMultiSelect}
                                        />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    filteredTasks.map(task => (
                        <StoreTaskItem
                            key={task.id}
                            taskId={task.id}
                            selectionMode={selectionMode}
                            isMultiSelected={multiSelectedIds.has(task.id)}
                            onToggleSelectId={toggleMultiSelect}
                        />
                    ))
                )}
                </div>
            </div>
            </div>
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
            <PromptModal
                isOpen={contextPromptOpen}
                title={contextPromptMode === 'add' ? t('bulk.addContext') : t('bulk.removeContext')}
                description={contextPromptMode === 'add' ? t('bulk.addContext') : t('bulk.removeContext')}
                placeholder={t('bulk.contextPlaceholder')}
                defaultValue=""
                confirmLabel={t('common.save')}
                cancelLabel={t('common.cancel')}
                onCancel={() => setContextPromptOpen(false)}
                onConfirm={async (value) => {
                    const input = value.trim();
                    if (!input) return;
                    const ctx = input.startsWith('@') ? input : `@${input}`;
                    await updateSelectedTaskTokens('contexts', ctx, contextPromptMode, {
                        afterNoop: () => setContextPromptOpen(false),
                        afterSuccess: () => setContextPromptOpen(false),
                    });
                }}
            />
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
            {confirmModal}
        </ErrorBoundary>
    );
}
