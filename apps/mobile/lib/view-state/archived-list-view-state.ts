import type { TaskSortBy } from '@mindwtr/core';
import { DONE_TASK_LIST_SORT_OPTIONS } from '@mindwtr/core';

export const ARCHIVED_LIST_VIEW_STATE_STORAGE_KEY = 'mindwtr:view:archived:v1';
// Same axes as Done: everything filed in Archive is finished work, so
// completion date is the axis that means something here.
export const ARCHIVED_LIST_GROUP_OPTIONS = ['none', 'completedDate', 'context', 'area', 'project', 'tag'] as const;
export type ArchivedListGroupBy = typeof ARCHIVED_LIST_GROUP_OPTIONS[number];

export type ArchivedListViewState = {
  groupBy: ArchivedListGroupBy;
  sortBy?: TaskSortBy;
};

export const DEFAULT_ARCHIVED_LIST_VIEW_STATE: ArchivedListViewState = {
  groupBy: 'none',
};

export function readArchivedListViewState(raw: string | null): ArchivedListViewState {
  if (!raw) return DEFAULT_ARCHIVED_LIST_VIEW_STATE;
  try {
    const parsed = JSON.parse(raw) as Partial<ArchivedListViewState>;
    const groupBy = ARCHIVED_LIST_GROUP_OPTIONS.includes(parsed.groupBy as ArchivedListGroupBy)
      ? parsed.groupBy as ArchivedListGroupBy
      : DEFAULT_ARCHIVED_LIST_VIEW_STATE.groupBy;
    const sortBy = DONE_TASK_LIST_SORT_OPTIONS.includes(parsed.sortBy as TaskSortBy)
      ? parsed.sortBy as TaskSortBy
      : undefined;
    return {
      groupBy,
      ...(sortBy ? { sortBy } : {}),
    };
  } catch {
    return DEFAULT_ARCHIVED_LIST_VIEW_STATE;
  }
}

export function serializeArchivedListViewState(state: ArchivedListViewState): string {
  return JSON.stringify(state);
}
