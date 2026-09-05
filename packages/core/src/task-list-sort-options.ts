/**
 * Task-list sort rosters and their two feature-gated resolvers, shared by
 * every task-list surface on desktop and mobile. Kept as a sibling of
 * `resolveTaskSortByForFeatures` (task-utils.ts) rather than inside that
 * file because task-utils.ts is already large.
 */

import type { AppSettings, TaskSortBy } from './types';
import { resolveTaskSortByForFeatures } from './task-utils';

export const TASK_LIST_SORT_OPTIONS: readonly TaskSortBy[] = [
    'default',
    'due',
    'start',
    'review',
    'timeEstimate',
    'title',
    'created',
    'created-desc',
];

export const DONE_TASK_LIST_SORT_OPTIONS: readonly TaskSortBy[] = [
    ...TASK_LIST_SORT_OPTIONS,
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
