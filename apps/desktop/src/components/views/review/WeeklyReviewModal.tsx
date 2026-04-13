import { useEffect, useMemo, useState } from 'react';
import {
    createAIProvider,
    DEFAULT_AREA_COLOR,
    getStaleItems,
    isDueForReview,
    safeFormatDate,
    safeParseDate,
    safeParseDueDate,
    shallow,
    type ExternalCalendarEvent,
    type ReviewSuggestion,
    useTaskStore,
    type Task,
    type TaskStatus,
    type AIProviderId,
} from '@mindwtr/core';
import { Archive, ArrowRight, Calendar, Check, CheckSquare, ChevronLeft, Layers, MapPin, RefreshCw, Sparkles, X, type LucideIcon } from 'lucide-react';

import { TaskItem } from '../../TaskItem';
import { PromptModal } from '../../PromptModal';
import { cn } from '../../../lib/utils';
import { useLanguage } from '../../../contexts/language-context';
import { buildAIConfig, isAIKeyRequired, loadAIKey } from '../../../lib/ai-config';
import { fetchExternalCalendarEvents, summarizeExternalCalendarWarnings } from '../../../lib/external-calendar-events';

type ReviewStep = 'inbox' | 'ai' | 'calendar' | 'waiting' | 'contexts' | 'projects' | 'someday' | 'completed';
type CalendarReviewEntry = {
    task: Task;
    date: Date;
    kind: 'due' | 'start';
};
type ContextReviewGroup = {
    context: string;
    tasks: Task[];
};
type ExternalCalendarDaySummary = {
    dayStart: Date;
    events: ExternalCalendarEvent[];
    totalCount: number;
};

type WeeklyReviewGuideModalProps = {
    onClose: () => void;
};

export function WeeklyReviewGuideModal({ onClose }: WeeklyReviewGuideModalProps) {
    const [currentStep, setCurrentStep] = useState<ReviewStep>('inbox');
    const [expandedExternalDays, setExpandedExternalDays] = useState<Set<string>>(new Set());
    const [expandedContextGroups, setExpandedContextGroups] = useState<Set<string>>(new Set());
    const [projectTaskPrompt, setProjectTaskPrompt] = useState<{ projectId: string; projectTitle: string } | null>(null);
    const { tasks, projects, areas, settings, batchUpdateTasks } = useTaskStore(
        (state) => ({
            tasks: state.tasks,
            projects: state.projects,
            areas: state.areas,
            settings: state.settings,
            batchUpdateTasks: state.batchUpdateTasks,
        }),
        shallow
    );
    const addTask = useTaskStore((state) => state.addTask);
    const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
    const { t } = useLanguage();
    const [aiSuggestions, setAiSuggestions] = useState<ReviewSuggestion[]>([]);
    const [aiSelectedIds, setAiSelectedIds] = useState<Set<string>>(new Set());
    const [aiLoading, setAiLoading] = useState(false);
    const [aiError, setAiError] = useState<string | null>(null);
    const [aiRan, setAiRan] = useState(false);
    const [externalCalendarEvents, setExternalCalendarEvents] = useState<ExternalCalendarEvent[]>([]);
    const [externalCalendarLoading, setExternalCalendarLoading] = useState(false);
    const [externalCalendarError, setExternalCalendarError] = useState<string | null>(null);

    const aiEnabled = settings?.ai?.enabled === true;
    const includeContextStep = settings?.gtd?.weeklyReview?.includeContextStep !== false;
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
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const upcomingEnd = new Date(startOfToday);
        upcomingEnd.setDate(upcomingEnd.getDate() + 7);
        const entries: CalendarReviewEntry[] = [];

        tasks.forEach((task) => {
            if (task.deletedAt) return;
            if (task.status === 'done' || task.status === 'archived' || task.status === 'reference') return;
            const dueDate = safeParseDueDate(task.dueDate);
            if (dueDate) entries.push({ task, date: dueDate, kind: 'due' });
            const startTime = safeParseDate(task.startTime);
            if (startTime) entries.push({ task, date: startTime, kind: 'start' });
        });

        const upcoming = entries
            .filter((entry) => entry.date >= startOfToday && entry.date < upcomingEnd)
            .sort((a, b) => a.date.getTime() - b.date.getTime());

        return upcoming;
    }, [tasks]);
    const externalCalendarReviewItems = useMemo<ExternalCalendarDaySummary[]>(() => {
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const summaries: ExternalCalendarDaySummary[] = [];
        for (let offset = 0; offset < 7; offset += 1) {
            const dayStart = new Date(startOfToday);
            dayStart.setDate(dayStart.getDate() + offset);
            const dayEnd = new Date(dayStart);
            dayEnd.setDate(dayEnd.getDate() + 1);
            const dayEvents = externalCalendarEvents
                .filter((event) => {
                    const start = safeParseDate(event.start);
                    const end = safeParseDate(event.end);
                    if (!start || !end) return false;
                    return start.getTime() < dayEnd.getTime() && end.getTime() > dayStart.getTime();
                })
                .sort((a, b) => {
                    const aStart = safeParseDate(a.start)?.getTime() ?? Number.POSITIVE_INFINITY;
                    const bStart = safeParseDate(b.start)?.getTime() ?? Number.POSITIVE_INFINITY;
                    return aStart - bStart;
                });
            if (dayEvents.length > 0) {
                summaries.push({
                    dayStart,
                    events: dayEvents,
                    totalCount: dayEvents.length,
                });
            }
        }
        return summaries;
    }, [externalCalendarEvents]);
    const contextReviewGroups = useMemo<ContextReviewGroup[]>(() => {
        const groups = new Map<string, Task[]>();
        tasks.forEach((task) => {
            if (task.deletedAt) return;
            if (task.status === 'done' || task.status === 'archived' || task.status === 'reference') return;
            (task.contexts ?? []).forEach((contextValue) => {
                const normalized = contextValue.trim();
                if (!normalized) return;
                const existing = groups.get(normalized) ?? [];
                existing.push(task);
                groups.set(normalized, existing);
            });
        });
        return Array.from(groups.entries())
            .map(([context, contextTasks]) => ({
                context,
                tasks: contextTasks.sort((a, b) => a.title.localeCompare(b.title)),
            }))
            .sort((a, b) => (b.tasks.length - a.tasks.length) || a.context.localeCompare(b.context));
    }, [tasks]);

    const steps = useMemo<{ id: ReviewStep; title: string; description: string; icon: LucideIcon }[]>(() => {
        const list: { id: ReviewStep; title: string; description: string; icon: LucideIcon }[] = [
            { id: 'inbox', title: t('review.inboxStep'), description: t('review.inboxStepDesc'), icon: CheckSquare },
        ];
        if (aiEnabled) {
            list.push({ id: 'ai', title: t('review.aiStep'), description: t('review.aiStepDesc'), icon: Sparkles });
        }
        list.push(
            { id: 'calendar', title: t('review.calendarStep'), description: t('review.calendarStepDesc'), icon: Calendar },
            { id: 'waiting', title: t('review.waitingStep'), description: t('review.waitingStepDesc'), icon: ArrowRight },
        );
        if (includeContextStep) {
            list.push({ id: 'contexts', title: t('review.contexts'), description: t('review.contextsStepDesc'), icon: MapPin });
        }
        list.push(
            { id: 'projects', title: t('review.projectsStep'), description: t('review.projectsStepDesc'), icon: Layers },
            { id: 'someday', title: t('review.somedayStep'), description: t('review.somedayStepDesc'), icon: Archive },
            { id: 'completed', title: t('review.allDone'), description: t('review.allDoneDesc'), icon: Check },
        );
        return list;
    }, [aiEnabled, includeContextStep, t]);

    const currentStepIndex = steps.findIndex((step) => step.id === currentStep);
    const safeStepIndex = currentStepIndex >= 0 ? currentStepIndex : 0;
    const progress = (safeStepIndex / Math.max(1, steps.length - 1)) * 100;

    useEffect(() => {
        if (!steps.some((step) => step.id === currentStep)) {
            setCurrentStep(steps[0].id);
        }
    }, [currentStep, steps]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onClose]);

    useEffect(() => {
        let cancelled = false;
        const loadCalendar = async () => {
            setExternalCalendarLoading(true);
            setExternalCalendarError(null);
            try {
                const now = new Date();
                const rangeStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                const rangeEnd = new Date(rangeStart);
                rangeEnd.setDate(rangeEnd.getDate() + 7);
                rangeEnd.setMilliseconds(-1);
                const { events, warnings } = await fetchExternalCalendarEvents(rangeStart, rangeEnd);
                if (cancelled) return;
                setExternalCalendarEvents(events);
                setExternalCalendarError(summarizeExternalCalendarWarnings(warnings));
            } catch (error) {
                if (cancelled) return;
                setExternalCalendarError(error instanceof Error ? error.message : String(error));
                setExternalCalendarEvents([]);
            } finally {
                if (!cancelled) setExternalCalendarLoading(false);
            }
        };
        loadCalendar();
        return () => {
            cancelled = true;
        };
    }, []);

    const nextStep = () => {
        if (currentStepIndex < 0) {
            setCurrentStep(steps[0].id);
            return;
        }
        if (currentStepIndex < steps.length - 1) {
            setCurrentStep(steps[currentStepIndex + 1].id);
        }
    };

    const prevStep = () => {
        if (currentStepIndex < 0) {
            setCurrentStep(steps[0].id);
            return;
        }
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
        if (isAIKeyRequired(settings) && !apiKey) {
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

    const openQuickAdd = (initialProps?: Partial<Task>) => {
        window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
            detail: { initialProps: initialProps ?? {} },
        }));
    };

    const toggleExternalDayExpanded = (dayKey: string) => {
        setExpandedExternalDays((prev) => {
            const next = new Set(prev);
            if (next.has(dayKey)) {
                next.delete(dayKey);
            } else {
                next.add(dayKey);
            }
            return next;
        });
    };

    const toggleContextGroupExpanded = (contextKey: string) => {
        setExpandedContextGroups((prev) => {
            const next = new Set(prev);
            if (next.has(contextKey)) {
                next.delete(contextKey);
            } else {
                next.add(contextKey);
            }
            return next;
        });
    };

    const renderCalendarList = (items: CalendarReviewEntry[]) => {
        if (items.length === 0) {
            return <div className="text-sm text-muted-foreground">{t('calendar.noTasks')}</div>;
        }
        return (
            <div className="space-y-2">
                {items.slice(0, 12).map((entry) => (
                    <div key={`${entry.kind}-${entry.task.id}-${entry.date.toISOString()}`} className="flex items-start gap-3 text-sm">
                        <div className="min-w-0">
                            <div className="font-medium truncate">{entry.task.title}</div>
                            <div className="text-xs text-muted-foreground">
                                {(entry.kind === 'due' ? t('taskEdit.dueDateLabel') : t('review.startTime'))}
                                {' / '}
                                {safeFormatDate(entry.date, 'Pp')}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        );
    };
    const renderExternalCalendarList = (days: ExternalCalendarDaySummary[]) => {
        if (externalCalendarLoading) {
            return <div className="text-sm text-muted-foreground">{t('common.loading')}</div>;
        }
        if (externalCalendarError) {
            return <div className="text-sm text-muted-foreground">{externalCalendarError}</div>;
        }
        if (days.length === 0) {
            return <div className="text-sm text-muted-foreground">{t('calendar.noTasks')}</div>;
        }
        return (
            <div className="space-y-2">
                {days.map((day) => (
                    <div key={day.dayStart.toISOString()} className="rounded-md border border-border/70 p-2.5">
                        {(() => {
                            const dayKey = day.dayStart.toISOString();
                            const isExpanded = expandedExternalDays.has(dayKey);
                            const visibleEvents = isExpanded ? day.events : day.events.slice(0, 2);
                            return (
                                <>
                        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                            {safeFormatDate(day.dayStart, 'EEEE, PP')} · {day.totalCount} {t('calendar.events')}
                        </div>
                        <div className="mt-1.5 space-y-1">
                            {visibleEvents.map((event) => {
                                const start = safeParseDate(event.start);
                                const timeLabel = event.allDay || !start ? t('calendar.allDay') : safeFormatDate(start, 'p');
                                return (
                                    <div key={`${event.sourceId}-${event.id}-${event.start}`} className="text-sm flex gap-2">
                                        <span className="text-muted-foreground w-12 shrink-0">{timeLabel}</span>
                                        <span className="font-medium truncate">{event.title}</span>
                                    </div>
                                );
                            })}
                            {day.totalCount > 2 && (
                                <button
                                    type="button"
                                    onClick={() => toggleExternalDayExpanded(dayKey)}
                                    className="text-xs text-primary hover:text-primary/80 font-medium"
                                >
                                    {isExpanded
                                        ? t('common.less')
                                        : `+${day.totalCount - visibleEvents.length} ${t('common.more').toLowerCase()}`}
                                </button>
                            )}
                        </div>
                                </>
                            );
                        })()}
                    </div>
                ))}
            </div>
        );
    };

    const renderStepContent = () => {
        switch (currentStep) {
            case 'inbox': {
                const inboxTasks = tasks.filter((task) => task.status === 'inbox');
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
                                inboxTasks.map((task) => (
                                    <TaskItem key={task.id} task={task} showProjectBadgeInActions={false} />
                                ))
                            )}
                        </div>
                    </div>
                );
            }

            case 'calendar':
                return (
                    <div className="space-y-6">
                        <div className="flex justify-end">
                            <button
                                type="button"
                                onClick={() => openQuickAdd({ status: 'inbox' })}
                                className="px-3 py-1.5 rounded-md border border-border text-sm text-foreground hover:bg-muted/40 transition-colors"
                            >
                                {t('calendar.addTask')}
                            </button>
                        </div>
                        <div className="space-y-2">
                            <h3 className="font-semibold text-muted-foreground uppercase text-xs tracking-wider">
                                {t('calendar.events')}
                            </h3>
                            <p className="text-xs text-muted-foreground">{t('review.calendarStepDesc')}</p>
                            <div className="bg-card border border-border rounded-lg p-4 min-h-[200px] space-y-3">
                                {renderExternalCalendarList(externalCalendarReviewItems)}
                            </div>
                        </div>
                        <div className="space-y-2">
                            <h3 className="font-semibold text-muted-foreground uppercase text-xs tracking-wider">
                                {t('review.calendarStep')}
                            </h3>
                            <p className="text-xs text-muted-foreground">{t('review.upcoming14Desc')}</p>
                        </div>
                        <div className="bg-card border border-border rounded-lg p-4 min-h-[200px] space-y-3">
                            {renderCalendarList(calendarReviewItems)}
                        </div>
                    </div>
                );

            case 'waiting': {
                const waitingTasks = tasks.filter((task) => task.status === 'waiting');
                const waitingDue = waitingTasks.filter((task) => isDueForReview(task.reviewAt));
                const waitingFuture = waitingTasks.filter((task) => !isDueForReview(task.reviewAt));
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
                                    {waitingDue.length > 0 && waitingDue.map((task) => (
                                        <TaskItem key={task.id} task={task} showProjectBadgeInActions={false} />
                                    ))}
                                    {waitingFuture.length > 0 && (
                                        <div className="pt-4">
                                            <h4 className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
                                                {t('review.notDueYet')}
                                            </h4>
                                            {waitingFuture.map((task) => (
                                                <TaskItem key={task.id} task={task} showProjectBadgeInActions={false} />
                                            ))}
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                );
            }
            case 'contexts': {
                return (
                    <div className="space-y-4">
                        <p className="text-muted-foreground">{t('review.contextsStepDesc')}</p>
                        {contextReviewGroups.length === 0 ? (
                            <div className="text-center py-12 text-muted-foreground">
                                <p>{t('review.contextsEmpty')}</p>
                            </div>
                        ) : (
                            contextReviewGroups.map((group) => (
                                <div key={group.context} className="border border-border rounded-lg p-4 space-y-2">
                                    <div className="flex items-center justify-between">
                                        <h3 className="font-semibold">{group.context}</h3>
                                        <span className="text-xs text-muted-foreground">{group.tasks.length}</span>
                                    </div>
                                    <div className="space-y-1.5">
                                        {(() => {
                                            const contextKey = group.context;
                                            const isExpanded = expandedContextGroups.has(contextKey);
                                            const visibleTasks = isExpanded ? group.tasks : group.tasks.slice(0, 4);
                                            return (
                                                <>
                                                    {visibleTasks.map((task) => (
                                                        <TaskItem key={`${group.context}-${task.id}`} task={task} showProjectBadgeInActions={false} />
                                                    ))}
                                                    {group.tasks.length > 4 && (
                                                        <button
                                                            type="button"
                                                            onClick={() => toggleContextGroupExpanded(contextKey)}
                                                            className="text-xs text-primary hover:text-primary/80 font-medium"
                                                        >
                                                            {isExpanded
                                                                ? t('common.less')
                                                                : `+${group.tasks.length - visibleTasks.length} ${t('common.more').toLowerCase()}`}
                                                        </button>
                                                    )}
                                                </>
                                            );
                                        })()}
                                    </div>
                                </div>
                            ))
                        )}
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
                                className="bg-primary text-primary-foreground px-3 py-1.5 rounded-md text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
                                                            : "border-border text-muted-foreground",
                                                    )}
                                                    aria-pressed={aiSelectedIds.has(suggestion.id)}
                                                >
                                                    {aiSelectedIds.has(suggestion.id) ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
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
                                        className="bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
                const activeProjects = projects.filter((project) => project.status === 'active');
                const dueProjects = activeProjects.filter((project) => isDueForReview(project.reviewAt));
                const futureProjects = activeProjects.filter((project) => !isDueForReview(project.reviewAt));
                const orderedProjects = [...dueProjects, ...futureProjects];
                return (
                    <div className="space-y-6">
                        <p className="text-muted-foreground">{t('review.projectsHint')}</p>
                        <div className="space-y-4">
                            {orderedProjects.map((project) => {
                                const projectTasks = tasks.filter((task) => task.projectId === project.id && task.status !== 'done' && task.status !== 'reference');
                                const hasNextAction = projectTasks.some((task) => task.status === 'next');

                                return (
                                    <div key={project.id} className="border border-border rounded-lg p-4">
                                        <div className="flex items-center justify-between gap-3 mb-3">
                                            <div className="flex items-center gap-2">
                                                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: (project.areaId ? areaById.get(project.areaId)?.color : undefined) || DEFAULT_AREA_COLOR }} />
                                                <h3 className="font-semibold">{project.title}</h3>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <button
                                                    type="button"
                                                    onClick={() => setProjectTaskPrompt({ projectId: project.id, projectTitle: project.title })}
                                                    className="px-2.5 py-1 rounded-md border border-border text-xs text-foreground hover:bg-muted/40 transition-colors"
                                                >
                                                    {t('projects.addTask')}
                                                </button>
                                                <div
                                                    className={cn("text-xs px-2 py-1 rounded-full", hasNextAction ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600")}
                                                >
                                                    {hasNextAction ? t('review.hasNextAction') : t('review.needsAction')}
                                                </div>
                                            </div>
                                        </div>
                                        <div className="space-y-2 pl-5">
                                            {projectTasks.map((task) => (
                                                <TaskItem key={task.id} task={task} showProjectBadgeInActions={false} />
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
                const somedayTasks = tasks.filter((task) => task.status === 'someday');
                const somedayDue = somedayTasks.filter((task) => isDueForReview(task.reviewAt));
                const somedayFuture = somedayTasks.filter((task) => !isDueForReview(task.reviewAt));
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
                                    {somedayDue.length > 0 && somedayDue.map((task) => (
                                        <TaskItem key={task.id} task={task} showProjectBadgeInActions={false} />
                                    ))}
                                    {somedayFuture.length > 0 && (
                                        <div className="pt-4">
                                            <h4 className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
                                                {t('review.notDueYet')}
                                            </h4>
                                            {somedayFuture.map((task) => (
                                                <TaskItem key={task.id} task={task} showProjectBadgeInActions={false} />
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
            role="dialog"
            aria-modal="true"
            aria-label={t('review.title')}
            onClick={onClose}
        >
            <div
                className="bg-card border border-border rounded-lg shadow-xl max-w-4xl w-full mx-4 max-h-[85vh] flex flex-col"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="px-5 py-4 border-b border-border flex items-center justify-between">
                    <h3 className="text-[15px] font-semibold flex items-center gap-2.5">
                        <RefreshCw className="w-4 h-4 text-primary" />
                        {t('review.title')}
                    </h3>
                    <button
                        onClick={onClose}
                        className="p-1.5 rounded-md hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors"
                        aria-label={t('common.close')}
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                <div className="p-5 flex flex-col flex-1 min-h-0">
                    <div className="mb-5">
                        <div className="flex items-center justify-between mb-3">
                            <h1 className="text-lg font-semibold flex items-center gap-2">
                                {(() => {
                                    const Icon = steps[safeStepIndex].icon;
                                    return Icon && <Icon className="w-[18px] h-[18px] text-primary" />;
                                })()}
                                {steps[safeStepIndex].title}
                            </h1>
                            <span className="text-xs text-muted-foreground">
                                {t('review.step')} {safeStepIndex + 1} {t('review.of')} {steps.length}
                            </span>
                        </div>
                        <div className="h-1 bg-muted rounded-full overflow-hidden">
                            <div
                                className="h-full bg-primary transition-all duration-500 ease-in-out rounded-full"
                                style={{ width: `${progress}%` }}
                            />
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto pr-2">
                        {renderStepContent()}
                    </div>

                    {currentStep !== 'completed' && (
                        <div className="flex justify-between items-center pt-3.5 border-t border-border mt-5">
                            <button
                                onClick={prevStep}
                                className="flex items-center gap-1.5 px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                            >
                                <ChevronLeft className="w-3.5 h-3.5" /> {t('review.back')}
                            </button>
                            <button
                                onClick={nextStep}
                                className="flex items-center gap-2 bg-primary text-primary-foreground px-5 py-2 rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors"
                            >
                                {t('review.nextStepBtn')} <ArrowRight className="w-3.5 h-3.5" />
                            </button>
                        </div>
                    )}
                </div>
            </div>
            <PromptModal
                isOpen={Boolean(projectTaskPrompt)}
                title={t('projects.addTask')}
                description={projectTaskPrompt ? `${projectTaskPrompt.projectTitle}` : undefined}
                placeholder={t('nav.addTask')}
                defaultValue=""
                confirmLabel={t('common.add')}
                cancelLabel={t('common.cancel')}
                onCancel={() => setProjectTaskPrompt(null)}
                onConfirm={(value) => {
                    const trimmed = value.trim();
                    const targetProject = projectTaskPrompt;
                    if (!trimmed || !targetProject) return;
                    void (async () => {
                        await addTask(trimmed, { projectId: targetProject.projectId, status: 'next' });
                        setProjectTaskPrompt(null);
                    })();
                }}
            />
        </div>
    );
}
