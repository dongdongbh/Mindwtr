import { describe, expect, it } from 'vitest';

import { splitFocusedTasks } from './focus-screen-utils';

describe('splitFocusedTasks', () => {
    it('separates focused tasks while preserving relative order inside each group', () => {
        const { focusedTasks, otherTasks } = splitFocusedTasks([
            { id: 'due-1', isFocusedToday: false },
            { id: 'focus-1', isFocusedToday: true },
            { id: 'due-2', isFocusedToday: false },
            { id: 'focus-2', isFocusedToday: true },
            { id: 'focus-3', isFocusedToday: true },
        ]);

        expect(focusedTasks.map((task) => task.id)).toEqual([
            'focus-1',
            'focus-2',
            'focus-3',
        ]);
        expect(otherTasks.map((task) => task.id)).toEqual([
            'due-1',
            'due-2',
        ]);
    });

    it('returns empty groups when one side is absent', () => {
        const tasks = [
            { id: 'focus-1', isFocusedToday: true },
            { id: 'focus-2', isFocusedToday: true },
        ];

        expect(splitFocusedTasks(tasks)).toEqual({
            focusedTasks: tasks,
            otherTasks: [],
        });
    });
});
