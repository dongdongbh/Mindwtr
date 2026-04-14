import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { View, Modal, Animated, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
    Task,
    TaskEditorFieldId,
    useTaskStore,
    type RecurrenceWeekday,
    type RecurrenceByDay,
    buildRRuleString,
    parseRRuleString,
    resolveAutoTextDirection,
    DEFAULT_PROJECT_COLOR,
    getLocalizedWeekdayButtons,
    getLocalizedWeekdayLabels,
    getUsedTaskTokens,
} from '@mindwtr/core';
import { useLanguage } from '../contexts/language-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useToast } from '@/contexts/toast-context';
import { ExpandedMarkdownEditor } from './expanded-markdown-editor';
import { KeyboardAccessoryHost } from './keyboard-accessory-host';
import { styles } from './task-edit/task-edit-modal.styles';
import { TaskEditFieldRenderer } from './task-edit/TaskEditFieldRenderer';
import { useTaskDescriptionEditor } from './task-edit/use-task-description-editor';
import { TaskEditViewTab } from './task-edit/TaskEditViewTab';
import { TaskEditFormTab } from './task-edit/TaskEditFormTab';
import { TaskEditHeader } from './task-edit/TaskEditHeader';
import { TaskEditModalErrorBoundary } from './task-edit/TaskEditModalErrorBoundary';
import { TaskEditOverlayStack } from './task-edit/TaskEditOverlayStack';
import { TaskEditTabs } from './task-edit/TaskEditTabs';
import {
    getRecurrenceRuleValue,
    getRecurrenceStrategyValue,
} from './task-edit/recurrence-utils';
import { useTaskEditCopilot } from './task-edit/use-task-edit-copilot';
import { logTaskError } from './task-edit/task-edit-modal.utils';
import {
    parseTokenList,
    replaceTrailingToken,
} from './task-edit/task-edit-token-utils';
import { useTaskEditActions } from './task-edit/use-task-edit-actions';
import { useTaskEditAttachments } from './task-edit/use-task-edit-attachments';
import { useTaskEditDates } from './task-edit/use-task-edit-dates';
import { useTaskEditPager } from './task-edit/use-task-edit-pager';
import { useTaskEditPreview } from './task-edit/use-task-edit-preview';
import {
    useTaskEditState,
} from './task-edit/use-task-edit-state';
import { useTaskEditDerivedState } from './task-edit/use-task-edit-derived-state';
import { useTaskTokenSuggestions } from './task-edit/use-task-token-suggestions';


interface TaskEditModalProps {
    visible: boolean;
    task: Task | null;
    onClose: () => void;
    onSave: (taskId: string, updates: Partial<Task>) => void;
    onFocusMode?: (taskId: string) => void;
    defaultTab?: 'task' | 'view';
    onProjectNavigate?: (projectId: string) => void;
    onContextNavigate?: (context: string) => void;
    onTagNavigate?: (tag: string) => void;
}

function TaskEditModalInner({
    visible,
    task,
    onClose,
    onSave,
    onFocusMode,
    defaultTab,
    onProjectNavigate,
    onContextNavigate,
    onTagNavigate,
}: TaskEditModalProps) {
    const { showToast } = useToast();
    const {
        tasks,
        projects,
        sections,
        areas,
        settings,
        duplicateTask,
        resetTaskChecklist,
        addProject,
        addSection,
        addArea,
        deleteTask,
    } = useTaskStore();
    const { t, language } = useLanguage();
    const tc = useThemeColors();
    const prioritiesEnabled = settings.features?.priorities !== false;
    const timeEstimatesEnabled = settings.features?.timeEstimates !== false;
    const resetCopilotStateRef = useRef<() => void>(() => {});
    const {
        aiModal,
        baseTaskRef,
        contextInputDraft,
        customWeekdays,
        descriptionDebounceRef,
        descriptionDraft,
        descriptionDraftRef,
        editTab,
        editedTask,
        isAIWorking,
        isContextInputFocused,
        isTagInputFocused,
        pendingDueDate,
        pendingStartDate,
        setAiModal,
        setContextInputDraft,
        setCustomWeekdays,
        setDescriptionDraft,
        setEditTab,
        setEditedTask,
        setIsAIWorking,
        setIsContextInputFocused,
        setIsTagInputFocused,
        setPendingDueDate,
        setPendingStartDate,
        setShowAreaPicker,
        setShowDatePicker,
        setShowDescriptionPreview,
        setShowProjectPicker,
        setShowSectionPicker,
        setTagInputDraft,
        setTitleDraft,
        showAreaPicker,
        showDatePicker,
        showDescriptionPreview,
        showProjectPicker,
        showSectionPicker,
        tagInputDraft,
        titleDebounceRef,
        titleDraft,
        titleDraftRef,
    } = useTaskEditState({
        defaultTab,
        resetCopilotStateRef,
        task,
        tasks,
        visible,
    });
    const recurrenceWeekdayButtons = useMemo(() => getLocalizedWeekdayButtons(language, 'narrow'), [language]);
    const recurrenceWeekdayLabels = useMemo(() => getLocalizedWeekdayLabels(language, 'long'), [language]);
    const aiEnabled = settings.ai?.enabled === true;
    const aiProvider = settings.ai?.provider ?? 'openai';

    const contextOptions = React.useMemo(() => Array.from(new Set([
            ...getUsedTaskTokens(tasks, (item) => item.contexts, { prefix: '@' }),
            ...(editedTask.contexts ?? []),
        ])).filter(Boolean), [editedTask.contexts, tasks]);
    const tagOptions = React.useMemo(() => Array.from(new Set([
            ...getUsedTaskTokens(tasks, (item) => item.tags, { prefix: '#' }),
            ...(editedTask.tags ?? []),
        ])).filter(Boolean), [editedTask.tags, tasks]);
    const {
        handlePreviewContextPress,
        handlePreviewProjectPress,
        handlePreviewTagPress,
        projectContext,
    } = useTaskEditPreview({
        editedProjectId: editedTask.projectId,
        onClose,
        onContextNavigate,
        onProjectNavigate,
        onTagNavigate,
        projectId: task?.projectId,
        projects,
        task,
        tasks,
    });

    const {
        copilotSuggestion,
        copilotApplied,
        copilotContext,
        copilotEstimate,
        copilotTags,
        resetCopilotDraft,
        resetCopilotState,
        applyCopilotSuggestion,
    } = useTaskEditCopilot({
        settings,
        aiEnabled,
        aiProvider,
        timeEstimatesEnabled,
        titleDraft,
        descriptionDraft,
        contextOptions,
        tagOptions,
        editedTask,
        visible,
        setEditedTask,
    });
    resetCopilotStateRef.current = resetCopilotState;

    const {
        addFileAttachment,
        addImageAttachment,
        audioAttachment,
        audioLoading,
        audioTranscribing,
        audioTranscriptionError,
        audioModalVisible,
        audioStatus,
        closeAudioModal,
        closeImagePreview,
        closeLinkModal,
        confirmAddLink,
        downloadAttachment,
        imagePreviewAttachment,
        isImageAttachment,
        linkInput,
        linkInputTouched,
        linkModalVisible,
        openAttachment,
        removeAttachment,
        retryAudioTranscription,
        setLinkInput,
        setLinkInputTouched,
        setLinkModalVisible,
        toggleAudioPlayback,
        visibleAttachments,
    } = useTaskEditAttachments({
        editedTask,
        setEditedTask,
        t,
        visible,
    });

    const {
        contextTokenSuggestions,
        tagTokenSuggestions,
        frequentContextSuggestions,
        frequentTagSuggestions,
        selectedContextTokens,
        selectedTagTokens,
    } = useTaskTokenSuggestions({
        tasks,
        editedContexts: editedTask.contexts,
        editedTags: editedTask.tags,
        contextInputDraft,
        tagInputDraft,
    });

    const closeAIModal = () => setAiModal(null);
    const setTitleImmediate = useCallback((text: string) => {
        if (titleDebounceRef.current) {
            clearTimeout(titleDebounceRef.current);
            titleDebounceRef.current = null;
        }
        titleDraftRef.current = text;
        setTitleDraft(text);
        setEditedTask((prev) => ({ ...prev, title: text }));
    }, [setEditedTask]);
    const handleTitleDraftChange = useCallback((text: string) => {
        titleDraftRef.current = text;
        setTitleDraft(text);
        resetCopilotDraft();
        if (titleDebounceRef.current) {
            clearTimeout(titleDebounceRef.current);
        }
        titleDebounceRef.current = setTimeout(() => {
            setEditedTask((prev) => ({ ...prev, title: text }));
        }, 250);
    }, [resetCopilotDraft, setEditedTask]);
    const {
        activeProjectId,
        availableStatusOptions,
        basicFields,
        dailyInterval,
        detailsFields,
        filteredProjectsForPicker,
        formatTimeEstimateLabel,
        monthlyAnchorDate,
        monthlyPattern,
        monthlyWeekdayCode,
        organizationFields,
        energyLevelOptions,
        priorityOptions,
        projectFilterAreaId,
        projectSections,
        recurrenceOptions,
        recurrenceRRuleValue,
        recurrenceRuleValue,
        recurrenceStrategyValue,
        schedulingFields,
        sectionOpenDefaults,
        timeEstimateOptions,
    } = useTaskEditDerivedState({
        task,
        editedTask,
        settings,
        projects,
        sections,
        prioritiesEnabled,
        timeEstimatesEnabled,
        contextInputDraft,
        descriptionDraft,
        tagInputDraft,
        visibleAttachmentsLength: visibleAttachments.length,
        t,
    });
    const isReference = (editedTask.status ?? task?.status) === 'reference';

    useEffect(() => {
        const projectId = editedTask.projectId ?? task?.projectId;
        const sectionId = editedTask.sectionId ?? task?.sectionId;
        if (!sectionId) return;
        if (!projectId) {
            setEditedTask(prev => ({ ...prev, sectionId: undefined }));
            return;
        }
        const isValid = sections.some((section) => section.id === sectionId && section.projectId === projectId && !section.deletedAt);
        if (!isValid) {
            setEditedTask(prev => ({ ...prev, sectionId: undefined }));
        }
    }, [editedTask.projectId, editedTask.sectionId, sections, setEditedTask, task?.projectId, task?.sectionId]);

    useEffect(() => {
        if (!activeProjectId) {
            setShowSectionPicker(false);
        }
    }, [activeProjectId]);

    const {
        formatDate,
        formatDueDate,
        getSafePickerDateValue,
        onDateChange,
    } = useTaskEditDates({
        editedTask,
        pendingDueDate,
        pendingStartDate,
        setEditedTask,
        setPendingDueDate,
        setPendingStartDate,
        setShowDatePicker,
        showDatePicker,
        t,
    });

    const mergedTask = useMemo(() => ({
        ...(task ?? {}),
        ...editedTask,
    }), [task, editedTask]);

    const [customRecurrenceVisible, setCustomRecurrenceVisible] = useState(false);
    const [customInterval, setCustomInterval] = useState(1);
    const [customMode, setCustomMode] = useState<'date' | 'nth'>('date');
    const [customOrdinal, setCustomOrdinal] = useState<'1' | '2' | '3' | '4' | '-1'>('1');
    const [customWeekday, setCustomWeekday] = useState<RecurrenceWeekday>(monthlyWeekdayCode);
    const [customMonthDay, setCustomMonthDay] = useState<number>(monthlyAnchorDate.getDate());

    const openCustomRecurrence = useCallback(() => {
        const parsed = parseRRuleString(recurrenceRRuleValue);
        const interval = parsed.interval && parsed.interval > 0 ? parsed.interval : 1;
        let mode: 'date' | 'nth' = 'date';
        let ordinal: '1' | '2' | '3' | '4' | '-1' = '1';
        let weekday: RecurrenceWeekday = monthlyWeekdayCode;
        const monthDay = parsed.byMonthDay?.[0];
        if (monthDay) {
            mode = 'date';
            setCustomMonthDay(Math.min(Math.max(monthDay, 1), 31));
        }
        const token = parsed.byDay?.find((day) => /^(-1|1|2|3|4)/.test(String(day)));
        if (token) {
            const match = String(token).match(/^(-1|1|2|3|4)?(SU|MO|TU|WE|TH|FR|SA)$/);
            if (match) {
                mode = 'nth';
                ordinal = (match[1] ?? '1') as '1' | '2' | '3' | '4' | '-1';
                weekday = match[2] as RecurrenceWeekday;
            }
        }
        setCustomInterval(interval);
        setCustomMode(mode);
        setCustomOrdinal(ordinal);
        setCustomWeekday(weekday);
        if (!monthDay) {
            setCustomMonthDay(monthlyAnchorDate.getDate());
        }
        setCustomRecurrenceVisible(true);
    }, [monthlyAnchorDate, monthlyWeekdayCode, recurrenceRRuleValue]);

    const applyCustomRecurrence = useCallback(() => {
        const intervalValue = Number(customInterval);
        const safeInterval = Number.isFinite(intervalValue) && intervalValue > 0 ? intervalValue : 1;
        const safeMonthDay = Math.min(Math.max(Math.round(customMonthDay || 1), 1), 31);
        const rrule = customMode === 'nth'
            ? buildRRuleString('monthly', [`${customOrdinal}${customWeekday}` as RecurrenceByDay], safeInterval)
            : [
                'FREQ=MONTHLY',
                safeInterval > 1 ? `INTERVAL=${safeInterval}` : null,
                `BYMONTHDAY=${safeMonthDay}`,
            ].filter(Boolean).join(';');
        setEditedTask(prev => ({
            ...prev,
            recurrence: {
                rule: 'monthly',
                strategy: recurrenceStrategyValue,
                ...(customMode === 'nth' ? { byDay: [`${customOrdinal}${customWeekday}` as RecurrenceByDay] } : {}),
                rrule,
            },
        }));
        setCustomRecurrenceVisible(false);
    }, [customInterval, customMode, customOrdinal, customWeekday, customMonthDay, recurrenceStrategyValue, setEditedTask]);

    const [isMarkdownOverlayOpen, setIsMarkdownOverlayOpen] = useState(false);
    const {
        containerWidth,
        handleContainerLayout,
        handleInputFocus,
        handleMomentumScrollEnd,
        handleTabPress,
        registerScrollTaskFormToEnd,
        scrollRef,
        scrollX,
    } = useTaskEditPager({
        editTab,
        isMarkdownOverlayOpen,
        setEditTab,
        taskId: task?.id,
        visible,
    });

    useEffect(() => {
        if (!visible) {
            setIsMarkdownOverlayOpen(false);
        }
    }, [visible]);

    const descriptionEditor = useTaskDescriptionEditor({
        task,
        descriptionDraft,
        descriptionDraftRef,
        setDescriptionDraft,
        descriptionDebounceRef,
        setEditedTask,
        resetCopilotDraft,
        onMarkdownOverlayVisibilityChange: setIsMarkdownOverlayOpen,
        onInputFocusTracked: handleInputFocus,
    });

    const updateContextInput = useCallback((text: string) => {
        setContextInputDraft(text);
        setEditedTask((prev) => ({ ...prev, contexts: parseTokenList(text, '@') }));
    }, [setEditedTask]);
    const updateTagInput = useCallback((text: string) => {
        setTagInputDraft(text);
        setEditedTask((prev) => ({ ...prev, tags: parseTokenList(text, '#') }));
    }, [setEditedTask]);
    const applyContextSuggestion = useCallback((token: string) => {
        updateContextInput(replaceTrailingToken(contextInputDraft, token));
    }, [contextInputDraft, updateContextInput]);
    const applyTagSuggestion = useCallback((token: string) => {
        updateTagInput(replaceTrailingToken(tagInputDraft, token));
    }, [tagInputDraft, updateTagInput]);
    const toggleQuickContextToken = useCallback((token: string) => {
        const next = new Set(parseTokenList(contextInputDraft, '@'));
        if (next.has(token)) {
            next.delete(token);
        } else {
            next.add(token);
        }
        updateContextInput(Array.from(next).join(', '));
    }, [contextInputDraft, updateContextInput]);
    const toggleQuickTagToken = useCallback((token: string) => {
        const next = new Set(parseTokenList(tagInputDraft, '#'));
        if (next.has(token)) {
            next.delete(token);
        } else {
            next.add(token);
        }
        updateTagInput(Array.from(next).join(', '));
    }, [tagInputDraft, updateTagInput]);
    const commitContextDraft = useCallback(() => {
        setIsContextInputFocused(false);
        updateContextInput(parseTokenList(contextInputDraft, '@').join(', '));
    }, [contextInputDraft, updateContextInput]);
    const commitTagDraft = useCallback(() => {
        setIsTagInputFocused(false);
        updateTagInput(parseTokenList(tagInputDraft, '#').join(', '));
    }, [tagInputDraft, updateTagInput]);

    const {
        applyChecklistUpdate,
        handleAIClarify,
        handleAIBreakdown,
        handleAttemptClose,
        handleConvertToReference,
        handleDeleteTask,
        handleDone,
        handleDuplicateTask,
        handleResetChecklist,
        handleShare,
    } = useTaskEditActions({
        addProject,
        aiEnabled,
        areas,
        baseTaskRef,
        closeAIModal,
        contextInputDraft,
        customWeekdays,
        deleteTask,
        descriptionDebounceRef,
        descriptionDraft,
        descriptionDraftRef,
        duplicateTask,
        editedTask,
        formatDate,
        formatDueDate,
        formatTimeEstimateLabel,
        isAIWorking,
        isContextInputFocused,
        isTagInputFocused,
        onClose,
        onSave,
        prioritiesEnabled,
        projectContext,
        projectFilterAreaId,
        projects,
        recurrenceRuleValue,
        recurrenceRRuleValue,
        recurrenceStrategyValue,
        resetTaskChecklist,
        sections,
        setAiModal,
        setEditedTask,
        setIsAIWorking,
        setTitleImmediate,
        settings,
        showToast,
        t,
        tagInputDraft,
        task,
        tasks,
        timeEstimatesEnabled,
        titleDebounceRef,
        titleDraftRef,
    });

    const inputStyle = { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text };
    const combinedText = `${titleDraft ?? ''}\n${descriptionDraft ?? ''}`.trim();
    const resolvedDirection = resolveAutoTextDirection(combinedText, language);
    const textDirectionStyle = {
        writingDirection: resolvedDirection,
        textAlign: resolvedDirection === 'rtl' ? 'right' : 'left',
    } as const;
    const fieldRendererProps = {
        addFileAttachment,
        addImageAttachment,
        applyContextSuggestion,
        applyTagSuggestion,
        areas,
        availableStatusOptions,
        commitContextDraft,
        commitTagDraft,
        contextInputDraft,
        contextTokenSuggestions,
        customWeekdays,
        dailyInterval,
        descriptionDraft,
        descriptionInputRef: descriptionEditor.descriptionInputRef,
        descriptionSelection: descriptionEditor.descriptionSelection,
        setDescriptionSelection: descriptionEditor.setDescriptionSelection,
        descriptionUndoDepth: descriptionEditor.descriptionUndoDepth,
        isDescriptionInputFocused: descriptionEditor.isDescriptionInputFocused,
        setIsDescriptionInputFocused: descriptionEditor.setIsDescriptionInputFocused,
        handleDescriptionChange: descriptionEditor.handleDescriptionChange,
        handleDescriptionUndo: descriptionEditor.handleDescriptionUndo,
        handleDescriptionApplyAction: descriptionEditor.handleDescriptionApplyAction,
        applyDescriptionResult: descriptionEditor.applyDescriptionResult,
        openDescriptionExpandedEditor: descriptionEditor.openDescriptionExpandedEditor,
        downloadAttachment,
        editedTask,
        formatDate,
        formatDueDate,
        frequentContextSuggestions,
        frequentTagSuggestions,
        getSafePickerDateValue,
        handleInputFocus,
        handleResetChecklist,
        language,
        monthlyPattern,
        onDateChange,
        openAttachment,
        openCustomRecurrence,
        pendingDueDate,
        pendingStartDate,
        prioritiesEnabled,
        energyLevelOptions,
        priorityOptions,
        projects,
        projectSections,
        recurrenceOptions,
        recurrenceRRuleValue,
        recurrenceRuleValue,
        recurrenceStrategyValue,
        recurrenceWeekdayButtons,
        removeAttachment,
        selectedContextTokens,
        selectedTagTokens,
        setCustomWeekdays,
        setEditedTask,
        setIsContextInputFocused,
        setIsTagInputFocused,
        setLinkInputTouched,
        setLinkModalVisible,
        setShowAreaPicker,
        setShowDatePicker,
        setShowDescriptionPreview,
        setShowProjectPicker,
        setShowSectionPicker,
        showDatePicker,
        showDescriptionPreview,
        styles,
        tagInputDraft,
        tagTokenSuggestions,
        task,
        t,
        tc,
        timeEstimateOptions,
        timeEstimatesEnabled,
        titleDraft,
        toggleQuickContextToken,
        toggleQuickTagToken,
        updateContextInput,
        updateTagInput,
        visibleAttachments,
    };
    const renderField = (fieldId: TaskEditorFieldId) => (
        <TaskEditFieldRenderer fieldId={fieldId} {...fieldRendererProps} />
    );

    if (!task) return null;

    return (
        <>
        <Modal
            visible={visible}
            animationType="slide"
            presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
            allowSwipeDismissal
            onRequestClose={handleAttemptClose}
        >
            <KeyboardAccessoryHost>
                <SafeAreaView
                    style={[styles.container, { backgroundColor: tc.bg }]}
                    edges={['top']}
                >
                    <TaskEditHeader
                        title={String(titleDraft || editedTask.title || '').trim() || t('taskEdit.title')}
                        onDone={handleDone}
                        onShare={handleShare}
                        onDuplicate={handleDuplicateTask}
                        onDelete={handleDeleteTask}
                        onConvertToReference={handleConvertToReference}
                        showConvertToReference={!isReference}
                    />

                    <TaskEditTabs
                        editTab={editTab}
                        onTabPress={handleTabPress}
                        scrollX={scrollX}
                        containerWidth={containerWidth}
                    />

                    <View
                        style={styles.tabContent}
                        onLayout={handleContainerLayout}
                    >
                        <Animated.ScrollView
                            ref={scrollRef}
                            horizontal
                            pagingEnabled
                            scrollEnabled={!isMarkdownOverlayOpen}
                            scrollEventThrottle={16}
                            showsHorizontalScrollIndicator={false}
                            directionalLockEnabled
                            onScroll={Animated.event(
                                [{ nativeEvent: { contentOffset: { x: scrollX } } }],
                                { useNativeDriver: true }
                            )}
                            onMomentumScrollEnd={handleMomentumScrollEnd}
                        >
                            <TaskEditFormTab
                                t={t}
                                tc={tc}
                                styles={styles}
                                inputStyle={inputStyle}
                                editedTask={editedTask}
                                setEditedTask={setEditedTask}
                                aiEnabled={aiEnabled}
                                isAIWorking={isAIWorking}
                                handleAIClarify={handleAIClarify}
                                handleAIBreakdown={handleAIBreakdown}
                                copilotSuggestion={copilotSuggestion}
                                copilotApplied={copilotApplied}
                                applyCopilotSuggestion={applyCopilotSuggestion}
                                copilotContext={copilotContext}
                                copilotEstimate={copilotEstimate}
                                copilotTags={copilotTags}
                                timeEstimatesEnabled={timeEstimatesEnabled}
                                renderField={renderField}
                                basicFields={basicFields}
                                schedulingFields={schedulingFields}
                                organizationFields={organizationFields}
                                detailsFields={detailsFields}
                                sectionOpenDefaults={sectionOpenDefaults}
                                showDatePicker={showDatePicker}
                                pendingStartDate={pendingStartDate}
                                pendingDueDate={pendingDueDate}
                                getSafePickerDateValue={getSafePickerDateValue}
                                onDateChange={onDateChange}
                                containerWidth={containerWidth}
                                textDirectionStyle={textDirectionStyle}
                                titleDraft={titleDraft}
                                onTitleDraftChange={handleTitleDraftChange}
                                registerScrollToEnd={registerScrollTaskFormToEnd}
                                formResetKey={`${task.id}:${visible ? 'open' : 'closed'}`}
                                suspendKeyboardHandling={isMarkdownOverlayOpen}
                            />
                            <View style={[styles.tabPage, { width: containerWidth || '100%' }]}>
                                <TaskEditViewTab
                                    t={t}
                                    tc={tc}
                                    styles={styles}
                                    mergedTask={mergedTask}
                                    projects={projects}
                                    sections={projectSections}
                                    areas={areas}
                                    prioritiesEnabled={prioritiesEnabled}
                                    timeEstimatesEnabled={timeEstimatesEnabled}
                                    formatTimeEstimateLabel={formatTimeEstimateLabel}
                                    formatDate={formatDate}
                                    formatDueDate={formatDueDate}
                                    getRecurrenceRuleValue={getRecurrenceRuleValue}
                                    getRecurrenceStrategyValue={getRecurrenceStrategyValue}
                                    applyChecklistUpdate={applyChecklistUpdate}
                                    visibleAttachments={visibleAttachments}
                                    openAttachment={openAttachment}
                                    isImageAttachment={isImageAttachment}
                                    textDirectionStyle={textDirectionStyle}
                                    resolvedDirection={resolvedDirection}
                                    nestedScrollEnabled
                                    onProjectPress={onProjectNavigate ? handlePreviewProjectPress : undefined}
                                    onContextPress={onContextNavigate ? handlePreviewContextPress : undefined}
                                    onTagPress={onTagNavigate ? handlePreviewTagPress : undefined}
                                />
                            </View>
                        </Animated.ScrollView>
                    </View>

                    <TaskEditOverlayStack
                        aiModal={aiModal}
                        addArea={addArea}
                        addProject={addProject}
                        addSection={addSection}
                        applyCustomRecurrence={applyCustomRecurrence}
                        areas={areas}
                        audioAttachment={audioAttachment}
                        audioLoading={audioLoading}
                        audioTranscribing={audioTranscribing}
                        audioTranscriptionError={audioTranscriptionError}
                        audioModalVisible={audioModalVisible}
                        audioStatus={audioStatus}
                        closeAIModal={closeAIModal}
                        closeAudioModal={closeAudioModal}
                        closeImagePreview={closeImagePreview}
                        closeLinkModal={closeLinkModal}
                        confirmAddLink={confirmAddLink}
                        customInterval={customInterval}
                        customMode={customMode}
                        customMonthDay={customMonthDay}
                        customOrdinal={customOrdinal}
                        customRecurrenceVisible={customRecurrenceVisible}
                        customWeekday={customWeekday}
                        filteredProjectsForPicker={filteredProjectsForPicker}
                        imagePreviewAttachment={imagePreviewAttachment}
                        linkInput={linkInput}
                        linkInputTouched={linkInputTouched}
                        linkModalVisible={linkModalVisible}
                        projectFilterAreaId={projectFilterAreaId}
                        projects={projects}
                        recurrenceWeekdayButtons={recurrenceWeekdayButtons}
                        recurrenceWeekdayLabels={recurrenceWeekdayLabels}
                        sectionPickerProjectId={activeProjectId}
                        sectionPickerSections={projectSections}
                        setCustomInterval={setCustomInterval}
                        setCustomMode={setCustomMode}
                        setCustomMonthDay={setCustomMonthDay}
                        setCustomOrdinal={setCustomOrdinal}
                        setCustomRecurrenceVisible={setCustomRecurrenceVisible}
                        setCustomWeekday={setCustomWeekday}
                        setEditedTask={setEditedTask}
                        setLinkInput={setLinkInput}
                        setLinkInputTouched={setLinkInputTouched}
                        setShowAreaPicker={setShowAreaPicker}
                        setShowProjectPicker={setShowProjectPicker}
                        setShowSectionPicker={setShowSectionPicker}
                        showAreaPicker={showAreaPicker}
                        showProjectPicker={showProjectPicker}
                        showSectionPicker={showSectionPicker}
                        styles={styles}
                        t={t}
                        tc={tc}
                        retryAudioTranscription={retryAudioTranscription}
                        toggleAudioPlayback={toggleAudioPlayback}
                        DEFAULT_PROJECT_COLOR={DEFAULT_PROJECT_COLOR}
                    />
                </SafeAreaView>
            </KeyboardAccessoryHost>
        </Modal>
        {visible ? (
            <ExpandedMarkdownEditor
                isOpen={descriptionEditor.descriptionExpanded}
                onClose={descriptionEditor.closeDescriptionExpandedEditor}
                value={descriptionDraft}
                onChange={descriptionEditor.handleDescriptionChange}
                title={t('taskEdit.descriptionLabel')}
                headerTitle={titleDraft.trim() || task?.title?.trim() || t('taskEdit.descriptionLabel')}
                placeholder={t('taskEdit.descriptionPlaceholder')}
                t={t}
                initialMode="edit"
                direction={resolvedDirection}
                selection={descriptionEditor.descriptionSelection}
                onSelectionChange={descriptionEditor.setDescriptionSelection}
                canUndo={descriptionEditor.descriptionUndoDepth > 0}
                onUndo={descriptionEditor.handleDescriptionUndo}
                onApplyAction={descriptionEditor.handleDescriptionApplyAction}
            />
        ) : null}
        </>
    );
}

const areTaskEditModalPropsEqual = (prev: TaskEditModalProps, next: TaskEditModalProps): boolean => (
    prev.visible === next.visible && prev.task === next.task && prev.onClose === next.onClose && prev.onSave === next.onSave
    && prev.onFocusMode === next.onFocusMode && prev.defaultTab === next.defaultTab
    && prev.onProjectNavigate === next.onProjectNavigate && prev.onContextNavigate === next.onContextNavigate && prev.onTagNavigate === next.onTagNavigate
);

const TaskEditModalWithBoundary = (props: TaskEditModalProps) => {
    const { t } = useLanguage();
    const tc = useThemeColors();
    return <TaskEditModalErrorBoundary onClose={props.onClose} taskId={props.task?.id} t={t} tc={tc}><TaskEditModalInner {...props} /></TaskEditModalErrorBoundary>;
};

export const TaskEditModal = React.memo(TaskEditModalWithBoundary, areTaskEditModalPropsEqual);
