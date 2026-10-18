import { safeParseDate } from './date';
import { applyImport, type ImportExecutionResult, type ImportParseResult } from './import-apply';
import {
    appendWarning,
    basename,
    buildHeaderIndex,
    createImportArchiveBudget,
    dedupeStrings,
    decodeTextBytes,
    getCell,
    ImportSourceLimitError,
    joinDescription,
    parseCsvRows,
    readImportSource,
    sanitizeCsvText,
    type ImportArchiveBudget,
} from './import-source-reader';
import { normalizeRecurrenceForLoad } from './recurrence';
import { normalizeTagId } from './store-helpers';
import type { AppData, ChecklistItem, Task, TaskPriority, TaskStatus } from './types';
import { generateDeterministicUUID, generateUUID as uuidv4 } from './uuid';

const TICKTICK_REQUIRED_COLUMNS = ['TITLE', 'LIST NAME'];
const TICKTICK_DELIMITER = ',';
const TICKTICK_AREA_FALLBACK = 'TickTick Area';
const TICKTICK_PROJECT_FALLBACK = 'TickTick Import';
const TICKTICK_TASK_FALLBACK = 'Imported TickTick Task';
const TICKTICK_IMPORT_SUFFIX = ' (TickTick)';
const TICKTICK_IMPORT_ID_NAMESPACE = 'mindwtr:ticktick-import:v1';
const TICKTICK_CHECKLIST_UNCHECKED = '▫';
const TICKTICK_CHECKLIST_CHECKED = '▪';

const createTickTickImportId = (kind: 'area' | 'project' | 'section' | 'task', sourceKey: string): string => (
    generateDeterministicUUID(`${TICKTICK_IMPORT_ID_NAMESPACE}:${kind}:${sourceKey}`)
);

type TickTickFileInput = {
    bytes?: ArrayBuffer | Uint8Array | null;
    fileName: string;
    text?: string | null;
};

type TickTickWarningCounters = {
    childTasksConverted: number;
    emptyExports: number;
    emptyTitleRows: number;
    invalidCsvFiles: number;
    nestedZipFiles: number;
    nonCsvEntries: number;
    orphanChildTasks: number;
    unclosedQuotedFiles: number;
    unknownStatuses: number;
    unsupportedRepeats: number;
};

type NormalizedTickTickRecord = {
    areaSourceKey?: string;
    checklist: ChecklistItem[];
    completedAt?: string;
    content: string;
    createdAt?: string;
    dueDate?: string;
    isCompleted: boolean;
    order: number;
    parentId?: string;
    priority?: TaskPriority;
    projectSourceKey: string;
    recurrence?: Task['recurrence'];
    repeatText?: string;
    sourceId: string;
    sourceIndex: number;
    startTime?: string;
    status: TaskStatus;
    tags: string[];
    title: string;
    updatedAt?: string;
};

export type ParsedTickTickArea = {
    name: string;
    order: number;
    sourceKey: string;
};

export type ParsedTickTickProject = {
    areaSourceKey?: string;
    name: string;
    order: number;
    sourceKey: string;
};

export type ParsedTickTickTask = {
    areaSourceKey?: string;
    checklist: ChecklistItem[];
    completedAt?: string;
    createdAt?: string;
    description?: string;
    dueDate?: string;
    order: number;
    priority?: TaskPriority;
    projectSourceKey?: string;
    recurrence?: Task['recurrence'];
    sourceId: string;
    startTime?: string;
    status: TaskStatus;
    tags: string[];
    title: string;
    updatedAt?: string;
};

export type ParsedTickTickImportData = {
    areas: ParsedTickTickArea[];
    projects: ParsedTickTickProject[];
    tasks: ParsedTickTickTask[];
    warnings: string[];
};

export type TickTickImportProjectPreview = {
    areaName?: string;
    name: string;
    taskCount: number;
};

export type TickTickImportPreview = {
    areaCount: number;
    checklistItemCount: number;
    fileName: string;
    projectCount: number;
    projects: TickTickImportProjectPreview[];
    recurringCount: number;
    taskCount: number;
    warnings: string[];
};

export type TickTickImportParseResult = ImportParseResult<ParsedTickTickImportData, TickTickImportPreview>;

// TickTick doesn't surface importedStandaloneTaskCount even though applyImport() (called by
// applyTickTickImport below) always computes it — same trade-off as DGT.
export type TickTickImportExecutionResult = Omit<ImportExecutionResult, 'importedStandaloneTaskCount'>;

const createWarningCounters = (): TickTickWarningCounters => ({
    childTasksConverted: 0,
    emptyExports: 0,
    emptyTitleRows: 0,
    invalidCsvFiles: 0,
    nestedZipFiles: 0,
    nonCsvEntries: 0,
    orphanChildTasks: 0,
    unclosedQuotedFiles: 0,
    unknownStatuses: 0,
    unsupportedRepeats: 0,
});

const buildWarnings = (counters: TickTickWarningCounters): string[] => {
    const warnings: string[] = [];
    appendWarning(
        warnings,
        counters.childTasksConverted,
        '1 TickTick child task was imported as a checklist item on its parent task.',
        '{count} TickTick child tasks were imported as checklist items on their parent tasks.'
    );
    appendWarning(
        warnings,
        counters.orphanChildTasks,
        '1 TickTick child task had no matching parent and was imported as a normal task.',
        '{count} TickTick child tasks had no matching parent and were imported as normal tasks.'
    );
    appendWarning(
        warnings,
        counters.unsupportedRepeats,
        '1 TickTick repeat rule could not be mapped and will be imported once.',
        '{count} TickTick repeat rules could not be mapped and will be imported once.'
    );
    appendWarning(
        warnings,
        counters.unknownStatuses,
        '1 TickTick task status could not be mapped and was imported to Inbox.',
        '{count} TickTick task statuses could not be mapped and were imported to Inbox.'
    );
    appendWarning(
        warnings,
        counters.emptyTitleRows,
        '1 TickTick row with an empty title was skipped.',
        '{count} TickTick rows with empty titles were skipped.'
    );
    appendWarning(
        warnings,
        counters.nonCsvEntries,
        '1 non-CSV file inside the TickTick archive was skipped.',
        '{count} non-CSV files inside the TickTick archive were skipped.'
    );
    appendWarning(
        warnings,
        counters.nestedZipFiles,
        '1 nested ZIP file inside the TickTick archive was skipped.',
        '{count} nested ZIP files inside the TickTick archive were skipped.'
    );
    appendWarning(
        warnings,
        counters.unclosedQuotedFiles,
        '1 TickTick CSV file ended with an unclosed quoted field and was imported best-effort.',
        '{count} TickTick CSV files ended with unclosed quoted fields and were imported best-effort.'
    );
    appendWarning(
        warnings,
        counters.invalidCsvFiles,
        '1 TickTick CSV file could not be parsed and was skipped.',
        '{count} TickTick CSV files could not be parsed and were skipped.'
    );
    appendWarning(
        warnings,
        counters.emptyExports,
        '1 TickTick export contained no importable tasks.',
        '{count} TickTick exports contained no importable tasks.'
    );
    return warnings;
};

const findHeaderRowIndex = (rows: string[][]): number => rows.findIndex((row) => {
    const headerIndex = buildHeaderIndex(row);
    return TICKTICK_REQUIRED_COLUMNS.every((column) => headerIndex.has(column));
});

const normalizeSourcePart = (value: string, fallback: string): string => {
    const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
    return normalized || fallback;
};

const toNumber = (value: string, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const toBoolean = (value: string): boolean => /^(?:true|1|y|yes)$/iu.test(value.trim());

const parseTickTickTags = (value: string): string[] => dedupeStrings(
    value
        .split(/[,;\s]+/u)
        .map((tag) => normalizeTagId(tag.replace(/^#+/u, '')))
        .filter(Boolean)
);

const normalizeTickTickDateInput = (value: string): string => value.trim().replace(/([+-]\d{2})(\d{2})$/u, '$1:$2');

const parseTickTickTimestamp = (value: string): string | undefined => {
    const trimmed = normalizeTickTickDateInput(value);
    if (!trimmed) return undefined;
    const parsed = safeParseDate(trimmed);
    return parsed ? parsed.toISOString() : undefined;
};

const formatDateInTimeZone = (date: Date, timeZone: string): string => {
    const trimmedZone = timeZone.trim();
    if (!trimmedZone) return date.toISOString().slice(0, 10);
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: trimmedZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).formatToParts(date);
        const year = parts.find((part) => part.type === 'year')?.value;
        const month = parts.find((part) => part.type === 'month')?.value;
        const day = parts.find((part) => part.type === 'day')?.value;
        if (year && month && day) return `${year}-${month}-${day}`;
    } catch {
        // Fall back to UTC below when the runtime lacks this IANA timezone.
    }
    return date.toISOString().slice(0, 10);
};

const parseTickTickTaskDate = (value: string, isAllDay: boolean, timeZone: string): string | undefined => {
    const trimmed = normalizeTickTickDateInput(value);
    if (!trimmed) return undefined;
    if (/^\d{4}-\d{2}-\d{2}$/u.test(trimmed)) return trimmed;
    const exportedDate = trimmed.match(/^(\d{4}-\d{2}-\d{2})(?:[T\s]|$)/u)?.[1];
    if (isAllDay && !timeZone.trim() && exportedDate) return exportedDate;
    const parsed = safeParseDate(trimmed);
    if (!parsed) return undefined;
    return isAllDay ? formatDateInTimeZone(parsed, timeZone) : parsed.toISOString();
};

const parsePriority = (value: string): TaskPriority | undefined => {
    const priority = Math.trunc(toNumber(value, 0));
    if (priority >= 5) return 'high';
    if (priority >= 3) return 'medium';
    if (priority >= 1) return 'low';
    return undefined;
};

const parseRecurrence = (value: string, counters: TickTickWarningCounters): Task['recurrence'] | undefined => {
    const repeatLines = value
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean);
    if (repeatLines.length === 0) return undefined;
    const recurrence = normalizeRecurrenceForLoad(repeatLines[0]);
    if (recurrence) return recurrence;
    counters.unsupportedRepeats += 1;
    return undefined;
};

const countChecklistContentItems = (content: string): number => {
    let count = 0;
    let lineStart = 0;
    for (let index = 0; index <= content.length; index += 1) {
        if (index < content.length && content[index] !== '\n' && content[index] !== '\r') continue;
        const trimmed = content.slice(lineStart, index).trim();
        if (
            (trimmed.startsWith(TICKTICK_CHECKLIST_UNCHECKED) || trimmed.startsWith(TICKTICK_CHECKLIST_CHECKED))
            && trimmed.slice(1).trim().length > 0
        ) {
            count += 1;
        }
        if (content[index] === '\r' && content[index + 1] === '\n') index += 1;
        lineStart = index + 1;
    }
    return count;
};

const parseChecklistContent = (
    content: string,
    archiveBudget: ImportArchiveBudget,
): { checklist: ChecklistItem[]; description?: string } => {
    archiveBudget.consumeChecklistItems(countChecklistContentItems(content));
    const checklist: ChecklistItem[] = [];
    const descriptionLines: string[] = [];
    content.replace(/\r/gu, '\n').split('\n').forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (trimmed.startsWith(TICKTICK_CHECKLIST_UNCHECKED) || trimmed.startsWith(TICKTICK_CHECKLIST_CHECKED)) {
            const isCompleted = trimmed.startsWith(TICKTICK_CHECKLIST_CHECKED);
            const title = trimmed.slice(1).trim();
            if (title) {
                checklist.push({ id: uuidv4(), title, isCompleted });
            }
            return;
        }
        descriptionLines.push(trimmed);
    });
    return {
        checklist,
        description: joinDescription(descriptionLines),
    };
};

const createProjectSourceKey = (folderName: string, listName: string): string => {
    const folderPart = folderName.trim()
        ? `folder:${normalizeSourcePart(folderName, 'none')}`
        : 'folder:none';
    const listPart = `list:${normalizeSourcePart(listName, 'inbox')}`;
    return `${folderPart}/${listPart}`;
};

const resolveTaskStatus = (
    statusValue: string,
    completedAt: string | undefined,
    counters: TickTickWarningCounters
): { isCompleted: boolean; status: TaskStatus } => {
    const status = Math.trunc(toNumber(statusValue, 0));
    if (status === 2) return { status: 'archived', isCompleted: true };
    if (completedAt || status === 1) return { status: 'done', isCompleted: true };
    if (status === 0) return { status: 'inbox', isCompleted: false };
    counters.unknownStatuses += 1;
    return { status: 'inbox', isCompleted: false };
};

const appendSubtaskDetails = (parts: string[], child: NormalizedTickTickRecord): void => {
    const details: string[] = [];
    if (child.content.trim()) details.push(child.content.trim());
    if (child.repeatText) details.push(`Repeats in TickTick: ${child.repeatText}`);
    if (child.startTime) details.push(`Start: ${child.startTime}`);
    if (child.dueDate) details.push(`Due: ${child.dueDate}`);
    if (details.length > 0) {
        parts.push(`Subtask "${child.title}": ${details.join(' | ')}`);
    }
};

const parseTickTickRows = (
    csvText: string,
    counters: TickTickWarningCounters,
    archiveBudget: ImportArchiveBudget,
): ParsedTickTickImportData => {
    const { rows, hasUnclosedQuote } = parseCsvRows(sanitizeCsvText(csvText), TICKTICK_DELIMITER, undefined, archiveBudget);
    if (hasUnclosedQuote) counters.unclosedQuotedFiles += 1;
    if (rows.length === 0) {
        counters.emptyExports += 1;
        return { areas: [], projects: [], tasks: [], warnings: [] };
    }

    const headerRowIndex = findHeaderRowIndex(rows);
    if (headerRowIndex === -1) {
        throw new Error('TickTick CSV is missing required columns: List Name, Title');
    }
    const headerIndex = buildHeaderIndex(rows[headerRowIndex] || []);
    const missingRequired = TICKTICK_REQUIRED_COLUMNS.filter((column) => !headerIndex.has(column));
    if (missingRequired.length > 0) {
        throw new Error(`TickTick CSV is missing required columns: ${missingRequired.join(', ')}`);
    }

    const areasByKey = new Map<string, ParsedTickTickArea>();
    const projectsByKey = new Map<string, ParsedTickTickProject>();
    const records: NormalizedTickTickRecord[] = [];

    for (let rowIndex = headerRowIndex + 1; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex] || [];
        const title = getCell(row, headerIndex, 'TITLE').trim();
        const content = getCell(row, headerIndex, 'CONTENT').replace(/\r/gu, '\n').trim();
        if (!title) {
            if (row.some((cell) => String(cell || '').trim().length > 0)) counters.emptyTitleRows += 1;
            continue;
        }

        const folderName = getCell(row, headerIndex, 'FOLDER NAME').trim();
        const listName = getCell(row, headerIndex, 'LIST NAME').trim() || TICKTICK_PROJECT_FALLBACK;
        const sourceIndex = records.length;
        const areaSourceKey = folderName ? `folder:${normalizeSourcePart(folderName, `folder-${sourceIndex + 1}`)}` : undefined;
        const projectSourceKey = createProjectSourceKey(folderName, listName);
        const order = toNumber(getCell(row, headerIndex, 'ORDER'), sourceIndex);
        const timeZone = getCell(row, headerIndex, 'TIMEZONE');
        const isAllDay = toBoolean(getCell(row, headerIndex, 'IS ALL DAY'));
        const completedAt = parseTickTickTimestamp(getCell(row, headerIndex, 'COMPLETED TIME'));
        const status = resolveTaskStatus(getCell(row, headerIndex, 'STATUS'), completedAt, counters);
        const isChecklist = toBoolean(getCell(row, headerIndex, 'IS CHECK LIST'))
            || getCell(row, headerIndex, 'KIND').toUpperCase() === 'CHECKLIST';
        const checklistData = isChecklist ? parseChecklistContent(content, archiveBudget) : { checklist: [], description: content || undefined };
        const repeatText = getCell(row, headerIndex, 'REPEAT');
        const recurrence = parseRecurrence(repeatText, counters);
        const sourceId = getCell(row, headerIndex, 'TASKID') || `row-${rowIndex + 1}`;

        if (areaSourceKey && !areasByKey.has(areaSourceKey)) {
            areasByKey.set(areaSourceKey, {
                sourceKey: areaSourceKey,
                name: folderName || TICKTICK_AREA_FALLBACK,
                order: areasByKey.size,
            });
        }
        if (!projectsByKey.has(projectSourceKey)) {
            projectsByKey.set(projectSourceKey, {
                sourceKey: projectSourceKey,
                name: listName,
                order: projectsByKey.size,
                ...(areaSourceKey ? { areaSourceKey } : {}),
            });
        }

        records.push({
            areaSourceKey,
            checklist: checklistData.checklist,
            completedAt,
            content: checklistData.description || '',
            createdAt: parseTickTickTimestamp(getCell(row, headerIndex, 'CREATED TIME')),
            dueDate: parseTickTickTaskDate(getCell(row, headerIndex, 'DUE DATE'), isAllDay, timeZone),
            isCompleted: status.isCompleted,
            order,
            parentId: getCell(row, headerIndex, 'PARENTID') || undefined,
            priority: parsePriority(getCell(row, headerIndex, 'PRIORITY')),
            projectSourceKey,
            recurrence,
            repeatText: repeatText || undefined,
            sourceId,
            sourceIndex,
            startTime: parseTickTickTaskDate(getCell(row, headerIndex, 'START DATE'), isAllDay, timeZone),
            status: status.status,
            tags: parseTickTickTags(getCell(row, headerIndex, 'TAGS')),
            title,
            updatedAt: completedAt || parseTickTickTimestamp(getCell(row, headerIndex, 'CREATED TIME')),
        });
    }

    const recordById = new Map(records.map((record) => [record.sourceId, record]));
    const checklistChildrenByParent = new Map<string, NormalizedTickTickRecord[]>();
    const convertedChildIds = new Set<string>();
    const resolveChecklistParent = (record: NormalizedTickTickRecord): NormalizedTickTickRecord | null => {
        if (!record.parentId) return null;
        let parent = recordById.get(record.parentId);
        if (!parent) {
            counters.orphanChildTasks += 1;
            return null;
        }

        const visited = new Set<string>([record.sourceId, parent.sourceId]);
        while (parent.parentId) {
            const grandparent = recordById.get(parent.parentId);
            if (!grandparent) return parent;
            if (visited.has(grandparent.sourceId)) return null;
            visited.add(grandparent.sourceId);
            parent = grandparent;
        }
        return parent;
    };

    records.forEach((record) => {
        const parent = resolveChecklistParent(record);
        if (!parent) return;
        const children = checklistChildrenByParent.get(parent.sourceId) ?? [];
        children.push(record);
        checklistChildrenByParent.set(parent.sourceId, children);
        convertedChildIds.add(record.sourceId);
        counters.childTasksConverted += 1;
    });

    const parsedTasks: ParsedTickTickTask[] = [];
    records.forEach((record) => {
        if (convertedChildIds.has(record.sourceId)) return;
        const descriptionParts = [record.content];
        const checklistChildren = checklistChildrenByParent.get(record.sourceId) ?? [];
        archiveBudget.consumeChecklistItems(checklistChildren.length);
        const childChecklistItems = checklistChildren
            .sort((left, right) => left.order - right.order || left.sourceIndex - right.sourceIndex)
            .map((child) => {
                appendSubtaskDetails(descriptionParts, child);
                record.tags = dedupeStrings([...record.tags, ...child.tags]);
                return {
                    id: uuidv4(),
                    title: child.title || TICKTICK_TASK_FALLBACK,
                    isCompleted: child.isCompleted,
                };
            });
        parsedTasks.push({
            sourceId: record.sourceId,
            title: record.title || TICKTICK_TASK_FALLBACK,
            order: record.sourceIndex,
            status: record.status,
            tags: dedupeStrings(record.tags),
            checklist: [...record.checklist, ...childChecklistItems],
            description: joinDescription(descriptionParts),
            completedAt: record.completedAt,
            priority: record.priority,
            dueDate: record.dueDate,
            startTime: record.startTime,
            recurrence: record.recurrence,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            projectSourceKey: record.projectSourceKey,
            areaSourceKey: record.areaSourceKey,
        });
    });

    if (parsedTasks.length === 0) counters.emptyExports += 1;

    const usedProjectKeys = new Set(parsedTasks.map((task) => task.projectSourceKey).filter(Boolean));
    const projects = Array.from(projectsByKey.values()).filter((project) => usedProjectKeys.has(project.sourceKey));
    const usedAreaKeys = new Set(projects.map((project) => project.areaSourceKey).filter(Boolean) as string[]);
    const areas = Array.from(areasByKey.values()).filter((area) => usedAreaKeys.has(area.sourceKey));

    return {
        areas,
        projects,
        tasks: parsedTasks,
        warnings: [],
    };
};

const mergeParsedData = (target: ParsedTickTickImportData, source: ParsedTickTickImportData): void => {
    const areaKeys = new Set(target.areas.map((area) => area.sourceKey));
    const projectKeys = new Set(target.projects.map((project) => project.sourceKey));
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
    // One push per task: QuickJS (native Android) refuses a call with more than 65535 arguments.
    source.tasks.forEach((task) => target.tasks.push(task));
};

const buildPreview = (fileName: string, parsedData: ParsedTickTickImportData): TickTickImportPreview => {
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
    const recurringCount = parsedData.tasks.reduce((sum, task) => sum + (task.recurrence ? 1 : 0), 0);
    return {
        fileName,
        areaCount: parsedData.areas.length,
        projectCount: parsedData.projects.length,
        taskCount: parsedData.tasks.length,
        checklistItemCount,
        recurringCount,
        projects,
        warnings: parsedData.warnings,
    };
};

export const parseTickTickImportSource = (input: TickTickFileInput): TickTickImportParseResult => {
    const fileName = basename(input.fileName);
    const counters = createWarningCounters();
    const parsedData: ParsedTickTickImportData = { areas: [], projects: [], tasks: [], warnings: [] };
    const archiveBudget = createImportArchiveBudget();

    const parseOneCsv = (csvText: string): void => {
        const parsed = parseTickTickRows(csvText, counters, archiveBudget);
        archiveBudget.consumeEntities(parsed.areas.length + parsed.projects.length + parsed.tasks.length);
        mergeParsedData(parsedData, parsed);
    };

    try {
        const source = readImportSource(input);
        if (source.kind === 'archive') {
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
                try {
                    parseOneCsv(decodeTextBytes(entryBytes));
                } catch (error) {
                    if (error instanceof ImportSourceLimitError) throw error;
                    counters.invalidCsvFiles += 1;
                }
            });
        } else {
            parseOneCsv(source.text);
        }
    } catch (error) {
        const warnings = buildWarnings(counters);
        return {
            valid: false,
            parsedData: null,
            preview: null,
            warnings,
            errors: [error instanceof Error && error.message ? error.message : 'Failed to parse the TickTick export.'],
        };
    }

    const warnings = buildWarnings(counters);
    parsedData.warnings = warnings;
    const errors = parsedData.tasks.length === 0 ? ['No importable TickTick tasks were found in the selected file.'] : [];
    return {
        valid: errors.length === 0,
        parsedData: errors.length === 0 ? parsedData : null,
        preview: errors.length === 0 ? buildPreview(fileName, parsedData) : null,
        warnings,
        errors,
    };
};

// TickTick's raw CSV timestamps aren't ISO — normalize before handing them to applyImport's
// shared resolveTimestamp, which only validates-and-falls-back (see import-apply.ts).
const normalizeParsedTimestamp = (value: string | undefined): string | undefined => {
    const parsed = safeParseDate(value);
    return parsed ? parsed.toISOString() : undefined;
};

const resolveImportedTaskStatus = (status: TaskStatus, projectId: string | undefined): TaskStatus => (
    status === 'inbox' && projectId ? 'next' : status
);

// TickTick derives stable ids from source keys (namespaced UUIDv5-style hash), so re-importing
// the same export is idempotent: existing areas/projects/tasks are matched by id and skipped.
export const applyTickTickImport = (
    currentData: AppData,
    parsedData: ParsedTickTickImportData,
    options: { now?: Date | string } = {}
): TickTickImportExecutionResult => {
    const areas = [...parsedData.areas].sort((left, right) => left.order - right.order || left.sourceKey.localeCompare(right.sourceKey));
    const projects = [...parsedData.projects].sort((left, right) => left.order - right.order || left.sourceKey.localeCompare(right.sourceKey));
    const tasks = parsedData.tasks.map((task) => ({
        ...task,
        sourceKey: `${task.projectSourceKey ?? 'none'}:${task.sourceId}`,
        createdAt: normalizeParsedTimestamp(task.createdAt),
        updatedAt: normalizeParsedTimestamp(task.updatedAt),
    }));
    return applyImport(
        currentData,
        { areas, projects, tasks, warnings: parsedData.warnings },
        {
            fallbacks: { area: TICKTICK_AREA_FALLBACK, project: TICKTICK_PROJECT_FALLBACK },
            idFor: createTickTickImportId,
            now: options.now,
            resolveTaskStatus: resolveImportedTaskStatus,
            suffix: TICKTICK_IMPORT_SUFFIX,
        }
    );
};
