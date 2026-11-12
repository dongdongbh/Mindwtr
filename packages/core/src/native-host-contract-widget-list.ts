


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
import { normalizeSavedFilters } from './saved-filters';
import { normalizeWidgetListDestinationId, resolveWidgetListDestination } from './widget-list-destination';

export type NativeWidgetListView = {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;

    revision: string;
    id: string;

    found: boolean;

    contextsFilterId: string | null;

    title: string;

    total: number;
    rows: NativeTaskRow[];

    empty: { message: string } | null;


    validUntil: number;
};

type WidgetListDeps = {
    readiness: () => NativeHostResult<null>;
    t: () => (key: string) => string;
    language: () => Language;

    revision: (now: Date) => string;

    rows: (tasks: readonly Task[], now: Date) => NativeTaskRow[];
};

export function createWidgetListMethods(deps: WidgetListDeps) {
    return {

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

            const list = resolveWidgetListDestination({
                tasks: state._allTasks?.length ? state._allTasks : state.tasks,
                projects: state._allProjects?.length ? state._allProjects : state.projects,
                sections: state._allSections?.length ? state._allSections : state.sections,
                areas: state._allAreas?.length ? state._allAreas : state.areas,
                settings: state.settings,
            }, deps.language(), input.id);
            const destination = normalizeWidgetListDestinationId(input.id);
            const savedFilterId = destination?.startsWith('filter:') && destination.length - 'filter:'.length <= 200 ? destination.slice('filter:'.length) : null;
            const contextsFilter = savedFilterId === null ? undefined : normalizeSavedFilters(state.settings.savedFilters)
                .find((filter) => filter.id === savedFilterId && filter.view === 'contexts' && !filter.deletedAt);
            const t = deps.t();
            const tasks = list?.tasks ?? [];
            const rows = deps.rows(page(tasks, window), now);
            const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
            return {
                ok: true,
                value: {
                    version: NATIVE_HOST_CONTRACT_VERSION,
                    revision,
                    id: input.id,
                    found: Boolean(list),
                    contextsFilterId: contextsFilter?.id ?? null,
                    title: list?.title ?? t('search.noResults'),
                    total: tasks.length,
                    rows,
                    empty: tasks.length === 0 ? { message: t('search.noResults') } : null,
                    validUntil: Math.min(midnight, ...rows.map((row) => row.meta?.validUntil ?? midnight)),
                },
            };
        },
    };
}
