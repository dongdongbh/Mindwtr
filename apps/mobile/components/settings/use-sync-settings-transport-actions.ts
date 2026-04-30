import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
    addBreadcrumb,
    CLOCK_SKEW_THRESHOLD_MS,
    cloudGetJson,
    normalizeWebdavUrl,
    webdavGetJson,
    type AppData,
} from '@mindwtr/core';

import { pickAndParseSyncFolder } from '@/lib/storage-file';
import { getCloudKitAccountStatus } from '@/lib/cloudkit-sync';
import { authorizeDropbox, getDropboxRedirectUri } from '@/lib/dropbox-oauth';
import {
    disconnectDropbox,
    forceRefreshDropboxAccessToken,
    getValidDropboxAccessToken,
    isDropboxConnected,
} from '@/lib/dropbox-auth';
import { performMobileSync } from '@/lib/sync-service';
import { MOBILE_WEBDAV_REQUEST_OPTIONS } from '@/lib/webdav-request-options';
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
    CLOUD_TOKEN_KEY,
    CLOUD_URL_KEY,
    SYNC_BACKEND_KEY,
    SYNC_PATH_BOOKMARK_KEY,
    SYNC_PATH_KEY,
    WEBDAV_PASSWORD_KEY,
    WEBDAV_URL_KEY,
    WEBDAV_USERNAME_KEY,
} from '@/lib/sync-constants';

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
    lastSyncStats: AppData['settings']['lastSyncStats'] | null | undefined;
    lastSyncStatus: AppData['settings']['lastSyncStatus'] | undefined;
    localize: (english: string, chinese: string) => string;
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
    localize,
    resetSyncStatusForBackendSwitch,
    showSettingsErrorToast,
    showSettingsWarning,
    showToast,
    supportsNativeICloudSync,
    t,
}: UseSyncSettingsTransportActionsParams) {
    const [syncPath, setSyncPath] = useState<string | null>(null);
    const [syncBackend, setSyncBackend] = useState<SyncBackend>('off');
    const [isSyncing, setIsSyncing] = useState(false);
    const [isTestingConnection, setIsTestingConnection] = useState(false);
    const [webdavUrl, setWebdavUrl] = useState('');
    const [webdavUsername, setWebdavUsername] = useState('');
    const [webdavPassword, setWebdavPassword] = useState('');
    const [cloudUrl, setCloudUrl] = useState('');
    const [cloudToken, setCloudToken] = useState('');
    const [cloudProvider, setCloudProvider] = useState<CloudProvider>('selfhosted');
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
        let accessToken = await getValidDropboxAccessToken(dropboxAppKey);
        try {
            await testDropboxAccess(accessToken);
        } catch (error) {
            if (!isDropboxUnauthorizedError(error)) {
                throw error;
            }
            accessToken = await forceRefreshDropboxAccessToken(dropboxAppKey);
            await testDropboxAccess(accessToken);
        }
    }, [dropboxAppKey]);

    useEffect(() => {
        let cancelled = false;

        AsyncStorage.multiGet([
            SYNC_PATH_KEY,
            SYNC_BACKEND_KEY,
            WEBDAV_URL_KEY,
            WEBDAV_USERNAME_KEY,
            WEBDAV_PASSWORD_KEY,
            CLOUD_URL_KEY,
            CLOUD_TOKEN_KEY,
            CLOUD_PROVIDER_KEY,
        ]).then((entries) => {
            if (cancelled) return;

            const entryMap = new Map(entries);
            const path = entryMap.get(SYNC_PATH_KEY);
            const storedBackend = entryMap.get(SYNC_BACKEND_KEY);
            const storedWebDavUrl = entryMap.get(WEBDAV_URL_KEY);
            const storedWebDavUsername = entryMap.get(WEBDAV_USERNAME_KEY);
            const storedWebDavPassword = entryMap.get(WEBDAV_PASSWORD_KEY);
            const storedCloudUrl = entryMap.get(CLOUD_URL_KEY);
            const storedCloudToken = entryMap.get(CLOUD_TOKEN_KEY);
            const storedCloudProvider = entryMap.get(CLOUD_PROVIDER_KEY);

            setSyncPath(path || null);
            setWebdavUrl(storedWebDavUrl || '');
            setWebdavUsername(storedWebDavUsername || '');
            setWebdavPassword(storedWebDavPassword || '');
            setCloudUrl(storedCloudUrl || '');
            setCloudToken(storedCloudToken || '');

            const resolvedBackend = storedBackend === 'webdav'
                || storedBackend === 'cloud'
                || storedBackend === 'off'
                || storedBackend === 'file'
                || storedBackend === 'cloudkit'
                ? storedBackend
                : 'off';
            const supportedBackend = coerceSupportedBackend(resolvedBackend, supportsNativeICloudSync);
            setSyncBackend(supportedBackend);

            const resolvedCloudProvider: CloudProvider = (
                (resolvedBackend === 'cloudkit' || storedCloudProvider === 'cloudkit') && supportsNativeICloudSync
            )
                ? 'cloudkit'
                : storedCloudProvider === 'dropbox' && dropboxConfigured
                    ? 'dropbox'
                    : 'selfhosted';
            setCloudProvider(resolvedCloudProvider);

            if (resolvedBackend !== supportedBackend) {
                AsyncStorage.setItem(SYNC_BACKEND_KEY, supportedBackend).catch(logSettingsError);
            }
            if (!dropboxConfigured && storedCloudProvider === 'dropbox') {
                AsyncStorage.setItem(CLOUD_PROVIDER_KEY, 'selfhosted').catch(logSettingsError);
            }
            if (!supportsNativeICloudSync && storedCloudProvider === 'cloudkit') {
                AsyncStorage.setItem(CLOUD_PROVIDER_KEY, 'selfhosted').catch(logSettingsError);
            }
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
        AsyncStorage.setItem(SYNC_BACKEND_KEY, nextBackend).catch(logSettingsError);
        addBreadcrumb(`settings:syncBackend:${nextBackend}`);
        setSyncBackend(nextBackend);
        resetSyncStatusForBackendSwitch();
    }, [cloudProvider, resetSyncStatusForBackendSwitch]);

    const handleSelectCloudProvider = useCallback((provider: CloudProvider) => {
        if (provider === 'cloudkit' && !supportsNativeICloudSync) return;
        if (provider === 'dropbox' && !dropboxConfigured) return;

        const nextBackend: SyncBackend = provider === 'cloudkit' ? 'cloudkit' : 'cloud';
        setCloudProvider(provider);
        setSyncBackend(nextBackend);
        AsyncStorage.multiSet([
            [CLOUD_PROVIDER_KEY, provider],
            [SYNC_BACKEND_KEY, nextBackend],
        ]).catch(logSettingsError);
        resetSyncStatusForBackendSwitch();
    }, [dropboxConfigured, resetSyncStatusForBackendSwitch, supportsNativeICloudSync]);

    const handleSetSyncPath = useCallback(async () => {
        try {
            const result = await pickAndParseSyncFolder();
            if (!result) return;
            const fileUri = (result as { __fileUri: string }).__fileUri;
            const fileBookmark = (result as { __fileBookmark?: string }).__fileBookmark?.trim() ?? null;
            if (!fileUri) return;

            await AsyncStorage.setItem(SYNC_PATH_KEY, fileUri);
            if (fileBookmark) {
                await AsyncStorage.setItem(SYNC_PATH_BOOKMARK_KEY, fileBookmark);
            } else {
                await AsyncStorage.removeItem(SYNC_PATH_BOOKMARK_KEY);
            }

            setSyncPath(fileUri);
            await AsyncStorage.setItem(SYNC_BACKEND_KEY, 'file');
            addBreadcrumb('settings:syncBackend:file');
            setSyncBackend('file');
            resetSyncStatusForBackendSwitch();
            showToast({
                title: localize('Success', '成功'),
                message: localize('Sync folder set successfully', '同步文件夹已设置'),
                tone: 'success',
            });
        } catch (error) {
            const message = String(error);
            if (/Selected JSON file is not a Mindwtr backup/i.test(message)) {
                showSettingsWarning(
                    localize('Invalid sync file', '无效同步文件'),
                    localize(
                        'Please choose a Mindwtr backup JSON file in the target folder, then try "Select Folder" again.',
                        '请选择目标文件夹中的 Mindwtr 备份 JSON 文件，然后重试“选择文件夹”。'
                    ),
                    5200
                );
                return;
            }
            if (/temporary Inbox location|re-select a folder in Settings -> (?:Data & Sync|Sync)/i.test(message)) {
                showSettingsWarning(
                    localize('Unsupported cloud provider on iOS', 'iOS 云端提供商暂不支持'),
                    localize(
                        'The selected file came from a temporary iOS Files copy. Providers like Google Drive and OneDrive are not reliable for file sync here yet. Please choose iCloud Drive instead, or switch to WebDAV.',
                        '当前选择的是 iOS“文件”提供的临时副本。Google Drive、OneDrive 等提供商暂不适合作为这里的文件同步目录。请改用 iCloud Drive，或切换到 WebDAV。'
                    ),
                    5600
                );
                return;
            }
            if (/read-only|read only|not writable|isn't writable|permission denied|EACCES/i.test(message)) {
                showSettingsWarning(
                    localize('Sync folder is read-only', '同步文件夹不可写'),
                    Platform.OS === 'ios'
                        ? localize(
                            'The selected folder is read-only. Choose a writable location, or make the cloud folder available offline in Files before selecting it.',
                            '所选文件夹不可写。请选择可写位置，或先在“文件”App中将云端文件夹设为离线可用后再选择。'
                        )
                        : localize(
                            'The selected folder is read-only. Please choose a writable folder (e.g. My files) or make it available offline.',
                            '所选文件夹不可写。请选择可写文件夹（如“我的文件”），或将其设为离线可用。'
                        ),
                    5600
                );
                return;
            }
            showSettingsErrorToast(localize('Error', '错误'), localize('Failed to set sync path', '设置失败'));
        }
    }, [
        localize,
        resetSyncStatusForBackendSwitch,
        showSettingsErrorToast,
        showSettingsWarning,
        showToast,
    ]);

    const handleConnectDropbox = useCallback(async () => {
        if (isFossBuild) {
            showSettingsWarning(localize('Dropbox unavailable', 'Dropbox 不可用'), localize('Dropbox is disabled in FOSS builds.', 'FOSS 构建不支持 Dropbox。'));
            return;
        }
        if (!dropboxConfigured) {
            showSettingsWarning(localize('Dropbox unavailable', 'Dropbox 不可用'), localize('Dropbox app key is not configured in this build.', '当前构建未配置 Dropbox App Key。'));
            return;
        }
        if (isExpoGo) {
            showSettingsWarning(
                localize('Dropbox unavailable in Expo Go', 'Expo Go 不支持 Dropbox'),
                `${localize(
                    'Dropbox OAuth requires a development/release build. Expo Go uses temporary redirect URIs that Dropbox rejects.',
                    'Dropbox OAuth 需要开发版或正式版应用。Expo Go 使用临时回调地址，Dropbox 会拒绝。'
                )}\n\n${localize('Use redirect URI', '请使用回调地址')}: ${getDropboxRedirectUri()}`,
                6000
            );
            return;
        }
        setDropboxBusy(true);
        try {
            await authorizeDropbox(dropboxAppKey);
            await AsyncStorage.multiSet([
                [SYNC_BACKEND_KEY, 'cloud'],
                [CLOUD_PROVIDER_KEY, 'dropbox'],
            ]);
            setCloudProvider('dropbox');
            addBreadcrumb('settings:syncBackend:cloud');
            setSyncBackend('cloud');
            setDropboxConnected(true);
            resetSyncStatusForBackendSwitch();
            showToast({
                title: localize('Success', '成功'),
                message: localize('Connected to Dropbox.', '已连接 Dropbox。'),
                tone: 'success',
            });
        } catch (error) {
            const message = String(error);
            if (/redirect[_\s-]?uri/i.test(message)) {
                showSettingsWarning(
                    localize('Invalid redirect URI', '回调地址无效'),
                    `${localize('Add this exact redirect URI in Dropbox OAuth settings.', '请在 Dropbox OAuth 设置里添加以下精确回调地址。')}\n\n${getDropboxRedirectUri()}`,
                    6000
                );
            } else {
                showSettingsErrorToast(localize('Connection failed', '连接失败'), formatError(error), 5200);
            }
        } finally {
            setDropboxBusy(false);
        }
    }, [
        dropboxAppKey,
        dropboxConfigured,
        isExpoGo,
        isFossBuild,
        localize,
        resetSyncStatusForBackendSwitch,
        showSettingsErrorToast,
        showSettingsWarning,
        showToast,
    ]);

    const handleDisconnectDropbox = useCallback(async () => {
        if (!dropboxConfigured) {
            setDropboxConnected(false);
            return;
        }
        setDropboxBusy(true);
        try {
            await disconnectDropbox(dropboxAppKey);
            setDropboxConnected(false);
            resetSyncStatusForBackendSwitch();
            showToast({
                title: localize('Disconnected', '已断开'),
                message: localize('Dropbox connection removed.', '已移除 Dropbox 连接。'),
                tone: 'success',
            });
        } catch (error) {
            showSettingsErrorToast(localize('Disconnect failed', '断开失败'), formatError(error), 5200);
        } finally {
            setDropboxBusy(false);
        }
    }, [
        dropboxAppKey,
        dropboxConfigured,
        localize,
        resetSyncStatusForBackendSwitch,
        showSettingsErrorToast,
        showToast,
    ]);

    const handleTestDropboxConnection = useCallback(async () => {
        if (isFossBuild) {
            showSettingsWarning(localize('Dropbox unavailable', 'Dropbox 不可用'), localize('Dropbox is disabled in FOSS builds.', 'FOSS 构建不支持 Dropbox。'));
            return;
        }
        if (!dropboxConfigured) {
            showSettingsWarning(localize('Dropbox unavailable', 'Dropbox 不可用'), localize('Dropbox app key is not configured in this build.', '当前构建未配置 Dropbox App Key。'));
            return;
        }
        setIsTestingConnection(true);
        try {
            await runDropboxConnectionTest();
            setDropboxConnected(true);
            showToast({
                title: localize('Connection OK', '连接成功'),
                message: localize('Dropbox account is reachable.', 'Dropbox 账号可访问。'),
                tone: 'success',
            });
        } catch (error) {
            if (isDropboxUnauthorizedError(error)) {
                setDropboxConnected(false);
                showSettingsWarning(
                    localize('Connection failed', '连接失败'),
                    localize(
                        'Dropbox token is invalid or revoked. Please tap Connect Dropbox to re-authorize.',
                        'Dropbox 令牌无效或已失效。请点击“连接 Dropbox”重新授权。'
                    ),
                    5200
                );
            } else {
                showSettingsErrorToast(localize('Connection failed', '连接失败'), formatError(error), 5200);
            }
        } finally {
            setIsTestingConnection(false);
        }
    }, [
        dropboxConfigured,
        isFossBuild,
        localize,
        runDropboxConnectionTest,
        showSettingsErrorToast,
        showSettingsWarning,
        showToast,
    ]);

    const handleSaveWebDavSettings = useCallback(async (nextSettings: WebDavSyncSettings) => {
        const trimmedUrl = nextSettings.url.trim();
        if (!trimmedUrl || !isValidHttpUrl(trimmedUrl)) {
            showSettingsWarning(localize('Invalid URL', '地址无效'), localize('Please enter a valid WebDAV URL (http/https).', '请输入有效的 WebDAV 地址（http/https）。'));
            return;
        }
        const trimmedUsername = nextSettings.username.trim();
        try {
            await AsyncStorage.multiSet([
                [SYNC_BACKEND_KEY, 'webdav'],
                [WEBDAV_URL_KEY, trimmedUrl],
                [WEBDAV_USERNAME_KEY, trimmedUsername],
                [WEBDAV_PASSWORD_KEY, nextSettings.password],
            ]);
            setWebdavUrl(trimmedUrl);
            setWebdavUsername(trimmedUsername);
            setWebdavPassword(nextSettings.password);
            setSyncBackend('webdav');
            resetSyncStatusForBackendSwitch();
            showToast({
                title: localize('Success', '成功'),
                message: t('settings.webdavSave'),
                tone: 'success',
            });
        } catch {
            showSettingsErrorToast(
                localize('Error', '错误'),
                localize('Failed to save WebDAV settings', '保存 WebDAV 设置失败')
            );
        }
    }, [
        localize,
        resetSyncStatusForBackendSwitch,
        showSettingsErrorToast,
        showSettingsWarning,
        showToast,
        t,
    ]);

    const handleSaveSelfHostedSettings = useCallback(async (nextSettings: SelfHostedSyncSettings) => {
        const trimmedUrl = nextSettings.url.trim();
        if (!trimmedUrl || !isValidHttpUrl(trimmedUrl)) {
            showSettingsWarning(localize('Invalid URL', '地址无效'), localize('Please enter a valid self-hosted URL (http/https).', '请输入有效的自托管地址（http/https）。'));
            return;
        }
        try {
            await AsyncStorage.multiSet([
                [SYNC_BACKEND_KEY, 'cloud'],
                [CLOUD_PROVIDER_KEY, 'selfhosted'],
                [CLOUD_URL_KEY, trimmedUrl],
                [CLOUD_TOKEN_KEY, nextSettings.token],
            ]);
            setCloudUrl(trimmedUrl);
            setCloudToken(nextSettings.token);
            setCloudProvider('selfhosted');
            setSyncBackend('cloud');
            resetSyncStatusForBackendSwitch();
            showToast({
                title: localize('Success', '成功'),
                message: t('settings.cloudSave'),
                tone: 'success',
            });
        } catch {
            showSettingsErrorToast(
                localize('Error', '错误'),
                localize('Failed to save self-hosted settings', '保存自托管设置失败')
            );
        }
    }, [
        localize,
        resetSyncStatusForBackendSwitch,
        showSettingsErrorToast,
        showSettingsWarning,
        showToast,
        t,
    ]);

    const handleSync = useCallback(async (options?: SyncActionOptions) => {
        addBreadcrumb('sync:manual');
        setIsSyncing(true);
        try {
            const previousLastSyncStatus = lastSyncStatus;
            const previousLastSyncStats = lastSyncStats ?? null;
            const effectiveBackend = options?.backend ?? syncBackend;
            const effectiveCloud = options?.cloud ?? { token: cloudToken, url: cloudUrl };
            const effectiveCloudProvider = options?.cloudProvider ?? cloudProvider;
            const effectiveWebdav = options?.webdav ?? { password: webdavPassword, url: webdavUrl, username: webdavUsername };

            if (effectiveBackend === 'off') return;
            if (effectiveBackend === 'webdav') {
                const trimmedWebDavUrl = effectiveWebdav.url.trim();
                if (!trimmedWebDavUrl) {
                    showSettingsWarning(localize('Notice', '提示'), localize('Please set a WebDAV URL first', '请先设置 WebDAV 地址'));
                    return;
                }
                if (!isValidHttpUrl(trimmedWebDavUrl)) {
                    showSettingsWarning(localize('Invalid URL', '地址无效'), localize('Please enter a valid WebDAV URL (http/https).', '请输入有效的 WebDAV 地址（http/https）。'));
                    return;
                }
                const trimmedWebDavUsername = effectiveWebdav.username.trim();
                await AsyncStorage.multiSet([
                    [SYNC_BACKEND_KEY, 'webdav'],
                    [WEBDAV_URL_KEY, trimmedWebDavUrl],
                    [WEBDAV_USERNAME_KEY, trimmedWebDavUsername],
                    [WEBDAV_PASSWORD_KEY, effectiveWebdav.password],
                ]);
                setWebdavUrl(trimmedWebDavUrl);
                setWebdavUsername(trimmedWebDavUsername);
                setWebdavPassword(effectiveWebdav.password);
                setSyncBackend('webdav');
            } else if (effectiveBackend === 'cloudkit') {
                const accountStatus = await getCloudKitAccountStatus();
                setCloudKitAccountStatus(accountStatus);
                const statusDetails = getCloudKitStatusDetails(accountStatus);
                if (!statusDetails.syncEnabled) {
                    showSettingsWarning(localize('iCloud unavailable', 'iCloud 不可用'), statusDetails.helpText, 5200);
                    return;
                }
                await AsyncStorage.multiSet([
                    [SYNC_BACKEND_KEY, 'cloudkit'],
                    [CLOUD_PROVIDER_KEY, 'cloudkit'],
                ]);
                setCloudProvider('cloudkit');
                setSyncBackend('cloudkit');
            } else if (effectiveBackend === 'cloud') {
                if (effectiveCloudProvider === 'dropbox') {
                    if (isFossBuild) {
                        showSettingsWarning(localize('Dropbox unavailable', 'Dropbox 不可用'), localize('Dropbox is disabled in FOSS builds.', 'FOSS 构建不支持 Dropbox。'));
                        return;
                    }
                    if (!dropboxConfigured) {
                        showSettingsWarning(localize('Dropbox unavailable', 'Dropbox 不可用'), localize('Dropbox app key is not configured in this build.', '当前构建未配置 Dropbox App Key。'));
                        return;
                    }
                    const connected = await isDropboxConnected();
                    if (!connected) {
                        showSettingsWarning(localize('Notice', '提示'), localize('Please connect Dropbox first.', '请先连接 Dropbox。'));
                        return;
                    }
                    await AsyncStorage.multiSet([
                        [SYNC_BACKEND_KEY, 'cloud'],
                        [CLOUD_PROVIDER_KEY, 'dropbox'],
                    ]);
                    setCloudProvider('dropbox');
                    setSyncBackend('cloud');
                } else {
                    const trimmedCloudUrl = effectiveCloud.url.trim();
                    if (!trimmedCloudUrl) {
                        showSettingsWarning(localize('Notice', '提示'), localize('Please set a self-hosted URL first', '请先设置自托管地址'));
                        return;
                    }
                    if (!isValidHttpUrl(trimmedCloudUrl)) {
                        showSettingsWarning(localize('Invalid URL', '地址无效'), localize('Please enter a valid self-hosted URL (http/https).', '请输入有效的自托管地址（http/https）。'));
                        return;
                    }
                    await AsyncStorage.multiSet([
                        [SYNC_BACKEND_KEY, 'cloud'],
                        [CLOUD_PROVIDER_KEY, 'selfhosted'],
                        [CLOUD_URL_KEY, trimmedCloudUrl],
                        [CLOUD_TOKEN_KEY, effectiveCloud.token],
                    ]);
                    setCloudUrl(trimmedCloudUrl);
                    setCloudToken(effectiveCloud.token);
                    setCloudProvider('selfhosted');
                    setSyncBackend('cloud');
                }
            } else {
                if (!syncPath) {
                    showSettingsWarning(localize('Notice', '提示'), localize('Please set a sync folder first', '请先设置同步文件夹'));
                    return;
                }
                await AsyncStorage.setItem(SYNC_BACKEND_KEY, 'file');
                setSyncBackend('file');
            }

            resetSyncStatusForBackendSwitch();
            const result = await performMobileSync(effectiveBackend === 'file' ? syncPath || undefined : undefined);
            if (result.skipped === 'offline' || isLikelyOfflineSyncError(result.error)) {
                showToast({
                    title: t('common.offline'),
                    message: t('settings.syncSkippedOffline'),
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
            if (result.success) {
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
                    localize('Unsupported cloud provider on iOS', 'iOS 云端提供商暂不支持'),
                    localize(
                        'The selected file came from a temporary iOS Files copy. Providers like Google Drive and OneDrive are not reliable for file sync here yet. Please go to Settings → Sync, choose iCloud Drive, or switch to WebDAV.',
                        '当前选择的是 iOS“文件”提供的临时副本。Google Drive、OneDrive 等提供商暂不适合作为这里的文件同步目录。请前往「设置 → 同步」，改选 iCloud Drive，或切换到 WebDAV。'
                    ),
                    5600
                );
                return;
            }
            showSettingsErrorToast(localize('Error', '错误'), getSyncFailureToastMessage(error));
        } finally {
            setIsSyncing(false);
        }
    }, [
        cloudProvider,
        cloudToken,
        cloudUrl,
        dropboxConfigured,
        getCloudKitStatusDetails,
        getSyncFailureToastMessage,
        isFossBuild,
        lastSyncStats,
        lastSyncStatus,
        localize,
        formatText,
        resetSyncStatusForBackendSwitch,
        showSettingsErrorToast,
        showSettingsWarning,
        showToast,
        syncBackend,
        syncPath,
        webdavPassword,
        webdavUrl,
        webdavUsername,
    ]);

    const handleTestConnection = useCallback(async (backend: 'webdav' | 'cloud', options?: Omit<SyncActionOptions, 'backend'>) => {
        setIsTestingConnection(true);
        const effectiveCloud = options?.cloud ?? { token: cloudToken, url: cloudUrl };
        const effectiveCloudProvider = options?.cloudProvider ?? cloudProvider;
        const effectiveWebdav = options?.webdav ?? { password: webdavPassword, url: webdavUrl, username: webdavUsername };
        try {
            if (backend === 'webdav') {
                const trimmedWebDavUrl = effectiveWebdav.url.trim();
                if (!trimmedWebDavUrl || !isValidHttpUrl(trimmedWebDavUrl)) {
                    showSettingsWarning(localize('Invalid URL', '地址无效'), localize('Please enter a valid WebDAV URL (http/https).', '请输入有效的 WebDAV 地址（http/https）。'));
                    return;
                }
                await webdavGetJson<unknown>(normalizeWebdavUrl(trimmedWebDavUrl), {
                    ...MOBILE_WEBDAV_REQUEST_OPTIONS,
                    username: effectiveWebdav.username.trim(),
                    password: effectiveWebdav.password,
                    timeoutMs: 10_000,
                });
                showToast({
                    title: localize('Connection OK', '连接成功'),
                    message: localize('WebDAV endpoint is reachable.', 'WebDAV 端点可访问。'),
                    tone: 'success',
                });
                return;
            }

            if (effectiveCloudProvider === 'dropbox') {
                if (isFossBuild) {
                    showSettingsWarning(localize('Dropbox unavailable', 'Dropbox 不可用'), localize('Dropbox is disabled in FOSS builds.', 'FOSS 构建不支持 Dropbox。'));
                    return;
                }
                await runDropboxConnectionTest();
                setDropboxConnected(true);
                showToast({
                    title: localize('Connection OK', '连接成功'),
                    message: localize('Dropbox account is reachable.', 'Dropbox 账号可访问。'),
                    tone: 'success',
                });
                return;
            }

            const trimmedCloudUrl = effectiveCloud.url.trim();
            if (!trimmedCloudUrl || !isValidHttpUrl(trimmedCloudUrl)) {
                showSettingsWarning(localize('Invalid URL', '地址无效'), localize('Please enter a valid self-hosted URL (http/https).', '请输入有效的自托管地址（http/https）。'));
                return;
            }
            await cloudGetJson<unknown>(trimmedCloudUrl.replace(/\/+$/, ''), {
                token: effectiveCloud.token,
                timeoutMs: 10_000,
            });
            showToast({
                title: localize('Connection OK', '连接成功'),
                message: localize('Self-hosted endpoint is reachable.', '自托管端点可访问。'),
                tone: 'success',
            });
        } catch (error) {
            if (effectiveCloudProvider === 'dropbox' && isDropboxUnauthorizedError(error)) {
                setDropboxConnected(false);
            }
            showSettingsErrorToast(
                localize('Connection failed', '连接失败'),
                effectiveCloudProvider === 'dropbox' && isDropboxUnauthorizedError(error)
                    ? localize(
                        'Dropbox token is invalid or revoked. Please tap Connect Dropbox to re-authorize.',
                        'Dropbox 令牌无效或已失效。请点击“连接 Dropbox”重新授权。'
                    )
                    : formatError(error),
                5200
            );
        } finally {
            setIsTestingConnection(false);
        }
    }, [
        cloudProvider,
        cloudToken,
        cloudUrl,
        isFossBuild,
        localize,
        runDropboxConnectionTest,
        showSettingsErrorToast,
        showSettingsWarning,
        showToast,
        webdavPassword,
        webdavUrl,
        webdavUsername,
    ]);

    return {
        cloudKitAccountStatus,
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
        webdavPassword,
        webdavUrl,
        webdavUsername,
    };
}
