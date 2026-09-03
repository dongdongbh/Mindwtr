export {
    buildCloudKey,
    cleanupAttachmentTempFiles,
    deleteManagedAttachmentFile,
    ATTACHMENT_LOCAL_MIGRATION_MAX_PER_SYNC,
    getBaseSyncUrl,
    getCloudBaseUrl,
    hasCompletedAttachmentPresenceReconciliation,
    hasPendingAttachmentSyncWork,
    persistAttachmentLocally,
    persistAttachmentLocallyDetailed,
} from './attachment-sync-utils';
export type { PersistAttachmentOutcome } from './attachment-sync-utils';
export {
    syncCloudAttachments,
    syncCloudKitAttachments,
    syncDropboxAttachments,
    syncFileAttachments,
    syncWebdavAttachments,
} from './attachment-sync-backends';
export { ensureAttachmentAvailable } from './attachment-sync-availability';
