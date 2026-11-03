import {
  isLikelyOfflineSyncError as isCoreLikelyOfflineSyncError,
  isRemoteSyncBackend as isCoreRemoteSyncBackend,
  type SyncBackend as CoreSyncBackend,
} from '@mindwtr/core';


export {
  classifySyncFailure,
  coerceSupportedBackend,
  formatMobileSyncErrorMessage as formatSyncErrorMessage,
  getFileSyncBaseDir,
  getSyncConflictCount,
  getSyncMaxClockSkewMs,
  getSyncTimestampAdjustments,
  hasSameUserFacingSyncConflictSummary,
  isLikelyFilePath,
  isMobileSyncFilePath as isSyncFilePath,
  normalizeFileSyncPath,
  resolveBackend,
  type SyncFailureKind,
} from '@mindwtr/core/mobile-sync-utils';

export type SyncBackend = CoreSyncBackend | 'cloudkit';

export const isLikelyOfflineSyncError = (errorOrMessage: unknown): boolean => {
  return isCoreLikelyOfflineSyncError(errorOrMessage);
};

export const isRemoteSyncBackend = (backend: SyncBackend): boolean => isCoreRemoteSyncBackend(backend);
