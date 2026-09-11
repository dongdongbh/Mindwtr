import type { Task } from '@mindwtr/core';

// A stale widget must not complete a task that has since changed or reopened.
// This is an opaque version stamp, not a credential; it never contains task text.
export function buildWidgetCompletionToken(task: Task): string {
    return JSON.stringify([task.id, task.rev ?? 0, task.updatedAt, task.status]);
}
