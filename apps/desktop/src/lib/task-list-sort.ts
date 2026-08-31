import type { TaskSortBy } from '@mindwtr/core';

export const SORT_OPTIONS: readonly TaskSortBy[] = [
    'default',
    'due',
    'start',
    'review',
    'timeEstimate',
    'title',
    'created',
    'created-desc',
];

export const DONE_SORT_OPTIONS: readonly TaskSortBy[] = [
    ...SORT_OPTIONS,
    'completed',
];

export function resolveNonDoneTaskSortBy(stored?: TaskSortBy): TaskSortBy {
    return !stored || stored === 'completed' ? 'default' : stored;
}

export function resolveDoneTaskSortBy(stored?: TaskSortBy, viewSortBy?: TaskSortBy): TaskSortBy {
    return viewSortBy ?? (stored === 'completed' ? 'completed' : 'default');
}
