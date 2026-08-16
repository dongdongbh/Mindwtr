import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppData } from '@mindwtr/core';

import {
    clearAttachmentSyncState,
    syncCloudAttachments,
    syncCloudKitAttachments,
    syncFileAttachments,
    syncWebdavAttachments,
    type AttachmentBackendDeps,
} from './sync-attachment-backends';

const coreMocks = vi.hoisted(() => ({
    webdavFileExists: vi.fn(),
    webdavMakeDirectory: vi.fn(),
    withRetry: vi.fn((operation: () => Promise<unknown>) => operation()),
}));

const fsMocks = vi.hoisted(() => ({
    BaseDirectory: { Data: 'Data' },
    exists: vi.fn(),
    mkdir: vi.fn(),
    readFile: vi.fn(),
    remove: vi.fn(),
    rename: vi.fn(),
    writeFile: vi.fn(),
}));

// #1037: the file backend must reach the sync folder through the async Rust
// commands, never the fs plugin's main-thread exists/mkdir/remove/rename.
const syncFsMocks = vi.hoisted(() => ({
    exists: vi.fn(),
    mkdir: vi.fn(),
    remove: vi.fn(),
    rename: vi.fn(),
}));

const pathMocks = vi.hoisted(() => ({
    dataDir: vi.fn(),
    join: vi.fn(),
}));

const cloudKitMocks = vi.hoisted(() => ({
    deleteCloudKitAttachmentAssets: vi.fn(),
    fetchCloudKitAttachmentAsset: vi.fn(),
    saveCloudKitAttachmentAsset: vi.fn(),
}));

vi.mock('@mindwtr/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@mindwtr/core')>();
    return {
        ...actual,
        webdavFileExists: coreMocks.webdavFileExists,
        webdavMakeDirectory: coreMocks.webdavMakeDirectory,
        withRetry: coreMocks.withRetry,
    };
});
vi.mock('@tauri-apps/plugin-fs', () => fsMocks);
vi.mock('./sync-fs', () => syncFsMocks);
vi.mock('@tauri-apps/api/path', () => pathMocks);
vi.mock('./cloudkit-sync', () => cloudKitMocks);

const errorResponse = (status: number, statusText: string): Response =>
    ({
        ok: false,
        status,
        statusText,
        headers: new Headers(),
        body: null,
        arrayBuffer: async () => new ArrayBuffer(0),
    }) as Response;

const createCandidateAttachmentData = (): AppData => ({
    tasks: [
        {
            id: 'task-1',
            title: 'Task',
            status: 'next',
            tags: [],
            contexts: [],
            attachments: [
                {
                    id: 'attachment-1',
                    kind: 'file',
                    title: 'candidate-proof.txt',
                    uri: '/data/candidate-proof.txt',
                    cloudKey: 'attachments/attachment-1.txt',
                    localStatus: 'available',
                    createdAt: '2026-08-03T00:00:00.000Z',
                    updatedAt: '2026-08-03T00:00:00.000Z',
                },
            ],
            createdAt: '2026-08-03T00:00:00.000Z',
            updatedAt: '2026-08-03T00:00:00.000Z',
        },
    ],
    projects: [],
    sections: [],
    areas: [],
    settings: {},
});

const activationHelpers = () => ({
    activationProbe: true,
    ensureLocalSnapshotFresh: vi.fn(),
});

describe('desktop sync attachment backends', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearAttachmentSyncState();
        pathMocks.dataDir.mockResolvedValue('/app-data');
        pathMocks.join.mockImplementation(async (...parts: string[]) => parts.join('/'));
        fsMocks.mkdir.mockResolvedValue(undefined);
        syncFsMocks.mkdir.mockResolvedValue(undefined);
        syncFsMocks.rename.mockResolvedValue(undefined);
        syncFsMocks.remove.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('marks cloud attachments unrecoverable when the remote file is missing', async () => {
        const fetcher = vi.fn(async () => errorResponse(404, 'Not Found'));
        const logSyncWarning = vi.fn();
        const appData: AppData = {
            tasks: [
                {
                    id: 'task-1',
                    title: 'Task',
                    status: 'next',
                    tags: [],
                    contexts: [],
                    attachments: [
                        {
                            id: 'attachment-1',
                            kind: 'file',
                            title: 'PXL_20260604_232051859.jpg',
                            uri: '',
                            cloudKey: 'attachments/attachment-1.jpg',
                            localStatus: 'missing',
                            fileHash: 'a'.repeat(64),
                            createdAt: '2026-06-07T00:00:00.000Z',
                            updatedAt: '2026-06-07T00:00:00.000Z',
                        },
                    ],
                    createdAt: '2026-06-07T00:00:00.000Z',
                    updatedAt: '2026-06-07T00:00:00.000Z',
                },
            ],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        };
        const deps: AttachmentBackendDeps = {
            getTauriFetch: async () => fetcher as unknown as typeof fetch,
            isTauriRuntimeEnv: () => true,
            logSyncInfo: vi.fn(),
            logSyncWarning,
            resolveWebdavPassword: vi.fn(),
        };

        await expect(
            syncCloudAttachments(
                appData,
                { url: 'https://cloud.example/v1/data', token: 'token' },
                'https://cloud.example/v1',
                deps,
            ),
        ).resolves.toBe(true);

        const attachment = appData.tasks[0].attachments?.[0];
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(attachment?.cloudKey).toBeUndefined();
        expect(attachment?.fileHash).toBeUndefined();
        expect(attachment?.localStatus).toBe('missing');
        expect(attachment?.deletedAt).toBeDefined();
        expect(logSyncWarning).not.toHaveBeenCalledWith(
            expect.stringContaining('Failed to download attachment'),
            expect.anything(),
        );
    });

    it('uploads self-hosted cloud attachments selected from Windows paths', async () => {
        const bytes = new Uint8Array([1, 2, 3]);
        const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
        const logSyncWarning = vi.fn();
        const appData: AppData = {
            tasks: [
                {
                    id: 'task-1',
                    title: 'Task',
                    status: 'next',
                    tags: [],
                    contexts: [],
                    attachments: [
                        {
                            id: 'attachment-1',
                            kind: 'file',
                            title: 'mindwtr-upload-test.txt',
                            uri: 'C:\\Temp\\mindwtr-upload-test.txt',
                            localStatus: 'available',
                            createdAt: '2026-06-27T00:00:00.000Z',
                            updatedAt: '2026-06-27T00:00:00.000Z',
                        },
                    ],
                    createdAt: '2026-06-27T00:00:00.000Z',
                    updatedAt: '2026-06-27T00:00:00.000Z',
                },
            ],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        };
        const deps: AttachmentBackendDeps = {
            getTauriFetch: async () => fetcher as unknown as typeof fetch,
            isTauriRuntimeEnv: () => true,
            logSyncInfo: vi.fn(),
            logSyncWarning,
            resolveWebdavPassword: vi.fn(),
        };

        fsMocks.exists.mockImplementation(async (path: string) => path === 'C:/Temp/mindwtr-upload-test.txt');
        fsMocks.readFile.mockImplementation(async (path: string) => {
            if (path !== 'C:/Temp/mindwtr-upload-test.txt') {
                throw new Error('unexpected path ' + path);
            }
            return bytes;
        });

        await expect(
            syncCloudAttachments(
                appData,
                { url: 'http://cloud.local/v1/data', token: 'token', allowInsecureHttp: true },
                'http://cloud.local/v1',
                deps,
            ),
        ).resolves.toBe(true);

        const attachment = appData.tasks[0].attachments?.[0];
        expect(fsMocks.exists).toHaveBeenCalledWith('C:/Temp/mindwtr-upload-test.txt');
        expect(fsMocks.readFile).toHaveBeenCalledWith('C:/Temp/mindwtr-upload-test.txt');
        expect(fetcher).toHaveBeenCalledWith(
            'http://cloud.local/v1/attachments/attachment-1.txt',
            expect.objectContaining({ method: 'PUT' }),
        );
        expect(attachment?.cloudKey).toBe('attachments/attachment-1.txt');
        expect(attachment?.localStatus).toBe('available');
        expect(logSyncWarning).not.toHaveBeenCalledWith(
            expect.stringContaining('Failed to upload attachment'),
            expect.anything(),
        );
    });

    it('re-uploads a locally available attachment with an old cloud key during a self-hosted activation probe', async () => {
        const bytes = new Uint8Array([1, 2, 3]);
        const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
        const appData = createCandidateAttachmentData();
        const deps: AttachmentBackendDeps = {
            getTauriFetch: async () => fetcher as unknown as typeof fetch,
            isTauriRuntimeEnv: () => true,
            logSyncInfo: vi.fn(),
            logSyncWarning: vi.fn(),
            resolveWebdavPassword: vi.fn(),
        };
        fsMocks.exists.mockResolvedValue(true);
        fsMocks.readFile.mockResolvedValue(bytes);

        await syncCloudAttachments(
            appData,
            { url: 'https://candidate.example/v1/data', token: 'candidate-token' },
            'https://candidate.example/v1',
            deps,
            activationHelpers(),
        );

        expect(fetcher).toHaveBeenCalledWith(
            'https://candidate.example/v1/attachments/attachment-1.txt',
            expect.objectContaining({ method: 'PUT' }),
        );
        expect(appData.tasks[0].attachments?.[0]?.cloudKey).toBe('attachments/attachment-1.txt');
    });

    it('clears stale candidate proof when an activation-probe attachment upload fails', async () => {
        const fetcher = vi.fn(async () => errorResponse(503, 'Unavailable'));
        const appData = createCandidateAttachmentData();
        const deps: AttachmentBackendDeps = {
            getTauriFetch: async () => fetcher as unknown as typeof fetch,
            isTauriRuntimeEnv: () => true,
            logSyncInfo: vi.fn(),
            logSyncWarning: vi.fn(),
            resolveWebdavPassword: vi.fn(),
        };
        fsMocks.exists.mockResolvedValue(true);
        fsMocks.readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));

        await syncCloudAttachments(
            appData,
            { url: 'https://candidate.example/v1/data', token: 'candidate-token' },
            'https://candidate.example/v1',
            deps,
            activationHelpers(),
        );

        expect(fetcher).toHaveBeenCalledWith(
            'https://candidate.example/v1/attachments/attachment-1.txt',
            expect.objectContaining({ method: 'PUT' }),
        );
        expect(appData.tasks[0].attachments?.[0]?.cloudKey).toBeUndefined();
    });

    it('re-copies a locally available attachment with an old cloud key during a file activation probe', async () => {
        const bytes = new Uint8Array([1, 2, 3]);
        const appData = createCandidateAttachmentData();
        const deps: AttachmentBackendDeps = {
            getTauriFetch: vi.fn(),
            isTauriRuntimeEnv: () => true,
            logSyncInfo: vi.fn(),
            logSyncWarning: vi.fn(),
            resolveWebdavPassword: vi.fn(),
        };
        syncFsMocks.exists.mockResolvedValue(true);
        fsMocks.readFile.mockResolvedValue(bytes);

        await syncFileAttachments(
            appData,
            '/candidate-sync',
            deps,
            activationHelpers(),
        );

        expect(fsMocks.writeFile).toHaveBeenCalledWith(
            expect.stringMatching(/^\/candidate-sync\/attachments\/attachment-1\.txt\.tmp-/),
            bytes,
        );
        // Never the fs plugin's rename: it is a main-thread command and the
        // sync folder may be a slow mount (#1037).
        expect(fsMocks.rename).not.toHaveBeenCalled();
        expect(syncFsMocks.rename).toHaveBeenCalledWith(
            expect.stringMatching(/^\/candidate-sync\/attachments\/attachment-1\.txt\.tmp-/),
            '/candidate-sync/attachments/attachment-1.txt',
        );
        expect(appData.tasks[0].attachments?.[0]?.cloudKey).toBe('attachments/attachment-1.txt');
    });

    it('re-copies a locally available attachment into a sync folder that is missing it on a regular sync', async () => {
        // #1001: switching the File Sync folder outside the settings UI left
        // attachments/ empty forever — the recorded cloudKey pointed at the
        // old folder and nothing re-verified presence in the current one.
        const bytes = new Uint8Array([1, 2, 3]);
        const appData = createCandidateAttachmentData();
        const deps: AttachmentBackendDeps = {
            getTauriFetch: vi.fn(),
            isTauriRuntimeEnv: () => true,
            logSyncInfo: vi.fn(),
            logSyncWarning: vi.fn(),
            resolveWebdavPassword: vi.fn(),
        };
        syncFsMocks.exists.mockImplementation(async (path: string) => !String(path).startsWith('/candidate-sync/'));
        fsMocks.readFile.mockResolvedValue(bytes);

        const mutated = await syncFileAttachments(appData, '/candidate-sync', deps);

        expect(syncFsMocks.rename).toHaveBeenCalledWith(
            expect.stringMatching(/^\/candidate-sync\/attachments\/attachment-1\.txt\.tmp-/),
            '/candidate-sync/attachments/attachment-1.txt',
        );
        expect(appData.tasks[0].attachments?.[0]?.cloudKey).toBe('attachments/attachment-1.txt');
        expect(mutated).toBe(true);
        // The sync folder is only ever touched off the main thread (#1037).
        expect(fsMocks.exists).not.toHaveBeenCalled();
        expect(fsMocks.mkdir).not.toHaveBeenCalled();
    });

    it('keeps an attachment cloud key when its local copy is missing, even if the sync folder lacks the file', async () => {
        const appData = createCandidateAttachmentData();
        const deps: AttachmentBackendDeps = {
            getTauriFetch: vi.fn(),
            isTauriRuntimeEnv: () => true,
            logSyncInfo: vi.fn(),
            logSyncWarning: vi.fn(),
            resolveWebdavPassword: vi.fn(),
        };
        syncFsMocks.exists.mockResolvedValue(false);

        await syncFileAttachments(appData, '/candidate-sync', deps);

        expect(appData.tasks[0].attachments?.[0]?.cloudKey).toBe('attachments/attachment-1.txt');
        expect(fsMocks.writeFile).not.toHaveBeenCalled();
        // The sync folder is only ever stat'd off the main thread (#1037).
        expect(fsMocks.exists).not.toHaveBeenCalled();
        expect(fsMocks.mkdir).not.toHaveBeenCalled();
    });

    it('keeps WebDAV attachment sync in cooldown across repeated sync runs after rate limiting', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-12T00:00:00.000Z'));
        const rateLimitError = Object.assign(new Error('WebDAV MKCOL failed (503)'), { status: 503 });
        const logSyncInfo = vi.fn();
        const logSyncWarning = vi.fn();
        const deps: AttachmentBackendDeps = {
            getTauriFetch: vi.fn(async () => undefined),
            isTauriRuntimeEnv: () => true,
            logSyncInfo,
            logSyncWarning,
            resolveWebdavPassword: vi.fn(async () => 'secret'),
        };
        const appData: AppData = {
            tasks: [],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        };
        coreMocks.webdavMakeDirectory.mockRejectedValueOnce(rateLimitError);

        await expect(
            syncWebdavAttachments(
                appData,
                { url: 'https://dav.example/mindwtr', username: 'alice' },
                'https://dav.example/mindwtr',
                deps,
            ),
        ).resolves.toBeNull();
        await expect(
            syncWebdavAttachments(
                appData,
                { url: 'https://dav.example/mindwtr', username: 'alice' },
                'https://dav.example/mindwtr',
                deps,
            ),
        ).resolves.toBeNull();

        expect(coreMocks.webdavMakeDirectory).toHaveBeenCalledTimes(1);
        expect(logSyncWarning).toHaveBeenCalledWith('WebDAV rate limited; pausing attachment sync', rateLimitError);
        expect(logSyncInfo).toHaveBeenCalledWith(
            'WebDAV attachment sync skipped during rate-limit cooldown',
            { remainingMs: '60000' },
        );

        vi.advanceTimersByTime(60_000);
        coreMocks.webdavMakeDirectory.mockResolvedValueOnce(undefined);

        await expect(
            syncWebdavAttachments(
                appData,
                { url: 'https://dav.example/mindwtr', username: 'alice' },
                'https://dav.example/mindwtr',
                deps,
            ),
        ).resolves.toBeNull();

        expect(coreMocks.webdavMakeDirectory).toHaveBeenCalledTimes(2);
    });

    it('caps WebDAV uploads per sync run and logs once when the limit is reached', async () => {
        // WEBDAV_ATTACHMENT_MAX_UPLOADS_PER_SYNC is 10; one attachment over that must be skipped.
        const attachmentCount = 11;
        const bytes = new Uint8Array([1, 2, 3]);
        const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 200 }));
        const logSyncInfo = vi.fn();
        const logSyncWarning = vi.fn();
        const appData: AppData = {
            tasks: Array.from({ length: attachmentCount }, (_, index) => ({
                id: `task-${index}`,
                title: `Task ${index}`,
                status: 'next',
                tags: [],
                contexts: [],
                attachments: [
                    {
                        id: `attachment-${index}`,
                        kind: 'file',
                        title: `file-${index}.txt`,
                        uri: `/data/file-${index}.txt`,
                        createdAt: '2026-06-27T00:00:00.000Z',
                        updatedAt: '2026-06-27T00:00:00.000Z',
                    },
                ],
                createdAt: '2026-06-27T00:00:00.000Z',
                updatedAt: '2026-06-27T00:00:00.000Z',
            })),
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        };
        const deps: AttachmentBackendDeps = {
            getTauriFetch: async () => fetcher as unknown as typeof fetch,
            isTauriRuntimeEnv: () => true,
            logSyncInfo,
            logSyncWarning,
            resolveWebdavPassword: vi.fn(async () => 'secret'),
        };

        fsMocks.exists.mockResolvedValue(true);
        fsMocks.readFile.mockResolvedValue(bytes);

        const result = await syncWebdavAttachments(
            appData,
            { url: 'https://dav.example/mindwtr', username: 'alice' },
            'https://dav.example/mindwtr',
            deps,
        );

        expect(result).not.toBeNull();
        const uploadedCount = result!.tasks.filter((task) => task.attachments?.[0]?.cloudKey).length;
        expect(uploadedCount).toBe(10);
        const putCalls = fetcher.mock.calls.filter(([, init]) => (init as RequestInit)?.method === 'PUT');
        expect(putCalls).toHaveLength(10);
        expect(logSyncInfo).toHaveBeenCalledWith('WebDAV attachment upload limit reached', { limit: '10' });
        expect(logSyncWarning).not.toHaveBeenCalledWith(
            expect.stringContaining('Failed to upload attachment'),
            expect.anything(),
        );
    });

    it('re-uploads a locally available attachment with an old cloud key during a WebDAV activation probe', async () => {
        const bytes = new Uint8Array([1, 2, 3]);
        const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
        const appData = createCandidateAttachmentData();
        const deps: AttachmentBackendDeps = {
            getTauriFetch: async () => fetcher as unknown as typeof fetch,
            isTauriRuntimeEnv: () => true,
            logSyncInfo: vi.fn(),
            logSyncWarning: vi.fn(),
            resolveWebdavPassword: vi.fn(async () => 'secret'),
        };
        fsMocks.exists.mockResolvedValue(true);
        fsMocks.readFile.mockResolvedValue(bytes);
        coreMocks.webdavFileExists.mockResolvedValue(true);

        const result = await syncWebdavAttachments(
            appData,
            { url: 'https://candidate.example/mindwtr', username: 'alice' },
            'https://candidate.example/mindwtr',
            deps,
            activationHelpers(),
        );

        expect(fetcher).toHaveBeenCalledWith(
            'https://candidate.example/mindwtr/attachments/attachment-1.txt',
            expect.objectContaining({ method: 'PUT' }),
        );
        expect(result?.tasks[0].attachments?.[0]?.cloudKey).toBe('attachments/attachment-1.txt');
    });

    it('uploads local attachments to CloudKit and flushes CloudKit pending deletes', async () => {
        const bytes = new Uint8Array([1, 2, 3]);
        const logSyncWarning = vi.fn();
        const appData: AppData = {
            tasks: [
                {
                    id: 'task-1',
                    title: 'Task',
                    status: 'next',
                    tags: [],
                    contexts: [],
                    attachments: [
                        {
                            id: 'attachment-1',
                            kind: 'file',
                            title: 'photo.jpg',
                            uri: '/app-data/mindwtr/attachments/photo.jpg',
                            localStatus: 'available',
                            createdAt: '2026-06-07T00:00:00.000Z',
                            updatedAt: '2026-06-07T00:00:00.000Z',
                        },
                    ],
                    createdAt: '2026-06-07T00:00:00.000Z',
                    updatedAt: '2026-06-07T00:00:00.000Z',
                },
            ],
            projects: [],
            sections: [],
            areas: [],
            settings: {
                attachments: {
                    pendingRemoteDeletes: [
                        { cloudKey: 'cloudkit:old-attachment' },
                        { cloudKey: 'attachments/legacy-file.jpg' },
                    ],
                },
            },
        };
        const deps: AttachmentBackendDeps = {
            getTauriFetch: vi.fn(),
            isTauriRuntimeEnv: () => true,
            logSyncInfo: vi.fn(),
            logSyncWarning,
            resolveWebdavPassword: vi.fn(),
        };

        pathMocks.dataDir.mockResolvedValue('/app-data');
        pathMocks.join.mockImplementation(async (...parts: string[]) => parts.join('/'));
        fsMocks.mkdir.mockResolvedValue(undefined);
        fsMocks.exists.mockResolvedValue(true);
        fsMocks.readFile.mockResolvedValue(bytes);
        cloudKitMocks.deleteCloudKitAttachmentAssets.mockResolvedValue(undefined);
        cloudKitMocks.saveCloudKitAttachmentAsset.mockResolvedValue({
            recordName: 'attachment-1',
            attachmentId: 'attachment-1',
            ownerType: 'task',
            ownerId: 'task-1',
            title: 'photo.jpg',
            size: 3,
            updatedAt: '2026-06-07T00:00:00.000Z',
        });

        await expect(syncCloudKitAttachments(appData, deps)).resolves.toBe(true);

        const attachment = appData.tasks[0].attachments?.[0];
        expect(cloudKitMocks.deleteCloudKitAttachmentAssets).toHaveBeenCalledWith(['old-attachment']);
        expect(cloudKitMocks.saveCloudKitAttachmentAsset).toHaveBeenCalledWith(
            'attachment-1',
            '/app-data/mindwtr/attachments/photo.jpg',
            expect.objectContaining({
                attachmentId: 'attachment-1',
                ownerType: 'task',
                ownerId: 'task-1',
                title: 'photo.jpg',
                size: 3,
            }),
        );
        expect(attachment?.cloudKey).toBe('cloudkit:attachment-1');
        expect(attachment?.localStatus).toBe('available');
        expect(attachment?.size).toBe(3);
        expect(appData.settings.attachments?.pendingRemoteDeletes).toEqual([
            { cloudKey: 'attachments/legacy-file.jpg' },
        ]);
        expect(logSyncWarning).not.toHaveBeenCalled();
    });
});
