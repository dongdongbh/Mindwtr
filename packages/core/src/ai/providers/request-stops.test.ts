import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AIProvider, AIProviderConfig } from '../types';
import { createAnthropicProvider } from './anthropic';
import { createGeminiProvider } from './gemini';
import { createOpenAIProvider } from './openai';

type ProviderCase = {
    name: string;
    create: (overrides: Partial<AIProviderConfig>) => AIProvider;
    success: () => Response;
    invalidJson: () => Response;
};

const response = (body: unknown, status = 200) => new Response(
    JSON.stringify(body),
    { status, headers: { 'Content-Type': 'application/json' } },
);

const providerCases: ProviderCase[] = [
    {
        name: 'OpenAI',
        create: (overrides) => createOpenAIProvider({
            provider: 'openai',
            apiKey: 'test-key',
            model: 'gpt-4o-mini',
            ...overrides,
        }),
        success: () => response({
            choices: [{
                message: {
                    content: JSON.stringify({
                        question: 'What is the next action?',
                        options: [{ label: 'Do it', action: 'do' }],
                    }),
                },
            }],
        }),
        invalidJson: () => response({ choices: [{ message: { content: 'not json' } }] }),
    },
    {
        name: 'Anthropic',
        create: (overrides) => createAnthropicProvider({
            provider: 'anthropic',
            apiKey: 'test-key',
            model: 'claude-haiku-4-5-20251001',
            ...overrides,
        }),
        success: () => response({
            content: [{
                type: 'text',
                text: JSON.stringify({
                    question: 'What is the next action?',
                    options: [{ label: 'Do it', action: 'do' }],
                }),
            }],
        }),
        invalidJson: () => response({ content: [{ type: 'text', text: 'not json' }] }),
    },
    {
        name: 'Gemini',
        create: (overrides) => createGeminiProvider({
            provider: 'gemini',
            apiKey: 'test-key',
            model: 'gemini-2.5-flash',
            ...overrides,
        }),
        success: () => response({
            candidates: [{
                content: {
                    parts: [{
                        text: JSON.stringify({
                            question: 'What is the next action?',
                            options: [{ label: 'Do it', action: 'do' }],
                        }),
                    }],
                },
            }],
        }),
        invalidJson: () => response({
            candidates: [{ content: { parts: [{ text: 'not json' }] } }],
        }),
    },
];

let fakeNow = Date.now() + 1_000_000;

const useFutureFakeClock = () => {
    fakeNow += 1_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(fakeNow);
};

afterEach(() => {
    vi.useRealTimers();
});

describe.each(providerCases)('$name provider request termination', ({ name, create, success, invalidJson }) => {
    it('allows a response after 30 seconds when configured for 120 seconds', async () => {
        useFutureFakeClock();
        const fetcher = vi.fn(() => new Promise<Response>((resolve) => {
            setTimeout(() => resolve(success()), 31_000);
        }));
        const provider = create({ timeoutMs: 120_000, fetcher: fetcher as unknown as typeof fetch });

        const result = provider.clarifyTask({ title: 'Plan trip' });
        const resolved = expect(result).resolves.toMatchObject({ question: 'What is the next action?' });
        await vi.advanceTimersByTimeAsync(0);
        expect(fetcher).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(31_000);

        await resolved;
        expect(fetcher).toHaveBeenCalledOnce();
    });

    it('does not retry a client timeout and reports it once', async () => {
        useFutureFakeClock();
        const fetcher = vi.fn(() => new Promise<Response>(() => undefined));
        const onRequestStop = vi.fn();
        const provider = create({
            timeoutMs: 100,
            onRequestStop,
            fetcher: fetcher as unknown as typeof fetch,
        });

        const result = provider.clarifyTask({ title: 'Plan trip' });
        const rejected = expect(result).rejects.toThrow(`${name} request timed out`);
        await vi.runAllTimersAsync();

        await rejected;
        expect(fetcher).toHaveBeenCalledOnce();
        expect(onRequestStop).toHaveBeenCalledOnce();
        expect(onRequestStop).toHaveBeenCalledWith('timeout');
    });

    it('does not classify an untyped network error by timeout-like message text', async () => {
        useFutureFakeClock();
        const fetcher = vi.fn()
            .mockRejectedValueOnce(new Error(`${name} request timed out`))
            .mockImplementation(async () => success());
        const onRequestStop = vi.fn();
        const provider = create({ onRequestStop, fetcher: fetcher as unknown as typeof fetch });

        const result = provider.clarifyTask({ title: 'Plan trip' });
        const resolved = expect(result).resolves.toMatchObject({ question: 'What is the next action?' });
        await vi.runAllTimersAsync();

        await resolved;
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(onRequestStop).not.toHaveBeenCalled();
    });

    it('does not dispatch when the caller already cancelled', async () => {
        const controller = new AbortController();
        controller.abort();
        const fetcher = vi.fn(async () => success());
        const onRequestStop = vi.fn();
        const provider = create({ onRequestStop, fetcher: fetcher as unknown as typeof fetch });

        await expect(provider.clarifyTask(
            { title: 'Plan trip' },
            { signal: controller.signal },
        )).rejects.toThrow(`${name} request aborted`);

        expect(fetcher).not.toHaveBeenCalled();
        expect(onRequestStop).toHaveBeenCalledOnce();
        expect(onRequestStop).toHaveBeenCalledWith('aborted');
    });

    it('cancels an in-flight fetch without retrying it', async () => {
        useFutureFakeClock();
        const controller = new AbortController();
        const fetcher = vi.fn(() => new Promise<Response>(() => undefined));
        const onRequestStop = vi.fn();
        const provider = create({ onRequestStop, fetcher: fetcher as unknown as typeof fetch });

        const result = provider.clarifyTask({ title: 'Plan trip' }, { signal: controller.signal });
        const rejected = expect(result).rejects.toThrow(`${name} request aborted`);
        await vi.advanceTimersByTimeAsync(0);
        expect(fetcher).toHaveBeenCalledOnce();
        controller.abort();

        await rejected;
        expect(fetcher).toHaveBeenCalledOnce();
        expect(onRequestStop).toHaveBeenCalledOnce();
        expect(onRequestStop).toHaveBeenCalledWith('aborted');
    });

    it('cancels retry backoff without another dispatch', async () => {
        useFutureFakeClock();
        const controller = new AbortController();
        const fetcher = vi.fn()
            .mockResolvedValueOnce(response({ error: 'busy' }, 503))
            .mockImplementation(async () => success());
        const onRequestStop = vi.fn();
        const provider = create({ onRequestStop, fetcher: fetcher as unknown as typeof fetch });

        const result = provider.clarifyTask({ title: 'Plan trip' }, { signal: controller.signal });
        const rejected = expect(result).rejects.toThrow(`${name} request aborted`);
        await vi.advanceTimersByTimeAsync(0);
        expect(fetcher).toHaveBeenCalledOnce();
        controller.abort();

        await rejected;
        expect(fetcher).toHaveBeenCalledOnce();
        expect(onRequestStop).toHaveBeenCalledOnce();
        expect(onRequestStop).toHaveBeenCalledWith('aborted');
    });

    it('cancels while reading the response body and reports it once', async () => {
        useFutureFakeClock();
        const controller = new AbortController();
        let markBodyReadStarted!: () => void;
        const bodyReadStarted = new Promise<void>((resolve) => {
            markBodyReadStarted = resolve;
        });
        const reader = {
            read: vi.fn(() => {
                markBodyReadStarted();
                return new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined);
            }),
            cancel: vi.fn(async () => undefined),
        };
        const body = {
            locked: false,
            cancel: vi.fn(async () => undefined),
            getReader: () => reader,
        };
        const pendingBodyResponse = {
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
            body,
            bodyUsed: false,
        } as unknown as Response;
        const fetcher = vi.fn(async () => pendingBodyResponse);
        const onRequestStop = vi.fn();
        const provider = create({ onRequestStop, fetcher: fetcher as unknown as typeof fetch });

        const result = provider.clarifyTask({ title: 'Plan trip' }, { signal: controller.signal });
        const rejected = expect(result).rejects.toThrow(`${name} request aborted`);
        await vi.advanceTimersByTimeAsync(0);
        await bodyReadStarted;
        controller.abort();

        await rejected;
        expect(fetcher).toHaveBeenCalledOnce();
        expect(reader.cancel).toHaveBeenCalled();
        expect(onRequestStop).toHaveBeenCalledOnce();
        expect(onRequestStop).toHaveBeenCalledWith('aborted');
    });

    it('keeps bounded retries for network failures and transient HTTP responses', async () => {
        useFutureFakeClock();
        const fetcher = vi.fn()
            .mockRejectedValueOnce(new TypeError('network unavailable'))
            .mockResolvedValueOnce(response({ error: 'busy' }, 503))
            .mockImplementation(async () => success());
        const provider = create({ fetcher: fetcher as unknown as typeof fetch });

        const result = provider.clarifyTask({ title: 'Plan trip' });
        const resolved = expect(result).resolves.toMatchObject({ question: 'What is the next action?' });
        await vi.runAllTimersAsync();

        await resolved;
        expect(fetcher).toHaveBeenCalledTimes(3);
    });

    it('does not retry a timeout from the JSON-repair request', async () => {
        useFutureFakeClock();
        const fetcher = vi.fn()
            .mockResolvedValueOnce(invalidJson())
            .mockImplementation(() => new Promise<Response>(() => undefined));
        const onRequestStop = vi.fn();
        const provider = create({
            timeoutMs: 100,
            onRequestStop,
            fetcher: fetcher as unknown as typeof fetch,
        });

        const result = provider.clarifyTask({ title: 'Plan trip' });
        const rejected = expect(result).rejects.toThrow(`${name} request timed out`);
        await vi.runAllTimersAsync();

        await rejected;
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(onRequestStop).toHaveBeenCalledOnce();
        expect(onRequestStop).toHaveBeenCalledWith('timeout');
    });
});

describe('OpenAI provider request termination fallbacks', () => {
    it('does not retry a timeout during response-format negotiation', async () => {
        useFutureFakeClock();
        const fetcher = vi.fn()
            .mockResolvedValueOnce(response({
                error: { message: "'response_format.type' must be 'json_schema'" },
            }, 400))
            .mockImplementation(() => new Promise<Response>(() => undefined));
        const onRequestStop = vi.fn();
        const provider = createOpenAIProvider({
            provider: 'openai',
            endpoint: 'http://localhost:1234/v1/chat/completions',
            apiKey: '',
            model: 'local-model',
            timeoutMs: 100,
            onRequestStop,
            fetcher: fetcher as unknown as typeof fetch,
        });

        const result = provider.clarifyTask({ title: 'Plan trip' });
        const rejected = expect(result).rejects.toThrow('OpenAI request timed out');
        await vi.runAllTimersAsync();

        await rejected;
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(onRequestStop).toHaveBeenCalledOnce();
    });

    it('preserves the terminal request error when the diagnostic callback throws', async () => {
        useFutureFakeClock();
        const provider = createOpenAIProvider({
            provider: 'openai',
            apiKey: 'test-key',
            model: 'gpt-4o-mini',
            timeoutMs: 100,
            onRequestStop: () => {
                throw new Error('diagnostic failure');
            },
            fetcher: () => new Promise<Response>(() => undefined),
        });

        const result = provider.clarifyTask({ title: 'Plan trip' });
        const rejected = expect(result).rejects.toThrow('OpenAI request timed out');
        await vi.runAllTimersAsync();

        await rejected;
    });
});
