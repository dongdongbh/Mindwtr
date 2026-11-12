import { Attachment } from '@mindwtr/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { normalizeAttachmentPathForUrl, isLocalAttachmentPath, isUnsafeLocalAttachmentPath, resolveAttachmentOpenTarget } from '../../lib/attachment-paths';
import { isTauriRuntime } from '../../lib/runtime';

export function isAudioAttachment(attachment: Attachment): boolean {
    const mime = attachment.mimeType?.toLowerCase();
    if (mime && mime.startsWith('audio/')) return true;
    return /\.(m4a|aac|mp3|wav|caf|ogg|oga|flac|webm)$/i.test(attachment.uri);
}

export function isImageAttachment(attachment: Attachment): boolean {
    const mime = attachment.mimeType?.toLowerCase();
    if (mime && mime.startsWith('image/')) return true;
    return /\.(png|jpg|jpeg|gif|webp|bmp|svg|heic|heif)$/i.test(attachment.uri);
}

export function isTextAttachment(attachment: Attachment): boolean {
    const mime = attachment.mimeType?.toLowerCase();
    if (mime) {
        if (mime.startsWith('text/')) return true;
        if (mime === 'application/json' || mime === 'application/xml') return true;
        if (mime === 'application/x-yaml' || mime === 'application/toml') return true;
    }
    return /\.(txt|md|markdown|json|csv|log|yaml|yml|toml|ini|cfg|conf|xml)$/i.test(attachment.uri);
}

export function resolveAttachmentSource(uri: string): string {
    if (isUnsafeLocalAttachmentPath(uri)) return '';
    if (!isTauriRuntime()) return uri;
    if (/^https?:\/\//i.test(uri)) return uri;
    if (!isLocalAttachmentPath(uri)) return uri;
    const raw = resolveAttachmentOpenTarget(uri);
    return convertFileSrc(normalizeAttachmentPathForUrl(raw));
}
