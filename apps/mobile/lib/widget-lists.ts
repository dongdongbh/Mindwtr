import {
    compareProjectsByOrder,
    getProjectAccentColor,
    getProjectSectionsForView,
    isTaskActionable,
    sortTasksBy,
    type AppData,
    type Project,
    type Task,
    type TaskSortBy,
} from '@mindwtr/core';

import { sortProjectTasksByOrder } from '@/components/task-list-utils';
import type { FocusTaskLists } from './focus-sections';
import { compareSomedayTasks, compareWaitingTasks } from './list-order';

// The lists a placed Tasks widget can show (#1173): Mindwtr's own GTD lists,
// each in the order its screen uses. `focus` is the sectioned Focus layout
// widget-data.ts already builds; the others are defined here, once.
export const WIDGET_FIXED_LIST_IDS = ['focus', 'inbox', 'next', 'waiting', 'someday'] as const;
export type WidgetFixedListId = (typeof WIDGET_FIXED_LIST_IDS)[number];
export const WIDGET_PROJECT_LIST_PREFIX = 'project:';
export const WIDGET_PROJECT_OPTION_CAP = 50;

const LIST_TITLE_KEYS: Record<WidgetFixedListId, [string, string]> = {
    focus: ['nav.agenda', 'Focus'],
    inbox: ['nav.inbox', 'Inbox'],
    next: ['nav.next', 'Next Actions'],
    waiting: ['nav.waiting', 'Waiting For'],
    someday: ['nav.someday', 'Someday/Maybe'],
};

// The fixed list titles plus the "Projects" group label for the picker.
export function widgetListTitles(tr: Record<string, string>): Record<WidgetFixedListId | 'projects', string> {
    return {
        ...(Object.fromEntries(
            WIDGET_FIXED_LIST_IDS.map((id) => [id, tr[LIST_TITLE_KEYS[id][0]] ?? LIST_TITLE_KEYS[id][1]]),
        ) as Record<WidgetFixedListId, string>),
        projects: tr['nav.projects'] ?? 'Projects',
    };
}

export interface WidgetTaskListSection {
    key: string;
    title: string;
    items: Task[];
}

export interface WidgetTaskList {
    title: string;
    /** Present for a sectioned project; the Focus list keeps its own sections. */
    sections?: WidgetTaskListSection[];
    tasks: Task[];
}

export interface WidgetListContext {
    data: AppData;
    /** Undeleted, actionable, in an active project: the widget's base pool. */
    activeTasks: Task[];
    focusLists: FocusTaskLists;
    sortBy: TaskSortBy;
    tr: Record<string, string>;
}

/** Projects the configuration screen offers, in Projects-screen order. */
export function buildWidgetProjectOptions(data: AppData): { id: string; title: string; identityColor: string | null }[] {
    const areaById = new Map((data.areas || []).map((area) => [area.id, area]));
    return (data.projects || [])
        .filter((project) => !project.deletedAt && project.status === 'active')
        .sort(compareProjectsByOrder)
        .slice(0, WIDGET_PROJECT_OPTION_CAP)
        .map((project) => ({ id: project.id, title: project.title, identityColor: getProjectAccentColor(project, areaById) ?? null }));
}

/** Null when the id names no list (an unknown or deleted project). */
export function buildWidgetTaskList(listId: string, context: WidgetListContext): WidgetTaskList | null {
    const { data, activeTasks, focusLists, sortBy, tr } = context;
    const titles = widgetListTitles(tr);
    switch (listId) {
        case 'inbox':
            return { title: titles.inbox, tasks: sortTasksBy(activeTasks.filter((task) => task.status === 'inbox'), sortBy) };
        case 'next':
            // The app's Next Actions list is the Focus screen's Next section
            // (sequential-project rules included).
            return { title: titles.next, tasks: focusLists.nextActions };
        case 'waiting':
            return { title: titles.waiting, tasks: activeTasks.filter((task) => task.status === 'waiting').sort(compareWaitingTasks) };
        case 'someday':
            return { title: titles.someday, tasks: activeTasks.filter((task) => task.status === 'someday').sort(compareSomedayTasks) };
        default:
            break;
    }
    if (!listId.startsWith(WIDGET_PROJECT_LIST_PREFIX)) return null;
    const projectId = listId.slice(WIDGET_PROJECT_LIST_PREFIX.length);
    const project = (data.projects || []).find((candidate) => candidate.id === projectId && !candidate.deletedAt);
    if (!project) return null;
    return buildProjectList(project, data, tr);
}

// Same order as the project screen's task list: manual project order,
// grouped by the project's sections, unsectioned tasks last.
function buildProjectList(project: Project, data: AppData, tr: Record<string, string>): WidgetTaskList {
    const tasks = sortProjectTasksByOrder(
        (data.tasks || []).filter((task) => !task.deletedAt && task.projectId === project.id && isTaskActionable(task)),
    );
    const sections = getProjectSectionsForView(project, (data.sections || []).filter((section) => !section.deletedAt));
    if (sections.length === 0 && !tasks.some((task) => task.sectionId)) {
        return { title: project.title, tasks };
    }
    const sectionIds = new Set(sections.map((section) => section.id));
    const grouped: WidgetTaskListSection[] = sections
        .map((section) => ({ key: section.id, title: section.title, items: tasks.filter((task) => task.sectionId === section.id) }))
        .filter((section) => section.items.length > 0);
    const unsectioned = tasks.filter((task) => !task.sectionId || !sectionIds.has(task.sectionId));
    if (unsectioned.length > 0) {
        grouped.push({ key: 'no-section', title: tr['projects.noSection'] ?? 'No section', items: unsectioned });
    }
    return { title: project.title, sections: grouped, tasks };
}
