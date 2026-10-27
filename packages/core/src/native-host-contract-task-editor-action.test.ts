import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeHostContract } from './native-host-contract';
import { taskRevisionOf } from './native-request-receipts';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Project, Task } from './types';

const at = '2026-09-27T15:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const task = (patch: Partial<Task> = {}): Task => ({
    id: 'task', title: 'Pack the kitchen', status: 'next', tags: [], contexts: [], projectId: 'p', order: 1, orderNum: 1,
    checklist: [{ id: 'c1', title: 'Wrap the glasses', isCompleted: false }],
    createdAt: at, updatedAt: at, rev: 2, revBy: 'other', ...patch,
});
const project = (id: string, patch: Partial<Project> = {}): Project => ({
    id, title: id === 'p' ? 'Move house' : id, status: 'active', color: '#123456', order: 0, tagIds: [], createdAt: at, updatedAt: at, ...patch,
});

async function open(initial: Partial<AppData> = {}, failSave?: () => boolean) {
    await flushPendingSave();
    resetForTests();
    let data: AppData = { tasks: [task()], projects: [project('p')], sections: [], areas: [], people: [], settings: { deviceId: 'device' }, ...initial };
    let saves = 0;
    setStorageAdapter({ getData: async () => structuredClone(data), saveData: async (next) => {
        if (failSave?.()) throw new Error('disk unavailable');
        data = structuredClone(next);
        saves += 1;
    } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [], settings: {},
        error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    const host = createNativeHostContract();
    expect(await host.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' })).toMatchObject({ ok: true });
    expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
    return { host, data: () => data, saves: () => saves, stored: () => data.tasks.find((row) => row.id === 'task')! };
}
const revision = () => taskRevisionOf(useTaskStore.getState()._tasksById.get('task')!);
const action = (n: number, kind: string, extra: Record<string, unknown> = {}) =>
    ({ requestId: uuid(n), taskId: 'task', taskRevision: revision(), kind, ...extra }) as never;
const scheduleBase = { startTime: null, dueDate: null, relativeStartOffset: null, reviewAt: null };

afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await flushPendingSave();
    resetForTests();
});

describe('runTaskEditorAction', () => {
    it('converts to a section once; a replay answers the same section and writes nothing', async () => {
        const { host, data, saves } = await open();
        const input = action(1, 'convertToSection');
        expect(await host.runTaskEditorAction(input)).toEqual({ ok: true,
            value: { kind: 'convertToSection', outcome: 'saved', projectId: 'p', sectionId: uuid(1) } });
        expect(data().sections.map((row) => [row.id, row.title])).toEqual([[uuid(1), 'Pack the kitchen']]);
        expect(data().tasks.filter((row) => row.sectionId === uuid(1)).map((row) => row.title)).toEqual(['Wrap the glasses']);
        expect(data().tasks.find((row) => row.id === 'task')?.deletedAt).toBeTruthy();
        const count = saves();
        expect(await host.runTaskEditorAction(input)).toEqual({ ok: true,
            value: { kind: 'convertToSection', outcome: 'unchanged', projectId: 'p', sectionId: uuid(1) } });
        expect(saves()).toBe(count);
        // After a restart (a new contract), the journal's replay still finds the section and writes nothing.
        const cold = await open({ tasks: data().tasks, sections: data().sections });
        expect(await cold.host.runTaskEditorAction(input)).toMatchObject({ ok: true, value: { outcome: 'unchanged', sectionId: uuid(1) } });
        expect(cold.data().sections).toHaveLength(1);
    });

    it('refuses a Convert to section request ID that already made another task\'s section, and writes nothing', async () => {
        const { host, data } = await open({ tasks: [task(), task({ id: 'other', title: 'Paint the hall' })] });
        expect(await host.runTaskEditorAction(action(30, 'convertToSection'))).toMatchObject({ ok: true, value: { outcome: 'saved' } });
        const reused = { requestId: uuid(30), taskId: 'other', taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get('other')!),
            kind: 'convertToSection' };
        expect(await host.runTaskEditorAction(reused as never))
            .toEqual({ ok: false, error: { code: 'INVALID_INPUT', message: 'Request ID already belongs to another action' } });
        expect(data().tasks.find((row) => row.id === 'other')?.deletedAt).toBeUndefined();
        expect(data().sections).toHaveLength(1);
    });

    it('prepares Convert to section again when a sync lands between its preparation and commit', async () => {
        const { host, data } = await open();
        const prepare = host.prepareTaskToSection.bind(host);
        let synced = false;
        const spy = vi.spyOn(host, 'prepareTaskToSection').mockImplementation((input) => {
            const answer = prepare(input);
            if (!synced) {
                synced = true;
                void useTaskStore.getState().addSection('p', 'Synced section');
            }
            return answer;
        });
        expect(await host.runTaskEditorAction(action(2, 'convertToSection'))).toMatchObject({ ok: true, value: { outcome: 'saved' } });
        expect(spy).toHaveBeenCalledTimes(2);
        expect(data().sections.find((row) => row.id === uuid(2))?.order).toBe(1);
    });

    it('refuses an action on a task changed since the editor opened, and a task without a project', async () => {
        const { host } = await open();
        const old = { ...(action(3, 'convertToSection') as object), taskRevision: '1:old:2026-01-01T00:00:00.000Z' };
        expect(await host.runTaskEditorAction(old as never)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(await host.runTaskEditorAction({ ...(action(4, 'promote', { title: 'New' }) as object),
            taskRevision: '1:old:2026-01-01T00:00:00.000Z' } as never)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(await host.runTaskEditorAction({ ...(action(5, 'delete') as object),
            taskRevision: '1:old:2026-01-01T00:00:00.000Z' } as never)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        const loose = await open({ tasks: [task({ projectId: undefined })] });
        expect(await loose.host.runTaskEditorAction(action(6, 'convertToSection')))
            .toEqual({ ok: false, error: { code: 'INVALID_INPUT', message: 'Task is not in a project' } });
    });

    it('answers SAVE_FAILED when the save fails, and the retry lands Convert to section once', async () => {
        let failing = false;
        const { host, data } = await open({}, () => failing);
        failing = true;
        const input = action(7, 'convertToSection');
        expect(await host.runTaskEditorAction(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        failing = false;
        expect(await host.runTaskEditorAction(input)).toEqual({ ok: true,
            value: { kind: 'convertToSection', outcome: 'saved', projectId: 'p', sectionId: uuid(7) } });
        expect(data().sections).toHaveLength(1);
        expect(data().tasks.filter((row) => row.sectionId === uuid(7))).toHaveLength(1);
    });

    it('promotes to a new project; a replay answers the same reply and writes nothing', async () => {
        const { host, data, saves } = await open();
        const input = action(8, 'promote', { title: ' Kitchen project ' });
        const first = await host.runTaskEditorAction(input);
        expect(first).toEqual({ ok: true, value: { kind: 'promote', outcome: 'saved', projectId: uuid(8), reused: false } });
        expect(data().projects.find((row) => row.id === uuid(8))?.title).toBe('Kitchen project');
        expect(data().tasks.find((row) => row.id === 'task')?.projectId).toBe(uuid(8));
        const count = saves();
        expect(await host.runTaskEditorAction(input)).toEqual(first);
        expect(saves()).toBe(count);
        expect(data().projects).toHaveLength(2);
    });

    it('deletes once, replays unchanged, and its Undo restores the task once', async () => {
        const { host, stored, saves } = await open();
        const input = action(9, 'delete');
        expect(await host.runTaskEditorAction(input)).toEqual({ ok: true, value: { kind: 'delete', outcome: 'saved' } });
        expect(stored().deletedAt).toBeTruthy();
        const count = saves();
        expect(await host.runTaskEditorAction(input)).toEqual({ ok: true, value: { kind: 'delete', outcome: 'unchanged' } });
        expect(saves()).toBe(count);
        const undo = action(10, 'deleteUndo', { deleteRequestId: uuid(9) });
        expect(await host.runTaskEditorAction(undo)).toEqual({ ok: true, value: { kind: 'deleteUndo', outcome: 'saved' } });
        expect(stored().deletedAt).toBeUndefined();
        const restored = saves();
        expect(await host.runTaskEditorAction(undo)).toEqual({ ok: true, value: { kind: 'deleteUndo', outcome: 'unchanged' } });
        expect(saves()).toBe(restored);
    });

    it('refuses a Delete Undo this process did not confirm (after a restart)', async () => {
        const { host, data } = await open();
        expect(await host.runTaskEditorAction(action(11, 'delete'))).toMatchObject({ ok: true });
        const cold = await open({ tasks: data().tasks });
        expect(await cold.host.runTaskEditorAction(action(12, 'deleteUndo', { deleteRequestId: uuid(11) })))
            .toEqual({ ok: false, error: { code: 'STALE_REVISION', message: 'The Delete can no longer be undone' } });
        expect(cold.stored().deletedAt).toBeTruthy();
    });

    it('cancels with the editor draft and RN\'s Undo toast; a replay answers the same; its Undo restores once', async () => {
        const { host, stored, saves } = await open();
        const input = action(13, 'cancel', { save: { base: { title: 'Pack the kitchen' }, patch: { title: 'Pack it all' }, scheduleBase } });
        const first = await host.runTaskEditorAction(input);
        expect(first).toEqual({ ok: true, value: { kind: 'cancel', outcome: 'saved', cancellation: {
            message: 'Task cancelled. You can restore it from Archive.', undoLabel: 'Undo', undoEnabled: true } } });
        expect(stored()).toMatchObject({ title: 'Pack it all', status: 'archived' });
        expect(stored().cancelledAt).toBeTruthy();
        const count = saves();
        expect(await host.runTaskEditorAction(input)).toEqual(first);
        expect(saves()).toBe(count);
        const undo = action(14, 'cancelUndo', { cancelRequestId: uuid(13) });
        expect(await host.runTaskEditorAction(undo)).toEqual({ ok: true, value: { kind: 'cancelUndo', outcome: 'saved' } });
        expect(stored()).toMatchObject({ title: 'Pack it all', status: 'next' });
        expect(stored().cancelledAt).toBeUndefined();
        const restored = saves();
        expect(await host.runTaskEditorAction(undo)).toEqual({ ok: true, value: { kind: 'cancelUndo', outcome: 'saved' } });
        expect(saves()).toBe(restored);
    });

    it('refuses a cancel whose draft base changed (STALE_REVISION), and an Undo of a cancel this process never made', async () => {
        const { host, stored, data } = await open();
        expect(await host.runTaskEditorAction(action(15, 'cancel', { save: { base: { title: 'Older title' }, patch: { title: 'Mine' }, scheduleBase } })))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(stored().status).toBe('next');
        expect(await host.runTaskEditorAction(action(16, 'cancel', { save: { base: {}, patch: {}, scheduleBase } }))).toMatchObject({ ok: true });
        const cold = await open({ tasks: data().tasks });
        expect(await cold.host.runTaskEditorAction(action(17, 'cancelUndo', { cancelRequestId: uuid(16) })))
            .toEqual({ ok: false, error: { code: 'STALE_REVISION', message: 'The cancellation can no longer be undone' } });
        expect(cold.stored().status).toBe('archived');
    });

    it('answers an unchanged Undo whose save fails with SAVE_FAILED, and its retry with the full reply', async () => {
        let failing = false;
        const { host } = await open({ tasks: [task(), task({ id: 'other', title: 'Paint the hall' })] }, () => failing);
        expect(await host.runTaskEditorAction(action(31, 'cancel', { save: { base: {}, patch: {}, scheduleBase } }))).toMatchObject({ ok: true });
        expect(await host.runTaskEditorAction(action(32, 'cancelUndo', { cancelRequestId: uuid(31) }))).toMatchObject({ ok: true });
        // A second Undo tap finds the task restored while an unrelated change waits for a save that fails.
        void useTaskStore.getState().updateTask('other', { title: 'Queued' });
        failing = true;
        const again = action(33, 'cancelUndo', { cancelRequestId: uuid(31) });
        expect(await host.runTaskEditorAction(again)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        failing = false;
        expect(await host.runTaskEditorAction(again)).toEqual({ ok: true, value: { kind: 'cancelUndo', outcome: 'unchanged' } });
    });

    it('answers SAVE_FAILED for a cancel whose save fails, and the retry only saves it', async () => {
        let failing = false;
        const { host, stored } = await open({}, () => failing);
        failing = true;
        const input = action(18, 'cancel', { save: { base: {}, patch: {}, scheduleBase } });
        expect(await host.runTaskEditorAction(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(stored().status).toBe('next');
        failing = false;
        expect(await host.runTaskEditorAction(input)).toMatchObject({ ok: true, value: { kind: 'cancel', outcome: 'saved',
            cancellation: { undoLabel: 'Undo' } } });
        expect(stored().status).toBe('archived');
    });

    it('skips one occurrence; a replay answers the same and makes no second occurrence', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(at));
        const recurring = task({ projectId: undefined, dueDate: '2026-09-27', recurrence: { rule: 'daily', strategy: 'strict' } });
        const { host, data, saves } = await open({ tasks: [recurring] });
        const stale = action(20, 'skip', { save: { base: { title: 'Older title' }, patch: { title: 'Mine' },
            scheduleBase: { ...scheduleBase, dueDate: '2026-09-27' } } });
        expect(await host.runTaskEditorAction(stale)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(data().tasks).toHaveLength(1);
        const input = action(19, 'skip', { save: { base: {}, patch: {}, scheduleBase: { ...scheduleBase, dueDate: '2026-09-27' } } });
        expect(await host.runTaskEditorAction(input)).toEqual({ ok: true, value: { kind: 'skip', outcome: 'saved' } });
        expect(data().tasks).toHaveLength(2);
        expect(data().tasks.find((row) => row.id !== 'task')?.dueDate).toBe('2026-09-28');
        const count = saves();
        expect(await host.runTaskEditorAction(input)).toEqual({ ok: true, value: { kind: 'skip', outcome: 'saved' } });
        expect(saves()).toBe(count);
        expect(data().tasks).toHaveLength(2);
    });

    it('refuses malformed or unbounded actions', async () => {
        const { host } = await open();
        const good = action(21, 'delete') as Record<string, unknown>;
        for (const bad of [
            { ...good, requestId: 'a0000000-0000-4000-8000-000000000021'.toUpperCase() },
            { ...good, extra: true },
            { ...good, kind: 'duplicate' },
            { ...good, taskRevision: '' },
            { ...good, kind: 'deleteUndo', deleteRequestId: uuid(21) },
            { ...good, kind: 'promote', title: '   ' },
            { ...good, kind: 'cancel', save: { base: {}, patch: {}, scheduleBase, other: 1 } },
        ]) expect(await host.runTaskEditorAction(bad as never), JSON.stringify(bad)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });
});
