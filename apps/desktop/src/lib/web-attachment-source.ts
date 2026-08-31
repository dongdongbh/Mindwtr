import { cloudGetFile, getCloudBaseUrl, type Attachment } from '@mindwtr/core';
import { inferAttachmentMimeTypeFromUri } from './attachment-mime';
import { isTauriRuntime } from './runtime';

/** The web build has no filesystem, so `attachmentPhasesEnabled` is false and file
 *  attachments only ever carry metadata (`cloudKey` set, `uri` empty). A self-hosted
 *  Mindwtr Cloud server already serves those bytes at `<cloudBase>/<cloudKey>`, which is
 *  exactly the URL the desktop and mobile cloud attachment backends PUT/GET. Nothing here
 *  runs under Tauri: the desktop app reads the local managed copy instead. */

type WebAttachmentBytes = { bytes: ArrayBuffer; mimeType: string };

// ponytail: unbounded session-lifetime byte cache — in the web build these bytes are the
// only copy, and a virtualized list re-mounts the same rows constantly. Add an LRU if a
// library of large attachments makes the memory show up.
const bytesByAttachment = new Map<string, Promise<WebAttachmentBytes | null>>();

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

const readCachedBytes = (
    attachment: Attachment,
    options: WebAttachmentFetchOptions,
): Promise<WebAttachmentBytes | null> => {
    if (isTauriRuntime() || !attachment.cloudKey || attachment.deletedAt) return Promise.resolve(null);
    const key = `${attachment.id}:${attachment.fileHash || attachment.updatedAt || ''}`;
    const cached = bytesByAttachment.get(key);
    if (cached) return cached;
    const pending = loadBytes(attachment, options).catch(() => null);
    bytesByAttachment.set(key, pending);
    // Only successes are worth remembering — an offline or failed load must be retryable.
    void pending.then((result) => {
        if (!result) bytesByAttachment.delete(key);
    });
    return pending;
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
