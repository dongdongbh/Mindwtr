/**
 * Task-list sort rosters and their two feature-gated resolvers, shared by
 * every task-list surface on desktop and mobile. Kept as a sibling of
 * `resolveTaskSortByForFeatures` (task-utils.ts) rather than inside that
 * file because task-utils.ts is already large.
 */

import type { AppSettings, SortField, TaskSortBy } from './types';
import { resolveTaskSortByForFeatures } from './task-utils';

export const TASK_LIST_SORT_OPTIONS: readonly TaskSortBy[] = [
    'default',
    'due',
    'start',
    'review',
    'priority',
    'timeEstimate',
    'title',
    'created',
    'created-desc',
];

/**
 * The per-project sort roster: the shared one without 'priority'. Project.taskSortBy
 * syncs, and older clients' normalizeProjectTaskSortBy turns a value they do not know
 * into undefined, so an old device would erase a project's Priority sort on its next
 * edit. The shared settings.taskSortBy passes through old clients unchanged (#1415).
 */
export const PROJECT_TASK_SORT_OPTIONS: readonly TaskSortBy[] = TASK_LIST_SORT_OPTIONS.filter(
    (option) => option !== 'priority',
);

// The Focus screens' own roster: no review/timeEstimate/title, plus priority.
// Both screens hide 'priority' when the priority feature is off.
export const FOCUS_SORT_OPTIONS: readonly SortField[] = [
    'default',
    'due',
    'start',
    'priority',
    'created',
    'created-desc',
];

// Done and Archive keep their pre-#1415 roster: no 'priority'. A finished task's
// priority rarely matters, and native iOS History still validates against this
// list hard-coded (CoreModel.validHistorySort).
export const DONE_TASK_LIST_SORT_OPTIONS: readonly TaskSortBy[] = [
    ...TASK_LIST_SORT_OPTIONS.filter((option) => option !== 'priority'),
    'completed',
];

// `settings` is required, not optional: a view that forgets it would silently
// keep sorting by a disabled feature's field (#1107).
export function resolveNonDoneTaskSortBy(
    stored: TaskSortBy | undefined,
    settings: AppSettings | undefined,
): TaskSortBy {
    return resolveTaskSortByForFeatures(!stored || stored === 'completed' ? 'default' : stored, settings);
}

export function resolveDoneTaskSortBy(
    stored: TaskSortBy | undefined,
    viewSortBy: TaskSortBy | undefined,
    settings: AppSettings | undefined,
): TaskSortBy {
    return resolveTaskSortByForFeatures(
        viewSortBy ?? (stored === 'completed' ? 'completed' : 'default'),
        settings,
    );
}

/**
 * The options a sort picker shows: those whose feature is on (Time estimates,
 * Priorities). A stored sort for a hidden option resolves to 'default' through
 * the same `resolveTaskSortByForFeatures`, so the selected row is never hidden (#1107).
 */
export function getVisibleTaskSortOptions<Sort extends SortField>(
    options: readonly Sort[],
    settings: { features?: AppSettings['features'] } | null | undefined,
): Sort[] {
    return options.filter((option) => resolveTaskSortByForFeatures(option, settings) === option);
}

/** A sort option's label. Priority has no `sort.*` key; it reuses Focus's `filters.priority`. */
export function getTaskSortByLabel(sortBy: SortField, t: (key: string) => string): string {
    return sortBy === 'priority' ? t('filters.priority') : t(`sort.${sortBy}`);
}
