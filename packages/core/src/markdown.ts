/**
 * Minimal, safe Markdown helpers.
 *
 * These are intentionally conservative and avoid HTML rendering.
 * Apps can use `stripMarkdown` for previews and notifications.
 */

import type { Project, Task } from './types';
import { isSafeMarkdownExternalHref } from './markdown-links';

const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`([^`]+)`/g;
const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;
const INLINE_TOKEN_RE = /(\*\*([^*]+)\*\*|__([^_]+)__|~~([^~\n]+)~~|\*([^*\n]+)\*|_([^_\n]+)_|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|((?:https?:\/\/|mailto:|tel:|mid:)[^\s<>\]]+|www\.[a-z0-9][^\s<>\]]*))/gi;
const INTERNAL_LINK_RE = /\[\[(task|project):([^\]|]+)\|([^\]]+)\]\]/g;
const INTERNAL_LINK_TOKEN_RE = /^\[\[(task|project):([^\]|]+)\|([^\]]+)\]\]$/;
const MARKDOWN_LIST_ITEM_RE = /^(\s*)(?:(?:[-+*])\s+(?:\[(?: |x|X)\]\s*)?|\d+[.)]\s+)(?:\S|$)/;
const MARKDOWN_PREVIEW_PREFIX_RE = /^\s{0,3}(?:(?:[-*+]\s+)?\[(?: |x|X)\]\s+|>\s?|#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/;
const MARKDOWN_PREVIEW_SKIP_LINE_RE = /^\s*(?:```.*|[-*_]{3,})\s*$/;

export type InlineToken =
    | { type: 'text'; text: string }
    | { type: 'bold'; text: string }
    | { type: 'italic'; text: string }
    | { type: 'strike'; text: string }
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

export type MarkdownReferenceSearchOptions = {
    excludeTaskIds?: string[];
    excludeProjectIds?: string[];
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
    | 'strikethrough'
    | 'quote'
    | 'horizontalRule'
    | 'bulletList'
    | 'orderedList'
    | 'taskList'
    | 'link'
    | 'code'
    | 'codeBlock';

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

export type MarkdownKeyboardShortcut = {
    key: string;
    altKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
};

export const MARKDOWN_TOOLBAR_ACTIONS: MarkdownToolbarAction[] = [
    { id: 'heading', shortLabel: 'H1', labelKey: 'markdown.toolbar.heading', fallbackLabel: 'Insert heading' },
    { id: 'bold', shortLabel: 'B', labelKey: 'markdown.toolbar.bold', fallbackLabel: 'Bold' },
    { id: 'italic', shortLabel: 'I', labelKey: 'markdown.toolbar.italic', fallbackLabel: 'Italic' },
    { id: 'strikethrough', shortLabel: 'S', labelKey: 'markdown.toolbar.strikethrough', fallbackLabel: 'Strikethrough' },
    { id: 'link', shortLabel: '[]', labelKey: 'markdown.toolbar.link', fallbackLabel: 'Insert link' },
    { id: 'code', shortLabel: '`', labelKey: 'markdown.toolbar.code', fallbackLabel: 'Inline code' },
    { id: 'codeBlock', shortLabel: '</>', labelKey: 'markdown.toolbar.codeBlock', fallbackLabel: 'Code block' },
    { id: 'quote', shortLabel: '>', labelKey: 'markdown.toolbar.quote', fallbackLabel: 'Quote' },
    { id: 'horizontalRule', shortLabel: '---', labelKey: 'markdown.toolbar.horizontalRule', fallbackLabel: 'Horizontal rule' },
    { id: 'bulletList', shortLabel: '-', labelKey: 'markdown.toolbar.bulletList', fallbackLabel: 'Bullet list' },
    { id: 'orderedList', shortLabel: '1.', labelKey: 'markdown.toolbar.orderedList', fallbackLabel: 'Numbered list' },
    { id: 'taskList', shortLabel: '[ ]', labelKey: 'markdown.toolbar.taskList', fallbackLabel: 'Task list' },
];

const clampIndex = (value: string, index: number) => Math.max(0, Math.min(index, value.length));
const RAW_LINK_TRAILING_PUNCTUATION_RE = /[),.;:!?]+$/;

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
        if (isSafeMarkdownExternalHref(trimmed) || ['mid:', 'mindwtr:'].includes(url.protocol)) {
            return trimmed;
        }
    } catch {
        return null;
    }
    return null;
};

const splitRawLinkToken = (rawHref: string): { href: string; trailing: string } => {
    const trailingMatch = RAW_LINK_TRAILING_PUNCTUATION_RE.exec(rawHref);
    if (!trailingMatch) return { href: rawHref, trailing: '' };
    const trailing = trailingMatch[0];
    const href = rawHref.slice(0, -trailing.length);
    return href ? { href, trailing } : { href: rawHref, trailing: '' };
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

// Typing helpers that fire automatically as the user edits (auto-pairing,
// url-to-link paste, list continuation, reference autocomplete). They are
// gated by a single setting so the description can act as a plain-text field
// with nothing injected (discussion #742). Explicit actions (toolbar buttons,
// keyboard shortcuts) are deliberate and stay enabled regardless.
export type MarkdownAssistOptions = {
    assist?: boolean;
};

// Single source of truth for the default-on semantics. Only an explicit
// `false` turns the helpers off; unset keeps them on (the maintainer's #742
// commitment that pairing stays on by default).
export function isMarkdownEditorAssistEnabled(
    settings?: { markdownEditorAssist?: boolean } | null,
): boolean {
    return settings?.markdownEditorAssist !== false;
}

export function getActiveMarkdownReferenceQuery(
    value: string,
    selection: MarkdownSelection,
    options?: MarkdownAssistOptions,
): ActiveMarkdownReferenceQuery | null {
    if (options?.assist === false) return null;
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
    options?: MarkdownReferenceSearchOptions,
): MarkdownReferenceSearchResult[] {
    const normalizedQuery = query.trim().toLowerCase();
    const excludedTaskIds = new Set(options?.excludeTaskIds ?? []);
    const excludedProjectIds = new Set(options?.excludeProjectIds ?? []);
    const taskCandidates: MarkdownReferenceSearchResult[] = tasks
        .filter((task) => !task.deletedAt && !excludedTaskIds.has(task.id) && Boolean(task.title?.trim()))
        .map((task) => ({
            entityType: 'task',
            id: task.id,
            title: task.title.trim(),
            status: task.status,
            updatedAt: task.updatedAt,
        }));
    const projectCandidates: MarkdownReferenceSearchResult[] = projects
        .filter((project) => !project.deletedAt && !excludedProjectIds.has(project.id) && Boolean(project.title?.trim()))
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
        const strike = match[4];
        const italicA = match[5];
        const italicB = match[6];
        const code = match[7];
        const linkText = match[8];
        const linkHref = match[9];
        const rawHref = match[10];

        if (code) {
            tokens.push({ type: 'code', text: code });
        } else if (boldA || boldB) {
            tokens.push({ type: 'bold', text: boldA || boldB });
        } else if (strike) {
            tokens.push({ type: 'strike', text: strike });
        } else if (italicA || italicB) {
            tokens.push({ type: 'italic', text: italicA || italicB });
        } else if (linkText && linkHref) {
            const safeHref = sanitizeLinkHref(linkHref);
            if (safeHref) {
                tokens.push({ type: 'link', text: linkText, href: safeHref });
            } else {
                tokens.push({ type: 'text', text: linkText });
            }
        } else if (rawHref) {
            const { href, trailing } = splitRawLinkToken(rawHref);
            // A bare www. address links as GFM does (as the opened description's renderer does),
            // only at the start of a word (#1425).
            const isBareWww = /^www\./i.test(href);
            const midWord = isBareWww && match.index > 0 && /[\w.\/@-]/.test(source[match.index - 1]);
            const safeHref = midWord ? null : sanitizeLinkHref(isBareWww ? `http://${href}` : href);
            if (safeHref) {
                tokens.push({ type: 'link', text: href, href: safeHref });
                if (trailing) tokens.push({ type: 'text', text: trailing });
            } else {
                tokens.push({ type: 'text', text: rawHref });
            }
        }

        lastIndex = INLINE_TOKEN_RE.lastIndex;
    }

    if (lastIndex < source.length) {
        tokens.push({ type: 'text', text: source.slice(lastIndex) });
    }

    return tokens;
}

export function getInlineMarkdownPreview(markdown: string): string {
    if (!markdown) return '';

    const lines = markdown.replace(/\r\n/g, '\n').split('\n');
    for (const line of lines) {
        if (!line.trim() || MARKDOWN_PREVIEW_SKIP_LINE_RE.test(line)) continue;
        const preview = line.replace(MARKDOWN_PREVIEW_PREFIX_RE, '').trim();
        if (preview) return preview;
    }

    return '';
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

const PASTED_CHECKLIST_LINE_RE = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?(?:\[( |x|X)\]\s*)?/;

/**
 * Split pasted multi-line plain text into checklist items. Bullet, numbered,
 * and checkbox markers are stripped; `[x]` marks an item completed. Empty and
 * marker-only lines are dropped.
 */
export function parsePastedChecklistItems(text: string): MarkdownChecklistItem[] {
    if (!text) return [];
    const items: MarkdownChecklistItem[] = [];
    for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
        const match = PASTED_CHECKLIST_LINE_RE.exec(line);
        const title = line.slice(match?.[0].length ?? 0).trim();
        if (!title) continue;
        items.push({ title, isCompleted: match?.[1]?.toLowerCase() === 'x' });
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

const getMarkdownContinuation = (line: string): { prefix: string; contentStart: number } | null => {
    const quoteMatch = line.match(/^(\s*(?:>\s?)+)(.*)$/);
    const quoteRawPrefix = quoteMatch ? quoteMatch[1] : '';
    const quotePrefix = quoteMatch ? quoteRawPrefix.replace(/\s*$/, ' ') : '';
    const innerLine = quoteMatch ? quoteMatch[2] : line;
    const innerOffset = quoteRawPrefix.length;

    const taskMatch = innerLine.match(/^(\s*)([-+*])\s+\[(?: |x|X)\]\s+(.*)$/);
    if (taskMatch && taskMatch[3].trim().length > 0) {
        return {
            prefix: `${quotePrefix}${taskMatch[1]}${taskMatch[2]} [ ] `,
            contentStart: innerOffset + innerLine.length - taskMatch[3].length,
        };
    }

    const orderedMatch = innerLine.match(/^(\s*)(\d+)([.)])\s+(.*)$/);
    if (orderedMatch && orderedMatch[4].trim().length > 0) {
        const nextNumber = Number.parseInt(orderedMatch[2], 10) + 1;
        return {
            prefix: `${quotePrefix}${orderedMatch[1]}${nextNumber}${orderedMatch[3]} `,
            contentStart: innerOffset + innerLine.length - orderedMatch[4].length,
        };
    }

    const bulletMatch = innerLine.match(/^(\s*)([-+*])\s+(.*)$/);
    if (bulletMatch && bulletMatch[3].trim().length > 0) {
        return {
            prefix: `${quotePrefix}${bulletMatch[1]}${bulletMatch[2]} `,
            contentStart: innerOffset + innerLine.length - bulletMatch[3].length,
        };
    }

    if (quotePrefix && innerLine.trim().length > 0) {
        return {
            prefix: quotePrefix,
            contentStart: quoteRawPrefix.length,
        };
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

const replaceSelection = (
    value: string,
    selection: MarkdownSelection,
    insertedText: string,
): MarkdownToolbarResult => {
    const { start, end } = normalizeSelection(value, selection);
    const nextValue = `${value.slice(0, start)}${insertedText}${value.slice(end)}`;
    const cursor = start + insertedText.length;
    return {
        value: nextValue,
        selection: { start: cursor, end: cursor },
    };
};

const insertHorizontalRule = (value: string, selection: MarkdownSelection): MarkdownToolbarResult => {
    const { start, end } = normalizeSelection(value, selection);
    const before = value.slice(0, start);
    const after = value.slice(end);
    const leadingBreak = before && !before.endsWith('\n') ? '\n' : '';
    const inserted = `${leadingBreak}---\n`;
    const nextValue = `${before}${inserted}${after}`;
    const cursor = before.length + leadingBreak.length + 4;
    return { value: nextValue, selection: { start: cursor, end: cursor } };
};

const indentSelection = (value: string, selection: MarkdownSelection): MarkdownToolbarResult => {
    const normalizedSelection = normalizeSelection(value, selection);
    if (normalizedSelection.start === normalizedSelection.end) {
        return indentListItemAtCursor(value, normalizedSelection) ?? replaceSelection(value, normalizedSelection, '  ');
    }

    return prefixLines(value, normalizedSelection, '  ');
};

const adjustSelectionForLinePrefix = (
    selection: MarkdownSelection,
    lineStart: number,
    delta: number,
): MarkdownSelection => {
    const adjust = (index: number) => (
        index <= lineStart
            ? index
            : Math.max(lineStart, index + delta)
    );
    return {
        start: adjust(selection.start),
        end: adjust(selection.end),
    };
};

const getListItemMatchAtCursor = (value: string, selection: MarkdownSelection) => {
    const lineStart = findLineStart(value, selection.start);
    const lineEnd = findLineEnd(value, selection.start);
    const line = value.slice(lineStart, lineEnd);
    const match = MARKDOWN_LIST_ITEM_RE.exec(line);
    if (!match) return null;
    return { lineStart, lineEnd, line, indent: match[1] ?? '' };
};

const indentListItemAtCursor = (
    value: string,
    selection: MarkdownSelection,
): MarkdownToolbarResult | null => {
    const match = getListItemMatchAtCursor(value, selection);
    if (!match) return null;
    const nextValue = `${value.slice(0, match.lineStart)}  ${match.line}${value.slice(match.lineEnd)}`;
    return {
        value: nextValue,
        selection: adjustSelectionForLinePrefix(selection, match.lineStart, 2),
    };
};

const outdentListItemAtCursor = (
    value: string,
    selection: MarkdownSelection,
): MarkdownToolbarResult | null => {
    const normalizedSelection = normalizeSelection(value, selection);
    if (normalizedSelection.start !== normalizedSelection.end) {
        return outdentSelectedListItems(value, normalizedSelection);
    }

    const match = getListItemMatchAtCursor(value, normalizedSelection);
    if (!match || match.indent.length === 0) return null;
    const removalLength = Math.min(match.indent.startsWith('\t') ? 1 : 2, match.indent.length);
    const nextLine = match.line.slice(removalLength);
    const nextValue = `${value.slice(0, match.lineStart)}${nextLine}${value.slice(match.lineEnd)}`;
    return {
        value: nextValue,
        selection: adjustSelectionForLinePrefix(normalizedSelection, match.lineStart, -removalLength),
    };
};

const outdentSelectedListItems = (
    value: string,
    selection: MarkdownSelection,
): MarkdownToolbarResult | null => {
    const blockStart = findLineStart(value, selection.start);
    const blockEnd = findLineEnd(value, selection.end > selection.start ? selection.end - 1 : selection.start);
    const block = value.slice(blockStart, blockEnd);
    let changed = false;
    const nextBlock = block
        .split('\n')
        .map((line) => {
            const match = MARKDOWN_LIST_ITEM_RE.exec(line);
            const indent = match?.[1] ?? '';
            if (!match || indent.length === 0) return line;
            changed = true;
            const removalLength = Math.min(indent.startsWith('\t') ? 1 : 2, indent.length);
            return line.slice(removalLength);
        })
        .join('\n');

    if (!changed) return null;
    const nextValue = `${value.slice(0, blockStart)}${nextBlock}${value.slice(blockEnd)}`;
    return {
        value: nextValue,
        selection: {
            start: blockStart,
            end: blockStart + nextBlock.length,
        },
    };
};

const detectSelectionReplacement = (
    previousValue: string,
    nextValue: string,
    selection: MarkdownSelection,
): { selection: MarkdownSelection; selectedText: string; insertedText: string } | null => {
    const normalizedSelection = normalizeSelection(previousValue, selection);
    if (normalizedSelection.start === normalizedSelection.end) return null;

    const before = previousValue.slice(0, normalizedSelection.start);
    const after = previousValue.slice(normalizedSelection.end);
    if (!nextValue.startsWith(before) || !nextValue.endsWith(after)) return null;

    const insertedEnd = nextValue.length - after.length;
    if (insertedEnd < before.length) return null;

    return {
        selection: normalizedSelection,
        selectedText: previousValue.slice(normalizedSelection.start, normalizedSelection.end),
        insertedText: nextValue.slice(before.length, insertedEnd),
    };
};

const escapeMarkdownLinkLabel = (label: string): string => label.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');

// Maps, not object literals: these are indexed by user-typed/pasted text, and a
// plain object would resolve a key like "constructor" or "toString" through
// Object.prototype instead of returning undefined, injecting native function
// source into the note (SEC-13).
const MARKDOWN_INSERTION_PAIRS: Map<string, string> = new Map([
    ['[', ']'],
    ['(', ')'],
    ['{', '}'],
    ['<', '>'],
    ['`', '`'],
    ["'", "'"],
    ['"', '"'],
    ['~', '~~'],
]);

// Auto-close only the characters that carry Markdown meaning (links and code).
// Quotes, angle brackets, and braces were removed: auto-closing them while typing
// fights normal prose and pasted URLs with no Markdown benefit (discussion #742).
// Selection wrapping (MARKDOWN_INSERTION_PAIRS) still supports the full set.
const MARKDOWN_AUTO_INSERTION_PAIRS: Map<string, string> = new Map([
    ['[', ']'],
    ['(', ')'],
    ['`', '`'],
]);

const MARKDOWN_CLOSING_INSERTIONS = new Set<string>([
    ']',
    ')',
    '}',
    '>',
    '`',
    "'",
    '"',
]);

const isAsciiAlphaNumeric = (value: string | undefined): boolean => (
    typeof value === 'string' && /^[A-Za-z0-9]$/.test(value)
);

const countBackticksBefore = (value: string, index: number): number => {
    let count = 0;
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === '`'; cursor -= 1) {
        count += 1;
    }
    return count;
};

const countBackticksAfter = (value: string, index: number): number => {
    let count = 0;
    for (let cursor = index; cursor < value.length && value[cursor] === '`'; cursor += 1) {
        count += 1;
    }
    return count;
};

const wrapSelectionInFencedCodeBlock = (
    value: string,
    selection: MarkdownSelection,
    selectedText: string,
    existingFenceTicks = 0,
): MarkdownToolbarResult => {
    const fenceStart = Math.max(0, selection.start - existingFenceTicks);
    const fenceEnd = Math.min(value.length, selection.end + existingFenceTicks);
    const before = value.slice(0, fenceStart);
    const after = value.slice(fenceEnd);
    const leadingBreak = before && !before.endsWith('\n') ? '\n' : '';
    const trailingBreak = after && !after.startsWith('\n') ? '\n' : '';
    const blockPrefix = `${leadingBreak}\`\`\`\n`;
    const blockSuffix = `\n\`\`\`${trailingBreak}`;
    const nextValue = `${before}${blockPrefix}${selectedText}${blockSuffix}${after}`;
    const nextStart = before.length + blockPrefix.length;

    return {
        value: nextValue,
        selection: {
            start: nextStart,
            end: nextStart + selectedText.length,
        },
    };
};

const insertCollapsedFencedCodeBlock = (
    value: string,
    cursor: number,
    existingOpeningTicks = 0,
): MarkdownToolbarResult => {
    const fenceStart = Math.max(0, cursor - existingOpeningTicks);
    const before = value.slice(0, fenceStart);
    const after = value.slice(cursor);
    const leadingBreak = before && !before.endsWith('\n') ? '\n' : '';
    const trailingBreak = after && !after.startsWith('\n') ? '\n' : '';
    const blockPrefix = `${leadingBreak}\`\`\`\n`;
    const blockSuffix = `\n\`\`\`${trailingBreak}`;
    const nextValue = `${before}${blockPrefix}${blockSuffix}${after}`;
    const nextCursor = before.length + blockPrefix.length;

    return {
        value: nextValue,
        selection: { start: nextCursor, end: nextCursor },
    };
};

const getCollapsedInsertionCandidates = (
    previousValue: string,
    nextValue: string,
    selection: MarkdownSelection,
): Array<{ cursor: number; insertedText: string }> => {
    const normalizedSelection = normalizeSelection(previousValue, selection);
    if (normalizedSelection.start !== normalizedSelection.end) return [];

    const cursorCandidates = [normalizedSelection.start];
    if (normalizedSelection.start > 0) {
        cursorCandidates.push(normalizedSelection.start - 1);
    }

    const candidates: Array<{ cursor: number; insertedText: string }> = [];
    for (const cursor of cursorCandidates) {
        const before = previousValue.slice(0, cursor);
        const after = previousValue.slice(cursor);
        if (!nextValue.startsWith(before) || !nextValue.endsWith(after)) continue;

        const insertedEnd = nextValue.length - after.length;
        if (insertedEnd <= before.length) continue;
        candidates.push({
            cursor,
            insertedText: nextValue.slice(before.length, insertedEnd),
        });
    }

    return candidates;
};

const shouldAutoPairInsertion = (
    previousValue: string,
    cursor: number,
    insertedText: string,
): boolean => {
    if (!MARKDOWN_AUTO_INSERTION_PAIRS.has(insertedText)) return false;
    if (insertedText !== "'") return true;

    return !isAsciiAlphaNumeric(previousValue[cursor - 1]) && !isAsciiAlphaNumeric(previousValue[cursor]);
};

const applyCollapsedPairInsertion = (
    previousValue: string,
    nextValue: string,
    selection: MarkdownSelection,
): MarkdownToolbarResult | null => {
    for (const { cursor, insertedText } of getCollapsedInsertionCandidates(previousValue, nextValue, selection)) {
        if (insertedText === '```') {
            return insertCollapsedFencedCodeBlock(previousValue, cursor);
        }
        if (
            insertedText === '`'
            && countBackticksBefore(previousValue, cursor) === 2
            && countBackticksAfter(previousValue, cursor) === 0
        ) {
            return insertCollapsedFencedCodeBlock(previousValue, cursor, 2);
        }

        if (
            insertedText.length === 1
            && MARKDOWN_CLOSING_INSERTIONS.has(insertedText)
            && previousValue[cursor] === insertedText
        ) {
            return {
                value: previousValue,
                selection: { start: cursor + 1, end: cursor + 1 },
            };
        }

        if (!shouldAutoPairInsertion(previousValue, cursor, insertedText)) continue;
        const suffix = MARKDOWN_AUTO_INSERTION_PAIRS.get(insertedText);
        const next = `${previousValue.slice(0, cursor)}${insertedText}${suffix}${previousValue.slice(cursor)}`;
        return {
            value: next,
            selection: { start: cursor + insertedText.length, end: cursor + insertedText.length },
        };
    }

    return null;
};

export function applyMarkdownPairInsertion(
    previousValue: string,
    nextValue: string,
    selection: MarkdownSelection,
    options?: MarkdownAssistOptions,
): MarkdownToolbarResult | null {
    if (options?.assist === false) return null;
    const replacement = detectSelectionReplacement(previousValue, nextValue, selection);
    if (!replacement) {
        return applyCollapsedPairInsertion(previousValue, nextValue, selection);
    }
    if (replacement.insertedText === '```') {
        return wrapSelectionInFencedCodeBlock(previousValue, replacement.selection, replacement.selectedText);
    }
    const suffix = MARKDOWN_INSERTION_PAIRS.get(replacement.insertedText);
    if (!suffix) return null;

    const prefix = replacement.insertedText === '~' ? '~~' : replacement.insertedText;
    const { start, end } = replacement.selection;
    if (
        replacement.insertedText === '`'
        && countBackticksBefore(previousValue, start) === 2
        && countBackticksAfter(previousValue, end) === 2
    ) {
        return wrapSelectionInFencedCodeBlock(previousValue, replacement.selection, replacement.selectedText, 2);
    }
    const next = `${previousValue.slice(0, start)}${prefix}${replacement.selectedText}${suffix}${previousValue.slice(end)}`;
    return {
        value: next,
        selection: {
            start: start + prefix.length,
            end: start + prefix.length + replacement.selectedText.length,
        },
    };
}

export function applyMarkdownUrlPaste(
    previousValue: string,
    nextValue: string,
    selection: MarkdownSelection,
    options?: MarkdownAssistOptions,
): MarkdownToolbarResult | null {
    if (options?.assist === false) return null;
    const replacement = detectSelectionReplacement(previousValue, nextValue, selection);
    if (!replacement) return null;
    const href = sanitizeLinkHref(replacement.insertedText);
    if (!href) return null;

    const token = `[${escapeMarkdownLinkLabel(replacement.selectedText)}](${href})`;
    const { start, end } = replacement.selection;
    const value = `${previousValue.slice(0, start)}${token}${previousValue.slice(end)}`;
    const cursor = start + token.length;
    return {
        value,
        selection: { start: cursor, end: cursor },
    };
}

export function applyMarkdownKeyboardShortcut(
    value: string,
    selection: MarkdownSelection,
    shortcut: MarkdownKeyboardShortcut,
): MarkdownToolbarResult | null {
    if (shortcut.key === 'Tab' && !shortcut.altKey && !shortcut.ctrlKey && !shortcut.metaKey) {
        if (shortcut.shiftKey) {
            return outdentListItemAtCursor(value, selection);
        }
        return indentSelection(value, selection);
    }

    if (shortcut.altKey || shortcut.shiftKey) return null;
    if (!shortcut.ctrlKey && !shortcut.metaKey) return null;

    const lowerKey = shortcut.key.toLowerCase();
    if (lowerKey === 'b') return applyMarkdownToolbarAction(value, selection, 'bold');
    if (lowerKey === 'i') return applyMarkdownToolbarAction(value, selection, 'italic');
    return null;
}

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
        case 'strikethrough':
            return wrapSelection(value, selection, '~~', '~~', 2);
        case 'quote':
            return prefixLines(value, selection, '> ');
        case 'horizontalRule':
            return insertHorizontalRule(value, selection);
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
        case 'codeBlock': {
            const normalizedSelection = normalizeSelection(value, selection);
            const selectedText = value.slice(normalizedSelection.start, normalizedSelection.end);
            if (selectedText) {
                return wrapSelectionInFencedCodeBlock(value, normalizedSelection, selectedText);
            }
            return insertCollapsedFencedCodeBlock(value, normalizedSelection.start);
        }
        default:
            return { value, selection: normalizeSelection(value, selection) };
    }
}

export function continueMarkdownOnEnter(
    value: string,
    selection: MarkdownSelection,
    options?: MarkdownAssistOptions,
): MarkdownToolbarResult | null {
    if (options?.assist === false) return null;
    const normalizedSelection = normalizeSelection(value, selection);
    if (normalizedSelection.start !== normalizedSelection.end) {
        return null;
    }

    const cursor = normalizedSelection.start;
    const lineStart = findLineStart(value, cursor);
    const lineEnd = findLineEnd(value, cursor);
    const line = value.slice(lineStart, lineEnd);
    const continuation = getMarkdownContinuation(line);
    if (!continuation || cursor - lineStart < continuation.contentStart) {
        return null;
    }

    const nextValue = `${value.slice(0, cursor)}\n${continuation.prefix}${value.slice(cursor)}`;
    const nextCursor = cursor + 1 + continuation.prefix.length;
    return {
        value: nextValue,
        selection: { start: nextCursor, end: nextCursor },
    };
}

export function continueMarkdownOnTextChange(
    previousValue: string,
    nextValue: string,
    selection: MarkdownSelection,
    options?: MarkdownAssistOptions,
): MarkdownToolbarResult | null {
    if (options?.assist === false) return null;
    const normalizedSelection = normalizeSelection(previousValue, selection);
    if (normalizedSelection.start !== normalizedSelection.end) {
        return null;
    }

    const expectedValue = `${previousValue.slice(0, normalizedSelection.start)}\n${previousValue.slice(normalizedSelection.end)}`;
    if (nextValue !== expectedValue) {
        return null;
    }

    return continueMarkdownOnEnter(previousValue, normalizedSelection, options);
}
