import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRootLayoutNotificationOpenHandler } from '@/hooks/root-layout/use-root-layout-notification-open-handler';

const h = vi.hoisted(() => ({
    receipts: [] as { actionId: string; taskId: string }[], tasks: new Map<string, any>(),
    handler: null as any, foreground: null as any, flush: vi.fn(), snapshot: vi.fn(), update: vi.fn(), ack: vi.fn(), log: vi.fn(),
}));
vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    AppState: { addEventListener: (_event: string, callback: any) => { h.foreground = callback; return { remove: () => {} }; } },
}));
vi.mock('@mindwtr/core', async (importOriginal) => {
    const { mockCore } = await import('../test-support/mock-core');
    return mockCore(importOriginal, () => ({
        _tasksById: h.tasks, tasks: [...h.tasks.values()], updateTask: h.update, persistSnapshot: h.snapshot,
    }), { flushPendingSave: h.flush });
});
vi.mock('@/lib/notification-service', () => ({ setNotificationOpenHandler: (handler: any) => { h.handler = handler; } }));
vi.mock('@/modules/notification-open-intents', () => ({
    consumePendingNotificationOpenPayload: async () => null,
    peekPendingNotificationCompletions: async () => [...h.receipts],
    acknowledgeNotificationCompletion: h.ack,
}));
vi.mock('@/lib/app-log', () => ({ logInfo: h.log, logWarn: h.log }));

const router = { push: vi.fn() };
function Harness({ ready = true }: { ready?: boolean }) {
    useRootLayoutNotificationOpenHandler({ appReady: ready, pathname: '/inbox', router });
    return null;
}
const receipt = (id: string) => {
    h.receipts.push({ actionId: `done:${id}`, taskId: id });
    h.tasks.set(id, { id, status: 'next', recurrence: { rule: 'daily' } });
};
const mount = async (ready = true) => {
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(<Harness ready={ready} />); });
    return tree;
};

describe('Android durable Done replay', () => {
    beforeEach(() => {
        h.receipts = []; h.tasks.clear(); h.log.mockReset();
        h.flush.mockReset().mockResolvedValue(undefined);
        h.snapshot.mockReset().mockResolvedValue(undefined);
        h.update.mockReset().mockImplementation(async (id: string) => { h.tasks.get(id).status = 'done'; return { success: true }; });
        h.ack.mockReset().mockImplementation(async (actionId: string) => { h.receipts = h.receipts.filter((item) => item.actionId !== actionId); });
    });
    it('keeps cold receipts through read, slow save and hook recreation; duplicate warm events serialize', async () => {
        receipt('a');
        let finish!: () => void;
        h.flush.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
        const first = await mount(false);
        expect(h.update).not.toHaveBeenCalled();
        await act(async () => { first.update(<Harness />); });
        expect(h.update).toHaveBeenCalledTimes(1);
        expect(h.ack).not.toHaveBeenCalled();
        expect(h.receipts).toHaveLength(1);
        act(() => first.unmount());
        const second = await mount();
        await act(async () => {
            h.handler({ actionIdentifier: 'complete', taskId: 'a' });
            h.handler({ actionIdentifier: 'complete', taskId: 'a' });
            finish();
        });
        expect(h.update).toHaveBeenCalledTimes(1);
        expect(h.ack).toHaveBeenCalledTimes(1);
        expect(h.receipts).toEqual([]);
        act(() => second.unmount());
    });
    it('retains failed saves and retries the optimistic done snapshot on foreground without recurring twice', async () => {
        receipt('a'); h.flush.mockRejectedValueOnce(new Error('disk failed'));
        const tree = await mount();
        expect(h.receipts).toHaveLength(1);
        expect(h.ack).not.toHaveBeenCalled();
        expect(h.log).toHaveBeenCalledWith(expect.stringContaining('retained'), expect.anything());
        await act(async () => { h.foreground('active'); });
        expect(h.snapshot).toHaveBeenCalledTimes(1);
        expect(h.update).toHaveBeenCalledTimes(1);
        expect(h.receipts).toEqual([]);
        act(() => tree.unmount());
    });
    it('replays more than 50 cold actions and acknowledges terminal missing, deleted and done tasks', async () => {
        for (let index = 0; index < 61; index++) receipt(String(index));
        h.tasks.delete('0'); h.tasks.get('1').deletedAt = '2026-10-06T00:00:00Z'; h.tasks.get('2').status = 'done';
        const tree = await mount();
        expect(h.update).toHaveBeenCalledTimes(58);
        expect(h.snapshot).toHaveBeenCalledTimes(3);
        expect(h.ack).toHaveBeenCalledTimes(61);
        expect(h.receipts).toEqual([]);
        receipt('warm');
        await act(async () => { h.handler({ actionIdentifier: 'complete', taskId: 'warm' }); });
        expect(h.ack).toHaveBeenLastCalledWith('done:warm');
        expect(router.push).not.toHaveBeenCalled();
        act(() => tree.unmount());
    });
    it('retains rejected store updates and failed acknowledgements until foreground', async () => {
        receipt('a'); h.update.mockResolvedValueOnce({ success: false, error: 'invalid' });
        const tree = await mount();
        expect(h.flush).not.toHaveBeenCalled(); expect(h.ack).not.toHaveBeenCalled();
        h.ack.mockRejectedValueOnce(new Error('native commit failed'));
        await act(async () => { h.foreground('active'); });
        expect(h.receipts).toHaveLength(1);
        await act(async () => { h.foreground('active'); });
        expect(h.update).toHaveBeenCalledTimes(2);
        expect(h.snapshot).toHaveBeenCalledTimes(1);
        expect(h.receipts).toEqual([]);
        act(() => tree.unmount());
    });
});
