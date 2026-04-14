import React, { useCallback } from 'react';
import { Alert, Share } from 'react-native';
import {
    Area,
    Project,
    type RecurrenceRule,
    Task,
    TaskStatus,
    TimeEstimate,
    createAIProvider,
    generateUUID,
    type AIProviderId,
    type RecurrenceByDay,
    type RecurrenceStrategy,
    type RecurrenceWeekday,
    buildRRuleString,
    parseRRuleString,
    parseQuickAdd,
    DEFAULT_PROJECT_COLOR,
    getUsedTaskTokens,
} from '@mindwtr/core';

import type { AIResponseAction } from '../ai-response-modal';
import { buildAIConfig, isAIKeyRequired, loadAIKey } from '../../lib/ai-config';
import { areTaskFieldValuesEqual } from './task-edit-modal.helpers';
import { logTaskError, logTaskWarn } from './task-edit-modal.utils';
import { applyMarkdownChecklistToTask, parseTokenList } from './task-edit-token-utils';
import { buildRecurrenceValue } from './recurrence-utils';

type AIResponseModalState = {
    title: string;
    message?: string;
    actions: AIResponseAction[];
} | null;

type ShowToast = (options: {
    title: string;
    message: string;
    tone: 'warning' | 'error' | 'success' | 'info';
    durationMs?: number;
}) => void;

type TaskEditActionsParams = {
    addProject: (title: string, color: string, options?: { areaId?: string }) => Promise<{ id?: string } | null>;
    aiEnabled: boolean;
    areas: Area[];
    baseTaskRef: React.MutableRefObject<Task | null>;
    closeAIModal: () => void;
    contextInputDraft: string;
    customWeekdays: RecurrenceWeekday[];
    deleteTask: (taskId: string) => Promise<unknown>;
    descriptionDebounceRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
    descriptionDraft: string;
    descriptionDraftRef: React.MutableRefObject<string>;
    duplicateTask: (taskId: string, includeDoneSubtasks?: boolean) => Promise<unknown>;
    editedTask: Partial<Task>;
    formatDate: (dateStr?: string) => string;
    formatDueDate: (dateStr?: string) => string;
    formatTimeEstimateLabel: (estimate: TimeEstimate) => string;
    isAIWorking: boolean;
    isContextInputFocused: boolean;
    isTagInputFocused: boolean;
    onClose: () => void;
    onSave: (taskId: string, updates: Partial<Task>) => void;
    prioritiesEnabled: boolean;
    projectContext?: Record<string, unknown> | null;
    projectFilterAreaId?: string;
    projects: Project[];
    recurrenceRRuleValue: string;
    recurrenceRuleValue: RecurrenceRule | '';
    recurrenceStrategyValue: RecurrenceStrategy;
    resetTaskChecklist: (taskId: string) => Promise<unknown>;
    sections: Array<{ id: string; projectId?: string; deletedAt?: string | null }>;
    setAiModal: React.Dispatch<React.SetStateAction<AIResponseModalState>>;
    setEditedTask: React.Dispatch<React.SetStateAction<Partial<Task>>>;
    setIsAIWorking: React.Dispatch<React.SetStateAction<boolean>>;
    setTitleImmediate: (text: string) => void;
    settings: Record<string, any>;
    showToast: ShowToast;
    t: (key: string) => string;
    tagInputDraft: string;
    task: Task | null;
    tasks: Task[];
    timeEstimatesEnabled: boolean;
    titleDebounceRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
    titleDraftRef: React.MutableRefObject<string>;
};

export function useTaskEditActions({
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
}: TaskEditActionsParams) {
    const applyChecklistUpdate = useCallback((nextChecklist: NonNullable<Task['checklist']>) => {
        setEditedTask((prev) => {
            const currentStatus = (prev.status ?? task?.status ?? 'inbox') as TaskStatus;
            let nextStatus = currentStatus;
            const isListMode = (prev.taskMode ?? task?.taskMode) === 'list';
            if (isListMode) {
                const allComplete = nextChecklist.length > 0 && nextChecklist.every((item) => item.isCompleted);
                if (allComplete) {
                    nextStatus = 'done';
                } else if (currentStatus === 'done') {
                    nextStatus = 'next';
                }
            }
            return {
                ...prev,
                checklist: nextChecklist,
                status: nextStatus,
            };
        });
    }, [setEditedTask, task?.status, task?.taskMode]);

    const handleResetChecklist = useCallback(() => {
        const current = editedTask.checklist || [];
        if (current.length === 0 || !task) return;
        const reset = current.map((item) => ({ ...item, isCompleted: false }));
        applyChecklistUpdate(reset);
        resetTaskChecklist(task.id).catch((error) => logTaskError('Failed to reset checklist', error));
    }, [applyChecklistUpdate, editedTask.checklist, resetTaskChecklist, task]);

    const handleSave = useCallback(async () => {
        if (!task) return;
        if (titleDebounceRef.current) {
            clearTimeout(titleDebounceRef.current);
            titleDebounceRef.current = null;
        }
        if (descriptionDebounceRef.current) {
            clearTimeout(descriptionDebounceRef.current);
            descriptionDebounceRef.current = null;
        }

        const rawTitle = String(titleDraftRef.current ?? '');
        const { title: parsedTitle, props: parsedProps, projectTitle, invalidDateCommands } = parseQuickAdd(
            rawTitle,
            projects,
            new Date(),
            areas,
        );
        if (invalidDateCommands && invalidDateCommands.length > 0) {
            showToast({
                title: t('common.notice'),
                message: `${t('quickAdd.invalidDateCommand')}: ${invalidDateCommands.join(', ')}`,
                tone: 'warning',
                durationMs: 4200,
            });
            return;
        }

        const existingProjectId = editedTask.projectId ?? task?.projectId;
        const hasProjectCommand = Boolean(parsedProps.projectId || projectTitle);
        let resolvedProjectId = parsedProps.projectId;
        if (!resolvedProjectId && projectTitle) {
            try {
                const created = await addProject(
                    projectTitle,
                    DEFAULT_PROJECT_COLOR,
                    projectFilterAreaId ? { areaId: projectFilterAreaId } : undefined,
                );
                resolvedProjectId = created?.id;
            } catch (error) {
                logTaskError('Failed to create project from quick add', error);
            }
        }
        if (!resolvedProjectId) {
            resolvedProjectId = existingProjectId;
        }

        const fallbackTitle = editedTask.title ?? task.title ?? rawTitle;
        const cleanedTitle = parsedTitle.trim() ? parsedTitle : fallbackTitle;
        const baseDescription = descriptionDraftRef.current;
        const resolvedDescription = parsedProps.description
            ? (baseDescription ? `${baseDescription}\n${parsedProps.description}` : parsedProps.description)
            : baseDescription;
        const mergedContexts = parsedProps.contexts
            ? Array.from(new Set([...(editedTask.contexts || []), ...parsedProps.contexts]))
            : editedTask.contexts;
        const mergedTags = parsedProps.tags
            ? Array.from(new Set([...(editedTask.tags || []), ...parsedProps.tags]))
            : editedTask.tags;
        const updates: Partial<Task> = {
            ...editedTask,
            title: cleanedTitle,
            description: resolvedDescription,
            contexts: mergedContexts,
            tags: mergedTags,
        };
        updates.checklist = applyMarkdownChecklistToTask(resolvedDescription, updates.checklist);
        if (parsedProps.status) updates.status = parsedProps.status;
        if (parsedProps.startTime) updates.startTime = parsedProps.startTime;
        if (parsedProps.dueDate) updates.dueDate = parsedProps.dueDate;
        if (parsedProps.reviewAt) updates.reviewAt = parsedProps.reviewAt;
        if (hasProjectCommand && resolvedProjectId && resolvedProjectId !== existingProjectId) {
            updates.projectId = resolvedProjectId;
            updates.sectionId = undefined;
            updates.areaId = undefined;
        }

        const recurrenceRule = recurrenceRuleValue || undefined;
        if (recurrenceRule) {
            if (recurrenceRule === 'weekly' && customWeekdays.length > 0) {
                const rrule = buildRRuleString('weekly', customWeekdays);
                updates.recurrence = { rule: 'weekly', strategy: recurrenceStrategyValue, byDay: customWeekdays, rrule };
            } else if (recurrenceRRuleValue) {
                const parsed = parseRRuleString(recurrenceRRuleValue);
                if (parsed.byDay?.length) {
                    updates.recurrence = {
                        rule: recurrenceRule,
                        strategy: recurrenceStrategyValue,
                        byDay: parsed.byDay,
                        rrule: recurrenceRRuleValue,
                    };
                } else {
                    updates.recurrence = { rule: recurrenceRule, strategy: recurrenceStrategyValue, rrule: recurrenceRRuleValue };
                }
            } else {
                updates.recurrence = buildRecurrenceValue(recurrenceRule, recurrenceStrategyValue);
            }
        } else {
            updates.recurrence = undefined;
        }

        const baseTask = baseTaskRef.current ?? task;
        const nextProjectId = updates.projectId ?? baseTask.projectId;
        if (nextProjectId) {
            updates.areaId = undefined;
        } else {
            updates.sectionId = undefined;
        }
        if (nextProjectId) {
            const nextSectionId = updates.sectionId ?? baseTask.sectionId;
            if (nextSectionId) {
                const isValid = sections.some((section) =>
                    section.id === nextSectionId && section.projectId === nextProjectId && !section.deletedAt
                );
                if (!isValid) {
                    updates.sectionId = undefined;
                }
            }
        }

        const trimmedUpdates: Partial<Task> = { ...updates };
        (Object.keys(trimmedUpdates) as (keyof Task)[]).forEach((key) => {
            const nextValue = trimmedUpdates[key];
            const baseValue = baseTask[key];
            if (Array.isArray(nextValue) || typeof nextValue === 'object') {
                const nextSerialized = nextValue == null ? null : JSON.stringify(nextValue);
                const baseSerialized = baseValue == null ? null : JSON.stringify(baseValue);
                if (nextSerialized === baseSerialized) delete trimmedUpdates[key];
            } else if ((nextValue ?? null) === (baseValue ?? null)) {
                delete trimmedUpdates[key];
            }
        });
        if (Object.keys(trimmedUpdates).length === 0) {
            onClose();
            return;
        }

        onSave(task.id, trimmedUpdates);
        onClose();
    }, [
        areas,
        addProject,
        baseTaskRef,
        customWeekdays,
        descriptionDebounceRef,
        descriptionDraftRef,
        editedTask,
        onClose,
        onSave,
        projectFilterAreaId,
        projects,
        recurrenceRuleValue,
        recurrenceRRuleValue,
        recurrenceStrategyValue,
        sections,
        showToast,
        t,
        task,
        titleDebounceRef,
        titleDraftRef,
    ]);

    const handleShare = useCallback(async () => {
        if (!task) return;

        const title = String(titleDraftRef.current ?? editedTask.title ?? task.title ?? '').trim();
        const lines: string[] = [];
        if (title) lines.push(title);

        const status = (editedTask.status ?? task.status) as TaskStatus | undefined;
        if (status) lines.push(`${t('taskEdit.statusLabel')}: ${t(`status.${status}`)}`);
        if (prioritiesEnabled) {
            const priority = editedTask.priority ?? task.priority;
            if (priority) lines.push(`${t('taskEdit.priorityLabel')}: ${t(`priority.${priority}`)}`);
        }
        if (editedTask.startTime) lines.push(`${t('taskEdit.startDateLabel')}: ${formatDate(editedTask.startTime)}`);
        if (editedTask.dueDate) lines.push(`${t('taskEdit.dueDateLabel')}: ${formatDueDate(editedTask.dueDate)}`);
        if (editedTask.reviewAt) lines.push(`${t('taskEdit.reviewDateLabel')}: ${formatDate(editedTask.reviewAt)}`);
        if (timeEstimatesEnabled) {
            const estimate = editedTask.timeEstimate as TimeEstimate | undefined;
            if (estimate) lines.push(`${t('taskEdit.timeEstimateLabel')}: ${formatTimeEstimateLabel(estimate)}`);
        }

        const contexts = (editedTask.contexts ?? []).filter(Boolean);
        if (contexts.length) lines.push(`${t('taskEdit.contextsLabel')}: ${contexts.join(', ')}`);

        const tags = (editedTask.tags ?? []).filter(Boolean);
        if (tags.length) lines.push(`${t('taskEdit.tagsLabel')}: ${tags.join(', ')}`);

        const description = String(editedTask.description ?? '').trim();
        if (description) {
            lines.push('');
            lines.push(`${t('taskEdit.descriptionLabel')}:`);
            lines.push(description);
        }

        const checklist = (editedTask.checklist ?? []).filter((item) => item && item.title);
        if (checklist.length) {
            lines.push('');
            lines.push(`${t('taskEdit.checklist')}:`);
            checklist.forEach((item) => {
                lines.push(`${item.isCompleted ? '[x]' : '[ ]'} ${item.title}`);
            });
        }

        const message = lines.join('\n').trim();
        if (!message) return;

        try {
            await Share.share({
                title: title || undefined,
                message,
            });
        } catch (error) {
            logTaskError('Share failed:', error);
        }
    }, [editedTask, formatDate, formatDueDate, formatTimeEstimateLabel, prioritiesEnabled, t, task, timeEstimatesEnabled, titleDraftRef]);

    const discardAndClose = useCallback(() => {
        if (titleDebounceRef.current) {
            clearTimeout(titleDebounceRef.current);
            titleDebounceRef.current = null;
        }
        if (descriptionDebounceRef.current) {
            clearTimeout(descriptionDebounceRef.current);
            descriptionDebounceRef.current = null;
        }
        onClose();
    }, [descriptionDebounceRef, onClose, titleDebounceRef]);

    const hasPendingChanges = useCallback((): boolean => {
        if (!task) return false;

        const baseTask = baseTaskRef.current ?? task;
        const pendingContexts = isContextInputFocused
            ? parseTokenList(contextInputDraft, '@')
            : (editedTask.contexts ?? baseTask.contexts ?? []);
        const pendingTags = isTagInputFocused
            ? parseTokenList(tagInputDraft, '#')
            : (editedTask.tags ?? baseTask.tags ?? []);
        const currentSnapshot: Task = {
            ...baseTask,
            ...editedTask,
            title: String(titleDraftRef.current ?? editedTask.title ?? baseTask.title ?? ''),
            description: String(descriptionDraftRef.current ?? editedTask.description ?? baseTask.description ?? ''),
            contexts: pendingContexts,
            tags: pendingTags,
        };
        const keys = new Set<keyof Task>([
            ...(Object.keys(baseTask) as (keyof Task)[]),
            ...(Object.keys(currentSnapshot) as (keyof Task)[]),
        ]);

        for (const key of keys) {
            if (!areTaskFieldValuesEqual(currentSnapshot[key], baseTask[key])) {
                return true;
            }
        }
        return false;
    }, [
        baseTaskRef,
        contextInputDraft,
        descriptionDraftRef,
        editedTask,
        isContextInputFocused,
        isTagInputFocused,
        tagInputDraft,
        task,
        titleDraftRef,
    ]);

    const handleAttemptClose = useCallback(() => {
        if (!hasPendingChanges()) {
            discardAndClose();
            return;
        }

        Alert.alert(
            t('taskEdit.discardChanges'),
            t('taskEdit.discardChangesDesc'),
            [
                {
                    text: t('common.cancel'),
                    style: 'cancel',
                },
                {
                    text: t('common.discard'),
                    style: 'destructive',
                    onPress: discardAndClose,
                },
                {
                    text: t('common.save'),
                    onPress: () => {
                        void handleSave();
                    },
                },
            ],
            { cancelable: true },
        );
    }, [discardAndClose, handleSave, hasPendingChanges, t]);

    const handleDone = useCallback(() => {
        void handleSave();
    }, [handleSave]);

    const handleDuplicateTask = useCallback(async () => {
        if (!task) return;
        await duplicateTask(task.id, false).catch((error) => logTaskError('Failed to duplicate task', error));
        Alert.alert(t('taskEdit.duplicateDoneTitle'), t('taskEdit.duplicateDoneBody'));
    }, [duplicateTask, t, task]);

    const handleDeleteTask = useCallback(async () => {
        if (!task) return;
        await deleteTask(task.id).catch((error) => logTaskError('Failed to delete task', error));
        onClose();
    }, [deleteTask, onClose, task]);

    const handleConvertToReference = useCallback(() => {
        if (!task) return;
        const referenceUpdate: Partial<Task> = {
            status: 'reference',
            startTime: undefined,
            dueDate: undefined,
            reviewAt: undefined,
            recurrence: undefined,
            priority: undefined,
            timeEstimate: undefined,
            checklist: undefined,
            isFocusedToday: false,
            pushCount: 0,
        };
        onSave(task.id, referenceUpdate);
        setEditedTask((prev) => ({
            ...prev,
            ...referenceUpdate,
        }));
    }, [onSave, setEditedTask, task]);

    const getAIProvider = useCallback(async () => {
        if (!aiEnabled) {
            Alert.alert(t('ai.disabledTitle'), t('ai.disabledBody'));
            return null;
        }
        const provider = (settings.ai?.provider ?? 'openai') as AIProviderId;
        const apiKey = await loadAIKey(provider);
        if (isAIKeyRequired(settings) && !apiKey) {
            Alert.alert(t('ai.missingKeyTitle'), t('ai.missingKeyBody'));
            return null;
        }
        return createAIProvider(buildAIConfig(settings, apiKey));
    }, [aiEnabled, settings, t]);

    const applyAISuggestion = useCallback((suggested: { title?: string; context?: string; timeEstimate?: TimeEstimate }) => {
        if (suggested.title) {
            setTitleImmediate(suggested.title);
        }
        setEditedTask((prev) => {
            const nextContexts = suggested.context
                ? Array.from(new Set([...(prev.contexts ?? []), suggested.context]))
                : prev.contexts;
            return {
                ...prev,
                title: suggested.title ?? prev.title,
                timeEstimate: suggested.timeEstimate ?? prev.timeEstimate,
                contexts: nextContexts,
            };
        });
    }, [setEditedTask, setTitleImmediate]);

    const handleAIClarify = useCallback(async () => {
        if (!task || isAIWorking) return;
        const title = String(titleDraftRef.current ?? editedTask.title ?? task.title ?? '').trim();
        if (!title) return;
        setIsAIWorking(true);
        try {
            const provider = await getAIProvider();
            if (!provider) return;
            const contextOptions = Array.from(new Set([
                ...getUsedTaskTokens(tasks, (item) => item.contexts, { prefix: '@' }),
                ...(editedTask.contexts ?? []),
            ]));
            const response = await provider.clarifyTask({
                title,
                contexts: contextOptions,
                ...(projectContext ?? {}),
            });
            const actions: AIResponseAction[] = response.options.slice(0, 3).map((option) => ({
                label: option.label,
                onPress: () => {
                    setTitleImmediate(option.action);
                    closeAIModal();
                },
            }));
            if (response.suggestedAction?.title) {
                actions.push({
                    label: t('ai.applySuggestion'),
                    variant: 'primary',
                    onPress: () => {
                        applyAISuggestion(response.suggestedAction!);
                        closeAIModal();
                    },
                });
            }
            actions.push({
                label: t('common.cancel'),
                variant: 'secondary',
                onPress: closeAIModal,
            });
            setAiModal({
                title: response.question || t('taskEdit.aiClarify'),
                actions,
            });
        } catch (error) {
            logTaskWarn('AI clarify failed', error);
            Alert.alert(t('ai.errorTitle'), t('ai.errorBody'));
        } finally {
            setIsAIWorking(false);
        }
    }, [
        applyAISuggestion,
        closeAIModal,
        editedTask,
        getAIProvider,
        isAIWorking,
        projectContext,
        setAiModal,
        setIsAIWorking,
        setTitleImmediate,
        t,
        task,
        tasks,
        titleDraftRef,
    ]);

    const handleAIBreakdown = useCallback(async () => {
        if (!task || isAIWorking) return;
        const title = String(titleDraftRef.current ?? editedTask.title ?? task.title ?? '').trim();
        if (!title) return;
        setIsAIWorking(true);
        try {
            const provider = await getAIProvider();
            if (!provider) return;
            const response = await provider.breakDownTask({
                title,
                description: String(descriptionDraft ?? ''),
                ...(projectContext ?? {}),
            });
            const steps = response.steps.map((step) => step.trim()).filter(Boolean).slice(0, 8);
            if (steps.length === 0) return;
            setAiModal({
                title: t('ai.breakdownTitle'),
                message: steps.map((step, index) => `${index + 1}. ${step}`).join('\n'),
                actions: [
                    {
                        label: t('common.cancel'),
                        variant: 'secondary',
                        onPress: closeAIModal,
                    },
                    {
                        label: t('ai.addSteps'),
                        variant: 'primary',
                        onPress: () => {
                            const newItems = steps.map((step) => ({
                                id: generateUUID(),
                                title: step,
                                isCompleted: false,
                            }));
                            applyChecklistUpdate([...(editedTask.checklist || []), ...newItems]);
                            closeAIModal();
                        },
                    },
                ],
            });
        } catch (error) {
            logTaskWarn('AI breakdown failed', error);
            Alert.alert(t('ai.errorTitle'), t('ai.errorBody'));
        } finally {
            setIsAIWorking(false);
        }
    }, [
        applyChecklistUpdate,
        closeAIModal,
        descriptionDraft,
        editedTask.checklist,
        getAIProvider,
        isAIWorking,
        projectContext,
        setAiModal,
        setIsAIWorking,
        t,
        task,
        titleDraftRef,
    ]);

    return {
        applyChecklistUpdate,
        handleAIClarify,
        handleAIBreakdown,
        handleAttemptClose,
        handleConvertToReference,
        handleDeleteTask,
        handleDone,
        handleDuplicateTask,
        handleResetChecklist,
        handleSave,
        handleShare,
    };
}
