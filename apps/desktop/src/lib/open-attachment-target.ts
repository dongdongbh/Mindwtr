import { open as openShell } from '@tauri-apps/plugin-shell';
import { isLocalAttachmentPath, resolveAttachmentOpenTarget, toAttachmentBrowserUrl } from './attachment-paths';
import { isTauriRuntime } from './runtime';
import { invokeNative } from './tauri-invoke';
import { isSandboxMode } from '@mindwtr/core';
import { isUpNoteHref, openExternalLink } from './external-link';
import { logInfo } from './app-log';

export async function openAttachmentTarget(uri: string, attachmentId?: string): Promise<void> {
    if (isSandboxMode()) throw new Error('Unavailable in sandbox.');
    const trimmed = uri.trim();
    if (!trimmed) return;
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

    window.open(toAttachmentBrowserUrl(trimmed), '_blank');
}
