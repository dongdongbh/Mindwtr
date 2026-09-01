import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getWebDefaultCloudUrl, resetWebDefaultCloudUrlForTests } from './web-runtime-config';

type FetchResponses = Record<string, () => Promise<Partial<Response>> | Partial<Response>>;

const installFetch = (responses: FetchResponses) => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        calls.push(path);
        const handler = responses[path];
        if (!handler) throw new Error(`Unexpected fetch: ${path}`);
        return await handler() as Response;
    }));
    return calls;
};

const jsonResponse = (body: unknown, ok = true): Partial<Response> => ({
    ok,
    json: async () => body,
});

const htmlResponse = (): Partial<Response> => ({
    ok: true,
    json: async () => {
        throw new SyntaxError('Unexpected token <');
    },
});

describe('getWebDefaultCloudUrl', () => {
    beforeEach(() => {
        resetWebDefaultCloudUrlForTests();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('prefers the admin-provided runtime config over same-origin detection', async () => {
        const calls = installFetch({
            '/runtime-config.json': () => jsonResponse({ defaultCloudUrl: ' https://cloud.example ' }),
        });
        await expect(getWebDefaultCloudUrl()).resolves.toBe('https://cloud.example');
        expect(calls).toEqual(['/runtime-config.json']);
    });

    it('falls back to the own origin when the same-origin health check answers cloud JSON', async () => {
        installFetch({
            '/runtime-config.json': () => jsonResponse(null, false),
            '/health': () => jsonResponse({ ok: true }),
        });
        await expect(getWebDefaultCloudUrl()).resolves.toBe(window.location.origin);
    });

    it('does not treat the SPA fallback page as a cloud health answer', async () => {
        installFetch({
            '/runtime-config.json': () => jsonResponse(null, false),
            '/health': () => htmlResponse(),
        });
        await expect(getWebDefaultCloudUrl()).resolves.toBe('');
    });

    it('yields no default when every probe fails', async () => {
        installFetch({
            '/runtime-config.json': () => {
                throw new Error('offline');
            },
            '/health': () => {
                throw new Error('offline');
            },
        });
        await expect(getWebDefaultCloudUrl()).resolves.toBe('');
    });

    it('resolves once per session', async () => {
        const calls = installFetch({
            '/runtime-config.json': () => jsonResponse({ defaultCloudUrl: 'https://cloud.example' }),
        });
        await getWebDefaultCloudUrl();
        await getWebDefaultCloudUrl();
        expect(calls).toEqual(['/runtime-config.json']);
    });
});
