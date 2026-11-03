import { maskCalendarFeedUrl } from '@mindwtr/core';

const FILE_URL_PREFIX = 'file://';

function encodePathSegment(segment: string, index: number): string {
    if (index === 1 && /^[A-Za-z]:$/.test(segment)) {
        return segment;
    }
    return encodeURIComponent(segment);
}

export function isLocalCalendarFileUrl(value: string): boolean {
    return value.trim().toLowerCase().startsWith(FILE_URL_PREFIX);
}

export function isSupportedCalendarSourceUrl(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed) return false;
    const lower = trimmed.toLowerCase();
    if (lower.startsWith('https://') || lower.startsWith('http://') || lower.startsWith('webcal://')) {
        return true;
    }
    if (!isLocalCalendarFileUrl(trimmed)) return false;
    try {
        trimmed.slice(FILE_URL_PREFIX.length).split('/').forEach((segment) => decodeURIComponent(segment));
    } catch {
        return false;
    }
    const path = localCalendarFileUrlToPath(trimmed);
    return path.startsWith('/') && /\.ics$/i.test(path);
}

export function localPathToCalendarFileUrl(path: string): string {
    const trimmed = path.trim();
    if (isLocalCalendarFileUrl(trimmed)) return trimmed;
    const normalized = trimmed.replace(/\\/g, '/');
    const absolutePath = normalized.startsWith('/') ? normalized : `/${normalized}`;
    return `file://${absolutePath.split('/').map(encodePathSegment).join('/')}`;
}

export function localCalendarFileUrlToPath(value: string): string {
    const trimmed = value.trim();
    if (!isLocalCalendarFileUrl(trimmed)) return trimmed;
    const path = trimmed.slice(FILE_URL_PREFIX.length);
    try {
        return path.split('/').map((segment) => decodeURIComponent(segment)).join('/');
    } catch {
        return path;
    }
}

export function getCalendarSourceFileName(value: string): string {
    const source = isLocalCalendarFileUrl(value)
        ? localCalendarFileUrlToPath(value)
        : value;
    const segments = source.replace(/\\/g, '/').split('/').filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : '';
}


export function maskCalendarSourceUrl(url: string): string {
    const trimmed = url.trim();
    if (!trimmed) return '';
    if (isLocalCalendarFileUrl(trimmed)) {
        const path = localCalendarFileUrlToPath(trimmed);
        const filename = getCalendarSourceFileName(trimmed);
        return filename ? `Local file /.../${filename}` : `Local file ${path}`;
    }
    return maskCalendarFeedUrl(trimmed);
}
