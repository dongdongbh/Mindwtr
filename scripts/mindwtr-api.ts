#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

import {
    applyTaskUpdates,
    generateUUID,
    parseQuickAdd,
    searchAll,
    type AppData,
    type Task,
    type TaskStatus,
} from '@mindwtr/core';

import { resolveMindwtrDataPath } from './mindwtr-paths';

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
        '  bun run scripts/mindwtr-api.ts -- [--port 4317] [--host 127.0.0.1] [--data <path>]',
        '',
        'Options:',
        '  --port <n>     Port to listen on (default 4317)',
        '  --host <host>  Host to bind (default 127.0.0.1)',
        '  --data <path>  Override data.json location',
        '',
        'Environment:',
        '  MINDWTR_DATA       Override data.json location (if --data is omitted)',
        '  MINDWTR_API_TOKEN  If set, require Authorization: Bearer <token>',
    ];
    console.log(lines.join('\n'));
    process.exit(exitCode);
}

function loadAppData(path: string): AppData {
    try {
        const raw = readFileSync(path, 'utf8');
        const parsed = JSON.parse(raw) as Partial<AppData>;
        return {
            tasks: Array.isArray(parsed.tasks) ? (parsed.tasks as any) : [],
            projects: Array.isArray(parsed.projects) ? (parsed.projects as any) : [],
            settings: typeof parsed.settings === 'object' && parsed.settings ? (parsed.settings as any) : {},
        };
    } catch {
        return { tasks: [], projects: [], settings: {} };
    }
}

function saveAppData(path: string, data: AppData) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2));
}

function asStatus(value: unknown): TaskStatus | null {
    if (typeof value !== 'string') return null;
    const allowed: TaskStatus[] = ['inbox', 'todo', 'next', 'in-progress', 'waiting', 'someday', 'done', 'archived'];
    return allowed.includes(value as TaskStatus) ? (value as TaskStatus) : null;
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

function pickTaskList(data: AppData, opts: { includeDeleted: boolean; includeCompleted: boolean; status?: TaskStatus | null; query?: string }): Task[] {
    let tasks = data.tasks;
    if (!opts.includeDeleted) tasks = tasks.filter((t) => !t.deletedAt);
    if (!opts.includeCompleted) tasks = tasks.filter((t) => t.status !== 'done' && t.status !== 'archived');
    if (opts.status) tasks = tasks.filter((t) => t.status === opts.status);
    if (opts.query && opts.query.trim()) {
        tasks = searchAll(tasks, data.projects.filter((p) => !p.deletedAt), opts.query).tasks;
    }
    return tasks;
}

async function main() {
    const flags = parseArgs(process.argv.slice(2));
    if (flags.help) usage(0);

    const port = Number(flags.port || 4317);
    const host = String(flags.host || '127.0.0.1');
    const dataPath = resolveMindwtrDataPath(flags.data as string | undefined);

    let lock: Promise<void> = Promise.resolve();
    const withWriteLock = async <T>(fn: () => Promise<T>) => {
        const run = lock.then(fn, fn);
        lock = run.then(() => undefined, () => undefined);
        return run;
    };

    console.log(`[mindwtr-api] data: ${dataPath}`);
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
                const status = asStatus(url.searchParams.get('status'));

                const data = loadAppData(dataPath);
                const tasks = pickTaskList(data, {
                    includeDeleted,
                    includeCompleted: includeAll,
                    status,
                    query,
                });

                return jsonResponse({ tasks });
            }

            if (req.method === 'GET' && pathname === '/projects') {
                const data = loadAppData(dataPath);
                const projects = data.projects.filter((p) => !p.deletedAt);
                return jsonResponse({ projects });
            }

            if (req.method === 'GET' && pathname === '/search') {
                const query = url.searchParams.get('query') || '';
                const data = loadAppData(dataPath);
                const tasks = data.tasks.filter((t) => !t.deletedAt);
                const projects = data.projects.filter((p) => !p.deletedAt);
                const results = searchAll(tasks, projects, query);
                return jsonResponse(results);
            }

            if (req.method === 'POST' && pathname === '/tasks') {
                const body = await readJsonBody(req);
                if (body && typeof body === 'object' && '__mindwtrError' in body) {
                    const err = (body as any).__mindwtrError;
                    return errorResponse(String(err?.message || 'Payload too large'), Number(err?.status) || 413);
                }
                if (!body || typeof body !== 'object') return errorResponse('Invalid JSON body');

                return withWriteLock(async () => {
                    const data = loadAppData(dataPath);
                    const now = new Date().toISOString();

                    const input = typeof (body as any).input === 'string' ? String((body as any).input) : '';
                    const rawTitle = typeof (body as any).title === 'string' ? String((body as any).title) : '';
                    const initialProps = typeof (body as any).props === 'object' && (body as any).props ? (body as any).props : {};

                    const parsed = input ? parseQuickAdd(input, data.projects, new Date(now)) : { title: rawTitle, props: {} };
                    const title = (parsed.title || rawTitle || input).trim();
                    if (!title) return errorResponse('Missing task title');

                    const props: Partial<Task> = {
                        ...parsed.props,
                        ...initialProps,
                    };

                    const status = asStatus(props.status) || 'inbox';
                    const tags = Array.isArray(props.tags) ? (props.tags as any) : [];
                    const contexts = Array.isArray(props.contexts) ? (props.contexts as any) : [];
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
                        createdAt: now,
                        updatedAt: now,
                    } as Task;

                    data.tasks.push(task);
                    saveAppData(dataPath, data);
                    return jsonResponse({ task }, { status: 201 });
                });
            }

            const taskMatch = pathname.match(/^\/tasks\/([^/]+)$/);
            if (taskMatch) {
                const taskId = decodeURIComponent(taskMatch[1]);

                if (req.method === 'GET') {
                    const data = loadAppData(dataPath);
                    const task = data.tasks.find((t) => t.id === taskId);
                    if (!task) return errorResponse('Task not found', 404);
                    return jsonResponse({ task });
                }

                if (req.method === 'PATCH') {
                    const body = await readJsonBody(req);
                    if (body && typeof body === 'object' && '__mindwtrError' in body) {
                        const err = (body as any).__mindwtrError;
                        return errorResponse(String(err?.message || 'Payload too large'), Number(err?.status) || 413);
                    }
                    if (!body || typeof body !== 'object') return errorResponse('Invalid JSON body');

                    return withWriteLock(async () => {
                        const data = loadAppData(dataPath);
                        const idx = data.tasks.findIndex((t) => t.id === taskId);
                        if (idx < 0) return errorResponse('Task not found', 404);

                        const now = new Date().toISOString();
                        const existing = data.tasks[idx];
                        const updates = body as Partial<Task>;
                        const { updatedTask, nextRecurringTask } = applyTaskUpdates(existing, updates, now);

                        data.tasks[idx] = updatedTask;
                        if (nextRecurringTask) data.tasks.push(nextRecurringTask);
                        saveAppData(dataPath, data);
                        return jsonResponse({ task: updatedTask });
                    });
                }

                if (req.method === 'DELETE') {
                    return withWriteLock(async () => {
                        const data = loadAppData(dataPath);
                        const idx = data.tasks.findIndex((t) => t.id === taskId);
                        if (idx < 0) return errorResponse('Task not found', 404);

                        const now = new Date().toISOString();
                        const existing = data.tasks[idx];
                        data.tasks[idx] = { ...existing, deletedAt: now, updatedAt: now };
                        saveAppData(dataPath, data);
                        return jsonResponse({ ok: true });
                    });
                }
            }

            const actionMatch = pathname.match(/^\/tasks\/([^/]+)\/(complete|archive)$/);
            if (actionMatch && req.method === 'POST') {
                const taskId = decodeURIComponent(actionMatch[1]);
                const action = actionMatch[2];
                const status: TaskStatus = action === 'archive' ? 'archived' : 'done';

                return withWriteLock(async () => {
                    const data = loadAppData(dataPath);
                    const idx = data.tasks.findIndex((t) => t.id === taskId);
                    if (idx < 0) return errorResponse('Task not found', 404);

                    const now = new Date().toISOString();
                    const existing = data.tasks[idx];
                    const { updatedTask, nextRecurringTask } = applyTaskUpdates(existing, { status }, now);
                    data.tasks[idx] = updatedTask;
                    if (nextRecurringTask) data.tasks.push(nextRecurringTask);
                    saveAppData(dataPath, data);
                    return jsonResponse({ task: updatedTask });
                });
            }

            return errorResponse('Not found', 404);
        },
    });
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
