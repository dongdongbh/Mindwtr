#!/usr/bin/env bun
import { existsSync, readFileSync, realpathSync, unlinkSync } from 'fs';
import { join } from 'path';
import {
    applyTaskUpdates,
    generateUUID,
    mergeAppData,
    parseQuickAdd,
    searchAll,
    validateAttachmentForUpload,
    type Attachment,
    type AppData,
    type Task,
    type TaskStatus,
} from '@mindwtr/core';
import {
    getAuthFailureRateKey,
    getClientIp,
    getToken,
    isAuthorizedToken,
    parseAllowedAuthTokens,
    parseBoolEnv,
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
    MAX_TASK_QUICK_ADD_LENGTH,
    MAX_TASK_TITLE_LENGTH,
    normalizeRevision,
    parseArgs,
    parsePagination,
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
    validateTaskCreationProps,
    validateTaskPatchProps,
} from './server-validation';

const normalizeAttachmentContentType = (value: string | null): string => value?.split(';', 1)[0]?.trim().toLowerCase() || '';

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

type RateLimitState = {
    count: number;
    resetAt: number;
    lastSeenAt: number;
};

const shutdown = (signal: string) => {
    logInfo(`received ${signal}, shutting down`);
    process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

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

export const __cloudTestUtils = {
    parseArgs,
    getToken,
    tokenToKey,
    parseAllowedAuthTokens,
    parseBoolEnv,
    resolveAllowedAuthTokensFromEnv,
    isAuthorizedToken,
    getClientIp,
    getAuthFailureRateKey,
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

    const unauthorizedResponse = (req: Request, token?: string | null): Response => {
        const requestIp = (() => {
            const bunServer = server as { requestIP?: (request: Request) => { address?: string | null } | null };
            if (typeof bunServer.requestIP !== 'function') return null;
            return bunServer.requestIP(req)?.address ?? null;
        })();
        const authRateKey = getAuthFailureRateKey(req, {
            trustProxyHeaders,
            requestIpAddress: requestIp,
            token,
            authHeader: req.headers.get('authorization'),
        });
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
            const requestId = generateRequestId();
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
                    pathname === '/v1/tasks'
                    || pathname === '/v1/projects'
                    || pathname === '/v1/search'
                    || pathname.startsWith('/v1/tasks/')
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
                        const pagination = parsePagination(url.searchParams);
                        if ('error' in pagination) return errorResponse(pagination.error, 400);
                        const data = loadAppData(filePath);
                        const tasks = data.tasks.filter((t) => !t.deletedAt);
                        const projects = data.projects.filter((p: any) => !p.deletedAt);
                        const results = searchAll(tasks, projects, query);
                        const taskTotal = results.tasks.length;
                        const projectTotal = results.projects.length;
                        return jsonResponse({
                            tasks: results.tasks.slice(pagination.offset, pagination.offset + pagination.limit),
                            projects: results.projects.slice(pagination.offset, pagination.offset + pagination.limit),
                            taskTotal,
                            projectTotal,
                            limit: pagination.limit,
                            offset: pagination.offset,
                        });
                    }

                    if (pathname.startsWith('/v1/tasks') || pathname === '/v1/projects' || pathname === '/v1/search') {
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
