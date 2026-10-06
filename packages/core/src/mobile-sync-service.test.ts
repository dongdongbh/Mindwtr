import { describe, expect, it, vi } from 'vitest';

import { createMobileSyncService, type MobileSyncServiceHost } from './mobile-sync-service';
import { classifySyncFailure } from './mobile-sync-utils';
import { NativeAttachmentCleanupUnconfirmedError } from './native-attachment-cleanup';
import { LocalSyncAbort } from './sync-client-helpers';
import { performSyncCycle } from './sync';
import { createSyncEncryptionStateStore, readSyncLocationScope } from './sync-encryption-local-state';
import { createWebdavCapabilityProofStore } from './webdav-capability-proof';
import { SYNC_BACKEND_KEY, SYNC_ENCRYPTION_STATE_KEY, WEBDAV_PASSWORD_KEY, WEBDAV_URL_KEY, WEBDAV_USERNAME_KEY, CLOUD_PROVIDER_KEY } from './sync-storage-keys';
import type { AppData } from './types';

const emptyData = (): AppData => ({
  tasks: [],
  projects: [],
  sections: [],
  areas: [],
  people: [],
  settings: {},
} as AppData);

const emptyStats = {
  tasks: { mergedTotal: 0, conflicts: 0, conflictIds: [], maxClockSkewMs: 0, timestampAdjustments: 0 },
  projects: { mergedTotal: 0, conflicts: 0, conflictIds: [], maxClockSkewMs: 0, timestampAdjustments: 0 },
  sections: { mergedTotal: 0, conflicts: 0, conflictIds: [], maxClockSkewMs: 0, timestampAdjustments: 0 },
  areas: { mergedTotal: 0, conflicts: 0, conflictIds: [], maxClockSkewMs: 0, timestampAdjustments: 0 },
};

type FakeOptions = {
  values?: Record<string, string>;
  secrets?: Record<string, string>;
  offline?: boolean;
  isFossBuild?: boolean;
  dropboxAppKey?: string;
};

/** A host whose storage, network, store and transports are all in memory. The cycle's merge
 *  (`performSyncCycle`) is a stand-in: read local, read remote, keep the remote, stamp the
 *  status, write both. */
const createFakeHost = (options: FakeOptions = {}) => {
  const values = new Map(Object.entries(options.values ?? {}));
  const secrets = new Map(Object.entries(options.secrets ?? {}));
  const storage = {
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { values.delete(key); }),
  };
  const logs: Array<{ level: string; message: string; extra?: Record<string, string> }> = [];
  const syncErrors: string[] = [];
  const store = {
    lastDataChangeAt: 1,
    settings: {} as AppData['settings'],
    setError: vi.fn(),
    fetchData: vi.fn(async () => undefined),
  };
  const remote = { data: null as AppData | null, etag: 0 };
  const fenceOwners: string[] = [];
  const saved: AppData[] = [];
  const encryption = createSyncEncryptionStateStore({
    storage,
    secureConfig: {
      getSecureConfigValue: async (key) => secrets.get(key) ?? null,
      setSecureConfigValue: async (key, value) => { secrets.set(key, value); },
      deleteSecureConfigValue: async (key) => { secrets.delete(key); },
    },
    readActiveScope: async () => null,
    log: { info: () => undefined, warn: () => undefined },
  });
  const proof = createWebdavCapabilityProofStore(storage);
  const lease = { token: 'lease' };
  const host: MobileSyncServiceHost<typeof lease> = {
    storage,
    getSecureConfigValue: async (key) => secrets.get(key) ?? null,
    platform: {
      os: () => 'android',
      isFossBuild: options.isFossBuild === true,
      dropboxAppKey: () => options.dropboxAppKey ?? '',
    },
    network: {
      getState: async () => (options.offline
        ? { isConnected: false, isInternetReachable: false, isAirplaneModeEnabled: false }
        : { isConnected: true, isInternetReachable: true, isAirplaneModeEnabled: false }),
      subscribe: () => ({ remove: () => undefined }),
    },
    localData: {
      getData: async () => emptyData(),
      saveData: async (data) => { saved.push(data); },
    },
    log: {
      info: (message, context) => { logs.push({ level: 'info', message, extra: context?.extra }); },
      warn: (message, context) => { logs.push({ level: 'warn', message, extra: context?.extra }); },
      syncError: async (error, context) => {
        syncErrors.push(`${error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)} ${context.url ?? ''}`);
        return null;
      },
      sanitize: (message) => message,
    },
    externalCalendars: { load: async () => [], save: async () => undefined },
    fetch: vi.fn(async () => { throw new Error('no network in tests'); }) as unknown as typeof fetch,
    crypto: {} as MobileSyncServiceHost<unknown>['crypto'],
    encryption,
    ensureWebdavCapabilityProof: (config, probe, proofOptions) => proof.ensureWebdavCapabilityProof(config, probe, proofOptions),
    dropboxAuth: {
      isConnected: async () => true,
      getValidAccessToken: async () => 'token',
      forceRefreshAccessToken: async () => 'token',
      getValidAccessTokenForTokens: async (_clientId, tokens) => ({ accessToken: 'token', tokens }),
      forceRefreshAccessTokenForTokens: async (_clientId, tokens) => ({ accessToken: 'token', tokens }),
    },
    fileSync: {
      readVersioned: async () => ({ data: emptyData(), fingerprint: 'file:v1:absent', needsRepair: true }),
      write: async () => undefined,
      resolveUri: async (uri) => uri,
      isBookmarksAvailable: () => false,
      resolveBookmark: async () => null,
      acquireLease: async () => lease,
      revalidateLease: async () => undefined,
      releaseLease: async () => undefined,
    },
    attachments: {
      syncWebdav: async () => false,
      syncCloud: async () => false,
      syncDropbox: async () => false,
      syncFile: async () => false,
      cleanupTempFiles: async () => undefined,
      hasCompletedPresenceReconciliation: async () => false,
      hasPendingWork: async () => false,
      runCleanup: async ({ appData }) => ({ appData, shouldInvalidateFastSyncState: false }),
    },
    core: {
      useTaskStore: {
        getState: () => store as never,
        setState: vi.fn(),
      },
      flushPendingSave: async () => undefined,
      getInMemoryAppDataSnapshot: () => emptyData(),
      isSandboxMode: () => false,
      isWorkspaceTransitionActive: () => false,
      performSyncCycle: vi.fn(async (io) => {
        const local = await io.readLocal();
        const remoteData = await io.readRemote();
        const merged = remoteData ?? local;
        const data = { ...merged, settings: { ...merged.settings, lastSyncStatus: 'success' as const, lastSyncAt: '2026-09-28T12:00:00.000Z' } };
        await io.writeLocal(data);
        await io.writeRemote(data);
        return { status: 'success', stats: emptyStats, data } as never;
      }),
      withRetry: async (operation) => operation(),
      probeWebdavSyncCompatibility: vi.fn(async () => 'strong-etag' as const),
      webdavGetSyncDocument: vi.fn(async () => ({
        state: 'data' as const,
        data: remote.data,
        exists: remote.data !== null,
        strongEtag: remote.data !== null ? `"${remote.etag}"` : null,
      })) as never,
      webdavPutSyncDocument: vi.fn(async (_url: string, data: AppData) => {
        remote.data = data;
        remote.etag += 1;
        return { etag: `"${remote.etag}"` };
      }) as never,
      webdavHeadFile: vi.fn(async () => ({ exists: remote.data !== null, fingerprint: `webdav:v1:etag="${remote.etag}"`, etag: `"${remote.etag}"` })) as never,
      acquireSyncRemoteMutationFence: vi.fn(async (_port, fenceOptions) => {
        fenceOwners.push(fenceOptions.ownerId);
        return { assertHeld: async () => undefined, renew: async () => undefined, release: async () => undefined } as never;
      }),
      createWebdavSyncRemoteMutationFencePort: vi.fn(() => ({}) as never),
      createDropboxSyncRemoteMutationFencePort: vi.fn(() => ({}) as never),
    },
  };
  return { host, values, logs, syncErrors, store, remote, fenceOwners, saved };
};

const WEBDAV_VALUES = {
  [SYNC_BACKEND_KEY]: 'webdav',
  [WEBDAV_URL_KEY]: 'https://dav.example.com/Mindwtr',
  [WEBDAV_USERNAME_KEY]: 'alex',
};

describe('mobile sync service behind fake ports', () => {
  it('reports each backend configuration from the stored keys', async () => {
    const off = createMobileSyncService(createFakeHost().host);
    await expect(off.getMobileSyncConfigurationStatus()).resolves.toEqual({ backend: 'off', configured: false });

    const webdav = createMobileSyncService(createFakeHost({ values: WEBDAV_VALUES }).host);
    await expect(webdav.getMobileSyncConfigurationStatus()).resolves.toEqual({ backend: 'webdav', configured: true });

    // FOSS builds never offer Dropbox, even with a key and saved tokens.
    const foss = createMobileSyncService(createFakeHost({
      values: { [SYNC_BACKEND_KEY]: 'cloud', [CLOUD_PROVIDER_KEY]: 'dropbox' },
      isFossBuild: true,
      dropboxAppKey: 'key',
    }).host);
    await expect(foss.getMobileSyncConfigurationStatus()).resolves.toMatchObject({ backend: 'cloud', configured: false });

    // CloudKit is iOS only: a host without it reads the stored backend as off.
    const cloudkit = createMobileSyncService(createFakeHost({ values: { [SYNC_BACKEND_KEY]: 'cloudkit' } }).host);
    await expect(cloudkit.getMobileSyncConfigurationStatus()).resolves.toEqual({ backend: 'off', configured: false });
  });

  it('runs a WebDAV cycle under the mindwtr-mobile fence and publishes the status', async () => {
    const fake = createFakeHost({ values: WEBDAV_VALUES, secrets: { [WEBDAV_PASSWORD_KEY]: 'secret' } });
    const service = createMobileSyncService(fake.host);
    const activity: string[] = [];
    service.subscribeMobileSyncActivityState((state) => activity.push(state));

    const result = await service.performMobileSync(undefined, { manual: true });

    expect(result).toMatchObject({ success: true });
    // Every device on this backend shares the owner id: a new id would wait out the old lease.
    expect(fake.fenceOwners).toEqual(['mindwtr-mobile']);
    const putUrl = vi.mocked(fake.host.core!.webdavPutSyncDocument!).mock.calls[0]?.[0];
    expect(putUrl).toBe('https://dav.example.com/Mindwtr/data.json');
    expect(fake.remote.data).not.toBeNull();
    expect(fake.saved.length).toBeGreaterThan(0);
    expect(fake.values.get('@mindwtr_local_sync_status_v1')).toContain('"lastSyncStatus":"success"');
    expect(activity).toEqual(['idle', 'syncing', 'idle']);
  });

  it('reads the password through the keystore, not the plain key-value store', async () => {
    const fake = createFakeHost({ values: WEBDAV_VALUES, secrets: { [WEBDAV_PASSWORD_KEY]: 'secret' } });
    const service = createMobileSyncService(fake.host);

    await service.performMobileSync(undefined, { manual: true });

    expect(fake.host.storage.getItem).not.toHaveBeenCalledWith(WEBDAV_PASSWORD_KEY);
    const probeOptions = vi.mocked(fake.host.core!.probeWebdavSyncCompatibility!).mock.calls[0]?.[1];
    expect(probeOptions).toMatchObject({ username: 'alex', password: 'secret', timeoutMs: 30_000 });
  });

  it('keeps the stored password out of every log line, the result and the saved status when a server echoes it', async () => {
    const password = 'p@ss';
    const fake = createFakeHost({ values: WEBDAV_VALUES, secrets: { [WEBDAV_PASSWORD_KEY]: password } });
    vi.mocked(fake.host.core!.webdavGetSyncDocument!).mockRejectedValue(
      Object.assign(new Error(`403: Authentication rejected: ${password}`), { status: 403 }),
    );
    const service = createMobileSyncService(fake.host);

    const result = await service.performMobileSync(undefined, { manual: true });

    expect(result).toMatchObject({ success: false });
    const text = JSON.stringify({ result, logs: fake.logs, syncErrors: fake.syncErrors, status: fake.values.get('@mindwtr_local_sync_status_v1') });
    expect(fake.values.get('@mindwtr_local_sync_status_v1')).toContain('"lastSyncStatus":"error"');
    expect(text).toContain('Authentication rejected');
    expect(text).not.toContain(password);
  });

  it('stores no echoed password when the remote write fails after the local save (the library\'s lastSyncError too)', async () => {
    const password = 'p@ss';
    const fake = createFakeHost({ values: WEBDAV_VALUES, secrets: { [WEBDAV_PASSWORD_KEY]: password } });
    fake.host.core!.performSyncCycle = performSyncCycle;
    vi.mocked(fake.host.core!.webdavPutSyncDocument!).mockRejectedValue(new Error(`403: Authentication rejected: ${password}`));
    const service = createMobileSyncService(fake.host);

    const result = await service.performMobileSync(undefined, { manual: true });

    const stored = fake.saved.map((data) => data.settings);
    expect(stored.some((settings) => settings.lastSyncError?.includes('Authentication rejected'))).toBe(true);
    const storeUpdates = vi.mocked(fake.host.core!.useTaskStore!.setState).mock.calls.map(([update]) => (typeof update === 'function' ? update({ settings: {} } as never) : update));
    const text = JSON.stringify({ result, stored, storeUpdates, logs: fake.logs, syncErrors: fake.syncErrors, status: fake.values.get('@mindwtr_local_sync_status_v1') });
    expect(text).not.toContain(password);
  });

  it('keeps an echoed Dropbox access token out of the logs, the result and the status', async () => {
    const accessToken = 'sl.dropbox-access-echo';
    const fake = createFakeHost({ values: { [SYNC_BACKEND_KEY]: 'cloud', [CLOUD_PROVIDER_KEY]: 'dropbox' }, dropboxAppKey: 'key' });
    fake.host.dropboxAuth.getValidAccessToken = async () => accessToken;
    fake.host.core!.downloadDropboxAppData = vi.fn(async () => { throw new Error(`Dropbox rejected token ${accessToken}`); }) as never;
    fake.host.core!.getDropboxAppDataMetadata = vi.fn(async () => { throw new Error(`Dropbox rejected token ${accessToken}`); }) as never;
    const service = createMobileSyncService(fake.host);

    const result = await service.performMobileSync(undefined, { manual: true });

    expect(result).toMatchObject({ success: false });
    const text = JSON.stringify({ result, logs: fake.logs, syncErrors: fake.syncErrors, status: fake.values.get('@mindwtr_local_sync_status_v1') });
    expect(text).toContain('Dropbox rejected token');
    expect(text).not.toContain(accessToken);
  });

  it('classifies a failure on its raw text: a password "403" leaves a 403 an auth failure', async () => {
    const fake = createFakeHost({ values: WEBDAV_VALUES, secrets: { [WEBDAV_PASSWORD_KEY]: '403' } });
    vi.mocked(fake.host.core!.webdavGetSyncDocument!).mockRejectedValue(new Error('WebDAV GET failed (403)'));
    const service = createMobileSyncService(fake.host);

    const result = await service.performMobileSync(undefined, { manual: true });

    expect(result).toMatchObject({ success: false });
    const error = (result as { error?: string }).error ?? '';
    expect(error).not.toMatch(/\b403\b/);
    expect(classifySyncFailure(error)).toBe('auth');
    const status = JSON.parse(fake.values.get('@mindwtr_local_sync_status_v1') ?? '{}') as { lastSyncError?: string };
    expect(classifySyncFailure(status.lastSyncError)).toBe('auth');
  });

  it('skips a remote backend while the device is offline, without starting a cycle', async () => {
    const fake = createFakeHost({ values: WEBDAV_VALUES, offline: true });
    const service = createMobileSyncService(fake.host);

    await expect(service.performMobileSync()).resolves.toEqual({ success: true, skipped: 'offline', offlineCause: 'network' });
    expect(fake.host.core!.performSyncCycle).not.toHaveBeenCalled();
  });

  it('never saves a candidate configuration during its activation probe', async () => {
    const fake = createFakeHost({ values: { [SYNC_BACKEND_KEY]: 'off' } });
    const service = createMobileSyncService(fake.host);

    const result = await service.performMobileSync(undefined, {
      activationProbe: true,
      configOverride: {
        backend: 'webdav',
        webdav: { url: 'https://candidate.example.com/dav', username: 'bea', password: 'pw' },
      },
    });

    expect(result).toMatchObject({ success: true });
    expect(vi.mocked(fake.host.core!.webdavPutSyncDocument!).mock.calls[0]?.[0]).toBe('https://candidate.example.com/dav/data.json');
    // The settings transaction saves the configuration after the proof; the probe never does.
    const writtenKeys = fake.host.storage.setItem.mock.calls.map(([key]) => key);
    expect(writtenKeys).not.toContain(SYNC_BACKEND_KEY);
    expect(writtenKeys).not.toContain(WEBDAV_URL_KEY);
    expect(fake.values.get(SYNC_BACKEND_KEY)).toBe('off');
  });

  it('asks the candidate WebDAV folder, not the stored one, whether it holds ciphertext', async () => {
    // The stored folder is partly encrypted (an Enable cut off there); a switch to a clean folder must not be refused for it.
    const fake = createFakeHost({ values: WEBDAV_VALUES, secrets: { [WEBDAV_PASSWORD_KEY]: 'secret' } });
    fake.host.attachments.hasPendingWork = async () => true;
    fake.host.attachments.syncWebdav = vi.fn(async () => false as const);
    const probe = vi.fn(async (target?: { webdav?: { url: string } }) => (
      target?.webdav?.url.startsWith('https://candidate.example.com') ? 'plaintext' as const : 'mixed' as const));
    fake.host.encryption = { ...fake.host.encryption, probeLocationCiphertext: probe };
    const withFile = (): AppData => ({ ...emptyData(), tasks: [{ id: 't1', title: 'T', status: 'inbox', tags: [], contexts: [],
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
      attachments: [{ id: 'a1', kind: 'file', title: 'a.pdf', uri: 'file:///a.pdf', cloudKey: 'attachments/a1.pdf', localStatus: 'available',
        createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }] }] } as AppData);
    fake.host.localData.getData = async () => withFile();
    fake.host.core!.getInMemoryAppDataSnapshot = () => withFile();
    fake.host.core!.performSyncCycle = performSyncCycle;
    const service = createMobileSyncService(fake.host);

    const result = await service.performMobileSync(undefined, {
      activationProbe: true,
      configOverride: { backend: 'webdav', webdav: { url: 'https://candidate.example.com/dav', username: 'bea', password: 'pw' } },
    });

    expect(probe).toHaveBeenCalledWith({ webdav: expect.objectContaining({ url: 'https://candidate.example.com/dav/data.json' }) });
    // This fake's attachment pass downloads nothing, so the proof fails after it; the location check no longer refuses.
    expect(String(result.error ?? '')).not.toContain('PARTLY_ENCRYPTED');
  });

  it('refuses a Dropbox candidate in a FOSS build', async () => {
    const fake = createFakeHost({ isFossBuild: true, dropboxAppKey: 'key' });
    const service = createMobileSyncService(fake.host);

    const result = await service.performMobileSync(undefined, {
      manual: true,
      configOverride: { backend: 'cloud', cloudProvider: 'dropbox' },
    });

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('Dropbox sync is unavailable in this build') });
  });

  it('returns requeued for a settings proof that arrives while a cycle runs', async () => {
    const fake = createFakeHost({ values: WEBDAV_VALUES });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const performSyncCycle = vi.mocked(fake.host.core!.performSyncCycle!);
    const original = performSyncCycle.getMockImplementation()!;
    performSyncCycle.mockImplementation(async (io) => {
      await gate;
      return original(io);
    });
    const service = createMobileSyncService(fake.host);

    const active = service.performMobileSync();
    await vi.waitFor(() => expect(performSyncCycle).toHaveBeenCalled());
    const proof = await service.performMobileSync(undefined, {
      configOverride: { backend: 'webdav', webdav: { url: 'https://other.example.com', username: '', password: '' } },
    });

    expect(proof).toEqual({ success: true, skipped: 'requeued' });
    release();
    await active;
  });

  it('treats a lifecycle abort as a success and queues a follow-up', async () => {
    const fake = createFakeHost({ values: WEBDAV_VALUES });
    const service = createMobileSyncService(fake.host);
    const performSyncCycle = vi.mocked(fake.host.core!.performSyncCycle!);
    performSyncCycle.mockImplementationOnce(async () => {
      expect(service.abortMobileSync()).toBe(true);
      throw new Error('aborted');
    });

    const result = await service.performMobileSync();

    expect(result).toEqual({ success: true });
    expect(fake.logs.some((line) => line.message === 'Sync aborted by app lifecycle transition')).toBe(true);
    await service.waitForMobileSyncIdle();
    expect(performSyncCycle).toHaveBeenCalledTimes(2);
  });

  it('ends a cycle the background run abandons at its deadline as a failure, with no follow-up', async () => {
    const fake = createFakeHost({ values: WEBDAV_VALUES });
    const service = createMobileSyncService(fake.host);
    const performSyncCycle = vi.mocked(fake.host.core!.performSyncCycle!);
    performSyncCycle.mockImplementationOnce(async () => {
      expect(service.abortMobileSync('deadline')).toBe(true);
      throw new Error('aborted');
    });

    const result = await service.performMobileSync();

    expect(result.success).toBe(false);
    expect(fake.logs.some((line) => line.message === 'Sync aborted at the background run\'s deadline')).toBe(true);
    await service.waitForMobileSyncIdle();
    // The background job retries later (its failure cooldown); no unowned cycle starts after it.
    expect(performSyncCycle).toHaveBeenCalledTimes(1);
  });

  it('keeps a deadline stop through the app opening and closing during its cleanup: no follow-up, no second cycle (review S4a 1)', async () => {
    const fake = createFakeHost({ values: WEBDAV_VALUES });
    const service = createMobileSyncService(fake.host);
    const performSyncCycle = vi.mocked(fake.host.core!.performSyncCycle!);
    let joined: Promise<unknown> | null = null;
    performSyncCycle.mockImplementationOnce(async () => {
      // The background run gives up at its deadline...
      expect(service.abortMobileSync('deadline')).toBe(true);
      // ...the app opens (its resume asks for a sync, which queues behind this cycle)...
      joined = service.performMobileSync();
      // ...and closes again (its leave aborts as a lifecycle change) before the cycle has ended.
      service.abortMobileSync();
      throw new Error('aborted');
    });

    const result = await service.performMobileSync();
    await joined;

    expect(result.success).toBe(false);
    expect(fake.logs.some((line) => line.message === 'Sync aborted at the background run\'s deadline')).toBe(true);
    expect(fake.logs.some((line) => line.message === 'Sync aborted by app lifecycle transition')).toBe(false);
    await service.waitForMobileSyncIdle();
    expect(performSyncCycle).toHaveBeenCalledTimes(1);
  });

  it('never syncs a location this device holds as partly encrypted, manual or automatic', async () => {
    const fake = createFakeHost({ values: WEBDAV_VALUES, secrets: { [WEBDAV_PASSWORD_KEY]: 'secret' } });
    const scope = await readSyncLocationScope({ getItem: async (key: string) => fake.values.get(key) ?? null });
    fake.values.set(SYNC_ENCRYPTION_STATE_KEY, JSON.stringify({ state: 'off', partlyEncryptedScope: scope }));
    const service = createMobileSyncService(fake.host);

    const manual = await service.performMobileSync(undefined, { manual: true });
    expect(manual.success).toBe(false);
    expect(String(manual.error)).toContain('partly encrypted');
    expect(classifySyncFailure(manual.error)).toBe('encryption');
    expect(fake.remote.data).toBeNull();
    expect(vi.mocked(fake.host.core!.webdavPutSyncDocument!)).not.toHaveBeenCalled();

    // Another location syncs as ever.
    fake.values.set(WEBDAV_URL_KEY, 'https://elsewhere.example.com/Mindwtr');
    service.clearMobileSyncConfigCache();
    const elsewhere = await service.performMobileSync(undefined, { manual: true });
    expect(elsewhere, String(elsewhere.error)).toMatchObject({ success: true });
  });

  it('refuses a plaintext attachment pass into a location whose attachments hold ciphertext, and remembers the location', async () => {
    const fake = createFakeHost({ values: WEBDAV_VALUES, secrets: { [WEBDAV_PASSWORD_KEY]: 'secret' } });
    const attachmentPasses = vi.fn(async () => false as const);
    fake.host.attachments.hasPendingWork = async () => true;
    fake.host.attachments.hasCompletedPresenceReconciliation = async () => true;
    fake.host.attachments.syncWebdav = attachmentPasses;
    const probe = vi.fn(async () => 'mixed' as const);
    fake.host.encryption = { ...fake.host.encryption, probeLocationCiphertext: probe };
    const service = createMobileSyncService(fake.host);

    const result = await service.performMobileSync(undefined, { manual: true });

    expect(probe).toHaveBeenCalled();
    expect(attachmentPasses).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('partly encrypted');
    const scope = await readSyncLocationScope({ getItem: async (key: string) => fake.values.get(key) ?? null });
    expect(JSON.parse(fake.values.get(SYNC_ENCRYPTION_STATE_KEY)!)).toEqual({ state: 'off', partlyEncryptedScope: scope });
  });

  it('runs the attachment pass a deferred pre-sync phase owes, even when the document is unchanged', async () => {
    // A download the last process never finished (the native installer's boot recovery rolled it back): the record holds a
    // cloudKey and no local file. On a location this device has no fast-sync record or presence stamp for, the pre-sync
    // phase defers (encryption-recheck), and the unchanged read check then skipped the post-merge pass as well, so even
    // Sync now never downloaded it.
    const fake = createFakeHost({ values: WEBDAV_VALUES, secrets: { [WEBDAV_PASSWORD_KEY]: 'secret' } });
    const attachmentPasses = vi.fn(async () => false as const);
    fake.host.attachments.hasPendingWork = async () => true;
    fake.host.attachments.syncWebdav = attachmentPasses;
    fake.host.encryption = { ...fake.host.encryption, probeLocationCiphertext: async () => 'plaintext' as const };
    const service = createMobileSyncService(fake.host);
    await expect(service.performMobileSync(undefined, { manual: true })).resolves.toMatchObject({ success: true });
    // No record of a completed cycle here (as after attachment cleanup invalidates it): the posture is unestablished again.
    fake.values.delete('@mindwtr_fast_sync_state_v1');
    attachmentPasses.mockClear();

    const result = await service.performMobileSync(undefined, { manual: true });

    expect(result.success).toBe(true);
    expect(fake.logs.some((line) => line.message.includes('Attachment pre-sync skipped') && line.extra?.reason === 'encryption-recheck')).toBe(true);
    expect(attachmentPasses).toHaveBeenCalled();
  });

  it.each([false, true])('quarantines queued syncs and idle waiters after cleanup refusal (unsubscribe throws: %s)', async (unsubscribeThrows) => {
    const fake = createFakeHost({ values: WEBDAV_VALUES });
    fake.host.core!.performSyncCycle = vi.fn(performSyncCycle);
    fake.remote.data = {
      ...emptyData(),
      tasks: [{ id: 'remote-task', title: 'Remote', status: 'inbox', tags: [], contexts: [],
        createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }],
    };
    const fatal = new NativeAttachmentCleanupUnconfirmedError();
    const remove = vi.fn(() => { if (unsubscribeThrows) throw new Error('unsubscribe unavailable'); });
    fake.host.network.subscribe = vi.fn(() => ({ remove }));
    const fence = { assertHeld: vi.fn(async () => undefined), renew: vi.fn(async () => undefined), release: vi.fn(async () => undefined) };
    vi.mocked(fake.host.core!.acquireSyncRemoteMutationFence!).mockResolvedValue(fence as never);
    // These are the ports this real shared cycle uses: after refusal only the
    // local network subscription's removal is allowed, even if it throws.
    const ports = [
      fake.host.storage.getItem, fake.host.storage.setItem, fake.host.storage.removeItem,
      vi.spyOn(fake.host, 'getSecureConfigValue'),
      vi.spyOn(fake.host.platform, 'os'), vi.spyOn(fake.host.platform, 'dropboxAppKey'),
      vi.spyOn(fake.host.network, 'getState'), fake.host.network.subscribe,
      vi.spyOn(fake.host.localData, 'getData'), vi.spyOn(fake.host.localData, 'saveData'),
      vi.spyOn(fake.host.log, 'info'), vi.spyOn(fake.host.log, 'warn'),
      vi.spyOn(fake.host.log, 'syncError'), vi.spyOn(fake.host.log, 'sanitize'),
      vi.spyOn(fake.host.externalCalendars, 'load'), vi.spyOn(fake.host.externalCalendars, 'save'),
      vi.spyOn(fake.host.encryption, 'loadSyncEncryptionLocalState'),
      vi.spyOn(fake.host.encryption, 'logSyncEncryptionEvent'),
      vi.spyOn(fake.host.core!, 'isSandboxMode'), vi.spyOn(fake.host.core!, 'isWorkspaceTransitionActive'),
      vi.spyOn(fake.host.core!.useTaskStore!, 'getState'), fake.host.core!.useTaskStore!.setState,
      fake.store.setError, fake.store.fetchData, vi.spyOn(fake.host.core!, 'flushPendingSave'),
      vi.spyOn(fake.host.core!, 'getInMemoryAppDataSnapshot'), fake.host.core!.performSyncCycle,
      fake.host.core!.webdavGetSyncDocument, fake.host.core!.webdavPutSyncDocument, fake.host.core!.webdavHeadFile,
      fake.host.core!.probeWebdavSyncCompatibility, fake.host.core!.acquireSyncRemoteMutationFence,
      fake.host.fetch, fence.assertHeld, fence.renew, fence.release,
      vi.spyOn(fake.host.attachments, 'syncWebdav'), vi.spyOn(fake.host.attachments, 'cleanupTempFiles'),
      vi.spyOn(fake.host.attachments, 'hasPendingWork'), vi.spyOn(fake.host.attachments, 'hasCompletedPresenceReconciliation'),
      vi.spyOn(fake.host.fileSync, 'releaseLease'),
    ];
    const calls = () => ports.map((port) => vi.mocked(port!).mock.calls.length);
    const durableAndLogs = () => JSON.stringify({
      values: [...fake.values], saved: fake.saved, remote: fake.remote, settings: fake.store.settings,
      logs: fake.logs, syncErrors: fake.syncErrors,
    });
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let boundaryCalls: number[] = [];
    let boundaryState = '';
    fake.host.attachments.runCleanup = vi.fn(async () => {
      entered();
      await gate;
      boundaryCalls = calls();
      boundaryState = durableAndLogs();
      throw fatal;
    });
    const service = createMobileSyncService(fake.host);
    const activity: string[] = [];
    service.subscribeMobileSyncActivityState((state) => activity.push(state));
    const active = service.performMobileSync(undefined, { manual: true });
    await paused;
    expect(fake.saved.some((data) => data.tasks.some((task) => task.id === 'remote-task'))).toBe(true);
    const queued = service.performMobileSync(undefined, { manual: true });
    const waiter = service.waitForMobileSyncIdle();
    // This API reports requeue before refusal, but its late rejection callback
    // must not write a diagnostic once cleanup owns the host.
    await expect(service.performMobileSync(undefined, {
      configOverride: { backend: 'webdav', webdav: { url: 'https://other.example.com', username: '', password: '' } },
    })).resolves.toEqual({ success: true, skipped: 'requeued' });
    const settled = Promise.allSettled([active, queued, waiter]);
    vi.useFakeTimers();
    try {
      release();
      const outcomes = await settled;
      for (const outcome of outcomes) {
        expect(outcome.status).toBe('rejected');
        if (outcome.status === 'rejected') expect(outcome.reason).toBe(fatal);
      }
      expect(remove).toHaveBeenCalledTimes(1);
      expect(fence.release).not.toHaveBeenCalled();
      expect(activity).toEqual(['idle', 'syncing']);
      expect(service.abortMobileSync()).toBe(false);
      service.clearMobileSyncConfigCache();
      await expect(service.performMobileSync()).rejects.toBe(fatal);
      await expect(service.getMobileSyncConfigurationStatus()).rejects.toBe(fatal);
      await expect(service.waitForMobileSyncIdle()).rejects.toBe(fatal);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(calls()).toEqual(boundaryCalls);
      expect(durableAndLogs()).toBe(boundaryState);
      expect(fake.host.core!.performSyncCycle).toHaveBeenCalledTimes(1);
      expect(fake.host.attachments.runCleanup).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
    fake.host.network.subscribe = () => ({ remove: () => undefined });
    fake.host.attachments.runCleanup = async ({ appData }) => ({ appData, shouldInvalidateFastSyncState: false });
    // Only host recreation supplies a fresh service. Clearing the cache above
    // did not release the retained fatal owner in the original instance.
    const fresh = createMobileSyncService(fake.host);
    await expect(fresh.performMobileSync(undefined, { manual: true })).resolves.toMatchObject({ success: true });
    expect(fence.release).toHaveBeenCalledTimes(1);
  });

  it('withholds an acquired File Sync lease after fatal cleanup and preserves earlier merge writes', async () => {
    const fake = createFakeHost();
    const fatal = new NativeAttachmentCleanupUnconfirmedError();
    const acquire = vi.spyOn(fake.host.fileSync, 'acquireLease');
    const release = vi.spyOn(fake.host.fileSync, 'releaseLease');
    const fileWrite = vi.spyOn(fake.host.fileSync, 'write');
    let savedAtRefusal = '';
    fake.host.attachments.runCleanup = vi.fn(async () => {
      savedAtRefusal = JSON.stringify({ saved: fake.saved, values: [...fake.values], logs: fake.logs });
      throw fatal;
    });
    const service = createMobileSyncService(fake.host);
    await expect(service.performMobileSync(undefined, {
      manual: true, configOverride: { backend: 'file', syncPath: 'file:///sync/data.json' },
    })).rejects.toBe(fatal);
    await expect(service.waitForMobileSyncIdle()).rejects.toBe(fatal);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(fileWrite).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    expect(fake.saved.length).toBeGreaterThan(0);
    expect(JSON.stringify({ saved: fake.saved, values: [...fake.values], logs: fake.logs })).toBe(savedAtRefusal);
    expect(service.abortMobileSync()).toBe(false);
  });

  it('does not log or announce idle when a scheduled queued cycle refuses cleanup', async () => {
    const fake = createFakeHost({ values: WEBDAV_VALUES });
    const fatal = new NativeAttachmentCleanupUnconfirmedError();
    const remove = vi.fn();
    fake.host.network.subscribe = () => ({ remove });
    const fenceRelease = vi.fn(async () => undefined);
    vi.mocked(fake.host.core!.acquireSyncRemoteMutationFence!).mockResolvedValue({
      assertHeld: async () => undefined, renew: async () => undefined, release: fenceRelease,
    } as never);
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let boundaryState = '';
    const state = () => JSON.stringify({ saved: fake.saved, values: [...fake.values], logs: fake.logs, syncErrors: fake.syncErrors });
    fake.host.attachments.runCleanup = vi.fn()
      .mockImplementationOnce(async ({ appData }) => {
        entered();
        await gate;
        return { appData, shouldInvalidateFastSyncState: false };
      })
      .mockImplementationOnce(async () => {
        boundaryState = state();
        throw fatal;
      });
    const service = createMobileSyncService(fake.host);
    const activity: string[] = [];
    service.subscribeMobileSyncActivityState((value) => activity.push(value));
    const active = service.performMobileSync(undefined, { manual: true });
    await paused;
    const queued = service.performMobileSync(undefined, { manual: true });
    const idleResult = service.waitForMobileSyncIdle().then(() => 'idle', (error: unknown) => error);
    vi.useFakeTimers();
    try {
      release();
      await vi.advanceTimersByTimeAsync(20);
      await expect(active).resolves.toMatchObject({ success: true });
      await expect(queued).resolves.toMatchObject({ success: true });
      // A real remote edit prevents the read-check optimization from ending
      // the queued cycle before its cleanup hook is reached.
      fake.remote.data = { ...fake.remote.data!, tasks: [{
        id: 'queued-remote-task', title: 'Changed remotely', status: 'inbox', tags: [], contexts: [],
        createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
      }] };
      fake.remote.etag += 1;
      await vi.advanceTimersByTimeAsync(1_100);
      expect(await idleResult).toBe(fatal);
      expect(fake.host.attachments.runCleanup).toHaveBeenCalledTimes(2);
      expect(fake.host.core!.performSyncCycle).toHaveBeenCalledTimes(2);
      expect(remove).toHaveBeenCalledTimes(2);
      expect(fenceRelease).toHaveBeenCalledTimes(1);
      expect(activity).toEqual(['idle', 'syncing']);
      expect(boundaryState).not.toBe('');
      await vi.advanceTimersByTimeAsync(300_000);
      expect(state()).toBe(boundaryState);
      expect(fake.host.core!.performSyncCycle).toHaveBeenCalledTimes(2);
      await expect(service.performMobileSync()).rejects.toBe(fatal);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['ordinary-same-name', 'local-abort'])('keeps %s cleanup failures recoverable and releases the File Sync lease', async (kind) => {
    const fake = createFakeHost();
    const error = kind === 'local-abort'
      ? new LocalSyncAbort()
      : Object.assign(new Error('ordinary cleanup error'), { name: 'NativeAttachmentCleanupUnconfirmedError' });
    const release = vi.spyOn(fake.host.fileSync, 'releaseLease');
    fake.host.attachments.runCleanup = vi.fn()
      .mockRejectedValueOnce(error)
      .mockImplementation(async ({ appData }) => ({ appData, shouldInvalidateFastSyncState: false }));
    const service = createMobileSyncService(fake.host);
    const activity: string[] = [];
    service.subscribeMobileSyncActivityState((value) => activity.push(value));
    const options = { manual: true, configOverride: { backend: 'file' as const, syncPath: 'file:///sync/data.json' } };

    const result = await service.performMobileSync(undefined, options);

    expect(result).toMatchObject(kind === 'local-abort' ? { success: true, skipped: 'requeued' } : { success: false });
    await expect(service.waitForMobileSyncIdle()).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledTimes(1);
    expect(activity).toEqual(['idle', 'syncing', 'idle']);
    expect(fake.logs.some((line) => line.message === (kind === 'local-abort' ? 'Sync cycle requeued' : 'Sync failed'))).toBe(true);
    await expect(service.performMobileSync(undefined, options)).resolves.toMatchObject({ success: true });
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('does nothing in sandbox mode', async () => {
    const fake = createFakeHost({ values: WEBDAV_VALUES });
    fake.host.core!.isSandboxMode = () => true;
    const service = createMobileSyncService(fake.host);

    await expect(service.performMobileSync()).resolves.toEqual({ success: true, skipped: 'disabled' });
    await expect(service.getMobileSyncConfigurationStatus()).resolves.toEqual({ backend: 'off', configured: false });
    expect(fake.host.storage.getItem).not.toHaveBeenCalled();
  });
});
