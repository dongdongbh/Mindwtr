import { describe, expect, it } from 'vitest';

import type { DropboxAuthTokens } from './dropbox-auth';
import {
    commitProvenMobileSyncConfiguration,
    MobileSyncConfigurationTransactionError,
    type MobileSyncConfigurationTransactionDependencies,
} from './sync-configuration-transaction';
import {
    CLOUD_ALLOW_INSECURE_HTTP_KEY,
    CLOUD_PROVIDER_KEY,
    CLOUD_TOKEN_KEY,
    CLOUD_URL_KEY,
    SYNC_BACKEND_KEY,
    SYNC_PATH_BOOKMARK_KEY,
    SYNC_PATH_KEY,
    WEBDAV_ALLOW_INSECURE_HTTP_KEY,
    WEBDAV_ALLOW_WEAK_FINGERPRINT_KEY,
    WEBDAV_PASSWORD_KEY,
    WEBDAV_URL_KEY,
    WEBDAV_USERNAME_KEY,
} from './sync-constants';

const CONFIG_KEYS = [
    SYNC_BACKEND_KEY,
    SYNC_PATH_KEY,
    SYNC_PATH_BOOKMARK_KEY,
    WEBDAV_URL_KEY,
    WEBDAV_USERNAME_KEY,
    WEBDAV_ALLOW_INSECURE_HTTP_KEY,
    WEBDAV_ALLOW_WEAK_FINGERPRINT_KEY,
    CLOUD_PROVIDER_KEY,
    CLOUD_URL_KEY,
    CLOUD_ALLOW_INSECURE_HTTP_KEY,
];
/** One protocol read: the whole persisted configuration plus both secrets. */
const READ_CONFIG = [
    `read:${CONFIG_KEYS.join(',')}`,
    `read-secret:${WEBDAV_PASSWORD_KEY}`,
    `read-secret:${CLOUD_TOKEN_KEY}`,
];
const WEBDAV_WRITE = `multi-set:${[
    WEBDAV_URL_KEY,
    WEBDAV_USERNAME_KEY,
    WEBDAV_ALLOW_INSECURE_HTTP_KEY,
    WEBDAV_ALLOW_WEAK_FINGERPRINT_KEY,
].join(',')}`;
const CLOUD_WRITE = `multi-set:${[CLOUD_URL_KEY, CLOUD_ALLOW_INSECURE_HTTP_KEY].join(',')}`;
const backendWrite = (backend: string): string => `set:${SYNC_BACKEND_KEY}:${backend}`;

type HarnessOptions = {
    failCandidateActivation?: boolean;
    failDropboxRollback?: boolean;
};

const OLD_DROPBOX_TOKENS: DropboxAuthTokens = {
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: 4_000_000_000_000,
};
const NEW_DROPBOX_TOKENS: DropboxAuthTokens = {
    accessToken: 'new-access',
    refreshToken: 'new-refresh',
    expiresAt: 4_100_000_000_000,
};

const createHarness = (
    initialStorage: Record<string, string>,
    initialSecrets: Record<string, string> = {},
    initialDropboxTokens: DropboxAuthTokens | null = null,
    options: HarnessOptions = {},
) => {
    const storage = new Map(Object.entries(initialStorage));
    const secrets = new Map(Object.entries(initialSecrets));
    const events: string[] = [];
    let dropboxTokens = initialDropboxTokens;
    let candidateActivationFailed = false;

    const dependencies: MobileSyncConfigurationTransactionDependencies = {
        clearConfigCache: () => events.push('clear-cache'),
        clearDropboxTokens: async () => {
            events.push('clear-dropbox');
            dropboxTokens = null;
        },
        deleteSecret: async (key) => {
            events.push(`delete-secret:${key}`);
            secrets.delete(key);
        },
        getDropboxTokens: async () => dropboxTokens,
        getIncompleteSyncEncryptionTransition: async () => null,
        getSecret: async (key) => secrets.get(key) ?? null,
        multiGet: async (keys) => keys.map((key) => [key, storage.get(key) ?? null] as const),
        multiSet: async (entries) => {
            events.push(`multi-set:${entries.map(([key]) => key).join(',')}`);
            for (const [key, value] of entries) storage.set(key, value);
        },
        removeItem: async (key) => {
            events.push(`remove:${key}`);
            storage.delete(key);
        },
        saveDropboxTokens: async (tokens) => {
            events.push(`save-dropbox:${tokens.accessToken}`);
            if (options.failDropboxRollback && candidateActivationFailed && tokens.accessToken === OLD_DROPBOX_TOKENS.accessToken) {
                throw new Error('injected Dropbox rollback failure');
            }
            dropboxTokens = { ...tokens };
        },
        setItem: async (key, value) => {
            events.push(`set:${key}:${value}`);
            if (
                options.failCandidateActivation
                && key === SYNC_BACKEND_KEY
                && value === 'cloud'
                && dropboxTokens?.accessToken === NEW_DROPBOX_TOKENS.accessToken
                && !candidateActivationFailed
            ) {
                candidateActivationFailed = true;
                throw new Error('injected activation failure');
            }
            storage.set(key, value);
        },
        setSecret: async (key, value) => {
            events.push(`set-secret:${key}:${value}`);
            if (storage.get(SYNC_BACKEND_KEY) !== 'off') {
                throw new Error('transport secret changed while sync was active');
            }
            secrets.set(key, value);
        },
    };

    return {
        dependencies,
        events,
        getDropboxTokens: () => dropboxTokens,
        secrets,
        storage,
    };
};

describe('commitProvenMobileSyncConfiguration', () => {
    it('blocks destination changes while an encryption transition journal exists', async () => {
        const harness = createHarness({ [SYNC_BACKEND_KEY]: 'webdav' });
        harness.dependencies.getIncompleteSyncEncryptionTransition = async () => 'enable';

        await expect(commitProvenMobileSyncConfiguration({
            backend: 'off',
        }, harness.dependencies)).rejects.toThrow('SYNC_ENCRYPTION_TRANSITION_INCOMPLETE');

        expect(harness.events).toEqual([]);
        expect(harness.storage.get(SYNC_BACKEND_KEY)).toBe('webdav');
    });

    it('disables an active same-backend configuration before changing its transport', async () => {
        const harness = createHarness({
            [SYNC_BACKEND_KEY]: 'webdav',
            [WEBDAV_URL_KEY]: 'https://old.example.test/dav',
            [WEBDAV_USERNAME_KEY]: 'old-user',
            [WEBDAV_ALLOW_INSECURE_HTTP_KEY]: 'false',
        }, {
            [WEBDAV_PASSWORD_KEY]: 'old-password',
        });

        await commitProvenMobileSyncConfiguration({
            backend: 'webdav',
            webdav: {
                url: 'https://new.example.test/dav',
                username: 'new-user',
                password: 'new-password',
                allowInsecureHttp: false,
            },
        }, harness.dependencies);

        expect(harness.storage.get(SYNC_BACKEND_KEY)).toBe('webdav');
        expect(harness.storage.get(WEBDAV_URL_KEY)).toBe('https://new.example.test/dav');
        expect(harness.secrets.get(WEBDAV_PASSWORD_KEY)).toBe('new-password');
        const disabledAt = harness.events.indexOf(`set:${SYNC_BACKEND_KEY}:off`);
        const transportWriteAt = harness.events.findIndex((event) => event.startsWith('multi-set:'));
        const activatedAt = harness.events.lastIndexOf(`set:${SYNC_BACKEND_KEY}:webdav`);
        expect(disabledAt).toBeGreaterThanOrEqual(0);
        expect(transportWriteAt).toBeGreaterThan(disabledAt);
        expect(activatedAt).toBeGreaterThan(transportWriteAt);
    });

    it('restores and reactivates the previous backend when candidate activation fails', async () => {
        const harness = createHarness({
            [SYNC_BACKEND_KEY]: 'cloud',
            [CLOUD_PROVIDER_KEY]: 'dropbox',
        }, {}, OLD_DROPBOX_TOKENS, { failCandidateActivation: true });

        await expect(commitProvenMobileSyncConfiguration({
            backend: 'cloud',
            cloudProvider: 'dropbox',
            dropbox: { tokens: NEW_DROPBOX_TOKENS },
        }, harness.dependencies)).rejects.toThrow('injected activation failure');

        expect(harness.storage.get(SYNC_BACKEND_KEY)).toBe('cloud');
        expect(harness.storage.get(CLOUD_PROVIDER_KEY)).toBe('dropbox');
        expect(harness.getDropboxTokens()).toEqual(OLD_DROPBOX_TOKENS);
        expect(harness.events.lastIndexOf(`set:${SYNC_BACKEND_KEY}:cloud`)).toBeGreaterThan(
            harness.events.lastIndexOf(`save-dropbox:${OLD_DROPBOX_TOKENS.accessToken}`),
        );
    });

    // Desktop verifies its whole persisted configuration after disabling the
    // backend, so a disable that perturbs a transport aborts before any
    // credential is written. Mobile proves the same over the snapshot's own key
    // footprint.
    it('aborts before writing the candidate when disabling sync perturbs a transport', async () => {
        const harness = createHarness({
            [SYNC_BACKEND_KEY]: 'webdav',
            [WEBDAV_URL_KEY]: 'https://old.example.test/dav',
            [WEBDAV_USERNAME_KEY]: 'old-user',
            [WEBDAV_ALLOW_INSECURE_HTTP_KEY]: 'false',
        }, {
            [WEBDAV_PASSWORD_KEY]: 'old-password',
        });
        const { setItem } = harness.dependencies;
        let tampered = false;
        harness.dependencies.setItem = async (key, value) => {
            await setItem(key, value);
            if (!tampered && key === SYNC_BACKEND_KEY && value === 'off') {
                tampered = true;
                harness.storage.set(WEBDAV_URL_KEY, 'https://tampered.example.test/dav');
            }
        };

        await expect(commitProvenMobileSyncConfiguration({
            backend: 'webdav',
            webdav: {
                url: 'https://new.example.test/dav',
                username: 'new-user',
                password: 'new-password',
                allowInsecureHttp: false,
            },
        }, harness.dependencies)).rejects.toThrow(/Disabling sync changed the persisted transport configuration/);

        // Asserting the stored values alone would also pass if rollback had
        // rewritten every slot, so pin the scoping directly: the candidate's
        // secret never reaches the store, and the untouched cloud bundle is never
        // written. The webdav secret IS rewritten — the perturbed url marks that
        // whole bundle touched — but only ever with the prior value.
        expect(harness.events.some((event) => event.includes(':new-password'))).toBe(false);
        expect(harness.events).toContain(`set-secret:${WEBDAV_PASSWORD_KEY}:old-password`);
        expect(harness.events).not.toContain(CLOUD_WRITE);
        expect(harness.events.some((event) => event.startsWith(`set:${CLOUD_PROVIDER_KEY}:`))).toBe(false);
        expect(harness.secrets.get(WEBDAV_PASSWORD_KEY)).toBe('old-password');
        expect(harness.storage.get(WEBDAV_URL_KEY)).toBe('https://old.example.test/dav');
        expect(harness.storage.get(SYNC_BACKEND_KEY)).toBe('webdav');
    });

    // #1043: a prior secret can become unreadable while its endpoint stays
    // configured. Re-entering it must work, which it only does because the
    // tolerant read makes the unreadable prior opaque rather than absent.
    it('commits a re-entered password over an unreadable prior secret', async () => {
        const harness = createHarness({
            [SYNC_BACKEND_KEY]: 'webdav',
            [WEBDAV_URL_KEY]: 'https://old.example.test/dav',
            [WEBDAV_USERNAME_KEY]: 'old-user',
            [WEBDAV_ALLOW_INSECURE_HTTP_KEY]: 'false',
        }, {
            [WEBDAV_PASSWORD_KEY]: 'unreadable-password',
        });
        const { getSecret, setSecret } = harness.dependencies;
        let readable = false;
        harness.dependencies.getSecret = async (key) => {
            if (key === WEBDAV_PASSWORD_KEY && !readable) {
                throw new Error('keystore is unavailable');
            }
            return getSecret(key);
        };
        harness.dependencies.setSecret = async (key, value) => {
            await setSecret(key, value);
            if (key === WEBDAV_PASSWORD_KEY) readable = true;
        };

        await commitProvenMobileSyncConfiguration({
            backend: 'webdav',
            webdav: {
                url: 'https://new.example.test/dav',
                username: 'new-user',
                password: 're-entered-password',
                allowInsecureHttp: false,
            },
        }, harness.dependencies);

        expect(harness.secrets.get(WEBDAV_PASSWORD_KEY)).toBe('re-entered-password');
        expect(harness.storage.get(SYNC_BACKEND_KEY)).toBe('webdav');
    });

    // Settings restore keys off the literal 'cloudkit' in the provider slot
    // (use-sync-settings-transport-actions.ts), which the canonical
    // 'dropbox' | 'selfhosted' union cannot express.
    it.each<{ label: string; stored: Record<string, string> }>([
        { label: 'over a Dropbox provider', stored: { [CLOUD_PROVIDER_KEY]: 'dropbox' } },
        { label: 'on a fresh install', stored: {} },
    ])('stores the cloudkit provider literal $label', async ({ stored }) => {
        const harness = createHarness({ [SYNC_BACKEND_KEY]: 'off', ...stored });

        await commitProvenMobileSyncConfiguration({ backend: 'cloudkit' }, harness.dependencies);

        expect(harness.storage.get(CLOUD_PROVIDER_KEY)).toBe('cloudkit');
        expect(harness.storage.get(SYNC_BACKEND_KEY)).toBe('cloudkit');
    });

    it('writes the sync path and its bookmark in one batch', async () => {
        const harness = createHarness({ [SYNC_BACKEND_KEY]: 'off' });

        await commitProvenMobileSyncConfiguration({
            backend: 'file',
            syncPath: '/sync/folder',
            syncPathBookmark: 'bookmark-blob',
        }, harness.dependencies);

        expect(harness.events).toContain(`multi-set:${SYNC_PATH_KEY},${SYNC_PATH_BOOKMARK_KEY}`);
        expect(harness.storage.get(SYNC_PATH_BOOKMARK_KEY)).toBe('bookmark-blob');
    });

    it('leaves sync off and does not reactivate a partially restored configuration', async () => {
        const harness = createHarness({
            [SYNC_BACKEND_KEY]: 'cloud',
            [CLOUD_PROVIDER_KEY]: 'dropbox',
        }, {}, OLD_DROPBOX_TOKENS, {
            failCandidateActivation: true,
            failDropboxRollback: true,
        });

        const error = await commitProvenMobileSyncConfiguration({
            backend: 'cloud',
            cloudProvider: 'dropbox',
            dropbox: { tokens: NEW_DROPBOX_TOKENS },
        }, harness.dependencies).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(MobileSyncConfigurationTransactionError);
        expect((error as MobileSyncConfigurationTransactionError).syncRemainsDisabled).toBe(true);
        expect(String(error)).toContain('sync remains disabled');
        expect(harness.storage.get(SYNC_BACKEND_KEY)).toBe('off');
        expect(harness.getDropboxTokens()).toEqual(NEW_DROPBOX_TOKENS);
        expect(harness.events.filter((event) => event.startsWith(`set:${SYNC_BACKEND_KEY}:`)).at(-1))
            .toBe(backendWrite('off'));
    });
});

// Characterization goldens for the sync-configuration commit protocol, matching
// the desktop golden scenario matrix step for step so the two platforms'
// protocols can be compared directly. Treat a change here as a protocol change,
// not a test update.
describe('mobile commit protocol goldens', () => {
    type GoldenFailure = {
        /** Throw on the candidate's transport write (before it is verified). */
        transportWrite?: boolean;
        /** Throw when the backend key is set to this value. */
        activation?: string;
        /** Throw on the transport write inside the restore path. */
        transportRestore?: boolean;
    };

    // Decorates the shared harness so reads are recorded too — desktop's golden
    // records every verification read, and the verify steps are the part of the
    // protocol being compared.
    const goldenHarness = (
        initialStorage: Record<string, string>,
        initialSecrets: Record<string, string> = {},
        initialDropboxTokens: DropboxAuthTokens | null = null,
        failure: GoldenFailure = {},
    ) => {
        const harness = createHarness(initialStorage, initialSecrets, initialDropboxTokens);
        const { dependencies, events } = harness;
        const { getDropboxTokens, getSecret, multiGet, multiSet, setItem } = dependencies;
        let restoreStarted = false;

        dependencies.multiGet = async (keys) => {
            events.push(`read:${keys.join(',')}`);
            return multiGet(keys);
        };
        dependencies.getSecret = async (key) => {
            events.push(`read-secret:${key}`);
            return getSecret(key);
        };
        dependencies.getDropboxTokens = async () => {
            events.push('read-dropbox');
            return getDropboxTokens();
        };
        dependencies.multiSet = async (entries) => {
            if (failure.transportWrite && !restoreStarted) {
                restoreStarted = true;
                events.push(`multi-set:${entries.map(([key]) => key).join(',')}`);
                throw new Error('injected transport failure');
            }
            if (failure.transportRestore && restoreStarted) {
                events.push(`multi-set:${entries.map(([key]) => key).join(',')}`);
                throw new Error('injected restore failure');
            }
            return multiSet(entries);
        };
        dependencies.setItem = async (key, value) => {
            if (failure.activation && key === SYNC_BACKEND_KEY && value === failure.activation && !restoreStarted) {
                restoreStarted = true;
                events.push(`set:${key}:${value}`);
                throw new Error('injected activation failure');
            }
            return setItem(key, value);
        };

        return harness;
    };

    const activeCloudStorage = () => ({
        [SYNC_BACKEND_KEY]: 'cloud',
        [CLOUD_PROVIDER_KEY]: 'selfhosted',
    });
    const activeWebdavStorage = () => ({
        [SYNC_BACKEND_KEY]: 'webdav',
        [WEBDAV_URL_KEY]: 'https://old-dav.example.com',
        [WEBDAV_USERNAME_KEY]: 'old-user',
        [WEBDAV_ALLOW_INSECURE_HTTP_KEY]: 'false',
    });
    const GOLDEN_WEBDAV = {
        url: 'https://golden-dav.example.com',
        username: 'golden-user',
        password: 'golden-password',
        allowInsecureHttp: false,
    };

    it('G1 file candidate over an active cloud backend', async () => {
        const harness = goldenHarness(activeCloudStorage());

        await commitProvenMobileSyncConfiguration(
            { backend: 'file', syncPath: '/golden/file-sync' },
            harness.dependencies,
        );

        expect(harness.events).toEqual([
            ...READ_CONFIG,
            backendWrite('off'),
            'clear-cache',
            ...READ_CONFIG,
            `multi-set:${SYNC_PATH_KEY}`,
            `remove:${SYNC_PATH_BOOKMARK_KEY}`,
            'clear-cache',
            ...READ_CONFIG,
            backendWrite('file'),
            'clear-cache',
            ...READ_CONFIG,
        ]);
    });

    it('G2 webdav candidate with a replacement password', async () => {
        const harness = goldenHarness(activeWebdavStorage(), {
            [WEBDAV_PASSWORD_KEY]: 'old-password',
        });

        await commitProvenMobileSyncConfiguration(
            { backend: 'webdav', webdav: GOLDEN_WEBDAV },
            harness.dependencies,
        );

        expect(harness.events).toEqual([
            ...READ_CONFIG,
            backendWrite('off'),
            'clear-cache',
            ...READ_CONFIG,
            WEBDAV_WRITE,
            `set-secret:${WEBDAV_PASSWORD_KEY}:golden-password`,
            'clear-cache',
            ...READ_CONFIG,
            backendWrite('webdav'),
            'clear-cache',
            ...READ_CONFIG,
        ]);
    });

    it('G3 self-hosted cloud candidate with a replacement token', async () => {
        const harness = goldenHarness(activeCloudStorage());

        await commitProvenMobileSyncConfiguration({
            backend: 'cloud',
            cloudProvider: 'selfhosted',
            cloud: {
                url: 'https://golden-cloud.example.com',
                token: 'golden-token',
                allowInsecureHttp: false,
            },
        }, harness.dependencies);

        expect(harness.events).toEqual([
            ...READ_CONFIG,
            backendWrite('off'),
            'clear-cache',
            ...READ_CONFIG,
            CLOUD_WRITE,
            `set-secret:${CLOUD_TOKEN_KEY}:golden-token`,
            'clear-cache',
            `set:${CLOUD_PROVIDER_KEY}:selfhosted`,
            'clear-cache',
            ...READ_CONFIG,
            backendWrite('cloud'),
            'clear-cache',
            ...READ_CONFIG,
        ]);
    });

    it('G4 dropbox candidate carrying new tokens', async () => {
        const harness = goldenHarness({
            [SYNC_BACKEND_KEY]: 'cloud',
            [CLOUD_PROVIDER_KEY]: 'dropbox',
        }, {}, OLD_DROPBOX_TOKENS);

        await commitProvenMobileSyncConfiguration({
            backend: 'cloud',
            cloudProvider: 'dropbox',
            dropbox: { tokens: NEW_DROPBOX_TOKENS },
        }, harness.dependencies);

        expect(harness.events).toEqual([
            ...READ_CONFIG,
            backendWrite('off'),
            'clear-cache',
            ...READ_CONFIG,
            `set:${CLOUD_PROVIDER_KEY}:dropbox`,
            'clear-cache',
            ...READ_CONFIG,
            'read-dropbox',
            `save-dropbox:${NEW_DROPBOX_TOKENS.accessToken}`,
            'clear-cache',
            ...READ_CONFIG,
            backendWrite('cloud'),
            'clear-cache',
            ...READ_CONFIG,
        ]);
    });

    it('G5 transport write fails mid-candidate', async () => {
        const harness = goldenHarness(activeWebdavStorage(), {
            [WEBDAV_PASSWORD_KEY]: 'old-password',
        }, null, { transportWrite: true });

        await expect(commitProvenMobileSyncConfiguration(
            { backend: 'webdav', webdav: GOLDEN_WEBDAV },
            harness.dependencies,
        )).rejects.toThrow('injected transport failure');

        expect(harness.events).toEqual([
            ...READ_CONFIG,
            backendWrite('off'),
            'clear-cache',
            ...READ_CONFIG,
            WEBDAV_WRITE,
            backendWrite('off'),
            'clear-cache',
            ...READ_CONFIG,
            backendWrite('off'),
            'clear-cache',
            ...READ_CONFIG,
            WEBDAV_WRITE,
            `set-secret:${WEBDAV_PASSWORD_KEY}:old-password`,
            'clear-cache',
            ...READ_CONFIG,
            backendWrite('webdav'),
            'clear-cache',
            ...READ_CONFIG,
        ]);
    });

    it('G6 activation fails after the candidate verified', async () => {
        const harness = goldenHarness(activeWebdavStorage(), {
            [WEBDAV_PASSWORD_KEY]: 'old-password',
        }, null, { activation: 'webdav' });

        await expect(commitProvenMobileSyncConfiguration(
            { backend: 'webdav', webdav: GOLDEN_WEBDAV },
            harness.dependencies,
        )).rejects.toThrow('injected activation failure');

        expect(harness.events).toEqual([
            ...READ_CONFIG,
            backendWrite('off'),
            'clear-cache',
            ...READ_CONFIG,
            WEBDAV_WRITE,
            `set-secret:${WEBDAV_PASSWORD_KEY}:golden-password`,
            'clear-cache',
            ...READ_CONFIG,
            backendWrite('webdav'),
            backendWrite('off'),
            'clear-cache',
            ...READ_CONFIG,
            backendWrite('off'),
            'clear-cache',
            ...READ_CONFIG,
            WEBDAV_WRITE,
            `set-secret:${WEBDAV_PASSWORD_KEY}:old-password`,
            'clear-cache',
            ...READ_CONFIG,
            backendWrite('webdav'),
            'clear-cache',
            ...READ_CONFIG,
        ]);
    });

    it('G7 restore itself fails and sync stays disabled', async () => {
        const harness = goldenHarness(activeWebdavStorage(), {
            [WEBDAV_PASSWORD_KEY]: 'old-password',
        }, null, { activation: 'webdav', transportRestore: true });

        await expect(commitProvenMobileSyncConfiguration(
            { backend: 'webdav', webdav: GOLDEN_WEBDAV },
            harness.dependencies,
        )).rejects.toThrow(/sync remains disabled/i);

        expect(harness.events).toEqual([
            ...READ_CONFIG,
            backendWrite('off'),
            'clear-cache',
            ...READ_CONFIG,
            WEBDAV_WRITE,
            `set-secret:${WEBDAV_PASSWORD_KEY}:golden-password`,
            'clear-cache',
            ...READ_CONFIG,
            backendWrite('webdav'),
            backendWrite('off'),
            'clear-cache',
            ...READ_CONFIG,
            backendWrite('off'),
            'clear-cache',
            ...READ_CONFIG,
            WEBDAV_WRITE,
            backendWrite('off'),
            'clear-cache',
        ]);
    });
});
