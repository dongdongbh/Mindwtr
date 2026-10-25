import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeHostContract } from './native-host-contract';
import type { NativePreparedQuickCapture, NativeQuickCaptureInput } from './native-host-contract-quick-capture';
import { projectToSqliteRow } from './project-sync-schema';
import { loadQuickCaptureFixture, seedQuickCaptureStore } from './quick-capture-model.replay';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import { taskToSqliteRow, TASK_SQLITE_COLUMNS } from './task-sync-schema';
import { mapSqliteTaskRow } from './sqlite-adapter';
import type { Task } from './types';
import * as logger from './logger';
import { buildNewTask } from './task-creation';
import { createProjectOrderReserver } from './store-helpers';
import { resolveTaskFocusCreation } from './focus-star';
import { generateUUID } from './uuid';

const fixture = loadQuickCaptureFixture();
const value = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const activate = async (recoveryLoad?: boolean) => {
    const host = createNativeHostContract();
    value(await host.setLanguage({ storedLanguage: 'en', systemLocale: null }));
    value(await host.activate({ writeSafetyReady: true, ...(recoveryLoad === undefined ? {} : { recoveryLoad }) }));
    return host;
};
const open = async (settings = 'base', saveData = vi.fn().mockResolvedValue(undefined)) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(fixture.now));
    await seedQuickCaptureStore(fixture, { settings }, { saveData });
    const host = await activate();
    const options = value(host.openQuickCapture()).options;
    saveData.mockClear();
    return { host, options, saveData };
};
const originalTz = process.env.TZ;
const prepare = (host: ReturnType<typeof createNativeHostContract>, request: NativeQuickCaptureInput) => {
    const outcome = value(host.prepareQuickCapture(request));
    if (outcome.kind !== 'prepared') throw new Error('Capture was not prepared');
    return JSON.parse(JSON.stringify({ request, prepared: outcome.prepared })) as { request: NativeQuickCaptureInput; prepared: NativePreparedQuickCapture };
};
afterEach(async () => {
    vi.useRealTimers();
    await flushPendingSave().catch(() => undefined);
    resetForTests();
    vi.restoreAllMocks();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
});

describe('prepared native quick capture', () => {
    it('preserves review-due focused Someday capture parity with ordinary submission', async () => {
        const { host, options } = await open();
        const request = { text: 'Read /someday /review:today', options: { ...options, focus: true }, captureId: generateUUID() };
        const command = prepare(host, request);
        expect(command.prepared.task).toMatchObject({ status: 'someday', isFocusedToday: true });
        value(await host.commitPreparedQuickCapture(command));
        const ordinaryId = generateUUID();
        value(await host.submitQuickCapture({ ...request, captureId: ordinaryId }));
        const ordinary = useTaskStore.getState()._tasksById.get(ordinaryId)!;
        expect({ status: ordinary.status, reviewAt: ordinary.reviewAt, isFocusedToday: ordinary.isFocusedToday })
            .toEqual({ status: command.prepared.task.status, reviewAt: command.prepared.task.reviewAt, isFocusedToday: command.prepared.task.isFocusedToday });
    });

    it('defers scheduled promotion until exact pending replay is acknowledged, then normal activation resumes it', async () => {
        const { host, options, saveData } = await open();
        process.env.TZ = 'Pacific/Honolulu';
        vi.setSystemTime(new Date('2026-09-26T23:50:00.000Z'));
        const command = prepare(host, { text: 'Review /inbox /due:tomorrow', options: { ...options, note: 'Frozen note', addAnother: true, startTime: '2026-10-01T14:30:00.000Z' }, captureId: generateUUID() });
        expect(command.prepared.task.status).toBe('inbox');
        value(await host.commitPreparedQuickCapture(command));
        const row = taskToSqliteRow(command.prepared.task);
        saveData.mockClear();
        process.env.TZ = 'Pacific/Auckland';
        vi.setSystemTime(new Date('2026-09-29T03:10:00.000Z'));
        const restarted = await activate(true);
        expect(taskToSqliteRow(useTaskStore.getState()._tasksById.get(command.prepared.task.id)!)).toEqual(row);
        expect(value(await restarted.commitPreparedQuickCapture(command))).toEqual(command.prepared.result);
        expect(saveData).not.toHaveBeenCalled();
        value(await restarted.activate({ writeSafetyReady: true }));
        expect(useTaskStore.getState()._tasksById.get(command.prepared.task.id)).toMatchObject({ status: 'next', rev: 2 });
        expect(saveData).toHaveBeenCalled();
    });

    it('preserves a focused Waiting receipt across a backward local day before normal view normalization', async () => {
        const { host, options, saveData } = await open();
        process.env.TZ = 'America/New_York';
        vi.setSystemTime(new Date('2026-09-27T04:30:00.000Z'));
        const settings = useTaskStore.getState().settings;
        useTaskStore.setState({ settings: { ...settings, migrations: { ...settings.migrations, lastTombstoneCleanupAt: new Date().toISOString() } } });
        const command = prepare(host, { text: 'Read /waiting /review:2026-09-27 /start:2026-09-27', options: { ...options, focus: true }, captureId: generateUUID() });
        expect(command.prepared.task).toMatchObject({ status: 'waiting', isFocusedToday: true });
        value(await host.commitPreparedQuickCapture(command));
        const row = taskToSqliteRow(command.prepared.task);
        saveData.mockClear();
        process.env.TZ = 'America/Los_Angeles';
        // A backward wall-clock adjustment exercises the same local-day edge in
        // Node workers, whose process timezone may be fixed when they start.
        vi.setSystemTime(new Date('2026-09-26T04:30:00.000Z'));
        const restarted = await activate(true);
        expect(taskToSqliteRow(useTaskStore.getState()._tasksById.get(command.prepared.task.id)!)).toEqual(row);
        expect(value(await restarted.commitPreparedQuickCapture(command))).toEqual(command.prepared.result);
        expect(saveData).not.toHaveBeenCalled();
        value(await restarted.activate({ writeSafetyReady: true }));
        expect(useTaskStore.getState()._tasksById.get(command.prepared.task.id)?.isFocusedToday).toBe(false);
        expect(saveData).not.toHaveBeenCalled();
        // Entering recovery from an already-normalized store must also replace
        // the same-revision cached view with the authoritative persisted row.
        value(await restarted.activate({ writeSafetyReady: true, recoveryLoad: true }));
        expect(taskToSqliteRow(useTaskStore.getState()._tasksById.get(command.prepared.task.id)!)).toEqual(row);
        expect(value(await restarted.commitPreparedQuickCapture(command))).toEqual(command.prepared.result);
        expect(saveData).not.toHaveBeenCalled();
        value(await restarted.activate({ writeSafetyReady: true }));
        expect(useTaskStore.getState()._tasksById.get(command.prepared.task.id)?.isFocusedToday).toBe(false);
    });

    it('requires an explicit boolean recovery-load flag', async () => {
        const { host } = await open();
        expect(await host.activate({ writeSafetyReady: true, recoveryLoad: 'yes' as never }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('replays exact rows and the frozen result after midnight, timezone change, and host restart', async () => {
        process.env.TZ = 'America/New_York';
        const { host, options, saveData } = await open();
        const request = { text: 'Call tomorrow', options: { ...options, note: 'Private note', addAnother: true, focus: true }, captureId: generateUUID() };
        const command = prepare(host, request);
        expect(saveData).not.toHaveBeenCalled();
        const saved = value(await host.commitPreparedQuickCapture(command));
        const before = JSON.stringify(taskToSqliteRow(useTaskStore.getState()._tasksById.get(request.captureId)!));
        vi.setSystemTime(new Date('2026-09-27T19:00:00.000Z'));
        process.env.TZ = 'Asia/Tokyo';
        const restarted = await activate();
        const saves = saveData.mock.calls.length;
        expect(value(await restarted.commitPreparedQuickCapture(command))).toEqual(saved);
        expect(JSON.stringify(taskToSqliteRow(useTaskStore.getState()._tasksById.get(request.captureId)!))).toBe(before);
        expect(saveData).toHaveBeenCalledTimes(saves);
    });

    it('keeps original options and the result across changed settings and a renamed referenced project', async () => {
        const { host, options, saveData } = await open('priorities');
        const request = { text: 'Review /due:tomorrow', options: { ...options, projectId: 'p-home', priority: 'high' as const, dueDate: '2026-10-01', addAnother: true }, captureId: generateUUID() };
        const command = prepare(host, request);
        expect(command.prepared.request.options.dueDate).toBe('2026-10-01');
        const result = value(await host.commitPreparedQuickCapture(command));
        const state = useTaskStore.getState();
        await state.updateSettings({ features: { priorities: false }, gtd: { defaultAreaMode: 'fixed', defaultAreaId: 'a-work', defaultProjectFlowMode: 'sequential' } });
        await state.updateProject('p-home', { title: 'Renamed' });
        await flushPendingSave();
        const restarted = await activate();
        saveData.mockClear();
        expect(value(await restarted.commitPreparedQuickCapture(command))).toEqual(result);
        expect(saveData).not.toHaveBeenCalled();
        for (const changed of [
            { note: 'changed' }, { dueDate: '2026-10-02' }, { startTime: '2026-09-30T12:00:00.000Z' },
            { focus: true }, { addAnother: false }, { priority: null }, { contexts: ['@new'] },
        ]) {
            expect(await restarted.commitPreparedQuickCapture({ ...command, request: { ...request, options: { ...request.options, ...changed } } }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(await restarted.commitPreparedQuickCapture({ ...command, request: { ...request, openAfterSave: true } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(saveData).not.toHaveBeenCalled();
    });

    it.each([false, true])('round-trips no container, date-only, notes, timed start, links and exact response (open=%s)', async (openAfterSave) => {
        const { host, options } = await open();
        const request = { text: 'Read #book /note:parsed /link:https://example.com', options: { ...options, note: 'Typed', contexts: ['@home'], dueDate: '2026-10-01', startTime: '2026-09-29T16:45:00.000Z', addAnother: true }, captureId: generateUUID(), openAfterSave };
        const command = prepare(host, request);
        expect(command.prepared.task).toMatchObject({ description: 'Typed\nparsed', startTime: request.options.startTime, dueDate: '2026-10-01', tags: ['#book'], contexts: ['@home'] });
        expect(command.prepared.task.projectId).toBeUndefined();
        expect(command.prepared.task.areaId).toBeUndefined();
        expect(value(await host.commitPreparedQuickCapture(command))).toEqual(command.prepared.result);
        const row = taskToSqliteRow(command.prepared.task);
        const reloaded = mapSqliteTaskRow(Object.fromEntries(TASK_SQLITE_COLUMNS.map((column, index) => [column, row[index]])));
        expect(taskToSqliteRow(reloaded)).toEqual(row);
        useTaskStore.setState({ _allTasks: [...useTaskStore.getState()._allTasks.filter((task) => task.id !== reloaded.id), reloaded] });
        const sorted = JSON.parse(JSON.stringify(command, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
            ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right))) : entry));
        expect(value(await host.commitPreparedQuickCapture(sorted))).toEqual(command.prepared.result);
    });

    it('preserves normalized recurrence through the shared factory, JSON and SQLite codecs', async () => {
        const { host, options } = await open();
        const command = prepare(host, { text: 'Read', options, captureId: generateUUID() });
        // Quick capture has no recurrence control; exercise the same creation
        // factory/transport shape without inventing new capture UI semantics.
        const state = useTaskStore.getState();
        const built = buildNewTask({ title: command.prepared.task.title,
            initialTaskProps: { areaId: undefined, recurrence: { rule: 'weekly', byDay: ['MO', 'FR'], count: 3 } },
            id: command.prepared.task.id, now: command.prepared.task.createdAt, deviceId: command.prepared.task.revBy!,
            state, tasks: state._allTasks, focusedCount: state.getFocusedCount(), focusTaskLimit: 3,
            projectOrderReserver: createProjectOrderReserver(state._allTasks) });
        if (!built.ok) throw new Error(built.error);
        command.prepared.task = built.task;
        const json = JSON.parse(JSON.stringify(command));
        value(await host.commitPreparedQuickCapture(json));
        const row = taskToSqliteRow(useTaskStore.getState()._tasksById.get(built.task.id)!);
        const reloaded = mapSqliteTaskRow(Object.fromEntries(TASK_SQLITE_COLUMNS.map((column, index) => [column, row[index]])));
        useTaskStore.setState({ _allTasks: [...useTaskStore.getState()._allTasks.filter((task) => task.id !== reloaded.id), reloaded] });
        expect(value(await host.commitPreparedQuickCapture(json))).toEqual(command.prepared.result);
        expect(reloaded.recurrence).toEqual(built.task.recurrence);
    });

    it.each(['available', 'full', 'future', 'sequential'])('prepares the existing RN focus outcome: %s', async (scenario) => {
        const { host, options } = await open(scenario === 'full' || scenario === 'future' ? 'focusFull' : 'base');
        if (scenario === 'sequential') {
            await useTaskStore.getState().updateProject('p-home', { isSequential: true });
            await useTaskStore.getState().addTask('Earlier', { status: 'next', projectId: 'p-home' });
            await flushPendingSave();
        }
        const request = { text: 'Capture', options: { ...options, focus: true,
            ...(scenario === 'future' ? { startTime: '2026-10-01T12:00:00.000Z' } : {}),
            ...(scenario === 'sequential' ? { projectId: 'p-home' } : {}) }, captureId: generateUUID() };
        const command = prepare(host, request);
        const rnId = generateUUID();
        value(await host.submitQuickCapture({ ...request, captureId: rnId }));
        const ordinary = useTaskStore.getState()._tasksById.get(rnId)!;
        expect({ status: command.prepared.task.status, focused: command.prepared.task.isFocusedToday })
            .toEqual({ status: ordinary.status, focused: ordinary.isFocusedToday });
        expect(command.prepared.task.isFocusedToday).toBe(scenario === 'available' || scenario === 'future');
    });

    it('acknowledges the last accepted focus slot without reevaluating its own occupancy', async () => {
        const { host, options, saveData } = await open('focusFull');
        useTaskStore.setState({ _allTasks: useTaskStore.getState()._allTasks.map((task) => ({ ...task, isFocusedToday: false })) });
        const command = prepare(host, { text: 'Capture', options: { ...options, focus: true }, captureId: generateUUID() });
        expect(command.prepared.task.isFocusedToday).toBe(true);
        value(await host.commitPreparedQuickCapture(command));
        expect(useTaskStore.getState().getFocusedCount()).toBe(1);
        saveData.mockClear();
        expect(value(await host.commitPreparedQuickCapture(command))).toEqual(command.prepared.result);
        expect(saveData).not.toHaveBeenCalled();
    });

    it('uses the supplied creation clock for queued focus while existing callers default to the live clock', async () => {
        await open('focusFull');
        const state = useTaskStore.getState();
        const focus = { tasks: state._allTasks, projects: state._allProjects, sections: state._allSections,
            focusedCount: 1, focusTaskLimit: 1 };
        vi.setSystemTime(new Date('2026-10-01T12:00:00.000Z'));
        const built = buildNewTask({
            title: 'Queued at preparation', initialTaskProps: { status: 'next', startTime: '2026-09-29', isFocusedToday: true },
            id: generateUUID(), now: fixture.now, deviceId: state.settings.deviceId!, state,
            tasks: state._allTasks, focusedCount: focus.focusedCount, focusTaskLimit: focus.focusTaskLimit,
            projectOrderReserver: createProjectOrderReserver(state._allTasks),
        });
        if (!built.ok) throw new Error(built.error);
        expect(built.task.isFocusedToday).toBe(true);
        expect(built.focusedCount).toBe(1);
        expect(built.task.createdAt).toBe(fixture.now);
        expect(resolveTaskFocusCreation({ ...built.task, isFocusedToday: true }, focus).outcome).toBe('refused-limit');
    });

    it('validates containers only before inserting a missing task, and initializes only a missing device ID', async () => {
        const { host, options, saveData } = await open();
        useTaskStore.setState({ settings: { ...useTaskStore.getState().settings, deviceId: undefined } });
        const command = prepare(host, { text: 'Read', options: { ...options, projectId: 'p-home' }, captureId: generateUUID() });
        expect(command.prepared.deviceIdToInitialize).toBe(command.prepared.task.revBy);
        await useTaskStore.getState().updateProject('p-home', { status: 'archived' });
        await flushPendingSave();
        saveData.mockClear();
        expect(await host.commitPreparedQuickCapture(command)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(saveData).not.toHaveBeenCalled();
        useTaskStore.setState({ _allTasks: [...useTaskStore.getState()._allTasks, command.prepared.task] });
        expect(value(await host.commitPreparedQuickCapture(command))).toEqual(command.prepared.result);
        expect(saveData).not.toHaveBeenCalled();

        const second = prepare(host, { text: 'Second', options, captureId: generateUUID() });
        const currentDevice = useTaskStore.getState().settings.deviceId;
        useTaskStore.setState({ settings: { ...useTaskStore.getState().settings, dateFormat: 'ymd' } });
        value(await host.commitPreparedQuickCapture(second));
        expect(useTaskStore.getState().settings).toMatchObject({ deviceId: currentDevice, dateFormat: 'ymd' });
    });

    it('returns durable success even when the diagnostic sink throws', async () => {
        const { host, options } = await open();
        const command = prepare(host, { text: 'Read', options, captureId: generateUUID() });
        vi.spyOn(logger, 'logInfo').mockImplementation(() => { throw new Error('sink failed'); });
        expect(value(await host.commitPreparedQuickCapture(command))).toEqual(command.prepared.result);
    });

    it('rejects edited or tombstoned rows, including note, start, recurrence and revision-only changes', async () => {
        const { host, options, saveData } = await open();
        const command = prepare(host, { text: 'Read', options, captureId: generateUUID() });
        value(await host.commitPreparedQuickCapture(command));
        saveData.mockClear();
        const baseline = useTaskStore.getState()._allTasks;
        for (const changes of [
            { description: 'Edited' }, { startTime: '2026-10-01' }, { recurrence: { rule: 'daily' as const } },
            { rev: 2 }, { deletedAt: fixture.now }, { deletedAt: fixture.now, purgedAt: fixture.now },
        ]) {
            const modified = baseline.map((task) => task.id === command.prepared.task.id ? { ...task, ...changes } : task);
            useTaskStore.setState({ _allTasks: modified });
            expect(await host.commitPreparedQuickCapture(command)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(useTaskStore.getState()._allTasks).toBe(modified);
        }
        expect(saveData).not.toHaveBeenCalled();
    });

    it.each(['missing', 'project-only', 'both', 'project-mismatch', 'task-only', 'same-title', 'project-deleted', 'project-purged'])(
        'classifies project/task state atomically: %s', async (scenario) => {
            const { host, options, saveData } = await open();
            const command = prepare(host, { text: 'Read +Fresh project', options, captureId: generateUUID() });
            const { task, project } = command.prepared;
            if (!project) throw new Error('Expected a new project');
            const state = useTaskStore.getState();
            const projects = [...state._allProjects];
            const tasks = [...state._allTasks];
            if (['project-only', 'both'].includes(scenario)) projects.push(project);
            if (['task-only', 'both'].includes(scenario)) tasks.push(task);
            if (scenario === 'project-mismatch') projects.push({ ...project, title: 'Edited' });
            if (scenario === 'same-title') projects.push({ ...project, id: generateUUID() });
            if (scenario === 'project-deleted') projects.push({ ...project, deletedAt: fixture.now });
            if (scenario === 'project-purged') projects.push({ ...project, deletedAt: fixture.now, purgedAt: fixture.now });
            useTaskStore.setState({ _allTasks: tasks, _allProjects: projects });
            const before = JSON.stringify({ tasks, projects });
            const result = await host.commitPreparedQuickCapture(command);
            if (['missing', 'project-only', 'both'].includes(scenario)) {
                expect(value(result)).toEqual(command.prepared.result);
                expect(taskToSqliteRow(useTaskStore.getState()._tasksById.get(task.id)!)).toEqual(taskToSqliteRow(task));
                expect(projectToSqliteRow(useTaskStore.getState()._projectsById.get(project.id)!)).toEqual(projectToSqliteRow(project));
                expect(saveData).toHaveBeenCalledTimes(scenario === 'both' ? 0 : 1);
                if (scenario !== 'both') {
                    const saved = saveData.mock.lastCall![0];
                    expect(saved.tasks.some((entry: Task) => entry.id === task.id)).toBe(true);
                    expect(saved.projects.some((entry: { id: string }) => entry.id === project.id)).toBe(true);
                }
            } else {
                expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(JSON.stringify({ tasks: useTaskStore.getState()._allTasks, projects: useTaskStore.getState()._allProjects })).toBe(before);
                expect(saveData).not.toHaveBeenCalled();
            }
        },
    );

    it('finishes a failed save without recreating either row or changing their revisions', async () => {
        const { host, options, saveData } = await open();
        const command = prepare(host, { text: 'Read +Fresh project', options, captureId: generateUUID() });
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.commitPreparedQuickCapture(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        const snapshot = JSON.stringify({ tasks: useTaskStore.getState()._allTasks, projects: useTaskStore.getState()._allProjects });
        vi.setSystemTime(new Date('2026-10-01T12:00:00.000Z'));
        expect(await host.commitPreparedQuickCapture(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(JSON.stringify({ tasks: useTaskStore.getState()._allTasks, projects: useTaskStore.getState()._allProjects })).toBe(snapshot);
        saveData.mockResolvedValue(undefined);
        expect(value(await host.commitPreparedQuickCapture(command))).toEqual(command.prepared.result);
        expect(JSON.stringify({ tasks: useTaskStore.getState()._allTasks, projects: useTaskStore.getState()._allProjects })).toBe(snapshot);
    }, 20_000);

    it('rejects invalid journals and mismatched full requests without writes', async () => {
        const { host, options, saveData } = await open();
        const command = prepare(host, { text: 'Read', options, captureId: generateUUID() });
        const mutations: ((value: any) => void)[] = [
            (v) => { v.extra = true; }, (v) => { v.prepared.version = 2; }, (v) => { v.prepared.extra = true; },
            (v) => { delete v.prepared.request.options.note; }, (v) => { v.prepared.task.id = generateUUID(); },
            (v) => { v.prepared.task.rev = 2; }, (v) => { v.prepared.task.updatedAt = 'later'; },
            (v) => { v.prepared.task.status = 'unknown'; }, (v) => { v.prepared.task.tags = [{}]; },
            (v) => { v.prepared.task.recurrence = { rule: 'daily', extra: true }; },
            (v) => { v.prepared.task.deletedAt = fixture.now; }, (v) => { v.prepared.task.surprise = true; },
            (v) => { v.prepared.task.attachments = [{ kind: 'file' }]; },
            (v) => { v.prepared.result.taskId = generateUUID(); }, (v) => { v.prepared.result.next = 'open'; },
            (v) => { v.prepared.deviceIdToInitialize = generateUUID(); },
            (v) => { v.request.options.note = 'Different'; }, (v) => { v.request.options.extra = true; },
        ];
        for (const mutate of mutations) {
            const invalid = JSON.parse(JSON.stringify(command));
            mutate(invalid);
            expect(await host.commitPreparedQuickCapture(invalid)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(await host.commitPreparedQuickCapture(null as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(saveData).not.toHaveBeenCalled();
        expect(useTaskStore.getState()._tasksById.has(command.prepared.task.id)).toBe(false);
    });

    it('returns refusal/line confirmation without creating a prepared command or saving', async () => {
        const { host, options, saveData } = await open();
        expect(value(host.prepareQuickCapture({ text: 'Read /due:whenever', options, captureId: generateUUID() }))).toMatchObject({ kind: 'refused' });
        expect(value(host.prepareQuickCapture({ text: 'One\nTwo', options, captureId: generateUUID() }))).toMatchObject({ kind: 'confirmLines' });
        expect(host.prepareQuickCapture({ text: 'One\nTwo', options, captureId: 'bad' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(saveData).not.toHaveBeenCalled();
    });
});
