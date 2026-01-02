import type { Project, Task } from './types';

export function projectHasNextAction(project: Project, tasks: Task[]): boolean {
    return tasks.some(t =>
        t.projectId === project.id &&
        !t.deletedAt &&
        t.status === 'next'
    );
}

export function filterProjectsNeedingNextAction(projects: Project[], tasks: Task[]): Project[] {
    return projects.filter(p => p.status === 'active' && !p.deletedAt && !projectHasNextAction(p, tasks));
}

export function getProjectsByArea(projects: Project[], areaId: string): Project[] {
    return projects
        .filter(p => !p.deletedAt && p.areaId === areaId)
        .sort((a, b) => a.title.localeCompare(b.title));
}
