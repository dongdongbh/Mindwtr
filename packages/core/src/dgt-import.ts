import { strFromU8, unzipSync } from 'fflate';

import { DEFAULT_AREA_COLOR, DEFAULT_PROJECT_COLOR } from './color-constants';
import { safeParseDate } from './date';
import { buildRRuleString } from './recurrence';
import { ensureDeviceId } from './store-helpers';
import type {
    AppData,
    Area,
    ChecklistItem,
    Project,
    RecurrenceByDay,
    RecurrenceWeekday,
    Task,
    TaskPriority,
    TaskStatus,
} from './types';
import { generateUUID as uuidv4 } from './uuid';

const DGT_ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
const DGT_AREA_FALLBACK = 'Imported Area';
const DGT_PROJECT_FALLBACK = 'Imported Project';
const DGT_TASK_FALLBACK = 'Imported Task';
const DGT_IMPORT_SUFFIX = ' (DGT)';
const DGT_TYPE_TASK = 0;
const DGT_TYPE_PROJECT = 1;
const DGT_TYPE_CHECKLIST = 2;
const DGT_TYPE_CHECKLIST_ITEM = 3;
const DGT_STATUS_NONE = 0;
const DGT_STATUS_NEXT_ACTION = 1;

const WEEKDAY_CODES: RecurrenceWeekday[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const WEEKDAY_ALIASES: Record<string, RecurrenceWeekday> = {
    sunday: 'SU',
    sun: 'SU',
    monday: 'MO',
    mon: 'MO',
    tuesday: 'TU',
    tue: 'TU',
    tues: 'TU',
    wednesday: 'WE',
    wed: 'WE',
    thursday: 'TH',
    thu: 'TH',
    thur: 'TH',
    thurs: 'TH',
    friday: 'FR',
    fri: 'FR',
    saturday: 'SA',
    sat: 'SA',
};

const ORDINAL_ALIASES: Record<string, number> = {
    first: 1,
    '1st': 1,
    second: 2,
    '2nd': 2,
    third: 3,
    '3rd': 3,
    fourth: 4,
    '4th': 4,
    last: -1,
};

type DgtFileInput = {
    bytes?: ArrayBuffer | Uint8Array | null;
    fileName: string;
    text?: string | null;
};

type NormalizedFolder = {
    color?: string;
    createdAt?: string;
    order: number;
    sourceId: number;
    title: string;
    updatedAt?: string;
};

type NormalizedContext = {
    sourceId: number;
    title: string;
};

type NormalizedTag = {
    sourceId: number;
    title: string;
};

type NormalizedTaskRecord = {
    color?: string;
    completedAt?: string;
    contextId?: number;
    createdAt?: string;
    dueDate?: string;
    dueTimeSet: boolean;
    folderId?: number;
    note?: string;
    order: number;
    parentId?: number;
    priorityValue: number;
    repeatText?: string;
    sourceId: number;
    sourceIndex: number;
    starred: boolean;
    startDate?: string;
    startTimeSet: boolean;
    statusValue: number;
    tagIds: number[];
    title: string;
    type: number;
    updatedAt?: string;
};

type DgtWarningCounters = {
    emptyExports: number;
    invalidJsonFiles: number;
    nestedZipFiles: number;
    nonJsonEntries: number;
    orphanChecklistItems: number;
    unknownTaskTypes: number;
    unmappedStatuses: number;
    unsupportedRepeats: number;
};

export type ParsedDgtArea = {
    color?: string;
    createdAt?: string;
    name: string;
    order: number;
    sourceId: number;
    updatedAt?: string;
};

export type ParsedDgtProject = {
    areaSourceId?: number;
    color?: string;
    createdAt?: string;
    dueDate?: string;
    isArchived?: boolean;
    name: string;
    order: number;
    sourceId: number;
    supportNotes?: string;
    updatedAt?: string;
};

export type ParsedDgtTask = {
    areaSourceId?: number;
    checklist: ChecklistItem[];
    completedAt?: string;
    contexts: string[];
    createdAt?: string;
    description?: string;
    dueDate?: string;
    order: number;
    priority?: TaskPriority;
    projectSourceId?: number;
    recurrence?: Task['recurrence'];
    sourceId: number;
    startTime?: string;
    status: TaskStatus;
    tags: string[];
    title: string;
    updatedAt?: string;
};

export type ParsedDgtImportData = {
    areas: ParsedDgtArea[];
    projects: ParsedDgtProject[];
    tasks: ParsedDgtTask[];
    warnings: string[];
};

export type DgtImportProjectPreview = {
    areaName?: string;
    name: string;
    taskCount: number;
};

export type DgtImportPreview = {
    areaCount: number;
    checklistItemCount: number;
    fileName: string;
    projectCount: number;
    projects: DgtImportProjectPreview[];
    recurringCount: number;
    standaloneTaskCount: number;
    taskCount: number;
    warnings: string[];
};

export type DgtImportParseResult = {
    errors: string[];
    parsedData: ParsedDgtImportData | null;
    preview: DgtImportPreview | null;
    valid: boolean;
    warnings: string[];
};

export type DgtImportExecutionResult = {
    data: AppData;
    importedAreaCount: number;
    importedChecklistItemCount: number;
    importedProjectCount: number;
    importedTaskCount: number;
    warnings: string[];
};

const createWarningCounters = (): DgtWarningCounters => ({
    emptyExports: 0,
    invalidJsonFiles: 0,
    nestedZipFiles: 0,
    nonJsonEntries: 0,
    orphanChecklistItems: 0,
    unknownTaskTypes: 0,
    unmappedStatuses: 0,
    unsupportedRepeats: 0,
});

const appendWarning = (warnings: string[], count: number, singular: string, plural = singular): void => {
    if (count <= 0) return;
    warnings.push(count === 1 ? singular : plural.replace('{count}', String(count)));
};

const buildWarnings = (counters: DgtWarningCounters): string[] => {
    const warnings: string[] = [];
    appendWarning(warnings, counters.unsupportedRepeats, '1 DGT recurring task could not be mapped and will be imported once.', '{count} DGT recurring tasks could not be mapped and will be imported once.');
    appendWarning(warnings, counters.unmappedStatuses, '1 DGT task status could not be mapped and was imported to Inbox.', '{count} DGT task statuses could not be mapped and were imported to Inbox.');
    appendWarning(warnings, counters.orphanChecklistItems, '1 DGT checklist item had no parent checklist and was imported as a normal task.', '{count} DGT checklist items had no parent checklist and were imported as normal tasks.');
    appendWarning(warnings, counters.unknownTaskTypes, '1 DGT item type was imported as a normal task.', '{count} DGT item types were imported as normal tasks.');
    appendWarning(warnings, counters.nonJsonEntries, '1 non-JSON file inside the DGT archive was skipped.', '{count} non-JSON files inside the DGT archive were skipped.');
    appendWarning(warnings, counters.nestedZipFiles, '1 nested ZIP file inside the DGT archive was skipped.', '{count} nested ZIP files inside the DGT archive were skipped.');
    appendWarning(warnings, counters.invalidJsonFiles, '1 DGT JSON file could not be parsed and was skipped.', '{count} DGT JSON files could not be parsed and were skipped.');
    appendWarning(warnings, counters.emptyExports, '1 DGT export contained no importable tasks or projects.', '{count} DGT exports contained no importable tasks or projects.');
    return warnings;
};

const basename = (value: string): string => {
    const parts = String(value || '').split(/[\\/]/u);
    return parts[parts.length - 1] || value;
};

const toUint8Array = (value?: ArrayBuffer | Uint8Array | null): Uint8Array | null => {
    if (!value) return null;
    return value instanceof Uint8Array ? value : new Uint8Array(value);
};

const isZipBytes = (bytes: Uint8Array): boolean =>
    bytes.length >= DGT_ZIP_SIGNATURE.length
    && DGT_ZIP_SIGNATURE.every((byte, index) => bytes[index] === byte);

const decodeTextBytes = (bytes: Uint8Array): string => {
    try {
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
        return strFromU8(bytes, true);
    }
};

const sanitizeJsonText = (raw: string): string => String(raw || '').replace(/^\uFEFF/u, '').trim();

const toRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

const toStringValue = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const toNumberValue = (value: unknown, fallback = 0): number => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
};

const toPositiveInt = (value: unknown): number | undefined => {
    const parsed = Math.trunc(toNumberValue(value, 0));
    return parsed > 0 ? parsed : undefined;
};

const toBooleanFlag = (value: unknown): boolean => toNumberValue(value, 0) === 1;

const toIntegerArray = (value: unknown): number[] => {
    if (!Array.isArray(value)) return [];
    return value
        .map((entry) => toPositiveInt(entry))
        .filter((entry): entry is number => entry !== undefined);
};

const normalizeDateString = (value: unknown, hasTime: boolean): string | undefined => {
    const trimmed = toStringValue(value);
    if (!trimmed) return undefined;
    const dateOnlyMatch = /^(\d{4}-\d{2}-\d{2})$/u.exec(trimmed);
    if (dateOnlyMatch) {
        return dateOnlyMatch[1];
    }
    const dateTimeMatch = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)$/u.exec(trimmed);
    if (!dateTimeMatch) return undefined;
    return hasTime ? `${dateTimeMatch[1]}T${dateTimeMatch[2]}` : dateTimeMatch[1];
};

const normalizeTitle = (value: unknown, fallback: string): string => toStringValue(value) || fallback;

const normalizeColor = (value: unknown): string | undefined => {
    if (value === '' || value === null || value === undefined) return undefined;
    const parsed = Math.trunc(toNumberValue(value, Number.NaN));
    if (!Number.isFinite(parsed)) return undefined;
    const hex = (parsed >>> 0).toString(16).padStart(8, '0').slice(-6);
    return `#${hex.toLowerCase()}`;
};

const normalizeOrder = (value: unknown, fallback: number): number => {
    const parsed = Math.trunc(toNumberValue(value, fallback));
    return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeContextName = (value: string): string | undefined => {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
};

const normalizeTagName = (value: string): string | undefined => {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
};

const dedupeStrings = (values: Array<string | undefined>): string[] => {
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

const joinDescription = (parts: Array<string | undefined>): string | undefined => {
    const normalized = parts
        .map((part) => String(part || '').trim())
        .filter(Boolean);
    return normalized.length > 0 ? normalized.join('\n\n') : undefined;
};

const normalizePriority = (priorityValue: number, starred: boolean): TaskPriority | undefined => {
    if (starred) return 'urgent';
    switch (priorityValue) {
        case 4:
            return 'urgent';
        case 3:
            return 'high';
        case 2:
            return 'medium';
        case 1:
            return 'low';
        default:
            return undefined;
    }
};

const weekdayFromDate = (isoString?: string): RecurrenceWeekday | undefined => {
    const parsed = safeParseDate(isoString);
    if (!parsed) return undefined;
    return WEEKDAY_CODES[parsed.getDay()];
};

const parseOrdinalToken = (value: string): number | undefined => ORDINAL_ALIASES[value.trim().toLowerCase()];

const parseWeekdayToken = (value: string): RecurrenceWeekday | undefined => WEEKDAY_ALIASES[value.trim().toLowerCase()];

const buildIntervalRecurrence = (rule: 'daily' | 'weekly' | 'monthly' | 'yearly', interval = 1): Task['recurrence'] => {
    if (!Number.isFinite(interval) || interval <= 1) return { rule };
    return {
        rule,
        rrule: `FREQ=${rule.toUpperCase()};INTERVAL=${Math.trunc(interval)}`,
    };
};

const buildMonthlyByDayRecurrence = (byDay: RecurrenceByDay, interval = 1): Task['recurrence'] => ({
    rule: 'monthly',
    rrule: buildRRuleString('monthly', [byDay], interval),
});

const buildWeeklyByDayRecurrence = (byDay: RecurrenceWeekday, interval = 1): Task['recurrence'] => ({
    rule: 'weekly',
    rrule: buildRRuleString('weekly', [byDay], interval),
});

const resolveRepeatPattern = (repeatText: string, anchorDate?: string): { recurrence?: Task['recurrence']; unsupported?: true } => {
    const trimmed = repeatText.trim();
    if (!trimmed) return {};

    if (/^daily$/iu.test(trimmed)) {
        return { recurrence: { rule: 'daily' } };
    }
    if (/^weekly$/iu.test(trimmed)) {
        const weekday = weekdayFromDate(anchorDate);
        return weekday ? { recurrence: buildWeeklyByDayRecurrence(weekday) } : { recurrence: { rule: 'weekly' } };
    }
    if (/^monthly$/iu.test(trimmed)) {
        return { recurrence: { rule: 'monthly' } };
    }
    if (/^(yearly|annually)$/iu.test(trimmed)) {
        return { recurrence: { rule: 'yearly' } };
    }
    if (/^quarterly$/iu.test(trimmed)) {
        return { recurrence: buildIntervalRecurrence('monthly', 3) };
    }

    const everyWeekdayMatch = /^every\s+([a-z]+)$/iu.exec(trimmed);
    if (everyWeekdayMatch) {
        const weekday = parseWeekdayToken(everyWeekdayMatch[1]);
        if (weekday) {
            return { recurrence: buildWeeklyByDayRecurrence(weekday) };
        }
    }

    const everyIntervalMatch = /^every\s+(\d+)\s+(day|days|week|weeks|month|months|year|years)$/iu.exec(trimmed);
    if (everyIntervalMatch) {
        const interval = Number(everyIntervalMatch[1]);
        const unit = everyIntervalMatch[2].toLowerCase();
        if (unit.startsWith('day')) return { recurrence: buildIntervalRecurrence('daily', interval) };
        if (unit.startsWith('week')) return { recurrence: buildIntervalRecurrence('weekly', interval) };
        if (unit.startsWith('month')) return { recurrence: buildIntervalRecurrence('monthly', interval) };
        if (unit.startsWith('year')) return { recurrence: buildIntervalRecurrence('yearly', interval) };
    }

    const ordinalMonthMatch = /^(?:the|every)\s+([a-z0-9]+)\s+([a-z]+)\s+every\s+(\d+)\s+months?$/iu.exec(trimmed);
    if (ordinalMonthMatch) {
        const ordinal = parseOrdinalToken(ordinalMonthMatch[1]);
        const weekday = parseWeekdayToken(ordinalMonthMatch[2]);
        const interval = Number(ordinalMonthMatch[3]);
        if (ordinal !== undefined && weekday) {
            return { recurrence: buildMonthlyByDayRecurrence(`${ordinal}${weekday}` as RecurrenceByDay, interval) };
        }
    }

    if (/^last day of every \d+ months?$/iu.test(trimmed) || /^last day of every month$/iu.test(trimmed)) {
        return { unsupported: true };
    }

    return { unsupported: true };
};

const resolveTaskStatus = (
    statusValue: number,
    completedAt: string | undefined,
    counters: DgtWarningCounters
): { completedAt?: string; status: TaskStatus } => {
    if (completedAt) {
        return {
            status: 'done',
            completedAt,
        };
    }
    if (statusValue === DGT_STATUS_NONE) {
        return { status: 'inbox' };
    }
    if (statusValue === DGT_STATUS_NEXT_ACTION) {
        return { status: 'next' };
    }
    counters.unmappedStatuses += 1;
    return { status: 'inbox' };
};

const normalizeFolders = (rawFolders: unknown): NormalizedFolder[] => {
    if (!Array.isArray(rawFolders)) return [];
    return rawFolders.flatMap((value, index) => {
        const record = toRecord(value);
        const sourceId = toPositiveInt(record?.ID);
        if (!record || sourceId === undefined) return [];
        return [{
            sourceId,
            title: normalizeTitle(record.TITLE, `${DGT_AREA_FALLBACK} ${index + 1}`),
            color: normalizeColor(record.COLOR),
            order: normalizeOrder(record.ORDINAL, index),
            createdAt: normalizeDateString(record.CREATED, true),
            updatedAt: normalizeDateString(record.MODIFIED, true),
        }];
    });
};

const normalizeContexts = (rawContexts: unknown): NormalizedContext[] => {
    if (!Array.isArray(rawContexts)) return [];
    return rawContexts
        .map((value, index) => {
            const record = toRecord(value);
            const sourceId = toPositiveInt(record?.ID);
            if (!record || sourceId === undefined) return null;
            return {
                sourceId,
                title: normalizeTitle(record.TITLE, `Context ${index + 1}`),
            };
        })
        .filter((entry): entry is NormalizedContext => Boolean(entry));
};

const normalizeTags = (rawTags: unknown): NormalizedTag[] => {
    if (!Array.isArray(rawTags)) return [];
    return rawTags
        .map((value, index) => {
            const record = toRecord(value);
            const sourceId = toPositiveInt(record?.ID);
            if (!record || sourceId === undefined) return null;
            return {
                sourceId,
                title: normalizeTitle(record.TITLE, `Tag ${index + 1}`),
            };
        })
        .filter((entry): entry is NormalizedTag => Boolean(entry));
};

const normalizeTasks = (rawTasks: unknown): NormalizedTaskRecord[] => {
    if (!Array.isArray(rawTasks)) return [];
    return rawTasks.flatMap((value, index) => {
        const record = toRecord(value);
        const sourceId = toPositiveInt(record?.ID);
        if (!record || sourceId === undefined) return [];
        return [{
            sourceId,
            sourceIndex: index,
            type: Math.trunc(toNumberValue(record.TYPE, DGT_TYPE_TASK)),
            parentId: toPositiveInt(record.PARENT),
            title: normalizeTitle(record.TITLE, `${DGT_TASK_FALLBACK} ${index + 1}`),
            note: toStringValue(record.NOTE) || undefined,
            startDate: normalizeDateString(record.START_DATE, toBooleanFlag(record.START_TIME_SET)),
            startTimeSet: toBooleanFlag(record.START_TIME_SET),
            dueDate: normalizeDateString(record.DUE_DATE, toBooleanFlag(record.DUE_TIME_SET)),
            dueTimeSet: toBooleanFlag(record.DUE_TIME_SET),
            repeatText: toStringValue(record.REPEAT_NEW) || undefined,
            statusValue: Math.trunc(toNumberValue(record.STATUS, DGT_STATUS_NONE)),
            contextId: toPositiveInt(record.CONTEXT),
            folderId: toPositiveInt(record.FOLDER),
            tagIds: toIntegerArray(record.TAG),
            starred: toBooleanFlag(record.STARRED),
            priorityValue: Math.trunc(toNumberValue(record.PRIORITY, 0)),
            completedAt: normalizeDateString(record.COMPLETED, true),
            color: normalizeColor(record.COLOR),
            order: normalizeOrder(record.ORDINAL, index),
            createdAt: normalizeDateString(record.CREATED, true),
            updatedAt: normalizeDateString(record.MODIFIED, true),
        }];
    });
};

const parseDgtPayload = (
    payload: Record<string, unknown>,
    counters: DgtWarningCounters
): ParsedDgtImportData => {
    const folders = normalizeFolders(payload.FOLDER);
    const contexts = normalizeContexts(payload.CONTEXT);
    const tags = normalizeTags(payload.TAG);
    const records = normalizeTasks(payload.TASK);

    const contextMap = new Map<number, string>(
        contexts
            .map((context) => [context.sourceId, normalizeContextName(context.title)] as const)
            .filter((entry): entry is readonly [number, string] => Boolean(entry[1]))
    );
    const tagMap = new Map<number, string>(
        tags
            .map((tag) => [tag.sourceId, normalizeTagName(tag.title)] as const)
            .filter((entry): entry is readonly [number, string] => Boolean(entry[1]))
    );
    const recordMap = new Map<number, NormalizedTaskRecord>(records.map((record) => [record.sourceId, record]));
    const projectRecords = records.filter((record) => record.type === DGT_TYPE_PROJECT);
    const checklistItemIds = new Set<number>();
    const parsedAreas: ParsedDgtArea[] = folders
        .sort((left, right) => left.order - right.order || left.sourceId - right.sourceId)
        .map((folder) => ({
            sourceId: folder.sourceId,
            name: folder.title,
            order: folder.order,
            color: folder.color,
            createdAt: folder.createdAt,
            updatedAt: folder.updatedAt,
        }));

    const buildRecordTags = (record: NormalizedTaskRecord): string[] =>
        dedupeStrings(record.tagIds.map((tagId) => tagMap.get(tagId)));

    const buildRecordContexts = (record: NormalizedTaskRecord): string[] =>
        dedupeStrings(record.contextId ? [contextMap.get(record.contextId)] : []);

    const buildRepeatMetadata = (record: NormalizedTaskRecord): { descriptionSuffix?: string; recurrence?: Task['recurrence'] } => {
        if (!record.repeatText) return {};
        const repeatResolution = resolveRepeatPattern(record.repeatText, record.dueDate || record.startDate);
        if (repeatResolution.recurrence) {
            return { recurrence: repeatResolution.recurrence };
        }
        counters.unsupportedRepeats += 1;
        return {
            descriptionSuffix: `Original DGT repeat: ${record.repeatText}`,
        };
    };

    const buildTaskBase = (record: NormalizedTaskRecord): Omit<ParsedDgtTask, 'checklist' | 'projectSourceId'> => {
        const priority = normalizePriority(record.priorityValue, record.starred);
        const status = resolveTaskStatus(record.statusValue, record.completedAt, counters);
        const repeatMetadata = buildRepeatMetadata(record);
        return {
            sourceId: record.sourceId,
            title: record.title,
            order: record.order,
            areaSourceId: record.folderId,
            status: status.status,
            completedAt: status.completedAt,
            priority,
            contexts: buildRecordContexts(record),
            tags: buildRecordTags(record),
            description: joinDescription([record.note, repeatMetadata.descriptionSuffix]),
            dueDate: record.dueDate,
            startTime: record.startDate,
            recurrence: repeatMetadata.recurrence,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
        };
    };

    const parsedProjects: ParsedDgtProject[] = projectRecords
        .sort((left, right) => left.order - right.order || left.sourceIndex - right.sourceIndex)
        .map((record) => {
            const repeatMetadata = buildRepeatMetadata(record);
            const supportNotes = joinDescription([
                record.note,
                buildRecordContexts(record).length > 0 ? `Contexts: ${buildRecordContexts(record).join(', ')}` : undefined,
                buildRecordTags(record).length > 0 ? `Tags: ${buildRecordTags(record).join(', ')}` : undefined,
                repeatMetadata.descriptionSuffix,
            ]);
            return {
                sourceId: record.sourceId,
                name: record.title || DGT_PROJECT_FALLBACK,
                order: record.order,
                areaSourceId: record.folderId,
                color: record.color,
                dueDate: record.dueDate,
                supportNotes,
                isArchived: Boolean(record.completedAt),
                createdAt: record.createdAt,
                updatedAt: record.updatedAt,
            };
        });

    const parsedTasks: ParsedDgtTask[] = [];
    const checklistChildrenByParent = new Map<number, NormalizedTaskRecord[]>();
    records
        .filter((record) => record.type === DGT_TYPE_CHECKLIST_ITEM)
        .forEach((record) => {
            if (!record.parentId) return;
            const existing = checklistChildrenByParent.get(record.parentId) ?? [];
            existing.push(record);
            checklistChildrenByParent.set(record.parentId, existing);
        });

    const sortableNonProjectRecords = records
        .filter((record) => record.type !== DGT_TYPE_PROJECT && record.type !== DGT_TYPE_CHECKLIST_ITEM)
        .sort((left, right) => left.order - right.order || left.sourceIndex - right.sourceIndex);

    sortableNonProjectRecords.forEach((record) => {
        const isTaskLike = record.type === DGT_TYPE_TASK || record.type === DGT_TYPE_CHECKLIST;
        if (!isTaskLike) {
            counters.unknownTaskTypes += 1;
        }
        const checklistItems = (checklistChildrenByParent.get(record.sourceId) ?? [])
            .sort((left, right) => left.order - right.order || left.sourceIndex - right.sourceIndex)
            .map((item) => {
                checklistItemIds.add(item.sourceId);
                return {
                    id: uuidv4(),
                    title: item.title || DGT_TASK_FALLBACK,
                    isCompleted: Boolean(item.completedAt),
                };
            });
        const parentRecord = record.parentId ? recordMap.get(record.parentId) : undefined;
        const projectSourceId = parentRecord?.type === DGT_TYPE_PROJECT ? parentRecord.sourceId : undefined;
        const baseTask = buildTaskBase(record);
        parsedTasks.push({
            ...baseTask,
            projectSourceId,
            checklist: checklistItems,
        });
    });

    records
        .filter((record) => record.type === DGT_TYPE_CHECKLIST_ITEM && !checklistItemIds.has(record.sourceId))
        .sort((left, right) => left.order - right.order || left.sourceIndex - right.sourceIndex)
        .forEach((record) => {
            counters.orphanChecklistItems += 1;
            const parentRecord = record.parentId ? recordMap.get(record.parentId) : undefined;
            const projectSourceId = parentRecord?.type === DGT_TYPE_PROJECT ? parentRecord.sourceId : undefined;
            parsedTasks.push({
                ...buildTaskBase(record),
                projectSourceId,
                checklist: [],
            });
        });

    if (parsedProjects.length === 0 && parsedTasks.length === 0) {
        counters.emptyExports += 1;
    }

    return {
        areas: parsedAreas,
        projects: parsedProjects,
        tasks: parsedTasks,
        warnings: buildWarnings(counters),
    };
};

const buildPreview = (fileName: string, parsedData: ParsedDgtImportData): DgtImportPreview => {
    const taskCountByProject = new Map<number, number>();
    parsedData.tasks.forEach((task) => {
        if (!task.projectSourceId) return;
        taskCountByProject.set(task.projectSourceId, (taskCountByProject.get(task.projectSourceId) ?? 0) + 1);
    });
    const areaNameById = new Map(parsedData.areas.map((area) => [area.sourceId, area.name]));
    const projects = parsedData.projects.map((project) => ({
        name: project.name,
        areaName: project.areaSourceId ? areaNameById.get(project.areaSourceId) : undefined,
        taskCount: taskCountByProject.get(project.sourceId) ?? 0,
    }));
    const checklistItemCount = parsedData.tasks.reduce((sum, task) => sum + task.checklist.length, 0);
    const recurringCount = parsedData.tasks.reduce((sum, task) => sum + (task.recurrence ? 1 : 0), 0);
    const standaloneTaskCount = parsedData.tasks.filter((task) => !task.projectSourceId).length;
    return {
        fileName,
        areaCount: parsedData.areas.length,
        projectCount: parsedData.projects.length,
        taskCount: parsedData.tasks.length,
        checklistItemCount,
        recurringCount,
        standaloneTaskCount,
        projects,
        warnings: parsedData.warnings,
    };
};

const parseRawDgtExport = (text: string, counters: DgtWarningCounters): ParsedDgtImportData => {
    const payload = JSON.parse(sanitizeJsonText(text));
    const record = toRecord(payload);
    if (!record) {
        throw new Error('The selected DGT export is not a JSON object.');
    }
    return parseDgtPayload(record, counters);
};

export const parseDgtImportSource = (input: DgtFileInput): DgtImportParseResult => {
    const fileName = basename(input.fileName);
    const counters = createWarningCounters();
    const bytes = toUint8Array(input.bytes);

    try {
        let parsedData: ParsedDgtImportData | null = null;
        if (bytes && isZipBytes(bytes)) {
            const entries = unzipSync(bytes);
            for (const [entryName, entryBytes] of Object.entries(entries)) {
                const lowerName = entryName.toLowerCase();
                if (!entryName || entryName.endsWith('/')) continue;
                if (lowerName.endsWith('.zip')) {
                    counters.nestedZipFiles += 1;
                    continue;
                }
                if (!lowerName.endsWith('.json')) {
                    counters.nonJsonEntries += 1;
                    continue;
                }
                if (parsedData) continue;
                try {
                    parsedData = parseRawDgtExport(decodeTextBytes(entryBytes), counters);
                } catch {
                    counters.invalidJsonFiles += 1;
                }
            }
            if (!parsedData) {
                const warnings = buildWarnings(counters);
                return {
                    valid: false,
                    parsedData: null,
                    preview: null,
                    warnings,
                    errors: ['No importable DGT JSON export was found in the selected archive.'],
                };
            }
            const warnings = buildWarnings(counters);
            parsedData.warnings = warnings;
            if (parsedData.projects.length === 0 && parsedData.tasks.length === 0) {
                return {
                    valid: false,
                    parsedData: null,
                    preview: null,
                    warnings,
                    errors: ['No importable DGT tasks or projects were found in the selected file.'],
                };
            }
            return {
                valid: true,
                parsedData,
                preview: buildPreview(fileName, parsedData),
                warnings,
                errors: [],
            };
        }

        const text = input.text ?? (bytes ? decodeTextBytes(bytes) : '');
        const parsedTextResult = parseRawDgtExport(text, counters);
        const warnings = buildWarnings(counters);
        parsedTextResult.warnings = warnings;
        if (parsedTextResult.projects.length === 0 && parsedTextResult.tasks.length === 0) {
            return {
                valid: false,
                parsedData: null,
                preview: null,
                warnings,
                errors: ['No importable DGT tasks or projects were found in the selected file.'],
            };
        }
        return {
            valid: true,
            parsedData: parsedTextResult,
            preview: buildPreview(fileName, parsedTextResult),
            warnings,
            errors: [],
        };
    } catch (error) {
        const warnings = buildWarnings(counters);
        return {
            valid: false,
            parsedData: null,
            preview: null,
            warnings,
            errors: [
                error instanceof Error && error.message
                    ? error.message
                    : 'Failed to parse the DGT export.',
            ],
        };
    }
};

const resolveUniqueName = (title: string, usedTitles: Set<string>, fallback: string): string => {
    const trimmed = title.trim() || fallback;
    if (!usedTitles.has(trimmed.toLowerCase())) {
        usedTitles.add(trimmed.toLowerCase());
        return trimmed;
    }

    const base = `${trimmed}${DGT_IMPORT_SUFFIX}`;
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

const resolveTimestamp = (value: string | undefined, fallback: string): string => {
    const parsed = safeParseDate(value);
    return parsed ? value as string : fallback;
};

export const applyDgtImport = (
    currentData: AppData,
    parsedData: ParsedDgtImportData,
    options: { now?: Date | string } = {}
): DgtImportExecutionResult => {
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
    let importedAreaCount = 0;
    let importedProjectCount = 0;
    let importedTaskCount = 0;
    let importedChecklistItemCount = 0;

    const areaIdBySourceId = new Map<number, string>();
    const projectIdBySourceId = new Map<number, string>();

    const nextAreaOrder = nextData.areas
        .filter((area) => !area.deletedAt)
        .reduce((max, area) => Math.max(max, Number.isFinite(area.order) ? area.order : -1), -1) + 1;
    parsedData.areas
        .slice()
        .sort((left, right) => left.order - right.order || left.sourceId - right.sourceId)
        .forEach((area, index) => {
            const areaName = resolveUniqueName(area.name, usedAreaNames, DGT_AREA_FALLBACK);
            if (areaName !== area.name) {
                warnings.push(`Imported area "${area.name}" was renamed to "${areaName}" to avoid a name conflict.`);
            }
            const createdAt = resolveTimestamp(area.createdAt, nowIso);
            const updatedAt = resolveTimestamp(area.updatedAt, createdAt);
            const nextArea: Area = {
                id: uuidv4(),
                name: areaName,
                color: area.color ?? DEFAULT_AREA_COLOR,
                order: nextAreaOrder + index,
                createdAt,
                updatedAt,
                rev: 1,
                revBy: deviceState.deviceId,
            };
            nextData.areas.push(nextArea);
            areaIdBySourceId.set(area.sourceId, nextArea.id);
            importedAreaCount += 1;
        });

    parsedData.projects
        .slice()
        .sort((left, right) => left.order - right.order || left.sourceId - right.sourceId)
        .forEach((project) => {
            const areaId = project.areaSourceId ? areaIdBySourceId.get(project.areaSourceId) : undefined;
            const projectTitle = resolveUniqueName(project.name, usedProjectTitles, DGT_PROJECT_FALLBACK);
            if (projectTitle !== project.name) {
                warnings.push(`Imported project "${project.name}" was renamed to "${projectTitle}" to avoid a title conflict.`);
            }
            const siblingMaxOrder = nextData.projects
                .filter((item) => !item.deletedAt && (item.areaId ?? undefined) === areaId)
                .reduce((max, item) => Math.max(max, Number.isFinite(item.order) ? item.order : -1), -1);
            const createdAt = resolveTimestamp(project.createdAt, nowIso);
            const updatedAt = resolveTimestamp(project.updatedAt, createdAt);
            const nextProject: Project = {
                id: uuidv4(),
                title: projectTitle,
                status: project.isArchived ? 'archived' : 'active',
                color: project.color ?? DEFAULT_PROJECT_COLOR,
                order: siblingMaxOrder + 1,
                tagIds: [],
                dueDate: project.dueDate,
                supportNotes: project.supportNotes,
                createdAt,
                updatedAt,
                rev: 1,
                revBy: deviceState.deviceId,
                ...(areaId ? { areaId } : {}),
            };
            nextData.projects.push(nextProject);
            projectIdBySourceId.set(project.sourceId, nextProject.id);
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
        .sort((left, right) => left.order - right.order || left.sourceId - right.sourceId)
        .forEach((task) => {
            const projectId = task.projectSourceId ? projectIdBySourceId.get(task.projectSourceId) : undefined;
            const areaId = !projectId && task.areaSourceId ? areaIdBySourceId.get(task.areaSourceId) : undefined;
            const order = allocateTaskOrder(projectId, areaId);
            const createdAt = resolveTimestamp(task.createdAt, nowIso);
            const updatedAt = resolveTimestamp(task.updatedAt, createdAt);
            const checklist = task.checklist.length > 0
                ? task.checklist.map((item) => ({
                    id: uuidv4(),
                    title: item.title,
                    isCompleted: item.isCompleted,
                }))
                : undefined;
            const nextTask: Task = {
                id: uuidv4(),
                title: task.title,
                status: task.status,
                taskMode: checklist ? 'list' : 'task',
                priority: task.priority,
                contexts: task.contexts,
                tags: task.tags,
                description: task.description,
                startTime: task.startTime,
                dueDate: task.dueDate,
                recurrence: task.recurrence,
                completedAt: task.completedAt,
                checklist,
                pushCount: 0,
                createdAt,
                updatedAt,
                rev: 1,
                revBy: deviceState.deviceId,
                order,
                orderNum: order,
                ...(projectId ? { projectId } : {}),
                ...(areaId ? { areaId } : {}),
            };
            nextData.tasks.push(nextTask);
            importedTaskCount += 1;
            importedChecklistItemCount += checklist?.length ?? 0;
        });

    return {
        data: nextData,
        importedAreaCount,
        importedProjectCount,
        importedTaskCount,
        importedChecklistItemCount,
        warnings,
    };
};
