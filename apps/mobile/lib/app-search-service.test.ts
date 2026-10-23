import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (state: any, prevState: any) => void;

const listeners = vi.hoisted(() => [] as Listener[]);
const storeState = vi.hoisted(() => ({ tasks: [] as any[], projects: [] as any[], areas: [] as any[], settings: {} as any }));

const useTaskStoreMock = vi.hoisted(() => ({
    getState: () => storeState,
    subscribe: (listener: Listener) => {
        listeners.push(listener);
        return () => {
            const index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
        };
    },
}));

vi.mock('@mindwtr/core', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        useTaskStore: useTaskStoreMock,
        // The real helper just tags the listener for the notify profiler; identity
        // passthrough is all this suite needs.
        nameNotifyListener: (_name: string, listener: Listener) => listener,
    };
});

const upsertAppSearchDocuments = vi.hoisted(() => vi.fn(async (_docs: unknown[]) => undefined));
const removeAppSearchDocuments = vi.hoisted(() => vi.fn(async (_ids: string[]) => undefined));
const wipeAppSearchIndexNative = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/modules/app-search', () => ({
    upsertAppSearchDocuments,
    removeAppSearchDocuments,
    wipeAppSearchIndexNative,
}));

const isAppSearchSupported = vi.hoisted(() => vi.fn(() => true));
const readAppSearchIndexingEnabled = vi.hoisted(() => vi.fn(async () => true));
const readAppSearchWipeOwed = vi.hoisted(() => vi.fn(async () => false));
const clearAppSearchWipeOwed = vi.hoisted(() => vi.fn(async () => undefined));
const markAppSearchWipeOwed = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('./app-search-preference', () => ({
    isAppSearchSupported,
    readAppSearchIndexingEnabled,
    readAppSearchWipeOwed,
    clearAppSearchWipeOwed,
    markAppSearchWipeOwed,
}));

import {
    armAppSearchIndexing,
    disarmAppSearchIndexing,
    enableAppSearchIndexing,
    isAppSearchIndexingArmed,
    runFullAppSearchReindex,
    syncAppSearchIndexingWithPreference,
    wipeAppSearchIndex,
} from './app-search-service';

const now = '2026-08-10T00:00:00.000Z';
const task = (overrides: Record<string, unknown> = {}) => ({
    id: 't1', title: 'Buy milk', status: 'next', tags: [], contexts: [], createdAt: now, updatedAt: now, ...overrides,
});

const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
};

describe('app-search-service', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        listeners.length = 0;
        storeState.tasks = [];
        storeState.projects = [];
        storeState.areas = [];
        isAppSearchSupported.mockReturnValue(true);
        readAppSearchIndexingEnabled.mockResolvedValue(true);
        readAppSearchWipeOwed.mockResolvedValue(false);
        disarmAppSearchIndexing();
    });

    afterEach(() => {
        disarmAppSearchIndexing();
        vi.useRealTimers();
    });

    it('does not subscribe when unsupported (zero overhead in the default-off state)', () => {
        isAppSearchSupported.mockReturnValue(false);
        armAppSearchIndexing();
        expect(listeners).toHaveLength(0);
        expect(isAppSearchIndexingArmed()).toBe(false);
    });

    it('arms exactly one subscription even if called twice', () => {
        armAppSearchIndexing();
        armAppSearchIndexing();
        expect(listeners).toHaveLength(1);
    });

    it('debounces a mutation and upserts only the changed task', async () => {
        armAppSearchIndexing();
        const prevState = { ...storeState };
        storeState.tasks = [task()];
        listeners[0](storeState, prevState);

        expect(upsertAppSearchDocuments).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2_000);
        await flush();

        expect(upsertAppSearchDocuments).toHaveBeenCalledTimes(1);
        expect(upsertAppSearchDocuments.mock.calls[0][0]).toEqual([
            expect.objectContaining({ id: 'task:t1', title: 'Buy milk' }),
        ]);
        expect(removeAppSearchDocuments).toHaveBeenCalledWith([]);
    });

    it('coalesces rapid changes into a single round-trip', async () => {
        armAppSearchIndexing();
        const prevState = { ...storeState };
        storeState.tasks = [task()];
        listeners[0](storeState, prevState);
        storeState.tasks = [task({ title: 'Buy oat milk' })];
        listeners[0](storeState, prevState);

        await vi.advanceTimersByTimeAsync(2_000);
        await flush();

        expect(upsertAppSearchDocuments).toHaveBeenCalledTimes(1);
        expect(upsertAppSearchDocuments.mock.calls[0][0][0]).toMatchObject({ title: 'Buy oat milk' });
    });

    it('does no work when the changed slices are unrelated to tasks/projects/areas', async () => {
        armAppSearchIndexing();
        const prevState = { ...storeState, loading: false };
        const nextState = { ...storeState, loading: true };
        listeners[0](nextState, prevState);
        await vi.advanceTimersByTimeAsync(2_000);
        await flush();
        expect(upsertAppSearchDocuments).not.toHaveBeenCalled();
    });

    it('disarm stops future updates from reaching the index', async () => {
        armAppSearchIndexing();
        disarmAppSearchIndexing();
        expect(listeners).toHaveLength(0);
        expect(isAppSearchIndexingArmed()).toBe(false);
    });

    it('runFullAppSearchReindex wipes then upserts every indexable entity', async () => {
        storeState.tasks = [task(), task({ id: 't2', status: 'done' })];
        await runFullAppSearchReindex();
        expect(wipeAppSearchIndexNative).toHaveBeenCalledTimes(1);
        expect(upsertAppSearchDocuments).toHaveBeenCalledTimes(1);
        expect(upsertAppSearchDocuments.mock.calls[0][0]).toEqual([expect.objectContaining({ id: 'task:t1' })]);
    });

    it('wipeAppSearchIndex disarms and wipes the native index', async () => {
        armAppSearchIndexing();
        await wipeAppSearchIndex();
        expect(isAppSearchIndexingArmed()).toBe(false);
        expect(wipeAppSearchIndexNative).toHaveBeenCalledTimes(1);
    });

    it('syncAppSearchIndexingWithPreference arms only when the preference is on', async () => {
        readAppSearchIndexingEnabled.mockResolvedValue(false);
        await syncAppSearchIndexingWithPreference();
        expect(isAppSearchIndexingArmed()).toBe(false);

        readAppSearchIndexingEnabled.mockResolvedValue(true);
        await syncAppSearchIndexingWithPreference();
        expect(isAppSearchIndexingArmed()).toBe(true);
        expect(wipeAppSearchIndexNative).toHaveBeenCalledTimes(1); // seeding full reindex
    });

    it('enableAppSearchIndexing arms normally when the preference is still on', async () => {
        await enableAppSearchIndexing();
        expect(isAppSearchIndexingArmed()).toBe(true);
        expect(wipeAppSearchIndexNative).toHaveBeenCalledTimes(1);
    });

    it('enableAppSearchIndexing re-wipes instead of arming if the preference flips off mid-reindex (#1017 correction)', async () => {
        let resolveUpsert!: () => void;
        upsertAppSearchDocuments.mockImplementationOnce(() => new Promise<undefined>((resolve) => {
            resolveUpsert = () => resolve(undefined);
        }));

        const enabling = enableAppSearchIndexing();
        await flush(); // let runFullAppSearchReindex's wipe resolve and reach the upsert call
        // The toggle-off handler flips the persisted preference while the
        // reindex's upsert is still in flight.
        readAppSearchIndexingEnabled.mockResolvedValue(false);
        resolveUpsert();
        await enabling;

        expect(isAppSearchIndexingArmed()).toBe(false);
        // Once from runFullAppSearchReindex's own wipe, once more from the
        // post-reindex re-check that undoes the upserts it just sent.
        expect(wipeAppSearchIndexNative).toHaveBeenCalledTimes(2);
    });

    // A toggle-off whose wipe failed (or never ran: the app died) left titles in Android search for good, since the next
    // start saw the switch off and did nothing. The owed wipe now runs then, and is cleared only once it lands.
    it('finishes an owed wipe at the next start, and keeps it owed until a wipe lands', async () => {
        wipeAppSearchIndexNative.mockRejectedValueOnce(new Error('boom'));
        await wipeAppSearchIndex();
        expect(clearAppSearchWipeOwed).not.toHaveBeenCalled();

        readAppSearchIndexingEnabled.mockResolvedValue(false);
        readAppSearchWipeOwed.mockResolvedValue(true);
        wipeAppSearchIndexNative.mockClear();
        await syncAppSearchIndexingWithPreference();
        expect(wipeAppSearchIndexNative).toHaveBeenCalledTimes(1);
        expect(clearAppSearchWipeOwed).toHaveBeenCalledTimes(1);
        expect(isAppSearchIndexingArmed()).toBe(false);

        // Nothing owed, switch off: a start does no native work at all.
        readAppSearchWipeOwed.mockResolvedValue(false);
        wipeAppSearchIndexNative.mockClear();
        await syncAppSearchIndexingWithPreference();
        expect(wipeAppSearchIndexNative).not.toHaveBeenCalled();
    });

    // A toggle-off can land during a reindex, and the reindex's upsert lands after its wipe: a reindex never settles an
    // owed wipe (a stale one while the switch is on is harmless; turning it off sets it again).
    it('a full reindex (switch on) leaves an owed wipe owed', async () => {
        readAppSearchWipeOwed.mockResolvedValue(true);
        await syncAppSearchIndexingWithPreference();
        expect(isAppSearchIndexingArmed()).toBe(true);
        expect(clearAppSearchWipeOwed).not.toHaveBeenCalled();
    });

    it('a native failure is logged and swallowed, never thrown', async () => {
        upsertAppSearchDocuments.mockRejectedValueOnce(new Error('boom'));
        armAppSearchIndexing();
        const prevState = { ...storeState };
        storeState.tasks = [task()];
        expect(() => listeners[0](storeState, prevState)).not.toThrow();
        await vi.advanceTimersByTimeAsync(2_000);
        await expect(flush()).resolves.toBeUndefined();
    });

    it('still runs removals when the upsert in the same batch fails (#1017 correction)', async () => {
        armAppSearchIndexing();
        // Seed with two tasks so the next batch carries one upsert (title
        // change) and one removal (task disappeared) together.
        storeState.tasks = [task(), task({ id: 't2', title: 'Other' })];
        listeners[0](storeState, { ...storeState, tasks: [] });
        await vi.advanceTimersByTimeAsync(2_000);
        await flush();
        upsertAppSearchDocuments.mockClear();
        removeAppSearchDocuments.mockClear();

        upsertAppSearchDocuments.mockRejectedValueOnce(new Error('boom'));
        const prevState = { ...storeState };
        storeState.tasks = [task({ title: 'Buy oat milk' })]; // t1 changes, t2 disappears
        listeners[0](storeState, prevState);
        await vi.advanceTimersByTimeAsync(2_000);
        await flush();

        expect(upsertAppSearchDocuments).toHaveBeenCalledWith([expect.objectContaining({ title: 'Buy oat milk' })]);
        expect(removeAppSearchDocuments).toHaveBeenCalledWith(['task:t2']);
    });
});
