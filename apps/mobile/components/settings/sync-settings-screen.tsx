import React, { useCallback, useEffect, useState } from 'react';
import Constants from 'expo-constants';
import { Alert, Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
    addBreadcrumb,
    CLOCK_SKEW_THRESHOLD_MS,
    useTaskStore,
} from '@mindwtr/core';

import { useMobileSyncBadge } from '@/hooks/use-mobile-sync-badge';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useToast } from '@/contexts/toast-context';
import { getCloudKitAccountStatus, isCloudKitAvailable } from '@/lib/cloudkit-sync';
import {
    listLocalDataSnapshots,
} from '@/lib/data-transfer';
import { getDropboxRedirectUri } from '@/lib/dropbox-oauth';
import {
    isDropboxClientConfigured,
    isDropboxConnected,
} from '@/lib/dropbox-auth';
import { logInfo } from '@/lib/app-log';
import {
    formatClockSkew,
    logSettingsError,
} from '@/lib/settings-utils';
import {
    classifySyncFailure,
    coerceSupportedBackend,
} from '@/lib/sync-service-utils';
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
import { SyncCloudKitBackendPanel } from './sync-settings-cloudkit-panel';
import { SyncDropboxBackendPanel } from './sync-settings-dropbox-panel';
import { SyncFileBackendPanel } from './sync-settings-file-panel';
import {
    SyncBackupSection,
    SyncDiagnosticsCard,
    SyncLastStatusCard,
    SyncPreferencesCard,
} from './sync-settings-sections';
import { SyncSelfHostedBackendPanel, type SelfHostedSyncSettings } from './sync-settings-selfhosted-panel';
import { SyncWebDavBackendPanel, type WebDavSyncSettings } from './sync-settings-webdav-panel';
import { useSyncSettingsBackupActions } from './use-sync-settings-backup-actions';
import { useSyncSettingsTransportActions } from './use-sync-settings-transport-actions';
import { SettingsTopBar, SubHeader } from './settings.shell';
import { styles } from './settings.styles';

export function SyncSettingsScreen() {
    const tc = useThemeColors();
    const { showToast } = useToast();
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
    type CloudKitAccountStatus = 'available' | 'noAccount' | 'restricted' | 'temporarilyUnavailable' | 'unknown';
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
    const [cloudKitAccountStatus, setCloudKitAccountStatus] = useState<CloudKitAccountStatus>('unknown');
    const [syncOptionsOpen, setSyncOptionsOpen] = useState(false);
    const [syncHistoryExpanded, setSyncHistoryExpanded] = useState(false);
    const [backupAction, setBackupAction] = useState<null | 'export' | 'restore' | 'import' | 'snapshot'>(null);
    const [recoverySnapshots, setRecoverySnapshots] = useState<string[]>([]);
    const [recoverySnapshotsOpen, setRecoverySnapshotsOpen] = useState(false);
    const [isLoadingRecoverySnapshots, setIsLoadingRecoverySnapshots] = useState(false);
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
    const isBackupBusy = backupAction !== null;
    const backendOptions: ('off' | 'file' | 'webdav' | 'cloud')[] = ['off', 'file', 'webdav', 'cloud'];
    const isCloudSyncSelected = syncBackend === 'cloud' || syncBackend === 'cloudkit';
    const showSettingsWarning = useCallback((title: string, message: string, durationMs = 4200) => {
        showToast({
            title,
            message,
            tone: 'warning',
            durationMs,
        });
    }, [showToast]);
    const showSettingsErrorToast = useCallback((title: string, message: string, durationMs = 4200) => {
        showToast({
            title,
            message,
            tone: 'error',
            durationMs,
        });
    }, [showToast]);
    const getSyncFailureToastMessage = useCallback((error: unknown) => {
        switch (classifySyncFailure(error)) {
            case 'offline':
                return localize('Check your internet connection and try again.', '请检查网络连接后重试。');
            case 'auth':
                return localize(
                    'Re-authenticate or review your sync credentials in Data & Sync.',
                    '请在“数据与同步”中重新验证或检查同步凭据。'
                );
            case 'permission':
                return localize(
                    'Re-select the sync file or folder, or grant access again in Data & Sync.',
                    '请在“数据与同步”中重新选择同步文件/文件夹，或重新授予访问权限。'
                );
            case 'rateLimited':
                return localize('The sync backend is rate limiting requests. Wait a moment and try again.', '同步后端正在限流。请稍后再试。');
            case 'misconfigured':
                return localize(
                    'Finish configuring the selected sync backend in Data & Sync.',
                    '请先在“数据与同步”中完成所选同步后端的配置。'
                );
            case 'conflict':
                return localize(
                    'Another device or backend reported a sync conflict. Retry after both sides finish syncing.',
                    '另一台设备或后端报告了同步冲突。请等待双方完成同步后再重试。'
                );
            default:
                return localize('Review Data & Sync settings and try again.', '请检查“数据与同步”设置后重试。');
        }
    }, [localize]);

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
            const resolvedCloudProvider: CloudProvider =
                ((resolvedBackend === 'cloudkit' || storedCloudProvider === 'cloudkit') && supportsNativeICloudSync)
                    ? 'cloudkit'
                    : storedCloudProvider === 'dropbox' && !isFossBuild
                        ? 'dropbox'
                        : 'selfhosted';
            setCloudProvider(resolvedCloudProvider);
            if (isFossBuild && storedCloudProvider === 'dropbox') {
                AsyncStorage.setItem(CLOUD_PROVIDER_KEY, 'selfhosted').catch(logSettingsError);
            }
            if (!supportsNativeICloudSync && storedCloudProvider === 'cloudkit') {
                AsyncStorage.setItem(CLOUD_PROVIDER_KEY, 'selfhosted').catch(logSettingsError);
            }
        }).catch(logSettingsError);
    }, [isFossBuild, supportsNativeICloudSync]);

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

    const refreshRecoverySnapshots = useCallback(async () => {
        setIsLoadingRecoverySnapshots(true);
        try {
            setRecoverySnapshots(await listLocalDataSnapshots());
        } catch (error) {
            logSettingsError(error);
        } finally {
            setIsLoadingRecoverySnapshots(false);
        }
    }, []);

    useEffect(() => {
        void refreshRecoverySnapshots();
    }, [refreshRecoverySnapshots]);

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

    const getCloudKitStatusDetails = (status: CloudKitAccountStatus) => {
        switch (status) {
            case 'available':
                return {
                    label: localize('Signed in to iCloud', '已登录 iCloud'),
                    helpText: localize(
                        'Syncs your tasks, projects, and areas across Apple devices using CloudKit. No Mindwtr account setup is required. Tap "Sync now" to force an immediate merge.',
                        '通过 CloudKit 在 Apple 设备间同步任务、项目和领域。无需额外注册 Mindwtr 账号。点击“立即同步”可手动触发一次合并。'
                    ),
                    syncEnabled: true,
                };
            case 'noAccount':
                return {
                    label: localize('iCloud sign-in required', '需要登录 iCloud'),
                    helpText: localize(
                        'This device is not signed into iCloud. Open iOS Settings, sign into your Apple Account, enable iCloud for Mindwtr, then come back and tap "Sync now".',
                        '这台设备尚未登录 iCloud。请打开 iOS“设置”，登录 Apple 账户并为 Mindwtr 启用 iCloud，然后返回这里点击“立即同步”。'
                    ),
                    syncEnabled: false,
                };
            case 'restricted':
                return {
                    label: localize('iCloud restricted', 'iCloud 已受限'),
                    helpText: localize(
                        'CloudKit is restricted on this device. Check Screen Time, MDM, or iCloud restrictions, then try again.',
                        '这台设备上的 CloudKit 已被限制。请检查屏幕使用时间、设备管理或 iCloud 限制后再试。'
                    ),
                    syncEnabled: false,
                };
            case 'temporarilyUnavailable':
                return {
                    label: localize('iCloud temporarily unavailable', 'iCloud 暂时不可用'),
                    helpText: localize(
                        'iCloud is temporarily unavailable. Wait a moment, then tap "Sync now" again.',
                        'iCloud 当前暂时不可用。请稍后再点击“立即同步”。'
                    ),
                    syncEnabled: false,
                };
            case 'unknown':
            default:
                return {
                    label: localize('iCloud status unavailable', 'iCloud 状态未知'),
                    helpText: localize(
                        'Syncs your tasks, projects, and areas across Apple devices using CloudKit. If sync does not start, verify that iCloud is enabled for this device and app, then tap "Sync now".',
                        '通过 CloudKit 在 Apple 设备间同步任务、项目和领域。如果同步没有开始，请确认此设备和该应用已启用 iCloud，然后点击“立即同步”。'
                    ),
                    syncEnabled: true,
                };
        }
    };

    const cloudKitStatusDetails = getCloudKitStatusDetails(cloudKitAccountStatus);

    const {
        formatRecoverySnapshotLabel,
        handleBackup,
        handleClearLog,
        handleImportDgt,
        handleImportTodoist,
        handleRestoreBackup,
        handleRestoreRecoverySnapshot,
        handleShareLog,
        toggleDebugLogging,
    } = useSyncSettingsBackupActions({
        areas,
        localize,
        projects,
        refreshRecoverySnapshots,
        sections,
        settings,
        setBackupAction,
        showSettingsErrorToast,
        showSettingsWarning,
        showToast,
        t,
        tasks,
        updateSettings,
    });
    const {
        handleConnectDropbox,
        handleDisconnectDropbox,
        handleSaveSelfHostedSettings,
        handleSaveWebDavSettings,
        handleSetSyncPath,
        handleSync,
        handleTestConnection,
        handleTestDropboxConnection,
    } = useSyncSettingsTransportActions({
        cloudProvider,
        cloudToken,
        cloudUrl,
        dropboxAppKey,
        dropboxConfigured,
        getCloudKitStatusDetails,
        getSyncFailureToastMessage,
        isExpoGo,
        isFossBuild,
        localize,
        resetSyncStatusForBackendSwitch,
        setCloudKitAccountStatus,
        setCloudProvider,
        setCloudToken,
        setCloudUrl,
        setDropboxBusy,
        setDropboxConnected,
        setIsSyncing,
        setIsTestingConnection,
        setSyncBackend,
        setSyncPath,
        setWebdavPassword,
        setWebdavUrl,
        setWebdavUsername,
        settings,
        showSettingsErrorToast,
        showSettingsWarning,
        showToast,
        syncBackend,
        syncPath,
        t,
        webdavPassword,
        webdavUrl,
        webdavUsername,
    });

    const lastSyncCard = (
        <SyncLastStatusCard
            conflictCount={syncConflictCount}
            conflictIds={conflictIds}
            historyContent={renderSyncHistory()}
            lastSyncAt={settings.lastSyncAt}
            lastSyncError={settings.lastSyncError}
            lastSyncStatus={settings.lastSyncStatus}
            maxClockSkewLabel={maxClockSkewMs > 0 ? formatClockSkew(maxClockSkewMs) : undefined}
            showLastSyncStats={showLastSyncStats}
            t={t}
            tc={tc}
            timestampAdjustments={timestampAdjustments}
        />
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
                                    : syncBackend === 'webdav'
                                            ? t('settings.syncBackendWebdav')
                                            : isCloudSyncSelected
                                                ? cloudProvider === 'cloudkit'
                                                    ? 'iCloud (CloudKit)'
                                                    : t('settings.syncBackendCloud')
                                                : t('settings.syncBackendFile')}
                            </Text>
                        </View>
                        <View style={[styles.backendToggle, { marginTop: 8, width: '100%' }]}>
                            {backendOptions.map((backend) => (
                                <TouchableOpacity
                                    key={backend}
                                    style={[
                                        styles.backendOption,
                                        {
                                            borderColor: tc.border,
                                            backgroundColor: (backend === 'cloud' ? isCloudSyncSelected : syncBackend === backend)
                                                ? tc.filterBg
                                                : 'transparent',
                                        },
                                    ]}
                                    onPress={() => {
                                        const nextBackend = backend === 'cloud'
                                            ? (cloudProvider === 'cloudkit' ? 'cloudkit' : 'cloud')
                                            : backend;
                                        AsyncStorage.setItem(SYNC_BACKEND_KEY, nextBackend).catch(logSettingsError);
                                        addBreadcrumb(`settings:syncBackend:${nextBackend}`);
                                        setSyncBackend(nextBackend);
                                        resetSyncStatusForBackendSwitch();
                                    }}
                                >
                                    <Text
                                        style={[
                                            styles.backendOptionText,
                                            {
                                                color: (backend === 'cloud' ? isCloudSyncSelected : syncBackend === backend)
                                                    ? tc.tint
                                                    : tc.secondaryText,
                                            },
                                        ]}
                                    >
                                        {backend === 'off'
                                            ? t('settings.syncBackendOff')
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

                {syncBackend === 'file' && (
                    <SyncFileBackendPanel
                        isSyncing={isSyncing}
                        lastSyncCard={lastSyncCard}
                        localize={localize}
                        onSelectFolder={() => void handleSetSyncPath()}
                        onSync={() => void handleSync({ backend: 'file' })}
                        syncPath={syncPath}
                        t={t}
                        tc={tc}
                    />
                )}

                {syncBackend === 'webdav' && (
                    <SyncWebDavBackendPanel
                        initialPassword={webdavPassword}
                        initialUrl={webdavUrl}
                        initialUsername={webdavUsername}
                        isSyncing={isSyncing}
                        isTestingConnection={isTestingConnection}
                        lastSyncCard={lastSyncCard}
                        localize={localize}
                        onSave={(settings) => void handleSaveWebDavSettings(settings)}
                        onSync={(settings) => void handleSync({ backend: 'webdav', webdav: settings })}
                        onTestConnection={(settings) => void handleTestConnection('webdav', { webdav: settings })}
                        t={t}
                        tc={tc}
                    />
                )}

                {isCloudSyncSelected && (
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
                                            AsyncStorage.multiSet([
                                                [CLOUD_PROVIDER_KEY, 'selfhosted'],
                                                [SYNC_BACKEND_KEY, 'cloud'],
                                            ]).catch(logSettingsError);
                                            setSyncBackend('cloud');
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
                                                AsyncStorage.multiSet([
                                                    [CLOUD_PROVIDER_KEY, 'dropbox'],
                                                    [SYNC_BACKEND_KEY, 'cloud'],
                                                ]).catch(logSettingsError);
                                                setSyncBackend('cloud');
                                                resetSyncStatusForBackendSwitch();
                                            }}
                                        >
                                            <Text style={[styles.backendOptionText, { color: cloudProvider === 'dropbox' ? tc.tint : tc.secondaryText }]}>
                                                Dropbox
                                            </Text>
                                        </TouchableOpacity>
                                    )}
                                    {supportsNativeICloudSync && (
                                        <TouchableOpacity
                                            style={[
                                                styles.backendOption,
                                                { borderColor: tc.border, backgroundColor: cloudProvider === 'cloudkit' ? tc.filterBg : 'transparent' },
                                            ]}
                                            onPress={() => {
                                                setCloudProvider('cloudkit');
                                                AsyncStorage.multiSet([
                                                    [CLOUD_PROVIDER_KEY, 'cloudkit'],
                                                    [SYNC_BACKEND_KEY, 'cloudkit'],
                                                ]).catch(logSettingsError);
                                                setSyncBackend('cloudkit');
                                                resetSyncStatusForBackendSwitch();
                                            }}
                                        >
                                            <Text style={[styles.backendOptionText, { color: cloudProvider === 'cloudkit' ? tc.tint : tc.secondaryText }]}>
                                                iCloud
                                            </Text>
                                        </TouchableOpacity>
                                    )}
                                </View>
                            </View>
                        </View>

                        {cloudProvider === 'cloudkit' && supportsNativeICloudSync ? (
                            <SyncCloudKitBackendPanel
                                helpText={cloudKitStatusDetails.helpText}
                                isSyncEnabled={cloudKitStatusDetails.syncEnabled}
                                isSyncing={isSyncing}
                                lastSyncCard={lastSyncCard}
                                localize={localize}
                                onSync={() => void handleSync({ backend: 'cloudkit', cloudProvider: 'cloudkit' })}
                                statusLabel={cloudKitStatusDetails.label}
                                t={t}
                                tc={tc}
                            />
                        ) : cloudProvider === 'selfhosted' || isFossBuild ? (
                            <SyncSelfHostedBackendPanel
                                initialToken={cloudToken}
                                initialUrl={cloudUrl}
                                isSyncing={isSyncing}
                                isTestingConnection={isTestingConnection}
                                lastSyncCard={lastSyncCard}
                                onSave={(settings) => void handleSaveSelfHostedSettings(settings)}
                                onSync={(settings) => void handleSync({ backend: 'cloud', cloud: settings, cloudProvider: 'selfhosted' })}
                                onTestConnection={(settings) => void handleTestConnection('cloud', { cloud: settings, cloudProvider: 'selfhosted' })}
                                t={t}
                                tc={tc}
                            />
                        ) : (
                            <SyncDropboxBackendPanel
                                dropboxBusy={dropboxBusy}
                                dropboxConfigured={dropboxConfigured}
                                dropboxConnected={dropboxConnected}
                                isExpoGo={isExpoGo}
                                isSyncing={isSyncing}
                                isTestingConnection={isTestingConnection}
                                lastSyncCard={lastSyncCard}
                                localize={localize}
                                onConnectToggle={() => void (dropboxConnected ? handleDisconnectDropbox() : handleConnectDropbox())}
                                onSync={() => void handleSync({ backend: 'cloud', cloudProvider: 'dropbox' })}
                                onTestConnection={() => void handleTestDropboxConnection()}
                                redirectUri={getDropboxRedirectUri()}
                                t={t}
                                tc={tc}
                            />
                        )}
                    </>
                )}

                <SyncBackupSection
                    backupAction={backupAction}
                    formatRecoverySnapshotLabel={formatRecoverySnapshotLabel}
                    handleBackup={() => void handleBackup()}
                    handleImportDgt={() => void handleImportDgt()}
                    handleImportTodoist={() => void handleImportTodoist()}
                    handleRestoreBackup={() => void handleRestoreBackup()}
                    handleRestoreRecoverySnapshot={(snapshot) => void handleRestoreRecoverySnapshot(snapshot)}
                    isBackupBusy={isBackupBusy}
                    isLoadingRecoverySnapshots={isLoadingRecoverySnapshots}
                    isSyncing={isSyncing}
                    localize={localize}
                    recoverySnapshots={recoverySnapshots}
                    recoverySnapshotsOpen={recoverySnapshotsOpen}
                    setRecoverySnapshotsOpen={setRecoverySnapshotsOpen}
                    t={t}
                    tc={tc}
                />

                <SyncPreferencesCard
                    syncAiEnabled={syncAiEnabled}
                    syncAppearanceEnabled={syncAppearanceEnabled}
                    syncExternalCalendarsEnabled={syncExternalCalendarsEnabled}
                    syncLanguageEnabled={syncLanguageEnabled}
                    syncOptionsOpen={syncOptionsOpen}
                    t={t}
                    tc={tc}
                    toggleSyncOptionsOpen={() => setSyncOptionsOpen((prev) => !prev)}
                    updateSyncPreferences={updateSyncPreferences}
                />

                <SyncDiagnosticsCard
                    handleClearLog={() => void handleClearLog()}
                    handleShareLog={() => void handleShareLog()}
                    loggingEnabled={loggingEnabled}
                    t={t}
                    tc={tc}
                    toggleDebugLogging={toggleDebugLogging}
                />
            </ScrollView>
        </SafeAreaView>
    );
}
