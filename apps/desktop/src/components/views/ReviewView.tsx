import { useCallback, useEffect, useMemo, useState } from 'react';

import { createAIProvider, getStaleItems, isDueForReview, safeFormatDate, safeParseDate, safeParseDueDate, sortTasksBy, PRESET_CONTEXTS, type ReviewSuggestion, useTaskStore, type Project, type Task, type TaskStatus, type TaskSortBy, type AIProviderId } from '@mindwtr/core';
import { Archive, ArrowRight, Calendar, Check, CheckSquare, Layers, RefreshCw, Sparkles, Star, X, type LucideIcon } from 'lucide-react';

import { TaskItem } from '../TaskItem';
import { cn } from '../../lib/utils';
import { PromptModal } from '../PromptModal';
import { useLanguage } from '../../contexts/language-context';
import { buildAIConfig, loadAIKey } from '../../lib/ai-config';
import { InboxProcessor } from './InboxProcessor';

type ReviewStep = 'intro' | 'inbox' | 'ai' | 'calendar' | 'waiting' | 'projects' | 'someday' | 'completed';
type CalendarReviewEntry = {
    task: Task;
    date: Date;
    kind: 'due' | 'start';
};

function WeeklyReviewGuideModal({ onClose }: { onClose: () => void }) {
    const [currentStep, setCurrentStep] = useState<ReviewStep>('intro');
    const { tasks, projects, areas, settings, batchUpdateTasks } = useTaskStore();
    const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
    const { t } = useLanguage();
    const [aiSuggestions, setAiSuggestions] = useState<ReviewSuggestion[]>([]);
    const [aiSelectedIds, setAiSelectedIds] = useState<Set<string>>(new Set());
    const [aiLoading, setAiLoading] = useState(false);
    const [aiError, setAiError] = useState<string | null>(null);
    const [aiRan, setAiRan] = useState(false);

    const aiEnabled = settings?.ai?.enabled === true;
    const aiProvider = (settings?.ai?.provider ?? 'openai') as AIProviderId;
    const staleItems = useMemo(() => getStaleItems(tasks, projects), [tasks, projects]);
    const staleItemTitleMap = useMemo(() => {
        return staleItems.reduce((acc, item) => {
            acc[item.id] = item.title;
            return acc;
        }, {} as Record<string, string>);
    }, [staleItems]);
    const calendarReviewItems = useMemo(() => {
        const now = new Date();
        const pastStart = new Date(now);
        pastStart.setDate(pastStart.getDate() - 14);
        const upcomingEnd = new Date(now);
        upcomingEnd.setDate(upcomingEnd.getDate() + 14);
        const entries: CalendarReviewEntry[] = [];

        tasks.forEach((task) => {
            if (task.deletedAt) return;
            const dueDate = safeParseDueDate(task.dueDate);
            if (dueDate) entries.push({ task, date: dueDate, kind: 'due' });
            const startTime = safeParseDate(task.startTime);
            if (startTime) entries.push({ task, date: startTime, kind: 'start' });
        });

        const past = entries
            .filter((entry) => entry.date >= pastStart && entry.date < now)
            .sort((a, b) => b.date.getTime() - a.date.getTime());
        const upcoming = entries
            .filter((entry) => entry.date >= now && entry.date <= upcomingEnd)
            .sort((a, b) => a.date.getTime() - b.date.getTime());

        return { past, upcoming };
    }, [tasks]);

    const steps: { id: ReviewStep; title: string; description: string; icon: LucideIcon }[] = [
        { id: 'intro', title: t('review.title'), description: t('review.intro'), icon: RefreshCw },
        { id: 'inbox', title: t('review.inboxStep'), description: t('review.inboxStepDesc'), icon: CheckSquare },
        { id: 'ai', title: t('review.aiStep'), description: t('review.aiStepDesc'), icon: Sparkles },
        { id: 'calendar', title: t('review.calendarStep'), description: t('review.calendarStepDesc'), icon: Calendar },
        { id: 'waiting', title: t('review.waitingStep'), description: t('review.waitingStepDesc'), icon: ArrowRight },
        { id: 'projects', title: t('review.projectsStep'), description: t('review.projectsStepDesc'), icon: Layers },
        { id: 'someday', title: t('review.somedayStep'), description: t('review.somedayStepDesc'), icon: Archive },
        { id: 'completed', title: t('review.allDone'), description: t('review.allDoneDesc'), icon: Check },
    ];

    const currentStepIndex = steps.findIndex(s => s.id === currentStep);
    const progress = ((currentStepIndex) / (steps.length - 1)) * 100;

    const nextStep = () => {
        if (currentStepIndex < steps.length - 1) {
            setCurrentStep(steps[currentStepIndex + 1].id);
        }
    };

    const prevStep = () => {
        if (currentStepIndex > 0) {
            setCurrentStep(steps[currentStepIndex - 1].id);
        }
    };

    const isActionableSuggestion = (suggestion: ReviewSuggestion) => {
        if (suggestion.id.startsWith('project:')) return false;
        return suggestion.action === 'someday' || suggestion.action === 'archive';
    };

    const toggleSuggestion = (id: string) => {
        setAiSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    };

    const runAiAnalysis = async () => {
        setAiError(null);
        setAiRan(true);
        if (!aiEnabled) {
            setAiError(t('ai.disabledBody'));
            return;
        }
        const apiKey = await loadAIKey(aiProvider);
        if (!apiKey) {
            setAiError(t('ai.missingKeyBody'));
            return;
        }
        if (staleItems.length === 0) {
            setAiSuggestions([]);
            setAiSelectedIds(new Set());
            return;
        }
        setAiLoading(true);
        try {
            const provider = createAIProvider(buildAIConfig(settings, apiKey));
            const response = await provider.analyzeReview({ items: staleItems });
            setAiSuggestions(response.suggestions || []);
            const defaultSelected = new Set(
                (response.suggestions || [])
                    .filter(isActionableSuggestion)
                    .map((suggestion) => suggestion.id),
            );
            setAiSelectedIds(defaultSelected);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setAiError(message || t('ai.errorBody'));
        } finally {
            setAiLoading(false);
        }
    };

    const applyAiSuggestions = async () => {
        const updates = aiSuggestions
            .filter((suggestion) => aiSelectedIds.has(suggestion.id))
            .filter(isActionableSuggestion)
            .map((suggestion) => {
                if (suggestion.action === 'someday') {
                    return { id: suggestion.id, updates: { status: 'someday' as TaskStatus } };
                }
                if (suggestion.action === 'archive') {
                    return { id: suggestion.id, updates: { status: 'archived' as TaskStatus, completedAt: new Date().toISOString() } };
                }
                return null;
            })
            .filter(Boolean) as Array<{ id: string; updates: Partial<Task> }>;

        if (updates.length === 0) return;
        await batchUpdateTasks(updates);
    };

    const renderCalendarList = (items: CalendarReviewEntry[]) => {
        if (items.length === 0) {
            return <div className="text-sm text-muted-foreground">{t('calendar.noTasks')}</div>;
        }
        return (
            <div className="space-y-2">
                {items.map((entry) => (
                    <div key={`${entry.kind}-${entry.task.id}-${entry.date.toISOString()}`} className="flex items-start gap-3 text-sm">
                        <div className="min-w-0">
                            <div className="font-medium truncate">{entry.task.title}</div>
                            <div className="text-xs text-muted-foreground">
                                {(entry.kind === 'due' ? t('taskEdit.dueDateLabel') : t('review.startTime'))}
                                {' / '}
                                {safeFormatDate(entry.date, 'MMM d, HH:mm')}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        );
    };

    const renderStepContent = () => {
        switch (currentStep) {
            case 'intro':
                return (
                    <div className="text-center space-y-6 py-12">
                        <div className="w-20 h-20 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-6">
                            <RefreshCw className="w-10 h-10 text-primary" />
                        </div>
                        <h2 className="text-3xl font-bold">{t('review.timeFor')}</h2>
                        <p className="text-muted-foreground text-lg max-w-md mx-auto">
                            {t('review.timeForDesc')}
                        </p>
                        <button
                            onClick={nextStep}
                            className="bg-primary text-primary-foreground px-8 py-3 rounded-lg text-lg font-medium hover:bg-primary/90 transition-colors"
                        >
                            {t('review.startReview')}
                        </button>
                    </div>
                );

            case 'inbox': {
                const inboxTasks = tasks.filter(t => t.status === 'inbox');
                return (
                    <div className="space-y-4">
                        <div className="bg-muted/30 p-4 rounded-lg border border-border">
                            <h3 className="font-semibold mb-2">{t('review.inboxZero')}</h3>
                            <p className="text-sm text-muted-foreground">
                                <span className="font-bold text-foreground">{inboxTasks.length}</span> {t('review.inboxZeroDesc')}
                            </p>
                        </div>
                        <div className="space-y-2">
                            {inboxTasks.length === 0 ? (
                                <div className="text-center py-12 text-muted-foreground">
                                    <Check className="w-12 h-12 mx-auto mb-4 text-green-500" />
                                    <p>{t('review.inboxEmpty')}</p>
                                </div>
                            ) : (
                                inboxTasks.map(task => <TaskItem key={task.id} task={task} />)
                            )}
                        </div>
                    </div>
                );
            }

            case 'calendar':
                return (
                    <div className="space-y-6">
                        <div className="grid grid-cols-2 gap-6">
                            <div className="space-y-2">
                                <h3 className="font-semibold text-muted-foreground uppercase text-xs tracking-wider">{t('review.past14')}</h3>
                                <div className="bg-card border border-border rounded-lg p-4 min-h-[200px] space-y-3">
                                    <p className="text-xs text-muted-foreground">{t('review.past14Desc')}</p>
                                    {renderCalendarList(calendarReviewItems.past)}
                                </div>
                            </div>
                            <div className="space-y-2">
                                <h3 className="font-semibold text-muted-foreground uppercase text-xs tracking-wider">{t('review.upcoming14')}</h3>
                                <div className="bg-card border border-border rounded-lg p-4 min-h-[200px] space-y-3">
                                    <p className="text-xs text-muted-foreground">{t('review.upcoming14Desc')}</p>
                                    {renderCalendarList(calendarReviewItems.upcoming)}
                                </div>
                            </div>
                        </div>
                    </div>
                );

            case 'waiting': {
                const waitingTasks = tasks.filter(t => t.status === 'waiting');
                const waitingDue = waitingTasks.filter(t => isDueForReview(t.reviewAt));
                const waitingFuture = waitingTasks.filter(t => !isDueForReview(t.reviewAt));
                return (
                    <div className="space-y-4">
                        <p className="text-muted-foreground">
                            {t('review.waitingHint')}
                        </p>
                        <div className="space-y-2">
                            {waitingTasks.length === 0 ? (
                                <div className="text-center py-12 text-muted-foreground">
                                    <p>{t('review.waitingEmpty')}</p>
                                </div>
                            ) : (
                                <>
                                    {waitingDue.length > 0 && waitingDue.map(task => (
                                        <TaskItem key={task.id} task={task} />
                                    ))}
                                    {waitingFuture.length > 0 && (
                                        <div className="pt-4">
                                            <h4 className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
                                                {t('review.notDueYet')}
                                            </h4>
                                            {waitingFuture.map(task => (
                                                <TaskItem key={task.id} task={task} />
                                            ))}
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                );
            }

            case 'ai': {
                return (
                    <div className="space-y-4">
                        <div className="flex items-center justify-between gap-4">
                            <div className="text-sm text-muted-foreground">
                                {t('review.aiStepDesc')}
                            </div>
                            <button
                                onClick={runAiAnalysis}
                                className="bg-primary text-primary-foreground px-3 py-1.5 rounded-md text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
                                disabled={aiLoading}
                            >
                                {aiLoading ? t('review.aiRunning') : t('review.aiRun')}
                            </button>
                        </div>

                        {aiError && (
                            <div className="text-sm text-red-500 bg-red-500/10 border border-red-500/20 rounded-md p-3">
                                {aiError}
                            </div>
                        )}

                        {aiRan && !aiLoading && aiSuggestions.length === 0 && !aiError && (
                            <div className="text-sm text-muted-foreground">{t('review.aiEmpty')}</div>
                        )}

                        {aiSuggestions.length > 0 && (
                            <div className="space-y-3">
                                {aiSuggestions.map((suggestion) => {
                                    const actionable = isActionableSuggestion(suggestion);
                                    return (
                                        <div
                                            key={suggestion.id}
                                            className="border border-border rounded-lg p-3 flex items-start gap-3"
                                        >
                                            {actionable ? (
                                                <button
                                                    type="button"
                                                    onClick={() => toggleSuggestion(suggestion.id)}
                                                    className={cn(
                                                        "mt-1 h-4 w-4 rounded border flex items-center justify-center text-xs",
                                                        aiSelectedIds.has(suggestion.id)
                                                            ? "bg-primary text-primary-foreground border-primary"
                                                            : "border-border text-muted-foreground"
                                                    )}
                                                    aria-pressed={aiSelectedIds.has(suggestion.id)}
                                                >
                                                    {aiSelectedIds.has(suggestion.id) ? '✓' : ''}
                                                </button>
                                            ) : (
                                                <span className="mt-1 h-4 w-4 rounded border border-border/50" />
                                            )}
                                            <div className="flex-1">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-sm font-medium">{staleItemTitleMap[suggestion.id] || suggestion.id}</span>
                                                    <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                                                        {t(`review.aiAction.${suggestion.action}`)}
                                                    </span>
                                                </div>
                                                <div className="text-xs text-muted-foreground mt-1">{suggestion.reason}</div>
                                            </div>
                                        </div>
                                    );
                                })}
                                <div className="flex justify-end">
                                    <button
                                        onClick={applyAiSuggestions}
                                        className="bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
                                        disabled={aiSelectedIds.size === 0}
                                    >
                                        {t('review.aiApply')} ({aiSelectedIds.size})
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                );
            }

            case 'projects': {
                const activeProjects = projects.filter(p => p.status === 'active');
                const dueProjects = activeProjects.filter(p => isDueForReview(p.reviewAt));
                const futureProjects = activeProjects.filter(p => !isDueForReview(p.reviewAt));
                const orderedProjects = [...dueProjects, ...futureProjects];
                return (
                    <div className="space-y-6">
                        <p className="text-muted-foreground">{t('review.projectsHint')}</p>
                        <div className="space-y-4">
                            {orderedProjects.map(project => {
                                const projectTasks = tasks.filter(task => task.projectId === project.id && task.status !== 'done');
                                const hasNextAction = projectTasks.some(task => task.status === 'next');

                                return (
                                    <div key={project.id} className="border border-border rounded-lg p-4">
                                        <div className="flex items-center justify-between mb-3">
                                            <div className="flex items-center gap-2">
                                                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: (project.areaId ? areaById.get(project.areaId)?.color : undefined) || '#94a3b8' }} />
                                                <h3 className="font-semibold">{project.title}</h3>
                                            </div>
                                            <div className={cn("text-xs px-2 py-1 rounded-full", hasNextAction ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600")}>
                                                {hasNextAction ? t('review.hasNextAction') : t('review.needsAction')}
                                            </div>
                                        </div>
                                        <div className="space-y-2 pl-5">
                                            {projectTasks.map(task => (
                                                <TaskItem key={task.id} task={task} />
                                            ))}
                                            {projectTasks.length > 0 && (
                                                <div className="mt-2 text-xs text-muted-foreground bg-muted/30 p-2 rounded border border-border/50">
                                                    <span className="font-semibold mr-1">{t('review.stuckQuestion')}</span>
                                                    {t('review.stuckPrompt')}
                                                </div>
                                            )}
                                            {projectTasks.length === 0 && (
                                                <div className="text-sm text-muted-foreground italic">{t('review.noActiveTasks')}</div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                );
            }

            case 'someday': {
                const somedayTasks = tasks.filter(t => t.status === 'someday');
                const somedayDue = somedayTasks.filter(t => isDueForReview(t.reviewAt));
                const somedayFuture = somedayTasks.filter(t => !isDueForReview(t.reviewAt));
                return (
                    <div className="space-y-4">
                        <p className="text-muted-foreground">
                            {t('review.somedayHint')}
                        </p>
                        <div className="space-y-2">
                            {somedayTasks.length === 0 ? (
                                <div className="text-center py-12 text-muted-foreground">
                                    <p>{t('review.listEmpty')}</p>
                                </div>
                            ) : (
                                <>
                                    {somedayDue.length > 0 && somedayDue.map(task => (
                                        <TaskItem key={task.id} task={task} />
                                    ))}
                                    {somedayFuture.length > 0 && (
                                        <div className="pt-4">
                                            <h4 className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
                                                {t('review.notDueYet')}
                                            </h4>
                                            {somedayFuture.map(task => (
                                                <TaskItem key={task.id} task={task} />
                                            ))}
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                );
            }

            case 'completed':
                return (
                    <div className="text-center space-y-6 py-12">
                        <div className="w-20 h-20 bg-green-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
                            <Check className="w-10 h-10 text-green-600" />
                        </div>
                        <h2 className="text-3xl font-bold">{t('review.complete')}</h2>
                        <p className="text-muted-foreground text-lg max-w-md mx-auto">
                            {t('review.completeDesc')}
                        </p>
                        <button
                            onClick={onClose}
                            className="bg-primary text-primary-foreground px-8 py-3 rounded-lg text-lg font-medium hover:bg-primary/90 transition-colors"
                        >
                            {t('review.finish')}
                        </button>
                    </div>
                );
        }
    };

    return (
        <div
            className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
            role="button"
            tabIndex={0}
            aria-label={t('common.close')}
            onClick={onClose}
            onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onClose();
                }
            }}
        >
            <div
                className="bg-card border border-border rounded-lg shadow-xl max-w-4xl w-full mx-4 max-h-[85vh] flex flex-col"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="p-6 border-b border-border flex items-center justify-between">
                    <h3 className="text-xl font-semibold flex items-center gap-2">
                        <RefreshCw className="w-5 h-5 text-primary" />
                        {t('review.title')}
                    </h3>
                    <button
                        onClick={onClose}
                        className="p-2 rounded-md hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors"
                        aria-label={t('common.close')}
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="p-6 flex flex-col flex-1 min-h-0">
                    <div className="mb-6">
                        <div className="flex items-center justify-between mb-3">
                            <h1 className="text-2xl font-bold flex items-center gap-2">
                                {(() => {
                                    const Icon = steps[currentStepIndex].icon;
                                    return Icon && <Icon className="w-6 h-6" />;
                                })()}
                                {steps[currentStepIndex].title}
                            </h1>
                            <span className="text-sm text-muted-foreground">
                                {t('review.step')} {currentStepIndex + 1} {t('review.of')} {steps.length}
                            </span>
                        </div>
                        <div className="h-2 bg-muted rounded-full overflow-hidden">
                            <div
                                className="h-full bg-primary transition-all duration-500 ease-in-out"
                                style={{ width: `${progress}%` }}
                            />
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto pr-2">
                        {renderStepContent()}
                    </div>

                    {currentStep !== 'intro' && currentStep !== 'completed' && (
                        <div className="flex justify-between pt-4 border-t border-border mt-6">
                            <button
                                onClick={prevStep}
                                className="px-4 py-2 text-muted-foreground hover:text-foreground transition-colors"
                            >
                                {t('review.back')}
                            </button>
                            <button
                                onClick={nextStep}
                                className="bg-primary text-primary-foreground px-6 py-2 rounded-md hover:bg-primary/90 transition-colors"
                            >
                                {t('review.nextStepBtn')}
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

type DailyReviewStep = 'intro' | 'today' | 'focus' | 'inbox' | 'waiting' | 'completed';

function isSameDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function DailyReviewGuideModal({ onClose }: { onClose: () => void }) {
    const [currentStep, setCurrentStep] = useState<DailyReviewStep>('intro');
    const { tasks, projects, areas, settings, addProject, updateTask, deleteTask } = useTaskStore();
    const { t } = useLanguage();
    const [isProcessing, setIsProcessing] = useState(false);

    const today = new Date();
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const sortBy = (settings?.taskSortBy ?? 'default') as TaskSortBy;

    const projectMap = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);

    const activeTasks = tasks.filter((task) => !task.deletedAt);
    const inboxTasks = useMemo(() => {
        const now = new Date();
        return activeTasks.filter((task) => {
            if (task.status !== 'inbox') return false;
            const start = safeParseDate(task.startTime);
            if (start && start > now) return false;
            return true;
        });
    }, [activeTasks]);
    const focusedTasks = activeTasks.filter((task) => task.isFocusedToday && task.status !== 'done');
    const waitingTasks = useMemo(
        () => sortTasksBy(activeTasks.filter((task) => task.status === 'waiting'), sortBy),
        [activeTasks, sortBy],
    );

    const dueTodayTasks = activeTasks.filter((task) => {
        if (task.status === 'done') return false;
        if (!task.dueDate) return false;
        const due = safeParseDueDate(task.dueDate);
        if (!due) return false;
        return isSameDay(due, today);
    });

    const overdueTasks = activeTasks.filter((task) => {
        if (task.status === 'done') return false;
        if (!task.dueDate) return false;
        const due = safeParseDueDate(task.dueDate);
        if (!due) return false;
        return due < startOfToday;
    });

    const allContexts = useMemo(() => {
        const taskContexts = tasks.flatMap((task) => task.contexts || []);
        return Array.from(new Set([...PRESET_CONTEXTS, ...taskContexts])).sort();
    }, [tasks]);

    const sequentialProjectIds = useMemo(
        () => new Set(projects.filter((project) => project.isSequential && !project.deletedAt).map((project) => project.id)),
        [projects],
    );
    const sequentialFirstTaskIds = useMemo(() => {
        const tasksByProject = new Map<string, Task[]>();
        activeTasks.forEach((task) => {
            if (task.status !== 'next' || !task.projectId) return;
            if (!sequentialProjectIds.has(task.projectId)) return;
            const list = tasksByProject.get(task.projectId) ?? [];
            list.push(task);
            tasksByProject.set(task.projectId, list);
        });
        const firstIds: string[] = [];
        tasksByProject.forEach((tasksForProject) => {
            const hasOrder = tasksForProject.some((task) => Number.isFinite(task.orderNum));
            let firstTask: Task | null = null;
            let bestKey = Number.POSITIVE_INFINITY;
            tasksForProject.forEach((task) => {
                const key = hasOrder
                    ? (Number.isFinite(task.orderNum) ? (task.orderNum as number) : Number.POSITIVE_INFINITY)
                    : new Date(task.createdAt).getTime();
                if (!firstTask || key < bestKey) {
                    firstTask = task;
                    bestKey = key;
                }
            });
            if (firstTask) firstIds.push(firstTask.id);
        });
        return new Set(firstIds);
    }, [activeTasks, sequentialProjectIds]);

    const focusCandidates = useMemo(() => {
        const now = new Date();
        const todayStr = now.toDateString();
        const byId = new Map<string, Task>();
        const addCandidate = (task: Task) => {
            if (!byId.has(task.id)) byId.set(task.id, task);
        };
        activeTasks.forEach((task) => {
            if (task.status === 'done') return;
            if (task.isFocusedToday) addCandidate(task);
            const due = task.dueDate ? safeParseDueDate(task.dueDate) : null;
            if (due && (due < now || due.toDateString() === todayStr)) {
                addCandidate(task);
                return;
            }
            if (task.status === 'next') {
                const start = safeParseDate(task.startTime);
                if (start && start > now) return;
                if (task.projectId && sequentialProjectIds.has(task.projectId) && !sequentialFirstTaskIds.has(task.id)) {
                    return;
                }
                addCandidate(task);
                return;
            }
            if ((task.status === 'waiting' || task.status === 'someday') && isDueForReview(task.reviewAt, now)) {
                addCandidate(task);
            }
        });
        return sortTasksBy(Array.from(byId.values()), sortBy);
    }, [activeTasks, sequentialFirstTaskIds, sequentialProjectIds, sortBy]);

    useEffect(() => {
        if (currentStep !== 'inbox' && isProcessing) {
            setIsProcessing(false);
        }
    }, [currentStep, isProcessing]);

    const steps: { id: DailyReviewStep; title: string; description: string; icon: LucideIcon }[] = [
        { id: 'intro', title: t('dailyReview.title'), description: t('dailyReview.introDesc'), icon: RefreshCw },
        { id: 'today', title: t('dailyReview.todayStep'), description: t('dailyReview.todayDesc'), icon: Calendar },
        { id: 'focus', title: t('dailyReview.focusStep'), description: t('dailyReview.focusDesc'), icon: CheckSquare },
        { id: 'inbox', title: t('dailyReview.inboxStep'), description: t('dailyReview.inboxDesc'), icon: CheckSquare },
        { id: 'waiting', title: t('dailyReview.waitingStep'), description: t('dailyReview.waitingDesc'), icon: ArrowRight },
        { id: 'completed', title: t('dailyReview.completeTitle'), description: t('dailyReview.completeDesc'), icon: Check },
    ];

    const currentStepIndex = steps.findIndex((s) => s.id === currentStep);
    const progress = ((currentStepIndex) / (steps.length - 1)) * 100;

    const nextStep = () => {
        if (currentStepIndex < steps.length - 1) {
            setCurrentStep(steps[currentStepIndex + 1].id);
        }
    };

    const prevStep = () => {
        if (currentStepIndex > 0) {
            setCurrentStep(steps[currentStepIndex - 1].id);
        }
    };

    const renderTaskList = (list: Task[], emptyText: string) => {
        if (list.length === 0) {
            return (
                <div className="text-center py-12 text-muted-foreground">
                    <p>{emptyText}</p>
                </div>
            );
        }
        return (
            <div className="space-y-2">
                {list.slice(0, 10).map((task) => (
                    <TaskItem key={task.id} task={task} />
                ))}
            </div>
        );
    };

    const renderFocusList = () => {
        if (focusCandidates.length === 0) {
            return (
                <div className="text-center py-12 text-muted-foreground">
                    <p>{t('agenda.focusHint')}</p>
                </div>
            );
        }
        const focusedCount = focusedTasks.length;
        return (
            <div className="space-y-2">
                {focusCandidates.slice(0, 10).map((task) => {
                    const project = task.projectId ? projectMap.get(task.projectId) : null;
                    const canFocus = task.isFocusedToday || focusedCount < 3;
                    return (
                        <div
                            key={task.id}
                            className={cn(
                                "bg-card border rounded-lg px-4 py-3 flex items-center gap-3",
                                task.isFocusedToday && "border-yellow-500/70 bg-amber-500/10"
                            )}
                        >
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                    {task.isFocusedToday && <Star className="w-4 h-4 text-yellow-500 fill-yellow-500" />}
                                    <span className={cn("font-medium truncate", task.status === 'done' && "line-through text-muted-foreground")}>
                                        {task.title}
                                    </span>
                                </div>
                                <div className="flex flex-wrap items-center gap-2 mt-2 text-xs text-muted-foreground">
                                    {task.status && (
                                        <span className="px-2 py-0.5 rounded-full bg-muted/60 text-foreground">
                                            {t(`status.${task.status}`)}
                                        </span>
                                    )}
                                    {project && (
                                        <span className="px-2 py-0.5 rounded-full bg-muted/60 text-foreground">
                                            {project.title}
                                        </span>
                                    )}
                                    {task.contexts?.length ? (
                                        <span className="truncate">
                                            {task.contexts.slice(0, 2).join(', ')}
                                        </span>
                                    ) : null}
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => {
                                    if (task.isFocusedToday) {
                                        updateTask(task.id, { isFocusedToday: false });
                                    } else if (focusedCount < 3) {
                                        updateTask(task.id, { isFocusedToday: true });
                                    }
                                }}
                                disabled={!canFocus}
                                className={cn(
                                    "p-2 rounded-full border transition-colors",
                                    task.isFocusedToday
                                        ? "border-yellow-500 text-yellow-500 bg-yellow-500/10"
                                        : canFocus
                                            ? "border-border text-muted-foreground hover:text-foreground hover:bg-muted/50"
                                            : "border-border text-muted-foreground/50 cursor-not-allowed"
                                )}
                                aria-label={task.isFocusedToday ? t('agenda.removeFromFocus') : t('agenda.addToFocus')}
                                title={task.isFocusedToday ? t('agenda.removeFromFocus') : focusedCount >= 3 ? t('agenda.maxFocusItems') : t('agenda.addToFocus')}
                            >
                                <Star className={cn("w-4 h-4", task.isFocusedToday && "fill-current")} />
                            </button>
                        </div>
                    );
                })}
            </div>
        );
    };

    const renderStepContent = () => {
        switch (currentStep) {
            case 'intro':
                return (
                    <div className="text-center space-y-6 py-12">
                        <div className="w-20 h-20 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-6">
                            <RefreshCw className="w-10 h-10 text-primary" />
                        </div>
                        <h2 className="text-3xl font-bold">{t('dailyReview.introTitle')}</h2>
                        <p className="text-muted-foreground text-lg max-w-md mx-auto">{t('dailyReview.introDesc')}</p>
                        <button
                            onClick={nextStep}
                            className="bg-primary text-primary-foreground px-8 py-3 rounded-lg text-lg font-medium hover:bg-primary/90 transition-colors"
                        >
                            {t('dailyReview.start')}
                        </button>
                    </div>
                );

            case 'today': {
                const list = [...overdueTasks, ...dueTodayTasks];
                return (
                    <div className="space-y-4">
                        <div className="bg-muted/30 p-4 rounded-lg border border-border">
                            <h3 className="font-semibold mb-2">{t('dailyReview.todayStep')}</h3>
                            <p className="text-sm text-muted-foreground">{t('dailyReview.todayDesc')}</p>
                            <p className="text-sm text-muted-foreground mt-2">
                                <span className="font-bold text-foreground">{list.length}</span> {t('common.tasks')}
                            </p>
                        </div>
                        {renderTaskList(list, t('agenda.noTasks'))}
                    </div>
                );
            }

            case 'focus':
                return (
                    <div className="space-y-4">
                        <div className="bg-muted/30 p-4 rounded-lg border border-border">
                            <h3 className="font-semibold mb-2">{t('dailyReview.focusStep')}</h3>
                            <p className="text-sm text-muted-foreground">{t('dailyReview.focusDesc')}</p>
                            <p className="text-sm text-muted-foreground mt-2">
                                <span className="font-bold text-foreground">{focusedTasks.length}</span> / 3
                            </p>
                        </div>
                        {renderFocusList()}
                    </div>
                );

            case 'inbox':
                return (
                    <div className="space-y-4">
                        <div className="bg-muted/30 p-4 rounded-lg border border-border">
                            <h3 className="font-semibold mb-2">{t('dailyReview.inboxStep')}</h3>
                            <p className="text-sm text-muted-foreground">{t('dailyReview.inboxDesc')}</p>
                            <p className="text-sm text-muted-foreground mt-2">
                                <span className="font-bold text-foreground">{inboxTasks.length}</span> {t('common.tasks')}
                            </p>
                        </div>
                        <InboxProcessor
                            t={t}
                            isInbox
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
                        {renderTaskList(inboxTasks, t('review.inboxEmpty'))}
                    </div>
                );

            case 'waiting':
                return (
                    <div className="space-y-4">
                        <div className="bg-muted/30 p-4 rounded-lg border border-border">
                            <h3 className="font-semibold mb-2">{t('dailyReview.waitingStep')}</h3>
                            <p className="text-sm text-muted-foreground">{t('dailyReview.waitingDesc')}</p>
                            <p className="text-sm text-muted-foreground mt-2">
                                <span className="font-bold text-foreground">{waitingTasks.length}</span> {t('common.tasks')}
                            </p>
                        </div>
                        {renderTaskList(waitingTasks, t('review.waitingEmpty'))}
                    </div>
                );

            case 'completed':
                return (
                    <div className="text-center space-y-6 py-12">
                        <div className="w-20 h-20 bg-green-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
                            <Check className="w-10 h-10 text-green-600" />
                        </div>
                        <h2 className="text-3xl font-bold">{t('dailyReview.completeTitle')}</h2>
                        <p className="text-muted-foreground text-lg max-w-md mx-auto">{t('dailyReview.completeDesc')}</p>
                        <button
                            onClick={onClose}
                            className="bg-primary text-primary-foreground px-8 py-3 rounded-lg text-lg font-medium hover:bg-primary/90 transition-colors"
                        >
                            {t('review.finish')}
                        </button>
                    </div>
                );
        }
    };

    return (
        <div
            className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
            role="button"
            tabIndex={0}
            aria-label={t('common.close')}
            onClick={onClose}
            onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onClose();
                }
            }}
        >
            <div
                className="bg-card border border-border rounded-lg shadow-xl max-w-4xl w-full mx-4 max-h-[85vh] flex flex-col"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="p-6 border-b border-border flex items-center justify-between">
                    <h3 className="text-xl font-semibold flex items-center gap-2">
                        <Calendar className="w-5 h-5 text-primary" />
                        {t('dailyReview.title')}
                    </h3>
                    <button
                        onClick={onClose}
                        className="p-2 rounded-md hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors"
                        aria-label={t('common.close')}
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="p-6 flex flex-col flex-1 min-h-0">
                    <div className="mb-6">
                        <div className="flex items-center justify-between mb-3">
                            <h1 className="text-2xl font-bold flex items-center gap-2">
                                {(() => {
                                    const Icon = steps[currentStepIndex].icon;
                                    return Icon && <Icon className="w-6 h-6" />;
                                })()}
                                {steps[currentStepIndex].title}
                            </h1>
                            <span className="text-sm text-muted-foreground">
                                {t('review.step')} {currentStepIndex + 1} {t('review.of')} {steps.length}
                            </span>
                        </div>
                        <div className="h-2 bg-muted rounded-full overflow-hidden">
                            <div
                                className="h-full bg-primary transition-all duration-500 ease-in-out"
                                style={{ width: `${progress}%` }}
                            />
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto pr-2">
                        {renderStepContent()}
                    </div>

                    {currentStep !== 'intro' && currentStep !== 'completed' && (
                        <div className="flex justify-between pt-4 border-t border-border mt-6">
                            <button
                                onClick={prevStep}
                                className="px-4 py-2 text-muted-foreground hover:text-foreground transition-colors"
                            >
                                {t('review.back')}
                            </button>
                            <button
                                onClick={nextStep}
                                className="bg-primary text-primary-foreground px-6 py-2 rounded-md hover:bg-primary/90 transition-colors"
                            >
                                {t('review.nextStepBtn')}
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

export function ReviewView() {
    const { tasks, projects, settings, batchMoveTasks, batchDeleteTasks, batchUpdateTasks } = useTaskStore();
    const { t } = useLanguage();
    const [filterStatus, setFilterStatus] = useState<TaskStatus | 'all'>('all');
    const [selectionMode, setSelectionMode] = useState(false);
    const [multiSelectedIds, setMultiSelectedIds] = useState<Set<string>>(new Set());
    const [tagPromptOpen, setTagPromptOpen] = useState(false);
    const [tagPromptIds, setTagPromptIds] = useState<string[]>([]);
    const [showGuide, setShowGuide] = useState(false);
    const [showDailyGuide, setShowDailyGuide] = useState(false);
    const [moveToStatus, setMoveToStatus] = useState<TaskStatus | ''>('');

    const sortBy = (settings?.taskSortBy ?? 'default') as TaskSortBy;

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

    const activeTasks = useMemo(() => {
        return tasks.filter((t) => !t.deletedAt);
    }, [tasks]);

    const statusOptions: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'done'];

    const statusCounts = useMemo(() => {
        const counts: Record<string, number> = { all: activeTasks.length };
        for (const status of statusOptions) {
            counts[status] = activeTasks.filter((t) => t.status === status).length;
        }
        return counts;
    }, [activeTasks]);

    const filteredTasks = useMemo(() => {
        const list = filterStatus === 'all' ? activeTasks : activeTasks.filter((t) => t.status === filterStatus);
        return sortTasksBy(list, sortBy);
    }, [activeTasks, filterStatus, sortBy]);

    const selectedIdsArray = useMemo(() => Array.from(multiSelectedIds), [multiSelectedIds]);

    const bulkStatuses: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'done'];

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

    return (
        <>
        <div className="space-y-6">
            <header className="flex items-center justify-between">
                <div className="space-y-1">
                    <h2 className="text-3xl font-bold tracking-tight">
                        {t('review.title')}
                    </h2>
                    <p className="text-sm text-muted-foreground">
                        {filteredTasks.length} {t('common.tasks')}
                    </p>
                </div>
                <div className="flex items-center gap-3">
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
                        onClick={() => setShowDailyGuide(true)}
                        className="bg-muted/50 text-foreground px-4 py-2 rounded-md hover:bg-muted transition-colors"
                    >
                        {t('dailyReview.title')}
                    </button>
                    <button
                        onClick={() => setShowGuide(true)}
                        className="bg-primary text-primary-foreground px-4 py-2 rounded-md hover:bg-primary/90 transition-colors"
                    >
                        {t('review.openGuide')}
                    </button>
                </div>
            </header>

            <div className="flex items-center gap-2 overflow-x-auto pb-1">
                <button
                    onClick={() => setFilterStatus('all')}
                    className={cn(
                        "px-3 py-1.5 text-sm rounded-full border transition-colors whitespace-nowrap shrink-0",
                        filterStatus === 'all'
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground"
                    )}
                >
                    {t('common.all')} ({statusCounts.all})
                </button>
                {statusOptions.map((status) => (
                    <button
                        key={status}
                        onClick={() => setFilterStatus(status)}
                        className={cn(
                            "px-3 py-1.5 text-sm rounded-full border transition-colors whitespace-nowrap shrink-0",
                            filterStatus === status
                                ? "bg-primary text-primary-foreground border-primary"
                                : "bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground"
                        )}
                    >
                        {t(`status.${status}`)} ({statusCounts[status]})
                    </button>
                ))}
            </div>

            {selectionMode && selectedIdsArray.length > 0 && (
                <div className="flex flex-wrap items-center gap-3 bg-card border border-border rounded-lg p-3">
                    <div className="flex items-center gap-3">
                        <span className="text-sm text-muted-foreground">
                            {selectedIdsArray.length} {t('bulk.selected')}
                        </span>
                        <div className="flex items-center gap-2">
                            <label htmlFor="review-bulk-move" className="text-xs text-muted-foreground">
                                {t('bulk.moveTo')}
                            </label>
                            <select
                                id="review-bulk-move"
                                value={moveToStatus}
                                onChange={async (e) => {
                                    const nextStatus = e.target.value as TaskStatus;
                                    setMoveToStatus(nextStatus);
                                    await handleBatchMove(nextStatus);
                                }}
                                className="text-xs bg-muted/50 text-foreground border border-border rounded px-2 py-1 hover:bg-muted transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40"
                            >
                                <option value="" disabled>
                                    {t('bulk.moveTo')}
                                </option>
                                {bulkStatuses.map((status) => (
                                    <option key={status} value={status}>
                                        {t(`status.${status}`)}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
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
                </div>
            )}

            <div className="space-y-3">
                {filteredTasks.length === 0 ? (
                    <div className="text-center py-12 text-muted-foreground">
                        <p>{t('review.noTasks')}</p>
                    </div>
                ) : (
                    filteredTasks.map((task) => (
                        <TaskItem
                            key={task.id}
                            task={task}
                            project={task.projectId ? projectMap[task.projectId] : undefined}
                            selectionMode={selectionMode}
                            isMultiSelected={multiSelectedIds.has(task.id)}
                            onToggleSelect={() => toggleMultiSelect(task.id)}
                        />
                    ))
                )}
            </div>

            {showGuide && (
                <WeeklyReviewGuideModal onClose={() => setShowGuide(false)} />
            )}

            {showDailyGuide && (
                <DailyReviewGuideModal onClose={() => setShowDailyGuide(false)} />
            )}
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
