import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
    buildQuickAddParseOptions,
    buildReviewSteps,
    createAIProvider,
    filterReviewSuggestionsToKnownIds,
    getExternalCalendarDaySummaries,
    getWeeklyReviewBuckets,
    parseProjectNextActionInput,
    parseStoredReviewStepSession,
    resolveReviewStepSession,
    type AIProviderId,
    type ExternalCalendarEvent,
    type ReviewSuggestion,
    type StoredReviewStepSession,
    type Task,
    type TaskStatus,
    type WeeklyReviewProjectEntry,
    useTaskStore,
} from '@mindwtr/core';
import {
    Calendar as CalendarIcon,
    CheckCircle2,
    Clock,
    FolderOpen,
    History,
    Inbox,
    Lightbulb,
    Tag,
    type LucideIcon,
} from 'lucide-react-native';

import { useTheme } from '../../contexts/theme-context';
import { useLanguage } from '../../contexts/language-context';
import { useQuickCapture } from '../../contexts/quick-capture-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';
import { buildAIConfig, isAIKeyRequired, loadAIKey } from '../../lib/ai-config';
import { logError } from '../../lib/app-log';
import { fetchExternalCalendarEvents } from '../../lib/external-calendar';
import { maybeRequestStoreReviewAfterPositiveMoment } from '../../lib/store-review-prompt';
import { getReviewLabels } from '../review-modal.labels';

export type ReviewStep =
    | 'inbox'
    | 'stale'
    | 'calendar'
    | 'waiting'
    | 'contexts'
    | 'projects'
    | 'someday'
    | 'completed';

export type ReviewStepDefinition = {
    Icon: LucideIcon;
    hasWork: boolean;
    id: ReviewStep;
    title: string;
};

// Weekly Review's per-step candidate lists live in core (ADR 0021); these
// three types are re-exported under their historical local names so callers
// of this controller don't need to change their imports.
export type {
    CalendarReviewEntry as CalendarTaskReviewEntry,
    ContextReviewGroup,
    ExternalCalendarDaySummary,
} from '@mindwtr/core';

export type ReviewProjectEntry = WeeklyReviewProjectEntry & {
    areaColor: string;
};

const WEEKLY_REVIEW_STEP_STORAGE_KEY = 'mindwtr:weeklyReview:currentStep';
const WEEKLY_REVIEW_STEPS = new Set<ReviewStep>([
    'inbox', 'stale', 'calendar', 'waiting', 'contexts', 'projects', 'someday', 'completed',
]);

type UseReviewModalControllerParams = {
    onClose: () => void;
    visible: boolean;
};

export function useReviewModalController({
    onClose,
    visible,
}: UseReviewModalControllerParams) {
    const { tasks, projects, people, areas, updateTask, deleteTask, settings, batchUpdateTasks, addTask } = useTaskStore();
    const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
    const { isDark } = useTheme();
    const { t } = useLanguage();
    const { openQuickCapture } = useQuickCapture();
    const [reviewSession, setReviewSession] = useState<StoredReviewStepSession<ReviewStep>>(() => ({
        step: 'inbox',
        startedAt: new Date().toISOString(),
    }));
    const [sessionHydrated, setSessionHydrated] = useState(false);
    const sessionTouchedRef = useRef(false);
    const sessionWriteRef = useRef<Promise<void>>(Promise.resolve());
    const currentStep = reviewSession.step;
    const setCurrentStep = useCallback((step: ReviewStep) => {
        sessionTouchedRef.current = true;
        setReviewSession((session) => ({ ...session, step }));
    }, []);
    const [editingTask, setEditingTask] = useState<Task | null>(null);
    const [showEditModal, setShowEditModal] = useState(false);
    const [expandedProject, setExpandedProject] = useState<string | null>(null);
    const [aiSuggestions, setAiSuggestions] = useState<ReviewSuggestion[]>([]);
    const [aiSelectedIds, setAiSelectedIds] = useState<Set<string>>(new Set());
    const [aiLoading, setAiLoading] = useState(false);
    const [aiError, setAiError] = useState<string | null>(null);
    const [aiRan, setAiRan] = useState(false);
    const [externalCalendarEvents, setExternalCalendarEvents] = useState<ExternalCalendarEvent[]>([]);
    const [externalCalendarLoading, setExternalCalendarLoading] = useState(false);
    const [externalCalendarError, setExternalCalendarError] = useState<string | null>(null);
    const [expandedExternalDays, setExpandedExternalDays] = useState<Set<string>>(new Set());
    const [expandedContextGroups, setExpandedContextGroups] = useState<Set<string>>(new Set());
    const [projectTaskPrompt, setProjectTaskPrompt] = useState<{ projectId: string; projectTitle: string } | null>(null);
    const [projectTaskTitle, setProjectTaskTitle] = useState('');
    const [editModalTab, setEditModalTab] = useState<'task' | 'view'>('view');

    const labels = useMemo(() => getReviewLabels(t), [t]);
    const tc = useThemeColors();
    const aiEnabled = settings?.ai?.enabled === true;
    const includeContextStep = settings?.gtd?.weeklyReview?.includeContextStep !== false;
    const aiProvider = (settings?.ai?.provider ?? 'openai') as AIProviderId;

    useEffect(() => {
        if (!visible) {
            setSessionHydrated(false);
            return;
        }
        sessionTouchedRef.current = false;
        let cancelled = false;
        const now = new Date();
        void AsyncStorage.getItem(WEEKLY_REVIEW_STEP_STORAGE_KEY)
            .then((stored) => {
                if (cancelled) return;
                const restored = parseStoredReviewStepSession(stored, WEEKLY_REVIEW_STEPS, {
                    cadence: 'weekly',
                    now,
                    weekStart: settings?.weekStart,
                });
                if (!sessionTouchedRef.current) {
                    setReviewSession(restored ?? { step: 'inbox', startedAt: now.toISOString() });
                }
            })
            .catch(() => {
                if (!cancelled && !sessionTouchedRef.current) {
                    setReviewSession({ step: 'inbox', startedAt: now.toISOString() });
                }
            })
            .finally(() => {
                if (!cancelled) setSessionHydrated(true);
            });
        return () => {
            cancelled = true;
        };
    }, [settings?.weekStart, visible]);

    useEffect(() => {
        if (!visible || !sessionHydrated) return;
        const serialized = JSON.stringify(reviewSession);
        sessionWriteRef.current = sessionWriteRef.current
            .then(() => AsyncStorage.setItem(WEEKLY_REVIEW_STEP_STORAGE_KEY, serialized))
            .catch(() => undefined);
    }, [reviewSession, sessionHydrated, visible]);

    const handleClose = useCallback(() => {
        setExpandedExternalDays(new Set());
        setExpandedContextGroups(new Set());
        onClose();
    }, [onClose]);

    const handleTaskPress = useCallback((task: Task) => {
        setEditModalTab('view');
        setEditingTask(task);
        setShowEditModal(true);
    }, []);

    const closeEditModal = useCallback(() => {
        setShowEditModal(false);
    }, []);

    const handleStatusChange = useCallback((taskId: string, status: string) => {
        return updateTask(taskId, { status: status as TaskStatus });
    }, [updateTask]);

    const handleDelete = useCallback((taskId: string) => {
        return deleteTask(taskId);
    }, [deleteTask]);

    const handleSaveTask = useCallback((taskId: string, updates: Partial<Task>) => {
        return updateTask(taskId, updates);
    }, [updateTask]);

    const openReviewQuickAdd = useCallback((initialProps?: Partial<Task>) => {
        openQuickCapture({ initialProps });
    }, [openQuickCapture]);

    const openProjectTaskPrompt = useCallback((projectId: string, projectTitle: string) => {
        setProjectTaskPrompt({ projectId, projectTitle });
        setProjectTaskTitle('');
    }, []);

    const closeProjectTaskPrompt = useCallback(() => {
        setProjectTaskPrompt(null);
        setProjectTaskTitle('');
    }, []);

    const submitProjectTask = useCallback(async (options?: { openEditor?: boolean }) => {
        const rawTitle = projectTaskTitle.trim();
        const targetProject = projectTaskPrompt;
        if (!rawTitle || !targetProject) return;
        try {
            // Same quick-add grammar as the capture sheet, matching the
            // project next-action prompt (#859).
            const { title, props } = parseProjectNextActionInput(rawTitle, {
                projectId: targetProject.projectId,
                projects,
                areas,
                parseOptions: buildQuickAddParseOptions(settings, { tasks, people }),
            });
            const result = await addTask(title, props);
            if (result && result.success === false) {
                throw new Error(result.error || 'Failed to add task');
            }
            closeProjectTaskPrompt();
            if (options?.openEditor && result?.id) {
                const created = useTaskStore.getState().tasks.find((task) => task.id === result.id);
                if (created) {
                    setEditModalTab('task');
                    setEditingTask(created);
                    setShowEditModal(true);
                }
            }
        } catch (error) {
            void logError(error, {
                scope: 'review',
                extra: { message: 'Failed to add task from project review', projectId: targetProject.projectId },
            });
        }
    }, [addTask, areas, closeProjectTaskPrompt, people, projects, projectTaskPrompt, projectTaskTitle, settings, tasks]);

    const toggleExternalDayExpanded = useCallback((dayKey: string) => {
        setExpandedExternalDays((prev) => {
            const next = new Set(prev);
            if (next.has(dayKey)) {
                next.delete(dayKey);
            } else {
                next.add(dayKey);
            }
            return next;
        });
    }, []);

    const toggleContextGroupExpanded = useCallback((contextKey: string) => {
        setExpandedContextGroups((prev) => {
            const next = new Set(prev);
            if (next.has(contextKey)) {
                next.delete(contextKey);
            } else {
                next.add(contextKey);
            }
            return next;
        });
    }, []);

    useEffect(() => {
        if (!visible) return;
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
                const { events } = await fetchExternalCalendarEvents(rangeStart, rangeEnd);
                if (cancelled) return;
                setExternalCalendarEvents(events);
            } catch (error) {
                if (cancelled) return;
                setExternalCalendarError(error instanceof Error ? error.message : String(error));
                setExternalCalendarEvents([]);
            } finally {
                if (!cancelled) setExternalCalendarLoading(false);
            }
        };
        void loadCalendar();
        return () => {
            cancelled = true;
        };
    }, [visible]);

    const handleFinish = useCallback(async () => {
        try {
            await AsyncStorage.setItem('lastWeeklyReview', new Date().toISOString());
        } catch (error) {
            void logError(error, { scope: 'review', extra: { message: 'Failed to save review time' } });
        }
        try {
            await sessionWriteRef.current;
            await AsyncStorage.removeItem(WEEKLY_REVIEW_STEP_STORAGE_KEY);
        } catch (error) {
            void logError(error, { scope: 'review', extra: { message: 'Failed to clear review session' } });
        }
        handleClose();
        setTimeout(() => {
            void maybeRequestStoreReviewAfterPositiveMoment();
        }, 650);
    }, [handleClose]);

    // Core owns the complete Weekly Review model; mobile only decorates the
    // shared project entries with a theme-aware color for rendering.
    const weeklyBuckets = useMemo(
        () => getWeeklyReviewBuckets(tasks, projects),
        [tasks, projects],
    );
    const staleItems = weeklyBuckets.staleItems;
    const reviewSummary = weeklyBuckets.summary;
    const staleItemTitleMap = useMemo(() => staleItems.reduce((acc, item) => {
        acc[item.id] = item.title;
        return acc;
    }, {} as Record<string, string>), [staleItems]);
    const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
    const staleTasks = useMemo(() => staleItems.flatMap((item) => {
        if (item.id.startsWith('project:')) return [];
        const task = taskById.get(item.id);
        return task ? [task] : [];
    }), [staleItems, taskById]);
    const staleProjectItems = useMemo(
        () => staleItems.filter((item) => item.id.startsWith('project:')),
        [staleItems],
    );

    const isActionableSuggestion = useCallback((suggestion: ReviewSuggestion) => {
        if (suggestion.id.startsWith('project:')) return false;
        return suggestion.action === 'someday' || suggestion.action === 'archive';
    }, []);

    const toggleSuggestion = useCallback((id: string) => {
        setAiSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    }, []);

    const runAiAnalysis = useCallback(async () => {
        setAiError(null);
        setAiRan(true);
        if (!aiEnabled) {
            setAiError('AI is disabled. Enable it in Settings.');
            return;
        }
        const apiKey = await loadAIKey(aiProvider);
        if (isAIKeyRequired(settings) && !apiKey) {
            setAiError('Missing API key. Add it in Settings.');
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
            // Filter here, not in the apply path, so what is displayed and what
            // can be written never diverge.
            const suggestions = filterReviewSuggestionsToKnownIds(
                response.suggestions || [],
                staleItems.map((item) => item.id),
            );
            setAiSuggestions(suggestions);
            const defaultSelected = new Set(
                suggestions.filter(isActionableSuggestion).map((suggestion) => suggestion.id),
            );
            setAiSelectedIds(defaultSelected);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setAiError(message || 'AI request failed.');
        } finally {
            setAiLoading(false);
        }
    }, [aiEnabled, aiProvider, isActionableSuggestion, settings, staleItems]);

    const applyAiSuggestions = useCallback(async () => {
        const updates = aiSuggestions
            .filter((suggestion) => aiSelectedIds.has(suggestion.id))
            .filter(isActionableSuggestion)
            .map((suggestion) => {
                if (suggestion.action === 'someday') {
                    return { id: suggestion.id, updates: { status: 'someday' as TaskStatus } };
                }
                if (suggestion.action === 'archive') {
                    return {
                        id: suggestion.id,
                        updates: { status: 'archived' as TaskStatus, completedAt: new Date().toISOString() },
                    };
                }
                return null;
            })
            .filter(Boolean) as { id: string; updates: Partial<Task> }[];

        if (updates.length === 0) return;
        await batchUpdateTasks(updates);
    }, [aiSelectedIds, aiSuggestions, batchUpdateTasks, isActionableSuggestion]);

    const inboxTasks = weeklyBuckets.inbox;
    const waitingGroups = weeklyBuckets.waitingGroups;
    const visibleWaitingTasks = useMemo(
        () => [...waitingGroups.due, ...waitingGroups.unscheduled],
        [waitingGroups],
    );
    const scheduledWaitingTasks = waitingGroups.scheduled;
    const somedayGroups = weeklyBuckets.somedayGroups;
    const visibleSomedayTasks = useMemo(
        () => [...somedayGroups.due, ...somedayGroups.unscheduled],
        [somedayGroups],
    );
    const scheduledSomedayTasks = somedayGroups.scheduled;
    // Only used for the "nothing waiting/someday at all" length checks below;
    // the visible/scheduled slices above are what actually render.
    const waitingTasks = useMemo(
        () => [...waitingGroups.due, ...waitingGroups.scheduled, ...waitingGroups.unscheduled],
        [waitingGroups],
    );
    const somedayTasks = useMemo(
        () => [...somedayGroups.due, ...somedayGroups.scheduled, ...somedayGroups.unscheduled],
        [somedayGroups],
    );
    const calendarReviewItems = weeklyBuckets.calendarItems;
    const externalCalendarReviewItems = useMemo(
        () => getExternalCalendarDaySummaries(externalCalendarEvents),
        [externalCalendarEvents],
    );
    const contextReviewGroups = weeklyBuckets.contextGroups;

    const projectReviewEntries = useMemo<ReviewProjectEntry[]>(
        () => weeklyBuckets.projectEntries.map((entry) => ({
            ...entry,
            areaColor: (
                entry.project.areaId
                    ? areaById.get(entry.project.areaId)?.color
                    : undefined
            ) || tc.tint,
        })),
        [areaById, tc.tint, weeklyBuckets.projectEntries],
    );

    const stepFlags = useMemo(() => buildReviewSteps(weeklyBuckets, {
        kind: 'weekly',
        includeContextStep,
        externalCalendarDayCount: externalCalendarReviewItems.length,
        externalCalendarHasError: Boolean(externalCalendarError),
    }), [externalCalendarError, externalCalendarReviewItems.length, includeContextStep, weeklyBuckets]);
    const stepHasWork = useMemo(() => new Map(stepFlags.map((flag) => [flag.id, flag.hasWork])), [stepFlags]);
    const steps = useMemo<ReviewStepDefinition[]>(() => {
        const list: ReviewStepDefinition[] = [
            { id: 'inbox', title: labels.inbox, Icon: Inbox, hasWork: stepHasWork.get('inbox') ?? false },
            { id: 'stale', title: labels.stale, Icon: History, hasWork: stepHasWork.get('stale') ?? false },
        ];
        list.push(
            { id: 'calendar', title: labels.calendar, Icon: CalendarIcon, hasWork: stepHasWork.get('calendar') ?? false },
            { id: 'waiting', title: labels.waiting, Icon: Clock, hasWork: stepHasWork.get('waiting') ?? false },
        );
        if (includeContextStep) {
            list.push({ id: 'contexts', title: labels.contexts, Icon: Tag, hasWork: stepHasWork.get('contexts') ?? false });
        }
        list.push(
            { id: 'projects', title: labels.projects, Icon: FolderOpen, hasWork: stepHasWork.get('projects') ?? false },
            { id: 'someday', title: labels.someday, Icon: Lightbulb, hasWork: stepHasWork.get('someday') ?? false },
            { id: 'completed', title: labels.done, Icon: CheckCircle2, hasWork: true },
        );
        return list;
    }, [includeContextStep, labels, stepHasWork]);
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

    const nextStep = useCallback(() => {
        if (nextStepId) setCurrentStep(nextStepId);
    }, [nextStepId, setCurrentStep]);

    const prevStep = useCallback(() => {
        if (previousStepId) setCurrentStep(previousStepId);
    }, [previousStepId, setCurrentStep]);

    const handleNavigateToProject = useCallback((projectId: string) => {
        onClose();
        openProjectScreen(projectId);
    }, [onClose]);

    const handleNavigateToToken = useCallback((token: string) => {
        onClose();
        openContextsScreen(token);
    }, [onClose]);

    const toggleExpandedProject = useCallback((projectId: string) => {
        setExpandedProject((prev) => (prev === projectId ? null : projectId));
    }, []);

    return {
        aiEnabled,
        aiError,
        aiLoading,
        aiRan,
        aiSelectedIds,
        aiSuggestions,
        applyAiSuggestions,
        calendarReviewItems,
        canGoBack: previousStepId !== null,
        closeEditModal,
        closeProjectTaskPrompt,
        contextReviewGroups,
        currentStep: displayedStep,
        editModalTab,
        editingTask,
        expandedContextGroups,
        expandedExternalDays,
        expandedProject,
        externalCalendarError,
        externalCalendarLoading,
        externalCalendarReviewItems,
        handleClose,
        handleDelete,
        handleFinish,
        handleNavigateToProject,
        handleNavigateToToken,
        handleSaveTask,
        handleStatusChange,
        handleTaskPress,
        includeContextStep,
        inboxTasks,
        isActionableSuggestion,
        isDark,
        labels,
        nextStep,
        openProjectTaskPrompt,
        openReviewQuickAdd,
        prevStep,
        progress,
        projectReviewEntries,
        projectTaskPrompt,
        projectTaskTitle,
        reviewSummary,
        runAiAnalysis,
        safeStepIndex,
        scheduledSomedayTasks,
        scheduledWaitingTasks,
        setProjectTaskTitle,
        showEditModal,
        somedayTasks,
        staleItemTitleMap,
        staleProjectItems,
        staleTasks,
        steps,
        submitProjectTask,
        tc,
        toggleContextGroupExpanded,
        toggleExpandedProject,
        toggleExternalDayExpanded,
        toggleSuggestion,
        visibleSomedayTasks,
        visibleWaitingTasks,
        waitingTasks,
    };
}
