import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, FlatList, Modal, TouchableOpacity, StyleSheet, Platform, ScrollView } from 'react-native';
import { workspaceSessionStorage as AsyncStorage } from '@/lib/workspace-session-storage';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Calendar as CalendarIcon, Clock, Sparkles, Star, CheckCircle2, Play, ChevronDown, ChevronUp } from 'lucide-react-native';

import {
    DAILY_REVIEW_SESSION_STORAGE_KEY,
    buildReviewSteps,
    formatListItemCountNoun,
    formatDailyReviewStepLabel,
    getDailyReviewBuckets,
    getDailyReviewCalendarDay,
    getDailyReviewFollowUp,
    getDailyReviewSettings,
    getDailyReviewText,
    getDailyReviewTodayTasks,
    getReviewCalendarRange,
    planDailyReviewFollowUp,
    useTaskStore,
    shallow,
    resolveReviewStepSession,
    restoreReviewSession,
    safeFormatDate,
    serializeReviewSession,
    titleDailyReviewSteps,
    type DailyReviewStepId,
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
import { SandboxWorkspaceCue } from './sandbox-workspace-cue';
import { fetchExternalCalendarEvents } from '../lib/external-calendar';
import { useLocalDayKey } from '@/hooks/use-local-day-key';

type DailyReviewStep = DailyReviewStepId;

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
    const { tasks, projects, sections, settings, updateTask, deleteTask } = useTaskStore((state) => ({
        tasks: state.tasks,
        projects: state.projects,
        sections: state.sections,
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
    const [externalLoading, setExternalLoading] = useState(true);
    const [externalError, setExternalError] = useState<string | null>(null);
    const [calendarExpanded, setCalendarExpanded] = useState(true);

    useEffect(() => {
        let cancelled = false;
        void AsyncStorage.getItem(DAILY_REVIEW_SESSION_STORAGE_KEY)
            .then((stored) => {
                if (cancelled) return;
                const { session, resumed } = restoreReviewSession<DailyReviewStep>('daily', stored, { now: new Date() });
                if (resumed && !sessionTouchedRef.current) setReviewSession(session);
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
        const serialized = serializeReviewSession(reviewSession);
        sessionWriteRef.current = sessionWriteRef.current
            .then(() => AsyncStorage.setItem(DAILY_REVIEW_SESSION_STORAGE_KEY, serialized))
            .catch(() => undefined);
    }, [reviewSession, sessionHydrated]);

    const { sortBy, includeFocusStep, focusTaskLimit } = getDailyReviewSettings(settings);
    const text = useMemo(() => getDailyReviewText(t, focusTaskLimit), [focusTaskLimit, t]);

    const { followUpToday, reviewDue } = text;
    const followUpText = useMemo(() => ({ followUpToday, reviewDue }), [followUpToday, reviewDue]);

    const localDayKey = useLocalDayKey();
    const today = useMemo(() => {
        const [year, monthIndex, day] = localDayKey.split('-').map(Number);
        return new Date(year, monthIndex, day);
    }, [localDayKey]);
    const tomorrow = useMemo(() => {
        const d = new Date(today);
        d.setDate(d.getDate() + 1);
        return d;
    }, [today]);

    useEffect(() => {
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const loadEvents = async () => {
            setExternalLoading(true);
            setExternalError(null);
            try {
                const { start, end } = getReviewCalendarRange(today, 2);
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


    const todayCalendar = getDailyReviewCalendarDay(externalEvents, today, text, safeFormatDate, Infinity);
    const tomorrowCalendar = getDailyReviewCalendarDay(externalEvents, tomorrow, text, safeFormatDate, Infinity);


    const dailyBuckets = useMemo(
        () => getDailyReviewBuckets(tasks, projects, { now: today, sortBy, sections }),
        [tasks, projects, sections, today, sortBy],
    );
    const inboxTasks = dailyBuckets.inbox;
    const focusedTasks = dailyBuckets.focused;
    const waitingTasks = dailyBuckets.waiting;
    const focusCandidates = dailyBuckets.focusCandidates;

    const stepFlags = useMemo(() => buildReviewSteps(dailyBuckets, {
        kind: 'daily',
        includeFocusStep,
        todayCalendarEventCount: todayCalendar.count,
        tomorrowCalendarEventCount: tomorrowCalendar.count,
        externalCalendarHasError: Boolean(externalError),
        externalCalendarLoading: externalLoading,
    }), [dailyBuckets, externalError, externalLoading, includeFocusStep, todayCalendar.count, tomorrowCalendar.count]);
    const steps = useMemo(() => titleDailyReviewSteps(stepFlags, t), [stepFlags, t]);
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
        if (currentStep !== displayedStep) {
            setReviewSession((session) => ({ ...session, step: displayedStep }));
        }
    }, [currentStep, displayedStep]);

    const next = () => {
        if (nextStepId) setCurrentStep(nextStepId);
    };

    const back = () => {
        if (previousStepId) setCurrentStep(previousStepId);
    };

    const finishReview = useCallback(async () => {
        try {
            await sessionWriteRef.current;
            await AsyncStorage.removeItem(DAILY_REVIEW_SESSION_STORAGE_KEY);
        } finally {
            onClose();
        }
    }, [onClose]);

    const openTask = useCallback((task: Task) => {
        setEditingTask(task);
        setIsTaskModalVisible(true);
    }, []);


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
        const plan = planDailyReviewFollowUp(task, today);
        if (plan) void updateTask(task.id, plan);
    }, [today, updateTask]);


    const followUpFooters = useMemo(() => {
        const byTaskId = new Map<string, React.ReactNode>();
        for (const task of waitingTasks) {
            const followUp = getDailyReviewFollowUp(task, today, followUpText);
            const reviewDue = followUp.due;
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
                    accessibilityLabel={followUp.accessibilityLabel}
                >
                    <Clock size={13} color={reviewDue ? tc.secondaryText : tc.tint} strokeWidth={2.2} />
                    <Text style={[styles.followUpButtonText, { color: reviewDue ? tc.secondaryText : tc.tint }]}>
                        {followUp.label}
                    </Text>
                </TouchableOpacity>
            ));
        }
        return byTaskId;
    }, [followUpText, handleFollowUpToday, tc, today, waitingTasks]);

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

    const renderExternalEventList = (day: typeof todayCalendar) => {
        if (externalLoading) {
            return <Text style={[styles.eventMeta, { color: tc.secondaryText }]}>{text.loading}</Text>;
        }
        if (externalError) {
            return <Text style={[styles.eventMeta, { color: tc.secondaryText }]}>{externalError}</Text>;
        }
        if (day.count === 0) {
            return <Text style={[styles.eventMeta, { color: tc.secondaryText }]}>{text.noEvents}</Text>;
        }
        return (
            <View style={styles.eventList}>
                {day.events.map((event) => (
                    <View key={event.key} style={styles.eventRow}>
                        <Text style={[styles.eventTitle, { color: tc.text }]} numberOfLines={1}>
                            {event.title}
                        </Text>
                        <Text style={[styles.eventMeta, { color: tc.secondaryText }]} numberOfLines={1}>
                            {event.timeLabel}
                        </Text>
                    </View>
                ))}
            </View>
        );
    };

    const renderStep = () => {
        switch (displayedStep) {
            case 'today': {
                const topTasks = getDailyReviewTodayTasks(dailyBuckets);
                const totalToday = topTasks.length;
                const calendarEventCount = todayCalendar.count + tomorrowCalendar.count;
                return renderTaskList(topTasks, {
                    testID: 'daily-review-step-scroll-today',
                    header: (
                        <>
                            <View style={[styles.infoBox, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                                <Text style={[styles.infoText, { color: tc.text }]}>
                                    <Text style={{ fontWeight: '700' }}>{totalToday}</Text> {formatListItemCountNoun(totalToday, 'task', t)}
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
                                                {todayCalendar.title}
                                            </Text>
                                            {renderExternalEventList(todayCalendar)}
                                        </View>
                                        <View style={[styles.calendarCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                                            <Text style={[styles.calendarCardTitle, { color: tc.secondaryText }]}>
                                                {tomorrowCalendar.title}
                                            </Text>
                                            {renderExternalEventList(tomorrowCalendar)}
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
                return renderTaskList(focusCandidates, {
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
                                {text.focusEmpty}
                            </Text>
                        </View>
                    ),
                });
            case 'inbox':
                return renderTaskList(inboxTasks, {
                    testID: 'daily-review-step-scroll-inbox',
                    header: (
                        <>
                            <View style={[styles.infoBox, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                                <Text style={[styles.infoText, { color: tc.text }]}>
                                    <Text style={{ fontWeight: '700' }}>{inboxTasks.length}</Text> {formatListItemCountNoun(inboxTasks.length, 'task', t)}
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
                return renderTaskList(waitingTasks, {
                    testID: 'daily-review-step-scroll-waiting',
                    showFollowUpToday: true,
                    header: (
                        <View style={[styles.infoBox, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                            <Text style={[styles.infoText, { color: tc.text }]}>
                                <Text style={{ fontWeight: '700' }}>{waitingTasks.length}</Text> {formatListItemCountNoun(waitingTasks.length, 'task', t)}
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
                    <ScrollView
                        testID="daily-review-completed-scroll"
                        style={styles.taskList}
                        contentContainerStyle={styles.centerContent}
                        showsVerticalScrollIndicator={false}
                    >
                        <CheckCircle2 size={56} color={tc.tint} strokeWidth={1.5} style={styles.bigIcon} />
                        <Text style={[styles.description, { color: tc.secondaryText }]}>{t('dailyReview.completeDesc')}</Text>
                    </ScrollView>
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
                <SandboxWorkspaceCue />
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
                            {formatDailyReviewStepLabel(t, safeActiveStepIndex, activeSteps.length)}
                        </Text>
                    </View>
                    <View style={{ width: 28 }} />
                </View>

                <View style={styles.content}>{renderStep()}</View>

                <ToastViewport inline />

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
                    {displayedStep === 'completed' ? (
                        <TouchableOpacity
                            onPress={finishReview}
                            accessibilityRole="button"
                            accessibilityLabel={t('review.finish')}
                            style={[styles.footerButton, { backgroundColor: filledButton.backgroundColor }]}
                        >
                            <Text style={[styles.footerPrimaryText, { color: filledButton.textColor ?? tc.onTint }]}>
                                {t('review.finish')}
                            </Text>
                        </TouchableOpacity>
                    ) : (
                        <>
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
                        </>
                    )}
                </View>
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
        flexGrow: 1,
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
