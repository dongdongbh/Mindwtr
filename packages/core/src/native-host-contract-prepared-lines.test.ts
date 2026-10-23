import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeHostContract } from './native-host-contract';
import { validatePreparedQuickCaptureLines, type NativePreparedQuickCaptureLines, type NativeQuickCaptureLinesInput } from './native-host-contract-quick-capture';
import { loadQuickCaptureFixture, seedQuickCaptureStore } from './quick-capture-model.replay';
import { saveQuickCaptureBulk, resolveQuickCaptureDefaultAreaId } from './quick-capture-model';
import { buildQuickAddParseOptions } from './quick-add';
import { safeFormatDate } from './date';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import { taskToSqliteRow } from './task-sync-schema';
import { projectToSqliteRow } from './project-sync-schema';
import { generateUUID } from './uuid';
import type { Project, Task } from './types';
import * as logger from './logger';

const fixture = loadQuickCaptureFixture();
const originalTz = process.env.TZ;
const value = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const activate = async (recoveryLoad = false) => {
    const host = createNativeHostContract();
    value(await host.setLanguage({ storedLanguage: 'en', systemLocale: null }));
    value(await host.activate({ writeSafetyReady: true, recoveryLoad }));
    return host;
};
const open = async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(fixture.now));
    const saveData = vi.fn().mockResolvedValue(undefined);
    const recorder = await seedQuickCaptureStore(fixture, { settings: 'base' }, { saveData });
    const host = await activate();
    const options = value(host.openQuickCapture()).options;
    saveData.mockClear(); recorder.log.length = 0;
    return { host, options, saveData, recorder };
};
const prepare = (host: ReturnType<typeof createNativeHostContract>, request: NativeQuickCaptureLinesInput) => {
    const outcome = value(host.prepareQuickCaptureLines(request));
    if (outcome.kind !== 'prepared') throw new Error('Expected prepared lines');
    return JSON.parse(JSON.stringify({ request, prepared: outcome.prepared })) as { request: NativeQuickCaptureLinesInput; prepared: NativePreparedQuickCaptureLines };
};
const stateRows = () => JSON.stringify({ tasks: useTaskStore.getState()._allTasks.map(taskToSqliteRow),
    projects: useTaskStore.getState()._allProjects.map(projectToSqliteRow), settings: useTaskStore.getState().settings });
afterEach(async () => {
    vi.useRealTimers(); await flushPendingSave().catch(() => undefined); resetForTests(); vi.restoreAllMocks();
    if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz;
});

describe('prepared native multiline capture prerequisite', () => {
    it('prepares detached canonical rows without task, project, device or persistence writes', async () => {
        const { host, options, saveData, recorder } = await open();
        const before = stateRows();
        const request = { text: 'Read +Fresh project /due:tomorrow\nCall @phone',
            options: { ...options, note: 'Typed note', startTime: '2026-10-01T14:30:00.000Z', dueDate: '2026-10-02' },
            captureIds: [generateUUID(), generateUUID()] };
        const command = prepare(host, request);
        expect(stateRows()).toBe(before); expect(recorder.log).toEqual([]); expect(saveData).not.toHaveBeenCalled();
        expect(command.prepared.tasks).toHaveLength(2); expect(command.prepared.projects).toHaveLength(1);
        expect(command.prepared.tasks[0]).toMatchObject({ description: 'Typed note', startTime: request.options.startTime, dueDate: '2026-10-02' });
        expect(validatePreparedQuickCaptureLines(command)).toEqual({ ok: true, value: { kind: 'saved', taskIds: request.captureIds } });
        request.options.note = 'Later draft';
        expect(command.prepared.request.options.note).toBe('Typed note');
    });

    it('checks an invalid later date before creating any project or device state', async () => {
        const { host, options, saveData } = await open(); const before = stateRows();
        expect(value(host.prepareQuickCaptureLines({ text: 'Plan +Fresh\nPay /due:whenever', options,
            captureIds: [generateUUID(), generateUUID()] }))).toMatchObject({ kind: 'refused' });
        expect(stateRows()).toBe(before); expect(saveData).not.toHaveBeenCalled();
    });

    it('matches RN bulk project reuse, sequential focus budget, task order and parsed options', async () => {
        const { host, options } = await open();
        const settings = { ...useTaskStore.getState().settings, features: { priorities: true },
            gtd: { focusTaskLimit: 1, defaultProjectFlowMode: 'sequential' as const } };
        useTaskStore.setState({ settings, _allTasks: useTaskStore.getState()._allTasks.map((task) => ({ ...task, isFocusedToday: false })) });
        value(host.openQuickCapture());
        const text = 'First +Batch /next\nSecond +Batch /next\nThird @home /due:tomorrow';
        const request = { text, options: { ...options, note: 'Typed', focus: true, priority: 'high' as const },
            captureIds: [generateUUID(), generateUUID(), generateUUID()] };
        const command = prepare(host, request);
        expect(command.prepared.projects).toHaveLength(1);
        expect(command.prepared.tasks.slice(0, 2).map((task) => task.order)).toEqual([0, 1]);
        expect(command.prepared.tasks[0].isFocusedToday).toBe(true);
        expect(command.prepared.tasks[1].isFocusedToday).toBe(false);
        const semanticRows = (tasks: Task[], projects: Project[]) => tasks.map((task) => {
            const { id: _id, revBy: _device, projectId, ...row } = task;
            return { ...row, project: projects.find((project) => project.id === projectId)?.title };
        });
        const preparedRows = JSON.parse(JSON.stringify(semanticRows(command.prepared.tasks, command.prepared.projects)));
        const state = useTaskStore.getState();
        const initialIDs = new Set(state._allTasks.map((task) => task.id));
        expect(await saveQuickCaptureBulk({ lines: text.split('\n'), options: request.options,
            context: { settings: state.settings, projects: state.projects, areas: state.areas,
                parseOptions: buildQuickAddParseOptions(state.settings, state), focusedCount: state.getFocusedCount(),
                defaultAreaId: resolveQuickCaptureDefaultAreaId(state.settings, state.areas),
                t: (key) => key, formatDate: safeFormatDate, now: new Date() },
            actions: { addProject: state.addProject, addTasks: state.addTasks } })).toEqual({ kind: 'saved' });
        const actual = useTaskStore.getState();
        expect(JSON.parse(JSON.stringify(semanticRows(actual._allTasks.filter((task) => !initialIDs.has(task.id)), actual._allProjects))))
            .toEqual(preparedRows);
    });

    it('publishes tasks and projects together once, then acknowledges an exact receipt without another insert', async () => {
        const { host, options, saveData } = await open();
        const command = prepare(host, { text: 'One +Batch\nTwo +Batch', options, captureIds: [generateUUID(), generateUUID()] });
        const publications: number[] = [];
        const unsubscribe = useTaskStore.subscribe((next, previous) => {
            if (next._allTasks !== previous._allTasks || next._allProjects !== previous._allProjects) {
                publications.push(next._allTasks.filter((task) => command.request.captureIds.includes(task.id)).length);
            }
        });
        expect(value(await host.commitPreparedQuickCaptureLines(command))).toEqual(command.prepared.result);
        const after = stateRows(); saveData.mockClear();
        expect(value(await host.commitPreparedQuickCaptureLines(command))).toEqual(command.prepared.result);
        unsubscribe(); expect(publications).toEqual([2]); expect(stateRows()).toBe(after); expect(saveData).not.toHaveBeenCalled();
    });

    it('retains a failed adapter save and retries frozen rows without reparsing or changing revisions', async () => {
        const { host, options, saveData } = await open();
        const command = prepare(host, { text: 'One +Batch /due:tomorrow\nTwo', options, captureIds: [generateUUID(), generateUUID()] });
        const diagnostic = vi.spyOn(logger, 'logInfo').mockImplementation(() => undefined);
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.commitPreparedQuickCaptureLines(command)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(diagnostic.mock.calls.filter(([message]) => message === 'Prepared native capture lines saved')).toEqual([]);
        const after = stateRows(); vi.setSystemTime(new Date('2026-10-03T14:00:00.000Z'));
        saveData.mockResolvedValue(undefined);
        expect(value(await host.commitPreparedQuickCaptureLines(command))).toEqual(command.prepared.result);
        expect(stateRows()).toBe(after);
        expect(diagnostic).toHaveBeenCalledWith('Prepared native capture lines saved', {
            scope: 'native-host', category: 'storage',
            context: { releaseCheck: 'v1.3.5/native-capture-lines', operation: 'captureLinesCommit', count: 2 },
        });
    }, 25_000);

    it.each(['project-only', 'task-subset', 'all'])('replays %s exact rows after restart, timezone and settings changes', async (scenario) => {
        const { host, options, saveData } = await open();
        const command = prepare(host, { text: 'One +Batch /due:tomorrow\nTwo +Batch /due:2026-10-02',
            options: { ...options, note: 'Frozen note' }, captureIds: [generateUUID(), generateUUID()] });
        const state = useTaskStore.getState();
        useTaskStore.setState({ _allProjects: [...state._allProjects, ...command.prepared.projects],
            _allTasks: [...state._allTasks, ...(scenario === 'all' ? command.prepared.tasks : scenario === 'task-subset' ? [command.prepared.tasks[0]] : [])],
            settings: { ...state.settings, deviceId: 'current-device', dateFormat: 'ymd', features: { priorities: false },
                gtd: { defaultAreaMode: 'fixed', defaultAreaId: 'a-work', focusTaskLimit: 1 } } });
        await useTaskStore.getState().persistSnapshot(); await flushPendingSave();
        vi.setSystemTime(new Date('2026-10-10T02:00:00.000Z')); process.env.TZ = 'Pacific/Auckland';
        const restarted = await activate(true); saveData.mockClear();
        expect(value(await restarted.commitPreparedQuickCaptureLines(command))).toEqual(command.prepared.result);
        const after = useTaskStore.getState();
        expect(command.prepared.tasks.map((task) => taskToSqliteRow(after._tasksById.get(task.id)!)))
            .toEqual(command.prepared.tasks.map(taskToSqliteRow));
        expect(after.settings).toMatchObject({ deviceId: 'current-device', dateFormat: 'ymd', features: { priorities: false } });
        if (scenario === 'all') expect(saveData).not.toHaveBeenCalled();
    });

    it.each(['later-edit', 'deleted', 'purged', 'project-edit', 'project-deleted', 'missing-project', 'title-collision'])('rejects %s before any missing-row insertion and keeps unrelated edits', async (scenario) => {
        const { host, options, saveData } = await open();
        const command = prepare(host, { text: 'One +Batch\nTwo +Batch', options, captureIds: [generateUUID(), generateUUID()] });
        const state = useTaskStore.getState();
        const project = command.prepared.projects[0];
        const occupied = { ...command.prepared.tasks[1],
            ...(scenario === 'later-edit' ? { description: 'External edit', rev: 2 } : {}),
            ...(scenario === 'deleted' ? { deletedAt: fixture.now } : {}),
            ...(scenario === 'purged' ? { deletedAt: fixture.now, purgedAt: fixture.now } : {}) };
        useTaskStore.setState({ _allTasks: [...state._allTasks.map((task, index) => index === 0 ? { ...task, description: 'Unrelated edit' } : task),
                ...(scenario === 'title-collision' ? [] : [occupied])],
            _allProjects: [...state._allProjects, ...(scenario === 'missing-project' ? [] : [{ ...project,
                ...(scenario === 'project-edit' ? { color: '#123456', rev: 2 } : {}),
                ...(scenario === 'project-deleted' ? { deletedAt: fixture.now } : {}),
                ...(scenario === 'title-collision' ? { id: generateUUID() } : {}) }])] });
        const before = stateRows();
        expect(await host.commitPreparedQuickCaptureLines(command)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(stateRows()).toBe(before); expect(saveData).not.toHaveBeenCalled();
        expect(useTaskStore.getState()._tasksById.has(command.prepared.tasks[0].id)).toBe(false);
    });

    it('refuses a missing row in an archived referenced project but accepts an all-landed receipt first', async () => {
        const { host, options } = await open();
        const command = prepare(host, { text: 'One\nTwo', options: { ...options, projectId: 'p-home' }, captureIds: [generateUUID(), generateUUID()] });
        await useTaskStore.getState().updateProject('p-home', { status: 'archived' });
        const before = stateRows();
        expect(await host.commitPreparedQuickCaptureLines(command)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(stateRows()).toBe(before);
        useTaskStore.setState({ _allTasks: [...useTaskStore.getState()._allTasks, ...command.prepared.tasks] });
        expect(value(await host.commitPreparedQuickCaptureLines(command))).toEqual(command.prepared.result);
    });

    it('preflights title collisions between missing operation projects before publishing either', async () => {
        const { host, options, saveData } = await open();
        const command = prepare(host, { text: 'One +Batch\nTwo +Batch', options, captureIds: [generateUUID(), generateUUID()] });
        const second = { ...command.prepared.projects[0], id: generateUUID() };
        command.prepared.projects.push(second); command.prepared.tasks[1].projectId = second.id;
        expect(validatePreparedQuickCaptureLines(command)).toMatchObject({ ok: true });
        const before = stateRows();
        expect(await host.commitPreparedQuickCaptureLines(command)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(stateRows()).toBe(before); expect(saveData).not.toHaveBeenCalled();
    });

    it('rejects closed grammar, ordered IDs and malformed frozen rows without publication', async () => {
        const { host, options, saveData } = await open();
        const command = prepare(host, { text: 'One +Batch\nTwo', options, captureIds: [generateUUID(), generateUUID()] });
        const mutations: ((row: typeof command) => void)[] = [
            (row) => { Object.assign(row, { extra: true }); }, (row) => { Object.assign(row.request, { openAfterSave: true }); },
            (row) => { row.request.captureIds.reverse(); }, (row) => { Object.assign(row.prepared, { extra: true }); },
            (row) => { row.prepared.request.options.note = 'Changed'; }, (row) => { row.prepared.tasks.reverse(); },
            (row) => { row.prepared.tasks[1].rev = 2; }, (row) => { row.prepared.tasks[1].deletedAt = fixture.now; },
            (row) => { row.prepared.tasks[1].createdAt = '2026-10-01T00:00:00.000Z'; row.prepared.tasks[1].updatedAt = row.prepared.tasks[1].createdAt; },
            (row) => { row.prepared.result.taskIds.reverse(); }, (row) => { Object.assign(row.prepared.result, { next: 'close' }); },
            (row) => { row.prepared.projects.push(row.prepared.projects[0]); },
            (row) => { row.prepared.deviceIdToInitialize = generateUUID(); },
        ];
        const before = stateRows();
        for (const mutate of mutations) {
            const invalid = JSON.parse(JSON.stringify(command)); mutate(invalid);
            expect(validatePreparedQuickCaptureLines(invalid)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await host.commitPreparedQuickCaptureLines(invalid)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(validatePreparedQuickCaptureLines(null)).toMatchObject({ ok: false });
        expect(stateRows()).toBe(before); expect(saveData).not.toHaveBeenCalled();
    });

    it('rejects duplicate/noncanonical IDs, too many lines and repeated UTF8 note payload before writes', async () => {
        const { host, options, saveData } = await open(); const before = stateRows();
        const id = generateUUID();
        for (const captureIds of [[id, id], [id.toUpperCase(), generateUUID()], [id]]) {
            expect(host.prepareQuickCaptureLines({ text: 'One\nTwo', options, captureIds })).toMatchObject({ ok: false });
        }
        expect(host.prepareQuickCaptureLines({ text: Array(1001).fill('Line').join('\n'), options,
            captureIds: Array.from({ length: 1001 }, generateUUID) })).toMatchObject({ ok: false });
        expect(host.prepareQuickCaptureLines({ text: Array(20).fill('Line').join('\n'), options: { ...options, note: 'é'.repeat(250_000) },
            captureIds: Array.from({ length: 20 }, generateUUID) })).toMatchObject({ ok: false });
        expect(stateRows()).toBe(before); expect(saveData).not.toHaveBeenCalled();
    });

    it('accepts the count boundary and measures UTF8 rather than UTF16 when bounding a repeated note', async () => {
        const { host, options, saveData } = await open();
        const atCount = prepare(host, { text: Array(1000).fill('Line').join('\n'), options,
            captureIds: Array.from({ length: 1000 }, generateUUID) });
        expect(atCount.prepared.tasks).toHaveLength(1000);
        const request = { text: Array(20).fill('Line').join('\n'), options: { ...options, note: 'a'.repeat(250_000) },
            captureIds: Array.from({ length: 20 }, generateUUID) };
        const ascii = prepare(host, request);
        expect(validatePreparedQuickCaptureLines(ascii)).toMatchObject({ ok: true });
        expect(host.prepareQuickCaptureLines({ ...request, options: { ...request.options, note: 'é'.repeat(250_000) } }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        // A hostile stored envelope can also exceed the limit independently of its request.
        ascii.prepared.tasks.forEach((task) => { task.description = 'é'.repeat(250_000); });
        const before = stateRows();
        expect(validatePreparedQuickCaptureLines(ascii)).toMatchObject({ ok: false });
        expect(await host.commitPreparedQuickCaptureLines(ascii)).toMatchObject({ ok: false });
        expect(stateRows()).toBe(before); expect(saveData).not.toHaveBeenCalled();
    }, 20_000);

    it('bounds repeated contexts after the same exact dedupe as RN planning', async () => {
        const { host, options } = await open();
        const context = '@' + 'x'.repeat(499);
        const command = prepare(host, { text: Array(20).fill('Line').join('\n'),
            options: { ...options, contexts: Array(1000).fill(context) }, captureIds: Array.from({ length: 20 }, generateUUID) });
        expect(command.prepared.tasks.every((task) => task.contexts.length === 1 && task.contexts[0] === context)).toBe(true);
    });
});
