import { describe, expect, it, vi } from 'vitest';

import { flushPendingSave, resetForTests, sameStoreData, storeDataOf, useTaskStore } from './store';
import { runToEnd } from './cooperative';
import { cloneAppDataPass } from './sync-runtime-utils';
import type { AppData } from './types';
import {
    CLOUD_PROVIDER_DROPBOX,
    CLOUD_PROVIDER_SELF_HOSTED,
    DEFAULT_ATTACHMENT_CLEANUP_INTERVAL_MS,
    LocalSyncAbort,
    applySyncedDataToStore,
    captureInMemoryAppDataSnapshot,
    createAbortableFetch,
    ensureFreshLocalSyncSnapshot,
    getInMemoryAppDataSnapshot,
    loadLeavesStorePass,
    prepareSyncedDataPublishPass,
    getInMemorySyncChangeFingerprint,
    normalizeCloudProvider,
    shouldRunAttachmentCleanup,
} from './sync-client-helpers';

describe('sync-client-helpers', () => {
    it('creates an isolated in-memory app data snapshot', () => {
        const now = '2026-01-01T00:00:00.000Z';
        useTaskStore.setState((state) => ({
            ...state,
            _allTasks: [{ id: 't1', title: 'Task', status: 'inbox', createdAt: now, updatedAt: now }],
            _allProjects: [{ id: 'p1', title: 'Project', status: 'active', color: '#000000', createdAt: now, updatedAt: now }],
            _allSections: [],
            _allAreas: [],
            _allPeople: [{ id: 'person-1', name: 'Alex', createdAt: now, updatedAt: now }],
            settings: { gtd: { autoArchiveDays: 7 } },
        }));

        const snapshot = getInMemoryAppDataSnapshot();
        snapshot.tasks[0]!.title = 'Changed';
        snapshot.people![0]!.name = 'Changed';

        expect(useTaskStore.getState()._allTasks[0]!.title).toBe('Task');
        expect(useTaskStore.getState()._allPeople[0]!.name).toBe('Alex');
    });

    it('captures the store in one read, and copying the capture gives the deep snapshot (D9b change 3 review P3-2)', () => {
        const now = '2026-01-01T00:00:00.000Z';
        useTaskStore.setState((state) => ({
            ...state,
            _allTasks: [{ id: 't1', title: 'Task', status: 'inbox', tags: ['#a'], checklist: [{ id: 'c1', title: 'one', isCompleted: false }], createdAt: now, updatedAt: now }],
            _allProjects: [{ id: 'p1', title: 'Project', status: 'active', color: '#000000', createdAt: now, updatedAt: now }],
            _allSections: [{ id: 's1', projectId: 'p1', title: 'Section', createdAt: now, updatedAt: now }],
            _allAreas: [{ id: 'a1', name: 'Area', order: 0, createdAt: now, updatedAt: now }],
            _allPeople: [{ id: 'person-1', name: 'Alex', createdAt: now, updatedAt: now }],
            settings: { gtd: { autoArchiveDays: 7 } },
        }));
        const expected = getInMemoryAppDataSnapshot();

        const captured = captureInMemoryAppDataSnapshot();
        // The store replaces its lists after the capture; the capture keeps the state it read.
        useTaskStore.setState({ _allTasks: [], _allPeople: [] });
        const copy = runToEnd(cloneAppDataPass(captured));

        expect(copy).toEqual(expected);
        copy.tasks[0]!.tags!.push('#b');
        expect(captured.tasks[0]!.tags).toEqual(['#a']);
    });

    it('swaps in a prepared publish only onto the store it was built against, leaving what computing it in the gate leaves (D9b W6)', () => {
        const now = '2026-01-01T00:00:00.000Z';
        const later = '2026-01-02T00:00:00.000Z';
        useTaskStore.setState((state) => ({
            ...state,
            _allTasks: [
                { id: 't1', title: 'Old', status: 'inbox', createdAt: now, updatedAt: now, rev: 1 },
                { id: 't2', title: 'Kept', status: 'next', createdAt: now, updatedAt: now, rev: 1 },
            ],
            _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
            settings: { gtd: { autoArchiveDays: 7 } },
        }));
        const before = useTaskStore.getState();
        const doc: AppData = {
            tasks: [
                { id: 't1', title: 'New', status: 'next', createdAt: now, updatedAt: later, rev: 2 },
                { ...before._allTasks[1]! },
                { id: 't3', title: 'Added', status: 'inbox', createdAt: later, updatedAt: later, rev: 1 },
            ],
            projects: [], sections: [], areas: [], people: [],
            settings: { gtd: { autoArchiveDays: 14 } },
        };
        const shown = () => {
            const state = useTaskStore.getState();
            return { all: state._allTasks, visible: state.tasks, byId: [...state._tasksById.entries()], projects: state._allProjects, settings: state.settings };
        };
        expect(applySyncedDataToStore(doc, useTaskStore)).toBe(false);
        const inGate = shown();

        useTaskStore.setState(before, true);
        const prepared = runToEnd(prepareSyncedDataPublishPass(doc));
        expect(applySyncedDataToStore(doc, useTaskStore, prepared)).toBe(true);
        expect(shown()).toEqual(inGate);
        // The row whose revision did not change keeps the store's object, as a load does.
        expect(useTaskStore.getState()._tasksById.get('t2')).toBe(before._allTasks[1]);

        // Built against a store that has moved since, or for another document: computed in the gate.
        useTaskStore.setState(before, true);
        const stale = runToEnd(prepareSyncedDataPublishPass(doc));
        useTaskStore.setState((state) => ({ settings: { ...state.settings, lastSyncStatus: 'syncing' } }));
        expect(applySyncedDataToStore(doc, useTaskStore, stale)).toBe(false);
        useTaskStore.setState(before, true);
        expect(applySyncedDataToStore({ ...doc }, useTaskStore, runToEnd(prepareSyncedDataPublishPass(doc)))).toBe(false);
        expect(shown()).toEqual(inGate);
    });

    // The refresh drop (D9b W6) rests on this: a prepared publish says the end-of-cycle load changes nothing exactly when
    // fetchData with the same document, run after the publish, leaves the store's data as it was.
    it.each([
        ['a document the load leaves as it is', true, (doc: AppData) => doc],
        ['a row that needs normalizeTaskForLoad', false, (doc: AppData) => ({
            // An update time before the creation time: the load moves it, so the row's revision identity changes.
            ...doc, tasks: [...doc.tasks, { id: 'raw', title: 'Raw', status: 'inbox', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', rev: 1 } as AppData['tasks'][number]],
        })],
        ['a row a load migration changes', false, (doc: AppData) => ({
            ...doc, tasks: doc.tasks.map((task) => (task.id === 't2'
                ? { ...task, status: 'done' as const, completedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(), rev: 2 }
                : task)),
        })],
        ['a kept store row whose Focus fields differ', false, (doc: AppData) => {
            useTaskStore.setState((state) => ({ _allTasks: state._allTasks.map((task) => (task.id === 't1' ? { ...task, isFocusedToday: true } : task)) }));
            return doc;
        }],
    ])('says the end-of-cycle load changes nothing exactly when it does not: %s', async (_name, covered, change) => {
        await flushPendingSave();
        resetForTests();
        const now = new Date().toISOString();
        // An empty store: a load never drops rows the store holds (its partial-snapshot guard).
        useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [], settings: {} });
        await useTaskStore.getState().fetchData({ silent: true, preloadedData: {
            tasks: [
                { id: 't1', title: 'One', status: 'next', createdAt: now, updatedAt: now, rev: 1 },
                { id: 't2', title: 'Two', status: 'next', createdAt: now, updatedAt: now, rev: 1 },
            ],
            projects: [{ id: 'p1', title: 'Project', status: 'active', color: '#000000', createdAt: now, updatedAt: now, rev: 1 }],
            sections: [], areas: [], people: [], settings: { deviceId: 'this-device' },
        } as AppData });
        await flushPendingSave();
        expect(useTaskStore.getState()._allTasks.map((task) => task.id)).toEqual(['t1', 't2']);
        expect(useTaskStore.getState().settings).toMatchObject({ deviceId: 'this-device', migrations: { version: expect.any(Number) } });
        // What the store shows after a load: every row load-normalized, every migration applied.
        const doc = change(getInMemoryAppDataSnapshot());

        const prepared = runToEnd(prepareSyncedDataPublishPass(doc));
        expect(applySyncedDataToStore(doc, useTaskStore, prepared)).toBe(true);
        const published = storeDataOf(useTaskStore.getState());
        const shown = useTaskStore.getState();
        const leaves = runToEnd(loadLeavesStorePass(doc, { tasks: shown._allTasks, projects: shown._allProjects }));
        await useTaskStore.getState().fetchData({ silent: true, preloadedData: doc });
        await flushPendingSave();

        expect(leaves).toBe(covered);
        expect(sameStoreData(storeDataOf(useTaskStore.getState()), published)).toBe(covered);
    });

    it('fingerprints store changes without cloning, and ignores device-local sync status', () => {
        const now = '2026-01-01T00:00:00.000Z';
        useTaskStore.setState((state) => ({
            ...state,
            _allTasks: [{ id: 't1', title: 'Task', status: 'inbox', createdAt: now, updatedAt: now, rev: 1 }],
            _allProjects: [],
            _allSections: [],
            _allAreas: [],
            _allPeople: [],
            settings: { gtd: { autoArchiveDays: 7 } },
        }));
        const before = getInMemorySyncChangeFingerprint();

        // Sync bookkeeping is patched straight into settings after every cycle;
        // it must never look like a change worth syncing again (#766).
        useTaskStore.setState((state) => ({
            settings: { ...state.settings, lastSyncAt: now, lastSyncStatus: 'success' },
        }));
        expect(getInMemorySyncChangeFingerprint()).toBe(before);

        useTaskStore.setState((state) => ({
            _allTasks: [{ ...state._allTasks[0]!, title: 'Edited', updatedAt: '2026-01-02T00:00:00.000Z', rev: 2 }],
        }));
        expect(getInMemorySyncChangeFingerprint()).not.toBe(before);
    });

    it('evaluates attachment cleanup windows', () => {
        expect(shouldRunAttachmentCleanup(undefined)).toBe(true);
        expect(shouldRunAttachmentCleanup('invalid-date')).toBe(true);

        const now = Date.now();
        const recent = new Date(now - Math.floor(DEFAULT_ATTACHMENT_CLEANUP_INTERVAL_MS / 2)).toISOString();
        const stale = new Date(now - (DEFAULT_ATTACHMENT_CLEANUP_INTERVAL_MS + 1_000)).toISOString();

        expect(shouldRunAttachmentCleanup(recent)).toBe(false);
        expect(shouldRunAttachmentCleanup(stale)).toBe(true);
    });

    it('creates a named LocalSyncAbort error', () => {
        const error = new LocalSyncAbort();
        expect(error.name).toBe('LocalSyncAbort');
        expect(error.message).toContain('Local changes detected');
    });


    it('keeps a fresh local sync snapshot without queueing follow-up work', () => {
        const requestFollowUp = vi.fn();

        const currentChangeAt = ensureFreshLocalSyncSnapshot({
            localSnapshotChangeAt: 10,
            getCurrentChangeAt: () => 10,
            requestFollowUp,
        });

        expect(currentChangeAt).toBe(10);
        expect(requestFollowUp).not.toHaveBeenCalled();
    });

    it('accepts a stale local sync snapshot when the caller proves it is covered', () => {
        const requestFollowUp = vi.fn();
        const acceptCoveredSnapshot = vi.fn(() => true);

        const currentChangeAt = ensureFreshLocalSyncSnapshot({
            localSnapshotChangeAt: 10,
            getCurrentChangeAt: () => 11,
            requestFollowUp,
            acceptCoveredSnapshot,
        });

        expect(currentChangeAt).toBe(11);
        expect(acceptCoveredSnapshot).toHaveBeenCalledWith(11);
        expect(requestFollowUp).not.toHaveBeenCalled();
    });

    it('queues a follow-up and aborts when the local sync snapshot is stale', () => {
        const requestFollowUp = vi.fn();
        const onStale = vi.fn();

        expect(() => ensureFreshLocalSyncSnapshot({
            localSnapshotChangeAt: 10,
            getCurrentChangeAt: () => 12,
            requestFollowUp,
            onStale,
        })).toThrow(LocalSyncAbort);

        expect(onStale).toHaveBeenCalledWith({ localSnapshotChangeAt: 10, currentChangeAt: 12 });
        expect(requestFollowUp).toHaveBeenCalledOnce();
    });

    it('normalizes cloud provider values', () => {
        expect(normalizeCloudProvider('dropbox')).toBe(CLOUD_PROVIDER_DROPBOX);
        expect(normalizeCloudProvider('dropbox', { allowDropbox: false })).toBe(CLOUD_PROVIDER_SELF_HOSTED);
        expect(normalizeCloudProvider('anything-else')).toBe(CLOUD_PROVIDER_SELF_HOSTED);
        expect(normalizeCloudProvider(null)).toBe(CLOUD_PROVIDER_SELF_HOSTED);
    });

    it('applies the base abort signal when wrapping fetch', async () => {
        const baseController = new AbortController();
        const baseFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            expect(init?.signal).toBe(baseController.signal);
            return new Response(null, { status: 200 });
        }) as typeof fetch;
        const wrappedFetch = createAbortableFetch(baseFetch, { baseSignal: baseController.signal });

        await wrappedFetch('https://example.com');
        expect(baseFetch).toHaveBeenCalledTimes(1);
    });

    it('uses an already-aborted base signal for wrapped fetch calls', async () => {
        const baseController = new AbortController();
        baseController.abort();

        const baseFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            expect(init?.signal?.aborted).toBe(true);
            return new Response(null, { status: 200 });
        }) as typeof fetch;
        const wrappedFetch = createAbortableFetch(baseFetch, { baseSignal: baseController.signal });

        await wrappedFetch('https://example.com');
        expect(baseFetch).toHaveBeenCalledTimes(1);
    });

    it('keeps the fallback signal bridge active after response headers arrive', async () => {
        const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
        Object.defineProperty(AbortSignal, 'any', {
            configurable: true,
            value: undefined,
        });
        try {
            const baseController = new AbortController();
            const requestController = new AbortController();
            let requestSignal: AbortSignal | null = null;
            const baseFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
                requestSignal = init?.signal as AbortSignal;
                return new Response(new ReadableStream({ pull: () => undefined }), { status: 200 });
            }) as typeof fetch;
            const wrappedFetch = createAbortableFetch(baseFetch, { baseSignal: baseController.signal });

            const response = await wrappedFetch('https://example.com', {
                signal: requestController.signal,
            });
            expect(response.body).not.toBeNull();
            expect(requestSignal?.aborted).toBe(false);

            baseController.abort(new DOMException('Sync cycle cancelled', 'AbortError'));

            expect(requestSignal?.aborted).toBe(true);
            expect(requestSignal?.reason).toMatchObject({ name: 'AbortError' });
        } finally {
            if (anyDescriptor) {
                Object.defineProperty(AbortSignal, 'any', anyDescriptor);
            } else {
                Reflect.deleteProperty(AbortSignal, 'any');
            }
        }
    });
});
