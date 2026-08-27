import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { View, Modal, Animated, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Task,
    TaskEditorFieldId,
    useTaskStore,
    type Attachment,
    type RecurrenceWeekday,
    type RecurrenceByDay,
    type TaskStatus,
    buildRRuleString,
    parseRRuleString,
    resolveAutoTextDirection,
    DEFAULT_PROJECT_COLOR,
    getLocalizedWeekdayButtons,
    getLocalizedWeekdayLabels,
    normalizeClockTimeInput,
    resolveTaskViewSection,
    resolveFeatureFlags,
    setTaskViewSectionId,
    shallow,
    sortViewSectionDefinitions,
    tFallback, } from '@mindwtr/core';
import { taskDraftToUpdatePatch } from '@mindwtr/core/task-draft';
import { useLanguage } from '../contexts/language-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { ToastViewport, useToast } from '@/contexts/toast-context';
import { ExpandedMarkdownEditor } from './expanded-markdown-editor';
import { KeyboardAccessoryHost } from './keyboard-accessory-host';
import { MarkdownFormatToolbar } from './markdown-format-toolbar';
import { ThemedAlertHost } from './themed-alert';
import { styles } from './task-edit/task-edit-modal.styles';
import { TaskEditFieldRenderer } from './task-edit/TaskEditFieldRenderer';
import { useTaskDescriptionEditor } from './task-edit/use-task-description-editor';
import { TaskEditViewTab } from './task-edit/TaskEditViewTab';
import { TaskEditFormTab } from './task-edit/TaskEditFormTab';
import { TaskEditHeader } from './task-edit/TaskEditHeader';
import { TaskEditModalErrorBoundary } from './task-edit/TaskEditModalErrorBoundary';
import { TaskEditOverlayStack } from './task-edit/TaskEditOverlayStack';
import { TaskEditTabs } from './task-edit/TaskEditTabs';
import { CompletedAtPicker } from './completed-at-picker';
import {
    MAX_VISIBLE_SUGGESTIONS,
    getRecurrenceRuleValue,
    getRecurrenceStrategyValue,
} from './task-edit/recurrence-utils';
import { getAssignedToSuggestions } from './task-metadata-suggestions';
import { useTaskEditCopilot, type CopilotPart } from './task-edit/use-task-edit-copilot';
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


const EMPTY_COPILOT_TAGS: string[] = [];
const EMPTY_COPILOT_PARTS: CopilotPart[] = [];

interface TaskEditModalProps {
    visible: boolean;
    task: Task | null;
    onClose: () => void;
    /** Return the store write's result (e.g. `updateTask(...)`) so a failed save can be reported. */
    onSave: (taskId: string, updates: Partial<Task>) => unknown;
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
        people,
        settings,
        duplicateTask,
        promoteTaskToProject,
        resetTaskChecklist,
        addProject,
        addSection,
        addArea,
        addPerson,
        deleteTask,
        restoreTask,
        allContexts = [],
        allTags = [],
        contextTokenUsage = [],
        tagTokenUsage = [],
    } = useTaskStore((state) => {
        const derived = state.getDerivedState();
        return {
            tasks: state.tasks,
            projects: state.projects,
            sections: state.sections,
            areas: state.areas,
            people: state.people,
            settings: state.settings,
            duplicateTask: state.duplicateTask,
            promoteTaskToProject: state.promoteTaskToProject,
            resetTaskChecklist: state.resetTaskChecklist,
            addProject: state.addProject,
            addSection: state.addSection,
            addArea: state.addArea,
            addPerson: state.addPerson,
            deleteTask: state.deleteTask,
            restoreTask: state.restoreTask,
            allContexts: derived.allContexts,
            allTags: derived.allTags,
            contextTokenUsage: derived.contextTokenUsage,
            tagTokenUsage: derived.tagTokenUsage,
        };
    }, shallow);
    const { t, language } = useLanguage();
    // Already identity-stable: resolveThemeTokens caches its result on the theme,
    // so this only changes when a colour actually does (#766).
    const tc = useThemeColors();
    const resolvedFeatureFlags = resolveFeatureFlags(settings);
    const prioritiesEnabled = resolvedFeatureFlags.priorities;
    const timeEstimatesEnabled = resolvedFeatureFlags.timeEstimates;
    const timeSpentEnabled = resolvedFeatureFlags.pomodoro && settings.gtd?.pomodoro?.linkTask === true;
    const resetCopilotStateRef = useRef<() => void>(() => {});
    const descriptionToolbarInteractionUntilRef = useRef(0);
    const showTaskWriteError = useCallback((message?: string) => showToast({
        title: tFallback(t, 'common.error', 'Error'),
        message: message || tFallback(t, 'task.updateFailed', 'Could not update task.'),
        tone: 'error',
        durationMs: 4200,
    }), [showToast, t]);
    const {
        aiModal,
        contextInputDraft,
        customWeekdays,
        descriptionDebounceRef,
        descriptionDraft,
        descriptionDraftRef,
        editTab,
        isAIWorking,
        isContextInputFocused,
        isTagInputFocused,
        pendingDueDate,
        pendingStartDate,
        setAiModal,
        setAttachments,
        setChecklist,
        setContextInputDraft,
        setCustomWeekdays,
        setDescriptionDraft,
        setDraftField,
        setEditTab,
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
        taskEditDraft,
        draftLifecycle,
        titleDebounceRef,
        titleDraft,
        titleDraftRef,
    } = useTaskEditState({
        defaultTab,
        onClose,
        onSave,
        onSaveError: showTaskWriteError,
        resetCopilotStateRef,
        sections,
        task,
        tasks,
        visible,
    });
    const recurrenceWeekdayButtons = useMemo(() => getLocalizedWeekdayButtons(language, 'narrow'), [language]);
    const recurrenceWeekdayLabels = useMemo(() => getLocalizedWeekdayLabels(language, 'long'), [language]);
    const aiEnabled = settings.ai?.enabled === true;
    const aiProvider = settings.ai?.provider ?? 'openai';

    const draftContexts = useMemo(
        () => parseTokenList(taskEditDraft?.draft.contexts ?? '', '@'),
        [taskEditDraft?.draft.contexts],
    );
    const draftTags = useMemo(
        () => parseTokenList(taskEditDraft?.draft.tags ?? '', '#'),
        [taskEditDraft?.draft.tags],
    );
    const contextOptions = React.useMemo(() => Array.from(new Set([
            ...allContexts,
            ...draftContexts,
        ])).filter(Boolean), [allContexts, draftContexts]);
    const tagOptions = React.useMemo(() => Array.from(new Set([
            ...allTags,
            ...draftTags,
        ])).filter(Boolean), [allTags, draftTags]);
    const {
        handlePreviewContextPress,
        handlePreviewProjectPress,
        handlePreviewTagPress,
        projectContext,
    } = useTaskEditPreview({
        editedProjectId: taskEditDraft?.draft.projectId,
        includeProjectContext: aiEnabled,
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
        pendingCopilotParts,
        copilotContext,
        copilotEstimate,
        copilotTags,
        resetCopilotDraft,
        resetCopilotState,
        applyCopilotPart,
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
        draft: taskEditDraft?.draft ?? null,
        visible,
        setDraftField,
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
        editLinkAttachment,
        editingLinkAttachmentId,
        imagePreviewAttachment,
        isImageAttachment,
        linkInput,
        linkInputTouched,
        linkModalVisible,
        openAddLinkAttachment,
        openAttachment,
        removeAttachment,
        retryAudioTranscription,
        setLinkInput,
        setLinkInputTouched,
        setLinkModalVisible,
        toggleAudioPlayback,
        visibleAttachments,
    } = useTaskEditAttachments({
        attachments: taskEditDraft?.attachments,
        setAttachments,
        setDraftField,
        taskId: task?.id,
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
        editedContexts: draftContexts,
        editedTags: draftTags,
        contextInputDraft,
        tagInputDraft,
        allContexts,
        allTags,
        contextTokenUsage,
        tagTokenUsage,
    });
    const assignedToSuggestions = useMemo(
        () => getAssignedToSuggestions(tasks, taskEditDraft?.draft.assignedTo ?? '', MAX_VISIBLE_SUGGESTIONS, people),
        [people, taskEditDraft?.draft.assignedTo, tasks]
    );

    const closeAIModal = () => setAiModal(null);
    const setTitleImmediate = useCallback((text: string) => {
        if (titleDebounceRef.current) {
            clearTimeout(titleDebounceRef.current);
            titleDebounceRef.current = null;
        }
        titleDraftRef.current = text;
        setTitleDraft(text);
        setDraftField('title', text);
    }, [setDraftField, setTitleDraft, titleDebounceRef, titleDraftRef]);
    const handleTitleDraftChange = useCallback((text: string) => {
        titleDraftRef.current = text;
        setTitleDraft(text);
        resetCopilotDraft();
        if (titleDebounceRef.current) {
            clearTimeout(titleDebounceRef.current);
        }
        titleDebounceRef.current = setTimeout(() => {
            setDraftField('title', text);
        }, 250);
    }, [resetCopilotDraft, setDraftField, setTitleDraft, titleDebounceRef, titleDraftRef]);
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
        showStatusField,
        timeEstimateOptions,
    } = useTaskEditDerivedState({
        task,
        checklist: taskEditDraft?.checklist,
        draft: taskEditDraft?.draft ?? null,
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
    const isReference = (taskEditDraft?.draft.status ?? task?.status) === 'reference';
    const somedaySections = useMemo(
        () => sortViewSectionDefinitions(settings.gtd?.viewSections?.someday ?? []),
        [settings.gtd?.viewSections?.someday],
    );
    const selectedSomedaySectionId = taskEditDraft
        ? resolveTaskViewSection(taskEditDraft.draft, 'someday', somedaySections)?.id
        : undefined;
    const handleSomedaySectionChange = useCallback((sectionId: string | undefined) => {
        setDraftField(
            'viewSectionIds',
            setTaskViewSectionId(taskEditDraft?.draft.viewSectionIds, 'someday', sectionId),
        );
    }, [setDraftField, taskEditDraft?.draft.viewSectionIds]);

    const editedTaskProjectId = taskEditDraft?.draft.projectId;
    const editedTaskSectionId = taskEditDraft?.draft.sectionId;
    useEffect(() => {
        if (!editedTaskSectionId) return;
        if (!editedTaskProjectId) {
            setDraftField('sectionId', '');
            return;
        }
        const isValid = sections.some((section) => section.id === editedTaskSectionId && section.projectId === editedTaskProjectId && !section.deletedAt);
        if (!isValid) {
            setDraftField('sectionId', '');
        }
    }, [editedTaskProjectId, editedTaskSectionId, sections, setDraftField]);

    useEffect(() => {
        if (!activeProjectId) {
            setShowSectionPicker(false);
        }
    }, [activeProjectId, setShowSectionPicker]);

    const {
        applyQuickDate,
        formatDate,
        formatDueDate,
        getSafePickerDateValue,
        onDateChange,
    } = useTaskEditDates({
        draft: taskEditDraft?.draft ?? null,
        pendingDueDate,
        pendingStartDate,
        setDraftField,
        setPendingDueDate,
        setPendingStartDate,
        setShowDatePicker,
        showDatePicker,
        defaultScheduleTime: normalizeClockTimeInput(settings.gtd?.defaultScheduleTime) || '',
        t,
    });

    const mergedTask = useMemo(() => {
        if (!task || !taskEditDraft) return task as Task;
        const patch = taskDraftToUpdatePatch(taskEditDraft.draft, task, {
            attachments: taskEditDraft.attachments,
        }) ?? {};
        return {
            ...task,
            ...patch,
            checklist: taskEditDraft.checklist,
        };
    }, [task, taskEditDraft]);

    const [customRecurrenceVisible, setCustomRecurrenceVisible] = useState(false);
    const [customInterval, setCustomInterval] = useState(1);
    const [customMode, setCustomMode] = useState<'date' | 'nth' | 'lastDay'>('date');
    const [customOrdinal, setCustomOrdinal] = useState<'1' | '2' | '3' | '4' | '-1'>('1');
    const [customWeekday, setCustomWeekday] = useState<RecurrenceWeekday>(monthlyWeekdayCode);
    const [customMonthDays, setCustomMonthDays] = useState<number[]>([monthlyAnchorDate.getDate()]);
    const [waitingAssignmentModalVisible, setWaitingAssignmentModalVisible] = useState(false);
    const [waitingAssignmentInput, setWaitingAssignmentInput] = useState('');
    const [completedAtPickerVisible, setCompletedAtPickerVisible] = useState(false);
    useEffect(() => {
        setCompletedAtPickerVisible(false);
    }, [task?.id, visible]);
    const waitingAssignmentSuggestions = useMemo(
        () => getAssignedToSuggestions(tasks, waitingAssignmentInput, MAX_VISIBLE_SUGGESTIONS, people),
        [people, tasks, waitingAssignmentInput]
    );
    const [isTitleInputFocused, setIsTitleInputFocused] = useState(false);

    const toggleCustomMonthDay = useCallback((day: number) => {
        setCustomMonthDays((current) => {
            if (!current.includes(day)) return [...current, day].sort((a, b) => a - b);
            // The rule needs at least one day, so ignore the tap that would empty it.
            return current.length > 1 ? current.filter((value) => value !== day) : current;
        });
    }, []);

    const openCustomRecurrence = useCallback(() => {
        const parsed = parseRRuleString(recurrenceRRuleValue);
        const interval = parsed.interval && parsed.interval > 0 ? parsed.interval : 1;
        let mode: 'date' | 'nth' | 'lastDay' = 'date';
        let ordinal: '1' | '2' | '3' | '4' | '-1' = '1';
        let weekday: RecurrenceWeekday = monthlyWeekdayCode;
        const monthDays = (parsed.byMonthDay ?? []).filter((day) => day >= 1 && day <= 31);
        if (parsed.byMonthDay?.includes(-1)) {
            mode = 'lastDay';
        } else if (monthDays.length > 0) {
            mode = 'date';
            setCustomMonthDays(monthDays);
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
        if (monthDays.length === 0) {
            setCustomMonthDays([monthlyAnchorDate.getDate()]);
        }
        setCustomRecurrenceVisible(true);
    }, [monthlyAnchorDate, monthlyWeekdayCode, recurrenceRRuleValue]);

    const applyCustomRecurrence = useCallback(() => {
        const parsed = parseRRuleString(recurrenceRRuleValue);
        const intervalValue = Number(customInterval);
        const safeInterval = Number.isFinite(intervalValue) && intervalValue > 0 ? intervalValue : 1;
        // buildRRuleString clamps, dedupes and sorts the list.
        const safeMonthDays = customMonthDays.length > 0 ? customMonthDays : [1];
        const ends = { count: parsed.count, until: parsed.until };
        const rrule = customMode === 'nth'
            ? buildRRuleString('monthly', [`${customOrdinal}${customWeekday}` as RecurrenceByDay], safeInterval, ends)
            : buildRRuleString('monthly', undefined, safeInterval, {
                ...ends,
                byMonthDay: customMode === 'lastDay' ? [-1] : safeMonthDays,
            });
        setDraftField('recurrence', 'monthly');
        setDraftField('recurrenceStrategy', recurrenceStrategyValue);
        setDraftField('recurrenceRRule', rrule);
        setCustomRecurrenceVisible(false);
    }, [customInterval, customMode, customOrdinal, customWeekday, customMonthDays, recurrenceRRuleValue, recurrenceStrategyValue, setDraftField]);

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
            setIsTitleInputFocused(false);
        }
    }, [visible]);

    const descriptionEditor = useTaskDescriptionEditor({
        task,
        descriptionDraft,
        descriptionDraftRef,
        setDescriptionDraft,
        descriptionDebounceRef,
        setDraftField,
        resetCopilotDraft,
        onMarkdownOverlayVisibilityChange: setIsMarkdownOverlayOpen,
        onInputFocusTracked: handleInputFocus,
    });

    const updateContextInput = useCallback((text: string) => {
        setContextInputDraft(text);
        setDraftField('contexts', parseTokenList(text, '@').join(', '));
    }, [setContextInputDraft, setDraftField]);
    const updateTagInput = useCallback((text: string) => {
        setTagInputDraft(text);
        setDraftField('tags', parseTokenList(text, '#').join(', '));
    }, [setDraftField, setTagInputDraft]);
    const applyContextSuggestion = useCallback((token: string) => {
        updateContextInput(replaceTrailingToken(contextInputDraft, token));
    }, [contextInputDraft, updateContextInput]);
    const applyTagSuggestion = useCallback((token: string) => {
        updateTagInput(replaceTrailingToken(tagInputDraft, token));
    }, [tagInputDraft, updateTagInput]);
    const applyAssignedToSuggestion = useCallback((assignedTo: string) => {
        setDraftField('assignedTo', assignedTo);
    }, [setDraftField]);
    const createAssignedToPerson = useCallback(async (name: string) => {
        const created = await addPerson(name);
        if (created) {
            setDraftField('assignedTo', created.name);
        }
        return created;
    }, [addPerson, setDraftField]);
    const closeWaitingAssignmentModal = useCallback(() => {
        setWaitingAssignmentModalVisible(false);
    }, []);
    const confirmWaitingAssignment = useCallback(() => {
        setDraftField('status', 'waiting');
        setDraftField('assignedTo', waitingAssignmentInput.trim());
        setWaitingAssignmentModalVisible(false);
    }, [setDraftField, waitingAssignmentInput]);
    const requestStatusChange = useCallback((status: TaskStatus) => {
        const currentStatus = taskEditDraft?.draft.status ?? task?.status;
        if (status === 'waiting' && currentStatus !== 'waiting') {
            setWaitingAssignmentInput(taskEditDraft?.draft.assignedTo ?? task?.assignedTo ?? '');
            setWaitingAssignmentModalVisible(true);
            return;
        }
        setDraftField('status', status);
    }, [setDraftField, task?.assignedTo, task?.status, taskEditDraft?.draft.assignedTo, taskEditDraft?.draft.status]);
    const requestBackdatedCompletion = useCallback(() => {
        setCompletedAtPickerVisible(true);
    }, []);
    const confirmBackdatedCompletion = useCallback((completedAt: string, timeSpentMinutes?: number) => {
        setCompletedAtPickerVisible(false);
        setDraftField('status', 'done');
        setDraftField('completedAt', completedAt);
        if (timeSpentEnabled) {
            setDraftField('timeSpentMinutes', timeSpentMinutes);
        }
    }, [setDraftField, timeSpentEnabled]);
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
    }, [contextInputDraft, setIsContextInputFocused, updateContextInput]);
    const commitTagDraft = useCallback(() => {
        setIsTagInputFocused(false);
        updateTagInput(parseTokenList(tagInputDraft, '#').join(', '));
    }, [setIsTagInputFocused, tagInputDraft, updateTagInput]);

    const {
        applyChecklistUpdate,
        handleAIClarify,
        handleAIBreakdown,
        handleAttemptClose,
        handleConvertToReference,
        handleDeleteTask,
        handleDone,
        handleDuplicateTask,
        handlePromoteTaskToProject,
        handleResetChecklist,
        handleShare,
    } = useTaskEditActions({
        aiEnabled,
        closeAIModal,
        deleteTask,
        descriptionDraft,
        draftLifecycle,
        duplicateTask,
        promoteTaskToProject,
        mergedTask,
        taskEditDraft,
        formatDate,
        formatDueDate,
        formatTimeEstimateLabel,
        isAIWorking,
        onClose,
        prioritiesEnabled,
        projectContext,
        resetTaskChecklist,
        restoreTask,
        setAiModal,
        setChecklist,
        setDraftField,
        setIsAIWorking,
        setTitleImmediate,
        settings,
        showToast,
        t,
        task,
        tasks,
        timeEstimatesEnabled,
        titleDraftRef,
    });

    const inputStyle = useMemo(
        () => ({ backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }),
        [tc.border, tc.inputBg, tc.text]
    );
    const combinedText = `${titleDraft ?? ''}\n${descriptionDraft ?? ''}`.trim();
    const resolvedDirection = resolveAutoTextDirection(combinedText, language);
    const textDirectionStyle = useMemo(() => ({
        writingDirection: resolvedDirection,
        textAlign: resolvedDirection === 'rtl' ? 'right' : 'left',
    }) as const, [resolvedDirection]);
    const openAttachmentRef = useRef(openAttachment);
    useEffect(() => {
        openAttachmentRef.current = openAttachment;
    }, [openAttachment]);
    const stableOpenAttachment = useCallback((attachment: Attachment) => (
        openAttachmentRef.current(attachment)
    ), []);
    const noopAIAction = useCallback(() => {}, []);
    const noopApplyCopilotPart = useCallback((_part: CopilotPart) => {}, []);
    const formHandleAIClarify = aiEnabled ? handleAIClarify : noopAIAction;
    const formHandleAIBreakdown = aiEnabled ? handleAIBreakdown : noopAIAction;
    const formApplyCopilotSuggestion = aiEnabled ? applyCopilotSuggestion : noopAIAction;
    const formApplyCopilotPart = aiEnabled ? applyCopilotPart : noopApplyCopilotPart;
    const formPendingCopilotParts = aiEnabled ? pendingCopilotParts : EMPTY_COPILOT_PARTS;
    const formCopilotTags = aiEnabled ? copilotTags : EMPTY_COPILOT_TAGS;
    const fieldRendererProps = useMemo(() => ({
        addFileAttachment,
        addImageAttachment,
        applyAssignedToSuggestion,
        applyContextSuggestion,
        applyTagSuggestion,
        areas,
        assignedToSuggestions,
        availableStatusOptions,
        commitContextDraft,
        commitTagDraft,
        checklist: taskEditDraft?.checklist,
        contextInputDraft,
        contextTokenSuggestions,
        createAssignedToPerson,
        customWeekdays,
        dailyInterval,
        descriptionDraft,
        descriptionInputRef: descriptionEditor.descriptionInputRef,
        descriptionSelection: descriptionEditor.descriptionSelection,
        descriptionSelectionRestorePending: descriptionEditor.descriptionSelectionRestorePending,
        setDescriptionSelection: descriptionEditor.setDescriptionSelection,
        descriptionToolbarInteractionUntilRef,
        isDescriptionInputFocused: descriptionEditor.isDescriptionInputFocused,
        setIsDescriptionInputFocused: descriptionEditor.setIsDescriptionInputFocused,
        handleDescriptionChange: descriptionEditor.handleDescriptionChange,
        handleDescriptionKeyPress: descriptionEditor.handleDescriptionKeyPress,
        applyDescriptionResult: descriptionEditor.applyDescriptionResult,
        applyQuickDate,
        openDescriptionExpandedEditor: descriptionEditor.openDescriptionExpandedEditor,
        downloadAttachment,
        draft: taskEditDraft?.draft ?? null,
        editLinkAttachment,
        formatDate,
        formatDueDate,
        frequentContextSuggestions,
        frequentTagSuggestions,
        getSafePickerDateValue,
        handleInputFocus,
        handleResetChecklist,
        applyChecklistUpdate,
        language,
        monthlyPattern,
        onDateChange,
        openAddLinkAttachment,
        openAttachment: stableOpenAttachment,
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
        requestBackdatedCompletion,
        requestStatusChange,
        removeAttachment,
        selectedContextTokens,
        selectedTagTokens,
        setCustomWeekdays,
        setDraftField,
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
        timeSpentEnabled,
        titleDraft,
        toggleQuickContextToken,
        toggleQuickTagToken,
        updateContextInput,
        updateTagInput,
        visibleAttachments,
    }), [
        addFileAttachment,
        addImageAttachment,
        applyAssignedToSuggestion,
        applyContextSuggestion,
        applyQuickDate,
        applyTagSuggestion,
        areas,
        assignedToSuggestions,
        availableStatusOptions,
        commitContextDraft,
        commitTagDraft,
        taskEditDraft?.checklist,
        contextInputDraft,
        contextTokenSuggestions,
        createAssignedToPerson,
        customWeekdays,
        dailyInterval,
        descriptionDraft,
        descriptionEditor.applyDescriptionResult,
        descriptionEditor.descriptionInputRef,
        descriptionEditor.descriptionSelection,
        descriptionEditor.descriptionSelectionRestorePending,
        descriptionEditor.handleDescriptionChange,
        descriptionEditor.handleDescriptionKeyPress,
        descriptionEditor.isDescriptionInputFocused,
        descriptionEditor.openDescriptionExpandedEditor,
        descriptionEditor.setDescriptionSelection,
        descriptionEditor.setIsDescriptionInputFocused,
        descriptionToolbarInteractionUntilRef,
        downloadAttachment,
        taskEditDraft?.draft,
        editLinkAttachment,
        formatDate,
        formatDueDate,
        frequentContextSuggestions,
        frequentTagSuggestions,
        getSafePickerDateValue,
        handleInputFocus,
        handleResetChecklist,
        applyChecklistUpdate,
        language,
        monthlyPattern,
        onDateChange,
        openAddLinkAttachment,
        stableOpenAttachment,
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
        requestBackdatedCompletion,
        requestStatusChange,
        removeAttachment,
        selectedContextTokens,
        selectedTagTokens,
        setCustomWeekdays,
        setDraftField,
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
        tagInputDraft,
        tagTokenSuggestions,
        task,
        t,
        tc,
        timeEstimateOptions,
        timeEstimatesEnabled,
        timeSpentEnabled,
        titleDraft,
        toggleQuickContextToken,
        toggleQuickTagToken,
        updateContextInput,
        updateTagInput,
        visibleAttachments,
    ]);
    const renderField = useCallback((fieldId: TaskEditorFieldId) => (
        <TaskEditFieldRenderer fieldId={fieldId} {...fieldRendererProps} />
    ), [fieldRendererProps]);
    const handleViewStatusUpdate = useCallback((status: TaskStatus) => {
        requestStatusChange(status);
    }, [requestStatusChange]);
    const isTaskFormTextInputFocused = isTitleInputFocused
        || descriptionEditor.isDescriptionInputFocused
        || isContextInputFocused
        || isTagInputFocused;

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
                        onDone={handleDone}
                        onShare={handleShare}
                        onDuplicate={handleDuplicateTask}
                        onPromoteToProject={handlePromoteTaskToProject}
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
                            scrollEnabled={!isMarkdownOverlayOpen && !isTaskFormTextInputFocused}
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
                                accessibilityHidden={editTab !== 'task'}
                                t={t}
                                tc={tc}
                                styles={styles}
                                inputStyle={inputStyle}
                                attachments={taskEditDraft?.attachments}
                                checklist={taskEditDraft?.checklist}
                                draft={taskEditDraft?.draft ?? null}
                                aiEnabled={aiEnabled}
                                isAIWorking={isAIWorking}
                                handleAIClarify={formHandleAIClarify}
                                handleAIBreakdown={formHandleAIBreakdown}
                                pendingCopilotParts={formPendingCopilotParts}
                                applyCopilotPart={formApplyCopilotPart}
                                applyCopilotSuggestion={formApplyCopilotSuggestion}
                                copilotContext={copilotContext}
                                copilotEstimate={copilotEstimate}
                                copilotTags={formCopilotTags}
                                timeEstimatesEnabled={timeEstimatesEnabled}
                                renderField={renderField}
                                basicFields={basicFields}
                                somedaySections={somedaySections}
                                selectedSomedaySectionId={selectedSomedaySectionId}
                                onSomedaySectionChange={handleSomedaySectionChange}
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
                                onInputFocusTracked={handleInputFocus}
                                onTitleInputFocusChange={setIsTitleInputFocused}
                                registerScrollToEnd={registerScrollTaskFormToEnd}
                                formResetKey={`${task.id}:${visible ? 'open' : 'closed'}`}
                                suspendKeyboardHandling={isMarkdownOverlayOpen}
                            />
                            <View
                                accessibilityElementsHidden={editTab !== 'view'}
                                importantForAccessibility={editTab !== 'view' ? 'no-hide-descendants' : 'auto'}
                                style={[styles.tabPage, { width: containerWidth || '100%' }]}
                                testID="task-edit-preview-page"
                            >
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
                                    openAttachment={stableOpenAttachment}
                                    isImageAttachment={isImageAttachment}
                                    textDirectionStyle={textDirectionStyle}
                                    resolvedDirection={resolvedDirection}
                                    nestedScrollEnabled
                                    onProjectPress={onProjectNavigate ? handlePreviewProjectPress : undefined}
                                    onContextPress={onContextNavigate ? handlePreviewContextPress : undefined}
                                    onTagPress={onTagNavigate ? handlePreviewTagPress : undefined}
                                    onBackdatedComplete={requestBackdatedCompletion}
                                    onStatusUpdate={handleViewStatusUpdate}
                                    showStatusField={showStatusField}
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
                        customMonthDays={customMonthDays}
                        customOrdinal={customOrdinal}
                        customRecurrenceVisible={customRecurrenceVisible}
                        customWeekday={customWeekday}
                        draft={taskEditDraft?.draft}
                        filteredProjectsForPicker={filteredProjectsForPicker}
                        imagePreviewAttachment={imagePreviewAttachment}
                        linkInput={linkInput}
                        linkInputTouched={linkInputTouched}
                        linkModalVisible={linkModalVisible}
                        linkModalTitle={editingLinkAttachmentId ? t('common.edit') : t('attachments.addLink')}
                        projectFilterAreaId={projectFilterAreaId}
                        projects={projects}
                        recurrenceWeekdayButtons={recurrenceWeekdayButtons}
                        recurrenceWeekdayLabels={recurrenceWeekdayLabels}
                        sectionPickerProjectId={activeProjectId}
                        sectionPickerSections={projectSections}
                        setCustomInterval={setCustomInterval}
                        setCustomMode={setCustomMode}
                        toggleCustomMonthDay={toggleCustomMonthDay}
                        setCustomOrdinal={setCustomOrdinal}
                        setCustomRecurrenceVisible={setCustomRecurrenceVisible}
                        setCustomWeekday={setCustomWeekday}
                        setDraftField={setDraftField}
                        setLinkInput={setLinkInput}
                        setLinkInputTouched={setLinkInputTouched}
                        setShowAreaPicker={setShowAreaPicker}
                        setShowProjectPicker={setShowProjectPicker}
                        setShowSectionPicker={setShowSectionPicker}
                        showAreaPicker={showAreaPicker}
                        showProjectPicker={showProjectPicker}
                        showSectionPicker={showSectionPicker}
                        styles={styles}
                        task={task}
                        t={t}
                        tc={tc}
                        retryAudioTranscription={retryAudioTranscription}
                        toggleAudioPlayback={toggleAudioPlayback}
                        waitingAssignmentInput={waitingAssignmentInput}
                        waitingAssignmentModalVisible={waitingAssignmentModalVisible}
                        waitingAssignmentSuggestions={waitingAssignmentSuggestions}
                        closeWaitingAssignmentModal={closeWaitingAssignmentModal}
                        confirmWaitingAssignment={confirmWaitingAssignment}
                        setWaitingAssignmentInput={setWaitingAssignmentInput}
                        DEFAULT_PROJECT_COLOR={DEFAULT_PROJECT_COLOR}
                    />
                    <MarkdownFormatToolbar
                        selection={descriptionEditor.descriptionSelection}
                        onSelectionChange={descriptionEditor.setDescriptionSelection}
                        inputRef={descriptionEditor.descriptionInputRef}
                        t={t}
                        tc={tc}
                        visible={
                            descriptionEditor.isDescriptionInputFocused
                            && editTab === 'task'
                            && !showDescriptionPreview
                            && !descriptionEditor.descriptionExpanded
                        }
                        canUndo={descriptionEditor.descriptionUndoDepth > 0}
                        onUndo={descriptionEditor.handleDescriptionUndo}
                        onApplyAction={descriptionEditor.handleDescriptionApplyAction}
                        onInteractionStart={() => {
                            descriptionToolbarInteractionUntilRef.current = Date.now() + 300;
                            descriptionEditor.setIsDescriptionInputFocused(true);
                        }}
                    />
                </SafeAreaView>
            </KeyboardAccessoryHost>
            <ToastViewport />
            {/* Last child so the alert covers the header and the toasts (#940). */}
            <ThemedAlertHost />
        </Modal>
        {visible && completedAtPickerVisible ? (
            <CompletedAtPicker
                initialValue={mergedTask.completedAt ?? (task.status === 'done' ? task.updatedAt : undefined)}
                initialTimeSpentMinutes={mergedTask.timeSpentMinutes}
                showTimeSpent={timeSpentEnabled}
                onCancel={() => setCompletedAtPickerVisible(false)}
                onConfirm={confirmBackdatedCompletion}
                t={t}
                tc={tc}
            />
        ) : null}
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
                currentTaskId={task?.id}
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
