import { afterEach, expect, it, vi } from 'vitest';
import { createCalendarRecorder, loadCalendarViewsFixture, seedCalendarStore } from './calendar-view-model.replay';
import { createNativeHostContract } from './native-host-contract';
import { flushPendingSave, resetForTests, useTaskStore } from './store';

const fixture = loadCalendarViewsFixture();
const requestId = '6475c779-e751-42d3-a2ea-85abffb3be73';
const value = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const open = async (saveData?: (data: unknown) => Promise<void>) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(fixture.now));
    await seedCalendarStore(fixture, { name: 'prepared-create', settings: 'month', actions: [] }, createCalendarRecorder(), { saveData });
    const host = createNativeHostContract();
    value(await host.setLanguage({ storedLanguage: 'en', systemLocale: fixture.deviceLocale }));
    value(await host.activate({ writeSafetyReady: true }));
    return host;
};
const composer = (host: ReturnType<typeof createNativeHostContract>, title: string) => {
    const opened = value(host.openCalendarComposer({ day: '2026-10-31', mode: 'new' }));
    return value(host.editCalendarComposer({ composer: opened.composer!.composer, edit: { type: 'title', title } })).composer;
};
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

afterEach(async () => {
    await flushPendingSave();
    resetForTests();
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

it('prepares a Calendar-specific task and project without writing, then commits both once', async () => {
    const saveData = vi.fn(async () => undefined);
    const host = await open(saveData);
    const edited = composer(host, 'Buy paint +Kitchen /due:2026-11-02');
    saveData.mockClear();
    const prepared = value(await host.prepareCalendarComposerCreate({ requestId, composer: edited }));
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;
    expect(saveData).not.toHaveBeenCalled();
    expect(prepared.prepared.task).toMatchObject({ id: requestId, title: 'Buy paint', dueDate: '2026-11-02',
        startTime: edited.startAt, projectId: prepared.prepared.project?.id });
    expect(prepared.prepared.project).toMatchObject({ title: 'Kitchen', color: '#94a3b8' });
    const command = { request: prepared.prepared.request, prepared: prepared.prepared };
    expect(value(await host.commitPreparedCalendarComposerCreate(command))).toEqual(prepared.prepared.result);
    expect(saveData).toHaveBeenCalledTimes(1);
    expect(useTaskStore.getState()._tasksById.get(requestId)?.title).toBe('Buy paint');
    expect(value(await host.commitPreparedCalendarComposerCreate(command))).toEqual(prepared.prepared.result);
    expect(saveData).toHaveBeenCalledTimes(1);
});

it('opens a New composer at the shared snapped Day tap and retains an Existing selection across the mode toggle', async () => {
    vi.stubEnv('TZ', 'America/New_York');
    const host = await open();
    const dayTap = value(host.openCalendarComposer({ day: '2026-10-31', rawMinutes: 37, mode: 'new' }));
    expect(dayTap.composer?.composer.mode).toBe('new');
    expect(dayTap.composer?.composer.startAt).toBe('2026-10-31T04:35:00.000Z');
    const fold = value(host.openCalendarComposer({ day: '2026-11-01', rawMinutes: 95, mode: 'new' }));
    expect(fold.composer?.composer.startAt).toBe('2026-11-01T05:35:00.000Z');
    for (const invalid of [
        { day: '2026-10-31', rawMinutes: -1, mode: 'new' },
        { day: '2026-10-31', rawMinutes: 1441, mode: 'new' },
        { day: '2026-10-31', rawMinutes: 37, mode: 'existing' },
        { day: '2026-10-31', rawMinutes: 37, at: '2026-10-31T04:00:00.000Z', mode: 'new' },
    ] as const) expect(host.openCalendarComposer(invalid).ok).toBe(false);
    const existing = value(host.openCalendarComposer({ day: '2026-10-31', scheduleTaskId: 'n-email' }));
    const asNew = value(host.editCalendarComposer({ composer: existing.composer!.composer, edit: { type: 'mode', mode: 'new' } }));
    expect(asNew.composer.selectedTaskId).toBe('n-email');
    const titled = value(host.editCalendarComposer({ composer: asNew.composer, edit: { type: 'title', title: 'New after toggle' } }));
    const prepared = value(await host.prepareCalendarComposerCreate({ requestId, composer: titled.composer }));
    expect(prepared.kind).toBe('prepared');
});

it('rejects forged task, project, request, link and navigation effects with no store write', async () => {
    const saveData = vi.fn(async () => undefined);
    const host = await open(saveData);
    const edited = composer(host, 'Read +Notebook /link:https://example.com /due:2026-11-02');
    const answer = value(await host.prepareCalendarComposerCreate({ requestId, composer: edited }));
    expect(answer.kind).toBe('prepared');
    if (answer.kind !== 'prepared') return;
    saveData.mockClear();
    const original = { request: answer.prepared.request, prepared: answer.prepared };
    const invalid = [
        (item: typeof original) => { item.request.requestId = '4475c779-e751-42d3-a2ea-85abffb3be73'; },
        (item: typeof original) => { item.prepared.intent.props.dueDate = '2026-11-03'; },
        (item: typeof original) => { item.prepared.intent.props.dueDate = 'not-a-date'; item.prepared.task.dueDate = 'not-a-date'; },
        (item: typeof original) => { item.prepared.intent.props.dueDate = '2026-02-30'; item.prepared.task.dueDate = '2026-02-30'; },
        (item: typeof original) => { item.prepared.intent.props.dueDate = '2026-10-30'; item.prepared.task.dueDate = '2026-10-30'; },
        (item: typeof original) => { item.prepared.intent.props.reviewAt = 'not-a-date'; item.prepared.task.reviewAt = 'not-a-date'; },
        (item: typeof original) => { item.prepared.intent.props.reviewAt = '2026-10-01T99:00:00.000Z'; item.prepared.task.reviewAt = '2026-10-01T99:00:00.000Z'; },
        (item: typeof original) => { item.prepared.task.title = 'Forged'; },
        (item: typeof original) => { item.prepared.task.rev = 3; },
        (item: typeof original) => { item.prepared.project!.order = 900; },
        (item: typeof original) => { item.prepared.generatedLinkIds[0] = '4475c779-e751-42d3-a2ea-85abffb3be73'; },
        (item: typeof original) => { item.prepared.preparedAt = '2026-10-30T10:00:00.000Z'; },
        (item: typeof original) => { item.prepared.result.taskId = '4475c779-e751-42d3-a2ea-85abffb3be73'; },
        (item: typeof original) => { item.prepared.creation.taskOrderMax = 23; },
    ];
    for (const mutate of invalid) {
        const altered = copy(original);
        mutate(altered);
        expect(host.validatePreparedCalendarComposerCreate(altered).ok).toBe(false);
        expect((await host.commitPreparedCalendarComposerCreate(altered)).ok).toBe(false);
    }
    expect(useTaskStore.getState()._tasksById.has(requestId)).toBe(false);
    expect(saveData).not.toHaveBeenCalled();
});

it('accepts a same-local-day date-only due after timezone drift', async () => {
    vi.stubEnv('TZ', 'America/New_York');
    const host = await open();
    const answer = value(await host.prepareCalendarComposerCreate({ requestId,
        composer: composer(host, 'Late task /due:2026-10-31') }));
    expect(answer.kind).toBe('prepared');
    if (answer.kind !== 'prepared') return;
    expect(answer.prepared.intent.props.dueDate).toBe('2026-10-31');
    vi.stubEnv('TZ', 'UTC');
    expect(host.validatePreparedCalendarComposerCreate({ request: answer.prepared.request,
        prepared: answer.prepared }).ok).toBe(true);
});

it('guards generated project identity and target order before first publication, but acknowledges the full task receipt first', async () => {
    const saveData = vi.fn(async () => undefined);
    const host = await open(saveData);
    const answer = value(await host.prepareCalendarComposerCreate({ requestId, composer: composer(host, 'Paint +Studio') }));
    expect(answer.kind).toBe('prepared');
    if (answer.kind !== 'prepared') return;
    const command = { request: answer.prepared.request, prepared: answer.prepared };
    const project = answer.prepared.project!;
    useTaskStore.setState((state) => ({ _allProjects: [...state._allProjects, { ...project, title: 'Occupied' }],
        _projectsById: new Map([...state._projectsById, [project.id, { ...project, title: 'Occupied' }]]) }));
    saveData.mockClear();
    expect((await host.commitPreparedCalendarComposerCreate(command)).ok).toBe(false);
    expect(saveData).not.toHaveBeenCalled();
    useTaskStore.setState((state) => ({ _allProjects: state._allProjects.filter((entry) => entry.id !== project.id),
        _projectsById: new Map([...state._projectsById].filter(([id]) => id !== project.id)) }));
    const occupied = { ...answer.prepared.task, title: 'Another task' };
    useTaskStore.setState((state) => ({ _allTasks: [...state._allTasks, occupied],
        _tasksById: new Map([...state._tasksById, [occupied.id, occupied]]) }));
    expect((await host.commitPreparedCalendarComposerCreate(command)).ok).toBe(false);
    expect(saveData).not.toHaveBeenCalled();
    useTaskStore.setState((state) => ({ _allTasks: state._allTasks.filter((entry) => entry.id !== occupied.id),
        _tasksById: new Map([...state._tasksById].filter(([id]) => id !== occupied.id)) }));
    expect(value(await host.commitPreparedCalendarComposerCreate(command))).toEqual(answer.prepared.result);
    expect(saveData).toHaveBeenCalledTimes(1);
    await useTaskStore.getState().updateProject(project.id, { title: 'Studio renamed' });
    await flushPendingSave();
    saveData.mockClear();
    expect(value(await host.commitPreparedCalendarComposerCreate(command))).toEqual(answer.prepared.result);
    expect(saveData).not.toHaveBeenCalled();
});

it('freezes a nonsequential Focus decision across timezone change and refuses sequential Focus before writing', async () => {
    vi.stubEnv('TZ', 'America/New_York');
    const saveData = vi.fn(async () => undefined);
    const host = await open(saveData);
    const focus = value(await host.prepareCalendarComposerCreate({ requestId, composer: composer(host, 'Star plan /next /*') }));
    expect(focus.kind).toBe('prepared');
    if (focus.kind !== 'prepared') return;
    expect(focus.prepared.creation.focusRequested).toBe(true);
    vi.stubEnv('TZ', 'UTC');
    vi.setSystemTime(new Date('2027-02-03T20:00:00.000Z'));
    expect(host.validatePreparedCalendarComposerCreate({ request: focus.prepared.request, prepared: focus.prepared }).ok).toBe(true);
    expect(value(await host.commitPreparedCalendarComposerCreate({ request: focus.prepared.request, prepared: focus.prepared }))).toEqual(focus.prepared.result);
    expect(useTaskStore.getState()._tasksById.get(requestId)?.isFocusedToday).toBe(focus.prepared.task.isFocusedToday);
    const sequential = await useTaskStore.getState().addProject('Sequential', '#94a3b8', { isSequential: true });
    expect(sequential).not.toBeNull();
    await flushPendingSave();
    saveData.mockClear();
    const empty = value(await host.prepareCalendarComposerCreate({ requestId: '4475c779-e751-42d3-a2ea-85abffb3be73',
        composer: composer(host, 'First +Sequential /next /*') }));
    expect(empty.kind).toBe('prepared');
    if (empty.kind === 'prepared') expect(empty.prepared.creation.sequentialEmpty).toBe(true);
    await useTaskStore.getState().addTask('Earlier', { status: 'next', projectId: sequential!.id });
    await flushPendingSave();
    saveData.mockClear();
    if (empty.kind === 'prepared') {
        expect((await host.commitPreparedCalendarComposerCreate({ request: empty.prepared.request, prepared: empty.prepared })).ok).toBe(false);
        expect(saveData).not.toHaveBeenCalled();
    }
    const refused = await host.prepareCalendarComposerCreate({ requestId: 'c475c779-e751-42d3-a2ea-85abffb3be73',
        composer: composer(host, 'Blocked +Sequential /next /*') });
    expect(refused.ok).toBe(false);
    expect(saveData).not.toHaveBeenCalled();
    useTaskStore.setState((state) => ({ settings: { ...state.settings,
        gtd: { ...state.settings.gtd, defaultProjectFlowMode: 'sequential' } } }));
    const generated = value(await host.prepareCalendarComposerCreate({ requestId: 'd475c779-e751-42d3-a2ea-85abffb3be73',
        composer: composer(host, 'First +New Sequential /next /*') }));
    expect(generated.kind).toBe('prepared');
    if (generated.kind === 'prepared') {
        expect(generated.prepared.project?.isSequential).toBe(true);
        expect(generated.prepared.creation.sequentialEmpty).toBe(true);
    }
});

it('uses a frozen existing project ID after a harmless rename and refuses a changed order reservation', async () => {
    const saveData = vi.fn(async () => undefined);
    const host = await open(saveData);
    const selected = await useTaskStore.getState().addProject('Studio', '#94a3b8');
    expect(selected).not.toBeNull();
    await flushPendingSave();
    const plan = value(await host.prepareCalendarComposerCreate({ requestId, composer: composer(host, 'Paint +Studio') }));
    expect(plan.kind).toBe('prepared');
    if (plan.kind !== 'prepared') return;
    expect(plan.prepared.project).toBeNull();
    expect(plan.prepared.task.projectId).toBe(selected!.id);
    await useTaskStore.getState().updateProject(selected!.id, { title: 'Studio renamed' });
    await flushPendingSave();
    saveData.mockClear();
    expect(value(await host.commitPreparedCalendarComposerCreate({ request: plan.prepared.request, prepared: plan.prepared }))).toEqual(plan.prepared.result);
    expect(saveData).toHaveBeenCalledTimes(1);

    const nextID = '4475c779-e751-42d3-a2ea-85abffb3be73';
    const next = value(await host.prepareCalendarComposerCreate({ requestId: nextID, composer: composer(host, 'Paint +Another') }));
    expect(next.kind).toBe('prepared');
    if (next.kind !== 'prepared') return;
    // A generated project's order is a factory input, not an excuse to reorder
    // unrelated rows during a stale commit.
    await useTaskStore.getState().addProject('Order moved', '#94a3b8');
    await flushPendingSave();
    saveData.mockClear();
    expect((await host.commitPreparedCalendarComposerCreate({ request: next.prepared.request, prepared: next.prepared })).ok).toBe(false);
    expect(useTaskStore.getState()._tasksById.has(nextID)).toBe(false);
    expect(saveData).not.toHaveBeenCalled();
});

it('keeps relative due and selected-slot override frozen when clock and timezone change', async () => {
    vi.stubEnv('TZ', 'America/New_York');
    const saveData = vi.fn(async () => undefined);
    const host = await open(saveData);
    const opened = value(host.openCalendarComposer({ day: '2026-10-29', mode: 'new' }));
    const edited = value(host.editCalendarComposer({ composer: opened.composer!.composer,
        edit: { type: 'title', title: 'Read @phone #notes /next /due:tomorrow /start:2030-01-01 /link:https://example.com' } })).composer;
    const planned = value(await host.prepareCalendarComposerCreate({ requestId, composer: edited }));
    expect(planned.kind).toBe('prepared');
    if (planned.kind !== 'prepared') return;
    const { task, intent } = planned.prepared;
    expect(task.title).toBe('Read');
    expect(task.status).toBe('next');
    expect(task.contexts).toContain('@phone');
    expect(task.tags).toContain('#notes');
    expect(task.startTime).toBe(edited.startAt);
    expect(task.dueDate).toBeTruthy();
    expect(task.attachments?.[0]).toMatchObject({ kind: 'link', uri: 'https://example.com' });
    expect(intent.props.startTime).toBe(edited.startAt);
    vi.setSystemTime(new Date('2027-02-03T20:00:00.000Z'));
    vi.stubEnv('TZ', 'UTC');
    const command = { request: planned.prepared.request, prepared: planned.prepared };
    expect(host.validatePreparedCalendarComposerCreate(command).ok).toBe(true);
    saveData.mockClear();
    expect(value(await host.commitPreparedCalendarComposerCreate(command))).toEqual(planned.prepared.result);
    expect(saveData).toHaveBeenCalledTimes(1);
    expect(value(await host.commitPreparedCalendarComposerCreate(command))).toEqual(planned.prepared.result);
    expect(saveData).toHaveBeenCalledTimes(1);
    expect(useTaskStore.getState()._tasksById.get(requestId)?.dueDate).toBe(task.dueDate);
});

it('returns no-write refusal for empty, malformed date and start-after-due titles', async () => {
    const saveData = vi.fn(async () => undefined);
    const host = await open(saveData);
    saveData.mockClear();
    for (const title of [' ', 'Read /due:2026-99-99', 'Read /due:2026-10-20']) {
        const refusal = value(await host.prepareCalendarComposerCreate({ requestId, composer: composer(host, title) }));
        expect(refusal.kind).toBe('refused');
        if (refusal.kind === 'refused') {
            expect(refusal.result.changed).toBe(false);
            expect(refusal.result.composer?.error).toBeTruthy();
        }
    }
    expect(saveData).not.toHaveBeenCalled();
    expect(useTaskStore.getState()._tasksById.has(requestId)).toBe(false);
});

it('creates the composer task under Skip as RN addTask does, and keeps an earlier Send journal valid', async () => {
    const host = await open();
    const sent = value(await host.prepareCalendarComposerCreate({ requestId: '7475c779-e751-42d3-a2ea-85abffb3be73', composer: composer(host, 'Sent') }));
    if (sent.kind !== 'prepared') throw new Error('Expected a prepared creation');
    expect(sent.prepared.task.suppressMindwtrReminders).toBe(false);
    useTaskStore.setState((state) => ({ settings: { ...state.settings, taskReminderDefault: 'skip' } }));
    const prepared = value(await host.prepareCalendarComposerCreate({ requestId, composer: composer(host, 'Skipped') }));
    if (prepared.kind !== 'prepared') throw new Error('Expected a prepared creation');
    expect(prepared.prepared.task.suppressMindwtrReminders).toBe(true);
    expect(value(await host.commitPreparedCalendarComposerCreate({ request: prepared.prepared.request, prepared: prepared.prepared })))
        .toEqual(prepared.prepared.result);
    expect(useTaskStore.getState()._tasksById.get(requestId)?.suppressMindwtrReminders).toBe(true);
    expect(value(host.validatePreparedCalendarComposerCreate({ request: sent.prepared.request, prepared: sent.prepared })))
        .toEqual(sent.prepared.result);
    const ordinary = await useTaskStore.getState().addTask('Reference', { status: 'next' });
    expect(useTaskStore.getState()._tasksById.get(ordinary.id!)?.suppressMindwtrReminders).toBe(true);
});
