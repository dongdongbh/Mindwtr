import { safeParseDate } from './date';
import { applyImport, type ImportParseResult, type ImportSource } from './import-apply';
import {
    appendWarning,
    buildHeaderIndex,
    decodeTextBytes,
    dedupeStrings,
    detectDelimiter,
    isZipBytes,
    pad,
    parseCsvRows,
    readImportSource,
    sanitizeCsvText,
    toImportBytes,
    type ImportSourceInput,
} from './import-source-reader';
import type { MindwtrCsvImportPreview } from './mindwtr-csv-import';
import { normalizeTagId } from './store-helpers';
import type { AppData, TaskPriority, TaskStatus } from './types';
import { deterministicHash128Hex, generateDeterministicUUID } from './uuid';

const TASK_COLUMNS = {
    subject: ['SUBJECT', '主题'],
    notes: ['NOTES', '备注', '注释'],
    categories: ['CATEGORIES', '类别', '分类'],
    priority: ['PRIORITY', 'IMPORTANCE', '优先级', '重要性'],
    status: ['STATUS', '状态', '任务状态'],
    start: ['START DATE', '开始日期'],
    due: ['DUE DATE', '截止日期', '到期日期'],
    completedAt: ['DATE COMPLETED', 'COMPLETION DATE', '完成日期', '完成时间'],
    complete: ['COMPLETE', 'COMPLETED', '完成', '已完成'],
    percentComplete: ['% COMPLETE', 'PERCENT COMPLETE', '完成百分比', '完成率', '% 完成'],
};

const NON_TASK_HEADERS = [
    'END DATE', 'ALL DAY EVENT', 'MEETING ORGANIZER', '结束日期', '全天事件', '会议组织者',
    'FIRST NAME', 'LAST NAME', '名', '姓', 'FROM', '发件人',
];

const TASK_STATUSES = new Map<string, TaskStatus>([
    ['0', 'inbox'], ['not started', 'inbox'], ['未开始', 'inbox'], ['未启动', 'inbox'],
    ['1', 'next'], ['in progress', 'next'], ['进行中', 'next'], ['正在进行', 'next'],
    ['2', 'done'], ['complete', 'done'], ['completed', 'done'], ['完成', 'done'], ['已完成', 'done'],
    ['3', 'waiting'], ['waiting on someone else', 'waiting'], ['waiting on others', 'waiting'],
    ['等待其他人', 'waiting'], ['等待他人', 'waiting'], ['正在等待其他人', 'waiting'],
    ['4', 'someday'], ['deferred', 'someday'], ['推迟', 'someday'], ['已推迟', 'someday'], ['延迟', 'someday'],
]);

const TASK_PRIORITIES = new Map<string, TaskPriority>([
    ['0', 'low'], ['low', 'low'], ['低', 'low'], ['低优先级', 'low'], ['低重要性', 'low'],
    ['1', 'medium'], ['normal', 'medium'], ['普通', 'medium'], ['正常', 'medium'], ['中', 'medium'], ['正常优先级', 'medium'], ['正常重要性', 'medium'],
    ['2', 'high'], ['high', 'high'], ['高', 'high'], ['高优先级', 'high'], ['高重要性', 'high'],
]);

const INVALID_TASK_EXPORT = 'Choose a CSV exported from the Tasks folder in classic Outlook for Windows.';
const INVALID_ENCODING = 'The CSV text encoding could not be read. Re-save the Outlook export as UTF-8 CSV.';
const IMPORT_LABEL = 'Microsoft To Do';

const decodeOutlookCsv = (bytes: Uint8Array): string => {
    const isLittleEndian = bytes[0] === 0xff && bytes[1] === 0xfe;
    const isBigEndian = bytes[0] === 0xfe && bytes[1] === 0xff;
    if (isLittleEndian || isBigEndian) {
        if (bytes.length % 2 !== 0) throw new Error(INVALID_ENCODING);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const parts: string[] = [];
        for (let offset = 2; offset < bytes.length;) {
            const units = [];
            const end = Math.min(offset + 16_384, bytes.length);
            for (; offset < end; offset += 2) units.push(view.getUint16(offset, isLittleEndian));
            parts.push(String.fromCharCode(...units));
        }
        const text = parts.join('');
        if (/[\uD800-\uDFFF]/u.test(text)) throw new Error(INVALID_ENCODING);
        return text;
    }

    const isUtf8Bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const payload = isUtf8Bom ? bytes.subarray(3) : bytes;
    const text = decodeTextBytes(payload);
    const encoded = new TextEncoder().encode(text);
    if (encoded.length !== payload.length || !encoded.every((byte, index) => byte === payload[index])) {
        throw new Error(INVALID_ENCODING);
    }
    return text;
};

const parseOutlookDate = (value: string): string | null | undefined => {
    if (!value || /^(?:none|null|n\/a|无|无日期)$/iu.test(value)) return undefined;

    const yearFirst = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(.*)$/u.exec(value);
    const chinese = /^(\d{4})年(\d{1,2})月(\d{1,2})日(.*)$/u.exec(value);
    const yearLast = /^(\d{1,2})([-/.])(\d{1,2})\2(\d{4})(.*)$/u.exec(value);

    let date: string;
    let time: string;
    if (yearFirst) {
        date = `${yearFirst[1]}-${pad(Number(yearFirst[3]))}-${pad(Number(yearFirst[4]))}`;
        time = yearFirst[5];
    } else if (chinese) {
        date = `${chinese[1]}-${pad(Number(chinese[2]))}-${pad(Number(chinese[3]))}`;
        time = chinese[4];
    } else if (yearLast) {
        const first = Number(yearLast[1]);
        const second = Number(yearLast[3]);
        if (first !== second && first <= 12 && second <= 12) return null;
        const [month, day] = first > 12 ? [second, first] : [first, second];
        date = `${yearLast[4]}-${pad(month)}-${pad(day)}`;
        time = yearLast[5];
    } else {
        return null;
    }

    if (date === '4501-01-01') return undefined;
    if (!safeParseDate(date)) return null;
    if (!time) return date;

    const clock = /^[T ]((?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?)(Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?$/iu.exec(time);
    if (!clock) return null;
    const dateTime = `${date}T${clock[1]}`;
    return clock[2] ? safeParseDate(`${dateTime}${clock[2]}`)?.toISOString() ?? null : dateTime;
};

export const parseMicrosoftTodoImportSource = (
    input: ImportSourceInput,
): ImportParseResult<ImportSource, MindwtrCsvImportPreview> => {
    const invalid = (error: string, warnings: string[] = []) => ({
        errors: [error], parsedData: null, preview: null, valid: false, warnings,
    });
    try {
        const bytes = toImportBytes(input.bytes);
        if (bytes && isZipBytes(bytes)) return invalid(INVALID_TASK_EXPORT);
        const source = readImportSource(input, decodeOutlookCsv);
        if (source.kind !== 'text') return invalid(INVALID_TASK_EXPORT);
        if (source.text.includes('\0')) return invalid(INVALID_ENCODING);

        const text = sanitizeCsvText(source.text);
        const recordNumbers: number[] = [];
        const { rows } = parseCsvRows(text, detectDelimiter(text), undefined, undefined, recordNumbers, { strict: true });
        if (rows.length === 0) return invalid(INVALID_TASK_EXPORT);
        const headers = buildHeaderIndex(rows[0]);
        const column = (key: keyof typeof TASK_COLUMNS): number | undefined => {
            for (const alias of TASK_COLUMNS[key]) {
                const index = headers.get(alias);
                if (index !== undefined) return index;
            }
            return undefined;
        };
        const subjectColumn = column('subject');
        if (subjectColumn === undefined) return invalid('The Outlook CSV is missing the required column: Subject.');
        const statusColumn = column('status');
        const dueColumn = column('due');
        const completedAtColumn = column('completedAt');
        const completeColumn = column('complete');
        const percentColumn = column('percentComplete');
        if (NON_TASK_HEADERS.some((header) => headers.has(header))
            || [statusColumn, dueColumn, completedAtColumn, completeColumn, percentColumn].every((index) => index === undefined)) {
            return invalid(INVALID_TASK_EXPORT);
        }
        const startColumn = column('start');
        const notesColumn = column('notes');
        const categoriesColumn = column('categories');
        const priorityColumn = column('priority');
        const fileName = source.fileName;
        const projectName = fileName.replace(/\.csv$/iu, '').trim() || IMPORT_LABEL;
        const projectSourceKey = projectName.toLowerCase();
        const tasks: ImportSource['tasks'] = [];
        const occurrences = new Map<string, number>();
        const dateLocations: string[] = [];
        let unparsedDates = 0;
        let unmappedStatuses = 0;
        let emptyTitles = 0;

        for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
            const row = rows[rowIndex];
            const cell = (index: number | undefined): string => index === undefined ? '' : (row[index] ?? '').trim();
            const date = (index: number | undefined): string | undefined => {
                if (index === undefined) return undefined;
                const parsed = parseOutlookDate(cell(index));
                if (parsed !== null) return parsed;
                unparsedDates += 1;
                if (dateLocations.length < 5) dateLocations.push(`0:${recordNumbers[rowIndex]}:${index + 1}`);
                return undefined;
            };
            const title = cell(subjectColumn);
            if (!title) {
                emptyTitles += 1;
                continue;
            }
            const startTime = date(startColumn);
            const dueDate = date(dueColumn);
            const completionDate = date(completedAtColumn);
            const completedAt = safeParseDate(completionDate)?.toISOString();
            const statusText = cell(statusColumn).toLowerCase();
            const mappedStatus = TASK_STATUSES.get(statusText);
            const isComplete = Boolean(completedAt)
                || /^(?:true|yes|1|是)$/iu.test(cell(completeColumn))
                || (!mappedStatus && /^100(?:[.,]0+)?%?$/u.test(cell(percentColumn)));
            if (!isComplete && statusText && !mappedStatus) unmappedStatuses += 1;
            const status = isComplete ? 'done' : mappedStatus ?? 'inbox';
            const description = cell(notesColumn).replace(/\r\n?/gu, '\n') || undefined;
            const tags = dedupeStrings(cell(categoriesColumn).split(/[,;，；]/u).map(normalizeTagId));
            const priority = TASK_PRIORITIES.get(cell(priorityColumn).toLowerCase());
            const fingerprint = deterministicHash128Hex(JSON.stringify([
                title, description, [...tags].sort(), priority, status, startTime, dueDate, completionDate,
            ]));
            const occurrence = (occurrences.get(fingerprint) ?? 0) + 1;
            occurrences.set(fingerprint, occurrence);
            tasks.push({
                title, description, tags, priority, status, startTime, dueDate, completedAt,
                projectSourceKey,
                order: rowIndex,
                sourceKey: JSON.stringify([projectSourceKey, fingerprint, occurrence]),
            });
        }

        const warnings: string[] = [];
        appendWarning(warnings, unparsedDates, '1 date value could not be parsed and was skipped.', '{count} date values could not be parsed and were skipped.');
        if (dateLocations.length > 0) {
            warnings[0] += ` [csv-locations=${dateLocations.join(',')}; omitted=${unparsedDates - dateLocations.length}]`;
        }
        appendWarning(warnings, unmappedStatuses, '1 status could not be mapped.', '{count} statuses could not be mapped.');
        appendWarning(warnings, emptyTitles, '1 row with an empty title was skipped.', '{count} rows with empty titles were skipped.');
        if (tasks.length === 0) return invalid('No importable tasks were found in the selected file.', warnings);

        return {
            errors: [],
            parsedData: { areas: [], projects: [{ name: projectName, order: 0, sourceKey: projectSourceKey }], sections: [], tasks, warnings },
            preview: {
                fileName, areaCount: 0, projectCount: 1, sectionCount: 0, checklistItemCount: 0, standaloneTaskCount: 0,
                taskCount: tasks.length, projects: [{ name: projectName, taskCount: tasks.length }], warnings,
            },
            valid: true,
            warnings,
        };
    } catch (error) {
        return invalid(error instanceof Error ? error.message : INVALID_TASK_EXPORT);
    }
};

export const applyMicrosoftTodoImport = (data: AppData, parsed: ImportSource) => applyImport(data, parsed, {
    fallbacks: { area: IMPORT_LABEL, project: IMPORT_LABEL },
    idFor: (kind, sourceKey) => generateDeterministicUUID(`mindwtr:microsoft-todo:v1:${kind}:${sourceKey}`),
    resolveTaskStatus: (status, projectId) => status === 'inbox' && projectId ? 'next' : status,
    suffix: ` (${IMPORT_LABEL})`,
});
