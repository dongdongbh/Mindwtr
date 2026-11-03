import {
    computeSha256Hex,
    assertBufferedAttachmentUploadSize,
    AttachmentUploadSizeUnavailableError,
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


    ensureLocalSnapshotFresh?: () => void;
};

type AttachmentUploadSnapshotFactoryOptions = {
    readLocalFile: (path: string, attachment: Attachment) => Promise<Uint8Array>;
    statLocalFile: (path: string, attachment: Attachment) => Promise<LocalFileStat | null>;
    maxBufferedUploadBytes?: number;
    stageBytes?: (
        bytes: Uint8Array,
        attachment: Attachment,
    ) => Promise<{ sourcePath: string; dispose: () => Promise<void> }>;
};


export const createAttachmentUploadSnapshotFactory = ({
    readLocalFile,
    statLocalFile,
    stageBytes,
    maxBufferedUploadBytes,
}: AttachmentUploadSnapshotFactoryOptions): NonNullable<
    AttachmentTransferLifecycleOptions['createUploadSnapshot']
> => async (path, attachment): Promise<AttachmentUploadSnapshot | null> => {
    const before = await statLocalFile(path, attachment);
    if (!before) {
        if (maxBufferedUploadBytes !== undefined) {
            throw new AttachmentUploadSizeUnavailableError();
        }
        return null;
    }
    if (maxBufferedUploadBytes !== undefined) {
        assertBufferedAttachmentUploadSize(before.size, maxBufferedUploadBytes);
    }

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
