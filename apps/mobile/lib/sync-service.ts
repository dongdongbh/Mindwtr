import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Network from 'expo-network';
import {
  acquireSyncRemoteMutationFence,
  cloudGetJson,
  cloudHeadJson,
  cloudPutJson,
  createDropboxSyncRemoteMutationFencePort,
  createWebdavSyncRemoteMutationFencePort,
  flushPendingSave,
  getInMemoryAppDataSnapshot,
  isSandboxMode,
  isWorkspaceTransitionActive,
  performSyncCycle,
  probeWebdavSyncCompatibility,
  useTaskStore,
  webdavGetSyncDocument,
  webdavHeadFile,
  webdavPutSyncDocument,
  withRetry,
} from '@mindwtr/core';
import {
  createMobileSyncService,
  type MobileSyncService,
} from '@mindwtr/core/mobile-sync-service';
import { readDropboxAppKey } from '@mindwtr/core/mobile-sync-utils';
import { mobileStorage } from './storage-adapter';
import { logInfo, logSyncError, logWarn, sanitizeLogMessage } from './app-log';
import { readSyncFileVersioned, resolveSyncFileUri, writeSyncFile } from './storage-file';
import { isSyncPathBookmarksAvailable, resolveSyncPathBookmark } from './sync-path-bookmarks';
import { getBaseSyncUrl, getCloudBaseUrl, syncCloudAttachments, syncCloudKitAttachments, syncDropboxAttachments, syncFileAttachments, syncWebdavAttachments, cleanupAttachmentTempFiles, clearWebdavDownloadBackoffs, hasCompletedAttachmentPresenceReconciliation, hasPendingAttachmentSyncWork } from './attachment-sync';
import { runMobileAttachmentCleanup } from './sync-attachment-cleanup';
import { getExternalCalendars, saveExternalCalendars } from './external-calendar';
import {
  forceRefreshDropboxAccessToken,
  forceRefreshDropboxAccessTokenForTokens,
  getValidDropboxAccessToken,
  getValidDropboxAccessTokenForTokens,
  isDropboxConnected,
} from './dropbox-auth';
import {
  deleteDropboxFileVersioned,
  downloadDropboxAppData,
  getDropboxAppDataMetadata,
  getDropboxFileMetadata,
  uploadDropboxAppData,
} from './dropbox-sync';
import { ensureCloudKitReady, readRemoteCloudKit, writeRemoteCloudKit, isCloudKitAvailable } from './cloudkit-sync';
import { getSecureConfigValue } from './secure-config';
import { mobileSyncCryptoPrimitives } from './sync-crypto-native';
import {
  flushSyncEncryptionLocalState,
  getMobileSyncEncryptionStatus,
  getSyncEncryptionMaterial,
  isSyncEncryptionBlocked,
  isSyncEncryptionPostureUnestablished,
  loadSyncEncryptionLocalState,
  logSyncEncryptionEvent,
  syncEncryptionLocalState,
} from './sync-encryption-state';
import { ensureWebdavCapabilityProof } from './webdav-capability-proof';
import {
  acquireMobileFileSyncLease,
  revalidateMobileFileSyncLease,
  releaseMobileFileSyncLease,
  type MobileFileSyncLease,
} from './sync-file-lock';
import { backgroundSafeFetch, setBackgroundSafeFetchDeadline } from './background-safe-fetch';
import './js-timers';

// The sync service itself — one cycle per backend on the shared cycle machine, the queue, the
// offline checks, the config cache and the visible sync activity — lives in core
// (`packages/core/src/mobile-sync-service.ts`) so the native app runs the same policy. This
// module binds it to AsyncStorage, expo-network, the SQLite storage adapter, the app log, File
// Sync, the attachment passes, CloudKit and the Dropbox credentials. Every binding calls the
// imported function when used, so tests that replace these modules still reach their mocks.

// Phase 3 imports the sync-encryption surface from the sync-service layer (pinned API
// location); the implementation lives next door in sync-encryption-service.ts.
export {
  changeSyncEncryptionPassphrase,
  declineSyncEncryptionPassphrase,
  disableSyncEncryption,
  enableSyncEncryption,
  getSyncEncryptionStatus,
  provideSyncEncryptionPassphrase,
  type SyncEncryptionTransitionOptions,
} from './sync-encryption-service';
export type {
  MobileCloudSyncConfig,
  MobileDropboxSyncCredentials,
  MobileSyncConfigOverride,
  MobileWebDavSyncConfig,
} from '@mindwtr/core/mobile-sync-service';

const isFossBuild = (() => {
  const extra = Constants.expoConfig?.extra as { isFossBuild?: unknown } | undefined;
  return extra?.isFossBuild === true || extra?.isFossBuild === 'true';
})();

const getDropboxAppKey = (): string => readDropboxAppKey(Constants.expoConfig?.extra);

// Created on first use: tests that replace @mindwtr/core as a whole still import this module.
let service: MobileSyncService<MobileFileSyncLease> | null = null;
const mobileSyncService = (): MobileSyncService<MobileFileSyncLease> => {
  service ??= createMobileSyncService<MobileFileSyncLease>({
    storage: {
      getItem: (key) => AsyncStorage.getItem(key),
      setItem: (key, value) => AsyncStorage.setItem(key, value),
      removeItem: (key) => AsyncStorage.removeItem(key),
    },
    getSecureConfigValue: (key) => getSecureConfigValue(key),
    platform: {
      os: () => Platform.OS,
      isFossBuild,
      dropboxAppKey: () => getDropboxAppKey(),
    },
    network: {
      getState: () => Network.getNetworkStateAsync(),
      subscribe: (listener) => Network.addNetworkStateListener(listener),
    },
    localData: {
      getData: () => mobileStorage.getData(),
      saveData: (data) => mobileStorage.saveData(data),
    },
    log: {
      info: (message, context) => logInfo(message, context),
      warn: (message, context) => logWarn(message, context),
      syncError: (error, context) => logSyncError(error, context),
      sanitize: (message) => sanitizeLogMessage(message),
    },
    externalCalendars: {
      load: () => getExternalCalendars(),
      save: (calendars) => saveExternalCalendars(calendars),
    },
    fetch: backgroundSafeFetch,
    crypto: mobileSyncCryptoPrimitives,
    encryption: {
      flushSyncEncryptionLocalState: () => flushSyncEncryptionLocalState(),
      getSyncEncryptionStatus: () => getMobileSyncEncryptionStatus(),
      getSyncEncryptionMaterial: () => getSyncEncryptionMaterial(),
      isSyncEncryptionBlocked: (activeScope) => isSyncEncryptionBlocked(activeScope),
      isSyncEncryptionPostureUnestablished: (activeScope, hasCompletedCycleAgainstLocation) => (
        isSyncEncryptionPostureUnestablished(activeScope, hasCompletedCycleAgainstLocation)
      ),
      loadSyncEncryptionLocalState: () => loadSyncEncryptionLocalState(),
      logSyncEncryptionEvent: (event, extra, options) => logSyncEncryptionEvent(event, extra, options),
      syncEncryptionLocalState,
      // Loaded when asked: the encryption service pulls in the attachment and File Sync modules this one must not load.
      probeLocationCiphertext: async (target) => (await import('./sync-encryption-service')).probeSyncLocationCiphertext(target),
    },
    ensureWebdavCapabilityProof: (config, probe, options) => ensureWebdavCapabilityProof(config, probe, options),
    dropboxAuth: {
      isConnected: () => isDropboxConnected(),
      getValidAccessToken: (clientId, fetcher) => getValidDropboxAccessToken(clientId, fetcher),
      forceRefreshAccessToken: (clientId, fetcher) => forceRefreshDropboxAccessToken(clientId, fetcher),
      getValidAccessTokenForTokens: (clientId, tokens, fetcher) => (
        getValidDropboxAccessTokenForTokens(clientId, tokens, fetcher)
      ),
      forceRefreshAccessTokenForTokens: (clientId, tokens, fetcher) => (
        forceRefreshDropboxAccessTokenForTokens(clientId, tokens, fetcher)
      ),
    },
    fileSync: {
      readVersioned: (path, options) => readSyncFileVersioned(path, options),
      write: (path, data, options) => writeSyncFile(path, data, options),
      resolveUri: (uri, options) => resolveSyncFileUri(uri, options),
      isBookmarksAvailable: () => isSyncPathBookmarksAvailable(),
      resolveBookmark: (bookmark) => resolveSyncPathBookmark(bookmark),
      acquireLease: (path) => acquireMobileFileSyncLease(path),
      revalidateLease: (lease) => revalidateMobileFileSyncLease(lease),
      releaseLease: (lease) => releaseMobileFileSyncLease(lease),
    },
    attachments: {
      syncWebdav: (data, config, signal, options) => (
        syncWebdavAttachments(data, config, getBaseSyncUrl(config.url), signal, options)
      ),
      syncCloud: (data, config, options) => (
        syncCloudAttachments(data, config, getCloudBaseUrl(config.url), options)
      ),
      syncDropbox: (data, clientId, fetcher, options) => syncDropboxAttachments(data, clientId, fetcher, options),
      syncFile: (data, syncPath, signal, options) => syncFileAttachments(data, syncPath, signal, options),
      cleanupTempFiles: () => cleanupAttachmentTempFiles(),
      hasCompletedPresenceReconciliation: () => hasCompletedAttachmentPresenceReconciliation(),
      hasPendingWork: (data, options) => hasPendingAttachmentSyncWork(data, options),
      runCleanup: (options) => runMobileAttachmentCleanup(options),
      clearDownloadBackoff: () => clearWebdavDownloadBackoffs(),
    },
    cloudKit: {
      isAvailable: () => isCloudKitAvailable(),
      ensureReady: (options) => ensureCloudKitReady(options),
      read: (options) => readRemoteCloudKit(options),
      write: (data, options) => writeRemoteCloudKit(data, options),
      syncAttachments: (data, signal, options) => syncCloudKitAttachments(data, signal, options),
    },
    core: {
      useTaskStore: {
        getState: () => useTaskStore.getState(),
        setState: (...args: Parameters<typeof useTaskStore.setState>) => useTaskStore.setState(...args),
      },
      flushPendingSave: () => flushPendingSave(),
      getInMemoryAppDataSnapshot: () => getInMemoryAppDataSnapshot(),
      isSandboxMode: () => isSandboxMode(),
      isWorkspaceTransitionActive: () => isWorkspaceTransitionActive(),
      performSyncCycle: (io) => performSyncCycle(io),
      withRetry: (operation, options) => withRetry(operation, options),
      probeWebdavSyncCompatibility: (url, options, probeOptions) => probeWebdavSyncCompatibility(url, options, probeOptions),
      webdavGetSyncDocument: (url, options) => webdavGetSyncDocument(url, options),
      webdavPutSyncDocument: (url, data, options) => webdavPutSyncDocument(url, data, options),
      webdavHeadFile: (url, options) => webdavHeadFile(url, options),
      cloudGetJson: (url, options) => cloudGetJson(url, options),
      cloudPutJson: (url, data, options) => cloudPutJson(url, data, options),
      cloudHeadJson: (url, options) => cloudHeadJson(url, options),
      acquireSyncRemoteMutationFence: (port, options) => acquireSyncRemoteMutationFence(port, options),
      createWebdavSyncRemoteMutationFencePort: (url, options) => createWebdavSyncRemoteMutationFencePort(url, options),
      createDropboxSyncRemoteMutationFencePort: (token, fetcher, options) => (
        createDropboxSyncRemoteMutationFencePort(token, fetcher, options)
      ),
      downloadDropboxAppData: (...args) => downloadDropboxAppData(...args),
      uploadDropboxAppData: (...args) => uploadDropboxAppData(...args),
      getDropboxAppDataMetadata: (...args) => getDropboxAppDataMetadata(...args),
      getDropboxFileMetadata: (...args) => getDropboxFileMetadata(...args),
      deleteDropboxFileVersioned: (...args) => deleteDropboxFileVersioned(...args),
    },
  });
  return service;
};

export const getMobileSyncActivityState: MobileSyncService['getMobileSyncActivityState'] = () => (
  mobileSyncService().getMobileSyncActivityState()
);

export const subscribeMobileSyncActivityState: MobileSyncService['subscribeMobileSyncActivityState'] = (listener) => (
  mobileSyncService().subscribeMobileSyncActivityState(listener)
);

export const waitForMobileSyncIdle = (): Promise<void> => mobileSyncService().waitForMobileSyncIdle();

export const clearMobileSyncConfigCache = (): void => {
  mobileSyncService().clearMobileSyncConfigCache();
};

export const getMobileSelectedSyncBackend: MobileSyncService['getMobileSelectedSyncBackend'] = () => (
  mobileSyncService().getMobileSelectedSyncBackend()
);
export const getMobileSyncConfigurationStatus: MobileSyncService['getMobileSyncConfigurationStatus'] = () => (
  mobileSyncService().getMobileSyncConfigurationStatus()
);

/** `manual` marks a user-initiated sync: it always runs the full read/merge cycle,
 *  never the fast-check skip, so a stale cached fingerprint can't hide remote data. */
export const performMobileSync: MobileSyncService['performMobileSync'] = (syncPathOverride, options) => (
  mobileSyncService().performMobileSync(syncPathOverride, options)
);

export { setBackgroundSafeFetchDeadline as setMobileSyncRequestDeadline };

/** 'deadline' (the background run gave up) ends the cycle with no follow-up; 'lifecycle' queues one. */
export function abortMobileSync(reason?: 'lifecycle' | 'deadline'): boolean {
  return mobileSyncService().abortMobileSync(reason);
}

export const __mobileSyncTestUtils = {
  reset() {
    mobileSyncService().__mobileSyncTestUtils.reset();
  },
  getWebdavSyncBlockedUntil() {
    return mobileSyncService().__mobileSyncTestUtils.getWebdavSyncBlockedUntil();
  },
  queueFollowUpForTests() {
    mobileSyncService().__mobileSyncTestUtils.queueFollowUpForTests();
  },
  clearFollowUpForTests() {
    mobileSyncService().__mobileSyncTestUtils.clearFollowUpForTests();
  },
};
