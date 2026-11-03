import { getProjectAccentColor } from '@mindwtr/core';
import {
    buildCompletionDateSections,
    compareProjectsByOrder,
    DEFAULT_AREA_COLOR,
    getContextColor,
    groupTasksByContext as groupCoreTasksByContext,
    groupTasksByTag as groupCoreTasksByTag,
    groupTasksByViewSection,
    tFallback,
    baseTextCollator,
} from '@mindwtr/core';
import type { Area, Project, Task, TaskEnergyLevel, TaskPriority, TaskStatus, ViewSectionDefinition } from '@mindwtr/core';


export const FOCUS_AXES = ['none', 'context', 'area', 'project', 'tag', 'energy', 'priority', 'person'] as const;
export type NextGroupBy = typeof FOCUS_AXES[number];

export const SOMEDAY_AXES = [...FOCUS_AXES, 'viewSection'] as const;
export type SomedayGroupBy = typeof SOMEDAY_AXES[number];

export const REFERENCE_AXES = ['none', 'context', 'area', 'project', 'tag'] as const;
export type ReferenceGroupBy = typeof REFERENCE_AXES[number];


export const DONE_AXES = ['none', 'completedDate', 'context', 'area', 'project', 'tag'] as const;
export type DoneGroupBy = typeof DONE_AXES[number];

export type TaskListGroupBy = NextGroupBy | SomedayGroupBy | ReferenceGroupBy | DoneGroupBy;


export const LIST_AXES: readonly TaskListGroupBy[] = Array.from(
    new Set<TaskListGroupBy>([...FOCUS_AXES, ...SOMEDAY_AXES, ...REFERENCE_AXES, ...DONE_AXES]),
);


export const CONTEXTS_AXES = ['none', 'status', 'tag', 'context', 'area', 'project'] as const;
export type ContextsGroupBy = typeof CONTEXTS_AXES[number];


export interface TaskGroup {
    id: string;
    title: string;
    tasks: Task[];

    projects?: Project[];
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
    return groupCoreTasksByContext({ tasks, noContextLabel }).map((group) => (
        group.muted ? group : { ...group, dotColor: getContextColor(group.title, theme) }
    ));
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


            dotColor: getProjectAccentColor(project, areaById) ?? DEFAULT_AREA_COLOR,
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
    return groupCoreTasksByTag({ tasks, noTagLabel }).map((group) => (
        group.muted ? group : { ...group, dotColor: getContextColor(group.title, theme) }
    ));
}


export type TaskGroupAxis = TaskListGroupBy | ContextsGroupBy;

export type GroupTasksInputs = {
    tasks: Task[];
    areas: Area[];
    projectMap: Map<string, Project>;
    t: (key: string) => string;

    theme?: string;
    viewSectionDefinitions?: readonly ViewSectionDefinition[];
};


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


export function sanitizeAxis<Axis extends TaskGroupAxis>(
    axes: readonly Axis[],
    value: unknown,
    fallback: Axis,
): Axis {
    return axes.includes(value as Axis) ? value as Axis : fallback;
}


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
