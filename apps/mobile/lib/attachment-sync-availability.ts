import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  cloudGetFile,
  isSandboxMode,
  webdavGetFile,
  withRetry,
} from '@mindwtr/core';
import {
  createMobileAttachmentAvailability,
  getAttachmentAvailabilityPatch,
  getAttachmentDownloadIdentity,
  getAttachmentUnrecoverablePatch,
  hasAttachmentDownloadIdentity,
  type MobileAttachmentAvailability,
} from '@mindwtr/core/mobile-attachment-availability';
import { DropboxFileNotFoundError, downloadDropboxFile } from './dropbox-sync';
import { getDropboxClientId, mobileAttachmentFiles } from './attachment-sync-utils';
import { mobileAttachmentCommon } from './attachment-sync-backends/common';
import {
  fetchCloudKitAttachmentAsset,
  isCloudKitAttachmentNotFoundError,
} from './cloudkit-sync';
import { getSyncEncryptionMaterial } from './sync-encryption-state';


export {
  getAttachmentAvailabilityPatch,
  getAttachmentDownloadIdentity,
  getAttachmentUnrecoverablePatch,
  hasAttachmentDownloadIdentity,
};
export type { AttachmentAvailabilityOutcome } from '@mindwtr/core/mobile-attachment-availability';

let availability: MobileAttachmentAvailability | null = null;

const mobileAttachmentAvailability = (): MobileAttachmentAvailability => {
  if (availability) return availability;
  availability = createMobileAttachmentAvailability({
    files: mobileAttachmentFiles(),
    common: mobileAttachmentCommon(),
    storage: { getItem: (key) => AsyncStorage.getItem(key) },
    encryption: { getSyncEncryptionMaterial: () => getSyncEncryptionMaterial() },
    getDropboxClientId: () => getDropboxClientId(),
    cloudKit: {
      fetchAttachmentAsset: (recordName, stagedUri) => fetchCloudKitAttachmentAsset(recordName, stagedUri),
      isAttachmentNotFoundError: (error) => isCloudKitAttachmentNotFoundError(error),
    },
    core: {
      isSandboxMode: () => isSandboxMode(),
      withRetry: (operation, options) => withRetry(operation, options),
      cloudGetFile: (url, options) => cloudGetFile(url, options),
      webdavGetFile: (url, options) => webdavGetFile(url, options),
      downloadDropboxFile: (accessToken, path) => downloadDropboxFile(accessToken, path),
      isDropboxFileNotFoundError: (error) => error instanceof DropboxFileNotFoundError,
    },
  });
  return availability;
};

export const ensureAttachmentAvailableDetailed: MobileAttachmentAvailability['ensureAttachmentAvailableDetailed'] = (
  attachment,
) => mobileAttachmentAvailability().ensureAttachmentAvailableDetailed(attachment);


export const ensureAttachmentAvailable: MobileAttachmentAvailability['ensureAttachmentAvailable'] = (
  attachment,
) => mobileAttachmentAvailability().ensureAttachmentAvailable(attachment);
