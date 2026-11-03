import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { formatTaskMarkedDoneMessage, formatTaskMovedMessage, translateWithFallback, useTaskStore } from '@mindwtr/core';
import type { StoreActionResult, Task, TaskStatus } from '@mindwtr/core';

import { useOptionalKeybindings, type TaskListScope } from '../../../contexts/keybinding-context';
import { reportError } from '../../../lib/report-error';
import { showUndoToast } from '../../../lib/undo-registry';
import { undoTaskCompletion } from '../../../lib/undo-task-completion';
import { requestTaskRowAction, type TaskRowAction } from '../../../lib/task-row-actions';
import { copyTaskTitles } from '../../../lib/task-clipboard';

type TranslateFn = (key: string) => string;

export type TaskListScopeDeps = {

    getTasks: () => Task[];
    getSelectedIndex: () => number;
    getSelectedIds?: () => ReadonlySet<string> | undefined;
    getHighlightedTaskId?: () => string | undefined;
    setSelectedIndex: (index: number) => void;
    t: TranslateFn;
    addInputRef?: RefObject<HTMLElement | null>;


    revealSelected?: (task: Task) => void;

    focusSelected?: () => boolean;

    toggleSelect?: (task: Task) => void;
};

function findTaskRow(taskId: string): HTMLElement | null {
    if (typeof document === 'undefined') return null;
    return document.querySelector<HTMLElement>(`[data-task-id="${taskId}"]`);
}


function getFocusedTaskId(): string | null {
    if (typeof document === 'undefined') return null;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return null;
    return active.closest<HTMLElement>('[data-task-id]')?.dataset.taskId ?? null;
}

const FOCUSABLE_ROW_SELECTOR = 'button, [tabindex]:not([tabindex="-1"])';

function focusTaskRowControl(row: HTMLElement): void {


    const focusTarget = row.querySelector<HTMLElement>('[data-task-view-toggle]')
        ?? row.querySelector<HTMLElement>(FOCUSABLE_ROW_SELECTOR)
        ?? (row.matches(FOCUSABLE_ROW_SELECTOR) ? row : null);
    focusTarget?.focus();
}

function revealTaskRow(taskId: string): void {
    const row = findTaskRow(taskId);
    if (!row) return;
    row.scrollIntoView?.({ block: 'nearest' });
    focusTaskRowControl(row);
}


export function focusTaskRowWhenMounted(taskId: string, signal?: AbortSignal): void {
    if (typeof document === 'undefined' || signal?.aborted) return;
    let attempts = 0;
    const tryFocus = () => {
        if (signal?.aborted) return;
        const active = document.activeElement;
        if (
            active instanceof HTMLElement
            && active.closest('input, textarea, select, [contenteditable="true"]')
        ) return;
        const row = findTaskRow(taskId);
        if (row) {
            focusTaskRowControl(row);
            return;
        }
        if (attempts >= 8) return;
        attempts += 1;
        window.setTimeout(tryFocus, 50);
    };
    tryFocus();
}


function assertStoreActionSucceeded(result: unknown, fallbackMessage: string): void {
    const outcome = result as StoreActionResult | undefined;
    if (outcome && outcome.success === false) {
        throw new Error(outcome.error || fallbackMessage);
    }
}

export function createTaskListScope(deps: TaskListScopeDeps): TaskListScope {
    const translate = (key: string, fallback: string) => translateWithFallback(deps.t, key, fallback);


    const resolveIndex = (tasks: Task[]): number => {
        if (tasks.length === 0) return -1;
        const focusedId = getFocusedTaskId();
        const focusedIndex = focusedId ? tasks.findIndex((task) => task.id === focusedId) : -1;
        const index = focusedIndex >= 0
            ? focusedIndex
            : Math.min(Math.max(deps.getSelectedIndex(), 0), tasks.length - 1);
        if (index !== deps.getSelectedIndex()) deps.setSelectedIndex(index);
        return index;
    };

    const selectedTask = (): Task | null => {
        const tasks = deps.getTasks();
        const index = resolveIndex(tasks);
        return index < 0 ? null : tasks[index] ?? null;
    };

    const selectedRow = (): HTMLElement | null => {
        const task = selectedTask();
        return task ? findTaskRow(task.id) : null;
    };

    const reveal = (task: Task) => {
        if (deps.revealSelected) {
            deps.revealSelected(task);
            return;
        }
        revealTaskRow(task.id);
    };

    const move = (resolveNext: (index: number, count: number) => number) => {
        const tasks = deps.getTasks();
        const index = resolveIndex(tasks);
        if (index < 0) return;
        const nextIndex = Math.min(Math.max(resolveNext(index, tasks.length), 0), tasks.length - 1);
        deps.setSelectedIndex(nextIndex);
        const task = tasks[nextIndex];
        if (task) reveal(task);
    };

    const requestRowAction = (action: TaskRowAction) => {
        requestTaskRowAction(selectedRow(), action);
    };

    return {
        kind: 'taskList',
        selectNext: () => move((index, count) => Math.min(index + 1, count - 1)),
        selectPrev: () => move((index) => index - 1),
        selectFirst: () => move(() => 0),
        selectLast: () => move((_index, count) => count - 1),
        editSelected: () => {
            const row = selectedRow();
            if (!row) return;
            const trigger = row.matches('[data-task-edit-trigger]')
                ? row
                : row.querySelector<HTMLElement>('[data-task-edit-trigger]')
                    ?? row.querySelector<HTMLElement>('button, [role="button"], [tabindex]:not([tabindex="-1"])');
            if (!trigger) {
                row.click();
                return;
            }
            trigger.focus();
            trigger.click();
        },
        openSelected: () => {
            selectedRow()?.querySelector<HTMLElement>('[data-task-view-toggle]')?.click();
        },
        openQuickActions: () => {
            const trigger = selectedRow()?.querySelector<HTMLElement>('[data-task-quick-actions-trigger]');
            if (!trigger) return;
            trigger.focus();
            trigger.click();
        },
        toggleDoneSelected: () => {
            const task = selectedTask();
            if (!task) return;
            const previousStatus = task.status;
            const nextStatus: TaskStatus = previousStatus === 'done' ? 'inbox' : 'done';
            const wasFocusedToday = task.isFocusedToday === true;
            void Promise.resolve(useTaskStore.getState().moveTask(task.id, nextStatus))
                .then((result) => {
                    assertStoreActionSucceeded(result, 'Failed to change task status');
                    if (nextStatus !== 'done' || previousStatus === 'done') return;
                    showUndoToast(formatTaskMarkedDoneMessage(deps.t, task.title), () => {
                        void undoTaskCompletion(task.id, previousStatus, wasFocusedToday)
                            .catch((error) => reportError('Failed to undo task completion', error));
                    }, deps.t);
                })
                .catch((error) => reportError('Failed to change task status', error));
        },
        toggleSelectSelected: () => {
            const task = selectedTask();
            if (!task) return;
            deps.toggleSelect?.(task);
        },
        copySelected: (includeDescription, requireHighlight = false) => {
            const selectedIds = includeDescription ? undefined : deps.getSelectedIds?.();
            const seenIds = new Set<string>();
            const highlightedId = requireHighlight ? getFocusedTaskId() ?? deps.getHighlightedTaskId?.() : undefined;
            const selected = selectedIds?.size ? undefined : requireHighlight
                ? deps.getTasks().find((task) => task.id === highlightedId)
                : selectedTask();
            const tasks = selectedIds?.size
                ? deps.getTasks().filter((task) => {
                    if (!selectedIds.has(task.id) || seenIds.has(task.id)) return false;
                    seenIds.add(task.id);
                    return true;
                })
                : selected ? [selected] : [];
            if (tasks.length === 0) return false;
            void copyTaskTitles(tasks, deps.t, includeDescription);
            return true;
        },
        toggleFocusSelected: () => requestRowAction('toggle-focus'),
        renameSelected: () => requestRowAction('rename-title'),
        deleteSelected: () => {
            const task = selectedTask();
            if (!task) return;
            void Promise.resolve(useTaskStore.getState().deleteTask(task.id))
                .then((result) => {
                    assertStoreActionSucceeded(result, 'Failed to delete task');
                    showUndoToast(translate('list.taskDeleted', 'Task deleted'), () => {
                        void useTaskStore.getState().restoreTask(task.id);
                    }, deps.t);
                })
                .catch((error) => reportError('Failed to delete task', error));
        },


        setStatusSelected: (status: TaskStatus) => {
            const task = selectedTask();
            if (!task || task.status === status) return;
            const previousStatus = task.status;
            const wasFocusedToday = task.isFocusedToday === true;
            void Promise.resolve(useTaskStore.getState().moveTask(task.id, status))
                .then((result) => {
                    assertStoreActionSucceeded(result, 'Failed to change task status');
                    showUndoToast(
                        status === 'done'
                            ? formatTaskMarkedDoneMessage(deps.t, task.title)
                            : formatTaskMovedMessage(deps.t, task.title, status),
                        () => {


                            if (status === 'done') {
                                void undoTaskCompletion(task.id, previousStatus, wasFocusedToday)
                                    .catch((error) => reportError('Failed to undo task status change', error));
                                return;
                            }
                            void useTaskStore.getState().moveTask(task.id, previousStatus)
                                .catch((error) => reportError('Failed to undo task status change', error));
                        },
                        deps.t,
                    );
                })
                .catch((error) => reportError('Failed to change task status', error));
        },
        focusAddInput: () => {
            const input = deps.addInputRef?.current;
            if (!input) return false;
            input.focus();
            return true;
        },
        focusSelected: () => {
            if (deps.focusSelected) return deps.focusSelected();
            const task = selectedTask();
            if (!task) return false;
            reveal(task);
            return true;
        },
    };
}


export function useRegisteredTaskListScope(
    register: (scope: TaskListScope | null) => void,
    deps: TaskListScopeDeps & { enabled?: boolean },
): void {
    const depsRef = useRef(deps);
    depsRef.current = deps;
    const enabled = deps.enabled !== false;

    const scope = useMemo(() => createTaskListScope({
        getTasks: () => depsRef.current.getTasks(),
        getSelectedIndex: () => depsRef.current.getSelectedIndex(),
        getSelectedIds: () => depsRef.current.getSelectedIds?.(),
        getHighlightedTaskId: () => depsRef.current.getHighlightedTaskId?.(),
        setSelectedIndex: (index) => depsRef.current.setSelectedIndex(index),
        t: (key) => depsRef.current.t(key),
        addInputRef: depsRef.current.addInputRef,
        revealSelected: depsRef.current.revealSelected && ((task) => depsRef.current.revealSelected?.(task)),
        focusSelected: depsRef.current.focusSelected && (() => depsRef.current.focusSelected?.() ?? false),
        toggleSelect: depsRef.current.toggleSelect && ((task) => depsRef.current.toggleSelect?.(task)),
    }), []);

    useEffect(() => {
        if (!enabled) return;
        register(scope);
        return () => register(null);
    }, [enabled, register, scope]);
}

const NO_KEYBINDING_REGISTRAR = () => {};


export function useTaskListScope(deps: TaskListScopeDeps & { enabled?: boolean }): void {
    const keybindings = useOptionalKeybindings();
    useRegisteredTaskListScope(keybindings?.registerTaskListScope ?? NO_KEYBINDING_REGISTRAR, deps);
}
