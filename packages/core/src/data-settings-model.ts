/**
 * Settings › Data's Diagnostics card as React Native draws it (apps/mobile/components/settings/
 * sync-settings-sections.tsx SyncDiagnosticsCard; its actions in use-sync-settings-backup-actions.ts):
 * the analytics opt-out (builds with the heartbeat only), the Debug logging switch, then, while
 * logging is on, Share log and Clear log. Its Encryption block comes with sync and is not here yet. Backup currently exposes RN's JSON, CSV and TaskNotes export actions; restore and the
 * other transfer formats remain separate migration work.
 */
import { isDiagnosticsLoggingEnabled } from './diagnostics-log';
import type { AppSettings } from './types';

type Translate = (key: string) => string;

export type DataSettingsEdit = { type: 'debugLogging'; value: boolean } | { type: 'analyticsOptOut'; value: boolean };

export type DataSettingsModel = {
    title: string;
    backup: {
        title: string; exportLabel: string; description: string; failed: string;
        csvLabel: string; csvDescription: string; csvFailed: string;
        csvImportLabel: string; csvImportDescription: string;
        restoreFileLabel: string; restoreFileDescription: string;
        todoistImportLabel: string; todoistImportDescription: string;
        ticktickImportLabel: string; ticktickImportDescription: string;
        dgtImportLabel: string; dgtImportDescription: string;
        omnifocusImportLabel: string; omnifocusImportDescription: string;
        tasknotesLabel: string; tasknotesDescription: string; tasknotesFailed: string;
        mergeLabel: string; mergeDescription: string; mergeFailed: string; snapshotsLabel: string; restoreLabel: string;
    };
    diagnostics: {
        title: string;
        /**
         * RN's analytics switch, on while the user opted out of the heartbeat; null in a build without one. Turning it on asks
         * `confirm` first (its cancel keeps the heartbeat).
         */
        analytics: {
            label: string; description: string; value: boolean; edit: DataSettingsEdit;
            confirm: { title: string; message: string; keepLabel: string; disableLabel: string };
        } | null;
        debugLogging: { label: string; description: string; value: boolean; edit: DataSettingsEdit };
        shareLog: { label: string; description: string } | null;
        clearLog: { label: string } | null;
        /** RN's toasts after Share and Clear, each titled `toastTitle`. */
        toastTitle: string;
        logMissing: string;
        shareUnavailable: string;
        logCleared: string;
        logClearFailed: string;
    };
};

/** `analyticsAvailable`: the build sends the heartbeat (isMobileAnalyticsHeartbeatConfigured). */
export function buildDataSettingsModel(settings: AppSettings, t: Translate, analyticsAvailable = false): DataSettingsModel {
    const on = isDiagnosticsLoggingEnabled(settings);
    const optedOut = analyticsAvailable && !isAnalyticsHeartbeatEnabled(settings);
    return {
        title: t('settings.data'),
        backup: {
            title: t('settings.backup'),
            exportLabel: t('settings.exportBackup'),
            description: t('settings.exportBackupDesc'),
            failed: t('settings.backupMobile.failedToExportBackup'),
            csvLabel: t('settings.exportCsv'),
            csvDescription: t('settings.exportCsvDesc'),
            csvFailed: t('settings.exportCsvFailed'),
            csvImportLabel: t('settings.importMindwtrCsv'),
            csvImportDescription: t('settings.importMindwtrCsvDesc'),
            restoreFileLabel: t('settings.restoreBackup'),
            restoreFileDescription: t('settings.restoreBackupDesc'),
            todoistImportLabel: t('settings.importTodoist'),
            todoistImportDescription: t('settings.importTodoistDesc'),
            ticktickImportLabel: t('settings.importTickTick'),
            ticktickImportDescription: t('settings.importTickTickDesc'),
            dgtImportLabel: t('settings.importDgt'),
            dgtImportDescription: t('settings.importDgtDesc'),
            omnifocusImportLabel: t('settings.importOmniFocus'),
            omnifocusImportDescription: t('settings.importOmniFocusDesc'),
            tasknotesLabel: t('settings.exportTaskNotes'),
            tasknotesDescription: t('settings.exportTaskNotesDesc'),
            tasknotesFailed: t('settings.exportTaskNotesFailed'),
            mergeLabel: t('settings.mergeBackup'),
            mergeDescription: t('settings.mergeBackupDesc'),
            mergeFailed: t('settings.mergeBackupFailed'),
            snapshotsLabel: t('settings.recoverySnapshots'),
            restoreLabel: t('settings.recoverySnapshotsRestore'),
        },
        diagnostics: {
            title: t('settings.diagnostics'),
            analytics: analyticsAvailable ? {
                label: t('settings.analyticsHeartbeat'),
                description: t('settings.analyticsHeartbeatDesc'),
                value: optedOut,
                edit: { type: 'analyticsOptOut', value: !optedOut },
                confirm: {
                    title: t('settings.analyticsHeartbeatDisableTitle'),
                    message: t('settings.analyticsHeartbeatDisableDesc'),
                    keepLabel: t('settings.analyticsHeartbeatKeepEnabled'),
                    disableLabel: t('settings.analyticsHeartbeatDisableConfirm'),
                },
            } : null,
            debugLogging: {
                label: t('settings.debugLogging'),
                description: t('settings.debugLoggingDesc'),
                value: on,
                edit: { type: 'debugLogging', value: !on },
            },
            shareLog: on ? { label: t('settings.shareLog'), description: t('settings.logFile') } : null,
            clearLog: on ? { label: t('settings.clearLog') } : null,
            toastTitle: t('settings.debugLogging'),
            logMissing: t('settings.logMissing'),
            shareUnavailable: t('settings.shareUnavailable'),
            logCleared: t('settings.logCleared'),
            logClearFailed: t('settings.logClearFailed'),
        },
    };
}

/** RN's: the heartbeat is on unless the user turned it off. */
export const isAnalyticsHeartbeatEnabled = (settings: AppSettings): boolean => settings.analytics?.heartbeatEnabled !== false;

export const isDataSettingStored = (settings: AppSettings, edit: DataSettingsEdit): boolean => (
    edit.type === 'analyticsOptOut'
        ? !isAnalyticsHeartbeatEnabled(settings) === edit.value
        : isDiagnosticsLoggingEnabled(settings) === edit.value
);

/**
 * RN's toggleDebugLogging (the switch's value, the other diagnostics fields kept) and its analytics switch (heartbeatEnabled
 * set to the opposite of the opt-out, the other analytics fields kept).
 */
export const buildDataSettingsUpdate = (settings: AppSettings, edit: DataSettingsEdit): Partial<AppSettings> => (
    edit.type === 'analyticsOptOut'
        ? { analytics: { ...(settings.analytics ?? {}), heartbeatEnabled: !edit.value } }
        : { diagnostics: { ...(settings.diagnostics ?? {}), loggingEnabled: edit.value } }
);
