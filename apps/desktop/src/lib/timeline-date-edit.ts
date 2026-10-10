import {
    canEditTimelineProjectDates,
    canEditTimelineTaskDates,
    flushPendingSave,
    planTimelineProjectDateEdit,
    planTimelineTaskDateEdit,
    runAfterStoreWriteLock,
    useTaskStore,
    type Project,
    type Task,
    type TimelineDateEdit,
    type TimelineDateEditPlan,
} from '@mindwtr/core';
import { logInfo } from './app-log';

export type TimelineDateEditTarget =
    | { kind: 'task'; task: Task; project?: Project }
    | { kind: 'project'; project: Project };
export type TimelineDateEditResult =
    | { status: 'saved'; undo: () => Promise<boolean> }
    | { status: 'noop' | 'conflict' | 'invalid' };

const TASK_SCHEDULE_FIELDS = ['startTime', 'dueDate', 'relativeStartOffset', 'pushCount'] as const;
const TASK_GUARD_FIELDS = [...TASK_SCHEDULE_FIELDS, 'recurrence', 'status', 'projectId',
    'deletedAt', 'purgedAt', 'cancelledAt', 'completedAt', 'archivedAt'] as const;
const PROJECT_SCHEDULE_FIELDS = ['startDate', 'dueDate'] as const;
const PROJECT_GUARD_FIELDS = [...PROJECT_SCHEDULE_FIELDS, 'status', 'deletedAt', 'purgedAt', 'cancelledAt'] as const;

const equal = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const matches = <T>(entity: T, expected: Partial<T>): boolean =>
    (Object.keys(expected) as (keyof T)[]).every((field) => equal(entity[field], expected[field]));
const pick = <T>(entity: T, fields: readonly (keyof T)[]): Partial<T> => {
    const result: Partial<T> = {};
    for (const field of fields) result[field] = entity[field];
    return result;
};

const logSaved = (kind: TimelineDateEditTarget['kind'], operation: 'apply' | 'undo'): void => {
    void logInfo('Timeline date edit saved', {
        scope: 'timeline',
        extra: { releaseCheck: 'v1.3.5/timeline-date-edit', kind, operation, outcome: 'saved' },
    }).catch(() => undefined);
};

const saveDateEdit = <T extends Task | Project>(
    kind: TimelineDateEditTarget['kind'],
    before: T,
    edit: TimelineDateEdit,
    fields: readonly (keyof T)[],
    guardFields: readonly (keyof T)[],
    current: () => T | undefined,
    editable: (entity: T) => boolean,
    plan: (entity: T, edit: TimelineDateEdit) => TimelineDateEditPlan<T> | null,
    update: (patch: Partial<T>, undo?: true) => Promise<{ success: boolean; error?: string }>,
): Promise<TimelineDateEditResult> => {
    const originalGuard = pick(before, guardFields);
    return runAfterStoreWriteLock(async (): Promise<TimelineDateEditResult> => {
        const live = current();
        if (!live || !editable(live) || !matches(live, originalGuard)) return { status: 'conflict' };
        if (edit.days === 0) return { status: 'noop' };
        const planned = plan(live, edit);
        if (!planned) return { status: 'invalid' };
        const write = update(planned.updates);
        // Normal store methods apply scheduling and push-count changes before yielding.
        const applied = current();
        const result = await write;
        if (!result.success) throw new Error(result.error || 'Could not save timeline dates');
        if (!applied || applied === live) throw new Error('Timeline dates were not applied');
        const restore: Partial<T> = {};
        for (const field of fields) {
            if (!equal(live[field], applied[field])) restore[field] = live[field];
        }
        if (Object.keys(restore).length === 0) return { status: 'noop' };
        const appliedGuard = pick(applied, guardFields);
        await flushPendingSave();
        const saved = current();
        if (!saved || !editable(saved) || !matches(saved, appliedGuard)) return { status: 'conflict' };
        logSaved(kind, 'apply');

        let written = false;
        let retryPersistence = false;
        let finished = false;
        let restoredGuard: Partial<T> | null = null;
        let inFlight: Promise<boolean> | null = null;
        const runUndo = (): Promise<boolean> => runAfterStoreWriteLock(async () => {
            if (finished) return true;
            let latest = current();
            if (!latest || !editable(latest) || !matches(latest, written ? restoredGuard! : appliedGuard)) return false;
            if (!written) {
                const beforeUndo = latest;
                const captureRestore = (): boolean => {
                    const restored = current();
                    if (!restored || restored === beforeUndo || !matches(restored, restore)) return false;
                    restoredGuard = pick(restored, guardFields);
                    return true;
                };
                try {
                    const undoWrite = update(restore, true);
                    written = captureRestore();
                    const undoResult = await undoWrite;
                    written = written || captureRestore();
                    if (!undoResult.success) {
                        retryPersistence = written;
                        throw new Error(undoResult.error || 'Could not undo timeline dates');
                    }
                    if (!written) throw new Error('Timeline date undo was not applied');
                } catch (error) {
                    written = written || captureRestore();
                    retryPersistence = written;
                    throw error;
                }
            }
            try {
                latest = current();
                if (!latest || !editable(latest) || !matches(latest, restoredGuard!)) return false;
                if (retryPersistence) await useTaskStore.getState().persistSnapshot();
                await flushPendingSave();
                latest = current();
                if (!latest || !editable(latest) || !matches(latest, restoredGuard!)) return false;
                finished = true;
                logSaved(kind, 'undo');
                return true;
            } catch (error) {
                // Requeue persistence after an exhausted save; never replay the mutation.
                retryPersistence = true;
                throw error;
            }
        });
        return {
            status: 'saved',
            undo: () => {
                if (inFlight) return inFlight;
                inFlight = runUndo().finally(() => { inFlight = null; });
                return inFlight;
            },
        };
    });
};

export const commitTimelineDateEdit = (target: TimelineDateEditTarget, edit: TimelineDateEdit): Promise<TimelineDateEditResult> => {
    if (target.kind === 'project') {
        const id = target.project.id;
        return saveDateEdit('project', target.project, edit, PROJECT_SCHEDULE_FIELDS, PROJECT_GUARD_FIELDS,
            () => useTaskStore.getState()._projectsById.get(id), canEditTimelineProjectDates, planTimelineProjectDateEdit,
            (updates) => useTaskStore.getState().updateProject(id, updates));
    }
    const id = target.task.id;
    return saveDateEdit('task', target.task, edit, TASK_SCHEDULE_FIELDS, TASK_GUARD_FIELDS,
        () => useTaskStore.getState()._tasksById.get(id),
        (task) => {
            const project = task.projectId ? useTaskStore.getState()._projectsById.get(task.projectId) : undefined;
            return (!task.projectId || !!project) && canEditTimelineTaskDates(task, project);
        }, planTimelineTaskDateEdit,
        (updates, undo) => useTaskStore.getState().updateTask(id, {
            ...updates,
            ...(undo && Object.prototype.hasOwnProperty.call(updates, 'dueDate') ? { pushCount: target.task.pushCount } : {}),
            // Restoring start and due together must retain an unchanged relative link.
            ...(undo && Object.prototype.hasOwnProperty.call(updates, 'startTime') && !Object.prototype.hasOwnProperty.call(updates, 'relativeStartOffset')
                && target.task.relativeStartOffset ? { relativeStartOffset: target.task.relativeStartOffset } : {}),
        }));
};
