import React, { useCallback, useEffect, useState } from 'react';
import Constants from 'expo-constants';
import { ActivityIndicator, Alert, Platform, ScrollView, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
    cloudGetJson,
    useTaskStore,
    webdavGetJson,
} from '@mindwtr/core';

import { useMobileSyncBadge } from '@/hooks/use-mobile-sync-badge';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { exportData, pickAndParseSyncFolder } from '@/lib/storage-file';
import { isCloudKitAvailable } from '@/lib/cloudkit-sync';
import { authorizeDropbox, getDropboxRedirectUri } from '@/lib/dropbox-oauth';
import {
    disconnectDropbox,
    forceRefreshDropboxAccessToken,
    getValidDropboxAccessToken,
    isDropboxClientConfigured,
    isDropboxConnected,
} from '@/lib/dropbox-auth';
import { clearLog, ensureLogFilePath, logInfo } from '@/lib/app-log';
import {
    formatClockSkew,
    formatError,
    isDropboxUnauthorizedError,
    isDropboxUnauthorizedError as isDropboxUnauthorizedSettingsError,
    logSettingsError,
    logSettingsWarn,
} from '@/lib/settings-utils';
import { performMobileSync } from '@/lib/sync-service';
import { coerceSupportedBackend, isLikelyOfflineSyncError } from '@/lib/sync-service-utils';
import { testDropboxAccess } from '@/lib/dropbox-sync';
import {
    CLOUD_PROVIDER_KEY,
    CLOUD_TOKEN_KEY,
    CLOUD_URL_KEY,
    SYNC_BACKEND_KEY,
    SYNC_PATH_KEY,
    WEBDAV_PASSWORD_KEY,
    WEBDAV_URL_KEY,
    WEBDAV_USERNAME_KEY,
} from '@/lib/sync-constants';

import { CloudProvider, MobileExtraConfig, isValidHttpUrl } from './settings.constants';
import { useSettingsLocalization, useSettingsScrollContent } from './settings.hooks';
import { SettingsTopBar, SubHeader } from './settings.shell';
import { styles } from './settings.styles';

export function SyncSettingsScreen() {
    const tc = useThemeColors();
    const { localize, t } = useSettingsLocalization();
    const scrollContentStyle = useSettingsScrollContent();
    const {
        tasks,
        projects,
        sections,
        areas,
        settings,
        updateSettings,
    } = useTaskStore();
    const extraConfig = Constants.expoConfig?.extra as MobileExtraConfig | undefined;
    const isFossBuild = extraConfig?.isFossBuild === true || extraConfig?.isFossBuild === 'true';
    const dropboxAppKey = typeof extraConfig?.dropboxAppKey === 'string' ? extraConfig.dropboxAppKey.trim() : '';
    const dropboxConfigured = !isFossBuild && isDropboxClientConfigured(dropboxAppKey);
    const isExpoGo = Constants.appOwnership === 'expo';
    const supportsNativeICloudSync = Platform.OS === 'ios' && isCloudKitAvailable();
    const [isSyncing, setIsSyncing] = useState(false);
    const [syncPath, setSyncPath] = useState<string | null>(null);
    const [syncBackend, setSyncBackend] = useState<'file' | 'webdav' | 'cloud' | 'cloudkit' | 'off'>('off');
    const [isTestingConnection, setIsTestingConnection] = useState(false);
    const [webdavUrl, setWebdavUrl] = useState('');
    const [webdavUsername, setWebdavUsername] = useState('');
    const [webdavPassword, setWebdavPassword] = useState('');
    const [cloudUrl, setCloudUrl] = useState('');
    const [cloudToken, setCloudToken] = useState('');
    const [cloudProvider, setCloudProvider] = useState<CloudProvider>('selfhosted');
    const [dropboxConnected, setDropboxConnected] = useState(false);
    const [dropboxBusy, setDropboxBusy] = useState(false);
    const [syncOptionsOpen, setSyncOptionsOpen] = useState(false);
    const [syncHistoryExpanded, setSyncHistoryExpanded] = useState(false);
    const { refreshSyncBadgeConfig } = useMobileSyncBadge();

    const syncPreferences = settings.syncPreferences ?? {};
    const syncAppearanceEnabled = syncPreferences.appearance === true;
    const syncLanguageEnabled = syncPreferences.language === true;
    const syncExternalCalendarsEnabled = syncPreferences.externalCalendars === true;
    const syncAiEnabled = syncPreferences.ai === true;
    const syncHistory = settings.lastSyncHistory ?? [];
    const syncHistoryEntries = syncHistory.slice(0, 5);
    const lastSyncStats = settings.lastSyncStats ?? null;
    const showLastSyncStats = Boolean(lastSyncStats) && (settings.lastSyncStatus === 'success' || settings.lastSyncStatus === 'conflict');
    const syncConflictCount = (lastSyncStats?.tasks.conflicts || 0) + (lastSyncStats?.projects.conflicts || 0);
    const maxClockSkewMs = Math.max(lastSyncStats?.tasks.maxClockSkewMs || 0, lastSyncStats?.projects.maxClockSkewMs || 0);
    const timestampAdjustments = (lastSyncStats?.tasks.timestampAdjustments || 0) + (lastSyncStats?.projects.timestampAdjustments || 0);
    const conflictIds = [
        ...(lastSyncStats?.tasks.conflictIds ?? []),
        ...(lastSyncStats?.projects.conflictIds ?? []),
    ].slice(0, 6);
    const loggingEnabled = settings.diagnostics?.loggingEnabled === true;
    const webdavUrlError = webdavUrl.trim() ? !isValidHttpUrl(webdavUrl.trim()) : false;
    const cloudUrlError = cloudUrl.trim() ? !isValidHttpUrl(cloudUrl.trim()) : false;
    const backendOptions: typeof syncBackend[] = supportsNativeICloudSync
        ? ['off', 'cloudkit', 'file', 'webdav', 'cloud']
        : ['off', 'file', 'webdav', 'cloud'];

    useEffect(() => {
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
            const entryMap = new Map(entries);
            const path = entryMap.get(SYNC_PATH_KEY);
            const backend = entryMap.get(SYNC_BACKEND_KEY);
            const url = entryMap.get(WEBDAV_URL_KEY);
            const username = entryMap.get(WEBDAV_USERNAME_KEY);
            const password = entryMap.get(WEBDAV_PASSWORD_KEY);
            const cloudSyncUrl = entryMap.get(CLOUD_URL_KEY);
            const cloudSyncToken = entryMap.get(CLOUD_TOKEN_KEY);
            const storedCloudProvider = entryMap.get(CLOUD_PROVIDER_KEY);

            if (path) setSyncPath(path);
            const resolvedBackend = backend === 'webdav' || backend === 'cloud' || backend === 'off' || backend === 'file' || backend === 'cloudkit'
                ? backend
                : 'off';
            const supportedBackend = coerceSupportedBackend(resolvedBackend, supportsNativeICloudSync);
            setSyncBackend(supportedBackend);
            if (resolvedBackend !== supportedBackend) {
                AsyncStorage.setItem(SYNC_BACKEND_KEY, supportedBackend).catch(logSettingsError);
            }
            if (url) setWebdavUrl(url);
            if (username) setWebdavUsername(username);
            if (password) setWebdavPassword(password);
            if (cloudSyncUrl) setCloudUrl(cloudSyncUrl);
            if (cloudSyncToken) setCloudToken(cloudSyncToken);
            const resolvedCloudProvider =
                storedCloudProvider === 'dropbox' && !isFossBuild
                    ? 'dropbox'
                    : 'selfhosted';
            setCloudProvider(resolvedCloudProvider);
            if (isFossBuild && storedCloudProvider === 'dropbox') {
                AsyncStorage.setItem(CLOUD_PROVIDER_KEY, 'selfhosted').catch(logSettingsError);
            }
        }).catch(logSettingsError);
    }, [isFossBuild, supportsNativeICloudSync]);

    useEffect(() => {
        void refreshSyncBadgeConfig();
    }, [
        refreshSyncBadgeConfig,
        syncBackend,
        syncPath,
        webdavUrl,
        cloudUrl,
        cloudToken,
        cloudProvider,
        settings.lastSyncAt,
        settings.lastSyncStatus,
        settings.pendingRemoteWriteAt,
    ]);

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

    const resetSyncStatusForBackendSwitch = useCallback(() => {
        updateSettings({
            lastSyncStatus: 'idle',
            lastSyncError: undefined,
        }).catch(logSettingsError);
    }, [updateSettings]);

    const updateSyncPreferences = (partial: Partial<NonNullable<typeof settings.syncPreferences>>) => {
        updateSettings({ syncPreferences: { ...syncPreferences, ...partial } }).catch(logSettingsError);
    };

    const runDropboxConnectionTest = useCallback(async () => {
        let accessToken = await getValidDropboxAccessToken(dropboxAppKey);
        try {
            await testDropboxAccess(accessToken);
        } catch (error) {
            if (!isDropboxUnauthorizedError(error)) throw error;
            accessToken = await forceRefreshDropboxAccessToken(dropboxAppKey);
            await testDropboxAccess(accessToken);
        }
    }, [dropboxAppKey]);

    const renderSyncHistory = () => {
        if (syncHistoryEntries.length === 0) return null;
        return (
            <View style={{ marginTop: 6 }}>
                <TouchableOpacity onPress={() => setSyncHistoryExpanded((value) => !value)} activeOpacity={0.7}>
                    <Text style={[styles.settingDescription, { color: tc.secondaryText, fontWeight: '600' }]}>
                        {t('settings.syncHistory')} ({syncHistoryEntries.length}) {syncHistoryExpanded ? '▾' : '▸'}
                    </Text>
                </TouchableOpacity>
                {syncHistoryExpanded && syncHistoryEntries.map((entry) => {
                    const statusLabel = entry.status === 'success'
                        ? t('settings.lastSyncSuccess')
                        : entry.status === 'conflict'
                            ? t('settings.lastSyncConflict')
                            : t('settings.lastSyncError');
                    const details = [
                        entry.backend ? `${t('settings.syncHistoryBackend')}: ${entry.backend}` : null,
                        entry.type ? `${t('settings.syncHistoryType')}: ${entry.type}` : null,
                        entry.conflicts ? `${t('settings.lastSyncConflicts')}: ${entry.conflicts}` : null,
                        entry.maxClockSkewMs > 0 ? `${t('settings.lastSyncSkew')}: ${formatClockSkew(entry.maxClockSkewMs)}` : null,
                        entry.timestampAdjustments > 0 ? `${t('settings.lastSyncAdjusted')}: ${entry.timestampAdjustments}` : null,
                        entry.details ? `${t('settings.syncHistoryDetails')}: ${entry.details}` : null,
                    ].filter(Boolean);
                    return (
                        <Text key={`${entry.at}-${entry.status}`} style={[styles.settingDescription, { color: tc.secondaryText }]}>
                            {new Date(entry.at).toLocaleString()} • {statusLabel}
                            {details.length ? ` • ${details.join(' • ')}` : ''}
                            {entry.status === 'error' && entry.error ? ` • ${entry.error}` : ''}
                        </Text>
                    );
                })}
            </View>
        );
    };

    const handleBackup = async () => {
        setIsSyncing(true);
        try {
            await exportData({ tasks, projects, sections, areas, settings });
        } catch (error) {
            logSettingsError(error);
            Alert.alert(localize('Error', '错误'), localize('Failed to export data', '导出失败'));
        } finally {
            setIsSyncing(false);
        }
    };

    const toggleDebugLogging = (value: boolean) => {
        updateSettings({
            diagnostics: {
                ...(settings.diagnostics ?? {}),
                loggingEnabled: value,
            },
        })
            .then(async () => {
                if (!value) return;
                const ensuredPath = await ensureLogFilePath();
                if (!ensuredPath) return;
                await logInfo('Debug logging enabled', { scope: 'diagnostics', force: true });
            })
            .catch(logSettingsError);
    };

    const handleShareLog = async () => {
        const path = await ensureLogFilePath();
        if (!path) {
            Alert.alert(t('settings.debugLogging'), t('settings.logMissing'));
            return;
        }
        const Sharing = await import('expo-sharing');
        const canShare = await Sharing.isAvailableAsync();
        if (!canShare) {
            Alert.alert(t('settings.debugLogging'), t('settings.shareUnavailable'));
            return;
        }
        await Sharing.shareAsync(path, { mimeType: 'text/plain' });
    };

    const handleClearLog = async () => {
        await clearLog();
        Alert.alert(t('settings.debugLogging'), t('settings.logCleared'));
    };

    const handleSetSyncPath = async () => {
        try {
            const result = await pickAndParseSyncFolder();
            if (result) {
                const fileUri = (result as { __fileUri: string }).__fileUri;
                if (fileUri) {
                    await AsyncStorage.setItem(SYNC_PATH_KEY, fileUri);
                    setSyncPath(fileUri);
                    await AsyncStorage.setItem(SYNC_BACKEND_KEY, 'file');
                    setSyncBackend('file');
                    resetSyncStatusForBackendSwitch();
                    Alert.alert(localize('Success', '成功'), localize('Sync folder set successfully', '同步文件夹已设置'));
                }
            }
        } catch (error) {
            logSettingsError(error);
            const message = String(error);
            if (/Selected JSON file is not a Mindwtr backup/i.test(message)) {
                Alert.alert(
                    localize('Invalid sync file', '无效同步文件'),
                    localize(
                        'Please choose a Mindwtr backup JSON file in the target folder, then try "Select Folder" again.',
                        '请选择目标文件夹中的 Mindwtr 备份 JSON 文件，然后重试“选择文件夹”。'
                    )
                );
                return;
            }
            if (/temporary Inbox location|re-select a folder in Settings -> Data & Sync/i.test(message)) {
                Alert.alert(
                    localize('Unsupported cloud provider on iOS', 'iOS 云端提供商暂不支持'),
                    localize(
                        'The selected file came from a temporary iOS Files copy. Providers like Google Drive and OneDrive are not reliable for file sync here yet. Please choose iCloud Drive instead, or switch to WebDAV.',
                        '当前选择的是 iOS“文件”提供的临时副本。Google Drive、OneDrive 等提供商暂不适合作为这里的文件同步目录。请改用 iCloud Drive，或切换到 WebDAV。'
                    )
                );
                return;
            }
            if (/read-only|read only|not writable|isn't writable|permission denied|EACCES/i.test(message)) {
                Alert.alert(
                    localize('Sync folder is read-only', '同步文件夹不可写'),
                    Platform.OS === 'ios'
                        ? localize(
                            'The selected folder is read-only. Choose a writable location, or make the cloud folder available offline in Files before selecting it.',
                            '所选文件夹不可写。请选择可写位置，或先在“文件”App中将云端文件夹设为离线可用后再选择。'
                        )
                        : localize(
                            'The selected folder is read-only. Please choose a writable folder (e.g. My files) or make it available offline.',
                            '所选文件夹不可写。请选择可写文件夹（如“我的文件”），或将其设为离线可用。'
                        )
                );
                return;
            }
            Alert.alert(localize('Error', '错误'), localize('Failed to set sync path', '设置失败'));
        }
    };

    const handleConnectDropbox = async () => {
        if (isFossBuild) {
            Alert.alert(localize('Dropbox unavailable', 'Dropbox 不可用'), localize('Dropbox is disabled in FOSS builds.', 'FOSS 构建不支持 Dropbox。'));
            return;
        }
        if (!dropboxConfigured) {
            Alert.alert(localize('Dropbox unavailable', 'Dropbox 不可用'), localize('Dropbox app key is not configured in this build.', '当前构建未配置 Dropbox App Key。'));
            return;
        }
        if (isExpoGo) {
            Alert.alert(
                localize('Dropbox unavailable in Expo Go', 'Expo Go 不支持 Dropbox'),
                `${localize(
                    'Dropbox OAuth requires a development/release build. Expo Go uses temporary redirect URIs that Dropbox rejects.',
                    'Dropbox OAuth 需要开发版或正式版应用。Expo Go 使用临时回调地址，Dropbox 会拒绝。'
                )}\n\n${localize('Use redirect URI', '请使用回调地址')}: ${getDropboxRedirectUri()}`
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
            setSyncBackend('cloud');
            setDropboxConnected(true);
            resetSyncStatusForBackendSwitch();
            Alert.alert(localize('Success', '成功'), localize('Connected to Dropbox.', '已连接 Dropbox。'));
        } catch (error) {
            logSettingsError(error);
            const message = formatError(error);
            if (/redirect[_\s-]?uri/i.test(message)) {
                Alert.alert(
                    localize('Invalid redirect URI', '回调地址无效'),
                    `${localize('Add this exact redirect URI in Dropbox OAuth settings.', '请在 Dropbox OAuth 设置里添加以下精确回调地址。')}\n\n${getDropboxRedirectUri()}`
                );
            } else {
                Alert.alert(localize('Connection failed', '连接失败'), message);
            }
        } finally {
            setDropboxBusy(false);
        }
    };

    const handleDisconnectDropbox = async () => {
        if (!dropboxConfigured) {
            setDropboxConnected(false);
            return;
        }
        setDropboxBusy(true);
        try {
            await disconnectDropbox(dropboxAppKey);
            setDropboxConnected(false);
            resetSyncStatusForBackendSwitch();
            Alert.alert(localize('Disconnected', '已断开'), localize('Dropbox connection removed.', '已移除 Dropbox 连接。'));
        } catch (error) {
            logSettingsError(error);
            Alert.alert(localize('Disconnect failed', '断开失败'), formatError(error));
        } finally {
            setDropboxBusy(false);
        }
    };

    const handleTestDropboxConnection = async () => {
        if (isFossBuild) {
            Alert.alert(localize('Dropbox unavailable', 'Dropbox 不可用'), localize('Dropbox is disabled in FOSS builds.', 'FOSS 构建不支持 Dropbox。'));
            return;
        }
        if (!dropboxConfigured) {
            Alert.alert(localize('Dropbox unavailable', 'Dropbox 不可用'), localize('Dropbox app key is not configured in this build.', '当前构建未配置 Dropbox App Key。'));
            return;
        }
        setIsTestingConnection(true);
        try {
            await runDropboxConnectionTest();
            setDropboxConnected(true);
            Alert.alert(localize('Connection OK', '连接成功'), localize('Dropbox account is reachable.', 'Dropbox 账号可访问。'));
        } catch (error) {
            logSettingsWarn('Dropbox connection test failed', error);
            if (isDropboxUnauthorizedSettingsError(error)) {
                setDropboxConnected(false);
                Alert.alert(
                    localize('Connection failed', '连接失败'),
                    localize(
                        'Dropbox token is invalid or revoked. Please tap Connect Dropbox to re-authorize.',
                        'Dropbox 令牌无效或已失效。请点击“连接 Dropbox”重新授权。'
                    )
                );
            } else {
                Alert.alert(localize('Connection failed', '连接失败'), formatError(error));
            }
        } finally {
            setIsTestingConnection(false);
        }
    };

    const handleSync = async () => {
        setIsSyncing(true);
        try {
            if (syncBackend === 'off') return;
            if (syncBackend === 'webdav') {
                if (!webdavUrl.trim()) {
                    Alert.alert(localize('Notice', '提示'), localize('Please set a WebDAV URL first', '请先设置 WebDAV 地址'));
                    return;
                }
                if (webdavUrlError) {
                    Alert.alert(localize('Invalid URL', '地址无效'), localize('Please enter a valid WebDAV URL (http/https).', '请输入有效的 WebDAV 地址（http/https）。'));
                    return;
                }
                await AsyncStorage.multiSet([
                    [SYNC_BACKEND_KEY, 'webdav'],
                    [WEBDAV_URL_KEY, webdavUrl.trim()],
                    [WEBDAV_USERNAME_KEY, webdavUsername.trim()],
                    [WEBDAV_PASSWORD_KEY, webdavPassword],
                ]);
            } else if (syncBackend === 'cloudkit') {
                await AsyncStorage.setItem(SYNC_BACKEND_KEY, 'cloudkit');
            } else if (syncBackend === 'cloud') {
                if (cloudProvider === 'dropbox') {
                    if (isFossBuild) {
                        Alert.alert(localize('Dropbox unavailable', 'Dropbox 不可用'), localize('Dropbox is disabled in FOSS builds.', 'FOSS 构建不支持 Dropbox。'));
                        return;
                    }
                    if (!dropboxConfigured) {
                        Alert.alert(localize('Dropbox unavailable', 'Dropbox 不可用'), localize('Dropbox app key is not configured in this build.', '当前构建未配置 Dropbox App Key。'));
                        return;
                    }
                    const connected = await isDropboxConnected();
                    if (!connected) {
                        Alert.alert(localize('Notice', '提示'), localize('Please connect Dropbox first.', '请先连接 Dropbox。'));
                        return;
                    }
                    await AsyncStorage.multiSet([
                        [SYNC_BACKEND_KEY, 'cloud'],
                        [CLOUD_PROVIDER_KEY, 'dropbox'],
                    ]);
                } else {
                    if (!cloudUrl.trim()) {
                        Alert.alert(localize('Notice', '提示'), localize('Please set a self-hosted URL first', '请先设置自托管地址'));
                        return;
                    }
                    if (cloudUrlError) {
                        Alert.alert(localize('Invalid URL', '地址无效'), localize('Please enter a valid self-hosted URL (http/https).', '请输入有效的自托管地址（http/https）。'));
                        return;
                    }
                    await AsyncStorage.multiSet([
                        [SYNC_BACKEND_KEY, 'cloud'],
                        [CLOUD_PROVIDER_KEY, 'selfhosted'],
                        [CLOUD_URL_KEY, cloudUrl.trim()],
                        [CLOUD_TOKEN_KEY, cloudToken],
                    ]);
                }
            } else {
                if (!syncPath) {
                    Alert.alert(localize('Notice', '提示'), localize('Please set a sync folder first', '请先设置同步文件夹'));
                    return;
                }
                await AsyncStorage.setItem(SYNC_BACKEND_KEY, 'file');
            }

            resetSyncStatusForBackendSwitch();
            const result = await performMobileSync(syncBackend === 'file' ? syncPath || undefined : undefined);
            if (result.skipped === 'offline' || isLikelyOfflineSyncError(result.error)) {
                Alert.alert(localize('Offline', '离线'), localize('No internet connection. Sync skipped.', '当前无网络连接，已跳过同步。'));
                return;
            }
            if (result.success) {
                const conflictCount = (result.stats?.tasks.conflicts || 0) + (result.stats?.projects.conflicts || 0);
                Alert.alert(
                    localize('Success', '成功'),
                    conflictCount > 0
                        ? localize(`Sync completed with ${conflictCount} conflicts (resolved automatically).`, `同步完成，发现 ${conflictCount} 个冲突（已自动处理）。`)
                        : localize('Sync completed!', '同步完成！')
                );
            } else {
                throw new Error(result.error || 'Unknown error');
            }
        } catch (error) {
            logSettingsError(error);
            const message = String(error);
            if (/temporary Inbox location|re-select a folder in Settings -> Data & Sync|Cannot access the selected sync file/i.test(message)) {
                Alert.alert(
                    localize('Unsupported cloud provider on iOS', 'iOS 云端提供商暂不支持'),
                    localize(
                        'The selected file came from a temporary iOS Files copy. Providers like Google Drive and OneDrive are not reliable for file sync here yet. Please go to Settings → Data & Sync, choose iCloud Drive, or switch to WebDAV.',
                        '当前选择的是 iOS“文件”提供的临时副本。Google Drive、OneDrive 等提供商暂不适合作为这里的文件同步目录。请前往「设置 → 数据与同步」，改选 iCloud Drive，或切换到 WebDAV。'
                    )
                );
                return;
            }
            Alert.alert(localize('Error', '错误'), localize('Sync failed', '同步失败'));
        } finally {
            setIsSyncing(false);
        }
    };

    const handleTestConnection = async (backend: 'webdav' | 'cloud') => {
        setIsTestingConnection(true);
        try {
            if (backend === 'webdav') {
                if (!webdavUrl.trim() || webdavUrlError) {
                    Alert.alert(localize('Invalid URL', '地址无效'), localize('Please enter a valid WebDAV URL (http/https).', '请输入有效的 WebDAV 地址（http/https）。'));
                    return;
                }
                await webdavGetJson<unknown>(webdavUrl.trim().replace(/\/+$/, ''), {
                    username: webdavUsername.trim(),
                    password: webdavPassword,
                    timeoutMs: 10_000,
                });
                Alert.alert(localize('Connection OK', '连接成功'), localize('WebDAV endpoint is reachable.', 'WebDAV 端点可访问。'));
                return;
            }

            if (cloudProvider === 'dropbox') {
                if (isFossBuild) {
                    Alert.alert(localize('Dropbox unavailable', 'Dropbox 不可用'), localize('Dropbox is disabled in FOSS builds.', 'FOSS 构建不支持 Dropbox。'));
                    return;
                }
                await runDropboxConnectionTest();
                setDropboxConnected(true);
                Alert.alert(localize('Connection OK', '连接成功'), localize('Dropbox account is reachable.', 'Dropbox 账号可访问。'));
                return;
            }

            if (!cloudUrl.trim() || cloudUrlError) {
                Alert.alert(localize('Invalid URL', '地址无效'), localize('Please enter a valid self-hosted URL (http/https).', '请输入有效的自托管地址（http/https）。'));
                return;
            }
            await cloudGetJson<unknown>(cloudUrl.trim().replace(/\/+$/, ''), {
                token: cloudToken,
                timeoutMs: 10_000,
            });
            Alert.alert(localize('Connection OK', '连接成功'), localize('Self-hosted endpoint is reachable.', '自托管端点可访问。'));
        } catch (error) {
            logSettingsWarn('Sync connection test failed', error);
            if (cloudProvider === 'dropbox' && isDropboxUnauthorizedSettingsError(error)) {
                setDropboxConnected(false);
            }
            Alert.alert(
                localize('Connection failed', '连接失败'),
                cloudProvider === 'dropbox' && isDropboxUnauthorizedSettingsError(error)
                    ? localize(
                        'Dropbox token is invalid or revoked. Please tap Connect Dropbox to re-authorize.',
                        'Dropbox 令牌无效或已失效。请点击“连接 Dropbox”重新授权。'
                    )
                    : formatError(error)
            );
        } finally {
            setIsTestingConnection(false);
        }
    };

    const lastSyncCard = (
        <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
            <View style={styles.settingRow}>
                <View style={styles.settingInfo}>
                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.lastSync')}</Text>
                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                        {settings.lastSyncAt ? new Date(settings.lastSyncAt).toLocaleString() : t('settings.lastSyncNever')}
                        {settings.lastSyncStatus === 'error' && t('settings.syncStatusFailedSuffix')}
                        {settings.lastSyncStatus === 'conflict' && t('settings.syncStatusConflictsSuffix')}
                    </Text>
                    {showLastSyncStats && (
                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                            {t('settings.lastSyncConflicts')}: {syncConflictCount}
                        </Text>
                    )}
                    {showLastSyncStats && maxClockSkewMs > 0 && (
                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                            {t('settings.lastSyncSkew')}: {formatClockSkew(maxClockSkewMs)}
                        </Text>
                    )}
                    {showLastSyncStats && timestampAdjustments > 0 && (
                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                            {t('settings.lastSyncAdjusted')}: {timestampAdjustments}
                        </Text>
                    )}
                    {showLastSyncStats && conflictIds.length > 0 && (
                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                            {t('settings.lastSyncConflictIds')}: {conflictIds.join(', ')}
                        </Text>
                    )}
                    {settings.lastSyncStatus === 'error' && settings.lastSyncError && (
                        <Text style={[styles.settingDescription, { color: '#EF4444' }]}>{settings.lastSyncError}</Text>
                    )}
                    {renderSyncHistory()}
                </View>
            </View>
        </View>
    );

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
            <SettingsTopBar />
            <SubHeader title={t('settings.dataSync')} />
            <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginBottom: 12 }]}>
                    <View style={styles.settingRowColumn}>
                        <View style={styles.settingInfo}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.syncBackend')}</Text>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                {syncBackend === 'off'
                                    ? t('settings.syncBackendOff')
                                    : syncBackend === 'cloudkit'
                                        ? 'iCloud (CloudKit)'
                                        : syncBackend === 'webdav'
                                            ? t('settings.syncBackendWebdav')
                                            : syncBackend === 'cloud'
                                                ? t('settings.syncBackendCloud')
                                                : t('settings.syncBackendFile')}
                            </Text>
                        </View>
                        <View style={[styles.backendToggle, { marginTop: 8, width: '100%' }]}>
                            {backendOptions.map((backend) => (
                                <TouchableOpacity
                                    key={backend}
                                    style={[
                                        styles.backendOption,
                                        { borderColor: tc.border, backgroundColor: syncBackend === backend ? tc.filterBg : 'transparent' },
                                    ]}
                                    onPress={() => {
                                        AsyncStorage.setItem(SYNC_BACKEND_KEY, backend).catch(logSettingsError);
                                        setSyncBackend(backend);
                                        resetSyncStatusForBackendSwitch();
                                    }}
                                >
                                    <Text style={[styles.backendOptionText, { color: syncBackend === backend ? tc.tint : tc.secondaryText }]}>
                                        {backend === 'off'
                                            ? t('settings.syncBackendOff')
                                            : backend === 'cloudkit'
                                                ? 'iCloud'
                                                : backend === 'file'
                                                    ? t('settings.syncBackendFile')
                                                    : backend === 'webdav'
                                                        ? t('settings.syncBackendWebdav')
                                                        : t('settings.syncBackendCloud')}
                                    </Text>
                                </TouchableOpacity>
                            ))}
                        </View>
                    </View>
                </View>

                {syncBackend === 'off' && (
                    <View style={[styles.helpBox, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                        <Text style={[styles.helpTitle, { color: tc.text }]}>{t('settings.syncOff')}</Text>
                        <Text style={[styles.helpText, { color: tc.secondaryText }]}>{t('settings.syncOffDesc')}</Text>
                    </View>
                )}

                {syncBackend === 'cloudkit' && supportsNativeICloudSync && (
                    <View style={[styles.helpBox, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                        <Text style={[styles.helpTitle, { color: tc.text }]}>iCloud Sync</Text>
                        <Text style={[styles.helpText, { color: tc.secondaryText }]}>
                            Syncs your tasks, projects, and areas across Apple devices using CloudKit. No setup required.
                        </Text>
                    </View>
                )}

                {syncBackend === 'file' && (
                    <>
                        <View style={[styles.helpBox, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                            <Text style={[styles.helpTitle, { color: tc.text }]}>{localize('How to Sync', '如何同步')}</Text>
                            <Text style={[styles.helpText, { color: tc.secondaryText }]}>
                                {Platform.OS === 'ios' ? t('settings.fileSyncHowToIos') : t('settings.fileSyncHowToAndroid')}
                            </Text>
                            <Text style={[styles.helpText, { color: tc.secondaryText, marginTop: 8 }]}>{t('settings.fileSyncTip')}</Text>
                        </View>

                        <Text style={[styles.sectionTitle, { color: tc.text, marginTop: 16 }]}>{t('settings.syncSettings')}</Text>
                        <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                            <View style={styles.settingRow}>
                                <View style={styles.settingInfo}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.syncFolderLocation')}</Text>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]} numberOfLines={1}>
                                        {syncPath ? syncPath.split('/').pop() : t('common.notSet')}
                                    </Text>
                                </View>
                                <TouchableOpacity onPress={() => void handleSetSyncPath()}>
                                    <Text style={styles.linkText}>{t('settings.selectFolder')}</Text>
                                </TouchableOpacity>
                            </View>
                            <TouchableOpacity
                                style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                                onPress={() => void handleSync()}
                                disabled={isSyncing || !syncPath}
                            >
                                <View style={styles.settingInfo}>
                                    <Text style={[styles.settingLabel, { color: syncPath ? '#3B82F6' : tc.secondaryText }]}>{t('settings.syncNow')}</Text>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.syncReadMergeFolder')}</Text>
                                </View>
                                {isSyncing && <ActivityIndicator size="small" color="#3B82F6" />}
                            </TouchableOpacity>
                            <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                <View style={styles.settingInfo}>{lastSyncCard}</View>
                            </View>
                        </View>
                    </>
                )}

                {syncBackend === 'webdav' && (
                    <>
                        <Text style={[styles.sectionTitle, { color: tc.text, marginTop: 16 }]}>{t('settings.syncBackendWebdav')}</Text>
                        <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                            <View style={styles.inputGroup}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.webdavUrl')}</Text>
                                <TextInput
                                    value={webdavUrl}
                                    onChangeText={setWebdavUrl}
                                    placeholder={t('settings.webdavUrlPlaceholder')}
                                    placeholderTextColor={tc.secondaryText}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    style={[styles.textInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                                />
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.webdavHint')}</Text>
                                {webdavUrlError && (
                                    <Text style={[styles.settingDescription, { color: '#EF4444' }]}>{t('settings.invalidUrlHttp')}</Text>
                                )}
                            </View>
                            <View style={[styles.inputGroup, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.webdavUsername')}</Text>
                                <TextInput
                                    value={webdavUsername}
                                    onChangeText={setWebdavUsername}
                                    placeholder={t('settings.webdavUsernamePlaceholder')}
                                    placeholderTextColor={tc.secondaryText}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    style={[styles.textInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                                />
                            </View>
                            <View style={[styles.inputGroup, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.webdavPassword')}</Text>
                                <TextInput
                                    value={webdavPassword}
                                    onChangeText={setWebdavPassword}
                                    placeholder="••••••••"
                                    placeholderTextColor={tc.secondaryText}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    secureTextEntry
                                    style={[styles.textInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                                />
                            </View>
                            {Platform.OS === 'web' && (
                                <Text style={[styles.settingDescription, { color: '#F59E0B' }]}>
                                    {localize('Web warning: WebDAV passwords are stored in browser storage. Use only on trusted devices.', 'Web 提示：WebDAV 密码会保存在浏览器本地存储中，请仅在可信设备使用。')}
                                </Text>
                            )}
                            <TouchableOpacity
                                style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                                onPress={() => {
                                    if (webdavUrlError || !webdavUrl.trim()) {
                                        Alert.alert(localize('Invalid URL', '地址无效'), localize('Please enter a valid WebDAV URL (http/https).', '请输入有效的 WebDAV 地址（http/https）。'));
                                        return;
                                    }
                                    AsyncStorage.multiSet([
                                        [SYNC_BACKEND_KEY, 'webdav'],
                                        [WEBDAV_URL_KEY, webdavUrl.trim()],
                                        [WEBDAV_USERNAME_KEY, webdavUsername.trim()],
                                        [WEBDAV_PASSWORD_KEY, webdavPassword],
                                    ]).then(() => {
                                        resetSyncStatusForBackendSwitch();
                                        Alert.alert(localize('Success', '成功'), t('settings.webdavSave'));
                                    }).catch(logSettingsError);
                                }}
                                disabled={webdavUrlError || !webdavUrl.trim()}
                            >
                                <View style={styles.settingInfo}>
                                    <Text style={[styles.settingLabel, { color: webdavUrlError || !webdavUrl.trim() ? tc.secondaryText : tc.tint }]}>
                                        {t('settings.webdavSave')}
                                    </Text>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.webdavUrl')}</Text>
                                </View>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                                onPress={() => void handleSync()}
                                disabled={isSyncing || !webdavUrl.trim() || webdavUrlError}
                            >
                                <View style={styles.settingInfo}>
                                    <Text style={[styles.settingLabel, { color: webdavUrl.trim() && !webdavUrlError ? tc.tint : tc.secondaryText }]}>
                                        {t('settings.syncNow')}
                                    </Text>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.syncReadMergeWebdav')}</Text>
                                </View>
                                {isSyncing && <ActivityIndicator size="small" color={tc.tint} />}
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                                onPress={() => void handleTestConnection('webdav')}
                                disabled={isSyncing || isTestingConnection || !webdavUrl.trim() || webdavUrlError}
                            >
                                <View style={styles.settingInfo}>
                                    <Text style={[styles.settingLabel, { color: webdavUrl.trim() && !webdavUrlError ? tc.tint : tc.secondaryText }]}>
                                        {t('settings.testConnection')}
                                    </Text>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.webdavTestHint')}</Text>
                                </View>
                                {isTestingConnection && <ActivityIndicator size="small" color={tc.tint} />}
                            </TouchableOpacity>
                        </View>
                        {lastSyncCard}
                    </>
                )}

                {syncBackend === 'cloud' && (
                    <>
                        <Text style={[styles.sectionTitle, { color: tc.text, marginTop: 16 }]}>{t('settings.syncBackendCloud')}</Text>
                        <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                            <View style={styles.settingRowColumn}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.cloudProvider')}</Text>
                                <View style={[styles.backendToggle, { marginTop: 8, width: '100%' }]}>
                                    <TouchableOpacity
                                        style={[
                                            styles.backendOption,
                                            { borderColor: tc.border, backgroundColor: cloudProvider === 'selfhosted' ? tc.filterBg : 'transparent' },
                                        ]}
                                        onPress={() => {
                                            setCloudProvider('selfhosted');
                                            AsyncStorage.setItem(CLOUD_PROVIDER_KEY, 'selfhosted').catch(logSettingsError);
                                            resetSyncStatusForBackendSwitch();
                                        }}
                                    >
                                        <Text style={[styles.backendOptionText, { color: cloudProvider === 'selfhosted' ? tc.tint : tc.secondaryText }]}>
                                            {t('settings.cloudProviderSelfHosted')}
                                        </Text>
                                    </TouchableOpacity>
                                    {!isFossBuild && (
                                        <TouchableOpacity
                                            style={[
                                                styles.backendOption,
                                                { borderColor: tc.border, backgroundColor: cloudProvider === 'dropbox' ? tc.filterBg : 'transparent' },
                                            ]}
                                            onPress={() => {
                                                setCloudProvider('dropbox');
                                                AsyncStorage.setItem(CLOUD_PROVIDER_KEY, 'dropbox').catch(logSettingsError);
                                                resetSyncStatusForBackendSwitch();
                                            }}
                                        >
                                            <Text style={[styles.backendOptionText, { color: cloudProvider === 'dropbox' ? tc.tint : tc.secondaryText }]}>
                                                Dropbox
                                            </Text>
                                        </TouchableOpacity>
                                    )}
                                </View>
                            </View>
                        </View>

                        {cloudProvider === 'selfhosted' || isFossBuild ? (
                            <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                                <View style={styles.inputGroup}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.cloudUrl')}</Text>
                                    <TextInput
                                        value={cloudUrl}
                                        onChangeText={setCloudUrl}
                                        placeholder={t('settings.cloudUrlPlaceholder')}
                                        placeholderTextColor={tc.secondaryText}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                        style={[styles.textInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                                    />
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.cloudHint')}</Text>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.cloudBaseUrlHint')}</Text>
                                    {cloudUrlError && (
                                        <Text style={[styles.settingDescription, { color: '#EF4444' }]}>{t('settings.invalidUrlHttp')}</Text>
                                    )}
                                </View>
                                <View style={[styles.inputGroup, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.cloudToken')}</Text>
                                    <TextInput
                                        value={cloudToken}
                                        onChangeText={setCloudToken}
                                        placeholder="••••••••"
                                        placeholderTextColor={tc.secondaryText}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                        secureTextEntry
                                        style={[styles.textInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                                    />
                                </View>
                                <TouchableOpacity
                                    style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                                    onPress={() => {
                                        if (cloudUrlError || !cloudUrl.trim()) {
                                            Alert.alert(localize('Invalid URL', '地址无效'), localize('Please enter a valid self-hosted URL (http/https).', '请输入有效的自托管地址（http/https）。'));
                                            return;
                                        }
                                        AsyncStorage.multiSet([
                                            [SYNC_BACKEND_KEY, 'cloud'],
                                            [CLOUD_PROVIDER_KEY, 'selfhosted'],
                                            [CLOUD_URL_KEY, cloudUrl.trim()],
                                            [CLOUD_TOKEN_KEY, cloudToken],
                                        ]).then(() => {
                                            resetSyncStatusForBackendSwitch();
                                            Alert.alert(localize('Success', '成功'), t('settings.cloudSave'));
                                        }).catch(logSettingsError);
                                    }}
                                    disabled={cloudUrlError || !cloudUrl.trim()}
                                >
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: cloudUrlError || !cloudUrl.trim() ? tc.secondaryText : tc.tint }]}>
                                            {t('settings.cloudSave')}
                                        </Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.cloudUrl')}</Text>
                                    </View>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                                    onPress={() => void handleSync()}
                                    disabled={isSyncing || !cloudUrl.trim() || cloudUrlError}
                                >
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: cloudUrl.trim() && !cloudUrlError ? tc.tint : tc.secondaryText }]}>
                                            {t('settings.syncNow')}
                                        </Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.syncReadMergeSelfHosted')}</Text>
                                    </View>
                                    {isSyncing && <ActivityIndicator size="small" color={tc.tint} />}
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                                    onPress={() => void handleTestConnection('cloud')}
                                    disabled={isSyncing || isTestingConnection || !cloudUrl.trim() || cloudUrlError}
                                >
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: cloudUrl.trim() && !cloudUrlError ? tc.tint : tc.secondaryText }]}>
                                            {t('settings.testConnection')}
                                        </Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.cloudTestHint')}</Text>
                                    </View>
                                    {isTestingConnection && <ActivityIndicator size="small" color={tc.tint} />}
                                </TouchableOpacity>
                            </View>
                        ) : (
                            <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                                <View style={styles.settingRowColumn}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{localize('Dropbox account', 'Dropbox 账号')}</Text>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText, marginTop: 6 }]}>
                                        {localize(
                                            'OAuth with Dropbox App Folder access. Mindwtr syncs /Apps/Mindwtr/data.json and /Apps/Mindwtr/attachments/* in your Dropbox.',
                                            '使用 Dropbox OAuth（应用文件夹权限）。Mindwtr 会同步 Dropbox 中 /Apps/Mindwtr/data.json 与 /Apps/Mindwtr/attachments/*。'
                                        )}
                                    </Text>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText, marginTop: 6 }]}>
                                        {localize('Redirect URI', '回调地址')}: {getDropboxRedirectUri()}
                                    </Text>
                                    {!dropboxConfigured && (
                                        <Text style={[styles.settingDescription, { color: '#EF4444', marginTop: 8 }]}>
                                            {localize('Dropbox app key is not configured for this build.', '当前构建未配置 Dropbox App Key。')}
                                        </Text>
                                    )}
                                    {isExpoGo && (
                                        <Text style={[styles.settingDescription, { color: '#EF4444', marginTop: 8 }]}>
                                            {localize('Expo Go is not supported for Dropbox OAuth. Use a development/release build.', 'Expo Go 不支持 Dropbox OAuth。请使用开发版或正式版应用。')}
                                        </Text>
                                    )}
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText, marginTop: 8 }]}>
                                        {dropboxConnected ? localize('Status: Connected', '状态：已连接') : localize('Status: Not connected', '状态：未连接')}
                                    </Text>
                                </View>
                                <TouchableOpacity
                                    style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                                    onPress={() => void (dropboxConnected ? handleDisconnectDropbox() : handleConnectDropbox())}
                                    disabled={dropboxBusy || !dropboxConfigured || isExpoGo}
                                >
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: dropboxConfigured && !isExpoGo ? tc.tint : tc.secondaryText }]}>
                                            {dropboxConnected ? localize('Disconnect Dropbox', '断开 Dropbox') : localize('Connect Dropbox', '连接 Dropbox')}
                                        </Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                            {isExpoGo
                                                ? localize('Requires development/release build (Expo Go unsupported).', '需要开发版/正式版应用（Expo Go 不支持）。')
                                                : dropboxConnected
                                                    ? localize('Revoke app token and remove local auth.', '撤销应用令牌并移除本地授权。')
                                                    : localize('Open Dropbox OAuth sign-in in browser.', '在浏览器中打开 Dropbox OAuth 登录。')}
                                        </Text>
                                    </View>
                                    {dropboxBusy && <ActivityIndicator size="small" color={tc.tint} />}
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                                    onPress={() => void handleTestDropboxConnection()}
                                    disabled={isTestingConnection || !dropboxConfigured || !dropboxConnected}
                                >
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: dropboxConnected ? tc.tint : tc.secondaryText }]}>
                                            {t('settings.testConnection')}
                                        </Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.dropboxTestHint')}</Text>
                                    </View>
                                    {isTestingConnection && <ActivityIndicator size="small" color={tc.tint} />}
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                                    onPress={() => void handleSync()}
                                    disabled={isSyncing || !dropboxConfigured || !dropboxConnected}
                                >
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: dropboxConnected ? tc.tint : tc.secondaryText }]}>
                                            {t('settings.syncNow')}
                                        </Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                            {localize('Read and merge Dropbox data.', '读取并合并 Dropbox 数据。')}
                                        </Text>
                                    </View>
                                    {isSyncing && <ActivityIndicator size="small" color={tc.tint} />}
                                </TouchableOpacity>
                            </View>
                        )}
                        {lastSyncCard}
                    </>
                )}

                <Text style={[styles.sectionTitle, { color: tc.text, marginTop: 24 }]}>{t('settings.backup')}</Text>
                <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                    <TouchableOpacity style={styles.settingRow} onPress={() => void handleBackup()} disabled={isSyncing}>
                        <View style={styles.settingInfo}>
                            <Text style={[styles.settingLabel, { color: '#3B82F6' }]}>{t('settings.exportBackup')}</Text>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.saveToSyncFolder')}</Text>
                        </View>
                    </TouchableOpacity>
                </View>

                <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 16 }]}>
                    <TouchableOpacity style={styles.settingRow} onPress={() => setSyncOptionsOpen((prev) => !prev)}>
                        <View style={styles.settingInfo}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.syncPreferences')}</Text>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.syncPreferencesDesc')}</Text>
                        </View>
                        <Text style={[styles.chevron, { color: tc.secondaryText }]}>{syncOptionsOpen ? '▾' : '▸'}</Text>
                    </TouchableOpacity>
                    {syncOptionsOpen && (
                        <>
                            <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                <View style={styles.settingInfo}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.syncPreferenceAppearance')}</Text>
                                </View>
                                <Switch value={syncAppearanceEnabled} onValueChange={(value) => updateSyncPreferences({ appearance: value })} trackColor={{ false: '#767577', true: '#3B82F6' }} />
                            </View>
                            <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                <View style={styles.settingInfo}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.syncPreferenceLanguage')}</Text>
                                </View>
                                <Switch value={syncLanguageEnabled} onValueChange={(value) => updateSyncPreferences({ language: value })} trackColor={{ false: '#767577', true: '#3B82F6' }} />
                            </View>
                            <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                <View style={styles.settingInfo}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.syncPreferenceExternalCalendars')}</Text>
                                </View>
                                <Switch value={syncExternalCalendarsEnabled} onValueChange={(value) => updateSyncPreferences({ externalCalendars: value })} trackColor={{ false: '#767577', true: '#3B82F6' }} />
                            </View>
                            <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                <View style={styles.settingInfo}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.syncPreferenceAi')}</Text>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.syncPreferenceAiHint')}</Text>
                                </View>
                                <Switch value={syncAiEnabled} onValueChange={(value) => updateSyncPreferences({ ai: value })} trackColor={{ false: '#767577', true: '#3B82F6' }} />
                            </View>
                        </>
                    )}
                </View>

                <Text style={[styles.sectionTitle, { color: tc.text, marginTop: 24 }]}>{t('settings.diagnostics')}</Text>
                <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                    <View style={styles.settingRow}>
                        <View style={styles.settingInfo}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.debugLogging')}</Text>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.debugLoggingDesc')}</Text>
                        </View>
                        <Switch value={loggingEnabled} onValueChange={toggleDebugLogging} trackColor={{ false: '#767577', true: '#3B82F6' }} />
                    </View>
                    {loggingEnabled && (
                        <>
                            <TouchableOpacity style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]} onPress={() => void handleShareLog()}>
                                <View style={styles.settingInfo}>
                                    <Text style={[styles.settingLabel, { color: tc.tint }]}>{t('settings.shareLog')}</Text>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.logFile')}</Text>
                                </View>
                            </TouchableOpacity>
                            <TouchableOpacity style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]} onPress={() => void handleClearLog()}>
                                <View style={styles.settingInfo}>
                                    <Text style={[styles.settingLabel, { color: tc.secondaryText }]}>{t('settings.clearLog')}</Text>
                                </View>
                            </TouchableOpacity>
                        </>
                    )}
                </View>
            </ScrollView>
        </SafeAreaView>
    );
}
