/**
 * Test support only (imported by the selection-mode tests; not exported).
 * Replays the frozen React Native selection-mode scenarios
 * (task-list-bulk-actions-parity.fixtures.json, captured by
 * apps/mobile/components/task-list/bulk-actions-parity.test.tsx) through core:
 * either core's functions directly, or the native host contract. A replay keeps
 * what React state keeps on mobile (the selection, the open dialog, the draft) and
 * records the same observation the mobile harness records.
 */
import { readFileSync } from 'node:fs';
import { collectBulkTaskTokens } from './bulk-task-tokens';
import { createNativeHostContract, type NativeHostResult } from './native-host-contract';
import type { NativeBulkList } from './native-host-contract-bulk-actions';
import { sortProjectsForPicker } from './project-utils';
import { updateRangeSelection } from './range-selection';
import { getSomedaySectionMoveSelection } from './someday-sections-model';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import {
    applyBulkOrganizeDraftEdit,
    BULK_ORGANIZE_KEEP,
    BULK_ORGANIZE_NONE,
    buildBulkOrganizeDateFieldModel,
    buildBulkOrganizeDialogModel,
    buildBulkOrganizeInput,
    buildTaskListBulkBarModel,
    canSaveTaskListTag,
    EMPTY_BULK_ORGANIZE_DRAFT,
    getBulkMoveStatusOptions,
    getBulkOrganizeAreaOptions,
    getBulkOrganizeProjectOptions,
    getTaskListAddTagDialogText,
    getTaskListBulkToast,
    getTaskListRemoveTagPickerText,
    planBulkOrganize,
    planBulkTagEdit,
    runTaskListBulkWrite,
    TASK_LIST_BULK_SCREENS,
    type BulkOrganizeDateField,
    type BulkOrganizeDraft,
    type BulkOrganizeDraftEdit,
    type TaskListBulkBarModel,
    type TaskListBulkScreen,
    type TaskListBulkWrite,
} from './task-list-bulk-actions';
import { getBulkTrashConfirmation } from './trash-view-model';
import { sortViewSectionDefinitions } from './view-sections';
import type { AppSettings, Area, Project, Task, TaskStatus } from './types';

type FixtureDateField = 'start' | 'due' | 'review';
export type BulkScenarioAction = [string, ...unknown[]];
export type BulkScenario = { name: string; list: TaskListBulkScreen; actions: BulkScenarioAction[] };
export type BulkActionsFixture = {
    timeZone: string;
    now: string;
    tasks: Task[];
    projects: Project[];
    areas: Area[];
    settings: AppSettings;
    scenarios: BulkScenario[];
    observations: Record<string, Record<string, unknown>[]>;
};

export const loadBulkActionsFixture = (): BulkActionsFixture => JSON.parse(
    readFileSync(new URL('./task-list-bulk-actions-parity.fixtures.json', import.meta.url), 'utf8'),
) as BulkActionsFixture;

export const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (
    entry === undefined ? '<undefined>' : entry
)));

type StoreState = ReturnType<typeof useTaskStore.getState>;
type RealActions = Pick<StoreState, 'batchMoveTasks' | 'batchDeleteTasks' | 'batchUpdateTasks' | 'restoreTask' | 'updateTask' | 'deleteTask'>;
let realActions: RealActions | null = null;

/**
 * Seeds the store as the mobile harness does, with its store calls recorded in
 * `log`. `saveData` can fail a save.
 */
export async function seedBulkActionsStore(fixture: BulkActionsFixture, log: unknown[], saveData?: (data: unknown) => Promise<void>) {
    await flushPendingSave();
    resetForTests();
    const initial = useTaskStore.getState();
    realActions ??= {
        batchMoveTasks: initial.batchMoveTasks,
        batchDeleteTasks: initial.batchDeleteTasks,
        batchUpdateTasks: initial.batchUpdateTasks,
        restoreTask: initial.restoreTask,
        updateTask: initial.updateTask,
        deleteTask: initial.deleteTask,
    };
    const real = realActions;
    let data = JSON.parse(JSON.stringify({
        tasks: fixture.tasks, projects: fixture.projects, sections: [], areas: fixture.areas, people: [], settings: fixture.settings,
    }));
    setStorageAdapter({
        getData: async () => data,
        saveData: async (next) => {
            await saveData?.(next);
            data = JSON.parse(JSON.stringify(next));
        },
    });
    useTaskStore.setState({
        ...real,
        _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
        highlightTaskId: null,
    });
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    if (useTaskStore.getState()._allTasks.length !== fixture.tasks.length) throw new Error('Store seed did not load');
    const record = (name: string, args: unknown[]) => { log.push([name, ...(normalize(args) as unknown[])]); };
    useTaskStore.setState({
        batchMoveTasks: async (ids, status) => { record('batchMoveTasks', [ids, status]); return real.batchMoveTasks(ids, status); },
        batchDeleteTasks: async (ids) => { record('batchDeleteTasks', [ids]); return real.batchDeleteTasks(ids); },
        batchUpdateTasks: async (updates) => { record('batchUpdateTasks', [updates]); return real.batchUpdateTasks(updates); },
        restoreTask: async (id) => { record('restoreTask', [id]); return real.restoreTask(id); },
        updateTask: async (id, updates) => { record('updateTask', [id, updates]); return real.updateTask(id, updates); },
        deleteTask: async (id) => { record('deleteTask', [id]); return real.deleteTask(id); },
    });
}

export const value = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};

export async function openBulkActionsHost() {
    const host = createNativeHostContract();
    value(await host.setLanguage({ storedLanguage: 'en', systemLocale: null }));
    value(await host.activate({ writeSafetyReady: true }));
    return host;
}
export type BulkActionsHost = Awaited<ReturnType<typeof openBulkActionsHost>>;

let requestCount = 0;
/** A fresh request UUID. */
export const requestId = () => `00000000-0000-4000-8000-${String(++requestCount).padStart(12, '0')}`;

type Row = { id: string; readOnly: boolean };
const DATE_FIELDS: Record<FixtureDateField, BulkOrganizeDateField> = { start: 'startDate', due: 'dueDate', review: 'reviewDate' };

/** The list's rows as its view returns them (the list views have their own parity fixtures). */
function readRows(host: BulkActionsHost, list: TaskListBulkScreen, params: Record<string, unknown>): Row[] {
    const window = { offset: 0, limit: 100 };
    const task = (items: { type: string; row?: { id: string; readOnly?: boolean } }[]) => items
        .flatMap((item) => (item.type === 'task' && item.row ? [{ id: item.row.id, readOnly: item.row.readOnly === true }] : []));
    const input = { ...params, ...window } as never;
    switch (list) {
        case 'inbox': return task(value(host.getInboxView(input)).items);
        case 'waiting': return value(host.getWaitingView(input)).rows.map((row) => ({ id: row.id, readOnly: false }));
        case 'someday': return task(value(host.getSomedayView(input)).items);
        case 'reference': return task(value(host.getReferenceView(input)).items);
        case 'done': return task(value(host.getDoneView(input)).items);
        case 'project': {
            const detail = value(host.getProjectDetail({ projectId: 'p-launch', ...window }));
            return detail.items.flatMap((item) => (item.type === 'task' ? [{ id: item.row.id, readOnly: detail.readOnly }] : []));
        }
    }
}

/** What React state holds on mobile while a list is in selection mode. */
type HostState = {
    list: TaskListBulkScreen;
    params: Record<string, unknown>;
    selectionMode: boolean;
    /** Tap order. */
    selected: string[];
    anchorId: string | null;
    rangeSelectMode: boolean;
    tagInput: string | null;
    removePickerOpen: boolean;
    sectionPickerOpen: boolean;
    organize: { draft: BulkOrganizeDraft; showValidation: boolean; picker: 'project' | 'area' | null; datePicker: BulkOrganizeDateField | null } | null;
    alerts: unknown[];
    toasts: unknown[];
    undo: (() => Promise<void>) | null;
};

type OrganizeShown = {
    dialog: ReturnType<typeof buildBulkOrganizeDialogModel>;
    dates: { field: BulkOrganizeDateField; model: ReturnType<typeof buildBulkOrganizeDateFieldModel> }[];
    picker: { projects: string[]; leading: [string, boolean][]; selectedId: string | null | undefined } | null;
};

/** How a replay reads the bar and dialogs and makes each write: core's functions, or the contract. */
export type BulkDriver = {
    bar(state: HostState, rows: Row[]): TaskListBulkBarModel;
    removeTokens(state: HostState): string[];
    deleteConfirmation(state: HostState): ReturnType<typeof getBulkTrashConfirmation>;
    organize(state: HostState): OrganizeShown;
    /** A row tap: the new selection and anchor. */
    toggle(state: HostState, rows: Row[], taskId: string): { selected: string[]; anchorId: string | null };
    /** A draft edit, as the dialog's control sends it. */
    edit(state: HostState, edit: BulkOrganizeDraftEdit): BulkOrganizeDraft;
    /** A quick date chip's edit. */
    quickDate(state: HostState, field: BulkOrganizeDateField, preset: 'today' | 'tomorrow'): BulkOrganizeDraftEdit;
    sectionMove(state: HostState): { selectedId: string | null; selectionMixed: boolean };
    /** A bulk action; `changed` leaves selection mode. */
    run(state: HostState, action: DriverAction): Promise<{ changed: boolean; toast: unknown[] | null; undo: (() => Promise<void>) | null }>;
};
type DriverAction =
    | { type: 'move'; status: TaskStatus }
    | { type: 'tags'; mode: 'add' | 'remove'; values: string[] }
    | { type: 'organize' }
    | { type: 'trash' };

const selectedRows = (state: HostState, rows: Row[]) => {
    const selectable = new Set(rows.filter((row) => !row.readOnly).map((row) => row.id));
    return state.selected.filter((id) => selectable.has(id));
};

export function createCoreDriver(t: (key: string) => string): BulkDriver {
    const store = () => useTaskStore.getState();
    const tasksById = () => store()._tasksById;
    const organizeDialog = (state: HostState) => {
        const projects = getBulkOrganizeProjectOptions(store().projects);
        const areas = getBulkOrganizeAreaOptions(store().areas);
        return { projects, areas, dialog: buildBulkOrganizeDialogModel({ draft: state.organize!.draft, projects, areas, selectedCount: state.selected.length, t }) };
    };
    const perform = async (write: TaskListBulkWrite | null) => {
        if (!write) return { changed: false, toast: null, undo: null };
        const result = await runTaskListBulkWrite(store(), write);
        const failed = (Array.isArray(result) ? result : [result]).find((entry) => entry && entry.success === false);
        if (failed) throw new Error(failed.error ?? 'write failed');
        const toast = getTaskListBulkToast(write, t);
        const undoIds = toast?.undo?.taskIds;
        return {
            changed: true,
            toast: toast ? [toast.tone, toast.title, toast.message, toast.undo?.label ?? null] : null,
            undo: undoIds ? async () => { await perform({ kind: 'restore', taskIds: undoIds }); } : null,
        };
    };
    return {
        bar: (state, rows) => {
            const screen = TASK_LIST_BULK_SCREENS[state.list];
            const ids = selectedRows(state, rows);
            return buildTaskListBulkBarModel({
                selectedCount: ids.length,
                hasSelection: ids.length > 0,
                busy: false,
                rangeSelectMode: state.rangeSelectMode,
                statuses: getBulkMoveStatusOptions(screen.status),
                moveToSection: screen.moveToSection,
                organize: screen.organize,
                removeTag: screen.removeTags ? { canRemove: collectBulkTaskTokens(ids, tasksById(), 'tags').length > 0 } : null,
                t,
            });
        },
        removeTokens: (state) => collectBulkTaskTokens(state.selected, tasksById(), 'tags'),
        deleteConfirmation: () => getBulkTrashConfirmation(t),
        organize: (state) => {
            const { draft } = state.organize!;
            const { dialog, projects, areas } = organizeDialog(state);
            const now = new Date();
            const picker = state.organize!.picker;
            return {
                dialog,
                dates: dialog.dates.map(({ field, label }) => ({ field, model: buildBulkOrganizeDateFieldModel({ label, value: draft[field], now, t }) })),
                picker: picker === 'project'
                    ? {
                        projects: sortProjectsForPicker(projects, store().areas).map((project) => project.id),
                        leading: [[dialog.project.keepLabel, draft.projectChoice === BULK_ORGANIZE_KEEP]],
                        selectedId: draft.projectChoice === BULK_ORGANIZE_NONE ? null : dialog.project.selectedId,
                    }
                    : picker === 'area'
                        ? {
                            projects: areas.map((area) => area.id),
                            leading: [[dialog.area.keepLabel, draft.areaChoice === BULK_ORGANIZE_KEEP]],
                            selectedId: draft.areaChoice === BULK_ORGANIZE_NONE ? null : dialog.area.selectedId,
                        }
                        : null,
            };
        },
        toggle: (state, rows, taskId) => {
            const visibleIds = rows.filter((row) => !row.readOnly).map((row) => row.id);
            const result = updateRangeSelection({
                anchorId: state.anchorId, range: state.rangeSelectMode, selectedIds: new Set(selectedRows(state, rows)), targetId: taskId, visibleIds,
            });
            return { selected: Array.from(result.selectedIds), anchorId: result.anchorId };
        },
        edit: (state, edit) => applyBulkOrganizeDraftEdit(state.organize!.draft, edit),
        quickDate: (state, field, preset) => {
            const label = organizeDialog(state).dialog.dates.find((entry) => entry.field === field)!.label;
            const model = buildBulkOrganizeDateFieldModel({ label, value: state.organize!.draft[field], now: new Date(), t });
            return { type: 'setText', field, value: model.quickDates.find((chip) => chip.preset === preset)!.value };
        },
        sectionMove: (state) => {
            const sections = sortViewSectionDefinitions(store().settings.gtd?.viewSections?.someday);
            const selection = getSomedaySectionMoveSelection(state.selected.map((id) => tasksById().get(id)), sections);
            return { selectedId: selection.selectedId ?? null, selectionMixed: selection.selectionMixed };
        },
        run: async (state, action) => {
            switch (action.type) {
                case 'move': return perform({ kind: 'move', taskIds: state.selected, status: action.status });
                case 'tags': return perform(planBulkTagEdit(state.selected, tasksById(), action.mode, action.mode === 'add' ? action.values[0] : action.values));
                case 'organize': return perform(planBulkOrganize(state.selected, tasksById(), buildBulkOrganizeInput(state.organize!.draft)));
                case 'trash': return perform({ kind: 'trash', taskIds: state.selected });
            }
        },
    };
}

export function createContractDriver(host: BulkActionsHost): BulkDriver {
    const list = (state: HostState) => state.list as NativeBulkList;
    const view = (state: HostState, extra: Record<string, unknown> = {}) => value(host.getBulkActions({
        list: list(state),
        params: state.params,
        taskIds: state.selected,
        anchorId: state.anchorId,
        rangeSelectMode: state.rangeSelectMode,
        ...(state.organize ? { organize: { draft: state.organize.draft } } : {}),
        ...extra,
    }));
    const run = async (state: HostState, action: Record<string, unknown>) => {
        const result = value(await host.runBulkAction({ requestId: requestId(), list: list(state), action: action as never }));
        const { toast } = result;
        const undo = toast?.undo?.action;
        return {
            changed: result.changed,
            toast: toast ? [toast.tone, toast.title, toast.message, toast.undo?.label ?? null] : null,
            undo: undo ? async () => { value(await host.runBulkAction({ requestId: requestId(), list: list(state), action: undo })); } : null,
        };
    };
    return {
        bar: (state) => view(state).bar,
        removeTokens: (state) => value(host.getBulkActions({ list: list(state), params: state.params, taskIds: state.selected, picker: { kind: 'removeTag' } }))
            .picker!.items.map((item) => item.value),
        deleteConfirmation: (state) => view(state).deleteConfirmation,
        organize: (state) => {
            const picker = state.organize!.picker;
            const shown = view(state, picker ? { picker: { kind: picker } } : {});
            const organize = shown.organize!;
            const items = shown.picker?.items ?? [];
            return {
                dialog: organize,
                dates: organize.dates.map((date) => ({ field: date.field, model: date })),
                picker: shown.picker
                    ? {
                        projects: items.slice(2).map((item) => item.value),
                        leading: [[items[0].label, items[0].selected]],
                        selectedId: items[1].selected ? null : items.slice(2).find((item) => item.selected)?.value,
                    }
                    : null,
            };
        },
        toggle: (state, _rows, taskId) => {
            const shown = view(state, { selectionEdit: { taskId, range: state.rangeSelectMode } });
            return { selected: shown.selectedIds, anchorId: shown.anchorId };
        },
        edit: (state, edit) => view(state, { organize: { draft: state.organize!.draft, edit } }).organize!.draft,
        quickDate: (state, field, preset) => view(state).organize!.dates.find((date) => date.field === field)!
            .quickDates.find((chip) => chip.preset === preset)!.edit,
        sectionMove: (state) => {
            const ids = view(state).moveToSection!.taskIds;
            const dialog = value(host.getSomedayMoveDialog({ taskIds: ids }));
            const chosen = dialog.choices.items.find((choice) => choice.selected);
            return { selectedId: chosen?.sectionId ?? null, selectionMixed: !chosen };
        },
        run: async (state, action) => {
            // The selection with each row's revision, as the view shows them.
            const target = { taskIds: state.selected, taskRevisions: view(state).taskRevisions };
            switch (action.type) {
                case 'move': return run(state, { type: 'moveTasks', status: action.status, ...target });
                case 'tags': return run(state, { type: 'editTaskTokens', field: 'tags', mode: action.mode, values: action.values, ...target });
                case 'organize': return run(state, { type: 'organize', draft: state.organize!.draft, ...target });
                case 'trash': return run(state, { type: 'trashTasks', ...target });
            }
        },
    };
}

/** Every task the store changed since the last call: [id, { field: [before, after] }], as the mobile harness records it. */
function createChangeTracker() {
    const snapshot = () => new Map(useTaskStore.getState()._allTasks.map((entry) => [entry.id, JSON.stringify(normalize(entry))]));
    let last = snapshot();
    return () => {
        const next = snapshot();
        const changed: unknown[] = [];
        for (const [id, json] of next) {
            const before = last.get(id);
            if (before === json) continue;
            const previous = before ? JSON.parse(before) as Record<string, unknown> : {};
            const current = JSON.parse(json) as Record<string, unknown>;
            const read = (entry: Record<string, unknown>, field: string) => JSON.stringify(entry[field] ?? '<undefined>');
            const fields = Array.from(new Set([...Object.keys(previous), ...Object.keys(current)]))
                .filter((field) => field !== 'revBy' && read(previous, field) !== read(current, field))
                .sort();
            changed.push([id, Object.fromEntries(fields.map((field) => [field, [previous[field] ?? '<undefined>', current[field] ?? '<undefined>']]))]);
        }
        last = next;
        return changed;
    };
}

/** Replays one scenario and returns the observations the mobile harness records. */
export async function replayBulkScenario(
    fixture: BulkActionsFixture,
    scenario: BulkScenario,
    driverFor: (host: BulkActionsHost) => BulkDriver,
    t: (key: string) => string,
): Promise<Record<string, unknown>[]> {
    const log: unknown[] = [];
    await seedBulkActionsStore(fixture, log);
    const host = await openBulkActionsHost();
    const driver = driverFor(host);
    log.length = 0;
    const changes = createChangeTracker();
    const state: HostState = {
        list: scenario.list, params: {}, selectionMode: false, selected: [], anchorId: null, rangeSelectMode: false,
        tagInput: null, removePickerOpen: false, sectionPickerOpen: false, organize: null, alerts: [], toasts: [], undo: null,
    };
    const rows = () => readRows(host, state.list, state.params);
    // Mobile drops selected rows that leave the screen.
    const prune = () => {
        const onScreen = new Set(rows().map((row) => row.id));
        state.selected = state.selected.filter((id) => onScreen.has(id));
    };
    const exitSelection = () => {
        state.selectionMode = false;
        state.selected = [];
        state.rangeSelectMode = false;
        state.anchorId = null;
    };
    const afterRun = (outcome: Awaited<ReturnType<BulkDriver['run']>>) => {
        if (outcome.toast) state.toasts.push(outcome.toast);
        if (outcome.undo) state.undo = outcome.undo;
        if (outcome.changed) exitSelection();
    };

    const observe = (): Record<string, unknown> => {
        const shown = rows();
        const selectedSet = new Set(state.selected);
        const bar = state.selectionMode ? driver.bar(state, shown) : null;
        const tagText = getTaskListAddTagDialogText(t);
        const removeText = getTaskListRemoveTagPickerText(t);
        const barButton = (entry: { label: string; enabled: boolean } | null, accessibilityLabel?: string) => (
            entry ? [[accessibilityLabel ?? entry.label, entry.label, !entry.enabled]] : []
        );
        const organize = state.organize ? (() => {
            const { dialog, dates, picker } = driver.organize(state);
            const { draft, showValidation, datePicker } = state.organize!;
            const projectPicker = state.organize!.picker === 'project' && picker;
            const areaPicker = state.organize!.picker === 'area' && picker;
            return {
                title: dialog.title,
                subtitle: dialog.subtitle,
                close: [dialog.closeLabel, false],
                labels: [
                    dialog.statusLabel, dialog.project.label, dialog.area.label,
                    ...(dialog.waitingFor ? [dialog.waitingFor.label] : []),
                    ...dialog.dates.map((date) => date.label),
                    dialog.contexts.label, dialog.tags.label,
                ],
                status: dialog.statuses.map((status) => [null, status.label, status.selected, false]),
                project: [`${dialog.project.label}: ${dialog.project.value}`, dialog.project.value, false],
                area: [`${dialog.area.label}: ${dialog.area.value}`, dialog.area.value, dialog.area.disabled],
                waitingFor: dialog.waitingFor ? [draft.delegateWho, dialog.waitingFor.placeholder] : null,
                contexts: [draft.contexts, dialog.contexts.placeholder],
                tags: [draft.tags, dialog.tags.placeholder],
                dates: dates.map(({ field, model }) => ({
                    label: model.label,
                    input: [model.label, model.displayValue, model.placeholder, true],
                    calendar: [model.calendarAccessibilityLabel, datePicker === field, false],
                    chips: model.quickDates.map((chip) => [chip.accessibilityLabel, chip.label, chip.selected, false]),
                    picker: datePicker === field ? model.pickerStart : null,
                })),
                errors: showValidation ? [dialog.validationMessage] : [],
                cancel: [dialog.cancelLabel, false],
                apply: [dialog.applyLabel, state.selected.length === 0],
                // allProjects and allowCreate are the mobile picker's own props: the store's projects, and creation on.
                projectPicker: projectPicker ? {
                    projects: projectPicker.projects,
                    allProjects: useTaskStore.getState().projects.map((project) => project.id),
                    leading: projectPicker.leading,
                    selectedProjectId: projectPicker.selectedId === undefined ? '<undefined>' : projectPicker.selectedId,
                    allowCreate: true,
                } : null,
                areaPicker: areaPicker ? {
                    areas: areaPicker.projects,
                    leading: areaPicker.leading,
                    selectedAreaId: areaPicker.selectedId === undefined ? '<undefined>' : areaPicker.selectedId,
                    allowCreate: true,
                } : null,
            };
        })() : null;
        const observation = {
            rows: shown.map((row) => [row.id, row.readOnly]),
            selected: shown.filter((row) => !row.readOnly && selectedSet.has(row.id)).map((row) => row.id),
            selectionMode: state.selectionMode && shown.some((row) => !row.readOnly),
            bar: bar ? {
                count: bar.countLabel,
                buttons: [
                    [bar.exit.accessibilityLabel, '', !bar.exit.enabled],
                    ...bar.statuses.map((status) => [status.accessibilityLabel, status.label, !status.enabled]),
                    ...barButton(bar.moveToSection),
                    ...barButton(bar.organize),
                    ...barButton(bar.range),
                    ...barButton(bar.addTag),
                    ...barButton(bar.removeTag),
                    ...barButton(bar.delete),
                ],
            } : null,
            tagModal: state.tagInput === null ? null : {
                title: tagText.title,
                placeholder: tagText.placeholder,
                value: state.tagInput,
                cancel: tagText.cancelLabel,
                save: [tagText.saveLabel, !canSaveTaskListTag(state.tagInput)],
            },
            removePicker: state.removePickerOpen
                ? { title: removeText.title, description: removeText.description, tokens: driver.removeTokens(state), placeholder: removeText.placeholder, multiSelect: true }
                : null,
            organize,
            sectionPicker: state.sectionPickerOpen ? driver.sectionMove(state) : null,
            alerts: state.alerts.splice(0),
            toasts: state.toasts.splice(0),
            writes: log.splice(0),
            changed: changes(),
        };
        return normalize(observation) as Record<string, unknown>;
    };

    const observations = [observe()];
    for (const action of scenario.actions) {
        const [kind, arg, extra] = action as [string, unknown, unknown];
        const editDraft = (edit: BulkOrganizeDraftEdit) => { state.organize!.draft = driver.edit(state, edit); };
        switch (kind) {
            case 'select': {
                const row = rows().find((entry) => entry.id === arg);
                if (!row) throw new Error(`No row ${String(arg)}`);
                if (row.readOnly) break;
                state.selectionMode = true;
                const next = driver.toggle(state, rows(), row.id);
                state.selected = next.selected;
                state.anchorId = next.anchorId;
                state.rangeSelectMode = false;
                break;
            }
            case 'range':
                state.rangeSelectMode = !state.rangeSelectMode;
                break;
            case 'exit':
                exitSelection();
                break;
            case 'move':
                afterRun(await driver.run(state, { type: 'move', status: arg as TaskStatus }));
                break;
            case 'includeArchivedProjects':
                state.params = { ...state.params, includeArchivedProjects: true };
                break;
            case 'addTag':
                if (arg === 'open') state.tagInput = '';
                else if (arg === 'type') state.tagInput = extra as string;
                else if (arg === 'cancel') state.tagInput = null;
                else {
                    const input = state.tagInput!.trim();
                    state.tagInput = null;
                    if (input) afterRun(await driver.run(state, { type: 'tags', mode: 'add', values: [input] }));
                }
                break;
            case 'removeTag':
                if (arg === 'open') state.removePickerOpen = true;
                else {
                    state.removePickerOpen = false;
                    if (arg === 'confirm' && (extra as string[]).length > 0) {
                        afterRun(await driver.run(state, { type: 'tags', mode: 'remove', values: extra as string[] }));
                    }
                }
                break;
            case 'delete': {
                const confirmation = driver.deleteConfirmation(state);
                state.alerts.push([confirmation.title, confirmation.message, [[confirmation.cancelLabel, 'cancel'], [confirmation.confirmLabel, 'destructive']]]);
                if (arg === 'confirm') afterRun(await driver.run(state, { type: 'trash' }));
                break;
            }
            case 'undo': {
                const undo = state.undo;
                state.undo = null;
                await undo!();
                break;
            }
            case 'moveToSection':
                state.sectionPickerOpen = arg === 'open';
                break;
            case 'organize': {
                switch (arg) {
                    case 'open':
                        state.organize = { draft: EMPTY_BULK_ORGANIZE_DRAFT, showValidation: false, picker: null, datePicker: null };
                        break;
                    case 'close':
                        state.organize = null;
                        break;
                    case 'apply': {
                        const { dialog } = driver.organize(state);
                        if (!dialog.canApply) {
                            state.organize!.showValidation = true;
                            break;
                        }
                        const outcome = await driver.run(state, { type: 'organize' });
                        state.organize = null;
                        afterRun(outcome);
                        break;
                    }
                    case 'projectPicker':
                    case 'areaPicker':
                        state.organize!.picker = arg === 'projectPicker' ? 'project' : 'area';
                        break;
                    case 'status':
                        editDraft({ type: 'setStatus', value: extra === 'keep' ? BULK_ORGANIZE_KEEP : extra as BulkOrganizeDraft['status'] });
                        state.organize!.showValidation = false;
                        break;
                    case 'project':
                    case 'area': {
                        const choice = extra === 'keep' ? BULK_ORGANIZE_KEEP : extra === 'none' ? BULK_ORGANIZE_NONE : extra as string;
                        editDraft({ type: arg === 'project' ? 'setProject' : 'setArea', value: choice });
                        state.organize!.picker = null;
                        break;
                    }
                    case 'person':
                        editDraft({ type: 'setText', field: 'delegateWho', value: extra as string });
                        state.organize!.showValidation = false;
                        break;
                    case 'contexts':
                    case 'tags':
                        editDraft({ type: 'setText', field: arg, value: extra as string });
                        break;
                    case 'quickDate': {
                        const field = DATE_FIELDS[extra as FixtureDateField];
                        editDraft(driver.quickDate(state, field, (action as unknown[])[3] as 'today' | 'tomorrow'));
                        break;
                    }
                    case 'typeDate':
                        editDraft({ type: 'setText', field: DATE_FIELDS[extra as FixtureDateField], value: (action as unknown[])[3] as string });
                        break;
                    case 'openPicker':
                        state.organize!.datePicker = DATE_FIELDS[extra as FixtureDateField];
                        break;
                    case 'pickDate':
                        // The picked local day; the Android picker closes once a day is picked.
                        editDraft({ type: 'setText', field: DATE_FIELDS[extra as FixtureDateField], value: (action as unknown[])[3] as string });
                        state.organize!.datePicker = null;
                        break;
                    default:
                        throw new Error(`Unknown organize action ${JSON.stringify(action)}`);
                }
                break;
            }
            default:
                throw new Error(`Unknown action ${JSON.stringify(action)}`);
        }
        await flushPendingSave();
        prune();
        observations.push(observe());
    }
    await flushPendingSave();
    return observations;
}
