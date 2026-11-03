


import { taskMatchesAreaFilterSelection, type AreaFilterSelection } from './area-filter';
import { tFallback } from './i18n';
import { filterTasksBySearch } from './search';
import { useTaskStore } from './store';
import { getTaskSortByLabel, resolveNonDoneTaskSortBy, TASK_LIST_SORT_OPTIONS } from './task-list-sort-options';
import { resolveTaskSortByForFeatures, sortTasksBy } from './task-utils';
import type { AppSettings, Area, Project, SavedSearch, Task, TaskSortBy } from './types';

type Translate = (key: string) => string;

export type SavedSearchScreenText = {

    title: string;

    query: string;

    deleteAction: {
        label: string;
        confirm: { title: string; message: string; cancelLabel: string; confirmLabel: string };
    } | null;

    empty: { message: string; actions: { inboxLabel: string; backLabel: string } | null };
};

export function findSavedSearch(savedSearches: readonly SavedSearch[] | undefined, id: string): SavedSearch | undefined {
    return savedSearches?.find((search) => search.id === id);
}


export function removeSavedSearch(savedSearches: readonly SavedSearch[] | undefined, id: string): SavedSearch[] {
    return (savedSearches || []).filter((search) => search.id !== id);
}


export async function deleteSavedSearchById(id: string): Promise<boolean> {
    const { settings, updateSettings } = useTaskStore.getState();
    if (!findSavedSearch(settings.savedSearches, id)) return false;

    await updateSettings({ savedSearches: removeSavedSearch(settings.savedSearches, id) });
    return true;
}


export function getSavedSearchOwnSortBy(savedSearch: SavedSearch | undefined, settings: AppSettings | undefined): TaskSortBy | null {
    const own = savedSearch?.sort as TaskSortBy | undefined;
    return own && TASK_LIST_SORT_OPTIONS.includes(own) && resolveTaskSortByForFeatures(own, settings) === own ? own : null;
}


export function resolveSavedSearchSortBy(savedSearch: SavedSearch | undefined, settings: AppSettings | undefined): TaskSortBy {
    return getSavedSearchOwnSortBy(savedSearch, settings) ?? resolveNonDoneTaskSortBy(settings?.taskSortBy, settings);
}


export function getSavedSearchGlobalSortLabel(settings: AppSettings | undefined, t: Translate): string {
    const label = getTaskSortByLabel(resolveNonDoneTaskSortBy(settings?.taskSortBy, settings), t);
    return tFallback(t, 'search.sortUseGlobal', 'Use global setting ({sort})').replace('{sort}', label);
}


export async function setSavedSearchSortById(id: string, sort: TaskSortBy | null): Promise<boolean> {
    const { settings, updateSettings } = useTaskStore.getState();
    const target = findSavedSearch(settings.savedSearches, id);
    if (!target || (target.sort ?? null) === sort) return false;
    const { sort: _previous, ...rest } = target;
    const next: SavedSearch = sort === null ? rest : { ...rest, sort };

    await updateSettings({ savedSearches: settings.savedSearches!.map((search) => (search === target ? next : search)) });
    return true;
}


export function selectSavedSearchTasks(input: {
    query: string;
    tasks: Task[];
    projects: Project[];
    areaFilter: AreaFilterSelection;
    areaById: Map<string, Area>;
    sortBy: TaskSortBy;
}): Task[] {
    if (!input.query) return [];
    const projectMap = new Map(input.projects.map((project) => [project.id, project]));
    return sortTasksBy(
        filterTasksBySearch(input.tasks, input.projects, input.query).filter((task) => (
            taskMatchesAreaFilterSelection(task, input.areaFilter, projectMap, input.areaById)
        )),
        input.sortBy,
    );
}

export function buildSavedSearchScreenText(input: {
    savedSearch: SavedSearch | undefined;
    savedSearches: readonly SavedSearch[] | undefined;
    t: Translate;
}): SavedSearchScreenText {
    const { savedSearch, t } = input;
    const hasAnySavedSearches = (input.savedSearches?.length ?? 0) > 0;
    return {
        title: savedSearch?.name || t('search.savedSearches'),
        query: savedSearch?.query || '',
        deleteAction: savedSearch ? {
            label: t('common.delete'),
            confirm: {
                title: t('common.delete'),
                message: tFallback(t, 'search.deleteConfirm', `Delete "${savedSearch.name}"?`),
                cancelLabel: t('common.cancel'),
                confirmLabel: t('common.delete'),
            },
        } : null,
        empty: {
            message: savedSearch || hasAnySavedSearches ? t('search.noResults') : t('search.noSavedSearches'),
            actions: savedSearch ? null : { inboxLabel: t('nav.inbox'), backLabel: t('common.back') },
        },
    };
}
