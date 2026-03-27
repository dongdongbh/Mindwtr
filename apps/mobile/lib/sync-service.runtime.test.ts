import { beforeEach, describe, expect, it, vi } from 'vitest';

const emptyData = {
  tasks: [],
  projects: [],
  sections: [],
  areas: [],
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
}));

const externalCalendarMocks = vi.hoisted(() => ({
  getExternalCalendars: vi.fn(),
  saveExternalCalendars: vi.fn(),
}));

const dropboxAuthMocks = vi.hoisted(() => ({
  forceRefreshDropboxAccessToken: vi.fn(),
  getValidDropboxAccessToken: vi.fn(),
}));

const dropboxSyncMocks = vi.hoisted(() => ({
  deleteDropboxFile: vi.fn(),
  downloadDropboxAppData: vi.fn(),
  uploadDropboxAppData: vi.fn(),
}));

const storageFileMocks = vi.hoisted(() => ({
  readSyncFile: vi.fn(),
  resolveSyncFileUri: vi.fn(),
  writeSyncFile: vi.fn(),
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
  webdavGetJson: vi.fn(),
  webdavPutJson: vi.fn(),
  cloudGetJson: vi.fn(),
  cloudPutJson: vi.fn(),
  withRetry: vi.fn(),
  flushPendingSave: vi.fn(),
  performSyncCycle: vi.fn(),
  webdavDeleteFile: vi.fn(),
  cloudDeleteFile: vi.fn(),
  getInMemoryAppDataSnapshot: vi.fn(),
  useTaskStoreGetState: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: asyncStorageMocks.getItem,
    setItem: asyncStorageMocks.setItem,
    removeItem: asyncStorageMocks.removeItem,
  },
}));

vi.mock('expo-constants', () => ({
  default: {
    expoConfig: {
      extra: {
        isFossBuild: true,
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
}));

vi.mock('./external-calendar', () => ({
  getExternalCalendars: externalCalendarMocks.getExternalCalendars,
  saveExternalCalendars: externalCalendarMocks.saveExternalCalendars,
}));

vi.mock('./dropbox-auth', () => ({
  forceRefreshDropboxAccessToken: dropboxAuthMocks.forceRefreshDropboxAccessToken,
  getValidDropboxAccessToken: dropboxAuthMocks.getValidDropboxAccessToken,
}));

vi.mock('./dropbox-sync', () => ({
  DropboxConflictError: class DropboxConflictError extends Error {},
  DropboxUnauthorizedError: class DropboxUnauthorizedError extends Error {},
  deleteDropboxFile: dropboxSyncMocks.deleteDropboxFile,
  downloadDropboxAppData: dropboxSyncMocks.downloadDropboxAppData,
  uploadDropboxAppData: dropboxSyncMocks.uploadDropboxAppData,
}));

vi.mock('./storage-file', () => ({
  readSyncFile: storageFileMocks.readSyncFile,
  resolveSyncFileUri: storageFileMocks.resolveSyncFileUri,
  writeSyncFile: storageFileMocks.writeSyncFile,
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
    webdavGetJson: coreMocks.webdavGetJson,
    webdavPutJson: coreMocks.webdavPutJson,
    cloudGetJson: coreMocks.cloudGetJson,
    cloudPutJson: coreMocks.cloudPutJson,
    withRetry: coreMocks.withRetry,
    flushPendingSave: coreMocks.flushPendingSave,
    performSyncCycle: coreMocks.performSyncCycle,
    webdavDeleteFile: coreMocks.webdavDeleteFile,
    cloudDeleteFile: coreMocks.cloudDeleteFile,
    getInMemoryAppDataSnapshot: coreMocks.getInMemoryAppDataSnapshot,
    useTaskStore: {
      getState: coreMocks.useTaskStoreGetState,
    },
  };
});

const syncServiceModulePromise = import('./sync-service');

describe('mobile sync-service runtime', () => {
  beforeEach(async () => {
    vi.clearAllMocks();

    storeStateRef.current = {
      lastDataChangeAt: 1,
      settings: {},
      fetchData: vi.fn().mockResolvedValue(undefined),
      updateSettings: vi.fn().mockResolvedValue(undefined),
      setError: vi.fn(),
    };

    asyncStorageMocks.getItem.mockImplementation(async (key: string) => {
      const values: Record<string, string | null> = {
        '@mindwtr_sync_backend': 'webdav',
        '@mindwtr_webdav_url': 'https://sync.example.com/data.json',
        '@mindwtr_webdav_username': 'user',
        '@mindwtr_webdav_password': 'pass',
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

    attachmentSyncMocks.syncCloudAttachments.mockResolvedValue(false);
    attachmentSyncMocks.syncDropboxAttachments.mockResolvedValue(false);
    attachmentSyncMocks.syncFileAttachments.mockResolvedValue(false);
    attachmentSyncMocks.syncWebdavAttachments.mockResolvedValue(false);
    attachmentSyncMocks.cleanupAttachmentTempFiles.mockResolvedValue(undefined);

    externalCalendarMocks.getExternalCalendars.mockResolvedValue([]);
    externalCalendarMocks.saveExternalCalendars.mockResolvedValue(undefined);

    dropboxAuthMocks.forceRefreshDropboxAccessToken.mockResolvedValue('token');
    dropboxAuthMocks.getValidDropboxAccessToken.mockResolvedValue('token');

    logMocks.logSyncError.mockResolvedValue(null);

    coreMocks.flushPendingSave.mockResolvedValue(undefined);
    coreMocks.withRetry.mockImplementation(async (operation: () => Promise<unknown>) => await operation());
    coreMocks.getInMemoryAppDataSnapshot.mockReturnValue(emptyData);
    coreMocks.useTaskStoreGetState.mockImplementation(() => storeStateRef.current);
    coreMocks.performSyncCycle.mockImplementation(async (io: any) => {
      const local = await io.readLocal();
      const remote = await io.readRemote();
      const data = remote ?? local;
      await io.writeLocal(data);
      await io.writeRemote(data);
      return { status: 'success', stats: emptyStats, data };
    });

    const syncServiceModule = await syncServiceModulePromise;
    syncServiceModule.__mobileSyncTestUtils.reset();
  });

  it('pauses repeated WebDAV sync attempts after a rate limit response', async () => {
    const rateLimitError = Object.assign(new Error('WebDAV GET failed (429): Too Many Requests'), { status: 429 });
    coreMocks.webdavGetJson.mockRejectedValue(rateLimitError);

    const syncServiceModule = await syncServiceModulePromise;
    const first = await syncServiceModule.performMobileSync();
    expect(first.success).toBe(false);
    expect(first.error).toContain('WebDAV rate limited. Sync paused briefly; try again in about a minute.');
    expect(coreMocks.webdavGetJson).toHaveBeenCalledTimes(1);
    expect(syncServiceModule.__mobileSyncTestUtils.getWebdavSyncBlockedUntil()).toBeGreaterThan(Date.now());

    coreMocks.webdavGetJson.mockResolvedValue(emptyData);

    const second = await syncServiceModule.performMobileSync();
    expect(second.success).toBe(false);
    expect(second.error).toContain('WebDAV rate limited. Sync paused briefly; try again in about a minute.');
    expect(coreMocks.webdavGetJson).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('skips remote sync before start when the device is offline', async () => {
    networkMocks.getNetworkStateAsync.mockResolvedValue({
      isConnected: false,
      isInternetReachable: false,
      isAirplaneModeEnabled: false,
    });

    const syncServiceModule = await syncServiceModulePromise;
    const result = await syncServiceModule.performMobileSync();

    expect(result).toEqual({ success: true, skipped: 'offline' });
    expect(coreMocks.performSyncCycle).not.toHaveBeenCalled();
    expect(coreMocks.webdavGetJson).not.toHaveBeenCalled();
    expect(storeStateRef.current.updateSettings).not.toHaveBeenCalled();
    expect(logMocks.logSyncError).not.toHaveBeenCalled();
  });

  it('skips remote sync when the request fails with an offline network error', async () => {
    coreMocks.webdavGetJson.mockRejectedValue(new TypeError('Network request failed'));

    const syncServiceModule = await syncServiceModulePromise;
    const result = await syncServiceModule.performMobileSync();

    expect(result).toEqual({ success: true, skipped: 'offline' });
    expect(coreMocks.performSyncCycle).toHaveBeenCalledTimes(1);
    expect(coreMocks.webdavGetJson).toHaveBeenCalledTimes(1);
    expect(storeStateRef.current.updateSettings).not.toHaveBeenCalled();
    expect(logMocks.logSyncError).not.toHaveBeenCalled();
  });

  it('clears stale sync stats when a sync error occurs after prior conflicts', async () => {
    storeStateRef.current = {
      ...storeStateRef.current,
      settings: {
        lastSyncStatus: 'conflict',
        lastSyncStats: {
          tasks: { mergedTotal: 1, conflicts: 3, conflictIds: ['task-1'], maxClockSkewMs: 0, timestampAdjustments: 0 },
          projects: { mergedTotal: 0, conflicts: 0, conflictIds: [], maxClockSkewMs: 0, timestampAdjustments: 0 },
          sections: { mergedTotal: 0, conflicts: 0, conflictIds: [], maxClockSkewMs: 0, timestampAdjustments: 0 },
          areas: { mergedTotal: 0, conflicts: 0, conflictIds: [], maxClockSkewMs: 0, timestampAdjustments: 0 },
        },
      },
      updateSettings: vi.fn().mockResolvedValue(undefined),
    };
    coreMocks.webdavGetJson.mockRejectedValue(new Error('sync read failed'));

    const syncServiceModule = await syncServiceModulePromise;
    const result = await syncServiceModule.performMobileSync();

    expect(result.success).toBe(false);
    expect(coreMocks.performSyncCycle).toHaveBeenCalledTimes(1);
    expect(storeStateRef.current.updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      lastSyncStatus: 'error',
      lastSyncStats: undefined,
    }));
  });

  it('reports sync activity state while a sync cycle is in flight', async () => {
    let releaseSync!: () => void;
    const syncGate = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });

    coreMocks.webdavGetJson.mockResolvedValue(emptyData);
    coreMocks.performSyncCycle.mockImplementation(async (io: any) => {
      await io.readLocal();
      await io.readRemote();
      await syncGate;
      return { status: 'success', stats: emptyStats, data: emptyData };
    });

    const syncServiceModule = await syncServiceModulePromise;
    const states: string[] = [];
    const unsubscribe = syncServiceModule.subscribeMobileSyncActivityState((state) => {
      states.push(state);
    });

    const syncPromise = syncServiceModule.performMobileSync();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(states).toContain('syncing');

    releaseSync();
    await syncPromise;
    unsubscribe();

    expect(states[0]).toBe('idle');
    expect(states.at(-1)).toBe('idle');
  });
});
