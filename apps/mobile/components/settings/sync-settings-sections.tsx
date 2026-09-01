import type { ReactNode } from 'react';
import React from 'react';
import { ActivityIndicator, Switch, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { translateWithFallback } from '@mindwtr/core';

import type { ThemeColors } from '@/hooks/use-theme-colors';
import { CompactText } from '@/components/compact-text';
import { MOBILE_BACKGROUND_SYNC_INTERVAL_OPTIONS, type BackgroundSyncInterval } from '@/lib/sync-constants';
import type { BackupAction } from './use-sync-settings-backup-actions';

import { styles } from './settings.styles';

type Translate = (key: string) => string;
type SettingsTranslator = (key: string, values?: Record<string, string | number | boolean | null | undefined>) => string;

function renderDecorativeActivityIndicator(color: string) {
  return (
    <ActivityIndicator
      size="small"
      color={color}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}

type SyncLastStatusCardProps = {
  conflictCount: number;
  conflictIds: string[];
  conflictLines: string[];
  historyContent?: ReactNode;
  lastSyncAt?: string;
  lastSyncError?: string;
  lastSyncStatus?: 'idle' | 'syncing' | 'success' | 'error' | 'conflict';
  maxClockSkewLabel?: string;
  showLastSyncStats: boolean;
  t: Translate;
  tc: ThemeColors;
  timestampAdjustments: number;
};

export function SyncLastStatusCard({
  conflictCount,
  conflictIds,
  conflictLines,
  historyContent,
  lastSyncAt,
  lastSyncError,
  lastSyncStatus,
  maxClockSkewLabel,
  showLastSyncStats,
  t,
  tc,
  timestampAdjustments,
}: SyncLastStatusCardProps) {
  return (
    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
      <View style={styles.settingRow}>
        <View style={styles.settingInfo}>
          <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.lastSync')}</Text>
          <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
            {lastSyncAt ? new Date(lastSyncAt).toLocaleString() : t('settings.lastSyncNever')}
            {lastSyncStatus === 'error' && t('settings.syncStatusFailedSuffix')}
            {lastSyncStatus === 'conflict' && t('settings.syncStatusConflictsSuffix')}
          </Text>
          {showLastSyncStats && (
            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
              {t('settings.lastSyncConflicts')}: {conflictCount}
            </Text>
          )}
          {showLastSyncStats && maxClockSkewLabel && (
            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
              {t('settings.lastSyncSkew')}: {maxClockSkewLabel}
            </Text>
          )}
          {showLastSyncStats && timestampAdjustments > 0 && (
            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
              {t('settings.lastSyncAdjusted')}: {timestampAdjustments}
            </Text>
          )}
          {showLastSyncStats && conflictLines.map((line, index) => (
            <Text key={`${index}-${line}`} style={[styles.settingDescription, { color: tc.secondaryText }]}>
              {line}
            </Text>
          ))}
          {showLastSyncStats && conflictLines.length === 0 && conflictIds.length > 0 && (
            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
              {t('settings.lastSyncConflictIds')}: {conflictIds.join(', ')}
            </Text>
          )}
          {lastSyncStatus === 'error' && lastSyncError && (
            <Text style={[styles.settingDescription, { color: tc.danger }]}>{lastSyncError}</Text>
          )}
          {historyContent}
        </View>
      </View>
    </View>
  );
}

const BACKGROUND_SYNC_INTERVAL_LABEL_KEYS: Record<BackgroundSyncInterval, string> = {
  off: 'settings.syncMobile.backgroundSyncIntervalOff',
  '15m': 'settings.syncMobile.backgroundSyncIntervalEvery15Minutes',
  '1h': 'settings.syncMobile.backgroundSyncIntervalEveryHour',
  '6h': 'settings.syncMobile.backgroundSyncIntervalEvery6Hours',
};

type BackgroundSyncInfoCardProps = {
  interval: BackgroundSyncInterval;
  isRemoteBackend: boolean;
  onSelectInterval: (interval: BackgroundSyncInterval) => void;
  tr: SettingsTranslator;
  tc: ThemeColors;
};

export function BackgroundSyncInfoCard({
  interval,
  isRemoteBackend,
  onSelectInterval,
  tr,
  tc,
}: BackgroundSyncInfoCardProps) {
  return (
    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 16 }]}>
      <View style={styles.settingRowColumn}>
        <View>
          <Text style={[styles.settingLabel, { color: tc.text }]}>
            {tr('settings.syncMobile.backgroundSync')}
          </Text>
          <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
            {isRemoteBackend
              ? tr('settings.syncMobile.backgroundSyncIntervalDescription')
              : tr('settings.syncMobile.scheduledBackgroundSyncIsAvailableForWebdavSelfHostedCloud')}
          </Text>
        </View>
        {isRemoteBackend && (
          <>
            <Text style={[styles.settingLabel, { color: tc.text, marginTop: 12 }]}>
              {tr('settings.syncMobile.backgroundSyncInterval')}
            </Text>
            <View style={[styles.gtdSegmentedControl, { backgroundColor: tc.bg, borderColor: tc.border, marginTop: 8 }]}>
              {MOBILE_BACKGROUND_SYNC_INTERVAL_OPTIONS.map((option) => {
                const selected = interval === option;
                return (
                  <TouchableOpacity
                    key={option}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    style={[
                      styles.gtdSegmentedOption,
                      { backgroundColor: selected ? tc.filterBg : 'transparent' },
                    ]}
                    onPress={() => onSelectInterval(option)}
                    activeOpacity={0.8}
                  >
                    <CompactText
                      style={[styles.gtdSegmentedOptionText, { color: selected ? tc.tint : tc.secondaryText }]}
                      numberOfLines={2}
                    >
                      {tr(BACKGROUND_SYNC_INTERVAL_LABEL_KEYS[option])}
                    </CompactText>
                  </TouchableOpacity>
                );
              })}
            </View>
          </>
        )}
      </View>
    </View>
  );
}

type SyncBackupSectionProps = {
  backupAction: BackupAction;
  handleAddGettingStartedContent: () => void;
  handleBackup: () => void;
  handleExportCsv: () => void;
  handleExportTaskNotes: () => void;
  handleImportDgt: () => void;
  handleImportMindwtrCsv: () => void;
  handleImportOmniFocus: () => void;
  handleImportTickTick: () => void;
  handleImportTodoist: () => void;
  handleMergeBackup: () => void;
  handleRestoreBackup: () => void;
  // The screen owns the docs URL, so it passes the rendered link in rather than
  // this module reaching into the settings shell for SettingsGuideLink.
  importGuide?: ReactNode;
  isBackupBusy: boolean;
  isGettingStartedDisabled: boolean;
  isGettingStartedBusy: boolean;
  isSyncing: boolean;
  tr: SettingsTranslator;
  t: Translate;
  tc: ThemeColors;
};

// Two folded cards, matching desktop's Data page: restoring a backup and
// migrating from another app are unrelated errands, and both are rare enough to
// stay folded until asked for (same disclosure shape as the recovery snapshots
// card below). The cards title themselves, so there is no outer section header.
export function SyncBackupSection({
  backupAction,
  handleAddGettingStartedContent,
  handleBackup,
  handleExportCsv,
  handleExportTaskNotes,
  handleImportDgt,
  handleImportMindwtrCsv,
  handleImportOmniFocus,
  handleImportTickTick,
  handleImportTodoist,
  handleMergeBackup,
  handleRestoreBackup,
  importGuide,
  isBackupBusy,
  isGettingStartedDisabled,
  isGettingStartedBusy,
  isSyncing,
  tr,
  t,
  tc,
}: SyncBackupSectionProps) {
  const [backupOpen, setBackupOpen] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);

  return (
    <>
      <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 24 }]}>
        <TouchableOpacity
          style={[styles.gtdNavigationRow, { borderTopWidth: 0 }]}
          onPress={() => setBackupOpen((prev) => !prev)}
          accessibilityRole="button"
          accessibilityState={{ expanded: backupOpen }}
          activeOpacity={0.75}
          testID="backup-disclosure"
        >
          <View style={styles.settingInfo}>
            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.backup')}</Text>
            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
              {t('settings.backupDesc')}
            </Text>
          </View>
          <Ionicons
            name={backupOpen ? 'chevron-up' : 'chevron-down'}
            size={18}
            color={tc.secondaryText}
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          />
        </TouchableOpacity>
        {backupOpen && (
        <>
          <TouchableOpacity
            style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
            onPress={handleBackup}
            disabled={isSyncing || isBackupBusy}
            accessibilityRole="button"
            accessibilityLabel={t('settings.exportBackup')}
            accessibilityHint={t('settings.saveToSyncFolder')}
            accessibilityState={{ busy: backupAction === 'export', disabled: isSyncing || isBackupBusy }}
            testID="data-transfer-export"
          >
            <View style={styles.settingInfo}>
              <Text style={[styles.settingLabel, { color: '#3B82F6' }]}>{t('settings.exportBackup')}</Text>
              <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.saveToSyncFolder')}</Text>
            </View>
            {backupAction === 'export' && renderDecorativeActivityIndicator(tc.tint)}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
            onPress={handleExportCsv}
            disabled={isSyncing || isBackupBusy}
            accessibilityRole="button"
            accessibilityLabel={t('settings.exportCsv')}
            accessibilityHint={t('settings.exportCsvDesc')}
            accessibilityState={{ busy: backupAction === 'export:csv', disabled: isSyncing || isBackupBusy }}
            testID="data-transfer-export-csv"
          >
            <View style={styles.settingInfo}>
              <Text style={[styles.settingLabel, { color: '#3B82F6' }]}>{t('settings.exportCsv')}</Text>
              <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.exportCsvDesc')}</Text>
            </View>
            {backupAction === 'export:csv' && renderDecorativeActivityIndicator(tc.tint)}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
            onPress={handleExportTaskNotes}
            disabled={isSyncing || isBackupBusy}
            accessibilityRole="button"
            accessibilityLabel={t('settings.exportTaskNotes')}
            accessibilityHint={t('settings.exportTaskNotesDesc')}
            accessibilityState={{ busy: backupAction === 'export:tasknotes', disabled: isSyncing || isBackupBusy }}
            testID="data-transfer-export-tasknotes"
          >
            <View style={styles.settingInfo}>
              <Text style={[styles.settingLabel, { color: '#3B82F6' }]}>{t('settings.exportTaskNotes')}</Text>
              <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.exportTaskNotesDesc')}</Text>
            </View>
            {backupAction === 'export:tasknotes' && renderDecorativeActivityIndicator(tc.tint)}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
            onPress={handleRestoreBackup}
            disabled={isSyncing || isBackupBusy}
            accessibilityRole="button"
            accessibilityLabel={tr('settings.syncMobile.restoreBackup')}
            accessibilityHint={tr('settings.syncMobile.replaceLocalDataFromABackupJsonFile')}
            accessibilityState={{ busy: backupAction === 'restore', disabled: isSyncing || isBackupBusy }}
            testID="data-transfer-restore"
          >
            <View style={styles.settingInfo}>
              <Text style={[styles.settingLabel, { color: tc.tint }]}>{tr('settings.syncMobile.restoreBackup')}</Text>
              <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                {tr('settings.syncMobile.replaceLocalDataFromABackupJsonFile')}
              </Text>
            </View>
            {backupAction === 'restore' && renderDecorativeActivityIndicator(tc.tint)}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
            onPress={handleMergeBackup}
            disabled={isSyncing || isBackupBusy}
            accessibilityRole="button"
            accessibilityLabel={t('settings.mergeBackup')}
            accessibilityHint={t('settings.mergeBackupDesc')}
            accessibilityState={{ busy: backupAction === 'merge', disabled: isSyncing || isBackupBusy }}
            testID="data-transfer-merge"
          >
            <View style={styles.settingInfo}>
              <Text style={[styles.settingLabel, { color: tc.tint }]}>{t('settings.mergeBackup')}</Text>
              <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                {t('settings.mergeBackupDesc')}
              </Text>
            </View>
            {backupAction === 'merge' && renderDecorativeActivityIndicator(tc.tint)}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
            onPress={handleAddGettingStartedContent}
            disabled={isGettingStartedDisabled || isSyncing || isBackupBusy}
            accessibilityRole="button"
            accessibilityLabel={t('settings.gettingStartedContentAction')}
            accessibilityHint={t('settings.gettingStartedContentDesc')}
            accessibilityState={{
              busy: isGettingStartedBusy,
              disabled: isGettingStartedDisabled || isSyncing || isBackupBusy,
            }}
            testID="add-getting-started-content"
          >
            <View style={styles.settingInfo}>
              <Text style={[styles.settingLabel, { color: tc.tint }]}>{t('settings.gettingStartedContentAction')}</Text>
              <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.gettingStartedContentDesc')}</Text>
            </View>
            {isGettingStartedBusy && renderDecorativeActivityIndicator(tc.tint)}
          </TouchableOpacity>
        </>
        )}
      </View>

      <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 16 }]}>
        <TouchableOpacity
          style={[styles.gtdNavigationRow, { borderTopWidth: 0 }]}
          onPress={() => setImportOpen((prev) => !prev)}
          accessibilityRole="button"
          accessibilityState={{ expanded: importOpen }}
          activeOpacity={0.75}
          testID="import-disclosure"
        >
          <View style={styles.settingInfo}>
            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.importData')}</Text>
            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
              {t('settings.importDataDesc')}
            </Text>
          </View>
          <Ionicons
            name={importOpen ? 'chevron-up' : 'chevron-down'}
            size={18}
            color={tc.secondaryText}
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          />
        </TouchableOpacity>
        {importOpen && (
        <>
          {importGuide ? (
            <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
              {importGuide}
            </View>
          ) : null}
          <TouchableOpacity
            style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
            onPress={handleImportTodoist}
            disabled={isSyncing || isBackupBusy}
            accessibilityRole="button"
            accessibilityLabel={tr('settings.syncMobile.importFromTodoist')}
            accessibilityHint={tr('settings.syncMobile.importTodoistCsvOrZipExportsIntoMindwtrProjects')}
            accessibilityState={{ busy: backupAction === 'import:todoist', disabled: isSyncing || isBackupBusy }}
            testID="data-transfer-import-todoist"
          >
            <View style={styles.settingInfo}>
              <Text style={[styles.settingLabel, { color: tc.tint }]}>{tr('settings.syncMobile.importFromTodoist')}</Text>
              <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                {tr('settings.syncMobile.importTodoistCsvOrZipExportsIntoMindwtrProjects')}
              </Text>
            </View>
            {backupAction === 'import:todoist' && renderDecorativeActivityIndicator(tc.tint)}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
            onPress={handleImportTickTick}
            disabled={isSyncing || isBackupBusy}
            accessibilityRole="button"
            accessibilityLabel={tr('settings.syncMobile.importFromTicktick')}
            accessibilityHint={tr('settings.syncMobile.importTicktickCsvOrZipBackupsIntoMindwtrAreas')}
            accessibilityState={{ busy: backupAction === 'import:ticktick', disabled: isSyncing || isBackupBusy }}
            testID="data-transfer-import-ticktick"
          >
            <View style={styles.settingInfo}>
              <Text style={[styles.settingLabel, { color: tc.tint }]}>{tr('settings.syncMobile.importFromTicktick')}</Text>
              <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                {tr('settings.syncMobile.importTicktickCsvOrZipBackupsIntoMindwtrAreas')}
              </Text>
            </View>
            {backupAction === 'import:ticktick' && renderDecorativeActivityIndicator(tc.tint)}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
            onPress={handleImportDgt}
            disabled={isSyncing || isBackupBusy}
            accessibilityRole="button"
            accessibilityLabel={tr('settings.syncMobile.importFromDgtGtd')}
            accessibilityHint={tr('settings.syncMobile.importDgtGtdJsonOrZipExportsIntoMindwtrAreas')}
            accessibilityState={{ busy: backupAction === 'import:dgt', disabled: isSyncing || isBackupBusy }}
            testID="data-transfer-import-dgt"
          >
            <View style={styles.settingInfo}>
              <Text style={[styles.settingLabel, { color: tc.tint }]}>{tr('settings.syncMobile.importFromDgtGtd')}</Text>
              <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                {tr('settings.syncMobile.importDgtGtdJsonOrZipExportsIntoMindwtrAreas')}
              </Text>
            </View>
            {backupAction === 'import:dgt' && renderDecorativeActivityIndicator(tc.tint)}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
            onPress={handleImportOmniFocus}
            disabled={isSyncing || isBackupBusy}
            accessibilityRole="button"
            accessibilityLabel={tr('settings.syncMobile.importFromOmnifocus')}
            accessibilityHint={tr('settings.syncMobile.importOmnifocusCsvJsonOrZipExportsIntoMindwtrProjects')}
            accessibilityState={{ busy: backupAction === 'import:omnifocus', disabled: isSyncing || isBackupBusy }}
            testID="data-transfer-import-omnifocus"
          >
            <View style={styles.settingInfo}>
              <Text style={[styles.settingLabel, { color: tc.tint }]}>{tr('settings.syncMobile.importFromOmnifocus')}</Text>
              <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                {tr('settings.syncMobile.importOmnifocusCsvJsonOrZipExportsIntoMindwtrProjects')}
              </Text>
            </View>
            {backupAction === 'import:omnifocus' && renderDecorativeActivityIndicator(tc.tint)}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
            onPress={handleImportMindwtrCsv}
            disabled={isSyncing || isBackupBusy}
            accessibilityRole="button"
            accessibilityLabel={tr('settings.syncMobile.importFromMindwtrCsv')}
            accessibilityHint={tr('settings.syncMobile.importMindwtrCsvFileIntoMindwtrAreasProjectsAndTasks')}
            accessibilityState={{ busy: backupAction === 'import:mindwtr-csv', disabled: isSyncing || isBackupBusy }}
            testID="data-transfer-import-mindwtr-csv"
          >
            <View style={styles.settingInfo}>
              <Text style={[styles.settingLabel, { color: tc.tint }]}>{tr('settings.syncMobile.importFromMindwtrCsv')}</Text>
              <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                {tr('settings.syncMobile.importMindwtrCsvFileIntoMindwtrAreasProjectsAndTasks')}
              </Text>
            </View>
            {backupAction === 'import:mindwtr-csv' && renderDecorativeActivityIndicator(tc.tint)}
          </TouchableOpacity>
        </>
        )}
      </View>
    </>
  );
}

type RecoverySnapshotsCardProps = {
  backupAction: BackupAction;
  formatRecoverySnapshotLabel: (fileName: string) => string;
  handleRestoreRecoverySnapshot: (snapshotName: string) => void;
  isBackupBusy: boolean;
  isLoadingRecoverySnapshots: boolean;
  isSyncing: boolean;
  tr: SettingsTranslator;
  recoverySnapshots: string[];
  recoverySnapshotsOpen: boolean;
  setRecoverySnapshotsOpen: (open: boolean) => void;
  t: Translate;
  tc: ThemeColors;
};

export function RecoverySnapshotsCard({
  backupAction,
  formatRecoverySnapshotLabel,
  handleRestoreRecoverySnapshot,
  isBackupBusy,
  isLoadingRecoverySnapshots,
  isSyncing,
  tr,
  recoverySnapshots,
  recoverySnapshotsOpen,
  setRecoverySnapshotsOpen,
  t,
  tc,
}: RecoverySnapshotsCardProps) {
  return (
    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 16 }]}>
      <TouchableOpacity
        style={styles.settingRow}
        onPress={() => setRecoverySnapshotsOpen(!recoverySnapshotsOpen)}
        accessibilityRole="button"
        accessibilityState={{ expanded: recoverySnapshotsOpen }}
        testID="recovery-snapshots-disclosure"
      >
        <View style={styles.settingInfo}>
          <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.recoverySnapshots')}</Text>
          <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
            {tr('settings.syncMobile.savedAutomaticallyBeforeRestoreAndImportOperations')}
          </Text>
        </View>
        <Text
          style={[styles.chevron, { color: tc.secondaryText }]}
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          testID="recovery-snapshots-chevron"
        >
          {recoverySnapshotsOpen ? '▾' : '▸'}
        </Text>
      </TouchableOpacity>
      {recoverySnapshotsOpen && (
        <>
          {isLoadingRecoverySnapshots && (
            <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
              <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                {t('settings.recoverySnapshotsLoading')}
              </Text>
            </View>
          )}
          {!isLoadingRecoverySnapshots && recoverySnapshots.length === 0 && (
            <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
              <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                {t('settings.recoverySnapshotsEmpty')}
              </Text>
            </View>
          )}
          {!isLoadingRecoverySnapshots &&
            recoverySnapshots.map((snapshot) => {
              const displayLabel = formatRecoverySnapshotLabel(snapshot);
              const accessibilityName = displayLabel === snapshot
                ? snapshot
                : `${displayLabel} (${snapshot})`;
              return (
              <TouchableOpacity
                key={snapshot}
                style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                onPress={() => handleRestoreRecoverySnapshot(snapshot)}
                disabled={isSyncing || isBackupBusy}
                accessibilityRole="button"
                accessibilityLabel={tr('settings.recoverySnapshotsRestoreNamed', {
                  snapshotName: accessibilityName,
                })}
                accessibilityHint={tr('settings.recoverySnapshotsConfirm', { snapshot })}
                accessibilityState={{
                  busy: backupAction === `snapshot:${snapshot}`,
                  disabled: isSyncing || isBackupBusy,
                }}
                testID={`recovery-snapshot-${snapshot}`}
              >
                <View style={styles.settingInfo}>
                  <Text style={[styles.settingLabel, { color: tc.text }]} numberOfLines={1}>
                    {displayLabel}
                  </Text>
                  <Text style={[styles.settingDescription, { color: tc.secondaryText }]} numberOfLines={1}>
                    {snapshot}
                  </Text>
                </View>
                {backupAction === `snapshot:${snapshot}` ? (
                  renderDecorativeActivityIndicator(tc.tint)
                ) : (
                  <Text style={[styles.settingLabel, { color: tc.tint }]}>{t('settings.recoverySnapshotsRestore')}</Text>
                )}
              </TouchableOpacity>
              );
            })}
        </>
      )}
    </View>
  );
}

type SyncPreferencesCardProps = {
  syncAiEnabled: boolean;
  syncAppearanceEnabled: boolean;
  syncExternalCalendarsEnabled: boolean;
  syncGtdEnabled: boolean;
  syncLanguageEnabled: boolean;
  syncSavedFiltersEnabled: boolean;
  syncOptionsOpen: boolean;
  t: Translate;
  tc: ThemeColors;
  toggleSyncOptionsOpen: () => void;
  updateSyncPreferences: (partial: { ai?: boolean; appearance?: boolean; externalCalendars?: boolean; gtd?: boolean; language?: boolean; savedFilters?: boolean }) => void;
};

export function SyncPreferencesCard({
  syncAiEnabled,
  syncAppearanceEnabled,
  syncExternalCalendarsEnabled,
  syncGtdEnabled,
  syncLanguageEnabled,
  syncSavedFiltersEnabled,
  syncOptionsOpen,
  t,
  tc,
  toggleSyncOptionsOpen,
  updateSyncPreferences,
}: SyncPreferencesCardProps) {
  return (
    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 16 }]}>
      <TouchableOpacity
        style={styles.settingRow}
        onPress={toggleSyncOptionsOpen}
        accessibilityRole="button"
        accessibilityState={{ expanded: syncOptionsOpen }}
        testID="sync-preferences-disclosure"
      >
        <View style={styles.settingInfo}>
          <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.syncPreferences')}</Text>
          <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.syncPreferencesDesc')}</Text>
        </View>
        <Text
          style={[styles.chevron, { color: tc.secondaryText }]}
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          testID="sync-preferences-chevron"
        >
          {syncOptionsOpen ? '▾' : '▸'}
        </Text>
      </TouchableOpacity>
      {syncOptionsOpen && (
        <>
          <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
            <View style={styles.settingInfo}>
              <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.syncPreferenceAppearance')}</Text>
            </View>
            <Switch
              value={syncAppearanceEnabled}
              onValueChange={(value) => updateSyncPreferences({ appearance: value })}
              trackColor={{ false: '#767577', true: '#3B82F6' }}
            />
          </View>
          <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
            <View style={styles.settingInfo}>
              <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.syncPreferenceLanguage')}</Text>
            </View>
            <Switch
              value={syncLanguageEnabled}
              onValueChange={(value) => updateSyncPreferences({ language: value })}
              trackColor={{ false: '#767577', true: '#3B82F6' }}
            />
          </View>
          <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
            <View style={styles.settingInfo}>
              <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.syncPreferenceGtd')}</Text>
            </View>
            <Switch
              value={syncGtdEnabled}
              onValueChange={(value) => updateSyncPreferences({ gtd: value })}
              trackColor={{ false: '#767577', true: '#3B82F6' }}
            />
          </View>
          <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
            <View style={styles.settingInfo}>
              <Text style={[styles.settingLabel, { color: tc.text }]}>
                {translateWithFallback(t, 'settings.syncPreferenceSavedFilters', 'Saved filters')}
              </Text>
            </View>
            <Switch
              value={syncSavedFiltersEnabled}
              onValueChange={(value) => updateSyncPreferences({ savedFilters: value })}
              trackColor={{ false: '#767577', true: '#3B82F6' }}
            />
          </View>
          <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
            <View style={styles.settingInfo}>
              <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.syncPreferenceExternalCalendars')}</Text>
            </View>
            <Switch
              value={syncExternalCalendarsEnabled}
              onValueChange={(value) => updateSyncPreferences({ externalCalendars: value })}
              trackColor={{ false: '#767577', true: '#3B82F6' }}
            />
          </View>
          <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
            <View style={styles.settingInfo}>
              <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.syncPreferenceAi')}</Text>
              <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.syncPreferenceAiHint')}</Text>
            </View>
            <Switch
              value={syncAiEnabled}
              onValueChange={(value) => updateSyncPreferences({ ai: value })}
              trackColor={{ false: '#767577', true: '#3B82F6' }}
            />
          </View>
        </>
      )}
    </View>
  );
}

type SyncDiagnosticsCardProps = {
  analyticsHeartbeatAvailable: boolean;
  analyticsHeartbeatOptedOut: boolean;
  handleClearLog: () => void;
  handleShareLog: () => void;
  loggingEnabled: boolean;
  toggleAnalyticsHeartbeatOptOut: (value: boolean) => void;
  t: Translate;
  tc: ThemeColors;
  toggleDebugLogging: (value: boolean) => void;
};

export function SyncDiagnosticsCard({
  analyticsHeartbeatAvailable,
  analyticsHeartbeatOptedOut,
  handleClearLog,
  handleShareLog,
  loggingEnabled,
  toggleAnalyticsHeartbeatOptOut,
  t,
  tc,
  toggleDebugLogging,
}: SyncDiagnosticsCardProps) {
  return (
    <>
      <Text style={[styles.sectionTitle, { color: tc.text, marginTop: 24 }]}>{t('settings.diagnostics')}</Text>
      <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
        {analyticsHeartbeatAvailable && (
          <View style={styles.settingRow}>
            <View style={styles.settingInfo}>
              <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.analyticsHeartbeat')}</Text>
              <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.analyticsHeartbeatDesc')}</Text>
            </View>
            <Switch
              value={analyticsHeartbeatOptedOut}
              onValueChange={toggleAnalyticsHeartbeatOptOut}
              trackColor={{ false: '#767577', true: '#71717A' }}
              thumbColor="#F4F4F5"
            />
          </View>
        )}
        <View style={[
          styles.settingRow,
          analyticsHeartbeatAvailable && { borderTopWidth: 1, borderTopColor: tc.border },
        ]}>
          <View style={styles.settingInfo}>
            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.debugLogging')}</Text>
            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.debugLoggingDesc')}</Text>
          </View>
          <Switch value={loggingEnabled} onValueChange={toggleDebugLogging} trackColor={{ false: '#767577', true: '#3B82F6' }} />
        </View>
        {loggingEnabled && (
          <>
            <TouchableOpacity style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]} onPress={handleShareLog}>
              <View style={styles.settingInfo}>
                <Text style={[styles.settingLabel, { color: tc.tint }]}>{t('settings.shareLog')}</Text>
                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.logFile')}</Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]} onPress={handleClearLog}>
              <View style={styles.settingInfo}>
                <Text style={[styles.settingLabel, { color: tc.secondaryText }]}>{t('settings.clearLog')}</Text>
              </View>
            </TouchableOpacity>
          </>
        )}
      </View>
    </>
  );
}
