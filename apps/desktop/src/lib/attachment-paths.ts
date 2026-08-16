import { ATTACHMENTS_DIR_NAME } from '@mindwtr/core';
import { stripFileScheme } from './sync-service-utils';

const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATTERN = /^\\\\[^\\]/;

export function isLocalAttachmentPath(uri: string): boolean {
    const trimmed = uri.trim();
    if (!trimmed) return false;
    if (/^file:\/\//i.test(trimmed)) return true;
    if (WINDOWS_DRIVE_PATTERN.test(trimmed)) return true;
    if (WINDOWS_UNC_PATTERN.test(trimmed)) return true;
    if (trimmed.startsWith('/')) return true;
    return !URI_SCHEME_PATTERN.test(trimmed);
}

export function resolveAttachmentOpenTarget(uri: string): string {
    const trimmed = uri.trim();
    if (!trimmed) return trimmed;
    if (!isLocalAttachmentPath(trimmed)) return trimmed;
    return stripFileScheme(trimmed);
}

// A portable profile travels with the install, so an attachment URI recorded at
// the previous location is stale even though the file moved along inside the
// profile's attachments dir. The recorded path always wins while it resolves;
// only once it is gone do we retry the same file name in the current managed
// attachments dir, so the stored URI format never changes (#1038).
export async function resolveAttachmentReadPath(uri: string): Promise<string> {
    const target = resolveAttachmentOpenTarget(uri);
    if (!target || !isLocalAttachmentPath(target)) return target;
    const { exists } = await import('@tauri-apps/plugin-fs');
    // A path outside the webview's fs scope throws instead of returning false.
    const readable = async (path: string): Promise<boolean> => {
        try {
            return await exists(path);
        } catch {
            return false;
        }
    };
    if (await readable(target)) return target;
    const fileName = normalizeAttachmentPathForUrl(target).split('/').pop();
    if (!fileName) return target;
    const { getManagedPath } = await import('./managed-paths');
    const fallback = await getManagedPath(ATTACHMENTS_DIR_NAME, fileName);
    return (await readable(fallback)) ? fallback : target;
}

export function normalizeAttachmentPathForUrl(path: string): string {
    if (!path) return path;
    if (WINDOWS_UNC_PATTERN.test(path)) {
        return `//${path.replace(/^\\\\+/, '').replace(/\\/g, '/')}`;
    }
    return path.replace(/\\/g, '/');
}

export function toAttachmentBrowserUrl(uri: string): string {
    const trimmed = uri.trim();
    if (!trimmed) return trimmed;
    if (!isLocalAttachmentPath(trimmed)) return trimmed;
    const normalizedPath = normalizeAttachmentPathForUrl(resolveAttachmentOpenTarget(trimmed));
    if (normalizedPath.startsWith('//')) return `file:${normalizedPath}`;
    if (normalizedPath.startsWith('/')) return `file://${normalizedPath}`;
    return `file:///${normalizedPath}`;
}
