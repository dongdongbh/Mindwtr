import { ATTACHMENTS_DIR_NAME } from '@mindwtr/core';
import { stripFileScheme } from './sync-service-utils';
import { logWarn } from './app-log';

const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATTERN = /^\\\\[^\\]/;

export function isLocalAttachmentPath(uri: string): boolean {
    const trimmed = uri.trim();
    if (!trimmed) return false;
    if (/^file:/i.test(trimmed)) return true;
    if (WINDOWS_DRIVE_PATTERN.test(trimmed)) return true;
    if (WINDOWS_UNC_PATTERN.test(trimmed)) return true;
    if (trimmed.startsWith('/')) return true;
    return !URI_SCHEME_PATTERN.test(trimmed);
}

export function isUnsafeLocalAttachmentPath(uri: string): boolean {
    const trimmed = uri.trim();
    let path = trimmed;
    if (/^file:/i.test(trimmed)) {
        try {
            const parsed = new URL(trimmed);
            if (!/^file:\/\//i.test(trimmed) || parsed.hostname) return true;
            decodeURIComponent(parsed.pathname);
            path = stripFileScheme(trimmed);
        } catch {
            return true;
        }
    }
    const normalized = path.replace(/\\/g, '/');
    if (normalized.startsWith('//') || path.startsWith('\\') || [...path].some((character) => (
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ))) return true;
    if (!WINDOWS_DRIVE_PATTERN.test(path)) return false;
    return normalized.slice(3).split('/').some((part) => (
        part.includes(':')
        || (part !== '.' && part !== '..' && /[. ]$/.test(part))
        || /^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/i.test(part)
    ));
}


const RELOCATED_MANAGED_DIR_NAMES = [ATTACHMENTS_DIR_NAME, 'audio-captures'];


export function rehomeManagedSubfolderPath(path: string, managedDataDir: string): string | null {
    const normalized = normalizeAttachmentPathForUrl(path.trim());
    const managed = normalizeAttachmentPathForUrl(managedDataDir.trim()).replace(/\/+$/, '');
    if (!normalized || !managed) return null;
    const parentEnd = managed.lastIndexOf('/');
    if (parentEnd < 0) return null;
    const parent = managed.slice(0, parentEnd);
    const prefix = parent.endsWith('/') ? parent : `${parent}/`;
    if (!normalized.startsWith(prefix)) return null;
    const segments = normalized.slice(prefix.length).split('/');
    const dirName = segments.shift();
    if (!dirName || !RELOCATED_MANAGED_DIR_NAMES.includes(dirName)) return null;
    if (segments.length === 0) return null;
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
    const rehomed = `${managed}/${dirName}/${segments.join('/')}`;
    return rehomed === normalized ? null : rehomed;
}

export function resolveAttachmentOpenTarget(uri: string): string {
    const trimmed = uri.trim();
    if (!trimmed) return trimmed;
    if (!isLocalAttachmentPath(trimmed)) return trimmed;
    if (isUnsafeLocalAttachmentPath(trimmed)) {
        void logWarn('Attachment path refused', {
            scope: 'attachment',
            extra: { releaseCheck: 'v1.3.9/attachment-open-policy', outcome: 'refused-path' },
        });
        throw new Error('Only local file paths can be opened.');
    }
    return stripFileScheme(trimmed);
}


export async function resolveAttachmentReadPath(uri: string, attachmentId: string): Promise<string> {
    const target = resolveAttachmentOpenTarget(uri);
    if (!target || !isLocalAttachmentPath(target)) return target;
    const { exists } = await import('@tauri-apps/plugin-fs');

    const readable = async (path: string): Promise<boolean> => {
        try {
            return await exists(path);
        } catch {
            return false;
        }
    };
    if (await readable(target)) return target;
    const { getManagedDataDir, getManagedPath } = await import('./managed-paths');
    const rehomed = rehomeManagedSubfolderPath(target, await getManagedDataDir());
    if (rehomed && (await readable(rehomed))) return rehomed;
    const fileName = normalizeAttachmentPathForUrl(target).split('/').pop();
    if (
        !fileName
        || (fileName !== attachmentId && !fileName.startsWith(`${attachmentId}.`))
    ) return target;
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
