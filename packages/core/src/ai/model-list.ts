


import { fetchTextWithTimeout } from './utils';

export type ModelListProviderId = 'openai' | 'gemini' | 'anthropic';
export type ModelListKind = 'chat' | 'transcription';

export type FetchProviderModelsOptions = {
    apiKey?: string;


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


const OPENAI_DEFAULT_ROOT = 'https://api.openai.com/v1';
const OPENAI_CHAT_EXCLUDE = /(embed|tts|audio|whisper|transcribe|realtime|image|dall-e|moderation)/i;
const OPENAI_TRANSCRIBE_INCLUDE = /(whisper|transcribe)/i;

async function fetchOpenAIModels(options: ResolvedOptions): Promise<string[]> {
    const root = String(options.baseUrl || '').trim().replace(/\/+$/, '') || OPENAI_DEFAULT_ROOT;
    const apiKey = String(options.apiKey || '').trim();


    if (!apiKey && root === OPENAI_DEFAULT_ROOT) {
        throw new Error('OpenAI models request needs an API key or a base URL.');
    }
    const response = await fetchTextWithTimeout(
        `${root}/models`,
        {


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


    const withCreated = filtered.filter((e) => e.created !== undefined);
    const withoutCreated = filtered.filter((e) => e.created === undefined);
    withCreated.sort((a, b) => (b.created as number) - (a.created as number));
    withoutCreated.sort((a, b) => a.id.localeCompare(b.id));
    return [...withCreated, ...withoutCreated].map((e) => e.id);
}


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


    return ids.sort().reverse();
}


const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models?limit=100';

async function fetchAnthropicModels(options: ResolvedOptions): Promise<string[]> {

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

    return (data as Array<{ id?: unknown }>)
        .map((entry) => (typeof entry?.id === 'string' ? entry.id : ''))
        .filter(Boolean);
}


export function fetchProviderModels(
    provider: ModelListProviderId,
    options: FetchProviderModelsOptions = {}
): Promise<string[]> {
    const resolved = resolveOptions(options);
    if (provider === 'openai') return fetchOpenAIModels(resolved);
    if (provider === 'gemini') return fetchGeminiModels(resolved);
    return fetchAnthropicModels(resolved);
}


type CacheEntry = { value: string[]; expiresAt: number };
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<string[]>>();

function cacheKey(provider: ModelListProviderId, options: FetchProviderModelsOptions): string {
    const baseUrl = String(options.baseUrl || '').trim();
    const kind = options.kind ?? 'chat';


    const apiKey = String(options.apiKey || '').trim();
    return `${provider}|${baseUrl}|${kind}|${apiKey}`;
}


export function clearProviderModelsCache(): void {
    cache.clear();
    inFlight.clear();
}


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


    const settle = () => {
        if (inFlight.get(key) === promise) inFlight.delete(key);
    };
    promise.then(settle, settle);
    return promise;
}


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
