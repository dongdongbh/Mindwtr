import { safeParseDueDate } from './date';
import { isTaskActionable } from './task-status';
import type { Project, Section, Task } from './types';

/** Counts persisted tasks only; recurrence projection and start dates are irrelevant to a due badge. */
export function countTasksForIconBadge(
    tasks: readonly Task[],
    projects: readonly Project[],
    sections: readonly Section[] = [],
    now: Date = new Date(),
): number {
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
    if (!Number.isFinite(endOfToday)) return 0;
    const projectsById = new Map(projects.map((project) => [project.id, project]));
    const sectionsById = new Map(sections.map((section) => [section.id, section]));
    let count = 0;
    for (const task of tasks) {
        if (task.deletedAt || !isTaskActionable(task)) continue;
        const projectId = task.projectId || (task.sectionId ? sectionsById.get(task.sectionId)?.projectId : undefined);
        const project = projectId ? projectsById.get(projectId) : undefined;
        if (project && (project.deletedAt || project.status === 'archived')) continue;
        const due = safeParseDueDate(task.dueDate);
        if (due && due.getTime() <= endOfToday) count += 1;
    }
    return count;
}
