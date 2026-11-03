import { baseTextCollator } from './task-utils';
import type { Project, Task, ViewSectionDefinition, ViewSectionIds, ViewSectionScope } from './types';

export function sortViewSectionDefinitions(
    definitions: readonly ViewSectionDefinition[] | undefined,
): ViewSectionDefinition[] {
    return [...(definitions ?? [])]
        .filter((definition) => (
            typeof definition?.id === 'string'
            && definition.id.trim().length > 0
            && typeof definition.title === 'string'
            && definition.title.trim().length > 0
        ))
        .sort((left, right) => {
            const leftOrder = Number.isFinite(left.order) ? left.order : Number.POSITIVE_INFINITY;
            const rightOrder = Number.isFinite(right.order) ? right.order : Number.POSITIVE_INFINITY;
            return (leftOrder - rightOrder) || baseTextCollator.compare(left.title, right.title);
        });
}

export function resolveTaskViewSection(
    task: { viewSectionIds?: ViewSectionIds },
    scope: ViewSectionScope,
    definitions: readonly ViewSectionDefinition[] | undefined,
): ViewSectionDefinition | undefined {
    const storedId = task.viewSectionIds?.[scope];
    if (typeof storedId !== 'string' || storedId.length === 0) return undefined;
    return definitions?.find((definition) => definition.id === storedId);
}


export function setTaskViewSectionId(
    current: ViewSectionIds | undefined,
    scope: ViewSectionScope,
    sectionId: string | undefined,
): ViewSectionIds {
    const next: Record<string, string> = {};
    if (current && typeof current === 'object') {
        for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
            if (typeof value === 'string' && value.length > 0) next[key] = value;
        }
    }
    if (typeof sectionId === 'string' && sectionId.length > 0) next[scope] = sectionId;
    else delete next[scope];

    const sorted: Record<string, string> = {};
    for (const key of Object.keys(next).sort()) sorted[key] = next[key];
    return sorted as ViewSectionIds;
}

type TaskViewSectionUpdate = { id: string; updates: Pick<Task, 'viewSectionIds'> };


export function buildTaskViewSectionUpdates(
    tasks: readonly Task[],
    scope: ViewSectionScope,
    sectionId?: string,
): TaskViewSectionUpdate[] {
    const destination = sectionId || undefined;
    const seen = new Set<string>();
    return tasks.flatMap((task) => {
        if (seen.has(task.id) || task.deletedAt) return [];
        seen.add(task.id);
        if ((task.viewSectionIds?.[scope] || undefined) === destination) return [];
        return [{
            id: task.id,
            updates: { viewSectionIds: setTaskViewSectionId(task.viewSectionIds, scope, destination) },
        }];
    });
}


export function buildTaskViewSectionUndoUpdates(
    tasks: readonly Task[],
    scope: ViewSectionScope,
    previous: readonly { id: string; sectionId?: string }[],
    expectedSectionId?: string,
): TaskViewSectionUpdate[] {
    const previousById = new Map(previous.map((assignment) => [assignment.id, assignment.sectionId]));
    const expected = expectedSectionId || undefined;
    const seen = new Set<string>();
    return tasks.flatMap((task) => {
        if (seen.has(task.id) || task.deletedAt || !previousById.has(task.id)) return [];
        seen.add(task.id);
        if ((task.viewSectionIds?.[scope] || undefined) !== expected) return [];
        return buildTaskViewSectionUpdates([task], scope, previousById.get(task.id));
    });
}

export interface ViewSectionTaskGroup {
    id: string;
    title: string;
    tasks: Task[];

    projects?: Project[];
    muted?: boolean;
}


export function buildProjectViewSectionUpdate(
    project: Pick<Project, 'viewSectionIds'>,
    scope: ViewSectionScope,
    sectionId?: string,
): Pick<Project, 'viewSectionIds'> | null {
    const destination = sectionId || undefined;
    if ((project.viewSectionIds?.[scope] || undefined) === destination) return null;
    return { viewSectionIds: setTaskViewSectionId(project.viewSectionIds, scope, destination) };
}


export function groupProjectsByViewSection(
    projects: readonly Project[],
    scope: ViewSectionScope,
    definitions: readonly ViewSectionDefinition[] | undefined,
): Map<string, Project[]> {
    const knownIds = new Set(sortViewSectionDefinitions(definitions).map((definition) => definition.id));
    const grouped = new Map<string, Project[]>();
    for (const project of projects) {
        const storedId = project.viewSectionIds?.[scope];
        const key = `view-section:${scope}:${typeof storedId === 'string' && knownIds.has(storedId) ? storedId : ''}`;
        const list = grouped.get(key) ?? [];
        list.push(project);
        grouped.set(key, list);
    }
    return grouped;
}

export function groupTasksByViewSection(
    tasks: readonly Task[],
    scope: ViewSectionScope,
    definitions: readonly ViewSectionDefinition[] | undefined,
    noSectionTitle: string,
): ViewSectionTaskGroup[] {
    const sortedDefinitions = sortViewSectionDefinitions(definitions);
    const knownIds = new Set(sortedDefinitions.map((definition) => definition.id));
    const grouped = new Map<string, Task[]>();
    const noSectionTasks: Task[] = [];

    for (const task of tasks) {
        const storedId = task.viewSectionIds?.[scope];
        if (typeof storedId !== 'string' || !knownIds.has(storedId)) {
            noSectionTasks.push(task);
            continue;
        }
        const sectionTasks = grouped.get(storedId) ?? [];
        sectionTasks.push(task);
        grouped.set(storedId, sectionTasks);
    }

    const result: ViewSectionTaskGroup[] = sortedDefinitions.flatMap((definition) => {
        const sectionTasks = grouped.get(definition.id);
        return sectionTasks?.length
            ? [{ id: `view-section:${scope}:${definition.id}`, title: definition.title, tasks: sectionTasks }]
            : [];
    });
    if (noSectionTasks.length > 0) {
        result.push({
            id: `view-section:${scope}:`,
            title: noSectionTitle,
            tasks: noSectionTasks,
            muted: true,
        });
    }
    return result;
}
