import React, { useState, useMemo } from 'react';
import { Plus, Play, X, Trash2, Moon, User, CheckCircle } from 'lucide-react';
import { useTaskStore, TaskStatus, Task, PRESET_CONTEXTS, sortTasks, Project } from '@mindwtr/core';
import { TaskItem } from '../TaskItem';
import { cn } from '../../lib/utils';
import { useLanguage } from '../../contexts/language-context';


interface ListViewProps {
    title: string;
    statusFilter: TaskStatus | 'all';
}

type ProcessingStep = 'actionable' | 'twomin' | 'decide' | 'context' | 'project' | 'waiting-note';

export function ListView({ title, statusFilter }: ListViewProps) {
    const { tasks, projects, addTask, updateTask, deleteTask, moveTask } = useTaskStore();
    const { t } = useLanguage();
    const [newTaskTitle, setNewTaskTitle] = useState('');
    const [selectedContext, setSelectedContext] = useState<string | null>(null);
    const [customContext, setCustomContext] = useState('');

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

    const projectMap = useMemo(() => {
        return projects.reduce((acc, project) => {
            acc[project.id] = project;
            return acc;
        }, {} as Record<string, Project>);
    }, [projects]);

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
        const filtered = tasks.filter(t => {
            // Always filter out soft-deleted tasks
            if (t.deletedAt) return false;

            if (statusFilter !== 'all' && t.status !== statusFilter) return false;
            // Filter out archived unless we are in archived view (which uses statusFilter='archived')
            // But ListView is generic. If statusFilter is 'inbox', we want inbox.
            // If 'all', we usually want active tasks.
            // Desktop App.tsx passes explicit filters.

            if (statusFilter === 'all' && (t.status === 'archived' || t.status === 'done')) {
                // "All" view usually implies ContextsView or similar. 
                // But ListView statusFilter is usually one status.
            }
            // Just respect statusFilter.

            // Sequential project filter: for 'next' status, only show first task from sequential projects
            if (statusFilter === 'next' && t.projectId) {
                const project = projectMap[t.projectId];
                if (project?.isSequential) {
                    // Only include if this is the first task
                    if (!sequentialProjectFirstTasks.has(t.id)) return false;
                }
            }

            if (selectedContext && !t.contexts?.includes(selectedContext)) return false;
            return true;
        });

        return sortTasks(filtered);
    }, [tasks, projects, statusFilter, selectedContext, sequentialProjectFirstTasks, projectMap]);

    const contextCounts = useMemo(() => {
        const counts: Record<string, number> = {};
        tasks.filter(t => !t.deletedAt && (statusFilter === 'all' || t.status === statusFilter)).forEach(t => {
            (t.contexts || []).forEach(ctx => {
                counts[ctx] = (counts[ctx] || 0) + 1;
            });
        });
        return counts;
    }, [tasks, statusFilter]);

    const handleAddTask = (e: React.FormEvent) => {
        e.preventDefault();
        if (newTaskTitle.trim()) {
            addTask(newTaskTitle);
            setNewTaskTitle('');
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
                status: 'todo',
                contexts: selectedContexts,
                projectId: projectId || undefined
            });
        }
        processNext();
    };

    const showContextFilter = ['next', 'todo', 'all'].includes(statusFilter);
    const isInbox = statusFilter === 'inbox';
    const inboxCount = tasks.filter(t => t.status === 'inbox').length;
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
                <span className="text-muted-foreground text-sm">
                    {filteredTasks.length} {t('common.tasks')}
                    {selectedContext && <span className="ml-1 text-primary">• {selectedContext}</span>}
                </span>
            </header>

            {/* Next Actions Warning */}
            {isNextView && nextCount > NEXT_WARNING_THRESHOLD && (
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 flex items-start gap-3">
                    <span className="text-amber-500 text-xl">⚠️</span>
                    <div>
                        <p className="font-medium text-amber-700 dark:text-amber-400">
                            {nextCount} items in Next Actions
                        </p>
                        <p className="text-sm text-amber-600 dark:text-amber-500 mt-1">
                            Consider focusing on fewer projects. GTD recommends keeping Next Actions to 10-15 items for clarity.
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
                            <p className="text-xs text-muted-foreground text-center pt-2">If not actionable:</p>
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
                            <p className="text-center font-medium">👤 {t('process.waitingFor') || 'Who/what are you waiting for?'}</p>
                            <p className="text-center text-sm text-muted-foreground">
                                {t('process.waitingForDesc') || 'Add a note to remember what you\'re waiting on'}
                            </p>
                            <textarea
                                value={waitingNote}
                                onChange={(e) => setWaitingNote(e.target.value)}
                                placeholder="e.g., Waiting for John to review the document..."
                                className="w-full bg-muted border border-border rounded-lg px-3 py-3 text-sm focus:ring-2 focus:ring-primary resize-none"
                                rows={3}
                            />
                            <div className="flex gap-3">
                                <button
                                    onClick={handleConfirmWaiting}
                                    className="flex-1 py-3 bg-muted text-muted-foreground rounded-lg font-medium hover:bg-muted/80"
                                >
                                    Skip
                                </button>
                                <button
                                    onClick={handleConfirmWaiting}
                                    className="flex-1 py-3 bg-orange-500 text-white rounded-lg font-medium hover:bg-orange-600"
                                >
                                    ✓ Done
                                </button>
                            </div>
                        </div>
                    )}

                    {processingStep === 'context' && (
                        <div className="space-y-4">
                            <p className="text-center font-medium">{t('process.context')}</p>
                            <p className="text-center text-sm text-muted-foreground">
                                {t('process.contextDesc')} (Select multiple or none)
                            </p>

                            {/* Selected contexts display */}
                            {selectedContexts.length > 0 && (
                                <div className="flex flex-wrap gap-2 justify-center p-3 bg-primary/10 rounded-lg">
                                    <span className="text-xs text-primary font-medium">Selected:</span>
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
                                    placeholder={t('process.newContextPlaceholder') || 'Add new context...'}
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
                                    ? `Next → (${selectedContexts.length} context${selectedContexts.length > 1 ? 's' : ''} selected)`
                                    : 'Next → (No context)'}
                            </button>
                        </div>
                    )}

                    {processingStep === 'project' && (
                        <div className="space-y-4">
                            <p className="text-center font-medium">{t('process.project') || 'Assign to a project?'}</p>
                            <p className="text-center text-sm text-muted-foreground">
                                {t('process.projectDesc') || 'Optional - link this task to a project'}
                            </p>

                            {/* No project option */}
                            <button
                                onClick={() => handleSetProject(null)}
                                className="w-full py-3 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700"
                            >
                                ✓ Done - No project needed
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

            {/* Only show add task for inbox/next/todo - other views are read-only */}
            {['inbox', 'next', 'todo'].includes(statusFilter) && (
                <form onSubmit={handleAddTask} className="relative">
                    <input
                        type="text"
                        placeholder={`Add a task to ${title}...`}
                        value={newTaskTitle}
                        onChange={(e) => setNewTaskTitle(e.target.value)}
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
                    filteredTasks.map(task => (
                        <TaskItem key={task.id} task={task} project={task.projectId ? projectMap[task.projectId] : undefined} />
                    ))
                )}
            </div>
        </div>
    );
}
