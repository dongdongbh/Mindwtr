import type { ReactNode } from 'react';
import React from 'react';
import { ActivityIndicator, Switch, Text, TouchableOpacity, View } from 'react-native';

import type { ThemeColors } from '@/hooks/use-theme-colors';

import { styles } from './settings.styles';

type Translate = (key: string) => string;
type Localize = (english: string, chinese: string) => string;

type SyncLastStatusCardProps = {
  conflictCount: number;
  conflictIds: string[];
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
          {showLastSyncStats && conflictIds.length > 0 && (
            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
              {t('settings.lastSyncConflictIds')}: {conflictIds.join(', ')}
            </Text>
          )}
          {lastSyncStatus === 'error' && lastSyncError && (
            <Text style={[styles.settingDescription, { color: '#EF4444' }]}>{lastSyncError}</Text>
          )}
          {historyContent}
        </View>
      </View>
    </View>
  );
}

type SyncBackupSectionProps = {
  backupAction: null | 'export' | 'restore' | 'import' | 'snapshot';
  handleBackup: () => void;
  handleImportDgt: () => void;
  handleImportOmniFocus: () => void;
  handleImportTodoist: () => void;
  handleRestoreBackup: () => void;
  isBackupBusy: boolean;
  isSyncing: boolean;
  localize: Localize;
  t: Translate;
  tc: ThemeColors;
};

export function SyncBackupSection({
  backupAction,
  handleBackup,
  handleImportDgt,
  handleImportOmniFocus,
  handleImportTodoist,
  handleRestoreBackup,
  isBackupBusy,
  isSyncing,
  localize,
  t,
  tc,
}: SyncBackupSectionProps) {
  return (
    <>
      <Text style={[styles.sectionTitle, { color: tc.text, marginTop: 24 }]}>{t('settings.backup')}</Text>
      <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
        <TouchableOpacity style={styles.settingRow} onPress={handleBackup} disabled={isSyncing || isBackupBusy}>
          <View style={styles.settingInfo}>
            <Text style={[styles.settingLabel, { color: '#3B82F6' }]}>{t('settings.exportBackup')}</Text>
            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.saveToSyncFolder')}</Text>
          </View>
          {backupAction === 'export' && <ActivityIndicator size="small" color={tc.tint} />}
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
          onPress={handleRestoreBackup}
          disabled={isSyncing || isBackupBusy}
        >
          <View style={styles.settingInfo}>
            <Text style={[styles.settingLabel, { color: tc.tint }]}>{localize('Restore Backup', '恢复备份')}</Text>
            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
              {localize('Replace local data from a backup JSON file.', '从备份 JSON 文件替换本地数据。')}
            </Text>
          </View>
          {backupAction === 'restore' && <ActivityIndicator size="small" color={tc.tint} />}
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
          onPress={handleImportTodoist}
          disabled={isSyncing || isBackupBusy}
        >
          <View style={styles.settingInfo}>
            <Text style={[styles.settingLabel, { color: tc.tint }]}>{localize('Import from Todoist', '从 Todoist 导入')}</Text>
            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
              {localize('Import Todoist CSV or ZIP exports into Mindwtr projects.', '将 Todoist 的 CSV 或 ZIP 导出导入为 Mindwtr 项目。')}
            </Text>
          </View>
          {backupAction === 'import' && <ActivityIndicator size="small" color={tc.tint} />}
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
          onPress={handleImportDgt}
          disabled={isSyncing || isBackupBusy}
        >
          <View style={styles.settingInfo}>
            <Text style={[styles.settingLabel, { color: tc.tint }]}>{localize('Import from DGT GTD', '从 DGT GTD 导入')}</Text>
            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
              {localize('Import DGT GTD JSON or ZIP exports into Mindwtr areas, projects, and tasks.', '将 DGT GTD 的 JSON 或 ZIP 导出导入为 Mindwtr 的领域、项目和任务。')}
            </Text>
          </View>
          {backupAction === 'import' && <ActivityIndicator size="small" color={tc.tint} />}
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
          onPress={handleImportOmniFocus}
          disabled={isSyncing || isBackupBusy}
        >
          <View style={styles.settingInfo}>
            <Text style={[styles.settingLabel, { color: tc.tint }]}>{localize('Import from OmniFocus', '从 OmniFocus 导入')}</Text>
            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
              {localize('Import OmniFocus CSV, JSON, or ZIP exports into Mindwtr projects and inbox tasks.', '将 OmniFocus 的 CSV、JSON 或 ZIP 导出导入为 Mindwtr 项目和收集箱任务。')}
            </Text>
          </View>
          {backupAction === 'import' && <ActivityIndicator size="small" color={tc.tint} />}
        </TouchableOpacity>
      </View>
    </>
  );
}

type RecoverySnapshotsCardProps = {
  backupAction: null | 'export' | 'restore' | 'import' | 'snapshot';
  formatRecoverySnapshotLabel: (fileName: string) => string;
  handleRestoreRecoverySnapshot: (snapshotName: string) => void;
  isBackupBusy: boolean;
  isLoadingRecoverySnapshots: boolean;
  isSyncing: boolean;
  localize: Localize;
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
  localize,
  recoverySnapshots,
  recoverySnapshotsOpen,
  setRecoverySnapshotsOpen,
  t,
  tc,
}: RecoverySnapshotsCardProps) {
  return (
    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 16 }]}>
      <TouchableOpacity style={styles.settingRow} onPress={() => setRecoverySnapshotsOpen(!recoverySnapshotsOpen)}>
        <View style={styles.settingInfo}>
          <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.recoverySnapshots')}</Text>
          <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
            {localize('Saved automatically before restore and import operations.', '在恢复和导入之前自动保存。')}
          </Text>
        </View>
        <Text style={[styles.chevron, { color: tc.secondaryText }]}>{recoverySnapshotsOpen ? '▾' : '▸'}</Text>
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
            recoverySnapshots.map((snapshot) => (
              <TouchableOpacity
                key={snapshot}
                style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                onPress={() => handleRestoreRecoverySnapshot(snapshot)}
                disabled={isSyncing || isBackupBusy}
              >
                <View style={styles.settingInfo}>
                  <Text style={[styles.settingLabel, { color: tc.text }]} numberOfLines={1}>
                    {formatRecoverySnapshotLabel(snapshot)}
                  </Text>
                  <Text style={[styles.settingDescription, { color: tc.secondaryText }]} numberOfLines={1}>
                    {snapshot}
                  </Text>
                </View>
                {backupAction === 'snapshot' ? (
                  <ActivityIndicator size="small" color={tc.tint} />
                ) : (
                  <Text style={[styles.settingLabel, { color: tc.tint }]}>{t('settings.recoverySnapshotsRestore')}</Text>
                )}
              </TouchableOpacity>
            ))}
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
  syncOptionsOpen: boolean;
  t: Translate;
  tc: ThemeColors;
  toggleSyncOptionsOpen: () => void;
  updateSyncPreferences: (partial: { ai?: boolean; appearance?: boolean; externalCalendars?: boolean; gtd?: boolean; language?: boolean }) => void;
};

export function SyncPreferencesCard({
  syncAiEnabled,
  syncAppearanceEnabled,
  syncExternalCalendarsEnabled,
  syncGtdEnabled,
  syncLanguageEnabled,
  syncOptionsOpen,
  t,
  tc,
  toggleSyncOptionsOpen,
  updateSyncPreferences,
}: SyncPreferencesCardProps) {
  return (
    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 16 }]}>
      <TouchableOpacity style={styles.settingRow} onPress={toggleSyncOptionsOpen}>
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
  handleClearLog: () => void;
  handleShareLog: () => void;
  loggingEnabled: boolean;
  t: Translate;
  tc: ThemeColors;
  toggleDebugLogging: (value: boolean) => void;
};

export function SyncDiagnosticsCard({
  handleClearLog,
  handleShareLog,
  loggingEnabled,
  t,
  tc,
  toggleDebugLogging,
}: SyncDiagnosticsCardProps) {
  return (
    <>
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
