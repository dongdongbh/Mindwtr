import { safeParseDate } from '@mindwtr/core';

export function resolveAttachmentValidationMessage(
    error: string | undefined,
    t: (key: string) => string,
) {
    if (error === 'file_too_large') return t('attachments.fileTooLarge');
    if (error === 'mime_type_blocked' || error === 'mime_type_not_allowed') {
        return t('attachments.invalidFileType');
    }
    return t('attachments.fileNotSupported');
}

export function formatProjectDate(dateStr: string | undefined, notSetLabel: string) {
    if (!dateStr) return notSetLabel;
    try {
        const parsed = safeParseDate(dateStr);
        return parsed ? parsed.toLocaleDateString() : dateStr;
    } catch {
        return dateStr;
    }
}

export function normalizeProjectTag(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return '';
    return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
}
