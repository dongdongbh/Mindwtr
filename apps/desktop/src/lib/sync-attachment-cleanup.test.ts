import { describe, expect, it, vi } from 'vitest';
import { type AppData } from '@mindwtr/core';

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

const coreMocks = vi.hoisted(() => ({
    webdavDeleteFileVersioned: vi.fn(),
    webdavHeadFile: vi.fn(),
}));

vi.mock('@mindwtr/core', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@mindwtr/core')>()),
    webdavDeleteFileVersioned: coreMocks.webdavDeleteFileVersioned,
    webdavHeadFile: coreMocks.webdavHeadFile,
}));

vi.mock('@tauri-apps/plugin-fs', () => fsMocks);
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
    it('clears File Sync cleanup bookkeeping without deleting shared-folder bytes', async () => {
        const deps = buildDeps();
        const cleaned = await cleanupOrphanedAttachments(
            buildData(),
            'file',
            deps,
            { ensureLocalSnapshotFresh: vi.fn() },
        );

        expect(deps.getSyncPath).not.toHaveBeenCalled();
        expect(fsMocks.remove).not.toHaveBeenCalled();
        expect(cleaned.settings.attachments?.pendingRemoteDeletes).toBeUndefined();
    });

    it('bounds remote cleanup and resumes the retained queue on the next pass', async () => {
        const pendingRemoteDeletes = Array.from({ length: 26 }, (_, index) => ({
            cloudKey: `attachments/orphan-${index + 1}.pdf`,
            title: `orphan-${index + 1}.pdf`,
            attempts: 2,
            lastErrorAt: `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
        }));
        const appData: AppData = {
            ...buildData(),
            settings: { attachments: { pendingRemoteDeletes } },
        };
        const deps = buildDeps();
        vi.mocked(deps.getWebDavConfig).mockResolvedValue({
            url: 'https://dav.example.com/mindwtr/',
            username: 'alice',
        });
        fsMocks.readDir.mockResolvedValue([]);
        coreMocks.webdavHeadFile.mockResolvedValue({ exists: true, etag: '"v1"' });
        coreMocks.webdavDeleteFileVersioned.mockResolvedValue(undefined);

        const firstPass = await cleanupOrphanedAttachments(
            appData,
            'webdav',
            deps,
            { ensureLocalSnapshotFresh: vi.fn() },
        );

        expect(coreMocks.webdavHeadFile).toHaveBeenCalledTimes(25);
        expect(coreMocks.webdavDeleteFileVersioned).toHaveBeenCalledTimes(25);
        expect(firstPass.settings.attachments?.pendingRemoteDeletes).toEqual([
            pendingRemoteDeletes[25],
        ]);
        expect(deps.logSyncInfo).toHaveBeenCalledWith(
            'Attachment cleanup batch limit reached',
            { limit: '25', total: '26' },
        );

        const secondPass = await cleanupOrphanedAttachments(
            firstPass,
            'webdav',
            deps,
            { ensureLocalSnapshotFresh: vi.fn() },
        );

        expect(coreMocks.webdavHeadFile).toHaveBeenCalledTimes(26);
        expect(coreMocks.webdavDeleteFileVersioned).toHaveBeenCalledTimes(26);
        expect(secondPass.settings.attachments?.pendingRemoteDeletes).toBeUndefined();
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
