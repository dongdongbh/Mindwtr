


import { hasTimeComponent, safeParseDate, safeParseDueDate } from './date';
import type { ExternalCalendarEvent } from './ics';
import { isProjectedRecurringTask } from './recurrence';
import { isTaskActionable, isTaskCompleted } from './task-status';
import type { Task } from './types';


export const getTaskCompletionInstant = (
    task: Pick<Task, 'status' | 'cancelledAt' | 'completedAt' | 'updatedAt'>,
): Date | null => (
    isTaskCompleted(task) ? safeParseDate(task.completedAt ?? task.updatedAt) : null
);


export const isCompletedCalendarTask = (task: Task): boolean => (
    !task.deletedAt
    && isTaskCompleted(task)
    && getTaskCompletionInstant(task) !== null
);


export const isSchedulableCalendarTask = (task: Task): boolean => (
    !task.deletedAt
    && isTaskActionable(task)
);

export type CalendarDayItem =
    | { id: string; kind: 'scheduled'; start: Date | null; task: Task; title: string }
    | { id: string; kind: 'deadline'; start: Date | null; task: Task; title: string }
    | { id: string; kind: 'completed'; start: Date | null; task: Task; title: string }
    | { event: ExternalCalendarEvent; id: string; kind: 'event'; start: Date | null; title: string };

export type CalendarDayItemsInput = {


    completed?: readonly Task[];
    deadlines: readonly Task[];
    events: readonly ExternalCalendarEvent[];
    scheduled: readonly Task[];


    preserveTimedDeadlines?: boolean;
};


export function buildCalendarDayItems({ completed = [], deadlines, events, scheduled, preserveTimedDeadlines = false }: CalendarDayItemsInput): CalendarDayItem[] {
    const scheduledIds = new Set(scheduled.map((task) => task.id));
    const distinctDeadlines = deadlines.filter((task) => !scheduledIds.has(task.id)
        || (preserveTimedDeadlines && hasTimeComponent(task.dueDate) && safeParseDueDate(task.dueDate) !== null));
    return [
        ...completed.filter(isCompletedCalendarTask).map((task): CalendarDayItem => ({
            id: `completed-${task.id}`,
            kind: 'completed',
            start: getTaskCompletionInstant(task),
            task,
            title: task.title,
        })),
        ...scheduled.map((task): CalendarDayItem => ({
            id: `scheduled-${task.id}`,
            kind: 'scheduled',
            start: task.startTime ? safeParseDate(task.startTime) : null,
            task,
            title: task.title,
        })),
        ...distinctDeadlines
            .map((task): CalendarDayItem => ({
                id: `deadline-${task.id}`,
                kind: 'deadline',
                start: task.dueDate ? safeParseDueDate(task.dueDate) : null,
                task,
                title: task.title,
            })),
        ...events.map((event): CalendarDayItem => ({
            event,
            id: `event-${event.id}`,
            kind: 'event',
            start: safeParseDate(event.start),
            title: event.title,
        })),
    ].sort((a, b) => {
        const aTime = a.start?.getTime() ?? Number.MAX_SAFE_INTEGER;
        const bTime = b.start?.getTime() ?? Number.MAX_SAFE_INTEGER;
        if (aTime !== bTime) return aTime - bTime;
        return a.title.localeCompare(b.title);
    });
}


export type CalendarDeadlineMarker = {
    id: string;
    kind: 'deadline';
    task: Task;
    title: string;
    start: Date;
};

export function getCalendarTimedDeadlines(deadlines: readonly Task[]): CalendarDeadlineMarker[] {
    const markers: CalendarDeadlineMarker[] = [];
    for (const task of deadlines) {
        if (!isSchedulableCalendarTask(task) || !hasTimeComponent(task.dueDate)) continue;
        const start = safeParseDueDate(task.dueDate);
        if (!start) continue;
        markers.push({ id: `deadline-${task.id}`, kind: 'deadline', task, title: task.title, start });
    }
    return markers;
}

export type CalendarDeadlineMarkerGroup = {
    markers: CalendarDeadlineMarker[];

    anchorMinutes: number;

    startMinutes: number;
};


export function getCalendarDeadlineMarkerGroups(
    markers: readonly CalendarDeadlineMarker[],
    options: { dayStart: Date; minGapMinutes?: number; maxVisibleRows?: number },
): CalendarDeadlineMarkerGroup[] {
    const gap = Number.isFinite(options.minGapMinutes) && (options.minGapMinutes ?? 0) > 0
        ? Math.min(1440, options.minGapMinutes!) : 32;
    const maxRows = Number.isFinite(options.maxVisibleRows) && (options.maxVisibleRows ?? 0) > 0
        ? Math.max(1, Math.floor(options.maxVisibleRows!)) : 3;
    const sameDay = (start: Date) => start.getFullYear() === options.dayStart.getFullYear()
        && start.getMonth() === options.dayStart.getMonth() && start.getDate() === options.dayStart.getDate();
    const minutes = (marker: CalendarDeadlineMarker) => marker.start.getHours() * 60 + marker.start.getMinutes()
        + marker.start.getSeconds() / 60 + marker.start.getMilliseconds() / 60_000;
    const sorted = markers.filter((marker) => sameDay(marker.start))
        .sort((a, b) => minutes(a) - minutes(b) || a.title.localeCompare(b.title));
    const groups: CalendarDeadlineMarkerGroup[] = [];
    const height = (group: CalendarDeadlineMarkerGroup) => Math.min(1440, Math.min(group.markers.length, maxRows) * gap);
    const place = (group: CalendarDeadlineMarkerGroup) => {
        group.startMinutes = Math.max(0, Math.min(group.anchorMinutes, 1440 - height(group)));
    };
    for (const marker of sorted) {
        const anchorMinutes = minutes(marker);
        let group: CalendarDeadlineMarkerGroup = { markers: [marker], anchorMinutes, startMinutes: anchorMinutes };
        place(group);

        while (groups.length > 0) {
            const previous = groups[groups.length - 1];
            if (group.startMinutes >= previous.startMinutes + height(previous)) break;
            groups.pop();
            previous.markers.push(...group.markers);
            group = previous;
            place(group);
        }
        groups.push(group);
    }
    return groups;
}

export const getCalendarDistinctDeadlines = (deadlines: readonly Task[], scheduled: readonly Task[]): Task[] => {
    const scheduledIds = new Set(scheduled.map((task) => task.id));
    return deadlines.filter((task) => !scheduledIds.has(task.id));
};

type LimitedSlotCalendarItem = {
    kind: 'scheduled' | 'deadline' | 'completed' | 'event';
    task?: Task;
};


export function orderCalendarDayItemsForLimitedSlots<T extends LimitedSlotCalendarItem>(
    items: readonly T[]
): T[] {
    const real: T[] = [];
    const projected: T[] = [];
    for (const item of items) {
        const isProjection = (item.kind === 'scheduled' || item.kind === 'deadline')
            && isProjectedRecurringTask(item.task);
        (isProjection ? projected : real).push(item);
    }
    return projected.length === 0 ? [...items] : [...real, ...projected];
}

export type CalendarTimedLayoutInput = {
    id: string;
    startMinutes: number;
    endMinutes: number;
};

export type CalendarTimedLayout = {
    columnCount: number;
    columnIndex: number;
    leftPercent: number;
    widthPercent: number;
};

type TimedLayoutItem = CalendarTimedLayoutInput & {
    index: number;
};

type TimedLayoutWorkingItem = TimedLayoutItem & {
    columnIndex: number;
};


export const buildTimedCalendarLayouts = (
    items: readonly CalendarTimedLayoutInput[]
): Map<string, CalendarTimedLayout> => {
    const layouts = new Map<string, CalendarTimedLayout>();
    const normalizedItems = items
        .map<TimedLayoutItem | null>((item, index) => {
            if (!Number.isFinite(item.startMinutes) || !Number.isFinite(item.endMinutes)) return null;
            const startMinutes = Math.min(item.startMinutes, item.endMinutes);
            const endMinutes = Math.max(item.startMinutes, item.endMinutes);
            if (endMinutes <= startMinutes) return null;
            return { ...item, startMinutes, endMinutes, index };
        })
        .filter((item): item is TimedLayoutItem => Boolean(item))
        .sort((a, b) =>
            a.startMinutes - b.startMinutes
            || a.endMinutes - b.endMinutes
            || a.index - b.index
        );

    let activeItems: TimedLayoutWorkingItem[] = [];
    let groupItems: TimedLayoutWorkingItem[] = [];

    const flushGroup = () => {
        if (groupItems.length === 0) return;
        const columnCount = Math.max(1, ...groupItems.map((item) => item.columnIndex + 1));
        const widthPercent = 100 / columnCount;
        for (const item of groupItems) {
            layouts.set(item.id, {
                columnCount,
                columnIndex: item.columnIndex,
                leftPercent: item.columnIndex * widthPercent,
                widthPercent,
            });
        }
        groupItems = [];
    };

    for (const item of normalizedItems) {
        activeItems = activeItems.filter((active) => active.endMinutes > item.startMinutes);
        if (activeItems.length === 0) {
            flushGroup();
        }

        const occupiedColumns = new Set(activeItems.map((active) => active.columnIndex));
        let columnIndex = 0;
        while (occupiedColumns.has(columnIndex)) columnIndex += 1;

        const workingItem = { ...item, columnIndex };
        activeItems.push(workingItem);
        groupItems.push(workingItem);
    }

    flushGroup();

    return layouts;
};
