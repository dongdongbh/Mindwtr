import { normalizeCloudUrl } from './sync-helpers';
import { isSha256Hex } from './attachment-hash';
import type { Attachment } from './types';


export const ATTACHMENTS_DIR_NAME = 'attachments';


export const extractExtension = (value?: string): string => {
    if (!value) return '';
    const stripped = value.split('?')[0].split('#')[0];
    const leaf = stripped.split(/[\\/]/).pop() || '';
    const match = leaf.match(/\.[A-Za-z0-9]{1,8}$/);
    return match ? match[0].toLowerCase() : '';
};


export const buildCloudKey = (attachment: Attachment): string => {
    const ext = extractExtension(attachment.title) || extractExtension(attachment.uri);
    return `${ATTACHMENTS_DIR_NAME}/${attachment.id}${ext}`;
};


export const buildFileSyncGenerationCloudKey = (
    attachment: Attachment,
    fileHash: string,
): string => {
    const normalizedHash = fileHash.trim().toLowerCase();
    if (!isSha256Hex(normalizedHash)) {
        throw new Error('File Sync attachment generation requires a SHA-256 digest');
    }
    const ext = extractExtension(attachment.title) || extractExtension(attachment.uri);
    return `${ATTACHMENTS_DIR_NAME}/${attachment.id}.${normalizedHash}${ext}`;
};

const FILE_SYNC_GENERATION_CLOUD_KEY_PATTERN = /^attachments\/[^/]+\.[a-f0-9]{64}(?:\.[a-z0-9]{1,8})?$/;


export const isFileSyncGenerationCloudKey = (value: unknown): value is string =>
    typeof value === 'string' && FILE_SYNC_GENERATION_CLOUD_KEY_PATTERN.test(value);


export const getBaseSyncUrl = (fullUrl: string): string => {
    const trimmed = fullUrl.replace(/\/+$/, '');
    if (trimmed.toLowerCase().endsWith('.json')) {
        const lastSlash = trimmed.lastIndexOf('/');
        return lastSlash >= 0 ? trimmed.slice(0, lastSlash) : trimmed;
    }
    return trimmed;
};


export const getCloudBaseUrl = (fullUrl: string): string =>
    normalizeCloudUrl(fullUrl).slice(0, -'/data'.length);
