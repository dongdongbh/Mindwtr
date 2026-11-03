import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadTranslations } from './i18n/i18n-loader';
import { createNativeHostContract, NATIVE_AI_UNJOURNALED_COMMANDS, type NativeAIHost, type NativeHostResult } from './native-host-contract';
import type { NativeAIActionAnswer, NativeAISettingChange, NativeAISettings, NativeAICopilotApplied, NativeAICopilotSuggestion } from './native-host-contract-ai';
import { NATIVE_UNJOURNALED_COMMANDS } from './native-request-receipts';
import { openSqliteHost } from './screen-parity.replay';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { createTaskDraft, type TaskDraft } from './task-draft';
import type { AppSettings, ChecklistItem, Project, Section, Task } from './types';
import { generateUUID } from './uuid';


const device = vi.hoisted(() => ({
    queues: {} as Record<string, unknown[]>,
    calls: [] as unknown[][],

    signals: [] as (AbortSignal | undefined)[],
    modelFetch: null as null | ((url: string, init: RequestInit) => Promise<unknown>),
}));


const answer = async (name: string, fallback: string): Promise<any> => {
    const queue = device.queues[name];
    const next = queue && queue.length > 0 ? queue.shift() : { error: fallback };
    const entry = typeof next === 'function' ? await (next as () => Promise<unknown>)() : next;
    if (entry && typeof entry === 'object' && 'error' in entry) throw new Error(String((entry as { error: string }).error));
    return (entry as { value: unknown }).value;
};

vi.mock('./ai/ai-service', () => ({
    createAIProvider: (config: Record<string, unknown>) => {
        const record = (method: string, input: unknown) => {
            device.calls.push(['ai', method, {
                provider: config.provider, apiKey: config.apiKey, model: config.model, reasoningEffort: config.reasoningEffort,
                thinkingBudget: config.thinkingBudget, timeoutMs: config.timeoutMs, endpoint: config.endpoint,
                extraBodyParams: config.extraBodyParams, language: config.language, onRequestStop: typeof config.onRequestStop,
            }, input]);
            return answer(method, `No ${method} answer queued`);
        };
        const signalled = (method: string) => (input: unknown, options?: { signal?: AbortSignal }) => {
            device.signals.push(options?.signal);
            return record(method, input);
        };
        return {
            predictMetadata: signalled('predictMetadata'),
            clarifyTask: signalled('clarifyTask'),
            breakDownTask: signalled('breakDownTask'),
            analyzeReview: signalled('analyzeReview'),
        };
    },
}));
vi.mock('./ai/model-list', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./ai/model-list')>()),
    fetchProviderModelsCached: async (provider: string, options: { apiKey: string; baseUrl: string; kind: string; fetchImpl?: (url: string, init: RequestInit) => Promise<unknown> }) => {
        device.modelFetch = options.fetchImpl ?? null;
        device.calls.push(['fetchModels', provider, { apiKey: options.apiKey, baseUrl: options.baseUrl, kind: options.kind }]);
        return answer('models', 'offline');
    },
}));

const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (entry === undefined ? '<undefined>' : entry)));
const value = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const TINT = true;

type Device = { language?: string; foss?: boolean; storage?: Record<string, string>; secrets?: Record<string, string>; queues?: Record<string, unknown[]> };


function createDevice(input: Device, warnings: unknown[][] = []) {
    const storage = new Map(Object.entries(input.storage ?? {}));
    const secrets = new Map(Object.entries(input.secrets ?? {}));
    const log: unknown[][] = [];
    const host: NativeAIHost = {
        platform: { isFossBuild: input.foss ?? false },
        storage: {
            getItem: async (key) => storage.get(key) ?? null,
            setItem: async (key, entry) => { log.push(['setItem', key, entry]); storage.set(key, entry); },
            removeItem: async (key) => { log.push(['removeItem', key]); storage.delete(key); },
        },
        secrets: {
            get: async (key) => secrets.get(key) ?? null,

            set: async (key, entry) => { log.push(['setSecret', key, entry, 'whenUnlockedThisDeviceOnly']); secrets.set(key, entry); },
            delete: async (key) => { log.push(['deleteSecret', key]); secrets.delete(key); },
        },
        log: {
            warn: (message) => { warnings.push(['logWarn', message]); },
            info: () => undefined,
        },
        whisper: {
            preferredModelUri: (modelId) => `file:///whisper/${modelId}.bin`,
            locate: async (modelId) => ({ exists: false, uri: `file:///whisper/${modelId}.bin`, size: 0 }),
        },
    };
    device.queues = Object.fromEntries(Object.entries(input.queues ?? {}).map(([name, entries]) => [name,
        entries.map((entry) => (typeof entry === 'function' ? entry : JSON.parse(JSON.stringify(entry))))]));
    device.calls.length = 0;
    return { host, log, storage, secrets };
}

const writes: unknown[][] = [];
let realActions: Record<string, (...args: any[]) => Promise<any>> | null = null;

async function seed(data: { tasks?: Task[]; projects?: Project[]; sections?: Section[]; settings: AppSettings }) {
    await flushPendingSave();
    resetForTests();
    const state = useTaskStore.getState() as unknown as Record<string, (...args: any[]) => Promise<any>>;
    realActions ??= { updateTask: state.updateTask, batchUpdateTasks: state.batchUpdateTasks, updateSettings: state.updateSettings };
    let stored = JSON.parse(JSON.stringify({ tasks: data.tasks ?? [], projects: data.projects ?? [], sections: data.sections ?? [], areas: [], people: [], settings: data.settings }));
    setStorageAdapter({ getData: async () => stored, saveData: async (next) => { stored = JSON.parse(JSON.stringify(next)); } });
    useTaskStore.setState({
        ...realActions,
        _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
    } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    useTaskStore.setState(Object.fromEntries(Object.entries(realActions).map(([name, real]) => [name, async (...args: unknown[]) => {
        writes.push([name, ...(normalize(args) as unknown[])]);
        return real(...args);
    }])) as never);
    writes.length = 0;
}

async function openHost(host: NativeAIHost, language = 'en') {
    const contract = createNativeHostContract({ ai: host });
    value(await contract.setLanguage({ storedLanguage: language, systemLocale: 'en-US' }));
    expect(await contract.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
    return contract;
}
type Host = Awaited<ReturnType<typeof openHost>>;


type SettingsScenario = { name: string; settings: string; device: Device; actions: [string, ...unknown[]][] };
type SettingsFixture = { settings: Record<string, AppSettings>; scenarios: SettingsScenario[]; observations: Record<string, Record<string, unknown>[]> };
const settingsFixture: SettingsFixture = JSON.parse(readFileSync(new URL('./ai-settings-parity.fixtures.json', import.meta.url), 'utf8'));

type Control = { label: string; tinted: boolean; press: () => Promise<unknown> | void };
type Drawn = { texts: unknown[]; controls: Control[]; switches: { value: boolean; flip: () => Promise<unknown> }[]; inputs: { row: unknown[]; type: (text: string) => Promise<unknown> | void }[] };

async function replaySettings(scenario: SettingsScenario, strings: Record<string, Record<string, string>>) {
    await seed({ settings: settingsFixture.settings[scenario.settings] });
    const dev = createDevice(scenario.device, device.calls);
    const language = scenario.device.language ?? 'en';
    const translate = (key: string) => strings[language]?.[key] || strings.en[key] || key;
    const contract = await openHost(dev.host, language);
    const screen = { assistant: false, speech: false, advanced: false, extra: false, timeout: false, picker: null as null | 'model' | 'copilotModel' | 'speechModel' };
    let extraDraft = '';
    let lastExtraValue: string | null = null;
    let alert: { change: NativeAISettingChange; agree: string } | null = null;
    const asked: Record<'assistant' | 'speech', string | null> = { assistant: null, speech: null };
    const log = { toasts: [] as unknown[][], alerts: [] as unknown[][], device: 0, writes: 0, calls: 0 };
    let view: NativeAISettings = value(await contract.openAISettings({ requestId: generateUUID() }));

    const settle = async () => {
        view = value(contract.getAISettings());
        for (const list of ['assistant', 'speech'] as const) {
            const request = view.modelLists[list].request;
            if (request !== asked[list]) {
                asked[list] = request;
                if (request) view = value(await contract.loadAIModels({ list, request }));
            }
        }
        const extra = view.assistant.panel.kind === 'openai' ? view.assistant.panel.extraBody.value : null;
        if (extra !== null && extra !== lastExtraValue) extraDraft = extra;
        lastExtraValue = extra;
    };
    const set = async (change: NativeAISettingChange, consent?: true) => {
        const result = value(await contract.setAISetting({ requestId: generateUUID(), change, ...(consent ? { consent } : {}) }));
        for (const toast of result.toasts) log.toasts.push([toast.title, toast.message, toast.tone, toast.durationMs]);
        if (result.consent) {
            log.alerts.push([result.consent.title, result.consent.message, [result.consent.cancel, result.consent.agree]]);
            alert = { change, agree: result.consent.agree };
        }
        if (result.extraBodyDraft !== null) extraDraft = result.extraBodyDraft;
    };
    const endpoint = async (field: 'assistant' | 'speech', text: string) => {
        value(await contract.setAIEndpoint({ requestId: generateUUID(), field, value: text }));
    };
    const key = async (field: 'assistant' | 'speech', text: string) => {
        const provider = field === 'assistant'
            ? view.assistant.provider.options.find((option) => option.selected)!.value
            : view.speech.provider.options.find((option) => option.selected)!.value;
        value(await contract.setAIKey({ requestId: generateUUID(), field, provider, value: text }));
    };

    const layout = (): Drawn => {
        const drawn: Drawn = { texts: [view.title], controls: [], switches: [], inputs: [] };
        const text = (...entries: (string | null)[]) => { for (const entry of entries) if (entry !== null) drawn.texts.push(entry); };
        const control = (label: string, tinted: boolean, press: Control['press'], ...texts: string[]) => {
            text(...(texts.length ? texts : [label]));
            drawn.controls.push({ label, tinted, press });
        };
        const input = (placeholder: string | null, shown: string, secure: boolean, type: (entry: string) => Promise<unknown> | void) => {
            drawn.inputs.push({ row: [placeholder, secure ? '•'.repeat(shown.length) : shown, secure], type });
        };
        const options = <T,>(entries: { value: T; label: string; selected: boolean }[], choose: (entry: T) => Promise<unknown> | void) => {
            for (const entry of entries) control(entry.label, entry.selected, () => choose(entry.value));
        };
        const card = (title: string, description: string, open: boolean, toggle: () => void) => {
            const chevron = open ? '▾' : '▸';
            control(`${title}|${description}|${chevron}`, false, toggle, title, description, chevron);
        };
        const { assistant, speech } = view;
        card(assistant.title, assistant.description, screen.assistant, () => { screen.assistant = !screen.assistant; });
        if (screen.assistant) {
            text(assistant.enabled.label, assistant.enabled.description);
            drawn.switches.push({ value: assistant.enabled.value, flip: () => set({ type: 'enabled', value: !assistant.enabled.value }) });
            text(assistant.provider.label, assistant.provider.description);
            options(assistant.provider.options, (provider) => set({ type: 'provider', value: provider }));
            text(assistant.model.label);
            input(assistant.model.placeholder, assistant.model.value, false, (entry) => set({ type: 'model', value: entry }));
            control(assistant.model.suggestions, false, () => { screen.picker = 'model'; });
            text(assistant.copilotModel.label, assistant.copilotModel.description);
            input(assistant.copilotModel.placeholder, assistant.copilotModel.value, false, (entry) => set({ type: 'copilotModel', value: entry }));
            control(assistant.copilotModel.suggestions, false, () => { screen.picker = 'copilotModel'; });
            const { panel } = assistant;
            if (panel.kind === 'openai') {
                text(panel.reasoning.label, panel.reasoning.description);
                options(panel.reasoning.options, (effort) => set({ type: 'reasoningEffort', value: effort }));
                text(panel.baseUrl.label, panel.baseUrl.description);
                input(panel.baseUrl.placeholder, panel.baseUrl.value, false, (entry) => endpoint('assistant', entry));
                const chevron = screen.extra ? '▾' : '▸';
                control(`${panel.extraBody.label}|${panel.extraBody.description}|${chevron}`, false, () => { screen.extra = !screen.extra; },
                    panel.extraBody.label, panel.extraBody.description ?? '', chevron);
                if (screen.extra) {
                    input(panel.extraBody.placeholder, extraDraft, false, (entry) => { extraDraft = entry; });
                    drawn.texts.push(panel.extraBody.error ? ['danger', panel.extraBody.error] : panel.extraBody.hint);
                    control(panel.extraBody.save, false, () => set({ type: 'extraBodyParams', text: extraDraft }));
                }
                text(panel.apiKey.label, panel.apiKey.description, panel.apiKey.note);
                input(panel.apiKey.placeholder, panel.apiKey.mask, true, (entry) => key('assistant', entry));
            } else if (panel.kind === 'gemini') {
                text(panel.thinking.label, panel.thinking.description);
                options(panel.thinking.options, (budget) => set({ type: 'thinkingBudget', value: budget }));
                text(panel.apiKey.label, panel.apiKey.description);
                input(panel.apiKey.placeholder, panel.apiKey.mask, true, (entry) => key('assistant', entry));
            } else {
                text(panel.thinking.label, panel.thinking.description);
                drawn.switches.push({ value: panel.thinking.value, flip: () => set({ type: 'anthropicThinking', value: !panel.thinking.value }) });
                if (panel.budget) {
                    text(panel.budget.label, panel.budget.description);
                    options(panel.budget.options, (budget) => set({ type: 'thinkingBudget', value: budget }));
                }
                text(panel.apiKey.label, panel.apiKey.description);
                input(panel.apiKey.placeholder, panel.apiKey.mask, true, (entry) => key('assistant', entry));
            }
            const advancedChevron = screen.advanced ? '▾' : '▸';
            control(assistant.advanced.label, false, () => { screen.advanced = !screen.advanced; }, assistant.advanced.label, advancedChevron);
            if (screen.advanced) {
                const { timeout } = assistant.advanced;
                text(timeout.label, timeout.description);
                control(timeout.label, false, () => { screen.timeout = true; }, timeout.value, '▾');
                if (screen.timeout) {
                    text(timeout.label);
                    options(timeout.options, async (seconds) => {
                        await set({ type: 'requestTimeoutSeconds', value: seconds });
                        screen.timeout = false;
                    });
                }
            }
        }
        card(speech.title, speech.description, screen.speech, () => { screen.speech = !screen.speech; });
        if (screen.speech) {
            text(speech.enabled.label);
            drawn.switches.push({ value: speech.enabled.value, flip: () => set({ type: 'speechEnabled', value: !speech.enabled.value }) });
            text(speech.provider.label, speech.provider.description);
            options(speech.provider.options, (provider) => set({ type: 'speechProvider', value: provider }));
            text(speech.model.label);
            if (speech.model.kind === 'input') {
                input(null, speech.model.value, false, (entry) => set({ type: 'speechModel', value: entry }));
                control(speech.model.suggestions, false, () => { screen.picker = 'speechModel'; });
            } else {
                control(`${speech.model.value}|▾`, false, () => { screen.picker = 'speechModel'; }, speech.model.value, '▾');
            }
            if (speech.whisper) {
                text(speech.whisper.label, speech.whisper.description, speech.whisper.status);
                control(speech.whisper.action.label, false, () => undefined);
            } else {
                if (speech.apiKey) {
                    text(speech.apiKey.label, speech.apiKey.description);
                    input(speech.apiKey.placeholder, speech.apiKey.mask, true, (entry) => key('speech', entry));
                }
                if (speech.baseUrl) {
                    text(speech.baseUrl.label, speech.baseUrl.description);
                    input(speech.baseUrl.placeholder, speech.baseUrl.value, false, (entry) => endpoint('speech', entry));
                }
            }
            text(speech.language.label, speech.language.description);
            input(speech.language.placeholder, speech.language.value, false, (entry) => set({ type: 'speechLanguage', text: entry }));
            text(speech.mode.label, speech.mode.description);
            options(speech.mode.options, (mode) => set({ type: 'speechMode', value: mode }));
            text(speech.fieldStrategy.label, speech.fieldStrategy.description);
            options(speech.fieldStrategy.options, (strategy) => set({ type: 'speechFieldStrategy', value: strategy }));
        }
        if (screen.picker) {
            const picker = view.pickers[screen.picker];
            const kind = screen.picker;
            text(picker.title);
            options(picker.options, async (entry) => {
                await set(kind === 'model' ? { type: 'model', value: entry } : kind === 'copilotModel' ? { type: 'copilotModel', value: entry } : { type: 'speechModel', value: entry });
                screen.picker = null;
            });
        }
        return drawn;
    };

    const observe = () => {
        const drawn = layout();
        const out = normalize({
            texts: drawn.texts,
            controls: drawn.controls.map((entry) => [entry.label, entry.tinted === TINT]),
            switches: drawn.switches.map((entry) => entry.value),
            inputs: drawn.inputs.map((entry) => entry.row),
            writes: writes.slice(log.writes),
            device: dev.log.slice(log.device),
            toasts: log.toasts,
            calls: device.calls.slice(log.calls),
            alerts: log.alerts,
        });
        log.writes = writes.length;
        log.device = dev.log.length;
        log.calls = device.calls.length;
        log.toasts = [];
        log.alerts = [];
        return out;
    };

    const labelText = (label: string) => (label.startsWith('k:') ? translate(label.slice(2)) : label);
    const perform = async ([kind, target, extra]: [string, ...unknown[]]) => {
        const drawn = layout();
        switch (kind) {
            case 'press': {
                const label = labelText(target as string);
                const found = drawn.controls.filter((entry) => entry.label === label || entry.label.split('|')[0] === label)[(extra as number | undefined) ?? 0];
                if (!found) throw new Error(`No control ${label}`);
                return found.press();
            }
            case 'switch':
                return drawn.switches[target as number].flip();
            case 'type':
                return drawn.inputs[target as number].type(extra as string);
            case 'alert': {
                const open = alert;
                alert = null;
                if (open && target !== null && labelText(target as string) === open.agree) await set(open.change, true);
                return undefined;
            }
            case 'backdrop':
                screen.timeout = false;
                screen.picker = null;
                return undefined;
            default:
                throw new Error(`Unknown action ${kind}`);
        }
    };

    await settle();
    const observations = [observe()];
    for (const action of scenario.actions) {
        await perform(action);
        await settle();
        observations.push(observe());
    }
    value(contract.closeAISettings());
    return observations;
}


type ActionsScenario = { name: string; screen: 'editor' | 'inbox' | 'review'; settings: string; taskId?: string; device: Device; actions: [string, ...unknown[]][] };
type ActionsFixture = {
    now: string;
    tasks: Task[];
    projects: Project[];
    settings: Record<string, AppSettings>;
    scenarios: ActionsScenario[];
    observations: Record<string, Record<string, unknown>[]>;
};
const actionsFixture: ActionsFixture = JSON.parse(readFileSync(new URL('./ai-actions-parity.fixtures.json', import.meta.url), 'utf8'));

async function replayActions(scenario: ActionsScenario, strings: Record<string, Record<string, string>>) {
    await seed({ tasks: actionsFixture.tasks, projects: actionsFixture.projects, settings: actionsFixture.settings[scenario.settings] });
    const dev = createDevice(scenario.device);
    const language = scenario.device.language ?? 'en';
    const translate = (key: string) => strings[language]?.[key] || strings.en[key] || key;
    const contract = await openHost(dev.host, language);
    const log = { alerts: [] as unknown[][], toasts: [] as unknown[][], writes: 0, calls: 0 };
    const events = () => {
        const out = { calls: device.calls.slice(log.calls), alerts: log.alerts, toasts: log.toasts, writes: writes.slice(log.writes), routes: [] };
        log.calls = device.calls.length;
        log.writes = writes.length;
        log.alerts = [];
        log.toasts = [];
        return out;
    };
    const shown = <Apply,>(result: NativeAIActionAnswer<Apply>) => {
        if (result.kind === 'alert') log.alerts.push([result.title, result.message]);
        if (result.kind === 'toast') log.toasts.push([result.toast.tone, result.toast.title, result.toast.message, result.toast.action.label, result.toast.durationMs]);
        return result.kind === 'dialog' ? result : null;
    };
    const dialogOf = (dialog: { title: string; message: string | null; choices: { label: string; variant: string | null }[] } | null) => (dialog
        ? { title: dialog.title, message: dialog.message, actions: dialog.choices.map((choice) => [choice.label, choice.variant]) }
        : null);
    const labelText = (label: string) => (label.startsWith('k:') ? translate(label.slice(2)) : label);
    const observations: unknown[] = [];

    if (scenario.screen === 'editor') {
        const id = scenario.taskId!;
        const task = useTaskStore.getState()._tasksById.get(id)!;
        let draft: TaskDraft = createTaskDraft(task);
        let checklist: ChecklistItem[] = task.checklist ?? [];
        let copilot: { suggestion: NativeAICopilotSuggestion | null; applied: NativeAICopilotApplied } = { suggestion: null, applied: { tags: [] } };
        let dialog: ReturnType<typeof shown> = null;
        let dialogKind: 'clarify' | 'breakdown' | null = null;

        let pending = true;
        const read = () => value(contract.getTaskEditorAI({ id, draft, copilot }));
        const typed = () => {
            pending = true;
            if (!read().copilot.request) copilot = { ...copilot, suggestion: null };
        };
        const observe = () => {
            const ai = read();
            return normalize({
                modal: dialogOf(dialog as never),
                working: false,
                parts: (ai.copilot.suggested?.parts ?? []).map((part) => ({ kind: part.kind, value: part.label })),
                applied: { context: copilot.applied.context ?? null, estimate: copilot.applied.timeEstimate ?? null, tags: copilot.applied.tags },
                draft: { title: draft.title, contexts: draft.contexts, tags: draft.tags, timeEstimate: draft.timeEstimate, status: draft.status },
                checklist: checklist.map((item) => [item.title, item.isCompleted]),
                ...events(),
            });
        };
        const edit = (next: NonNullable<ReturnType<typeof read>['copilot']['suggested']>['parts'][number]['edit']) => {
            draft = value(contract.editTaskDraft({ id, draft, edit: next })).draft;
        };
        observations.push(observe());
        for (const [kind, target] of scenario.actions) {
            switch (kind) {
                case 'wait': {
                    if (!pending) break;
                    pending = false;
                    if (!read().copilot.request) {
                        copilot = { ...copilot, suggestion: null };
                        break;
                    }
                    const result = value(await contract.requestTaskEditorCopilot({ id, draft }));
                    copilot = { ...copilot, suggestion: result.suggestion };
                    break;
                }
                case 'title':
                    draft = { ...draft, title: target as string };
                    typed();
                    break;
                case 'description':
                    draft = { ...draft, description: target as string };
                    typed();
                    break;
                case 'chip': {
                    const part = read().copilot.suggested!.parts.find((entry) => entry.label === target)!;
                    edit(part.edit);
                    copilot = { ...copilot, applied: part.applied };
                    break;
                }
                case 'applyAll': {
                    const all = read().copilot.suggested!;
                    const chosen = all.applyAll ?? all.parts[0];
                    edit(chosen.edit);
                    copilot = { ...copilot, applied: chosen.applied };
                    break;
                }
                case 'clarify':
                    dialog = shown(value(await contract.requestTaskEditorClarify({ id, draft })));
                    dialogKind = 'clarify';
                    break;
                case 'breakdown':
                    dialog = shown(value(await contract.requestTaskEditorBreakdown({ id, draft, checklist })));
                    dialogKind = 'breakdown';
                    break;
                case 'modal': {
                    const choice = (dialog as unknown as { choices: { label: string; apply: unknown }[] }).choices.find((entry) => entry.label === labelText(target as string))!;
                    if (choice.apply && dialogKind === 'clarify') edit(choice.apply as never);
                    if (choice.apply && dialogKind === 'breakdown') {
                        const added = choice.apply as { checklist: ChecklistItem[]; edit: never };
                        checklist = added.checklist;
                        if (added.edit) edit(added.edit);
                    }
                    dialog = null;
                    break;
                }
                case 'hide':
                    copilot = { suggestion: null, applied: { tags: [] } };
                    break;
                default:
                    throw new Error(`Unknown editor action ${kind}`);
            }
            await flushPendingSave();
            observations.push(observe());
        }
        return observations;
    }

    if (scenario.screen === 'inbox') {
        const started = value(contract.startInboxProcessing({}));
        const sessionId = started.sessionId!;
        let view = started.view!;
        let dialog: ReturnType<typeof shown> = null;
        const step = (edit?: never) => {
            view = value(contract.getInboxProcessingStep({ sessionId, taskId: view.taskId, step: view.step, ...(edit ? { edit } : {}) }));
        };
        const observe = () => normalize({
            taskId: view.taskId,
            modal: dialogOf(dialog as never),
            working: false,
            title: view.draft.title,
            contexts: view.draft.contexts,
            ...events(),
        });
        observations.push(observe());
        for (const [kind, target] of scenario.actions) {
            if (kind === 'clarify') {
                dialog = shown(value(await contract.requestInboxClarify({ sessionId, taskId: view.taskId, step: view.step })));
            } else if (kind === 'modal') {
                const choice = (dialog as unknown as { choices: { label: string; apply: unknown[] | null }[] }).choices.find((entry) => entry.label === labelText(target as string))!;
                for (const edit of choice.apply ?? []) step(edit as never);
                dialog = null;
            } else if (kind === 'title') {
                step({ type: 'set', field: 'title', value: target } as never);
            } else {
                throw new Error(`Unknown inbox action ${kind}`);
            }
            observations.push(observe());
        }
        return observations;
    }

    const review = { error: null as string | null, ran: false, suggestions: [] as { id: string; action: string; reason: string; title: string; taskRevision: string | null }[], selected: new Set<string>() };
    const observe = () => normalize({
        error: review.error,
        loading: false,
        ran: review.ran,
        suggestions: review.suggestions.map((entry) => [entry.id, entry.action, entry.reason, entry.title]),
        selected: Array.from(review.selected),
        ...events(),
    });
    observations.push(observe());
    for (const [kind, target] of scenario.actions) {
        if (kind === 'run') {
            review.ran = true;
            const result = value(await contract.requestWeeklyReviewAnalysis());
            review.error = result.error;
            if (result.suggestions) review.suggestions = result.suggestions;
            if (result.selectedIds) review.selected = new Set(result.selectedIds);
        } else if (kind === 'toggle') {
            const id = target as string;
            if (review.selected.has(id)) review.selected.delete(id);
            else review.selected.add(id);
        } else if (kind === 'apply') {
            const chosen = review.suggestions.filter((entry) => review.selected.has(entry.id));

            const taskRevisions = Object.fromEntries(chosen.flatMap((entry) => (entry.taskRevision ? [[entry.id, entry.taskRevision]] : [])));
            value(await contract.runReviewAction({
                requestId: generateUUID(),
                action: { type: 'applySuggestions', suggestions: chosen.map(({ id, action, reason }) => ({ id, action: action as never, reason })), taskRevisions },
            }));
        } else {
            throw new Error(`Unknown review action ${kind}`);
        }
        await flushPendingSave();
        observations.push(observe());
    }
    return observations;
}

describe('native host contract: AI', () => {
    const strings: Record<string, Record<string, string>> = {};
    const originalTz = process.env.TZ;
    beforeAll(async () => {
        process.env.TZ = 'UTC';
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(actionsFixture.now));
        strings.en = await loadTranslations('en');
        strings.de = await loadTranslations('de');
    });
    afterAll(() => {
        vi.useRealTimers();
        resetForTests();
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });

    it.each(settingsFixture.scenarios.map((scenario) => [scenario.name, scenario] as const))(
        'replays the frozen React Native Settings › AI scenario through the contract: %s',
        async (name, scenario) => {
            expect(await replaySettings(scenario, strings)).toEqual(settingsFixture.observations[name]);
        },
    );

    it.each(actionsFixture.scenarios.map((scenario) => [scenario.name, scenario] as const))(
        'replays the frozen React Native AI action through the contract: %s',
        async (name, scenario) => {
            expect(await replayActions(scenario, strings)).toEqual(actionsFixture.observations[name]);
        },
    );

    it('never journals a command that carries an API key', () => {
        for (const command of NATIVE_AI_UNJOURNALED_COMMANDS) expect(NATIVE_UNJOURNALED_COMMANDS.has(command)).toBe(true);
    });
});


describe('native host contract: AI commands replayed after a restart', () => {
    const originalTz = process.env.TZ;
    beforeAll(() => {
        process.env.TZ = 'UTC';
    });
    afterAll(() => {
        resetForTests();
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });

    const openFile = async (settings: AppSettings, input: Device = {}) => {
        const dev = createDevice(input);
        const env = await openSqliteHost({ settings }, undefined, { ai: dev.host });
        return { dev, env };
    };

    it('openAISettings: a landed FOSS correction answers its first reply and writes nothing again', async () => {
        const { dev, env } = await openFile({ ai: { provider: 'gemini', speechToText: { provider: 'openai' } } }, { foss: true });
        try {
            const input = { requestId: generateUUID() };
            value(await env.host.openAISettings(input));
            expect(useTaskStore.getState().settings.ai).toMatchObject({ provider: 'openai', model: 'llama3.2', speechToText: { provider: 'whisper' } });
            expect(await env.receiptIds()).toEqual([input.requestId]);
            const { result, wrote } = await env.replay((restarted) => restarted.openAISettings(input));
            expect(value(result).assistant.model.value).toBe('llama3.2');
            expect(wrote).toBe(false);
            expect(dev.log.filter((entry) => entry[0] === 'setItem')).toEqual([]);
        } finally {
            await env.close();
        }
    });

    it('setAISetting: a landed change answers its first reply and keeps a later change', async () => {
        const { env } = await openFile({ ai: { enabled: true, provider: 'openai' } });
        try {
            const input = { requestId: generateUUID(), change: { type: 'model' as const, value: 'gpt-5.6' } };
            expect(value(await env.host.setAISetting(input))).toEqual({ changed: true, consent: null, extraBodyDraft: null, toasts: [] });
            await useTaskStore.getState().updateSettings({ ai: { ...useTaskStore.getState().settings.ai, copilotModel: 'fast-one' } });
            await flushPendingSave();
            const { result, wrote } = await env.replay((restarted) => restarted.setAISetting(input));
            expect(value(result)).toEqual({ changed: true, consent: null, extraBodyDraft: null, toasts: [] });
            expect(wrote).toBe(false);
            expect(useTaskStore.getState().settings.ai).toMatchObject({ model: 'gpt-5.6', copilotModel: 'fast-one' });
        } finally {
            await env.close();
        }
    });

    it('setAISetting: without a receipt, a replay finds the target reached and writes nothing', async () => {
        await seed({ settings: { ai: { provider: 'openai' } } });
        const dev = createDevice({});
        const input = { requestId: generateUUID(), change: { type: 'reasoningEffort' as const, value: 'high' as const } };
        value(await (await openHost(dev.host)).setAISetting(input));
        const restarted = await openHost(dev.host);
        const before = useTaskStore.getState().settings;
        expect(value(await restarted.setAISetting(input))).toMatchObject({ changed: false });
        expect(useTaskStore.getState().settings).toBe(before);
    });

    it('setAISetting with consent: records the agreement once, and a replay records and writes nothing again', async () => {
        const { dev, env } = await openFile({ ai: { provider: 'anthropic' } });
        try {
            const change = { type: 'enabled' as const, value: true };
            const asked = value(await env.host.setAISetting({ requestId: generateUUID(), change }));
            expect(asked.changed).toBe(false);
            expect(asked.consent?.message).toContain('Anthropic (Claude)');
            expect(useTaskStore.getState().settings.ai?.enabled).toBeUndefined();
            const agreed = { requestId: generateUUID(), change, consent: true };
            expect(value(await env.host.setAISetting(agreed)).changed).toBe(true);
            expect(dev.storage.get('mindwtr-ai-provider-consent-v1')).toBe('{"anthropic":true}');
            const consentWrites = dev.log.length;
            const { result, wrote } = await env.replay((restarted) => restarted.setAISetting(agreed));
            expect(value(result).changed).toBe(true);
            expect(wrote).toBe(false);
            expect(dev.log.length).toBe(consentWrites);

            await useTaskStore.getState().updateSettings({ ai: { ...useTaskStore.getState().settings.ai, enabled: false } });
            expect(value(await env.host.setAISetting({ requestId: generateUUID(), change })).consent).toBeNull();
        } finally {
            await env.close();
        }
    });

    it('setAIKey: never on disk (no receipt, no key in any receipt), and a replay stores the same key', async () => {
        const { dev, env } = await openFile({ ai: { provider: 'openai' } });
        try {
            value(await env.host.openAISettings({ requestId: generateUUID() }));
            const input = { requestId: generateUUID(), field: 'assistant' as const, provider: 'openai', value: 'sk-secret-000111' };
            expect(value(await env.host.setAIKey(input))).toEqual({ mask: '•'.repeat(16) });
            expect(dev.secrets.get('mindwtr-ai-key_openai')).toBe('sk-secret-000111');

            expect(await env.host.setAIKey({ ...input, value: 'other' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            const rows = await env.sql<{ request_id: string; method: string; reply: string }>('SELECT request_id, method, reply FROM native_request_receipts');
            expect(rows.map((row) => row.request_id)).not.toContain(input.requestId);
            expect(JSON.stringify(rows)).not.toContain('sk-secret');
            const { result, wrote, receipts } = await env.replay((restarted) => restarted.setAIKey(input));
            expect(value(result)).toEqual({ mask: '•'.repeat(16) });
            expect({ wrote, receipts }).toEqual({ wrote: false, receipts: false });
            expect(dev.secrets.get('mindwtr-ai-key_openai')).toBe('sk-secret-000111');
        } finally {
            await env.close();
        }
    });

    it('setAIEndpoint: never on disk, and a replay finds the URL stored and writes nothing', async () => {
        const { env } = await openFile({ ai: { provider: 'openai' } });
        try {
            const input = { requestId: generateUUID(), field: 'assistant' as const, value: 'http://ann:pw-1@10.0.0.5:11434/v1' };
            expect(value(await env.host.setAIEndpoint(input))).toEqual({ changed: true });
            expect(useTaskStore.getState().settings.ai?.baseUrl).toBe(input.value);
            const rows = await env.sql<{ request_id: string; method: string; reply: string }>('SELECT request_id, method, reply FROM native_request_receipts');
            expect(JSON.stringify(rows)).not.toContain('pw-1');
            expect(rows.map((row) => row.request_id)).not.toContain(input.requestId);
            const { result, wrote, receipts } = await env.replay((restarted) => restarted.setAIEndpoint(input));
            expect(value(result)).toEqual({ changed: false });
            expect({ wrote, receipts }).toEqual({ wrote: false, receipts: false });

            expect(await env.host.setAIEndpoint({ requestId: generateUUID(), field: 'speech', value: 'http://stt' }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        } finally {
            await env.close();
        }
    });

    it('setAISetting: a replayed provider or thinking choice never resets what was chosen since', async () => {
        await seed({ settings: { ai: { provider: 'anthropic', thinkingBudget: 0, speechToText: { provider: 'gemini' } } } });
        const dev = createDevice({});
        const first = await openHost(dev.host);
        const thinking = { requestId: generateUUID(), change: { type: 'anthropicThinking' as const, value: true } };
        const speech = { requestId: generateUUID(), change: { type: 'speechProvider' as const, value: 'openai' as const } };
        value(await first.setAISetting(thinking));
        value(await first.setAISetting(speech));
        value(await first.setAISetting({ requestId: generateUUID(), change: { type: 'thinkingBudget', value: 4096 } }));
        value(await first.setAISetting({ requestId: generateUUID(), change: { type: 'speechModel', value: 'whisper-1' } }));
        const restarted = await openHost(dev.host);
        expect(value(await restarted.setAISetting(thinking)).changed).toBe(false);
        expect(value(await restarted.setAISetting(speech)).changed).toBe(false);
        expect(useTaskStore.getState().settings.ai).toMatchObject({ thinkingBudget: 4096, speechToText: { provider: 'openai', model: 'whisper-1' } });
    });

    it('openAISettings answered from its receipt still reads the Whisper model file', async () => {
        const dev = createDevice({});
        dev.host.whisper = {
            preferredModelUri: (modelId) => `file:///whisper/${modelId}.bin`,
            locate: async (modelId) => ({ exists: true, uri: `file:///whisper/${modelId}.bin`, size: 77691713 }),
        };
        const env = await openSqliteHost({ settings: { ai: { speechToText: { provider: 'whisper', model: 'whisper-tiny' } } } }, undefined, { ai: dev.host });
        try {
            const input = { requestId: generateUUID() };
            expect(value(await env.host.openAISettings(input)).speech.whisper?.status).toBe('Model downloaded - 74.1 MB');
            const { result } = await env.replay((restarted) => restarted.openAISettings(input));
            expect(value(result).speech.whisper?.status).toBe('Model downloaded - 74.1 MB');
        } finally {
            await env.close();
        }
    });

    it.each(['setAIKey', 'setAIEndpoint'] as const)('%s: A, then B, then A\'s request sent again in the same process keeps B', async (command) => {
        await seed({ settings: { ai: { provider: 'openai' } } });
        const dev = createDevice({});
        const contract = await openHost(dev.host);
        const send = (text: string, requestId: string) => (command === 'setAIKey'
            ? contract.setAIKey({ requestId, field: 'assistant', provider: 'openai', value: text })
            : contract.setAIEndpoint({ requestId, field: 'assistant', value: text }));
        const stored = () => (command === 'setAIKey' ? dev.secrets.get('mindwtr-ai-key_openai') : useTaskStore.getState().settings.ai?.baseUrl);
        const first = generateUUID();
        const answerA = value(await send('http://a/v1', first));
        value(await send('http://b/v1', generateUUID()));
        const writes = dev.log.length;
        expect(value(await send('http://a/v1', first))).toEqual(answerA);
        expect(stored()).toBe('http://b/v1');
        expect(dev.log.length).toBe(writes);
    });

    it('setAIKey: a provider the view no longer shows is refused', async () => {
        await seed({ settings: { ai: { provider: 'gemini' } } });
        const dev = createDevice({});
        const contract = await openHost(dev.host);
        expect(await contract.setAIKey({ requestId: generateUUID(), field: 'assistant', provider: 'openai', value: 'k' }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(await contract.setAIKey({ requestId: generateUUID(), field: 'speech', provider: 'whisper', value: 'k' }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(dev.secrets.size).toBe(0);
    });
});


describe('native host contract: AI keys stay out of views, errors and logs', () => {
    beforeAll(() => {
        process.env.TZ = 'UTC';
    });
    afterAll(() => {
        resetForTests();
    });

    it('shows a stored key only as dots', async () => {
        await seed({ settings: { ai: { provider: 'openai', speechToText: { provider: 'openai' } } } });
        const dev = createDevice({ secrets: { 'mindwtr-ai-key_openai': 'sk-live-424242' } });
        const contract = await openHost(dev.host);
        const view = value(await contract.openAISettings({ requestId: generateUUID() }));
        expect(JSON.stringify(view)).not.toContain('sk-live-424242');
        expect(view.assistant.panel.kind === 'openai' && view.assistant.panel.apiKey.mask).toBe('•'.repeat(14));
        expect(view.speech.apiKey?.mask).toBe('•'.repeat(14));
    });

    it('drops the key and the endpoint password from an error and its log line', async () => {
        const settings: AppSettings = { ai: { enabled: true, provider: 'openai', baseUrl: 'http://ann:pw-9x7@10.0.0.5:11434/v1' } };
        const tasks = [{ id: 't1', title: 'Plan the trip', status: 'next', contexts: [], tags: [], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }] as Task[];
        await seed({ tasks, settings });
        const warned: unknown[][] = [];
        const dev = createDevice({
            secrets: { 'mindwtr-ai-key_openai': 'home-key-77' },
            queues: { clarifyTask: [{ error: 'Upstream 401 for http://ann:pw-9x7@10.0.0.5:11434/v1 with key home-key-77' }] },
        }, warned);
        const contract = await openHost(dev.host);
        const draft = createTaskDraft(useTaskStore.getState()._tasksById.get('t1')!);
        const result = value(await contract.requestTaskEditorClarify({ id: 't1', draft }));
        const text = JSON.stringify([result, warned]);
        expect(result.kind).toBe('alert');
        expect(text).toContain('Upstream 401');
        expect(text).not.toContain('home-key-77');
        expect(text).not.toContain('pw-9x7');
    });


    it('drops the password the request was sent with, though the endpoint changed while it waited', async () => {
        const settings: AppSettings = { ai: { enabled: true, provider: 'openai', baseUrl: 'http://ann:pw-old-1@10.0.0.5:11434/v1' } };
        const tasks = [{ id: 't1', title: 'Plan the trip', status: 'next', contexts: [], tags: [], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }] as Task[];
        await seed({ tasks, settings });
        const warned: unknown[][] = [];
        const changed = async () => {
            await useTaskStore.getState().updateSettings({ ai: { ...useTaskStore.getState().settings.ai, baseUrl: 'http://ann:pw-new-2@10.0.0.6:11434/v1' } });
            return { error: 'Upstream 401: the password pw-old-1 is wrong' };
        };
        const dev = createDevice({ queues: { clarifyTask: [changed], analyzeReview: [changed] } }, warned);
        const contract = await openHost(dev.host);
        const draft = createTaskDraft(useTaskStore.getState()._tasksById.get('t1')!);
        const result = value(await contract.requestTaskEditorClarify({ id: 't1', draft }));
        expect(result.kind).toBe('alert');
        expect(JSON.stringify([result, warned])).toContain('Upstream 401');
        expect(JSON.stringify([result, warned])).not.toContain('pw-old-1');
        await useTaskStore.getState().updateSettings({ ai: { ...useTaskStore.getState().settings.ai, baseUrl: 'http://ann:pw-old-1@10.0.0.5:11434/v1' } });
        const tasksStale = [{ ...tasks[0], updatedAt: '2026-01-01T00:00:00.000Z' }] as Task[];
        await seed({ tasks: tasksStale, settings });
        const analysis = value(await (await openHost(createDevice({ queues: { analyzeReview: [changed] } }, warned).host)).requestWeeklyReviewAnalysis());
        expect(analysis.error).toContain('Upstream 401');
        expect(JSON.stringify([analysis, warned])).not.toContain('pw-old-1');
    });

    it('sends the same sequence-aware stale snapshot the wizard shows, including Per-section flow', async () => {
        const stamp = '2026-01-01T00:00:00.000Z';
        const project: Project = { id: 'p', title: 'Project', status: 'active', color: '#000000', order: 0, tagIds: [], perSectionFlow: true, createdAt: stamp, updatedAt: stamp };
        const section: Section = { id: 's', projectId: 'p', title: 'Sequence', order: 0, isSequential: true, createdAt: stamp, updatedAt: stamp };
        const task = (id: string, status: Task['status'], order: number): Task => ({ id, title: id, projectId: 'p', sectionId: 's', status, order, contexts: [], tags: [], createdAt: stamp, updatedAt: stamp });
        await seed({ tasks: [task('head', 'waiting', 0), task('tail', 'next', 1)], projects: [project], sections: [section], settings: { ai: { enabled: true, provider: 'openai', baseUrl: 'http://local/v1' } } });
        const dev = createDevice({ queues: { analyzeReview: [{ value: { suggestions: [] } }] } });
        const info = vi.fn();
        dev.host.log!.info = info;
        const host = await openHost(dev.host);
        const wizard = value(host.getWeeklyReview({ checkpoint: JSON.stringify({ step: 'stale', startedAt: new Date().toISOString() }), offset: 0, limit: 100 }));
        expect(wizard.content.step).toBe('stale');
        expect(wizard.items.filter((item) => item.type === 'task').map((item) => item.row.id)).toEqual(['head']);
        await host.requestWeeklyReviewAnalysis();
        const request = device.calls.find((call) => call[1] === 'analyzeReview')!;
        expect((request[3] as { items: { id: string }[] }).items.map((item) => item.id)).toEqual(['head', 'project:p']);
        expect(info).toHaveBeenCalledWith('Weekly review sequence candidates prepared', { scope: 'ai', extra: { releaseCheck: 'v1.3.8/review-sequence', candidateCount: 2, staleTaskCount: 1, staleProjectCount: 1 } });
    });


    it('gives each suggestion the revision the analysis read, so Apply refuses a task changed while it waited', async () => {
        const tasks = [{ id: 's1', title: 'Old errand', status: 'next', contexts: [], tags: [], rev: 3, revBy: 'this', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }] as Task[];
        await seed({ tasks, settings: { ai: { enabled: true, provider: 'openai', baseUrl: 'http://local/v1' } } });
        const installNewer = async () => {
            const state = useTaskStore.getState();
            const newer = { ...state._tasksById.get('s1')!, rev: 4, revBy: 'other-device' } as Task;
            const swap = (list: Task[]) => list.map((task) => (task.id === 's1' ? newer : task));
            useTaskStore.setState({ _allTasks: swap(state._allTasks), tasks: swap(state.tasks), _tasksById: new Map(state._tasksById).set('s1', newer) } as never);
            return { value: { suggestions: [{ id: 's1', action: 'someday', reason: 'Stale' }] } };
        };
        const contract = await openHost(createDevice({ queues: { analyzeReview: [installNewer] } }).host);
        const analysis = value(await contract.requestWeeklyReviewAnalysis());
        const suggestion = analysis.suggestions!.find((entry) => entry.id === 's1')!;
        expect(suggestion.taskRevision).toBe('3:this:2026-01-01T00:00:00.000Z');
        const applied = await contract.runReviewAction({
            requestId: generateUUID(),
            action: { type: 'applySuggestions', suggestions: [{ id: 's1', action: 'someday', reason: 'Stale' }], taskRevisions: { s1: suggestion.taskRevision! } },
        });
        expect(applied).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(useTaskStore.getState()._tasksById.get('s1')!.status).toBe('next');
    });


    it('hands the caller\'s abort signal to each provider call and to the model list\'s fetch', async () => {
        const tasks = [{ id: 't1', title: 'Plan the trip', status: 'next', contexts: [], tags: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }] as Task[];
        await seed({ tasks, settings: { ai: { enabled: true, provider: 'openai', baseUrl: 'http://local/v1' } } });
        const dev = createDevice({ queues: { clarifyTask: [{ error: 'x' }], breakDownTask: [{ error: 'x' }], predictMetadata: [{ error: 'x' }, { error: 'x' }], analyzeReview: [{ error: 'x' }], models: [{ value: [] }] } });
        const seen: RequestInit[] = [];
        dev.host.fetch = (async (_url: string, init: RequestInit) => { seen.push(init); return new Response('{}'); }) as typeof fetch;
        const contract = await openHost(dev.host);
        const draft = createTaskDraft(useTaskStore.getState()._tasksById.get('t1')!);
        const signal = new AbortController().signal;
        device.signals.length = 0;
        await contract.requestTaskEditorClarify({ id: 't1', draft }, { signal });
        await contract.requestTaskEditorBreakdown({ id: 't1', draft, checklist: [] }, { signal });
        await contract.requestTaskEditorCopilot({ id: 't1', draft }, { signal });
        await contract.requestAICopilot({ request: { title: 'Plan the trip', contexts: [], tags: [] } }, { signal });
        await contract.requestWeeklyReviewAnalysis({ signal });
        expect(device.signals).toEqual([signal, signal, signal, signal, signal]);
        const view = value(await contract.openAISettings({ requestId: generateUUID() }));
        const aborting = new AbortController();
        value(await contract.loadAIModels({ list: 'assistant', request: view.modelLists.assistant.request! }, { signal: aborting.signal }));
        await device.modelFetch!('http://local/v1/models', {});
        aborting.abort();
        expect(seen[0].signal?.aborted).toBe(true);
    });


    it('fetches a model list again after its earlier load was cancelled (endpoint A, B, then A while A loads)', async () => {
        await seed({ settings: { ai: { enabled: true, provider: 'openai', baseUrl: 'http://a/v1' } } });
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        const dev = createDevice({ queues: { models: [async () => { await held; return { error: 'aborted' }; }, { value: ['a-model'] }] } });
        dev.secrets.set('mindwtr-ai-key_openai', 'sk-1');
        const contract = await openHost(dev.host);
        let view = value(await contract.openAISettings({ requestId: generateUUID() }));
        const atA = view.modelLists.assistant.request!;
        const first = new AbortController();
        const loading = contract.loadAIModels({ list: 'assistant', request: atA }, { signal: first.signal });
        await new Promise((resolve) => setTimeout(resolve, 0));
        value(await contract.setAIEndpoint({ requestId: generateUUID(), field: 'assistant', value: 'http://b/v1' }));
        expect(value(contract.getAISettings()).modelLists.assistant.request).not.toBe(atA);
        value(await contract.setAIEndpoint({ requestId: generateUUID(), field: 'assistant', value: 'http://a/v1' }));
        expect(value(contract.getAISettings()).modelLists.assistant.request).toBe(atA);

        first.abort();
        view = value(await contract.loadAIModels({ list: 'assistant', request: atA }, { signal: new AbortController().signal }));
        release();
        await loading;
        expect(device.calls.filter((call) => call[0] === 'fetchModels')).toHaveLength(2);
        expect(JSON.stringify(view)).toContain('a-model');
    });

    it('answers an unreadable keystore with an alert, and the screen shows no key', async () => {
        const tasks = [{ id: 't1', title: 'Plan the trip', status: 'next', contexts: [], tags: [], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }] as Task[];
        await seed({ tasks, settings: { ai: { enabled: true, provider: 'gemini' } } });
        const warned: unknown[][] = [];
        const dev = createDevice({}, warned);
        dev.host.secrets.get = async () => { throw new Error('Keystore locked'); };
        const contract = await openHost(dev.host);
        const draft = createTaskDraft(useTaskStore.getState()._tasksById.get('t1')!);
        expect(value(await contract.requestTaskEditorClarify({ id: 't1', draft }))).toMatchObject({ kind: 'alert', message: expect.stringContaining('Keystore locked') });
        const view = value(await contract.openAISettings({ requestId: generateUUID() }));
        expect(view.assistant.panel.kind === 'gemini' && view.assistant.panel.apiKey.mask).toBe('');
        expect(warned).toContainEqual(['logWarn', 'Failed to load AI key']);
    });

    it('asks the copilot for another screen\'s question only while AI is on with the key it needs', async () => {
        const request = { title: 'Call the bank', contexts: ['@phone'], tags: [] };
        await seed({ settings: { ai: { enabled: true, provider: 'gemini' } } });
        const dev = createDevice({ queues: { predictMetadata: [{ value: { context: '@phone', timeEstimate: '5min' } }] } });
        const contract = await openHost(dev.host);
        expect(value(await contract.requestAICopilot({ request }))).toEqual({ suggestion: null });
        expect(device.calls).toEqual([]);
        dev.secrets.set('mindwtr-ai-key_gemini', 'gem-1');
        expect(value(await contract.requestAICopilot({ request }))).toEqual({ suggestion: { context: '@phone', timeEstimate: '5min' } });
        expect(device.calls).toEqual([['ai', 'predictMetadata', expect.objectContaining({ provider: 'gemini', apiKey: 'gem-1' }), request]]);
    });

    it('Break down on a finished list task reopens it through a status edit, as React Native does', async () => {
        const tasks = [{
            id: 'l1', title: 'Pack', status: 'done', taskMode: 'list', contexts: [], tags: [], checklist: [{ id: 'c1', title: 'Passport', isCompleted: true }],

            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        }] as Task[];
        await seed({ tasks, settings: { ai: { enabled: true, provider: 'openai', baseUrl: 'http://local/v1' } } });
        const dev = createDevice({ queues: { breakDownTask: [{ value: { steps: ['Charger'] } }] } });
        const contract = await openHost(dev.host);
        const task = useTaskStore.getState()._tasksById.get('l1')!;
        const answered = value(await contract.requestTaskEditorBreakdown({ id: 'l1', draft: createTaskDraft(task), checklist: task.checklist! }));
        const add = answered.kind === 'dialog' ? answered.choices[1].apply : null;
        expect(add).toEqual({
            checklist: [{ id: 'c1', title: 'Passport', isCompleted: true }, { id: expect.any(String), title: 'Charger', isCompleted: false }],
            edit: { type: 'fields', patch: { status: 'next' } },
        });
    });

    it('Process Inbox\'s Clarify only adds its context, never takes one away', async () => {
        const tasks = [{ id: 'i1', title: 'Gift', status: 'inbox', contexts: ['@calls'], tags: [], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }] as Task[];
        await seed({ tasks, settings: { ai: { enabled: true, provider: 'openai', baseUrl: 'http://local/v1' } } });
        const suggestion = { value: { question: 'Next?', options: [], suggestedAction: { title: 'Call Sam', context: '@calls' } } };
        const dev = createDevice({ queues: { clarifyTask: [suggestion] } });
        const contract = await openHost(dev.host);
        const started = value(contract.startInboxProcessing({}));
        let view = started.view!;
        const answered = value(await contract.requestInboxClarify({ sessionId: started.sessionId!, taskId: view.taskId, step: view.step }));
        const edits = answered.kind === 'dialog' ? answered.choices.find((choice) => choice.variant === 'primary')!.apply! : [];
        for (const edit of edits) view = value(contract.getInboxProcessingStep({ sessionId: started.sessionId!, taskId: view.taskId, step: view.step, edit }));
        expect(view.draft).toMatchObject({ title: 'Call Sam', contexts: ['@calls'] });
    });


    it('names Process Inbox\'s Clarify button while AI is on, and no button while it is off', async () => {
        const tasks = [{ id: 'i1', title: 'Gift', status: 'inbox', tags: [], contexts: [], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }] as Task[];
        await seed({ tasks, settings: { ai: { enabled: true, provider: 'openai' } } });
        const contract = await openHost(createDevice({}).host);
        expect(value(contract.startInboxProcessing({})).view!.aiClarify).toEqual({ label: 'AI clarify', working: 'Working...' });
        await seed({ tasks, settings: { ai: { enabled: false, provider: 'openai' } } });
        const off = await openHost(createDevice({}).host);
        expect(value(off.startInboxProcessing({})).view!.aiClarify).toBeNull();
    });

    it('answers ACTION_FAILED without a bound AI host, and sends nothing', async () => {
        await seed({ settings: { ai: { enabled: true, provider: 'openai' } } });
        device.calls.length = 0;
        const bare = createNativeHostContract();
        value(await bare.setLanguage({ storedLanguage: 'en', systemLocale: null }));
        value(await bare.activate({ writeSafetyReady: true }));
        expect(await bare.requestWeeklyReviewAnalysis()).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        expect(await bare.openAISettings({ requestId: generateUUID() })).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        expect(device.calls).toEqual([]);
    });
});
