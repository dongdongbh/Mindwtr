import {
  cloudDeleteFile,
  webdavDeleteFileVersioned,
  webdavHeadFile,
} from '@mindwtr/core';
import {
  runMobileAttachmentCleanup as runCoreMobileAttachmentCleanup,
  type MobileAttachmentCleanupResult,
} from '@mindwtr/core/mobile-attachment-cleanup';
import type { MobileSyncAttachmentCleanupOptions } from '@mindwtr/core/mobile-sync-service';
import { getBaseSyncUrl, getCloudBaseUrl } from './attachment-sync';
import { mobileAttachmentFileSystem } from './attachment-sync-utils';
import { DropboxConflictError } from './dropbox-sync';


export const runMobileAttachmentCleanup = async (
  options: MobileSyncAttachmentCleanupOptions
): Promise<MobileAttachmentCleanupResult> => runCoreMobileAttachmentCleanup(options, {
  fs: mobileAttachmentFileSystem,
  isDropboxConflictError: (error) => error instanceof DropboxConflictError,
  core: {
    getBaseSyncUrl: (url) => getBaseSyncUrl(url),
    getCloudBaseUrl: (url) => getCloudBaseUrl(url),
    webdavHeadFile: (url, options) => webdavHeadFile(url, options),
    webdavDeleteFileVersioned: (url, etag, options) => webdavDeleteFileVersioned(url, etag, options),
    cloudDeleteFile: (url, options) => cloudDeleteFile(url, options),
  },
});
