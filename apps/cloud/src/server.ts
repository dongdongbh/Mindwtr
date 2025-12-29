#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join } from 'path';

type Flags = Record<string, string | boolean>;

type RateLimitState = {
    count: number;
    resetAt: number;
};

const corsOrigin = process.env.MINDWTR_CLOUD_CORS_ORIGIN || '*';

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

function jsonResponse(body: unknown, init: ResponseInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('Content-Type', 'application/json; charset=utf-8');
    headers.set('Access-Control-Allow-Origin', corsOrigin);
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    headers.set('Access-Control-Allow-Methods', 'GET,PUT,OPTIONS');
    return new Response(JSON.stringify(body, null, 2), { ...init, headers });
}

function errorResponse(message: string, status = 400) {
    return jsonResponse({ error: message }, { status });
}

function getToken(req: Request): string | null {
    const auth = req.headers.get('authorization') || '';
    const match = auth.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : null;
}

function tokenToKey(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateAppData(value: unknown): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
    if (!isRecord(value)) return { ok: false, error: 'Invalid data: expected an object' };
    const tasks = value.tasks;
    const projects = value.projects;
    const settings = value.settings;

    if (!Array.isArray(tasks)) return { ok: false, error: 'Invalid data: tasks must be an array' };
    if (!Array.isArray(projects)) return { ok: false, error: 'Invalid data: projects must be an array' };
    if (settings !== undefined && !isRecord(settings)) return { ok: false, error: 'Invalid data: settings must be an object' };

    for (const task of tasks) {
        if (!isRecord(task) || typeof task.id !== 'string' || typeof task.title !== 'string') {
            return { ok: false, error: 'Invalid data: each task must be an object with string id and title' };
        }
    }

    for (const project of projects) {
        if (!isRecord(project) || typeof project.id !== 'string' || typeof project.title !== 'string') {
            return { ok: false, error: 'Invalid data: each project must be an object with string id and title' };
        }
    }

    return { ok: true, data: value };
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
    writeFileSync(filePath, JSON.stringify(data, null, 2));
}

async function main() {
    const flags = parseArgs(process.argv.slice(2));
    const port = Number(flags.port || process.env.PORT || 8787);
    const host = String(flags.host || process.env.HOST || '0.0.0.0');
    const dataDir = String(process.env.MINDWTR_CLOUD_DATA_DIR || join(process.cwd(), 'data'));

    const rateLimits = new Map<string, RateLimitState>();
    const windowMs = Number(process.env.MINDWTR_CLOUD_RATE_WINDOW_MS || 60_000);
    const maxPerWindow = Number(process.env.MINDWTR_CLOUD_RATE_MAX || 120);
    const maxBodyBytes = Number(process.env.MINDWTR_CLOUD_MAX_BODY_BYTES || 2_000_000);
    const encoder = new TextEncoder();

    console.log(`[mindwtr-cloud] dataDir: ${dataDir}`);
    console.log(`[mindwtr-cloud] listening on http://${host}:${port}`);

    Bun.serve({
        hostname: host,
        port,
        async fetch(req) {
            if (req.method === 'OPTIONS') return jsonResponse({ ok: true });

            const url = new URL(req.url);
            const pathname = url.pathname.replace(/\/+$/, '') || '/';

            if (req.method === 'GET' && pathname === '/health') {
                return jsonResponse({ ok: true });
            }

            if (pathname === '/v1/data') {
                const token = getToken(req);
                if (!token) return errorResponse('Unauthorized', 401);
                const key = tokenToKey(token);
                const now = Date.now();
                const state = rateLimits.get(key);
                if (state && now < state.resetAt) {
                    state.count += 1;
                    if (state.count > maxPerWindow) {
                        const retryAfter = Math.ceil((state.resetAt - now) / 1000);
                        return jsonResponse(
                            { error: 'Rate limit exceeded', retryAfterSeconds: retryAfter },
                            { status: 429, headers: { 'Retry-After': String(retryAfter) } },
                        );
                    }
                } else {
                    rateLimits.set(key, { count: 1, resetAt: now + windowMs });
                }
                const filePath = join(dataDir, `${key}.json`);

                if (req.method === 'GET') {
                    const data = readData(filePath);
                    if (!data) return errorResponse('Not found', 404);
                    return jsonResponse(data);
                }

                if (req.method === 'PUT') {
                    const contentLength = Number(req.headers.get('content-length') || '0');
                    if (contentLength && contentLength > maxBodyBytes) {
                        return errorResponse('Payload too large', 413);
                    }
                    const text = await req.text();
                    if (!text.trim()) return errorResponse('Missing body');
                    if (encoder.encode(text).length > maxBodyBytes) {
                        return errorResponse('Payload too large', 413);
                    }
                    let parsed: any;
                    try {
                        parsed = JSON.parse(text);
                    } catch {
                        return errorResponse('Invalid JSON body');
                    }
                    const validated = validateAppData(parsed);
                    if (!validated.ok) return errorResponse(validated.error, 400);
                    writeData(filePath, validated.data);
                    return jsonResponse({ ok: true });
                }
            }

            return errorResponse('Not found', 404);
        },
    });
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
