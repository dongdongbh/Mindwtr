import type { AppData } from './types';
import { buildProjectTaskListModel, getProjectDetailTaskListOptions, selectProjectTaskListTasks } from './project-task-list-model';
import { resolveAreaFilterSelection, taskMatchesAreaFilterSelection } from './area-filter';
import { selectVisibleAreas, selectVisibleSections, selectVisibleTasks } from './store-helpers';
import { resolveTaskSortByForFeatures } from './task-utils';
import { resolveNonDoneTaskSortBy } from './task-list-sort-options';
import { resolveFeatureFlags } from './resolve-feature-flags';
import { getTaskMetadataFilterVisibility } from './task-metadata-filter-visibility';
import { readFilterState } from './native-host-contract-menu-views';
import { resolveListFilterState, type ListFilterState, type ResolvedListFilter } from './list-filter-state';
import { record } from './native-host-contract-project-shared';

export type NativeProjectBulkParams = { projectId: string; showCompleted: boolean; completedCollapsed: boolean;
    filters: ListFilterState; filterSheetOpen: false };
export type NativeProjectTaskListData = Pick<AppData, 'tasks' | 'projects' | 'sections' | 'areas' | 'settings'>;

export const readProjectBulkParams = (value: unknown): NativeProjectBulkParams | null => {
    if (!record(value) || Object.keys(value).some(key => !['projectId', 'showCompleted', 'completedCollapsed', 'filters', 'filterSheetOpen'].includes(key))
        || typeof value.projectId !== 'string' || !value.projectId.trim() || value.projectId.length > 500
        || typeof value.showCompleted !== 'boolean' || typeof value.completedCollapsed !== 'boolean'
        || value.filterSheetOpen !== undefined && value.filterSheetOpen !== false || !record(value.filters)) return null;
    const filters = readFilterState(value.filters);
    return filters && !filters.projects.length && !filters.timeEstimates.length
        ? { projectId: value.projectId, showCompleted: value.showCompleted, completedCollapsed: value.completedCollapsed,
            filters, filterSheetOpen: false } : null;
};

export const nativeProjectTaskSources = (data: NativeProjectTaskListData, projectId: string, showCompleted: boolean) => {
    const project = data.projects.find(candidate => candidate.id === projectId);
    if (!project || project.deletedAt) return null;
    const options = getProjectDetailTaskListOptions(project, showCompleted);
    const projectTasks = data.tasks.filter(task => task.projectId === project.id && !task.deletedAt);
    const areas = selectVisibleAreas(data.areas ?? []);
    const areaById = new Map([...areas].sort((a, b) => a.order !== b.order ? a.order - b.order : a.name.localeCompare(b.name)).map(area => [area.id, area]));
    const selection = resolveAreaFilterSelection(data.settings.filters, areas);
    const projects = new Map(data.projects.map(row => [row.id, row]));
    const filterableTasks = selectProjectTaskListTasks(projectTasks, { projectId, statusFilter: 'all',
        includeArchived: options.includeArchived, includeDone: options.includeDone,
        isVisible: task => taskMatchesAreaFilterSelection(task, selection, projects, areaById) });
    return { project, options, projectTasks, filterableTasks };
};
export type NativeProjectTaskSources = NonNullable<ReturnType<typeof nativeProjectTaskSources>>;
export const nativeProjectFilterVisibility = (sources: NativeProjectTaskSources, settings: AppData['settings']) =>
    getTaskMetadataFilterVisibility(sources.filterableTasks, {
        prioritiesEnabled: resolveFeatureFlags(settings).priorities, timeEstimatesEnabled: false,
    });
export const nativeProjectTaskModel = (data: NativeProjectTaskListData, sources: NativeProjectTaskSources,
    completedCollapsed: boolean, resolved: Pick<ResolvedListFilter, 'criteria' | 'searchQuery'> | undefined, t: (key: string) => string) => {
    const projectSortBy = resolveTaskSortByForFeatures(sources.project.taskSortBy ?? 'default', data.settings);
    return buildProjectTaskListModel({ project: sources.project, tasks: sources.filterableTasks,
        visibleTasks: selectVisibleTasks(data.tasks), sections: selectVisibleSections(data.sections ?? []), allSections: data.sections ?? [],
        statusFilter: 'all', criteria: resolved?.criteria ?? {}, searchQuery: resolved?.searchQuery ?? '',
        sortBy: resolveNonDoneTaskSortBy(projectSortBy, data.settings), projectOrder: sources.options.enableProjectReorder,
        reorderMode: false, groupCompletedTasksLast: sources.options.groupCompletedTasksLast, completedCollapsed, t });
};
export const nativeProjectSelectableTasks = (data: NativeProjectTaskListData, params: NativeProjectBulkParams) => {
    const sources = nativeProjectTaskSources(data, params.projectId, params.showCompleted);
    if (!sources || sources.options.readOnly || sources.project.purgedAt) return [];
    const t = (key: string) => key;
    const resolved = resolveListFilterState(params.filters, { visibility: nativeProjectFilterVisibility(sources, data.settings), t });
    return nativeProjectTaskModel(data, sources, params.completedCollapsed, resolved, t).items.flatMap(item => item.type === 'task' ? [item.task] : []);
};
