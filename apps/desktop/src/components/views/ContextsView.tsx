import { useState, useEffect, useMemo } from 'react';
import { useTaskStore, matchesHierarchicalToken, isTaskInActiveProject, shallow, TaskStatus } from '@mindwtr/core';
import { TaskItem } from '../TaskItem';
import { Tag, Filter } from 'lucide-react';
import { PromptModal } from '../PromptModal';
import { ListBulkActions } from './list/ListBulkActions';
import { cn } from '../../lib/utils';
import { useLanguage } from '../../contexts/language-context';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import { checkBudget } from '../../config/performanceBudgets';
import { resolveAreaFilter, taskMatchesAreaFilter } from '../../lib/area-filter';
import { reportError } from '../../lib/report-error';

export function ContextsView() {
    const perf = usePerformanceMonitor('ContextsView');
    const { tasks, projects, areas, settings } = useTaskStore(
        (state) => ({ tasks: state.tasks, projects: state.projects, areas: state.areas, settings: state.settings }),
        shallow
    );
    const batchMoveTasks = useTaskStore((state) => state.batchMoveTasks);
    const batchDeleteTasks = useTaskStore((state) => state.batchDeleteTasks);
    const batchUpdateTasks = useTaskStore((state) => state.batchUpdateTasks);
    const { t } = useLanguage();
    const [selectedContext, setSelectedContext] = useState<string | null>(null);
    const NO_CONTEXT_TOKEN = '__no_context__';
    const [statusFilter, setStatusFilter] = useState<TaskStatus | 'all'>('all');
    const [searchQuery, setSearchQuery] = useState('');
    const [selectionMode, setSelectionMode] = useState(false);
    const [multiSelectedIds, setMultiSelectedIds] = useState<Set<string>>(new Set());
    const [tagPromptOpen, setTagPromptOpen] = useState(false);
    const [tagPromptIds, setTagPromptIds] = useState<string[]>([]);
    const [contextPromptOpen, setContextPromptOpen] = useState(false);
    const [contextPromptMode, setContextPromptMode] = useState<'add' | 'remove'>('add');
    const [contextPromptIds, setContextPromptIds] = useState<string[]>([]);
    const [isBatchDeleting, setIsBatchDeleting] = useState(false);
    const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
    const resolvedAreaFilter = useMemo(
        () => resolveAreaFilter(settings?.filters?.areaId, areas),
        [settings?.filters?.areaId, areas],
    );

    useEffect(() => {
        if (!perf.enabled) return;
        const timer = window.setTimeout(() => {
            checkBudget('ContextsView', perf.metrics, 'simple');
        }, 0);
        return () => window.clearTimeout(timer);
    }, [perf.enabled]);

    // Filter out deleted tasks first
    const projectMap = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
    const activeTasks = tasks.filter(t =>
        !t.deletedAt
        && isTaskInActiveProject(t, projectMap)
        && taskMatchesAreaFilter(t, resolvedAreaFilter, projectMap, areaById)
    );
    const baseTasks = activeTasks.filter(t => t.status !== 'archived');
    const scopedTasks = statusFilter === 'all'
        ? baseTasks
        : baseTasks.filter(t => t.status === statusFilter);

    // Extract all unique contexts from active tasks
    const allContexts = Array.from(new Set(
        scopedTasks.flatMap(t => [...(t.contexts || []), ...(t.tags || [])])
    )).sort();

    const matchesSelected = (task: typeof activeTasks[number], context: string) => {
        const tokens = [...(task.contexts || []), ...(task.tags || [])];
        return tokens.some(token => matchesHierarchicalToken(context, token));
    };

    const hasContext = (task: typeof activeTasks[number]) =>
        (task.contexts?.length || 0) > 0 || (task.tags?.length || 0) > 0;

    const contextFilteredTasks = selectedContext === NO_CONTEXT_TOKEN
        ? scopedTasks.filter((t) => !hasContext(t))
        : selectedContext
            ? scopedTasks.filter(t => matchesSelected(t, selectedContext))
            : scopedTasks.filter((t) => hasContext(t));
    const normalizedSearchQuery = searchQuery.trim().toLowerCase();
    const filteredTasks = normalizedSearchQuery
        ? contextFilteredTasks.filter((task) => task.title.toLowerCase().includes(normalizedSearchQuery))
        : contextFilteredTasks;
    const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);

    const exitSelectionMode = () => {
        setSelectionMode(false);
        setMultiSelectedIds(new Set());
    };

    const toggleMultiSelect = (taskId: string) => {
        setMultiSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(taskId)) next.delete(taskId);
            else next.add(taskId);
            return next;
        });
    };

    const selectedIdsArray = useMemo(() => Array.from(multiSelectedIds), [multiSelectedIds]);
    const bulkAreaOptions = useMemo(
        () => [...areas]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((area) => ({ id: area.id, name: area.name })),
        [areas]
    );

    const handleBatchMove = async (newStatus: TaskStatus) => {
        if (selectedIdsArray.length === 0) return;
        try {
            await batchMoveTasks(selectedIdsArray, newStatus);
            exitSelectionMode();
        } catch (error) {
            reportError('Failed to batch move tasks in contexts view', error);
        }
    };

    const handleBatchDelete = async () => {
        if (selectedIdsArray.length === 0) return;
        const confirmMessage = t('list.confirmBatchDelete') || 'Delete selected tasks?';
        if (!window.confirm(confirmMessage)) return;
        setIsBatchDeleting(true);
        try {
            await batchDeleteTasks(selectedIdsArray);
            exitSelectionMode();
        } catch (error) {
            reportError('Failed to batch delete tasks in contexts view', error);
        } finally {
            setIsBatchDeleting(false);
        }
    };

    const handleBatchAddTag = () => {
        if (selectedIdsArray.length === 0) return;
        setTagPromptIds(selectedIdsArray);
        setTagPromptOpen(true);
    };

    const handleBatchAddContext = () => {
        if (selectedIdsArray.length === 0) return;
        setContextPromptIds(selectedIdsArray);
        setContextPromptMode('add');
        setContextPromptOpen(true);
    };

    const handleBatchRemoveContext = () => {
        if (selectedIdsArray.length === 0) return;
        setContextPromptIds(selectedIdsArray);
        setContextPromptMode('remove');
        setContextPromptOpen(true);
    };

    const handleBatchAssignArea = async (areaId: string | null) => {
        if (selectedIdsArray.length === 0) return;
        try {
            await batchUpdateTasks(selectedIdsArray.map((id) => ({
                id,
                updates: { areaId: areaId ?? undefined },
            })));
            exitSelectionMode();
        } catch (error) {
            reportError('Failed to batch assign area in contexts view', error);
        }
    };

    useEffect(() => {
        setMultiSelectedIds((prev) => {
            const visible = new Set(filteredTasks.map((task) => task.id));
            const next = new Set(Array.from(prev).filter((id) => visible.has(id)));
            if (next.size === prev.size) return prev;
            return next;
        });
    }, [filteredTasks]);

    const statusOptions: Array<{ value: TaskStatus | 'all'; label: string }> = [
        { value: 'next', label: t('status.next') },
        { value: 'waiting', label: t('status.waiting') },
        { value: 'someday', label: t('status.someday') },
        { value: 'all', label: t('common.all') || 'All' },
    ];

    return (
        <>
            <div className="mx-auto flex h-full w-full max-w-6xl gap-6">
            {/* Sidebar List of Contexts */}
            <div className="w-64 flex-shrink-0 flex flex-col gap-4 border-r border-border pr-6">
                <div className="flex items-center justify-between">
                    <h2 className="text-xl font-bold tracking-tight">{t('contexts.title')}</h2>
                    <Filter className="w-5 h-5 text-muted-foreground" />
                </div>

                <div className="space-y-1 overflow-y-auto flex-1">
                    <div
                        onClick={() => setSelectedContext(null)}
                        className={cn(
                            "flex items-center gap-2 p-2 rounded-lg cursor-pointer transition-colors text-sm",
                            selectedContext === null ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted/40 text-foreground"
                        )}
                    >
                        <Tag className="w-4 h-4" />
                        <span className="flex-1">{t('contexts.all')}</span>
                        <span className="text-xs text-muted-foreground">
                            {scopedTasks.filter((t) => hasContext(t)).length}
                        </span>
                    </div>

                    <div
                        onClick={() => setSelectedContext(NO_CONTEXT_TOKEN)}
                        className={cn(
                            "flex items-center gap-2 p-2 rounded-lg cursor-pointer transition-colors text-sm",
                            selectedContext === NO_CONTEXT_TOKEN ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted/40 text-foreground"
                        )}
                    >
                        <Tag className="w-4 h-4" />
                        <span className="flex-1">{t('contexts.none')}</span>
                        <span className="text-xs text-muted-foreground">
                            {scopedTasks.filter((t) => !hasContext(t)).length}
                        </span>
                    </div>

                    {allContexts.map(context => (
                        <div
                            key={context}
                            onClick={() => setSelectedContext(context)}
                            className={cn(
                                "flex items-center gap-2 p-2 rounded-lg cursor-pointer transition-colors text-sm",
                                selectedContext === context ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted/40 text-foreground"
                            )}
                        >
                            <span className="text-muted-foreground">@</span>
                            <span className="flex-1 truncate">{context.replace(/^@/, '')}</span>
                            <span className="text-xs text-muted-foreground">
                                {scopedTasks.filter(t => matchesSelected(t, context)).length}
                            </span>
                        </div>
                    ))}

                    {allContexts.length === 0 && (
                        <div className="text-sm text-muted-foreground text-center py-8">
                            {t('contexts.noContexts')}
                        </div>
                    )}
                </div>
            </div>

            {/* Context Tasks */}
            <div className="flex-1 flex flex-col h-full overflow-hidden">
                <header className="flex items-center gap-3 mb-6">
                    <div className="p-2 bg-primary/10 rounded-lg">
                        <Tag className="w-6 h-6 text-primary" />
                    </div>
                    <div>
                        <h2 className="text-2xl font-bold">
                            {selectedContext === NO_CONTEXT_TOKEN ? t('contexts.none') : (selectedContext ?? t('contexts.all'))}
                        </h2>
                        <p className="text-muted-foreground text-sm">
                            {filteredTasks.length} {t('common.tasks')}
                        </p>
                    </div>
                    <div className="ml-auto">
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
                            <select
                                value={statusFilter}
                                onChange={(event) => setStatusFilter(event.target.value as TaskStatus | 'all')}
                                className="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
                            >
                                {statusOptions.map((option) => (
                                    <option key={option.value} value={option.value}>
                                        {option.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>
                </header>
                <div className="mb-4">
                    <input
                        type="text"
                        data-view-filter-input
                        placeholder={t('common.search')}
                        value={searchQuery}
                        onChange={(event) => setSearchQuery(event.target.value)}
                        className="w-full text-sm px-3 py-2 rounded border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                </div>

                {selectionMode && selectedIdsArray.length > 0 && (
                    <div className="mb-4">
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
                    </div>
                )}

                <div className="flex-1 overflow-y-auto divide-y divide-border/30 pr-2">
                    {filteredTasks.length > 0 ? (
                        filteredTasks.map(task => (
                            <TaskItem
                                key={task.id}
                                task={task}
                                selectionMode={selectionMode}
                                isMultiSelected={multiSelectedIds.has(task.id)}
                                onToggleSelect={() => toggleMultiSelect(task.id)}
                                showProjectBadgeInActions={false}
                            />
                        ))
                    ) : (
                        <div className="text-center text-muted-foreground py-12">
                            {normalizedSearchQuery ? t('filters.noMatch') : t('contexts.noTasks')}
                        </div>
                    )}
                </div>
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
                    try {
                        await batchUpdateTasks(tagPromptIds.map((id) => {
                            const task = tasksById.get(id);
                            const existingTags = task?.tags || [];
                            const nextTags = Array.from(new Set([...existingTags, tag]));
                            return { id, updates: { tags: nextTags } };
                        }));
                        setTagPromptOpen(false);
                        exitSelectionMode();
                    } catch (error) {
                        reportError('Failed to batch add tag in contexts view', error);
                    }
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
                    try {
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
                    } catch (error) {
                        reportError('Failed to batch update context in contexts view', error);
                    }
                }}
            />
        </>
    );
}
