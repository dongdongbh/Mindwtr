import { useEffect, useState } from 'react';
import type { Attachment } from '@mindwtr/core';
import { cn } from '../../lib/utils';
import { normalizeAttachmentPathForUrl, resolveAttachmentReadPath } from '../../lib/attachment-paths';
import { isTauriRuntime } from '../../lib/runtime';
import { resolveAttachmentSource } from './task-item-attachment-utils';

type AttachmentImageProps = {
    attachment: Attachment;
    alt: string;
    className?: string;
};

const inferImageMimeType = (attachment: Attachment): string => {
    const mime = attachment.mimeType?.toLowerCase();
    if (mime?.startsWith('image/')) return mime;
    const uri = attachment.uri.toLowerCase();
    if (uri.endsWith('.png')) return 'image/png';
    if (uri.endsWith('.jpg') || uri.endsWith('.jpeg')) return 'image/jpeg';
    if (uri.endsWith('.gif')) return 'image/gif';
    if (uri.endsWith('.webp')) return 'image/webp';
    if (uri.endsWith('.bmp')) return 'image/bmp';
    if (uri.endsWith('.svg')) return 'image/svg+xml';
    if (uri.endsWith('.heic')) return 'image/heic';
    if (uri.endsWith('.heif')) return 'image/heif';
    return 'image/png';
};

const loadTauriImageSource = async (attachment: Attachment): Promise<string | null> => {
    const uri = await resolveAttachmentReadPath(attachment.uri);
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

export function AttachmentImage({ attachment, alt, className }: AttachmentImageProps) {
    const [src, setSrc] = useState<string | null>(() => (
        attachment.uri && !isTauriRuntime() ? resolveAttachmentSource(attachment.uri) : null
    ));
    const [hidden, setHidden] = useState(false);

    useEffect(() => {
        let active = true;
        let objectUrl: string | null = null;

        setHidden(false);
        if (!attachment.uri) {
            setSrc(null);
            return () => undefined;
        }
        if (!isTauriRuntime()) {
            setSrc(resolveAttachmentSource(attachment.uri));
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
    }, [attachment.uri, attachment.mimeType]);

    if (!src || hidden) {
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
