import { createMobileCloudKitAttachmentSync, type AppData } from '@mindwtr/core';
import { deleteCloudKitAttachmentAssets, fetchCloudKitAttachmentAsset, isCloudKitAttachmentNotFoundError,
    saveCloudKitAttachmentAsset } from '../cloudkit-sync';
import { computeAttachmentFileHash, getLocalAttachmentPresence, getAttachmentByteSize, getAttachmentsDir,
    logAttachmentWarn, markAttachmentPresenceReconciled, readAttachmentBytesForUpload, readFileAsBytes,
    statAttachmentFile, writeBytesSafely, getWebdavDownloadBackoff, setWebdavDownloadBackoff, clearWebdavDownloadBackoff } from '../attachment-sync-utils';
import { createAttachmentDownloadStagePath, deleteAttachmentDownloadStageBestEffort, installStagedAttachmentDownload,
    migrateAttachmentsLocallyBeforeSync, runMobileAttachmentLifecycle } from './common';

let sync: ReturnType<typeof createMobileCloudKitAttachmentSync> | undefined;

export const syncCloudKitAttachments = async (
    appData: AppData,
    signal?: AbortSignal,
    options: { activationProbe?: boolean; phase?: 'prepare' | 'post-merge' } = {},
): Promise<AppData | false> => {
    sync ??= createMobileCloudKitAttachmentSync({
        files: {
            computeAttachmentFileHash: (...args) => computeAttachmentFileHash(...args),
            getLocalAttachmentPresence: (...args) => getLocalAttachmentPresence(...args),
            getAttachmentByteSize: (...args) => getAttachmentByteSize(...args),
            getAttachmentsDir: () => getAttachmentsDir(),
            logAttachmentWarn: (...args) => logAttachmentWarn(...args),
            markAttachmentPresenceReconciled: () => markAttachmentPresenceReconciled(),
            readAttachmentBytesForUpload: (...args) => readAttachmentBytesForUpload(...args),
            readFileAsBytes: (...args) => readFileAsBytes(...args),
            statAttachmentFile: (...args) => statAttachmentFile(...args),
            writeBytesSafely: (...args) => writeBytesSafely(...args),
            getWebdavDownloadBackoff: (...args) => getWebdavDownloadBackoff(...args),
            setWebdavDownloadBackoff: (...args) => setWebdavDownloadBackoff(...args),
            clearWebdavDownloadBackoff: (...args) => clearWebdavDownloadBackoff(...args),
        },
        common: {
            createAttachmentDownloadStagePath: (...args) => createAttachmentDownloadStagePath(...args),
            deleteAttachmentDownloadStageBestEffort: (...args) => deleteAttachmentDownloadStageBestEffort(...args),
            installStagedAttachmentDownload: (...args) => installStagedAttachmentDownload(...args),
            migrateAttachmentsLocallyBeforeSync: (...args) => migrateAttachmentsLocallyBeforeSync(...args),
            runMobileAttachmentLifecycle: (...args) => runMobileAttachmentLifecycle(...args),
        },
        cloudKit: {
            deleteAttachmentAssets: (...args) => deleteCloudKitAttachmentAssets(...args),
            fetchAttachmentAsset: (...args) => fetchCloudKitAttachmentAsset(...args),
            isAttachmentNotFoundError: (...args) => isCloudKitAttachmentNotFoundError(...args),
            saveAttachmentAsset: (...args) => saveCloudKitAttachmentAsset(...args),
        },
    });
    return sync(appData, signal, options);
};
