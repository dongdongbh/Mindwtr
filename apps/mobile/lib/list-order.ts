import { safeParseDueDate, type Task } from '@mindwtr/core';

// The Waiting For and Someday/Maybe screens' default orders, shared with the
// widget lists (#1173) so a widget shows the same order as the screen.
export function compareWaitingTasks(a: Task, b: Task): number {
    if (a.dueDate && !b.dueDate) return -1;
    if (!a.dueDate && b.dueDate) return 1;
    if (a.dueDate && b.dueDate) {
        const aDue = safeParseDueDate(a.dueDate);
        const bDue = safeParseDueDate(b.dueDate);
        if (aDue && bDue) return aDue.getTime() - bDue.getTime();
    }
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

export function compareSomedayTasks(a: Task, b: Task): number {
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}
