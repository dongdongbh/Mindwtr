/**
 * Settings › Data's Diagnostics card as React Native draws it (apps/mobile/components/settings/
 * sync-settings-sections.tsx SyncDiagnosticsCard; its actions in use-sync-settings-backup-actions.ts):
 * the Debug logging switch, then, while logging is on, Share log and Clear log. RN's analytics row
 * shows only in builds with the heartbeat, and its Encryption block comes with sync; neither is
 * here yet. Backup currently exposes RN's JSON, CSV and TaskNotes export actions; restore and the
 * other transfer formats remain separate migration work.
 */
import { isDiagnosticsLoggingEnabled } from './diagnostics-log';
import type { AppSettings } from './types';

type Translate = (key: string) => string;

export type DataSettingsEdit = { type: 'debugLogging'; value: boolean };

export type DataSettingsModel = {
    title: string;
    backup: {
        title: string; exportLabel: string; description: string; failed: string;
        csvLabel: string; csvDescription: string; csvFailed: string;
        tasknotesLabel: string; tasknotesDescription: string; tasknotesFailed: string;
    };
    diagnostics: {
        title: string;
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

export function buildDataSettingsModel(settings: AppSettings, t: Translate): DataSettingsModel {
    const on = isDiagnosticsLoggingEnabled(settings);
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
            tasknotesLabel: t('settings.exportTaskNotes'),
            tasknotesDescription: t('settings.exportTaskNotesDesc'),
            tasknotesFailed: t('settings.exportTaskNotesFailed'),
        },
        diagnostics: {
            title: t('settings.diagnostics'),
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

export const isDataSettingStored = (settings: AppSettings, edit: DataSettingsEdit): boolean =>
    isDiagnosticsLoggingEnabled(settings) === edit.value;

/** RN's toggleDebugLogging: the switch's value, the other diagnostics fields kept. */
export const buildDataSettingsUpdate = (settings: AppSettings, edit: DataSettingsEdit): Partial<AppSettings> => ({
    diagnostics: { ...(settings.diagnostics ?? {}), loggingEnabled: edit.value },
});
