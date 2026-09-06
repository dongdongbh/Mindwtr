import { createElement, useCallback, useMemo } from 'react';
import {
    DEFAULT_PROJECT_COLOR,
    isTaskFinished,
    normalizeWeekStartSetting,
    resolveFeatureFlags,
    shallow,
    tFallback,
    useTaskStore,
    type Section,
    type Task,
    type TaskDraftSetter,
    type TaskStatus,
} from '@mindwtr/core';

import { useLanguage } from '../../contexts/language-context';
import { dispatchNavigateEvent } from '../../lib/navigation-events';
import { resolveNativeDateInputLocale } from '../../lib/native-date-input-locale';
import { reportError } from '../../lib/report-error';
import { registerUndoableAction } from '../../lib/undo-registry';
import { undoTaskCompletion } from '../../lib/undo-task-completion';
import { useUiStore } from '../../store/ui-store';
import { formatTaskMarkedDoneMessage, formatTaskMovedMessage } from '@mindwtr/core';
import { TaskQuickActionMenu, type TaskQuickActionMenuProps } from './TaskQuickActionMenu';
import { useTaskItemProjectContext } from './useTaskItemProjectContext';

const EMPTY_SECTIONS: Section[] = [];
const NOOP_SET_DRAFT_FIELD: TaskDraftSetter = () => {};

export type TaskQuickActionMenuOverrides = {
    readOnly?: boolean;
    onRename?: () => void;
    onPromoteToProject?: () => void;
    onConvertToSection?: () => void;
    focusAction?: TaskQuickActionMenuProps['focusAction'];
    /** Runs before the default delete; the row uses it to close its edit session. */
    onBeforeDelete?: () => void;
    /** Fully replaces the default status change (the row intercepts 'waiting'). */
    onStatusChange?: (status: TaskStatus) => void;
    /** Extra entries rendered above Delete. The calendar passes "Remove from calendar". */
    extraActions?: Array<{
        id: string;
        label: string;
        onSelect: () => void;
    }>;
};

// Single delete-with-undo implementation for every quick-action-menu surface:
// the menu's own default (calendar) and the row's other delete entry points
// (editor, display actions) all call this instead of hand-rolling the same
// registerUndoableAction + toast pattern (see task-list-scope.ts's canonical
// version, which this mirrors).
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
        // task.aria.delete is "Delete task" (an aria label for the button, an
        // imperative), not a completion message — list.taskDeleted is the key
        // task-list-scope.ts uses for this same toast.
        tFallback(t, 'list.taskDeleted', 'Task deleted'),
        'info',
        5000,
        {
            label: tFallback(t, 'common.undo', 'Undo'),
            onClick: undo,
        },
    );
}

/**
 * Single duplicate implementation for every surface that offers it: the row's
 * hover button, the row menu, and the calendar menu.
 *
 * Deliberately NOT gated on read-only. Duplicating never touches the source
 * task — it writes a new one — and the row only renders its Duplicate button on
 * read-only (done/archived) rows, so a read-only guard made the button dead in
 * the one place it appears (#950).
 */
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
        useTaskStore.getState().setHighlightTask(result.id);
        if (task.projectId) {
            useUiStore.getState().setProjectView({ selectedProjectId: task.projectId });
            dispatchNavigateEvent('projects');
        } else if (isTaskFinished(task)) {
            // The copy goes to the Inbox to be re-clarified, so it is never in the
            // Done/Archived list it was made from. Without this the duplicate
            // succeeds somewhere the user cannot see and the click reads as a
            // no-op (#950).
            dispatchNavigateEvent('inbox');
        }
        useUiStore.getState().setTaskExpanded(result.id, false);
        useUiStore.getState().setEditingTaskId(result.id);
    } catch (error) {
        reportError('Failed to duplicate task', error);
        useUiStore.getState().showToast(t('task.duplicateFailed'), 'error');
    }
}

/**
 * Builds the full prop bag for TaskQuickActionMenu from the store, with
 * override points for the handful of behaviours that differ by caller. Both
 * TaskItem's row menu and the calendar's block/chip menu render through this
 * so delete-with-undo and status-change logic exist in exactly one place.
 *
 * Only call this from a component that mounts while the menu is open (see
 * TaskQuickActionMenuHost below) — its data props are gated on that.
 */
export function useTaskQuickActionMenuProps(
    task: Task,
    overrides?: TaskQuickActionMenuOverrides,
): Omit<TaskQuickActionMenuProps, 'x' | 'y' | 'onClose'> {
    const { t, language } = useLanguage();
    const { areas, projects, settings } = useTaskStore(
        (state) => ({ areas: state.areas, projects: state.projects, settings: state.settings }),
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
    // The context token list is task-independent (it's every token used across
    // all tasks), so reuse TaskItem's own project-context hook rather than a
    // second copy of the token-collection/prefixing logic.
    const { allContexts, popularContextOptions } = useTaskItemProjectContext({
        task,
        sections: EMPTY_SECTIONS,
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

    const onUpdateTask = useCallback(
        (updates: Partial<Task>) => useTaskStore.getState().updateTask(task.id, updates),
        [task.id],
    );

    const onDuplicate = useCallback(
        () => duplicateTaskAndReveal(task, { t }),
        [t, task],
    );

    const onDelete = useCallback(() => {
        deleteTaskWithUndo(task.id, { t, onBeforeDelete: overrides?.onBeforeDelete });
    }, [overrides?.onBeforeDelete, t, task.id]);

    // Canonical store-level status change (task-list-scope.ts's setStatusSelected
    // pattern): move + undo + the shared moved/marked-done toast text. Callers
    // with row-specific behaviour (TaskItem's waiting-assignment prompt) replace
    // this outright via overrides.onStatusChange.
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
        readOnly,
        prioritiesEnabled: resolveFeatureFlags(settings).priorities,
        focusAction: overrides?.focusAction,
        onRename: overrides?.onRename,
        onDuplicate,
        onPromoteToProject: overrides?.onPromoteToProject,
        onConvertToSection: overrides?.onConvertToSection,
        onDelete,
        onStatusChange: overrides?.onStatusChange ?? defaultOnStatusChange,
        onCreateArea,
        onUpdateTask,
        extraActions: overrides?.extraActions,
    };
}

type TaskQuickActionMenuHostProps = {
    task: Task;
    x: number;
    y: number;
    onClose: () => void;
    overrides?: TaskQuickActionMenuOverrides;
};

// Mounts only while a menu is actually open (callers render it inside the same
// `quickActionMenu &&` guard that used to wrap TaskQuickActionMenu directly),
// so the hook's store reads only run then rather than on every row render.
export function TaskQuickActionMenuHost({ task, x, y, onClose, overrides }: TaskQuickActionMenuHostProps) {
    const props = useTaskQuickActionMenuProps(task, overrides);
    // createElement, not JSX: this file is .ts (no JSX parsing) so the hook and
    // its mount-gated host can live together without a second file.
    return createElement(TaskQuickActionMenu, { ...props, x, y, onClose });
}
