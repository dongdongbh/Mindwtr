import { describe, expect, it, vi } from 'vitest';

import { bytesToBase64 } from './base64-bytes';
import {
    SyncEncryptionKeyMissingError,
    SyncEncryptionStateUnavailableError,
    createSyncEncryptionStateStore,
    readSyncLocationScope,
    type SyncEncryptionLogContext,
} from './sync-encryption-local-state';
import { buildSyncLocationScope } from './sync-encryption';
import {
    SYNC_BACKEND_KEY,
    SYNC_ENCRYPTION_KEY_KEY,
    SYNC_ENCRYPTION_STATE_KEY,
    WEBDAV_URL_KEY,
    WEBDAV_USERNAME_KEY,
} from './sync-storage-keys';

const KDF = { mKib: 19456, t: 2, p: 1 };
const KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const WEBDAV_SCOPE = buildSyncLocationScope({ backend: 'webdav', webdavUrl: 'https://dav.example.com/sync', webdavUsername: 'alice' });

const createHarness = () => {
    const plain = new Map<string, string>();
    const secrets = new Map<string, string>();
    const control = { failWrites: false, failReads: false };
    const logs: Array<{ level: 'info' | 'warn'; message: string; context: SyncEncryptionLogContext }> = [];
    const storage = {
        getItem: vi.fn(async (key: string) => {
            if (control.failReads) throw new Error('storage offline');
            return plain.get(key) ?? null;
        }),
        setItem: vi.fn(async (key: string, value: string) => {
            if (control.failWrites) throw new Error('disk full');
            plain.set(key, value);
        }),
        removeItem: vi.fn(async (key: string) => {
            if (control.failWrites) throw new Error('disk full');
            plain.delete(key);
        }),
    };
    const store = createSyncEncryptionStateStore({
        storage,
        secureConfig: {
            getSecureConfigValue: async (key) => secrets.get(key) ?? null,
            setSecureConfigValue: async (key, value) => {
                secrets.set(key, value);
            },
            deleteSecureConfigValue: async (key) => {
                secrets.delete(key);
            },
        },
        readActiveScope: () => readSyncLocationScope(storage),
        log: {
            info: (message, context) => {
                logs.push({ level: 'info', message, context });
            },
            warn: (message, context) => {
                logs.push({ level: 'warn', message, context });
            },
        },
    });
    return { plain, secrets, control, logs, storage, store };
};

describe('sync encryption local state', () => {
    it('fails closed on a sidecar it cannot validate, and re-reads it next time', async () => {
        const { plain, logs, storage, store } = createHarness();
        plain.set(SYNC_ENCRYPTION_STATE_KEY, JSON.stringify({ state: 'off' }));

        await expect(store.loadSyncEncryptionLocalState()).rejects.toBeInstanceOf(SyncEncryptionStateUnavailableError);
        expect(logs.at(-1)).toMatchObject({ level: 'warn', message: 'Failed to read sync encryption state; stopping sync' });

        plain.set(SYNC_ENCRYPTION_STATE_KEY, '{not json');
        await expect(store.loadSyncEncryptionLocalState()).rejects.toBeInstanceOf(SyncEncryptionStateUnavailableError);

        plain.set(SYNC_ENCRYPTION_STATE_KEY, JSON.stringify({ state: 'off', incompleteTransition: 'enable' }));
        await expect(store.loadSyncEncryptionLocalState()).resolves.toEqual({
            state: 'off',
            discoveredSalt: undefined,
            discoveredParams: undefined,
            discoveredScope: undefined,
            incompleteTransition: 'enable',
        });
        await store.loadSyncEncryptionLocalState();
        expect(storage.getItem).toHaveBeenCalledTimes(3);
        await expect(store.getSyncEncryptionStatus()).resolves.toEqual({ state: 'off', incompleteTransition: 'enable' });
        await expect(store.getIncompleteSyncEncryptionTransition()).resolves.toBe('enable');
    });

    it('shows a location as partly encrypted only while it is the active one', async () => {
        const { plain, store } = createHarness();
        plain.set(SYNC_ENCRYPTION_STATE_KEY, JSON.stringify({ state: 'off', partlyEncryptedScope: WEBDAV_SCOPE }));
        plain.set(SYNC_BACKEND_KEY, 'webdav');
        plain.set(WEBDAV_URL_KEY, 'https://dav.example.com/sync');
        plain.set(WEBDAV_USERNAME_KEY, 'alice');
        await expect(store.getSyncEncryptionStatus()).resolves.toEqual({ state: 'off', incompleteTransition: undefined, partlyEncrypted: true });

        plain.set(WEBDAV_URL_KEY, 'https://dav.example.com/other');
        await expect(store.getSyncEncryptionStatus()).resolves.toEqual({ state: 'off', incompleteTransition: undefined });
    });

    it('resolves material only for keyed states and never reads a missing key as "off"', async () => {
        const { plain, secrets, store } = createHarness();
        await expect(store.getSyncEncryptionMaterial()).resolves.toBeNull();

        store.reset();
        plain.set(SYNC_ENCRYPTION_STATE_KEY, JSON.stringify({ state: 'enabled', discoveredSalt: '0a0b', discoveredParams: KDF }));
        await expect(store.getSyncEncryptionMaterial()).rejects.toBeInstanceOf(SyncEncryptionKeyMissingError);


        secrets.set(SYNC_ENCRYPTION_KEY_KEY, bytesToBase64(KEY.slice(0, 16)));
        await expect(store.getSyncEncryptionMaterial()).rejects.toBeInstanceOf(SyncEncryptionKeyMissingError);

        await store.syncEncryptionKeyCache.setKey(KEY);
        expect(secrets.get(SYNC_ENCRYPTION_KEY_KEY)).toBe(bytesToBase64(KEY));
        await expect(store.getSyncEncryptionMaterial()).resolves.toEqual({
            key: KEY,
            salt: Uint8Array.from([10, 11]),
            params: KDF,
        });


        store.reset();
        plain.set(SYNC_ENCRYPTION_STATE_KEY, JSON.stringify({ state: 'remote-plaintext', discoveredSalt: '0a0b', discoveredParams: KDF }));
        await expect(store.getSyncEncryptionMaterial()).resolves.not.toBeNull();

        store.reset();
        plain.set(SYNC_ENCRYPTION_STATE_KEY, JSON.stringify({ state: 'enabled', discoveredParams: KDF }));
        await expect(store.getSyncEncryptionMaterial()).rejects.toBeInstanceOf(SyncEncryptionKeyMissingError);
    });

    it('queues writes, flushes them durably, and restores the cache when a write fails', async () => {
        const { plain, control, logs, store } = createHarness();
        await store.loadSyncEncryptionLocalState();
        const enabled = { state: 'enabled' as const, discoveredSalt: '00', discoveredParams: KDF };

        const first = store.syncEncryptionLocalState.write(enabled);
        expect(store.syncEncryptionLocalState.read()).toBe(enabled);
        await first;
        await store.flushSyncEncryptionLocalState();
        expect(JSON.parse(plain.get(SYNC_ENCRYPTION_STATE_KEY)!)).toEqual(enabled);

        control.failWrites = true;
        const failed = store.syncEncryptionLocalState.write(null);
        expect(store.syncEncryptionLocalState.read()).toBeNull();
        await expect(failed).rejects.toThrow('disk full');
        await expect(store.flushSyncEncryptionLocalState()).rejects.toThrow('disk full');
        expect(store.syncEncryptionLocalState.read()).toBe(enabled);
        expect(logs.at(-1)).toMatchObject({ level: 'warn', message: 'Failed to persist sync encryption state' });

        control.failWrites = false;
        await store.syncEncryptionLocalState.write(null);
        await store.flushSyncEncryptionLocalState();
        expect(plain.has(SYNC_ENCRYPTION_STATE_KEY)).toBe(false);
        await expect(store.reloadSyncEncryptionLocalStateForRecovery()).resolves.toBeNull();
    });

    it('blocks and defers only for the location a discovery was made on', async () => {
        const { plain, store } = createHarness();
        await expect(store.isSyncEncryptionPostureUnestablished(WEBDAV_SCOPE, false)).resolves.toBe(true);
        await expect(store.isSyncEncryptionPostureUnestablished(WEBDAV_SCOPE, true)).resolves.toBe(false);

        store.reset();
        plain.set(SYNC_ENCRYPTION_STATE_KEY, JSON.stringify({ state: 'remote-encrypted-no-key', discoveredScope: WEBDAV_SCOPE }));
        await expect(store.isSyncEncryptionBlocked(WEBDAV_SCOPE)).resolves.toBe(true);
        await expect(store.isSyncEncryptionBlocked(null)).resolves.toBe(true);
        await expect(store.isSyncEncryptionBlocked('["file","/other"]')).resolves.toBe(false);
        await expect(store.isSyncEncryptionPostureUnestablished(WEBDAV_SCOPE, false)).resolves.toBe(false);
        await expect(store.isSyncEncryptionPostureUnestablished('["file","/other"]', true)).resolves.toBe(true);

        store.reset();
        plain.set(SYNC_ENCRYPTION_STATE_KEY, JSON.stringify({ state: 'enabled', discoveredSalt: '00', discoveredParams: KDF }));
        await expect(store.isSyncEncryptionPostureUnestablished(WEBDAV_SCOPE, false)).resolves.toBe(false);
    });

    it('reads a remembered partly encrypted location as off for every other location\'s posture', async () => {


        const { plain, store } = createHarness();
        plain.set(SYNC_ENCRYPTION_STATE_KEY, JSON.stringify({ state: 'off', partlyEncryptedScope: '["webdav","https://dav.example.com/mixed/data.json","bob"]' }));
        await expect(store.isSyncEncryptionPostureUnestablished(WEBDAV_SCOPE, true)).resolves.toBe(false);
        await expect(store.isSyncEncryptionPostureUnestablished(WEBDAV_SCOPE, false)).resolves.toBe(true);


        store.reset();
        plain.set(SYNC_ENCRYPTION_STATE_KEY, JSON.stringify({ state: 'off', incompleteTransition: 'enable' }));
        await expect(store.isSyncEncryptionPostureUnestablished(WEBDAV_SCOPE, true)).resolves.toBe(true);
    });

    it('reads the active location from the stored keys, and null when they cannot be read', async () => {
        const { plain, control, storage } = createHarness();
        plain.set(SYNC_BACKEND_KEY, 'webdav');
        plain.set(WEBDAV_URL_KEY, 'https://dav.example.com/sync');
        plain.set(WEBDAV_USERNAME_KEY, 'alice');

        await expect(readSyncLocationScope(storage)).resolves.toBe(WEBDAV_SCOPE);
        control.failReads = true;
        await expect(readSyncLocationScope(storage)).resolves.toBeNull();
    });

    it('writes the diagnostics posture as a forced state line', async () => {
        const { plain, logs, store } = createHarness();
        plain.set(SYNC_BACKEND_KEY, 'webdav');
        plain.set(WEBDAV_URL_KEY, 'https://dav.example.com/sync');
        plain.set(WEBDAV_USERNAME_KEY, 'alice');
        plain.set(SYNC_ENCRYPTION_STATE_KEY, JSON.stringify({ state: 'remote-encrypted-no-key', discoveredScope: WEBDAV_SCOPE }));

        await store.logSyncEncryptionDiagnosticsBlock();

        const line = logs.at(-1)!;
        expect(line.level).toBe('info');
        expect(line.context.force).toBe(true);
        expect(line.context.scope).toBe('sync');
        expect(line.context.extra).toMatchObject({ backend: 'webdav', decision: 'blocked-no-key' });
        const lines = await store.getSyncEncryptionDiagnosticsLines();
        expect(lines.length).toBeGreaterThan(0);
    });

    it('reports an unreadable sidecar as a blocked transition in diagnostics', async () => {
        const { plain, logs, store } = createHarness();
        plain.set(SYNC_ENCRYPTION_STATE_KEY, 'garbage');

        await store.logSyncEncryptionDiagnosticsBlock();

        expect(logs.at(-1)!.context.extra).toMatchObject({ decision: 'blocked-transition' });
    });
});
