import type { TaskSortBy, TaskStatus } from '@mindwtr/core';

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

export function resolveNonDoneTaskSortBy(stored?: TaskSortBy): TaskSortBy {
  return !stored || stored === 'completed' ? 'default' : stored;
}

export function resolveDoneTaskSortBy(stored?: TaskSortBy, viewSortBy?: TaskSortBy): TaskSortBy {
  return viewSortBy ?? (stored === 'completed' ? 'completed' : 'default');
}

export function resolveTaskListSortBy({
  globalSortBy,
  projectSortBy,
  statusFilter,
  viewSortBy,
}: {
  globalSortBy?: TaskSortBy;
  projectSortBy?: TaskSortBy;
  statusFilter: TaskStatus | 'all';
  viewSortBy?: TaskSortBy;
}): TaskSortBy {
  if (projectSortBy) {
    return statusFilter === 'done'
      ? resolveDoneTaskSortBy(projectSortBy, viewSortBy)
      : resolveNonDoneTaskSortBy(projectSortBy);
  }
  if (statusFilter === 'done') {
    return resolveDoneTaskSortBy(globalSortBy, viewSortBy);
  }
  return resolveNonDoneTaskSortBy(globalSortBy);
}
