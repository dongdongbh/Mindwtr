/**
 * The native host contract for the widget list screen (route `/widget-list/<id>`, a Tasks widget's header for Next, Upcoming or a
 * saved filter), as React Native's app/(drawer)/widget-list/[id].tsx draws it from resolveWidgetListDestination: the list's
 * title, every task of the widget's own core projection (uncapped, already filtered and ordered, with no in-app area or filter
 * applied again), windowed by NATIVE_HOST_MAX_WINDOW, and RN's empty line. A route ID that is not a list, or a saved filter that
 * is gone, shows the empty line under RN's "No results" title. A row's swipes, taps and editor are the task lists' own commands.
 *
 * Only functions read this module's imports from native-host-contract.ts, so the import cycle between the two files is safe.
 */
import type { Language } from './i18n/i18n-types';
import {
    NATIVE_HOST_CONTRACT_VERSION,
    NATIVE_HOST_MAX_WINDOW,
    type NativeHostResult,
    type NativeTaskRow,
} from './native-host-contract';
import { fail, isObjectRecord, isPaging, isText, page, paramsKey } from './native-host-contract-menu-views';
import { useTaskStore } from './store';
import type { Task } from './types';
import { resolveWidgetListDestination } from './widget-list-destination';

export type NativeWidgetListView = {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    /** Covers the data, settings, language, the minute and the route ID. */
    revision: string;
    id: string;
    /** False when the ID names no list: not a list ID, or a saved filter that is gone. */
    found: boolean;
    /** The screen's header title: the list's, else RN's "No results". */
    title: string;
    /** Every task of the list; `rows` is the requested window. */
    total: number;
    rows: NativeTaskRow[];
    /** RN's empty line, only when the list has no task. */
    empty: { message: string } | null;
};

type WidgetListDeps = {
    readiness: () => NativeHostResult<null>;
    t: () => (key: string) => string;
    language: () => Language;
    /** Data plus display revision: tasks, projects, settings, language and the minute. */
    revision: (now: Date) => string;
    /** Rows with core meta, as the other contract lists build them. */
    rows: (tasks: readonly Task[], now: Date) => NativeTaskRow[];
};

export function createWidgetListMethods(deps: WidgetListDeps) {
    return {
        /** The widget list screen for `next`, `upcoming`, `filter:<id>`, `project:<id>`, `context:<token>` or `tag:<token>`. */
        getWidgetListView(input: { id: string; offset?: number; limit?: number; revision?: string }): NativeHostResult<NativeWidgetListView> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const window = isObjectRecord(input)
                ? { offset: input.offset ?? 0, limit: input.limit ?? NATIVE_HOST_MAX_WINDOW, revision: input.revision }
                : null;
            if (!isObjectRecord(input) || !isText(input.id, 2048) || !window || !isPaging(window)) {
                return fail('INVALID_INPUT', 'A widget list ID and a window of at most 100 rows are required');
            }
            const now = new Date();
            const revision = `${deps.revision(now)}:${paramsKey(input.id)}`;
            if (window.revision !== undefined && window.revision !== revision) {
                return fail('STALE_REVISION', 'The widget list changed; read it again from offset zero');
            }
            const state = useTaskStore.getState();
            // RN's screen: the widget publication's canonical pools, so parent tombstones still hide their children.
            const list = resolveWidgetListDestination({
                tasks: state._allTasks?.length ? state._allTasks : state.tasks,
                projects: state._allProjects?.length ? state._allProjects : state.projects,
                sections: state._allSections?.length ? state._allSections : state.sections,
                areas: state._allAreas?.length ? state._allAreas : state.areas,
                settings: state.settings,
            }, deps.language(), input.id);
            const t = deps.t();
            const tasks = list?.tasks ?? [];
            return {
                ok: true,
                value: {
                    version: NATIVE_HOST_CONTRACT_VERSION,
                    revision,
                    id: input.id,
                    found: Boolean(list),
                    title: list?.title ?? t('search.noResults'),
                    total: tasks.length,
                    rows: deps.rows(page(tasks, window), now),
                    empty: tasks.length === 0 ? { message: t('search.noResults') } : null,
                },
            };
        },
    };
}
