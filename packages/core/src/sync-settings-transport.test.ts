import { describe, expect, it, vi } from 'vitest';
import { NativeAttachmentCleanupUnconfirmedError } from './native-attachment-cleanup';
import { createSyncSettingsTransport, SyncSettingsWriteError, type SyncSettingsSyncResult, type SyncSettingsToast, type SyncSettingsTransportHost } from './sync-settings-transport';
import { SYNC_BACKEND_KEY, SYNC_PATH_BOOKMARK_KEY, SYNC_PATH_KEY, WEBDAV_PASSWORD_KEY, WEBDAV_URL_KEY, WEBDAV_USERNAME_KEY } from './sync-storage-keys';

const picked = { value: null as unknown };

vi.mock('./webdav', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./webdav')>()),
    probeWebdavSyncCompatibility: async () => 'strong-etag',
}));

/** A transport over an in-memory device, with core's own rules (no host overrides). */
function setup(syncResults: SyncSettingsSyncResult[]) {
    const storage = new Map<string, string>();
    const secrets = new Map<string, string>();
    const toasts: SyncSettingsToast[] = [];
    const syncs: unknown[] = [];
    const t = (key: string) => key;
    const host: SyncSettingsTransportHost = {
        params: () => ({
            dropboxAppKey: '', dropboxConfigured: false, isExpoGo: false, isFossBuild: false,
            getCloudKitStatusDetails: () => ({ helpText: '', syncEnabled: false }),
            getSyncFailureToastMessage: (error) => `failed: ${error instanceof Error ? error.message : String(error)}`,
            lastSyncStats: null, lastSyncStatus: undefined, tr: t, t,
            resetSyncStatusForBackendSwitch: () => undefined,
            showSettingsErrorToast: (title, message, durationMs) => toasts.push({ title, message, tone: 'error', durationMs }),
            showSettingsWarning: (title, message, durationMs) => toasts.push({ title, message, tone: 'warning', durationMs }),
            showToast: (toast) => toasts.push(toast),
            supportsNativeICloudSync: false,
        }),
        storage: {
            multiGet: async (keys) => keys.map((key) => [key, storage.get(key) ?? null] as const),
            setItem: async (key, value) => { storage.set(key, value); },
            multiSet: async (entries) => { for (const [key, value] of entries) storage.set(key, value); },
            removeItem: async (key) => { storage.delete(key); },
        },
        secrets: {
            get: async (key) => secrets.get(key) ?? null,
            set: async (key, value) => { secrets.set(key, value); },
            delete: async (key) => { secrets.delete(key); },
        },
        platform: { os: () => 'android' },
        logInfo: () => undefined,
        logSettingsError: () => undefined,
        performSync: async (_path, options) => {
            syncs.push(options);
            return syncResults.shift() ?? { success: true };
        },
        clearSyncConfigCache: () => undefined,
        reconcileBackgroundSync: async () => undefined,
        pickSyncFolder: async () => picked.value,
        getCloudKitAccountStatus: async () => 'unknown',
        rememberWebdavCapabilityProof: async () => undefined,
        encryption: { getStatus: async () => ({ state: 'off' }), getIncompleteTransition: async () => null },
        dropbox: {} as SyncSettingsTransportHost['dropbox'],
        core: { addBreadcrumb: () => undefined },
    };
    return { transport: createSyncSettingsTransport(host), host, storage, secrets, toasts, syncs };
}

const fields = { allowInsecureHttp: false, password: 'secret', url: ' https://dav.example.com/ ', username: 'alice' };

describe('sync settings transport', () => {
    it.each(['verification', 'first sync', 'sync now'] as const)('propagates fatal cleanup during WebDAV %s without any later callback', async (phase) => {
        const { transport, host, storage, secrets, toasts } = setup([]);
        if (phase === 'sync now') {
            storage.set(SYNC_BACKEND_KEY, 'webdav');
            storage.set(WEBDAV_URL_KEY, fields.url.trim());
            storage.set(WEBDAV_USERNAME_KEY, fields.username);
            secrets.set(WEBDAV_PASSWORD_KEY, fields.password);
        }
        await transport.load().done;
        const params = host.params();
        host.params = () => params;
        const changed = vi.fn();
        transport.subscribe(changed);
        const ports = [
            vi.spyOn(host.storage, 'multiGet'), vi.spyOn(host.storage, 'setItem'),
            vi.spyOn(host.storage, 'multiSet'), vi.spyOn(host.storage, 'removeItem'),
            vi.spyOn(host.secrets, 'get'), vi.spyOn(host.secrets, 'set'), vi.spyOn(host.secrets, 'delete'),
            vi.spyOn(host, 'logInfo'), vi.spyOn(host, 'logSettingsError'),
            vi.spyOn(host, 'clearSyncConfigCache'), vi.spyOn(host, 'reconcileBackgroundSync'),
            vi.spyOn(host, 'rememberWebdavCapabilityProof'),
            vi.spyOn(host.encryption, 'getStatus'), vi.spyOn(host.encryption, 'getIncompleteTransition'),
            vi.spyOn(params, 'getSyncFailureToastMessage'), changed,
        ];
        const fatal = new NativeAttachmentCleanupUnconfirmedError();
        let calls = 0;
        let at!: { counts: number[]; storage: [string, string][]; secrets: [string, string][]; toasts: SyncSettingsToast[] };
        host.performSync = async () => {
            if (phase === 'first sync' && calls++ === 0) return { success: true };
            at = { counts: ports.map((port) => port.mock.calls.length), storage: [...storage], secrets: [...secrets], toasts: [...toasts] };
            throw fatal;
        };
        const result = phase === 'sync now'
            ? transport.handleSync({ backend: 'webdav', webdav: { ...fields, url: fields.url.trim() } })
            : transport.handleSaveWebDavSettings(fields);
        await expect(result).rejects.toBe(fatal);
        expect(ports.map((port) => port.mock.calls.length)).toEqual(at.counts);
        expect([...storage]).toEqual(at.storage);
        expect([...secrets]).toEqual(at.secrets);
        expect(toasts).toEqual(at.toasts);
        expect(transport.getState().isSyncing).toBe(true);
        expect(storage.get(SYNC_BACKEND_KEY)).toBe(phase === 'verification' ? undefined : 'webdav');
        expect(secrets.get(WEBDAV_PASSWORD_KEY)).toBe(phase === 'verification' ? undefined : fields.password);
    });

    it('handles an ordinary error with the fatal class name through the normal toast and state reset', async () => {
        const { transport, host, toasts } = setup([]);
        await transport.load().done;
        const ordinary = Object.assign(new Error('ordinary sync failure'), { name: 'NativeAttachmentCleanupUnconfirmedError' });
        host.performSync = async () => { throw ordinary; };
        await transport.handleSaveWebDavSettings(fields);
        expect(toasts).toEqual([{ title: 'settings.syncMobile.error', message: 'failed: ordinary sync failure', tone: 'error', durationMs: undefined }]);
        expect(transport.getState().isSyncing).toBe(false);
    });

    it.each(['fatal', 'ordinary'] as const)('handles a held background-reconcile %s rejection after the first sync refuses', async (kind) => {
        const { transport, host, storage, secrets } = setup([]);
        await transport.load().done;
        let rejectReconcile!: (error: Error) => void;
        host.reconcileBackgroundSync = () => new Promise<void>((_resolve, reject) => { rejectReconcile = reject; });
        const logged = vi.spyOn(host, 'logSettingsError');
        const fatal = new NativeAttachmentCleanupUnconfirmedError();
        let calls = 0;
        host.performSync = async () => {
            if (calls++ === 0) return { success: true };
            throw fatal;
        };
        await expect(transport.handleSaveWebDavSettings(fields)).rejects.toBe(fatal);
        expect(rejectReconcile).toBeDefined();
        expect(storage.get(SYNC_BACKEND_KEY)).toBe('webdav');
        expect(secrets.get(WEBDAV_PASSWORD_KEY)).toBe(fields.password);
        expect(logged).not.toHaveBeenCalled();
        const failure = kind === 'fatal' ? fatal : new Error('ordinary reconciliation failure');
        rejectReconcile(failure);
        await Promise.resolve();
        if (kind === 'fatal') expect(logged).not.toHaveBeenCalled();
        else expect(logged).toHaveBeenCalledWith(expect.objectContaining({ name: 'Error', message: failure.message }));
    });

    it('never saves a configuration whose first round trip failed', async () => {
        const { transport, storage, secrets, toasts } = setup([{ success: false, error: 'HTTP 500' }]);
        await transport.load().done;
        await transport.handleSaveWebDavSettings(fields);
        expect(storage.get(SYNC_BACKEND_KEY)).toBeUndefined();
        expect(storage.get(WEBDAV_URL_KEY)).toBeUndefined();
        expect(secrets.size).toBe(0);
        expect(toasts).toEqual([{ title: 'settings.syncMobile.error', message: 'failed: HTTP 500', tone: 'error', durationMs: undefined }]);
        // The form keeps the staged choice until the screen closes.
        expect(transport.getState()).toMatchObject({ syncBackend: 'webdav', webdavUrl: 'https://dav.example.com/', isSyncing: false });
        expect(transport.getProven()).toEqual({ backend: 'off', cloudProvider: 'selfhosted', pending: true });
    });

    it('stores a proven WebDAV configuration, then runs the first sync', async () => {
        const { transport, storage, secrets, syncs } = setup([]);
        await transport.load().done;
        await transport.handleSaveWebDavSettings(fields);
        expect(storage.get(SYNC_BACKEND_KEY)).toBe('webdav');
        expect(storage.get(WEBDAV_URL_KEY)).toBe('https://dav.example.com/');
        expect(secrets.get(WEBDAV_PASSWORD_KEY)).toBe('secret');
        expect(syncs).toEqual([
            { activationProbe: true, manual: true, configOverride: { backend: 'webdav', webdav: { allowInsecureHttp: false, password: 'secret', url: 'https://dav.example.com/', username: 'alice' } } },
            { manual: true, ignorePendingRemoteWriteBackoff: true },
        ]);
        expect(transport.getProven()).toEqual({ backend: 'webdav', cloudProvider: 'selfhosted', pending: false });
    });

    it('stages a backend whose settings are incomplete, and a build without Dropbox ignores Dropbox', async () => {
        const { transport, storage, syncs } = setup([]);
        await transport.load().done;
        expect(transport.handleSelectSyncBackend('webdav')).toBeUndefined();
        expect(transport.handleSelectCloudProvider('dropbox')).toBeUndefined();
        expect(transport.getState().syncBackend).toBe('webdav');
        expect(syncs).toEqual([]);
        expect(storage.size).toBe(0);
    });

    it('warns once about insecure HTTP when a form is saved, not once for the save and again for its first sync', async () => {
        const { transport, toasts, storage } = setup([]);
        await transport.load().done;
        await transport.handleSaveWebDavSettings({ ...fields, url: 'http://dav.example.com', allowInsecureHttp: true });
        await transport.handleSaveSelfHostedSettings({ allowInsecureHttp: true, token: 'abcdefghijklmnopqrstuvwxyz012345', url: 'http://cloud.example.com' });
        expect(toasts.map((toast) => toast.title)).toEqual([
            'settings.syncMobile.insecureHttpEnabled', 'common.success',
            'settings.syncMobile.insecureHttpEnabled', 'common.success',
        ]);
        expect(storage.get(SYNC_BACKEND_KEY)).toBe('cloud');
        // Sync now on a form still warns: that tap has no save before it.
        await transport.handleSync({ backend: 'cloud', cloudProvider: 'selfhosted', cloud: { allowInsecureHttp: true, token: 'abcdefghijklmnopqrstuvwxyz012345', url: 'http://cloud.example.com' } });
        expect(toasts.slice(4).map((toast) => toast.title)).toEqual(['settings.syncMobile.insecureHttpEnabled', 'common.success']);
    });

    it('stores a folder picked without a bookmark with no bookmark, not the previous folder\'s', async () => {
        const { transport, storage, syncs } = setup([]);
        storage.set(SYNC_BACKEND_KEY, 'file');
        storage.set(SYNC_PATH_KEY, 'file:///old/data.json');
        storage.set(SYNC_PATH_BOOKMARK_KEY, 'old-bookmark');
        await transport.load().done;
        picked.value = { __fileUri: 'file:///new/data.json' };
        await transport.handleSetSyncPath();
        expect(syncs[0]).toMatchObject({ configOverride: { backend: 'file', syncPath: 'file:///new/data.json', syncPathBookmark: null } });
        expect(storage.get(SYNC_PATH_KEY)).toBe('file:///new/data.json');
        expect(storage.has(SYNC_PATH_BOOKMARK_KEY)).toBe(false);
    });

    it('keeps showing the stored backend when Off cannot be stored, and rejects so the caller can say so', async () => {
        const { transport, storage, host } = setup([]);
        storage.set(SYNC_BACKEND_KEY, 'webdav');
        storage.set(WEBDAV_URL_KEY, 'https://dav.example.com');
        await transport.load().done;
        const setItem = host.storage.setItem;
        host.storage.setItem = async (key, value) => {
            if (key === SYNC_BACKEND_KEY) throw new Error('The device store refused the write');
            return setItem(key, value);
        };
        await expect(transport.handleSelectSyncBackend('off')).rejects.toBeInstanceOf(SyncSettingsWriteError);
        expect(storage.get(SYNC_BACKEND_KEY)).toBe('webdav');
        expect(transport.getState().syncBackend).toBe('webdav');
        expect(transport.getProven()).toEqual({ backend: 'webdav', cloudProvider: 'selfhosted', pending: false });
    });

    it('never echoes the password in a failure toast', async () => {
        const { transport, toasts } = setup([{ success: false, error: 'server said: bad password secret-pw for alice' }]);
        await transport.load().done;
        await transport.handleSaveWebDavSettings({ ...fields, password: 'secret-pw' });
        expect(toasts).toHaveLength(1);
        expect(JSON.stringify(toasts)).not.toContain('secret-pw');
    });

    it('lets only the latest Off write restore the screen when a write fails', async () => {
        const { transport, storage, host } = setup([]);
        storage.set(SYNC_BACKEND_KEY, 'webdav');
        storage.set(WEBDAV_URL_KEY, 'https://dav.example.com');
        await transport.load().done;
        const setItem = host.storage.setItem;
        let failFirst!: (error: Error) => void;
        let calls = 0;
        host.storage.setItem = async (key, value) => {
            if (key === SYNC_BACKEND_KEY && calls++ === 0) {
                return new Promise<void>((_resolve, reject) => { failFirst = reject; });
            }
            return setItem(key, value);
        };
        const firstOff = transport.handleSelectSyncBackend('off');
        transport.handleSelectSyncBackend('file');
        await transport.handleSelectSyncBackend('off');
        expect(storage.get(SYNC_BACKEND_KEY)).toBe('off');
        failFirst(new Error('late failure'));
        await expect(firstOff).rejects.toBeInstanceOf(SyncSettingsWriteError);
        expect(transport.getState().syncBackend).toBe('off');
        expect(transport.getProven()).toMatchObject({ backend: 'off' });
    });
});
