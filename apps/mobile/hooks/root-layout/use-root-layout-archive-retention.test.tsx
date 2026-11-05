import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AppState, type AppStateStatus } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    days: 0, loading: false, error: null as string | null, editLockCount: 0,
    run: vi.fn(async (_options: { syncConfigured: boolean }) => ({ success: true })),
    selectedBackend: vi.fn(async (): Promise<string> => 'off'),
}));
vi.mock('@mindwtr/core', () => ({
    isArchiveRetentionDays: (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 36500,
    useTaskStore: Object.assign(
        (selector: (state: unknown) => unknown) => selector({ settings: { gtd: { archiveRetentionDays: harness.days } } }),
        { getState: () => ({ isLoading: harness.loading, error: harness.error, editLockCount: harness.editLockCount, runArchiveRetention: harness.run }) },
    ),
}));
vi.mock('@/lib/app-log', () => ({ logError: vi.fn(async () => undefined) }));
vi.mock('@/lib/sync-service', () => ({ getMobileSelectedSyncBackend: harness.selectedBackend }));

import { useRootLayoutArchiveRetention } from './use-root-layout-archive-retention';

function Probe({ ready, disabled }: { ready: boolean; disabled: boolean }) {
    useRootLayoutArchiveRetention(ready, disabled);
    return null;
}

const stateDescriptor = Object.getOwnPropertyDescriptor(AppState, 'currentState');

describe('useRootLayoutArchiveRetention', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        harness.days = 0; harness.loading = false; harness.error = null; harness.editLockCount = 0; harness.run.mockClear();
        harness.selectedBackend.mockReset(); harness.selectedBackend.mockResolvedValue('off');
        Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        if (stateDescriptor) Object.defineProperty(AppState, 'currentState', stateDescriptor);
    });

    it('runs after hydration only while enabled, active, and outside edit locks', async () => {
        let listener: ((state: AppStateStatus) => void) | null = null;
        vi.spyOn(AppState, 'addEventListener').mockImplementation((_event, callback) => {
            listener = callback as (state: AppStateStatus) => void;
            return { remove: vi.fn() };
        });
        let tree!: renderer.ReactTestRenderer;
        await act(async () => { tree = renderer.create(<Probe ready={false} disabled={false} />); });
        await act(async () => { vi.advanceTimersByTime(30 * 60 * 1000); });
        expect(harness.run).not.toHaveBeenCalled();
        harness.days = 30;
        await act(async () => tree.update(<Probe ready disabled />));
        expect(harness.run).not.toHaveBeenCalled();
        await act(async () => tree.update(<Probe ready disabled={false} />));
        expect(harness.run).toHaveBeenCalledTimes(1);
        harness.editLockCount = 1;
        await act(async () => { listener?.('active'); vi.advanceTimersByTime(15 * 60 * 1000); });
        expect(harness.run).toHaveBeenCalledTimes(1);
        harness.editLockCount = 0;
        Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'background' });
        await act(async () => { vi.advanceTimersByTime(15 * 60 * 1000); });
        expect(harness.run).toHaveBeenCalledTimes(1);
        Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
        await act(async () => { listener?.('active'); });
        expect(harness.run).toHaveBeenCalledTimes(2);
        await act(async () => tree.unmount());
    });

    it('keeps waiting while the selected Dropbox backend is disconnected', async () => {
        vi.spyOn(AppState, 'addEventListener').mockImplementation(() => ({ remove: vi.fn() }));
        harness.days = 30;
        harness.selectedBackend.mockResolvedValue('cloud');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => { tree = renderer.create(<Probe ready disabled={false} />); });
        expect(harness.run).toHaveBeenLastCalledWith({ syncConfigured: true });
        await act(async () => tree.unmount());
    });

    it('keeps waiting for a selected CloudKit backend this build cannot run', async () => {
        vi.spyOn(AppState, 'addEventListener').mockImplementation(() => ({ remove: vi.fn() }));
        harness.days = 30;
        harness.selectedBackend.mockResolvedValue('cloudkit');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => { tree = renderer.create(<Probe ready disabled={false} />); });
        expect(harness.run).toHaveBeenLastCalledWith({ syncConfigured: true });
        await act(async () => tree.unmount());
    });

    it('tells retention whether a sync backend is selected so it waits for the first sync (R-2)', async () => {
        let listener: ((state: AppStateStatus) => void) | null = null;
        vi.spyOn(AppState, 'addEventListener').mockImplementation((_event, callback) => {
            listener = callback as (state: AppStateStatus) => void;
            return { remove: vi.fn() };
        });
        harness.days = 30;
        harness.selectedBackend.mockResolvedValue('webdav');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => { tree = renderer.create(<Probe ready disabled={false} />); });
        expect(harness.run).toHaveBeenLastCalledWith({ syncConfigured: true });
        harness.selectedBackend.mockResolvedValue('off');
        await act(async () => { listener?.('active'); });
        expect(harness.run).toHaveBeenLastCalledWith({ syncConfigured: false });

        harness.selectedBackend.mockRejectedValue(new Error('config unavailable'));
        await act(async () => { listener?.('active'); });
        expect(harness.run).toHaveBeenLastCalledWith({ syncConfigured: true });
        expect(harness.run).toHaveBeenCalledTimes(3);
        await act(async () => tree.unmount());
    });
});
