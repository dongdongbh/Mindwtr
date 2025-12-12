import { endOfDay, startOfDay } from 'date-fns';

import { safeParseDate } from './date';
import type { Project, Task } from './types';

export interface DailyDigestSummary {
    dueToday: number;
    overdue: number;
    focusToday: number;
    reviewDueTasks: number;
    reviewDueProjects: number;
}

export function getDailyDigestSummary(
    tasks: Task[],
    projects: Project[] = [],
    now: Date = new Date()
): DailyDigestSummary {
    const dayStart = startOfDay(now).getTime();
    const dayEnd = endOfDay(now).getTime();

    let dueToday = 0;
    let overdue = 0;
    let focusToday = 0;
    let reviewDueTasks = 0;
    let reviewDueProjects = 0;

    for (const task of tasks) {
        if (task.deletedAt) continue;
        if (task.status === 'done' || task.status === 'archived') continue;

        if (task.isFocusedToday) focusToday += 1;

        const due = safeParseDate(task.dueDate);
        if (due) {
            const dueTs = due.getTime();
            if (dueTs < dayStart) overdue += 1;
            else if (dueTs <= dayEnd) dueToday += 1;
        }

        const review = safeParseDate(task.reviewAt);
        if (review && review.getTime() <= dayEnd) reviewDueTasks += 1;
    }

    for (const project of projects) {
        if (project.deletedAt) continue;
        if (project.status !== 'active') continue;
        const review = safeParseDate(project.reviewAt);
        if (review && review.getTime() <= dayEnd) reviewDueProjects += 1;
    }

    return { dueToday, overdue, focusToday, reviewDueTasks, reviewDueProjects };
}

