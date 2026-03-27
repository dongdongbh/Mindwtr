import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from 'fs';
import { basename, dirname, join, relative, resolve, sep } from 'path';
import type { AppData, Task } from '@mindwtr/core';
import {
    ATTACHMENT_PATH_ALLOWLIST,
    CLOUD_DATA_LOCK_REFRESH_MS,
    CLOUD_DATA_LOCK_TTL_MS,
    CLOUD_DATA_LOCK_WAIT_TIMEOUT_MS,
    logError,
} from './server-config';

type CloudFileLock = {
    owner: string;
    acquiredAt: number;
    heartbeatAt: number;
};

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
    <T>(key: string, fn: () => Promise<T>): Promise<T>;
    getPendingLockCount: () => number;
};

const DEFAULT_DATA: AppData = { tasks: [], projects: [], sections: [], areas: [], settings: {} };

const isObjectRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

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

export function normalizeAttachmentRelativePath(rawPath: string): string | null {
    const decoded = decodeAttachmentPath(rawPath);
    if (!decoded) return null;
    if (!decoded || !ATTACHMENT_PATH_ALLOWLIST.test(decoded)) {
        return null;
    }
    const normalized = decoded.replace(/^\/+|\/+$/g, '');
    if (!normalized) return null;
    const segments = normalized.split('/').filter(Boolean);
    if (segments.length === 0) return null;
    if (segments.some((segment) => segment === '.' || segment === '..')) {
        return null;
    }
    return segments.join('/');
}

export function resolveAttachmentPath(
    dataDir: string,
    key: string,
    rawPath: string
): { rootRealPath: string; filePath: string } | null {
    const relativePath = normalizeAttachmentRelativePath(rawPath);
    if (!relativePath) return null;
    const rootDir = resolve(join(dataDir, key, 'attachments'));
    mkdirSync(rootDir, { recursive: true });
    const rootRealPath = realpathSync(rootDir);
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

export function writeAttachmentFileSafely(rootRealPath: string, filePath: string, body: Uint8Array): boolean {
    mkdirSync(dirname(filePath), { recursive: true });
    const parentPath = dirname(filePath);
    if (pathContainsSymlink(rootRealPath, parentPath)) {
        return false;
    }
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

    const tempPath = join(
        parentRealPath,
        `.mindwtr-upload-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
    );
    let tempExists = false;
    try {
        writeFileSync(tempPath, body, { flag: 'wx', mode: 0o600 });
        tempExists = true;
        const tempRealPath = realpathSync(tempPath);
        if (!isPathWithinRoot(tempRealPath, rootRealPath)) {
            return false;
        }
        renameSync(tempPath, safeFilePath);
        tempExists = false;
        return true;
    } finally {
        if (tempExists && existsSync(tempPath)) {
            try {
                unlinkSync(tempPath);
            } catch {
                // Best-effort cleanup for temp files.
            }
        }
    }
}

export function readData(filePath: string): any | null {
    try {
        const raw = readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

export function loadAppData(filePath: string): AppData {
    const raw = readData(filePath);
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_DATA };
    const record = raw as Record<string, unknown>;
    const nowIso = new Date().toISOString();
    const normalizedAreas = Array.isArray(record.areas)
        ? (record.areas as unknown[]).map((area) => {
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
        })
        : [];
    return {
        tasks: Array.isArray(record.tasks) ? (record.tasks as Task[]) : [],
        projects: Array.isArray(record.projects) ? (record.projects as any) : [],
        sections: Array.isArray(record.sections) ? (record.sections as any) : [],
        areas: normalizedAreas as any,
        settings: typeof record.settings === 'object' && record.settings ? (record.settings as any) : {},
    };
}

export function writeData(filePath: string, data: unknown) {
    mkdirSync(dirname(filePath), { recursive: true });
    const serialized = JSON.stringify(data, null, 2);
    const tempPath = join(
        dirname(filePath),
        `.${basename(filePath)}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
    );
    let tempExists = false;
    try {
        writeFileSync(tempPath, serialized, { flag: 'wx', mode: 0o600 });
        tempExists = true;
        renameSync(tempPath, filePath);
        tempExists = false;
    } finally {
        if (tempExists && existsSync(tempPath)) {
            try {
                unlinkSync(tempPath);
            } catch {
                // Best-effort cleanup if the atomic replace fails partway through.
            }
        }
    }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function getCloudLockPath(dataDir: string, key: string): string {
    return join(dataDir, '.locks', `${key}.lock`);
}

function readCloudLock(lockPath: string): CloudFileLock | null {
    try {
        const raw = readFileSync(lockPath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<CloudFileLock>;
        if (!parsed || typeof parsed.owner !== 'string') return null;
        const acquiredAt = Number(parsed.acquiredAt);
        const heartbeatAt = Number(parsed.heartbeatAt);
        if (!Number.isFinite(acquiredAt) || !Number.isFinite(heartbeatAt)) return null;
        return {
            owner: parsed.owner,
            acquiredAt,
            heartbeatAt,
        };
    } catch {
        return null;
    }
}

function writeCloudLock(lockPath: string, lock: CloudFileLock, flag: 'wx' | 'w'): void {
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify(lock), { flag, mode: 0o600 });
}

async function withCloudFileLock<T>(dataDir: string, key: string, fn: () => Promise<T>): Promise<T> {
    const owner = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const lockPath = getCloudLockPath(dataDir, key);
    const startedAt = Date.now();
    let attempt = 0;
    while (true) {
        const now = Date.now();
        try {
            writeCloudLock(lockPath, { owner, acquiredAt: now, heartbeatAt: now }, 'wx');
            break;
        } catch (error) {
            const isExistingLock = typeof error === 'object'
                && error !== null
                && 'code' in error
                && (error as { code?: string }).code === 'EEXIST';
            if (!isExistingLock) {
                throw error;
            }
            const currentLock = readCloudLock(lockPath);
            const lastHeartbeatAt = currentLock?.heartbeatAt ?? currentLock?.acquiredAt ?? 0;
            if (Number.isFinite(lastHeartbeatAt) && now - lastHeartbeatAt > CLOUD_DATA_LOCK_TTL_MS) {
                try {
                    unlinkSync(lockPath);
                    continue;
                } catch {
                    // Another process may have refreshed or released the lock.
                }
            }
            if (now - startedAt > CLOUD_DATA_LOCK_WAIT_TIMEOUT_MS) {
                throw new Error('Timed out waiting for cloud data lock');
            }
            attempt += 1;
            await sleep(Math.min(1000, 25 * attempt));
        }
    }

    const refreshTimer = setInterval(() => {
        try {
            const currentLock = readCloudLock(lockPath);
            if (!currentLock || currentLock.owner !== owner) return;
            writeCloudLock(lockPath, { ...currentLock, heartbeatAt: Date.now() }, 'w');
        } catch {
            // Best effort only; stale-lock cleanup covers crashes.
        }
    }, CLOUD_DATA_LOCK_REFRESH_MS);
    if (typeof refreshTimer.unref === 'function') {
        refreshTimer.unref();
    }

    try {
        return await fn();
    } finally {
        clearInterval(refreshTimer);
        try {
            const currentLock = readCloudLock(lockPath);
            if (currentLock?.owner === owner && existsSync(lockPath)) {
                unlinkSync(lockPath);
            }
        } catch {
            // Best-effort cleanup if another process already reclaimed the stale lock.
        }
    }
}

export function ensureWritableDir(dirPath: string): boolean {
    try {
        mkdirSync(dirPath, { recursive: true });
        const testPath = join(dirPath, '.mindwtr_write_test');
        writeFileSync(testPath, 'ok');
        unlinkSync(testPath);
        return true;
    } catch (error) {
        logError(`cloud data dir is not writable: ${dirPath}`, error);
        logError('ensure the volume is writable by the container user (uid 1000)');
        return false;
    }
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

export async function readJsonBody(req: Request, maxBodyBytes: number, signal?: AbortSignal): Promise<any> {
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
    const withWriteLock = async <T>(key: string, fn: () => Promise<T>) => {
        const current = writeLocks.get(key) ?? Promise.resolve();
        const run = current.catch(() => undefined).then(() => (
            dataDir ? withCloudFileLock(dataDir, key, fn) : fn()
        ));
        const queueTail = run.then(() => undefined, () => undefined);
        writeLocks.set(key, queueTail);
        try {
            return await run;
        } finally {
            if (writeLocks.get(key) === queueTail) {
                writeLocks.delete(key);
            }
        }
    };
    withWriteLock.getPendingLockCount = () => writeLocks.size;
    return withWriteLock;
}
