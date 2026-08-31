import { resolveTaskSortByForFeatures, type AppSettings, type TaskSortBy } from '@mindwtr/core';

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
