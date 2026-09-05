import type { TaskSortBy } from '@mindwtr/core';
import { DONE_TASK_LIST_SORT_OPTIONS } from '@mindwtr/core';

export const DONE_LIST_VIEW_STATE_STORAGE_KEY = 'mindwtr:view:done:v1';
export const DONE_LIST_GROUP_OPTIONS = ['none', 'completedDate', 'context', 'area', 'project', 'tag'] as const;
export type DoneListGroupBy = typeof DONE_LIST_GROUP_OPTIONS[number];

export type DoneListViewState = {
  groupBy: DoneListGroupBy;
  sortBy?: TaskSortBy;
};

export const DEFAULT_DONE_LIST_VIEW_STATE: DoneListViewState = {
  groupBy: 'none',
};

export function readDoneListViewState(raw: string | null): DoneListViewState {
  if (!raw) return DEFAULT_DONE_LIST_VIEW_STATE;
  try {
    const parsed = JSON.parse(raw) as Partial<DoneListViewState>;
    const groupBy = DONE_LIST_GROUP_OPTIONS.includes(parsed.groupBy as DoneListGroupBy)
      ? parsed.groupBy as DoneListGroupBy
      : DEFAULT_DONE_LIST_VIEW_STATE.groupBy;
    const sortBy = DONE_TASK_LIST_SORT_OPTIONS.includes(parsed.sortBy as TaskSortBy)
      ? parsed.sortBy as TaskSortBy
      : undefined;
    return {
      groupBy,
      ...(sortBy ? { sortBy } : {}),
    };
  } catch {
    return DEFAULT_DONE_LIST_VIEW_STATE;
  }
}

export function serializeDoneListViewState(state: DoneListViewState): string {
  return JSON.stringify(state);
}
