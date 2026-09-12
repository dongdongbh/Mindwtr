import { isTaskInActiveProject } from './project-utils';
import type { Project, Task, TaskEditorFieldId } from './types';

/** Action metadata stays out of Reference presentation, without changing the entity. */
export const REFERENCE_HIDDEN_TASK_FIELDS = [
    'status', 'startTime', 'dueDate', 'reviewAt', 'recurrence', 'priority',
    'energyLevel', 'timeEstimate', 'checklist', 'contexts', 'location',
] as const satisfies readonly TaskEditorFieldId[];

const normalizeReferenceText = (value: string): string => value.normalize('NFKC').toLowerCase();

/** Compile once per query; Reference search treats every term as literal text. */
export function createReferenceSearchPredicate(query: string): (task: Pick<Task, 'title' | 'description'>) => boolean {
    const terms = [...new Set(normalizeReferenceText(query).trim().split(/\s+/u).filter(Boolean))];
    if (terms.length === 0) return () => true;
    return (task) => {
        const text = normalizeReferenceText(`${task.title}\n${task.description ?? ''}`);
        return terms.every((term) => text.includes(term));
    };
}

/** Historical reference material is opt-in; other project visibility rules stay intact. */
export function isReferenceInVisibleProject(
    task: Task,
    projectLookup: Map<string, Project> | Record<string, Project>,
    includeArchivedProjects = false,
): boolean {
    if (task.status !== 'reference' || task.deletedAt || task.purgedAt) return false;
    const project = task.projectId
        ? projectLookup instanceof Map ? projectLookup.get(task.projectId) : projectLookup[task.projectId]
        : undefined;
    if (project?.deletedAt || project?.purgedAt) return false;
    if (project?.status === 'archived') return includeArchivedProjects;
    return isTaskInActiveProject(task, projectLookup);
}
