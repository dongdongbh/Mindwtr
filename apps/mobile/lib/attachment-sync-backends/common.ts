import * as LegacyFileSystem from 'expo-file-system/legacy';
import {
  assertAttachmentSyncNotAborted,
  CLOUD_ATTACHMENT_PRESENCE_MAX_CHECKS_PER_PASS,
  createAttachmentAbortError,
  createMobileAttachmentCommon,
  isAttachmentSyncAbortError,
  resolveAttachmentDownloadTargetPath,
  StreamedUploadCancellationUnconfirmedError,
  type MobileAttachmentCommon,
} from '@mindwtr/core/mobile-attachment-common';
import { mobileAttachmentFiles, mobileAttachmentFileSystem } from '../attachment-sync-utils';
import { installAttachmentFileGeneration } from '../attachment-file-installer';
import { isExpoGo } from '../expo-go';
import { areJsTimersPaused } from '../js-timers';
import { getMobileSyncEncryptionStatus, logSyncEncryptionEvent } from '../sync-encryption-state';
import { mobileSyncCryptoPrimitives } from '../sync-crypto-native';


export {
  assertAttachmentSyncNotAborted,
  CLOUD_ATTACHMENT_PRESENCE_MAX_CHECKS_PER_PASS,
  createAttachmentAbortError,
  isAttachmentSyncAbortError,
  resolveAttachmentDownloadTargetPath,
  StreamedUploadCancellationUnconfirmedError,
};
export type { BespokeAttachmentRemoteWinnerCheck } from '@mindwtr/core/mobile-attachment-common';


const resolveUploadType = (): number => {
  const types = (LegacyFileSystem as any).FileSystemUploadType;
  return types?.BINARY_CONTENT ?? types?.BINARY ?? 0;
};

let common: MobileAttachmentCommon | null = null;


export const mobileAttachmentCommon = (): MobileAttachmentCommon => {
  if (common) return common;
  common = createMobileAttachmentCommon({
    fs: mobileAttachmentFileSystem,
    files: mobileAttachmentFiles(),
    crypto: mobileSyncCryptoPrimitives,
    encryption: {
      getSyncEncryptionStatus: () => getMobileSyncEncryptionStatus(),
      logSyncEncryptionEvent: (event, extra, options) => logSyncEncryptionEvent(event, extra, options),
    },
    installer: {
      installAttachmentFileGeneration: (stagedPath, targetPath, expected, expectedDownloadSha256) => (
        installAttachmentFileGeneration(stagedPath, targetPath, expected, expectedDownloadSha256)
      ),
    },
    installerMayBeMissing: () => isExpoGo(),
    timersPaused: () => areJsTimersPaused(),
    uploads: {


      createUploadTask: (url, fileUri, options, onProgress) => {
        if (typeof LegacyFileSystem.uploadAsync !== 'function') return null;
        if (typeof LegacyFileSystem.createUploadTask !== 'function') return null;
        return LegacyFileSystem.createUploadTask(
          url,
          fileUri,
          { ...options, uploadType: resolveUploadType() },
          onProgress,
        );
      },
    },
  });
  return common;
};

type Common = MobileAttachmentCommon;

export const sealAttachmentBytesForUpload: Common['sealAttachmentBytesForUpload'] = (...args) => (
  mobileAttachmentCommon().sealAttachmentBytesForUpload(...args)
);
export const openAttachmentBytesFromDownload: Common['openAttachmentBytesFromDownload'] = (...args) => (
  mobileAttachmentCommon().openAttachmentBytesFromDownload(...args)
);
export const deleteAttachmentDownloadStageBestEffort: Common['deleteAttachmentDownloadStageBestEffort'] = (...args) => (
  mobileAttachmentCommon().deleteAttachmentDownloadStageBestEffort(...args)
);
export const copyAttachmentDownloadToStage: Common['copyAttachmentDownloadToStage'] = (...args) => (
  mobileAttachmentCommon().copyAttachmentDownloadToStage(...args)
);
export const readAttachmentDownloadStageBytes: Common['readAttachmentDownloadStageBytes'] = (...args) => (
  mobileAttachmentCommon().readAttachmentDownloadStageBytes(...args)
);
export const installStagedAttachmentDownload: Common['installStagedAttachmentDownload'] = (...args) => (
  mobileAttachmentCommon().installStagedAttachmentDownload(...args)
);
export const installAttachmentDownloadBytes: Common['installAttachmentDownloadBytes'] = (...args) => (
  mobileAttachmentCommon().installAttachmentDownloadBytes(...args)
);

export const createAttachmentDownloadStagePath: Common['createAttachmentDownloadStagePath'] = (...args) => (
  mobileAttachmentCommon().createAttachmentDownloadStagePath(...args)
);
export const createMobileAttachmentUploadSnapshot: Common['createMobileAttachmentUploadSnapshot'] = (...args) => (
  mobileAttachmentCommon().createMobileAttachmentUploadSnapshot(...args)
);
export const createMobileAttachmentUploadSnapshotWithLimit: Common['createMobileAttachmentUploadSnapshotWithLimit'] = (...args) => (
  mobileAttachmentCommon().createMobileAttachmentUploadSnapshotWithLimit(...args)
);
export const runMobileAttachmentLifecycle: Common['runMobileAttachmentLifecycle'] = (...args) => (
  mobileAttachmentCommon().runMobileAttachmentLifecycle(...args)
);
export const prepareBespokeAttachmentContentCandidate: Common['prepareBespokeAttachmentContentCandidate'] = (...args) => (
  mobileAttachmentCommon().prepareBespokeAttachmentContentCandidate(...args)
);
export const pendingBespokeAttachmentContentStillMatches: Common['pendingBespokeAttachmentContentStillMatches'] = (...args) => (
  mobileAttachmentCommon().pendingBespokeAttachmentContentStillMatches(...args)
);
export const checkBespokeAttachmentRemoteWinner: Common['checkBespokeAttachmentRemoteWinner'] = (...args) => (
  mobileAttachmentCommon().checkBespokeAttachmentRemoteWinner(...args)
);
export const refreshBespokeAttachmentDownloadedContentStat: Common['refreshBespokeAttachmentDownloadedContentStat'] = (...args) => (
  mobileAttachmentCommon().refreshBespokeAttachmentDownloadedContentStat(...args)
);
export const migrateAttachmentsLocallyBeforeSync: Common['migrateAttachmentsLocallyBeforeSync'] = (...args) => (
  mobileAttachmentCommon().migrateAttachmentsLocallyBeforeSync(...args)
);
export const reconcileRemoteAttachmentPresence: Common['reconcileRemoteAttachmentPresence'] = (...args) => (
  mobileAttachmentCommon().reconcileRemoteAttachmentPresence(...args)
);
export const waitForAttachmentSyncDelay: Common['waitForAttachmentSyncDelay'] = (...args) => (
  mobileAttachmentCommon().waitForAttachmentSyncDelay(...args)
);
export const uploadWebdavFileWithFileSystem: Common['uploadWebdavFileWithFileSystem'] = (...args) => (
  mobileAttachmentCommon().uploadWebdavFileWithFileSystem(...args)
);
