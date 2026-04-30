import { safeParseDate } from './date';
import type { ExternalCalendarEvent } from './ics';
import type { Task, TimeEstimate } from './types';

export const DEFAULT_CALENDAR_DAY_START_HOUR = 8;
export const DEFAULT_CALENDAR_DAY_END_HOUR = 23;
export const DEFAULT_CALENDAR_SNAP_MINUTES = 5;
export const CALENDAR_TIME_ESTIMATE_OPTIONS: Array<{ estimate: TimeEstimate; minutes: number }> = [
    { estimate: '5min', minutes: 5 },
    { estimate: '10min', minutes: 10 },
    { estimate: '15min', minutes: 15 },
    { estimate: '30min', minutes: 30 },
    { estimate: '1hr', minutes: 60 },
    { estimate: '2hr', minutes: 120 },
    { estimate: '3hr', minutes: 180 },
    { estimate: '4hr', minutes: 240 },
];

type SchedulingTask = Pick<Task, 'deletedAt' | 'id' | 'startTime' | 'status' | 'timeEstimate'>;
type SchedulingEvent = Pick<ExternalCalendarEvent, 'allDay' | 'end' | 'start'>;

type CalendarSchedulingOptions = {
    dayEndHour?: number;
    dayStartHour?: number;
    snapMinutes?: number;
    timeEstimatesEnabled?: boolean;
};

type FindFreeSlotOptions = CalendarSchedulingOptions & {
    day: Date;
    durationMinutes: number;
    events: readonly SchedulingEvent[];
    excludeTaskId?: string;
    now?: Date;
    tasks: readonly SchedulingTask[];
};

type IsSlotFreeOptions = CalendarSchedulingOptions & {
    day: Date;
    durationMinutes: number;
    events: readonly SchedulingEvent[];
    excludeTaskId?: string;
    startTime: Date;
    tasks: readonly SchedulingTask[];
};

type Interval = { end: number; start: number };

export function timeEstimateToMinutes(estimate: TimeEstimate | undefined, options?: { enabled?: boolean }): number {
    if (options?.enabled === false) return 30;
    switch (estimate) {
        case '5min': return 5;
        case '10min': return 10;
        case '15min': return 15;
        case '30min': return 30;
        case '1hr': return 60;
        case '2hr': return 120;
        case '3hr': return 180;
        case '4hr':
        case '4hr+':
            return 240;
        default:
            return 30;
    }
}

export function minutesToTimeEstimate(minutes: number): TimeEstimate {
    const normalized = Math.max(1, Math.round(minutes));
    const exact = CALENDAR_TIME_ESTIMATE_OPTIONS.find((option) => option.minutes === normalized);
    if (exact) return exact.estimate;

    const nextLargest = CALENDAR_TIME_ESTIMATE_OPTIONS.find((option) => option.minutes >= normalized);
    return nextLargest?.estimate ?? '4hr+';
}

const ceilToMinutes = (date: Date, stepMinutes: number): Date => {
    const stepMs = stepMinutes * 60 * 1000;
    return new Date(Math.ceil(date.getTime() / stepMs) * stepMs);
};

const isSameLocalDay = (left: Date, right: Date): boolean => (
    left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate()
);

const getDayBounds = (day: Date, options?: CalendarSchedulingOptions): { dayEnd: Date; dayStart: Date; snapMinutes: number } => {
    const dayStart = new Date(day);
    dayStart.setHours(options?.dayStartHour ?? DEFAULT_CALENDAR_DAY_START_HOUR, 0, 0, 0);
    const dayEnd = new Date(day);
    dayEnd.setHours(options?.dayEndHour ?? DEFAULT_CALENDAR_DAY_END_HOUR, 0, 0, 0);
    return {
        dayEnd,
        dayStart,
        snapMinutes: options?.snapMinutes ?? DEFAULT_CALENDAR_SNAP_MINUTES,
    };
};

const taskBlocksScheduling = (task: SchedulingTask, excludeTaskId?: string): boolean => {
    if (task.deletedAt) return false;
    if (task.id === excludeTaskId) return false;
    return task.status !== 'done' && task.status !== 'archived' && task.status !== 'reference';
};

const collectBusyIntervals = (
    day: Date,
    events: readonly SchedulingEvent[],
    tasks: readonly SchedulingTask[],
    options?: CalendarSchedulingOptions & { excludeTaskId?: string },
): Interval[] => {
    const { dayEnd, dayStart } = getDayBounds(day, options);
    const intervals: Interval[] = [];

    for (const event of events) {
        if (event.allDay) continue;
        const start = safeParseDate(event.start);
        const end = safeParseDate(event.end);
        if (!start || !end) continue;
        const s = Math.max(start.getTime(), dayStart.getTime());
        const e = Math.min(end.getTime(), dayEnd.getTime());
        if (e > s) intervals.push({ start: s, end: e });
    }

    for (const task of tasks) {
        if (!taskBlocksScheduling(task, options?.excludeTaskId)) continue;
        const start = safeParseDate(task.startTime);
        if (!start || !isSameLocalDay(start, day)) continue;
        const durationMs = timeEstimateToMinutes(task.timeEstimate, { enabled: options?.timeEstimatesEnabled }) * 60 * 1000;
        const s = Math.max(start.getTime(), dayStart.getTime());
        const e = Math.min(start.getTime() + durationMs, dayEnd.getTime());
        if (e > s) intervals.push({ start: s, end: e });
    }

    intervals.sort((a, b) => a.start - b.start);
    const merged: Interval[] = [];
    for (const interval of intervals) {
        const last = merged[merged.length - 1];
        if (!last || interval.start > last.end) merged.push({ ...interval });
        else last.end = Math.max(last.end, interval.end);
    }
    return merged;
};

export function findFreeSlotForDay(options: FindFreeSlotOptions): Date | null {
    const { dayEnd, dayStart, snapMinutes } = getDayBounds(options.day, options);
    const now = options.now ?? new Date();
    const isToday = isSameLocalDay(options.day, now);
    const earliest = ceilToMinutes(
        new Date(Math.max(dayStart.getTime(), isToday ? now.getTime() : dayStart.getTime())),
        snapMinutes,
    );
    const intervals = collectBusyIntervals(options.day, options.events, options.tasks, options);
    const durationMs = options.durationMinutes * 60 * 1000;
    let cursor = Math.max(earliest.getTime(), dayStart.getTime());

    for (const interval of intervals) {
        if (cursor + durationMs <= interval.start) return new Date(cursor);
        if (cursor < interval.end) {
            cursor = ceilToMinutes(new Date(interval.end), snapMinutes).getTime();
        }
    }

    if (cursor + durationMs <= dayEnd.getTime()) return new Date(cursor);
    return null;
}

export function isSlotFreeForDay(options: IsSlotFreeOptions): boolean {
    const startMs = options.startTime.getTime();
    const endMs = startMs + options.durationMinutes * 60 * 1000;

    const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number): boolean => aStart < bEnd && aEnd > bStart;
    const intervals = collectBusyIntervals(options.day, options.events, options.tasks, {
        ...options,
        dayEndHour: 24,
        dayStartHour: 0,
    });
    return !intervals.some((interval) => overlaps(startMs, endMs, interval.start, interval.end));
}
