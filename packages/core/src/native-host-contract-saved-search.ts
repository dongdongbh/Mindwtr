/**
 * The native host contract for a saved search's screen (the More sheet's saved
 * searches, route `/saved-search/<id>`), from core's saved-search-view-model.ts.
 * Kept in its own file and spread into createNativeHostContract.
 *
 * - getSavedSearchView reads the screen for a saved search's ID: its header, its
 *   rows (windowed by NATIVE_HOST_MAX_WINDOW; a later window sends the first one's
 *   `revision`), and its empty state. A row's swipes, taps and editor are the task
 *   lists' own commands.
 * - Delete asks first with `delete.confirm`, then deleteSavedSearch. Afterwards,
 *   and for the empty state's Back, mobile goes back, or to the Inbox when there is
 *   nothing to go back to; the empty state's Inbox replaces the screen with the Inbox.
 *
 * deleteSavedSearch takes a request UUID and retries exactly
 * (native-request-receipts.ts). It deletes by ID against the settings as they are
 * when it runs (deleteSavedSearchById), and it is target-state: a saved search
 * already gone writes nothing.
 *
 * Only functions read this module's imports from native-host-contract.ts, so the
 * import cycle between the two files is safe.
 */
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
import {
    buildSavedSearchScreenText,
    deleteSavedSearchById,
    findSavedSearch,
    resolveSavedSearchSortBy,
    selectSavedSearchTasks,
    type SavedSearchScreenText,
} from './saved-search-view-model';
import { useTaskStore } from './store';
import type { Task } from './types';

export type NativeSavedSearchView = {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    /** Covers the tasks, projects, areas, settings (the saved searches, the area filter, the sort), the language and the minute. */
    revision: string;
    id: string;
    /** False when no saved search has this ID: it was deleted, or never saved. */
    found: boolean;
    title: string;
    /** The query under the title; null when there is none to show. */
    query: string | null;
    delete: SavedSearchScreenText['deleteAction'];
    /** Every row the query finds; `rows` is the requested window. */
    total: number;
    rows: NativeTaskRow[];
    /** Only when nothing is found: the line to show, and Inbox and Back when the saved search is gone. */
    empty: SavedSearchScreenText['empty'] | null;
};

type SavedSearchDeps = {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    t: () => (key: string) => string;
    /** Data plus display revision: tasks, projects, settings, language and the minute. */
    revision: (now: Date) => string;
    /** Rows with core meta, as the other contract lists build them. */
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
        /** A saved search's screen, as mobile shows it for `/saved-search/<id>`. */
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
            // Mobile's area filter (useMobileAreaFilter): the areas in display order.
            const areas = sortAreasForDisplay(state.areas);
            const tasks = selectSavedSearchTasks({
                query: savedSearch?.query || '',
                tasks: state.tasks,
                projects: state.projects,
                areaFilter: resolveAreaFilterSelection(state.settings.filters, areas),
                areaById: new Map(areas.map((area) => [area.id, area])),
                sortBy: resolveSavedSearchSortBy(savedSearch, state.settings),
            });
            const text = buildSavedSearchScreenText({ savedSearch, savedSearches, t: deps.t() });
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
                    total: tasks.length,
                    rows: deps.rows(page(tasks, window), now),
                    empty: tasks.length === 0 ? text.empty : null,
                },
            };
        },

        /** Delete a saved search, as the screen's confirmed Delete does. Reuse `requestId` to retry. */
        async deleteSavedSearch(input: { requestId: string; id: string }): Promise<NativeHostResult<{ changed: boolean }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !isText(input.id, 200) || !input.id) {
                return fail('INVALID_INPUT', 'A request UUID and a saved search ID are required');
            }
            const { id } = input;
            return receipts.run<{ changed: boolean }>(input.requestId, JSON.stringify(['deleteSavedSearch', id]), async () => {
                // By ID, against the settings as they are when the write runs.
                const deleted = { found: false };
                const written = await runStoreWrite(async () => { deleted.found = await deleteSavedSearchById(id); });
                // Target state: a saved search already gone is deleted.
                if (!deleted.found) return written.ok ? { ok: true, value: { changed: false } } : written;
                return settleWrite(written, { changed: true });
            });
        },
    };
}
