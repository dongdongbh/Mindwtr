/**
 * Test support only (imported by the list views tests; not exported).
 * Replays the frozen React Native Contexts, Archive, Trash and History scenarios
 * (list-views-model-parity.fixtures.json, captured by the mobile *.parity tests
 * and history.test.tsx) through core: either core's functions directly, or the
 * native host contract. A backend builds one screen model; `observe*` turns it
 * into the fixture's shape, so both backends are held to the same observations.
 * Selection mode, the open picker or dialog and the view options are host UI
 * state and are kept here, as the React Native hooks keep them.
 */
import { readFileSync } from 'node:fs';
import {
    ARCHIVE_SEGMENTS,
    buildArchiveTaskItems,
    filterArchivedTasksByArea,
    getArchiveConfirmation,
    getArchivedProjectRow,
    getArchivedTaskRow,
    getArchiveEmptyState,
    getArchiveMenu,
    getArchiveRowLabels,
    getArchiveSegmentLabel,
    getArchiveSummary,
    getArchiveTokenFilterOptions,
    getHistoryTabs,
    getTaskGroupItemIds,
    moveArchivedTasksToInbox,
    moveArchivedTaskToInbox,
    reactivateArchivedProject,
    resolveArchiveSortBy,
    resolveHistoryTab,
    selectArchivedProjects,
    selectArchivedTasks,
    setArchivedTaskCompletedAt,
    showArchiveSearch,
    sortArchivedTasks,
    type ArchiveMenu,
    type ArchiveSegment,
    type ArchiveTaskGroupBy,
} from './archive-view-model';
import { collectBulkTaskTokens, type BulkTaskTokenField, type BulkTaskTokenMode } from './bulk-task-tokens';
import { formatTimeEstimateLabel } from './calendar-scheduling';
import {
    buildContextsTokenIndex,
    buildContextsViewModel,
    CONTEXTS_BULK_STATUSES,
    editContextsTaskTokens,
    getContextsEmptyState,
    getContextsMatchModeLabels,
    getContextsTokenPicker,
    getContextsTokenPickerTitle,
    getContextsRouteTokens,
    resolveContextsMatchMode,
    selectContextsRouteTokens,
    toggleContextsNoContext,
    toggleContextsToken,
} from './contexts-view-model';
import { safeFormatDate } from './date';
import { countActiveFilterCriteria, criteriaFromSelections } from './filter-criteria';
import type { ContextOrTagMatchMode } from './hierarchy-utils';
import { tFallback } from './i18n';
import { getListSearchChipLabel } from './list-filter-state';
import { getProjectAccentColor } from './task-accent-color';
import { formatListItemCount } from './list-count';
import { getInlineMarkdownPreview } from './markdown';
import type { createNativeHostContract, NativeArchiveAction, NativeContextsAction, NativeListActionResult, NativeTrashAction } from './native-host-contract';
import { updateRangeSelection } from './range-selection';
import { resolveFeatureFlags } from './resolve-feature-flags';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { taskMatchesFilterSelections } from './task-filter-selections';
import type { TaskGroupItem } from './task-group-sections';
import { getTaskMetadataFilterVisibility, type TaskMetadataFilterVisibility } from './task-metadata-filter-visibility';
import { isTaskVisibleInArea, resolveAreaFilterSelection } from './area-filter';
import { buildTrashTimeline, resolveTrashClearScope } from './task-utils';
import {
    formatTrashCounts,
    getTrashUndoLabel,
    formatTrashDeletedDate,
    getBulkTrashConfirmation,
    getTrashEmptyState,
    getTrashPurgeConfirmation,
    getTrashRetentionHint,
    getTrashRowLabels,
    purgeTrashItems,
    restoreTrashItems,
    selectTrashedProjects,
    selectTrashedTasks,
    type ListConfirmation,
} from './trash-view-model';
import type { AppSettings, Area, Project, Task, TaskEnergyLevel, TaskPriority, TaskSortBy, TaskStatus, TimeEstimate } from './types';

type Translate = (key: string) => string;
type Host = ReturnType<typeof createNativeHostContract>;
export type ListViewsScenario = {
    name: string;
    settings: string;
    taskIds?: string[];
    projectIds?: string[];
    route?: { token?: string | string[] };
    stored?: { groupBy?: ArchiveTaskGroupBy; sortBy?: TaskSortBy };
    actions: unknown[][];
};
export type ListViewsPart = {
    timeZone: string;
    now: string;
    tasks: Task[];
    projects: Project[];
    areas: Area[];
    settings: Record<string, AppSettings>;
    scenarios: ListViewsScenario[];
    observations: Record<string, Record<string, unknown>[]>;
};
export type ListViewsFixture = {
    provenance: Record<string, unknown>;
    contexts: ListViewsPart;
    archive: ListViewsPart;
    trash: ListViewsPart;
    history: { observations: { tab: string | null; opened: unknown; switched: unknown }[] };
};

export const loadListViewsFixture = (): ListViewsFixture => JSON.parse(
    readFileSync(new URL('./list-views-model-parity.fixtures.json', import.meta.url), 'utf8'),
);

const RECORDED = [
    'updateTask', 'deleteTask', 'restoreTask', 'restoreTasks', 'restoreProject', 'purgeTask', 'purgeTasks', 'purgeProject',
    'batchMoveTasks', 'batchDeleteTasks', 'batchUpdateTasks', 'updateProject', 'deleteProject',
] as const;
type StoreActions = Record<(typeof RECORDED)[number], (...args: unknown[]) => Promise<unknown>>;
let realActions: StoreActions | null = null;

/** The store writes a scenario asks for, encoded as the mobile capture encoded them. */
export function createWriteRecorder() {
    const log: unknown[][] = [];
    const encode = (args: unknown[]) => JSON.parse(JSON.stringify(args.map((arg) => (
        arg && typeof arg === 'object' && !Array.isArray(arg)
            ? Object.fromEntries(Object.entries(arg).map(([key, value]) => [key, value === undefined ? '<undefined>' : value]))
            : arg
    )), (_key, value) => (value === undefined ? '<undefined>' : value))) as unknown[];
    return { log, encode };
}
export type WriteRecorder = ReturnType<typeof createWriteRecorder>;

/** Load the scenario's data through the store, as the mobile capture did, and record the screens' writes. */
export async function seedListViewsStore(
    part: ListViewsPart,
    scenario: ListViewsScenario,
    recorder: WriteRecorder,
    adapter: { saveData?: (data: unknown) => Promise<void> } = {},
): Promise<void> {
    await flushPendingSave();
    resetForTests();
    const initial = useTaskStore.getState() as unknown as StoreActions;
    realActions ??= Object.fromEntries(RECORDED.map((name) => [name, initial[name]])) as StoreActions;
    const real = realActions;
    const tasks = scenario.taskIds ? part.tasks.filter((task) => scenario.taskIds!.includes(task.id)) : part.tasks;
    const projects = scenario.projectIds ? part.projects.filter((project) => scenario.projectIds!.includes(project.id)) : part.projects;
    let data = JSON.parse(JSON.stringify({ tasks, projects, sections: [], areas: part.areas, people: [], settings: part.settings[scenario.settings] }));
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
        highlightTaskId: null,
    } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    // Only the screens' own calls: batchMoveTasks calls batchUpdateTasks inside the store.
    let moving = 0;
    useTaskStore.setState(Object.fromEntries(RECORDED.map((name) => [name, async (...args: unknown[]) => {
        if (!(name === 'batchUpdateTasks' && moving > 0)) recorder.log.push([name, ...recorder.encode(args)]);
        if (name !== 'batchMoveTasks') return real[name](...args);
        moving += 1;
        try {
            return await real[name](...args);
        } finally {
            moving -= 1;
        }
    }])) as never);
}

type Dialog = { title: string; message: string; buttons: { text: string; style: string; run?: () => Promise<void> }[] };
type Toast = { tone: string; title: string | null; message: string; actionLabel: string | null; undo?: () => Promise<void> };
const dialog = (confirmation: ListConfirmation, run: () => Promise<void>): Dialog => ({
    title: confirmation.title,
    message: confirmation.message,
    buttons: [{ text: confirmation.cancelLabel, style: 'cancel' }, { text: confirmation.confirmLabel, style: 'destructive', run }],
});
const expectOk = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const WINDOW = { offset: 0, limit: 100 };
const areaScope = () => {
    const state = useTaskStore.getState();
    const areas = [...state.areas].filter((area) => !area.deletedAt)
        .sort((a, b) => (a.order !== b.order ? a.order - b.order : a.name.localeCompare(b.name)));
    return {
        state,
        areaById: new Map(areas.map((area) => [area.id, area])),
        projectById: new Map(state.projects.map((project) => [project.id, project])),
        selection: resolveAreaFilterSelection(state.settings.filters, areas),
    };
};

/** A replay: the observation after opening, then after each action. */
async function replay<Screen>(
    screen: Screen & { observe: () => Record<string, unknown>; settle?: () => void },
    perform: (screen: Screen, action: unknown[]) => Promise<void>,
    actions: unknown[][],
    recorder: WriteRecorder,
) {
    let writes = 0;
    const observe = () => {
        screen.settle?.();
        const observation = { ...screen.observe(), writes: recorder.log.slice(writes) };
        writes = recorder.log.length;
        return observation;
    };
    const observed = [observe()];
    for (const action of actions) {
        await perform(screen, action);
        await flushPendingSave();
        observed.push(observe());
    }
    return observed;
}

// --- Contexts --------------------------------------------------------------

type ContextsModel = {
    chips: [string, boolean, string[]][];
    matchMode: [string, [string, boolean][]] | null;
    rowIds: string[];
    empty: [string, string, string] | null;
    bulk: { exit: string; statuses: { status: TaskStatus; label: string }[]; tokens: { field: BulkTaskTokenField; mode: BulkTaskTokenMode; label: string; enabled: boolean }[]; delete: string } | null;
    picker: (field: BulkTaskTokenField, mode: BulkTaskTokenMode) => { title: string; tokens: string[]; placeholder: string; allowCustomValue: boolean; multiSelect: boolean };
    deleteConfirmation: ListConfirmation;
};
type ContextsBackend = {
    model: (state: ContextsState) => ContextsModel;
    run: (write: ContextsWrite) => Promise<Toast | null>;
};
type ContextsWrite =
    | { type: 'setTaskStatus'; taskId: string; status: TaskStatus }
    | { type: 'trashTask'; taskId: string }
    | { type: 'moveTasks'; taskIds: string[]; status: TaskStatus }
    | { type: 'editTaskTokens'; taskIds: string[]; field: BulkTaskTokenField; mode: BulkTaskTokenMode; values: string[] }
    | { type: 'trashTasks'; taskIds: string[] }
    | { type: 'restoreTasks'; taskIds: string[] };
type ContextsState = {
    tokens: string[];
    matchMode: ContextOrTagMatchMode;
    searchQuery: string;
    selected: string[];
    selectionMode: boolean;
    picker: { field: BulkTaskTokenField; mode: BulkTaskTokenMode } | null;
    editor: string | null;
    dialogs: Dialog[];
    toasts: Toast[];
};
const ICONS = { tag: 'Icon:Tag', check: 'Icon:CheckCircle2' } as const;

/** Contexts through core's functions, as the React Native screen calls them. */
export function createContextsCoreBackend(t: Translate): ContextsBackend {
    return {
        model(state) {
            const { state: store, areaById, projectById, selection } = areaScope();
            const visibleTasks = store.tasks.filter((task) => isTaskVisibleInArea(task, { areaById, projectById, resolvedAreaFilter: selection }));
            const model = buildContextsViewModel({ index: buildContextsTokenIndex(visibleTasks), settings: store.settings, selectedTokens: state.tokens, matchMode: state.matchMode, searchQuery: state.searchQuery });
            const labels = getContextsMatchModeLabels(t);
            const tasksById = Object.fromEntries(store.tasks.map((task) => [task.id, task]));
            const empty = getContextsEmptyState({ hasTokens: model.hasTokens, selectedTokens: state.tokens }, t);
            return {
                chips: [
                    [t('contexts.all'), state.tokens.length === 0, [t('common.all'), String(model.allCount)]],
                    [t('contexts.none'), model.noContextSelected, [t('contexts.none'), String(model.noContextCount)]],
                    ...model.tokenChips.map((chip): [string, boolean, string[]] => [`${chip.token} (${chip.count})`, chip.selected, [chip.token, String(chip.count)]]),
                ],
                matchMode: model.showMatchMode
                    ? [labels.label, [[labels.all, state.matchMode === 'all'], [labels.any, state.matchMode === 'any']]]
                    : null,
                rowIds: model.tasks.map((task) => task.id),
                empty: [ICONS[empty.icon], empty.title, empty.message],
                bulk: {
                    exit: t('bulk.exitSelect'),
                    statuses: CONTEXTS_BULK_STATUSES.map((status) => ({ status, label: t(`status.${status}`) })),
                    tokens: (['tags', 'contexts'] as const).flatMap((field) => (['add', 'remove'] as const).map((mode) => ({
                        field, mode, label: getContextsTokenPickerTitle(field, mode, t),
                        enabled: mode === 'add' || collectBulkTaskTokens(state.selected, tasksById, field).length > 0,
                    }))),
                    delete: t('common.delete'),
                },
                picker: (field, mode) => getContextsTokenPicker({ field, action: mode, activeTasks: model.activeTasks, selectedIds: state.selected, tasksById, t }),
                deleteConfirmation: getBulkTrashConfirmation(t),
            };
        },
        async run(write) {
            const store = useTaskStore.getState();
            const done = (count: number): Toast => ({ tone: 'success', title: t('common.done'), message: formatListItemCount(count, 'task', t), actionLabel: null });
            switch (write.type) {
                case 'setTaskStatus': await store.updateTask(write.taskId, { status: write.status }); return null;
                case 'trashTask': await store.deleteTask(write.taskId); return null;
                case 'moveTasks': await store.batchMoveTasks(write.taskIds, write.status); return done(write.taskIds.length);
                case 'editTaskTokens': {
                    const tasksById = Object.fromEntries(store.tasks.map((task) => [task.id, task]));
                    const outcome = await editContextsTaskTokens(store, { ...write, tasksById });
                    return outcome.changed ? done(outcome.count) : null;
                }
                case 'trashTasks': {
                    await store.batchDeleteTasks(write.taskIds);
                    const undo = async () => { await Promise.all(write.taskIds.map((id) => useTaskStore.getState().restoreTask(id))); };
                    return { ...done(write.taskIds.length), actionLabel: getTrashUndoLabel(t), undo };
                }
                case 'restoreTasks': await Promise.all(write.taskIds.map((id) => useTaskStore.getState().restoreTask(id))); return null;
            }
        },
    };
}

/** Contexts through the native host contract: views from getContextsView, writes through runContextsAction. */
export function createContextsContractBackend(host: Host, requestId: () => string): ContextsBackend {
    const toToast = (result: NativeListActionResult<NativeContextsAction>): Toast | null => {
        const toast = result.toast;
        if (!toast) return null;
        const undo = toast.undo;
        return {
            tone: toast.tone, title: toast.title, message: toast.message, actionLabel: undo?.label ?? null,
            undo: undo ? async () => { expectOk(await host.runContextsAction({ requestId: requestId(), action: undo.action })); } : undefined,
        };
    };
    return {
        model(state) {
            const view = expectOk(host.getContextsView({
                tokens: state.tokens, matchMode: state.matchMode, searchQuery: state.searchQuery, selectedIds: state.selected, ...WINDOW,
            }));
            const pickers = view.bulk?.tokenActions ?? [];
            return {
                chips: view.chips.map((chip): [string, boolean, string[]] => [chip.accessibilityLabel, chip.selected, [chip.label, String(chip.count)]]),
                matchMode: view.matchMode ? [view.matchMode.label, view.matchMode.options.map((option): [string, boolean] => [option.label, option.selected])] : null,
                rowIds: view.rows.map((row) => row.id),
                empty: view.empty ? [ICONS[view.empty.icon], view.empty.title, view.empty.message] : null,
                bulk: view.bulk ? {
                    exit: view.bulk.exitLabel,
                    statuses: view.bulk.statuses,
                    tokens: view.bulk.tokenActions.map(({ field, mode, title, enabled }) => ({ field, mode, label: title, enabled })),
                    delete: view.bulk.deleteLabel,
                } : null,
                picker: (field, mode) => {
                    const { title, tokens, placeholder, allowCustomValue, multiSelect } = pickers.find((entry) => entry.field === field && entry.mode === mode)!;
                    return { title, tokens, placeholder, allowCustomValue, multiSelect };
                },
                deleteConfirmation: view.bulk?.deleteConfirmation ?? { title: '', message: '', cancelLabel: '', confirmLabel: '' },
            };
        },
        async run(write) {
            const result = expectOk(await host.runContextsAction({ requestId: requestId(), action: write as NativeContextsAction }));
            // The row's own toast (Task deleted, Undo) belongs to the shared row; the capture mocked the row.
            return write.type === 'trashTask' ? null : toToast(result);
        },
    };
}

export async function replayContexts(backend: ContextsBackend, scenario: ListViewsScenario, recorder: WriteRecorder) {
    const requested = getContextsRouteTokens(scenario.route?.token);
    const state: ContextsState = {
        tokens: requested.length > 0 ? selectContextsRouteTokens(requested) : [],
        matchMode: 'all', searchQuery: '', selected: [], selectionMode: false, picker: null, editor: null, dialogs: [], toasts: [],
    };
    let current = backend.model(state);
    let seenDialogs = 0;
    let seenToasts = 0;
    const exitSelection = () => { state.selectionMode = false; state.selected = []; };
    const screen = {
        settle() {
            // The screen's effects: an empty selection matches with All; rows that leave take their selection with them.
            state.matchMode = resolveContextsMatchMode(state.tokens, state.matchMode);
            current = backend.model(state);
            state.selected = state.selected.filter((id) => current.rowIds.includes(id));
            if (state.selectionMode && state.selected.length === 0) exitSelection();
            current = backend.model(state);
        },
        observe() {
            const picker = state.picker ? current.picker(state.picker.field, state.picker.mode) : null;
            const bulk = state.selectionMode && current.bulk ? [
                [current.bulk.exit, false],
                ...current.bulk.statuses.map(({ label }) => [label, false]),
                ...current.bulk.tokens.map(({ label, enabled }) => [label, !enabled]),
                [current.bulk.delete, false],
            ] : null;
            const observation = {
                search: state.searchQuery,
                chips: current.chips,
                matchMode: current.matchMode,
                rows: current.rowIds.map((id) => [id, state.selected.includes(id)]),
                selectionMode: current.rowIds.length > 0 ? state.selectionMode : null,
                empty: current.rowIds.length === 0 ? current.empty : null,
                bulk,
                picker: picker ? { title: picker.title, description: picker.title, tokens: picker.tokens, placeholder: picker.placeholder, allowCustomValue: picker.allowCustomValue, multiSelect: picker.multiSelect } : null,
                editor: state.editor,
                alerts: state.dialogs.slice(seenDialogs).map((entry) => [entry.title, entry.message, entry.buttons.map((button) => [button.text, button.style])]),
                toasts: state.toasts.slice(seenToasts).map((toast) => [toast.tone, toast.title, toast.message, toast.actionLabel]),
            };
            seenDialogs = state.dialogs.length;
            seenToasts = state.toasts.length;
            return observation;
        },
    };
    const toast = (entry: Toast | null) => { if (entry) state.toasts.push(entry); };
    return replay(screen, async (_screen, action) => {
        const [kind, first, second, third] = action as [string, string, string, unknown];
        if (kind === 'search') state.searchQuery = first;
        else if (kind === 'chip') {
            if (first === t_all) { state.tokens = []; state.matchMode = 'all'; }
            else if (first === t_none) { state.tokens = toggleContextsNoContext(state.tokens); state.matchMode = 'all'; }
            else state.tokens = toggleContextsToken(state.tokens, first);
        } else if (kind === 'matchMode') state.matchMode = first as ContextOrTagMatchMode;
        else if (kind === 'row') {
            if (second === 'edit') state.editor = first;
            if (second === 'remove') toast(await backend.run({ type: 'trashTask', taskId: first }));
            if (second === 'toggleSelect') {
                state.selectionMode = true;
                state.selected = Array.from(updateRangeSelection({ anchorId: null, selectedIds: new Set(state.selected), targetId: first, visibleIds: [] }).selectedIds);
            }
            if (second === 'changeStatus') toast(await backend.run({ type: 'setTaskStatus', taskId: first, status: third as TaskStatus }));
        } else if (kind === 'rowToken') { state.tokens = [first]; state.matchMode = 'all'; }
        else if (kind === 'editorNavigate') state.tokens = [second];
        else if (kind === 'bulk') {
            const bulk = current.bulk!;
            const labels = [bulk.exit, ...bulk.statuses.map(({ label }) => label), ...bulk.tokens.map(({ label }) => label), bulk.delete];
            const index = labels.map((label, position) => [label, position] as const).filter(([label]) => label === first)[(second as unknown as number) ?? 0][1];
            if (index === 0) exitSelection();
            else if (index <= bulk.statuses.length) {
                toast(await backend.run({ type: 'moveTasks', taskIds: [...state.selected], status: bulk.statuses[index - 1].status }));
                exitSelection();
            } else if (index < labels.length - 1) {
                const { field, mode } = bulk.tokens[index - 1 - bulk.statuses.length];
                state.picker = { field, mode };
            } else {
                const taskIds = [...state.selected];
                state.dialogs.push(dialog(current.deleteConfirmation, async () => {
                    const entry = await backend.run({ type: 'trashTasks', taskIds });
                    exitSelection();
                    toast(entry);
                }));
            }
        } else if (kind === 'picker') {
            const picker = state.picker!;
            state.picker = null;
            if (first === 'confirm') {
                const entry = await backend.run({ type: 'editTaskTokens', taskIds: [...state.selected], field: picker.field, mode: picker.mode, values: second as unknown as string[] });
                if (entry) { exitSelection(); toast(entry); }
            }
        } else if (kind === 'alert') await state.dialogs[state.dialogs.length - 1].buttons.find((button) => button.text === first)?.run?.();
        else if (kind === 'toastAction') await state.toasts[state.toasts.length - 1].undo!();
        else throw new Error(`Unknown Contexts action ${kind}`);
    }, scenario.actions, recorder);
}
// The capture presses All and No context by their labels.
const t_all = 'All Contexts';
const t_none = 'No context';

// --- Archive ---------------------------------------------------------------

type FilterState = {
    searchQuery: string; tokens: string[]; excludedTokens: string[];
    priorities: TaskPriority[]; energyLevels: TaskEnergyLevel[]; timeEstimates: TimeEstimate[]; location: string;
};
const NO_FILTERS: FilterState = { searchQuery: '', tokens: [], excludedTokens: [], priorities: [], energyLevels: [], timeEstimates: [], location: '' };
type ArchiveState = {
    segment: ArchiveSegment;
    groupBy: ArchiveTaskGroupBy;
    sortBy: TaskSortBy | undefined;
    filters: FilterState;
    filtersVisible: boolean;
    collapsed: Record<string, string[]>;
    selectionMode: boolean;
    selected: string[];
    editor: string | null;
    completedAt: string | null;
};
type ArchiveTaskItem = { type: 'task'; id: string; title: string; groupId: string | null; cancelled: boolean; dateLabel: string; markdown: string | null; completedAtValue: string | null };
type ArchiveModel = {
    segmentLabels: string[];
    search: { query: string; placeholder: string } | null;
    menu: ArchiveMenu;
    filters: { activeCount: number; chips: { id: string; label: string; excluded: boolean }[]; visibility: TaskMetadataFilterVisibility; tokenOptions: string[] };
    summary: string | null;
    items: (
        | { type: 'section'; id: string; title: string; count: number; collapsible: boolean; collapsed: boolean }
        | ArchiveTaskItem
        | { type: 'project'; id: string; title: string; cancelled: boolean; dateLabel: string; areaName: string | null; indicatorColor: string | null; confirmation: ListConfirmation }
    )[];
    visibleIds: string[];
    empty: { title: string; message: string; clearLabel: string | null } | null;
    labels: ReturnType<typeof getArchiveRowLabels> & { selectAll: string; restoreSelected: string; done: string; bulkSelected: string };
    confirmations: { trashTask: ListConfirmation; trashTasks: ListConfirmation };
};
type ArchiveBackend = {
    model: (state: ArchiveState) => ArchiveModel;
    /** Mobile's writes: explicit ids and ISO completion times (the contract's selectAll and day/time forms have their own tests). */
    run: (write: Exclude<NativeArchiveAction, { selectAll: unknown } | { day: string }>) => Promise<Toast | null>;
};

/** The filter sheet's selections as mobile's hook turns them into criteria, chips and a count. */
function resolveHookFilters(filters: FilterState, visibility: TaskMetadataFilterVisibility, t: Translate) {
    const priorities = visibility.priority ? filters.priorities : [];
    const energyLevels = visibility.energyLevel ? filters.energyLevels : [];
    const timeEstimates = visibility.timeEstimate ? filters.timeEstimates : [];
    const location = visibility.location ? filters.location.trim() : '';
    const criteria = criteriaFromSelections({
        tokens: filters.tokens, excludedTokens: filters.excludedTokens, projects: [], locations: location ? [location] : [],
        priorities, energyLevels, timeEstimates, contextMatchMode: 'all', tagMatchMode: 'all',
    });
    const search = filters.searchQuery.trim();
    return {
        criteria,
        activeCount: (search ? 1 : 0) + countActiveFilterCriteria(criteria),
        chips: [
            ...(search ? [{ id: 'search', label: getListSearchChipLabel(search, t), excluded: false }] : []),
            ...filters.tokens.map((token) => ({ id: `token:${token}`, label: token, excluded: false })),
            ...filters.excludedTokens.map((token) => ({ id: `excluded-token:${token}`, label: token, excluded: true })),
            ...priorities.map((value) => ({ id: `priority:${value}`, label: t(`priority.${value}`), excluded: false })),
            ...energyLevels.map((value) => ({ id: `energy:${value}`, label: t(`energyLevel.${value}`), excluded: false })),
            ...timeEstimates.map((value) => ({ id: `time:${value}`, label: formatTimeEstimateLabel(value), excluded: false })),
            ...(location ? [{ id: 'location', label: `${tFallback(t, 'taskEdit.locationLabel', 'Location')}: ${location}`, excluded: false }] : []),
        ],
    };
}

/** Archive through core's functions, as the React Native screen calls them. */
export function createArchiveCoreBackend(t: Translate): ArchiveBackend {
    return {
        model(state) {
            const { state: store, areaById, projectById, selection } = areaScope();
            const sortBy = resolveArchiveSortBy(state.sortBy, store.settings);
            const allArchived = filterArchivedTasksByArea(sortArchivedTasks(selectArchivedTasks(store._allTasks), sortBy), selection, projectById, areaById);
            const flags = resolveFeatureFlags(store.settings);
            const visibility = getTaskMetadataFilterVisibility(allArchived, { prioritiesEnabled: flags.priorities, timeEstimatesEnabled: flags.timeEstimates });
            const filters = resolveHookFilters(state.filters, visibility, t);
            const archivedTasks = allArchived.filter((task) => taskMatchesFilterSelections(task, { criteria: filters.criteria, searchQuery: state.filters.searchQuery }));
            const taskItems = buildArchiveTaskItems({
                groupBy: state.groupBy, tasks: archivedTasks, areas: store.areas, projectById, t,
                collapsedGroupIds: new Set(state.collapsed[state.groupBy] ?? []),
            });
            const projects = selectArchivedProjects(store.projects, selection, areaById);
            const labels = getArchiveRowLabels(t);
            const hasActive = filters.activeCount > 0;
            const shown = state.segment === 'tasks' ? archivedTasks.length : projects.length;
            const toTask = (entry: TaskGroupItem): ArchiveModel['items'][number] => {
                if (entry.type === 'section') {
                    return { type: 'section', id: entry.id, title: entry.title, count: entry.count, collapsible: entry.collapsible === true, collapsed: entry.collapsed === true };
                }
                const row = getArchivedTaskRow(entry.task, safeFormatDate, labels.notSet);
                return {
                    type: 'task', id: entry.task.id, title: entry.task.title, groupId: entry.groupId ?? null, cancelled: row.cancelled,
                    dateLabel: `${row.cancelled ? labels.taskCancelled : labels.completed}: ${row.dateLabel}`,
                    markdown: entry.task.description ? getInlineMarkdownPreview(entry.task.description) : null,
                    completedAtValue: entry.task.completedAt || entry.task.updatedAt,
                };
            };
            const items = state.segment === 'tasks' ? taskItems.map(toTask) : projects.map((project) => {
                const row = getArchivedProjectRow(project, safeFormatDate, areaById, labels.notSet);
                return {
                    type: 'project' as const, id: project.id, title: project.title, cancelled: row.cancelled,
                    dateLabel: `${row.cancelled ? labels.projectCancelled : labels.completed}: ${row.dateLabel}`,
                    areaName: project.areaId ? areaById.get(project.areaId)?.name ?? null : null,
                    indicatorColor: row.indicatorColor ?? null,
                    confirmation: getArchiveConfirmation({ kind: 'project', project }, t),
                };
            });
            return {
                segmentLabels: ARCHIVE_SEGMENTS.map((segment) => getArchiveSegmentLabel(segment, t)),
                search: showArchiveSearch(state.segment, allArchived.length, hasActive)
                    ? { query: state.filters.searchQuery, placeholder: tFallback(t, 'common.search', 'Search') }
                    : null,
                menu: getArchiveMenu({ sortBy, groupBy: state.groupBy, settings: store.settings }, t),
                filters: {
                    activeCount: filters.activeCount, chips: filters.chips, visibility,
                    tokenOptions: getArchiveTokenFilterOptions(allArchived, state.filtersVisible, state.filters),
                },
                summary: getArchiveSummary(state.segment, shown, t),
                items,
                visibleIds: getTaskGroupItemIds(taskItems),
                empty: items.length === 0
                    ? getArchiveEmptyState({ segment: state.segment, hasActiveFilters: hasActive, filterChipLabels: filters.chips.map((chip) => chip.label) }, t)
                    : null,
                labels: {
                    ...labels,
                    selectAll: `${tFallback(t, 'bulk.select', 'Select')} ${tFallback(t, 'common.all', 'all')}`,
                    restoreSelected: t('trash.restoreToInbox'),
                    done: tFallback(t, 'common.done', 'Done'),
                    bulkSelected: t('bulk.selected'),
                },
                confirmations: { trashTask: getArchiveConfirmation({ kind: 'task' }, t), trashTasks: getBulkTrashConfirmation(t) },
            };
        },
        async run(write) {
            const store = useTaskStore.getState();
            switch (write.type) {
                case 'moveToInbox': await moveArchivedTaskToInbox(store, write.taskId); return null;
                case 'moveTasksToInbox': await moveArchivedTasksToInbox(store, write.taskIds); return null;
                case 'setCompletedAt': await setArchivedTaskCompletedAt(store, write.taskId, write.completedAt); return null;
                case 'trashTask': await store.deleteTask(write.taskId); return null;
                case 'reactivateProject': await reactivateArchivedProject(store, write.projectId); return null;
                case 'trashProject': await store.deleteProject(write.projectId); return null;
                case 'restoreTasks': await Promise.all(write.taskIds.map((id) => useTaskStore.getState().restoreTask(id))); return null;
                case 'trashTasks': {
                    await store.batchDeleteTasks(write.taskIds);
                    return {
                        tone: 'success', title: t('common.done'), message: formatListItemCount(write.taskIds.length, 'task', t),
                        actionLabel: getTrashUndoLabel(t),
                        undo: async () => { await Promise.all(write.taskIds.map((id) => useTaskStore.getState().restoreTask(id))); },
                    };
                }
            }
        },
    };
}

/** Archive through the native host contract. */
export function createArchiveContractBackend(host: Host, requestId: () => string): ArchiveBackend {
    return {
        model(state) {
            const view = expectOk(host.getArchiveView({
                segment: state.segment, sortBy: state.sortBy, groupBy: state.groupBy,
                filters: { ...state.filters }, filterSheetOpen: state.filtersVisible,
                collapsedGroupIds: state.collapsed[state.groupBy] ?? [], selectedIds: state.selected, ...WINDOW,
            }));
            return {
                segmentLabels: view.segments.map((segment) => segment.label),
                search: view.search,
                menu: view.menu,
                filters: { activeCount: view.filters.activeCount, chips: view.filters.chips, visibility: view.filters.visibility, tokenOptions: view.filters.tokenOptions },
                summary: view.summary,
                items: view.items.map((item) => (
                    item.type === 'task'
                        ? {
                            type: 'task' as const, id: item.row.id, title: item.row.title, groupId: item.groupId, cancelled: item.cancelled,
                            dateLabel: item.dateLabel, markdown: item.descriptionMarkdown, completedAtValue: item.completedAtValue,
                        }
                        : item.type === 'project'
                            ? { ...item, confirmation: item.trashConfirmation }
                            : item
                )),
                // The contract counts the ids; Select all pages through the rows.
                visibleIds: view.items.flatMap((item) => (item.type === 'task' ? [item.row.id] : [])).filter((id, index, ids) => ids.indexOf(id) === index),
                empty: view.empty,
                labels: { ...view.labels, bulkSelected: view.labels.selected.replace(/^\d+ /, '') },
                confirmations: view.confirmations,
            };
        },
        async run(write) {
            const result = expectOk(await host.runArchiveAction({ requestId: requestId(), action: write }));
            const toast = result.toast;
            if (!toast) return null;
            const undo = toast.undo;
            return {
                tone: toast.tone, title: toast.title, message: toast.message, actionLabel: undo?.label ?? null,
                undo: undo ? async () => { expectOk(await host.runArchiveAction({ requestId: requestId(), action: undo.action })); } : undefined,
            };
        },
    };
}

export async function replayArchive(backend: ArchiveBackend, scenario: ListViewsScenario, recorder: WriteRecorder, t: Translate) {
    const state: ArchiveState = {
        segment: 'tasks', groupBy: scenario.stored?.groupBy ?? 'none', sortBy: scenario.stored?.sortBy,
        filters: { ...NO_FILTERS }, filtersVisible: false, collapsed: {}, selectionMode: false, selected: [], editor: null, completedAt: null,
    };
    const dialogs: Dialog[] = [];
    const toasts: Toast[] = [];
    let seenDialogs = 0;
    let seenToasts = 0;
    let current = backend.model(state);
    const exitSelection = () => { state.selectionMode = false; state.selected = []; };
    const screen = {
        settle() {
            current = backend.model(state);
            // The hook drops selections a section no longer justifies; rows a filter or fold hides leave the selection.
            const { visibility } = current.filters;
            if (!visibility.priority) state.filters.priorities = [];
            if (!visibility.energyLevel) state.filters.energyLevels = [];
            if (!visibility.timeEstimate) state.filters.timeEstimates = [];
            if (!visibility.location) state.filters.location = '';
            current = backend.model(state);
            state.selected = state.selected.filter((id) => current.visibleIds.includes(id));
            const edited = state.editor ? useTaskStore.getState()._tasksById.get(state.editor) : undefined;
            if (state.editor && (!edited || edited.deletedAt)) state.editor = null;
            current = backend.model(state);
        },
        observe() {
            const labels = current.labels;
            const hasActive = current.filters.activeCount > 0;
            const filtersLabel = `${current.menu.filtersLabel} · ${current.filters.activeCount}`;
            const header: string[] = [...current.segmentLabels];
            if (current.search && hasActive) header.push(filtersLabel);
            if (state.segment === 'tasks' && current.summary) header.push(current.summary, state.selectionMode ? labels.done : labels.select);
            if (state.segment === 'projects' && current.summary) header.push(current.summary);
            const bulk = state.segment === 'tasks' && state.selectionMode;
            if (bulk) header.push(`${state.selected.length} ${labels.bulkSelected}`, labels.selectAll, labels.restoreSelected, labels.delete);
            const items = current.items.map((item) => {
                if (item.type === 'section') return ['section', item.id, [item.title, String(item.count)], !item.collapsible, !item.collapsed];
                if (item.type === 'project') {
                    return [
                        `Open archived project: ${item.title}`, null,
                        [item.title, item.dateLabel, ...(item.areaName ? [item.areaName] : [])],
                        !item.cancelled, null, item.indicatorColor, null,
                    ];
                }
                return [
                    state.selectionMode ? `${labels.select} ${item.title}` : `Open archived task details: ${item.title}`,
                    state.selectionMode ? { selected: state.selected.includes(item.id) } : null,
                    [item.title, item.dateLabel],
                    !item.cancelled, item.markdown, '#6B7280',
                    item.cancelled ? null : [labels.editCompletedAt, state.selectionMode],
                ];
            });
            const menu = current.menu;
            const observation = {
                segments: ARCHIVE_SEGMENTS.map((segment, index) => [current.segmentLabels[index], segment === state.segment]),
                search: current.search ? [current.search.query, current.search.placeholder] : null,
                filtersButton: current.search && hasActive ? filtersLabel : null,
                menu: current.search ? [
                    ['filters', menu.filtersLabel, null, null, hasActive, null],
                    ['sort', menu.sort.label, `${menu.sort.label}: ${menu.sort.value}`, menu.sort.value, false,
                        [menu.sort.label, menu.sort.options.map((option) => [`sort:${option.id}`, option.label, `${menu.sort.label}: ${option.label}`, option.selected])]],
                    ['group', menu.group.label, `${menu.group.label}: ${menu.group.value}`, menu.group.value, false,
                        [menu.group.label, menu.group.options.map((option) => [`group:${option.id}`, option.label, `${menu.group.label}: ${option.label}`, option.selected])]],
                ] : null,
                header,
                bulkButtons: bulk ? [
                    [labels.selectAll, current.visibleIds.length === 0 || state.selected.length === current.visibleIds.length],
                    [labels.restoreSelected, state.selected.length === 0],
                    [labels.delete, state.selected.length === 0],
                ] : [],
                items,
                empty: items.length > 0 || !current.empty ? null
                    : ['Icon:Archive', current.empty.title, current.empty.message, ...(current.empty.clearLabel ? [current.empty.clearLabel] : [])],
                filterSheet: {
                    visible: state.filtersVisible,
                    tokens: current.filters.tokenOptions,
                    visibility: current.filters.visibility,
                    activeCount: current.filters.activeCount,
                    chips: current.filters.chips.map((chip) => [chip.id, chip.label, chip.excluded]),
                },
                editor: state.editor,
                completedAtPicker: state.completedAt ? (() => {
                    const task = useTaskStore.getState()._allTasks.find((entry) => entry.id === state.completedAt);
                    return task ? task.completedAt || task.updatedAt : null;
                })() : null,
                alerts: dialogs.slice(seenDialogs).map((entry) => [entry.title, entry.message, entry.buttons.map((button) => [button.text, button.style])]),
                toasts: toasts.slice(seenToasts).map((toast) => [toast.tone, toast.title, toast.message, toast.actionLabel]),
            };
            seenDialogs = dialogs.length;
            seenToasts = toasts.length;
            return observation;
        },
    };
    const itemFor = (id: string) => current.items.find((item) => item.type !== 'section' && item.id === id)!;
    return replay(screen, async (_screen, action) => {
        const [kind, first, second] = action as [string, string, unknown];
        if (kind === 'segment') {
            if (state.segment !== first) exitSelection();
            state.segment = first as ArchiveSegment;
        } else if (kind === 'menu') {
            if (first === 'filters') state.filtersVisible = true;
            else if (first === 'sort') state.sortBy = second as TaskSortBy;
            else state.groupBy = second as ArchiveTaskGroupBy;
        } else if (kind === 'header') {
            const folded = state.collapsed[state.groupBy] ?? [];
            state.collapsed[state.groupBy] = folded.includes(first) ? folded.filter((id) => id !== first) : [...folded, first];
        } else if (kind === 'search') state.filters.searchQuery = first;
        else if (kind === 'filter') {
            const filters = state.filters;
            const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]);
            if (first === 'clear') state.filters = { ...NO_FILTERS };
            else if (first === 'close') state.filtersVisible = false;
            else if (first === 'toggleToken') {
                const token = second as string;
                if (filters.tokens.includes(token)) {
                    filters.tokens = filters.tokens.filter((entry) => entry !== token);
                    if (!filters.excludedTokens.includes(token)) filters.excludedTokens = [...filters.excludedTokens, token];
                } else if (filters.excludedTokens.includes(token)) filters.excludedTokens = filters.excludedTokens.filter((entry) => entry !== token);
                else filters.tokens = [...filters.tokens, token];
            } else if (first === 'togglePriority') filters.priorities = toggle(filters.priorities, second as TaskPriority);
            else if (first === 'toggleEnergyLevel') filters.energyLevels = toggle(filters.energyLevels, second as TaskEnergyLevel);
            else if (first === 'toggleTimeEstimate') filters.timeEstimates = toggle(filters.timeEstimates, second as TimeEstimate);
            else if (first === 'setLocation') filters.location = second as string;
        } else if (kind === 'press') {
            const labels = current.labels;
            if (first === 'Select' && !state.selectionMode) state.selectionMode = true;
            else if (first === labels.done && state.selectionMode) exitSelection();
            else if (first === 'Select all') state.selected = [...current.visibleIds];
            else if (first === labels.restoreSelected) {
                await backend.run({ type: 'moveTasksToInbox', taskIds: [...state.selected] });
                exitSelection();
            } else if (first === labels.delete) {
                const taskIds = [...state.selected];
                dialogs.push(dialog(current.confirmations.trashTasks, async () => {
                    const toast = await backend.run({ type: 'trashTasks', taskIds });
                    exitSelection();
                    if (toast) toasts.push(toast);
                }));
            } else if (first === current.empty?.clearLabel) state.filters = { ...NO_FILTERS };
            else throw new Error(`Nothing to press for ${first}`);
        } else if (kind === 'swipe') {
            const item = itemFor(first);
            if (item.type === 'project') {
                if (second === 'restore') await backend.run({ type: 'reactivateProject', projectId: first });
                else dialogs.push(dialog(item.confirmation, async () => { await backend.run({ type: 'trashProject', projectId: first }); }));
            } else if (second === 'restore') await backend.run({ type: 'moveToInbox', taskId: first });
            else dialogs.push(dialog(current.confirmations.trashTask, async () => { await backend.run({ type: 'trashTask', taskId: first }); }));
        } else if (kind === 'row') {
            if (second === 'completedAt') state.completedAt = first;
            else if (state.selectionMode) state.selected = Array.from(updateRangeSelection({ anchorId: null, selectedIds: new Set(state.selected), targetId: first, visibleIds: [] }).selectedIds);
            else state.editor = first;
        } else if (kind === 'pickCompletedAt') {
            const taskId = state.completedAt!;
            state.completedAt = null;
            await backend.run({ type: 'setCompletedAt', taskId, completedAt: first });
        } else if (kind === 'editorSave') {
            // The editor's own save; the screen closes it after asking the store.
            await useTaskStore.getState().updateTask(first, second as Partial<Task>);
            state.editor = null;
        } else if (kind === 'alert') await dialogs[dialogs.length - 1].buttons.find((button) => button.text === first)?.run?.();
        else if (kind === 'toastAction') await toasts[toasts.length - 1].undo!();
        else throw new Error(`Unknown Archive action ${kind}`);
        void t;
    }, scenario.actions, recorder);
}

// --- Trash -----------------------------------------------------------------

type TrashModel = {
    summary: string | null;
    retentionHint: string | null;
    items: { type: 'task' | 'project'; id: string; title: string; deletedAt: string; typeLabel: string; deletedLabel: string; markdown: string | null; indicatorColor: string | null }[];
    /** What Select all selects: mobile takes the shown tasks and projects in store order. */
    selectAll: { taskIds: string[]; projectIds: string[] };
    labels: ReturnType<typeof getTrashRowLabels> & { done: string; clearAll: string; selectAll: string; restoreSelected: string; deleteSelected: string; bulkSelected: string };
    confirmations: { purgeItem: ListConfirmation; purgeSelection: ListConfirmation };
    emptyTrash: { confirmation: ListConfirmation; run: () => Promise<void> } | null;
    empty: { title: string; message: string } | null;
};
type TrashBackend = { model: () => TrashModel; run: (write: NativeTrashAction) => Promise<void> };

/** Trash through core's functions, as the React Native screen calls them. */
export function createTrashCoreBackend(t: Translate): TrashBackend {
    const run = async (write: NativeTrashAction) => {
        const store = useTaskStore.getState();
        switch (write.type) {
            case 'restoreItem': await (write.kind === 'task' ? store.restoreTask(write.id) : store.restoreProject(write.id)); return;
            case 'purgeItem': await (write.kind === 'task' ? store.purgeTask(write.id) : store.purgeProject(write.id)); return;
            case 'restoreItems': await restoreTrashItems(store, write); return;
            case 'purgeItems': await purgeTrashItems(store, write); return;
            case 'emptyTrash': throw new Error('Clear Trash runs from its dialog');
        }
    };
    return {
        run,
        model() {
            const { state: store, areaById, projectById, selection } = areaScope();
            const tasks = selectTrashedTasks(store._allTasks, selection, projectById, areaById);
            const projects = selectTrashedProjects(store._allProjects, selection, areaById);
            const items = buildTrashTimeline(tasks, projects);
            const labels = getTrashRowLabels(t);
            const scope = resolveTrashClearScope(tasks, projects, store._allTasks, store._allProjects);
            return {
                summary: items.length > 0 ? formatTrashCounts(tasks.length, projects.length, t) : null,
                retentionHint: items.length > 0 ? getTrashRetentionHint(t) : null,
                items: items.map((item) => {
                    const entity = item.type === 'task' ? item.task : item.project;
                    return {
                        type: item.type, id: entity.id, title: entity.title, deletedAt: entity.deletedAt!,
                        typeLabel: item.type === 'task' ? labels.taskType : labels.projectType,
                        deletedLabel: `${labels.deleted}: ${formatTrashDeletedDate(entity.deletedAt, safeFormatDate, labels.notSet)}`,
                        markdown: item.type === 'task' && item.task.description ? getInlineMarkdownPreview(item.task.description) : null,
                        indicatorColor: item.type === 'project' ? getProjectAccentColor(item.project, areaById) ?? null : '#6B7280',
                    };
                }),
                selectAll: { taskIds: tasks.map((task) => task.id), projectIds: projects.map((project) => project.id) },
                labels: {
                    ...labels,
                    done: tFallback(t, 'common.done', 'Done'),
                    clearAll: tFallback(t, 'trash.clearAll', 'Clear Trash'),
                    selectAll: `${tFallback(t, 'bulk.select', 'Select')} ${tFallback(t, 'common.all', 'all')}`,
                    restoreSelected: t('trash.restore'),
                    deleteSelected: t('trash.deletePermanently'),
                    bulkSelected: t('bulk.selected'),
                },
                confirmations: { purgeItem: getTrashPurgeConfirmation({ kind: 'item' }, t), purgeSelection: getTrashPurgeConfirmation({ kind: 'selection' }, t) },
                emptyTrash: items.length === 0 ? null : {
                    confirmation: getTrashPurgeConfirmation({ kind: 'clear', narrowed: scope.narrowed, taskCount: scope.taskIds.length, projectCount: scope.projectIds.length }, t),
                    // Always the ids the dialog opened for.
                    run: () => run({ type: 'purgeItems', taskIds: scope.taskIds, projectIds: scope.projectIds }),
                },
                empty: items.length === 0 ? getTrashEmptyState(t) : null,
            };
        },
    };
}

/** Trash through the native host contract. */
export function createTrashContractBackend(host: Host, requestId: () => string): TrashBackend {
    const run = async (write: NativeTrashAction) => { expectOk(await host.runTrashAction({ requestId: requestId(), action: write })); };
    return {
        run,
        model() {
            const view = expectOk(host.getTrashView({ ...WINDOW }));
            const { labels } = view;
            return {
                summary: view.summary,
                retentionHint: view.retentionHint,
                items: view.items.map((item) => {
                    const entity = item.type === 'task'
                        ? useTaskStore.getState()._tasksById.get(item.row.id)!
                        : useTaskStore.getState()._allProjects.find((project) => project.id === item.id)!;
                    return {
                        type: item.type, id: entity.id, title: entity.title, deletedAt: entity.deletedAt!, typeLabel: item.typeLabel,
                        deletedLabel: item.deletedLabel,
                        markdown: item.type === 'task' ? item.descriptionMarkdown : null,
                        indicatorColor: item.type === 'project' ? item.indicatorColor : '#6B7280',
                    };
                }),
                // The host selects every row it has paged; the contract hands the store its own order.
                selectAll: {
                    taskIds: view.items.flatMap((item) => (item.type === 'task' ? [item.row.id] : [])),
                    projectIds: view.items.flatMap((item) => (item.type === 'project' ? [item.id] : [])),
                },
                labels: { ...labels, bulkSelected: labels.selected.replace(/^\d+ /, '') },
                confirmations: view.confirmations,
                emptyTrash: view.emptyTrash ? {
                    confirmation: view.emptyTrash.confirmation,
                    run: () => run({ type: 'emptyTrash', revision: view.emptyTrash!.revision }),
                } : null,
                empty: view.empty,
            };
        },
    };
}

export async function replayTrash(backend: TrashBackend, scenario: ListViewsScenario, recorder: WriteRecorder) {
    let selectionMode = false;
    let selectedTasks: string[] = [];
    let selectedProjects: string[] = [];
    const dialogs: Dialog[] = [];
    let seenDialogs = 0;
    let current = backend.model();
    const exitSelection = () => { selectionMode = false; selectedTasks = []; selectedProjects = []; };
    const screen = {
        settle() {
            current = backend.model();
            selectedTasks = selectedTasks.filter((id) => current.items.some((item) => item.type === 'task' && item.id === id));
            selectedProjects = selectedProjects.filter((id) => current.items.some((item) => item.type === 'project' && item.id === id));
        },
        observe() {
            const { labels } = current;
            const count = selectedTasks.length + selectedProjects.length;
            const hasItems = current.items.length > 0;
            const selectLabel = selectionMode ? labels.done : labels.select;
            const observation = {
                header: [
                    ...(hasItems ? [current.summary!, selectLabel, labels.clearAll, current.retentionHint!] : []),
                    ...(selectionMode ? [`${count} ${labels.bulkSelected}`, labels.selectAll, labels.restoreSelected, labels.deleteSelected] : []),
                ],
                buttons: [
                    ...(hasItems ? [[selectLabel, false], [labels.clearAll, false]] : []),
                    ...(selectionMode ? [
                        [labels.selectAll, !hasItems || count === current.items.length],
                        [labels.restoreSelected, count === 0],
                        [labels.deleteSelected, count === 0],
                    ] : []),
                ],
                rows: current.items.map((item) => {
                    const selected = item.type === 'task' ? selectedTasks.includes(item.id) : selectedProjects.includes(item.id);
                    return [
                        [item.title, item.typeLabel, item.deletedLabel],
                        selectionMode ? `${labels.select} ${item.title}` : null,
                        selectionMode ? { selected } : null,
                        !selectionMode,
                        item.markdown,
                        item.indicatorColor,
                        selectionMode ? null : [`↩️ ${labels.restore}`, labels.delete],
                    ];
                }),
                empty: current.empty ? ['Icon:Trash2', current.empty.title, current.empty.message] : null,
                alerts: dialogs.slice(seenDialogs).map((entry) => [entry.title, entry.message, entry.buttons.map((button) => [button.text, button.style])]),
                toasts: [],
            };
            seenDialogs = dialogs.length;
            return observation;
        },
    };
    const itemFor = (id: string) => current.items.find((item) => item.id === id)!;
    return replay(screen, async (_screen, action) => {
        const [kind, first, second] = action as [string, string, string];
        const { labels } = current;
        if (kind === 'swipe') {
            const item = itemFor(first);
            if (second === 'restore') await backend.run({ type: 'restoreItem', kind: item.type, id: first });
            else dialogs.push(dialog(current.confirmations.purgeItem, () => backend.run({ type: 'purgeItem', kind: item.type, id: first })));
        } else if (kind === 'toggle') {
            const item = itemFor(first);
            const toggle = (list: string[]) => (list.includes(first) ? list.filter((id) => id !== first) : [...list, first]);
            if (item.type === 'task') selectedTasks = toggle(selectedTasks);
            else selectedProjects = toggle(selectedProjects);
        } else if (kind === 'press') {
            if (first === labels.select && !selectionMode) selectionMode = true;
            else if (first === labels.done && selectionMode) exitSelection();
            else if (first === 'Select all') {
                selectedTasks = [...current.selectAll.taskIds];
                selectedProjects = [...current.selectAll.projectIds];
            } else if (first === labels.restoreSelected) {
                if (selectedTasks.length + selectedProjects.length === 0) return;
                await backend.run({ type: 'restoreItems', taskIds: [...selectedTasks], projectIds: [...selectedProjects] });
                exitSelection();
            } else if (first === labels.deleteSelected) {
                if (selectedTasks.length + selectedProjects.length === 0) return;
                const taskIds = [...selectedTasks];
                const projectIds = [...selectedProjects];
                dialogs.push(dialog(current.confirmations.purgeSelection, async () => {
                    await backend.run({ type: 'purgeItems', taskIds, projectIds });
                    exitSelection();
                }));
            } else if (first === labels.clearAll) {
                const clear = current.emptyTrash;
                if (!clear) return;
                dialogs.push(dialog(clear.confirmation, async () => {
                    await clear.run();
                    exitSelection();
                }));
            } else throw new Error(`Nothing to press for ${first}`);
        } else if (kind === 'alert') await dialogs[dialogs.length - 1].buttons.find((button) => button.text === first)?.run?.();
        else throw new Error(`Unknown Trash action ${kind}`);
    }, scenario.actions, recorder);
}

// --- History ---------------------------------------------------------------

/** History for a route's tab: the tabs as it opens, then after tapping the other one. */
export function observeHistory(tab: string | null, readTabs: (tab: string | null) => { tab: string; tabs: { id: string; label: string; selected: boolean }[] }) {
    const opened = readTabs(tab);
    const other = opened.tabs.find((entry) => !entry.selected)!.id;
    const switched = readTabs(other);
    const shape = (view: typeof opened) => ({ tabs: view.tabs.map((entry) => [entry.label, entry.selected]), content: view.tab });
    return { tab, opened: shape(opened), switched: { ...shape(switched), setParams: [[{ tab: other }]] } };
}

/** History through core's functions. */
export const readHistoryTabs = (t: Translate) => (tab: string | null) => {
    const resolved = resolveHistoryTab(tab);
    return { tab: resolved, tabs: getHistoryTabs(t).map((entry) => ({ ...entry, selected: entry.id === resolved })) };
};
