import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Task, TaskStore } from '@mindwtr/core';
import { runSerializedSyncDocumentWriteOperation } from '@mindwtr/core';
import { commitTimelineDateEdit, type TimelineDateEditResult } from './timeline-date-edit';

const mocks = vi.hoisted(() => ({ getState: vi.fn<() => TaskStore>(), flush: vi.fn(), log: vi.fn() }));
vi.mock('@mindwtr/core', async () => ({
    ...await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core'),
    useTaskStore: { getState: mocks.getState }, flushPendingSave: mocks.flush,
}));
vi.mock('./app-log', () => ({ logInfo: mocks.log }));

const core = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
const task = (patch: Partial<Task> = {}): Task => ({
    id: 'task', title: 'Private task', status: 'next', tags: [], contexts: [], pushCount: 3,
    startTime: '2026-10-10', dueDate: '2026-10-13', createdAt: '2026-01-01', updatedAt: '2026-01-01', ...patch,
});
const project = (patch: Partial<Project> = {}): Project => ({
    id: 'project', title: 'Private project', status: 'active', color: '#000000', order: 0, tagIds: [],
    startDate: '2026-10-10', dueDate: '2026-10-13', createdAt: '2026-01-01', updatedAt: '2026-01-01', ...patch,
});
const saved = (result: TimelineDateEditResult) => {
    expect(result.status).toBe('saved');
    if (result.status !== 'saved') throw new Error('Expected saved edit');
    return result;
};

describe('guarded timeline date persistence', () => {
    let state: TaskStore;
    beforeEach(() => {
        mocks.flush.mockReset().mockResolvedValue(undefined);
        mocks.log.mockReset().mockResolvedValue(null);
        state = {
            _tasksById: new Map([['task', task()]]), _projectsById: new Map([['project', project()]]),
            updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
                state._tasksById.set(id, { ...state._tasksById.get(id)!, ...patch });
                return { success: true };
            }),
            updateProject: vi.fn(async (id: string, patch: Partial<Project>) => {
                state._projectsById.set(id, { ...state._projectsById.get(id)!, ...patch });
                return { success: true };
            }), persistSnapshot: vi.fn().mockResolvedValue(undefined),
        } as unknown as TaskStore;
        mocks.getState.mockImplementation(() => state);
    });

    it('saves once, preserves unrelated edits, and logs only durable apply/undo outcomes', async () => {
        const before = state._tasksById.get('task')!;
        state._tasksById.set('task', { ...before, description: 'Later note' });
        const result = saved(await commitTimelineDateEdit({ kind: 'task', task: before }, { kind: 'move', days: 1 }));
        expect(state.updateTask).toHaveBeenCalledExactlyOnceWith('task', { startTime: '2026-10-11', dueDate: '2026-10-14' });
        expect(mocks.flush).toHaveBeenCalledOnce();
        state._tasksById.set('task', { ...state._tasksById.get('task')!, title: 'Later title' });
        expect(await result.undo()).toBe(true);
        expect(state._tasksById.get('task')).toMatchObject({ startTime: before.startTime, dueDate: before.dueDate,
            title: 'Later title', description: 'Later note' });
        expect(await result.undo()).toBe(true);
        expect(state.updateTask).toHaveBeenCalledTimes(2);
        expect(mocks.log.mock.calls).toEqual(['apply', 'undo'].map((operation) => ['Timeline date edit saved', {
            scope: 'timeline', extra: { releaseCheck: 'v1.3.5/timeline-date-edit', kind: 'task', operation, outcome: 'saved' },
        }]));
        expect(JSON.stringify(mocks.log.mock.calls)).not.toContain('Private');
    });

    it.each([
        { startTime: '2026-10-11' }, { dueDate: '2026-10-14' }, { relativeStartOffset: { amount: -2, unit: 'day' } },
        { pushCount: 4 }, { recurrence: { rule: 'daily', strategy: 'strict' } }, { status: 'done' },
        { projectId: 'project' }, { deletedAt: '2026-10-10' },
    ] as Partial<Task>[])('rejects a stale scheduling/lifecycle snapshot %j', async (patch) => {
        const before = task();
        state._tasksById.set('task', { ...before, ...patch });
        expect(await commitTimelineDateEdit({ kind: 'task', task: before }, { kind: 'move', days: 1 })).toEqual({ status: 'conflict' });
        expect(state.updateTask).not.toHaveBeenCalled();
    });

    it('rereads the guarded snapshot after an import barrier releases', async () => {
        const before = task();
        let release!: () => void;
        let started!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const start = new Promise<void>((resolve) => { started = resolve; });
        const transfer = runSerializedSyncDocumentWriteOperation(async () => {
            started();
            await gate;
            state._tasksById.set('task', { ...before, dueDate: '2026-10-20' });
        });
        await start;
        const pending = commitTimelineDateEdit({ kind: 'task', task: before }, { kind: 'move', days: 1 });
        expect(state.updateTask).not.toHaveBeenCalled();
        release();
        await transfer;
        expect(await pending).toEqual({ status: 'conflict' });
        expect(state.updateTask).not.toHaveBeenCalled();
    });

    it('rejects inactive or missing parents and does no writes for zero delta or an invalid resize', async () => {
        const before = task({ projectId: 'project' });
        state._tasksById.set('task', before);
        state._projectsById.set('project', project({ status: 'archived' }));
        expect(await commitTimelineDateEdit({ kind: 'task', task: before }, { kind: 'move', days: 1 })).toEqual({ status: 'conflict' });
        state._projectsById.clear();
        expect(await commitTimelineDateEdit({ kind: 'task', task: before }, { kind: 'move', days: 1 })).toEqual({ status: 'conflict' });
        state._tasksById.set('task', task());
        expect(await commitTimelineDateEdit({ kind: 'task', task: task() }, { kind: 'move', days: 0 })).toEqual({ status: 'noop' });
        expect(await commitTimelineDateEdit({ kind: 'task', task: task() }, { kind: 'start', days: 4 })).toEqual({ status: 'invalid' });
        expect(state.updateTask).not.toHaveBeenCalled();
    });

    it('throws a refused store action and does not claim a durable success', async () => {
        state.updateTask = vi.fn().mockResolvedValue({ success: false, error: 'save refused' });
        await expect(commitTimelineDateEdit({ kind: 'task', task: task() }, { kind: 'move', days: 1 })).rejects.toThrow('save refused');
        expect(mocks.flush).not.toHaveBeenCalled();
        expect(mocks.log).not.toHaveBeenCalled();
    });

    it('leaves optimistic changes intact when persistence rejects and shows no success marker', async () => {
        mocks.flush.mockRejectedValueOnce(new Error('disk full'));
        await expect(commitTimelineDateEdit({ kind: 'task', task: task() }, { kind: 'move', days: 1 })).rejects.toThrow('disk full');
        expect(state._tasksById.get('task')?.dueDate).toBe('2026-10-14');
        expect(state.updateTask).toHaveBeenCalledOnce();
        expect(mocks.log).not.toHaveBeenCalled();
    });

    it('does not acknowledge an apply superseded while persistence is pending', async () => {
        mocks.flush.mockImplementationOnce(async () => {
            state._tasksById.set('task', { ...state._tasksById.get('task')!, dueDate: '2026-10-20' });
        });
        expect(await commitTimelineDateEdit({ kind: 'task', task: task() }, { kind: 'move', days: 1 }))
            .toEqual({ status: 'conflict' });
        expect(mocks.log).not.toHaveBeenCalled();
    });

    it.each([{ dueDate: '2026-10-15' }, { pushCount: 5 }, { status: 'done' }, { deletedAt: '2026-10-12' }] as Partial<Task>[])('rejects conflicting undo without an extra write %j', async (patch) => {
            const result = saved(await commitTimelineDateEdit({ kind: 'task', task: task() }, { kind: 'move', days: 1 }));
            state._tasksById.set('task', { ...state._tasksById.get('task')!, ...patch });
            expect(await result.undo()).toBe(false);
            expect(state.updateTask).toHaveBeenCalledOnce();
        });

    it('rechecks the parent lifecycle on undo', async () => {
        const before = task({ projectId: 'project' });
        state._tasksById.set('task', before);
        const result = saved(await commitTimelineDateEdit({ kind: 'task', task: before }, { kind: 'move', days: 1 }));
        state._projectsById.set('project', project({ cancelledAt: '2026-10-11' }));
        expect(await result.undo()).toBe(false);
        expect(state.updateTask).toHaveBeenCalledOnce();
    });

    it('retries undo persistence once without replaying the mutation or losing a later note', async () => {
        const result = saved(await commitTimelineDateEdit({ kind: 'task', task: task() }, { kind: 'move', days: 1 }));
        mocks.flush.mockRejectedValueOnce(new Error('disk full'));
        await expect(result.undo()).rejects.toThrow('disk full');
        state._tasksById.set('task', { ...state._tasksById.get('task')!, description: 'New note' });
        expect(await result.undo()).toBe(true);
        expect(state.updateTask).toHaveBeenCalledTimes(2);
        expect(state.persistSnapshot).toHaveBeenCalledOnce();
        expect(state._tasksById.get('task')?.description).toBe('New note');
        expect(await result.undo()).toBe(true);
        expect(state.updateTask).toHaveBeenCalledTimes(2);
    });

    it('rejects a superseded persistence retry without saving or mutating again', async () => {
        const result = saved(await commitTimelineDateEdit({ kind: 'task', task: task() }, { kind: 'move', days: 1 }));
        mocks.flush.mockRejectedValueOnce(new Error('disk full'));
        await expect(result.undo()).rejects.toThrow('disk full');
        state._tasksById.set('task', { ...state._tasksById.get('task')!, dueDate: '2026-10-20' });
        expect(await result.undo()).toBe(false);
        expect(state.updateTask).toHaveBeenCalledTimes(2);
        expect(state.persistSnapshot).not.toHaveBeenCalled();
        expect(mocks.log).toHaveBeenCalledOnce();
    });

    it('does not acknowledge an undo superseded while persistence is pending', async () => {
        const result = saved(await commitTimelineDateEdit({ kind: 'task', task: task() }, { kind: 'move', days: 1 }));
        mocks.flush.mockImplementationOnce(async () => {
            state._tasksById.set('task', { ...state._tasksById.get('task')!, status: 'archived' });
        });
        expect(await result.undo()).toBe(false);
        expect(mocks.log).toHaveBeenCalledOnce();
    });

    it.each([false, true])('detects optimistic undo rejection (delayed=%s) and retries only persistence', async (delayed) => {
        const result = saved(await commitTimelineDateEdit({ kind: 'task', task: task() }, { kind: 'move', days: 1 }));
        state.updateTask = vi.fn(async (id: string, patch: Partial<Task>) => {
            if (delayed) await Promise.resolve();
            state._tasksById.set(id, { ...state._tasksById.get(id)!, ...patch });
            throw new Error('save rejected');
        });
        await expect(result.undo()).rejects.toThrow('save rejected');
        expect(await result.undo()).toBe(true);
        expect(state.updateTask).toHaveBeenCalledOnce();
        expect(state.persistSnapshot).toHaveBeenCalledOnce();
    });

    it('shares concurrent undo calls and suppresses duplicate mutation/logging', async () => {
        const result = saved(await commitTimelineDateEdit({ kind: 'task', task: task() }, { kind: 'move', days: 1 }));
        let release!: () => void;
        mocks.flush.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
        const first = result.undo();
        const second = result.undo();
        expect(first).toBe(second);
        await Promise.resolve();
        release();
        expect(await first).toBe(true);
        expect(state.updateTask).toHaveBeenCalledTimes(2);
        expect(mocks.log).toHaveBeenCalledTimes(2);
    });

    it('guards and saves project dates without touching child tasks, preserving project notes', async () => {
        const before = project();
        state._projectsById.set('project', { ...before, supportNotes: 'Later note' });
        const child = state._tasksById.get('task');
        const result = saved(await commitTimelineDateEdit({ kind: 'project', project: before }, { kind: 'move', days: 1 }));
        expect(state.updateProject).toHaveBeenCalledExactlyOnceWith('project', { startDate: '2026-10-11', dueDate: '2026-10-14' });
        expect(state.updateTask).not.toHaveBeenCalled();
        expect(await result.undo()).toBe(true);
        expect(state._tasksById.get('task')).toBe(child);
        expect(state._projectsById.get('project')?.supportNotes).toBe('Later note');
        state._projectsById.set('project', { ...before, dueDate: '2026-10-20' });
        expect(await commitTimelineDateEdit({ kind: 'project', project: before }, { kind: 'move', days: 1 })).toEqual({ status: 'conflict' });
    });
});

describe('timeline edits through normal store scheduling effects', () => {
    beforeEach(() => {
        core.resetForTests();
        mocks.log.mockReset().mockResolvedValue(null);
        mocks.getState.mockImplementation(core.useTaskStore.getState);
        mocks.flush.mockReset().mockImplementation(core.flushPendingSave);
        core.setStorageAdapter({ getData: async () => ({ tasks: [], projects: [], sections: [], areas: [], settings: {} }),
            saveData: async () => undefined });
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
    });
    afterEach(async () => {
        await core.flushPendingSave();
        core.resetForTests();
        vi.useRealTimers();
    });
    const load = (tasks: Task[], projects: Project[] = []) => core.useTaskStore.setState({
        tasks, projects, sections: [], areas: [], people: [], _allTasks: tasks, _allProjects: projects,
        _allSections: [], _allAreas: [], _allPeople: [], _tasksById: new Map(tasks.map((item) => [item.id, item])),
        _projectsById: new Map(projects.map((item) => [item.id, item])), settings: { deviceId: 'timeline-test' },
        error: null, persistenceFailure: null, isLoading: false,
    });

    it.each([-1, 1])('restores actual pushCount after moving due date by %s days', async (days) => {
        const before = task();
        load([before]);
        const result = saved(await commitTimelineDateEdit({ kind: 'task', task: before }, { kind: 'move', days }));
        expect(core.useTaskStore.getState()._tasksById.get('task')?.pushCount).toBe(days > 0 ? 4 : 3);
        expect(await result.undo()).toBe(true);
        expect(core.useTaskStore.getState()._tasksById.get('task')).toMatchObject({
            startTime: before.startTime, dueDate: before.dueDate, pushCount: 3,
        });
    });

    it.each(['move', 'start', 'due'] as const)('undo restores relative dates and offset through the normal resolver after %s', async (kind) => {
        const before = task({ startTime: '2026-10-11', relativeStartOffset: { amount: -2, unit: 'day' },
            recurrence: { rule: 'weekly', strategy: 'strict' } });
        load([before]);
        const result = saved(await commitTimelineDateEdit({ kind: 'task', task: before }, { kind, days: 1 }));
        expect(core.useTaskStore.getState()._tasksById.get('task')?.recurrence).toEqual(before.recurrence);
        expect(core.useTaskStore.getState()._tasksById.get('task')?.relativeStartOffset)
            .toEqual(kind === 'start' ? undefined : before.relativeStartOffset);
        expect(await result.undo()).toBe(true);
        expect(core.useTaskStore.getState()._tasksById.get('task')).toMatchObject({
            startTime: before.startTime, dueDate: before.dueDate, relativeStartOffset: before.relativeStartOffset,
            pushCount: before.pushCount, recurrence: before.recurrence,
        });
        expect(core.useTaskStore.getState()._allTasks).toHaveLength(1);
        expect(core.useTaskStore.getState()._tasksById.get('task')?.recurrence).toEqual(before.recurrence);
    });

    it('keeps normal inbox promotion and focus normalization when dates are undone', async () => {
        const before = task({ status: 'inbox', isFocusedToday: true, focusOrder: 2 });
        load([before]);
        const result = saved(await commitTimelineDateEdit({ kind: 'task', task: before }, { kind: 'move', days: 1 }));
        expect(core.useTaskStore.getState()._tasksById.get('task')?.status).toBe('next');
        expect(core.useTaskStore.getState()._tasksById.get('task')?.focusOrder).toBeUndefined();
        expect(await result.undo()).toBe(true);
        expect(core.useTaskStore.getState()._tasksById.get('task')).toMatchObject({
            status: 'next', startTime: before.startTime, dueDate: before.dueDate, isFocusedToday: true,
        });
        expect(core.useTaskStore.getState()._tasksById.get('task')?.focusOrder).toBeUndefined();
    });
});
