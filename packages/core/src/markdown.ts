/**
 * Minimal, safe Markdown helpers.
 *
 * These are intentionally conservative and avoid HTML rendering.
 * Apps can use `stripMarkdown` for previews and notifications.
 */

const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`([^`]+)`/g;
const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;

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

