// Live model-list fetch for AI settings pickers (#986). The static catalog in
// ./catalog.ts goes stale whenever a provider ships or retires a model; this
// module hits each provider's list-models endpoint instead. Every failure
// mode (HTTP error, timeout, malformed body, legitimately empty list) is
// something the caller degrades from — see mergeModelOptions.
import { fetchTextWithTimeout } from './utils';

export type ModelListProviderId = 'openai' | 'gemini' | 'anthropic';
export type ModelListKind = 'chat' | 'transcription';

export type FetchProviderModelsOptions = {
    apiKey?: string;
    // OpenAI only: root of an OpenAI-compatible server, same convention as
    // resolveOpenAITranscribeEndpoint (user pastes a root ending in /v1).
    baseUrl?: string;
    kind?: ModelListKind;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
};

type ResolvedOptions = {
    apiKey?: string;
    baseUrl?: string;
    kind: ModelListKind;
    timeoutMs: number;
    fetchImpl: typeof fetch;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 5 * 60 * 1000;

function resolveOptions(options: FetchProviderModelsOptions): ResolvedOptions {
    return {
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        kind: options.kind ?? 'chat',
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetchImpl: options.fetchImpl ?? globalThis.fetch,
    };
}

function readJsonBody(raw: string, label: string): unknown {
    try {
        return JSON.parse(raw) as unknown;
    } catch {
        throw new Error(`${label} returned a malformed response body.`);
    }
}

// --- OpenAI --------------------------------------------------------------

const OPENAI_DEFAULT_ROOT = 'https://api.openai.com/v1';
const OPENAI_CHAT_EXCLUDE = /(embed|tts|audio|whisper|transcribe|realtime|image|dall-e|moderation)/i;
const OPENAI_TRANSCRIBE_INCLUDE = /(whisper|transcribe)/i;

async function fetchOpenAIModels(options: ResolvedOptions): Promise<string[]> {
    const root = String(options.baseUrl || '').trim().replace(/\/+$/, '') || OPENAI_DEFAULT_ROOT;
    const apiKey = String(options.apiKey || '').trim();
    // Official OpenAI without a key can only 401; don't fire the doomed
    // request. A keyless self-hosted root (#930) is the one keyless case.
    if (!apiKey && root === OPENAI_DEFAULT_ROOT) {
        throw new Error('OpenAI models request needs an API key or a base URL.');
    }
    const response = await fetchTextWithTimeout(
        `${root}/models`,
        {
            // A self-hosted server usually has no key, and an empty "Bearer "
            // header makes some servers 401 — only send it when we have one
            // (mirrors transcribeOpenAI in apps/desktop/src/lib/speech-to-text.ts).
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        },
        options.timeoutMs,
        'OpenAI models',
        undefined,
        options.fetchImpl
    );
    if (!response.ok) {
        throw new Error(`OpenAI models request failed (${response.status}).`);
    }
    const data = (readJsonBody(response.bodyText, 'OpenAI models') as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) {
        throw new Error('OpenAI models response was missing a data array.');
    }

    const entries = (data as Array<{ id?: unknown; created?: unknown }>)
        .filter((entry): entry is { id: string; created?: unknown } => typeof entry?.id === 'string')
        .map((entry) => ({
            id: entry.id,
            created: typeof entry.created === 'number' ? entry.created : undefined,
        }));

    const filtered = options.kind === 'transcription'
        ? entries.filter((entry) => OPENAI_TRANSCRIBE_INCLUDE.test(entry.id))
        : entries.filter((entry) => !OPENAI_CHAT_EXCLUDE.test(entry.id));

    // Newest first: numeric `created` descending, entries without it sorted
    // alphabetically after everything that has one.
    const withCreated = filtered.filter((e) => e.created !== undefined);
    const withoutCreated = filtered.filter((e) => e.created === undefined);
    withCreated.sort((a, b) => (b.created as number) - (a.created as number));
    withoutCreated.sort((a, b) => a.id.localeCompare(b.id));
    return [...withCreated, ...withoutCreated].map((e) => e.id);
}

// --- Gemini ----------------------------------------------------------------

const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_EXCLUDE = /(embedding|aqa|imagen|veo|tts|native[-_ ]?audio|live|music|lyria)/i;

async function fetchGeminiModels(options: ResolvedOptions): Promise<string[]> {
    const apiKey = String(options.apiKey || '').trim();
    if (!apiKey) {
        throw new Error('Gemini models request needs an API key.');
    }
    const url = `${GEMINI_MODELS_URL}?key=${encodeURIComponent(apiKey)}&pageSize=1000`;
    const response = await fetchTextWithTimeout(url, {}, options.timeoutMs, 'Gemini models', undefined, options.fetchImpl);
    if (!response.ok) {
        throw new Error(`Gemini models request failed (${response.status}).`);
    }
    const modelEntries = (readJsonBody(response.bodyText, 'Gemini models') as { models?: unknown } | null)?.models;
    if (!Array.isArray(modelEntries)) {
        throw new Error('Gemini models response was missing a models array.');
    }

    const ids = (modelEntries as Array<{ name?: unknown; supportedGenerationMethods?: unknown }>)
        .filter((model) => Array.isArray(model?.supportedGenerationMethods)
            && (model.supportedGenerationMethods as unknown[]).includes('generateContent'))
        .map((model) => (typeof model.name === 'string' ? model.name.replace(/^models\//, '') : ''))
        .filter((id) => id && !GEMINI_EXCLUDE.test(id));

    // No version parser; plain lexicographic descending is good enough
    // (puts gemini-3.6 above gemini-3.5).
    return ids.sort().reverse();
}

// --- Anthropic ---------------------------------------------------------------

const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models?limit=100';

async function fetchAnthropicModels(options: ResolvedOptions): Promise<string[]> {
    // Anthropic has no speech-to-text models to list.
    if (options.kind === 'transcription') return [];

    const apiKey = String(options.apiKey || '').trim();
    if (!apiKey) {
        throw new Error('Anthropic models request needs an API key.');
    }
    const response = await fetchTextWithTimeout(
        ANTHROPIC_MODELS_URL,
        {
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                // Required so the desktop Tauri webview's browser Origin passes
                // CORS (mirrors packages/core/src/ai/providers/anthropic.ts).
                'anthropic-dangerous-direct-browser-access': 'true',
            },
        },
        options.timeoutMs,
        'Anthropic models',
        undefined,
        options.fetchImpl
    );
    if (!response.ok) {
        throw new Error(`Anthropic models request failed (${response.status}).`);
    }
    const data = (readJsonBody(response.bodyText, 'Anthropic models') as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) {
        throw new Error('Anthropic models response was missing a data array.');
    }
    // Keep API order (newest first already).
    return (data as Array<{ id?: unknown }>)
        .map((entry) => (typeof entry?.id === 'string' ? entry.id : ''))
        .filter(Boolean);
}

/**
 * Fetches and normalizes the live model list for a provider. Throws on HTTP
 * error, timeout, or a malformed body. Returns [] when the provider
 * legitimately lists nothing usable for `kind`. Callers fall back to the
 * static catalog on either outcome.
 */
export function fetchProviderModels(
    provider: ModelListProviderId,
    options: FetchProviderModelsOptions = {}
): Promise<string[]> {
    const resolved = resolveOptions(options);
    if (provider === 'openai') return fetchOpenAIModels(resolved);
    if (provider === 'gemini') return fetchGeminiModels(resolved);
    return fetchAnthropicModels(resolved);
}

// --- Cached wrapper ----------------------------------------------------------

type CacheEntry = { value: string[]; expiresAt: number };
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<string[]>>();

function cacheKey(provider: ModelListProviderId, options: FetchProviderModelsOptions): string {
    const baseUrl = String(options.baseUrl || '').trim();
    const kind = options.kind ?? 'chat';
    // Key on the actual apiKey value (in-memory only — the key already lives
    // in settings state): switching to a different account's key must not
    // serve the previous account's list for up to the TTL.
    const apiKey = String(options.apiKey || '').trim();
    return `${provider}|${baseUrl}|${kind}|${apiKey}`;
}

/** Test-only reset for the module-level TTL cache and in-flight dedupe map. */
export function clearProviderModelsCache(): void {
    cache.clear();
    inFlight.clear();
}

/**
 * Same contract as fetchProviderModels, plus a 5-minute TTL cache and
 * in-flight promise dedupe so two pickers opening at once fire one request.
 * Errors are never cached — a failed fetch always retries next call.
 */
export function fetchProviderModelsCached(
    provider: ModelListProviderId,
    options: FetchProviderModelsOptions = {}
): Promise<string[]> {
    const key = cacheKey(provider, options);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
        return Promise.resolve(cached.value);
    }
    const existing = inFlight.get(key);
    if (existing) return existing;

    const promise = fetchProviderModels(provider, options).then((value) => {
        cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
        return value;
    });
    inFlight.set(key, promise);
    // Clear the in-flight marker on settle — but only if it is still ours
    // (clearProviderModelsCache mid-flight may have let a newer request claim
    // the slot). Attaching handlers also keeps this internal reference from
    // raising an unhandled-rejection warning independent of the caller.
    const settle = () => {
        if (inFlight.get(key) === promise) inFlight.delete(key);
    };
    promise.then(settle, settle);
    return promise;
}

/**
 * Pure; always returns a fresh array. Uses `fetched` when it has entries,
 * `fallback` otherwise, deduped preserving order. `selected` (the user's
 * saved/typed model) is prepended when it is non-empty and missing from the
 * list — on BOTH paths, because a custom model must appear in its own picker
 * precisely when the fetch degraded. When the list already carries it, it
 * stays in place, keeping the newest-first order stable across selections.
 */
export function mergeModelOptions(
    fetched: string[] | null | undefined,
    fallback: string[],
    selected?: string
): string[] {
    const source = fetched && fetched.length > 0 ? fetched : fallback;
    const selectedId = String(selected ?? '').trim();
    const seen = new Set<string>();
    const merged: string[] = [];
    if (selectedId && !source.includes(selectedId)) {
        merged.push(selectedId);
        seen.add(selectedId);
    }
    for (const id of source) {
        if (!id || seen.has(id)) continue;
        seen.add(id);
        merged.push(id);
    }
    return merged;
}
