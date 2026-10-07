import type { TaskPriority, TaskStatus } from './types';
import {
    parseObsidianFrontmatterProperties,
    type ObsidianFrontmatterProperties,
    splitObsidianFrontmatter,
} from './obsidian-frontmatter';

export type ObsidianSourceRef = {
    vaultName: string;
    vaultPath: string;
    relativeFilePath: string;
    lineNumber: number;
    fileModifiedAt: string;
    noteTags: string[];
};

export type ObsidianTaskFormat = 'inline' | 'tasknotes';
export type ObsidianTaskNotesStatus = Extract<TaskStatus, 'inbox' | 'next' | 'waiting' | 'someday' | 'done' | 'archived'>;

export type ObsidianTaskNotesData = {
    rawStatus: string;
    mindwtrStatus: ObsidianTaskNotesStatus;
    priority: TaskPriority | null;
    dueDate: string | null;
    scheduledDate: string | null;
    contexts: string[];
    projects: string[];
    timeEstimateMinutes: number | null;
    recurrenceRule: string | null;
    completedDate: string | null;
    bodyPreview: string | null;
};

export type ObsidianDataviewData = {
    priority: TaskPriority | null;
    dueDate: string | null;
    scheduledDate: string | null;
    contexts: string[];
    projects: string[];
    tags: string[];
    timeEstimateMinutes: number | null;
};

export type ObsidianTask = {
    id: string;
    text: string;
    completed: boolean;
    tags: string[];
    wikiLinks: string[];
    nestingLevel: number;
    source: ObsidianSourceRef;
    format: ObsidianTaskFormat;
    taskNotesData?: ObsidianTaskNotesData;
    dataviewData?: ObsidianDataviewData;
};

export type ObsidianFrontmatter = {
    tags: string[];
    due?: string;
    properties: ObsidianFrontmatterProperties;
};

export type ParseObsidianTasksOptions = {
    vaultName: string;
    vaultPath: string;
    relativeFilePath: string;
    fileModifiedAt: string;
    dataviewMetadataEnabled?: boolean;
    requiredInlineTag?: string;
};

export type ParseObsidianTasksResult = {
    tasks: ObsidianTask[];
    frontmatter: ObsidianFrontmatter;
};

const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const TASK_RE = /^([ \t]*)(?:[-*+])\s+\[( |x|X)\]\s+(.+)$/;
const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const TAG_RE = /(^|\s)#([\p{L}\p{N}_/.:-]+)/gu;
const DATAVIEW_FIELD_RE = /(^|[\s([])(project|projects|context|contexts|tag|tags|due|deadline|scheduled|start|startdate|priority|estimate|timeestimate|time-estimate)\s*::/gi;

export const normalizeObsidianTagValue = (value: string): string => {
    const trimmed = value.trim();
    if (!trimmed) return '';
    return trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
};

export const uniqueObsidianStrings = (items: string[]): string[] => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of items) {
        const trimmed = item.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        result.push(trimmed);
    }
    return result;
};

export const normalizeObsidianRelativePath = (value: string): string => {
    const normalized = String(value || '').trim().replace(/\\/g, '/').replace(/\/+/g, '/');
    if (!normalized) return '';
    if (normalized.startsWith('/')) {
        throw new Error('Obsidian relative paths cannot be absolute.');
    }
    if (/^[A-Za-z]:/.test(normalized)) {
        throw new Error('Obsidian relative paths cannot include drive prefixes.');
    }

    const segments = normalized
        .split('/')
        .map((segment) => segment.trim())
        .filter(Boolean);

    if (segments.some((segment) => segment === '..')) {
        throw new Error('Obsidian relative paths cannot contain parent traversal.');
    }

    return segments.filter((segment) => segment !== '.').join('/');
};

const hashObsidianSource = (source: string): string => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < source.length; index += 1) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
};

export const buildObsidianTaskId = (relativeFilePath: string, lineNumber: number): string => {
    const normalizedLineNumber = Number.isFinite(lineNumber) ? Math.max(0, Math.floor(lineNumber)) : 0;
    const source = `${normalizeObsidianRelativePath(relativeFilePath)}:${normalizedLineNumber}`;
    return `obsidian-${normalizedLineNumber}-${hashObsidianSource(source)}`;
};

export const buildObsidianFileTaskId = (relativeFilePath: string, format: ObsidianTaskFormat = 'tasknotes'): string => {
    const source = `${format}:${normalizeObsidianRelativePath(relativeFilePath)}`;
    return `obsidian-file-${hashObsidianSource(source)}`;
};

export const extractObsidianTags = (text: string): string[] => {
    const tags: string[] = [];
    let match: RegExpExecArray | null;
    TAG_RE.lastIndex = 0;
    while ((match = TAG_RE.exec(text)) !== null) {
        const value = normalizeObsidianTagValue(match[2] || '');
        if (value) tags.push(value);
    }
    return uniqueObsidianStrings(tags);
};

/** One inline tag, with the same character set as the existing tag extractor. */
export const normalizeObsidianRequiredInlineTag = (value: string | null | undefined): string => {
    const tag = normalizeObsidianTagValue(value ?? '');
    if (!tag && !(value ?? '').trim()) return '';
    if (!/^[\p{L}\p{N}_/.:-]+$/u.test(tag) || tag.startsWith('/') || tag.endsWith('/') || tag.includes('//')) {
        throw new Error('Enter one inline tag, such as #task.');
    }
    return `#${tag}`;
};

export const matchesObsidianRequiredInlineTag = (text: string, requiredInlineTag: string): boolean => {
    const required = normalizeObsidianRequiredInlineTag(requiredInlineTag).slice(1);
    return !required || extractObsidianTags(text).some((tag) => tag === required || tag.startsWith(`${required}/`));
};

export const appendObsidianRequiredInlineTag = (text: string, requiredInlineTag: string): string => {
    const tag = normalizeObsidianRequiredInlineTag(requiredInlineTag);
    return matchesObsidianRequiredInlineTag(text, tag) ? text : `${text.trimEnd()} ${tag}`;
};

export const extractObsidianWikiLinks = (text: string): string[] => {
    const links: string[] = [];
    let match: RegExpExecArray | null;
    WIKI_LINK_RE.lastIndex = 0;
    while ((match = WIKI_LINK_RE.exec(text)) !== null) {
        const value = (match[1] || '').trim();
        if (value) links.push(value);
    }
    return uniqueObsidianStrings(links);
};

const normalizeDataviewKey = (key: string): string => key.trim().replace(/[-_\s]/g, '').toLowerCase();

const stripDataviewValueWrapper = (value: string): string => {
    let trimmed = value.trim();
    while (trimmed.startsWith('[') && trimmed.endsWith(']') && !trimmed.startsWith('[[')) {
        trimmed = trimmed.slice(1, -1).trim();
    }
    const wikiLinkMatch = trimmed.match(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/);
    if (wikiLinkMatch) {
        return (wikiLinkMatch[2] || wikiLinkMatch[1] || '').trim();
    }
    return trimmed;
};

const splitDataviewListValue = (value: string): string[] => {
    const normalized = stripDataviewValueWrapper(value);
    if (!normalized) return [];
    return normalized
        .split(/[,;|]/)
        .map(stripDataviewValueWrapper)
        .map((item) => item.trim())
        .filter(Boolean);
};

const normalizeDataviewToken = (value: string, prefix: '@' | '#' | null): string => {
    const trimmed = stripDataviewValueWrapper(value).trim();
    if (!trimmed) return '';
    return prefix && trimmed.startsWith(prefix) ? trimmed.slice(1).trim() : trimmed;
};

const parseDataviewDate = (value: string): string | null => {
    const normalized = stripDataviewValueWrapper(value).replace(/^date\((.+)\)$/i, '$1').trim();
    const match = normalized.match(/\d{4}-\d{2}-\d{2}(?:[T ][^\s,\];)]+)?/);
    return match?.[0] ?? null;
};

const normalizeDataviewPriority = (value: string): TaskPriority | null => {
    const normalized = stripDataviewValueWrapper(value).trim().toLowerCase();
    switch (normalized) {
        case 'urgent':
        case 'highest':
        case 'p0':
            return 'urgent';
        case 'high':
        case 'p1':
            return 'high';
        case 'medium':
        case 'normal':
        case 'p2':
            return 'medium';
        case 'low':
        case 'lowest':
        case 'p3':
        case 'p4':
            return 'low';
        default:
            return null;
    }
};

const parseDataviewEstimateMinutes = (value: string): number | null => {
    const normalized = stripDataviewValueWrapper(value).trim().toLowerCase();
    const hoursMatch = normalized.match(/^(\d+(?:\.\d+)?)\s*h(?:ours?)?$/);
    if (hoursMatch) {
        const hours = Number(hoursMatch[1]);
        return Number.isFinite(hours) && hours > 0 ? Math.round(hours * 60) : null;
    }
    const minutesMatch = normalized.match(/^(\d+)\s*m(?:in(?:ute)?s?)?$/);
    if (minutesMatch) {
        const minutes = Number(minutesMatch[1]);
        return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
    }
    const plainMinutes = Number(normalized);
    return Number.isFinite(plainMinutes) && plainMinutes > 0 ? Math.round(plainMinutes) : null;
};

const findDataviewBracketEnd = (text: string, startIndex: number): number => {
    for (let index = startIndex + 1; index < text.length; index += 1) {
        if (text[index] === '[' && text[index + 1] === '[') {
            const wikiEnd = text.indexOf(']]', index + 2);
            if (wikiEnd === -1) return -1;
            index = wikiEnd + 1;
            continue;
        }
        if (text[index] === ']') return index;
    }
    return -1;
};

const collectBracketedDataviewFields = (text: string): Array<{ key: string; value: string; start: number; end: number }> => {
    const fields: Array<{ key: string; value: string; start: number; end: number }> = [];
    for (let index = 0; index < text.length; index += 1) {
        if (text[index] !== '[' || text[index + 1] === '[') continue;
        const end = findDataviewBracketEnd(text, index);
        if (end === -1) break;
        const content = text.slice(index + 1, end).trim();
        const match = content.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*::\s*(.+)$/s);
        if (match) {
            fields.push({
                key: match[1] || '',
                value: match[2] || '',
                start: index,
                end: end + 1,
            });
        }
        index = end;
    }
    return fields;
};

const collectBareDataviewFields = (text: string): Array<{ key: string; value: string }> => {
    const matches: Array<{ key: string; valueStart: number; fieldStart: number }> = [];
    let match: RegExpExecArray | null;
    DATAVIEW_FIELD_RE.lastIndex = 0;
    while ((match = DATAVIEW_FIELD_RE.exec(text)) !== null) {
        matches.push({
            key: match[2] || '',
            valueStart: DATAVIEW_FIELD_RE.lastIndex,
            fieldStart: match.index + (match[1] || '').length,
        });
    }

    return matches
        .map((current, index) => {
            const next = matches[index + 1];
            const rawValue = text.slice(current.valueStart, next?.fieldStart ?? text.length);
            const value = rawValue.replace(/[\s,;()[\]]+$/g, '').trim();
            return { key: current.key, value };
        })
        .filter((field) => field.value.length > 0);
};

export const parseObsidianDataviewData = (text: string): ObsidianDataviewData | null => {
    const bracketedFields = collectBracketedDataviewFields(text);
    const bareSource = bracketedFields.reduce(
        (current, field) => `${current.slice(0, field.start)}${' '.repeat(field.end - field.start)}${current.slice(field.end)}`,
        text
    );
    const fields = [
        ...bracketedFields.map(({ key, value }) => ({ key, value })),
        ...collectBareDataviewFields(bareSource),
    ];

    const contexts: string[] = [];
    const projects: string[] = [];
    const tags: string[] = [];
    let dueDate: string | null = null;
    let scheduledDate: string | null = null;
    let priority: TaskPriority | null = null;
    let timeEstimateMinutes: number | null = null;

    for (const field of fields) {
        const key = normalizeDataviewKey(field.key);
        if (!key) continue;
        if (key === 'project' || key === 'projects') {
            projects.push(...splitDataviewListValue(field.value));
            continue;
        }
        if (key === 'context' || key === 'contexts') {
            contexts.push(...splitDataviewListValue(field.value).map((item) => normalizeDataviewToken(item, '@')));
            continue;
        }
        if (key === 'tag' || key === 'tags') {
            tags.push(...splitDataviewListValue(field.value).map((item) => normalizeDataviewToken(item, '#')));
            continue;
        }
        if ((key === 'due' || key === 'deadline') && !dueDate) {
            dueDate = parseDataviewDate(field.value);
            continue;
        }
        if ((key === 'scheduled' || key === 'start' || key === 'startdate') && !scheduledDate) {
            scheduledDate = parseDataviewDate(field.value);
            continue;
        }
        if (key === 'priority' && !priority) {
            priority = normalizeDataviewPriority(field.value);
            continue;
        }
        if ((key === 'estimate' || key === 'timeestimate') && !timeEstimateMinutes) {
            timeEstimateMinutes = parseDataviewEstimateMinutes(field.value);
        }
    }

    const normalizedContexts = uniqueObsidianStrings(contexts.filter(Boolean));
    const normalizedProjects = uniqueObsidianStrings(projects.filter(Boolean));
    const normalizedTags = uniqueObsidianStrings(tags.map(normalizeObsidianTagValue).filter(Boolean));
    if (!dueDate && !scheduledDate && !priority && !timeEstimateMinutes && normalizedContexts.length === 0 && normalizedProjects.length === 0 && normalizedTags.length === 0) {
        return null;
    }

    return {
        priority,
        dueDate,
        scheduledDate,
        contexts: normalizedContexts,
        projects: normalizedProjects,
        tags: normalizedTags,
        timeEstimateMinutes,
    };
};

export const parseObsidianNoteFrontmatter = (input: string): ObsidianFrontmatter => {
    const properties = parseObsidianFrontmatterProperties(input);

    const noteTags = uniqueObsidianStrings([
        ...((Array.isArray(properties.tags) ? properties.tags : typeof properties.tags === 'string' ? [properties.tags] : [])
            .filter((value): value is string => typeof value === 'string')
            .map(normalizeObsidianTagValue)
            .filter(Boolean)),
        ...((Array.isArray(properties.tag) ? properties.tag : typeof properties.tag === 'string' ? [properties.tag] : [])
            .filter((value): value is string => typeof value === 'string')
            .map(normalizeObsidianTagValue)
            .filter(Boolean)),
    ]);

    const dueValue = properties.due;
    const due = typeof dueValue === 'string' && dueValue.trim() ? dueValue.trim() : undefined;

    return {
        tags: noteTags,
        ...(due ? { due } : {}),
        properties,
    };
};

const computeIndentLevel = (rawIndent: string): number => {
    let tabs = 0;
    let spaces = 0;
    for (const char of rawIndent) {
        if (char === '\t') {
            tabs += 1;
            continue;
        }
        if (char === ' ') {
            spaces += 1;
        }
    }
    return tabs + Math.floor(spaces / 2);
};

export const parseObsidianTasksFromMarkdown = (
    markdown: string,
    options: ParseObsidianTasksOptions
): ParseObsidianTasksResult => {
    const normalizedRelativePath = normalizeObsidianRelativePath(options.relativeFilePath);
    const split = splitObsidianFrontmatter(markdown);
    const frontmatter: ObsidianFrontmatter = {
        tags: uniqueObsidianStrings([
            ...((Array.isArray(split.properties.tags) ? split.properties.tags : typeof split.properties.tags === 'string' ? [split.properties.tags] : [])
                .filter((value): value is string => typeof value === 'string')
                .map(normalizeObsidianTagValue)
                .filter(Boolean)),
            ...((Array.isArray(split.properties.tag) ? split.properties.tag : typeof split.properties.tag === 'string' ? [split.properties.tag] : [])
                .filter((value): value is string => typeof value === 'string')
                .map(normalizeObsidianTagValue)
                .filter(Boolean)),
        ]),
        ...(typeof split.properties.due === 'string' && split.properties.due.trim() ? { due: split.properties.due.trim() } : {}),
        properties: split.properties,
    };
    const tasks: ObsidianTask[] = [];
    let inFence = false;

    for (let index = 0; index < split.bodyLines.length; index += 1) {
        const line = split.bodyLines[index] ?? '';
        if (FENCE_RE.test(line)) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;

        const match = TASK_RE.exec(line);
        if (!match) continue;
        const text = (match[3] || '').trim();
        if (!text) continue;
        if (!matchesObsidianRequiredInlineTag(text, options.requiredInlineTag ?? '')) continue;

        const lineNumber = split.bodyStartLineNumber + index;
        const dataviewData = options.dataviewMetadataEnabled
            ? parseObsidianDataviewData(text)
            : null;
        const taskTags = uniqueObsidianStrings([...extractObsidianTags(text), ...frontmatter.tags, ...(dataviewData?.tags ?? [])]);
        tasks.push({
            id: buildObsidianTaskId(normalizedRelativePath, lineNumber),
            text,
            completed: (match[2] || '').toLowerCase() === 'x',
            tags: taskTags,
            wikiLinks: extractObsidianWikiLinks(text),
            nestingLevel: computeIndentLevel(match[1] || ''),
            source: {
                vaultName: options.vaultName,
                vaultPath: options.vaultPath,
                relativeFilePath: normalizedRelativePath,
                lineNumber,
                fileModifiedAt: options.fileModifiedAt,
                noteTags: frontmatter.tags,
            },
            format: 'inline',
            ...(dataviewData ? { dataviewData } : {}),
        });
    }

    return { tasks, frontmatter };
};
