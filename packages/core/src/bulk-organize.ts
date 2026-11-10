import type { Task, TaskStatus } from './types';

export type BulkOrganizeStatus = Exclude<TaskStatus, 'archived'>;

export type BulkOrganizeTaskUpdateInput = {

    status?: BulkOrganizeStatus;
    projectId?: string | null;


    sectionId?: string | null;

    sectionProjectId?: string | null;
    areaId?: string | null;
    contexts?: string[];
    tags?: string[];
    startTime?: string | null;
    dueDate?: string | null;
    reviewAt?: string | null;
    assignedTo?: string | null;
};

export function parseBulkOrganizeTokenInput(value: string, prefix: '@' | '#'): string[] {
    return Array.from(new Set(
        value
            .split(/[\s,]+/)
            .map((token) => token.trim())
            .filter(Boolean)
            .map((token) => (token.startsWith(prefix) ? token : `${prefix}${token}`)),
    ));
}

const mergeTokens = (existing: string[] | undefined, incoming: string[] | undefined): string[] | undefined => {
    if (!incoming || incoming.length === 0) return undefined;
    return Array.from(new Set([...(existing ?? []), ...incoming]));
};

const hasOwn = <T extends object, K extends PropertyKey>(value: T, key: K): value is T & Record<K, unknown> => (
    Object.prototype.hasOwnProperty.call(value, key)
);

const normalizedOptionalString = (value: string | null | undefined): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

const isTaskMap = (
    value: ReadonlyMap<string, Task> | Record<string, Task | undefined>,
): value is ReadonlyMap<string, Task> => (
    typeof (value as ReadonlyMap<string, Task>).get === 'function'
);

export function buildBulkOrganizeTaskUpdate(
    task: Pick<Task, 'contexts' | 'tags' | 'projectId'>,
    input: BulkOrganizeTaskUpdateInput,
): Partial<Task> {
    const updates: Partial<Task> = {};
    if (input.status) {
        updates.status = input.status;
    }

    const hasProjectChoice = hasOwn(input, 'projectId');
    const hasAreaChoice = hasOwn(input, 'areaId');
    const projectId = normalizedOptionalString(input.projectId);
    const areaId = normalizedOptionalString(input.areaId);

    if (hasProjectChoice) {
        updates.projectId = projectId;
        if (projectId) {
            updates.areaId = undefined;
        }
    }

    if (!projectId && hasAreaChoice) {
        updates.areaId = areaId;
        if (areaId) {
            updates.projectId = undefined;
        }
    }

    if (hasOwn(input, 'sectionId')) {
        const sectionId = normalizedOptionalString(input.sectionId);

        const effectiveProjectId = hasOwn(updates, 'projectId')
            ? updates.projectId
            : normalizedOptionalString(task.projectId);
        if (!sectionId) {
            updates.sectionId = undefined;
        } else if (effectiveProjectId && effectiveProjectId === normalizedOptionalString(input.sectionProjectId)) {
            updates.sectionId = sectionId;
        }


    }

    const contexts = mergeTokens(task.contexts, input.contexts);
    if (contexts) updates.contexts = contexts;

    const tags = mergeTokens(task.tags, input.tags);
    if (tags) updates.tags = tags;

    if (hasOwn(input, 'startTime')) updates.startTime = normalizedOptionalString(input.startTime);
    if (hasOwn(input, 'dueDate')) updates.dueDate = normalizedOptionalString(input.dueDate);
    if (hasOwn(input, 'reviewAt')) updates.reviewAt = normalizedOptionalString(input.reviewAt);
    if (hasOwn(input, 'assignedTo')) updates.assignedTo = normalizedOptionalString(input.assignedTo);

    return updates;
}

export function buildBulkOrganizeTaskUpdates(
    taskIds: readonly string[],
    tasksById: ReadonlyMap<string, Task> | Record<string, Task | undefined>,
    input: BulkOrganizeTaskUpdateInput,
): Array<{ id: string; updates: Partial<Task> }> {
    return taskIds.flatMap((id) => {
        const task = isTaskMap(tasksById) ? tasksById.get(id) : tasksById[id];
        if (!task) return [];
        const updates = buildBulkOrganizeTaskUpdate(task, input);


        if (Object.keys(updates).length === 0) return [];
        return [{ id, updates }];
    });
}
