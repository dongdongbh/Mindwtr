/**
 * Test support only (imported by the menu-views tests; not exported).
 * Replays the frozen React Native list-view scenarios (menu-views-parity.fixtures.json,
 * captured by apps/mobile/components/views/menu-views-parity.test.tsx) through
 * core: either core's models and write plans directly, or the native host
 * contract. Both produce the observations the mobile harness recorded.
 */
import { readFileSync } from 'node:fs';
import { isTaskVisibleInArea, resolveAreaFilterSelection } from './area-filter';
import {
    applyListFilterEdit,
    EMPTY_LIST_FILTER_STATE,
    resolveListFilterState,
    type ListFilterEdit,
    type ListFilterState,
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
    REFERENCE_ARCHIVED_CHIP_ID,
    REFERENCE_LIST_DEFAULT_GROUP_BY,
    TASK_LIST_GROUP_OPTIONS,
    selectSomedayTasks,
    selectStatusListTasks,
    type SomedayGroupBy,
    type StatusListKind,
} from './menu-views-model';
import { buildMoreMenuModel } from './more-menu-model';
import type { createNativeHostContract, NativeTaskRow } from './native-host-contract';
import { sortAreasForDisplay } from './native-host-contract';
import {
    buildSomedaySectionManagerRows,
    buildSomedaySectionMoveDialog,
    buildSomedaySectionsSettingsUpdate,
    formatSomedaySectionMoved,
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
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { getSomedaySectionChoices } from './task-editor-model';
import type { TaskGroupBy } from './task-group-sections';
import { DONE_TASK_LIST_SORT_OPTIONS } from './task-list-sort-options';
import type { AppSettings, Area, Project, Task, TaskSortBy, ViewSectionDefinition } from './types';
import { generateUUID } from './uuid';
import { buildTaskViewSectionUndoUpdates, sortViewSectionDefinitions } from './view-sections';

type Screen = 'more' | 'waiting' | 'someday' | 'someday-sections' | 'reference' | 'done';
export type MenuViewAction = [string, ...unknown[]];
export type MenuViewScenario = {
    name: string;
    screen: Screen;
    settings: string;
    omit?: string[];
    storage?: Record<string, string>;
    actions: MenuViewAction[];
};
type Observation = Record<string, unknown>;
export type MenuViewsFixture = {
    provenance: Record<string, unknown>;
    timeZone: string;
    now: string;
    tasks: Task[];
    projects: Project[];
    areas: Area[];
    settings: Record<string, AppSettings>;
    scenarios: MenuViewScenario[];
    observations: Record<string, Observation[]>;
};
type Translate = (key: string) => string;
type Contract = ReturnType<typeof createNativeHostContract>;
const REFERENCE_GROUP_BY_KEY = 'mindwtr:view:reference:groupBy:v1';

export const loadMenuViewsFixture = (): MenuViewsFixture => JSON.parse(
    readFileSync(new URL('./menu-views-parity.fixtures.json', import.meta.url), 'utf8'),
);

// A created task's ID; a new section's (mobile names it someday-…, the contract by its request UUID).
const UUID_OR_SECTION_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|someday-[0-9a-z]+-[0-9a-z]+/g;

/** The store writes a scenario asks for, with created ids named after their titles. */
export function createWriteRecorder() {
    const log: unknown[] = [];
    const createdIds = new Map<string, string>();
    const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (
        entry === undefined ? '<undefined>' : entry
    )).replace(UUID_OR_SECTION_ID, (match) => (
        createdIds.get(match) ?? match
    )));
    const encodeArgs = (args: unknown[]) => normalize(args.map((arg) => (
        arg && typeof arg === 'object' && !Array.isArray(arg)
            ? Object.fromEntries(Object.entries(arg).map(([key, value]) => [key, value === undefined ? '<undefined>' : value]))
            : arg
    ))) as unknown[];
    return { log, createdIds, normalize, encodeArgs };
}
export type WriteRecorder = ReturnType<typeof createWriteRecorder>;

type RecordedActions = 'updateTask' | 'deleteTask' | 'addTask' | 'updateProject' | 'updateSettings' | 'batchUpdateTasks' | 'batchMoveTasks' | 'batchDeleteTasks';
let realActions: Pick<ReturnType<typeof useTaskStore.getState>, RecordedActions> | null = null;
export const getRealStoreActions = () => realActions!;

/** Load the scenario's data through the store and record the writes the screens use, as the harness does. */
export async function seedMenuViewsStore(
    fixture: MenuViewsFixture,
    scenario: MenuViewScenario,
    recorder: WriteRecorder,
    adapter: { saveData?: (data: unknown) => Promise<void> } = {},
): Promise<void> {
    await flushPendingSave();
    resetForTests();
    const initial = useTaskStore.getState();
    realActions ??= {
        updateTask: initial.updateTask,
        deleteTask: initial.deleteTask,
        addTask: initial.addTask,
        updateProject: initial.updateProject,
        updateSettings: initial.updateSettings,
        batchUpdateTasks: initial.batchUpdateTasks,
        batchMoveTasks: initial.batchMoveTasks,
        batchDeleteTasks: initial.batchDeleteTasks,
    };
    const real = realActions;
    const omit = scenario.omit ?? [];
    let data = JSON.parse(JSON.stringify({
        tasks: fixture.tasks.filter((task) => !omit.includes(task.id)),
        projects: fixture.projects.filter((project) => !omit.includes(project.id)),
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
        ...real,
        _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
    });
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    const { log, createdIds, encodeArgs } = recorder;
    const record = (name: string, args: unknown[]) => { log.push([name, ...encodeArgs(args)]); };
    useTaskStore.setState({
        updateTask: async (id, updates) => { record('updateTask', [id, updates]); return real.updateTask(id, updates); },
        deleteTask: async (id) => { record('deleteTask', [id]); return real.deleteTask(id); },
        addTask: async (title, props, options) => {
            record('addTask', [title, props]);
            const result = await real.addTask(title, props, options);
            if (result.id) createdIds.set(result.id, `<created:${title}>`);
            return result;
        },
        updateProject: async (id, updates) => { record('updateProject', [id, updates]); return real.updateProject(id, updates); },
        updateSettings: async (updates) => {
            updates.gtd?.viewSections?.someday?.forEach((section) => {
                const id = String(section?.id);
                if (id.replace(UUID_OR_SECTION_ID, '') === '' && !createdIds.has(id)) createdIds.set(id, `<created:${section.title}>`);
            });
            record('updateSettings', [updates]);
            return real.updateSettings(updates);
        },
        batchUpdateTasks: async (updates) => { record('batchUpdateTasks', [updates]); return real.batchUpdateTasks(updates); },
        batchMoveTasks: async (ids, status) => { record('batchMoveTasks', [ids, status]); return real.batchMoveTasks(ids, status); },
        batchDeleteTasks: async (ids) => { record('batchDeleteTasks', [ids]); return real.batchDeleteTasks(ids); },
    });
}

const ok = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};

/** The screen's visible tasks and area lookups, as mobile's useVisibleTaskContext derives them. */
const visibleContext = () => {
    const state = useTaskStore.getState();
    const areas = sortAreasForDisplay(state.areas);
    const areaById = new Map(areas.map((area) => [area.id, area]));
    const resolvedAreaFilter = resolveAreaFilterSelection(state.settings.filters, areas);
    const projectById = new Map(state.projects.map((project) => [project.id, project]));
    const visibleTasks = state.tasks.filter((task) => isTaskVisibleInArea(task, { areaById, projectById, resolvedAreaFilter }));
    return { state, areaById, resolvedAreaFilter, visibleTasks };
};

/**
 * What the comparison reads: the parts of an observation that are the screen's
 * logic. Mobile's render details that the contract does not own are reduced to
 * what a user sees (an empty state only shows with no rows; the move dialog is
 * its choices; the tab bar is its quick-access tab; device view-state storage
 * is dropped).
 */
export function projectObservation(screen: Screen, observation: Observation, t: Translate): Observation {
    if ('opened' in observation) return { opened: projectObservation(screen, observation.opened as Observation, t) };
    if ('created' in observation) return observation;
    const next: Observation = { ...observation };
    if (screen === 'more') next.tabs = (observation.tabs as string[])[3];
    if (screen === 'waiting' || screen === 'someday') {
        const rows = (observation.rows as unknown[]);
        next.empty = observation.empty && rows.length === 0 ? observation.empty : null;
    }
    if (screen === 'someday') {
        // Headings offer Add task; the pre-grouping order is not shown.
        const rows = observation.rows as unknown[][];
        next.canAddToSection = observation.canAddToSection === true && rows.some((row) => row[0] === 'heading');
        delete next.tasks;
    }
    if (screen === 'someday' && observation.moveDialog && 'sections' in (observation.moveDialog as object)) {
        const dialog = observation.moveDialog as { title: string; sections: ViewSectionDefinition[]; selectedId: string | null; selectionMixed: boolean };
        next.moveDialog = {
            title: dialog.title,
            choices: getSomedaySectionChoices(dialog.sections, dialog.selectedId ?? undefined, t('viewSections.noSection'), dialog.selectionMixed),
        };
    }
    if (screen === 'reference') next.referenceGroupByStorage = (observation.stored as Record<string, string> | undefined)?.[REFERENCE_GROUP_BY_KEY] ?? null;
    if (screen === 'reference' || screen === 'done') delete next.stored;
    return next;
}

type SomedaySession = {
    sortBy: TaskSortBy;
    groupBy: SomedayGroupBy;
    showDetails: boolean;
    filters: ListFilterState;
    selection: string[];
    moveTargets: string[] | null;
    undo: { previous: SomedaySectionAssignment[]; sectionId: string | null } | null;
    /** The contract's move to undo. */
    undoRequestId: string | null;
};

type StatusSession = {
    groupBy: TaskGroupBy;
    viewSortBy?: TaskSortBy;
    includeArchived: boolean;
    filters: ListFilterState;
    collapsed: Record<string, string[]>;
};

const FILTER_EDITS: Record<string, ListFilterEdit['type']> = {
    token: 'toggleToken', project: 'toggleProject', priority: 'togglePriority', energy: 'toggleEnergyLevel', time: 'toggleTimeEstimate', search: 'setSearch',
};
const filterEditOf = (action: MenuViewAction): ListFilterEdit => (
    { type: FILTER_EDITS[action[1] as string], value: action[2] } as ListFilterEdit
);

/** Replays one scenario. With `contract`, every read and write goes through the native host contract. */
export async function replayMenuViewsScenario(options: {
    fixture: MenuViewsFixture;
    scenario: MenuViewScenario;
    recorder: WriteRecorder;
    t: Translate;
    contract?: Contract;
}): Promise<Observation[]> {
    const { scenario, recorder, t, contract } = options;
    const toasts: unknown[] = [];
    const drain = () => ({ writes: recorder.normalize(recorder.log.splice(0)), toasts: toasts.splice(0) });
    const observations: Observation[] = [];
    const push = (observation: Observation) => observations.push(recorder.normalize(observation) as Observation);
    const store = () => useTaskStore.getState();
    const taskById = (id: string) => store()._allTasks.find((task) => task.id === id)!;
    const rowIds = (rows: NativeTaskRow[]) => rows.map((row) => row.id);

    const changeStatus = async (id: string, status: Task['status']) => {
        if (contract) {
            ok(await contract.updateTask({ id, base: { status: taskById(id).status }, patch: { status }, requestId: generateUUID() }));
        } else {
            await store().updateTask(id, { status });
        }
    };
    // The row's delete moves the task to Trash through the store; the contract has no delete yet.
    const remove = async (id: string) => { await store().deleteTask(id); };
    const activate = async (id: string) => {
        if (!contract) {
            await store().updateProject(id, { status: 'active' });
            return;
        }
        // The parked row's revision, as the screen showed it.
        const window = { offset: 0, limit: 1 };
        const { deferred } = scenario.screen === 'waiting' ? ok(contract.getWaitingView(window)) : ok(contract.getSomedayView(window));
        const row = deferred!.rows.items.find((entry) => entry.id === id)!;
        ok(await contract.activateProject({ projectId: id, projectRevision: row.projectRevision }));
    };

    // ------------------------------------------------------------------ More
    if (scenario.screen === 'more') {
        let open = false;
        let pushes: string[] = [];
        const readMenu = () => {
            const settings = store().settings;
            if (!contract) {
                return buildMoreMenuModel({ quickAccessView: settings.appearance?.mobileQuickAccessView, savedSearches: settings.savedSearches, t });
            }
            const menu = ok(contract.getMoreMenu());
            return { ...menu, savedSearches: menu.savedSearches.items };
        };
        const observe = () => {
            const menu = readMenu();
            const item = (entry: typeof menu.primary[number]) => ({
                id: entry.id, label: entry.label, text: entry.displayLabel, icon: entry.icon, iconColor: entry.iconColor, route: entry.route,
            });
            const observation = {
                tabs: ['', '', '', menu.quickAccessView, ''],
                open,
                utilities: open ? menu.utilities.map(item) : [],
                savedTitle: open && menu.savedSearches.length > 0 ? menu.savedSearchesTitle : null,
                saved: open ? menu.savedSearches.map(item) : [],
                primary: open ? menu.primary.map(item) : [],
                pushes,
            };
            pushes = [];
            return observation;
        };
        push(observe());
        for (const action of scenario.actions) {
            if (action[0] === 'openMore') open = true;
            if (action[0] === 'press') {
                const menu = readMenu();
                const target = [...menu.utilities, ...menu.savedSearches, ...menu.primary].find((entry) => entry.id === action[1])!;
                pushes = [target.route];
                open = false;
            }
            push(observe());
        }
        return observations;
    }

    // --------------------------------------------------------------- Waiting
    if (scenario.screen === 'waiting') {
        let person = '';
        const observe = (): Observation => {
            if (contract) {
                const view = ok(contract.getWaitingView({ person, offset: 0, limit: 100 }));
                person = view.person;
                return {
                    stats: view.stats.map((stat) => [String(stat.value), stat.label]),
                    filterLabel: view.filterLabel,
                    people: [
                        { label: view.all.label, active: view.all.selected },
                        ...view.people.items.map((entry) => ({ label: entry.label, active: entry.selected })),
                    ],
                    clear: view.clearLabel,
                    rows: rowIds(view.rows),
                    groups: null,
                    deferred: view.deferred && {
                        header: view.deferred.title,
                        headerLabel: view.deferred.title,
                        rows: view.deferred.rows.items.map((row) => ({ action: view.deferred!.activateLabel, title: row.title, area: row.areaName, color: row.color ?? '#64748b' })),
                    },
                    empty: view.empty ? [view.empty.title, view.empty.hint] : null,
                    ...drain(),
                };
            }
            const { state, areaById, resolvedAreaFilter, visibleTasks } = visibleContext();
            let model = buildWaitingViewModel({ tasks: visibleTasks, projects: state.projects, resolvedAreaFilter, areaById, person, t });
            if (!model.personOffered) {
                person = '';
                model = buildWaitingViewModel({ tasks: visibleTasks, projects: state.projects, resolvedAreaFilter, areaById, person, t });
            }
            const { labels } = model;
            return {
                stats: [[String(model.count), labels.count], [String(model.withDeadlineCount), labels.withDeadline]],
                filterLabel: labels.filter,
                people: [
                    { label: labels.all, active: !person },
                    ...model.people.map((entry) => ({ label: entry, active: person.toLowerCase() === entry.toLowerCase() })),
                ],
                clear: person ? labels.clear : null,
                rows: model.tasks.map((task) => task.id),
                groups: null,
                deferred: model.deferred && {
                    header: model.deferred.title,
                    headerLabel: model.deferred.title,
                    rows: model.deferred.rows.map((row) => ({ action: model.deferred!.activateLabel, title: row.title, area: row.areaName, color: row.color ?? '#64748b' })),
                },
                empty: model.deferred ? null : [labels.emptyTitle, labels.emptyHint],
                ...drain(),
            };
        };
        push(observe());
        for (const action of scenario.actions) {
            const [kind, first, second] = action as [string, string, string];
            if (kind === 'person') person = first;
            else if (kind === 'clearPerson') person = '';
            else if (kind === 'status') await changeStatus(first, second as Task['status']);
            else if (kind === 'delete') await remove(first);
            else if (kind === 'activateProject') await activate(first);
            else throw new Error(`Unknown action ${kind}`);
            push(observe());
        }
        return observations;
    }

    // --------------------------------------------------------------- Someday
    if (scenario.screen === 'someday') {
        const session: SomedaySession = {
            sortBy: 'default', groupBy: 'viewSection', showDetails: false, filters: EMPTY_LIST_FILTER_STATE,
            selection: [], moveTargets: null, undo: null, undoRequestId: null,
        };
        let addDialog: string[] | null = null;
        const coreView = () => {
            const { state, areaById, resolvedAreaFilter, visibleTasks } = visibleContext();
            const tasks = selectSomedayTasks(visibleTasks);
            const filterOptions = buildSomedayFilterOptions({ tasks, projects: state.projects, settings: state.settings, t });
            const resolved = resolveListFilterState(session.filters, {
                visibility: filterOptions.visibility,
                retainTokens: filterOptions.retainTokens,
                retainProjects: filterOptions.retainProjects,
                getProjectLabel: filterOptions.getProjectLabel,
                t,
            });
            const model = buildSomedayViewModel({
                tasks, projects: state.projects, areaById, resolvedAreaFilter, settings: state.settings,
                sortBy: session.sortBy, groupBy: session.groupBy, showDetails: session.showDetails,
                criteria: resolved.criteria, searchQuery: resolved.searchQuery, filterChips: resolved.chips, t,
            });
            return { model, resolved, filterOptions };
        };
        const moveDialog = () => {
            if (!session.moveTargets) return null;
            const byId = new Map(store().tasks.map((task) => [task.id, task]));
            const targets = session.moveTargets.map((id) => byId.get(id));
            const dialog = contract
                ? ok(contract.getSomedayMoveDialog({ taskIds: session.moveTargets }))
                : buildSomedaySectionMoveDialog(targets, store().settings.gtd?.viewSections?.someday, t);
            const choices = Array.isArray(dialog.choices) ? dialog.choices : dialog.choices.items;
            return { title: dialog.title, choices: choices.map((choice) => ({ id: choice.sectionId ?? '', title: choice.title, selected: choice.selected })) };
        };
        // The native Android host draws parked projects inside their section, as React Native does (#1319).
        const somedayRead = (limit: number) => ok(contract!.getSomedayView({
            sortBy: session.sortBy, groupBy: session.groupBy, showDetails: session.showDetails,
            filters: session.filters, projectsInSections: true, offset: 0, limit,
        }));
        const leaf = (id: string, label: string, accessibilityLabel: string | null, value: string | null, selected: boolean | null) => ({
            id, label, accessibilityLabel, value, selected,
        });
        const observe = (): Observation => {
            if (contract) {
                const view = somedayRead(100);
                session.filters = view.filters.state;
                const { menu } = view;
                const rows = view.items.map((item) => (item.type === 'heading'
                    ? ['heading', item.id, item.title, item.muted]
                    : item.type === 'project' ? ['project', item.id] : ['task', item.row.id]));
                const grouped = view.items.some((item) => item.type === 'heading');
                return {
                    stats: view.stats.map((stat) => [String(stat.value), stat.label]),
                    filterChip: view.filterChip,
                    menu: {
                        actions: [
                            leaf('filters', menu.filters.label, null, null, menu.filters.selected),
                            { ...leaf('sort', menu.sort.label, menu.sort.accessibilityLabel, menu.sort.value, null), submenu: {
                                title: menu.sort.label,
                                actions: menu.sort.options.map((option) => leaf(`sort:${option.value}`, option.label, option.accessibilityLabel, null, option.selected)),
                            } },
                            { ...leaf('group', menu.group.label, menu.group.accessibilityLabel, menu.group.value, null), submenu: {
                                title: menu.group.label,
                                actions: menu.group.options.map((option) => leaf(`group:${option.value}`, option.label, option.accessibilityLabel, null, option.selected)),
                            } },
                            leaf('details', menu.details.label, null, null, menu.details.selected),
                            leaf('new-section', menu.newSection.label, null, null, null),
                        ],
                        labels: [menu.backLabel, menu.closeLabel, menu.moreLabel],
                    },
                    rows,
                    canAddToSection: grouped && view.items.some((item) => item.type === 'heading' && item.addTask !== null),
                    canMoveToSection: true,
                    showDetails: view.showDetails,
                    filterSheet: {
                        tokens: view.filters.tokens.items.map((token) => token.value),
                        projects: view.filters.projects?.items.map(({ id, title }) => ({ id, title })) ?? null,
                        timeEstimates: view.filters.timeEstimates.map((estimate) => estimate.value),
                        visibility: view.filters.visibility,
                        hasAdditional: false,
                        chips: view.chips.map((chip) => [chip.id, chip.label, chip.excluded]),
                        activeCount: view.filters.activeCount,
                        archiveToggle: null,
                    },
                    moveDialog: moveDialog(),
                    addDialog,
                    deferred: view.deferred && {
                        header: view.deferred.title,
                        headerLabel: view.deferred.title,
                        rows: view.deferred.rows.items.map((row) => ({ action: view.deferred!.activateLabel, title: row.title, area: row.areaName, color: row.color ?? '#64748b' })),
                    },
                    empty: view.empty ? [view.empty.title, ...(view.empty.hint ? [view.empty.hint] : []), ...(view.empty.clear ? [t('filters.clear')] : [])] : null,
                    ...drain(),
                };
            }
            const { model, resolved, filterOptions } = coreView();
            session.filters = resolved.state;
            const { labels } = model;
            return {
                stats: [[String(model.ideasCount), labels.ideas], [String(model.inProjectsCount), labels.inProjects]],
                filterChip: resolved.hasActive
                    ? { label: `${labels.filters} · ${resolved.activeCount}`, removeLabel: `${labels.filtersClear}: ${labels.filters}` }
                    : null,
                menu: {
                    actions: [
                        leaf('filters', labels.filters, null, null, resolved.hasActive),
                        { ...leaf('sort', labels.sort, `${labels.sort}: ${model.menu.sortValue}`, model.menu.sortValue, null), submenu: {
                            title: labels.sort,
                            actions: model.menu.sortOptions.map((option) => leaf(`sort:${option.value}`, option.label, `${labels.sort}: ${option.label}`, null, option.selected)),
                        } },
                        { ...leaf('group', labels.group, `${labels.group}: ${model.menu.groupValue}`, model.menu.groupValue, null), submenu: {
                            title: labels.group,
                            actions: model.menu.groupOptions.map((option) => leaf(`group:${option.value}`, option.label, `${labels.group}: ${option.label}`, null, option.selected)),
                        } },
                        leaf('details', labels.details, null, null, session.showDetails),
                        leaf('new-section', labels.newSection, null, null, null),
                    ],
                    labels: [labels.back, labels.close, labels.more],
                },
                rows: model.groups
                    ? model.groups.flatMap((group) => [
                        ['heading', group.id, group.title, group.muted === true],
                        ...(group.projects ?? []).map((project) => ['project', project.id]),
                        ...group.tasks.map((task) => ['task', task.id]),
                    ])
                    : model.tasks.map((task) => ['task', task.id]),
                tasks: model.tasks.map((task) => task.id),
                canAddToSection: model.canAddTaskToGroup,
                canMoveToSection: true,
                showDetails: session.showDetails,
                filterSheet: {
                    tokens: filterOptions.tokens,
                    projects: filterOptions.projects,
                    timeEstimates: filterOptions.timeEstimates,
                    visibility: filterOptions.visibility,
                    hasAdditional: false,
                    chips: resolved.chips.map((chip) => [chip.id, chip.label, chip.excluded]),
                    activeCount: resolved.activeCount,
                    archiveToggle: null,
                },
                moveDialog: moveDialog(),
                addDialog,
                deferred: model.deferred && {
                    header: model.deferred.title,
                    headerLabel: model.deferred.title,
                    rows: model.deferred.rows.map((row) => ({ action: model.deferred!.activateLabel, title: row.title, area: row.areaName, color: row.color ?? '#64748b' })),
                },
                empty: model.deferred && !model.showEmptyState ? null
                    : [model.empty.message, ...(model.empty.hint ? [model.empty.hint] : []), ...(model.empty.actionLabel ? [model.empty.actionLabel] : [])],
                ...drain(),
            };
        };

        const move = async (destination: string | null) => {
            const text = getSomedaySectionMoveText(t);
            const failed = () => { toasts.push(['error', text.errorTitle, text.moveFailed, null]); };
            const ids = session.moveTargets!;
            if (contract) {
                // Each task's revision as the list showed it.
                const rows = somedayRead(100).items.flatMap((item) => (item.type === 'task' ? [item.row] : []));
                const taskRevisions = Object.fromEntries(ids.map((id) => [id, rows.find((row) => row.id === id)!.taskRevision]));
                const result = ok(await contract.moveSomedayTasksToSection({ taskIds: ids, sectionId: destination, requestId: generateUUID(), taskRevisions }));
                if ('refused' in result) return failed();
                session.moveTargets = null;
                session.selection = [];
                if (result.toast) toasts.push(['success', null, result.toast.message, result.toast.undoLabel]);
                session.undoRequestId = result.undoRequestId;
                return undefined;
            }
            const latest = store();
            const section = destination
                ? sortViewSectionDefinitions(latest.settings.gtd?.viewSections?.someday).find((entry) => entry.id === destination)
                : undefined;
            if (destination && !section) return failed();
            const tasks = getSomedaySectionMoveTasks({
                tasks: latest.tasks, projects: latest.projects, areas: latest.areas, ids, resolvedAreaFilter: visibleContext().resolvedAreaFilter,
            });
            if (!tasks) return failed();
            const { updates, previous } = planSomedaySectionMove({ ids, tasks, destination: destination ?? undefined });
            session.moveTargets = null;
            session.selection = [];
            if (previous.length === 0) return undefined;
            if (updates.length > 0) await latest.batchUpdateTasks(updates);
            toasts.push(['success', null, formatSomedaySectionMoved(t, previous.length, section?.title), text.undoLabel]);
            session.undo = { previous, sectionId: destination };
            return undefined;
        };

        push(observe());
        for (const action of scenario.actions) {
            const [kind, first, second] = action as [string, unknown, unknown];
            if (kind === 'status') await changeStatus(first as string, second as Task['status']);
            else if (kind === 'delete') await remove(first as string);
            else if (kind === 'activateProject') await activate(first as string);
            else if (kind === 'sort') session.sortBy = first as TaskSortBy;
            else if (kind === 'group') session.groupBy = first as SomedayGroupBy;
            else if (kind === 'details') session.showDetails = !session.showDetails;
            else if (kind === 'filter') session.filters = applyListFilterEdit(session.filters, filterEditOf(action));
            else if (kind === 'clearFilters') session.filters = applyListFilterEdit(session.filters, { type: 'clear' });
            else if (kind === 'clearChip') {
                const chip = contract
                    ? somedayRead(1).chips.find((entry) => entry.id === first)!
                    : { action: { filterEdit: coreView().resolved.chips.find((entry) => entry.id === first)!.edit } };
                session.filters = applyListFilterEdit(session.filters, (chip.action as { filterEdit: ListFilterEdit }).filterEdit);
            } else if (kind === 'select') session.selection = [...session.selection, ...(first as string[]).filter((id) => !session.selection.includes(id))];
            else if (kind === 'moveToSection') {
                const ids = first as string[];
                session.moveTargets = ids.length > 0 ? [ids[0]] : [...session.selection];
                push({ opened: observe() });
                await move(second as string | null);
            } else if (kind === 'undo') {
                const undo = session.undo!;
                session.undo = null;
                if (contract) {
                    ok(await contract.undoSomedaySectionMove({ moveRequestId: session.undoRequestId!, requestId: generateUUID() }));
                    session.undoRequestId = null;
                } else {
                    const latest = store();
                    const latestTasks = undo.previous.map(({ id }) => latest.tasks.find((task) => task.id === id)).filter((task): task is Task => Boolean(task));
                    const updates = buildTaskViewSectionUndoUpdates(latestTasks, 'someday', undo.previous, undo.sectionId ?? undefined);
                    if (updates.length > 0) await latest.batchUpdateTasks(updates);
                }
            } else if (kind === 'addTask') {
                const groupId = first as string;
                const sectionId = getSomedayGroupSectionId(groupId) ?? undefined;
                const current = contract ? somedayRead(100) : null;
                const heading = current?.items.find((item) => item.type === 'heading' && item.id === groupId);
                const groupTitle = coreView().model.groups!.find((group) => group.id === groupId)!.title;
                const dialogText = getSomedaySectionTaskText(t, groupTitle);
                addDialog = heading && heading.type === 'heading'
                    ? [heading.addTask!.accessibilityLabel, current!.text.addTask.cancelLabel, current!.text.addTask.saveLabel]
                    : [dialogText.title, dialogText.cancelLabel, dialogText.saveLabel];
                push({ opened: observe() });
                addDialog = null;
                if (contract) {
                    const result = ok(await contract.addSomedaySectionTask({ title: second as string, sectionId: sectionId ?? null, captureId: generateUUID() }));
                    if ('refused' in result) throw new Error('Add task refused');
                    toasts.push(['success', null, result.toast, null]);
                } else {
                    const plan = planSomedaySectionTaskAdd({ title: second as string, sectionId, stored: store().settings.gtd?.viewSections?.someday });
                    if (plan.kind !== 'add') throw new Error('Add task refused');
                    await store().addTask(plan.title, plan.props);
                    toasts.push(['success', null, dialogText.created, null]);
                }
            } else if (kind === 'newSection') {
                let created: string;
                if (contract) {
                    created = ok(await contract.createSomedaySection({ title: first as string, requestId: generateUUID() })).id;
                } else {
                    const settings = store().settings;
                    const plan = planSomedaySectionCreate(settings.gtd?.viewSections?.someday, first as string);
                    if (plan.kind === 'blank') throw new Error('Blank section');
                    if (plan.kind === 'create') await store().updateSettings(buildSomedaySectionsSettingsUpdate(settings, plan.sections));
                    created = plan.id;
                }
                push({ created: recorder.normalize(created) });
            } else if (kind === 'removeSectionElsewhere') {
                const settings = store().settings;
                await getRealStoreActions().updateSettings(buildSomedaySectionsSettingsUpdate(
                    settings,
                    (settings.gtd?.viewSections?.someday ?? []).filter((section) => section.id !== first),
                ));
            } else {
                throw new Error(`Unknown action ${kind}`);
            }
            push(observe());
        }
        return observations;
    }

    // ------------------------------------------------------ Someday sections
    if (scenario.screen === 'someday-sections') {
        let renaming: { id: string; title: string } | null = null;
        let alerts: unknown[] = [];
        const rows = () => {
            if (contract) return ok(contract.getSomedaySections()).rows;
            return buildSomedaySectionManagerRows(store().settings.gtd?.viewSections?.someday, t);
        };
        const observe = (): Observation => {
            const saveLabel = t('common.save');
            const observation = {
                rows: rows().map((row) => ({
                    title: renaming?.id === row.id ? '' : row.title,
                    input: renaming?.id === row.id ? renaming.title : null,
                    buttons: [
                        [row.moveUp.label, row.moveUp.disabled],
                        [row.moveDown.label, row.moveDown.disabled],
                        [renaming?.id === row.id ? saveLabel : row.renameLabel, false],
                        [row.deleteLabel, false],
                    ],
                })),
                alerts,
                writes: recorder.log.splice(0),
            };
            return observation;
        };
        const stored = () => store().settings.gtd?.viewSections?.someday;
        const write = async (next: ViewSectionDefinition[]) => {
            await store().updateSettings(buildSomedaySectionsSettingsUpdate(store().settings, next));
        };
        push(observe());
        for (const action of scenario.actions) {
            const [kind, id, value] = action as [string, string, unknown];
            const row = rows().find((entry) => entry.id === id)!;
            if (kind === 'renameSection') {
                renaming = { id, title: value as string };
                if (contract) {
                    const result = await contract.renameSomedaySection({ id, title: value as string });
                    if (result.ok) renaming = null;
                    else if (result.error.code !== 'INVALID_INPUT') throw new Error(result.error.message);
                } else {
                    const next = renameSomedaySection(stored(), id, value as string);
                    if (next) {
                        await write(next);
                        renaming = null;
                    }
                }
            } else if (kind === 'moveSection') {
                const offset = value as -1 | 1;
                const disabled = offset < 0 ? row.moveUp.disabled : row.moveDown.disabled;
                if (!disabled) {
                    if (contract) {
                        const target = (offset < 0 ? row.moveUp : row.moveDown) as { ids?: string[] | null };
                        const ids = target.ids!;
                        ok(await contract.reorderSomedaySections({ ids }));
                    } else {
                        await write(moveSomedaySection(stored(), id, offset)!);
                    }
                }
            } else if (kind === 'deleteSection') {
                const confirm = row.deleteConfirm;
                alerts = [[confirm.title, confirm.message, [[confirm.cancelLabel, 'cancel'], [confirm.confirmLabel, 'destructive']]]];
                push(observe());
                alerts = [];
                if (contract) ok(await contract.deleteSomedaySection({ id }));
                else await write(removeSomedaySection(stored(), id));
            } else {
                throw new Error(`Unknown action ${kind}`);
            }
            push(observe());
        }
        return observations;
    }

    // --------------------------------------------------- Reference and Done
    const kind: StatusListKind = scenario.screen === 'reference' ? 'reference' : 'done';
    let storedReferenceGroupBy = scenario.storage?.[REFERENCE_GROUP_BY_KEY] ?? null;
    const initialReferenceGroupBy = (TASK_LIST_GROUP_OPTIONS as readonly string[]).includes(storedReferenceGroupBy ?? '')
        ? storedReferenceGroupBy as TaskGroupBy : REFERENCE_LIST_DEFAULT_GROUP_BY;
    const storedDone = scenario.storage?.['mindwtr:view:done:v1'];
    const parsedDone = storedDone ? JSON.parse(storedDone) as { groupBy?: TaskGroupBy; sortBy?: TaskSortBy } : {};
    const session: StatusSession = {
        groupBy: kind === 'reference' ? initialReferenceGroupBy
            : (DONE_LIST_GROUP_OPTIONS as readonly string[]).includes(parsedDone.groupBy as string) ? parsedDone.groupBy! : DONE_LIST_DEFAULT_GROUP_BY,
        viewSortBy: DONE_TASK_LIST_SORT_OPTIONS.includes(parsedDone.sortBy as TaskSortBy) ? parsedDone.sortBy : undefined,
        includeArchived: false,
        filters: EMPTY_LIST_FILTER_STATE,
        collapsed: {},
    };
    const read = (edit?: ListFilterEdit) => {
        const input = {
            groupBy: session.groupBy,
            filters: session.filters,
            filterEdit: edit,
            collapsedGroupIds: session.collapsed[session.groupBy] ?? [],
            offset: 0,
            limit: 100,
        };
        const view = ok(kind === 'reference'
            ? contract!.getReferenceView({ ...input, includeArchivedProjects: session.includeArchived })
            : contract!.getDoneView({ ...input, sortBy: session.viewSortBy }));
        session.filters = view.filters.state;
        session.includeArchived = view.includeArchivedProjects;
        return view;
    };
    const coreModel = () => {
        const { state, areaById, resolvedAreaFilter } = visibleContext();
        const tasks = selectStatusListTasks({
            kind, tasks: state.tasks, projects: state.projects, allProjects: state._allProjects,
            resolvedAreaFilter, areaById, includeArchivedProjects: session.includeArchived,
        });
        const filterOptions = buildStatusListFilterOptions({ kind, tasks, allProjects: state._allProjects, settings: state.settings, t });
        const resolved = resolveListFilterState(session.filters, {
            visibility: filterOptions.visibility,
            retainProjects: filterOptions.retainProjects,
            getProjectLabel: filterOptions.getProjectLabel,
            t,
        });
        const model = buildStatusListModel({
            kind, tasks, projects: state.projects, areas: state.areas, settings: state.settings,
            groupBy: session.groupBy, viewSortBy: session.viewSortBy,
            criteria: resolved.criteria, searchQuery: resolved.searchQuery,
            collapsedGroupIds: new Set(session.collapsed[session.groupBy] ?? []), t,
        });
        const summary = buildStatusListFilterSummary({
            kind, chips: resolved.chips, activeCount: resolved.activeCount, hasActive: resolved.hasActive,
            includeArchivedProjects: session.includeArchived, t,
        });
        session.filters = resolved.state;
        return { model, resolved, summary, filterOptions };
    };
    const title = getStatusListScreenText(kind, t).title;
    const stored = () => kind === 'reference' ? { stored: storedReferenceGroupBy ? { [REFERENCE_GROUP_BY_KEY]: storedReferenceGroupBy } : {} } : {};
    const observe = (first = false): Observation => {
        if (contract) {
            const view = read();
            return {
                items: view.items.map((item) => (item.type === 'section'
                    ? ['section', item.id, item.title, item.count, item.muted, item.collapsible, item.collapsed]
                    : ['task', item.row.id, item.groupId])),
                header: {
                    count: view.count,
                    chips: view.chips.map((chip) => [chip.id, chip.label, chip.excluded]),
                    filterActiveCount: view.filterActiveCount,
                    hasActiveFilters: view.hasActiveFilters,
                    groupByLabel: view.group.label,
                    sortByLabel: view.sort.label,
                    showHeader: false,
                    title: view.title,
                    navigationOverflow: { renderOverflowOnly: true, title: view.title, count: view.count },
                },
                empty: { message: view.empty.message, hint: view.empty.hint, actionLabel: view.empty.actionLabel },
                filterSheet: {
                    tokens: view.filters.tokens.items.map((token) => token.value),
                    projects: view.filters.projects?.items.map(({ id, title: projectTitle }) => ({ id, title: projectTitle })) ?? null,
                    timeEstimates: view.filters.timeEstimates.map((estimate) => estimate.value),
                    visibility: view.filters.visibility,
                    hasAdditional: view.includeArchivedProjects,
                    chips: view.chips.filter((chip) => 'filterEdit' in chip.action).map((chip) => [chip.id, chip.label, chip.excluded]),
                    activeCount: view.filters.activeCount,
                    archiveToggle: view.archivedProjectsToggle,
                },
                ...stored(),
                ...drain(),
                ...(first ? {
                    sort: { options: view.sort.options.map((option) => [option.value, option.label, option.selected]) },
                    group: view.group.options.map((option) => [option.label, option.selected]),
                } : {}),
            };
        }
        const { model, resolved, summary, filterOptions } = coreModel();
        return {
            items: model.items.map((item) => (item.type === 'section'
                ? ['section', item.id, item.title, item.count, item.muted, item.collapsible, item.collapsed]
                : ['task', item.task.id, item.groupId])),
            header: {
                count: model.orderedTasks.length,
                chips: summary.chips.map((chip) => [chip.id, chip.label, chip.excluded]),
                filterActiveCount: summary.activeCount,
                hasActiveFilters: summary.hasActive,
                groupByLabel: model.groupByLabel,
                sortByLabel: model.sortByLabel,
                showHeader: false,
                title,
                navigationOverflow: { renderOverflowOnly: true, title, count: model.orderedTasks.length },
            },
            empty: summary.empty,
            filterSheet: {
                tokens: filterOptions.tokens,
                projects: filterOptions.projects,
                timeEstimates: filterOptions.timeEstimates,
                visibility: filterOptions.visibility,
                hasAdditional: kind === 'reference' && session.includeArchived,
                chips: resolved.chips.map((chip) => [chip.id, chip.label, chip.excluded]),
                activeCount: resolved.activeCount,
                archiveToggle: kind === 'reference' ? { label: t('reference.includeArchivedProjects'), value: session.includeArchived } : null,
            },
            ...stored(),
            ...drain(),
            ...(first ? {
                sort: { options: model.sortOptions.map((option) => [option.value, option.label, option.selected]) },
                group: model.groupOptions.map((option) => [option.label, option.selected]),
            } : {}),
        };
    };
    const applyFilterEdit = (edit: ListFilterEdit) => {
        if (contract) {
            read(edit);
            return;
        }
        session.filters = applyListFilterEdit(session.filters, edit);
        // Mobile's Clear also turns archived projects off.
        if (edit.type === 'clear') session.includeArchived = false;
    };
    push(observe(true));
    for (const action of scenario.actions) {
        const [actionKind, first, second] = action as [string, unknown, unknown];
        if (actionKind === 'status') await changeStatus(first as string, second as Task['status']);
        else if (actionKind === 'delete') await remove(first as string);
        else if (actionKind === 'group') {
            session.groupBy = first as TaskGroupBy;
            if (kind === 'reference') storedReferenceGroupBy = session.groupBy;
        }
        else if (actionKind === 'sort') {
            if (kind === 'done') session.viewSortBy = first as TaskSortBy;
            else if (contract) ok(await contract.setTaskListSort({ sortBy: first as TaskSortBy }));
            else await store().updateSettings({ taskSortBy: first as TaskSortBy });
        } else if (actionKind === 'collapse') {
            const ids = session.collapsed[session.groupBy] ?? [];
            session.collapsed[session.groupBy] = ids.includes(first as string)
                ? ids.filter((id) => id !== first)
                : [...ids, first as string];
        } else if (actionKind === 'includeArchived') session.includeArchived = first as boolean;
        else if (actionKind === 'filter') applyFilterEdit(filterEditOf(action));
        else if (actionKind === 'clearFilters') applyFilterEdit({ type: 'clear' });
        else if (actionKind === 'clearChip') {
            if (first === REFERENCE_ARCHIVED_CHIP_ID) session.includeArchived = false;
            else {
                const chip = contract
                    ? read().chips.find((entry) => entry.id === first)!.action as { filterEdit: ListFilterEdit }
                    : { filterEdit: coreModel().resolved.chips.find((entry) => entry.id === first)!.edit };
                applyFilterEdit(chip.filterEdit);
            }
        } else {
            throw new Error(`Unknown action ${actionKind}`);
        }
        push(observe());
    }
    return observations;
}
