import { describe, expect, it, vi } from 'vitest';
import { createSyncBackendIO, type SyncBackendContext, type SyncTransport } from './sync-backend-io';
import { DropboxConflictError, DropboxUnauthorizedError } from './dropbox';
import { SyncRemoteWriteConflict } from './sync-run-ports';
import type { AppData } from './types';
import { WebDavRemoteWriteConflictError } from './webdav';
import type { SyncRemoteMutationFenceLease } from './sync-remote-fence';

const APP_DATA: AppData = {
    tasks: [], projects: [], sections: [], areas: [], people: [], settings: {},
};

const makeTransport = (overrides: Partial<SyncTransport> = {}): SyncTransport => ({
    webdavGet: vi.fn().mockResolvedValue({
        data: APP_DATA,
        exists: true,
        strongEtag: '"webdav-read-v1"',
    }),
    webdavPut: vi.fn().mockResolvedValue({ fingerprint: 'webdav-fp' }),
    webdavPutLegacyPlaintext: vi.fn().mockResolvedValue({ fingerprint: 'webdav-legacy-fp' }),
    webdavHead: vi.fn().mockResolvedValue({ exists: true, fingerprint: 'webdav-head-fp' }),
    cloudGet: vi.fn().mockResolvedValue(APP_DATA),
    cloudPut: vi.fn().mockResolvedValue({ fingerprint: 'cloud-fp' }),
    cloudHead: vi.fn().mockResolvedValue({ exists: true, fingerprint: 'cloud-head-fp' }),
    fileRead: vi.fn().mockResolvedValue(APP_DATA),
    fileWrite: vi.fn().mockResolvedValue(undefined),
    cloudKitRead: vi.fn().mockResolvedValue(APP_DATA),
    cloudKitWrite: vi.fn().mockResolvedValue(undefined),
    resolveDropboxToken: vi.fn().mockResolvedValue('token'),
    dropboxDownload: vi.fn().mockResolvedValue({ data: APP_DATA, rev: 'rev-1' }),
    dropboxUpload: vi.fn().mockResolvedValue({ rev: 'rev-2' }),
    dropboxMetadata: vi.fn().mockResolvedValue({ rev: 'rev-3' }),
    syncWebdavAttachments: vi.fn().mockResolvedValue(null),
    syncCloudAttachments: vi.fn().mockResolvedValue(null),
    syncDropboxAttachments: vi.fn().mockResolvedValue(null),
    syncFileAttachments: vi.fn().mockResolvedValue(null),
    syncCloudKitAttachments: vi.fn().mockResolvedValue(null),
    ...overrides,
});

const helpers = { ensureLocalSnapshotFresh: () => {} };
const fenceLease = (): SyncRemoteMutationFenceLease => ({
    assertHeld: vi.fn().mockResolvedValue(undefined),
    renew: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
});

describe('createSyncBackendIO', () => {
    describe('cloudkit', () => {
        const ctx: SyncBackendContext = { backend: 'cloudkit', cloudProvider: 'selfhosted', dropboxRev: null };

        it('reads, writes, and syncs attachments through the cloudkit transport', async () => {
            const transport = makeTransport();
            const io = createSyncBackendIO(ctx, transport);
            await expect(io.readRemote()).resolves.toBe(APP_DATA);
            expect(transport.cloudKitRead).toHaveBeenCalledTimes(1);

            await io.writeRemote(APP_DATA);
            expect(transport.cloudKitWrite).toHaveBeenCalledWith(APP_DATA);

            await expect(io.readRemoteFingerprint!()).resolves.toBeNull();

            await io.syncAttachments!(APP_DATA, helpers);
            expect(transport.syncCloudKitAttachments).toHaveBeenCalledWith(APP_DATA, helpers);
        });
    });

    describe('webdav', () => {
        it('acquires the WebDAV mutation fence through the platform transport', async () => {
            const lease = fenceLease();
            const acquireWebdavRemoteMutationFence = vi.fn().mockResolvedValue(lease);
            const io = createSyncBackendIO({
                backend: 'webdav', cloudProvider: 'selfhosted',
                webdav: { url: 'https://dav.example.com/data.json' }, dropboxRev: null,
            }, makeTransport({ acquireWebdavRemoteMutationFence }));

            await expect(io.acquireRemoteMutationFence!()).resolves.toBe(lease);
            expect(acquireWebdavRemoteMutationFence).toHaveBeenCalledTimes(1);
        });

        it('bypasses the strong-ETag mutation fence in explicit legacy plaintext mode', async () => {
            const acquireWebdavRemoteMutationFence = vi.fn();
            const io = createSyncBackendIO({
                backend: 'webdav', cloudProvider: 'selfhosted',
                webdav: { url: 'https://dav.example.com/data.json' }, dropboxRev: null,
                allowLegacyWebdavPlaintext: true,
            }, makeTransport({ acquireWebdavRemoteMutationFence }));

            await expect(io.acquireRemoteMutationFence!()).resolves.toBeNull();
            expect(acquireWebdavRemoteMutationFence).not.toHaveBeenCalled();
        });

        it('throws when unconfigured and never touches the transport', async () => {
            const ctx: SyncBackendContext = { backend: 'webdav', cloudProvider: 'selfhosted', webdav: null, dropboxRev: null };
            const transport = makeTransport();
            const io = createSyncBackendIO(ctx, transport);
            await expect(io.readRemote()).rejects.toThrow('WebDAV URL not configured');
            expect(transport.webdavGet).not.toHaveBeenCalled();
        });

        it('normalizes the url into syncUrl before reading, writing, and heading', async () => {
            const ctx: SyncBackendContext = {
                backend: 'webdav', cloudProvider: 'selfhosted',
                webdav: { url: 'https://dav.example.com/mindwtr/data.json/' }, dropboxRev: null,
            };
            const transport = makeTransport();
            const io = createSyncBackendIO(ctx, transport);

            await io.readRemote();
            expect(ctx.syncUrl).toBe('https://dav.example.com/mindwtr/data.json');
            expect(transport.webdavGet).toHaveBeenCalledTimes(1);

            const outcome = await io.writeRemote(APP_DATA);
            expect(transport.webdavPut).toHaveBeenCalledWith(APP_DATA, '"webdav-read-v1"');
            expect(outcome).toEqual({ fingerprint: 'webdav-fp', serverMergedRemoteData: false });

            await expect(io.readRemoteFingerprint!()).resolves.toBe('webdav-head-fp');

            await io.syncAttachments!(APP_DATA, helpers);
            expect(transport.syncWebdavAttachments).toHaveBeenCalledWith(APP_DATA, helpers);
        });

        it('threads the mutation guard into the actual WebDAV write attempt', async () => {
            const ctx: SyncBackendContext = {
                backend: 'webdav', cloudProvider: 'selfhosted',
                webdav: { url: 'https://dav.example.com/data.json' }, dropboxRev: null,
            };
            const transport = makeTransport();
            const io = createSyncBackendIO(ctx, transport);
            const guard = vi.fn().mockResolvedValue(undefined);
            await io.readRemote();

            await io.writeRemote(APP_DATA, guard);

            expect(transport.webdavPut).toHaveBeenCalledWith(APP_DATA, '"webdav-read-v1"', guard);
        });

        it('skips attachment sync when webdav is unconfigured', async () => {
            const ctx: SyncBackendContext = { backend: 'webdav', cloudProvider: 'selfhosted', webdav: null, dropboxRev: null };
            const transport = makeTransport();
            const io = createSyncBackendIO(ctx, transport);
            await expect(io.syncAttachments!(APP_DATA, helpers)).resolves.toBeNull();
            expect(transport.syncWebdavAttachments).not.toHaveBeenCalled();
        });

        it('uses create-only semantics after a confirmed missing read', async () => {
            const ctx: SyncBackendContext = {
                backend: 'webdav', cloudProvider: 'selfhosted',
                webdav: { url: 'https://dav.example.com/data.json' }, dropboxRev: null,
            };
            const transport = makeTransport({
                webdavGet: vi.fn().mockResolvedValue({ data: null, exists: false, strongEtag: null }),
            });
            const io = createSyncBackendIO(ctx, transport);

            await io.readRemote();
            await io.writeRemote(APP_DATA);

            expect(transport.webdavPut).toHaveBeenCalledWith(APP_DATA, null);
        });

        it('refuses to replace an existing document without a strong ETag', async () => {
            const ctx: SyncBackendContext = {
                backend: 'webdav', cloudProvider: 'selfhosted',
                webdav: { url: 'https://dav.example.com/data.json' }, dropboxRev: null,
            };
            const transport = makeTransport({
                webdavGet: vi.fn().mockResolvedValue({ data: APP_DATA, exists: true, strongEtag: null }),
            });
            const io = createSyncBackendIO(ctx, transport);

            await io.readRemote();
            await expect(io.writeRemote(APP_DATA)).rejects.toThrow('safe strong ETag');
            expect(transport.webdavPut).not.toHaveBeenCalled();
        });

        it('degrades an encryption-off cycle to the plaintext write when the read has no strong ETag', async () => {
            // A Nextcloud-class server behind a proxy answered one GET without a usable
            // validator while the capability probe had already classed it strong-ETag.
            // Encryption is off, so the cycle degrades to the bounded plaintext write
            // instead of failing with SYNC_ENCRYPTION_REMOTE_VERSION_UNAVAILABLE.
            const ctx: SyncBackendContext = {
                backend: 'webdav', cloudProvider: 'selfhosted',
                webdav: { url: 'https://dav.example.com/data.json' }, dropboxRev: null,
                syncEncryptionOff: true,
            };
            const webdavGet = vi.fn()
                .mockResolvedValue({ data: APP_DATA, exists: true, strongEtag: null });
            const transport = makeTransport({ webdavGet });
            const io = createSyncBackendIO(ctx, transport);

            await io.readRemote();
            expect(ctx.allowLegacyWebdavPlaintext).toBe(true);
            await expect(io.writeRemote(APP_DATA)).resolves.toEqual({
                fingerprint: 'webdav-legacy-fp',
                serverMergedRemoteData: false,
            });
            expect(transport.webdavPut).not.toHaveBeenCalled();
        });

        it('prefers strong-ETag CAS when the degraded cycle rereads a validator back', async () => {
            const ctx: SyncBackendContext = {
                backend: 'webdav', cloudProvider: 'selfhosted',
                webdav: { url: 'https://dav.example.com/data.json' }, dropboxRev: null,
                syncEncryptionOff: true,
            };
            const webdavGet = vi.fn()
                .mockResolvedValueOnce({ data: APP_DATA, exists: true, strongEtag: null })
                .mockResolvedValueOnce({ data: APP_DATA, exists: true, strongEtag: '"back-v2"' });
            const transport = makeTransport({ webdavGet });
            const io = createSyncBackendIO(ctx, transport);

            await io.readRemote();
            await io.writeRemote(APP_DATA);

            expect(transport.webdavPut).toHaveBeenCalledWith(APP_DATA, '"back-v2"');
            expect(transport.webdavPutLegacyPlaintext).not.toHaveBeenCalled();
        });

        it('leaves an encryption-off cycle on strong-ETag CAS while the read carries a validator', async () => {
            const ctx: SyncBackendContext = {
                backend: 'webdav', cloudProvider: 'selfhosted',
                webdav: { url: 'https://dav.example.com/data.json' }, dropboxRev: null,
                syncEncryptionOff: true,
            };
            const transport = makeTransport();
            const io = createSyncBackendIO(ctx, transport);

            await io.readRemote();
            expect(ctx.allowLegacyWebdavPlaintext).toBeFalsy();
            await io.writeRemote(APP_DATA);

            expect(transport.webdavPut).toHaveBeenCalledWith(APP_DATA, '"webdav-read-v1"');
            expect(transport.webdavPutLegacyPlaintext).not.toHaveBeenCalled();
        });

        it('uses one explicit legacy plaintext write after a matching bounded reread', async () => {
            const ctx: SyncBackendContext = {
                backend: 'webdav', cloudProvider: 'selfhosted',
                webdav: { url: 'https://dav.example.com/data.json' }, dropboxRev: null,
                allowLegacyWebdavPlaintext: true,
            };
            const webdavGet = vi.fn()
                .mockResolvedValue({ data: APP_DATA, exists: true, strongEtag: null });
            const transport = makeTransport({ webdavGet });
            const io = createSyncBackendIO(ctx, transport);
            const guard = vi.fn().mockResolvedValue(undefined);

            await io.readRemote();
            await expect(io.writeRemote(APP_DATA, guard)).resolves.toEqual({
                fingerprint: 'webdav-legacy-fp',
                serverMergedRemoteData: false,
            });

            expect(webdavGet).toHaveBeenCalledTimes(2);
            expect(guard).toHaveBeenCalled();
            expect(transport.webdavPutLegacyPlaintext).toHaveBeenCalledWith(APP_DATA, guard);
            expect(transport.webdavPut).not.toHaveBeenCalled();
        });

        it('uses the bounded one-shot legacy transport when the weak-ETag document became absent', async () => {
            const ctx: SyncBackendContext = {
                backend: 'webdav', cloudProvider: 'selfhosted',
                webdav: { url: 'https://dav.example.com/data.json' }, dropboxRev: null,
                allowLegacyWebdavPlaintext: true,
            };
            const webdavGet = vi.fn()
                .mockResolvedValue({ data: null, exists: false, strongEtag: null });
            const transport = makeTransport({ webdavGet });
            const io = createSyncBackendIO(ctx, transport);

            await io.readRemote();
            await expect(io.writeRemote(APP_DATA)).resolves.toEqual({
                fingerprint: 'webdav-legacy-fp',
                serverMergedRemoteData: false,
            });

            expect(webdavGet).toHaveBeenCalledTimes(2);
            expect(transport.webdavPutLegacyPlaintext).toHaveBeenCalledOnce();
            expect(transport.webdavPutLegacyPlaintext).toHaveBeenCalledWith(APP_DATA);
            expect(transport.webdavPut).not.toHaveBeenCalled();
        });

        it('requeues instead of overwriting when a weak-ETag remote changes before legacy plaintext write', async () => {
            const ctx: SyncBackendContext = {
                backend: 'webdav', cloudProvider: 'selfhosted',
                webdav: { url: 'https://dav.example.com/data.json' }, dropboxRev: null,
                allowLegacyWebdavPlaintext: true,
            };
            const changed = { ...APP_DATA, tasks: [{ id: 'peer' }] } as AppData;
            const webdavGet = vi.fn()
                .mockResolvedValueOnce({ data: APP_DATA, exists: true, strongEtag: null })
                .mockResolvedValueOnce({ data: changed, exists: true, strongEtag: null });
            const transport = makeTransport({ webdavGet });
            const io = createSyncBackendIO(ctx, transport);

            await io.readRemote();
            await expect(io.writeRemote(APP_DATA)).rejects.toBeInstanceOf(SyncRemoteWriteConflict);

            expect(transport.webdavPutLegacyPlaintext).not.toHaveBeenCalled();
            expect(transport.webdavPut).not.toHaveBeenCalled();
        });

        it('upgrades a matching legacy reread to strong-ETag CAS when support appears', async () => {
            const ctx: SyncBackendContext = {
                backend: 'webdav', cloudProvider: 'selfhosted',
                webdav: { url: 'https://dav.example.com/data.json' }, dropboxRev: null,
                allowLegacyWebdavPlaintext: true,
            };
            const webdavGet = vi.fn()
                .mockResolvedValueOnce({ data: APP_DATA, exists: true, strongEtag: null })
                .mockResolvedValueOnce({ data: APP_DATA, exists: true, strongEtag: '"upgraded-v2"' });
            const transport = makeTransport({ webdavGet });
            const io = createSyncBackendIO(ctx, transport);

            await io.readRemote();
            await io.writeRemote(APP_DATA);

            expect(transport.webdavPut).toHaveBeenCalledWith(APP_DATA, '"upgraded-v2"');
            expect(transport.webdavPutLegacyPlaintext).not.toHaveBeenCalled();
        });

        it('maps a conditional WebDAV conflict into SyncRemoteWriteConflict', async () => {
            const ctx: SyncBackendContext = {
                backend: 'webdav', cloudProvider: 'selfhosted',
                webdav: { url: 'https://dav.example.com/data.json' }, dropboxRev: null,
            };
            const transport = makeTransport({
                webdavPut: vi.fn().mockRejectedValue(new WebDavRemoteWriteConflictError(412)),
            });
            const io = createSyncBackendIO(ctx, transport);

            await io.readRemote();
            await expect(io.writeRemote(APP_DATA)).rejects.toBeInstanceOf(SyncRemoteWriteConflict);
        });

        it('preserves a native invalid-JSON read validator for a conditional repair', async () => {
            const ctx: SyncBackendContext = {
                backend: 'webdav', cloudProvider: 'selfhosted',
                webdav: { url: 'https://dav.example.com/data.json' }, dropboxRev: null,
            };
            const invalid = new Error('Invalid WebDAV response: error decoding response body [mindwtr-webdav-version:existing:"broken-v1"]');
            const transport = makeTransport({ webdavGet: vi.fn().mockRejectedValue(invalid) });
            const io = createSyncBackendIO(ctx, transport);

            await expect(io.readRemote()).rejects.toBe(invalid);
            await io.writeRemote(APP_DATA);

            expect(transport.webdavPut).toHaveBeenCalledWith(APP_DATA, '"broken-v1"');
        });
    });

    describe('cloud + selfhosted', () => {
        it('throws when unconfigured', async () => {
            const ctx: SyncBackendContext = { backend: 'cloud', cloudProvider: 'selfhosted', cloud: null, dropboxRev: null };
            const transport = makeTransport();
            const io = createSyncBackendIO(ctx, transport);
            await expect(io.readRemote()).rejects.toThrow('Self-hosted URL not configured');
            expect(transport.cloudGet).not.toHaveBeenCalled();
        });

        it('normalizes the url and reads/writes/heads through the cloud transport', async () => {
            const ctx: SyncBackendContext = {
                backend: 'cloud', cloudProvider: 'selfhosted',
                cloud: { url: 'https://cloud.example.com/v1/data/' }, dropboxRev: null,
            };
            const transport = makeTransport();
            const io = createSyncBackendIO(ctx, transport);

            await io.readRemote();
            expect(ctx.syncUrl).toBe('https://cloud.example.com/v1/data');

            await io.writeRemote(APP_DATA);
            expect(transport.cloudPut).toHaveBeenCalledWith(APP_DATA);

            await expect(io.readRemoteFingerprint!()).resolves.toBe('cloud-head-fp');

            await io.syncAttachments!(APP_DATA, helpers);
            expect(transport.syncCloudAttachments).toHaveBeenCalledWith(APP_DATA, helpers);
        });
    });

    describe('cloud + dropbox', () => {
        const baseCtx = (): SyncBackendContext => ({
            backend: 'cloud', cloudProvider: 'dropbox', dropboxAppKey: 'app-key', dropboxRev: null,
        });

        it('throws when no app key is configured', async () => {
            const ctx: SyncBackendContext = { backend: 'cloud', cloudProvider: 'dropbox', dropboxAppKey: '', dropboxRev: null };
            const transport = makeTransport();
            const io = createSyncBackendIO(ctx, transport);
            await expect(io.readRemote()).rejects.toThrow('Dropbox app key is not configured');
        });

        it('acquires the Dropbox mutation fence with the auth-retry contract', async () => {
            const lease = fenceLease();
            const resolveDropboxToken = vi.fn()
                .mockResolvedValueOnce('stale-token')
                .mockResolvedValueOnce('fresh-token');
            const acquireDropboxRemoteMutationFence = vi.fn()
                .mockRejectedValueOnce(new DropboxUnauthorizedError())
                .mockResolvedValueOnce(lease);
            const io = createSyncBackendIO(baseCtx(), makeTransport({
                resolveDropboxToken,
                acquireDropboxRemoteMutationFence,
            }));

            await expect(io.acquireRemoteMutationFence!()).resolves.toBe(lease);
            expect(acquireDropboxRemoteMutationFence).toHaveBeenNthCalledWith(1, 'stale-token');
            expect(acquireDropboxRemoteMutationFence).toHaveBeenNthCalledWith(2, 'fresh-token');
        });

        it('reads, caches the rev, writes, and refreshes the fingerprint using the dropbox:v1:rev= format', async () => {
            const ctx = baseCtx();
            const transport = makeTransport();
            const io = createSyncBackendIO(ctx, transport);

            await io.readRemote();
            expect(ctx.dropboxRev).toBe('rev-1');
            expect(io.getCachedRemoteFingerprint!()).toBe('dropbox:v1:rev=rev-1');

            await io.writeRemote(APP_DATA);
            expect(transport.dropboxUpload).toHaveBeenCalledWith('token', APP_DATA, 'rev-1');
            expect(ctx.dropboxRev).toBe('rev-2');

            const fp = await io.readRemoteFingerprint!();
            expect(fp).toBe('dropbox:v1:rev=rev-3');
            expect(ctx.dropboxRev).toBe('rev-3');

            await io.syncAttachments!(APP_DATA, helpers);
            expect(transport.syncDropboxAttachments).toHaveBeenCalledWith(APP_DATA, helpers);
        });

        it('threads the mutation guard through a Dropbox auth refresh retry', async () => {
            const ctx = baseCtx();
            ctx.dropboxRev = 'rev-1';
            const guard = vi.fn().mockResolvedValue(undefined);
            const resolveDropboxToken = vi.fn()
                .mockResolvedValueOnce('stale-token')
                .mockResolvedValueOnce('fresh-token');
            const dropboxUpload = vi.fn()
                .mockRejectedValueOnce(new DropboxUnauthorizedError())
                .mockResolvedValueOnce({ rev: 'rev-2' });
            const io = createSyncBackendIO(ctx, makeTransport({ resolveDropboxToken, dropboxUpload }));

            await io.writeRemote(APP_DATA, guard);

            expect(dropboxUpload).toHaveBeenNthCalledWith(1, 'stale-token', APP_DATA, 'rev-1', guard);
            expect(dropboxUpload).toHaveBeenNthCalledWith(2, 'fresh-token', APP_DATA, 'rev-1', guard);
        });

        it('has no cached fingerprint when no rev is known yet', () => {
            const ctx = baseCtx();
            const io = createSyncBackendIO(ctx, makeTransport());
            expect(io.getCachedRemoteFingerprint!()).toBeNull();
        });

        it('maps a DropboxConflictError from writeRemote into SyncRemoteWriteConflict', async () => {
            const ctx = baseCtx();
            const transport = makeTransport({
                dropboxUpload: vi.fn().mockRejectedValue(new DropboxConflictError()),
            });
            const io = createSyncBackendIO(ctx, transport);
            await expect(io.writeRemote(APP_DATA)).rejects.toBeInstanceOf(SyncRemoteWriteConflict);
        });

        it('retries exactly once on an unauthorized token, then succeeds', async () => {
            const ctx = baseCtx();
            const resolveDropboxToken = vi.fn()
                .mockResolvedValueOnce('stale-token')
                .mockResolvedValueOnce('fresh-token');
            const dropboxDownload = vi.fn()
                .mockRejectedValueOnce(new DropboxUnauthorizedError())
                .mockResolvedValueOnce({ data: APP_DATA, rev: 'rev-1' });
            const transport = makeTransport({ resolveDropboxToken, dropboxDownload });
            const io = createSyncBackendIO(ctx, transport);

            await expect(io.readRemote()).resolves.toBe(APP_DATA);
            expect(resolveDropboxToken).toHaveBeenNthCalledWith(1, false);
            expect(resolveDropboxToken).toHaveBeenNthCalledWith(2, true);
            expect(dropboxDownload).toHaveBeenCalledTimes(2);
        });

        it('gives up after exactly one retry when the token stays unauthorized', async () => {
            const ctx = baseCtx();
            const resolveDropboxToken = vi.fn().mockResolvedValue('token');
            const dropboxDownload = vi.fn().mockRejectedValue(new DropboxUnauthorizedError());
            const transport = makeTransport({ resolveDropboxToken, dropboxDownload });
            const io = createSyncBackendIO(ctx, transport);

            await expect(io.readRemote()).rejects.toBeInstanceOf(DropboxUnauthorizedError);
            expect(resolveDropboxToken).toHaveBeenCalledTimes(2);
            expect(dropboxDownload).toHaveBeenCalledTimes(2);
        });

        it('does not retry a non-auth error', async () => {
            const ctx = baseCtx();
            const resolveDropboxToken = vi.fn().mockResolvedValue('token');
            const dropboxDownload = vi.fn().mockRejectedValue(new Error('HTTP 500'));
            const transport = makeTransport({ resolveDropboxToken, dropboxDownload });
            const io = createSyncBackendIO(ctx, transport);

            await expect(io.readRemote()).rejects.toThrow('HTTP 500');
            expect(resolveDropboxToken).toHaveBeenCalledTimes(1);
            expect(dropboxDownload).toHaveBeenCalledTimes(1);
        });
    });

    describe('file', () => {
        it('does not acquire a provider fence for File Sync', async () => {
            const transport = makeTransport({
                acquireWebdavRemoteMutationFence: vi.fn().mockResolvedValue(fenceLease()),
                acquireDropboxRemoteMutationFence: vi.fn().mockResolvedValue(fenceLease()),
            });
            const io = createSyncBackendIO({
                backend: 'file', cloudProvider: 'selfhosted', filePath: '/tmp/sync', dropboxRev: null,
            }, transport);

            await expect(io.acquireRemoteMutationFence!()).resolves.toBeNull();
            expect(transport.acquireWebdavRemoteMutationFence).not.toHaveBeenCalled();
            expect(transport.acquireDropboxRemoteMutationFence).not.toHaveBeenCalled();
        });

        it('reads, writes, and syncs attachments through the file transport', async () => {
            const ctx: SyncBackendContext = { backend: 'file', cloudProvider: 'selfhosted', filePath: '/tmp/sync', dropboxRev: null };
            const transport = makeTransport();
            const io = createSyncBackendIO(ctx, transport);

            await expect(io.readRemote()).resolves.toBe(APP_DATA);
            expect(transport.fileRead).toHaveBeenCalledTimes(1);

            await io.writeRemote(APP_DATA);
            expect(transport.fileWrite).toHaveBeenCalledWith(APP_DATA);

            await expect(io.readRemoteFingerprint!()).resolves.toBeNull();

            await io.syncAttachments!(APP_DATA, helpers);
            expect(transport.syncFileAttachments).toHaveBeenCalledWith(APP_DATA, helpers);
        });

        it('threads the version from a file read into the matching write', async () => {
            const ctx: SyncBackendContext = {
                backend: 'file', cloudProvider: 'selfhosted', filePath: '/tmp/sync', dropboxRev: null,
            };
            const transport = makeTransport({
                fileRead: vi.fn().mockResolvedValue({
                    data: APP_DATA,
                    fingerprint: 'file-v1',
                    source: 'backup',
                    needsRepair: true,
                }),
            });
            const io = createSyncBackendIO(ctx, transport);

            await expect(io.readRemote()).resolves.toBe(APP_DATA);
            expect(io.requiresRemoteRepair?.()).toBe(true);
            await io.writeRemote(APP_DATA);

            expect(transport.fileWrite).toHaveBeenCalledWith(APP_DATA, 'file-v1');
            expect(io.requiresRemoteRepair?.()).toBe(false);
        });

        it('skips attachment sync when no file path is configured', async () => {
            const ctx: SyncBackendContext = { backend: 'file', cloudProvider: 'selfhosted', filePath: '', dropboxRev: null };
            const transport = makeTransport();
            const io = createSyncBackendIO(ctx, transport);
            await expect(io.syncAttachments!(APP_DATA, helpers)).resolves.toBeNull();
            expect(transport.syncFileAttachments).not.toHaveBeenCalled();
        });
    });

    it('reports the last request url via getSyncUrl', async () => {
        const ctx: SyncBackendContext = {
            backend: 'webdav', cloudProvider: 'selfhosted',
            webdav: { url: 'https://dav.example.com/data.json' }, dropboxRev: null,
        };
        const io = createSyncBackendIO(ctx, makeTransport());
        expect(io.getSyncUrl!()).toBeUndefined();
        await io.readRemote();
        expect(io.getSyncUrl!()).toBe('https://dav.example.com/data.json');
    });
});
