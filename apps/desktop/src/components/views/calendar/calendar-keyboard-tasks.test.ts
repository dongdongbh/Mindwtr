import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProjectedRecurringTaskId, useTaskStore } from '@mindwtr/core';
import type { Task } from '@mindwtr/core';

import { createTaskListScope } from '../list/task-list-scope';
import { collectCalendarKeyboardTasks } from './calendar-keyboard-tasks';

const makeTask = (id: string): Task => ({
    id,
    title: `Task ${id}`,
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
} as Task);

const real = [makeTask('a'), makeTask('b'), makeTask('c')];


const mountCalendarDay = () => {
    const main = document.createElement('div');
    main.setAttribute('data-main-content', '');
    const chip = (taskId: string, projected: boolean) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('data-task-id', taskId);
        if (!projected) button.setAttribute('data-task-edit-trigger', '');
        button.disabled = projected;
        main.appendChild(button);
        return button;
    };
    const chips = {
        a: chip('a', false),
        projected: chip(getProjectedRecurringTaskId('b'), true),
        b: chip('b', false),

        aRepeat: chip('a', false),
        c: chip('c', false),
    };
    document.body.appendChild(main);
    return chips;
};

beforeEach(() => {
    useTaskStore.setState((state) => ({ ...state, tasks: real, _allTasks: real } as never));
});

afterEach(() => {
    document.body.innerHTML = '';
});

describe('collectCalendarKeyboardTasks', () => {
    it('walks the day in document order, skipping projected chips and repeats', () => {
        mountCalendarDay();

        expect(collectCalendarKeyboardTasks().map((task) => task.id)).toEqual(['a', 'b', 'c']);
    });

    it('returns nothing when the calendar shows no real tasks', () => {
        const main = document.createElement('div');
        main.setAttribute('data-main-content', '');
        const projected = document.createElement('button');
        projected.setAttribute('data-task-id', getProjectedRecurringTaskId('b'));
        main.appendChild(projected);
        document.body.appendChild(main);

        expect(collectCalendarKeyboardTasks()).toEqual([]);
    });
});

describe('calendar keyboard scope', () => {
    let selectedIndex: number;
    const build = () => {
        selectedIndex = 0;
        return createTaskListScope({
            getTasks: collectCalendarKeyboardTasks,
            getSelectedIndex: () => selectedIndex,
            setSelectedIndex: (next) => { selectedIndex = next; },
            t: (key: string) => key,
        });
    };

    it('j steps past the projected chip to the next real task', () => {
        const chips = mountCalendarDay();
        const scope = build();

        scope.selectNext();

        expect(selectedIndex).toBe(1);
        expect(document.activeElement).toBe(chips.b);
        expect(document.activeElement).not.toBe(chips.projected);
    });

    it('never acts on a projected chip, even when focus sits on one', async () => {
        const chips = mountCalendarDay();
        const moveTask = vi.fn(async () => ({ success: true }));
        const deleteTask = vi.fn(async () => ({ success: true }));
        useTaskStore.setState((state) => ({ ...state, moveTask, deleteTask } as never));
        const scope = build();

        chips.projected.focus();
        scope.toggleDoneSelected();
        scope.deleteSelected();

        await vi.waitFor(() => expect(moveTask).toHaveBeenCalled());


        expect(moveTask).toHaveBeenCalledWith('a', 'done');
        expect(deleteTask).toHaveBeenCalledWith('a');
        expect(deleteTask).not.toHaveBeenCalledWith(getProjectedRecurringTaskId('b'));
    });

    it('e opens the chip itself, which carries the edit trigger', () => {
        const chips = mountCalendarDay();
        const scope = build();
        const click = vi.fn();
        chips.a.addEventListener('click', click);

        scope.editSelected();

        expect(click).toHaveBeenCalledTimes(1);
    });

    it('the status chord moves the selected calendar task', async () => {
        mountCalendarDay();
        const moveTask = vi.fn(async () => ({ success: true }));
        useTaskStore.setState((state) => ({ ...state, moveTask } as never));
        const scope = build();

        scope.selectLast();
        scope.setStatusSelected?.('someday');

        await vi.waitFor(() => expect(moveTask).toHaveBeenCalledWith('c', 'someday'));
    });
});
