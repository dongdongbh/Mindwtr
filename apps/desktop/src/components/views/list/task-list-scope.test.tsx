import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskStore } from '@mindwtr/core';
import type { Task } from '@mindwtr/core';

import { useUiStore } from '../../../store/ui-store';
import { takeUndoableAction, clearUndoableAction } from '../../../lib/undo-registry';
import { createTaskListScope, type TaskListScopeDeps } from './task-list-scope';

type ShowToast = ReturnType<typeof useUiStore.getState>['showToast'];

const makeTask = (id: string, overrides: Partial<Task> = {}): Task => ({
    id,
    title: `Task ${id}`,
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
} as Task);

// The row markup every registered view renders through TaskItem: a done button
// first in document order, then the title toggle, the edit trigger and the
// quick-actions trigger.
const mountRows = (tasks: Task[]) => {
    const main = document.createElement('div');
    main.setAttribute('data-main-content', '');
    for (const task of tasks) {
        const row = document.createElement('div');
        row.setAttribute('data-task-id', task.id);
        const done = document.createElement('button');
        done.setAttribute('data-done-button', '');
        const toggle = document.createElement('button');
        toggle.setAttribute('data-task-view-toggle', '');
        const edit = document.createElement('button');
        edit.setAttribute('data-task-edit-trigger', '');
        const quickActions = document.createElement('button');
        quickActions.setAttribute('data-task-quick-actions-trigger', '');
        row.append(done, toggle, edit, quickActions);
        main.appendChild(row);
    }
    document.body.appendChild(main);
};

const rowControl = (taskId: string, selector: string) =>
    document.querySelector<HTMLElement>(`[data-task-id="${taskId}"] ${selector}`);

// A stand-in non-English locale: every user-visible string the scope produces
// must come out of it, so an untranslated copy fails loudly.
const LOCALE: Record<string, string> = {
    'task.markedDone': '{title} ERLEDIGT',
    'task.movedToStatus': '{{title}} nach {{status}}',
    'status.next': 'NAECHSTE',
    'status.someday': 'IRGENDWANN',
    'list.taskDeleted': 'GELOESCHT',
    'common.undo': 'RUECKGAENGIG',
};
const translate = (key: string) => LOCALE[key] ?? key;

// Every registered view supplies one of these two dependency shapes: the views
// that let the scope own scroll/focus (Focus, Board, Projects, Search,
// Contexts, Review) and ListView, which keeps its virtualization-aware scroll
// and its own #890 focus hook. Both must behave identically.
type ScopeCase = {
    name: string;
    extraDeps: (state: { tasks: Task[]; index: () => number }) => Partial<TaskListScopeDeps>;
};

const SCOPE_CASES: ScopeCase[] = [
    {
        name: 'view-owned selection (Focus, Board, Projects, Search, Contexts, Review)',
        extraDeps: () => ({}),
    },
    {
        name: 'list-owned scroll and focus (ListView)',
        extraDeps: ({ tasks, index }) => ({
            revealSelected: (task) => {
                rowControl(task.id, '[data-task-view-toggle]')?.focus();
            },
            focusSelected: () => {
                const task = tasks[index()];
                if (!task) return false;
                rowControl(task.id, '[data-task-view-toggle]')?.focus();
                return true;
            },
        }),
    },
];

const setStore = (overrides: Record<string, unknown>) => {
    useTaskStore.setState((state) => ({ ...state, ...overrides } as never));
};

let showToast = vi.fn<ShowToast>();
const firstToastAction = () => {
    const action = showToast.mock.calls[0]?.[3];
    if (!action) throw new Error('Expected the first toast to include an action');
    return action;
};

beforeEach(() => {
    clearUndoableAction();
    showToast = vi.fn<ShowToast>();
    useUiStore.setState({ showToast });
    useTaskStore.setState((state) => ({
        settings: { ...state.settings, undoNotificationsEnabled: true },
    }));
});

afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
});

describe.each(SCOPE_CASES)('createTaskListScope — $name', ({ extraDeps }) => {
    let tasks: Task[];
    let selectedIndex: number;

    const build = (overrides: Partial<TaskListScopeDeps> = {}) => {
        const index = () => selectedIndex;
        return createTaskListScope({
            getTasks: () => tasks,
            getSelectedIndex: index,
            setSelectedIndex: (next) => { selectedIndex = next; },
            t: translate,
            ...extraDeps({ tasks, index }),
            ...overrides,
        });
    };

    beforeEach(() => {
        tasks = [makeTask('1'), makeTask('2'), makeTask('3')];
        selectedIndex = 0;
        mountRows(tasks);
    });

    it('walks the visible task array with j/k and clamps at both ends', () => {
        const scope = build();

        scope.selectNext();
        expect(selectedIndex).toBe(1);
        scope.selectNext();
        scope.selectNext();
        expect(selectedIndex).toBe(2);

        scope.selectPrev();
        expect(selectedIndex).toBe(1);
        scope.selectFirst();
        expect(selectedIndex).toBe(0);
        scope.selectPrev();
        expect(selectedIndex).toBe(0);
        scope.selectLast();
        expect(selectedIndex).toBe(2);
    });

    it('focuses the title toggle, not the done button, when navigation reveals a row', () => {
        const scope = build();

        scope.selectNext();

        expect(document.activeElement).toBe(rowControl('2', '[data-task-view-toggle]'));
    });

    it('does nothing when the visible list is empty', () => {
        tasks = [];
        const scope = build();

        scope.selectNext();
        scope.selectLast();
        scope.toggleDoneSelected();

        expect(scope.focusSelected?.()).toBe(false);
    });

    it('opens, edits and opens quick actions on the selected task', () => {
        const scope = build();
        const edit = rowControl('1', '[data-task-edit-trigger]')!;
        const toggle = rowControl('1', '[data-task-view-toggle]')!;
        const quickActions = rowControl('1', '[data-task-quick-actions-trigger]')!;
        const editClick = vi.fn();
        const toggleClick = vi.fn();
        const quickActionsClick = vi.fn();
        edit.addEventListener('click', editClick);
        toggle.addEventListener('click', toggleClick);
        quickActions.addEventListener('click', quickActionsClick);

        scope.editSelected();
        scope.openSelected?.();
        scope.openQuickActions?.();

        expect(editClick).toHaveBeenCalledTimes(1);
        expect(toggleClick).toHaveBeenCalledTimes(1);
        expect(quickActionsClick).toHaveBeenCalledTimes(1);
    });

    it('navigates then edits the newly selected task', () => {
        const scope = build();
        const editTask2 = vi.fn();
        rowControl('2', '[data-task-edit-trigger]')!.addEventListener('click', editTask2);
        const editTask1 = vi.fn();
        rowControl('1', '[data-task-edit-trigger]')!.addEventListener('click', editTask1);

        scope.selectNext();
        scope.editSelected();
        expect(editTask2).toHaveBeenCalledTimes(1);

        scope.selectFirst();
        scope.editSelected();
        expect(editTask1).toHaveBeenCalledTimes(1);
    });

    it('falls back to the first clickable control when a row has no edit trigger', () => {
        document.body.innerHTML = '';
        const main = document.createElement('div');
        main.setAttribute('data-main-content', '');
        const row = document.createElement('div');
        row.setAttribute('data-task-id', '1');
        const open = document.createElement('button');
        row.appendChild(open);
        main.appendChild(row);
        document.body.appendChild(main);
        const openClick = vi.fn();
        open.addEventListener('click', openClick);

        build().editSelected();

        expect(openClick).toHaveBeenCalledTimes(1);
    });

    it('acts on the row DOM focus sits in, not a stale selection index', () => {
        const scope = build();
        const moveTask = vi.fn(async () => ({ success: true }));
        setStore({ moveTask });

        rowControl('3', '[data-task-view-toggle]')!.focus();
        scope.toggleDoneSelected();

        expect(moveTask).toHaveBeenCalledWith('3', 'done');
        expect(selectedIndex).toBe(2);
    });

    it('marks the selected task done with a translated toast and an undo', async () => {
        const moveTask = vi.fn(async () => ({ success: true }));
        setStore({ moveTask });
        const scope = build();

        scope.toggleDoneSelected();

        await vi.waitFor(() => expect(moveTask).toHaveBeenCalledWith('1', 'done'));
        expect(showToast).toHaveBeenCalledWith(
            'Task 1 ERLEDIGT',
            'info',
            5000,
            // The "Undo" label resolves through the caller's translator, so the
            // injected stand-in locale governs it like every other string here.
            expect.objectContaining({ label: 'RUECKGAENGIG' }),
        );
        expect(takeUndoableAction()).toEqual(expect.any(Function));
    });

    it('does not toast when a task that was already done is toggled back', async () => {
        tasks = [makeTask('1', { status: 'done' })];
        const moveTask = vi.fn(async () => ({ success: true }));
        setStore({ moveTask });
        const scope = build();

        scope.toggleDoneSelected();

        await vi.waitFor(() => expect(moveTask).toHaveBeenCalledWith('1', 'inbox'));
        expect(showToast).not.toHaveBeenCalled();
    });

    it('does not report success when moveTask fails', async () => {
        const moveTask = vi.fn(async () => ({ success: false, error: 'nope' }));
        setStore({ moveTask });
        const scope = build();

        scope.toggleDoneSelected();

        await vi.waitFor(() => expect(moveTask).toHaveBeenCalled());
        await Promise.resolve();
        const successToasts = showToast.mock.calls.filter(([, tone]) => tone === 'info');
        expect(successToasts).toHaveLength(0);
    });

    it('does not report success when the status chord move fails', async () => {
        const moveTask = vi.fn(async () => ({ success: false, error: 'nope' }));
        setStore({ moveTask });
        const scope = build();

        scope.setStatusSelected?.('someday');

        await vi.waitFor(() => expect(moveTask).toHaveBeenCalledWith('1', 'someday'));
        await Promise.resolve();
        const successToasts = showToast.mock.calls.filter(([, tone]) => tone === 'info');
        expect(successToasts).toHaveLength(0);
    });

    it('moves the selected task with the status chord and undoes back to the previous status', async () => {
        const moveTask = vi.fn(async () => ({ success: true }));
        setStore({ moveTask });
        const scope = build();

        scope.setStatusSelected?.('someday');

        await vi.waitFor(() => expect(moveTask).toHaveBeenCalledWith('1', 'someday'));
        expect(showToast).toHaveBeenCalledWith(
            'Task 1 nach IRGENDWANN',
            'info',
            5000,
            expect.objectContaining({ label: 'RUECKGAENGIG' }),
        );

        firstToastAction().onClick();
        expect(moveTask).toHaveBeenCalledWith('1', 'next');
    });

    it('ignores the status chord when the task is already in that status', () => {
        const moveTask = vi.fn(async () => ({ success: true }));
        setStore({ moveTask });

        build().setStatusSelected?.('next');

        expect(moveTask).not.toHaveBeenCalled();
    });

    it('deletes the selected task and offers an undo that restores it', async () => {
        const deleteTask = vi.fn(async () => ({ success: true }));
        const restoreTask = vi.fn(async () => ({ success: true }));
        setStore({ deleteTask, restoreTask });
        const scope = build();

        scope.deleteSelected();

        await vi.waitFor(() => expect(deleteTask).toHaveBeenCalledWith('1'));
        expect(showToast).toHaveBeenCalledWith(
            'GELOESCHT',
            'info',
            5000,
            expect.objectContaining({ label: 'RUECKGAENGIG' }),
        );

        firstToastAction().onClick();
        expect(restoreTask).toHaveBeenCalledWith('1');
    });

    // Disabling undo toasts hides the toast, not Ctrl/Cmd+Z: registration is
    // unconditional, so the shortcut still has something to undo.
    it('registers the undo even when undo toasts are disabled', async () => {
        const deleteTask = vi.fn(async () => ({ success: true }));
        const restoreTask = vi.fn(async () => ({ success: true }));
        setStore({ deleteTask, restoreTask });
        useTaskStore.setState((state) => ({
            settings: { ...state.settings, undoNotificationsEnabled: false },
        }));
        const scope = build();

        scope.deleteSelected();

        await vi.waitFor(() => expect(deleteTask).toHaveBeenCalledWith('1'));
        expect(showToast).not.toHaveBeenCalled();

        takeUndoableAction()?.();
        expect(restoreTask).toHaveBeenCalledWith('1');
    });

    it('does not report success when deleteTask fails', async () => {
        const deleteTask = vi.fn(async () => ({ success: false, error: 'nope' }));
        setStore({ deleteTask });
        const scope = build();

        scope.deleteSelected();

        await vi.waitFor(() => expect(deleteTask).toHaveBeenCalled());
        await Promise.resolve();
        const successToasts = showToast.mock.calls.filter(([, tone]) => tone === 'info');
        expect(successToasts).toHaveLength(0);
    });

    it('toggles multi-select on the selected task when the view wires it', () => {
        const toggleSelect = vi.fn();
        const scope = build({ toggleSelect });

        scope.selectNext();
        scope.toggleSelectSelected?.();

        expect(toggleSelect).toHaveBeenCalledWith(expect.objectContaining({ id: '2' }));
    });

    it('requests the row focus/rename actions on the selected task', () => {
        const scope = build();
        const events: string[] = [];
        document.querySelector('[data-task-id="1"]')!
            .addEventListener('mindwtr:task-row-action', (event) => {
                events.push((event as CustomEvent<string>).detail);
            });

        scope.toggleFocusSelected?.();
        scope.renameSelected?.();

        expect(events).toEqual(['toggle-focus', 'rename-title']);
    });

    it('focuses the add-task input only when the view has one', () => {
        const input = document.createElement('input');
        document.body.appendChild(input);

        expect(build().focusAddInput?.()).toBe(false);
        expect(build({ addInputRef: { current: input } }).focusAddInput?.()).toBe(true);
        expect(document.activeElement).toBe(input);
    });

    it('reveals the selected task when the list is entered from the sidebar', () => {
        const scope = build();

        expect(scope.focusSelected?.()).toBe(true);
        expect(document.activeElement).toBe(rowControl('1', '[data-task-view-toggle]'));
    });
});
