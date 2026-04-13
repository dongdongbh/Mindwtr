import type { Task } from '@mindwtr/core';

export function splitFocusedTasks<T extends Pick<Task, 'isFocusedToday'>>(tasks: T[]): {
    focusedTasks: T[];
    otherTasks: T[];
} {
    const focusedTasks: T[] = [];
    const otherTasks: T[] = [];

    tasks.forEach((task) => {
        if (task.isFocusedToday) {
            focusedTasks.push(task);
            return;
        }

        otherTasks.push(task);
    });

    return { focusedTasks, otherTasks };
}
