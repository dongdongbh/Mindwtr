export type ImportDiagnosticSeverity = 'error' | 'warning';

export type ImportDiagnosticCode =
    | 'adjusted-records'
    | 'archive-limit-exceeded'
    | 'backup-empty-active-records'
    | 'backup-newer-version'
    | 'backup-older-version'
    | 'backup-source-size-unknown'
    | 'backup-source-too-large'
    | 'duplicate-identity'
    | 'empty-records'
    | 'invalid-archive-entry'
    | 'missing-parent'
    | 'missing-required-column'
    | 'no-importable-records'
    | 'parse-failed'
    | 'renamed-container'
    | 'resource-limit-exceeded'
    | 'skipped-archive-entry'
    | 'skipped-existing-records'
    | 'unknown-columns'
    | 'unmapped-date'
    | 'unmapped-status'
    | 'unsupported-recurrence';

export type ImportDiagnostic = {
    code: ImportDiagnosticCode;
    params: Record<string, number | string>;
    severity: ImportDiagnosticSeverity;
};

const countFromMessage = (message: string): number => {
    const match = /^\s*(\d+)/u.exec(message);
    return match ? Number(match[1]) : 1;
};

// Bounded numeric CSV entry/record/column positions, with no source text accepted.
export const importDiagnosticLocationParams = (message: string): Record<string, number | string> => {
    const match = / \[csv-locations=((?:\d{1,9}:\d{1,9}:\d{1,9})(?:,\d{1,9}:\d{1,9}:\d{1,9}){0,4}); omitted=(\d{1,9})\]$/u.exec(message);
    if (!match || match[1].split(',').some((location) => {
        const [, row, column] = location.split(':').map(Number);
        return row < 1 || column < 1;
    })) return {};
    return { locations: match[1], omittedLocations: Number(match[2]) };
};

export const createImportDiagnostic = (
    message: string,
    severity: ImportDiagnosticSeverity,
): ImportDiagnostic => {
    const normalized = message.toLowerCase();
    const count = countFromMessage(message);
    if (severity === 'error') {
        const missingColumn = /missing the required column:\s*([^.!]+)/iu.exec(message);
        if (missingColumn) {
            return {
                code: 'missing-required-column',
                params: { column: missingColumn[1].trim() },
                severity,
            };
        }
        if (/no importable|contained no tasks|contains no tasks/u.test(normalized)) {
            return { code: 'no-importable-records', params: {}, severity };
        }
        if (/archive.*(?:too many|too large|expands to too much)/u.test(normalized)) {
            return { code: 'archive-limit-exceeded', params: {}, severity };
        }
        if (/too (?:large|many)|checklist contains/u.test(normalized)) {
            return { code: 'resource-limit-exceeded', params: {}, severity };
        }
        return { code: 'parse-failed', params: {}, severity };
    }

    const renamed = /imported (area|project) [“"](.+?)[”"] was renamed to [“"](.+?)[”"]/iu.exec(message);
    if (renamed) {
        return {
            code: 'renamed-container',
            params: { kind: renamed[1].toLowerCase(), from: renamed[2], to: renamed[3] },
            severity,
        };
    }
    if (/recurr|repeat rule/u.test(normalized)) {
        return { code: 'unsupported-recurrence', params: { count }, severity };
    }
    if (/^\d+ unknown columns? (?:was|were) ignored\./u.test(normalized)) {
        return { code: 'unknown-columns', params: { count, ...importDiagnosticLocationParams(message) }, severity };
    }
    if (/date.*(?:could not|skipped)/u.test(normalized)) {
        return { code: 'unmapped-date', params: { count, ...importDiagnosticLocationParams(message) }, severity };
    }
    if (/status.*could not/u.test(normalized)) {
        return { code: 'unmapped-status', params: { count }, severity };
    }
    if (/duplicat|repeated csv id/u.test(normalized)) {
        return { code: 'duplicate-identity', params: { count }, severity };
    }
    if (/already imported|previously imported|imported earlier and then deleted here|deleted or permanently removed/u.test(normalized)) {
        return { code: 'skipped-existing-records', params: { count }, severity };
    }
    if (/nested zip|non-csv|non-json/u.test(normalized)) {
        return { code: 'skipped-archive-entry', params: { count }, severity };
    }
    if (/could not be parsed|unclosed quoted/u.test(normalized)) {
        return { code: 'invalid-archive-entry', params: { count }, severity };
    }
    if (/no parent|no matching parent|no preceding task|no project/u.test(normalized)) {
        return { code: 'missing-parent', params: { count }, severity };
    }
    if (/empty|no importable/u.test(normalized)) {
        return { code: 'empty-records', params: { count }, severity };
    }
    return { code: 'adjusted-records', params: { count }, severity };
};

export const createImportDiagnostics = (
    messages: readonly string[],
    severity: ImportDiagnosticSeverity,
): ImportDiagnostic[] => messages.map((message) => createImportDiagnostic(message, severity));

export type ImportDiagnosticTranslator = (
    key: string,
    values?: Record<string, number | string>,
) => string;

export const formatImportDiagnostic = (
    diagnostic: ImportDiagnostic,
    translate: ImportDiagnosticTranslator,
): string => {
    if (diagnostic.severity === 'error') {
        if (diagnostic.code === 'backup-source-size-unknown') {
            return translate('settings.backupDiagnostics.unknownSize');
        }
        if (diagnostic.code === 'backup-source-too-large') {
            return translate('settings.backupDiagnostics.tooLarge', diagnostic.params);
        }
        if (diagnostic.code === 'missing-required-column') {
            return translate('settings.importDiagnostics.missingColumn', diagnostic.params);
        }
        if (diagnostic.code === 'no-importable-records') {
            return translate('settings.importDiagnostics.noImportableRecords');
        }
        if (diagnostic.code === 'resource-limit-exceeded' || diagnostic.code === 'archive-limit-exceeded') {
            return translate('settings.importDiagnostics.limitExceeded');
        }
        return translate('settings.importDiagnostics.cannotRead');
    }
    if (diagnostic.code === 'backup-empty-active-records') {
        return translate('settings.backupDiagnostics.noActiveRecords');
    }
    if (diagnostic.code === 'backup-newer-version') {
        return translate('settings.backupDiagnostics.newerVersion', diagnostic.params);
    }
    if (diagnostic.code === 'backup-older-version') {
        return translate('settings.backupDiagnostics.olderVersion', diagnostic.params);
    }
    if (diagnostic.code === 'renamed-container') {
        return translate('settings.importDiagnostics.renamedContainer', diagnostic.params);
    }
    const warningKeys: Partial<Record<ImportDiagnosticCode, string>> = {
        'duplicate-identity': 'settings.importDiagnostics.duplicateIdentity',
        'empty-records': 'settings.importDiagnostics.emptyRecords',
        'invalid-archive-entry': 'settings.importDiagnostics.invalidArchiveEntries',
        'missing-parent': 'settings.importDiagnostics.missingParent',
        'skipped-archive-entry': 'settings.importDiagnostics.skippedArchiveEntries',
        'skipped-existing-records': 'settings.importDiagnostics.skippedExistingRecords',
        'unknown-columns': 'settings.importDiagnostics.unknownColumns',
        'unmapped-date': 'settings.importDiagnostics.unmappedDate',
        'unmapped-status': 'settings.importDiagnostics.unmappedStatus',
        'unsupported-recurrence': 'settings.importDiagnostics.unsupportedRecurrence',
    };
    const warningKey = warningKeys[diagnostic.code];
    if (warningKey) {
        const summary = translate(warningKey, {
            count: typeof diagnostic.params.count === 'number' ? diagnostic.params.count : 1,
        });
        const { locations, omittedLocations } = diagnostic.params;
        if ((diagnostic.code === 'unknown-columns' || diagnostic.code === 'unmapped-date') && typeof locations === 'string') {
            const safeParams = importDiagnosticLocationParams(` [csv-locations=${locations}; omitted=${omittedLocations}]`);
            if (typeof safeParams.locations === 'string') {
                const samples = safeParams.locations.split(',').map((location) => {
                    const [entry, row, column] = location.split(':').map(Number);
                    return translate(entry ? 'settings.importDiagnostics.csvArchiveLocation' : 'settings.importDiagnostics.csvLocation', { entry, row, column });
                });
                const detail = translate('settings.importDiagnostics.csvLocations', { locations: samples.join('; ') });
                const more = typeof safeParams.omittedLocations === 'number' && safeParams.omittedLocations > 0
                    ? ` ${translate('settings.importDiagnostics.csvLocationsMore', { count: safeParams.omittedLocations })}` : '';
                return `${summary} ${detail}${more}`;
            }
        }
        return summary;
    }
    return translate('settings.importDiagnostics.adjustedRecords', {
        count: typeof diagnostic.params.count === 'number' ? diagnostic.params.count : 1,
    });
};
