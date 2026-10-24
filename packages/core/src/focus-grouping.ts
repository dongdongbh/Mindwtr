import { getProjectAccentColor } from './task-accent-color';
import type { Area, FocusGroupBy, Project, Task, TaskEnergyLevel, TaskPriority } from './types';
import type { ProjectDeadlineBoost } from './task-utils';
import { baseTextCollator } from './task-utils';
import { DEFAULT_AREA_COLOR } from './color-constants';
import { getContextColor } from './context-color';

/**
 * Resolve an i18n key to text, falling back to the supplied English string when
 * the key is missing. Adapters pass `translateWithFallback(t, ...)` bound to
 * their platform's translate function.
 */
export type FocusResolveText = (key: string, fallback: string) => string;

/**
 * One assembled Today's Focus group. `key` is stable across renders (React key
 * and collapse-state identity); each platform renders `label`/`muted`/`tasks`
 * with its own markup. `dotColor` is a decorative bucket-color swatch, present
 * only on the project/area/context/tag axes' named buckets (never a none-bucket
 * or the person/energy/priority axes) — desktop `next-grouping` parity.
 */
export type FocusTaskGroup = {
    key: string;
    label: string;
    tasks: Task[];
    muted?: boolean;
    dotColor?: string;
};

export type BuildFocusTaskGroupsParams = {
    groupBy: FocusGroupBy;
    tasks: Task[];
    projects: Project[];
    areas: Area[];
    resolveText: FocusResolveText;
    /** Active theme, for the context/tag swatch palette only (#974). */
    theme?: string;
};

// Internal shape carrying the ordering key the single-assignment axes sort by.
// The exported groups drop `sortOrder` — callers only need the ordered list.
type OrderedGroupDescriptor = {
    key: string;
    label: string;
    muted?: boolean;
    sortOrder?: number;
    dotColor?: string;
};

const ENERGY_SORT_ORDER: Record<TaskEnergyLevel, number> = { high: 0, medium: 1, low: 2 };
const PRIORITY_SORT_ORDER: Record<TaskPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

function getEnergySortOrder(level: TaskEnergyLevel | undefined): number {
    return level ? ENERGY_SORT_ORDER[level] : 3;
}

function getPrioritySortOrder(priority: TaskPriority | undefined): number {
    return priority ? PRIORITY_SORT_ORDER[priority] : 4;
}

function stripSortOrder(descriptor: OrderedGroupDescriptor, tasks: Task[]): FocusTaskGroup {
    const group: FocusTaskGroup = { key: descriptor.key, label: descriptor.label, tasks };
    if (descriptor.muted) group.muted = true;
    if (descriptor.dotColor) group.dotColor = descriptor.dotColor;
    return group;
}

// Single-assignment axes: every task lands in exactly one group, and groups are
// ordered by `sortOrder` (unspecified sorts last) then label, case-insensitively.
function buildOrderedGroups(
    tasks: Task[],
    resolveGroup: (task: Task) => OrderedGroupDescriptor,
): FocusTaskGroup[] {
    const descriptors = new Map<string, OrderedGroupDescriptor>();
    const grouped = new Map<string, Task[]>();
    tasks.forEach((task) => {
        const descriptor = resolveGroup(task);
        const existing = grouped.get(descriptor.key);
        if (existing) {
            existing.push(task);
            return;
        }
        descriptors.set(descriptor.key, descriptor);
        grouped.set(descriptor.key, [task]);
    });

    return Array.from(descriptors.values())
        .sort((left, right) => {
            const leftOrder = Number.isFinite(left.sortOrder) ? left.sortOrder as number : Number.POSITIVE_INFINITY;
            const rightOrder = Number.isFinite(right.sortOrder) ? right.sortOrder as number : Number.POSITIVE_INFINITY;
            if (leftOrder !== rightOrder) return leftOrder - rightOrder;
            return baseTextCollator.compare(left.label, right.label);
        })
        .map((descriptor) => stripSortOrder(descriptor, grouped.get(descriptor.key) ?? []));
}

// Multi-assignment axes (context, tag): a task with several tokens appears in
// each token's group. The "none" bucket leads (muted); named buckets follow
// alphabetically. No sortOrder — this mirrors the mobile token grouping exactly.
function buildTokenGroups(
    tasks: Task[],
    selectToken: (task: Task) => string[] | undefined,
    keyPrefix: string,
    noneLabel: string,
    theme?: string,
): FocusTaskGroup[] {
    const grouped = new Map<string, Task[]>();
    const noneTasks: Task[] = [];

    tasks.forEach((task) => {
        const tokens = (selectToken(task) ?? [])
            .map((value) => value.trim())
            .filter((value) => value.length > 0);
        if (tokens.length === 0) {
            noneTasks.push(task);
            return;
        }
        Array.from(new Set(tokens)).forEach((token) => {
            const bucket = grouped.get(token) ?? [];
            bucket.push(task);
            grouped.set(token, bucket);
        });
    });

    const groups: FocusTaskGroup[] = [];
    if (noneTasks.length > 0) {
        groups.push({ key: `${keyPrefix}:none`, label: noneLabel, tasks: noneTasks, muted: true });
    }
    [...grouped.keys()]
        .sort((a, b) => baseTextCollator.compare(a, b))
        .forEach((token) => {
            groups.push({
                key: `${keyPrefix}:${token}`,
                label: token,
                tasks: grouped.get(token) ?? [],
                dotColor: getContextColor(token, theme),
            });
        });
    return groups;
}

/**
 * Assemble the grouped Next Actions sections for the Today's Focus surface. Pure
 * (no store, no clock): the axis switch, bucket ordering, and label wiring live
 * here so adding an axis or rewording a bucket is a one-place change. Callers
 * keep their own section rendering.
 */
export function buildFocusTaskGroups({
    groupBy,
    tasks,
    projects,
    areas,
    resolveText,
    theme,
}: BuildFocusTaskGroupsParams): FocusTaskGroup[] {
    switch (groupBy) {
        case 'none':
            return [];
        case 'context':
            return buildTokenGroups(
                tasks,
                (task) => task.contexts,
                'context',
                resolveText('contexts.none', 'No context'),
                theme,
            );
        case 'tag':
            return buildTokenGroups(
                tasks,
                (task) => task.tags,
                'tag',
                resolveText('projects.noTags', 'No tags'),
                theme,
            );
        case 'project': {
            const areaById = new Map(areas.map((area) => [area.id, area]));
            const projectById = new Map(projects.map((project) => [project.id, project]));
            return buildOrderedGroups(tasks, (task) => {
                const project = task.projectId ? projectById.get(task.projectId) : undefined;
                if (!project) {
                    return {
                        key: 'project:none',
                        label: resolveText('taskEdit.noProjectOption', 'No project'),
                        muted: true,
                        sortOrder: -1,
                    };
                }
                return {
                    key: `project:${project.id}`,
                    label: project.title,
                    sortOrder: Number.isFinite(project.order) ? project.order : Number.POSITIVE_INFINITY,
                    dotColor: getProjectAccentColor(project, areaById) ?? DEFAULT_AREA_COLOR,
                };
            });
        }
        case 'area': {
            const projectById = new Map(projects.map((project) => [project.id, project]));
            const areaById = new Map(areas.map((area) => [area.id, area]));
            const noAreaLabel = resolveText('taskEdit.noAreaOption', 'No Area');
            return buildOrderedGroups(tasks, (task) => {
                const project = task.projectId ? projectById.get(task.projectId) : undefined;
                const areaId = project?.areaId ?? task.areaId;
                if (!areaId) {
                    return { key: 'area:none', label: noAreaLabel, muted: true, sortOrder: -1 };
                }
                const area = areaById.get(areaId);
                return {
                    key: `area:${areaId}`,
                    label: area?.name ?? project?.areaTitle ?? noAreaLabel,
                    sortOrder: area && Number.isFinite(area.order) ? area.order : Number.POSITIVE_INFINITY,
                    dotColor: area?.color || DEFAULT_AREA_COLOR,
                };
            });
        }
        case 'energy':
            return buildOrderedGroups(tasks, (task) => (
                task.energyLevel
                    ? {
                        key: `energy:${task.energyLevel}`,
                        label: resolveEnergyLabel(task.energyLevel, resolveText),
                        sortOrder: getEnergySortOrder(task.energyLevel),
                    }
                    : {
                        key: 'energy:none',
                        label: resolveText('focus.group.noEnergy', 'No energy'),
                        muted: true,
                        sortOrder: getEnergySortOrder(undefined),
                    }
            ));
        case 'priority':
            return buildOrderedGroups(tasks, (task) => (
                task.priority
                    ? {
                        key: `priority:${task.priority}`,
                        label: resolvePriorityLabel(task.priority, resolveText),
                        sortOrder: getPrioritySortOrder(task.priority),
                    }
                    : {
                        key: 'priority:none',
                        label: resolveText('focus.group.noPriority', 'No priority'),
                        muted: true,
                        sortOrder: getPrioritySortOrder(undefined),
                    }
            ));
        case 'person':
            return buildOrderedGroups(tasks, (task) => {
                const name = task.assignedTo?.trim();
                return name
                    ? { key: `person:${name.toLowerCase()}`, label: name, sortOrder: 0 }
                    : {
                        // Unassigned sorts after every named person (decided
                        // 2026-07-21, matching desktop).
                        key: 'person:none',
                        label: resolveText('people.unassigned', 'Unassigned'),
                        muted: true,
                        sortOrder: Number.POSITIVE_INFINITY,
                    };
            });
    }
}

const ENERGY_LABEL_FALLBACK: Record<TaskEnergyLevel, string> = {
    low: 'Low energy',
    medium: 'Medium energy',
    high: 'High energy',
};

const PRIORITY_LABEL_FALLBACK: Record<TaskPriority, string> = {
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    urgent: 'Urgent',
};

function resolveEnergyLabel(level: TaskEnergyLevel, resolveText: FocusResolveText): string {
    return resolveText(`energyLevel.${level}`, ENERGY_LABEL_FALLBACK[level]);
}

function resolvePriorityLabel(priority: TaskPriority, resolveText: FocusResolveText): string {
    return resolveText(`priority.${priority}`, PRIORITY_LABEL_FALLBACK[priority]);
}

/**
 * The overdue / due-today badge for a task whose project has a deadline boost.
 * Returns undefined when the task carries no boost.
 */
export function getProjectDeadlineBoostLabel(
    boost: ProjectDeadlineBoost | undefined,
    resolveText: FocusResolveText,
): string | undefined {
    if (!boost) return undefined;
    return boost.isOverdue
        ? resolveText('focus.projectOverdue', 'Project overdue')
        : resolveText('focus.projectDueToday', 'Project due today');
}
