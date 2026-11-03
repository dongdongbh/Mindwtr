


import { readFileSync } from 'node:fs';
import { formatTimeEstimateLabel, resolveTimeEstimateOptions } from './calendar-scheduling';
import { tFallback } from './i18n';
import {
    answerProcessInboxStep,
    applyProcessInboxDraftEdit,
    buildProcessInboxStepView,
    commitProcessInboxDecision,
    createProcessInboxDraft,
    createProcessInboxTitleParser,
    formatProcessInboxCommitMessage,
    formatProcessInboxProgressLabel,
    getProcessInboxPersonSuggestions,
    getProcessInboxProgress,
    getProcessInboxProjectChoices,
    getProcessInboxSimilarTasks,
    getProcessInboxSuggestionTerms,
    getProcessInboxTokenPools,
    getProcessInboxTokenSuggestions,
    INITIAL_PROCESS_INBOX_ANSWERS,
    PROCESS_INBOX_QUICK_DATE_LABELS,
    PROCESS_INBOX_SUGGESTION_LIMIT,
    rankProcessInboxTokenSuggestions,
    resolveProcessInboxProjectSearchSubmit,
    selectProcessInboxQueue,
    type ProcessInboxAnswers,
    type ProcessInboxCommitKind,
    type ProcessInboxCommitted,
    type ProcessInboxDraft,
    type ProcessInboxDraftEdit,
    type ProcessInboxMode,
    type ProcessInboxStepView,
    type ProcessInboxViewDateRow,
    type ProcessInboxViewOption,
} from './process-inbox-model';
import { resolveProcessInboxPlan } from './process-inbox-plan';
import {
    getProcessInboxCurrentCandidate,
    getProcessInboxRemainingCandidates,
    startProcessInboxSession,
    type ProcessInboxSession,
} from './process-inbox-session';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { createDateFormatter } from './date';
import { createTaskSimilarityIndex } from './task-similarity';
import type { AppSettings, Area, Person, Project, Task } from './types';

type DateField = 'startTime' | 'dueDate' | 'reviewAt' | 'followUp';
export type ProcessInboxAction =
    | ['press', string]
    | ['set', string, unknown]
    | ['chip', string, string | null]
    | ['quickDate', DateField, string]
    | ['pickDate', DateField, string]
    | ['dateOnly', DateField]
    | ['clearDate', DateField]
    | ['addToken', 'context' | 'tag']
    | ['extraAction', 'add']
    | ['extraAction', 'enter', number | 'next']
    | ['extraAction', 'type', number, string]
    | ['extraAction', 'remove', number];
export type ProcessInboxScenario = { name: string; settings: string; taskIds: string[]; actions: ProcessInboxAction[] };
export type ProcessInboxObservation = Record<string, unknown> & { step: string; writes: unknown[]; toasts: unknown[] };
export type ProcessInboxFixture = {
    timeZone: string;
    now: string;
    tasks: Task[];
    projects: Project[];
    areas: Area[];
    people: Person[];
    settings: Record<string, AppSettings>;
    scenarios: ProcessInboxScenario[];
    observations: Record<string, ProcessInboxObservation[]>;
};

export const loadProcessInboxFixture = (): ProcessInboxFixture => JSON.parse(
    readFileSync(new URL('./process-inbox-model-parity.fixtures.json', import.meta.url), 'utf8'),
);


const CONTEXT_TASK_IDS = ['next-e', 'done-f'];

type Translate = (key: string) => string;


export function createWriteRecorder() {
    const log: unknown[] = [];
    const createdIds = new Map<string, string>();
    const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (
        entry === undefined ? '<undefined>' : entry
    )).replace(/"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/g, (match, id) => (
        createdIds.has(id) ? `"${createdIds.get(id)}"` : match
    )));
    const encodeArgs = (args: unknown[]) => normalize(args.map((arg) => (
        arg && typeof arg === 'object' && !Array.isArray(arg)
            ? Object.fromEntries(Object.entries(arg).map(([key, value]) => [key, value === undefined ? '<undefined>' : value]))
            : arg
    ))) as unknown[];
    return { log, createdIds, normalize, encodeArgs };
}
export type WriteRecorder = ReturnType<typeof createWriteRecorder>;

let realActions: Pick<ReturnType<typeof useTaskStore.getState>, 'updateTask' | 'deleteTask' | 'addTask' | 'addProject'> | null = null;


export async function seedProcessInboxStore(
    fixture: ProcessInboxFixture,
    scenario: ProcessInboxScenario,
    recorder: WriteRecorder,
    adapter: { saveData?: (data: unknown) => Promise<void> } = {},
): Promise<void> {

    await flushPendingSave();
    resetForTests();
    const initial = useTaskStore.getState();
    realActions ??= { updateTask: initial.updateTask, deleteTask: initial.deleteTask, addTask: initial.addTask, addProject: initial.addProject };
    const real = realActions;
    const byId = new Map(fixture.tasks.map((task) => [task.id, task]));
    const tasks = [
        ...scenario.taskIds.map((id) => byId.get(id)!),
        ...fixture.tasks.filter((task) => CONTEXT_TASK_IDS.includes(task.id)),
    ];
    let data = JSON.parse(JSON.stringify({
        tasks, projects: fixture.projects, sections: [], areas: fixture.areas, people: fixture.people,
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
    useTaskStore.setState({
        updateTask: async (id, updates) => { log.push(['updateTask', ...encodeArgs([id, updates])]); return real.updateTask(id, updates); },
        deleteTask: async (id) => { log.push(['deleteTask', id]); return real.deleteTask(id); },
        addTask: async (title, props, options) => {
            log.push(['addTask', ...encodeArgs([title, props])]);
            const result = await real.addTask(title, props, options);
            if (result.id) createdIds.set(result.id, `<created:${title}>`);
            return result;
        },
        addProject: async (title, color, initialProps) => {


            const { id: _id, ...rest } = initialProps ?? {};
            const shown = initialProps && 'id' in initialProps ? (Object.keys(rest).length > 0 ? rest : undefined) : initialProps;
            log.push(['addProject', ...encodeArgs([title, color, shown])]);
            const created = await real.addProject(title, color, initialProps);
            if (created) createdIds.set(created.id, `<created:${title}>`);
            return created;
        },
    });
}

export type ReplayView = ProcessInboxStepView & { taskId: string; draft: ProcessInboxDraft; progressLabel: string };

export type ReplayBackend = {
    view(): ReplayView | null;
    edit(edit: ProcessInboxDraftEdit): Promise<void>;
    choose(choice: string): Promise<void>;
    skip(): Promise<void>;
    submitProjectSearch(): Promise<void>;
    toggleMode(): Promise<void>;

    extras?(): Record<string, unknown>;
};

const storeActions = () => ({
    updateTask: (id: string, updates: Partial<Task>) => useTaskStore.getState().updateTask(id, updates),
    deleteTask: (id: string) => useTaskStore.getState().deleteTask(id),
    addTask: (title: string, props?: Partial<Task>) => useTaskStore.getState().addTask(title, props),
    addProject: (title: string, color: string, props?: Partial<Project>) => useTaskStore.getState().addProject(title, color, props),
});


export function createCoreBackend(options: { t: Translate; toasts: unknown[] }): ReplayBackend {
    const { t, toasts } = options;
    let mode: ProcessInboxMode = 'guided';
    let session: ProcessInboxSession | null = null;
    let answers: ProcessInboxAnswers = { ...INITIAL_PROCESS_INBOX_ANSWERS };
    let draft: ProcessInboxDraft | null = null;
    let previousProgress = { total: 0, processed: 0 };

    const context = () => {
        const state = useTaskStore.getState();
        return {
            state,
            plan: resolveProcessInboxPlan(state.settings),
            queue: selectProcessInboxQueue(state.tasks, state.projects),
            parseTitle: createProcessInboxTitleParser({
                settings: state.settings, tasks: state.tasks, people: state.people, projects: state.projects, areas: state.areas,
            }),
        };
    };
    const currentTask = () => (session ? getProcessInboxCurrentCandidate(session, context().queue) : null);
    const prime = (task: Task) => {
        answers = { ...INITIAL_PROCESS_INBOX_ANSWERS };
        draft = createProcessInboxDraft(task);
    };
    {
        const { queue } = context();
        if (queue.length > 0) {
            session = startProcessInboxSession(queue);
            prime(queue[0]);
        }
    }

    const runCommit = async (kind: ProcessInboxCommitKind | 'convert', committed: ProcessInboxCommitted | null) => {
        const task = currentTask()!;
        const { state, plan, queue, parseTitle } = context();
        const title = draft!.title.trim() || task.title;
        const result = await commitProcessInboxDecision(kind, {
            task, draft: draft!, plan, settings: state.settings, projects: state.projects, parseTitle,
            session: session!, candidates: queue, actions: storeActions(), t,
        });
        draft = result.draft;
        if (!result.ok) {
            if (result.notice) toasts.push([result.notice.tone, result.notice.title, result.notice.message, null]);
            return;
        }
        session = result.session;
        const next = currentTask();
        if (!next) session = null;
        else prime(next);
        if (committed) {
            toasts.push(['info', null, formatProcessInboxCommitMessage(t, committed, title), tFallback(t, 'common.undo', 'Undo')]);
        }
    };

    return {
        view() {
            const task = currentTask();
            if (!task || !draft) return null;
            const { state, plan, queue } = context();
            const progress = getProcessInboxProgress(previousProgress, getProcessInboxRemainingCandidates(session!, queue).length, session!);
            previousProgress = progress;
            const settings = state.settings;
            return {
                ...buildProcessInboxStepView({
                    task, draft, answers, mode, plan, settings,
                    tasks: state.tasks, projects: state.projects, areas: state.areas, people: state.people,
                    similarityIndex: createTaskSimilarityIndex(state._allTasks),
                    t,
                    formatDate: createDateFormatter({ language: 'en', dateFormat: settings.dateFormat, calendarSystem: settings.calendarSystem, timeFormat: settings.timeFormat }),
                    now: new Date(),
                }),
                taskId: task.id,
                draft,
                progressLabel: formatProcessInboxProgressLabel(t, progress.processed, progress.total),
            };
        },
        async edit(edit) {
            draft = applyProcessInboxDraftEdit(draft!, edit, context().plan);
        },
        async choose(choice) {
            const task = currentTask()!;
            const { plan, parseTitle } = context();
            const outcome = answerProcessInboxStep({ choice, answers, draft: draft!, mode, plan, task, parseTitle });
            if (outcome.type === 'invalid') throw new Error(`Choice ${choice} is not offered`);
            if (outcome.type === 'flow') {
                answers = outcome.answers;
                draft = outcome.draft;
                return;
            }
            await runCommit(outcome.kind, outcome.committed);
        },
        async skip() {
            await runCommit('skip', null);
        },
        async submitProjectSearch() {
            const { state, plan } = context();
            const { exactMatch } = getProcessInboxProjectChoices(state.projects, draft!.areaId, draft!.projectSearch);
            const submit = resolveProcessInboxProjectSearchSubmit(draft!.projectSearch, exactMatch, draft!.areaId);
            if (submit.type === 'none') return;
            const projectId = submit.type === 'select'
                ? submit.projectId
                : (await useTaskStore.getState().addProject(submit.title, submit.color, submit.props))?.id;
            if (projectId) draft = applyProcessInboxDraftEdit(draft!, { type: 'selectProject', value: projectId }, plan);
        },
        async toggleMode() {
            mode = mode === 'quick' ? 'guided' : 'quick';
        },
        extras() {
            const task = currentTask()!;
            const { state, plan, queue } = context();
            const current = draft!;
            const pools = getProcessInboxTokenPools(state.tasks);
            const terms = getProcessInboxSuggestionTerms(current.title, current.description, current.tokenInput);
            const choices = getProcessInboxProjectChoices(state.projects, current.areaId, current.projectSearch);
            const similar = getProcessInboxSimilarTasks(createTaskSimilarityIndex(state._allTasks), current.title, task.id, state.projects);
            const remaining = getProcessInboxRemainingCandidates(session!, queue).length;
            return {
                counts: [queue.length, queue.length - remaining],
                suggestions: {
                    tokens: getProcessInboxTokenSuggestions({
                        tokenInput: current.tokenInput,
                        pools,
                        visible: { contexts: plan.visibleFields.contexts, tags: plan.visibleFields.tags },
                        selectedContexts: current.contexts,
                        selectedTags: current.tags,
                    }),
                    contextCopilot: rankProcessInboxTokenSuggestions(pools.contexts, current.contexts, terms, PROCESS_INBOX_SUGGESTION_LIMIT),
                    tagCopilot: rankProcessInboxTokenSuggestions(pools.tags, current.tags, terms, PROCESS_INBOX_SUGGESTION_LIMIT),
                    assignedTo: getProcessInboxPersonSuggestions(state.tasks, state.people, current.assignedTo),
                    delegateWho: getProcessInboxPersonSuggestions(state.tasks, state.people, current.delegateWho),
                    projects: choices.filteredProjects.map((project) => project.id),
                    exactProject: Boolean(choices.exactMatch),
                    similar: similar.tasks.map((similarTask) => similarTask.id),
                    similarProjects: Object.fromEntries(similar.projectTitles),
                    timeEstimates: resolveTimeEstimateOptions(current.timeEstimate ?? undefined),
                },
            };
        },
    };
}

const PRESS_LABELS: Record<string, [string, string?]> = {
    yes: ['inbox.yes'],
    later: ['process.later', 'Start later'],
    someday: ['inbox.someday'],
    incubate: ['process.incubate', 'Incubate'],
    reference: ['nav.reference'],
    trash: ['inbox.trash'],
    done: ['inbox.doneIt'],
    longer: ['inbox.takesLonger'],
    illDoIt: ['inbox.illDoIt'],
    delegate: ['inbox.delegate'],
    project: ['taskEdit.projectLabel'],
    oneActionNo: ['process.moreThanOneStepNo'],
    oneActionYes: ['process.moreThanOneStepYes'],
};

const findRow = (view: ReplayView, field: DateField): ProcessInboxViewDateRow => {
    const rows = [view.dateRow, view.delegate?.followUp ?? null, ...(view.moreOptions?.scheduling?.rows ?? [])];
    const row = rows.find((candidate) => candidate?.field === field);
    if (!row) throw new Error(`No ${field} row on ${view.step}`);
    return row;
};
const pick = (options: readonly ProcessInboxViewOption[] | undefined, match: (option: ProcessInboxViewOption) => boolean, what: string) => {
    const option = options?.find(match);
    if (!option) throw new Error(`No option ${what}`);
    return option.edit;
};


export async function performProcessInboxAction(backend: ReplayBackend, action: ProcessInboxAction, t: Translate): Promise<void> {
    const view = backend.view();
    if (!view) throw new Error(`No step for ${JSON.stringify(action)}`);
    const tf = (key: string, fallback?: string) => (fallback ? tFallback(t, key, fallback) : t(key));
    switch (action[0]) {
        case 'press': {
            const id = action[1];
            if (id === 'mode') return backend.toggleMode();
            if (id === 'skip') return backend.skip();
            if (id === 'more') return backend.edit(view.moreOptions!.edit);
            if (id === 'createProjectEarly') return backend.submitProjectSearch();
            if (id === 'back') {
                if (!view.back) throw new Error(`No Back on ${view.step}`);
                return backend.choose('back');
            }
            if (id === 'fileIt') {
                if (view.fileIt !== tf('inbox.fileIt', 'File it')) throw new Error(`No File it on ${view.step}`);
                return backend.choose('fileIt');
            }
            if (id === 'createProject') {
                if (view.project?.conversion?.createLabel !== t('process.createProject')) throw new Error('No Create project');
                return backend.choose('createProject');
            }
            const label = tf(...PRESS_LABELS[id]);
            const choice = view.choices.find((candidate) => candidate.label === label);
            if (!choice) throw new Error(`No choice "${label}" on ${view.step}`);
            return backend.choose(choice.id);
        }
        case 'set': {
            const [, field, value] = action;
            if (field === 'extraActions') return backend.edit({ type: 'setExtraActions', value: value as string[] });
            if (field === 'somedaySection') return backend.edit({ type: 'setSomedaySection', value: (value as string | null) ?? null });
            return backend.edit({ type: 'set', field: field as 'title', value: value as string });
        }
        case 'chip': {
            const [, kind, value] = action;
            const organization = view.moreOptions?.organization;
            const tokenRows = [view.contexts, view.moreOptions?.tags].filter(Boolean);
            switch (kind) {
                case 'context':
                    return backend.edit(pick(view.contexts?.selectedContexts, (option) => option.label === `${value} x`, `${value} x`));
                case 'tag':
                    return backend.edit(pick(view.moreOptions?.tags?.selectedTags, (option) => option.label === `${value} x`, `${value} x`));
                case 'suggestion':
                    return backend.edit(pick(
                        tokenRows.flatMap((row) => [...row!.suggestions, ...row!.contextSuggestions, ...row!.tagSuggestions]),
                        (option) => option.label === value,
                        String(value),
                    ));
                case 'project':
                    return backend.edit(pick(view.project?.projects, (option) => option.edit.type === 'selectProject' && option.edit.value === value, `project ${value}`));
                case 'area':
                    return backend.edit(pick(view.project?.areas, (option) => option.edit.type === 'setArea' && option.edit.value === value, `area ${value}`));
                case 'priority':
                    return backend.edit(pick(organization?.priorities, (option) => option.label === t(`priority.${value}`), `priority ${value}`));
                case 'energy':
                    return backend.edit(pick(organization?.energyLevels, (option) => option.label === t(`energyLevel.${value}`), `energy ${value}`));
                case 'estimate':
                    return backend.edit(pick(organization?.timeEstimates, (option) => option.label === formatTimeEstimateLabel(value as never), `estimate ${value}`));
                default:
                    throw new Error(`Unknown chip ${kind}`);
            }
        }
        case 'quickDate': {
            const [, field, preset] = action;
            const labels = PROCESS_INBOX_QUICK_DATE_LABELS[preset as keyof typeof PROCESS_INBOX_QUICK_DATE_LABELS];
            return backend.edit(pick(findRow(view, field).quickDates, (option) => option.label === tFallback(t, labels.key, labels.fallback), preset));
        }
        case 'pickDate':
            return backend.edit({ ...findRow(view, action[1]).pick, day: action[2] });
        case 'dateOnly': {
            const toggle = findRow(view, action[1]).timeMode;
            if (!toggle) throw new Error(`No date-only switch for ${action[1]}`);
            return backend.edit(toggle.edit);
        }
        case 'clearDate': {
            const clear = findRow(view, action[1]).clear;
            if (!clear) throw new Error(`No Clear for ${action[1]}`);
            return backend.edit(clear.edit);
        }
        case 'extraAction': {
            const conversion = view.project?.conversion;
            if (!conversion) throw new Error(`No project split on ${view.step}`);
            if (action[1] === 'add') return backend.edit(conversion.addAction.edit);
            if (action[1] === 'remove') return backend.edit(conversion.rows[action[2]].remove);
            if (action[1] === 'type') return backend.edit({ type: 'setExtraAction', index: action[2], value: action[3] });

            const submit = action[2] === 'next' ? conversion.nextActionSubmit : conversion.rows[action[2]].submit;
            return submit ? backend.edit(submit) : undefined;
        }
        case 'addToken': {
            const row = action[1] === 'context' ? view.contexts : view.moreOptions?.tags;
            if (!row) throw new Error(`No ${action[1]} input on ${view.step}`);
            return backend.edit(row.add.edit);
        }
    }
}


export function observeProcessInbox(
    backend: ReplayBackend,
    recorder: WriteRecorder,
    toasts: unknown[],
): ProcessInboxObservation {
    const view = backend.view();
    const writes = recorder.normalize(recorder.log.splice(0)) as unknown[];
    const toastEntries = recorder.normalize(toasts.splice(0)) as unknown[];
    if (!view) return { closed: true, step: 'none', writes, toasts: toastEntries };
    const { dirtyScheduleFields: _dirty, ...draft } = view.draft;
    if (draft.startTime) draft.startTime = { date: draft.startTime.date, dateOnly: draft.startTime.dateOnly };
    return recorder.normalize({
        closed: false,
        taskId: view.taskId,
        step: view.step,
        back: Boolean(view.back),
        fileIt: Boolean(view.fileIt),
        progress: view.progressLabel,
        returning: Boolean(view.capture.returningLabel),
        ...(backend.extras?.() ?? {}),
        draft,
        writes,
        toasts: toastEntries,
    }) as ProcessInboxObservation;
}


export function frozenObservation(observation: ProcessInboxObservation, keep?: readonly string[]): ProcessInboxObservation {
    const closed = typeof observation.closed === 'number' ? observation.closed > 0 : Boolean(observation.closed);
    const entries = Object.entries({ ...observation, closed })
        .filter(([key]) => !keep || key === 'closed' || key === 'step' || key === 'writes' || key === 'toasts' || keep.includes(key));
    return Object.fromEntries(entries) as ProcessInboxObservation;
}
