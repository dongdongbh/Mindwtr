import { useTaskStore } from './store';
import type { Section, Task } from './types';
import { projectDeleteUndoReattachments, type DetachedProjectTask } from './store-projects/shared';

export type { DetachedProjectTask } from './store-projects/shared';

export function projectDeleteTaskLinks(projectId: string, sections: readonly Section[],
    tasks: readonly Task[]): DetachedProjectTask[] {
    const sectionIds = new Set(sections.filter((section) => section.projectId === projectId).map((section) => section.id));
    return tasks.filter((task) => !task.deletedAt
        && (task.projectId === projectId || (task.sectionId !== undefined && sectionIds.has(task.sectionId))))
        .map((task) => ({ id: task.id, ...(task.sectionId ? { sectionId: task.sectionId } : {}) }));
}


export function collectProjectTaskLinks(projectId: string): DetachedProjectTask[] {
    const state = useTaskStore.getState();
    return projectDeleteTaskLinks(projectId, state._allSections, state._allTasks);
}


export async function undoProjectDelete(projectId: string, links: readonly DetachedProjectTask[]): Promise<void> {
    const restoreResult = await Promise.resolve(useTaskStore.getState().restoreProject(projectId));
    if (!restoreResult.success) throw new Error(restoreResult.error || 'Failed to restore project');

    const state = useTaskStore.getState();
    const updates = projectDeleteUndoReattachments(projectId, links, state._allSections, state._allTasks);
    if (updates.length === 0) return;
    const attachResult = await Promise.resolve(state.batchUpdateTasks(updates));
    if (!attachResult.success) throw new Error(attachResult.error || 'Failed to restore project tasks');
}
