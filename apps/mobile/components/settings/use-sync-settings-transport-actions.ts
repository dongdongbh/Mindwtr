import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Alert, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
    addBreadcrumb,
    CLOCK_SKEW_THRESHOLD_MS,
    cloudGetJson,
    formatActivationMissingAttachments,
    isConnectionAllowed,
    isSyncEncryptionRemoteVersionUnavailableError,
    isValidCloudSyncToken,
    normalizeCloudUrl,
    normalizeWebdavUrl,
    probeWebdavSyncCompatibility,
    SyncEncryptionRemoteVersionUnavailableError,
    SYNC_LOCAL_INSECURE_URL_OPTIONS,
} from '@mindwtr/core';
import {
    createSyncSettingsTransport,
    type SyncSettingsTransport,
    type SyncSettingsTransportParams,
} from '@mindwtr/core/sync-settings-transport';

import { logInfo } from '@/lib/app-log';
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
} from '@/lib/sync-service';
import {
    syncMobileBackgroundSyncRegistration,
} from '@/lib/background-sync-task';
import { rememberWebdavCapabilityProof } from '@/lib/webdav-capability-proof';
import {
    getIncompleteSyncEncryptionTransition,
    getMobileSyncEncryptionStatus,
} from '@/lib/sync-encryption-state';
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
import { deleteSecureConfigValue, getSecureConfigValue, setSecureConfigValue } from '@/lib/secure-config';

// The transport rules live in core (sync-settings-transport.ts) so the native app runs them
// too; this hook binds them to AsyncStorage, the secure config, the sync service, the folder
// picker, CloudKit and Dropbox, and hands React the controller's state.
export type { SyncSettingsBackend as SyncBackend, CloudKitAccountStatus } from '@mindwtr/core/sync-settings-model';

type UseSyncSettingsTransportActionsParams = SyncSettingsTransportParams;

// Activation found files on neither this device nor the new location: Continue keeps the
// rows (shown as missing) and leaves the files where they are; Cancel changes nothing.
const confirmActivationWithoutFiles = (
    tr: UseSyncSettingsTransportActionsParams['tr'],
): NonNullable<SyncSettingsTransportParams['confirmActivationWithoutFiles']> => (files) => new Promise<boolean>((resolve) => {
    Alert.alert(
        tr('settings.syncMissingFilesTitle'),
        tr('settings.syncMissingFilesBody', {
            files: formatActivationMissingAttachments(files, (count) => tr('settings.syncMissingFilesMore', { count })),
        }),
        [
            { text: tr('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
            { text: tr('settings.syncMissingFilesContinue'), onPress: () => resolve(true) },
        ],
        { cancelable: true, onDismiss: () => resolve(false) },
    );
});

const createTransport = (params: () => UseSyncSettingsTransportActionsParams): SyncSettingsTransport => createSyncSettingsTransport({
    params: () => {
        const current = params();
        return { ...current, confirmActivationWithoutFiles: confirmActivationWithoutFiles(current.tr) };
    },
    storage: {
        multiGet: (keys) => AsyncStorage.multiGet(keys),
        setItem: (key, value) => AsyncStorage.setItem(key, value),
        multiSet: (entries) => AsyncStorage.multiSet(entries as [string, string][]),
        removeItem: (key) => AsyncStorage.removeItem(key),
    },
    secrets: {
        get: (key) => getSecureConfigValue(key),
        set: (key, value) => setSecureConfigValue(key, value),
        delete: (key) => deleteSecureConfigValue(key),
    },
    platform: { os: () => Platform.OS },
    logInfo: (message, context) => logInfo(message, context),
    logSettingsError: (error) => logSettingsError(error),
    performSync: (syncPathOverride, options) => performMobileSync(syncPathOverride, options),
    clearSyncConfigCache: () => clearMobileSyncConfigCache(),
    reconcileBackgroundSync: () => syncMobileBackgroundSyncRegistration(),
    pickSyncFolder: () => {
        const { tr } = params();
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
        return pickAndParseSyncFolder({ confirmFileFallback });
    },
    getCloudKitAccountStatus: () => getCloudKitAccountStatus(),
    rememberWebdavCapabilityProof: (config) => rememberWebdavCapabilityProof(config),
    encryption: {
        getStatus: () => getMobileSyncEncryptionStatus(),
        getIncompleteTransition: () => getIncompleteSyncEncryptionTransition(),
    },
    dropbox: {
        authorize: (clientId) => authorizeDropbox(clientId),
        redirectUri: () => getDropboxRedirectUri(),
        isConnected: () => isDropboxConnected(),
        disconnect: (clientId) => disconnectDropbox(clientId),
        clearTokens: () => clearDropboxTokens(),
        revokeTokens: (clientId, tokens) => revokeDropboxTokens(clientId, tokens),
        getStoredTokens: () => getStoredDropboxTokens(),
        saveTokens: (tokens) => saveDropboxTokens(tokens),
        getValidAccessToken: (clientId) => getValidDropboxAccessToken(clientId),
        forceRefreshAccessToken: (clientId) => forceRefreshDropboxAccessToken(clientId),
        getValidAccessTokenForTokens: (clientId, tokens) => getValidDropboxAccessTokenForTokens(clientId, tokens),
        forceRefreshAccessTokenForTokens: (clientId, tokens) => forceRefreshDropboxAccessTokenForTokens(clientId, tokens),
        testAccess: (accessToken) => testDropboxAccess(accessToken),
    },
    // This app's imports, so a test that replaces them replaces what the controller calls.
    core: {
        addBreadcrumb: (message) => addBreadcrumb(message),
        CLOCK_SKEW_THRESHOLD_MS,
        cloudGetJson: (url, options) => cloudGetJson(url, options),
        isConnectionAllowed: (url, options) => isConnectionAllowed(url, options),
        isSyncEncryptionRemoteVersionUnavailableError: (error) => isSyncEncryptionRemoteVersionUnavailableError(error),
        isValidCloudSyncToken: (token) => isValidCloudSyncToken(token),
        normalizeCloudUrl: (url) => normalizeCloudUrl(url),
        normalizeWebdavUrl: (url) => normalizeWebdavUrl(url),
        probeWebdavSyncCompatibility: (url, options, policy) => probeWebdavSyncCompatibility(url, options, policy),
        SyncEncryptionRemoteVersionUnavailableError,
        SYNC_LOCAL_INSECURE_URL_OPTIONS,
        coerceSupportedBackend: (backend, allowCloudKit) => coerceSupportedBackend(backend, allowCloudKit),
        getSyncConflictCount: (stats) => getSyncConflictCount(stats),
        getSyncMaxClockSkewMs: (stats) => getSyncMaxClockSkewMs(stats),
        getSyncTimestampAdjustments: (stats) => getSyncTimestampAdjustments(stats),
        hasSameUserFacingSyncConflictSummary: (current, previous) => hasSameUserFacingSyncConflictSummary(current, previous),
        isLikelyOfflineSyncError: (errorOrMessage) => isLikelyOfflineSyncError(errorOrMessage),
        formatClockSkew: (ms) => formatClockSkew(ms),
        formatError: (error) => formatError(error),
        isDropboxUnauthorizedError: (error) => isDropboxUnauthorizedError(error),
    },
});

export function useSyncSettingsTransportActions(params: UseSyncSettingsTransportActionsParams) {
    const paramsRef = useRef(params);
    paramsRef.current = params;
    // One controller per screen visit, created on first use.
    const [transport] = useState(() => createTransport(() => paramsRef.current));
    const state = useSyncExternalStore(transport.subscribe, transport.getState);
    const { dropboxConfigured, supportsNativeICloudSync } = params;
    const { syncBackend } = state;

    useEffect(() => transport.load(), [dropboxConfigured, supportsNativeICloudSync, transport]);

    useEffect(() => {
        void transport.refreshCloudKitAccountStatus();
    }, [supportsNativeICloudSync, transport]);

    useEffect(() => {
        if (syncBackend !== 'cloudkit') return;
        void transport.refreshCloudKitAccountStatus();
    }, [supportsNativeICloudSync, syncBackend, transport]);

    useEffect(() => transport.loadDropboxState(), [dropboxConfigured, transport]);

    return {
        cloudKitAccountStatus: state.cloudKitAccountStatus,
        cloudAllowInsecureHttp: state.cloudAllowInsecureHttp,
        cloudProvider: state.cloudProvider,
        cloudToken: state.cloudToken,
        cloudUrl: state.cloudUrl,
        dropboxBusy: state.dropboxBusy,
        dropboxConnected: state.dropboxConnected,
        handleConnectDropbox: transport.handleConnectDropbox,
        handleDisconnectDropbox: transport.handleDisconnectDropbox,
        handleSaveSelfHostedSettings: transport.handleSaveSelfHostedSettings,
        handleSaveWebDavSettings: transport.handleSaveWebDavSettings,
        handleSelectCloudProvider: transport.handleSelectCloudProvider,
        handleSelectSyncBackend: transport.handleSelectSyncBackend,
        handleSetSyncPath: transport.handleSetSyncPath,
        handleSync: transport.handleSync,
        handleTestConnection: transport.handleTestConnection,
        handleTestDropboxConnection: transport.handleTestDropboxConnection,
        isSyncing: state.isSyncing,
        isTestingConnection: state.isTestingConnection,
        redactText: transport.redactText,
        syncBackend: state.syncBackend,
        syncPath: state.syncPath,
        webdavAllowInsecureHttp: state.webdavAllowInsecureHttp,
        webdavPassword: state.webdavPassword,
        webdavUrl: state.webdavUrl,
        webdavUsername: state.webdavUsername,
    };
}
