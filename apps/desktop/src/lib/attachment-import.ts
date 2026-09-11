import { type Attachment, DEFAULT_MAX_FILE_SIZE_BYTES, generateUUID, isSandboxMode } from '@mindwtr/core';
import { logWarn } from './app-log';
import { getManagedPath } from './managed-paths';
import { ATTACHMENTS_DIR_NAME, extractExtension } from './sync-service-utils';
import { invokeNative } from './tauri-invoke';

export type ImportPickedFileResult =
    | { attachment: Attachment }
    | { errorKey: 'attachments.fileTooLarge' | 'attachments.fileNotReadable' };

// Browse for a file to LINK to (pointer, no copy) — fills the link prompt
// with the picked path instead of importing the bytes.
export async function browseForLinkTarget(dialogTitle: string): Promise<string | null> {
    if (isSandboxMode()) return null;
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({
        multiple: false,
        directory: false,
        title: dialogTitle,
    });
    return typeof selected === 'string' ? selected : null;
}

// Copies the picked file into the app-managed attachments dir (via the Rust
// side, which is not bound by the webview fs scope) so the attachment owns its
// bytes and never depends on the original path again.
export async function importPickedFileAttachment(selectedPath: string): Promise<ImportPickedFileResult> {
    if (isSandboxMode()) return { errorKey: 'attachments.fileNotReadable' };
    const title = selectedPath.split(/[/\\]/).pop() || selectedPath;
    const id = generateUUID();
    try {
        const imported = await invokeNative<{ uri: string; size: number }>('import_attachment_file', {
            path: selectedPath,
            fileName: `${id}${extractExtension(title)}`,
            maxBytes: DEFAULT_MAX_FILE_SIZE_BYTES,
        });
        const now = new Date().toISOString();
        return {
            attachment: {
                id,
                kind: 'file',
                title,
                uri: imported.uri,
                size: imported.size,
                localStatus: 'available',
                createdAt: now,
                updatedAt: now,
            },
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void logWarn('Failed to import attachment file', {
            scope: 'attachment',
            extra: { error: message },
        });
        return {
            errorKey: message === 'file_too_large'
                ? 'attachments.fileTooLarge'
                : 'attachments.fileNotReadable',
        };
    }
}

// A dropped file arrives as bytes with no OS path, so it can't go through
// the Rust copier (import_attachment_file). Write it into the same
// managed attachments dir directly from the webview instead.
export async function importDroppedFileAttachment(file: File): Promise<ImportPickedFileResult> {
    if (isSandboxMode()) return { errorKey: 'attachments.fileNotReadable' };
    if (file.size > DEFAULT_MAX_FILE_SIZE_BYTES) {
        return { errorKey: 'attachments.fileTooLarge' };
    }
    const id = generateUUID();
    try {
        const { mkdir, writeFile } = await import('@tauri-apps/plugin-fs');
        const { join } = await import('@tauri-apps/api/path');
        const dir = await getManagedPath(ATTACHMENTS_DIR_NAME);
        await mkdir(dir, { recursive: true });
        const targetPath = await join(dir, `${id}${extractExtension(file.name)}`);
        const bytes = new Uint8Array(await file.arrayBuffer());
        await writeFile(targetPath, bytes);
        const now = new Date().toISOString();
        return {
            attachment: {
                id,
                kind: 'file',
                title: file.name,
                uri: targetPath,
                size: file.size,
                localStatus: 'available',
                createdAt: now,
                updatedAt: now,
                mimeType: file.type || undefined,
            },
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void logWarn('Failed to import dropped file attachment', {
            scope: 'attachment',
            extra: { error: message },
        });
        return { errorKey: 'attachments.fileNotReadable' };
    }
}
