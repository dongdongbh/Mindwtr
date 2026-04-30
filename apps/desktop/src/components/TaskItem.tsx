import { useState, memo, useEffect, useRef, useCallback, useMemo, type ReactNode } from 'react';
import {
    DEFAULT_PROJECT_COLOR,
    Task,
    TaskStatus,
    TaskEditorFieldId,
    getLocalizedWeekdayLabels,
    Project,
    generateUUID,
    normalizeClockTimeInput,
    tFallback,
} from '@mindwtr/core';
import { cn } from '../lib/utils';
import { useLanguage } from '../contexts/language-context';
import { TaskItemEditor } from './Task/TaskItemEditor';
import { TaskItemDisplay } from './Task/TaskItemDisplay';
import { TaskItemEditorSurface } from './Task/TaskItemEditorSurface';
import { TaskItemFieldRenderer } from './Task/TaskItemFieldRenderer';
import { TaskItemOverlays } from './Task/TaskItemOverlays';
import { TaskQuickActionMenu } from './Task/TaskQuickActionMenu';
import {
    getRecurrenceRuleValue,
    getRecurrenceRRuleValue,
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
import { dispatchNavigateEvent } from '../lib/navigation-events';
import { reportError } from '../lib/report-error';
import { resolveNativeDateInputLocale } from '../lib/native-date-input-locale';
import { useTaskItemStoreState, useTaskItemUiState } from './Task/useTaskItemStoreState';

interface TaskItemProps {
    task: Task;
    project?: Project;
    isSelected?: boolean;
    onSelect?: () => void;
    selectionMode?: boolean;
    isMultiSelected?: boolean;
    onToggleSelect?: () => void;
    showQuickDone?: boolean;
    showStatusSelect?: boolean;
    showProjectBadgeInActions?: boolean;
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
    compactMetaEnabled?: boolean;
    enableDoubleClickEdit?: boolean;
    showHoverHint?: boolean;
    editorPresentation?: 'inline' | 'modal';
}

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
    actionsOverlay = false,
    dragHandle,
    focusToggle,
    readOnly = false,
    compactMetaEnabled = true,
    enableDoubleClickEdit = false,
    showHoverHint = true,
    editorPresentation = 'inline',
}: TaskItemProps) {
    const [isEditing, setIsEditing] = useState(false);
    const [autoFocusTitle, setAutoFocusTitle] = useState(false);
    const [quickActionMenu, setQuickActionMenu] = useState<{ x: number; y: number } | null>(null);
    const modalEditorRef = useRef<HTMLDivElement | null>(null);
    const lastFocusedBeforeModalRef = useRef<HTMLElement | null>(null);
    const {
        updateTask,
        deleteTask,
        moveTask,
        projects,
        sections,
        areas,
        project: storeProject,
        projectArea,
        taskArea: storeTaskArea,
        settings,
        focusedCount,
        duplicateTask,
        resetTaskChecklist,
        restoreTask,
        highlightTaskId,
        setHighlightTask,
        addProject,
        addArea,
        addSection,
        lockEditing,
        unlockEditing,
    } = useTaskItemStoreState({
        task,
        propProject,
        isEditing,
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
            timeFormat: settings?.timeFormat,
            weekStart: settings?.weekStart === 'monday' ? 'monday' : 'sunday',
            systemLocale,
        });
    }, [language, settings?.dateFormat, settings?.timeFormat, settings?.weekStart]);
    const recurrenceWeekdayLabels = useMemo(
        () => getLocalizedWeekdayLabels(language, 'long'),
        [language]
    );
    const {
        editAttachments,
        attachmentError,
        showLinkPrompt,
        setShowLinkPrompt,
        addFileAttachment,
        addLinkAttachment,
        handleAddLinkAttachment,
        removeAttachment,
        openAttachment,
        resetAttachmentState,
        audioAttachment,
        audioSource,
        audioError,
        audioTranscribing,
        audioTranscriptionError,
        audioRef,
        openAudioExternally,
        handleAudioError,
        retryAudioTranscription,
        closeAudio,
        imageAttachment,
        imageSource,
        closeImage,
        textAttachment,
        textContent,
        textError,
        textLoading,
        openTextExternally,
        openImageExternally,
        closeText,
    } = useTaskItemAttachments({ task, t });
    const {
        editTitle,
        setEditTitle,
        editDueDate,
        setEditDueDate,
        editStartTime,
        setEditStartTime,
        editProjectId,
        setEditProjectId,
        editSectionId,
        setEditSectionId,
        editAreaId,
        setEditAreaId,
        editStatus,
        setEditStatus,
        editContexts,
        setEditContexts,
        editTags,
        setEditTags,
        editDescription,
        setEditDescription,
        editLocation,
        setEditLocation,
        editRecurrence,
        setEditRecurrence,
        editRecurrenceStrategy,
        setEditRecurrenceStrategy,
        editRecurrenceRRule,
        setEditRecurrenceRRule,
        editTimeEstimate,
        setEditTimeEstimate,
        editPriority,
        setEditPriority,
        editEnergyLevel,
        setEditEnergyLevel,
        editAssignedTo,
        setEditAssignedTo,
        editReviewAt,
        setEditReviewAt,
        showDescriptionPreview,
        setShowDescriptionPreview,
        resetEditState: resetLocalEditState,
    } = useTaskItemEditState({
        task,
        resetAttachmentState,
    });
    const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [showWaitingAssignmentPrompt, setShowWaitingAssignmentPrompt] = useState(false);
    const [showWaitingDuePrompt, setShowWaitingDuePrompt] = useState(false);
    const [waitingTransitionMode, setWaitingTransitionMode] = useState<'status-change' | 'status-and-due' | null>(null);
    const prioritiesEnabled = settings?.features?.priorities !== false;
    const timeEstimatesEnabled = settings?.features?.timeEstimates !== false;
    const undoNotificationsEnabled = settings?.undoNotificationsEnabled !== false;
    const isCompact = settings?.appearance?.density === 'compact';
    const isHighlighted = highlightTaskId === task.id;
    const recurrenceRule = getRecurrenceRuleValue(task.recurrence);
    const recurrenceStrategy = getRecurrenceStrategyValue(task.recurrence);
    const isStagnant = (task.pushCount ?? 0) > 3;
    const effectiveReadOnly = readOnly || task.status === 'done';
    const defaultFocusToggle = useMemo(() => {
        if (effectiveReadOnly) return undefined;
        if (task.status === 'done' || task.status === 'reference' || task.status === 'archived') return undefined;
        const isFocused = Boolean(task.isFocusedToday);
        const canToggle = isFocused || focusedCount < 3;
        const removeLabel = t('agenda.removeFromFocus');
        const addLabel = t('agenda.addToFocus');
        const maxLabel = t('agenda.maxFocusItems');
        return {
            isFocused,
            canToggle,
            onToggle: () => {
                if (isFocused) {
                    updateTask(task.id, { isFocusedToday: false });
                } else if (focusedCount < 3) {
                    const updates: Partial<Task> = {
                        isFocusedToday: true,
                        ...(task.status !== 'next' ? { status: 'next' } : {}),
                    };
                    updateTask(task.id, updates);
                }
            },
            title: isFocused ? removeLabel : (canToggle ? addLabel : maxLabel),
            ariaLabel: isFocused ? removeLabel : addLabel,
        };
    }, [effectiveReadOnly, focusedCount, task.id, task.isFocusedToday, task.status, t, updateTask]);
    const effectiveFocusToggle = focusToggle ?? defaultFocusToggle;
    const handleToggleChecklistItem = useCallback((index: number) => {
        if (effectiveReadOnly) return;
        const checklist = task.checklist || [];
        if (!checklist[index]) return;
        const nextChecklist = checklist.map((item, i) =>
            i === index ? { ...item, isCompleted: !item.isCompleted } : item
        );
        void updateTask(task.id, { checklist: nextChecklist });
    }, [effectiveReadOnly, task, updateTask]);
    const {
        monthlyRecurrence,
        showCustomRecurrence,
        setShowCustomRecurrence,
        customInterval,
        setCustomInterval,
        customMode,
        setCustomMode,
        customOrdinal,
        setCustomOrdinal,
        customWeekday,
        setCustomWeekday,
        customMonthDay,
        setCustomMonthDay,
        openCustomRecurrence,
        applyCustomRecurrence,
    } = useTaskItemRecurrence({
        task,
        editDueDate,
        editRecurrence,
        editRecurrenceRRule,
        setEditRecurrence,
        setEditRecurrenceRRule,
    });

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
    } = useTaskItemProjectContext({
        task,
        project: storeProject,
        projectArea,
        taskArea: storeTaskArea,
        sections,
        isEditing,
        editProjectId,
        setEditAreaId,
    });

    useEffect(() => {
        const projectId = editProjectId || task.projectId || '';
        if (!projectId) {
            if (editSectionId) setEditSectionId('');
            return;
        }
        const projectSections = sectionsByProject.get(projectId) ?? [];
        if (editSectionId && !projectSections.some((section) => section.id === editSectionId)) {
            setEditSectionId('');
        }
    }, [editProjectId, editSectionId, sectionsByProject, setEditSectionId, task.projectId]);

    const {
        aiEnabled,
        isAIWorking,
        aiClarifyResponse,
        aiError,
        aiBreakdownSteps,
        copilotSuggestion,
        copilotApplied,
        copilotContext,
        copilotEstimate,
        resetCopilotDraft,
        resetAiState,
        clearAiBreakdown,
        clearAiClarify,
        applyCopilotSuggestion,
        applyAISuggestion,
        handleAIClarify,
        handleAIBreakdown,
    } = useTaskItemAi({
        taskId: task.id,
        settings,
        t,
        editTitle,
        editDescription,
        editContexts,
        editTags,
        tagOptions,
        projectContext,
        timeEstimatesEnabled,
        setEditTitle,
        setEditContexts,
        setEditTags,
        setEditTimeEstimate,
    });

    const resetEditState = useCallback(() => {
        resetLocalEditState();
        setShowCustomRecurrence(false);
        resetAiState();
    }, [resetLocalEditState, resetAiState, setShowCustomRecurrence]);
    const startEditing = useCallback(() => {
        if (effectiveReadOnly || isEditing) return;
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
        const initialAreaId = editAreaId || undefined;
        const created = await addProject(
            trimmed,
            DEFAULT_PROJECT_COLOR,
            initialAreaId ? { areaId: initialAreaId } : undefined
        );
        return created?.id ?? null;
    }, [addProject, editAreaId, projects]);
    const handleCreateArea = useCallback(async (name: string) => {
        const trimmed = name.trim();
        if (!trimmed) return null;
        const existing = areas.find((area) => area.name.toLowerCase() === trimmed.toLowerCase());
        if (existing) return existing.id;
        const created = await addArea(trimmed, { color: DEFAULT_PROJECT_COLOR });
        return created?.id ?? null;
    }, [addArea, areas]);
    const handleCreateSection = useCallback(async (title: string) => {
        const trimmed = title.trim();
        if (!trimmed) return null;
        const projectId = editProjectId || task.projectId;
        if (!projectId) return null;
        const existing = (sectionsByProject.get(projectId) ?? [])
            .find((section) => section.title.toLowerCase() === trimmed.toLowerCase());
        if (existing) return existing.id;
        const created = await addSection(projectId, trimmed);
        return created?.id ?? null;
    }, [addSection, editProjectId, sectionsByProject, task.projectId]);
    const visibleAttachments = (task.attachments || []).filter((a) => !a.deletedAt);
    const visibleEditAttachments = editAttachments.filter((a) => !a.deletedAt);
    const wasEditingRef = useRef(false);

    const {
        showProjectField,
        showAreaField,
        showSectionField,
        basicFields,
        schedulingFields,
        organizationFields,
        detailsFields,
        sectionCounts,
        sectionOpenDefaults,
    } = useTaskItemFieldLayout({
        settings,
        task,
        editStatus,
        editProjectId,
        editSectionId,
        editAreaId,
        editPriority,
        editEnergyLevel,
        editAssignedTo,
        editContexts,
        editDescription,
        editDueDate,
        editRecurrence,
        editReviewAt,
        editStartTime,
        editTags,
        editTimeEstimate,
        prioritiesEnabled,
        timeEstimatesEnabled,
        visibleEditAttachmentsLength: visibleEditAttachments.length,
    });
    const activeProjectId = editProjectId || task.projectId || '';
    const projectSections = activeProjectId ? (sectionsByProject.get(activeProjectId) ?? []) : [];
    const toggleDescriptionPreview = useCallback(() => {
        setShowDescriptionPreview((prev) => !prev);
    }, []);
    const handleSetEditDescription = useCallback((value: string) => {
        setEditDescription(value);
        resetCopilotDraft();
    }, [resetCopilotDraft, setEditDescription]);
    const fieldRendererData = useMemo(() => ({
        t,
        task,
        taskId: task.id,
        showDescriptionPreview,
        editDescription,
        attachmentError,
        visibleEditAttachments,
        editStartTime,
        editDueDate,
        editReviewAt,
        editStatus,
        editPriority,
        editEnergyLevel,
        editAssignedTo,
        editRecurrence,
        editRecurrenceStrategy,
        editRecurrenceRRule,
        monthlyRecurrence,
        editTimeEstimate,
        editContexts,
        editTags,
        language,
        nativeDateInputLocale,
        defaultScheduleTime: normalizeClockTimeInput(settings?.gtd?.defaultScheduleTime) || '',
        popularContextOptions,
        popularTagOptions,
    }), [
        t,
        task,
        showDescriptionPreview,
        editDescription,
        attachmentError,
        visibleEditAttachments,
        editStartTime,
        editDueDate,
        editReviewAt,
        editStatus,
        editPriority,
        editEnergyLevel,
        editAssignedTo,
        editRecurrence,
        editRecurrenceStrategy,
        editRecurrenceRRule,
        monthlyRecurrence,
        editTimeEstimate,
        editContexts,
        editTags,
        language,
        nativeDateInputLocale,
        settings?.gtd?.defaultScheduleTime,
        popularContextOptions,
        popularTagOptions,
    ]);
    const fieldRendererHandlers = useMemo(() => ({
        toggleDescriptionPreview,
        setEditDescription: handleSetEditDescription,
        addFileAttachment,
        addLinkAttachment,
        openAttachment,
        removeAttachment,
        setEditStartTime,
        setEditDueDate,
        setEditReviewAt,
        setEditStatus,
        setEditPriority,
        setEditEnergyLevel,
        setEditAssignedTo,
        setEditRecurrence,
        setEditRecurrenceStrategy,
        setEditRecurrenceRRule,
        openCustomRecurrence,
        setEditTimeEstimate,
        setEditContexts,
        setEditTags,
        updateTask,
        resetTaskChecklist,
    }), [
        toggleDescriptionPreview,
        handleSetEditDescription,
        addFileAttachment,
        addLinkAttachment,
        openAttachment,
        removeAttachment,
        setEditStartTime,
        setEditDueDate,
        setEditReviewAt,
        setEditStatus,
        setEditPriority,
        setEditEnergyLevel,
        setEditAssignedTo,
        setEditRecurrence,
        setEditRecurrenceStrategy,
        setEditRecurrenceRRule,
        openCustomRecurrence,
        setEditTimeEstimate,
        setEditContexts,
        setEditTags,
        updateTask,
        resetTaskChecklist,
    ]);

    const renderField = (fieldId: TaskEditorFieldId) => (
        <TaskItemFieldRenderer
            fieldId={fieldId}
            data={fieldRendererData}
            handlers={fieldRendererHandlers}
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
            setTaskExpanded(task.id, false);
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
        return () => {
            unlockEditing();
        };
    }, [isEditing, lockEditing, unlockEditing]);


    const handleDiscardChanges = useCallback(() => {
        resetEditState();
        setIsEditing(false);
        if (editingTaskId === task.id) {
            setEditingTaskId(null);
        }
    }, [editingTaskId, resetEditState, setEditingTaskId, task.id]);

    const handleSubmit = useTaskItemSubmit({
        addProject,
        areas,
        editAreaId,
        editAssignedTo,
        editAttachments,
        editContexts,
        editDescription,
        editDueDate,
        editEnergyLevel,
        editLocation,
        editPriority,
        editProjectId,
        editRecurrence,
        editRecurrenceRRule,
        editRecurrenceStrategy,
        editReviewAt,
        editSectionId,
        editStartTime,
        editStatus,
        editTags,
        editTimeEstimate,
        editTitle,
        editingTaskId,
        projects,
        setEditingTaskId,
        setIsEditing,
        showToast,
        t,
        task,
        updateTask,
    });

    const project = currentProject;
    const taskArea = currentTaskArea;
    const projectColor = currentProjectColor;
    const handleOpenProject = useCallback((projectId: string) => {
        setHighlightTask(task.id);
        setSelectedProjectId(projectId);
        dispatchNavigateEvent('projects');
    }, [setHighlightTask, setSelectedProjectId, task.id]);
    const undoLabel = useMemo(() => tFallback(t, 'common.undo', 'Undo'), [t]);
    const closeWaitingAssignmentPrompt = useCallback(() => {
        setShowWaitingAssignmentPrompt(false);
        setWaitingTransitionMode(null);
    }, []);
    const applyWaitingAssignment = useCallback((value: string) => {
        const assignedTo = value.trim() || undefined;
        const openDuePrompt = waitingTransitionMode === 'status-and-due';
        setShowWaitingAssignmentPrompt(false);
        setWaitingTransitionMode(null);
        void moveTask(task.id, 'waiting')
            .then(async (result) => {
                if (!result.success) {
                    throw new Error(result.error || 'Failed to change task status');
                }
                const updateResult = await updateTask(task.id, { assignedTo });
                if (!updateResult.success) {
                    throw new Error(updateResult.error || 'Failed to update waiting assignee');
                }
                if (openDuePrompt) {
                    setShowWaitingDuePrompt(true);
                }
            })
            .catch((error) => reportError('Failed to move task to waiting', error));
    }, [moveTask, task.id, updateTask, waitingTransitionMode]);
    const handleMoveToWaitingWithPrompt = useCallback(() => {
        setWaitingTransitionMode('status-and-due');
        setShowWaitingAssignmentPrompt(true);
    }, []);
    const handleStatusChange = useCallback((nextStatus: TaskStatus) => {
        if (nextStatus === 'waiting' && task.status !== 'waiting') {
            setWaitingTransitionMode('status-change');
            setShowWaitingAssignmentPrompt(true);
            return;
        }
        const previousStatus = task.status;
        void moveTask(task.id, nextStatus)
            .then((result) => {
                if (!result.success) {
                    throw new Error(result.error || 'Failed to change task status');
                }
                if (!undoNotificationsEnabled || nextStatus !== 'done' || previousStatus === 'done') return;
                showToast(
                    `${task.title} marked Done`,
                    'info',
                    5000,
                    {
                        label: undoLabel,
                        onClick: () => {
                            void moveTask(task.id, previousStatus);
                        },
                    }
                );
            })
            .catch((error) => reportError('Failed to change task status', error));
    }, [moveTask, showToast, task.id, task.status, task.title, undoLabel, undoNotificationsEnabled]);
    const hasPendingEdits = useCallback(() => {
        if (editTitle !== task.title) return true;
        if (editDescription !== (task.description || '')) return true;
        if (editProjectId !== (task.projectId || '')) return true;
        if (editSectionId !== (task.sectionId || '')) return true;
        if (editAreaId !== (task.areaId || '')) return true;
        if (editStatus !== task.status) return true;
        if (editContexts.trim() !== (task.contexts?.join(', ') || '').trim()) return true;
        if (editTags.trim() !== (task.tags?.join(', ') || '').trim()) return true;
        if (editLocation !== (task.location || '')) return true;
        if (editRecurrence !== getRecurrenceRuleValue(task.recurrence)) return true;
        if (editRecurrenceStrategy !== getRecurrenceStrategyValue(task.recurrence)) return true;
        if (editRecurrenceRRule !== getRecurrenceRRuleValue(task.recurrence)) return true;
        if (editTimeEstimate !== (task.timeEstimate || '')) return true;
        if (editPriority !== (task.priority || '')) return true;
        if (editEnergyLevel !== (task.energyLevel || '')) return true;
        if (editAssignedTo !== (task.assignedTo || '')) return true;
        if (editDueDate !== toDateTimeLocalValue(task.dueDate)) return true;
        if (editStartTime !== toDateTimeLocalValue(task.startTime)) return true;
        if (editReviewAt !== toDateTimeLocalValue(task.reviewAt)) return true;
        return false;
    }, [
        editTitle,
        editDescription,
        editProjectId,
        editSectionId,
        editAreaId,
        editStatus,
        editContexts,
        editTags,
        editLocation,
        editRecurrence,
        editRecurrenceStrategy,
        editRecurrenceRRule,
        editTimeEstimate,
        editPriority,
        editEnergyLevel,
        editAssignedTo,
        editDueDate,
        editStartTime,
        editReviewAt,
        task,
    ]);
    const isModalEditor = editorPresentation === 'modal';
    const getModalFocusableElements = useCallback((): HTMLElement[] => {
        const root = modalEditorRef.current;
        if (!root) return [];
        return Array.from(
            root.querySelectorAll<HTMLElement>(
                'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
            ),
        ).filter((el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true');
    }, []);
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
            const focusable = getModalFocusableElements();
            if (focusable.length > 0) {
                focusable[0].focus();
                return;
            }
            modalEditorRef.current?.focus();
        }, 0);
        return () => clearTimeout(timer);
    }, [getModalFocusableElements, isEditing, isModalEditor]);
    const handleEditorCancel = useCallback(() => {
        if (hasPendingEdits()) {
            setShowDiscardConfirm(true);
            return;
        }
        handleDiscardChanges();
    }, [handleDiscardChanges, hasPendingEdits]);
    const handleOpenQuickActionMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        if (selectionMode || isEditing) return;
        event.preventDefault();
        event.stopPropagation();
        onSelect?.();
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
        const rect = event.currentTarget.getBoundingClientRect();
        setQuickActionMenu({
            x: rect.left,
            y: rect.bottom + 4,
        });
    }, [isEditing, onSelect, selectionMode]);
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
            editTitle={editTitle}
            setEditTitle={setEditTitle}
            autoFocusTitle={autoFocusTitle}
            resetCopilotDraft={resetCopilotDraft}
            aiEnabled={aiEnabled}
            isAIWorking={isAIWorking}
            handleAIClarify={handleAIClarify}
            handleAIBreakdown={handleAIBreakdown}
            copilotSuggestion={copilotSuggestion}
            copilotApplied={copilotApplied}
            applyCopilotSuggestion={applyCopilotSuggestion}
            copilotContext={copilotContext}
            copilotEstimate={copilotEstimate}
            copilotTags={copilotSuggestion?.tags ?? []}
            timeEstimatesEnabled={timeEstimatesEnabled}
            aiError={aiError}
            aiBreakdownSteps={aiBreakdownSteps}
            onAddBreakdownSteps={() => {
                if (!aiBreakdownSteps?.length) return;
                const newItems = aiBreakdownSteps.map((step) => ({
                    id: generateUUID(),
                    title: step,
                    isCompleted: false,
                }));
                updateTask(task.id, { checklist: [...(task.checklist || []), ...newItems] });
                clearAiBreakdown();
            }}
            onDismissBreakdown={clearAiBreakdown}
            aiClarifyResponse={aiClarifyResponse}
            onSelectClarifyOption={(action) => {
                setEditTitle(action);
                clearAiClarify();
            }}
            onApplyAISuggestion={() => {
                if (aiClarifyResponse?.suggestedAction) {
                    applyAISuggestion(aiClarifyResponse.suggestedAction);
                }
            }}
            onDismissClarify={clearAiClarify}
            projects={projects}
            areas={areas}
            editProjectId={editProjectId}
            setEditProjectId={setEditProjectId}
            sections={projectSections}
            editSectionId={editSectionId}
            setEditSectionId={setEditSectionId}
            editAreaId={editAreaId}
            setEditAreaId={setEditAreaId}
            onCreateProject={handleCreateProject}
            onCreateArea={handleCreateArea}
            onCreateSection={handleCreateSection}
            showProjectField={showProjectField}
            showAreaField={showAreaField}
            showSectionField={showSectionField}
            basicFields={basicFields}
            schedulingFields={schedulingFields}
            organizationFields={organizationFields}
            detailsFields={detailsFields}
            sectionCounts={sectionCounts}
            sectionOpenDefaults={sectionOpenDefaults}
            renderField={renderField}
            editLocation={editLocation}
            setEditLocation={setEditLocation}
            language={language}
            inputContexts={allContexts}
            onDuplicateTask={() => duplicateTask(task.id, false)}
            onCancel={handleEditorCancel}
            onSubmit={handleSubmit}
        />
    );

    const selectAriaLabel = tFallback(t, 'task.select', 'Select task');
    const displayActions = useMemo(() => ({
        onToggleSelect,
        onToggleView: () => toggleTaskExpanded(task.id),
        onEdit: startEditing,
        onDelete: () => setShowDeleteConfirm(true),
        onDuplicate: () => duplicateTask(task.id, false),
        onStatusChange: handleStatusChange,
        onOpenQuickActions: handleOpenQuickActionButton,
        onMoveToWaitingWithPrompt: handleMoveToWaitingWithPrompt,
        onOpenProject: project ? handleOpenProject : undefined,
        openAttachment,
        onToggleChecklistItem: handleToggleChecklistItem,
        focusToggle: effectiveFocusToggle,
    }), [
        duplicateTask,
        effectiveFocusToggle,
        handleMoveToWaitingWithPrompt,
        handleOpenProject,
        handleOpenQuickActionButton,
        handleStatusChange,
        handleToggleChecklistItem,
        onToggleSelect,
        openAttachment,
        project,
        startEditing,
        task.id,
        toggleTaskExpanded,
    ]);

    return (
        <>
            <div
                data-task-id={task.id}
                onClickCapture={onSelect ? () => onSelect?.() : undefined}
                onDoubleClick={(event) => {
                    if (!enableDoubleClickEdit || selectionMode || effectiveReadOnly || isEditing) return;
                    event.stopPropagation();
                    startEditing();
                }}
                onContextMenu={handleOpenQuickActionMenu}
                className={cn(
                    "group rounded-lg hover:bg-muted/50 dark:hover:bg-muted/20 transition-colors animate-in fade-in slide-in-from-bottom-2",
                    isCompact ? "p-2.5" : "px-3 py-3",
                    isSelected && "ring-2 ring-inset ring-primary/40 bg-primary/5",
                    isHighlighted && "ring-2 ring-inset ring-primary/70 bg-primary/5"
                )}
            >
                <div className={cn("flex items-start", isCompact ? "gap-2" : "gap-3")}>
                    {selectionMode && (
                        <input
                            type="checkbox"
                            aria-label={selectAriaLabel}
                            checked={isMultiSelected}
                            onChange={() => onToggleSelect?.()}
                            className={cn(
                                "h-4 w-4 rounded border-border text-primary focus:ring-primary cursor-pointer",
                                isCompact ? "mt-1" : "mt-1.5"
                            )}
                        />
                    )}

                    <TaskItemEditorSurface
                        editorAriaLabel={t('taskEdit.editTask') || 'Edit task'}
                        getModalFocusableElements={getModalFocusableElements}
                        isEditing={isEditing}
                        isModalEditor={isModalEditor}
                        modalEditorRef={modalEditorRef}
                        onCancel={handleEditorCancel}
                        renderDisplay={() => (
                            <TaskItemDisplay
                                task={task}
                                language={language}
                                project={project}
                                area={taskArea}
                                projectColor={projectColor}
                                selectionMode={selectionMode}
                                isViewOpen={isTaskExpanded}
                                actions={displayActions}
                                visibleAttachments={visibleAttachments}
                                recurrenceRule={recurrenceRule}
                                recurrenceStrategy={recurrenceStrategy}
                                prioritiesEnabled={prioritiesEnabled}
                                timeEstimatesEnabled={timeEstimatesEnabled}
                                isStagnant={isStagnant}
                                showQuickDone={showQuickDone}
                                showStatusSelect={showStatusSelect}
                                showProjectBadgeInActions={showProjectBadgeInActions}
                                readOnly={effectiveReadOnly}
                                compactMetaEnabled={compactMetaEnabled}
                                dense={isCompact}
                                actionsOverlay={actionsOverlay}
                                dragHandle={dragHandle}
                                showHoverHint={showHoverHint}
                                t={t}
                            />
                        )}
                        renderEditor={renderEditor}
                    />
                </div>
            </div>
            {quickActionMenu && (
                <TaskQuickActionMenu
                    task={task}
                    x={quickActionMenu.x}
                    y={quickActionMenu.y}
                    t={t}
                    nativeDateInputLocale={nativeDateInputLocale}
                    contextOptions={popularContextOptions}
                    readOnly={effectiveReadOnly}
                    onClose={() => setQuickActionMenu(null)}
                    onDuplicate={() => {
                        duplicateTask(task.id, false);
                    }}
                    onDelete={() => {
                        setShowDeleteConfirm(true);
                    }}
                    onUpdateTask={(updates) => updateTask(task.id, updates)}
                />
            )}
            <TaskItemOverlays
                applyCustomRecurrence={applyCustomRecurrence}
                audioAttachment={audioAttachment}
                audioError={audioError}
                audioRef={audioRef}
                audioSource={audioSource}
                audioTranscribing={audioTranscribing}
                audioTranscriptionError={audioTranscriptionError}
                clearLinkPrompt={() => setShowLinkPrompt(false)}
                closeAudio={closeAudio}
                closeImage={closeImage}
                closeText={closeText}
                customInterval={customInterval}
                customMode={customMode}
                customMonthDay={customMonthDay}
                customOrdinal={customOrdinal}
                customWeekday={customWeekday}
                deleteTask={deleteTask}
                handleAddLinkAttachment={handleAddLinkAttachment}
                handleAudioError={handleAudioError}
                handleDiscardChanges={handleDiscardChanges}
                handleOpenDeleteConfirm={setShowDeleteConfirm}
                handleOpenDiscardConfirm={setShowDiscardConfirm}
                imageAttachment={imageAttachment}
                imageSource={imageSource}
                onOpenImageExternally={openImageExternally}
                onOpenTextExternally={openTextExternally}
                openAudioExternally={openAudioExternally}
                openDeleteConfirm={showDeleteConfirm}
                openDiscardConfirm={showDiscardConfirm}
                openLinkPrompt={showLinkPrompt}
                openWaitingAssignmentPrompt={showWaitingAssignmentPrompt}
                openWaitingDuePrompt={showWaitingDuePrompt}
                onCancelWaitingAssignmentPrompt={closeWaitingAssignmentPrompt}
                onConfirmWaitingAssignmentPrompt={applyWaitingAssignment}
                waitingAssignmentDefaultValue={task.assignedTo || ''}
                openWaitingDuePromptSetter={setShowWaitingDuePrompt}
                restoreTask={restoreTask}
                retryAudioTranscription={retryAudioTranscription}
                setCustomInterval={setCustomInterval}
                setCustomMode={setCustomMode}
                setCustomMonthDay={setCustomMonthDay}
                setCustomOrdinal={setCustomOrdinal}
                setCustomWeekday={setCustomWeekday}
                setShowCustomRecurrence={setShowCustomRecurrence}
                showCustomRecurrence={showCustomRecurrence}
                showToast={showToast}
                t={t}
                taskId={task.id}
                textAttachment={textAttachment}
                textContent={textContent}
                textError={textError}
                textLoading={textLoading}
                undoLabel={undoLabel}
                undoNotificationsEnabled={undoNotificationsEnabled}
                updateTask={updateTask}
                weekdayLabels={recurrenceWeekdayLabels}
            />
        </>
    );
});
