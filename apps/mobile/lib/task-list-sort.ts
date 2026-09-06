import {
  resolveDoneTaskSortBy,
  resolveNonDoneTaskSortBy,
  type AppSettings,
  type TaskSortBy,
  type TaskStatus,
} from '@mindwtr/core';

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
