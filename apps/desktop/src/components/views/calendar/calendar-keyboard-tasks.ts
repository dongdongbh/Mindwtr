import { isProjectedRecurringTaskId, useTaskStore } from '@mindwtr/core';
import type { Task } from '@mindwtr/core';


export function collectCalendarKeyboardTasks(): Task[] {
    if (typeof document === 'undefined') return [];
    const root = document.querySelector<HTMLElement>('[data-main-content]') ?? document.body;
    const tasksById = useTaskStore.getState().getDerivedState().tasksById;
    const seen = new Set<string>();
    const tasks: Task[] = [];

    for (const row of root.querySelectorAll<HTMLElement>('[data-task-id]')) {
        const taskId = row.dataset.taskId;


        if (!taskId || seen.has(taskId) || isProjectedRecurringTaskId(taskId)) continue;
        const task = tasksById.get(taskId);
        if (!task) continue;
        seen.add(taskId);
        tasks.push(task);
    }

    return tasks;
}
