import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CaptureModalCopilotSuggestion, CaptureModalDraft, CaptureModalParams } from './capture-modal-model';
import { configureDateFormatting } from './date';
import { createNativeHostContract } from './native-host-contract';
import type { NativeCaptureModalClose, NativeCaptureModalSubmitResult, NativeCaptureModalView } from './native-host-contract-capture-modal';
import { openScreenHost, openSqliteHost, requestId, restartScreenHost, value } from './screen-parity.replay';
import { requestRowId } from './native-request-receipts';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppSettings, Area, Project, Task } from './types';

/**
 * React Native's capture confirmation screen, frozen by
 * apps/mobile/tests/capture-modal.parity.test.tsx, replayed through the native
 * host contract: the host keeps what React Native keeps outside core (the
 * route params, the draft, the open question, where it can go back to).
 */
type Action =
    | ['type', string] | ['description', string] | ['help'] | ['save'] | ['saveAndEdit'] | ['cancel'] | ['back']
    | ['confirmBulk'] | ['cancelBulk'] | ['applyCopilot', string] | ['applyAllCopilot'] | ['refuseWrites', boolean];
type Scenario = {
    name: string;
    params: CaptureModalParams;
    settings: string;
    canGoBack: boolean;
    suggestions?: Record<string, CaptureModalCopilotSuggestion>;
    actions: Action[];
};
type Screen = { texts: string[]; fields: { placeholder: string; value: string }[]; preview: unknown[]; controls: { label: string; disabled: boolean }[] };
type Observation = { writes: unknown[]; toasts: unknown[]; navigation: unknown[]; ai: unknown[]; screen: Screen | null };
type Fixture = {
    now: string;
    timeZone: string;
    tasks: Task[];
    projects: Project[];
    areas: Area[];
    settings: Record<string, AppSettings>;
    scenarios: Scenario[];
    observations: Record<string, Observation[]>;
};

const fixture = JSON.parse(readFileSync(new URL('./capture-modal-parity.fixtures.json', import.meta.url), 'utf8')) as Fixture;

// ---------------------------------------------------------------------------
// The store, recorded as the React Native harness records it

type Real = Pick<ReturnType<typeof useTaskStore.getState>, 'addTask' | 'addTasks' | 'addProject'>;
let real: Real | null = null;
const createdIds = new Map<string, string>();
const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, entry) => (
    // The native host's items carry their capture UUID; React Native's carry none.
    key === 'captureId' ? undefined : entry === undefined ? '<undefined>' : entry
)).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (match) => createdIds.get(match) ?? '<uuid>'));
const encode = (args: unknown[]) => normalize(args.map((arg) => (
    arg && typeof arg === 'object' && !Array.isArray(arg)
        ? Object.fromEntries(Object.entries(arg).map(([key, entry]) => [key, entry === undefined ? '<undefined>' : entry]))
        : arg
)));

async function openReplayHost(settings: AppSettings, refuse: () => boolean) {
    await flushPendingSave();
    resetForTests();
    createdIds.clear();
    const initial = useTaskStore.getState();
    real ??= { addTask: initial.addTask, addTasks: initial.addTasks, addProject: initial.addProject };
    const actions = real;
    const data = JSON.parse(JSON.stringify({ tasks: fixture.tasks, projects: fixture.projects, sections: [], areas: fixture.areas, people: [], settings }));
    setStorageAdapter({ getData: async () => data, saveData: async () => undefined });
    useTaskStore.setState({
        ...actions,
        _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
    } as never);
    const host = createNativeHostContract();
    value(await host.setLanguage({ storedLanguage: 'en', systemLocale: null }));
    value(await host.activate({ writeSafetyReady: true }));
    const log: unknown[] = [];
    useTaskStore.setState({
        addTask: async (title, props, options) => {
            log.push(['addTask', ...encode([title, props]) as unknown[]]);
            if (refuse()) return { success: false, error: 'Disk full' };
            const result = await actions.addTask(title, props, options);
            if (result.id) createdIds.set(result.id, `<created:${title}>`);
            return result;
        },
        addTasks: async (items) => {
            log.push(['addTasks', ...encode([items]) as unknown[]]);
            if (refuse()) return { success: false, error: 'Disk full' };
            const result = await actions.addTasks(items);
            result.ids?.forEach((id, index) => createdIds.set(id, `<created:${items[index]?.title}>`));
            return result;
        },
        addProject: async (title, color, props) => {
            // The native host names a capture's project by its request (requestRowId); React Native's store picks the id.
            const { id: _requestDerived, ...shown } = props ?? {};
            log.push(['addProject', ...encode([title, color, Object.keys(shown).length > 0 ? shown : undefined]) as unknown[]]);
            const created = await actions.addProject(title, color, props);
            if (created) createdIds.set(created.id, `<created-project:${title}>`);
            return created;
        },
    });
    return { host, log };
}

// ---------------------------------------------------------------------------
// The screen as React Native lays it out, from the view

type Question = Extract<NativeCaptureModalSubmitResult, { kind: 'confirmLines' }>['confirm'];

function screenOf(view: NativeCaptureModalView, question: Question | null): Screen {
    const { copilot } = view;
    return {
        texts: [
            ...(view.sandboxCue ? [view.sandboxCue] : []),
            view.title,
            view.help.toggle,
            ...(view.attachments ? [view.attachments.label, ...view.attachments.titles] : []),
            ...(view.description ? [view.description.label] : []),
            ...(copilot.suggested
                ? [copilot.suggested.label, ...copilot.suggested.parts.map((part) => part.label), ...(copilot.suggested.applyAll ? [copilot.suggested.applyAll.label] : []), copilot.suggested.hint]
                : []),
            ...(copilot.applied !== null ? [copilot.applied] : []),
            ...(view.help.text ? [view.help.text] : []),
            ...(view.error ? [view.error] : []),
            view.actions.cancel, view.actions.saveAndEdit, view.actions.save,
            ...(question ? [question.title, question.message, question.cancelLabel, question.confirmLabel] : []),
        ],
        fields: [
            { placeholder: view.input.placeholder, value: view.input.value },
            ...(view.description ? [{ placeholder: view.description.placeholder, value: view.description.value }] : []),
        ],
        preview: view.preview,
        controls: [
            view.help.toggle,
            ...(copilot.suggested ? [...copilot.suggested.parts.map((part) => part.label), ...(copilot.suggested.applyAll ? [copilot.suggested.applyAll.label] : [])] : []),
            view.actions.cancel, view.actions.saveAndEdit, view.actions.save,
            // The question's Cancel and Create tasks, then its backdrop.
            ...(question ? [question.cancelLabel, question.confirmLabel, question.cancelLabel] : []),
        ].map((label) => ({ label, disabled: false })),
    };
}

/** Shared files wait for the attachments pass on the native host: React Native's are left out of its observations. */
function withoutSharedFiles(observation: Observation): Observation {
    const drop = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, entry) => (key === 'attachments' ? undefined : entry)));
    const screen = observation.screen;
    if (!screen) return { ...observation, writes: drop(observation.writes) as unknown[] };
    const texts = [...screen.texts];
    const start = texts.indexOf('Attachments');
    if (start >= 0) {
        let end = start + 1;
        while (end < texts.length && texts[end] !== 'Description' && texts[end] !== 'Cancel') end += 1;
        texts.splice(start, end - start);
    }
    return { ...observation, writes: drop(observation.writes) as unknown[], screen: { ...screen, texts } };
}

async function replay(scenario: Scenario): Promise<Observation[]> {
    let refuse = false;
    vi.setSystemTime(new Date(fixture.now));
    const { host, log } = await openReplayHost(withLocalAIEndpoint(fixture.settings[scenario.settings]), () => refuse);
    const { params } = scenario;
    const opened = value(host.openCaptureModal({ params }));
    let draft: CaptureModalDraft = opened.draft;
    let view = opened.view;
    let question: Question | null = null;
    let closed = false;
    const toasts: unknown[] = [];
    const navigation: unknown[] = [];
    const ai: unknown[] = [];
    const edit = (next: unknown) => {
        const result = value(host.editCaptureModal({ params, draft, edit: next as never }));
        draft = result.draft;
        view = result.view;
    };
    // React Native asks the AI when the screen opens and whenever the title changes.
    const askAI = () => {
        const request = view.copilot.request;
        if (!request) return;
        ai.push(['predictMetadata', request]);
        edit({ type: 'setSuggestion', title: request.title, suggestion: scenario.suggestions?.[request.title] ?? {} });
    };
    const close = (target: NativeCaptureModalClose) => {
        navigation.push(scenario.canGoBack ? ['back'] : ['replace', target.returnTo ?? '/inbox']);
        if (target.returnToPreviousApp) navigation.push(['returnToPreviousApp']);
        closed = true;
    };
    const observe = (): Observation => {
        if (!closed) view = value(host.getCaptureModalView({ params, draft }));
        return normalize({
            writes: log.splice(0),
            toasts: toasts.splice(0),
            navigation: navigation.splice(0),
            ai: ai.splice(0),
            screen: closed ? null : screenOf(view, question),
        }) as Observation;
    };
    askAI();
    const observations = [observe()];
    for (const [index, action] of scenario.actions.entries()) {
        vi.setSystemTime(new Date(Date.parse(fixture.now) + (index + 1) * 1000));
        switch (action[0]) {
            case 'type': {
                const changed = action[1] !== draft.text;
                edit({ type: 'setText', value: action[1] });
                if (changed) askAI();
                break;
            }
            case 'description': edit({ type: 'setDescription', value: action[1] }); break;
            case 'help': edit(view.help.edit); break;
            case 'save':
            case 'saveAndEdit': {
                const result = await host.submitCaptureModal({ params, draft, captureId: requestId(), openAfterSave: action[0] === 'saveAndEdit' });
                if (result.ok && (result.value.kind === 'nothing' || result.value.kind === 'confirmLines')) {
                    if (result.value.kind === 'confirmLines') question = result.value.confirm;
                    break;
                }
                // A save starts: the card's failure clears, and returns when this one fails.
                draft = { ...draft, failed: !result.ok };
                if (!result.ok) break;
                const saved = result.value;
                if (saved.kind === 'refused') toasts.push([saved.notice.tone, saved.notice.title, saved.notice.message, saved.notice.durationMs]);
                if (saved.kind !== 'saved') break;
                if (saved.next === 'open') {
                    navigation.push(['openTaskScreen', saved.taskId, saved.projectId ?? undefined, 'task', { replace: true }]);
                    closed = true;
                } else {
                    if (saved.next === 'openInProject') navigation.push(['stashPendingCaptureTaskOpen', { taskId: saved.taskId, projectId: saved.projectId, taskTab: 'task' }]);
                    close(saved.close!);
                }
                break;
            }
            case 'confirmBulk': {
                const lineCount = question ? Number(/\d+/.exec(question.title)?.[0]) : 0;
                question = null;
                const result = await host.submitCaptureModalLines({ params, draft, captureIds: Array.from({ length: lineCount }, () => requestId()) });
                draft = { ...draft, failed: !result.ok };
                if (!result.ok) break;
                if (result.value.kind === 'refused') {
                    const { notice } = result.value;
                    toasts.push([notice.tone, notice.title, notice.message, notice.durationMs]);
                } else {
                    close(result.value.close);
                }
                break;
            }
            case 'cancelBulk': question = null; break;
            case 'back':
                if (question) question = null;
                else {
                    navigation.push(['systemBack']);
                    closed = true;
                }
                break;
            case 'cancel': close(value(host.discardCaptureModal({ params })).close); break;
            case 'applyCopilot': edit(view.copilot.suggested!.parts.find((part) => part.label === action[1])!.edit); break;
            case 'applyAllCopilot': edit(view.copilot.suggested!.applyAll!.edit); break;
            case 'refuseWrites': refuse = action[1]; break;
            default: throw new Error(`Unknown action ${JSON.stringify(action)}`);
        }
        observations.push(observe());
    }
    return observations;
}

/**
 * The AI at a local OpenAI-compatible endpoint, which needs no key. The fixture's React
 * Native screen held a key for its provider; this host keeps no AI key until pass AI1.
 */
const withLocalAIEndpoint = (settings: AppSettings): AppSettings => (
    settings.ai?.enabled ? { ...settings, ai: { ...settings.ai, baseUrl: 'http://127.0.0.1:11434/v1' } } : settings
);

/** A capture link naming a note, a tag and a project no project carries. */
const linkParams: CaptureModalParams = {
    initialValue: 'Plan%20trip',
    initialProps: encodeURIComponent(JSON.stringify({ description: 'Book flights', tags: ['#travel'] })),
    project: 'Shopping',
};

describe('native host contract: the capture confirmation screen', () => {
    const originalTz = process.env.TZ;
    beforeAll(() => {
        process.env.TZ = fixture.timeZone;
    });
    afterAll(() => {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });
    afterEach(async () => {
        vi.useRealTimers();
        configureDateFormatting();
        await flushPendingSave();
        resetForTests();
    });

    it("replays React Native's frozen screen: what it shows, writes, says and where it goes", async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        for (const scenario of fixture.scenarios) {
            const frozen = fixture.observations[scenario.name].map(withoutSharedFiles);
            expect({ [scenario.name]: await replay(scenario) }).toEqual({ [scenario.name]: frozen });
        }
    }, 120_000);

    // -----------------------------------------------------------------------
    // Crash safety: every command, replayed on a new host after a restart

    const data = { tasks: fixture.tasks, projects: fixture.projects, areas: fixture.areas, settings: fixture.settings.ai };
    const storeData = () => {
        const state = useTaskStore.getState();
        return [state._allTasks, state._allProjects, state._allSections, state._allAreas, state._allPeople, state.settings];
    };
    /** Runs a command on a new host, as after a restart, and says whether the store changed. */
    const afterRestart = async <T,>(run: (host: Awaited<ReturnType<typeof restartScreenHost>>) => Promise<T> | T) => {
        const host = await restartScreenHost();
        const before = storeData();
        const result = await run(host);
        return { result, wrote: storeData().some((entry, index) => entry !== before[index]) };
    };

    it('reads the same screen after a restart and writes nothing: open, view, edit and discard', async () => {
        const log: unknown[][] = [];
        const host = await openScreenHost({ data, record: { addTask: 2, addTasks: 1, addProject: 1 }, log });
        const opened = value(host.openCaptureModal({ params: linkParams }));
        expect(opened.draft).toEqual({ text: 'Plan trip', description: 'Book flights', showHelp: false, suggestion: null, applied: { tags: [] }, failed: false });
        const help = value(host.editCaptureModal({ params: linkParams, draft: opened.draft, edit: opened.view.help.edit }));
        const discarded = value(host.discardCaptureModal({ params: linkParams }));
        expect(discarded).toEqual({ close: { returnTo: null, returnToPreviousApp: false } });

        const replayed = await afterRestart(async (restarted) => [
            value(restarted.openCaptureModal({ params: linkParams })),
            value(restarted.getCaptureModalView({ params: linkParams, draft: opened.draft })),
            value(restarted.editCaptureModal({ params: linkParams, draft: opened.draft, edit: opened.view.help.edit })),
            value(restarted.discardCaptureModal({ params: linkParams })),
        ]);
        // The views' revision names the data and the minute; the rest must be equal.
        const unrevised = (value: unknown) => JSON.parse(JSON.stringify(value, (key, entry) => (key === 'revision' ? undefined : entry)));
        expect(replayed.wrote).toBe(false);
        expect(unrevised(replayed.result)).toEqual(unrevised([opened, opened.view, help, discarded]));
        expect(log).toEqual([]);
    });

    it("names the project a project's + opened the screen from, so the host opens it again on close, also after a restart", async () => {
        const fromProject = (projectId: string): CaptureModalParams => ({
            initialProps: JSON.stringify({ projectId, status: 'next' }),
            returnTo: `/projects-screen?projectId=${encodeURIComponent(projectId)}`,
        });
        const host = await openScreenHost({ data, record: { addTask: 2 }, log: [] });
        const params = fromProject('p-launch');
        const opened = value(host.openCaptureModal({ params }));
        expect(value(host.discardCaptureModal({ params }))).toEqual({ close: { returnTo: params.returnTo, returnToPreviousApp: false, returnToProjectId: 'p-launch' } });
        // The params ride the screen's file: after a restart the preset (the project, status Next) and the way back are core's again.
        const restarted = await restartScreenHost();
        const saved = value(await restarted.submitCaptureModal({ params, draft: { ...opened.draft, text: 'Order parts' }, captureId: requestId() }));
        expect(saved).toMatchObject({ kind: 'saved', projectId: 'p-launch', next: 'close', close: { returnToProjectId: 'p-launch' } });
        expect(useTaskStore.getState()._tasksById.get((saved as { taskId: string }).taskId)).toMatchObject({ title: 'Order parts', projectId: 'p-launch', status: 'next' });
        // Save & edit leaves the editor to the project screen it reopens (#938).
        expect(value(await restarted.submitCaptureModal({ params, draft: { ...opened.draft, text: 'Call shop' }, captureId: requestId(), openAfterSave: true })))
            .toMatchObject({ next: 'openInProject', projectId: 'p-launch' });
        // A project gone since is not reopened; another screen's params name none.
        expect(value(restarted.discardCaptureModal({ params: fromProject('p-gone') })).close).toEqual({ returnTo: '/projects-screen?projectId=p-gone', returnToPreviousApp: false });
        expect(value(restarted.discardCaptureModal({ params: linkParams })).close).toEqual({ returnTo: null, returnToPreviousApp: false });
    });

    it('saves under the capture UUID; a retry, or a replay after a restart, writes nothing more', async () => {
        const log: unknown[][] = [];
        const host = await openScreenHost({ data, record: { addTask: 2, addProject: 1 }, log });
        const { draft } = value(host.openCaptureModal({ params: linkParams }));
        const input = { params: linkParams, draft, captureId: requestId() };
        const saved = value(await host.submitCaptureModal(input));
        expect(saved).toEqual({
            kind: 'saved', taskId: input.captureId, projectId: expect.any(String), next: 'close',
            close: { returnTo: null, returnToPreviousApp: false },
        });
        expect(log.map(([name]) => name)).toEqual(['addProject', 'addTask']);
        expect(value(await host.submitCaptureModal(input))).toEqual(saved);

        const replayed = await afterRestart((restarted) => restarted.submitCaptureModal(input));
        expect(replayed).toEqual({ result: { ok: true, value: saved }, wrote: false });
        expect(log).toHaveLength(2);
        const task = useTaskStore.getState()._allTasks.find((entry) => entry.id === input.captureId);
        expect(task).toMatchObject({ title: 'Plan trip', description: 'Book flights', tags: ['#travel'] });
        expect(useTaskStore.getState()._allProjects.filter((project) => project.title === 'Shopping')).toHaveLength(1);

        // The same UUID with another draft is another capture.
        const other = await afterRestart((restarted) => restarted.submitCaptureModal({ ...input, draft: { ...draft, text: 'Plan a different trip' } }));
        expect(other).toMatchObject({ result: { ok: false, error: { code: 'INVALID_INPUT' } }, wrote: false });
    });

    // Review blocker 1: a capture UUID reused after a restart with another draft (same title) answered saved.
    it('without a receipt on disk, a reused capture UUID answers saved only for the draft that made its task', async () => {
        // On a Thursday, /start:tomorrow and /start:friday are the same request.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(fixture.now));
        const host = await openScreenHost({ data, record: {}, log: [] });
        const { draft } = value(host.openCaptureModal({ params: linkParams }));
        const input = { params: linkParams, draft: { ...draft, text: 'Plan trip /start:tomorrow %Ann' }, captureId: requestId() };
        const saved = value(await host.submitCaptureModal(input));
        expect(await afterRestart((restarted) => restarted.submitCaptureModal(input))).toEqual({ result: { ok: true, value: saved }, wrote: false });
        const changed = [
            { ...input.draft, description: 'Book hotels' },
            { ...input.draft, applied: { tags: [], timeEstimate: '30min' as const } },
            { ...input.draft, text: 'Plan trip /start:friday %Ann' },
            { ...input.draft, text: 'Plan trip /start:tomorrow %Bob' },
        ];
        for (const other of changed) {
            expect(await afterRestart((restarted) => restarted.submitCaptureModal({ ...input, draft: other })))
                .toMatchObject({ result: { ok: false, error: { code: 'INVALID_INPUT' } }, wrote: false });
        }
    });

    it('finishes a save that failed to persist on retry, without a second task', async () => {
        let failSave = false;
        const log: unknown[][] = [];
        const host = await openScreenHost({
            data, record: { addTask: 2 }, log,
            saveData: async () => {
                if (failSave) throw new Error('disk unavailable');
            },
        });
        const { draft } = value(host.openCaptureModal({ params: { initialValue: 'Water%20plants' } }));
        const input = { params: { initialValue: 'Water%20plants' }, draft, captureId: requestId() };
        failSave = true;
        expect(await host.submitCaptureModal(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        failSave = false;
        expect(value(await host.submitCaptureModal(input))).toMatchObject({ kind: 'saved', taskId: input.captureId });
        expect(log).toHaveLength(1);
        expect(useTaskStore.getState()._allTasks.filter((task) => task.title === 'Water plants')).toHaveLength(1);
    });

    it('creates one task per line under their UUIDs; a retry after a restart writes what did not land, once', async () => {
        let refuse = true;
        const log: unknown[][] = [];
        const host = await openScreenHost({
            data, record: { addTasks: 1, addProject: 1 }, log,
            intercept: (name) => (refuse && name === 'addTasks' ? Promise.resolve({ success: false, error: 'Disk full' }) : undefined),
        });
        const params = { initialValue: 'Buy%20eggs%0ACall%20plumber%20%2BPlumbing', origin: 'system' };
        const { draft } = value(host.openCaptureModal({ params }));
        const asked = value(await host.submitCaptureModal({ params, draft, captureId: requestId() }));
        expect(asked).toEqual({
            kind: 'confirmLines', lineCount: 2,
            confirm: { title: 'Create 2 tasks?', message: 'Buy eggs\nCall plumber +Plumbing', confirmLabel: 'Create tasks', cancelLabel: 'Cancel' },
        });
        const input = { params, draft, captureIds: [requestId(), requestId()] };
        // The store refuses the batch: its line's project landed, its tasks did not.
        expect(await host.submitCaptureModalLines(input)).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        expect(log.map(([name]) => name)).toEqual(['addProject', 'addTasks']);

        refuse = false;
        log.length = 0;
        const retried = await afterRestart((restarted) => restarted.submitCaptureModalLines(input));
        const saved = { kind: 'saved', taskIds: input.captureIds, close: { returnTo: null, returnToPreviousApp: true } };
        expect(retried).toEqual({ result: { ok: true, value: saved }, wrote: true });
        expect(log.map(([name]) => name)).toEqual(['addTasks']);

        const replayed = await afterRestart((restarted) => restarted.submitCaptureModalLines(input));
        expect(replayed).toEqual({ result: { ok: true, value: saved }, wrote: false });
        const state = useTaskStore.getState();
        expect(input.captureIds.map((id) => state._allTasks.find((task) => task.id === id)?.title)).toEqual(['Buy eggs', 'Call plumber']);
        expect(state._allProjects.filter((project) => project.title === 'Plumbing')).toHaveLength(1);
    });

    it('refuses an unreadable date command before any write; the UUIDs stay free', async () => {
        const log: unknown[][] = [];
        const host = await openScreenHost({ data, record: { addTask: 2, addTasks: 1, addProject: 1 }, log });
        const params = {};
        const { draft } = value(host.openCaptureModal({ params }));
        const captureId = requestId();
        const refused = value(await host.submitCaptureModal({ params, draft: { ...draft, text: 'Pay rent /due:whenever' }, captureId }));
        expect(refused).toEqual({
            kind: 'refused',
            notice: { tone: 'warning', title: 'Notice', message: 'Invalid date command: /due:whenever', durationMs: 4200 },
        });
        const ids = [requestId(), requestId()];
        const lines = { params, draft: { ...draft, text: 'Plan beds +Garden plan\nPay rent /due:whenever' }, captureIds: ids };
        expect(value(await host.submitCaptureModalLines(lines))).toMatchObject({ kind: 'refused' });
        expect(log).toEqual([]);
        expect(value(await host.submitCaptureModal({ params, draft: { ...draft, text: 'Pay rent /due:friday' }, captureId }))).toMatchObject({ kind: 'saved', taskId: captureId });
        expect(value(await host.submitCaptureModalLines({ ...lines, draft: { ...draft, text: 'Plan beds\nPay rent' } }))).toMatchObject({ kind: 'saved', taskIds: ids });
    });

    it.each([
        [{ areaId: 'a-work' }, 'a-work'],
        [{}, '<undefined>'],
    ])('files a capture in the active area filter %j when new tasks follow it (#1460)', async (filters, areaId) => {
        const log: unknown[][] = [];
        const settings = { ...fixture.settings.ai, gtd: { ...fixture.settings.ai.gtd, defaultAreaMode: 'active' as const }, filters };
        const host = await openScreenHost({ data: { ...data, settings }, record: { addTask: 2 }, log });
        const params = { initialValue: 'Call plumber' };
        const opened = value(host.openCaptureModal({ params }));
        value(await host.submitCaptureModal({ params, draft: opened.draft, captureId: requestId() }));
        expect(log).toEqual([['addTask', 'Call plumber', { status: 'inbox', areaId }]]);
    });

    it('leaves shared files out, and checks what the host sends', async () => {
        const log: unknown[][] = [];
        const host = await openScreenHost({ data, record: { addTask: 2 }, log });
        const params = {
            initialValue: 'Receipt',
            initialProps: encodeURIComponent(JSON.stringify({
                attachments: [{ id: 'a1', kind: 'file', title: 'Receipt.pdf', uri: 'file:///data/mindwtr/attachments/a1.pdf', createdAt: fixture.now }],
            })),
        };
        const opened = value(host.openCaptureModal({ params }));
        expect(opened.view.attachments).toBeNull();
        value(await host.submitCaptureModal({ params, draft: opened.draft, captureId: requestId() }));
        expect(log).toEqual([['addTask', 'Receipt', { status: 'inbox', areaId: '<undefined>' }]]);

        const { draft } = opened;
        const invalid = [
            host.openCaptureModal({ params: { unknown: 'x' } as never }),
            host.getCaptureModalView({ params, draft: { ...draft, extra: true } as never }),
            host.getCaptureModalView({ params, draft: { ...draft, applied: { tags: [], timeEstimate: 'forever' } } as never }),
            host.editCaptureModal({ params, draft, edit: { type: 'applyCopilot', parts: [{ kind: 'tag', value: '#never-suggested' }] } }),
            host.editCaptureModal({ params, draft, edit: { type: 'rename' } as never }),
        ];
        expect(invalid.map((result) => (result.ok ? 'ok' : result.error.code))).toEqual(Array(5).fill('INVALID_INPUT'));
    });

    // Review should-fix 4: React Native asks the AI only with a key, or with a provider that needs none.
    it('asks the AI as React Native does: never for a provider that needs a key this host does not hold', async () => {
        const params = { initialValue: 'Call%20the%20bank' };
        const keyed = await openScreenHost({ data, record: {}, log: [] });
        const opened = value(keyed.openCaptureModal({ params }));
        expect(opened.view.copilot.request).toBeNull();
        const answered = value(keyed.editCaptureModal({ params, draft: opened.draft, edit: { type: 'setSuggestion', title: 'Call the bank', suggestion: { tags: ['#finance'] } } }));
        expect(answered.draft.suggestion).toBeNull();

        // An OpenAI-compatible endpoint needs no key (React Native's isAIKeyRequired, now core's).
        const local = await openScreenHost({ data: { ...data, settings: withLocalAIEndpoint(data.settings) }, record: {}, log: [] });
        expect(value(local.openCaptureModal({ params })).view.copilot.request).toMatchObject({ title: 'Call the bank' });
    });

    // Pass C1: a host that binds AI asks requestAICopilot, which loads the key itself and answers null without one.
    it('asks the AI for any provider on a host that binds AI: requestAICopilot checks the key', async () => {
        const params = { initialValue: 'Call%20the%20bank' };
        const ai = {
            platform: { isFossBuild: false },
            storage: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
            secrets: { get: async () => null, set: async () => undefined, delete: async () => undefined },
        };
        const bound = await openScreenHost({ data, record: {}, log: [], bindings: { ai } });
        const { view } = value(bound.openCaptureModal({ params }));
        expect(view.copilot.request).toMatchObject({ title: 'Call the bank' });
        expect(value(await bound.requestAICopilot({ request: view.copilot.request! }))).toEqual({ suggestion: null });
    });

    it('drops an AI answer for a title the field no longer holds', async () => {
        const host = await openScreenHost({ data: { ...data, settings: withLocalAIEndpoint(data.settings) }, record: {}, log: [] });
        const params = { initialValue: 'Call%20the%20bank' };
        const { draft, view } = value(host.openCaptureModal({ params }));
        expect(view.copilot.request).toMatchObject({ title: 'Call the bank', contexts: ['@computer', '@home office', '@phone'], tags: ['#finance', '#work'] });
        const late = value(host.editCaptureModal({ params, draft, edit: { type: 'setSuggestion', title: 'Call the', suggestion: { tags: ['#finance'] } } }));
        expect(late.draft.suggestion).toBeNull();
        const current = value(host.editCaptureModal({ params, draft, edit: { type: 'setSuggestion', title: 'Call the bank', suggestion: { tags: ['#finance'] } } }));
        expect(current.view.copilot.suggested?.parts).toEqual([{ label: '#finance', edit: { type: 'applyCopilot', parts: [{ kind: 'tag', value: '#finance' }] } }]);
    });
});

/** The native host over a real SQLite file with its receipts, booted as the app boots it; `replay` is a replay after process death. */
describe('native host contract: the capture confirmation screen over SQLite', () => {
    let env: Awaited<ReturnType<typeof openSqliteHost>> | null = null;
    const open = async () => {
        env = await openSqliteHost({ tasks: fixture.tasks, projects: fixture.projects, areas: fixture.areas });
        return env;
    };
    afterEach(async () => {
        await env?.close();
        env = null;
    });

    it('a capture UUID reused after process death answers its first reply, and refuses another draft', async () => {
        const env = await open();
        const { draft } = value(env.host.openCaptureModal({ params: linkParams }));
        const input = { params: linkParams, draft, captureId: requestId() };
        const first = await env.host.submitCaptureModal(input);
        expect(first).toMatchObject({ ok: true, value: { kind: 'saved', taskId: input.captureId } });
        expect(await env.receiptIds()).toEqual([input.captureId]);
        expect(await env.replay((restarted) => restarted.submitCaptureModal(input))).toEqual({ result: first, wrote: false, receipts: false });
        expect(await env.replay((restarted) => restarted.submitCaptureModal({ ...input, draft: { ...draft, description: 'Book hotels' } })))
            .toMatchObject({ result: { ok: false, error: { code: 'INVALID_INPUT' } }, wrote: false, receipts: false });
    });

    // Review blocker 2: a batch saved under [A, B], retried after a restart under a changed list, made a duplicate line.
    it('a batch retried after process death under a changed UUID list is refused and writes nothing', async () => {
        const env = await open();
        const params = { initialValue: 'First%0ASecond' };
        const { draft } = value(env.host.openCaptureModal({ params }));
        const [a, b, c] = [requestId(), requestId(), requestId()];
        const first = await env.host.submitCaptureModalLines({ params, draft, captureIds: [a, b] });
        expect(first).toMatchObject({ ok: true, value: { kind: 'saved', taskIds: [a, b] } });
        expect(await env.replay((restarted) => restarted.submitCaptureModalLines({ params, draft, captureIds: [a, b] })))
            .toEqual({ result: first, wrote: false, receipts: false });
        for (const captureIds of [[a, c], [c, b], [b, a]]) {
            expect(await env.replay((restarted) => restarted.submitCaptureModalLines({ params, draft, captureIds })))
                .toMatchObject({ result: { ok: false, error: { code: 'INVALID_INPUT' } }, wrote: false, receipts: false });
        }
        expect(useTaskStore.getState()._allTasks.filter((task) => task.title === 'First' || task.title === 'Second').map((task) => task.id).sort())
            .toEqual([a, b].sort());
    });

    /** Runs `write` while the store refuses to add tasks, as a task write that fails after its project landed. */
    const withTaskWritesRefused = async <T,>(write: () => Promise<T>): Promise<T> => {
        const { addTask, addTasks } = useTaskStore.getState();
        useTaskStore.setState({
            addTask: async () => ({ success: false, error: 'Task store refused' }),
            addTasks: async () => ({ success: false, error: 'Task store refused' }),
        });
        try {
            return await write();
        } finally {
            useTaskStore.setState({ addTask, addTasks });
            await flushPendingSave();
        }
    };
    const store = () => useTaskStore.getState();

    // Review blocker 3: a project that landed while its task failed was made again by a replay after a rename.
    it.each([
        ['a link\'s project param', linkParams, 'shopping'],
        ['a typed +Project', { initialValue: 'Plan%20beds%20%2BGarden' }, 'garden'],
    ] as const)('%s whose project landed and task failed: a replay after a rename files the task there and makes no second project', async (_entry, params, name) => {
        {
            const env = await open();
            const { draft } = value(env.host.openCaptureModal({ params }));
            const input = { params, draft, captureId: requestId() };
            const projectId = requestRowId(input.captureId, `project:${name}`);
            expect(await withTaskWritesRefused(() => env.host.submitCaptureModal(input))).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
            expect(await env.receiptIds()).toEqual([]);
            await store().updateProject(projectId, { title: 'Renamed' });
            await flushPendingSave();
            const replay = await env.replay((restarted) => restarted.submitCaptureModal(input));
            expect(replay.result).toMatchObject({ ok: true, value: { kind: 'saved', taskId: input.captureId, projectId } });
            expect(store()._allProjects.filter((project) => !['p-launch', 'p-home', 'p-old', 'p-gone'].includes(project.id)).map((project) => [project.id, project.title]))
                .toEqual([[projectId, 'Renamed']]);
            expect(store()._tasksById.get(input.captureId)).toMatchObject({ projectId });
            expect(await env.replay((restarted) => restarted.submitCaptureModal(input))).toEqual({ result: replay.result, wrote: false, receipts: false });
        }
    });

    it('a capture whose project was deleted since is refused (STALE_REVISION) and writes nothing', async () => {
        const env = await open();
        const { draft } = value(env.host.openCaptureModal({ params: linkParams }));
        const input = { params: linkParams, draft, captureId: requestId() };
        await withTaskWritesRefused(() => env.host.submitCaptureModal(input));
        await store().deleteProject(requestRowId(input.captureId, 'project:shopping'));
        await flushPendingSave();
        expect(await env.replay((restarted) => restarted.submitCaptureModal(input)))
            .toMatchObject({ result: { ok: false, error: { code: 'STALE_REVISION' } }, wrote: false, receipts: false });
    });

    it('a batch whose project landed and tasks failed: a replay after a rename files every line there', async () => {
        const env = await open();
        const params = { initialValue: 'Buy%20seeds%20%2BGarden%0AWeed%20%2BGarden' };
        const { draft } = value(env.host.openCaptureModal({ params }));
        const input = { params, draft, captureIds: [requestId(), requestId()] };
        const projectId = requestRowId(input.captureIds[0], 'project:garden');
        expect(await withTaskWritesRefused(() => env.host.submitCaptureModalLines(input))).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        await store().updateProject(projectId, { title: 'Beds' });
        await flushPendingSave();
        const replay = await env.replay((restarted) => restarted.submitCaptureModalLines(input));
        expect(replay.result).toMatchObject({ ok: true, value: { kind: 'saved', taskIds: input.captureIds } });
        expect(input.captureIds.map((id) => store()._tasksById.get(id)?.projectId)).toEqual([projectId, projectId]);
        expect(store()._allProjects.filter((project) => project.title === 'Garden' || project.id === projectId).map((project) => project.title)).toEqual(['Beds']);
    });
});
