import type { Area, Project, Task } from '@mindwtr/core';

/**
 * The identity color a task carries on the calendar and the timeline — project
 * first, then the area behind it, then an area set straight on the task. One
 * home so the two charts can never drift into different palettes for the same
 * task. Undefined (no project or area color) leaves the caller's themed
 * fallback in place.
 */
export function getTaskAccentColor(
    task: Task,
    projectById: Map<string, Project>,
    areaById: Map<string, Area>,
): string | undefined {
    const project = task.projectId ? projectById.get(task.projectId) : undefined;
    if (project?.color) return project.color;
    const areaId = project?.areaId ?? task.areaId;
    return (areaId ? areaById.get(areaId)?.color : undefined) || undefined;
}
