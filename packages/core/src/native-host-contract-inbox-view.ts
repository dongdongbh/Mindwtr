/**
 * The native host contract for the React Native Inbox tab: its list, toolbar,
 * filters and chips (core's status-list model, kind 'inbox', as mobile's TaskList
 * builds it) and the screen's own parts (buildInboxScreenModel): Process Inbox,
 * the Mind Sweep entry, the "All areas" line and the empty state's capture action.
 * Kept in its own file and spread into createNativeHostContract.
 *
 * View state, kept where mobile keeps it:
 * - Sort: the synced setting `settings.taskSortBy`, shared by every task list.
 *   Change it with setTaskListSort (native-host-contract-menu-views.ts); the view
 *   reads it back.
 * - Group: screen state, 'none' each time the Inbox opens. Send it as `groupBy`.
 * - Filters: screen state, empty each time the Inbox opens. Send the returned
 *   `filters.state` back as `filters`, with a control's `filterEdit`.
 * - Folded group headings: device-local and never synced. Mobile stores them
 *   under the key `mindwtr:view:group-collapse:inbox:v1` as JSON
 *   `{"<groupBy>": ["<group id>", ...]}`, one list per grouping, and writes the
 *   whole object after each tap. Send the current grouping's list as
 *   `collapsedGroupIds`; a heading's `collapseEdit` is that list after a tap.
 *
 * The rows are windowed by NATIVE_HOST_MAX_WINDOW with `offset`/`limit`; the
 * filter sheet's tokens carry their first window, and getInboxFilterTokens pages
 * the rest under the same revision; its optional `query` is the picker's search box.
 *
 * Only functions read this module's imports from native-host-contract.ts, so the
 * import cycle between the two files is safe.
 */
import { resolveAreaFilterSelection } from './area-filter';
import { applyListFilterEdit, resolveListFilterState, type ListFilterEdit, type ListFilterState } from './list-filter-state';
import {
    buildInboxScreenModel,
    buildStatusListFilterOptions,
    buildStatusListFilterSummary,
    buildStatusListModel,
    getTaskListHeaderText,
    isStatusListTaskReadOnly,
    selectStatusListTasks,
    TASK_LIST_GROUP_OPTIONS,
} from './menu-views-model';
import {
    fail,
    isFilterEdit,
    isObjectRecord,
    isPaging,
    isText,
    isTextList,
    matchesPickerQuery,
    nativeFilterView,
    page,
    paramsKey,
    readFilterState,
    tokenOptions,
    type NativeListFilterView,
    type NativeWindow,
    type PageInput,
    type TokenOption,
} from './native-host-contract-menu-views';
import {
    NATIVE_HOST_CONTRACT_VERSION,
    sortAreasForDisplay,
    type NativeHostResult,
    type NativeTaskRow,
} from './native-host-contract';
import { useTaskStore } from './store';
import type { TaskGroupBy } from './task-group-sections';
import type { Task, TaskSortBy } from './types';

export type InboxViewDeps = {
    readiness: () => NativeHostResult<null>;
    /** Data plus display revision: tasks, projects, settings, language and the minute. */
    revision: (now: Date) => string;
    t: () => (key: string) => string;
    /** Rows with core meta, as mobile's Inbox shows them (no checklist progress). */
    rows: (tasks: readonly Task[], now: Date) => NativeTaskRow[];
};

export type NativeInboxItem =
    | {
        type: 'section';
        id: string;
        title: string;
        count: number;
        muted: boolean;
        collapsible: boolean;
        collapsed: boolean;
        /** Send as `collapsedGroupIds` (and store it for this grouping) to fold or unfold this heading. */
        collapseEdit: { collapsedGroupIds: string[] };
    }
    /** readOnly: the task's project was archived or deleted; mobile opens it for viewing only. */
    | { type: 'task'; row: NativeTaskRow & { readOnly: boolean }; groupId: string | null };

export type NativeInboxChip = {
    id: string;
    label: string;
    excluded: boolean;
    accessibilityLabel: string;
    /** Tapping the chip removes its filter: send this as `filterEdit`. */
    action: { filterEdit: ListFilterEdit };
};

export type NativeInboxView = {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    /** Changes with the data, settings, language, minute and the view's inputs. */
    revision: string;
    /** Items (headings and rows) in the whole list. */
    total: number;
    title: string;
    items: NativeInboxItem[];
    /** Tasks shown after the filters. */
    count: number;
    groupBy: TaskGroupBy;
    sortBy: TaskSortBy;
    collapsedGroupIds: string[];
    /** The three compact controls beside the Mind Sweep pill, in this order. */
    toolbar: {
        /** Choosing an option sends its `edit` to setTaskListSort. */
        sort: {
            accessibilityLabel: string;
            title: string;
            label: string;
            options: { value: TaskSortBy; label: string; selected: boolean; edit: { sortBy: TaskSortBy } }[];
        };
        /** Choosing an option sends its `edit` with the next read. */
        group: {
            accessibilityLabel: string;
            title: string;
            label: string;
            options: { value: TaskGroupBy; label: string; selected: boolean; edit: { groupBy: TaskGroupBy } }[];
        };
        /** Opens the filter sheet; `countLabel` shows inside the control while filters are on. */
        filters: { accessibilityLabel: string; selected: boolean; countLabel: string | null };
    };
    filters: NativeListFilterView;
    /** The active filters under the controls, then a Clear chip (`clearLabel`) that sends `filters.clearEdit`. */
    chips: NativeInboxChip[];
    clearLabel: string;
    filterActiveCount: number;
    hasActiveFilters: boolean;
    /**
     * Shown when there are no items. With filters on, its action clears them;
     * otherwise it opens quick capture, recording at once when `autoRecord` is set.
     */
    empty: {
        message: string;
        hint: string;
        actionLabel: string | null;
        action: { filterEdit: ListFilterEdit } | { capture: { autoRecord: boolean } };
    };
    /** "All areas": the Inbox ignores the area selection. Shown above the rows. */
    scopeLabel: string;
    /** Process Inbox, below the controls; null while the Inbox is empty. Its count ignores filters. */
    process: { label: string; accessibilityLabel: string; count: number } | null;
    /** A pill beside the controls while the Inbox has tasks ('accessory'); in the Process slot when it is empty ('primary'). */
    mindSweep: { label: string; accessibilityLabel: string; placement: 'accessory' | 'primary' };
};

type InboxViewInput = {
    groupBy?: TaskGroupBy;
    filters?: Partial<ListFilterState>;
    filterEdit?: ListFilterEdit;
    collapsedGroupIds?: string[];
};

const toggled = (ids: readonly string[], id: string) => (ids.includes(id) ? ids.filter((entry) => entry !== id) : [...ids, id]);

export function createInboxViewMethods(deps: InboxViewDeps) {
    const readParams = (input: Record<string, unknown>) => {
        const filters = readFilterState(input.filters);
        if (!filters
            || (input.groupBy !== undefined && !(TASK_LIST_GROUP_OPTIONS as readonly string[]).includes(input.groupBy as string))
            || (input.collapsedGroupIds !== undefined && !isTextList(input.collapsedGroupIds, 200))
            || (input.filterEdit !== undefined && !isFilterEdit(input.filterEdit))) {
            return null;
        }
        const edit = input.filterEdit as ListFilterEdit | undefined;
        return {
            groupBy: (input.groupBy as TaskGroupBy | undefined) ?? 'none',
            collapsedGroupIds: (input.collapsedGroupIds as string[] | undefined) ?? [],
            filters: edit ? applyListFilterEdit(filters, edit) : filters,
        };
    };

    // ponytail: one cached build, keyed by the revision and the inputs; paging rebuilds nothing.
    let cache: { key: string; value: ReturnType<typeof compute> } | null = null;
    const compute = (params: NonNullable<ReturnType<typeof readParams>>, now: Date) => {
        const t = deps.t();
        const state = useTaskStore.getState();
        const areas = sortAreasForDisplay(state.areas);
        // The Inbox ignores the area selection; the selector takes it for the other lists.
        const tasks = selectStatusListTasks({
            kind: 'inbox', tasks: state.tasks, projects: state.projects, allProjects: state._allProjects,
            resolvedAreaFilter: resolveAreaFilterSelection(state.settings.filters, areas),
            areaById: new Map(areas.map((area) => [area.id, area])),
        });
        const options = buildStatusListFilterOptions({ kind: 'inbox', tasks, allProjects: state._allProjects, settings: state.settings, t });
        const resolved = resolveListFilterState(params.filters, { visibility: options.visibility, t });
        const model = buildStatusListModel({
            kind: 'inbox', tasks, projects: state.projects, areas: state.areas, settings: state.settings,
            groupBy: params.groupBy, criteria: resolved.criteria, searchQuery: resolved.searchQuery,
            collapsedGroupIds: new Set(params.collapsedGroupIds), t, now,
        });
        const summary = buildStatusListFilterSummary({
            kind: 'inbox', chips: resolved.chips, activeCount: resolved.activeCount, hasActive: resolved.hasActive,
            includeArchivedProjects: false, settings: state.settings, t,
        });
        const allProjects = state._allProjects;
        return {
            model, resolved, options, summary,
            screen: buildInboxScreenModel({ count: tasks.length, settings: state.settings, t }),
            header: getTaskListHeaderText({
                sortByLabel: model.sortByLabel, groupByLabel: model.groupByLabel,
                hasActiveFilters: summary.hasActive, filterActiveCount: summary.activeCount, t,
            }),
            tokens: tokenOptions(options, resolved.state),
            readOnly: (task: Task) => isStatusListTaskReadOnly(task, allProjects),
        };
    };
    const build = (params: NonNullable<ReturnType<typeof readParams>>) => {
        const now = new Date();
        const base = deps.revision(now);
        const key = `${base}:${paramsKey(params)}`;
        if (cache?.key !== key) cache = { key, value: compute(params, now) };
        const data = cache.value;
        return {
            revision: `${base}:${paramsKey(['inbox', params.groupBy, params.collapsedGroupIds, data.resolved.state])}`,
            now,
            data,
        };
    };

    return {
        /**
         * The Inbox tab. `groupBy` and the filters are the screen's session choices
         * (defaults: none, no filters); `collapsedGroupIds` are the device's folds
         * for this grouping. Pages its items by `offset`/`limit` under one revision.
         */
        getInboxView(input: InboxViewInput & PageInput): NativeHostResult<NativeInboxView> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const params = isObjectRecord(input) ? readParams(input) : null;
            if (!params || !isPaging(input)) {
                return fail('INVALID_INPUT', 'A valid offset, bounded limit, revision for later pages, and the Inbox\'s grouping, folds and filters are required');
            }
            const built = build(params);
            if (input.revision !== undefined && input.revision !== built.revision) {
                return fail('STALE_REVISION', 'Inbox changed; restart paging from offset zero');
            }
            const t = deps.t();
            const { model, resolved, options, summary, screen, header } = built.data;
            const windowItems = page(model.items, input);
            const rows = deps.rows(windowItems.flatMap((item) => (item.type === 'task' ? [item.task] : [])), built.now);
            let rowIndex = 0;
            return {
                ok: true,
                value: {
                    version: NATIVE_HOST_CONTRACT_VERSION,
                    revision: built.revision,
                    total: model.items.length,
                    title: screen.title,
                    items: windowItems.map((item): NativeInboxItem => (item.type === 'section'
                        ? { ...item, collapseEdit: { collapsedGroupIds: toggled(params.collapsedGroupIds, item.id) } }
                        : { type: 'task', row: { ...rows[rowIndex++], readOnly: built.data.readOnly(item.task) }, groupId: item.groupId })),
                    count: model.orderedTasks.length,
                    groupBy: params.groupBy,
                    sortBy: model.sortBy,
                    collapsedGroupIds: params.collapsedGroupIds,
                    toolbar: {
                        sort: {
                            accessibilityLabel: header.sortAccessibilityLabel,
                            title: model.sortTitle,
                            label: model.sortByLabel,
                            options: model.sortOptions.map((option) => ({ ...option, edit: { sortBy: option.value } })),
                        },
                        group: {
                            accessibilityLabel: header.groupAccessibilityLabel,
                            title: model.groupTitle,
                            label: model.groupByLabel,
                            options: model.groupOptions.map((option) => ({ ...option, edit: { groupBy: option.value } })),
                        },
                        filters: {
                            accessibilityLabel: header.filtersAccessibilityLabel,
                            selected: summary.hasActive,
                            countLabel: summary.hasActive ? String(summary.activeCount) : null,
                        },
                    },
                    filters: nativeFilterView(resolved, options, built.data.tokens, null, t),
                    chips: resolved.chips.map((chip) => ({
                        id: chip.id,
                        label: chip.label,
                        excluded: chip.excluded,
                        accessibilityLabel: header.chipAccessibilityLabel(chip),
                        action: { filterEdit: chip.edit },
                    })),
                    clearLabel: header.clear,
                    filterActiveCount: summary.activeCount,
                    hasActiveFilters: summary.hasActive,
                    empty: {
                        ...summary.empty,
                        action: resolved.hasActive ? { filterEdit: { type: 'clear' as const } } : { capture: { autoRecord: screen.autoRecord } },
                    },
                    scopeLabel: screen.scopeLabel,
                    process: screen.process,
                    mindSweep: { ...screen.mindSweep, accessibilityLabel: screen.mindSweep.label },
                },
            };
        },

        /** A later window of the filter sheet's tokens. `params` are the view's inputs as last sent (with the returned `filters.state`, no `filterEdit`). */
        getInboxFilterTokens(input: { params?: InboxViewInput; offset: number; limit: number; revision: string; query?: string }): NativeHostResult<{
            version: typeof NATIVE_HOST_CONTRACT_VERSION;
            revision: string;
        } & NativeWindow<TokenOption>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const raw = isObjectRecord(input) && input.params !== undefined ? input.params : {};
            const params = isObjectRecord(raw) && raw.filterEdit === undefined ? readParams(raw) : null;
            if (!params || !isObjectRecord(input) || typeof input.revision !== 'string' || !isPaging(input)
                || (input.query !== undefined && !isText(input.query))) {
                return fail('INVALID_INPUT', 'The view\'s params, a valid window, its revision and an optional picker query are required');
            }
            const built = build(params);
            if (built.revision !== input.revision) return fail('STALE_REVISION', 'Inbox changed; read it again');
            const query = input.query;
            const tokens = query === undefined ? built.data.tokens : built.data.tokens.filter((token) => matchesPickerQuery(token.value, query));
            return {
                ok: true,
                value: {
                    version: NATIVE_HOST_CONTRACT_VERSION,
                    revision: built.revision,
                    total: tokens.length,
                    items: page(tokens, input),
                },
            };
        },
    };
}
