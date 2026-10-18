import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AppState, type AppStateStatus } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRootLayoutAppBadge } from './use-root-layout-app-badge';

type State = { _allTasks: object[]; _allProjects: object[]; _allSections: object[]; isLoading: boolean; error: string | null };
const h = vi.hoisted(() => ({
    state: { _allTasks: [{}], _allProjects: [], _allSections: [], isLoading: false, error: null } as State,
    storeListeners: new Set<(state: State, previous: State) => void>(),
    preferenceListeners: new Set<() => void>(), workspaceListeners: new Set<() => void>(),
    supported: true, sandbox: false, switching: false, writes: [] as number[],
    refresh: vi.fn(), count: vi.fn(),
}));
vi.mock('@mindwtr/core', () => ({
    isSandboxMode: () => h.sandbox,
    countTasksForIconBadge: h.count,
    useTaskStore: {
        getState: () => h.state,
        subscribe: (listener: (state: State, previous: State) => void) => {
            h.storeListeners.add(listener);
            return () => h.storeListeners.delete(listener);
        },
    },
}));
vi.mock('@/lib/ios-app-badge', () => ({
    isIosAppBadgeSupported: () => h.supported,
    refreshIosAppBadge: h.refresh,
    subscribeIosAppBadgeEnabled: (listener: () => void) => {
        h.preferenceListeners.add(listener);
        return () => h.preferenceListeners.delete(listener);
    },
}));
vi.mock('@/lib/sandbox-workspace', () => ({
    getWorkspaceSwitching: () => h.switching,
    subscribeWorkspaceSwitching: (listener: () => void) => {
        h.workspaceListeners.add(listener);
        return () => h.workspaceListeners.delete(listener);
    },
}));
vi.mock('@/lib/app-log', () => ({ logWarn: vi.fn(), logInfo: vi.fn() }));
vi.mock('@/modules/ios-app-badge', () => ({ getIosAppBadgeNative: () => null }));

function Probe({ ready = true, disabled = false }) {
    useRootLayoutAppBadge({ canonicalDataReady: ready, disabled });
    return null;
}
const replaceState = (patch: Partial<State>) => {
    const previous = h.state;
    h.state = { ...previous, ...patch };
    h.storeListeners.forEach((listener) => listener(h.state, previous));
};

describe('root app badge lifecycle', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    let lifecycle: ((state: AppStateStatus) => void) | undefined;
    let remove = vi.fn<() => void>();
    beforeEach(() => {
        vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 18, 23, 59, 59));
        h.state = { _allTasks: [{}], _allProjects: [], _allSections: [], isLoading: false, error: null };
        h.supported = true; h.sandbox = false; h.switching = false; h.writes = [];
        h.storeListeners.clear(); h.preferenceListeners.clear(); h.workspaceListeners.clear();
        h.count.mockReset(); h.count.mockImplementation((tasks: object[]) => tasks.length);
        h.refresh.mockReset(); h.refresh.mockImplementation(async (getCount: () => number | null, options: { canWrite: () => boolean }) => {
            const count = getCount();
            if (count !== null && options.canWrite()) h.writes.push(count);
        });
        remove = vi.fn();
        vi.spyOn(AppState, 'addEventListener').mockImplementation((_event, callback) => {
            lifecycle = callback as (state: AppStateStatus) => void;
            return { remove };
        });
    });
    afterEach(async () => {
        if (tree) await act(async () => tree?.unmount());
        tree = undefined; vi.useRealTimers(); vi.restoreAllMocks();
    });
    it('waits for canonical data; avoids counts during loads/errors and reacts only to canonical identities', async () => {
        await act(async () => { tree = renderer.create(<Probe ready={false} />); });
        expect(h.writes).toEqual([]); expect(h.count).not.toHaveBeenCalled();
        await act(async () => tree?.update(<Probe />));
        expect(h.writes.at(-1)).toBe(1); expect(h.count).toHaveBeenCalledOnce();
        await act(async () => replaceState({}));
        expect(h.count).toHaveBeenCalledOnce();
        await act(async () => replaceState({ isLoading: true, _allTasks: [{}, {}] }));
        expect(h.count).toHaveBeenCalledOnce();
        await act(async () => replaceState({ isLoading: false, error: 'unavailable' }));
        expect(h.count).toHaveBeenCalledOnce();
        await act(async () => replaceState({ error: null }));
        expect(h.writes.at(-1)).toBe(2); expect(h.count).toHaveBeenCalledTimes(2);
        await act(async () => replaceState({ _allProjects: [{}], _allSections: [{}] }));
        expect(h.count).toHaveBeenCalledTimes(3);
    });
    it('refreshes at local midnight and resume, reschedules timer and keeps one subscriber', async () => {
        await act(async () => { tree = renderer.create(<Probe />); });
        expect(h.count).toHaveBeenCalledOnce();
        await act(async () => { vi.advanceTimersByTime(1100); });
        expect(h.count).toHaveBeenCalledTimes(2);
        await act(async () => { lifecycle?.('background'); lifecycle?.('active'); });
        expect(h.refresh.mock.calls.at(-1)?.[1].force).toBe(true);
        expect(h.count).toHaveBeenCalledTimes(2);
        expect(AppState.addEventListener).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(1);
    });
    it('clears during sandbox/workspace transition and never counts sandbox data', async () => {
        await act(async () => { tree = renderer.create(<Probe />); });
        h.switching = true;
        await act(async () => h.workspaceListeners.forEach((listener) => listener()));
        expect(h.writes.at(-1)).toBe(0); expect(h.count).toHaveBeenCalledOnce();
        h.sandbox = true; h.switching = false;
        await act(async () => replaceState({ _allTasks: [{}, {}, {}] }));
        expect(h.writes.at(-1)).toBe(0); expect(h.count).toHaveBeenCalledOnce();
        h.sandbox = false;
        await act(async () => tree?.update(<Probe disabled />));
        expect(h.writes.at(-1)).toBe(0); expect(h.count).toHaveBeenCalledOnce();
    });
    it('recounts on a same-date timezone change when the local due-day boundary changes', async () => {
        const previousTimezone = process.env.TZ;
        try {
            process.env.TZ = 'America/New_York';
            vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
            await act(async () => { tree = renderer.create(<Probe />); });
            expect(h.count).toHaveBeenCalledOnce();
            const previousDay = new Date().getDate();
            process.env.TZ = 'Asia/Tokyo';
            expect(new Date().getDate()).toBe(previousDay);
            await act(async () => { lifecycle?.('active'); });
            expect(h.count).toHaveBeenCalledTimes(2);
        } finally {
            if (previousTimezone === undefined) delete process.env.TZ;
            else process.env.TZ = previousTimezone;
        }
    });
    it('rechecks live workspace and disposal in callbacks that resume after authorization', async () => {
        const pending: (() => void)[] = [];
        h.refresh.mockImplementation((getCount: () => number | null, options: { canWrite: () => boolean }) => new Promise<void>((resolve) => {
            pending.push(() => { const count = getCount(); if (count !== null && options.canWrite()) h.writes.push(count); resolve(); });
        }));
        await act(async () => { tree = renderer.create(<Probe />); });
        h.switching = true;
        await act(async () => { pending.shift()?.(); });
        expect(h.writes).toEqual([0]); expect(h.count).not.toHaveBeenCalled();
        await act(async () => { tree?.unmount(); tree = undefined; });
        await act(async () => { pending.forEach((resume) => resume()); });
        expect(h.writes).toEqual([0]);
        expect(remove).toHaveBeenCalledOnce();
        expect(h.storeListeners.size + h.preferenceListeners.size + h.workspaceListeners.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });
    it('processes preference changes and background data changes while running', async () => {
        await act(async () => { tree = renderer.create(<Probe />); });
        await act(async () => { lifecycle?.('background'); replaceState({ _allTasks: [{}, {}] }); });
        expect(h.writes.at(-1)).toBe(2);
        const count = h.refresh.mock.calls.length;
        await act(async () => h.preferenceListeners.forEach((listener) => listener()));
        expect(h.refresh).toHaveBeenCalledTimes(count + 1);
    });
    it('creates no subscription or timer when unsupported (including Android)', async () => {
        h.supported = false;
        await act(async () => { tree = renderer.create(<Probe />); });
        expect(h.refresh).not.toHaveBeenCalled(); expect(AppState.addEventListener).not.toHaveBeenCalled();
        expect(h.storeListeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
    });
    it('uses the production controller to clear default-off without computing a count, even before canonical readiness', async () => {
        const { createIosAppBadgeController } = await vi.importActual<typeof import('@/lib/ios-app-badge')>('@/lib/ios-app-badge');
        const setBadgeCount = vi.fn(async (_count: number): Promise<void> => undefined);
        const controller = createIosAppBadgeController({
            native: () => ({ setBadgeCount, isBadgeAuthorized: async () => true, requestBadgeAuthorization: async () => true }),
            read: async () => null, write: async () => undefined, report: vi.fn(),
        });
        h.refresh.mockImplementation(controller.refresh);
        await act(async () => { tree = renderer.create(<Probe ready={false} />); });
        expect(setBadgeCount).toHaveBeenCalledExactlyOnceWith(0);
        expect(h.count).not.toHaveBeenCalled();
    });
});
