import {
  cloudAttachmentExists,
  cloudGetFile,
  cloudPutFile,
  MAX_FILE_SYNC_BUFFERED_PLAINTEXT_BYTES,
  webdavConfirmUploadedFile,
  webdavFileExists,
  webdavGetFile,
  webdavHeadFile,
  webdavMakeDirectory,
  webdavPutFileVersioned,
  withRetry,
  type AppData,
} from '@mindwtr/core';
import {
  createMobileAttachmentBackends,
  type DropboxAttachmentSyncOptions,
  type MobileAttachmentBackends,
} from '@mindwtr/core/mobile-attachment-backends';
import {
  abandonFileSyncAttachmentPublication,
  claimFileSyncAttachmentPublication,
  clearFileSyncAttachmentPublicationRecovery,
  completeFileSyncAttachmentPublication,
  hashAttachmentFileGeneration,
  publishImmutableAttachmentFileGeneration,
  recoverFileSyncAttachmentPublications,
  reserveFileSyncAttachmentPublication,
  retainFileSyncAttachmentPublicationForInvalidTarget,
} from './attachment-file-installer';
import { mobileAttachmentCommon } from './attachment-sync-backends/common';
import { mobileAttachmentFiles, mobileAttachmentFileSystem } from './attachment-sync-utils';
import { sanitizeLogMessage } from './app-log';
import { backgroundSafeFetch } from './background-safe-fetch';
import {
  DropboxConflictError,
  DropboxFileNotFoundError,
  downloadDropboxFile,
  getDropboxFileMetadata,
  listDropboxFolderFiles,
  uploadDropboxFileVersioned,
} from './dropbox-sync';


export { syncCloudKitAttachments } from './attachment-sync-backends/cloudkit';
export type { CloudAttachmentSyncOptions, DropboxAttachmentSyncOptions } from '@mindwtr/core/mobile-attachment-backends';

let backends: MobileAttachmentBackends | null = null;

const mobileAttachmentBackends = (): MobileAttachmentBackends => {
  if (backends) return backends;
  backends = createMobileAttachmentBackends({
    fs: mobileAttachmentFileSystem,
    files: mobileAttachmentFiles(),
    common: mobileAttachmentCommon(),
    installer: {
      abandonFileSyncAttachmentPublication: (...args) => abandonFileSyncAttachmentPublication(...args),
      clearFileSyncAttachmentPublicationRecovery: (...args) => clearFileSyncAttachmentPublicationRecovery(...args),
      claimFileSyncAttachmentPublication: (...args) => claimFileSyncAttachmentPublication(...args),
      completeFileSyncAttachmentPublication: (...args) => completeFileSyncAttachmentPublication(...args),
      hashAttachmentFileGeneration: (...args) => hashAttachmentFileGeneration(...args),
      publishImmutableAttachmentFileGeneration: (...args) => publishImmutableAttachmentFileGeneration(...args),
      recoverFileSyncAttachmentPublications: (...args) => recoverFileSyncAttachmentPublications(...args),
      reserveFileSyncAttachmentPublication: (...args) => reserveFileSyncAttachmentPublication(...args),
      retainFileSyncAttachmentPublicationForInvalidTarget: (...args) => (
        retainFileSyncAttachmentPublicationForInvalidTarget(...args)
      ),
    },
    log: { sanitize: (message) => sanitizeLogMessage(message) },
    core: {
      withRetry: (operation, options) => withRetry(operation, options),
      webdavFileExists: (...args) => webdavFileExists(...args),
      webdavGetFile: (...args) => webdavGetFile(...args),
      webdavHeadFile: (...args) => webdavHeadFile(...args),
      webdavMakeDirectory: (...args) => webdavMakeDirectory(...args),
      webdavPutFileVersioned: (...args) => webdavPutFileVersioned(...args),
      webdavConfirmUploadedFile: (...args) => webdavConfirmUploadedFile(...args),
      cloudAttachmentExists: (...args) => cloudAttachmentExists(...args),
      cloudGetFile: (...args) => cloudGetFile(...args),
      cloudPutFile: (...args) => cloudPutFile(...args),
      downloadDropboxFile: (...args) => downloadDropboxFile(...args),
      getDropboxFileMetadata: (...args) => getDropboxFileMetadata(...args),
      listDropboxFolderFiles: (...args) => listDropboxFolderFiles(...args),
      uploadDropboxFileVersioned: (...args) => uploadDropboxFileVersioned(...args),
      isDropboxConflictError: (error) => error instanceof DropboxConflictError,
      isDropboxFileNotFoundError: (error) => error instanceof DropboxFileNotFoundError,
      maxFileSyncBufferedPlaintextBytes: () => MAX_FILE_SYNC_BUFFERED_PLAINTEXT_BYTES,
    },
  });
  return backends;
};

type Backends = MobileAttachmentBackends;

export const syncWebdavAttachments: Backends['syncWebdavAttachments'] = (...args) => (
  mobileAttachmentBackends().syncWebdavAttachments(...args)
);
export const syncCloudAttachments: Backends['syncCloudAttachments'] = (...args) => (
  mobileAttachmentBackends().syncCloudAttachments(...args)
);
export const syncDropboxAttachments = (
  appData: AppData,
  dropboxClientId: string,
  fetcher: typeof fetch = backgroundSafeFetch,
  options: DropboxAttachmentSyncOptions = {},
): ReturnType<Backends['syncDropboxAttachments']> => (
  mobileAttachmentBackends().syncDropboxAttachments(appData, dropboxClientId, fetcher, options)
);
export const syncFileAttachments: Backends['syncFileAttachments'] = (...args) => (
  mobileAttachmentBackends().syncFileAttachments(...args)
);
