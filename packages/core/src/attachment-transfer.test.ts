import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppData, Attachment, AttachmentSettings, Project, Task } from './types';
import {
    AttachmentUploadTooLargeError,
    AttachmentUploadSizeUnavailableError,
    applyAttachmentPatches,
    assertBufferedAttachmentUploadSize,
    collectAttachmentsById,
    MAX_FILE_SYNC_BUFFERED_PLAINTEXT_BYTES,
    normalizePendingRemoteDeletes,
    resetUnhashableAttachmentStatsForTests,
    runAttachmentTransferLifecycle,
    validateAttachmentHash,
    withAttachmentSettingsPatch,
    type AttachmentTransferLifecycleOptions,
} from './attachment-transfer';
import { setSha256HexProvider } from './attachment-hash';

const makeAttachment = (overrides: Partial<Attachment>): Attachment => ({
    id: 'attachment-1',
    kind: 'file',
    title: 'Attachment',
    uri: '/local/file.txt',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
});

const makeTask = (overrides: Partial<Task>): Task => ({
    id: 'task-1',
    title: 'Task',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
});

const makeProject = (overrides: Partial<Project>): Project => ({
    id: 'project-1',
    title: 'Project',
    color: '#94a3b8',
    order: 0,
    status: 'active',
    tagIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
});

const makeData = (overrides: Partial<AppData>): AppData => ({
    tasks: [],
    projects: [],
    sections: [],
    areas: [],
    settings: {},
    ...overrides,
});

/**
 * The lifecycle never writes to its inputs: it reports every change as a patch keyed by
 * attachment id. `after(id)` is where a test reads the post-run value — the patch when one
 * was produced, otherwise the (pristine) input, which is exactly what the platform backends
 * see once {@link applyAttachmentPatches} has folded the patches back into the document.
 */
const runLifecycle = async (options: AttachmentTransferLifecycleOptions) => {
    const { changed, patches } = await runAttachmentTransferLifecycle(options);
    return {
        didMutate: changed,
        patches,
        after: (id = 'attachment-1'): Attachment => patches.get(id) ?? options.attachmentsById.get(id)!,
    };
};

const deepFreeze = <T>(value: T): T => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    }
    return value;
};

describe('runAttachmentTransferLifecycle', () => {
    it('rejects an oversized buffered upload before snapshot creation without changing pending metadata', async () => {
        const attachment = makeAttachment({
            cloudKey: 'attachments/attachment-1.txt',
            fileHash: 'ab'.repeat(32),
            pendingContentUpload: true,
            localStatus: 'available',
            contentMtimeMs: 1000,
            contentSize: 10,
        });
        const createUploadSnapshot = vi.fn();
        const onUpload = vi.fn();

        await expect(runLifecycle({
            attachmentsById: new Map([[attachment.id, attachment]]),
            getLocalFilePresence: vi.fn(async () => 'present' as const),
            getLocalFileStat: vi.fn(async () => ({ mtimeMs: 2000, size: 11 })),
            maxBufferedUploadBytes: 10,
            createUploadSnapshot,
            requireUploadSnapshot: true,
            contentChangePhase: 'post-merge',
            onUpload,
            onUploadError: vi.fn(),
            onDownload: vi.fn(),
            onDownloadError: vi.fn(),
            isFatalError: (error) => error instanceof AttachmentUploadTooLargeError,
        })).rejects.toMatchObject({
            name: 'AttachmentUploadTooLargeError',
            actualBytes: 11,
            limitBytes: 10,
        });

        expect(createUploadSnapshot).not.toHaveBeenCalled();
        expect(onUpload).not.toHaveBeenCalled();
        expect(attachment).toEqual(makeAttachment({
            cloudKey: 'attachments/attachment-1.txt',
            fileHash: 'ab'.repeat(32),
            pendingContentUpload: true,
            localStatus: 'available',
            contentMtimeMs: 1000,
            contentSize: 10,
        }));
    });

    it('rejects an oversized changed file before hashing it', async () => {
        const attachment = makeAttachment({
            cloudKey: 'attachments/attachment-1.txt',
            fileHash: 'ab'.repeat(32),
            localStatus: 'available',
            contentMtimeMs: 1000,
            contentSize: 10,
        });
        const computeLocalFileHash = vi.fn();

        await expect(runLifecycle({
            attachmentsById: new Map([[attachment.id, attachment]]),
            getLocalFilePresence: vi.fn(async () => 'present' as const),
            getLocalFileStat: vi.fn(async () => ({ mtimeMs: 2000, size: 11 })),
            computeLocalFileHash,
            maxBufferedUploadBytes: 10,
            contentChangePhase: 'prepare',
            onUpload: vi.fn(),
            onUploadError: vi.fn(),
            onDownload: vi.fn(),
            onDownloadError: vi.fn(),
        })).rejects.toBeInstanceOf(AttachmentUploadTooLargeError);

        expect(computeLocalFileHash).not.toHaveBeenCalled();
    });

    it('reserves the MWENC1 envelope inside the File Sync buffered-read ceiling', () => {
        expect(MAX_FILE_SYNC_BUFFERED_PLAINTEXT_BYTES + 70).toBe(100 * 1024 * 1024);
        expect(() => assertBufferedAttachmentUploadSize(
            MAX_FILE_SYNC_BUFFERED_PLAINTEXT_BYTES,
            MAX_FILE_SYNC_BUFFERED_PLAINTEXT_BYTES,
        )).not.toThrow();
        expect(() => assertBufferedAttachmentUploadSize(
            MAX_FILE_SYNC_BUFFERED_PLAINTEXT_BYTES + 1,
            MAX_FILE_SYNC_BUFFERED_PLAINTEXT_BYTES,
        )).toThrow(AttachmentUploadTooLargeError);
        expect(() => assertBufferedAttachmentUploadSize(
            Number.NaN,
            MAX_FILE_SYNC_BUFFERED_PLAINTEXT_BYTES,
        )).toThrow(AttachmentUploadSizeUnavailableError);
    });

    it('uploads local file attachments that do not yet have a cloud key', async () => {
        const attachment = makeAttachment({ localStatus: 'missing' });
        const onUpload = vi.fn(async (item: Attachment) => {
            item.cloudKey = 'attachments/attachment-1.txt';
            return true;
        });
        const { didMutate, after } = await runLifecycle({
            attachmentsById: new Map([[attachment.id, attachment]]),
            getLocalFilePresence: vi.fn(async () => 'present' as const),
            onUpload,
            onUploadError: vi.fn(),
            onDownload: vi.fn(),
            onDownloadError: vi.fn(),
        });

        expect(didMutate).toBe(true);
        expect(after().localStatus).toBe('available');
        expect(after().cloudKey).toBe('attachments/attachment-1.txt');
        expect(onUpload).toHaveBeenCalledWith(after(), '/local/file.txt');
        // The input object is never written to — that is the whole point of the patch contract.
        expect(attachment.localStatus).toBe('missing');
        expect(attachment.cloudKey).toBeUndefined();
    });

    it('downloads remote attachments when the local file is missing', async () => {
        const attachment = makeAttachment({ cloudKey: 'attachments/attachment-1.txt', localStatus: 'available' });
        const onDownload = vi.fn(async (item: Attachment) => {
            item.uri = '/local/downloaded.txt';
            item.localStatus = 'available';
            return true;
        });
        const { didMutate, after } = await runLifecycle({
            attachmentsById: new Map([[attachment.id, attachment]]),
            getLocalFilePresence: vi.fn(async () => 'confirmed-not-found' as const),
            onUpload: vi.fn(),
            onUploadError: vi.fn(),
            onDownload,
            onDownloadError: vi.fn(),
        });

        expect(didMutate).toBe(true);
        expect(onDownload).toHaveBeenCalledWith(after(), { kind: 'absent' });
        expect(after().uri).toBe('/local/downloaded.txt');
        expect(attachment.uri).toBe('/local/file.txt');
    });

    it('preserves all metadata and performs no transfer work when local presence is unreadable', async () => {
        const attachment = makeAttachment({
            cloudKey: 'attachments/attachment-1.txt',
            fileHash: 'ab'.repeat(32),
            pendingContentUpload: true,
            localStatus: 'available',
            contentMtimeMs: 123,
            contentSize: 456,
        });
        const onUpload = vi.fn();
        const onDownload = vi.fn();
        const getLocalFileStat = vi.fn();
        const computeLocalFileHash = vi.fn();
        const createUploadSnapshot = vi.fn();

        const { didMutate, patches } = await runLifecycle({
            attachmentsById: new Map([[attachment.id, attachment]]),
            getLocalFilePresence: vi.fn(async () => 'unreadable' as const),
            onUpload,
            onUploadError: vi.fn(),
            onDownload,
            onDownloadError: vi.fn(),
            getLocalFileStat,
            computeLocalFileHash,
            createUploadSnapshot,
            contentChangePhase: 'post-merge',
        });

        expect(didMutate).toBe(false);
        expect(patches.size).toBe(0);
        expect(onUpload).not.toHaveBeenCalled();
        expect(onDownload).not.toHaveBeenCalled();
        expect(getLocalFileStat).not.toHaveBeenCalled();
        expect(computeLocalFileHash).not.toHaveBeenCalled();
        expect(createUploadSnapshot).not.toHaveBeenCalled();
        expect(attachment).toEqual(makeAttachment({
            cloudKey: 'attachments/attachment-1.txt',
            fileHash: 'ab'.repeat(32),
            pendingContentUpload: true,
            localStatus: 'available',
            contentMtimeMs: 123,
            contentSize: 456,
        }));
    });

    it('is a no-op on the second aligned pass', async () => {
        const attachment = makeAttachment({ cloudKey: 'attachments/attachment-1.txt', localStatus: 'available' });
        const { didMutate, patches } = await runLifecycle({
            attachmentsById: new Map([[attachment.id, attachment]]),
            getLocalFilePresence: vi.fn(async () => 'present' as const),
            onUpload: vi.fn(),
            onUploadError: vi.fn(),
            onDownload: vi.fn(),
            onDownloadError: vi.fn(),
        });

        expect(didMutate).toBe(false);
        expect(patches.size).toBe(0);
    });

    it('routes transfer errors to the operation-specific error callbacks', async () => {
        const uploadAttachment = makeAttachment({ id: 'upload', uri: '/local/upload.txt' });
        const downloadAttachment = makeAttachment({ id: 'download', uri: '/local/missing.txt', cloudKey: 'attachments/download.txt' });
        const uploadError = new Error('upload failed');
        const downloadError = new Error('download failed');
        const onUploadError = vi.fn();
        const onDownloadError = vi.fn();

        const { didMutate, after } = await runLifecycle({
            attachmentsById: new Map([
                [uploadAttachment.id, uploadAttachment],
                [downloadAttachment.id, downloadAttachment],
            ]),
            getLocalFilePresence: vi.fn(async (path) => (
                path === '/local/upload.txt' ? 'present' as const : 'confirmed-not-found' as const
            )),
            onUpload: vi.fn(async () => { throw uploadError; }),
            onUploadError,
            onDownload: vi.fn(async () => { throw downloadError; }),
            onDownloadError,
        });

        expect(didMutate).toBe(true);
        expect(onUploadError).toHaveBeenCalledWith(after('upload'), uploadError);
        expect(onDownloadError).toHaveBeenCalledWith(after('download'), downloadError);
    });

    it('skips deleted and non-file attachments', async () => {
        const deleted = makeAttachment({ id: 'deleted', deletedAt: '2026-01-02T00:00:00.000Z' });
        const link = makeAttachment({ id: 'link', kind: 'link', uri: 'https://example.test' });
        const getLocalFilePresence = vi.fn(async () => 'present' as const);
        const { didMutate } = await runLifecycle({
            attachmentsById: new Map([[deleted.id, deleted], [link.id, link]]),
            getLocalFilePresence,
            onUpload: vi.fn(),
            onUploadError: vi.fn(),
            onDownload: vi.fn(),
            onDownloadError: vi.fn(),
        });

        expect(didMutate).toBe(false);
        expect(getLocalFilePresence).not.toHaveBeenCalled();
    });

    it('supports a custom hasCloudCopy predicate for backends whose cloudKey format differs', async () => {
        // Simulates CloudKit: a cloudKey written by a different backend before a provider switch
        // isn't a valid CloudKit record key, so CloudKit must still upload.
        const attachment = makeAttachment({ cloudKey: 'attachments/from-other-backend.txt' });
        const onUpload = vi.fn(async () => true);
        const { didMutate, after } = await runLifecycle({
            attachmentsById: new Map([[attachment.id, attachment]]),
            getLocalFilePresence: vi.fn(async () => 'present' as const),
            hasCloudCopy: (item) => item.cloudKey?.startsWith('cloudkit:') ?? false,
            onUpload,
            onUploadError: vi.fn(),
            onDownload: vi.fn(),
            onDownloadError: vi.fn(),
        });

        expect(didMutate).toBe(true);
        expect(onUpload).toHaveBeenCalledWith(after(), '/local/file.txt');
    });

    it('lets a policy cap uploads and downloads without touching the default (uncapped) callers', async () => {
        const uploadA = makeAttachment({ id: 'upload-a', uri: '/local/a.txt' });
        const uploadB = makeAttachment({ id: 'upload-b', uri: '/local/b.txt' });
        const onUpload = vi.fn(async () => true);
        const shouldUpload = vi.fn(() => false);

        const { didMutate, after } = await runLifecycle({
            attachmentsById: new Map([[uploadA.id, uploadA], [uploadB.id, uploadB]]),
            getLocalFilePresence: vi.fn(async () => 'present' as const),
            onUpload,
            onUploadError: vi.fn(),
            onDownload: vi.fn(),
            onDownloadError: vi.fn(),
            policy: { shouldUpload },
        });

        expect(onUpload).not.toHaveBeenCalled();
        expect(shouldUpload).toHaveBeenCalledTimes(2);
        // localStatus still refreshes even when the cap blocks the transfer itself.
        expect(didMutate).toBe(true);
        expect(after('upload-a').localStatus).toBe('available');
    });

    it('lets a policy skip an attachment entirely, including its local-status refresh', async () => {
        const attachment = makeAttachment({ localStatus: 'missing' });
        const getLocalFilePresence = vi.fn(async () => 'present' as const);
        const { didMutate, after } = await runLifecycle({
            attachmentsById: new Map([[attachment.id, attachment]]),
            getLocalFilePresence,
            onUpload: vi.fn(),
            onUploadError: vi.fn(),
            onDownload: vi.fn(),
            onDownloadError: vi.fn(),
            policy: { shouldSkip: () => true },
        });

        expect(didMutate).toBe(false);
        expect(getLocalFilePresence).not.toHaveBeenCalled();
        expect(after().localStatus).toBe('missing');
    });

    it('gates downloads through a policy backoff without affecting other attachments', async () => {
        const backedOff = makeAttachment({ id: 'backed-off', cloudKey: 'attachments/backed-off.txt' });
        const ready = makeAttachment({ id: 'ready', cloudKey: 'attachments/ready.txt' });
        const onDownload = vi.fn(async () => true);
        const shouldDownload = vi.fn((attachment: Attachment) => attachment.id !== 'backed-off');

        const { didMutate, after } = await runLifecycle({
            attachmentsById: new Map([[backedOff.id, backedOff], [ready.id, ready]]),
            getLocalFilePresence: vi.fn(async () => 'confirmed-not-found' as const),
            onUpload: vi.fn(),
            onUploadError: vi.fn(),
            onDownload,
            onDownloadError: vi.fn(),
            policy: { shouldDownload },
        });

        expect(didMutate).toBe(true);
        expect(onDownload).toHaveBeenCalledTimes(1);
        expect(onDownload).toHaveBeenCalledWith(after('ready'), { kind: 'absent' });
    });

    it('rethrows a fatal error immediately and discards the whole run, inputs included', async () => {
        // Mirrors an AbortSignal firing mid-run on a mobile backend. Under the patch contract
        // a rejected run publishes NOTHING: the earlier attachment's successful upload lives
        // only on a working copy inside the discarded patch map, and the caller's document is
        // byte-identical to what it passed in. (Before the purity refactor this test asserted
        // the opposite — that attachment #1 stayed mutated in place.)
        const first = makeAttachment({ id: 'first', uri: '/local/first.txt' });
        const second = makeAttachment({ id: 'second', uri: '/local/second.txt' });
        const abortError = new Error('aborted');
        abortError.name = 'AbortError';
        const onUpload = vi.fn(async (item: Attachment) => {
            if (item.id === 'second') throw abortError;
            item.cloudKey = 'attachments/first.txt';
            return true;
        });
        const onUploadError = vi.fn();

        await expect(runAttachmentTransferLifecycle({
            attachmentsById: new Map([[first.id, first], [second.id, second]]),
            getLocalFilePresence: vi.fn(async () => 'present' as const),
            onUpload,
            onUploadError,
            onDownload: vi.fn(),
            onDownloadError: vi.fn(),
            isFatalError: (error) => error instanceof Error && error.name === 'AbortError',
        })).rejects.toBe(abortError);

        expect(onUploadError).not.toHaveBeenCalled();
        expect(first.cloudKey).toBeUndefined();
        expect(first.localStatus).toBeUndefined();
    });

    describe('check-on-touch content change detection (#1057)', () => {
        it('prepare phase: a hash-confirmed local edit bumps contentRev and re-uploads', async () => {
            const attachment = makeAttachment({
                cloudKey: 'attachments/attachment-1.txt',
                fileHash: 'aaaa',
                contentRev: 2,
                contentMtimeMs: 1000,
                contentSize: 10,
            });
            const onUpload = vi.fn(async () => true);
            const { didMutate, after } = await runLifecycle({
                attachmentsById: new Map([[attachment.id, attachment]]),
                getLocalFilePresence: vi.fn(async () => 'present' as const),
                getLocalFileStat: vi.fn(async () => ({ mtimeMs: 2000, size: 20 })),
                computeLocalFileHash: vi.fn(async () => 'bbbb'),
                contentChangePhase: 'prepare',
                onUpload,
                onUploadError: vi.fn(),
                onDownload: vi.fn(),
                onDownloadError: vi.fn(),
            });

            expect(didMutate).toBe(true);
            expect(after().contentRev).toBe(3);
            expect(after().fileHash).toBe('bbbb');
            expect(after().contentMtimeMs).toBe(2000);
            expect(after().contentSize).toBe(20);
            expect(onUpload).toHaveBeenCalledWith(after(), '/local/file.txt');
            expect(attachment.contentRev).toBe(2);
            expect(attachment.fileHash).toBe('aaaa');
        });

        it('prepare phase defers a confirmed edit until after the remote merge', async () => {
            const attachment = makeAttachment({
                cloudKey: 'attachments/attachment-1.txt',
                fileHash: 'aaaa',
                contentRev: 2,
                contentMtimeMs: 1000,
                contentSize: 10,
            });
            const onUpload = vi.fn(async () => true);
            const { didMutate, after } = await runLifecycle({
                attachmentsById: new Map([[attachment.id, attachment]]),
                getLocalFilePresence: vi.fn(async () => 'present' as const),
                getLocalFileStat: vi.fn(async () => ({ mtimeMs: 2000, size: 20 })),
                computeLocalFileHash: vi.fn(async () => 'bbbb'),
                contentChangePhase: 'prepare',
                deferUploads: true,
                onUpload,
                onUploadError: vi.fn(),
                onDownload: vi.fn(),
                onDownloadError: vi.fn(),
            });

            expect(didMutate).toBe(true);
            expect(onUpload).not.toHaveBeenCalled();
            expect(after()).toMatchObject({
                contentRev: 3,
                fileHash: 'bbbb',
                contentMtimeMs: 2000,
                contentSize: 20,
                pendingContentUpload: true,
            });
        });

        it('post-merge uploads only a pending winning candidate and clears its marker', async () => {
            const expectedHash = 'b'.repeat(64);
            const attachment = makeAttachment({
                cloudKey: 'attachments/attachment-1.txt',
                fileHash: expectedHash,
                contentRev: 3,
                contentMtimeMs: 2000,
                contentSize: 20,
                pendingContentUpload: true,
            });
            const onUpload = vi.fn(async () => true);
            const { didMutate, after } = await runLifecycle({
                attachmentsById: new Map([[attachment.id, attachment]]),
                getLocalFilePresence: vi.fn(async () => 'present' as const),
                getLocalFileStat: vi.fn(async () => ({ mtimeMs: 2000, size: 20 })),
                computeLocalFileHash: vi.fn(async () => expectedHash),
                contentChangePhase: 'post-merge',
                onUpload,
                onUploadError: vi.fn(),
                onDownload: vi.fn(),
                onDownloadError: vi.fn(),
            });

            expect(didMutate).toBe(true);
            expect(onUpload).toHaveBeenCalledOnce();
            expect(after().pendingContentUpload).toBeUndefined();
        });

        it('post-merge does not upload a pending candidate whose local bytes changed after prepare', async () => {
            const expectedHash = 'a'.repeat(64);
            const attachment = makeAttachment({
                cloudKey: 'attachments/attachment-1.txt',
                fileHash: expectedHash,
                contentRev: 3,
                contentMtimeMs: 2000,
                contentSize: 20,
                localStatus: 'available',
                pendingContentUpload: true,
            });
            const onUpload = vi.fn(async () => true);
            const onDownload = vi.fn(async () => true);
            const onLocalEditRace = vi.fn();
            const { didMutate, after } = await runLifecycle({
                attachmentsById: new Map([[attachment.id, attachment]]),
                getLocalFilePresence: vi.fn(async () => 'present' as const),
                getLocalFileStat: vi.fn(async () => ({ mtimeMs: 3000, size: 30 })),
                computeLocalFileHash: vi.fn(async () => 'b'.repeat(64)),
                contentChangePhase: 'post-merge',
                onUpload,
                onUploadError: vi.fn(),
                onDownload,
                onDownloadError: vi.fn(),
                onLocalEditRace,
            });

            expect(didMutate).toBe(false);
            expect(onUpload).not.toHaveBeenCalled();
            expect(onDownload).not.toHaveBeenCalled();
            expect(onLocalEditRace).toHaveBeenCalledWith(after());
            expect(after().pendingContentUpload).toBe(true);
            expect(after().fileHash).toBe(expectedHash);
            expect(after().contentMtimeMs).toBe(2000);
        });

        it('recovers a missing pending candidate only after the remote bytes validate its identity', async () => {
            const expectedHash = 'a'.repeat(64);
            const attachment = makeAttachment({
                cloudKey: 'attachments/attachment-1.txt',
                fileHash: expectedHash,
                contentRev: 3,
                contentMtimeMs: 2000,
                contentSize: 20,
                localStatus: 'available',
                pendingContentUpload: true,
            });
            const onDownload = vi.fn(async (item: Attachment) => {
                item.uri = '/local/recovered.txt';
                item.localStatus = 'available';
                return true;
            });
            const { after } = await runLifecycle({
                attachmentsById: new Map([[attachment.id, attachment]]),
                getLocalFilePresence: vi.fn(async () => 'confirmed-not-found' as const),
                getLocalFileStat: vi.fn(async () => null),
                computeLocalFileHash: vi.fn(async () => null),
                contentChangePhase: 'post-merge',
                onUpload: vi.fn(),
                onUploadError: vi.fn(),
                onDownload,
                onDownloadError: vi.fn(),
            });

            expect(onDownload).toHaveBeenCalledOnce();
            expect(onDownload).toHaveBeenCalledWith(after(), { kind: 'absent' });
            expect(after()).toMatchObject({
                uri: '/local/recovered.txt',
                localStatus: 'available',
                fileHash: expectedHash,
                pendingContentUpload: undefined,
            });
        });

        it('preserves a missing pending candidate when its provider cannot bind remote recovery to a generation', async () => {
            const expectedHash = 'a'.repeat(64);
            const attachment = makeAttachment({
                cloudKey: 'attachments/attachment-1.txt',
                fileHash: expectedHash,
                contentRev: 3,
                localStatus: 'available',
                pendingContentUpload: true,
            });
            const onDownload = vi.fn(async () => true);
            const { didMutate, after } = await runLifecycle({
                attachmentsById: new Map([[attachment.id, attachment]]),
                getLocalFilePresence: vi.fn(async () => 'confirmed-not-found' as const),
                contentChangePhase: 'post-merge',
                allowPendingRemoteRecovery: false,
                onUpload: vi.fn(),
                onUploadError: vi.fn(),
                onDownload,
                onDownloadError: vi.fn(),
            });

            expect(didMutate).toBe(false);
            expect(onDownload).not.toHaveBeenCalled();
            expect(after()).toMatchObject({
                cloudKey: 'attachments/attachment-1.txt',
                fileHash: expectedHash,
                contentRev: 3,
                localStatus: 'available',
                pendingContentUpload: true,
            });
        });

        it('retains a missing pending candidate when remote recovery changes its identity', async () => {
            const expectedHash = 'a'.repeat(64);
            const attachment = makeAttachment({
                cloudKey: 'attachments/attachment-1.txt',
                fileHash: expectedHash,
                contentRev: 3,
                localStatus: 'missing',
                pendingContentUpload: true,
            });
            const onDownload = vi.fn(async (item: Attachment) => {
                item.cloudKey = undefined;
                item.fileHash = undefined;
                item.localStatus = 'available';
                return true;
            });
            const { didMutate, after } = await runLifecycle({
                attachmentsById: new Map([[attachment.id, attachment]]),
                getLocalFilePresence: vi.fn(async () => 'confirmed-not-found' as const),
                contentChangePhase: 'post-merge',
                onUpload: vi.fn(),
                onUploadError: vi.fn(),
                onDownload,
                onDownloadError: vi.fn(),
            });

            expect(didMutate).toBe(false);
            expect(onDownload).toHaveBeenCalledOnce();
            expect(after()).toMatchObject({
                cloudKey: 'attachments/attachment-1.txt',
                fileHash: expectedHash,
                localStatus: 'missing',
                pendingContentUpload: true,
            });
        });

        it('does not attempt missing pending recovery without a valid content hash', async () => {
            const attachment = makeAttachment({
                cloudKey: 'attachments/attachment-1.txt',
                fileHash: 'not-a-digest',
                localStatus: 'missing',
                pendingContentUpload: true,
            });
            const onDownload = vi.fn(async () => true);
            const { after } = await runLifecycle({
                attachmentsById: new Map([[attachment.id, attachment]]),
                getLocalFilePresence: vi.fn(async () => 'confirmed-not-found' as const),
                contentChangePhase: 'post-merge',
                onUpload: vi.fn(),
                onUploadError: vi.fn(),
                onDownload,
                onDownloadError: vi.fn(),
            });

            expect(onDownload).not.toHaveBeenCalled();
            expect(after().pendingContentUpload).toBe(true);
        });

        it('does not upload a locally available pending candidate without a valid content hash', async () => {
            const attachment = makeAttachment({
                cloudKey: undefined,
                fileHash: 'not-a-digest',
                localStatus: 'available',
                pendingContentUpload: true,
            });
            const onUpload = vi.fn(async () => true);
            const onLocalEditRace = vi.fn();
            const { after } = await runLifecycle({
                attachmentsById: new Map([[attachment.id, attachment]]),
                getLocalFilePresence: vi.fn(async () => 'present' as const),
                createUploadSnapshot: vi.fn(async () => ({
                    sourcePath: '/staged/attachment-1',
                    fileHash: 'a'.repeat(64),
                    stat: { mtimeMs: 1000, size: 3 },
                    dispose: vi.fn(async () => undefined),
                })),
                requireUploadSnapshot: true,
                contentChangePhase: 'post-merge',
                onUpload,
                onUploadError: vi.fn(),
                onDownload: vi.fn(),
                onDownloadError: vi.fn(),
                onLocalEditRace,
            });

            expect(onUpload).not.toHaveBeenCalled();
            expect(onLocalEditRace).toHaveBeenCalledOnce();
            expect(after()).toMatchObject({
                cloudKey: undefined,
                fileHash: 'not-a-digest',
                pendingContentUpload: true,
            });
        });

        it('defers a first upload with no cloud key until the merged pass', async () => {
            const attachment = makeAttachment({ localStatus: 'available' });
            const onUpload = vi.fn(async () => true);
            const { after } = await runLifecycle({
                attachmentsById: new Map([[attachment.id, attachment]]),
                getLocalFilePresence: vi.fn(async () => 'present' as const),
                contentChangePhase: 'prepare',
                deferUploads: true,
                onUpload,
                onUploadError: vi.fn(),
                onDownload: vi.fn(),
                onDownloadError: vi.fn(),
            });

            expect(onUpload).not.toHaveBeenCalled();
            expect(after().cloudKey).toBeUndefined();
        });

        it('binds a first upload and its published hash to one immutable snapshot', async () => {
            const attachment = makeAttachment({ localStatus: 'available' });
            const snapshotHash = 'a'.repeat(64);
            const dispose = vi.fn(async () => undefined);
            const computeLocalFileHash = vi.fn(async () => 'b'.repeat(64));
            const onUpload = vi.fn(async (
                item: Attachment,
                sourcePath: string,
                snapshot?: { bytes?: Uint8Array; fileHash: string },
            ) => {
                expect(sourcePath).toBe('/staged/attachment-1');
                expect(snapshot?.bytes).toEqual(new Uint8Array([1, 2, 3]));
                expect(snapshot?.fileHash).toBe(snapshotHash);
                item.cloudKey = 'attachments/attachment-1.txt';
                return true;
            });
            const { after } = await runLifecycle({
                attachmentsById: new Map([[attachment.id, attachment]]),
                getLocalFilePresence: vi.fn(async () => 'present' as const),
                getLocalFileStat: vi.fn(async () => ({ mtimeMs: 9000, size: 99 })),
                computeLocalFileHash,
                createUploadSnapshot: vi.fn(async () => ({
                    sourcePath: '/staged/attachment-1',
                    bytes: new Uint8Array([1, 2, 3]),
                    fileHash: snapshotHash,
                    stat: { mtimeMs: 1000, size: 3 },
                    dispose,
                })),
                requireUploadSnapshot: true,
                contentChangePhase: 'post-merge',
                onUpload,
                onUploadError: vi.fn(),
                onDownload: vi.fn(),
                onDownloadError: vi.fn(),
            });

            expect(onUpload).toHaveBeenCalledOnce();
            expect(after()).toMatchObject({
                cloudKey: 'attachments/attachment-1.txt',
                fileHash: snapshotHash,
                contentMtimeMs: 1000,
                contentSize: 3,
            });
            expect(computeLocalFileHash).not.toHaveBeenCalled();
            expect(dispose).toHaveBeenCalledOnce();
        });

        it('retains a pending candidate when its immutable snapshot has different bytes', async () => {
            const expectedHash = 'a'.repeat(64);
            const dispose = vi.fn(async () => undefined);
            const attachment = makeAttachment({
                cloudKey: 'attachments/attachment-1.txt',
                fileHash: expectedHash,
                contentRev: 3,
                contentMtimeMs: 1000,
                contentSize: 3,
                pendingContentUpload: true,
            });
            const onUpload = vi.fn(async () => true);
            const onLocalEditRace = vi.fn();
            const { after } = await runLifecycle({
                attachmentsById: new Map([[attachment.id, attachment]]),
                getLocalFilePresence: vi.fn(async () => 'present' as const),
                createUploadSnapshot: vi.fn(async () => ({
                    sourcePath: '/staged/attachment-1',
                    fileHash: 'b'.repeat(64),
                    stat: { mtimeMs: 1000, size: 3 },
                    dispose,
                })),
                requireUploadSnapshot: true,
                contentChangePhase: 'post-merge',
                onUpload,
                onUploadError: vi.fn(),
                onDownload: vi.fn(),
                onDownloadError: vi.fn(),
                onLocalEditRace,
            });

            expect(onUpload).not.toHaveBeenCalled();
            expect(onLocalEditRace).toHaveBeenCalledOnce();
            expect(after().pendingContentUpload).toBe(true);
            expect(after().fileHash).toBe(expectedHash);
            expect(dispose).toHaveBeenCalledOnce();
        });

        it('retains a pending candidate without a cloud key when its snapshot has newer bytes', async () => {
            const expectedHash = 'a'.repeat(64);
            const dispose = vi.fn(async () => undefined);
            const attachment = makeAttachment({
                cloudKey: undefined,
                fileHash: expectedHash,
                contentRev: 3,
                contentMtimeMs: 1000,
                contentSize: 3,
                pendingContentUpload: true,
            });
            const onUpload = vi.fn(async () => true);
            const onLocalEditRace = vi.fn();
            const { after } = await runLifecycle({
                attachmentsById: new Map([[attachment.id, attachment]]),
                getLocalFilePresence: vi.fn(async () => 'present' as const),
                createUploadSnapshot: vi.fn(async () => ({
                    sourcePath: '/staged/attachment-1',
                    fileHash: 'b'.repeat(64),
                    stat: { mtimeMs: 2000, size: 3 },
                    dispose,
                })),
                requireUploadSnapshot: true,
                contentChangePhase: 'post-merge',
                onUpload,
                onUploadError: vi.fn(),
                onDownload: vi.fn(),
                onDownloadError: vi.fn(),
                onLocalEditRace,
            });

            expect(onUpload).not.toHaveBeenCalled();
            expect(onLocalEditRace).toHaveBeenCalledOnce();
            expect(after()).toMatchObject({
                cloudKey: undefined,
                fileHash: expectedHash,
                contentRev: 3,
                pendingContentUpload: true,
            });
            expect(dispose).toHaveBeenCalledOnce();
        });

        it('creates a missing cloud object only from the exact pending snapshot', async () => {
            const expectedHash = 'a'.repeat(64);
            const dispose = vi.fn(async () => undefined);
            const attachment = makeAttachment({
                cloudKey: undefined,
                fileHash: expectedHash,
                contentRev: 3,
                contentMtimeMs: 1000,
                contentSize: 3,
                pendingContentUpload: true,
            });
            const onUpload = vi.fn(async (item: Attachment) => {
                item.cloudKey = 'attachments/attachment-1.txt';
                return true;
            });
            const { after } = await runLifecycle({
                attachmentsById: new Map([[attachment.id, attachment]]),
                getLocalFilePresence: vi.fn(async () => 'present' as const),
                createUploadSnapshot: vi.fn(async () => ({
                    sourcePath: '/staged/attachment-1',
                    fileHash: expectedHash,
                    stat: { mtimeMs: 1000, size: 3 },
                    dispose,
                })),
                requireUploadSnapshot: true,
                contentChangePhase: 'post-merge',
                onUpload,
                onUploadError: vi.fn(),
                onDownload: vi.fn(),
                onDownloadError: vi.fn(),
            });

            expect(onUpload).toHaveBeenCalledOnce();
            expect(after()).toMatchObject({
                cloudKey: 'attachments/attachment-1.txt',
                fileHash: expectedHash,
                contentRev: 3,
                pendingContentUpload: undefined,
            });
            expect(dispose).toHaveBeenCalledOnce();
        });

        it('fails closed when a production backend cannot create an upload snapshot', async () => {
            const attachment = makeAttachment({ localStatus: 'available' });
            const onUpload = vi.fn(async () => true);
            const { after } = await runLifecycle({
                attachmentsById: new Map([[attachment.id, attachment]]),
                getLocalFilePresence: vi.fn(async () => 'present' as const),
                createUploadSnapshot: vi.fn(async () => null),
                requireUploadSnapshot: true,
                onUpload,
                onUploadError: vi.fn(),
                onDownload: vi.fn(),
                onDownloadError: vi.fn(),
            });

            expect(onUpload).not.toHaveBeenCalled();
            expect(after().cloudKey).toBeUndefined();
        });

        it('disposes an immutable snapshot after an upload error', async () => {
            const attachment = makeAttachment({ localStatus: 'available' });
            const dispose = vi.fn(async () => undefined);
            const onUploadError = vi.fn();
            await runLifecycle({
                attachmentsById: new Map([[attachment.id, attachment]]),
                getLocalFilePresence: vi.fn(async () => 'present' as const),
                createUploadSnapshot: vi.fn(async () => ({
                    sourcePath: '/staged/attachment-1',
                    fileHash: 'a'.repeat(64),
                    stat: { mtimeMs: 1000, size: 3 },
                    dispose,
                })),
                requireUploadSnapshot: true,
                onUpload: vi.fn(async () => { throw new Error('network failed'); }),
                onUploadError,
                onDownload: vi.fn(),
                onDownloadError: vi.fn(),
            });

            expect(onUploadError).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
                message: 'network failed',
            }));
            expect(dispose).toHaveBeenCalledOnce();
        });

        describe('prepare phase: a failed/skipped upload must not publish metadata (review B2)', () => {
            const staleAttachment = () => makeAttachment({
                cloudKey: 'attachments/attachment-1.txt',
                fileHash: 'stale-hash',
                contentRev: 2,
                contentMtimeMs: 1000,
                contentSize: 10,
            });
            const baseOptions = {
                getLocalFilePresence: vi.fn(async () => 'present' as const),
                getLocalFileStat: vi.fn(async () => ({ mtimeMs: 2000, size: 20 })),
                computeLocalFileHash: vi.fn(async () => 'new-hash'),
                contentChangePhase: 'prepare' as const,
                onUploadError: vi.fn(),
                onDownload: vi.fn(),
                onDownloadError: vi.fn(),
            };

            it('onUpload returns false (validation/rate-limit failure)', async () => {
                const attachment = staleAttachment();
                const { after } = await runLifecycle({
                    ...baseOptions,
                    attachmentsById: new Map([[attachment.id, attachment]]),
                    onUpload: vi.fn(async () => false),
                });
                expect(after().contentRev).toBe(2);
                expect(after().fileHash).toBe('stale-hash');
                expect(after().contentMtimeMs).toBe(1000);
                expect(after().contentSize).toBe(10);
            });

            it('onUpload throws (network failure)', async () => {
                const attachment = staleAttachment();
                const { after } = await runLifecycle({
                    ...baseOptions,
                    attachmentsById: new Map([[attachment.id, attachment]]),
                    onUpload: vi.fn(async () => { throw new Error('network error'); }),
                });
                expect(after().contentRev).toBe(2);
                expect(after().fileHash).toBe('stale-hash');
            });

            it('policy.shouldUpload returns false (per-sync cap)', async () => {
                const attachment = staleAttachment();
                const onUpload = vi.fn(async () => true);
                const { after } = await runLifecycle({
                    ...baseOptions,
                    attachmentsById: new Map([[attachment.id, attachment]]),
                    onUpload,
                    policy: { shouldUpload: () => false },
                });
                expect(onUpload).not.toHaveBeenCalled();
                expect(after().contentRev).toBe(2);
                expect(after().fileHash).toBe('stale-hash');
            });

            it('a later cycle with a working upload still detects and retries the same change', async () => {
                // Proves the "leave it untouched" fix actually enables retry, not just
                // "nothing happens forever": the stat/hash are still recorded as stale, so
                // the exact same mismatch is detected again next cycle. The second cycle
                // reads the first cycle's patched value, as a real backend would after
                // applyAttachmentPatches folded it back into the document.
                const attachment = staleAttachment();
                const firstPass = await runLifecycle({
                    ...baseOptions,
                    attachmentsById: new Map([[attachment.id, attachment]]),
                    onUpload: vi.fn(async () => false),
                });
                const carried = firstPass.after();
                const onUpload = vi.fn(async () => true);
                const { after } = await runLifecycle({
                    ...baseOptions,
                    attachmentsById: new Map([[carried.id, carried]]),
                    onUpload,
                });
                expect(onUpload).toHaveBeenCalledTimes(1);
                expect(after().contentRev).toBe(3);
                expect(after().fileHash).toBe('new-hash');
            });
        });

        it('prepare phase: an unconfirmable hash does not bump, upload, or publish a stale fileHash (review S2)', async () => {
            const attachment = makeAttachment({
                cloudKey: 'attachments/attachment-1.txt',
                fileHash: 'old-hash',
                contentRev: 2,
                contentMtimeMs: 1000,
                contentSize: 10,
                localStatus: 'available',
            });
            const onUpload = vi.fn(async () => true);
            const { didMutate, after } = await runLifecycle({
                attachmentsById: new Map([[attachment.id, attachment]]),
                getLocalFilePresence: vi.fn(async () => 'present' as const),
                getLocalFileStat: vi.fn(async () => ({ mtimeMs: 2000, size: 20 })),
                computeLocalFileHash: vi.fn(async () => null),
                contentChangePhase: 'prepare',
                onUpload,
                onUploadError: vi.fn(),
                onDownload: vi.fn(),
                onDownloadError: vi.fn(),
            });

            expect(didMutate).toBe(false);
            expect(onUpload).not.toHaveBeenCalled();
            expect(after().contentRev).toBe(2);
            expect(after().fileHash).toBe('old-hash');
            expect(after().contentMtimeMs).toBe(1000);
        });

        it('post-merge phase: a local edit landing mid-cycle is never overwritten (review S3)', async () => {
            const attachment = makeAttachment({
                cloudKey: 'attachments/attachment-1.txt',
                fileHash: 'winner-hash',
                contentRev: 5,
                contentMtimeMs: 9000,
                contentSize: 90,
                localStatus: 'available',
            });
            const onDownload = vi.fn(async () => true);
            const onLocalEditRace = vi.fn();
            // First stat call (the detection pass) reports the state that triggers the
            // mismatch; the second (the re-stat immediately before overwrite, S3) reports
            // that the file changed AGAIN in between — simulating the user's editor saving
            // mid-cycle.
            const getLocalFileStat = vi.fn()
                .mockResolvedValueOnce({ mtimeMs: 1234, size: 12 })
                .mockResolvedValueOnce({ mtimeMs: 5678, size: 34 });
            const { didMutate, after } = await runLifecycle({
                attachmentsById: new Map([[attachment.id, attachment]]),
                getLocalFilePresence: vi.fn(async () => 'present' as const),
                getLocalFileStat,
                computeLocalFileHash: vi.fn(async () => 'loser-hash'),
                contentChangePhase: 'post-merge',
                onUpload: vi.fn(),
                onUploadError: vi.fn(),
                onDownload,
                onDownloadError: vi.fn(),
                onLocalEditRace,
            });

            expect(onDownload).not.toHaveBeenCalled();
            expect(onLocalEditRace).toHaveBeenCalledWith(after());
            expect(didMutate).toBe(false);
            // The record is untouched — the next cycle's prepare pass picks this up as an
            // ordinary local edit.
            expect(after().fileHash).toBe('winner-hash');
            expect(after().contentMtimeMs).toBe(9000);
        });

        it('post-merge phase: a download skipped by the local-edit race never consults the download budget', async () => {
            const attachment = makeAttachment({
                cloudKey: 'attachments/attachment-1.txt',
                fileHash: 'winner-hash',
                contentRev: 5,
                contentMtimeMs: 9000,
                contentSize: 90,
                localStatus: 'available',
            });
            const onDownload = vi.fn(async () => true);
            const shouldDownload = vi.fn(() => true);
            // Same race setup as the S3 test above: the re-stat immediately before
            // overwrite reports a fresh mismatch, so the download is skipped.
            const getLocalFileStat = vi.fn()
                .mockResolvedValueOnce({ mtimeMs: 1234, size: 12 })
                .mockResolvedValueOnce({ mtimeMs: 5678, size: 34 });
            const { didMutate } = await runLifecycle({
                attachmentsById: new Map([[attachment.id, attachment]]),
                getLocalFilePresence: vi.fn(async () => 'present' as const),
                getLocalFileStat,
                computeLocalFileHash: vi.fn(async () => 'loser-hash'),
                contentChangePhase: 'post-merge',
                onUpload: vi.fn(),
                onUploadError: vi.fn(),
                onDownload,
                onDownloadError: vi.fn(),
                onLocalEditRace: vi.fn(),
                policy: { shouldDownload },
            });

            expect(onDownload).not.toHaveBeenCalled();
            expect(shouldDownload).not.toHaveBeenCalled();
            expect(didMutate).toBe(false);
        });

        it('prepare phase: a cosmetic mtime touch with the same hash refreshes stat but does not bump or re-upload', async () => {
            const attachment = makeAttachment({
                cloudKey: 'attachments/attachment-1.txt',
                fileHash: 'aaaa',
                contentRev: 2,
                contentMtimeMs: 1000,
                contentSize: 10,
            });
            const onUpload = vi.fn(async () => true);
            const { didMutate, after } = await runLifecycle({
                attachmentsById: new Map([[attachment.id, attachment]]),
                getLocalFilePresence: vi.fn(async () => 'present' as const),
                getLocalFileStat: vi.fn(async () => ({ mtimeMs: 5000, size: 10 })),
                computeLocalFileHash: vi.fn(async () => 'aaaa'),
                contentChangePhase: 'prepare',
                onUpload,
                onUploadError: vi.fn(),
                onDownload: vi.fn(),
                onDownloadError: vi.fn(),
            });

            expect(didMutate).toBe(true);
            expect(after().contentRev).toBe(2);
            expect(after().contentMtimeMs).toBe(5000);
            expect(after().contentSize).toBe(10);
            expect(onUpload).not.toHaveBeenCalled();
        });

        it('leaves an unchanged file (matching stat) completely alone — no hash call, no mutation', async () => {
            const attachment = makeAttachment({
                cloudKey: 'attachments/attachment-1.txt',
                fileHash: 'aaaa',
                contentMtimeMs: 1000,
                contentSize: 10,
                localStatus: 'available',
            });
            const computeLocalFileHash = vi.fn(async () => 'aaaa');
            const { didMutate } = await runLifecycle({
                attachmentsById: new Map([[attachment.id, attachment]]),
                getLocalFilePresence: vi.fn(async () => 'present' as const),
                getLocalFileStat: vi.fn(async () => ({ mtimeMs: 1000, size: 10 })),
                computeLocalFileHash,
                contentChangePhase: 'prepare',
                onUpload: vi.fn(),
                onUploadError: vi.fn(),
                onDownload: vi.fn(),
                onDownloadError: vi.fn(),
            });

            expect(didMutate).toBe(false);
            expect(computeLocalFileHash).not.toHaveBeenCalled();
        });

        it('post-merge phase: a hash mismatch (another device won the merge) re-downloads instead of re-uploading', async () => {
            // Simulates the losing side of a concurrent edit: the merge already adopted
            // the other device's fileHash/contentRev into this attachment object, but the
            // file still on this device's disk is the old, losing content.
            const attachment = makeAttachment({
                cloudKey: 'attachments/attachment-1.txt',
                fileHash: 'winner-hash',
                contentRev: 5,
                contentMtimeMs: 9000,
                contentSize: 90,
                localStatus: 'available',
            });
            const onUpload = vi.fn(async () => true);
            const onDownload = vi.fn(async (item: Attachment) => {
                item.uri = '/local/downloaded.txt';
                return true;
            });
            const { didMutate, after } = await runLifecycle({
                attachmentsById: new Map([[attachment.id, attachment]]),
                getLocalFilePresence: vi.fn(async () => 'present' as const),
                getLocalFileStat: vi.fn(async () => ({ mtimeMs: 1234, size: 12 })),
                computeLocalFileHash: vi.fn(async () => 'loser-hash'),
                contentChangePhase: 'post-merge',
                onUpload,
                onUploadError: vi.fn(),
                onDownload,
                onDownloadError: vi.fn(),
            });

            expect(didMutate).toBe(true);
            expect(onUpload).not.toHaveBeenCalled();
            expect(onDownload).toHaveBeenCalledWith(after(), {
                kind: 'present',
                sha256: 'loser-hash',
            });
            // contentRev/fileHash are untouched by the download branch itself — they
            // already carry the winning side's values from the merge.
            expect(after().contentRev).toBe(5);
            expect(after().fileHash).toBe('winner-hash');
        });

        it('loop safety: a downloaded file is immediately stat-recorded so a second, unchanged pass is a byte-for-byte no-op', async () => {
            const attachment = makeAttachment({ cloudKey: 'attachments/attachment-1.txt' });
            const onDownload = vi.fn(async (item: Attachment) => {
                item.uri = '/local/downloaded.txt';
                item.fileHash = 'downloaded-hash';
                item.localStatus = 'available';
                return true;
            });
            // Round 1: not on disk yet — the existing "missing -> download" path fires.
            let existsLocally = false;
            const getLocalFilePresence = vi.fn(async () => (
                existsLocally ? 'present' as const : 'confirmed-not-found' as const
            ));
            // The freshly-written file's real stat, as the caller's getLocalFileStat would report it.
            const getLocalFileStat = vi.fn(async () => ({ mtimeMs: 42_000, size: 42 }));

            const firstPass = await runLifecycle({
                attachmentsById: new Map([[attachment.id, attachment]]),
                getLocalFilePresence,
                getLocalFileStat,
                computeLocalFileHash: vi.fn(async () => 'downloaded-hash'),
                contentChangePhase: 'post-merge',
                onUpload: vi.fn(),
                onUploadError: vi.fn(),
                onDownload,
                onDownloadError: vi.fn(),
            });
            expect(firstPass.didMutate).toBe(true);
            expect(onDownload).toHaveBeenCalledTimes(1);
            // The invariant under test: contentMtimeMs/contentSize already match the
            // fresh file immediately after download, without waiting for a second cycle.
            const downloaded = firstPass.after();
            expect(downloaded.contentMtimeMs).toBe(42_000);
            expect(downloaded.contentSize).toBe(42);

            // Round 2: the file is now on disk and its stat is unchanged.
            existsLocally = true;
            const secondPass = await runLifecycle({
                attachmentsById: new Map([[downloaded.id, downloaded]]),
                getLocalFilePresence,
                getLocalFileStat,
                computeLocalFileHash: vi.fn(async () => 'downloaded-hash'),
                contentChangePhase: 'post-merge',
                onUpload: vi.fn(),
                onUploadError: vi.fn(),
                onDownload,
                onDownloadError: vi.fn(),
            });

            // Byte-for-byte no-op: no second download, no further mutation.
            expect(onDownload).toHaveBeenCalledTimes(1);
            expect(secondPass.didMutate).toBe(false);
        });

        it('does not record a post-install local edit as the downloaded generation baseline', async () => {
            const remoteHash = 'a'.repeat(64);
            const localEditHash = 'b'.repeat(64);
            const attachment = makeAttachment({
                cloudKey: 'attachments/attachment-1.txt',
                fileHash: remoteHash,
                localStatus: 'missing',
            });
            const onLocalEditRace = vi.fn();
            const getLocalFileStat = vi.fn(async () => ({ mtimeMs: 42_000, size: 42 }));
            const { after } = await runLifecycle({
                attachmentsById: new Map([[attachment.id, attachment]]),
                getLocalFilePresence: vi.fn(async () => 'confirmed-not-found' as const),
                getLocalFileStat,
                computeLocalFileHash: vi.fn(async () => localEditHash),
                contentChangePhase: 'post-merge',
                onUpload: vi.fn(),
                onUploadError: vi.fn(),
                onDownload: vi.fn(async (item: Attachment) => {
                    item.uri = '/local/downloaded.txt';
                    item.localStatus = 'available';
                    item.fileHash = remoteHash;
                    return true;
                }),
                onDownloadError: vi.fn(),
                onLocalEditRace,
            });

            expect(onLocalEditRace).toHaveBeenCalledWith(after());
            expect(after().contentMtimeMs).toBeUndefined();
            expect(after().contentSize).toBeUndefined();
            expect(after().fileHash).toBe(remoteHash);
        });
    });

    it('lets platform adapters resolve local URI paths', async () => {
        const attachment = makeAttachment({ uri: 'file:///tmp/upload.txt' });
        const getLocalFilePresence = vi.fn(async () => 'present' as const);
        await runLifecycle({
            attachmentsById: new Map([[attachment.id, attachment]]),
            getLocalFilePresence,
            resolveLocalPath: (uri) => uri.replace('file://', ''),
            onUpload: vi.fn(async () => false),
            onUploadError: vi.fn(),
            onDownload: vi.fn(),
            onDownloadError: vi.fn(),
        });

        expect(getLocalFilePresence).toHaveBeenCalledWith(
            '/tmp/upload.txt',
            expect.objectContaining({ id: 'attachment-1' }),
        );
    });
});

/**
 * The teeth of the purity contract: a deep-frozen input graph makes any in-place write
 * throw (module code is strict mode), so every one of these passing is proof the lifecycle
 * wrote only to its own working copies.
 */
describe('runAttachmentTransferLifecycle purity (frozen inputs)', () => {
    beforeEach(() => {
        resetUnhashableAttachmentStatsForTests();
    });

    const frozenRun = (attachments: Attachment[], options: Partial<AttachmentTransferLifecycleOptions>) => {
        const data = deepFreeze(makeData({
            tasks: [makeTask({ attachments: attachments.slice(0, 1) })],
            projects: [makeProject({ attachments: attachments.slice(1) })],
        }));
        return runAttachmentTransferLifecycle({
            attachmentsById: collectAttachmentsById(data),
            getLocalFilePresence: vi.fn(async () => 'present' as const),
            onUpload: vi.fn(async () => true),
            onUploadError: vi.fn(),
            onDownload: vi.fn(async () => true),
            onDownloadError: vi.fn(),
            ...options,
        });
    };

    it('upload path never writes through to the frozen attachment', async () => {
        const attachment = makeAttachment({ localStatus: 'missing' });
        const { changed, patches } = await frozenRun([attachment], {
            onUpload: async (item) => {
                item.cloudKey = 'attachments/attachment-1.txt';
                return true;
            },
        });
        expect(changed).toBe(true);
        expect(patches.get('attachment-1')?.cloudKey).toBe('attachments/attachment-1.txt');
        expect(attachment.cloudKey).toBeUndefined();
    });

    it('download path never writes through to the frozen attachment', async () => {
        const attachment = makeAttachment({ cloudKey: 'attachments/attachment-1.txt' });
        const { patches } = await frozenRun([attachment], {
            getLocalFilePresence: vi.fn(async () => 'confirmed-not-found' as const),
            onDownload: async (item) => {
                item.uri = '/local/downloaded.txt';
                item.localStatus = 'available';
                return true;
            },
        });
        expect(patches.get('attachment-1')?.uri).toBe('/local/downloaded.txt');
        expect(attachment.uri).toBe('/local/file.txt');
    });

    it('prepare-phase content re-upload never writes stat/hash/contentRev through', async () => {
        const attachment = makeAttachment({
            cloudKey: 'attachments/attachment-1.txt',
            fileHash: 'aaaa',
            contentRev: 2,
            contentMtimeMs: 1000,
            contentSize: 10,
            localStatus: 'available',
        });
        const { patches } = await frozenRun([attachment], {
            getLocalFileStat: vi.fn(async () => ({ mtimeMs: 2000, size: 20 })),
            computeLocalFileHash: vi.fn(async () => 'bbbb'),
            contentChangePhase: 'prepare',
        });
        expect(patches.get('attachment-1')?.contentRev).toBe(3);
        expect(attachment.contentRev).toBe(2);
        expect(attachment.fileHash).toBe('aaaa');
        expect(attachment.contentMtimeMs).toBe(1000);
    });

    it('post-merge content re-download never writes stat through', async () => {
        const attachment = makeAttachment({
            cloudKey: 'attachments/attachment-1.txt',
            fileHash: 'winner-hash',
            contentMtimeMs: 9000,
            contentSize: 90,
            localStatus: 'available',
        });
        const { patches } = await frozenRun([attachment], {
            getLocalFileStat: vi.fn(async () => ({ mtimeMs: 1234, size: 12 })),
            computeLocalFileHash: vi.fn(async () => 'loser-hash'),
            contentChangePhase: 'post-merge',
            onDownload: async (item) => {
                item.uri = '/local/downloaded.txt';
                return true;
            },
        });
        expect(patches.get('attachment-1')?.uri).toBe('/local/downloaded.txt');
        expect(attachment.uri).toBe('/local/file.txt');
        expect(attachment.contentMtimeMs).toBe(9000);
    });

    it('post-merge fileHash backfill never writes through (BUG-16)', async () => {
        const attachment = makeAttachment({ cloudKey: 'attachments/attachment-1.txt' });
        const { patches } = await frozenRun([attachment], {
            getLocalFileStat: vi.fn(async () => ({ mtimeMs: 2000, size: 20 })),
            computeLocalFileHash: vi.fn(async () => 'backfilled-hash'),
            contentChangePhase: 'post-merge',
        });
        expect(patches.get('attachment-1')?.fileHash).toBe('backfilled-hash');
        expect(attachment.fileHash).toBeUndefined();
    });

    it('error callbacks receive the working copy, leaving the frozen input alone', async () => {
        const attachment = makeAttachment({ localStatus: 'missing' });
        const onUploadError = vi.fn();
        const { patches } = await frozenRun([attachment], {
            onUpload: async () => { throw new Error('upload failed'); },
            onUploadError,
        });
        expect(onUploadError).toHaveBeenCalledWith(patches.get('attachment-1'), expect.any(Error));
        expect(attachment.localStatus).toBe('missing');
    });

    it('folding the resulting patches back is what actually changes the document', async () => {
        const attachment = makeAttachment({ localStatus: 'missing' });
        const data = deepFreeze(makeData({ tasks: [makeTask({ attachments: [attachment] })] }));
        const { patches } = await runAttachmentTransferLifecycle({
            attachmentsById: collectAttachmentsById(data),
            getLocalFilePresence: vi.fn(async () => 'present' as const),
            onUpload: async (item) => {
                item.cloudKey = 'attachments/attachment-1.txt';
                return true;
            },
            onUploadError: vi.fn(),
            onDownload: vi.fn(async () => false),
            onDownloadError: vi.fn(),
        });

        const next = applyAttachmentPatches(data, patches);
        expect(next).not.toBe(data);
        expect(next.tasks[0].attachments?.[0].cloudKey).toBe('attachments/attachment-1.txt');
        expect(data.tasks[0].attachments?.[0].cloudKey).toBeUndefined();
    });
});

describe('collectAttachmentsById', () => {
    it('collects live task and project attachments and skips deleted owners', () => {
        const taskAttachment = makeAttachment({ id: 'task-attachment' });
        const projectAttachment = makeAttachment({ id: 'project-attachment' });
        const deletedOwnerAttachment = makeAttachment({ id: 'deleted-owner-attachment' });
        const data = makeData({
            tasks: [
                makeTask({ id: 'task-live', attachments: [taskAttachment] }),
                makeTask({ id: 'task-deleted', deletedAt: '2026-01-02T00:00:00.000Z', attachments: [deletedOwnerAttachment] }),
            ],
            projects: [makeProject({ id: 'project-live', attachments: [projectAttachment] })],
        });

        expect([...collectAttachmentsById(data).keys()]).toEqual(['task-attachment', 'project-attachment']);
    });
});

describe('applyAttachmentPatches', () => {
    const patchedCopy = (attachment: Attachment): Attachment => ({ ...attachment, cloudKey: 'attachments/new.txt' });

    it('returns the input document unchanged when there is nothing to apply', () => {
        const data = makeData({ tasks: [makeTask({ attachments: [makeAttachment({})] })] });
        expect(applyAttachmentPatches(data, new Map())).toBe(data);
    });

    it('returns the input document unchanged when no owner holds a patched attachment', () => {
        const data = makeData({ tasks: [makeTask({ attachments: [makeAttachment({})] })] });
        const orphan = makeAttachment({ id: 'not-in-document' });
        expect(applyAttachmentPatches(data, new Map([[orphan.id, orphan]]))).toBe(data);
    });

    it('reallocates only the owners holding a patched attachment', () => {
        const patchedAttachment = makeAttachment({ id: 'patched' });
        const siblingAttachment = makeAttachment({ id: 'sibling' });
        const untouchedTask = makeTask({ id: 'task-untouched', attachments: [makeAttachment({ id: 'other' })] });
        const patchedTask = makeTask({ id: 'task-patched', attachments: [patchedAttachment, siblingAttachment] });
        const untouchedProject = makeProject({ id: 'project-untouched' });
        const data = makeData({ tasks: [untouchedTask, patchedTask], projects: [untouchedProject] });

        const patch = patchedCopy(patchedAttachment);
        const next = applyAttachmentPatches(data, new Map([[patch.id, patch]]));

        expect(next).not.toBe(data);
        expect(next.tasks[0]).toBe(untouchedTask);
        expect(next.tasks[1]).not.toBe(patchedTask);
        expect(next.tasks[1].attachments?.[0]).toBe(patch);
        // Siblings inside the reallocated owner keep their identity.
        expect(next.tasks[1].attachments?.[1]).toBe(siblingAttachment);
        // The projects array had nothing to patch, so it is the same array object.
        expect(next.projects).toBe(data.projects);
        // Inputs untouched.
        expect(patchedTask.attachments?.[0]).toBe(patchedAttachment);
        expect(patchedAttachment.cloudKey).toBeUndefined();
    });

    it('patches project owners too', () => {
        const attachment = makeAttachment({ id: 'project-attachment' });
        const project = makeProject({ attachments: [attachment] });
        const data = makeData({ projects: [project] });

        const patch = patchedCopy(attachment);
        const next = applyAttachmentPatches(data, new Map([[patch.id, patch]]));

        expect(next.projects[0]).not.toBe(project);
        expect(next.projects[0].attachments?.[0]).toBe(patch);
        expect(next.tasks).toBe(data.tasks);
    });

    it('skips deleted owners even when they hold a patched attachment id', () => {
        const attachment = makeAttachment({ id: 'shared-id' });
        const deletedTask = makeTask({ id: 'task-deleted', deletedAt: '2026-01-02T00:00:00.000Z', attachments: [attachment] });
        const data = makeData({ tasks: [deletedTask] });

        const patch = patchedCopy(attachment);
        const next = applyAttachmentPatches(data, new Map([[patch.id, patch]]));

        expect(next).toBe(data);
        expect(next.tasks[0]).toBe(deletedTask);
    });

    it('never touches rev or updatedAt', () => {
        const attachment = makeAttachment({});
        const task = makeTask({ attachments: [attachment], rev: 7, updatedAt: '2026-01-01T00:00:00.000Z' });
        const data = makeData({ tasks: [task] });

        const patch = patchedCopy(attachment);
        const next = applyAttachmentPatches(data, new Map([[patch.id, patch]]));

        expect(next.tasks[0].rev).toBe(7);
        expect(next.tasks[0].updatedAt).toBe('2026-01-01T00:00:00.000Z');
    });
});

describe('withAttachmentSettingsPatch', () => {
    it('returns the input document unchanged for an undefined patch', () => {
        const data = makeData({ settings: { attachments: { pendingRemoteDeletes: [] } } });
        expect(withAttachmentSettingsPatch(data, undefined)).toBe(data);
    });

    it('swaps in the next attachment settings without touching the input', () => {
        const data = makeData({
            settings: {
                theme: 'dark',
                attachments: { pendingRemoteDeletes: [{ cloudKey: 'attachments/a.txt', attempts: 1 }] },
            } as AppData['settings'],
        });
        const nextSettings: AttachmentSettings = { pendingRemoteDeletes: [] };

        const next = withAttachmentSettingsPatch(data, nextSettings);

        expect(next).not.toBe(data);
        expect(next.settings.attachments).toBe(nextSettings);
        expect((next.settings as { theme?: string }).theme).toBe('dark');
        expect(data.settings.attachments?.pendingRemoteDeletes).toHaveLength(1);
    });
});

describe('upload source containment (SEC-07)', () => {
    const hostile = () => makeAttachment({ uri: '/etc/passwd', localStatus: 'missing' });
    const baseOptions = {
        getLocalFilePresence: vi.fn(async () => 'present' as const),
        canUploadFrom: (localPath: string) => localPath.startsWith('/managed/'),
        onUploadError: vi.fn(),
        onDownload: vi.fn(async () => true),
        onDownloadError: vi.fn(),
    };

    it('never reads or uploads a local path the platform disallows', async () => {
        const attachment = hostile();
        const onUpload = vi.fn(async () => true);
        const computeLocalFileHash = vi.fn(async () => 'hash');

        const { after } = await runLifecycle({
            ...baseOptions,
            attachmentsById: new Map([[attachment.id, attachment]]),
            getLocalFileStat: vi.fn(async () => ({ mtimeMs: 2000, size: 20 })),
            computeLocalFileHash,
            contentChangePhase: 'prepare',
            onUpload,
        });

        expect(onUpload).not.toHaveBeenCalled();
        expect(computeLocalFileHash).not.toHaveBeenCalled();
        expect(after().cloudKey).toBeUndefined();
        // localStatus is still reconciled — the file is there, it is just not ours to send.
        expect(after().localStatus).toBe('available');
    });

    it('does not re-upload a disallowed path that already has a cloud copy', async () => {
        const attachment = makeAttachment({
            uri: '/etc/passwd',
            cloudKey: 'attachments/attachment-1.txt',
            fileHash: 'old-hash',
            contentMtimeMs: 1000,
            contentSize: 10,
        });
        const onUpload = vi.fn(async () => true);

        const { after } = await runLifecycle({
            ...baseOptions,
            attachmentsById: new Map([[attachment.id, attachment]]),
            getLocalFileStat: vi.fn(async () => ({ mtimeMs: 2000, size: 20 })),
            computeLocalFileHash: vi.fn(async () => 'new-hash'),
            contentChangePhase: 'prepare',
            onUpload,
        });

        expect(onUpload).not.toHaveBeenCalled();
        expect(after().fileHash).toBe('old-hash');
    });

    it('still downloads a cloud copy whose local file is missing', async () => {
        const attachment = makeAttachment({ uri: '/etc/passwd', cloudKey: 'attachments/attachment-1.txt' });
        const onDownload = vi.fn(async () => true);

        await runLifecycle({
            ...baseOptions,
            attachmentsById: new Map([[attachment.id, attachment]]),
            getLocalFilePresence: vi.fn(async () => 'confirmed-not-found' as const),
            onUpload: vi.fn(async () => true),
            onDownload,
        });

        expect(onDownload).toHaveBeenCalledTimes(1);
    });

    it('uploads normally when no containment predicate is supplied', async () => {
        const attachment = makeAttachment({ uri: '/etc/passwd' });
        const onUpload = vi.fn(async () => true);

        await runLifecycle({
            ...baseOptions,
            canUploadFrom: undefined,
            attachmentsById: new Map([[attachment.id, attachment]]),
            onUpload,
        });

        expect(onUpload).toHaveBeenCalledTimes(1);
    });
});

describe('missing fileHash and unhashable files (BUG-16)', () => {
    beforeEach(() => {
        resetUnhashableAttachmentStatsForTests();
    });

    const baseOptions = {
        getLocalFilePresence: vi.fn(async () => 'present' as const),
        onUploadError: vi.fn(),
        onDownloadError: vi.fn(),
    };

    it('backfills a missing fileHash instead of guessing a transfer', async () => {
        // An attachment uploaded by a client that predates fileHash: it has a cloud copy
        // and a local file, but no baseline hash, so a bare stat mismatch is not evidence
        // of anything and must not trigger a download.
        const attachment = makeAttachment({ cloudKey: 'attachments/attachment-1.txt' });
        const onDownload = vi.fn(async () => true);
        const onUpload = vi.fn(async () => true);

        const { didMutate, after } = await runLifecycle({
            ...baseOptions,
            attachmentsById: new Map([[attachment.id, attachment]]),
            getLocalFileStat: vi.fn(async () => ({ mtimeMs: 2000, size: 20 })),
            computeLocalFileHash: vi.fn(async () => 'backfilled-hash'),
            contentChangePhase: 'post-merge',
            onUpload,
            onDownload,
        });

        expect(didMutate).toBe(true);
        expect(onDownload).not.toHaveBeenCalled();
        expect(onUpload).not.toHaveBeenCalled();
        expect(after().fileHash).toBe('backfilled-hash');
        expect(after().contentMtimeMs).toBe(2000);
        expect(after().contentSize).toBe(20);
        expect(after().contentRev).toBeUndefined();
    });

    it('re-reads a file it could not hash only once per observed stat', async () => {
        // Each cycle carries the previous cycle's patched attachment forward, exactly as a
        // backend does once applyAttachmentPatches has folded it into the document.
        let current = makeAttachment({
            cloudKey: 'attachments/attachment-1.txt',
            fileHash: 'old-hash',
            contentMtimeMs: 1000,
            contentSize: 10,
        });
        const computeLocalFileHash = vi.fn(async () => null);
        let stat = { mtimeMs: 2000, size: 20 };
        const runCycle = async () => {
            const { after } = await runLifecycle({
                ...baseOptions,
                attachmentsById: new Map([[current.id, current]]),
                getLocalFileStat: vi.fn(async () => stat),
                computeLocalFileHash,
                contentChangePhase: 'prepare',
                onUpload: vi.fn(async () => true),
                onDownload: vi.fn(async () => true),
            });
            current = after(current.id);
        };

        await runCycle();
        expect(computeLocalFileHash).toHaveBeenCalledTimes(1);

        await runCycle();
        expect(computeLocalFileHash).toHaveBeenCalledTimes(1);

        stat = { mtimeMs: 3000, size: 30 };
        await runCycle();
        expect(computeLocalFileHash).toHaveBeenCalledTimes(2);
        expect(current.fileHash).toBe('old-hash');
        expect(current.contentMtimeMs).toBe(1000);
    });
});

describe('validateAttachmentHash', () => {
    // sha256("abc")
    const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    const abcBytes = new Uint8Array([0x61, 0x62, 0x63]);

    afterEach(() => {
        setSha256HexProvider(null);
    });

    it('passes when the computed digest matches the recorded fileHash', async () => {
        await expect(validateAttachmentHash(
            makeAttachment({ fileHash: ABC_SHA256.toUpperCase() }),
            abcBytes,
        )).resolves.toBeUndefined();
    });

    it('rejects when the bytes do not match the recorded fileHash', async () => {
        await expect(validateAttachmentHash(
            makeAttachment({ fileHash: ABC_SHA256 }),
            new Uint8Array([0x61, 0x62, 0x64]),
        )).rejects.toThrow(/Integrity validation failed/);
    });

    it('fails closed when no digest can be computed at all', async () => {
        setSha256HexProvider(() => 'no-digest-available');
        await expect(validateAttachmentHash(
            makeAttachment({ fileHash: ABC_SHA256 }),
            abcBytes,
        )).rejects.toThrow(/Integrity validation/);
    });

    it('skips validation when the attachment carries no fileHash', async () => {
        setSha256HexProvider(() => 'no-digest-available');
        await expect(validateAttachmentHash(makeAttachment({}), abcBytes)).resolves.toBeUndefined();
    });

    it('skips validation when the recorded fileHash is not a syntactically valid digest', async () => {
        await expect(validateAttachmentHash(
            makeAttachment({ fileHash: ABC_SHA256.slice(0, 32) }),
            abcBytes,
        )).resolves.toBeUndefined();
    });
});

describe('normalizePendingRemoteDeletes', () => {
    it('dedupes by cloud key and keeps the highest attempt count', () => {
        expect(normalizePendingRemoteDeletes([
            { cloudKey: ' attachments/a.txt ', attempts: 1, title: 'old' },
            { cloudKey: 'attachments/a.txt', attempts: 3, title: 'new' },
            { cloudKey: '', attempts: 9 },
        ])).toEqual([
            { cloudKey: 'attachments/a.txt', attempts: 3, title: 'new', lastErrorAt: undefined },
        ]);
    });
});
