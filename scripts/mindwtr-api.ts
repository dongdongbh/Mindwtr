#!/usr/bin/env bun
import { type Task } from '@mindwtr/core';

import { asTaskStatus, createMindwtrAutomationService } from './mindwtr-automation-core';

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
        '',
        'Environment:',
        '  MINDWTR_DATA       Override data.json location (if --data is omitted)',
        '  MINDWTR_DB_PATH    Override mindwtr.db location (if --db is omitted)',
        '  MINDWTR_API_TOKEN  If set, require Authorization: Bearer <token>',
    ];
    console.log(lines.join('\n'));
    process.exit(exitCode);
}

const MAX_BODY_BYTES = Number(process.env.MINDWTR_API_MAX_BODY_BYTES || 1_000_000);
const encoder = new TextEncoder();
const corsOrigin = process.env.MINDWTR_API_CORS_ORIGIN || '*';

function jsonResponse(body: unknown, init: ResponseInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('Content-Type', 'application/json; charset=utf-8');
    headers.set('Access-Control-Allow-Origin', corsOrigin);
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    headers.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    return new Response(JSON.stringify(body, null, 2), { ...init, headers });
}

function errorResponse(message: string, status = 400) {
    return jsonResponse({ error: message }, { status });
}

function taskErrorResponse(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'Task not found' || message.startsWith('Task not found:')) {
        return errorResponse('Task not found', 404);
    }
    return errorResponse(message || 'Bad request', 400);
}

function requireAuth(req: Request): Response | null {
    const token = process.env.MINDWTR_API_TOKEN;
    if (!token) return null;

    const header = (req.headers.get('authorization') || '').trim();
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
        return errorResponse('Unauthorized', 401);
    }
    const expected = token.trim();
    const value = match[1].trim();
    if (value !== expected) {
        return errorResponse('Unauthorized', 401);
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

    Bun.serve({
        hostname: host,
        port,
        async fetch(req) {
            if (req.method === 'OPTIONS') return jsonResponse({ ok: true });

            const authError = requireAuth(req);
            if (authError) return authError;

            const url = new URL(req.url);
            const pathname = url.pathname.replace(/\/+$/, '') || '/';

            if (req.method === 'GET' && pathname === '/health') {
                return jsonResponse({ ok: true });
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
                return jsonResponse({
                    tasks: await service.listTasks({
                        includeAll,
                        includeDeleted,
                        status,
                        query,
                    }),
                });
            }

            if (req.method === 'GET' && pathname === '/projects') {
                return jsonResponse({ projects: await service.listProjects() });
            }

            if (req.method === 'GET' && (pathname === '/areas' || pathname === '/v1/areas')) {
                return jsonResponse({ areas: await service.listAreas() });
            }

            if (req.method === 'GET' && pathname === '/search') {
                const query = url.searchParams.get('query') || '';
                return jsonResponse(await service.search(query));
            }

            if (req.method === 'POST' && pathname === '/tasks') {
                const body = await readJsonBody(req);
                if (body && typeof body === 'object' && '__mindwtrError' in body) {
                    const err = (body as any).__mindwtrError;
                    return errorResponse(String(err?.message || 'Payload too large'), Number(err?.status) || 413);
                }
                if (!body || typeof body !== 'object') return errorResponse('Invalid JSON body');

                return withWriteLock(async () => {
                    const input = typeof (body as any).input === 'string' ? String((body as any).input) : '';
                    const title = typeof (body as any).title === 'string' ? String((body as any).title) : '';
                    const props = typeof (body as any).props === 'object' && (body as any).props ? (body as any).props : {};
                    try {
                        const task = await service.createTask({ input, title, props: props as Partial<Task> });
                        return jsonResponse({ task }, { status: 201 });
                    } catch (error) {
                        return taskErrorResponse(error);
                    }
                });
            }

            const taskMatch = pathname.match(/^\/tasks\/([^/]+)$/);
            if (taskMatch) {
                const taskId = decodeURIComponent(taskMatch[1]);

                if (req.method === 'GET') {
                    try {
                        return jsonResponse({ task: await service.getTask(taskId) });
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
                            const task = await service.updateTask(taskId, body as Partial<Task>);
                            return jsonResponse({ task });
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
                            ? await service.completeTask(taskId)
                            : action === 'archive'
                                ? await service.archiveTask(taskId)
                                : await service.restoreTask(taskId);
                        return jsonResponse({ task });
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
