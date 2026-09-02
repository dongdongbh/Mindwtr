import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    runAfterStoreWriteLock,
    runDataTransferTransactionWithoutSnapshot,
    runSerializedSyncDocumentOperation,
    SyncFileLockBusyError,
    SyncRemoteWriteConflict,
    type AppData,
    type Attachment,
} from '@mindwtr/core';
import { DropboxUnauthorizedError } from './dropbox-sync';
import {
    fallbackHashString,
    getFileSyncDir,
    hashString,
    normalizeSyncBackend,
    type SyncBackend,
} from './sync-service-utils';
import {
    CLOUD_ALLOW_INSECURE_HTTP_KEY,
    CLOUD_PROVIDER_KEY,
    CLOUD_REMEMBER_TOKEN_KEY,
    CLOUD_TOKEN_KEY,
    CLOUD_URL_KEY,
    SYNC_BACKEND_KEY,
    WEBDAV_ALLOW_INSECURE_HTTP_KEY,
    WEBDAV_ALLOW_WEAK_FINGERPRINT_KEY,
    WEBDAV_PASSWORD_KEY,
    WEBDAV_URL_KEY,
    WEBDAV_USERNAME_KEY,
} from './sync-service-config';
import { useUiStore } from '../store/ui-store';
import { WEBDAV_CAPABILITY_PROOF_STORAGE_KEY } from './webdav-capability-proof';

const markLocalWriteMock = vi.hoisted(() => vi.fn());
const markLocalSqliteWriteMock = vi.hoisted(() => vi.fn());

// #1119 follow-up: `hasAttachmentSyncWork` asks `attachment-reference` where the managed
// attachments dir is, which is one Tauri IPC and resolves to null outside the desktop shell.
// Only that lookup is stubbed — `isExternalFileReference`, the rule being tested, is the real
// one.
const MANAGED_ATTACHMENTS_DIR = '/app-data/mindwtr/attachments/';
vi.mock('./attachment-reference', async (importOriginal) => ({
    ...await importOriginal<typeof import('./attachment-reference')>(),
    loadManagedAttachmentsDirPrefix: vi.fn(async () => '/app-data/mindwtr/attachments/'),
}));

import {
    clearAttachmentPresenceStamp,
    markAttachmentPresenceReconciled,
} from './attachment-presence-scope';
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

const ACTIVE_TRANSFER_EVENTS = [
    'transfer:flush',
    'transfer:read',
    'transfer:persist:start',
] as const;

const emptyAppData = (): AppData => ({
    tasks: [],
    projects: [],
    sections: [],
    areas: [],
    settings: {},
});

const startBlockedDataTransfer = async (events: string[], operation: string) => {
    const currentData = emptyAppData();
    let releaseTransfer!: () => void;
    const transferBarrier = new Promise<void>((resolve) => {
        releaseTransfer = resolve;
    });
    const transfer = runDataTransferTransactionWithoutSnapshot({
        operation,
        flushPendingSave: async () => {
            events.push('transfer:flush');
        },
        getCurrentChangeAt: () => 0,
        readCurrentData: async () => {
            events.push('transfer:read');
            return currentData;
        },
        apply: async (data) => ({ data, result: undefined }),
        persistData: async () => {
            events.push('transfer:persist:start');
            await transferBarrier;
            events.push('transfer:persist:end');
        },
        refreshData: async () => {
            events.push('transfer:refresh');
        },
    });
    await waitForAssertion(() => expect(events).toEqual(ACTIVE_TRANSFER_EVENTS));
    return { currentData, releaseTransfer, transfer };
};

const waitForResolutionToRemainBlocked = async (
    resolutionFlushStarted: Promise<void>,
): Promise<void> => {
    const resolutionState = await Promise.race([
        resolutionFlushStarted.then(() => 'started' as const),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 0)),
    ]);
    expect(resolutionState).toBe('blocked');
};

const setPendingExternalSyncChangeForTests = () => {
    (SyncService as any).didMigrate = true;
    (SyncService as any).pendingExternalSyncChange = {
        path: '/tmp/mindwtr-sync.json',
        localHash: 'local-hash',
        incomingHash: 'incoming-hash',
    };
};

afterEach(async () => {
    __syncServiceTestUtils.resetDependenciesForTests();
    await SyncService.resetForTests();
    localStorage.clear();
    sessionStorage.clear();
});

describe('covered local snapshot', () => {
    const dataWithSettings = (settings: AppData['settings']): AppData => ({
        tasks: [],
        projects: [],
        sections: [],
        areas: [],
        people: [],
        settings,
    });

    it('rejects coverage when a device-local setting changed mid-cycle (#316)', () => {
        __syncServiceTestUtils.setDependenciesForTests({
            getStoreState: () => ({ lastDataChangeAt: 5 }) as any,
            getInMemoryAppDataSnapshot: () => dataWithSettings({ filters: { areaIds: ['area-2'] } }),
        });

        const covered = (SyncService as any).isCoveredLocalSnapshot(
            dataWithSettings({ filters: { areaIds: ['area-1'] } }),
        );

        expect(covered).toBe(false);
    });

    it('rejects coverage when the proxy changed mid-cycle', () => {
        __syncServiceTestUtils.setDependenciesForTests({
            getStoreState: () => ({ lastDataChangeAt: 5 }) as any,
            getInMemoryAppDataSnapshot: () => dataWithSettings({
                network: { proxyUrl: 'http://proxy-two.local:8080' },
            }),
        });

        const covered = (SyncService as any).isCoveredLocalSnapshot(
            dataWithSettings({ network: { proxyUrl: 'http://proxy-one.local:8080' } }),
        );

        expect(covered).toBe(false);
    });

    it('accepts coverage when the mid-cycle change left settings identical', () => {
        __syncServiceTestUtils.setDependenciesForTests({
            getStoreState: () => ({ lastDataChangeAt: 5 }) as any,
            getInMemoryAppDataSnapshot: () => dataWithSettings({ filters: { areaIds: ['area-1'] } }),
        });

        const covered = (SyncService as any).isCoveredLocalSnapshot(
            dataWithSettings({ filters: { areaIds: ['area-1'] }, lastSyncStatus: 'success' }),
        );

        expect(covered).toBe(true);
    });
});

describe('sync-service test utils', () => {
    it('serializes desktop sync document work with imports and restores', async () => {
        const events: string[] = [];
        let releaseTransfer!: () => void;
        const transferBarrier = new Promise<void>((resolve) => {
            releaseTransfer = resolve;
        });
        const transfer = runSerializedSyncDocumentOperation(async () => {
            events.push('transfer:start');
            await transferBarrier;
            events.push('transfer:end');
        });
        await waitForAssertion(() => expect(events).toEqual(['transfer:start']));

        const sync = __syncServiceTestUtils.runSyncDocumentExclusiveForTests(async () => {
            events.push('sync');
        });
        await Promise.resolve();
        expect(events).toEqual(['transfer:start']);

        releaseTransfer();
        await Promise.all([transfer, sync]);
        expect(events).toEqual(['transfer:start', 'transfer:end', 'sync']);
    });

    it('waits for an active data transfer before applying an external file replacement', async () => {
        const events: string[] = [];
        const { currentData, releaseTransfer, transfer } = await startBlockedDataTransfer(
            events,
            'test import',
        );
        const externalData = {
            ...currentData,
            tasks: [{
                id: 'external-task',
                title: 'External task',
                status: 'next' as const,
                tags: [],
                contexts: [],
                createdAt: '2026-08-09T12:00:00.000Z',
                updatedAt: '2026-08-09T12:00:00.000Z',
            }],
        } satisfies AppData;
        const fetchData = vi.fn(async () => {
            events.push('resolution:refresh');
        });
        let markResolutionFlushStarted!: () => void;
        const resolutionFlushStarted = new Promise<void>((resolve) => {
            markResolutionFlushStarted = resolve;
        });
        const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'get_sync_backend') return 'file';
            if (command === 'acquire_file_sync_lease') return 'external-resolution-lease';
            if (command === 'read_sync_file') {
                expect(args?.leaseToken).toBe('external-resolution-lease');
                events.push('resolution:read-external');
                return externalData;
            }
            if (command === 'release_file_sync_lease') {
                expect(args?.token).toBe('external-resolution-lease');
                return undefined;
            }
            if (command === 'save_data') {
                events.push('resolution:save-external');
                return args?.data;
            }
            throw new Error(`unexpected command: ${command}`);
        });
        __syncServiceTestUtils.setDependenciesForTests({
            flushPendingSave: vi.fn(async () => {
                events.push('resolution:flush');
                markResolutionFlushStarted();
            }),
            getStoreState: () => ({
                fetchData,
                lastDataChangeAt: 0,
                settings: {},
            }) as any,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
            isTauriRuntime: () => true,
            markLocalSqliteWrite: vi.fn(),
            markLocalWrite: vi.fn(),
        });
        setPendingExternalSyncChangeForTests();

        const resolution = SyncService.resolveExternalSyncChange('use-external');
        try {
            await waitForResolutionToRemainBlocked(resolutionFlushStarted);
            expect(events).toEqual(ACTIVE_TRANSFER_EVENTS);

            releaseTransfer();
            await transfer;
            await expect(resolution).resolves.toEqual({ success: true });
            expect(events).toEqual([
                'transfer:flush',
                'transfer:read',
                'transfer:persist:start',
                'transfer:persist:end',
                'transfer:refresh',
                'resolution:flush',
                'resolution:read-external',
                'resolution:save-external',
                'resolution:refresh',
            ]);
        } finally {
            releaseTransfer();
            await Promise.allSettled([transfer, resolution]);
        }
    });

    it('blocks ordinary store writes through external exact replacement persistence', async () => {
        const events: string[] = [];
        let releaseExternalRead!: () => void;
        const externalReadBarrier = new Promise<void>((resolve) => {
            releaseExternalRead = resolve;
        });
        let markExternalReadStarted!: () => void;
        const externalReadStarted = new Promise<void>((resolve) => {
            markExternalReadStarted = resolve;
        });
        const externalData = emptyAppData();
        const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'get_sync_backend') return 'file';
            if (command === 'acquire_file_sync_lease') return 'external-resolution-lease';
            if (command === 'read_sync_file') {
                expect(args?.leaseToken).toBe('external-resolution-lease');
                events.push('resolution:read:start');
                markExternalReadStarted();
                await externalReadBarrier;
                events.push('resolution:read:end');
                return externalData;
            }
            if (command === 'release_file_sync_lease') {
                expect(args?.token).toBe('external-resolution-lease');
                return undefined;
            }
            if (command === 'save_data') {
                events.push('resolution:persist');
                return args?.data;
            }
            throw new Error(`unexpected command: ${command}`);
        });
        __syncServiceTestUtils.setDependenciesForTests({
            flushPendingSave: vi.fn(async () => undefined),
            getStoreState: () => ({
                fetchData: vi.fn(async () => undefined),
                lastDataChangeAt: 0,
                settings: {},
            }) as any,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
            isTauriRuntime: () => true,
            markLocalSqliteWrite: vi.fn(),
            markLocalWrite: vi.fn(),
        });
        setPendingExternalSyncChangeForTests();

        const resolution = SyncService.resolveExternalSyncChange('use-external');
        await externalReadStarted;
        const ordinaryWrite = runAfterStoreWriteLock(async () => {
            events.push('ordinary:write');
        });
        await Promise.resolve();
        const eventsBeforeRelease = [...events];

        releaseExternalRead();
        await expect(resolution).resolves.toEqual({ success: true });
        await ordinaryWrite;
        expect(eventsBeforeRelease).toEqual(['resolution:read:start']);
        expect(events).toEqual([
            'resolution:read:start',
            'resolution:read:end',
            'resolution:persist',
            'ordinary:write',
        ]);
    });

    it('waits for an active data transfer before keeping the local sync file', async () => {
        const events: string[] = [];
        const { currentData, releaseTransfer, transfer } = await startBlockedDataTransfer(
            events,
            'test restore',
        );

        let markResolutionFlushStarted!: () => void;
        const resolutionFlushStarted = new Promise<void>((resolve) => {
            markResolutionFlushStarted = resolve;
        });
        const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'get_sync_backend') return 'file';
            if (command === 'acquire_file_sync_lease') {
                events.push('resolution:lease:acquire');
                return 'lease-token';
            }
            if (command === 'release_file_sync_lease') {
                expect(args?.token).toBe('lease-token');
                events.push('resolution:lease:release');
                return undefined;
            }
            if (command === 'get_data') {
                events.push('resolution:read-local');
                return currentData;
            }
            if (command === 'write_sync_file') {
                expect(args?.leaseToken).toBe('lease-token');
                events.push('resolution:write-sync-file');
                return true;
            }
            throw new Error(`unexpected command: ${command}`);
        });
        __syncServiceTestUtils.setDependenciesForTests({
            flushPendingSave: vi.fn(async () => {
                events.push('resolution:flush');
                markResolutionFlushStarted();
            }),
            getExternalCalendars: vi.fn(async () => []),
            getStoreState: () => ({
                lastDataChangeAt: 0,
                setError: vi.fn(),
                settings: {},
            }) as any,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
            isTauriRuntime: () => true,
        });
        setPendingExternalSyncChangeForTests();
        const performSyncSpy = vi.spyOn(SyncService, 'performSync').mockImplementation(() => (
            runSerializedSyncDocumentOperation(async () => {
                events.push('follow-up:sync');
                return { success: true };
            })
        ));

        const resolution = SyncService.resolveExternalSyncChange('keep-local');
        try {
            await waitForResolutionToRemainBlocked(resolutionFlushStarted);
            expect(events).toEqual(ACTIVE_TRANSFER_EVENTS);

            releaseTransfer();
            await transfer;
            await expect(resolution).resolves.toEqual({ success: true });
            expect(events).toEqual([
                'transfer:flush',
                'transfer:read',
                'transfer:persist:start',
                'transfer:persist:end',
                'transfer:refresh',
                'resolution:lease:acquire',
                'resolution:flush',
                'resolution:read-local',
                'resolution:write-sync-file',
                'resolution:lease:release',
                'follow-up:sync',
            ]);
        } finally {
            releaseTransfer();
            await Promise.allSettled([transfer, resolution]);
            performSyncSpy.mockRestore();
        }
    });

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
    const createTestWebdavCapabilityFetch = (documentBody: string | null = '{}') => {
        let probeBytes: Uint8Array | null = null;
        let probeVersion = 0;
        const methods: string[] = [];
        const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method ?? 'GET';
            const headers = new Headers(init?.headers);
            methods.push(method);
            if (!url.includes('.mindwtr-etag-probe-')) {
                if (method !== 'GET') throw new Error(`unexpected document ${method}`);
                if (documentBody === null) return new Response(null, { status: 404 });
                return new Response(documentBody, { status: 200, headers: { etag: '"document-v1"' } });
            }
            if (method === 'GET') {
                if (!probeBytes) return new Response(null, { status: 404 });
                return new Response(probeBytes.slice().buffer, {
                    status: 200,
                    headers: { etag: `"probe-v${probeVersion}"` },
                });
            }
            if (method === 'PUT') {
                const body = init?.body;
                if (!(body instanceof Uint8Array)) throw new Error('expected byte-array probe body');
                const currentEtag = probeBytes ? `"probe-v${probeVersion}"` : null;
                if (probeBytes && headers.get('if-none-match') === '*') {
                    return new Response(null, { status: 412 });
                }
                if (probeBytes && headers.has('if-match') && headers.get('if-match') !== currentEtag) {
                    return new Response(null, { status: 412 });
                }
                probeBytes = new Uint8Array(body);
                probeVersion += 1;
                return new Response(null, { status: currentEtag ? 204 : 201 });
            }
            if (method === 'DELETE') {
                if (!probeBytes || headers.get('if-match') !== `"probe-v${probeVersion}"`) {
                    return new Response(null, { status: 412 });
                }
                probeBytes = null;
                return new Response(null, { status: 204 });
            }
            throw new Error(`unexpected ${method}`);
        });
        return { fetchSpy, methods };
    };

    it('retains one opaque Dropbox credential handle until its matching recovery completes', () => {
        const listener = vi.fn();
        const unsubscribe = SyncService.subscribePendingDropboxCredentialHandleForSession(listener);

        SyncService.rememberPendingDropboxCredentialHandleForSession('opaque-candidate-handle');
        expect(SyncService.getPendingDropboxCredentialHandleForSession()).toBe('opaque-candidate-handle');
        expect(() => {
            SyncService.rememberPendingDropboxCredentialHandleForSession('different-candidate-handle');
        }).toThrow('must be resolved');

        SyncService.forgetPendingDropboxCredentialHandleForSession('different-candidate-handle');
        expect(SyncService.getPendingDropboxCredentialHandleForSession()).toBe('opaque-candidate-handle');

        SyncService.forgetPendingDropboxCredentialHandleForSession('opaque-candidate-handle');
        expect(SyncService.getPendingDropboxCredentialHandleForSession()).toBeNull();
        expect(listener.mock.calls).toEqual([
            [null],
            ['opaque-candidate-handle'],
            [null],
        ]);
        unsubscribe();
    });

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
            backend: null,
        });
        expect((SyncService as any).syncListeners.size).toBe(0);
        expect((SyncService as any).syncOrchestrator.getState()).toEqual({
            inFlight: false,
            queued: false,
        });
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

    it('proves a legacy persisted WebDAV backend before any sync-document IO', async () => {
        localStorage.setItem(SYNC_BACKEND_KEY, 'webdav');
        localStorage.setItem(WEBDAV_URL_KEY, 'https://sync.example.com');
        localStorage.setItem(WEBDAV_USERNAME_KEY, 'alice');
        localStorage.setItem(WEBDAV_ALLOW_INSECURE_HTTP_KEY, 'false');
        sessionStorage.setItem(WEBDAV_PASSWORD_KEY, 'secret');
        const performSyncCycleMock = vi.fn();
        const capabilityProbe = vi.spyOn(SyncService as any, 'probeWebDavCompatibility')
            .mockRejectedValue(
                new Error('SYNC_ENCRYPTION_REMOTE_VERSION_UNAVAILABLE: conditional writes unavailable'),
            );
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => false,
            flushPendingSave: vi.fn(async () => undefined),
            getInMemoryAppDataSnapshot: () => emptyAppData(),
            getStoreState: () => ({
                fetchData: vi.fn(async () => undefined),
                lastDataChangeAt: 0,
                settings: {},
                setError: vi.fn(),
                updateSettings: vi.fn(async () => undefined),
            }) as any,
            performSyncCycle: performSyncCycleMock as any,
        });

        try {
            await expect(SyncService.performSync({ manual: true })).resolves.toMatchObject({
                success: false,
                error: expect.stringContaining('conditional writes unavailable'),
            });
            expect(capabilityProbe).toHaveBeenCalledWith(
                expect.objectContaining({
                    url: 'https://sync.example.com',
                    username: 'alice',
                    password: 'secret',
                }),
                true,
            );
            expect(performSyncCycleMock).not.toHaveBeenCalled();
            expect(localStorage.getItem(WEBDAV_CAPABILITY_PROOF_STORAGE_KEY)).toBeNull();
        } finally {
            capabilityProbe.mockRestore();
        }
    });

    it('persists the cloud provider natively with exact readback before retiring legacy renderer state', async () => {
        let nativeProvider = 'selfhosted';
        const events: string[] = [];
        localStorage.setItem('mindwtr-cloud-provider', 'selfhosted');
        const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'recover_dropbox_credentials_before_sync_configuration') return true;
            if (command === 'set_sync_cloud_provider') {
                events.push(`set:${localStorage.getItem('mindwtr-cloud-provider')}`);
                nativeProvider = String(args?.provider);
                return true;
            }
            if (command === 'get_sync_cloud_provider') {
                events.push(`get:${localStorage.getItem('mindwtr-cloud-provider')}`);
                return nativeProvider;
            }
            return undefined;
        });
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
        });
        (SyncService as any).didMigrate = true;

        await SyncService.setCloudProvider('dropbox');

        expect(events).toEqual(['set:selfhosted', 'get:selfhosted']);
        expect(localStorage.getItem(CLOUD_PROVIDER_KEY)).toBeNull();
        await expect(SyncService.getCloudProvider()).resolves.toBe('dropbox');
    });

    it('rejects a cloud-provider write whose native readback disagrees and preserves the renderer cache', async () => {
        localStorage.setItem('mindwtr-cloud-provider', 'selfhosted');
        const invoke = vi.fn(async (command: string) => {
            if (command === 'recover_dropbox_credentials_before_sync_configuration') return true;
            if (command === 'set_sync_cloud_provider') return true;
            if (command === 'get_sync_cloud_provider') return 'selfhosted';
            return undefined;
        });
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
        });
        (SyncService as any).didMigrate = true;

        await expect(SyncService.setCloudProvider('dropbox')).rejects.toThrow(
            'Cloud sync provider did not persist correctly',
        );
        expect(localStorage.getItem(CLOUD_PROVIDER_KEY)).toBe('selfhosted');
    });

    it('migrates File sync without consulting an unavailable dormant Cloud authority (#1035, #1036)', async () => {
        localStorage.setItem(SYNC_BACKEND_KEY, 'file');
        localStorage.setItem(WEBDAV_URL_KEY, 'https://legacy-webdav.example.com');
        localStorage.setItem(WEBDAV_USERNAME_KEY, 'legacy-user');
        sessionStorage.setItem(WEBDAV_PASSWORD_KEY, 'legacy-password');
        let nativeWebdav = {
            url: '',
            username: '',
            password: '',
            hasPassword: false,
            allowInsecureHttp: false,
            allowWeakFingerprint: true,
        };
        const nativeSnapshot = () => ({
            backend: 'file' as const,
            syncPath: '/home/alice/Sync/Mindwtr',
            cloudProvider: 'selfhosted' as const,
            cloudProviderAuthority: 'uninitialized' as const,
            webdav: {
                ...nativeWebdav,
                password: nativeWebdav.hasPassword ? nativeWebdav.password : null,
                passwordAuthority: nativeWebdav.hasPassword ? 'known' as const : 'opaque' as const,
                hasPassword: nativeWebdav.hasPassword ? true : null,
            },
            cloud: {
                url: '',
                token: null,
                tokenAuthority: 'opaque' as const,
                allowInsecureHttp: false,
                rememberToken: false,
            },
        });
        const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'recover_dropbox_credentials_before_sync_configuration') return true;
            if (command === 'get_sync_configuration_snapshot') return nativeSnapshot();
            if (command === 'set_webdav_config') {
                nativeWebdav = {
                    url: String(args?.url ?? ''),
                    username: String(args?.username ?? ''),
                    password: String(args?.password ?? ''),
                    hasPassword: Boolean(args?.password),
                    allowInsecureHttp: args?.allowInsecureHttp === true,
                    allowWeakFingerprint: args?.allowWeakFingerprint !== false,
                };
                return undefined;
            }
            if (command === 'get_webdav_config') return nativeWebdav;
            if (command === 'get_cloud_config') {
                throw new Error('cloud credential authority is unavailable');
            }
            throw new Error(`Unexpected command: ${command}`);
        });
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
        });

        await expect(SyncService.getPersistedSyncConfigurationSnapshot()).resolves.toMatchObject({
            backend: 'file',
            syncPath: '/home/alice/Sync/Mindwtr',
        });
        expect(invoke.mock.calls.some(([command]) => command === 'get_cloud_config')).toBe(false);
        expect(nativeWebdav).toMatchObject({
            url: 'https://legacy-webdav.example.com',
            username: 'legacy-user',
            password: 'legacy-password',
        });
        expect(localStorage.getItem(SYNC_BACKEND_KEY)).toBeNull();
        expect(localStorage.getItem(WEBDAV_URL_KEY)).toBeNull();
        expect(sessionStorage.getItem(WEBDAV_PASSWORD_KEY)).toBeNull();
    });

    it('finishes provider-only legacy migration before returning the native configuration snapshot', async () => {
        let nativeProvider: 'selfhosted' | 'dropbox' = 'selfhosted';
        let providerAuthority: 'uninitialized' | 'native' = 'uninitialized';
        let releaseProviderWrite!: () => void;
        const events: string[] = [];
        localStorage.setItem(CLOUD_PROVIDER_KEY, 'dropbox');

        const nativeSnapshot = () => ({
            backend: 'cloud' as const,
            syncPath: '',
            cloudProvider: nativeProvider,
            cloudProviderAuthority: providerAuthority,
            webdav: {
                url: '',
                username: '',
                password: null,
                passwordAuthority: 'opaque' as const,
                hasPassword: null,
                allowInsecureHttp: false,
                allowWeakFingerprint: true,
            },
            cloud: {
                url: '',
                token: null,
                tokenAuthority: 'opaque' as const,
                allowInsecureHttp: false,
                rememberToken: false,
            },
        });
        const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
            events.push(command);
            if (command === 'recover_dropbox_credentials_before_sync_configuration') return true;
            if (command === 'get_sync_backend') return 'cloud';
            if (command === 'get_webdav_config') {
                return { url: '', username: '', hasPassword: false, allowInsecureHttp: false };
            }
            if (command === 'get_cloud_config') {
                return { url: '', token: '', allowInsecureHttp: false };
            }
            if (command === 'get_sync_cloud_provider_state') {
                return { provider: nativeProvider, authority: providerAuthority };
            }
            if (command === 'set_sync_cloud_provider') {
                await new Promise<void>((resolve) => {
                    releaseProviderWrite = resolve;
                });
                nativeProvider = args?.provider as typeof nativeProvider;
                providerAuthority = 'native';
                return true;
            }
            if (command === 'get_sync_configuration_snapshot') return nativeSnapshot();
            return undefined;
        });
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
        });

        const snapshotPromise = SyncService.getPersistedSyncConfigurationSnapshot();
        await waitForAssertion(() => expect(events).toContain('set_sync_cloud_provider'));
        expect(events.filter((event) => event === 'get_sync_configuration_snapshot')).toHaveLength(1);

        releaseProviderWrite();
        await expect(snapshotPromise).resolves.toMatchObject({
            backend: 'cloud',
            cloudProvider: 'dropbox',
        });
        expect(localStorage.getItem(CLOUD_PROVIDER_KEY)).toBeNull();
        expect(events[0]).toBe('recover_dropbox_credentials_before_sync_configuration');
        expect(events.indexOf('recover_dropbox_credentials_before_sync_configuration')).toBeLessThan(
            events.indexOf('set_sync_cloud_provider'),
        );
        expect(events.indexOf('set_sync_cloud_provider')).toBeLessThan(
            events.lastIndexOf('get_sync_configuration_snapshot'),
        );
        expect(events.filter((event) => event === 'get_sync_configuration_snapshot')).toHaveLength(2);
    });

    it('does not read or write native configuration when the migration recovery barrier fails', async () => {
        const events: string[] = [];
        localStorage.setItem(SYNC_BACKEND_KEY, 'cloud');
        localStorage.setItem(CLOUD_PROVIDER_KEY, 'dropbox');
        const invoke = vi.fn(async (command: string) => {
            events.push(command);
            if (command === 'recover_dropbox_credentials_before_sync_configuration') {
                throw new Error('native Dropbox recovery failed');
            }
            throw new Error(`Unexpected command: ${command}`);
        });
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
        });

        await expect(SyncService.getPersistedSyncConfigurationSnapshot()).rejects.toThrow(
            'native Dropbox recovery failed',
        );

        expect(events).toEqual(['recover_dropbox_credentials_before_sync_configuration']);
        expect(localStorage.getItem(SYNC_BACKEND_KEY)).toBe('cloud');
        expect(localStorage.getItem(CLOUD_PROVIDER_KEY)).toBe('dropbox');
    });

    it('makes concurrent native getters await the same provider migration', async () => {
        let nativeProvider: 'selfhosted' | 'dropbox' = 'selfhosted';
        let providerAuthority: 'uninitialized' | 'native' = 'uninitialized';
        let releaseProviderWrite!: () => void;
        let backendResolved = false;
        let providerResolved = false;
        localStorage.setItem(CLOUD_PROVIDER_KEY, 'dropbox');
        const nativeSnapshot = () => ({
            backend: 'cloud' as const,
            syncPath: '',
            cloudProvider: nativeProvider,
            cloudProviderAuthority: providerAuthority,
            webdav: {
                url: '',
                username: '',
                password: null,
                passwordAuthority: 'opaque' as const,
                hasPassword: null,
                allowInsecureHttp: false,
                allowWeakFingerprint: true,
            },
            cloud: {
                url: '',
                token: null,
                tokenAuthority: 'opaque' as const,
                allowInsecureHttp: false,
                rememberToken: false,
            },
        });

        const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'recover_dropbox_credentials_before_sync_configuration') return true;
            if (command === 'get_sync_configuration_snapshot') return nativeSnapshot();
            if (command === 'get_sync_backend') return 'cloud';
            if (command === 'get_webdav_config') {
                return { url: '', username: '', hasPassword: false, allowInsecureHttp: false };
            }
            if (command === 'get_cloud_config') {
                return { url: '', token: '', allowInsecureHttp: false };
            }
            if (command === 'get_sync_cloud_provider_state') {
                return { provider: nativeProvider, authority: providerAuthority };
            }
            if (command === 'set_sync_cloud_provider') {
                await new Promise<void>((resolve) => {
                    releaseProviderWrite = resolve;
                });
                nativeProvider = args?.provider as typeof nativeProvider;
                providerAuthority = 'native';
                return true;
            }
            if (command === 'get_sync_cloud_provider') return nativeProvider;
            return undefined;
        });
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
        });

        const backendPromise = SyncService.getSyncBackend().then((backend) => {
            backendResolved = true;
            return backend;
        });
        const providerPromise = SyncService.getCloudProvider().then((provider) => {
            providerResolved = true;
            return provider;
        });
        await waitForAssertion(() => {
            expect(invoke).toHaveBeenCalledWith('set_sync_cloud_provider', { provider: 'dropbox' });
        });
        expect(backendResolved).toBe(false);
        expect(providerResolved).toBe(false);
        expect(invoke.mock.calls.filter(([command]) => command === 'set_sync_cloud_provider')).toHaveLength(1);

        releaseProviderWrite();
        await expect(Promise.all([backendPromise, providerPromise])).resolves.toEqual(['cloud', 'dropbox']);
        expect(localStorage.getItem(CLOUD_PROVIDER_KEY)).toBeNull();
    });

    it('retains a failed legacy provider migration for a later successful retry', async () => {
        let nativeProvider: 'selfhosted' | 'dropbox' = 'selfhosted';
        let providerAuthority: 'uninitialized' | 'native' = 'uninitialized';
        let shouldFail = true;
        const events: string[] = [];
        const reportError = vi.fn();
        localStorage.setItem(CLOUD_PROVIDER_KEY, 'dropbox');

        const nativeSnapshot = () => ({
            backend: 'cloud' as const,
            syncPath: '',
            cloudProvider: nativeProvider,
            cloudProviderAuthority: providerAuthority,
            webdav: {
                url: '',
                username: '',
                password: null,
                passwordAuthority: 'opaque' as const,
                hasPassword: null,
                allowInsecureHttp: false,
                allowWeakFingerprint: true,
            },
            cloud: {
                url: '',
                token: null,
                tokenAuthority: 'opaque' as const,
                allowInsecureHttp: false,
                rememberToken: false,
            },
        });
        const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
            events.push(command);
            if (command === 'recover_dropbox_credentials_before_sync_configuration') return true;
            if (command === 'get_sync_backend') return 'cloud';
            if (command === 'get_webdav_config') {
                return { url: '', username: '', hasPassword: false, allowInsecureHttp: false };
            }
            if (command === 'get_cloud_config') {
                return { url: '', token: '', allowInsecureHttp: false };
            }
            if (command === 'get_sync_cloud_provider_state') {
                return { provider: nativeProvider, authority: providerAuthority };
            }
            if (command === 'set_sync_cloud_provider') {
                if (shouldFail) throw new Error('native provider unavailable');
                nativeProvider = args?.provider as typeof nativeProvider;
                providerAuthority = 'native';
                return true;
            }
            if (command === 'get_sync_configuration_snapshot') return nativeSnapshot();
            return undefined;
        });
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
            reportError,
        });

        await expect(SyncService.getPersistedSyncConfigurationSnapshot()).rejects.toThrow(
            'native provider unavailable',
        );
        expect(localStorage.getItem(CLOUD_PROVIDER_KEY)).toBe('dropbox');
        expect(events.filter((event) => event === 'get_sync_configuration_snapshot')).toHaveLength(1);
        expect(reportError).toHaveBeenCalledTimes(1);

        shouldFail = false;
        events.length = 0;
        await expect(SyncService.getPersistedSyncConfigurationSnapshot()).resolves.toMatchObject({
            backend: 'cloud',
            cloudProvider: 'dropbox',
        });
        expect(localStorage.getItem(CLOUD_PROVIDER_KEY)).toBeNull();
        expect(events).toContain('get_sync_configuration_snapshot');
        expect(invoke.mock.calls.filter(([command]) => command === 'set_sync_cloud_provider')).toHaveLength(2);
    });

    it('ignores a stale legacy provider once native authority has been established', async () => {
        const events: string[] = [];
        localStorage.setItem(CLOUD_PROVIDER_KEY, 'dropbox');
        const invoke = vi.fn(async (command: string) => {
            events.push(command);
            if (command === 'recover_dropbox_credentials_before_sync_configuration') return true;
            if (command === 'get_sync_backend') return 'cloud';
            if (command === 'get_webdav_config') {
                return { url: '', username: '', hasPassword: false, allowInsecureHttp: false };
            }
            if (command === 'get_cloud_config') {
                return { url: '', token: '', allowInsecureHttp: false };
            }
            if (command === 'get_sync_cloud_provider_state') {
                return { provider: 'selfhosted', authority: 'native' };
            }
            if (command === 'get_sync_configuration_snapshot') {
                return {
                    backend: 'cloud',
                    syncPath: '',
                    cloudProvider: 'selfhosted',
                    cloudProviderAuthority: 'native',
                    webdav: {
                        url: '',
                        username: '',
                        password: null,
                        passwordAuthority: 'opaque',
                        hasPassword: null,
                        allowInsecureHttp: false,
                        allowWeakFingerprint: true,
                    },
                    cloud: {
                        url: '',
                        token: null,
                        tokenAuthority: 'opaque',
                        allowInsecureHttp: false,
                        rememberToken: false,
                    },
                };
            }
            return undefined;
        });
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
        });

        await expect(SyncService.getPersistedSyncConfigurationSnapshot()).resolves.toMatchObject({
            backend: 'cloud',
            cloudProvider: 'selfhosted',
        });
        expect(events).not.toContain('set_sync_cloud_provider');
        expect(localStorage.getItem(CLOUD_PROVIDER_KEY)).toBeNull();
    });

    it('retires every inspected legacy field when populated native state needs no setters', async () => {
        const localLegacyValues: Record<string, string> = {
            [SYNC_BACKEND_KEY]: 'cloud',
            [WEBDAV_URL_KEY]: 'https://legacy-webdav.example.com',
            [WEBDAV_USERNAME_KEY]: 'legacy-user',
            [WEBDAV_PASSWORD_KEY]: 'legacy-local-password',
            [WEBDAV_ALLOW_INSECURE_HTTP_KEY]: 'true',
            [WEBDAV_ALLOW_WEAK_FINGERPRINT_KEY]: 'false',
            [CLOUD_URL_KEY]: 'https://legacy-cloud.example.com',
            [CLOUD_TOKEN_KEY]: 'legacy-local-token',
            [CLOUD_ALLOW_INSECURE_HTTP_KEY]: 'true',
            [CLOUD_REMEMBER_TOKEN_KEY]: 'false',
            [CLOUD_PROVIDER_KEY]: 'dropbox',
        };
        Object.entries(localLegacyValues).forEach(([key, value]) => localStorage.setItem(key, value));
        sessionStorage.setItem(WEBDAV_PASSWORD_KEY, 'legacy-session-password');
        sessionStorage.setItem(CLOUD_TOKEN_KEY, 'legacy-session-token');

        const nativeSnapshot = {
            backend: 'cloud' as const,
            syncPath: '',
            cloudProvider: 'selfhosted' as const,
            cloudProviderAuthority: 'native' as const,
            webdav: {
                url: 'https://native-webdav.example.com',
                username: 'native-user',
                password: null,
                passwordAuthority: 'opaque' as const,
                hasPassword: true,
                allowInsecureHttp: false,
                allowWeakFingerprint: true,
            },
            cloud: {
                url: 'https://native-cloud.example.com',
                token: null,
                tokenAuthority: 'opaque' as const,
                allowInsecureHttp: false,
                rememberToken: false,
            },
        };
        const invoke = vi.fn(async (command: string) => {
            if (command === 'recover_dropbox_credentials_before_sync_configuration') return true;
            if (command === 'get_sync_backend') return nativeSnapshot.backend;
            if (command === 'get_webdav_config') {
                return {
                    url: nativeSnapshot.webdav.url,
                    username: nativeSnapshot.webdav.username,
                    hasPassword: true,
                    allowInsecureHttp: false,
                    allowWeakFingerprint: true,
                };
            }
            if (command === 'get_cloud_config') {
                return {
                    url: nativeSnapshot.cloud.url,
                    token: 'native-token',
                    allowInsecureHttp: false,
                };
            }
            if (command === 'get_sync_cloud_provider_state') {
                return { provider: 'selfhosted', authority: 'native' };
            }
            if (command === 'get_sync_configuration_snapshot') return nativeSnapshot;
            throw new Error(`Unexpected command: ${command}`);
        });
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
        });

        await expect(SyncService.getPersistedSyncConfigurationSnapshot()).resolves.toMatchObject({
            backend: 'cloud',
            cloudProvider: 'selfhosted',
        });

        expect(invoke.mock.calls.some(([command]) => command.startsWith('set_'))).toBe(false);
        Object.keys(localLegacyValues).forEach((key) => expect(localStorage.getItem(key)).toBeNull());
        expect(sessionStorage.getItem(WEBDAV_PASSWORD_KEY)).toBeNull();
        expect(sessionStorage.getItem(CLOUD_TOKEN_KEY)).toBeNull();
    });

    it('migrates a legacy cloud url without replacing a known native token', async () => {
        localStorage.setItem(CLOUD_URL_KEY, 'https://legacy-cloud.example.com');
        localStorage.setItem(CLOUD_ALLOW_INSECURE_HTTP_KEY, 'true');
        let cloudUrl = '';
        let cloudToken = 'native-token';
        const snapshot = () => ({
            backend: 'file' as const,
            syncPath: '',
            cloudProvider: 'selfhosted' as const,
            cloudProviderAuthority: 'native' as const,
            webdav: {
                url: '',
                username: '',
                password: null,
                passwordAuthority: 'opaque' as const,
                hasPassword: null,
                allowInsecureHttp: false,
                allowWeakFingerprint: true,
            },
            cloud: {
                url: cloudUrl,
                token: cloudToken,
                tokenAuthority: 'known' as const,
                allowInsecureHttp: cloudUrl ? true : false,
                rememberToken: false,
            },
        });
        const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'recover_dropbox_credentials_before_sync_configuration') return true;
            if (command === 'get_sync_configuration_snapshot') return snapshot();
            if (command === 'set_cloud_config') {
                cloudUrl = String(args?.url ?? '');
                cloudToken = String(args?.token ?? '');
                return true;
            }
            if (command === 'get_cloud_config') {
                return { url: cloudUrl, token: cloudToken, allowInsecureHttp: true };
            }
            throw new Error(`Unexpected command: ${command}`);
        });
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
        });

        await expect(SyncService.getPersistedSyncConfigurationSnapshot()).resolves.toMatchObject({
            cloud: {
                url: 'https://legacy-cloud.example.com',
                token: 'native-token',
            },
        });
        expect(invoke).toHaveBeenCalledWith('set_cloud_config', {
            url: 'https://legacy-cloud.example.com',
            token: 'native-token',
            allowInsecureHttp: true,
        });
        expect(localStorage.getItem(CLOUD_URL_KEY)).toBeNull();
        expect(localStorage.getItem(CLOUD_ALLOW_INSECURE_HTTP_KEY)).toBeNull();
    });

    it('preserves a non-remembered local legacy token when native provider migration fails', async () => {
        localStorage.setItem(CLOUD_URL_KEY, 'https://legacy-cloud.example.com');
        localStorage.setItem(CLOUD_TOKEN_KEY, 'must-survive-failed-migration');
        localStorage.setItem(CLOUD_REMEMBER_TOKEN_KEY, 'false');
        localStorage.setItem(CLOUD_PROVIDER_KEY, 'dropbox');

        const invoke = vi.fn(async (command: string) => {
            if (command === 'recover_dropbox_credentials_before_sync_configuration') return true;
            if (command === 'get_sync_configuration_snapshot') {
                return {
                    backend: 'cloud',
                    syncPath: '',
                    cloudProvider: 'selfhosted',
                    cloudProviderAuthority: 'uninitialized',
                    webdav: {
                        url: '',
                        username: '',
                        password: null,
                        passwordAuthority: 'opaque',
                        hasPassword: null,
                        allowInsecureHttp: false,
                        allowWeakFingerprint: true,
                    },
                    cloud: {
                        url: 'https://native-cloud.example.com',
                        token: 'native-token',
                        tokenAuthority: 'known',
                        allowInsecureHttp: false,
                        rememberToken: false,
                    },
                };
            }
            if (command === 'get_sync_backend') return 'cloud';
            if (command === 'get_webdav_config') {
                return { url: '', username: '', hasPassword: false, allowInsecureHttp: false, allowWeakFingerprint: true };
            }
            if (command === 'get_cloud_config') {
                return { url: 'https://native-cloud.example.com', token: 'native-token', allowInsecureHttp: false };
            }
            if (command === 'get_sync_cloud_provider_state') {
                return { provider: 'selfhosted', authority: 'uninitialized' };
            }
            if (command === 'set_sync_cloud_provider') throw new Error('native provider unavailable');
            throw new Error(`Unexpected command: ${command}`);
        });
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
        });

        await expect(SyncService.getPersistedSyncConfigurationSnapshot()).rejects.toThrow(
            'native provider unavailable',
        );

        expect(localStorage.getItem(CLOUD_TOKEN_KEY)).toBe('must-survive-failed-migration');
        expect(localStorage.getItem(CLOUD_URL_KEY)).toBe('https://legacy-cloud.example.com');
        expect(localStorage.getItem(CLOUD_REMEMBER_TOKEN_KEY)).toBe('false');
        expect(localStorage.getItem(CLOUD_PROVIDER_KEY)).toBe('dropbox');
        expect(sessionStorage.getItem(CLOUD_TOKEN_KEY)).toBeNull();
    });

    it('commits self-hosted sync from the native provider snapshot after renderer storage is lost', async () => {
        let backend: SyncBackend = 'cloud';
        let nativeProvider: 'selfhosted' | 'dropbox' = 'dropbox';
        let cloudUrl = '';
        let cloudToken = '';
        const events: string[] = [];
        localStorage.removeItem('mindwtr-cloud-provider');
        const snapshot = (args?: Record<string, unknown>) => ({
            backend,
            cloudProvider: nativeProvider,
            syncPath: '',
            webdav: {
                url: '',
                username: '',
                password: null,
                passwordAuthority: 'opaque' as const,
                hasPassword: null,
                allowInsecureHttp: false,
                allowWeakFingerprint: true,
            },
            cloud: args?.requireCloudToken === true
                ? {
                    url: cloudUrl,
                    token: cloudToken,
                    tokenAuthority: 'known' as const,
                    allowInsecureHttp: false,
                    rememberToken: false,
                }
                : {
                    url: cloudUrl,
                    token: null,
                    tokenAuthority: 'opaque' as const,
                    allowInsecureHttp: false,
                    rememberToken: false,
                },
        });
        const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'recover_dropbox_credentials_before_sync_configuration') {
                events.push('dropbox:recover-before-configuration');
                return true;
            }
            if (command === 'get_sync_configuration_snapshot') {
                events.push(args?.requireCloudToken === true ? 'snapshot:strict-cloud' : 'snapshot:tolerant');
                return snapshot(args);
            }
            if (command === 'set_sync_backend') {
                backend = args?.backend as SyncBackend;
                events.push(`backend:${backend}`);
                return undefined;
            }
            if (command === 'set_cloud_config') {
                cloudUrl = String(args?.url ?? '');
                cloudToken = String(args?.token ?? '');
                events.push(`cloud:${cloudUrl}`);
                return undefined;
            }
            if (command === 'set_sync_cloud_provider') {
                nativeProvider = args?.provider as typeof nativeProvider;
                events.push(`provider:${nativeProvider}`);
                return true;
            }
            if (command === 'get_sync_cloud_provider') return nativeProvider;
            return undefined;
        });
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
        });
        (SyncService as any).didMigrate = true;

        await SyncService.commitProvenSyncConfiguration({
            backend: 'cloud',
            cloudProvider: 'selfhosted',
            cloud: {
                url: 'https://new-cloud.example.com',
                token: 'new-cloud-token',
            },
        });

        expect(backend).toBe('cloud');
        expect(nativeProvider).toBe('selfhosted');
        expect(cloudToken).toBe('new-cloud-token');
        expect(localStorage.getItem(CLOUD_PROVIDER_KEY)).toBeNull();
        expect(events[0]).toBe('dropbox:recover-before-configuration');
        expect(events).toContain('snapshot:strict-cloud');
        expect(events.indexOf('provider:selfhosted')).toBeLessThan(events.lastIndexOf('backend:cloud'));
    });

    it('prevents every configuration read and write when native Dropbox recovery fails', async () => {
        const events: string[] = [];
        const invoke = vi.fn(async (command: string) => {
            events.push(command);
            if (command === 'recover_dropbox_credentials_before_sync_configuration') {
                throw new Error('native Dropbox recovery failed');
            }
            return undefined;
        });
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
        });
        (SyncService as any).didMigrate = true;

        await expect(SyncService.commitProvenSyncConfiguration({
            backend: 'file',
            syncPath: '/must-not-write',
        })).rejects.toThrow('native Dropbox recovery failed');

        expect(events).toEqual(['recover_dropbox_credentials_before_sync_configuration']);
    });

    it('holds snapshot restore behind pending saves through the refresh', async () => {
        const events: string[] = [];
        let releaseFlush!: () => void;
        const flushPendingSave = vi.fn(() => {
            events.push('flush');
            return new Promise<void>((resolve) => {
                releaseFlush = resolve;
            });
        });
        const invoke = vi.fn(async (command: string) => {
            events.push(command);
            if (command === 'get_data') {
                return { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} };
            }
            return true;
        });
        const fetchData = vi.fn(async () => {
            events.push('fetch');
        });
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
            flushPendingSave,
            getStoreState: () => ({ fetchData, lastDataChangeAt: 0 }) as any,
        });

        const restore = SyncService.restoreDataSnapshot('data.2026-07-31.snapshot.json');
        await Promise.resolve();
        await Promise.resolve();
        expect(events).toEqual(['flush']);

        releaseFlush();
        await expect(restore).resolves.toEqual({ success: true });
        expect(events).toEqual(['flush', 'get_data', 'restore_data_snapshot', 'fetch']);
        expect(invoke).toHaveBeenCalledWith('restore_data_snapshot', {
            snapshotFileName: 'data.2026-07-31.snapshot.json',
        });
    });

    it('waits for an active sync write window before restoring a snapshot', async () => {
        const events: string[] = [];
        let releaseSync!: () => void;
        const activeSync = __syncServiceTestUtils.runSyncRestoreExclusiveForTests(async () => {
            events.push('sync:start');
            await new Promise<void>((resolve) => {
                releaseSync = resolve;
            });
            events.push('sync:end');
        });
        const invoke = vi.fn(async (command: string) => {
            events.push(command);
            if (command === 'get_data') {
                return { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} };
            }
            return true;
        });
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
            flushPendingSave: vi.fn(async () => {
                events.push('flush');
            }),
            getStoreState: () => ({
                fetchData: vi.fn(async () => {
                    events.push('fetch');
                }),
                lastDataChangeAt: 0,
            }) as any,
        });

        const restore = SyncService.restoreDataSnapshot('data.2026-07-31.snapshot.json');
        await Promise.resolve();
        await Promise.resolve();
        expect(events).toEqual(['sync:start']);

        releaseSync();
        await activeSync;
        await expect(restore).resolves.toEqual({ success: true });
        expect(events).toEqual([
            'sync:start',
            'sync:end',
            'flush',
            'get_data',
            'restore_data_snapshot',
            'fetch',
        ]);
    });

    it.each([
        {
            name: 'sync backend',
            label: 'Failed to set sync backend',
            save: () => SyncService.setSyncBackend('webdav'),
        },
        {
            name: 'WebDAV config',
            label: 'Failed to set WebDAV config',
            save: () => SyncService.setWebDavConfig({ url: 'https://dav.example.com' }),
        },
        {
            name: 'self-hosted config',
            label: 'Failed to set Self-Hosted config',
            save: () => SyncService.setCloudConfig({ url: 'https://sync.example.com' }),
        },
    ])('rejects when native $name persistence fails', async ({ label, save }) => {
        const persistenceError = new Error('native config write failed');
        const invoke = vi.fn(async (command: string) => {
            if (command === 'recover_dropbox_credentials_before_sync_configuration') return true;
            throw persistenceError;
        });
        const reportError = vi.fn();
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
            reportError,
        });

        await expect(save()).rejects.toBe(persistenceError);
        expect(reportError).toHaveBeenCalledWith(label, persistenceError);
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
        markLocalSqliteWriteMock.mockReset();
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
            markLocalWrite: markLocalWriteMock as unknown as (data?: AppData) => void,
            markLocalSqliteWrite: markLocalSqliteWriteMock as unknown as () => void,
        });

        await __syncServiceTestUtils.persistLocalDataForTests(data);

        expect(markLocalWriteMock).toHaveBeenCalledWith(data);
        expect(markLocalSqliteWriteMock).toHaveBeenCalledTimes(2);
        expect(invoke).toHaveBeenCalledWith('save_data', { data });
    });

    it('persists Tauri sync status outside the data snapshot', async () => {
        const invoke = vi.fn(async (command: string, _args?: Record<string, unknown>) => {
            throw new Error(`unexpected command: ${command}`);
        });
        const updateSettings = vi.fn(async () => undefined);
        const flushPendingSave = vi.fn(async () => undefined);
        markLocalWriteMock.mockReset();
        markLocalSqliteWriteMock.mockReset();
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
            flushPendingSave,
            getStoreState: () => ({
                updateSettings,
                lastDataChangeAt: 123,
                settings: {},
            }) as any,
            markLocalWrite: markLocalWriteMock as unknown as (data?: AppData) => void,
            markLocalSqliteWrite: markLocalSqliteWriteMock as unknown as () => void,
        });

        const result = await (SyncService as any).persistSuccessfulSyncStatus(
            'success',
            '2026-06-12T00:00:00.000Z',
        );

        expect(result).toBe(true);
        expect(updateSettings).not.toHaveBeenCalled();
        expect(flushPendingSave).not.toHaveBeenCalled();
        expect(invoke).not.toHaveBeenCalled();
        expect(JSON.parse(localStorage.getItem('mindwtr-local-sync-status-v1') ?? '{}')).toMatchObject({
            lastSyncAt: '2026-06-12T00:00:00.000Z',
            lastSyncStatus: 'success',
        });
        expect(markLocalWriteMock).not.toHaveBeenCalled();
        expect(markLocalSqliteWriteMock).not.toHaveBeenCalled();
    });

    it('keeps browser self-hosted tokens session-only by default', async () => {
        await SyncService.setCloudConfig({
            url: 'https://sync.example.com',
            token: 'session-secret',
            allowInsecureHttp: false,
        });

        expect(sessionStorage.getItem(CLOUD_TOKEN_KEY)).toBe('session-secret');
        expect(localStorage.getItem(CLOUD_TOKEN_KEY)).toBeNull();
        expect(localStorage.getItem(CLOUD_REMEMBER_TOKEN_KEY)).toBeNull();
        expect(await SyncService.getCloudConfig()).toMatchObject({
            url: 'https://sync.example.com',
            token: 'session-secret',
            rememberToken: false,
        });

        sessionStorage.clear();

        expect(await SyncService.getCloudConfig()).toMatchObject({
            url: 'https://sync.example.com',
            token: '',
            rememberToken: false,
        });
    });

    it('persists browser self-hosted tokens when remember token is enabled', async () => {
        await SyncService.setCloudConfig({
            url: 'https://sync.example.com',
            token: 'persistent-secret',
            rememberToken: true,
            allowInsecureHttp: false,
        });

        expect(localStorage.getItem(CLOUD_TOKEN_KEY)).toBe('persistent-secret');
        expect(localStorage.getItem(CLOUD_REMEMBER_TOKEN_KEY)).toBe('true');
        expect(sessionStorage.getItem(CLOUD_TOKEN_KEY)).toBeNull();

        sessionStorage.clear();

        expect(await SyncService.getCloudConfig()).toMatchObject({
            url: 'https://sync.example.com',
            token: 'persistent-secret',
            rememberToken: true,
        });
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

    it('settles native recovery before staging OAuth after renderer lifecycle state was lost', async () => {
        const events: string[] = [];
        const invoke = vi.fn(async (command: string) => {
            events.push(command);
            if (command === 'recover_dropbox_credentials_before_sync_configuration') return true;
            if (command === 'connect_dropbox') return 'opaque-candidate-handle';
            if (command === 'get_dropbox_access_token') return 'candidate-access-token';
            return undefined;
        });
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
        });

        await expect(SyncService.connectDropbox('client-id')).resolves.toBe('opaque-candidate-handle');
        await expect(SyncService.getDropboxAccessToken('client-id', {
            credentialHandle: 'opaque-candidate-handle',
            forceRefresh: true,
        })).resolves.toBe('candidate-access-token');

        expect((SyncService as any).pendingDropboxFinalizeHandles.size).toBe(0);
        expect(events.slice(0, 2)).toEqual([
            'recover_dropbox_credentials_before_sync_configuration',
            'connect_dropbox',
        ]);
        expect(invoke).toHaveBeenNthCalledWith(2, 'connect_dropbox', { clientId: 'client-id' });
        expect(invoke).toHaveBeenNthCalledWith(3, 'get_dropbox_access_token', {
            clientId: 'client-id',
            credentialHandle: 'opaque-candidate-handle',
            forceRefresh: true,
        });
    });

    it('does not start Dropbox OAuth when native recovery fails', async () => {
        const events: string[] = [];
        const invoke = vi.fn(async (command: string) => {
            events.push(command);
            if (command === 'recover_dropbox_credentials_before_sync_configuration') {
                throw new Error('native Dropbox recovery failed');
            }
            throw new Error(`Unexpected command: ${command}`);
        });
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
        });

        await expect(SyncService.connectDropbox('client-id')).rejects.toThrow(
            'native Dropbox recovery failed',
        );

        expect(events).toEqual(['recover_dropbox_credentials_before_sync_configuration']);
        expect(SyncService.getPendingDropboxCredentialHandleForSession()).toBeNull();
    });

    it('keeps attachment cleanup token resolution on the staged Dropbox account', async () => {
        const invoke = vi.fn(async (command: string) => {
            if (command === 'get_dropbox_access_token') return 'candidate-access-token';
            return undefined;
        });
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
        });

        await expect(__syncServiceTestUtils.runSyncRestoreExclusiveForTests(() => (
            __syncServiceTestUtils.resolveDropboxCleanupTokenForTests(
                'client-id',
                'opaque-candidate-handle',
                true,
            )
        ))).resolves.toBe('candidate-access-token');

        expect(invoke).toHaveBeenCalledWith('get_dropbox_access_token', {
            clientId: 'client-id',
            credentialHandle: 'opaque-candidate-handle',
            forceRefresh: true,
        });
    });

    it('durably disables an active Dropbox backend before revoking its tokens', async () => {
        let backend: SyncBackend = 'cloud';
        const events: string[] = [];
        const snapshot = () => ({
            backend,
            cloudProvider: 'dropbox' as const,
            syncPath: '',
            webdav: {
                url: '',
                username: '',
                password: null,
                passwordAuthority: 'opaque' as const,
                hasPassword: null,
                allowInsecureHttp: false,
                allowWeakFingerprint: true,
            },
            cloud: {
                url: '',
                token: null,
                tokenAuthority: 'opaque' as const,
                allowInsecureHttp: false,
                rememberToken: false,
            },
        });
        const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
            events.push(command);
            if (command === 'recover_dropbox_credentials_before_sync_configuration') return true;
            if (command === 'get_sync_configuration_snapshot') return snapshot();
            if (command === 'set_sync_backend') {
                backend = args?.backend as SyncBackend;
                return undefined;
            }
            if (command === 'get_sync_backend') return backend;
            if (command === 'disconnect_dropbox') return true;
            return undefined;
        });
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
        });
        (SyncService as any).didMigrate = true;

        await SyncService.disconnectDropbox('client-id');

        expect(backend).toBe('off');
        expect(events.indexOf('set_sync_backend')).toBeGreaterThan(events.indexOf('get_sync_configuration_snapshot'));
        expect(events.lastIndexOf('get_sync_configuration_snapshot')).toBeGreaterThan(events.indexOf('set_sync_backend'));
        expect(events.indexOf('disconnect_dropbox')).toBeGreaterThan(events.lastIndexOf('get_sync_configuration_snapshot'));
    });

    it('does not revoke Dropbox tokens when disabling the active backend fails', async () => {
        const invoke = vi.fn(async (command: string) => {
            if (command === 'recover_dropbox_credentials_before_sync_configuration') return true;
            if (command === 'get_sync_configuration_snapshot') {
                return {
                    backend: 'cloud',
                    cloudProvider: 'dropbox',
                    syncPath: '',
                    webdav: {
                        url: '',
                        username: '',
                        password: null,
                        passwordAuthority: 'opaque',
                        hasPassword: null,
                        allowInsecureHttp: false,
                        allowWeakFingerprint: true,
                    },
                    cloud: {
                        url: '',
                        token: null,
                        tokenAuthority: 'opaque',
                        allowInsecureHttp: false,
                        rememberToken: false,
                    },
                };
            }
            if (command === 'set_sync_backend') throw new Error('disk full');
            return undefined;
        });
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
        });
        (SyncService as any).didMigrate = true;

        await expect(SyncService.disconnectDropbox('client-id')).rejects.toThrow('disk full');
        expect(invoke.mock.calls.some(([command]) => command === 'disconnect_dropbox')).toBe(false);
    });

    it('serializes Dropbox disconnect and reconnect so an older disconnect cannot lose the new handle', async () => {
        let releaseDisconnect!: () => void;
        const disconnectGate = new Promise<void>((resolve) => {
            releaseDisconnect = resolve;
        });
        const events: string[] = [];
        const invoke = vi.fn(async (command: string) => {
            if (command === 'recover_dropbox_credentials_before_sync_configuration') return true;
            if (command === 'get_sync_configuration_snapshot') {
                return {
                    backend: 'off',
                    cloudProvider: 'dropbox',
                    syncPath: '',
                    webdav: {
                        url: '',
                        username: '',
                        password: null,
                        passwordAuthority: 'opaque',
                        hasPassword: null,
                        allowInsecureHttp: false,
                        allowWeakFingerprint: true,
                    },
                    cloud: {
                        url: '',
                        token: null,
                        tokenAuthority: 'opaque',
                        allowInsecureHttp: false,
                        rememberToken: false,
                    },
                };
            }
            if (command === 'disconnect_dropbox') {
                events.push('disconnect:start');
                await disconnectGate;
                events.push('disconnect:finish');
                return true;
            }
            if (command === 'connect_dropbox') {
                events.push('connect');
                return 'new-opaque-handle';
            }
            return undefined;
        });
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
        });

        const disconnect = SyncService.disconnectDropbox('client-id');
        await waitForAssertion(() => expect(events).toContain('disconnect:start'));
        const reconnect = SyncService.connectDropbox('client-id');
        await new Promise((resolve) => setTimeout(resolve, 0));
        const connectedBeforeDisconnectFinished = events.includes('connect');

        releaseDisconnect();
        await expect(disconnect).resolves.toBeUndefined();
        await expect(reconnect).resolves.toBe('new-opaque-handle');
        expect(connectedBeforeDisconnectFinished).toBe(false);
        expect(events).toEqual(['disconnect:start', 'disconnect:finish', 'connect']);
        expect(SyncService.getPendingDropboxCredentialHandleForSession()).toBe('new-opaque-handle');
    });

    it('queues staged credential cleanup behind an in-flight configuration transaction', async () => {
        let releaseConfigurationRead!: () => void;
        const configurationReadGate = new Promise<void>((resolve) => {
            releaseConfigurationRead = resolve;
        });
        const events: string[] = [];
        let firstConfigurationRead = true;
        const snapshot = {
            backend: 'off' as const,
            cloudProvider: 'selfhosted' as const,
            syncPath: '',
            webdav: {
                url: '',
                username: '',
                password: null,
                passwordAuthority: 'opaque' as const,
                hasPassword: null,
                allowInsecureHttp: false,
                allowWeakFingerprint: true,
            },
            cloud: {
                url: '',
                token: null,
                tokenAuthority: 'opaque' as const,
                allowInsecureHttp: false,
                rememberToken: false,
            },
        };
        const invoke = vi.fn(async (command: string) => {
            if (command === 'recover_dropbox_credentials_before_sync_configuration') return true;
            if (command === 'get_sync_configuration_snapshot') {
                if (firstConfigurationRead) {
                    firstConfigurationRead = false;
                    events.push('transaction:start');
                    await configurationReadGate;
                }
                return snapshot;
            }
            if (command === 'get_sync_backend') return 'off';
            if (command === 'discard_staged_dropbox_credentials') {
                events.push('credential:discard');
                return true;
            }
            return undefined;
        });
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
        });
        (SyncService as any).didMigrate = true;
        SyncService.rememberPendingDropboxCredentialHandleForSession('opaque-candidate-handle');
        const appKeySpy = vi.spyOn(SyncService, 'getDropboxAppKey').mockResolvedValue('client-id');

        const transaction = SyncService.commitProvenSyncConfiguration({ backend: 'off' });
        await waitForAssertion(() => expect(events).toContain('transaction:start'));
        const cleanup = SyncService.resolvePendingDropboxCredentialForSession('opaque-candidate-handle');
        await new Promise((resolve) => setTimeout(resolve, 0));
        const cleanupStartedBeforeTransactionFinished = events.includes('credential:discard');

        releaseConfigurationRead();
        await expect(transaction).resolves.toEqual({
            committed: true,
            cleanupPending: false,
            handleFinalized: true,
        });
        await expect(cleanup).resolves.toBeUndefined();
        appKeySpy.mockRestore();

        expect(cleanupStartedBeforeTransactionFinished).toBe(false);
        expect(events).toContain('credential:discard');
        expect(SyncService.getPendingDropboxCredentialHandleForSession()).toBeNull();
    });

    it('queues Dropbox status and connection tests behind credential promotion without nesting the token queue', async () => {
        let releasePromotion!: () => void;
        const promotionGate = new Promise<void>((resolve) => {
            releasePromotion = resolve;
        });
        let backend: SyncBackend = 'cloud';
        let cloudProvider = 'dropbox' as const;
        const events: string[] = [];
        const snapshot = () => ({
            backend,
            cloudProvider,
            syncPath: '',
            webdav: {
                url: '',
                username: '',
                password: null,
                passwordAuthority: 'opaque' as const,
                hasPassword: null,
                allowInsecureHttp: false,
                allowWeakFingerprint: true,
            },
            cloud: {
                url: '',
                token: null,
                tokenAuthority: 'opaque' as const,
                allowInsecureHttp: false,
                rememberToken: false,
            },
        });
        const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'get_sync_configuration_snapshot') {
                events.push('snapshot:native');
                return snapshot();
            }
            if (command === 'get_sync_backend') return backend;
            if (command === 'set_sync_backend') {
                backend = args?.backend as SyncBackend;
                events.push(`backend:${backend}`);
                return undefined;
            }
            if (command === 'set_sync_cloud_provider') {
                cloudProvider = args?.provider as typeof cloudProvider;
                return true;
            }
            if (command === 'get_sync_cloud_provider') return cloudProvider;
            if (command === 'promote_staged_dropbox_credentials') {
                events.push('promotion:start');
                await promotionGate;
                events.push('promotion:finish');
                return true;
            }
            if (command === 'finalize_staged_dropbox_credentials') {
                events.push('promotion:finalize');
                return true;
            }
            if (command === 'is_dropbox_connected') {
                events.push('status:native');
                return true;
            }
            if (command === 'get_dropbox_access_token') {
                events.push('test:token');
                if (args?.credentialHandle) {
                    throw new Error('finalized candidate handle is invalid');
                }
                return 'durable-access-token';
            }
            return undefined;
        });
        const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
            getTauriFetch: async () => fetchSpy as unknown as typeof fetch,
        });
        (SyncService as any).didMigrate = true;
        SyncService.rememberPendingDropboxCredentialHandleForSession('opaque-candidate-handle');
        const appKeySpy = vi.spyOn(SyncService, 'getDropboxAppKey').mockResolvedValue('client-id');

        const commit = SyncService.commitProvenSyncConfiguration({
            backend: 'cloud',
            cloudProvider: 'dropbox',
            dropboxCredentialHandle: 'opaque-candidate-handle',
        });
        await waitForAssertion(() => expect(events).toContain('promotion:start'));
        const status = SyncService.isDropboxConnected('client-id');
        const test = SyncService.testDropboxConnection('client-id', {
            credentialHandle: 'opaque-candidate-handle',
        });
        const snapshotReadsBeforeRemount = events.filter((event) => event === 'snapshot:native').length;
        const remountSnapshot = SyncService.getPersistedSyncConfigurationSnapshot();
        await new Promise((resolve) => setTimeout(resolve, 0));
        const statusEnteredDuringPromotion = events.includes('status:native');
        const testEnteredDuringPromotion = events.includes('test:token');
        const remountReadEnteredDuringPromotion = events.filter(
            (event) => event === 'snapshot:native',
        ).length > snapshotReadsBeforeRemount;

        releasePromotion();
        await expect(commit).resolves.toEqual({
            committed: true,
            cleanupPending: false,
            handleFinalized: true,
        });
        await expect(status).resolves.toBe(true);
        await expect(test).resolves.toBeUndefined();
        await expect(remountSnapshot).resolves.toMatchObject({
            backend: 'cloud',
            cloudProvider: 'dropbox',
        });
        appKeySpy.mockRestore();

        expect(statusEnteredDuringPromotion).toBe(false);
        expect(testEnteredDuringPromotion).toBe(false);
        expect(remountReadEnteredDuringPromotion).toBe(false);
        expect(events.indexOf('status:native')).toBeGreaterThan(events.indexOf('promotion:finalize'));
        expect(events.indexOf('test:token')).toBeGreaterThan(events.indexOf('status:native'));
        expect(invoke).toHaveBeenCalledWith('get_dropbox_access_token', {
            clientId: 'client-id',
            credentialHandle: undefined,
            forceRefresh: false,
        });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it.each(['journal-clear', 'entry-removal'] as const)(
        'keeps the committed Dropbox backend and retries finalize after a lost response at %s',
        async (lostResponseStage) => {
            let backend: SyncBackend = 'file';
            let cloudProvider = 'selfhosted' as 'selfhosted' | 'dropbox';
            let finalizeAttempts = 0;
            const events: string[] = [];
            const snapshot = () => ({
                backend,
                cloudProvider,
                syncPath: '/previous-file-sync',
                webdav: {
                    url: '',
                    username: '',
                    password: null,
                    passwordAuthority: 'opaque' as const,
                    hasPassword: null,
                    allowInsecureHttp: false,
                    allowWeakFingerprint: true,
                },
                cloud: {
                    url: '',
                    token: null,
                    tokenAuthority: 'opaque' as const,
                    allowInsecureHttp: false,
                    rememberToken: false,
                },
            });
            const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
                if (command === 'get_sync_configuration_snapshot') return snapshot();
                if (command === 'get_sync_backend') return backend;
                if (command === 'set_sync_backend') {
                    backend = args?.backend as SyncBackend;
                    events.push(`backend:${backend}`);
                    return undefined;
                }
                if (command === 'set_sync_cloud_provider') {
                    cloudProvider = args?.provider as typeof cloudProvider;
                    events.push(`provider:${cloudProvider}`);
                    return true;
                }
                if (command === 'get_sync_cloud_provider') return cloudProvider;
                if (command === 'promote_staged_dropbox_credentials') {
                    events.push(`promote:${String(args?.credentialHandle)}`);
                    return true;
                }
                if (command === 'finalize_staged_dropbox_credentials') {
                    finalizeAttempts += 1;
                    events.push(`finalize:${lostResponseStage}:${finalizeAttempts}`);
                    if (finalizeAttempts === 1) {
                        throw new Error(`lost response after ${lostResponseStage}`);
                    }
                    return true;
                }
                return undefined;
            });
            __syncServiceTestUtils.setDependenciesForTests({
                isTauriRuntime: () => true,
                invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
            });
            (SyncService as any).didMigrate = true;
            SyncService.rememberPendingDropboxCredentialHandleForSession('committed-handle');
            const appKeySpy = vi.spyOn(SyncService, 'getDropboxAppKey').mockResolvedValue('client-id');

            await expect(SyncService.commitProvenSyncConfiguration({
                backend: 'cloud',
                cloudProvider: 'dropbox',
                dropboxCredentialHandle: 'committed-handle',
            })).resolves.toEqual({
                committed: true,
                cleanupPending: true,
                handleFinalized: false,
            });
            await waitForAssertion(() => expect(finalizeAttempts).toBe(2));
            appKeySpy.mockRestore();

            expect(backend).toBe('cloud');
            expect(cloudProvider).toBe('dropbox');
            expect(SyncService.getPendingDropboxCredentialHandleForSession()).toBeNull();
            expect((SyncService as any).pendingDropboxFinalizeHandles.size).toBe(0);
            expect(events).not.toContain('backend:file');
            expect(events.some((event) => event.startsWith('rollback:'))).toBe(false);
        },
    );

    it('keeps finalize-pending credentials out of a later Sync and isolates a newer candidate', async () => {
        let backend: SyncBackend = 'file';
        let cloudProvider = 'selfhosted' as 'selfhosted' | 'dropbox';
        let finalizeAttempts = 0;
        const events: string[] = [];
        const snapshot = () => ({
            backend,
            cloudProvider,
            syncPath: '/previous-file-sync',
            webdav: {
                url: '',
                username: '',
                password: null,
                passwordAuthority: 'opaque' as const,
                hasPassword: null,
                allowInsecureHttp: false,
                allowWeakFingerprint: true,
            },
            cloud: {
                url: '',
                token: null,
                tokenAuthority: 'opaque' as const,
                allowInsecureHttp: false,
                rememberToken: false,
            },
        });
        const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'recover_dropbox_credentials_before_sync_configuration') return true;
            if (command === 'get_sync_configuration_snapshot') return snapshot();
            if (command === 'get_sync_backend') return backend;
            if (command === 'set_sync_backend') {
                backend = args?.backend as SyncBackend;
                events.push(`backend:${backend}`);
                return undefined;
            }
            if (command === 'set_sync_cloud_provider') {
                cloudProvider = args?.provider as typeof cloudProvider;
                return true;
            }
            if (command === 'get_sync_cloud_provider') return cloudProvider;
            if (command === 'promote_staged_dropbox_credentials') {
                events.push(`promote:${String(args?.credentialHandle)}`);
                return true;
            }
            if (command === 'finalize_staged_dropbox_credentials') {
                finalizeAttempts += 1;
                events.push(`finalize:${String(args?.credentialHandle)}:${finalizeAttempts}:failed`);
                throw new Error('finalize still unavailable');
            }
            if (command === 'discard_staged_dropbox_credentials') {
                events.push(`discard:${String(args?.credentialHandle)}`);
                return true;
            }
            if (command === 'rollback_staged_dropbox_credentials') {
                events.push(`rollback:${String(args?.credentialHandle)}`);
                return true;
            }
            return undefined;
        });
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
        });
        (SyncService as any).didMigrate = true;
        SyncService.rememberPendingDropboxCredentialHandleForSession('committed-handle');
        const appKeySpy = vi.spyOn(SyncService, 'getDropboxAppKey').mockResolvedValue('client-id');

        await expect(SyncService.commitProvenSyncConfiguration({
            backend: 'cloud',
            cloudProvider: 'dropbox',
            dropboxCredentialHandle: 'committed-handle',
        })).resolves.toMatchObject({ committed: true, cleanupPending: true });
        await waitForAssertion(() => expect(finalizeAttempts).toBeGreaterThanOrEqual(2));
        expect(SyncService.getPendingDropboxCredentialHandleForSession()).toBeNull();

        SyncService.rememberPendingDropboxCredentialHandleForSession('newer-candidate-handle');
        const backendSpy = vi.spyOn(SyncService, 'getSyncBackend').mockResolvedValue('off');
        await expect(SyncService.performSync({ manual: true })).resolves.toMatchObject({ success: true });
        backendSpy.mockRestore();
        appKeySpy.mockRestore();

        expect(finalizeAttempts).toBeGreaterThanOrEqual(3);
        expect(backend).toBe('cloud');
        expect(cloudProvider).toBe('dropbox');
        expect(SyncService.getPendingDropboxCredentialHandleForSession()).toBe('newer-candidate-handle');
        expect(events.filter((event) => event === 'promote:committed-handle')).toHaveLength(1);
        expect(events).not.toContain('promote:newer-candidate-handle');
        expect(events.some((event) => event.startsWith('discard:committed-handle'))).toBe(false);
        expect(events.some((event) => event.startsWith('rollback:committed-handle'))).toBe(false);
        expect((SyncService as any).pendingDropboxFinalizeHandles.has('committed-handle')).toBe(true);
    });

    it.each(['off', 'disconnect'] as const)(
        'settles committed Dropbox recovery before standalone %s mutation',
        async (action) => {
            let backend: SyncBackend = 'file';
            let cloudProvider = 'selfhosted' as 'selfhosted' | 'dropbox';
            let durableAccount = 'old-account';
            let revokedAccount: string | null = null;
            let journalPending = false;
            let finalizeAttempts = 0;
            const events: string[] = [];
            const snapshot = () => ({
                backend,
                cloudProvider,
                syncPath: '/previous-file-sync',
                webdav: {
                    url: '',
                    username: '',
                    password: null,
                    passwordAuthority: 'opaque' as const,
                    hasPassword: null,
                    allowInsecureHttp: false,
                    allowWeakFingerprint: true,
                },
                cloud: {
                    url: '',
                    token: null,
                    tokenAuthority: 'opaque' as const,
                    allowInsecureHttp: false,
                    rememberToken: false,
                },
            });
            const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
                if (command === 'get_sync_configuration_snapshot') return snapshot();
                if (command === 'get_sync_backend') return backend;
                if (command === 'set_sync_backend') {
                    backend = args?.backend as SyncBackend;
                    events.push(`backend:${backend}`);
                    return undefined;
                }
                if (command === 'set_sync_cloud_provider') {
                    cloudProvider = args?.provider as typeof cloudProvider;
                    return true;
                }
                if (command === 'get_sync_cloud_provider') return cloudProvider;
                if (command === 'promote_staged_dropbox_credentials') {
                    durableAccount = 'candidate-account';
                    journalPending = true;
                    events.push('promote:candidate-account');
                    return true;
                }
                if (command === 'finalize_staged_dropbox_credentials') {
                    finalizeAttempts += 1;
                    events.push(`finalize:${finalizeAttempts}:failed`);
                    throw new Error('finalize response unavailable');
                }
                if (command === 'recover_dropbox_credentials_before_sync_configuration') {
                    events.push(`recover:${backend}:${cloudProvider}`);
                    expect(backend).toBe('cloud');
                    expect(cloudProvider).toBe('dropbox');
                    expect(journalPending).toBe(true);
                    journalPending = false;
                    return true;
                }
                if (command === 'disconnect_dropbox') {
                    revokedAccount = durableAccount;
                    durableAccount = '';
                    events.push(`disconnect:${String(revokedAccount)}`);
                    return true;
                }
                return undefined;
            });
            __syncServiceTestUtils.setDependenciesForTests({
                isTauriRuntime: () => true,
                invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
            });
            (SyncService as any).didMigrate = true;
            SyncService.rememberPendingDropboxCredentialHandleForSession('committed-handle');
            const appKeySpy = vi.spyOn(SyncService, 'getDropboxAppKey').mockResolvedValue('client-id');

            await expect(SyncService.commitProvenSyncConfiguration({
                backend: 'cloud',
                cloudProvider: 'dropbox',
                dropboxCredentialHandle: 'committed-handle',
            })).resolves.toMatchObject({ committed: true, cleanupPending: true });
            await waitForAssertion(() => expect(finalizeAttempts).toBeGreaterThanOrEqual(2));

            if (action === 'off') {
                await SyncService.setSyncBackend('off');
            } else {
                await SyncService.disconnectDropbox('client-id');
            }
            appKeySpy.mockRestore();

            const recoveryIndex = events.indexOf('recover:cloud:dropbox');
            expect(recoveryIndex).toBeGreaterThan(-1);
            expect(events.lastIndexOf('backend:off')).toBeGreaterThan(recoveryIndex);
            expect(backend).toBe('off');
            expect(journalPending).toBe(false);
            expect((SyncService as any).pendingDropboxFinalizeHandles.size).toBe(0);
            if (action === 'off') {
                expect(durableAccount).toBe('candidate-account');
                expect(revokedAccount).toBeNull();
            } else {
                expect(revokedAccount).toBe('candidate-account');
                expect(durableAccount).toBe('');
            }
        },
    );

    it('publishes finalize-pending ownership before a queued Off barrier and emits no stale retry warning', async () => {
        let backend: SyncBackend = 'file';
        let cloudProvider = 'selfhosted' as 'selfhosted' | 'dropbox';
        let releaseFinalize!: () => void;
        let finalizeAttempts = 0;
        let barrierSawFinalizeOwnership = false;
        const finalizeGate = new Promise<void>((resolve) => {
            releaseFinalize = resolve;
        });
        const logWarn = vi.fn(async () => null);
        const showToast = vi.fn();
        const originalShowToast = useUiStore.getState().showToast;
        useUiStore.setState({ showToast });
        const snapshot = () => ({
            backend,
            cloudProvider,
            syncPath: '/previous-file-sync',
            webdav: {
                url: '',
                username: '',
                password: null,
                passwordAuthority: 'opaque' as const,
                hasPassword: null,
                allowInsecureHttp: false,
                allowWeakFingerprint: true,
            },
            cloud: {
                url: '',
                token: null,
                tokenAuthority: 'opaque' as const,
                allowInsecureHttp: false,
                rememberToken: false,
            },
        });
        const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'get_sync_configuration_snapshot') return snapshot();
            if (command === 'get_sync_backend') return backend;
            if (command === 'set_sync_backend') {
                backend = args?.backend as SyncBackend;
                return undefined;
            }
            if (command === 'set_sync_cloud_provider') {
                cloudProvider = args?.provider as typeof cloudProvider;
                return true;
            }
            if (command === 'get_sync_cloud_provider') return cloudProvider;
            if (command === 'promote_staged_dropbox_credentials') return true;
            if (command === 'finalize_staged_dropbox_credentials') {
                finalizeAttempts += 1;
                await finalizeGate;
                throw new Error('finalize response unavailable');
            }
            if (command === 'recover_dropbox_credentials_before_sync_configuration') {
                barrierSawFinalizeOwnership = (SyncService as any)
                    .pendingDropboxFinalizeHandles
                    .has('committed-handle');
                return true;
            }
            return undefined;
        });
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
            logWarn,
        });
        (SyncService as any).didMigrate = true;
        SyncService.rememberPendingDropboxCredentialHandleForSession('committed-handle');
        const appKeySpy = vi.spyOn(SyncService, 'getDropboxAppKey').mockResolvedValue('client-id');

        try {
            const commit = SyncService.commitProvenSyncConfiguration({
                backend: 'cloud',
                cloudProvider: 'dropbox',
                dropboxCredentialHandle: 'committed-handle',
            });
            await waitForAssertion(() => expect(finalizeAttempts).toBe(1));
            const disable = SyncService.setSyncBackend('off');

            releaseFinalize();
            await expect(commit).resolves.toMatchObject({ committed: true, cleanupPending: true });
            await expect(disable).resolves.toBeUndefined();

            expect(barrierSawFinalizeOwnership).toBe(true);
            expect(backend).toBe('off');
            expect(finalizeAttempts).toBe(1);
            expect((SyncService as any).pendingDropboxFinalizeHandles.size).toBe(0);
            expect(SyncService.getPendingDropboxCredentialHandleForSession()).toBeNull();
            expect(logWarn).not.toHaveBeenCalled();
            expect(showToast).not.toHaveBeenCalled();
        } finally {
            appKeySpy.mockRestore();
            useUiStore.setState({ showToast: originalShowToast });
        }
    });

    it.each([
        {
            label: 'file',
            candidate: { backend: 'file' as const, syncPath: '/next-file-sync' },
        },
        {
            label: 'self-hosted',
            candidate: {
                backend: 'cloud' as const,
                cloudProvider: 'selfhosted' as const,
                cloud: {
                    url: 'https://next-cloud.example.com',
                    token: 'next-cloud-token',
                },
            },
        },
    ])('settles finalize-pending Dropbox state before activating $label sync', async ({ candidate }) => {
        let backend: SyncBackend = 'file';
        let cloudProvider = 'selfhosted' as 'selfhosted' | 'dropbox';
        let syncPath = '/previous-file-sync';
        let cloudUrl = '';
        let cloudToken = '';
        let journalPending = false;
        let finalizeAttempts = 0;
        const events: string[] = [];
        const snapshot = (args?: Record<string, unknown>) => ({
            backend,
            cloudProvider,
            syncPath,
            webdav: {
                url: '',
                username: '',
                password: null,
                passwordAuthority: 'opaque' as const,
                hasPassword: null,
                allowInsecureHttp: false,
                allowWeakFingerprint: true,
            },
            cloud: args?.requireCloudToken === true
                ? {
                    url: cloudUrl,
                    token: cloudToken,
                    tokenAuthority: 'known' as const,
                    allowInsecureHttp: false,
                    rememberToken: false,
                }
                : {
                    url: cloudUrl,
                    token: null,
                    tokenAuthority: 'opaque' as const,
                    allowInsecureHttp: false,
                    rememberToken: false,
                },
        });
        const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'get_sync_configuration_snapshot') return snapshot(args);
            if (command === 'get_sync_backend') return backend;
            if (command === 'set_sync_backend') {
                backend = args?.backend as SyncBackend;
                events.push(`backend:${backend}`);
                return undefined;
            }
            if (command === 'set_sync_path') {
                syncPath = String(args?.syncPath ?? '');
                events.push(`path:${syncPath}`);
                return { success: true, path: syncPath };
            }
            if (command === 'set_cloud_config') {
                cloudUrl = String(args?.url ?? '');
                cloudToken = String(args?.token ?? '');
                events.push(`cloud:${cloudUrl}`);
                return true;
            }
            if (command === 'set_sync_cloud_provider') {
                cloudProvider = args?.provider as typeof cloudProvider;
                events.push(`provider:${cloudProvider}`);
                return true;
            }
            if (command === 'get_sync_cloud_provider') return cloudProvider;
            if (command === 'promote_staged_dropbox_credentials') {
                journalPending = true;
                events.push('promote:committed-handle');
                return true;
            }
            if (command === 'finalize_staged_dropbox_credentials') {
                finalizeAttempts += 1;
                events.push(`finalize:${finalizeAttempts}:failed`);
                throw new Error('finalize response unavailable');
            }
            if (command === 'recover_dropbox_credentials_before_sync_configuration') {
                events.push(`recover:${backend}:${cloudProvider}`);
                expect(backend).toBe('cloud');
                expect(cloudProvider).toBe('dropbox');
                expect(journalPending).toBe(true);
                journalPending = false;
                return true;
            }
            return undefined;
        });
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
        });
        (SyncService as any).didMigrate = true;
        SyncService.rememberPendingDropboxCredentialHandleForSession('committed-handle');
        const appKeySpy = vi.spyOn(SyncService, 'getDropboxAppKey').mockResolvedValue('client-id');

        await SyncService.commitProvenSyncConfiguration({
            backend: 'cloud',
            cloudProvider: 'dropbox',
            dropboxCredentialHandle: 'committed-handle',
        });
        await waitForAssertion(() => expect(finalizeAttempts).toBeGreaterThanOrEqual(2));

        await expect(SyncService.commitProvenSyncConfiguration(candidate)).resolves.toEqual({
            committed: true,
            cleanupPending: false,
            handleFinalized: true,
        });
        await SyncService.retryPendingDropboxCredentialFinalizationForSession();
        appKeySpy.mockRestore();

        const recoveryIndex = events.indexOf('recover:cloud:dropbox');
        expect(recoveryIndex).toBeGreaterThan(-1);
        expect(recoveryIndex).toBeLessThan(events.indexOf('backend:off', recoveryIndex));
        expect(backend).toBe(candidate.backend);
        expect(journalPending).toBe(false);
        expect(finalizeAttempts).toBe(2);
        expect((SyncService as any).pendingDropboxFinalizeHandles.size).toBe(0);
        if (candidate.backend === 'file') {
            expect(syncPath).toBe('/next-file-sync');
        } else {
            expect(cloudProvider).toBe('selfhosted');
            expect(cloudUrl).toBe('https://next-cloud.example.com');
            expect(cloudToken).toBe('next-cloud-token');
        }
    });

    it('rejects a queued stale credential request rather than touching a newer authorization', async () => {
        let releaseTransaction!: () => void;
        const transactionGate = new Promise<void>((resolve) => {
            releaseTransaction = resolve;
        });
        const invoke = vi.fn(async () => 'candidate-access-token');
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
        });
        SyncService.rememberPendingDropboxCredentialHandleForSession('old-candidate-handle');

        const transaction = __syncServiceTestUtils.runSyncRestoreExclusiveForTests(
            () => transactionGate,
        );
        const token = SyncService.getDropboxAccessToken('client-id', {
            credentialHandle: 'old-candidate-handle',
        });
        SyncService.forgetPendingDropboxCredentialHandleForSession('old-candidate-handle');
        SyncService.rememberPendingDropboxCredentialHandleForSession('new-candidate-handle');

        releaseTransaction();
        await transaction;
        await expect(token).rejects.toThrow('A different Dropbox authorization is pending');
        expect(invoke).not.toHaveBeenCalled();
        expect(SyncService.getPendingDropboxCredentialHandleForSession()).toBe('new-candidate-handle');
    });

    it('queues public backend writes behind a commit so a later Off action wins durably', async () => {
        let releasePromotion!: () => void;
        const promotionGate = new Promise<void>((resolve) => {
            releasePromotion = resolve;
        });
        let backend: SyncBackend = 'off';
        let cloudProvider = 'dropbox' as const;
        const events: string[] = [];
        const snapshot = () => ({
            backend,
            cloudProvider,
            syncPath: '',
            webdav: {
                url: '',
                username: '',
                password: null,
                passwordAuthority: 'opaque' as const,
                hasPassword: null,
                allowInsecureHttp: false,
                allowWeakFingerprint: true,
            },
            cloud: {
                url: '',
                token: null,
                tokenAuthority: 'opaque' as const,
                allowInsecureHttp: false,
                rememberToken: false,
            },
        });
        const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'recover_dropbox_credentials_before_sync_configuration') return true;
            if (command === 'get_sync_configuration_snapshot') return snapshot();
            if (command === 'get_sync_backend') return backend;
            if (command === 'set_sync_backend') {
                backend = args?.backend as SyncBackend;
                events.push(`backend:${backend}`);
                return undefined;
            }
            if (command === 'set_sync_cloud_provider') {
                cloudProvider = args?.provider as typeof cloudProvider;
                return true;
            }
            if (command === 'get_sync_cloud_provider') return cloudProvider;
            if (command === 'promote_staged_dropbox_credentials') {
                events.push('promotion:start');
                await promotionGate;
                events.push('promotion:finish');
                return true;
            }
            if (command === 'finalize_staged_dropbox_credentials') {
                events.push('promotion:finalize');
                return true;
            }
            return undefined;
        });
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
        });
        (SyncService as any).didMigrate = true;
        SyncService.rememberPendingDropboxCredentialHandleForSession('opaque-candidate-handle');
        const appKeySpy = vi.spyOn(SyncService, 'getDropboxAppKey').mockResolvedValue('client-id');

        const commit = SyncService.commitProvenSyncConfiguration({
            backend: 'cloud',
            cloudProvider: 'dropbox',
            dropboxCredentialHandle: 'opaque-candidate-handle',
        });
        await waitForAssertion(() => expect(events).toContain('promotion:start'));
        const disable = SyncService.setSyncBackend('off');
        await new Promise((resolve) => setTimeout(resolve, 0));
        const offWrittenDuringPromotion = events.includes('backend:off')
            && events.lastIndexOf('backend:off') > events.indexOf('promotion:start');

        releasePromotion();
        await commit;
        await disable;
        appKeySpy.mockRestore();

        expect(offWrittenDuringPromotion).toBe(false);
        expect(backend).toBe('off');
        expect(events.lastIndexOf('backend:off')).toBeGreaterThan(events.indexOf('promotion:finalize'));
    });

    it('queues manual attachment cleanup behind sync lifecycle transactions', async () => {
        let releaseTransaction!: () => void;
        const transactionGate = new Promise<void>((resolve) => {
            releaseTransaction = resolve;
        });
        const events: string[] = [];
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            flushPendingSave: async () => {
                events.push('cleanup:flush');
                throw new Error('stop after queue proof');
            },
        });

        const transaction = __syncServiceTestUtils.runSyncRestoreExclusiveForTests(async () => {
            events.push('transaction:start');
            await transactionGate;
            events.push('transaction:finish');
        });
        await waitForAssertion(() => expect(events).toContain('transaction:start'));
        const cleanup = SyncService.cleanupAttachmentsNow();
        const cleanupResult = cleanup.then(
            () => null,
            (error: unknown) => error,
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        const cleanupStartedDuringTransaction = events.includes('cleanup:flush');

        releaseTransaction();
        await transaction;
        const cleanupError = await cleanupResult;

        expect(cleanupStartedDuringTransaction).toBe(false);
        expect(events.indexOf('cleanup:flush')).toBeGreaterThan(events.indexOf('transaction:finish'));
        expect(cleanupError).toEqual(new Error('stop after queue proof'));
    });

    it('tests WebDAV connectivity against the normalized data.json URL', async () => {
        const { fetchSpy } = createTestWebdavCapabilityFetch();
        __syncServiceTestUtils.setDependenciesForTests({
            getTauriFetch: async () => fetchSpy as unknown as typeof fetch,
        });

        await SyncService.testWebDavConnection({
            url: 'https://example.com/remote.php/dav/files/user/mindwtr/',
            username: 'alice',
            password: 'secret',
        });

        expect(fetchSpy).toHaveBeenCalledTimes(10);
        const firstCall = fetchSpy.mock.calls[0];
        expect(firstCall).toBeDefined();
        if (!firstCall) {
            throw new Error('Expected WebDAV fetch call');
        }
        expect(firstCall[0]).toBe('https://example.com/remote.php/dav/files/user/mindwtr/data.json');
        expect(firstCall[1]).toMatchObject({ method: 'GET' });
    });

    it('accepts an empty WebDAV location observationally without creating a capability probe', async () => {
        const { fetchSpy, methods } = createTestWebdavCapabilityFetch(null);
        __syncServiceTestUtils.setDependenciesForTests({
            getTauriFetch: async () => fetchSpy as unknown as typeof fetch,
        });

        await SyncService.testWebDavConnection({
            url: 'https://example.com/remote.php/dav/files/user/mindwtr',
            username: 'alice',
            password: 'secret',
        });

        expect(methods).toEqual(['GET']);
        expect(localStorage.getItem(WEBDAV_CAPABILITY_PROOF_STORAGE_KEY)).toBeNull();
    });

    it.each([
        ['missing', undefined],
        ['weak', 'W/"v1"'],
    ] as const)('accepts legacy plaintext WebDAV setup when data.json has a %s ETag', async (_case, etag) => {
        const fetchSpy = vi.fn(async () => new Response('{}', {
            status: 200,
            headers: etag ? { etag } : undefined,
        }));
        __syncServiceTestUtils.setDependenciesForTests({
            getTauriFetch: async () => fetchSpy as unknown as typeof fetch,
        });

        await expect(SyncService.testWebDavConnection({
            url: 'https://example.com/remote.php/dav/files/user/mindwtr',
            username: 'alice',
            password: 'secret',
        })).resolves.toBeUndefined();
        expect(fetchSpy).toHaveBeenCalledOnce();
        expect(localStorage.getItem(WEBDAV_CAPABILITY_PROOF_STORAGE_KEY)).toBeNull();
    });

    it.each([
        [{ state: 'off' }, true],
        [{ state: 'enabled' }, false],
        [{ state: 'off', incompleteTransition: 'enable' }, false],
    ] as const)('allows legacy plaintext WebDAV only for exact-off posture %j', (status, expected) => {
        expect(__syncServiceTestUtils.isLegacyWebdavPlaintextPostureAllowed(status)).toBe(expected);
    });

    // fresh-join-attachment-posture packet -10: closes #1138 result §8 risk 2. Desktop has no
    // pre-read no-key gate, so this predicate is the ONLY thing standing between an unresolved
    // encryption posture and sealAttachmentBytes' plaintext fallback.
    describe('shouldDeferAttachmentPrepareUntilRead (fresh-join-attachment-posture packet -10)', () => {
        const base = {
            backend: 'webdav' as const,
            cloudProvider: 'selfhosted' as const,
            encryptionState: 'off' as const,
            discoveredScopeLabel: undefined,
            activeScopeLabel: 'webdav#aaaaaaaa',
            hasCompletedCycleAgainstLocation: false,
        };

        it.each([
            ['cloudkit', 'selfhosted'],
            ['cloud', 'selfhosted'],
        ] as const)('never defers for a backend encryption cannot apply to (%s/%s)', (backend, cloudProvider) => {
            expect(__syncServiceTestUtils.shouldDeferAttachmentPrepareUntilRead({
                ...base,
                backend,
                cloudProvider,
                hasCompletedCycleAgainstLocation: false,
            })).toBe(false);
        });

        it.each([
            ['file', 'selfhosted'],
            ['webdav', 'selfhosted'],
            ['cloud', 'dropbox'],
        ] as const)('defers for a genuinely fresh %s/%s device (no fast-sync record yet)', (backend, cloudProvider) => {
            expect(__syncServiceTestUtils.shouldDeferAttachmentPrepareUntilRead({
                ...base,
                backend,
                cloudProvider,
                hasCompletedCycleAgainstLocation: false,
            })).toBe(true);
        });

        it('does not defer once a fast-sync cycle has completed against this off-state location', () => {
            expect(__syncServiceTestUtils.shouldDeferAttachmentPrepareUntilRead({
                ...base,
                hasCompletedCycleAgainstLocation: true,
            })).toBe(false);
        });

        it('treats an unreadable ("unknown") posture the same as off — fail closed, defer', () => {
            expect(__syncServiceTestUtils.shouldDeferAttachmentPrepareUntilRead({
                ...base,
                encryptionState: 'unknown',
                hasCompletedCycleAgainstLocation: false,
            })).toBe(true);
        });

        it.each([
            // Keyed states (enabled/remote-plaintext) are ALWAYS established, with no scope
            // comparison — material present means every write is encrypted from the first
            // byte. Review packet -10 finding B1: `discoveredScopeLabel` is `undefined` for
            // every production 'enabled' state (both writers clear it on purpose), so the row
            // that matters most is the `undefined` one below — it must NOT defer.
            ['enabled', 'webdav#aaaaaaaa', false],
            ['enabled', 'webdav#bbbbbbbb', false],
            ['enabled', undefined, false],
            ['remote-plaintext', 'webdav#aaaaaaaa', false],
            ['remote-plaintext', undefined, false],
            ['remote-encrypted-no-key', 'webdav#aaaaaaaa', false],
            ['remote-encrypted-no-key', 'webdav#bbbbbbbb', true],
            ['remote-encrypted-no-key', undefined, true],
        ] as const)('%s with discoveredScopeLabel %s -> defer=%s', (encryptionState, discoveredScopeLabel, expected) => {
            expect(__syncServiceTestUtils.shouldDeferAttachmentPrepareUntilRead({
                ...base,
                encryptionState,
                discoveredScopeLabel,
                hasCompletedCycleAgainstLocation: false,
            })).toBe(expected);
        });
    });


    // #1119 follow-up (audit F3), desktop port of mobile commit 06ebf5b41. The gate used to
    // return true for ANY live file attachment, so a user with one synced attachment paid the
    // whole phase — MKCOL plus one HEAD per attachment — on every cycle including idle ones.
    describe('hasAttachmentSyncWork (#1119 follow-up)', () => {
        const SCOPE = JSON.stringify(['webdav', 'https://dav.example/mindwtr', 'alice']);

        const dataWith = (attachment: Partial<Attachment>): AppData => ({
            ...emptyAppData(),
            tasks: [{
                id: 'task-1',
                title: 'Task',
                status: 'next',
                tags: [],
                contexts: [],
                createdAt: '2026-09-01T00:00:00.000Z',
                updatedAt: '2026-09-01T00:00:00.000Z',
                attachments: [{
                    id: 'attachment-1',
                    kind: 'file',
                    title: 'doc.txt',
                    uri: `${MANAGED_ATTACHMENTS_DIR}doc.txt`,
                    cloudKey: 'attachments/attachment-1.txt',
                    localStatus: 'available',
                    contentMtimeMs: 1000,
                    contentSize: 3,
                    createdAt: '2026-09-01T00:00:00.000Z',
                    updatedAt: '2026-09-01T00:00:00.000Z',
                    ...attachment,
                }],
            }],
        });

        afterEach(() => {
            clearAttachmentPresenceStamp();
        });

        it('reports no work for a settled managed attachment inside the reconciliation interval', async () => {
            markAttachmentPresenceReconciled(SCOPE);
            await expect(__syncServiceTestUtils.hasAttachmentSyncWork(dataWith({}), SCOPE)).resolves.toBe(false);
        });

        it('reports work when the daily presence proof is due', async () => {
            await expect(__syncServiceTestUtils.hasAttachmentSyncWork(dataWith({}), SCOPE)).resolves.toBe(true);
        });

        it.each([
            ['no cloudKey yet', { cloudKey: undefined }],
            ['no local copy', { uri: '' }],
            ['localStatus missing', { localStatus: 'missing' as const }],
            ['localStatus downloading', { localStatus: 'downloading' as const }],
            ['localStatus not yet known', { localStatus: undefined }],
            ['a pending content upload', { pendingContentUpload: true }],
            // An incoming content winner is merged in with NO recorded stat, on purpose, so the
            // receiving device re-checks and re-downloads (resolveContentIdentity in core).
            ['no recorded content mtime', { contentMtimeMs: undefined }],
            ['no recorded content size', { contentSize: undefined }],
            // Desktop-only: a linked file outside the managed dir can be edited in an external
            // editor, which is exactly what #1057 check-on-touch exists to catch.
            ['an external file reference', { uri: '/home/user/Documents/spec.pdf' }],
        ])('still reports work with %s, even with a fresh stamp', async (_label, overrides) => {
            markAttachmentPresenceReconciled(SCOPE);
            await expect(
                __syncServiceTestUtils.hasAttachmentSyncWork(dataWith(overrides), SCOPE),
            ).resolves.toBe(true);
        });

        it('reports work for a pending remote delete regardless of the stamp', async () => {
            markAttachmentPresenceReconciled(SCOPE);
            const data = dataWith({});
            data.settings.attachments = {
                pendingRemoteDeletes: [{ cloudKey: 'attachments/attachment-9.txt' }],
            };
            await expect(__syncServiceTestUtils.hasAttachmentSyncWork(data, SCOPE)).resolves.toBe(true);
        });

        it('reports no work at all for a library with no file attachments', async () => {
            markAttachmentPresenceReconciled(SCOPE);
            await expect(__syncServiceTestUtils.hasAttachmentSyncWork(emptyAppData(), SCOPE)).resolves.toBe(false);
        });
    });

    // fresh-join-attachment-posture packet -10, added item A: the presence stamp is the file
    // backend's only durable "seen this location" fact, since buildFastSyncScope returns null
    // there. Before this, `file` was hard-coded established, so a genuinely fresh file-backend
    // device ran its attachment prepare phase — and `sealAttachmentBytes`' plaintext fallback —
    // before the document read could discover the folder is encrypted.
    describe('hasCompletedCycleAgainstLocation (#1119 stamp feeding the #1138 posture gate)', () => {
        const FILE_SCOPE = JSON.stringify(['file', '/sync']);

        afterEach(() => {
            clearAttachmentPresenceStamp();
        });

        it('is not established on a fresh file-backend device, so the prepare phase defers', () => {
            const established = __syncServiceTestUtils.hasCompletedCycleAgainstLocation({
                backend: 'file',
                locationScope: FILE_SCOPE,
                fastSyncScope: null,
            });
            expect(established).toBe(false);
            expect(__syncServiceTestUtils.shouldDeferAttachmentPrepareUntilRead({
                backend: 'file',
                cloudProvider: 'selfhosted',
                encryptionState: 'off',
                discoveredScopeLabel: undefined,
                activeScopeLabel: 'file#aaaaaaaa',
                hasCompletedCycleAgainstLocation: established,
            })).toBe(true);
        });

        it('is established once a presence pass completed against this location', () => {
            markAttachmentPresenceReconciled(FILE_SCOPE);
            const established = __syncServiceTestUtils.hasCompletedCycleAgainstLocation({
                backend: 'file',
                locationScope: FILE_SCOPE,
                fastSyncScope: null,
            });
            expect(established).toBe(true);
            expect(__syncServiceTestUtils.shouldDeferAttachmentPrepareUntilRead({
                backend: 'file',
                cloudProvider: 'selfhosted',
                encryptionState: 'off',
                discoveredScopeLabel: undefined,
                activeScopeLabel: 'file#aaaaaaaa',
                hasCompletedCycleAgainstLocation: established,
            })).toBe(false);
        });

        it('never lets a stamp from another location vouch for this one', () => {
            markAttachmentPresenceReconciled(JSON.stringify(['file', '/other-sync']));
            expect(__syncServiceTestUtils.hasCompletedCycleAgainstLocation({
                backend: 'file',
                locationScope: FILE_SCOPE,
                fastSyncScope: null,
            })).toBe(false);
        });
    });

    it('rejects an HTML/login response with 200 and a strong ETag during WebDAV setup', async () => {
        const fetchSpy = vi.fn(async () => new Response('<html>Sign in</html>', {
            status: 200,
            headers: { etag: '"login-v1"' },
        }));
        __syncServiceTestUtils.setDependenciesForTests({
            getTauriFetch: async () => fetchSpy as unknown as typeof fetch,
        });

        await expect(SyncService.testWebDavConnection({
            url: 'https://example.com/remote.php/dav/files/user/mindwtr',
            username: 'alice',
            password: 'secret',
        })).rejects.toThrow('WebDAV GET failed: invalid JSON');
        expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it('reuses the stored WebDAV password when settings only expose hasPassword', async () => {
        const { fetchSpy } = createTestWebdavCapabilityFetch();
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

    it('falls back to the stored WebDAV password when the form field is empty after a restart (#899)', async () => {
        const { fetchSpy } = createTestWebdavCapabilityFetch();
        const invoke = vi.fn(async (command: string) => {
            if (command === 'get_webdav_password') return 'stored-secret';
            throw new Error(`unexpected command: ${command}`);
        });
        __syncServiceTestUtils.setDependenciesForTests({
            getTauriFetch: async () => fetchSpy as unknown as typeof fetch,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
            isTauriRuntime: () => true,
        });

        // The settings form sends password: '' with hasPassword: true after a
        // restart; the empty string must not shadow the keyring secret.
        await SyncService.testWebDavConnection({
            url: 'https://example.com/remote.php/dav/files/user/mindwtr',
            username: 'alice',
            password: '',
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
        const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'get_sync_backend') return 'file';
            if (command === 'save_data') return undefined;
            if (command === 'acquire_file_sync_lease') return 'lease-token';
            if (command === 'release_file_sync_lease') {
                expect(args?.token).toBe('lease-token');
                return undefined;
            }
            if (command === 'write_sync_file') {
                expect(args?.leaseToken).toBe('lease-token');
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
        expect((SyncService as any).pendingExternalSyncChange).toEqual({
            path: '/tmp/mindwtr-sync.json',
            localHash: 'local-hash',
            incomingHash: 'incoming-hash',
        });
        expect((SyncService as any).fileWriteIgnoreActive).toBe(false);
        expect((SyncService as any).ignoreFileEventsUntil).toBe(11_000);
        getMonotonicNowSpy.mockRestore();
    });

    // The 401-triggered token-refresh-and-retry-once policy moved to
    // `createSyncBackendIO` (packages/core/src/sync-backend-io.test.ts,
    // "retries exactly once on an unauthorized token" / "gives up after
    // exactly one retry") as part of ADR 0014's completion — it is shared
    // with mobile now instead of hand-copied here. What remains desktop's own
    // policy is the transient-retry wrap around one Dropbox transport call.
    it('retries a transient Dropbox request failure before giving up', async () => {
        const operation = vi.fn()
            .mockRejectedValueOnce(new TypeError('Network request failed'))
            .mockResolvedValue('ok');

        await expect((SyncService as any).runDropboxTransientRetry(operation)).resolves.toBe('ok');

        expect(operation).toHaveBeenCalledTimes(2);
    });

    it('does not retry non-transient Dropbox failures', async () => {
        const operation = vi.fn(async () => {
            throw new Error('Dropbox download failed: HTTP 409');
        });

        await expect((SyncService as any).runDropboxTransientRetry(operation))
            .rejects
            .toThrow('HTTP 409');

        expect(operation).toHaveBeenCalledTimes(1);
    });

    it('does not retry an unauthorized Dropbox failure (the auth-retry policy lives in createSyncBackendIO)', async () => {
        const operation = vi.fn(async () => {
            throw new DropboxUnauthorizedError('Dropbox upload failed: HTTP 401');
        });

        await expect((SyncService as any).runDropboxTransientRetry(operation))
            .rejects
            .toBeInstanceOf(DropboxUnauthorizedError);

        expect(operation).toHaveBeenCalledTimes(1);
    });

    it('does not swallow a lifecycle abort during the browser Dropbox read fallback', async () => {
        const requestAbortController = new AbortController();
        const nativeFetch = vi.fn(async () => new Response('', {
            status: 200,
            headers: { 'dropbox-api-result': '{"rev":"native-rev"}' },
        })) as typeof fetch;
        const cancelBody = vi.fn();
        const browserFetch = vi.fn(async () => new Response(new ReadableStream({
            pull: () => new Promise<void>(() => undefined),
            cancel: cancelBody,
        }), {
            status: 200,
            headers: { 'dropbox-api-result': '{"rev":"browser-rev"}' },
        })) as typeof fetch;
        const originalFetch = globalThis.fetch;
        globalThis.fetch = browserFetch;
        __syncServiceTestUtils.setDependenciesForTests({
            getTauriFetch: async () => nativeFetch,
        });

        try {
            const download = (SyncService as any).downloadDropboxWithFallback(
                { requestAbortController },
                'dropbox-token',
            );
            await waitForAssertion(() => expect(browserFetch).toHaveBeenCalledOnce());

            requestAbortController.abort(new DOMException('Sync cycle cancelled', 'AbortError'));

            await expect(download).rejects.toMatchObject({ name: 'AbortError' });
            expect(browserFetch).toHaveBeenCalledOnce();
            expect(cancelBody).toHaveBeenCalledOnce();
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('maps a native file fingerprint mismatch to a shared remote-write conflict', async () => {
        const remote = emptyAppData();
        const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'read_sync_file_versioned') {
                expect(args?.leaseToken).toBe('cycle-lease');
                return { data: remote, fingerprint: 'file:v1:sha256=initial' };
            }
            if (command === 'write_sync_file') {
                expect(args?.expectedFingerprint).toBe('file:v1:sha256=initial');
                expect(args?.leaseToken).toBe('cycle-lease');
                throw new Error('SYNC_FILE_WRITE_CONFLICT');
            }
            throw new Error(`unexpected command: ${command}`);
        });
        __syncServiceTestUtils.setDependenciesForTests({
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
            isTauriRuntime: () => true,
        });
        const io = (SyncService as any).createBackendIO({
            backend: 'file',
            usesConfigOverride: false,
            networkWentOffline: false,
            removeNetworkListener: null,
            requestAbortController: new AbortController(),
            webdavConfig: null,
            cloudProvider: 'selfhosted',
            cloudConfig: null,
            dropboxAppKey: '',
            dropboxCredentialHandle: null,
            cachedDropboxAccessToken: null,
            syncPath: '/tmp/mindwtr-sync',
            fileBaseDir: '/tmp/mindwtr-sync',
            fileSyncLeaseToken: 'cycle-lease',
        });

        await expect(io.readRemote()).resolves.toBe(remote);
        await expect(io.writeRemote(remote)).rejects.toBeInstanceOf(SyncRemoteWriteConflict);
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

    it('normalizes a native busy File Sync lease into a neutral deferred result', async () => {
        __syncServiceTestUtils.setDependenciesForTests({
            flushPendingSave: vi.fn(async () => undefined),
            getStoreState: () => ({
                fetchData: vi.fn(async () => undefined),
                lastDataChangeAt: 0,
                settings: {},
                setError: vi.fn(),
                updateSettings: vi.fn(async () => undefined),
            }) as any,
            invoke: vi.fn(async (command: string) => {
                if (command === 'acquire_file_sync_lease') {
                    throw new Error('SYNC_FILE_LOCK_BUSY: lock held by another process');
                }
                throw new Error(`unexpected command: ${command}`);
            }) as any,
            isTauriRuntime: () => false,
        });

        const result = await SyncService.performSync({
            manual: true,
            configOverride: { backend: 'file', syncPath: '/tmp/mindwtr-sync/data.json' },
        });

        expect(result).toMatchObject({
            success: true,
            skipped: 'fileSyncLockBusy',
            fileSyncLockDeferred: 'busy',
        });
        expect(result.error).toBeUndefined();
        expect(SyncService.getSyncStatus()).toMatchObject({
            inFlight: false,
            lastResult: null,
            lastResultAt: null,
        });
    });

    it('returns an actionable failure when the native File Sync lease is unavailable', async () => {
        __syncServiceTestUtils.setDependenciesForTests({
            flushPendingSave: vi.fn(async () => undefined),
            getStoreState: () => ({
                fetchData: vi.fn(async () => undefined),
                lastDataChangeAt: 0,
                settings: {},
                setError: vi.fn(),
                updateSettings: vi.fn(async () => undefined),
            }) as any,
            invoke: vi.fn(async (command: string) => {
                if (command === 'acquire_file_sync_lease') {
                    throw new Error('SYNC_FILE_LOCK_UNAVAILABLE: platform lease API failed');
                }
                throw new Error(`unexpected command: ${command}`);
            }) as any,
            isTauriRuntime: () => false,
        });

        const result = await SyncService.performSync({
            manual: true,
            configOverride: { backend: 'file', syncPath: '/tmp/mindwtr-sync/data.json' },
        });

        expect(result).toMatchObject({ success: false, fileSyncLockUnavailable: true });
        expect(result.error).toContain('Safe File Sync locking is unavailable');
    });

    it('normalizes the native lock-open failure into localized File Sync recovery', async () => {
        __syncServiceTestUtils.setDependenciesForTests({
            flushPendingSave: vi.fn(async () => undefined),
            getStoreState: () => ({
                fetchData: vi.fn(async () => undefined),
                lastDataChangeAt: 0,
                settings: {},
                setError: vi.fn(),
                updateSettings: vi.fn(async () => undefined),
            }) as any,
            invoke: vi.fn(async (command: string) => {
                if (command === 'acquire_file_sync_lease') {
                    throw new Error('Failed to open sync lock: permission denied');
                }
                throw new Error(`unexpected command: ${command}`);
            }) as any,
            isTauriRuntime: () => false,
        });

        await expect(SyncService.performSync({
            manual: true,
            configOverride: { backend: 'file', syncPath: '/tmp/mindwtr-sync/data.json' },
        })).resolves.toMatchObject({
            success: false,
            fileSyncLockUnavailable: true,
            error: expect.stringContaining('Safe File Sync locking is unavailable'),
        });
    });

    it('keeps a completed desktop File Sync cycle successful when lease release is deferred', async () => {
        const setupSpy = vi.spyOn(SyncService as any, 'setupDesktopCycle').mockImplementation(async (context: any) => {
            context.backend = 'file';
            context.fileSyncLeaseToken = 'cycle-lease';
            return {
                kind: 'ready',
                backend: 'file',
                cloudProvider: 'selfhosted',
                fastSyncScope: null,
                io: {
                    readRemote: vi.fn(async () => null),
                    writeRemote: vi.fn(async () => undefined),
                },
            };
        });
        try {
            __syncServiceTestUtils.setDependenciesForTests({
                flushPendingSave: vi.fn(async () => undefined),
                getStoreState: () => ({
                    fetchData: vi.fn(async () => undefined),
                    lastDataChangeAt: 0,
                    settings: {},
                    setError: vi.fn(),
                    updateSettings: vi.fn(async () => undefined),
                }) as any,
                applySyncedDataToStore: vi.fn(),
                performSyncCycle: vi.fn(async () => ({
                    data: { tasks: [], projects: [], sections: [], areas: [], settings: {} },
                    status: 'success',
                    stats: { tasks: {}, projects: {}, sections: {}, areas: {} },
                })) as any,
                invoke: vi.fn(async (command: string) => {
                    if (command === 'release_file_sync_lease') {
                        throw new Error('SYNC_FILE_LOCK_UNAVAILABLE: release failed');
                    }
                    throw new Error(`unexpected command: ${command}`);
                }) as any,
                isTauriRuntime: () => false,
            });

            const result = await SyncService.performSync({ manual: true });

            expect(result).toMatchObject({ success: true, fileSyncLockDeferred: 'cleanup' });
        } finally {
            setupSpy.mockRestore();
        }
    });

    it('restores the File Sync contention retry budget after an ordinary follow-up', async () => {
        let setupAttempt = 0;
        const setupSpy = vi.spyOn(SyncService as any, 'setupDesktopCycle').mockImplementation(async () => {
            setupAttempt += 1;
            if (setupAttempt === 1 || setupAttempt === 3) {
                throw new SyncFileLockBusyError(5);
            }
            return {
                kind: 'ready',
                backend: 'file',
                cloudProvider: 'selfhosted',
                fastSyncScope: null,
                io: {
                    readRemote: vi.fn(async () => null),
                    writeRemote: vi.fn(async () => ({
                        serverMergedRemoteData: setupAttempt === 2,
                    })),
                },
            };
        });
        try {
            __syncServiceTestUtils.setDependenciesForTests({
                flushPendingSave: vi.fn(async () => undefined),
                getStoreState: () => ({
                    fetchData: vi.fn(async () => undefined),
                    lastDataChangeAt: 0,
                    settings: {},
                    setError: vi.fn(),
                    updateSettings: vi.fn(async () => undefined),
                }) as any,
                getInMemoryAppDataSnapshot: () => emptyAppData(),
                applySyncedDataToStore: vi.fn(),
                performSyncCycle: vi.fn(async (io: any) => {
                    const local = await io.readLocal();
                    await io.writeRemote(local);
                    return {
                        data: local,
                        status: 'success',
                        stats: { tasks: {}, projects: {}, sections: {}, areas: {} },
                    };
                }) as any,
                isTauriRuntime: () => false,
            });

            await expect(SyncService.performSync({ manual: true })).resolves.toMatchObject({
                success: true,
                fileSyncLockDeferred: 'busy',
            });

            await waitForAssertion(() => expect(setupSpy).toHaveBeenCalledTimes(4));
            await waitForAssertion(() => expect(SyncService.getSyncStatus()).toMatchObject({
                inFlight: false,
                queued: false,
            }));
        } finally {
            setupSpy.mockRestore();
        }
    });

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

    it('waits for the active cycle and then proves a transient configuration on its own run', async () => {
        // An activation probe must be proven by the call that will commit it, so
        // it can neither ride the active cycle nor be queued behind it as a
        // follow-up. It used to bounce with `requeued` at once, which dropped the
        // backend switch every time an auto sync happened to be running when the
        // user pressed Save (dd's own desktop, 2026-09-02). It now waits.
        const firstRun = createDeferred();
        const backendSpy = vi.spyOn(SyncService as any, 'getSyncBackend');
        backendSpy.mockImplementation(async () => {
            await firstRun.promise;
            return 'off';
        });

        const first = SyncService.performSync();
        await waitForAssertion(() => {
            expect(SyncService.getSyncStatus().inFlight).toBe(true);
        });
        let proofSettled = false;
        const proof = SyncService.performSync({
            activationProbe: true,
            configOverride: { backend: 'off' },
            manual: true,
        }).then((result) => {
            proofSettled = true;
            return result;
        });
        // Still waiting: nothing queued behind the active cycle, nothing answered.
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(proofSettled).toBe(false);
        expect(SyncService.getSyncStatus().queued).toBe(false);

        firstRun.resolve();
        await first;
        const proofResult = await proof;
        expect(proofResult).not.toMatchObject({ skipped: 'requeued' });
        await waitForAssertion(() => {
            expect(SyncService.getSyncStatus()).toMatchObject({
                inFlight: false,
                queued: false,
            });
        });
        // The probe carried its own configOverride, so it never re-read the
        // persisted backend; the active cycle's single read is all there is.
        expect(backendSpy).toHaveBeenCalledTimes(1);
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

    it('uses the latest queued sync options for the follow-up run', async () => {
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

        const first = SyncService.performSync();
        await waitForAssertion(() => {
            expect(SyncService.getSyncStatus()).toMatchObject({
                inFlight: true,
                queued: false,
            });
        });
        const second = SyncService.performSync({ backendOverride: 'cloud' });
        const third = SyncService.performSync({ backendOverride: 'off' });
        await waitForAssertion(() => {
            expect(SyncService.getSyncStatus()).toMatchObject({
                inFlight: true,
                queued: true,
            });
        });
        firstRun.resolve();

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
        });

        expect(backendCalls).toBe(1);
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

    it('reports pending local changes for desktop auto-sync only after local data changes', () => {
        const storeState = {
            lastDataChangeAt: 0,
        };
        __syncServiceTestUtils.setDependenciesForTests({
            getStoreState: () => storeState as any,
        });

        expect(SyncService.hasPendingLocalChangesForAutoSync()).toBe(false);

        (SyncService as any).lastSuccessfulSyncLocalChangeAt = 100;
        storeState.lastDataChangeAt = 100;
        expect(SyncService.hasPendingLocalChangesForAutoSync()).toBe(false);

        storeState.lastDataChangeAt = 101;
        expect(SyncService.hasPendingLocalChangesForAutoSync()).toBe(true);
    });

    it('refreshes store data without overwriting synced settings after a successful sync', async () => {
        const callOrder: string[] = [];
        const storeState = {
            lastDataChangeAt: 0,
            settings: {},
            fetchData: vi.fn(async () => {
                callOrder.push('fetchData');
            }),
            updateSettings: vi.fn(async () => {
                callOrder.push('updateSettings');
            }),
            setError: vi.fn(),
        };
        const setupSpy = vi.spyOn(SyncService as any, 'setupDesktopCycle').mockImplementation(async (context: any) => {
            context.backend = 'file';
            context.fileSyncLeaseToken = 'cycle-lease';
            return {
                kind: 'ready',
                backend: 'file',
                cloudProvider: 'selfhosted',
                fastSyncScope: null,
                io: {
                    readRemote: vi.fn(async () => null),
                    writeRemote: vi.fn(async () => undefined),
                },
            };
        });

        try {
            __syncServiceTestUtils.setDependenciesForTests({
                flushPendingSave: vi.fn(async () => undefined),
                invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
                    if (command === 'release_file_sync_lease') {
                        expect(args?.token).toBe('cycle-lease');
                        callOrder.push('releaseFileSyncLease');
                        return undefined;
                    }
                    throw new Error(`unexpected command: ${command}`);
                }) as any,
                getStoreState: () => storeState as any,
                applySyncedDataToStore: vi.fn(() => {
                    callOrder.push('applySyncedDataToStore');
                }),
                performSyncCycle: vi.fn(async () => ({
                    data: {
                        tasks: [],
                        projects: [],
                        sections: [],
                        areas: [],
                        settings: {},
                    } satisfies AppData,
                    status: 'success' as const,
                    stats: {
                        tasks: {},
                        projects: {},
                        sections: {},
                        areas: {},
                    } as any,
                })),
            });

            const result = await SyncService.performSync();

            expect(result.success).toBe(true);
            expect(callOrder).toEqual(['applySyncedDataToStore', 'releaseFileSyncLease']);
            expect(storeState.fetchData).not.toHaveBeenCalled();
            expect(storeState.updateSettings).not.toHaveBeenCalled();
        } finally {
            setupSpy.mockRestore();
        }
    });

    it('does not record fast-sync state after post-remote attachment phases change the sync payload', async () => {
        const syncedData: AppData = {
            tasks: [{
                id: 'task-1',
                title: 'Before cleanup',
                status: 'next',
                tags: [],
                contexts: [],
                // The attachment phases are gated on there being attachment work at
                // all, so the payload-mutating pass below needs something to act on.
                attachments: [{
                    id: 'attachment-1',
                    kind: 'file',
                    title: 'notes.pdf',
                    uri: '/tmp/notes.pdf',
                    createdAt: '2026-04-01T00:00:00.000Z',
                    updatedAt: '2026-04-01T00:00:00.000Z',
                }],
                createdAt: '2026-04-01T00:00:00.000Z',
                updatedAt: '2026-04-01T00:00:00.000Z',
            }],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        };
        const storeState = {
            lastDataChangeAt: 0,
            settings: {},
            fetchData: vi.fn(async () => undefined),
            updateSettings: vi.fn(async () => undefined),
            setError: vi.fn(),
        };
        const readRemoteFingerprint = vi.fn(async () => 'remote-fp-1');
        // Post-merge attachment pass changes the payload; recording fast-sync
        // state afterwards would cache a stale local fingerprint.
        const setupSpy = vi.spyOn(SyncService as any, 'setupDesktopCycle').mockImplementation(async () => ({
            kind: 'ready',
            backend: 'file',
            cloudProvider: 'selfhosted',
            fastSyncScope: 'scope-fast-state-test',
            io: {
                readRemote: vi.fn(async () => null),
                writeRemote: vi.fn(async () => undefined),
                readRemoteFingerprint,
                syncAttachments: vi.fn(async (data: AppData) => ({
                    ...data,
                    tasks: [{
                        ...data.tasks[0],
                        title: 'After cleanup',
                    }],
                })),
            },
        }));
        localStorage.removeItem('mindwtr-fast-sync-state-v1');

        try {
            __syncServiceTestUtils.setDependenciesForTests({
                isTauriRuntime: () => true,
                invoke: vi.fn(async (command: string) => (
                    command === 'get_data' ? (syncedData as unknown) : undefined
                )) as any,
                markLocalWrite: vi.fn(),
                markLocalSqliteWrite: vi.fn(),
                applySyncedDataToStore: vi.fn(),
                getExternalCalendars: async () => [],
                setExternalCalendars: vi.fn(),
                flushPendingSave: vi.fn(async () => undefined),
                getStoreState: () => storeState as any,
                performSyncCycle: vi.fn(async () => ({
                    data: syncedData,
                    status: 'success' as const,
                    stats: {
                        tasks: {},
                        projects: {},
                        sections: {},
                        areas: {},
                    } as any,
                })),
            });

            const result = await SyncService.performSync();

            expect(result.success).toBe(true);
            expect(localStorage.getItem('mindwtr-fast-sync-state-v1')).toBeNull();
            expect(readRemoteFingerprint).not.toHaveBeenCalled();
        } finally {
            setupSpy.mockRestore();
            localStorage.removeItem('mindwtr-fast-sync-state-v1');
        }
    });
});

// #1060: the connection-status probe reruns on every settings visit and
// auto-sync tick; a persistently broken keyring must not re-report the same
// failure each time, but a new failure (or a break after recovery) stays loud.
describe('Dropbox connection status probe reporting', () => {
    it('reports each distinct probe failure once, re-arming after success', async () => {
        const reportError = vi.fn();
        let failure: string | null = 'keyring down';
        const invoke = vi.fn(async (command: string) => {
            if (command === 'is_dropbox_connected') {
                if (failure) throw new Error(failure);
                return true;
            }
            return undefined;
        });
        __syncServiceTestUtils.setDependenciesForTests({
            isTauriRuntime: () => true,
            invoke: invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
            reportError,
        });

        await expect(SyncService.isDropboxConnected('app-key')).resolves.toBe(false);
        await expect(SyncService.isDropboxConnected('app-key')).resolves.toBe(false);
        expect(reportError).toHaveBeenCalledTimes(1);

        failure = 'portal denied';
        await expect(SyncService.isDropboxConnected('app-key')).resolves.toBe(false);
        expect(reportError).toHaveBeenCalledTimes(2);

        failure = null;
        await expect(SyncService.isDropboxConnected('app-key')).resolves.toBe(true);

        failure = 'keyring down';
        await expect(SyncService.isDropboxConnected('app-key')).resolves.toBe(false);
        expect(reportError).toHaveBeenCalledTimes(3);
    });
});
