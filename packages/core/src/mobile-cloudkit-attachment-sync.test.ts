import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppData, Attachment } from './types';
import { createMobileAttachmentFiles } from './mobile-attachment-files';
import { createMobileAttachmentCommon, type MobileAttachmentCommonHost } from './mobile-attachment-common';
import { createMobileAttachmentAvailability } from './mobile-attachment-availability';
import { SYNC_BACKEND_KEY } from './sync-storage-keys';
import { defaultSyncCryptoPrimitives } from './sync-crypto';
import { createMobileCloudKitAttachmentSync, type MobileCloudKitAttachmentAssetPort } from './mobile-cloudkit-attachment-sync';
import { createMemoryFileSystem, createMemoryStorage, createRecordingLog, MANAGED } from './__fixtures__/mobile-attachment-fakes';

const NOW = '2026-10-30T12:00:00.000Z';
const LOCAL = new Uint8Array([1, 2, 3]);
const REMOTE = new Uint8Array([9, 8, 7, 6]);
const TARGET = `${MANAGED}attachment-1.txt`;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const attachment = (patch: Partial<Attachment> = {}): Attachment => ({
    id: 'attachment-1', kind: 'file', title: 'attachment-1.txt', mimeType: 'text/plain',
    uri: TARGET, localStatus: 'available', createdAt: NOW, updatedAt: NOW, ...patch,
});
const document = (file?: Attachment): AppData => ({
    tasks: [{ id: 'task-1', title: 'Synthetic task', status: 'next', tags: [], contexts: [],
        createdAt: NOW, updatedAt: NOW, attachments: file ? [file] : [] }],
    projects: [], sections: [], areas: [], settings: {},
});
const downloaded = (result: AppData | false) => result && result.tasks[0].attachments?.[0];

const setup = () => {
    const memory = createMemoryFileSystem({ sha256: async bytes => hash(bytes) });
    const { storage } = createMemoryStorage({ [SYNC_BACKEND_KEY]: 'cloudkit' });
    const { log, lines } = createRecordingLog();
    const files = createMobileAttachmentFiles({ fs: memory.fs, storage, log, fetch,
        getSecureConfigValue: async () => null,
        dropboxAuth: { getValidAccessToken: async () => '', forceRefreshAccessToken: async () => '' },
        core: { isSandboxMode: () => false },
    });
    const markReconciled = vi.spyOn(files, 'markAttachmentPresenceReconciled');
    const install = vi.fn<MobileAttachmentCommonHost['installer']['installAttachmentFileGeneration']>(async (stage, target) => {
        await memory.fs.move(stage, target);
        return { status: 'installed' };
    });
    const common = createMobileAttachmentCommon({ fs: memory.fs, files, crypto: defaultSyncCryptoPrimitives,
        encryption: { logSyncEncryptionEvent: async () => {} }, installer: { installAttachmentFileGeneration: install },
        installerMayBeMissing: () => false, timersPaused: () => false, uploads: { createUploadTask: () => null },
    });
    const save = vi.fn<MobileCloudKitAttachmentAssetPort['saveAttachmentAsset']>(async () => undefined);
    const fetchAsset = vi.fn<MobileCloudKitAttachmentAssetPort['fetchAttachmentAsset']>(async (_record, stage) => {
        await memory.fs.writeBytes(stage, REMOTE);
        return { attachmentId: 'attachment-1', ownerType: 'task', ownerId: 'task-1',
            title: 'Older remote title', mimeType: 'application/octet-stream', updatedAt: '2025-01-01T00:00:00.000Z', size: REMOTE.length };
    });
    const remove = vi.fn<MobileCloudKitAttachmentAssetPort['deleteAttachmentAssets']>(async () => {});
    const missing = new Error('Synthetic CloudKit asset not found');
    const cloudKit = { saveAttachmentAsset: save, fetchAttachmentAsset: fetchAsset, deleteAttachmentAssets: remove,
        isAttachmentNotFoundError: (error: unknown) => error === missing };
    const sync = createMobileCloudKitAttachmentSync({ files, common, cloudKit });
    const availability = createMobileAttachmentAvailability({ files, common, storage, cloudKit,
        encryption: { getSyncEncryptionMaterial: async () => null }, getDropboxClientId: async () => '',
        core: { isSandboxMode: () => false } });
    return { memory, sync, availability, save, fetchAsset, remove, missing, install, markReconciled, files, lines };
};

afterEach(() => vi.restoreAllMocks());

describe('shared CloudKit attachment sync', () => {
    it('defers prepare uploads, then uploads current bytes before publishing the key without changing the input', async () => {
        const f = setup(), input = document(attachment()), before = structuredClone(input);
        f.memory.put(TARGET, LOCAL);
        await f.sync(input, undefined, { phase: 'prepare', activationProbe: true });
        expect(f.save).not.toHaveBeenCalled();
        expect(f.markReconciled).not.toHaveBeenCalled();
        f.save.mockImplementation(async (record, uri, metadata) => {
            expect(record).toBe('attachment-1'); expect(f.memory.read(uri)).toEqual(LOCAL);
            expect(input.tasks[0].attachments?.[0].cloudKey).toBeUndefined();
            expect(metadata).toMatchObject({ attachmentId: record, ownerType: 'task', ownerId: 'task-1', fileHash: hash(LOCAL) });
        });
        const result = await f.sync(input, undefined, { phase: 'post-merge' });
        expect(f.save).toHaveBeenCalledOnce();
        expect(downloaded(result)).toMatchObject({ cloudKey: 'cloudkit:attachment-1', localStatus: 'available', size: LOCAL.length });
        expect(f.markReconciled).toHaveBeenCalledOnce();
        expect(input).toEqual(before);
    });

    it('fetches scratch and passes the original absent generation and verified hash to the installer', async () => {
        const f = setup(), input = document(attachment({ uri: '', localStatus: 'missing',
            cloudKey: 'cloudkit:attachment-1', fileHash: hash(REMOTE) })), before = structuredClone(input);
        const controller = new AbortController();
        const result = await f.sync(input, controller.signal, { phase: 'post-merge' });
        const stage = f.fetchAsset.mock.calls[0][1];
        expect(stage).toMatch(/\.mindwtr-download-.*\.staged$/); expect(stage).not.toBe(TARGET);
        expect(f.fetchAsset).toHaveBeenCalledWith('attachment-1', stage, { signal: controller.signal });
        expect(f.install).toHaveBeenCalledWith(stage, TARGET, { kind: 'absent' }, hash(REMOTE));
        expect(f.memory.read(TARGET)).toEqual(REMOTE); expect(f.memory.read(stage)).toBeUndefined();
        expect(downloaded(result)).toMatchObject({ title: 'attachment-1.txt', mimeType: 'text/plain', updatedAt: NOW,
            uri: TARGET, size: REMOTE.length, fileHash: hash(REMOTE), localStatus: 'available' });
        expect(input).toEqual(before);
    });

    it('preserves the conflicting target and installer-owned scratch rather than publishing fetched metadata', async () => {
        const f = setup(), input = document(attachment({ uri: '', localStatus: 'missing',
            cloudKey: 'cloudkit:attachment-1', fileHash: hash(REMOTE) }));
        f.install.mockImplementation(async (stage, target, expected) => {
            expect(expected).toEqual({ kind: 'absent' });
            f.memory.put(target, LOCAL);
            return { status: 'conflict', preservedPath: stage };
        });
        expect(await f.sync(input)).toBe(false);
        const stage = f.fetchAsset.mock.calls[0][1];
        expect(f.memory.read(TARGET)).toEqual(LOCAL); expect(f.memory.read(stage)).toEqual(REMOTE);
        expect(input.tasks[0].attachments?.[0].uri).toBe('');
    });

    it('keeps definitive absence live, backs off, and recovers the same identity', async () => {
        const f = setup(), original = attachment({ uri: '', localStatus: 'missing', cloudKey: 'cloudkit:attachment-1', fileHash: hash(REMOTE) });
        const input = document(original), before = structuredClone(input);
        f.fetchAsset.mockRejectedValueOnce(f.missing);
        expect(await f.sync(input)).toBe(false);
        expect(f.install).not.toHaveBeenCalled(); expect(input).toEqual(before);
        expect(f.files.getWebdavDownloadBackoff(original.id)).toBeGreaterThan(Date.now());
        expect(f.lines).toContainEqual(expect.objectContaining({
            level: 'warn', extra: expect.objectContaining({ releaseCheck: 'v1.3.8/attachment-not-found-kept' }),
        }));
        expect(await f.sync(input)).toBe(false); expect(f.fetchAsset).toHaveBeenCalledTimes(1);
        const result = await f.sync(input, undefined, { activationProbe: true });
        expect(downloaded(result)).toMatchObject({ cloudKey: original.cloudKey, fileHash: original.fileHash, localStatus: 'available' });
        expect(result && result.tasks[0].attachments?.[0].deletedAt).toBeUndefined();
        expect(f.memory.read(TARGET)).toEqual(REMOTE);
        expect(f.files.getWebdavDownloadBackoff(original.id)).not.toBeNull(); expect(input).toEqual(before);
    });

    it('selected CloudKit recovery clears old backoff before a newer merged generation arrives', async () => {
        const f = setup(), original = attachment({ uri: '', localStatus: 'missing', cloudKey: 'cloudkit:attachment-1', fileHash: hash(REMOTE) });
        f.fetchAsset.mockRejectedValueOnce(f.missing);
        expect(await f.sync(document(original))).toBe(false);
        expect(f.files.getWebdavDownloadBackoff(original.id)).not.toBeNull();
        const selected = await f.availability.ensureAttachmentAvailableDetailed(original);
        if (selected.status !== 'available') throw new Error('Expected selected CloudKit recovery');
        expect(f.files.getWebdavDownloadBackoff(original.id)).toBeNull();
        const present = await f.sync(document(selected.attachment), undefined, { phase: 'post-merge' });
        const current = present ? present.tasks[0].attachments![0] : selected.attachment;
        f.fetchAsset.mockImplementation(async (_record, stage) => {
            await f.memory.fs.writeBytes(stage, LOCAL);
            return { attachmentId: original.id, ownerType: 'task', ownerId: 'task-1', title: original.title,
                mimeType: 'text/plain', updatedAt: NOW, size: LOCAL.length };
        });
        const winner = { ...current, fileHash: hash(LOCAL), contentRev: 2, contentMtimeMs: undefined, contentSize: undefined };
        const result = await f.sync(document(winner), undefined, { phase: 'post-merge' });
        expect(f.fetchAsset).toHaveBeenCalledTimes(3);
        expect(f.memory.read(TARGET)).toEqual(LOCAL);
        expect(downloaded(result)).toMatchObject({ fileHash: hash(LOCAL), contentRev: 2, localStatus: 'available' });
    });

    it.each([false, true])('verified current CloudKit bytes release old backoff only outside an activation probe (%s)', async activationProbe => {
        const f = setup();
        f.memory.put(TARGET, LOCAL);
        f.files.setWebdavDownloadBackoff('attachment-1', { status: 404 });
        const blockedUntil = f.files.getWebdavDownloadBackoff('attachment-1');
        const current = attachment({ cloudKey: 'cloudkit:attachment-1', fileHash: hash(LOCAL), contentRev: 1 });
        await f.sync(document(current), undefined, { phase: 'post-merge', activationProbe });
        expect(f.fetchAsset).not.toHaveBeenCalled();
        expect(f.files.getWebdavDownloadBackoff(current.id)).toBe(activationProbe ? blockedUntil : null);
        if (!activationProbe) {
            const winner = { ...current, fileHash: hash(REMOTE), contentRev: 2 };
            const result = await f.sync(document(winner), undefined, { phase: 'post-merge' });
            expect(f.fetchAsset).toHaveBeenCalledTimes(1);
            expect(f.memory.read(TARGET)).toEqual(REMOTE);
            expect(downloaded(result)).toMatchObject({ fileHash: hash(REMOTE), contentRev: 2, localStatus: 'available' });
        }
    });

    it('a missing CloudKit remote winner keeps backoff even when stale local bytes remain', async () => {
        const f = setup();
        f.memory.put(TARGET, LOCAL);
        const winner = attachment({ cloudKey: 'cloudkit:attachment-1', fileHash: hash(REMOTE), contentRev: 2 });
        f.fetchAsset.mockRejectedValue(f.missing);
        await f.sync(document(winner), undefined, { phase: 'post-merge' });
        const blockedUntil = f.files.getWebdavDownloadBackoff(winner.id);
        expect(blockedUntil).toBeGreaterThan(Date.now());
        await f.sync(document(winner), undefined, { phase: 'post-merge' });
        expect(f.fetchAsset).toHaveBeenCalledTimes(1);
        expect(f.files.getWebdavDownloadBackoff(winner.id)).toBe(blockedUntil);
        expect(f.memory.read(TARGET)).toEqual(LOCAL);
    });

    it('an activation probe ignores ordinary backoff and marks only its trial copy', async () => {
        const f = setup(), input = document(attachment({ uri: '', localStatus: 'missing', cloudKey: 'cloudkit:attachment-1' }));
        f.files.setWebdavDownloadBackoff('attachment-1', { status: 404 });
        const blockedUntil = f.files.getWebdavDownloadBackoff('attachment-1');
        f.fetchAsset.mockRejectedValue(f.missing);
        const result = await f.sync(input, undefined, { activationProbe: true });
        expect(result && result.tasks[0].attachments?.[0].deletedAt).toBeTruthy();
        expect(f.files.getWebdavDownloadBackoff('attachment-1')).toBe(blockedUntil);
        expect(input.tasks[0].attachments?.[0].deletedAt).toBeUndefined();
    });

    it('retains pending delete settings on failure and removes only confirmed CloudKit keys', async () => {
        const f = setup(), input = document();
        input.settings.attachments = { pendingRemoteDeletes: [{ cloudKey: 'cloudkit:old-1' }, { cloudKey: 'other-backend/key' }] };
        const before = structuredClone(input);
        f.remove.mockRejectedValueOnce(new Error('Synthetic delete failure'));
        await expect(f.sync(input)).rejects.toThrow('Synthetic delete failure');
        expect(input).toEqual(before);
        const result = await f.sync(input);
        expect(f.remove).toHaveBeenLastCalledWith(['old-1'], { signal: undefined });
        expect(result && result.settings.attachments?.pendingRemoteDeletes).toEqual([{ cloudKey: 'other-backend/key' }]);
        expect(input).toEqual(before);
    });

    it('cleans pre-install scratch and propagates fatal cancellation without recording reconciliation', async () => {
        const f = setup(), controller = new AbortController(), cancelled = new Error('Synthetic cancelled');
        const input = document(attachment({ uri: '', localStatus: 'missing', cloudKey: 'cloudkit:attachment-1' }));
        const before = structuredClone(input);
        f.fetchAsset.mockImplementation(async (_record, stage) => {
            await f.memory.fs.writeBytes(stage, REMOTE); controller.abort(cancelled); throw cancelled;
        });
        await expect(f.sync(input, controller.signal)).rejects.toBe(cancelled);
        expect(f.install).not.toHaveBeenCalled(); expect(f.markReconciled).not.toHaveBeenCalled();
        expect(f.memory.read(f.fetchAsset.mock.calls[0][1])).toBeUndefined(); expect(input).toEqual(before);
    });
});
