import { DEFAULT_PROJECT_COLOR, isValidProjectColorOverride } from './color-constants';
import type { Area, Project, Task } from './types';

// Historical area-less imported colors remain a fallback, never inferred overrides.
const chosenColor = (color: string | undefined): string | undefined => (
    color && color !== DEFAULT_PROJECT_COLOR && color !== '#6B7280' ? color : undefined
);

/** Shared Project identity: explicit override, live Area, then area-less legacy color. */
export function getProjectAccentColor(project: Pick<Project, 'colorOverride' | 'areaId'> & { color?: string }, areaById: ReadonlyMap<string, Pick<Area, 'color' | 'deletedAt'>>): string | undefined {
    if (project.colorOverride && isValidProjectColorOverride(project.colorOverride)) return project.colorOverride;
    if (project.areaId) {
        const area = areaById.get(project.areaId);
        return area && !area.deletedAt ? chosenColor(area.color) : undefined;
    }
    return chosenColor(project.color);
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
    areaById: ReadonlyMap<string, Pick<Area, 'color' | 'deletedAt'>>,
): string | undefined {
    const project = task.projectId ? projectById.get(task.projectId) : undefined;
    if (project) return getProjectAccentColor(project, areaById);
    const area = task.areaId ? areaById.get(task.areaId) : undefined;
    return area && !area.deletedAt ? chosenColor(area.color) : undefined;
}

/**
 * A light wash of the accent for a calendar block background, macOS Calendar
 * style: the block keeps the theme's text color and a solid bar of the accent
 * on its left edge, so any user-picked hue stays readable. Undefined when the
 * accent is not a plain six-digit hex color the caller can tint.
 */
export function getAccentTint(accent: string | undefined, alpha = 0.22): string | undefined {
    if (!accent || !/^#[0-9a-f]{6}$/i.test(accent)) return undefined;
    return `${accent}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;
}
