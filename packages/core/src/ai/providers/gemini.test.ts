import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGeminiProvider } from './gemini';

const originalFetch = globalThis.fetch;

const mockGeminiSuccess = (content: unknown) =>
    new Response(
        JSON.stringify({
            candidates: [
                {
                    content: {
                        parts: [{ text: JSON.stringify(content) }],
                    },
                },
            ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe('gemini provider request behavior', () => {
    it('uses a larger output budget for structured JSON responses', async () => {
        const fetchMock = vi.fn(async () => mockGeminiSuccess({ steps: ['Pick a date'] }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createGeminiProvider({
            provider: 'gemini',
            apiKey: 'test-key',
            model: 'gemini-2.5-flash',
        });

        const result = await provider.breakDownTask({ title: 'Plan trip' });
        expect(result.steps).toEqual(['Pick a date']);

        const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
        const body = JSON.parse(String(requestInit?.body ?? '{}')) as {
            generationConfig?: { maxOutputTokens?: number };
        };
        expect(body.generationConfig?.maxOutputTokens).toBe(4096);
    });

    const readThinkingConfig = (fetchMock: ReturnType<typeof vi.fn>) => {
        const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
        const body = JSON.parse(String(requestInit?.body ?? '{}')) as {
            generationConfig?: { thinkingConfig?: { thinkingBudget?: number } };
        };
        return body.generationConfig?.thinkingConfig;
    };

    it('disables thinking on thinking-capable models when no budget is set so the answer is not truncated', async () => {
        const fetchMock = vi.fn(async () => mockGeminiSuccess({ steps: ['Pick a date'] }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createGeminiProvider({ provider: 'gemini', apiKey: 'k', model: 'gemini-2.5-flash' });
        await provider.breakDownTask({ title: 'Plan trip' });

        expect(readThinkingConfig(fetchMock)).toEqual({ thinkingBudget: 0 });
    });

    it('honors an explicit thinking budget', async () => {
        const fetchMock = vi.fn(async () => mockGeminiSuccess({ steps: ['Pick a date'] }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createGeminiProvider({ provider: 'gemini', apiKey: 'k', model: 'gemini-2.5-flash', thinkingBudget: 512 });
        await provider.breakDownTask({ title: 'Plan trip' });

        expect(readThinkingConfig(fetchMock)).toEqual({ thinkingBudget: 512 });
    });

    it('omits thinkingConfig for models that do not support thinking', async () => {
        const fetchMock = vi.fn(async () => mockGeminiSuccess({ steps: ['Pick a date'] }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createGeminiProvider({ provider: 'gemini', apiKey: 'k', model: 'gemini-1.5-flash' });
        await provider.breakDownTask({ title: 'Plan trip' });

        expect(readThinkingConfig(fetchMock)).toBeUndefined();
    });
});

const mockGeminiError = (status: number, error?: { status?: string; message?: string }, headers?: Record<string, string>) =>
    new Response(
        error ? JSON.stringify({ error }) : 'upstream boom',
        { status, headers: { 'Content-Type': error ? 'application/json' : 'text/plain', ...headers } },
    );

describe('gemini provider error behavior', () => {
    it('requires an API key', async () => {
        const provider = createGeminiProvider({ provider: 'gemini', apiKey: '', model: 'gemini-2.5-flash' });
        await expect(provider.breakDownTask({ title: 'Plan trip' })).rejects.toThrow('Gemini API key is required.');
    });

    it('trims whitespace/newlines from the API key before sending it', async () => {
        const fetchMock = vi.fn(async () => mockGeminiSuccess({ steps: ['Pick a date'] }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createGeminiProvider({ provider: 'gemini', apiKey: '  AIza-test-key\n', model: 'gemini-2.5-flash' });
        await provider.breakDownTask({ title: 'Plan trip' });

        const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
        const headers = (requestInit?.headers ?? {}) as Record<string, string>;
        expect(headers['x-goog-api-key']).toBe('AIza-test-key');
    });

    it('surfaces the status and message from the response body', async () => {
        const fetchMock = vi.fn(async () =>
            mockGeminiError(400, { status: 'INVALID_ARGUMENT', message: 'Unknown name "thinkingConfig".' }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createGeminiProvider({ provider: 'gemini', apiKey: 'k', model: 'gemini-2.5-flash' });
        await expect(provider.breakDownTask({ title: 'Plan trip' })).rejects.toThrow(
            'Gemini request failed (400) [INVALID_ARGUMENT] : Unknown name "thinkingConfig".',
        );
    });

    it('gives an actionable message for an invalid API key (400 API_KEY_INVALID)', async () => {
        const fetchMock = vi.fn(async () =>
            mockGeminiError(400, { status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.' }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createGeminiProvider({ provider: 'gemini', apiKey: 'bad', model: 'gemini-2.5-flash' });
        await expect(provider.breakDownTask({ title: 'Plan trip' })).rejects.toThrow('Gemini API key is invalid.');
    });

    it('distinguishes custom endpoint auth failures from official ones', async () => {
        const fetchMock = vi.fn(async () => mockGeminiError(403, { status: 'PERMISSION_DENIED', message: 'nope' }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createGeminiProvider({
            provider: 'gemini',
            endpoint: 'https://proxy.example.com/v1beta/models',
            apiKey: 'k',
            model: 'gemini-2.5-flash',
        });
        await expect(provider.breakDownTask({ title: 'Plan trip' })).rejects.toThrow(
            'Gemini-compatible endpoint denied access. Check the API key and model permissions.',
        );
    });

    it('falls back to the raw body when no structured error is present', async () => {
        const fetchMock = vi.fn(async () => mockGeminiError(502));
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createGeminiProvider({ provider: 'gemini', apiKey: 'k', model: 'gemini-2.5-flash' });
        await expect(provider.breakDownTask({ title: 'Plan trip' })).rejects.toThrow(
            'Gemini request failed (502) : upstream boom',
        );
    });
});
