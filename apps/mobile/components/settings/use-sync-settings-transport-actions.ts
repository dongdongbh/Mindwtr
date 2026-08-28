import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
    addBreadcrumb,
    assertWebdavStrongEtagSupport,
    CLOCK_SKEW_THRESHOLD_MS,
    cloudGetJson,
    isConnectionAllowed,
    isSyncEncryptionRemoteVersionUnavailableError,
    isValidCloudSyncToken,
    normalizeCloudUrl,
    normalizeWebdavUrl,
    SYNC_LOCAL_INSECURE_URL_OPTIONS,
    type AppSettings,
} from '@mindwtr/core';

import { pickAndParseSyncFolder } from '@/lib/storage-file';
import { getCloudKitAccountStatus } from '@/lib/cloudkit-sync';
import { authorizeDropbox, getDropboxRedirectUri } from '@/lib/dropbox-oauth';
import {
    clearDropboxTokens,
    disconnectDropbox,
    forceRefreshDropboxAccessToken,
    forceRefreshDropboxAccessTokenForTokens,
    getStoredDropboxTokens,
    getValidDropboxAccessToken,
    getValidDropboxAccessTokenForTokens,
    isDropboxConnected,
    revokeDropboxTokens,
    saveDropboxTokens,
} from '@/lib/dropbox-auth';
import {
    clearMobileSyncConfigCache,
    performMobileSync,
    type MobileDropboxSyncCredentials,
    type MobileSyncConfigOverride,
} from '@/lib/sync-service';
import {
    commitProvenMobileSyncConfiguration,
    MobileSyncConfigurationTransactionError,
} from '@/lib/sync-configuration-transaction';
import { syncMobileBackgroundSyncRegistration } from '@/lib/background-sync-task';
import { getMobileCloudRequestOptions, getMobileWebDavRequestOptions } from '@/lib/webdav-request-options';
import { rememberWebdavCapabilityProof } from '@/lib/webdav-capability-proof';
import { getIncompleteSyncEncryptionTransition } from '@/lib/sync-encryption-state';
import {
    getSyncConflictCount,
    getSyncMaxClockSkewMs,
    getSyncTimestampAdjustments,
    hasSameUserFacingSyncConflictSummary,
    isLikelyOfflineSyncError,
    coerceSupportedBackend,
} from '@/lib/sync-service-utils';
import { testDropboxAccess } from '@/lib/dropbox-sync';
import { formatClockSkew, formatError, isDropboxUnauthorizedError, logSettingsError } from '@/lib/settings-utils';
import {
    CLOUD_PROVIDER_KEY,
    CLOUD_ALLOW_INSECURE_HTTP_KEY,
    CLOUD_TOKEN_KEY,
    CLOUD_URL_KEY,
    SYNC_BACKEND_KEY,
    SYNC_PATH_BOOKMARK_KEY,
    SYNC_PATH_KEY,
    WEBDAV_PASSWORD_KEY,
    WEBDAV_ALLOW_INSECURE_HTTP_KEY,
    WEBDAV_URL_KEY,
    WEBDAV_USERNAME_KEY,
} from '@/lib/sync-constants';
import { deleteSecureConfigValue, getSecureConfigValue, setSecureConfigValue } from '@/lib/secure-config';

import { type CloudProvider, isValidHttpUrl } from './settings.constants';
import { type SelfHostedSyncSettings } from './sync-settings-selfhosted-panel';
import { type WebDavSyncSettings } from './sync-settings-webdav-panel';

export type SyncBackend = 'file' | 'webdav' | 'cloud' | 'cloudkit' | 'off';
export type CloudKitAccountStatus = 'available' | 'noAccount' | 'restricted' | 'temporarilyUnavailable' | 'unknown';

type SyncActionOptions = {
    backend?: 'file' | 'webdav' | 'cloud' | 'cloudkit';
    cloud?: SelfHostedSyncSettings;
    cloudProvider?: CloudProvider;
    webdav?: WebDavSyncSettings;
};

const reconcileBackgroundSyncRegistration = () => {
    void syncMobileBackgroundSyncRegistration().catch(logSettingsError);
};

const persistSyncConfigItem = (key: string, value: string, afterSave?: () => void) => {
    AsyncStorage.setItem(key, value)
        .then(() => {
            clearMobileSyncConfigCache();
            afterSave?.();
        })
        .catch(logSettingsError);
};

const isManualInsecureOverride = (url: string, allowInsecureHttp: boolean): boolean => {
    if (!allowInsecureHttp) return false;
    try {
        if (new URL(url).protocol !== 'http:') return false;
    } catch {
        return false;
    }
    return !isConnectionAllowed(url, SYNC_LOCAL_INSECURE_URL_OPTIONS);
};

type ToastFn = (options: {
    durationMs?: number;
    message: string;
    title: string;
    tone: 'warning' | 'error' | 'success' | 'info';
}) => void;

type UseSyncSettingsTransportActionsParams = {
    dropboxAppKey: string;
    dropboxConfigured: boolean;
    getCloudKitStatusDetails: (status: CloudKitAccountStatus) => { helpText: string; syncEnabled: boolean };
    getSyncFailureToastMessage: (error: unknown) => string;
    isExpoGo: boolean;
    isFossBuild: boolean;
    lastSyncStats: AppSettings['lastSyncStats'] | null | undefined;
    lastSyncStatus: AppSettings['lastSyncStatus'] | undefined;
    tr: (key: string, values?: Record<string, string | number | boolean | null | undefined>) => string;
    resetSyncStatusForBackendSwitch: () => void;
    showSettingsErrorToast: (title: string, message: string, durationMs?: number) => void;
    showSettingsWarning: (title: string, message: string, durationMs?: number) => void;
    showToast: ToastFn;
    supportsNativeICloudSync: boolean;
    t: (key: string) => string;
};

export function useSyncSettingsTransportActions({
    dropboxAppKey,
    dropboxConfigured,
    getCloudKitStatusDetails,
    getSyncFailureToastMessage,
    isExpoGo,
    isFossBuild,
    lastSyncStats,
    lastSyncStatus,
    tr,
    resetSyncStatusForBackendSwitch,
    showSettingsErrorToast,
    showSettingsWarning,
    showToast,
    supportsNativeICloudSync,
    t,
}: UseSyncSettingsTransportActionsParams) {
    const [syncPath, setSyncPath] = useState<string | null>(null);
    const [syncPathBookmark, setSyncPathBookmark] = useState<string | null>(null);
    const [syncBackend, setSyncBackend] = useState<SyncBackend>('off');
    const [isSyncing, setIsSyncing] = useState(false);
    const [isTestingConnection, setIsTestingConnection] = useState(false);
    const [webdavUrl, setWebdavUrl] = useState('');
    const [webdavUsername, setWebdavUsername] = useState('');
    const [webdavPassword, setWebdavPassword] = useState('');
    const [webdavAllowInsecureHttp, setWebdavAllowInsecureHttp] = useState(false);
    const [cloudUrl, setCloudUrl] = useState('');
    const [cloudToken, setCloudToken] = useState('');
    const [cloudAllowInsecureHttp, setCloudAllowInsecureHttp] = useState(false);
    const [cloudProvider, setCloudProvider] = useState<CloudProvider>('selfhosted');
    const provenSyncBackendRef = useRef<SyncBackend>('off');
    const provenCloudProviderRef = useRef<CloudProvider>('selfhosted');
    const hasPendingSyncConfiguration = useRef(false);
    const stagedDropboxCredentialsRef = useRef<MobileDropboxSyncCredentials | null>(null);
    const [dropboxConnected, setDropboxConnected] = useState(false);
    const [dropboxBusy, setDropboxBusy] = useState(false);
    const [cloudKitAccountStatus, setCloudKitAccountStatus] = useState<CloudKitAccountStatus>('unknown');
    const formatText = useCallback((key: string, replacements: Record<string, string | number>) => {
        let text = t(key);
        Object.entries(replacements).forEach(([name, value]) => {
            text = text.split(`{${name}}`).join(String(value));
        });
        return text;
    }, [t]);

    const runDropboxConnectionTest = useCallback(async () => {
        const stagedCredentials = stagedDropboxCredentialsRef.current;
        let accessToken: string;
        if (stagedCredentials) {
            const resolution = await getValidDropboxAccessTokenForTokens(
                dropboxAppKey,
                stagedCredentials.tokens,
            );
            stagedCredentials.tokens = resolution.tokens;
            accessToken = resolution.accessToken;
        } else {
            accessToken = await getValidDropboxAccessToken(dropboxAppKey);
        }
        try {
            await testDropboxAccess(accessToken);
        } catch (error) {
            if (!isDropboxUnauthorizedError(error)) {
                throw error;
            }
            if (stagedCredentials) {
                const resolution = await forceRefreshDropboxAccessTokenForTokens(
                    dropboxAppKey,
                    stagedCredentials.tokens,
                );
                stagedCredentials.tokens = resolution.tokens;
                accessToken = resolution.accessToken;
            } else {
                accessToken = await forceRefreshDropboxAccessToken(dropboxAppKey);
            }
            await testDropboxAccess(accessToken);
        }
    }, [dropboxAppKey]);

    const validateSyncHttpUrl = useCallback((url: string, allowInsecureHttp: boolean, label: 'WebDAV' | 'self-hosted'): boolean => {
        if (!url || !isValidHttpUrl(url)) {
            showSettingsWarning(
                tr('settings.syncMobile.invalidUrl'),
                label === 'WebDAV'
                    ? tr('settings.syncMobile.pleaseEnterAValidWebdavUrlHttpHttps')
                    : tr('settings.syncMobile.pleaseEnterAValidSelfHostedUrlHttpHttps')
            );
            return false;
        }
        if (!isConnectionAllowed(url, {
            ...SYNC_LOCAL_INSECURE_URL_OPTIONS,
            allowInsecureHttp,
        })) {
            showSettingsWarning(
                tr('settings.syncMobile.httpsRequired'),
                tr('settings.syncMobile.publicHttpSyncUrlsAreBlockedUseHttpsOrEnable'),
                6500
            );
            return false;
        }
        if (isManualInsecureOverride(url, allowInsecureHttp)) {
            showSettingsWarning(
                tr('settings.syncMobile.insecureHttpEnabled'),
                tr('settings.syncMobile.onlyUseThisOnTrustedNetworksSyncDataWillBe'),
                6500
            );
        }
        return true;
    }, [tr, showSettingsWarning]);

    // Mobile self-hosted forms hold the real token (unlike desktop's keyring-backed
    // "empty = unchanged"): an empty token is valid (no auth), but a non-empty token
    // that fails the shape check must block the save.
    const validateCloudToken = useCallback((token: string): boolean => {
        if (!token || isValidCloudSyncToken(token)) return true;
        showSettingsWarning(
            tr('settings.syncMobile.error'),
            tr('settings.cloudTokenInvalid')
        );
        return false;
    }, [tr, showSettingsWarning]);

    useEffect(() => {
        let cancelled = false;

        Promise.all([
            AsyncStorage.multiGet([
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
            getSecureConfigValue(WEBDAV_PASSWORD_KEY),
            getSecureConfigValue(CLOUD_TOKEN_KEY),
        ]).then(([entries, storedWebDavPassword, storedCloudToken]) => {
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

            setSyncPath(path || null);
            setSyncPathBookmark(pathBookmark || null);
            setWebdavUrl(storedWebDavUrl || '');
            setWebdavUsername(storedWebDavUsername || '');
            setWebdavPassword(storedWebDavPassword || '');
            setWebdavAllowInsecureHttp(storedWebDavAllowInsecureHttp === 'true');
            setCloudUrl(storedCloudUrl || '');
            setCloudToken(storedCloudToken || '');
            setCloudAllowInsecureHttp(storedCloudAllowInsecureHttp === 'true');

            const resolvedBackend = storedBackend === 'webdav'
                || storedBackend === 'cloud'
                || storedBackend === 'off'
                || storedBackend === 'file'
                || storedBackend === 'cloudkit'
                ? storedBackend
                : 'off';
            const unsupportedDropboxBackend = resolvedBackend === 'cloud'
                && storedCloudProvider === 'dropbox'
                && !dropboxConfigured;
            const supportedBackend = unsupportedDropboxBackend
                ? 'off'
                : coerceSupportedBackend(resolvedBackend, supportsNativeICloudSync);
            setSyncBackend(supportedBackend);
            provenSyncBackendRef.current = supportedBackend;

            const resolvedCloudProvider: CloudProvider = (
                (resolvedBackend === 'cloudkit' || storedCloudProvider === 'cloudkit') && supportsNativeICloudSync
            )
                ? 'cloudkit'
                : storedCloudProvider === 'dropbox' && dropboxConfigured
                    ? 'dropbox'
                    : 'selfhosted';
            setCloudProvider(resolvedCloudProvider);
            provenCloudProviderRef.current = resolvedCloudProvider;

            if (resolvedBackend !== supportedBackend) {
                persistSyncConfigItem(SYNC_BACKEND_KEY, supportedBackend);
            }
            if (!dropboxConfigured && storedCloudProvider === 'dropbox') {
                persistSyncConfigItem(CLOUD_PROVIDER_KEY, 'selfhosted');
            }
            if (!supportsNativeICloudSync && storedCloudProvider === 'cloudkit') {
                persistSyncConfigItem(CLOUD_PROVIDER_KEY, 'selfhosted');
            }
            reconcileBackgroundSyncRegistration();
        }).catch(logSettingsError);

        return () => {
            cancelled = true;
        };
    }, [dropboxConfigured, supportsNativeICloudSync]);

    const refreshCloudKitAccountStatus = useCallback(async () => {
        if (!supportsNativeICloudSync) {
            setCloudKitAccountStatus('unknown');
            return;
        }
        setCloudKitAccountStatus(await getCloudKitAccountStatus());
    }, [supportsNativeICloudSync]);

    useEffect(() => {
        void refreshCloudKitAccountStatus();
    }, [refreshCloudKitAccountStatus]);

    useEffect(() => {
        if (syncBackend !== 'cloudkit') return;
        void refreshCloudKitAccountStatus();
    }, [refreshCloudKitAccountStatus, syncBackend]);

    useEffect(() => {
        let cancelled = false;

        const loadDropboxState = async () => {
            if (!dropboxConfigured) {
                if (!cancelled) setDropboxConnected(false);
                return;
            }
            try {
                const connected = await isDropboxConnected();
                if (!cancelled) setDropboxConnected(connected);
            } catch {
                if (!cancelled) setDropboxConnected(false);
            }
        };

        void loadDropboxState();
        return () => {
            cancelled = true;
        };
    }, [dropboxConfigured]);

    const handleSelectSyncBackend = useCallback((backend: 'off' | 'file' | 'webdav' | 'cloud') => {
        const nextBackend = backend === 'cloud'
            ? (cloudProvider === 'cloudkit' ? 'cloudkit' : 'cloud')
            : backend;
        addBreadcrumb(`settings:syncBackend:${nextBackend}`);
        setSyncBackend(nextBackend);
        if (nextBackend === 'off') {
            hasPendingSyncConfiguration.current = false;
            provenSyncBackendRef.current = 'off';
            resetSyncStatusForBackendSwitch();
            persistSyncConfigItem(SYNC_BACKEND_KEY, nextBackend, reconcileBackgroundSyncRegistration);
        } else if (nextBackend !== provenSyncBackendRef.current) {
            hasPendingSyncConfiguration.current = true;
        }
    }, [cloudProvider, resetSyncStatusForBackendSwitch]);

    const handleSelectCloudProvider = useCallback((provider: CloudProvider) => {
        if (provider === 'cloudkit' && !supportsNativeICloudSync) return;
        if (provider === 'dropbox' && !dropboxConfigured) return;

        const nextBackend: SyncBackend = provider === 'cloudkit' ? 'cloudkit' : 'cloud';
        if (provider !== provenCloudProviderRef.current || nextBackend !== provenSyncBackendRef.current) {
            hasPendingSyncConfiguration.current = true;
        }
        setCloudProvider(provider);
        setSyncBackend(nextBackend);
    }, [dropboxConfigured, supportsNativeICloudSync]);

    const handleSetSyncPath = useCallback(async () => {
        try {
            // iOS: providers whose Files app integration can't offer folders
            // (Google Drive, OneDrive, ownCloud…) still work through a backup
            // JSON picked in place — but only if the user knows the second
            // sheet exists and what to put in it (#1068).
            const confirmFileFallback = () => new Promise<boolean>((resolve) => {
                Alert.alert(
                    tr('settings.syncMobile.iosFolderFallbackTitle'),
                    tr('settings.syncMobile.iosFolderFallbackMessage'),
                    [
                        { text: tr('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
                        { text: tr('settings.syncMobile.iosFolderFallbackConfirm'), onPress: () => resolve(true) },
                    ],
                    { cancelable: true, onDismiss: () => resolve(false) },
                );
            });
            const result = await pickAndParseSyncFolder({ confirmFileFallback });
            if (!result) return;
            const fileUri = (result as { __fileUri: string }).__fileUri;
            const fileBookmark = (result as { __fileBookmark?: string }).__fileBookmark?.trim() ?? null;
            if (!fileUri) return;

            setSyncPath(fileUri);
            setSyncPathBookmark(fileBookmark);
            hasPendingSyncConfiguration.current = true;
            addBreadcrumb('settings:syncBackend:file');
            setSyncBackend('file');
        } catch (error) {
            const message = String(error);
            if (/Selected JSON file is not a Mindwtr backup/i.test(message)) {
                showSettingsWarning(
                    tr('settings.syncMobile.invalidSyncFile'),
                    tr('settings.syncMobile.pleaseChooseAMindwtrBackupJsonFileInTheTarget'),
                    5200
                );
                return;
            }
            if (/temporary Inbox location|re-select a folder in Settings -> (?:Data & Sync|Sync)/i.test(message)) {
                showSettingsWarning(
                    tr('settings.syncMobile.unsupportedCloudProviderOnIos'),
                    tr('settings.syncMobile.theSelectedFileCameFromATemporaryIosFilesCopy'),
                    5600
                );
                return;
            }
            if (/read-only|read only|not writable|isn't writable|permission denied|EACCES/i.test(message)) {
                showSettingsWarning(
                    tr('settings.syncMobile.syncFolderIsReadOnly'),
                    Platform.OS === 'ios'
                        ? tr('settings.syncMobile.theSelectedFolderIsReadOnlyChooseAWritableLocation')
                        : tr('settings.syncMobile.theSelectedFolderIsReadOnlyPleaseChooseAWritable'),
                    5600
                );
                return;
            }
            showSettingsErrorToast(tr('settings.syncMobile.error'), tr('settings.syncMobile.failedToSetSyncPath'));
        }
    }, [
        tr,
        showSettingsErrorToast,
        showSettingsWarning,
    ]);

    const handleDisconnectDropbox = useCallback(async () => {
        setDropboxBusy(true);
        try {
            const stagedCredentials = stagedDropboxCredentialsRef.current;
            const disconnectingProvenDropbox = (
                provenSyncBackendRef.current === 'cloud'
                && provenCloudProviderRef.current === 'dropbox'
            );
            if (
                disconnectingProvenDropbox
            ) {
                await AsyncStorage.setItem(SYNC_BACKEND_KEY, 'off');
                clearMobileSyncConfigCache();
                const [[, persistedBackend]] = await AsyncStorage.multiGet([SYNC_BACKEND_KEY]);
                if (persistedBackend !== 'off') {
                    throw new Error('Dropbox sync could not be disabled before disconnecting');
                }
                provenSyncBackendRef.current = 'off';
                hasPendingSyncConfiguration.current = false;
                setSyncBackend('off');
                reconcileBackgroundSyncRegistration();
            }
            if (stagedCredentials && dropboxConfigured) {
                await revokeDropboxTokens(dropboxAppKey, stagedCredentials.tokens);
            }
            stagedDropboxCredentialsRef.current = null;
            if (dropboxConfigured) {
                await disconnectDropbox(dropboxAppKey);
            } else {
                // A FOSS or otherwise unconfigured build cannot revoke the
                // remote token, but it must still let the user remove local
                // credentials left by a previously configured build.
                await clearDropboxTokens();
            }
            if (!disconnectingProvenDropbox) {
                // A failed activation leaves Dropbox selected only in this
                // screen's staged UI. Disconnect must return to the last
                // configuration that actually completed its probe.
                hasPendingSyncConfiguration.current = false;
                setSyncBackend(provenSyncBackendRef.current);
                setCloudProvider(provenCloudProviderRef.current);
            }
            setDropboxConnected(false);
            resetSyncStatusForBackendSwitch();
            reconcileBackgroundSyncRegistration();
            showToast({
                title: tr('settings.syncMobile.disconnected'),
                message: tr('settings.syncMobile.dropboxConnectionRemoved'),
                tone: 'success',
            });
        } catch (error) {
            showSettingsErrorToast(tr('settings.syncMobile.disconnectFailed'), formatError(error), 5200);
        } finally {
            setDropboxBusy(false);
        }
    }, [
        dropboxAppKey,
        dropboxConfigured,
        tr,
        resetSyncStatusForBackendSwitch,
        showSettingsErrorToast,
        showToast,
    ]);

    const handleTestDropboxConnection = useCallback(async () => {
        if (isFossBuild) {
            showSettingsWarning(tr('settings.syncMobile.dropboxUnavailable'), tr('settings.syncMobile.dropboxIsDisabledInFossBuilds'));
            return;
        }
        if (!dropboxConfigured) {
            showSettingsWarning(tr('settings.syncMobile.dropboxUnavailable'), tr('settings.syncMobile.dropboxAppKeyIsNotConfiguredInThisBuild'));
            return;
        }
        setIsTestingConnection(true);
        try {
            await runDropboxConnectionTest();
            setDropboxConnected(true);
            showToast({
                title: tr('settings.syncMobile.connectionOk'),
                message: tr('settings.syncMobile.dropboxAccountIsReachable'),
                tone: 'success',
            });
        } catch (error) {
            if (isDropboxUnauthorizedError(error)) {
                setDropboxConnected(false);
                showSettingsWarning(
                    tr('settings.syncMobile.connectionFailed'),
                    tr('settings.syncMobile.dropboxTokenIsInvalidOrRevokedPleaseTapConnectDropbox'),
                    5200
                );
            } else {
                showSettingsErrorToast(tr('settings.syncMobile.connectionFailed'), formatError(error), 5200);
            }
        } finally {
            setIsTestingConnection(false);
        }
    }, [
        dropboxConfigured,
        isFossBuild,
        tr,
        runDropboxConnectionTest,
        showSettingsErrorToast,
        showSettingsWarning,
        showToast,
    ]);

    const handleSaveWebDavSettings = useCallback(async (nextSettings: WebDavSyncSettings) => {
        const trimmedUrl = nextSettings.url.trim();
        if (!validateSyncHttpUrl(trimmedUrl, nextSettings.allowInsecureHttp, 'WebDAV')) {
            return;
        }
        const trimmedUsername = nextSettings.username.trim();
        setWebdavUrl(trimmedUrl);
        setWebdavUsername(trimmedUsername);
        setWebdavPassword(nextSettings.password);
        setWebdavAllowInsecureHttp(nextSettings.allowInsecureHttp);
        setSyncBackend('webdav');
        hasPendingSyncConfiguration.current = true;
    }, [validateSyncHttpUrl]);

    const handleSaveSelfHostedSettings = useCallback(async (nextSettings: SelfHostedSyncSettings) => {
        const trimmedUrl = nextSettings.url.trim();
        if (!validateSyncHttpUrl(trimmedUrl, nextSettings.allowInsecureHttp, 'self-hosted')) {
            return;
        }
        if (!validateCloudToken(nextSettings.token.trim())) {
            return;
        }
        setCloudUrl(trimmedUrl);
        setCloudToken(nextSettings.token);
        setCloudAllowInsecureHttp(nextSettings.allowInsecureHttp);
        setCloudProvider('selfhosted');
        setSyncBackend('cloud');
        hasPendingSyncConfiguration.current = true;
    }, [
        validateCloudToken,
        validateSyncHttpUrl,
    ]);

    const commitProvenSyncConfiguration = useCallback(async (config: MobileSyncConfigOverride) => {
        try {
            await commitProvenMobileSyncConfiguration(config, {
                clearConfigCache: clearMobileSyncConfigCache,
                clearDropboxTokens,
                deleteSecret: deleteSecureConfigValue,
                getDropboxTokens: getStoredDropboxTokens,
                getIncompleteSyncEncryptionTransition,
                getSecret: getSecureConfigValue,
                multiGet: (keys) => AsyncStorage.multiGet(keys),
                multiSet: (entries) => AsyncStorage.multiSet(entries),
                removeItem: (key) => AsyncStorage.removeItem(key),
                saveDropboxTokens,
                setItem: (key, value) => AsyncStorage.setItem(key, value),
                setSecret: setSecureConfigValue,
            });
        } catch (error) {
            if (
                error instanceof MobileSyncConfigurationTransactionError
                && error.syncRemainsDisabled
            ) {
                provenSyncBackendRef.current = 'off';
                setSyncBackend('off');
                resetSyncStatusForBackendSwitch();
                reconcileBackgroundSyncRegistration();
            }
            throw error;
        }

        provenSyncBackendRef.current = config.backend;
        if (config.backend === 'cloudkit') {
            provenCloudProviderRef.current = 'cloudkit';
        } else if (config.backend === 'cloud') {
            provenCloudProviderRef.current = config.cloudProvider ?? 'selfhosted';
        }
        if (config.cloudProvider === 'dropbox' && config.dropbox) {
            stagedDropboxCredentialsRef.current = null;
        }
        hasPendingSyncConfiguration.current = false;
        reconcileBackgroundSyncRegistration();
    }, [resetSyncStatusForBackendSwitch]);

    const handleSync = useCallback(async (options?: SyncActionOptions) => {
        addBreadcrumb('sync:manual');
        setIsSyncing(true);
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
            const previousLastSyncStatus = lastSyncStatus;
            const previousLastSyncStats = lastSyncStats ?? null;
            const effectiveBackend = options?.backend ?? syncBackend;
            const configOverride: MobileSyncConfigOverride = { backend: effectiveBackend };
            const effectiveCloud = options?.cloud ?? {
                allowInsecureHttp: cloudAllowInsecureHttp,
                token: cloudToken,
                url: cloudUrl,
            };
            const effectiveCloudProvider = options?.cloudProvider ?? cloudProvider;
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
                if (!validateSyncHttpUrl(trimmedWebDavUrl, effectiveWebdav.allowInsecureHttp, 'WebDAV')) {
                    return;
                }
                const trimmedWebDavUsername = effectiveWebdav.username.trim();
                configOverride.webdav = {
                    allowInsecureHttp: effectiveWebdav.allowInsecureHttp,
                    password: effectiveWebdav.password,
                    url: trimmedWebDavUrl,
                    username: trimmedWebDavUsername,
                };
                setWebdavUrl(trimmedWebDavUrl);
                setWebdavUsername(trimmedWebDavUsername);
                setWebdavPassword(effectiveWebdav.password);
                setWebdavAllowInsecureHttp(effectiveWebdav.allowInsecureHttp);
                setSyncBackend('webdav');
            } else if (effectiveBackend === 'cloudkit') {
                const accountStatus = await getCloudKitAccountStatus();
                setCloudKitAccountStatus(accountStatus);
                const statusDetails = getCloudKitStatusDetails(accountStatus);
                if (!statusDetails.syncEnabled) {
                    showSettingsWarning(tr('settings.syncMobile.icloudUnavailable'), statusDetails.helpText, 5200);
                    return;
                }
                setCloudProvider('cloudkit');
                setSyncBackend('cloudkit');
            } else if (effectiveBackend === 'cloud') {
                if (effectiveCloudProvider === 'dropbox') {
                    if (isFossBuild) {
                        showSettingsWarning(tr('settings.syncMobile.dropboxUnavailable'), tr('settings.syncMobile.dropboxIsDisabledInFossBuilds'));
                        return;
                    }
                    if (!dropboxConfigured) {
                        showSettingsWarning(tr('settings.syncMobile.dropboxUnavailable'), tr('settings.syncMobile.dropboxAppKeyIsNotConfiguredInThisBuild'));
                        return;
                    }
                    const stagedCredentials = stagedDropboxCredentialsRef.current;
                    const connected = Boolean(stagedCredentials) || await isDropboxConnected();
                    if (!connected) {
                        showSettingsWarning(tr('common.notice'), tr('settings.syncMobile.pleaseConnectDropboxFirst'));
                        return;
                    }
                    configOverride.cloudProvider = 'dropbox';
                    if (stagedCredentials) {
                        configOverride.dropbox = stagedCredentials;
                    }
                    setCloudProvider('dropbox');
                    setSyncBackend('cloud');
                } else {
                    const trimmedCloudUrl = effectiveCloud.url.trim();
                    if (!trimmedCloudUrl) {
                        showSettingsWarning(tr('common.notice'), tr('settings.syncMobile.pleaseSetASelfHostedUrlFirst'));
                        return;
                    }
                    if (!validateSyncHttpUrl(trimmedCloudUrl, effectiveCloud.allowInsecureHttp, 'self-hosted')) {
                        return;
                    }
                    if (!validateCloudToken(effectiveCloud.token.trim())) {
                        return;
                    }
                    configOverride.cloudProvider = 'selfhosted';
                    configOverride.cloud = {
                        allowInsecureHttp: effectiveCloud.allowInsecureHttp,
                        token: effectiveCloud.token,
                        url: trimmedCloudUrl,
                    };
                    setCloudUrl(trimmedCloudUrl);
                    setCloudToken(effectiveCloud.token);
                    setCloudAllowInsecureHttp(effectiveCloud.allowInsecureHttp);
                    setCloudProvider('selfhosted');
                    setSyncBackend('cloud');
                }
            } else {
                if (!syncPath) {
                    showSettingsWarning(tr('common.notice'), tr('settings.syncMobile.pleaseSetASyncFolderFirst'));
                    return;
                }
                configOverride.syncPath = syncPath;
                configOverride.syncPathBookmark = syncPathBookmark;
                setSyncBackend('file');
            }

            const needsActivationProbe = Boolean(options)
                || hasPendingSyncConfiguration.current
                || effectiveBackend !== provenSyncBackendRef.current
                || (
                    effectiveBackend === 'cloud'
                    && effectiveCloudProvider !== provenCloudProviderRef.current
                )
                || (
                    effectiveBackend === 'cloudkit'
                    && provenCloudProviderRef.current !== 'cloudkit'
            );
            if (needsActivationProbe) {
                if (configOverride.backend === 'webdav' && configOverride.webdav) {
                    await assertWebdavStrongEtagSupport(normalizeWebdavUrl(configOverride.webdav.url), {
                        ...getMobileWebDavRequestOptions(configOverride.webdav.allowInsecureHttp),
                        username: configOverride.webdav.username,
                        password: configOverride.webdav.password,
                        timeoutMs: 10_000,
                    });
                    await rememberWebdavCapabilityProof(configOverride.webdav);
                }
                const probeResult = await performMobileSync(
                    effectiveBackend === 'file' ? syncPath || undefined : undefined,
                    { activationProbe: true, manual: true, configOverride }
                );
                if (probeResult.skipped === 'offline' || isLikelyOfflineSyncError(probeResult.error)) {
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
                        await commitProvenSyncConfiguration(configOverride);
                        showSettingsWarning(
                            tr('common.notice'),
                            tr('settings.syncEncryptionRemoteEncrypted'),
                            6000,
                        );
                        return;
                    }
                    throw new Error(probeResult.error || 'Sync setup could not be verified');
                }
                await commitProvenSyncConfiguration(configOverride);
                if (activationCleanupDeferred) {
                    if (activationCleanupDeferred === 'file') showFileSyncLockFeedback('cleanup');
                    else showRemoteFenceFeedback('cleanup');
                    return;
                }
            }

            const result = await performMobileSync(undefined, {
                manual: true,
                ignorePendingRemoteWriteBackoff: needsActivationProbe,
            });
            if (result.skipped === 'offline' || isLikelyOfflineSyncError(result.error)) {
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
                const conflictCount = getSyncConflictCount(result.stats);
                const maxResultClockSkewMs = getSyncMaxClockSkewMs(result.stats);
                const resultTimestampAdjustments = getSyncTimestampAdjustments(result.stats);
                const shouldSuppressDuplicateConflictNotice = (
                    (previousLastSyncStatus === 'success' || previousLastSyncStatus === 'conflict')
                    && hasSameUserFacingSyncConflictSummary(result.stats, previousLastSyncStats)
                );
                const warningDetails = [
                    maxResultClockSkewMs > CLOCK_SKEW_THRESHOLD_MS
                        ? formatText('settings.syncClockSkewWarning', {
                            skew: formatClockSkew(maxResultClockSkewMs),
                        })
                        : null,
                    resultTimestampAdjustments > 0
                        ? formatText('settings.syncAdjustedTimestamps', {
                            count: resultTimestampAdjustments,
                        })
                        : null,
                ].filter(Boolean);
                showToast({
                    title: t('common.success'),
                    message: [
                        conflictCount > 0 && !shouldSuppressDuplicateConflictNotice
                            ? formatText('settings.syncCompletedWithConflicts', { count: conflictCount })
                            : t('settings.syncCompleted'),
                        ...warningDetails,
                    ].join('\n\n'),
                    tone: conflictCount > 0 || warningDetails.length > 0 ? 'warning' : 'success',
                    durationMs: warningDetails.length > 0 || conflictCount > 0 ? 5200 : 3600,
                });
            } else {
                throw new Error(result.error || 'Unknown error');
            }
        } catch (error) {
            const message = String(error);
            if (/temporary Inbox location|re-select a folder in Settings -> (?:Data & Sync|Sync)|Cannot access the selected sync file/i.test(message)) {
                showSettingsWarning(
                    tr('settings.syncMobile.unsupportedCloudProviderOnIos'),
                    tr('settings.syncMobile.theSelectedFileCameFromATemporaryIosFilesCopy2'),
                    5600
                );
                return;
            }
            showSettingsErrorToast(
                tr('settings.syncMobile.error'),
                isSyncEncryptionRemoteVersionUnavailableError(error)
                    ? tr('settings.syncEncryptionErrorBackendIncompatible')
                    : getSyncFailureToastMessage(error),
            );
        } finally {
            setIsSyncing(false);
        }
    }, [
        cloudAllowInsecureHttp,
        cloudProvider,
        cloudToken,
        cloudUrl,
        commitProvenSyncConfiguration,
        dropboxConfigured,
        getCloudKitStatusDetails,
        getSyncFailureToastMessage,
        isFossBuild,
        lastSyncStats,
        lastSyncStatus,
        t,
        tr,
        formatText,
        showSettingsErrorToast,
        showSettingsWarning,
        showToast,
        syncBackend,
        syncPath,
        syncPathBookmark,
        validateCloudToken,
        validateSyncHttpUrl,
        webdavAllowInsecureHttp,
        webdavPassword,
        webdavUrl,
        webdavUsername,
    ]);

    const handleConnectDropbox = useCallback(async () => {
        if (isFossBuild) {
            showSettingsWarning(tr('settings.syncMobile.dropboxUnavailable'), tr('settings.syncMobile.dropboxIsDisabledInFossBuilds'));
            return;
        }
        if (!dropboxConfigured) {
            showSettingsWarning(tr('settings.syncMobile.dropboxUnavailable'), tr('settings.syncMobile.dropboxAppKeyIsNotConfiguredInThisBuild'));
            return;
        }
        if (isExpoGo) {
            showSettingsWarning(
                tr('settings.syncMobile.dropboxUnavailableInExpoGo'),
                `${tr('settings.syncMobile.dropboxOauthRequiresADevelopmentReleaseBuildExpoGoUses')}\n\n${tr('settings.syncMobile.useRedirectUri')}: ${getDropboxRedirectUri()}`,
                6000
            );
            return;
        }
        setDropboxBusy(true);
        try {
            const tokens = await authorizeDropbox(dropboxAppKey);
            stagedDropboxCredentialsRef.current = { tokens };
            hasPendingSyncConfiguration.current = true;
            setCloudProvider('dropbox');
            addBreadcrumb('settings:syncBackend:cloud');
            setSyncBackend('cloud');
            setDropboxConnected(true);
            showToast({
                title: tr('common.success'),
                message: tr('settings.syncMobile.connectedToDropbox'),
                tone: 'success',
            });
            // Android's OAuth redirect deep link can navigate away and unmount
            // this screen, destroying the staged tokens before any manual
            // "Sync now" tap. Activation must finish inside this continuation,
            // which still owns the staged credentials (#1033).
            await handleSync({ backend: 'cloud', cloudProvider: 'dropbox' });
        } catch (error) {
            const message = String(error);
            if (/redirect[_\s-]?uri/i.test(message)) {
                showSettingsWarning(
                    tr('settings.syncMobile.invalidRedirectUri'),
                    `${tr('settings.syncMobile.addThisExactRedirectUriInDropboxOauthSettings')}\n\n${getDropboxRedirectUri()}`,
                    6000
                );
            } else {
                showSettingsErrorToast(tr('settings.syncMobile.connectionFailed'), formatError(error), 5200);
            }
        } finally {
            setDropboxBusy(false);
        }
    }, [
        dropboxAppKey,
        dropboxConfigured,
        handleSync,
        isExpoGo,
        isFossBuild,
        tr,
        showSettingsErrorToast,
        showSettingsWarning,
        showToast,
    ]);

    const handleTestConnection = useCallback(async (backend: 'webdav' | 'cloud', options?: Omit<SyncActionOptions, 'backend'>) => {
        setIsTestingConnection(true);
        const effectiveCloud = options?.cloud ?? {
            allowInsecureHttp: cloudAllowInsecureHttp,
            token: cloudToken,
            url: cloudUrl,
        };
        const effectiveCloudProvider = options?.cloudProvider ?? cloudProvider;
        const effectiveWebdav = options?.webdav ?? {
            allowInsecureHttp: webdavAllowInsecureHttp,
            password: webdavPassword,
            url: webdavUrl,
            username: webdavUsername,
        };
        try {
            if (backend === 'webdav') {
                const trimmedWebDavUrl = effectiveWebdav.url.trim();
                if (!validateSyncHttpUrl(trimmedWebDavUrl, effectiveWebdav.allowInsecureHttp, 'WebDAV')) {
                    return;
                }
                await assertWebdavStrongEtagSupport(normalizeWebdavUrl(trimmedWebDavUrl), {
                    ...getMobileWebDavRequestOptions(effectiveWebdav.allowInsecureHttp),
                    username: effectiveWebdav.username.trim(),
                    password: effectiveWebdav.password,
                    timeoutMs: 10_000,
                });
                await rememberWebdavCapabilityProof(effectiveWebdav);
                showToast({
                    title: tr('settings.syncMobile.connectionOk'),
                    message: tr('settings.syncMobile.webdavEndpointIsReachable'),
                    tone: 'success',
                });
                return;
            }

            if (effectiveCloudProvider === 'dropbox') {
                if (isFossBuild) {
                    showSettingsWarning(tr('settings.syncMobile.dropboxUnavailable'), tr('settings.syncMobile.dropboxIsDisabledInFossBuilds'));
                    return;
                }
                await runDropboxConnectionTest();
                setDropboxConnected(true);
                showToast({
                    title: tr('settings.syncMobile.connectionOk'),
                    message: tr('settings.syncMobile.dropboxAccountIsReachable'),
                    tone: 'success',
                });
                return;
            }

            const trimmedCloudUrl = effectiveCloud.url.trim();
            if (!validateSyncHttpUrl(trimmedCloudUrl, effectiveCloud.allowInsecureHttp, 'self-hosted')) {
                return;
            }
            await cloudGetJson<unknown>(normalizeCloudUrl(trimmedCloudUrl), {
                ...getMobileCloudRequestOptions(effectiveCloud.allowInsecureHttp),
                token: effectiveCloud.token,
                timeoutMs: 10_000,
            });
            showToast({
                title: tr('settings.syncMobile.connectionOk'),
                message: tr('settings.syncMobile.selfHostedEndpointIsReachable'),
                tone: 'success',
            });
        } catch (error) {
            if (effectiveCloudProvider === 'dropbox' && isDropboxUnauthorizedError(error)) {
                setDropboxConnected(false);
            }
            showSettingsErrorToast(
                tr('settings.syncMobile.connectionFailed'),
                effectiveCloudProvider === 'dropbox' && isDropboxUnauthorizedError(error)
                    ? tr('settings.syncMobile.dropboxTokenIsInvalidOrRevokedPleaseTapConnectDropbox')
                    : backend === 'webdav' && isSyncEncryptionRemoteVersionUnavailableError(error)
                        ? tr('settings.syncEncryptionErrorBackendIncompatible')
                    : formatError(error),
                5200
            );
        } finally {
            setIsTestingConnection(false);
        }
    }, [
        cloudAllowInsecureHttp,
        cloudProvider,
        cloudToken,
        cloudUrl,
        isFossBuild,
        tr,
        runDropboxConnectionTest,
        showSettingsErrorToast,
        showSettingsWarning,
        showToast,
        validateSyncHttpUrl,
        webdavAllowInsecureHttp,
        webdavPassword,
        webdavUrl,
        webdavUsername,
    ]);

    return {
        cloudKitAccountStatus,
        cloudAllowInsecureHttp,
        cloudProvider,
        cloudToken,
        cloudUrl,
        dropboxBusy,
        dropboxConnected,
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
        isSyncing,
        isTestingConnection,
        syncBackend,
        syncPath,
        webdavAllowInsecureHttp,
        webdavPassword,
        webdavUrl,
        webdavUsername,
    };
}
