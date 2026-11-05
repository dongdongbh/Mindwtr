import type { AppSettings, Area, Project, Section, Task } from './types';
import { projectToSqliteRow } from './project-sync-schema';
import { taskToSqliteRow } from './task-sync-schema';
import { findSelectableProjectByTitleAndArea, isSelectableProjectForTaskAssignment } from './project-utils';
import { resolveTaskContainerAssignment } from './task-container-rules';
import { retainTaskTaxonomy, retainTaxonomyEffects } from './taxonomy-catalog';

type Collections = { _allTasks: Task[]; _allProjects: Project[]; _allSections: Section[]; _allAreas: Area[]; settings: AppSettings };
type Result = { tasks: Task[]; projects: Project[]; settings: AppSettings; changed: boolean };
const unchanged = (state: Collections): Result => ({ tasks: state._allTasks, projects: state._allProjects, settings: state.settings, changed: false });

/** Canonical post-preparation checks/effects shared by ordinary capture and the atomic share receipt writer. */
export function applyPreparedCaptureData(state: Collections,
    { task, project, deviceIdToInitialize }: { task: Task; project: Project | null; deviceIdToInitialize: string | null }): Result | null {
    const existingTask = state._allTasks.find((entry) => entry.id === task.id);
    const existingProject = project && state._allProjects.find((entry) => entry.id === project.id);
    const sameTask = existingTask && !existingTask.deletedAt && !existingTask.purgedAt
        && JSON.stringify(taskToSqliteRow(existingTask)) === JSON.stringify(taskToSqliteRow(task));
    const sameProject = existingProject && !existingProject.deletedAt && !existingProject.purgedAt
        && JSON.stringify(projectToSqliteRow(existingProject)) === JSON.stringify(projectToSqliteRow(project!));
    if ((existingTask && !sameTask) || (existingProject && !sameProject)) return null;
    if (existingTask) {
        if (project && !sameProject) return null;
        return unchanged(state);
    }
    if (project && !existingProject && findSelectableProjectByTitleAndArea(state._allProjects, project.title, project.areaId)) return null;
    const projects = project && !existingProject ? [...state._allProjects, project] : state._allProjects;
    if (task.projectId && !projects.some((entry) => entry.id === task.projectId && isSelectableProjectForTaskAssignment(entry))) return null;
    if (project?.areaId && !state._allAreas.some((entry) => entry.id === project.areaId && !entry.deletedAt)) return null;
    const container = resolveTaskContainerAssignment({ projectId: task.projectId, sectionId: task.sectionId, areaId: task.areaId,
        allProjects: projects, allSections: state._allSections, allAreas: state._allAreas });
    if (!container.ok || container.projectId !== task.projectId || container.sectionId !== task.sectionId || container.areaId !== task.areaId) return null;
    const tasks = [...state._allTasks, task];
    const settings = retainTaskTaxonomy(!state.settings.deviceId && deviceIdToInitialize
        ? { ...state.settings, deviceId: deviceIdToInitialize } : state.settings, undefined, task);
    return { tasks, projects, settings, changed: true };
}

export function applyPreparedCaptureLinesData(state: Collections,
    { tasks: preparedTasks, projects: preparedProjects, deviceIdToInitialize }: { tasks: Task[]; projects: Project[]; deviceIdToInitialize: string | null }): Result | null {
    const currentTasks = new Map(state._allTasks.map((task) => [task.id, task]));
    const currentProjects = new Map(state._allProjects.map((project) => [project.id, project]));
    const operationProjects = new Set(preparedProjects.map((project) => project.id));
    const missingTasks: Task[] = [], missingProjects: Project[] = [];
    for (const task of preparedTasks) {
        const existing = currentTasks.get(task.id);
        if (existing) {
            if (existing.deletedAt || existing.purgedAt || JSON.stringify(taskToSqliteRow(existing)) !== JSON.stringify(taskToSqliteRow(task))
                || task.projectId && operationProjects.has(task.projectId) && !currentProjects.has(task.projectId)) return null;
        } else { missingTasks.push(task); }
    }
    for (const project of preparedProjects) {
        const existing = currentProjects.get(project.id);
        if (existing) {
            if (existing.deletedAt || existing.purgedAt || JSON.stringify(projectToSqliteRow(existing)) !== JSON.stringify(projectToSqliteRow(project))) return null;
        } else { missingProjects.push(project); }
    }
    if (!missingTasks.length && !missingProjects.length) return unchanged(state);
    const projects = [...state._allProjects];
    for (const project of missingProjects) {
        if (findSelectableProjectByTitleAndArea(projects, project.title, project.areaId)
            || project.areaId && !state._allAreas.some((area) => area.id === project.areaId && !area.deletedAt)) return null;
        projects.push(project);
    }
    for (const task of missingTasks) {
        if (task.projectId && !projects.some((project) => project.id === task.projectId && isSelectableProjectForTaskAssignment(project))) return null;
        const container = resolveTaskContainerAssignment({ projectId: task.projectId, sectionId: task.sectionId, areaId: task.areaId,
            allProjects: projects, allSections: state._allSections, allAreas: state._allAreas });
        if (!container.ok || container.projectId !== task.projectId || container.sectionId !== task.sectionId || container.areaId !== task.areaId) return null;
    }
    const tasks = [...state._allTasks, ...missingTasks];
    const settings = retainTaxonomyEffects(!state.settings.deviceId && deviceIdToInitialize
        ? { ...state.settings, deviceId: deviceIdToInitialize } : state.settings,
        missingTasks.map((after) => ({ after })), missingProjects.map((after) => ({ after })));
    return { tasks, projects, settings, changed: true };
}
