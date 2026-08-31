import { useEffect, useState } from 'react';
import type { Attachment } from '@mindwtr/core';
import { cn } from '../../lib/utils';
import { inferAttachmentMimeTypeFromUri } from '../../lib/attachment-mime';
import { normalizeAttachmentPathForUrl, resolveAttachmentReadPath } from '../../lib/attachment-paths';
import { isTauriRuntime } from '../../lib/runtime';
import { fetchWebCloudAttachmentBlob } from '../../lib/web-attachment-source';
import { resolveAttachmentSource } from './task-item-attachment-utils';

type AttachmentImageProps = {
    attachment: Attachment;
    alt: string;
    className?: string;
    /** Shown instead of the muted placeholder when the web build cannot fetch the bytes.
     *  Only the full-size viewer passes it; thumbnails stay silent. */
    unavailableText?: string;
};

const inferImageMimeType = (attachment: Attachment): string => {
    const mime = attachment.mimeType?.toLowerCase();
    if (mime?.startsWith('image/')) return mime;
    const inferred = inferAttachmentMimeTypeFromUri(attachment.uri);
    return inferred?.startsWith('image/') ? inferred : 'image/png';
};

const loadTauriImageSource = async (attachment: Attachment): Promise<string | null> => {
    const uri = await resolveAttachmentReadPath(attachment.uri, attachment.id);
    if (!uri || /^https?:\/\//i.test(uri)) return resolveAttachmentSource(attachment.uri);

    const [{ dataDir }, { BaseDirectory, readFile }] = await Promise.all([
        import('@tauri-apps/api/path'),
        import('@tauri-apps/plugin-fs'),
    ]);

    const baseDir = await dataDir();
    const normalizedUri = normalizeAttachmentPathForUrl(uri);
    const normalizedBaseDir = normalizeAttachmentPathForUrl(baseDir);
    const bytes = normalizedUri.startsWith(normalizedBaseDir)
        ? await readFile(normalizedUri.slice(normalizedBaseDir.length).replace(/^[\\/]/, ''), {
            baseDir: BaseDirectory.Data,
        })
        : await readFile(uri);
    const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return URL.createObjectURL(new Blob([buffer], { type: inferImageMimeType(attachment) }));
};

export function AttachmentImage({ attachment, alt, className, unavailableText }: AttachmentImageProps) {
    const [src, setSrc] = useState<string | null>(() => (
        attachment.uri && !isTauriRuntime() ? resolveAttachmentSource(attachment.uri) : null
    ));
    const [hidden, setHidden] = useState(false);
    const [unavailable, setUnavailable] = useState(false);

    useEffect(() => {
        let active = true;
        let objectUrl: string | null = null;

        setHidden(false);
        setUnavailable(false);
        if (!isTauriRuntime()) {
            if (attachment.uri) {
                setSrc(resolveAttachmentSource(attachment.uri));
                return () => undefined;
            }
            // No filesystem in the web build: the bytes can only come from a self-hosted
            // cloud server, and only for a plaintext library.
            setSrc(null);
            void fetchWebCloudAttachmentBlob(attachment).then((blobUrl) => {
                if (!active) {
                    if (blobUrl) URL.revokeObjectURL(blobUrl);
                    return;
                }
                objectUrl = blobUrl;
                setSrc(blobUrl);
                setUnavailable(!blobUrl);
            });
            return () => {
                active = false;
                if (objectUrl) URL.revokeObjectURL(objectUrl);
            };
        }
        if (!attachment.uri) {
            setSrc(null);
            return () => undefined;
        }

        setSrc(null);
        void loadTauriImageSource(attachment)
            .then((nextSrc) => {
                if (!active) {
                    if (nextSrc?.startsWith('blob:')) URL.revokeObjectURL(nextSrc);
                    return;
                }
                objectUrl = nextSrc?.startsWith('blob:') ? nextSrc : null;
                setSrc(nextSrc);
            })
            .catch(() => {
                if (!active) return;
                setSrc(resolveAttachmentSource(attachment.uri));
            });

        return () => {
            active = false;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [attachment.id, attachment.uri, attachment.mimeType, attachment.cloudKey]);

    if (!src || hidden) {
        if (unavailable && unavailableText) {
            return (
                <div className={cn(className, 'flex items-center justify-center p-6 text-xs text-muted-foreground')}>
                    {unavailableText}
                </div>
            );
        }
        return <div className={cn(className, 'bg-muted/30')} aria-hidden="true" />;
    }

    return (
        <img
            src={src}
            alt={alt}
            className={className}
            loading="lazy"
            onError={() => {
                const fallback = resolveAttachmentSource(attachment.uri);
                if (src !== fallback) {
                    setSrc(fallback);
                    return;
                }
                setHidden(true);
            }}
        />
    );
}
