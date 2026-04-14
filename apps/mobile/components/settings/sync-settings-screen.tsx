import React, { useCallback, useEffect, useState } from 'react';
import Constants from 'expo-constants';
import { Alert, Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
    addBreadcrumb,
    CLOCK_SKEW_THRESHOLD_MS,
    cloudGetJson,
    type BackupValidation,
    type DgtImportParseResult,
    type ParsedDgtImportData,
    type ParsedTodoistProject,
    type TodoistImportParseResult,
    useTaskStore,
    webdavGetJson,
} from '@mindwtr/core';

import { useMobileSyncBadge } from '@/hooks/use-mobile-sync-badge';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useToast } from '@/contexts/toast-context';
import { pickAndParseSyncFolder } from '@/lib/storage-file';
import { getCloudKitAccountStatus, isCloudKitAvailable } from '@/lib/cloudkit-sync';
import {
    exportCurrentDataBackup,
    importDgtData,
    importTodoistData,
    inspectBackupDocument,
    inspectDgtDocument,
    inspectTodoistDocument,
    listLocalDataSnapshots,
    pickBackupDocument,
    pickDgtDocument,
    pickTodoistDocument,
    restoreDataFromBackup,
    restoreLocalDataSnapshot,
} from '@/lib/data-transfer';
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
import {
    classifySyncFailure,
    coerceSupportedBackend,
    getSyncConflictCount,
    getSyncMaxClockSkewMs,
    getSyncTimestampAdjustments,
    hasSameUserFacingSyncConflictSummary,
    isLikelyOfflineSyncError,
} from '@/lib/sync-service-utils';
import { testDropboxAccess } from '@/lib/dropbox-sync';
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
import { SettingsTopBar, SubHeader } from './settings.shell';
import { styles } from './settings.styles';

type SyncActionOptions = {
    backend?: 'file' | 'webdav' | 'cloud' | 'cloudkit';
    cloud?: SelfHostedSyncSettings;
    cloudProvider?: CloudProvider;
    webdav?: WebDavSyncSettings;
};

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

    const formatRecoverySnapshotLabel = (fileName: string): string => {
        const match = fileName.match(/^data\.(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.snapshot\.json$/i);
        if (!match) return fileName;
        const [, datePart, hour, minute, second] = match;
        const localDate = new Date(`${datePart}T${hour}:${minute}:${second}Z`);
        return Number.isFinite(localDate.getTime()) ? localDate.toLocaleString() : fileName;
    };

    const buildBackupSummary = (validation: Awaited<ReturnType<typeof inspectBackupDocument>>) => {
        const details = [
            validation.metadata?.backupAt
                ? localize(`Backup date: ${new Date(validation.metadata.backupAt).toLocaleString()}`, `备份时间：${new Date(validation.metadata.backupAt).toLocaleString()}`)
                : validation.metadata?.fileName
                    ? localize(`File: ${validation.metadata.fileName}`, `文件：${validation.metadata.fileName}`)
                    : null,
            localize(
                `Contains ${validation.metadata?.taskCount ?? 0} tasks and ${validation.metadata?.projectCount ?? 0} projects.`,
                `包含 ${(validation.metadata?.taskCount ?? 0)} 个任务和 ${(validation.metadata?.projectCount ?? 0)} 个项目。`
            ),
            localize(
                'This will replace all current local data. A recovery snapshot will be saved first.',
                '这将替换当前所有本地数据。系统会先保存一个恢复快照。'
            ),
            ...(validation.warnings.length > 0 ? ['', ...validation.warnings] : []),
        ].filter(Boolean);
        return details.join('\n');
    };

    const buildTodoistSummary = (preview: NonNullable<TodoistImportParseResult['preview']>) => {
        const projectLines = preview.projects
            .slice(0, 4)
            .map((project) => `• ${project.name}: ${project.taskCount}`);
        if (preview.projects.length > 4) {
            projectLines.push(localize(`• ${preview.projects.length - 4} more project(s)…`, `• 另外还有 ${preview.projects.length - 4} 个项目…`));
        }
        const details = [
            localize(
                `Import ${preview.taskCount} tasks from ${preview.projectCount} Todoist project(s)?`,
                `导入来自 ${preview.projectCount} 个 Todoist 项目的 ${preview.taskCount} 个任务？`
            ),
            preview.sectionCount > 0
                ? localize(`${preview.sectionCount} section(s) will be preserved.`, `${preview.sectionCount} 个分组将被保留。`)
                : null,
            preview.checklistItemCount > 0
                ? localize(`${preview.checklistItemCount} subtask(s) will become checklist items.`, `${preview.checklistItemCount} 个子任务会变成清单项。`)
                : null,
            localize(
                'Imported tasks stay in Inbox so you can process them in Mindwtr.',
                '导入后的任务会保留在收集箱中，方便你在 Mindwtr 里继续处理。'
            ),
            ...(projectLines.length > 0 ? ['', ...projectLines] : []),
            ...(preview.warnings.length > 0 ? ['', ...preview.warnings] : []),
        ].filter(Boolean);
        return details.join('\n');
    };

    const buildDgtSummary = (preview: NonNullable<DgtImportParseResult['preview']>) => {
        const projectLines = preview.projects
            .slice(0, 4)
            .map((project) => `• ${project.areaName ? `${project.areaName} / ` : ''}${project.name}: ${project.taskCount}`);
        if (preview.projects.length > 4) {
            projectLines.push(localize(`• ${preview.projects.length - 4} more project(s)…`, `• 另外还有 ${preview.projects.length - 4} 个项目…`));
        }
        const details = [
            localize(
                `Import ${preview.taskCount} tasks from ${preview.fileName}?`,
                `导入来自 ${preview.fileName} 的 ${preview.taskCount} 个任务？`
            ),
            preview.areaCount > 0
                ? localize(`${preview.areaCount} area(s) will be created from DGT folders.`, `${preview.areaCount} 个领域将从 DGT 文件夹创建。`)
                : null,
            preview.projectCount > 0
                ? localize(`${preview.projectCount} project(s) will be created.`, `${preview.projectCount} 个项目将被创建。`)
                : null,
            preview.checklistItemCount > 0
                ? localize(`${preview.checklistItemCount} checklist item(s) will be preserved.`, `${preview.checklistItemCount} 个清单项将被保留。`)
                : null,
            preview.standaloneTaskCount > 0
                ? localize(
                    `${preview.standaloneTaskCount} task(s) will stay outside projects so you can process them in Mindwtr.`,
                    `${preview.standaloneTaskCount} 个任务会保留在项目之外，方便你在 Mindwtr 中继续整理。`
                )
                : null,
            ...(projectLines.length > 0 ? ['', ...projectLines] : []),
            ...(preview.warnings.length > 0 ? ['', ...preview.warnings] : []),
        ].filter(Boolean);
        return details.join('\n');
    };

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

    const handleBackup = async () => {
        setBackupAction('export');
        try {
            await exportCurrentDataBackup({ tasks, projects, sections, areas, settings });
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(localize('Error', '错误'), localize('Failed to export backup', '导出备份失败'));
        } finally {
            setBackupAction(null);
        }
    };

    const confirmRestoreBackup = async (validation: BackupValidation) => {
        if (!validation.data) return;
        setBackupAction('restore');
        try {
            const { snapshotName } = await restoreDataFromBackup(validation.data);
            await refreshRecoverySnapshots();
            showToast({
                title: localize('Restore complete', '恢复完成'),
                message: localize(
                    `Backup restored successfully. Recovery snapshot saved as ${snapshotName}.`,
                    `备份恢复成功。恢复快照已保存为 ${snapshotName}。`
                ),
                tone: 'success',
                durationMs: 5000,
            });
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(localize('Restore failed', '恢复失败'), String(error), 5200);
        } finally {
            setBackupAction(null);
        }
    };

    const handleRestoreBackup = async () => {
        setBackupAction('restore');
        try {
            const document = await pickBackupDocument();
            if (!document) return;
            const validation = await inspectBackupDocument(document, {
                appVersion: Constants.expoConfig?.version ?? '0.0.0',
            });
            if (!validation.valid || !validation.data) {
                showSettingsWarning(
                    localize('Invalid backup', '无效备份'),
                    validation.errors[0] || localize('This file is not a valid Mindwtr backup.', '这不是有效的 Mindwtr 备份文件。')
                );
                return;
            }
            const summary = buildBackupSummary(validation);
            Alert.alert(
                localize('Restore backup?', '恢复备份？'),
                summary,
                [
                    { text: localize('Cancel', '取消'), style: 'cancel' },
                    {
                        text: localize('Restore', '恢复'),
                        style: 'destructive',
                        onPress: () => void confirmRestoreBackup(validation),
                    },
                ]
            );
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(localize('Restore failed', '恢复失败'), String(error), 5200);
        } finally {
            setBackupAction(null);
        }
    };

    const confirmTodoistImport = async (parsedProjects: ParsedTodoistProject[]) => {
        setBackupAction('import');
        try {
            const { snapshotName, result } = await importTodoistData(parsedProjects);
            await refreshRecoverySnapshots();
            const details = [
                localize(
                    `Imported ${result.importedTaskCount} tasks into ${result.importedProjectCount} project(s).`,
                    `已导入 ${result.importedProjectCount} 个项目中的 ${result.importedTaskCount} 个任务。`
                ),
                result.importedChecklistItemCount > 0
                    ? localize(
                        `${result.importedChecklistItemCount} subtask(s) became checklist items.`,
                        `${result.importedChecklistItemCount} 个子任务已转换为清单项。`
                    )
                    : null,
                localize(`Recovery snapshot saved as ${snapshotName}.`, `恢复快照已保存为 ${snapshotName}。`),
                ...(result.warnings.length > 0 ? ['', ...result.warnings] : []),
            ].filter(Boolean);
            showToast({
                title: localize('Import complete', '导入完成'),
                message: details.join('\n'),
                tone: 'success',
                durationMs: 5600,
            });
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(localize('Import failed', '导入失败'), String(error), 5200);
        } finally {
            setBackupAction(null);
        }
    };

    const confirmDgtImport = async (parsedData: ParsedDgtImportData) => {
        setBackupAction('import');
        try {
            const { snapshotName, result } = await importDgtData(parsedData);
            await refreshRecoverySnapshots();
            const details = [
                localize(
                    `Imported ${result.importedTaskCount} task(s), ${result.importedProjectCount} project(s), and ${result.importedAreaCount} area(s).`,
                    `已导入 ${result.importedTaskCount} 个任务、${result.importedProjectCount} 个项目和 ${result.importedAreaCount} 个领域。`
                ),
                result.importedChecklistItemCount > 0
                    ? localize(
                        `${result.importedChecklistItemCount} checklist item(s) were preserved.`,
                        `${result.importedChecklistItemCount} 个清单项已被保留。`
                    )
                    : null,
                localize(`Recovery snapshot saved as ${snapshotName}.`, `恢复快照已保存为 ${snapshotName}。`),
                ...(result.warnings.length > 0 ? ['', ...result.warnings] : []),
            ].filter(Boolean);
            showToast({
                title: localize('Import complete', '导入完成'),
                message: details.join('\n'),
                tone: 'success',
                durationMs: 6200,
            });
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(localize('Import failed', '导入失败'), String(error), 5200);
        } finally {
            setBackupAction(null);
        }
    };

    const handleImportTodoist = async () => {
        setBackupAction('import');
        try {
            const document = await pickTodoistDocument();
            if (!document) return;
            const parseResult = await inspectTodoistDocument(document);
            if (!parseResult.valid || !parseResult.preview) {
                showSettingsWarning(
                    localize('Import failed', '导入失败'),
                    parseResult.errors[0] || localize('The selected file is not a supported Todoist export.', '所选文件不是受支持的 Todoist 导出文件。')
                );
                return;
            }
            Alert.alert(
                localize('Import Todoist data?', '导入 Todoist 数据？'),
                buildTodoistSummary(parseResult.preview),
                [
                    { text: localize('Cancel', '取消'), style: 'cancel' },
                    {
                        text: localize('Import', '导入'),
                        onPress: () => void confirmTodoistImport(parseResult.parsedProjects),
                    },
                ]
            );
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(localize('Import failed', '导入失败'), String(error), 5200);
        } finally {
            setBackupAction(null);
        }
    };

    const handleImportDgt = async () => {
        setBackupAction('import');
        try {
            const document = await pickDgtDocument();
            if (!document) return;
            const parseResult = await inspectDgtDocument(document);
            if (!parseResult.valid || !parseResult.preview || !parseResult.parsedData) {
                showSettingsWarning(
                    localize('Import failed', '导入失败'),
                    parseResult.errors[0] || localize('The selected file is not a supported DGT GTD export.', '所选文件不是受支持的 DGT GTD 导出文件。')
                );
                return;
            }
            const parsedData = parseResult.parsedData;
            Alert.alert(
                localize('Import DGT GTD data?', '导入 DGT GTD 数据？'),
                buildDgtSummary(parseResult.preview),
                [
                    { text: localize('Cancel', '取消'), style: 'cancel' },
                    {
                        text: localize('Import', '导入'),
                        onPress: () => void confirmDgtImport(parsedData),
                    },
                ]
            );
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(localize('Import failed', '导入失败'), String(error), 5200);
        } finally {
            setBackupAction(null);
        }
    };

    const handleRestoreRecoverySnapshot = async (snapshotName: string) => {
        Alert.alert(
            localize('Restore recovery snapshot?', '恢复快照？'),
            localize(
                `Restore ${formatRecoverySnapshotLabel(snapshotName)}? This will replace current local data.`,
                `恢复 ${formatRecoverySnapshotLabel(snapshotName)}？这将替换当前本地数据。`
            ),
            [
                { text: localize('Cancel', '取消'), style: 'cancel' },
                {
                    text: localize('Restore', '恢复'),
                    style: 'destructive',
                    onPress: async () => {
                        setBackupAction('snapshot');
                        try {
                            await restoreLocalDataSnapshot(snapshotName);
                            await refreshRecoverySnapshots();
                            showToast({
                                title: localize('Restore complete', '恢复完成'),
                                message: localize('Recovery snapshot restored.', '恢复快照已恢复。'),
                                tone: 'success',
                            });
                        } catch (error) {
                            logSettingsError(error);
                            showSettingsErrorToast(localize('Restore failed', '恢复失败'), String(error), 5200);
                        } finally {
                            setBackupAction(null);
                        }
                    },
                },
            ]
        );
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
            showToast({
                title: t('settings.debugLogging'),
                message: t('settings.logMissing'),
                tone: 'warning',
            });
            return;
        }
        const Sharing = await import('expo-sharing');
        const canShare = await Sharing.isAvailableAsync();
        if (!canShare) {
            showToast({
                title: t('settings.debugLogging'),
                message: t('settings.shareUnavailable'),
                tone: 'warning',
            });
            return;
        }
        await Sharing.shareAsync(path, { mimeType: 'text/plain' });
    };

    const handleClearLog = async () => {
        await clearLog();
        showToast({
            title: t('settings.debugLogging'),
            message: t('settings.logCleared'),
            tone: 'success',
        });
    };

    const handleSetSyncPath = async () => {
        try {
            const result = await pickAndParseSyncFolder();
            if (result) {
                const fileUri = (result as { __fileUri: string }).__fileUri;
                const fileBookmark = (result as { __fileBookmark?: string }).__fileBookmark?.trim() ?? null;
                if (fileUri) {
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
                }
            }
        } catch (error) {
            logSettingsError(error);
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
            if (/temporary Inbox location|re-select a folder in Settings -> Data & Sync/i.test(message)) {
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
    };

    const handleConnectDropbox = async () => {
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
            logSettingsError(error);
            const message = formatError(error);
            if (/redirect[_\s-]?uri/i.test(message)) {
                showSettingsWarning(
                    localize('Invalid redirect URI', '回调地址无效'),
                    `${localize('Add this exact redirect URI in Dropbox OAuth settings.', '请在 Dropbox OAuth 设置里添加以下精确回调地址。')}\n\n${getDropboxRedirectUri()}`,
                    6000
                );
            } else {
                showSettingsErrorToast(localize('Connection failed', '连接失败'), message, 5200);
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
            showToast({
                title: localize('Disconnected', '已断开'),
                message: localize('Dropbox connection removed.', '已移除 Dropbox 连接。'),
                tone: 'success',
            });
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(localize('Disconnect failed', '断开失败'), formatError(error), 5200);
        } finally {
            setDropboxBusy(false);
        }
    };

    const handleTestDropboxConnection = async () => {
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
            logSettingsWarn('Dropbox connection test failed', error);
            if (isDropboxUnauthorizedSettingsError(error)) {
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
    };

    const handleSaveWebDavSettings = async (nextSettings: WebDavSyncSettings) => {
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
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(
                localize('Error', '错误'),
                localize('Failed to save WebDAV settings', '保存 WebDAV 设置失败')
            );
        }
    };

    const handleSaveSelfHostedSettings = async (nextSettings: SelfHostedSyncSettings) => {
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
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(
                localize('Error', '错误'),
                localize('Failed to save self-hosted settings', '保存自托管设置失败')
            );
        }
    };

    const handleSync = async (options?: SyncActionOptions) => {
        addBreadcrumb('sync:manual');
        setIsSyncing(true);
        try {
            const previousLastSyncStatus = settings.lastSyncStatus;
            const previousLastSyncStats = settings.lastSyncStats ?? null;
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
                    title: localize('Offline', '离线'),
                    message: localize('No internet connection. Sync skipped.', '当前无网络连接，已跳过同步。'),
                    tone: 'warning',
                });
                return;
            }
            if (result.skipped === 'requeued') {
                showToast({
                    title: localize('Sync queued', '已重新排队'),
                    message: localize('Local changes arrived during sync. A retry was queued automatically.', '同步期间检测到本地更改，已自动重新排队重试。'),
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
                        ? localize(
                            `Large device clock skew detected (${formatClockSkew(maxResultClockSkewMs)}). Check time settings on each device.`,
                            `检测到较大的设备时钟偏差（${formatClockSkew(maxResultClockSkewMs)}）。请检查各设备的时间设置。`
                        )
                        : null,
                    resultTimestampAdjustments > 0
                        ? localize(
                            `Adjusted ${resultTimestampAdjustments} future-dated timestamp${resultTimestampAdjustments === 1 ? '' : 's'} during sync.`,
                            `同步期间已调整 ${resultTimestampAdjustments} 个未来时间戳。`
                        )
                        : null,
                ].filter(Boolean);
                showToast({
                    title: localize('Success', '成功'),
                    message: [
                        conflictCount > 0 && !shouldSuppressDuplicateConflictNotice
                            ? localize(`Sync completed with ${conflictCount} conflicts (resolved automatically).`, `同步完成，发现 ${conflictCount} 个冲突（已自动处理）。`)
                            : localize('Sync completed!', '同步完成！'),
                        ...warningDetails,
                    ].join('\n\n'),
                    tone: conflictCount > 0 || warningDetails.length > 0 ? 'warning' : 'success',
                    durationMs: warningDetails.length > 0 || conflictCount > 0 ? 5200 : 3600,
                });
            } else {
                throw new Error(result.error || 'Unknown error');
            }
        } catch (error) {
            logSettingsError(error);
            const message = String(error);
            if (/temporary Inbox location|re-select a folder in Settings -> Data & Sync|Cannot access the selected sync file/i.test(message)) {
                showSettingsWarning(
                    localize('Unsupported cloud provider on iOS', 'iOS 云端提供商暂不支持'),
                    localize(
                        'The selected file came from a temporary iOS Files copy. Providers like Google Drive and OneDrive are not reliable for file sync here yet. Please go to Settings → Data & Sync, choose iCloud Drive, or switch to WebDAV.',
                        '当前选择的是 iOS“文件”提供的临时副本。Google Drive、OneDrive 等提供商暂不适合作为这里的文件同步目录。请前往「设置 → 数据与同步」，改选 iCloud Drive，或切换到 WebDAV。'
                    ),
                    5600
                );
                return;
            }
            showSettingsErrorToast(localize('Error', '错误'), getSyncFailureToastMessage(error));
        } finally {
            setIsSyncing(false);
        }
    };

    const handleTestConnection = async (backend: 'webdav' | 'cloud', options?: Omit<SyncActionOptions, 'backend'>) => {
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
                await webdavGetJson<unknown>(trimmedWebDavUrl.replace(/\/+$/, ''), {
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
            logSettingsWarn('Sync connection test failed', error);
            if (effectiveCloudProvider === 'dropbox' && isDropboxUnauthorizedSettingsError(error)) {
                setDropboxConnected(false);
            }
            showSettingsErrorToast(
                localize('Connection failed', '连接失败'),
                effectiveCloudProvider === 'dropbox' && isDropboxUnauthorizedSettingsError(error)
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
    };

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
