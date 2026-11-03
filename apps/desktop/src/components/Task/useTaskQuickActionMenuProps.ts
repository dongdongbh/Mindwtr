import { createElement, useCallback, useMemo } from 'react';
import {
    canMoveTaskToChecklist,
    canSkipRecurringTaskOccurrence,
    createBulkOrganizeProject,
    createTaskCancellationUndo,
    DEFAULT_PROJECT_COLOR,
    isProjectedRecurringTask,
    isTaskActionable,
    isTaskFinished,
    normalizeWeekStartSetting,
    resolveFeatureFlags,
    shallow,
    tFallback,
    updateTaskFromDraft,
    resolveQuickCaptureDefaultAreaId,
    useTaskStore,
    type Task,
    type TaskDraftSetter,
    type TaskStatus,
} from '@mindwtr/core';

import { useLanguage } from '../../contexts/language-context';
import { logInfo } from '../../lib/app-log';
import { dispatchNavigateEvent } from '../../lib/navigation-events';
import { resolveNativeDateInputLocale } from '../../lib/native-date-input-locale';
import { reportError } from '../../lib/report-error';
import { registerUndoableAction } from '../../lib/undo-registry';
import { undoTaskCompletion } from '../../lib/undo-task-completion';
import { useUiStore } from '../../store/ui-store';
import { runAfterTaskEditExit } from './task-edit-session';
import { formatTaskMarkedDoneMessage, formatTaskMovedMessage } from '@mindwtr/core';
import { TaskQuickActionMenu, type TaskQuickActionMenuProps } from './TaskQuickActionMenu';
import { useTaskItemProjectContext } from './useTaskItemProjectContext';

const NOOP_SET_DRAFT_FIELD: TaskDraftSetter = () => {};

export type TaskQuickActionMenuOverrides = {
    readOnly?: boolean;
    onRename?: () => void;
    focusAction?: TaskQuickActionMenuProps['focusAction'];

    onBeforeDelete?: () => void;

    onStatusChange?: (status: TaskStatus) => void;

    extraActions?: Array<{
        id: string;
        label: string;
        onSelect: () => void;
    }>;
};


export function deleteTaskWithUndo(
    taskId: string,
    { t, onBeforeDelete }: { t: (key: string) => string; onBeforeDelete?: () => void },
): void {
    onBeforeDelete?.();
    void useTaskStore.getState().deleteTask(taskId);
    const undo = registerUndoableAction(() => {
        void useTaskStore.getState().restoreTask(taskId);
    });
    if (useTaskStore.getState().settings?.undoNotificationsEnabled === false) return;
    useUiStore.getState().showToast(


        tFallback(t, 'list.taskDeleted', 'Task deleted'),
        'info',
        5000,
        {
            label: tFallback(t, 'common.undo', 'Undo'),
            onClick: undo,
        },
    );
}


export async function moveTaskToChecklistWithUndo(
    sourceId: string,
    targetId: string,
    { t }: { t: (key: string) => string },
): Promise<void> {
    const failed = (error?: string) => useUiStore.getState().showToast(
        error || tFallback(t, 'task.updateFailed', 'Could not update task.'), 'error');
    try {
        const result = await useTaskStore.getState().moveTaskToChecklist(sourceId, targetId);
        if (!result.success) {
            failed(result.error);
            return;
        }
    } catch (error) {
        reportError('Failed to move task to checklist', error);
        failed();
        return;
    }
    const undo = registerUndoableAction(() => {
        void useTaskStore.getState().undoMoveTaskToChecklist(sourceId, targetId)
            .then((result) => { if (!result.success) failed(result.error); })
            .catch((error) => reportError('Failed to undo move to checklist', error));
    });
    useUiStore.getState().showToast(
        tFallback(t, 'task.addedToChecklist', 'Added to checklist'),
        'info',
        5000,
        useTaskStore.getState().settings?.undoNotificationsEnabled === false
            ? undefined
            : { label: tFallback(t, 'common.undo', 'Undo'), onClick: undo },
    );
}


export async function duplicateTaskAndReveal(
    task: Pick<Task, 'id' | 'projectId' | 'status'>,
    { t }: { t: (key: string) => string },
): Promise<void> {
    try {
        const result = await useTaskStore.getState().duplicateTask(task.id, false);
        if (!result.success || !result.id) {
            useUiStore.getState().showToast(result.error || t('task.duplicateFailed'), 'error');
            return;
        }
        runAfterTaskEditExit(() => {
            useTaskStore.getState().setHighlightTask(result.id!);
            if (task.projectId) {
                useUiStore.getState().setProjectView({ selectedProjectId: task.projectId });
                dispatchNavigateEvent('projects');
            } else if (isTaskFinished(task)) {


                dispatchNavigateEvent('inbox');
            }
            useUiStore.getState().setTaskExpanded(result.id!, false);
            useUiStore.getState().setEditingTaskId(result.id!);
        });
    } catch (error) {
        reportError('Failed to duplicate task', error);
        useUiStore.getState().showToast(t('task.duplicateFailed'), 'error');
    }
}


export function useTaskQuickActionMenuProps(
    task: Task,
    overrides?: TaskQuickActionMenuOverrides,
): Omit<TaskQuickActionMenuProps, 'x' | 'y' | 'onClose'> {
    const { t, language } = useLanguage();
    const { areas, projects, sections, settings, tasks } = useTaskStore(
        (state) => ({ areas: state.areas, projects: state.projects, sections: state.sections, settings: state.settings, tasks: state.tasks }),
        shallow,
    );
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


    const { allContexts, popularContextOptions } = useTaskItemProjectContext({
        task,
        sections,
        isEditing: false,
        loadTokenOptions: true,
        editProjectId: '',
        setField: NOOP_SET_DRAFT_FIELD,
    });

    const readOnly = overrides?.readOnly ?? task.status === 'done';

    const onCreateArea = useCallback(async (name: string) => {
        const trimmed = name.trim();
        if (!trimmed) return null;
        const existing = areas.find((area) => area.name.toLowerCase() === trimmed.toLowerCase());
        if (existing) return existing.id;
        const created = await useTaskStore.getState().addArea(trimmed, { color: DEFAULT_PROJECT_COLOR });
        return created?.id ?? null;
    }, [areas]);

    const onCreateProject = useCallback(async (title: string) => {
        const inheritedAreaId = task.projectId
            ? projects.find((project) => project.id === task.projectId)?.areaId
            : task.areaId;
        const activeAreaId = inheritedAreaId
            && areas.some((area) => area.id === inheritedAreaId && !area.deletedAt)
            ? inheritedAreaId
            : undefined;
        try {
            const created = await createBulkOrganizeProject(title, activeAreaId);
            if (!created) {
                useUiStore.getState().showToast(
                    tFallback(t, 'projects.createFailed', 'Failed to create project'),
                    'error',
                );
                return null;
            }
            void logInfo('Task menu project creation saved', {
                scope: 'project',
                extra: {
                    outcome: 'created',
                },
            }).catch((error) => reportError('Failed to log task-menu project creation', error));
            return created.id;
        } catch (error) {
            reportError('Failed to create project from task quick actions', error);
            useUiStore.getState().showToast(
                tFallback(t, 'projects.createFailed', 'Failed to create project'),
                'error',
            );
            return null;
        }
    }, [areas, projects, t, task.areaId, task.projectId]);

    const onUpdateTask = useCallback(
        (updates: Partial<Task>, base?: Task) => (base
            ? updateTaskFromDraft(task.id, base, updates)
            : useTaskStore.getState().updateTask(task.id, updates)),
        [task.id],
    );

    const onDuplicate = useCallback(
        () => duplicateTaskAndReveal(task, { t }),
        [t, task],
    );

    const onDelete = useCallback(() => {
        deleteTaskWithUndo(task.id, { t, onBeforeDelete: overrides?.onBeforeDelete });
    }, [overrides?.onBeforeDelete, t, task.id]);

    const checklistMove = useMemo(() => (readOnly || !canMoveTaskToChecklist(task, resolveQuickCaptureDefaultAreaId(useTaskStore.getState().settings, useTaskStore.getState().areas)) ? undefined : {
        tasks,
        onSelect: (targetId: string) => { void moveTaskToChecklistWithUndo(task.id, targetId, { t }); },
    }), [readOnly, t, task, tasks]);

    const cancelAction = useMemo(() => {
        if (readOnly || !isTaskActionable(task) || isProjectedRecurringTask(task)) return [];
        return [
            ...(canSkipRecurringTaskOccurrence(task) ? [{
                id: 'skip-recurring-occurrence',
                label: tFallback(t, 'task.skipOccurrence', 'Skip this occurrence'),
                onSelect: async () => {
                    try {
                        const result = await useTaskStore.getState().skipRecurringTaskOccurrence(task.id);
                        if (!result.success) {
                            useUiStore.getState().showToast(
                                result.error || tFallback(t, 'task.skipOccurrenceFailed', 'Failed to skip occurrence'),
                                'error',
                            );
                        }
                    } catch (error) {
                        reportError('Failed to skip recurring occurrence', error);
                        useUiStore.getState().showToast(
                            tFallback(t, 'task.skipOccurrenceFailed', 'Failed to skip occurrence'),
                            'error',
                        );
                    }
                },
            }] : []), {
            id: 'cancel-task',
            label: task.recurrence
                ? tFallback(t, 'task.cancelRecurringSeries', 'Cancel recurring series')
                : tFallback(t, 'task.cancel', 'Cancel task'),
            onSelect: async () => {
                const before = useTaskStore.getState()._tasksById.get(task.id) ?? task;
                let cancellationInFlight = false;
                const attempt = async () => {
                    if (cancellationInFlight) return;
                    cancellationInFlight = true;
                    try {
                        const result = await useTaskStore.getState().cancelTask(task.id);
                        if (!result.success) throw new Error(result.error || tFallback(t, 'task.cancelFailed', 'Failed to cancel task'));
                        const cancelledAt = useTaskStore.getState()._tasksById.get(task.id)?.cancelledAt;
                        const undoCancellation = createTaskCancellationUndo(before, cancelledAt);
                        const restore = async () => {
                            const outcome = await undoCancellation();
                            if (outcome.success) return;
                            reportError('Failed to undo task cancellation', new Error(outcome.error || 'Cancellation was superseded'));
                            useUiStore.getState().showToast(
                                outcome.error || tFallback(t, 'task.updateFailed', 'Could not update task.'),
                                'error',
                                5000,
                                outcome.retryable
                                    ? { label: tFallback(t, 'common.undo', 'Undo'), onClick: registerUndoableAction(() => { void restore(); }) }
                                    : undefined,
                            );
                        };
                        const undo = registerUndoableAction(() => { void restore(); });
                        useUiStore.getState().showToast(
                            tFallback(t, 'task.cancelledWithRestore', 'Task cancelled. You can restore it from Archive.'),
                            'info',
                            5000,
                            useTaskStore.getState().settings?.undoNotificationsEnabled === false
                                ? undefined
                                : { label: tFallback(t, 'common.undo', 'Undo'), onClick: undo },
                        );
                    } catch (error) {
                        reportError('Failed to cancel task', error);
                        useUiStore.getState().showToast(
                            error instanceof Error ? error.message : tFallback(t, 'task.cancelFailed', 'Failed to cancel task'),
                            'error',
                            5000,
                            useTaskStore.getState()._tasksById.has(task.id)
                                ? { label: tFallback(t, 'common.retry', 'Try again'), onClick: () => { void attempt(); } }
                                : undefined,
                        );
                    } finally {
                        cancellationInFlight = false;
                    }
                };
                await attempt();
            },
        }];
    }, [readOnly, t, task]);


    const defaultOnStatusChange = useCallback((nextStatus: TaskStatus) => {
        if (task.status === nextStatus) return;
        const previousStatus = task.status;
        const wasFocusedToday = task.isFocusedToday === true;
        void useTaskStore.getState().moveTask(task.id, nextStatus)
            .then((result) => {
                if (!result.success) {
                    throw new Error(result.error || 'Failed to change task status');
                }
                const undo = registerUndoableAction(() => {
                    if (nextStatus === 'done') {
                        void undoTaskCompletion(task.id, previousStatus, wasFocusedToday)
                            .catch((error) => reportError('Failed to undo task status change', error));
                        return;
                    }
                    void useTaskStore.getState().moveTask(task.id, previousStatus)
                        .catch((error) => reportError('Failed to undo task status change', error));
                });
                if (useTaskStore.getState().settings?.undoNotificationsEnabled === false) return;
                useUiStore.getState().showToast(
                    nextStatus === 'done'
                        ? formatTaskMarkedDoneMessage(t, task.title)
                        : formatTaskMovedMessage(t, task.title, nextStatus),
                    'info',
                    5000,
                    {
                        label: tFallback(t, 'common.undo', 'Undo'),
                        onClick: undo,
                    },
                );
            })
            .catch((error) => reportError('Failed to change task status', error));
    }, [t, task.id, task.isFocusedToday, task.status, task.title]);

    return {
        task,
        t,
        dateFormatSetting: settings?.dateFormat,
        nativeDateInputLocale,
        contextOptions: popularContextOptions,
        contextSuggestions: allContexts,
        areas,
        projects,
        sections,
        readOnly,
        prioritiesEnabled: resolveFeatureFlags(settings).priorities,
        focusAction: overrides?.focusAction,
        onRename: overrides?.onRename,
        onDuplicate,
        onDelete,
        onStatusChange: overrides?.onStatusChange ?? defaultOnStatusChange,
        onCreateArea,
        onCreateProject,
        onUpdateTask,
        checklistMove,
        extraActions: [...cancelAction, ...(overrides?.extraActions ?? [])],
    };
}

type TaskQuickActionMenuHostProps = {
    task: Task;
    x: number;
    y: number;
    onClose: () => void;
    overrides?: TaskQuickActionMenuOverrides;
};


export function TaskQuickActionMenuHost({ task, x, y, onClose, overrides }: TaskQuickActionMenuHostProps) {
    const props = useTaskQuickActionMenuProps(task, overrides);


    return createElement(TaskQuickActionMenu, { ...props, x, y, onClose });
}
