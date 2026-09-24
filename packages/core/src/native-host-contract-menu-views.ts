/**
 * The native host contract for the Menu tab's More sheet and the Waiting,
 * Someday, Reference and Done screens. Kept in its own file and spread into
 * createNativeHostContract: other changes edit native-host-contract.ts in
 * parallel. Every view is the React Native screen's, from the same core models
 * (menu-views-model.ts, someday-sections-model.ts, more-menu-model.ts).
 *
 * Every collection a view carries (rows, filter options, people, parked
 * projects, sections, saved searches) is windowed by NATIVE_HOST_MAX_WINDOW.
 * A view returns the first window of each; getMenuViewCollection pages the rest
 * under the same revision.
 *
 * Only functions read this module's imports from native-host-contract.ts, so
 * the import cycle between the two files is safe.
 */
import { isTaskVisibleInArea, resolveAreaFilterSelection } from './area-filter';
import type { DateFormatter } from './date';
import { formatTimeEstimateLabel, isCustomTimeEstimate, TIME_ESTIMATE_OPTIONS } from './calendar-scheduling';
import {
    applyListFilterEdit,
    EMPTY_LIST_FILTER_STATE,
    resolveListFilterState,
    type ListFilterEdit,
    type ListFilterState,
    type ResolvedListFilter,
} from './list-filter-state';
import {
    buildSomedayFilterOptions,
    buildSomedayViewModel,
    buildStatusListFilterOptions,
    buildStatusListFilterSummary,
    buildStatusListModel,
    buildWaitingViewModel,
    DONE_LIST_DEFAULT_GROUP_BY,
    DONE_LIST_GROUP_OPTIONS,
    getSomedayGroupSectionId,
    getStatusListScreenText,
    isStatusListTaskReadOnly,
    REFERENCE_LIST_DEFAULT_GROUP_BY,
    selectSomedayTasks,
    selectStatusListTasks,
    SOMEDAY_GROUP_OPTIONS,
    TASK_LIST_GROUP_OPTIONS,
    type DeferredProjectsSection,
    type ListFilterOptions,
    type SomedayGroupBy,
    type StatusListKind,
} from './menu-views-model';
import { buildMoreMenuModel, type MoreMenuItem, type MoreMenuModel } from './more-menu-model';
import {
    NATIVE_HOST_CONTRACT_VERSION,
    NATIVE_HOST_MAX_WINDOW,
    sortAreasForDisplay,
    type NativeHostResult,
    type NativeTaskRow,
} from './native-host-contract';
import { createNativeRequestReceipts, runStoreWrite, settleWrite } from './native-request-receipts';
import {
    buildSomedaySectionManagerRows,
    buildSomedaySectionMoveDialog,
    buildSomedaySectionsSettingsUpdate,
    formatSomedaySectionMoved,
    getSomedaySectionManagerText,
    getSomedaySectionMoveTasks,
    getSomedaySectionMoveText,
    getSomedaySectionTaskText,
    moveSomedaySection,
    planSomedaySectionCreate,
    planSomedaySectionMove,
    planSomedaySectionTaskAdd,
    removeSomedaySection,
    renameSomedaySection,
    type SomedaySectionAssignment,
} from './someday-sections-model';
import { useTaskStore } from './store';
import { TASK_EDITOR_ENERGY_LEVEL_OPTIONS, TASK_EDITOR_PRIORITY_OPTIONS } from './task-editor-model';
import type { TaskGroupBy } from './task-group-sections';
import { DONE_TASK_LIST_SORT_OPTIONS, TASK_LIST_SORT_OPTIONS } from './task-list-sort-options';
import { tFallback } from './i18n';
import type { MultiValueFilterMatchMode, Task, TaskEnergyLevel, TaskPriority, TaskSortBy, TimeEstimate, ViewSectionDefinition } from './types';
import { buildTaskViewSectionUndoUpdates, sortViewSectionDefinitions } from './view-sections';

type NativeHostErrorCode = Extract<NativeHostResult<never>, { ok: false }>['error']['code'];

export type MenuViewDeps = {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    /** Data plus display revision: tasks, projects, settings, language and the minute. */
    revision: (now: Date) => string;
    t: () => (key: string) => string;
    /** The user's date formatting (createDateFormatter); the only formatter this block uses. */
    formatDate: () => DateFormatter;
    /** Rows with core meta, as the other contract lists build them. */
    rows: (tasks: readonly Task[], now: Date) => NativeTaskRow[];
    requestIdPattern: RegExp;
};

/** A user-visible refusal, shown the way mobile shows it (a toast or the dialog's error line). */
export type NativeMenuViewRefusal = { refused: { title: string | null; message: string } };

/** The first NATIVE_HOST_MAX_WINDOW items of a collection; getMenuViewCollection pages the rest. */
export type NativeWindow<T> = { total: number; items: T[] };

export type NativeSomedayMoveResult =
    | {
        moved: number;
        toast: { message: string; undoLabel: string } | null;
        /** Send this to undoSomedaySectionMove as `moveRequestId`; null when nothing moved. */
        undoRequestId: string | null;
    }
    | NativeMenuViewRefusal;

export type NativeMoreMenu = Omit<MoreMenuModel, 'savedSearches'> & {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    revision: string;
    savedSearches: NativeWindow<MoreMenuItem>;
};

export type TokenOption = { value: string; state: 'included' | 'excluded' | 'none'; edit: ListFilterEdit };
type ProjectOption = { id: string; title: string; selected: boolean; edit: ListFilterEdit };
/** A match mode control (the picker's footer): Any, then All, each with the edit that chooses it. */
export type NativeMatchModeControl = {
    kind: 'context' | 'tag';
    label: string;
    options: { value: MultiValueFilterMatchMode; label: string; selected: boolean; edit: ListFilterEdit }[];
};

/** The filter picker: options carry the exact edit to send back as `filterEdit`. */
export type NativeListFilterView = {
    /** The effective state; send it back as `filters` with the next read. */
    state: ListFilterState;
    activeCount: number;
    hasActive: boolean;
    clearEdit: ListFilterEdit;
    visibility: ListFilterOptions['visibility'];
    showContextMatchMode: boolean;
    showTagMatchMode: boolean;
    /** The match mode controls shown (contexts, then tags); empty until two tokens of a kind are chosen. */
    matchModes: NativeMatchModeControl[];
    tokens: NativeWindow<TokenOption>;
    projects: NativeWindow<ProjectOption> | null;
    priorities: { value: TaskPriority; label: string; selected: boolean; edit: ListFilterEdit }[];
    energyLevels: { value: TaskEnergyLevel; label: string; selected: boolean; edit: ListFilterEdit }[];
    timeEstimates: { value: TimeEstimate; label: string; selected: boolean; edit: ListFilterEdit }[];
};

export type NativeListChip = {
    id: string;
    label: string;
    excluded: boolean;
    /** What removing the chip sends: a filter edit, or Reference's archived-projects toggle turned off. */
    action: { filterEdit: ListFilterEdit } | { includeArchivedProjects: false };
};

type DeferredRow = DeferredProjectsSection['rows'][number];
export type NativeDeferredProjects = Omit<DeferredProjectsSection, 'rows'> & { rows: NativeWindow<DeferredRow> };
type PersonOption = { label: string; person: string; selected: boolean };

type Paged<T> = {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    /** Changes with the data, settings, language, minute and the view's resolved inputs. */
    revision: string;
    total: number;
} & T;

export type NativeWaitingView = Paged<{
    rows: NativeTaskRow[];
    /** The person in effect: '' when the one asked for is no longer offered. */
    person: string;
    /** The "All" chip; sending person '' chooses it. */
    all: { label: string; selected: boolean };
    /** Each person; send `person` back to choose it. */
    people: NativeWindow<PersonOption>;
    filterLabel: string;
    /** Shown while a person is chosen; sending person '' clears it. */
    clearLabel: string | null;
    stats: { value: number; label: string }[];
    deferred: NativeDeferredProjects | null;
    empty: { title: string; hint: string } | null;
    /** Waiting rows show their detail parts. */
    showDetails: true;
}>;

export type NativeSomedayItem =
    | {
        type: 'heading';
        id: string;
        title: string;
        muted: boolean;
        /** Section grouping only: the section a new task goes to (null = No section). */
        addTask: { sectionId: string | null; label: string; accessibilityLabel: string } | null;
    }
    | { type: 'task'; row: NativeTaskRow; groupId: string | null };

export type NativeSomedayView = Paged<{
    items: NativeSomedayItem[];
    sortBy: TaskSortBy;
    groupBy: SomedayGroupBy;
    showDetails: boolean;
    stats: { value: number; label: string }[];
    /** The summary chip beside the stats while filters are on; its edit clears them. */
    filterChip: { label: string; removeLabel: string } | null;
    menu: {
        filters: { label: string; selected: boolean };
        sort: { label: string; accessibilityLabel: string; value: string; options: { value: TaskSortBy; label: string; accessibilityLabel: string; selected: boolean }[] };
        group: { label: string; accessibilityLabel: string; value: string; options: { value: SomedayGroupBy; label: string; accessibilityLabel: string; selected: boolean }[] };
        details: { label: string; selected: boolean };
        newSection: { label: string };
        backLabel: string;
        closeLabel: string;
        moreLabel: string;
    };
    filters: NativeListFilterView;
    chips: NativeListChip[];
    sections: NativeWindow<ViewSectionDefinition>;
    deferred: NativeDeferredProjects | null;
    empty: { title: string; hint: string; clear: boolean } | null;
    text: {
        moveToSection: string;
        undoLabel: string;
        errorTitle: string;
        moveFailed: string;
        undoFailed: string;
        /** The Add task dialog; its title is the heading's `addTask.accessibilityLabel`. */
        addTask: Omit<ReturnType<typeof getSomedaySectionTaskText>, 'title'>;
    };
}>;

export type NativeStatusListItem =
    | { type: 'section'; id: string; title: string; count: number; muted: boolean; collapsible: boolean; collapsed: boolean }
    | { type: 'task'; row: NativeTaskRow & { readOnly: boolean }; groupId: string | null };

/** Reference and Done; the Inbox has its own view (native-host-contract-inbox-view.ts). */
type MenuStatusListKind = Exclude<StatusListKind, 'inbox'>;

export type NativeStatusListView = Paged<{
    kind: MenuStatusListKind;
    title: string;
    items: NativeStatusListItem[];
    /** Tasks shown (the header count). */
    count: number;
    groupBy: TaskGroupBy;
    sortBy: TaskSortBy;
    includeArchivedProjects: boolean;
    collapsedGroupIds: string[];
    sort: { title: string; label: string; options: { value: TaskSortBy; label: string; selected: boolean }[] };
    group: { title: string; label: string; options: { value: TaskGroupBy; label: string; selected: boolean }[] };
    filters: NativeListFilterView;
    /** The header's active filters, Reference's archived-projects toggle included. */
    chips: NativeListChip[];
    filterActiveCount: number;
    hasActiveFilters: boolean;
    /** Reference only: the filter sheet's top switch. */
    archivedProjectsToggle: { label: string; value: boolean } | null;
    /** Shown when there are no items; `clear` is set when filters hide everything. */
    empty: { message: string; hint: string; actionLabel: string | null; clear: boolean };
}>;

export type MenuViewCollectionName = 'savedSearches' | 'people' | 'deferredProjects' | 'tokens' | 'projects' | 'sections';
const VIEW_COLLECTIONS: Record<string, readonly MenuViewCollectionName[]> = {
    more: ['savedSearches'],
    waiting: ['people', 'deferredProjects'],
    someday: ['tokens', 'projects', 'sections', 'deferredProjects'],
    reference: ['tokens', 'projects'],
    done: ['tokens'],
};

// The helpers below, down to nativeFilterView, are shared with the Inbox view (native-host-contract-inbox-view.ts).
export const fail = (code: NativeHostErrorCode, message: string): NativeHostResult<never> => ({ ok: false, error: { code, message } });
export const isObjectRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);
// ponytail: id lists (a selection) stop at 1000; raise with the selection UI if people select more.
const MAX_IDS = 1000;
export const isText = (value: unknown, max = 500): value is string => typeof value === 'string' && value.length <= max;
export const isTextList = (value: unknown, max = MAX_IDS): value is string[] => (
    Array.isArray(value) && value.length <= max && value.every((entry) => isText(entry))
);
const MATCH_MODES = new Set(['all', 'any']);
const isTimeEstimate = (value: unknown): value is TimeEstimate => (
    typeof value === 'string' && (TIME_ESTIMATE_OPTIONS.includes(value as TimeEstimate) || isCustomTimeEstimate(value as TimeEstimate))
);
// Selections are bounded by the window, so the chips they make are bounded too.
const FILTER_STATE_CHECKS: Record<keyof ListFilterState, (value: unknown) => boolean> = {
    searchQuery: (value) => isText(value, 2000),
    tokens: (value) => isTextList(value, NATIVE_HOST_MAX_WINDOW),
    excludedTokens: (value) => isTextList(value, NATIVE_HOST_MAX_WINDOW),
    projects: (value) => isTextList(value, NATIVE_HOST_MAX_WINDOW),
    priorities: (value) => Array.isArray(value) && value.every((entry) => TASK_EDITOR_PRIORITY_OPTIONS.includes(entry as TaskPriority)),
    energyLevels: (value) => Array.isArray(value) && value.every((entry) => TASK_EDITOR_ENERGY_LEVEL_OPTIONS.includes(entry as TaskEnergyLevel)),
    timeEstimates: (value) => Array.isArray(value) && value.length <= 50 && value.every(isTimeEstimate),
    location: (value) => isText(value, 500),
    contextMatchMode: (value) => MATCH_MODES.has(value as string),
    tagMatchMode: (value) => MATCH_MODES.has(value as string),
};

/** A partial state is completed from the empty one; unknown keys are refused. */
export const readFilterState = (value: unknown): ListFilterState | null => {
    if (value === undefined) return EMPTY_LIST_FILTER_STATE;
    if (!isObjectRecord(value)) return null;
    for (const [key, entry] of Object.entries(value)) {
        const check = FILTER_STATE_CHECKS[key as keyof ListFilterState];
        if (!check || !check(entry)) return null;
    }
    return { ...EMPTY_LIST_FILTER_STATE, ...(value as Partial<ListFilterState>) };
};

export const isFilterEdit = (edit: unknown): edit is ListFilterEdit => {
    if (!isObjectRecord(edit)) return false;
    switch (edit.type) {
        case 'toggleToken':
        case 'removeToken':
        case 'toggleProject':
            return isText(edit.value) && (edit.value as string).length > 0;
        case 'togglePriority':
            return TASK_EDITOR_PRIORITY_OPTIONS.includes(edit.value as TaskPriority);
        case 'toggleEnergyLevel':
            return TASK_EDITOR_ENERGY_LEVEL_OPTIONS.includes(edit.value as TaskEnergyLevel);
        case 'toggleTimeEstimate':
            return isTimeEstimate(edit.value);
        case 'setSearch':
            return isText(edit.value, 2000);
        case 'setLocation':
            return isText(edit.value, 500);
        case 'setMatchMode':
            return (edit.kind === 'context' || edit.kind === 'tag') && MATCH_MODES.has(edit.value as string);
        case 'clear':
            return true;
        default:
            return false;
    }
};

export type PageInput = { offset: number; limit: number; revision?: string };
export const isPaging = (input: Record<string, unknown>) => (
    Number.isSafeInteger(input.offset) && (input.offset as number) >= 0
    && Number.isSafeInteger(input.limit) && (input.limit as number) >= 1 && (input.limit as number) <= NATIVE_HOST_MAX_WINDOW
    && (input.revision === undefined || typeof input.revision === 'string')
    && ((input.offset as number) === 0 || typeof input.revision === 'string')
);

/** A short, stable key for a view's own inputs, so a page of one filter never continues another. */
export const paramsKey = (params: unknown): string => {
    const text = JSON.stringify(params);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(36);
};

export const page = <T,>(items: readonly T[], input: { offset: number; limit: number }) => items.slice(input.offset, input.offset + input.limit);
export const firstWindow = <T,>(items: readonly T[]): NativeWindow<T> => ({ total: items.length, items: items.slice(0, NATIVE_HOST_MAX_WINDOW) });

/**
 * The picker's search, as mobile's filter sheet narrows its token and project lists:
 * a trimmed, case-insensitive substring. toLowerCase, not toLocaleLowerCase: QuickJS has no Intl.
 */
export const matchesPickerQuery = (label: string, query: string): boolean => label.toLowerCase().includes(query.trim().toLowerCase());

const matchModeControls = (resolved: ResolvedListFilter, t: (key: string) => string): NativeMatchModeControl[] => {
    const control = (kind: 'context' | 'tag', label: string, mode: MultiValueFilterMatchMode): NativeMatchModeControl => ({
        kind,
        label,
        options: (['any', 'all'] as const).map((value) => ({
            value,
            label: value === 'any' ? tFallback(t, 'filters.matchAny', 'Any') : tFallback(t, 'common.all', 'All'),
            selected: mode === value,
            edit: { type: 'setMatchMode', kind, value },
        })),
    });
    return [
        ...(resolved.showContextMatchMode ? [control('context', tFallback(t, 'filters.contextMatchMode', 'Context match'), resolved.state.contextMatchMode)] : []),
        ...(resolved.showTagMatchMode ? [control('tag', tFallback(t, 'filters.tagMatchMode', 'Tag match'), resolved.state.tagMatchMode)] : []),
    ];
};

export const tokenOptions = (options: ListFilterOptions, state: ListFilterState): TokenOption[] => options.tokens.map((value) => ({
    value,
    state: state.tokens.includes(value) ? 'included' : state.excludedTokens.includes(value) ? 'excluded' : 'none',
    edit: { type: 'toggleToken', value },
}));
const projectOptions = (options: ListFilterOptions, state: ListFilterState): ProjectOption[] | null => options.projects?.map((project) => ({
    ...project,
    selected: state.projects.includes(project.id),
    edit: { type: 'toggleProject', value: project.id },
})) ?? null;

export const nativeFilterView = (
    resolved: ResolvedListFilter,
    options: ListFilterOptions,
    tokens: TokenOption[],
    projects: ProjectOption[] | null,
    t: (key: string) => string,
): NativeListFilterView => {
    const { state } = resolved;
    return {
        state,
        activeCount: resolved.activeCount,
        hasActive: resolved.hasActive,
        clearEdit: { type: 'clear' },
        visibility: options.visibility,
        showContextMatchMode: resolved.showContextMatchMode,
        showTagMatchMode: resolved.showTagMatchMode,
        matchModes: matchModeControls(resolved, t),
        tokens: firstWindow(tokens),
        projects: projects ? firstWindow(projects) : null,
        priorities: TASK_EDITOR_PRIORITY_OPTIONS.map((value) => ({
            value, label: t(`priority.${value}`), selected: state.priorities.includes(value), edit: { type: 'togglePriority', value },
        })),
        energyLevels: TASK_EDITOR_ENERGY_LEVEL_OPTIONS.map((value) => ({
            value, label: t(`energyLevel.${value}`), selected: state.energyLevels.includes(value), edit: { type: 'toggleEnergyLevel', value },
        })),
        timeEstimates: options.timeEstimates.map((value) => ({
            value, label: formatTimeEstimateLabel(value), selected: state.timeEstimates.includes(value), edit: { type: 'toggleTimeEstimate', value },
        })),
    };
};

const filterChips = (resolved: ResolvedListFilter): NativeListChip[] => resolved.chips.map((chip) => ({
    id: chip.id, label: chip.label, excluded: chip.excluded, action: { filterEdit: chip.edit },
}));

type MoveUndo = { previous: SomedaySectionAssignment[]; sectionId: string | null };

/** A view's data, its revision (from the resolved inputs) and its collections. */
type Built<T> = { revision: string; now: Date; data: T; collections: Partial<Record<MenuViewCollectionName, readonly unknown[]>> };

export function createMenuViewMethods(deps: MenuViewDeps) {
    const writeFailure = (message: string | undefined): NativeHostResult<never> => {
        const failure = useTaskStore.getState().persistenceFailure;
        return fail(failure ? 'SAVE_FAILED' : 'ACTION_FAILED', failure?.message ?? message ?? 'Write failed');
    };
    const caught = (error: unknown) => writeFailure(error instanceof Error ? error.message : String(error));
    /** Makes every write so far durable: retries a failed save, then flushes. */
    const durableSave = async (): Promise<NativeHostResult<null>> => {
        try {
            if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
        } catch (error) {
            return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error));
        }
        return deps.save();
    };
    /** Nothing new to write: finish an earlier failed save, then acknowledge durably. */
    const settle = async <T,>(value: T): Promise<NativeHostResult<T>> => {
        const saved = await durableSave();
        return saved.ok ? { ok: true, value } : saved;
    };
    // Moves, their Undo and Add task retry exactly through the shared helper.
    const receipts = createNativeRequestReceipts({ save: durableSave });
    // ponytail: the 50 most recent moves keep their Undo, in memory like mobile's Undo toast;
    // an older move, or any move after a restart, can no longer be undone.
    const undoByMove = new Map<string, MoveUndo>();
    const rememberUndo = (requestId: string, undo: MoveUndo) => {
        undoByMove.set(requestId, undo);
        if (undoByMove.size > 50) undoByMove.delete(undoByMove.keys().next().value!);
    };

    const visibleContext = () => {
        const state = useTaskStore.getState();
        const areas = sortAreasForDisplay(state.areas);
        const areaById = new Map(areas.map((area) => [area.id, area]));
        const resolvedAreaFilter = resolveAreaFilterSelection(state.settings.filters, areas);
        const projectById = new Map(state.projects.map((project) => [project.id, project]));
        const visibleTasks = state.tasks.filter((task) => isTaskVisibleInArea(task, { areaById, projectById, resolvedAreaFilter }));
        return { state, areas, areaById, resolvedAreaFilter, visibleTasks };
    };

    // ponytail: one cached build per screen, keyed by the data and the raw inputs; paging rebuilds nothing.
    const cache = new Map<string, { key: string; value: unknown }>();
    const cached = <T,>(screen: string, key: string, build: () => T): T => {
        const hit = cache.get(screen);
        if (hit?.key === key) return hit.value as T;
        const value = build();
        cache.set(screen, { key, value });
        return value;
    };

    const buildMore = (): Built<MoreMenuModel> => {
        const settings = useTaskStore.getState().settings;
        const now = new Date();
        const data = buildMoreMenuModel({
            quickAccessView: settings.appearance?.mobileQuickAccessView,
            savedSearches: settings.savedSearches,
            t: deps.t(),
        });
        return { revision: deps.revision(now), now, data, collections: { savedSearches: data.savedSearches } };
    };

    const readWaitingParams = (input: Record<string, unknown>) => (
        input.person === undefined || isText(input.person, 200) ? { person: (input.person as string | undefined) ?? '' } : null
    );
    const buildWaiting = (params: { person: string }) => {
        const t = deps.t();
        const now = new Date();
        const base = deps.revision(now);
        const data = cached('waiting', `${base}:${paramsKey(params)}`, () => {
            const { state, areaById, resolvedAreaFilter, visibleTasks } = visibleContext();
            const model = buildWaitingViewModel({
                tasks: visibleTasks, projects: state.projects, resolvedAreaFilter, areaById, person: params.person, t,
            });
            const person = model.person;
            return {
                model,
                person,
                people: model.people.map((entry): PersonOption => ({
                    label: entry, person: entry, selected: person.toLowerCase() === entry.toLowerCase(),
                })),
            };
        });
        return {
            revision: `${base}:${paramsKey(['waiting', data.person])}`,
            now,
            data,
            collections: { people: data.people, deferredProjects: data.model.deferred?.rows ?? [] },
        } satisfies Built<typeof data>;
    };

    const readSomedayParams = (input: Record<string, unknown>) => {
        const filters = readFilterState(input.filters);
        if (!filters
            || (input.sortBy !== undefined && !TASK_LIST_SORT_OPTIONS.includes(input.sortBy as TaskSortBy))
            || (input.groupBy !== undefined && !SOMEDAY_GROUP_OPTIONS.includes(input.groupBy as SomedayGroupBy))
            || (input.showDetails !== undefined && typeof input.showDetails !== 'boolean')
            || (input.filterEdit !== undefined && !isFilterEdit(input.filterEdit))) {
            return null;
        }
        const edit = input.filterEdit as ListFilterEdit | undefined;
        return {
            sortBy: (input.sortBy as TaskSortBy | undefined) ?? 'default',
            groupBy: (input.groupBy as SomedayGroupBy | undefined) ?? 'viewSection',
            showDetails: input.showDetails === true,
            filters: edit ? applyListFilterEdit(filters, edit) : filters,
        };
    };
    const buildSomeday = (params: NonNullable<ReturnType<typeof readSomedayParams>>) => {
        const t = deps.t();
        const now = new Date();
        const base = deps.revision(now);
        const data = cached('someday', `${base}:${paramsKey(params)}`, () => {
            const { state, areaById, resolvedAreaFilter, visibleTasks } = visibleContext();
            const tasks = selectSomedayTasks(visibleTasks);
            const options = buildSomedayFilterOptions({ tasks, projects: state.projects, settings: state.settings, t });
            const resolved = resolveListFilterState(params.filters, {
                visibility: options.visibility,
                retainTokens: options.retainTokens,
                retainProjects: options.retainProjects,
                getProjectLabel: options.getProjectLabel,
                t,
            });
            const model = buildSomedayViewModel({
                tasks, projects: state.projects, areaById, resolvedAreaFilter, settings: state.settings,
                sortBy: params.sortBy, groupBy: params.groupBy, showDetails: params.showDetails,
                criteria: resolved.criteria, searchQuery: resolved.searchQuery, filterChips: resolved.chips, t,
            });
            const items: ({ type: 'heading'; id: string; title: string; muted: boolean } | { type: 'task'; task: Task; groupId: string | null })[] = model.groups
                ? model.groups.flatMap((group) => [
                    { type: 'heading' as const, id: group.id, title: group.title, muted: group.muted === true },
                    ...group.tasks.map((task) => ({ type: 'task' as const, task, groupId: group.id })),
                ])
                : model.tasks.map((task) => ({ type: 'task' as const, task, groupId: null }));
            return {
                model, resolved, options, items,
                tokens: tokenOptions(options, resolved.state),
                projects: projectOptions(options, resolved.state),
            };
        });
        const { sortBy, groupBy, showDetails } = params;
        return {
            revision: `${base}:${paramsKey(['someday', sortBy, groupBy, showDetails, data.resolved.state])}`,
            now,
            data,
            collections: {
                tokens: data.tokens,
                projects: data.projects ?? [],
                sections: data.model.sections,
                deferredProjects: data.model.deferred?.rows ?? [],
            },
        } satisfies Built<typeof data>;
    };

    const readStatusParams = (kind: MenuStatusListKind, input: Record<string, unknown>) => {
        const groupOptions: readonly string[] = kind === 'done' ? DONE_LIST_GROUP_OPTIONS : TASK_LIST_GROUP_OPTIONS;
        const filters = readFilterState(input.filters);
        if (!filters
            || (input.groupBy !== undefined && !groupOptions.includes(input.groupBy as string))
            || (input.sortBy !== undefined && (kind !== 'done' || !DONE_TASK_LIST_SORT_OPTIONS.includes(input.sortBy as TaskSortBy)))
            || (input.includeArchivedProjects !== undefined && (kind !== 'reference' || typeof input.includeArchivedProjects !== 'boolean'))
            || (input.collapsedGroupIds !== undefined && !isTextList(input.collapsedGroupIds, 200))
            || (input.filterEdit !== undefined && !isFilterEdit(input.filterEdit))) {
            return null;
        }
        const edit = input.filterEdit as ListFilterEdit | undefined;
        return {
            kind,
            groupBy: (input.groupBy as TaskGroupBy | undefined) ?? (kind === 'done' ? DONE_LIST_DEFAULT_GROUP_BY : REFERENCE_LIST_DEFAULT_GROUP_BY),
            viewSortBy: input.sortBy as TaskSortBy | undefined,
            // Mobile's Clear also turns archived projects off.
            includeArchivedProjects: kind === 'reference' && input.includeArchivedProjects === true && edit?.type !== 'clear',
            collapsedGroupIds: (input.collapsedGroupIds as string[] | undefined) ?? [],
            filters: edit ? applyListFilterEdit(filters, edit) : filters,
        };
    };
    const buildStatus = (params: NonNullable<ReturnType<typeof readStatusParams>>) => {
        const { kind } = params;
        const t = deps.t();
        const now = new Date();
        const base = deps.revision(now);
        const data = cached(kind, `${base}:${paramsKey(params)}`, () => {
            const { state, areaById, resolvedAreaFilter } = visibleContext();
            const tasks = selectStatusListTasks({
                kind, tasks: state.tasks, projects: state.projects, allProjects: state._allProjects,
                resolvedAreaFilter, areaById, includeArchivedProjects: params.includeArchivedProjects,
            });
            const options = buildStatusListFilterOptions({ kind, tasks, allProjects: state._allProjects, settings: state.settings, t });
            const resolved = resolveListFilterState(params.filters, {
                visibility: options.visibility,
                retainProjects: options.retainProjects,
                getProjectLabel: options.getProjectLabel,
                t,
            });
            const model = buildStatusListModel({
                kind, tasks, projects: state.projects, areas: state.areas, settings: state.settings,
                groupBy: params.groupBy, viewSortBy: params.viewSortBy,
                criteria: resolved.criteria, searchQuery: resolved.searchQuery,
                collapsedGroupIds: new Set(params.collapsedGroupIds), t, now, formatDate: deps.formatDate(),
            });
            const summary = buildStatusListFilterSummary({
                kind, chips: resolved.chips, activeCount: resolved.activeCount, hasActive: resolved.hasActive,
                includeArchivedProjects: params.includeArchivedProjects, t,
            });
            const chips = [
                ...filterChips(resolved),
                ...(summary.chips.length > resolved.chips.length
                    ? [{ ...summary.chips[summary.chips.length - 1], action: { includeArchivedProjects: false as const } }]
                    : []),
            ];
            const allProjects = state._allProjects;
            return {
                model, resolved, options, summary, chips,
                title: getStatusListScreenText(kind, t).title,
                tokens: tokenOptions(options, resolved.state),
                projects: projectOptions(options, resolved.state),
                archivedProjectsToggle: kind === 'reference' ? { label: t('reference.includeArchivedProjects'), value: params.includeArchivedProjects } : null,
                readOnly: (task: Task) => isStatusListTaskReadOnly(task, allProjects),
            };
        });
        const { groupBy, viewSortBy, includeArchivedProjects, collapsedGroupIds } = params;
        return {
            revision: `${base}:${paramsKey([kind, groupBy, viewSortBy, includeArchivedProjects, collapsedGroupIds, data.resolved.state])}`,
            now,
            data,
            collections: { tokens: data.tokens, projects: data.projects ?? [] },
        } satisfies Built<typeof data>;
    };

    const statusListView = (kind: MenuStatusListKind, input: Record<string, unknown>): NativeHostResult<NativeStatusListView> => {
        const ready = deps.readiness();
        if (!ready.ok) return ready;
        const params = isObjectRecord(input) ? readStatusParams(kind, input) : null;
        if (!params || !isPaging(input)) {
            return fail('INVALID_INPUT', 'A valid offset, bounded limit, revision for later pages, and this list\'s grouping, sort and filters are required');
        }
        const built = buildStatus(params);
        if (input.revision !== undefined && input.revision !== built.revision) {
            return fail('STALE_REVISION', 'The list changed; restart paging from offset zero');
        }
        const { data, now } = built;
        const { model } = data;
        const windowItems = page(model.items, input as PageInput);
        const rows = deps.rows(windowItems.flatMap((item) => (item.type === 'task' ? [item.task] : [])), now);
        let rowIndex = 0;
        return {
            ok: true,
            value: {
                version: NATIVE_HOST_CONTRACT_VERSION,
                revision: built.revision,
                total: model.items.length,
                kind,
                title: data.title,
                items: windowItems.map((item): NativeStatusListItem => (item.type === 'section'
                    ? item
                    : { type: 'task', row: { ...rows[rowIndex++], readOnly: data.readOnly(item.task) }, groupId: item.groupId })),
                count: model.orderedTasks.length,
                groupBy: params.groupBy,
                sortBy: model.sortBy,
                includeArchivedProjects: params.includeArchivedProjects,
                collapsedGroupIds: params.collapsedGroupIds,
                sort: { title: model.sortTitle, label: model.sortByLabel, options: model.sortOptions },
                group: { title: model.groupTitle, label: model.groupByLabel, options: model.groupOptions },
                filters: nativeFilterView(data.resolved, data.options, data.tokens, data.projects, deps.t()),
                chips: data.chips,
                filterActiveCount: data.summary.activeCount,
                hasActiveFilters: data.summary.hasActive,
                archivedProjectsToggle: data.archivedProjectsToggle,
                empty: { ...data.summary.empty, clear: data.resolved.hasActive },
            },
        };
    };

    const somedaySections = () => useTaskStore.getState().settings.gtd?.viewSections?.someday;

    const updateSomedaySections = async (next: ViewSectionDefinition[]) => {
        const state = useTaskStore.getState();
        await state.updateSettings(buildSomedaySectionsSettingsUpdate(state.settings, next));
    };

    const deferredWindow = (deferred: DeferredProjectsSection | null): NativeDeferredProjects | null => (
        deferred ? { ...deferred, rows: firstWindow(deferred.rows) } : null
    );

    return {
        /** The Menu tab's More sheet. */
        getMoreMenu(): NativeHostResult<NativeMoreMenu> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const built = buildMore();
            return {
                ok: true,
                value: {
                    version: NATIVE_HOST_CONTRACT_VERSION,
                    revision: built.revision,
                    ...built.data,
                    savedSearches: firstWindow(built.data.savedSearches),
                },
            };
        },

        /** Waiting For. `person` chooses one person's tasks ('' or absent = All). */
        getWaitingView(input: { person?: string; offset: number; limit: number; revision?: string }): NativeHostResult<NativeWaitingView> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const params = isObjectRecord(input) ? readWaitingParams(input) : null;
            if (!params || !isPaging(input)) {
                return fail('INVALID_INPUT', 'A valid offset, bounded limit, revision for later pages, and person are required');
            }
            const built = buildWaiting(params);
            if (input.revision !== undefined && input.revision !== built.revision) {
                return fail('STALE_REVISION', 'Waiting changed; restart paging from offset zero');
            }
            const { model, person, people } = built.data;
            const { labels } = model;
            return {
                ok: true,
                value: {
                    version: NATIVE_HOST_CONTRACT_VERSION,
                    revision: built.revision,
                    total: model.tasks.length,
                    rows: deps.rows(page(model.tasks, input), built.now),
                    person,
                    all: { label: labels.all, selected: !person },
                    people: firstWindow(people),
                    filterLabel: labels.filter,
                    clearLabel: person ? labels.clear : null,
                    stats: [{ value: model.count, label: labels.count }, { value: model.withDeadlineCount, label: labels.withDeadline }],
                    deferred: deferredWindow(model.deferred),
                    empty: model.showEmptyState ? { title: labels.emptyTitle, hint: labels.emptyHint } : null,
                    showDetails: true,
                },
            };
        },

        /**
         * Someday/Maybe. `sortBy`, `groupBy` and `showDetails` are the screen's
         * session choices (defaults: default, viewSection, off); send the returned
         * `filters.state` back with a control's `filterEdit`.
         */
        getSomedayView(input: {
            sortBy?: TaskSortBy;
            groupBy?: SomedayGroupBy;
            showDetails?: boolean;
            filters?: Partial<ListFilterState>;
            filterEdit?: ListFilterEdit;
            offset: number;
            limit: number;
            revision?: string;
        }): NativeHostResult<NativeSomedayView> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const params = isObjectRecord(input) ? readSomedayParams(input) : null;
            if (!params || !isPaging(input)) {
                return fail('INVALID_INPUT', 'A valid offset, bounded limit, revision for later pages, sort, grouping and filters are required');
            }
            const built = buildSomeday(params);
            if (input.revision !== undefined && input.revision !== built.revision) {
                return fail('STALE_REVISION', 'Someday changed; restart paging from offset zero');
            }
            const t = deps.t();
            const { model, resolved, options } = built.data;
            const { labels } = model;
            const windowItems = page(built.data.items, input);
            const rows = deps.rows(windowItems.flatMap((item) => (item.type === 'task' ? [item.task] : [])), built.now);
            let rowIndex = 0;
            const moveText = getSomedaySectionMoveText(t);
            const { title: _title, ...addTaskText } = getSomedaySectionTaskText(t, '');
            return {
                ok: true,
                value: {
                    version: NATIVE_HOST_CONTRACT_VERSION,
                    revision: built.revision,
                    total: built.data.items.length,
                    items: windowItems.map((item): NativeSomedayItem => {
                        if (item.type === 'task') return { type: 'task', row: rows[rowIndex++], groupId: item.groupId };
                        const sectionId = model.canAddTaskToGroup ? getSomedayGroupSectionId(item.id) : null;
                        return {
                            ...item,
                            addTask: sectionId === null ? null : {
                                sectionId: sectionId ?? null,
                                label: labels.addTask,
                                accessibilityLabel: getSomedaySectionTaskText(t, item.title).title,
                            },
                        };
                    }),
                    sortBy: params.sortBy,
                    groupBy: params.groupBy,
                    showDetails: params.showDetails,
                    stats: [{ value: model.ideasCount, label: labels.ideas }, { value: model.inProjectsCount, label: labels.inProjects }],
                    filterChip: resolved.hasActive
                        ? { label: `${labels.filters} · ${resolved.activeCount}`, removeLabel: `${labels.filtersClear}: ${labels.filters}` }
                        : null,
                    menu: {
                        filters: { label: labels.filters, selected: resolved.hasActive },
                        sort: {
                            label: labels.sort,
                            accessibilityLabel: `${labels.sort}: ${model.menu.sortValue}`,
                            value: model.menu.sortValue,
                            options: model.menu.sortOptions.map((option) => ({ ...option, accessibilityLabel: `${labels.sort}: ${option.label}` })),
                        },
                        group: {
                            label: labels.group,
                            accessibilityLabel: `${labels.group}: ${model.menu.groupValue}`,
                            value: model.menu.groupValue,
                            options: model.menu.groupOptions.map((option) => ({ ...option, accessibilityLabel: `${labels.group}: ${option.label}` })),
                        },
                        details: { label: labels.details, selected: params.showDetails },
                        newSection: { label: labels.newSection },
                        backLabel: labels.back,
                        closeLabel: labels.close,
                        moreLabel: labels.more,
                    },
                    filters: nativeFilterView(resolved, options, built.data.tokens, built.data.projects, t),
                    chips: filterChips(resolved),
                    sections: firstWindow(model.sections),
                    deferred: deferredWindow(model.deferred),
                    empty: model.showEmptyState ? { title: labels.emptyTitle, hint: labels.emptyHint, clear: model.empty.actionLabel !== null } : null,
                    text: {
                        moveToSection: labels.moveToSection,
                        undoLabel: moveText.undoLabel,
                        errorTitle: moveText.errorTitle,
                        moveFailed: moveText.moveFailed,
                        undoFailed: moveText.undoFailed,
                        addTask: addTaskText,
                    },
                },
            };
        },

        /** Reference. Defaults: grouped by area, archived projects hidden. */
        getReferenceView(input: {
            groupBy?: TaskGroupBy;
            includeArchivedProjects?: boolean;
            filters?: Partial<ListFilterState>;
            filterEdit?: ListFilterEdit;
            collapsedGroupIds?: string[];
            offset: number;
            limit: number;
            revision?: string;
        }): NativeHostResult<NativeStatusListView> {
            return statusListView('reference', input as Record<string, unknown>);
        },

        /** Done. `groupBy` and `sortBy` are the device's saved view choices (defaults: none, the stored sort). */
        getDoneView(input: {
            groupBy?: TaskGroupBy;
            sortBy?: TaskSortBy;
            filters?: Partial<ListFilterState>;
            filterEdit?: ListFilterEdit;
            collapsedGroupIds?: string[];
            offset: number;
            limit: number;
            revision?: string;
        }): NativeHostResult<NativeStatusListView> {
            return statusListView('done', input as Record<string, unknown>);
        },

        /**
         * A later window of one of a view's collections. `params` are the view's own
         * inputs as last sent (with the returned `filters.state`, no `filterEdit`);
         * `revision` is the view's. `query` is the filter picker's search text: the
         * tokens or projects matching it, from offset zero.
         */
        getMenuViewCollection(input: {
            view: 'more' | 'waiting' | 'someday' | 'reference' | 'done';
            collection: MenuViewCollectionName;
            params?: Record<string, unknown>;
            query?: string;
            offset: number;
            limit: number;
            revision: string;
        }): NativeHostResult<{
            version: typeof NATIVE_HOST_CONTRACT_VERSION;
            revision: string;
            view: string;
            collection: MenuViewCollectionName;
            total: number;
            items: unknown[];
        }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const params = isObjectRecord(input) && input.params !== undefined ? input.params : {};
            if (!isObjectRecord(input) || !isObjectRecord(params) || typeof input.revision !== 'string' || !isPaging(input)
                || !VIEW_COLLECTIONS[input.view as string]?.includes(input.collection) || params.filterEdit !== undefined
                || (input.query !== undefined && (!isText(input.query) || (input.collection !== 'tokens' && input.collection !== 'projects')))) {
                return fail('INVALID_INPUT', 'A view, one of its collections, its params, a valid window, its revision and a picker query only for tokens or projects are required');
            }
            let built: Built<unknown> | null = null;
            if (input.view === 'more') built = buildMore();
            if (input.view === 'waiting') {
                const waiting = readWaitingParams(params);
                built = waiting ? buildWaiting(waiting) : null;
            }
            if (input.view === 'someday') {
                const someday = readSomedayParams(params);
                built = someday ? buildSomeday(someday) : null;
            }
            if (input.view === 'reference' || input.view === 'done') {
                const status = readStatusParams(input.view, params);
                built = status ? buildStatus(status) : null;
            }
            if (!built) return fail('INVALID_INPUT', 'The view params are not valid');
            if (built.revision !== input.revision) return fail('STALE_REVISION', 'The view changed; read it again');
            const all = built.collections[input.collection] ?? [];
            const query = input.query;
            const items = query === undefined ? all : all.filter((item) => matchesPickerQuery(
                input.collection === 'tokens' ? (item as TokenOption).value : (item as ProjectOption).title,
                query,
            ));
            return {
                ok: true,
                value: {
                    version: NATIVE_HOST_CONTRACT_VERSION,
                    revision: built.revision,
                    view: input.view,
                    collection: input.collection,
                    total: items.length,
                    items: page(items, input),
                },
            };
        },

        /** Someday's sections as Settings › Manage lists them; `moveUp.ids` / `moveDown.ids` go to reorderSomedaySections. */
        getSomedaySections(input: PageInput = { offset: 0, limit: NATIVE_HOST_MAX_WINDOW }): NativeHostResult<{
            version: typeof NATIVE_HOST_CONTRACT_VERSION;
            revision: string;
            total: number;
            text: ReturnType<typeof getSomedaySectionManagerText>;
            rows: (ReturnType<typeof buildSomedaySectionManagerRows>[number] & {
                moveUp: { ids: string[] | null };
                moveDown: { ids: string[] | null };
            })[];
        }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !isPaging(input)) return fail('INVALID_INPUT', 'A valid offset, bounded limit and revision for later pages are required');
            const t = deps.t();
            const revision = deps.revision(new Date());
            if (input.revision !== undefined && input.revision !== revision) return fail('STALE_REVISION', 'Sections changed; read them again');
            const stored = somedaySections();
            const rows = buildSomedaySectionManagerRows(stored, t);
            const orderAfter = (id: string, offset: -1 | 1) => moveSomedaySection(stored, id, offset)?.map((section) => section.id) ?? null;
            return {
                ok: true,
                value: {
                    version: NATIVE_HOST_CONTRACT_VERSION,
                    revision,
                    total: rows.length,
                    text: getSomedaySectionManagerText(t),
                    rows: page(rows, input).map((row) => ({
                        ...row,
                        moveUp: { ...row.moveUp, ids: orderAfter(row.id, -1) },
                        moveDown: { ...row.moveDown, ids: orderAfter(row.id, 1) },
                    })),
                },
            };
        },

        /** The Move to section dialog for these tasks: choices ("No section" first) with the current one selected. */
        getSomedayMoveDialog(input: { taskIds: string[]; offset?: number; limit?: number; revision?: string }): NativeHostResult<
            Omit<ReturnType<typeof buildSomedaySectionMoveDialog>, 'choices'> & {
                version: typeof NATIVE_HOST_CONTRACT_VERSION;
                revision: string;
                choices: NativeWindow<ReturnType<typeof buildSomedaySectionMoveDialog>['choices'][number]>;
            }
        > {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const window = isObjectRecord(input) ? { offset: input.offset ?? 0, limit: input.limit ?? NATIVE_HOST_MAX_WINDOW, revision: input.revision } : null;
            if (!window || !isTextList(input.taskIds) || input.taskIds.length === 0 || !isPaging(window)) {
                return fail('INVALID_INPUT', 'Task IDs and a valid window are required');
            }
            const ids = Array.from(new Set(input.taskIds));
            const revision = `${deps.revision(new Date())}:${paramsKey(ids)}`;
            if (window.revision !== undefined && window.revision !== revision) return fail('STALE_REVISION', 'Sections changed; read them again');
            const taskById = new Map(useTaskStore.getState().tasks.map((task) => [task.id, task]));
            const dialog = buildSomedaySectionMoveDialog(ids.map((id) => taskById.get(id)), somedaySections(), deps.t());
            return {
                ok: true,
                value: {
                    ...dialog,
                    version: NATIVE_HOST_CONTRACT_VERSION,
                    revision,
                    choices: { total: dialog.choices.length, items: page(dialog.choices, window) },
                },
            };
        },

        /** Waiting and Someday's parked projects: swiping one makes it active. Target state; a retry writes nothing. */
        async activateProject(input: { projectId: string }): Promise<NativeHostResult<{ id: string; changed: boolean }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !isText(input.projectId) || !input.projectId) return fail('INVALID_INPUT', 'Project ID is required');
            const project = useTaskStore.getState()._projectsById.get(input.projectId);
            if (!project || project.deletedAt) return fail('INVALID_INPUT', 'Project is not available');
            if (project.status === 'active') return settle({ id: project.id, changed: false });
            if (project.status !== 'waiting' && project.status !== 'someday') return fail('INVALID_INPUT', 'Only a waiting or someday project can be activated');
            try {
                const result = await useTaskStore.getState().updateProject(project.id, { status: 'active' });
                if (!result.success) return writeFailure(result.error ?? 'Project activation failed');
            } catch (error) {
                return caught(error);
            }
            const saved = await deps.save();
            if (!saved.ok) return saved;
            return { ok: true, value: { id: project.id, changed: true } };
        },

        /**
         * Move Someday tasks to a section (null = No section), as the move dialog
         * does. Target state: tasks already in the section are not written, so any
         * retry is safe. Reusing `requestId` returns the first outcome; its Undo
         * lives in memory, like mobile's Undo toast.
         */
        async moveSomedayTasksToSection(input: { taskIds: string[]; sectionId: string | null; requestId: string }): Promise<NativeHostResult<NativeSomedayMoveResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !isTextList(input.taskIds) || input.taskIds.length === 0
                || (input.sectionId !== null && !isText(input.sectionId))
                || typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId)) {
                return fail('INVALID_INPUT', 'Task IDs, a section ID or null, and a request UUID are required');
            }
            const ids = Array.from(new Set(input.taskIds));
            const destination = input.sectionId ?? undefined;
            const requestId = input.requestId;
            return receipts.run<NativeSomedayMoveResult>(requestId, JSON.stringify(['move', ids, input.sectionId]), async () => {
                const t = deps.t();
                const text = getSomedaySectionMoveText(t);
                const refused: NativeHostResult<NativeSomedayMoveResult> = { ok: true, value: { refused: { title: text.errorTitle, message: text.moveFailed } } };
                const state = useTaskStore.getState();
                const section = destination ? sortViewSectionDefinitions(somedaySections()).find((entry) => entry.id === destination) : undefined;
                if (destination && !section) return refused;
                const { resolvedAreaFilter } = visibleContext();
                const tasks = getSomedaySectionMoveTasks({
                    tasks: state.tasks, projects: state.projects, areas: state.areas, ids, resolvedAreaFilter,
                });
                if (!tasks) return refused;
                // Target state: tasks already in the section are not written.
                const { updates, previous } = planSomedaySectionMove({ ids, tasks, destination });
                if (previous.length === 0) return { ok: true, value: { moved: 0, toast: null, undoRequestId: null } };
                const written = await runStoreWrite(() => state.batchUpdateTasks(updates));
                if (!written.ok && written.error.code !== 'SAVE_FAILED') return written;
                // Landed: Undo is offered even while the save is owed.
                rememberUndo(requestId, { previous, sectionId: input.sectionId });
                return settleWrite(written, {
                    moved: previous.length,
                    toast: { message: formatSomedaySectionMoved(t, previous.length, section?.title), undoLabel: text.undoLabel },
                    undoRequestId: requestId,
                });
            });
        },

        /**
         * Undo a recorded move (its `requestId`): tasks still Someday tasks in the
         * moved-to section go back; tasks moved or filed elsewhere since stay.
         * Reuse `requestId` to retry the Undo itself.
         */
        async undoSomedaySectionMove(input: { moveRequestId: string; requestId: string }): Promise<NativeHostResult<{ reverted: number }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || typeof input.moveRequestId !== 'string' || !deps.requestIdPattern.test(input.moveRequestId)
                || typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId) || input.requestId === input.moveRequestId) {
                return fail('INVALID_INPUT', 'The move\'s request ID and a new request UUID are required');
            }
            const undo = undoByMove.get(input.moveRequestId);
            if (!undo) return fail('STALE_REVISION', 'That move can no longer be undone');
            return receipts.run<{ reverted: number }>(input.requestId, JSON.stringify(['undo', input.moveRequestId]), async () => {
                const state = useTaskStore.getState();
                // Only tasks still in Someday: a task filed elsewhere since keeps its state.
                const latest = undo.previous
                    .map(({ id }) => state.tasks.find((task) => task.id === id))
                    .filter((task): task is Task => task?.status === 'someday');
                const updates = buildTaskViewSectionUndoUpdates(latest, 'someday', undo.previous, undo.sectionId ?? undefined);
                if (updates.length === 0) return { ok: true, value: { reverted: 0 } };
                return settleWrite(await runStoreWrite(() => state.batchUpdateTasks(updates)), { reverted: updates.length });
            });
        },

        /**
         * Add a Someday task to a section (null = No section). Reuse `captureId` to
         * retry without a duplicate; a captureId already used for another title or
         * section is refused.
         */
        async addSomedaySectionTask(input: { title: string; sectionId: string | null; captureId: string }): Promise<NativeHostResult<
            { id: string; toast: string } | NativeMenuViewRefusal
        >> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !isText(input.title, 10_000) || !input.title.trim()
                || (input.sectionId !== null && !isText(input.sectionId))
                || typeof input.captureId !== 'string' || !deps.requestIdPattern.test(input.captureId)) {
                return fail('INVALID_INPUT', 'A task title, a section ID or null, and a capture UUID are required');
            }
            const text = getSomedaySectionTaskText(deps.t(), '');
            const title = input.title.trim();
            return receipts.run<{ id: string; toast: string } | NativeMenuViewRefusal>(
                input.captureId,
                JSON.stringify(['add', title, input.sectionId]),
                async () => {
                    // After a restart the receipt is gone: the task the captureId created still
                    // answers a retry, and refuses a different payload.
                    const id = input.captureId.toLowerCase();
                    const existing = useTaskStore.getState()._allTasks.find((task) => task.id === id);
                    if (existing) {
                        if (existing.title !== title || (existing.viewSectionIds?.someday ?? null) !== input.sectionId) {
                            return fail('INVALID_INPUT', 'Capture ID already belongs to another task');
                        }
                        return { ok: true, value: { id, toast: text.created } };
                    }
                    const plan = planSomedaySectionTaskAdd({ title, sectionId: input.sectionId ?? undefined, stored: somedaySections() });
                    if (plan.kind !== 'add') return { ok: true, value: { refused: { title: null, message: text.failed } } };
                    let created = id;
                    const written = await runStoreWrite(async () => {
                        const result = await useTaskStore.getState().addTask(plan.title, plan.props, { captureId: input.captureId });
                        if (result.id) created = result.id;
                        return result.success && !result.id ? { success: false, error: 'Task creation failed' } : result;
                    });
                    return settleWrite(written, { id: created, toast: text.created });
                },
            );
        },

        /** New Someday section. A title that exists (any case) returns that section; a retry writes nothing again. */
        async createSomedaySection(input: { title: string }): Promise<NativeHostResult<{ id: string; existing: boolean }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !isText(input.title, 200) || !input.title.trim()) return fail('INVALID_INPUT', 'A section title is required');
            const plan = planSomedaySectionCreate(somedaySections(), input.title);
            if (plan.kind === 'blank') return fail('INVALID_INPUT', 'A section title is required');
            if (plan.kind === 'existing') return settle({ id: plan.id, existing: true });
            try {
                await updateSomedaySections(plan.sections);
            } catch (error) {
                return caught(error);
            }
            if (!sortViewSectionDefinitions(somedaySections()).some((section) => section.id === plan.id)) return writeFailure('Section creation failed');
            const saved = await deps.save();
            if (!saved.ok) return saved;
            return { ok: true, value: { id: plan.id, existing: false } };
        },

        /** Rename a section. Target state; the same title again writes nothing. */
        async renameSomedaySection(input: { id: string; title: string }): Promise<NativeHostResult<{ id: string; changed: boolean }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !isText(input.id) || !isText(input.title, 200)) return fail('INVALID_INPUT', 'Section ID and title are required');
            const stored = somedaySections();
            const current = sortViewSectionDefinitions(stored).find((section) => section.id === input.id);
            if (!current) return fail('INVALID_INPUT', 'Section is not available');
            const next = renameSomedaySection(stored, input.id, input.title);
            if (!next) return fail('INVALID_INPUT', 'A section title is required');
            if (current.title === input.title.trim()) return settle({ id: input.id, changed: false });
            try {
                await updateSomedaySections(next);
            } catch (error) {
                return caught(error);
            }
            const saved = await deps.save();
            if (!saved.ok) return saved;
            return { ok: true, value: { id: input.id, changed: true } };
        },

        /** Put the sections in this order (every section's id once), numbered from 0. Target state. */
        async reorderSomedaySections(input: { ids: string[] }): Promise<NativeHostResult<{ changed: boolean }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const sorted = sortViewSectionDefinitions(somedaySections());
            if (!isObjectRecord(input) || !isTextList(input.ids) || input.ids.length !== sorted.length
                || new Set(input.ids).size !== input.ids.length || !input.ids.every((id) => sorted.some((section) => section.id === id))) {
                return fail('INVALID_INPUT', 'Every section ID, once, is required');
            }
            if (sorted.every((section, index) => section.id === input.ids[index] && section.order === index)) return settle({ changed: false });
            const byId = new Map(sorted.map((section) => [section.id, section]));
            try {
                await updateSomedaySections(input.ids.map((id, order) => ({ ...byId.get(id)!, order })));
            } catch (error) {
                return caught(error);
            }
            const saved = await deps.save();
            if (!saved.ok) return saved;
            return { ok: true, value: { changed: true } };
        },

        /**
         * Delete a section after the row's `deleteConfirm`. Its tasks keep their
         * stored assignment and show under "No section", as on mobile. Target state.
         */
        async deleteSomedaySection(input: { id: string }): Promise<NativeHostResult<{ id: string; changed: boolean }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !isText(input.id) || !input.id) return fail('INVALID_INPUT', 'Section ID is required');
            const stored = somedaySections();
            if (!sortViewSectionDefinitions(stored).some((section) => section.id === input.id)) return settle({ id: input.id, changed: false });
            try {
                await updateSomedaySections(removeSomedaySection(stored, input.id));
            } catch (error) {
                return caught(error);
            }
            const saved = await deps.save();
            if (!saved.ok) return saved;
            return { ok: true, value: { id: input.id, changed: true } };
        },

        /** Reference's sort sheet: the stored task-list sort, shared with the other lists. Target state. */
        async setTaskListSort(input: { sortBy: TaskSortBy }): Promise<NativeHostResult<{ sortBy: TaskSortBy; changed: boolean }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !TASK_LIST_SORT_OPTIONS.includes(input.sortBy as TaskSortBy)) {
                return fail('INVALID_INPUT', 'A task-list sort is required');
            }
            const sortBy = input.sortBy as TaskSortBy;
            if (useTaskStore.getState().settings.taskSortBy === sortBy) return settle({ sortBy, changed: false });
            try {
                await useTaskStore.getState().updateSettings({ taskSortBy: sortBy });
            } catch (error) {
                return caught(error);
            }
            const saved = await deps.save();
            if (!saved.ok) return saved;
            return { ok: true, value: { sortBy, changed: true } };
        },
    };
}
