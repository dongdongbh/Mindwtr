import { addDays, format, isValid } from 'date-fns';
import { hasTimeComponent, safeParseDate } from './date';
import { isTaskDateCoherent } from './task-date-coherence';
import { computeRelativeStartTime, normalizeRelativeStartOffset, resolveRelativeStartUpdates } from './task-relative-start';
import { isTaskActionable } from './task-status';
import type { Project, Task } from './types';

export type TimelineDateEditKind = 'move' | 'start' | 'due';
export type TimelineDateEdit = { kind: TimelineDateEditKind; days: number };
export type TimelineDateEditPlan<T extends Task | Project> = {
    updates: Partial<T>;
    effectiveDates: { start?: string; due?: string };
};

const validDates = (start?: string, due?: string): boolean => (
    !!(start || due)
    && (!start || !!safeParseDate(start))
    && (!due || !!safeParseDate(due))
    && isTaskDateCoherent({ startTime: start, dueDate: due })
);

const activeProject = (project: Project): boolean => project.status === 'active'
    && !project.deletedAt && !project.purgedAt && !project.cancelledAt;

export const canEditTimelineTaskDates = (task: Task, project?: Project): boolean => {
    if (!isTaskActionable(task) || task.deletedAt || task.purgedAt || task.cancelledAt
        || (project && (!activeProject(project) || project.id !== task.projectId))
        || !validDates(task.startTime, task.dueDate)) return false;
    if (task.relativeStartOffset != null) {
        const offset = normalizeRelativeStartOffset(task.relativeStartOffset);
        if (!task.startTime || !offset || !computeRelativeStartTime(task.dueDate, offset)) return false;
    }
    return true;
};

export const canEditTimelineProjectDates = (project: Project): boolean => activeProject(project)
    && !!project.startDate && !!project.dueDate && validDates(project.startDate, project.dueDate);

const moveDate = (value: string, days: number): string | undefined => {
    const parsed = safeParseDate(value);
    if (!parsed) return undefined;
    const moved = addDays(parsed, days);
    if (!isValid(moved)) return undefined;
    return hasTimeComponent(value) ? moved.toISOString() : format(moved, 'yyyy-MM-dd');
};

const validEdit = (edit: TimelineDateEdit): boolean => Number.isInteger(edit.days)
    && edit.days !== 0 && (edit.kind === 'move' || edit.kind === 'start' || edit.kind === 'due');

export const planTimelineTaskDateEdit = (task: Task, edit: TimelineDateEdit): TimelineDateEditPlan<Task> | null => {
    if (!validEdit(edit) || !canEditTimelineTaskDates(task)) return null;
    if (edit.kind !== 'move' && (!task.startTime || !task.dueDate)) return null;
    const updates: Partial<Task> = {};
    if (task.startTime && edit.kind !== 'due') {
        updates.startTime = moveDate(task.startTime, edit.days);
        if (!updates.startTime) return null;
    }
    if (task.dueDate && edit.kind !== 'start') {
        updates.dueDate = moveDate(task.dueDate, edit.days);
        if (!updates.dueDate) return null;
    }
    if (edit.kind === 'move' && task.relativeStartOffset) updates.relativeStartOffset = task.relativeStartOffset;
    const resolved = resolveRelativeStartUpdates(task, updates);
    const next = { ...task, ...resolved };
    if (!validDates(next.startTime, next.dueDate)) return null;
    return { updates: resolved, effectiveDates: { start: next.startTime, due: next.dueDate } };
};

export const planTimelineProjectDateEdit = (project: Project, edit: TimelineDateEdit): TimelineDateEditPlan<Project> | null => {
    if (!validEdit(edit) || !canEditTimelineProjectDates(project)) return null;
    const updates: Partial<Project> = {};
    if (edit.kind !== 'due') {
        updates.startDate = moveDate(project.startDate!, edit.days);
        if (!updates.startDate) return null;
    }
    if (edit.kind !== 'start') {
        updates.dueDate = moveDate(project.dueDate!, edit.days);
        if (!updates.dueDate) return null;
    }
    const next = { ...project, ...updates };
    if (!validDates(next.startDate, next.dueDate)) return null;
    return { updates, effectiveDates: { start: next.startDate, due: next.dueDate } };
};
