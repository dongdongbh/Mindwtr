import { TIME_ESTIMATE_OPTIONS } from './calendar-scheduling';
import { CONTEXTS_NO_CONTEXT_TOKEN } from './contexts-view-model';
import { selectionsFromCriteria } from './filter-criteria';
import { getFocusProjectFilterLabel, getFocusProjectFilterOptions } from './focus-controls';
import type { ContextOrTagMatchMode } from './hierarchy-utils';
import { applyListFilterEdit, EMPTY_LIST_FILTER_STATE, resolveListFilterState, type ListFilterEdit, type ListFilterState } from './list-filter-state';
import type { ListFilterOptions } from './menu-views-model';
import { applyFilter, normalizeSavedFilters } from './saved-filters';
import { resolveFeatureFlags } from './resolve-feature-flags';
import { getTaskMetadataFilterVisibility } from './task-metadata-filter-visibility';
import { isTaskFinished } from './task-status';
import { taskMatchesFilterSearchQuery } from './task-filter-selections';
import type { AppSettings, FilterCriteria, Project, Task, TaskStatus } from './types';

export const CONTEXTS_FILTER_STATUSES = ['inbox', 'next', 'waiting', 'someday'] as const satisfies readonly TaskStatus[];

export function selectContextsFilterTasks(tasks: Task[], criteria: FilterCriteria, projects: Project[]): Task[] {
    const pool = criteria.statuses?.length ? tasks : tasks.filter((task) => !isTaskFinished(task));
    return applyFilter(pool, criteria, { projects, tokenMatchMode: 'all' });
}

export function getContextsSaveCriteria(criteria: FilterCriteria, tokens: string[], matchMode: ContextOrTagMatchMode, searchQueries: readonly string[] = []): FilterCriteria | null {
    if (searchQueries.some((query) => query.trim())) return null;
    if (!criteria.statuses?.length || criteria.statuses.some((status) => !CONTEXTS_FILTER_STATUSES.some((value) => value === status))) return null;
    if (tokens.includes(CONTEXTS_NO_CONTEXT_TOKEN)) return null;
    const contexts = tokens.filter((token) => !token.startsWith('#'));
    const tags = tokens.filter((token) => token.startsWith('#'));
    if (matchMode === 'any' && contexts.length > 0 && tags.length > 0) return null;
    if (tokens.length > 0 && (criteria.contexts?.length || criteria.tags?.length)) return null;
    return {
        ...criteria,
        ...(contexts.length ? { contexts, contextMatchMode: matchMode } : {}),
        ...(tags.length ? { tags, tagMatchMode: matchMode } : {}),
    };
}

export function buildContextsFilterModel(input: {
    tasks: Task[]; projects: Project[]; settings: AppSettings | undefined;
    filters: ListFilterState; edit?: ListFilterEdit; savedFilterId?: string | null;
    preservedCriteria?: FilterCriteria; filterSheetOpen?: boolean;
    t: (key: string) => string;
}) {
    const savedFilters = normalizeSavedFilters(input.settings?.savedFilters).filter((filter) =>
        !filter.deletedAt && (filter.view === 'contexts' || filter.view === 'all'));
    const activeSavedFilter = savedFilters.find((filter) => filter.id === input.savedFilterId) ?? null;
    const selections = activeSavedFilter ? selectionsFromCriteria(activeSavedFilter.criteria) : null;
    let state: ListFilterState = selections ? {
        ...EMPTY_LIST_FILTER_STATE,
        searchQuery: input.filters.searchQuery,
        tokens: selections.tokens, excludedTokens: selections.excludedTokens, projects: selections.projects,
        excludedProjects: selections.excludedProjects, statuses: selections.statuses,
        priorities: selections.priorities, energyLevels: selections.energyLevels, timeEstimates: selections.timeEstimates,
        location: selections.locations[0] ?? '', contextMatchMode: selections.contextMatchMode, tagMatchMode: selections.tagMatchMode,
        ...(selections.anyDateRange ? { anyDateRange: selections.anyDateRange } : {}),
    } : input.filters;
    let preservedCriteria = input.preservedCriteria;
    if (input.edit) {
        state = applyListFilterEdit(state, input.edit);
        const rawSaved = activeSavedFilter && input.settings?.savedFilters?.find((filter) => filter.id === activeSavedFilter.id);
        const preserved = { ...(rawSaved?.criteria ?? activeSavedFilter?.criteria ?? preservedCriteria) };
        const forget = (...fields: (keyof FilterCriteria)[]) => fields.forEach((field) => { delete preserved[field]; });
        switch (input.edit.type) {
            case 'clear': preservedCriteria = undefined; break;
            case 'cycleProject': case 'toggleProject': case 'removeProject': forget('projects', 'excludedProjects'); break;
            case 'toggleStatus': forget('statuses'); break;
            case 'toggleToken': case 'removeToken': forget('contexts', 'tags', 'excludedContexts', 'excludedTags'); break;
            case 'setAnyDateRange': forget('anyDateRange'); break;
            case 'setLocation': forget('locations'); break;
            case 'togglePriority': forget('priority'); break;
            case 'toggleEnergyLevel': forget('energy'); break;
            case 'toggleTimeEstimate': forget('timeEstimates', 'timeEstimateRange'); break;
            case 'setMatchMode': forget(input.edit.kind === 'context' ? 'contextMatchMode' : 'tagMatchMode'); break;
        }
        if (input.edit.type !== 'clear') preservedCriteria = preserved;
    }
    if (input.filterSheetOpen && (!activeSavedFilter || input.edit) && state.statuses === undefined) {
        state = { ...state, statuses: [...CONTEXTS_FILTER_STATUSES] };
    }
    const features = resolveFeatureFlags(input.settings);
    const visibility = getTaskMetadataFilterVisibility(input.tasks, { prioritiesEnabled: features.priorities,
        timeEstimatesEnabled: features.timeEstimates });
    const projectById = new Map(input.projects.map((project) => [project.id, project]));
    const options: ListFilterOptions = {
        tokens: [], projects: getFocusProjectFilterOptions(input.tasks, input.projects, input.t),
        timeEstimates: TIME_ESTIMATE_OPTIONS, visibility,
        getProjectLabel: (id) => getFocusProjectFilterLabel(id, projectById, input.t),
    };
    const resolved = resolveListFilterState(state, { visibility, getProjectLabel: options.getProjectLabel, t: input.t });
    resolved.chips = resolved.chips.map(chip => chip.id.startsWith('project:') && chip.edit.type === 'toggleProject'
        ? { ...chip, edit: { type: 'removeProject' as const, value: chip.edit.value } } : chip);
    const criteria = activeSavedFilter && !input.edit ? activeSavedFilter.criteria : { ...resolved.criteria, ...preservedCriteria };
    return { resolved, criteria, options, savedFilters, preservedCriteria, activeSavedFilter: input.edit ? null : activeSavedFilter,
        tasks: selectContextsFilterTasks(input.tasks, criteria, input.projects).filter((task) => taskMatchesFilterSearchQuery(task, resolved.searchQuery)) };
}
