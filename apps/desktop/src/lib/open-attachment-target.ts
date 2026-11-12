import { open as openShell } from '@tauri-apps/plugin-shell';
import { isLocalAttachmentPath, resolveAttachmentOpenTarget, toAttachmentBrowserUrl } from './attachment-paths';
import { isTauriRuntime } from './runtime';
import { invokeNative } from './tauri-invoke';
import { isSandboxMode } from '@mindwtr/core';
import { isUpNoteHref, openExternalLink } from './external-link';
import { logInfo, logWarn } from './app-log';

const EXTERNAL_ATTACHMENT_LINK = /^(?:(?:https?|upnote|joplin|obsidian|ms-windows-store):\/\/|(?:mailto|tel|mid):)\S+$/i;

export async function openAttachmentTarget(uri: string, attachmentId?: string): Promise<void> {
    if (isSandboxMode()) throw new Error('Unavailable in sandbox.');
    const trimmed = uri.trim();
    if (!trimmed) return;
    if (!isLocalAttachmentPath(trimmed) && !EXTERNAL_ATTACHMENT_LINK.test(trimmed)) {
        void logWarn('Attachment link protocol refused', {
            scope: 'attachment', force: true,
            extra: { releaseCheck: 'v1.3.9/web-attachment-open-policy', outcome: 'refused-protocol' },
        });
        throw new Error('Attachment link protocol is not supported.');
    }
    if (isUpNoteHref(uri)) {
        await openExternalLink(uri, 'attachment');
        return;
    }

    if (isTauriRuntime()) {
        if (!isLocalAttachmentPath(trimmed)) {
            await openShell(trimmed);
            if (/^joplin:\/\//i.test(trimmed)) void logInfo('Joplin link handed to the OS', {
                scope: 'links', force: true,
                extra: { releaseCheck: 'v1.3.8/joplin-link-open' },
            });
            return;
        }

        await invokeNative('open_path', {
            path: resolveAttachmentOpenTarget(trimmed),
            attachmentId,
        });
        return;
    }

    window.open(toAttachmentBrowserUrl(trimmed), '_blank', 'noopener,noreferrer');
}
