import { TaskProjectConversionModal } from './task-edit/TaskProjectConversionModal';
import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, TextInput, Modal, Animated, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Task,
    TaskEditorFieldId,
    useTaskStore,
    type Attachment,
    type AttachmentDraftSettlementInput,
    type RecurrenceWeekday,
    type TaskStatus,
    buildTaskEditorMonthlyCustomRRule,
    getTaskEditorMonthlyCustom,
    getRetainedTaskContexts,
    isTaskEditorTimeSpentEnabled,
    getTaskEditorBackdatedCompletionStart,
    resolveAutoTextDirection,
    DEFAULT_PROJECT_COLOR,
    getLocalizedWeekdayButtons,
    getLocalizedWeekdayLabels,
    getProjectSectionsForView,
    normalizeClockTimeInput,
    resolveTaskViewSection,
    resolveFeatureFlags,
    isProjectedRecurringTask,
    canSkipRecurringTaskOccurrence,
    isTaskActionable,
    setTaskViewSectionId,
    shallow,
    sortViewSectionDefinitions,
    tFallback,
    toggleTaskEditorToken, } from '@mindwtr/core';
import {
    collectFocusEligibilityTasks,
    getFocusStarBlockedText,
    normalizeFocusTaskLimit,
    resolveTaskEditorFocusStar,
} from '@mindwtr/core';
import { createTaskDraft, taskDraftToUpdatePatch } from '@mindwtr/core/task-draft';
import { useLanguage } from '../contexts/language-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useAdaptiveWindow } from '@/components/adaptive-window-context';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { AdaptiveModalSurface } from './adaptive-modal-surface';
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
    type TaskEditActivityInputRecovery,
} from './task-edit/use-task-edit-state';
import { useTaskEditDerivedState } from './task-edit/use-task-edit-derived-state';
import { useTaskTokenSuggestions } from './task-edit/use-task-token-suggestions';
import { createSomedaySection } from '../lib/someday-section-actions';
import { logInfo } from '../lib/app-log';
import { SandboxWorkspaceCue } from './sandbox-workspace-cue';
import { resolveTaskOpenTab, useTaskOpenMode } from '@/lib/view-state/task-open-mode';


const EMPTY_COPILOT_TAGS: string[] = [];
const EMPTY_COPILOT_PARTS: CopilotPart[] = [];

type RecoveredInputSchedule = (callback: () => void, attempt: number) => () => void;

const scheduleRecoveredInputAttempt: RecoveredInputSchedule = (callback, attempt) => {
    if (attempt === 0 && typeof requestAnimationFrame === 'function') {
        const frame = requestAnimationFrame(callback);
        return () => cancelAnimationFrame(frame);
    }
    const timeout = setTimeout(callback, attempt * 80);
    return () => clearTimeout(timeout);
};

export const restoreRecoveredTaskEditInput = ({
    acknowledge,
    descriptionInputRef,
    editTab,
    recoveredInput,
    schedule = scheduleRecoveredInputAttempt,
    titleInputRef,
}: {
    acknowledge: () => void;
    descriptionInputRef: React.RefObject<TextInput | null>;
    editTab: 'task' | 'view';
    recoveredInput: TaskEditActivityInputRecovery | null;
    schedule?: RecoveredInputSchedule;
    titleInputRef: React.RefObject<TextInput | null>;
}) => {
    if (!recoveredInput || editTab !== 'task') return () => {};
    let cancelled = false;
    let cancelScheduled = () => {};
    let attempt = 0;
    const restore = () => {
        if (cancelled) return;
        const input = recoveredInput.field === 'title'
            ? titleInputRef.current
            : descriptionInputRef.current;
        if (input) {
            input.focus();
            input.setNativeProps({ selection: recoveredInput.selection });
            if (typeof input.isFocused !== 'function' || input.isFocused()) {
                void logInfo('Android activity editor input restored', {
                    scope: 'task-edit',
                    extra: {
                        releaseCheck: 'v1.3.0/android-activity-session-recovery',
                        outcome: 'focused',
                        surface: recoveredInput.field,
                    },
                });
                acknowledge();
                return;
            }
        }
        attempt += 1;
        if (attempt > 2) {
            acknowledge();
            return;
        }
        cancelScheduled = schedule(restore, attempt);
    };
    cancelScheduled = schedule(restore, attempt);
    return () => {
        cancelled = true;
        cancelScheduled();
    };
};

interface TaskEditModalProps {
    visible: boolean;
    task: Task | null;
    onClose: () => void;
    /** Return the store write's result (e.g. `updateTask(...)`) so a failed save can be reported. */
    onSave: (taskId: string, updates: Partial<Task>) => unknown;
    defaultTab?: 'task' | 'view';
    /** Normal per-screen default used only when the device preference is Automatic. */
    automaticDefaultTab?: 'task' | 'view';
    onProjectNavigate?: (projectId: string) => void;
    onContextNavigate?: (context: string) => void;
    onTagNavigate?: (tag: string) => void;
    /** Archived-project tasks remain inspectable, but every mutation is disabled. */
    readOnly?: boolean;
}

function TaskEditModalInner({
    visible,
    task,
    onClose,
    onSave,
    defaultTab,
    onProjectNavigate,
    onContextNavigate,
    onTagNavigate,
    readOnly = false,
}: TaskEditModalProps) {
    const { showToast } = useToast();
    const {
        tasks,
        allTasks,
        projects,
        allProjects,
        sections,
        allSections,
        areas,
        people,
        settings,
        duplicateTask,
        promoteTaskToProject,
        convertTaskToSection,
        resetTaskChecklist,
        skipRecurringTaskOccurrence,
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
        activeTasksByStatus,
        projectMap,
        focusedCount,
        sequentialProjectIds,
        sequentialWithinSectionProjectIds,
    } = useTaskStore((state) => {
        const derived = state.getDerivedState();
        return {
            tasks: state.tasks,
            allTasks: state._allTasks,
            projects: state.projects,
            allProjects: state._allProjects,
            sections: state.sections,
            allSections: state._allSections,
            areas: state.areas,
            people: state.people,
            settings: state.settings,
            duplicateTask: state.duplicateTask,
            promoteTaskToProject: state.promoteTaskToProject,
            convertTaskToSection: state.convertTaskToSection,
            resetTaskChecklist: state.resetTaskChecklist,
            skipRecurringTaskOccurrence: state.skipRecurringTaskOccurrence,
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
            activeTasksByStatus: derived.activeTasksByStatus,
            projectMap: derived.projectMap,
            focusedCount: derived.focusedCount,
            sequentialProjectIds: derived.sequentialProjectIds,
            sequentialWithinSectionProjectIds: derived.sequentialWithinSectionProjectIds,
        };
    }, shallow);
    const contextHistory = useMemo(
        () => getRetainedTaskContexts(allTasks),
        [allTasks],
    );
    const { t, language } = useLanguage();
    // Already identity-stable: resolveThemeTokens caches its result on the theme,
    // so this only changes when a colour actually does (#766).
    const tc = useThemeColors();
    const adaptiveWindow = useAdaptiveWindow();
    const reducedMotion = useReducedMotion();
    const constrainEditorSurface = adaptiveWindow.isExpanded || Boolean(adaptiveWindow.activeFeature);
    const resolvedFeatureFlags = resolveFeatureFlags(settings);
    const prioritiesEnabled = resolvedFeatureFlags.priorities;
    const timeEstimatesEnabled = resolvedFeatureFlags.timeEstimates;
    const timeSpentEnabled = isTaskEditorTimeSpentEnabled(settings);
    const resetCopilotStateRef = useRef<() => void>(() => {});
    const settleAttachmentDraftRef = useRef<(input: AttachmentDraftSettlementInput) => void>(() => {});
    const settleAttachmentDraft = useCallback((input: AttachmentDraftSettlementInput) => {
        settleAttachmentDraftRef.current(input);
    }, []);
    const descriptionToolbarInteractionUntilRef = useRef(0);
    const readOnlyRef = useRef(readOnly);
    const onSaveRef = useRef(onSave);
    readOnlyRef.current = readOnly;
    onSaveRef.current = onSave;
    const guardedOnSave = useCallback((taskId: string, updates: Partial<Task>) => {
        if (readOnlyRef.current) return { success: false };
        return onSaveRef.current(taskId, updates);
    }, []);
    const canMutate = useCallback(() => !readOnlyRef.current, []);
    const showTaskWriteError = useCallback((message?: string) => showToast({
        title: tFallback(t, 'common.error', 'Error'),
        message: message || tFallback(t, 'task.updateFailed', 'Could not update task.'),
        tone: 'error',
        durationMs: 4200,
    }), [showToast, t]);
    const {
        aiModal,
        acknowledgeRecoveredActivityInput,
        checklistDraftRef,
        cancelRetryPending,
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
        recoveredActivityInput,
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
        trackActivityInputFocus,
        trackActivityInputSelection,
        draftLifecycle,
        titleDebounceRef,
        titleDraft,
        titleDraftRef,
    } = useTaskEditState({
        defaultTab,
        onClose,
        onSave: guardedOnSave,
        onSaveError: showTaskWriteError,
        resetCopilotStateRef,
        settleAttachmentDraft,
        sections,
        task,
        tasks,
        translate: t,
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
        language,
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
        settleDraftAttachments,
        toggleAudioPlayback,
        visibleAttachments,
    } = useTaskEditAttachments({
        attachments: taskEditDraft?.attachments,
        canMutate,
        setAttachments,
        setDraftField,
        taskId: task?.id,
        t,
        visible,
    });
    settleAttachmentDraftRef.current = settleDraftAttachments;

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
        contextHistory,
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
    const destinationFields = useMemo(
        () => basicFields.filter((fieldId) => fieldId === 'project' || fieldId === 'area'),
        [basicFields],
    );
    const isReference = (taskEditDraft?.draft.status ?? task?.status) === 'reference';
    const readOnlyProjectSections = useMemo(() => {
        if (!readOnly || !task?.projectId) return [];
        const project = allProjects.find((candidate) => candidate.id === task.projectId);
        return getProjectSectionsForView(project, sections, allSections);
    }, [allProjects, allSections, readOnly, sections, task?.projectId]);
    const hasProject = taskEditDraft ? Boolean(taskEditDraft.draft.projectId) : Boolean(task?.projectId);
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
    const handleCreateSomedaySection = useCallback(async (title: string) => {
        if (!canMutate()) return null;
        try {
            return await createSomedaySection(title);
        } catch {
            showToast({
                title: tFallback(t, 'common.error', 'Error'),
                message: tFallback(t, 'viewSections.updateFailed', 'Could not update Someday sections.'),
                tone: 'error',
            });
            return null;
        }
    }, [canMutate, showToast, t]);

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
    const backdatedCompletionStart = useMemo(() => task
        ? getTaskEditorBackdatedCompletionStart(task, taskEditDraft?.draft ?? createTaskDraft(task))
        : null, [task, taskEditDraft?.draft]);
    const focusStar = useMemo(() => {
        if (!task || !taskEditDraft || readOnly || task.deletedAt || task.status === 'archived') return undefined;
        const limit = normalizeFocusTaskLimit(settings.gtd?.focusTaskLimit);
        const action = resolveTaskEditorFocusStar(task, taskEditDraft.draft, {
            tasks: collectFocusEligibilityTasks(activeTasksByStatus),
            projects: projectMap,
            sections,
            focusedCount,
            focusTaskLimit: limit,
            sequentialProjectIds,
            sectionScopedProjectIds: sequentialWithinSectionProjectIds,
        });
        const blocked = getFocusStarBlockedText(t, action, limit);
        const label = tFallback(t, action.labelKey, action.isFocused ? 'Remove from focus' : "Add to today's focus");
        const queuedHint = tFallback(t, 'agenda.focusWhenAvailable', 'Focus when available');
        return {
            focused: action.isFocused,
            disabled: !action.canToggle,
            label: blocked ?? (action.queued ? (action.isFocused ? `${label}. ${queuedHint}` : queuedHint) : label),
            onToggle: () => setDraftField('focusedToday', !action.isFocused),
        };
    }, [activeTasksByStatus, focusedCount, projectMap, readOnly, sections, sequentialProjectIds,
        sequentialWithinSectionProjectIds, settings, setDraftField, t, task, taskEditDraft]);

    const [customRecurrenceVisible, setCustomRecurrenceVisible] = useState(false);
    const [customInterval, setCustomInterval] = useState(1);
    const [customMode, setCustomMode] = useState<'date' | 'nth' | 'lastDay'>('date');
    const [customOrdinal, setCustomOrdinal] = useState<'1' | '2' | '3' | '4' | '-1'>('1');
    const [customWeekday, setCustomWeekday] = useState<RecurrenceWeekday | 'WEEKDAY'>(monthlyWeekdayCode);
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
    const [isModalShown, setIsModalShown] = useState(false);

    const toggleCustomMonthDay = useCallback((day: number) => {
        setCustomMonthDays((current) => {
            if (!current.includes(day)) return [...current, day].sort((a, b) => a - b);
            // The rule needs at least one day, so ignore the tap that would empty it.
            return current.length > 1 ? current.filter((value) => value !== day) : current;
        });
    }, []);

    const openCustomRecurrence = useCallback(() => {
        const custom = getTaskEditorMonthlyCustom(recurrenceRRuleValue, monthlyAnchorDate);
        setCustomInterval(custom.interval);
        setCustomMode(custom.mode);
        setCustomOrdinal(custom.ordinal);
        setCustomWeekday(custom.weekday);
        setCustomMonthDays(custom.monthDays);
        setCustomRecurrenceVisible(true);
    }, [monthlyAnchorDate, recurrenceRRuleValue]);

    const applyCustomRecurrence = useCallback(() => {
        const rrule = buildTaskEditorMonthlyCustomRRule(recurrenceRRuleValue, {
            interval: customInterval,
            mode: customMode,
            ordinal: customOrdinal,
            weekday: customWeekday,
            monthDays: customMonthDays,
        });
        setDraftField('recurrence', 'monthly');
        setDraftField('recurrenceStrategy', recurrenceStrategyValue);
        setDraftField('recurrenceRRule', rrule);
        setCustomRecurrenceVisible(false);
    }, [customInterval, customMode, customOrdinal, customWeekday, customMonthDays, recurrenceRRuleValue, recurrenceStrategyValue, setDraftField]);

    const [isMarkdownOverlayOpen, setIsMarkdownOverlayOpen] = useState(false);
    const titleInputRef = useRef<TextInput>(null);
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
            setIsModalShown(false);
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
    const setDescriptionInputFocused = descriptionEditor.setIsDescriptionInputFocused;
    const setDescriptionSelection = descriptionEditor.setDescriptionSelection;
    const setDescriptionInputFocusedWithActivityTracking = useCallback<React.Dispatch<React.SetStateAction<boolean>>>((next) => {
        setDescriptionInputFocused((current) => {
            const focused = typeof next === 'function' ? next(current) : next;
            trackActivityInputFocus('description', focused);
            return focused;
        });
    }, [setDescriptionInputFocused, trackActivityInputFocus]);
    const setDescriptionSelectionWithActivityTracking = useCallback((selection: { start: number; end: number }) => {
        setDescriptionSelection(selection);
        trackActivityInputSelection('description', selection);
    }, [setDescriptionSelection, trackActivityInputSelection]);

    useEffect(() => restoreRecoveredTaskEditInput({
        acknowledge: acknowledgeRecoveredActivityInput,
        descriptionInputRef: descriptionEditor.descriptionInputRef,
        editTab,
        recoveredInput: visible && isModalShown ? recoveredActivityInput : null,
        titleInputRef,
    }), [
        acknowledgeRecoveredActivityInput,
        descriptionEditor.descriptionInputRef,
        editTab,
        isModalShown,
        recoveredActivityInput,
        visible,
    ]);
    const handleTitleInputFocusChange = useCallback((focused: boolean) => {
        setIsTitleInputFocused(focused);
        trackActivityInputFocus('title', focused);
    }, [trackActivityInputFocus]);
    const handleTitleSelectionChange = useCallback((selection: { start: number; end: number }) => {
        trackActivityInputSelection('title', selection);
    }, [trackActivityInputSelection]);

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
        if (!canMutate()) return null;
        const created = await addPerson(name);
        if (created && canMutate()) {
            setDraftField('assignedTo', created.name);
        }
        return created;
    }, [addPerson, canMutate, setDraftField]);
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
    const handleConvertToAction = useCallback(() => {
        requestStatusChange('next');
    }, [requestStatusChange]);
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
        updateContextInput(toggleTaskEditorToken(contextInputDraft, token, '@'));
    }, [contextInputDraft, updateContextInput]);
    const toggleQuickTagToken = useCallback((token: string) => {
        updateTagInput(toggleTaskEditorToken(tagInputDraft, token, '#'));
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
        handleConvertToSection,
        handleCancelTask,
        handleSkipOccurrence,
        handleDeleteTask,
        handleDone,
        handleDuplicateTask,
        handlePromoteTaskToProject,
        projectConversionOpen, setProjectConversionOpen, confirmProjectConversion,
        handleResetChecklist,
        handleShare,
    } = useTaskEditActions({
        aiEnabled,
        language,
        closeAIModal,
        deleteTask,
        descriptionDraft,
        draftLifecycle,
        duplicateTask,
        promoteTaskToProject,
        convertTaskToSection,
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
        skipRecurringTaskOccurrence,
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
        canMutate,
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
        setDescriptionSelection: setDescriptionSelectionWithActivityTracking,
        descriptionToolbarInteractionUntilRef,
        isDescriptionInputFocused: descriptionEditor.isDescriptionInputFocused,
        setIsDescriptionInputFocused: setDescriptionInputFocusedWithActivityTracking,
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
        destinationFields,
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
        setDescriptionSelectionWithActivityTracking,
        setDescriptionInputFocusedWithActivityTracking,
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
        destinationFields,
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

    const previewTask = readOnly ? task : mergedTask;
    const previewAttachments = readOnly
        ? (task.attachments ?? []).filter((attachment) => !attachment.deletedAt)
        : visibleAttachments;

    return (
        <>
        <Modal
            visible={visible}
            animationType={reducedMotion ? 'none' : (adaptiveWindow.isExpanded ? 'fade' : 'slide')}
            presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
            allowSwipeDismissal
            onShow={() => setIsModalShown(true)}
            onRequestClose={readOnly ? onClose : handleAttemptClose}
        >
            <KeyboardAccessoryHost backgroundColor={tc.bg}>
                <AdaptiveModalSurface
                    variant="editor"
                    style={[styles.container, { backgroundColor: tc.bg }]}
                    testID="task-edit-adaptive-surface"
                >
                <SafeAreaView
                    style={[styles.container, { backgroundColor: tc.bg }]}
                    edges={constrainEditorSurface ? [] : (Platform.OS === 'android' ? ['top', 'bottom'] : ['top'])}
                >
                    {projectConversionOpen && task && <TaskProjectConversionModal
                        task={{ ...task, ...mergedTask } as Task} onConfirm={confirmProjectConversion}
                        onClose={() => setProjectConversionOpen(false)} />}
                    <SandboxWorkspaceCue />
                    <TaskEditHeader
                        onDone={readOnly ? onClose : handleDone}
                        onClose={readOnly ? onClose : handleAttemptClose}
                        onShare={handleShare}
                        onDuplicate={handleDuplicateTask}
                        onPromoteToProject={handlePromoteTaskToProject}
                        onCancelTask={task && (cancelRetryPending || isTaskActionable(task)) && !isProjectedRecurringTask(task)
                            ? handleCancelTask
                            : undefined}
                        onSkipOccurrence={task && !readOnly && !isProjectedRecurringTask(task) && canSkipRecurringTaskOccurrence(task)
                            ? handleSkipOccurrence
                            : undefined}
                        cancelTaskLabel={task?.recurrence
                            ? tFallback(t, 'task.cancelRecurringSeries', 'Cancel recurring series')
                            : tFallback(t, 'task.cancel', 'Cancel task')}
                        onDelete={handleDeleteTask}
                        onConvertToAction={handleConvertToAction}
                        showConvertToAction={isReference}
                        onConvertToSection={handleConvertToSection}
                        showConvertToSection={hasProject}
                        readOnly={readOnly}
                    />

                    {readOnly ? (
                        <View style={styles.tabContent}>
                            <View
                                accessible
                                accessibilityRole="summary"
                                style={{ paddingHorizontal: 16, paddingVertical: 10, backgroundColor: tc.inputBg }}
                                testID="task-edit-read-only-hint"
                            >
                                <Text style={{ color: tc.secondaryText }}>
                                    {tFallback(t, 'projects.archivedReadOnlyHint', 'Archived project. Reactivate it to edit this task.')}
                                </Text>
                            </View>
                            <TaskEditViewTab
                                t={t}
                                tc={tc}
                                styles={styles}
                                mergedTask={previewTask}
                                projects={projects}
                                sections={readOnly ? readOnlyProjectSections : projectSections}
                                areas={areas}
                                prioritiesEnabled={prioritiesEnabled}
                                timeEstimatesEnabled={timeEstimatesEnabled}
                                formatTimeEstimateLabel={formatTimeEstimateLabel}
                                formatDate={formatDate}
                                formatDueDate={formatDueDate}
                                getRecurrenceRuleValue={getRecurrenceRuleValue}
                                getRecurrenceStrategyValue={getRecurrenceStrategyValue}
                                applyChecklistUpdate={applyChecklistUpdate}
                                visibleAttachments={previewAttachments}
                                openAttachment={stableOpenAttachment}
                                isImageAttachment={isImageAttachment}
                                textDirectionStyle={textDirectionStyle}
                                resolvedDirection={resolvedDirection}
                                nestedScrollEnabled
                                onProjectPress={onProjectNavigate ? handlePreviewProjectPress : undefined}
                                onContextPress={onContextNavigate ? handlePreviewContextPress : undefined}
                                onTagPress={onTagNavigate ? handlePreviewTagPress : undefined}
                                showStatusField={showStatusField}
                                readOnly
                            />
                        </View>
                    ) : (
                    <>
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
                            keyboardShouldPersistTaps="handled"
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
                                focusStar={focusStar}
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
                                onCreateSomedaySection={handleCreateSomedaySection}
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
                                titleInputRef={titleInputRef}
                                onTitleDraftChange={handleTitleDraftChange}
                                onTitleSelectionChange={handleTitleSelectionChange}
                                onInputFocusTracked={handleInputFocus}
                                onTitleInputFocusChange={handleTitleInputFocusChange}
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
                                    pendingChecklistDraftRef={checklistDraftRef}
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
                        linkMultiline={!editingLinkAttachmentId}
                        destinationFields={destinationFields}
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
                    </>
                    )}
                </SafeAreaView>
                </AdaptiveModalSurface>
            </KeyboardAccessoryHost>
            <ToastViewport />
            {/* Last child so the alert covers the header and the toasts (#940). */}
            <ThemedAlertHost />
        </Modal>
        {visible && !readOnly && completedAtPickerVisible ? (
            <CompletedAtPicker
                initialValue={backdatedCompletionStart?.initialValue ?? undefined}
                initialTimeSpentMinutes={backdatedCompletionStart?.initialTimeSpentMinutes ?? undefined}
                showTimeSpent={timeSpentEnabled}
                onCancel={() => setCompletedAtPickerVisible(false)}
                onConfirm={confirmBackdatedCompletion}
                t={t}
                tc={tc}
            />
        ) : null}
        {visible && !readOnly ? (
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
    && prev.readOnly === next.readOnly
    && prev.defaultTab === next.defaultTab
    && prev.automaticDefaultTab === next.automaticDefaultTab
    && prev.onProjectNavigate === next.onProjectNavigate && prev.onContextNavigate === next.onContextNavigate && prev.onTagNavigate === next.onTagNavigate
);

const TaskEditModalWithBoundary = (props: TaskEditModalProps) => {
    const { t } = useLanguage();
    const tc = useThemeColors();
    const taskOpenMode = useTaskOpenMode();
    useEffect(() => {
        if (!props.visible) return;
        useTaskStore.getState().lockEditing();
        return () => useTaskStore.getState().unlockEditing();
    }, [props.visible]);
    if (!taskOpenMode.hydrated) return null;
    const resolvedDefaultTab = resolveTaskOpenTab({
        mode: taskOpenMode.mode,
        automaticTab: props.automaticDefaultTab ?? props.defaultTab ?? 'view',
        explicitEdit: props.defaultTab === 'task',
        readOnly: props.readOnly,
    });
    return (
        <TaskEditModalErrorBoundary onClose={props.onClose} taskId={props.task?.id} t={t} tc={tc}>
            <TaskEditModalInner {...props} defaultTab={resolvedDefaultTab} />
        </TaskEditModalErrorBoundary>
    );
};

export const TaskEditModal = React.memo(TaskEditModalWithBoundary, areTaskEditModalPropsEqual);
