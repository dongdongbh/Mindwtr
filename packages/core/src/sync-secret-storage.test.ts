import { describe, expect, it, vi } from 'vitest';

import {
    createSecureSyncConfigStore,
    createSyncSecretVault,
    getSecureConfigValueReadOnly,
    isSecretConfigKey,
    type SyncSecretAccessibility,
} from './sync-secret-storage';
import {
    CLOUD_TOKEN_KEY,
    SYNC_ENCRYPTION_KEY_KEY,
    WEBDAV_PASSWORD_KEY,
    WEBDAV_URL_KEY,
} from './sync-storage-keys';

const createPorts = (options: { available?: boolean } = {}) => {
    const plain = new Map<string, string>();
    const secure = new Map<string, { value: string; accessibility: SyncSecretAccessibility }>();
    const control = { available: options.available ?? true, probeFailures: 0, failSecureWrites: false };
    const storage = {
        getItem: vi.fn(async (key: string) => plain.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => {
            plain.set(key, value);
        }),
        removeItem: vi.fn(async (key: string) => {
            plain.delete(key);
        }),
    };
    const secrets = {
        isAvailable: vi.fn(async () => {
            if (control.probeFailures > 0) {
                control.probeFailures -= 1;
                throw new Error('keystore probe failed');
            }
            return control.available;
        }),
        getItem: vi.fn(async (key: string) => secure.get(key)?.value ?? null),
        setItem: vi.fn(async (key: string, value: string, accessibility: SyncSecretAccessibility) => {
            if (control.failSecureWrites) throw new Error('keystore unavailable');
            secure.set(key, { value, accessibility });
        }),
        deleteItem: vi.fn(async (key: string) => {
            secure.delete(key);
        }),
    };
    const vault = createSyncSecretVault(secrets);
    const config = createSecureSyncConfigStore({ storage, secrets, vault });
    return { plain, secure, control, storage, secrets, vault, config };
};

describe('isSecretConfigKey', () => {
    it('names the WebDAV password, the cloud token and the encryption key only', () => {
        expect(isSecretConfigKey(WEBDAV_PASSWORD_KEY)).toBe(true);
        expect(isSecretConfigKey(CLOUD_TOKEN_KEY)).toBe(true);
        expect(isSecretConfigKey(SYNC_ENCRYPTION_KEY_KEY)).toBe(true);
        expect(isSecretConfigKey(WEBDAV_URL_KEY)).toBe(false);
    });
});

describe('createSyncSecretVault', () => {
    it('caches a successful availability probe but retries a rejected one', async () => {
        const { control, secrets, vault } = createPorts();
        control.probeFailures = 1;

        await expect(vault.isSecureStoreAvailable()).rejects.toThrow('keystore probe failed');
        await expect(vault.isSecureStoreAvailable()).resolves.toBe(true);
        await expect(vault.isSecureStoreAvailable()).resolves.toBe(true);
        expect(secrets.isAvailable).toHaveBeenCalledTimes(2);

        vault.reset();
        await vault.isSecureStoreAvailable();
        expect(secrets.isAvailable).toHaveBeenCalledTimes(3);
    });

    it('drops the in-memory copy when the legacy plaintext cannot be removed', async () => {
        const { vault } = createPorts();

        await expect(vault.evacuateLegacySecretToSession('k', 'v', async () => {
            throw new Error('remove failed');
        })).rejects.toThrow('remove failed');
        expect(vault.getSessionSecret('k')).toBeNull();

        await vault.evacuateLegacySecretToSession('k', 'v', async () => undefined);
        expect(vault.getSessionSecret('k')).toBe('v');
    });
});

describe('createSecureSyncConfigStore', () => {
    it('writes to the keystore after-first-unlock under the key without its @ prefix', async () => {
        const { plain, secure, config } = createPorts();
        plain.set(CLOUD_TOKEN_KEY, 'old-plaintext');

        await config.setSecureConfigValue(CLOUD_TOKEN_KEY, 'fresh-token');

        expect(secure.get('mindwtr_cloud_token')).toEqual({ value: 'fresh-token', accessibility: 'after-first-unlock' });
        expect(plain.has(CLOUD_TOKEN_KEY)).toBe(false);
    });

    it('reads the keystore first, scrubbing any plaintext copy', async () => {
        const { plain, secure, config } = createPorts();
        secure.set('mindwtr_webdav_password', { value: 'secure-pass', accessibility: 'after-first-unlock' });
        plain.set(WEBDAV_PASSWORD_KEY, 'stale-plaintext');

        await expect(config.getSecureConfigValue(WEBDAV_PASSWORD_KEY)).resolves.toBe('secure-pass');
        expect(plain.has(WEBDAV_PASSWORD_KEY)).toBe(false);
    });

    it('migrates legacy plaintext into the keystore, and keeps it when the keystore write fails', async () => {
        const { plain, secure, control, config } = createPorts();
        plain.set(CLOUD_TOKEN_KEY, 'legacy-token');
        control.failSecureWrites = true;

        await expect(config.getSecureConfigValue(CLOUD_TOKEN_KEY)).rejects.toThrow('keystore unavailable');
        expect(plain.get(CLOUD_TOKEN_KEY)).toBe('legacy-token');

        control.failSecureWrites = false;
        await expect(config.getSecureConfigValue(CLOUD_TOKEN_KEY)).resolves.toBe('legacy-token');
        expect(secure.get('mindwtr_cloud_token')?.value).toBe('legacy-token');
        expect(plain.has(CLOUD_TOKEN_KEY)).toBe(false);
    });

    it('never writes plaintext when the keystore is unsupported: secrets live in memory only', async () => {
        const { plain, secure, storage, config } = createPorts({ available: false });

        await config.setSecureConfigValue(CLOUD_TOKEN_KEY, 'session-token');
        expect(storage.setItem).not.toHaveBeenCalled();
        expect(secure.size).toBe(0);
        await expect(config.getSecureConfigValue(CLOUD_TOKEN_KEY)).resolves.toBe('session-token');

        plain.set(WEBDAV_PASSWORD_KEY, 'legacy-pass');
        await expect(config.getSecureConfigValue(WEBDAV_PASSWORD_KEY)).resolves.toBe('legacy-pass');
        expect(plain.has(WEBDAV_PASSWORD_KEY)).toBe(false);
        await expect(config.getSecureConfigValue(WEBDAV_PASSWORD_KEY)).resolves.toBe('legacy-pass');

        await config.deleteSecureConfigValue(WEBDAV_PASSWORD_KEY);
        await expect(config.getSecureConfigValue(WEBDAV_PASSWORD_KEY)).resolves.toBeNull();
    });

    it('deletes from both stores', async () => {
        const { plain, secure, config } = createPorts();
        secure.set('mindwtr_webdav_password', { value: 'secure-pass', accessibility: 'after-first-unlock' });
        plain.set(WEBDAV_PASSWORD_KEY, 'stale-plaintext');

        await config.deleteSecureConfigValue(WEBDAV_PASSWORD_KEY);

        expect(secure.has('mindwtr_webdav_password')).toBe(false);
        expect(plain.has(WEBDAV_PASSWORD_KEY)).toBe(false);
    });
});

describe('getSecureConfigValueReadOnly', () => {
    const watchMutations = ({ storage, secrets, vault }: ReturnType<typeof createPorts>) => [
        storage.setItem, storage.removeItem, secrets.setItem, secrets.deleteItem,
        vi.spyOn(vault, 'setSessionSecret'), vi.spyOn(vault, 'deleteSessionSecret'),
        vi.spyOn(vault, 'evacuateLegacySecretToSession'), vi.spyOn(vault, 'reset'),
    ];

    it.each([
        [WEBDAV_PASSWORD_KEY, 'mindwtr_webdav_password'],
        [CLOUD_TOKEN_KEY, 'mindwtr_cloud_token'],
        [SYNC_ENCRYPTION_KEY_KEY, 'mindwtr_sync_encryption_key_v1'],
    ])('reads the existing mapped secure account for %s without scrubbing legacy or session values', async (key, account) => {
        const ports = createPorts();
        ports.plain.set(key, 'legacy-value');
        ports.secure.set(account, { value: 'secure-value', accessibility: 'when-unlocked' });
        ports.vault.setSessionSecret(account, 'session-value');
        const beforePlain = [...ports.plain.entries()];
        const beforeSecure = [...ports.secure.entries()];
        const mutations = watchMutations(ports);

        await expect(getSecureConfigValueReadOnly(ports, key)).resolves.toBe('secure-value');

        expect(ports.secrets.getItem).toHaveBeenCalledWith(account);
        expect(ports.storage.getItem).not.toHaveBeenCalled();
        expect([...ports.plain.entries()]).toEqual(beforePlain);
        expect([...ports.secure.entries()]).toEqual(beforeSecure);
        expect(ports.vault.getSessionSecret(account)).toBe('session-value');
        mutations.forEach((mutation) => expect(mutation).not.toHaveBeenCalled());
    });

    it('uses legacy only for a missing secure value without migration or session insertion', async () => {
        const ports = createPorts();
        ports.plain.set(WEBDAV_PASSWORD_KEY, 'legacy-value');
        ports.vault.setSessionSecret('unrelated-account', 'unrelated-value');
        const mutations = watchMutations(ports);

        await expect(getSecureConfigValueReadOnly(ports, WEBDAV_PASSWORD_KEY)).resolves.toBe('legacy-value');

        expect(ports.secrets.getItem).toHaveBeenCalledWith('mindwtr_webdav_password');
        expect(ports.storage.getItem).toHaveBeenCalledWith(WEBDAV_PASSWORD_KEY);
        expect(ports.plain.get(WEBDAV_PASSWORD_KEY)).toBe('legacy-value');
        expect(ports.secure.size).toBe(0);
        expect(ports.vault.getSessionSecret('mindwtr_webdav_password')).toBeNull();
        expect(ports.vault.getSessionSecret('unrelated-account')).toBe('unrelated-value');
        mutations.forEach((mutation) => expect(mutation).not.toHaveBeenCalled());
    });

    it('keeps an empty secure string ahead of legacy/session values', async () => {
        const ports = createPorts();
        ports.secure.set('mindwtr_webdav_password', { value: '', accessibility: 'after-first-unlock' });
        ports.plain.set(WEBDAV_PASSWORD_KEY, 'legacy-value');
        ports.vault.setSessionSecret('mindwtr_webdav_password', 'session-value');
        const mutations = watchMutations(ports);

        await expect(getSecureConfigValueReadOnly(ports, WEBDAV_PASSWORD_KEY)).resolves.toBe('');

        expect(ports.storage.getItem).not.toHaveBeenCalled();
        expect(ports.plain.get(WEBDAV_PASSWORD_KEY)).toBe('legacy-value');
        expect(ports.vault.getSessionSecret('mindwtr_webdav_password')).toBe('session-value');
        mutations.forEach((mutation) => expect(mutation).not.toHaveBeenCalled());
    });

    it('propagates a secure read error unchanged and never falls back', async () => {
        const ports = createPorts();
        ports.plain.set(WEBDAV_PASSWORD_KEY, 'legacy-value');
        ports.vault.setSessionSecret('mindwtr_webdav_password', 'session-value');
        const failure = new Error('Secure read unavailable');
        ports.secrets.getItem.mockRejectedValueOnce(failure);
        const mutations = watchMutations(ports);

        await expect(getSecureConfigValueReadOnly(ports, WEBDAV_PASSWORD_KEY)).rejects.toBe(failure);

        expect(ports.storage.getItem).not.toHaveBeenCalled();
        expect(ports.plain.get(WEBDAV_PASSWORD_KEY)).toBe('legacy-value');
        expect(ports.vault.getSessionSecret('mindwtr_webdav_password')).toBe('session-value');
        mutations.forEach((mutation) => expect(mutation).not.toHaveBeenCalled());
    });

    it('propagates a rejected availability probe unchanged and permits the existing vault retry', async () => {
        const ports = createPorts();
        ports.plain.set(WEBDAV_PASSWORD_KEY, 'legacy-value');
        ports.secure.set('mindwtr_webdav_password', { value: 'secure-value', accessibility: 'after-first-unlock' });
        const failure = new Error('Probe unavailable');
        ports.secrets.isAvailable.mockRejectedValueOnce(failure);
        const mutations = watchMutations(ports);

        await expect(getSecureConfigValueReadOnly(ports, WEBDAV_PASSWORD_KEY)).rejects.toBe(failure);
        expect(ports.secrets.getItem).not.toHaveBeenCalled();
        expect(ports.storage.getItem).not.toHaveBeenCalled();
        await expect(getSecureConfigValueReadOnly(ports, WEBDAV_PASSWORD_KEY)).resolves.toBe('secure-value');
        expect(ports.secrets.isAvailable).toHaveBeenCalledTimes(2);
        expect(ports.storage.getItem).not.toHaveBeenCalled();
        expect(ports.plain.get(WEBDAV_PASSWORD_KEY)).toBe('legacy-value');
        mutations.forEach((mutation) => expect(mutation).not.toHaveBeenCalled());
    });

    it.each(['session-value', ''])('prefers unsupported-store session value %j without evacuation/removal', async (sessionValue) => {
        const ports = createPorts({ available: false });
        ports.vault.setSessionSecret('mindwtr_webdav_password', sessionValue);
        ports.vault.setSessionSecret('unrelated-account', 'unrelated-value');
        ports.plain.set(WEBDAV_PASSWORD_KEY, 'legacy-value');
        const mutations = watchMutations(ports);

        await expect(getSecureConfigValueReadOnly(ports, WEBDAV_PASSWORD_KEY)).resolves.toBe(sessionValue);

        expect(ports.storage.getItem).not.toHaveBeenCalled();
        expect(ports.secrets.getItem).not.toHaveBeenCalled();
        expect(ports.vault.getSessionSecret('mindwtr_webdav_password')).toBe(sessionValue);
        expect(ports.vault.getSessionSecret('unrelated-account')).toBe('unrelated-value');
        expect(ports.plain.get(WEBDAV_PASSWORD_KEY)).toBe('legacy-value');
        mutations.forEach((mutation) => expect(mutation).not.toHaveBeenCalled());
    });

    it('reads unsupported-store legacy repeatedly without inserting a session value or evacuating plaintext', async () => {
        const ports = createPorts({ available: false });
        ports.plain.set(WEBDAV_PASSWORD_KEY, 'legacy-value');
        ports.vault.setSessionSecret('unrelated-account', 'unrelated-value');
        const mutations = watchMutations(ports);

        await expect(getSecureConfigValueReadOnly(ports, WEBDAV_PASSWORD_KEY)).resolves.toBe('legacy-value');
        ports.plain.set(WEBDAV_PASSWORD_KEY, 'later-legacy');
        await expect(getSecureConfigValueReadOnly(ports, WEBDAV_PASSWORD_KEY)).resolves.toBe('later-legacy');

        expect(ports.secrets.isAvailable).toHaveBeenCalledTimes(1);
        expect(ports.secrets.getItem).not.toHaveBeenCalled();
        expect(ports.storage.getItem).toHaveBeenCalledTimes(2);
        expect(ports.plain.get(WEBDAV_PASSWORD_KEY)).toBe('later-legacy');
        expect(ports.vault.getSessionSecret('mindwtr_webdav_password')).toBeNull();
        expect(ports.vault.getSessionSecret('unrelated-account')).toBe('unrelated-value');
        mutations.forEach((mutation) => expect(mutation).not.toHaveBeenCalled());
    });

    it.each([true, false])('returns an actually missing value for secure availability %s without writing', async (available) => {
        const ports = createPorts({ available });
        const mutations = watchMutations(ports);

        await expect(getSecureConfigValueReadOnly(ports, WEBDAV_PASSWORD_KEY)).resolves.toBeNull();

        expect(ports.plain.size).toBe(0);
        expect(ports.secure.size).toBe(0);
        expect(ports.vault.getSessionSecret('mindwtr_webdav_password')).toBeNull();
        mutations.forEach((mutation) => expect(mutation).not.toHaveBeenCalled());
    });
});
