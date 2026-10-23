import { buildProjectTaskListModel, type ProjectSyntheticSection, type ProjectTaskListModelInput } from './project-task-list-model';
import type { Project, Section, Task, TaskSortBy } from './types';

export type ProjectTaskReorderListItem<T> =
    | { type: 'section'; id: string; muted?: boolean; title?: string; synthetic?: ProjectSyntheticSection }
    | { type: 'task'; reorderSectionId?: string | null; task: T };

export type ProjectTaskReorderGroup<T> = {
    id: string;
    muted?: boolean;
    sectionId?: string | null;
    tasks: T[];
    title?: string;
};

export function buildProjectTaskReorderGroups<T>(
    items: ProjectTaskReorderListItem<T>[],
    options: { includeEmptySections?: boolean } = {},
): ProjectTaskReorderGroup<T>[] {
    const groups: ProjectTaskReorderGroup<T>[] = [];
    let currentGroup: ProjectTaskReorderGroup<T> | null = null;

    items.forEach((item) => {
        if (item.type === 'section') {
            currentGroup = {
                id: item.id,
                muted: item.muted,
                sectionId: item.synthetic === 'none' ? null : item.id,
                tasks: [],
                title: item.title,
            };
            groups.push(currentGroup);
            return;
        }

        if (!currentGroup) {
            currentGroup = {
                id: 'project',
                sectionId: item.reorderSectionId,
                tasks: [],
            };
            groups.push(currentGroup);
        }
        currentGroup.tasks.push(item.task);
    });

    return options.includeEmptySections
        ? groups
        : groups.filter((group) => group.tasks.length > 0);
}

export type ProjectReorderFlatItem<T> =
    | { type: 'header'; key: string; group: ProjectTaskReorderGroup<T> }
    | { type: 'task'; key: string; task: T };

export function flattenProjectReorderGroups<T extends { id: string }>(
    groups: ProjectTaskReorderGroup<T>[],
): ProjectReorderFlatItem<T>[] {
    const items: ProjectReorderFlatItem<T>[] = [];
    groups.forEach((group) => {
        if (group.title) {
            items.push({ type: 'header', key: `section:${group.id}`, group });
        }
        group.tasks.forEach((task) => {
            items.push({ type: 'task', key: `task:${task.id}`, task });
        });
    });
    return items;
}

export type ProjectReorderDropPlan = {
    sectionId: string | null;
    orderedIds: string[];
};

export function resolveProjectReorderDropPlan<T extends { id: string }>(
    data: ProjectReorderFlatItem<T>[],
    movedTaskId: string,
): ProjectReorderDropPlan | null {
    let currentSection: string | null = null;
    const buckets = new Map<string | null, string[]>();
    for (const item of data) {
        if (item.type === 'header') {
            currentSection = item.group.sectionId ?? null;
            continue;
        }
        const bucket = buckets.get(currentSection) ?? [];
        bucket.push(item.task.id);
        buckets.set(currentSection, bucket);
    }
    for (const [sectionId, orderedIds] of buckets) {
        if (orderedIds.includes(movedTaskId)) {
            return { sectionId, orderedIds };
        }
    }
    return null;
}

export function buildProjectTaskReorderModel(input: ProjectTaskListModelInput): {
    groups: ProjectTaskReorderGroup<Task>[];
    items: ProjectReorderFlatItem<Task>[];
} {
    const model = buildProjectTaskListModel({ ...input, reorderMode: true });
    const reorderItems = input.groupCompletedTasksLast && input.statusFilter === 'all'
        ? model.items.filter((item) => item.type === 'section'
            ? item.synthetic !== 'completed' : item.task.status !== 'done')
        : model.items;
    const groups = buildProjectTaskReorderGroups(reorderItems, { includeEmptySections: model.sections.length > 0 });
    return { groups, items: flattenProjectReorderGroups(groups) };
}

export type ProjectTaskOrderIdentity =
    | { type: 'section'; id: string; sectionId: string | null }
    | { type: 'task'; id: string };
export type ProjectTaskOrderAnchor = { type: 'section' | 'task'; id: string } | null;

export const projectTaskOrderIdentities = (items: ProjectReorderFlatItem<Task>[]): ProjectTaskOrderIdentity[] =>
    items.map((item) => item.type === 'header'
        ? { type: 'section', id: item.group.id, sectionId: item.group.sectionId ?? null }
        : { type: 'task', id: item.task.id });

/** An exact, compact precondition; text/Notes do not enter the ordering identity. */
export function projectTaskOrderToken(input: {
    project: Project; sections: readonly Section[]; tasks: readonly Task[];
    sortBy: TaskSortBy; items: readonly ProjectTaskOrderIdentity[];
}): string {
    const { project } = input;
    const byId = <T extends { id: string }>(rows: readonly T[]) => [...rows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return JSON.stringify({
        project: { id: project.id, status: project.status, isSequential: project.isSequential ?? null,
            sequentialScope: project.sequentialScope ?? null, taskSortBy: project.taskSortBy ?? null,
            ...(project.perSectionFlow !== undefined ? { perSectionFlow: project.perSectionFlow } : {}) },
        sortBy: input.sortBy,
        sections: byId(input.sections).map((row) => ({ id: row.id, order: row.order })),
        tasks: byId(input.tasks).map((row) => ({ id: row.id, sectionId: row.sectionId ?? null,
            order: row.order ?? null, orderNum: row.orderNum ?? null })),
        // Swift persists the prepared envelope with sorted JSON keys. Rebuild
        // each identity so that roundtrip cannot change this exact token.
        items: input.items.map((item) => item.type === 'section'
            ? { type: 'section', id: item.id, sectionId: item.sectionId }
            : { type: 'task', id: item.id }),
    });
}

/** Move a task after a typed predecessor, then ask RN's drop resolver for its destination. */
export function planProjectTaskOrderMove(
    items: ProjectReorderFlatItem<Task>[], taskId: string, after: ProjectTaskOrderAnchor,
): { items: ProjectReorderFlatItem<Task>[]; drop: ProjectReorderDropPlan; changed: boolean } | null {
    const source = items.findIndex((item) => item.type === 'task' && item.task.id === taskId);
    if (source < 0 || (after?.type === 'task' && after.id === taskId)) return null;
    const next = [...items];
    const [moved] = next.splice(source, 1);
    const predecessor = after === null ? -1 : next.findIndex((item) => after.type === 'section'
        ? item.type === 'header' && item.group.id === after.id
        : item.type === 'task' && item.task.id === after.id);
    if (after !== null && predecessor < 0) return null;
    next.splice(predecessor + 1, 0, moved);
    const drop = resolveProjectReorderDropPlan(next, taskId);
    return drop && { items: next, drop, changed: source !== predecessor + 1 };
}
