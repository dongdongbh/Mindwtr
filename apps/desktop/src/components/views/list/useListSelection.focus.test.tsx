import { act } from 'react';
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Task } from '@mindwtr/core';
import { useListSelection } from './useListSelection';

type Scope = {
    selectNext: () => void;
    selectPrev: () => void;
} | null;

const makeTask = (id: string): Task => ({
    id,
    title: `Task ${id}`,
    status: 'next',
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
} as Task);


const mountTaskRows = (tasks: Task[]): Map<string, HTMLButtonElement> => {
    const toggles = new Map<string, HTMLButtonElement>();
    for (const task of tasks) {
        const row = document.createElement('div');
        row.setAttribute('data-task-id', task.id);
        const toggle = document.createElement('button');
        toggle.setAttribute('data-task-view-toggle', '');
        row.appendChild(toggle);
        document.body.appendChild(row);
        toggles.set(task.id, toggle);
    }
    return toggles;
};

const renderListSelection = (
    filteredTasks: Task[],
    highlightTaskId: string | null = null,
    isProcessing = false,
) => {
    let scope: Scope = null;
    const registerTaskListScope = (next: unknown) => {
        scope = next as Scope;
    };
    const options = {
        activeNextGroupBy: 'none' as const,
        addInputRef: { current: null },
        batchDeleteTasks: vi.fn(),
        batchMoveTasks: vi.fn(),
        batchUpdateTasks: vi.fn(),
        deleteTask: vi.fn(),
        filteredTasks,
        highlightTaskId,
        isProcessing,
        moveTask: vi.fn(),
        prioritiesEnabled: false,
        registerTaskListScope,
        restoreTask: vi.fn(async () => ({ success: true }) as never),
        scrollToVirtualIndex: vi.fn(),
        selectedPriorities: [],
        selectedTimeEstimates: [],
        selectedTokens: [],
        selectedWaitingPerson: '',
        setHighlightTask: vi.fn(),
        shouldVirtualize: false,
        showToast: vi.fn(),
        statusFilter: 'all' as const,
        t: (key: string) => key,
        tasksById: new Map(filteredTasks.map((task) => [task.id, task])),
        timeEstimatesEnabled: false,
        translateWithFallback: (_key: string, fallback: string) => fallback,
        undoNotificationsEnabled: false,
    };
    const view = renderHook(() => useListSelection(options as never));
    return {
        getScope: () => scope,
        rerenderListSelection: (next: {
            filteredTasks?: Task[];
            highlightTaskId?: string | null;
            isProcessing?: boolean;
        }) => {
            if (next.filteredTasks) {
                options.filteredTasks = next.filteredTasks;
                options.tasksById = new Map(next.filteredTasks.map((task) => [task.id, task]));
            }
            if (next.highlightTaskId !== undefined) options.highlightTaskId = next.highlightTaskId;
            if (next.isProcessing !== undefined) options.isProcessing = next.isProcessing;
            view.rerender();
        },
        setHighlightTask: options.setHighlightTask,
        ...view,
    };
};

afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('useListSelection keyboard focus follows selection (#860)', () => {
    it('moves DOM focus to the next task toggle when a task toggle is focused', () => {
        const tasks = [makeTask('one'), makeTask('two')];
        const toggles = mountTaskRows(tasks);
        const { getScope } = renderListSelection(tasks);

        toggles.get('one')!.focus();
        expect(document.activeElement).toBe(toggles.get('one'));

        act(() => {
            getScope()!.selectNext();
        });

        expect(document.activeElement).toBe(toggles.get('two'));
    });

    it('does not move focus when the active element is not a task toggle', () => {
        const tasks = [makeTask('one'), makeTask('two')];
        const toggles = mountTaskRows(tasks);
        const { getScope } = renderListSelection(tasks);


        (document.activeElement as HTMLElement | null)?.blur?.();
        expect(document.activeElement === toggles.get('one')).toBe(false);
        expect(document.activeElement === toggles.get('two')).toBe(false);
        const before = document.activeElement;

        act(() => {
            getScope()!.selectNext();
        });

        expect(document.activeElement).toBe(before);
        expect(document.activeElement).not.toBe(toggles.get('two'));
    });
});

describe('highlight reveal moves keyboard focus (#1014)', () => {
    it('focuses the highlighted task row even when a stale row still holds focus', () => {
        const tasks = [makeTask('one'), makeTask('two')];
        const toggles = mountTaskRows(tasks);


        toggles.get('one')!.focus();

        renderListSelection(tasks, 'two');

        expect(document.activeElement).toBe(toggles.get('two'));
    });

    it('does not steal focus from a text field', () => {
        const tasks = [makeTask('one'), makeTask('two')];
        const toggles = mountTaskRows(tasks);
        const input = document.createElement('input');
        document.body.appendChild(input);
        input.focus();

        renderListSelection(tasks, 'two');

        expect(document.activeElement).toBe(input);
        expect(document.activeElement).not.toBe(toggles.get('two'));
    });

    it('does not scroll or focus a highlighted row during Inbox processing', () => {
        const tasks = [makeTask('one'), makeTask('two')];
        const toggles = mountTaskRows(tasks);
        const highlightedRow = toggles.get('two')!.closest<HTMLElement>('[data-task-id]')!;
        highlightedRow.scrollIntoView = vi.fn();
        toggles.get('one')!.focus();

        renderListSelection(tasks, 'two', true);

        expect(highlightedRow.scrollIntoView).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(toggles.get('one'));
    });

    it('cancels pending highlight scroll and focus retries when Inbox processing starts', () => {
        vi.useFakeTimers();
        const tasks = [makeTask('one')];
        const previousControl = document.createElement('button');
        document.body.appendChild(previousControl);
        previousControl.focus();
        const { rerenderListSelection } = renderListSelection(tasks, 'one');

        rerenderListSelection({ isProcessing: true });

        const toggles = mountTaskRows(tasks);
        const highlightedRow = toggles.get('one')!.closest<HTMLElement>('[data-task-id]')!;
        highlightedRow.scrollIntoView = vi.fn();
        act(() => vi.advanceTimersByTime(50));

        expect(highlightedRow.scrollIntoView).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(previousControl);
    });

    it('keeps a pending highlight focus retry across a harmless list refresh', () => {
        vi.useFakeTimers();
        const tasks = [makeTask('one')];
        const previousControl = document.createElement('button');
        document.body.appendChild(previousControl);
        previousControl.focus();
        const { rerenderListSelection } = renderListSelection(tasks, 'one');

        rerenderListSelection({ filteredTasks: [...tasks] });

        const toggles = mountTaskRows(tasks);
        act(() => vi.advanceTimersByTime(50));

        expect(document.activeElement).toBe(toggles.get('one'));
    });

    it('drops a selection-clamp scroll during processing instead of replaying it afterward', () => {
        const tasks = [makeTask('one'), makeTask('two')];
        const toggles = mountTaskRows(tasks);
        const firstRow = toggles.get('one')!.closest<HTMLElement>('[data-task-id]')!;
        const secondRow = toggles.get('two')!.closest<HTMLElement>('[data-task-id]')!;
        firstRow.scrollIntoView = vi.fn();
        secondRow.scrollIntoView = vi.fn();
        const { getScope, rerenderListSelection } = renderListSelection(tasks);

        toggles.get('one')!.focus();
        act(() => getScope()!.selectNext());
        expect(secondRow.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
        vi.mocked(firstRow.scrollIntoView).mockClear();
        vi.mocked(secondRow.scrollIntoView).mockClear();

        const processingControl = document.createElement('button');
        document.body.appendChild(processingControl);
        processingControl.focus();
        rerenderListSelection({ filteredTasks: [tasks[0]], isProcessing: true });

        expect(firstRow.scrollIntoView).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(processingControl);

        rerenderListSelection({ isProcessing: false });

        expect(firstRow.scrollIntoView).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(processingControl);
    });

    it('clears a stale highlight on processing entry instead of replaying it on exit', () => {
        const tasks = [makeTask('one'), makeTask('two')];
        const toggles = mountTaskRows(tasks);
        const firstRow = toggles.get('one')!.closest<HTMLElement>('[data-task-id]')!;
        const secondRow = toggles.get('two')!.closest<HTMLElement>('[data-task-id]')!;
        firstRow.scrollIntoView = vi.fn();
        secondRow.scrollIntoView = vi.fn();
        const { rerenderListSelection, setHighlightTask } = renderListSelection(tasks, 'two');
        vi.mocked(firstRow.scrollIntoView).mockClear();
        vi.mocked(secondRow.scrollIntoView).mockClear();

        const processingControl = document.createElement('button');
        document.body.appendChild(processingControl);
        processingControl.focus();
        rerenderListSelection({ isProcessing: true });

        expect(setHighlightTask).toHaveBeenCalledWith(null);
        rerenderListSelection({ highlightTaskId: null });
        rerenderListSelection({ isProcessing: false });

        expect(secondRow.scrollIntoView).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(processingControl);

        rerenderListSelection({ highlightTaskId: 'one' });
        expect(firstRow.scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    });
});
