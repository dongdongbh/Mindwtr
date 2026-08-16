import type { Attachment, AttachmentKind } from './types';

const FILE_URI_PREFIX = /^file:\/\//i;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const UNC_PATH = /^\\\\/;
const MARKDOWN_LINK_RE = /^\[([^\]]+)\]\(([^)]+)\)$/;
const MAX_COMPACT_LABEL = 72;

export type NormalizedAttachmentInput = {
    kind: AttachmentKind;
    title: string;
    uri: string;
};

function isLikelyFilePath(value: string): boolean {
    if (FILE_URI_PREFIX.test(value)) return true;
    if (value.startsWith('~/')) return true;
    if (value.startsWith('/')) return true;
    if (WINDOWS_DRIVE.test(value)) return true;
    if (UNC_PATH.test(value)) return true;
    return false;
}

function getFileTitle(value: string): string {
    const raw = value.replace(FILE_URI_PREFIX, '');
    const parts = raw.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? value;
}

function collapseWhitespace(value: string): string {
    return value.trim().replace(/\s+/g, ' ');
}

function truncateMiddle(value: string, maxLength = MAX_COMPACT_LABEL): string {
    if (value.length <= maxLength) return value;
    const separator = '...';
    if (maxLength <= separator.length) return value.slice(0, maxLength);
    const front = Math.max(16, Math.floor((maxLength - separator.length) * 0.7));
    const back = Math.max(8, maxLength - front - separator.length);
    if (front + back + separator.length > maxLength) {
        return value.slice(0, maxLength);
    }
    return `${value.slice(0, front)}${separator}${value.slice(-back)}`;
}

function decodePathSegment(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

function normalizeUrlCandidate(value: string): string {
    const trimmed = value.trim();
    if (/^www\./i.test(trimmed)) return `https://${trimmed}`;
    return trimmed;
}

function isLikelyLinkUri(value: string): boolean {
    const candidate = normalizeUrlCandidate(value);
    if (!candidate) return false;
    try {
        const url = new URL(candidate);
        return url.protocol.length > 0;
    } catch {
        return false;
    }
}

function parseLabeledLinkInput(input: string): { title: string; uri: string } | null {
    const markdownMatch = MARKDOWN_LINK_RE.exec(input);
    if (markdownMatch) {
        const title = collapseWhitespace(markdownMatch[1] || '');
        const uri = collapseWhitespace(markdownMatch[2] || '');
        if (title && uri && isLikelyLinkUri(uri)) return { title, uri: normalizeUrlCandidate(uri) };
    }

    const separatorIndex = input.lastIndexOf('|');
    if (separatorIndex <= 0) return null;

    const title = collapseWhitespace(input.slice(0, separatorIndex));
    const uri = collapseWhitespace(input.slice(separatorIndex + 1));
    if (!title || !uri || !isLikelyLinkUri(uri)) return null;
    return { title, uri: normalizeUrlCandidate(uri) };
}

export function createCompactLinkTitle(uri: string): string {
    const candidate = normalizeUrlCandidate(uri);
    try {
        const url = new URL(candidate);
        if (url.protocol === 'mailto:') {
            return truncateMiddle(url.pathname || candidate);
        }

        const host = url.hostname.replace(/^www\./i, '');
        const segments = url.pathname
            .split('/')
            .filter(Boolean)
            .map((segment) => decodePathSegment(segment));

        let compact = host;
        if (segments.length === 1) {
            compact = `${host}/${segments[0]}`;
        } else if (segments.length === 2) {
            compact = `${host}/${segments[0]}/${segments[1]}`;
        } else if (segments.length > 2) {
            compact = `${host}/${segments[0]}/.../${segments[segments.length - 1]}`;
        }

        return truncateMiddle(compact);
    } catch {
        return truncateMiddle(candidate);
    }
}

export function normalizeLinkAttachmentInput(input: string): NormalizedAttachmentInput {
    const trimmed = collapseWhitespace(input);
    if (!trimmed) {
        return { kind: 'link', title: '', uri: '' };
    }

    const labeled = parseLabeledLinkInput(trimmed);
    if (labeled) {
        return {
            kind: 'link',
            title: labeled.title,
            uri: labeled.uri,
        };
    }

    const uri = normalizeUrlCandidate(trimmed);
    return {
        kind: 'link',
        title: createCompactLinkTitle(uri),
        uri,
    };
}

export function normalizeAttachmentInput(input: string): NormalizedAttachmentInput {
    const trimmed = input.trim();
    if (!trimmed) {
        return { kind: 'link', title: '', uri: '' };
    }

    if (isLikelyFilePath(trimmed)) {
        // A pointer, not a copy: "Add link" (and "Link to file…") promise the
        // original file is only referenced. `kind: 'file'` would hand the path
        // to attachment sync, which uploads the bytes and later re-homes the
        // attachment onto its own copy (#1001).
        return {
            kind: 'link',
            title: getFileTitle(trimmed),
            uri: trimmed,
        };
    }

    return normalizeLinkAttachmentInput(trimmed);
}

export function getAttachmentDisplayTitle(attachment: Pick<Attachment, 'kind' | 'title' | 'uri'>): string {
    const rawTitle = collapseWhitespace(attachment.title || '');
    const rawUri = collapseWhitespace(attachment.uri || '');

    if (attachment.kind !== 'link') return rawTitle || rawUri;
    if (!rawTitle && !rawUri) return '';

    if (rawTitle && rawTitle !== rawUri && !isLikelyLinkUri(rawTitle)) return rawTitle;
    return createCompactLinkTitle(rawUri || rawTitle);
}
