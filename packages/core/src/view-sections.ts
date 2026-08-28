import { baseTextCollator } from './task-utils';
import type { Task, ViewSectionDefinition, ViewSectionIds, ViewSectionScope } from './types';

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
    task: Pick<Task, 'viewSectionIds'>,
    scope: ViewSectionScope,
    definitions: readonly ViewSectionDefinition[] | undefined,
): ViewSectionDefinition | undefined {
    const storedId = task.viewSectionIds?.[scope];
    if (typeof storedId !== 'string' || storedId.length === 0) return undefined;
    return definitions?.find((definition) => definition.id === storedId);
}

/**
 * Build an explicit assignment map while preserving future scope keys written by
 * newer clients. Clearing the last known assignment returns {}, not undefined:
 * presence distinguishes an intentional clear from an old-client payload that
 * never carried this field.
 */
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

export interface ViewSectionTaskGroup {
    id: string;
    title: string;
    tasks: Task[];
    muted?: boolean;
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
            id: `view-section:${scope}:none`,
            title: noSectionTitle,
            tasks: noSectionTasks,
            muted: true,
        });
    }
    return result;
}
