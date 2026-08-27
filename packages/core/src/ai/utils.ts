import {
    fetchWithTimeoutAndConsume as fetchHttpWithTimeoutAndConsume,
    readResponseText,
} from '../http-utils';

const MAX_JSON_REPAIR_BOUNDARIES = 50;
const MAX_AI_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * Repair candidates for a truncated JSON document (e.g. the model hit its output
 * token limit mid-array). Walks the text tracking string state and the bracket
 * stack, recording every point where a value just completed, then closes the
 * still-open brackets. Returns candidates longest-first so the most complete
 * salvage that passes the caller's validator wins.
 */
function repairTruncatedJson(input: string): string[] {
    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    const boundaries: Array<{ len: number; stack: string[] }> = [];

    for (let i = 0; i < input.length; i += 1) {
        const ch = input[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
                // A string just closed; it may be a value or an element worth keeping.
                if (stack.length > 0) boundaries.push({ len: i + 1, stack: [...stack] });
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === '{' || ch === '[') {
            stack.push(ch);
            continue;
        }
        if (ch === '}' || ch === ']') {
            stack.pop();
            if (stack.length > 0) boundaries.push({ len: i + 1, stack: [...stack] });
            continue;
        }
    }

    const repaired: string[] = [];
    const repairBoundaries = boundaries.slice(-MAX_JSON_REPAIR_BOUNDARIES);
    for (let i = repairBoundaries.length - 1; i >= 0; i -= 1) {
        const { len, stack: openStack } = repairBoundaries[i];
        const head = input.slice(0, len).replace(/[,\s]+$/, '');
        const closers = openStack
            .map((opener) => (opener === '{' ? '}' : ']'))
            .reverse()
            .join('');
        const candidate = head + closers;
        if (!repaired.includes(candidate)) repaired.push(candidate);
    }
    return repaired;
}

export function parseJson<T>(raw: string, validator?: (value: unknown) => value is T): T {
    const trimmed = raw.trim();
    if (!trimmed) {
        throw new Error('AI response was empty.');
    }
    const cleaned = trimmed
        .replace(/^```(?:json)?/i, '')
        .replace(/```$/i, '')
        .trim();

    const candidates = [cleaned];
    const objectStart = cleaned.indexOf('{');
    const objectEnd = cleaned.lastIndexOf('}');
    if (objectStart !== -1 && objectEnd > objectStart) {
        const sliced = cleaned.slice(objectStart, objectEnd + 1);
        if (!candidates.includes(sliced)) candidates.push(sliced);
    }
    const arrayStart = cleaned.indexOf('[');
    const arrayEnd = cleaned.lastIndexOf(']');
    if (arrayStart !== -1 && arrayEnd > arrayStart) {
        const sliced = cleaned.slice(arrayStart, arrayEnd + 1);
        if (!candidates.includes(sliced)) candidates.push(sliced);
    }
    const strictCandidateCount = candidates.length;
    for (const repaired of repairTruncatedJson(cleaned)) {
        if (!candidates.includes(repaired)) candidates.push(repaired);
    }

    let lastError: unknown = null;
    for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        try {
            const parsed = JSON.parse(candidate) as unknown;
            if (validator && !validator(parsed)) {
                throw new Error('AI response failed validation.');
            }
            if (index >= strictCandidateCount) {
                // Strict parsing failed; this came from the truncation-repair path.
                logAiParseDiagnostic('recovered-from-truncated-response', raw);
            }
            return parsed as T;
        } catch (error) {
            lastError = error;
        }
    }

    logAiParseDiagnostic('unrecoverable', raw);
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`AI JSON parse error: ${message}.`);
}

/**
 * Logs when strict parsing fails, so a truncated or malformed payload can be
 * diagnosed. Only fires on the degraded path, never on a clean parse. Avoids
 * dumping full task content; the unrecoverable case keeps a short tail so a
 * hard failure can still be inspected.
 */
function logAiParseDiagnostic(stage: 'recovered-from-truncated-response' | 'unrecoverable', raw: string): void {
    if (typeof console === 'undefined' || typeof console.warn !== 'function') return;
    if (stage === 'recovered-from-truncated-response') {
        console.warn(`[AI JSON parse] recovered from a truncated response (length=${raw.length}).`);
        return;
    }
    const tail = raw.slice(-160).replace(/\s+/g, ' ');
    console.warn(`[AI JSON parse] unrecoverable response (length=${raw.length}); tail: …${tail}`);
}

const TIME_ESTIMATE_MAP: Record<string, string> = {
    '5m': '5min',
    '5min': '5min',
    '10m': '10min',
    '10min': '10min',
    '15m': '15min',
    '15min': '15min',
    '30m': '30min',
    '30min': '30min',
    '1h': '1hr',
    '1hr': '1hr',
    '2h': '2hr',
    '2hr': '2hr',
    '3h': '3hr',
    '3hr': '3hr',
    '4h': '4hr',
    '4hr': '4hr',
    '4h+': '4hr+',
    '4hr+': '4hr+',
};

export function normalizeTimeEstimate(value?: string): string | undefined {
    if (!value) return undefined;
    const key = value.trim().toLowerCase();
    return TIME_ESTIMATE_MAP[key];
}

/**
 * Drops review suggestions whose id was not among the analyzed items. The model
 * is free to echo any string back, and both platforms map suggestion ids
 * straight into a status write, so only ids we actually sent may reach one.
 * Ids keep the shape `getStaleItems` emitted (`project:<id>` for projects), so
 * the item list is a complete allow-list for task and project suggestions alike.
 */
export function filterReviewSuggestionsToKnownIds<T extends { id: string }>(
    suggestions: readonly T[],
    knownIds: Iterable<string>
): T[] {
    const allowed = new Set(knownIds);
    return suggestions.filter((suggestion) => allowed.has(suggestion.id));
}

export function normalizeTags(tags?: string[] | null): string[] {
    if (!tags || tags.length === 0) return [];
    const normalized = tags
        .map((tag) => String(tag).trim())
        .filter(Boolean)
        .map((tag) => (tag.startsWith('#') ? tag : `#${tag}`));
    return Array.from(new Set(normalized));
}

// The generic "AI request failed, try again" alert hid the provider's actual
// error, so failures like Gemini retiring a model (404 "no longer available")
// produced unreproducible reports. Append a truncated single-line detail; API
// keys never appear in provider error bodies, but cap length defensively.
export function formatAIErrorAlertBody(genericBody: string, error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error ?? '');
    const detail = raw.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!detail) return genericBody;
    return `${genericBody}\n\n${detail}`;
}

export type BufferedAIResponse = {
    ok: boolean;
    status: number;
    statusText: string;
    headers: Headers;
    bodyText: string;
};

export async function fetchTextWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    label: string,
    externalSignal?: AbortSignal,
    fetcher: typeof fetch = globalThis.fetch
): Promise<BufferedAIResponse> {
    const callerSignal = externalSignal ?? init.signal ?? undefined;
    try {
        return await fetchHttpWithTimeoutAndConsume(
            url,
            { ...init, signal: callerSignal },
            timeoutMs,
            fetcher,
            `${label} request timed out`,
            async (response, signal) => ({
                ok: response.ok,
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                bodyText: await readResponseText(response, MAX_AI_RESPONSE_BYTES, signal),
            }),
        );
    } catch (error) {
        if (callerSignal?.aborted) {
            throw new Error(`${label} request aborted`);
        }
        throw error;
    }
}

const lastRequestAt = new Map<string, number>();

export async function rateLimit(key: string, minIntervalMs = 250): Promise<void> {
    const now = Date.now();
    const last = lastRequestAt.get(key) ?? 0;
    const waitMs = minIntervalMs - (now - last);
    if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    lastRequestAt.set(key, Date.now());
}
