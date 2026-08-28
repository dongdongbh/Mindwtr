import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { formatI18nTemplate, safeFormatDate, safeParseDate, type Task } from '@mindwtr/core';
import {
    Brain,
    Calendar as CalendarIcon,
    CheckCircle2,
    ChevronDown,
    ChevronRight,
    Clock,
    FolderOpen,
    History,
    Inbox,
    Lightbulb,
    PartyPopper,
    Play,
    Sparkles,
    Tag,
    X,
} from 'lucide-react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { useLanguage } from '../contexts/language-context';
import { ToastViewport } from '../contexts/toast-context';
import { AppPressable } from './app-pressable';
import { CompactText } from './compact-text';
import { SwipeableTaskItem, type TaskRowActions } from './swipeable-task-item';
import { TaskEditModal } from './task-edit-modal';
import { InboxProcessingModal } from './inbox-processing-modal';
import { MindSweepModalContent } from './mind-sweep-modal-content';
import { ErrorBoundary } from './ErrorBoundary';
import {
    type CalendarTaskReviewEntry,
    type ContextReviewGroup,
    type ExternalCalendarDaySummary,
    useReviewModalController,
} from './review/useReviewModalController';
import { styles } from './review-modal.styles';
import { useFilledButtonColors } from '@/hooks/use-filled-button-colors';

interface ReviewModalProps {
    visible: boolean;
    onClose: () => void;
}

export const checkReviewTime = () => true;

export function ReviewModal({ visible, onClose }: ReviewModalProps) {
    const { t } = useLanguage();
    const filledButton = useFilledButtonColors();
    const [showInboxProcessing, setShowInboxProcessing] = useState(false);
    const [showMindSweep, setShowMindSweep] = useState(false);
    const [showScheduledWaiting, setShowScheduledWaiting] = useState(false);
    const [showScheduledSomeday, setShowScheduledSomeday] = useState(false);
    const {
        aiEnabled,
        aiError,
        aiLoading,
        aiRan,
        aiSelectedIds,
        aiSuggestions,
        applyAiSuggestions,
        calendarReviewItems,
        canGoBack,
        closeEditModal,
        closeProjectTaskPrompt,
        contextReviewGroups,
        currentStep,
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
        staleProjectItems,
        staleTasks,
        safeStepIndex,
        scheduledSomedayTasks,
        scheduledWaitingTasks,
        setProjectTaskTitle,
        showEditModal,
        somedayTasks,
        staleItemTitleMap,
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
    } = useReviewModalController({ visible, onClose });
    const closeLabel = t('common.close');
    const closeText = closeLabel && closeLabel !== 'common.close' ? closeLabel : 'Close';
    const onFilled = filledButton.textColor ?? tc.onTint;

    // Every step's rows share one actions object so stepping through the review
    // does not hand each row a fresh set of arrows (#766). The handlers come
    // from the controller, so they are read through a ref rather than closed over.
    const rowSourcesRef = useRef({ handleTaskPress, handleStatusChange, handleDelete });
    rowSourcesRef.current = { handleTaskPress, handleStatusChange, handleDelete };
    const rowActions = useMemo<TaskRowActions>(() => ({
        edit: (task) => rowSourcesRef.current.handleTaskPress(task),
        changeStatus: (task, status) => rowSourcesRef.current.handleStatusChange(task.id, status),
        remove: (task) => rowSourcesRef.current.handleDelete(task.id),
    }), []);

    useEffect(() => {
        if (!visible && showInboxProcessing) {
            setShowInboxProcessing(false);
        }
        if (!visible && showMindSweep) {
            setShowMindSweep(false);
        }
    }, [showInboxProcessing, showMindSweep, visible]);

    const renderSummaryRow = (good: boolean, text: string) => (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            {good
                ? <CheckCircle2 size={16} color={tc.success} strokeWidth={2.2} />
                : <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tc.warning }} />}
            <Text style={{ flex: 1, fontSize: 14, color: good ? tc.secondaryText : tc.text }}>
                {text}
            </Text>
        </View>
    );

    const renderMindSweepNudge = () => (
        <View style={[styles.mindSweepNudge, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            <View style={styles.mindSweepNudgeText}>
                <Text style={[styles.mindSweepNudgeTitle, { color: tc.text }]}>{t('mindSweep.title')}</Text>
                <Text style={[styles.mindSweepNudgeBody, { color: tc.secondaryText }]}>
                    {t('mindSweep.intro')}
                </Text>
            </View>
            <TouchableOpacity
                testID="review-mind-sweep-button"
                style={[styles.mindSweepNudgeButton, { borderColor: tc.tint }]}
                onPress={() => setShowMindSweep(true)}
                accessibilityRole="button"
                accessibilityLabel={t('mindSweep.launchButton')}
            >
                <Brain size={16} color={tc.tint} strokeWidth={2.2} />
                <Text style={[styles.mindSweepNudgeButtonText, { color: tc.tint }]}>
                    {t('mindSweep.launchButton')}
                </Text>
            </TouchableOpacity>
        </View>
    );

    const renderStepRail = () => (
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={[styles.stepRail, { borderBottomColor: tc.border }]}
            contentContainerStyle={styles.stepRailContent}
        >
            {steps.map((step, index) => {
                const skipped = !step.hasWork && step.id !== 'completed';
                const complete = skipped || index < safeStepIndex;
                const current = step.id === currentStep;
                return (
                    <View
                        key={step.id}
                        style={[
                            styles.stepRailItem,
                            {
                                backgroundColor: current
                                    ? `${tc.tint}1A`
                                    : complete
                                        ? `${tc.success}1A`
                                        : tc.filterBg,
                                borderColor: current
                                    ? tc.tint
                                    : complete
                                        ? `${tc.success}66`
                                        : tc.border,
                            },
                        ]}
                    >
                        <View
                            style={[
                                styles.stepRailBadge,
                                {
                                    backgroundColor: current ? tc.tint : tc.cardBg,
                                },
                            ]}
                        >
                            {complete ? (
                                <CheckCircle2 size={12} color={tc.text} strokeWidth={2.8} />
                            ) : (
                                <Text style={[styles.stepRailBadgeText, { color: current ? tc.onTint : tc.text }]}>{index + 1}</Text>
                            )}
                        </View>
                        <CompactText
                            style={[
                                styles.stepRailText,
                                { color: current ? tc.text : tc.secondaryText },
                            ]}
                            numberOfLines={1}
                        >
                            {step.title}
                        </CompactText>
                    </View>
                );
            })}
        </ScrollView>
    );

    const renderTaskList = (
        taskList: Task[],
        footer?: React.ReactElement | null,
        header?: React.ReactElement | null,
        empty?: React.ReactElement | null,
        testID?: string,
    ) => (
        <FlatList
            testID={testID}
            data={taskList}
            renderItem={({ item: task }) => (
                <SwipeableTaskItem
                    task={task}
                    isDark={isDark}
                    tc={tc}
                    actions={rowActions}
                />
            )}
            keyExtractor={(task) => task.id}
            style={styles.taskList}
            contentContainerStyle={styles.taskListContent}
            ListHeaderComponent={header ?? null}
            ListFooterComponent={footer ?? null}
            ListEmptyComponent={empty ?? null}
            initialNumToRender={12}
            maxToRenderPerBatch={12}
            windowSize={5}
            updateCellsBatchingPeriod={50}
            removeClippedSubviews={false}
            showsVerticalScrollIndicator={false}
        />
    );

    const renderScheduledGroup = (scheduled: Task[], expanded: boolean, onToggle: () => void) => {
        if (scheduled.length === 0) return null;
        const Chevron = expanded ? ChevronDown : ChevronRight;
        return (
            <View style={styles.scheduledSection}>
                <AppPressable
                    style={styles.scheduledToggle}
                    onPress={onToggle}
                    accessibilityRole="button"
                    accessibilityLabel={`${labels.notDueYet} (${scheduled.length})`}
                >
                    <Chevron size={14} color={tc.secondaryText} strokeWidth={2.2} />
                    <Text style={[styles.scheduledToggleText, { color: tc.secondaryText }]}>
                        {labels.notDueYet} ({scheduled.length})
                    </Text>
                </AppPressable>
                {expanded && scheduled.map((task) => (
                    <SwipeableTaskItem
                        key={task.id}
                        task={task}
                        isDark={isDark}
                        tc={tc}
                        actions={rowActions}
                    />
                ))}
            </View>
        );
    };

    const renderExternalCalendarList = (days: ExternalCalendarDaySummary[]) => {
        if (externalCalendarLoading) {
            return (
                <View style={styles.loadingRow}>
                    <ActivityIndicator size="small" color={tc.tint} />
                    <Text style={[styles.calendarEventMeta, { color: tc.secondaryText }]}>{labels.loading}</Text>
                </View>
            );
        }
        if (externalCalendarError) {
            return <Text style={[styles.calendarEventMeta, { color: tc.secondaryText }]}>{externalCalendarError}</Text>;
        }
        if (days.length === 0) {
            return <Text style={[styles.calendarEventMeta, { color: tc.secondaryText }]}>{labels.calendarEmpty}</Text>;
        }
        return (
            <View style={styles.calendarEventList}>
                {days.map((day) => {
                    const dayKey = day.dayStart.toISOString();
                    const isExpanded = expandedExternalDays.has(dayKey);
                    const visibleEvents = isExpanded ? day.events : day.events.slice(0, 2);

                    return (
                        <View key={dayKey} style={[styles.calendarDayCard, { borderColor: tc.border }]}>
                            <Text style={[styles.calendarDayTitle, { color: tc.secondaryText }]}>
                                {safeFormatDate(day.dayStart, 'EEEE, PP')} · {day.totalCount}
                            </Text>
                            {visibleEvents.map((event) => {
                                const start = safeParseDate(event.start);
                                const timeLabel = event.allDay || !start ? labels.allDay : safeFormatDate(start, 'p');
                                return (
                                    <View key={`${event.sourceId}-${event.id}-${event.start}`} style={styles.calendarEventRow}>
                                        <Text style={[styles.calendarEventMeta, { color: tc.secondaryText }]}>
                                            {timeLabel}
                                        </Text>
                                        <Text style={[styles.calendarEventTitle, { color: tc.text }]} numberOfLines={1}>
                                            {event.title}
                                        </Text>
                                    </View>
                                );
                            })}
                            {day.totalCount > 2 && (
                                <TouchableOpacity onPress={() => toggleExternalDayExpanded(dayKey)}>
                                    <Text style={[styles.calendarEventMeta, styles.calendarToggleText, { color: tc.secondaryText }]}>
                                        {isExpanded ? labels.less : `+${day.totalCount - visibleEvents.length} ${labels.more}`}
                                    </Text>
                                </TouchableOpacity>
                            )}
                        </View>
                    );
                })}
            </View>
        );
    };

    const renderCalendarTaskList = (items: CalendarTaskReviewEntry[]) => {
        if (items.length === 0) {
            return <Text style={[styles.calendarEventMeta, { color: tc.secondaryText }]}>{labels.calendarTasksEmpty}</Text>;
        }
        return (
            <View style={styles.calendarEventList}>
                {items.slice(0, 12).map((entry) => (
                    <View
                        key={`${entry.kind}-${entry.task.id}-${entry.date.toISOString()}`}
                        style={[styles.calendarDayCard, { borderColor: tc.border }]}
                    >
                        <Text style={[styles.calendarEventTitle, { color: tc.text }]} numberOfLines={1}>
                            {entry.task.title}
                        </Text>
                        <Text style={[styles.calendarEventMeta, { color: tc.secondaryText }]}>
                            {(entry.kind === 'due' ? labels.dueLabel : labels.startLabel)} · {safeFormatDate(entry.date, 'Pp')}
                        </Text>
                    </View>
                ))}
            </View>
        );
    };

    const renderContextsList = (groups: ContextReviewGroup[]) => {
        if (groups.length === 0) {
            return (
                <View style={styles.emptyState}>
                    <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
                        {labels.contextsEmpty}
                    </Text>
                </View>
            );
        }
        return (
            <FlatList
                data={groups}
                renderItem={({ item: group }) => {
                    const contextKey = group.context;
                    const isExpanded = expandedContextGroups.has(contextKey);
                    const visibleTasks = isExpanded ? group.tasks : group.tasks.slice(0, 4);
                    return (
                        <View style={[styles.contextGroupCard, { borderColor: tc.border, backgroundColor: tc.cardBg }]}>
                            <View style={styles.contextGroupHeader}>
                                <Text style={[styles.contextGroupTitle, { color: tc.text }]}>{group.context}</Text>
                                <Text style={[styles.contextGroupCount, { color: tc.secondaryText }]}>{group.tasks.length}</Text>
                            </View>
                            {visibleTasks.map((task) => (
                                <TouchableOpacity
                                    key={`${group.context}-${task.id}`}
                                    style={[styles.contextTaskRow, { borderTopColor: tc.border }]}
                                    onPress={() => handleTaskPress(task)}
                                >
                                    <Text style={[styles.contextTaskTitle, { color: tc.text }]} numberOfLines={1}>
                                        {task.title}
                                    </Text>
                                </TouchableOpacity>
                            ))}
                            {group.tasks.length > 4 && (
                                <TouchableOpacity onPress={() => toggleContextGroupExpanded(contextKey)}>
                                    <Text style={[styles.contextMoreText, { color: tc.secondaryText }]}>
                                        {isExpanded ? labels.less : `+${group.tasks.length - visibleTasks.length} ${labels.more}`}
                                    </Text>
                                </TouchableOpacity>
                            )}
                        </View>
                    );
                }}
                keyExtractor={(group) => group.context}
                style={styles.taskList}
                initialNumToRender={12}
                maxToRenderPerBatch={12}
                windowSize={5}
                updateCellsBatchingPeriod={50}
                removeClippedSubviews={false}
                showsVerticalScrollIndicator={false}
            />
        );
    };

    const renderStepContent = () => {
        switch (currentStep) {
            case 'inbox':
                return renderTaskList(
                    inboxTasks,
                    null,
                    <>
                        <View style={styles.stepTitleRow}>
                            <Inbox size={22} color={tc.text} strokeWidth={2} />
                            <Text style={[styles.stepTitleInline, { color: tc.text }]}>
                                {labels.inboxDesc}
                            </Text>
                        </View>
                        <View style={[styles.infoBox, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                            <Text style={[styles.infoText, { color: tc.text }]}>
                                <Text style={{ fontWeight: '700' }}>{inboxTasks.length}</Text> {labels.itemsInInbox}
                            </Text>
                            <Text style={[styles.guideText, { color: tc.secondaryText }]}>
                                {labels.inboxGuide}
                            </Text>
                        </View>
                        {renderMindSweepNudge()}
                        {inboxTasks.length > 0 && (
                            <TouchableOpacity
                                style={[styles.processButton, { backgroundColor: filledButton.backgroundColor }]}
                                onPress={() => setShowInboxProcessing(true)}
                                hitSlop={8}
                                accessibilityRole="button"
                                accessibilityLabel={t('inbox.processButton')}
                            >
                                <Play size={14} color={onFilled} strokeWidth={2.5} fill={onFilled} />
                                <Text style={[styles.processButtonText, { color: onFilled }]}>
                                    {t('inbox.processButton')}
                                </Text>
                            </TouchableOpacity>
                        )}
                    </>,
                    <View style={styles.emptyState}>
                        <CheckCircle2 size={48} color={tc.secondaryText} strokeWidth={1.5} style={styles.emptyIcon} />
                        <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
                            {labels.inboxEmpty}
                        </Text>
                    </View>,
                    'review-step-scroll',
                );

            case 'stale':
                return (
                    <View style={styles.stepContent}>
                        <View style={styles.stepTitleRow}>
                            <History size={22} color={tc.text} strokeWidth={2} />
                            <Text style={[styles.stepTitleInline, { color: tc.text }]}>
                                {labels.stale}
                            </Text>
                        </View>
                        <Text style={[styles.hint, { color: tc.secondaryText }]}>
                            {labels.staleDesc}
                        </Text>
                        <ScrollView style={styles.taskList}>
                            {staleTasks.map((task) => (
                                <SwipeableTaskItem
                                    key={task.id}
                                    task={task}
                                    isDark={isDark}
                                    tc={tc}
                                    actions={rowActions}
                                />
                            ))}
                            {staleProjectItems.map((item) => (
                                <View key={item.id} style={[styles.calendarDayCard, { borderColor: tc.border }]}>
                                    <Text style={[styles.calendarEventTitle, { color: tc.text }]} numberOfLines={1}>
                                        {item.title}
                                    </Text>
                                    <Text style={[styles.calendarEventMeta, { color: tc.secondaryText }]}>
                                        {formatI18nTemplate(labels.staleDaysInactive, { days: item.daysStale })}
                                    </Text>
                                </View>
                            ))}
                            {aiEnabled && (
                                <>
                                    <View style={[styles.stepTitleRow, { marginTop: 16 }]}>
                                        <Sparkles size={18} color={tc.text} strokeWidth={2} />
                                        <Text style={[styles.hint, { color: tc.secondaryText }]}>
                                            {labels.aiDesc}
                                        </Text>
                                    </View>
                                    <TouchableOpacity
                                        style={[styles.primaryButton, { backgroundColor: filledButton.backgroundColor, marginTop: 12 }]}
                                        onPress={runAiAnalysis}
                                        disabled={aiLoading}
                                    >
                                        <Text style={[styles.primaryButtonText, { color: onFilled }]}>
                                            {aiLoading ? labels.aiRunning : labels.aiRun}
                                        </Text>
                                    </TouchableOpacity>

                                    {aiError && (
                                        <Text style={[styles.hint, { color: '#EF4444', marginTop: 12 }]}>
                                            {aiError}
                                        </Text>
                                    )}

                                    {aiRan && !aiLoading && aiSuggestions.length === 0 && !aiError && (
                                        <Text style={[styles.hint, { color: tc.secondaryText, marginTop: 12 }]}>
                                            {labels.aiEmpty}
                                        </Text>
                                    )}

                                    {aiSuggestions.map((suggestion) => {
                                    const actionable = isActionableSuggestion(suggestion);
                                    const label = suggestion.action === 'someday'
                                        ? labels.aiActionSomeday
                                        : suggestion.action === 'archive'
                                            ? labels.aiActionArchive
                                            : suggestion.action === 'breakdown'
                                                ? labels.aiActionBreakdown
                                                : labels.aiActionKeep;
                                    return (
                                        <TouchableOpacity
                                            key={suggestion.id}
                                            style={[styles.aiItemRow, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                            onPress={() => actionable && toggleSuggestion(suggestion.id)}
                                            disabled={!actionable}
                                        >
                                            <View
                                                style={[
                                                    styles.aiCheckbox,
                                                    {
                                                        borderColor: tc.border,
                                                        backgroundColor: aiSelectedIds.has(suggestion.id) ? tc.tint : 'transparent',
                                                    },
                                                ]}
                                            >
                                                {aiSelectedIds.has(suggestion.id) && <Text style={[styles.aiCheckboxText, { color: tc.onTint }]}>✓</Text>}
                                            </View>
                                            <View style={{ flex: 1 }}>
                                                <Text style={[styles.aiItemTitle, { color: tc.text }]}>
                                                    {staleItemTitleMap[suggestion.id] || suggestion.id}
                                                </Text>
                                                <Text style={[styles.aiItemMeta, { color: tc.secondaryText }]}>
                                                    {label} · {suggestion.reason}
                                                </Text>
                                            </View>
                                        </TouchableOpacity>
                                    );
                                })}
                                {aiSuggestions.length > 0 && (
                                    <TouchableOpacity
                                        style={[styles.primaryButton, { backgroundColor: filledButton.backgroundColor, marginTop: 12 }]}
                                        onPress={applyAiSuggestions}
                                        disabled={aiSelectedIds.size === 0}
                                    >
                                        <Text style={[styles.primaryButtonText, { color: onFilled }]}>
                                            {labels.aiApply} ({aiSelectedIds.size})
                                        </Text>
                                    </TouchableOpacity>
                                )}
                                </>
                            )}
                        </ScrollView>
                    </View>
                );

            case 'calendar':
                return (
                    <ScrollView
                        style={styles.stepContent}
                        contentContainerStyle={styles.calendarStepContent}
                        showsVerticalScrollIndicator
                    >
                        <View style={styles.stepTitleRow}>
                            <CalendarIcon size={22} color={tc.text} strokeWidth={2} />
                            <Text style={[styles.stepTitleInline, { color: tc.text }]}>
                                {labels.calendar}
                            </Text>
                        </View>
                        <TouchableOpacity
                            style={[styles.reviewAddTaskButton, { borderColor: tc.border }]}
                            onPress={() => openReviewQuickAdd({ status: 'inbox' })}
                        >
                            <Text style={[styles.reviewAddTaskButtonText, { color: tc.text }]}>{labels.addTask}</Text>
                        </TouchableOpacity>
                        <Text style={[styles.hint, { color: tc.secondaryText }]}>
                            {labels.calendarDesc}
                        </Text>
                        <View style={[styles.calendarColumn, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                            <Text style={[styles.calendarColumnTitle, { color: tc.secondaryText }]}>{labels.calendarUpcoming}</Text>
                            {renderExternalCalendarList(externalCalendarReviewItems)}
                        </View>
                        <View style={[styles.calendarColumn, { backgroundColor: tc.cardBg, borderColor: tc.border, marginTop: 12 }]}>
                            <Text style={[styles.calendarColumnTitle, { color: tc.secondaryText }]}>{labels.calendarTasks}</Text>
                            {renderCalendarTaskList(calendarReviewItems)}
                        </View>
                    </ScrollView>
                );

            case 'waiting':
                return (
                    <View style={styles.stepContent}>
                        <View style={styles.stepTitleRow}>
                            <Clock size={22} color={tc.text} strokeWidth={2} />
                            <Text style={[styles.stepTitleInline, { color: tc.text }]}>
                                {labels.waitingDesc}
                            </Text>
                        </View>
                        <Text style={[styles.hint, { color: tc.secondaryText }]}>
                            {labels.waitingGuide}
                        </Text>
                        {waitingTasks.length === 0 ? (
                            <View style={styles.emptyState}>
                                <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
                                    {labels.nothingWaiting}
                                </Text>
                            </View>
                        ) : (
                            renderTaskList(
                                visibleWaitingTasks,
                                renderScheduledGroup(
                                    scheduledWaitingTasks,
                                    showScheduledWaiting,
                                    () => setShowScheduledWaiting((prev) => !prev),
                                ),
                            )
                        )}
                    </View>
                );

            case 'contexts':
                return (
                    <View style={styles.stepContent}>
                        <View style={styles.stepTitleRow}>
                            <Tag size={22} color={tc.text} strokeWidth={2} />
                            <Text style={[styles.stepTitleInline, { color: tc.text }]}>
                                {labels.contexts}
                            </Text>
                        </View>
                        <Text style={[styles.hint, { color: tc.secondaryText }]}>
                            {labels.contextsDesc}
                        </Text>
                        {renderContextsList(contextReviewGroups)}
                    </View>
                );

            case 'projects':
                return (
                    <View style={styles.stepContent}>
                        <View style={styles.stepTitleRow}>
                            <FolderOpen size={22} color={tc.text} strokeWidth={2} />
                            <Text style={[styles.stepTitleInline, { color: tc.text }]}>
                                {labels.projectsDesc}
                            </Text>
                        </View>
                        <Text style={[styles.hint, { color: tc.secondaryText }]}>
                            {labels.projectsGuide}
                        </Text>
                        {projectReviewEntries.length === 0 ? (
                            <View style={styles.emptyState}>
                                <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
                                    {labels.noActiveProjects}
                                </Text>
                            </View>
                        ) : (
                            <FlatList
                                data={projectReviewEntries}
                                renderItem={({ item: entry }) => {
                                    const isExpanded = expandedProject === entry.project.id;
                                    return (
                                        <View>
                                            <TouchableOpacity
                                                style={[styles.projectItem, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                                onPress={() => toggleExpandedProject(entry.project.id)}
                                            >
                                                <View style={styles.projectHeader}>
                                                    <View style={[styles.projectDot, { backgroundColor: entry.areaColor }]} />
                                                    <Text style={[styles.projectTitle, { color: tc.text }]}>{entry.project.title}</Text>
                                                    <TouchableOpacity
                                                        style={[styles.reviewProjectAddTaskButton, { borderColor: tc.border }]}
                                                        onPress={(event) => {
                                                            event.stopPropagation();
                                                            openProjectTaskPrompt(entry.project.id, entry.project.title);
                                                        }}
                                                    >
                                                        <Text style={[styles.reviewProjectAddTaskButtonText, { color: tc.text }]}>
                                                            {labels.addTask}
                                                        </Text>
                                                    </TouchableOpacity>
                                                    <View
                                                        style={[styles.statusBadge, {
                                                            backgroundColor: entry.nextActionState === 'next'
                                                                ? '#10B98120'
                                                                // Delegated (waiting) is amber, not the red alarm (#1086).
                                                                : entry.nextActionState === 'waiting' ? '#F59E0B20' : '#EF444420',
                                                        }]}
                                                    >
                                                        <Text
                                                            style={[styles.statusText, {
                                                                color: entry.nextActionState === 'next'
                                                                    ? '#10B981'
                                                                    : entry.nextActionState === 'waiting' ? '#F59E0B' : '#EF4444',
                                                            }]}
                                                        >
                                                            {entry.nextActionState === 'next'
                                                                ? labels.hasNext
                                                                : entry.nextActionState === 'waiting' ? labels.waitingStatus : labels.needsAction}
                                                        </Text>
                                                    </View>
                                                </View>
                                                <View style={styles.projectMeta}>
                                                    <Text style={[styles.taskCount, { color: tc.secondaryText }]}>
                                                        {entry.tasks.length} {labels.activeTasks}
                                                    </Text>
                                                    <Text style={[styles.expandIcon, { color: tc.secondaryText }]}>
                                                        {isExpanded ? '▾' : '▸'}
                                                    </Text>
                                                </View>
                                            </TouchableOpacity>
                                            {isExpanded && entry.tasks.length > 0 && (
                                                <View style={styles.projectTasks}>
                                                    {entry.tasks.map((task) => (
                                                        <SwipeableTaskItem
                                                            key={task.id}
                                                            task={task}
                                                            isDark={isDark}
                                                            tc={tc}
                                                            actions={rowActions}
                                                        />
                                                    ))}
                                                </View>
                                            )}
                                        </View>
                                    );
                                }}
                                keyExtractor={(entry) => entry.project.id}
                                style={styles.taskList}
                                initialNumToRender={12}
                                maxToRenderPerBatch={12}
                                windowSize={5}
                                updateCellsBatchingPeriod={50}
                                removeClippedSubviews={false}
                                showsVerticalScrollIndicator={false}
                            />
                        )}
                    </View>
                );

            case 'someday':
                return (
                    <View style={styles.stepContent}>
                        <View style={styles.stepTitleRow}>
                            <Lightbulb size={22} color={tc.text} strokeWidth={2} />
                            <Text style={[styles.stepTitleInline, { color: tc.text }]}>
                                {labels.somedayDesc}
                            </Text>
                        </View>
                        <Text style={[styles.hint, { color: tc.secondaryText }]}>
                            {labels.somedayGuide}
                        </Text>
                        {somedayTasks.length === 0 ? (
                            <View style={styles.emptyState}>
                                <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
                                    {labels.listEmpty}
                                </Text>
                            </View>
                        ) : (
                            renderTaskList(
                                visibleSomedayTasks,
                                renderScheduledGroup(
                                    scheduledSomedayTasks,
                                    showScheduledSomeday,
                                    () => setShowScheduledSomeday((prev) => !prev),
                                ),
                            )
                        )}
                    </View>
                );

            case 'completed':
                return (
                    <View style={styles.centerContent}>
                        <PartyPopper size={64} color={tc.tint} strokeWidth={1.5} style={styles.bigIcon} />
                        <Text style={[styles.heading, { color: tc.text }]}>
                            {labels.reviewComplete}
                        </Text>
                        <Text style={[styles.description, { color: tc.secondaryText }]}>
                            {labels.completeDesc}
                        </Text>
                        <View style={{ alignSelf: 'stretch', borderWidth: 1, borderColor: tc.border, borderRadius: 10, padding: 14, gap: 10, marginBottom: 16 }}>
                            {renderSummaryRow(
                                reviewSummary.inboxCount === 0,
                                reviewSummary.inboxCount === 0
                                    ? labels.summaryInboxEmpty
                                    : formatI18nTemplate(labels.summaryInboxCount, { count: reviewSummary.inboxCount }),
                            )}
                            {reviewSummary.activeProjectCount > 0 && renderSummaryRow(
                                reviewSummary.projectsWithoutNextAction === 0,
                                reviewSummary.projectsWithoutNextAction === 0
                                    ? labels.summaryProjectsOk
                                    : formatI18nTemplate(labels.summaryProjectsMissing, { count: reviewSummary.projectsWithoutNextAction }),
                            )}
                            {reviewSummary.staleWaitingCount > 0 && renderSummaryRow(
                                false,
                                formatI18nTemplate(labels.summaryWaitingStale, { count: reviewSummary.staleWaitingCount }),
                            )}
                        </View>
                        {renderMindSweepNudge()}
                        <TouchableOpacity style={[styles.primaryButton, { backgroundColor: filledButton.backgroundColor }]} onPress={handleFinish}>
                            <Text style={[styles.primaryButtonText, { color: onFilled }]}>
                                {labels.finish}
                            </Text>
                        </TouchableOpacity>
                    </View>
                );
        }
    };

    return (
        <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" allowSwipeDismissal onRequestClose={handleClose}>
            <GestureHandlerRootView style={{ flex: 1 }}>
                <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['top', 'bottom']}>
                    <View style={[styles.header, { borderBottomColor: tc.border }]}>
                        <TouchableOpacity
                            onPress={handleClose}
                            style={styles.closeButton}
                            accessibilityRole="button"
                            accessibilityLabel={closeText}
                            hitSlop={8}
                        >
                            <X size={22} color={tc.text} strokeWidth={2} />
                        </TouchableOpacity>
                        <View style={styles.headerTitleRow}>
                            {(() => {
                                const HeaderIcon = steps[safeStepIndex].Icon;
                                return <HeaderIcon size={18} color={tc.text} strokeWidth={2} />;
                            })()}
                            <Text style={[styles.headerTitle, { color: tc.text }]}>
                                {steps[safeStepIndex].title}
                            </Text>
                        </View>
                        <Text style={[styles.stepIndicator, { color: tc.secondaryText }]}>
                            {safeStepIndex + 1}/{steps.length}
                        </Text>
                    </View>

                    <View style={[styles.progressContainer, { backgroundColor: tc.border }]}>
                        <View style={[styles.progressBar, { width: `${progress}%` }]} />
                    </View>
                    {renderStepRail()}

                    <View style={styles.content}>
                        {renderStepContent()}
                    </View>

                    {currentStep !== 'completed' && (
                        <View style={[styles.footer, { borderTopColor: tc.border }]}>
                            <TouchableOpacity
                                style={[styles.backButton, { opacity: canGoBack ? 1 : 0.5 }]}
                                onPress={prevStep}
                                disabled={!canGoBack}
                                accessibilityState={{ disabled: !canGoBack }}
                            >
                                <Text style={[styles.backButtonText, { color: tc.secondaryText }]}>← {labels.back}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={[styles.primaryButton, { backgroundColor: filledButton.backgroundColor }]} onPress={nextStep}>
                                <Text style={[styles.primaryButtonText, { color: onFilled }]}>{labels.next} →</Text>
                            </TouchableOpacity>
                        </View>
                    )}
                </SafeAreaView>

                <TaskEditModal
                    visible={showEditModal}
                    task={editingTask}
                    onClose={closeEditModal}
                    onSave={handleSaveTask}
                    defaultTab={editModalTab}
                    onProjectNavigate={handleNavigateToProject}
                    onContextNavigate={handleNavigateToToken}
                    onTagNavigate={handleNavigateToToken}
                />

                <ErrorBoundary>
                    <InboxProcessingModal
                        visible={visible && showInboxProcessing}
                        onClose={() => setShowInboxProcessing(false)}
                    />
                </ErrorBoundary>

                <Modal
                    visible={visible && showMindSweep}
                    animationType="slide"
                    presentationStyle="pageSheet"
                    onRequestClose={() => setShowMindSweep(false)}
                >
                    <MindSweepModalContent onClose={() => setShowMindSweep(false)} />
                </Modal>

                <Modal
                    visible={Boolean(projectTaskPrompt)}
                    transparent
                    animationType="fade"
                    onRequestClose={closeProjectTaskPrompt}
                >
                    <View style={styles.promptBackdrop}>
                        <View style={[styles.promptCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                            <Text style={[styles.promptTitle, { color: tc.text }]}>{labels.addTask}</Text>
                            <Text style={[styles.promptProject, { color: tc.secondaryText }]}>
                                {projectTaskPrompt?.projectTitle}
                            </Text>
                            <TextInput
                                value={projectTaskTitle}
                                onChangeText={setProjectTaskTitle}
                                placeholder={labels.addTaskPlaceholder}
                                placeholderTextColor={tc.secondaryText}
                                autoFocus
                                style={[styles.promptInput, { color: tc.text, borderColor: tc.border, backgroundColor: tc.bg }]}
                                returnKeyType="done"
                                onSubmitEditing={() => {
                                    void submitProjectTask();
                                }}
                            />
                            <View style={styles.promptActions}>
                                <TouchableOpacity
                                    style={[styles.promptButton, { borderColor: tc.border }]}
                                    onPress={closeProjectTaskPrompt}
                                >
                                    <Text style={[styles.promptButtonText, { color: tc.text }]}>{labels.cancel}</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={[
                                        styles.promptButton,
                                        {
                                            borderColor: tc.border,
                                            opacity: projectTaskTitle.trim().length > 0 ? 1 : 0.5,
                                        },
                                    ]}
                                    onPress={() => {
                                        void submitProjectTask({ openEditor: true });
                                    }}
                                    disabled={projectTaskTitle.trim().length === 0}
                                >
                                    <Text style={[styles.promptButtonText, { color: tc.text }]}>{labels.saveAndEdit}</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={[
                                        styles.promptButtonPrimary,
                                        {
                                            backgroundColor: filledButton.backgroundColor,
                                            opacity: projectTaskTitle.trim().length > 0 ? 1 : 0.5,
                                        },
                                    ]}
                                    onPress={() => {
                                        void submitProjectTask();
                                    }}
                                    disabled={projectTaskTitle.trim().length === 0}
                                >
                                    <Text style={[styles.promptButtonPrimaryText, { color: onFilled }]}>{labels.add}</Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    </View>
                </Modal>
                <ToastViewport />
            </GestureHandlerRootView>
        </Modal>
    );
}
