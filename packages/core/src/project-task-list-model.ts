import { tFallback } from './i18n';
import { getProjectSectionsForView } from './project-utils';
import { createReferenceSearchPredicate } from './reference';
import { taskMatchesFilterSelections } from './task-filter-selections';
import { compareTasksByProjectOrder, getProjectFlowMode, sortDoneTasksForListView, sortTasksBy, splitCompletedTasks } from './task-utils';
import type { FilterCriteria, Project, Section, Task, TaskSortBy, TaskStatus } from './types';


export const PROJECT_NO_SECTION_ID = 'no-section';

export const PROJECT_COMPLETED_SECTION_ID = 'project-completed-tasks';

export const PROJECT_REFERENCE_SECTION_ID = 'project-reference-tasks';

export type ProjectSyntheticSection = 'none' | 'completed' | 'reference';


export function getProjectSyntheticSectionIds(sections: readonly Pick<Section, 'id'>[]): Record<ProjectSyntheticSection, string> {
    const used = new Set(sections.map(({ id }) => id));
    const allocate = (base: string) => {
        let id = base;
        for (let suffix = 1; used.has(id); suffix++) id = `${base}:${suffix}`;
        used.add(id);
        return id;
    };
    return {
        none: allocate(PROJECT_NO_SECTION_ID),
        completed: allocate(PROJECT_COMPLETED_SECTION_ID),
        reference: allocate(PROJECT_REFERENCE_SECTION_ID),
    };
}

export type ProjectTaskListItem =
    | { type: 'section'; id: string; title: string; count: number; muted?: boolean; collapsible?: boolean; collapsed?: boolean; synthetic?: ProjectSyntheticSection;

        flowLabel?: string }

    | { type: 'task'; task: Task; reorderSectionId?: string | null };

export type ProjectTaskListModel = {
    items: ProjectTaskListItem[];

    orderedTasks: Task[];

    sections: Section[];
};

export type ProjectTaskListModelInput = {

    project: Pick<Project, 'id' | 'status'> & { tagIds?: readonly string[] }
        & Partial<Pick<Project, 'isSequential' | 'perSectionFlow'>>;

    tasks: readonly Task[];

    visibleTasks: readonly Task[];
    sections: readonly Section[];
    allSections: readonly Section[];
    statusFilter: TaskStatus | 'all';
    criteria: FilterCriteria;
    searchQuery: string;
    sortBy: TaskSortBy;

    projectOrder: boolean;

    reorderMode: boolean;

    groupCompletedTasksLast: boolean;
    completedCollapsed: boolean;
    t: (key: string) => string;
};


export function sortProjectTasksByOrder<T extends { createdAt: string; id: string; order?: number; orderNum?: number }>(tasks: readonly T[]): T[] {
    return [...tasks].sort(compareTasksByProjectOrder);
}


export function getProjectDetailTaskListOptions(
    selectedProject: Pick<Project, 'status' | 'isSequential' | 'perSectionFlow'> | null,
    showCompletedTasks = false,
) {
    const isArchived = selectedProject?.status === 'archived';
    return {
        allowAdd: !isArchived,
        enableProjectReorder: !isArchived,
        includeArchived: isArchived || showCompletedTasks,
        includeDone: isArchived || showCompletedTasks,

        groupCompletedTasksLast: !isArchived && showCompletedTasks
            && (!selectedProject || getProjectFlowMode(selectedProject) === 'parallel'),
        readOnly: isArchived,
    };
}


export function selectProjectTaskListTasks(
    tasks: readonly Task[],
    options: {
        projectId: string;
        statusFilter: TaskStatus | 'all';
        includeArchived: boolean;
        includeDone: boolean;

        isVisible?: (task: Task) => boolean;
    },
): Task[] {
    const { projectId, statusFilter, includeArchived, includeDone, isVisible } = options;
    return tasks.filter((task) => {
        if (task.deletedAt || task.projectId !== projectId) return false;
        if (!includeArchived && task.status === 'archived') return false;
        if (statusFilter === 'all') {
            if (task.status === 'reference') return false;
            if (!includeDone && task.status === 'done') return false;
        } else if (task.status !== statusFilter) {
            return false;
        }
        return isVisible ? isVisible(task) : true;
    });
}

export function buildProjectTaskListModel(input: ProjectTaskListModelInput): ProjectTaskListModel {
    const { project, statusFilter, criteria, searchQuery, sortBy, reorderMode, completedCollapsed, t } = input;
    const referenceSearchPredicate = createReferenceSearchPredicate(statusFilter === 'reference' ? searchQuery : '');
    const listSelections = { criteria, searchQuery: statusFilter === 'reference' ? '' : searchQuery };
    const filteredTasks = input.tasks.filter((task) => (
        referenceSearchPredicate(task) && taskMatchesFilterSelections(task, listSelections)
    ));

    let orderedTasks: Task[];
    if (input.projectOrder && sortBy === 'default') {
        orderedTasks = sortProjectTasksByOrder(filteredTasks);
    } else if (statusFilter === 'done' && sortBy === 'default') {

        orderedTasks = sortDoneTasksForListView(filteredTasks);
    } else {
        orderedTasks = sortTasksBy(filteredTasks, sortBy);
    }

    const groupCompleted = input.groupCompletedTasksLast && statusFilter === 'all';
    let activeTasks = orderedTasks;
    let completedTasks: Task[] = [];
    if (groupCompleted) {
        const split = splitCompletedTasks(orderedTasks);
        activeTasks = split.activeTasks;
        completedTasks = sortBy === 'default' ? sortDoneTasksForListView(split.completedTasks) : split.completedTasks;
    }


    let referenceTasks: Task[] = [];
    if (statusFilter === 'all') {
        const projectTagSet = new Set((project.tagIds || []).map((tag) => String(tag).toLowerCase()));
        const referenceSelections = { criteria, searchQuery };
        const matchingReferences = input.visibleTasks.filter((task) => {
            if (task.deletedAt || task.status !== 'reference') return false;
            const inProject = task.projectId === project.id
                || (projectTagSet.size > 0 && (task.tags || []).some((tag) => projectTagSet.has(String(tag).toLowerCase())));
            return inProject && taskMatchesFilterSelections(task, referenceSelections);
        });
        referenceTasks = sortBy === 'default'
            ? sortProjectTasksByOrder(matchingReferences)
            : sortTasksBy(matchingReferences, sortBy);
    }

    const sections = getProjectSectionsForView(project, input.sections, input.allSections);
    const syntheticIds = getProjectSyntheticSectionIds(sections);

    const appendPiles = (items: ProjectTaskListItem[]): ProjectTaskListItem[] => {
        if (groupCompleted && completedTasks.length > 0) {
            items.push({
                type: 'section',
                id: syntheticIds.completed,
                synthetic: 'completed',
                title: tFallback(t, 'list.done', tFallback(t, 'status.done', 'Completed')),
                count: completedTasks.length,
                muted: true,
                collapsible: true,
                collapsed: completedCollapsed,
            });
            if (!completedCollapsed) {
                completedTasks.forEach((task) => items.push({ type: 'task', task }));
            }
        }
        if (!reorderMode && referenceTasks.length > 0) {
            items.push({
                type: 'section',
                id: syntheticIds.reference,
                synthetic: 'reference',
                title: tFallback(t, 'status.reference', 'Reference'),
                count: referenceTasks.length,
                muted: true,
            });
            referenceTasks.forEach((task) => items.push({ type: 'task', task }));
        }
        return items;
    };

    if (sections.length === 0 && !activeTasks.some((task) => task.sectionId)) {
        return {
            items: appendPiles(activeTasks.map((task): ProjectTaskListItem => ({ type: 'task', task, reorderSectionId: undefined }))),
            orderedTasks,
            sections,
        };
    }

    const sectionIds = new Set(sections.map((section) => section.id));
    const tasksBySection = new Map<string, Task[]>();
    const unsectioned: Task[] = [];
    activeTasks.forEach((task) => {
        const sectionId = task.sectionId && sectionIds.has(task.sectionId) ? task.sectionId : null;
        if (sectionId) {
            const list = tasksBySection.get(sectionId) ?? [];
            list.push(task);
            tasksBySection.set(sectionId, list);
        } else {
            unsectioned.push(task);
        }
    });
    const items: ProjectTaskListItem[] = [];
    const perSection = getProjectFlowMode(project) === 'perSection';
    sections.forEach((section) => {
        const tasksForSection = tasksBySection.get(section.id) ?? [];
        if (tasksForSection.length === 0 && !reorderMode) return;
        items.push({ type: 'section', id: section.id, title: section.title, count: tasksForSection.length,
            ...(perSection ? { flowLabel: section.isSequential === true
                ? tFallback(t, 'projects.sequential', 'Sequential')
                : tFallback(t, 'projects.parallel', 'Parallel') } : {}) });
        tasksForSection.forEach((task) => items.push({ type: 'task', task, reorderSectionId: section.id }));
    });
    if (unsectioned.length > 0) {
        const reorderSectionId = sections.length > 0 ? null : undefined;
        items.push({
            type: 'section',
            id: syntheticIds.none,
            synthetic: 'none',
            title: t('projects.noSection'),
            count: unsectioned.length,
            muted: true,
        });
        unsectioned.forEach((task) => items.push({ type: 'task', task, reorderSectionId }));
    }
    return { items: appendPiles(items), orderedTasks, sections };
}
