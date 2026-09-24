import { projectMatchesAreaFilterSelection, taskMatchesAreaFilterSelection, type AreaFilterSelection } from './area-filter';
import type { DateFormatter } from './date';
import { tFallback } from './i18n';
import { resolveFeatureFlags } from './resolve-feature-flags';
import { getProjectAccentColor } from './task-accent-color';
import { formatListItemCount } from './list-count';
import type { TaskStore } from './store-types';
import { buildTaskGroupSections, getTaskGroupByLabel, type TaskGroupItem } from './task-group-sections';
import { DONE_TASK_LIST_SORT_OPTIONS } from './task-list-sort-options';
import { isTaskCancelled } from './task-status';
import { getUsedTaskTokens } from './task-token-usage';
import { resolveTaskSortByForFeatures, sortDoneTasksForListView, sortTasksBy } from './task-utils';
import type { ListConfirmation } from './trash-view-model';
import type { AppSettings, Area, Project, Task, TaskSortBy } from './types';

/**
 * The React Native History screen (Done and Archive tabs) and its Archive tab:
 * which archived tasks and projects it lists, their order, groups, row dates,
 * menus, counts and empty states, and the confirmations its deletes show. The
 * screens keep only React state, storage and navigation.
 */

export type HistoryTab = 'done' | 'archived';

/** History opens on Archive only for `tab=archived`; anything else opens Done. */
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

/** Archive's grouping axes, in menu order: the Done axes, as everything filed here is finished work. */
export const ARCHIVE_TASK_GROUP_OPTIONS = ['none', 'completedDate', 'context', 'area', 'project', 'tag'] as const;
export type ArchiveTaskGroupBy = typeof ARCHIVE_TASK_GROUP_OPTIONS[number];

export function getArchiveSegmentLabel(segment: ArchiveSegment, t: (key: string) => string): string {
    return segment === 'tasks' ? tFallback(t, 'archived.tasksSegment', 'Tasks') : tFallback(t, 'projects.title', 'Projects');
}

export const selectArchivedTasks = (allTasks: Task[]): Task[] => (
    allTasks.filter((task) => task.status === 'archived' && !task.deletedAt)
);

/** A stored sort for a feature that is off falls back to the default (#1107). */
export function resolveArchiveSortBy(stored: TaskSortBy | undefined, settings: AppSettings | undefined): TaskSortBy {
    return resolveTaskSortByForFeatures(stored ?? 'default', settings);
}

/** Archive is a log like Done: with no explicit sort, newest completion first. */
export function sortArchivedTasks(tasks: Task[], sortBy: TaskSortBy): Task[] {
    return sortBy === 'default' ? sortDoneTasksForListView(tasks) : sortTasksBy(tasks, sortBy);
}

export const filterArchivedTasksByArea = (
    tasks: Task[],
    selection: AreaFilterSelection,
    projectById: Map<string, Project>,
    areaById: Map<string, Area>,
): Task[] => tasks.filter((task) => taskMatchesAreaFilterSelection(task, selection, projectById, areaById));

/** The sort menu hides Time estimate while that feature is off, like the shared sort modal (#1107). */
export function getArchiveSortOptions(settings: AppSettings | undefined): TaskSortBy[] {
    const timeEstimates = resolveFeatureFlags(settings).timeEstimates;
    return DONE_TASK_LIST_SORT_OPTIONS.filter((option) => option !== 'timeEstimate' || timeEstimates);
}

export type ArchiveMenu = {
    filtersLabel: string;
    sort: { label: string; value: string; options: { id: TaskSortBy; label: string; selected: boolean }[] };
    group: { label: string; value: string; options: { id: ArchiveTaskGroupBy; label: string; selected: boolean }[] };
};

/** The Filters, Sort and Group entries of the list menu. */
export function getArchiveMenu(
    { sortBy, groupBy, settings }: { sortBy: TaskSortBy; groupBy: ArchiveTaskGroupBy; settings: AppSettings | undefined },
    t: (key: string) => string,
): ArchiveMenu {
    return {
        filtersLabel: tFallback(t, 'filters.title', 'Filters'),
        sort: {
            label: tFallback(t, 'sort.label', 'Sort'),
            value: t(`sort.${sortBy}`),
            options: getArchiveSortOptions(settings).map((id) => ({ id, label: t(`sort.${id}`), selected: sortBy === id })),
        },
        group: {
            label: tFallback(t, 'list.groupBy', 'Group'),
            value: getTaskGroupByLabel(groupBy, t),
            options: ARCHIVE_TASK_GROUP_OPTIONS.map((id) => ({ id, label: getTaskGroupByLabel(id, t), selected: groupBy === id })),
        },
    };
}

/** The tokens the filter sheet offers: every one in use once it is open; before that, only the chosen ones. */
export function getArchiveTokenFilterOptions(
    tasks: Task[],
    sheetOpen: boolean,
    { tokens, excludedTokens }: { tokens: string[]; excludedTokens: string[] },
): string[] {
    if (!sheetOpen) return Array.from(new Set([...tokens, ...excludedTokens]));
    return getUsedTaskTokens(tasks, (task) => [...(task.contexts ?? []), ...(task.tags ?? [])]);
}

/** The list rows: always the grouped row shape, with no headings when ungrouped. */
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

/**
 * The tasks a folded heading has not removed, each once: Select all and the
 * selection prune work off these, so a bulk action never reaches a hidden row.
 */
export function getTaskGroupItemIds(items: TaskGroupItem[]): string[] {
    return Array.from(new Set(items.flatMap((item) => (item.type === 'task' ? [item.task.id] : []))));
}

/** Archived projects in the area filter, most recently changed first. */
export function selectArchivedProjects(
    projects: Project[],
    selection: AreaFilterSelection,
    areaById: Map<string, Area>,
): Project[] {
    return projects
        .filter((project) => project.status === 'archived' && projectMatchesAreaFilterSelection(project, selection, areaById))
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

/** An archived task row's outcome and its date: when it was cancelled, else completed. `notSetLabel` names a missing date. */
export function getArchivedTaskRow(task: Task, formatDate: DateFormatter, notSetLabel: string): { cancelled: boolean; dateLabel: string } {
    const cancelled = isTaskCancelled(task);
    const timestamp = cancelled ? task.cancelledAt || task.updatedAt : task.completedAt || task.updatedAt;
    return { cancelled, dateLabel: timestamp ? formatDate(timestamp, 'Pp', timestamp) : notSetLabel };
}

/** An archived project row's outcome, date and status dot color. `notSetLabel` names a missing date. */
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

/**
 * Where the completion time picker opens (yyyy-MM-dd, HH:mm): the stored completion,
 * else the last change, else now, as mobile's picker starts.
 */
export function getArchiveCompletedAtPickerStart(task: Task, formatDate: DateFormatter, now: Date): { day: string; time: string } {
    const value = task.completedAt || task.updatedAt;
    const parsed = value ? new Date(value) : null;
    const start = parsed && !Number.isNaN(parsed.getTime()) ? parsed : now;
    return { day: formatDate(start, 'yyyy-MM-dd'), time: formatDate(start, 'HH:mm') };
}

const PICKED_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const PICKED_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * The completion time mobile's picker stores for a local day and time: that local
 * minute as an ISO instant, seconds zeroed. Null for a malformed or impossible day.
 */
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

/** The search row: on the Tasks segment while it has archived tasks or a filter is on. */
export function showArchiveSearch(segment: ArchiveSegment, archivedTaskCount: number, hasActiveFilters: boolean): boolean {
    return segment === 'tasks' && (archivedTaskCount > 0 || hasActiveFilters);
}

/** The count above the list, or null when the segment is empty. */
export function getArchiveSummary(segment: ArchiveSegment, count: number, t: (key: string) => string): string | null {
    if (count === 0) return null;
    return formatListItemCount(count, segment === 'tasks' ? 'task' : 'project', t);
}

/** The empty list: filters that match nothing name up to three of their chips. */
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

/** Moving one archived task to Trash, or deleting an archived project, asks first. */
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

/** Archive's Restore: the task goes back to Inbox. */
export const moveArchivedTaskToInbox = (store: Pick<TaskStore, 'updateTask'>, taskId: string) => (
    store.updateTask(taskId, { status: 'inbox' })
);

/** Archive's bulk Restore to Inbox. */
export const moveArchivedTasksToInbox = (store: Pick<TaskStore, 'batchMoveTasks'>, taskIds: string[]) => (
    store.batchMoveTasks(taskIds, 'inbox')
);

/** The completion time picker's choice for a completed archived task. */
export const setArchivedTaskCompletedAt = (store: Pick<TaskStore, 'updateTask'>, taskId: string, completedAt: string) => (
    store.updateTask(taskId, { completedAt })
);

/** An archived project's Restore: it becomes active again. */
export const reactivateArchivedProject = (store: Pick<TaskStore, 'updateProject'>, projectId: string) => (
    store.updateProject(projectId, { status: 'active' })
);
