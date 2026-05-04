import type { Area, Project, Section, Task } from '@mindwtr/core';

type Flags = Record<string, string | boolean>;
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

export const normalizeRevision = (value?: number): number => (
    typeof value === 'number' && Number.isFinite(value) ? value : 0
);

export const logInfo = (message: string, context?: Record<string, unknown>) => {
    writeLog({ ts: new Date().toISOString(), level: 'info', scope: 'cloud', message, context });
};

export const logWarn = (message: string, context?: Record<string, unknown>) => {
    writeLog({ ts: new Date().toISOString(), level: 'warn', scope: 'cloud', message, context });
};

export const logError = (message: string, error?: unknown) => {
    const context: Record<string, unknown> = {};
    if (error instanceof Error) {
        context.error = error.message;
        if (error.stack) context.stack = error.stack;
    } else if (error !== undefined) {
        context.error = String(error);
    }
    writeLog({
        ts: new Date().toISOString(),
        level: 'error',
        scope: 'cloud',
        message,
        context: Object.keys(context).length ? context : undefined,
    });
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

export const corsOrigin = configuredCorsOrigin || 'http://localhost:5173';
const maxTaskTitleLengthValue = Number(process.env.MINDWTR_CLOUD_MAX_TASK_TITLE_LENGTH || 500);
export const MAX_TASK_TITLE_LENGTH = Number.isFinite(maxTaskTitleLengthValue) && maxTaskTitleLengthValue > 0
    ? Math.floor(maxTaskTitleLengthValue)
    : 500;
const maxTaskQuickAddLengthValue = Number(process.env.MINDWTR_CLOUD_MAX_TASK_QUICK_ADD_LENGTH || 2000);
export const MAX_TASK_QUICK_ADD_LENGTH = Number.isFinite(maxTaskQuickAddLengthValue) && maxTaskQuickAddLengthValue > 0
    ? Math.floor(maxTaskQuickAddLengthValue)
    : 2000;
const maxItemsPerCollectionValue = Number(process.env.MINDWTR_CLOUD_MAX_ITEMS_PER_COLLECTION || 50_000);
export const MAX_ITEMS_PER_COLLECTION = Number.isFinite(maxItemsPerCollectionValue) && maxItemsPerCollectionValue > 0
    ? Math.floor(maxItemsPerCollectionValue)
    : 50_000;
const listDefaultLimitValue = Number(process.env.MINDWTR_CLOUD_LIST_DEFAULT_LIMIT || 200);
export const LIST_DEFAULT_LIMIT = Number.isFinite(listDefaultLimitValue) && listDefaultLimitValue > 0
    ? Math.floor(listDefaultLimitValue)
    : 200;
const listMaxLimitValue = Number(process.env.MINDWTR_CLOUD_LIST_MAX_LIMIT || 1000);
export const LIST_MAX_LIMIT = Number.isFinite(listMaxLimitValue) && listMaxLimitValue > 0
    ? Math.floor(listMaxLimitValue)
    : 1000;
const rateLimitMaxKeysValue = Number(process.env.MINDWTR_CLOUD_RATE_MAX_KEYS || 10_000);
export const RATE_LIMIT_MAX_KEYS = Number.isFinite(rateLimitMaxKeysValue) && rateLimitMaxKeysValue > 0
    ? Math.floor(rateLimitMaxKeysValue)
    : 10_000;
export const MAX_PENDING_REMOTE_DELETE_ATTEMPTS = 100;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const authFailureRateMaxValue = Number(process.env.MINDWTR_CLOUD_AUTH_FAILURE_RATE_MAX || 30);
export const AUTH_FAILURE_RATE_MAX = Number.isFinite(authFailureRateMaxValue) && authFailureRateMaxValue > 0
    ? Math.floor(authFailureRateMaxValue)
    : 30;
export const ATTACHMENT_PATH_ALLOWLIST = /^[a-zA-Z0-9._/-]+$/;
export const CLOUD_DATA_LOCK_TTL_MS = 30_000;
export const CLOUD_DATA_LOCK_REFRESH_MS = 2_000;
export const CLOUD_DATA_LOCK_WAIT_TIMEOUT_MS = 60_000;
export const CLOUD_TASK_CREATION_ALLOWED_PROP_KEYS = new Set<keyof Task>([
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
export const CLOUD_TASK_PATCH_ALLOWED_PROP_KEYS = new Set<keyof Task>([
    'title',
    'order',
    'orderNum',
    ...CLOUD_TASK_CREATION_ALLOWED_PROP_KEYS,
]);
export const CLOUD_PROJECT_CREATION_ALLOWED_PROP_KEYS = new Set<keyof Project>([
    'status',
    'color',
    'order',
    'tagIds',
    'isSequential',
    'isFocused',
    'supportNotes',
    'attachments',
    'dueDate',
    'reviewAt',
    'areaId',
    'areaTitle',
]);
export const CLOUD_PROJECT_PATCH_ALLOWED_PROP_KEYS = new Set<keyof Project>([
    'title',
    ...CLOUD_PROJECT_CREATION_ALLOWED_PROP_KEYS,
]);
export const CLOUD_SECTION_CREATION_ALLOWED_PROP_KEYS = new Set<keyof Section>([
    'description',
    'order',
    'isCollapsed',
]);
export const CLOUD_SECTION_PATCH_ALLOWED_PROP_KEYS = new Set<keyof Section>([
    'projectId',
    'title',
    ...CLOUD_SECTION_CREATION_ALLOWED_PROP_KEYS,
]);
export const CLOUD_AREA_CREATION_ALLOWED_PROP_KEYS = new Set<keyof Area>([
    'color',
    'icon',
    'order',
]);
export const CLOUD_AREA_PATCH_ALLOWED_PROP_KEYS = new Set<keyof Area>([
    'name',
    ...CLOUD_AREA_CREATION_ALLOWED_PROP_KEYS,
]);
export const CLOUD_API_REV_BY = 'cloud';
export const BEARER_TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{20,512}$/;

export function parseArgs(argv: string[]) {
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

export function parsePagination(searchParams: URLSearchParams): { limit: number; offset: number } | { error: string } {
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

const applyCorsHeaders = (headers: Headers): Headers => {
    headers.set('Access-Control-Allow-Origin', corsOrigin);
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    headers.set('Access-Control-Allow-Methods', 'GET,PUT,POST,PATCH,DELETE,OPTIONS');
    return headers;
};

export function jsonResponse(body: unknown, init: ResponseInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('Content-Type', 'application/json; charset=utf-8');
    applyCorsHeaders(headers);
    return new Response(JSON.stringify(body, null, 2), { ...init, headers });
}

export function preflightResponse(init: ResponseInit = {}) {
    const headers = applyCorsHeaders(new Headers(init.headers));
    return new Response(null, { status: 204, ...init, headers });
}

export function errorResponse(message: string, status = 400) {
    return jsonResponse({ error: message }, { status });
}
