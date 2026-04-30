import { strFromU8, unzipSync } from 'fflate';

import { DEFAULT_AREA_COLOR, DEFAULT_PROJECT_COLOR } from './color-constants';
import { safeParseDate } from './date';
import { buildRRuleString, parseRRuleString } from './recurrence';
import { ensureDeviceId, normalizeTagId } from './store-helpers';
import type {
    AppData,
    Area,
    ChecklistItem,
    Project,
    Recurrence,
    RecurrenceByDay,
    RecurrenceRule,
    Task,
    TaskPriority,
    TaskStatus,
} from './types';
import { generateUUID as uuidv4 } from './uuid';

const OMNIFOCUS_REQUIRED_COLUMNS = ['TYPE', 'NAME'];
const OMNIFOCUS_DELIMITER_FALLBACK = ',';
const OMNIFOCUS_ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
const OMNIFOCUS_PROJECT_FALLBACK = 'OmniFocus Import';
const OMNIFOCUS_AREA_FALLBACK = 'OmniFocus';
const OMNIFOCUS_TASK_FALLBACK = 'Untitled OmniFocus task';
const OMNIFOCUS_IMPORT_SUFFIX = ' (OmniFocus)';

type OmniFocusFileInput = {
    bytes?: ArrayBuffer | Uint8Array | null;
    fileName: string;
    text?: string | null;
};

type OmniFocusWarningCounters = {
    emptyExports: number;
    flattenedNestedTasks: number;
    nestedZipFiles: number;
    nonJsonEntries: number;
    unknownTypes: number;
    unparsedDateFields: number;
    unresolvedTagIds: number;
    unsupportedRecurrencePatterns: number;
};

type ParsedOmniFocusRow = {
    completionDate?: string;
    contextNames: string[];
    dueDate?: string;
    duration?: string;
    flagged: boolean;
    lineNumber: number;
    name: string;
    notes?: string;
    plannedDate?: string;
    projectName?: string;
    startDate?: string;
    statusText?: string;
    tagNames: string[];
    type: 'project' | 'task';
};

type OmniFocusJsonTask = {
    completed: boolean;
    completionDate?: string;
    deferDate?: string;
    dueDate?: string;
    flagged: boolean;
    id: string;
    name: string;
    note?: string;
    parentTaskId?: string;
    plannedDate?: string;
    projectId?: string;
    repetition?: unknown;
    statusText?: string;
    tagIds: string[];
};

type OmniFocusJsonProjectMeta = {
    completed: boolean;
    creationDate?: string;
    dueDate?: string;
    folderId?: string;
    folderName?: string;
    id: string;
    name: string;
    note?: string;
    statusText?: string;
    tagIds: string[];
};

type OmniFocusJsonDocument = {
    data: Record<string, unknown>;
    name: string;
};

export type ParsedOmniFocusArea = {
    name: string;
    order: number;
    sourceKey: string;
};

export type ParsedOmniFocusProject = {
    areaSourceKey?: string;
    dueDate?: string;
    name: string;
    order: number;
    sourceKey: string;
    status: Project['status'];
    supportNotes?: string;
    tagIds: string[];
};

export type ParsedOmniFocusTask = {
    areaSourceKey?: string;
    checklist?: ChecklistItem[];
    completedAt?: string;
    contexts: string[];
    description?: string;
    dueDate?: string;
    order: number;
    priority?: TaskPriority;
    projectSourceKey?: string;
    recurrence?: Task['recurrence'];
    startTime?: string;
    status: TaskStatus;
    tags: string[];
    title: string;
};

export type ParsedOmniFocusImportData = {
    areas: ParsedOmniFocusArea[];
    projects: ParsedOmniFocusProject[];
    tasks: ParsedOmniFocusTask[];
    warnings: string[];
};

export type OmniFocusImportProjectPreview = {
    name: string;
    taskCount: number;
};

export type OmniFocusImportPreview = {
    areaCount: number;
    checklistItemCount: number;
    fileName: string;
    projectCount: number;
    projects: OmniFocusImportProjectPreview[];
    standaloneTaskCount: number;
    taskCount: number;
    warnings: string[];
};

export type OmniFocusImportParseResult = {
    errors: string[];
    parsedData: ParsedOmniFocusImportData | null;
    preview: OmniFocusImportPreview | null;
    valid: boolean;
    warnings: string[];
};

export type OmniFocusImportExecutionResult = {
    data: AppData;
    importedAreaCount: number;
    importedChecklistItemCount: number;
    importedProjectCount: number;
    importedStandaloneTaskCount: number;
    importedTaskCount: number;
    warnings: string[];
};

const createWarningCounters = (): OmniFocusWarningCounters => ({
    emptyExports: 0,
    flattenedNestedTasks: 0,
    nestedZipFiles: 0,
    nonJsonEntries: 0,
    unknownTypes: 0,
    unparsedDateFields: 0,
    unresolvedTagIds: 0,
    unsupportedRecurrencePatterns: 0,
});

const appendWarning = (warnings: string[], count: number, singular: string, plural = singular): void => {
    if (count <= 0) return;
    warnings.push(count === 1 ? singular : plural.replace('{count}', String(count)));
};

const buildWarnings = (counters: OmniFocusWarningCounters): string[] => {
    const warnings: string[] = [];
    appendWarning(
        warnings,
        counters.unknownTypes,
        '1 OmniFocus row type was not recognized and was imported as a task.',
        '{count} OmniFocus row types were not recognized and were imported as tasks.'
    );
    appendWarning(
        warnings,
        counters.unparsedDateFields,
        '1 OmniFocus date could not be mapped directly and was preserved in notes.',
        '{count} OmniFocus dates could not be mapped directly and were preserved in notes.'
    );
    appendWarning(
        warnings,
        counters.flattenedNestedTasks,
        '1 nested OmniFocus task was flattened because Mindwtr cannot preserve its hierarchy directly.',
        '{count} nested OmniFocus tasks were flattened because Mindwtr cannot preserve their hierarchy directly.'
    );
    appendWarning(
        warnings,
        counters.unresolvedTagIds,
        '1 OmniFocus tag could not be resolved because metadata was missing or incomplete.',
        '{count} OmniFocus tags could not be resolved because metadata was missing or incomplete.'
    );
    appendWarning(
        warnings,
        counters.unsupportedRecurrencePatterns,
        '1 OmniFocus repeat rule was only imported best-effort and the original rule was preserved in notes.',
        '{count} OmniFocus repeat rules were only imported best-effort and the original rules were preserved in notes.'
    );
    appendWarning(
        warnings,
        counters.nonJsonEntries,
        '1 non-JSON file inside the OmniFocus archive was skipped.',
        '{count} non-JSON files inside the OmniFocus archive were skipped.'
    );
    appendWarning(
        warnings,
        counters.nestedZipFiles,
        '1 nested ZIP file inside the OmniFocus archive was skipped.',
        '{count} nested ZIP files inside the OmniFocus archive were skipped.'
    );
    appendWarning(
        warnings,
        counters.emptyExports,
        '1 OmniFocus export contained no importable tasks or projects.',
        '{count} OmniFocus exports contained no importable tasks or projects.'
    );
    return warnings;
};

const basename = (value: string): string => {
    const parts = String(value || '').split(/[\\/]/u);
    return parts[parts.length - 1] || value;
};

const sanitizeCsvText = (raw: string): string => String(raw || '').replace(/^\uFEFF/u, '');

const sanitizeJsonText = (raw: string): string => String(raw || '').replace(/^\uFEFF/u, '').trim();

const decodeUtf16Be = (bytes: Uint8Array): string => {
    const swapped = new Uint8Array(bytes.length - (bytes.length % 2));
    for (let index = 0; index < swapped.length; index += 2) {
        swapped[index] = bytes[index + 1];
        swapped[index + 1] = bytes[index];
    }
    return new TextDecoder('utf-16le', { fatal: false }).decode(swapped);
};

const decodeOmniFocusBytes = (bytes: Uint8Array): string => {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return new TextDecoder('utf-16le', { fatal: false }).decode(bytes);
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        return decodeUtf16Be(bytes.slice(2));
    }
    try {
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
        return strFromU8(bytes, true);
    }
};

const toUint8Array = (value?: ArrayBuffer | Uint8Array | null): Uint8Array | null => {
    if (!value) return null;
    return value instanceof Uint8Array ? value : new Uint8Array(value);
};

const isZipBytes = (bytes: Uint8Array): boolean =>
    bytes.length >= OMNIFOCUS_ZIP_SIGNATURE.length
    && OMNIFOCUS_ZIP_SIGNATURE.every((byte, index) => bytes[index] === byte);

const detectDelimiter = (text: string): string => {
    const firstLine = sanitizeCsvText(text)
        .split(/\r?\n/u)
        .find((line) => line.trim().length > 0);
    if (!firstLine) return OMNIFOCUS_DELIMITER_FALLBACK;
    const commaCount = (firstLine.match(/,/gu) || []).length;
    const semicolonCount = (firstLine.match(/;/gu) || []).length;
    return semicolonCount > commaCount ? ';' : ',';
};

const parseCsvRows = (text: string, delimiter: string): string[][] => {
    const rows: string[][] = [];
    let currentRow: string[] = [];
    let currentCell = '';
    let inQuotes = false;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];
        if (inQuotes) {
            if (char === '"') {
                if (next === '"') {
                    currentCell += '"';
                    index += 1;
                } else {
                    inQuotes = false;
                }
            } else {
                currentCell += char;
            }
            continue;
        }

        if (char === '"') {
            inQuotes = true;
            continue;
        }
        if (char === delimiter) {
            currentRow.push(currentCell);
            currentCell = '';
            continue;
        }
        if (char === '\r' || char === '\n') {
            if (char === '\r' && next === '\n') {
                index += 1;
            }
            currentRow.push(currentCell);
            rows.push(currentRow);
            currentRow = [];
            currentCell = '';
            continue;
        }
        currentCell += char;
    }

    currentRow.push(currentCell);
    if (currentRow.length > 1 || currentRow[0] !== '' || rows.length === 0) {
        rows.push(currentRow);
    }
    return rows.filter((row) => row.some((cell) => cell.length > 0));
};

const normalizeHeaderCell = (value: string): string => value.trim().toUpperCase();

const buildHeaderIndex = (headerRow: string[]): Map<string, number> => {
    const index = new Map<string, number>();
    headerRow.forEach((cell, cellIndex) => {
        const normalized = normalizeHeaderCell(cell);
        if (normalized && !index.has(normalized)) {
            index.set(normalized, cellIndex);
        }
    });
    return index;
};

const getCell = (row: string[], headerIndex: Map<string, number>, key: string): string => {
    const index = headerIndex.get(key);
    if (index === undefined) return '';
    return String(row[index] ?? '').trim();
};

const normalizeContextName = (value: string): string | undefined => {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
};

const splitTokenList = (value: string): string[] =>
    value
        .split(/[;,]/u)
        .map((entry) => entry.trim())
        .filter(Boolean);

const dedupeCaseInsensitive = (values: string[]): string[] => {
    const seen = new Set<string>();
    const result: string[] = [];
    values.forEach((value) => {
        const trimmed = String(value || '').trim();
        if (!trimmed) return;
        const normalized = trimmed.toLowerCase();
        if (seen.has(normalized)) return;
        seen.add(normalized);
        result.push(trimmed);
    });
    return result;
};

const normalizeTags = (value: string): string[] =>
    dedupeCaseInsensitive(splitTokenList(value).map((tag) => normalizeTagId(tag)).filter(Boolean));

const normalizeContexts = (value: string): string[] =>
    dedupeCaseInsensitive(splitTokenList(value).map((context) => normalizeContextName(context)).filter(Boolean) as string[]);

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

const formatLocalDate = (date: Date): string =>
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const formatLocalDateTime = (date: Date): string =>
    `${formatLocalDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;

const normalizeMappedDate = (value: string): { rawText?: string; value?: string } => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return {};
    const dateOnlyMatch = /^(\d{4}-\d{2}-\d{2})$/u.exec(trimmed);
    if (dateOnlyMatch) {
        return { value: dateOnlyMatch[1] };
    }
    const dateTimeMatch = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)$/u.exec(trimmed);
    if (dateTimeMatch) {
        return { value: `${dateTimeMatch[1]}T${dateTimeMatch[2]}` };
    }
    const parsed = safeParseDate(trimmed);
    if (!parsed) {
        return { rawText: trimmed };
    }
    if (/Z$|[+-]\d{2}:?\d{2}$/iu.test(trimmed)) {
        return { value: parsed.toISOString() };
    }
    return {
        value: /(?:\d{1,2}:\d{2}|[ap]\.?m\.?)/iu.test(trimmed)
            ? formatLocalDateTime(parsed)
            : formatLocalDate(parsed),
    };
};

const normalizeProjectKey = (value: string): string => value.trim().toLowerCase();

const normalizeAreaKey = (value: string): string => value.trim().toLowerCase();

const parseFlagged = (value: string): boolean => /^(?:1|true|yes|y|flagged)$/iu.test(value.trim());

const parseProjectStatus = (value: string): Project['status'] => {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return 'active';
    if (normalized.includes('drop') || normalized.includes('archive') || normalized.includes('complete') || normalized.includes('done')) {
        return 'archived';
    }
    if (normalized.includes('someday') || normalized.includes('maybe') || normalized.includes('hold')) return 'someday';
    if (normalized.includes('waiting')) return 'waiting';
    return 'active';
};

const parseTaskStatus = (value: string, completionDate?: string): TaskStatus => {
    if (completionDate) return 'done';
    const normalized = value.trim().toLowerCase();
    if (!normalized) return 'inbox';
    if (normalized.includes('complete') || normalized.includes('done')) return 'done';
    if (normalized.includes('drop') || normalized.includes('archive')) return 'archived';
    if (normalized.includes('waiting')) return 'waiting';
    if (normalized.includes('someday') || normalized.includes('maybe') || normalized.includes('hold')) return 'someday';
    if (normalized.includes('reference')) return 'reference';
    return 'inbox';
};

const parseRowType = (value: string, counters: OmniFocusWarningCounters): 'project' | 'task' => {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return 'task';
    if (normalized === 'project' || normalized === 'single action list') return 'project';
    if (normalized === 'action' || normalized === 'task' || normalized === 'action group') return 'task';
    counters.unknownTypes += 1;
    return 'task';
};

const joinDescription = (parts: Array<string | undefined>): string | undefined => {
    const normalized = parts.map((part) => String(part || '').trim()).filter(Boolean);
    return normalized.length > 0 ? normalized.join('\n\n') : undefined;
};

const ensureProjectRecord = (
    projectsByKey: Map<string, ParsedOmniFocusProject>,
    projectName: string,
    nextOrder: () => number
): ParsedOmniFocusProject => {
    const normalizedName = projectName.trim();
    const sourceKey = normalizeProjectKey(normalizedName);
    const existing = projectsByKey.get(sourceKey);
    if (existing) return existing;
    const created: ParsedOmniFocusProject = {
        name: normalizedName || OMNIFOCUS_PROJECT_FALLBACK,
        order: nextOrder(),
        sourceKey,
        status: 'active',
        tagIds: [],
    };
    projectsByKey.set(sourceKey, created);
    return created;
};

const mergeProjectSupportNotes = (currentValue: string | undefined, nextValue: string | undefined): string | undefined => {
    const current = String(currentValue || '').trim();
    const next = String(nextValue || '').trim();
    if (!current) return next || undefined;
    if (!next) return current;
    if (current === next) return current;
    return `${current}\n\n${next}`;
};

const parseCsvImport = (csvText: string, counters: OmniFocusWarningCounters): ParsedOmniFocusImportData => {
    const delimiter = detectDelimiter(csvText);
    const rows = parseCsvRows(sanitizeCsvText(csvText), delimiter);
    if (rows.length === 0) {
        counters.emptyExports += 1;
        return { areas: [], projects: [], tasks: [], warnings: buildWarnings(counters) };
    }

    const headerIndex = buildHeaderIndex(rows[0]);
    const missingRequired = OMNIFOCUS_REQUIRED_COLUMNS.filter((key) => !headerIndex.has(key));
    if (missingRequired.length > 0) {
        throw new Error(`OmniFocus CSV is missing required columns: ${missingRequired.join(', ')}`);
    }

    const parsedRows: ParsedOmniFocusRow[] = [];
    for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex];
        const name = getCell(row, headerIndex, 'NAME');
        const type = parseRowType(getCell(row, headerIndex, 'TYPE'), counters);
        if (!name) continue;

        parsedRows.push({
            type,
            name,
            lineNumber: rowIndex + 1,
            statusText: getCell(row, headerIndex, 'STATUS') || undefined,
            projectName: getCell(row, headerIndex, 'PROJECT') || undefined,
            contextNames: normalizeContexts(getCell(row, headerIndex, 'CONTEXT')),
            startDate: getCell(row, headerIndex, 'START DATE') || undefined,
            plannedDate: getCell(row, headerIndex, 'PLANNED DATE') || undefined,
            dueDate: getCell(row, headerIndex, 'DUE DATE') || undefined,
            completionDate: getCell(row, headerIndex, 'COMPLETION DATE') || undefined,
            duration: getCell(row, headerIndex, 'DURATION') || undefined,
            flagged: parseFlagged(getCell(row, headerIndex, 'FLAGGED')),
            notes: getCell(row, headerIndex, 'NOTES') || undefined,
            tagNames: normalizeTags(getCell(row, headerIndex, 'TAGS')),
        });
    }

    if (parsedRows.length === 0) {
        counters.emptyExports += 1;
        return { areas: [], projects: [], tasks: [], warnings: buildWarnings(counters) };
    }

    let nextProjectOrder = 0;
    const allocateProjectOrder = (): number => {
        const current = nextProjectOrder;
        nextProjectOrder += 1;
        return current;
    };

    const projectsByKey = new Map<string, ParsedOmniFocusProject>();
    const tasks: ParsedOmniFocusTask[] = [];

    parsedRows.forEach((row, index) => {
        const startMapping = normalizeMappedDate(row.startDate || '');
        const plannedMapping = normalizeMappedDate(row.plannedDate || '');
        const dueMapping = normalizeMappedDate(row.dueDate || '');
        const completionMapping = normalizeMappedDate(row.completionDate || '');
        const rawDateNotes = [
            startMapping.rawText ? `Original OmniFocus start date: ${startMapping.rawText}` : undefined,
            plannedMapping.rawText ? `Original OmniFocus planned date: ${plannedMapping.rawText}` : undefined,
            dueMapping.rawText ? `Original OmniFocus due date: ${dueMapping.rawText}` : undefined,
            completionMapping.rawText ? `Original OmniFocus completion date: ${completionMapping.rawText}` : undefined,
        ].filter(Boolean);
        counters.unparsedDateFields += rawDateNotes.length;

        if (row.type === 'project') {
            const project = ensureProjectRecord(projectsByKey, row.name, allocateProjectOrder);
            project.status = parseProjectStatus(row.statusText || '');
            project.dueDate = dueMapping.value ?? project.dueDate;
            project.supportNotes = mergeProjectSupportNotes(
                project.supportNotes,
                joinDescription([
                    row.notes,
                    plannedMapping.value ? `Planned date in OmniFocus: ${plannedMapping.value}` : undefined,
                    row.duration && row.duration !== '0' ? `Estimated duration in OmniFocus: ${row.duration}` : undefined,
                    ...rawDateNotes,
                ])
            );
            project.tagIds = dedupeCaseInsensitive([...project.tagIds, ...row.tagNames]);
            return;
        }

        const normalizedProjectName = row.projectName?.trim();
        const project = normalizedProjectName
            ? ensureProjectRecord(projectsByKey, normalizedProjectName, allocateProjectOrder)
            : null;
        const description = joinDescription([
            row.notes,
            plannedMapping.value ? `Planned date in OmniFocus: ${plannedMapping.value}` : undefined,
            row.duration && row.duration !== '0' ? `Estimated duration in OmniFocus: ${row.duration}` : undefined,
            ...rawDateNotes,
        ]);
        tasks.push({
            title: row.name,
            order: index,
            projectSourceKey: project?.sourceKey,
            contexts: row.contextNames,
            tags: row.tagNames,
            description,
            startTime: startMapping.value,
            dueDate: dueMapping.value,
            completedAt: completionMapping.value,
            status: parseTaskStatus(row.statusText || '', completionMapping.value),
            priority: row.flagged ? 'high' : undefined,
        });
    });

    return {
        areas: [],
        projects: Array.from(projectsByKey.values()).sort((left, right) => left.order - right.order || left.name.localeCompare(right.name)),
        tasks,
        warnings: buildWarnings(counters),
    };
};

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const readStringValue = (value: unknown): string | undefined => {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed ? trimmed : undefined;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
    }
    return undefined;
};

const readBooleanValue = (value: unknown): boolean => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') return /^(?:1|true|yes|y)$/iu.test(value.trim());
    return false;
};

const readNumberValue = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
};

const readStringArray = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return value
        .map((entry) => readStringValue(entry))
        .filter((entry): entry is string => Boolean(entry));
};

const isLikelyJsonText = (text: string): boolean => /^[\s\uFEFF]*[{[]/u.test(String(text || ''));

const parseJsonDocument = (rawText: string, name: string): OmniFocusJsonDocument => {
    const text = sanitizeJsonText(rawText);
    try {
        const parsed = JSON.parse(text);
        if (!isObjectRecord(parsed)) {
            throw new Error('Top-level JSON value must be an object.');
        }
        return {
            name,
            data: parsed,
        };
    } catch (error) {
        throw new Error(
            error instanceof Error && error.message
                ? `Failed to parse ${basename(name)}: ${error.message}`
                : `Failed to parse ${basename(name)}.`
        );
    }
};

const isPreferredTaskDocumentName = (name: string): boolean => basename(name).toLowerCase() === 'omnifocus.json';

const isPreferredMetadataDocumentName = (name: string): boolean => basename(name).toLowerCase() === 'metadata.json';

const readTasksArray = (document: OmniFocusJsonDocument | null | undefined): unknown[] =>
    document && Array.isArray(document.data.tasks) ? document.data.tasks : [];

const readProjectsArray = (document: OmniFocusJsonDocument | null | undefined): unknown[] =>
    document && Array.isArray(document.data.projects) ? document.data.projects : [];

const readTagsArray = (document: OmniFocusJsonDocument | null | undefined): unknown[] =>
    document && Array.isArray(document.data.tags) ? document.data.tags : [];

const decodeJsonDocumentsFromArchive = (
    bytes: Uint8Array,
    counters: OmniFocusWarningCounters
): OmniFocusJsonDocument[] => {
    const entries = unzipSync(bytes);
    const documents: OmniFocusJsonDocument[] = [];
    Object.entries(entries).forEach(([name, entryBytes]) => {
        const lowerName = basename(name).toLowerCase();
        if (lowerName.endsWith('.zip')) {
            counters.nestedZipFiles += 1;
            return;
        }
        if (!lowerName.endsWith('.json')) {
            counters.nonJsonEntries += 1;
            return;
        }
        documents.push(parseJsonDocument(decodeOmniFocusBytes(entryBytes), name));
    });
    return documents;
};

const readOmniFocusTask = (value: unknown, index: number): OmniFocusJsonTask | null => {
    if (!isObjectRecord(value)) return null;
    const id = readStringValue(value.id) || `omnifocus-task-${index + 1}`;
    return {
        id,
        name: readStringValue(value.name) || OMNIFOCUS_TASK_FALLBACK,
        note: readStringValue(value.note),
        dueDate: readStringValue(value.dueDate),
        deferDate: readStringValue(value.deferDate),
        plannedDate: readStringValue(value.plannedDate),
        completed: readBooleanValue(value.completed),
        completionDate: readStringValue(value.completionDate),
        flagged: readBooleanValue(value.flagged),
        tagIds: readStringArray(value.tagIds),
        repetition: value.repetition ?? value.repeatRule ?? value.repetitionRule,
        projectId: readStringValue(value.projectId),
        parentTaskId: readStringValue(value.parentTaskId),
        statusText: readStringValue(value.status),
    };
};

const readOmniFocusProjectMeta = (value: unknown, index: number): OmniFocusJsonProjectMeta | null => {
    if (!isObjectRecord(value)) return null;
    const id = readStringValue(value.id) || `omnifocus-project-${index + 1}`;
    return {
        id,
        name: readStringValue(value.name) || OMNIFOCUS_PROJECT_FALLBACK,
        note: readStringValue(value.note),
        folderId: readStringValue(value.folderId),
        folderName: readStringValue(value.folderName),
        completed: readBooleanValue(value.completed),
        statusText: readStringValue(value.status),
        creationDate: readStringValue(value.creationDate),
        dueDate: readStringValue(value.dueDate),
        tagIds: readStringArray(value.tagIds),
    };
};

const readOmniFocusTags = (values: unknown[]): Map<string, string> => {
    const tagNameById = new Map<string, string>();
    values.forEach((value) => {
        if (!isObjectRecord(value)) return;
        const id = readStringValue(value.id);
        const name = readStringValue(value.name);
        const normalized = name ? normalizeTagId(name) : undefined;
        if (!id || !normalized || tagNameById.has(id)) return;
        tagNameById.set(id, normalized);
    });
    return tagNameById;
};

const resolveTagNames = (
    tagIds: string[],
    tagNameById: Map<string, string>,
    counters: OmniFocusWarningCounters
): string[] => {
    const resolved: string[] = [];
    tagIds.forEach((tagId) => {
        const tagName = tagNameById.get(tagId);
        if (!tagName) {
            counters.unresolvedTagIds += 1;
            return;
        }
        resolved.push(tagName);
    });
    return dedupeCaseInsensitive(resolved);
};

const supportedRRuleKeys = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'COUNT', 'UNTIL', 'BYSETPOS']);

const parseByDayToken = (token: string): RecurrenceByDay | undefined => {
    const trimmed = token.trim().toUpperCase();
    const match = /^(-1|1|2|3|4)?(SU|MO|TU|WE|TH|FR|SA)$/u.exec(trimmed);
    if (!match) return undefined;
    return `${match[1] ?? ''}${match[2]}` as RecurrenceByDay;
};

const parseByDayValues = (value: unknown): RecurrenceByDay[] | undefined => {
    const tokens = Array.isArray(value)
        ? value.flatMap((entry) => String(entry || '').split(','))
        : typeof value === 'string'
            ? value.split(',')
            : [];
    const parsed = tokens
        .map((token) => parseByDayToken(String(token || '')))
        .filter((token): token is RecurrenceByDay => Boolean(token));
    return parsed.length > 0 ? dedupeCaseInsensitive(parsed as string[]) as RecurrenceByDay[] : undefined;
};

const parseByMonthDayValues = (value: unknown): number[] | undefined => {
    const tokens = Array.isArray(value)
        ? value
        : typeof value === 'string'
            ? value.split(',')
            : typeof value === 'number'
                ? [value]
                : [];
    const parsed = tokens
        .map((token) => readNumberValue(token))
        .filter((token): token is number => token !== undefined && token >= 1 && token <= 31);
    const unique = Array.from(new Set(parsed)).sort((left, right) => left - right);
    return unique.length > 0 ? unique : undefined;
};

const buildImportedRecurrence = (
    rule: RecurrenceRule,
    strategy: 'fluid' | 'strict',
    options: {
        byDay?: RecurrenceByDay[];
        byMonthDay?: number[];
        count?: number;
        interval?: number;
        until?: string;
    } = {}
): Recurrence => ({
    rule,
    ...(strategy === 'fluid' ? { strategy } : {}),
    ...(options.byDay && options.byDay.length > 0 ? { byDay: options.byDay } : {}),
    ...(options.count ? { count: options.count } : {}),
    ...(options.until ? { until: options.until } : {}),
    rrule: buildRRuleString(rule, options.byDay, options.interval, {
        byMonthDay: options.byMonthDay,
        count: options.count,
        until: options.until,
    }),
});

const parseSupportedRRule = (
    rawRule: string,
    strategy: 'fluid' | 'strict',
    counters: OmniFocusWarningCounters
): { note?: string; recurrence?: Task['recurrence'] } => {
    const trimmed = rawRule.trim();
    if (!trimmed) return {};
    const tokens = trimmed.split(';').reduce<Record<string, string>>((acc, token) => {
        const [key, value] = token.split('=');
        if (key && value) acc[key.toUpperCase()] = value;
        return acc;
    }, {});
    const unknownKeys = Object.keys(tokens).filter((key) => !supportedRRuleKeys.has(key));
    const freqToken = tokens.FREQ?.toUpperCase();
    const rule = freqToken === 'DAILY' || freqToken === 'WEEKLY' || freqToken === 'MONTHLY' || freqToken === 'YEARLY'
        ? freqToken.toLowerCase() as RecurrenceRule
        : undefined;
    let byDay = parseByDayValues(tokens.BYDAY);
    const byMonthDay = parseByMonthDayValues(tokens.BYMONTHDAY);
    const bySetPos = tokens.BYSETPOS ? readNumberValue(tokens.BYSETPOS) : undefined;
    if ((!byDay || byDay.length === 0) && tokens.BYDAY && bySetPos && ['1', '2', '3', '4', '-1'].includes(String(bySetPos))) {
        byDay = parseByDayValues(`${bySetPos}${tokens.BYDAY}`);
    }
    const interval = tokens.INTERVAL ? readNumberValue(tokens.INTERVAL) : undefined;
    const count = tokens.COUNT ? readNumberValue(tokens.COUNT) : undefined;
    const until = tokens.UNTIL ? parseRRuleString(`FREQ=DAILY;UNTIL=${tokens.UNTIL}`).until : undefined;

    if (!rule) {
        counters.unsupportedRecurrencePatterns += 1;
        return { note: `Original OmniFocus repeat rule: ${trimmed}` };
    }

    if (unknownKeys.length > 0 || (tokens.BYSETPOS && (!byDay || byDay.length === 0))) {
        counters.unsupportedRecurrencePatterns += 1;
        return {
            recurrence: buildImportedRecurrence(rule, strategy, { byDay, byMonthDay, count, interval, until }),
            note: `Original OmniFocus repeat rule: ${trimmed}`,
        };
    }

    return {
        recurrence: buildImportedRecurrence(rule, strategy, { byDay, byMonthDay, count, interval, until }),
    };
};

const resolveRecurrenceRuleFromText = (value: string | undefined): RecurrenceRule | undefined => {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return undefined;
    if (normalized.startsWith('day')) return 'daily';
    if (normalized.startsWith('week')) return 'weekly';
    if (normalized.startsWith('month')) return 'monthly';
    if (normalized.startsWith('year')) return 'yearly';
    return undefined;
};

const safeJsonStringify = (value: unknown): string => {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
};

const resolveOmniFocusRecurrence = (
    value: unknown,
    counters: OmniFocusWarningCounters
): { note?: string; recurrence?: Task['recurrence'] } => {
    if (!value) return {};
    if (typeof value === 'string') {
        if (value.includes('FREQ=')) {
            return parseSupportedRRule(value, 'strict', counters);
        }
        const rule = resolveRecurrenceRuleFromText(value);
        if (!rule) {
            counters.unsupportedRecurrencePatterns += 1;
            return { note: `Original OmniFocus repeat rule: ${value}` };
        }
        return { recurrence: buildImportedRecurrence(rule, 'strict') };
    }
    if (!isObjectRecord(value)) {
        counters.unsupportedRecurrencePatterns += 1;
        return { note: `Original OmniFocus repeat rule: ${String(value)}` };
    }

    const strategy = readBooleanValue(value.fromCompletion) || /fromcompletion/iu.test(readStringValue(value.scheduleType) || '')
        ? 'fluid'
        : 'strict';
    const explicitRule = readStringValue(value.ruleString) || readStringValue(value.rrule);
    if (explicitRule) {
        return parseSupportedRRule(explicitRule, strategy, counters);
    }

    const rule = resolveRecurrenceRuleFromText(
        readStringValue(value.unit)
        || readStringValue(value.method)
        || readStringValue(value.frequency)
        || readStringValue(value.freq)
    );
    if (!rule) {
        counters.unsupportedRecurrencePatterns += 1;
        return {
            note: `Original OmniFocus repeat rule: ${safeJsonStringify(value)}`,
        };
    }

    const byDay = parseByDayValues(value.byDay);
    const byMonthDay = parseByMonthDayValues(value.byMonthDay ?? value.dayOfMonth ?? value.monthDay);
    const interval = readNumberValue(value.interval);
    const count = readNumberValue(value.count ?? value.occurrences);
    const until = normalizeMappedDate(readStringValue(value.until ?? value.endDate ?? value.untilDate) || '').value;

    return {
        recurrence: buildImportedRecurrence(rule, strategy, { byDay, byMonthDay, count, interval, until }),
    };
};

const normalizeProjectSourceKey = (projectId: string): string => `omnifocus-project:${projectId}`;

const normalizeAreaSourceKey = (folderId: string | undefined, folderName: string): string =>
    folderId ? `omnifocus-area:${folderId}` : `omnifocus-area:${normalizeAreaKey(folderName)}`;

const buildDateNotes = (
    values: {
        completionDate?: string;
        deferDate?: string;
        dueDate?: string;
        plannedDate?: string;
    },
    counters: OmniFocusWarningCounters
): {
    completedAt?: string;
    dueDate?: string;
    plannedNote?: string;
    rawDateNotes: string[];
    startTime?: string;
} => {
    const startMapping = normalizeMappedDate(values.deferDate || '');
    const plannedMapping = normalizeMappedDate(values.plannedDate || '');
    const dueMapping = normalizeMappedDate(values.dueDate || '');
    const completionMapping = normalizeMappedDate(values.completionDate || '');
    const rawDateNotes = [
        startMapping.rawText ? `Original OmniFocus start date: ${startMapping.rawText}` : undefined,
        plannedMapping.rawText ? `Original OmniFocus planned date: ${plannedMapping.rawText}` : undefined,
        dueMapping.rawText ? `Original OmniFocus due date: ${dueMapping.rawText}` : undefined,
        completionMapping.rawText ? `Original OmniFocus completion date: ${completionMapping.rawText}` : undefined,
    ].filter((note): note is string => Boolean(note));
    counters.unparsedDateFields += rawDateNotes.length;
    return {
        startTime: startMapping.value,
        dueDate: dueMapping.value,
        completedAt: completionMapping.value,
        plannedNote: plannedMapping.value ? `Planned date in OmniFocus: ${plannedMapping.value}` : undefined,
        rawDateNotes,
    };
};

const buildParentChain = (
    task: OmniFocusJsonTask,
    taskById: Map<string, OmniFocusJsonTask>,
    projectRootIds: Set<string>
): OmniFocusJsonTask[] => {
    const chain: OmniFocusJsonTask[] = [];
    let currentParentId = task.parentTaskId;
    const visited = new Set<string>([task.id]);
    while (currentParentId) {
        if (visited.has(currentParentId)) break;
        visited.add(currentParentId);
        const parent = taskById.get(currentParentId);
        if (!parent) break;
        if (projectRootIds.has(parent.id)) break;
        chain.unshift(parent);
        currentParentId = parent.parentTaskId;
    }
    return chain;
};

const isChecklistConvertibleTask = (task: OmniFocusJsonTask): boolean => {
    const completionDate = normalizeMappedDate(task.completionDate || '').value;
    const status = parseTaskStatus(task.statusText || '', completionDate);
    return !task.note
        && !task.deferDate
        && !task.dueDate
        && !task.plannedDate
        && !task.flagged
        && task.tagIds.length === 0
        && !task.repetition
        && (status === 'inbox' || status === 'done');
};

const parseJsonImport = (
    documents: OmniFocusJsonDocument[],
    counters: OmniFocusWarningCounters
): ParsedOmniFocusImportData => {
    const preferredTasksDocument = documents.find((document) => isPreferredTaskDocumentName(document.name) && readTasksArray(document).length > 0)
        || documents.find((document) => readTasksArray(document).length > 0)
        || null;
    if (!preferredTasksDocument) {
        throw new Error('The selected OmniFocus JSON export is missing a tasks array.');
    }

    const preferredMetadataDocument = documents.find((document) => document !== preferredTasksDocument && isPreferredMetadataDocumentName(document.name))
        || documents.find((document) => document !== preferredTasksDocument && (readProjectsArray(document).length > 0 || readTagsArray(document).length > 0))
        || (readProjectsArray(preferredTasksDocument).length > 0 || readTagsArray(preferredTasksDocument).length > 0 ? preferredTasksDocument : null);

    const rawTasks = readTasksArray(preferredTasksDocument)
        .map((task, index) => readOmniFocusTask(task, index))
        .filter((task): task is OmniFocusJsonTask => Boolean(task));
    if (rawTasks.length === 0) {
        counters.emptyExports += 1;
        return { areas: [], projects: [], tasks: [], warnings: buildWarnings(counters) };
    }

    const rawProjects = readProjectsArray(preferredMetadataDocument)
        .map((project, index) => readOmniFocusProjectMeta(project, index))
        .filter((project): project is OmniFocusJsonProjectMeta => Boolean(project));
    const tagNameById = readOmniFocusTags(readTagsArray(preferredMetadataDocument));

    const taskById = new Map(rawTasks.map((task) => [task.id, task] as const));
    const childIdsByParent = new Map<string, string[]>();
    rawTasks.forEach((task) => {
        if (!task.parentTaskId) return;
        const existing = childIdsByParent.get(task.parentTaskId) ?? [];
        existing.push(task.id);
        childIdsByParent.set(task.parentTaskId, existing);
    });

    const projectRootIds = new Set<string>();
    rawTasks.forEach((task) => {
        if (task.projectId && task.id === task.projectId && !task.parentTaskId) {
            projectRootIds.add(task.id);
        }
    });
    rawProjects.forEach((project) => {
        projectRootIds.add(project.id);
    });

    const areas: ParsedOmniFocusArea[] = [];
    const areaSourceKeyByName = new Map<string, string>();
    const ensureAreaRecord = (folderId: string | undefined, folderName: string | undefined): string | undefined => {
        const normalizedName = String(folderName || '').trim();
        if (!normalizedName) return undefined;
        const sourceKey = normalizeAreaSourceKey(folderId, normalizedName);
        if (areaSourceKeyByName.has(sourceKey)) {
            return sourceKey;
        }
        areaSourceKeyByName.set(sourceKey, sourceKey);
        areas.push({
            name: normalizedName,
            order: areas.length,
            sourceKey,
        });
        return sourceKey;
    };

    const projects: ParsedOmniFocusProject[] = [];
    const seenProjectIds = new Set<string>();
    rawProjects.forEach((project) => {
        const rootTask = taskById.get(project.id);
        const dateNotes = buildDateNotes({
            deferDate: rootTask?.deferDate,
            dueDate: project.dueDate || rootTask?.dueDate,
            plannedDate: rootTask?.plannedDate,
            completionDate: rootTask?.completionDate,
        }, counters);
        const repeatNote = rootTask?.repetition
            ? `OmniFocus project repeat rule: ${
                readStringValue((rootTask.repetition as Record<string, unknown>)?.ruleString)
                    || readStringValue((rootTask.repetition as Record<string, unknown>)?.rrule)
                    || safeJsonStringify(rootTask.repetition)
            }`
            : undefined;
        projects.push({
            sourceKey: normalizeProjectSourceKey(project.id),
            name: project.name || rootTask?.name || OMNIFOCUS_PROJECT_FALLBACK,
            order: projects.length,
            areaSourceKey: ensureAreaRecord(project.folderId, project.folderName),
            status: project.completed || rootTask?.completed ? 'archived' : parseProjectStatus(project.statusText || rootTask?.statusText || ''),
            dueDate: dateNotes.dueDate,
            supportNotes: joinDescription([
                project.note,
                rootTask?.note,
                dateNotes.plannedNote,
                repeatNote,
                ...dateNotes.rawDateNotes,
            ]),
            tagIds: dedupeCaseInsensitive([
                ...resolveTagNames(project.tagIds, tagNameById, counters),
                ...resolveTagNames(rootTask?.tagIds ?? [], tagNameById, counters),
            ]),
        });
        seenProjectIds.add(project.id);
    });

    rawTasks.forEach((task) => {
        if (!projectRootIds.has(task.id) || seenProjectIds.has(task.id)) return;
        const dateNotes = buildDateNotes({
            deferDate: task.deferDate,
            dueDate: task.dueDate,
            plannedDate: task.plannedDate,
            completionDate: task.completionDate,
        }, counters);
        const repeatNote = task.repetition
            ? `OmniFocus project repeat rule: ${
                readStringValue((task.repetition as Record<string, unknown>)?.ruleString)
                    || readStringValue((task.repetition as Record<string, unknown>)?.rrule)
                    || safeJsonStringify(task.repetition)
            }`
            : undefined;
        projects.push({
            sourceKey: normalizeProjectSourceKey(task.id),
            name: task.name || OMNIFOCUS_PROJECT_FALLBACK,
            order: projects.length,
            status: task.completed ? 'archived' : parseProjectStatus(task.statusText || ''),
            dueDate: dateNotes.dueDate,
            supportNotes: joinDescription([
                task.note,
                dateNotes.plannedNote,
                repeatNote,
                ...dateNotes.rawDateNotes,
            ]),
            tagIds: resolveTagNames(task.tagIds, tagNameById, counters),
        });
        seenProjectIds.add(task.id);
    });

    const checklistChildrenByParentId = new Map<string, OmniFocusJsonTask[]>();
    const checklistChildIds = new Set<string>();
    rawTasks.forEach((task) => {
        if (projectRootIds.has(task.id)) return;
        const parentChain = buildParentChain(task, taskById, projectRootIds);
        if (parentChain.length !== 1 || !isChecklistConvertibleTask(task)) return;
        const directChildren = childIdsByParent.get(task.id);
        if (directChildren && directChildren.length > 0) return;
        const parentId = parentChain[0]?.id;
        if (!parentId) return;
        checklistChildIds.add(task.id);
        const existing = checklistChildrenByParentId.get(parentId) ?? [];
        existing.push(task);
        checklistChildrenByParentId.set(parentId, existing);
    });

    const tasks: ParsedOmniFocusTask[] = [];
    rawTasks.forEach((task) => {
        if (projectRootIds.has(task.id) || checklistChildIds.has(task.id)) return;

        const parentChain = buildParentChain(task, taskById, projectRootIds);
        const depth = parentChain.length;
        if (depth > 0) {
            counters.flattenedNestedTasks += 1;
        }

        const dateNotes = buildDateNotes({
            deferDate: task.deferDate,
            dueDate: task.dueDate,
            plannedDate: task.plannedDate,
            completionDate: task.completionDate,
        }, counters);
        const recurrenceResolution = resolveOmniFocusRecurrence(task.repetition, counters);
        const checklistItems = (checklistChildrenByParentId.get(task.id) ?? [])
            .map((child) => ({
                id: uuidv4(),
                title: child.name || OMNIFOCUS_TASK_FALLBACK,
                isCompleted: child.completed || Boolean(normalizeMappedDate(child.completionDate || '').value),
            }))
            .sort((left, right) => left.title.localeCompare(right.title));
        const hierarchyPrefix = depth > 0
            ? `${parentChain.map((item) => item.name || OMNIFOCUS_TASK_FALLBACK).join(' -> ')} -> `
            : '';
        const hierarchyNote = depth > 0
            ? `Original OmniFocus hierarchy: ${parentChain.map((item) => item.name || OMNIFOCUS_TASK_FALLBACK).join(' > ')}`
            : undefined;
        const completionValue = dateNotes.completedAt;
        const projectSourceKey = task.projectId ? normalizeProjectSourceKey(task.projectId) : undefined;
        tasks.push({
            title: `${hierarchyPrefix}${task.name || OMNIFOCUS_TASK_FALLBACK}`,
            order: tasks.length,
            projectSourceKey,
            contexts: [],
            tags: resolveTagNames(task.tagIds, tagNameById, counters),
            description: joinDescription([
                task.note,
                dateNotes.plannedNote,
                hierarchyNote,
                recurrenceResolution.note,
                ...dateNotes.rawDateNotes,
            ]),
            checklist: checklistItems.length > 0 ? checklistItems : undefined,
            startTime: dateNotes.startTime,
            dueDate: dateNotes.dueDate,
            recurrence: recurrenceResolution.recurrence,
            completedAt: completionValue,
            status: parseTaskStatus(task.statusText || '', completionValue),
            priority: task.flagged ? 'high' : undefined,
        });
    });

    if (projects.length === 0 && tasks.length === 0) {
        counters.emptyExports += 1;
    }

    return {
        areas,
        projects,
        tasks,
        warnings: buildWarnings(counters),
    };
};

const parseOmniFocusImportData = (
    input: OmniFocusFileInput,
    counters: OmniFocusWarningCounters
): ParsedOmniFocusImportData => {
    const bytes = toUint8Array(input.bytes);
    if (bytes && isZipBytes(bytes)) {
        const documents = decodeJsonDocumentsFromArchive(bytes, counters);
        if (documents.length === 0) {
            throw new Error('The selected OmniFocus ZIP archive did not contain any supported JSON export files.');
        }
        return parseJsonImport(documents, counters);
    }

    const rawText = input.text ?? (bytes ? decodeOmniFocusBytes(bytes) : '');
    if (isLikelyJsonText(rawText)) {
        return parseJsonImport([parseJsonDocument(rawText, input.fileName)], counters);
    }
    return parseCsvImport(rawText, counters);
};

const resolveUniqueName = (title: string, usedTitles: Set<string>, fallback: string): string => {
    const trimmed = title.trim() || fallback;
    if (!usedTitles.has(trimmed.toLowerCase())) {
        usedTitles.add(trimmed.toLowerCase());
        return trimmed;
    }

    const base = `${trimmed}${OMNIFOCUS_IMPORT_SUFFIX}`;
    if (!usedTitles.has(base.toLowerCase())) {
        usedTitles.add(base.toLowerCase());
        return base;
    }

    let suffix = 2;
    while (true) {
        const next = `${base} ${suffix}`;
        const normalized = next.toLowerCase();
        if (!usedTitles.has(normalized)) {
            usedTitles.add(normalized);
            return next;
        }
        suffix += 1;
    }
};

const buildPreview = (fileName: string, parsedData: ParsedOmniFocusImportData): OmniFocusImportPreview => {
    const taskCountByProject = new Map<string, number>();
    let standaloneTaskCount = 0;
    let checklistItemCount = 0;
    parsedData.tasks.forEach((task) => {
        checklistItemCount += task.checklist?.length ?? 0;
        if (task.projectSourceKey) {
            taskCountByProject.set(task.projectSourceKey, (taskCountByProject.get(task.projectSourceKey) ?? 0) + 1);
        } else {
            standaloneTaskCount += 1;
        }
    });
    return {
        fileName,
        areaCount: parsedData.areas.length,
        checklistItemCount,
        projectCount: parsedData.projects.length,
        taskCount: parsedData.tasks.length,
        standaloneTaskCount,
        projects: parsedData.projects.map((project) => ({
            name: project.name,
            taskCount: taskCountByProject.get(project.sourceKey) ?? 0,
        })),
        warnings: parsedData.warnings,
    };
};

export const parseOmniFocusImportSource = (input: OmniFocusFileInput): OmniFocusImportParseResult => {
    const fileName = basename(input.fileName);
    try {
        const counters = createWarningCounters();
        const parsedData = parseOmniFocusImportData(input, counters);
        if (parsedData.projects.length === 0 && parsedData.tasks.length === 0) {
            return {
                valid: false,
                parsedData: null,
                preview: null,
                warnings: parsedData.warnings,
                errors: ['No importable OmniFocus items were found in the selected file.'],
            };
        }
        return {
            valid: true,
            parsedData,
            preview: buildPreview(fileName, parsedData),
            warnings: parsedData.warnings,
            errors: [],
        };
    } catch (error) {
        return {
            valid: false,
            parsedData: null,
            preview: null,
            warnings: [],
            errors: [
                error instanceof Error && error.message
                    ? error.message
                    : 'Failed to parse the OmniFocus export.',
            ],
        };
    }
};

export const applyOmniFocusImport = (
    currentData: AppData,
    parsedData: ParsedOmniFocusImportData,
    options: { now?: Date | string } = {}
): OmniFocusImportExecutionResult => {
    const resolvedNow = options.now instanceof Date
        ? options.now
        : typeof options.now === 'string' && options.now.trim()
            ? new Date(options.now)
            : new Date();
    const nowIso = Number.isFinite(resolvedNow.getTime()) ? resolvedNow.toISOString() : new Date().toISOString();
    const deviceState = ensureDeviceId(currentData.settings ?? {});
    const settings = deviceState.settings;
    const nextData: AppData = {
        tasks: [...currentData.tasks],
        projects: [...currentData.projects],
        sections: [...currentData.sections],
        areas: [...currentData.areas],
        settings,
    };

    const usedAreaNames = new Set(
        nextData.areas
            .filter((area) => !area.deletedAt)
            .map((area) => area.name.trim().toLowerCase())
    );
    const usedProjectTitles = new Set(
        nextData.projects
            .filter((project) => !project.deletedAt)
            .map((project) => project.title.trim().toLowerCase())
    );
    const warnings = [...parsedData.warnings];
    const areaIdBySourceKey = new Map<string, string>();
    const projectIdBySourceKey = new Map<string, string>();
    let importedAreaCount = 0;
    let importedChecklistItemCount = 0;
    let importedProjectCount = 0;
    let importedTaskCount = 0;
    let importedStandaloneTaskCount = 0;

    const nextAreaOrder = nextData.areas
        .filter((area) => !area.deletedAt)
        .reduce((max, area) => Math.max(max, Number.isFinite(area.order) ? area.order : -1), -1) + 1;

    parsedData.areas
        .slice()
        .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
        .forEach((parsedArea, index) => {
            const areaName = resolveUniqueName(parsedArea.name, usedAreaNames, OMNIFOCUS_AREA_FALLBACK);
            if (areaName !== parsedArea.name) {
                warnings.push(`Imported area "${parsedArea.name}" was renamed to "${areaName}" to avoid a name conflict.`);
            }
            const area: Area = {
                id: uuidv4(),
                name: areaName,
                color: DEFAULT_AREA_COLOR,
                order: nextAreaOrder + index,
                createdAt: nowIso,
                updatedAt: nowIso,
                rev: 1,
                revBy: deviceState.deviceId,
            };
            nextData.areas.push(area);
            areaIdBySourceKey.set(parsedArea.sourceKey, area.id);
            importedAreaCount += 1;
        });

    parsedData.projects
        .slice()
        .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
        .forEach((parsedProject) => {
            const areaId = parsedProject.areaSourceKey ? areaIdBySourceKey.get(parsedProject.areaSourceKey) : undefined;
            const projectTitle = resolveUniqueName(parsedProject.name, usedProjectTitles, OMNIFOCUS_PROJECT_FALLBACK);
            if (projectTitle !== parsedProject.name) {
                warnings.push(`Imported project "${parsedProject.name}" was renamed to "${projectTitle}" to avoid a title conflict.`);
            }
            const siblingMaxOrder = nextData.projects
                .filter((project) => !project.deletedAt && (project.areaId ?? undefined) === areaId)
                .reduce((max, project) => Math.max(max, Number.isFinite(project.order) ? project.order : -1), -1);
            const project: Project = {
                id: uuidv4(),
                title: projectTitle,
                status: parsedProject.status,
                color: DEFAULT_PROJECT_COLOR,
                order: siblingMaxOrder + 1,
                tagIds: parsedProject.tagIds,
                supportNotes: parsedProject.supportNotes,
                dueDate: parsedProject.dueDate,
                createdAt: nowIso,
                updatedAt: nowIso,
                rev: 1,
                revBy: deviceState.deviceId,
                ...(areaId ? { areaId } : {}),
            };
            nextData.projects.push(project);
            projectIdBySourceKey.set(parsedProject.sourceKey, project.id);
            importedProjectCount += 1;
        });

    const nextTaskOrderByBucket = new Map<string, number>();
    const getTaskBucketKey = (projectId?: string, areaId?: string): string => {
        if (projectId) return `project:${projectId}`;
        if (areaId) return `area:${areaId}`;
        return 'inbox';
    };
    const allocateTaskOrder = (projectId?: string, areaId?: string): number => {
        const bucket = getTaskBucketKey(projectId, areaId);
        const cached = nextTaskOrderByBucket.get(bucket);
        if (cached !== undefined) {
            nextTaskOrderByBucket.set(bucket, cached + 1);
            return cached;
        }
        const currentMax = nextData.tasks
            .filter((task) => !task.deletedAt && (task.projectId ?? undefined) === projectId && (task.areaId ?? undefined) === areaId)
            .reduce((max, task) => {
                const candidate = typeof task.order === 'number'
                    ? task.order
                    : typeof task.orderNum === 'number'
                        ? task.orderNum
                        : -1;
                return Math.max(max, candidate);
            }, -1);
        const nextOrder = currentMax + 1;
        nextTaskOrderByBucket.set(bucket, nextOrder + 1);
        return nextOrder;
    };

    parsedData.tasks
        .slice()
        .sort((left, right) => left.order - right.order || left.title.localeCompare(right.title))
        .forEach((parsedTask) => {
            const projectId = parsedTask.projectSourceKey ? projectIdBySourceKey.get(parsedTask.projectSourceKey) : undefined;
            const areaId = !projectId && parsedTask.areaSourceKey ? areaIdBySourceKey.get(parsedTask.areaSourceKey) : undefined;
            const order = allocateTaskOrder(projectId, areaId);
            const task: Task = {
                id: uuidv4(),
                title: parsedTask.title,
                status: parsedTask.status,
                taskMode: parsedTask.checklist?.length ? 'list' : 'task',
                priority: parsedTask.priority,
                contexts: parsedTask.contexts,
                tags: parsedTask.tags,
                checklist: parsedTask.checklist,
                description: parsedTask.description,
                startTime: parsedTask.startTime,
                dueDate: parsedTask.dueDate,
                recurrence: parsedTask.recurrence,
                completedAt: parsedTask.completedAt,
                pushCount: 0,
                createdAt: nowIso,
                updatedAt: nowIso,
                rev: 1,
                revBy: deviceState.deviceId,
                order,
                orderNum: order,
                ...(projectId ? { projectId } : {}),
                ...(areaId ? { areaId } : {}),
            };
            nextData.tasks.push(task);
            importedTaskCount += 1;
            importedChecklistItemCount += parsedTask.checklist?.length ?? 0;
            if (!projectId) {
                importedStandaloneTaskCount += 1;
            }
        });

    return {
        data: nextData,
        importedAreaCount,
        importedChecklistItemCount,
        importedProjectCount,
        importedStandaloneTaskCount,
        importedTaskCount,
        warnings,
    };
};
