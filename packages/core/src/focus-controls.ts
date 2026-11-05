


import { isTaskVisibleInArea, projectMatchesAreaFilterSelection, resolveAreaFilterSelection, taskMatchesAreaFilterSelection } from './area-filter';
import { TIME_ESTIMATE_OPTIONS } from './calendar-scheduling';
import { hasTimeComponent, safeParseDueDate } from './date';
import { countActiveFilterCriteria, criteriaFromSelections, selectionsFromCriteria } from './filter-criteria';
import { buildFocusTaskGroups, type FocusTaskGroup } from './focus-grouping';
import {
    buildFocusPools,
    DEFAULT_FOCUS_SORT_BY,
    deriveFocusTaskLists,
    getReviewDueProjects,
    type FocusPools,
    type FocusTaskLists,
    type FocusSelection,
} from './focus-sections';
import { formatI18nTemplate, tFallback } from './i18n';
import {
    applyListFilterEdit,
    EMPTY_LIST_FILTER_STATE,
    resolveListFilterState,
    type ListFilterChip,
    type ListFilterEdit,
    type ListFilterState,
} from './list-filter-state';
import { buildAdvancedFilterCriteriaChips, removeAdvancedFilterCriteriaChip } from './saved-filter-labels';
import { hasActiveFilterCriteria, markSavedFilterDeleted, normalizeSavedFilters, SAVED_FILTER_NO_PROJECT_ID } from './saved-filters';
import { resolveFeatureFlags } from './resolve-feature-flags';
import { FOCUS_SORT_OPTIONS } from './task-list-sort-options';
import { getTaskMetadataFilterVisibility, type TaskMetadataFilterVisibility } from './task-metadata-filter-visibility';
import { isTaskActionable } from './task-status';
import { isTaskCountedAsFocused } from './store-helpers';
import { getUsedTaskTokens } from './task-token-usage';
import { resolveTaskPerspectiveForFeatures, shouldShowTaskForStart, sortTasksByFocusOrder, type TaskPerspectiveFeatureState } from './task-utils';
import type {
    AppSettings,
    Area,
    FilterCriteria,
    FocusGroupBy,
    Project,
    SavedFilter,
    Section,
    SortField,
    Task,
    TimeEstimate,
} from './types';

type Translate = (key: string) => string;
type FormatDate = (value: string | Date, formatStr: string, fallback?: string) => string;

export const FOCUS_GROUP_BY_OPTIONS: readonly FocusGroupBy[] = ['none', 'context', 'project', 'area', 'energy', 'priority', 'person', 'tag'];

export function normalizeFocusGroupBy(value: unknown): FocusGroupBy {
    return FOCUS_GROUP_BY_OPTIONS.includes(value as FocusGroupBy) ? value as FocusGroupBy : 'none';
}


export function getFocusSortOptions(prioritiesEnabled: boolean): readonly SortField[] {
    return prioritiesEnabled ? FOCUS_SORT_OPTIONS : FOCUS_SORT_OPTIONS.filter((option) => option !== 'priority');
}


export function getFocusGroupByOptions(prioritiesEnabled: boolean): readonly FocusGroupBy[] {
    return prioritiesEnabled ? FOCUS_GROUP_BY_OPTIONS : FOCUS_GROUP_BY_OPTIONS.filter((option) => option !== 'priority');
}

export function getFocusSortByLabel(sortBy: SortField, t: Translate): string {
    if (sortBy === 'priority') return tFallback(t, 'filters.priority', 'Priority');
    return tFallback(t, `sort.${sortBy}`, sortBy);
}

export function getFocusGroupByLabel(groupBy: FocusGroupBy, t: Translate): string {
    switch (groupBy) {
        case 'context':
            return tFallback(t, 'focus.group.context', 'Context');
        case 'project':
            return tFallback(t, 'focus.group.project', 'Project');
        case 'area':
            return tFallback(t, 'focus.group.area', 'Area');
        case 'energy':
            return tFallback(t, 'focus.group.energy', 'Energy');
        case 'priority':
            return tFallback(t, 'focus.group.priority', 'Priority');
        case 'person':
            return tFallback(t, 'people.title', 'People');
        case 'tag':
            return tFallback(t, 'tags.title', 'Tags');
        case 'none':
        default:
            return tFallback(t, 'focus.group.none', 'None');
    }
}


export function selectFocusSavedFilters(savedFilters: readonly SavedFilter[] | undefined): SavedFilter[] {
    return normalizeSavedFilters(savedFilters).filter((filter) => filter.view === 'focus' && !filter.deletedAt);
}


export function getFocusFilterTokens(activeTasks: Task[]): string[] {
    return getUsedTaskTokens(activeTasks, (task) => [...(task.contexts ?? []), ...(task.tags ?? [])], { includeAncestors: true });
}


export function getFocusProjectFilterOptions(
    activeTasks: readonly Task[],
    visibleProjects: readonly Project[],
    t: Translate,
): { id: string; title: string }[] {
    const activeProjectIds = new Set(activeTasks.map((task) => task.projectId).filter((projectId): projectId is string => Boolean(projectId)));
    const projects = visibleProjects
        .filter((project) => activeProjectIds.has(project.id))
        .sort((a, b) => {
            const aOrder = Number.isFinite(a.order) ? (a.order as number) : Number.POSITIVE_INFINITY;
            const bOrder = Number.isFinite(b.order) ? (b.order as number) : Number.POSITIVE_INFINITY;
            if (aOrder !== bOrder) return aOrder - bOrder;
            return a.title.localeCompare(b.title);
        });
    return [
        ...(activeTasks.some((task) => !task.projectId)
            ? [{ id: SAVED_FILTER_NO_PROJECT_ID, title: tFallback(t, 'taskEdit.noProjectOption', 'No project') }]
            : []),
        ...projects.map((project) => ({ id: project.id, title: project.title })),
    ];
}


export function getFocusProjectFilterLabel(projectId: string, projectById: ReadonlyMap<string, Project>, t: Translate): string | undefined {
    return projectId === SAVED_FILTER_NO_PROJECT_ID
        ? tFallback(t, 'taskEdit.noProjectOption', 'No project')
        : projectById.get(projectId)?.title;
}


export function resolveFocusPerspective(input: {
    activeSavedFilter: SavedFilter | null;
    sortBy: SortField;
    settings: AppSettings | undefined;
    hasActiveFilters: boolean;
    hasCurrentCriteria: boolean;
    activeSavedFilterId: string | null;
}): TaskPerspectiveFeatureState<SortField, FocusGroupBy> {
    return resolveTaskPerspectiveForFeatures({
        sortBy: input.activeSavedFilter?.sortBy ?? input.sortBy,
        groupBy: normalizeFocusGroupBy(input.activeSavedFilter?.groupBy ?? normalizeFocusGroupBy(input.settings?.gtd?.focusGroupBy)),
        settings: input.settings,
        hasActiveFilters: input.hasActiveFilters,
        hasCurrentCriteria: input.hasCurrentCriteria,
        activeSavedFilterId: input.activeSavedFilterId,
    });
}


export function planFocusSortChange(next: SortField, current: { effectiveSortBy: SortField; hasActiveSavedFilter: boolean }): { sortBy: SortField } | null {
    if (next === current.effectiveSortBy && !current.hasActiveSavedFilter) return null;
    return { sortBy: next };
}


export function planFocusGroupChange(
    next: FocusGroupBy,
    current: { effectiveGroupBy: FocusGroupBy; hasActiveSavedFilter: boolean; settings: AppSettings | undefined },
): { settingsUpdate: Pick<AppSettings, 'gtd'> } | null {
    if (next === current.effectiveGroupBy && !current.hasActiveSavedFilter) return null;
    return { settingsUpdate: { gtd: { ...(current.settings?.gtd ?? {}), focusGroupBy: next } } };
}


export function getFocusSaveFilterName(chipLabels: readonly string[], fallback: string): string {
    return chipLabels.slice(0, 3).join(' + ') || fallback;
}


export function planFocusFilterSave(input: {
    name: string;
    canSave: boolean;
    currentCriteria: FilterCriteria;
    effectiveSortBy: SortField;
    effectiveGroupBy: FocusGroupBy;
    savedFilters: SavedFilter[] | undefined;
    id: string;
    nowIso: string;
}): { filter: SavedFilter; savedFilters: SavedFilter[] } | null {
    const name = input.name.trim();
    if (!name || !input.canSave) return null;
    const filter: SavedFilter = {
        id: input.id,
        name,
        view: 'focus',
        criteria: input.currentCriteria,
        ...(input.effectiveSortBy !== DEFAULT_FOCUS_SORT_BY ? { sortBy: input.effectiveSortBy } : {}),
        ...(input.effectiveGroupBy !== 'none' ? { groupBy: input.effectiveGroupBy } : {}),
        createdAt: input.nowIso,
        updatedAt: input.nowIso,
    };
    return { filter, savedFilters: [...(input.savedFilters ?? []), filter] };
}


export function planFocusFilterCriterionRemoval(input: {
    activeSavedFilter: SavedFilter | null;
    criterionId: string;
    savedFilters: SavedFilter[] | undefined;
    nowIso: string;
}): { savedFilters: SavedFilter[] } | null {
    const active = input.activeSavedFilter;
    if (!active) return null;
    if (removeAdvancedFilterCriteriaChip(active.criteria, input.criterionId) === active.criteria) return null;
    return {
        savedFilters: (input.savedFilters ?? []).map((filter) => {
            if (filter.id !== active.id) return filter;
            const stored = filter.criteria && typeof filter.criteria === 'object' ? filter.criteria : {};
            return { ...filter, criteria: removeAdvancedFilterCriteriaChip(stored, input.criterionId), updatedAt: input.nowIso };
        }),
    };
}


export function planFocusFilterDelete(savedFilters: readonly SavedFilter[] | undefined, id: string, deletedAt?: string): { savedFilters: SavedFilter[] } {
    return { savedFilters: markSavedFilterDeleted(savedFilters, id, deletedAt) };
}

export type FocusAdvancedFilterChip = {

    id: string;

    criterionId: string;
    label: string;
};


export function buildFocusAdvancedFilterChips(input: {
    activeSavedFilter: SavedFilter | null;
    criteria: FilterCriteria;
    areaById: ReadonlyMap<string, Area>;
    t: Translate;
    formatDate?: (value: string) => string;
}): FocusAdvancedFilterChip[] {
    if (!input.activeSavedFilter) return [];
    return buildAdvancedFilterCriteriaChips(input.criteria, {
        getAreaLabel: (areaId) => input.areaById.get(areaId)?.name,
        resolveText: (key, fallback) => tFallback(input.t, key, fallback),
        ...(input.formatDate ? { formatDate: input.formatDate } : {}),
    }).filter((chip) => chip.id !== 'anyDateRange' && !chip.id.startsWith('excluded-project:')).map((chip) => ({ id: `advanced:${chip.id}`, criterionId: chip.id, label: chip.label }));
}


export function canReorderFocusTasks(input: { effectiveSortBy: SortField; hasActiveFilters: boolean; focusedCount: number }): boolean {
    return input.effectiveSortBy === DEFAULT_FOCUS_SORT_BY && !input.hasActiveFilters && input.focusedCount > 0;
}


export function mergeFocusReorderIds(currentIds: readonly string[], orderedIds: readonly string[]): string[] {
    const current = new Set(currentIds);
    const shown = [...new Set(orderedIds)].filter((id) => current.has(id));
    const shownIds = new Set(shown);
    let index = 0;
    return currentIds.map((id) => shownIds.has(id) ? shown[index++] : id);
}

export function getFocusHiddenByAreaLabel(selection: FocusSelection, t: Translate): string | null {
    return selection.hiddenByAreaCount > 0
        ? formatI18nTemplate(tFallback(t, 'focus.hiddenByArea', '{{count}} selected in other areas'), { count: selection.hiddenByAreaCount })
        : null;
}


export function reconcileFocusReorderOrder<T extends { id: string }>(draft: readonly T[], live: readonly T[]): T[] {
    const byId = new Map(live.map((task) => [task.id, task] as const));
    const kept = draft.filter((task) => byId.has(task.id)).map((task) => byId.get(task.id) as T);
    const keptIds = new Set(kept.map((task) => task.id));
    return [...kept, ...live.filter((task) => !keptIds.has(task.id))];
}


export function moveFocusReorderTask<T extends { id: string }>(order: readonly T[], taskId: string, offset: -1 | 1): T[] | null {
    const from = order.findIndex((task) => task.id === taskId);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= order.length) return null;
    const next = [...order];
    const [moved] = next.splice(from, 1);
    if (!moved) return null;
    next.splice(to, 0, moved);
    return next;
}


export function getFocusReorderPositionLabel(t: Translate, title: string, index: number, count: number): string {
    return formatI18nTemplate(tFallback(t, 'focus.reorderPosition', '{{title}}. Position {{position}} of {{count}}'), {
        title,
        position: index + 1,
        count,
    });
}


export function getFocusReorderSecondaryLabel(task: Task, projectById: ReadonlyMap<string, Project>, formatDate: FormatDate): string {
    const details: string[] = [];
    const project = task.projectId ? projectById.get(task.projectId) : undefined;
    if (project) details.push(project.title);
    const dueDate = safeParseDueDate(task.dueDate);
    if (dueDate) details.push(formatDate(dueDate, hasTimeComponent(task.dueDate) ? 'Pp' : 'P', task.dueDate));
    return details.join(' · ');
}


export type FocusListTaskItem = { type: 'task'; task: Task; grouped: boolean; groupId?: string };
export type FocusListGroupHeader = { type: 'groupHeader'; id: string; title: string; count: number; muted?: boolean; dotColor?: string; collapsed?: boolean };
export type FocusListItem = FocusListTaskItem | FocusListGroupHeader;

const taskItems = (tasks: readonly Task[], grouped = false, groupId?: string): FocusListTaskItem[] => (
    tasks.map((task) => ({ type: 'task' as const, task, grouped, ...(groupId === undefined ? {} : { groupId }) }))
);


export function buildFocusScheduleItems(split: { ready: Task[]; laterToday: Task[] }, t: Translate, collapsedGroupIds?: ReadonlySet<string>): FocusListItem[] {
    const collapsed = collapsedGroupIds?.has('focus:schedule:later-today') === true;
    return [
        ...taskItems(split.ready),
        ...(split.laterToday.length > 0
            ? [
                {
                    type: 'groupHeader' as const,
                    id: 'focus:schedule:later-today',
                    title: tFallback(t, 'agenda.laterToday', 'Later today'),
                    count: split.laterToday.length,
                    muted: true,
                    ...(collapsedGroupIds ? { collapsed } : {}),
                },
                ...(collapsed ? [] : taskItems(split.laterToday, true)),
            ]
            : []),
    ];
}


export function buildFocusNextItems(input: {
    groupBy: FocusGroupBy;
    tasks: Task[];
    projects: Project[];
    areas: Area[];
    t: Translate;
    theme?: string;
    collapsedGroupIds?: ReadonlySet<string>;
}): FocusListItem[] {
    if (input.groupBy === 'none') return taskItems(input.tasks);
    const groups: FocusTaskGroup[] = buildFocusTaskGroups({
        groupBy: input.groupBy,
        tasks: input.tasks,
        projects: input.projects,
        areas: input.areas,
        resolveText: (key, fallback) => tFallback(input.t, key, fallback),
        theme: input.theme,
    });
    return groups.flatMap((group) => [
        {
            type: 'groupHeader' as const,
            id: group.key,
            title: group.label,
            count: group.tasks.length,
            muted: group.muted,
            dotColor: group.dotColor,
            ...(input.collapsedGroupIds ? { collapsed: input.collapsedGroupIds.has(group.key) } : {}),
        },
        ...(input.collapsedGroupIds?.has(group.key) ? [] : taskItems(group.tasks, true, group.key)),
    ]);
}


export function getFocusEmptyState(input: { hasActiveFilters: boolean; hasAnyTasks: boolean; t: Translate }): { title: string; subtitle: string } {
    const { t } = input;
    return input.hasActiveFilters
        ? { title: tFallback(t, 'filters.noMatch', 'No tasks match these filters.'), subtitle: tFallback(t, 'filters.label', 'Filters') }
        : { title: t('agenda.allClear'), subtitle: input.hasAnyTasks ? t('agenda.noTasks') : t('agenda.emptyStart') };
}


export type FocusControlState = {

    filters: ListFilterState;

    savedFilterId: string | null;

    preservedCriteria?: FilterCriteria;

    sortBy: SortField;
};

export const DEFAULT_FOCUS_CONTROL_STATE: FocusControlState = {
    filters: EMPTY_LIST_FILTER_STATE,
    savedFilterId: null,
    sortBy: DEFAULT_FOCUS_SORT_BY,
};

export type ResolvedFocusFilter = {

    state: FocusControlState;
    activeSavedFilter: SavedFilter | null;

    criteria: FilterCriteria;

    currentCriteria: FilterCriteria;
    activeCount: number;
    hasActive: boolean;
    hasCurrentCriteria: boolean;
    canSave: boolean;

    chips: ListFilterChip[];
    showContextMatchMode: boolean;
    showTagMatchMode: boolean;
};


export function resolveFocusFilterState(
    input: FocusControlState,
    options: {
        savedFilters: readonly SavedFilter[];
        visibility: TaskMetadataFilterVisibility;
        retainTokens: readonly string[];
        retainProjects: readonly string[];
        getProjectLabel: (projectId: string) => string | undefined;
        t: Translate;
    },
): ResolvedFocusFilter {
    const { visibility } = options;
    const resolved = resolveListFilterState(input.filters, options);
    const { state } = resolved;
    const activeSavedFilter = options.savedFilters.find((filter) => filter.id === input.savedFilterId) ?? null;
    const currentCriteria = { ...criteriaFromSelections({
        tokens: state.tokens,
        excludedTokens: state.excludedTokens,
        projects: state.projects,
        excludedProjects: state.excludedProjects,
        statuses: state.statuses,
        locations: visibility.location && state.location.trim() ? [state.location.trim()] : [],
        priorities: visibility.priority ? state.priorities : [],
        energyLevels: visibility.energyLevel ? state.energyLevels : [],
        timeEstimates: visibility.timeEstimate ? state.timeEstimates : [],
        contextMatchMode: state.contextMatchMode,
        tagMatchMode: state.tagMatchMode,
        anyDateRange: state.anyDateRange,
    }), ...input.preservedCriteria };


    const criteria: FilterCriteria = {
        ...(activeSavedFilter?.criteria ?? currentCriteria),
        ...(visibility.priority ? {} : { priority: undefined }),
        ...(visibility.energyLevel ? {} : { energy: undefined }),
        ...(visibility.location ? {} : { locations: undefined }),
        ...(visibility.timeEstimate ? {} : { timeEstimates: undefined, timeEstimateRange: undefined }),
    };
    const activeCount = (state.searchQuery.trim().toLowerCase() ? 1 : 0) + countActiveFilterCriteria(criteria);
    const hasCurrentCriteria = hasActiveFilterCriteria(currentCriteria);
    const savedFilterId = activeSavedFilter ? activeSavedFilter.id : null;
    return {
        state: { filters: state, savedFilterId, sortBy: input.sortBy, ...(input.preservedCriteria ? { preservedCriteria: input.preservedCriteria } : {}) },
        activeSavedFilter,
        criteria,
        currentCriteria,
        activeCount,
        hasActive: activeCount > 0,
        hasCurrentCriteria,
        canSave: savedFilterId === null && hasCurrentCriteria,
        chips: resolved.chips.filter((chip) => !chip.id.startsWith('status:') && (!activeSavedFilter || chip.id !== 'location')),
        showContextMatchMode: resolved.showContextMatchMode,
        showTagMatchMode: resolved.showTagMatchMode,
    };
}


export type FocusControlEdit =

    | { type: 'filter'; edit: ListFilterEdit }

    | { type: 'sort'; sortBy: SortField }

    | { type: 'applySavedFilter'; id: string }
    | { type: 'removePreservedCriterion'; criterionId: string };


export function applyFocusSavedFilter(state: FocusControlState, filter: SavedFilter): FocusControlState {
    const selections = selectionsFromCriteria(filter.criteria);
    const { anyDateRange: _previousDate, excludedProjects: _previousExcludedProjects, statuses: _previousStatuses, ...filters } = state.filters;
    return {
        filters: {
            ...filters,
            tokens: selections.tokens,
            excludedTokens: selections.excludedTokens,
            projects: selections.projects,
            ...(selections.excludedProjects ? { excludedProjects: selections.excludedProjects } : {}),
            ...(selections.statuses ? { statuses: selections.statuses } : {}),
            priorities: selections.priorities,
            energyLevels: selections.energyLevels,
            timeEstimates: selections.timeEstimates,
            location: selections.locations[0] ?? '',
            contextMatchMode: selections.contextMatchMode,
            tagMatchMode: selections.tagMatchMode,
            ...(selections.anyDateRange ? { anyDateRange: selections.anyDateRange } : {}),
        },
        savedFilterId: filter.id,
        sortBy: filter.sortBy ?? DEFAULT_FOCUS_SORT_BY,
    };
}


export function applyFocusControlEdit(
    resolved: Pick<ResolvedFocusFilter, 'state' | 'activeSavedFilter'> & { effectiveSortBy: SortField },
    edit: FocusControlEdit,
    savedFilters: readonly SavedFilter[],
    rawSavedFilters: readonly SavedFilter[] = savedFilters,
): FocusControlState | null {
    const { state } = resolved;
    switch (edit.type) {
        case 'filter': {
            if (edit.edit.type === 'clear') return DEFAULT_FOCUS_CONTROL_STATE;
            const preserved = { ...(resolved.activeSavedFilter
                ? rawSavedFilters.find((filter) => filter.id === resolved.activeSavedFilter!.id)?.criteria ?? resolved.activeSavedFilter.criteria
                : state.preservedCriteria) };
            const forget = (...fields: (keyof FilterCriteria)[]) => { fields.forEach((field) => { delete preserved[field]; }); };
            switch (edit.edit.type) {
                case 'setAnyDateRange': forget('anyDateRange'); break;
                case 'removeToken':
                case 'toggleToken': forget('contexts', 'tags', 'excludedContexts', 'excludedTags'); break;
                case 'toggleProject':
                case 'cycleProject':
                case 'removeProject': forget('projects', 'excludedProjects'); break;
                case 'toggleStatus': forget('statuses'); break;
                case 'togglePriority': forget('priority'); break;
                case 'toggleEnergyLevel': forget('energy'); break;
                case 'toggleTimeEstimate': forget('timeEstimates', 'timeEstimateRange'); break;
                case 'setLocation': forget('locations'); break;
                case 'setMatchMode': forget(edit.edit.kind === 'context' ? 'contextMatchMode' : 'tagMatchMode'); break;
            }
            return {
                ...state,
                filters: applyListFilterEdit(state.filters, edit.edit),
                savedFilterId: edit.edit.type === 'setSearch' ? state.savedFilterId : null,
                ...(state.preservedCriteria || resolved.activeSavedFilter
                    ? { preservedCriteria: preserved } : {}),
            };
        }
        case 'sort': {
            const plan = planFocusSortChange(edit.sortBy, {
                effectiveSortBy: resolved.effectiveSortBy,
                hasActiveSavedFilter: resolved.activeSavedFilter !== null,
            });
            return plan ? { ...state, savedFilterId: null, sortBy: plan.sortBy } : state;
        }
        case 'removePreservedCriterion': {
            const preservedCriteria = { ...state.preservedCriteria };
            const filters = { ...state.filters };
            switch (edit.criterionId) {
                case 'priority': delete preservedCriteria.priority; filters.priorities = []; break;
                case 'energy': delete preservedCriteria.energy; filters.energyLevels = []; break;
                case 'timeEstimates': delete preservedCriteria.timeEstimates; filters.timeEstimates = []; break;
                case 'projects': delete preservedCriteria.projects; filters.projects = []; break;
                default:
                    if (edit.criterionId.startsWith('location:')) filters.location = '';
                    if (edit.criterionId.startsWith('status:')) filters.statuses = filters.statuses?.filter((status) => status !== edit.criterionId.slice('status:'.length));
                    return { ...state, filters, preservedCriteria: removeAdvancedFilterCriteriaChip(preservedCriteria, edit.criterionId) };
            }
            return { ...state, filters, preservedCriteria };
        }
        case 'applySavedFilter': {
            const filter = savedFilters.find((entry) => entry.id === edit.id);
            return filter ? applyFocusSavedFilter(state, filter) : null;
        }
    }
}

export type FocusControlsModel = {
    options: { tokens: string[]; projects: { id: string; title: string }[]; timeEstimates: TimeEstimate[]; visibility: TaskMetadataFilterVisibility };
    savedFilters: SavedFilter[];
    filter: ResolvedFocusFilter;
    perspective: TaskPerspectiveFeatureState<SortField, FocusGroupBy>;
    prioritiesEnabled: boolean;
    pools: FocusPools;
    lists: FocusTaskLists;
    selection: FocusSelection;
    globalFocusedTasks: Task[];
    reviewProjects: Project[];
    advancedChips: FocusAdvancedFilterChip[];
    canReorder: boolean;

    hasTasks: boolean;

    empty: { title: string; subtitle: string } | null;
    areaById: Map<string, Area>;
    projectById: Map<string, Project>;
};


export function buildFocusControlsModel(input: {
    state: FocusControlState;

    tasks: Task[];
    projects: Project[];
    areas: Area[];
    sections: Section[];
    settings: AppSettings;
    now: Date;
    t: Translate;
    formatDate?: (value: string) => string;
}): FocusControlsModel {
    const { settings, now, t } = input;
    const flags = resolveFeatureFlags(settings);
    const sortedAreas = input.areas
        .filter((area) => !area.deletedAt)
        .sort((a, b) => (a.order !== b.order ? a.order - b.order : a.name.localeCompare(b.name)));
    const areaById = new Map(sortedAreas.map((area) => [area.id, area]));
    const projectById = new Map(input.projects.map((project) => [project.id, project]));
    const resolvedAreaFilter = resolveAreaFilterSelection(settings.filters, sortedAreas);
    const visibleProjects = input.projects.filter((project) => (
        !project.deletedAt && projectMatchesAreaFilterSelection(project, resolvedAreaFilter, areaById)
    ));
    const actionableTasks = input.tasks.filter(isTaskActionable);
    const baseActiveTasks = actionableTasks.filter((task) => isTaskVisibleInArea(task, { areaById, projectById, resolvedAreaFilter }));
    const activeTasks = baseActiveTasks.filter((task) => shouldShowTaskForStart(task, { now, granularity: 'time' }));
    const tokens = getFocusFilterTokens(activeTasks);
    const projects = getFocusProjectFilterOptions(activeTasks, visibleProjects, t);
    const visibility = getTaskMetadataFilterVisibility(activeTasks, {
        prioritiesEnabled: flags.priorities,
        timeEstimatesEnabled: flags.timeEstimates,
    });
    const savedFilters = selectFocusSavedFilters(settings.savedFilters);
    const filter = resolveFocusFilterState(input.state, {
        savedFilters,
        visibility,
        retainTokens: tokens,
        retainProjects: projects.map((option) => option.id),
        getProjectLabel: (projectId) => getFocusProjectFilterLabel(projectId, projectById, t),
        t,
    });
    const perspective = resolveFocusPerspective({
        activeSavedFilter: filter.activeSavedFilter,
        sortBy: filter.state.sortBy,
        settings,
        hasActiveFilters: filter.hasActive,
        hasCurrentCriteria: filter.hasCurrentCriteria,
        activeSavedFilterId: filter.state.savedFilterId,
    });
    const pools = buildFocusPools({ tasks: actionableTasks, visibleTasks: baseActiveTasks, projects: input.projects, criteria: filter.criteria, now,
        isAreaVisible: (task) => taskMatchesAreaFilterSelection(task, resolvedAreaFilter, projectById, areaById),
    });
    const lists = deriveFocusTaskLists(pools, {
        now,
        projects: input.projects,
        sections: input.sections,
        sortBy: perspective.effectiveSortBy,
        prioritiesEnabled: flags.priorities,
        sortOrder: filter.activeSavedFilter?.sortOrder,
        focusIncludeStartDates: settings.gtd?.focusIncludeStartDates,
    });
    const reviewProjects = getReviewDueProjects(visibleProjects, now);
    const hasTasks = pools.selection.globalCount > 0 || lists.schedule.length > 0 || lists.nextActions.length > 0
        || lists.upcoming.length > 0 || lists.reviewDue.length > 0 || reviewProjects.length > 0;
    return {
        options: { tokens, projects, timeEstimates: TIME_ESTIMATE_OPTIONS, visibility },
        savedFilters,
        filter,
        perspective,
        prioritiesEnabled: flags.priorities,
        pools,
        lists,
        selection: pools.selection,
        globalFocusedTasks: sortTasksByFocusOrder(input.tasks.filter((task) => isTaskCountedAsFocused(task, now))),
        reviewProjects,
        advancedChips: buildFocusAdvancedFilterChips({
            activeSavedFilter: filter.activeSavedFilter, criteria: filter.criteria, areaById, t, formatDate: input.formatDate,
        }),
        canReorder: canReorderFocusTasks({
            effectiveSortBy: perspective.effectiveSortBy,
            hasActiveFilters: filter.hasActive,
            focusedCount: lists.focusedTasks.length,
        }),
        hasTasks,
        empty: hasTasks ? null : getFocusEmptyState({ hasActiveFilters: filter.hasActive, hasAnyTasks: input.tasks.length > 0, t }),
        areaById,
        projectById,
    };
}
