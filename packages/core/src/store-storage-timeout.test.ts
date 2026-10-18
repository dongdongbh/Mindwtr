import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetForTests, setStorageAdapter, useTaskStore } from './store';
import { getStorageTimeoutMs, setStorageTimeoutMs } from './store-settings';
import type { StorageAdapter } from './storage';
import type { AppData } from './types';

// Pass D1c: a load waits for storage as long as the host's budget says; RN, desktop and iOS keep the 15 s default.
describe('the storage read timeout', () => {
    const empty: AppData = { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} };
    const slowStorage = (ms: number) => setStorageAdapter({
        getData: () => new Promise<AppData>((resolve) => setTimeout(() => resolve(empty), ms)),
        saveData: async () => undefined,
    } as unknown as StorageAdapter);
    /** The load's outcome ("loaded" or its error text) once [advanceMs] of fake time passed. */
    const load = async (advanceMs: number) => {
        const outcome = useTaskStore.getState().fetchData({ throwOnError: true })
            .then(() => 'loaded', (error: unknown) => (error instanceof Error ? error.message : String(error)));
        await vi.advanceTimersByTimeAsync(advanceMs);
        return outcome;
    };
    afterEach(() => { setStorageTimeoutMs(); vi.useRealTimers(); resetForTests(); });

    it('defaults to 15 s: a 20 s read times out', async () => {
        vi.useFakeTimers();
        expect(getStorageTimeoutMs()).toBe(15_000);
        slowStorage(20_000);
        expect(await load(20_000)).toContain('Storage request timed out');
    });

    it('a host budget of 30 s lets the 20 s read finish, and no argument restores the default', async () => {
        vi.useFakeTimers();
        setStorageTimeoutMs(30_000);
        slowStorage(20_000);
        expect(await load(20_000)).toBe('loaded');
        setStorageTimeoutMs();
        expect(getStorageTimeoutMs()).toBe(15_000);
        setStorageTimeoutMs(-5);
        expect(getStorageTimeoutMs()).toBe(15_000);
    });
});
