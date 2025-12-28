import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Plus, Play, X, Trash2, Moon, User, CheckCircle } from 'lucide-react';
import { useTaskStore, TaskStatus, Task, PRESET_CONTEXTS, PRESET_TAGS, sortTasksBy, Project, parseQuickAdd, isTaskBlocked, matchesHierarchicalToken, safeParseDate, createAIProvider } from '@mindwtr/core';
import type { TaskSortBy } from '@mindwtr/core';
import { TaskItem } from '../TaskItem';
import { cn } from '../../lib/utils';
import { useLanguage } from '../../contexts/language-context';
import { useKeybindings } from '../../contexts/keybinding-context';
import { buildCopilotConfig, loadAIKey } from '../../lib/ai-config';


interface ListViewProps {
    title: string;
    statusFilter: TaskStatus | 'all';
}

type ProcessingStep = 'actionable' | 'twomin' | 'decide' | 'context' | 'project' | 'waiting-note';

export function ListView({ title, statusFilter }: ListViewProps) {
    const { tasks, projects, settings, updateSettings, addTask, updateTask, deleteTask, moveTask, batchMoveTasks, batchDeleteTasks, batchUpdateTasks } = useTaskStore();
    const { t } = useLanguage();
    const { registerTaskListScope } = useKeybindings();
    const sortBy = (settings?.taskSortBy ?? 'default') as TaskSortBy;
    const [newTaskTitle, setNewTaskTitle] = useState('');
    const [selectedContext, setSelectedContext] = useState<string | null>(null);
    const [customContext, setCustomContext] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [selectionMode, setSelectionMode] = useState(false);
    const [multiSelectedIds, setMultiSelectedIds] = useState<Set<string>>(new Set());
    const addInputRef = useRef<HTMLInputElement>(null);
    const [aiKey, setAiKey] = useState('');
    const [copilotSuggestion, setCopilotSuggestion] = useState<{ context?: string; tags?: string[] } | null>(null);
    const [copilotApplied, setCopilotApplied] = useState(false);
    const [copilotContext, setCopilotContext] = useState<string | null>(null);
    const [copilotTags, setCopilotTags] = useState<string[]>([]);
    const aiEnabled = settings?.ai?.enabled === true;
    const aiProvider = (settings?.ai?.provider ?? 'openai') as 'openai' | 'gemini';

    const exitSelectionMode = useCallback(() => {
        setSelectionMode(false);
        setMultiSelectedIds(new Set());
    }, []);

    // Inbox processing state
    const [isProcessing, setIsProcessing] = useState(false);
    const [processingTask, setProcessingTask] = useState<Task | null>(null);
    const [processingStep, setProcessingStep] = useState<ProcessingStep>('actionable');
    const [selectedContexts, setSelectedContexts] = useState<string[]>([]);
    const [waitingNote, setWaitingNote] = useState('');

    const allContexts = useMemo(() => {
        const taskContexts = tasks.flatMap(t => t.contexts || []);
        return Array.from(new Set([...PRESET_CONTEXTS, ...taskContexts])).sort();
    }, [tasks]);
    const allTags = useMemo(() => {
        const taskTags = tasks.flatMap(t => t.tags || []);
        return Array.from(new Set([...PRESET_TAGS, ...taskTags])).sort();
    }, [tasks]);

    useEffect(() => {
        setAiKey(loadAIKey(aiProvider));
    }, [aiProvider]);

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
                const suggestion = await provider.predictMetadata({ title, contexts: allContexts, tags: allTags });
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
        const sequentialProjects = projects.filter(p => p.isSequential);
        const firstTaskIds = new Set<string>();

        for (const project of sequentialProjects) {
            const projectTasks = tasks
                .filter(t => t.projectId === project.id && t.status === 'next' && !t.deletedAt)
                .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

            if (projectTasks.length > 0) {
                firstTaskIds.add(projectTasks[0].id);
            }
        }
        return firstTaskIds;
    }, [tasks, projects]);

    const filteredTasks = useMemo(() => {
        const now = new Date();
        const filtered = tasks.filter(t => {
            // Always filter out soft-deleted tasks
            if (t.deletedAt) return false;

            if (statusFilter !== 'all' && t.status !== statusFilter) return false;
            // Respect statusFilter (handled above).

            if (statusFilter === 'inbox') {
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

            if (statusFilter === 'next' && isTaskBlocked(t, tasksById)) return false;

            if (selectedContext && !(t.contexts || []).some(ctx => matchesHierarchicalToken(selectedContext, ctx))) return false;
            return true;
        });

        return sortTasksBy(filtered, sortBy);
    }, [tasks, projects, statusFilter, selectedContext, sequentialProjectFirstTasks, projectMap, sortBy]);

    useEffect(() => {
        setSelectedIndex(0);
        exitSelectionMode();
    }, [statusFilter, selectedContext, exitSelectionMode]);

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
        }
    }, [filteredTasks, selectedIndex]);

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

    const contextCounts = useMemo(() => {
        const counts: Record<string, number> = {};
        tasks.filter(t => !t.deletedAt && (statusFilter === 'all' || t.status === statusFilter)).forEach(t => {
            (t.contexts || []).forEach(ctx => {
                counts[ctx] = (counts[ctx] || 0) + 1;
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
        const input = window.prompt(t('bulk.addTag'));
        if (!input) return;
        const tag = input.startsWith('#') ? input : `#${input}`;
        await batchUpdateTasks(selectedIdsArray.map((id) => {
            const task = tasksById[id];
            const existingTags = task?.tags || [];
            const nextTags = Array.from(new Set([...existingTags, tag]));
            return { id, updates: { tags: nextTags } };
        }));
        exitSelectionMode();
    }, [batchUpdateTasks, selectedIdsArray, tasksById, t, exitSelectionMode]);

    const handleAddTask = (e: React.FormEvent) => {
        e.preventDefault();
        if (newTaskTitle.trim()) {
            const { title: parsedTitle, props } = parseQuickAdd(newTaskTitle, projects);
            const finalTitle = parsedTitle || newTaskTitle;
            const initialProps: Partial<Task> = { ...props };
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
            addTask(finalTitle, initialProps);
            setNewTaskTitle('');
            setCopilotSuggestion(null);
            setCopilotApplied(false);
            setCopilotContext(null);
            setCopilotTags([]);
        }
    };

    // Inbox processing handlers
    const startProcessing = () => {
        const inboxTasks = tasks.filter(t => t.status === 'inbox');
        if (inboxTasks.length > 0) {
            setProcessingTask(inboxTasks[0]);
            setProcessingStep('actionable');
            setSelectedContexts([]);
            setIsProcessing(true);
        }
    };

    const processNext = () => {
        // Exclude the current task being processed (its status may not have updated in state yet)
        const currentTaskId = processingTask?.id;
        const inboxTasks = tasks.filter(t => t.status === 'inbox' && t.id !== currentTaskId);
        if (inboxTasks.length > 0) {
            setProcessingTask(inboxTasks[0]);
            setProcessingStep('actionable');
            setSelectedContexts([]);
        } else {
            setIsProcessing(false);
            setProcessingTask(null);
            setSelectedContexts([]);
        }
    };

    const handleNotActionable = (action: 'trash' | 'someday') => {
        if (!processingTask) return;
        if (action === 'trash') {
            deleteTask(processingTask.id);
        } else {
            moveTask(processingTask.id, 'someday');
        }
        processNext();
    };

    const handleActionable = () => setProcessingStep('twomin');

    const handleTwoMinDone = () => {
        if (processingTask) {
            moveTask(processingTask.id, 'done');
        }
        processNext();
    };

    const handleTwoMinNo = () => setProcessingStep('decide');

    const handleDelegate = () => {
        setWaitingNote('');
        setProcessingStep('waiting-note');
    };

    const handleConfirmWaiting = () => {
        if (processingTask) {
            updateTask(processingTask.id, {
                status: 'waiting',
                description: waitingNote || processingTask.description
            });
        }
        setWaitingNote('');
        processNext();
    };

    const handleDefer = () => {
        setSelectedContexts([]);
        setProcessingStep('context');
    };

    const toggleContext = (ctx: string) => {
        setSelectedContexts(prev =>
            prev.includes(ctx) ? prev.filter(c => c !== ctx) : [...prev, ctx]
        );
    };

    const addCustomContext = () => {
        if (customContext.trim()) {
            const ctx = `@${customContext.trim().replace(/^@/, '')}`;
            if (!selectedContexts.includes(ctx)) {
                setSelectedContexts(prev => [...prev, ctx]);
            }
            setCustomContext('');
        }
    };

    const handleConfirmContexts = () => {
        setProcessingStep('project');
    };

    const handleSetProject = (projectId: string | null) => {
        if (processingTask) {
            updateTask(processingTask.id, {
                status: 'next',
                contexts: selectedContexts,
                projectId: projectId || undefined
            });
        }
        processNext();
    };

    const showContextFilter = ['next', 'all'].includes(statusFilter);
    const isInbox = statusFilter === 'inbox';
    const inboxCount = tasks.filter(t => {
        if (t.status !== 'inbox' || t.deletedAt) return false;
        const start = safeParseDate(t.startTime);
        if (start && start > new Date()) return false;
        return true;
    }).length;
    const nextCount = tasks.filter(t => t.status === 'next' && !t.deletedAt).length;
    const isNextView = statusFilter === 'next';
    const NEXT_WARNING_THRESHOLD = 15;

    return (
        <div className="space-y-6">
            <header className="flex items-center justify-between">
                <h2 className="text-3xl font-bold tracking-tight">
                    {title}
                    {isNextView && <span className="ml-2 text-lg font-normal text-muted-foreground">({nextCount})</span>}
                </h2>
                <div className="flex items-center gap-3">
                    <span className="text-muted-foreground text-sm">
                        {filteredTasks.length} {t('common.tasks')}
                        {selectedContext && <span className="ml-1 text-primary">• {selectedContext}</span>}
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

            {/* Inbox Processing Bar */}
            {isInbox && inboxCount > 0 && !isProcessing && (
                <button
                    onClick={startProcessing}
                    className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground py-3 px-4 rounded-lg font-medium hover:bg-primary/90 transition-colors"
                >
                    <Play className="w-4 h-4" />
                    {t('process.btn')} ({inboxCount})
                </button>
            )}

            {/* Inbox Processing Wizard */}
            {isProcessing && processingTask && (
                <div className="bg-card border border-border rounded-xl p-6 space-y-4 animate-in fade-in">
                    <div className="flex items-center justify-between">
                        <h3 className="font-semibold text-lg">📋 {t('process.title')}</h3>
                        <button
                            onClick={() => setIsProcessing(false)}
                            className="text-muted-foreground hover:text-foreground"
                        >
                            <X className="w-5 h-5" />
                        </button>
                    </div>

                    <div className="bg-muted/50 rounded-lg p-4">
                        <p className="font-medium">{processingTask.title}</p>
                    </div>

                    {processingStep === 'actionable' && (
                        <div className="space-y-4">
                            <p className="text-center font-medium">{t('process.actionable')}</p>
                            <p className="text-center text-sm text-muted-foreground">
                                {t('process.actionableDesc')}
                            </p>
                            <div className="flex gap-3">
                                <button
                                    onClick={handleActionable}
                                    className="flex-1 bg-primary text-primary-foreground py-3 rounded-lg font-medium hover:bg-primary/90"
                                >
                                    {t('process.yesActionable')}
                                </button>
                            </div>
                            <p className="text-xs text-muted-foreground text-center pt-2">{t('process.ifNotActionable')}</p>
                            <div className="flex gap-3">
                                <button
                                    onClick={() => handleNotActionable('trash')}
                                    className="flex-1 flex items-center justify-center gap-2 bg-destructive/10 text-destructive py-2 rounded-lg font-medium hover:bg-destructive/20"
                                >
                                    <Trash2 className="w-4 h-4" /> {t('process.trash')}
                                </button>
                                <button
                                    onClick={() => handleNotActionable('someday')}
                                    className="flex-1 flex items-center justify-center gap-2 bg-purple-500/10 text-purple-600 py-2 rounded-lg font-medium hover:bg-purple-500/20"
                                >
                                    <Moon className="w-4 h-4" /> {t('process.someday')}
                                </button>
                            </div>
                        </div>
                    )}

                    {processingStep === 'twomin' && (
                        <div className="space-y-4">
                            <p className="text-center font-medium">{t('process.twoMin')}</p>
                            <p className="text-center text-sm text-muted-foreground">
                                {t('process.twoMinDesc')}
                            </p>
                            <div className="flex gap-3">
                                <button
                                    onClick={handleTwoMinDone}
                                    className="flex-1 flex items-center justify-center gap-2 bg-green-500 text-white py-3 rounded-lg font-medium hover:bg-green-600"
                                >
                                    <CheckCircle className="w-4 h-4" /> {t('process.doneIt')}
                                </button>
                                <button
                                    onClick={handleTwoMinNo}
                                    className="flex-1 bg-muted py-3 rounded-lg font-medium hover:bg-muted/80"
                                >
                                    {t('process.takesLonger')}
                                </button>
                            </div>
                        </div>
                    )}

                    {processingStep === 'decide' && (
                        <div className="space-y-4">
                            <p className="text-center font-medium">{t('process.nextStep')}</p>
                            <p className="text-center text-sm text-muted-foreground">
                                {t('process.nextStepDesc')}
                            </p>
                            <div className="flex gap-3">
                                <button
                                    onClick={handleDefer}
                                    className="flex-1 bg-primary text-primary-foreground py-3 rounded-lg font-medium hover:bg-primary/90"
                                >
                                    {t('process.doIt')}
                                </button>
                                <button
                                    onClick={handleDelegate}
                                    className="flex-1 flex items-center justify-center gap-2 bg-orange-500 text-white py-3 rounded-lg font-medium hover:bg-orange-600"
                                >
                                    <User className="w-4 h-4" /> {t('process.delegate')}
                                </button>
                            </div>
                        </div>
                    )}

                    {processingStep === 'waiting-note' && (
                        <div className="space-y-4">
                            <p className="text-center font-medium">👤 {t('process.waitingFor')}</p>
                            <p className="text-center text-sm text-muted-foreground">
                                {t('process.waitingForDesc')}
                            </p>
                            <textarea
                                value={waitingNote}
                                onChange={(e) => setWaitingNote(e.target.value)}
                                placeholder={t('process.waitingPlaceholder')}
                                className="w-full bg-muted border border-border rounded-lg px-3 py-3 text-sm focus:ring-2 focus:ring-primary resize-none"
                                rows={3}
                            />
                            <div className="flex gap-3">
                                <button
                                    onClick={handleConfirmWaiting}
                                    className="flex-1 py-3 bg-muted text-muted-foreground rounded-lg font-medium hover:bg-muted/80"
                                >
                                    {t('common.skip')}
                                </button>
                                <button
                                    onClick={handleConfirmWaiting}
                                    className="flex-1 py-3 bg-orange-500 text-white rounded-lg font-medium hover:bg-orange-600"
                                >
                                    ✓ {t('common.done')}
                                </button>
                            </div>
                        </div>
                    )}

                    {processingStep === 'context' && (
                        <div className="space-y-4">
                            <p className="text-center font-medium">{t('process.context')}</p>
                            <p className="text-center text-sm text-muted-foreground">
                                {t('process.contextDesc')} {t('process.selectMultipleHint')}
                            </p>

                            {/* Selected contexts display */}
                            {selectedContexts.length > 0 && (
                                <div className="flex flex-wrap gap-2 justify-center p-3 bg-primary/10 rounded-lg">
                                    <span className="text-xs text-primary font-medium">{t('process.selectedLabel')}</span>
                                    {selectedContexts.map(ctx => (
                                        <span key={ctx} className="px-2 py-1 bg-primary text-primary-foreground rounded-full text-xs">
                                            {ctx}
                                        </span>
                                    ))}
                                </div>
                            )}

                            {/* Custom context input */}
                            <div className="flex gap-2">
                                <input
                                    type="text"
                                    placeholder={t('process.newContextPlaceholder')}
                                    value={customContext}
                                    onChange={(e) => setCustomContext(e.target.value)}
                                    className="flex-1 bg-muted border border-border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary"
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            addCustomContext();
                                        }
                                    }}
                                />
                                <button
                                    onClick={addCustomContext}
                                    disabled={!customContext.trim()}
                                    className="px-4 py-2 bg-secondary text-secondary-foreground rounded-lg text-sm font-medium hover:bg-secondary/80 disabled:opacity-50"
                                >
                                    +
                                </button>
                            </div>

                            {/* Existing contexts - toggle selection */}
                            {allContexts.length > 0 && (
                                <div className="flex flex-wrap gap-2 justify-center">
                                    {allContexts.map(ctx => (
                                        <button
                                            key={ctx}
                                            onClick={() => toggleContext(ctx)}
                                            className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${selectedContexts.includes(ctx)
                                                ? 'bg-primary text-primary-foreground'
                                                : 'bg-muted hover:bg-muted/80'
                                                }`}
                                        >
                                            {ctx}
                                        </button>
                                    ))}
                                </div>
                            )}

                            {/* Next button - go to project step */}
                            <button
                                onClick={handleConfirmContexts}
                                className="w-full py-3 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90"
                            >
                                {selectedContexts.length > 0
                                    ? `${t('process.next')} → (${selectedContexts.length})`
                                    : `${t('process.next')} → (${t('process.noContext')})`}
                            </button>
                        </div>
                    )}

                    {processingStep === 'project' && (
                        <div className="space-y-4">
                            <p className="text-center font-medium">{t('process.project')}</p>
                            <p className="text-center text-sm text-muted-foreground">
                                {t('process.projectDesc')}
                            </p>

                            {/* No project option */}
                            <button
                                onClick={() => handleSetProject(null)}
                                className="w-full py-3 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700"
                            >
                                ✓ {t('process.noProject')}
                            </button>

                            {/* Project list */}
                            {projects.length > 0 && (
                                <div className="space-y-2 max-h-48 overflow-y-auto">
                                    {projects.map(project => (
                                        <button
                                            key={project.id}
                                            onClick={() => handleSetProject(project.id)}
                                            className="w-full flex items-center gap-3 p-3 bg-muted rounded-lg hover:bg-muted/80 text-left"
                                        >
                                            <div
                                                className="w-3 h-3 rounded-full"
                                                style={{ backgroundColor: project.color || '#6B7280' }}
                                            />
                                            <span>{project.title}</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    <p className="text-xs text-center text-muted-foreground pt-2">
                        {tasks.filter(t => t.status === 'inbox').length} {t('process.remaining')}
                    </p>
                </div>
            )}

            {/* Context Filter Bar */}
            {showContextFilter && !isProcessing && (
                <div className="flex items-center gap-2 flex-wrap">
                    <button
                        onClick={() => setSelectedContext(null)}
                        className={cn(
                            "px-3 py-1.5 rounded-full text-sm font-medium transition-colors",
                            selectedContext === null
                                ? "bg-primary text-primary-foreground"
                                : "bg-muted hover:bg-muted/80 text-muted-foreground"
                        )}
                    >
                        {t('common.all')}
                    </button>
                    {allContexts.map(context => (
                        <button
                            key={context}
                            onClick={() => setSelectedContext(context)}
                            className={cn(
                                "px-3 py-1.5 rounded-full text-sm font-medium transition-colors",
                                selectedContext === context
                                    ? "bg-primary text-primary-foreground"
                                    : "bg-muted hover:bg-muted/80 text-muted-foreground"
                            )}
                        >
                            {context}
                            {contextCounts[context] > 0 && (
                                <span className="ml-1 opacity-70">({contextCounts[context]})</span>
                            )}
                        </button>
                    ))}
                </div>
            )}

            {/* Only show add task for inbox/next - other views are read-only */}
            {['inbox', 'next'].includes(statusFilter) && (
                <form onSubmit={handleAddTask} className="relative">
                    <input
                        ref={addInputRef}
                        type="text"
                        placeholder={`${t('nav.addTask')}... ${t('quickAdd.example')}`}
                        value={newTaskTitle}
                        onChange={(e) => {
                            setNewTaskTitle(e.target.value);
                            setCopilotApplied(false);
                            setCopilotContext(null);
                            setCopilotTags([]);
                        }}
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

            <div className="space-y-3">
                {filteredTasks.length === 0 ? (
                    <div className="text-center py-12 text-muted-foreground">
                        <p>
                            {selectedContext
                                ? t('next.noContext') + ` ${selectedContext}`
                                : t('list.noTasks') || `${t('contexts.noTasks')}`}
                        </p>
                    </div>
                ) : (
	                    filteredTasks.map((task, index) => (
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
	                        />
	                    ))
	                )}
            </div>
        </div>
    );
}
