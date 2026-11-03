


import { resolveAreaFilterSelection } from './area-filter';
import {
    NATIVE_HOST_CONTRACT_VERSION,
    NATIVE_HOST_MAX_WINDOW,
    sortAreasForDisplay,
    type NativeHostResult,
    type NativeTaskRow,
} from './native-host-contract';
import { fail, isObjectRecord, isPaging, isText, page, paramsKey } from './native-host-contract-menu-views';
import { createNativeRequestReceipts, runStoreWrite, settleWrite } from './native-request-receipts';
import { getTaskListHeaderText } from './menu-views-model';
import {
    buildSavedSearchScreenText,
    deleteSavedSearchById,
    findSavedSearch,
    getSavedSearchGlobalSortLabel,
    getSavedSearchOwnSortBy,
    resolveSavedSearchSortBy,
    selectSavedSearchTasks,
    setSavedSearchSortById,
    type SavedSearchScreenText,
} from './saved-search-view-model';
import { useTaskStore } from './store';
import { getTaskSortByLabel, getVisibleTaskSortOptions, TASK_LIST_SORT_OPTIONS } from './task-list-sort-options';
import type { Task, TaskSortBy } from './types';

export type NativeSavedSearchView = {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;

    revision: string;
    id: string;

    found: boolean;
    title: string;

    query: string | null;
    delete: SavedSearchScreenText['deleteAction'];


    sort: {
        title: string;
        accessibilityLabel: string;
        options: { label: string; selected: boolean; edit: { sortBy: TaskSortBy | null } }[];
    } | null;

    total: number;
    rows: NativeTaskRow[];

    empty: SavedSearchScreenText['empty'] | null;
};

type SavedSearchDeps = {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    t: () => (key: string) => string;

    revision: (now: Date) => string;

    rows: (tasks: readonly Task[], now: Date) => NativeTaskRow[];
};

export function createSavedSearchMethods(deps: SavedSearchDeps) {
    const receipts = createNativeRequestReceipts({
        save: async () => {
            if (useTaskStore.getState().persistenceFailure) {
                try {
                    await useTaskStore.getState().retryPersistence();
                } catch (error) {
                    return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error));
                }
            }
            return deps.save();
        },
    });

    return {

        getSavedSearchView(input: { id: string; offset?: number; limit?: number; revision?: string }): NativeHostResult<NativeSavedSearchView> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const window = isObjectRecord(input)
                ? { offset: input.offset ?? 0, limit: input.limit ?? NATIVE_HOST_MAX_WINDOW, revision: input.revision }
                : null;
            if (!isObjectRecord(input) || !isText(input.id, 200) || !window || !isPaging(window)) {
                return fail('INVALID_INPUT', 'A saved search ID and a window of at most 100 rows are required');
            }
            const now = new Date();
            const revision = `${deps.revision(now)}:${paramsKey(input.id)}`;
            if (window.revision !== undefined && window.revision !== revision) {
                return fail('STALE_REVISION', 'The saved search changed; read it again from offset zero');
            }
            const state = useTaskStore.getState();
            const { savedSearches } = state.settings;
            const savedSearch = findSavedSearch(savedSearches, input.id);

            const areas = sortAreasForDisplay(state.areas);
            const tasks = selectSavedSearchTasks({
                query: savedSearch?.query || '',
                tasks: state.tasks,
                projects: state.projects,
                areaFilter: resolveAreaFilterSelection(state.settings.filters, areas),
                areaById: new Map(areas.map((area) => [area.id, area])),
                sortBy: resolveSavedSearchSortBy(savedSearch, state.settings),
            });
            const t = deps.t();
            const text = buildSavedSearchScreenText({ savedSearch, savedSearches, t });
            const ownSortBy = getSavedSearchOwnSortBy(savedSearch, state.settings);
            return {
                ok: true,
                value: {
                    version: NATIVE_HOST_CONTRACT_VERSION,
                    revision,
                    id: input.id,
                    found: Boolean(savedSearch),
                    title: text.title,
                    query: text.query || null,
                    delete: text.deleteAction,
                    sort: savedSearch ? {
                        title: t('sort.label'),
                        accessibilityLabel: getTaskListHeaderText({
                            sortByLabel: getTaskSortByLabel(resolveSavedSearchSortBy(savedSearch, state.settings), t),
                            hasActiveFilters: false, filterActiveCount: 0, t,
                        }).sortAccessibilityLabel,
                        options: [
                            { label: getSavedSearchGlobalSortLabel(state.settings, t), selected: ownSortBy === null, edit: { sortBy: null } },
                            ...getVisibleTaskSortOptions(TASK_LIST_SORT_OPTIONS, state.settings).map((sortBy) => ({
                                label: getTaskSortByLabel(sortBy, t), selected: ownSortBy === sortBy, edit: { sortBy },
                            })),
                        ],
                    } : null,
                    total: tasks.length,
                    rows: deps.rows(page(tasks, window), now),
                    empty: tasks.length === 0 ? text.empty : null,
                },
            };
        },


        async deleteSavedSearch(input: { requestId: string; id: string }): Promise<NativeHostResult<{ changed: boolean }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !isText(input.id, 200) || !input.id) {
                return fail('INVALID_INPUT', 'A request UUID and a saved search ID are required');
            }
            const { id } = input;
            return receipts.run<{ changed: boolean }>(input.requestId, JSON.stringify(['deleteSavedSearch', id]), async () => {

                const deleted = { found: false };
                const written = await runStoreWrite(async () => { deleted.found = await deleteSavedSearchById(id); });

                if (!deleted.found) return written.ok ? { ok: true, value: { changed: false } } : written;
                return settleWrite(written, { changed: true });
            });
        },


        async setSavedSearchSort(input: { requestId: string; id: string; sortBy: TaskSortBy | null }): Promise<NativeHostResult<{ changed: boolean }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !isText(input.id, 200) || !input.id
                || (input.sortBy !== null && !TASK_LIST_SORT_OPTIONS.includes(input.sortBy as TaskSortBy))) {
                return fail('INVALID_INPUT', 'A request UUID, a saved search ID and a list sort (or null) are required');
            }
            const { id, sortBy } = input;
            return receipts.run<{ changed: boolean }>(input.requestId, JSON.stringify(['setSavedSearchSort', id, sortBy]), async () => {
                const set = { changed: false };
                const written = await runStoreWrite(async () => { set.changed = await setSavedSearchSortById(id, sortBy); });
                if (!set.changed) return written.ok ? { ok: true, value: { changed: false } } : written;
                return settleWrite(written, { changed: true });
            });
        },
    };
}
