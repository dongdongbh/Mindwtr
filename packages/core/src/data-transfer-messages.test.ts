import { describe, expect, it } from 'vitest';
import { buildBackupPreviewSummary, buildMindwtrCsvResultMessage, buildTodoistPreviewSummary } from './data-transfer-messages';
import { getTranslator, resolveI18nText } from './i18n';

const t = getTranslator('en');
const tr = (key: string, values?: Record<string, string | number>) => resolveI18nText(t, key, { values });

// RN meant a blank line between a summary and its project list or warnings (it pushes '' there), but filter(Boolean) dropped it.
describe('Data transfer messages: the blank line before a list', () => {
    it('keeps the blank line before the project list and before the warnings', () => {
        const preview = buildTodoistPreviewSummary({ taskCount: 3, projectCount: 1, sectionCount: 0, checklistItemCount: 0,
            projects: [{ name: 'Home', taskCount: 3 }], warnings: ['Skipped 2 rows without a title.'] }, tr);
        expect(preview.split('\n')).toEqual([tr('settings.backupMobile.importTodoistTasksFromProjects', { taskCount: 3, projectCount: 1 }), '', '• Home: 3', '', expect.any(String)]);
        const backup = buildBackupPreviewSummary({ metadata: { taskCount: 1, projectCount: 0 }, warnings: ['Skipped 2 rows without a title.'] }, 'Effect.', tr);
        expect(backup.split('\n')[2]).toBe('');
    });

    it('adds no blank line when nothing follows', () => {
        const preview = buildTodoistPreviewSummary({ taskCount: 3, projectCount: 0, sectionCount: 0, checklistItemCount: 0, projects: [], warnings: [] }, tr);
        expect(preview).not.toContain('\n\n');
        expect(preview.endsWith('\n')).toBe(false);
    });
});

// The phone toast shows four lines; a skip reason below the snapshot name was cut off (#1447).
describe('Data transfer messages: import results', () => {
    it('puts the warnings right after the counts and the snapshot line last', () => {
        const result = buildMindwtrCsvResultMessage({ importedTaskCount: 0, importedProjectCount: 0, importedSectionCount: 0,
            importedAreaCount: 0, importedChecklistItemCount: 0,
            warnings: ['7 tasks were skipped because they were imported earlier and then deleted here; deletions are kept on re-import.'] },
        'data.snapshot.json', tr).split('\n');
        expect(result).toEqual([
            expect.stringContaining('Imported 0 task(s)'),
            tr('settings.importDiagnostics.skippedExistingRecords', { count: 7 }),
            tr('settings.backupMobile.recoverySnapshotSaved', { snapshotName: 'data.snapshot.json' }),
        ]);
    });
});
