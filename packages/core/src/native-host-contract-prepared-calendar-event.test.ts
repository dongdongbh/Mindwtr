import { afterEach, expect, it, vi } from 'vitest';
import { createCalendarRecorder, loadCalendarViewsFixture, seedCalendarStore } from './calendar-view-model.replay';
import { createNativeHostContract } from './native-host-contract';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { planCalendarEventTask } from './calendar-view-model';
import { taskToSqliteRow } from './task-sync-schema';
import type { NativeCalendarEventTaskCreateRequest } from './native-host-contract-calendar';
import type { Area } from './types';
import * as sandbox from './sandbox';

const fixture = loadCalendarViewsFixture();
const requestId = '6475c779-e751-42d3-a2ea-85abffb3be73';
const value = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const open = async (saveData?: (data: unknown) => Promise<void>) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(fixture.now));
    await seedCalendarStore(fixture, { name: 'prepared-event', settings: 'month', actions: [] }, createCalendarRecorder(), { saveData });
    const host = createNativeHostContract();
    value(await host.setLanguage({ storedLanguage: 'en', systemLocale: fixture.deviceLocale }));
    value(await host.activate({ writeSafetyReady: true }));
    return host;
};
const request = (): NativeCalendarEventTaskCreateRequest => ({ requestId, event: { title: ' Read +Notebook /due:tomorrow ',
    start: '2026-10-31T10:00:00.000Z', end: '2026-10-31T11:15:00.000Z', allDay: false,
    description: ' Notes ', location: ' Library ' }, calendarName: ' Work ', fallbackTitle: 'Calendar event',
    state: { viewMode: 'week' as const, selectedDate: '2026-10-29', visibleMonth: '2026-10-01' } });
const copy = <T,>(input: T): T => JSON.parse(JSON.stringify(input)) as T;
const prepare = async (host: ReturnType<typeof createNativeHostContract>, input: NativeCalendarEventTaskCreateRequest = request()) => {
    const answer = value(await host.prepareCalendarEventTaskCreate(input));
    return copy({ request: answer.prepared.request, prepared: answer.prepared });
};
const configureDefault = (id: string, mode: 'fixed' | 'none' | 'active' | undefined = 'fixed') => useTaskStore.setState((state) => ({
    settings: { ...state.settings, gtd: { ...state.settings.gtd, defaultAreaMode: mode, defaultAreaId: id } },
}));
const area = (id: string): Area => ({ id, name: 'Default Area', order: 0, createdAt: fixture.now, updatedAt: fixture.now, rev: 1 });
const insertArea = (entry: Area) => useTaskStore.setState((state) => ({
    _allAreas: [...state._allAreas.filter((item) => item.id !== entry.id), entry],
    _areasById: new Map([...state._areasById, [entry.id, entry]]),
}));

afterEach(async () => {
    await flushPendingSave();
    resetForTests();
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

it('copies the displayed timed event literally without effects during prepare, then saves its complete factory row once', async () => {
    vi.stubEnv('TZ', 'UTC');
    const saveData = vi.fn(async () => undefined);
    const host = await open(saveData);
    saveData.mockClear();
    const answer = value(await host.prepareCalendarEventTaskCreate(request()));
    expect(answer.kind).toBe('prepared');
    expect(answer.prepared.task).toMatchObject({ id: requestId, title: 'Read +Notebook /due:tomorrow', status: 'next',
        startTime: '2026-10-31T10:00:00.000Z', timeEstimate: 'custom:75', description: 'Notes\n\nCalendar: Work', location: 'Library',
        rev: 1, revBy: useTaskStore.getState().settings.deviceId });
    expect(answer.prepared.task.projectId).toBeUndefined();
    expect(answer.prepared.task.dueDate).toBeUndefined();
    expect(answer.prepared.result).toMatchObject({ changed: true, taskId: requestId,
        next: { viewMode: 'week', selectedDate: '2026-10-31', visibleMonth: '2026-10-31' } });
    expect(useTaskStore.getState()._tasksById.has(requestId)).toBe(false);
    expect(saveData).not.toHaveBeenCalled();
    const command = { request: answer.prepared.request, prepared: answer.prepared };
    expect(host.validatePreparedCalendarEventTaskCreate(command).ok).toBe(true);
    expect(value(await host.commitCalendarEventTaskCreate(command))).toEqual(answer.prepared.result);
    expect(saveData).toHaveBeenCalledTimes(1);
    expect(value(await host.commitCalendarEventTaskCreate(command))).toEqual(answer.prepared.result);
    expect(saveData).toHaveBeenCalledTimes(1);
});

it.each([
    ['fractional duration', '2026-10-31T10:00:00.000Z', '2026-10-31T10:01:31.000Z', 'custom:2'],
    ['subminute duration', '2026-10-31T10:00:00.000Z', '2026-10-31T10:00:01.000Z', 'custom:1'],
    ['multi-day duration', '2026-10-31T10:00:00.000Z', '2026-11-02T10:00:00.000Z', 'custom:2880'],
    ['DST fold duration', '2026-11-01T01:30:00-04:00', '2026-11-01T01:30:00-05:00', '1hr'],
    ['nonpositive duration', '2026-10-31T10:00:00.000Z', '2026-10-31T09:00:00.000Z', undefined],
] as const)('retains RN %s semantics and the complete ordinary task factory row', async (_label, start, end, estimate) => {
    vi.stubEnv('TZ', 'America/New_York');
    const host = await open();
    const input = request();
    input.event.start = start;
    input.event.end = end;
    const command = await prepare(host, input);
    expect(command.prepared.task.timeEstimate).toBe(estimate);
    const plan = planCalendarEventTask({ ...input.event, id: 'transient-event', sourceId: 'transient-source' },
        { calendarName: input.calendarName ?? undefined, t: () => input.fallbackTitle });
    const ordinary = await useTaskStore.getState().addTask(plan.title, plan.initialProps, { captureId: requestId });
    expect(ordinary.success).toBe(true);
    await flushPendingSave();
    expect(taskToSqliteRow(command.prepared.task)).toEqual(taskToSqliteRow(useTaskStore.getState()._tasksById.get(requestId)!));
    vi.stubEnv('TZ', 'Asia/Tokyo');
    vi.setSystemTime(new Date('2030-02-04T15:00:00.000Z'));
    expect(host.validatePreparedCalendarEventTaskCreate(command).ok).toBe(true);
    expect(value(await host.commitCalendarEventTaskCreate(command))).toEqual(command.prepared.result);
});

it.each(['2026-11-01', '2026-11-01T00:00:00+14:00'])('preserves all-day date-only due from %s, without start or duration', async (start) => {
    vi.stubEnv('TZ', 'America/New_York');
    const host = await open();
    const input = request();
    input.event = { ...input.event, title: '  ', start, end: '2026-11-02', allDay: true };
    const command = await prepare(host, input);
    expect(command.prepared.task).toMatchObject({ title: 'Calendar event', dueDate: '2026-11-01', status: 'next' });
    expect(command.prepared.task.startTime).toBeUndefined();
    expect(command.prepared.task.timeEstimate).toBeUndefined();
    expect(command.prepared.result.next).toEqual({ viewMode: 'week', selectedDate: '2026-11-01', visibleMonth: '2026-11-01' });
    vi.stubEnv('TZ', 'UTC');
    vi.setSystemTime(new Date('2031-01-01T00:00:00.000Z'));
    expect(host.validatePreparedCalendarEventTaskCreate(command).ok).toBe(true);
});

it('uses the shared default fallback and ignores blank copied location, notes and calendar name', async () => {
    const host = await open();
    const input = request();
    input.event = { ...input.event, title: ' ', location: ' ', description: ' ' };
    input.fallbackTitle = ' ';
    input.calendarName = ' ';
    const command = await prepare(host, input);
    expect(command.prepared.task.title).toBe('Calendar event');
    expect(command.prepared.task.location).toBeUndefined();
    expect(command.prepared.task.description).toBeUndefined();
});

it('accepts all raw notes and the 22,012-unit derived description without truncation or link parsing', async () => {
    const host = await open();
    const input = request();
    input.event.title = 'https://example.com +Project /link:https://example.com';
    input.event.description = '界'.repeat(20_000);
    input.calendarName = '名'.repeat(2000);
    input.event.location = '室'.repeat(2000);
    const command = await prepare(host, input);
    expect(command.prepared.task.description).toHaveLength(22_012);
    expect(command.prepared.task.description).toBe(`${input.event.description}\n\nCalendar: ${input.calendarName}`);
    expect(command.prepared.task.attachments).toBeUndefined();
    expect(command.prepared.task.projectId).toBeUndefined();
    expect(command.prepared.task.title).toBe(input.event.title);
    value(await host.commitCalendarEventTaskCreate(command));
    expect(useTaskStore.getState()._tasksById.get(requestId)?.description).toBe(command.prepared.task.description);
    const expanded = copy(command);
    expanded.prepared.intent.props.description += 'X';
    expanded.prepared.task.description += 'X';
    expect(host.validatePreparedCalendarEventTaskCreate(expanded).ok).toBe(false);
});

it('retains heavily escaped copied text across JSON serialization and UTF8 admission', async () => {
    const host = await open();
    const input = request();
    input.event.description = '\u0000"\\界😀'.repeat(3000);
    input.calendarName = null;
    const command = await prepare(host, input);
    expect(host.validatePreparedCalendarEventTaskCreate(copy(command)).ok).toBe(true);
    expect(command.prepared.task.description).toBe(input.event.description);
    expect(Buffer.byteLength(JSON.stringify(command), 'utf8')).toBeGreaterThan(JSON.stringify(command).length);
});

it('rejects unknown metadata, raw limits and invalid dates before preparing or writing anything', async () => {
    const saveData = vi.fn(async () => undefined);
    const host = await open(saveData);
    saveData.mockClear();
    const invalid: unknown[] = [
        { ...request(), eventRef: { id: 'private' } },
        { ...request(), calendar: { status: 'ready', events: [] } },
        { ...request(), event: { ...request().event, id: 'private-event' } },
        { ...request(), event: { ...request().event, sourceId: 'private-source' } },
        { ...request(), event: { ...request().event, nativeEventId: 'private-native' } },
        { ...request(), event: { ...request().event, url: 'https://private.invalid' } },
        { ...request(), event: { ...request().event, description: 'x'.repeat(20_001) } },
        { ...request(), event: { ...request().event, title: 'x'.repeat(2001) } },
        { ...request(), event: { ...request().event, location: 'x'.repeat(2001) } },
        { ...request(), calendarName: 'x'.repeat(2001) },
        { ...request(), fallbackTitle: 'x'.repeat(2001) },
        { ...request(), event: { ...request().event, start: '2026-02-30T10:00:00.000Z' } },
        { ...request(), event: { ...request().event, start: '2026-10-31T10:00:00' } },
        { ...request(), event: { ...request().event, start: '2026-10-31' } },
        { ...request(), state: { ...request().state, extra: true } },
        { ...request(), state: { ...request().state, selectedDate: null } },
        { ...request(), state: { ...request().state, visibleMonth: '2026-02-30' } },
        { ...request(), state: { ...request().state, viewMode: 'bad' } },
        { ...request(), requestId: 'NOT-A-UUID' },
    ];
    for (const item of invalid) expect((await host.prepareCalendarEventTaskCreate(item as NativeCalendarEventTaskCreateRequest)).ok).toBe(false);
    expect(saveData).not.toHaveBeenCalled();
    expect(useTaskStore.getState()._tasksById.has(requestId)).toBe(false);
});

it('strips provider metadata from the owned sheet template and exposes exact occurrence references on event rows', async () => {
    const host = await open();
    const input = request();
    const event = { ...input.event, id: 'provider-event-secret', sourceId: 'provider-source-secret', nativeEventId: 'native-secret' };
    const sheet = value(host.getCalendarItemSheet({ event, canOpen: false, state: input.state, calendarName: input.calendarName }));
    expect(sheet.kind).toBe('event');
    if (sheet.kind !== 'event') return;
    expect(sheet.buttons.map((button) => button.id)).toEqual(['createTask', 'cancel']);
    expect(sheet.creationTemplate).toEqual({ event: input.event, state: input.state, calendarName: input.calendarName, fallbackTitle: 'Calendar event' });
    const command = await prepare(host, { ...sheet.creationTemplate!, requestId });
    expect(JSON.stringify(command)).not.toMatch(/provider-event-secret|provider-source-secret|native-secret/);
    const view = value(host.getCalendarView({ state: { viewMode: 'day', selectedDate: '2026-10-31', visibleMonth: '2026-10-31' },
        calendar: { status: 'ready', calendars: [], events: [event] }, offset: 0, limit: 100 }));
    const items = view.items.flatMap((entry) => entry.type === 'item' ? [entry.item] : entry.type === 'day' ? entry.preview : []);
    expect(items.filter((item) => item.kind === 'event').map((item) => item.eventRef)).toEqual([
        { sourceId: event.sourceId, id: event.id, start: event.start, end: event.end },
    ]);
    expect(items.filter((item) => item.taskId).every((item) => item.eventRef === null)).toBe(true);
});

it('rejects forged frozen request, factory, navigation, clock, device, terminal and Area effects without writes', async () => {
    const saveData = vi.fn(async () => undefined);
    const host = await open(saveData);
    const command = await prepare(host);
    saveData.mockClear();
    const invalid: Array<(item: typeof command) => void> = [
        (item) => { item.request.event.title = 'Changed'; },
        (item) => { item.prepared.task.title = 'Changed'; },
        (item) => { item.prepared.task.location = 'Changed'; },
        (item) => { item.prepared.task.rev = 2; },
        (item) => { item.prepared.intent.props.dueDate = '2027-01-01'; },
        (item) => { item.prepared.intent.props.status = 'inbox'; },
        (item) => { item.prepared.intent.props.projectId = 'some-project'; },
        (item) => { item.prepared.intent.props.attachments = []; },
        (item) => { item.prepared.preparedAt = '2030-01-01T00:00:00.000Z'; },
        (item) => { item.prepared.deviceIdBefore = 'other-device'; },
        (item) => { item.prepared.deviceIdToInitialize = '3475c779-e751-42d3-a2ea-85abffb3be73'; },
        (item) => { item.prepared.projection.localDay = '2026-11-01'; },
        (item) => { item.prepared.projection.localMinute += 1; },
        (item) => { item.prepared.result.next!.viewMode = 'day'; },
        (item) => { item.prepared.result.next!.selectedDate = '2027-01-01'; },
        (item) => { item.prepared.result.toast = { tone: 'success', title: 'Forged', message: 'Forged', durationMs: 3000 }; },
        (item) => { item.prepared.result.changed = false; },
        (item) => { item.prepared.creation.focusRequested = true; },
        (item) => { item.prepared.creation.selectedProject = { id: 'private-project' } as never; },
        (item) => { item.prepared.defaultAreaWitness = { id: 'forged', before: null }; },
    ];
    for (const mutate of invalid) {
        const altered = copy(command);
        mutate(altered);
        expect(host.validatePreparedCalendarEventTaskCreate(altered).ok).toBe(false);
        expect((await host.commitCalendarEventTaskCreate(altered)).ok).toBe(false);
    }
    const oversized = { ...command, unexpected: '😀'.repeat(500_001) };
    expect(Buffer.byteLength(JSON.stringify(oversized), 'utf8')).toBeGreaterThan(2_000_000);
    expect(host.validatePreparedCalendarEventTaskCreate(oversized).ok).toBe(false);
    expect(saveData).not.toHaveBeenCalled();
});

it.each(['edit', 'delete', 'purge'] as const)('preserves a later %s against the frozen receipt and refuses a new hot occupied UUID', async (change) => {
    const saveData = vi.fn(async () => undefined);
    const host = await open(saveData);
    const command = await prepare(host);
    value(await host.commitCalendarEventTaskCreate(command));
    if (change === 'edit') await useTaskStore.getState().updateTask(requestId, { title: 'Later edit' });
    else if (change === 'delete') await useTaskStore.getState().deleteTask(requestId);
    else {
        expect((await useTaskStore.getState().deleteTask(requestId)).success).toBe(true);
        expect((await useTaskStore.getState().purgeTask(requestId)).success).toBe(true);
    }
    await flushPendingSave();
    const row = copy(useTaskStore.getState()._tasksById.get(requestId)!);
    saveData.mockClear();
    expect((await host.commitCalendarEventTaskCreate(command)).ok).toBe(false);
    expect((await host.prepareCalendarEventTaskCreate(request())).ok).toBe(false);
    expect(useTaskStore.getState()._tasksById.get(requestId)).toEqual(row);
    expect(saveData).not.toHaveBeenCalled();
});

it('allows an intentional second copy under a different operation UUID', async () => {
    const host = await open();
    value(await host.commitCalendarEventTaskCreate(await prepare(host)));
    const second = await prepare(host, { ...request(), requestId: '4475c779-e751-42d3-a2ea-85abffb3be73' });
    value(await host.commitCalendarEventTaskCreate(second));
    expect(useTaskStore.getState()._tasksById.get(second.request.requestId)?.title).toBe(useTaskStore.getState()._tasksById.get(requestId)?.title);
});

it('guards a missing trimmed fixed default Area before publication and answers the durable row before that witness', async () => {
    const saveData = vi.fn(async () => undefined);
    const host = await open(saveData);
    configureDefault(' missing-area ');
    const command = await prepare(host);
    expect(command.prepared.defaultAreaWitness).toEqual({ id: 'missing-area', before: null });
    expect(command.prepared.task.areaId).toBeUndefined();
    insertArea(area('missing-area'));
    saveData.mockClear();
    expect((await host.commitCalendarEventTaskCreate(command)).ok).toBe(false);
    expect(saveData).not.toHaveBeenCalled();
    useTaskStore.setState((state) => ({ _allAreas: state._allAreas.filter((entry) => entry.id !== 'missing-area'),
        _areasById: new Map([...state._areasById].filter(([id]) => id !== 'missing-area')) }));
    value(await host.commitCalendarEventTaskCreate(command));
    insertArea(area('missing-area'));
    configureDefault('different-area');
    useTaskStore.setState((state) => ({ settings: { ...state.settings, deviceId: 'different-device' } }));
    saveData.mockClear();
    expect(value(await host.commitCalendarEventTaskCreate(command))).toEqual(command.prepared.result);
    expect(saveData).not.toHaveBeenCalled();
});

it.each([false, true])('guards the exact relevant present/deleted Area witness (deleted=%s)', async (deleted) => {
    const saveData = vi.fn(async () => undefined);
    const host = await open(saveData);
    const original = { ...area('fixed-area'), ...(deleted ? { deletedAt: fixture.now } : {}) };
    insertArea(original);
    configureDefault(' fixed-area ', undefined);
    const command = await prepare(host);
    expect(command.prepared.task.areaId).toBe(deleted ? undefined : 'fixed-area');
    expect(command.prepared.defaultAreaWitness).toEqual({ id: 'fixed-area', before: { deletedAt: deleted ? fixture.now : null } });
    insertArea({ ...original, deletedAt: deleted ? undefined : fixture.now });
    saveData.mockClear();
    expect((await host.commitCalendarEventTaskCreate(command)).ok).toBe(false);
    expect(saveData).not.toHaveBeenCalled();
    const forged = copy(command);
    forged.prepared.defaultAreaWitness = null;
    expect(host.validatePreparedCalendarEventTaskCreate(forged).ok).toBe(false);
});

it.each(['none', 'active'] as const)('retains ordinary default Area mode %s without introducing a fixed Area witness', async (mode) => {
    const host = await open();
    insertArea(area('unused'));
    configureDefault(' unused ', mode);
    const command = await prepare(host);
    expect(command.prepared.defaultAreaWitness).toBeNull();
    expect(command.prepared.task.areaId).toBeUndefined();
    expect(command.prepared.creation.areas).toEqual([]);
});

it('retains legacy fixed-default inference when the explicit mode is absent', async () => {
    const host = await open();
    insertArea(area('legacy-default'));
    configureDefault(' legacy-default ');
    useTaskStore.setState((state) => ({ settings: { ...state.settings, gtd: { ...state.settings.gtd, defaultAreaMode: undefined } } }));
    const command = await prepare(host);
    expect(command.prepared.creation.defaultAreaMode).toBeNull();
    expect(command.prepared.task.areaId).toBe('legacy-default');
    expect(command.prepared.defaultAreaWitness).toEqual({ id: 'legacy-default', before: { deletedAt: null } });
    value(await host.commitCalendarEventTaskCreate(command));
});

it('rejects closed sheet variants with provider extras, mixed fields or unavailable OS Open', async () => {
    const host = await open();
    const input = request();
    const event = { ...input.event, id: 'event', sourceId: 'source' };
    const valid = { event, canOpen: false, state: input.state, calendarName: null };
    const invalid = [
        { ...valid, canOpen: true },
        { ...valid, taskId: 'task' },
        { ...valid, calendar: { status: 'ready' } },
        { ...valid, calendarName: undefined },
        { ...valid, state: { ...input.state, extra: true } },
        { ...valid, event: { ...event, url: 'https://private.invalid' } },
    ];
    for (const candidate of invalid) expect(host.getCalendarItemSheet(candidate as typeof valid).ok).toBe(false);
    const legacy = value(host.getCalendarItemSheet({ event, canOpen: true }));
    expect(legacy.kind).toBe('event');
    if (legacy.kind === 'event') {
        expect(legacy.buttons.map((button) => button.id)).toEqual(['createTask', 'openInCalendar', 'cancel']);
        expect(legacy.creationTemplate).toBeUndefined();
    }
});

it('rejects unknown nested prepared members even when their value would disappear from JSON', async () => {
    const host = await open();
    const command = await prepare(host);
    for (const target of ['task', 'props', 'next', 'request'] as const) {
        const altered = copy(command);
        const record = target === 'task' ? altered.prepared.task : target === 'props' ? altered.prepared.intent.props
            : target === 'next' ? altered.prepared.result.next! : altered.prepared.request;
        Object.assign(record, { unknown: undefined });
        expect(host.validatePreparedCalendarEventTaskCreate(altered).ok).toBe(false);
    }
});

it('captures immutable request and Area inputs while preserving intentional copied URL text', async () => {
    const host = await open();
    insertArea(area('copy-default'));
    configureDefault('copy-default');
    const input = request();
    input.event.description = 'Visit https://example.com; this is copied event text.';
    const answer = value(await host.prepareCalendarEventTaskCreate(input));
    const original = structuredClone(answer.prepared);
    input.event.title = 'Changed outside';
    input.state.viewMode = 'day';
    useTaskStore.getState()._allAreas.find((entry) => entry.id === 'copy-default')!.name = 'Changed outside';
    expect(answer.prepared).toEqual(original);
    expect(answer.prepared.task.description).toContain('https://example.com');
});

it('answers a decoded prepared journal after a store snapshot reload, without a source or second durable save', async () => {
    vi.stubEnv('TZ', 'America/New_York');
    const firstSave = vi.fn(async () => undefined);
    const host = await open(firstSave);
    const command = await prepare(host);
    value(await host.commitCalendarEventTaskCreate(command));
    let snapshot = copy(firstSave.mock.calls.at(-1)![0]);
    await flushPendingSave();
    resetForTests();
    const coldSave = vi.fn(async (data: unknown) => { snapshot = copy(data); });
    setStorageAdapter({ getData: async () => snapshot as never, saveData: coldSave });
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    vi.stubEnv('TZ', 'Asia/Tokyo');
    vi.setSystemTime(new Date('2030-04-05T19:00:00.000Z'));
    const cold = createNativeHostContract();
    value(await cold.setLanguage({ storedLanguage: 'zh', systemLocale: 'zh-CN' }));
    value(await cold.activate({ writeSafetyReady: true }));
    coldSave.mockClear();
    useTaskStore.setState((state) => ({ settings: { ...state.settings, deviceId: 'changed-device',
        gtd: { defaultAreaMode: 'fixed', defaultAreaId: 'new-default' } } }));
    expect(cold.validatePreparedCalendarEventTaskCreate(copy(command)).ok).toBe(true);
    expect(value(await cold.commitCalendarEventTaskCreate(copy(command)))).toEqual(command.prepared.result);
    expect(coldSave).not.toHaveBeenCalled();
    expect(useTaskStore.getState()._tasksById.get(requestId)?.rev).toBe(1);
});

it('retains the complete row after failed persistence and retries its save without republishing the task', async () => {
    let refuseSave = false;
    const saveData = vi.fn(async () => { if (refuseSave) throw new Error('held save failure'); });
    const host = await open(saveData);
    const command = await prepare(host);
    refuseSave = true;
    const failed = await host.commitCalendarEventTaskCreate(command);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe('SAVE_FAILED');
    const published = useTaskStore.getState()._tasksById.get(requestId);
    expect(published?.rev).toBe(1);
    refuseSave = false;
    expect(value(await host.commitCalendarEventTaskCreate(copy(command)))).toEqual(command.prepared.result);
    expect(useTaskStore.getState()._tasksById.get(requestId)).toBe(published);
    expect(useTaskStore.getState()._allTasks.filter((task) => task.id === requestId)).toHaveLength(1);
});

it('keeps exact occurrence identity for equal event IDs from different sources and repeated starts', async () => {
    const host = await open();
    const input = request();
    const events = [
        { ...input.event, id: 'same-id', sourceId: '\u00e9' },
        { ...input.event, id: 'same-id', sourceId: 'e\u0301' },
        { ...input.event, id: 'same-id', sourceId: '\u00e9', start: '2026-10-31T12:00:00.000Z', end: '2026-10-31T13:00:00.000Z' },
    ];
    const view = value(host.getCalendarView({ state: { viewMode: 'day', selectedDate: '2026-10-31', visibleMonth: '2026-10-31' },
        calendar: { status: 'ready', calendars: [], events }, offset: 0, limit: 100 }));
    const references = view.items.flatMap((entry) => entry.type === 'item' && entry.item.kind === 'event' ? [entry.item.eventRef] : []);
    expect(references).toHaveLength(3);
    expect(references).toEqual(expect.arrayContaining(events.map(({ id, sourceId, start, end }) => ({ id, sourceId, start, end }))));
});


it('offers owned OS Open only for eligible system events while keeping the copied task template private', async () => {
    const saveData = vi.fn(async () => undefined);
    const host = await open(saveData);
    saveData.mockClear();
    const input = request();
    const event = { ...input.event, id: 'system:calendar:opaque-display', sourceId: 'system:calendar', nativeEventId: ' native-é ' };
    const read = (candidate = event, canOpen = true) => host.getCalendarItemSheet({ event: candidate, canOpen, state: input.state, calendarName: input.calendarName });
    const sheet = value(read());
    expect(sheet.kind).toBe('event');
    if (sheet.kind !== 'event') return;
    expect(sheet.buttons.map((button) => button.id)).toEqual(['createTask', 'openInCalendar', 'cancel']);
    expect(sheet.creationTemplate).toEqual({ event: input.event, state: input.state, calendarName: input.calendarName, fallbackTitle: 'Calendar event' });
    expect(JSON.stringify(sheet.creationTemplate)).not.toMatch(/native-|opaque-display|system:/);
    const disabled = value(read(event, false));
    if (disabled.kind !== 'event') throw new Error('Expected event sheet');
    expect(disabled.buttons.map((button) => button.id)).toEqual(['createTask', 'cancel']);
    for (const candidate of [{ ...event, sourceId: 'ics:calendar' }, { ...event, nativeEventId: '' }, { ...event, nativeEventId: '  ' }]) {
        expect(read(candidate).ok).toBe(false);
    }
    const guard = vi.spyOn(sandbox, 'isSandboxMode').mockReturnValue(true);
    try { expect(read().ok).toBe(false); } finally { guard.mockRestore(); }
    expect(saveData).not.toHaveBeenCalled();
    expect(useTaskStore.getState()._tasksById.has(requestId)).toBe(false);
});
