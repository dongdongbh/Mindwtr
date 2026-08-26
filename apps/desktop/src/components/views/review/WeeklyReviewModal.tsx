import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    buildQuickAddParseOptions,
    buildReviewSteps,
    createAIProvider,
    DEFAULT_AREA_COLOR,
    filterReviewSuggestionsToKnownIds,
    formatI18nTemplate,
    getExternalCalendarDaySummaries,
    getUsedTaskTokens,
    getWeeklyReviewBuckets,
    isTaskInActiveProject,
    parseProjectNextActionInput,
    parseStoredReviewStepSession,
    resolveReviewStepSession,
    safeFormatDate,
    safeParseDate,
    shallow,
    type CalendarReviewEntry,
    type ExternalCalendarDaySummary,
    type ExternalCalendarEvent,
    type ReviewSuggestion,
    type StoredReviewStepSession,
    useTaskStore,
    type Project,
    type Task,
    type TaskStatus,
    type AIProviderId,
} from '@mindwtr/core';
import { Archive, ArrowRight, Calendar, Check, CheckSquare, ChevronDown, ChevronLeft, ChevronRight, History, Layers, MapPin, RefreshCw, X, type LucideIcon } from 'lucide-react';

import { TaskItem } from '../../TaskItem';
import { Dialog, DialogHeader } from '../../ui/Dialog';
import { MindSweepLauncher } from '../../MindSweepModal';
import { PromptModal } from '../../PromptModal';
import { InboxProcessor } from '../InboxProcessor';
import { cn } from '../../../lib/utils';
import { useLanguage } from '../../../contexts/language-context';
import { buildAIConfig, isAIKeyRequired, loadAIKey } from '../../../lib/ai-config';
import { fetchExternalCalendarEvents, summarizeExternalCalendarWarnings } from '../../../lib/external-calendar-events';
import { useUiStore } from '../../../store/ui-store';

type ReviewStep = 'inbox' | 'stale' | 'calendar' | 'waiting' | 'contexts' | 'projects' | 'someday' | 'completed';
type ReviewStepDefinition = {
    id: ReviewStep;
    title: string;
    description: string;
    icon: LucideIcon;
    hasWork: boolean;
};
type WeeklyReviewGuideModalProps = {
    onClose: () => void;
};
const WEEKLY_REVIEW_STEP_STORAGE_KEY = 'mindwtr:weeklyReview:currentStep';
const WEEKLY_REVIEW_STEPS = new Set<ReviewStep>([
    'inbox', 'stale', 'calendar', 'waiting', 'contexts', 'projects', 'someday', 'completed',
]);

function SummaryRow({ good, text }: { good: boolean; text: string }) {
    return (
        <div className="flex items-center gap-2.5 text-sm">
            {good
                ? <Check className="w-4 h-4 shrink-0 text-success" />
                : <span className="w-2 h-2 shrink-0 rounded-full bg-warning" aria-hidden="true" />}
            <span className={good ? "text-muted-foreground" : "text-foreground"}>{text}</span>
        </div>
    );
}

export function WeeklyReviewGuideModal({ onClose }: WeeklyReviewGuideModalProps) {
    const [isProcessing, setIsProcessing] = useState(false);
    const [expandedExternalDays, setExpandedExternalDays] = useState<Set<string>>(new Set());
    const [expandedContextGroups, setExpandedContextGroups] = useState<Set<string>>(new Set());
    const [showScheduledWaiting, setShowScheduledWaiting] = useState(false);
    const [showScheduledSomeday, setShowScheduledSomeday] = useState(false);
    const [projectTaskPrompt, setProjectTaskPrompt] = useState<{ projectId: string; projectTitle: string } | null>(null);
    const { tasks, projects, areas, settings, addProject, updateProject, updateTask, deleteTask, batchUpdateTasks } = useTaskStore(
        (state) => ({
            tasks: state.tasks,
            projects: state.projects,
            areas: state.areas,
            settings: state.settings,
            addProject: state.addProject,
            updateProject: state.updateProject,
            updateTask: state.updateTask,
            deleteTask: state.deleteTask,
            batchUpdateTasks: state.batchUpdateTasks,
        }),
        shallow
    );
    const [reviewSession, setReviewSession] = useState<StoredReviewStepSession<ReviewStep>>(() => {
        const now = new Date();
        return parseStoredReviewStepSession(
            window.localStorage.getItem(WEEKLY_REVIEW_STEP_STORAGE_KEY),
            WEEKLY_REVIEW_STEPS,
            { cadence: 'weekly', now, weekStart: settings?.weekStart },
        ) ?? { step: 'inbox', startedAt: now.toISOString() };
    });
    const currentStep = reviewSession.step;
    const setCurrentStep = useCallback((step: ReviewStep) => {
        setReviewSession((session) => ({ ...session, step }));
    }, []);
    const addTask = useTaskStore((state) => state.addTask);
    const showToast = useUiStore((state) => state.showToast);
    const setEditingTaskId = useUiStore((state) => state.setEditingTaskId);
    const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
    const projectMap = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
    const activeTasks = useMemo(
        () => tasks.filter((task) => !task.deletedAt && task.status !== 'reference' && isTaskInActiveProject(task, projectMap)),
        [projectMap, tasks],
    );
    const allContexts = useMemo(() => getUsedTaskTokens(activeTasks, (task) => task.contexts, { prefix: '@' }), [activeTasks]);
    const allTags = useMemo(() => getUsedTaskTokens(activeTasks, (task) => task.tags, { prefix: '#' }), [activeTasks]);
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
    // One core derivation owns every Weekly Review candidate, project-health,
    // stale-item, and completion-summary decision.
    const weeklyBuckets = useMemo(
        () => getWeeklyReviewBuckets(tasks, projects),
        [tasks, projects],
    );
    const staleItems = weeklyBuckets.staleItems;
    const staleItemTitleMap = useMemo(() => {
        return staleItems.reduce((acc, item) => {
            acc[item.id] = item.title;
            return acc;
        }, {} as Record<string, string>);
    }, [staleItems]);
    const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
    const staleTaskEntries = useMemo(() => staleItems
        .filter((item) => !item.id.startsWith('project:'))
        .flatMap((item) => {
            const task = taskById.get(item.id);
            return task ? [{ daysStale: item.daysStale, task }] : [];
        }), [staleItems, taskById]);
    const staleProjectItems = useMemo(
        () => staleItems.filter((item) => item.id.startsWith('project:')),
        [staleItems],
    );
    const inboxTasks = weeklyBuckets.inbox;
    const waitingGroups = weeklyBuckets.waitingGroups;
    const somedayGroups = weeklyBuckets.somedayGroups;
    const projectEntries = weeklyBuckets.projectEntries;
    const contextReviewGroups = weeklyBuckets.contextGroups;
    const calendarReviewItems = weeklyBuckets.calendarItems;
    // Only used for the "nothing waiting/someday at all" empty state; the
    // step content itself renders due+unscheduled and a collapsible
    // "not due yet" section from waitingGroups/somedayGroups directly.
    const waitingTasks = useMemo(
        () => [...waitingGroups.due, ...waitingGroups.scheduled, ...waitingGroups.unscheduled],
        [waitingGroups],
    );
    const somedayTasks = useMemo(
        () => [...somedayGroups.due, ...somedayGroups.scheduled, ...somedayGroups.unscheduled],
        [somedayGroups],
    );
    const externalCalendarReviewItems = useMemo(
        () => getExternalCalendarDaySummaries(externalCalendarEvents),
        [externalCalendarEvents],
    );
    const reviewSummary = weeklyBuckets.summary;

    const stepFlags = useMemo(() => buildReviewSteps(weeklyBuckets, {
        kind: 'weekly',
        includeContextStep,
        externalCalendarDayCount: externalCalendarReviewItems.length,
        externalCalendarHasError: Boolean(externalCalendarError),
    }), [externalCalendarError, externalCalendarReviewItems.length, includeContextStep, weeklyBuckets]);
    const stepHasWork = useMemo(() => new Map(stepFlags.map((flag) => [flag.id, flag.hasWork])), [stepFlags]);
    const steps = useMemo<ReviewStepDefinition[]>(() => {
        const list: ReviewStepDefinition[] = [
            { id: 'inbox', title: t('review.inboxStep'), description: t('review.inboxStepDesc'), icon: CheckSquare, hasWork: stepHasWork.get('inbox') ?? false },
            { id: 'stale', title: t('review.staleStep'), description: t('review.staleStepDesc'), icon: History, hasWork: stepHasWork.get('stale') ?? false },
        ];
        list.push(
            { id: 'calendar', title: t('review.calendarStep'), description: t('review.calendarStepDesc'), icon: Calendar, hasWork: stepHasWork.get('calendar') ?? false },
            { id: 'waiting', title: t('review.waitingStep'), description: t('review.waitingStepDesc'), icon: ArrowRight, hasWork: stepHasWork.get('waiting') ?? false },
        );
        if (includeContextStep) {
            list.push({ id: 'contexts', title: t('review.contexts'), description: t('review.contextsStepDesc'), icon: MapPin, hasWork: stepHasWork.get('contexts') ?? false });
        }
        list.push(
            { id: 'projects', title: t('review.projectsStep'), description: t('review.projectsStepDesc'), icon: Layers, hasWork: stepHasWork.get('projects') ?? false },
            { id: 'someday', title: t('review.somedayStep'), description: t('review.somedayStepDesc'), icon: Archive, hasWork: stepHasWork.get('someday') ?? false },
            { id: 'completed', title: t('review.allDone'), description: t('review.allDoneDesc'), icon: Check, hasWork: true },
        );
        return list;
    }, [includeContextStep, stepHasWork, t]);
    const {
        displayedStep,
        currentStepIndex: safeStepIndex,
        progress,
        nextStep: nextStepId,
        previousStep: previousStepId,
    } = useMemo(() => resolveReviewStepSession(steps, currentStep), [currentStep, steps]);

    useEffect(() => {
        if (currentStep !== displayedStep) {
            setCurrentStep(displayedStep);
        }
    }, [currentStep, displayedStep, setCurrentStep]);

    useEffect(() => {
        window.localStorage.setItem(WEEKLY_REVIEW_STEP_STORAGE_KEY, JSON.stringify(reviewSession));
    }, [reviewSession]);

    useEffect(() => {
        if (displayedStep !== 'inbox' && isProcessing) {
            setIsProcessing(false);
        }
    }, [displayedStep, isProcessing]);

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
        if (nextStepId) setCurrentStep(nextStepId);
    };

    const prevStep = () => {
        if (previousStepId) setCurrentStep(previousStepId);
    };

    const finishReview = () => {
        window.localStorage.removeItem(WEEKLY_REVIEW_STEP_STORAGE_KEY);
        onClose();
    };

    const renderStepRail = () => (
        <div className="mt-3 flex flex-wrap gap-2">
            {steps.map((step, index) => {
                const skipped = !step.hasWork && step.id !== 'completed';
                const complete = skipped || index < safeStepIndex;
                const current = step.id === displayedStep;
                return (
                    <div
                        key={step.id}
                        className={cn(
                            "inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px]",
                            current
                                ? "border-primary bg-primary/10 text-foreground"
                                : complete
                                    ? "border-success/30 bg-success/10 text-muted-foreground"
                                    : "border-border bg-muted/30 text-muted-foreground",
                        )}
                    >
                        <span
                            className={cn(
                                "flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold",
                                current
                                    ? "bg-primary text-primary-foreground"
                                    : complete
                                        ? "bg-success text-success-foreground"
                                        : "bg-muted text-muted-foreground",
                            )}
                        >
                            {complete ? <Check className="h-3 w-3" strokeWidth={3} /> : index + 1}
                        </span>
                        <span className="max-w-[9rem] truncate">{step.title}</span>
                    </div>
                );
            })}
        </div>
    );

    const getSuggestionProjectId = (id: string) => (
        id.startsWith('project:') ? id.slice('project:'.length) : null
    );

    const getSuggestionProjectStatus = (action: ReviewSuggestion['action']): Project['status'] | null => {
        if (action === 'someday') return 'someday';
        if (action === 'archive') return 'archived';
        return null;
    };

    const isActionableSuggestion = (suggestion: ReviewSuggestion) => (
        suggestion.action === 'someday' || suggestion.action === 'archive'
    );

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
            const provider = createAIProvider(await buildAIConfig(settings, apiKey));
            const response = await provider.analyzeReview({ items: staleItems });
            // Filter here, not in the apply path, so what is displayed and what
            // can be written never diverge.
            const suggestions = filterReviewSuggestionsToKnownIds(
                response.suggestions || [],
                staleItems.map((item) => item.id),
            );
            setAiSuggestions(suggestions);
            const defaultSelected = new Set(
                suggestions
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
        const selectedSuggestions = aiSuggestions
            .filter((suggestion) => aiSelectedIds.has(suggestion.id))
            .filter(isActionableSuggestion);

        const taskUpdates = selectedSuggestions
            .filter((suggestion) => !getSuggestionProjectId(suggestion.id))
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

        const projectUpdates = selectedSuggestions
            .map((suggestion) => {
                const projectId = getSuggestionProjectId(suggestion.id);
                const status = getSuggestionProjectStatus(suggestion.action);
                return projectId && status ? { id: projectId, updates: { status } } : null;
            })
            .filter(Boolean) as Array<{ id: string; updates: Partial<Project> }>;

        if (taskUpdates.length === 0 && projectUpdates.length === 0) return;
        if (taskUpdates.length > 0) {
            await batchUpdateTasks(taskUpdates);
        }
        await Promise.all(projectUpdates.map((update) => updateProject(update.id, update.updates)));
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

    const createProjectTaskFromPrompt = async (value: string): Promise<string | null> => {
        const targetProject = projectTaskPrompt;
        if (!targetProject) return null;

        const trimmed = value.trim();
        if (!trimmed) return null;

        // Same quick-add grammar as the quick-add box, matching the project
        // next-action prompt (#859). Read people lazily: the prompt is rare
        // and the modal shouldn't subscribe to more of the store for it.
        const state = useTaskStore.getState();
        const { title, props, invalidDateCommands } = parseProjectNextActionInput(trimmed, {
            projectId: targetProject.projectId,
            projects: state.projects,
            areas: state.areas,
            parseOptions: buildQuickAddParseOptions(settings, state),
        });
        if (invalidDateCommands && invalidDateCommands.length > 0) {
            showToast(`${t('quickAdd.invalidDateCommand')}: ${invalidDateCommands.join(', ')}`, 'error');
            return null;
        }

        const result = await addTask(title, props);
        if (!result.success) {
            showToast(result.error || t('calendar.saveTaskFailed'), 'error');
            return null;
        }
        setProjectTaskPrompt(null);
        return result.id ?? null;
    };

    const confirmProjectTaskPrompt = (value: string) => {
        void createProjectTaskFromPrompt(value);
    };

    const saveAndEditProjectTask = (value: string) => {
        void createProjectTaskFromPrompt(value).then((taskId) => {
            // The new task renders as a TaskItem in the project step; claiming
            // editingTaskId opens its inline editor without leaving the review.
            if (taskId) setEditingTaskId(taskId);
        });
    };

    const renderMindSweepNudge = () => (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
                <div className="text-sm font-semibold text-foreground">{t('mindSweep.title')}</div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('mindSweep.intro')}</p>
            </div>
            <MindSweepLauncher t={t} addTask={addTask} />
        </div>
    );

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
        switch (displayedStep) {
            case 'inbox': {
                return (
                    <div className="space-y-4">
                        <div className="bg-muted/30 p-4 rounded-lg border border-border">
                            <h3 className="font-semibold mb-2">{t('review.inboxZero')}</h3>
                            <p className="text-sm text-muted-foreground">
                                <span className="font-bold text-foreground">{inboxTasks.length}</span> {t('review.inboxZeroDesc')}
                            </p>
                        </div>
                        {renderMindSweepNudge()}
                        <InboxProcessor
                            t={t}
                            isInbox
                            tasks={tasks}
                            projects={projects}
                            areas={areas}
                            settings={settings}
                            addTask={addTask}
                            addProject={addProject}
                            updateTask={updateTask}
                            deleteTask={deleteTask}
                            allContexts={allContexts}
                            allTags={allTags}
                            isProcessing={isProcessing}
                            setIsProcessing={setIsProcessing}
                        />
                        <div className="space-y-2">
                            {inboxTasks.length === 0 ? (
                                <div className="text-center py-12 text-muted-foreground">
                                    <Check className="w-12 h-12 mx-auto mb-4 text-success" />
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
                                    {[...waitingGroups.due, ...waitingGroups.unscheduled].map((task) => (
                                        <TaskItem key={task.id} task={task} showProjectBadgeInActions={false} />
                                    ))}
                                    {waitingGroups.scheduled.length > 0 && (
                                        <div className="pt-4">
                                            <button
                                                type="button"
                                                onClick={() => setShowScheduledWaiting((prev) => !prev)}
                                                className="mb-2 flex items-center gap-1 text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground"
                                            >
                                                {showScheduledWaiting ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                                {t('review.notDueYet')} ({waitingGroups.scheduled.length})
                                            </button>
                                            {showScheduledWaiting && waitingGroups.scheduled.map((task) => (
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

            case 'stale': {
                return (
                    <div className="space-y-4">
                        <p className="text-muted-foreground">{t('review.staleStepDesc')}</p>
                        {staleItems.length === 0 ? (
                            <div className="text-center py-12 text-muted-foreground">
                                <p>{t('review.aiEmpty')}</p>
                            </div>
                        ) : (
                            <div className="space-y-2">
                                {staleTaskEntries.map(({ daysStale, task }) => (
                                    <div key={task.id} className="flex items-center gap-3">
                                        <div className="flex-1 min-w-0">
                                            <TaskItem task={task} showProjectBadgeInActions={false} />
                                        </div>
                                        <span className="shrink-0 text-xs text-muted-foreground whitespace-nowrap">
                                            {formatI18nTemplate(t('review.staleDaysInactive'), { days: daysStale })}
                                        </span>
                                    </div>
                                ))}
                                {staleProjectItems.map((item) => (
                                    <div key={item.id} className="border border-border rounded-lg p-3 flex items-center justify-between gap-3">
                                        <div className="flex items-center gap-2 min-w-0">
                                            <Layers className="h-4 w-4 shrink-0 text-muted-foreground" />
                                            <span className="text-sm font-medium truncate">{item.title}</span>
                                        </div>
                                        <span className="shrink-0 text-xs text-muted-foreground whitespace-nowrap">
                                            {formatI18nTemplate(t('review.staleDaysInactive'), { days: item.daysStale })}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                        {aiEnabled && (
                    <div className="space-y-4 border-t border-border pt-4">
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
                            <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md p-3">
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
                                    const suggestionTitle = staleItemTitleMap[suggestion.id] || suggestion.id;
                                    const actionLabel = t(`review.aiAction.${suggestion.action}`);
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
                                                    aria-label={`${suggestionTitle}: ${actionLabel}`}
                                                    aria-pressed={aiSelectedIds.has(suggestion.id)}
                                                >
                                                    {aiSelectedIds.has(suggestion.id) ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
                                                </button>
                                            ) : (
                                                <span className="mt-1 h-4 w-4 rounded border border-border/50" />
                                            )}
                                            <div className="flex-1">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-sm font-medium">{suggestionTitle}</span>
                                                    <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                                                        {actionLabel}
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
                        )}
                    </div>
                );
            }

            case 'projects': {
                return (
                    <div className="space-y-6">
                        <p className="text-muted-foreground">{t('review.projectsHint')}</p>
                        <div className="space-y-4">
                            {projectEntries.map(({ project, tasks: projectTasks, nextActionState }) => {
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
                                                    className={cn(
                                                        "text-xs px-2 py-1 rounded-full",
                                                        nextActionState === 'next' && "bg-success/10 text-success",
                                                        // Delegated, not stuck: amber, not the red alarm (#1086).
                                                        nextActionState === 'waiting' && "bg-warning/10 text-warning",
                                                        nextActionState === 'none' && "bg-destructive/10 text-destructive",
                                                    )}
                                                >
                                                    {nextActionState === 'next'
                                                        ? t('review.hasNextAction')
                                                        : nextActionState === 'waiting'
                                                            ? t('status.waiting')
                                                            : t('review.needsAction')}
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
                                    {[...somedayGroups.due, ...somedayGroups.unscheduled].map((task) => (
                                        <TaskItem key={task.id} task={task} showProjectBadgeInActions={false} />
                                    ))}
                                    {somedayGroups.scheduled.length > 0 && (
                                        <div className="pt-4">
                                            <button
                                                type="button"
                                                onClick={() => setShowScheduledSomeday((prev) => !prev)}
                                                className="mb-2 flex items-center gap-1 text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground"
                                            >
                                                {showScheduledSomeday ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                                {t('review.notDueYet')} ({somedayGroups.scheduled.length})
                                            </button>
                                            {showScheduledSomeday && somedayGroups.scheduled.map((task) => (
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
                        <div className="w-20 h-20 bg-success/10 rounded-full flex items-center justify-center mx-auto mb-6">
                            <Check className="w-10 h-10 text-success" />
                        </div>
                        <h2 className="text-3xl font-bold">{t('review.complete')}</h2>
                        <p className="text-muted-foreground text-lg max-w-md mx-auto">
                            {t('review.completeDesc')}
                        </p>
                        <div className="mx-auto max-w-lg text-left rounded-lg border border-border bg-muted/30 p-4 space-y-2.5">
                            <SummaryRow
                                good={reviewSummary.inboxCount === 0}
                                text={reviewSummary.inboxCount === 0
                                    ? t('review.summaryInboxEmpty')
                                    : formatI18nTemplate(t('review.summaryInboxCount'), { count: reviewSummary.inboxCount })}
                            />
                            {reviewSummary.activeProjectCount > 0 && (
                                <SummaryRow
                                    good={reviewSummary.projectsWithoutNextAction === 0}
                                    text={reviewSummary.projectsWithoutNextAction === 0
                                        ? t('review.summaryProjectsOk')
                                        : formatI18nTemplate(t('review.summaryProjectsMissing'), { count: reviewSummary.projectsWithoutNextAction })}
                                />
                            )}
                            {reviewSummary.staleWaitingCount > 0 && (
                                <SummaryRow
                                    good={false}
                                    text={formatI18nTemplate(t('review.summaryWaitingStale'), { count: reviewSummary.staleWaitingCount })}
                                />
                            )}
                        </div>
                        <div className="mx-auto max-w-lg text-left">
                            {renderMindSweepNudge()}
                        </div>
                        <button
                            onClick={finishReview}
                            className="bg-primary text-primary-foreground px-8 py-3 rounded-lg text-lg font-medium hover:bg-primary/90 transition-colors"
                        >
                            {t('review.finish')}
                        </button>
                    </div>
                );
        }
    };

    return (
        <Dialog
            onClose={onClose}
            label={t('review.title')}
            panelClassName="max-w-4xl mx-4 max-h-[85vh] bg-card rounded-lg border-border shadow-xl"
        >
            <DialogHeader className="px-5 py-4 border-b border-border flex items-center justify-between">
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
            </DialogHeader>

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
                            className="h-full w-full origin-left rounded-full bg-primary transition-transform duration-300 ease-out motion-reduce:transition-none"
                            style={{ transform: `scaleX(${progress / 100})` }}
                        />
                    </div>
                    {renderStepRail()}
                </div>

                <div className="flex-1 overflow-y-auto pr-2">
                    {renderStepContent()}
                </div>

                {displayedStep !== 'completed' && (
                    <div className="flex justify-between items-center pt-3.5 border-t border-border mt-5">
                        <button
                            onClick={prevStep}
                            disabled={!previousStepId}
                            className="flex items-center gap-1.5 px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted-foreground"
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
            <PromptModal
                isOpen={Boolean(projectTaskPrompt)}
                title={t('projects.addTask')}
                description={projectTaskPrompt ? `${projectTaskPrompt.projectTitle}` : undefined}
                placeholder={t('nav.addTask')}
                defaultValue=""
                confirmLabel={t('common.add')}
                cancelLabel={t('common.cancel')}
                secondaryLabel={t('quickAdd.saveAndEdit')}
                onSecondary={saveAndEditProjectTask}
                onCancel={() => setProjectTaskPrompt(null)}
                onConfirm={confirmProjectTaskPrompt}
            />
        </Dialog>
    );
}
