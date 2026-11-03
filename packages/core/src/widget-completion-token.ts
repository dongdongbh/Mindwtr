import type { Task } from './types';


export function buildWidgetCompletionToken(task: Task): string {
    return JSON.stringify([task.id, task.rev ?? 0, task.updatedAt, task.status]);
}
