import { describe, expect, it, vi } from 'vitest';

import { useTaskStore } from './store';
import {
    CLOUD_PROVIDER_DROPBOX,
    CLOUD_PROVIDER_SELF_HOSTED,
    DEFAULT_ATTACHMENT_CLEANUP_INTERVAL_MS,
    LocalSyncAbort,
    createAbortableFetch,
    ensureFreshLocalSyncSnapshot,
    getInMemoryAppDataSnapshot,
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
