import { describe, expect, it, vi } from 'vitest';
import { LocalSyncAbort, type AppData } from '@mindwtr/core';

import {
    cleanupOrphanedAttachments,
    deleteAttachmentFile,
    type AttachmentCleanupDeps,
} from './sync-attachment-cleanup';

const fsMocks = vi.hoisted(() => ({
    exists: vi.fn(),
    readDir: vi.fn(),
    remove: vi.fn(),
}));

const pathMocks = vi.hoisted(() => ({
    join: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => fsMocks);
vi.mock('@tauri-apps/api/path', () => pathMocks);
vi.mock('./managed-paths', () => ({
    getManagedPath: async (...segments: string[]) => ['/new-profile', ...segments].join('/'),
}));

const buildData = (): AppData => ({
    tasks: [],
    projects: [],
    sections: [],
    areas: [],
    people: [],
    settings: {
        attachments: {
            pendingRemoteDeletes: [{
                cloudKey: 'attachments/orphan.pdf',
                title: 'orphan.pdf',
            }],
        },
    },
});

const buildDeps = (): AttachmentCleanupDeps => ({
    getCloudConfig: vi.fn(async () => ({ url: '', token: '' })),
    getCloudProvider: vi.fn(async () => 'selfhosted' as const),
    getDropboxAccessToken: vi.fn(async () => ''),
    getDropboxAppKey: vi.fn(async () => ''),
    getSyncPath: vi.fn(async () => '/sync/data.json'),
    getTauriFetch: vi.fn(async () => undefined),
    getWebDavConfig: vi.fn(async () => ({ url: '', username: '' })),
    isTauriRuntimeEnv: vi.fn(() => true),
    logSyncInfo: vi.fn(),
    logSyncWarning: vi.fn(),
    resolveWebdavPassword: vi.fn(async () => ''),
});

describe('desktop attachment cleanup freshness', () => {
    it('aborts after resolving a file target when a local edit makes the snapshot stale', async () => {
        let stale = false;
        pathMocks.join.mockImplementation(async (...parts: string[]) => {
            stale = true;
            return parts.join('/');
        });
        const ensureLocalSnapshotFresh = vi.fn(() => {
            if (stale) throw new LocalSyncAbort();
        });

        await expect(cleanupOrphanedAttachments(
            buildData(),
            'file',
            buildDeps(),
            { ensureLocalSnapshotFresh },
        )).rejects.toBeInstanceOf(LocalSyncAbort);

        expect(pathMocks.join).toHaveBeenCalled();
        expect(ensureLocalSnapshotFresh).toHaveBeenCalledTimes(2);
        expect(fsMocks.remove).not.toHaveBeenCalled();
    });
});

describe('deleteAttachmentFile', () => {
    const attachment = (uri: string) => ({
        id: 'a1',
        kind: 'file' as const,
        title: 'a1.pdf',
        uri,
        createdAt: '2026-08-16T00:00:00.000Z',
        updatedAt: '2026-08-16T00:00:00.000Z',
    });

    it('removes the profile copy a relocated portable install left under a stale path', async () => {
        // #1038: the recorded path names the previous profile location, so the
        // managed-dir check missed the copy and it stayed there forever.
        fsMocks.remove.mockReset();
        fsMocks.exists.mockImplementation(async (path: string) => path === '/new-profile/attachments/a1.pdf');

        await deleteAttachmentFile(
            attachment('/old-profile/attachments/a1.pdf'),
            buildDeps(),
            { ensureLocalSnapshotFresh: vi.fn() },
        );

        expect(fsMocks.remove).toHaveBeenCalledWith('/new-profile/attachments/a1.pdf');
    });

    it('never removes a pointer target outside the managed dir', async () => {
        fsMocks.remove.mockReset();
        fsMocks.exists.mockResolvedValue(true);

        await deleteAttachmentFile(
            attachment('/home/demo/Documents/spec.pdf'),
            buildDeps(),
            { ensureLocalSnapshotFresh: vi.fn() },
        );

        expect(fsMocks.remove).not.toHaveBeenCalled();
    });
});
