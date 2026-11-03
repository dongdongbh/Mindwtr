import { DEFAULT_PROJECT_COLOR } from './color-constants';
import {
    appendWarning,
    basename,
    buildHeaderIndex,
    createImportArchiveBudget,
    decodeTextBytes,
    detectDelimiter,
    formatLocalDate,
    getCell,
    ImportSourceLimitError,
    joinDescription,
    parseCsvRows,
    readImportSource,
    sanitizeCsvText,
    type ImportArchiveBudget,
} from './import-source-reader';
import { ensureDeviceId, normalizeTagId } from './store-helpers';
import type { AppData, Project, Section, Task, TaskPriority } from './types';
import { generateDeterministicUUID, generateUUID as uuidv4 } from './uuid';

const TODOIST_REQUIRED_COLUMNS = ['TYPE', 'CONTENT'];
const TODOIST_PROJECT_FALLBACK = 'Todoist Import';
const TODOIST_IMPORT_SUFFIX = ' (Todoist)';
const TODOIST_IMPORT_ID_NAMESPACE = 'mindwtr:todoist-import:v1';

const createTodoistImportId = (kind: 'project' | 'section' | 'task', sourceKey: string): string => (
    generateDeterministicUUID(`${TODOIST_IMPORT_ID_NAMESPACE}:${kind}:${sourceKey}`)
);

type TodoistFileInput = {
    bytes?: ArrayBuffer | Uint8Array | null;
    fileName: string;
    text?: string | null;
};

type TodoistWarningCounters = {
    emptyFiles: number;
    invalidCsvFiles: number;
    nestedZipFiles: number;
    nonCsvEntries: number;
    noteWithoutTask: number;
    orphanSubtasks: number;
    recurringTasks: number;
    unclosedQuotedFiles: number;
    unknownRowTypes: number;
    unparsedDates: number;
};

type ParsedTodoistRow = {
    content: string;
    date: string;
    description: string;
    indent: number;
    lineNumber: number;
    priority: number;
    type: 'task' | 'section' | 'note';
};

type RawTodoistTask = {
    date: string;
    description: string;
    dueDate?: string;
    indent: number;
    lineNumber: number;
    notes: string[];
    priority?: TaskPriority;
    recurringText?: string;
    sectionName?: string;
    tags: string[];
    title: string;
};

type MutableParsedTodoistTask = {
    checklist: string[];
    descriptionParts: string[];
    dueDate?: string;
    priority?: TaskPriority;
    recurringText?: string;
    sectionName?: string;
    tags: string[];
    title: string;
};

export type ParsedTodoistTask = {
    checklist: string[];
    description?: string;
    dueDate?: string;
    priority?: TaskPriority;
    recurringText?: string;
    sectionName?: string;
    tags: string[];
    title: string;
};

export type ParsedTodoistProject = {
    checklistItemCount: number;
    name: string;
    recurringCount: number;
    sections: string[];
    tasks: ParsedTodoistTask[];
};

export type TodoistImportProjectPreview = {
    checklistItemCount: number;
    name: string;
    recurringCount: number;
    sectionCount: number;
    taskCount: number;
};

export type TodoistImportPreview = {
    checklistItemCount: number;
    fileName: string;
    projectCount: number;
    projects: TodoistImportProjectPreview[];
    recurringCount: number;
    sectionCount: number;
    taskCount: number;
    warnings: string[];
};

export type TodoistImportParseResult = {
    errors: string[];
    parsedProjects: ParsedTodoistProject[];
    preview: TodoistImportPreview | null;
    valid: boolean;
    warnings: string[];
};

export type TodoistImportExecutionResult = {
    data: AppData;
    importedChecklistItemCount: number;
    importedProjectCount: number;
    importedSectionCount: number;
    importedTaskCount: number;
    warnings: string[];
};

const createWarningCounters = (): TodoistWarningCounters => ({
    emptyFiles: 0,
    invalidCsvFiles: 0,
    nestedZipFiles: 0,
    nonCsvEntries: 0,
    noteWithoutTask: 0,
    orphanSubtasks: 0,
    recurringTasks: 0,
    unclosedQuotedFiles: 0,
    unknownRowTypes: 0,
    unparsedDates: 0,
});

const buildTodoistWarnings = (counters: TodoistWarningCounters): string[] => {
    const warnings: string[] = [];
    appendWarning(warnings, counters.recurringTasks, '1 recurring Todoist task will be imported once.', '{count} recurring Todoist tasks will be imported once.');
    appendWarning(warnings, counters.unparsedDates, '1 Todoist due date could not be parsed and was skipped.', '{count} Todoist due dates could not be parsed and were skipped.');
    appendWarning(warnings, counters.noteWithoutTask, '1 Todoist note row was skipped because it had no preceding task.', '{count} Todoist note rows were skipped because they had no preceding task.');
    appendWarning(warnings, counters.orphanSubtasks, '1 Todoist subtask had no parent task and was imported as a normal task.', '{count} Todoist subtasks had no parent task and were imported as normal tasks.');
    appendWarning(warnings, counters.nonCsvEntries, '1 non-CSV file inside the Todoist ZIP was skipped.', '{count} non-CSV files inside the Todoist ZIP were skipped.');
    appendWarning(warnings, counters.nestedZipFiles, '1 nested ZIP file inside the Todoist archive was skipped.', '{count} nested ZIP files inside the Todoist archive were skipped.');
    appendWarning(warnings, counters.unclosedQuotedFiles, '1 Todoist CSV file ended with an unclosed quoted field and was imported best-effort.', '{count} Todoist CSV files ended with unclosed quoted fields and were imported best-effort.');
    appendWarning(warnings, counters.invalidCsvFiles, '1 Todoist CSV file could not be parsed and was skipped.', '{count} Todoist CSV files could not be parsed and were skipped.');
    appendWarning(warnings, counters.emptyFiles, '1 Todoist file contained no tasks.', '{count} Todoist files contained no tasks.');
    appendWarning(warnings, counters.unknownRowTypes, '1 Todoist row had an unknown TYPE value and was skipped.', '{count} Todoist rows had unknown TYPE values and were skipped.');
    return warnings;
};

const stripExtension = (value: string): string => value.replace(/\.[^.]+$/u, '');

const normalizeProjectName = (value: string): string => {
    const base = stripExtension(basename(value)).trim();
    return base || TODOIST_PROJECT_FALLBACK;
};

const extractTodoistLabels = (content: string): { labels: string[]; title: string } => {
    const labels: string[] = [];
    const title = content
        .replace(/(^|\s)@([\p{L}\p{N}_./-]+)/gu, (_full, prefix: string, label: string) => {
            const normalized = normalizeTagId(label);
            if (normalized) labels.push(normalized);
            return prefix;
        })
        .replace(/\s{2,}/gu, ' ')
        .trim();
    return {
        labels: Array.from(new Set(labels)),
        title,
    };
};

const parsePriority = (value: string): TaskPriority | undefined => {
    const numeric = Number.parseInt(value, 10);
    if (numeric === 1) return 'urgent';
    if (numeric === 2) return 'high';
    if (numeric === 3) return 'medium';
    return undefined;
};

const parseTodoistDate = (
    rawValue: string,
    counters: TodoistWarningCounters
): { dueDate?: string; recurringText?: string } => {
    const text = rawValue.trim();
    if (!text) return {};

    if (/\bevery!?(?:\s|$)/iu.test(text)) {
        counters.recurringTasks += 1;
        return { recurringText: text };
    }

    if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) {
        return { dueDate: text };
    }

    const isoCandidate = text.match(/^\d{4}-\d{2}-\d{2}(?:[T\s].+)?$/u) ? new Date(text) : null;
    if (isoCandidate && Number.isFinite(isoCandidate.getTime())) {
        return { dueDate: isoCandidate.toISOString() };
    }

    const normalized = text.toLowerCase();
    const now = new Date();
    const inMatch = normalized.match(/^in\s+(\d+)\s+(day|days|week|weeks|month|months|year|years)$/u);
    if (inMatch) {
        const count = Number.parseInt(inMatch[1], 10);
        const unit = inMatch[2];
        const date = new Date(now);
        if (unit.startsWith('day')) date.setDate(date.getDate() + count);
        else if (unit.startsWith('week')) date.setDate(date.getDate() + count * 7);
        else if (unit.startsWith('month')) date.setMonth(date.getMonth() + count);
        else if (unit.startsWith('year')) date.setFullYear(date.getFullYear() + count);
        return { dueDate: formatLocalDate(date) };
    }

    if (normalized === 'today') {
        return { dueDate: formatLocalDate(now) };
    }
    if (normalized === 'tomorrow') {
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        return { dueDate: formatLocalDate(tomorrow) };
    }
    const weekdayMap: Record<string, number> = {
        sunday: 0,
        monday: 1,
        tuesday: 2,
        wednesday: 3,
        thursday: 4,
        friday: 5,
        saturday: 6,
    };
    const weekday = weekdayMap[normalized];


    if (typeof weekday === 'number') {
        const target = new Date(now);
        const delta = (weekday - target.getDay() + 7) % 7 || 7;
        target.setDate(target.getDate() + delta);
        return { dueDate: formatLocalDate(target) };
    }


    if (/\b\d{4}\b/u.test(text)) {
        const parsed = new Date(text);
        if (Number.isFinite(parsed.getTime())) {
            const hasClockTime = /\d{1,2}:\d{2}|\d\s*[ap]\.?m\b/iu.test(text);
            return { dueDate: hasClockTime ? parsed.toISOString() : formatLocalDate(parsed) };
        }
    }

    counters.unparsedDates += 1;
    return {};
};

const buildDescriptionParts = (rawTask: RawTodoistTask): string[] => {
    const parts: string[] = [];
    const description = rawTask.description.trim();
    if (description) {
        parts.push(description);
    }
    if (rawTask.notes.length > 0) {
        parts.push(rawTask.notes.join('\n\n'));
    }
    if (rawTask.recurringText) {
        parts.push(`Imported from Todoist recurring schedule: ${rawTask.recurringText}`);
    }
    return parts;
};

const appendSubtaskDetails = (task: MutableParsedTodoistTask, rawTask: RawTodoistTask, checklistTitle: string): void => {
    const details: string[] = [];
    if (rawTask.description.trim()) {
        details.push(rawTask.description.trim());
    }
    if (rawTask.notes.length > 0) {
        details.push(rawTask.notes.join(' | '));
    }
    if (rawTask.recurringText) {
        details.push(`Recurring in Todoist: ${rawTask.recurringText}`);
    }
    if (rawTask.dueDate) {
        details.push(`Due: ${rawTask.dueDate}`);
    }
    if (details.length === 0) return;
    task.descriptionParts.push(`Subtask "${checklistTitle}": ${details.join(' | ')}`);
};

const finalizeParsedTask = (task: MutableParsedTodoistTask): ParsedTodoistTask => ({
    title: task.title,
    tags: Array.from(new Set(task.tags)),
    checklist: task.checklist,
    ...(task.descriptionParts.length > 0 ? { description: joinDescription(task.descriptionParts) } : {}),
    ...(task.priority ? { priority: task.priority } : {}),
    ...(task.dueDate ? { dueDate: task.dueDate } : {}),
    ...(task.recurringText ? { recurringText: task.recurringText } : {}),
    ...(task.sectionName ? { sectionName: task.sectionName } : {}),
});

const parseTodoistRows = (
    csvText: string,
    fileName: string,
    counters: TodoistWarningCounters,
    archiveBudget: ImportArchiveBudget,
): ParsedTodoistProject => {
    const delimiter = detectDelimiter(csvText);
    const { rows, hasUnclosedQuote } = parseCsvRows(sanitizeCsvText(csvText), delimiter, undefined, archiveBudget);
    if (hasUnclosedQuote) {
        counters.unclosedQuotedFiles += 1;
    }
    if (rows.length === 0) {
        counters.emptyFiles += 1;
        return {
            name: normalizeProjectName(fileName),
            tasks: [],
            sections: [],
            recurringCount: 0,
            checklistItemCount: 0,
        };
    }

    const headerIndex = buildHeaderIndex(rows[0]);
    const missingRequired = TODOIST_REQUIRED_COLUMNS.filter((key) => !headerIndex.has(key));
    if (missingRequired.length > 0) {
        throw new Error(`Todoist CSV is missing required columns: ${missingRequired.join(', ')}`);
    }

    const parsedRows: ParsedTodoistRow[] = [];
    for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex];
        const typeValue = getCell(row, headerIndex, 'TYPE').toLowerCase();
        const content = getCell(row, headerIndex, 'CONTENT');
        const description = getCell(row, headerIndex, 'DESCRIPTION');
        const date = getCell(row, headerIndex, 'DATE');
        const priority = Number.parseInt(getCell(row, headerIndex, 'PRIORITY'), 10);
        const indent = Math.max(1, Number.parseInt(getCell(row, headerIndex, 'INDENT') || '1', 10) || 1);

        if (!typeValue && !content && !description) continue;
        if (typeValue !== 'task' && typeValue !== 'section' && typeValue !== 'note') {
            counters.unknownRowTypes += 1;
            continue;
        }

        parsedRows.push({
            type: typeValue,
            content,
            description,
            date,
            priority,
            indent,
            lineNumber: rowIndex + 1,
        });
    }

    const sections: string[] = [];
    let currentSectionName: string | undefined;
    const rawTasks: RawTodoistTask[] = [];
    let lastTask: RawTodoistTask | null = null;

    for (const row of parsedRows) {
        if (row.type === 'section') {
            const title = row.content.trim();
            currentSectionName = title || undefined;
            if (title) sections.push(title);
            continue;
        }
        if (row.type === 'note') {
            const noteText = row.content.trim() || row.description.trim();
            if (!lastTask || !noteText) {
                counters.noteWithoutTask += 1;
                continue;
            }
            lastTask.notes.push(noteText);
            continue;
        }

        const { title, labels } = extractTodoistLabels(row.content);
        const taskTitle = title.trim();
        if (!taskTitle) continue;

        const { dueDate, recurringText } = parseTodoistDate(row.date, counters);
        const priority = parsePriority(String(row.priority));
        const rawTask: RawTodoistTask = {
            title: taskTitle,
            tags: labels,
            description: row.description,
            date: row.date,
            indent: row.indent,
            lineNumber: row.lineNumber,
            notes: [],
            ...(currentSectionName ? { sectionName: currentSectionName } : {}),
            ...(priority ? { priority } : {}),
            ...(dueDate ? { dueDate } : {}),
            ...(recurringText ? { recurringText } : {}),
        };
        rawTasks.push(rawTask);
        lastTask = rawTask;
    }

    if (rawTasks.length === 0) {
        counters.emptyFiles += 1;
        return {
            name: normalizeProjectName(fileName),
            tasks: [],
            sections: Array.from(new Set(sections)),
            recurringCount: 0,
            checklistItemCount: 0,
        };
    }

    const finalizedTasks: MutableParsedTodoistTask[] = [];
    const ownerIndexByRawTask = new Map<number, number>();
    const rawTaskIndexByIndent = new Map<number, number>();
    let checklistItemCount = 0;
    let recurringCount = 0;

    for (let rawIndex = 0; rawIndex < rawTasks.length; rawIndex += 1) {
        const rawTask = rawTasks[rawIndex];
        const cleanedDeeperIndents = Array.from(rawTaskIndexByIndent.keys()).filter((indent) => indent > rawTask.indent);
        cleanedDeeperIndents.forEach((indent) => rawTaskIndexByIndent.delete(indent));
        rawTaskIndexByIndent.set(rawTask.indent, rawIndex);

        if (rawTask.indent <= 1) {
            finalizedTasks.push({
                title: rawTask.title,
                tags: rawTask.tags,
                checklist: [],
                descriptionParts: buildDescriptionParts(rawTask),
                ...(rawTask.priority ? { priority: rawTask.priority } : {}),
                ...(rawTask.dueDate ? { dueDate: rawTask.dueDate } : {}),
                ...(rawTask.recurringText ? { recurringText: rawTask.recurringText } : {}),
                ...(rawTask.sectionName ? { sectionName: rawTask.sectionName } : {}),
            });
            ownerIndexByRawTask.set(rawIndex, finalizedTasks.length - 1);
            if (rawTask.recurringText) recurringCount += 1;
            continue;
        }

        let parentRawIndex: number | undefined;
        for (let indent = rawTask.indent - 1; indent >= 1; indent -= 1) {
            const candidate = rawTaskIndexByIndent.get(indent);
            if (candidate !== undefined) {
                parentRawIndex = candidate;
                break;
            }
        }

        if (parentRawIndex === undefined) {
            counters.orphanSubtasks += 1;
            finalizedTasks.push({
                title: rawTask.title,
                tags: rawTask.tags,
                checklist: [],
                descriptionParts: buildDescriptionParts(rawTask),
                ...(rawTask.priority ? { priority: rawTask.priority } : {}),
                ...(rawTask.dueDate ? { dueDate: rawTask.dueDate } : {}),
                ...(rawTask.recurringText ? { recurringText: rawTask.recurringText } : {}),
                ...(rawTask.sectionName ? { sectionName: rawTask.sectionName } : {}),
            });
            ownerIndexByRawTask.set(rawIndex, finalizedTasks.length - 1);
            if (rawTask.recurringText) recurringCount += 1;
            continue;
        }

        const ownerIndex = ownerIndexByRawTask.get(parentRawIndex);
        if (ownerIndex === undefined) {
            counters.orphanSubtasks += 1;
            finalizedTasks.push({
                title: rawTask.title,
                tags: rawTask.tags,
                checklist: [],
                descriptionParts: buildDescriptionParts(rawTask),
                ...(rawTask.priority ? { priority: rawTask.priority } : {}),
                ...(rawTask.dueDate ? { dueDate: rawTask.dueDate } : {}),
                ...(rawTask.recurringText ? { recurringText: rawTask.recurringText } : {}),
                ...(rawTask.sectionName ? { sectionName: rawTask.sectionName } : {}),
            });
            ownerIndexByRawTask.set(rawIndex, finalizedTasks.length - 1);
            if (rawTask.recurringText) recurringCount += 1;
            continue;
        }

        const ownerTask = finalizedTasks[ownerIndex];
        const checklistTitle = `${rawTask.indent > 2 ? `${'> '.repeat(rawTask.indent - 2)}` : ''}${rawTask.title}`.trim();
        ownerTask.checklist.push(checklistTitle);
        ownerTask.tags = Array.from(new Set([...ownerTask.tags, ...rawTask.tags]));
        appendSubtaskDetails(ownerTask, rawTask, checklistTitle);
        ownerIndexByRawTask.set(rawIndex, ownerIndex);
        checklistItemCount += 1;
        if (rawTask.recurringText) recurringCount += 1;
    }

    return {
        name: normalizeProjectName(fileName),
        tasks: finalizedTasks.map(finalizeParsedTask),
        sections: Array.from(new Set(sections)),
        recurringCount,
        checklistItemCount,
    };
};

const resolveUniqueProjectTitle = (title: string, usedTitles: Set<string>): string => {
    const trimmed = title.trim() || TODOIST_PROJECT_FALLBACK;
    if (!usedTitles.has(trimmed.toLowerCase())) {
        usedTitles.add(trimmed.toLowerCase());
        return trimmed;
    }

    const base = `${trimmed}${TODOIST_IMPORT_SUFFIX}`;
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

const buildPreview = (fileName: string, parsedProjects: ParsedTodoistProject[], warnings: string[]): TodoistImportPreview => {
    const projectPreviews = parsedProjects.map((project) => ({
        name: project.name,
        taskCount: project.tasks.length,
        checklistItemCount: project.checklistItemCount,
        sectionCount: project.sections.length,
        recurringCount: project.recurringCount,
    }));
    return {
        fileName,
        projectCount: projectPreviews.length,
        taskCount: projectPreviews.reduce((sum, project) => sum + project.taskCount, 0),
        checklistItemCount: projectPreviews.reduce((sum, project) => sum + project.checklistItemCount, 0),
        sectionCount: projectPreviews.reduce((sum, project) => sum + project.sectionCount, 0),
        recurringCount: projectPreviews.reduce((sum, project) => sum + project.recurringCount, 0),
        projects: projectPreviews,
        warnings,
    };
};

export const parseTodoistImportSource = (input: TodoistFileInput): TodoistImportParseResult => {
    const fileName = basename(input.fileName);
    const counters = createWarningCounters();
    const parsedProjects: ParsedTodoistProject[] = [];
    const errors: string[] = [];
    const archiveBudget = createImportArchiveBudget();

    const parseOneCsv = (csvText: string, sourceName: string): void => {
        const project = parseTodoistRows(csvText, sourceName, counters, archiveBudget);
        archiveBudget.consumeEntities(1 + project.sections.length + project.tasks.length);
        archiveBudget.consumeChecklistItems(project.checklistItemCount);
        if (project.tasks.length > 0) {
            parsedProjects.push(project);
        }
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
                    parseOneCsv(decodeTextBytes(entryBytes), entryName);
                } catch (error) {
                    if (error instanceof ImportSourceLimitError) throw error;
                    counters.invalidCsvFiles += 1;
                }
            });
        } else {
            parseOneCsv(source.text, fileName);
        }
    } catch (error) {
        return {
            valid: false,
            parsedProjects: [],
            preview: null,
            warnings: buildTodoistWarnings(counters),
            errors: [
                error instanceof Error && error.message
                    ? error.message
                    : 'Failed to parse the Todoist export.',
            ],
        };
    }

    if (parsedProjects.length === 0) {
        errors.push('No importable Todoist tasks were found in the selected file.');
    }

    const warnings = buildTodoistWarnings(counters);
    return {
        valid: errors.length === 0,
        parsedProjects,
        preview: errors.length === 0 ? buildPreview(fileName, parsedProjects, warnings) : null,
        warnings,
        errors,
    };
};

export const applyTodoistImport = (
    currentData: AppData,
    parsedProjects: ParsedTodoistProject[],
    options: { areaId?: string; now?: Date | string } = {}
): TodoistImportExecutionResult => {
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
        people: [...(currentData.people ?? [])],
        settings,
    };

    const usedProjectTitles = new Set(
        nextData.projects
            .filter((project) => !project.deletedAt)
            .map((project) => project.title.trim().toLowerCase())
    );
    const warnings: string[] = [];
    let importedProjectCount = 0;
    let importedSectionCount = 0;
    let importedTaskCount = 0;
    let importedChecklistItemCount = 0;
    const existingProjectIds = new Set(nextData.projects.map((project) => project.id));

    parsedProjects.forEach((parsedProject, projectIndex) => {
        const projectSourceKey = `${options.areaId ?? 'none'}:${projectIndex}:${parsedProject.name}`;
        const projectId = createTodoistImportId('project', projectSourceKey);
        if (existingProjectIds.has(projectId)) return;

        const projectTitle = resolveUniqueProjectTitle(parsedProject.name, usedProjectTitles);
        if (projectTitle !== parsedProject.name) {
            warnings.push(`Imported project "${parsedProject.name}" was renamed to "${projectTitle}" to avoid a title conflict.`);
        }

        const siblingMaxOrder = nextData.projects
            .filter((project) => !project.deletedAt && (project.areaId ?? undefined) === (options.areaId ?? undefined))
            .reduce((max, project) => Math.max(max, Number.isFinite(project.order) ? project.order : -1), -1);
        const project: Project = {
            id: projectId,
            title: projectTitle,
            color: DEFAULT_PROJECT_COLOR,
            order: siblingMaxOrder + 1,
            tagIds: [],
            status: 'active',
            createdAt: nowIso,
            updatedAt: nowIso,
            rev: 1,
            revBy: deviceState.deviceId,
            ...(options.areaId ? { areaId: options.areaId } : {}),
        };
        nextData.projects.push(project);
        existingProjectIds.add(project.id);
        importedProjectCount += 1;

        const sectionIdByName = new Map<string, string>();
        parsedProject.sections.forEach((sectionName, sectionIndex) => {
            const trimmed = sectionName.trim();
            if (!trimmed || sectionIdByName.has(trimmed.toLowerCase())) return;
            const section: Section = {
                id: createTodoistImportId('section', `${projectSourceKey}:${trimmed.toLowerCase()}`),
                projectId: project.id,
                title: trimmed,
                order: sectionIndex,
                createdAt: nowIso,
                updatedAt: nowIso,
                rev: 1,
                revBy: deviceState.deviceId,
            };
            nextData.sections.push(section);
            sectionIdByName.set(trimmed.toLowerCase(), section.id);
            importedSectionCount += 1;
        });

        parsedProject.tasks.forEach((parsedTask, taskIndex) => {
            const checklist = parsedTask.checklist.map((title) => ({
                id: uuidv4(),
                title,
                isCompleted: false,
            }));
            const sectionId = parsedTask.sectionName
                ? sectionIdByName.get(parsedTask.sectionName.trim().toLowerCase())
                : undefined;
            const task: Task = {
                id: createTodoistImportId('task', `${projectSourceKey}:${taskIndex}:${parsedTask.title}`),
                title: parsedTask.title,
                status: 'next',
                taskMode: checklist.length > 0 ? 'list' : 'task',
                tags: Array.from(new Set(parsedTask.tags)),
                contexts: [],
                pushCount: 0,
                projectId: project.id,
                sectionId,
                checklist: checklist.length > 0 ? checklist : undefined,
                description: parsedTask.description,
                priority: parsedTask.priority,
                dueDate: parsedTask.dueDate,
                createdAt: nowIso,
                updatedAt: nowIso,
                rev: 1,
                revBy: deviceState.deviceId,
                order: taskIndex,
                orderNum: taskIndex,
            };
            nextData.tasks.push(task);
            importedTaskCount += 1;
            importedChecklistItemCount += checklist.length;
        });
    });

    return {
        data: nextData,
        importedProjectCount,
        importedSectionCount,
        importedTaskCount,
        importedChecklistItemCount,
        warnings,
    };
};
