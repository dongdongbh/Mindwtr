import {
    buildCompletionDateSections,
    compareProjectsByOrder,
    DEFAULT_AREA_COLOR,
    getContextColor,
    groupTasksByViewSection,
    tFallback,
    baseTextCollator,
} from '@mindwtr/core';
import type { Area, Project, Task, TaskEnergyLevel, TaskPriority, TaskStatus, ViewSectionDefinition } from '@mindwtr/core';

// The rosters are data, and the types are derived from them — never the other
// way round. One array per view is what the dropdown renders AND what the
// persistence sanitizer accepts, so an axis the menu offers can never be one
// the sanitizer silently rewrites to 'none' on the next reload. Adding an axis
// to a view is one entry here plus one `groupTasks` case, nothing else.
// (Same reason `lib/view-url-params.ts` derives URL_KNOWN_VIEWS from
// RESTORABLE_VIEWS instead of restating it.)
// Order is the order users see in the dropdown.
export const FOCUS_AXES = ['none', 'context', 'area', 'project', 'tag', 'energy', 'priority', 'person'] as const;
export type NextGroupBy = typeof FOCUS_AXES[number];

export const SOMEDAY_AXES = [...FOCUS_AXES, 'viewSection'] as const;
export type SomedayGroupBy = typeof SOMEDAY_AXES[number];

export const REFERENCE_AXES = ['none', 'context', 'area', 'project', 'tag'] as const;
export type ReferenceGroupBy = typeof REFERENCE_AXES[number];

// Done is the only list where every task has a completion to group by, so the
// axis lives here rather than in FOCUS_AXES (#945).
export const DONE_AXES = ['none', 'completedDate', 'context', 'area', 'project', 'tag'] as const;
export type DoneGroupBy = typeof DONE_AXES[number];

export type TaskListGroupBy = NextGroupBy | SomedayGroupBy | ReferenceGroupBy | DoneGroupBy;

// Every axis any status list can offer. Collapse state is sanitized against
// this one roster instead of the per-status one, so a list keeps the collapsed
// groups of an axis it no longer shows rather than dropping them silently.
export const LIST_AXES: readonly TaskListGroupBy[] = Array.from(
    new Set<TaskListGroupBy>([...FOCUS_AXES, ...SOMEDAY_AXES, ...REFERENCE_AXES, ...DONE_AXES]),
);

// Contexts and Review both span every status, so status itself is a useful axis
// there (see one #topic across Next / Waiting / Someday / Reference at a glance).
export const CONTEXTS_AXES = ['none', 'status', 'tag', 'context', 'area', 'project'] as const;
export type ContextsGroupBy = typeof CONTEXTS_AXES[number];

// The muted catch-all ("No project", "General", "No context", …) always sorts
// LAST. Grouping is for finding a group, and the ungrouped pile is the least
// specific thing in the list — leading with it pushed every real group below a
// scroll. Priority, energy and person already ended this way; the rest matched
// them (#963).
export interface TaskGroup {
    id: string;
    title: string;
    tasks: Task[];
    muted?: boolean;
    dotColor?: string;
}

interface GroupByAreaParams {
    areas: Area[];
    tasks: Task[];
    projectMap: Map<string, Project>;
    noAreaLabel: string;
}

interface GroupByContextParams {
    tasks: Task[];
    noContextLabel: string;
    /** Active theme, for the token swatch palette only (#974). */
    theme?: string;
}

interface GroupByProjectParams {
    tasks: Task[];
    projectMap: Map<string, Project>;
    noProjectLabel: string;
    areas?: Area[];
}

interface GroupByTagParams {
    tasks: Task[];
    noTagLabel: string;
    /** Active theme, for the token swatch palette only (#974). */
    theme?: string;
}

interface GroupByPriorityParams {
    tasks: Task[];
    getPriorityLabel: (priority: TaskPriority) => string;
    noPriorityLabel: string;
}

interface GroupByEnergyParams {
    tasks: Task[];
    getEnergyLabel: (energy: TaskEnergyLevel) => string;
    noEnergyLabel: string;
}

interface GroupByPersonParams {
    tasks: Task[];
    unassignedLabel: string;
}

const PRIORITY_GROUP_ORDER: TaskPriority[] = ['urgent', 'high', 'medium', 'low'];
const ENERGY_GROUP_ORDER: TaskEnergyLevel[] = ['high', 'medium', 'low'];

export function groupTasksByArea({
    areas,
    tasks,
    projectMap,
    noAreaLabel,
}: GroupByAreaParams): TaskGroup[] {
    const activeAreas = [...areas]
        .filter((area) => !area.deletedAt)
        .sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name));
    const validAreaIds = new Set(activeAreas.map((area) => area.id));
    const grouped = new Map<string, Task[]>();
    const noAreaTasks: Task[] = [];

    tasks.forEach((task) => {
        const projectAreaId = task.projectId ? projectMap.get(task.projectId)?.areaId : undefined;
        const resolvedAreaId = task.areaId || projectAreaId;
        if (resolvedAreaId && validAreaIds.has(resolvedAreaId)) {
            const items = grouped.get(resolvedAreaId) ?? [];
            items.push(task);
            grouped.set(resolvedAreaId, items);
            return;
        }
        noAreaTasks.push(task);
    });

    const groups: TaskGroup[] = [];
    activeAreas.forEach((area) => {
        const areaTasks = grouped.get(area.id) ?? [];
        if (areaTasks.length === 0) return;
        groups.push({
            id: `area:${area.id}`,
            title: area.name,
            tasks: areaTasks,
            dotColor: area.color || DEFAULT_AREA_COLOR,
        });
    });

    if (noAreaTasks.length > 0) {
        groups.push({
            // id stays 'general' so persisted collapse state survives the label rename
            id: 'general',
            title: noAreaLabel,
            tasks: noAreaTasks,
            muted: true,
        });
    }
    return groups;
}

export function groupTasksByContext({
    tasks,
    noContextLabel,
    theme,
}: GroupByContextParams): TaskGroup[] {
    const grouped = new Map<string, Task[]>();
    const noContextTasks: Task[] = [];

    tasks.forEach((task) => {
        const contexts = (task.contexts ?? [])
            .map((value) => value.trim())
            .filter((value) => value.length > 0);
        if (contexts.length === 0) {
            noContextTasks.push(task);
            return;
        }
        Array.from(new Set(contexts)).forEach((context) => {
            const contextTasks = grouped.get(context) ?? [];
            contextTasks.push(task);
            grouped.set(context, contextTasks);
        });
    });

    const groups: TaskGroup[] = [];
    const sortedContexts = [...grouped.keys()].sort((a, b) =>
        baseTextCollator.compare(a, b)
    );
    sortedContexts.forEach((context) => {
        const contextTasks = grouped.get(context) ?? [];
        groups.push({
            id: `context:${context}`,
            title: context,
            tasks: contextTasks,
            dotColor: getContextColor(context, theme),
        });
    });

    if (noContextTasks.length > 0) {
        groups.push({
            id: 'context:none',
            title: noContextLabel,
            tasks: noContextTasks,
            muted: true,
        });
    }
    return groups;
}

export function groupTasksByPriority({
    tasks,
    getPriorityLabel,
    noPriorityLabel,
}: GroupByPriorityParams): TaskGroup[] {
    const grouped = new Map<TaskPriority, Task[]>();
    const noPriorityTasks: Task[] = [];

    tasks.forEach((task) => {
        if (!task.priority) {
            noPriorityTasks.push(task);
            return;
        }
        const priorityTasks = grouped.get(task.priority) ?? [];
        priorityTasks.push(task);
        grouped.set(task.priority, priorityTasks);
    });

    const groups: TaskGroup[] = [];
    PRIORITY_GROUP_ORDER.forEach((priority) => {
        const priorityTasks = grouped.get(priority) ?? [];
        if (priorityTasks.length === 0) return;
        groups.push({
            id: `priority:${priority}`,
            title: getPriorityLabel(priority),
            tasks: priorityTasks,
        });
    });

    if (noPriorityTasks.length > 0) {
        groups.push({
            id: 'priority:none',
            title: noPriorityLabel,
            tasks: noPriorityTasks,
            muted: true,
        });
    }

    return groups;
}

export function groupTasksByEnergy({
    tasks,
    getEnergyLabel,
    noEnergyLabel,
}: GroupByEnergyParams): TaskGroup[] {
    const grouped = new Map<TaskEnergyLevel, Task[]>();
    const noEnergyTasks: Task[] = [];

    tasks.forEach((task) => {
        if (!task.energyLevel) {
            noEnergyTasks.push(task);
            return;
        }
        const energyTasks = grouped.get(task.energyLevel) ?? [];
        energyTasks.push(task);
        grouped.set(task.energyLevel, energyTasks);
    });

    const groups: TaskGroup[] = [];
    ENERGY_GROUP_ORDER.forEach((energy) => {
        const energyTasks = grouped.get(energy) ?? [];
        if (energyTasks.length === 0) return;
        groups.push({
            id: `energy:${energy}`,
            title: getEnergyLabel(energy),
            tasks: energyTasks,
        });
    });

    if (noEnergyTasks.length > 0) {
        groups.push({
            id: 'energy:none',
            title: noEnergyLabel,
            tasks: noEnergyTasks,
            muted: true,
        });
    }

    return groups;
}

export function groupTasksByProject({
    tasks,
    projectMap,
    noProjectLabel,
    areas,
}: GroupByProjectParams): TaskGroup[] {
    const grouped = new Map<string, Task[]>();
    const noProjectTasks: Task[] = [];
    const areaById = new Map((areas ?? []).map((area) => [area.id, area]));

    tasks.forEach((task) => {
        if (!task.projectId) {
            noProjectTasks.push(task);
            return;
        }
        const project = projectMap.get(task.projectId);
        if (!project) {
            noProjectTasks.push(task);
            return;
        }
        const projectTasks = grouped.get(project.id) ?? [];
        projectTasks.push(task);
        grouped.set(project.id, projectTasks);
    });

    const groups: TaskGroup[] = [];
    const sortedProjects = [...grouped.keys()]
        .map((projectId) => projectMap.get(projectId))
        .filter((project): project is Project => Boolean(project))
        .sort(compareProjectsByOrder);

    sortedProjects.forEach((project) => {
        const projectTasks = grouped.get(project.id) ?? [];
        groups.push({
            id: `project:${project.id}`,
            title: project.title,
            tasks: projectTasks,
            // Same precedence the task rows' project chips and the Agenda's
            // project dots use: the area color is the identity color, the
            // project's own color is the fallback — a header dot must not
            // disagree with the chips right under it.
            dotColor: (project.areaId ? areaById.get(project.areaId)?.color : undefined) || project.color,
        });
    });

    if (noProjectTasks.length > 0) {
        groups.push({
            id: 'project:none',
            title: noProjectLabel,
            tasks: noProjectTasks,
            muted: true,
        });
    }
    return groups;
}

export function groupTasksByPerson({
    tasks,
    unassignedLabel,
}: GroupByPersonParams): TaskGroup[] {
    const grouped = new Map<string, { name: string; tasks: Task[] }>();
    const unassignedTasks: Task[] = [];

    tasks.forEach((task) => {
        const name = task.assignedTo?.trim();
        if (!name) {
            unassignedTasks.push(task);
            return;
        }
        const key = name.toLowerCase();
        const entry = grouped.get(key) ?? { name, tasks: [] };
        entry.tasks.push(task);
        grouped.set(key, entry);
    });

    const groups: TaskGroup[] = [];
    const sortedPeople = [...grouped.values()].sort((a, b) =>
        baseTextCollator.compare(a.name, b.name)
    );
    sortedPeople.forEach((entry) => {
        groups.push({
            id: `person:${entry.name.toLowerCase()}`,
            title: entry.name,
            tasks: entry.tasks,
        });
    });
    if (unassignedTasks.length > 0) {
        groups.push({
            id: 'person:none',
            title: unassignedLabel,
            tasks: unassignedTasks,
            muted: true,
        });
    }
    return groups;
}

interface GroupByStatusParams {
    tasks: Task[];
    getStatusLabel: (status: TaskStatus) => string;
}

const STATUS_GROUP_ORDER: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'];

export function groupTasksByStatus({
    tasks,
    getStatusLabel,
}: GroupByStatusParams): TaskGroup[] {
    const grouped = new Map<TaskStatus, Task[]>();

    tasks.forEach((task) => {
        const statusTasks = grouped.get(task.status) ?? [];
        statusTasks.push(task);
        grouped.set(task.status, statusTasks);
    });

    const groups: TaskGroup[] = [];
    STATUS_GROUP_ORDER.forEach((status) => {
        const statusTasks = grouped.get(status) ?? [];
        if (statusTasks.length === 0) return;
        groups.push({
            id: `status:${status}`,
            title: getStatusLabel(status),
            tasks: statusTasks,
        });
    });
    return groups;
}

export function groupTasksByTag({
    tasks,
    noTagLabel,
    theme,
}: GroupByTagParams): TaskGroup[] {
    const grouped = new Map<string, Task[]>();
    const noTagTasks: Task[] = [];

    tasks.forEach((task) => {
        const tags = (task.tags ?? [])
            .map((value) => value.trim())
            .filter((value) => value.length > 0);
        if (tags.length === 0) {
            noTagTasks.push(task);
            return;
        }
        Array.from(new Set(tags)).forEach((tag) => {
            const tagTasks = grouped.get(tag) ?? [];
            tagTasks.push(task);
            grouped.set(tag, tagTasks);
        });
    });

    const groups: TaskGroup[] = [];
    const sortedTags = [...grouped.keys()].sort((a, b) =>
        baseTextCollator.compare(a, b)
    );
    sortedTags.forEach((tag) => {
        const tagTasks = grouped.get(tag) ?? [];
        groups.push({
            id: `tag:${tag}`,
            title: tag,
            tasks: tagTasks,
            dotColor: getContextColor(tag, theme),
        });
    });

    if (noTagTasks.length > 0) {
        groups.push({
            id: 'tag:none',
            title: noTagLabel,
            tasks: noTagTasks,
            muted: true,
        });
    }
    return groups;
}

/**
 * Every axis any view offers — the union of the rosters above, so a new roster
 * entry lands here (and therefore in the `groupTasks` switch below, which the
 * compiler checks for exhaustiveness) automatically.
 */
export type TaskGroupAxis = TaskListGroupBy | ContextsGroupBy;

export type GroupTasksInputs = {
    tasks: Task[];
    areas: Area[];
    projectMap: Map<string, Project>;
    t: (key: string) => string;
    /** Active theme, for the context/tag swatch palette only (#974). */
    theme?: string;
    viewSectionDefinitions?: readonly ViewSectionDefinition[];
};

/**
 * One dispatch for every grouped list: axis in, groups out, i18n label wiring
 * included. Views declare which axes they offer and where the choice
 * persists — nothing else.
 */
export function groupTasks(axis: TaskGroupAxis, { tasks, areas, projectMap, t, theme, viewSectionDefinitions }: GroupTasksInputs): TaskGroup[] {
    switch (axis) {
        case 'none':
            return [];
        case 'status':
            return groupTasksByStatus({ tasks, getStatusLabel: (status) => t(`status.${status}`) });
        case 'area':
            return groupTasksByArea({ areas, tasks, projectMap, noAreaLabel: tFallback(t, 'taskEdit.noAreaOption', 'No Area') });
        case 'project':
            return groupTasksByProject({ tasks, projectMap, areas, noProjectLabel: tFallback(t, 'taskEdit.noProjectOption', 'No project') });
        case 'priority':
            return groupTasksByPriority({ tasks, getPriorityLabel: (priority) => t(`priority.${priority}`), noPriorityLabel: tFallback(t, 'focus.group.noPriority', 'No priority') });
        case 'energy':
            return groupTasksByEnergy({ tasks, getEnergyLabel: (energy) => t(`energyLevel.${energy}`), noEnergyLabel: tFallback(t, 'focus.group.noEnergy', 'No energy') });
        case 'person':
            return groupTasksByPerson({ tasks, unassignedLabel: tFallback(t, 'people.unassigned', 'Unassigned') });
        case 'tag':
            return groupTasksByTag({ tasks, noTagLabel: tFallback(t, 'projects.noTags', 'No tags'), theme });
        case 'context':
            return groupTasksByContext({ tasks, noContextLabel: tFallback(t, 'contexts.none', 'No context'), theme });
        case 'completedDate':
            // Bucketing and labels live in core so Done/Archive read the same
            // on both platforms (#959).
            return buildCompletionDateSections({ tasks, t });
        case 'viewSection':
            return groupTasksByViewSection(
                tasks,
                'someday',
                viewSectionDefinitions,
                tFallback(t, 'viewSections.noSection', 'No section'),
            );
    }
}

export function getGroupAxisLabel(axis: TaskGroupAxis, t: (key: string) => string): string {
    switch (axis) {
        case 'none': return tFallback(t, 'list.groupByNone', 'No grouping');
        case 'completedDate': return tFallback(t, 'list.groupByCompletedDate', 'Completion date');
        case 'status': return tFallback(t, 'taskEdit.statusLabel', 'Status');
        case 'context': return tFallback(t, 'list.groupByContext', 'Context');
        case 'area': return tFallback(t, 'list.groupByArea', 'Area');
        case 'project': return tFallback(t, 'list.groupByProject', 'Project');
        case 'tag': return tFallback(t, 'taskEdit.tagsLabel', 'Tags');
        case 'priority': return tFallback(t, 'filters.priority', 'Priority');
        case 'energy': return tFallback(t, 'focus.group.energy', 'Energy');
        case 'person': return tFallback(t, 'people.title', 'People');
        case 'viewSection': return tFallback(t, 'viewSections.somedaySection', 'Someday section');
    }
}

/**
 * A persisted axis in, a valid one out — checked against the same array the
 * dropdown renders, so a stored choice the menu offers is never rejected.
 */
export function sanitizeAxis<Axis extends TaskGroupAxis>(
    axes: readonly Axis[],
    value: unknown,
    fallback: Axis,
): Axis {
    return axes.includes(value as Axis) ? value as Axis : fallback;
}

/** Collapsed group ids per axis. Deliberately not `Partial`: see below. */
export type CollapsedGroups<Axis extends TaskGroupAxis> = Record<Exclude<Axis, 'none'>, string[]>;

type CollapseKey<Axis extends TaskGroupAxis> = Exclude<Axis, 'none'>;

export function emptyCollapsedGroups<Axis extends TaskGroupAxis>(
    axes: readonly Axis[],
): CollapsedGroups<Axis> {
    const state = {} as CollapsedGroups<Axis>;
    axes.forEach((axis) => {
        if (axis === 'none') return;
        state[axis as CollapseKey<Axis>] = [];
    });
    return state;
}

/**
 * Collapse state for every axis in the roster.
 *
 * Iterating the roster is the whole point. This used to be a hand-written
 * `Partial<Record<Axis, string[]>>` literal per view, and because it was
 * `Partial`, omitting an axis compiled clean — a new axis's collapse state was
 * dropped on every read with nothing to catch it. Driving both the default and
 * the sanitizer off the array means a new axis is covered the moment it is
 * added to the roster.
 */
export function sanitizeCollapsedGroups<Axis extends TaskGroupAxis>(
    axes: readonly Axis[],
    value: unknown,
    fallback: CollapsedGroups<Axis>,
): CollapsedGroups<Axis> {
    const stored: Record<string, unknown> = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
    const state = {} as CollapsedGroups<Axis>;
    axes.forEach((axis) => {
        if (axis === 'none') return;
        const key = axis as CollapseKey<Axis>;
        const ids = stored[axis];
        state[key] = Array.isArray(ids)
            ? Array.from(new Set(ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)))
            : fallback[key] ?? [];
    });
    return state;
}
