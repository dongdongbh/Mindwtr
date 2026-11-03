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
import { normalizeAttachmentPathForUrl, rehomeManagedSubfolderPath } from './attachment-paths';

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

        }
    }

    return fallbackHashString(value);
};

export const fallbackHashString = (value: string): string => {

    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
        hash = Math.imul(31, hash) + value.charCodeAt(i);
        hash |= 0;
    }
    return (hash >>> 0).toString(16);
};


const RENDERER_YIELD_TIMEOUT_MS = 100;

export const yieldToRenderer = async (): Promise<'frame' | 'timer'> => {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (by: 'frame' | 'timer') => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(by);
            };
            const timer = setTimeout(() => finish('timer'), RENDERER_YIELD_TIMEOUT_MS);
            window.requestAnimationFrame(() => finish('frame'));
        });
    }
    await sleep(0);
    return 'timer';
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

const isPathWithin = (dir: string, path: string, ignoreCase = false): boolean => {
    let root = normalizeAttachmentFsPath(dir).replace(/\/+$/, '');
    if (ignoreCase) {
        root = root.toLowerCase();
        path = path.toLowerCase();
    }
    return Boolean(root) && (path === root || path.startsWith(`${root}/`));
};


const isCaseInsensitiveDataDir = (osDataDir: string): boolean =>
    /^([A-Za-z]:\/|\/\/)/.test(osDataDir) || osDataDir.includes('/Library/Application Support');


const ATTACHMENT_SOURCE_DIR_NAMES = [ATTACHMENTS_DIR_NAME, 'audio-captures', 'quick-add-images'];


const LEGACY_SHARED_DOWNLOAD_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[A-Za-z0-9]{1,16})?$/i;


export const createManagedAttachmentSourcePredicate = async (): Promise<(localPath: string) => boolean> => {
    const { dataDir } = await import('@tauri-apps/api/path');
    const { getManagedDataDir } = await import('./managed-paths');
    const { logWarn } = await import('./app-log');
    const [osDataDir, managedDataDir] = await Promise.all([dataDir(), getManagedDataDir()]);
    const trimRoot = (dir: string) => normalizeAttachmentFsPath(dir).replace(/\/+$/, '');
    const osProfile = trimRoot(osDataDir) ? `${trimRoot(osDataDir)}/mindwtr` : '';
    const profileRoots = [trimRoot(managedDataDir), osProfile, osProfile && `${osProfile}/data`]
        .filter(Boolean);
    const allowedDirs = profileRoots.flatMap((root) => ATTACHMENT_SOURCE_DIR_NAMES.map((name) => `${root}/${name}`));


    const legacySharedDir = trimRoot(osDataDir) ? `${trimRoot(osDataDir)}/${ATTACHMENTS_DIR_NAME}` : '';
    const ignoreCase = isCaseInsensitiveDataDir(trimRoot(osDataDir));
    const isLegacySharedDownload = (path: string): boolean => {
        if (!legacySharedDir || !isPathWithin(legacySharedDir, path, ignoreCase)) return false;
        const rest = path.slice(legacySharedDir.length + 1);
        return LEGACY_SHARED_DOWNLOAD_NAME.test(rest);
    };
    let refusalLogged = false;
    return (localPath: string): boolean => {
        const normalized = normalizeAttachmentFsPath(stripFileScheme(localPath));
        const reason = normalized.split('/').some((segment) => segment === '.' || segment === '..')
            ? 'dot-segment'
            : allowedDirs.some((dir) => isPathWithin(dir, normalized, ignoreCase)) || isLegacySharedDownload(normalized)
                ? null
                : 'outside-attachment-folders';
        if (!reason) return true;
        if (!refusalLogged) {
            refusalLogged = true;
            void logWarn('Attachment upload refused for a path outside the attachment folders', {
                scope: 'sync',
                extra: { releaseCheck: 'v1.3.5/attachment-source-guard', reason },
            });
        }
        return false;
    };
};


export const createLocalAttachmentFs = (
    logSyncWarning: (message: string, error?: unknown) => void,
    deps: {
        baseDataDir: string;
        dataBaseDir: any;
        exists: (path: string, options?: { baseDir: any }) => Promise<boolean>;
        readFile: (path: string, options?: { baseDir: any }) => Promise<Uint8Array>;


        managedAttachmentsDir?: string;


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


    const managedFallbackPaths = (path: string, attachment: Pick<Attachment, 'id'>): string[] => {
        if (!deps.managedAttachmentsDir) return [];
        const normalized = normalizeAttachmentFsPath(path);
        const dir = normalizeAttachmentFsPath(deps.managedAttachmentsDir).replace(/\/+$/, '');
        const managedDataDir = dir.slice(0, dir.lastIndexOf('/'));
        const candidates: string[] = [];
        const rehomed = managedDataDir ? rehomeManagedSubfolderPath(normalized, managedDataDir) : null;
        if (rehomed) candidates.push(rehomed);
        const fileName = normalized.split('/').pop();
        if (fileName && (fileName === attachment.id || fileName.startsWith(`${attachment.id}.`))) {
            const byId = `${dir}/${fileName}`;
            if (byId !== normalized && !candidates.includes(byId)) candidates.push(byId);
        }
        return candidates;
    };

    const readLocalFile = async (
        path: string,
        attachment: Pick<Attachment, 'id'>,
    ): Promise<Uint8Array> => {
        try {
            if (isWithinDataDir(path)) {
                return await deps.readFile(toRelative(path), { baseDir: deps.dataBaseDir });
            }
            return await deps.readFile(normalizeAttachmentFsPath(path));
        } catch (error) {
            for (const fallback of managedFallbackPaths(path, attachment)) {
                try {
                    return await deps.readFile(fallback);
                } catch {

                }
            }
            throw error;
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
        for (const fallback of managedFallbackPaths(path, attachment)) candidates.push({ path: fallback });

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
            try {
                if (isWithinDataDir(path)) {
                    return toStat(await deps.stat(toRelative(path), { baseDir: deps.dataBaseDir }));
                }
                return toStat(await deps.stat(normalizeAttachmentFsPath(path)));
            } catch (error) {
                for (const fallback of managedFallbackPaths(path, attachment)) {
                    try {
                        return toStat(await deps.stat(fallback));
                    } catch {

                    }
                }
                throw error;
            }
        } catch (error) {
            logSyncWarning(warningMessage, error);
            return null;
        }
    };

    return { readLocalFile, localFilePresence, localFileExists, statLocalFile };
};

const ATTACHMENT_TEMP_FILE_PREFIX = '.mindwtr-attachment-write-';

const buildTempPath = (relativePath: string): string => {
    const separatorIndex = Math.max(relativePath.lastIndexOf('/'), relativePath.lastIndexOf('\\'));
    const parent = separatorIndex >= 0 ? relativePath.slice(0, separatorIndex + 1) : '';
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`;
    return `${parent}${ATTACHMENT_TEMP_FILE_PREFIX}${suffix}.tmp`;
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
    if (relativePath.includes('\0') || segments.some((segment) => segment === '..')) {
        throw new Error(`Refusing attachment path outside the sync folder: ${JSON.stringify(relativePath)}`);
    }
    return segments.length > 0 ? await join(baseDir, ...segments) : baseDir;
};

export const isTempAttachmentFile = (name: string): boolean => {
    return /^\.mindwtr-attachment-write-[0-9a-z]+-[0-9a-f]{12}\.tmp$/.test(name);
};
