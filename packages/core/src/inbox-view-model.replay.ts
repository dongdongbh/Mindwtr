


import { readFileSync } from 'node:fs';
import { resolveAreaFilterSelection } from './area-filter';
import { applyListFilterEdit, EMPTY_LIST_FILTER_STATE, resolveListFilterState, type ListFilterEdit, type ListFilterState } from './list-filter-state';
import {
    buildInboxScreenModel,
    buildStatusListFilterOptions,
    buildStatusListFilterSummary,
    buildStatusListModel,
    getTaskListHeaderText,
    isStatusListTaskReadOnly,
    selectStatusListTasks,
} from './menu-views-model';
import type { createNativeHostContract } from './native-host-contract';
import { sortAreasForDisplay } from './native-host-contract';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { TaskGroupBy } from './task-group-sections';
import type { AppSettings, Area, Project, Task, TaskSortBy } from './types';

export type InboxViewAction = [string, ...unknown[]];
export type InboxViewScenario = { name: string; settings: string; omit?: string[]; extra?: number; actions: InboxViewAction[] };
type Observation = Record<string, unknown>;
export type InboxViewFixture = {
    provenance: Record<string, unknown>;
    timeZone: string;
    now: string;
    tasks: Task[];
    extraTasks: Task[];
    projects: Project[];
    areas: Area[];
    settings: Record<string, AppSettings>;
    scenarios: InboxViewScenario[];
    observations: Record<string, Observation[]>;
};
type Translate = (key: string) => string;
type Contract = ReturnType<typeof createNativeHostContract>;


export const INBOX_GROUP_COLLAPSE_STORAGE_KEY = 'mindwtr:view:group-collapse:inbox:v1';

export const loadInboxViewFixture = (): InboxViewFixture => JSON.parse(
    readFileSync(new URL('./inbox-view-parity.fixtures.json', import.meta.url), 'utf8'),
);

const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (
    entry === undefined ? '<undefined>' : entry
)));

let realUpdateSettings: ReturnType<typeof useTaskStore.getState>['updateSettings'] | null = null;


export async function seedInboxStore(
    fixture: InboxViewFixture,
    scenario: Pick<InboxViewScenario, 'settings' | 'omit' | 'extra'>,
    writes: unknown[],
    adapter: { saveData?: (data: unknown) => Promise<void> } = {},
): Promise<void> {
    await flushPendingSave();
    resetForTests();
    realUpdateSettings ??= useTaskStore.getState().updateSettings;
    const real = realUpdateSettings;
    const omit = scenario.omit ?? [];
    let data = JSON.parse(JSON.stringify({
        tasks: [...fixture.tasks.filter((task) => !omit.includes(task.id)), ...fixture.extraTasks.slice(0, scenario.extra ?? 0)],
        projects: fixture.projects,
        sections: [],
        areas: fixture.areas,
        people: [],
        settings: fixture.settings[scenario.settings],
    }));
    setStorageAdapter({
        getData: async () => data,
        saveData: async (next) => {
            await adapter.saveData?.(next);
            data = JSON.parse(JSON.stringify(next));
        },
    });
    useTaskStore.setState({
        updateSettings: real,
        _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
    });
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    useTaskStore.setState({
        updateSettings: async (updates) => { writes.push(['updateSettings', normalize(updates)]); return real(updates); },
    });
}

const ok = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};

type Chip = { id: string; label: string; excluded: boolean; accessibilityLabel: string };

type Parts = {
    items: unknown[][];
    count: number;
    title: string;
    sortByLabel: string;
    groupByLabel: string;
    filterActiveCount: number;
    hasActiveFilters: boolean;
    chips: Chip[];
    clearLabel: string;
    controls: { sort: string; group: string; filters: { accessibilityLabel: string; countLabel: string | null; selected: boolean } };
    mindSweep: { label: string; accessibilityLabel: string; placement: 'accessory' | 'primary' };
    process: { label: string; accessibilityLabel: string } | null;
    scopeLabel: string;
    empty: { message: string; hint: string; actionLabel: string | null };
    filterSheet: Observation;
    sort: unknown[][];
    group: unknown[][];
};


const layout = (parts: Parts, first: boolean, extra: Observation): Observation => ({
    items: parts.items,
    header: {
        count: parts.count,
        title: parts.title,
        showHeader: false,
        directControls: true,
        sortByLabel: parts.sortByLabel,
        groupByLabel: parts.groupByLabel,
        filterActiveCount: parts.filterActiveCount,
        hasActiveFilters: parts.hasActiveFilters,
        chips: parts.chips.map((chip) => [chip.id, chip.label, chip.excluded]),
        buttons: [
            [parts.controls.sort, '', null],
            [parts.controls.group, '', null],
            [parts.controls.filters.accessibilityLabel, parts.controls.filters.countLabel ?? '', parts.controls.filters.selected],
            ...(parts.mindSweep.placement === 'accessory' ? [[parts.mindSweep.accessibilityLabel, parts.mindSweep.label, null]] : []),
            ...parts.chips.map((chip) => [chip.accessibilityLabel, chip.label, null]),
            ...(parts.chips.length > 0 ? [[parts.clearLabel, parts.clearLabel, null]] : []),
        ],
    },
    primary: [parts.process
        ? [parts.process.accessibilityLabel, parts.process.label, null]
        : [parts.mindSweep.accessibilityLabel, parts.mindSweep.label, null]],
    scope: [parts.scopeLabel],
    empty: parts.empty,
    filterSheet: parts.filterSheet,
    ...extra,
    ...(first ? { sort: parts.sort, group: parts.group } : {}),
});

type Session = { groupBy: TaskGroupBy; filters: ListFilterState; collapsed: Record<string, string[]> };


export async function replayInboxScenario(options: {
    scenario: InboxViewScenario;
    writes: unknown[];
    t: Translate;
    contract?: Contract;
}): Promise<Observation[]> {
    const { scenario, writes, t, contract } = options;
    const session: Session = { groupBy: 'none', filters: EMPTY_LIST_FILTER_STATE, collapsed: {} };
    const store = () => useTaskStore.getState();
    let capture: unknown[] = [];
    let stored: Record<string, string> = {};

    const read = (edit?: ListFilterEdit) => {
        const view = ok(contract!.getInboxView({
            groupBy: session.groupBy,
            filters: session.filters,
            filterEdit: edit,
            collapsedGroupIds: session.collapsed[session.groupBy] ?? [],
            offset: 0,
            limit: 100,
        }));
        session.filters = view.filters.state;
        return view;
    };
    const contractParts = (): Parts & { view: ReturnType<typeof read> } => {
        const view = read();
        return {
            view,
            items: view.items.map((item) => (item.type === 'section'
                ? ['section', item.id, item.title, item.count, item.muted, item.collapsible, item.collapsed]
                : ['task', item.row.id, item.groupId, item.row.readOnly])),
            count: view.count,
            title: view.title,
            sortByLabel: view.toolbar.sort.label,
            groupByLabel: view.toolbar.group.label,
            filterActiveCount: view.filterActiveCount,
            hasActiveFilters: view.hasActiveFilters,
            chips: view.chips,
            clearLabel: view.clearLabel,
            controls: { sort: view.toolbar.sort.accessibilityLabel, group: view.toolbar.group.accessibilityLabel, filters: view.toolbar.filters },
            mindSweep: view.mindSweep,
            process: view.process,
            scopeLabel: view.scopeLabel,
            empty: { message: view.empty.message, hint: view.empty.hint, actionLabel: view.empty.actionLabel },
            filterSheet: {
                tokens: view.filters.tokens.items.map((token) => token.value),
                projects: view.filters.projects,
                timeEstimates: view.filters.timeEstimates.map((estimate) => estimate.value),
                visibility: view.filters.visibility,
                chips: view.chips.map((chip) => [chip.id, chip.label, chip.excluded]),
                activeCount: view.filters.activeCount,
                contextMatchMode: view.filters.state.contextMatchMode,
                tagMatchMode: view.filters.state.tagMatchMode,
                showContextMatchMode: view.filters.showContextMatchMode,
                showTagMatchMode: view.filters.showTagMatchMode,
            },
            sort: view.toolbar.sort.options.map((option) => [option.value, option.label, option.selected]),
            group: view.toolbar.group.options.map((option) => [option.label, option.selected]),
        };
    };
    const coreModels = () => {
        const state = store();
        const areas = sortAreasForDisplay(state.areas);
        const tasks = selectStatusListTasks({
            kind: 'inbox', tasks: state.tasks, projects: state.projects, allProjects: state._allProjects,
            resolvedAreaFilter: resolveAreaFilterSelection(state.settings.filters, areas),
            areaById: new Map(areas.map((area) => [area.id, area])),
        });

        const options = buildStatusListFilterOptions({ kind: 'inbox', tasks, allProjects: state._allProjects, settings: state.settings, t, timeEstimateFilters: true });
        const resolved = resolveListFilterState(session.filters, { visibility: options.visibility, t });
        session.filters = resolved.state;
        const model = buildStatusListModel({
            kind: 'inbox', tasks, projects: state.projects, areas: state.areas, settings: state.settings,
            groupBy: session.groupBy, criteria: resolved.criteria, searchQuery: resolved.searchQuery,
            collapsedGroupIds: new Set(session.collapsed[session.groupBy] ?? []), t,
        });
        const summary = buildStatusListFilterSummary({
            kind: 'inbox', chips: resolved.chips, activeCount: resolved.activeCount, hasActive: resolved.hasActive,
            includeArchivedProjects: false, settings: state.settings, t,
        });
        const screen = buildInboxScreenModel({ count: tasks.length, settings: state.settings, t });
        const header = getTaskListHeaderText({
            sortByLabel: model.sortByLabel, groupByLabel: model.groupByLabel,
            hasActiveFilters: summary.hasActive, filterActiveCount: summary.activeCount, t,
        });
        return { state, options, resolved, model, summary, screen, header };
    };
    const coreParts = (): Parts => {
        const { state, options, resolved, model, summary, screen, header } = coreModels();
        return {
            items: model.items.map((item) => (item.type === 'section'
                ? ['section', item.id, item.title, item.count, item.muted, item.collapsible, item.collapsed]
                : ['task', item.task.id, item.groupId, isStatusListTaskReadOnly(item.task, state._allProjects)])),
            count: model.orderedTasks.length,
            title: screen.title,
            sortByLabel: model.sortByLabel,
            groupByLabel: model.groupByLabel,
            filterActiveCount: summary.activeCount,
            hasActiveFilters: summary.hasActive,
            chips: summary.chips.map((chip) => ({ ...chip, accessibilityLabel: header.chipAccessibilityLabel(chip) })),
            clearLabel: header.clear,
            controls: {
                sort: header.sortAccessibilityLabel,
                group: header.groupAccessibilityLabel,
                filters: {
                    accessibilityLabel: header.filtersAccessibilityLabel,
                    countLabel: summary.hasActive ? String(summary.activeCount) : null,
                    selected: summary.hasActive,
                },
            },
            mindSweep: { ...screen.mindSweep, accessibilityLabel: screen.mindSweep.label },
            process: screen.process,
            scopeLabel: screen.scopeLabel,
            empty: summary.empty,
            filterSheet: {
                tokens: options.tokens,
                projects: options.projects,
                timeEstimates: options.timeEstimates,
                visibility: options.visibility,
                chips: resolved.chips.map((chip) => [chip.id, chip.label, chip.excluded]),
                activeCount: resolved.activeCount,
                contextMatchMode: resolved.state.contextMatchMode,
                tagMatchMode: resolved.state.tagMatchMode,
                showContextMatchMode: resolved.showContextMatchMode,
                showTagMatchMode: resolved.showTagMatchMode,
            },
            sort: model.sortOptions.map((option) => [option.value, option.label, option.selected]),
            group: model.groupOptions.map((option) => [option.label, option.selected]),
        };
    };

    const observations: Observation[] = [];
    const observe = (first: boolean) => {
        const parts = contract ? contractParts() : coreParts();
        const extra = { capture, writes: normalize(writes.splice(0)), stored };
        capture = [];
        observations.push(normalize(layout(parts, first, extra)) as Observation);
    };
    const applyFilterEdit = (edit: ListFilterEdit) => {
        if (contract) read(edit);
        else session.filters = applyListFilterEdit(session.filters, edit);
    };

    observe(true);
    for (const action of scenario.actions) {
        const [kind, first, second] = action as [string, unknown, unknown];
        if (kind === 'sort') {
            if (contract) {
                const option = read().toolbar.sort.options.find((entry) => entry.value === first)!;
                ok(await contract.setTaskListSort(option.edit));
            } else {
                await store().updateSettings({ taskSortBy: first as TaskSortBy });
            }
        } else if (kind === 'group') {
            session.groupBy = contract
                ? read().toolbar.group.options.find((entry) => entry.value === first)!.edit.groupBy
                : first as TaskGroupBy;
        } else if (kind === 'collapse') {
            const ids = session.collapsed[session.groupBy] ?? [];
            if (contract) {
                const heading = read().items.find((item) => item.type === 'section' && item.id === first);
                if (heading?.type !== 'section') throw new Error(`No group ${String(first)}`);
                session.collapsed[session.groupBy] = heading.collapseEdit.collapsedGroupIds;
            } else {
                session.collapsed[session.groupBy] = ids.includes(first as string) ? ids.filter((id) => id !== first) : [...ids, first as string];
            }

            stored = { [INBOX_GROUP_COLLAPSE_STORAGE_KEY]: JSON.stringify(session.collapsed) };
        } else if (kind === 'filter') {
            const value = second as string;
            if (first === 'search') applyFilterEdit({ type: 'setSearch', value });
            else if (first === 'location') applyFilterEdit({ type: 'setLocation', value });
            else if (!contract) {
                const type = ({ token: 'toggleToken', priority: 'togglePriority', energy: 'toggleEnergyLevel' } as const)[first as 'token' | 'priority' | 'energy'];
                applyFilterEdit({ type, value } as ListFilterEdit);
            } else {

                const { filters } = read();
                const option = first === 'token'
                    ? filters.tokens.items.find((entry) => entry.value === value)
                    : (first === 'priority' ? filters.priorities : filters.energyLevels).find((entry) => entry.value === value);
                if (!option) throw new Error(`No ${String(first)} option ${value}`);
                applyFilterEdit(option.edit);
            }
        } else if (kind === 'matchMode') {
            applyFilterEdit({ type: 'setMatchMode', kind: first as 'context' | 'tag', value: second as 'all' | 'any' });
        } else if (kind === 'clearChip') {
            const edit = contract
                ? read().chips.find((chip) => chip.id === first)?.action.filterEdit
                : coreModels().resolved.chips.find((chip) => chip.id === first)?.edit;
            if (!edit) throw new Error(`No chip ${String(first)}`);
            applyFilterEdit(edit);
        } else if (kind === 'clearFilters') {
            applyFilterEdit(contract ? read().filters.clearEdit : { type: 'clear' });
        } else if (kind === 'emptyAction') {
            const action = contract
                ? read().empty.action
                : (() => {
                    const { resolved, screen } = coreModels();
                    return resolved.hasActive ? { filterEdit: { type: 'clear' } as ListFilterEdit } : { capture: { autoRecord: screen.autoRecord } };
                })();
            if ('filterEdit' in action) applyFilterEdit(action.filterEdit);
            else capture = [action.capture];
        } else {
            throw new Error(`Unknown action ${kind}`);
        }
        observe(false);
    }
    return observations;
}
