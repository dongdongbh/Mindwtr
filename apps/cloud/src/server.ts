#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, realpathSync, lstatSync, renameSync } from 'fs';
import { createHash } from 'crypto';
import { basename, dirname, join, relative, resolve, sep } from 'path';
import {
    applyTaskUpdates,
    generateUUID,
    mergeAppData,
    parseQuickAdd,
    searchAll,
    type AppData,
    type Task,
    type TaskStatus,
} from '@mindwtr/core';

type Flags = Record<string, string | boolean>;

type RateLimitState = {
    count: number;
    resetAt: number;
    lastSeenAt: number;
};

type LogLevel = 'info' | 'warn' | 'error';
type LogEntry = {
    ts: string;
    level: LogLevel;
    scope: 'cloud';
    message: string;
    context?: Record<string, unknown>;
};

const writeLog = (entry: LogEntry) => {
    const line = `${JSON.stringify(entry)}\n`;
    if (entry.level === 'error') {
        process.stderr.write(line);
    } else {
        process.stdout.write(line);
    }
};
const normalizeRevision = (value?: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

const logInfo = (message: string, context?: Record<string, unknown>) => {
    writeLog({ ts: new Date().toISOString(), level: 'info', scope: 'cloud', message, context });
};

const logWarn = (message: string, context?: Record<string, unknown>) => {
    writeLog({ ts: new Date().toISOString(), level: 'warn', scope: 'cloud', message, context });
};

const logError = (message: string, error?: unknown) => {
    const context: Record<string, unknown> = {};
    if (error instanceof Error) {
        context.error = error.message;
        if (error.stack) context.stack = error.stack;
    } else if (error !== undefined) {
        context.error = String(error);
    }
    writeLog({ ts: new Date().toISOString(), level: 'error', scope: 'cloud', message, context: Object.keys(context).length ? context : undefined });
};

const configuredCorsOrigin = (process.env.MINDWTR_CLOUD_CORS_ORIGIN || '').trim();
if (configuredCorsOrigin === '*') {
    throw new Error('MINDWTR_CLOUD_CORS_ORIGIN cannot be "*" in production. Set an explicit origin.');
}
const nodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase();
const isProductionEnv = nodeEnv === 'production';
if (!configuredCorsOrigin && isProductionEnv) {
    throw new Error('MINDWTR_CLOUD_CORS_ORIGIN must be set in production.');
}
const corsOrigin = configuredCorsOrigin || 'http://localhost:5173';
const maxTaskTitleLengthValue = Number(process.env.MINDWTR_CLOUD_MAX_TASK_TITLE_LENGTH || 500);
const MAX_TASK_TITLE_LENGTH = Number.isFinite(maxTaskTitleLengthValue) && maxTaskTitleLengthValue > 0
    ? Math.floor(maxTaskTitleLengthValue)
    : 500;
const maxItemsPerCollectionValue = Number(process.env.MINDWTR_CLOUD_MAX_ITEMS_PER_COLLECTION || 50_000);
const MAX_ITEMS_PER_COLLECTION = Number.isFinite(maxItemsPerCollectionValue) && maxItemsPerCollectionValue > 0
    ? Math.floor(maxItemsPerCollectionValue)
    : 50_000;
const listDefaultLimitValue = Number(process.env.MINDWTR_CLOUD_LIST_DEFAULT_LIMIT || 200);
const LIST_DEFAULT_LIMIT = Number.isFinite(listDefaultLimitValue) && listDefaultLimitValue > 0
    ? Math.floor(listDefaultLimitValue)
    : 200;
const listMaxLimitValue = Number(process.env.MINDWTR_CLOUD_LIST_MAX_LIMIT || 1000);
const LIST_MAX_LIMIT = Number.isFinite(listMaxLimitValue) && listMaxLimitValue > 0
    ? Math.floor(listMaxLimitValue)
    : 1000;
const rateLimitMaxKeysValue = Number(process.env.MINDWTR_CLOUD_RATE_MAX_KEYS || 10_000);
const RATE_LIMIT_MAX_KEYS = Number.isFinite(rateLimitMaxKeysValue) && rateLimitMaxKeysValue > 0
    ? Math.floor(rateLimitMaxKeysValue)
    : 10_000;
const MAX_PENDING_REMOTE_DELETE_ATTEMPTS = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const authFailureRateMaxValue = Number(process.env.MINDWTR_CLOUD_AUTH_FAILURE_RATE_MAX || 30);
const AUTH_FAILURE_RATE_MAX = Number.isFinite(authFailureRateMaxValue) && authFailureRateMaxValue > 0
    ? Math.floor(authFailureRateMaxValue)
    : 30;
const ATTACHMENT_PATH_ALLOWLIST = /^[a-zA-Z0-9._/-]+$/;
const CLOUD_DATA_LOCK_TTL_MS = 30_000;
const CLOUD_DATA_LOCK_REFRESH_MS = 2_000;
const CLOUD_DATA_LOCK_WAIT_TIMEOUT_MS = 60_000;
const CLOUD_TASK_CREATION_ALLOWED_PROP_KEYS = new Set<keyof Task>([
    'status',
    'priority',
    'taskMode',
    'startTime',
    'dueDate',
    'recurrence',
    'pushCount',
    'tags',
    'contexts',
    'checklist',
    'description',
    'textDirection',
    'attachments',
    'location',
    'projectId',
    'sectionId',
    'areaId',
    'isFocusedToday',
    'timeEstimate',
    'reviewAt',
]);
const CLOUD_TASK_PATCH_ALLOWED_PROP_KEYS = new Set<keyof Task>([
    'title',
    'order',
    'orderNum',
    ...CLOUD_TASK_CREATION_ALLOWED_PROP_KEYS,
]);
const CLOUD_API_REV_BY = 'cloud';
// Accept URL-safe and common base64 token alphabets to avoid breaking existing deployments.
const BEARER_TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{20,512}$/;

type CloudFileLock = {
    owner: string;
    acquiredAt: number;
    heartbeatAt: number;
};

type RequestAbortError = Error & {
    status: number;
};

type BodyReadError = {
    __mindwtrError: {
        message: string;
        status: number;
    };
};

function createRequestAbortError(message: string, status = 408): RequestAbortError {
    const error = new Error(message) as RequestAbortError;
    error.name = 'RequestAbortError';
    error.status = status;
    return error;
}

function isRequestAbortError(error: unknown): error is RequestAbortError {
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

function throwIfRequestAborted(signal?: AbortSignal, fallbackMessage = 'Request timed out'): void {
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

function isBodyReadError(value: unknown): value is BodyReadError {
    return isRecord(value)
        && isRecord(value.__mindwtrError)
        && typeof value.__mindwtrError.message === 'string'
        && typeof value.__mindwtrError.status === 'number';
}

function decodeAttachmentPath(rawPath: string): string | null {
    try {
        const decoded = decodeURIComponent(rawPath);
        // Reject any path that still contains a percent sign after one decode pass.
        // This blocks multi-encoded traversal attempts and keeps parsing deterministic.
        if (decoded.includes('%')) {
            return null;
        }
        return decoded;
    } catch {
        return null;
    }
}

function decodePathParam(rawValue: string): string | null {
    try {
        return decodeURIComponent(rawValue);
    } catch {
        return null;
    }
}

function parseTaskRouteId(rawValue: string): string | null {
    const decoded = decodePathParam(rawValue);
    if (!decoded) return null;
    return UUID_PATTERN.test(decoded) ? decoded : null;
}

function isPathWithinRoot(pathValue: string, rootPath: string): boolean {
    return pathValue === rootPath || pathValue.startsWith(`${rootPath}${sep}`);
}

function normalizeAttachmentRelativePath(rawPath: string): string | null {
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

function resolveAttachmentPath(dataDir: string, key: string, rawPath: string): { rootRealPath: string; filePath: string } | null {
    const relativePath = normalizeAttachmentRelativePath(rawPath);
    if (!relativePath) return null;
    const rootDir = resolve(join(dataDir, key, 'attachments'));
    mkdirSync(rootDir, { recursive: true });
    const rootRealPath = realpathSync(rootDir);
    const filePath = resolve(join(rootRealPath, relativePath));
    if (!isPathWithinRoot(filePath, rootRealPath)) return null;
    return { rootRealPath, filePath };
}

function pathContainsSymlink(rootRealPath: string, targetPath: string): boolean {
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

function writeAttachmentFileSafely(rootRealPath: string, filePath: string, body: Uint8Array): boolean {
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

const shutdown = (signal: string) => {
    logInfo(`received ${signal}, shutting down`);
    process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

function parseArgs(argv: string[]) {
    const flags: Flags = {};
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg || !arg.startsWith('--')) continue;
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
            flags[key] = next;
            i += 1;
        } else {
            flags[key] = true;
        }
    }
    return flags;
}

function parsePagination(searchParams: URLSearchParams): { limit: number; offset: number } | { error: string } {
    const limitRaw = searchParams.get('limit');
    const offsetRaw = searchParams.get('offset');
    const parsedLimit = limitRaw == null ? LIST_DEFAULT_LIMIT : Number(limitRaw);
    const parsedOffset = offsetRaw == null ? 0 : Number(offsetRaw);
    if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
        return { error: 'Invalid limit' };
    }
    if (!Number.isFinite(parsedOffset) || parsedOffset < 0) {
        return { error: 'Invalid offset' };
    }
    const limit = Math.min(LIST_MAX_LIMIT, Math.floor(parsedLimit));
    const offset = Math.floor(parsedOffset);
    return { limit, offset };
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('Content-Type', 'application/json; charset=utf-8');
    headers.set('Access-Control-Allow-Origin', corsOrigin);
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    headers.set('Access-Control-Allow-Methods', 'GET,PUT,POST,PATCH,DELETE,OPTIONS');
    return new Response(JSON.stringify(body, null, 2), { ...init, headers });
}

function errorResponse(message: string, status = 400) {
    return jsonResponse({ error: message }, { status });
}

function getToken(req: Request): string | null {
    const auth = req.headers.get('authorization') || '';
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match) return null;
    const token = match[1].trim();
    if (!BEARER_TOKEN_PATTERN.test(token)) return null;
    return token;
}

function tokenToKey(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

function getClientIp(req: Request, trustProxyHeaders = false): string {
    if (!trustProxyHeaders) return 'unknown';
    const forwarded = req.headers.get('x-forwarded-for');
    if (forwarded) {
        const first = forwarded.split(',')[0]?.trim();
        if (first) return first;
    }
    const cfIp = req.headers.get('cf-connecting-ip')?.trim();
    if (cfIp) return cfIp;
    const realIp = req.headers.get('x-real-ip')?.trim();
    if (realIp) return realIp;
    return 'unknown';
}

function parseAllowedAuthTokens(rawValue?: string): Set<string> | null {
    const tokens = String(rawValue || '')
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    return tokens.length > 0 ? new Set(tokens) : null;
}

function parseBoolEnv(value: string | undefined): boolean {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function resolveAllowedAuthTokensFromEnv(env: Record<string, string | undefined>): Set<string> | null {
    const values = [
        env.MINDWTR_CLOUD_AUTH_TOKENS,
        env.MINDWTR_CLOUD_TOKEN, // legacy name kept for backward compatibility
    ]
        .map((value) => String(value || '').trim())
        .filter((value) => value.length > 0);
    if (values.length === 0) {
        if (parseBoolEnv(env.MINDWTR_CLOUD_ALLOW_ANY_TOKEN)) {
            logWarn('MINDWTR_CLOUD_ALLOW_ANY_TOKEN is enabled. Prefer MINDWTR_CLOUD_AUTH_TOKENS for stronger access control.');
            return null;
        }
        throw new Error(
            'Cloud auth is not configured. Set MINDWTR_CLOUD_AUTH_TOKENS (or legacy MINDWTR_CLOUD_TOKEN), or explicitly set MINDWTR_CLOUD_ALLOW_ANY_TOKEN=true to enable token namespace mode.'
        );
    }
    return parseAllowedAuthTokens(values.join(','));
}

function isAuthorizedToken(token: string, allowedTokens: Set<string> | null): boolean {
    if (!allowedTokens) return true;
    return allowedTokens.has(token);
}

function toRateLimitRoute(pathname: string): string {
    if (/^\/v1\/attachments\/.+/.test(pathname)) {
        return '/v1/attachments/:path';
    }
    if (/^\/v1\/tasks\/[^/]+\/(complete|archive)$/.test(pathname)) {
        return '/v1/tasks/:id/:action';
    }
    if (/^\/v1\/tasks\/[^/]+$/.test(pathname)) {
        return '/v1/tasks/:id';
    }
    return pathname;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidIsoTimestamp(value: unknown): boolean {
    if (typeof value !== 'string' || value.trim().length === 0) return false;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed);
}

function validateAppData(value: unknown): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
    if (!isRecord(value)) return { ok: false, error: 'Invalid data: expected an object' };
    const tasks = value.tasks;
    const projects = value.projects;
    const sections = value.sections;
    const settings = value.settings;
    const areas = value.areas;

    if (!Array.isArray(tasks)) return { ok: false, error: 'Invalid data: tasks must be an array' };
    if (!Array.isArray(projects)) return { ok: false, error: 'Invalid data: projects must be an array' };
    if (sections !== undefined && !Array.isArray(sections)) return { ok: false, error: 'Invalid data: sections must be an array' };
    if (areas !== undefined && !Array.isArray(areas)) return { ok: false, error: 'Invalid data: areas must be an array' };
    if (settings !== undefined && !isRecord(settings)) return { ok: false, error: 'Invalid data: settings must be an object' };
    if (tasks.length > MAX_ITEMS_PER_COLLECTION) return { ok: false, error: `Invalid data: tasks exceeds limit (${MAX_ITEMS_PER_COLLECTION})` };
    if (projects.length > MAX_ITEMS_PER_COLLECTION) return { ok: false, error: `Invalid data: projects exceeds limit (${MAX_ITEMS_PER_COLLECTION})` };
    if (Array.isArray(sections) && sections.length > MAX_ITEMS_PER_COLLECTION) {
        return { ok: false, error: `Invalid data: sections exceeds limit (${MAX_ITEMS_PER_COLLECTION})` };
    }
    if (Array.isArray(areas) && areas.length > MAX_ITEMS_PER_COLLECTION) {
        return { ok: false, error: `Invalid data: areas exceeds limit (${MAX_ITEMS_PER_COLLECTION})` };
    }

    for (const task of tasks) {
        if (!isRecord(task) || typeof task.id !== 'string' || typeof task.title !== 'string') {
            return { ok: false, error: 'Invalid data: each task must be an object with string id and title' };
        }
        if (task.id.trim().length === 0 || task.title.trim().length === 0) {
            return { ok: false, error: 'Invalid data: each task must include non-empty id and title' };
        }
        if (typeof task.status !== 'string' || !['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'].includes(task.status)) {
            return { ok: false, error: 'Invalid data: task status must be a valid value' };
        }
        if (!isValidIsoTimestamp(task.createdAt) || !isValidIsoTimestamp(task.updatedAt)) {
            return { ok: false, error: 'Invalid data: task createdAt/updatedAt must be valid ISO timestamps' };
        }
        if (task.deletedAt != null && !isValidIsoTimestamp(task.deletedAt)) {
            return { ok: false, error: 'Invalid data: task deletedAt must be a valid ISO timestamp when present' };
        }
    }

    for (const project of projects) {
        if (!isRecord(project) || typeof project.id !== 'string' || typeof project.title !== 'string') {
            return { ok: false, error: 'Invalid data: each project must be an object with string id and title' };
        }
        if (project.id.trim().length === 0 || project.title.trim().length === 0) {
            return { ok: false, error: 'Invalid data: each project must include non-empty id and title' };
        }
        if (typeof project.status !== 'string' || !['active', 'someday', 'waiting', 'archived'].includes(project.status)) {
            return { ok: false, error: 'Invalid data: project status must be a valid value' };
        }
        if (!isValidIsoTimestamp(project.createdAt) || !isValidIsoTimestamp(project.updatedAt)) {
            return { ok: false, error: 'Invalid data: project createdAt/updatedAt must be valid ISO timestamps' };
        }
        if (project.deletedAt != null && !isValidIsoTimestamp(project.deletedAt)) {
            return { ok: false, error: 'Invalid data: project deletedAt must be a valid ISO timestamp when present' };
        }
    }

    const projectsById = new Map<string, Record<string, unknown>>();
    const activeProjectIds = new Set<string>();
    for (const project of projects) {
        const projectRecord = project as Record<string, unknown>;
        const projectId = String(projectRecord.id);
        projectsById.set(projectId, projectRecord);
        if (projectRecord.deletedAt == null) {
            activeProjectIds.add(projectId);
        }
    }

    if (Array.isArray(sections)) {
        const sectionsById = new Map<string, Record<string, unknown>>();
        const activeSectionIds = new Set<string>();
        for (const section of sections) {
            if (!isRecord(section) || typeof section.id !== 'string' || typeof section.projectId !== 'string' || typeof section.title !== 'string') {
                return { ok: false, error: 'Invalid data: each section must be an object with string id, projectId, and title' };
            }
            if (!isValidIsoTimestamp(section.createdAt) || !isValidIsoTimestamp(section.updatedAt)) {
                return { ok: false, error: 'Invalid data: section createdAt/updatedAt must be valid ISO timestamps' };
            }
            if (section.deletedAt != null && !isValidIsoTimestamp(section.deletedAt)) {
                return { ok: false, error: 'Invalid data: section deletedAt must be a valid ISO timestamp when present' };
            }
            sectionsById.set(section.id, section);
            if (section.deletedAt == null) {
                activeSectionIds.add(section.id);
                if (!activeProjectIds.has(section.projectId)) {
                    return { ok: false, error: `Invalid data: live section ${section.id} references missing or deleted project ${section.projectId}` };
                }
            }
        }

        for (const task of tasks) {
            const taskRecord = task as Record<string, unknown>;
            if (taskRecord.deletedAt != null) continue;
            const projectId = typeof taskRecord.projectId === 'string' ? taskRecord.projectId.trim() : '';
            const sectionId = typeof taskRecord.sectionId === 'string' ? taskRecord.sectionId.trim() : '';
            if (projectId && !activeProjectIds.has(projectId)) {
                return { ok: false, error: `Invalid data: live task ${String(taskRecord.id)} references missing or deleted project ${projectId}` };
            }
            if (sectionId) {
                if (!projectId) {
                    return { ok: false, error: `Invalid data: live task ${String(taskRecord.id)} must include projectId when sectionId is present` };
                }
                if (!activeSectionIds.has(sectionId)) {
                    return { ok: false, error: `Invalid data: live task ${String(taskRecord.id)} references missing or deleted section ${sectionId}` };
                }
                const section = sectionsById.get(sectionId);
                const sectionProjectId = typeof section?.projectId === 'string' ? section.projectId : '';
                if (sectionProjectId !== projectId) {
                    return { ok: false, error: `Invalid data: live task ${String(taskRecord.id)} section ${sectionId} belongs to project ${sectionProjectId}` };
                }
            }
        }
    } else {
        for (const task of tasks) {
            const taskRecord = task as Record<string, unknown>;
            if (taskRecord.deletedAt != null) continue;
            const projectId = typeof taskRecord.projectId === 'string' ? taskRecord.projectId.trim() : '';
            const sectionId = typeof taskRecord.sectionId === 'string' ? taskRecord.sectionId.trim() : '';
            if (projectId && !activeProjectIds.has(projectId)) {
                return { ok: false, error: `Invalid data: live task ${String(taskRecord.id)} references missing or deleted project ${projectId}` };
            }
            if (sectionId) {
                return { ok: false, error: `Invalid data: live task ${String(taskRecord.id)} references section ${sectionId} but sections are missing` };
            }
        }
    }

    const activeAreaIds = new Set<string>();
    if (Array.isArray(areas)) {
        for (const area of areas) {
            if (!isRecord(area) || typeof area.id !== 'string' || typeof area.name !== 'string') {
                return { ok: false, error: 'Invalid data: each area must be an object with string id and name' };
            }
            if (!isValidIsoTimestamp(area.createdAt)) {
                return { ok: false, error: 'Invalid data: area createdAt must be a valid ISO timestamp' };
            }
            if (!isValidIsoTimestamp(area.updatedAt)) {
                return { ok: false, error: 'Invalid data: area updatedAt must be a valid ISO timestamp' };
            }
            if (area.deletedAt != null && !isValidIsoTimestamp(area.deletedAt)) {
                return { ok: false, error: 'Invalid data: area deletedAt must be a valid ISO timestamp when present' };
            }
            if (area.deletedAt == null) {
                activeAreaIds.add(area.id);
            }
        }
    }

    for (const project of projects) {
        if (!isRecord(project) || project.deletedAt != null) continue;
        const areaId = typeof project.areaId === 'string' ? project.areaId.trim() : '';
        if (areaId && !activeAreaIds.has(areaId)) {
            return { ok: false, error: `Invalid data: live project ${project.id} references missing or deleted area ${areaId}` };
        }
    }

    for (const task of tasks) {
        const taskRecord = task as Record<string, unknown>;
        if (taskRecord.deletedAt != null) continue;
        const areaId = typeof taskRecord.areaId === 'string' ? taskRecord.areaId.trim() : '';
        if (areaId && !activeAreaIds.has(areaId)) {
            return { ok: false, error: `Invalid data: live task ${String(taskRecord.id)} references missing or deleted area ${areaId}` };
        }
    }

    const attachments = settings && isRecord(settings) ? (settings as Record<string, unknown>).attachments : undefined;
    if (attachments !== undefined) {
        if (!isRecord(attachments)) {
            return { ok: false, error: 'Invalid data: settings.attachments must be an object when present' };
        }
        const pendingRemoteDeletes = (attachments as Record<string, unknown>).pendingRemoteDeletes;
        if (pendingRemoteDeletes !== undefined) {
            if (!Array.isArray(pendingRemoteDeletes)) {
                return { ok: false, error: 'Invalid data: settings.attachments.pendingRemoteDeletes must be an array when present' };
            }
            if (pendingRemoteDeletes.length > MAX_ITEMS_PER_COLLECTION) {
                return { ok: false, error: `Invalid data: pendingRemoteDeletes exceeds limit (${MAX_ITEMS_PER_COLLECTION})` };
            }
            for (const item of pendingRemoteDeletes) {
                if (!isRecord(item)) {
                    return { ok: false, error: 'Invalid data: each pendingRemoteDeletes entry must be an object' };
                }
                const cloudKey = typeof item.cloudKey === 'string' ? item.cloudKey.trim() : '';
                if (!cloudKey || !normalizeAttachmentRelativePath(cloudKey)) {
                    return { ok: false, error: 'Invalid data: pendingRemoteDeletes.cloudKey must be a valid relative attachment path' };
                }
                if (item.title !== undefined && typeof item.title !== 'string') {
                    return { ok: false, error: 'Invalid data: pendingRemoteDeletes.title must be a string when present' };
                }
                if (item.attempts !== undefined) {
                    if (typeof item.attempts !== 'number' || !Number.isFinite(item.attempts) || item.attempts < 0 || !Number.isInteger(item.attempts)) {
                        return { ok: false, error: 'Invalid data: pendingRemoteDeletes.attempts must be a non-negative integer when present' };
                    }
                    if (item.attempts > MAX_PENDING_REMOTE_DELETE_ATTEMPTS) {
                        return { ok: false, error: `Invalid data: pendingRemoteDeletes.attempts exceeds ${MAX_PENDING_REMOTE_DELETE_ATTEMPTS}` };
                    }
                }
                if (item.lastErrorAt !== undefined && item.lastErrorAt !== null && !isValidIsoTimestamp(item.lastErrorAt)) {
                    return { ok: false, error: 'Invalid data: pendingRemoteDeletes.lastErrorAt must be a valid ISO timestamp when present' };
                }
            }
        }
    }

    return { ok: true, data: value };
}

const DEFAULT_DATA: AppData = { tasks: [], projects: [], sections: [], areas: [], settings: {} };

function loadAppData(filePath: string): AppData {
    const raw = readData(filePath);
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_DATA };
    const record = raw as Record<string, unknown>;
    const nowIso = new Date().toISOString();
    const normalizedAreas = Array.isArray(record.areas)
        ? (record.areas as unknown[]).map((area) => {
            if (!isRecord(area)) return area;
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

function asStatus(value: unknown): TaskStatus | null {
    if (typeof value !== 'string') return null;
    const allowed: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'];
    return allowed.includes(value as TaskStatus) ? (value as TaskStatus) : null;
}

function validateTaskCreationProps(value: unknown): { ok: true; props: Partial<Task> } | { ok: false; error: string } {
    if (!isRecord(value)) return { ok: false, error: 'Invalid task props' };
    const invalidKeys = Object.keys(value).filter((key) => !CLOUD_TASK_CREATION_ALLOWED_PROP_KEYS.has(key as keyof Task));
    if (invalidKeys.length > 0) {
        return {
            ok: false,
            error: `Unsupported task props: ${invalidKeys.slice(0, 10).join(', ')}`,
        };
    }
    return { ok: true, props: value as Partial<Task> };
}

function validateTaskPatchProps(value: unknown): { ok: true; props: Partial<Task> } | { ok: false; error: string } {
    if (!isRecord(value)) return { ok: false, error: 'Invalid task updates' };
    const invalidKeys = Object.keys(value).filter((key) => !CLOUD_TASK_PATCH_ALLOWED_PROP_KEYS.has(key as keyof Task));
    if (invalidKeys.length > 0) {
        return {
            ok: false,
            error: `Unsupported task updates: ${invalidKeys.slice(0, 10).join(', ')}`,
        };
    }
    return { ok: true, props: value as Partial<Task> };
}

function pickTaskList(
    data: AppData,
    opts: { includeDeleted: boolean; includeCompleted: boolean; status?: TaskStatus | null; query?: string }
): Task[] {
    let tasks = data.tasks;
    if (!opts.includeDeleted) tasks = tasks.filter((t) => !t.deletedAt);
    if (!opts.includeCompleted) tasks = tasks.filter((t) => t.status !== 'done' && t.status !== 'archived');
    if (opts.status) tasks = tasks.filter((t) => t.status === opts.status);
    if (opts.query && opts.query.trim()) {
        tasks = searchAll(tasks, data.projects.filter((p) => !p.deletedAt), opts.query).tasks;
    }
    return tasks;
}

function readData(filePath: string): any | null {
    try {
        const raw = readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function writeData(filePath: string, data: unknown) {
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

function ensureWritableDir(dirPath: string): boolean {
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

async function readRequestBytes(
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

async function readJsonBody(req: Request, maxBodyBytes: number, signal?: AbortSignal): Promise<any> {
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

export const __cloudTestUtils = {
    parseArgs,
    getToken,
    tokenToKey,
    parseAllowedAuthTokens,
    parseBoolEnv,
    resolveAllowedAuthTokensFromEnv,
    isAuthorizedToken,
    getClientIp,
    toRateLimitRoute,
    validateAppData,
    asStatus,
    validateTaskCreationProps,
    validateTaskPatchProps,
    pickTaskList,
    readJsonBody,
    writeData,
    normalizeAttachmentRelativePath,
    isPathWithinRoot,
    pathContainsSymlink,
    createWriteLockRunner,
};

type CloudServerOptions = {
    port?: number;
    host?: string;
    dataDir?: string;
    windowMs?: number;
    maxPerWindow?: number;
    maxAttachmentPerWindow?: number;
    maxBodyBytes?: number;
    maxAttachmentBytes?: number;
    requestTimeoutMs?: number;
    allowedAuthTokens?: Set<string> | null;
    trustProxyHeaders?: boolean;
};

type CloudServerHandle = {
    stop: () => void;
    port: number;
};

type WriteLockRunner = {
    <T>(key: string, fn: () => Promise<T>): Promise<T>;
    getPendingLockCount: () => number;
};

function createWriteLockRunner(dataDir?: string): WriteLockRunner {
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

export async function startCloudServer(options: CloudServerOptions = {}): Promise<CloudServerHandle> {
    const flags = parseArgs(process.argv.slice(2));
    const port = Number(options.port ?? flags.port ?? process.env.PORT ?? 8787);
    const host = String(options.host ?? flags.host ?? process.env.HOST ?? '0.0.0.0');
    const dataDir = String(options.dataDir ?? process.env.MINDWTR_CLOUD_DATA_DIR ?? join(process.cwd(), 'data'));

    const rateLimits = new Map<string, RateLimitState>();
    const windowMs = Number(options.windowMs ?? process.env.MINDWTR_CLOUD_RATE_WINDOW_MS ?? 60_000);
    const maxPerWindow = Number(options.maxPerWindow ?? process.env.MINDWTR_CLOUD_RATE_MAX ?? 120);
    const maxAttachmentPerWindow = Number(
        options.maxAttachmentPerWindow ?? process.env.MINDWTR_CLOUD_ATTACHMENT_RATE_MAX ?? maxPerWindow
    );
    const maxBodyBytes = Number(options.maxBodyBytes ?? process.env.MINDWTR_CLOUD_MAX_BODY_BYTES ?? 2_000_000);
    const maxAttachmentBytes = Number(
        options.maxAttachmentBytes ?? process.env.MINDWTR_CLOUD_MAX_ATTACHMENT_BYTES ?? 50_000_000
    );
    const allowedAuthTokens = options.allowedAuthTokens ?? resolveAllowedAuthTokensFromEnv(process.env);
    const trustProxyHeaders = options.trustProxyHeaders ?? parseBoolEnv(process.env.MINDWTR_CLOUD_TRUST_PROXY_HEADERS);
    const withWriteLock = createWriteLockRunner(dataDir);
    const rateLimitCleanupMs = Number(process.env.MINDWTR_CLOUD_RATE_CLEANUP_MS || 60_000);
    const requestTimeoutMs = Number(options.requestTimeoutMs ?? process.env.MINDWTR_CLOUD_REQUEST_TIMEOUT_MS ?? 30_000);
    const pruneExpiredRateLimits = (now: number) => {
        for (const [key, state] of rateLimits.entries()) {
            if (now > state.resetAt) {
                rateLimits.delete(key);
            }
        }
    };
    const findLeastRecentlyUsedRateLimitKey = (): string | null => {
        let oldestKey: string | null = null;
        let oldestSeenAt = Number.POSITIVE_INFINITY;
        let oldestResetAt = Number.POSITIVE_INFINITY;
        for (const [key, state] of rateLimits.entries()) {
            if (
                state.lastSeenAt < oldestSeenAt
                || (state.lastSeenAt === oldestSeenAt && state.resetAt < oldestResetAt)
            ) {
                oldestKey = key;
                oldestSeenAt = state.lastSeenAt;
                oldestResetAt = state.resetAt;
            }
        }
        return oldestKey;
    };
    const ensureRateLimitCapacity = (now: number) => {
        pruneExpiredRateLimits(now);
        while (rateLimits.size >= RATE_LIMIT_MAX_KEYS) {
            const oldestKey = findLeastRecentlyUsedRateLimitKey();
            if (!oldestKey) break;
            rateLimits.delete(oldestKey);
        }
    };
    const checkRateLimit = (rateKey: string, maxAllowed: number): Response | null => {
        const now = Date.now();
        const state = rateLimits.get(rateKey);
        if (state && now < state.resetAt) {
            state.count += 1;
            state.lastSeenAt = now;
            if (state.count > maxAllowed) {
                const retryAfter = Math.ceil((state.resetAt - now) / 1000);
                return jsonResponse(
                    { error: 'Rate limit exceeded', retryAfterSeconds: retryAfter },
                    { status: 429, headers: { 'Retry-After': String(retryAfter) } },
                );
            }
            return null;
        }
        if (!state && rateLimits.size >= RATE_LIMIT_MAX_KEYS) {
            ensureRateLimitCapacity(now);
        }
        rateLimits.set(rateKey, { count: 1, resetAt: now + windowMs, lastSeenAt: now });
        return null;
    };
    const unauthorizedResponse = (req: Request): Response => {
        const authRateKey = `auth-failure:${getClientIp(req, trustProxyHeaders)}`;
        const authRateLimitResponse = checkRateLimit(authRateKey, AUTH_FAILURE_RATE_MAX);
        if (authRateLimitResponse) {
            return authRateLimitResponse;
        }
        return errorResponse('Unauthorized', 401);
    };
    const cleanupTimer = setInterval(() => {
        pruneExpiredRateLimits(Date.now());
    }, rateLimitCleanupMs);
    if (typeof cleanupTimer.unref === 'function') {
        cleanupTimer.unref();
    }

    logInfo(`dataDir: ${dataDir}`);
    const usingLegacyTokenVar = options.allowedAuthTokens === undefined
        && !String(process.env.MINDWTR_CLOUD_AUTH_TOKENS || '').trim()
        && String(process.env.MINDWTR_CLOUD_TOKEN || '').trim().length > 0;
    if (usingLegacyTokenVar) {
        logWarn('MINDWTR_CLOUD_TOKEN is deprecated; use MINDWTR_CLOUD_AUTH_TOKENS instead');
    }
    if (allowedAuthTokens) {
        logInfo('token auth allowlist enabled', { allowedTokens: String(allowedAuthTokens.size) });
    } else {
        logInfo('token namespace mode enabled by explicit opt-in', {
            hint: 'set MINDWTR_CLOUD_AUTH_TOKENS to enforce a strict token allowlist',
        });
    }
    if (trustProxyHeaders) {
        logWarn('trusting proxy IP headers for auth failure rate limiting', {
            hint: 'enable this only behind a trusted reverse proxy that overwrites forwarded IP headers',
        });
    }
    if (!ensureWritableDir(dataDir)) {
        throw new Error(`Cloud data directory is not writable: ${dataDir}`);
    }
    logInfo(`listening on http://${host}:${port}`);

    const server = Bun.serve({
        hostname: host,
        port,
        async fetch(req) {
            const requestAbortController = new AbortController();
            const requestTimeout = setTimeout(() => {
                requestAbortController.abort(createRequestAbortError('Request timed out', 408));
            }, requestTimeoutMs);
            try {
                throwIfRequestAborted(requestAbortController.signal);
                if (req.method === 'OPTIONS') return jsonResponse({ ok: true });

                const url = new URL(req.url);
                const pathname = url.pathname.replace(/\/+$/, '') || '/';

            if (req.method === 'GET' && pathname === '/health') {
                return jsonResponse({ ok: true });
            }

            if (
                pathname === '/v1/tasks' ||
                pathname === '/v1/projects' ||
                pathname === '/v1/search' ||
                pathname.startsWith('/v1/tasks/')
            ) {
                const token = getToken(req);
                if (!token) return unauthorizedResponse(req);
                if (!isAuthorizedToken(token, allowedAuthTokens)) return unauthorizedResponse(req);
                const key = tokenToKey(token);
                const routeKey = toRateLimitRoute(pathname);
                const rateKey = `${key}:${req.method}:${routeKey}`;
                const rateLimitResponse = checkRateLimit(rateKey, maxPerWindow);
                if (rateLimitResponse) return rateLimitResponse;
                const filePath = join(dataDir, `${key}.json`);

                if (req.method === 'GET' && pathname === '/v1/tasks') {
                    const query = url.searchParams.get('query') || '';
                    const includeAll = url.searchParams.get('all') === '1';
                    const includeDeleted = url.searchParams.get('deleted') === '1';
                    const rawStatus = url.searchParams.get('status');
                    const pagination = parsePagination(url.searchParams);
                    if ('error' in pagination) return errorResponse(pagination.error, 400);
                    const status = asStatus(rawStatus);
                    if (rawStatus !== null && status === null) {
                        return errorResponse('Invalid task status');
                    }
                    const data = loadAppData(filePath);
                    const tasks = pickTaskList(data, {
                        includeDeleted,
                        includeCompleted: includeAll,
                        status,
                        query,
                    });
                    const total = tasks.length;
                    const pageTasks = tasks.slice(pagination.offset, pagination.offset + pagination.limit);
                    return jsonResponse({ tasks: pageTasks, total, limit: pagination.limit, offset: pagination.offset });
                }

                if (req.method === 'POST' && pathname === '/v1/tasks') {
                    const body = await readJsonBody(req, maxBodyBytes, requestAbortController.signal);
                    if (isBodyReadError(body)) {
                        const err = body.__mindwtrError;
                        return errorResponse(String(err?.message || 'Payload too large'), Number(err?.status) || 413);
                    }
                    if (!body || typeof body !== 'object') return errorResponse('Invalid JSON body');

                    return await withWriteLock(key, async () => {
                        throwIfRequestAborted(requestAbortController.signal);
                        const data = loadAppData(filePath);
                        const nowIso = new Date().toISOString();

                        const input = typeof (body as any).input === 'string' ? String((body as any).input) : '';
                        const rawTitle = typeof (body as any).title === 'string' ? String((body as any).title) : '';
                        const rawInitialProps = typeof (body as any).props === 'object' && (body as any).props ? (body as any).props : {};
                        const validatedInitialProps = validateTaskCreationProps(rawInitialProps);
                        if (!validatedInitialProps.ok) {
                            return errorResponse(validatedInitialProps.error, 400);
                        }
                        const initialProps = validatedInitialProps.props;
                        if (input.trim().length > MAX_TASK_TITLE_LENGTH) {
                            return errorResponse(`Quick-add input too long (max ${MAX_TASK_TITLE_LENGTH} characters)`, 400);
                        }

                        const parsed = input ? parseQuickAdd(input, data.projects, new Date(nowIso), data.areas) : { title: rawTitle, props: {} };
                        const title = (parsed.title || rawTitle || input).trim();
                        if (!title) return errorResponse('Missing task title');
                        if (title.length > MAX_TASK_TITLE_LENGTH) {
                            return errorResponse(`Task title too long (max ${MAX_TASK_TITLE_LENGTH} characters)`, 400);
                        }

                        const props: Partial<Task> = {
                            ...parsed.props,
                            ...initialProps,
                        };

                        const rawStatus = (props as any).status;
                        const parsedStatus = asStatus(rawStatus);
                        if (rawStatus !== undefined && parsedStatus === null) {
                            return errorResponse('Invalid task status', 400);
                        }
                        const status = parsedStatus || 'inbox';
                        const tags = Array.isArray((props as any).tags) ? (props as any).tags : [];
                        const contexts = Array.isArray((props as any).contexts) ? (props as any).contexts : [];
                        const {
                            id: _id,
                            title: _title,
                            createdAt: _createdAt,
                            updatedAt: _updatedAt,
                            status: _status,
                            tags: _tags,
                            contexts: _contexts,
                            ...restProps
                        } = props as any;
                        const task: Task = {
                            id: generateUUID(),
                            title,
                            ...restProps,
                            status,
                            tags,
                            contexts,
                            createdAt: nowIso,
                            updatedAt: nowIso,
                        } as Task;
                        if ((status === 'done' || status === 'archived') && !task.completedAt) {
                            task.completedAt = nowIso;
                        }

                        data.tasks.push(task);
                        throwIfRequestAborted(requestAbortController.signal);
                        writeData(filePath, data);
                        return jsonResponse({ task }, { status: 201 });
                    });
                }

                const actionMatch = pathname.match(/^\/v1\/tasks\/([^/]+)\/(complete|archive)$/);
                if (actionMatch && req.method === 'POST') {
                    const taskId = parseTaskRouteId(actionMatch[1]);
                    if (!taskId) return errorResponse('Invalid task id', 400);
                    const action = actionMatch[2];
                    const status: TaskStatus = action === 'archive' ? 'archived' : 'done';

                    return await withWriteLock(key, async () => {
                        throwIfRequestAborted(requestAbortController.signal);
                        const data = loadAppData(filePath);
                        const idx = data.tasks.findIndex((t) => t.id === taskId && !t.deletedAt);
                        if (idx < 0) return errorResponse('Task not found', 404);

                        const nowIso = new Date().toISOString();
                        const existing = data.tasks[idx];
                        const { updatedTask, nextRecurringTask } = applyTaskUpdates(existing, {
                            status,
                            rev: normalizeRevision(existing.rev) + 1,
                            revBy: CLOUD_API_REV_BY,
                        }, nowIso);
                        data.tasks[idx] = updatedTask;
                        if (nextRecurringTask) data.tasks.push(nextRecurringTask);
                        throwIfRequestAborted(requestAbortController.signal);
                        writeData(filePath, data);
                        return jsonResponse({ task: updatedTask });
                    });
                }

                const taskMatch = pathname.match(/^\/v1\/tasks\/([^/]+)$/);
                if (taskMatch) {
                    const taskId = parseTaskRouteId(taskMatch[1]);
                    if (!taskId) return errorResponse('Invalid task id', 400);

                    if (req.method === 'GET') {
                        const data = loadAppData(filePath);
                        const task = data.tasks.find((t) => t.id === taskId && !t.deletedAt);
                        if (!task) return errorResponse('Task not found', 404);
                        return jsonResponse({ task });
                    }

                    if (req.method === 'PATCH') {
                        const body = await readJsonBody(req, maxBodyBytes, requestAbortController.signal);
                        if (isBodyReadError(body)) {
                            const err = body.__mindwtrError;
                            return errorResponse(String(err?.message || 'Payload too large'), Number(err?.status) || 413);
                        }
                        if (!body || typeof body !== 'object') return errorResponse('Invalid JSON body');
                        const validatedPatch = validateTaskPatchProps(body);
                        if (!validatedPatch.ok) {
                            return errorResponse(validatedPatch.error, 400);
                        }
                        const updates = validatedPatch.props;
                        if (typeof (updates as any).title === 'string' && (updates as any).title.length > MAX_TASK_TITLE_LENGTH) {
                            return errorResponse(`Task title too long (max ${MAX_TASK_TITLE_LENGTH} characters)`, 400);
                        }
                        const rawStatus = (updates as any).status;
                        if (rawStatus !== undefined && asStatus(rawStatus) === null) {
                            return errorResponse('Invalid task status', 400);
                        }

                        return await withWriteLock(key, async () => {
                            throwIfRequestAborted(requestAbortController.signal);
                            const data = loadAppData(filePath);
                            const idx = data.tasks.findIndex((t) => t.id === taskId && !t.deletedAt);
                            if (idx < 0) return errorResponse('Task not found', 404);

                            const nowIso = new Date().toISOString();
                            const existing = data.tasks[idx];
                            const { updatedTask, nextRecurringTask } = applyTaskUpdates(existing, {
                                ...updates,
                                rev: normalizeRevision(existing.rev) + 1,
                                revBy: CLOUD_API_REV_BY,
                            }, nowIso);

                            data.tasks[idx] = updatedTask;
                            if (nextRecurringTask) data.tasks.push(nextRecurringTask);
                            throwIfRequestAborted(requestAbortController.signal);
                            writeData(filePath, data);
                            return jsonResponse({ task: updatedTask });
                        });
                    }

                    if (req.method === 'DELETE') {
                        return await withWriteLock(key, async () => {
                            throwIfRequestAborted(requestAbortController.signal);
                            const data = loadAppData(filePath);
                            const idx = data.tasks.findIndex((t) => t.id === taskId && !t.deletedAt);
                            if (idx < 0) return errorResponse('Task not found', 404);

                            const nowIso = new Date().toISOString();
                            const existing = data.tasks[idx];
                            data.tasks[idx] = {
                                ...existing,
                                deletedAt: nowIso,
                                updatedAt: nowIso,
                                rev: normalizeRevision(existing.rev) + 1,
                                revBy: CLOUD_API_REV_BY,
                            };
                            throwIfRequestAborted(requestAbortController.signal);
                            writeData(filePath, data);
                            return jsonResponse({ ok: true });
                        });
                    }
                }

                if (req.method === 'GET' && pathname === '/v1/projects') {
                    throwIfRequestAborted(requestAbortController.signal);
                    const pagination = parsePagination(url.searchParams);
                    if ('error' in pagination) return errorResponse(pagination.error, 400);
                    const data = loadAppData(filePath);
                    const projects = data.projects.filter((p: any) => !p.deletedAt);
                    const total = projects.length;
                    const pageProjects = projects.slice(pagination.offset, pagination.offset + pagination.limit);
                    return jsonResponse({
                        projects: pageProjects,
                        total,
                        limit: pagination.limit,
                        offset: pagination.offset,
                    });
                }

                if (req.method === 'GET' && pathname === '/v1/search') {
                    throwIfRequestAborted(requestAbortController.signal);
                    const query = url.searchParams.get('query') || '';
                    const data = loadAppData(filePath);
                    const tasks = data.tasks.filter((t) => !t.deletedAt);
                    const projects = data.projects.filter((p: any) => !p.deletedAt);
                    const results = searchAll(tasks, projects, query);
                    return jsonResponse(results);
                }

                if (pathname.startsWith('/v1/tasks') || pathname === '/v1/projects' || pathname === '/v1/search') {
                    return errorResponse('Method not allowed', 405);
                }
            }

            if (pathname === '/v1/data') {
                const token = getToken(req);
                if (!token) return unauthorizedResponse(req);
                if (!isAuthorizedToken(token, allowedAuthTokens)) return unauthorizedResponse(req);
                const key = tokenToKey(token);
                const dataRateKey = `${key}:${req.method}:${toRateLimitRoute(pathname)}`;
                const dataRateLimitResponse = checkRateLimit(dataRateKey, maxPerWindow);
                if (dataRateLimitResponse) return dataRateLimitResponse;
                const filePath = join(dataDir, `${key}.json`);

                if (req.method === 'GET') {
                    return await withWriteLock(key, async () => {
                        throwIfRequestAborted(requestAbortController.signal);
                        if (!existsSync(filePath)) {
                            const emptyData: AppData = { tasks: [], projects: [], sections: [], areas: [], settings: {} };
                            throwIfRequestAborted(requestAbortController.signal);
                            if (!existsSync(filePath)) writeData(filePath, emptyData);
                            return jsonResponse(emptyData);
                        }
                        const data = readData(filePath);
                        if (!data) return errorResponse('Failed to read data', 500);
                        const validated = validateAppData(data);
                        if (!validated.ok) {
                            logWarn('Stored cloud data failed validation', { key, error: validated.error });
                            return errorResponse('Stored data failed validation', 500);
                        }
                        return jsonResponse(validated.data);
                    });
                }

                if (req.method === 'PUT') {
                    const body = await readJsonBody(req, maxBodyBytes, requestAbortController.signal);
                    if (isBodyReadError(body)) {
                        const err = body.__mindwtrError;
                        return errorResponse(String(err?.message || 'Payload too large'), Number(err?.status) || 413);
                    }
                    if (!body) return errorResponse('Missing body');
                    if (typeof body !== 'object') return errorResponse('Invalid JSON body');
                    const validated = validateAppData(body);
                    if (!validated.ok) return errorResponse(validated.error, 400);
                    return await withWriteLock(key, async () => {
                        throwIfRequestAborted(requestAbortController.signal);
                        const existingData = loadAppData(filePath);
                        const incomingData = validated.data as AppData;
                        const mergedData = mergeAppData(existingData, incomingData);
                        const validatedMerged = validateAppData(mergedData);
                        if (!validatedMerged.ok) {
                            logWarn('Merged cloud data failed validation', { key, error: validatedMerged.error });
                            return errorResponse('Merged data failed validation', 500);
                        }
                        throwIfRequestAborted(requestAbortController.signal);
                        writeData(filePath, validatedMerged.data);
                        return jsonResponse({ ok: true });
                    });
                }
            }

            if (pathname.startsWith('/v1/attachments/')) {
                const token = getToken(req);
                if (!token) return unauthorizedResponse(req);
                if (!isAuthorizedToken(token, allowedAuthTokens)) return unauthorizedResponse(req);
                const key = tokenToKey(token);
                const attachmentRateKey = `${key}:${req.method}:${toRateLimitRoute(pathname)}`;
                const attachmentRateLimitResponse = checkRateLimit(attachmentRateKey, maxAttachmentPerWindow);
                if (attachmentRateLimitResponse) return attachmentRateLimitResponse;

                const resolvedAttachmentPath = resolveAttachmentPath(dataDir, key, pathname.slice('/v1/attachments/'.length));
                if (!resolvedAttachmentPath) {
                    return errorResponse('Invalid attachment path', 400);
                }
                const { rootRealPath, filePath } = resolvedAttachmentPath;

                if (req.method === 'GET') {
                    if (!existsSync(filePath)) return errorResponse('Not found', 404);
                    try {
                        const realFilePath = realpathSync(filePath);
                        if (!isPathWithinRoot(realFilePath, rootRealPath)) {
                            return errorResponse('Invalid attachment path', 400);
                        }
                        const file = readFileSync(realFilePath);
                        const headers = new Headers();
                        headers.set('Access-Control-Allow-Origin', corsOrigin);
                        headers.set('Content-Type', 'application/octet-stream');
                        return new Response(file, { status: 200, headers });
                    } catch {
                        return errorResponse('Failed to read attachment', 500);
                    }
                }

                if (req.method === 'PUT') {
                    const body = await readRequestBytes(req, maxAttachmentBytes, requestAbortController.signal);
                    if (isBodyReadError(body)) {
                        return errorResponse(body.__mindwtrError.message, body.__mindwtrError.status);
                    }
                    throwIfRequestAborted(requestAbortController.signal);
                    const wrote = writeAttachmentFileSafely(rootRealPath, filePath, body);
                    if (!wrote) return errorResponse('Invalid attachment path', 400);
                    return jsonResponse({ ok: true });
                }

                if (req.method === 'DELETE') {
                    if (!existsSync(filePath)) {
                        return jsonResponse({ ok: true });
                    }
                    try {
                        const realFilePath = realpathSync(filePath);
                        if (!isPathWithinRoot(realFilePath, rootRealPath)) {
                            return errorResponse('Invalid attachment path', 400);
                        }
                        unlinkSync(realFilePath);
                        return jsonResponse({ ok: true });
                    } catch {
                        return errorResponse('Failed to delete attachment', 500);
                    }
                }

                return errorResponse('Method not allowed', 405);
            }

                return errorResponse('Not found', 404);
            } catch (error) {
                if (isRequestAbortError(error)) {
                    return errorResponse(error.message, error.status);
                }
                if (error && typeof error === 'object' && 'code' in error) {
                    const code = (error as any).code;
                    if (code === 'EACCES') {
                        logError('permission denied writing cloud data', error);
                        return errorResponse('Cloud data directory is not writable. Check volume permissions.', 500);
                    }
                }
                logError('request failed', error);
                return errorResponse('Internal server error', 500);
            } finally {
                clearTimeout(requestTimeout);
            }
        },
    });

    return {
        port: server.port,
        stop: () => {
            clearInterval(cleanupTimer);
            try {
                (server as { stop?: (closeIdleConnections?: boolean) => void }).stop?.(true);
            } catch {
                // Ignore stop errors during teardown.
            }
        },
    };
}

const isMainModule = typeof Bun !== 'undefined' && (import.meta as ImportMeta & { main?: boolean }).main === true;
if (isMainModule) {
    startCloudServer().catch((err) => {
        logError('Failed to start server', err);
        process.exit(1);
    });
}
