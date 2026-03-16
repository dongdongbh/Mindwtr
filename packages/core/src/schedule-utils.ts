import { isAfter } from 'date-fns';
import { hasTimeComponent, safeParseDate } from './date';
import type { Task } from './types';

type ScheduleOptions = {
    includeReviewAt?: boolean;
};

function parseExplicitReminderDate(value: string | undefined | null): Date | null {
    if (!hasTimeComponent(value ?? undefined)) {
        return null;
    }
    return safeParseDate(value ?? undefined);
}

/**
 * Returns the next future scheduled time for a task, based on startTime/dueDate.
 * Used by apps to drive local notification scheduling.
 */
export function getNextScheduledAt(task: Task, now: Date = new Date(), options: ScheduleOptions = {}): Date | null {
    if (task.deletedAt) return null;
    if (task.status === 'done' || task.status === 'archived' || task.status === 'reference') return null;

    const candidates: Date[] = [];
    const start = parseExplicitReminderDate(task.startTime);
    const due = parseExplicitReminderDate(task.dueDate);
    const review = options.includeReviewAt ? parseExplicitReminderDate(task.reviewAt) : null;

    if (start && isAfter(start, now)) candidates.push(start);
    if (due && isAfter(due, now)) candidates.push(due);
    if (review && isAfter(review, now)) candidates.push(review);

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.getTime() - b.getTime());
    return candidates[0];
}

export function getUpcomingSchedules(tasks: Task[], now: Date = new Date(), options: ScheduleOptions = {}) {
    return tasks
        .map((task) => {
            const scheduledAt = getNextScheduledAt(task, now, options);
            return scheduledAt ? { task, scheduledAt } : null;
        })
        .filter(Boolean)
        .sort((a, b) => (a!.scheduledAt.getTime() - b!.scheduledAt.getTime()));
}

export function isDueWithinMinutes(task: Task, minutes: number, now: Date = new Date(), options: ScheduleOptions = {}): boolean {
    const next = getNextScheduledAt(task, now, options);
    if (!next) return false;
    const diffMs = next.getTime() - now.getTime();
    return diffMs >= 0 && diffMs <= minutes * 60 * 1000;
}

export function parseTimeOfDay(value: string | undefined, fallback: { hour: number; minute: number }) {
    if (!value) return fallback;
    const [h, m] = value.split(':');
    const hour = Number.parseInt(h, 10);
    const minute = Number.parseInt(m, 10);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return fallback;
    if (hour < 0 || hour > 23) return fallback;
    if (minute < 0 || minute > 59) return fallback;
    return { hour, minute };
}
