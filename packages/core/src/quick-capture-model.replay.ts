


import { readFileSync } from 'node:fs';
import { resolveCaptureAreaQuery, resolveCaptureProjectQuery } from './capture';
import { safeFormatDate } from './date';
import type { createNativeHostContract } from './native-host-contract';
import type { NativeQuickCaptureView } from './native-host-contract-quick-capture';
import { buildQuickAddParseOptions, type QuickAddParseOptions } from './quick-add';
import {
    applyQuickCaptureEdit,
    buildQuickCaptureAreaPicker,
    buildQuickCaptureContextPicker,
    buildQuickCapturePriorityPicker,
    buildQuickCaptureProjectPicker,
    buildQuickCaptureView,
    createQuickCaptureOptions,
    getQuickCaptureBulkConfirm,
    getQuickCaptureContextChoices,
    parseQuickCaptureContextQuery,
    planQuickCaptureSave,
    resolveQuickCaptureDefaultAreaId,
    saveQuickCapture,
    saveQuickCaptureBulk,
    type QuickCaptureContext,
    type QuickCaptureEdit,
    type QuickCaptureNotice,
    type QuickCaptureOptions,
    type QuickCaptureView,
} from './quick-capture-model';
import { resolveFeatureFlags } from './resolve-feature-flags';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { generateUUID } from './uuid';
import type { AppSettings, Area, Project, Task, TaskPriority } from './types';

type Picker = 'project' | 'area' | 'context' | 'priority';
export type QuickCaptureAction =
    | ['type', string]
    | ['note', string]
    | ['save']
    | ['saveAndEdit']
    | ['addAnother', boolean]
    | ['focus']
    | ['more']
    | ['quickDate', 'today' | 'tomorrow' | 'next_week']
    | ['pickDue', string]
    | ['pickDueTime', string]
    | ['clearDueTime']
    | ['clearDue']
    | ['openPicker', Picker]
    | ['closePicker', Picker]
    | ['query', 'project' | 'area' | 'context', string]
    | ['submitQuery', 'project' | 'area' | 'context']
    | ['selectProject', string | null]
    | ['selectArea', string | null]
    | ['selectPriority', TaskPriority | null]
    | ['toggleContext', string]
    | ['removeContext', string]
    | ['clearContexts']
    | ['addContexts']
    | ['reset', 'project' | 'area' | 'priority' | 'contexts']
    | ['confirmBulk']
    | ['cancelBulk']
    | ['close']
    | ['reopen']
    | ['elsewhere', { title: string; contexts?: string[] }];
export type QuickCaptureScenario = {
    name: string;
    settings: string;
    initialProps?: Partial<Task>;
    initialValue?: string;
    addAnotherPreference?: boolean;
    actions: QuickCaptureAction[];
};
export type QuickCaptureFixture = {
    provenance: { command: string; capturedAt: string };
    timeZone: string;
    now: string;
    tasks: Task[];
    projects: Project[];
    areas: Area[];
    settings: Record<string, AppSettings>;
    scenarios: QuickCaptureScenario[];
    observations: Record<string, Record<string, unknown>[]>;
};

export const loadQuickCaptureFixture = (): QuickCaptureFixture => JSON.parse(
    readFileSync(new URL('./quick-capture-parity.fixtures.json', import.meta.url), 'utf8'),
) as QuickCaptureFixture;


type Recorder = { log: unknown[]; createdIds: Map<string, string> };
type RealActions = Pick<ReturnType<typeof useTaskStore.getState>, 'addTask' | 'addTasks' | 'addProject' | 'addArea'>;
let realActions: RealActions | null = null;

const normalizeWith = (recorder: Recorder) => (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (
    entry === undefined ? '<undefined>' : entry
)).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (match) => recorder.createdIds.get(match) ?? '<uuid>'));

export async function seedQuickCaptureStore(
    fixture: QuickCaptureFixture,
    scenario: Pick<QuickCaptureScenario, 'settings'>,
    adapter: { saveData?: (data: unknown) => Promise<void> } = {},
): Promise<Recorder> {
    resetForTests();
    const initial = useTaskStore.getState();
    realActions ??= { addTask: initial.addTask, addTasks: initial.addTasks, addProject: initial.addProject, addArea: initial.addArea };
    const real = realActions;
    const recorder: Recorder = { log: [], createdIds: new Map() };
    const normalize = normalizeWith(recorder);
    const encode = (args: unknown[]) => normalize(args.map((arg) => (
        arg && typeof arg === 'object' && !Array.isArray(arg)
            ? Object.fromEntries(Object.entries(arg).map(([key, value]) => [key, value === undefined ? '<undefined>' : value]))
            : arg
    )));
    const data = JSON.parse(JSON.stringify({
        tasks: fixture.tasks, projects: fixture.projects, sections: [], areas: fixture.areas, people: [],
        settings: scenario.settings === 'base' ? {} : fixture.settings[scenario.settings],
    }));
    await flushPendingSave();
    let stored = data;
    setStorageAdapter({
        getData: async () => stored,
        saveData: async (next) => {
            await adapter.saveData?.(next);
            stored = JSON.parse(JSON.stringify(next));
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
    if (useTaskStore.getState()._allTasks.length !== data.tasks.length) throw new Error('Store seed did not load');
    const log = (name: string, args: unknown[]) => { recorder.log.push([name, ...encode(args) as unknown[]]); };


    const withoutId = <T extends object>(props: T | undefined) => {
        if (!props || !('id' in props)) return props;
        const { id: _id, ...rest } = props as T & { id: unknown };
        return Object.keys(rest).length > 0 ? rest : undefined;
    };
    useTaskStore.setState({
        addTask: async (title, props, options) => {
            log('addTask', [title, props]);
            const result = await real.addTask(title, props, options);
            if (result.id) recorder.createdIds.set(result.id, `<created:${title}>`);
            return result;
        },
        addTasks: async (items) => {
            log('addTasks', [items]);
            const result = await real.addTasks(items);
            result.ids?.forEach((id, index) => recorder.createdIds.set(id, `<created:${items[index]?.title}>`));
            return result;
        },
        addProject: async (title, color, props) => {
            log('addProject', [title, color, withoutId(props)]);
            const created = await real.addProject(title, color, props);
            if (created) recorder.createdIds.set(created.id, `<created-project:${title}>`);
            return created;
        },
        addArea: async (name, props) => {
            log('addArea', [name, withoutId(props)]);
            const created = await real.addArea(name, props);
            if (created) recorder.createdIds.set(created.id, `<created-area:${name}>`);
            return created;
        },
    });
    return recorder;
}


export function projectQuickCaptureObservation(observation: Record<string, unknown>): Record<string, unknown> {
    type Sheet = Record<string, unknown> & {
        showDueTime: boolean;
        prioritiesEnabled: boolean;
        labels: Record<string, unknown>;
        focus: { on: boolean; canFocus: boolean; label: string };
    };
    const sheet = observation.sheet as Sheet | null;
    if (!sheet) return { ...observation, sheet: null };
    const { showDueTime, focus, labels, ...rest } = sheet;
    return {
        ...observation,
        sheet: {
            ...rest,
            labels: { ...labels, dueTime: showDueTime ? labels.dueTime : null, priority: sheet.prioritiesEnabled ? labels.priority : null },
            focus: { on: focus.on, canFocus: focus.canFocus, label: focus.label },
        },
    };
}

type Ui = {
    text: string;
    options: QuickCaptureOptions;
    expanded: boolean;
    bag: QuickAddParseOptions | null;

    choices: string[];
    queries: { project: string; area: string; context: string };
    open: Picker | null;
    bulk: { lines: string[]; confirm: ReturnType<typeof getQuickCaptureBulkConfirm> } | null;
};

const observeView = (
    ui: Ui,
    view: QuickCaptureView,
    picker: NativeQuickCaptureView['picker'] | ReturnType<typeof pickerOf>,
) => {
    const { options } = ui;
    const query = ui.open && ui.open !== 'priority' ? ui.queries[ui.open] : '';
    const items = (picker && 'items' in picker ? picker.items : []) as { id?: string; label: string; value?: string }[];
    return {
        text: ui.text,
        note: options.note,
        saveEnabled: view.canSave,
        saveAndEditEnabled: view.canSave,
        preview: view.preview,
        dueDate: options.dueDate,
        projectSelected: view.project.selected,
        prioritiesEnabled: view.priority !== null,
        priority: options.priority,
        areaId: options.areaId,
        contexts: options.contexts,
        addAnother: view.addAnother.value,
        expanded: ui.expanded,
        moreLabel: ui.expanded ? view.text.hideOptions : view.text.more,
        quickDates: ui.expanded ? view.due.quickDates.map(({ label, selected }) => ({ label, selected })) : null,

        customDate: ui.expanded ? { label: view.due.custom.label, accessibilityLabel: view.due.custom.accessibilityLabel } : null,
        dueTimeChip: ui.expanded && view.due.time ? view.due.time.accessibilityLabel : null,
        pickers: {
            project: ui.open === 'project'
                ? { query, items: items.map((item) => item.id), exact: query.trim() ? (picker as { create: unknown }).create === null : false }
                : null,
            area: ui.open === 'area'
                ? { query, items: items.map((item) => item.id), exact: query.trim() ? (picker as { create: unknown }).create === null : false }
                : null,
            context: ui.open === 'context'
                ? { query, items: items.map((item) => item.label), addable: (picker as { add: unknown }).add !== null, loading: false }
                : null,
            priority: ui.open === 'priority' && view.priority ? { options: items.map((item) => item.value) } : null,
        },
        bulk: ui.bulk
            ? { title: ui.bulk.confirm.title, message: ui.bulk.confirm.message, confirm: ui.bulk.confirm.confirmLabel, cancel: ui.bulk.confirm.cancelLabel }
            : null,
        labels: {
            due: view.due.label,
            dueTime: view.due.time?.label ?? null,
            contexts: view.contexts.label,
            project: view.project.label,
            area: view.area.label,
            priority: view.priority?.label ?? null,
        },
        focus: { on: view.focus.selected, canFocus: view.focus.enabled, label: view.focus.accessibilityLabel },
    };
};

const pickerOf = (ui: Ui, context: QuickCaptureContext) => {
    if (ui.open === 'project') return buildQuickCaptureProjectPicker(ui.options, context, ui.queries.project);
    if (ui.open === 'area') return buildQuickCaptureAreaPicker(ui.options, context, ui.queries.area);
    if (ui.open === 'context') return buildQuickCaptureContextPicker(ui.options, context, ui.queries.context, ui.choices);
    if (ui.open === 'priority') return buildQuickCapturePriorityPicker(ui.options, context);
    return null;
};

const toastOf = (notice: QuickCaptureNotice) => [notice.tone, notice.title, notice.message, notice.durationMs ?? null];


export async function replayQuickCaptureScenario(input: {
    fixture: QuickCaptureFixture;
    scenario: QuickCaptureScenario;
    recorder: Recorder;
    t: (key: string) => string;
    contract?: ReturnType<typeof createNativeHostContract>;
}): Promise<Record<string, unknown>[]> {
    const { scenario, recorder, t, contract } = input;
    const normalize = normalizeWith(recorder);
    const toasts: unknown[] = [];
    const navigation: unknown[] = [];
    let preference = scenario.addAnotherPreference ?? false;
    let closed = false;
    let ui: Ui | null = null;
    const store = () => useTaskStore.getState();
    const unwrap = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
        return result.value;
    };

    const context = (current: Ui): QuickCaptureContext => {
        const state = store();
        return {
            settings: state.settings,
            projects: state.projects,
            areas: state.areas,
            parseOptions: current.bag!,
            focusedCount: state.getFocusedCount(),
            defaultAreaId: resolveQuickCaptureDefaultAreaId(state.settings, state.areas),
            initialProps: scenario.initialProps,
            contextChoices: current.choices,
            t,
            formatDate: safeFormatDate,
            now: new Date(),
        };
    };
    const freshUi = (options: QuickCaptureOptions, text: string, bag: QuickAddParseOptions | null): Ui => ({
        text,
        options,
        expanded: false,
        bag,
        choices: getQuickCaptureContextChoices([], scenario.initialProps?.contexts),
        queries: { project: '', area: '', context: '' },
        open: null,
        bulk: null,
    });
    const rebuildBag = () => buildQuickAddParseOptions(store().settings, store());

    const open = () => {
        if (contract) {
            const view = unwrap(contract.openQuickCapture());
            ui = freshUi(view.options, '', null);
            if (preference) ui.options = unwrap(contract.editQuickCapture({ text: '', options: ui.options, edit: { type: 'setAddAnother', value: true } })).view.options;
            return;
        }
        const state = store();
        const options = createQuickCaptureOptions({
            initialProps: scenario.initialProps,
            projects: state.projects,
            defaultAreaId: resolveQuickCaptureDefaultAreaId(state.settings, state.areas),
        });

        if (!resolveFeatureFlags(state.settings).priorities) options.priority = null;
        if (preference) options.addAnother = true;
        ui = freshUi(options, scenario.initialValue ?? '', rebuildBag());
    };
    const close = () => {
        ui = null;
        closed = true;
    };
    const resetForNext = (options: QuickCaptureOptions) => {
        if (contract) {
            ui = freshUi(options, '', null);
            return;
        }
        const state = store();
        ui = freshUi(createQuickCaptureOptions({
            initialProps: scenario.initialProps,
            projects: state.projects,
            defaultAreaId: resolveQuickCaptureDefaultAreaId(state.settings, state.areas),
            addAnother: true,
        }), '', rebuildBag());
    };

    const edit = (current: Ui, change: QuickCaptureEdit): boolean => {
        if (contract) {
            const result = unwrap(contract.editQuickCapture({ text: current.text, options: current.options, edit: change }));
            if (result.notice) toasts.push(toastOf(result.notice));
            current.options = result.view.options;
            return !result.notice;
        }
        const result = applyQuickCaptureEdit(current.options, change, context(current));
        if (!result) throw new Error(`Refused edit ${JSON.stringify(change)}`);
        if (result.notice) toasts.push(toastOf(result.notice));
        current.options = result.options;
        return !result.notice;
    };

    const viewOf = (current: Ui) => {
        if (contract) {

            const shown = current.open === 'priority' && !resolveFeatureFlags(store().settings).priorities ? null : current.open;
            const picker = shown ? { kind: shown, ...(shown === 'priority' ? {} : { query: current.queries[shown] }) } : undefined;
            const view = unwrap(contract.getQuickCaptureView({ text: current.text, options: current.options, picker }));
            return { view, picker: view.picker };
        }
        const ctx = context(current);
        return { view: buildQuickCaptureView(current.text, current.options, ctx), picker: pickerOf(current, ctx) };
    };

    const save = async (current: Ui, openAfterSave: boolean) => {
        if (contract) {
            if (!current.text.trim()) return;
            const result = unwrap(await contract.submitQuickCapture({
                text: current.text, options: current.options, captureId: generateUUID(), openAfterSave,
            }));
            if (result.kind === 'confirmLines') {
                current.bulk = { lines: new Array(result.lineCount).fill(''), confirm: result.confirm };
                return;
            }
            if (result.kind === 'refused') {
                toasts.push(toastOf(result.notice));
                return;
            }
            if (result.next === 'open') {
                close();
                navigation.push(['openTaskScreen', result.taskId, result.projectId, 'task']);
            } else if (result.next === 'addAnother') {
                resetForNext(result.reset!.options);
            } else {
                close();
            }
            return;
        }
        const plan = planQuickCaptureSave(current.text);
        if (plan.kind === 'empty') return;
        if (plan.kind === 'bulk') {
            current.bulk = { lines: plan.lines, confirm: getQuickCaptureBulkConfirm(plan.lines, t) };
            return;
        }
        const outcome = await saveQuickCapture({
            text: plan.text,
            options: current.options,
            context: context(current),
            actions: { addProject: store().addProject, addTask: store().addTask },
            openAfterSave,
        });
        if (outcome.kind === 'refused') {
            toasts.push(toastOf(outcome.notice));
            return;
        }
        if (outcome.next === 'open') {
            close();
            if (outcome.taskId) navigation.push(['openTaskScreen', outcome.taskId, outcome.projectId, 'task']);
        } else if (outcome.next === 'addAnother') {
            resetForNext(current.options);
        } else {
            if (outcome.highlightTaskId) store().setHighlightTask(outcome.highlightTaskId);
            close();
        }
    };

    const confirmBulk = async (current: Ui) => {
        const bulk = current.bulk!;
        current.bulk = null;
        if (contract) {

            const snapshot = unwrap(await contract.createQuickCaptureSnapshot());
            const result = unwrap(await contract.submitQuickCaptureLines({
                text: current.text,
                options: current.options,
                captureIds: bulk.lines.map(() => generateUUID()),
                snapshotFileName: snapshot?.fileName ?? null,
            }));
            if (result.kind === 'refused') toasts.push(toastOf(result.notice));
            else close();
            return;
        }
        const outcome = await saveQuickCaptureBulk({
            lines: bulk.lines,
            options: current.options,
            context: context(current),
            actions: { addProject: store().addProject, addTasks: store().addTasks },
        });
        if (outcome.kind === 'refused') toasts.push(toastOf(outcome.notice));
        if (outcome.kind === 'saved') close();
    };

    const submitPickerQuery = async (current: Ui, picker: 'project' | 'area') => {
        const query = current.queries[picker];
        const closePicker = () => {
            current.open = null;
            current.queries[picker] = '';
        };
        if (contract) {
            if (!query.trim()) return;
            const chosen = unwrap(await contract.submitQuickCapturePickerQuery({
                picker, query, text: current.text, options: current.options, requestId: generateUUID(),
            }));
            current.options = chosen.options;
            closePicker();
            return;
        }
        const state = store();
        let id: string | null = null;
        if (picker === 'project') {
            const resolution = resolveCaptureProjectQuery(state.projects, query, current.options.areaId);
            if (resolution.kind === 'empty') return;
            if (resolution.kind === 'select') id = resolution.project.id;
            else {
                const created = await state.addProject(resolution.projectToCreate.title, resolution.projectToCreate.color, resolution.projectToCreate.initialProps);
                if (!created) return;
                id = created.id;
            }
            edit(current, { type: 'selectProject', projectId: id });
        } else {
            const resolution = resolveCaptureAreaQuery(state.areas, query);
            if (resolution.kind === 'empty') return;
            if (resolution.kind === 'select') id = resolution.area.id;
            else {
                const created = await state.addArea(resolution.areaToCreate.name, { color: resolution.areaToCreate.color });
                if (!created) return;
                id = created.id;
            }
            edit(current, { type: 'selectArea', areaId: id });
        }
        closePicker();
    };

    const addContexts = (current: Ui) => {
        if (parseQuickCaptureContextQuery(current.queries.context).length === 0) return;
        if (contract) {
            const result = unwrap(contract.editQuickCapture({
                text: current.text, options: current.options, edit: { type: 'addContexts', query: current.queries.context },
            }));
            current.options = result.view.options;
        } else {
            edit(current, { type: 'addContexts', query: current.queries.context });
        }
        current.queries.context = '';
    };

    const run = async (action: QuickCaptureAction) => {
        if (action[0] === 'reopen') return open();
        if (action[0] === 'elsewhere') {
            await realActions!.addTask(action[1].title, { contexts: action[1].contexts ?? [] });
            return;
        }
        const current = ui;
        if (!current) throw new Error('The popup is closed');
        switch (action[0]) {
            case 'type': current.text = action[1]; break;
            case 'note': edit(current, { type: 'setNote', value: action[1] }); break;
            case 'save': await save(current, false); break;
            case 'saveAndEdit': await save(current, true); break;
            case 'addAnother': edit(current, { type: 'setAddAnother', value: action[1] }); preference = action[1]; break;
            case 'focus': edit(current, { type: 'toggleFocus' }); break;
            case 'more': current.expanded = !current.expanded; break;
            case 'quickDate': {
                const chip = viewOf(current).view.due.quickDates.find((entry) => entry.preset === action[1])!;
                edit(current, chip.edit);
                break;
            }
            case 'pickDue': edit(current, { type: 'setDueDay', day: action[1] }); break;
            case 'pickDueTime': edit(current, { type: 'setDueTime', time: action[1] }); break;
            case 'clearDueTime': edit(current, { type: 'clearDueTime' }); break;
            case 'clearDue': edit(current, { type: 'clearDueDate' }); break;
            case 'openPicker':
                current.open = action[1];
                if (action[1] === 'context') current.choices = getQuickCaptureContextChoices(store().tasks, scenario.initialProps?.contexts);
                break;
            case 'closePicker':
                current.open = null;
                if (action[1] === 'area') current.queries.area = '';
                break;
            case 'query': current.queries[action[1]] = action[2]; break;
            case 'submitQuery':
                if (action[1] === 'context') addContexts(current);
                else await submitPickerQuery(current, action[1]);
                break;
            case 'selectProject': edit(current, { type: 'selectProject', projectId: action[1] }); current.open = null; break;
            case 'selectArea': edit(current, { type: 'selectArea', areaId: action[1] }); current.open = null; current.queries.area = ''; break;
            case 'selectPriority': edit(current, { type: 'setPriority', priority: action[1] }); current.open = null; break;
            case 'toggleContext': edit(current, { type: 'toggleContext', value: action[1] }); current.queries.context = ''; break;
            case 'removeContext': edit(current, { type: 'removeContext', value: action[1] }); break;
            case 'clearContexts': edit(current, { type: 'clearContexts' }); current.queries.context = ''; current.open = null; break;
            case 'addContexts': addContexts(current); break;
            case 'reset':
                if (action[1] === 'project') edit(current, { type: 'resetProject' });
                if (action[1] === 'area') edit(current, { type: 'selectArea', areaId: null });
                if (action[1] === 'priority') edit(current, { type: 'setPriority', priority: null });
                if (action[1] === 'contexts') { edit(current, { type: 'clearContexts' }); current.queries.context = ''; }
                break;
            case 'confirmBulk': await confirmBulk(current); break;
            case 'cancelBulk': current.bulk = null; break;
            case 'close': close(); break;
        }
    };

    const step = () => {
        const current = ui as Ui | null;
        const observed = current ? (() => {
            const { view, picker } = viewOf(current);
            return observeView(current, view, picker);
        })() : null;
        const entry = {

            writes: contract
                ? JSON.parse(JSON.stringify(recorder.log.splice(0), (key, value) => (key === 'captureId' ? undefined : value)))
                : recorder.log.splice(0),
            toasts: toasts.splice(0),
            navigation: navigation.splice(0),
            closed,
            highlight: store().highlightTaskId ?? null,
            sheet: observed,
        };
        closed = false;
        return normalize(entry) as Record<string, unknown>;
    };

    open();
    const observations = [step()];
    for (const action of scenario.actions) {
        try {
            await run(action);
        } catch (error) {
            throw new Error(`${scenario.name}: ${JSON.stringify(action)} failed\n${String(error)}`);
        }
        observations.push(step());
    }
    await flushPendingSave();
    return observations;
}
