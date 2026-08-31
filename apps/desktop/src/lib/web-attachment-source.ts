import { cloudGetFile, getCloudBaseUrl, type Attachment } from '@mindwtr/core';
import { inferAttachmentMimeTypeFromUri } from './attachment-mime';
import { isTauriRuntime } from './runtime';

/** The web build has no filesystem, so `attachmentPhasesEnabled` is false and file
 *  attachments only ever carry metadata (`cloudKey` set, `uri` empty). A self-hosted
 *  Mindwtr Cloud server already serves those bytes at `<cloudBase>/<cloudKey>`, which is
 *  exactly the URL the desktop and mobile cloud attachment backends PUT/GET. Nothing here
 *  runs under Tauri: the desktop app reads the local managed copy instead. */

type WebAttachmentBytes = { bytes: ArrayBuffer; mimeType: string };

export const WEB_ATTACHMENT_BYTE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
export const WEB_ATTACHMENT_BYTE_CACHE_MAX_ENTRIES = 8;
export const WEB_ATTACHMENT_OPEN_URL_MAX_ENTRIES = 8;

type WebAttachmentByteCacheEntry = {
    promise: Promise<WebAttachmentBytes | null>;
    byteLength: number;
    settled: boolean;
};

// The web build has no filesystem copy, so short-lived byte reuse avoids refetching as
// virtualized rows remount. Keep it deliberately small: attachment bytes can be much larger
// than task metadata, and a session-lifetime unbounded Map eventually terminates the tab.
const bytesByAttachment = new Map<string, WebAttachmentByteCacheEntry>();
let cachedByteLength = 0;
const openedObjectUrls: string[] = [];

type WebAttachmentFetchOptions = { fetcher?: typeof fetch };

const resolveMimeType = (attachment: Attachment): string => (
    attachment.mimeType
    || inferAttachmentMimeTypeFromUri(attachment.cloudKey || '')
    || inferAttachmentMimeTypeFromUri(attachment.title || '')
    || 'application/octet-stream'
);

const loadBytes = async (
    attachment: Attachment,
    options: WebAttachmentFetchOptions,
): Promise<WebAttachmentBytes | null> => {
    // Imported lazily: sync-service pulls the whole sync stack (and its native seams) in,
    // and nothing on this path runs before a user opens an attachment.
    const { SyncService } = await import('./sync-service');
    const [backend, provider, encryption] = await Promise.all([
        SyncService.getSyncBackend(),
        SyncService.getCloudProvider(),
        SyncService.getSyncEncryptionStatus(),
    ]);
    if (backend !== 'cloud' || provider !== 'selfhosted') return null;
    // No key material exists in the web build, so anything but plaintext would decode to
    // garbage. Show the unsupported notice instead of broken bytes.
    if (encryption.state !== 'off') return null;

    const config = await SyncService.getCloudConfig({ silent: true });
    if (!config.url) return null;
    const data = await cloudGetFile(`${getCloudBaseUrl(config.url)}/${attachment.cloudKey}`, {
        token: config.token,
        allowInsecureHttp: config.allowInsecureHttp,
        ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    });
    return { bytes: data, mimeType: resolveMimeType(attachment) };
};

const deleteCachedBytes = (key: string, expected?: WebAttachmentByteCacheEntry): void => {
    const current = bytesByAttachment.get(key);
    if (!current || (expected && current !== expected)) return;
    bytesByAttachment.delete(key);
    if (current.settled) cachedByteLength = Math.max(0, cachedByteLength - current.byteLength);
};

const evictCachedBytesToBudget = (): void => {
    const settledEntries = () => Array.from(bytesByAttachment.values()).filter((entry) => entry.settled).length;
    while (
        cachedByteLength > WEB_ATTACHMENT_BYTE_CACHE_MAX_BYTES
        || settledEntries() > WEB_ATTACHMENT_BYTE_CACHE_MAX_ENTRIES
    ) {
        const oldest = Array.from(bytesByAttachment.entries()).find(([, entry]) => entry.settled);
        if (!oldest) return;
        deleteCachedBytes(oldest[0], oldest[1]);
    }
};

const readCachedBytes = (
    attachment: Attachment,
    options: WebAttachmentFetchOptions,
): Promise<WebAttachmentBytes | null> => {
    if (isTauriRuntime() || !attachment.cloudKey || attachment.deletedAt) return Promise.resolve(null);
    const key = `${attachment.id}:${attachment.fileHash || attachment.updatedAt || ''}`;
    const cached = bytesByAttachment.get(key);
    if (cached) {
        // Map insertion order is the LRU order.
        bytesByAttachment.delete(key);
        bytesByAttachment.set(key, cached);
        return cached.promise;
    }
    // A new content identity makes older successful bytes for this attachment obsolete.
    const attachmentPrefix = `${attachment.id}:`;
    for (const [existingKey, entry] of bytesByAttachment) {
        if (existingKey !== key && existingKey.startsWith(attachmentPrefix)) {
            deleteCachedBytes(existingKey, entry);
        }
    }
    const pending = loadBytes(attachment, options).catch(() => null);
    const entry: WebAttachmentByteCacheEntry = { promise: pending, byteLength: 0, settled: false };
    bytesByAttachment.set(key, entry);
    // Only successes are worth remembering — an offline or failed load must be retryable.
    void pending.then((result) => {
        if (bytesByAttachment.get(key) !== entry) return;
        if (!result) {
            deleteCachedBytes(key, entry);
            return;
        }
        entry.settled = true;
        entry.byteLength = result.bytes.byteLength;
        cachedByteLength += entry.byteLength;
        evictCachedBytesToBudget();
    });
    return pending;
};

/** Keep generic Open actions bounded. Preview/audio callers own their URL directly and
 * revoke it when their viewer closes; a browser tab has no matching React lifecycle. */
export const retainOpenedWebAttachmentUrl = (url: string): void => {
    const existingIndex = openedObjectUrls.indexOf(url);
    if (existingIndex >= 0) openedObjectUrls.splice(existingIndex, 1);
    openedObjectUrls.push(url);
    while (openedObjectUrls.length > WEB_ATTACHMENT_OPEN_URL_MAX_ENTRIES) {
        const oldest = openedObjectUrls.shift();
        if (oldest) URL.revokeObjectURL(oldest);
    }
};

/** Clears retained web-only attachment memory, suitable for tests and session teardown. */
export const clearWebAttachmentMemoryCaches = (): void => {
    bytesByAttachment.clear();
    cachedByteLength = 0;
    for (const url of openedObjectUrls.splice(0)) URL.revokeObjectURL(url);
};

/** An object URL for the attachment's bytes, or null when this build/backend can't serve
 *  them. Each call mints a fresh URL, so the caller owns it and revokes it exactly the way
 *  it already revokes the Tauri-read blobs. */
export async function fetchWebCloudAttachmentBlob(
    attachment: Attachment,
    options: WebAttachmentFetchOptions = {},
): Promise<string | null> {
    const result = await readCachedBytes(attachment, options);
    if (!result) return null;
    return URL.createObjectURL(new Blob([result.bytes], { type: result.mimeType }));
}

/** UTF-8 text for the attachment, or null when this build/backend can't serve the bytes. */
export async function fetchWebCloudAttachmentText(
    attachment: Attachment,
    options: WebAttachmentFetchOptions = {},
): Promise<string | null> {
    const result = await readCachedBytes(attachment, options);
    if (!result) return null;
    return new TextDecoder().decode(result.bytes);
}
