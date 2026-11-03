import type { Project } from './types';


export function countLiveProjectsByArea(projects: readonly Project[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const project of projects) {
        if (project.deletedAt || !project.areaId) continue;
        counts.set(project.areaId, (counts.get(project.areaId) ?? 0) + 1);
    }
    return counts;
}
