/**
 * Minimal, safe Markdown helpers.
 *
 * These are intentionally conservative and avoid HTML rendering.
 * Apps can use `stripMarkdown` for previews and notifications.
 */

import type { Project, Task } from './types';

const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`([^`]+)`/g;
const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;
const INLINE_TOKEN_RE = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
const INTERNAL_LINK_RE = /\[\[(task|project):([^\]|]+)\|([^\]]+)\]\]/g;
const INTERNAL_LINK_TOKEN_RE = /^\[\[(task|project):([^\]|]+)\|([^\]]+)\]\]$/;
const TASK_LIST_RE = /^\s{0,3}(?:[-*+]\s+)?\[( |x|X)\]\s+(.+)$/;

export type InlineToken =
    | { type: 'text'; text: string }
    | { type: 'bold'; text: string }
    | { type: 'italic'; text: string }
    | { type: 'code'; text: string }
    | { type: 'link'; text: string; href: string };

export type MarkdownChecklistItem = {
    title: string;
    isCompleted: boolean;
};

export type MarkdownReferenceEntityType = 'task' | 'project';

export type MarkdownReferenceTarget = {
    entityType: MarkdownReferenceEntityType;
    id: string;
};

export type MarkdownReference = MarkdownReferenceTarget & {
    label: string;
};

export type MarkdownReferenceSearchResult = MarkdownReferenceTarget & {
    title: string;
    status: string;
    updatedAt: string;
};

export type ActiveMarkdownReferenceQuery = {
    start: number;
    end: number;
    query: string;
};

export type MarkdownToolbarActionId =
    | 'heading'
    | 'bold'
    | 'italic'
    | 'quote'
    | 'bulletList'
    | 'orderedList'
    | 'taskList'
    | 'link'
    | 'code';

export type MarkdownSelection = {
    start: number;
    end: number;
};

export type MarkdownToolbarAction = {
    id: MarkdownToolbarActionId;
    shortLabel: string;
    labelKey: string;
    fallbackLabel: string;
};

export type MarkdownToolbarResult = {
    value: string;
    selection: MarkdownSelection;
};

export const MARKDOWN_TOOLBAR_ACTIONS: MarkdownToolbarAction[] = [
    { id: 'heading', shortLabel: 'H1', labelKey: 'markdown.toolbar.heading', fallbackLabel: 'Insert heading' },
    { id: 'bold', shortLabel: 'B', labelKey: 'markdown.toolbar.bold', fallbackLabel: 'Bold' },
    { id: 'italic', shortLabel: 'I', labelKey: 'markdown.toolbar.italic', fallbackLabel: 'Italic' },
    { id: 'quote', shortLabel: '>', labelKey: 'markdown.toolbar.quote', fallbackLabel: 'Quote' },
    { id: 'bulletList', shortLabel: '-', labelKey: 'markdown.toolbar.bulletList', fallbackLabel: 'Bullet list' },
    { id: 'orderedList', shortLabel: '1.', labelKey: 'markdown.toolbar.orderedList', fallbackLabel: 'Numbered list' },
    { id: 'taskList', shortLabel: '[ ]', labelKey: 'markdown.toolbar.taskList', fallbackLabel: 'Task list' },
];

const clampIndex = (value: string, index: number) => Math.max(0, Math.min(index, value.length));

const sanitizeLinkHref = (href: string): string | null => {
    const trimmed = href.trim();
    if (!trimmed) return null;
    const lower = trimmed.toLowerCase();
    if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:')) {
        return null;
    }
    if (trimmed.startsWith('#')) {
        return trimmed;
    }
    try {
        const url = new URL(trimmed);
        if (['http:', 'https:', 'mailto:', 'tel:', 'mindwtr:'].includes(url.protocol)) {
            return trimmed;
        }
    } catch {
        return null;
    }
    return null;
};

const replaceOutsideInlineCode = (
    text: string,
    replacer: (plainText: string) => string,
): string => {
    const inlineCodeRegex = /`[^`]+`/g;
    let result = '';
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = inlineCodeRegex.exec(text)) !== null) {
        result += replacer(text.slice(lastIndex, match.index));
        result += match[0];
        lastIndex = match.index + match[0].length;
    }

    result += replacer(text.slice(lastIndex));
    return result;
};

const replaceOutsideCode = (
    markdown: string,
    replacer: (plainText: string) => string,
): string => {
    const codeBlockRegex = /```[\s\S]*?```/g;
    let result = '';
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = codeBlockRegex.exec(markdown)) !== null) {
        result += replaceOutsideInlineCode(markdown.slice(lastIndex, match.index), replacer);
        result += match[0];
        lastIndex = match.index + match[0].length;
    }

    result += replaceOutsideInlineCode(markdown.slice(lastIndex), replacer);
    return result;
};

export function sanitizeMarkdownReferenceLabel(label: string): string {
    const sanitized = label.replace(/[|\]]/g, ' ').replace(/\s+/g, ' ').trim();
    return sanitized || 'Untitled';
}

export function serializeMarkdownReferenceHref(reference: MarkdownReferenceTarget): string {
    return `mindwtr://${reference.entityType}/${encodeURIComponent(reference.id)}`;
}

export function serializeMarkdownReference(reference: MarkdownReference): string {
    return `[[${reference.entityType}:${reference.id}|${sanitizeMarkdownReferenceLabel(reference.label)}]]`;
}

export function parseMarkdownReferenceToken(token: string): MarkdownReference | null {
    const match = INTERNAL_LINK_TOKEN_RE.exec(token.trim());
    if (!match) return null;
    const entityType = match[1] as MarkdownReferenceEntityType;
    const id = match[2]?.trim();
    const label = match[3]?.trim();
    if (!id || !label) return null;
    return { entityType, id, label };
}

export function parseMarkdownReferenceHref(href: string): MarkdownReferenceTarget | null {
    try {
        const url = new URL(href);
        if (url.protocol !== 'mindwtr:') return null;
        const entityType = url.hostname;
        if (entityType !== 'task' && entityType !== 'project') return null;
        const id = decodeURIComponent(url.pathname.replace(/^\/+/, '').trim());
        if (!id) return null;
        return {
            entityType,
            id,
        };
    } catch {
        return null;
    }
}

export function normalizeMarkdownInternalLinks(markdown: string): string {
    if (!markdown) return '';
    return replaceOutsideCode(markdown, (plainText) => (
        plainText.replace(INTERNAL_LINK_RE, (_match, entityType, id, label) => (
            `[${sanitizeMarkdownReferenceLabel(String(label))}](${serializeMarkdownReferenceHref({
                entityType: entityType as MarkdownReferenceEntityType,
                id: String(id),
            })})`
        ))
    ));
}

export function getActiveMarkdownReferenceQuery(
    value: string,
    selection: MarkdownSelection,
): ActiveMarkdownReferenceQuery | null {
    const normalizedSelection = normalizeSelection(value, selection);
    if (normalizedSelection.start !== normalizedSelection.end) return null;

    const cursor = normalizedSelection.end;
    const beforeCursor = value.slice(0, cursor);
    const openIndex = beforeCursor.lastIndexOf('[[');
    if (openIndex === -1) return null;

    const closeIndex = beforeCursor.lastIndexOf(']]');
    if (closeIndex > openIndex) return null;

    const query = value.slice(openIndex + 2, cursor);
    if (!query && cursor < value.length && value.slice(cursor, cursor + 2) === ']]') {
        return null;
    }
    if (query.includes('\n') || query.includes('\r') || query.includes(']') || query.includes('|')) {
        return null;
    }
    if (/^\s*(task|project):/i.test(query)) {
        return null;
    }

    return {
        start: openIndex,
        end: cursor,
        query,
    };
}

export function insertMarkdownReferenceAtQuery(
    value: string,
    activeQuery: ActiveMarkdownReferenceQuery,
    reference: MarkdownReference,
): MarkdownToolbarResult {
    const before = value.slice(0, activeQuery.start);
    const after = value.slice(activeQuery.end);
    const token = serializeMarkdownReference(reference);
    const nextValue = `${before}${token}${after}`;
    const cursor = before.length + token.length;
    return {
        value: nextValue,
        selection: {
            start: cursor,
            end: cursor,
        },
    };
}

const scoreMarkdownReferenceTitle = (title: string, query: string): number => {
    if (!query) return 0;
    const normalizedTitle = title.trim().toLowerCase();
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedTitle || !normalizedQuery) return 0;
    if (normalizedTitle === normalizedQuery) return 400;
    if (normalizedTitle.startsWith(normalizedQuery)) return 300;
    const wordIndex = normalizedTitle.indexOf(` ${normalizedQuery}`);
    if (wordIndex !== -1) return 200 - Math.min(wordIndex, 50);
    const containsIndex = normalizedTitle.indexOf(normalizedQuery);
    if (containsIndex !== -1) return 100 - Math.min(containsIndex, 50);
    return -1;
};

export function searchMarkdownReferences(
    tasks: Task[],
    projects: Project[],
    query: string,
    limit = 8,
): MarkdownReferenceSearchResult[] {
    const normalizedQuery = query.trim().toLowerCase();
    const taskCandidates: MarkdownReferenceSearchResult[] = tasks
        .filter((task) => !task.deletedAt && Boolean(task.title?.trim()))
        .map((task) => ({
            entityType: 'task',
            id: task.id,
            title: task.title.trim(),
            status: task.status,
            updatedAt: task.updatedAt,
        }));
    const projectCandidates: MarkdownReferenceSearchResult[] = projects
        .filter((project) => !project.deletedAt && Boolean(project.title?.trim()))
        .map((project) => ({
            entityType: 'project',
            id: project.id,
            title: project.title.trim(),
            status: project.status,
            updatedAt: project.updatedAt,
        }));

    return [...taskCandidates, ...projectCandidates]
        .map((candidate) => ({
            candidate,
            score: scoreMarkdownReferenceTitle(candidate.title, normalizedQuery),
        }))
        .filter(({ score }) => normalizedQuery ? score >= 0 : true)
        .sort((left, right) => {
            if (left.score !== right.score) return right.score - left.score;
            const updatedAtDelta = right.candidate.updatedAt.localeCompare(left.candidate.updatedAt);
            if (updatedAtDelta !== 0) return updatedAtDelta;
            if (left.candidate.entityType !== right.candidate.entityType) {
                return left.candidate.entityType === 'project' ? -1 : 1;
            }
            return left.candidate.title.localeCompare(right.candidate.title);
        })
        .slice(0, limit)
        .map(({ candidate }) => candidate);
}

export function parseInlineMarkdown(text: string): InlineToken[] {
    const tokens: InlineToken[] = [];
    if (!text) return tokens;

    const source = normalizeMarkdownInternalLinks(text);

    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = INLINE_TOKEN_RE.exec(source)) !== null) {
        if (match.index > lastIndex) {
            tokens.push({ type: 'text', text: source.slice(lastIndex, match.index) });
        }

        const boldA = match[2];
        const boldB = match[3];
        const italicA = match[4];
        const italicB = match[5];
        const code = match[6];
        const linkText = match[7];
        const linkHref = match[8];

        if (code) {
            tokens.push({ type: 'code', text: code });
        } else if (boldA || boldB) {
            tokens.push({ type: 'bold', text: boldA || boldB });
        } else if (italicA || italicB) {
            tokens.push({ type: 'italic', text: italicA || italicB });
        } else if (linkText && linkHref) {
            const safeHref = sanitizeLinkHref(linkHref);
            if (safeHref) {
                tokens.push({ type: 'link', text: linkText, href: safeHref });
            } else {
                tokens.push({ type: 'text', text: linkText });
            }
        }

        lastIndex = INLINE_TOKEN_RE.lastIndex;
    }

    if (lastIndex < source.length) {
        tokens.push({ type: 'text', text: source.slice(lastIndex) });
    }

    return tokens;
}

export function stripMarkdown(markdown: string): string {
    if (!markdown) return '';

    let text = normalizeMarkdownInternalLinks(markdown);

    // Remove fenced code blocks but keep their contents.
    text = text.replace(CODE_BLOCK_RE, (block) => block.replace(/```/g, ''));

    // Inline code.
    text = text.replace(INLINE_CODE_RE, '$1');

    // Links: keep label.
    text = text.replace(LINK_RE, '$1');

    // Remove block-level markers.
    text = text.replace(/^\s{0,3}(?:[-*+]\s+)?\[(?: |x|X)\]\s+/gm, '');
    text = text.replace(/^\s{0,3}>\s?/gm, '');
    text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
    text = text.replace(/^\s{0,3}[-*+]\s+/gm, '');
    text = text.replace(/^\s{0,3}\d+\.\s+/gm, '');

    // Remove emphasis markers.
    text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
    text = text.replace(/(\*|_)(.*?)\1/g, '$2');
    text = text.replace(/~~(.*?)~~/g, '$1');

    // Normalize whitespace.
    text = text.replace(/\r\n/g, '\n');
    text = text.replace(/\n{3,}/g, '\n\n');
    text = text.replace(/[ \t]{2,}/g, ' ');

    return text.trim();
}

export function extractChecklistFromMarkdown(markdown: string): MarkdownChecklistItem[] {
    if (!markdown) return [];
    const lines = markdown.replace(/\r\n/g, '\n').split('\n');
    const items: MarkdownChecklistItem[] = [];
    for (const line of lines) {
        const match = TASK_LIST_RE.exec(line);
        if (!match) continue;
        const title = match[2]?.trim();
        if (!title) continue;
        items.push({
            title,
            isCompleted: match[1].toLowerCase() === 'x',
        });
    }
    return items;
}

const normalizeSelection = (value: string, selection: MarkdownSelection): MarkdownSelection => {
    const start = clampIndex(value, selection.start);
    const end = clampIndex(value, selection.end);
    if (start <= end) return { start, end };
    return { start: end, end: start };
};

const wrapSelection = (
    value: string,
    selection: MarkdownSelection,
    prefix: string,
    suffix: string,
    emptySelectionOffset: number,
    selectionMode: 'wrapped' | 'inside-suffix' = 'wrapped',
): MarkdownToolbarResult => {
    const { start, end } = normalizeSelection(value, selection);
    const before = value.slice(0, start);
    const selected = value.slice(start, end);
    const after = value.slice(end);
    const nextValue = `${before}${prefix}${selected}${suffix}${after}`;

    if (start === end) {
        const cursor = start + emptySelectionOffset;
        return {
            value: nextValue,
            selection: { start: cursor, end: cursor },
        };
    }

    if (selectionMode === 'inside-suffix') {
        const cursor = start + prefix.length + selected.length + suffix.length - 1;
        return {
            value: nextValue,
            selection: { start: cursor, end: cursor },
        };
    }

    return {
        value: nextValue,
        selection: {
            start: start + prefix.length,
            end: start + prefix.length + selected.length,
        },
    };
};

const findLineStart = (value: string, index: number) => {
    const normalized = clampIndex(value, index);
    const previousNewline = value.lastIndexOf('\n', Math.max(0, normalized - 1));
    return previousNewline === -1 ? 0 : previousNewline + 1;
};

const findLineEnd = (value: string, index: number) => {
    const normalized = clampIndex(value, index);
    const nextNewline = value.indexOf('\n', normalized);
    return nextNewline === -1 ? value.length : nextNewline;
};

const getMarkdownContinuationPrefix = (line: string): string | null => {
    const quoteMatch = line.match(/^(\s*(?:>\s?)+)(.*)$/);
    const quotePrefix = quoteMatch ? quoteMatch[1].replace(/\s*$/, ' ') : '';
    const innerLine = quoteMatch ? quoteMatch[2] : line;

    const taskMatch = innerLine.match(/^(\s*)([-+*])\s+\[(?: |x|X)\]\s+(.*)$/);
    if (taskMatch && taskMatch[3].trim().length > 0) {
        return `${quotePrefix}${taskMatch[1]}${taskMatch[2]} [ ] `;
    }

    const orderedMatch = innerLine.match(/^(\s*)(\d+)([.)])\s+(.*)$/);
    if (orderedMatch && orderedMatch[4].trim().length > 0) {
        const nextNumber = Number.parseInt(orderedMatch[2], 10) + 1;
        return `${quotePrefix}${orderedMatch[1]}${nextNumber}${orderedMatch[3]} `;
    }

    const bulletMatch = innerLine.match(/^(\s*)([-+*])\s+(.*)$/);
    if (bulletMatch && bulletMatch[3].trim().length > 0) {
        return `${quotePrefix}${bulletMatch[1]}${bulletMatch[2]} `;
    }

    if (quotePrefix && innerLine.trim().length > 0) {
        return quotePrefix;
    }

    return null;
};

const prefixLines = (value: string, selection: MarkdownSelection, prefix: string): MarkdownToolbarResult => {
    const { start, end } = normalizeSelection(value, selection);
    const blockStart = findLineStart(value, start);
    const blockEnd = findLineEnd(value, end > start ? end - 1 : start);
    const block = value.slice(blockStart, blockEnd);

    if (start === end && block.length === 0) {
        const nextValue = `${value.slice(0, blockStart)}${prefix}${value.slice(blockEnd)}`;
        const cursor = blockStart + prefix.length;
        return {
            value: nextValue,
            selection: { start: cursor, end: cursor },
        };
    }

    const prefixedBlock = block
        .split('\n')
        .map((line) => (line.length > 0 ? `${prefix}${line}` : line))
        .join('\n');

    const nextValue = `${value.slice(0, blockStart)}${prefixedBlock}${value.slice(blockEnd)}`;

    if (start === end) {
        const lineText = value.slice(findLineStart(value, start), findLineEnd(value, start));
        const cursor = lineText.length > 0 ? start + prefix.length : start;
        return {
            value: nextValue,
            selection: { start: cursor, end: cursor },
        };
    }

    return {
        value: nextValue,
        selection: {
            start: blockStart,
            end: blockStart + prefixedBlock.length,
        },
    };
};

export function applyMarkdownToolbarAction(
    value: string,
    selection: MarkdownSelection,
    actionId: MarkdownToolbarActionId,
): MarkdownToolbarResult {
    switch (actionId) {
        case 'heading':
            return prefixLines(value, selection, '# ');
        case 'bold':
            return wrapSelection(value, selection, '**', '**', 2);
        case 'italic':
            return wrapSelection(value, selection, '*', '*', 1);
        case 'quote':
            return prefixLines(value, selection, '> ');
        case 'bulletList':
            return prefixLines(value, selection, '- ');
        case 'orderedList':
            return prefixLines(value, selection, '1. ');
        case 'taskList':
            return prefixLines(value, selection, '- [ ] ');
        case 'link':
            return wrapSelection(value, selection, '[', ']()', 1, 'inside-suffix');
        case 'code':
            return wrapSelection(value, selection, '`', '`', 1);
        default:
            return { value, selection: normalizeSelection(value, selection) };
    }
}

export function continueMarkdownOnEnter(
    value: string,
    selection: MarkdownSelection,
): MarkdownToolbarResult | null {
    const normalizedSelection = normalizeSelection(value, selection);
    if (normalizedSelection.start !== normalizedSelection.end) {
        return null;
    }

    const cursor = normalizedSelection.start;
    const lineEnd = findLineEnd(value, cursor);
    if (cursor !== lineEnd) {
        return null;
    }

    const lineStart = findLineStart(value, cursor);
    const line = value.slice(lineStart, lineEnd);
    const continuationPrefix = getMarkdownContinuationPrefix(line);
    if (!continuationPrefix) {
        return null;
    }

    const nextValue = `${value.slice(0, cursor)}\n${continuationPrefix}${value.slice(cursor)}`;
    const nextCursor = cursor + 1 + continuationPrefix.length;
    return {
        value: nextValue,
        selection: { start: nextCursor, end: nextCursor },
    };
}

export function continueMarkdownOnTextChange(
    previousValue: string,
    nextValue: string,
    selection: MarkdownSelection,
): MarkdownToolbarResult | null {
    const normalizedSelection = normalizeSelection(previousValue, selection);
    if (normalizedSelection.start !== normalizedSelection.end) {
        return null;
    }

    const expectedValue = `${previousValue.slice(0, normalizedSelection.start)}\n${previousValue.slice(normalizedSelection.end)}`;
    if (nextValue !== expectedValue) {
        return null;
    }

    return continueMarkdownOnEnter(previousValue, normalizedSelection);
}
