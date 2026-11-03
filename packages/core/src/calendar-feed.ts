


import { hasTimeComponent, safeParseDate, safeParseDueDate } from './date';
import { isTaskInActiveProject } from './project-utils';
import { expandCalendarRecurringTasks } from './recurrence';
import { timeEstimateToMinutes } from './calendar-scheduling';
import { isTaskActionable } from './task-status';
import type { AppData, Project, Task } from './types';


const DEADLINE_EVENT_MINUTES = 15;

export type CalendarFeedEvent = {
    allDay: boolean;
    end: Date;
    kind: 'scheduled' | 'deadline';
    start: Date;
    taskId: string;
    title: string;
    uid: string;
};

export type CalendarFeedInput = Pick<AppData, 'tasks'> & Partial<Pick<AppData, 'projects'>>;

export type CalendarFeedOptions = {
    now?: Date;

    name?: string;
    timeEstimatesEnabled?: boolean;
};

const feedUid = (taskId: string, kind: CalendarFeedEvent['kind']): string => (
    `${taskId}-${kind === 'scheduled' ? 'start' : 'due'}@mindwtr.app`
);

const addMinutes = (date: Date, minutes: number): Date => new Date(date.getTime() + minutes * 60_000);

const startOfDay = (date: Date): Date => {
    const next = new Date(date);
    next.setHours(0, 0, 0, 0);
    return next;
};

const addDays = (date: Date, days: number): Date => {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
};


export const isCalendarFeedTask = (task: Task, projectsById: Map<string, Project>): boolean => {
    if (task.deletedAt) return false;
    if (!isTaskActionable(task)) return false;
    return isTaskInActiveProject(task, projectsById);
};

export function buildCalendarFeedEvents(
    data: CalendarFeedInput,
    options: CalendarFeedOptions = {},
): CalendarFeedEvent[] {
    const now = options.now ?? new Date();
    const projectsById = new Map((data.projects ?? []).map((project) => [project.id, project]));
    const events: CalendarFeedEvent[] = [];

    for (const sourceTask of data.tasks ?? []) {
        for (const task of expandCalendarRecurringTasks(sourceTask, now.toISOString())) {
            if (!isCalendarFeedTask(task, projectsById)) continue;

            const start = task.startTime ? safeParseDate(task.startTime) : null;
            const due = task.dueDate ? safeParseDueDate(task.dueDate) : null;

            if (start) {
                const timed = hasTimeComponent(task.startTime);
                const durationMinutes = timeEstimateToMinutes(task.timeEstimate, {
                    enabled: options.timeEstimatesEnabled,
                });
                events.push({
                    allDay: !timed,
                    end: timed ? addMinutes(start, durationMinutes) : addDays(startOfDay(start), 1),
                    kind: 'scheduled',
                    start: timed ? start : startOfDay(start),
                    taskId: task.id,
                    title: task.title,
                    uid: feedUid(task.id, 'scheduled'),
                });
            }


            if (!due) continue;
            if (
                start
                && !hasTimeComponent(task.startTime)
                && !hasTimeComponent(task.dueDate)
                && task.startTime === task.dueDate
            ) continue;

            const timedDue = hasTimeComponent(task.dueDate);
            events.push({
                allDay: !timedDue,
                end: timedDue ? addMinutes(due, DEADLINE_EVENT_MINUTES) : addDays(startOfDay(due), 1),
                kind: 'deadline',
                start: timedDue ? due : startOfDay(due),
                taskId: task.id,
                title: task.title,
                uid: feedUid(task.id, 'deadline'),
            });
        }
    }

    return events.sort((a, b) => a.start.getTime() - b.start.getTime() || a.uid.localeCompare(b.uid));
}

const pad = (value: number, length = 2): string => String(value).padStart(length, '0');


const formatIcsDate = (date: Date): string => (
    `${pad(date.getFullYear(), 4)}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
);


const formatIcsDateTime = (date: Date): string => (
    `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
);

const escapeIcsText = (value: string): string => value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');


const foldIcsLine = (line: string): string[] => {
    const bytes = new TextEncoder().encode(line);
    if (bytes.length <= 75) return [line];
    const decoder = new TextDecoder();
    const out: string[] = [];
    let offset = 0;
    while (offset < bytes.length) {
        const limit = out.length === 0 ? 75 : 74;
        let end = Math.min(offset + limit, bytes.length);

        while (end > offset && end < bytes.length && (bytes[end] & 0b1100_0000) === 0b1000_0000) end -= 1;
        const chunk = decoder.decode(bytes.slice(offset, end));
        out.push(out.length === 0 ? chunk : ` ${chunk}`);
        offset = end;
    }
    return out;
};

export function serializeCalendarFeed(
    events: readonly CalendarFeedEvent[],
    options: CalendarFeedOptions = {},
): string {
    const stamp = formatIcsDateTime(options.now ?? new Date());
    const name = options.name ?? 'Mindwtr';
    const lines: string[] = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Mindwtr//Calendar Feed//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        `NAME:${escapeIcsText(name)}`,
        `X-WR-CALNAME:${escapeIcsText(name)}`,
        'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
        'X-PUBLISHED-TTL:PT1H',
    ];

    for (const event of events) {
        lines.push(
            'BEGIN:VEVENT',
            `UID:${escapeIcsText(event.uid)}`,
            `DTSTAMP:${stamp}`,
            event.allDay
                ? `DTSTART;VALUE=DATE:${formatIcsDate(event.start)}`
                : `DTSTART:${formatIcsDateTime(event.start)}`,
            event.allDay
                ? `DTEND;VALUE=DATE:${formatIcsDate(event.end)}`
                : `DTEND:${formatIcsDateTime(event.end)}`,
            `SUMMARY:${escapeIcsText(event.kind === 'deadline' ? `Due: ${event.title}` : event.title)}`,
            'END:VEVENT',
        );
    }

    lines.push('END:VCALENDAR');
    return `${lines.flatMap(foldIcsLine).join('\r\n')}\r\n`;
}


export function buildCalendarFeed(data: CalendarFeedInput, options: CalendarFeedOptions = {}): string {
    return serializeCalendarFeed(buildCalendarFeedEvents(data, options), options);
}
