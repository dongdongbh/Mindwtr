import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetForTests, setStorageAdapter, useTaskStore, type AppData, type Task } from '@mindwtr/core';
import type { IosWidgetPendingCompletion } from '../modules/ios-widget';
import { buildWidgetCompletionToken } from './widget-completion-token';

const mocks = vi.hoisted(() => ({
    platform: { OS: 'ios' },
    sandbox: false,
    claim: vi.fn<() => Promise<IosWidgetPendingCompletion[]>>(),
    ack: vi.fn(async (_id: string) => undefined),
    logInfo: vi.fn(),
}));
vi.mock('react-native', () => ({ Platform: mocks.platform }));
vi.mock('@mindwtr/core', async (importOriginal) => ({
    ...await importOriginal<typeof import('@mindwtr/core')>(),
    isSandboxMode: () => mocks.sandbox,
}));
vi.mock('../modules/ios-widget', () => ({
    claimPendingCompletions: mocks.claim,
    acknowledgePendingCompletion: mocks.ack,
}));
vi.mock('./file-system', () => ({
    documentDirectory: null, getInfoAsync: vi.fn(), readDirectoryAsync: vi.fn(),
    readAsStringAsync: vi.fn(), deleteAsync: vi.fn(),
}));
vi.mock('./app-log', () => ({ logInfo: mocks.logInfo, logError: vi.fn(), logWarn: vi.fn() }));

// eslint-disable-next-line import/first
import { flushPendingTaskActionSave } from './pending-capture-persistence';
import { ingestIosWidgetCompletions } from './ios-widget-completions';

const task = (props: Partial<Task> = {}): Task => ({
    id: 'task-1', title: 'Private task text', status: 'next',
    tags: [], contexts: [], createdAt: '2026-09-11T12:00:00Z', updatedAt: '2026-09-11T12:00:00Z',
    ...props,
});
const action = (current = task()): IosWidgetPendingCompletion => ({
    id: 'action-1', taskId: current.id, token: buildWidgetCompletionToken(current),
    createdAt: 1, notBefore: 3001, claimed: true,
});
const depsFor = (tasks: Task[]) => ({
    tasks,
    getTasks: () => tasks,
    updateTask: vi.fn(async (id: string, updates: Partial<Task>) => {
        Object.assign(tasks.find((item) => item.id === id)!, updates);
    }),
    flushPendingSave: vi.fn(async () => undefined),
    refreshWidgets: vi.fn(async () => true),
});

describe('iOS widget completion ingestion', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.platform.OS = 'ios';
        mocks.sandbox = false;
        mocks.claim.mockResolvedValue([action()]);
        mocks.ack.mockResolvedValue(undefined);
    });

    it('completes through the normal store, flushes and publishes before acknowledging', async () => {
        const deps = depsFor([task()]);
        expect(await ingestIosWidgetCompletions(deps)).toBe(1);
        expect(deps.updateTask).toHaveBeenCalledWith('task-1', { status: 'done' });
        expect(deps.updateTask.mock.invocationCallOrder[0]).toBeLessThan(deps.flushPendingSave.mock.invocationCallOrder[0]);
        expect(deps.flushPendingSave.mock.invocationCallOrder[0]).toBeLessThan(deps.refreshWidgets.mock.invocationCallOrder[0]);
        expect(deps.refreshWidgets.mock.invocationCallOrder[0]).toBeLessThan(mocks.ack.mock.invocationCallOrder[0]);
        expect(mocks.ack).toHaveBeenCalledWith('action-1');
        expect(mocks.logInfo).toHaveBeenCalledWith('iOS widget completion ingested', {
            scope: 'widget', extra: { releaseCheck: 'v1.3.0/ios-widget-checkoff', outcome: 'completed' },
        });
        expect(JSON.stringify(mocks.logInfo.mock.calls)).not.toContain('Private task text');
    });

    it.each([
        ['already-done', { status: 'done' }],
        ['terminal', { status: 'archived', recurrence: { rule: 'daily' } }],
        ['missing', { deletedAt: '2026-09-11T12:01:00Z' }],
        ['missing', { purgedAt: '2026-09-11T12:01:00Z' }],
        ['stale', { rev: 2 }],
        ['stale', { updatedAt: '2026-09-11T12:01:00Z' }],
    ] as const)('acknowledges %s without changing the task', async (outcome, props) => {
        const deps = depsFor([task(props)]);
        expect(await ingestIosWidgetCompletions(deps)).toBe(1);
        expect(deps.updateTask).not.toHaveBeenCalled();
        expect(mocks.logInfo).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
            extra: { releaseCheck: 'v1.3.0/ios-widget-checkoff', outcome },
        }));
    });

    it('reads fresh all-task state and consumes missing tasks safely', async () => {
        const deps = depsFor([task()]);
        deps.getTasks = () => [];
        expect(await ingestIosWidgetCompletions(deps)).toBe(1);
        expect(deps.updateTask).not.toHaveBeenCalled();
    });

    it('retains claimed work after a failed flush, retries the save without a second completion', async () => {
        const deps = depsFor([task({ recurrence: { rule: 'daily' } })]);
        deps.flushPendingSave.mockRejectedValueOnce(new Error('disk unavailable'));
        expect(await ingestIosWidgetCompletions(deps)).toBe(0);
        expect(mocks.ack).not.toHaveBeenCalled();
        expect(deps.refreshWidgets).not.toHaveBeenCalled();
        expect(await ingestIosWidgetCompletions(deps)).toBe(1);
        expect(deps.updateTask).toHaveBeenCalledOnce();
        expect(deps.flushPendingSave).toHaveBeenCalledTimes(2);
    });

    it('retains claimed work when the store rejects or fresh widget publication fails', async () => {
        const deps = depsFor([task()]);
        deps.updateTask = vi.fn(async () => { throw new Error('store unavailable'); });
        expect(await ingestIosWidgetCompletions(deps)).toBe(0);
        expect(mocks.ack).not.toHaveBeenCalled();
        const retry = depsFor([task()]);
        retry.refreshWidgets.mockResolvedValue(false);
        expect(await ingestIosWidgetCompletions(retry)).toBe(0);
        expect(mocks.ack).not.toHaveBeenCalled();
    });

    it('replays an acknowledgement failure without applying completion twice', async () => {
        const deps = depsFor([task()]);
        mocks.ack.mockRejectedValueOnce(new Error('outbox unavailable'));
        expect(await ingestIosWidgetCompletions(deps)).toBe(0);
        expect(await ingestIosWidgetCompletions(deps)).toBe(1);
        expect(deps.updateTask).toHaveBeenCalledOnce();
    });

    it('does not touch the personal outbox on other platforms or in sandbox mode', async () => {
        const deps = depsFor([task()]);
        mocks.platform.OS = 'android';
        expect(await ingestIosWidgetCompletions(deps)).toBe(0);
        mocks.platform.OS = 'ios';
        mocks.sandbox = true;
        expect(await ingestIosWidgetCompletions(deps)).toBe(0);
        expect(mocks.claim).not.toHaveBeenCalled();
    });

    it('defers the durable save callback in sandbox mode', async () => {
        mocks.sandbox = true;
        await expect(flushPendingTaskActionSave()).rejects.toThrow('deferred in sandbox');
    });

    it('propagates a native claim failure for lifecycle retry without acknowledging anything', async () => {
        mocks.claim.mockRejectedValueOnce(new Error('corrupt queue'));
        await expect(ingestIosWidgetCompletions(depsFor([task()]))).rejects.toThrow('corrupt queue');
        expect(mocks.ack).not.toHaveBeenCalled();
    });

    it('retains claimed personal work if sandbox mode starts while awaiting native claim', async () => {
        mocks.claim.mockImplementationOnce(async () => {
            mocks.sandbox = true;
            return [action()];
        });
        const deps = depsFor([task()]);
        expect(await ingestIosWidgetCompletions(deps)).toBe(0);
        expect(deps.updateTask).not.toHaveBeenCalled();
        expect(mocks.ack).not.toHaveBeenCalled();
    });

    it('retains the action when sandbox starts during publication', async () => {
        const deps = depsFor([task()]);
        deps.refreshWidgets.mockImplementationOnce(async () => {
            mocks.sandbox = true;
            return true;
        });
        expect(await ingestIosWidgetCompletions(deps)).toBe(0);
        expect(mocks.ack).not.toHaveBeenCalled();
    });

    it('retries a real storage failure without generating a second recurring occurrence', async () => {
        vi.useFakeTimers();
        const recurring = task({ recurrence: { rule: 'daily' }, dueDate: '2026-09-11' });
        mocks.claim.mockResolvedValue([action(recurring)]);
        let persisted: AppData = {
            tasks: [recurring], projects: [], sections: [], areas: [], people: [],
            settings: { deviceId: 'widget-test' },
        };
        let failSaves = true;
        setStorageAdapter({
            getData: async () => structuredClone(persisted),
            saveData: async (data) => {
                if (failSaves) throw new Error('disk unavailable');
                persisted = structuredClone(data);
            },
        });
        useTaskStore.setState({
            settings: persisted.settings, persistenceFailure: null,
            _allTasks: [recurring], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        });
        const updateTask = vi.fn(useTaskStore.getState().updateTask);
        const deps = {
            tasks: [], getTasks: () => useTaskStore.getState()._allTasks,
            updateTask, flushPendingSave: flushPendingTaskActionSave, refreshWidgets: vi.fn(async () => true),
        };
        try {
            const first = ingestIosWidgetCompletions(deps);
            await vi.advanceTimersByTimeAsync(10_000);
            expect(await first).toBe(0);
            expect(mocks.ack).not.toHaveBeenCalled();
            expect(useTaskStore.getState().persistenceFailure).not.toBeNull();
            const optimistic = structuredClone(useTaskStore.getState()._allTasks);
            expect(optimistic.find(({ id }) => id === recurring.id)?.status).toBe('done');
            expect(optimistic.filter(({ status }) => status === 'next')).toHaveLength(1);
            failSaves = false;
            const retry = ingestIosWidgetCompletions(deps);
            await vi.runAllTimersAsync();
            expect(await retry).toBe(1);
            expect(updateTask).toHaveBeenCalledOnce();
            expect(persisted.tasks).toEqual(optimistic);
            expect(mocks.ack).toHaveBeenCalledOnce();
        } finally {
            resetForTests();
            vi.useRealTimers();
        }
    });
});
