// Where the mobile apps keep sync credentials. Secrets live in the platform keystore (iOS
// Keychain / Android Keystore) behind `SyncSecretStoragePort`; everything else stays in the
// device key-value store, which lands in device backups. A value found in the old plaintext
// location is moved into the keystore on first read. When the keystore is unsupported, a
// secret lives in memory for this process only and is never written in plaintext.

import {
    CLOUD_TOKEN_KEY,
    SYNC_ENCRYPTION_KEY_KEY,
    WEBDAV_PASSWORD_KEY,
    type SyncKeyValueStoragePort,
} from './sync-storage-keys';

/** When a stored secret may be read. `after-first-unlock` keeps it readable to a background
 *  sync that runs while the device is locked. iOS maps these to Keychain accessibility
 *  classes; Android ignores them. */
export type SyncSecretAccessibility = 'after-first-unlock' | 'when-unlocked';

/** The host's platform keystore (expo-secure-store on RN). Keys use only [A-Za-z0-9._-]. */
export type SyncSecretStoragePort = {
    isAvailable(): Promise<boolean>;
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string, accessibility: SyncSecretAccessibility): Promise<void>;
    deleteItem(key: string): Promise<void>;
};

/** Per-process secret state shared by every credential store of one host: the cached
 *  keystore availability and the in-memory fallback for secrets. */
export type SyncSecretVault = {
    isSecureStoreAvailable(): Promise<boolean>;
    getSessionSecret(key: string): string | null;
    setSessionSecret(key: string, value: string): void;
    deleteSessionSecret(key: string): void;
    /** Moves a legacy plaintext value into memory, then removes the plaintext copy. If the
     *  removal fails, the in-memory copy is dropped again and the error is rethrown. */
    evacuateLegacySecretToSession(key: string, value: string, removeLegacy: () => Promise<void>): Promise<void>;
    reset(): void;
};

export const createSyncSecretVault = (secrets: Pick<SyncSecretStoragePort, 'isAvailable'>): SyncSecretVault => {
    let availability: Promise<boolean> | null = null;
    const sessionSecrets = new Map<string, string>();

    const getSessionSecret = (key: string): string | null => sessionSecrets.get(key) ?? null;
    const setSessionSecret = (key: string, value: string): void => {
        sessionSecrets.set(key, value);
    };
    const deleteSessionSecret = (key: string): void => {
        sessionSecrets.delete(key);
    };

    return {
        /**
         * Cache stable availability, but never turn a rejected native probe into an
         * "unsupported" result. A later operation must be able to retry the probe.
         */
        isSecureStoreAvailable: () => {
            if (!availability) {
                availability = secrets.isAvailable().catch((error) => {
                    availability = null;
                    throw error;
                });
            }
            return availability;
        },
        getSessionSecret,
        setSessionSecret,
        deleteSessionSecret,
        evacuateLegacySecretToSession: async (key, value, removeLegacy) => {
            setSessionSecret(key, value);
            try {
                await removeLegacy();
            } catch (error) {
                deleteSessionSecret(key);
                throw error;
            }
        },
        reset: () => {
            availability = null;
            sessionSecrets.clear();
        },
    };
};

// Sync credentials that must live in the platform keystore rather than the plaintext
// key-value store, which lands in device backups. Non-secret sync config (URLs, usernames,
// flags) stays in the key-value store on purpose: keystore reads are slower and size-limited.
const SECRET_CONFIG_KEYS: ReadonlySet<string> = new Set([
    WEBDAV_PASSWORD_KEY,
    CLOUD_TOKEN_KEY,
    SYNC_ENCRYPTION_KEY_KEY,
]);

export const isSecretConfigKey = (key: string): boolean => SECRET_CONFIG_KEYS.has(key);

// Keystore keys only allow [A-Za-z0-9._-]; strip the key-value store's '@' prefix.
const secureKeyFor = (key: string): string => key.replace(/^@/, '');

export type SecureSyncConfigStore = {
    getSecureConfigValue(key: string): Promise<string | null>;
    setSecureConfigValue(key: string, value: string): Promise<void>;
    deleteSecureConfigValue(key: string): Promise<void>;
};

export type SecureSyncConfigStoreDeps = {
    storage: SyncKeyValueStoragePort;
    secrets: SyncSecretStoragePort;
    vault: SyncSecretVault;
};

/** Selected read-only lookup: preserve legacy/session copies without migrating them.
 * Native port admission and current-owner checks remain the caller's responsibility. */
export const getSecureConfigValueReadOnly = async (
    { storage, secrets, vault }: SecureSyncConfigStoreDeps,
    key: string,
): Promise<string | null> => {
    const secureKey = secureKeyFor(key);
    if (await vault.isSecureStoreAvailable()) {
        const secureValue = await secrets.getItem(secureKey);
        return secureValue !== null ? secureValue : storage.getItem(key);
    }
    const sessionValue = vault.getSessionSecret(secureKey);
    return sessionValue !== null ? sessionValue : storage.getItem(key);
};

/** Reads and writes the secret sync config keys (`isSecretConfigKey`). Secrets are written
 *  `after-first-unlock`: background sync can run while the device is locked. */
export const createSecureSyncConfigStore = ({ storage, secrets, vault }: SecureSyncConfigStoreDeps): SecureSyncConfigStore => {
    const migrateLegacyValue = async (key: string, legacyValue: string): Promise<void> => {
        await secrets.setItem(secureKeyFor(key), legacyValue, 'after-first-unlock');
        await storage.removeItem(key);
    };

    return {
        getSecureConfigValue: async (key) => {
            const secureKey = secureKeyFor(key);
            if (await vault.isSecureStoreAvailable()) {
                const secureValue = await secrets.getItem(secureKey);
                if (secureValue !== null) {
                    await storage.removeItem(key);
                    return secureValue;
                }

                const legacyValue = await storage.getItem(key);
                if (legacyValue !== null) {
                    await migrateLegacyValue(key, legacyValue);
                }
                return legacyValue;
            }

            const sessionValue = vault.getSessionSecret(secureKey);
            if (sessionValue !== null) return sessionValue;

            const legacyValue = await storage.getItem(key);
            if (legacyValue !== null) {
                await vault.evacuateLegacySecretToSession(
                    secureKey,
                    legacyValue,
                    () => storage.removeItem(key),
                );
            }
            return legacyValue;
        },
        setSecureConfigValue: async (key, value) => {
            const secureKey = secureKeyFor(key);
            if (await vault.isSecureStoreAvailable()) {
                await secrets.setItem(secureKey, value, 'after-first-unlock');
                await storage.removeItem(key);
                vault.deleteSessionSecret(secureKey);
                return;
            }

            await storage.removeItem(key);
            vault.setSessionSecret(secureKey, value);
        },
        deleteSecureConfigValue: async (key) => {
            const secureKey = secureKeyFor(key);
            if (await vault.isSecureStoreAvailable()) {
                await secrets.deleteItem(secureKey);
            }
            await storage.removeItem(key);
            vault.deleteSessionSecret(secureKey);
        },
    };
};
