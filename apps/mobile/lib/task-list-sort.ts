import { resolveTaskSortByForFeatures, type AppSettings, type TaskSortBy, type TaskStatus } from '@mindwtr/core';

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

// `settings` is required, not optional: a screen that forgets it would silently
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

export function resolveTaskListSortBy({
  globalSortBy,
  projectSortBy,
  settings,
  statusFilter,
  viewSortBy,
}: {
  globalSortBy?: TaskSortBy;
  projectSortBy?: TaskSortBy;
  settings: AppSettings | undefined;
  statusFilter: TaskStatus | 'all';
  viewSortBy?: TaskSortBy;
}): TaskSortBy {
  if (projectSortBy) {
    return statusFilter === 'done'
      ? resolveDoneTaskSortBy(projectSortBy, viewSortBy, settings)
      : resolveNonDoneTaskSortBy(projectSortBy, settings);
  }
  if (statusFilter === 'done') {
    return resolveDoneTaskSortBy(globalSortBy, viewSortBy, settings);
  }
  return resolveNonDoneTaskSortBy(globalSortBy, settings);
}
