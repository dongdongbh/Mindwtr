import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppData, Attachment } from '@mindwtr/core';
import { DropboxUnauthorizedError } from './dropbox-sync';
import { fallbackHashString, getFileSyncDir, hashString, normalizeSyncBackend } from './sync-service-utils';
import { useUiStore } from '../store/ui-store';

const markLocalWriteMock = vi.hoisted(() => vi.fn());

import { SyncService, __syncServiceTestUtils } from './sync-service';

const waitForAssertion = async (assertion: () => void, maxAttempts = 200): Promise<void> => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
            assertion();
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    }
    throw lastError ?? new Error('Timed out waiting for expectation');
};

afterEach(async () => {
    __syncServiceTestUtils.resetDependenciesForTests();
    await SyncService.resetForTests();
    localStorage.clear();
    sessionStorage.clear();
});

describe('sync-service test utils', () => {
    it('normalizes known sync backends and defaults unknown values to off', () => {
        expect(normalizeSyncBackend('file')).toBe('file');
        expect(normalizeSyncBackend('webdav')).toBe('webdav');
        expect(normalizeSyncBackend('cloud')).toBe('cloud');
        expect(normalizeSyncBackend('off')).toBe('off');
        expect(normalizeSyncBackend('unknown')).toBe('off');
        expect(normalizeSyncBackend(null)).toBe('off');
    });

    it('extracts base directory for file sync paths', () => {
        expect(getFileSyncDir('/tmp/mindwtr/data.json', 'data.json', 'mindwtr-sync.json')).toBe('/tmp/mindwtr');
        expect(getFileSyncDir('/tmp/mindwtr/mindwtr-sync.json', 'data.json', 'mindwtr-sync.json')).toBe('/tmp/mindwtr');
        expect(getFileSyncDir('/tmp/mindwtr/', 'data.json', 'mindwtr-sync.json')).toBe('/tmp/mindwtr');
        expect(getFileSyncDir('', 'data.json', 'mindwtr-sync.json')).toBe('');
    });

    it('hashes sync payloads with sha256 output', async () => {
        const hash = await hashString('mindwtr');
        expect(hash).toBe('feb7a7b01b1c68e586e77288a4b2598d146ee3696ec7dbfac0074196b8d68c33');
    });

    it('formats fallback hashes as unsigned hex', () => {
        expect(fallbackHashString('mindwtr')).toMatch(/^[0-9a-f]+$/);
        expect(fallbackHashString('mindwtr')).not.toContain('-');
    });

    it('marks attachments unrecoverable when validation failures hit retry cap', () => {
        const attachment: Attachment = {
            id: 'att-1',
            kind: 'file',
            title: 'Design Doc',
            uri: '/tmp/design-doc.pdf',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            localStatus: 'available',
            cloudKey: 'attachments/att-1.pdf',
            fileHash: 'hash-1',
        };

        const first = __syncServiceTestUtils.simulateAttachmentValidationFailure(attachment, 'invalid hash');
        const second = __syncServiceTestUtils.simulateAttachmentValidationFailure(attachment, 'invalid hash');
        const third = __syncServiceTestUtils.simulateAttachmentValidationFailure(attachment, 'invalid hash');

        expect(first.reachedLimit).toBe(false);
        expect(second.reachedLimit).toBe(false);
        expect(third.reachedLimit).toBe(true);
        expect(__syncServiceTestUtils.getAttachmentValidationFailureAttempts(attachment.id)).toBe(0);
        expect(attachment.deletedAt).toBeDefined();
        expect(attachment.localStatus).toBe('missing');
        expect(attachment.cloudKey).toBeUndefined();
        expect(attachment.fileHash).toBeUndefined();
    });
});

describe('SyncService testability hooks', () => {
    it('supports resetting singleton state between tests', async () => {
        (SyncService as any).syncQueued = true;
        (SyncService as any).syncStatus = {
            inFlight: true,
            queued: true,
            step: 'syncing',
            lastResult: 'error',
            lastResultAt: '2025-01-01T00:00:00.000Z',
        };
        (SyncService as any).syncListeners.add(() => {});
        __syncServiceTestUtils.clearWebdavDownloadBackoff();
        (SyncService as any).externalSyncTimer = setTimeout(() => undefined, 1_000);

        await SyncService.resetForTests();

        expect(SyncService.getSyncStatus()).toEqual({
            inFlight: false,
            queued: false,
            step: null,
            lastResult: null,
            lastResultAt: null,
        });
        expect((SyncService as any).syncListeners.size).toBe(0);
        expect((SyncService as any).syncQueued).toBe(false);
        expect((SyncService as any).externalSyncTimer).toBeNull();
    });

    it('only surfaces attachment warnings after repeated sync runs', async () => {
        const originalShowToast = useUiStore.getState().showToast;
        const showToast = vi.fn();
        useUiStore.setState({ showToast });

        try {
            (SyncService as any).consecutiveAttachmentWarningRuns = 0;
            (SyncService as any).lastAttachmentWarningToastAt = 0;

            (SyncService as any).finalizeAttachmentWarningState({ hadAttachmentWarning: true }, { success: true });
            expect(showToast).not.toHaveBeenCalled();

            (SyncService as any).finalizeAttachmentWarningState({ hadAttachmentWarning: true }, { success: true });
            expect(showToast).toHaveBeenCalledWith(
                'Attachment sync is still failing. Files will retry in the background.',
                'error',
                6000,
            );

            (SyncService as any).finalizeAttachmentWarningState({ hadAttachmentWarning: false }, { success: true });
            expect((SyncService as any).consecutiveAttachmentWarningRuns).toBe(0);
        } finally {
            useUiStore.setState({ showToast: originalShowToast });
        }
    });

    it('allows injecting tauri dependencies for orchestration tests', async () => {
        const invoke = vi.fn(async (command: string) => {
            if (command === 'get_sync_backend') return 'cloud';
            return '';
        });
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
        });
        (SyncService as any).didMigrate = true;

        const backend = await SyncService.getSyncBackend();

        expect(backend).toBe('cloud');
        expect(invoke).toHaveBeenCalledWith('get_sync_backend', undefined);
    });

    it('marks direct sync save_data writes as local writes', async () => {
        const invoke = vi.fn(async () => undefined);
        const data: AppData = {
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        };
        markLocalWriteMock.mockReset();
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
            markLocalWrite: markLocalWriteMock as unknown as (data?: AppData) => void,
        });

        await __syncServiceTestUtils.persistLocalDataForTests(data);

        expect(markLocalWriteMock).toHaveBeenCalledWith(data);
        expect(invoke).toHaveBeenCalledWith('save_data', { data });
    });

    it('defaults cloud provider to selfhosted and persists selection', async () => {
        expect(await SyncService.getCloudProvider()).toBe('selfhosted');
        await SyncService.setCloudProvider('dropbox');
        expect(await SyncService.getCloudProvider()).toBe('dropbox');
        await SyncService.setCloudProvider('selfhosted');
        expect(await SyncService.getCloudProvider()).toBe('selfhosted');
    });

    it('treats Dropbox app key as build-time config', async () => {
        const baseline = await SyncService.getDropboxAppKey();
        await SyncService.setDropboxAppKey('abc123');
        expect(await SyncService.getDropboxAppKey()).toBe(baseline);
        await SyncService.setDropboxAppKey('');
        expect(await SyncService.getDropboxAppKey()).toBe(baseline);
    });

    it('tests WebDAV connectivity against the normalized data.json URL', async () => {
        const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));
        __syncServiceTestUtils.setDependenciesForTests({
            getTauriFetch: async () => fetchSpy as unknown as typeof fetch,
        });

        await SyncService.testWebDavConnection({
            url: 'https://example.com/remote.php/dav/files/user/mindwtr/',
            username: 'alice',
            password: 'secret',
        });

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const firstCall = fetchSpy.mock.calls[0];
        expect(firstCall).toBeDefined();
        if (!firstCall) {
            throw new Error('Expected WebDAV fetch call');
        }
        expect(firstCall[0]).toBe('https://example.com/remote.php/dav/files/user/mindwtr/data.json');
        expect(firstCall[1]).toMatchObject({ method: 'GET' });
    });

    it('reuses the stored WebDAV password when settings only expose hasPassword', async () => {
        const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));
        const invoke = vi.fn(async (command: string) => {
            if (command === 'get_webdav_password') return 'stored-secret';
            throw new Error(`unexpected command: ${command}`);
        });
        __syncServiceTestUtils.setDependenciesForTests({
            getTauriFetch: async () => fetchSpy as unknown as typeof fetch,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
            isTauriRuntime: () => true,
        });

        await SyncService.testWebDavConnection({
            url: 'https://example.com/remote.php/dav/files/user/mindwtr',
            username: 'alice',
            hasPassword: true,
        });

        expect(invoke).toHaveBeenCalledWith('get_webdav_password', undefined);
        const firstCall = fetchSpy.mock.calls[0];
        expect(firstCall).toBeDefined();
        if (!firstCall) {
            throw new Error('Expected WebDAV fetch call');
        }
        const init = firstCall[1] as RequestInit | undefined;
        expect(init?.headers).toMatchObject({
            Authorization: 'Basic YWxpY2U6c3RvcmVkLXNlY3JldA==',
        });
    });

    it('keeps file watcher ignores active until sync completion after writing the sync file', async () => {
        const getMonotonicNowSpy = vi.spyOn(SyncService as any, 'getMonotonicNow');
        getMonotonicNowSpy.mockReturnValue(9_000);

        await (SyncService as any).markSyncWrite({
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        } satisfies AppData);

        expect((SyncService as any).fileWriteIgnoreActive).toBe(true);
        expect((SyncService as any).ignoreFileEventsUntil).toBe(Number.POSITIVE_INFINITY);

        (SyncService as any).finalizeSyncWriteIgnoreWindow();

        expect((SyncService as any).fileWriteIgnoreActive).toBe(false);
        expect((SyncService as any).ignoreFileEventsUntil).toBe(11_000);
        getMonotonicNowSpy.mockRestore();
    });

    it('finalizes the sync file ignore window when external keep-local writes fail', async () => {
        const getMonotonicNowSpy = vi.spyOn(SyncService as any, 'getMonotonicNow');
        getMonotonicNowSpy.mockReturnValue(9_000);
        const invoke = vi.fn(async (command: string) => {
            if (command === 'get_sync_backend') return 'file';
            if (command === 'save_data') return undefined;
            if (command === 'write_sync_file') {
                throw new Error('disk full');
            }
            throw new Error(`unexpected command: ${command}`);
        });
        __syncServiceTestUtils.setDependenciesForTests({
            flushPendingSave: vi.fn(async () => undefined),
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
            isTauriRuntime: () => true,
        });
        await __syncServiceTestUtils.persistLocalDataForTests({
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        });
        (SyncService as any).didMigrate = true;
        (SyncService as any).pendingExternalSyncChange = {
            path: '/tmp/mindwtr-sync.json',
            localHash: 'local-hash',
            incomingHash: 'incoming-hash',
        };

        const result = await SyncService.resolveExternalSyncChange('keep-local');

        expect(result).toEqual({ success: false, error: 'disk full' });
        expect((SyncService as any).fileWriteIgnoreActive).toBe(false);
        expect((SyncService as any).ignoreFileEventsUntil).toBe(11_000);
        getMonotonicNowSpy.mockRestore();
    });

    it('bounds Dropbox authorization retries to one forced refresh', async () => {
        const resolveAccessToken = vi.fn(async (forceRefresh = false) => forceRefresh ? 'token-2' : 'token-1');
        const operation = vi.fn(async () => {
            throw new DropboxUnauthorizedError('Dropbox upload failed: HTTP 401');
        });

        await expect((SyncService as any).runDropboxWithRetry(resolveAccessToken, operation))
            .rejects
            .toBeInstanceOf(DropboxUnauthorizedError);

        expect(resolveAccessToken).toHaveBeenNthCalledWith(1, false);
        expect(resolveAccessToken).toHaveBeenNthCalledWith(2, true);
        expect(resolveAccessToken).toHaveBeenCalledTimes(2);
        expect(operation).toHaveBeenNthCalledWith(1, 'token-1');
        expect(operation).toHaveBeenNthCalledWith(2, 'token-2');
        expect(operation).toHaveBeenCalledTimes(2);
    });
});

describe('SyncService orchestration', () => {
    const createDeferred = <T = void>() => {
        let resolve!: (value: T | PromiseLike<T>) => void;
        let reject!: (reason?: unknown) => void;
        const promise = new Promise<T>((nextResolve, nextReject) => {
            resolve = nextResolve;
            reject = nextReject;
        });
        return { promise, resolve, reject };
    };

    const countInFlightStarts = (snapshots: Array<ReturnType<typeof SyncService.getSyncStatus>>) => (
        snapshots.reduce((count, snapshot, index) => {
            const previous = snapshots[index - 1];
            if (!previous?.inFlight && snapshot.inFlight) {
                return count + 1;
            }
            return count;
        }, 0)
    );

    it('re-runs a queued sync cycle after the in-flight sync finishes', async () => {
        const firstRun = createDeferred();
        const backendSpy = vi.spyOn(SyncService as any, 'getSyncBackend');
        let backendCalls = 0;
        backendSpy.mockImplementation(async () => {
            backendCalls += 1;
            if (backendCalls === 1) {
                await firstRun.promise;
            }
            return 'off';
        });
        const snapshots: Array<ReturnType<typeof SyncService.getSyncStatus>> = [];
        const unsubscribe = SyncService.subscribeSyncStatus((status) => {
            snapshots.push({ ...status });
        });

        const first = SyncService.performSync();
        await waitForAssertion(() => {
            expect(SyncService.getSyncStatus()).toMatchObject({
                inFlight: true,
                queued: false,
            });
        });
        const second = SyncService.performSync();
        await waitForAssertion(() => {
            expect(SyncService.getSyncStatus()).toMatchObject({
                inFlight: true,
                queued: true,
            });
        });
        firstRun.resolve();

        const [firstResult, secondResult] = await Promise.all([first, second]);
        expect(firstResult.success).toBe(true);
        expect(secondResult.success).toBe(true);
        await waitForAssertion(() => {
            expect(SyncService.getSyncStatus()).toMatchObject({
                inFlight: false,
                queued: false,
                lastResult: 'success',
            });
            expect(countInFlightStarts(snapshots)).toBe(2);
        });
        unsubscribe();

        expect(snapshots.some((status) => status.queued === true)).toBe(true);
    });

    it('queues an additional follow-up when a new request lands during the queued rerun', async () => {
        const firstRun = createDeferred();
        const secondRun = createDeferred();
        const backendSpy = vi.spyOn(SyncService as any, 'getSyncBackend');
        let backendCalls = 0;
        backendSpy.mockImplementation(async () => {
            backendCalls += 1;
            if (backendCalls === 1) {
                await firstRun.promise;
            } else if (backendCalls === 2) {
                await secondRun.promise;
            }
            return 'off';
        });
        const snapshots: Array<ReturnType<typeof SyncService.getSyncStatus>> = [];
        const unsubscribe = SyncService.subscribeSyncStatus((status) => {
            snapshots.push({ ...status });
        });

        const first = SyncService.performSync();
        await waitForAssertion(() => {
            expect(SyncService.getSyncStatus()).toMatchObject({
                inFlight: true,
                queued: false,
            });
        });
        const second = SyncService.performSync();
        await waitForAssertion(() => {
            expect(SyncService.getSyncStatus()).toMatchObject({
                inFlight: true,
                queued: true,
            });
        });
        firstRun.resolve();
        await waitForAssertion(() => {
            expect(backendCalls).toBeGreaterThanOrEqual(2);
            expect(SyncService.getSyncStatus().inFlight).toBe(true);
        });
        const third = SyncService.performSync();
        await waitForAssertion(() => {
            expect(SyncService.getSyncStatus()).toMatchObject({
                inFlight: true,
                queued: true,
            });
        });
        secondRun.resolve();

        const [firstResult, secondResult, thirdResult] = await Promise.all([first, second, third]);
        expect(firstResult.success).toBe(true);
        expect(secondResult.success).toBe(true);
        expect(thirdResult.success).toBe(true);
        await waitForAssertion(() => {
            expect(SyncService.getSyncStatus()).toMatchObject({
                inFlight: false,
                queued: false,
                lastResult: 'success',
            });
            expect(countInFlightStarts(snapshots)).toBe(3);
        });
        unsubscribe();
    });

    it('emits queued status updates while a sync is already in flight', async () => {
        const firstRun = createDeferred();
        const backendSpy = vi.spyOn(SyncService as any, 'getSyncBackend');
        let backendCalls = 0;
        backendSpy.mockImplementation(async () => {
            backendCalls += 1;
            if (backendCalls === 1) {
                await firstRun.promise;
            }
            return 'off';
        });

        const snapshots: Array<ReturnType<typeof SyncService.getSyncStatus>> = [];
        const unsubscribe = SyncService.subscribeSyncStatus((status) => {
            snapshots.push({ ...status });
        });

        const first = SyncService.performSync();
        await waitForAssertion(() => {
            expect(SyncService.getSyncStatus()).toMatchObject({
                inFlight: true,
                queued: false,
            });
        });
        const second = SyncService.performSync();
        await waitForAssertion(() => {
            expect(SyncService.getSyncStatus()).toMatchObject({
                inFlight: true,
                queued: true,
            });
        });
        firstRun.resolve();
        await Promise.all([first, second]);
        await waitForAssertion(() => {
            expect(SyncService.getSyncStatus()).toMatchObject({
                inFlight: false,
                queued: false,
                lastResult: 'success',
            });
        });
        unsubscribe();

        expect(snapshots.some((status) => status.inFlight === true)).toBe(true);
        expect(snapshots.some((status) => status.queued === true)).toBe(true);
    });

    it('serializes re-entrant sync calls triggered by sync status listeners', async () => {
        const firstRun = createDeferred();
        const backendSpy = vi.spyOn(SyncService as any, 'getSyncBackend');
        backendSpy.mockImplementation(async () => {
            await firstRun.promise;
            return 'off';
        });
        const snapshots: Array<ReturnType<typeof SyncService.getSyncStatus>> = [];
        const unsubscribeSnapshots = SyncService.subscribeSyncStatus((status) => {
            snapshots.push({ ...status });
        });

        let triggered = false;
        const unsubscribe = SyncService.subscribeSyncStatus((status) => {
            if (status.inFlight && !triggered) {
                triggered = true;
                void SyncService.performSync().catch(() => undefined);
            }
        });

        const resultPromise = SyncService.performSync();
        await waitForAssertion(() => {
            expect(triggered).toBe(true);
            expect(SyncService.getSyncStatus()).toMatchObject({
                inFlight: true,
                queued: true,
            });
        });
        firstRun.resolve();
        const result = await resultPromise;
        await waitForAssertion(() => {
            expect(SyncService.getSyncStatus()).toMatchObject({
                inFlight: false,
                queued: false,
                lastResult: 'success',
            });
            expect(countInFlightStarts(snapshots)).toBe(2);
        });
        unsubscribe();
        unsubscribeSnapshots();

        expect(result.success).toBe(true);
        expect(snapshots.some((status) => status.queued === true)).toBe(true);
    });

    it('runs a queued follow-up sync after an in-flight failure', async () => {
        const firstRun = createDeferred();
        const backendSpy = vi.spyOn(SyncService as any, 'getSyncBackend');
        let backendCalls = 0;
        backendSpy.mockImplementation(async () => {
            backendCalls += 1;
            if (backendCalls === 1) {
                await firstRun.promise;
                throw new Error('temporary backend failure');
            }
            return 'off';
        });

        const first = SyncService.performSync();
        await waitForAssertion(() => {
            expect(SyncService.getSyncStatus()).toMatchObject({
                inFlight: true,
                queued: false,
            });
        });
        const second = SyncService.performSync();
        await waitForAssertion(() => {
            expect(SyncService.getSyncStatus()).toMatchObject({
                inFlight: true,
                queued: true,
            });
        });
        firstRun.resolve();
        const [firstResult, secondResult] = await Promise.all([first, second]);

        expect(firstResult.success).toBe(false);
        expect(secondResult.success).toBe(false);

        await waitForAssertion(() => {
            expect(SyncService.getSyncStatus()).toMatchObject({
                inFlight: false,
                queued: false,
                lastResult: 'success',
            });
        });
    });

    it('does not advance the last successful local change marker if sync status persistence fails', async () => {
        const updateSettings = vi.fn(async () => {
            throw new Error('disk full');
        });
        const storeState = {
            lastDataChangeAt: 123,
            updateSettings,
        };
        __syncServiceTestUtils.setDependenciesForTests({
            getStoreState: () => storeState as any,
            logWarn: vi.fn(async () => undefined) as any,
        });

        const persisted = await (SyncService as any).persistSuccessfulSyncStatus(
            'success',
            '2026-04-01T00:00:00.000Z'
        );

        expect(persisted).toBe(false);
        expect(updateSettings).toHaveBeenCalledTimes(1);
        expect((SyncService as any).lastSuccessfulSyncLocalChangeAt).toBe(0);
    });
});
