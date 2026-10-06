/**
 * Settings › Sync's transport actions: choosing a backend, the WebDAV and
 * self-hosted forms, the File Sync folder, Dropbox sign-in, Test connection,
 * Save and Sync now. It moved here from React Native's
 * `apps/mobile/components/settings/use-sync-settings-transport-actions.ts`
 * (the hook is now a binding) so the native apps run the same rules; each host
 * binds its device store, secret store, sync service, folder picker, Dropbox
 * sign-in and toasts through `SyncSettingsTransportHost`.
 *
 * Data safety: a candidate configuration is only ever saved after its first
 * successful round trip (the activation probe, then
 * `commitProvenMobileSyncConfiguration`). Choosing a backend whose settings are
 * incomplete only stages it on screen; leaving the screen drops it.
 *
 * One controller is one screen visit, as one hook instance was: `load` reads the
 * stored configuration, the handlers keep React Native's names, and `subscribe`
 * reports each state change.
 */
import { CLOCK_SKEW_THRESHOLD_MS as CORE_CLOCK_SKEW_THRESHOLD_MS, type MergeStats } from './sync-types';
import { cloudGetJson, isValidCloudSyncToken } from './cloud';
import { isDropboxUnauthorizedError as isCoreDropboxUnauthorizedError } from './dropbox';
import type { DropboxAccessTokenResolution, DropboxAuthTokens } from './dropbox-auth-tokens';
import type { I18nTemplateValues } from './i18n';
import {
    commitProvenMobileSyncConfiguration,
    MobileSyncConfigurationTransactionError,
    type MobileSyncConfigurationTransactionDependencies,
} from './mobile-sync-configuration-transaction';
import type { MobileDropboxSyncCredentials, MobileSyncConfigOverride } from './mobile-sync-service';
import { NativeAttachmentCleanupUnconfirmedError } from './native-attachment-cleanup';
import {
    coerceSupportedBackend,
    getMobileCloudRequestOptions,
    getMobileWebDavRequestOptions,
    getSyncConflictCount,
    getSyncMaxClockSkewMs,
    getSyncTimestampAdjustments,
    hasSameUserFacingSyncConflictSummary,
} from './mobile-sync-utils';
import { isConnectionAllowed, SYNC_LOCAL_INSECURE_URL_OPTIONS } from './http-utils';
import { addBreadcrumb } from './log-breadcrumbs';
import { SyncEncryptionRemoteVersionUnavailableError, isSyncEncryptionRemoteVersionUnavailableError, type SyncEncryptionTransitionKind } from './sync-encryption';
import { normalizeCloudUrl, normalizeWebdavUrl } from './sync-helpers';
import type { SyncRunResult } from './sync-run-ports';
import { isLikelyOfflineSyncError } from './sync-service-utils';
import { formatSyncClockSkew, isValidSyncHttpUrl, redactSyncText, type CloudKitAccountStatus, type SyncSettingsBackend, type SyncSettingsCloudProvider } from './sync-settings-model';
import {
    CLOUD_ALLOW_INSECURE_HTTP_KEY,
    CLOUD_PROVIDER_KEY,
    CLOUD_TOKEN_KEY,
    CLOUD_URL_KEY,
    SYNC_BACKEND_KEY,
    SYNC_PATH_BOOKMARK_KEY,
    SYNC_PATH_KEY,
    WEBDAV_ALLOW_INSECURE_HTTP_KEY,
    WEBDAV_PASSWORD_KEY,
    WEBDAV_URL_KEY,
    WEBDAV_USERNAME_KEY,
} from './sync-storage-keys';
import type { AppSettings } from './types';
import { probeWebdavSyncCompatibility } from './webdav';

export type SyncSettingsWebDavFields = {
    allowInsecureHttp: boolean;
    password: string;
    url: string;
    username: string;
};

export type SyncSettingsSelfHostedFields = {
    allowInsecureHttp: boolean;
    token: string;
    url: string;
};

export type SyncSettingsActionOptions = {
    backend?: 'file' | 'webdav' | 'cloud' | 'cloudkit';
    cloud?: SyncSettingsSelfHostedFields;
    cloudProvider?: SyncSettingsCloudProvider;
    // The folder picker activates the folder it just picked, before the state
    // set in the same tick is visible to this hook's closures.
    syncPath?: string | null;
    syncPathBookmark?: string | null;
    webdav?: SyncSettingsWebDavFields;
};

export type SyncSettingsToastTone = 'warning' | 'error' | 'success' | 'info';
export type SyncSettingsToast = { durationMs?: number; message: string; title: string; tone: SyncSettingsToastTone };

/** The screen's inputs (React Native: the hook's props), read at the start of each action. */
export type SyncSettingsTransportParams = {
    dropboxAppKey: string;
    dropboxConfigured: boolean;
    getCloudKitStatusDetails: (status: CloudKitAccountStatus) => { helpText: string; syncEnabled: boolean };
    getSyncFailureToastMessage: (error: unknown) => string;
    isExpoGo: boolean;
    isFossBuild: boolean;
    lastSyncStats: AppSettings['lastSyncStats'] | null | undefined;
    lastSyncStatus: AppSettings['lastSyncStatus'] | undefined;
    tr: (key: string, values?: I18nTemplateValues) => string;
    resetSyncStatusForBackendSwitch: () => void;
    showSettingsErrorToast: (title: string, message: string, durationMs?: number) => void;
    showSettingsWarning: (title: string, message: string, durationMs?: number) => void;
    showToast: (toast: SyncSettingsToast) => void;
    supportsNativeICloudSync: boolean;
    t: (key: string) => string;
};

export type SyncSettingsSyncResult = SyncRunResult & {
    offlineCause?: 'network' | 'request';
    activationProof?: 'remote-encrypted-no-key';
};

type StorageEntry = readonly [string, string];

/** A device write that failed: the screen kept the stored value, and the caller may retry. */
export class SyncSettingsWriteError extends Error {
    /** `message` is already redacted (the transport's `redactText`). */
    constructor(message: string) {
        super(message);
        this.name = 'SyncSettingsWriteError';
    }
}

/** Cancels a read for a screen that leaves first; `done` settles once the read is applied. */
export type SyncSettingsCancel = (() => void) & { done: Promise<void> };

/** Core functions called through here so a host's tests can replace them the way they replace `@mindwtr/core`. */
export type SyncSettingsTransportCoreFunctions = {
    addBreadcrumb: (message: string) => void;
    CLOCK_SKEW_THRESHOLD_MS: number;
    cloudGetJson: typeof cloudGetJson;
    isConnectionAllowed: typeof isConnectionAllowed;
    isSyncEncryptionRemoteVersionUnavailableError: (error: unknown) => boolean;
    isValidCloudSyncToken: (token: string) => boolean;
    normalizeCloudUrl: (url: string) => string;
    normalizeWebdavUrl: (url: string) => string;
    probeWebdavSyncCompatibility: typeof probeWebdavSyncCompatibility;
    SyncEncryptionRemoteVersionUnavailableError: new (target: string) => Error;
    SYNC_LOCAL_INSECURE_URL_OPTIONS: typeof SYNC_LOCAL_INSECURE_URL_OPTIONS;
    coerceSupportedBackend: (backend: SyncSettingsBackend, allowCloudKit: boolean) => SyncSettingsBackend;
    getSyncConflictCount: (stats?: MergeStats | null) => number;
    getSyncMaxClockSkewMs: (stats?: MergeStats | null) => number;
    getSyncTimestampAdjustments: (stats?: MergeStats | null) => number;
    hasSameUserFacingSyncConflictSummary: (current?: MergeStats | null, previous?: MergeStats | null) => boolean;
    isLikelyOfflineSyncError: (errorOrMessage: unknown) => boolean;
    formatClockSkew: (ms: number) => string;
    formatError: (error: unknown) => string;
    isDropboxUnauthorizedError: (error: unknown) => boolean;
};

const CORE_FUNCTIONS: SyncSettingsTransportCoreFunctions = {
    addBreadcrumb,
    CLOCK_SKEW_THRESHOLD_MS: CORE_CLOCK_SKEW_THRESHOLD_MS,
    cloudGetJson,
    isConnectionAllowed,
    isSyncEncryptionRemoteVersionUnavailableError,
    isValidCloudSyncToken,
    normalizeCloudUrl,
    normalizeWebdavUrl,
    probeWebdavSyncCompatibility,
    SyncEncryptionRemoteVersionUnavailableError,
    SYNC_LOCAL_INSECURE_URL_OPTIONS,
    coerceSupportedBackend,
    getSyncConflictCount,
    getSyncMaxClockSkewMs,
    getSyncTimestampAdjustments,
    hasSameUserFacingSyncConflictSummary,
    isLikelyOfflineSyncError,
    formatClockSkew: formatSyncClockSkew,
    formatError: (error) => (error instanceof Error ? error.message : String(error)),
    isDropboxUnauthorizedError: isCoreDropboxUnauthorizedError,
};

/** Dropbox sign-in and tokens (React Native: `dropbox-oauth.ts`, `dropbox-auth.ts`, `dropbox-sync.ts`). */
export type SyncSettingsDropboxPort = {
    authorize(clientId: string): Promise<DropboxAuthTokens>;
    redirectUri(): string;
    isConnected(): Promise<boolean>;
    disconnect(clientId: string): Promise<void>;
    clearTokens(): Promise<void>;
    revokeTokens(clientId: string, tokens: DropboxAuthTokens): Promise<void>;
    getStoredTokens(): Promise<DropboxAuthTokens | null>;
    saveTokens(tokens: DropboxAuthTokens): Promise<void>;
    getValidAccessToken(clientId: string): Promise<string>;
    forceRefreshAccessToken(clientId: string): Promise<string>;
    getValidAccessTokenForTokens(clientId: string, tokens: DropboxAuthTokens): Promise<DropboxAccessTokenResolution>;
    forceRefreshAccessTokenForTokens(clientId: string, tokens: DropboxAuthTokens): Promise<DropboxAccessTokenResolution>;
    testAccess(accessToken: string): Promise<unknown>;
};

export type SyncSettingsTransportHost = {
    params(): SyncSettingsTransportParams;
    /** The device key-value store (React Native: AsyncStorage). */
    storage: {
        multiGet(keys: string[]): Promise<readonly (readonly [string, string | null])[]>;
        setItem(key: string, value: string): Promise<void>;
        multiSet(entries: StorageEntry[]): Promise<void>;
        removeItem(key: string): Promise<void>;
    };
    /** The secure sync config (React Native: `secure-config.ts`). */
    secrets: {
        get(key: string): Promise<string | null>;
        set(key: string, value: string): Promise<void>;
        delete(key: string): Promise<void>;
    };
    platform: { os(): string };
    logInfo(message: string, context: { scope: string; extra: Record<string, string> }): unknown;
    logSettingsError(error: unknown): void;
    performSync(syncPathOverride: string | undefined, options: {
        manual?: boolean;
        activationProbe?: boolean;
        ignorePendingRemoteWriteBackoff?: boolean;
        configOverride?: MobileSyncConfigOverride;
    }): Promise<SyncSettingsSyncResult>;
    clearSyncConfigCache(): void;
    reconcileBackgroundSync(): Promise<unknown>;
    /**
     * The folder picker. Answers the picked document (`__fileUri`, and on iOS a
     * `__fileBookmark`), or null when the user cancels.
     */
    pickSyncFolder(): Promise<unknown>;
    getCloudKitAccountStatus(): Promise<CloudKitAccountStatus>;
    rememberWebdavCapabilityProof(config: SyncSettingsWebDavFields): Promise<void>;
    encryption: {
        getStatus(): Promise<{ state: string; incompleteTransition?: unknown }>;
        getIncompleteTransition(): Promise<SyncEncryptionTransitionKind | null>;
    };
    dropbox: SyncSettingsDropboxPort;
    core?: Partial<SyncSettingsTransportCoreFunctions>;
};

export type SyncSettingsTransportState = {
    cloudKitAccountStatus: CloudKitAccountStatus;
    cloudAllowInsecureHttp: boolean;
    cloudProvider: SyncSettingsCloudProvider;
    cloudToken: string;
    cloudUrl: string;
    dropboxBusy: boolean;
    dropboxConnected: boolean;
    isSyncing: boolean;
    isTestingConnection: boolean;
    syncBackend: SyncSettingsBackend;
    syncPath: string | null;
    syncPathBookmark: string | null;
    webdavAllowInsecureHttp: boolean;
    webdavPassword: string;
    webdavUrl: string;
    webdavUsername: string;
};

const INITIAL_STATE: SyncSettingsTransportState = {
    cloudKitAccountStatus: 'unknown',
    cloudAllowInsecureHttp: false,
    cloudProvider: 'selfhosted',
    cloudToken: '',
    cloudUrl: '',
    dropboxBusy: false,
    dropboxConnected: false,
    isSyncing: false,
    isTestingConnection: false,
    syncBackend: 'off',
    syncPath: null,
    syncPathBookmark: null,
    webdavAllowInsecureHttp: false,
    webdavPassword: '',
    webdavUrl: '',
    webdavUsername: '',
};

export function createSyncSettingsTransport(host: SyncSettingsTransportHost) {
    const core: SyncSettingsTransportCoreFunctions = { ...CORE_FUNCTIONS, ...host.core };
    let state = INITIAL_STATE;
    const listeners = new Set<() => void>();
    const set = (patch: Partial<SyncSettingsTransportState>) => {
        state = { ...state, ...patch };
        for (const listener of listeners) listener();
    };

    let provenSyncBackend: SyncSettingsBackend = 'off';
    let provenCloudProvider: SyncSettingsCloudProvider = 'selfhosted';
    let hasPendingSyncConfiguration = false;
    let stagedDropboxCredentials: MobileDropboxSyncCredentials | null = null;

    const reconcileBackgroundSyncRegistration = () => {
        void host.reconcileBackgroundSync().catch((error) => {
            if (!(error instanceof NativeAttachmentCleanupUnconfirmedError)) logError(error);
        });
    };

    const probeWebdavCompatibilityForCurrentEncryptionPosture = async (
        documentUrl: string,
        options: Parameters<typeof probeWebdavSyncCompatibility>[1],
    ): Promise<'strong-etag' | 'legacy-plaintext'> => {
        const status = await host.encryption.getStatus();
        const requireStrongEtag = status.state !== 'off' || Boolean(status.incompleteTransition);
        const compatibility = await core.probeWebdavSyncCompatibility(
            documentUrl,
            options,
            { requireStrongEtag },
        );
        if (compatibility === 'legacy-plaintext' && requireStrongEtag) {
            throw new core.SyncEncryptionRemoteVersionUnavailableError('WebDAV data.json');
        }
        return compatibility;
    };

    /** Answers once the write is stored (React Native's screen does not wait for it). */
    const persistSyncConfigItem = (key: string, value: string, afterSave?: () => void): Promise<void> => (
        host.storage.setItem(key, value)
            .then(() => {
                host.clearSyncConfigCache();
                afterSave?.();
            })
            .catch(logError)
    );

    const isManualInsecureOverride = (url: string, allowInsecureHttp: boolean): boolean => {
        if (!allowInsecureHttp) return false;
        try {
            if (new URL(url).protocol !== 'http:') return false;
        } catch {
            return false;
        }
        return !core.isConnectionAllowed(url, core.SYNC_LOCAL_INSECURE_URL_OPTIONS);
    };

    const urlPassword = (url: string): string | null => {
        try {
            return decodeURIComponent(new URL(url).password) || null;
        } catch {
            return null;
        }
    };

    // Every credential this visit has seen: typed passwords and tokens, a URL's password
    // (a draft's too), and Dropbox tokens read, refreshed or signed in.
    const known = new Set<string>();
    const remember = (...secrets: (string | null | undefined)[]) => {
        for (const secret of secrets) if (secret) known.add(secret);
    };
    const rememberUrl = (url: string | null | undefined) => remember(url ? urlPassword(url) : null);
    const rememberTokens = (tokens: DropboxAuthTokens | null | undefined) => remember(tokens?.accessToken, tokens?.refreshToken);
    /** The stored Dropbox tokens join the set; a refresh may have replaced them. */
    const rememberStoredDropboxTokens = async () => {
        try {
            rememberTokens(await host.dropbox.getStoredTokens());
        } catch {
            // Unreadable tokens cannot be echoed by this visit either.
        }
    };

    /**
     * The one redaction for every text that leaves the transport (toasts, errors, log
     * lines; the screen's status and history use it too): the log sanitizer, no URL
     * credentials, and none of the credentials this visit knows.
     */
    const redact = (text: string) => redactSyncText(text, [
        state.webdavPassword,
        state.cloudToken,
        urlPassword(state.webdavUrl),
        urlPassword(state.cloudUrl),
        stagedDropboxCredentials?.tokens.accessToken,
        stagedDropboxCredentials?.tokens.refreshToken,
        ...known,
    ]);

    /** An error for the log callback, its name and message redacted. */
    const redactError = (error: unknown): Error => {
        const redacted = new Error(redact(error instanceof Error ? error.message : String(error)));
        redacted.name = error instanceof Error ? redact(error.name) : 'Error';
        return redacted;
    };
    const logError = (error: unknown) => host.logSettingsError(redactError(error));
    const logInfo = (message: string, context: { scope: string; extra: Record<string, string> }) => host.logInfo(redact(message), {
        scope: context.scope,
        extra: Object.fromEntries(Object.entries(context.extra).map(([key, entry]) => [key, redact(entry)])),
    });

    // Every write of the backend key takes the next number; a failed Off write restores
    // the screen only while no later write has started.
    let backendWrites = 0;

    const formatText = (p: SyncSettingsTransportParams, key: string, replacements: Record<string, string | number>) => {
        let text = p.t(key);
        Object.entries(replacements).forEach(([name, value]) => {
            text = text.split(`{${name}}`).join(String(value));
        });
        return text;
    };

    const runDropboxConnectionTest = async (p: SyncSettingsTransportParams) => {
        const stagedCredentials = stagedDropboxCredentials;
        let accessToken: string;
        if (stagedCredentials) {
            const resolution = await host.dropbox.getValidAccessTokenForTokens(
                p.dropboxAppKey,
                stagedCredentials.tokens,
            );
            stagedCredentials.tokens = resolution.tokens;
            accessToken = resolution.accessToken;
            rememberTokens(resolution.tokens);
        } else {
            accessToken = await host.dropbox.getValidAccessToken(p.dropboxAppKey);
        }
        remember(accessToken);
        try {
            await host.dropbox.testAccess(accessToken);
        } catch (error) {
            if (!core.isDropboxUnauthorizedError(error)) {
                throw error;
            }
            if (stagedCredentials) {
                const resolution = await host.dropbox.forceRefreshAccessTokenForTokens(
                    p.dropboxAppKey,
                    stagedCredentials.tokens,
                );
                stagedCredentials.tokens = resolution.tokens;
                accessToken = resolution.accessToken;
                rememberTokens(resolution.tokens);
            } else {
                accessToken = await host.dropbox.forceRefreshAccessToken(p.dropboxAppKey);
            }
            remember(accessToken);
            await host.dropbox.testAccess(accessToken);
        }
    };

    /** `warnInsecure` is false when the same action already warned about this URL. */
    const validateSyncHttpUrl = (
        p: SyncSettingsTransportParams,
        url: string,
        allowInsecureHttp: boolean,
        label: 'WebDAV' | 'self-hosted',
        warnInsecure = true,
    ): boolean => {
        if (!url || !isValidSyncHttpUrl(url)) {
            p.showSettingsWarning(
                p.tr('settings.syncMobile.invalidUrl'),
                label === 'WebDAV'
                    ? p.tr('settings.syncMobile.pleaseEnterAValidWebdavUrlHttpHttps')
                    : p.tr('settings.syncMobile.pleaseEnterAValidSelfHostedUrlHttpHttps')
            );
            return false;
        }
        if (!core.isConnectionAllowed(url, {
            ...core.SYNC_LOCAL_INSECURE_URL_OPTIONS,
            allowInsecureHttp,
        })) {
            p.showSettingsWarning(
                p.tr('settings.syncMobile.httpsRequired'),
                p.tr('settings.syncMobile.publicHttpSyncUrlsAreBlockedUseHttpsOrEnable'),
                6500
            );
            return false;
        }
        if (warnInsecure && isManualInsecureOverride(url, allowInsecureHttp)) {
            p.showSettingsWarning(
                p.tr('settings.syncMobile.insecureHttpEnabled'),
                p.tr('settings.syncMobile.onlyUseThisOnTrustedNetworksSyncDataWillBe'),
                6500
            );
        }
        return true;
    };

    // Mobile self-hosted forms hold the real token (unlike desktop's keyring-backed
    // "empty = unchanged"): an empty token is valid (no auth), but a non-empty token
    // that fails the shape check must block the save.
    const validateCloudToken = (p: SyncSettingsTransportParams, token: string): boolean => {
        if (!token || core.isValidCloudSyncToken(token)) return true;
        p.showSettingsWarning(
            p.tr('settings.syncMobile.error'),
            p.tr('settings.cloudTokenInvalid')
        );
        return false;
    };

    /**
     * Reads the stored configuration. The answer cancels it for a screen that leaves
     * first; its `done` settles once the read is applied and any correction is stored.
     */
    const load = (): SyncSettingsCancel => {
        let cancelled = false;
        const p = host.params();
        const { dropboxConfigured, supportsNativeICloudSync } = p;

        const done = Promise.all([
            host.storage.multiGet([
                SYNC_PATH_KEY,
                SYNC_PATH_BOOKMARK_KEY,
                SYNC_BACKEND_KEY,
                WEBDAV_URL_KEY,
                WEBDAV_USERNAME_KEY,
                WEBDAV_ALLOW_INSECURE_HTTP_KEY,
                CLOUD_URL_KEY,
                CLOUD_ALLOW_INSECURE_HTTP_KEY,
                CLOUD_PROVIDER_KEY,
            ]),
            host.secrets.get(WEBDAV_PASSWORD_KEY),
            host.secrets.get(CLOUD_TOKEN_KEY),
        ]).then(async ([entries, storedWebDavPassword, storedCloudToken]) => {
            if (cancelled) return;

            const entryMap = new Map(entries);
            const path = entryMap.get(SYNC_PATH_KEY);
            const pathBookmark = entryMap.get(SYNC_PATH_BOOKMARK_KEY);
            const storedBackend = entryMap.get(SYNC_BACKEND_KEY);
            const storedWebDavUrl = entryMap.get(WEBDAV_URL_KEY);
            const storedWebDavUsername = entryMap.get(WEBDAV_USERNAME_KEY);
            const storedWebDavAllowInsecureHttp = entryMap.get(WEBDAV_ALLOW_INSECURE_HTTP_KEY);
            const storedCloudUrl = entryMap.get(CLOUD_URL_KEY);
            const storedCloudAllowInsecureHttp = entryMap.get(CLOUD_ALLOW_INSECURE_HTTP_KEY);
            const storedCloudProvider = entryMap.get(CLOUD_PROVIDER_KEY);

            const resolvedBackend = storedBackend === 'webdav'
                || storedBackend === 'cloud'
                || storedBackend === 'off'
                || storedBackend === 'file'
                || storedBackend === 'cloudkit'
                ? storedBackend
                : 'off';
            // React Native's rule, kept on purpose: a backend this build cannot run (Dropbox
            // on a FOSS build or without an app key, iCloud off iOS) is turned off, and the
            // correction is stored. What a build supports comes from the build's facts
            // (`dropboxConfigured`, `supportsNativeICloudSync`), never from which ports a
            // native host has bound.
            const unsupportedDropboxBackend = resolvedBackend === 'cloud'
                && storedCloudProvider === 'dropbox'
                && !dropboxConfigured;
            const supportedBackend = unsupportedDropboxBackend
                ? 'off'
                : core.coerceSupportedBackend(resolvedBackend, supportsNativeICloudSync);
            provenSyncBackend = supportedBackend;

            const resolvedCloudProvider: SyncSettingsCloudProvider = (
                (resolvedBackend === 'cloudkit' || storedCloudProvider === 'cloudkit') && supportsNativeICloudSync
            )
                ? 'cloudkit'
                : storedCloudProvider === 'dropbox' && dropboxConfigured
                    ? 'dropbox'
                    : 'selfhosted';
            provenCloudProvider = resolvedCloudProvider;

            set({
                syncPath: path || null,
                syncPathBookmark: pathBookmark || null,
                webdavUrl: storedWebDavUrl || '',
                webdavUsername: storedWebDavUsername || '',
                webdavPassword: storedWebDavPassword || '',
                webdavAllowInsecureHttp: storedWebDavAllowInsecureHttp === 'true',
                cloudUrl: storedCloudUrl || '',
                cloudToken: storedCloudToken || '',
                cloudAllowInsecureHttp: storedCloudAllowInsecureHttp === 'true',
                syncBackend: supportedBackend,
                cloudProvider: resolvedCloudProvider,
            });

            const corrections: Promise<void>[] = [];
            if (resolvedBackend !== supportedBackend) {
                corrections.push(persistSyncConfigItem(SYNC_BACKEND_KEY, supportedBackend));
            }
            if (!dropboxConfigured && storedCloudProvider === 'dropbox') {
                corrections.push(persistSyncConfigItem(CLOUD_PROVIDER_KEY, 'selfhosted'));
            }
            if (!supportsNativeICloudSync && storedCloudProvider === 'cloudkit') {
                corrections.push(persistSyncConfigItem(CLOUD_PROVIDER_KEY, 'selfhosted'));
            }
            reconcileBackgroundSyncRegistration();
            await Promise.all(corrections);
        }).catch(logError);

        return Object.assign(() => {
            cancelled = true;
        }, { done });
    };

    const refreshCloudKitAccountStatus = async () => {
        if (!host.params().supportsNativeICloudSync) {
            set({ cloudKitAccountStatus: 'unknown' });
            return;
        }
        set({ cloudKitAccountStatus: await host.getCloudKitAccountStatus() });
    };

    /** Reads whether Dropbox is connected; cancels and settles as `load` does. */
    const loadDropboxState = (): SyncSettingsCancel => {
        let cancelled = false;
        const { dropboxConfigured } = host.params();

        const run = async () => {
            if (!dropboxConfigured) {
                if (!cancelled) set({ dropboxConnected: false });
                return;
            }
            try {
                const connected = await host.dropbox.isConnected();
                if (!cancelled) set({ dropboxConnected: connected });
                if (connected) await rememberStoredDropboxTokens();
            } catch {
                if (!cancelled) set({ dropboxConnected: false });
            }
        };

        const done = run();
        return Object.assign(() => {
            cancelled = true;
        }, { done });
    };

    // Choosing a backend or provider whose target is already complete (a saved
    // WebDAV/self-hosted server, a connected Dropbox, a picked folder) activates
    // it through the verification sync. An incomplete target stays staged so the
    // user can finish the form and Save.
    const isSyncTargetComplete = (backend: SyncSettingsBackend, provider: SyncSettingsCloudProvider): boolean => {
        if (backend === 'off') return false;
        if (backend === 'cloudkit') return true;
        if (backend === 'webdav') return state.webdavUrl.trim().length > 0;
        if (backend === 'file') return Boolean(state.syncPath);
        if (provider === 'dropbox') return state.dropboxConnected || stagedDropboxCredentials !== null;
        return state.cloudUrl.trim().length > 0 && state.cloudToken.trim().length > 0;
    };

    const currentSyncTargetOptions = (): Omit<SyncSettingsActionOptions, 'backend'> => ({
        cloud: { allowInsecureHttp: state.cloudAllowInsecureHttp, token: state.cloudToken, url: state.cloudUrl },
        webdav: {
            allowInsecureHttp: state.webdavAllowInsecureHttp,
            password: state.webdavPassword,
            url: state.webdavUrl,
            username: state.webdavUsername,
        },
    });

    /**
     * Answers the activation it starts, or Off's write (React Native's screen waits for
     * neither). Off's write rejects with SyncSettingsWriteError when the store refuses it.
     */
    const handleSelectSyncBackend = (backend: 'off' | 'file' | 'webdav' | 'cloud'): Promise<void> | undefined => {
        const p = host.params();
        const { cloudProvider } = state;
        const nextBackend = backend === 'cloud'
            ? (cloudProvider === 'cloudkit' ? 'cloudkit' : 'cloud')
            : backend;
        const previous = { syncBackend: state.syncBackend, proven: provenSyncBackend, pending: hasPendingSyncConfiguration };
        core.addBreadcrumb(`settings:syncBackend:${nextBackend}`);
        set({ syncBackend: nextBackend });
        if (nextBackend === 'off') {
            hasPendingSyncConfiguration = false;
            provenSyncBackend = 'off';
            p.resetSyncStatusForBackendSwitch();
            const sequence = ++backendWrites;
            const write = host.storage.setItem(SYNC_BACKEND_KEY, nextBackend).then(() => {
                host.clearSyncConfigCache();
                reconcileBackgroundSyncRegistration();
            }, (error: unknown) => {
                logError(error);
                // The store still holds the previous backend: the screen must not show Off,
                // unless a later backend write has started since.
                if (sequence === backendWrites) {
                    provenSyncBackend = previous.proven;
                    hasPendingSyncConfiguration = previous.pending;
                    if (state.syncBackend === 'off') set({ syncBackend: previous.syncBackend });
                }
                throw new SyncSettingsWriteError(redact(error instanceof Error ? error.message : String(error)));
            });
            // React Native's screen does not wait for the write; a caller that does sees the failure.
            write.catch(() => undefined);
            return write;
        } else if (nextBackend !== provenSyncBackend) {
            hasPendingSyncConfiguration = true;
            if (isSyncTargetComplete(nextBackend, cloudProvider)) {
                return handleSync({
                    ...currentSyncTargetOptions(),
                    backend: nextBackend,
                    cloudProvider,
                });
            }
        }
        return undefined;
    };

    /** Answers the activation it starts, if any, as handleSelectSyncBackend does. */
    const handleSelectCloudProvider = (provider: SyncSettingsCloudProvider): Promise<void> | undefined => {
        const p = host.params();
        if (provider === 'cloudkit' && !p.supportsNativeICloudSync) return undefined;
        if (provider === 'dropbox' && !p.dropboxConfigured) return undefined;

        const nextBackend: SyncSettingsBackend = provider === 'cloudkit' ? 'cloudkit' : 'cloud';
        const isNewSelection = (
            provider !== provenCloudProvider
            || nextBackend !== provenSyncBackend
        );
        if (isNewSelection) {
            hasPendingSyncConfiguration = true;
        }
        set({ cloudProvider: provider, syncBackend: nextBackend });
        if (isNewSelection && isSyncTargetComplete(nextBackend, provider)) {
            return handleSync({
                ...currentSyncTargetOptions(),
                backend: nextBackend,
                cloudProvider: provider,
            });
        }
        return undefined;
    };

    const handleSetSyncPath = async () => {
        const p = host.params();
        try {
            const result = await host.pickSyncFolder();
            if (!result) return;
            const fileUri = (result as { __fileUri: string }).__fileUri;
            const fileBookmark = (result as { __fileBookmark?: string }).__fileBookmark?.trim() ?? null;
            if (!fileUri) return;

            hasPendingSyncConfiguration = true;
            core.addBreadcrumb('settings:syncBackend:file');
            set({ syncPath: fileUri, syncPathBookmark: fileBookmark, syncBackend: 'file' });
            // A picked folder is a complete target: activate the folder just
            // picked, not the stale one still in state this tick.
            await handleSync({
                backend: 'file',
                syncPath: fileUri,
                syncPathBookmark: fileBookmark,
            });
        } catch (error) {
            const message = String(error);
            if (/Selected JSON file is not a Mindwtr backup/i.test(message)) {
                p.showSettingsWarning(
                    p.tr('settings.syncMobile.invalidSyncFile'),
                    p.tr('settings.syncMobile.pleaseChooseAMindwtrBackupJsonFileInTheTarget'),
                    5200
                );
                return;
            }
            if (/temporary Inbox location|re-select a folder in Settings -> (?:Data & Sync|Sync)/i.test(message)) {
                p.showSettingsWarning(
                    p.tr('settings.syncMobile.unsupportedCloudProviderOnIos'),
                    p.tr('settings.syncMobile.theSelectedFileCameFromATemporaryIosFilesCopy'),
                    5600
                );
                return;
            }
            if (/read-only|read only|not writable|isn't writable|permission denied|EACCES/i.test(message)) {
                p.showSettingsWarning(
                    p.tr('settings.syncMobile.syncFolderIsReadOnly'),
                    host.platform.os() === 'ios'
                        ? p.tr('settings.syncMobile.theSelectedFolderIsReadOnlyChooseAWritableLocation')
                        : p.tr('settings.syncMobile.theSelectedFolderIsReadOnlyPleaseChooseAWritable'),
                    5600
                );
                return;
            }
            p.showSettingsErrorToast(p.tr('settings.syncMobile.error'), p.tr('settings.syncMobile.failedToSetSyncPath'));
        }
    };

    const handleDisconnectDropbox = async () => {
        const p = host.params();
        set({ dropboxBusy: true });
        try {
            const stagedCredentials = stagedDropboxCredentials;
            const disconnectingProvenDropbox = (
                provenSyncBackend === 'cloud'
                && provenCloudProvider === 'dropbox'
            );
            if (
                disconnectingProvenDropbox
            ) {
                backendWrites += 1;
                await host.storage.setItem(SYNC_BACKEND_KEY, 'off');
                host.clearSyncConfigCache();
                const [[, persistedBackend]] = await host.storage.multiGet([SYNC_BACKEND_KEY]);
                if (persistedBackend !== 'off') {
                    throw new Error('Dropbox sync could not be disabled before disconnecting');
                }
                provenSyncBackend = 'off';
                hasPendingSyncConfiguration = false;
                set({ syncBackend: 'off' });
                reconcileBackgroundSyncRegistration();
            }
            if (stagedCredentials && p.dropboxConfigured) {
                await host.dropbox.revokeTokens(p.dropboxAppKey, stagedCredentials.tokens);
            }
            stagedDropboxCredentials = null;
            if (p.dropboxConfigured) {
                await host.dropbox.disconnect(p.dropboxAppKey);
            } else {
                // A FOSS or otherwise unconfigured build cannot revoke the
                // remote token, but it must still let the user remove local
                // credentials left by a previously configured build.
                await host.dropbox.clearTokens();
            }
            if (!disconnectingProvenDropbox) {
                // A failed activation leaves Dropbox selected only in this
                // screen's staged UI. Disconnect must return to the last
                // configuration that actually completed its probe.
                hasPendingSyncConfiguration = false;
                set({ syncBackend: provenSyncBackend, cloudProvider: provenCloudProvider });
            }
            set({ dropboxConnected: false });
            p.resetSyncStatusForBackendSwitch();
            reconcileBackgroundSyncRegistration();
            p.showToast({
                title: p.tr('settings.syncMobile.disconnected'),
                message: p.tr('settings.syncMobile.dropboxConnectionRemoved'),
                tone: 'success',
            });
        } catch (error) {
            await rememberStoredDropboxTokens();
            p.showSettingsErrorToast(p.tr('settings.syncMobile.disconnectFailed'), redact(core.formatError(error)), 5200);
        } finally {
            set({ dropboxBusy: false });
        }
    };

    const handleTestDropboxConnection = async () => {
        const p = host.params();
        if (p.isFossBuild) {
            p.showSettingsWarning(p.tr('settings.syncMobile.dropboxUnavailable'), p.tr('settings.syncMobile.dropboxIsDisabledInFossBuilds'));
            return;
        }
        if (!p.dropboxConfigured) {
            p.showSettingsWarning(p.tr('settings.syncMobile.dropboxUnavailable'), p.tr('settings.syncMobile.dropboxAppKeyIsNotConfiguredInThisBuild'));
            return;
        }
        set({ isTestingConnection: true });
        try {
            await runDropboxConnectionTest(p);
            set({ dropboxConnected: true });
            p.showToast({
                title: p.tr('settings.syncMobile.connectionOk'),
                message: p.tr('settings.syncMobile.dropboxAccountIsReachable'),
                tone: 'success',
            });
        } catch (error) {
            if (core.isDropboxUnauthorizedError(error)) {
                set({ dropboxConnected: false });
                p.showSettingsWarning(
                    p.tr('settings.syncMobile.connectionFailed'),
                    p.tr('settings.syncMobile.dropboxTokenIsInvalidOrRevokedPleaseTapConnectDropbox'),
                    5200
                );
            } else {
                await rememberStoredDropboxTokens();
                p.showSettingsErrorToast(p.tr('settings.syncMobile.connectionFailed'), redact(core.formatError(error)), 5200);
            }
        } finally {
            set({ isTestingConnection: false });
        }
    };

    const handleSaveWebDavSettings = async (nextSettings: SyncSettingsWebDavFields) => {
        const p = host.params();
        const trimmedUrl = nextSettings.url.trim();
        if (!validateSyncHttpUrl(p, trimmedUrl, nextSettings.allowInsecureHttp, 'WebDAV')) {
            return;
        }
        const trimmedUsername = nextSettings.username.trim();
        set({
            webdavUrl: trimmedUrl,
            webdavUsername: trimmedUsername,
            webdavPassword: nextSettings.password,
            webdavAllowInsecureHttp: nextSettings.allowInsecureHttp,
            syncBackend: 'webdav',
        });
        hasPendingSyncConfiguration = true;
        // The save just warned about an insecure URL; its first sync does not again.
        await runSync(p, {
            backend: 'webdav',
            webdav: {
                allowInsecureHttp: nextSettings.allowInsecureHttp,
                password: nextSettings.password,
                url: trimmedUrl,
                username: trimmedUsername,
            },
        }, { insecureWarned: true });
    };

    const handleSaveSelfHostedSettings = async (nextSettings: SyncSettingsSelfHostedFields) => {
        const p = host.params();
        const trimmedUrl = nextSettings.url.trim();
        if (!validateSyncHttpUrl(p, trimmedUrl, nextSettings.allowInsecureHttp, 'self-hosted')) {
            return;
        }
        if (!validateCloudToken(p, nextSettings.token.trim())) {
            return;
        }
        set({
            cloudUrl: trimmedUrl,
            cloudToken: nextSettings.token,
            cloudAllowInsecureHttp: nextSettings.allowInsecureHttp,
            cloudProvider: 'selfhosted',
            syncBackend: 'cloud',
        });
        hasPendingSyncConfiguration = true;
        // An empty token passes validation but cannot activate; leave it staged
        // and say so, the way desktop does, instead of returning silently.
        if (!nextSettings.token.trim()) {
            p.showToast({
                title: p.tr('common.notice'),
                message: p.tr('settings.sync.readyToVerify'),
                tone: 'info',
            });
            return;
        }
        await runSync(p, {
            backend: 'cloud',
            cloudProvider: 'selfhosted',
            cloud: {
                allowInsecureHttp: nextSettings.allowInsecureHttp,
                token: nextSettings.token,
                url: trimmedUrl,
            },
        }, { insecureWarned: true });
    };

    const commitProvenSyncConfiguration = async (p: SyncSettingsTransportParams, config: MobileSyncConfigOverride) => {
        try {
            const dependencies: MobileSyncConfigurationTransactionDependencies = {
                clearConfigCache: () => host.clearSyncConfigCache(),
                clearDropboxTokens: () => host.dropbox.clearTokens(),
                deleteSecret: (key) => host.secrets.delete(key),
                getDropboxTokens: async () => {
                    const tokens = await host.dropbox.getStoredTokens();
                    rememberTokens(tokens);
                    return tokens;
                },
                getIncompleteSyncEncryptionTransition: () => host.encryption.getIncompleteTransition(),
                getSecret: (key) => host.secrets.get(key),
                multiGet: (keys) => host.storage.multiGet(keys),
                multiSet: (entries) => host.storage.multiSet(entries),
                removeItem: (key) => host.storage.removeItem(key),
                saveDropboxTokens: (tokens) => host.dropbox.saveTokens(tokens),
                setItem: (key, value) => host.storage.setItem(key, value),
                setSecret: (key, value) => host.secrets.set(key, value),
            };
            backendWrites += 1;
            await commitProvenMobileSyncConfiguration(config, dependencies);
        } catch (error) {
            if (
                error instanceof MobileSyncConfigurationTransactionError
                && error.syncRemainsDisabled
            ) {
                provenSyncBackend = 'off';
                set({ syncBackend: 'off' });
                p.resetSyncStatusForBackendSwitch();
                reconcileBackgroundSyncRegistration();
            }
            throw error;
        }

        provenSyncBackend = config.backend;
        if (config.backend === 'cloudkit') {
            provenCloudProvider = 'cloudkit';
        } else if (config.backend === 'cloud') {
            provenCloudProvider = config.cloudProvider ?? 'selfhosted';
        }
        if (config.cloudProvider === 'dropbox' && config.dropbox) {
            stagedDropboxCredentials = null;
        }
        hasPendingSyncConfiguration = false;
        reconcileBackgroundSyncRegistration();
    };

    const handleSync = (options?: SyncSettingsActionOptions): Promise<void> => runSync(host.params(), options);

    /**
     * `p` is the screen as the action that asked for this sync saw it;
     * `insecureWarned` says that action already warned about an insecure URL.
     */
    const runSync = async (p: SyncSettingsTransportParams, options?: SyncSettingsActionOptions, flags: { insecureWarned?: boolean } = {}) => {
        const { t, tr, showToast, showSettingsWarning, showSettingsErrorToast } = p;
        remember(options?.webdav?.password, options?.cloud?.token);
        rememberUrl(options?.webdav?.url);
        rememberUrl(options?.cloud?.url);
        const dropboxInPlay = (options?.cloudProvider ?? state.cloudProvider) === 'dropbox';
        const {
            syncBackend, cloudAllowInsecureHttp, cloudToken, cloudUrl, cloudProvider, syncPath, syncPathBookmark,
            webdavAllowInsecureHttp, webdavPassword, webdavUrl, webdavUsername,
        } = state;
        core.addBreadcrumb('sync:manual');
        set({ isSyncing: true });
        let cleanupUnconfirmed = false;
        let activationCleanupDeferred: 'remote' | 'file' | null = null;
        const showRemoteFenceFeedback = (deferred: 'busy' | 'cleanup') => {
            showSettingsWarning(
                tr('common.notice'),
                tr(deferred === 'busy'
                    ? 'settings.syncRemoteBusy'
                    : 'settings.syncRemoteCleanupDeferred'),
                6000,
            );
        };
        const showFileSyncLockFeedback = (
            outcome: 'busy' | 'cleanup' | 'unavailable',
            activationBusy = false,
        ) => {
            showToast({
                title: outcome === 'unavailable' ? tr('settings.syncMobile.error') : tr('common.notice'),
                message: tr(outcome === 'busy'
                    ? activationBusy
                        ? 'settings.syncFileLockActivationBusy'
                        : 'settings.syncFileLockBusy'
                    : outcome === 'cleanup'
                        ? 'settings.syncFileLockCleanupDeferred'
                        : 'settings.syncFileLockUnavailable'),
                tone: outcome === 'unavailable' ? 'error' : 'warning',
                durationMs: 6000,
            });
        };
        try {
            const previousLastSyncStatus = p.lastSyncStatus;
            const previousLastSyncStats = p.lastSyncStats ?? null;
            const effectiveBackend = options?.backend ?? syncBackend;
            const configOverride: MobileSyncConfigOverride = { backend: effectiveBackend };
            const effectiveCloud = options?.cloud ?? {
                allowInsecureHttp: cloudAllowInsecureHttp,
                token: cloudToken,
                url: cloudUrl,
            };
            const effectiveCloudProvider = options?.cloudProvider ?? cloudProvider;
            const effectiveSyncPath = options?.syncPath ?? syncPath;
            const effectiveSyncPathBookmark = options?.syncPathBookmark ?? syncPathBookmark;
            const effectiveWebdav = options?.webdav ?? {
                allowInsecureHttp: webdavAllowInsecureHttp,
                password: webdavPassword,
                url: webdavUrl,
                username: webdavUsername,
            };

            if (effectiveBackend === 'off') return;
            if (effectiveBackend === 'webdav') {
                const trimmedWebDavUrl = effectiveWebdav.url.trim();
                if (!trimmedWebDavUrl) {
                    showSettingsWarning(tr('common.notice'), tr('settings.syncMobile.pleaseSetAWebdavUrlFirst'));
                    return;
                }
                if (!validateSyncHttpUrl(p, trimmedWebDavUrl, effectiveWebdav.allowInsecureHttp, 'WebDAV', !flags.insecureWarned)) {
                    return;
                }
                const trimmedWebDavUsername = effectiveWebdav.username.trim();
                configOverride.webdav = {
                    allowInsecureHttp: effectiveWebdav.allowInsecureHttp,
                    password: effectiveWebdav.password,
                    url: trimmedWebDavUrl,
                    username: trimmedWebDavUsername,
                };
                set({
                    webdavUrl: trimmedWebDavUrl,
                    webdavUsername: trimmedWebDavUsername,
                    webdavPassword: effectiveWebdav.password,
                    webdavAllowInsecureHttp: effectiveWebdav.allowInsecureHttp,
                    syncBackend: 'webdav',
                });
            } else if (effectiveBackend === 'cloudkit') {
                const accountStatus = await host.getCloudKitAccountStatus();
                set({ cloudKitAccountStatus: accountStatus });
                const statusDetails = p.getCloudKitStatusDetails(accountStatus);
                if (!statusDetails.syncEnabled) {
                    showSettingsWarning(tr('settings.syncMobile.icloudUnavailable'), statusDetails.helpText, 5200);
                    return;
                }
                set({ cloudProvider: 'cloudkit', syncBackend: 'cloudkit' });
            } else if (effectiveBackend === 'cloud') {
                if (effectiveCloudProvider === 'dropbox') {
                    if (p.isFossBuild) {
                        showSettingsWarning(tr('settings.syncMobile.dropboxUnavailable'), tr('settings.syncMobile.dropboxIsDisabledInFossBuilds'));
                        return;
                    }
                    if (!p.dropboxConfigured) {
                        showSettingsWarning(tr('settings.syncMobile.dropboxUnavailable'), tr('settings.syncMobile.dropboxAppKeyIsNotConfiguredInThisBuild'));
                        return;
                    }
                    const stagedCredentials = stagedDropboxCredentials;
                    const connected = Boolean(stagedCredentials) || await host.dropbox.isConnected();
                    if (!connected) {
                        showSettingsWarning(tr('common.notice'), tr('settings.syncMobile.pleaseConnectDropboxFirst'));
                        return;
                    }
                    configOverride.cloudProvider = 'dropbox';
                    if (stagedCredentials) {
                        configOverride.dropbox = stagedCredentials;
                    }
                    set({ cloudProvider: 'dropbox', syncBackend: 'cloud' });
                } else {
                    const trimmedCloudUrl = effectiveCloud.url.trim();
                    if (!trimmedCloudUrl) {
                        showSettingsWarning(tr('common.notice'), tr('settings.syncMobile.pleaseSetASelfHostedUrlFirst'));
                        return;
                    }
                    if (!validateSyncHttpUrl(p, trimmedCloudUrl, effectiveCloud.allowInsecureHttp, 'self-hosted', !flags.insecureWarned)) {
                        return;
                    }
                    if (!validateCloudToken(p, effectiveCloud.token.trim())) {
                        return;
                    }
                    configOverride.cloudProvider = 'selfhosted';
                    configOverride.cloud = {
                        allowInsecureHttp: effectiveCloud.allowInsecureHttp,
                        token: effectiveCloud.token,
                        url: trimmedCloudUrl,
                    };
                    set({
                        cloudUrl: trimmedCloudUrl,
                        cloudToken: effectiveCloud.token,
                        cloudAllowInsecureHttp: effectiveCloud.allowInsecureHttp,
                        cloudProvider: 'selfhosted',
                        syncBackend: 'cloud',
                    });
                }
            } else {
                if (!effectiveSyncPath) {
                    showSettingsWarning(tr('common.notice'), tr('settings.syncMobile.pleaseSetASyncFolderFirst'));
                    return;
                }
                configOverride.syncPath = effectiveSyncPath;
                configOverride.syncPathBookmark = effectiveSyncPathBookmark;
                set({ syncPath: effectiveSyncPath, syncPathBookmark: effectiveSyncPathBookmark, syncBackend: 'file' });
            }

            // Every panel's Sync now passes its form, so options alone are not new settings:
            // only a form that differs from the settings this call started with (read above,
            // before the form was written into them) needs proving. It stays pending until
            // a proof commits it, like a Save.
            const formChanged = configOverride.webdav
                ? configOverride.webdav.url !== webdavUrl
                    || configOverride.webdav.username !== webdavUsername
                    || configOverride.webdav.password !== webdavPassword
                    || configOverride.webdav.allowInsecureHttp !== webdavAllowInsecureHttp
                : configOverride.cloud
                    ? configOverride.cloud.url !== cloudUrl
                        || configOverride.cloud.token !== cloudToken
                        || configOverride.cloud.allowInsecureHttp !== cloudAllowInsecureHttp
                    : configOverride.syncPath !== undefined && (
                        configOverride.syncPath !== syncPath
                        || (configOverride.syncPathBookmark ?? null) !== syncPathBookmark
                    );
            if (formChanged || configOverride.dropbox) {
                hasPendingSyncConfiguration = true;
            }
            const needsActivationProbe = hasPendingSyncConfiguration
                || effectiveBackend !== provenSyncBackend
                || (
                    effectiveBackend === 'cloud'
                    && effectiveCloudProvider !== provenCloudProvider
                )
                || (
                    effectiveBackend === 'cloudkit'
                    && provenCloudProvider !== 'cloudkit'
            );
            if (needsActivationProbe) {
                void logInfo('Sync backend selected; running the verification sync to activate it', {
                    scope: 'sync',
                    extra: {
                        releaseCheck: 'v1.2.7/sync-settings-activation-mobile',
                        backend: effectiveBackend,
                        cloudProvider: effectiveCloudProvider,
                    },
                });
                if (configOverride.backend === 'webdav' && configOverride.webdav) {
                    const compatibility = await probeWebdavCompatibilityForCurrentEncryptionPosture(
                        core.normalizeWebdavUrl(configOverride.webdav.url),
                        {
                        ...getMobileWebDavRequestOptions(configOverride.webdav.allowInsecureHttp),
                        username: configOverride.webdav.username,
                        password: configOverride.webdav.password,
                        timeoutMs: 10_000,
                        },
                    );
                    if (compatibility === 'strong-etag') {
                        await host.rememberWebdavCapabilityProof(configOverride.webdav as SyncSettingsWebDavFields);
                    }
                }
                const probeResult = await host.performSync(
                    effectiveBackend === 'file' ? effectiveSyncPath || undefined : undefined,
                    { activationProbe: true, manual: true, configOverride }
                );
                if (probeResult.skipped === 'offline' || core.isLikelyOfflineSyncError(probeResult.error)) {
                    const serverUnreachable = probeResult.skipped === 'offline' && probeResult.offlineCause === 'request';
                    showToast({
                        title: serverUnreachable ? t('common.notice') : t('common.offline'),
                        message: serverUnreachable ? t('settings.syncServerUnreachable') : t('settings.syncSkippedOffline'),
                        tone: 'warning',
                    });
                    return;
                }
                if (probeResult.skipped === 'requeued') {
                    showSettingsWarning(
                        tr('common.notice'),
                        tr('settings.syncActivationRequeuedBody'),
                        4200,
                    );
                    return;
                }
                if (probeResult.success && probeResult.remoteFenceDeferred === 'busy') {
                    showRemoteFenceFeedback('busy');
                    return;
                }
                if (probeResult.success && probeResult.fileSyncLockDeferred === 'busy') {
                    showFileSyncLockFeedback('busy', true);
                    return;
                }
                if (probeResult.fileSyncLockUnavailable) {
                    showFileSyncLockFeedback('unavailable');
                    return;
                }
                if (probeResult.fileGenerationCorrupt) {
                    showSettingsErrorToast(
                        tr('settings.syncMobile.error'),
                        tr('settings.syncFileGenerationCorrupt'),
                    );
                    return;
                }
                if (probeResult.fileAttachmentUploadBlocked === 'too-large') {
                    showSettingsErrorToast(
                        tr('settings.syncMobile.error'),
                        tr('settings.syncFileAttachmentTooLarge'),
                    );
                    return;
                }
                const probeRemoteCleanupDeferred = probeResult.success
                    && probeResult.remoteFenceDeferred === 'cleanup';
                const probeFileCleanupDeferred = probeResult.success
                    && probeResult.fileSyncLockDeferred === 'cleanup';
                activationCleanupDeferred = probeFileCleanupDeferred
                    ? 'file'
                    : probeRemoteCleanupDeferred
                        ? 'remote'
                        : null;
                if (
                    !probeResult.success
                    || probeResult.remoteWriteDeferred
                    || (probeResult.remoteFenceDeferred && !probeRemoteCleanupDeferred)
                    || (probeResult.fileSyncLockDeferred && !probeFileCleanupDeferred)
                    || probeResult.skipped === 'pendingRemoteWriteBackoff'
                ) {
                    // An encrypted remote is transport PROOF, not a failed probe: the
                    // read reached the sync location and found a valid Mindwtr document
                    // this device has no key for (the discovery just persisted the
                    // no-key state). Refusing to activate here would deadlock joining an
                    // already-encrypted location — unlock requires a durable backend,
                    // and the backend could only become durable through a sync that
                    // needs the key (#1001).
                    if (
                        !probeResult.success
                        && probeResult.activationProof === 'remote-encrypted-no-key'
                    ) {
                        await commitProvenSyncConfiguration(p, configOverride);
                        showSettingsWarning(
                            tr('common.notice'),
                            tr('settings.syncEncryptionRemoteEncrypted'),
                            6000,
                        );
                        return;
                    }
                    throw new Error(probeResult.error || 'Sync setup could not be verified');
                }
                await commitProvenSyncConfiguration(p, configOverride);
                if (activationCleanupDeferred) {
                    if (activationCleanupDeferred === 'file') showFileSyncLockFeedback('cleanup');
                    else showRemoteFenceFeedback('cleanup');
                    return;
                }
            }

            const result = await host.performSync(undefined, {
                manual: true,
                ignorePendingRemoteWriteBackoff: needsActivationProbe,
            });
            if (result.skipped === 'offline' || core.isLikelyOfflineSyncError(result.error)) {
                // 'request' means the OS says the device is online but the app's
                // requests failed — telling the user they are offline would be false.
                const serverUnreachable = result.skipped === 'offline' && result.offlineCause === 'request';
                showToast({
                    title: serverUnreachable ? t('common.notice') : t('common.offline'),
                    message: serverUnreachable ? t('settings.syncServerUnreachable') : t('settings.syncSkippedOffline'),
                    tone: 'warning',
                });
                return;
            }
            if (result.skipped === 'requeued') {
                showToast({
                    title: t('settings.syncQueued'),
                    message: t('settings.syncQueuedBody'),
                    tone: 'info',
                    durationMs: 4200,
                });
                return;
            }
            if (result.success && result.fileSyncLockDeferred) {
                showFileSyncLockFeedback(
                    activationCleanupDeferred === 'file' ? 'cleanup' : result.fileSyncLockDeferred,
                );
                return;
            }
            if (result.fileSyncLockUnavailable) {
                showFileSyncLockFeedback('unavailable');
                return;
            }
            if (result.fileGenerationCorrupt) {
                showSettingsErrorToast(
                    tr('settings.syncMobile.error'),
                    tr('settings.syncFileGenerationCorrupt'),
                );
                return;
            }
            if (
                result.success
                && !result.remoteWriteDeferred
                && result.fileAttachmentUploadBlocked === 'too-large'
            ) {
                showSettingsWarning(
                    tr('common.notice'),
                    tr('settings.syncFileAttachmentTooLarge'),
                    6000,
                );
                return;
            }
            if (result.success && result.remoteFenceDeferred) {
                showRemoteFenceFeedback(activationCleanupDeferred === 'remote' ? 'cleanup' : result.remoteFenceDeferred);
                return;
            }
            if (
                result.success
                && result.attachmentWriteDeferred
                && !result.remoteWriteDeferred
            ) {
                if (activationCleanupDeferred) {
                    if (activationCleanupDeferred === 'file') showFileSyncLockFeedback('cleanup');
                    else showRemoteFenceFeedback('cleanup');
                    return;
                }
                showSettingsWarning(
                    tr('common.notice'),
                    tr('settings.syncAttachmentWriteDeferred'),
                    6000,
                );
                return;
            }
            if (
                result.success
                && !result.remoteWriteDeferred
                && result.skipped !== 'pendingRemoteWriteBackoff'
            ) {
                if (activationCleanupDeferred) {
                    if (activationCleanupDeferred === 'file') showFileSyncLockFeedback('cleanup');
                    else showRemoteFenceFeedback('cleanup');
                    return;
                }
                const conflictCount = core.getSyncConflictCount(result.stats);
                const maxResultClockSkewMs = core.getSyncMaxClockSkewMs(result.stats);
                const resultTimestampAdjustments = core.getSyncTimestampAdjustments(result.stats);
                const shouldSuppressDuplicateConflictNotice = (
                    (previousLastSyncStatus === 'success' || previousLastSyncStatus === 'conflict')
                    && core.hasSameUserFacingSyncConflictSummary(result.stats, previousLastSyncStats)
                );
                const warningDetails = [
                    maxResultClockSkewMs > core.CLOCK_SKEW_THRESHOLD_MS
                        ? formatText(p, 'settings.syncClockSkewWarning', {
                            skew: core.formatClockSkew(maxResultClockSkewMs),
                        })
                        : null,
                    resultTimestampAdjustments > 0
                        ? formatText(p, 'settings.syncAdjustedTimestamps', {
                            count: resultTimestampAdjustments,
                        })
                        : null,
                ].filter(Boolean);
                showToast({
                    title: t('common.success'),
                    message: [
                        conflictCount > 0 && !shouldSuppressDuplicateConflictNotice
                            ? formatText(p, 'settings.syncCompletedWithConflicts', { count: conflictCount })
                            : t('settings.syncCompleted'),
                        ...warningDetails,
                    ].join('\n\n'),
                    tone: conflictCount > 0 || warningDetails.length > 0 ? 'warning' : 'success',
                    durationMs: warningDetails.length > 0 || conflictCount > 0 ? 5200 : 3600,
                });
            } else if (
                result.success
                && (result.remoteWriteDeferred || result.skipped === 'pendingRemoteWriteBackoff')
            ) {
                showToast({
                    title: tr('common.notice'),
                    message: tr('settings.sync.remoteWriteDeferred'),
                    tone: 'info',
                });
            } else {
                throw new Error(result.error || 'Unknown error');
            }
        } catch (error) {
            if (error instanceof NativeAttachmentCleanupUnconfirmedError) {
                cleanupUnconfirmed = true;
                throw error;
            }
            const message = String(error);
            if (/temporary Inbox location|re-select a folder in Settings -> (?:Data & Sync|Sync)|Cannot access the selected sync file/i.test(message)) {
                showSettingsWarning(
                    tr('settings.syncMobile.unsupportedCloudProviderOnIos'),
                    tr('settings.syncMobile.theSelectedFileCameFromATemporaryIosFilesCopy2'),
                    5600
                );
                return;
            }
            if (dropboxInPlay) await rememberStoredDropboxTokens();
            showSettingsErrorToast(
                tr('settings.syncMobile.error'),
                core.isSyncEncryptionRemoteVersionUnavailableError(error)
                    ? tr('settings.syncEncryptionErrorBackendIncompatible')
                    : redact(p.getSyncFailureToastMessage(error)),
            );
        } finally {
            if (!cleanupUnconfirmed) set({ isSyncing: false });
        }
    };

    const handleConnectDropbox = async () => {
        const p = host.params();
        if (p.isFossBuild) {
            p.showSettingsWarning(p.tr('settings.syncMobile.dropboxUnavailable'), p.tr('settings.syncMobile.dropboxIsDisabledInFossBuilds'));
            return;
        }
        if (!p.dropboxConfigured) {
            p.showSettingsWarning(p.tr('settings.syncMobile.dropboxUnavailable'), p.tr('settings.syncMobile.dropboxAppKeyIsNotConfiguredInThisBuild'));
            return;
        }
        if (p.isExpoGo) {
            p.showSettingsWarning(
                p.tr('settings.syncMobile.dropboxUnavailableInExpoGo'),
                `${p.tr('settings.syncMobile.dropboxOauthRequiresADevelopmentReleaseBuildExpoGoUses')}\n\n${p.tr('settings.syncMobile.useRedirectUri')}: ${host.dropbox.redirectUri()}`,
                6000
            );
            return;
        }
        set({ dropboxBusy: true });
        try {
            const tokens = await host.dropbox.authorize(p.dropboxAppKey);
            rememberTokens(tokens);
            stagedDropboxCredentials = { tokens };
            hasPendingSyncConfiguration = true;
            set({ cloudProvider: 'dropbox' });
            core.addBreadcrumb('settings:syncBackend:cloud');
            set({ syncBackend: 'cloud', dropboxConnected: true });
            p.showToast({
                title: p.tr('common.success'),
                message: p.tr('settings.syncMobile.connectedToDropbox'),
                tone: 'success',
            });
            // Android's OAuth redirect deep link can navigate away and unmount
            // this screen, destroying the staged tokens before any manual
            // "Sync now" tap. Activation must finish inside this continuation,
            // which still owns the staged credentials (#1033).
            await runSync(p, { backend: 'cloud', cloudProvider: 'dropbox' });
        } catch (error) {
            const message = String(error);
            if (/redirect[_\s-]?uri/i.test(message)) {
                p.showSettingsWarning(
                    p.tr('settings.syncMobile.invalidRedirectUri'),
                    `${p.tr('settings.syncMobile.addThisExactRedirectUriInDropboxOauthSettings')}\n\n${host.dropbox.redirectUri()}`,
                    6000
                );
            } else {
                await rememberStoredDropboxTokens();
                p.showSettingsErrorToast(p.tr('settings.syncMobile.connectionFailed'), redact(core.formatError(error)), 5200);
            }
        } finally {
            set({ dropboxBusy: false });
        }
    };

    const handleTestConnection = async (backend: 'webdav' | 'cloud', options?: Omit<SyncSettingsActionOptions, 'backend'>) => {
        const p = host.params();
        set({ isTestingConnection: true });
        const effectiveCloud = options?.cloud ?? {
            allowInsecureHttp: state.cloudAllowInsecureHttp,
            token: state.cloudToken,
            url: state.cloudUrl,
        };
        const effectiveCloudProvider = options?.cloudProvider ?? state.cloudProvider;
        const effectiveWebdav = options?.webdav ?? {
            allowInsecureHttp: state.webdavAllowInsecureHttp,
            password: state.webdavPassword,
            url: state.webdavUrl,
            username: state.webdavUsername,
        };
        remember(effectiveWebdav.password, effectiveCloud.token);
        rememberUrl(effectiveWebdav.url);
        rememberUrl(effectiveCloud.url);
        try {
            if (backend === 'webdav') {
                const trimmedWebDavUrl = effectiveWebdav.url.trim();
                if (!validateSyncHttpUrl(p, trimmedWebDavUrl, effectiveWebdav.allowInsecureHttp, 'WebDAV')) {
                    return;
                }
                const compatibility = await probeWebdavCompatibilityForCurrentEncryptionPosture(core.normalizeWebdavUrl(trimmedWebDavUrl), {
                    ...getMobileWebDavRequestOptions(effectiveWebdav.allowInsecureHttp),
                    username: effectiveWebdav.username.trim(),
                    password: effectiveWebdav.password,
                    timeoutMs: 10_000,
                });
                if (compatibility === 'strong-etag') {
                    await host.rememberWebdavCapabilityProof(effectiveWebdav);
                }
                p.showToast({
                    title: p.tr('settings.syncMobile.connectionOk'),
                    message: p.tr('settings.syncMobile.webdavEndpointIsReachable'),
                    tone: 'success',
                });
                return;
            }

            if (effectiveCloudProvider === 'dropbox') {
                if (p.isFossBuild) {
                    p.showSettingsWarning(p.tr('settings.syncMobile.dropboxUnavailable'), p.tr('settings.syncMobile.dropboxIsDisabledInFossBuilds'));
                    return;
                }
                await runDropboxConnectionTest(p);
                set({ dropboxConnected: true });
                p.showToast({
                    title: p.tr('settings.syncMobile.connectionOk'),
                    message: p.tr('settings.syncMobile.dropboxAccountIsReachable'),
                    tone: 'success',
                });
                return;
            }

            const trimmedCloudUrl = effectiveCloud.url.trim();
            if (!validateSyncHttpUrl(p, trimmedCloudUrl, effectiveCloud.allowInsecureHttp, 'self-hosted')) {
                return;
            }
            await core.cloudGetJson<unknown>(core.normalizeCloudUrl(trimmedCloudUrl), {
                ...getMobileCloudRequestOptions(effectiveCloud.allowInsecureHttp),
                token: effectiveCloud.token,
                timeoutMs: 10_000,
            });
            p.showToast({
                title: p.tr('settings.syncMobile.connectionOk'),
                message: p.tr('settings.syncMobile.selfHostedEndpointIsReachable'),
                tone: 'success',
            });
        } catch (error) {
            if (effectiveCloudProvider === 'dropbox' && core.isDropboxUnauthorizedError(error)) {
                set({ dropboxConnected: false });
            }
            if (effectiveCloudProvider === 'dropbox') await rememberStoredDropboxTokens();
            p.showSettingsErrorToast(
                p.tr('settings.syncMobile.connectionFailed'),
                effectiveCloudProvider === 'dropbox' && core.isDropboxUnauthorizedError(error)
                    ? p.tr('settings.syncMobile.dropboxTokenIsInvalidOrRevokedPleaseTapConnectDropbox')
                    : backend === 'webdav' && core.isSyncEncryptionRemoteVersionUnavailableError(error)
                        ? p.tr('settings.syncEncryptionErrorBackendIncompatible')
                    : redact(core.formatError(error)),
                5200
            );
        } finally {
            set({ isTestingConnection: false });
        }
    };

    return {
        getState: (): SyncSettingsTransportState => state,
        subscribe(listener: () => void): () => void {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        load,
        loadDropboxState,
        refreshCloudKitAccountStatus,
        handleConnectDropbox,
        handleDisconnectDropbox,
        handleSaveSelfHostedSettings,
        handleSaveWebDavSettings,
        handleSelectCloudProvider,
        handleSelectSyncBackend,
        handleSetSyncPath,
        handleSync,
        handleTestConnection,
        handleTestDropboxConnection,
        /** The one redaction for text that leaves the screen (see `redact`). */
        redactText: (text: string): string => redact(text),
        redactError,
        /** The configuration this visit proved last (target state for a replayed request). */
        getProven: () => ({ backend: provenSyncBackend, cloudProvider: provenCloudProvider, pending: hasPendingSyncConfiguration }),
    };
}

export type SyncSettingsTransport = ReturnType<typeof createSyncSettingsTransport>;
