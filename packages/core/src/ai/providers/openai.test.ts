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

    it('uses the configured fetcher instead of global fetch', async () => {
        const fetchMock = vi.fn(async () => mockOpenAiSuccess());
        globalThis.fetch = vi.fn(async () => {
            throw new Error('global fetch should not be used');
        }) as unknown as typeof fetch;

        const provider = createOpenAIProvider({
            provider: 'openai',
            apiKey: 'test-key',
            model: 'gpt-4o-mini',
            fetcher: fetchMock as unknown as typeof fetch,
        });

        const result = await provider.clarifyTask({ title: 'Plan trip' });
        expect(result.question).toBe('What is the next action?');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(globalThis.fetch).not.toHaveBeenCalled();
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

    it('adds extra OpenAI-compatible body params without overriding core request fields', async () => {
        const fetchMock = vi.fn(async () => mockOpenAiSuccess());
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createOpenAIProvider({
            provider: 'openai',
            endpoint: 'https://api.z.ai/api/paas/v4/chat/completions',
            apiKey: 'test-key',
            model: 'glm-4.5-flash',
            extraBodyParams: {
                thinking: { type: 'disabled' },
                max_tokens: 1024,
                model: 'wrong-model',
                messages: [],
                response_format: { type: 'text' },
            },
        });

        await provider.clarifyTask({ title: 'Plan trip' });

        const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
        const body = JSON.parse(String(requestInit?.body ?? '{}')) as Record<string, unknown>;
        expect(body.thinking).toEqual({ type: 'disabled' });
        expect(body.max_tokens).toBe(1024);
        expect(body.model).toBe('glm-4.5-flash');
        expect(body.messages).toEqual([
            expect.objectContaining({ role: 'system' }),
            expect.objectContaining({ role: 'user' }),
        ]);
        expect(body.response_format).toEqual({ type: 'json_object' });
    });

    it('sends an explicit temperature for models that support it', async () => {
        const fetchMock = vi.fn(async () => mockOpenAiSuccess());
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createOpenAIProvider({
            provider: 'openai',
            apiKey: 'test-key',
            model: 'gpt-4o-mini',
        });

        await provider.clarifyTask({ title: 'Plan trip' });

        const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
        const body = JSON.parse(String(requestInit?.body ?? '{}')) as Record<string, unknown>;
        expect(body.temperature).toBe(0.2);
    });

    it('omits temperature for gpt-5 reasoning models', async () => {
        const fetchMock = vi.fn(async () => mockOpenAiSuccess());
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createOpenAIProvider({
            provider: 'openai',
            apiKey: 'test-key',
            model: 'gpt-5-mini',
            reasoningEffort: 'medium',
        });

        await provider.clarifyTask({ title: 'Plan trip' });

        const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
        const body = JSON.parse(String(requestInit?.body ?? '{}')) as Record<string, unknown>;
        expect(body.temperature).toBeUndefined();
        expect(body.reasoning_effort).toBe('medium');
    });

    it('omits temperature for o-series reasoning models', async () => {
        const fetchMock = vi.fn(async () => mockOpenAiSuccess());
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createOpenAIProvider({
            provider: 'openai',
            apiKey: 'test-key',
            model: 'o3-mini',
        });

        await provider.clarifyTask({ title: 'Plan trip' });

        const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
        const body = JSON.parse(String(requestInit?.body ?? '{}')) as Record<string, unknown>;
        expect(body.temperature).toBeUndefined();
    });

    it('honors an explicit temperature from extraBodyParams on reasoning models', async () => {
        const fetchMock = vi.fn(async () => mockOpenAiSuccess());
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createOpenAIProvider({
            provider: 'openai',
            apiKey: 'test-key',
            model: 'gpt-5-mini',
            extraBodyParams: { temperature: 0.7 },
        });

        await provider.clarifyTask({ title: 'Plan trip' });

        const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
        const body = JSON.parse(String(requestInit?.body ?? '{}')) as Record<string, unknown>;
        expect(body.temperature).toBe(0.7);
    });

    it('lets extraBodyParams override the default temperature on standard models', async () => {
        const fetchMock = vi.fn(async () => mockOpenAiSuccess());
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createOpenAIProvider({
            provider: 'openai',
            apiKey: 'test-key',
            model: 'gpt-4o-mini',
            extraBodyParams: { temperature: 0.9 },
        });

        await provider.clarifyTask({ title: 'Plan trip' });

        const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
        const body = JSON.parse(String(requestInit?.body ?? '{}')) as Record<string, unknown>;
        expect(body.temperature).toBe(0.9);
    });

    it('falls back to reasoning_content when an OpenAI-compatible endpoint returns empty content', async () => {
        const fetchMock = vi.fn(async () =>
            new Response(
                JSON.stringify({
                    choices: [
                        {
                            message: {
                                content: '',
                                reasoning_content: JSON.stringify({
                                    question: 'What is the next action?',
                                    options: [{ label: 'Do it', action: 'do' }],
                                }),
                            },
                        },
                    ],
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ));
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createOpenAIProvider({
            provider: 'openai',
            endpoint: 'http://localhost:11434/v1/chat/completions',
            apiKey: '',
            model: 'qwen-local',
        });

        const result = await provider.clarifyTask({ title: 'Plan trip' });

        expect(result.question).toBe('What is the next action?');
    });

    it('reads text from OpenAI-compatible content part arrays', async () => {
        const fetchMock = vi.fn(async () =>
            new Response(
                JSON.stringify({
                    choices: [
                        {
                            message: {
                                content: [
                                    {
                                        type: 'text',
                                        text: JSON.stringify({
                                            question: 'What is the next action?',
                                            options: [{ label: 'Do it', action: 'do' }],
                                        }),
                                    },
                                ],
                            },
                        },
                    ],
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ));
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createOpenAIProvider({
            provider: 'openai',
            endpoint: 'http://localhost:11434/v1/chat/completions',
            apiKey: '',
            model: 'qwen-local',
        });

        const result = await provider.clarifyTask({ title: 'Plan trip' });

        expect(result.question).toBe('What is the next action?');
    });
});

const mockContent = (content: unknown) =>
    new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

const readBody = (fetchMock: ReturnType<typeof vi.fn>) => {
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    return JSON.parse(String(requestInit?.body ?? '{}')) as Record<string, unknown>;
};

describe('openai structured outputs', () => {
    it('uses strict json_schema on the official endpoint', async () => {
        const fetchMock = vi.fn(async () => mockOpenAiSuccess());
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createOpenAIProvider({ provider: 'openai', apiKey: 'test-key', model: 'gpt-5.4-mini' });
        await provider.clarifyTask({ title: 'Plan trip' });

        const body = readBody(fetchMock);
        expect(body.response_format).toEqual(
            expect.objectContaining({
                type: 'json_schema',
                json_schema: expect.objectContaining({ name: 'clarify_response', strict: true }),
            }),
        );
    });

    it('falls back to json_object on custom OpenAI-compatible endpoints', async () => {
        const fetchMock = vi.fn(async () => mockOpenAiSuccess());
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createOpenAIProvider({
            provider: 'openai',
            endpoint: 'http://localhost:11434/v1/chat/completions',
            apiKey: '',
            model: 'llama3.2',
        });
        await provider.clarifyTask({ title: 'Plan trip' });

        const body = readBody(fetchMock);
        expect(body.response_format).toEqual({ type: 'json_object' });
    });

    it('sends the operation-specific schema for each method', async () => {
        const cases = [
            { run: (p: ReturnType<typeof createOpenAIProvider>) => p.breakDownTask({ title: 'x' }), name: 'breakdown_response', reply: { steps: ['a'] } },
            { run: (p: ReturnType<typeof createOpenAIProvider>) => p.analyzeReview({ items: [] }), name: 'review_analysis_response', reply: { suggestions: [] } },
            { run: (p: ReturnType<typeof createOpenAIProvider>) => p.predictMetadata({ title: 'x' }), name: 'copilot_response', reply: { context: null, timeEstimate: null, tags: [] } },
        ];
        for (const { run, name, reply } of cases) {
            const fetchMock = vi.fn(async () => mockContent(reply));
            globalThis.fetch = fetchMock as unknown as typeof fetch;
            const provider = createOpenAIProvider({ provider: 'openai', apiKey: 'test-key', model: 'gpt-5.4-mini' });
            await run(provider);
            const json = readBody(fetchMock).response_format as { json_schema?: { name?: string } };
            expect(json.json_schema?.name).toBe(name);
        }
    });

    it('parses a strict-schema clarify response with a null suggestedAction', async () => {
        const fetchMock = vi.fn(async () =>
            mockContent({ question: 'Next action?', options: [{ label: 'Do', action: 'do' }], suggestedAction: null }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createOpenAIProvider({ provider: 'openai', apiKey: 'test-key', model: 'gpt-5.4-mini' });
        const result = await provider.clarifyTask({ title: 'Plan trip' });
        expect(result.question).toBe('Next action?');
        expect(result.options).toHaveLength(1);
    });

    it('parses a strict-schema copilot response with null optional fields', async () => {
        const fetchMock = vi.fn(async () => mockContent({ context: null, timeEstimate: null, tags: ['home'] }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createOpenAIProvider({ provider: 'openai', apiKey: 'test-key', model: 'gpt-5.4-mini' });
        const result = await provider.predictMetadata({ title: 'Buy milk' });
        expect(result.context).toBeUndefined();
        expect(result.tags).toEqual(['#home']);
    });

    it('forwards minimal reasoning_effort on the copilot path', async () => {
        const fetchMock = vi.fn(async () => mockContent({ context: null, timeEstimate: null, tags: [] }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createOpenAIProvider({ provider: 'openai', apiKey: 'test-key', model: 'gpt-5.4-nano', reasoningEffort: 'minimal' });
        await provider.predictMetadata({ title: 'Buy milk' });

        expect(readBody(fetchMock).reasoning_effort).toBe('minimal');
    });

    it('falls back to json_object when an official model rejects json_schema (400)', async () => {
        const unsupported = () =>
            new Response(
                JSON.stringify({ error: { message: "This model does not support the 'response_format' parameter with json_schema.", type: 'invalid_request_error', code: 'unsupported_parameter' } }),
                { status: 400, headers: { 'Content-Type': 'application/json' } },
            );
        let call = 0;
        const fetchMock = vi.fn(async () => {
            call += 1;
            return call === 1 ? unsupported() : mockOpenAiSuccess();
        });
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createOpenAIProvider({ provider: 'openai', apiKey: 'test-key', model: 'gpt-4-turbo' });
        const result = await provider.clarifyTask({ title: 'Plan trip' });

        expect(result.question).toBe('What is the next action?');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const first = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as Record<string, unknown>;
        const second = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as Record<string, unknown>;
        expect((first.response_format as { type?: string }).type).toBe('json_schema');
        expect(second.response_format).toEqual({ type: 'json_object' });
    });

    it('does not fall back for an unrelated 400 (surfaces the error)', async () => {
        const fetchMock = vi.fn(async () =>
            new Response(
                JSON.stringify({ error: { message: 'Invalid value for max_tokens.', type: 'invalid_request_error' } }),
                { status: 400, headers: { 'Content-Type': 'application/json' } },
            ));
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createOpenAIProvider({ provider: 'openai', apiKey: 'test-key', model: 'gpt-5.4-mini' });
        await expect(provider.clarifyTask({ title: 'Plan trip' })).rejects.toThrow('Invalid value for max_tokens.');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe('openai error body parsing', () => {
    it('recovers a non-JSON error body (body read once as text, not consumed by json())', async () => {
        const fetchMock = vi.fn(async () =>
            new Response('gateway exploded', { status: 502, headers: { 'Content-Type': 'text/plain' } }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createOpenAIProvider({ provider: 'openai', apiKey: 'test-key', model: 'gpt-5.4-mini' });
        await expect(provider.clarifyTask({ title: 'Plan trip' })).rejects.toThrow(
            'OpenAI request failed (502) : gateway exploded',
        );
    });
});
