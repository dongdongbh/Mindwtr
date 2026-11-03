import { DEFAULT_PROJECT_COLOR, isValidProjectColorOverride } from './color-constants';
import type { Area, Project, Task } from './types';


const chosenColor = (color: string | undefined): string | undefined => (
    color && color !== DEFAULT_PROJECT_COLOR && color !== '#6B7280' ? color : undefined
);


export function getProjectAccentColor(project: Pick<Project, 'colorOverride' | 'areaId'> & { color?: string }, areaById: ReadonlyMap<string, Pick<Area, 'color' | 'deletedAt'>>): string | undefined {
    if (project.colorOverride && isValidProjectColorOverride(project.colorOverride)) return project.colorOverride;
    if (project.areaId) {
        const area = areaById.get(project.areaId);
        return area && !area.deletedAt ? chosenColor(area.color) : undefined;
    }
    return chosenColor(project.color);
}


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


export function getAccentTint(accent: string | undefined, alpha = 0.22): string | undefined {
    if (!accent || !/^#[0-9a-f]{6}$/i.test(accent)) return undefined;
    return `${accent}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;
}
