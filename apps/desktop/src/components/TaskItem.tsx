import { useState, memo, useEffect, useRef, useCallback, useMemo, type DragEvent, type ReactNode } from 'react';
import {
    DEFAULT_PROJECT_COLOR,
    Task,
    TaskStatus,
    TaskEditorFieldId,
    type TaskEditorPresentation,
    getProjectNextActionPromptData,
    getLocalizedWeekdayLabels,
    normalizeWeekStartSetting,
    Project,
    type RangeSelectionOptions,
    normalizeClockTimeInput,
    normalizeFocusTaskLimit,
    resolveFeatureFlags,
    tFallback,
    collectFocusEligibilityTasks,
    getFocusStarBlockedText,
    isTaskActionable,
    resolveFocusStarAction,
    parseQuickAddDateCommands,
    parseProjectNextActionInput,
    buildQuickAddParseOptions,
    getPersonOptionNames,
    normalizeTimeSpentMinutes,
    useTaskStore,
    areDraftAttachmentsDirty,
    isTaskDraftDirty,
    type TaskDraftSetter,
} from '@mindwtr/core';
import { cn } from '../lib/utils';
import { useObsidianStore } from '../store/obsidian-store';
import { useLanguage } from '../contexts/language-context';
import { TaskItemEditor } from './Task/TaskItemEditor';
import { TaskItemDisplay } from './Task/TaskItemDisplay';
import { TaskItemEditorSurface } from './Task/TaskItemEditorSurface';
import { TaskItemFieldRenderer } from './Task/TaskItemFieldRenderer';
import { releaseTaskEditSession, tryClaimTaskEditSession } from './Task/task-edit-session';
import { TaskAttachmentOverlays } from './Task/TaskAttachmentOverlays';
import { TaskRecurrenceOverlay } from './Task/TaskRecurrenceOverlay';
import { ProjectNextActionPrompt } from './Task/ProjectNextActionPrompt';
import { ConfirmModal } from './ConfirmModal';
import { PromptModal } from './PromptModal';
import { getDialogFocusableElements } from './ui/Dialog';
import { deleteTaskWithUndo, duplicateTaskAndReveal, TaskQuickActionMenuHost } from './Task/useTaskQuickActionMenuProps';
import {
    getRecurrenceRuleValue,
    getRecurrenceStrategyValue,
    toDateTimeLocalValue,
} from './Task/task-item-helpers';
import { useTaskItemAttachments } from './Task/useTaskItemAttachments';
import { useTaskItemRecurrence } from './Task/useTaskItemRecurrence';
import { useTaskItemAi } from './Task/useTaskItemAi';
import { useTaskItemEditState } from './Task/useTaskItemEditState';
import { useTaskItemProjectContext } from './Task/useTaskItemProjectContext';
import { useTaskItemFieldLayout } from './Task/useTaskItemFieldLayout';
import { useTaskItemSubmit } from './Task/useTaskItemSubmit';
import { formatTaskMarkedDoneMessage, formatTaskMovedMessage } from '@mindwtr/core';
import { dispatchNavigateEvent } from '../lib/navigation-events';
import { usePomodoroStore } from '../store/pomodoro-store';
import { dispatchContextsTokenSelection } from '../lib/contexts-view-state';
import { reportError } from '../lib/report-error';
import { registerUndoableAction } from '../lib/undo-registry';
import { undoTaskCompletion } from '../lib/undo-task-completion';
import { createSomedaySection } from '../lib/someday-section-actions';
import { resolveNativeDateInputLocale } from '../lib/native-date-input-locale';
import { setCalendarTaskDragData } from '../lib/calendar-task-drag';
import { useTaskItemStoreState, useTaskItemUiState } from './Task/useTaskItemStoreState';
import type { TaskInputAcceptedSuggestion } from './Task/TaskInput';
import { TASK_ROW_ACTION_EVENT, type TaskRowAction } from '../lib/task-row-actions';

interface TaskItemProps {
    task: Task;
    project?: Project;
    isSelected?: boolean;
    onSelect?: () => void;
    selectionMode?: boolean;
    isMultiSelected?: boolean;
    onToggleSelect?: (options?: RangeSelectionOptions) => void;
    showQuickDone?: boolean;
    showStatusSelect?: boolean;
    showProjectBadgeInActions?: boolean;
    showProjectBadgeInMetadata?: boolean;
    actionsOverlay?: boolean;
    dragHandle?: ReactNode;
    focusToggle?: {
        isFocused: boolean;
        canToggle: boolean;
        onToggle: () => void;
        title: string;
        ariaLabel: string;
        alwaysVisible?: boolean;
    };
    readOnly?: boolean;
    interactionDisabled?: boolean;
    compactMetaEnabled?: boolean;
    enableDoubleClickEdit?: boolean;
    showHoverHint?: boolean;
    editorPresentation?: TaskEditorPresentation;
    appearsAtLabel?: string;
    projectDeadlineLabel?: string;
}

type ProjectNextActionPromptState = {
    candidates: Task[];
    projectId: string;
    projectTitle: string;
    sectionId?: string;
    scope: 'project' | 'section';
    sectionTitle?: string;
};

export const TaskItem = memo(function TaskItem({
    task,
    project: propProject,
    isSelected,
    onSelect,
    selectionMode = false,
    isMultiSelected = false,
    onToggleSelect,
    showQuickDone = true,
    showStatusSelect = true,
    showProjectBadgeInActions = true,
    showProjectBadgeInMetadata = true,
    actionsOverlay = false,
    dragHandle,
    focusToggle,
    readOnly = false,
    interactionDisabled = false,
    compactMetaEnabled = true,
    enableDoubleClickEdit = false,
    showHoverHint = true,
    editorPresentation,
    appearsAtLabel,
    projectDeadlineLabel,
}: TaskItemProps) {
    const [isEditing, setIsEditing] = useState(false);
    const [autoFocusTitle, setAutoFocusTitle] = useState(false);
    const showObsidianNoteAttachment = useObsidianStore((state) => state.config.enabled);
    const [quickActionMenu, setQuickActionMenu] = useState<{ x: number; y: number } | null>(null);
    const [renameRequestToken, setRenameRequestToken] = useState(0);
    const taskRootRef = useRef<HTMLDivElement | null>(null);
    const quickActionReturnFocusRef = useRef<HTMLElement | null>(null);
    const modalEditorRef = useRef<HTMLDivElement | null>(null);
    const lastFocusedBeforeModalRef = useRef<HTMLElement | null>(null);
    const {
        updateTask,
        addTask,
        moveTask,
        projects,
        sections,
        areas,
        project: storeProject,
        mutationProject,
        section: storeSection,
        projectArea,
        taskArea: storeTaskArea,
        settings,
        focusedCount,
        promoteTaskToProject,
        convertTaskToSection,
        resetTaskChecklist,
        highlightTaskId,
        setHighlightTask,
        addProject,
        addArea,
        addPerson,
        addSection,
        lockEditing,
        unlockEditing,
        projectMap,
        activeTasksByStatus,
        sequentialProjectIds,
        sequentialWithinSectionProjectIds,
    } = useTaskItemStoreState({
        task,
        propProject,
        isEditing,
        hasQuickActionMenu: Boolean(quickActionMenu),
    });
    const {
        setProjectView,
        editingTaskId,
        setEditingTaskId,
        isTaskExpanded,
        setTaskExpanded,
        toggleTaskExpanded,
        showToast,
    } = useTaskItemUiState(task.id);
    const setSelectedProjectId = useCallback(
        (value: string | null) => setProjectView({ selectedProjectId: value }),
        [setProjectView]
    );
    const { t, language } = useLanguage();
    const nativeDateInputLocale = useMemo(() => {
        const systemLocale = typeof navigator !== 'undefined'
            ? String(navigator.languages?.[0] || navigator.language || '').trim()
            : '';
        return resolveNativeDateInputLocale({
            language,
            dateFormat: settings?.dateFormat,
            calendarSystem: settings?.calendarSystem,
            timeFormat: settings?.timeFormat,
            weekStart: normalizeWeekStartSetting(settings?.weekStart),
            systemLocale,
        });
    }, [language, settings?.calendarSystem, settings?.dateFormat, settings?.timeFormat, settings?.weekStart]);
    const recurrenceWeekdayLabels = useMemo(
        () => getLocalizedWeekdayLabels(language, 'long'),
        [language]
    );
    // Kept whole: the attachment overlays take the hook result itself, so only
    // what the row's own surfaces need is unpacked here.
    const attachments = useTaskItemAttachments({ task, t });
    const {
        editAttachments,
        attachmentError,
        addFileAttachment,
        addDroppedFileAttachments,
        addLinkAttachment,
        addObsidianNoteAttachment,
        editLinkAttachment,
        removeAttachment,
        openAttachment,
        beginAttachmentSave,
        cancelAttachmentSaveBeforeStoreUpdate,
        resetAttachmentState,
        settlePersistedAttachmentSave,
    } = attachments;
    const {
        baselineTask: editBaselineTask,
        draft,
        setField: setDraftField,
        showDescriptionPreview,
        setShowDescriptionPreview,
        resetEditState: resetLocalEditState,
    } = useTaskItemEditState({
        task,
        resetAttachmentState,
    });
    const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
    const [showWaitingAssignmentPrompt, setShowWaitingAssignmentPrompt] = useState(false);
    // Read lazily when the prompt opens: the editor-scoped assignedToOptions
    // are only loaded while editing, and this prompt also opens outside edits.
    const waitingAssignmentSuggestions = useMemo(() => {
        if (!showWaitingAssignmentPrompt) return [];
        const storeState = useTaskStore.getState();
        return getPersonOptionNames(storeState.people, storeState.tasks);
    }, [showWaitingAssignmentPrompt]);
    const [completedAtPrompt, setCompletedAtPrompt] = useState<null | 'complete' | 'editor-complete' | 'edit'>(null);
    const [projectNextActionPrompt, setProjectNextActionPrompt] = useState<ProjectNextActionPromptState | null>(null);
    const projectNextActionPromptRef = useRef<ProjectNextActionPromptState | null>(null);
    projectNextActionPromptRef.current = projectNextActionPrompt;
    const mutationPromptOwnerTaskIdRef = useRef(task.id);
    const [projectNextActionTitle, setProjectNextActionTitle] = useState('');
    const resolvedFeatureFlags = resolveFeatureFlags(settings);
    const prioritiesEnabled = resolvedFeatureFlags.priorities;
    const timeEstimatesEnabled = resolvedFeatureFlags.timeEstimates;
    const undoNotificationsEnabled = settings?.undoNotificationsEnabled !== false;
    const showTaskAge = settings?.appearance?.showTaskAge === true;
    const focusTaskLimit = normalizeFocusTaskLimit(settings?.gtd?.focusTaskLimit);
    const density = settings?.appearance?.density ?? 'comfortable';
    const isCondensed = density === 'condensed';
    const isCompact = density === 'compact';
    const isDense = isCompact || isCondensed;
    const isHighlighted = highlightTaskId === task.id;
    const recurrenceRule = getRecurrenceRuleValue(task.recurrence);
    const recurrenceStrategy = getRecurrenceStrategyValue(task.recurrence);
    const isStagnant = (task.pushCount ?? 0) > 3;
    const effectiveReadOnly = interactionDisabled || readOnly || task.status === 'done';
    const mutationOwnerRef = useRef({
        taskId: task.id,
        interactionDisabled,
        readOnly,
    });
    mutationOwnerRef.current = {
        taskId: task.id,
        interactionDisabled,
        readOnly,
    };
    const getLiveMutableTask = useCallback((
        expectedTaskId: string,
        options?: { allowCompleted?: boolean },
    ): Task | null => {
        const owner = mutationOwnerRef.current;
        if (
            owner.taskId !== expectedTaskId
            || owner.interactionDisabled
            || owner.readOnly
        ) {
            return null;
        }
        const state = useTaskStore.getState();
        const liveTask = state._tasksById.get(expectedTaskId)
            ?? state._allTasks.find((candidate) => candidate.id === expectedTaskId);
        if (
            !liveTask
            || liveTask.deletedAt
            || liveTask.status === 'archived'
            || (!options?.allowCompleted && liveTask.status === 'done')
        ) {
            return null;
        }
        if (liveTask.projectId) {
            const liveProject = state._projectsById.get(liveTask.projectId)
                ?? state._allProjects.find((candidate) => candidate.id === liveTask.projectId);
            if (!liveProject || liveProject.deletedAt || liveProject.status === 'archived') {
                return null;
            }
        }
        return liveTask;
    }, []);
    const projectMutationPromptsReadOnly = interactionDisabled
        || readOnly
        || task.status === 'archived'
        || Boolean(task.projectId && (
            !mutationProject
            || mutationProject.deletedAt
            || mutationProject.status === 'archived'
        ));
    const taskMutationPromptsReadOnly = projectMutationPromptsReadOnly || task.status === 'done';
    const effectiveFocusToggle = effectiveReadOnly ? undefined : focusToggle;
    // Time tracking is opt-in: every time-spent surface (editor field, badge,
    // quick-start) stays hidden unless the Pomodoro timer and its task linking
    // are both enabled, so the default GTD experience is unchanged.
    const timeSpentEnabled = resolvedFeatureFlags.pomodoro
        && settings?.gtd?.pomodoro?.linkTask === true;
    // Task-row entry point into the shared pomodoro store: link this task and
    // start a focus session (never a free-running clock), then show the timer.
    const pomodoroQuickStartEligible = timeSpentEnabled
        && !effectiveReadOnly
        && task.status !== 'archived'
        && task.status !== 'reference';
    const pomodoroSessionCount = usePomodoroStore((state) => (
        pomodoroQuickStartEligible
            ? state.snapshot.sessionHistory.completedFocusSessionsByTaskId[task.id] ?? 0
            : 0
    ));
    const pomodoroAutoStartBreaks = settings?.gtd?.pomodoro?.autoStartBreaks === true;
    const pomodoroAutoStartFocus = settings?.gtd?.pomodoro?.autoStartFocus === true;
    const pomodoroQuickStart = useMemo(() => {
        if (!pomodoroQuickStartEligible) return undefined;
        return {
            sessionCount: pomodoroSessionCount,
            onStart: () => {
                usePomodoroStore.getState().startPomodoroFocusForTask(task.id, {
                    autoStartBreaks: pomodoroAutoStartBreaks,
                    autoStartFocus: pomodoroAutoStartFocus,
                });
                dispatchNavigateEvent('agenda');
            },
        };
    }, [pomodoroAutoStartBreaks, pomodoroAutoStartFocus, pomodoroQuickStartEligible, pomodoroSessionCount, task.id]);
    // An HTML5-draggable ancestor swallows mouse text selection, so rows stop
    // being calendar-drag sources while their read view is expanded (#815).
    const canCalendarDrag = !actionsOverlay && !dragHandle && !selectionMode && !isEditing && !effectiveReadOnly && !isTaskExpanded;
    // Adapter over the core focus-star module: TaskItem supplies its subscribed
    // store slices as context; eligibility, cap, and labels are decided in core.
    const resolveFocusStar = useCallback((options?: { allowUnclarified?: boolean }) => resolveFocusStarAction(task, {
        tasks: collectFocusEligibilityTasks(activeTasksByStatus),
        projects: projectMap,
        focusedCount,
        focusTaskLimit,
        sequentialProjectIds,
        sectionScopedProjectIds: sequentialWithinSectionProjectIds,
        allowUnclarified: options?.allowUnclarified,
    }), [activeTasksByStatus, focusTaskLimit, focusedCount, projectMap, sequentialProjectIds, sequentialWithinSectionProjectIds, task]);
    const toggleTaskFocus = useCallback(() => {
        if (effectiveReadOnly) return;
        const action = resolveFocusStar();
        const blockedText = getFocusStarBlockedText(t, action, focusTaskLimit);
        if (!action.canToggle) {
            if (blockedText) showToast(blockedText, 'info');
            return;
        }
        void updateTask(task.id, action.patch)
            .then((result) => {
                if (!result.success) showToast(result.error || t('task.updateFailed'), 'error');
            });
    }, [effectiveReadOnly, focusTaskLimit, resolveFocusStar, showToast, t, task.id, updateTask]);

    const quickActionFocus = useMemo(() => {
        // Also computed while the editor is open: the editor header shows the
        // same focus star (as a draft field there).
        if ((!quickActionMenu && !isEditing) || effectiveReadOnly) return undefined;
        const action = resolveFocusStar();
        const blockedText = getFocusStarBlockedText(t, action, focusTaskLimit);
        const label = tFallback(
            t,
            action.labelKey,
            action.isFocused ? "Remove from today's focus" : "Add to today's focus",
        );
        return {
            isFocused: action.isFocused,
            canToggle: action.canToggle,
            label,
            title: blockedText ?? label,
            onToggle: toggleTaskFocus,
        };
    }, [effectiveReadOnly, focusTaskLimit, isEditing, quickActionMenu, resolveFocusStar, t, toggleTaskFocus]);

    useEffect(() => {
        const root = taskRootRef.current;
        if (!root) return;
        const handleTaskRowAction = (event: Event) => {
            const action = (event as CustomEvent<TaskRowAction>).detail;
            if (action === 'toggle-focus') {
                toggleTaskFocus();
                return;
            }
            if (action === 'rename-title' && !effectiveReadOnly && !selectionMode && !isEditing) {
                setRenameRequestToken((token) => token + 1);
            }
        };
        root.addEventListener(TASK_ROW_ACTION_EVENT, handleTaskRowAction);
        return () => root.removeEventListener(TASK_ROW_ACTION_EVENT, handleTaskRowAction);
    }, [effectiveReadOnly, isEditing, selectionMode, toggleTaskFocus]);
    const handleToggleChecklistItem = useCallback((index: number) => {
        if (effectiveReadOnly) return;
        const checklist = task.checklist || [];
        if (!checklist[index]) return;
        const nextChecklist = checklist.map((item, i) =>
            i === index ? { ...item, isCompleted: !item.isCompleted } : item
        );
        void updateTask(task.id, { checklist: nextChecklist });
    }, [effectiveReadOnly, task, updateTask]);
    const recurrence = useTaskItemRecurrence({
        task,
        draft,
        setField: setDraftField,
    });
    const { monthlyRecurrence, setShowCustomRecurrence, openCustomRecurrence } = recurrence;

    useEffect(() => {
        if (!isHighlighted) return;
        const timer = setTimeout(() => {
            setHighlightTask(null);
        }, 3500);
        return () => clearTimeout(timer);
    }, [isHighlighted, setHighlightTask]);

    const {
        sectionsByProject,
        currentProject,
        currentTaskArea,
        currentProjectColor,
        projectContext,
        tagOptions,
        popularContextOptions,
        popularTagOptions,
        allContexts,
        assignedToOptions,
    } = useTaskItemProjectContext({
        task,
        project: storeProject,
        projectArea,
        taskArea: storeTaskArea,
        sections,
        isEditing,
        loadTokenOptions: isEditing || Boolean(quickActionMenu),
        editProjectId: draft.projectId,
        setField: setDraftField,
    });

    useEffect(() => {
        const projectId = draft.projectId || task.projectId || '';
        if (!projectId) {
            if (draft.sectionId) setDraftField('sectionId', '');
            return;
        }
        const projectSections = sectionsByProject.get(projectId) ?? [];
        if (draft.sectionId && !projectSections.some((section) => section.id === draft.sectionId)) {
            setDraftField('sectionId', '');
        }
    }, [draft.projectId, draft.sectionId, sectionsByProject, setDraftField, task.projectId]);

    // Kept whole: the editor's AI menu and panels take the hook result itself.
    const ai = useTaskItemAi({
        taskId: task.id,
        settings,
        t,
        editTitle: draft.title,
        editDescription: draft.description,
        editContexts: draft.contexts,
        editTags: draft.tags,
        editStartTime: draft.startTime,
        editDueDate: draft.dueDate,
        editReviewAt: draft.reviewAt,
        contextOptions: allContexts,
        tagOptions,
        projectContext,
        timeEstimatesEnabled,
        setField: setDraftField,
        // Background copilot calls are per-mounted-row; every list/board/review
        // surface renders one of these, so gate them on the row actually being
        // edited instead of firing for every collapsed row on the screen.
        copilotEnabled: isEditing,
    });
    const { resetCopilotDraft, resetAiState } = ai;

    // Desktop-only copilot policy: hand-editing the description invalidates
    // the applied-copilot markers. Editing surfaces get this wrapped setter;
    // the AI hook writes through the raw one.
    const setField = useCallback<TaskDraftSetter>((field, value) => {
        setDraftField(field, value);
        if (field === 'description') resetCopilotDraft();
    }, [resetCopilotDraft, setDraftField]);

    const resetEditState = useCallback(() => {
        resetLocalEditState();
        setShowCustomRecurrence(false);
        resetAiState();
    }, [resetLocalEditState, resetAiState, setShowCustomRecurrence]);
    // Identity of this row instance in the per-task edit-session claim. The
    // same task can render as several rows (Focus grouped by tags), and only
    // the claiming row may run the inline editor.
    const editSessionOwnerRef = useRef<object>({});
    const startEditing = useCallback(() => {
        if (effectiveReadOnly || isEditing) return;
        if (!tryClaimTaskEditSession(task.id, editSessionOwnerRef.current)) return;
        resetEditState();
        setTaskExpanded(task.id, false);
        setAutoFocusTitle(true);
        setIsEditing(true);
        setEditingTaskId(task.id);
    }, [effectiveReadOnly, isEditing, resetEditState, setEditingTaskId, setTaskExpanded, task.id]);

    const handleCreateProject = useCallback(async (title: string) => {
        const trimmed = title.trim();
        if (!trimmed) return null;
        const existing = projects.find((project) => project.title.toLowerCase() === trimmed.toLowerCase());
        if (existing) return existing.id;
        const initialAreaId = draft.areaId || undefined;
        const created = await addProject(
            trimmed,
            DEFAULT_PROJECT_COLOR,
            initialAreaId ? { areaId: initialAreaId } : undefined
        );
        return created?.id ?? null;
    }, [addProject, draft.areaId, projects]);
    const handleCreateArea = useCallback(async (name: string) => {
        const trimmed = name.trim();
        if (!trimmed) return null;
        const existing = areas.find((area) => area.name.toLowerCase() === trimmed.toLowerCase());
        if (existing) return existing.id;
        const created = await addArea(trimmed, { color: DEFAULT_PROJECT_COLOR });
        return created?.id ?? null;
    }, [addArea, areas]);
    const createAssignedToPerson = useCallback(async (name: string) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        const created = await addPerson(trimmed);
        if (created) {
            setDraftField('assignedTo', created.name);
        }
    }, [addPerson, setDraftField]);
    const createWaitingAssignmentPerson = useCallback(async (name: string) => {
        const trimmed = name.trim();
        if (!trimmed || !getLiveMutableTask(task.id)) return;
        await addPerson(trimmed);
    }, [addPerson, getLiveMutableTask, task.id]);
    const handleCreateSection = useCallback(async (title: string) => {
        const trimmed = title.trim();
        if (!trimmed) return null;
        const projectId = draft.projectId || task.projectId;
        if (!projectId) return null;
        const existing = (sectionsByProject.get(projectId) ?? [])
            .find((section) => section.title.toLowerCase() === trimmed.toLowerCase());
        if (existing) return existing.id;
        const created = await addSection(projectId, trimmed);
        return created?.id ?? null;
    }, [addSection, draft.projectId, sectionsByProject, task.projectId]);
    const handleCreateSomedaySection = useCallback(async (title: string) => {
        try {
            return await createSomedaySection(title);
        } catch (error) {
            reportError('Failed to create Someday section', error);
            showToast(tFallback(t, 'viewSections.updateFailed', 'Could not update Someday sections.'), 'error');
            return null;
        }
    }, [showToast, t]);
    const visibleAttachments = (task.attachments || []).filter((a) => !a.deletedAt);
    const visibleEditAttachments = editAttachments.filter((a) => !a.deletedAt);
    const wasEditingRef = useRef(false);

    const {
        organizerFields,
        basicFields,
        basicFieldsBeforeOrganizers,
        basicFieldsAfterOrganizers,
        schedulingFields,
        organizationFields,
        detailsFields,
        sectionCounts,
        sectionOpenDefaults,
    } = useTaskItemFieldLayout({
        settings,
        task,
        draft,
        prioritiesEnabled,
        timeEstimatesEnabled,
        visibleEditAttachmentsLength: visibleEditAttachments.length,
    });
    const activeProjectId = draft.projectId || task.projectId || '';
    const projectSections = activeProjectId ? (sectionsByProject.get(activeProjectId) ?? []) : [];
    const toggleDescriptionPreview = useCallback(() => {
        setShowDescriptionPreview((prev) => !prev);
    }, [setShowDescriptionPreview]);
    const editDescriptionFromPreview = useCallback(() => {
        setShowDescriptionPreview(false);
    }, [setShowDescriptionPreview]);
    const editorEnv = useMemo(() => ({
        t,
        language,
        dateFormatSetting: settings?.dateFormat,
        nativeDateInputLocale,
        defaultScheduleTime: normalizeClockTimeInput(settings?.gtd?.defaultScheduleTime) || '',
        timeSpentEnabled,
        showObsidianNoteAttachment,
    }), [
        t,
        language,
        settings?.dateFormat,
        nativeDateInputLocale,
        settings?.gtd?.defaultScheduleTime,
        timeSpentEnabled,
        showObsidianNoteAttachment,
    ]);
    const editorOptions = useMemo(() => ({
        allContextOptions: allContexts,
        allTagOptions: tagOptions,
        popularContextOptions,
        popularTagOptions,
        assignedToOptions,
    }), [allContexts, tagOptions, popularContextOptions, popularTagOptions, assignedToOptions]);
    const editorAttachments = useMemo(() => ({
        attachmentError,
        visibleEditAttachments,
        addFileAttachment,
        addLinkAttachment,
        addObsidianNoteAttachment,
        editLinkAttachment,
        openAttachment,
        removeAttachment,
    }), [
        attachmentError,
        visibleEditAttachments,
        addFileAttachment,
        addLinkAttachment,
        addObsidianNoteAttachment,
        editLinkAttachment,
        openAttachment,
        removeAttachment,
    ]);
    const editorDescriptionPreview = useMemo(() => ({
        visible: showDescriptionPreview,
        toggle: toggleDescriptionPreview,
        editSource: editDescriptionFromPreview,
    }), [showDescriptionPreview, toggleDescriptionPreview, editDescriptionFromPreview]);
    const canCompleteFromEditor = isTaskActionable(task);
    const requestEditorBackdatedComplete = useCallback(() => setCompletedAtPrompt('editor-complete'), []);
    const editorActions = useMemo(() => ({
        openCustomRecurrence,
        createAssignedToPerson,
        requestBackdatedComplete: canCompleteFromEditor ? requestEditorBackdatedComplete : undefined,
        updateTask,
        resetTaskChecklist,
    }), [
        openCustomRecurrence,
        createAssignedToPerson,
        canCompleteFromEditor,
        requestEditorBackdatedComplete,
        updateTask,
        resetTaskChecklist,
    ]);

    const renderField = (fieldId: TaskEditorFieldId) => (
        <TaskItemFieldRenderer
            fieldId={fieldId}
            task={task}
            draft={draft}
            setField={setField}
            monthlyRecurrence={monthlyRecurrence}
            descriptionPreview={editorDescriptionPreview}
            env={editorEnv}
            options={editorOptions}
            attachments={editorAttachments}
            actions={editorActions}
        />
    );

    useEffect(() => {
        if (effectiveReadOnly && isEditing) {
            setIsEditing(false);
            if (editingTaskId === task.id) {
                setEditingTaskId(null);
            }
            return;
        }
        if (!isEditing) {
            wasEditingRef.current = false;
            return;
        }
        wasEditingRef.current = true;
    }, [effectiveReadOnly, isEditing, editingTaskId, setEditingTaskId, task.id]);

    useEffect(() => {
        if (!isEditing) return;
        if (editingTaskId !== task.id) {
            setIsEditing(false);
        }
    }, [editingTaskId, isEditing, task.id]);

    useEffect(() => {
        if (isEditing) return;
        if (editingTaskId === task.id && !effectiveReadOnly) {
            // Another row instance of this task may already run the editor
            // (Focus grouped by tags renders multi-tag tasks once per group);
            // opening a second editor makes them close each other on click.
            if (!tryClaimTaskEditSession(task.id, editSessionOwnerRef.current)) return;
            setTaskExpanded(task.id, false);
            setAutoFocusTitle(true);
            setIsEditing(true);
        }
    }, [editingTaskId, effectiveReadOnly, isEditing, setTaskExpanded, task.id]);

    useEffect(() => {
        if (!isEditing) return;
        if (!autoFocusTitle) return;
        const raf = requestAnimationFrame(() => setAutoFocusTitle(false));
        return () => cancelAnimationFrame(raf);
    }, [autoFocusTitle, isEditing]);

    useEffect(() => {
        if (isEditing) {
            setTaskExpanded(task.id, false);
        }
    }, [isEditing, setTaskExpanded, task.id]);

    useEffect(() => {
        if (!isEditing) return;
        lockEditing();
        const owner = editSessionOwnerRef.current;
        return () => {
            unlockEditing();
            releaseTaskEditSession(task.id, owner);
        };
    }, [isEditing, lockEditing, task.id, unlockEditing]);


    const handleDiscardChanges = useCallback(() => {
        resetEditState();
        setIsEditing(false);
        if (editingTaskId === task.id) {
            setEditingTaskId(null);
        }
    }, [editingTaskId, resetEditState, setEditingTaskId, task.id]);

    const handleSubmit = useTaskItemSubmit({
        baselineTask: editBaselineTask,
        draft,
        editAttachments,
        editingTaskId,
        setEditingTaskId,
        setIsEditing,
        showToast,
        t,
        task,
        updateTask,
        beginAttachmentSave,
        cancelAttachmentSaveBeforeStoreUpdate,
        settlePersistedAttachmentSave,
    });

    const project = currentProject;
    const taskArea = currentTaskArea;
    const projectColor = currentProjectColor;
    const handleOpenProject = useCallback((projectId: string) => {
        setHighlightTask(task.id);
        setSelectedProjectId(projectId);
        dispatchNavigateEvent('projects');
    }, [setHighlightTask, setSelectedProjectId, task.id]);
    const handleDuplicateTask = useCallback(
        () => duplicateTaskAndReveal(task, { t }),
        [t, task],
    );
    const handlePromoteTaskToProject = useCallback(async () => {
        if (effectiveReadOnly) return;
        try {
            const result = await promoteTaskToProject(task.id);
            if (!result.success || !result.id) {
                showToast(result.error || t('task.promoteToProjectFailed'), 'error');
                return;
            }
            showToast(
                result.reused ? t('task.promoteToProjectMoved') : t('task.promoteToProjectCreated'),
                'success',
            );
            setHighlightTask(task.id);
            setSelectedProjectId(result.id);
            setEditingTaskId(null);
            setTaskExpanded(task.id, false);
            dispatchNavigateEvent('projects');
            if (typeof window !== 'undefined') {
                window.setTimeout(() => {
                    window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                        detail: {
                            initialProps: {
                                projectId: result.id,
                                status: 'next',
                            },
                        },
                    }));
                }, 80);
            }
        } catch (error) {
            reportError('Failed to create project from task', error);
            showToast(t('task.promoteToProjectFailed'), 'error');
        }
    }, [effectiveReadOnly, promoteTaskToProject, setEditingTaskId, setHighlightTask, setSelectedProjectId, setTaskExpanded, showToast, t, task.id]);
    const handleConvertTaskToSection = useCallback(async () => {
        if (effectiveReadOnly) return;
        try {
            const result = await convertTaskToSection(task.id);
            if (!result.success) {
                showToast(result.error || t('task.convertToSectionFailed'), 'error');
                return;
            }
            showToast(t('task.convertToSectionCreated'), 'success');
            setEditingTaskId(null);
            setTaskExpanded(task.id, false);
        } catch (error) {
            reportError('Failed to convert task to a section', error);
            showToast(t('task.convertToSectionFailed'), 'error');
        }
    }, [convertTaskToSection, effectiveReadOnly, setEditingTaskId, setTaskExpanded, showToast, t, task.id]);
    const handleOpenContextToken = useCallback((token: string) => {
        setHighlightTask(task.id);
        dispatchContextsTokenSelection(token);
        dispatchNavigateEvent('contexts');
    }, [setHighlightTask, task.id]);
    const undoLabel = useMemo(() => tFallback(t, 'common.undo', 'Undo'), [t]);
    const closeProjectNextActionPrompt = useCallback(() => {
        projectNextActionPromptRef.current = null;
        setProjectNextActionPrompt(null);
        setProjectNextActionTitle('');
    }, []);
    useEffect(() => {
        const taskChanged = mutationPromptOwnerTaskIdRef.current !== task.id;
        if (taskChanged) {
            mutationPromptOwnerTaskIdRef.current = task.id;
        }
        if (taskChanged || taskMutationPromptsReadOnly) {
            setShowWaitingAssignmentPrompt(false);
            setCompletedAtPrompt(null);
        }
        if (taskChanged || projectMutationPromptsReadOnly) {
            closeProjectNextActionPrompt();
        }
    }, [
        closeProjectNextActionPrompt,
        projectMutationPromptsReadOnly,
        task.id,
        taskMutationPromptsReadOnly,
    ]);
    const openProjectNextActionPromptIfNeeded = useCallback((completedTaskId: string) => {
        if (!getLiveMutableTask(completedTaskId, { allowCompleted: true })) return;
        const storeState = useTaskStore.getState();
        const completedTask = storeState._tasksById.get(completedTaskId)
            ?? storeState._allTasks.find((candidate) => candidate.id === completedTaskId)
            ?? { ...task, status: 'done' as TaskStatus };
        const promptData = getProjectNextActionPromptData(
            completedTask,
            storeState._allTasks,
            storeState._allProjects,
        );
        if (!promptData) return;
        setProjectNextActionTitle('');
        const nextPrompt = {
            candidates: promptData.candidates,
            projectId: promptData.project.id,
            projectTitle: promptData.project.title,
            sectionId: completedTask.sectionId,
            scope: promptData.scope,
            sectionTitle: promptData.scope === 'section' && completedTask.sectionId
                ? storeState.sections.find((section) => section.id === completedTask.sectionId)?.title
                : undefined,
        } satisfies ProjectNextActionPromptState;
        projectNextActionPromptRef.current = nextPrompt;
        setProjectNextActionPrompt(nextPrompt);
    }, [getLiveMutableTask, task]);
    const handlePromoteProjectNextAction = useCallback((nextTaskId: string) => {
        const prompt = projectNextActionPrompt;
        const liveOwner = getLiveMutableTask(task.id, { allowCompleted: true });
        if (
            !prompt
            || projectNextActionPromptRef.current !== prompt
            || !liveOwner
            || liveOwner.projectId !== prompt.projectId
        ) {
            return;
        }
        const state = useTaskStore.getState();
        const liveCandidate = state._tasksById.get(nextTaskId)
            ?? state._allTasks.find((candidate) => candidate.id === nextTaskId);
        if (
            !liveCandidate
            || liveCandidate.deletedAt
            || liveCandidate.projectId !== prompt.projectId
            || liveCandidate.status === 'done'
            || liveCandidate.status === 'archived'
        ) {
            return;
        }
        void moveTask(nextTaskId, 'next')
            .then((result) => {
                if (!result.success) {
                    throw new Error(result.error || 'Failed to choose next action');
                }
                if (
                    projectNextActionPromptRef.current === prompt
                    && getLiveMutableTask(task.id, { allowCompleted: true })
                ) {
                    closeProjectNextActionPrompt();
                }
            })
            .catch((error) => reportError('Failed to choose project next action', error));
    }, [closeProjectNextActionPrompt, getLiveMutableTask, moveTask, projectNextActionPrompt, task.id]);
    const handleAddProjectNextAction = useCallback(() => {
        const prompt = projectNextActionPrompt;
        const liveOwner = getLiveMutableTask(task.id, { allowCompleted: true });
        if (
            !prompt
            || projectNextActionPromptRef.current !== prompt
            || !liveOwner
            || liveOwner.projectId !== prompt.projectId
        ) {
            return;
        }
        const rawTitle = projectNextActionTitle.trim();
        if (!rawTitle) return;
        // Same quick-add grammar as the quick-add box, so "/waiting" and
        // friends work from this prompt too (#859). Read lazily: this row
        // component must not subscribe to the whole store.
        const state = useTaskStore.getState();
        const { title, props } = parseProjectNextActionInput(rawTitle, {
            projectId: prompt.projectId,
            sectionId: prompt.sectionId,
            projects: state.projects,
            areas: state.areas,
            parseOptions: buildQuickAddParseOptions(state.settings, state),
        });
        if (
            projectNextActionPromptRef.current !== prompt
            || !getLiveMutableTask(task.id, { allowCompleted: true })
        ) {
            return;
        }
        void addTask(title, props)
            .then((result) => {
                if (!result.success) {
                    throw new Error(result.error || 'Failed to add next action');
                }
                if (
                    projectNextActionPromptRef.current === prompt
                    && getLiveMutableTask(task.id, { allowCompleted: true })
                ) {
                    closeProjectNextActionPrompt();
                }
            })
            .catch((error) => reportError('Failed to add project next action', error));
    }, [addTask, closeProjectNextActionPrompt, getLiveMutableTask, projectNextActionPrompt, projectNextActionTitle, task.id]);
    const handleCompleteProjectNextAction = useCallback(() => {
        const prompt = projectNextActionPrompt;
        const liveOwner = getLiveMutableTask(task.id, { allowCompleted: true });
        if (
            !prompt
            || projectNextActionPromptRef.current !== prompt
            || !liveOwner
            || liveOwner.projectId !== prompt.projectId
        ) {
            return;
        }
        const { projectId } = prompt;
        // Archiving is the same reversible call the Archive button makes and
        // completes the project's remaining tasks in core (no confirmation, see
        // handleArchiveProject in ProjectWorkspace). Read the store lazily so
        // this row component does not subscribe to the project actions.
        void Promise.resolve(useTaskStore.getState().updateProject(projectId, { status: 'archived' }))
            .then((result) => {
                if (result && result.success === false) {
                    throw new Error(result.error || 'Failed to complete project');
                }
                if (projectNextActionPromptRef.current === prompt) {
                    closeProjectNextActionPrompt();
                }
            })
            .catch((error) => reportError('Failed to complete project from next-action prompt', error));
    }, [closeProjectNextActionPrompt, getLiveMutableTask, projectNextActionPrompt, task.id]);
    const closeWaitingAssignmentPrompt = useCallback(() => {
        setShowWaitingAssignmentPrompt(false);
    }, []);
    const applyWaitingAssignment = useCallback((value: string) => {
        const expectedTaskId = task.id;
        if (!getLiveMutableTask(expectedTaskId)) return;
        const assignedTo = value.trim() || undefined;
        setShowWaitingAssignmentPrompt(false);
        void moveTask(expectedTaskId, 'waiting')
            .then(async (result) => {
                if (!result.success) {
                    throw new Error(result.error || 'Failed to change task status');
                }
                if (!getLiveMutableTask(expectedTaskId)) return;
                const updateResult = await updateTask(expectedTaskId, { assignedTo });
                if (!updateResult.success) {
                    throw new Error(updateResult.error || 'Failed to update waiting assignee');
                }
            })
            .catch((error) => reportError('Failed to move task to waiting', error));
    }, [getLiveMutableTask, moveTask, task.id, updateTask]);
    // Deleting is a recoverable move to Trash, so it happens immediately with an
    // undo toast instead of a confirmation prompt. Permanent purge (in Trash)
    // keeps its confirmation.
    const closeQuickEditSession = useCallback(() => {
        // Deleting unmounts this row, so close the edit session here or the
        // stale editingTaskId keeps global keyboard shortcuts suppressed.
        if (isEditing) {
            resetEditState();
            setIsEditing(false);
        }
        if (editingTaskId === task.id) {
            setEditingTaskId(null);
        }
    }, [editingTaskId, isEditing, resetEditState, setEditingTaskId, task.id]);
    const handleDeleteTask = useCallback(() => {
        deleteTaskWithUndo(task.id, { t, onBeforeDelete: closeQuickEditSession });
    }, [closeQuickEditSession, t, task.id]);
    const handleTaskCompleted = useCallback((previousStatus: TaskStatus, wasFocusedToday: boolean) => {
        const undo = registerUndoableAction(() => {
            closeProjectNextActionPrompt();
            void undoTaskCompletion(task.id, previousStatus, wasFocusedToday)
                .catch((error) => reportError('Failed to undo task completion', error));
        });
        if (undoNotificationsEnabled) {
            showToast(
                formatTaskMarkedDoneMessage(t, task.title),
                'info',
                5000,
                {
                    label: undoLabel,
                    onClick: undo,
                }
            );
        }
        openProjectNextActionPromptIfNeeded(task.id);
    }, [
        closeProjectNextActionPrompt,
        openProjectNextActionPromptIfNeeded,
        showToast,
        t,
        task.id,
        task.title,
        undoLabel,
        undoNotificationsEnabled,
    ]);
    const requestBackdatedComplete = useCallback(() => setCompletedAtPrompt('complete'), []);
    const requestEditCompletedAt = useCallback(() => setCompletedAtPrompt('edit'), []);
    const closeCompletedAtPrompt = useCallback(() => setCompletedAtPrompt(null), []);
    const applyCompletedAtPrompt = useCallback((value: string, timeSpentMinutes?: number) => {
        const mode = completedAtPrompt;
        const expectedTaskId = task.id;
        if (!mode || !getLiveMutableTask(expectedTaskId, { allowCompleted: mode === 'edit' })) return;
        setCompletedAtPrompt(null);
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) return;
        const completedAt = parsed.toISOString();
        // Mirrors mobile's `mode === 'complete' && timeSpentEnabled` gate
        // (swipeable-task-item.tsx), plus desktop's editor-complete mode.
        const includeTimeSpent = (mode === 'complete' || mode === 'editor-complete') && timeSpentEnabled;
        if (mode === 'editor-complete') {
            const previousStatus = task.status;
            const wasFocusedToday = task.isFocusedToday === true;
            void handleSubmit(undefined, {
                statusOverride: 'done',
                completedAtOverride: completedAt,
                ...(includeTimeSpent ? { timeSpentMinutesOverride: timeSpentMinutes } : {}),
            })
                .then((result) => {
                    if (!result?.success) return;
                    if (!getLiveMutableTask(expectedTaskId, { allowCompleted: true })) return;
                    handleTaskCompleted(previousStatus, wasFocusedToday);
                })
                .catch((error) => reportError('Failed to mark task done from editor', error));
            return;
        }
        if (mode === 'complete') {
            const previousStatus = task.status;
            const wasFocusedToday = task.isFocusedToday === true;
            const updates: Partial<Task> = { status: 'done', completedAt };
            if (includeTimeSpent) {
                updates.timeSpentMinutes = timeSpentMinutes;
            }
            if (!getLiveMutableTask(expectedTaskId)) return;
            void updateTask(expectedTaskId, updates)
                .then((result) => {
                    if (!result.success) {
                        throw new Error(result.error || 'Failed to complete task');
                    }
                    if (!getLiveMutableTask(expectedTaskId, { allowCompleted: true })) return;
                    if (previousStatus !== 'done') {
                        handleTaskCompleted(previousStatus, wasFocusedToday);
                    }
                })
                .catch((error) => reportError('Failed to complete task', error));
            return;
        }
        if (!getLiveMutableTask(expectedTaskId, { allowCompleted: true })) return;
        void updateTask(expectedTaskId, { completedAt })
            .then((result) => {
                if (!result.success) {
                    throw new Error(result.error || 'Failed to update completion time');
                }
            })
            .catch((error) => reportError('Failed to update completion time', error));
    }, [completedAtPrompt, getLiveMutableTask, handleSubmit, handleTaskCompleted, task.id, task.isFocusedToday, task.status, timeSpentEnabled, updateTask]);
    const handleStatusChange = useCallback((nextStatus: TaskStatus) => {
        if (nextStatus === 'waiting' && task.status !== 'waiting') {
            setShowWaitingAssignmentPrompt(true);
            return;
        }
        const previousStatus = task.status;
        const wasFocusedToday = task.isFocusedToday === true;
        void moveTask(task.id, nextStatus)
            .then((result) => {
                if (!result.success) {
                    throw new Error(result.error || 'Failed to change task status');
                }
                if (nextStatus === 'done' && previousStatus !== 'done') {
                    handleTaskCompleted(previousStatus, wasFocusedToday);
                } else if (nextStatus === 'next' && (previousStatus === 'someday' || previousStatus === 'waiting')) {
                    // The row's ➔ promote removes the task from the list it was
                    // clicked in, so it gets the same toast + undo contract as
                    // completing does (#1053).
                    const undo = registerUndoableAction(() => {
                        void moveTask(task.id, previousStatus)
                            .catch((error) => reportError('Failed to undo task promotion', error));
                    });
                    if (undoNotificationsEnabled) {
                        showToast(
                            formatTaskMovedMessage(t, task.title, 'next'),
                            'info',
                            5000,
                            {
                                label: undoLabel,
                                onClick: undo,
                            }
                        );
                    }
                }
            })
            .catch((error) => reportError('Failed to change task status', error));
    }, [
        handleTaskCompleted,
        moveTask,
        showToast,
        t,
        task.id,
        task.isFocusedToday,
        task.status,
        task.title,
        undoLabel,
        undoNotificationsEnabled,
    ]);
    const handleEditorMarkDone = useCallback(() => {
        if (!isTaskActionable(task)) return;
        const previousStatus = task.status;
        const wasFocusedToday = task.isFocusedToday === true;
        void handleSubmit(undefined, { statusOverride: 'done' })
            .then((result) => {
                if (!result?.success) return;
                handleTaskCompleted(previousStatus, wasFocusedToday);
            })
            .catch((error) => reportError('Failed to mark task done from editor', error));
    }, [handleSubmit, handleTaskCompleted, task.isFocusedToday, task.status]);
    // Attachments count as pending edits too: their records are draft-buffered
    // in useTaskItemAttachments and only persist on Save.
    const hasPendingEdits = useCallback(
        () => isTaskDraftDirty(draft, task) || areDraftAttachmentsDirty(editAttachments, task),
        [draft, editAttachments, task],
    );
    const taskEditorPresentationSetting = settings?.gtd?.taskEditor?.presentation;
    const resolvedEditorPresentation: TaskEditorPresentation = editorPresentation
        ?? (taskEditorPresentationSetting === 'modal' ? 'modal' : 'inline');
    const isModalEditor = resolvedEditorPresentation === 'modal';
    useEffect(() => {
        if (!(isEditing && isModalEditor)) {
            if (lastFocusedBeforeModalRef.current) {
                lastFocusedBeforeModalRef.current.focus();
                lastFocusedBeforeModalRef.current = null;
            }
            return;
        }

        lastFocusedBeforeModalRef.current = document.activeElement as HTMLElement | null;
        const timer = setTimeout(() => {
            const active = document.activeElement as HTMLElement | null;
            if (active && modalEditorRef.current?.contains(active)) {
                return;
            }
            const focusable = getDialogFocusableElements(modalEditorRef.current);
            if (focusable.length > 0) {
                focusable[0].focus();
                return;
            }
            modalEditorRef.current?.focus();
        }, 0);
        return () => clearTimeout(timer);
    }, [isEditing, isModalEditor]);
    const handleEditorCancel = useCallback(() => {
        if (hasPendingEdits()) {
            setShowDiscardConfirm(true);
            return;
        }
        handleDiscardChanges();
    }, [handleDiscardChanges, hasPendingEdits]);
    // Clicking outside an untouched inline editor closes it — there is nothing
    // to lose, so no Save/Cancel trip to the bottom of the form. Once any field
    // differs from the task, the editor stays until an explicit Save/Cancel/Esc.
    useEffect(() => {
        if (!isEditing || isModalEditor) return;
        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (taskRootRef.current?.contains(target)) return;
            // Portaled overlays (quick-action panels, pickers, dialogs) sit
            // outside the row in the DOM but belong to the editing session.
            if (target instanceof Element && target.closest('[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]')) return;
            if (hasPendingEdits()) return;
            handleDiscardChanges();
        };
        document.addEventListener('pointerdown', handlePointerDown, true);
        return () => document.removeEventListener('pointerdown', handlePointerDown, true);
    }, [handleDiscardChanges, hasPendingEdits, isEditing, isModalEditor]);
    const handleOpenQuickActionMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        if (selectionMode || isEditing) return;
        event.preventDefault();
        event.stopPropagation();
        onSelect?.();
        quickActionReturnFocusRef.current = event.currentTarget.querySelector<HTMLElement>('[data-task-quick-actions-trigger]')
            ?? event.currentTarget;
        setQuickActionMenu({
            x: event.clientX,
            y: event.clientY,
        });
    }, [isEditing, onSelect, selectionMode]);
    const handleOpenQuickActionButton = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
        if (selectionMode || isEditing) return;
        event.preventDefault();
        event.stopPropagation();
        onSelect?.();
        quickActionReturnFocusRef.current = event.currentTarget;
        const rect = event.currentTarget.getBoundingClientRect();
        setQuickActionMenu({
            x: rect.left,
            y: rect.bottom + 4,
        });
    }, [isEditing, onSelect, selectionMode]);
    const handleCloseQuickActionMenu = useCallback((options?: { restoreFocus?: boolean }) => {
        setQuickActionMenu(null);
        // Keyboard and menu-action closes return focus to the row's trigger;
        // pointer dismissals must not — the deferred focus() lands after
        // whatever the pointer opened next (another row's menu), yanking focus
        // back and leaving this row wearing the focus-within ring (#999).
        if (options?.restoreFocus === false) {
            quickActionReturnFocusRef.current = null;
            return;
        }
        window.setTimeout(() => {
            quickActionReturnFocusRef.current?.focus();
            quickActionReturnFocusRef.current = null;
        }, 0);
    }, []);

    const handleTitleSuggestionAccept = useCallback((suggestion: TaskInputAcceptedSuggestion): boolean => {
        if (suggestion.kind !== 'command') return false;
        const value = suggestion.value.trim();

        if (suggestion.command === 'note') {
            if (!value) return false;
            const existingDescription = draft.description.trimEnd();
            setField('description', existingDescription ? `${existingDescription}\n\n${value}` : value);
            return true;
        }

        if (suggestion.command === 'due' || suggestion.command === 'start' || suggestion.command === 'review') {
            if (!value) return false;
            const parsed = parseQuickAddDateCommands(`/${suggestion.command}:${value}`, new Date(), {
                defaultScheduleTime: normalizeClockTimeInput(settings?.gtd?.defaultScheduleTime) || undefined,
            });
            if (parsed.invalidDateCommands?.length) return false;
            const parsedValue = suggestion.command === 'due'
                ? parsed.props.dueDate
                : suggestion.command === 'start'
                    ? parsed.props.startTime
                    : parsed.props.reviewAt;
            if (!parsedValue) return false;
            const editorValue = toDateTimeLocalValue(parsedValue);
            if (suggestion.command === 'due') {
                setField('dueDate', editorValue);
            } else if (suggestion.command === 'start') {
                setField('startTime', editorValue);
            } else {
                setField('reviewAt', editorValue);
            }
            return true;
        }

        if (
            suggestion.command === 'inbox'
            || suggestion.command === 'next'
            || suggestion.command === 'waiting'
            || suggestion.command === 'someday'
            || suggestion.command === 'done'
            || suggestion.command === 'archived'
        ) {
            setField('status', suggestion.command);
            return true;
        }

        if (suggestion.command === '*') {
            if (draft.focusedToday) return true;
            const action = resolveFocusStar({ allowUnclarified: true });
            if (!action.canToggle) {
                const blockedText = getFocusStarBlockedText(t, action, focusTaskLimit);
                if (blockedText) showToast(blockedText, 'info');
                return true;
            }
            setField('focusedToday', true);
            return true;
        }

        if (suggestion.command === 'energy') {
            const level = value.toLowerCase();
            if (level !== 'low' && level !== 'medium' && level !== 'high') return false;
            setField('energyLevel', level);
            return true;
        }

        // /link and /area have no draft field mapping here; the editor wrapper
        // resolves /area against its area list, /link stays as text.
        return false;
    }, [
        draft.description,
        draft.focusedToday,
        draft.status,
        focusTaskLimit,
        resolveFocusStar,
        settings?.gtd?.defaultScheduleTime,
        setField,
        showToast,
        t,
    ]);

    useEffect(() => {
        if (!isEditing) return;
        const handleGlobalCancel = (event: Event) => {
            const detail = (event as CustomEvent<{ taskId?: string }>).detail;
            if (detail?.taskId && detail.taskId !== task.id) return;
            handleEditorCancel();
        };
        window.addEventListener('mindwtr:cancel-task-edit', handleGlobalCancel);
        return () => window.removeEventListener('mindwtr:cancel-task-edit', handleGlobalCancel);
    }, [handleEditorCancel, isEditing, task.id]);
    const renderEditor = () => (
        <TaskItemEditor
            t={t}
            draft={draft}
            setField={setField}
            autoFocusTitle={autoFocusTitle}
            ai={ai}
            timeEstimatesEnabled={timeEstimatesEnabled}
            projects={projects}
            areas={areas}
            somedaySections={settings?.gtd?.viewSections?.someday ?? []}
            sections={projectSections}
            onCreateProject={handleCreateProject}
            onCreateArea={handleCreateArea}
            onCreateSection={handleCreateSection}
            onCreateSomedaySection={handleCreateSomedaySection}
            organizerFields={organizerFields}
            basicFieldsBeforeOrganizers={basicFieldsBeforeOrganizers}
            basicFieldsAfterOrganizers={basicFieldsAfterOrganizers}
            schedulingFields={schedulingFields}
            organizationFields={organizationFields}
            detailsFields={detailsFields}
            sectionCounts={sectionCounts}
            sectionOpenDefaults={sectionOpenDefaults}
            renderField={renderField}
            language={language}
            inputContexts={allContexts}
            onAcceptTitleSuggestion={handleTitleSuggestionAccept}
            isDoneActionActive={draft.status === 'done'}
            onMarkDone={canCompleteFromEditor ? handleEditorMarkDone : undefined}
            onRequestBackdatedComplete={canCompleteFromEditor ? requestEditorBackdatedComplete : undefined}
            focusStar={quickActionFocus && canCompleteFromEditor ? (() => {
                // Draft toggle, applied on Save like every other editor field —
                // an immediate write would re-filter the list mid-edit and yank
                // the row (and its open editor) into another view. The editor is
                // the clarifying surface, so unclarified tasks may be starred.
                const action = resolveFocusStar({ allowUnclarified: true });
                const blockedText = getFocusStarBlockedText(t, action, focusTaskLimit);
                const addLabel = tFallback(t, 'agenda.addToFocus', "Add to today's focus");
                const removeLabel = tFallback(t, 'agenda.removeFromFocus', "Remove from today's focus");
                return {
                    isFocused: draft.focusedToday,
                    title: draft.focusedToday ? removeLabel : (blockedText ?? addLabel),
                    onToggle: () => {
                        if (draft.focusedToday) {
                            setField('focusedToday', false);
                            return;
                        }
                        if (!action.canToggle) {
                            if (blockedText) showToast(blockedText, 'info');
                            return;
                        }
                        setField('focusedToday', true);
                    },
                };
            })() : undefined}
            onDeleteTask={task.status === 'inbox' ? handleDeleteTask : undefined}
            onCancel={handleEditorCancel}
            onSubmit={handleSubmit}
            onFilesDropped={(files) => void addDroppedFileAttachments(files)}
        />
    );

    const selectAriaLabel = tFallback(t, 'task.select', 'Select task');
    const displayActions = useMemo(() => ({
        onToggleSelect,
        onToggleView: () => toggleTaskExpanded(task.id),
        onEdit: startEditing,
        onRenameTitle: (nextTitle: string) => {
            void updateTask(task.id, { title: nextTitle });
        },
        onDelete: handleDeleteTask,
        onDuplicate: handleDuplicateTask,
        onStatusChange: handleStatusChange,
        onRequestBackdatedComplete: requestBackdatedComplete,
        onEditCompletedAt: requestEditCompletedAt,
        onOpenQuickActions: handleOpenQuickActionButton,
        onOpenProject: project ? handleOpenProject : undefined,
        onOpenContextToken: handleOpenContextToken,
        openAttachment,
        onToggleChecklistItem: handleToggleChecklistItem,
        focusToggle: effectiveFocusToggle,
        pomodoroQuickStart,
    }), [
        handleDeleteTask,
        handleDuplicateTask,
        effectiveFocusToggle,
        handleOpenContextToken,
        handleOpenProject,
        handleOpenQuickActionButton,
        handleStatusChange,
        handleToggleChecklistItem,
        onToggleSelect,
        openAttachment,
        pomodoroQuickStart,
        project,
        requestBackdatedComplete,
        requestEditCompletedAt,
        startEditing,
        task.id,
        toggleTaskExpanded,
        updateTask,
    ]);
    const handleCalendarDragStart = useCallback((event: DragEvent<HTMLDivElement>) => {
        if (!canCalendarDrag) {
            event.preventDefault();
            return;
        }
        setCalendarTaskDragData(event.dataTransfer, task.id);
    }, [canCalendarDrag, task.id]);
    const showConfiguredStatusSelect = showStatusSelect && basicFields.includes('status');

    return (
        <>
            <div
                ref={taskRootRef}
                data-task-id={task.id}
                draggable={canCalendarDrag}
                tabIndex={-1}
                onDragStart={handleCalendarDragStart}
                onClickCapture={onSelect ? (event) => {
                    if (!event.currentTarget.contains(event.target as Node)) return;
                    onSelect?.();
                } : undefined}
                onDoubleClick={(event) => {
                    if (!enableDoubleClickEdit || selectionMode || effectiveReadOnly || isEditing) return;
                    event.stopPropagation();
                    startEditing();
                }}
                onContextMenu={interactionDisabled ? undefined : handleOpenQuickActionMenu}
                className={cn(
                    "group rounded-lg hover:bg-muted/50 dark:hover:bg-muted/20 transition-colors animate-in fade-in slide-in-from-bottom-2",
                    isCondensed ? "px-2.5 py-1.5" : isCompact ? "p-2.5" : "px-3 py-3",
                    "focus-within:ring-2 focus-within:ring-inset focus-within:ring-primary/40 focus-within:bg-primary/5",
                    canCalendarDrag && "cursor-grab active:cursor-grabbing",
                    isSelected && "ring-2 ring-inset ring-primary/40 bg-primary/5",
                    isHighlighted && "ring-2 ring-inset ring-primary/70 bg-primary/5",
                    // The context menu names no task, so the row it acts on keeps the
                    // selection ring while the menu is open (#999).
                    quickActionMenu !== null && "ring-2 ring-inset ring-primary/40 bg-primary/5"
                )}
            >
                <div className={cn("flex items-start", isCondensed ? "gap-1.5" : isCompact ? "gap-2" : "gap-3")}>
                    {selectionMode && (
                        <input
                            type="checkbox"
                            data-task-selection-checkbox
                            aria-label={selectAriaLabel}
                            checked={isMultiSelected}
                            onClick={(event) => onToggleSelect?.({ range: event.shiftKey })}
                            onChange={() => undefined}
                            className={cn(
                                "h-4 w-4 rounded border-border text-primary focus:ring-primary cursor-pointer",
                                isCondensed ? "mt-0.5" : isCompact ? "mt-1" : "mt-1.5"
                            )}
                        />
                    )}

                    <TaskItemEditorSurface
                        editorAriaLabel={tFallback(t, 'taskEdit.editTask', 'Edit task')}
                        isEditing={isEditing}
                        isModalEditor={isModalEditor}
                        modalEditorRef={modalEditorRef}
                        onCancel={handleEditorCancel}
                        renderDisplay={() => (
                            <TaskItemDisplay
                                task={task}
                                language={language}
                                project={project}
                                section={storeSection}
                                area={taskArea}
                                projectColor={projectColor}
                                selectionMode={selectionMode}
                                isViewOpen={isTaskExpanded}
                                quickActionsOpen={Boolean(quickActionMenu)}
                                actions={displayActions}
                                visibleAttachments={visibleAttachments}
                                recurrenceRule={recurrenceRule}
                                recurrenceStrategy={recurrenceStrategy}
                                prioritiesEnabled={prioritiesEnabled}
                                timeEstimatesEnabled={timeEstimatesEnabled}
                                timeSpentEnabled={timeSpentEnabled}
                                isStagnant={isStagnant}
                                showQuickDone={showQuickDone}
                                showStatusSelect={showConfiguredStatusSelect}
                                showProjectBadgeInActions={showProjectBadgeInActions}
                                showProjectBadgeInMetadata={showProjectBadgeInMetadata}
                                readOnly={effectiveReadOnly}
                                interactionDisabled={interactionDisabled}
                                compactMetaEnabled={compactMetaEnabled}
                                dense={isDense}
                                actionsOverlay={actionsOverlay}
                                dragHandle={dragHandle}
                                showTaskAge={showTaskAge}
                                showHoverHint={showHoverHint}
                                appearsAtLabel={appearsAtLabel}
                                projectDeadlineLabel={projectDeadlineLabel}
                                renameRequestToken={renameRequestToken}
                                theme={settings?.theme}
                                t={t}
                            />
                        )}
                        renderEditor={renderEditor}
                    />
                </div>
            </div>
            {quickActionMenu && (
                <TaskQuickActionMenuHost
                    task={task}
                    x={quickActionMenu.x}
                    y={quickActionMenu.y}
                    onClose={handleCloseQuickActionMenu}
                    overrides={{
                        readOnly: effectiveReadOnly,
                        onRename: () => setRenameRequestToken((token) => token + 1),
                        onPromoteToProject: handlePromoteTaskToProject,
                        onConvertToSection: handleConvertTaskToSection,
                        focusAction: quickActionFocus,
                        onBeforeDelete: closeQuickEditSession,
                        onStatusChange: handleStatusChange,
                    }}
                />
            )}
            {projectNextActionPrompt && (
                <ProjectNextActionPrompt
                    isOpen={Boolean(projectNextActionPrompt)}
                    candidates={projectNextActionPrompt.candidates}
                    projectTitle={projectNextActionPrompt.projectTitle}
                    scope={projectNextActionPrompt.scope}
                    sectionTitle={projectNextActionPrompt.sectionTitle}
                    newTitle={projectNextActionTitle}
                    onAddTask={handleAddProjectNextAction}
                    onCancel={closeProjectNextActionPrompt}
                    onChooseTask={handlePromoteProjectNextAction}
                    onCompleteProject={handleCompleteProjectNextAction}
                    onNewTitleChange={setProjectNextActionTitle}
                    t={t}
                />
            )}
            <TaskRecurrenceOverlay
                recurrence={recurrence}
                weekdayLabels={recurrenceWeekdayLabels}
                t={t}
            />
            <TaskAttachmentOverlays attachments={attachments} t={t} />
            {showWaitingAssignmentPrompt && (
                <PromptModal
                    isOpen
                    title={tFallback(t, 'process.waitingFor', 'Who/what are you waiting for?')}
                    description={tFallback(t, 'process.waitingForDesc', "Add a note to remember what you're waiting on")}
                    placeholder={tFallback(t, 'taskEdit.assignedToPlaceholder', 'Who is this waiting for?')}
                    defaultValue={task.assignedTo || ''}
                    suggestions={waitingAssignmentSuggestions}
                    createLabel={tFallback(t, 'people.new', 'New Person')}
                    onCreate={createWaitingAssignmentPerson}
                    allowEmptyConfirm
                    confirmLabel={t('common.save')}
                    cancelLabel={t('common.cancel')}
                    onCancel={closeWaitingAssignmentPrompt}
                    onConfirm={applyWaitingAssignment}
                />
            )}
            {showDiscardConfirm && (
                <ConfirmModal
                    isOpen
                    title={tFallback(t, 'taskEdit.discardChanges', 'Discard unsaved changes?')}
                    description={tFallback(t, 'taskEdit.discardChangesDesc', 'Your changes will be lost if you leave now.')}
                    confirmLabel={tFallback(t, 'common.discard', 'Discard')}
                    cancelLabel={t('common.cancel')}
                    onCancel={() => setShowDiscardConfirm(false)}
                    onConfirm={() => {
                        setShowDiscardConfirm(false);
                        handleDiscardChanges();
                    }}
                />
            )}
            {completedAtPrompt && (
                <PromptModal
                    isOpen
                    title={tFallback(t, 'task.completedAtPromptTitle', 'Completion time')}
                    defaultValue={toDateTimeLocalValue(
                        completedAtPrompt === 'edit'
                            ? (task.completedAt || task.updatedAt)
                            : new Date().toISOString()
                    )}
                    inputType="datetime-local"
                    numericField={
                        (completedAtPrompt === 'complete' || completedAtPrompt === 'editor-complete') && timeSpentEnabled
                            ? {
                                label: tFallback(t, 'taskEdit.timeSpentLabel', 'Time Spent'),
                                placeholder: tFallback(t, 'taskEdit.timeSpentPlaceholder', 'minutes'),
                                // Seed from the draft in editor-complete mode: the editor
                                // may hold an unsaved Time Spent edit, and the confirmed
                                // value overrides the draft patch. Seeding from the saved
                                // task would silently discard it. Mirrors mobile's
                                // `initialTimeSpentMinutes={mergedTask.timeSpentMinutes}`.
                                defaultValue: normalizeTimeSpentMinutes(
                                    completedAtPrompt === 'editor-complete' ? draft.timeSpentMinutes : task.timeSpentMinutes
                                )?.toString() ?? '',
                            }
                            : undefined
                    }
                    confirmLabel={t('common.save')}
                    cancelLabel={t('common.cancel')}
                    onCancel={closeCompletedAtPrompt}
                    onConfirm={applyCompletedAtPrompt}
                />
            )}
        </>
    );
});
