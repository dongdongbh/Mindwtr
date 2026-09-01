import React, { useCallback } from 'react';
import { Alert, Share } from 'react-native';
import {
    formatAIErrorAlertBody,
    Task,
    TaskStatus,
    TimeEstimate,
    createAIProvider,
    generateUUID,
    type AIProviderId,
    getUsedTaskTokens,
    tFallback,
    type StoreActionResult,
} from '@mindwtr/core';

import type { AIResponseAction } from '../ai-response-modal';
import { buildAIConfig, isAIKeyRequired, loadAIKey } from '../../lib/ai-config';
import { logTaskError, logTaskWarn } from './task-edit-modal.utils';
import { openProjectScreen, openTaskScreen } from '../../lib/task-meta-navigation';
import { settleStoreAction } from '../store-action-result';
import { type TaskDraftSetter } from '@mindwtr/core/task-draft';
import {
    type TaskEditDraft,
} from './task-edit-draft-adapter';
import type {
    SetTaskEditDraftValue,
    TaskEditDraftLifecycle,
} from './use-task-edit-state';

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
    actionLabel?: string;
    onAction?: () => void | Promise<void>;
}) => void;

type TaskEditActionsParams = {
    aiEnabled: boolean;
    closeAIModal: () => void;
    deleteTask: (taskId: string) => Promise<StoreActionResult>;
    descriptionDraft: string;
    draftLifecycle: TaskEditDraftLifecycle;
    duplicateTask: (taskId: string, includeDoneSubtasks?: boolean) => Promise<StoreActionResult>;
    promoteTaskToProject?: (taskId: string, options?: { title?: string; color?: string; areaId?: string }) => Promise<StoreActionResult>;
    convertTaskToSection?: (taskId: string) => Promise<StoreActionResult>;
    mergedTask: Partial<Task>;
    taskEditDraft: TaskEditDraft | null;
    formatDate: (dateStr?: string) => string;
    formatDueDate: (dateStr?: string) => string;
    formatTimeEstimateLabel: (estimate: TimeEstimate) => string;
    isAIWorking: boolean;
    onClose: () => void;
    prioritiesEnabled: boolean;
    projectContext?: Record<string, unknown> | null;
    resetTaskChecklist: (taskId: string) => Promise<StoreActionResult>;
    restoreTask: (taskId: string) => Promise<StoreActionResult>;
    setAiModal: React.Dispatch<React.SetStateAction<AIResponseModalState>>;
    setChecklist: SetTaskEditDraftValue<Task['checklist']>;
    setDraftField: TaskDraftSetter;
    setIsAIWorking: React.Dispatch<React.SetStateAction<boolean>>;
    setTitleImmediate: (text: string) => void;
    settings: Record<string, any>;
    showToast: ShowToast;
    t: (key: string) => string;
    task: Task | null;
    tasks: Task[];
    timeEstimatesEnabled: boolean;
    titleDraftRef: React.MutableRefObject<string>;
    canMutate?: () => boolean;
};

export function useTaskEditActions({
    aiEnabled,
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
    canMutate = () => true,
}: TaskEditActionsParams) {
    const showTaskWriteError = useCallback((message?: string) => showToast({
        title: tFallback(t, 'common.error', 'Error'),
        message: message || tFallback(t, 'task.updateFailed', 'Could not update task.'),
        tone: 'error',
        durationMs: 4200,
    }), [showToast, t]);

    const runStoreAction = useCallback(async (
        action: () => Promise<StoreActionResult>,
        logMessage: string,
    ): Promise<boolean> => {
        if (!canMutate()) return false;
        const outcome = await settleStoreAction(action);
        if (outcome.ok) return true;
        if ('cause' in outcome) {
            logTaskError(logMessage, outcome.cause);
        }
        showTaskWriteError(outcome.message);
        return false;
    }, [canMutate, showTaskWriteError]);

    const applyChecklistUpdate = useCallback((nextChecklist: NonNullable<Task['checklist']>) => {
        if (!canMutate()) return;
        const currentStatus = taskEditDraft?.draft.status ?? task?.status ?? 'inbox';
        let nextStatus = currentStatus;
        if (task?.taskMode === 'list') {
            const allComplete = nextChecklist.length > 0 && nextChecklist.every((item) => item.isCompleted);
            if (allComplete) {
                nextStatus = 'done';
            } else if (currentStatus === 'done') {
                nextStatus = 'next';
            }
        }
        setChecklist(nextChecklist);
        if (nextStatus !== currentStatus) setDraftField('status', nextStatus);
    }, [canMutate, setChecklist, setDraftField, task?.status, task?.taskMode, taskEditDraft?.draft.status]);

    const handleResetChecklist = useCallback(async () => {
        const current = taskEditDraft?.checklist || [];
        if (current.length === 0 || !task) return;
        const succeeded = await runStoreAction(
            () => resetTaskChecklist(task.id),
            'Failed to reset checklist',
        );
        if (!succeeded) return;
        const reset = current.map((item) => ({ ...item, isCompleted: false }));
        applyChecklistUpdate(reset);
    }, [applyChecklistUpdate, resetTaskChecklist, runStoreAction, task, taskEditDraft?.checklist]);

    const handleShare = useCallback(async () => {
        if (!task) return;

        const title = String(titleDraftRef.current ?? mergedTask.title ?? task.title ?? '').trim();
        const lines: string[] = [];
        if (title) lines.push(title);

        const status = (mergedTask.status ?? task.status) as TaskStatus | undefined;
        if (status) lines.push(`${t('taskEdit.statusLabel')}: ${t(`status.${status}`)}`);
        if (prioritiesEnabled) {
            const priority = mergedTask.priority ?? task.priority;
            if (priority) lines.push(`${t('taskEdit.priorityLabel')}: ${t(`priority.${priority}`)}`);
        }
        if (mergedTask.startTime) lines.push(`${t('taskEdit.startDateLabel')}: ${formatDate(mergedTask.startTime)}`);
        if (mergedTask.dueDate) lines.push(`${t('taskEdit.dueDateLabel')}: ${formatDueDate(mergedTask.dueDate)}`);
        if (mergedTask.reviewAt) lines.push(`${t('taskEdit.reviewDateLabel')}: ${formatDate(mergedTask.reviewAt)}`);
        if (timeEstimatesEnabled) {
            const estimate = mergedTask.timeEstimate as TimeEstimate | undefined;
            if (estimate) lines.push(`${t('taskEdit.timeEstimateLabel')}: ${formatTimeEstimateLabel(estimate)}`);
        }

        const contexts = (mergedTask.contexts ?? []).filter(Boolean);
        if (contexts.length) lines.push(`${t('taskEdit.contextsLabel')}: ${contexts.join(', ')}`);

        const tags = (mergedTask.tags ?? []).filter(Boolean);
        if (tags.length) lines.push(`${t('taskEdit.tagsLabel')}: ${tags.join(', ')}`);

        const description = String(mergedTask.description ?? '').trim();
        if (description) {
            lines.push('');
            lines.push(`${t('taskEdit.descriptionLabel')}:`);
            lines.push(description);
        }

        const checklist = (mergedTask.checklist ?? []).filter((item) => item && item.title);
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
    }, [mergedTask, formatDate, formatDueDate, formatTimeEstimateLabel, prioritiesEnabled, t, task, timeEstimatesEnabled, titleDraftRef]);

    const handleAttemptClose = useCallback(() => {
        if (!canMutate()) {
            onClose();
            return;
        }
        if (!draftLifecycle.hasPendingChanges()) {
            draftLifecycle.discard();
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
                    onPress: draftLifecycle.discard,
                },
                {
                    text: t('common.save'),
                    onPress: () => {
                        void draftLifecycle.save();
                    },
                },
            ],
            { cancelable: true },
        );
    }, [canMutate, draftLifecycle, onClose, t]);

    const handleDone = useCallback(() => {
        if (!canMutate()) {
            onClose();
            return;
        }
        void draftLifecycle.save();
    }, [canMutate, draftLifecycle, onClose]);

    const handleDuplicateTask = useCallback(async () => {
        if (!task || !canMutate()) return;
        try {
            const result = await duplicateTask(task.id, false);
            if (!result.success || !result.id) {
                showToast({
                    title: tFallback(t, 'common.error', 'Error'),
                    message: result.error || t('task.duplicateFailed'),
                    tone: 'error',
                });
                return;
            }
            onClose();
            openTaskScreen(result.id, task.projectId, 'task');
        } catch (error) {
            logTaskError('Failed to duplicate task', error);
            showToast({
                title: tFallback(t, 'common.error', 'Error'),
                message: t('task.duplicateFailed'),
                tone: 'error',
            });
        }
    }, [canMutate, duplicateTask, onClose, showToast, t, task]);

    const handlePromoteTaskToProject = useCallback(async () => {
        if (!task || !promoteTaskToProject || !canMutate()) return;
        try {
            const title = String(titleDraftRef.current || mergedTask.title || task.title || '').trim();
            const result = await promoteTaskToProject(task.id, { title });
            if (!result.success || !result.id) {
                showToast({
                    title: tFallback(t, 'common.error', 'Error'),
                    message: result.error || t('task.promoteToProjectFailed'),
                    tone: 'error',
                });
                return;
            }
            showToast({
                title: tFallback(t, 'common.success', 'Success'),
                message: result.reused
                    ? t('task.promoteToProjectMoved')
                    : t('task.promoteToProjectCreated'),
                tone: 'success',
            });
            onClose();
            openProjectScreen(result.id);
        } catch (error) {
            logTaskError('Failed to create project from task', error);
            showToast({
                title: tFallback(t, 'common.error', 'Error'),
                message: t('task.promoteToProjectFailed'),
                tone: 'error',
            });
        }
    }, [canMutate, mergedTask, onClose, promoteTaskToProject, showToast, t, task, titleDraftRef]);

    const handleDeleteTask = useCallback(async () => {
        if (!task || !canMutate()) return;
        const deleted = await runStoreAction(
            () => deleteTask(task.id),
            'Failed to delete task',
        );
        if (!deleted) return;
        showToast({
            title: tFallback(t, 'common.notice', 'Notice'),
            message: tFallback(t, 'list.taskDeleted', 'Task deleted'),
            tone: 'info',
            actionLabel: tFallback(t, 'common.undo', 'Undo'),
            onAction: async () => {
                await runStoreAction(
                    () => restoreTask(task.id),
                    'Failed to restore task',
                );
            },
            durationMs: 5200,
        });
        onClose();
    }, [canMutate, deleteTask, onClose, restoreTask, runStoreAction, showToast, t, task]);

    const handleConvertToReference = useCallback(() => {
        if (!canMutate()) return;
        void draftLifecycle.convertToReference();
    }, [canMutate, draftLifecycle]);

    // The task is soft-deleted by the conversion, so the open draft is committed
    // first (save closes the editor) and only then does the section get built —
    // otherwise edits made in this session would be lost with the task (#1106).
    const handleConvertToSection = useCallback(async () => {
        if (!task || !convertTaskToSection || !canMutate()) return;
        const saved = await draftLifecycle.save();
        if (!saved) return;
        const converted = await runStoreAction(
            () => convertTaskToSection(task.id),
            'Failed to convert task to a section',
        );
        if (!converted) return;
        showToast({
            title: tFallback(t, 'common.success', 'Success'),
            message: t('task.convertToSectionCreated'),
            tone: 'success',
        });
    }, [canMutate, convertTaskToSection, draftLifecycle, runStoreAction, showToast, t, task]);

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
        if (!canMutate()) return;
        if (suggested.title) {
            setTitleImmediate(suggested.title);
        }
        if (suggested.timeEstimate) setDraftField('timeEstimate', suggested.timeEstimate);
        if (suggested.context) {
            const contexts = (taskEditDraft?.draft.contexts ?? '').split(',').map((value) => value.trim()).filter(Boolean);
            setDraftField('contexts', Array.from(new Set([...contexts, suggested.context])).join(', '));
        }
    }, [canMutate, setDraftField, setTitleImmediate, taskEditDraft?.draft.contexts]);

    const handleAIClarify = useCallback(async () => {
        if (!task || isAIWorking || !canMutate()) return;
        const title = String(titleDraftRef.current ?? mergedTask.title ?? task.title ?? '').trim();
        if (!title) return;
        setIsAIWorking(true);
        try {
            const provider = await getAIProvider();
            if (!provider) return;
            const contextOptions = Array.from(new Set([
                ...getUsedTaskTokens(tasks, (item) => item.contexts, { prefix: '@' }),
                ...(mergedTask.contexts ?? []),
            ]));
            const response = await provider.clarifyTask({
                title,
                contexts: contextOptions,
                startTime: mergedTask.startTime ?? task.startTime,
                dueDate: mergedTask.dueDate ?? task.dueDate,
                reviewAt: mergedTask.reviewAt ?? task.reviewAt,
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
            Alert.alert(t('ai.errorTitle'), formatAIErrorAlertBody(t('ai.errorBody'), error));
        } finally {
            setIsAIWorking(false);
        }
    }, [
        applyAISuggestion,
        canMutate,
        closeAIModal,
        mergedTask,
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
        if (!task || isAIWorking || !canMutate()) return;
        const title = String(titleDraftRef.current ?? mergedTask.title ?? task.title ?? '').trim();
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
                            applyChecklistUpdate([...(taskEditDraft?.checklist || []), ...newItems]);
                            closeAIModal();
                        },
                    },
                ],
            });
        } catch (error) {
            logTaskWarn('AI breakdown failed', error);
            Alert.alert(t('ai.errorTitle'), formatAIErrorAlertBody(t('ai.errorBody'), error));
        } finally {
            setIsAIWorking(false);
        }
    }, [
        applyChecklistUpdate,
        canMutate,
        closeAIModal,
        descriptionDraft,
        mergedTask,
        getAIProvider,
        isAIWorking,
        projectContext,
        setAiModal,
        setIsAIWorking,
        t,
        task,
        taskEditDraft?.checklist,
        titleDraftRef,
    ]);

    return {
        applyChecklistUpdate,
        handleAIClarify,
        handleAIBreakdown,
        handleAttemptClose,
        handleConvertToReference,
        handleConvertToSection,
        handleDeleteTask,
        handleDone,
        handleDuplicateTask,
        handlePromoteTaskToProject,
        handleResetChecklist,
        handleShare,
    };
}
