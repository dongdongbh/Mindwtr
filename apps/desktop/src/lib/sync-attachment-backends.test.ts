import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncRemoteMutationFenceLostError, type AppData } from '@mindwtr/core';

import {
    clearAttachmentSyncState,
    syncCloudAttachments,
    syncCloudKitAttachments,
    syncDropboxAttachments,
    syncFileAttachments,
    syncWebdavAttachments,
    type AttachmentBackendDeps,
} from './sync-attachment-backends';

const coreMocks = vi.hoisted(() => ({
    webdavFileExists: vi.fn(),
    webdavHeadFile: vi.fn(),
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
    // #1057: check-on-touch content detection stats the local file; default to a
    // rejection so tests that don't care about it see "no stat available" (the
    // lifecycle treats that as if getLocalFileStat were omitted) rather than a
    // silently-resolved bogus value.
    stat: vi.fn().mockRejectedValue(new Error('not stubbed')),
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

const dropboxMocks = vi.hoisted(() => ({
    downloadDropboxFile: vi.fn(),
    getDropboxFileMetadata: vi.fn(),
    uploadDropboxFile: vi.fn(),
}));

const installerMocks = vi.hoisted(() => ({
    installAttachmentDownload: vi.fn(),
}));

vi.mock('@mindwtr/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@mindwtr/core')>();
    return {
        ...actual,
        webdavFileExists: coreMocks.webdavFileExists,
        webdavHeadFile: coreMocks.webdavHeadFile,
        webdavMakeDirectory: coreMocks.webdavMakeDirectory,
        withRetry: coreMocks.withRetry,
    };
});
vi.mock('@tauri-apps/plugin-fs', () => fsMocks);
vi.mock('./sync-fs', () => syncFsMocks);
vi.mock('@tauri-apps/api/path', () => pathMocks);
vi.mock('./cloudkit-sync', () => cloudKitMocks);
vi.mock('./dropbox-sync', () => ({
    downloadDropboxFile: dropboxMocks.downloadDropboxFile,
    getDropboxFileMetadata: dropboxMocks.getDropboxFileMetadata,
    uploadDropboxFileVersioned: dropboxMocks.uploadDropboxFile,
    DropboxConflictError: class DropboxConflictError extends Error {},
    DropboxFileNotFoundError: class DropboxFileNotFoundError extends Error {},
    DropboxUnauthorizedError: class DropboxUnauthorizedError extends Error {},
}));
vi.mock('./attachment-installer', () => ({
    installAttachmentDownload: installerMocks.installAttachmentDownload,
}));

/** Backends now return the folded document instead of mutating the one they were given. */
const expectFoldedData = (result: AppData | boolean | null | undefined): AppData => {
    expect(typeof result === 'object' && result !== null).toBe(true);
    return result as AppData;
};

const deepFreeze = <T>(value: T): T => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    }
    return value;
};

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
                    uri: '/app-data/mindwtr/attachments/candidate-proof.txt',
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

const DOWNLOAD_BYTES = new Uint8Array([1, 2, 3]);
const DOWNLOAD_BYTES_HASH = '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81';

type DownloadBackend = 'webdav' | 'cloud' | 'dropbox' | 'cloudkit' | 'file';

describe('desktop sync attachment backends', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        installerMocks.installAttachmentDownload.mockReset();
        installerMocks.installAttachmentDownload.mockResolvedValue({ kind: 'installed' });
        clearAttachmentSyncState();
        pathMocks.dataDir.mockResolvedValue('/app-data');
        pathMocks.join.mockImplementation(async (...parts: string[]) => parts.join('/'));
        fsMocks.mkdir.mockResolvedValue(undefined);
        fsMocks.stat.mockResolvedValue({ mtime: new Date(1000), size: 3 });
        syncFsMocks.mkdir.mockResolvedValue(undefined);
        syncFsMocks.rename.mockResolvedValue(undefined);
        syncFsMocks.remove.mockResolvedValue(undefined);
        coreMocks.webdavHeadFile.mockResolvedValue({
            exists: false,
            fingerprint: null,
            etag: null,
            lastModified: null,
            contentLength: null,
        });
        dropboxMocks.getDropboxFileMetadata.mockResolvedValue({ rev: null });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    const createDownloadData = (backend: DownloadBackend): AppData => ({
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
                        title: 'download.txt',
                        uri: '',
                        cloudKey: backend === 'cloudkit'
                            ? 'cloudkit:attachment-1'
                            : 'attachments/attachment-1.txt',
                        localStatus: 'missing',
                        createdAt: '2026-08-27T00:00:00.000Z',
                        updatedAt: '2026-08-27T00:00:00.000Z',
                    },
                ],
                createdAt: '2026-08-27T00:00:00.000Z',
                updatedAt: '2026-08-27T00:00:00.000Z',
            },
        ],
        projects: [],
        sections: [],
        areas: [],
        settings: {},
    });

    const runDownload = async (
        backend: DownloadBackend,
        appData: AppData,
        deps: AttachmentBackendDeps,
    ): Promise<AppData | false | null> => {
        switch (backend) {
            case 'webdav':
                return syncWebdavAttachments(
                    appData,
                    { url: 'https://dav.example/mindwtr', username: 'alice' },
                    'https://dav.example/mindwtr',
                    deps,
                );
            case 'cloud':
                return syncCloudAttachments(
                    appData,
                    { url: 'https://cloud.example/v1/data', token: 'token' },
                    'https://cloud.example/v1',
                    deps,
                );
            case 'dropbox':
                return syncDropboxAttachments(appData, async () => 'dropbox-token', deps);
            case 'cloudkit':
                return syncCloudKitAttachments(appData, deps);
            case 'file':
                return syncFileAttachments(appData, '/sync-root', deps);
        }
    };

    it.each<DownloadBackend>(['webdav', 'cloud', 'dropbox', 'cloudkit', 'file'])(
        'stages and generation-binds an absent %s attachment download before publishing metadata',
        async (backend) => {
            const fetcher = vi.fn(async () => new Response(DOWNLOAD_BYTES.slice().buffer, { status: 200 }));
            const deps: AttachmentBackendDeps = {
                getTauriFetch: async () => fetcher as unknown as typeof fetch,
                isTauriRuntimeEnv: () => true,
                logSyncInfo: vi.fn(),
                logSyncWarning: vi.fn(),
                resolveWebdavPassword: vi.fn(async () => 'secret'),
            };
            const appData = createDownloadData(backend);
            fsMocks.readFile.mockResolvedValue(DOWNLOAD_BYTES);
            syncFsMocks.exists.mockResolvedValue(true);
            dropboxMocks.downloadDropboxFile.mockResolvedValue(DOWNLOAD_BYTES.slice().buffer);
            cloudKitMocks.fetchCloudKitAttachmentAsset.mockResolvedValue({
                recordName: 'attachment-1',
                attachmentId: 'attachment-1',
                ownerType: 'task',
                ownerId: 'task-1',
                title: 'download.txt',
                size: DOWNLOAD_BYTES.length,
                updatedAt: '2026-08-27T00:00:00.000Z',
            });

            const result = expectFoldedData(await runDownload(backend, appData, deps));
            const installCall = installerMocks.installAttachmentDownload.mock.calls[0];
            expect(installCall).toBeDefined();
            const [stagedPath, targetPath, expectation, expectedDownloadSha256] = installCall;
            expect(stagedPath).toMatch(/^\/app-data\/mindwtr\/attachments\/\.download-/);
            expect(targetPath).toBe('/app-data/mindwtr/attachments/attachment-1.txt');
            expect(expectation).toEqual({ kind: 'absent' });
            expect(expectedDownloadSha256).toBe(DOWNLOAD_BYTES_HASH);
            if (backend === 'cloudkit') {
                expect(cloudKitMocks.fetchCloudKitAttachmentAsset).toHaveBeenCalledWith(
                    'attachment-1',
                    stagedPath,
                );
                expect(cloudKitMocks.fetchCloudKitAttachmentAsset).not.toHaveBeenCalledWith(
                    'attachment-1',
                    targetPath,
                );
            } else {
                expect(fsMocks.writeFile).toHaveBeenCalledWith(stagedPath, DOWNLOAD_BYTES);
            }
            expect(fsMocks.remove).toHaveBeenCalledWith(stagedPath);
            expect(result.tasks[0].attachments?.[0]).toMatchObject({
                uri: targetPath,
                localStatus: 'available',
                fileHash: DOWNLOAD_BYTES_HASH,
            });
            expect(appData.tasks[0].attachments?.[0]).toMatchObject({
                uri: '',
                localStatus: 'missing',
            });
        },
    );

    it('preserves a staged download and attachment metadata when the installer detects a local-edit race', async () => {
        const localBytes = new Uint8Array([4, 5, 6]);
        const localBytesHash = '787c798e39a5bc1910355bae6d0cd87a36b2e10fd0202a83e3bb6b005da83472';
        const canonicalPath = '/app-data/mindwtr/attachments/local-edit.txt';
        const appData = createDownloadData('cloud');
        Object.assign(appData.tasks[0].attachments![0], {
            uri: canonicalPath,
            localStatus: 'available',
            fileHash: DOWNLOAD_BYTES_HASH,
            contentMtimeMs: 1000,
            contentSize: localBytes.length,
        });
        const fetcher = vi.fn(async () => new Response(DOWNLOAD_BYTES.slice().buffer, { status: 200 }));
        const deps: AttachmentBackendDeps = {
            getTauriFetch: async () => fetcher as unknown as typeof fetch,
            isTauriRuntimeEnv: () => true,
            logSyncInfo: vi.fn(),
            logSyncWarning: vi.fn(),
            resolveWebdavPassword: vi.fn(),
        };
        fsMocks.exists.mockResolvedValue(true);
        fsMocks.readFile.mockResolvedValue(localBytes);
        fsMocks.stat.mockResolvedValue({ mtime: new Date(2000), size: localBytes.length });
        installerMocks.installAttachmentDownload.mockResolvedValue({
            kind: 'conflict',
            reason: 'generation-mismatch',
            preservedPath: canonicalPath,
        });

        const result = await syncCloudAttachments(
            appData,
            { url: 'https://cloud.example/v1/data', token: 'token' },
            'https://cloud.example/v1',
            deps,
            { activationProbe: false, ensureLocalSnapshotFresh: vi.fn(), phase: 'post-merge' },
        );

        expect(result).toBe(false);
        const [stagedPath, targetPath, expectation, expectedDownloadSha256] =
            installerMocks.installAttachmentDownload.mock.calls[0];
        expect(stagedPath).toMatch(/^\/app-data\/mindwtr\/attachments\/\.download-/);
        expect(targetPath).toBe(canonicalPath);
        expect(expectation).toEqual({ kind: 'present', sha256: localBytesHash });
        expect(expectedDownloadSha256).toBe(DOWNLOAD_BYTES_HASH);
        expect(fsMocks.remove).not.toHaveBeenCalledWith(stagedPath);
        expect(deps.logSyncInfo).toHaveBeenCalledWith(
            'Attachment download deferred after local-edit race',
            {
                id: 'attachment-1',
                backend: 'cloud',
                reason: 'generation-mismatch',
            },
        );
        const conflictDetails = (deps.logSyncInfo as ReturnType<typeof vi.fn>).mock.calls
            .find(([message]) => message === 'Attachment download deferred after local-edit race')?.[1];
        expect(conflictDetails).not.toHaveProperty('stagedPath');
        expect(conflictDetails).not.toHaveProperty('preservedPath');
        expect(appData.tasks[0].attachments?.[0]).toMatchObject({
            uri: canonicalPath,
            localStatus: 'available',
            fileHash: DOWNLOAD_BYTES_HASH,
            contentMtimeMs: 1000,
            contentSize: localBytes.length,
        });
    });

    it('keeps canonical CloudKit bytes and metadata untouched when staged plaintext fails hash validation', async () => {
        const canonicalPath = '/app-data/mindwtr/attachments/attachment-1.txt';
        const appData = createDownloadData('cloudkit');
        appData.tasks[0].attachments![0].fileHash = 'a'.repeat(64);
        const deps: AttachmentBackendDeps = {
            getTauriFetch: vi.fn(),
            isTauriRuntimeEnv: () => true,
            logSyncInfo: vi.fn(),
            logSyncWarning: vi.fn(),
            resolveWebdavPassword: vi.fn(),
        };
        fsMocks.readFile.mockResolvedValue(DOWNLOAD_BYTES);
        cloudKitMocks.fetchCloudKitAttachmentAsset.mockResolvedValue({
            recordName: 'attachment-1',
            attachmentId: 'attachment-1',
            ownerType: 'task',
            ownerId: 'task-1',
            title: 'remote-title.txt',
            fileHash: DOWNLOAD_BYTES_HASH,
            size: 999,
            updatedAt: '2026-08-27T01:00:00.000Z',
        });

        const result = await syncCloudKitAttachments(appData, deps);

        expect(result).toBe(false);
        const [recordName, stagedPath] = cloudKitMocks.fetchCloudKitAttachmentAsset.mock.calls[0];
        expect(recordName).toBe('attachment-1');
        expect(stagedPath).toMatch(/^\/app-data\/mindwtr\/attachments\/\.download-/);
        expect(stagedPath).not.toBe(canonicalPath);
        expect(installerMocks.installAttachmentDownload).not.toHaveBeenCalled();
        expect(fsMocks.remove).toHaveBeenCalledWith(stagedPath);
        expect(fsMocks.writeFile).not.toHaveBeenCalledWith(canonicalPath, expect.anything());
        expect(appData.tasks[0].attachments?.[0]).toMatchObject({
            uri: '',
            localStatus: 'missing',
            fileHash: 'a'.repeat(64),
        });
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

        const result = await syncCloudAttachments(
            appData,
            { url: 'https://cloud.example/v1/data', token: 'token' },
            'https://cloud.example/v1',
            deps,
        );

        const attachment = expectFoldedData(result).tasks[0].attachments?.[0];
        // The document handed in is never written to.
        expect(appData.tasks[0].attachments?.[0]?.cloudKey).toBe('attachments/attachment-1.jpg');
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
                            uri: 'C:\\app-data\\mindwtr\\attachments\\mindwtr-upload-test.txt',
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

        // Windows profile root, so the upload-containment predicate sees the drive-letter
        // form of the managed data dir.
        pathMocks.dataDir.mockResolvedValue('C:\\app-data');
        const relativePath = 'mindwtr\\attachments\\mindwtr-upload-test.txt';
        fsMocks.exists.mockImplementation(async (path: string) => path === relativePath);
        fsMocks.readFile.mockImplementation(async (path: string) => {
            if (path !== relativePath) {
                throw new Error('unexpected path ' + path);
            }
            return bytes;
        });

        const result = await syncCloudAttachments(
            appData,
            { url: 'http://cloud.local/v1/data', token: 'token', allowInsecureHttp: true },
            'http://cloud.local/v1',
            deps,
        );

        const attachment = expectFoldedData(result).tasks[0].attachments?.[0];
        expect(appData.tasks[0].attachments?.[0]?.cloudKey).toBeUndefined();
        // Inside the profile root, so the read is scoped to the data dir; the drive-letter
        // form still has to be recognised as such for that to happen at all.
        expect(fsMocks.exists).toHaveBeenCalledWith(relativePath, { baseDir: fsMocks.BaseDirectory.Data });
        expect(fsMocks.readFile).toHaveBeenCalledWith(relativePath, { baseDir: fsMocks.BaseDirectory.Data });
        expect(fsMocks.readFile).toHaveBeenCalledTimes(1);
        expect(fetcher).toHaveBeenCalledWith(
            'http://cloud.local/v1/attachments/attachment-1.txt',
            expect.objectContaining({ method: 'PUT' }),
        );
        expect(attachment?.cloudKey).toBe('attachments/attachment-1.txt');
        expect(attachment?.fileHash).toBe(
            '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
        );
        expect(attachment?.localStatus).toBe('available');
        expect(logSyncWarning).not.toHaveBeenCalledWith(
            expect.stringContaining('Failed to upload attachment'),
            expect.anything(),
        );
    });

    it('uploads a candidate-cleared local attachment during a self-hosted activation probe', async () => {
        const bytes = new Uint8Array([1, 2, 3]);
        const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
        const appData = createCandidateAttachmentData();
        appData.tasks[0].attachments![0].cloudKey = undefined;
        const deps: AttachmentBackendDeps = {
            getTauriFetch: async () => fetcher as unknown as typeof fetch,
            isTauriRuntimeEnv: () => true,
            logSyncInfo: vi.fn(),
            logSyncWarning: vi.fn(),
            resolveWebdavPassword: vi.fn(),
        };
        fsMocks.exists.mockResolvedValue(true);
        fsMocks.readFile.mockResolvedValue(bytes);

        const result = await syncCloudAttachments(
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
        expect(expectFoldedData(result).tasks[0].attachments?.[0]?.cloudKey).toBe('attachments/attachment-1.txt');
    });

    it.each([false, true])(
        'revalidates the self-hosted Cloud fence before every upload retry (activation=%s)',
        async (activationProbe) => {
            const appData = createCandidateAttachmentData();
            appData.tasks[0].attachments![0].cloudKey = undefined;
            fsMocks.exists.mockResolvedValue(true);
            fsMocks.readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
            const lost = new SyncRemoteMutationFenceLostError();
            const assertRemoteMutationFenceHeld = vi.fn()
                .mockResolvedValueOnce(undefined)
                .mockRejectedValueOnce(lost);
            const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
                errorResponse(503, 'Unavailable'),
            );
            coreMocks.withRetry.mockImplementationOnce(async (operation: () => Promise<unknown>) => {
                await operation().catch(() => undefined);
                return await operation();
            });

            await expect(syncCloudAttachments(
                appData,
                { url: 'https://cloud.example/v1/data', token: 'token' },
                'https://cloud.example/v1',
                {
                    getTauriFetch: async () => fetcher as unknown as typeof fetch,
                    isTauriRuntimeEnv: () => true,
                    logSyncInfo: vi.fn(),
                    logSyncWarning: vi.fn(),
                    resolveWebdavPassword: vi.fn(),
                },
                { activationProbe, ensureLocalSnapshotFresh: vi.fn(), assertRemoteMutationFenceHeld },
            )).rejects.toBe(lost);

            expect(assertRemoteMutationFenceHeld).toHaveBeenNthCalledWith(1, 125_000);
            expect(assertRemoteMutationFenceHeld).toHaveBeenNthCalledWith(2, 125_000);
            expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
        },
    );

    it('does not manufacture candidate proof when an activation upload fails', async () => {
        const fetcher = vi.fn(async () => errorResponse(503, 'Unavailable'));
        const appData = createCandidateAttachmentData();
        appData.tasks[0].attachments![0].cloudKey = undefined;
        const deps: AttachmentBackendDeps = {
            getTauriFetch: async () => fetcher as unknown as typeof fetch,
            isTauriRuntimeEnv: () => true,
            logSyncInfo: vi.fn(),
            logSyncWarning: vi.fn(),
            resolveWebdavPassword: vi.fn(),
        };
        fsMocks.exists.mockResolvedValue(true);
        fsMocks.readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));

        const result = await syncCloudAttachments(
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
        expect(result).toBe(false);
        expect(appData.tasks[0].attachments?.[0]?.cloudKey).toBeUndefined();
    });

    it('copies a candidate-cleared local attachment during a file activation probe', async () => {
        const bytes = new Uint8Array([1, 2, 3]);
        const appData = createCandidateAttachmentData();
        appData.tasks[0].attachments![0].cloudKey = undefined;
        const deps: AttachmentBackendDeps = {
            getTauriFetch: vi.fn(),
            isTauriRuntimeEnv: () => true,
            logSyncInfo: vi.fn(),
            logSyncWarning: vi.fn(),
            resolveWebdavPassword: vi.fn(),
        };
        syncFsMocks.exists.mockResolvedValue(false);
        fsMocks.readFile.mockResolvedValue(bytes);

        const result = await syncFileAttachments(
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
        expect(expectFoldedData(result).tasks[0].attachments?.[0]?.cloudKey).toBe('attachments/attachment-1.txt');
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
        expect(expectFoldedData(mutated).tasks[0].attachments?.[0]?.cloudKey).toBe('attachments/attachment-1.txt');
        // The sync folder is only ever touched off the main thread (#1037). The fs
        // plugin is still how the app reads its OWN data dir, so the assertion names
        // the sync folder rather than banning the plugin outright.
        expect(fsMocks.exists).not.toHaveBeenCalledWith(
            expect.stringContaining('/candidate-sync'),
            expect.anything(),
        );
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
        fsMocks.exists.mockResolvedValue(false);

        const result = await syncFileAttachments(appData, '/candidate-sync', deps);

        // localStatus reconciles to 'missing', but the cloud key survives on the folded copy.
        expect(expectFoldedData(result).tasks[0].attachments?.[0]?.cloudKey).toBe('attachments/attachment-1.txt');
        expect(fsMocks.writeFile).not.toHaveBeenCalled();
        // The sync folder is only ever stat'd off the main thread (#1037); reads of the
        // app's own data dir legitimately go through the fs plugin.
        expect(fsMocks.exists).not.toHaveBeenCalledWith(
            expect.stringContaining('/candidate-sync'),
            expect.anything(),
        );
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
        expect(logSyncWarning).toHaveBeenCalledWith(
            'WebDAV rate limited; pausing attachment sync',
            expect.objectContaining({ message: 'Attachment sync operation failed (503)' }),
        );
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
        let now = 0;
        vi.spyOn(Date, 'now').mockImplementation(() => {
            now += 1_000;
            return now;
        });
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
                        uri: `/app-data/mindwtr/attachments/file-${index}.txt`,
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

    it('keeps private attachment titles and paths out of serialized desktop sync logs', async () => {
        const privateTitle = 'Divorce settlement draft.pdf';
        const privatePath = `/app-data/mindwtr/attachments/${privateTitle}`;
        const appData = createCandidateAttachmentData();
        const attachment = appData.tasks[0].attachments![0];
        attachment.title = privateTitle;
        attachment.uri = privatePath;
        attachment.cloudKey = undefined;
        const logSyncInfo = vi.fn();
        const logSyncWarning = vi.fn();
        const deps: AttachmentBackendDeps = {
            getTauriFetch: async () => vi.fn() as unknown as typeof fetch,
            isTauriRuntimeEnv: () => true,
            logSyncInfo,
            logSyncWarning,
            resolveWebdavPassword: vi.fn(async () => 'secret'),
        };
        fsMocks.exists.mockResolvedValue(true);
        fsMocks.readFile.mockRejectedValue(new Error(`Failed to read ${privatePath}`));

        await syncWebdavAttachments(
            appData,
            { url: 'https://dav.example/mindwtr', username: 'alice' },
            'https://dav.example/mindwtr',
            deps,
        );

        const serialized = JSON.stringify({
            info: logSyncInfo.mock.calls,
            warnings: logSyncWarning.mock.calls,
        });
        expect(serialized).not.toContain(privateTitle);
        expect(serialized).not.toContain(privatePath);
        expect(serialized).toContain('attachment-1');
        expect(logSyncInfo).toHaveBeenCalledWith(
            'WebDAV attachment check',
            expect.objectContaining({ uri: 'path:managed.pdf' }),
        );
        expect(logSyncWarning).toHaveBeenCalledWith(
            'Failed to upload attachment attachment-1',
            expect.objectContaining({ message: 'Attachment sync operation failed' }),
        );
    });

    it('redacts a path-bearing attachment download error before logging it', async () => {
        const privateTitle = 'Divorce settlement draft.pdf';
        const privatePath = `/app-data/mindwtr/attachments/${privateTitle}`;
        const appData = createDownloadData('cloudkit');
        appData.tasks[0].attachments![0].title = privateTitle;
        const logSyncWarning = vi.fn();
        const deps: AttachmentBackendDeps = {
            getTauriFetch: vi.fn(),
            isTauriRuntimeEnv: () => true,
            logSyncInfo: vi.fn(),
            logSyncWarning,
            resolveWebdavPassword: vi.fn(),
        };
        cloudKitMocks.fetchCloudKitAttachmentAsset.mockRejectedValue(
            new Error(`Failed to open ${privatePath}`),
        );

        await syncCloudKitAttachments(appData, deps);

        const serialized = JSON.stringify(logSyncWarning.mock.calls);
        expect(serialized).not.toContain(privateTitle);
        expect(serialized).not.toContain(privatePath);
        expect(logSyncWarning).toHaveBeenCalledWith(
            'Failed to download CloudKit attachment attachment-1',
            expect.objectContaining({ message: 'Attachment sync operation failed' }),
        );
    });

    it('uploads a candidate-cleared local attachment during a WebDAV activation probe', async () => {
        const bytes = new Uint8Array([1, 2, 3]);
        const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
        const appData = createCandidateAttachmentData();
        appData.tasks[0].attachments![0].cloudKey = undefined;
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

    it('preserves attachment metadata and performs no transfer when local presence is unreadable', async () => {
        const fetcher = vi.fn();
        const appData = createCandidateAttachmentData();
        Object.assign(appData.tasks[0].attachments![0], {
            fileHash: 'ab'.repeat(32),
            pendingContentUpload: true,
            contentMtimeMs: 123,
            contentSize: 456,
        });
        const original = structuredClone(appData);
        const deps: AttachmentBackendDeps = {
            getTauriFetch: async () => fetcher as unknown as typeof fetch,
            isTauriRuntimeEnv: () => true,
            logSyncInfo: vi.fn(),
            logSyncWarning: vi.fn(),
            resolveWebdavPassword: vi.fn(async () => 'secret'),
        };
        fsMocks.exists.mockRejectedValue(new Error('Permission denied'));

        await expect(syncWebdavAttachments(
            appData,
            { url: 'https://candidate.example/mindwtr', username: 'alice' },
            'https://candidate.example/mindwtr',
            deps,
        )).resolves.toBeNull();

        expect(appData).toEqual(original);
        expect(coreMocks.webdavFileExists).not.toHaveBeenCalled();
        expect(fetcher).not.toHaveBeenCalled();
        expect(fsMocks.readFile).not.toHaveBeenCalled();
        expect(fsMocks.stat).not.toHaveBeenCalled();
        expect(fsMocks.writeFile).not.toHaveBeenCalled();
    });

    it.each([false, true])(
        'prevents a WebDAV attachment PUT after lease takeover (activation=%s)',
        async (activationProbe) => {
            const appData = createCandidateAttachmentData();
            appData.tasks[0].attachments![0].cloudKey = undefined;
            fsMocks.exists.mockResolvedValue(true);
            fsMocks.readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
            const lost = new SyncRemoteMutationFenceLostError();
            const assertRemoteMutationFenceHeld = vi.fn()
                .mockResolvedValueOnce(undefined)
                .mockRejectedValueOnce(lost);
            const fetcher = vi.fn(async (
                _input: RequestInfo | URL,
                _init?: RequestInit,
            ) => new Response(null, { status: 200 }));

            await expect(syncWebdavAttachments(
                appData,
                { url: 'https://dav.example/mindwtr', username: 'alice' },
                'https://dav.example/mindwtr',
                {
                    getTauriFetch: async () => fetcher as unknown as typeof fetch,
                    isTauriRuntimeEnv: () => true,
                    logSyncInfo: vi.fn(),
                    logSyncWarning: vi.fn(),
                    resolveWebdavPassword: vi.fn(async () => 'secret'),
                },
                { activationProbe, ensureLocalSnapshotFresh: vi.fn(), assertRemoteMutationFenceHeld },
            )).rejects.toBe(lost);

            expect(assertRemoteMutationFenceHeld).toHaveBeenCalledTimes(2);
            expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
        },
    );

    it.each([false, true])(
        'prevents a Dropbox attachment upload after lease takeover (activation=%s)',
        async (activationProbe) => {
            const appData = createCandidateAttachmentData();
            appData.tasks[0].attachments![0].cloudKey = undefined;
            fsMocks.exists.mockResolvedValue(true);
            fsMocks.readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
            const lost = new SyncRemoteMutationFenceLostError();
            const assertRemoteMutationFenceHeld = vi.fn().mockRejectedValue(lost);

            await expect(syncDropboxAttachments(
                appData,
                vi.fn(async () => 'token'),
                {
                    getTauriFetch: async () => undefined,
                    isTauriRuntimeEnv: () => true,
                    logSyncInfo: vi.fn(),
                    logSyncWarning: vi.fn(),
                    resolveWebdavPassword: vi.fn(),
                },
                { activationProbe, ensureLocalSnapshotFresh: vi.fn(), assertRemoteMutationFenceHeld },
            )).rejects.toBe(lost);

            expect(dropboxMocks.getDropboxFileMetadata).toHaveBeenCalled();
            expect(dropboxMocks.uploadDropboxFile).not.toHaveBeenCalled();
        },
    );

    it('never reads or uploads an attachment whose uri points outside the profile (SEC-07)', async () => {
        // A hostile sync document can put any absolute path in `uri` — it survives the
        // merge sanitizer, which only rejects traversal segments.
        const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 200 }));
        const appData = createCandidateAttachmentData();
        appData.tasks[0].attachments![0].uri = '/home/alice/.ssh/id_rsa';
        appData.tasks[0].attachments![0].cloudKey = undefined;
        const deps: AttachmentBackendDeps = {
            getTauriFetch: async () => fetcher as unknown as typeof fetch,
            isTauriRuntimeEnv: () => true,
            logSyncInfo: vi.fn(),
            logSyncWarning: vi.fn(),
            resolveWebdavPassword: vi.fn(async () => 'secret'),
        };
        fsMocks.exists.mockResolvedValue(true);
        fsMocks.readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
        coreMocks.webdavFileExists.mockResolvedValue(true);

        await syncWebdavAttachments(
            appData,
            { url: 'https://dav.example/mindwtr', username: 'alice' },
            'https://dav.example/mindwtr',
            deps,
        );

        expect(fsMocks.readFile).not.toHaveBeenCalled();
        const putCalls = fetcher.mock.calls.filter(([, init]) => (init as RequestInit)?.method === 'PUT');
        expect(putCalls).toHaveLength(0);
        expect(appData.tasks[0].attachments?.[0]?.cloudKey).toBeUndefined();
    });

    it('aborts the transfer pass as soon as the local snapshot goes stale (BUG-26)', async () => {
        const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 200 }));
        const appData = createCandidateAttachmentData();
        const first = appData.tasks[0].attachments![0];
        appData.tasks[0].attachments!.push({
            ...first,
            id: 'attachment-2',
            title: 'second.txt',
            uri: '/app-data/mindwtr/attachments/second.txt',
            cloudKey: undefined,
        });
        first.cloudKey = undefined;
        const deps: AttachmentBackendDeps = {
            getTauriFetch: async () => fetcher as unknown as typeof fetch,
            isTauriRuntimeEnv: () => true,
            logSyncInfo: vi.fn(),
            logSyncWarning: vi.fn(),
            resolveWebdavPassword: vi.fn(async () => 'secret'),
        };
        fsMocks.exists.mockResolvedValue(true);
        fsMocks.readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
        coreMocks.webdavFileExists.mockResolvedValue(true);

        let checks = 0;
        const ensureLocalSnapshotFresh = vi.fn(() => {
            checks += 1;
            if (checks > 1) {
                const abort = new Error('local data changed mid-sync');
                abort.name = 'LocalSyncAbort';
                throw abort;
            }
        });

        await expect(syncWebdavAttachments(
            appData,
            { url: 'https://dav.example/mindwtr', username: 'alice' },
            'https://dav.example/mindwtr',
            deps,
            { activationProbe: false, ensureLocalSnapshotFresh, phase: 'prepare' },
        )).rejects.toMatchObject({ name: 'LocalSyncAbort' });

        expect(ensureLocalSnapshotFresh).toHaveBeenCalledTimes(2);
        const putCalls = fetcher.mock.calls.filter(([, init]) => (init as RequestInit)?.method === 'PUT');
        expect(putCalls).toHaveLength(0);
    });

    describe('check-on-touch content change detection (#1057)', () => {
        const bytes = new Uint8Array([1, 2, 3]);
        // Real SHA-256 of `bytes` above — computed once so "hash matches" and "hash
        // differs" tests can both use realistic hashes rather than a stubbed hasher.
        const BYTES_HASH = '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81';

        const prepareHelpers = () => ({
            activationProbe: false,
            ensureLocalSnapshotFresh: vi.fn(),
            phase: 'prepare' as const,
        });

        const postMergeHelpers = () => ({
            activationProbe: false,
            ensureLocalSnapshotFresh: vi.fn(),
            phase: 'post-merge' as const,
        });

        const makePendingData = (): AppData => {
            const data = createCandidateAttachmentData();
            Object.assign(data.tasks[0].attachments![0], {
                fileHash: BYTES_HASH,
                contentRev: 7,
                contentMtimeMs: 1000,
                contentSize: bytes.length,
                pendingContentUpload: true,
            });
            return data;
        };

        const depsFor = (fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
            new Response(null, { status: 200 })
        ))): AttachmentBackendDeps => ({
            getTauriFetch: async () => fetcher as unknown as typeof fetch,
            isTauriRuntimeEnv: () => true,
            logSyncInfo: vi.fn(),
            logSyncWarning: vi.fn(),
            resolveWebdavPassword: vi.fn(async () => 'secret'),
        });

        it('retains a WebDAV pending candidate when the blob is absent and local bytes advanced again', async () => {
            const newerBytes = new Uint8Array([4, 5, 6]);
            const appData = makePendingData();
            const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
                new Response(null, { status: 200 })
            ));
            fsMocks.exists.mockResolvedValue(true);
            fsMocks.readFile.mockResolvedValue(newerBytes);
            fsMocks.stat.mockResolvedValue({ mtime: new Date(2000), size: newerBytes.length });
            coreMocks.webdavFileExists.mockResolvedValue(false);

            const result = await syncWebdavAttachments(
                appData,
                { url: 'https://dav.example/mindwtr', username: 'alice' },
                'https://dav.example/mindwtr',
                depsFor(fetcher),
                postMergeHelpers(),
            );

            expect(result).toBeNull();
            expect(coreMocks.webdavFileExists).not.toHaveBeenCalled();
            expect(fetcher).not.toHaveBeenCalled();
            expect(appData.tasks[0].attachments?.[0]).toMatchObject({
                cloudKey: 'attachments/attachment-1.txt',
                fileHash: BYTES_HASH,
                contentRev: 7,
                pendingContentUpload: true,
            });
        });

        it('creates an absent WebDAV blob only from the exact pending bytes', async () => {
            const appData = makePendingData();
            const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
                new Response(null, { status: 200 })
            ));
            fsMocks.exists.mockResolvedValue(true);
            fsMocks.readFile.mockResolvedValue(bytes);
            fsMocks.stat.mockResolvedValue({ mtime: new Date(1000), size: bytes.length });
            coreMocks.webdavFileExists.mockResolvedValue(false);

            const result = expectFoldedData(await syncWebdavAttachments(
                appData,
                { url: 'https://dav.example/mindwtr', username: 'alice' },
                'https://dav.example/mindwtr',
                depsFor(fetcher),
                postMergeHelpers(),
            ));

            expect(coreMocks.webdavFileExists).not.toHaveBeenCalled();
            expect(fetcher.mock.calls.filter(([, init]) => (init as RequestInit)?.method === 'PUT')).toHaveLength(1);
            expect(result.tasks[0].attachments?.[0]).toMatchObject({
                cloudKey: 'attachments/attachment-1.txt',
                fileHash: BYTES_HASH,
                contentRev: 7,
                pendingContentUpload: undefined,
            });
        });

        it('retains a File Sync pending candidate when the blob is absent and local bytes advanced again', async () => {
            const newerBytes = new Uint8Array([4, 5, 6]);
            const appData = makePendingData();
            fsMocks.exists.mockResolvedValue(true);
            fsMocks.readFile.mockResolvedValue(newerBytes);
            fsMocks.stat.mockResolvedValue({ mtime: new Date(2000), size: newerBytes.length });
            syncFsMocks.exists.mockResolvedValue(false);

            const result = await syncFileAttachments(appData, '/candidate-sync', depsFor(), postMergeHelpers());

            expect(result).toBe(false);
            expect(syncFsMocks.exists).not.toHaveBeenCalled();
            expect(fsMocks.writeFile).not.toHaveBeenCalled();
            expect(appData.tasks[0].attachments?.[0]).toMatchObject({
                cloudKey: 'attachments/attachment-1.txt',
                fileHash: BYTES_HASH,
                contentRev: 7,
                pendingContentUpload: true,
            });
        });

        it('creates an absent File Sync blob only from the exact pending bytes', async () => {
            const appData = makePendingData();
            fsMocks.exists.mockResolvedValue(true);
            fsMocks.readFile.mockResolvedValue(bytes);
            fsMocks.stat.mockResolvedValue({ mtime: new Date(1000), size: bytes.length });
            syncFsMocks.exists.mockResolvedValue(false);

            const result = expectFoldedData(await syncFileAttachments(
                appData,
                '/candidate-sync',
                depsFor(),
                postMergeHelpers(),
            ));

            expect(syncFsMocks.exists).not.toHaveBeenCalled();
            expect(syncFsMocks.rename).toHaveBeenCalledWith(
                expect.stringMatching(/^\/candidate-sync\/attachments\/attachment-1\.txt\.tmp-/),
                '/candidate-sync/attachments/attachment-1.txt',
            );
            expect(result.tasks[0].attachments?.[0]).toMatchObject({
                cloudKey: 'attachments/attachment-1.txt',
                fileHash: BYTES_HASH,
                contentRev: 7,
                pendingContentUpload: undefined,
            });
        });

        it('defers a missing pending Cloud candidate without touching its remote generation', async () => {
            const appData = makePendingData();
            appData.tasks[0].attachments![0].localStatus = 'available';
            const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
            fsMocks.exists.mockResolvedValue(false);

            const result = await syncCloudAttachments(
                appData,
                { url: 'https://cloud.example/v1/data', token: 'token' },
                'https://cloud.example/v1',
                depsFor(fetcher),
                postMergeHelpers(),
            );

            expect(result).toBe(false);
            expect(fetcher).not.toHaveBeenCalled();
            expect(fsMocks.writeFile).not.toHaveBeenCalled();
            expect(appData.tasks[0].attachments?.[0]).toMatchObject({
                cloudKey: 'attachments/attachment-1.txt',
                fileHash: BYTES_HASH,
                contentRev: 7,
                localStatus: 'available',
                pendingContentUpload: true,
            });
        });

        it('defers a missing pending CloudKit candidate without fetching or saving an asset', async () => {
            const appData = makePendingData();
            Object.assign(appData.tasks[0].attachments![0], {
                cloudKey: 'cloudkit:attachment-1',
                localStatus: 'available',
            });
            fsMocks.exists.mockResolvedValue(false);

            const result = await syncCloudKitAttachments(appData, depsFor(), postMergeHelpers());

            expect(result).toBe(false);
            expect(cloudKitMocks.fetchCloudKitAttachmentAsset).not.toHaveBeenCalled();
            expect(cloudKitMocks.saveCloudKitAttachmentAsset).not.toHaveBeenCalled();
            expect(fsMocks.writeFile).not.toHaveBeenCalled();
            expect(appData.tasks[0].attachments?.[0]).toMatchObject({
                cloudKey: 'cloudkit:attachment-1',
                fileHash: BYTES_HASH,
                contentRev: 7,
                localStatus: 'available',
                pendingContentUpload: true,
            });
        });

        it('leaves an unchanged attachment alone: no PUT, no mutation, on a normal sync with check-on-touch active', async () => {
            const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 200 }));
            const appData = createCandidateAttachmentData();
            appData.tasks[0].attachments![0].fileHash = BYTES_HASH;
            appData.tasks[0].attachments![0].contentMtimeMs = 1000;
            appData.tasks[0].attachments![0].contentSize = 3;
            const deps: AttachmentBackendDeps = {
                getTauriFetch: async () => fetcher as unknown as typeof fetch,
                isTauriRuntimeEnv: () => true,
                logSyncInfo: vi.fn(),
                logSyncWarning: vi.fn(),
                resolveWebdavPassword: vi.fn(async () => 'secret'),
            };
            fsMocks.exists.mockResolvedValue(true);
            fsMocks.readFile.mockResolvedValue(bytes);
            fsMocks.stat.mockResolvedValue({ mtime: new Date(1000), size: 3 });
            coreMocks.webdavFileExists.mockResolvedValue(true);

            const result = await syncWebdavAttachments(
                appData,
                { url: 'https://dav.example/mindwtr', username: 'alice' },
                'https://dav.example/mindwtr',
                deps,
                prepareHelpers(),
            );

            const putCalls = fetcher.mock.calls.filter(([, init]) => (init as RequestInit)?.method === 'PUT');
            expect(putCalls).toHaveLength(0);
            expect(result).toBeNull();
        });

        it('records changed local content without overwriting the cloud key during prepare', async () => {
            const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
                new Response(null, { status: 200 }),
            );
            const appData = createCandidateAttachmentData();
            const attachment = appData.tasks[0].attachments![0];
            attachment.fileHash = 'stale-hash-from-a-previous-version';
            attachment.contentRev = 2;
            attachment.contentMtimeMs = 1000;
            attachment.contentSize = 3;
            const deps: AttachmentBackendDeps = {
                getTauriFetch: async () => fetcher as unknown as typeof fetch,
                isTauriRuntimeEnv: () => true,
                logSyncInfo: vi.fn(),
                logSyncWarning: vi.fn(),
                resolveWebdavPassword: vi.fn(async () => 'secret'),
            };
            fsMocks.exists.mockResolvedValue(true);
            fsMocks.readFile.mockResolvedValue(bytes);
            // mtime moved on, so the pre-pass hashes the file to confirm the change.
            fsMocks.stat.mockResolvedValue({ mtime: new Date(9_999), size: 3 });
            coreMocks.webdavFileExists.mockResolvedValue(true);

            const result = await syncWebdavAttachments(
                appData,
                { url: 'https://dav.example/mindwtr', username: 'alice' },
                'https://dav.example/mindwtr',
                deps,
                prepareHelpers(),
            );

            expect(fetcher.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'PUT')).toBe(false);
            const merged = result?.tasks[0].attachments?.[0];
            expect(merged?.cloudKey).toBe('attachments/attachment-1.txt');
            expect(merged?.contentRev).toBe(3);
            expect(merged?.fileHash).toBe(BYTES_HASH);
            expect(merged?.contentMtimeMs).toBe(9_999);
            expect(merged?.contentSize).toBe(3);
            expect(merged?.pendingContentUpload).toBe(true);
        });
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

        const result = expectFoldedData(await syncCloudKitAttachments(appData, deps));

        const attachment = result.tasks[0].attachments?.[0];
        expect(cloudKitMocks.deleteCloudKitAttachmentAssets).toHaveBeenCalledWith(['old-attachment']);
        expect(cloudKitMocks.saveCloudKitAttachmentAsset).toHaveBeenCalledWith(
            'attachment-1',
            expect.stringMatching(/^\/app-data\/mindwtr\/attachments\/\.upload-attachment-1-/),
            expect.objectContaining({
                attachmentId: 'attachment-1',
                fileHash: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
                ownerType: 'task',
                ownerId: 'task-1',
                title: 'photo.jpg',
                size: 3,
            }),
        );
        expect(fsMocks.remove).toHaveBeenCalledWith(
            expect.stringMatching(/^\/app-data\/mindwtr\/attachments\/\.upload-attachment-1-/),
        );
        expect(attachment?.cloudKey).toBe('cloudkit:attachment-1');
        expect(attachment?.localStatus).toBe('available');
        expect(attachment?.size).toBe(3);
        expect(result.settings.attachments?.pendingRemoteDeletes).toEqual([
            { cloudKey: 'attachments/legacy-file.jpg' },
        ]);
        // The input document keeps both pending deletes and its un-uploaded attachment.
        expect(appData.settings.attachments?.pendingRemoteDeletes).toHaveLength(2);
        expect(appData.tasks[0].attachments?.[0]?.cloudKey).toBeUndefined();
        expect(logSyncWarning).not.toHaveBeenCalled();
    });

    // The teeth of the purity contract: a deep-frozen document makes any in-place write
    // throw (strict mode), so a backend that still mutates its input fails loudly here.
    describe('backend purity (frozen input document)', () => {
        const bytes = new Uint8Array([1, 2, 3]);

        const frozenDeps = (): AttachmentBackendDeps => ({
            getTauriFetch: async () => (vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch),
            isTauriRuntimeEnv: () => true,
            logSyncInfo: vi.fn(),
            logSyncWarning: vi.fn(),
            resolveWebdavPassword: vi.fn(async () => 'secret'),
        });

        /** A locally-available attachment with no cloud key: every backend has real work to do. */
        const frozenData = (): AppData => {
            const data = createCandidateAttachmentData();
            data.tasks[0].attachments![0].cloudKey = undefined;
            data.settings = { attachments: { pendingRemoteDeletes: [{ cloudKey: 'cloudkit:old-attachment' }] } };
            return deepFreeze(data);
        };

        beforeEach(() => {
            fsMocks.exists.mockResolvedValue(true);
            fsMocks.readFile.mockResolvedValue(bytes);
            fsMocks.stat.mockResolvedValue({ mtime: new Date(1000), size: 3 });
            syncFsMocks.exists.mockResolvedValue(false);
            coreMocks.webdavFileExists.mockResolvedValue(false);
            cloudKitMocks.deleteCloudKitAttachmentAssets.mockResolvedValue(undefined);
            cloudKitMocks.saveCloudKitAttachmentAsset.mockResolvedValue({
                recordName: 'attachment-1',
                attachmentId: 'attachment-1',
                ownerType: 'task',
                ownerId: 'task-1',
                title: 'candidate-proof.txt',
                size: 3,
                updatedAt: '2026-08-03T00:00:00.000Z',
            });
            dropboxMocks.uploadDropboxFile.mockResolvedValue(undefined);
        });

        const postMergeHelpers = () => ({
            activationProbe: false,
            ensureLocalSnapshotFresh: vi.fn(),
            phase: 'post-merge' as const,
        });

        it('webdav', async () => {
            const appData = frozenData();
            const result = await syncWebdavAttachments(
                appData,
                { url: 'https://dav.example/mindwtr', username: 'alice' },
                'https://dav.example/mindwtr',
                frozenDeps(),
                postMergeHelpers(),
            );
            expect(expectFoldedData(result).tasks[0].attachments?.[0]?.cloudKey).toBe('attachments/attachment-1.txt');
            expect(appData.tasks[0].attachments?.[0]?.cloudKey).toBeUndefined();
        });

        it('cloud', async () => {
            const appData = frozenData();
            const result = await syncCloudAttachments(
                appData,
                { url: 'https://cloud.example/v1/data', token: 'token' },
                'https://cloud.example/v1',
                frozenDeps(),
                postMergeHelpers(),
            );
            expect(expectFoldedData(result).tasks[0].attachments?.[0]?.cloudKey).toBe('attachments/attachment-1.txt');
            expect(appData.tasks[0].attachments?.[0]?.cloudKey).toBeUndefined();
        });

        it('dropbox', async () => {
            const appData = frozenData();
            const result = await syncDropboxAttachments(
                appData,
                async () => 'dropbox-token',
                frozenDeps(),
                postMergeHelpers(),
            );
            expect(expectFoldedData(result).tasks[0].attachments?.[0]?.cloudKey).toBe('attachments/attachment-1.txt');
            expect(appData.tasks[0].attachments?.[0]?.cloudKey).toBeUndefined();
        });

        it('file', async () => {
            const appData = frozenData();
            const result = await syncFileAttachments(appData, '/candidate-sync', frozenDeps(), postMergeHelpers());
            expect(expectFoldedData(result).tasks[0].attachments?.[0]?.cloudKey).toBe('attachments/attachment-1.txt');
            expect(appData.tasks[0].attachments?.[0]?.cloudKey).toBeUndefined();
        });

        it('cloudkit, including the pending-remote-delete flush', async () => {
            const appData = frozenData();
            const result = expectFoldedData(await syncCloudKitAttachments(appData, frozenDeps(), postMergeHelpers()));
            expect(result.tasks[0].attachments?.[0]?.cloudKey).toBe('cloudkit:attachment-1');
            expect(result.settings.attachments?.pendingRemoteDeletes).toEqual([]);
            expect(appData.tasks[0].attachments?.[0]?.cloudKey).toBeUndefined();
            expect(appData.settings.attachments?.pendingRemoteDeletes).toHaveLength(1);
        });
    });
});
