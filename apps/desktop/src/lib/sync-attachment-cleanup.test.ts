import { describe, expect, it, vi } from 'vitest';
import { LocalSyncAbort, type AppData } from '@mindwtr/core';

import {
    cleanupOrphanedAttachments,
    deleteAttachmentFile,
    reconcileFileSyncAttachmentInventory,
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

const syncFsMocks = vi.hoisted(() => ({
    exists: vi.fn(),
    remove: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => fsMocks);
vi.mock('@tauri-apps/api/path', () => pathMocks);
vi.mock('./sync-fs', () => syncFsMocks);
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

describe('File Sync attachment inventory reconciliation', () => {
    const H1_FILENAME = `a1.${'1'.repeat(64)}.pdf`;
    const H2_FILENAME = `a1.${'2'.repeat(64)}.pdf`;

    const buildAuthoritativeData = (): AppData => ({
        tasks: [{
            id: 't1',
            title: 'Task',
            status: 'next',
            contexts: [],
            tags: [],
            createdAt: '2026-08-16T00:00:00.000Z',
            updatedAt: '2026-08-16T00:00:00.000Z',
            attachments: [{
                id: 'a1',
                kind: 'file',
                title: 'report.pdf',
                uri: '/managed/report.pdf',
                cloudKey: `attachments/${H2_FILENAME}`,
                createdAt: '2026-08-16T00:00:00.000Z',
                updatedAt: '2026-08-16T00:00:00.000Z',
            }],
        }],
        projects: [],
        sections: [],
        areas: [],
        people: [],
        settings: {},
    });

    it('reclaims crash-left scratch and an unjournaled losing generation only', async () => {
        pathMocks.join.mockImplementation(async (...parts: string[]) => parts.join('/'));
        syncFsMocks.exists.mockResolvedValue(true);
        syncFsMocks.remove.mockResolvedValue(undefined);
        fsMocks.readDir.mockResolvedValue([
            { name: '.mindwtr-attachment-generation-crashed.tmp', isFile: true, isSymlink: false },
            { name: H1_FILENAME, isFile: true, isSymlink: false },
            { name: H2_FILENAME, isFile: true, isSymlink: false },
            { name: 'legacy.pdf', isFile: true, isSymlink: false },
            { name: '.mindwtr-attachment-generation-peer.tmp', isFile: true, isSymlink: true },
        ]);
        const guards = {
            ensureLocalSnapshotFresh: vi.fn(),
            assertRemoteMutationFenceHeld: vi.fn(async () => undefined),
        };

        const discovered = await reconcileFileSyncAttachmentInventory(
            buildAuthoritativeData(),
            buildDeps(),
            guards,
        );
        const cleaned = await cleanupOrphanedAttachments(discovered, 'file', buildDeps(), guards);

        expect(syncFsMocks.remove).toHaveBeenCalledWith(
            '/sync/attachments/.mindwtr-attachment-generation-crashed.tmp',
        );
        expect(syncFsMocks.remove).toHaveBeenCalledWith(`/sync/attachments/${H1_FILENAME}`);
        expect(syncFsMocks.remove).not.toHaveBeenCalledWith(`/sync/attachments/${H2_FILENAME}`);
        expect(syncFsMocks.remove).not.toHaveBeenCalledWith('/sync/attachments/legacy.pdf');
        expect(syncFsMocks.remove).not.toHaveBeenCalledWith(
            '/sync/attachments/.mindwtr-attachment-generation-peer.tmp',
        );
        expect(cleaned.settings.attachments?.pendingRemoteDeletes).toBeUndefined();
        expect(cleaned.tasks[0].attachments?.[0]?.cloudKey).toBe(`attachments/${H2_FILENAME}`);
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

    it('logs an attachment id instead of a private title or path when deletion fails', async () => {
        const privateTitle = 'Divorce settlement draft.pdf';
        const privatePath = `/new-profile/attachments/${privateTitle}`;
        const logSyncWarning = vi.fn();
        fsMocks.remove.mockRejectedValueOnce(new Error(`Failed to remove ${privatePath}`));

        await deleteAttachmentFile(
            { ...attachment(privatePath), title: privateTitle },
            { logSyncWarning },
            { ensureLocalSnapshotFresh: vi.fn() },
        );

        const serialized = JSON.stringify(logSyncWarning.mock.calls);
        expect(serialized).not.toContain(privateTitle);
        expect(serialized).not.toContain(privatePath);
        expect(logSyncWarning).toHaveBeenCalledWith(
            'Failed to delete attachment file a1',
            expect.any(Error),
        );
    });
});
