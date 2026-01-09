import { useMemo, useState } from 'react';
import { View, Text, Modal, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { useTaskStore, isDueForReview, safeParseDate, safeParseDueDate, sortTasksBy, type Task, type TaskSortBy, type TaskStatus } from '@mindwtr/core';

import { useTheme } from '../contexts/theme-context';
import { useLanguage } from '../contexts/language-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { SwipeableTaskItem } from './swipeable-task-item';
import { TaskEditModal } from './task-edit-modal';
import { InboxProcessingModal } from './inbox-processing-modal';

type DailyReviewStep = 'intro' | 'today' | 'focus' | 'inbox' | 'waiting' | 'complete';

interface DailyReviewModalProps {
    visible: boolean;
    onClose: () => void;
}

function isSameDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function DailyReviewFlow({ onClose }: { onClose: () => void }) {
    const { tasks, settings, updateTask, deleteTask } = useTaskStore();
    const { isDark } = useTheme();
    const { t } = useLanguage();
    const tc = useThemeColors();

    const [currentStep, setCurrentStep] = useState<DailyReviewStep>('intro');
    const [editingTask, setEditingTask] = useState<Task | null>(null);
    const [isTaskModalVisible, setIsTaskModalVisible] = useState(false);
    const [showInboxProcessing, setShowInboxProcessing] = useState(false);

    const sortBy = (settings?.taskSortBy ?? 'default') as TaskSortBy;

    const today = useMemo(() => new Date(), []);

    const activeTasks = useMemo(
        () => tasks.filter((task) => !task.deletedAt && task.status !== 'done'),
        [tasks],
    );

    const inboxTasks = useMemo(() => {
        const now = new Date();
        return activeTasks.filter((task) => {
            if (task.status !== 'inbox') return false;
            const start = safeParseDate(task.startTime);
            if (start && start > now) return false;
            return true;
        });
    }, [activeTasks]);

    const focusedTasks = useMemo(
        () => activeTasks.filter((task) => task.isFocusedToday && task.status !== 'done'),
        [activeTasks],
    );

    const focusCandidates = useMemo(() => {
        const now = new Date();
        const todayStr = now.toDateString();
        const byId = new Map<string, Task>();
        const addCandidate = (task: Task) => {
            if (!byId.has(task.id)) byId.set(task.id, task);
        };
        activeTasks.forEach((task) => {
            if (task.isFocusedToday) addCandidate(task);
            const due = safeParseDueDate(task.dueDate);
            if (due && (due < now || due.toDateString() === todayStr)) {
                addCandidate(task);
                return;
            }
            if (task.status === 'next') {
                const start = safeParseDate(task.startTime);
                if (start && start > now) return;
                addCandidate(task);
                return;
            }
            if ((task.status === 'waiting' || task.status === 'someday') && isDueForReview(task.reviewAt, now)) {
                addCandidate(task);
            }
        });
        return sortTasksBy(Array.from(byId.values()), sortBy);
    }, [activeTasks, sortBy]);

    const dueTodayTasks = useMemo(() => {
        const dueToday = activeTasks.filter((task) => {
            if (task.status === 'done') return false;
            const due = safeParseDueDate(task.dueDate);
            return due ? isSameDay(due, today) : false;
        });
        return sortTasksBy(dueToday, sortBy);
    }, [activeTasks, sortBy, today]);

    const overdueTasks = useMemo(() => {
        const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const overdue = activeTasks.filter((task) => {
            if (task.status === 'done') return false;
            const due = safeParseDueDate(task.dueDate);
            return due ? due < startOfToday : false;
        });
        return sortTasksBy(overdue, sortBy);
    }, [activeTasks, sortBy, today]);

    const waitingTasks = useMemo(() => {
        const waiting = activeTasks.filter((task) => task.status === 'waiting');
        return sortTasksBy(waiting, sortBy);
    }, [activeTasks, sortBy]);

    const steps: { id: DailyReviewStep; title: string; description: string }[] = [
        { id: 'intro', title: t('dailyReview.introTitle'), description: t('dailyReview.introDesc') },
        { id: 'today', title: t('dailyReview.todayStep'), description: t('dailyReview.todayDesc') },
        { id: 'focus', title: t('dailyReview.focusStep'), description: t('dailyReview.focusDesc') },
        { id: 'inbox', title: t('dailyReview.inboxStep'), description: t('dailyReview.inboxDesc') },
        { id: 'waiting', title: t('dailyReview.waitingStep'), description: t('dailyReview.waitingDesc') },
        { id: 'complete', title: t('dailyReview.completeTitle'), description: t('dailyReview.completeDesc') },
    ];

    const currentIndex = steps.findIndex((s) => s.id === currentStep);
    const progress = (currentIndex / (steps.length - 1)) * 100;

    const next = () => {
        if (currentIndex < steps.length - 1) setCurrentStep(steps[currentIndex + 1].id);
    };

    const back = () => {
        if (currentIndex > 0) setCurrentStep(steps[currentIndex - 1].id);
    };

    const openTask = (task: Task) => {
        setEditingTask(task);
        setIsTaskModalVisible(true);
    };

    const closeTask = () => {
        setIsTaskModalVisible(false);
        setEditingTask(null);
    };

    const renderTaskList = (list: Task[], options?: { showFocusToggle?: boolean; hideStatusBadge?: boolean }) => (
        <ScrollView style={styles.taskList}>
            {list.map((task) => (
                <SwipeableTaskItem
                    key={task.id}
                    task={task}
                    isDark={isDark}
                    tc={tc}
                    onPress={() => openTask(task)}
                    onStatusChange={(status) => updateTask(task.id, { status: status as TaskStatus })}
                    onDelete={() => deleteTask(task.id)}
                    showFocusToggle={options?.showFocusToggle}
                    hideStatusBadge={options?.hideStatusBadge}
                />
            ))}
        </ScrollView>
    );

    const renderStep = () => {
        switch (currentStep) {
            case 'intro':
                return (
                    <View style={styles.centerContent}>
                        <Text style={styles.bigIcon}>🧭</Text>
                        <Text style={[styles.heading, { color: tc.text }]}>{t('dailyReview.title')}</Text>
                        <Text style={[styles.description, { color: tc.secondaryText }]}>{t('dailyReview.introDesc')}</Text>
                        <TouchableOpacity style={[styles.primaryButton, { backgroundColor: tc.tint }]} onPress={next}>
                            <Text style={styles.primaryButtonText}>
                                {t('dailyReview.start')} →
                            </Text>
                        </TouchableOpacity>
                    </View>
                );
            case 'today': {
                const topTasks = [...overdueTasks, ...dueTodayTasks].slice(0, 8);
                const totalToday = overdueTasks.length + dueTodayTasks.length;
                return (
                    <View style={styles.stepContent}>
                        <Text style={[styles.stepTitle, { color: tc.text }]}>📅 {t('dailyReview.todayStep')}</Text>
                        <View style={[styles.infoBox, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                            <Text style={[styles.infoText, { color: tc.text }]}>
                                <Text style={{ fontWeight: '700' }}>{totalToday}</Text> {t('common.tasks')}
                            </Text>
                            <Text style={[styles.guideText, { color: tc.secondaryText }]}>{t('dailyReview.todayDesc')}</Text>
                        </View>
                        {topTasks.length === 0 ? (
                            <View style={styles.emptyState}>
                                <Text style={styles.emptyIcon}>✨</Text>
                                <Text style={[styles.emptyText, { color: tc.secondaryText }]}>{t('agenda.noTasks')}</Text>
                            </View>
                        ) : (
                            renderTaskList(topTasks)
                        )}
                    </View>
                );
            }
            case 'focus':
                return (
                    <View style={styles.stepContent}>
                        <Text style={[styles.stepTitle, { color: tc.text }]}>🎯 {t('dailyReview.focusStep')}</Text>
                        <View style={[styles.infoBox, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                            <Text style={[styles.infoText, { color: tc.text }]}>
                                <Text style={{ fontWeight: '700' }}>{focusedTasks.length}</Text> / 3
                            </Text>
                            <Text style={[styles.guideText, { color: tc.secondaryText }]}>{t('dailyReview.focusDesc')}</Text>
                        </View>
                        {focusCandidates.length === 0 ? (
                            <View style={styles.emptyState}>
                                <Text style={styles.emptyIcon}>⭐</Text>
                                <Text style={[styles.emptyText, { color: tc.secondaryText }]}>{t('agenda.focusHint')}</Text>
                            </View>
                        ) : (
                            renderTaskList(focusCandidates.slice(0, 8), { showFocusToggle: true, hideStatusBadge: true })
                        )}
                    </View>
                );
            case 'inbox':
                return (
                    <View style={styles.stepContent}>
                        <Text style={[styles.stepTitle, { color: tc.text }]}>📥 {t('dailyReview.inboxStep')}</Text>
                        <View style={[styles.infoBox, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                            <Text style={[styles.infoText, { color: tc.text }]}>
                                <Text style={{ fontWeight: '700' }}>{inboxTasks.length}</Text> {t('common.tasks')}
                            </Text>
                            <Text style={[styles.guideText, { color: tc.secondaryText }]}>{t('dailyReview.inboxDesc')}</Text>
                        </View>
                        {inboxTasks.length > 0 && (
                            <TouchableOpacity
                                style={[styles.processButton, { backgroundColor: tc.tint }]}
                                onPress={() => setShowInboxProcessing(true)}
                            >
                                <Text style={styles.processButtonText}>
                                    ▷ {t('inbox.processButton')}
                                </Text>
                            </TouchableOpacity>
                        )}
                        {inboxTasks.length === 0 ? (
                            <View style={styles.emptyState}>
                                <Text style={styles.emptyIcon}>✅</Text>
                                <Text style={[styles.emptyText, { color: tc.secondaryText }]}>{t('review.inboxEmpty')}</Text>
                            </View>
                        ) : (
                            renderTaskList(inboxTasks.slice(0, 8))
                        )}
                    </View>
                );
            case 'waiting':
                return (
                    <View style={styles.stepContent}>
                        <Text style={[styles.stepTitle, { color: tc.text }]}>⏳ {t('dailyReview.waitingStep')}</Text>
                        <View style={[styles.infoBox, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                            <Text style={[styles.infoText, { color: tc.text }]}>
                                <Text style={{ fontWeight: '700' }}>{waitingTasks.length}</Text> {t('common.tasks')}
                            </Text>
                            <Text style={[styles.guideText, { color: tc.secondaryText }]}>{t('dailyReview.waitingDesc')}</Text>
                        </View>
                        {waitingTasks.length === 0 ? (
                            <View style={styles.emptyState}>
                                <Text style={styles.emptyIcon}>✅</Text>
                                <Text style={[styles.emptyText, { color: tc.secondaryText }]}>{t('review.waitingEmpty')}</Text>
                            </View>
                        ) : (
                            renderTaskList(waitingTasks.slice(0, 8))
                        )}
                    </View>
                );
            case 'complete':
                return (
                    <View style={styles.centerContent}>
                        <Text style={styles.bigIcon}>✅</Text>
                        <Text style={[styles.heading, { color: tc.text }]}>{t('dailyReview.completeTitle')}</Text>
                        <Text style={[styles.description, { color: tc.secondaryText }]}>{t('dailyReview.completeDesc')}</Text>
                        <TouchableOpacity style={[styles.primaryButton, { backgroundColor: tc.tint }]} onPress={onClose}>
                            <Text style={styles.primaryButtonText}>{t('review.finish')}</Text>
                        </TouchableOpacity>
                    </View>
                );
            default:
                return null;
        }
    };

    return (
        <GestureHandlerRootView style={[styles.modalContainer, { backgroundColor: tc.bg }]}>
            <View style={[styles.header, { borderBottomColor: tc.border }]}>
                <TouchableOpacity onPress={onClose}>
                    <Text style={[styles.closeButton, { color: tc.text }]}>✕</Text>
                </TouchableOpacity>
                <View style={styles.headerCenter}>
                    <Text style={[styles.headerTitle, { color: tc.text }]}>{t('dailyReview.title')}</Text>
                    <Text style={[styles.headerStep, { color: tc.secondaryText }]}>
                        {t('review.step')} {Math.max(1, currentIndex + 1)} {t('review.of')} {steps.length}
                    </Text>
                </View>
                <View style={{ width: 28 }} />
            </View>

            <View style={[styles.progressTrack, { backgroundColor: tc.border }]}>
                <View style={[styles.progressFill, { width: `${progress}%`, backgroundColor: tc.tint }]} />
            </View>

            <View style={styles.content}>{renderStep()}</View>

            {currentStep !== 'intro' && currentStep !== 'complete' && (
                <View style={[styles.footer, { borderTopColor: tc.border, backgroundColor: tc.cardBg }]}>
                    <TouchableOpacity
                        onPress={back}
                        disabled={currentIndex === 0}
                        style={[styles.footerButton, { backgroundColor: tc.filterBg, opacity: currentIndex === 0 ? 0.5 : 1 }]}
                    >
                        <Text style={[styles.footerButtonText, { color: tc.text }]}>{t('review.back')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={next} style={[styles.footerButton, { backgroundColor: tc.tint }]}>
                        <Text style={styles.footerPrimaryText}>{t('review.nextStepBtn')}</Text>
                    </TouchableOpacity>
                </View>
            )}
            <InboxProcessingModal
                visible={showInboxProcessing}
                onClose={() => setShowInboxProcessing(false)}
            />

            <TaskEditModal
                visible={isTaskModalVisible}
                task={editingTask}
                onClose={closeTask}
                onSave={(taskId, updates) => {
                    updateTask(taskId, updates);
                    closeTask();
                }}
                defaultTab="view"
                onFocusMode={(taskId) => {
                    closeTask();
                    router.push(`/check-focus?id=${taskId}`);
                }}
            />
        </GestureHandlerRootView>
    );
}

export function DailyReviewModal({ visible, onClose }: DailyReviewModalProps) {
    return (
        <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
            <DailyReviewFlow onClose={onClose} />
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
        fontSize: 22,
        fontWeight: '300',
        width: 28,
        textAlign: 'left',
    },
    headerCenter: {
        alignItems: 'center',
        flex: 1,
    },
    headerTitle: {
        fontSize: 16,
        fontWeight: '700',
    },
    headerStep: {
        fontSize: 12,
        marginTop: 2,
    },
    progressTrack: {
        height: 3,
        width: '100%',
    },
    progressFill: {
        height: '100%',
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
        fontSize: 56,
        marginBottom: 6,
    },
    heading: {
        fontSize: 24,
        fontWeight: '800',
        textAlign: 'center',
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
        color: '#FFFFFF',
        fontSize: 16,
        fontWeight: '700',
    },
    stepContent: {
        flex: 1,
        gap: 14,
    },
    stepTitle: {
        fontSize: 18,
        fontWeight: '800',
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
    processButton: {
        alignSelf: 'flex-start',
        borderRadius: 999,
        paddingHorizontal: 14,
        paddingVertical: 8,
    },
    processButtonText: {
        color: '#FFFFFF',
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
    emptyState: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 30,
        gap: 10,
    },
    emptyIcon: {
        fontSize: 40,
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
        color: '#FFFFFF',
    },
});
