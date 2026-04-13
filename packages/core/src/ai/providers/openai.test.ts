import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenAIProvider } from './openai';

const mockOpenAiSuccess = () =>
    new Response(
        JSON.stringify({
            choices: [
                {
                    message: {
                        content: JSON.stringify({
                            question: 'What is the next action?',
                            options: [{ label: 'Do it', action: 'do' }],
                        }),
                    },
                },
            ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe('openai provider auth behavior', () => {
    it('requires an API key for the default OpenAI endpoint', async () => {
        const provider = createOpenAIProvider({
            provider: 'openai',
            apiKey: '',
            model: 'gpt-4o-mini',
        });

        await expect(
            provider.clarifyTask({
                title: 'Plan trip',
            }),
        ).rejects.toThrow('OpenAI API key is required.');
    });

    it('allows empty API key for custom OpenAI-compatible endpoints', async () => {
        const fetchMock = vi.fn(async () => mockOpenAiSuccess());
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createOpenAIProvider({
            provider: 'openai',
            endpoint: 'http://localhost:11434/v1/chat/completions',
            apiKey: '',
            model: 'llama3.2',
        });

        const result = await provider.clarifyTask({ title: 'Plan trip' });
        expect(result.question).toBe('What is the next action?');

        const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
        const headers = (requestInit?.headers ?? {}) as Record<string, string>;
        expect(headers.Authorization).toBeUndefined();
    });

    it('surfaces custom endpoint auth errors without implying official OpenAI auth', async () => {
        const fetchMock = vi.fn(async () =>
            new Response(
                JSON.stringify({
                    error: {
                        message: 'invalid token',
                    },
                }),
                { status: 401, headers: { 'Content-Type': 'application/json' } },
            ));
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createOpenAIProvider({
            provider: 'openai',
            endpoint: 'https://glm.example.com/v1/chat/completions',
            apiKey: 'bad-token',
            model: 'GLM-4.7',
        });

        await expect(
            provider.clarifyTask({
                title: 'Plan trip',
            }),
        ).rejects.toThrow('OpenAI-compatible endpoint rejected the request. Check the custom base URL, API key, and model.');
    });
});
