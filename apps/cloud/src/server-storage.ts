import {
    closeSync,
    existsSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmdirSync,
    unlinkSync,
    writeFileSync,
} from 'fs';
import { createHash, randomBytes } from 'crypto';
import { basename, dirname, join, relative, resolve, sep } from 'path';
import { sleep, type AppData } from '@mindwtr/core';
import {
    ATTACHMENT_PATH_ALLOWLIST,
    ATTACHMENT_PATH_MAX_LENGTH,
    ATTACHMENT_PATH_MAX_SEGMENTS,
    CLOUD_DATA_LOCK_WAIT_TIMEOUT_MS,
    logError,
} from './server-config';

export type RequestAbortError = Error & {
    status: number;
};

type BodyReadError = {
    __mindwtrError: {
        message: string;
        status: number;
    };
};

export type WriteLockRunner = {
    <T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
    getPendingLockCount: () => number;
};

export type DurableFileSystem = {
    openSync: (path: string, flags: 'r' | 'wx', mode?: number) => number;
    writeFileSync: (handle: number, data: string | Uint8Array) => void;
    fsyncSync: (handle: number) => void;
    closeSync: (handle: number) => void;
    renameSync: (source: string, destination: string) => void;
    existsSync: (path: string) => boolean;
    unlinkSync: (path: string) => void;
};

export type DurableDirectoryFileSystem = {
    lstatSync: (path: string) => {
        isDirectory: () => boolean;
        isSymbolicLink: () => boolean;
    };
    mkdirSync: (path: string, options?: { mode?: number }) => void;
    realpathSync: (path: string) => string;
    openSync: (path: string, flags: 'r') => number;
    fsyncSync: (handle: number) => void;
    closeSync: (handle: number) => void;
};

type DurableDirectorySyncFileSystem = Pick<
    DurableDirectoryFileSystem,
    'openSync' | 'fsyncSync' | 'closeSync'
>;

export type DurableRemovalFileSystem = DurableDirectorySyncFileSystem & {
    existsSync: (path: string) => boolean;
    unlinkSync: (path: string) => void;
    rmdirSync: (path: string) => void;
};

export type WritableDirectoryProbeFileSystem = {
    openSync: (path: string, flags: 'wx', mode?: number) => number;
    writeFileSync: (handle: number, data: string | Uint8Array) => void;
    fsyncSync: (handle: number) => void;
    closeSync: (handle: number) => void;
    unlinkSync: (path: string) => void;
};

type WritableDirectoryProbeOptions = {
    directoryFileSystem?: DurableDirectoryFileSystem;
    probeFileSystem?: WritableDirectoryProbeFileSystem;
    createProbeId?: () => string;
};

const nodeDurableFileSystem: DurableFileSystem = {
    openSync: (path, flags, mode) => openSync(path, flags, mode),
    writeFileSync: (handle, data) => writeFileSync(handle, data),
    fsyncSync,
    closeSync,
    renameSync,
    existsSync,
    unlinkSync,
};

const nodeDurableDirectoryFileSystem: DurableDirectoryFileSystem = {
    lstatSync,
    mkdirSync: (path, options) => mkdirSync(path, options),
    realpathSync,
    openSync: (path, flags) => openSync(path, flags),
    fsyncSync,
    closeSync,
};

const nodeDurableRemovalFileSystem: DurableRemovalFileSystem = {
    existsSync,
    unlinkSync,
    rmdirSync,
    openSync: (path, flags) => openSync(path, flags),
    fsyncSync,
    closeSync,
};

const nodeWritableDirectoryProbeFileSystem: WritableDirectoryProbeFileSystem = {
    openSync: (path, flags, mode) => openSync(path, flags, mode),
    writeFileSync: (handle, data) => writeFileSync(handle, data),
    fsyncSync,
    closeSync,
    unlinkSync,
};

const createDefaultData = (): AppData => ({ tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} });

const isObjectRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

const toAppDataShape = (value: unknown): AppData | null => {
    if (!isObjectRecord(value)) return null;
    if (!Array.isArray(value.tasks) || !Array.isArray(value.projects)) return null;
    return {
        tasks: value.tasks as AppData['tasks'],
        projects: value.projects as AppData['projects'],
        sections: Array.isArray(value.sections) ? value.sections as AppData['sections'] : [],
        areas: Array.isArray(value.areas) ? value.areas as AppData['areas'] : [],
        people: Array.isArray(value.people) ? value.people as AppData['people'] : [],
        settings: (isObjectRecord(value.settings) ? value.settings : {}) as AppData['settings'],
    };
};

export function createRequestAbortError(message: string, status = 408): RequestAbortError {
    const error = new Error(message) as RequestAbortError;
    error.name = 'RequestAbortError';
    error.status = status;
    return error;
}

export function isRequestAbortError(error: unknown): error is RequestAbortError {
    return error instanceof Error
        && error.name === 'RequestAbortError'
        && typeof (error as { status?: unknown }).status === 'number';
}

function resolveRequestAbortError(signal: AbortSignal, fallbackMessage: string, fallbackStatus = 408): RequestAbortError {
    const reason = signal.reason;
    if (isRequestAbortError(reason)) {
        return reason;
    }
    if (reason instanceof Error) {
        const error = reason as RequestAbortError;
        error.name = 'RequestAbortError';
        error.status = typeof error.status === 'number' ? error.status : fallbackStatus;
        return error;
    }
    return createRequestAbortError(fallbackMessage, fallbackStatus);
}

export function throwIfRequestAborted(signal?: AbortSignal, fallbackMessage = 'Request timed out'): void {
    if (!signal?.aborted) return;
    throw resolveRequestAbortError(signal, fallbackMessage);
}

function createBodyReadError(message: string, status: number): BodyReadError {
    return {
        __mindwtrError: {
            message,
            status,
        },
    };
}

export function isBodyReadError(value: unknown): value is BodyReadError {
    return isObjectRecord(value)
        && isObjectRecord(value.__mindwtrError)
        && typeof value.__mindwtrError.message === 'string'
        && typeof value.__mindwtrError.status === 'number';
}

function decodeAttachmentPath(rawPath: string): string | null {
    try {
        const decoded = decodeURIComponent(rawPath);
        if (decoded.includes('%')) {
            return null;
        }
        return decoded;
    } catch {
        return null;
    }
}

function isPathWithinRoot(pathValue: string, rootPath: string): boolean {
    return pathValue === rootPath || pathValue.startsWith(`${rootPath}${sep}`);
}

export { isPathWithinRoot };

function isFsErrorWithCode(error: unknown, code: string): boolean {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && (error as { code?: unknown }).code === code;
}

// S9: node fs errors embed the absolute path in .message (e.g. "ENOENT: no such
// file or directory, lstat '/data/<namespace-key>/attachments/...'"). Callers that
// surface removal/GC failures to a response body must use the short .code instead
// (e.g. 'ENOENT', 'EIO') — never .message, and never the error object itself.
export function getFsErrorCode(error: unknown): string {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : 'unknown';
}

/**
 * Walks each path segment from `rootRealPath` down to `targetDir`, rejecting any
 * symlink escape along the way. With `create: true` (the default; used by attachment
 * writes) missing segments are created as plain directories. With `create: false`
 * (used by read-only attachment access — see `resolveAttachmentPath`) a missing
 * segment stops the walk and returns `true` without creating anything: nothing exists
 * below that point, so there is no symlink to escape through, and the caller treats
 * the unresolved remainder as "not found" rather than "invalid".
 */
function syncDirectoryEntryParent(
    parentPath: string,
    fileSystem: DurableDirectorySyncFileSystem,
): void {
    let handle: number | null = null;
    try {
        handle = fileSystem.openSync(parentPath, 'r');
        fileSystem.fsyncSync(handle);
        fileSystem.closeSync(handle);
        handle = null;
    } finally {
        if (handle !== null) {
            try {
                fileSystem.closeSync(handle);
            } catch {
                // The durability failure remains authoritative.
            }
        }
    }
}

export function durablySyncDirectory(
    directoryPath: string,
    fileSystem: DurableDirectorySyncFileSystem = nodeDurableRemovalFileSystem,
): void {
    syncDirectoryEntryParent(directoryPath, fileSystem);
}

export type DurableRemovalOptions = {
    /**
     * Set false only when the caller removes several entries from the same
     * directory and durably syncs that directory itself once at the end (see
     * garbageCollectOrphanAttachments' batched GC pass) — otherwise every
     * per-entry removal keeps paying its own parent fsync, which is required
     * for a standalone removal like the single-file DELETE route to durably
     * acknowledge before responding. Defaults to true.
     */
    syncParent?: boolean;
};

function durablyRemoveEntry(
    targetPath: string,
    remove: (path: string) => void,
    fileSystem: DurableRemovalFileSystem,
    syncParent: boolean,
): boolean {
    const parentPath = dirname(targetPath);
    if (!fileSystem.existsSync(targetPath)) {
        // A preceding attempt may have made the removal visible but failed while
        // publishing the parent-directory change. Re-sync an existing parent so
        // an idempotent retry cannot acknowledge visibility as durability.
        if (syncParent && fileSystem.existsSync(parentPath)) {
            syncDirectoryEntryParent(parentPath, fileSystem);
        }
        return false;
    }

    try {
        remove(targetPath);
    } catch (error) {
        if (!isFsErrorWithCode(error, 'ENOENT')) throw error;
        if (syncParent && fileSystem.existsSync(parentPath)) {
            syncDirectoryEntryParent(parentPath, fileSystem);
        }
        return false;
    }
    if (syncParent) syncDirectoryEntryParent(parentPath, fileSystem);
    return true;
}

export function durablyRemoveFile(
    targetPath: string,
    fileSystem: DurableRemovalFileSystem = nodeDurableRemovalFileSystem,
    options: DurableRemovalOptions = {},
): boolean {
    return durablyRemoveEntry(targetPath, (path) => fileSystem.unlinkSync(path), fileSystem, options.syncParent ?? true);
}

export function durablyRemoveDirectory(
    targetPath: string,
    fileSystem: DurableRemovalFileSystem = nodeDurableRemovalFileSystem,
    options: DurableRemovalOptions = {},
): boolean {
    return durablyRemoveEntry(targetPath, (path) => fileSystem.rmdirSync(path), fileSystem, options.syncParent ?? true);
}

export function ensureDirectoryWithinRoot(
    rootRealPath: string,
    targetDir: string,
    create = true,
    fileSystem: DurableDirectoryFileSystem = nodeDurableDirectoryFileSystem,
): boolean {
    if (!isPathWithinRoot(targetDir, rootRealPath)) return false;
    const rel = relative(rootRealPath, targetDir);
    if (!rel || rel === '.') return true;
    const segments = rel.split(/[\\/]+/).filter(Boolean);
    let currentPath = rootRealPath;

    for (const segment of segments) {
        const parentPath = currentPath;
        currentPath = join(currentPath, segment);
        try {
            const stat = fileSystem.lstatSync(currentPath);
            if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
        } catch (error) {
            if (!isFsErrorWithCode(error, 'ENOENT')) throw error;
            if (!create) return true;
            try {
                fileSystem.mkdirSync(currentPath, { mode: 0o700 });
            } catch (mkdirError) {
                if (!isFsErrorWithCode(mkdirError, 'EEXIST')) throw mkdirError;
            }
            const stat = fileSystem.lstatSync(currentPath);
            if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
        }

        const currentRealPath = fileSystem.realpathSync(currentPath);
        if (!isPathWithinRoot(currentRealPath, rootRealPath)) return false;
        // Persist the child entry itself, not only files later written inside
        // it. Re-syncing an existing segment also makes a retry safe after a
        // prior parent fsync failed while leaving the directory visible.
        if (create) syncDirectoryEntryParent(parentPath, fileSystem);
    }

    return true;
}

/**
 * Creates a directory tree from its nearest existing ancestor and durably
 * publishes every new directory entry before returning its canonical path.
 * Unsafe non-directory/symlink shapes return null; filesystem and durability
 * failures throw so request handlers can classify them as retryable 5xx.
 */
export function ensureDurableDirectory(
    targetDir: string,
    fileSystem: DurableDirectoryFileSystem = nodeDurableDirectoryFileSystem,
): string | null {
    const absoluteTarget = resolve(targetDir);
    let existingAncestor = absoluteTarget;

    while (true) {
        try {
            const entry = fileSystem.lstatSync(existingAncestor);
            const existingRealPath = fileSystem.realpathSync(existingAncestor);
            const realEntry = entry.isSymbolicLink()
                ? fileSystem.lstatSync(existingRealPath)
                : entry;
            if (realEntry.isSymbolicLink() || !realEntry.isDirectory()) return null;

            const relativeTarget = relative(existingAncestor, absoluteTarget);
            if (!relativeTarget || relativeTarget === '.') {
                // The target already existed when this call began, so nothing was
                // created — there is no new directory entry to publish. This is the
                // hot path (every lock acquisition, every GET/HEAD /v1/data), so it
                // must not pay a durability barrier; only first creation (below) does.
                // A crash between a prior call's mkdir and its parent fsync either
                // left the entry durable (nothing to fix) or drops it on a real
                // crash/reboot, which self-heals via ENOENT below on the next call.
                return existingRealPath;
            }
            const canonicalTarget = resolve(existingRealPath, relativeTarget);
            if (!ensureDirectoryWithinRoot(
                existingRealPath,
                canonicalTarget,
                true,
                fileSystem,
            )) return null;
            return fileSystem.realpathSync(canonicalTarget);
        } catch (error) {
            if (!isFsErrorWithCode(error, 'ENOENT')) throw error;
            const parent = dirname(existingAncestor);
            if (parent === existingAncestor) throw error;
            existingAncestor = parent;
        }
    }
}

export function normalizeAttachmentRelativePath(rawPath: string): string | null {
    const decoded = decodeAttachmentPath(rawPath);
    if (!decoded) return null;
    if (!decoded || decoded.length > ATTACHMENT_PATH_MAX_LENGTH || !ATTACHMENT_PATH_ALLOWLIST.test(decoded)) {
        return null;
    }
    const normalized = decoded.replace(/^\/+|\/+$/g, '');
    if (!normalized) return null;
    const segments = normalized.split('/').filter(Boolean);
    if (segments.length === 0 || segments.length > ATTACHMENT_PATH_MAX_SEGMENTS) return null;
    if (segments.some((segment) => segment === '.' || segment === '..')) {
        return null;
    }
    return segments.join('/');
}

/**
 * `create` must be `true` only for PUT. GET and DELETE resolve with `create: false`
 * so an unknown token can never plant `<dataDir>/<key>/attachments` on disk merely by
 * reading or deleting — that side effect used to double as an undocumented namespace
 * creation, permanently exempting the token from `ensureNamespaceWriteAllowed` and
 * consuming a slot in `maxAnyTokenNamespaces` without ever writing data.
 */
export function resolveAttachmentPath(
    dataDir: string,
    key: string,
    rawPath: string,
    options: { create: boolean }
): { rootRealPath: string; filePath: string } | null {
    const relativePath = normalizeAttachmentRelativePath(rawPath);
    if (!relativePath) return null;
    const dataRoot = resolve(dataDir);
    let dataRootRealPath: string;
    if (options.create) {
        const durableDataRoot = ensureDurableDirectory(dataRoot);
        if (!durableDataRoot) return null;
        dataRootRealPath = durableDataRoot;
    } else if (!existsSync(dataRoot)) {
        return null;
    } else {
        dataRootRealPath = realpathSync(dataRoot);
    }
    const rootDir = resolve(join(dataRootRealPath, key, 'attachments'));
    if (!ensureDirectoryWithinRoot(dataRootRealPath, rootDir, options.create)) return null;
    // rootDir may not exist yet when options.create is false (nothing was ever
    // uploaded for this key) — that's the whole point, so fall back to the
    // unresolved path rather than realpathSync-ing a directory that isn't there.
    const rootRealPath = existsSync(rootDir) ? realpathSync(rootDir) : rootDir;
    if (!isPathWithinRoot(rootRealPath, dataRootRealPath)) return null;
    const filePath = resolve(join(rootRealPath, relativePath));
    if (!isPathWithinRoot(filePath, rootRealPath)) return null;
    return { rootRealPath, filePath };
}

export function pathContainsSymlink(rootRealPath: string, targetPath: string): boolean {
    if (!isPathWithinRoot(targetPath, rootRealPath)) return true;
    const rel = relative(rootRealPath, targetPath);
    if (!rel || rel === '.') return false;
    const segments = rel.split(/[\\/]+/).filter(Boolean);
    let currentPath = rootRealPath;
    for (const segment of segments) {
        currentPath = join(currentPath, segment);
        if (!existsSync(currentPath)) continue;
        try {
            const stat = lstatSync(currentPath);
            if (stat.isSymbolicLink()) return true;
        } catch {
            return true;
        }
    }
    return false;
}

export function durablyPublishFile(
    destinationPath: string,
    data: string | Uint8Array,
    options: {
        beforeRename?: (tempPath: string) => boolean;
        fileSystem?: DurableFileSystem;
        tempName?: string;
    } = {},
): boolean {
    const parentPath = dirname(destinationPath);
    const fileSystem = options.fileSystem ?? nodeDurableFileSystem;
    const tempName = options.tempName
        ?? `.${basename(destinationPath)}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
    if (basename(tempName) !== tempName) {
        throw new Error('Durable publication temp name must not contain a path');
    }
    const tempPath = join(parentPath, tempName);
    let tempHandle: number | null = null;

    try {
        tempHandle = fileSystem.openSync(tempPath, 'wx', 0o600);
        fileSystem.writeFileSync(tempHandle, data);
        fileSystem.fsyncSync(tempHandle);
        fileSystem.closeSync(tempHandle);
        tempHandle = null;

        if (options.beforeRename && !options.beforeRename(tempPath)) {
            return false;
        }

        fileSystem.renameSync(tempPath, destinationPath);

        let parentHandle: number | null = null;
        try {
            parentHandle = fileSystem.openSync(parentPath, 'r');
            fileSystem.fsyncSync(parentHandle);
            fileSystem.closeSync(parentHandle);
            parentHandle = null;
        } finally {
            if (parentHandle !== null) {
                try {
                    fileSystem.closeSync(parentHandle);
                } catch {
                    // The original durability-stage error is more actionable.
                }
            }
        }
        return true;
    } finally {
        if (tempHandle !== null) {
            try {
                fileSystem.closeSync(tempHandle);
            } catch {
                // The original durability-stage error is more actionable.
            }
        }
        if (fileSystem.existsSync(tempPath)) {
            try {
                fileSystem.unlinkSync(tempPath);
            } catch {
                // Best-effort cleanup; the failed publication is still rejected.
            }
        }
    }
}

export function writeAttachmentFileSafely(rootRealPath: string, filePath: string, body: Uint8Array): boolean {
    const parentPath = dirname(filePath);
    if (!ensureDirectoryWithinRoot(rootRealPath, parentPath)) return false;
    if (pathContainsSymlink(rootRealPath, parentPath)) return false;
    const parentRealPath = realpathSync(parentPath);
    if (!isPathWithinRoot(parentRealPath, rootRealPath)) {
        return false;
    }

    const safeFilePath = join(parentRealPath, basename(filePath));
    if (existsSync(safeFilePath)) {
        const stat = lstatSync(safeFilePath);
        if (stat.isSymbolicLink()) {
            return false;
        }
        const realFilePath = realpathSync(safeFilePath);
        if (!isPathWithinRoot(realFilePath, rootRealPath)) {
            return false;
        }
    }

    return durablyPublishFile(safeFilePath, body, {
        tempName: `.mindwtr-upload-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
        beforeRename: (tempPath) => {
            const tempRealPath = realpathSync(tempPath);
            if (!isPathWithinRoot(tempRealPath, rootRealPath)) {
                return false;
            }
            if (pathContainsSymlink(rootRealPath, parentPath)) {
                return false;
            }
            const currentParentRealPath = realpathSync(parentPath);
            if (currentParentRealPath !== parentRealPath || !isPathWithinRoot(currentParentRealPath, rootRealPath)) {
                return false;
            }
            if (existsSync(safeFilePath)) {
                const stat = lstatSync(safeFilePath);
                if (stat.isSymbolicLink()) {
                    return false;
                }
                const currentRealFilePath = realpathSync(safeFilePath);
                if (!isPathWithinRoot(currentRealFilePath, rootRealPath)) {
                    return false;
                }
            }
            return true;
        },
    });
}

export function readData(filePath: string): AppData | null {
    try {
        const raw = readFileSync(filePath, 'utf8');
        return toAppDataShape(JSON.parse(raw));
    } catch {
        return null;
    }
}

function normalizeLoadedAreas(raw: AppData): AppData {
    const nowIso = new Date().toISOString();
    const normalizedAreas = raw.areas.map((area) => {
        if (!isObjectRecord(area)) return area;
        const createdAt = typeof area.createdAt === 'string' && area.createdAt.trim().length > 0
            ? area.createdAt
            : (typeof area.updatedAt === 'string' && area.updatedAt.trim().length > 0 ? area.updatedAt : nowIso);
            const updatedAt = typeof area.updatedAt === 'string' && area.updatedAt.trim().length > 0
                ? area.updatedAt
                : createdAt;
            return {
                ...area,
            createdAt,
            updatedAt,
        };
    }) as AppData['areas'];
    return {
        ...raw,
        areas: normalizedAreas,
    };
}

export type AppDataForWriteResult =
    | { state: 'ok'; data: AppData }
    | { state: 'unreadable' };

/**
 * Discriminates "no namespace document yet" (fine, callers write a fresh default) from
 * "the document exists but couldn't be read/parsed" (EIO/EACCES/corrupt JSON) so a write
 * path never mistakes the latter for an empty namespace and silently replaces real data —
 * see loadExistingDataForMerge in server.ts, which already does this for PUT /v1/data.
 */
export function loadAppDataForWriteUncached(filePath: string): AppDataForWriteResult {
    if (!existsSync(filePath)) return { state: 'ok', data: createDefaultData() };
    const raw = readData(filePath);
    if (!raw) return { state: 'unreadable' };
    return { state: 'ok', data: normalizeLoadedAreas(raw) };
}

// Raw, uncached disk read. server-data-cache.ts wraps this as the process-local-cached
// `loadAppData` that the rest of the server imports; this uncached name stays distinct
// so an import site can tell at a glance which one it's getting.
export function loadAppDataUncached(filePath: string): AppData {
    const result = loadAppDataForWriteUncached(filePath);
    return result.state === 'ok' ? result.data : createDefaultData();
}

export function writeData(filePath: string, data: unknown) {
    if (!ensureDurableDirectory(dirname(filePath))) {
        throw new Error('Cloud data directory is unsafe');
    }
    const serialized = JSON.stringify(data, null, 2);
    durablyPublishFile(filePath, serialized);
}

const CLOUD_LOCK_SHARD_COUNT = 64;

function getCloudLockPath(dataDir: string, key: string): string {
    const lockId = createHash('sha256').update(key).digest('hex');
    const shard = Number.parseInt(lockId.slice(0, 8), 16) % CLOUD_LOCK_SHARD_COUNT;
    return join(dataDir, '.locks', `shard-${shard.toString(16).padStart(2, '0')}.sqlite`);
}

const isSqliteBusyError = (error: unknown): boolean => {
    const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';
    const message = error instanceof Error ? error.message : String(error);
    return code === 'SQLITE_BUSY'
        || code === 'SQLITE_LOCKED'
        || /database is (?:busy|locked)/i.test(message);
};

const waitForCloudLockRetry = async (delayMs: number, signal?: AbortSignal): Promise<void> => {
    if (!signal) {
        await sleep(delayMs);
        return;
    }
    throwIfRequestAborted(signal);
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, delayMs);
        const onAbort = () => {
            clearTimeout(timeout);
            signal.removeEventListener('abort', onAbort);
            reject(resolveRequestAbortError(signal, 'Request timed out'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
};

async function withCloudFileLock<T>(
    dataDir: string,
    key: string,
    fn: () => Promise<T>,
    signal?: AbortSignal,
): Promise<T> {
    throwIfRequestAborted(signal);
    const lockPath = getCloudLockPath(dataDir, key);
    if (!ensureDurableDirectory(dirname(lockPath))) {
        throw new Error('Cloud lock directory is unsafe');
    }
    const startedAt = Date.now();
    let attempt = 0;
    const { Database } = await import('bun:sqlite');
    let lockDatabase: InstanceType<typeof Database> | null = null;

    while (true) {
        throwIfRequestAborted(signal);
        const candidate = new Database(lockPath);
        try {
            // Poll with a zero SQLite busy timeout instead of blocking Bun's event
            // loop. BEGIN IMMEDIATE is an OS-backed process lock; the kernel drops
            // it when a process crashes, so there is no stale lease to unlink.
            candidate.exec('PRAGMA busy_timeout = 0;');
            candidate.exec('BEGIN IMMEDIATE;');
            lockDatabase = candidate;
            break;
        } catch (error) {
            candidate.close();
            if (!isSqliteBusyError(error)) throw error;
            if (Date.now() - startedAt > CLOUD_DATA_LOCK_WAIT_TIMEOUT_MS) {
                throw new Error('Timed out waiting for cloud data lock');
            }
            attempt += 1;
            await waitForCloudLockRetry(Math.min(1000, 25 * attempt), signal);
        }
    }

    try {
        throwIfRequestAborted(signal);
        return await fn();
    } finally {
        try {
            lockDatabase?.exec('ROLLBACK;');
        } catch {
            // Closing the connection below still releases the OS lock.
        } finally {
            lockDatabase?.close();
        }
    }
}

export function ensureWritableDir(
    dirPath: string,
    options: WritableDirectoryProbeOptions = {},
): boolean {
    const directoryFileSystem = options.directoryFileSystem ?? nodeDurableDirectoryFileSystem;
    const probeFileSystem = options.probeFileSystem ?? nodeWritableDirectoryProbeFileSystem;
    const createProbeId = options.createProbeId ?? (() => randomBytes(16).toString('hex'));
    let probeHandle: number | null = null;
    let probePath: string | null = null;
    let ownsProbe = false;
    let writable = false;

    try {
        const durableDirPath = ensureDurableDirectory(dirPath, directoryFileSystem);
        if (durableDirPath) {
            probePath = join(durableDirPath, `.mindwtr-write-probe-${createProbeId()}.tmp`);
            probeHandle = probeFileSystem.openSync(probePath, 'wx', 0o600);
            ownsProbe = true;
            probeFileSystem.writeFileSync(probeHandle, 'ok');
            probeFileSystem.fsyncSync(probeHandle);
            writable = true;
        }
    } catch {
        writable = false;
    } finally {
        if (probeHandle !== null) {
            try {
                probeFileSystem.closeSync(probeHandle);
            } catch {
                writable = false;
            }
        }
        if (ownsProbe && probePath !== null) {
            try {
                probeFileSystem.unlinkSync(probePath);
            } catch {
                writable = false;
            }
        }
    }

    if (!writable) {
        logError('cloud data directory is not writable', {
            failureClass: 'filesystem',
            failureCode: 'data_dir_not_writable',
        });
    }
    return writable;
}

export async function readRequestBytes(
    req: Request,
    maxBodyBytes: number,
    signal?: AbortSignal,
): Promise<Uint8Array | BodyReadError> {
    const contentLength = Number(req.headers.get('content-length') || '0');
    if (contentLength && contentLength > maxBodyBytes) {
        return createBodyReadError('Payload too large', 413);
    }
    const stream = req.body;
    if (!stream) {
        return new Uint8Array();
    }
    try {
        throwIfRequestAborted(signal);
        const reader = stream.getReader();
        const chunks: Uint8Array[] = [];
        let totalLength = 0;
        const onAbort = signal
            ? () => {
                void reader.cancel(resolveRequestAbortError(signal, 'Request timed out')).catch(() => undefined);
            }
            : null;
        if (signal && onAbort) {
            signal.addEventListener('abort', onAbort, { once: true });
        }
        try {
            while (true) {
                throwIfRequestAborted(signal);
                const { done, value } = await reader.read();
                if (done) break;
                if (!value || value.length === 0) continue;
                totalLength += value.length;
                if (totalLength > maxBodyBytes) {
                    await reader.cancel().catch(() => undefined);
                    return createBodyReadError('Payload too large', 413);
                }
                chunks.push(value);
            }
        } finally {
            if (signal && onAbort) {
                signal.removeEventListener('abort', onAbort);
            }
        }
        // reader.cancel() resolves a pending read as { done: true } instead of
        // throwing, so recheck the request signal before treating partial bytes
        // as a complete body.
        throwIfRequestAborted(signal);

        if (chunks.length === 0) {
            return new Uint8Array();
        }
        if (chunks.length === 1) {
            return chunks[0];
        }
        const merged = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.length;
        }
        return merged;
    } catch (error) {
        if (signal?.aborted) {
            const requestAbortError = resolveRequestAbortError(signal, 'Request timed out');
            return createBodyReadError(requestAbortError.message, requestAbortError.status);
        }
        throw error;
    }
}

export async function readJsonBody(req: Request, maxBodyBytes: number, signal?: AbortSignal): Promise<unknown> {
    const bytes = await readRequestBytes(req, maxBodyBytes, signal);
    if (isBodyReadError(bytes)) {
        return bytes;
    }
    const text = new TextDecoder().decode(bytes);
    if (!text.trim()) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

export function createWriteLockRunner(dataDir?: string): WriteLockRunner {
    const writeLocks = new Map<string, Promise<void>>();
    const withWriteLock = async <T>(key: string, fn: () => Promise<T>, signal?: AbortSignal) => {
        const current = writeLocks.get(key) ?? Promise.resolve();
        let removeQueuedAbortListener: () => void = () => undefined;
        const abortBeforeStart = signal
            ? new Promise<never>((_resolve, reject) => {
                const onAbort = () => reject(resolveRequestAbortError(signal, 'Request timed out'));
                removeQueuedAbortListener = () => signal.removeEventListener('abort', onAbort);
                if (signal.aborted) {
                    onAbort();
                } else {
                    signal.addEventListener('abort', onAbort, { once: true });
                }
            })
            : null;
        const run = current.catch(() => undefined).then(() => {
            removeQueuedAbortListener();
            throwIfRequestAborted(signal);
            return dataDir ? withCloudFileLock(dataDir, key, fn, signal) : fn();
        });
        const queueTail = run.then(() => undefined, () => undefined);
        writeLocks.set(key, queueTail);
        void queueTail.then(() => {
            if (writeLocks.get(key) === queueTail) {
                writeLocks.delete(key);
            }
        });
        if (abortBeforeStart) {
            return Promise.race([run, abortBeforeStart]);
        }
        return run;
    };
    withWriteLock.getPendingLockCount = () => writeLocks.size;
    return withWriteLock;
}
