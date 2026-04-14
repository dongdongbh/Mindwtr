import React from 'react';
import { ActivityIndicator, Modal, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { safeFormatDate, safeParseDate, type Task } from '@mindwtr/core';
import {
    Calendar as CalendarIcon,
    CheckCircle2,
    Clock,
    FolderOpen,
    Inbox,
    Lightbulb,
    PartyPopper,
    Sparkles,
    Tag,
    X,
} from 'lucide-react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { SwipeableTaskItem } from './swipeable-task-item';
import { TaskEditModal } from './task-edit-modal';
import {
    type CalendarTaskReviewEntry,
    type ContextReviewGroup,
    type ExternalCalendarDaySummary,
    useReviewModalController,
} from './review/useReviewModalController';
import { styles } from './review-modal.styles';

interface ReviewModalProps {
    visible: boolean;
    onClose: () => void;
}

export const checkReviewTime = () => true;

export function ReviewModal({ visible, onClose }: ReviewModalProps) {
    const {
        aiEnabled,
        aiError,
        aiLoading,
        aiRan,
        aiSelectedIds,
        aiSuggestions,
        applyAiSuggestions,
        calendarReviewItems,
        closeEditModal,
        closeProjectTaskPrompt,
        contextReviewGroups,
        currentStep,
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
        orderedSomedayTasks,
        orderedWaitingTasks,
        prevStep,
        progress,
        projectReviewEntries,
        projectTaskPrompt,
        projectTaskTitle,
        runAiAnalysis,
        safeStepIndex,
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
        waitingTasks,
    } = useReviewModalController({ visible, onClose });

    const renderTaskList = (taskList: Task[]) => (
        <ScrollView style={styles.taskList}>
            {taskList.map((task) => (
                <SwipeableTaskItem
                    key={task.id}
                    task={task}
                    isDark={isDark}
                    tc={tc}
                    onPress={() => handleTaskPress(task)}
                    onStatusChange={(status) => handleStatusChange(task.id, status)}
                    onDelete={() => handleDelete(task.id)}
                    onProjectPress={handleNavigateToProject}
                    onContextPress={handleNavigateToToken}
                    onTagPress={handleNavigateToToken}
                />
            ))}
        </ScrollView>
    );

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
            <ScrollView style={styles.taskList}>
                {groups.map((group) => {
                    const contextKey = group.context;
                    const isExpanded = expandedContextGroups.has(contextKey);
                    const visibleTasks = isExpanded ? group.tasks : group.tasks.slice(0, 4);
                    return (
                        <View key={group.context} style={[styles.contextGroupCard, { borderColor: tc.border, backgroundColor: tc.cardBg }]}>
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
                })}
            </ScrollView>
        );
    };

    const renderStepContent = () => {
        switch (currentStep) {
            case 'inbox':
                return (
                    <View style={styles.stepContent}>
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
                        {inboxTasks.length === 0 ? (
                            <View style={styles.emptyState}>
                                <CheckCircle2 size={48} color={tc.secondaryText} strokeWidth={1.5} style={styles.emptyIcon} />
                                <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
                                    {labels.inboxEmpty}
                                </Text>
                            </View>
                        ) : (
                            renderTaskList(inboxTasks)
                        )}
                    </View>
                );

            case 'ai':
                return (
                    <View style={styles.stepContent}>
                        <View style={styles.stepTitleRow}>
                            <Sparkles size={22} color={tc.text} strokeWidth={2} />
                            <Text style={[styles.stepTitleInline, { color: tc.text }]}>
                                {labels.ai}
                            </Text>
                        </View>
                        <Text style={[styles.hint, { color: tc.secondaryText }]}>
                            {labels.aiDesc}
                        </Text>
                        <TouchableOpacity
                            style={[styles.primaryButton, { backgroundColor: tc.tint, marginTop: 12 }]}
                            onPress={runAiAnalysis}
                            disabled={aiLoading}
                        >
                            <Text style={styles.primaryButtonText}>
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

                        {aiSuggestions.length > 0 && (
                            <ScrollView style={styles.taskList}>
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
                                                {aiSelectedIds.has(suggestion.id) && <Text style={styles.aiCheckboxText}>✓</Text>}
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
                                <TouchableOpacity
                                    style={[styles.primaryButton, { backgroundColor: tc.tint, marginTop: 12 }]}
                                    onPress={applyAiSuggestions}
                                    disabled={aiSelectedIds.size === 0}
                                >
                                    <Text style={styles.primaryButtonText}>
                                        {labels.aiApply} ({aiSelectedIds.size})
                                    </Text>
                                </TouchableOpacity>
                            </ScrollView>
                        )}
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
                            renderTaskList(orderedWaitingTasks)
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
                            <ScrollView style={styles.taskList}>
                                {projectReviewEntries.map((entry) => {
                                    const isExpanded = expandedProject === entry.project.id;
                                    return (
                                        <View key={entry.project.id}>
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
                                                    <View style={[styles.statusBadge, { backgroundColor: entry.hasNextAction ? '#10B98120' : '#EF444420' }]}>
                                                        <Text style={[styles.statusText, { color: entry.hasNextAction ? '#10B981' : '#EF4444' }]}>
                                                            {entry.hasNextAction ? labels.hasNext : labels.needsAction}
                                                        </Text>
                                                    </View>
                                                </View>
                                                <View style={styles.projectMeta}>
                                                    <Text style={[styles.taskCount, { color: tc.secondaryText }]}>
                                                        {entry.tasks.length} {labels.activeTasks}
                                                    </Text>
                                                    <Text style={[styles.expandIcon, { color: tc.secondaryText }]}>
                                                        {isExpanded ? '▼' : '▶'}
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
                                                            onPress={() => handleTaskPress(task)}
                                                            onStatusChange={(status) => handleStatusChange(task.id, status)}
                                                            onDelete={() => handleDelete(task.id)}
                                                            onProjectPress={handleNavigateToProject}
                                                            onContextPress={handleNavigateToToken}
                                                            onTagPress={handleNavigateToToken}
                                                        />
                                                    ))}
                                                </View>
                                            )}
                                        </View>
                                    );
                                })}
                            </ScrollView>
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
                            renderTaskList(orderedSomedayTasks)
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
                        <TouchableOpacity style={styles.primaryButton} onPress={handleFinish}>
                            <Text style={styles.primaryButtonText}>
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
                            accessibilityLabel="Close"
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

                    <View style={styles.content}>
                        {renderStepContent()}
                    </View>

                    {currentStep !== 'completed' && (
                        <View style={[styles.footer, { borderTopColor: tc.border }]}>
                            <TouchableOpacity style={styles.backButton} onPress={prevStep}>
                                <Text style={[styles.backButtonText, { color: tc.secondaryText }]}>← {labels.back}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={styles.primaryButton} onPress={nextStep}>
                                <Text style={styles.primaryButtonText}>{labels.next} →</Text>
                            </TouchableOpacity>
                        </View>
                    )}
                </SafeAreaView>

                <TaskEditModal
                    visible={showEditModal}
                    task={editingTask}
                    onClose={closeEditModal}
                    onSave={handleSaveTask}
                    defaultTab="view"
                    onProjectNavigate={handleNavigateToProject}
                    onContextNavigate={handleNavigateToToken}
                    onTagNavigate={handleNavigateToToken}
                />

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
                                        styles.promptButtonPrimary,
                                        { opacity: projectTaskTitle.trim().length > 0 ? 1 : 0.5 },
                                    ]}
                                    onPress={() => {
                                        void submitProjectTask();
                                    }}
                                    disabled={projectTaskTitle.trim().length === 0}
                                >
                                    <Text style={styles.promptButtonPrimaryText}>{labels.add}</Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    </View>
                </Modal>
            </GestureHandlerRootView>
        </Modal>
    );
}
