import React, { useCallback } from 'react';
import { Alert, Share } from 'react-native';
import {
    prepareChecklistProjectConversion,
    type ChecklistProjectConversion,
    canSkipRecurringTaskOccurrence,
    Task,
    TimeEstimate,
    buildTaskShare,
    createAIProvider,
    createTaskCancellationUndo,
    generateUUID,
    type AIProviderId,
    type Language,
    getChecklistEditStatus,
    tFallback,
    type StoreActionResult,
    useTaskStore,
} from '@mindwtr/core';

import {
    appendTaskBreakdownSteps,
    buildTaskBreakdownInput,
    buildTaskClarifyInput,
    getAIClarifyDialog,
    getAIErrorAlert,
    getTaskBreakdownDialog,
    getTaskBreakdownSteps,
    getTaskClarifySuggestionEdit,
    redactAIError,
    type TaskAIProjectContext,
} from '@mindwtr/core/ai-task-actions';
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
    language?: Language;
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
    projectContext?: TaskAIProjectContext | null;
    resetTaskChecklist: (taskId: string) => Promise<StoreActionResult>;
    skipRecurringTaskOccurrence: (taskId: string) => Promise<StoreActionResult>;
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
    language = 'en',
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
    canMutate = () => true,
}: TaskEditActionsParams) {
    const cancellationBeforeRef = React.useRef<Task | null>(null);
    const showTaskWriteError = useCallback((message?: string) => showToast({
        title: tFallback(t, 'common.error', 'Error'),
        message: message || tFallback(t, 'task.updateFailed', 'Could not update task.'),
        tone: 'error',
        durationMs: 4200,
    }), [showToast, t]);

    const runStoreAction = useCallback(async (
        action: () => Promise<StoreActionResult>,
        logMessage: string,
        fallbackMessage?: string,
    ): Promise<boolean> => {
        if (!canMutate()) return false;
        const outcome = await settleStoreAction(action);
        if (outcome.ok) return true;
        if ('cause' in outcome) {
            logTaskError(logMessage, outcome.cause);
        }
        showTaskWriteError(outcome.message || fallbackMessage);
        return false;
    }, [canMutate, showTaskWriteError]);

    const applyChecklistUpdate = useCallback((nextChecklist: NonNullable<Task['checklist']>) => {
        if (!canMutate()) return;
        const currentStatus = taskEditDraft?.draft.status ?? task?.status ?? 'inbox';
        const nextStatus = getChecklistEditStatus({ taskMode: task?.taskMode, status: currentStatus, checklist: nextChecklist });
        setChecklist(nextChecklist);
        if (nextStatus !== currentStatus) setDraftField('status', nextStatus);
    }, [canMutate, setChecklist, setDraftField, task?.status, task?.taskMode, taskEditDraft?.draft.status]);

    const handleResetChecklist = useCallback(async () => {
        const current = taskEditDraft?.checklist || [];
        if (current.length === 0 || !task) return;
        // Items added in this editor are not saved yet: only the draft reopens them.
        const saved = useTaskStore.getState()._tasksById.get(task.id) ?? task;
        if (saved.checklist?.length) {
            const succeeded = await runStoreAction(
                () => resetTaskChecklist(task.id),
                'Failed to reset checklist',
            );
            if (!succeeded) return;
        }
        const reset = current.map((item) => ({ ...item, isCompleted: false }));
        applyChecklistUpdate(reset);
    }, [applyChecklistUpdate, resetTaskChecklist, runStoreAction, task, taskEditDraft?.checklist]);

    const handleShare = useCallback(async () => {
        const content = buildTaskShare({
            task, mergedTask, rawTitle: titleDraftRef.current,
            prioritiesEnabled, timeEstimatesEnabled, t,
            formatDate, formatDueDate, formatTimeEstimateLabel,
        });
        if (!content) return;

        try {
            await Share.share(content);
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

    const [projectConversionOpen, setProjectConversionOpen] = React.useState(false);
    React.useEffect(() => setProjectConversionOpen(false), [task?.id]);
    const confirmProjectConversion = useCallback(async (projectTitle?: string, expand = false) => {
        if (!task || !promoteTaskToProject || !canMutate()) return;
        try {
            const title = projectTitle ?? String(titleDraftRef.current || mergedTask.title || task.title || '').trim();
            if (expand) {
                const preview = prepareChecklistProjectConversion(useTaskStore.getState(), { ...task, ...mergedTask } as Task, title);
                if (!preview.success) { showTaskWriteError(t(preview.error)); return; }
            }
            if (!await draftLifecycle.save()) return;
            setProjectConversionOpen(false);
            if (expand) {
                const state = useTaskStore.getState();
                const source = state._tasksById.get(task.id);
                if (!source) return;
                const prepared = prepareChecklistProjectConversion(state, source, title);
                if (!prepared.success) { showTaskWriteError(t(prepared.error)); return; }
                const command: ChecklistProjectConversion = prepared.command;
                const convert = async () => {
                    const result = await useTaskStore.getState().convertChecklistToProject(command);
                    if (!result.success) {
                        showToast({ title: t('common.error'), message: t(result.error || 'task.expandChecklistSaveFailed'),
                            tone: 'error', ...(result.error === 'task.expandChecklistSaveFailed' ? { actionLabel: t('common.retry'), onAction: convert } : {}) });
                        return;
                    }
                    const undo = async () => {
                        const restored = await useTaskStore.getState().undoChecklistToProject(command);
                        if (!restored.success) showToast({ title: t('common.error'), tone: 'error',
                            message: t(restored.error || 'task.expandChecklistConflict'),
                            ...(restored.error === 'task.expandChecklistSaveFailed' ? { actionLabel: t('common.retry'), onAction: undo } : {}) });
                        else openTaskScreen(command.source.id, command.source.projectId, 'task');
                    };
                    showToast({ title: t('common.success'), message: t('task.promoteToProjectCreated'), tone: 'success',
                        actionLabel: t('common.undo'), onAction: undo });
                    openProjectScreen(command.project.id);
                };
                await convert();
                return;
            }
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
    }, [canMutate, draftLifecycle, mergedTask, onClose, promoteTaskToProject, showTaskWriteError, showToast, t, task, titleDraftRef]);
    const handlePromoteTaskToProject = useCallback(() => {
        if (!task || !canMutate()) return;
        if ((mergedTask.checklist ?? task.checklist)?.length) setProjectConversionOpen(true);
        else void confirmProjectConversion();
    }, [canMutate, confirmProjectConversion, mergedTask.checklist, task]);

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

    const handleCancelTask = useCallback(async () => {
        if (!task || !canMutate()) return;
        const before = cancellationBeforeRef.current?.id === task.id
            ? cancellationBeforeRef.current
            : useTaskStore.getState()._tasksById.get(task.id) ?? task;
        cancellationBeforeRef.current = before;
        try {
            if (!await draftLifecycle.cancel()) {
                const current = useTaskStore.getState()._tasksById.get(task.id);
                if (current?.status !== 'archived' || !current.cancelledAt) cancellationBeforeRef.current = null;
                return;
            }
            cancellationBeforeRef.current = null;
            const cancelledAt = useTaskStore.getState()._tasksById.get(task.id)?.cancelledAt;
            const undoCancellation = createTaskCancellationUndo(before, cancelledAt);
            const restore = async () => {
                const outcome = await undoCancellation();
                if (outcome.success) return;
                logTaskError('Failed to undo task cancellation', new Error(outcome.error || 'Cancellation was superseded'));
                showToast({
                    title: tFallback(t, 'common.error', 'Error'),
                    message: outcome.error || tFallback(t, 'task.updateFailed', 'Could not update task.'),
                    tone: 'error',
                    durationMs: 5200,
                    ...(outcome.retryable ? {
                        actionLabel: tFallback(t, 'common.undo', 'Undo'),
                        onAction: restore,
                    } : {}),
                });
            };
            showToast({
                title: tFallback(t, 'common.notice', 'Notice'),
                message: tFallback(t, 'task.cancelledWithRestore', 'Task cancelled. You can restore it from Archive.'),
                tone: 'info',
                durationMs: 5200,
                ...(useTaskStore.getState().settings?.undoNotificationsEnabled === false ? {} : {
                    actionLabel: tFallback(t, 'common.undo', 'Undo'),
                    onAction: restore,
                }),
            });
        } catch (error) {
            logTaskError('Failed to cancel task', error);
            showTaskWriteError(error instanceof Error ? error.message : undefined);
        }
    }, [canMutate, draftLifecycle, showTaskWriteError, showToast, t, task]);

    const handleSkipOccurrence = useCallback(async () => {
        if (!task || !canMutate()) return;
        if (draftLifecycle.hasPendingChanges()) {
            if (!canSkipRecurringTaskOccurrence({ ...task, ...mergedTask })) {
                showTaskWriteError(tFallback(t, 'task.skipOccurrenceSaveFirst', 'Save or discard status and recurrence changes before skipping.'));
                return;
            }
            if (!await draftLifecycle.save()) return;
        }
        const skipped = await runStoreAction(
            () => skipRecurringTaskOccurrence(task.id),
            'Failed to skip recurring occurrence',
        );
        if (skipped) onClose();
    }, [canMutate, draftLifecycle, mergedTask, onClose, runStoreAction, showTaskWriteError, skipRecurringTaskOccurrence, t, task]);

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

    // The key comes back too: a failure's text must never show it.
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
        return { provider: createAIProvider(buildAIConfig(settings, apiKey, language)), apiKey };
    }, [aiEnabled, language, settings, t]);

    const applyAISuggestion = useCallback((suggested: { title: string; context?: string; timeEstimate?: TimeEstimate }) => {
        if (!canMutate()) return;
        const edit = getTaskClarifySuggestionEdit(taskEditDraft?.draft.contexts, suggested);
        if (edit.title) {
            setTitleImmediate(edit.title);
        }
        if (edit.patch.timeEstimate) setDraftField('timeEstimate', edit.patch.timeEstimate);
        if (edit.patch.contexts !== undefined) setDraftField('contexts', edit.patch.contexts);
    }, [canMutate, setDraftField, setTitleImmediate, taskEditDraft?.draft.contexts]);

    const handleAIClarify = useCallback(async () => {
        if (!task || isAIWorking || !canMutate()) return;
        const title = String(titleDraftRef.current ?? mergedTask.title ?? task.title ?? '').trim();
        if (!title) return;
        setIsAIWorking(true);
        let apiKey = '';
        try {
            const ai = await getAIProvider();
            if (!ai) return;
            apiKey = ai.apiKey;
            const response = await ai.provider.clarifyTask(buildTaskClarifyInput({
                title,
                tasks,
                task,
                merged: mergedTask,
                projectContext,
            }));
            const dialog = getAIClarifyDialog(response, t);
            const actions: AIResponseAction[] = dialog.choices.map((choice) => {
                const { apply } = choice;
                return {
                    label: choice.label,
                    ...(choice.variant ? { variant: choice.variant } : {}),
                    onPress: apply.type === 'title'
                        ? () => {
                            setTitleImmediate(apply.title);
                            closeAIModal();
                        }
                        : apply.type === 'suggestion'
                            ? () => {
                                applyAISuggestion(apply.suggestion);
                                closeAIModal();
                            }
                            : closeAIModal,
                };
            });
            setAiModal({
                title: dialog.title,
                actions,
            });
        } catch (error) {
            logTaskWarn('AI clarify failed', redactAIError(error, apiKey, settings));
            const alert = getAIErrorAlert(error, t, apiKey, settings);
            Alert.alert(alert.title, alert.message);
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
        settings,
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
        let apiKey = '';
        try {
            const ai = await getAIProvider();
            if (!ai) return;
            apiKey = ai.apiKey;
            const response = await ai.provider.breakDownTask(buildTaskBreakdownInput({
                title,
                description: descriptionDraft,
                projectContext,
            }));
            const steps = getTaskBreakdownSteps(response);
            if (steps.length === 0) return;
            const dialog = getTaskBreakdownDialog(steps, t);
            setAiModal({
                title: dialog.title,
                message: dialog.message,
                actions: [
                    {
                        ...dialog.cancel,
                        onPress: closeAIModal,
                    },
                    {
                        ...dialog.add,
                        onPress: () => {
                            applyChecklistUpdate(appendTaskBreakdownSteps(taskEditDraft?.checklist || [], steps, generateUUID));
                            closeAIModal();
                        },
                    },
                ],
            });
        } catch (error) {
            logTaskWarn('AI breakdown failed', redactAIError(error, apiKey, settings));
            const alert = getAIErrorAlert(error, t, apiKey, settings);
            Alert.alert(alert.title, alert.message);
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
        settings,
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
        handleCancelTask,
        handleSkipOccurrence,
        handleDeleteTask,
        handleDone,
        handleDuplicateTask,
        handlePromoteTaskToProject,
        projectConversionOpen, setProjectConversionOpen, confirmProjectConversion,
        handleResetChecklist,
        handleShare,
    };
}
