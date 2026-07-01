import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicProvider } from './anthropic';

const mockAnthropicSuccess = () =>
    new Response(
        JSON.stringify({
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        question: 'What is the next action?',
                        options: [{ label: 'Do it', action: 'do' }],
                    }),
                },
            ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

const mockAnthropicError = (status: number, error?: { type?: string; message?: string }) =>
    new Response(
        JSON.stringify(error ? { type: 'error', error } : {}),
        { status, headers: { 'Content-Type': 'application/json' } },
    );

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe('anthropic provider error behavior', () => {
    it('requires an API key', async () => {
        const provider = createAnthropicProvider({
            provider: 'anthropic',
            apiKey: '',
            model: 'claude-haiku-4-5-20251001',
        });

        await expect(provider.clarifyTask({ title: 'Plan trip' })).rejects.toThrow(
            'Anthropic API key is required.',
        );
    });

    it('sets the direct-browser-access header so browser-origin requests are not rejected', async () => {
        const fetchMock = vi.fn(async () => mockAnthropicSuccess());
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createAnthropicProvider({
            provider: 'anthropic',
            apiKey: 'sk-ant-test-key',
            model: 'claude-haiku-4-5-20251001',
        });

        await provider.clarifyTask({ title: 'Plan trip' });

        const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
        const headers = (requestInit?.headers ?? {}) as Record<string, string>;
        expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    });

    it('trims whitespace/newlines from the API key before sending it', async () => {
        const fetchMock = vi.fn(async () => mockAnthropicSuccess());
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createAnthropicProvider({
            provider: 'anthropic',
            apiKey: '  sk-ant-test-key\n',
            model: 'claude-haiku-4-5-20251001',
        });

        await provider.clarifyTask({ title: 'Plan trip' });

        const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
        const headers = (requestInit?.headers ?? {}) as Record<string, string>;
        expect(headers['x-api-key']).toBe('sk-ant-test-key');
    });

    it('surfaces the error type and message from the response body', async () => {
        const fetchMock = vi.fn(async () =>
            mockAnthropicError(400, {
                type: 'invalid_request_error',
                message: 'max_tokens: must be greater than thinking.budget_tokens',
            }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createAnthropicProvider({
            provider: 'anthropic',
            apiKey: 'test-key',
            model: 'claude-haiku-4-5-20251001',
        });

        await expect(provider.clarifyTask({ title: 'Plan trip' })).rejects.toThrow(
            'Anthropic request failed (400) [invalid_request_error] : max_tokens: must be greater than thinking.budget_tokens',
        );
    });

    it('includes the request id from the response body when present', async () => {
        const fetchMock = vi.fn(async () =>
            new Response(
                JSON.stringify({
                    type: 'error',
                    error: { type: 'invalid_request_error', message: 'bad input' },
                    request_id: 'req_body_123',
                }),
                { status: 400, headers: { 'Content-Type': 'application/json' } },
            ));
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createAnthropicProvider({
            provider: 'anthropic',
            apiKey: 'test-key',
            model: 'claude-haiku-4-5-20251001',
        });

        await expect(provider.clarifyTask({ title: 'Plan trip' })).rejects.toThrow(
            'Anthropic request failed (400) [invalid_request_error] (req_body_123) : bad input',
        );
    });

    it('falls back to the request-id header when the body omits it', async () => {
        const fetchMock = vi.fn(async () =>
            new Response(
                JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad input' } }),
                { status: 400, headers: { 'Content-Type': 'application/json', 'request-id': 'req_header_456' } },
            ));
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createAnthropicProvider({
            provider: 'anthropic',
            apiKey: 'test-key',
            model: 'claude-haiku-4-5-20251001',
        });

        await expect(provider.clarifyTask({ title: 'Plan trip' })).rejects.toThrow(
            'Anthropic request failed (400) [invalid_request_error] (req_header_456) : bad input',
        );
    });

    it('gives an actionable message for invalid credentials on the official endpoint', async () => {
        const fetchMock = vi.fn(async () =>
            mockAnthropicError(401, { type: 'authentication_error', message: 'invalid x-api-key' }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createAnthropicProvider({
            provider: 'anthropic',
            apiKey: 'bad-key',
            model: 'claude-haiku-4-5-20251001',
        });

        await expect(provider.clarifyTask({ title: 'Plan trip' })).rejects.toThrow(
            'Anthropic API key is invalid or missing. (invalid x-api-key)',
        );
    });

    it('distinguishes custom endpoint auth failures from official OpenAI-style ones', async () => {
        const fetchMock = vi.fn(async () =>
            mockAnthropicError(401, { type: 'authentication_error', message: 'nope' }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createAnthropicProvider({
            provider: 'anthropic',
            endpoint: 'https://proxy.example.com/v1/messages',
            apiKey: 'bad-key',
            model: 'claude-haiku-4-5-20251001',
        });

        await expect(provider.clarifyTask({ title: 'Plan trip' })).rejects.toThrow(
            'Anthropic-compatible endpoint rejected the request. Check the custom base URL, API key, and model.',
        );
    });

    it('falls back to the raw body when no structured error is present', async () => {
        const fetchMock = vi.fn(async () =>
            new Response('gateway exploded', { status: 502, headers: { 'Content-Type': 'text/plain' } }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createAnthropicProvider({
            provider: 'anthropic',
            apiKey: 'test-key',
            model: 'claude-haiku-4-5-20251001',
        });

        await expect(provider.clarifyTask({ title: 'Plan trip' })).rejects.toThrow(
            'Anthropic request failed (502) : gateway exploded',
        );
    });

    it('succeeds on a well-formed response', async () => {
        const fetchMock = vi.fn(async () => mockAnthropicSuccess());
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = createAnthropicProvider({
            provider: 'anthropic',
            apiKey: 'test-key',
            model: 'claude-haiku-4-5-20251001',
        });

        const result = await provider.clarifyTask({ title: 'Plan trip' });
        expect(result.question).toBe('What is the next action?');
    });
});
