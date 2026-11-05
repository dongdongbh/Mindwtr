const SENSITIVE_KEYS = [
    'token',
    'access_token',
    'password',
    'pass',
    'apikey',
    'api_key',
    'key',
    'secret',
    'auth',
    'authorization',
    'username',
    'user',
    'session',
    'cookie',
];

const PRIVATE_CONTENT_KEYS = [
    'title',
    'tasktitle',
    'task_title',
    'projecttitle',
    'project_title',
    'projectname',
    'project_name',
    'description',
    'taskdescription',
    'task_description',
    'supportnotes',
    'support_notes',
    'note',
    'notes',
];


const AI_KEY_PATTERNS = [
    /(^|[^A-Za-z])sk-[A-Za-z0-9_-]{10,}/g,
    /(^|[^A-Za-z])xai-[A-Za-z0-9]{20,}/g,
    /(^|[^A-Za-z])gsk_[A-Za-z0-9]{20,}/g,
    /(^|[^A-Za-z])rk-[A-Za-z0-9]{10,}/g,
    /(^|[^A-Za-z])AIza[0-9A-Za-z\-_]{10,}/g,
];

const ICS_URL_PATTERN = /\b(?:https?|webcal|webcals):\/\/[^\s'")]+/gi;


const LOCAL_URI_PATTERN = /(file:\/|content:\/\/)[^\n]*/gi;
const LOCAL_PATH_PATTERN = /(^|[^\w/.~-])\/(?:private\/var\/mobile|var\/mobile|storage|sdcard|data\/user|data\/data)\/[^\n]*/gi;
const redactLocal = (text: string): string => text
    .replace(LOCAL_URI_PATTERN, (_match, start: string) => (start.toLowerCase().startsWith('file:') ? '[redacted-file-uri]' : '[redacted-content-uri]'))
    .replace(LOCAL_PATH_PATTERN, (_match, before: string) => `${before}[redacted-path]`);
const MAX_SANITIZE_DEPTH = 5;
const MAX_SANITIZE_ENTRIES = 50;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const shouldRedactKey = (key: string): boolean => {
    const normalized = key.toLowerCase();
    return SENSITIVE_KEYS.some((pattern) => normalized.includes(pattern))
        || PRIVATE_CONTENT_KEYS.includes(normalized);
};

const looksLikeUrlKey = (key?: string): boolean => {
    if (!key) return false;
    const normalized = key.toLowerCase();
    return normalized === 'url' || normalized.endsWith('url');
};


const sanitizeParsedUrl = (raw: string): string | null => {
    try {
        const parsed = new URL(raw);
        const scheme = parsed.protocol.replace(':', '').toLowerCase();
        if (scheme === 'file' || scheme === 'content') return `[redacted-${scheme}-uri]`;
        if (scheme === 'webcal' || scheme === 'webcals' || parsed.pathname.toLowerCase().includes('.ics')) {
            return '[redacted-ics-url]';
        }
        parsed.username = '';
        parsed.password = '';
        const params = parsed.searchParams;
        for (const key of params.keys()) {
            if (shouldRedactKey(key)) {
                params.set(key, 'redacted');
            }
        }
        return parsed.toString();
    } catch {
        return null;
    }
};


const redactUnparsedUrl = (raw: string): string => (
    /^webcals?:/i.test(raw) || /\.ics\b/i.test(raw) ? '[redacted-ics-url]' : raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/i, '$1')
);

export function sanitizeUrl(raw?: string): string | undefined {
    if (!raw) return undefined;
    return sanitizeParsedUrl(raw) ?? redactSensitiveText(raw);
}

function redactSensitiveText(value: string): string {
    let result = value;
    result = result.replace(/(Authorization:\s*)(Basic|Bearer)\s+[A-Za-z0-9+/=._-]+/gi, '$1$2 [redacted]');
    result = result.replace(
        /(password|pass|token|access_token|api_key|apikey|authorization|username|user|secret|session|cookie)=([^\s&]+)/gi,
        '$1=[redacted]'
    );
    for (const pattern of AI_KEY_PATTERNS) {
        result = result.replace(pattern, '$1[redacted]');
    }
    result = result.replace(ICS_URL_PATTERN, (match) => sanitizeParsedUrl(match) ?? redactUnparsedUrl(match));
    result = redactLocal(result);
    return result;
}

function sanitizeUnknown(
    value: unknown,
    keyHint?: string,
    depth = 0,
    seen: WeakSet<object> = new WeakSet<object>()
): unknown {
    if (depth >= MAX_SANITIZE_DEPTH) return '[truncated]';
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
        if (looksLikeUrlKey(keyHint)) {
            return sanitizeUrl(value) ?? '[redacted]';
        }
        return redactSensitiveText(value);
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Error) {
        return {
            name: redactSensitiveText(value.name),
            message: redactSensitiveText(value.message),
            ...(value.stack ? { stack: redactSensitiveText(value.stack) } : {}),
        };
    }
    if (Array.isArray(value)) {
        return value
            .slice(0, MAX_SANITIZE_ENTRIES)
            .map((item) => sanitizeUnknown(item, undefined, depth + 1, seen));
    }
    if (isRecord(value)) {
        if (seen.has(value)) return '[circular]';
        seen.add(value);
        const output: Record<string, unknown> = {};
        for (const [key, entryValue] of Object.entries(value).slice(0, MAX_SANITIZE_ENTRIES)) {
            if (shouldRedactKey(key)) {
                output[key] = '[redacted]';
                continue;
            }
            if (looksLikeUrlKey(key) && typeof entryValue === 'string') {
                output[key] = sanitizeUrl(entryValue) ?? '[redacted]';
                continue;
            }
            output[key] = sanitizeUnknown(entryValue, key, depth + 1, seen);
        }
        seen.delete(value);
        return output;
    }
    return redactSensitiveText(String(value));
}

export function sanitizeForLog(value: unknown): string {
    const sanitized = sanitizeUnknown(value);
    if (sanitized === undefined) return 'undefined';
    if (sanitized === null) return 'null';
    if (typeof sanitized === 'string') return sanitized;
    if (typeof sanitized === 'number' || typeof sanitized === 'boolean') return String(sanitized);
    try {
        return JSON.stringify(sanitized);
    } catch {
        return redactSensitiveText(String(value));
    }
}

export function sanitizeLogContext(context?: Record<string, unknown>): Record<string, string> | undefined {
    if (!context) return undefined;
    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(context)) {
        if (value === undefined) continue;
        if (shouldRedactKey(key)) {
            sanitized[key] = '[redacted]';
            continue;
        }
        if (looksLikeUrlKey(key)) {
            sanitized[key] = sanitizeUrl(String(value)) ?? '[redacted]';
            continue;
        }
        sanitized[key] = sanitizeForLog(value);
    }
    return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function sanitizeLogMessage(value: string): string {
    return sanitizeForLog(value);
}
