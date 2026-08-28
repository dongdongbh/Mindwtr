import { normalizeCloudUrl } from './sync-helpers';
import { isSha256Hex } from './attachment-hash';
import type { Attachment } from './types';

/** Remote folder name for synced attachment bytes, under every backend. */
export const ATTACHMENTS_DIR_NAME = 'attachments';

/** Extension (with leading dot, lowercased) from a title or URI, ignoring any
 *  query string or fragment. Empty string when none is found. */
export const extractExtension = (value?: string): string => {
    if (!value) return '';
    const stripped = value.split('?')[0].split('#')[0];
    const leaf = stripped.split(/[\\/]/).pop() || '';
    const match = leaf.match(/\.[A-Za-z0-9]{1,8}$/);
    return match ? match[0].toLowerCase() : '';
};

/** Wire-format remote key for an attachment's bytes. Desktop and mobile must
 *  derive this identically, or each stops finding the other's uploads. */
export const buildCloudKey = (attachment: Attachment): string => {
    const ext = extractExtension(attachment.title) || extractExtension(attachment.uri);
    return `${ATTACHMENTS_DIR_NAME}/${attachment.id}${ext}`;
};

/** Immutable File Sync key for one plaintext content generation. File Sync
 * publishes attachment bytes before the data-document CAS, so overwriting the
 * legacy identity-only key could corrupt the winning document when two devices
 * race on a provider whose lock is advisory. A digest-qualified key makes a
 * losing upload an unreferenced object instead of a destructive replacement. */
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

/** Whether a sanitized attachment key names one immutable File Sync content
 * generation. Legacy identity-only keys and other providers' opaque keys are
 * deliberately excluded from File Sync generation garbage collection. */
export const isFileSyncGenerationCloudKey = (value: unknown): value is string =>
    typeof value === 'string' && FILE_SYNC_GENERATION_CLOUD_KEY_PATTERN.test(value);

/** Base folder URL from a WebDAV/file sync URL that points at the data.json file itself. */
export const getBaseSyncUrl = (fullUrl: string): string => {
    const trimmed = fullUrl.replace(/\/+$/, '');
    if (trimmed.toLowerCase().endsWith('.json')) {
        const lastSlash = trimmed.lastIndexOf('/');
        return lastSlash >= 0 ? trimmed.slice(0, lastSlash) : trimmed;
    }
    return trimmed;
};

/** Versioned base URL for a self-hosted cloud's attachment routes.
 *  The stored cloud URL is whatever the user typed (`https://host`,
 *  `https://host/v1`, `https://host/v1/data`); data requests run it through
 *  `normalizeCloudUrl` first, so attachments must too or a bare host URL
 *  targets `/attachments/...` instead of `/v1/attachments/...` (#781). */
export const getCloudBaseUrl = (fullUrl: string): string =>
    normalizeCloudUrl(fullUrl).slice(0, -'/data'.length);
