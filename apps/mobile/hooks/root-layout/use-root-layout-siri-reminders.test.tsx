import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, Task } from '@mindwtr/core';

import { useRootLayoutSiriReminders } from './use-root-layout-siri-reminders';
import type { MindwtrSiriActionRequest } from '../../modules/ios-siri-actions';

const mocks = vi.hoisted(() => {
    type State = { settings: AppSettings; _allTasks: Task[] };
    return {
        appState: 'active',
        appListeners: new Set<(state: string) => void>(),
        state: { settings: {}, _allTasks: [] } as State,
        storeListeners: new Set<(next: State, previous: State) => void>(),
        workspaceListeners: new Set<() => void>(),
        switching: false,
        pendingListeners: new Set<() => void>(),
        available: true,
        storage: { getData: vi.fn() },
        flush: vi.fn(),
        apply: vi.fn(),
        claim: vi.fn(),
        publish: vi.fn(),
        clear: vi.fn(),
        access: vi.fn(),
        acknowledge: vi.fn(),
        logInfo: vi.fn(),
        logWarn: vi.fn(),
    };
});
vi.mock('react-native', () => ({
    AppState: {
        get currentState() { return mocks.appState; },
        addEventListener: (_event: string, listener: (state: string) => void) => {
            mocks.appListeners.add(listener);
            return { remove: () => mocks.appListeners.delete(listener) };
        },
    },
}));
vi.mock('@mindwtr/core', async (importOriginal) => ({
    ...await importOriginal<typeof import('@mindwtr/core')>(),
    flushPendingSave: mocks.flush,
    applySiriReminderAction: mocks.apply,
    getStorageAdapter: () => mocks.storage,
    isWorkspaceTransitionActive: () => mocks.switching,
    useTaskStore: {
        getState: () => mocks.state,
        subscribe: (listener: Parameters<typeof mocks.storeListeners.add>[0]) => {
            mocks.storeListeners.add(listener);
            return () => mocks.storeListeners.delete(listener);
        },
    },
}));
vi.mock('@/lib/storage-adapter', () => ({ mobileStorage: mocks.storage }));
vi.mock('@/lib/app-log', () => ({ logInfo: mocks.logInfo, logWarn: mocks.logWarn }));
vi.mock('@/lib/sandbox-workspace', () => ({
    getWorkspaceSwitching: () => mocks.switching,
    subscribeWorkspaceSwitching: (listener: () => void) => {
        mocks.workspaceListeners.add(listener);
        return () => mocks.workspaceListeners.delete(listener);
    },
}));
vi.mock('../../modules/ios-siri-actions', () => ({
    isAvailable: () => mocks.available,
    clearSnapshot: mocks.clear,
    publishSnapshot: mocks.publish,
    setAccessAllowed: mocks.access,
    claimPending: mocks.claim,
    acknowledge: mocks.acknowledge,
    subscribePendingActionsChanged: (listener: () => void) => {
        mocks.pendingListeners.add(listener);
        return { remove: () => mocks.pendingListeners.delete(listener) };
    },
}));

const request: MindwtrSiriActionRequest = {
    version: 1,
    id: '00000000-0000-4000-8000-000000000001',
    operation: 'create',
    replayOnly: false,
    createdAt: 1_000,
    expiresAt: 121_000,
    fields: { title: 'Pay bill', dueDate: '2026-11-30' },
    clearFields: [],
};
const task = { id: request.id, title: 'Pay bill', token: 'receipt-token', dueDate: '2026-11-30' };

function Harness({ ready = true, disabled = false }: { ready?: boolean; disabled?: boolean }) {
    useRootLayoutSiriReminders({ canonicalDataReady: ready, disabled });
    return null;
}

function setAppLock(enabled: boolean) {
    const previous = mocks.state;
    mocks.state = { ...previous, settings: { security: { mobileAppLockEnabled: enabled } } };
    mocks.storeListeners.forEach((listener) => listener(mocks.state, previous));
}

function setTasks(tasks: Task[]) {
    const previous = mocks.state;
    mocks.state = { ...previous, _allTasks: tasks };
    mocks.storeListeners.forEach((listener) => listener(mocks.state, previous));
}

function setAppState(state: string) {
    mocks.appState = state;
    mocks.appListeners.forEach((listener) => listener(state));
}

let tree: ReactTestRenderer | undefined;
beforeEach(() => {
    vi.resetAllMocks();
    mocks.available = true;
    mocks.appState = 'active';
    mocks.switching = false;
    mocks.state = { settings: {}, _allTasks: [] };
    mocks.storage.getData.mockResolvedValue({ tasks: [], projects: [] });
    mocks.flush.mockResolvedValue(undefined);
    mocks.apply.mockResolvedValue({ outcome: 'persisted', task });
    mocks.claim.mockResolvedValue([]);
    mocks.publish.mockResolvedValue(undefined);
    mocks.clear.mockResolvedValue(undefined);
    mocks.access.mockResolvedValue(undefined);
    mocks.acknowledge.mockResolvedValue(undefined);
    mocks.logInfo.mockResolvedValue(undefined);
    mocks.logWarn.mockResolvedValue(undefined);
});

afterEach(async () => {
    await act(async () => { tree?.unmount(); });
    tree = undefined;
    vi.useRealTimers();
});

describe('React Native Siri Reminder lifecycle', () => {
    it('waits for foreground canonical data and revokes immediately when App Lock is configured', async () => {
        mocks.appState = 'background';
        await act(async () => { tree = create(<Harness ready={false} />); });
        await act(async () => { setAppState('active'); });
        expect(mocks.publish).not.toHaveBeenCalled();
        expect(mocks.claim).not.toHaveBeenCalled();

        await act(async () => {
            setAppLock(true);
            tree?.update(<Harness />);
        });
        expect(mocks.access).not.toHaveBeenCalledWith(true);
        expect(mocks.claim).not.toHaveBeenCalled();

        await act(async () => { setAppLock(false); });
        expect(mocks.storage.getData).toHaveBeenCalledWith({ requireCanonical: true, rawTasks: true });
        expect(mocks.publish).toHaveBeenCalledOnce();
        expect(mocks.claim).toHaveBeenCalledOnce();
        const grant = mocks.access.mock.calls.findIndex(([allowed]) => allowed === true);
        expect(grant).toBeGreaterThanOrEqual(0);
        expect(mocks.publish.mock.invocationCallOrder[0]).toBeLessThan(mocks.access.mock.invocationCallOrder[grant]);
        expect(mocks.access.mock.invocationCallOrder[grant]).toBeLessThan(mocks.claim.mock.invocationCallOrder[0]);

        await act(async () => { setAppLock(true); });
        expect(mocks.access).toHaveBeenLastCalledWith(false);
        expect(mocks.clear).toHaveBeenCalled();
        await act(async () => { mocks.pendingListeners.forEach((listener) => listener()); });
        expect(mocks.claim).toHaveBeenCalledOnce();
    });

    it('replays the same durable create after an acknowledgement failure', async () => {
        vi.useFakeTimers();
        const stored: Task = {
            id: task.id, title: task.title, status: 'inbox', dueDate: task.dueDate, tags: [], contexts: [],
            createdAt: '2026-11-19T12:00:00.000Z', updatedAt: '2026-11-19T12:00:00.000Z',
        };
        mocks.storage.getData.mockResolvedValueOnce({ tasks: [], projects: [] });
        mocks.storage.getData.mockResolvedValue({ tasks: [stored], projects: [] });
        mocks.claim.mockResolvedValue([request]);
        mocks.acknowledge.mockRejectedValueOnce(new Error('receipt bridge interrupted'));
        await act(async () => { tree = create(<Harness />); });
        expect(mocks.apply).toHaveBeenCalledOnce();
        expect(mocks.logInfo).not.toHaveBeenCalled();

        await act(async () => { await vi.advanceTimersByTimeAsync(500); });
        expect(mocks.apply.mock.calls).toHaveLength(2);
        expect(mocks.apply.mock.calls[0][0]).toEqual({
            id: request.id, operation: 'create', title: 'Pay bill', dueDate: '2026-11-30',
            createdAt: request.createdAt, expiresAt: request.expiresAt,
        });
        expect(mocks.apply.mock.calls[0][2]).toEqual([request.id]);
        expect(mocks.apply.mock.calls[0][3]).toEqual({ replayOnly: false });
        expect(mocks.apply.mock.calls[1][0]).toEqual(mocks.apply.mock.calls[0][0]);
        expect(mocks.acknowledge).toHaveBeenLastCalledWith(request.id, JSON.stringify({
            outcome: 'persisted', task: JSON.stringify(task),
        }));
        expect(JSON.parse(mocks.publish.mock.calls[1][0]).items).toEqual([
            expect.objectContaining({ id: task.id, title: task.title, dueDate: task.dueDate }),
        ]);
        expect(mocks.publish.mock.invocationCallOrder[1]).toBeLessThan(mocks.acknowledge.mock.invocationCallOrder[0]);
        expect(mocks.logInfo).toHaveBeenCalledOnce();
    });

    it('skips SQLite and transport work for a Done edit and renews the current projection before expiry', async () => {
        vi.useFakeTimers();
        const inbox: Task = {
            id: request.id, title: 'Pay bill', status: 'inbox', tags: [], contexts: [],
            createdAt: '2026-11-19T12:00:00.000Z', updatedAt: '2026-11-19T12:00:00.000Z',
        };
        const done: Task = { ...inbox, title: 'Previous bill', id: '00000000-0000-4000-8000-000000000004', status: 'done' };
        setTasks([inbox, done]);
        mocks.storage.getData.mockImplementation(async () => ({ tasks: mocks.state._allTasks }));
        await act(async () => { tree = create(<Harness />); });
        expect(mocks.storage.getData).toHaveBeenCalledOnce();
        expect(mocks.publish).toHaveBeenCalledOnce();

        await act(async () => {
            setTasks([inbox, { ...done, title: 'Renamed previous bill' }]);
            await vi.advanceTimersByTimeAsync(250);
        });
        expect(mocks.flush).toHaveBeenCalledOnce();
        expect(mocks.storage.getData).toHaveBeenCalledOnce();
        expect(mocks.publish).toHaveBeenCalledOnce();
        expect(mocks.claim).toHaveBeenCalledOnce();

        await act(async () => {
            setTasks([{ ...inbox, title: 'Pay invoice' }, done]);
            await vi.advanceTimersByTimeAsync(250);
        });
        expect(mocks.storage.getData).toHaveBeenCalledTimes(2);
        expect(JSON.parse(mocks.publish.mock.calls[1][0]).items).toEqual([
            expect.objectContaining({ id: inbox.id, title: 'Pay invoice' }),
        ]);
        expect(mocks.claim).toHaveBeenCalledOnce();

        await act(async () => { await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000); });
        expect(mocks.publish).toHaveBeenCalledTimes(3);
        expect(JSON.parse(mocks.publish.mock.calls[2][0]).generatedAt)
            .not.toBe(JSON.parse(mocks.publish.mock.calls[1][0]).generatedAt);
    });

    it('refreshes an optimistic Inbox edit arriving just after the save flush', async () => {
        vi.useFakeTimers();
        const original: Task = {
            id: request.id, title: 'Pay bill', status: 'inbox', tags: [], contexts: [],
            createdAt: '2026-11-19T12:00:00.000Z', updatedAt: '2026-11-19T12:00:00.000Z',
        };
        const edited = { ...original, title: 'Pay invoice' };
        setTasks([original]);
        mocks.flush.mockImplementationOnce(() => {
            const flushed = Promise.resolve();
            void flushed.then(() => setTasks([edited]));
            return flushed;
        });
        mocks.storage.getData.mockResolvedValueOnce({ tasks: [original] })
            .mockResolvedValue({ tasks: [edited] });

        await act(async () => { tree = create(<Harness />); });
        const snapshotTitle = (index: number) => JSON.parse(mocks.publish.mock.calls[index][0]).items[0].title;
        expect(snapshotTitle(0)).toBe(original.title);
        await act(async () => { await vi.advanceTimersByTimeAsync(250); });
        expect(mocks.publish).toHaveBeenCalledTimes(2);
        expect(snapshotTitle(1)).toBe(edited.title);
    });

    it('sends a clear to core and rejects deletion at the transport boundary', async () => {
        const deletion = { ...request, operation: 'delete', id: '00000000-0000-4000-8000-000000000003' };
        const clear: MindwtrSiriActionRequest = {
            ...request,
            operation: 'update',
            targetId: '00000000-0000-4000-8000-000000000002',
            expectedToken: 'current-token',
            fields: {},
            clearFields: ['dueDate'],
        };
        mocks.claim.mockResolvedValue([deletion, clear]);
        mocks.apply.mockResolvedValue({ outcome: 'rejected', reason: 'stale' });
        await act(async () => { tree = create(<Harness />); });
        expect(mocks.apply).toHaveBeenCalledOnce();
        expect(mocks.apply).toHaveBeenCalledWith(
            { id: request.id, createdAt: request.createdAt, expiresAt: request.expiresAt,
                operation: 'update', targetId: clear.targetId, expectedToken: clear.expectedToken, dueDate: null },
            expect.any(Function),
            [deletion.id, clear.id],
            { replayOnly: false },
        );
        expect(mocks.acknowledge).toHaveBeenNthCalledWith(1, deletion.id, '{"outcome":"rejected","reason":"unsupported"}');
        expect(mocks.acknowledge).toHaveBeenNthCalledWith(2, clear.id, '{"outcome":"rejected","reason":"stale"}');
    });

    it('passes a claim from a previous foreground session to core for receipt replay only', async () => {
        mocks.claim.mockResolvedValue([{ ...request, replayOnly: true }]);
        mocks.apply.mockResolvedValue({ outcome: 'rejected', reason: 'cancelled' });
        await act(async () => { tree = create(<Harness />); });
        expect(mocks.apply.mock.calls[0][3]).toEqual({ replayOnly: true });
        expect(mocks.acknowledge).toHaveBeenCalledExactlyOnceWith(request.id, '{"outcome":"rejected","reason":"cancelled"}');
    });

    it.each(['inactive', 'workspace'] as const)('retains a claim if access is lost during %s', async (reason) => {
        let finishClaim!: (requests: MindwtrSiriActionRequest[]) => void;
        mocks.claim.mockReturnValueOnce(new Promise<MindwtrSiriActionRequest[]>((resolve) => { finishClaim = resolve; }));
        await act(async () => { tree = create(<Harness />); });
        expect(mocks.claim).toHaveBeenCalledOnce();

        await act(async () => {
            if (reason === 'inactive') setAppState('inactive');
            else {
                mocks.switching = true;
                mocks.workspaceListeners.forEach((listener) => listener());
            }
            finishClaim([request]);
        });
        expect(mocks.apply).not.toHaveBeenCalled();
        expect(mocks.acknowledge).not.toHaveBeenCalled();
        expect(mocks.access).toHaveBeenLastCalledWith(false);
    });

    it('does no work when the schema is unavailable or when the sandbox is open', async () => {
        mocks.available = false;
        await act(async () => { tree = create(<Harness />); });
        expect(mocks.access).not.toHaveBeenCalled();
        expect(mocks.appListeners.size).toBe(0);
        mocks.available = true;
        await act(async () => { tree?.update(<Harness disabled />); });
        expect(mocks.access).not.toHaveBeenCalledWith(true);
        expect(mocks.storage.getData).not.toHaveBeenCalled();
        expect(mocks.claim).not.toHaveBeenCalled();
    });
});
