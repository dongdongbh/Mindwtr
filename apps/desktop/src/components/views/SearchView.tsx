import { useMemo, useCallback, useEffect, useState, useRef, type UIEvent } from 'react';
import { ErrorBoundary } from '../ErrorBoundary';
import { shallow, useTaskStore, filterTasksBySearch, sortTasksBy, TaskStatus } from '@mindwtr/core';
import type { TaskSortBy } from '@mindwtr/core';
import { useLanguage } from '../../contexts/language-context';
import { Trash2 } from 'lucide-react';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import { checkBudget } from '../../config/performanceBudgets';
import { ListBulkActions } from './list/ListBulkActions';
import { PromptModal } from '../PromptModal';
import { cn } from '../../lib/utils';
import { resolveAreaFilter, taskMatchesAreaFilter } from '../../lib/area-filter';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';
import { VirtualTaskRow } from './list/VirtualTaskRow';
import {
    LIST_VIRTUALIZATION_THRESHOLD,
    LIST_VIRTUAL_ROW_ESTIMATE,
    LIST_VIRTUAL_OVERSCAN,
    useVirtualList,
} from './list/useVirtualList';
import { StoreTaskItem } from './list/StoreTaskItem';

interface SearchViewProps {
    savedSearchId: string;
    onDelete?: () => void;
}

export function SearchView({ savedSearchId, onDelete }: SearchViewProps) {
    const perf = usePerformanceMonitor('SearchView');
    const { tasks, tasksById, projects, areas, settings, updateSettings, batchUpdateTasks, batchDeleteTasks, batchMoveTasks } = useTaskStore(
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
        }),
        shallow
    );
    const { t } = useLanguage();
    const sortBy = (settings?.taskSortBy ?? 'default') as TaskSortBy;
    const [selectionMode, setSelectionMode] = useState(false);
    const [multiSelectedIds, setMultiSelectedIds] = useState<Set<string>>(new Set());
    const [tagPromptOpen, setTagPromptOpen] = useState(false);
    const [tagPromptIds, setTagPromptIds] = useState<string[]>([]);
    const [contextPromptOpen, setContextPromptOpen] = useState(false);
    const [contextPromptMode, setContextPromptMode] = useState<'add' | 'remove'>('add');
    const [contextPromptIds, setContextPromptIds] = useState<string[]>([]);
    const listScrollRef = useRef<HTMLDivElement>(null);
    const rowHeightsRef = useRef<Map<string, number>>(new Map());
    const [measureVersion, setMeasureVersion] = useState(0);
    const [listScrollTop, setListScrollTop] = useState(0);
    const [listHeight, setListHeight] = useState(0);
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

    useEffect(() => {
        const element = listScrollRef.current;
        if (!element) return;
        const updateHeight = () => {
            const nextHeight = element.clientHeight;
            setListHeight((current) => (current === nextHeight ? current : nextHeight));
        };
        updateHeight();
        window.addEventListener('resize', updateHeight);
        const resizeObserver = typeof ResizeObserver === 'function'
            ? new ResizeObserver(() => updateHeight())
            : null;
        resizeObserver?.observe(element);
        return () => {
            window.removeEventListener('resize', updateHeight);
            resizeObserver?.disconnect();
        };
    }, []);

    const projectMapById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
    const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
    const resolvedAreaFilter = useMemo(
        () => resolveAreaFilter(settings?.filters?.areaId, areas),
        [settings?.filters?.areaId, areas],
    );

    const filteredTasks = useMemo(() => {
        if (!query) return [];
        return sortTasksBy(
            filterTasksBySearch(tasks, projects, query).filter((task) =>
                taskMatchesAreaFilter(task, resolvedAreaFilter, projectMapById, areaById)
            ),
            sortBy
        );
    }, [tasks, projects, query, sortBy, resolvedAreaFilter, projectMapById, areaById]);
    const shouldVirtualize = filteredTasks.length > LIST_VIRTUALIZATION_THRESHOLD;
    const handleVirtualRowMeasure = useCallback((id: string, height: number) => {
        if (rowHeightsRef.current.get(id) === height) return;
        rowHeightsRef.current.set(id, height);
        setMeasureVersion((current) => current + 1);
    }, []);
    const handleVirtualScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
        setListScrollTop(event.currentTarget.scrollTop);
    }, []);
    const { rowOffsets, totalHeight, startIndex, visibleTasks } = useVirtualList({
        tasks: filteredTasks,
        shouldVirtualize,
        rowHeightsRef,
        measureVersion,
        listScrollTop,
        listHeight,
        rowEstimate: LIST_VIRTUAL_ROW_ESTIMATE,
        overscan: LIST_VIRTUAL_OVERSCAN,
    });

    const exitSelectionMode = useCallback(() => {
        setSelectionMode(false);
        setMultiSelectedIds(new Set());
    }, []);

    const toggleMultiSelect = useCallback((taskId: string) => {
        setMultiSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(taskId)) next.delete(taskId);
            else next.add(taskId);
            return next;
        });
    }, []);

    const selectedIdsArray = useMemo(() => Array.from(multiSelectedIds), [multiSelectedIds]);

    const handleBatchMove = useCallback(async (newStatus: TaskStatus) => {
        if (selectedIdsArray.length === 0) return;
        await batchMoveTasks(selectedIdsArray, newStatus);
        exitSelectionMode();
    }, [batchMoveTasks, selectedIdsArray, exitSelectionMode]);

    const handleBatchDelete = useCallback(async () => {
        if (selectedIdsArray.length === 0) return;
        const confirmed = await requestConfirmation({
            title: t('common.delete') || 'Delete',
            description: t('list.confirmBatchDelete') || 'Delete selected tasks?',
            confirmLabel: t('common.delete') || 'Delete',
            cancelLabel: t('common.cancel') || 'Cancel',
        });
        if (!confirmed) return;
        await batchDeleteTasks(selectedIdsArray);
        exitSelectionMode();
    }, [batchDeleteTasks, exitSelectionMode, requestConfirmation, selectedIdsArray, t]);

    const handleBatchAddTag = useCallback(() => {
        if (selectedIdsArray.length === 0) return;
        setTagPromptIds(selectedIdsArray);
        setTagPromptOpen(true);
    }, [selectedIdsArray]);

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

    const handleDelete = useCallback(async () => {
        if (!savedSearch) return;
        const confirmed = await requestConfirmation({
            title: t('common.delete') || 'Delete',
            description: t('search.deleteConfirm') || `Delete "${savedSearch.name}"?`,
            confirmLabel: t('common.delete') || 'Delete',
            cancelLabel: t('common.cancel') || 'Cancel',
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
                            onClick={() => {
                                if (selectionMode) exitSelectionMode();
                                else setSelectionMode(true);
                            }}
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
                            title={t('common.delete') || 'Delete'}
                        >
                            <Trash2 className="w-5 h-5" />
                        </button>
                    </div>
                )}
            </header>

            {selectionMode && selectedIdsArray.length > 0 && (
                <ListBulkActions
                    selectionCount={selectedIdsArray.length}
                    onMoveToStatus={handleBatchMove}
                    onAddTag={handleBatchAddTag}
                    onAddContext={handleBatchAddContext}
                    onRemoveContext={handleBatchRemoveContext}
                    onDelete={handleBatchDelete}
                    t={t}
                />
            )}

            {filteredTasks.length === 0 && query && (
                <div className="text-sm text-muted-foreground">
                    {t('search.noResults')}
                </div>
            )}

            <div
                ref={listScrollRef}
                onScroll={handleVirtualScroll}
                className={shouldVirtualize ? "flex-1 min-h-0 overflow-y-auto" : "space-y-3"}
            >
                {shouldVirtualize ? (
                    <div style={{ height: totalHeight, position: 'relative' }}>
                        {visibleTasks.map((task, visibleIndex) => {
                            const taskIndex = startIndex + visibleIndex;
                            return (
                                <VirtualTaskRow
                                    key={task.id}
                                    taskId={task.id}
                                    index={taskIndex}
                                    top={rowOffsets[taskIndex] ?? 0}
                                    selectionMode={selectionMode}
                                    isMultiSelected={multiSelectedIds.has(task.id)}
                                    onToggleSelectId={toggleMultiSelect}
                                    onMeasure={handleVirtualRowMeasure}
                                    gapClassName="pb-3"
                                    showDivider={false}
                                />
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
                placeholder={t('bulk.contextPlaceholder')}
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
            {confirmModal}
        </ErrorBoundary>
    );
}
