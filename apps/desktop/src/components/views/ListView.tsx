import React, { useState, useMemo, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { Plus, Filter } from 'lucide-react';
import { useTaskStore, TaskStatus, Task, TaskPriority, TimeEstimate, PRESET_CONTEXTS, PRESET_TAGS, sortTasksBy, Project, parseQuickAdd, matchesHierarchicalToken, safeParseDate, createAIProvider, type AIProviderId } from '@mindwtr/core';
import type { TaskSortBy } from '@mindwtr/core';
import { TaskItem } from '../TaskItem';
import { TaskInput } from '../Task/TaskInput';
import { cn } from '../../lib/utils';
import { PromptModal } from '../PromptModal';
import { InboxProcessor } from './InboxProcessor';
import { useLanguage } from '../../contexts/language-context';
import { useKeybindings } from '../../contexts/keybinding-context';
import { buildCopilotConfig, loadAIKey } from '../../lib/ai-config';


interface ListViewProps {
    title: string;
    statusFilter: TaskStatus | 'all';
}

const EMPTY_PRIORITIES: TaskPriority[] = [];
const EMPTY_ESTIMATES: TimeEstimate[] = [];
const VIRTUALIZATION_THRESHOLD = 80;
const VIRTUAL_ROW_ESTIMATE = 120;
const VIRTUAL_OVERSCAN = 600;

type VirtualTaskRowProps = {
    task: Task;
    project?: Project;
    top: number;
    isSelected: boolean;
    selectionMode: boolean;
    isMultiSelected: boolean;
    onSelect: () => void;
    onToggleSelect: () => void;
    onMeasure: (id: string, height: number) => void;
    showQuickDone: boolean;
};

const VirtualTaskRow = React.memo(function VirtualTaskRow({
    task,
    project,
    top,
    isSelected,
    selectionMode,
    isMultiSelected,
    onSelect,
    onToggleSelect,
    onMeasure,
    showQuickDone,
}: VirtualTaskRowProps) {
    const rowRef = useRef<HTMLDivElement | null>(null);

    useLayoutEffect(() => {
        const node = rowRef.current;
        if (!node) return undefined;
        const measure = () => {
            const nextHeight = Math.ceil(node.getBoundingClientRect().height);
            onMeasure(task.id, nextHeight);
        };
        measure();
        if (typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver(() => measure());
        observer.observe(node);
        return () => observer.disconnect();
    }, [task.id, onMeasure]);

    return (
        <div ref={rowRef} style={{ position: 'absolute', top, left: 0, right: 0 }}>
            <div className="pb-3">
                <TaskItem
                    key={task.id}
                    task={task}
                    project={project}
                    isSelected={isSelected}
                    onSelect={onSelect}
                    selectionMode={selectionMode}
                    isMultiSelected={isMultiSelected}
                    onToggleSelect={onToggleSelect}
                    showQuickDone={showQuickDone}
                />
            </div>
        </div>
    );
});

export function ListView({ title, statusFilter }: ListViewProps) {
    const { tasks, projects, areas, settings, updateSettings, addTask, addProject, updateTask, deleteTask, moveTask, batchMoveTasks, batchDeleteTasks, batchUpdateTasks, queryTasks, lastDataChangeAt } = useTaskStore();
    const { t } = useLanguage();
    const { registerTaskListScope } = useKeybindings();
    const sortBy = (settings?.taskSortBy ?? 'default') as TaskSortBy;
    const [newTaskTitle, setNewTaskTitle] = useState('');
    const [selectedTokens, setSelectedTokens] = useState<string[]>([]);
    const [selectedPriorities, setSelectedPriorities] = useState<TaskPriority[]>([]);
    const [selectedTimeEstimates, setSelectedTimeEstimates] = useState<TimeEstimate[]>([]);
    const [baseTasks, setBaseTasks] = useState<Task[]>([]);
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [selectionMode, setSelectionMode] = useState(false);
    const [multiSelectedIds, setMultiSelectedIds] = useState<Set<string>>(new Set());
    const [tagPromptOpen, setTagPromptOpen] = useState(false);
    const [tagPromptIds, setTagPromptIds] = useState<string[]>([]);
    const addInputRef = useRef<HTMLInputElement>(null);
    const listScrollRef = useRef<HTMLDivElement>(null);
    const rowHeightsRef = useRef<Map<string, number>>(new Map());
    const [listScrollTop, setListScrollTop] = useState(0);
    const [listHeight, setListHeight] = useState(0);
    const [measureVersion, setMeasureVersion] = useState(0);
    const [aiKey, setAiKey] = useState('');
    const [copilotSuggestion, setCopilotSuggestion] = useState<{ context?: string; tags?: string[] } | null>(null);
    const [copilotApplied, setCopilotApplied] = useState(false);
    const [copilotContext, setCopilotContext] = useState<string | null>(null);
    const [copilotTags, setCopilotTags] = useState<string[]>([]);
    const aiEnabled = settings?.ai?.enabled === true;
    const aiProvider = (settings?.ai?.provider ?? 'openai') as AIProviderId;
    const prioritiesEnabled = settings?.features?.priorities === true;
    const timeEstimatesEnabled = settings?.features?.timeEstimates === true;
    const showQuickDone = statusFilter === 'next';
    const activePriorities = useMemo(
        () => (prioritiesEnabled ? selectedPriorities : EMPTY_PRIORITIES),
        [prioritiesEnabled, selectedPriorities]
    );
    const activeTimeEstimates = useMemo(
        () => (timeEstimatesEnabled ? selectedTimeEstimates : EMPTY_ESTIMATES),
        [timeEstimatesEnabled, selectedTimeEstimates]
    );

    const exitSelectionMode = useCallback(() => {
        setSelectionMode(false);
        setMultiSelectedIds(new Set());
    }, []);

    const [isProcessing, setIsProcessing] = useState(false);

    const allContexts = useMemo(() => {
        const taskContexts = tasks.flatMap(t => t.contexts || []);
        return Array.from(new Set([...PRESET_CONTEXTS, ...taskContexts])).sort();
    }, [tasks]);
    const allTags = useMemo(() => {
        const taskTags = tasks.flatMap(t => t.tags || []);
        return Array.from(new Set([...PRESET_TAGS, ...taskTags])).sort();
    }, [tasks]);
    const allTokens = useMemo(() => {
        return Array.from(new Set([...allContexts, ...allTags])).sort();
    }, [allContexts, allTags]);

    useEffect(() => {
        setAiKey(loadAIKey(aiProvider));
    }, [aiProvider]);

    const copilotAbortRef = useRef<AbortController | null>(null);

    useEffect(() => {
        if (!aiEnabled || !aiKey) {
            setCopilotSuggestion(null);
            return;
        }
        const title = newTaskTitle.trim();
        if (title.length < 4) {
            setCopilotSuggestion(null);
            return;
        }
        let cancelled = false;
        const handle = setTimeout(async () => {
            try {
                const provider = createAIProvider(buildCopilotConfig(settings, aiKey));
                if (copilotAbortRef.current) copilotAbortRef.current.abort();
                const abortController = typeof AbortController === 'function' ? new AbortController() : null;
                copilotAbortRef.current = abortController;
                const suggestion = await provider.predictMetadata(
                    { title, contexts: allContexts, tags: allTags },
                    abortController ? { signal: abortController.signal } : undefined
                );
                if (cancelled) return;
                if (!suggestion.context && !suggestion.tags?.length) {
                    setCopilotSuggestion(null);
                } else {
                    setCopilotSuggestion({ context: suggestion.context, tags: suggestion.tags });
                }
            } catch {
                if (!cancelled) setCopilotSuggestion(null);
            }
        }, 800);
        return () => {
            cancelled = true;
            clearTimeout(handle);
            if (copilotAbortRef.current) {
                copilotAbortRef.current.abort();
                copilotAbortRef.current = null;
            }
        };
    }, [aiEnabled, aiKey, newTaskTitle, allContexts, allTags, settings]);

    const projectMap = useMemo(() => {
        return projects.reduce((acc, project) => {
            acc[project.id] = project;
            return acc;
        }, {} as Record<string, Project>);
    }, [projects]);

    const tasksById = useMemo(() => {
        return tasks.reduce((acc, task) => {
            acc[task.id] = task;
            return acc;
        }, {} as Record<string, Task>);
    }, [tasks]);

    // For sequential projects, get only the first (oldest) task to show in Next view
    const sequentialProjectFirstTasks = useMemo(() => {
        const sequentialIds = new Set(projects.filter(p => p.isSequential).map((p) => p.id));
        if (sequentialIds.size === 0) return new Set<string>();
        const earliestByProject = new Map<string, Task>();

        for (const task of baseTasks) {
            if (task.deletedAt || task.status !== 'next' || !task.projectId) continue;
            if (!sequentialIds.has(task.projectId)) continue;
            const existing = earliestByProject.get(task.projectId);
            if (!existing || new Date(task.createdAt).getTime() < new Date(existing.createdAt).getTime()) {
                earliestByProject.set(task.projectId, task);
            }
        }

        return new Set(Array.from(earliestByProject.values()).map((task) => task.id));
    }, [baseTasks, projects]);

    useEffect(() => {
        let cancelled = false;
        const status = statusFilter === 'all' ? undefined : statusFilter;
        queryTasks({
            status,
            includeArchived: status === 'archived',
            includeDeleted: false,
        }).then((result) => {
            if (!cancelled) setBaseTasks(result);
        }).catch(() => {
            if (!cancelled) setBaseTasks([]);
        });
        return () => {
            cancelled = true;
        };
    }, [statusFilter, queryTasks, lastDataChangeAt]);

    const filteredTasks = useMemo(() => {
        const now = new Date();
        const filtered = baseTasks.filter(t => {
            // Always filter out soft-deleted tasks
            if (t.deletedAt) return false;

            if (statusFilter !== 'all' && t.status !== statusFilter) return false;
            // Respect statusFilter (handled above).

            if (statusFilter === 'inbox') {
                const start = safeParseDate(t.startTime);
                if (start && start > now) return false;
            }
            if (statusFilter === 'next') {
                const start = safeParseDate(t.startTime);
                if (start && start > now) return false;
            }

            // Sequential project filter: for 'next' status, only show first task from sequential projects
            if (statusFilter === 'next' && t.projectId) {
                const project = projectMap[t.projectId];
                if (project?.isSequential) {
                    // Only include if this is the first task
                    if (!sequentialProjectFirstTasks.has(t.id)) return false;
                }
            }


            const taskTokens = [...(t.contexts || []), ...(t.tags || [])];
            if (selectedTokens.length > 0) {
                const matchesAll = selectedTokens.every((token) =>
                    taskTokens.some((taskToken) => matchesHierarchicalToken(token, taskToken))
                );
                if (!matchesAll) return false;
            }
            if (activePriorities.length > 0 && (!t.priority || !activePriorities.includes(t.priority))) return false;
            if (activeTimeEstimates.length > 0 && (!t.timeEstimate || !activeTimeEstimates.includes(t.timeEstimate))) return false;
            return true;
        });

        return sortTasksBy(filtered, sortBy);
    }, [baseTasks, projects, statusFilter, selectedTokens, activePriorities, activeTimeEstimates, sequentialProjectFirstTasks, projectMap, sortBy]);

    const shouldVirtualize = filteredTasks.length > VIRTUALIZATION_THRESHOLD;

    const handleListScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
        setListScrollTop(event.currentTarget.scrollTop);
    }, []);

    const handleRowMeasure = useCallback((id: string, height: number) => {
        const nextHeight = Math.max(40, height);
        const prevHeight = rowHeightsRef.current.get(id);
        if (prevHeight !== nextHeight) {
            rowHeightsRef.current.set(id, nextHeight);
            setMeasureVersion((version) => version + 1);
        }
    }, []);

    useEffect(() => {
        if (!shouldVirtualize) return;
        const container = listScrollRef.current;
        if (!container) return;
        const updateHeight = () => setListHeight(container.clientHeight);
        updateHeight();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(updateHeight);
        observer.observe(container);
        return () => observer.disconnect();
    }, [shouldVirtualize]);

    useEffect(() => {
        if (!shouldVirtualize) return;
        const activeIds = new Set(filteredTasks.map((task) => task.id));
        for (const id of rowHeightsRef.current.keys()) {
            if (!activeIds.has(id)) {
                rowHeightsRef.current.delete(id);
            }
        }
    }, [filteredTasks, shouldVirtualize]);

    const rowHeights = useMemo(() => {
        if (!shouldVirtualize) return [];
        return filteredTasks.map((task) => rowHeightsRef.current.get(task.id) ?? VIRTUAL_ROW_ESTIMATE);
    }, [filteredTasks, measureVersion, shouldVirtualize]);

    const { rowOffsets, totalHeight } = useMemo(() => {
        if (!shouldVirtualize) return { rowOffsets: [] as number[], totalHeight: 0 };
        let offset = 0;
        const offsets = rowHeights.map((height) => {
            const top = offset;
            offset += height;
            return top;
        });
        return { rowOffsets: offsets, totalHeight: offset };
    }, [rowHeights, shouldVirtualize]);

    const { startIndex, endIndex } = useMemo(() => {
        if (!shouldVirtualize) return { startIndex: 0, endIndex: filteredTasks.length };
        const count = rowOffsets.length;
        if (count === 0) return { startIndex: 0, endIndex: 0 };
        const targetStart = Math.max(0, listScrollTop - VIRTUAL_OVERSCAN);
        let low = 0;
        let high = count - 1;
        while (low <= high) {
            const mid = (low + high) >> 1;
            const midBottom = rowOffsets[mid] + rowHeights[mid];
            if (midBottom < targetStart) {
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        const start = Math.min(low, count - 1);
        const targetEnd = listScrollTop + listHeight + VIRTUAL_OVERSCAN;
        let end = start;
        while (end < count && rowOffsets[end] < targetEnd) {
            end += 1;
        }
        return { startIndex: start, endIndex: end };
    }, [shouldVirtualize, rowOffsets, rowHeights, listScrollTop, listHeight, filteredTasks.length]);

    const visibleTasks = shouldVirtualize ? filteredTasks.slice(startIndex, endIndex) : filteredTasks;

    useEffect(() => {
        setSelectedIndex(0);
        exitSelectionMode();
    }, [statusFilter, selectedTokens, selectedPriorities, selectedTimeEstimates, prioritiesEnabled, timeEstimatesEnabled, exitSelectionMode]);

    useEffect(() => {
        if (filteredTasks.length === 0) {
            setSelectedIndex(0);
            return;
        }
        if (selectedIndex >= filteredTasks.length) {
            setSelectedIndex(filteredTasks.length - 1);
        }
    }, [filteredTasks.length, selectedIndex]);

    useEffect(() => {
        const task = filteredTasks[selectedIndex];
        if (!task) return;
        const el = document.querySelector(`[data-task-id="${task.id}"]`) as HTMLElement | null;
        if (el && typeof (el as any).scrollIntoView === 'function') {
            el.scrollIntoView({ block: 'nearest' });
            return;
        }
        if (shouldVirtualize && listScrollRef.current && rowOffsets[selectedIndex] !== undefined) {
            listScrollRef.current.scrollTo({ top: rowOffsets[selectedIndex], behavior: 'auto' });
        }
    }, [filteredTasks, selectedIndex, shouldVirtualize, rowOffsets]);

    const selectNext = useCallback(() => {
        if (filteredTasks.length === 0) return;
        setSelectedIndex((i) => Math.min(i + 1, filteredTasks.length - 1));
    }, [filteredTasks.length]);

    const selectPrev = useCallback(() => {
        setSelectedIndex((i) => Math.max(i - 1, 0));
    }, []);

    const selectFirst = useCallback(() => {
        setSelectedIndex(0);
    }, []);

    const selectLast = useCallback(() => {
        if (filteredTasks.length > 0) {
            setSelectedIndex(filteredTasks.length - 1);
        }
    }, [filteredTasks.length]);

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
        moveTask(task.id, task.status === 'done' ? 'inbox' : 'done');
    }, [filteredTasks, selectedIndex, moveTask]);

    const deleteSelected = useCallback(() => {
        const task = filteredTasks[selectedIndex];
        if (!task) return;
        deleteTask(task.id);
    }, [filteredTasks, selectedIndex, deleteTask]);

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
            focusAddInput: () => addInputRef.current?.focus(),
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
    ]);

    const tokenCounts = useMemo(() => {
        const counts: Record<string, number> = {};
        tasks
            .filter(t => !t.deletedAt && (statusFilter === 'all' || t.status === statusFilter))
            .forEach(t => {
                const tokens = new Set([...(t.contexts || []), ...(t.tags || [])]);
                tokens.forEach((token) => {
                    counts[token] = (counts[token] || 0) + 1;
                });
            });
        return counts;
    }, [tasks, statusFilter]);

    const toggleMultiSelect = useCallback((taskId: string) => {
        setMultiSelectedIds(prev => {
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
        await batchDeleteTasks(selectedIdsArray);
        exitSelectionMode();
    }, [batchDeleteTasks, selectedIdsArray, exitSelectionMode]);

    const handleBatchAddTag = useCallback(async () => {
        if (selectedIdsArray.length === 0) return;
        setTagPromptIds(selectedIdsArray);
        setTagPromptOpen(true);
    }, [batchUpdateTasks, selectedIdsArray, tasksById, t, exitSelectionMode]);

    const handleAddTask = async (e: React.FormEvent) => {
        e.preventDefault();
        if (newTaskTitle.trim()) {
            const { title: parsedTitle, props, projectTitle } = parseQuickAdd(newTaskTitle, projects);
            const finalTitle = parsedTitle || newTaskTitle;
            const initialProps: Partial<Task> = { ...props };
            if (!initialProps.projectId && projectTitle) {
                const created = await addProject(projectTitle, '#94a3b8');
                initialProps.projectId = created.id;
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
            setCopilotSuggestion(null);
            setCopilotApplied(false);
            setCopilotContext(null);
            setCopilotTags([]);
        }
    };

    const showFilters = ['next', 'all'].includes(statusFilter);
    const isInbox = statusFilter === 'inbox';
    const nextCount = tasks.filter(t => t.status === 'next' && !t.deletedAt).length;
    const isNextView = statusFilter === 'next';
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
            ...selectedTokens,
            ...(prioritiesEnabled ? selectedPriorities.map((priority) => t(`priority.${priority}`)) : []),
            ...(timeEstimatesEnabled ? selectedTimeEstimates.map(formatEstimate) : []),
        ];
    }, [selectedTokens, selectedPriorities, selectedTimeEstimates, prioritiesEnabled, timeEstimatesEnabled, t]);
    const hasFilters = filterSummary.length > 0;
    const filterSummaryLabel = filterSummary.slice(0, 3).join(', ');
    const filterSummarySuffix = filterSummary.length > 3 ? ` +${filterSummary.length - 3}` : '';
    const showFiltersPanel = filtersOpen || hasFilters;
    const toggleTokenFilter = (token: string) => {
        setSelectedTokens((prev) =>
            prev.includes(token) ? prev.filter((item) => item !== token) : [...prev, token]
        );
    };
    const togglePriorityFilter = (priority: TaskPriority) => {
        setSelectedPriorities((prev) =>
            prev.includes(priority) ? prev.filter((item) => item !== priority) : [...prev, priority]
        );
    };
    const toggleTimeFilter = (estimate: TimeEstimate) => {
        setSelectedTimeEstimates((prev) =>
            prev.includes(estimate) ? prev.filter((item) => item !== estimate) : [...prev, estimate]
        );
    };
    const clearFilters = () => {
        setSelectedTokens([]);
        setSelectedPriorities([]);
        setSelectedTimeEstimates([]);
    };

    useEffect(() => {
        if (!prioritiesEnabled && selectedPriorities.length > 0) {
            setSelectedPriorities([]);
        }
    }, [prioritiesEnabled, selectedPriorities.length]);

    useEffect(() => {
        if (!timeEstimatesEnabled && selectedTimeEstimates.length > 0) {
            setSelectedTimeEstimates([]);
        }
    }, [timeEstimatesEnabled, selectedTimeEstimates.length]);

    return (
        <>
        <div className="flex h-full flex-col">
            <div className="space-y-6">
            <header className="flex items-center justify-between">
                <h2 className="text-3xl font-bold tracking-tight">
                    {title}
                    {isNextView && <span className="ml-2 text-lg font-normal text-muted-foreground">({nextCount})</span>}
                </h2>
                <div className="flex items-center gap-3">
                    <span className="text-muted-foreground text-sm">
                        {filteredTasks.length} {t('common.tasks')}
                        {hasFilters && (
                            <span className="ml-1 text-primary">• {filterSummaryLabel}{filterSummarySuffix}</span>
                        )}
                    </span>
                    <select
                        value={sortBy}
                        onChange={(e) => updateSettings({ taskSortBy: e.target.value as TaskSortBy })}
                        aria-label={t('sort.label')}
                        className="text-xs bg-muted/50 text-foreground border border-border rounded px-2 py-1 hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
                    >
                        <option value="default">{t('sort.default')}</option>
                        <option value="due">{t('sort.due')}</option>
                        <option value="start">{t('sort.start')}</option>
                        <option value="review">{t('sort.review')}</option>
                        <option value="title">{t('sort.title')}</option>
                        <option value="created">{t('sort.created')}</option>
                        <option value="created-desc">{t('sort.created-desc')}</option>
                    </select>
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
                </div>
            </header>

            {selectionMode && selectedIdsArray.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 bg-card border border-border rounded-lg p-3">
                    <span className="text-sm text-muted-foreground">
                        {selectedIdsArray.length} {t('bulk.selected')}
                    </span>
                    <div className="flex items-center gap-2">
                        {(['inbox', 'next', 'waiting', 'someday', 'done'] as TaskStatus[]).map((status) => (
                            <button
                                key={status}
                                onClick={() => handleBatchMove(status)}
                                className="text-xs px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors"
                            >
                                {t(`status.${status}`)}
                            </button>
                        ))}
                    </div>
                    <button
                        onClick={handleBatchAddTag}
                        className="text-xs px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors"
                    >
                        {t('bulk.addTag')}
                    </button>
                    <button
                        onClick={handleBatchDelete}
                        className="text-xs px-2 py-1 rounded bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
                    >
                        {t('bulk.delete')}
                    </button>
                </div>
            )}

            {/* Next Actions Warning */}
            {isNextView && nextCount > NEXT_WARNING_THRESHOLD && (
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 flex items-start gap-3">
                    <span className="text-amber-500 text-xl">⚠️</span>
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

            <InboxProcessor
                t={t}
                isInbox={isInbox}
                tasks={tasks}
                projects={projects}
                areas={areas}
                addProject={addProject}
                updateTask={updateTask}
                deleteTask={deleteTask}
                allContexts={allContexts}
                isProcessing={isProcessing}
                setIsProcessing={setIsProcessing}
            />

            {/* Filters */}
            {showFilters && !isProcessing && (
                <div className="bg-card border border-border rounded-lg p-3 space-y-3">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                            <Filter className="w-4 h-4" />
                            {t('filters.label')}
                        </div>
                        <div className="flex items-center gap-2">
                            {hasFilters && (
                                <button
                                    type="button"
                                    onClick={clearFilters}
                                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                                >
                                    {t('filters.clear')}
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={() => setFiltersOpen((prev) => !prev)}
                                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                            >
                                {showFiltersPanel ? t('filters.hide') : t('filters.show')}
                            </button>
                        </div>
                    </div>
                    {showFiltersPanel && (
                        <div className="space-y-4">
                            <div className="space-y-2">
                                <div className="text-xs text-muted-foreground uppercase tracking-wide">{t('filters.contexts')}</div>
                                <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
                                    {allTokens.map((token) => {
                                        const isActive = selectedTokens.includes(token);
                                        return (
                                            <button
                                                key={token}
                                                type="button"
                                                onClick={() => toggleTokenFilter(token)}
                                                aria-pressed={isActive}
                                                className={cn(
                                                    "px-3 py-1.5 rounded-full text-xs font-medium transition-colors",
                                                    isActive
                                                        ? "bg-primary text-primary-foreground"
                                                        : "bg-muted hover:bg-muted/80 text-muted-foreground"
                                                )}
                                            >
                                                {token}
                                                {tokenCounts[token] > 0 && (
                                                    <span className="ml-1 opacity-70">({tokenCounts[token]})</span>
                                                )}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                            {prioritiesEnabled && (
                                <div className="space-y-2">
                                    <div className="text-xs text-muted-foreground uppercase tracking-wide">{t('filters.priority')}</div>
                                    <div className="flex flex-wrap gap-2">
                                        {priorityOptions.map((priority) => {
                                            const isActive = selectedPriorities.includes(priority);
                                            return (
                                                <button
                                                    key={priority}
                                                    type="button"
                                                    onClick={() => togglePriorityFilter(priority)}
                                                    aria-pressed={isActive}
                                                    className={cn(
                                                        "px-3 py-1.5 rounded-full text-xs font-medium transition-colors",
                                                        isActive
                                                            ? "bg-primary text-primary-foreground"
                                                            : "bg-muted hover:bg-muted/80 text-muted-foreground"
                                                    )}
                                                >
                                                    {t(`priority.${priority}`)}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                            {timeEstimatesEnabled && (
                                <div className="space-y-2">
                                    <div className="text-xs text-muted-foreground uppercase tracking-wide">{t('filters.timeEstimate')}</div>
                                    <div className="flex flex-wrap gap-2">
                                        {timeEstimateOptions.map((estimate) => {
                                            const isActive = selectedTimeEstimates.includes(estimate);
                                            return (
                                                <button
                                                    key={estimate}
                                                    type="button"
                                                    onClick={() => toggleTimeFilter(estimate)}
                                                    aria-pressed={isActive}
                                                    className={cn(
                                                        "px-3 py-1.5 rounded-full text-xs font-medium transition-colors",
                                                        isActive
                                                            ? "bg-primary text-primary-foreground"
                                                            : "bg-muted hover:bg-muted/80 text-muted-foreground"
                                                    )}
                                                >
                                                    {formatEstimate(estimate)}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Only show add task for inbox/next - other views are read-only */}
            {['inbox', 'next'].includes(statusFilter) && (
                <form onSubmit={handleAddTask} className="relative">
                    <TaskInput
                        inputRef={addInputRef}
                        value={newTaskTitle}
                        projects={projects}
                        contexts={allContexts}
                        onCreateProject={async (title) => {
                            const created = await addProject(title, '#94a3b8');
                            return created.id;
                        }}
                        onChange={(next) => {
                            setNewTaskTitle(next);
                            setCopilotApplied(false);
                            setCopilotContext(null);
                            setCopilotTags([]);
                        }}
                        placeholder={`${t('nav.addTask')}... ${t('quickAdd.example')}`}
                        className="w-full bg-card border border-border rounded-lg py-3 pl-4 pr-12 shadow-sm focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
                    />
                    <button
                        type="submit"
                        disabled={!newTaskTitle.trim()}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 bg-primary text-primary-foreground rounded-md disabled:opacity-50 disabled:cursor-not-allowed hover:bg-primary/90 transition-colors"
                    >
                        <Plus className="w-4 h-4" />
                    </button>
                </form>
            )}
            {['inbox', 'next'].includes(statusFilter) && aiEnabled && copilotSuggestion && !copilotApplied && (
                <button
                    type="button"
                    onClick={() => {
                        setCopilotContext(copilotSuggestion.context ?? null);
                        setCopilotTags(copilotSuggestion.tags ?? []);
                        setCopilotApplied(true);
                    }}
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
                onScroll={handleListScroll}
                className="flex-1 min-h-0 overflow-y-auto pt-3"
            >
                {filteredTasks.length === 0 ? (
                    <div className="text-center py-12 text-muted-foreground">
                        <p>
                            {hasFilters ? t('filters.noMatch') : t('list.noTasks') || `${t('contexts.noTasks')}`}
                        </p>
                    </div>
                ) : shouldVirtualize ? (
                    <div style={{ height: totalHeight, position: 'relative' }}>
                        {visibleTasks.map((task, index) => {
                            const actualIndex = startIndex + index;
                            return (
                                <VirtualTaskRow
                                    key={task.id}
                                    task={task}
                                    project={task.projectId ? projectMap[task.projectId] : undefined}
                                    top={rowOffsets[actualIndex] ?? 0}
                                    isSelected={actualIndex === selectedIndex}
                                    onSelect={() => {
                                        if (!selectionMode) setSelectedIndex(actualIndex);
                                    }}
                                    selectionMode={selectionMode}
                                    isMultiSelected={multiSelectedIds.has(task.id)}
                                    onToggleSelect={() => toggleMultiSelect(task.id)}
                                    onMeasure={handleRowMeasure}
                                    showQuickDone={showQuickDone}
                                />
                            );
                        })}
                    </div>
                ) : (
                    <div className="space-y-3">
                        {filteredTasks.map((task, index) => (
                            <TaskItem
                                key={task.id}
                                task={task}
                                project={task.projectId ? projectMap[task.projectId] : undefined}
                                isSelected={index === selectedIndex}
                                onSelect={() => {
                                    if (!selectionMode) setSelectedIndex(index);
                                }}
                                selectionMode={selectionMode}
                                isMultiSelected={multiSelectedIds.has(task.id)}
                                onToggleSelect={() => toggleMultiSelect(task.id)}
                                showQuickDone={showQuickDone}
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
                    const task = tasksById[id];
                    const existingTags = task?.tags || [];
                    const nextTags = Array.from(new Set([...existingTags, tag]));
                    return { id, updates: { tags: nextTags } };
                }));
                setTagPromptOpen(false);
                exitSelectionMode();
            }}
        />
        </>
    );
}
