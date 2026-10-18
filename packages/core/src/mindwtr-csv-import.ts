// Generic "Mindwtr CSV" importer for users migrating from apps with no dedicated importer.
// Structural template: ticktick-import.ts (parse -> {parsedData, preview, errors, warnings}).
// Apply delegates to the shared import-apply.ts seam, which also creates this importer's
// Sections (the only ImportSource caller that supplies any).
import { safeParseDate } from './date';
import { MINDWTR_CSV_FLUID_RECURRENCE_TOKEN, MINDWTR_CSV_KNOWN_COLUMNS } from './mindwtr-csv-columns';
import { applyImport, type ImportExecutionResult, type ImportParseResult } from './import-apply';
import {
    appendWarning,
    assertImportChecklistItemCount,
    basename,
    buildHeaderIndex,
    createImportArchiveBudget,
    dedupeStrings,
    decodeTextBytes,
    detectDelimiter,
    formatLocalDate,
    formatLocalDateTime,
    getCell,
    ImportSourceLimitError,
    normalizeContextName,
    normalizeHeaderCell,
    parseCsvRows,
    readImportSource,
    sanitizeCsvText,
    toImportBytes,
    type ImportArchiveBudget,
} from './import-source-reader';
import { normalizeRecurrenceForLoad } from './recurrence';
import { createProjectOrderReserver, normalizeTagId } from './store-helpers';
import { nextRevision } from './sync-revision';
import { buildTaskContainerMovePatch } from './task-container-rules';
import type { AppData, ChecklistItem, Task, TaskEnergyLevel, TaskPriority, TaskStatus } from './types';
import { generateDeterministicUUID, generateUUID as uuidv4 } from './uuid';

const MINDWTR_CSV_IMPORT_ID_NAMESPACE = 'mindwtr:csv-import:v1';
const MINDWTR_CSV_AREA_FALLBACK = 'Mindwtr CSV Area';
const MINDWTR_CSV_PROJECT_FALLBACK = 'Mindwtr CSV Import';
const MINDWTR_CSV_IMPORT_SUFFIX = ' (Mindwtr CSV)';

const createMindwtrCsvImportId = (kind: 'area' | 'project' | 'section' | 'task', sourceKey: string): string => (
    generateDeterministicUUID(`${MINDWTR_CSV_IMPORT_ID_NAMESPACE}:${kind}:${sourceKey}`)
);

type MindwtrCsvFileInput = {
    bytes?: ArrayBuffer | Uint8Array | null;
    fileName: string;
    text?: string | null;
};

type MindwtrCsvWarningCounters = {
    duplicateIds: number;
    emptyTitleRows: number;
    invalidCsvFiles: number;
    nestedZipFiles: number;
    nonCsvEntries: number;
    sectionWithoutProject: number;
    unclosedQuotedFiles: number;
    unknownColumns: number;
    unknownColumnLocations: string[];
    unknownStatuses: number;
    unparsedDates: number;
    unparsedDateLocations: string[];
    unsupportedRecurrenceRules: number;
    unsupportedRecurrenceSamples: string[];
};

export type ParsedMindwtrCsvArea = {
    name: string;
    order: number;
    sourceKey: string;
};

export type ParsedMindwtrCsvProject = {
    areaSourceKey?: string;
    name: string;
    order: number;
    sourceKey: string;
};

export type ParsedMindwtrCsvSection = {
    name: string;
    order: number;
    projectSourceKey: string;
    sourceKey: string;
};

export type ParsedMindwtrCsvTask = {
    areaSourceKey?: string;
    assignedTo?: string;
    cancelledAt?: string;
    checklist: ChecklistItem[];
    completedAt?: string;
    contexts: string[];
    createdAt?: string;
    description?: string;
    dueDate?: string;
    energyLevel?: TaskEnergyLevel;
    location?: string;
    order: number;
    priority?: TaskPriority;
    projectSourceKey?: string;
    recurrence?: Task['recurrence'];
    reviewAt?: string;
    sectionSourceKey?: string;
    sourceId: string;
    sourceIdentityKind: 'explicit-id' | 'row-fallback';
    sourceKey: string;
    compatibilitySourceKeys?: string[];
    startTime?: string;
    status: TaskStatus;
    tags: string[];
    title: string;
};

export type ParsedMindwtrCsvImportData = {
    areas: ParsedMindwtrCsvArea[];
    projects: ParsedMindwtrCsvProject[];
    sections: ParsedMindwtrCsvSection[];
    tasks: ParsedMindwtrCsvTask[];
    warnings: string[];
};

export type MindwtrCsvImportProjectPreview = {
    areaName?: string;
    name: string;
    taskCount: number;
};

export type MindwtrCsvImportPreview = {
    areaCount: number;
    checklistItemCount: number;
    fileName: string;
    projectCount: number;
    projects: MindwtrCsvImportProjectPreview[];
    sectionCount: number;
    standaloneTaskCount: number;
    taskCount: number;
    warnings: string[];
};

export type MindwtrCsvImportParseResult = ImportParseResult<ParsedMindwtrCsvImportData, MindwtrCsvImportPreview>;

export type MindwtrCsvImportExecutionResult = ImportExecutionResult & { importedSectionCount: number };

const KNOWN_COLUMNS = MINDWTR_CSV_KNOWN_COLUMNS;

const VALID_STATUSES = new Set<TaskStatus>(['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived']);

const createWarningCounters = (): MindwtrCsvWarningCounters => ({
    duplicateIds: 0,
    emptyTitleRows: 0,
    invalidCsvFiles: 0,
    nestedZipFiles: 0,
    nonCsvEntries: 0,
    sectionWithoutProject: 0,
    unclosedQuotedFiles: 0,
    unknownColumns: 0,
    unknownColumnLocations: [],
    unknownStatuses: 0,
    unparsedDates: 0,
    unparsedDateLocations: [],
    unsupportedRecurrenceRules: 0,
    unsupportedRecurrenceSamples: [],
});

const buildWarnings = (counters: MindwtrCsvWarningCounters): string[] => {
    const warnings: string[] = [];
    appendWarning(warnings, counters.unknownColumns, '1 unknown column was ignored.', '{count} unknown columns were ignored.');
    appendLocationDetails(warnings, counters.unknownColumns, counters.unknownColumnLocations);
    appendWarning(warnings, counters.unknownStatuses, '1 task status could not be mapped and was imported to Inbox.', '{count} task statuses could not be mapped and were imported to Inbox.');
    appendWarning(warnings, counters.sectionWithoutProject, '1 Section was ignored because its row had no Project.', '{count} Sections were ignored because their rows had no Project.');
    appendWarning(warnings, counters.unsupportedRecurrenceRules, '1 Recurrence rule could not be understood; that task was imported without recurrence.', '{count} Recurrence rules could not be understood; those tasks were imported without recurrence.');
    if (counters.unsupportedRecurrenceSamples.length > 0) {
        warnings.push(`Unsupported Recurrence rules: ${counters.unsupportedRecurrenceSamples.join('; ')}.`);
    }
    appendWarning(warnings, counters.unparsedDates, '1 date value could not be parsed and was skipped.', '{count} date values could not be parsed and were skipped.');
    appendLocationDetails(warnings, counters.unparsedDates, counters.unparsedDateLocations);
    appendWarning(warnings, counters.duplicateIds, '1 row had an ID that duplicated an earlier row in this import and was dropped.', '{count} rows had an ID that duplicated an earlier row in this import and were dropped.');
    appendWarning(warnings, counters.emptyTitleRows, '1 row with an empty title was skipped.', '{count} rows with empty titles were skipped.');
    appendWarning(warnings, counters.nonCsvEntries, '1 non-CSV file inside the ZIP was skipped.', '{count} non-CSV files inside the ZIP were skipped.');
    appendWarning(warnings, counters.nestedZipFiles, '1 nested ZIP file inside the archive was skipped.', '{count} nested ZIP files inside the archive were skipped.');
    appendWarning(warnings, counters.unclosedQuotedFiles, '1 CSV file ended with an unclosed quoted field and was imported best-effort.', '{count} CSV files ended with unclosed quoted fields and were imported best-effort.');
    appendWarning(warnings, counters.invalidCsvFiles, '1 CSV file could not be parsed and was skipped.', '{count} CSV files could not be parsed and were skipped.');
    return warnings;
};

// Tab is checked locally (the shared detectDelimiter never needs it); comma vs semicolon
// delegates to that shared heuristic instead of duplicating it.
const detectMindwtrCsvDelimiter = (text: string): string => {
    const firstLine = sanitizeCsvText(text).split(/\r?\n/u).find((line) => line.trim().length > 0);
    if (firstLine) {
        const tabCount = (firstLine.match(/\t/gu) || []).length;
        const commaCount = (firstLine.match(/,/gu) || []).length;
        const semicolonCount = (firstLine.match(/;/gu) || []).length;
        if (tabCount > commaCount && tabCount > semicolonCount) return '\t';
    }
    return detectDelimiter(text);
};

const WARNING_LOCATION_LIMIT = 5;

// Only numeric positions cross the warning/localization seam; never copy source contents.
const appendLocationDetails = (warnings: string[], count: number, locations: string[]): void => {
    if (locations.length > 0) {
        warnings[warnings.length - 1] += ` [csv-locations=${locations.join(',')}; omitted=${count - locations.length}]`;
    }
};

const countUnknownColumns = (headerRow: string[], counters: MindwtrCsvWarningCounters, source: MindwtrCsvRowSource): void => {
    headerRow.forEach((cell, columnIndex) => {
        const normalized = normalizeHeaderCell(cell);
        if (normalized && !KNOWN_COLUMNS.has(normalized)) {
            counters.unknownColumns += 1;
            if (counters.unknownColumnLocations.length < WARNING_LOCATION_LIMIT) {
                counters.unknownColumnLocations.push(`${source.csvEntryIndex ?? 0}:1:${columnIndex + 1}`);
            }
        }
    });
};

const normalizeSourceKey = (value: string): string => value.trim().toLowerCase();

// Source keys are tuples, not display paths. Escaping each component before joining keeps
// `['work:north', 'ops']` distinct from `['work', 'north:ops']` while preserving the IDs
// produced for the overwhelmingly common delimiter-free names.
const encodeSourceKeyTuple = (...components: string[]): string => (
    components.map((component) => encodeURIComponent(component)).join(':')
);

const projectSourceKeyFor = (areaSourceKey: string | undefined, projectName: string): string => (
    encodeSourceKeyTuple(...(areaSourceKey ? [areaSourceKey] : []), normalizeSourceKey(projectName))
);

const legacyCanonicalTaskSourceKeyFor = (sourceId: string): string => encodeSourceKeyTuple(sourceId);

const explicitTaskSourceKeyFor = (sourceId: string): string => (
    encodeSourceKeyTuple('explicit-id', sourceId)
);

const rowTaskSourceKeyFor = (
    sourceKind: 'standalone-file' | 'zip-entry',
    sourceName: string,
    rowNumber: number,
): string => encodeSourceKeyTuple('row-fallback', sourceKind, sourceName, String(rowNumber));

const fingerprintImportBytes = (bytes: Uint8Array): string => {
    let h1 = 1779033703;
    let h2 = 3144134277;
    let h3 = 1013904242;
    let h4 = 2773480762;
    for (const byte of bytes) {
        h1 = h2 ^ Math.imul(h1 ^ byte, 597399067);
        h2 = h3 ^ Math.imul(h2 ^ byte, 2869860233);
        h3 = h4 ^ Math.imul(h3 ^ byte, 951274213);
        h4 = h1 ^ Math.imul(h4 ^ byte, 2716044179);
    }
    return [h1, h2, h3, h4]
        .map((part) => (part >>> 0).toString(16).padStart(8, '0'))
        .join('');
};

const normalizeArchiveEntryIdentity = (entryName: string): string => entryName
    .replace(/\\/gu, '/')
    .split('/')
    .filter((component) => component.length > 0 && component !== '.')
    .join('/');

const couldBeLegacyRowFallback = (sourceId: string): boolean => /(?:^|:)row-\d+$/u.test(sourceId);

const colonProjectSourceKeyFor = (areaSourceKey: string | undefined, projectName: string): string => (
    `${areaSourceKey ? `${areaSourceKey}:` : ''}${normalizeSourceKey(projectName)}`
);

const toNumber = (value: string, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const splitTokens = (value: string): string[] => value.split(/[,;]+/u).map((token) => token.trim()).filter(Boolean);

const parseContexts = (value: string): string[] => dedupeStrings(
    splitTokens(value).map((context) => normalizeContextName(context)).filter(Boolean) as string[]
);

const parseTags = (value: string): string[] => dedupeStrings(
    splitTokens(value).map((tag) => normalizeTagId(tag.replace(/^#+/u, '')))
);

const parsePriority = (value: string): TaskPriority | undefined => {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === 'high' || trimmed === '1') return 'high';
    if (trimmed === 'medium' || trimmed === '2') return 'medium';
    if (trimmed === 'low' || trimmed === '3') return 'low';
    return undefined;
};

const parseEnergy = (value: string): TaskEnergyLevel | undefined => {
    const trimmed = value.trim().toLowerCase();
    return trimmed === 'high' || trimmed === 'medium' || trimmed === 'low' ? trimmed : undefined;
};

const CHECKLIST_ITEM_PATTERN = /^\[([ xX])\]\s*(.*)$/u;

const parseChecklist = (value: string, archiveBudget: ImportArchiveBudget): ChecklistItem[] => {
    if (!value.trim()) return [];
    const itemCount = assertImportChecklistItemCount(value);
    // Charge the archive-wide allowance while the checklist is still one
    // string. A rejected archive must not first allocate split strings, UUIDs,
    // and checklist objects that it is guaranteed to discard.
    archiveBudget.consumeChecklistItems(itemCount);
    return value.replace(/\r/gu, '\n').split(/\n|\|/u)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const match = CHECKLIST_ITEM_PATTERN.exec(line);
            if (!match) return { id: uuidv4(), title: line, isCompleted: false };
            return { id: uuidv4(), title: match[2].trim() || line, isCompleted: match[1].toLowerCase() === 'x' };
        })
        .filter((item) => item.title);
};

const resolveStatus = (
    raw: string,
    hasProject: boolean,
    hasCompletedAt: boolean,
    hasCancelledAt: boolean,
    counters: MindwtrCsvWarningCounters
): TaskStatus => {
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed) return hasCancelledAt ? 'archived' : hasCompletedAt ? 'done' : hasProject ? 'next' : 'inbox';
    if (VALID_STATUSES.has(trimmed as TaskStatus)) return trimmed as TaskStatus;
    counters.unknownStatuses += 1;
    return 'inbox';
};

// Mirrors the date-only/datetime split omnifocus-import.ts's normalizeMappedDate already
// established: a date-only value never gains an implicit midnight/time component, and a
// datetime with no explicit offset keeps its literal wall-clock digits instead of shifting
// through UTC. Used for startTime/dueDate/reviewAt only — NOT for entity timestamps, which
// must be a real instant (see normalizeEntityTimestamp below).
// SQL exports (the main source feeding this importer) write timestamps like
// "2026-02-21 22:44:00.6390000 +00:00": fractional seconds beyond milliseconds and a
// space before the offset, neither of which safeParseDate accepts. Normalize both away
// here rather than loosening the app-wide parser.
const normalizeSqlTimestampShape = (value: string): string => value
    .replace(/(\.\d{3})\d+/u, '$1')
    .replace(/ (Z|[+-]\d{2}:?\d{2})$/iu, '$1');

const isValidCalendarDate = (value: string): boolean => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1) return false;
    const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return day <= (daysInMonth[month - 1] ?? 0);
};

const isValidClockTime = (value: string): boolean => {
    const match = /^(\d{2})(?::(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?)?$/u.exec(value);
    if (!match) return false;
    const hour = Number(match[1]);
    const minute = match[2] ? Number(match[2]) : 0;
    const second = match[3] ? Number(match[3]) : 0;
    return hour < 24 && minute < 60 && second < 60;
};

const hasValidCalendarComponents = (value: string): boolean => {
    const match = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}(?::\d{2}(?::\d{2}(?:\.\d{1,3})?)?)?))?(?:Z|[+-](\d{2}):?(\d{2}))?$/iu.exec(value);
    if (!match) return true;
    const offsetHour = match[3] ? Number(match[3]) : 0;
    const offsetMinute = match[4] ? Number(match[4]) : 0;
    return isValidCalendarDate(match[1])
        && (!match[2] || isValidClockTime(match[2]))
        && offsetHour < 24
        && offsetMinute < 60;
};

const parseCsvDateValue = (value: string): string | undefined => {
    const trimmed = normalizeSqlTimestampShape(value.trim());
    if (!trimmed) return undefined;
    const dateOnlyMatch = /^(\d{4}-\d{2}-\d{2})$/u.exec(trimmed);
    if (dateOnlyMatch) return isValidCalendarDate(dateOnlyMatch[1]) ? dateOnlyMatch[1] : undefined;
    const dateTimeMatch = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)$/u.exec(trimmed);
    if (dateTimeMatch) {
        return isValidCalendarDate(dateTimeMatch[1]) && isValidClockTime(dateTimeMatch[2])
            ? `${dateTimeMatch[1]}T${dateTimeMatch[2]}`
            : undefined;
    }
    if (!hasValidCalendarComponents(trimmed)) return undefined;
    const parsed = safeParseDate(trimmed);
    if (!parsed) return undefined;
    if (/Z$|[+-]\d{2}:?\d{2}$/iu.test(trimmed)) return parsed.toISOString();
    return /\d{1,2}:\d{2}/u.test(trimmed) ? formatLocalDateTime(parsed) : formatLocalDate(parsed);
};

// Entity timestamps (createdAt, and completedAt which feeds updatedAt via applyImport's
// fallback) must be a real, unambiguous instant. A bare "2026-08-01" written verbatim into
// storage reads back as UTC midnight in some readers (sync.ts's `new Date(...)`) and local
// midnight in others (safeParseDate) — one string, two different instants. Normalizing through
// safeParseDate + toISOString here, once, means every reader agrees forever after.
const normalizeEntityTimestamp = (value: string): string | undefined => {
    const normalized = normalizeSqlTimestampShape(value.trim());
    if (!hasValidCalendarComponents(normalized)) return undefined;
    return safeParseDate(normalized)?.toISOString();
};

// SQL exports render missing values as the literal string NULL; treating those cells as
// empty keeps them from becoming task titles, tags, or contexts named "NULL".
const readCell = (row: string[], headerIndex: Map<string, number>, key: string): string => {
    const value = getCell(row, headerIndex, key);
    return /^null$/iu.test(value) ? '' : value;
};

const recordUnparsedDate = (counters: MindwtrCsvWarningCounters, location: string): void => {
    counters.unparsedDates += 1;
    if (counters.unparsedDateLocations.length < WARNING_LOCATION_LIMIT) counters.unparsedDateLocations.push(location);
};

const parseDateCell = (raw: string, counters: MindwtrCsvWarningCounters, location: string): string | undefined => {
    const value = parseCsvDateValue(raw);
    if (!value && raw.trim()) recordUnparsedDate(counters, location);
    return value;
};

const parseTimestampCell = (raw: string, counters: MindwtrCsvWarningCounters, location: string): string | undefined => {
    const value = normalizeEntityTimestamp(raw);
    if (!value && raw.trim()) recordUnparsedDate(counters, location);
    return value;
};

type MindwtrCsvRowSource = {
    csvEntryIndex?: number;
    documentFingerprint: string;
    kind: 'standalone-file' | 'zip-entry';
    name: string;
};

// Everything the Mindwtr recurrence model can act on. A rule carrying anything else
// (BYSETPOS, BYMONTH, a frequency below daily) would import as the nearest rule the model
// CAN express — "second Tuesday" silently becoming "every Tuesday" — so the row is named in
// a warning and its task is imported without recurrence instead.
const SUPPORTED_RRULE_KEYS = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'COUNT', 'UNTIL', 'WKST']);
const UNSUPPORTED_RECURRENCE_SAMPLE_LIMIT = 3;

const parseRecurrenceCell = (
    raw: string,
    counters: MindwtrCsvWarningCounters,
    rowNumber: number,
    source: MindwtrCsvRowSource,
): Task['recurrence'] => {
    const value = raw.trim();
    if (!value) return undefined;

    const parts = value.split(';').map((part) => part.trim()).filter(Boolean);
    const isFluid = parts.some((part) => part.toUpperCase() === MINDWTR_CSV_FLUID_RECURRENCE_TOKEN);
    const ruleParts = parts.filter((part) => part.toUpperCase() !== MINDWTR_CSV_FLUID_RECURRENCE_TOKEN);
    const recurrence = ruleParts.every((part) => SUPPORTED_RRULE_KEYS.has(part.split('=')[0].toUpperCase()))
        ? normalizeRecurrenceForLoad(ruleParts.join(';'))
        : undefined;

    if (!recurrence) {
        counters.unsupportedRecurrenceRules += 1;
        if (counters.unsupportedRecurrenceSamples.length < UNSUPPORTED_RECURRENCE_SAMPLE_LIMIT) {
            counters.unsupportedRecurrenceSamples.push(
                `${source.kind === 'zip-entry' ? `${source.name} ` : ''}row ${rowNumber}: ${value}`,
            );
        }
        return undefined;
    }

    return isFluid ? { ...recurrence, strategy: 'fluid' } : recurrence;
};

const parseMindwtrCsvRows = (
    csvText: string,
    counters: MindwtrCsvWarningCounters,
    source: MindwtrCsvRowSource,
    archiveBudget: ImportArchiveBudget,
): ParsedMindwtrCsvImportData => {
    const delimiter = detectMindwtrCsvDelimiter(csvText);
    const recordNumbers: number[] = [];
    const { rows, hasUnclosedQuote } = parseCsvRows(sanitizeCsvText(csvText), delimiter, undefined, archiveBudget, recordNumbers);
    if (hasUnclosedQuote) counters.unclosedQuotedFiles += 1;
    if (rows.length === 0) {
        return { areas: [], projects: [], sections: [], tasks: [], warnings: [] };
    }

    const headerIndex = buildHeaderIndex(rows[0] || []);
    if (!headerIndex.has('TITLE')) {
        throw new Error('Mindwtr CSV is missing the required column: Title');
    }
    countUnknownColumns(rows[0] || [], counters, source);

    const areasByKey = new Map<string, ParsedMindwtrCsvArea>();
    const projectsByKey = new Map<string, ParsedMindwtrCsvProject>();
    const sectionsByKey = new Map<string, ParsedMindwtrCsvSection>();
    const sectionCountByProject = new Map<string, number>();
    const tasks: ParsedMindwtrCsvTask[] = [];

    for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex] || [];
        const title = readCell(row, headerIndex, 'TITLE').trim();
        if (!title) {
            if (row.some((cell) => String(cell || '').trim().length > 0)) counters.emptyTitleRows += 1;
            continue;
        }

        const projectName = readCell(row, headerIndex, 'PROJECT').trim();
        const sectionName = readCell(row, headerIndex, 'SECTION').trim();
        const areaName = readCell(row, headerIndex, 'AREA').trim();

        const areaSourceKey = areaName ? normalizeSourceKey(areaName) : undefined;
        const projectSourceKey = projectName
            ? projectSourceKeyFor(areaSourceKey, projectName)
            : undefined;
        let sectionSourceKey: string | undefined;
        if (sectionName) {
            if (projectSourceKey) {
                sectionSourceKey = encodeSourceKeyTuple(
                    ...(areaSourceKey ? [areaSourceKey] : []),
                    normalizeSourceKey(projectName),
                    normalizeSourceKey(sectionName),
                );
            } else {
                counters.sectionWithoutProject += 1;
            }
        }

        if (areaSourceKey && !areasByKey.has(areaSourceKey)) {
            areasByKey.set(areaSourceKey, { sourceKey: areaSourceKey, name: areaName, order: areasByKey.size });
        }
        if (projectSourceKey && !projectsByKey.has(projectSourceKey)) {
            projectsByKey.set(projectSourceKey, {
                sourceKey: projectSourceKey,
                name: projectName,
                order: projectsByKey.size,
                ...(areaSourceKey ? { areaSourceKey } : {}),
            });
        }
        if (sectionSourceKey && !sectionsByKey.has(sectionSourceKey)) {
            const order = sectionCountByProject.get(projectSourceKey as string) ?? 0;
            sectionCountByProject.set(projectSourceKey as string, order + 1);
            sectionsByKey.set(sectionSourceKey, {
                sourceKey: sectionSourceKey,
                projectSourceKey: projectSourceKey as string,
                name: sectionName,
                order,
            });
        }

        const rowNumber = rowIndex + 1;
        const recordNumber = recordNumbers[rowIndex] - recordNumbers[0] + 1;
        const dateLocation = (column: string): string => `${source.csvEntryIndex ?? 0}:${recordNumber}:${(headerIndex.get(column) ?? 0) + 1}`;
        const completedAt = parseTimestampCell(readCell(row, headerIndex, 'COMPLETED AT'), counters, dateLocation('COMPLETED AT'));
        const cancelledAt = parseTimestampCell(readCell(row, headerIndex, 'CANCELLED AT'), counters, dateLocation('CANCELLED AT'));
        const status = resolveStatus(
            readCell(row, headerIndex, 'STATUS'),
            Boolean(projectSourceKey),
            Boolean(completedAt),
            Boolean(cancelledAt),
            counters,
        );
        const idColumn = readCell(row, headerIndex, 'ID').trim();
        const sourceIdentityKind = idColumn ? 'explicit-id' : 'row-fallback';
        const sourceId = idColumn || `${source.kind === 'zip-entry' ? `${source.name}:` : ''}row-${rowNumber}`;
        const sourceKey = idColumn
            ? explicitTaskSourceKeyFor(idColumn)
            : encodeSourceKeyTuple(
                'row-fallback-v2',
                source.kind,
                source.documentFingerprint,
                ...(source.kind === 'zip-entry' ? [normalizeArchiveEntryIdentity(source.name)] : []),
                String(rowNumber),
            );

        tasks.push({
            areaSourceKey,
            assignedTo: readCell(row, headerIndex, 'ASSIGNED TO').trim() || undefined,
            cancelledAt,
            checklist: parseChecklist(readCell(row, headerIndex, 'CHECKLIST'), archiveBudget),
            completedAt,
            contexts: parseContexts(readCell(row, headerIndex, 'CONTEXTS')),
            createdAt: parseTimestampCell(readCell(row, headerIndex, 'CREATED AT'), counters, dateLocation('CREATED AT')),
            description: readCell(row, headerIndex, 'DESCRIPTION').trim() || undefined,
            dueDate: parseDateCell(readCell(row, headerIndex, 'DUE DATE'), counters, dateLocation('DUE DATE')),
            energyLevel: parseEnergy(readCell(row, headerIndex, 'ENERGY')),
            location: readCell(row, headerIndex, 'LOCATION').trim() || undefined,
            // Falls back to row index like TickTick's own ORDER column handling; ties after
            // sorting keep CSV row order because Array#sort is a stable sort.
            order: toNumber(readCell(row, headerIndex, 'ORDER'), rowIndex),
            priority: parsePriority(readCell(row, headerIndex, 'PRIORITY')),
            projectSourceKey,
            recurrence: parseRecurrenceCell(readCell(row, headerIndex, 'RECURRENCE'), counters, rowNumber, source),
            reviewAt: parseDateCell(readCell(row, headerIndex, 'REVIEW DATE'), counters, dateLocation('REVIEW DATE')),
            sectionSourceKey,
            sourceId,
            sourceIdentityKind,
            sourceKey,
            ...(!idColumn ? {
                compatibilitySourceKeys: [rowTaskSourceKeyFor(source.kind, source.name, rowNumber)],
            } : {}),
            startTime: parseDateCell(readCell(row, headerIndex, 'START DATE'), counters, dateLocation('START DATE')),
            status,
            tags: parseTags(readCell(row, headerIndex, 'TAGS')),
            title,
        });
    }

    return {
        areas: Array.from(areasByKey.values()),
        projects: Array.from(projectsByKey.values()),
        sections: Array.from(sectionsByKey.values()),
        tasks,
        warnings: [],
    };
};

const mergeParsedData = (target: ParsedMindwtrCsvImportData, source: ParsedMindwtrCsvImportData): void => {
    const areaKeys = new Set(target.areas.map((area) => area.sourceKey));
    const projectKeys = new Set(target.projects.map((project) => project.sourceKey));
    const sectionKeys = new Set(target.sections.map((section) => section.sourceKey));
    source.areas.forEach((area) => {
        if (areaKeys.has(area.sourceKey)) return;
        areaKeys.add(area.sourceKey);
        target.areas.push(area);
    });
    source.projects.forEach((project) => {
        if (projectKeys.has(project.sourceKey)) return;
        projectKeys.add(project.sourceKey);
        target.projects.push(project);
    });
    source.sections.forEach((section) => {
        if (sectionKeys.has(section.sourceKey)) return;
        sectionKeys.add(section.sourceKey);
        target.sections.push(section);
    });
    // One push per task: QuickJS (native Android) refuses a call with more than 65535 arguments.
    source.tasks.forEach((task) => target.tasks.push(task));
};

const dropDuplicateTasksAndUnusedContainers = (
    parsedData: ParsedMindwtrCsvImportData,
    counters: MindwtrCsvWarningCounters,
): void => {
    const seenTaskKeys = new Set<string>();
    parsedData.tasks = parsedData.tasks.filter((task) => {
        if (seenTaskKeys.has(task.sourceKey)) {
            counters.duplicateIds += 1;
            return false;
        }
        seenTaskKeys.add(task.sourceKey);
        return true;
    });

    const usedSectionKeys = new Set(
        parsedData.tasks.flatMap((task) => task.sectionSourceKey ? [task.sectionSourceKey] : []),
    );
    const usedProjectKeys = new Set(
        parsedData.tasks.flatMap((task) => task.projectSourceKey ? [task.projectSourceKey] : []),
    );
    parsedData.sections = parsedData.sections.filter((section) => (
        usedSectionKeys.has(section.sourceKey) && usedProjectKeys.has(section.projectSourceKey)
    ));
    parsedData.projects = parsedData.projects.filter((project) => usedProjectKeys.has(project.sourceKey));

    const usedAreaKeys = new Set(
        parsedData.tasks.flatMap((task) => task.areaSourceKey ? [task.areaSourceKey] : []),
    );
    parsedData.projects.forEach((project) => {
        if (project.areaSourceKey) usedAreaKeys.add(project.areaSourceKey);
    });
    parsedData.areas = parsedData.areas.filter((area) => usedAreaKeys.has(area.sourceKey));
};

const bucketKeyForTask = (task: ParsedMindwtrCsvTask): string => (
    task.projectSourceKey ? `project:${task.projectSourceKey}`
        : task.areaSourceKey ? `area:${task.areaSourceKey}`
            : 'inbox'
);

const buildPreview = (fileName: string, parsedData: ParsedMindwtrCsvImportData): MindwtrCsvImportPreview => {
    const taskCountByProject = new Map<string, number>();
    parsedData.tasks.forEach((task) => {
        if (!task.projectSourceKey) return;
        taskCountByProject.set(task.projectSourceKey, (taskCountByProject.get(task.projectSourceKey) ?? 0) + 1);
    });
    const areaNameByKey = new Map(parsedData.areas.map((area) => [area.sourceKey, area.name]));
    const projects = parsedData.projects.map((project) => ({
        name: project.name,
        areaName: project.areaSourceKey ? areaNameByKey.get(project.areaSourceKey) : undefined,
        taskCount: taskCountByProject.get(project.sourceKey) ?? 0,
    }));
    const checklistItemCount = parsedData.tasks.reduce((sum, task) => sum + task.checklist.length, 0);
    const standaloneTaskCount = parsedData.tasks.filter((task) => !task.projectSourceKey).length;
    return {
        fileName,
        areaCount: parsedData.areas.length,
        projectCount: parsedData.projects.length,
        sectionCount: parsedData.sections.length,
        taskCount: parsedData.tasks.length,
        standaloneTaskCount,
        checklistItemCount,
        projects,
        warnings: parsedData.warnings,
    };
};

export const parseMindwtrCsvImportSource = (input: MindwtrCsvFileInput): MindwtrCsvImportParseResult => {
    const fileName = basename(input.fileName);
    const counters = createWarningCounters();
    const parsedData: ParsedMindwtrCsvImportData = { areas: [], projects: [], sections: [], tasks: [], warnings: [] };
    const archiveBudget = createImportArchiveBudget();

    const parseOneCsv = (csvText: string, source: MindwtrCsvRowSource): void => {
        const parsed = parseMindwtrCsvRows(csvText, counters, source, archiveBudget);
        archiveBudget.consumeEntities(parsed.areas.length + parsed.projects.length + parsed.sections.length + parsed.tasks.length);
        mergeParsedData(parsedData, parsed);
    };

    try {
        const source = readImportSource(input);
        if (source.kind === 'archive') {
            const archiveBytes = toImportBytes(input.bytes);
            const documentFingerprint = archiveBytes
                ? fingerprintImportBytes(archiveBytes)
                : generateDeterministicUUID(source.entries.map(({ entryName, entryBytes }) => (
                    `${normalizeArchiveEntryIdentity(entryName)}:${fingerprintImportBytes(entryBytes)}`
                )).sort().join('|'));
            let csvEntryIndex = 0;
            source.entries.forEach(({ entryName, entryBytes }) => {
                const lowerName = entryName.toLowerCase();
                if (!entryName || entryName.endsWith('/')) return;
                if (lowerName.endsWith('.zip')) {
                    counters.nestedZipFiles += 1;
                    return;
                }
                if (!lowerName.endsWith('.csv')) {
                    counters.nonCsvEntries += 1;
                    return;
                }
                csvEntryIndex += 1;
                try {
                    parseOneCsv(decodeTextBytes(entryBytes), {
                        csvEntryIndex,
                        documentFingerprint,
                        kind: 'zip-entry',
                        name: entryName,
                    });
                } catch (error) {
                    if (error instanceof ImportSourceLimitError) throw error;
                    counters.invalidCsvFiles += 1;
                }
            });
        } else {
            parseOneCsv(source.text, {
                documentFingerprint: generateDeterministicUUID(sanitizeCsvText(source.text)),
                kind: 'standalone-file',
                name: fileName,
            });
        }
    } catch (error) {
        return {
            valid: false,
            parsedData: null,
            preview: null,
            warnings: buildWarnings(counters),
            errors: [error instanceof Error && error.message ? error.message : 'Failed to parse the Mindwtr CSV file.'],
        };
    }

    // Preview and apply share this global task identity, so every duplicate warning corresponds
    // to a row apply will actually drop. Containers referenced only by a dropped row must not
    // inflate the preview or create empty Area/Project/Section records during apply.
    dropDuplicateTasksAndUnusedContainers(parsedData, counters);

    // Stable sort: groups each task's manual Order within its own project/area bucket while
    // preserving original row order as the tiebreak (Array#sort is required to be stable).
    parsedData.tasks.sort((left, right) => {
        const bucketCompare = bucketKeyForTask(left).localeCompare(bucketKeyForTask(right));
        return bucketCompare !== 0 ? bucketCompare : left.order - right.order;
    });

    const warnings = buildWarnings(counters);
    parsedData.warnings = warnings;
    const errors = parsedData.tasks.length === 0 ? ['No importable tasks were found in the selected file.'] : [];
    return {
        valid: errors.length === 0,
        parsedData: errors.length === 0 ? parsedData : null,
        preview: errors.length === 0 ? buildPreview(fileName, parsedData) : null,
        warnings,
        errors,
    };
};

// Delegates entity creation (rev/revBy stamping, tombstone-aware deterministic id dedupe,
// per-bucket order allocation, and now Section creation) entirely to the shared seam.
export const applyMindwtrCsvImport = (
    currentData: AppData,
    parsedData: ParsedMindwtrCsvImportData,
    options: { now?: Date | string } = {}
): MindwtrCsvImportExecutionResult => {
    // Before area scoping, deterministic project/section/task IDs used only the
    // project name. Reuse those IDs when one project name has an unambiguous
    // owner so upgrading does not turn a routine re-import into duplicates.
    const legacyProjectSourceKeyByScopedKey = new Map<string, string>();
    parsedData.projects.forEach((project) => {
        if (!project.areaSourceKey) return;
        legacyProjectSourceKeyByScopedKey.set(project.sourceKey, normalizeSourceKey(project.name));
    });

    const legacySectionSourceKeyByScopedKey = new Map<string, string>();
    parsedData.sections.forEach((section) => {
        const legacyProjectSourceKey = legacyProjectSourceKeyByScopedKey.get(section.projectSourceKey);
        if (!legacyProjectSourceKey) return;
        legacySectionSourceKeyByScopedKey.set(
            section.sourceKey,
            `${legacyProjectSourceKey}:${normalizeSourceKey(section.name)}`,
        );
    });

    const legacyTaskSourceKeyByScopedKey = new Map<string, string>();
    const projectBySourceKey = new Map(parsedData.projects.map((project) => [project.sourceKey, project]));
    const taskSourceKeyFor = (task: ParsedMindwtrCsvTask): string => {
        const project = task.projectSourceKey ? projectBySourceKey.get(task.projectSourceKey) : undefined;
        if (task.sourceKey && (!project || project.sourceKey === projectSourceKeyFor(project.areaSourceKey, project.name))) {
            return task.sourceKey;
        }
        if (project && project.sourceKey !== projectSourceKeyFor(project.areaSourceKey, project.name)) {
            return `${task.projectSourceKey}:${task.sourceId}`;
        }
        // The stable ID (or ZIP-qualified row fallback) owns task identity; moving containers
        // in a corrected export must not manufacture a second task.
        return legacyCanonicalTaskSourceKeyFor(task.sourceId);
    };
    const tasksForImport = parsedData.tasks.map((task) => ({
        ...task,
        sourceKey: taskSourceKeyFor(task),
    }));

    tasksForImport.forEach((task) => {
        if (!task.projectSourceKey) return;
        const legacyProjectSourceKey = legacyProjectSourceKeyByScopedKey.get(task.projectSourceKey);
        if (!legacyProjectSourceKey) return;
        legacyTaskSourceKeyByScopedKey.set(task.sourceKey, `${legacyProjectSourceKey}:${task.sourceId}`);
    });

    const currentProjectById = new Map(currentData.projects.map((project) => [project.id, project]));
    const currentSectionById = new Map(currentData.sections.map((section) => [section.id, section]));
    const currentTaskById = new Map(currentData.tasks.map((task) => [task.id, task]));
    const currentAreaSourceKeyById = new Map(currentData.areas.map((area) => [
        area.id,
        normalizeSourceKey(area.name),
    ]));
    const currentProjectTaskScopes = currentData.projects.map((project) => {
        const areaSourceKey = project.areaId ? currentAreaSourceKeyById.get(project.areaId) : undefined;
        const projectSourceKey = normalizeSourceKey(project.title);
        const colonProjectSourceKey = colonProjectSourceKeyFor(areaSourceKey, project.title);
        return {
            areaSourceKey,
            colonProjectSourceKey,
            projectSourceKey,
            // Precomputed once per project (not once per row × project) so the
            // per-row historical-id scan below only appends the row's sourceId
            // instead of rebuilding these via encodeSourceKeyTuple's
            // array-spread/map/join on every (row, project) pair (BUG-12).
            tuplePrefix: `${encodeSourceKeyTuple(...(areaSourceKey ? [areaSourceKey] : []), projectSourceKey)}:`,
            colonPrefix: `${colonProjectSourceKey}:`,
            plainPrefix: `${projectSourceKey}:`,
        };
    });
    const resolvedIds = {
        area: new Map<string, string>(),
        project: new Map<string, string>(),
        section: new Map<string, string>(),
        task: new Map<string, string>(),
    };

    parsedData.areas.forEach((area) => {
        resolvedIds.area.set(area.sourceKey, createMindwtrCsvImportId('area', area.sourceKey));
    });

    // The immediately preceding importer used raw colon-joined scoped paths. Prefer a current
    // escaped-tuple ID, but recognize that predecessor only when the stored parent ownership
    // proves which tuple it represented. Two previously-colliding paths can therefore reuse at
    // most one old entity; the other receives its new injective ID.
    parsedData.projects.forEach((project) => {
        const scopedId = createMindwtrCsvImportId('project', project.sourceKey);
        if (currentProjectById.has(scopedId)) {
            resolvedIds.project.set(project.sourceKey, scopedId);
            return;
        }
        const expectedAreaId = project.areaSourceKey
            ? resolvedIds.area.get(project.areaSourceKey)
            : undefined;
        const colonSourceKey = colonProjectSourceKeyFor(project.areaSourceKey, project.name);
        const colonId = createMindwtrCsvImportId('project', colonSourceKey);
        const colonProject = currentProjectById.get(colonId);
        if (
            colonSourceKey !== project.sourceKey
            && colonProject
            && (colonProject.areaId ?? undefined) === expectedAreaId
        ) {
            resolvedIds.project.set(project.sourceKey, colonId);
            return;
        }
        const legacySourceKey = legacyProjectSourceKeyByScopedKey.get(project.sourceKey);
        const legacyId = legacySourceKey
            ? createMindwtrCsvImportId('project', legacySourceKey)
            : undefined;
        const legacyProject = legacyId ? currentProjectById.get(legacyId) : undefined;
        resolvedIds.project.set(
            project.sourceKey,
            legacyId
                && legacyProject
                && (legacyProject.areaId ?? undefined) === expectedAreaId
                ? legacyId
                : scopedId,
        );
    });

    parsedData.sections.forEach((section) => {
        const scopedId = createMindwtrCsvImportId('section', section.sourceKey);
        if (currentSectionById.has(scopedId)) {
            resolvedIds.section.set(section.sourceKey, scopedId);
            return;
        }
        const project = projectBySourceKey.get(section.projectSourceKey);
        const expectedProjectId = resolvedIds.project.get(section.projectSourceKey);
        const colonProjectSourceKey = project
            ? colonProjectSourceKeyFor(project.areaSourceKey, project.name)
            : section.projectSourceKey;
        const colonSourceKey = `${colonProjectSourceKey}:${normalizeSourceKey(section.name)}`;
        const colonId = createMindwtrCsvImportId('section', colonSourceKey);
        const colonSection = currentSectionById.get(colonId);
        if (
            colonSourceKey !== section.sourceKey
            && colonSection
            && colonSection.projectId === expectedProjectId
        ) {
            resolvedIds.section.set(section.sourceKey, colonId);
            return;
        }
        const legacySourceKey = legacySectionSourceKeyByScopedKey.get(section.sourceKey);
        const legacyId = legacySourceKey
            ? createMindwtrCsvImportId('section', legacySourceKey)
            : undefined;
        const legacySection = legacyId ? currentSectionById.get(legacyId) : undefined;
        resolvedIds.section.set(
            section.sourceKey,
            legacyId && legacySection && legacySection.projectId === expectedProjectId
                ? legacyId
                : scopedId,
        );
    });

    const taskSourceIdCounts = new Map<string, number>();
    parsedData.tasks.forEach((task) => {
        taskSourceIdCounts.set(task.sourceId, (taskSourceIdCounts.get(task.sourceId) ?? 0) + 1);
    });
    const migrationSourceKeys = new Set<string>();
    const editedHistoricalSourceKeys = new Set<string>();
    const ambiguousMigrationSourceIds = new Set<string>();
    const pendingTaskMigrations = new Map<string, {
        areaId?: string;
        projectId?: string;
        sectionId?: string;
    }>();
    const historicalTaskCandidatesFor = (sourceKeys: Array<string | undefined>): Array<{ id: string; task: Task }> => {
        const candidatesById = new Map<string, Task>();
        sourceKeys.forEach((sourceKey) => {
            if (!sourceKey) return;
            const id = createMindwtrCsvImportId('task', sourceKey);
            const historicalTask = currentTaskById.get(id);
            if (historicalTask) candidatesById.set(id, historicalTask);
        });
        return Array.from(candidatesById, ([id, historicalTask]) => ({ id, task: historicalTask }));
    };
    const hasUntouchedImporterProvenance = (task: Task): boolean => (
        task.rev === 1
        && Boolean(task.createdAt)
        && task.createdAt === task.updatedAt
    );

    // Older task IDs embedded their container path. Reuse an owned candidate unchanged; when a
    // single importer-generated candidate proves that the CSV container was previously collapsed
    // or moved, preserve the task and repair only its container references after creation.
    tasksForImport.forEach((task) => {
        // An `ID` column holding a live task's own id IS the identity — that is what Mindwtr's
        // own CSV export writes, so a round trip resolves back onto those same tasks rather than
        // minting derived ids and duplicating them (D1). `import-apply.ts` then SKIPS every id
        // that already exists, so a round trip is a no-op, not an update: CSV edits are not
        // applied. Only non-explicit identities fall through to the derived-id chain below.
        if (task.sourceIdentityKind === 'explicit-id' && currentTaskById.has(task.sourceId)) {
            resolvedIds.task.set(task.sourceKey, task.sourceId);
            return;
        }
        const scopedId = createMindwtrCsvImportId('task', task.sourceKey);
        if (currentTaskById.has(scopedId)) {
            resolvedIds.task.set(task.sourceKey, scopedId);
            return;
        }
        const compatibilityId = task.compatibilitySourceKeys
            ?.map((sourceKey) => createMindwtrCsvImportId('task', sourceKey))
            .find((id) => currentTaskById.has(id));
        if (compatibilityId) {
            resolvedIds.task.set(task.sourceKey, compatibilityId);
            return;
        }
        const precedingGlobalId = createMindwtrCsvImportId(
            'task',
            legacyCanonicalTaskSourceKeyFor(task.sourceId),
        );
        if (
            task.sourceIdentityKind === 'explicit-id'
            && !couldBeLegacyRowFallback(task.sourceId)
            && currentTaskById.has(precedingGlobalId)
        ) {
            resolvedIds.task.set(task.sourceKey, precedingGlobalId);
            return;
        }
        const project = task.projectSourceKey ? projectBySourceKey.get(task.projectSourceKey) : undefined;
        const expectedProjectId = task.projectSourceKey
            ? resolvedIds.project.get(task.projectSourceKey)
            : undefined;
        const expectedAreaId = !expectedProjectId && task.areaSourceKey
            ? resolvedIds.area.get(task.areaSourceKey)
            : undefined;
        const expectedSectionId = task.sectionSourceKey
            ? resolvedIds.section.get(task.sectionSourceKey)
            : undefined;
        const previousScopedSourceKey = project
            ? encodeSourceKeyTuple(
                ...(project.areaSourceKey ? [project.areaSourceKey] : []),
                normalizeSourceKey(project.name),
                task.sourceId,
            )
            : encodeSourceKeyTuple('none', task.sourceId);
        const colonProjectSourceKey = project
            ? colonProjectSourceKeyFor(project.areaSourceKey, project.name)
            : 'none';
        const colonSourceKey = `${colonProjectSourceKey}:${task.sourceId}`;
        const legacySourceKey = legacyTaskSourceKeyByScopedKey.get(task.sourceKey);
        let historicalCandidates = historicalTaskCandidatesFor(
            [previousScopedSourceKey, colonSourceKey, legacySourceKey]
                .filter((sourceKey) => sourceKey !== task.sourceKey),
        );
        if (historicalCandidates.length === 0 && currentTaskById.size > 0) {
            const encodedSourceId = encodeURIComponent(task.sourceId);
            const priorContainerSourceKeys = currentProjectTaskScopes.flatMap((scope) => [
                `${scope.tuplePrefix}${encodedSourceId}`,
                `${scope.colonPrefix}${task.sourceId}`,
                `${scope.plainPrefix}${task.sourceId}`,
            ]);
            historicalCandidates = historicalTaskCandidatesFor(priorContainerSourceKeys);
        }
        const ownedCandidate = historicalCandidates.find(({ task: historicalTask }) => (
            (historicalTask.projectId ?? undefined) === expectedProjectId
            && (historicalTask.areaId ?? undefined) === expectedAreaId
        ));
        if (ownedCandidate) {
            resolvedIds.task.set(task.sourceKey, ownedCandidate.id);
            return;
        }
        if (historicalCandidates.length === 0) {
            resolvedIds.task.set(task.sourceKey, scopedId);
            return;
        }

        const [candidate] = historicalCandidates;
        resolvedIds.task.set(task.sourceKey, candidate.id);
        if (candidate.task.deletedAt || candidate.task.purgedAt) return;
        if ((taskSourceIdCounts.get(task.sourceId) ?? 0) > 1 || historicalCandidates.length > 1) {
            ambiguousMigrationSourceIds.add(task.sourceId);
            return;
        }
        if (!hasUntouchedImporterProvenance(candidate.task)) {
            editedHistoricalSourceKeys.add(task.sourceKey);
            return;
        }

        migrationSourceKeys.add(task.sourceKey);
        pendingTaskMigrations.set(candidate.id, {
            projectId: expectedProjectId,
            sectionId: expectedSectionId,
            areaId: expectedAreaId,
        });
    });

    const compatibleIdFor = (
        kind: 'area' | 'project' | 'section' | 'task',
        sourceKey: string,
    ): string => resolvedIds[kind].get(sourceKey) ?? createMindwtrCsvImportId(kind, sourceKey);

    const applied = applyImport(
        currentData,
        {
            areas: parsedData.areas,
            projects: parsedData.projects,
            sections: parsedData.sections,
            tasks: tasksForImport.filter((task) => (
                !migrationSourceKeys.has(task.sourceKey)
                && !editedHistoricalSourceKeys.has(task.sourceKey)
                && !ambiguousMigrationSourceIds.has(task.sourceId)
            )),
            warnings: parsedData.warnings,
        },
        {
            fallbacks: { area: MINDWTR_CSV_AREA_FALLBACK, project: MINDWTR_CSV_PROJECT_FALLBACK },
            idFor: compatibleIdFor,
            now: options.now,
            suffix: MINDWTR_CSV_IMPORT_SUFFIX,
        }
    );

    const resolvedNow = options.now instanceof Date
        ? options.now
        : typeof options.now === 'string' && options.now.trim()
            ? new Date(options.now)
            : new Date();
    const updatedAt = Number.isFinite(resolvedNow.getTime()) ? resolvedNow.toISOString() : new Date().toISOString();
    const projectOrderReserver = createProjectOrderReserver(applied.data.tasks);
    let migratedTaskCount = 0;
    let unavailableMigrationCount = 0;
    const migratedTasks = applied.data.tasks.map((task) => {
        const migration = pendingTaskMigrations.get(task.id);
        if (!migration) return task;
        const move = buildTaskContainerMovePatch({
            task,
            updates: migration,
            allProjects: applied.data.projects,
            allSections: applied.data.sections,
            allAreas: applied.data.areas,
            projectOrderReserver,
        });
        if (!move.ok) {
            unavailableMigrationCount += 1;
            return task;
        }
        migratedTaskCount += 1;
        return {
            ...task,
            ...move.updates,
            updatedAt,
            rev: nextRevision(task.rev),
            revBy: applied.data.settings.deviceId,
        };
    });
    const warnings = [...applied.warnings];
    if (migratedTaskCount > 0) {
        warnings.push(migratedTaskCount === 1
            ? '1 previously imported task was moved to match its CSV container.'
            : `${migratedTaskCount} previously imported tasks were moved to match their CSV containers.`);
    }
    if (editedHistoricalSourceKeys.size > 0) {
        warnings.push(editedHistoricalSourceKeys.size === 1
            ? '1 previously imported task was kept in its current container because it was edited after import.'
            : `${editedHistoricalSourceKeys.size} previously imported tasks were kept in their current containers because they were edited after import.`);
    }
    if (ambiguousMigrationSourceIds.size > 0) {
        warnings.push(ambiguousMigrationSourceIds.size === 1
            ? '1 repeated CSV ID matched a prior import; existing tasks were kept unchanged.'
            : `${ambiguousMigrationSourceIds.size} repeated CSV IDs matched prior imports; existing tasks were kept unchanged.`);
    }
    if (unavailableMigrationCount > 0) {
        warnings.push(unavailableMigrationCount === 1
            ? '1 previously imported task could not be moved because its CSV container is unavailable.'
            : `${unavailableMigrationCount} previously imported tasks could not be moved because their CSV containers are unavailable.`);
    }
    return {
        ...applied,
        data: { ...applied.data, tasks: migratedTasks },
        warnings,
    };
};
