/**
 * Minimal, safe Markdown helpers.
 *
 * These are intentionally conservative and avoid HTML rendering.
 * Apps can use `stripMarkdown` for previews and notifications.
 */

const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`([^`]+)`/g;
const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;
const INLINE_TOKEN_RE = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
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
        if (['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) {
            return trimmed;
        }
    } catch {
        return null;
    }
    return null;
};

export function parseInlineMarkdown(text: string): InlineToken[] {
    const tokens: InlineToken[] = [];
    if (!text) return tokens;

    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = INLINE_TOKEN_RE.exec(text)) !== null) {
        if (match.index > lastIndex) {
            tokens.push({ type: 'text', text: text.slice(lastIndex, match.index) });
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

    if (lastIndex < text.length) {
        tokens.push({ type: 'text', text: text.slice(lastIndex) });
    }

    return tokens;
}

export function stripMarkdown(markdown: string): string {
    if (!markdown) return '';

    let text = markdown;

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
