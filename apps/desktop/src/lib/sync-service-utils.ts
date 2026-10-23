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

// A hidden or covered window gets no animation frames, so a timer ends the wait there;
// otherwise a sync run started while the window is hidden never continues (#1392).
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

// Windows (drive letter or UNC) and macOS (~/Library/Application Support) file systems
// ignore case by default; Linux file systems do not.
const isCaseInsensitiveDataDir = (osDataDir: string): boolean =>
    /^([A-Za-z]:\/|\/\/)/.test(osDataDir) || osDataDir.includes('/Library/Application Support');

// Every folder desktop has ever written attachment bytes into: imports, dropped
// files and sync downloads (attachments), recordings (audio-captures) and pasted
// images (quick-add-images).
const ATTACHMENT_SOURCE_DIR_NAMES = [ATTACHMENTS_DIR_NAME, 'audio-captures', 'quick-add-images'];

// Sync downloads in the old shared folder were named `<attachment id><ext>` (ids are UUIDs).
const LEGACY_SHARED_DOWNLOAD_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[A-Za-z0-9]{1,16})?$/i;

/**
 * SEC-07: which local paths this device may read bytes from for sync. An attachment `uri`
 * travels inside the synced document and an absolute path there survives the merge
 * sanitizer, so without this a hostile sync document makes the next cycle upload an
 * arbitrary local file to the remote. Every file attachment desktop creates is written
 * into one of {@link ATTACHMENT_SOURCE_DIR_NAMES}; files the user merely points at are
 * `kind: 'link'` and never reach the transfer loop.
 *
 * Only those folders are allowed, never the OS data dir or the profile root: on
 * Windows/macOS `config/secrets.toml` lives in the profile next to them. The roots are
 * the managed data dir (portable-aware, #855), the flat OS profile `<data>/mindwtr`
 * (paths recorded before #1245 moved folders into `data/`; quick-add-images never moved)
 * and the installed profile's `data/` (a portable copy sharing its paths), plus Mindwtr-named
 * downloads in the old shared `<data>/attachments` folder that sync used before 02a9aafa2.
 */
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
    // The old shared folder has a generic name other apps may use too, so only a direct
    // child named like a Mindwtr download (`<attachment uuid>.<ext>`) qualifies there.
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

    // Paths that no longer resolve where they were recorded, most specific first:
    // #1245 re-homing (an installed profile's folders moved down into `data/`),
    // then the #1038 rule (a portable profile travelled, the file moved along
    // inside attachments/ under its id name). Only consulted after the recorded
    // path fails — read, stat and presence must agree, because an attachment that
    // presence calls "present" while stat cannot reach it blocks every remote write.
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
                    // Try the next candidate; the recorded-path error is the one to report.
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
                        // Try the next candidate; the recorded-path error is the one to report.
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
    return /^\.mindwtr-attachment-write-[0-9a-z]+-[0-9a-f]{12}\.tmp$/.test(name);
};
