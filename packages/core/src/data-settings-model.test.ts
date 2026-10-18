import { describe, expect, it } from 'vitest';
import { buildDataSettingsModel, IMPORT_PICKER_MIME_TYPES } from './data-settings-model';
import { getDocsGuideUrl } from './docs-guidance';
import { getTranslator } from './i18n';
import { createSyncSettingsTranslator } from './sync-settings-model';

/** RN's SyncBackupSection (sync-settings-sections.tsx) and its screen's import guide, key for key. */
describe('Settings › Data model: RN\'s Backup and Import folds', () => {
    it.each(['en', 'ar', 'de', 'zh-Hans'] as const)('reads every text through RN\'s own key (%s)', (language) => {
        const t = getTranslator(language);
        const tr = createSyncSettingsTranslator(t);
        const { backup, importData } = buildDataSettingsModel({}, t, false, language);
        expect(backup).toMatchObject({
            title: t('settings.backup'),
            foldDescription: t('settings.backupDesc'),
            exportLabel: t('settings.exportBackup'),
            description: t('settings.saveToSyncFolder'),
            csvLabel: t('settings.exportCsv'),
            csvDescription: t('settings.exportCsvDesc'),
            tasknotesLabel: t('settings.exportTaskNotes'),
            tasknotesDescription: t('settings.exportTaskNotesDesc'),
            restoreFileLabel: tr('settings.syncMobile.restoreBackup'),
            restoreFileDescription: tr('settings.syncMobile.replaceLocalDataFromABackupJsonFile'),
            mergeLabel: t('settings.mergeBackup'),
            mergeDescription: t('settings.mergeBackupDesc'),
            todoistImportLabel: tr('settings.syncMobile.importFromTodoist'),
            ticktickImportDescription: tr('settings.syncMobile.importTicktickCsvOrZipBackupsIntoMindwtrAreas'),
            csvImportLabel: tr('settings.syncMobile.importFromMindwtrCsv'),
            errorTitle: tr('settings.syncMobile.error'),
            restoreFailed: t('settings.backupMobile.restoreFailed'),
        });
        expect(importData).toEqual({
            title: t('settings.importData'),
            description: t('settings.importDataDesc'),
            guide: { title: t('settings.importSetupGuideTitle'), description: t('settings.importSetupGuideDesc'), url: getDocsGuideUrl('import/', language) },
            failed: t('settings.backupMobile.importFailed'),
            // RN's row order (sync-settings-sections.tsx): Todoist, TickTick, DGT GTD, OmniFocus, Mindwtr CSV.
            rows: [
                { key: 'todoist', mode: 'todoist', label: tr('settings.syncMobile.importFromTodoist'), description: tr('settings.syncMobile.importTodoistCsvOrZipExportsIntoMindwtrProjects'), mimeTypes: IMPORT_PICKER_MIME_TYPES.todoist },
                { key: 'ticktick', mode: 'ticktick', label: tr('settings.syncMobile.importFromTicktick'), description: tr('settings.syncMobile.importTicktickCsvOrZipBackupsIntoMindwtrAreas'), mimeTypes: IMPORT_PICKER_MIME_TYPES.ticktick },
                { key: 'dgt', mode: 'dgt', label: tr('settings.syncMobile.importFromDgtGtd'), description: tr('settings.syncMobile.importDgtGtdJsonOrZipExportsIntoMindwtrAreas'), mimeTypes: IMPORT_PICKER_MIME_TYPES.dgt },
                { key: 'omnifocus', mode: 'omnifocus', label: tr('settings.syncMobile.importFromOmnifocus'), description: tr('settings.syncMobile.importOmnifocusCsvJsonOrZipExportsIntoMindwtrProjects'), mimeTypes: IMPORT_PICKER_MIME_TYPES.omnifocus },
                { key: 'mindwtr-csv', mode: 'csv', label: tr('settings.syncMobile.importFromMindwtrCsv'), description: tr('settings.syncMobile.importMindwtrCsvFileIntoMindwtrAreasProjectsAndTasks'), mimeTypes: IMPORT_PICKER_MIME_TYPES['mindwtr-csv'] },
            ],
        });
        expect(backup.gettingStarted).toEqual({
            label: t('settings.gettingStartedContentAction'), description: t('settings.gettingStartedContentDesc'), language,
            ready: t('onboarding.toastReady'), notCreated: t('onboarding.toastNotCreated'), failed: t('onboarding.toastFailed'), open: t('common.open'),
        });
    });

    // Frozen from RN's IMPORT_PICKER_DESCRIPTORS (apps/mobile/lib/data-transfer.ts) before the move into core.
    it('keeps RN\'s picker types for each importer', () => {
        const csvZip = ['text/csv', 'text/comma-separated-values', 'application/zip', 'application/x-zip-compressed', 'application/octet-stream'];
        expect(IMPORT_PICKER_MIME_TYPES).toEqual({
            todoist: csvZip,
            ticktick: csvZip,
            dgt: ['application/json', 'application/zip', 'application/x-zip-compressed', 'application/octet-stream'],
            omnifocus: ['text/csv', 'text/comma-separated-values', 'application/json', 'application/zip', 'application/x-zip-compressed', 'application/octet-stream'],
            'mindwtr-csv': csvZip,
        });
    });

    it('differs from the keys RN does not use where their words differ', () => {
        const t = getTranslator('de');
        const { backup } = buildDataSettingsModel({}, t, false, 'de');
        expect(backup.restoreFileDescription).not.toBe(t('settings.restoreBackupDesc'));
        expect(backup.description).not.toBe(t('settings.exportBackupDesc'));
    });

    it('gives the import guide the localized docs path', () => {
        expect(buildDataSettingsModel({}, getTranslator('zh-Hans'), false, 'zh-Hans').importData.guide.url).toBe(getDocsGuideUrl('import/', 'zh-Hans'));
        expect(getDocsGuideUrl('import/', 'zh-Hans')).not.toBe(getDocsGuideUrl('import/', 'en'));
    });
});
