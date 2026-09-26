/**
 * The Focus screen's controls as plain logic, for React Native's Focus screen
 * (`app/(drawer)/(tabs)/focus.tsx`) and for hosts that cannot run its hooks
 * (native-host-contract-focus-controls.ts): the filter sheet's options, the
 * sort and group choices, saved Focus filters (apply, save, update, delete) as
 * decision-to-write plans, the list items the sections draw, and the Today's
 * Focus reorder gate.
 *
 * The rows themselves always come from buildFocusPools and deriveFocusTaskLists
 * (focus-sections.ts); nothing here sorts, buckets or narrows a task.
 *
 * Mobile keeps the filter selections, the active saved filter and the sort in
 * React state (useTaskFilterSelections plus the screen's own sort state), so
 * they last as long as the screen is mounted. `FocusControlState` is that state
 * as plain data, and `resolveFocusFilterState` / `applyFocusControlEdit` mirror
 * the hook for a host that keeps it itself.
 */
import { isTaskVisibleInArea, projectMatchesAreaFilterSelection, resolveAreaFilterSelection } from './area-filter';
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
import { hasActiveFilterCriteria, markSavedFilterDeleted, SAVED_FILTER_NO_PROJECT_ID } from './saved-filters';
import { resolveFeatureFlags } from './resolve-feature-flags';
import { FOCUS_SORT_OPTIONS } from './task-list-sort-options';
import { getTaskMetadataFilterVisibility, type TaskMetadataFilterVisibility } from './task-metadata-filter-visibility';
import { isTaskActionable } from './task-status';
import { getUsedTaskTokens } from './task-token-usage';
import { resolveTaskPerspectiveForFeatures, shouldShowTaskForStart, type TaskPerspectiveFeatureState } from './task-utils';
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

/** View options' Sort row: 'priority' is offered only while Priorities is on. */
export function getFocusSortOptions(prioritiesEnabled: boolean): readonly SortField[] {
    return prioritiesEnabled ? FOCUS_SORT_OPTIONS : FOCUS_SORT_OPTIONS.filter((option) => option !== 'priority');
}

/** View options' Group by row: 'priority' is offered only while Priorities is on. */
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

/** The saved filters Focus offers: its own, not deleted, in stored order. */
export function selectFocusSavedFilters(savedFilters: readonly SavedFilter[] | undefined): SavedFilter[] {
    return (savedFilters ?? []).filter((filter) => filter.view === 'focus' && !filter.deletedAt);
}

/**
 * The filter sheet's context and tag chips: tokens on the tasks Focus can show
 * now (visible, actionable, started by the minute).
 */
export function getFocusFilterTokens(activeTasks: Task[]): string[] {
    return getUsedTaskTokens(activeTasks, (task) => [...(task.contexts ?? []), ...(task.tags ?? [])]);
}

/**
 * The filter sheet's project chips: "No project" when an active task has none,
 * then each visible project with an active task, by project order then title.
 */
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

/** A selected project's chip label; a project that no longer exists gets no chip. */
export function getFocusProjectFilterLabel(projectId: string, projectById: ReadonlyMap<string, Project>, t: Translate): string | undefined {
    return projectId === SAVED_FILTER_NO_PROJECT_ID
        ? tFallback(t, 'taskEdit.noProjectOption', 'No project')
        : projectById.get(projectId)?.title;
}

/**
 * The sort and grouping in effect. An applied saved filter's own sort and
 * grouping win over the screen's; a 'priority' sort or grouping stops taking
 * effect while Priorities is off (the stored choice survives for re-enable).
 */
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

/** A Sort chip: null when it changes nothing; otherwise it detaches any saved filter. */
export function planFocusSortChange(next: SortField, current: { effectiveSortBy: SortField; hasActiveSavedFilter: boolean }): { sortBy: SortField } | null {
    if (next === current.effectiveSortBy && !current.hasActiveSavedFilter) return null;
    return { sortBy: next };
}

/**
 * A Group by chip: null when it changes nothing; otherwise it detaches any
 * saved filter and writes the synced `settings.gtd.focusGroupBy`.
 */
export function planFocusGroupChange(
    next: FocusGroupBy,
    current: { effectiveGroupBy: FocusGroupBy; hasActiveSavedFilter: boolean; settings: AppSettings | undefined },
): { settingsUpdate: Pick<AppSettings, 'gtd'> } | null {
    if (next === current.effectiveGroupBy && !current.hasActiveSavedFilter) return null;
    return { settingsUpdate: { gtd: { ...(current.settings?.gtd ?? {}), focusGroupBy: next } } };
}

/** The save dialog's starting name: the first three active chips, else `fallback` (savedFilters.defaultName, "Focus filter"). */
export function getFocusSaveFilterName(chipLabels: readonly string[], fallback: string): string {
    return chipLabels.slice(0, 3).join(' + ') || fallback;
}

/**
 * Save the current Focus filter: the picker's criteria plus a non-default sort
 * and grouping, appended to the synced saved filters. Null when there is
 * nothing to save or no name.
 */
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

/**
 * Remove one criterion that no picker can express (an area, a date range…)
 * from the applied saved filter. Null when there is no applied filter or the
 * criterion is not on it.
 */
export function planFocusFilterCriterionRemoval(input: {
    activeSavedFilter: SavedFilter | null;
    criterionId: string;
    savedFilters: SavedFilter[] | undefined;
    nowIso: string;
}): { savedFilters: SavedFilter[] } | null {
    const active = input.activeSavedFilter;
    if (!active) return null;
    const criteria = removeAdvancedFilterCriteriaChip(active.criteria, input.criterionId);
    if (criteria === active.criteria) return null;
    return {
        savedFilters: (input.savedFilters ?? []).map((filter) => (
            filter.id === active.id ? { ...filter, criteria, updatedAt: input.nowIso } : filter
        )),
    };
}

/** Delete a saved filter: saved filters are synced, so it is marked deleted, never dropped. */
export function planFocusFilterDelete(savedFilters: readonly SavedFilter[] | undefined, id: string, deletedAt?: string): { savedFilters: SavedFilter[] } {
    return { savedFilters: markSavedFilterDeleted(savedFilters, id, deletedAt) };
}

export type FocusAdvancedFilterChip = {
    /** `advanced:` + the criterion id. */
    id: string;
    /** What planFocusFilterCriterionRemoval removes. */
    criterionId: string;
    label: string;
};

/**
 * An applied saved filter's criteria that no picker can express. They are
 * removed from the saved filter itself, not from the selections. Empty without
 * an applied saved filter.
 */
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
    }).map((chip) => ({ id: `advanced:${chip.id}`, criterionId: chip.id, label: chip.label }));
}

/**
 * Manual Today's Focus order is a whole-list concept: reordering a filtered
 * subset would renumber only the visible rows and corrupt the hidden ones'
 * positions. So reorder needs the default sort, no active filter, and a star.
 */
export function canReorderFocusTasks(input: { effectiveSortBy: SortField; hasActiveFilters: boolean; focusedCount: number }): boolean {
    return input.effectiveSortBy === DEFAULT_FOCUS_SORT_BY && !input.hasActiveFilters && input.focusedCount > 0;
}

/** The dragged order kept against the live list: gone tasks drop out, new ones join at the end. */
export function reconcileFocusReorderOrder<T extends { id: string }>(draft: readonly T[], live: readonly T[]): T[] {
    const byId = new Map(live.map((task) => [task.id, task] as const));
    const kept = draft.filter((task) => byId.has(task.id)).map((task) => byId.get(task.id) as T);
    const keptIds = new Set(kept.map((task) => task.id));
    return [...kept, ...live.filter((task) => !keptIds.has(task.id))];
}

/** Move up / Move down in reorder mode; null at either end. */
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

/** A reorder row's spoken label: "{{title}}. Position {{position}} of {{count}}". */
export function getFocusReorderPositionLabel(t: Translate, title: string, index: number, count: number): string {
    return formatI18nTemplate(tFallback(t, 'focus.reorderPosition', '{{title}}. Position {{position}} of {{count}}'), {
        title,
        position: index + 1,
        count,
    });
}

/** A reorder row's second line: the project, then the due date. */
export function getFocusReorderSecondaryLabel(task: Task, projectById: ReadonlyMap<string, Project>, formatDate: FormatDate): string {
    const details: string[] = [];
    const project = task.projectId ? projectById.get(task.projectId) : undefined;
    if (project) details.push(project.title);
    const dueDate = safeParseDueDate(task.dueDate);
    if (dueDate) details.push(formatDate(dueDate, hasTimeComponent(task.dueDate) ? 'Pp' : 'P', task.dueDate));
    return details.join(' · ');
}

/** `groupId` is the Next group heading the row sits under: grouping by context or tag can show a task under several. */
export type FocusListTaskItem = { type: 'task'; task: Task; grouped: boolean; groupId?: string };
export type FocusListGroupHeader = { type: 'groupHeader'; id: string; title: string; count: number; muted?: boolean; dotColor?: string };
export type FocusListItem = FocusListTaskItem | FocusListGroupHeader;

const taskItems = (tasks: readonly Task[], grouped = false, groupId?: string): FocusListTaskItem[] => (
    tasks.map((task) => ({ type: 'task' as const, task, grouped, ...(groupId === undefined ? {} : { groupId }) }))
);

/** Today's rows: ready ones, then a muted "Later today" heading over the timed starts still to come. */
export function buildFocusScheduleItems(split: { ready: Task[]; laterToday: Task[] }, t: Translate): FocusListItem[] {
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
                },
                ...taskItems(split.laterToday, true),
            ]
            : []),
    ];
}

/** Next actions' rows under the grouping in effect ('none' keeps them flat). */
export function buildFocusNextItems(input: {
    groupBy: FocusGroupBy;
    tasks: Task[];
    projects: Project[];
    areas: Area[];
    t: Translate;
    theme?: string;
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
        },
        ...taskItems(group.tasks, true, group.key),
    ]);
}

/** The empty Focus screen's two lines. */
export function getFocusEmptyState(input: { hasActiveFilters: boolean; hasAnyTasks: boolean; t: Translate }): { title: string; subtitle: string } {
    const { t } = input;
    return input.hasActiveFilters
        ? { title: tFallback(t, 'filters.noMatch', 'No tasks match these filters.'), subtitle: tFallback(t, 'filters.label', 'Filters') }
        : { title: t('agenda.allClear'), subtitle: input.hasAnyTasks ? t('agenda.noTasks') : t('agenda.emptyStart') };
}

// ---------------------------------------------------------------------------
// The control state as plain data, for hosts that cannot run the hooks.

export type FocusControlState = {
    /** The filter picker's selections (searchQuery stays '': Focus has no search box). */
    filters: ListFilterState;
    /** The applied saved filter; picker changes, sort and grouping detach it. */
    savedFilterId: string | null;
    /** The screen's own sort; an applied saved filter's sort wins while applied. */
    sortBy: SortField;
};

export const DEFAULT_FOCUS_CONTROL_STATE: FocusControlState = {
    filters: EMPTY_LIST_FILTER_STATE,
    savedFilterId: null,
    sortBy: DEFAULT_FOCUS_SORT_BY,
};

export type ResolvedFocusFilter = {
    /** The state after the hook's effects: dropped selections gone, a missing saved filter detached. */
    state: FocusControlState;
    activeSavedFilter: SavedFilter | null;
    /** What narrows the sections: the saved filter's own criteria while one is applied. */
    criteria: FilterCriteria;
    /** What the picker selects; what Save writes. */
    currentCriteria: FilterCriteria;
    activeCount: number;
    hasActive: boolean;
    hasCurrentCriteria: boolean;
    canSave: boolean;
    /** The picker's chips. A saved filter owns its location, so no location chip while one is applied. */
    chips: ListFilterChip[];
    showContextMatchMode: boolean;
    showTagMatchMode: boolean;
};

/** useTaskFilterSelections's derived values for a plain state (Focus: no search box). */
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
    const currentCriteria = criteriaFromSelections({
        tokens: state.tokens,
        excludedTokens: state.excludedTokens,
        projects: state.projects,
        locations: visibility.location && state.location.trim() ? [state.location.trim()] : [],
        priorities: visibility.priority ? state.priorities : [],
        energyLevels: visibility.energyLevel ? state.energyLevels : [],
        timeEstimates: visibility.timeEstimate ? state.timeEstimates : [],
        contextMatchMode: state.contextMatchMode,
        tagMatchMode: state.tagMatchMode,
    });
    // An applied saved filter can carry criteria no picker can express, so it
    // filters from its own criteria, still gated by what this view can show.
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
        state: { filters: state, savedFilterId, sortBy: input.sortBy },
        activeSavedFilter,
        criteria,
        currentCriteria,
        activeCount,
        hasActive: activeCount > 0,
        hasCurrentCriteria,
        canSave: savedFilterId === null && hasCurrentCriteria,
        chips: activeSavedFilter ? resolved.chips.filter((chip) => chip.id !== 'location') : resolved.chips,
        showContextMatchMode: resolved.showContextMatchMode,
        showTagMatchMode: resolved.showTagMatchMode,
    };
}

/** One Focus control's change that writes nothing. */
export type FocusControlEdit =
    /** A filter sheet or chip change; `clear` also resets the sort (the All chip, Clear, a selected saved filter). */
    | { type: 'filter'; edit: ListFilterEdit }
    /** A View options Sort chip. */
    | { type: 'sort'; sortBy: SortField }
    /** An unselected saved filter chip. */
    | { type: 'applySavedFilter'; id: string };

/** Applying a saved filter: its criteria become the selections, its sort the screen's sort. */
export function applyFocusSavedFilter(state: FocusControlState, filter: SavedFilter): FocusControlState {
    const selections = selectionsFromCriteria(filter.criteria);
    return {
        filters: {
            ...state.filters,
            tokens: selections.tokens,
            excludedTokens: selections.excludedTokens,
            projects: selections.projects,
            priorities: selections.priorities,
            energyLevels: selections.energyLevels,
            timeEstimates: selections.timeEstimates,
            location: selections.locations[0] ?? '',
            contextMatchMode: selections.contextMatchMode,
            tagMatchMode: selections.tagMatchMode,
        },
        savedFilterId: filter.id,
        sortBy: filter.sortBy ?? DEFAULT_FOCUS_SORT_BY,
    };
}

/**
 * The state after one edit, as the hook and the screen apply it. `resolved` is
 * the current state's resolution (the edit reads the sort in effect); null for
 * a saved filter Focus does not offer.
 */
export function applyFocusControlEdit(
    resolved: Pick<ResolvedFocusFilter, 'state' | 'activeSavedFilter'> & { effectiveSortBy: SortField },
    edit: FocusControlEdit,
    savedFilters: readonly SavedFilter[],
): FocusControlState | null {
    const { state } = resolved;
    switch (edit.type) {
        case 'filter':
            if (edit.edit.type === 'clear') return DEFAULT_FOCUS_CONTROL_STATE;
            return {
                ...state,
                filters: applyListFilterEdit(state.filters, edit.edit),
                savedFilterId: edit.edit.type === 'setSearch' ? state.savedFilterId : null,
            };
        case 'sort': {
            const plan = planFocusSortChange(edit.sortBy, {
                effectiveSortBy: resolved.effectiveSortBy,
                hasActiveSavedFilter: resolved.activeSavedFilter !== null,
            });
            return plan ? { ...state, savedFilterId: null, sortBy: plan.sortBy } : state;
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
    reviewProjects: Project[];
    advancedChips: FocusAdvancedFilterChip[];
    canReorder: boolean;
    /** Any section (Projects to review included) has something to show. */
    hasTasks: boolean;
    /** The empty screen's lines when no section has anything. */
    empty: { title: string; subtitle: string } | null;
    areaById: Map<string, Area>;
    projectById: Map<string, Project>;
};

/**
 * Everything the Focus screen derives from the store and the control state, in
 * one pass, the way the screen derives it: the area-visible actionable tasks,
 * the filter sheet's options, the resolved selections, the sort and grouping in
 * effect, and the sections through buildFocusPools and deriveFocusTaskLists.
 */
export function buildFocusControlsModel(input: {
    state: FocusControlState;
    /** The store's live tasks (`state.tasks`). */
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
    const pools = buildFocusPools({ tasks: actionableTasks, visibleTasks: baseActiveTasks, projects: input.projects, criteria: filter.criteria, now });
    const lists = deriveFocusTaskLists(pools, {
        now,
        projects: input.projects,
        sections: input.sections,
        sortBy: perspective.effectiveSortBy,
        prioritiesEnabled: flags.priorities,
        sortOrder: filter.activeSavedFilter?.sortOrder,
    });
    const reviewProjects = getReviewDueProjects(visibleProjects, now);
    const hasTasks = lists.focusedTasks.length > 0 || lists.schedule.length > 0 || lists.nextActions.length > 0
        || lists.upcoming.length > 0 || lists.reviewDue.length > 0 || reviewProjects.length > 0;
    return {
        options: { tokens, projects, timeEstimates: TIME_ESTIMATE_OPTIONS, visibility },
        savedFilters,
        filter,
        perspective,
        prioritiesEnabled: flags.priorities,
        pools,
        lists,
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
