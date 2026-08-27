import {
    ATTACHMENTS_DIR_NAME,
    buildCloudKey,
    extractExtension,
    getFileSyncDir,
    isSyncFilePath,
    normalizePath,
    normalizeSyncBackend,
    sleep,
    toStableJson,
    type Attachment,
    type LocalAttachmentPresence,
    type SyncBackend,
} from '@mindwtr/core';
import { normalizeAttachmentPathForUrl } from './attachment-paths';

export { ATTACHMENTS_DIR_NAME, buildCloudKey, extractExtension };

const importNodeCrypto = async (): Promise<typeof import('node:crypto')> => {
    const specifier = 'node:crypto';
    return import(/* @vite-ignore */ specifier) as Promise<typeof import('node:crypto')>;
};

export const hashString = async (value: string): Promise<string> => {
    if (globalThis.crypto?.subtle) {
        const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
        return Array.from(new Uint8Array(digest))
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('');
    }

    if (typeof process !== 'undefined' && process?.versions?.node) {
        try {
            const crypto = await importNodeCrypto();
            return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
        } catch {
            // Fall through to legacy fallback if node:crypto is unavailable.
        }
    }

    return fallbackHashString(value);
};

export const fallbackHashString = (value: string): string => {
    // Legacy fallback for runtimes without Web Crypto or node:crypto.
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
        hash = Math.imul(31, hash) + value.charCodeAt(i);
        hash |= 0;
    }
    return (hash >>> 0).toString(16);
};

export const yieldToRenderer = async (): Promise<void> => {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        return;
    }
    await sleep(0);
};

export const createCooperativeYield = (every = 8) => {
    let counter = 0;
    return async (): Promise<void> => {
        counter += 1;
        if (counter % every !== 0) return;
        await yieldToRenderer();
    };
};

export {
    getFileSyncDir,
    isSyncFilePath,
    normalizePath,
    normalizeSyncBackend,
    sleep,
    toStableJson,
    type SyncBackend,
};

export const stripFileScheme = (uri: string): string => {
    if (!/^file:\/\//i.test(uri)) return uri;
    try {
        const parsed = new URL(uri);
        let path = decodeURIComponent(parsed.pathname);
        if (/^\/[A-Za-z]:\//.test(path)) {
            path = path.slice(1);
        }
        return path;
    } catch {
        return uri.replace(/^file:\/\//i, '');
    }
};

const normalizeAttachmentFsPath = (path: string): string => normalizeAttachmentPathForUrl(path.trim());

const isPathWithin = (dir: string, path: string): boolean => {
    const root = normalizeAttachmentFsPath(dir).replace(/\/+$/, '');
    return Boolean(root) && (path === root || path.startsWith(`${root}/`));
};

/**
 * SEC-07: which local paths this device may read bytes from for sync. An attachment `uri`
 * travels inside the synced document and an absolute path there survives the merge
 * sanitizer, so without this a hostile sync document makes the next cycle upload an
 * arbitrary local file to the remote. Every file attachment desktop creates is written
 * under the managed data dir (imports, dropped files, pasted images, audio captures);
 * files the user merely points at are `kind: 'link'` and never reach the transfer loop.
 */
export const createManagedAttachmentSourcePredicate = async (): Promise<(localPath: string) => boolean> => {
    const { dataDir } = await import('@tauri-apps/api/path');
    const { getManagedDataDir } = await import('./managed-paths');
    const roots = await Promise.all([dataDir(), getManagedDataDir()]);
    return (localPath: string): boolean => {
        const normalized = normalizeAttachmentFsPath(stripFileScheme(localPath));
        return roots.some((root) => isPathWithin(root, normalized));
    };
};

/**
 * Every attachment sync backend needs the same two local-file primitives:
 * read a path that may be relative to Tauri's app-data dir (Windows paths
 * carried the raw drive letter before {@link stripFileScheme} normalized
 * them) or an absolute path elsewhere on disk. This factory is the single
 * home for that logic — previously duplicated verbatim across all five
 * backends in `sync-attachment-backends.ts`.
 */
export const createLocalAttachmentFs = (
    logSyncWarning: (message: string, error?: unknown) => void,
    deps: {
        baseDataDir: string;
        dataBaseDir: any;
        exists: (path: string, options?: { baseDir: any }) => Promise<boolean>;
        readFile: (path: string, options?: { baseDir: any }) => Promise<Uint8Array>;
        /** Current managed attachments dir, used to recover from stale absolute
         *  paths left behind by a relocated portable profile (#1038). */
        managedAttachmentsDir?: string;
        /** Optional: enables `statLocalFile` for check-on-touch content-change
         *  detection (#1057). Omitted by callers that don't need it. */
        stat?: (path: string, options?: { baseDir: any }) => Promise<{ mtime: Date | null; size: number }>;
    },
    warningMessage = 'Failed to check attachment file',
): {
    readLocalFile: (path: string, attachment: Pick<Attachment, 'id'>) => Promise<Uint8Array>;
    localFilePresence: (path: string, attachment: Pick<Attachment, 'id'>) => Promise<LocalAttachmentPresence>;
    localFileExists: (path: string, attachment: Pick<Attachment, 'id'>) => Promise<boolean>;
    statLocalFile: (path: string, attachment: Pick<Attachment, 'id'>) => Promise<{ mtimeMs: number; size: number } | null>;
} => {
    const baseDataDir = deps.baseDataDir.replace(/[\\/]+$/, '');
    const isWithinDataDir = (path: string): boolean => Boolean(baseDataDir) && (
        path === baseDataDir
        || path.startsWith(`${baseDataDir}/`)
        || path.startsWith(`${baseDataDir}\\`)
    );
    const toRelative = (path: string): string => path.slice(baseDataDir.length).replace(/^[\\/]/, '');

    // A portable profile travels with the install, so a URI recorded at its
    // previous location is stale even though the file moved along inside
    // attachments/. Only consulted after the recorded path fails (#1038).
    const managedFallbackPath = (path: string, attachment: Pick<Attachment, 'id'>): string | null => {
        if (!deps.managedAttachmentsDir) return null;
        const normalized = normalizeAttachmentFsPath(path);
        const fileName = normalized.split('/').pop();
        if (
            !fileName
            || (fileName !== attachment.id && !fileName.startsWith(`${attachment.id}.`))
        ) return null;
        const dir = normalizeAttachmentFsPath(deps.managedAttachmentsDir).replace(/\/+$/, '');
        const fallback = `${dir}/${fileName}`;
        return fallback === normalized ? null : fallback;
    };

    const readLocalFile = async (
        path: string,
        attachment: Pick<Attachment, 'id'>,
    ): Promise<Uint8Array> => {
        if (isWithinDataDir(path)) {
            return await deps.readFile(toRelative(path), { baseDir: deps.dataBaseDir });
        }
        try {
            return await deps.readFile(normalizeAttachmentFsPath(path));
        } catch (error) {
            const fallback = managedFallbackPath(path, attachment);
            if (!fallback) throw error;
            return await deps.readFile(fallback);
        }
    };

    const localFilePresence = async (
        path: string,
        attachment: Pick<Attachment, 'id'>,
    ): Promise<LocalAttachmentPresence> => {
        const candidates: Array<{ path: string; options?: { baseDir: any } }> = [
            isWithinDataDir(path)
                ? { path: toRelative(path), options: { baseDir: deps.dataBaseDir } }
                : { path: normalizeAttachmentFsPath(path) },
        ];
        const fallback = managedFallbackPath(path, attachment);
        if (fallback) candidates.push({ path: fallback });

        let sawError = false;
        for (const candidate of candidates) {
            try {
                const exists = candidate.options
                    ? await deps.exists(candidate.path, candidate.options)
                    : await deps.exists(candidate.path);
                if (exists) return 'present';
            } catch (error) {
                sawError = true;
                logSyncWarning(warningMessage, error);
            }
        }
        return sawError ? 'unreadable' : 'confirmed-not-found';
    };

    // Compatibility for callers that do not make sync decisions from absence.
    const localFileExists = async (
        path: string,
        attachment: Pick<Attachment, 'id'>,
    ): Promise<boolean> => await localFilePresence(path, attachment) === 'present';

    const statLocalFile = async (
        path: string,
        attachment: Pick<Attachment, 'id'>,
    ): Promise<{ mtimeMs: number; size: number } | null> => {
        if (!deps.stat) return null;
        const toStat = (info: { mtime: Date | null; size: number }) => ({
            mtimeMs: info.mtime ? info.mtime.getTime() : 0,
            size: info.size,
        });
        try {
            if (isWithinDataDir(path)) {
                return toStat(await deps.stat(toRelative(path), { baseDir: deps.dataBaseDir }));
            }
            try {
                return toStat(await deps.stat(normalizeAttachmentFsPath(path)));
            } catch (error) {
                const fallback = managedFallbackPath(path, attachment);
                if (!fallback) throw error;
                return toStat(await deps.stat(fallback));
            }
        } catch (error) {
            logSyncWarning(warningMessage, error);
            return null;
        }
    };

    return { readLocalFile, localFilePresence, localFileExists, statLocalFile };
};

const buildTempPath = (relativePath: string): string => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    return `${relativePath}.tmp-${suffix}`;
};

export const writeAttachmentFileSafely = async (
    relativePath: string,
    bytes: Uint8Array,
    options: {
        baseDir: any;
        writeFile: (path: string, data: Uint8Array, opts: { baseDir: any }) => Promise<void>;
        rename: (oldPath: string, newPath: string, opts: { oldPathBaseDir: any; newPathBaseDir: any }) => Promise<void>;
        remove: (path: string, opts: { baseDir: any }) => Promise<void>;
    }
): Promise<void> => {
    const tempPath = buildTempPath(relativePath);
    await options.writeFile(tempPath, bytes, { baseDir: options.baseDir });
    try {
        await options.rename(tempPath, relativePath, {
            oldPathBaseDir: options.baseDir,
            newPathBaseDir: options.baseDir,
        });
    } catch {
        await options.writeFile(relativePath, bytes, { baseDir: options.baseDir });
        try {
            await options.remove(tempPath, { baseDir: options.baseDir });
        } catch {
            // Ignore cleanup errors for temp file.
        }
    }
};

export const writeFileSafelyAbsolute = async (
    path: string,
    bytes: Uint8Array,
    options: {
        writeFile: (path: string, data: Uint8Array) => Promise<void>;
        rename: (oldPath: string, newPath: string) => Promise<void>;
        remove: (path: string) => Promise<void>;
    }
): Promise<void> => {
    const tempPath = buildTempPath(path);
    await options.writeFile(tempPath, bytes);
    try {
        await options.rename(tempPath, path);
    } catch {
        await options.writeFile(path, bytes);
        try {
            await options.remove(tempPath);
        } catch {
            // Ignore cleanup errors for temp file.
        }
    }
};

// A cloudKey arrives over sync, so it is attacker-controlled input to a filesystem
// write/delete. Both callers treat a rejection as a failed transfer, never a completed
// one, so throwing is safe here and silently clamping the path would not be.
export const resolveFileBackendPath = async (
    join: (...paths: string[]) => Promise<string>,
    baseDir: string,
    relativePath: string,
): Promise<string> => {
    const segments = relativePath
        .split(/[\\/]+/)
        .filter(Boolean);
    if (relativePath.includes('\0') || segments.some((segment) => segment === '..')) {
        throw new Error(`Refusing attachment path outside the sync folder: ${JSON.stringify(relativePath)}`);
    }
    return segments.length > 0 ? await join(baseDir, ...segments) : baseDir;
};

export const isTempAttachmentFile = (name: string): boolean => {
    return name.includes('.tmp-') || name.endsWith('.tmp') || name.endsWith('.partial');
};
