import { useState, memo, useEffect, useRef, useCallback, useMemo, type ReactNode } from 'react';
import {
    DEFAULT_PROJECT_COLOR,
    Task,
    TaskStatus,
    TaskEditorFieldId,
    getLocalizedWeekdayLabels,
    type Recurrence,
    parseRRuleString,
    Project,
    generateUUID,
    parseQuickAdd,
    extractChecklistFromMarkdown,
} from '@mindwtr/core';
import { cn } from '../lib/utils';
import { PromptModal } from './PromptModal';
import { ConfirmModal } from './ConfirmModal';
import { useLanguage } from '../contexts/language-context';
import { TaskItemEditor } from './Task/TaskItemEditor';
import { TaskItemDisplay } from './Task/TaskItemDisplay';
import { TaskItemFieldRenderer } from './Task/TaskItemFieldRenderer';
import { TaskItemRecurrenceModal } from './Task/TaskItemRecurrenceModal';
import { AttachmentModals } from './Task/AttachmentModals';
import { WEEKDAY_ORDER } from './Task/recurrence-constants';
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
import { reportError } from '../lib/report-error';
import { mergeMarkdownChecklist } from './Task/task-item-checklist';
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
    const {
        updateTask,
        deleteTask,
        moveTask,
        projects,
        sections,
        areas,
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
    } = useTaskItemStoreState();
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
    const recurrenceWeekdayLabels = useMemo(
        () => getLocalizedWeekdayLabels(language, 'long'),
        [language]
    );
    const [isEditing, setIsEditing] = useState(false);
    const [autoFocusTitle, setAutoFocusTitle] = useState(false);
    const modalEditorRef = useRef<HTMLDivElement | null>(null);
    const lastFocusedBeforeModalRef = useRef<HTMLElement | null>(null);
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
    const [showWaitingDuePrompt, setShowWaitingDuePrompt] = useState(false);
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
        projectById,
        sectionsByProject,
        areaById,
        projectContext,
        tagOptions,
        popularContextOptions,
        popularTagOptions,
        allContexts,
    } = useTaskItemProjectContext({
        task,
        propProject,
        projects,
        sections,
        areas,
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

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        const { title: parsedTitle, props: parsedProps, projectTitle, invalidDateCommands } = parseQuickAdd(editTitle, projects, new Date(), areas);
        if (invalidDateCommands && invalidDateCommands.length > 0) {
            showToast(`${t('quickAdd.invalidDateCommand')}: ${invalidDateCommands.join(', ')}`, 'error');
            return;
        }
        const cleanedTitle = parsedTitle.trim() ? parsedTitle : task.title;
        if (!cleanedTitle.trim()) return;

        const hasProjectCommand = Boolean(parsedProps.projectId || projectTitle);
        let resolvedProjectId = parsedProps.projectId || undefined;
        if (!resolvedProjectId && projectTitle) {
            try {
                const initialAreaId = editAreaId || undefined;
                const created = await addProject(
                    projectTitle,
                    DEFAULT_PROJECT_COLOR,
                    initialAreaId ? { areaId: initialAreaId } : undefined
                );
                resolvedProjectId = created?.id;
                if (!resolvedProjectId) {
                    const projectCreateFailed = t('projects.createFailed');
                    showToast(
                        projectCreateFailed === 'projects.createFailed'
                            ? 'Failed to create project from quick add.'
                            : projectCreateFailed,
                        'error'
                    );
                }
            } catch (error) {
                reportError('Failed to create project from quick add', error);
                const projectCreateFailed = t('projects.createFailed');
                showToast(
                    projectCreateFailed === 'projects.createFailed'
                        ? 'Failed to create project from quick add.'
                        : projectCreateFailed,
                    'error'
                );
            }
        }
        if (!resolvedProjectId) {
            resolvedProjectId = editProjectId || undefined;
        }
        const recurrenceValue: Recurrence | undefined = editRecurrence
            ? { rule: editRecurrence, strategy: editRecurrenceStrategy }
            : undefined;
        if (recurrenceValue && editRecurrenceRRule) {
            const parsed = parseRRuleString(editRecurrenceRRule);
            if (parsed.byDay && parsed.byDay.length > 0) {
                recurrenceValue.byDay = parsed.byDay;
            }
            recurrenceValue.rrule = editRecurrenceRRule;
        }
        const currentContexts = editContexts.split(',').map(c => c.trim()).filter(Boolean);
        const mergedContexts = Array.from(new Set([...currentContexts, ...(parsedProps.contexts || [])]));
        const currentTags = editTags.split(',').map(c => c.trim()).filter(Boolean);
        const mergedTags = Array.from(new Set([...currentTags, ...(parsedProps.tags || [])]));
        const resolvedDescription = parsedProps.description
            ? (editDescription ? `${editDescription}\n${parsedProps.description}` : parsedProps.description)
            : (editDescription || undefined);
        const markdownChecklist = extractChecklistFromMarkdown(String(resolvedDescription ?? ''));
        const resolvedChecklist = markdownChecklist.length > 0
            ? mergeMarkdownChecklist(markdownChecklist, task.checklist)
            : undefined;
        const projectChangedByCommand = hasProjectCommand && resolvedProjectId !== (editProjectId || undefined);
        const resolvedSectionId = projectChangedByCommand
            ? undefined
            : (resolvedProjectId ? (editSectionId || undefined) : undefined);
        const resolvedAreaId = projectChangedByCommand
            ? undefined
            : (resolvedProjectId ? undefined : (editAreaId || undefined));
        await updateTask(task.id, {
            title: cleanedTitle,
            status: parsedProps.status || editStatus,
            dueDate: parsedProps.dueDate || editDueDate || undefined,
            startTime: parsedProps.startTime || editStartTime || undefined,
            projectId: resolvedProjectId,
            sectionId: resolvedSectionId,
            areaId: resolvedAreaId,
            contexts: mergedContexts,
            tags: mergedTags,
            description: resolvedDescription,
            ...(resolvedChecklist ? { checklist: resolvedChecklist } : {}),
            location: editLocation || undefined,
            recurrence: recurrenceValue,
            timeEstimate: editTimeEstimate || undefined,
            priority: editPriority || undefined,
            energyLevel: editEnergyLevel || undefined,
            assignedTo: editAssignedTo.trim() || undefined,
            reviewAt: parsedProps.reviewAt || editReviewAt || undefined,
            attachments: editAttachments.length > 0 ? editAttachments : undefined,
        });
        setIsEditing(false);
        if (editingTaskId === task.id) {
            setEditingTaskId(null);
        }
    };

    const project = propProject || (task.projectId ? projectById.get(task.projectId) : undefined);
    const taskArea = task.projectId
        ? (project?.areaId ? areaById.get(project.areaId) : undefined)
        : (task.areaId ? areaById.get(task.areaId) : undefined);
    const projectColor = project?.areaId ? areaById.get(project.areaId)?.color : undefined;
    const handleOpenProject = useCallback((projectId: string) => {
        setHighlightTask(task.id);
        setSelectedProjectId(projectId);
        window.dispatchEvent(new CustomEvent('mindwtr:navigate', { detail: { view: 'projects' } }));
    }, [setHighlightTask, setSelectedProjectId, task.id]);
    const waitingDuePromptTitle = useMemo(() => {
        const translated = t('task.waitingDuePromptTitle');
        if (translated === 'task.waitingDuePromptTitle') return 'Set follow-up / review date';
        return translated;
    }, [t]);
    const waitingDuePromptDescription = useMemo(() => {
        const translated = t('task.waitingDuePromptDescription');
        if (translated === 'task.waitingDuePromptDescription') return 'This sets the task review date. When should this waiting task resurface?';
        return translated;
    }, [t]);
    const skipLabel = useMemo(() => {
        const translated = t('common.skip');
        if (translated === 'common.skip') return 'Skip';
        return translated;
    }, [t]);
    const undoLabel = useMemo(() => {
        const translated = t('common.undo');
        if (translated === 'common.undo') return 'Undo';
        return translated;
    }, [t]);
    const handleMoveToWaitingWithPrompt = useCallback(() => {
        setShowWaitingDuePrompt(true);
    }, []);
    const handleStatusChange = useCallback((nextStatus: TaskStatus) => {
        const previousStatus = task.status;
        void moveTask(task.id, nextStatus)
            .then(() => {
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

    const selectAriaLabel = (() => {
        const label = t('task.select');
        return label === 'task.select' ? 'Select task' : label;
    })();
    const resolveText = useCallback((key: string, fallback: string) => {
        const value = t(key);
        return value === key ? fallback : value;
    }, [t]);

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

                    {isEditing && !isModalEditor ? (
                        <div className="flex-1 min-w-0">
                            {renderEditor()}
                        </div>
                    ) : (
                        <TaskItemDisplay
                            task={task}
                            language={language}
                            project={project}
                            area={taskArea}
                            projectColor={projectColor}
                            selectionMode={selectionMode}
                            isViewOpen={isTaskExpanded}
                            actions={{
                                onToggleSelect,
                                onToggleView: () => toggleTaskExpanded(task.id),
                                onEdit: startEditing,
                                onDelete: () => setShowDeleteConfirm(true),
                                onDuplicate: () => duplicateTask(task.id, false),
                                onStatusChange: handleStatusChange,
                                onMoveToWaitingWithPrompt: handleMoveToWaitingWithPrompt,
                                onOpenProject: project ? handleOpenProject : undefined,
                                openAttachment,
                                onToggleChecklistItem: handleToggleChecklistItem,
                                focusToggle: effectiveFocusToggle,
                            }}
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
                </div>
            </div>
            {isEditing && isModalEditor && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
                    role="dialog"
                    aria-modal="true"
                    aria-label={t('taskEdit.editTask') || 'Edit task'}
                    onMouseDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        handleEditorCancel();
                    }}
                >
                    <div
                        ref={modalEditorRef}
                        tabIndex={-1}
                        className="w-[min(1100px,92vw)] max-h-[90vh] rounded-xl border border-border bg-card p-4 shadow-2xl"
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                                event.preventDefault();
                                handleEditorCancel();
                                return;
                            }
                            if (event.key !== 'Tab') return;
                            const focusable = getModalFocusableElements();
                            if (focusable.length === 0) return;
                            const first = focusable[0];
                            const last = focusable[focusable.length - 1];
                            const active = document.activeElement as HTMLElement | null;
                            if (!active || !focusable.includes(active)) {
                                event.preventDefault();
                                first.focus();
                                return;
                            }
                            if (event.shiftKey && active === first) {
                                event.preventDefault();
                                last.focus();
                                return;
                            }
                            if (!event.shiftKey && active === last) {
                                event.preventDefault();
                                first.focus();
                            }
                        }}
                    >
                        {renderEditor()}
                    </div>
                </div>
            )}
            {showCustomRecurrence && (
                <TaskItemRecurrenceModal
                    t={t}
                    weekdayOrder={WEEKDAY_ORDER}
                    weekdayLabels={recurrenceWeekdayLabels}
                    customInterval={customInterval}
                    customMode={customMode}
                    customOrdinal={customOrdinal}
                    customWeekday={customWeekday}
                    customMonthDay={customMonthDay}
                    onIntervalChange={(value) => setCustomInterval(value)}
                    onModeChange={(value) => setCustomMode(value)}
                    onOrdinalChange={(value) => setCustomOrdinal(value)}
                    onWeekdayChange={(value) => setCustomWeekday(value)}
                    onMonthDayChange={(value) => {
                        const safe = Number.isFinite(value) ? Math.min(Math.max(value, 1), 31) : 1;
                        setCustomMonthDay(safe);
                    }}
                    onClose={() => setShowCustomRecurrence(false)}
                    onApply={applyCustomRecurrence}
                />
            )}
            {showLinkPrompt && (
                <PromptModal
                    isOpen={showLinkPrompt}
                    title={t('attachments.addLink')}
                    description={t('attachments.linkInputHint')}
                    placeholder={t('attachments.linkPlaceholder')}
                    defaultValue=""
                    confirmLabel={t('common.save')}
                    cancelLabel={t('common.cancel')}
                    onCancel={() => setShowLinkPrompt(false)}
                    onConfirm={(value) => {
                        const added = handleAddLinkAttachment(value);
                        if (!added) return;
                        setShowLinkPrompt(false);
                    }}
                />
            )}
            {showWaitingDuePrompt && (
                <PromptModal
                    isOpen={showWaitingDuePrompt}
                    title={waitingDuePromptTitle}
                    description={waitingDuePromptDescription}
                    inputType="date"
                    defaultValue=""
                    secondaryLabel={skipLabel}
                    onSecondary={() => {
                        setShowWaitingDuePrompt(false);
                        void moveTask(task.id, 'waiting');
                    }}
                    confirmLabel={t('common.save')}
                    cancelLabel={t('common.cancel')}
                    onCancel={() => {
                        setShowWaitingDuePrompt(false);
                    }}
                    onConfirm={(value) => {
                        const input = value.trim();
                        if (!input) {
                            return;
                        }
                        setShowWaitingDuePrompt(false);
                        void moveTask(task.id, 'waiting');
                        void updateTask(task.id, { reviewAt: input });
                    }}
                />
            )}
            {showDeleteConfirm && (
                <ConfirmModal
                    isOpen={showDeleteConfirm}
                    title={resolveText('common.delete', 'Delete task')}
                    description={resolveText('task.deleteConfirmBody', 'Move this task to Trash?')}
                    confirmLabel={resolveText('common.delete', 'Delete')}
                    cancelLabel={t('common.cancel')}
                    onCancel={() => setShowDeleteConfirm(false)}
                    onConfirm={() => {
                        setShowDeleteConfirm(false);
                        void deleteTask(task.id);
                        const deletedMessage = resolveText('task.aria.delete', 'Task deleted');
                        if (!undoNotificationsEnabled) return;
                        showToast(
                            deletedMessage,
                            'info',
                            5000,
                            {
                                label: undoLabel,
                                onClick: () => {
                                    void restoreTask(task.id);
                                },
                            }
                        );
                    }}
                />
            )}
            {showDiscardConfirm && (
                <ConfirmModal
                    isOpen={showDiscardConfirm}
                    title={resolveText('taskEdit.discardChanges', 'Discard unsaved changes?')}
                    description={resolveText('taskEdit.discardChangesDesc', 'Your changes will be lost if you leave now.')}
                    confirmLabel={resolveText('common.discard', 'Discard')}
                    cancelLabel={t('common.cancel')}
                    onCancel={() => setShowDiscardConfirm(false)}
                    onConfirm={() => {
                        setShowDiscardConfirm(false);
                        handleDiscardChanges();
                    }}
                />
            )}
            <AttachmentModals
                audioAttachment={audioAttachment}
                audioSource={audioSource}
                audioRef={audioRef}
                audioError={audioError}
                audioTranscribing={audioTranscribing}
                audioTranscriptionError={audioTranscriptionError}
                onCloseAudio={closeAudio}
                onAudioError={handleAudioError}
                onOpenAudioExternally={openAudioExternally}
                onRetryAudioTranscription={retryAudioTranscription}
                imageAttachment={imageAttachment}
                imageSource={imageSource}
                onCloseImage={closeImage}
                onOpenImageExternally={openImageExternally}
                textAttachment={textAttachment}
                textContent={textContent}
                textLoading={textLoading}
                textError={textError}
                onCloseText={closeText}
                onOpenTextExternally={openTextExternally}
                t={t}
            />
        </>
    );
});
