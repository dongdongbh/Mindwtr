


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


export const PROJECT_TASK_SORT_OPTIONS: readonly TaskSortBy[] = TASK_LIST_SORT_OPTIONS.filter(
    (option) => option !== 'priority',
);


export const FOCUS_SORT_OPTIONS: readonly SortField[] = [
    'default',
    'due',
    'start',
    'priority',
    'created',
    'created-desc',
];


export const DONE_TASK_LIST_SORT_OPTIONS: readonly TaskSortBy[] = [
    ...TASK_LIST_SORT_OPTIONS.filter((option) => option !== 'priority'),
    'completed',
];


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


export function getVisibleTaskSortOptions<Sort extends SortField>(
    options: readonly Sort[],
    settings: { features?: AppSettings['features'] } | null | undefined,
): Sort[] {
    return options.filter((option) => resolveTaskSortByForFeatures(option, settings) === option);
}


export function getTaskSortByLabel(sortBy: SortField, t: (key: string) => string): string {
    return sortBy === 'priority' ? t('filters.priority') : t(`sort.${sortBy}`);
}
