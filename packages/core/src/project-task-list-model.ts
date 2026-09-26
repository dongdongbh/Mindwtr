import { tFallback } from './i18n';
import { getProjectSectionsForView } from './project-utils';
import { createReferenceSearchPredicate } from './reference';
import { taskMatchesFilterSelections } from './task-filter-selections';
import { compareTasksByProjectOrder, sortDoneTasksForListView, sortTasksBy, splitCompletedTasks } from './task-utils';
import type { FilterCriteria, Project, Section, Task, TaskSortBy, TaskStatus } from './types';

/**
 * A project's task list, as the project workspace shows it: which tasks, in what
 * order, under which section headers, plus the Completed and Reference piles.
 * Mobile renders it and the native host contract pages it, so both show the
 * same list.
 */

/** Header for tasks with no live section (or a section that no longer exists). */
export const PROJECT_NO_SECTION_ID = 'no-section';
/** The project Completed pile: a screen section, not a grouping heading. */
export const PROJECT_COMPLETED_SECTION_ID = 'project-completed-tasks';
/** The project References pile below the task list, matching desktop's ProjectWorkspace (#1000). */
export const PROJECT_REFERENCE_SECTION_ID = 'project-reference-tasks';

export type ProjectTaskListItem =
    | { type: 'section'; id: string; title: string; count: number; muted?: boolean; collapsible?: boolean; collapsed?: boolean }
    /** `reorderSectionId`: the section a drag lands the task in (null = no section; undefined = not reorderable). */
    | { type: 'task'; task: Task; reorderSectionId?: string | null };

export type ProjectTaskListModel = {
    items: ProjectTaskListItem[];
    /** The listed (non-reference) tasks in display order, before the Completed split. */
    orderedTasks: Task[];
    /** The project's sections, in display order, including empty ones. */
    sections: Section[];
};

export type ProjectTaskListModelInput = {
    /** An archived project reads its archived section history. Its tags pull in tag-matched references. */
    project: Pick<Project, 'id' | 'status'> & { tagIds?: readonly string[] };
    /** The list's tasks, from selectProjectTaskListTasks. */
    tasks: readonly Task[];
    /** Every visible task: a tag-matched reference can live in another project (#1000). */
    visibleTasks: readonly Task[];
    sections: readonly Section[];
    allSections: readonly Section[];
    statusFilter: TaskStatus | 'all';
    criteria: FilterCriteria;
    searchQuery: string;
    sortBy: TaskSortBy;
    /** Use the stored project order only while the caller is explicitly in reorder mode. */
    projectOrder: boolean;
    /** Reorder mode keeps empty sections as drop targets and hides the Reference pile. */
    reorderMode: boolean;
    /** Move finished tasks into the Completed pile (all-status list only). */
    groupCompletedTasksLast: boolean;
    completedCollapsed: boolean;
    t: (key: string) => string;
};

// Delegates to the one core comparator so display, reorder write plans, and
// desktop all sort identically — including the id tie-break that keeps tied
// (order, createdAt) rows from reshuffling with every sync merge (#784).
export function sortProjectTasksByOrder<T extends { createdAt: string; id: string; order?: number; orderNum?: number }>(tasks: readonly T[]): T[] {
    return [...tasks].sort(compareTasksByProjectOrder);
}

/**
 * What a project's own state makes of its task list. Archived projects are read
 * only and show their finished work inline; live ones hide it behind the
 * Completed pile unless the workspace asks for it.
 */
export function getProjectDetailTaskListOptions(
    selectedProject: Pick<Project, 'status' | 'isSequential'> | null,
    showCompletedTasks = false,
) {
    const isArchived = selectedProject?.status === 'archived';
    return {
        allowAdd: !isArchived,
        enableProjectReorder: !isArchived,
        includeArchived: isArchived || showCompletedTasks,
        includeDone: isArchived || showCompletedTasks,
        groupCompletedTasksLast: !isArchived && showCompletedTasks && !selectedProject?.isSequential,
        readOnly: isArchived,
    };
}

/** The project's own tasks that the list may show, before search and filter criteria. */
export function selectProjectTaskListTasks(
    tasks: readonly Task[],
    options: {
        projectId: string;
        statusFilter: TaskStatus | 'all';
        includeArchived: boolean;
        includeDone: boolean;
        /** Extra visibility rule from the caller, such as the mobile area filter. */
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
    if (input.projectOrder && input.reorderMode && sortBy === 'default') {
        // Manual order is used only while the user is explicitly reordering.
        orderedTasks = sortProjectTasksByOrder(filteredTasks);
    } else if (statusFilter === 'done' && sortBy === 'default') {
        // Done is a log: default order is completion date descending, matching desktop.
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
        completedTasks = sortDoneTasksForListView(split.completedTasks);
    }

    // Reference tasks render as their own pile below the list, matching desktop's
    // ProjectWorkspace: the project's own references plus references whose tags
    // match the project's tags (that tag match is how one reference serves
    // several projects) (#1000).
    let referenceTasks: Task[] = [];
    if (statusFilter === 'all') {
        const projectTagSet = new Set((project.tagIds || []).map((tag) => String(tag).toLowerCase()));
        const referenceSelections = { criteria, searchQuery };
        referenceTasks = sortProjectTasksByOrder(input.visibleTasks.filter((task) => {
            if (task.deletedAt || task.status !== 'reference') return false;
            const inProject = task.projectId === project.id
                || (projectTagSet.size > 0 && (task.tags || []).some((tag) => projectTagSet.has(String(tag).toLowerCase())));
            return inProject && taskMatchesFilterSelections(task, referenceSelections);
        }));
    }

    const sections = getProjectSectionsForView(project, input.sections, input.allSections);

    const appendPiles = (items: ProjectTaskListItem[]): ProjectTaskListItem[] => {
        if (groupCompleted && completedTasks.length > 0) {
            items.push({
                type: 'section',
                id: PROJECT_COMPLETED_SECTION_ID,
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
                id: PROJECT_REFERENCE_SECTION_ID,
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
    sections.forEach((section) => {
        const tasksForSection = tasksBySection.get(section.id) ?? [];
        if (tasksForSection.length === 0 && !reorderMode) return;
        items.push({ type: 'section', id: section.id, title: section.title, count: tasksForSection.length });
        tasksForSection.forEach((task) => items.push({ type: 'task', task, reorderSectionId: section.id }));
    });
    if (unsectioned.length > 0) {
        const reorderSectionId = sections.length > 0 ? null : undefined;
        items.push({
            type: 'section',
            id: PROJECT_NO_SECTION_ID,
            title: t('projects.noSection'),
            count: unsectioned.length,
            muted: true,
        });
        unsectioned.forEach((task) => items.push({ type: 'task', task, reorderSectionId }));
    }
    return { items: appendPiles(items), orderedTasks, sections };
}
