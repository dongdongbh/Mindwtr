import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, FlatList, Modal, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Calendar as CalendarIcon, Clock, Sparkles, Star, CheckCircle2, Play, ChevronDown, ChevronUp } from 'lucide-react-native';

import {
    buildReviewSteps,
    formatFocusTaskLimitText,
    getDailyReviewBuckets,
    useTaskStore,
    shallow,
    isDueForReview,
    normalizeFocusTaskLimit,
    parseStoredReviewStepSession,
    resolveReviewStepSession,
    safeFormatDate,
    safeParseDate,
    tFallback,
    type ExternalCalendarEvent,
    type StoredReviewStepSession,
    type Task,
    type TaskStatus,
} from '@mindwtr/core';

import { useTheme } from '../contexts/theme-context';
import { useLanguage } from '../contexts/language-context';
import { ToastViewport } from '../contexts/toast-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useFilledButtonColors } from '@/hooks/use-filled-button-colors';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';
import { SwipeableTaskItem, type TaskRowActions } from './swipeable-task-item';
import { TaskEditModal } from './task-edit-modal';
import { InboxProcessingModal } from './inbox-processing-modal';
import { ErrorBoundary } from './ErrorBoundary';
import { fetchExternalCalendarEvents } from '../lib/external-calendar';
import { resolveNonDoneTaskSortBy } from '@/lib/task-list-sort';

type DailyReviewStep = 'today' | 'focus' | 'inbox' | 'waiting' | 'completed';
type DailyReviewStepDefinition = {
    hasWork: boolean;
    id: DailyReviewStep;
    title: string;
    description: string;
};
const DAILY_REVIEW_STEP_STORAGE_KEY = 'mindwtr:dailyReview:currentStep';
const DAILY_REVIEW_STEPS = new Set<DailyReviewStep>(['today', 'focus', 'inbox', 'waiting', 'completed']);

type RenderTaskListOptions = {
    showFocusToggle?: boolean;
    hideStatusBadge?: boolean;
    showFollowUpToday?: boolean;
    header?: React.ReactElement;
    empty?: React.ReactElement;
    testID?: string;
};

interface DailyReviewModalProps {
    visible: boolean;
    onClose: () => void;
}

function DailyReviewFlow({ onClose }: { onClose: () => void }) {
    const { tasks, projects, settings, updateTask, deleteTask } = useTaskStore((state) => ({
        tasks: state.tasks,
        projects: state.projects,
        settings: state.settings,
        updateTask: state.updateTask,
        deleteTask: state.deleteTask,
    }), shallow);
    const { isDark } = useTheme();
    const { t } = useLanguage();
    const tc = useThemeColors();
    const filledButton = useFilledButtonColors();
    const insets = useSafeAreaInsets();

    const [reviewSession, setReviewSession] = useState<StoredReviewStepSession<DailyReviewStep>>(() => ({
        step: 'today',
        startedAt: new Date().toISOString(),
    }));
    const [sessionHydrated, setSessionHydrated] = useState(false);
    const sessionTouchedRef = useRef(false);
    const sessionWriteRef = useRef<Promise<void>>(Promise.resolve());
    const currentStep = reviewSession.step;
    const setCurrentStep = useCallback((step: DailyReviewStep) => {
        sessionTouchedRef.current = true;
        setReviewSession((session) => ({ ...session, step }));
    }, []);
    const [editingTask, setEditingTask] = useState<Task | null>(null);
    const [isTaskModalVisible, setIsTaskModalVisible] = useState(false);
    const [showInboxProcessing, setShowInboxProcessing] = useState(false);
    const [externalEvents, setExternalEvents] = useState<ExternalCalendarEvent[]>([]);
    const [externalLoading, setExternalLoading] = useState(false);
    const [externalError, setExternalError] = useState<string | null>(null);
    const [calendarExpanded, setCalendarExpanded] = useState(true);

    useEffect(() => {
        let cancelled = false;
        void AsyncStorage.getItem(DAILY_REVIEW_STEP_STORAGE_KEY)
            .then((stored) => {
                if (cancelled) return;
                const restored = parseStoredReviewStepSession(stored, DAILY_REVIEW_STEPS, {
                    cadence: 'daily',
                });
                if (restored && !sessionTouchedRef.current) setReviewSession(restored);
            })
            .catch(() => undefined)
            .finally(() => {
                if (!cancelled) setSessionHydrated(true);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (!sessionHydrated) return;
        const serialized = JSON.stringify(reviewSession);
        sessionWriteRef.current = sessionWriteRef.current
            .then(() => AsyncStorage.setItem(DAILY_REVIEW_STEP_STORAGE_KEY, serialized))
            .catch(() => undefined);
    }, [reviewSession, sessionHydrated]);

    const sortBy = resolveNonDoneTaskSortBy(settings?.taskSortBy);
    const includeFocusStep = settings.gtd?.dailyReview?.includeFocusStep !== false;
    const focusTaskLimit = normalizeFocusTaskLimit(settings.gtd?.focusTaskLimit);

    const today = useMemo(() => new Date(), []);
    const followUpTodayReviewAt = useMemo(
        () => new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString(),
        [today],
    );
    const tomorrow = useMemo(() => {
        const d = new Date(today);
        d.setDate(d.getDate() + 1);
        return d;
    }, [today]);
    const followUpTodayLabel = tFallback(t, 'dailyReview.followUpToday', 'Follow up today');
    const reviewDueLabel = tFallback(t, 'agenda.reviewDue', 'Review Due');

    useEffect(() => {
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const loadEvents = async () => {
            setExternalLoading(true);
            setExternalError(null);
            try {
                const start = new Date(today);
                start.setHours(0, 0, 0, 0);
                const end = new Date(start);
                end.setDate(end.getDate() + 2);
                end.setMilliseconds(-1);
                const { events } = await fetchExternalCalendarEvents(start, end, {
                    signal: controller?.signal,
                    timeoutMs: 15_000,
                });
                if (controller?.signal.aborted) return;
                setExternalEvents(events);
            } catch (error) {
                if (controller?.signal.aborted) return;
                setExternalError(error instanceof Error ? error.message : String(error));
                setExternalEvents([]);
            } finally {
                if (!controller?.signal.aborted) setExternalLoading(false);
            }
        };
        loadEvents();
        return () => {
            controller?.abort(new Error('Daily review calendar fetch cancelled'));
        };
    }, [today]);

    const getExternalEventsForDate = useCallback((date: Date) => {
        const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
        const end = new Date(start);
        end.setDate(end.getDate() + 1);
        return externalEvents
            .filter((event) => {
                const eventStart = safeParseDate(event.start);
                const eventEnd = safeParseDate(event.end);
                if (!eventStart || !eventEnd) return false;
                return eventStart.getTime() < end.getTime() && eventEnd.getTime() > start.getTime();
            })
            .sort((a, b) => {
                const aStart = safeParseDate(a.start)?.getTime() ?? Number.POSITIVE_INFINITY;
                const bStart = safeParseDate(b.start)?.getTime() ?? Number.POSITIVE_INFINITY;
                return aStart - bStart;
            });
    }, [externalEvents]);
    const todayEvents = useMemo(() => getExternalEventsForDate(today), [getExternalEventsForDate, today]);
    const tomorrowEvents = useMemo(() => getExternalEventsForDate(tomorrow), [getExternalEventsForDate, tomorrow]);

    // Single source of "what needs reviewing today" (#867): shared with
    // desktop via core so a raw startTime-vs-now check can't drift back in.
    const dailyBuckets = useMemo(
        () => getDailyReviewBuckets(tasks, projects, { now: today, sortBy }),
        [tasks, projects, today, sortBy],
    );
    const inboxTasks = dailyBuckets.inbox;
    const focusedTasks = dailyBuckets.focused;
    const waitingTasks = dailyBuckets.waiting;
    const dueTodayTasks = dailyBuckets.dueToday;
    const overdueTasks = dailyBuckets.overdue;
    const focusCandidates = dailyBuckets.focusCandidates;

    const stepFlags = useMemo(() => buildReviewSteps(dailyBuckets, {
        kind: 'daily',
        includeFocusStep,
        todayCalendarEventCount: todayEvents.length,
        tomorrowCalendarEventCount: tomorrowEvents.length,
        externalCalendarHasError: Boolean(externalError),
    }), [dailyBuckets, externalError, includeFocusStep, todayEvents.length, tomorrowEvents.length]);
    const stepHasWork = useMemo(() => new Map(stepFlags.map((flag) => [flag.id, flag.hasWork])), [stepFlags]);

    const steps: DailyReviewStepDefinition[] = useMemo(() => {
        const list: DailyReviewStepDefinition[] = [
            { id: 'today', title: t('dailyReview.todayStep'), description: t('dailyReview.todayDesc'), hasWork: stepHasWork.get('today') ?? false },
            { id: 'inbox', title: t('dailyReview.inboxStep'), description: t('dailyReview.inboxDesc'), hasWork: stepHasWork.get('inbox') ?? false },
            // Waiting For comes before focus selection: items unblocked today can be
            // switched to Next here and then picked up in the focus step.
            { id: 'waiting', title: t('dailyReview.waitingStep'), description: t('dailyReview.waitingDesc'), hasWork: stepHasWork.get('waiting') ?? false },
        ];
        if (includeFocusStep) {
            list.push({ id: 'focus', title: t('dailyReview.focusStep'), description: t('dailyReview.focusDesc'), hasWork: stepHasWork.get('focus') ?? false });
        }
        list.push(
            { id: 'completed', title: t('dailyReview.completeTitle'), description: t('dailyReview.completeDesc'), hasWork: true },
        );
        return list;
    }, [includeFocusStep, stepHasWork, t]);
    const {
        activeSteps,
        displayedStep,
        activeStepIndex,
        nextStep: nextStepId,
        previousStep: previousStepId,
    } = useMemo(() => resolveReviewStepSession(steps, currentStep), [currentStep, steps]);
    const safeActiveStepIndex = Math.max(0, activeStepIndex);
    const displayedStepDefinition = activeSteps[safeActiveStepIndex];

    useEffect(() => {
        if (currentStep !== displayedStep) setCurrentStep(displayedStep);
    }, [currentStep, displayedStep, setCurrentStep]);

    const next = () => {
        if (nextStepId) setCurrentStep(nextStepId);
    };

    const back = () => {
        if (previousStepId) setCurrentStep(previousStepId);
    };

    const finishReview = useCallback(async () => {
        try {
            await sessionWriteRef.current;
            await AsyncStorage.removeItem(DAILY_REVIEW_STEP_STORAGE_KEY);
        } finally {
            onClose();
        }
    }, [onClose]);

    const openTask = useCallback((task: Task) => {
        setEditingTask(task);
        setIsTaskModalVisible(true);
    }, []);

    // One object for every row across every step, so re-rendering a step does
    // not hand each row a fresh set of arrows (#766).
    const rowActions = useMemo<TaskRowActions>(() => ({
        edit: openTask,
        changeStatus: (task, status) => updateTask(task.id, { status: status as TaskStatus }),
        remove: (task) => deleteTask(task.id),
    }), [deleteTask, openTask, updateTask]);

    const closeTask = () => {
        setIsTaskModalVisible(false);
        setEditingTask(null);
    };
    const handleFollowUpToday = useCallback((task: Task) => {
        void updateTask(task.id, { reviewAt: followUpTodayReviewAt });
    }, [followUpTodayReviewAt, updateTask]);

    // The waiting step is the only one that gives rows a footer, and it shows at
    // most 8. Building them once keeps `footerContent` identity-stable, so that
    // step keeps the same row memo the other four already have (#766).
    const followUpFooters = useMemo(() => {
        const byTaskId = new Map<string, React.ReactNode>();
        for (const task of waitingTasks.slice(0, 8)) {
            const reviewDue = isDueForReview(task.reviewAt, today);
            byTaskId.set(task.id, (
                <TouchableOpacity
                    style={[
                        styles.followUpButton,
                        { backgroundColor: tc.filterBg, opacity: reviewDue ? 0.7 : 1 },
                    ]}
                    onPress={(event) => {
                        event.stopPropagation();
                        handleFollowUpToday(task);
                    }}
                    disabled={reviewDue}
                    hitSlop={6}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: Boolean(reviewDue) }}
                    accessibilityLabel={`${followUpTodayLabel}: ${task.title}`}
                >
                    <Clock size={13} color={reviewDue ? tc.secondaryText : tc.tint} strokeWidth={2.2} />
                    <Text style={[styles.followUpButtonText, { color: reviewDue ? tc.secondaryText : tc.tint }]}>
                        {reviewDue ? reviewDueLabel : followUpTodayLabel}
                    </Text>
                </TouchableOpacity>
            ));
        }
        return byTaskId;
    }, [followUpTodayLabel, handleFollowUpToday, reviewDueLabel, tc, today, waitingTasks]);

    const handleNavigateToProject = (projectId: string) => {
        closeTask();
        onClose();
        openProjectScreen(projectId);
    };
    const handleNavigateToToken = (token: string) => {
        closeTask();
        onClose();
        openContextsScreen(token);
    };

    const renderTaskList = (list: Task[], options?: RenderTaskListOptions) => (
        <FlatList
            testID={options?.testID}
            data={list}
            renderItem={({ item: task }) => (
                <SwipeableTaskItem
                    task={task}
                    isDark={isDark}
                    tc={tc}
                    actions={rowActions}
                    showFocusToggle={options?.showFocusToggle}
                    hideStatusBadge={options?.hideStatusBadge}
                    footerContent={options?.showFollowUpToday ? followUpFooters.get(task.id) : undefined}
                />
            )}
            keyExtractor={(task) => task.id}
            style={styles.taskList}
            contentContainerStyle={styles.taskListContent}
            ListHeaderComponent={options?.header}
            ListHeaderComponentStyle={options?.header ? styles.stepListHeader : undefined}
            ListEmptyComponent={options?.empty}
            initialNumToRender={12}
            maxToRenderPerBatch={12}
            windowSize={5}
            updateCellsBatchingPeriod={50}
            removeClippedSubviews={false}
            showsVerticalScrollIndicator={false}
        />
    );

    const renderExternalEventList = (events: ExternalCalendarEvent[]) => {
        if (externalLoading) {
            return <Text style={[styles.eventMeta, { color: tc.secondaryText }]}>{t('common.loading')}</Text>;
        }
        if (externalError) {
            return <Text style={[styles.eventMeta, { color: tc.secondaryText }]}>{externalError}</Text>;
        }
        if (events.length === 0) {
            return <Text style={[styles.eventMeta, { color: tc.secondaryText }]}>{t('calendar.noTasks')}</Text>;
        }
        return (
            <View style={styles.eventList}>
                {events.slice(0, 5).map((event) => {
                    const start = safeParseDate(event.start);
                    const end = safeParseDate(event.end);
                    const timeLabel = event.allDay || !start || !end
                        ? t('calendar.allDay')
                        : `${safeFormatDate(start, 'p')} - ${safeFormatDate(end, 'p')}`;
                    return (
                        <View key={`${event.sourceId}-${event.id}-${event.start}`} style={styles.eventRow}>
                            <Text style={[styles.eventTitle, { color: tc.text }]} numberOfLines={1}>
                                {event.title}
                            </Text>
                            <Text style={[styles.eventMeta, { color: tc.secondaryText }]} numberOfLines={1}>
                                {timeLabel}
                            </Text>
                        </View>
                    );
                })}
            </View>
        );
    };

    const renderStep = () => {
        switch (displayedStep) {
            case 'today': {
                const topTasks = [...overdueTasks, ...dueTodayTasks].slice(0, 8);
                const totalToday = overdueTasks.length + dueTodayTasks.length;
                const calendarEventCount = todayEvents.length + tomorrowEvents.length;
                return renderTaskList(topTasks, {
                    testID: 'daily-review-step-scroll-today',
                    header: (
                        <>
                            <View style={[styles.infoBox, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                                <Text style={[styles.infoText, { color: tc.text }]}>
                                    <Text style={{ fontWeight: '700' }}>{totalToday}</Text> {t('common.tasks')}
                                </Text>
                                <Text style={[styles.guideText, { color: tc.secondaryText }]}>{t('dailyReview.todayDesc')}</Text>
                            </View>
                            <View style={styles.calendarSection}>
                                <TouchableOpacity
                                    style={[styles.calendarToggleButton, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                    onPress={() => setCalendarExpanded((expanded) => !expanded)}
                                    activeOpacity={0.75}
                                    accessibilityRole="button"
                                    accessibilityState={{ expanded: calendarExpanded }}
                                    accessibilityLabel={t('calendar.events')}
                                >
                                    <View style={styles.calendarToggleTitle}>
                                        <CalendarIcon size={16} color={tc.secondaryText} strokeWidth={2} />
                                        <Text style={[styles.calendarToggleText, { color: tc.text }]}>
                                            {t('calendar.events')}
                                        </Text>
                                        <View style={[styles.calendarCountBadge, { backgroundColor: tc.filterBg }]}>
                                            <Text style={[styles.calendarCountText, { color: tc.secondaryText }]}>
                                                {calendarEventCount}
                                            </Text>
                                        </View>
                                    </View>
                                    {calendarExpanded ? (
                                        <ChevronUp size={18} color={tc.secondaryText} strokeWidth={2} />
                                    ) : (
                                        <ChevronDown size={18} color={tc.secondaryText} strokeWidth={2} />
                                    )}
                                </TouchableOpacity>
                                {calendarExpanded && (
                                    <View style={styles.calendarGrid}>
                                        <View style={[styles.calendarCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                                            <Text style={[styles.calendarCardTitle, { color: tc.secondaryText }]}>
                                                {safeFormatDate(today, 'P')} · {t('calendar.events')}
                                            </Text>
                                            {renderExternalEventList(todayEvents)}
                                        </View>
                                        <View style={[styles.calendarCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                                            <Text style={[styles.calendarCardTitle, { color: tc.secondaryText }]}>
                                                {safeFormatDate(tomorrow, 'P')} · {t('calendar.events')}
                                            </Text>
                                            {renderExternalEventList(tomorrowEvents)}
                                        </View>
                                    </View>
                                )}
                            </View>
                        </>
                    ),
                    empty: (
                        <View style={styles.emptyState}>
                            <Sparkles size={48} color={tc.secondaryText} strokeWidth={1.5} style={styles.emptyIcon} />
                            <Text style={[styles.emptyText, { color: tc.secondaryText }]}>{t('agenda.noTasks')}</Text>
                        </View>
                    ),
                });
            }
            case 'focus':
                return renderTaskList(focusCandidates.slice(0, 8), {
                    testID: 'daily-review-step-scroll-focus',
                    showFocusToggle: true,
                    hideStatusBadge: true,
                    header: (
                        <View style={[styles.infoBox, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                            <Text style={[styles.infoText, { color: tc.text }]}>
                                <Text style={{ fontWeight: '700' }}>{focusedTasks.length}</Text> {t('dailyReview.focusSelected')}
                            </Text>
                            <Text style={[styles.guideText, { color: tc.secondaryText }]}>{t('dailyReview.focusDesc')}</Text>
                        </View>
                    ),
                    empty: (
                        <View style={styles.emptyState}>
                            <Star size={48} color={tc.secondaryText} strokeWidth={1.5} style={styles.emptyIcon} />
                            <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
                                {formatFocusTaskLimitText(t('agenda.focusHint'), focusTaskLimit)}
                            </Text>
                        </View>
                    ),
                });
            case 'inbox':
                return renderTaskList(inboxTasks.slice(0, 8), {
                    testID: 'daily-review-step-scroll-inbox',
                    header: (
                        <>
                            <View style={[styles.infoBox, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                                <Text style={[styles.infoText, { color: tc.text }]}>
                                    <Text style={{ fontWeight: '700' }}>{inboxTasks.length}</Text> {t('common.tasks')}
                                </Text>
                                <Text style={[styles.guideText, { color: tc.secondaryText }]}>{t('dailyReview.inboxDesc')}</Text>
                            </View>
                            {inboxTasks.length > 0 && (
                                <TouchableOpacity
                                    style={[styles.processButton, { backgroundColor: filledButton.backgroundColor }]}
                                    onPress={() => setShowInboxProcessing(true)}
                                    hitSlop={8}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('inbox.processButton')}
                                >
                                    <Play size={14} color={filledButton.textColor ?? tc.onTint} strokeWidth={2.5} fill={filledButton.textColor ?? tc.onTint} />
                                    <Text style={[styles.processButtonText, { color: filledButton.textColor ?? tc.onTint }]}>
                                        {t('inbox.processButton')}
                                    </Text>
                                </TouchableOpacity>
                            )}
                        </>
                    ),
                    empty: (
                        <View style={styles.emptyState}>
                            <CheckCircle2 size={48} color={tc.secondaryText} strokeWidth={1.5} style={styles.emptyIcon} />
                            <Text style={[styles.emptyText, { color: tc.secondaryText }]}>{t('review.inboxEmpty')}</Text>
                        </View>
                    ),
                });
            case 'waiting':
                return renderTaskList(waitingTasks.slice(0, 8), {
                    testID: 'daily-review-step-scroll-waiting',
                    showFollowUpToday: true,
                    header: (
                        <View style={[styles.infoBox, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                            <Text style={[styles.infoText, { color: tc.text }]}>
                                <Text style={{ fontWeight: '700' }}>{waitingTasks.length}</Text> {t('common.tasks')}
                            </Text>
                            <Text style={[styles.guideText, { color: tc.secondaryText }]}>{t('dailyReview.waitingDesc')}</Text>
                        </View>
                    ),
                    empty: (
                        <View style={styles.emptyState}>
                            <CheckCircle2 size={48} color={tc.secondaryText} strokeWidth={1.5} style={styles.emptyIcon} />
                            <Text style={[styles.emptyText, { color: tc.secondaryText }]}>{t('review.waitingEmpty')}</Text>
                        </View>
                    ),
                });
            case 'completed':
                return (
                    <View style={styles.centerContent}>
                        <CheckCircle2 size={56} color={tc.tint} strokeWidth={1.5} style={styles.bigIcon} />
                        <Text style={[styles.description, { color: tc.secondaryText }]}>{t('dailyReview.completeDesc')}</Text>
                        <TouchableOpacity style={[styles.primaryButton, { backgroundColor: filledButton.backgroundColor }]} onPress={finishReview}>
                            <Text style={[styles.primaryButtonText, { color: filledButton.textColor ?? tc.onTint }]}>{t('review.finish')}</Text>
                        </TouchableOpacity>
                    </View>
                );
            default:
                return null;
        }
    };

    return (
        <GestureHandlerRootView
            style={[styles.modalContainer, { backgroundColor: tc.bg }]}
        >
            <SafeAreaView style={[styles.modalContainer, { backgroundColor: tc.bg }]} edges={['top']}>
                <View style={[styles.header, { borderBottomColor: tc.border }]}>
                    <TouchableOpacity
                        onPress={onClose}
                        style={styles.closeButton}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.close')}
                        hitSlop={8}
                    >
                        <X size={22} color={tc.text} strokeWidth={2} />
                    </TouchableOpacity>
                    <View style={styles.headerCenter}>
                        <Text style={[styles.headerEyebrow, { color: tc.secondaryText }]}>
                            {t('dailyReview.title')}
                        </Text>
                        <Text style={[styles.headerTitle, { color: tc.text }]} numberOfLines={2}>
                            {displayedStepDefinition?.title ?? t('dailyReview.completeTitle')}
                        </Text>
                        <Text style={[styles.headerStep, { color: tc.secondaryText }]}>
                            {t('review.step')} {safeActiveStepIndex + 1} {t('review.of')} {activeSteps.length}
                        </Text>
                    </View>
                    <View style={{ width: 28 }} />
                </View>

                <View style={styles.content}>{renderStep()}</View>

                {displayedStep !== 'completed' && (
                    <View
                        testID="daily-review-footer"
                        style={[
                            styles.footer,
                            {
                                borderTopColor: tc.border,
                                backgroundColor: tc.cardBg,
                                paddingBottom: 14 + Math.max(insets.bottom, 8),
                            },
                        ]}
                    >
                        <TouchableOpacity
                            onPress={back}
                            disabled={!previousStepId}
                            accessibilityState={{ disabled: !previousStepId }}
                            style={[styles.footerButton, { backgroundColor: tc.filterBg, opacity: previousStepId ? 1 : 0.5 }]}
                        >
                            <Text style={[styles.footerButtonText, { color: tc.text }]}>{t('review.back')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={next} style={[styles.footerButton, { backgroundColor: filledButton.backgroundColor }]}>
                            <Text style={[styles.footerPrimaryText, { color: filledButton.textColor ?? tc.onTint }]}>{t('review.nextStepBtn')}</Text>
                        </TouchableOpacity>
                    </View>
                )}
                <ErrorBoundary>
                    <InboxProcessingModal
                        visible={showInboxProcessing}
                        onClose={() => setShowInboxProcessing(false)}
                    />
                </ErrorBoundary>

                <ErrorBoundary>
                    <TaskEditModal
                        visible={isTaskModalVisible}
                        task={editingTask}
                        onClose={closeTask}
                        onSave={(taskId, updates) => {
                            const result = updateTask(taskId, updates);
                            closeTask();
                            return result;
                        }}
                        defaultTab="view"
                        onProjectNavigate={handleNavigateToProject}
                        onContextNavigate={handleNavigateToToken}
                        onTagNavigate={handleNavigateToToken}
                        onFocusMode={(taskId) => {
                            closeTask();
                            router.push(`/check-focus?id=${taskId}`);
                        }}
                    />
                </ErrorBoundary>
            </SafeAreaView>
        </GestureHandlerRootView>
    );
}

export function DailyReviewModal({ visible, onClose }: DailyReviewModalProps) {
    return (
        <Modal
            visible={visible}
            animationType="slide"
            presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
            allowSwipeDismissal
            onRequestClose={onClose}
        >
            {visible ? <DailyReviewFlow onClose={onClose} /> : null}
            <ToastViewport />
        </Modal>
    );
}

export function DailyReviewScreen({ onClose }: { onClose: () => void }) {
    return <DailyReviewFlow onClose={onClose} />;
}

const styles = StyleSheet.create({
    modalContainer: {
        flex: 1,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
    },
    closeButton: {
        width: 28,
        height: 28,
        alignItems: 'center',
        justifyContent: 'center',
    },
    headerCenter: {
        alignItems: 'center',
        flex: 1,
        paddingHorizontal: 8,
    },
    headerEyebrow: {
        fontSize: 11,
        fontWeight: '600',
        marginBottom: 1,
    },
    headerTitle: {
        fontSize: 16,
        fontWeight: '700',
        lineHeight: 20,
        textAlign: 'center',
    },
    headerStep: {
        fontSize: 12,
        marginTop: 2,
    },
    content: {
        flex: 1,
        padding: 20,
    },
    centerContent: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 24,
        gap: 14,
    },
    bigIcon: {
        marginBottom: 6,
    },
    description: {
        fontSize: 14,
        textAlign: 'center',
        lineHeight: 20,
        maxWidth: 320,
    },
    primaryButton: {
        paddingHorizontal: 18,
        paddingVertical: 12,
        borderRadius: 12,
        marginTop: 8,
    },
    primaryButtonText: {
        fontSize: 16,
        fontWeight: '700',
    },
    stepContent: {
        flex: 1,
        gap: 14,
    },
    infoBox: {
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        gap: 8,
    },
    infoText: {
        fontSize: 14,
        fontWeight: '700',
    },
    guideText: {
        fontSize: 13,
        lineHeight: 18,
    },
    calendarGrid: {
        gap: 10,
    },
    calendarSection: {
        gap: 10,
    },
    calendarToggleButton: {
        minHeight: 44,
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    calendarToggleTitle: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flex: 1,
        minWidth: 0,
    },
    calendarToggleText: {
        fontSize: 13,
        fontWeight: '700',
        flexShrink: 1,
    },
    calendarCountBadge: {
        minWidth: 28,
        height: 24,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 8,
    },
    calendarCountText: {
        fontSize: 12,
        fontWeight: '700',
    },
    calendarCard: {
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
        gap: 8,
    },
    calendarCardTitle: {
        fontSize: 11,
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: 0.4,
    },
    eventList: {
        gap: 6,
    },
    eventRow: {
        gap: 2,
    },
    eventTitle: {
        fontSize: 13,
        fontWeight: '600',
    },
    eventMeta: {
        fontSize: 12,
    },
    processButton: {
        alignSelf: 'flex-start',
        borderRadius: 999,
        paddingHorizontal: 14,
        paddingVertical: 8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    processButtonText: {
        fontSize: 12,
        fontWeight: '700',
    },
    quickActions: {
        flexDirection: 'row',
        gap: 10,
        marginTop: 4,
    },
    actionButton: {
        borderWidth: 1,
        borderRadius: 999,
        paddingVertical: 8,
        paddingHorizontal: 12,
    },
    actionButtonText: {
        fontSize: 13,
        fontWeight: '600',
    },
    taskList: {
        flex: 1,
    },
    taskListContent: {
        paddingBottom: 12,
    },
    stepListHeader: {
        gap: 14,
        marginBottom: 14,
    },
    followUpButton: {
        alignSelf: 'flex-start',
        minHeight: 32,
        borderRadius: 8,
        paddingHorizontal: 9,
        paddingVertical: 6,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginTop: 4,
    },
    followUpButtonText: {
        fontSize: 11,
        fontWeight: '700',
    },
    emptyState: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 30,
        gap: 10,
    },
    emptyIcon: {
        opacity: 0.9,
    },
    emptyText: {
        fontSize: 14,
        textAlign: 'center',
        lineHeight: 20,
    },
    footer: {
        flexDirection: 'row',
        gap: 12,
        padding: 14,
        borderTopWidth: 1,
    },
    footerButton: {
        flex: 1,
        paddingVertical: 12,
        borderRadius: 12,
        alignItems: 'center',
    },
    footerButtonText: {
        fontSize: 14,
        fontWeight: '700',
    },
    footerPrimaryText: {
        fontSize: 14,
        fontWeight: '700',
    },
});
