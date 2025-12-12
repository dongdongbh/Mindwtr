import type { Task } from './types';

export function isTaskCompletedForDependency(task: Task | undefined): boolean {
    if (!task) return true;
    if (task.deletedAt) return true;
    return task.status === 'done' || task.status === 'archived';
}

export function isTaskBlocked(task: Task, tasksById: Record<string, Task>): boolean {
    const blockers = task.blockedByTaskIds || [];
    if (blockers.length === 0) return false;
    return blockers.some((id) => !isTaskCompletedForDependency(tasksById[id]));
}

export function getBlockedTaskIds(tasks: Task[]): Set<string> {
    const tasksById: Record<string, Task> = {};
    for (const t of tasks) tasksById[t.id] = t;
    const blocked = new Set<string>();
    for (const task of tasks) {
        if (isTaskBlocked(task, tasksById)) blocked.add(task.id);
    }
    return blocked;
}

export function getUnblocksCount(taskId: string, tasks: Task[]): number {
    return tasks.filter((t) => (t.blockedByTaskIds || []).includes(taskId) && !t.deletedAt).length;
}

