import { projectMatchesAreaFilterSelection, taskMatchesAreaFilterSelection, type AreaFilterSelection } from './area-filter';
import type { DateFormatter } from './date';
import { tFallback } from './i18n';
import { getProjectAccentColor } from './task-accent-color';
import { formatListItemCount } from './list-count';
import type { TaskStore } from './store-types';
import { buildTaskGroupSections, getTaskGroupByLabel, type TaskGroupItem } from './task-group-sections';
import { DONE_TASK_LIST_SORT_OPTIONS, getTaskSortByLabel, getVisibleTaskSortOptions } from './task-list-sort-options';
import { isTaskCancelled } from './task-status';
import { getUsedTaskTokens } from './task-token-usage';
import { resolveTaskSortByForFeatures, sortDoneTasksForListView, sortTasksBy } from './task-utils';
import type { ListConfirmation } from './trash-view-model';
import type { AppSettings, Area, Project, Task, TaskSortBy } from './types';


export type HistoryTab = 'done' | 'archived';


export function resolveHistoryTab(tab: unknown): HistoryTab {
    return tab === 'archived' ? 'archived' : 'done';
}

export function getHistoryTabs(t: (key: string) => string): { id: HistoryTab; label: string }[] {
    return [
        { id: 'done', label: t('nav.done') },
        { id: 'archived', label: t('nav.archived') },
    ];
}

export type ArchiveSegment = 'tasks' | 'projects';
export const ARCHIVE_SEGMENTS: readonly ArchiveSegment[] = ['tasks', 'projects'];


export const ARCHIVE_TASK_GROUP_OPTIONS = ['none', 'completedDate', 'context', 'area', 'project', 'tag'] as const;
export type ArchiveTaskGroupBy = typeof ARCHIVE_TASK_GROUP_OPTIONS[number];

export function getArchiveSegmentLabel(segment: ArchiveSegment, t: (key: string) => string): string {
    return segment === 'tasks' ? tFallback(t, 'archived.tasksSegment', 'Tasks') : tFallback(t, 'projects.title', 'Projects');
}

export const selectArchivedTasks = (allTasks: Task[]): Task[] => (
    allTasks.filter((task) => task.status === 'archived' && !task.deletedAt)
);


export function resolveArchiveSortBy(stored: TaskSortBy | undefined, settings: AppSettings | undefined): TaskSortBy {
    return resolveTaskSortByForFeatures(stored ?? 'default', settings);
}


export function sortArchivedTasks(tasks: Task[], sortBy: TaskSortBy): Task[] {
    return sortBy === 'default' ? sortDoneTasksForListView(tasks) : sortTasksBy(tasks, sortBy);
}

export const filterArchivedTasksByArea = (
    tasks: Task[],
    selection: AreaFilterSelection,
    projectById: Map<string, Project>,
    areaById: Map<string, Area>,
): Task[] => tasks.filter((task) => taskMatchesAreaFilterSelection(task, selection, projectById, areaById));


export function getArchiveSortOptions(settings: AppSettings | undefined): TaskSortBy[] {
    return getVisibleTaskSortOptions(DONE_TASK_LIST_SORT_OPTIONS, settings);
}

export type ArchiveMenu = {
    filtersLabel: string;
    sort: { label: string; value: string; options: { id: TaskSortBy; label: string; selected: boolean }[] };
    group: { label: string; value: string; options: { id: ArchiveTaskGroupBy; label: string; selected: boolean }[] };
};


export function getArchiveMenu(
    { sortBy, groupBy, settings }: { sortBy: TaskSortBy; groupBy: ArchiveTaskGroupBy; settings: AppSettings | undefined },
    t: (key: string) => string,
): ArchiveMenu {
    return {
        filtersLabel: tFallback(t, 'filters.title', 'Filters'),
        sort: {
            label: tFallback(t, 'sort.label', 'Sort'),
            value: getTaskSortByLabel(sortBy, t),
            options: getArchiveSortOptions(settings).map((id) => ({ id, label: getTaskSortByLabel(id, t), selected: sortBy === id })),
        },
        group: {
            label: tFallback(t, 'list.groupBy', 'Group'),
            value: getTaskGroupByLabel(groupBy, t),
            options: ARCHIVE_TASK_GROUP_OPTIONS.map((id) => ({ id, label: getTaskGroupByLabel(id, t), selected: groupBy === id })),
        },
    };
}


export function getArchiveTokenFilterOptions(
    tasks: Task[],
    sheetOpen: boolean,
    { tokens, excludedTokens }: { tokens: string[]; excludedTokens: string[] },
): string[] {
    if (!sheetOpen) return Array.from(new Set([...tokens, ...excludedTokens]));
    return getUsedTaskTokens(tasks, (task) => [...(task.contexts ?? []), ...(task.tags ?? [])], { includeAncestors: true });
}


export function buildArchiveTaskItems({
    groupBy,
    tasks,
    areas,
    projectById,
    t,
    collapsedGroupIds,
}: {
    groupBy: ArchiveTaskGroupBy;
    tasks: Task[];
    areas: Area[];
    projectById: Map<string, Project>;
    t: (key: string) => string;
    collapsedGroupIds: ReadonlySet<string>;
}): TaskGroupItem[] {
    if (groupBy === 'none') return tasks.map((task) => ({ type: 'task', task }));
    return buildTaskGroupSections({ groupBy, tasks, areas, projectById, t, collapsedGroupIds });
}


export function getTaskGroupItemIds(items: TaskGroupItem[]): string[] {
    return Array.from(new Set(items.flatMap((item) => (item.type === 'task' ? [item.task.id] : []))));
}


export function selectArchivedProjects(
    projects: Project[],
    selection: AreaFilterSelection,
    areaById: Map<string, Area>,
): Project[] {
    return projects
        .filter((project) => project.status === 'archived' && projectMatchesAreaFilterSelection(project, selection, areaById))
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}


export function getArchivedTaskRow(task: Task, formatDate: DateFormatter, notSetLabel: string): { cancelled: boolean; dateLabel: string } {
    const cancelled = isTaskCancelled(task);
    const timestamp = cancelled ? task.cancelledAt || task.updatedAt : task.completedAt || task.updatedAt;
    return { cancelled, dateLabel: timestamp ? formatDate(timestamp, 'Pp', timestamp) : notSetLabel };
}


export function getArchivedProjectRow(
    project: Project,
    formatDate: DateFormatter,
    areaById: Map<string, Area>,
    notSetLabel: string,
): { cancelled: boolean; dateLabel: string; indicatorColor: string | undefined } {
    const timestamp = project.cancelledAt || project.updatedAt;
    return {
        cancelled: Boolean(project.cancelledAt),
        dateLabel: timestamp ? formatDate(timestamp, 'Pp', timestamp) : notSetLabel,
        indicatorColor: getProjectAccentColor(project, areaById),
    };
}


export function getArchiveCompletedAtPickerStart(task: Task, formatDate: DateFormatter, now: Date): { day: string; time: string } {
    const value = task.completedAt || task.updatedAt;
    const parsed = value ? new Date(value) : null;
    const start = parsed && !Number.isNaN(parsed.getTime()) ? parsed : now;
    return { day: formatDate(start, 'yyyy-MM-dd'), time: formatDate(start, 'HH:mm') };
}

const PICKED_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const PICKED_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;


export function resolvePickedCompletedAt(day: unknown, time: unknown): string | null {
    const date = typeof day === 'string' ? PICKED_DAY.exec(day) : null;
    const clock = typeof time === 'string' ? PICKED_TIME.exec(time) : null;
    if (!date || !clock) return null;
    const picked = new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
    if (picked.getFullYear() !== Number(date[1]) || picked.getMonth() !== Number(date[2]) - 1 || picked.getDate() !== Number(date[3])) return null;
    picked.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    return picked.toISOString();
}

export function getArchiveRowLabels(t: (key: string) => string) {
    return {
        completed: tFallback(t, 'list.done', 'Completed'),
        taskCancelled: tFallback(t, 'task.cancelled', 'Cancelled'),
        projectCancelled: tFallback(t, 'projects.cancelled', 'Cancelled'),
        editCompletedAt: tFallback(t, 'task.editCompletedAt', 'Edit completion time'),
        notSet: tFallback(t, 'common.notSet', 'Not set'),
        select: tFallback(t, 'bulk.select', 'Select'),
        restore: tFallback(t, 'trash.restore', 'Restore'),
        delete: tFallback(t, 'common.delete', 'Delete'),
    };
}


export function showArchiveSearch(segment: ArchiveSegment, archivedTaskCount: number, hasActiveFilters: boolean): boolean {
    return segment === 'tasks' && (archivedTaskCount > 0 || hasActiveFilters);
}


export function getArchiveSummary(segment: ArchiveSegment, count: number, t: (key: string) => string): string | null {
    if (count === 0) return null;
    return formatListItemCount(count, segment === 'tasks' ? 'task' : 'project', t);
}


export function getArchiveEmptyState(
    { segment, hasActiveFilters, filterChipLabels }: { segment: ArchiveSegment; hasActiveFilters: boolean; filterChipLabels: string[] },
    t: (key: string) => string,
): { title: string; message: string; clearLabel: string | null } {
    if (segment === 'projects') {
        return {
            title: tFallback(t, 'archived.emptyProjects', 'No archived projects'),
            message: tFallback(t, 'archived.emptyProjectsHint', 'Projects you archive will appear here'),
            clearLabel: null,
        };
    }
    return hasActiveFilters
        ? {
            title: tFallback(t, 'filters.noMatch', 'No tasks match these filters.'),
            message: filterChipLabels.slice(0, 3).join(', '),
            clearLabel: tFallback(t, 'filters.clear', 'Clear'),
        }
        : {
            title: tFallback(t, 'archived.empty', 'No archived tasks'),
            message: tFallback(t, 'archived.emptyHint', 'Tasks you archive will appear here'),
            clearLabel: null,
        };
}


export function getArchiveConfirmation(
    target: { kind: 'task' } | { kind: 'project'; project: Project | undefined },
    t: (key: string) => string,
): ListConfirmation {
    const cancelLabel = tFallback(t, 'common.cancel', 'Cancel');
    const confirmLabel = tFallback(t, 'common.delete', 'Delete');
    return target.kind === 'task'
        ? { title: confirmLabel, message: tFallback(t, 'task.deleteConfirmBody', 'Move this task to Trash?'), cancelLabel, confirmLabel }
        : {
            title: target.project?.title || confirmLabel,
            message: tFallback(t, 'projects.deleteConfirm', 'Delete this project? Tasks in this project will be kept and moved to unassigned.'),
            cancelLabel,
            confirmLabel,
        };
}


export const moveArchivedTaskToInbox = (store: Pick<TaskStore, 'updateTask'>, taskId: string) => (
    store.updateTask(taskId, { status: 'inbox' })
);


export const moveArchivedTasksToInbox = (store: Pick<TaskStore, 'batchMoveTasks'>, taskIds: string[]) => (
    store.batchMoveTasks(taskIds, 'inbox')
);


export const setArchivedTaskCompletedAt = (store: Pick<TaskStore, 'updateTask'>, taskId: string, completedAt: string) => (
    store.updateTask(taskId, { completedAt })
);


export const reactivateArchivedProject = (store: Pick<TaskStore, 'updateProject'>, projectId: string) => (
    store.updateProject(projectId, { status: 'active' })
);
