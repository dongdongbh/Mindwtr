import type { Task } from './types';
import { generateDeterministicUUID } from './uuid';


const DETAIL_FIELDS = [
    'description', 'attachments', 'checklist', 'startTime', 'dueDate', 'reviewAt', 'recurrence', 'relativeStartOffset',
    'contexts', 'tags', 'projectId', 'sectionId', 'priority', 'energyLevel', 'timeEstimate', 'assignedTo',
    'location', 'timeSpentMinutes', 'repeatReminderMinutes', 'dueReminderLeadMinutes', 'startReminderLeadMinutes',
] as const satisfies readonly (keyof Task)[];

const isEmpty = (value: unknown): boolean => value === undefined || value === null || value === 0
    || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && value.length === 0);


export function canMoveTaskToChecklist(task: Task, defaultAreaId?: string | null): boolean {
    return task.status === 'inbox' && !task.deletedAt && !task.purgedAt && Boolean(task.title.trim())
        && DETAIL_FIELDS.every((field) => isEmpty(task[field]))
        && (isEmpty(task.areaId) || task.areaId === defaultAreaId)
        && (task.reminderPolicy ?? 'inherit') === 'inherit';
}


export function isChecklistMoveTarget(task: Task, sourceId: string): boolean {
    return task.id !== sourceId && !task.deletedAt && !task.purgedAt && task.status !== 'done' && task.status !== 'archived';
}


export function getChecklistMoveTargets(tasks: readonly Task[], sourceId: string, query = ''): Task[] {
    const needle = query.trim().toLowerCase();
    const open = tasks.filter((task) => isChecklistMoveTarget(task, sourceId)
        && (!needle || task.title.toLowerCase().includes(needle)));
    return [...open.filter((task) => task.checklist?.length), ...open.filter((task) => !task.checklist?.length)];
}


export const checklistItemIdForMovedTask = (sourceId: string): string => generateDeterministicUUID(`checklist-move:${sourceId}`);
