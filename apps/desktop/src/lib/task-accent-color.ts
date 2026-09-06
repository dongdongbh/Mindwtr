import { DEFAULT_PROJECT_COLOR, type Area, type Project, type Task } from '@mindwtr/core';

// Every project stores DEFAULT_PROJECT_COLOR until the user picks one; that
// placeholder grey is "no identity", so it must never shadow the area color (#1124).
const chosenColor = (color: string | undefined): string | undefined => (
    color && color !== DEFAULT_PROJECT_COLOR ? color : undefined
);

/**
 * The identity color a project carries on the calendar and the timeline — its own
 * chosen color first, then the area behind it. The Timeline group dot used to read
 * `project.color` straight and so painted every never-recolored project grey while
 * the task bars under it took the area color.
 */
export function getProjectAccentColor(project: Project, areaById: Map<string, Area>): string | undefined {
    return chosenColor(project.color)
        ?? chosenColor(project.areaId ? areaById.get(project.areaId)?.color : undefined);
}

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
    const projectColor = project ? chosenColor(project.color) : undefined;
    if (projectColor) return projectColor;
    const areaId = project?.areaId ?? task.areaId;
    return chosenColor(areaId ? areaById.get(areaId)?.color : undefined);
}
