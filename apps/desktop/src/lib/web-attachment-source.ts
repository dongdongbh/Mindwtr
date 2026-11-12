import { bytesToBase64, cloudGetFile, getCloudBaseUrl, type Attachment } from '@mindwtr/core';
import { inferAttachmentMimeTypeFromUri } from './attachment-mime';
import { isTauriRuntime } from './runtime';
import { logInfo } from './app-log';


type WebAttachmentBytes = { bytes: ArrayBuffer; mimeType: string };

const INERT_WEB_ATTACHMENT_MIME = /^(application\/pdf|text\/plain|image\/(png|jpeg|gif|webp|bmp|avif|heic|heif|tiff|x-icon|vnd\.microsoft\.icon)|audio\/(aac|mpeg|mp4|wav|x-wav|ogg|flac|webm|x-caf|x-m4a|3gpp|3gpp2)|video\/(mp4|webm|quicktime|x-msvideo|x-matroska|mpeg|ogg|3gpp|3gpp2))$/;

export const WEB_ATTACHMENT_BYTE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
export const WEB_ATTACHMENT_BYTE_CACHE_MAX_ENTRIES = 8;
export const WEB_ATTACHMENT_OPEN_URL_MAX_ENTRIES = 8;

type WebAttachmentByteCacheEntry = {
    promise: Promise<WebAttachmentBytes | null>;
    byteLength: number;
    settled: boolean;
};


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


    const { SyncService } = await import('./sync-service');
    const [backend, provider, encryption] = await Promise.all([
        SyncService.getSyncBackend(),
        SyncService.getCloudProvider(),
        SyncService.getSyncEncryptionStatus(),
    ]);
    if (backend !== 'cloud' || provider !== 'selfhosted') return null;


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

        bytesByAttachment.delete(key);
        bytesByAttachment.set(key, cached);
        return cached.promise;
    }

    const attachmentPrefix = `${attachment.id}:`;
    for (const [existingKey, entry] of bytesByAttachment) {
        if (existingKey !== key && existingKey.startsWith(attachmentPrefix)) {
            deleteCachedBytes(existingKey, entry);
        }
    }
    const pending = loadBytes(attachment, options).catch(() => null);
    const entry: WebAttachmentByteCacheEntry = { promise: pending, byteLength: 0, settled: false };
    bytesByAttachment.set(key, entry);

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


export const retainOpenedWebAttachmentUrl = (url: string): void => {
    const existingIndex = openedObjectUrls.indexOf(url);
    if (existingIndex >= 0) openedObjectUrls.splice(existingIndex, 1);
    openedObjectUrls.push(url);
    while (openedObjectUrls.length > WEB_ATTACHMENT_OPEN_URL_MAX_ENTRIES) {
        const oldest = openedObjectUrls.shift();
        if (oldest) URL.revokeObjectURL(oldest);
    }
};


export const clearWebAttachmentMemoryCaches = (): void => {
    bytesByAttachment.clear();
    cachedByteLength = 0;
    for (const url of openedObjectUrls.splice(0)) URL.revokeObjectURL(url);
};


export async function fetchWebCloudAttachmentBlob(
    attachment: Attachment,
    options: WebAttachmentFetchOptions = {},
): Promise<string | null> {
    const result = await readCachedBytes(attachment, options);
    if (!result) return null;
    const mimeType = result.mimeType.split(';', 1)[0].trim().toLowerCase();
    if (!INERT_WEB_ATTACHMENT_MIME.test(mimeType)) {
        const opaqueMime = mimeType === 'image/svg+xml' ? mimeType : 'application/octet-stream';
        void logInfo('Web attachment preview isolated', {
            scope: 'attachment', force: true,
            extra: { releaseCheck: 'v1.3.9/web-attachment-open-policy', outcome: 'isolated-preview' },
        });
        return `data:${opaqueMime};base64,${bytesToBase64(new Uint8Array(result.bytes))}`;
    }
    return URL.createObjectURL(new Blob([result.bytes], { type: mimeType }));
}

export async function openWebCloudAttachment(
    attachment: Attachment,
    options: WebAttachmentFetchOptions = {},
): Promise<boolean> {
    const result = await readCachedBytes(attachment, options);
    if (!result) return false;
    const mimeType = result.mimeType.split(';', 1)[0].trim().toLowerCase();
    const preview = INERT_WEB_ATTACHMENT_MIME.test(mimeType);
    const url = URL.createObjectURL(new Blob([result.bytes], {
        type: preview ? mimeType : 'application/octet-stream',
    }));
    retainOpenedWebAttachmentUrl(url);
    if (preview) {
        window.open(url, '_blank', 'noopener,noreferrer');
    } else {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = attachment.title || 'attachment';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
    }
    void logInfo('Web attachment open policy applied', {
        scope: 'attachment', force: true,
        extra: { releaseCheck: 'v1.3.9/web-attachment-open-policy', outcome: preview ? 'preview' : 'download' },
    });
    return true;
}


export async function fetchWebCloudAttachmentText(
    attachment: Attachment,
    options: WebAttachmentFetchOptions = {},
): Promise<string | null> {
    const result = await readCachedBytes(attachment, options);
    if (!result) return null;
    return new TextDecoder().decode(result.bytes);
}
