import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    clearProviderModelsCache,
    fetchProviderModels,
    fetchProviderModelsCached,
    mergeModelOptions,
} from './model-list';

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
}

type CapturedRequest = { url: string; init: RequestInit };

// Takes a factory, not a Response instance: a Response body can only be read
// once, and several tests here reuse the same mock across multiple fetches.
function captureFetch(makeResponse: () => Response) {
    const calls: CapturedRequest[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return makeResponse();
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
}

beforeEach(() => {
    clearProviderModelsCache();
});

describe('fetchProviderModels: openai', () => {
    it('excludes non-chat ids, keeps chat/self-hosted ids, and sorts by created desc', async () => {
        const { fetchImpl } = captureFetch(() => jsonResponse({
            data: [
                { id: 'text-embedding-3-small', created: 5 },
                { id: 'whisper-1', created: 4 },
                { id: 'gpt-4o-transcribe', created: 10 },
                { id: 'gpt-5.6-terra', created: 3 },
                { id: 'gpt-5.6', created: 9 },
                { id: 'llama3.2:latest' },
            ],
        }));

        const models = await fetchProviderModels('openai', { fetchImpl, apiKey: 'sk-test' });

        expect(models).toEqual(['gpt-5.6', 'gpt-5.6-terra', 'llama3.2:latest']);
    });

    it('sorts entries without created alphabetically, after all entries that have one', async () => {
        const { fetchImpl } = captureFetch(() => jsonResponse({
            data: [
                { id: 'zeta-model' },
                { id: 'gpt-5.6-terra', created: 1 },
                { id: 'alpha-model' },
            ],
        }));

        const models = await fetchProviderModels('openai', { fetchImpl, apiKey: 'sk-test' });

        expect(models).toEqual(['gpt-5.6-terra', 'alpha-model', 'zeta-model']);
    });

    it('transcription kind keeps only whisper/transcribe ids', async () => {
        const { fetchImpl } = captureFetch(() => jsonResponse({
            data: [
                { id: 'gpt-transcribe', created: 5 },
                { id: 'whisper-1', created: 10 },
                { id: 'gpt-5.6', created: 1 },
            ],
        }));

        const models = await fetchProviderModels('openai', { fetchImpl, apiKey: 'sk-test', kind: 'transcription' });

        expect(models).toEqual(['whisper-1', 'gpt-transcribe']);
    });

    it('omits Authorization when apiKey is empty but baseUrl is set', async () => {
        const { fetchImpl, calls } = captureFetch(() => jsonResponse({ data: [] }));

        const models = await fetchProviderModels('openai', {
            fetchImpl,
            baseUrl: 'http://localhost:1234/v1',
        });

        expect(models).toEqual([]);
        expect(calls[0].url).toBe('http://localhost:1234/v1/models');
        expect(calls[0].init.headers).toEqual({});
    });

    it('trims trailing slashes from the pasted base URL', async () => {
        const { fetchImpl, calls } = captureFetch(() => jsonResponse({ data: [] }));

        await fetchProviderModels('openai', { fetchImpl, baseUrl: 'http://localhost:1234/v1/' });

        expect(calls[0].url).toBe('http://localhost:1234/v1/models');
    });

    it('throws without fetching when there is neither an API key nor a base URL', async () => {
        const { fetchImpl } = captureFetch(() => jsonResponse({ data: [] }));

        await expect(fetchProviderModels('openai', { fetchImpl })).rejects.toThrow(/API key or a base URL/);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('throws when the body parses but has no data array', async () => {
        const { fetchImpl } = captureFetch(() => jsonResponse({ unexpected: true }));

        await expect(fetchProviderModels('openai', { fetchImpl, apiKey: 'sk-test' }))
            .rejects.toThrow(/missing a data array/);
    });

    it('throws its own message on a JSON body of literal null', async () => {
        const { fetchImpl } = captureFetch(() => jsonResponse(null));

        await expect(fetchProviderModels('openai', { fetchImpl, apiKey: 'sk-test' }))
            .rejects.toThrow(/missing a data array/);
    });

    it('sends Authorization when apiKey is present', async () => {
        const { fetchImpl, calls } = captureFetch(() => jsonResponse({ data: [] }));

        await fetchProviderModels('openai', { fetchImpl, apiKey: 'sk-test' });

        expect(calls[0].init.headers).toEqual({ Authorization: 'Bearer sk-test' });
    });

    it('throws on HTTP error', async () => {
        const { fetchImpl } = captureFetch(() => jsonResponse({ error: 'nope' }, 401));

        await expect(fetchProviderModels('openai', { fetchImpl, apiKey: 'sk-test' })).rejects.toThrow(/401/);
    });

    it('throws on a malformed body', async () => {
        const { fetchImpl } = captureFetch(() => new Response('not json{', { status: 200 }));

        await expect(fetchProviderModels('openai', { fetchImpl, apiKey: 'sk-test' }))
            .rejects.toThrow(/malformed response body/);
    });
});

describe('fetchProviderModels: gemini', () => {
    it('keeps only generateContent models, strips the models/ prefix, and excludes non-chat families', async () => {
        const { fetchImpl, calls } = captureFetch(() => jsonResponse({
            models: [
                { name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/gemini-2.5-flash-native-audio-latest', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/gemini-2.0-flash-live-001', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/lyria-realtime-exp', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
                { name: 'models/imagen-3.0', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/aqa-001', supportedGenerationMethods: ['generateContent'] },
            ],
        }));

        const models = await fetchProviderModels('gemini', { fetchImpl, apiKey: 'g-key' });

        expect(models).toEqual(['gemini-3.6-flash', 'gemini-3.5-flash']);
        expect(calls[0].url).toContain('key=g-key');
        expect(calls[0].url).toContain('pageSize=1000');
    });

    it('uses the same general multimodal models for transcription without audio-output models', async () => {
        const { fetchImpl } = captureFetch(() => jsonResponse({
            models: [
                { name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/gemini-2.5-pro-preview-tts', supportedGenerationMethods: ['generateContent'] },
            ],
        }));

        const models = await fetchProviderModels('gemini', {
            fetchImpl,
            apiKey: 'g-key',
            kind: 'transcription',
        });

        expect(models).toEqual(['gemini-3.6-flash']);
    });

    it('throws without fetching when the API key is empty', async () => {
        const { fetchImpl } = captureFetch(() => jsonResponse({ models: [] }));

        await expect(fetchProviderModels('gemini', { fetchImpl })).rejects.toThrow(/API key/);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe('fetchProviderModels: anthropic', () => {
    it('sends the browser-access header and preserves API order', async () => {
        const { fetchImpl, calls } = captureFetch(() => jsonResponse({
            data: [{ id: 'claude-sonnet-5' }, { id: 'claude-opus-5' }],
        }));

        const models = await fetchProviderModels('anthropic', { fetchImpl, apiKey: 'a-key' });

        expect(models).toEqual(['claude-sonnet-5', 'claude-opus-5']);
        expect(calls[0].init.headers).toEqual({
            'x-api-key': 'a-key',
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
        });
    });

    it('returns [] for transcription without calling fetch', async () => {
        const { fetchImpl } = captureFetch(() => jsonResponse({ data: [] }));

        const models = await fetchProviderModels('anthropic', { fetchImpl, kind: 'transcription' });

        expect(models).toEqual([]);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('throws without fetching when the API key is empty', async () => {
        const { fetchImpl } = captureFetch(() => jsonResponse({ data: [] }));

        await expect(fetchProviderModels('anthropic', { fetchImpl })).rejects.toThrow(/API key/);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe('fetchProviderModels: orcarouter', () => {
    it('hits the gateway /v1/models root, sends the bearer key, and applies the chat filter', async () => {
        const { fetchImpl, calls } = captureFetch(() => jsonResponse({
            data: [
                { id: 'orcarouter/fusion', created: 5 },
                { id: 'openai/text-embedding-3-small', created: 4 },
                { id: 'openai/gpt-5.6-terra', created: 3 },
            ],
        }));

        const models = await fetchProviderModels('orcarouter', { fetchImpl, apiKey: 'sk-orca-test' });

        expect(models).toEqual(['orcarouter/fusion', 'openai/gpt-5.6-terra']);
        expect(calls[0].url).toBe('https://api.orcarouter.ai/v1/models');
        expect(calls[0].init.headers).toEqual({ Authorization: 'Bearer sk-orca-test' });
    });
});

describe('fetchProviderModels: timeout', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('aborts and rejects once timeoutMs elapses', async () => {
        const hangingFetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
                const error = new Error('The operation was aborted.');
                error.name = 'AbortError';
                reject(error);
            });
        })) as unknown as typeof fetch;

        const promise = fetchProviderModels('openai', { fetchImpl: hangingFetch, apiKey: 'sk-test', timeoutMs: 5000 });
        const assertion = expect(promise).rejects.toThrow(/timed out/i);
        await vi.advanceTimersByTimeAsync(5000);
        await assertion;
    });
});

describe('fetchProviderModelsCached', () => {
    it('dedupes concurrent in-flight requests for the same key', async () => {
        const { fetchImpl } = captureFetch(() => jsonResponse({ data: [{ id: 'claude-sonnet-5' }] }));

        const [a, b] = await Promise.all([
            fetchProviderModelsCached('anthropic', { apiKey: 'k', fetchImpl }),
            fetchProviderModelsCached('anthropic', { apiKey: 'k', fetchImpl }),
        ]);

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(a).toEqual(['claude-sonnet-5']);
        expect(b).toEqual(['claude-sonnet-5']);
    });

    it('serves from cache until the 5-minute TTL elapses, then refetches', async () => {
        vi.useFakeTimers();
        try {
            const { fetchImpl } = captureFetch(() => jsonResponse({ data: [{ id: 'claude-sonnet-5' }] }));

            await fetchProviderModelsCached('anthropic', { apiKey: 'k', fetchImpl });
            expect(fetchImpl).toHaveBeenCalledTimes(1);

            await fetchProviderModelsCached('anthropic', { apiKey: 'k', fetchImpl });
            expect(fetchImpl).toHaveBeenCalledTimes(1);

            vi.advanceTimersByTime(5 * 60 * 1000 + 1);
            await fetchProviderModelsCached('anthropic', { apiKey: 'k', fetchImpl });
            expect(fetchImpl).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not cache errors, so the next call retries', async () => {
        let calls = 0;
        const fetchImpl = vi.fn(async () => {
            calls += 1;
            if (calls === 1) return new Response('not json{', { status: 200 });
            return jsonResponse({ data: [{ id: 'claude-sonnet-5' }] });
        }) as unknown as typeof fetch;

        await expect(fetchProviderModelsCached('anthropic', { apiKey: 'k', fetchImpl })).rejects.toThrow();
        const result = await fetchProviderModelsCached('anthropic', { apiKey: 'k', fetchImpl });

        expect(result).toEqual(['claude-sonnet-5']);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('keys the cache separately per provider/baseUrl/kind/apiKey', async () => {
        const { fetchImpl } = captureFetch(() => jsonResponse({ data: [{ id: 'claude-sonnet-5' }] }));

        await fetchProviderModelsCached('anthropic', { apiKey: 'account-a', fetchImpl });
        await fetchProviderModelsCached('anthropic', { apiKey: 'account-a', fetchImpl }); // cached
        // Switching accounts must NOT serve account A's cached list.
        await fetchProviderModelsCached('anthropic', { apiKey: 'account-b', fetchImpl });
        await fetchProviderModelsCached('anthropic', { apiKey: 'account-a', fetchImpl, kind: 'transcription' });

        // anthropic transcription short-circuits before fetch, so only the
        // two distinct chat-kind keys hit the network.
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
});

describe('mergeModelOptions', () => {
    it('returns fallback content when fetched is null, undefined, or empty', () => {
        expect(mergeModelOptions(null, ['a', 'b'])).toEqual(['a', 'b']);
        expect(mergeModelOptions(undefined, ['a', 'b'])).toEqual(['a', 'b']);
        expect(mergeModelOptions([], ['a', 'b'])).toEqual(['a', 'b']);
    });

    it('never returns the fallback array by reference (static catalogs must stay immutable)', () => {
        const fallback = ['a', 'b'];
        const merged = mergeModelOptions(null, fallback);
        expect(merged).not.toBe(fallback);
        merged.sort();
        expect(fallback).toEqual(['a', 'b']);
    });

    it('prepends a custom selected model on the fallback path too', () => {
        // The degraded path is exactly where a typed custom model (self-hosted
        // id, still-working retired id) must not vanish from its own picker.
        expect(mergeModelOptions(null, ['a', 'b'], 'llama3.2:latest')).toEqual(['llama3.2:latest', 'a', 'b']);
    });

    it('dedupes fetched while preserving first-seen order', () => {
        expect(mergeModelOptions(['a', 'b', 'a', 'c'], ['x'])).toEqual(['a', 'b', 'c']);
    });

    it('prepends selected when non-empty and not already present', () => {
        expect(mergeModelOptions(['a', 'b'], ['x'], 'sel')).toEqual(['sel', 'a', 'b']);
    });

    it('leaves selected in place when it already appears in fetched, keeping list order stable', () => {
        expect(mergeModelOptions(['a', 'sel', 'b'], ['x'], 'sel')).toEqual(['a', 'sel', 'b']);
    });

    it('ignores an empty selected string', () => {
        expect(mergeModelOptions(['a', 'a'], ['x'], '')).toEqual(['a']);
    });
});
