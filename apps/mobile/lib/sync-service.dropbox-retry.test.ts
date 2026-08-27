import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';

import * as syncServiceModule from './sync-service';

const emptyData = {
  tasks: [],
  projects: [],
  sections: [],
  areas: [],
  people: [],
  settings: {},
};

const emptyStats = {
  tasks: { mergedTotal: 0, conflicts: 0, conflictIds: [], maxClockSkewMs: 0, timestampAdjustments: 0 },
  projects: { mergedTotal: 0, conflicts: 0, conflictIds: [], maxClockSkewMs: 0, timestampAdjustments: 0 },
  sections: { mergedTotal: 0, conflicts: 0, conflictIds: [], maxClockSkewMs: 0, timestampAdjustments: 0 },
  areas: { mergedTotal: 0, conflicts: 0, conflictIds: [], maxClockSkewMs: 0, timestampAdjustments: 0 },
};

const asyncStorageMocks = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
}));

const networkMocks = vi.hoisted(() => ({
  getNetworkStateAsync: vi.fn(),
  addNetworkStateListener: vi.fn(),
}));

const storageMocks = vi.hoisted(() => ({
  getData: vi.fn(),
  saveData: vi.fn(),
}));

const attachmentSyncMocks = vi.hoisted(() => ({
  getBaseSyncUrl: vi.fn((url: string) => url.replace(/\/+$/, '')),
  getCloudBaseUrl: vi.fn((url: string) => url.replace(/\/+$/, '')),
  syncCloudAttachments: vi.fn(),
  syncDropboxAttachments: vi.fn(),
  syncFileAttachments: vi.fn(),
  syncWebdavAttachments: vi.fn(),
  cleanupAttachmentTempFiles: vi.fn(),
  hasPendingAttachmentSyncWork: vi.fn(),
}));

const externalCalendarMocks = vi.hoisted(() => ({
  getExternalCalendars: vi.fn(),
  saveExternalCalendars: vi.fn(),
}));

const dropboxAuthMocks = vi.hoisted(() => ({
  forceRefreshDropboxAccessToken: vi.fn(),
  forceRefreshDropboxAccessTokenForTokens: vi.fn(),
  getValidDropboxAccessToken: vi.fn(),
  getValidDropboxAccessTokenForTokens: vi.fn(),
  isDropboxConnected: vi.fn(),
}));

const dropboxSyncMocks = vi.hoisted(() => ({
  deleteDropboxFile: vi.fn(),
  downloadDropboxAppData: vi.fn(),
  getDropboxAppDataMetadata: vi.fn(),
  uploadDropboxAppData: vi.fn(),
}));

const storageFileMocks = vi.hoisted(() => ({
  readSyncFile: vi.fn(),
  readSyncFileVersioned: vi.fn(),
  resolveSyncFileUri: vi.fn(),
  writeSyncFile: vi.fn(),
}));

const syncPathBookmarkMocks = vi.hoisted(() => ({
  resolveSyncPathBookmark: vi.fn(),
  isSyncPathBookmarksAvailable: vi.fn(() => false),
}));

const logMocks = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logSyncError: vi.fn(),
  logWarn: vi.fn(),
}));

const storeStateRef = vi.hoisted(() => ({
  current: {
    lastDataChangeAt: 1,
    settings: {},
    fetchData: vi.fn(),
    updateSettings: vi.fn(),
    setError: vi.fn(),
  },
}));

const coreMocks = vi.hoisted(() => ({
  acquireSyncRemoteMutationFence: vi.fn(),
  createDropboxSyncRemoteMutationFencePort: vi.fn(),
  createWebdavSyncRemoteMutationFencePort: vi.fn(),
  webdavGetJson: vi.fn(),
  webdavHeadFile: vi.fn(),
  webdavPutJson: vi.fn(),
  cloudGetJson: vi.fn(),
  cloudHeadJson: vi.fn(),
  cloudPutJson: vi.fn(),
  withRetry: vi.fn(),
  flushPendingSave: vi.fn(),
  performSyncCycle: vi.fn(),
  webdavDeleteFile: vi.fn(),
  cloudDeleteFile: vi.fn(),
  getInMemoryAppDataSnapshot: vi.fn(),
  useTaskStoreGetState: vi.fn(),
  useTaskStoreSetState: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: asyncStorageMocks.getItem,
    setItem: asyncStorageMocks.setItem,
    removeItem: asyncStorageMocks.removeItem,
  },
}));

// Non-FOSS build so the Dropbox cloud provider path is reachable (the runtime
// suite pins isFossBuild: true and can only assert Dropbox is unavailable).
vi.mock('expo-constants', () => ({
  default: {
    expoConfig: {
      extra: {
        isFossBuild: false,
        dropboxAppKey: 'test-app-key',
      },
    },
  },
}));

vi.mock('expo-network', () => ({
  getNetworkStateAsync: networkMocks.getNetworkStateAsync,
  addNetworkStateListener: networkMocks.addNetworkStateListener,
}));

vi.mock('expo-file-system/legacy', () => ({
  __esModule: true,
  documentDirectory: 'file://document/',
  cacheDirectory: 'file://cache/',
  deleteAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./storage-adapter', () => ({
  mobileStorage: {
    getData: storageMocks.getData,
    saveData: storageMocks.saveData,
  },
}));

vi.mock('./attachment-sync', () => ({
  getBaseSyncUrl: attachmentSyncMocks.getBaseSyncUrl,
  getCloudBaseUrl: attachmentSyncMocks.getCloudBaseUrl,
  syncCloudAttachments: attachmentSyncMocks.syncCloudAttachments,
  syncDropboxAttachments: attachmentSyncMocks.syncDropboxAttachments,
  syncFileAttachments: attachmentSyncMocks.syncFileAttachments,
  syncWebdavAttachments: attachmentSyncMocks.syncWebdavAttachments,
  cleanupAttachmentTempFiles: attachmentSyncMocks.cleanupAttachmentTempFiles,
  hasPendingAttachmentSyncWork: attachmentSyncMocks.hasPendingAttachmentSyncWork,
}));

vi.mock('./external-calendar', () => ({
  getExternalCalendars: externalCalendarMocks.getExternalCalendars,
  saveExternalCalendars: externalCalendarMocks.saveExternalCalendars,
}));

vi.mock('./dropbox-auth', () => ({
  forceRefreshDropboxAccessToken: dropboxAuthMocks.forceRefreshDropboxAccessToken,
  forceRefreshDropboxAccessTokenForTokens: dropboxAuthMocks.forceRefreshDropboxAccessTokenForTokens,
  getValidDropboxAccessToken: dropboxAuthMocks.getValidDropboxAccessToken,
  getValidDropboxAccessTokenForTokens: dropboxAuthMocks.getValidDropboxAccessTokenForTokens,
  isDropboxConnected: dropboxAuthMocks.isDropboxConnected,
}));

vi.mock('./dropbox-sync', () => ({
  DropboxConflictError: class DropboxConflictError extends Error {},
  DropboxUnauthorizedError: class DropboxUnauthorizedError extends Error {},
  deleteDropboxFile: dropboxSyncMocks.deleteDropboxFile,
  downloadDropboxAppData: dropboxSyncMocks.downloadDropboxAppData,
  getDropboxAppDataMetadata: dropboxSyncMocks.getDropboxAppDataMetadata,
  uploadDropboxAppData: dropboxSyncMocks.uploadDropboxAppData,
}));

vi.mock('./storage-file', () => ({
  readSyncFile: storageFileMocks.readSyncFile,
  readSyncFileVersioned: storageFileMocks.readSyncFileVersioned,
  resolveSyncFileUri: storageFileMocks.resolveSyncFileUri,
  writeSyncFile: storageFileMocks.writeSyncFile,
}));

vi.mock('./sync-path-bookmarks', () => ({
  resolveSyncPathBookmark: syncPathBookmarkMocks.resolveSyncPathBookmark,
  isSyncPathBookmarksAvailable: syncPathBookmarkMocks.isSyncPathBookmarksAvailable,
}));

vi.mock('./app-log', () => ({
  logInfo: logMocks.logInfo,
  logSyncError: logMocks.logSyncError,
  logWarn: logMocks.logWarn,
  sanitizeLogMessage: (value: string) => value,
}));

vi.mock('@mindwtr/core', async () => {
  const actual = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
  return {
    ...actual,
    acquireSyncRemoteMutationFence: coreMocks.acquireSyncRemoteMutationFence,
    createDropboxSyncRemoteMutationFencePort: coreMocks.createDropboxSyncRemoteMutationFencePort,
    createWebdavSyncRemoteMutationFencePort: coreMocks.createWebdavSyncRemoteMutationFencePort,
    webdavGetJson: coreMocks.webdavGetJson,
    webdavHeadFile: coreMocks.webdavHeadFile,
    webdavPutJson: coreMocks.webdavPutJson,
    cloudGetJson: coreMocks.cloudGetJson,
    cloudHeadJson: coreMocks.cloudHeadJson,
    cloudPutJson: coreMocks.cloudPutJson,
    withRetry: coreMocks.withRetry,
    flushPendingSave: coreMocks.flushPendingSave,
    performSyncCycle: coreMocks.performSyncCycle,
    webdavDeleteFile: coreMocks.webdavDeleteFile,
    cloudDeleteFile: coreMocks.cloudDeleteFile,
    getInMemoryAppDataSnapshot: coreMocks.getInMemoryAppDataSnapshot,
    useTaskStore: {
      getState: coreMocks.useTaskStoreGetState,
      setState: coreMocks.useTaskStoreSetState,
    },
  };
});

describe('mobile Dropbox sync transient retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (Platform as { OS: string }).OS = 'web';

    storeStateRef.current = {
      lastDataChangeAt: 1,
      settings: {},
      fetchData: vi.fn().mockResolvedValue(undefined),
      updateSettings: vi.fn().mockResolvedValue(undefined),
      setError: vi.fn(),
    };

    asyncStorageMocks.getItem.mockImplementation(async (key: string) => {
      const values: Record<string, string | null> = {
        '@mindwtr_sync_backend': 'cloud',
        '@mindwtr_cloud_provider': 'dropbox',
      };
      return values[key] ?? null;
    });
    asyncStorageMocks.setItem.mockResolvedValue(undefined);
    asyncStorageMocks.removeItem.mockResolvedValue(undefined);

    networkMocks.getNetworkStateAsync.mockResolvedValue({
      isConnected: true,
      isInternetReachable: true,
      isAirplaneModeEnabled: false,
    });
    networkMocks.addNetworkStateListener.mockReturnValue({ remove: vi.fn() });

    storageMocks.getData.mockResolvedValue(emptyData);
    storageMocks.saveData.mockResolvedValue(undefined);
  storageFileMocks.readSyncFile.mockResolvedValue(null);
  storageFileMocks.readSyncFileVersioned.mockResolvedValue({
    data: emptyData,
    fingerprint: 'file:v1:absent',
    source: 'empty',
    needsRepair: true,
  });
    storageFileMocks.resolveSyncFileUri.mockImplementation(async (uri: string) => uri);
    storageFileMocks.writeSyncFile.mockResolvedValue(undefined);
    syncPathBookmarkMocks.resolveSyncPathBookmark.mockResolvedValue(null);
    syncPathBookmarkMocks.isSyncPathBookmarksAvailable.mockReturnValue(false);

    attachmentSyncMocks.syncCloudAttachments.mockResolvedValue(false);
    attachmentSyncMocks.syncDropboxAttachments.mockResolvedValue(false);
    attachmentSyncMocks.syncFileAttachments.mockResolvedValue(false);
    attachmentSyncMocks.syncWebdavAttachments.mockResolvedValue(false);
    attachmentSyncMocks.cleanupAttachmentTempFiles.mockResolvedValue(undefined);
    attachmentSyncMocks.hasPendingAttachmentSyncWork.mockResolvedValue(false);

    externalCalendarMocks.getExternalCalendars.mockResolvedValue([]);
    externalCalendarMocks.saveExternalCalendars.mockResolvedValue(undefined);

    dropboxAuthMocks.forceRefreshDropboxAccessToken.mockResolvedValue('token');
    dropboxAuthMocks.forceRefreshDropboxAccessTokenForTokens.mockImplementation(async (
      _clientId: string,
      tokens: { refreshToken: string },
    ) => ({
      accessToken: 'candidate-refreshed-token',
      tokens: {
        accessToken: 'candidate-refreshed-token',
        refreshToken: tokens.refreshToken,
        expiresAt: 4_102_444_800_000,
      },
    }));
    dropboxAuthMocks.getValidDropboxAccessToken.mockResolvedValue('token');
    dropboxAuthMocks.getValidDropboxAccessTokenForTokens.mockImplementation(async (
      _clientId: string,
      tokens: { accessToken: string },
    ) => ({ accessToken: tokens.accessToken, tokens }));
    dropboxAuthMocks.isDropboxConnected.mockResolvedValue(true);

    dropboxSyncMocks.uploadDropboxAppData.mockResolvedValue({ rev: 'rev-2' });
    dropboxSyncMocks.getDropboxAppDataMetadata.mockResolvedValue(null);

    logMocks.logSyncError.mockResolvedValue(null);

    coreMocks.flushPendingSave.mockResolvedValue(undefined);
    coreMocks.createWebdavSyncRemoteMutationFencePort.mockReturnValue({ provider: 'webdav-fence-port' });
    coreMocks.createDropboxSyncRemoteMutationFencePort.mockReturnValue({ provider: 'dropbox-fence-port' });
    coreMocks.acquireSyncRemoteMutationFence.mockResolvedValue({
      assertHeld: vi.fn().mockResolvedValue(undefined),
      renew: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
    });
    // Delay-free withRetry that honors maxAttempts/shouldRetry/onRetry, so the
    // tests exercise the real retry policy without sleeping through backoff.
    coreMocks.withRetry.mockImplementation(async (
      operation: () => Promise<unknown>,
      options: {
        maxAttempts?: number;
        shouldRetry?: (error: unknown, attempt: number) => boolean;
        onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
      } = {},
    ) => {
      const maxAttempts = options.maxAttempts ?? 3;
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          return await operation();
        } catch (error) {
          lastError = error;
          if (attempt >= maxAttempts || !(options.shouldRetry ? options.shouldRetry(error, attempt) : true)) break;
          options.onRetry?.(error, attempt, 0);
        }
      }
      throw lastError;
    });
    coreMocks.getInMemoryAppDataSnapshot.mockReturnValue(emptyData);
    coreMocks.useTaskStoreGetState.mockImplementation(() => storeStateRef.current);
    coreMocks.performSyncCycle.mockImplementation(async (io: any) => {
      const local = await io.readLocal();
      const remote = await io.readRemote();
      let data = remote ?? local;
      const prepared = await io.prepareRemoteWrite?.(data);
      data = prepared ?? data;
      await io.writeLocal(data);
      await io.writeRemote(data);
      return { status: 'success', stats: emptyStats, data };
    });

    syncServiceModule.__mobileSyncTestUtils.reset();
  });

  it('retries a transient Dropbox request failure instead of skipping the sync as offline', async () => {
    dropboxSyncMocks.downloadDropboxAppData
      .mockRejectedValueOnce(new TypeError('Network request failed'))
      .mockResolvedValue({ data: emptyData, rev: 'rev-1' });

    const result = await syncServiceModule.performMobileSync();

    expect(result.success).toBe(true);
    expect(result.skipped).not.toBe('offline');
    expect(dropboxSyncMocks.downloadDropboxAppData).toHaveBeenCalledTimes(2);
    expect(logMocks.logWarn).toHaveBeenCalledWith(
      expect.stringContaining('Dropbox request failed (attempt 1)'),
      expect.objectContaining({ scope: 'sync' }),
    );
  });

  it('stops after bounded retries and records the underlying error in the offline skip log', async () => {
    dropboxSyncMocks.downloadDropboxAppData.mockRejectedValue(new TypeError('Network request failed'));

    const result = await syncServiceModule.performMobileSync();

    expect(result).toEqual({ success: true, skipped: 'offline', offlineCause: 'request' });
    expect(dropboxSyncMocks.downloadDropboxAppData).toHaveBeenCalledTimes(3);
    expect(logMocks.logInfo).toHaveBeenCalledWith(
      'Sync skipped after offline detection',
      expect.objectContaining({
        scope: 'sync',
        extra: expect.objectContaining({
          reason: 'request-error',
          error: expect.stringContaining('Network request failed'),
        }),
      }),
    );
  });

  it('does not retry non-transient Dropbox failures', async () => {
    dropboxSyncMocks.downloadDropboxAppData.mockRejectedValue(new Error('Dropbox download failed: HTTP 409'));

    const result = await syncServiceModule.performMobileSync();

    expect(result.success).toBe(false);
    expect(dropboxSyncMocks.downloadDropboxAppData).toHaveBeenCalledTimes(1);
  });

  it('uses and refreshes staged Dropbox tokens without touching persisted credentials', async () => {
    const staged = {
      tokens: {
        accessToken: 'candidate-access-token',
        refreshToken: 'candidate-refresh-token',
        expiresAt: 4_102_444_800_000,
      },
    };
    dropboxSyncMocks.downloadDropboxAppData
      .mockRejectedValueOnce(new Error('Dropbox download failed: HTTP 401'))
      .mockResolvedValue({ data: emptyData, rev: 'candidate-rev' });

    const result = await syncServiceModule.performMobileSync(undefined, {
      activationProbe: true,
      manual: true,
      configOverride: {
        backend: 'cloud',
        cloudProvider: 'dropbox',
        dropbox: staged,
      },
    });

    expect(result.success).toBe(true);
    expect(coreMocks.createDropboxSyncRemoteMutationFencePort).toHaveBeenCalledWith(
      'candidate-access-token',
      expect.any(Function),
    );
    expect(coreMocks.acquireSyncRemoteMutationFence).toHaveBeenCalledWith(
      { provider: 'dropbox-fence-port' },
      { ownerId: 'mindwtr-mobile', purpose: 'ordinary-sync' },
    );
    expect(dropboxSyncMocks.downloadDropboxAppData).toHaveBeenNthCalledWith(
      1,
      'candidate-access-token',
      expect.any(Function),
    );
    expect(dropboxSyncMocks.downloadDropboxAppData).toHaveBeenNthCalledWith(
      2,
      'candidate-refreshed-token',
      expect.any(Function),
    );
    expect(dropboxAuthMocks.getValidDropboxAccessTokenForTokens).toHaveBeenCalledWith(
      'test-app-key',
      expect.objectContaining({ accessToken: 'candidate-access-token' }),
      expect.any(Function),
    );
    expect(dropboxAuthMocks.forceRefreshDropboxAccessTokenForTokens).toHaveBeenCalledWith(
      'test-app-key',
      expect.objectContaining({ refreshToken: 'candidate-refresh-token' }),
      expect.any(Function),
    );
    expect(staged.tokens.accessToken).toBe('candidate-refreshed-token');
    expect(dropboxAuthMocks.getValidDropboxAccessToken).not.toHaveBeenCalled();
    expect(dropboxAuthMocks.forceRefreshDropboxAccessToken).not.toHaveBeenCalled();
  });

  it('passes the staged-aware token resolver to Dropbox attachment proof', async () => {
    const staged = {
      tokens: {
        accessToken: 'candidate-access-token',
        refreshToken: 'candidate-refresh-token',
        expiresAt: 4_102_444_800_000,
      },
    };
    const attachedData = {
      ...emptyData,
      tasks: [{
        id: 'task-with-attachment',
        title: 'Task',
        status: 'inbox',
        tags: [],
        contexts: [],
        attachments: [{
          id: 'candidate-attachment',
          kind: 'file',
          title: 'candidate.txt',
          uri: 'file://document/attachments/candidate.txt',
          cloudKey: 'cloudkit:candidate-attachment',
          localStatus: 'available',
          createdAt: '2026-08-03T10:00:00.000Z',
          updatedAt: '2026-08-03T10:00:00.000Z',
        }],
        createdAt: '2026-08-03T10:00:00.000Z',
        updatedAt: '2026-08-03T10:00:00.000Z',
      }],
    };
    storageMocks.getData.mockResolvedValue(attachedData);
    coreMocks.getInMemoryAppDataSnapshot.mockReturnValue(attachedData);
    dropboxAuthMocks.getValidDropboxAccessToken.mockResolvedValue('old-account-token');
    // This suite's lightweight performSyncCycle fake selects `remote ?? local`
    // instead of running the real merge. Keep the attachment in that remote
    // fixture so the assertion reaches the candidate attachment-proof seam.
    dropboxSyncMocks.downloadDropboxAppData.mockResolvedValue({ data: attachedData, rev: 'candidate-rev' });
    attachmentSyncMocks.syncDropboxAttachments.mockImplementation(async (data) => {
      const attachment = data.tasks[0]?.attachments?.[0];
      if (attachment) {
        attachment.cloudKey = 'attachments/candidate-attachment.txt';
        attachment.localStatus = 'available';
      }
      return data;
    });

    const result = await syncServiceModule.performMobileSync(undefined, {
      activationProbe: true,
      manual: true,
      configOverride: {
        backend: 'cloud',
        cloudProvider: 'dropbox',
        dropbox: staged,
      },
    });

    expect(result.success).toBe(true);
    expect(attachmentSyncMocks.syncDropboxAttachments).toHaveBeenCalledTimes(1);
    const attachmentOptions = attachmentSyncMocks.syncDropboxAttachments.mock.calls[0]?.[3] as {
      resolveAccessToken?: (forceRefresh: boolean) => Promise<string>;
    };
    expect(attachmentOptions.resolveAccessToken).toEqual(expect.any(Function));
    await expect(attachmentOptions.resolveAccessToken?.(false)).resolves.toBe('candidate-access-token');
    expect(dropboxAuthMocks.getValidDropboxAccessTokenForTokens).toHaveBeenCalled();
    expect(dropboxAuthMocks.getValidDropboxAccessToken).not.toHaveBeenCalled();
  });
});
