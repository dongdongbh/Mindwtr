import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    state: {
        tasks: [{ id: 'task-a', status: 'next', deletedAt: undefined as string | undefined }],
        updateTask: vi.fn(async () => ({ success: true })),
        persistSnapshot: vi.fn(async () => undefined),
    },
    trackSave: vi.fn(async (operation: () => Promise<unknown>) => ({ result: await operation(), saveCount: 1 })),
    flushSave: vi.fn<() => Promise<void>>(async () => undefined),
    cancel: vi.fn(async () => undefined),
    register: vi.fn(),
    logInfo: vi.fn(async () => undefined),
    logWarn: vi.fn(async () => undefined),
}));

vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, AppState: { addEventListener: vi.fn() } }));
vi.mock('@mindwtr/core', () => ({
    useTaskStore: { getState: () => mocks.state },
    runWithImmediateSaveTracking: mocks.trackSave,
    flushPendingSave: mocks.flushSave,
}));
vi.mock('@/lib/app-log', () => ({ logInfo: mocks.logInfo, logWarn: mocks.logWarn }));
vi.mock('@/lib/notification-service', () => ({ setNotificationOpenHandler: mocks.register }));
vi.mock('@/modules/notification-open-intents', () => ({
    cancelTaskReminderNotifications: mocks.cancel,
    consumePendingNotificationOpenPayload: vi.fn(async () => null),
    peekPendingNotificationCompletions: vi.fn(async () => []),
    acknowledgeNotificationCompletion: vi.fn(),
}));

import { useRootLayoutNotificationOpenHandler } from './use-root-layout-notification-open-handler';

const router = { push: vi.fn() };
function Harness() {
    useRootLayoutNotificationOpenHandler({ appReady: true, pathname: '/focus', router });
    return null;
}

describe('iOS notification Done save ordering', () => {
    let tree: renderer.ReactTestRenderer;
    let complete: () => void;
    beforeEach(async () => {
        vi.clearAllMocks();
        mocks.state.tasks[0].status = 'next';
        mocks.state.tasks[0].deletedAt = undefined;
        await act(async () => { tree = renderer.create(<Harness />); });
        const handler = mocks.register.mock.calls[0][0];
        complete = () => handler({ notificationId: 'alarm-a', actionIdentifier: 'complete', taskId: 'task-a' });
    });
    afterEach(() => act(() => tree.unmount()));

    it('waits for durable save before cancelling siblings and logging acceptance', async () => {
        let finishSave!: () => void;
        mocks.flushSave.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSave = resolve; }));
        await act(async () => { complete(); });
        expect(mocks.trackSave).toHaveBeenCalledOnce();
        expect(mocks.state.updateTask).toHaveBeenCalledWith('task-a', { status: 'done', isFocusedToday: false });
        expect(mocks.cancel).not.toHaveBeenCalled();
        await act(async () => { finishSave(); });
        expect(mocks.cancel).toHaveBeenCalledWith('task-a');
        expect(mocks.logInfo).toHaveBeenCalledWith('[Local Notifications] Done action saved and task reminders cancelled', {
            scope: 'notifications', extra: { releaseCheck: 'v1.3.5/ios-reminder-completion', outcome: 'saved-and-cancelled' },
        });
        await act(async () => { complete(); });
        expect(mocks.cancel).toHaveBeenCalledOnce();
    });

    it.each(['tracked', 'flush'] as const)('does not cancel siblings when the %s save fails', async (stage) => {
        (stage === 'tracked' ? mocks.trackSave : mocks.flushSave).mockRejectedValueOnce(new Error('disk unavailable'));
        await act(async () => { complete(); });
        expect(mocks.cancel).not.toHaveBeenCalled();
        expect(mocks.logInfo).not.toHaveBeenCalled();
        expect(mocks.logWarn).toHaveBeenCalledWith(expect.any(String), {
            scope: 'notifications', extra: { releaseCheck: 'v1.3.5/ios-reminder-completion', outcome: 'failed' },
        });
    });

    it('does not cancel siblings when the completion update is refused', async () => {
        mocks.state.updateTask.mockResolvedValueOnce({ success: false });
        await act(async () => { complete(); });
        expect(mocks.flushSave).not.toHaveBeenCalled();
        expect(mocks.cancel).not.toHaveBeenCalled();
    });

    it('does not resave or cancel for a deleted completed task', async () => {
        mocks.state.tasks[0].status = 'done';
        mocks.state.tasks[0].deletedAt = '2026-10-06T00:00:00Z';
        await act(async () => { complete(); });
        expect(mocks.state.persistSnapshot).not.toHaveBeenCalled();
        expect(mocks.cancel).not.toHaveBeenCalled();
    });

    it('resaves already completed memory on retry without repeating recurrence completion', async () => {
        mocks.state.updateTask.mockImplementationOnce(async () => {
            mocks.state.tasks[0].status = 'done';
            return { success: true };
        });
        mocks.flushSave.mockRejectedValueOnce(new Error('disk unavailable'));
        await act(async () => { complete(); });
        expect(mocks.cancel).not.toHaveBeenCalled();
        await act(async () => { complete(); });
        expect(mocks.state.updateTask).toHaveBeenCalledOnce();
        expect(mocks.state.persistSnapshot).toHaveBeenCalledOnce();
        expect(mocks.cancel).toHaveBeenCalledOnce();
    });

    it('does not claim cancellation acceptance when the native promise rejects', async () => {
        mocks.cancel.mockRejectedValueOnce(new Error('native unavailable'));
        await act(async () => { complete(); });
        expect(mocks.cancel).toHaveBeenCalledOnce();
        expect(mocks.logInfo).not.toHaveBeenCalled();
        expect(mocks.logWarn).toHaveBeenCalledOnce();
    });
});
