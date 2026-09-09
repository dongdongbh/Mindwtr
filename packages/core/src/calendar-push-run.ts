import {
    expandCalendarRecurringTasks,
    getProjectedRecurringTaskId,
    isProjectedRecurringTaskId,
} from './recurrence';
import type { CalendarSyncEntry } from './sqlite-adapter';
import { isTaskActionable } from './task-status';
import type { Task } from './types';

export type CalendarPushRunTarget = {
    id: string;
};

export type CalendarPushUpdateResult =
    | { status: 'updated'; eventId: string }
    | { status: 'missing' };

export type CalendarPushRunPorts = {
    platform: string;
    nowIso: () => string;
    createEvent: (task: Task) => Promise<string>;
    updateEvent: (
        entry: CalendarSyncEntry,
        task: Task,
    ) => Promise<CalendarPushUpdateResult>;
    deleteEvent: (entry: CalendarSyncEntry) => Promise<void>;
    getSyncEntry: (taskId: string) => Promise<CalendarSyncEntry | null>;
    getAllSyncEntries: () => Promise<CalendarSyncEntry[]>;
    upsertSyncEntry: (entry: CalendarSyncEntry) => Promise<void>;
    deleteSyncEntry: (taskId: string) => Promise<void>;
};

export type CalendarPushFullSyncOptions = {
    tasks: readonly Task[];
    target: CalendarPushRunTarget;
    ports: CalendarPushRunPorts;
    concurrency?: number;
};

export type CalendarPushFullSyncResult = {
    total: number;
    failed: number;
    stale: number;
    staleFailed: number;
};

export type CalendarPushPartialSyncOptions = {
    taskIds: readonly string[];
    tasksById: ReadonlyMap<string, Task>;
    target: CalendarPushRunTarget;
    ports: CalendarPushRunPorts;
    concurrency?: number;
};

export type CalendarPushPartialSyncResult = {
    total: number;
    failed: number;
    removed: number;
    removedFailed: number;
};

export function shouldRemoveCalendarPushTask(task: Task): boolean {
    return (!task.dueDate && !task.startTime)
        || Boolean(task.deletedAt)
        || !isTaskActionable(task);
}

async function runLimitedSettled<T>(
    items: readonly T[],
    concurrency: number,
    runner: (item: T) => Promise<void>,
): Promise<PromiseSettledResult<void>[]> {
    if (items.length === 0) return [];
    const results: PromiseSettledResult<void>[] = new Array(items.length);
    let cursor = 0;
    const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), items.length);
    const workers = Array.from({ length: workerCount }, async () => {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            try {
                await runner(items[index]!);
                results[index] = { status: 'fulfilled', value: undefined };
            } catch (reason) {
                results[index] = { status: 'rejected', reason };
            }
        }
    });
    await Promise.all(workers);
    return results;
}

async function createCalendarEvent(
    task: Task,
    target: CalendarPushRunTarget,
    ports: CalendarPushRunPorts,
): Promise<void> {
    const eventId = await ports.createEvent(task);
    await ports.upsertSyncEntry({
        taskId: task.id,
        calendarEventId: eventId,
        calendarId: target.id,
        platform: ports.platform,
        lastSyncedAt: ports.nowIso(),
    });
}

async function removeCalendarEntry(
    entry: CalendarSyncEntry,
    ports: CalendarPushRunPorts,
): Promise<void> {
    await ports.deleteEvent(entry);
    await ports.deleteSyncEntry(entry.taskId);
}

async function removeCalendarTask(
    taskId: string,
    ports: CalendarPushRunPorts,
): Promise<void> {
    const entry = await ports.getSyncEntry(taskId);
    if (!entry) return;
    await removeCalendarEntry(entry, ports);
}

async function syncCalendarPushTask(
    task: Task,
    target: CalendarPushRunTarget,
    ports: CalendarPushRunPorts,
): Promise<void> {
    if (shouldRemoveCalendarPushTask(task)) {
        await removeCalendarTask(task.id, ports);
        return;
    }
    const existing = await ports.getSyncEntry(task.id);
    if (existing && existing.calendarId === target.id) {
        const update = await ports.updateEvent(existing, task);
        if (update.status === 'updated') {
            await ports.upsertSyncEntry({
                taskId: task.id,
                calendarEventId: update.eventId,
                calendarId: target.id,
                platform: ports.platform,
                lastSyncedAt: ports.nowIso(),
            });
            return;
        }
        await ports.deleteSyncEntry(task.id);
        await createCalendarEvent(task, target, ports);
        return;
    }
    if (existing) {
        await removeCalendarEntry(existing, ports);
    }
    await createCalendarEvent(task, target, ports);
}

export async function runCalendarPushFullSync(
    options: CalendarPushFullSyncOptions,
): Promise<CalendarPushFullSyncResult> {
    const projectedAtIso = options.ports.nowIso();
    const calendarTasks = options.tasks.flatMap((task) =>
        expandCalendarRecurringTasks(task, projectedAtIso)
    );
    const initialEntries = await options.ports.getAllSyncEntries();
    const entriesByTaskId = new Map(
        initialEntries.map((entry) => [entry.taskId, entry]),
    );
    const runPorts: CalendarPushRunPorts = {
        ...options.ports,
        getSyncEntry: async (taskId) => entriesByTaskId.get(taskId) ?? null,
    };
    const concurrency = options.concurrency ?? 4;
    const results = await runLimitedSettled(
        calendarTasks,
        concurrency,
        (task) => syncCalendarPushTask(task, options.target, runPorts),
    );
    const activeTaskIds = new Set(
        calendarTasks
            .filter((task) => !shouldRemoveCalendarPushTask(task))
            .map((task) => task.id),
    );
    const staleEntries = (await options.ports.getAllSyncEntries())
        .filter((entry) => !activeTaskIds.has(entry.taskId));
    const staleResults = await runLimitedSettled(
        staleEntries,
        concurrency,
        (entry) => removeCalendarEntry(entry, options.ports),
    );

    return {
        total: calendarTasks.length,
        failed: results.filter((result) => result.status === 'rejected').length,
        stale: staleEntries.length,
        staleFailed: staleResults.filter((result) => result.status === 'rejected').length,
    };
}

export async function runCalendarPushPartialSync(
    options: CalendarPushPartialSyncOptions,
): Promise<CalendarPushPartialSyncResult> {
    const projectedAtIso = options.ports.nowIso();
    const targets: Task[] = [];
    const removedTaskIds = new Set<string>();

    for (const taskId of options.taskIds) {
        if (isProjectedRecurringTaskId(taskId)) {
            removedTaskIds.add(taskId);
            continue;
        }
        const task = options.tasksById.get(taskId);
        if (!task) {
            removedTaskIds.add(taskId);
            removedTaskIds.add(getProjectedRecurringTaskId(taskId));
            continue;
        }
        const expandedTasks = expandCalendarRecurringTasks(task, projectedAtIso);
        targets.push(...expandedTasks);
        const projectedTaskId = getProjectedRecurringTaskId(task.id);
        if (!expandedTasks.some((candidate) => candidate.id === projectedTaskId)) {
            removedTaskIds.add(projectedTaskId);
        }
    }

    const concurrency = options.concurrency ?? 4;
    const syncResults = await runLimitedSettled(
        targets,
        concurrency,
        (task) => syncCalendarPushTask(task, options.target, options.ports),
    );
    const removedIds = Array.from(removedTaskIds);
    const removeResults = await runLimitedSettled(
        removedIds,
        concurrency,
        (taskId) => removeCalendarTask(taskId, options.ports),
    );

    return {
        total: targets.length,
        failed: syncResults.filter((result) => result.status === 'rejected').length,
        removed: removedIds.length,
        removedFailed: removeResults.filter((result) => result.status === 'rejected').length,
    };
}
