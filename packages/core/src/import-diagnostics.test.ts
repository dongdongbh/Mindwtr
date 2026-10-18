import { describe, expect, it } from 'vitest';

import { createImportDiagnostic, formatImportDiagnostic } from './import-diagnostics';

describe('import diagnostics', () => {
    it.each([
        ['backup-empty-active-records', 'warning', 'settings.backupDiagnostics.noActiveRecords'],
        ['backup-newer-version', 'warning', 'settings.backupDiagnostics.newerVersion'],
        ['backup-older-version', 'warning', 'settings.backupDiagnostics.olderVersion'],
        ['backup-source-size-unknown', 'error', 'settings.backupDiagnostics.unknownSize'],
        ['backup-source-too-large', 'error', 'settings.backupDiagnostics.tooLarge'],
    ] as const)('formats structured backup diagnostic %s with localized copy', (code, severity, expectedKey) => {
        expect(formatImportDiagnostic({ code, params: {}, severity }, (key) => key)).toBe(expectedKey);
    });

    it.each([
        ['1 unsupported recurrence rule', 'settings.importDiagnostics.unsupportedRecurrence'],
        ['2 dates could not be mapped', 'settings.importDiagnostics.unmappedDate'],
        ['3 statuses could not be mapped', 'settings.importDiagnostics.unmappedStatus'],
        ['4 duplicate CSV IDs were skipped', 'settings.importDiagnostics.duplicateIdentity'],
        ['5 previously imported tasks were skipped', 'settings.importDiagnostics.skippedExistingRecords'],
        ['6 non-CSV archive entries were skipped', 'settings.importDiagnostics.skippedArchiveEntries'],
        ['7 files could not be parsed', 'settings.importDiagnostics.invalidArchiveEntries'],
        ['8 tasks had no matching parent', 'settings.importDiagnostics.missingParent'],
        ['9 empty rows were skipped', 'settings.importDiagnostics.emptyRecords'],
        ['2 unknown columns were ignored.', 'settings.importDiagnostics.unknownColumns'],
        ['1 unknown column was ignored.', 'settings.importDiagnostics.unknownColumns'],
    ])('formats %s with its code-specific localized meaning', (message, expectedKey) => {
        const diagnostic = createImportDiagnostic(message, 'warning');
        expect(formatImportDiagnostic(diagnostic, (key) => key)).toBe(expectedKey);
    });

    it.each([
        '0:2:private-cell', '0:0:2', '0:2:0', '0:2:2,0:3:2,0:4:2,0:5:2,0:6:2,0:7:2',
        '0:2222222222:2', '-1:2:2', '0:2:2; private-cell',
    ])('discards malformed or unbounded location samples: %s', (locations) => {
        const diagnostic = createImportDiagnostic(`1 date value could not be parsed and was skipped. [csv-locations=${locations}; omitted=0]`, 'warning');
        expect(diagnostic.params).toEqual({ count: 1 });
        expect(formatImportDiagnostic({ ...diagnostic, params: { count: 1, locations, omittedLocations: 0 } }, (key) => key))
            .toBe('settings.importDiagnostics.unmappedDate');
    });

    it.each([
        [1, '1 task was skipped because it was imported earlier and then deleted here; deletions are kept on re-import.'],
        [2, '2 tasks were skipped because they were imported earlier and then deleted here; deletions are kept on re-import.'],
    ] as const)('localizes actual deleted-import warning with count %s as skipped existing records', (count, message) => {
        const diagnostic = createImportDiagnostic(message, 'warning');
        expect(diagnostic).toEqual({ code: 'skipped-existing-records', params: { count }, severity: 'warning' });
        expect(formatImportDiagnostic(diagnostic, (key, values) => `${key}:${values?.count}`))
            .toBe(`settings.importDiagnostics.skippedExistingRecords:${count}`);
    });
});
