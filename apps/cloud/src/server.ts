#!/usr/bin/env bun
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from 'fs';
import { join, relative } from 'path';
import {
    applyTaskUpdates,
    filterNotDeleted,
    generateUUID,
    mergeAppData,
    parseQuickAdd,
    repairMergedSyncReferences,
    searchAll,
    validateAttachmentForUpload,
    type Area,
    type Attachment,
    type AppData,
    type Project,
    type Section,
    type Task,
    type TaskStatus,
} from '@mindwtr/core';
import {
    getAuthFailureRateKey,
    getAuthFailureTokenRateKey,
    getClientIp,
    getToken,
    isAuthorizedToken,
    parseAllowedAuthTokens,
    parseBoolEnv,
    parseTrustedProxyIps,
    resolveAllowedAuthTokensFromEnv,
    toRateLimitRoute,
    tokenToKey,
} from './server-auth';
import {
    AUTH_FAILURE_RATE_MAX,
    CLOUD_API_REV_BY,
    corsOrigin,
    errorResponse,
    jsonResponse,
    logError,
    logInfo,
    logWarn,
    LIST_MAX_LIMIT,
    MAX_TASK_QUICK_ADD_LENGTH,
    MAX_TASK_TITLE_LENGTH,
    normalizeRevision,
    parseArgs,
    parsePagination,
    preflightResponse,
    RATE_LIMIT_MAX_KEYS,
    UUID_PATTERN,
} from './server-config';
import {
    createRequestAbortError,
    createWriteLockRunner,
    ensureWritableDir,
    isBodyReadError,
    isPathWithinRoot,
    isRequestAbortError,
    loadAppData,
    normalizeAttachmentRelativePath,
    pathContainsSymlink,
    readData,
    readJsonBody,
    readRequestBytes,
    resolveAttachmentPath,
    throwIfRequestAborted,
    writeAttachmentFileSafely,
    writeData,
} from './server-storage';
import {
    asStatus,
    pickTaskList,
    validateAppData,
    validateAreaCreationProps,
    validateAreaPatchProps,
    validateProjectCreationProps,
    validateProjectPatchProps,
    validateSectionCreationProps,
    validateSectionPatchProps,
    validateTaskCreationProps,
    validateTaskPatchProps,
} from './server-validation';

const normalizeAttachmentContentType = (value: string | null): string => value?.split(';', 1)[0]?.trim().toLowerCase() || '';
const ANY_TOKEN_NAMESPACE_LIMIT_DEFAULT = 32;
const TOKEN_NAMESPACE_FILE_PATTERN = /^([a-f0-9]{64})\.json$/;
const TOKEN_NAMESPACE_DIR_PATTERN = /^[a-f0-9]{64}$/;
// Relies on POSIX mtime; do not lower below 1 minute without auditing filesystem timestamp resolution and batching.
const ORPHAN_ATTACHMENT_GC_GRACE_MS = 5 * 60 * 1000;

const getBlockedAttachmentSignature = (bytes: Uint8Array): string | null => {
    if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
        return 'windows-pe';
    }
    if (bytes.length >= 4) {
        if (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) {
            return 'elf';
        }
        const signature = `${bytes[0].toString(16).padStart(2, '0')}${bytes[1].toString(16).padStart(2, '0')}`
            + `${bytes[2].toString(16).padStart(2, '0')}${bytes[3].toString(16).padStart(2, '0')}`;
        if (signature === 'feedface' || signature === 'feedfacf' || signature === 'cefaedfe' || signature === 'cffaedfe') {
            return 'mach-o';
        }
    }
    return null;
};

const generateRequestId = (): string => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const createInternalServerErrorResponse = (message: string, requestId: string): Response => (
    jsonResponse(
        { error: message, requestId },
        { status: 500, headers: { 'X-Request-Id': requestId } },
    )
);

const IS_MAIN_MODULE = typeof Bun !== 'undefined' && (import.meta as ImportMeta & { main?: boolean }).main === true;

type RateLimitState = {
    count: number;
    resetAt: number;
    lastSeenAt: number;
};

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

function parseEntityRouteId(rawValue: string): string | null {
    const decoded = decodePathParam(rawValue);
    const trimmed = decoded?.trim() ?? '';
    if (!trimmed || trimmed.length > 200 || trimmed.includes('/')) return null;
    return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const PROJECT_STATUSES = new Set<Project['status']>(['active', 'someday', 'waiting', 'archived']);

function asProjectStatus(value: unknown): Project['status'] | null {
    return PROJECT_STATUSES.has(value as Project['status']) ? value as Project['status'] : null;
}

function readObjectBody(body: unknown): Record<string, unknown> | null {
    return isRecord(body) ? body : null;
}

function nextOrder(items: Array<{ order?: number }>): number {
    return items.reduce((maxOrder, item) => (
        typeof item.order === 'number' && Number.isFinite(item.order)
            ? Math.max(maxOrder, item.order)
            : maxOrder
    ), -1) + 1;
}

function parseSearchPaginationValue(searchParams: URLSearchParams, name: string, fallback: number): number | { error: string } {
    const raw = searchParams.get(name);
    if (raw == null) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0 || (name.toLowerCase().includes('limit') && parsed <= 0)) {
        return { error: `Invalid ${name}` };
    }
    const value = Math.floor(parsed);
    return name.toLowerCase().includes('limit') ? Math.min(LIST_MAX_LIMIT, value) : value;
}

function finalizeCloudDataForWrite(data: AppData, nowIso: string): AppData | { error: Response } {
    const repaired = repairMergedSyncReferences(data, nowIso);
    const validated = validateAppData(repaired);
    if (!validated.ok) {
        return { error: errorResponse(validated.error, 400) };
    }
    return repaired;
}

function namespaceExists(dataDir: string, key: string): boolean {
    return existsSync(join(dataDir, `${key}.json`)) || existsSync(join(dataDir, key));
}

function countTokenNamespaces(dataDir: string): number {
    const namespaces = new Set<string>();
    for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
        if (entry.isFile()) {
            const match = entry.name.match(TOKEN_NAMESPACE_FILE_PATTERN);
            if (match?.[1]) namespaces.add(match[1]);
        } else if (entry.isDirectory() && TOKEN_NAMESPACE_DIR_PATTERN.test(entry.name)) {
            namespaces.add(entry.name);
        }
    }
    return namespaces.size;
}

function resolveServerMergeTimestamp(..._dataSets: AppData[]): string {
    return new Date().toISOString();
}

function collectReferencedAttachmentCloudKeys(data: AppData): Set<string> {
    const referenced = new Set<string>();
    const collect = (attachments: Attachment[] | undefined, ownerDeleted?: string) => {
        if (ownerDeleted) return;
        for (const attachment of attachments ?? []) {
            if (attachment.kind !== 'file' || attachment.deletedAt || !attachment.cloudKey) continue;
            const normalized = normalizeAttachmentRelativePath(attachment.cloudKey);
            if (normalized) referenced.add(normalized);
        }
    };
    data.tasks.forEach((task) => collect(task.attachments, task.deletedAt));
    data.projects.forEach((project) => collect(project.attachments, project.deletedAt));
    return referenced;
}

function garbageCollectOrphanAttachments(dataDir: string, key: string, data: AppData): {
    deleted: number;
    errors: string[];
    kept: number;
    scanned: number;
} {
    const rootDir = join(dataDir, key, 'attachments');
    if (!existsSync(rootDir)) return { deleted: 0, errors: [], kept: 0, scanned: 0 };
    mkdirSync(rootDir, { recursive: true });
    const rootStat = lstatSync(rootDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        return {
            deleted: 0,
            errors: ['attachment root is not a normal directory'],
            kept: 0,
            scanned: 0,
        };
    }
    const rootRealPath = realpathSync(rootDir);
    const referenced = collectReferencedAttachmentCloudKeys(data);
    const errors: string[] = [];
    let deleted = 0;
    let kept = 0;
    let scanned = 0;

    const visit = (dirPath: string) => {
        for (const dirent of readdirSync(dirPath, { withFileTypes: true })) {
            const entryPath = join(dirPath, dirent.name);
            let stat;
            try {
                stat = lstatSync(entryPath);
            } catch (error) {
                errors.push(`${relative(rootRealPath, entryPath)}: ${(error as Error).message}`);
                continue;
            }
            if (stat.isDirectory()) {
                visit(entryPath);
                try {
                    if (entryPath !== rootRealPath) rmdirSync(entryPath);
                } catch {
                    // Directory still has referenced files or concurrent writes.
                }
                continue;
            }

            scanned += 1;
            const relativePath = normalizeAttachmentRelativePath(relative(rootRealPath, entryPath).replace(/\\/g, '/'));
            if (!relativePath || referenced.has(relativePath)) {
                kept += 1;
                continue;
            }
            if (stat.mtimeMs > Date.now() - ORPHAN_ATTACHMENT_GC_GRACE_MS) {
                kept += 1;
                continue;
            }
            try {
                unlinkSync(entryPath);
                deleted += 1;
            } catch (error) {
                errors.push(`${relativePath}: ${(error as Error).message}`);
            }
        }
    };

    visit(rootRealPath);
    return { deleted, errors, kept, scanned };
}

export const __cloudTestUtils = {
    parseArgs,
    getToken,
    tokenToKey,
    parseAllowedAuthTokens,
    parseBoolEnv,
    parseTrustedProxyIps,
    resolveAllowedAuthTokensFromEnv,
    isAuthorizedToken,
    getClientIp,
    getAuthFailureRateKey,
    getAuthFailureTokenRateKey,
    toRateLimitRoute,
    validateAppData,
    asStatus,
    validateTaskCreationProps,
    validateTaskPatchProps,
    pickTaskList,
    readJsonBody,
    resolveServerMergeTimestamp,
    writeData,
    normalizeAttachmentRelativePath,
    isPathWithinRoot,
    pathContainsSymlink,
    createWriteLockRunner,
    createInternalServerErrorResponse,
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
    trustedProxyIps?: Set<string> | null;
    maxAnyTokenNamespaces?: number;
};

type CloudServerHandle = {
    stop: () => void;
    port: number;
};

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
    const allowedAuthTokens = options.allowedAuthTokens === undefined
        ? resolveAllowedAuthTokensFromEnv(process.env)
        : options.allowedAuthTokens;
    const trustProxyHeaders = options.trustProxyHeaders ?? parseBoolEnv(process.env.MINDWTR_CLOUD_TRUST_PROXY_HEADERS);
    const trustedProxyIps = options.trustedProxyIps ?? parseTrustedProxyIps(process.env.MINDWTR_CLOUD_TRUSTED_PROXY_IPS);
    const rawMaxAnyTokenNamespaces = Number(
        options.maxAnyTokenNamespaces
        ?? process.env.MINDWTR_CLOUD_ANY_TOKEN_MAX_NAMESPACES
        ?? ANY_TOKEN_NAMESPACE_LIMIT_DEFAULT
    );
    const maxAnyTokenNamespaces = Number.isFinite(rawMaxAnyTokenNamespaces) && rawMaxAnyTokenNamespaces >= 0
        ? Math.floor(rawMaxAnyTokenNamespaces)
        : ANY_TOKEN_NAMESPACE_LIMIT_DEFAULT;
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

    const ensureNamespaceWriteAllowed = (key: string): Response | null => {
        if (allowedAuthTokens) return null;
        if (namespaceExists(dataDir, key)) return null;
        if (maxAnyTokenNamespaces <= 0) {
            return errorResponse('Token namespace creation is disabled', 403);
        }
        if (countTokenNamespaces(dataDir) >= maxAnyTokenNamespaces) {
            return errorResponse('Token namespace limit reached', 403);
        }
        return null;
    };

    const unauthorizedResponse = (req: Request, token?: string | null): Response => {
        const requestIp = (() => {
            const bunServer = server as { requestIP?: (request: Request) => { address?: string | null } | null };
            if (typeof bunServer.requestIP !== 'function') return null;
            return bunServer.requestIP(req)?.address ?? null;
        })();
        const authRateKey = getAuthFailureRateKey(req, {
            trustProxyHeaders,
            trustedProxyIps,
            requestIpAddress: requestIp,
        });
        const authRateLimitKeys = [
            authRateKey,
            getAuthFailureTokenRateKey({
                token,
                authHeader: req.headers.get('authorization'),
            }),
        ].filter((key): key is string => Boolean(key));
        for (const key of authRateLimitKeys) {
            const authRateLimitResponse = checkRateLimit(key, AUTH_FAILURE_RATE_MAX);
            if (authRateLimitResponse) {
                return authRateLimitResponse;
            }
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
        && !String(process.env.MINDWTR_CLOUD_AUTH_TOKENS_FILE || '').trim()
        && (
            String(process.env.MINDWTR_CLOUD_TOKEN || '').trim().length > 0
            || String(process.env.MINDWTR_CLOUD_TOKEN_FILE || '').trim().length > 0
        );
    if (usingLegacyTokenVar) {
        logWarn('MINDWTR_CLOUD_TOKEN is deprecated; use MINDWTR_CLOUD_AUTH_TOKENS instead');
    }
    if (allowedAuthTokens) {
        logInfo('token auth allowlist enabled', { allowedTokens: String(allowedAuthTokens.size) });
    } else {
        logInfo('token namespace mode enabled by explicit opt-in', {
            hint: 'set MINDWTR_CLOUD_AUTH_TOKENS to enforce a strict token allowlist',
            maxNamespaces: String(maxAnyTokenNamespaces),
        });
    }
    if (trustProxyHeaders) {
        if (trustedProxyIps.size > 0) {
            logWarn('trusting proxy IP headers for auth failure rate limiting', {
                trustedProxyIps: String(trustedProxyIps.size),
                hint: 'only requests from MINDWTR_CLOUD_TRUSTED_PROXY_IPS can supply forwarded client IP headers',
            });
        } else {
            logWarn('MINDWTR_CLOUD_TRUST_PROXY_HEADERS is enabled but no trusted proxy IPs are configured; forwarded IP headers will be ignored', {
                hint: 'set MINDWTR_CLOUD_TRUSTED_PROXY_IPS to the exact reverse-proxy source IPs',
            });
        }
    }
    if (!ensureWritableDir(dataDir)) {
        throw new Error(`Cloud data directory is not writable: ${dataDir}`);
    }
    logInfo(`listening on http://${host}:${port}`);

    const server = Bun.serve({
        hostname: host,
        port,
        async fetch(req) {
            const requestId = generateRequestId();
            const requestAbortController = new AbortController();
            const requestTimeout = setTimeout(() => {
                requestAbortController.abort(createRequestAbortError('Request timed out', 408));
            }, requestTimeoutMs);
            try {
                throwIfRequestAborted(requestAbortController.signal);
                if (req.method === 'OPTIONS') return preflightResponse();

                const url = new URL(req.url);
                const pathname = url.pathname.replace(/\/+$/, '') || '/';

                if (req.method === 'GET' && pathname === '/health') {
                    return jsonResponse({ ok: true });
                }

                if (
                    pathname === '/v1/tasks'
                    || pathname === '/v1/projects'
                    || pathname === '/v1/sections'
                    || pathname === '/v1/areas'
                    || pathname === '/v1/search'
                    || pathname.startsWith('/v1/tasks/')
                    || pathname.startsWith('/v1/projects/')
                    || pathname.startsWith('/v1/sections/')
                    || pathname.startsWith('/v1/areas/')
                ) {
                    const token = getToken(req);
                    if (!token) return unauthorizedResponse(req);
                    if (!isAuthorizedToken(token, allowedAuthTokens)) return unauthorizedResponse(req, token);
                    const key = tokenToKey(token);
                    const routeKey = toRateLimitRoute(pathname);
                    const rateKey = `${key}:${req.method}:${routeKey}`;
                    const rateLimitResponse = checkRateLimit(rateKey, maxPerWindow);
                    if (rateLimitResponse) return rateLimitResponse;
                    const filePath = join(dataDir, `${key}.json`);
                    if (req.method !== 'GET') {
                        const namespaceResponse = ensureNamespaceWriteAllowed(key);
                        if (namespaceResponse) return namespaceResponse;
                    }

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
                            if (input.trim().length > MAX_TASK_QUICK_ADD_LENGTH) {
                                return errorResponse(`Quick-add input too long (max ${MAX_TASK_QUICK_ADD_LENGTH} characters)`, 400);
                            }

                            const parsed = input
                                ? parseQuickAdd(input, data.projects, new Date(nowIso), data.areas)
                                : { title: rawTitle, props: {} };
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
                            const { updatedTask, nextRecurringTask } = applyTaskUpdates(
                                existing,
                                {
                                    status,
                                    rev: normalizeRevision(existing.rev) + 1,
                                    revBy: CLOUD_API_REV_BY,
                                },
                                nowIso,
                            );
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
                                const { updatedTask, nextRecurringTask } = applyTaskUpdates(
                                    existing,
                                    {
                                        ...updates,
                                        rev: normalizeRevision(existing.rev) + 1,
                                        revBy: CLOUD_API_REV_BY,
                                    },
                                    nowIso,
                                );

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
                        const projects = url.searchParams.get('deleted') === '1' ? data.projects : filterNotDeleted(data.projects);
                        const total = projects.length;
                        const pageProjects = projects.slice(pagination.offset, pagination.offset + pagination.limit);
                        return jsonResponse({
                            projects: pageProjects,
                            total,
                            limit: pagination.limit,
                            offset: pagination.offset,
                        });
                    }

                    if (req.method === 'POST' && pathname === '/v1/projects') {
                        const body = await readJsonBody(req, maxBodyBytes, requestAbortController.signal);
                        if (isBodyReadError(body)) {
                            const err = body.__mindwtrError;
                            return errorResponse(String(err?.message || 'Payload too large'), Number(err?.status) || 413);
                        }
                        const bodyRecord = readObjectBody(body);
                        if (!bodyRecord) return errorResponse('Invalid JSON body');
                        const rawProps = isRecord(bodyRecord.props) ? bodyRecord.props : {};
                        const validatedProps = validateProjectCreationProps(rawProps);
                        if (!validatedProps.ok) return errorResponse(validatedProps.error, 400);
                        const title = typeof bodyRecord.title === 'string' ? bodyRecord.title.trim() : '';
                        if (!title) return errorResponse('Missing project title');
                        if (title.length > MAX_TASK_TITLE_LENGTH) return errorResponse(`Project title too long (max ${MAX_TASK_TITLE_LENGTH} characters)`, 400);
                        const props = validatedProps.props as Record<string, unknown>;
                        if (props.areaId !== undefined && typeof props.areaId !== 'string') return errorResponse('Invalid area id', 400);

                        return await withWriteLock(key, async () => {
                            throwIfRequestAborted(requestAbortController.signal);
                            const data = loadAppData(filePath);
                            const nowIso = new Date().toISOString();
                            const areaId = typeof props.areaId === 'string' ? props.areaId.trim() : '';
                            if (areaId && !data.areas.some((area) => area.id === areaId && !area.deletedAt)) {
                                return errorResponse('Area not found', 404);
                            }
                            const rawStatus = props.status;
                            const status = rawStatus === undefined ? 'active' : asProjectStatus(rawStatus);
                            if (!status) return errorResponse('Invalid project status', 400);
                            const rawOrder = props.order;
                            const rawTagIds = props.tagIds;
                            const {
                                status: _status,
                                color: rawColor,
                                order: _order,
                                tagIds: _tagIds,
                                areaId: _areaId,
                                ...restProps
                            } = props;
                            const project: Project = {
                                id: generateUUID(),
                                title,
                                ...restProps,
                                areaId: areaId || undefined,
                                status,
                                color: typeof rawColor === 'string' && rawColor.trim() ? rawColor : '#6B7280',
                                order: typeof rawOrder === 'number' && Number.isFinite(rawOrder) ? rawOrder : nextOrder(data.projects),
                                tagIds: Array.isArray(rawTagIds) ? rawTagIds.filter((item): item is string => typeof item === 'string') : [],
                                createdAt: nowIso,
                                updatedAt: nowIso,
                                rev: 1,
                                revBy: CLOUD_API_REV_BY,
                            };
                            data.projects.push(project);
                            const finalized = finalizeCloudDataForWrite(data, nowIso);
                            if ('error' in finalized) return finalized.error;
                            throwIfRequestAborted(requestAbortController.signal);
                            writeData(filePath, finalized);
                            return jsonResponse({ project }, { status: 201 });
                        });
                    }

                    const projectMatch = pathname.match(/^\/v1\/projects\/([^/]+)$/);
                    if (projectMatch) {
                        const projectId = parseEntityRouteId(projectMatch[1]);
                        if (!projectId) return errorResponse('Invalid project id', 400);

                        if (req.method === 'GET') {
                            const data = loadAppData(filePath);
                            const project = data.projects.find((item) => item.id === projectId && !item.deletedAt);
                            if (!project) return errorResponse('Project not found', 404);
                            return jsonResponse({ project });
                        }

                        if (req.method === 'PATCH') {
                            const body = await readJsonBody(req, maxBodyBytes, requestAbortController.signal);
                            if (isBodyReadError(body)) {
                                const err = body.__mindwtrError;
                                return errorResponse(String(err?.message || 'Payload too large'), Number(err?.status) || 413);
                            }
                            if (!readObjectBody(body)) return errorResponse('Invalid JSON body');
                            const validatedPatch = validateProjectPatchProps(body);
                            if (!validatedPatch.ok) return errorResponse(validatedPatch.error, 400);
                            const updates = validatedPatch.props;
                            if (typeof updates.title === 'string' && !updates.title.trim()) return errorResponse('Missing project title');
                            if (typeof updates.title === 'string' && updates.title.length > MAX_TASK_TITLE_LENGTH) {
                                return errorResponse(`Project title too long (max ${MAX_TASK_TITLE_LENGTH} characters)`, 400);
                            }
                            if (updates.status !== undefined && !asProjectStatus(updates.status)) return errorResponse('Invalid project status', 400);
                            if (updates.areaId !== undefined && updates.areaId !== null && typeof updates.areaId !== 'string') return errorResponse('Invalid area id', 400);
                            if (typeof updates.areaId === 'string' && updates.areaId.trim() === '') return errorResponse('Invalid area id', 400);

                            return await withWriteLock(key, async () => {
                                throwIfRequestAborted(requestAbortController.signal);
                                const data = loadAppData(filePath);
                                const idx = data.projects.findIndex((item) => item.id === projectId && !item.deletedAt);
                                if (idx < 0) return errorResponse('Project not found', 404);
                                const areaId = updates.areaId === null
                                    ? null
                                    : typeof updates.areaId === 'string'
                                        ? updates.areaId.trim()
                                        : undefined;
                                if (areaId && !data.areas.some((area) => area.id === areaId && !area.deletedAt)) {
                                    return errorResponse('Area not found', 404);
                                }
                                const nowIso = new Date().toISOString();
                                const existing = data.projects[idx];
                                data.projects[idx] = {
                                    ...existing,
                                    ...updates,
                                    title: typeof updates.title === 'string' ? updates.title.trim() : existing.title,
                                    areaId: areaId !== undefined ? areaId ?? undefined : existing.areaId,
                                    updatedAt: nowIso,
                                    rev: normalizeRevision(existing.rev) + 1,
                                    revBy: CLOUD_API_REV_BY,
                                };
                                const finalized = finalizeCloudDataForWrite(data, nowIso);
                                if ('error' in finalized) return finalized.error;
                                writeData(filePath, finalized);
                                const project = finalized.projects.find((item) => item.id === projectId);
                                return jsonResponse({ project });
                            });
                        }

                        if (req.method === 'DELETE') {
                            return await withWriteLock(key, async () => {
                                throwIfRequestAborted(requestAbortController.signal);
                                const data = loadAppData(filePath);
                                const idx = data.projects.findIndex((item) => item.id === projectId && !item.deletedAt);
                                if (idx < 0) return errorResponse('Project not found', 404);
                                const nowIso = new Date().toISOString();
                                const existing = data.projects[idx];
                                data.projects[idx] = {
                                    ...existing,
                                    deletedAt: nowIso,
                                    updatedAt: nowIso,
                                    rev: normalizeRevision(existing.rev) + 1,
                                    revBy: CLOUD_API_REV_BY,
                                };
                                const finalized = finalizeCloudDataForWrite(data, nowIso);
                                if ('error' in finalized) return finalized.error;
                                writeData(filePath, finalized);
                                return jsonResponse({ ok: true });
                            });
                        }
                    }

                    if (req.method === 'GET' && pathname === '/v1/sections') {
                        throwIfRequestAborted(requestAbortController.signal);
                        const pagination = parsePagination(url.searchParams);
                        if ('error' in pagination) return errorResponse(pagination.error, 400);
                        const data = loadAppData(filePath);
                        let sections = url.searchParams.get('deleted') === '1' ? data.sections : filterNotDeleted(data.sections);
                        const projectId = url.searchParams.get('projectId');
                        if (projectId) sections = sections.filter((section) => section.projectId === projectId);
                        const total = sections.length;
                        return jsonResponse({
                            sections: sections.slice(pagination.offset, pagination.offset + pagination.limit),
                            total,
                            limit: pagination.limit,
                            offset: pagination.offset,
                        });
                    }

                    if (req.method === 'POST' && pathname === '/v1/sections') {
                        const body = await readJsonBody(req, maxBodyBytes, requestAbortController.signal);
                        if (isBodyReadError(body)) {
                            const err = body.__mindwtrError;
                            return errorResponse(String(err?.message || 'Payload too large'), Number(err?.status) || 413);
                        }
                        const bodyRecord = readObjectBody(body);
                        if (!bodyRecord) return errorResponse('Invalid JSON body');
                        const rawProps = isRecord(bodyRecord.props) ? bodyRecord.props : {};
                        const validatedProps = validateSectionCreationProps(rawProps);
                        if (!validatedProps.ok) return errorResponse(validatedProps.error, 400);
                        const title = typeof bodyRecord.title === 'string' ? bodyRecord.title.trim() : '';
                        const projectId = typeof bodyRecord.projectId === 'string' ? bodyRecord.projectId.trim() : '';
                        if (!title) return errorResponse('Missing section title');
                        if (title.length > MAX_TASK_TITLE_LENGTH) return errorResponse(`Section title too long (max ${MAX_TASK_TITLE_LENGTH} characters)`, 400);
                        if (!projectId) return errorResponse('Missing project id');

                        return await withWriteLock(key, async () => {
                            throwIfRequestAborted(requestAbortController.signal);
                            const data = loadAppData(filePath);
                            if (!data.projects.some((project) => project.id === projectId && !project.deletedAt)) {
                                return errorResponse('Project not found', 404);
                            }
                            const nowIso = new Date().toISOString();
                            const props = validatedProps.props as Record<string, unknown>;
                            const rawOrder = props.order;
                            const { order: _order, ...restProps } = props;
                            const section: Section = {
                                id: generateUUID(),
                                projectId,
                                title,
                                ...restProps,
                                order: typeof rawOrder === 'number' && Number.isFinite(rawOrder)
                                    ? rawOrder
                                    : nextOrder(data.sections.filter((item) => item.projectId === projectId)),
                                createdAt: nowIso,
                                updatedAt: nowIso,
                                rev: 1,
                                revBy: CLOUD_API_REV_BY,
                            };
                            data.sections.push(section);
                            const finalized = finalizeCloudDataForWrite(data, nowIso);
                            if ('error' in finalized) return finalized.error;
                            writeData(filePath, finalized);
                            return jsonResponse({ section }, { status: 201 });
                        });
                    }

                    const sectionMatch = pathname.match(/^\/v1\/sections\/([^/]+)$/);
                    if (sectionMatch) {
                        const sectionId = parseEntityRouteId(sectionMatch[1]);
                        if (!sectionId) return errorResponse('Invalid section id', 400);

                        if (req.method === 'GET') {
                            const data = loadAppData(filePath);
                            const section = data.sections.find((item) => item.id === sectionId && !item.deletedAt);
                            if (!section) return errorResponse('Section not found', 404);
                            return jsonResponse({ section });
                        }

                        if (req.method === 'PATCH') {
                            const body = await readJsonBody(req, maxBodyBytes, requestAbortController.signal);
                            if (isBodyReadError(body)) {
                                const err = body.__mindwtrError;
                                return errorResponse(String(err?.message || 'Payload too large'), Number(err?.status) || 413);
                            }
                            if (!readObjectBody(body)) return errorResponse('Invalid JSON body');
                            const validatedPatch = validateSectionPatchProps(body);
                            if (!validatedPatch.ok) return errorResponse(validatedPatch.error, 400);
                            const updates = validatedPatch.props;
                            if (typeof updates.title === 'string' && !updates.title.trim()) return errorResponse('Missing section title');
                            if (typeof updates.title === 'string' && updates.title.length > MAX_TASK_TITLE_LENGTH) {
                                return errorResponse(`Section title too long (max ${MAX_TASK_TITLE_LENGTH} characters)`, 400);
                            }
                            if (updates.projectId !== undefined && typeof updates.projectId !== 'string') return errorResponse('Invalid project id', 400);

                            return await withWriteLock(key, async () => {
                                throwIfRequestAborted(requestAbortController.signal);
                                const data = loadAppData(filePath);
                                const idx = data.sections.findIndex((item) => item.id === sectionId && !item.deletedAt);
                                if (idx < 0) return errorResponse('Section not found', 404);
                                const projectId = typeof updates.projectId === 'string' ? updates.projectId.trim() : data.sections[idx].projectId;
                                if (!projectId) return errorResponse('Missing project id');
                                if (!data.projects.some((project) => project.id === projectId && !project.deletedAt)) {
                                    return errorResponse('Project not found', 404);
                                }
                                const nowIso = new Date().toISOString();
                                const existing = data.sections[idx];
                                data.sections[idx] = {
                                    ...existing,
                                    ...updates,
                                    projectId,
                                    title: typeof updates.title === 'string' ? updates.title.trim() : existing.title,
                                    updatedAt: nowIso,
                                    rev: normalizeRevision(existing.rev) + 1,
                                    revBy: CLOUD_API_REV_BY,
                                };
                                const finalized = finalizeCloudDataForWrite(data, nowIso);
                                if ('error' in finalized) return finalized.error;
                                writeData(filePath, finalized);
                                const section = finalized.sections.find((item) => item.id === sectionId);
                                return jsonResponse({ section });
                            });
                        }

                        if (req.method === 'DELETE') {
                            return await withWriteLock(key, async () => {
                                throwIfRequestAborted(requestAbortController.signal);
                                const data = loadAppData(filePath);
                                const idx = data.sections.findIndex((item) => item.id === sectionId && !item.deletedAt);
                                if (idx < 0) return errorResponse('Section not found', 404);
                                const nowIso = new Date().toISOString();
                                const existing = data.sections[idx];
                                data.sections[idx] = {
                                    ...existing,
                                    deletedAt: nowIso,
                                    updatedAt: nowIso,
                                    rev: normalizeRevision(existing.rev) + 1,
                                    revBy: CLOUD_API_REV_BY,
                                };
                                const finalized = finalizeCloudDataForWrite(data, nowIso);
                                if ('error' in finalized) return finalized.error;
                                writeData(filePath, finalized);
                                return jsonResponse({ ok: true });
                            });
                        }
                    }

                    if (req.method === 'GET' && pathname === '/v1/areas') {
                        throwIfRequestAborted(requestAbortController.signal);
                        const pagination = parsePagination(url.searchParams);
                        if ('error' in pagination) return errorResponse(pagination.error, 400);
                        const data = loadAppData(filePath);
                        const areas = url.searchParams.get('deleted') === '1' ? data.areas : filterNotDeleted(data.areas);
                        const total = areas.length;
                        return jsonResponse({
                            areas: areas.slice(pagination.offset, pagination.offset + pagination.limit),
                            total,
                            limit: pagination.limit,
                            offset: pagination.offset,
                        });
                    }

                    if (req.method === 'POST' && pathname === '/v1/areas') {
                        const body = await readJsonBody(req, maxBodyBytes, requestAbortController.signal);
                        if (isBodyReadError(body)) {
                            const err = body.__mindwtrError;
                            return errorResponse(String(err?.message || 'Payload too large'), Number(err?.status) || 413);
                        }
                        const bodyRecord = readObjectBody(body);
                        if (!bodyRecord) return errorResponse('Invalid JSON body');
                        const rawProps = isRecord(bodyRecord.props) ? bodyRecord.props : {};
                        const validatedProps = validateAreaCreationProps(rawProps);
                        if (!validatedProps.ok) return errorResponse(validatedProps.error, 400);
                        const name = typeof bodyRecord.name === 'string' ? bodyRecord.name.trim() : '';
                        if (!name) return errorResponse('Missing area name');
                        if (name.length > MAX_TASK_TITLE_LENGTH) return errorResponse(`Area name too long (max ${MAX_TASK_TITLE_LENGTH} characters)`, 400);

                        return await withWriteLock(key, async () => {
                            throwIfRequestAborted(requestAbortController.signal);
                            const data = loadAppData(filePath);
                            const nowIso = new Date().toISOString();
                            const props = validatedProps.props as Record<string, unknown>;
                            const rawOrder = props.order;
                            const { order: _order, ...restProps } = props;
                            const area: Area = {
                                id: generateUUID(),
                                name,
                                ...restProps,
                                order: typeof rawOrder === 'number' && Number.isFinite(rawOrder) ? rawOrder : nextOrder(data.areas),
                                createdAt: nowIso,
                                updatedAt: nowIso,
                                rev: 1,
                                revBy: CLOUD_API_REV_BY,
                            };
                            data.areas.push(area);
                            const finalized = finalizeCloudDataForWrite(data, nowIso);
                            if ('error' in finalized) return finalized.error;
                            writeData(filePath, finalized);
                            return jsonResponse({ area }, { status: 201 });
                        });
                    }

                    const areaMatch = pathname.match(/^\/v1\/areas\/([^/]+)$/);
                    if (areaMatch) {
                        const areaId = parseEntityRouteId(areaMatch[1]);
                        if (!areaId) return errorResponse('Invalid area id', 400);

                        if (req.method === 'GET') {
                            const data = loadAppData(filePath);
                            const area = data.areas.find((item) => item.id === areaId && !item.deletedAt);
                            if (!area) return errorResponse('Area not found', 404);
                            return jsonResponse({ area });
                        }

                        if (req.method === 'PATCH') {
                            const body = await readJsonBody(req, maxBodyBytes, requestAbortController.signal);
                            if (isBodyReadError(body)) {
                                const err = body.__mindwtrError;
                                return errorResponse(String(err?.message || 'Payload too large'), Number(err?.status) || 413);
                            }
                            if (!readObjectBody(body)) return errorResponse('Invalid JSON body');
                            const validatedPatch = validateAreaPatchProps(body);
                            if (!validatedPatch.ok) return errorResponse(validatedPatch.error, 400);
                            const updates = validatedPatch.props;
                            if (typeof updates.name === 'string' && !updates.name.trim()) return errorResponse('Missing area name');
                            if (typeof updates.name === 'string' && updates.name.length > MAX_TASK_TITLE_LENGTH) {
                                return errorResponse(`Area name too long (max ${MAX_TASK_TITLE_LENGTH} characters)`, 400);
                            }

                            return await withWriteLock(key, async () => {
                                throwIfRequestAborted(requestAbortController.signal);
                                const data = loadAppData(filePath);
                                const idx = data.areas.findIndex((item) => item.id === areaId && !item.deletedAt);
                                if (idx < 0) return errorResponse('Area not found', 404);
                                const nowIso = new Date().toISOString();
                                const existing = data.areas[idx];
                                data.areas[idx] = {
                                    ...existing,
                                    ...updates,
                                    name: typeof updates.name === 'string' ? updates.name.trim() : existing.name,
                                    updatedAt: nowIso,
                                    rev: normalizeRevision(existing.rev) + 1,
                                    revBy: CLOUD_API_REV_BY,
                                };
                                const finalized = finalizeCloudDataForWrite(data, nowIso);
                                if ('error' in finalized) return finalized.error;
                                writeData(filePath, finalized);
                                const area = finalized.areas.find((item) => item.id === areaId);
                                return jsonResponse({ area });
                            });
                        }

                        if (req.method === 'DELETE') {
                            return await withWriteLock(key, async () => {
                                throwIfRequestAborted(requestAbortController.signal);
                                const data = loadAppData(filePath);
                                const idx = data.areas.findIndex((item) => item.id === areaId && !item.deletedAt);
                                if (idx < 0) return errorResponse('Area not found', 404);
                                const nowIso = new Date().toISOString();
                                const existing = data.areas[idx];
                                data.areas[idx] = {
                                    ...existing,
                                    deletedAt: nowIso,
                                    updatedAt: nowIso,
                                    rev: normalizeRevision(existing.rev) + 1,
                                    revBy: CLOUD_API_REV_BY,
                                };
                                const finalized = finalizeCloudDataForWrite(data, nowIso);
                                if ('error' in finalized) return finalized.error;
                                writeData(filePath, finalized);
                                return jsonResponse({ ok: true });
                            });
                        }
                    }

                    if (req.method === 'GET' && pathname === '/v1/search') {
                        throwIfRequestAborted(requestAbortController.signal);
                        const query = url.searchParams.get('query') || '';
                        const pagination = parsePagination(url.searchParams);
                        if ('error' in pagination) return errorResponse(pagination.error, 400);
                        const taskOffset = parseSearchPaginationValue(url.searchParams, 'taskOffset', pagination.offset);
                        if (typeof taskOffset !== 'number') return errorResponse(taskOffset.error, 400);
                        const projectOffset = parseSearchPaginationValue(url.searchParams, 'projectOffset', pagination.offset);
                        if (typeof projectOffset !== 'number') return errorResponse(projectOffset.error, 400);
                        const taskLimit = parseSearchPaginationValue(url.searchParams, 'taskLimit', pagination.limit);
                        if (typeof taskLimit !== 'number') return errorResponse(taskLimit.error, 400);
                        const projectLimit = parseSearchPaginationValue(url.searchParams, 'projectLimit', pagination.limit);
                        if (typeof projectLimit !== 'number') return errorResponse(projectLimit.error, 400);
                        const data = loadAppData(filePath);
                        const tasks = filterNotDeleted(data.tasks);
                        const projects = filterNotDeleted(data.projects);
                        const results = searchAll(tasks, projects, query);
                        const taskTotal = results.tasks.length;
                        const projectTotal = results.projects.length;
                        return jsonResponse({
                            tasks: results.tasks.slice(taskOffset, taskOffset + taskLimit),
                            projects: results.projects.slice(projectOffset, projectOffset + projectLimit),
                            taskTotal,
                            projectTotal,
                            limit: pagination.limit,
                            offset: pagination.offset,
                            taskLimit,
                            taskOffset,
                            projectLimit,
                            projectOffset,
                        });
                    }

                    if (
                        pathname.startsWith('/v1/tasks')
                        || pathname.startsWith('/v1/projects')
                        || pathname.startsWith('/v1/sections')
                        || pathname.startsWith('/v1/areas')
                        || pathname === '/v1/search'
                    ) {
                        return errorResponse('Method not allowed', 405);
                    }
                }

                if (pathname === '/v1/data') {
                    const token = getToken(req);
                    if (!token) return unauthorizedResponse(req);
                    if (!isAuthorizedToken(token, allowedAuthTokens)) return unauthorizedResponse(req, token);
                    const key = tokenToKey(token);
                    const dataRateKey = `${key}:${req.method}:${toRateLimitRoute(pathname)}`;
                    const dataRateLimitResponse = checkRateLimit(dataRateKey, maxPerWindow);
                    if (dataRateLimitResponse) return dataRateLimitResponse;
                    const filePath = join(dataDir, `${key}.json`);

                    if (req.method === 'GET') {
                        return await withWriteLock(key, async () => {
                            throwIfRequestAborted(requestAbortController.signal);
                            if (!existsSync(filePath)) {
                                const namespaceResponse = ensureNamespaceWriteAllowed(key);
                                if (namespaceResponse) return namespaceResponse;
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
                        const namespaceResponse = ensureNamespaceWriteAllowed(key);
                        if (namespaceResponse) return namespaceResponse;
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
                            const mergedData = mergeAppData(existingData, incomingData, {
                                nowIso: resolveServerMergeTimestamp(existingData, incomingData),
                            });
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

                if (pathname === '/v1/attachments/orphans') {
                    const token = getToken(req);
                    if (!token) return unauthorizedResponse(req);
                    if (!isAuthorizedToken(token, allowedAuthTokens)) return unauthorizedResponse(req, token);
                    const key = tokenToKey(token);
                    const attachmentRateKey = `${key}:${req.method}:${toRateLimitRoute(pathname)}`;
                    const attachmentRateLimitResponse = checkRateLimit(attachmentRateKey, maxAttachmentPerWindow);
                    if (attachmentRateLimitResponse) return attachmentRateLimitResponse;
                    if (req.method !== 'POST' && req.method !== 'DELETE') {
                        return errorResponse('Method not allowed', 405);
                    }

                    return await withWriteLock(key, async () => {
                        throwIfRequestAborted(requestAbortController.signal);
                        const filePath = join(dataDir, `${key}.json`);
                        const data = loadAppData(filePath);
                        const validated = validateAppData(data);
                        if (!validated.ok) {
                            logWarn('Stored cloud data failed validation before attachment GC', { key, error: validated.error });
                            return errorResponse('Stored data failed validation', 500);
                        }
                        const result = garbageCollectOrphanAttachments(dataDir, key, data);
                        return jsonResponse({ ok: result.errors.length === 0, ...result });
                    });
                }

                if (pathname.startsWith('/v1/attachments/')) {
                    const token = getToken(req);
                    if (!token) return unauthorizedResponse(req);
                    if (!isAuthorizedToken(token, allowedAuthTokens)) return unauthorizedResponse(req, token);
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
                        const namespaceResponse = ensureNamespaceWriteAllowed(key);
                        if (namespaceResponse) return namespaceResponse;
                        const contentType = normalizeAttachmentContentType(req.headers.get('content-type'));
                        if (contentType) {
                            const validation = await validateAttachmentForUpload({
                                id: 'attachment-upload',
                                kind: 'file',
                                title: pathname,
                                createdAt: '1970-01-01T00:00:00.000Z',
                                updatedAt: '1970-01-01T00:00:00.000Z',
                                mimeType: contentType,
                            } satisfies Attachment, 0);
                            if (!validation.valid && validation.error === 'mime_type_blocked') {
                                return errorResponse(`Blocked attachment content type: ${validation.details}`, 400);
                            }
                        }
                        const body = await readRequestBytes(req, maxAttachmentBytes, requestAbortController.signal);
                        if (isBodyReadError(body)) {
                            return errorResponse(body.__mindwtrError.message, body.__mindwtrError.status);
                        }
                        const blockedSignature = getBlockedAttachmentSignature(body);
                        if (blockedSignature) {
                            return errorResponse(`Blocked executable attachment signature: ${blockedSignature}`, 400);
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
                        logError(`permission denied writing cloud data (requestId=${requestId})`, error);
                        return createInternalServerErrorResponse(
                            'Cloud data directory is not writable. Check volume permissions.',
                            requestId,
                        );
                    }
                }
                logError(`request failed (requestId=${requestId})`, error);
                return createInternalServerErrorResponse('Internal server error', requestId);
            } finally {
                clearTimeout(requestTimeout);
            }
        },
    });

    let stopped = false;
    const stopServer = async () => {
        if (stopped) return;
        stopped = true;
        clearInterval(cleanupTimer);
        try {
            await Promise.resolve((server as { stop?: (closeIdleConnections?: boolean) => void | Promise<void> }).stop?.(true));
        } catch {
            // Ignore stop errors during teardown.
        }
    };
    const signalHandlers: Array<[NodeJS.Signals, () => void]> = [];
    if (IS_MAIN_MODULE) {
        const handleSignal = (signal: NodeJS.Signals) => {
            logInfo(`received ${signal}, shutting down`);
            void stopServer().finally(() => process.exit(0));
        };
        for (const signal of ['SIGINT', 'SIGTERM'] as NodeJS.Signals[]) {
            const handler = () => handleSignal(signal);
            signalHandlers.push([signal, handler]);
            process.once(signal, handler);
        }
    }

    return {
        port: server.port,
        stop: () => {
            for (const [signal, handler] of signalHandlers) {
                process.off(signal, handler);
            }
            void stopServer();
        },
    };
}

if (IS_MAIN_MODULE) {
    startCloudServer().catch((err) => {
        logError('Failed to start server', err);
        process.exit(1);
    });
}
