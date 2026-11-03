import type { Area, Project, Task, TaskStatus } from '@mindwtr/core';
import {
  computeGlobalSearchResults,
  type DuePreset,
  type GlobalSearchScope,
} from '@mindwtr/core/global-search-filter';

import { logInfo, logWarn } from '@/lib/app-log';
import {
  searchAppleTasksNative,
  type AppleTaskSearchNativeMatch,
} from '@/modules/apple-task-search';

export type AppleSearchFilters = {
  includeCompleted: boolean;
  includeReference: boolean;
  hideFutureTasks: boolean;
  selectedStatuses: TaskStatus[];
  selectedArea: 'all' | 'none' | string;
  selectedTokens: string[];
  locationQuery: string;
  duePreset: DuePreset;
  scope: GlobalSearchScope;
  weekStart?: string | null;
};

export const DEFAULT_APPLE_SEARCH_FILTERS: AppleSearchFilters = {
  includeCompleted: false,
  includeReference: true,
  hideFutureTasks: false,
  selectedStatuses: [],
  selectedArea: 'all',
  selectedTokens: [],
  locationQuery: '',
  duePreset: 'any',
  scope: 'tasks',
};

export type AppleSearchRevalidation = {
  tasks: Task[];
  unavailableTaskIds: string[];
  filteredTaskIds: string[];
};

export type AppleSearchEvaluationState = {
  tasks: Task[];
  projects: Project[];
  areas: Area[];
  filters: AppleSearchFilters;
};

export type AppleSearchEvaluationRun = AppleSearchRevalidation & {

  nativeMatches: AppleTaskSearchNativeMatch[];
};


export function revalidateAppleSearchMatches(params: {
  query: string;
  nativeMatches: AppleTaskSearchNativeMatch[];
  tasks: Task[];
  projects: Project[];
  areas: Area[];
  filters: AppleSearchFilters;
}): AppleSearchRevalidation {
  const taskById = new Map(params.tasks.map((task) => [task.id, task]));
  const seenTaskIds = new Set<string>();
  const candidateTasks: Task[] = [];
  const unavailableTaskIds: string[] = [];

  for (const match of params.nativeMatches) {
    if (seenTaskIds.has(match.taskId)) continue;
    seenTaskIds.add(match.taskId);
    const currentTask = taskById.get(match.taskId);
    if (!currentTask || currentTask.deletedAt) {
      unavailableTaskIds.push(match.taskId);
      continue;
    }
    candidateTasks.push(currentTask);
  }

  const result = computeGlobalSearchResults({
    query: params.query,
    tasks: params.tasks,
    projects: params.projects,
    areas: params.areas,
    ...params.filters,
    ftsQuery: params.query,
    ftsResults: {
      tasks: candidateTasks,
      projects: [],
    },
  });
  const acceptedIds = new Set<string>();
  for (const entry of result.results) {
    if (entry.type === 'task' && seenTaskIds.has(entry.item.id)) {
      acceptedIds.add(entry.item.id);
    }
  }
  const acceptedTasks = candidateTasks.filter((task) => acceptedIds.has(task.id));
  const filteredTaskIds = candidateTasks
    .filter((task) => !acceptedIds.has(task.id))
    .map((task) => task.id);

  return { tasks: acceptedTasks, unavailableTaskIds, filteredTaskIds };
}

export async function runAppleSearchEvaluation(params: {
  query: string;

  getCurrentState: () => AppleSearchEvaluationState;
  signal?: AbortSignal;
}): Promise<AppleSearchEvaluationRun> {
  const startedAt = Date.now();
  try {
    const nativeMatches = await searchAppleTasksNative(params.query, { signal: params.signal });
    const current = params.getCurrentState();
    const result = revalidateAppleSearchMatches({
      query: params.query,
      nativeMatches,
      tasks: current.tasks,
      projects: current.projects,
      areas: current.areas,
      filters: current.filters,
    });
    void logInfo('Apple task search evaluation completed', {
      scope: 'apple-search',
      force: true,
      extra: {
        releaseCheck: 'v1.3.1/apple-search-evaluation',
        stage: 'completed',
        matchCount: nativeMatches.length,
        acceptedCount: result.tasks.length,
        droppedCount: result.unavailableTaskIds.length + result.filteredTaskIds.length,
        elapsedMs: Date.now() - startedAt,
      },
    });
    return { ...result, nativeMatches };
  } catch (error) {
    const cancelled = error instanceof Error && error.name === 'AbortError';
    const logger = cancelled ? logInfo : logWarn;
    void logger('Apple task search evaluation stopped', {
      scope: 'apple-search',
      force: true,
      extra: {
        releaseCheck: 'v1.3.1/apple-search-evaluation',
        stage: cancelled ? 'cancelled' : 'failed',
        elapsedMs: Date.now() - startedAt,
      },
    });
    throw error;
  }
}
