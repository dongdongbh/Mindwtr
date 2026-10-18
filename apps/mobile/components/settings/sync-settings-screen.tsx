import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { Alert, Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Beaker } from 'lucide-react-native';

import {
    updateSettingsFromLatest,
    getDocsGuideUrl,
    useTaskStore,
} from '@mindwtr/core';
import {
    buildSyncConflictLines,
    buildSyncPreferencesUpdate,
    buildSyncHistoryLines,
    getCloudKitStatusDetails as getCoreCloudKitStatusDetails,
    getSyncBackendCurrentLabel,
    getSyncBackendGroups,
    getSyncBackendOptionLabel,
    getSyncBackendOptions,
    getSyncFailureMessage,
    getSyncLastErrorText,
    getSyncLastStatusSummary,
    getSyncPreferenceValues,
    isSyncBackendOptionSelected,
    resolveSyncBackendSelection,
    type SyncPreferenceKey,
    type SyncSettingsBackendOption,
} from '@mindwtr/core/sync-settings-model';

import { useMobileSyncBadge } from '@/hooks/use-mobile-sync-badge';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useToast } from '@/contexts/toast-context';
import { CompactText } from '@/components/compact-text';
import { isCloudKitAvailable } from '@/lib/cloudkit-sync';
import {
    cleanupInterruptedBackupExport,
    listLocalDataSnapshots,
} from '@/lib/data-transfer';
import { getDropboxRedirectUri } from '@/lib/dropbox-oauth';
import {
    isDropboxClientConfigured,
} from '@/lib/dropbox-auth';
import {
    formatClockSkew,
    logSettingsError,
} from '@/lib/settings-utils';
import {
    isMobileAnalyticsHeartbeatConfigured,
    resetMobileAnalyticsOptOutMarker,
    resolveMobileAnalyticsVersion,
    sendMobileAnalyticsOptOut,
} from '@/lib/analytics-heartbeat';

import { SettingRow } from './setting-row';
import { ArchiveRetentionSection } from './archive-retention-section';
import { MobileExtraConfig } from './settings.constants';
import { AppleRemindersImportSection } from './apple-reminders-import-section';
import { useSettingsLocalization, useSettingsScrollContent } from './settings.hooks';
import { SyncCloudKitBackendPanel } from './sync-settings-cloudkit-panel';
import { SyncDropboxBackendPanel } from './sync-settings-dropbox-panel';
import { SyncEncryptionCard } from './sync-settings-encryption-card';
import { SyncFileBackendPanel } from './sync-settings-file-panel';
import {
    RecoverySnapshotsCard,
    SyncBackupSection,
    SyncDiagnosticsCard,
    SyncLastStatusCard,
    SyncPreferencesCard,
} from './sync-settings-sections';
import { SyncSelfHostedBackendPanel } from './sync-settings-selfhosted-panel';
import { SyncWebDavBackendPanel } from './sync-settings-webdav-panel';
import { useSyncSettingsBackupActions, type BackupAction } from './use-sync-settings-backup-actions';
import {
    useSyncSettingsStoreSlice,
    type SettingsScreenMode,
} from './use-sync-settings-store-slice';
import { useSyncSettingsTransportActions, type CloudKitAccountStatus } from './use-sync-settings-transport-actions';
import { MenuItem, SettingsGuideLink, SettingsTopBar } from './settings.shell';
import { styles } from './settings.styles';
import { reloadIntoMobileSandbox } from '@/lib/sandbox-workspace';
import { requestMobileSandboxEntry } from './sandbox-entry-confirmation';

type VisibleSyncBackendOption = SyncSettingsBackendOption;

function SyncSettingsView({
    mode,
    onboardingHandoff = false,
}: {
    mode: SettingsScreenMode;
    onboardingHandoff?: boolean;
}) {
    const router = useRouter();
    const tc = useThemeColors();
    const { showToast } = useToast();
    const { tr, t, language } = useSettingsLocalization();
    const scrollContentStyle = useSettingsScrollContent();
    const {
        tasks,
        projects,
        sections,
        areas,
        settings,
        addTask,
        seedGettingStarted,
        updateSettings,
    } = useSyncSettingsStoreSlice(mode);
    const extraConfig = Constants.expoConfig?.extra as MobileExtraConfig | undefined;
    const isFossBuild = extraConfig?.isFossBuild === true || extraConfig?.isFossBuild === 'true';
    const analyticsHeartbeatUrl = typeof extraConfig?.analyticsHeartbeatUrl === 'string'
        ? extraConfig.analyticsHeartbeatUrl.trim()
        : '';
    const analyticsHeartbeatChannel = typeof extraConfig?.analyticsHeartbeatChannel === 'string'
        ? extraConfig.analyticsHeartbeatChannel.trim()
        : '';
    const analyticsReleaseVersion = typeof extraConfig?.analyticsReleaseVersion === 'string'
        ? extraConfig.analyticsReleaseVersion.trim()
        : '';
    const appVersion = Constants.expoConfig?.version ?? '0.0.0';
    const analyticsAppVersion = resolveMobileAnalyticsVersion(appVersion, analyticsReleaseVersion);
    const dropboxAppKey = typeof extraConfig?.dropboxAppKey === 'string' ? extraConfig.dropboxAppKey.trim() : '';
    const dropboxConfigured = !isFossBuild && isDropboxClientConfigured(dropboxAppKey);
    const isExpoGo = Constants.appOwnership === 'expo';
    const supportsNativeICloudSync = Platform.OS === 'ios' && isCloudKitAvailable();
    const [syncOptionsOpen, setSyncOptionsOpen] = useState(false);
    const [syncHistoryExpanded, setSyncHistoryExpanded] = useState(false);
    const [backupAction, setBackupAction] = useState<BackupAction>(null);
    const [gettingStartedBusy, setGettingStartedBusy] = useState(false);
    const [recoverySnapshots, setRecoverySnapshots] = useState<string[]>([]);
    const [recoverySnapshotsOpen, setRecoverySnapshotsOpen] = useState(false);
    const [isLoadingRecoverySnapshots, setIsLoadingRecoverySnapshots] = useState(false);
    const [sandboxBusy, setSandboxBusy] = useState(false);
    const [sandboxFailed, setSandboxFailed] = useState(false);
    const [appleRemindersBusy, setAppleRemindersBusy] = useState(false);
    const { refreshSyncBadgeConfig } = useMobileSyncBadge();

    const {
        appearance: syncAppearanceEnabled,
        language: syncLanguageEnabled,
        gtd: syncGtdEnabled,
        savedFilters: syncSavedFiltersEnabled,
        externalCalendars: syncExternalCalendarsEnabled,
        ai: syncAiEnabled,
    } = getSyncPreferenceValues(settings.syncPreferences);
    const {
        lastSyncStats,
        showLastSyncStats,
        conflictCount: syncConflictCount,
        maxClockSkewMs,
        timestampAdjustments,
        conflictIds,
    } = getSyncLastStatusSummary(settings);
    const conflictLines = useMemo(() => {
        const state = useTaskStore.getState();
        return buildSyncConflictLines(lastSyncStats, {
            tasks: state._allTasks,
            projects: state._allProjects,
            sections: state._allSections,
            areas: state._allAreas,
            people: state._allPeople,
        }, t);
    }, [lastSyncStats, t]);
    const loggingEnabled = settings.diagnostics?.loggingEnabled === true;
    const analyticsHeartbeatAvailable = isMobileAnalyticsHeartbeatConfigured({
        analyticsHeartbeatUrl,
        isExpoGo,
        isFossBuild,
    });
    const analyticsHeartbeatEnabled = analyticsHeartbeatAvailable && settings.analytics?.heartbeatEnabled !== false;
    const analyticsHeartbeatOptedOut = analyticsHeartbeatAvailable && !analyticsHeartbeatEnabled;
    const pendingRemoteDeleteCount = settings.attachments?.pendingRemoteDeletes?.length ?? 0;
    const isBackupBusy = backupAction !== null;
    const backendGroups = getSyncBackendGroups({ t, isFossBuild, supportsCloudKit: supportsNativeICloudSync });
    const backendControlOptions: VisibleSyncBackendOption[] = getSyncBackendOptions(backendGroups);
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
    const getSyncFailureToastMessage = useCallback((error: unknown) => getSyncFailureMessage(error, t), [t]);

    const resetSyncStatusForBackendSwitch = useCallback(() => {
        updateSettings({
            lastSyncStatus: 'idle',
            lastSyncError: undefined,
        }).catch(logSettingsError);
    }, [updateSettings]);

    const updateSyncPreferences = (partial: Partial<Record<SyncPreferenceKey, boolean>>) => {
        // Built from the latest stored preferences, so one another device changed stays.
        updateSettingsFromLatest((latest) => buildSyncPreferencesUpdate(latest.syncPreferences, partial), { write: updateSettings, read: () => useTaskStore.getState().settings })
            .catch(logSettingsError);
    };

    const handleClearPendingRemoteDeletes = useCallback(() => {
        if (pendingRemoteDeleteCount === 0) return;
        Alert.alert(
            tr('settings.syncMobile.clearPendingAttachmentDeletes'),
            tr('settings.syncMobile.onlyClearTheseIfYouNoLongerWantMindwtrTo'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: tr('filters.clear'),
                    style: 'destructive',
                    onPress: () => {
                        updateSettingsFromLatest((latest) => ({
                            attachments: {
                                ...(latest.attachments ?? {}),
                                pendingRemoteDeletes: undefined,
                            },
                        }), { write: updateSettings, read: () => useTaskStore.getState().settings }).catch(logSettingsError);
                    },
                },
            ],
        );
    }, [tr, pendingRemoteDeleteCount, t, updateSettings]);

    const toggleAnalyticsHeartbeatOptOut = useCallback((optedOut: boolean) => {
        if (!analyticsHeartbeatAvailable) return;
        const enabled = !optedOut;
        const saveSetting = () => {
            updateSettings({
                analytics: {
                    ...(settings.analytics ?? {}),
                    heartbeatEnabled: enabled,
                },
            })
                .then(async () => {
                    if (enabled) {
                        await resetMobileAnalyticsOptOutMarker();
                        return;
                    }
                    await sendMobileAnalyticsOptOut({
                        analyticsHeartbeatUrl,
                        analyticsHeartbeatChannel,
                        appVersion: analyticsAppVersion,
                        isExpoGo,
                        isFossBuild,
                    });
                })
                .catch(logSettingsError);
        };

        if (!optedOut) {
            saveSetting();
            return;
        }

        Alert.alert(
            t('settings.analyticsHeartbeatDisableTitle'),
            t('settings.analyticsHeartbeatDisableDesc'),
            [
                { text: t('settings.analyticsHeartbeatKeepEnabled'), style: 'cancel' },
                {
                    text: t('settings.analyticsHeartbeatDisableConfirm'),
                    onPress: saveSetting,
                },
            ],
        );
    }, [
        analyticsHeartbeatAvailable,
        analyticsHeartbeatChannel,
        analyticsHeartbeatUrl,
        analyticsAppVersion,
        isExpoGo,
        isFossBuild,
        settings.analytics,
        t,
        updateSettings,
    ]);

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

    // A backup a process death cut short while it was written into a picked folder is removed when Data opens again.
    useEffect(() => {
        if (mode === 'data') void cleanupInterruptedBackupExport();
    }, [mode]);

    const renderSyncHistory = () => {
        if (syncHistoryEntries.length === 0) return null;
        return (
            <View style={{ marginTop: 6 }}>
                <TouchableOpacity onPress={() => setSyncHistoryExpanded((value) => !value)} activeOpacity={0.7}>
                    <Text style={[styles.settingDescription, { color: tc.secondaryText, fontWeight: '600' }]}>
                        {t('settings.syncHistory')} ({syncHistoryEntries.length}) {syncHistoryExpanded ? '▾' : '▸'}
                    </Text>
                </TouchableOpacity>
                {syncHistoryExpanded && syncHistoryEntries.map((line, index) => (
                    <Text key={`${index}-${line}`} style={[styles.settingDescription, { color: tc.secondaryText }]}>
                        {line}
                    </Text>
                ))}
            </View>
        );
    };

    const getCloudKitStatusDetails = useCallback((status: CloudKitAccountStatus) => getCoreCloudKitStatusDetails(status, tr), [tr]);

    const {
        formatRecoverySnapshotLabel,
        handleBackup,
        handleExportCsv,
        handleExportTaskNotes,
        handleClearLog,
        handleImportDgt,
        handleImportMindwtrCsv,
        handleImportOmniFocus,
        handleImportTickTick,
        handleImportTodoist,
        handleMergeBackup,
        handleRestoreBackup,
        handleRestoreRecoverySnapshot,
        handleShareLog,
        toggleDebugLogging,
    } = useSyncSettingsBackupActions({
        tr,
        refreshRecoverySnapshots,
        settings,
        setBackupAction,
        showSettingsErrorToast,
        showSettingsWarning,
        showToast,
        t,
        updateSettings,
    });
    const {
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
        handleSelectCloudProvider,
        handleSelectSyncBackend,
        handleSaveWebDavSettings,
        handleSetSyncPath,
        handleSync,
        handleTestConnection,
        handleTestDropboxConnection,
        isSyncing,
        isTestingConnection,
        redactText,
        syncBackend,
        syncPath,
        webdavPassword,
        webdavAllowInsecureHttp,
        webdavUrl,
        webdavUsername,
    } = useSyncSettingsTransportActions({
        dropboxAppKey,
        dropboxConfigured,
        getCloudKitStatusDetails,
        getSyncFailureToastMessage,
        isExpoGo,
        isFossBuild,
        lastSyncStats,
        lastSyncStatus: settings.lastSyncStatus,
        tr,
        resetSyncStatusForBackendSwitch,
        showSettingsErrorToast,
        showSettingsWarning,
        showToast,
        supportsNativeICloudSync,
        t,
    });
    // The history and the last error drop URL credentials and the configured secrets.
    const syncHistoryEntries = buildSyncHistoryLines(settings.lastSyncHistory, t, (at) => new Date(at).toLocaleString(), redactText);
    const isGettingStartedActionBusy = gettingStartedBusy || isBackupBusy || isSyncing;
    const sandboxEntryBlocked = sandboxBusy
        || isBackupBusy
        || isSyncing
        || gettingStartedBusy
        || appleRemindersBusy;
    const sandboxEntryBlockedRef = React.useRef(sandboxEntryBlocked);
    sandboxEntryBlockedRef.current = sandboxEntryBlocked;
    const {
        isCloudSyncSelected,
        isSelfHostedSyncSelected,
        isDropboxSyncSelected,
        isCloudKitSyncSelected,
        isEncryptionCapableBackend,
    } = resolveSyncBackendSelection({ syncBackend, cloudProvider, isFossBuild, supportsCloudKit: supportsNativeICloudSync });
    const backendSelection = { isCloudSyncSelected, isSelfHostedSyncSelected, isDropboxSyncSelected, isCloudKitSyncSelected, isEncryptionCapableBackend };
    // The attachment worklist a transition converts is derived from this document —
    // without it, phase 2 leaves every attachment in plaintext.
    const encryptionAppData = useMemo(
        () => ({ tasks, projects, sections, areas, settings }),
        [areas, projects, sections, settings, tasks],
    );
    const cloudKitStatusDetails = getCloudKitStatusDetails(cloudKitAccountStatus);
    const addGettingStartedContent = useCallback((options?: { openProject?: boolean }) => {
        if (isGettingStartedActionBusy) return;
        setGettingStartedBusy(true);
        seedGettingStarted({ language })
            .then((result) => {
                if (!result.id) {
                    showToast({
                        message: t('onboarding.toastNotCreated'),
                        tone: 'info',
                    });
                    return;
                }
                if (options?.openProject) {
                    router.push({ pathname: '/projects-screen', params: { projectId: result.id } } as never);
                }
                showToast({
                    message: t('onboarding.toastReady'),
                    tone: 'success',
                    actionLabel: options?.openProject ? undefined : t('common.open'),
                    onAction: options?.openProject
                        ? undefined
                        : () => {
                            router.push({ pathname: '/projects-screen', params: { projectId: result.id } } as never);
                        },
                });
            })
            .catch((error) => {
                logSettingsError(error);
                showToast({
                    message: t('onboarding.toastFailed'),
                    tone: 'error',
                });
            })
            .finally(() => setGettingStartedBusy(false));
    }, [isGettingStartedActionBusy, language, router, seedGettingStarted, showToast, t]);

    const handleAddGettingStartedContent = useCallback((options?: { openProject?: boolean }) => {
        addGettingStartedContent(options);
    }, [addGettingStartedContent]);
    const onboardingHandoffCard = onboardingHandoff ? (
        <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginBottom: 12 }]}>
            <View style={styles.settingRowColumn}>
                <Text style={[styles.settingLabel, { color: tc.text }]}>
                    {t('settings.gettingStartedContentContinueTitle')}
                </Text>
                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                    {t('settings.gettingStartedContentContinueDesc')}
                </Text>
                <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityState={{
                        busy: gettingStartedBusy,
                        disabled: isGettingStartedActionBusy,
                    }}
                    activeOpacity={0.78}
                    disabled={isGettingStartedActionBusy}
                    onPress={() => handleAddGettingStartedContent({ openProject: true })}
                    style={[
                        styles.backendOption,
                        {
                            alignSelf: 'flex-start',
                            backgroundColor: isGettingStartedActionBusy ? tc.filterBg : tc.tint,
                            borderColor: isGettingStartedActionBusy ? tc.border : tc.tint,
                            marginTop: 12,
                        },
                    ]}
                    testID="mobile-onboarding-start-fresh-handoff"
                >
                    <Text
                        style={[
                            styles.backendOptionText,
                            { color: isGettingStartedActionBusy ? tc.secondaryText : tc.onTint },
                        ]}
                    >
                        {gettingStartedBusy ? t('common.loading') : t('onboarding.startFreshTitle')}
                    </Text>
                </TouchableOpacity>
            </View>
        </View>
    ) : null;
    const getBackendOptionLabel = useCallback((option: VisibleSyncBackendOption): string => getSyncBackendOptionLabel(option, t), [t]);
    const isBackendOptionSelected = (option: VisibleSyncBackendOption): boolean => (
        isSyncBackendOptionSelected(option, syncBackend, backendSelection)
    );
    const selectedBackendGroup = backendGroups.find((group) =>
        group.options.some((option) => isBackendOptionSelected(option))
    );
    const handleSelectVisibleBackend = useCallback((option: VisibleSyncBackendOption) => {
        switch (option) {
            case 'dropbox':
                handleSelectCloudProvider('dropbox');
                return;
            case 'selfhosted':
                handleSelectCloudProvider('selfhosted');
                return;
            case 'cloudkit':
                handleSelectCloudProvider('cloudkit');
                return;
            default:
                handleSelectSyncBackend(option);
        }
    }, [handleSelectCloudProvider, handleSelectSyncBackend]);
    const dataLabel = t('settings.data');

    useEffect(() => {
        void refreshSyncBadgeConfig();
    }, [
        cloudProvider,
        cloudToken,
        cloudUrl,
        refreshSyncBadgeConfig,
        settings.lastSyncAt,
        settings.lastSyncStatus,
        settings.pendingRemoteWriteAt,
        syncBackend,
        syncPath,
        webdavUrl,
    ]);

    const lastSyncCard = (
        <SyncLastStatusCard
            conflictCount={syncConflictCount}
            conflictIds={conflictIds}
            conflictLines={conflictLines}
            historyContent={renderSyncHistory()}
            lastSyncAt={settings.lastSyncAt}
            lastSyncError={getSyncLastErrorText(settings.lastSyncError, t, redactText)}
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
            <SettingsTopBar title={mode === 'sync' ? t('settings.sync') : dataLabel} />
            <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                {onboardingHandoffCard}
                {mode === 'sync' ? (
                    <>
                        <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginBottom: 12 }]}>
                            <View style={styles.settingRowColumn}>
                                <View style={styles.settingInfo}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.syncBackend')}</Text>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                        {getSyncBackendCurrentLabel(syncBackend, backendSelection, t)}
                                    </Text>
                                </View>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText, marginTop: 8 }]}>
                                    {t('settings.syncBackendChoiceHint')}
                                </Text>
                                <View style={[styles.backendToggle, { marginTop: 10, width: '100%' }]}>
                                    {backendControlOptions.map((backend) => {
                                        const selected = isBackendOptionSelected(backend);
                                        return (
                                            <TouchableOpacity
                                                key={backend}
                                                style={[
                                                    styles.backendOption,
                                                    {
                                                        borderColor: selected ? tc.tint : tc.border,
                                                        backgroundColor: selected ? tc.filterBg : 'transparent',
                                                    },
                                                ]}
                                                onPress={() => {
                                                    handleSelectVisibleBackend(backend);
                                                }}
                                            >
                                                <CompactText
                                                    style={[
                                                        styles.backendOptionText,
                                                        { color: selected ? tc.tint : tc.secondaryText },
                                                    ]}
                                                    numberOfLines={2}
                                                >
                                                    {getBackendOptionLabel(backend)}
                                                </CompactText>
                                            </TouchableOpacity>
                                        );
                                    })}
                                </View>
                                {selectedBackendGroup && (
                                    <View style={{ gap: 4, marginTop: 12 }}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>
                                            {selectedBackendGroup.title}
                                        </Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                            {selectedBackendGroup.description}
                                        </Text>
                                    </View>
                                )}
                            </View>
                        </View>

                        <SettingsGuideLink
                            title={t('settings.syncSetupGuideTitle')}
                            description={t('settings.syncSetupGuideDesc')}
                            url={getDocsGuideUrl('data-sync/', language)}
                            testID="sync-guide-link"
                        />

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
                                tr={tr}
                                onSelectFolder={() => void handleSetSyncPath()}
                                onSync={() => void handleSync({ backend: 'file' })}
                                syncPath={syncPath}
                                t={t}
                                tc={tc}
                            />
                        )}

                        {syncBackend === 'webdav' && (
                            <SyncWebDavBackendPanel
                                initialAllowInsecureHttp={webdavAllowInsecureHttp}
                                initialPassword={webdavPassword}
                                initialUrl={webdavUrl}
                                initialUsername={webdavUsername}
                                isSyncing={isSyncing}
                                isTestingConnection={isTestingConnection}
                                lastSyncCard={lastSyncCard}
                                onSave={(settings) => void handleSaveWebDavSettings(settings)}
                                onSync={(settings) => void handleSync({ backend: 'webdav', webdav: settings })}
                                onTestConnection={(settings) => void handleTestConnection('webdav', { webdav: settings })}
                                t={t}
                                tc={tc}
                            />
                        )}

                        {isCloudSyncSelected && (
                            <>
                                {isCloudKitSyncSelected ? (
                                    <SyncCloudKitBackendPanel
                                        helpText={cloudKitStatusDetails.helpText}
                                        isSyncEnabled={cloudKitStatusDetails.syncEnabled}
                                        isSyncing={isSyncing}
                                        lastSyncCard={lastSyncCard}
                                        tr={tr}
                                        onSync={() => void handleSync({ backend: 'cloudkit', cloudProvider: 'cloudkit' })}
                                        statusLabel={cloudKitStatusDetails.label}
                                        t={t}
                                        tc={tc}
                                    />
                                ) : isSelfHostedSyncSelected ? (
                                    <SyncSelfHostedBackendPanel
                                        initialAllowInsecureHttp={cloudAllowInsecureHttp}
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
                                ) : isDropboxSyncSelected ? (
                                    <SyncDropboxBackendPanel
                                        dropboxBusy={dropboxBusy}
                                        dropboxConfigured={dropboxConfigured}
                                        dropboxConnected={dropboxConnected}
                                        isExpoGo={isExpoGo}
                                        isSyncing={isSyncing}
                                        isTestingConnection={isTestingConnection}
                                        lastSyncCard={lastSyncCard}
                                        tr={tr}
                                        onConnectToggle={() => void (dropboxConnected ? handleDisconnectDropbox() : handleConnectDropbox())}
                                        onSync={() => void handleSync({ backend: 'cloud', cloudProvider: 'dropbox' })}
                                        onTestConnection={() => void handleTestDropboxConnection()}
                                        redirectUri={getDropboxRedirectUri()}
                                        t={t}
                                        tc={tc}
                                    />
                                ) : null}
                            </>
                        )}

                        {isEncryptionCapableBackend && (
                            <SyncEncryptionCard appData={encryptionAppData} t={t} tc={tc} language={language} transportBusy={isSyncing || isTestingConnection || dropboxBusy} />
                        )}

                        <SyncPreferencesCard
                            syncAiEnabled={syncAiEnabled}
                            syncAppearanceEnabled={syncAppearanceEnabled}
                            syncExternalCalendarsEnabled={syncExternalCalendarsEnabled}
                            syncGtdEnabled={syncGtdEnabled}
                            syncLanguageEnabled={syncLanguageEnabled}
                            syncSavedFiltersEnabled={syncSavedFiltersEnabled}
                            syncOptionsOpen={syncOptionsOpen}
                            t={t}
                            tc={tc}
                            toggleSyncOptionsOpen={() => setSyncOptionsOpen((prev) => !prev)}
                            updateSyncPreferences={updateSyncPreferences}
                        />

                        <RecoverySnapshotsCard
                            backupAction={backupAction}
                            formatRecoverySnapshotLabel={formatRecoverySnapshotLabel}
                            handleRestoreRecoverySnapshot={(snapshot) => void handleRestoreRecoverySnapshot(snapshot)}
                            isBackupBusy={isBackupBusy}
                            isLoadingRecoverySnapshots={isLoadingRecoverySnapshots}
                            isSyncing={isSyncing}
                            tr={tr}
                            recoverySnapshots={recoverySnapshots}
                            recoverySnapshotsOpen={recoverySnapshotsOpen}
                            setRecoverySnapshotsOpen={setRecoverySnapshotsOpen}
                            t={t}
                            tc={tc}
                        />
                    </>
                ) : (
                    <>
                        <SyncBackupSection
                            backupAction={backupAction}
                            handleAddGettingStartedContent={() => handleAddGettingStartedContent()}
                            handleBackup={() => void handleBackup()}
                            handleExportCsv={() => void handleExportCsv()}
                            handleExportTaskNotes={() => void handleExportTaskNotes()}
                            handleImportDgt={() => void handleImportDgt()}
                            handleImportMindwtrCsv={() => void handleImportMindwtrCsv()}
                            handleImportOmniFocus={() => void handleImportOmniFocus()}
                            handleImportTickTick={() => void handleImportTickTick()}
                            handleImportTodoist={() => void handleImportTodoist()}
                            handleMergeBackup={() => void handleMergeBackup()}
                            handleRestoreBackup={() => void handleRestoreBackup()}
                            importGuide={(
                                <SettingsGuideLink
                                    title={t('settings.importSetupGuideTitle')}
                                    description={t('settings.importSetupGuideDesc')}
                                    url={getDocsGuideUrl('import/', language)}
                                    style={{ marginBottom: 0 }}
                                    testID="import-guide-link"
                                />
                            )}
                            isBackupBusy={isBackupBusy}
                            isGettingStartedDisabled={isGettingStartedActionBusy}
                            isGettingStartedBusy={gettingStartedBusy}
                            isSyncing={isSyncing}
                            tr={tr}
                            t={t}
                            tc={tc}
                        />

                        <AppleRemindersImportSection
                            addTask={addTask}
                            disabled={isBackupBusy || isSyncing}
                            onBusyChange={setAppleRemindersBusy}
                            showToast={showToast}
                            tr={tr}
                            tc={tc}
                        />

                        <ArchiveRetentionSection />

                        <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 16 }]}>
                            <SettingRow
                                label={tr('settings.syncMobile.pendingRemoteDeletes')}
                                description={String(pendingRemoteDeleteCount)}
                            >
                                <TouchableOpacity
                                    disabled={pendingRemoteDeleteCount === 0}
                                    onPress={handleClearPendingRemoteDeletes}
                                    style={{ opacity: pendingRemoteDeleteCount === 0 ? 0.45 : 1 }}
                                >
                                    <CompactText
                                        style={[styles.linkText, { color: pendingRemoteDeleteCount === 0 ? tc.secondaryText : tc.tint }]}
                                        numberOfLines={2}
                                    >
                                        {tr('filters.clear')}
                                    </CompactText>
                                </TouchableOpacity>
                            </SettingRow>
                        </View>

                        <View style={[styles.menuCard, { backgroundColor: tc.cardBg, marginTop: 16 }]}>
                            <MenuItem
                                title={sandboxBusy ? t('sandbox.switching') : t('sandbox.open')}
                                description={sandboxFailed ? t('sandbox.switchFailed') : t('sandbox.description')}
                                icon={Beaker}
                                isLast
                                disabled={sandboxEntryBlocked}
                                onPress={() => {
                                    requestMobileSandboxEntry(t, () => {
                                        setSandboxBusy(true);
                                        setSandboxFailed(false);
                                        void reloadIntoMobileSandbox().catch(() => {
                                            setSandboxBusy(false);
                                            setSandboxFailed(true);
                                        });
                                    }, () => sandboxEntryBlockedRef.current);
                                }}
                            />
                        </View>

                        <SyncDiagnosticsCard
                            analyticsHeartbeatAvailable={analyticsHeartbeatAvailable}
                            analyticsHeartbeatOptedOut={analyticsHeartbeatOptedOut}
                            handleClearLog={() => void handleClearLog()}
                            handleShareLog={() => void handleShareLog()}
                            loggingEnabled={loggingEnabled}
                            toggleAnalyticsHeartbeatOptOut={toggleAnalyticsHeartbeatOptOut}
                            t={t}
                            tc={tc}
                            toggleDebugLogging={toggleDebugLogging}
                        />
                    </>
                )}
            </ScrollView>
        </SafeAreaView>
    );
}

export function SyncSettingsScreen({ onboardingHandoff = false }: { onboardingHandoff?: boolean }) {
    return <SyncSettingsView mode="sync" onboardingHandoff={onboardingHandoff} />;
}

export function DataSettingsScreen({ onboardingHandoff = false }: { onboardingHandoff?: boolean }) {
    return <SyncSettingsView mode="data" onboardingHandoff={onboardingHandoff} />;
}
