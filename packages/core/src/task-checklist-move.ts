import type { Task } from './types';
import { generateDeterministicUUID } from './uuid';

// Anything here that holds a value makes the Inbox task more than a title (#1467). Moving it into a checklist would
// drop that value, so Add to checklist is hidden instead (no partial copy).
const DETAIL_FIELDS = [
    'description', 'attachments', 'checklist', 'startTime', 'dueDate', 'reviewAt', 'recurrence', 'relativeStartOffset',
    'contexts', 'tags', 'projectId', 'sectionId', 'priority', 'energyLevel', 'timeEstimate', 'assignedTo',
    'location', 'timeSpentMinutes', 'repeatReminderMinutes', 'dueReminderLeadMinutes',
] as const satisfies readonly (keyof Task)[];

const isEmpty = (value: unknown): boolean => value === undefined || value === null || value === 0
    || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && value.length === 0);

/**
 * A live Inbox task that is only a title: the one kind Add to checklist accepts. `defaultAreaId` is the area new
 * captures get on their own (resolveQuickCaptureDefaultAreaId); that area was not chosen, so it does not count.
 */
export function canMoveTaskToChecklist(task: Task, defaultAreaId?: string | null): boolean {
    return task.status === 'inbox' && !task.deletedAt && !task.purgedAt && Boolean(task.title.trim())
        && DETAIL_FIELDS.every((field) => isEmpty(task[field]))
        && (isEmpty(task.areaId) || task.areaId === defaultAreaId)
        && (task.reminderPolicy ?? 'inherit') === 'inherit';
}

/** Any open task other than the source: not done, archived or deleted. */
export function isChecklistMoveTarget(task: Task, sourceId: string): boolean {
    return task.id !== sourceId && !task.deletedAt && !task.purgedAt && task.status !== 'done' && task.status !== 'archived';
}

/** Picker rows: open tasks whose title contains the query, tasks that already have a checklist first, else in given order. */
export function getChecklistMoveTargets(tasks: readonly Task[], sourceId: string, query = ''): Task[] {
    const needle = query.trim().toLowerCase();
    const open = tasks.filter((task) => isChecklistMoveTarget(task, sourceId)
        && (!needle || task.title.toLowerCase().includes(needle)));
    return [...open.filter((task) => task.checklist?.length), ...open.filter((task) => !task.checklist?.length)];
}

/** The checklist item a moved task becomes. Fixed per source, so a retried move never appends twice and Undo finds it. */
export const checklistItemIdForMovedTask = (sourceId: string): string => generateDeterministicUUID(`checklist-move:${sourceId}`);
