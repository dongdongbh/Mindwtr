import { getChecklistEditStatus } from './task-checklist-model';
import type { ChecklistItem, Task, TaskStatus } from './types';

export type RowChecklistEdit = { checklist: ChecklistItem[]; status?: TaskStatus };

export function applyRowChecklistEdit(task: Task, completed: Readonly<Record<string, boolean>>, added: readonly ChecklistItem[]): RowChecklistEdit {
    const stored = task.checklist ?? [];
    const storedIds = new Set(stored.map((item) => item.id));
    const checklist = [...stored, ...added.filter((item) => !storedIds.has(item.id))].map((item) => (
        Object.prototype.hasOwnProperty.call(completed, item.id) ? { ...item, isCompleted: completed[item.id] } : item
    ));
    const status = getChecklistEditStatus({ taskMode: task.taskMode, status: task.status, checklist });
    return status !== task.status ? { checklist, status } : { checklist };
}
