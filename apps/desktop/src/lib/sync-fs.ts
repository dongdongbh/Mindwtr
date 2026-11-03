import { invokeNative } from './tauri-invoke';


export const exists = (path: string): Promise<boolean> => invokeNative('sync_fs_exists', { path });

export const mkdir = (path: string): Promise<void> => invokeNative('sync_fs_create_dir', { path });

export const remove = (path: string): Promise<void> => invokeNative('sync_fs_remove_file', { path });

export const rename = (from: string, to: string): Promise<void> =>
    invokeNative('sync_fs_rename', { from, to });


export type AttachmentGenerationPublication =
    | { status: 'published' }
    | { status: 'alreadyExists' };

export type AttachmentGenerationReservation = {
    operationId: string;
    scratchPath: string;
};

export const reserveAttachmentGeneration = (
    leaseToken: string,
    targetPath: string,
    expectedSize: number,
    expectedSha256: string,
): Promise<AttachmentGenerationReservation> => invokeNative('sync_fs_reserve_attachment_generation', {
    leaseToken,
    targetPath,
    expectedSize,
    expectedSha256,
});

export const publishAttachmentGeneration = (
    leaseToken: string,
    operationId: string,
): Promise<AttachmentGenerationPublication> => invokeNative('sync_fs_publish_attachment_generation', {
    leaseToken,
    operationId,
});

export const abandonAttachmentGeneration = (
    leaseToken: string,
    operationId: string,
): Promise<void> => invokeNative('sync_fs_abandon_attachment_generation', {
    leaseToken,
    operationId,
});


export const stat = (path: string): Promise<{ mtimeMs: number; size: number }> =>
    invokeNative('sync_fs_stat', { path });


export const acquireFileSyncLease = (path?: string): Promise<string> =>
    invokeNative('acquire_file_sync_lease', path ? { path } : undefined);

export const releaseFileSyncLease = (token: string): Promise<void> =>
    invokeNative('release_file_sync_lease', { token });
