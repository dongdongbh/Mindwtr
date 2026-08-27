import {
    computeSha256Hex,
    runAttachmentTransferLifecycle,
    type Attachment,
    type AttachmentTransferLifecycleOptions,
    type AttachmentTransferResult,
    type AttachmentUploadSnapshot,
    type LocalFileStat,
} from '@mindwtr/core';
import {
    createCooperativeYield,
    createManagedAttachmentSourcePredicate,
    stripFileScheme,
} from './sync-service-utils';

export {
    collectAttachmentsById,
    getBaseSyncUrl,
    getCloudBaseUrl,
    normalizePendingRemoteDeletes,
    reportProgress,
    validateAttachmentHash,
} from '@mindwtr/core';

type BasicRemoteAttachmentSyncOptions = Omit<
    AttachmentTransferLifecycleOptions,
    'beforeEachAttachment' | 'resolveLocalPath' | 'canUploadFrom' | 'requireUploadSnapshot'
> & {
    /**
     * The sync run's freshness guard, checked between attachments exactly like the
     * cleanup lifecycle does (sync-attachment-cleanup.ts). The run re-checks freshness
     * before persisting either way, so this is not what keeps a local edit safe — it is
     * what stops a pass from working through every remaining transfer before the run
     * discovers the snapshot is stale and requeues.
     */
    ensureLocalSnapshotFresh?: () => void;
};

type AttachmentUploadSnapshotFactoryOptions = {
    readLocalFile: (path: string, attachment: Attachment) => Promise<Uint8Array>;
    statLocalFile: (path: string, attachment: Attachment) => Promise<LocalFileStat | null>;
    stageBytes?: (
        bytes: Uint8Array,
        attachment: Attachment,
    ) => Promise<{ sourcePath: string; dispose: () => Promise<void> }>;
};

/**
 * Capture the exact desktop bytes that an uploader will retry, together with
 * the digest it will publish. The before/after stat check is a cheap race
 * detector for a live source changing while it is being copied into memory.
 */
export const createAttachmentUploadSnapshotFactory = ({
    readLocalFile,
    statLocalFile,
    stageBytes,
}: AttachmentUploadSnapshotFactoryOptions): NonNullable<
    AttachmentTransferLifecycleOptions['createUploadSnapshot']
> => async (path, attachment): Promise<AttachmentUploadSnapshot | null> => {
    const before = await statLocalFile(path, attachment);
    if (!before) return null;

    const bytes = await readLocalFile(path, attachment);
    const after = await statLocalFile(path, attachment);
    if (
        !after
        || before.mtimeMs !== after.mtimeMs
        || before.size !== after.size
        || after.size !== bytes.byteLength
    ) {
        return null;
    }

    const staged = stageBytes
        ? await stageBytes(bytes, attachment)
        : { sourcePath: path, dispose: async () => undefined };
    const fileHash = await computeSha256Hex(bytes);
    if (!fileHash) {
        await staged.dispose();
        return null;
    }
    return {
        sourcePath: staged.sourcePath,
        bytes,
        fileHash,
        stat: after,
        dispose: staged.dispose,
    };
};

/**
 * Reports changes as attachment patches; it never writes to the objects it is given.
 * Callers fold the patches into a fresh document with `applyAttachmentPatches` and
 * return that.
 */
export async function syncBasicRemoteAttachments({
    ensureLocalSnapshotFresh,
    ...options
}: BasicRemoteAttachmentSyncOptions): Promise<AttachmentTransferResult> {
    const maybeYield = createCooperativeYield(4);
    return await runAttachmentTransferLifecycle({
        ...options,
        beforeEachAttachment: async () => {
            await maybeYield();
            ensureLocalSnapshotFresh?.();
        },
        resolveLocalPath: stripFileScheme,
        canUploadFrom: await createManagedAttachmentSourcePredicate(),
        requireUploadSnapshot: true,
    });
}
