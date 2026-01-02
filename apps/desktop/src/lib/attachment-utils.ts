import type { AttachmentKind } from '@mindwtr/core';

const FILE_URI_PREFIX = /^file:\/\//i;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const UNC_PATH = /^\\\\/;

type NormalizedAttachmentInput = {
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

export function normalizeAttachmentInput(input: string): NormalizedAttachmentInput {
    const trimmed = input.trim();
    if (!trimmed) {
        return { kind: 'link', title: '', uri: '' };
    }

    if (isLikelyFilePath(trimmed)) {
        return {
            kind: 'file',
            title: getFileTitle(trimmed),
            uri: trimmed,
        };
    }

    return {
        kind: 'link',
        title: trimmed,
        uri: trimmed,
    };
}
