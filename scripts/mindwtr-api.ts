#!/usr/bin/env bun
import {
    type LogPayload,
    sanitizeForLog,
    sanitizeLogContext,
    type Section,
    setLogger,
    type Task,
} from '@mindwtr/core';
import { createHash, timingSafeEqual } from 'node:crypto';

import { asTaskStatus, createMindwtrAutomationService } from './mindwtr-automation-core';
import { helperTaskListResponse, helperTaskResponse, parseHelperIfMatch, validateHelperIdempotencyKey } from './mindwtr-helper-reliability';


setLogger((event: LogPayload) => {
    const context = sanitizeLogContext({
        ...event.context,
        ...(event.error !== undefined ? { error: event.error } : {}),
    });
    process.stderr.write(
        `${JSON.stringify({
            ts: new Date().toISOString(),
            level: event.level,
            scope: sanitizeForLog(event.scope ?? 'core'),
            ...(event.category ? { category: sanitizeForLog(event.category) } : {}),
            message: sanitizeForLog(event.message),
            ...(context ? { context } : {}),
        })}\n`,
    );
});

type Flags = Record<string, string | boolean>;

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

function usage(exitCode: number) {
    const lines = [
        'mindwtr-api',
        '',
        'Usage:',
        '  bun run scripts/mindwtr-api.ts -- [--port 4317] [--host 127.0.0.1] [--data <path>] [--db <path>]',
        '',
        'Options:',
        '  --port <n>     Port to listen on (default 4317)',
        '  --host <host>  Host to bind (default 127.0.0.1)',
        '  --data <path>  Override data.json location',
        '  --db <path>    Override mindwtr.db location',
        '  --dangerously-disable-auth',
        '                  Run without authentication (unsafe; loopback only is not browser-safe)',
        '',
        'Environment:',
        '  MINDWTR_DATA       Override data.json location (if --data is omitted)',
        '  MINDWTR_DB_PATH    Override mindwtr.db location (if --db is omitted)',
        '  MINDWTR_API_TOKEN  Required bearer token unless auth is dangerously disabled',
        '  MINDWTR_API_CORS_ORIGIN',
        '                      Optional exact http(s) origin allowed to call the API',
    ];
    console.log(lines.join('\n'));
    process.exit(exitCode);
}

const MAX_BODY_BYTES = Number(process.env.MINDWTR_API_MAX_BODY_BYTES || 1_000_000);
const encoder = new TextEncoder();

function baseJsonResponse(body: unknown, init: ResponseInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('Content-Type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(body, null, 2), { ...init, headers });
}

function applyCorsHeaders(req: Request, response: Response, configuredOrigin: string | null): Response {
    if (!configuredOrigin) return response;

    const headers = new Headers(response.headers);
    headers.append('Vary', 'Origin');
    if (req.headers.get('origin') === configuredOrigin) {
        headers.set('Access-Control-Allow-Origin', configuredOrigin);
        headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, If-Match, Idempotency-Key');
        headers.set('Access-Control-Expose-Headers', 'ETag');
        headers.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    }
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

function baseErrorResponse(message: string, status = 400) {
    return baseJsonResponse({ error: message }, { status });
}

function baseTaskErrorResponse(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (['task_version_conflict', 'idempotency_conflict', 'idempotency_capacity'].includes(message)) {
        return baseJsonResponse({ error: message, code: message }, { status: message === 'task_version_conflict' ? 412 : 409 });
    }
    if (message === 'Task not found' || message.startsWith('Task not found:')) {
        return baseErrorResponse('Task not found', 404);
    }
    if (message === 'Section not found' || message.startsWith('Section not found:')) {
        return baseErrorResponse('Section not found', 404);
    }
    return baseErrorResponse(message || 'Bad request', 400);
}

function resolveApiToken(flags: Flags, env: Record<string, string | undefined>): string | null {
    if (flags['dangerously-disable-auth'] === true) return null;
    const token = env.MINDWTR_API_TOKEN?.trim();
    if (!token) {
        throw new Error(
            'MINDWTR_API_TOKEN is required. Set a strong bearer token, or explicitly pass ' +
            '--dangerously-disable-auth only for isolated compatibility testing.'
        );
    }
    return token;
}

function resolveCorsOrigin(env: Record<string, string | undefined>): string | null {
    const value = env.MINDWTR_API_CORS_ORIGIN?.trim();
    if (!value) return null;

    try {
        const url = new URL(value);
        const isOriginOnly = url.pathname === '/' && !url.search && !url.hash
            && !url.username && !url.password;
        if (!['http:', 'https:'].includes(url.protocol) || !isOriginOnly || value === '*') {
            throw new Error('invalid origin');
        }
        return url.origin;
    } catch {
        throw new Error(
            'MINDWTR_API_CORS_ORIGIN must be one exact http(s) origin, for example ' +
            'https://automation.example.'
        );
    }
}

function bearerTokensEqual(expected: string, provided: string): boolean {
    const expectedDigest = createHash('sha256').update(expected).digest();
    const providedDigest = createHash('sha256').update(provided).digest();
    return timingSafeEqual(expectedDigest, providedDigest);
}

function requireAuth(req: Request, token: string | null): Response | null {
    if (token === null) return null;

    const header = (req.headers.get('authorization') || '').trim();
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
        return baseErrorResponse('Unauthorized', 401);
    }
    const value = match[1].trim();
    if (!bearerTokensEqual(token, value)) {
        return baseErrorResponse('Unauthorized', 401);
    }
    return null;
}

async function readJsonBody(req: Request): Promise<any> {
    const contentLength = Number(req.headers.get('content-length') || '0');
    if (contentLength && contentLength > MAX_BODY_BYTES) {
        return { __mindwtrError: { message: 'Payload too large', status: 413 } };
    }
    const text = await req.text();
    if (!text.trim()) return null;
    if (encoder.encode(text).length > MAX_BODY_BYTES) {
        return { __mindwtrError: { message: 'Payload too large', status: 413 } };
    }
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

async function main() {
    const flags = parseArgs(process.argv.slice(2));
    if (flags.help) usage(0);

    const port = Number(flags.port || 4317);
    const host = String(flags.host || '127.0.0.1');
    const apiToken = resolveApiToken(flags, process.env);
    const corsOrigin = resolveCorsOrigin(process.env);
    const service = await createMindwtrAutomationService({
        dataPath: flags.data as string | undefined,
        dbPath: flags.db as string | undefined,
    });

    let lock: Promise<void> = Promise.resolve();
    const withWriteLock = async <T>(fn: () => Promise<T>) => {
        const run = lock.then(fn, fn);
        lock = run.then(() => undefined, () => undefined);
        return run;
    };

    console.log(`[mindwtr-api] data: ${service.paths.dataPath}`);
    console.log(`[mindwtr-api] db: ${service.paths.dbPath}`);
    console.log(`[mindwtr-api] listening on http://${host}:${port}`);
    if (apiToken === null) {
        console.warn('[mindwtr-api] WARNING: authentication is dangerously disabled');
    }

    Bun.serve({
        hostname: host,
        port,
        async fetch(req) {
            const jsonResponse = (body: unknown, init: ResponseInit = {}) => {
                return applyCorsHeaders(req, baseJsonResponse(body, init), corsOrigin);
            };
            const errorResponse = (message: string, status = 400) => {
                return applyCorsHeaders(req, baseErrorResponse(message, status), corsOrigin);
            };
            const taskErrorResponse = (error: unknown) => {
                return applyCorsHeaders(req, baseTaskErrorResponse(error), corsOrigin);
            };
            const taskResponse = (task: Task, status = 200) => {
                const body = helperTaskResponse(task);
                return jsonResponse(body, { status, headers: { ETag: `"${body.version}"` } });
            };

            if (req.method === 'OPTIONS') return jsonResponse({ ok: true });

            const authError = requireAuth(req, apiToken);
            if (authError) return applyCorsHeaders(req, authError, corsOrigin);

            const url = new URL(req.url);
            const requestedPath = url.pathname.replace(/\/+$/, '') || '/';
            const protectedAction = /^\/v2\/tasks\/[^/]+\/(complete|archive)$/.test(requestedPath);
            if (requestedPath.startsWith('/v2/') && (!protectedAction || req.method !== 'POST')) return errorResponse('Not found', 404);
            const pathname = protectedAction ? requestedPath.slice(3)
                : requestedPath.replace(/^\/v1\/tasks(?=\/|$)/, '/tasks');
            const ifMatch = req.headers.get('if-match');
            const conditionalWrite = (req.method === 'PATCH' && /^\/tasks\/[^/]+$/.test(pathname))
                || (req.method === 'POST' && /^\/tasks\/[^/]+\/(complete|archive)$/.test(pathname));
            if (protectedAction && ifMatch === null) return errorResponse('Invalid If-Match');
            if (conditionalWrite && ifMatch !== null) {
                try { parseHelperIfMatch(ifMatch); } catch (error) { return taskErrorResponse(error); }
            }

            if (req.method === 'GET' && pathname === '/health') {
                return jsonResponse({ ok: true, implementation: 'bun-helper', apiVersion: 2, capabilities: {
                    taskListVersions: true, conditionalTaskPatch: true, idempotentTaskCreate: true, conditionalTaskActions: true,
                } });
            }

            if (req.method === 'GET' && pathname === '/tasks') {
                const query = url.searchParams.get('query') || '';
                const includeAll = url.searchParams.get('all') === '1';
                const includeDeleted = url.searchParams.get('deleted') === '1';
                const rawStatus = url.searchParams.get('status');
                const status = asTaskStatus(rawStatus);
                if (rawStatus && !status) {
                    return errorResponse(`Invalid status: ${rawStatus}`);
                }
                const rawFocused = url.searchParams.get('isFocusedToday');
                const normalizedFocused = rawFocused?.trim().toLowerCase();
                if (normalizedFocused !== undefined && !['1', 'true', '0', 'false'].includes(normalizedFocused)) {
                    return errorResponse(`Invalid isFocusedToday: ${rawFocused}`);
                }
                return jsonResponse(helperTaskListResponse(await service.listTasks({
                        includeAll,
                        includeDeleted,
                        status,
                        query,
                        isFocusedToday: normalizedFocused === undefined
                            ? undefined
                            : normalizedFocused === '1' || normalizedFocused === 'true',
                    })));
            }

            if (req.method === 'GET' && pathname === '/projects') {
                return jsonResponse({ projects: await service.listProjects() });
            }

            if (req.method === 'GET' && (pathname === '/areas' || pathname === '/v1/areas')) {
                return jsonResponse({ areas: await service.listAreas() });
            }

            if (req.method === 'GET' && (pathname === '/sections' || pathname === '/v1/sections')) {
                const projectId = url.searchParams.get('projectId') || undefined;
                return jsonResponse({ sections: await service.listSections(projectId) });
            }

            if (req.method === 'POST' && (pathname === '/sections' || pathname === '/v1/sections')) {
                const body = await readJsonBody(req);
                if (body && typeof body === 'object' && '__mindwtrError' in body) {
                    const err = (body as any).__mindwtrError;
                    return errorResponse(String(err?.message || 'Payload too large'), Number(err?.status) || 413);
                }
                if (!body || typeof body !== 'object') return errorResponse('Invalid JSON body');
                return withWriteLock(async () => {
                    const payload = body as any;
                    const propsInput = typeof payload.props === 'object' && payload.props ? payload.props : {};
                    const props: Partial<Section> = { ...propsInput };
                    if ('description' in payload) props.description = payload.description ?? undefined;
                    if ('order' in payload) props.order = payload.order;
                    if ('isCollapsed' in payload) props.isCollapsed = payload.isCollapsed;
                    try {
                        const section = await service.createSection({
                            projectId: typeof payload.projectId === 'string' ? payload.projectId : '',
                            title: typeof payload.title === 'string' ? payload.title : '',
                            props,
                        });
                        return jsonResponse({ section }, { status: 201 });
                    } catch (error) {
                        return taskErrorResponse(error);
                    }
                });
            }

            if (req.method === 'GET' && pathname === '/search') {
                const query = url.searchParams.get('query') || '';
                return jsonResponse(await service.search(query));
            }

            if (req.method === 'POST' && pathname === '/tasks') {
                const idempotencyKey = req.headers.get('idempotency-key');
                if (idempotencyKey !== null) {
                    try { validateHelperIdempotencyKey(idempotencyKey); } catch (error) { return taskErrorResponse(error); }
                }
                const body = await readJsonBody(req);
                if (body && typeof body === 'object' && '__mindwtrError' in body) {
                    const err = (body as any).__mindwtrError;
                    return errorResponse(String(err?.message || 'Payload too large'), Number(err?.status) || 413);
                }
                if (!body || typeof body !== 'object') return errorResponse('Invalid JSON body');

                return withWriteLock(async () => {
                    const input = typeof (body as any).input === 'string' ? String((body as any).input) : '';
                    const title = typeof (body as any).title === 'string' ? String((body as any).title) : '';
                    const payload = body as any;
                    const props = typeof payload.props === 'object' && payload.props ? { ...payload.props } : {};
                    if ('sectionId' in payload) props.sectionId = payload.sectionId ?? undefined;
                    try {
                        const task = await service.createTask({ input, title, props: props as Partial<Task> }, {
                            idempotencyKey: idempotencyKey ?? undefined,
                            credential: apiToken ?? undefined,
                        });
                        return taskResponse(task, 201);
                    } catch (error) {
                        return taskErrorResponse(error);
                    }
                });
            }

            const sectionMatch = pathname.match(/^\/(?:v1\/)?sections\/([^/]+)$/);
            if (sectionMatch) {
                const sectionId = decodeURIComponent(sectionMatch[1]);

                if (req.method === 'GET') {
                    try {
                        return jsonResponse({ section: await service.getSection(sectionId) });
                    } catch (error) {
                        return taskErrorResponse(error);
                    }
                }

                if (req.method === 'PATCH') {
                    const body = await readJsonBody(req);
                    if (body && typeof body === 'object' && '__mindwtrError' in body) {
                        const err = (body as any).__mindwtrError;
                        return errorResponse(String(err?.message || 'Payload too large'), Number(err?.status) || 413);
                    }
                    if (!body || typeof body !== 'object') return errorResponse('Invalid JSON body');
                    return withWriteLock(async () => {
                        try {
                            const section = await service.updateSection(sectionId, body as Partial<Section>);
                            return jsonResponse({ section });
                        } catch (error) {
                            return taskErrorResponse(error);
                        }
                    });
                }

                if (req.method === 'DELETE') {
                    return withWriteLock(async () => {
                        try {
                            await service.deleteSection(sectionId);
                            return jsonResponse({ ok: true });
                        } catch (error) {
                            return taskErrorResponse(error);
                        }
                    });
                }
            }

            const taskMatch = pathname.match(/^\/tasks\/([^/]+)$/);
            if (taskMatch) {
                const taskId = decodeURIComponent(taskMatch[1]);

                if (req.method === 'GET') {
                    try {
                        return taskResponse(await service.getTask(taskId));
                    } catch (error) {
                        return taskErrorResponse(error);
                    }
                }

                if (req.method === 'PATCH') {
                    const body = await readJsonBody(req);
                    if (body && typeof body === 'object' && '__mindwtrError' in body) {
                        const err = (body as any).__mindwtrError;
                        return errorResponse(String(err?.message || 'Payload too large'), Number(err?.status) || 413);
                    }
                    if (!body || typeof body !== 'object') return errorResponse('Invalid JSON body');

                    return withWriteLock(async () => {
                        try {
                            const task = await service.updateTask(taskId, body as Partial<Task>, ifMatch === null ? {} : { ifMatch });
                            return taskResponse(task);
                        } catch (error) {
                            return taskErrorResponse(error);
                        }
                    });
                }

                if (req.method === 'DELETE') {
                    return withWriteLock(async () => {
                        try {
                            await service.deleteTask(taskId);
                            return jsonResponse({ ok: true });
                        } catch (error) {
                            return taskErrorResponse(error);
                        }
                    });
                }
            }

            const actionMatch = pathname.match(/^\/tasks\/([^/]+)\/(complete|archive|restore)$/);
            if (actionMatch && req.method === 'POST') {
                const taskId = decodeURIComponent(actionMatch[1]);
                const action = actionMatch[2];

                return withWriteLock(async () => {
                    try {
                        const task = action === 'complete'
                            ? await service.completeTask(taskId, ifMatch === null ? {} : { ifMatch })
                            : action === 'archive'
                                ? await service.archiveTask(taskId, ifMatch === null ? {} : { ifMatch })
                                : await service.restoreTask(taskId);
                        return taskResponse(task);
                    } catch (error) {
                        return taskErrorResponse(error);
                    }
                });
            }

            return errorResponse('Not found', 404);
        },
    });
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
});
