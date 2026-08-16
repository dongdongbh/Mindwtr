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
    },
    warningMessage = 'Failed to check attachment file',
): {
    readLocalFile: (path: string) => Promise<Uint8Array>;
    localFileExists: (path: string) => Promise<boolean>;
} => {
    const toRelative = (path: string): string => path.slice(deps.baseDataDir.length).replace(/^[\\/]/, '');

    // A portable profile travels with the install, so a URI recorded at its
    // previous location is stale even though the file moved along inside
    // attachments/. Only consulted after the recorded path fails (#1038).
    const managedFallbackPath = (path: string): string | null => {
        if (!deps.managedAttachmentsDir) return null;
        const normalized = normalizeAttachmentFsPath(path);
        const fileName = normalized.split('/').pop();
        if (!fileName) return null;
        const dir = normalizeAttachmentFsPath(deps.managedAttachmentsDir).replace(/\/+$/, '');
        const fallback = `${dir}/${fileName}`;
        return fallback === normalized ? null : fallback;
    };

    const readLocalFile = async (path: string): Promise<Uint8Array> => {
        if (path.startsWith(deps.baseDataDir)) {
            return await deps.readFile(toRelative(path), { baseDir: deps.dataBaseDir });
        }
        try {
            return await deps.readFile(normalizeAttachmentFsPath(path));
        } catch (error) {
            const fallback = managedFallbackPath(path);
            if (!fallback) throw error;
            return await deps.readFile(fallback);
        }
    };

    const localFileExists = async (path: string): Promise<boolean> => {
        try {
            if (path.startsWith(deps.baseDataDir)) {
                return await deps.exists(toRelative(path), { baseDir: deps.dataBaseDir });
            }
            if (await deps.exists(normalizeAttachmentFsPath(path))) return true;
        } catch (error) {
            logSyncWarning(warningMessage, error);
        }
        const fallback = managedFallbackPath(path);
        if (!fallback) return false;
        try {
            return await deps.exists(fallback);
        } catch (error) {
            logSyncWarning(warningMessage, error);
            return false;
        }
    };

    return { readLocalFile, localFileExists };
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

export const resolveFileBackendPath = async (
    join: (...paths: string[]) => Promise<string>,
    baseDir: string,
    relativePath: string,
): Promise<string> => {
    const segments = relativePath
        .split(/[\\/]+/)
        .filter(Boolean);
    return segments.length > 0 ? await join(baseDir, ...segments) : baseDir;
};

export const isTempAttachmentFile = (name: string): boolean => {
    return name.includes('.tmp-') || name.endsWith('.tmp') || name.endsWith('.partial');
};
