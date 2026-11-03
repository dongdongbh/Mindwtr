


import {
    commitProvenSyncConfiguration,
    type PersistedSyncConfiguration,
    type SecretAuthority,
    type SyncConfigurationCandidate,
    type SyncConfigurationPort,
} from './sync-configuration-transaction';
import { normalizeCloudProvider } from './sync-client-helpers';
import { SyncEncryptionTransitionIncompleteError, type SyncEncryptionTransitionKind } from './sync-encryption';
import { normalizeSyncBackend } from './sync-service-utils';
import type { DropboxAuthTokens } from './dropbox-auth-tokens';
import type { MobileSyncConfigOverride } from './mobile-sync-service';
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
} from './sync-storage-keys';

type StorageEntry = readonly [string, string];
type StorageSnapshotEntry = readonly [string, string | null];

export type MobileSyncConfigurationTransactionDependencies = {
    clearConfigCache: () => void;
    clearDropboxTokens: () => Promise<void>;
    deleteSecret: (key: string) => Promise<void>;
    getDropboxTokens: () => Promise<DropboxAuthTokens | null>;
    getIncompleteSyncEncryptionTransition: () => Promise<SyncEncryptionTransitionKind | null>;
    getSecret: (key: string) => Promise<string | null>;
    multiGet: (keys: string[]) => Promise<readonly StorageSnapshotEntry[]>;
    multiSet: (entries: StorageEntry[]) => Promise<void>;
    removeItem: (key: string) => Promise<void>;
    saveDropboxTokens: (tokens: DropboxAuthTokens) => Promise<void>;
    setItem: (key: string, value: string) => Promise<void>;
    setSecret: (key: string, value: string) => Promise<void>;
};

export class MobileSyncConfigurationTransactionError extends Error {
    readonly syncRemainsDisabled: boolean;

    constructor(message: string, syncRemainsDisabled: boolean) {
        super(message);
        this.name = 'MobileSyncConfigurationTransactionError';
        this.syncRemainsDisabled = syncRemainsDisabled;
    }
}


const STAGED_DROPBOX_HANDLE = 'mobile-staged-dropbox-credentials';

const CONFIGURATION_KEYS = [
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

const serializeBool = (value: boolean): string => (value ? 'true' : 'false');
const parseBool = (value: string | null): boolean => value === 'true';

const errorMessage = (error: unknown): string => {
    if (error instanceof Error && error.message.trim()) return error.message.trim();
    const text = String(error ?? '').trim();
    return text || 'Unknown sync configuration error';
};

const createPort = (
    candidate: MobileSyncConfigOverride,
    dependencies: MobileSyncConfigurationTransactionDependencies,
): SyncConfigurationPort => {
    const stagedTokens = candidate.dropbox?.tokens ?? null;
    let previousTokens: DropboxAuthTokens | null = null;
    let capturedPreviousTokens = false;


    const readSecret = async (
        key: string,
    ): Promise<{ value: string | null; authority: SecretAuthority }> => {
        try {
            return { value: await dependencies.getSecret(key), authority: 'known' };
        } catch {
            return { value: null, authority: 'opaque' };
        }
    };

    const writeSecret = async (key: string, value: string): Promise<void> => {
        if (value) {
            await dependencies.setSecret(key, value);
            return;
        }
        await dependencies.deleteSecret(key);
    };

    return {
        recoverDropboxCredentialsBeforeConfiguration: async () => undefined,


        readConfiguration: async (requirements = {}): Promise<PersistedSyncConfiguration> => {
            const stored = new Map(await dependencies.multiGet(CONFIGURATION_KEYS));
            const value = (key: string): string | null => stored.get(key) ?? null;
            const webdavSecret = await readSecret(WEBDAV_PASSWORD_KEY);
            const cloudSecret = await readSecret(CLOUD_TOKEN_KEY);
            if (requirements.requireWebdavPassword && webdavSecret.authority === 'opaque') {
                throw new Error('WebDAV password is unavailable');
            }
            if (requirements.requireCloudToken && cloudSecret.authority === 'opaque') {
                throw new Error('Self-hosted token is unavailable');
            }
            return {
                backend: normalizeSyncBackend(value(SYNC_BACKEND_KEY)),
                syncPath: value(SYNC_PATH_KEY) ?? '',
                syncPathBookmark: value(SYNC_PATH_BOOKMARK_KEY),
                webdav: {
                    url: value(WEBDAV_URL_KEY) ?? '',
                    username: value(WEBDAV_USERNAME_KEY) ?? '',
                    password: webdavSecret.value,
                    passwordAuthority: webdavSecret.authority,
                    hasPassword: webdavSecret.authority === 'known'
                        ? Boolean(webdavSecret.value)
                        : null,
                    allowInsecureHttp: parseBool(value(WEBDAV_ALLOW_INSECURE_HTTP_KEY)),
                    allowWeakFingerprint: parseBool(value(WEBDAV_ALLOW_WEAK_FINGERPRINT_KEY)),
                },
                cloudProvider: normalizeCloudProvider(value(CLOUD_PROVIDER_KEY)),
                cloud: {
                    url: value(CLOUD_URL_KEY) ?? '',
                    token: cloudSecret.value,
                    tokenAuthority: cloudSecret.authority,
                    allowInsecureHttp: parseBool(value(CLOUD_ALLOW_INSECURE_HTTP_KEY)),


                    rememberToken: true,
                },
            };
        },

        writeBackend: async (backend) => {
            await dependencies.setItem(SYNC_BACKEND_KEY, backend);
            dependencies.clearConfigCache();
        },

        writeSyncPath: async (path, bookmark) => {


            const entries: StorageEntry[] = [[SYNC_PATH_KEY, path]];
            if (bookmark) entries.push([SYNC_PATH_BOOKMARK_KEY, bookmark]);
            await dependencies.multiSet(entries);
            if (!bookmark) await dependencies.removeItem(SYNC_PATH_BOOKMARK_KEY);
            dependencies.clearConfigCache();
            return { success: true, path };
        },

        clearSyncPath: async () => {
            await dependencies.removeItem(SYNC_PATH_KEY);
            await dependencies.removeItem(SYNC_PATH_BOOKMARK_KEY);
            dependencies.clearConfigCache();
        },

        writeWebDav: async (webdav) => {
            await dependencies.multiSet([
                [WEBDAV_URL_KEY, webdav.url],
                [WEBDAV_USERNAME_KEY, webdav.username],
                [WEBDAV_ALLOW_INSECURE_HTTP_KEY, serializeBool(webdav.allowInsecureHttp)],
                [WEBDAV_ALLOW_WEAK_FINGERPRINT_KEY, serializeBool(webdav.allowWeakFingerprint)],
            ]);
            await writeSecret(WEBDAV_PASSWORD_KEY, webdav.password);
            dependencies.clearConfigCache();
        },

        writeCloud: async (cloud) => {
            await dependencies.multiSet([
                [CLOUD_URL_KEY, cloud.url],
                [CLOUD_ALLOW_INSECURE_HTTP_KEY, serializeBool(cloud.allowInsecureHttp)],
            ]);
            await writeSecret(CLOUD_TOKEN_KEY, cloud.token);
            dependencies.clearConfigCache();
        },

        writeCloudProvider: async (provider) => {


            await dependencies.setItem(
                CLOUD_PROVIDER_KEY,
                candidate.backend === 'cloudkit' ? 'cloudkit' : provider,
            );
            dependencies.clearConfigCache();
        },

        promoteDropboxCredentials: async () => {
            if (!capturedPreviousTokens) {
                previousTokens = await dependencies.getDropboxTokens();
                capturedPreviousTokens = true;
            }
            if (stagedTokens) await dependencies.saveDropboxTokens(stagedTokens);
            dependencies.clearConfigCache();
        },


        discardDropboxCredentials: async () => undefined,

        rollbackDropboxCredentials: async () => {
            if (!capturedPreviousTokens) return;
            if (previousTokens) {
                await dependencies.saveDropboxTokens(previousTokens);
            } else {
                await dependencies.clearDropboxTokens();
            }
            dependencies.clearConfigCache();
        },


        finalizeDropboxCredentials: async () => undefined,
    };
};

const toCandidate = (candidate: MobileSyncConfigOverride): SyncConfigurationCandidate => ({
    backend: candidate.backend,
    syncPath: candidate.syncPath,
    syncPathBookmark: candidate.syncPathBookmark ?? null,
    webdav: candidate.webdav,


    cloudProvider: candidate.backend === 'cloudkit'
        ? 'selfhosted'
        : candidate.cloudProvider,
    cloud: candidate.cloud,
    dropboxCredentialHandle: candidate.dropbox?.tokens ? STAGED_DROPBOX_HANDLE : undefined,
});


export async function commitProvenMobileSyncConfiguration(
    candidate: MobileSyncConfigOverride,
    dependencies: MobileSyncConfigurationTransactionDependencies,
): Promise<void> {
    try {
        const incompleteTransition = await dependencies.getIncompleteSyncEncryptionTransition();
        if (incompleteTransition) {
            throw new SyncEncryptionTransitionIncompleteError(incompleteTransition);
        }
        await commitProvenSyncConfiguration(toCandidate(candidate), createPort(candidate, dependencies));
    } catch (error) {
        const syncRemainsDisabled = Boolean(
            (error as { syncRemainsDisabled?: boolean } | null)?.syncRemainsDisabled,
        );
        if (!syncRemainsDisabled) throw error;
        throw new MobileSyncConfigurationTransactionError(errorMessage(error), true);
    }
}
