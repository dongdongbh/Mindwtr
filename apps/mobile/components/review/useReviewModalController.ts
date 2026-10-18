import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { workspaceSessionStorage as AsyncStorage } from '@/lib/workspace-session-storage';
import {
    LAST_WEEKLY_REVIEW_STORAGE_KEY,
    WEEKLY_REVIEW_SESSION_STORAGE_KEY,
    buildReviewSteps,
    buildReviewSuggestionUpdates,
    createAIProvider,
    getExternalCalendarDaySummaries,
    getReviewCalendarRange,
    getReviewStepRail,
    getWeeklyReviewBuckets,
    getWeeklyReviewCompletion,
    getWeeklyReviewLabels,
    getWeeklyReviewProjects,
    getWeeklyReviewScheduledList,
    getWeeklyReviewSettings,
    getWeeklyReviewStale,
    isActionableReviewSuggestion,
    planReviewProjectTask,
    resolveReviewStepSession,
    restoreReviewSession,
    serializeReviewSession,
    titleWeeklyReviewSteps,
    type AIProviderId,
    type ExternalCalendarEvent,
    type TitledReviewSuggestion,
    type StoredReviewStepSession,
    type Task,
    type TaskStatus,
    type WeeklyReviewStepId,
    useTaskStore,
} from '@mindwtr/core';
import { getWeeklyReviewAnalysisError, readWeeklyReviewAnalysis } from '@mindwtr/core/ai-task-actions';
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

export type ReviewStep = WeeklyReviewStepId;

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

const STEP_ICONS: Record<ReviewStep, LucideIcon> = {
    inbox: Inbox,
    stale: History,
    calendar: CalendarIcon,
    waiting: Clock,
    contexts: Tag,
    projects: FolderOpen,
    someday: Lightbulb,
    completed: CheckCircle2,
};

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
    const { t, language } = useLanguage();
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
    const [closingForNavigation, setClosingForNavigation] = useState(false);
    const modalVisible = visible && !closingForNavigation;
    const pendingNavigationRef = useRef<{ after: 'editor' | 'review'; navigate: () => void } | null>(null);

    useEffect(() => {
        setClosingForNavigation(false);
        pendingNavigationRef.current = null;
        if (!visible) setShowEditModal(false);
    }, [visible]);

    useEffect(() => () => { pendingNavigationRef.current = null; }, []);
    const [expandedProject, setExpandedProject] = useState<string | null>(null);
    const [aiSuggestions, setAiSuggestions] = useState<TitledReviewSuggestion[]>([]);
    const [aiSelectedIds, setAiSelectedIds] = useState<Set<string>>(new Set());
    const [aiLoading, setAiLoading] = useState(false);
    const [aiError, setAiError] = useState<string | null>(null);
    const [aiRan, setAiRan] = useState(false);
    const [externalCalendarEvents, setExternalCalendarEvents] = useState<ExternalCalendarEvent[]>([]);
    const [externalCalendarLoading, setExternalCalendarLoading] = useState(true);
    const [externalCalendarError, setExternalCalendarError] = useState<string | null>(null);
    const [expandedExternalDays, setExpandedExternalDays] = useState<Set<string>>(new Set());
    const [expandedContextGroups, setExpandedContextGroups] = useState<Set<string>>(new Set());
    const [projectTaskPrompt, setProjectTaskPrompt] = useState<{ projectId: string; projectTitle: string } | null>(null);
    const [projectTaskTitle, setProjectTaskTitle] = useState('');
    const [editModalTab, setEditModalTab] = useState<'task' | 'view'>('view');

    const labels = useMemo(() => getWeeklyReviewLabels(t), [t]);
    const tc = useThemeColors();
    const { aiEnabled, includeContextStep } = getWeeklyReviewSettings(settings);
    const aiProvider = (settings?.ai?.provider ?? 'openai') as AIProviderId;

    useEffect(() => {
        if (!visible) {
            setSessionHydrated(false);
            return;
        }
        sessionTouchedRef.current = false;
        let cancelled = false;
        const now = new Date();
        void AsyncStorage.getItem(WEEKLY_REVIEW_SESSION_STORAGE_KEY)
            .then((stored) => {
                if (cancelled) return;
                const { session } = restoreReviewSession<ReviewStep>('weekly', stored, { now, weekStart: settings?.weekStart });
                if (!sessionTouchedRef.current) setReviewSession(session);
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
        const serialized = serializeReviewSession(reviewSession);
        sessionWriteRef.current = sessionWriteRef.current
            .then(() => AsyncStorage.setItem(WEEKLY_REVIEW_SESSION_STORAGE_KEY, serialized))
            .catch(() => undefined);
    }, [reviewSession, sessionHydrated, visible]);

    const handleClose = useCallback(() => {
        pendingNavigationRef.current = null;
        setExpandedExternalDays(new Set());
        setExpandedContextGroups(new Set());
        onClose();
    }, [onClose]);

    const handleTaskPress = useCallback((task: Task) => {
        pendingNavigationRef.current = null;
        setEditModalTab('view');
        setEditingTask(task);
        setShowEditModal(true);
    }, []);

    const closeEditModal = useCallback(() => {
        pendingNavigationRef.current = null;
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
        const targetProject = projectTaskPrompt;
        if (!projectTaskTitle.trim() || !targetProject) return;
        try {
            const plan = planReviewProjectTask({
                title: projectTaskTitle,
                projectId: targetProject.projectId,
                projects,
                areas,
                settings,
                tasks,
                people,
            });
            if (!plan) return;
            const result = await addTask(plan.title, plan.props);
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
        if (!visible) {
            setExternalCalendarLoading(true);
            return;
        }
        let cancelled = false;
        const loadCalendar = async () => {
            setExternalCalendarLoading(true);
            setExternalCalendarError(null);
            try {
                const range = getReviewCalendarRange(new Date(), 7);
                const { events } = await fetchExternalCalendarEvents(range.start, range.end);
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
            await AsyncStorage.setItem(LAST_WEEKLY_REVIEW_STORAGE_KEY, new Date().toISOString());
        } catch (error) {
            void logError(error, { scope: 'review', extra: { message: 'Failed to save review time' } });
        }
        try {
            await sessionWriteRef.current;
            await AsyncStorage.removeItem(WEEKLY_REVIEW_SESSION_STORAGE_KEY);
        } catch (error) {
            void logError(error, { scope: 'review', extra: { message: 'Failed to clear review session' } });
        }
        handleClose();
        setTimeout(() => {
            void maybeRequestStoreReviewAfterPositiveMoment();
        }, 650);
    }, [handleClose]);

    // Core owns the complete Weekly Review model (review-utils, review-views-model).
    const weeklyBuckets = useMemo(
        () => getWeeklyReviewBuckets(tasks, projects, { weekStart: settings?.weekStart }),
        [projects, settings?.weekStart, tasks],
    );
    const staleItems = weeklyBuckets.staleItems;
    const completion = getWeeklyReviewCompletion(weeklyBuckets, settings, labels);
    // Deliberately over tasks (visible tasks), not the store's _tasksById
    // (all tasks incl. hidden) — PERF-03 leaves this site alone on purpose.
    const stale = useMemo(() => getWeeklyReviewStale(staleItems, tasks, labels), [labels, staleItems, tasks]);
    const staleTasks = stale.tasks;
    const staleProjectItems = stale.projects;

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
            setAiError(t('ai.disabledBody'));
            return;
        }
        let apiKey: string;
        try {
            apiKey = await loadAIKey(aiProvider);
        } catch (error) {
            // An unreadable keystore fails like a request, never as an unhandled rejection.
            setAiError(getWeeklyReviewAnalysisError(error, t, '', settings));
            return;
        }
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
            const provider = createAIProvider(buildAIConfig(settings, apiKey, language));
            const response = await provider.analyzeReview({ items: staleItems });
            const analysis = readWeeklyReviewAnalysis(response, staleItems);
            setAiSuggestions(analysis.suggestions);
            setAiSelectedIds(new Set(analysis.selectedIds));
        } catch (error) {
            setAiError(getWeeklyReviewAnalysisError(error, t, apiKey, settings));
        } finally {
            setAiLoading(false);
        }
    }, [aiEnabled, aiProvider, language, settings, staleItems, t]);

    const applyAiSuggestions = useCallback(async () => {
        const updates = buildReviewSuggestionUpdates(aiSuggestions, aiSelectedIds, new Date());
        if (updates.length === 0) return;
        await batchUpdateTasks(updates);
    }, [aiSelectedIds, aiSuggestions, batchUpdateTasks]);

    const inboxTasks = weeklyBuckets.inbox;
    const waitingList = useMemo(() => getWeeklyReviewScheduledList(weeklyBuckets.waitingGroups, labels), [labels, weeklyBuckets]);
    const somedayList = useMemo(() => getWeeklyReviewScheduledList(weeklyBuckets.somedayGroups, labels), [labels, weeklyBuckets]);
    const calendarReviewItems = weeklyBuckets.calendarItems;
    const externalCalendarReviewItems = useMemo(
        () => getExternalCalendarDaySummaries(externalCalendarEvents),
        [externalCalendarEvents],
    );
    const contextReviewGroups = weeklyBuckets.contextGroups;

    // A project without an area color takes the theme tint when drawn.
    const projectReviewEntries = useMemo(
        () => getWeeklyReviewProjects(weeklyBuckets.projectEntries, areaById, labels),
        [areaById, labels, weeklyBuckets.projectEntries],
    );

    const stepFlags = useMemo(() => buildReviewSteps(weeklyBuckets, {
        kind: 'weekly',
        includeContextStep,
        externalCalendarDayCount: externalCalendarReviewItems.length,
        externalCalendarHasError: Boolean(externalCalendarError),
        externalCalendarLoading,
    }), [externalCalendarError, externalCalendarLoading, externalCalendarReviewItems.length, includeContextStep, weeklyBuckets]);
    const steps = useMemo<ReviewStepDefinition[]>(
        () => titleWeeklyReviewSteps(stepFlags, labels).map((step) => ({ ...step, Icon: STEP_ICONS[step.id] })),
        [labels, stepFlags],
    );
    const {
        displayedStep,
        currentStepIndex: safeStepIndex,
        progress,
        nextStep: nextStepId,
        previousStep: previousStepId,
    } = useMemo(() => resolveReviewStepSession(steps, currentStep), [currentStep, steps]);

    const stepRail = useMemo(() => getReviewStepRail(steps, displayedStep, safeStepIndex), [displayedStep, safeStepIndex, steps]);

    useEffect(() => {
        if (currentStep !== displayedStep) {
            setReviewSession((session) => ({ ...session, step: displayedStep }));
        }
    }, [currentStep, displayedStep]);

    const nextStep = useCallback(() => {
        if (nextStepId) setCurrentStep(nextStepId);
    }, [nextStepId, setCurrentStep]);

    const prevStep = useCallback(() => {
        if (previousStepId) setCurrentStep(previousStepId);
    }, [previousStepId, setCurrentStep]);

    const navigateFromPreview = useCallback((navigate: () => void) => {
        if (!visible) return;
        // UIKit must dismiss the child sheet, then the review, before changing routes.
        if (Platform.OS === 'ios') {
            pendingNavigationRef.current ??= { after: 'editor', navigate };
        } else {
            onClose();
            navigate();
        }
    }, [onClose, visible]);

    const handleEditModalDismiss = useCallback(() => {
        const pending = pendingNavigationRef.current;
        if (!visible || showEditModal || pending?.after !== 'editor') return;
        pending.after = 'review';
        setClosingForNavigation(true);
    }, [showEditModal, visible]);

    const handleReviewDismiss = useCallback(() => {
        const pending = pendingNavigationRef.current;
        if (modalVisible || pending?.after !== 'review') return;
        pendingNavigationRef.current = null;
        onClose();
        pending.navigate();
    }, [modalVisible, onClose]);

    const handleNavigateToProject = useCallback((projectId: string) => {
        navigateFromPreview(() => openProjectScreen(projectId));
    }, [navigateFromPreview]);

    const handleNavigateToToken = useCallback((token: string) => {
        navigateFromPreview(() => openContextsScreen(token));
    }, [navigateFromPreview]);

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
        completion,
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
        handleEditModalDismiss,
        handleFinish,
        handleNavigateToProject,
        handleNavigateToToken,
        handleReviewDismiss,
        handleSaveTask,
        handleStatusChange,
        handleTaskPress,
        includeContextStep,
        inboxTasks,
        isActionableSuggestion: isActionableReviewSuggestion,
        isDark,
        labels,
        modalVisible,
        nextStep,
        openProjectTaskPrompt,
        openReviewQuickAdd,
        prevStep,
        progress,
        projectReviewEntries,
        projectTaskPrompt,
        projectTaskTitle,
        runAiAnalysis,
        safeStepIndex,
        setProjectTaskTitle,
        showEditModal,
        somedayList,
        staleProjectItems,
        staleTasks,
        stepRail,
        steps,
        submitProjectTask,
        tc,
        toggleContextGroupExpanded,
        toggleExpandedProject,
        toggleExternalDayExpanded,
        toggleSuggestion,
        waitingList,
    };
}
