import { DEFAULT_PROJECT_COLOR, type Area, type Project, type Task } from '@mindwtr/core';

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
    // Every project stores DEFAULT_PROJECT_COLOR until the user picks one; that
    // placeholder grey is "no identity", so it must not shadow the area color (#1124).
    if (project?.color && project.color !== DEFAULT_PROJECT_COLOR) return project.color;
    const areaId = project?.areaId ?? task.areaId;
    const areaColor = areaId ? areaById.get(areaId)?.color : undefined;
    return (areaColor !== DEFAULT_PROJECT_COLOR ? areaColor : undefined) || undefined;
}
